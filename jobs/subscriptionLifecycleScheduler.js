// jobs/subscriptionLifecycleScheduler.js

const Subscription = require("../models/Subscription");
const SubscriptionPayment = require("../models/SubscriptionPayment");

const SubscriptionService = require("../services/subscriptionService");
const SubscriptionPaymentService = require("../services/subscriptionPaymentService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_RENEWAL_LEAD_MINUTES = 10;
const DEFAULT_APPLICATION_LIMIT = 100;
const DEFAULT_RENEWAL_LIMIT = 100;
const DEFAULT_BOUNDARY_LIMIT = 100;
const MAXIMUM_BATCH_LIMIT = 500;

class SubscriptionLifecycleScheduler {
  static intervalHandle = null;
  static isRunning = false;
  // Process-local rotation; payment/lifecycle services own durable idempotency.
  // Restarting the process restarts each sweep from the beginning.
  static batchCursors = new Map();

  static async getRotatingBatch({ key, model, filter, select, limit }) {
    let cursor = this.batchCursors.get(key);
    const beginSweep = async () => {
      const last = await model.find(filter).sort({ _id: -1 }).limit(1).select("_id").lean();
      return last.length ? { throughId: last[0]._id, afterId: null } : null;
    };
    const read = (position) =>
      model
        .find({
          ...filter,
          _id: { $lte: position.throughId, ...(position.afterId ? { $gt: position.afterId } : {}) },
        })
        .sort({ _id: 1 })
        .limit(limit)
        .select(select)
        .lean();

    // A fixed upper ID makes each sweep finite even while new records arrive.
    if (!cursor) cursor = await beginSweep();
    let candidates = cursor ? await read(cursor) : [];
    if (!candidates.length && this.batchCursors.has(key)) {
      cursor = await beginSweep();
      candidates = cursor ? await read(cursor) : [];
    }
    if (candidates.length) {
      this.batchCursors.set(key, { ...cursor, afterId: candidates[candidates.length - 1]._id });
    } else {
      this.batchCursors.delete(key);
    }
    return candidates;
  }

  static async processDuePaymentApplications({ currentTime, limit }) {
    const payments = await this.getRotatingBatch({
      key: "applications",
      model: SubscriptionPayment,
      limit,
      filter: {
        paymentStatus: "paid",
        appliedAt: null,
        $or: [
          { paymentKind: { $in: ["initial_purchase", "plan_change"] } },
          { paymentKind: "renewal", periodStart: { $type: "date", $lte: currentTime } },
        ],
      },
      select: "_id paymentReference paymentKind subscription",
    });
    const results = [];
    for (const payment of payments) {
      const identity = {
        paymentId: String(payment._id),
        paymentReference: payment.paymentReference,
        paymentKind: payment.paymentKind,
        subscriptionId: String(payment.subscription),
      };
      try {
        const result = await SubscriptionPaymentService.applyPaidPayment({
          paymentId: payment._id,
          currentTime,
        });
        results.push({
          ...identity,
          success: true,
          applied: result.applied === true,
          idempotent: result.idempotent === true,
          reason: result.reason || null,
          events: result.events || [],
        });
      } catch (error) {
        results.push({
          ...identity,
          success: false,
          applied: false,
          code: error.code || "SUBSCRIPTION_PAYMENT_APPLICATION_FAILED",
          message: error.message,
          events: [],
        });
      }
    }
    return {
      checked: payments.length,
      applied: results.filter((r) => r.applied).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }

  static async processPendingPaymentVerification({ currentTime, limit }) {
    const payments = await this.getRotatingBatch({
      key: "verification",
      model: SubscriptionPayment,
      limit,
      filter: { paymentStatus: "pending", paymentProvider: "paystack" },
      select: "_id providerReference",
    });
    const results = [];
    for (const payment of payments) {
      try {
        // Reconcile existing receipts, including initial purchases and terminal
        // subscriptions. Never initiate or repeat a provider charge here.
        const result = await SubscriptionPaymentService.finalizePaystackPayment({
          reference: payment.providerReference,
          currentTime,
        });
        results.push({
          paymentId: String(payment._id),
          paid: result.paid === true,
          applied: result.application?.applied === true,
          reconciliationRequired: Boolean(result.applicationError),
          code: result.applicationError?.code || null,
        });
      } catch (error) {
        results.push({
          paymentId: String(payment._id),
          paid: false,
          applied: false,
          reconciliationRequired: error.code !== "SUBSCRIPTION_PAYMENT_PAYSTACK_FAILED",
          code: error.code || "SUBSCRIPTION_PAYMENT_VERIFICATION_FAILED",
          message: error.message,
        });
      }
    }
    return {
      checked: payments.length,
      paid: results.filter((r) => r.paid).length,
      reconciliationRequired: results.filter((r) => r.reconciliationRequired).length,
      results,
    };
  }

  static async runStage(name, callback, fallback) {
    try {
      return await callback();
    } catch (error) {
      logger.error("Subscription lifecycle " + name + " stage failed:", error);
      return {
        ...fallback,
        stageFailed: true,
        errorCode: error.code || "SUBSCRIPTION_LIFECYCLE_STAGE_FAILED",
        errorMessage: error.message,
      };
    }
  }

  static normalizeDate(value, fieldName = "current time") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Subscription lifecycle scheduler ${fieldName} is invalid.`);
    }

    return date;
  }

  static normalizePositiveInteger(value, fieldName, maximum = null) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 1) {
      throw new Error(
        `Subscription lifecycle scheduler ${fieldName} must be a positive whole number.`
      );
    }

    if (maximum !== null && normalizedValue > maximum) {
      throw new Error(`Subscription lifecycle scheduler ${fieldName} cannot exceed ${maximum}.`);
    }

    return normalizedValue;
  }

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    return (
      SubscriptionLifecycleScheduler.normalizePositiveInteger(
        intervalMinutes,
        "interval minutes",
        24 * 60
      ) *
      60 *
      1000
    );
  }

  static getRenewalCutoff(currentTime, renewalLeadMinutes) {
    return new Date(currentTime.getTime() + renewalLeadMinutes * 60 * 1000);
  }

  static async getUpcomingAutomaticRenewalCandidates({ currentTime, renewalLeadMinutes, limit }) {
    const cutoff = SubscriptionLifecycleScheduler.getRenewalCutoff(currentTime, renewalLeadMinutes);

    return this.getRotatingBatch({
      key: "renewals",
      model: Subscription,
      limit,
      select: "_id business currentPeriodEnd",
      filter: {
        status: "active",
        cancelAtPeriodEnd: false,
        pendingPlanChange: null,
        currentPeriodStart: { $type: "date", $lte: currentTime },
        currentPeriodEnd: {
          $type: "date",
          $gt: currentTime,
          $lte: cutoff,
        },
      },
    });
  }

  static async getDueBoundaryCandidates({ currentTime, limit }) {
    return this.getRotatingBatch({
      key: "boundaries",
      model: Subscription,
      limit,
      select: "_id business cancelAtPeriodEnd currentPeriodEnd",
      filter: {
        status: "active",
        currentPeriodEnd: {
          $type: "date",
          $lte: currentTime,
        },
      },
    });
  }

  static async getCurrentSubscriptionState(subscriptionId) {
    return Subscription.findById(subscriptionId)
      .select("status currentPeriodStart currentPeriodEnd cancelAtPeriodEnd endedAt")
      .lean();
  }

  static hasActivePaidPeriod(subscription, currentTime) {
    return Boolean(
      subscription &&
      subscription.status === "active" &&
      subscription.currentPeriodStart instanceof Date &&
      subscription.currentPeriodEnd instanceof Date &&
      subscription.currentPeriodStart <= currentTime &&
      currentTime < subscription.currentPeriodEnd
    );
  }

  static async processUpcomingAutomaticRenewals({ currentTime, renewalLeadMinutes, limit }) {
    const candidates = await SubscriptionLifecycleScheduler.getUpcomingAutomaticRenewalCandidates({
      currentTime,
      renewalLeadMinutes,
      limit,
    });

    const result = {
      inspected: candidates.length,
      paid: [],
      pending: [],
      unavailable: [],
      failed: [],
    };

    for (const candidate of candidates) {
      const subscriptionId = String(candidate._id);
      const employerProfileId = String(candidate.business);

      try {
        const renewalResult = await SubscriptionPaymentService.chargeRenewalWithStoredAuthorization(
          {
            employerProfileId,
            subscriptionId,
            currentTime,
          }
        );

        if (renewalResult?.paid === true) {
          result.paid.push({
            subscriptionId,
            employerProfileId,
            paymentId: renewalResult.payment?._id ? String(renewalResult.payment._id) : null,
            paymentReference: renewalResult.payment?.paymentReference || null,
            applied: renewalResult.application?.applied === true,
            idempotent: renewalResult.idempotent === true,
          });

          continue;
        }

        if (renewalResult?.pending === true) {
          result.pending.push({
            subscriptionId,
            employerProfileId,
            paymentId: renewalResult.payment?._id ? String(renewalResult.payment._id) : null,
            paymentReference: renewalResult.payment?.paymentReference || null,
            reconciliationRequired: renewalResult.reconciliationRequired === true,
          });

          continue;
        }

        result.failed.push({
          subscriptionId,
          employerProfileId,
          errorCode: "SUBSCRIPTION_AUTOMATIC_RENEWAL_NOT_COMPLETED",
          errorMessage: "Automatic subscription renewal did not complete.",
        });
      } catch (error) {
        if (
          [
            "SUBSCRIPTION_REUSABLE_PAYSTACK_AUTHORIZATION_NOT_FOUND",
            "SUBSCRIPTION_FUTURE_RENEWAL_ALREADY_PAID",
            "SUBSCRIPTION_PAYMENT_ATTEMPT_ALREADY_OPEN",
          ].includes(error.code)
        ) {
          result.unavailable.push({
            subscriptionId,
            employerProfileId,
            reason: error.code,
          });

          continue;
        }

        logger.error(`Subscription ${subscriptionId} automatic renewal failed:`, error);

        result.failed.push({
          subscriptionId,
          employerProfileId,
          errorCode: error.code || "SUBSCRIPTION_AUTOMATIC_RENEWAL_FAILED",
          errorMessage: error.message || "Automatic subscription renewal failed.",
        });
      }
    }

    return result;
  }

  static async reconcileBoundaryPayments({ subscriptionId, employerProfileId, currentTime }) {
    // The global application batch may be full or contain failed older items.
    // Check this exact subscription before making a terminal lifecycle decision.
    const paid = await SubscriptionPayment.find({
      subscription: subscriptionId,
      business: employerProfileId,
      paymentStatus: "paid",
      appliedAt: null,
      $or: [
        { paymentKind: { $in: ["initial_purchase", "plan_change"] } },
        { paymentKind: "renewal", periodStart: { $type: "date", $lte: currentTime } },
      ],
    })
      .sort({ paidAt: 1, _id: 1 })
      .limit(MAXIMUM_BATCH_LIMIT + 1)
      .select("_id")
      .lean();

    if (paid.length > MAXIMUM_BATCH_LIMIT) {
      throw new Error("Subscription paid-payment reconciliation limit exceeded.");
    }

    for (const payment of paid) {
      await SubscriptionPaymentService.applyPaidPayment({ paymentId: payment._id, currentTime });
    }

    const pending = await SubscriptionPayment.find({
      subscription: subscriptionId,
      business: employerProfileId,
      paymentStatus: "pending",
      paymentProvider: "paystack",
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAXIMUM_BATCH_LIMIT + 1)
      .select("_id providerReference")
      .lean();

    if (pending.length > MAXIMUM_BATCH_LIMIT) {
      throw new Error("Subscription pending-payment reconciliation limit exceeded.");
    }

    for (const payment of pending) {
      // Verify the existing reference; never issue another provider charge here.
      // Pending, uncertain, reversed or unappliable settlements prevent expiry.
      // An ended paid period still confers no marketplace authority.
      try {
        const result = await SubscriptionPaymentService.finalizePaystackPayment({
          reference: payment.providerReference,
          currentTime,
        });
        if (result.applicationError) {
          throw Object.assign(new Error(result.applicationError.message), {
            code: result.applicationError.code,
          });
        }
      } catch (error) {
        if (error.code !== "SUBSCRIPTION_PAYMENT_PAYSTACK_FAILED") throw error;
        // The service recorded a verified failed/abandoned attempt. Re-read the
        // lifecycle below, including any period-end action it already performed.
      }
    }
  }

  static async processDueBoundaries({ currentTime, limit }) {
    const candidates = await SubscriptionLifecycleScheduler.getDueBoundaryCandidates({
      currentTime,
      limit,
    });

    const result = {
      inspected: candidates.length,
      renewed: [],
      cancelled: [],
      expired: [],
      failed: [],
    };

    for (const candidate of candidates) {
      const subscriptionId = String(candidate._id);
      const employerProfileId = String(candidate.business);

      try {
        let refreshed =
          await SubscriptionLifecycleScheduler.getCurrentSubscriptionState(subscriptionId);

        if (
          refreshed?.status === "active" &&
          !refreshed.cancelAtPeriodEnd &&
          !SubscriptionLifecycleScheduler.hasActivePaidPeriod(refreshed, currentTime)
        ) {
          await SubscriptionLifecycleScheduler.reconcileBoundaryPayments({
            subscriptionId,
            employerProfileId,
            currentTime,
          });
          refreshed =
            await SubscriptionLifecycleScheduler.getCurrentSubscriptionState(subscriptionId);
        }

        if (SubscriptionLifecycleScheduler.hasActivePaidPeriod(refreshed, currentTime)) {
          result.renewed.push({
            subscriptionId,
            employerProfileId,
            idempotent: true,
          });

          continue;
        }

        if (refreshed?.status === "cancelled") {
          result.cancelled.push({
            subscriptionId,
            employerProfileId,
            idempotent: true,
            endedPublicationIds: [],
          });

          continue;
        }

        if (refreshed?.status === "expired") {
          result.expired.push({
            subscriptionId,
            employerProfileId,
            idempotent: true,
            endedPublicationIds: [],
          });

          continue;
        }

        if (!refreshed || refreshed.status !== "active") {
          continue;
        }

        if (refreshed.cancelAtPeriodEnd) {
          const cancellation = await SubscriptionService.finalizeScheduledCancellation({
            subscriptionId,
            employerProfileId,
            currentTime,
          });

          result.cancelled.push({
            subscriptionId,
            employerProfileId,
            idempotent: cancellation.idempotent === true,
            endedPublicationIds: cancellation.endedPublicationIds || [],
          });

          continue;
        }

        const expiry = await SubscriptionService.expireSubscription({
          subscriptionId,
          employerProfileId,
          currentTime,
        });

        result.expired.push({
          subscriptionId,
          employerProfileId,
          idempotent: expiry.idempotent === true,
          endedPublicationIds: expiry.endedPublicationIds || [],
        });
      } catch (error) {
        let refreshed = null;
        try {
          refreshed =
            await SubscriptionLifecycleScheduler.getCurrentSubscriptionState(subscriptionId);
        } catch (refreshError) {
          logger.error(`Subscription ${subscriptionId} state refresh failed:`, refreshError);
        }

        if (SubscriptionLifecycleScheduler.hasActivePaidPeriod(refreshed, currentTime)) {
          result.renewed.push({
            subscriptionId,
            employerProfileId,
            idempotent: true,
          });

          continue;
        }

        if (refreshed?.status === "expired") {
          result.expired.push({
            subscriptionId,
            employerProfileId,
            idempotent: true,
            endedPublicationIds: [],
          });

          continue;
        }

        if (refreshed?.status === "cancelled") {
          result.cancelled.push({
            subscriptionId,
            employerProfileId,
            idempotent: true,
            endedPublicationIds: [],
          });

          continue;
        }

        logger.error(`Subscription ${subscriptionId} period-end processing failed:`, error);

        result.failed.push({
          subscriptionId,
          employerProfileId,
          errorCode: error.code || "SUBSCRIPTION_PERIOD_END_PROCESSING_FAILED",
          errorMessage: error.message || "Subscription period-end processing failed.",
        });
      }
    }

    return result;
  }

  static async runOnce({
    currentTime = new Date(),
    renewalLeadMinutes = DEFAULT_RENEWAL_LEAD_MINUTES,
    applicationLimit = DEFAULT_APPLICATION_LIMIT,
    renewalLimit = DEFAULT_RENEWAL_LIMIT,
    boundaryLimit = DEFAULT_BOUNDARY_LIMIT,
  } = {}) {
    if (SubscriptionLifecycleScheduler.isRunning) {
      logger.info(
        "Subscription lifecycle scheduler skipped because the previous run is still active."
      );

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    SubscriptionLifecycleScheduler.isRunning = true;

    try {
      const normalizedCurrentTime = SubscriptionLifecycleScheduler.normalizeDate(
        currentTime,
        "current time"
      );

      const normalizedRenewalLeadMinutes = SubscriptionLifecycleScheduler.normalizePositiveInteger(
        renewalLeadMinutes,
        "renewal lead minutes",
        24 * 60
      );

      const normalizedApplicationLimit = SubscriptionLifecycleScheduler.normalizePositiveInteger(
        applicationLimit,
        "application limit",
        MAXIMUM_BATCH_LIMIT
      );

      const normalizedRenewalLimit = SubscriptionLifecycleScheduler.normalizePositiveInteger(
        renewalLimit,
        "renewal limit",
        MAXIMUM_BATCH_LIMIT
      );

      const normalizedBoundaryLimit = SubscriptionLifecycleScheduler.normalizePositiveInteger(
        boundaryLimit,
        "boundary limit",
        MAXIMUM_BATCH_LIMIT
      );

      logger.info("Subscription lifecycle scheduler run started.", {
        currentTime: normalizedCurrentTime,
        renewalLeadMinutes: normalizedRenewalLeadMinutes,
        applicationLimit: normalizedApplicationLimit,
        renewalLimit: normalizedRenewalLimit,
        boundaryLimit: normalizedBoundaryLimit,
      });

      // Each pass is independently bounded. Application limit also bounds the
      // separate verification pass; one stage failure must not suppress the rest.
      const pendingVerification = await this.runStage(
        "verification",
        () =>
          this.processPendingPaymentVerification({
            currentTime: normalizedCurrentTime,
            limit: normalizedApplicationLimit,
          }),
        { checked: 0, paid: 0, reconciliationRequired: 0, results: [] }
      );
      const paymentApplication = await this.runStage(
        "application",
        () =>
          this.processDuePaymentApplications({
            currentTime: normalizedCurrentTime,
            limit: normalizedApplicationLimit,
          }),
        { checked: 0, applied: 0, failed: 0, results: [] }
      );
      const automaticRenewal = await this.runStage(
        "renewal",
        () =>
          this.processUpcomingAutomaticRenewals({
            currentTime: normalizedCurrentTime,
            renewalLeadMinutes: normalizedRenewalLeadMinutes,
            limit: normalizedRenewalLimit,
          }),
        { inspected: 0, paid: [], pending: [], unavailable: [], failed: [] }
      );
      const periodEnd = await this.runStage(
        "boundary",
        () =>
          this.processDueBoundaries({
            currentTime: normalizedCurrentTime,
            limit: normalizedBoundaryLimit,
          }),
        { inspected: 0, renewed: [], cancelled: [], expired: [], failed: [] }
      );

      const result = {
        currentTime: normalizedCurrentTime,
        paymentApplication,
        pendingVerification,
        stageFailed: [pendingVerification, paymentApplication, automaticRenewal, periodEnd].some(
          (stage) => stage.stageFailed
        ),
        automaticRenewal,
        periodEnd,
      };

      logger.info("Subscription lifecycle scheduler run completed.", {
        stageFailed: result.stageFailed,
        pendingPaymentsChecked: pendingVerification.checked,
        pendingPaymentsNeedingReconciliation: pendingVerification.reconciliationRequired,
        paymentsChecked: paymentApplication.checked || 0,
        paymentsApplied: paymentApplication.applied || 0,
        paymentApplicationFailed: paymentApplication.failed || 0,
        renewalsInspected: automaticRenewal.inspected || 0,
        renewalPaid: automaticRenewal.paid.length,
        renewalPending: automaticRenewal.pending.length,
        renewalUnavailable: automaticRenewal.unavailable.length,
        renewalFailed: automaticRenewal.failed.length,
        boundariesInspected: periodEnd.inspected || 0,
        renewed: periodEnd.renewed.length,
        cancelled: periodEnd.cancelled.length,
        expired: periodEnd.expired.length,
        boundaryFailed: periodEnd.failed.length,
      });

      return result;
    } catch (error) {
      logger.error("Subscription lifecycle scheduler run failed:", error);

      return {
        failed: true,
        errorCode: error.code || "SUBSCRIPTION_LIFECYCLE_SCHEDULER_FAILED",
        errorMessage: error.message || "Subscription lifecycle scheduler failed.",
      };
    } finally {
      SubscriptionLifecycleScheduler.isRunning = false;
    }
  }

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    renewalLeadMinutes = DEFAULT_RENEWAL_LEAD_MINUTES,
    applicationLimit = DEFAULT_APPLICATION_LIMIT,
    renewalLimit = DEFAULT_RENEWAL_LIMIT,
    boundaryLimit = DEFAULT_BOUNDARY_LIMIT,
    runImmediately = false,
  } = {}) {
    if (SubscriptionLifecycleScheduler.intervalHandle) {
      logger.info("Subscription lifecycle scheduler is already running.");

      return SubscriptionLifecycleScheduler.intervalHandle;
    }

    const intervalMs = SubscriptionLifecycleScheduler.getIntervalMs(intervalMinutes);

    const normalizedRenewalLeadMinutes = SubscriptionLifecycleScheduler.normalizePositiveInteger(
      renewalLeadMinutes,
      "renewal lead minutes",
      24 * 60
    );

    const normalizedApplicationLimit = SubscriptionLifecycleScheduler.normalizePositiveInteger(
      applicationLimit,
      "application limit",
      MAXIMUM_BATCH_LIMIT
    );

    const normalizedRenewalLimit = SubscriptionLifecycleScheduler.normalizePositiveInteger(
      renewalLimit,
      "renewal limit",
      MAXIMUM_BATCH_LIMIT
    );

    const normalizedBoundaryLimit = SubscriptionLifecycleScheduler.normalizePositiveInteger(
      boundaryLimit,
      "boundary limit",
      MAXIMUM_BATCH_LIMIT
    );

    if (typeof runImmediately !== "boolean") {
      throw new Error(
        "Subscription lifecycle scheduler run-immediately option must be true or false."
      );
    }

    const runOptions = {
      renewalLeadMinutes: normalizedRenewalLeadMinutes,
      applicationLimit: normalizedApplicationLimit,
      renewalLimit: normalizedRenewalLimit,
      boundaryLimit: normalizedBoundaryLimit,
    };

    logger.info("Subscription lifecycle scheduler started.", {
      intervalMinutes,
      ...runOptions,
      runImmediately,
    });

    if (runImmediately) {
      void SubscriptionLifecycleScheduler.runOnce(runOptions);
    }

    SubscriptionLifecycleScheduler.intervalHandle = setInterval(() => {
      void SubscriptionLifecycleScheduler.runOnce(runOptions);
    }, intervalMs);

    return SubscriptionLifecycleScheduler.intervalHandle;
  }

  static stop() {
    if (!SubscriptionLifecycleScheduler.intervalHandle) {
      return;
    }

    clearInterval(SubscriptionLifecycleScheduler.intervalHandle);

    SubscriptionLifecycleScheduler.intervalHandle = null;

    logger.info("Subscription lifecycle scheduler stopped.");
  }
}

module.exports = SubscriptionLifecycleScheduler;
