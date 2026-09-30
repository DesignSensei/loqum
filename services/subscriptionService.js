// services/subscriptionService.js

const SubscriptionPlan = require("../models/SubscriptionPlan");
const Subscription = require("../models/Subscription");
const SubscriptionPayment = require("../models/SubscriptionPayment");
const EmployerProfile = require("../models/EmployerProfile");

const SubscriptionJobLifecycleService = require("./subscriptionJobLifecycleService");

const { SUBSCRIPTION_BILLING_CYCLES } = require("../constants/employerMonetization");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");

const ERROR_NAME = "SubscriptionServiceError";

const LIVE_SUBSCRIPTION_STATUSES = Object.freeze(["pending", "active"]);

const BENEFIT_ELIGIBLE_SUBSCRIPTION_STATUS = "active";

const MAX_PLAN_CHANGE_PAYMENT_REFERENCE_LENGTH = 180;

/**
 * SubscriptionService owns employer subscription lifecycle and recurring
 * subscription benefits.
 *
 * PAYMENT BOUNDARY:
 *
 * This service does not charge a wallet or initialize/verify Paystack Checkout.
 * SubscriptionPaymentService owns payment execution and recurring-charge
 * reconciliation.
 *
 * activateSubscription(), renewSubscription() and applyPaidPlanChange() are
 * trusted internal lifecycle operations. They should only run after the relevant
 * payment state has been established.
 *
 * JOB SLOT BENEFIT:
 *
 * An active subscription may provide concurrent permanent-Job capacity through
 * planSnapshot.benefits.activeJobSlots.
 *
 * This service exposes purchased capacity but does not maintain a consumed-slot
 * counter. Slot occupancy is derived from active subscription-funded
 * JobPublication records.
 *
 * SubscriptionJobLifecycleService owns publication effects when subscription
 * authority ends or an immediate downgrade reduces Job-slot capacity.
 *
 * PLAN CHANGES:
 *
 * A plan change is a new immediate purchase on the same continuing Subscription.
 *
 * pendingPlanChange represents only a purchase/payment currently in progress.
 * It is NOT another active plan and does not grant target-plan benefits.
 *
 * After a successful plan-change payment:
 *
 * - the old plan stops immediately;
 * - unused time/value on the old plan is forfeited;
 * - the target plan becomes the only current plan;
 * - downgrade Job-slot capacity is enforced immediately;
 * - a fresh billing period begins for the target plan;
 * - currentPlanStartedAt resets;
 * - currentPeriodStart resets;
 * - currentPeriodEnd is calculated from the new plan;
 * - renewalCount resets to zero.
 *
 * Two subscription plans are never effective concurrently.
 *
 * RENEWAL:
 *
 * Renewal renews the ONE currently effective plan.
 *
 * A plan-change payment in progress blocks renewal until the purchase either
 * succeeds or is cancelled/failed.
 *
 * PERIOD END:
 *
 * Benefits end at currentPeriodEnd unless a successful renewal advances the period.
 * A scheduled cancellation becomes cancelled at the boundary. Otherwise the
 * subscription becomes expired. There is no grace-period or past-due state.
 *
 * SHIFT BENEFIT:
 *
 * An active subscription may provide a reduced BASE Shift platform-fee rate.
 * This service exposes that current subscription benefit and its Subscription
 * reference. Shift pricing remains responsible for snapshotting the exact rate
 * applied to the Shift.
 */
class SubscriptionService {
  /* ─────────────────────────────── ERRORS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  /* ─────────────────────────────── CORE HELPERS ─────────────────────────────── */

  static normalizeObjectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,
      fieldName,
      required,
      createError: SubscriptionService.createError,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_SUBSCRIPTION_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeCountryCode(value) {
    const countryCode = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw this.createError({
        message: "A valid two-letter country code is required.",
        code: "INVALID_SUBSCRIPTION_COUNTRY_CODE",
      });
    }

    return countryCode;
  }

  static normalizeCurrency(value) {
    const currency = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw this.createError({
        message: "A valid three-letter currency code is required.",
        code: "INVALID_SUBSCRIPTION_CURRENCY",
      });
    }

    return currency;
  }

  static normalizePaymentReference(value) {
    const paymentReference = String(value || "")
      .trim()
      .toUpperCase();

    if (!paymentReference) {
      throw this.createError({
        message: "A plan-change payment reference is required.",
        code: "SUBSCRIPTION_PLAN_CHANGE_PAYMENT_REFERENCE_REQUIRED",
      });
    }

    if (paymentReference.length > MAX_PLAN_CHANGE_PAYMENT_REFERENCE_LENGTH) {
      throw this.createError({
        message: "The plan-change payment reference is too long.",
        code: "SUBSCRIPTION_PLAN_CHANGE_PAYMENT_REFERENCE_TOO_LONG",
      });
    }

    return paymentReference;
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    if (
      options.session &&
      (typeof options.session.inTransaction !== "function" || !options.session.inTransaction())
    ) {
      throw this.createError({
        message: "An active transaction is required for the supplied session.",
        code: "SUBSCRIPTION_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  static applySession(query, session = null) {
    if (session) {
      query.session(session);
    }

    return query;
  }

  static saveOptions(session = null) {
    return session ? { session } : {};
  }

  static assertCanManageSubscription(employerContext = null) {
    if (employerContext?.isPrimaryEmployer !== true && employerContext?.isBusinessAdmin !== true) {
      throw this.createError({
        message: "You do not have permission to manage this employer subscription.",
        code: "SUBSCRIPTION_MANAGEMENT_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
  }

  static assertBillingCycleSupported(value) {
    if (!SUBSCRIPTION_BILLING_CYCLES.includes(value)) {
      throw this.createError({
        message: "The subscription billing cycle is invalid.",
        code: "INVALID_SUBSCRIPTION_BILLING_CYCLE",
        statusCode: 500,
        details: {
          billingCycle: value || null,
        },
      });
    }

    return value;
  }

  static cloneDate(value) {
    return value ? new Date(value) : null;
  }

  static clonePlanSnapshot(snapshot) {
    const source = snapshot?.toObject ? snapshot.toObject() : snapshot;

    if (!source) {
      throw this.createError({
        message: "Subscription plan snapshot is missing.",
        code: "SUBSCRIPTION_PLAN_SNAPSHOT_MISSING",
        statusCode: 500,
      });
    }

    return {
      code: source.code,
      version: source.version,
      name: source.name,
      countryCode: source.countryCode,
      currency: source.currency,
      priceMinor: source.priceMinor,
      billingCycle: source.billingCycle,
      benefits: {
        activeJobSlots: source.benefits?.activeJobSlots ?? 0,
        basePlatformFeeRate: source.benefits?.basePlatformFeeRate ?? null,
        featureKeys: Array.isArray(source.benefits?.featureKeys)
          ? [...source.benefits.featureKeys]
          : [],
      },
    };
  }

  static normalizeFeatureKeys(values) {
    return new Set(
      (Array.isArray(values) ? values : [])
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    );
  }

  /**
   * Determines whether the target plan is commercially an upgrade
   * or downgrade by comparing the complete benefit direction.
   *
   * We deliberately do not infer plan direction from price alone.
   *
   * A target that simultaneously adds and removes benefits is
   * ambiguous without an explicit plan-ordering rule, so it is
   * rejected instead of guessed.
   */
  static comparePlanBenefitDirection({ currentSnapshot, targetSnapshot }) {
    let hasUpgrade = false;
    let hasDowngrade = false;

    const currentSlots = Number(currentSnapshot?.benefits?.activeJobSlots ?? 0);
    const targetSlots = Number(targetSnapshot?.benefits?.activeJobSlots ?? 0);

    if (
      !Number.isSafeInteger(currentSlots) ||
      currentSlots < 0 ||
      !Number.isSafeInteger(targetSlots) ||
      targetSlots < 0
    ) {
      throw this.createError({
        message: "Subscription plan Job-slot capacity is invalid.",
        code: "INVALID_SUBSCRIPTION_PLAN_JOB_SLOT_CAPACITY",
        statusCode: 500,
      });
    }

    if (targetSlots > currentSlots) {
      hasUpgrade = true;
    } else if (targetSlots < currentSlots) {
      hasDowngrade = true;
    }

    const currentRate = currentSnapshot?.benefits?.basePlatformFeeRate ?? null;
    const targetRate = targetSnapshot?.benefits?.basePlatformFeeRate ?? null;

    if (currentRate === null && targetRate !== null) {
      hasUpgrade = true;
    } else if (currentRate !== null && targetRate === null) {
      hasDowngrade = true;
    } else if (currentRate !== null && targetRate !== null) {
      const currentRateNumber = Number(currentRate);
      const targetRateNumber = Number(targetRate);

      if (!Number.isFinite(currentRateNumber) || !Number.isFinite(targetRateNumber)) {
        throw this.createError({
          message: "Subscription plan platform-fee benefit is invalid.",
          code: "INVALID_SUBSCRIPTION_PLAN_PLATFORM_FEE_RATE",
          statusCode: 500,
        });
      }

      /*
       * A lower employer platform fee is a stronger
       * commercial benefit.
       */
      if (targetRateNumber < currentRateNumber) {
        hasUpgrade = true;
      } else if (targetRateNumber > currentRateNumber) {
        hasDowngrade = true;
      }
    }

    const currentFeatures = this.normalizeFeatureKeys(currentSnapshot?.benefits?.featureKeys);
    const targetFeatures = this.normalizeFeatureKeys(targetSnapshot?.benefits?.featureKeys);

    const targetContainsAllCurrentFeatures = [...currentFeatures].every((feature) =>
      targetFeatures.has(feature)
    );

    const currentContainsAllTargetFeatures = [...targetFeatures].every((feature) =>
      currentFeatures.has(feature)
    );

    if (!currentContainsAllTargetFeatures) {
      hasUpgrade = true;
    }

    if (!targetContainsAllCurrentFeatures) {
      hasDowngrade = true;
    }

    if (hasUpgrade && hasDowngrade) {
      throw this.createError({
        message:
          "The target plan both adds and removes subscription benefits. Mixed-benefit plan changes are not supported without an explicit plan-ordering policy.",
        code: "SUBSCRIPTION_PLAN_CHANGE_MIXED_BENEFITS_NOT_SUPPORTED",
        statusCode: 409,
      });
    }

    if (!hasUpgrade && !hasDowngrade) {
      throw this.createError({
        message:
          "The target plan does not represent an upgrade or downgrade in subscription benefits.",
        code: "SUBSCRIPTION_PLAN_CHANGE_EQUIVALENT_BENEFITS",
        statusCode: 409,
      });
    }

    return hasUpgrade ? "upgrade" : "downgrade";
  }

  /* ─────────────────────────────── PERIOD HELPERS ─────────────────────────────── */

  static addUtcMonthsPreservingAnchor(value, monthsToAdd) {
    const date = this.normalizeCurrentTime(value);
    const months = Number(monthsToAdd);

    if (!Number.isSafeInteger(months) || months <= 0) {
      throw this.createError({
        message: "Subscription period offset is invalid.",
        code: "INVALID_SUBSCRIPTION_PERIOD_OFFSET",
        statusCode: 500,
      });
    }

    const originalDay = date.getUTCDate();
    const originalHour = date.getUTCHours();
    const originalMinute = date.getUTCMinutes();
    const originalSecond = date.getUTCSeconds();
    const originalMillisecond = date.getUTCMilliseconds();

    const targetMonthStart = new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth() + months,
        1,
        originalHour,
        originalMinute,
        originalSecond,
        originalMillisecond
      )
    );

    const targetYear = targetMonthStart.getUTCFullYear();
    const targetMonth = targetMonthStart.getUTCMonth();

    const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    return new Date(
      Date.UTC(
        targetYear,
        targetMonth,
        Math.min(originalDay, lastTargetDay),
        originalHour,
        originalMinute,
        originalSecond,
        originalMillisecond
      )
    );
  }

  static getBillingPeriodEnd({ activatedAt, billingCycle, cycleNumber }) {
    const normalizedBillingCycle = this.assertBillingCycleSupported(billingCycle);
    const normalizedCycleNumber = Number(cycleNumber);

    if (!Number.isSafeInteger(normalizedCycleNumber) || normalizedCycleNumber <= 0) {
      throw this.createError({
        message: "Subscription billing period number is invalid.",
        code: "INVALID_SUBSCRIPTION_BILLING_PERIOD_NUMBER",
        statusCode: 500,
      });
    }

    const monthsPerCycle = normalizedBillingCycle === "monthly" ? 1 : 12;

    return this.addUtcMonthsPreservingAnchor(activatedAt, monthsPerCycle * normalizedCycleNumber);
  }

  static buildBillingCycleKey({ subscriptionId, periodStart }) {
    const normalizedSubscriptionId = this.normalizeObjectId(subscriptionId, "subscription ID");
    const normalizedPeriodStart = this.normalizeCurrentTime(periodStart);

    return `${normalizedSubscriptionId}:${normalizedPeriodStart.toISOString()}`;
  }

  /* ─────────────────────────────── DATA LOADERS ─────────────────────────────── */

  static async getEmployerProfile(employerProfileId, session = null) {
    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const employerProfile = await this.applySession(
      EmployerProfile.findById(normalizedEmployerProfileId).select(
        "user businessName countryCode currency"
      ),
      session
    );

    if (!employerProfile) {
      throw this.createError({
        message: "Employer profile not found.",
        code: "SUBSCRIPTION_EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employerProfile;
  }

  static async getPlan(planId, session = null) {
    const normalizedPlanId = this.normalizeObjectId(planId, "subscription plan ID");

    const plan = await this.applySession(SubscriptionPlan.findById(normalizedPlanId), session);

    if (!plan) {
      throw this.createError({
        message: "Subscription plan not found.",
        code: "SUBSCRIPTION_PLAN_NOT_FOUND",
        statusCode: 404,
      });
    }

    return plan;
  }

  static async getSubscription({ subscriptionId, employerProfileId = null, session = null }) {
    const normalizedSubscriptionId = this.normalizeObjectId(subscriptionId, "subscription ID");

    const filter = {
      _id: normalizedSubscriptionId,
    };

    if (employerProfileId) {
      filter.business = this.normalizeObjectId(employerProfileId, "employer profile ID");
    }

    const subscription = await this.applySession(Subscription.findOne(filter), session);

    if (!subscription) {
      throw this.createError({
        message: "Subscription not found.",
        code: "SUBSCRIPTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return subscription;
  }

  static assertPlanAvailableForEmployer({ plan, employerProfile }) {
    if (plan.status !== "active") {
      throw this.createError({
        message:
          "This subscription plan is not currently available for new subscriptions or plan changes.",
        code: "SUBSCRIPTION_PLAN_NOT_ACTIVE",
        statusCode: 409,
      });
    }

    const employerCountryCode = this.normalizeCountryCode(employerProfile.countryCode);
    const employerCurrency = this.normalizeCurrency(employerProfile.currency);
    const planCountryCode = this.normalizeCountryCode(plan.countryCode);
    const planCurrency = this.normalizeCurrency(plan.currency);

    if (employerCountryCode !== planCountryCode || employerCurrency !== planCurrency) {
      throw this.createError({
        message: "This subscription plan is not available for the employer's market.",
        code: "SUBSCRIPTION_PLAN_MARKET_MISMATCH",
        statusCode: 409,
        details: {
          employerCountryCode,
          employerCurrency,
          planCountryCode,
          planCurrency,
        },
      });
    }

    return true;
  }

  static buildPlanSnapshot(plan) {
    return {
      code: plan.code,
      version: plan.version,
      name: plan.name,
      countryCode: plan.countryCode,
      currency: plan.currency,
      priceMinor: plan.priceMinor,
      billingCycle: plan.billingCycle,
      benefits: {
        activeJobSlots: plan.benefits?.activeJobSlots ?? 0,
        basePlatformFeeRate: plan.benefits?.basePlatformFeeRate ?? null,
        featureKeys: Array.isArray(plan.benefits?.featureKeys)
          ? [...plan.benefits.featureKeys]
          : [],
      },
    };
  }

  /* ─────────────────────────────── PLAN READS ─────────────────────────────── */

  static async listActivePlans({ countryCode, currency }, options = {}) {
    const normalizedCountryCode = this.normalizeCountryCode(countryCode);
    const normalizedCurrency = this.normalizeCurrency(currency);

    const query = SubscriptionPlan.find({
      countryCode: normalizedCountryCode,
      currency: normalizedCurrency,
      status: "active",
    }).sort({
      priceMinor: 1,
      name: 1,
      version: -1,
    });

    return this.applySession(query, options.session || null);
  }

  /* ─────────────────────────────── SUBSCRIPTION CREATION ─────────────────────────────── */

  static async createSubscription(
    {
      employerProfileId,
      employerContext = null,
      planId,
      subscribedByUserId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    this.assertCanManageSubscription(employerContext);

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedPlanId = this.normalizeObjectId(planId, "subscription plan ID");

    const normalizedSubscribedByUserId = this.normalizeObjectId(
      subscribedByUserId,
      "subscribed-by user ID"
    );

    const createdAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      // Operations sharing one transaction session must run sequentially.
      const employerProfile = await this.getEmployerProfile(normalizedEmployerProfileId, session);
      const plan = await this.getPlan(normalizedPlanId, session);

      this.assertPlanAvailableForEmployer({
        plan,
        employerProfile,
      });

      /*
       * Two concurrent creations can both observe no pending/active Subscription
       * and insert different documents. A transaction alone does not prevent it.
       * Serialize creation for this employer with a real version-key write before
       * the live-subscription check. Preserve write-conflict errors so the owner
       * retries the entire transaction and rechecks current state.
       *
       * __v already exists on EmployerProfile; this is not a commercial balance.
       * Do not change profile timestamps or business fields for coordination.
       */
      const creationGuard = await EmployerProfile.updateOne(
        { _id: normalizedEmployerProfileId },
        { $inc: { __v: 1 } },
        { session, timestamps: false }
      );

      if (creationGuard.matchedCount !== 1 || creationGuard.modifiedCount !== 1) {
        throw this.createError({
          message: "Employer profile is no longer available for subscription creation.",
          code: "SUBSCRIPTION_EMPLOYER_PROFILE_NOT_FOUND",
          statusCode: 404,
        });
      }

      const existingLiveSubscription = await this.applySession(
        Subscription.findOne({
          business: normalizedEmployerProfileId,
          status: {
            $in: LIVE_SUBSCRIPTION_STATUSES,
          },
        }).sort({
          createdAt: -1,
        }),
        session
      );

      if (existingLiveSubscription) {
        throw this.createError({
          message: "This employer already has a pending or current subscription.",
          code: "EMPLOYER_SUBSCRIPTION_ALREADY_EXISTS",
          statusCode: 409,
          details: {
            subscriptionId: String(existingLiveSubscription._id),
            status: existingLiveSubscription.status,
          },
        });
      }

      const subscriptionPayload = {
        referenceCode: generateReference("LQ-SUB"),
        business: normalizedEmployerProfileId,
        plan: normalizedPlanId,
        subscribedBy: normalizedSubscribedByUserId,
        planSnapshot: this.buildPlanSnapshot(plan),
        status: "pending",
        activatedAt: null,
        currentPlanStartedAt: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        renewalCount: 0,
        pendingPlanChange: null,
        planChangeHistory: [],
        cancelAtPeriodEnd: false,
        cancellationRequestedAt: null,
        cancellationRequestedBy: null,
        cancelledAt: null,
        endedAt: null,
      };

      const [subscription] = await Subscription.create([subscriptionPayload], { session });

      return {
        subscription,
        created: true,
        idempotent: false,
        createdAt,
        events: [
          {
            type: "subscription_created",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            planId: String(subscription.plan),
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── PLAN CHANGES ─────────────────────────────── */

  static async preparePlanChangePurchase(
    {
      subscriptionId,
      employerProfileId,
      employerContext = null,
      targetPlanId,
      requestedByUserId,
      retainedPublicationIds = [],
      paymentReference,
      currentTime = new Date(),
    },
    options = {}
  ) {
    this.assertCanManageSubscription(employerContext);

    const requestedAt = this.normalizeCurrentTime(currentTime);

    const normalizedTargetPlanId = this.normalizeObjectId(
      targetPlanId,
      "target subscription plan ID"
    );

    const normalizedRequestedByUserId = this.normalizeObjectId(
      requestedByUserId,
      "plan-change request user ID"
    );

    const normalizedPaymentReference = this.normalizePaymentReference(paymentReference);

    if (
      retainedPublicationIds !== null &&
      retainedPublicationIds !== undefined &&
      !Array.isArray(retainedPublicationIds)
    ) {
      throw this.createError({
        message: "retainedPublicationIds must be an array.",
        code: "INVALID_RETAINED_JOB_PUBLICATION_IDS",
      });
    }

    const normalizedRetainedPublicationIds = Array.isArray(retainedPublicationIds)
      ? retainedPublicationIds
      : [];

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (subscription.status !== "active") {
        throw this.createError({
          message: "Only an active subscription can purchase a different plan.",
          code: "SUBSCRIPTION_PLAN_CHANGE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      if (
        !subscription.currentPeriodStart ||
        !subscription.currentPeriodEnd ||
        requestedAt >= new Date(subscription.currentPeriodEnd)
      ) {
        throw this.createError({
          message:
            "A plan change cannot be started after the current purchased subscription period has ended.",
          code: "SUBSCRIPTION_PLAN_CHANGE_PERIOD_ENDED",
          statusCode: 409,
          details: {
            currentPeriodEnd: subscription.currentPeriodEnd || null,
          },
        });
      }

      if (subscription.cancelAtPeriodEnd) {
        throw this.createError({
          message: "A subscription scheduled for cancellation cannot purchase a different plan.",
          code: "SUBSCRIPTION_PLAN_CHANGE_BLOCKED_BY_CANCELLATION",
          statusCode: 409,
        });
      }

      if (subscription.pendingPlanChange) {
        const pending = subscription.pendingPlanChange;

        if (
          pending.paymentReference === normalizedPaymentReference &&
          String(pending.targetPlan) === String(normalizedTargetPlanId) &&
          String(pending.requestedBy) === String(normalizedRequestedByUserId)
        ) {
          return {
            subscription,
            prepared: false,
            idempotent: true,
            changeType: pending.changeType,
            targetPlanId: pending.targetPlan,
            targetPlan: null,
            targetPlanSnapshot: this.clonePlanSnapshot(pending.targetPlanSnapshot),
            retention: null,
            events: [],
          };
        }

        throw this.createError({
          message: "This subscription already has a different plan-change purchase in progress.",
          code: "SUBSCRIPTION_PLAN_CHANGE_ALREADY_PENDING",
          statusCode: 409,
          details: {
            targetPlanId: String(pending.targetPlan),
            changeType: pending.changeType,
            paymentReference: pending.paymentReference,
          },
        });
      }

      if (String(subscription.plan) === String(normalizedTargetPlanId)) {
        throw this.createError({
          message: "The target subscription plan is already the current plan.",
          code: "SUBSCRIPTION_PLAN_CHANGE_TARGET_UNCHANGED",
          statusCode: 409,
        });
      }

      const employerProfile = await this.getEmployerProfile(subscription.business, session);
      const targetPlan = await this.getPlan(normalizedTargetPlanId, session);

      this.assertPlanAvailableForEmployer({
        plan: targetPlan,
        employerProfile,
      });

      const currentPlanSnapshot = this.clonePlanSnapshot(subscription.planSnapshot);
      const targetPlanSnapshot = this.buildPlanSnapshot(targetPlan);

      if (
        currentPlanSnapshot.countryCode !== targetPlanSnapshot.countryCode ||
        currentPlanSnapshot.currency !== targetPlanSnapshot.currency
      ) {
        throw this.createError({
          message: "A subscription plan change must remain in the same country and currency.",
          code: "SUBSCRIPTION_PLAN_CHANGE_MARKET_MISMATCH",
          statusCode: 409,
        });
      }

      this.assertBillingCycleSupported(targetPlanSnapshot.billingCycle);

      const changeType = this.comparePlanBenefitDirection({
        currentSnapshot: currentPlanSnapshot,
        targetSnapshot: targetPlanSnapshot,
      });

      let retention = null;
      let retainedIds = [];

      if (changeType === "upgrade") {
        if (normalizedRetainedPublicationIds.length > 0) {
          throw this.createError({
            message: "An upgrade cannot specify retained Job publications.",
            code: "SUBSCRIPTION_UPGRADE_RETAINED_PUBLICATIONS_NOT_ALLOWED",
            statusCode: 409,
          });
        }
      } else {
        const targetActiveJobSlots = Number(targetPlanSnapshot.benefits.activeJobSlots);

        retention = await SubscriptionJobLifecycleService.validateDowngradeRetentionSelection({
          subscriptionId: subscription._id,
          businessId: subscription.business,
          targetActiveJobSlots,
          retainedPublicationIds: normalizedRetainedPublicationIds,
          session,
        });

        retainedIds = retention.effectiveRetainedPublicationIds;
      }

      subscription.pendingPlanChange = {
        changeType,
        targetPlan: targetPlan._id,
        targetPlanSnapshot,
        paymentReference: normalizedPaymentReference,
        requestedAt,
        requestedBy: normalizedRequestedByUserId,
        retainedPublicationIds: retainedIds,
      };

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        prepared: true,
        idempotent: false,
        changeType,
        targetPlanId: targetPlan._id,
        targetPlan,
        targetPlanSnapshot,
        retention: retention
          ? {
              activePublicationCount: retention.activePublicationCount,
              targetActiveJobSlots: retention.targetActiveJobSlots,
              requiresSelection: retention.requiresSelection,
              retainedPublicationIds: retention.effectiveRetainedPublicationIds,
              excessPublicationIds: retention.excessPublications.map(
                (publication) => publication._id
              ),
            }
          : null,
        events: [
          {
            type: "subscription_plan_change_purchase_prepared",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            fromPlanId: String(subscription.plan),
            toPlanId: String(targetPlan._id),
            changeType,
            paymentReference: normalizedPaymentReference,
            requestedAt,
          },
        ],
      };
    });
  }

  static async applyPaidPlanChange(
    { subscriptionId, employerProfileId, targetPlanId, paymentReference, currentTime = new Date() },
    options = {}
  ) {
    const appliedAt = this.normalizeCurrentTime(currentTime);

    const normalizedTargetPlanId = this.normalizeObjectId(
      targetPlanId,
      "target subscription plan ID"
    );

    const normalizedPaymentReference = this.normalizePaymentReference(paymentReference);

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      const planChangeHistory = Array.isArray(subscription.planChangeHistory)
        ? subscription.planChangeHistory
        : [];

      const latestHistory =
        planChangeHistory.length > 0 ? planChangeHistory[planChangeHistory.length - 1] : null;

      if (!subscription.pendingPlanChange) {
        if (
          latestHistory &&
          String(subscription.plan) === String(normalizedTargetPlanId) &&
          String(latestHistory.toPlan) === String(normalizedTargetPlanId) &&
          latestHistory.paymentReference === normalizedPaymentReference
        ) {
          return {
            subscription,
            applied: false,
            idempotent: true,
            changeType: latestHistory.changeType,
            previousPlanId: latestHistory.fromPlan,
            targetPlanId: latestHistory.toPlan,
            periodStart: subscription.currentPeriodStart,
            periodEnd: subscription.currentPeriodEnd,
            endedPublicationIds: [],
            retainedPublicationIds: Array.isArray(latestHistory.retainedPublicationIds)
              ? [...latestHistory.retainedPublicationIds]
              : [],
            events: [],
          };
        }

        throw this.createError({
          message:
            "This subscription does not have the matching plan-change purchase waiting to be applied.",
          code: "SUBSCRIPTION_PLAN_CHANGE_NOT_PREPARED",
          statusCode: 409,
        });
      }

      if (subscription.status !== "active") {
        throw this.createError({
          message: "Only an active subscription can apply a paid plan change.",
          code: "SUBSCRIPTION_PLAN_CHANGE_APPLICATION_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      if (subscription.cancelAtPeriodEnd) {
        throw this.createError({
          message: "A subscription scheduled for cancellation cannot apply a paid plan change.",
          code: "SUBSCRIPTION_PLAN_CHANGE_APPLICATION_BLOCKED_BY_CANCELLATION",
          statusCode: 409,
        });
      }

      const pending = subscription.pendingPlanChange;

      if (
        String(pending.targetPlan) !== String(normalizedTargetPlanId) ||
        pending.paymentReference !== normalizedPaymentReference
      ) {
        throw this.createError({
          message:
            "The paid plan-change payment does not match the plan change prepared on this subscription.",
          code: "SUBSCRIPTION_PLAN_CHANGE_PAYMENT_MISMATCH",
          statusCode: 409,
          details: {
            preparedTargetPlanId: String(pending.targetPlan),
            paidTargetPlanId: String(normalizedTargetPlanId),
            preparedPaymentReference: pending.paymentReference,
            paidPaymentReference: normalizedPaymentReference,
          },
        });
      }

      if (pending.requestedAt && appliedAt < new Date(pending.requestedAt)) {
        throw this.createError({
          message: "A plan change cannot be applied before it was requested.",
          code: "SUBSCRIPTION_PLAN_CHANGE_APPLICATION_TIME_INVALID",
          statusCode: 409,
        });
      }

      if (!subscription.currentPeriodEnd || appliedAt >= new Date(subscription.currentPeriodEnd)) {
        throw this.createError({
          message:
            "A paid plan change cannot be applied after the current subscription period has ended.",
          code: "SUBSCRIPTION_PLAN_CHANGE_APPLICATION_PERIOD_ENDED",
          statusCode: 409,
          details: {
            currentPeriodEnd: subscription.currentPeriodEnd || null,
          },
        });
      }

      const targetPlanSnapshot = this.clonePlanSnapshot(pending.targetPlanSnapshot);
      const billingCycle = this.assertBillingCycleSupported(targetPlanSnapshot.billingCycle);

      let lifecycle = null;

      if (pending.changeType === "downgrade") {
        lifecycle = await SubscriptionJobLifecycleService.applyDowngradePublicationCapacity(
          {
            subscriptionId: subscription._id,
            businessId: subscription.business,
            targetActiveJobSlots: targetPlanSnapshot.benefits.activeJobSlots,
            retainedPublicationIds: Array.isArray(pending.retainedPublicationIds)
              ? [...pending.retainedPublicationIds]
              : [],
            currentTime: appliedAt,
          },
          {
            session,
          }
        );
      }

      const previousPlanId = subscription.plan;

      const periodStart = appliedAt;

      const periodEnd = this.getBillingPeriodEnd({
        activatedAt: periodStart,
        billingCycle,
        cycleNumber: 1,
      });

      const retainedIds =
        pending.changeType === "downgrade" ? lifecycle?.retainedPublicationIds || [] : [];

      subscription.planChangeHistory.push({
        changeType: pending.changeType,
        fromPlan: previousPlanId,
        toPlan: pending.targetPlan,
        paymentReference: normalizedPaymentReference,
        requestedAt: pending.requestedAt,
        requestedBy: pending.requestedBy,
        effectiveAt: appliedAt,
        appliedAt,
        retainedPublicationIds: retainedIds,
      });

      subscription.plan = pending.targetPlan;
      subscription.planSnapshot = targetPlanSnapshot;
      subscription.status = "active";
      subscription.currentPlanStartedAt = periodStart;
      subscription.currentPeriodStart = periodStart;
      subscription.currentPeriodEnd = periodEnd;
      subscription.renewalCount = 0;
      subscription.pendingPlanChange = null;

      subscription.markModified("plan");
      subscription.markModified("planSnapshot");
      subscription.markModified("planChangeHistory");
      subscription.markModified("currentPlanStartedAt");
      subscription.markModified("currentPeriodStart");
      subscription.markModified("currentPeriodEnd");
      subscription.markModified("renewalCount");
      subscription.markModified("pendingPlanChange");

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        applied: true,
        idempotent: false,
        changeType: pending.changeType,
        previousPlanId,
        targetPlanId: subscription.plan,
        periodStart,
        periodEnd,
        endedPublicationIds: lifecycle?.endedPublicationIds || [],
        retainedPublicationIds: retainedIds,
        events: [
          ...(lifecycle?.events || []),
          {
            type: "subscription_plan_changed",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            fromPlanId: String(previousPlanId),
            toPlanId: String(subscription.plan),
            changeType: pending.changeType,
            paymentReference: normalizedPaymentReference,
            effectiveAt: appliedAt,
            periodStart,
            periodEnd,
          },
        ],
      };
    });
  }

  static async cancelPendingPlanChangePurchase(
    { subscriptionId, employerProfileId, targetPlanId, paymentReference, currentTime = new Date() },
    options = {}
  ) {
    const cancelledAt = this.normalizeCurrentTime(currentTime);

    const normalizedTargetPlanId = this.normalizeObjectId(
      targetPlanId,
      "target subscription plan ID"
    );

    const normalizedPaymentReference = this.normalizePaymentReference(paymentReference);

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (!subscription.pendingPlanChange) {
        return {
          subscription,
          cancelled: false,
          idempotent: true,
          events: [],
        };
      }

      const pending = subscription.pendingPlanChange;

      if (
        String(pending.targetPlan) !== String(normalizedTargetPlanId) ||
        pending.paymentReference !== normalizedPaymentReference
      ) {
        throw this.createError({
          message:
            "The plan-change purchase being cancelled does not match the subscription's pending plan change.",
          code: "SUBSCRIPTION_PLAN_CHANGE_CANCELLATION_MISMATCH",
          statusCode: 409,
          details: {
            preparedTargetPlanId: String(pending.targetPlan),
            requestedTargetPlanId: String(normalizedTargetPlanId),
            preparedPaymentReference: pending.paymentReference,
            requestedPaymentReference: normalizedPaymentReference,
          },
        });
      }

      const event = {
        type: "subscription_plan_change_purchase_cancelled",
        subscriptionId: String(subscription._id),
        employerProfileId: String(subscription.business),
        targetPlanId: String(pending.targetPlan),
        changeType: pending.changeType,
        paymentReference: pending.paymentReference,
        cancelledAt,
      };

      subscription.pendingPlanChange = null;

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        cancelled: true,
        idempotent: false,
        events: [event],
      };
    });
  }

  /* ─────────────────────────────── ACTIVATION / RENEWAL ─────────────────────────────── */

  static async activateSubscription(
    { subscriptionId, employerProfileId, currentTime = new Date() },
    options = {}
  ) {
    const activatedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (subscription.status === "active") {
        return {
          subscription,
          activated: false,
          idempotent: true,
          events: [],
        };
      }

      if (subscription.status !== "pending") {
        throw this.createError({
          message: "Only a pending subscription can be activated.",
          code: "SUBSCRIPTION_ACTIVATION_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      const billingCycle = this.assertBillingCycleSupported(subscription.planSnapshot.billingCycle);

      const periodStart = activatedAt;

      const periodEnd = this.getBillingPeriodEnd({
        activatedAt: periodStart,
        billingCycle,
        cycleNumber: 1,
      });

      subscription.status = "active";
      subscription.activatedAt = activatedAt;
      subscription.currentPlanStartedAt = activatedAt;
      subscription.currentPeriodStart = periodStart;
      subscription.currentPeriodEnd = periodEnd;
      subscription.renewalCount = 0;

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        activated: true,
        idempotent: false,
        events: [
          {
            type: "subscription_activated",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            planId: String(subscription.plan),
            periodStart,
            periodEnd,
          },
        ],
      };
    });
  }

  static async renewSubscription(
    { subscriptionId, employerProfileId, currentTime = new Date() },
    options = {}
  ) {
    const renewedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (subscription.status !== "active") {
        throw this.createError({
          message: "Only an active subscription can renew.",
          code: "SUBSCRIPTION_RENEWAL_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      if (subscription.cancelAtPeriodEnd) {
        throw this.createError({
          message: "A subscription scheduled for cancellation cannot renew.",
          code: "SUBSCRIPTION_RENEWAL_BLOCKED_BY_CANCELLATION",
          statusCode: 409,
        });
      }

      if (subscription.pendingPlanChange) {
        throw this.createError({
          message: "A subscription with a plan-change purchase in progress cannot renew.",
          code: "SUBSCRIPTION_RENEWAL_BLOCKED_BY_PLAN_CHANGE",
          statusCode: 409,
          details: {
            targetPlanId: String(subscription.pendingPlanChange.targetPlan),
            paymentReference: subscription.pendingPlanChange.paymentReference,
          },
        });
      }

      const currentPeriodEnd = this.cloneDate(subscription.currentPeriodEnd);

      if (!currentPeriodEnd || renewedAt < currentPeriodEnd) {
        throw this.createError({
          message: "The current subscription billing period has not ended yet.",
          code: "SUBSCRIPTION_RENEWAL_TOO_EARLY",
          statusCode: 409,
          details: {
            currentPeriodEnd,
          },
        });
      }

      const currentPlanStartedAt = this.cloneDate(subscription.currentPlanStartedAt);

      if (!currentPlanStartedAt) {
        throw this.createError({
          message: "The current subscription plan is missing its billing anchor.",
          code: "SUBSCRIPTION_CURRENT_PLAN_ANCHOR_MISSING",
          statusCode: 500,
        });
      }

      const billingCycle = this.assertBillingCycleSupported(subscription.planSnapshot.billingCycle);

      const nextCycleNumber = Number(subscription.renewalCount || 0) + 2;

      const nextPeriodStart = currentPeriodEnd;

      const nextPeriodEnd = this.getBillingPeriodEnd({
        activatedAt: currentPlanStartedAt,
        billingCycle,
        cycleNumber: nextCycleNumber,
      });

      if (renewedAt >= nextPeriodEnd) {
        throw this.createError({
          message:
            "The next subscription billing period has already elapsed. This renewal cannot be applied.",
          code: "SUBSCRIPTION_RENEWAL_PERIOD_ALREADY_ELAPSED",
          statusCode: 409,
          details: {
            nextPeriodStart,
            nextPeriodEnd,
          },
        });
      }

      subscription.currentPeriodStart = nextPeriodStart;
      subscription.currentPeriodEnd = nextPeriodEnd;
      subscription.renewalCount = Number(subscription.renewalCount || 0) + 1;

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        renewed: true,
        idempotent: false,
        events: [
          {
            type: "subscription_renewed",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            planId: String(subscription.plan),
            periodStart: nextPeriodStart,
            periodEnd: nextPeriodEnd,
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── PERIOD-END LIFECYCLE ─────────────────────────────── */

  static async expireSubscription(
    { subscriptionId, employerProfileId, currentTime = new Date() },
    options = {}
  ) {
    const processedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (subscription.status === "expired") {
        return {
          subscription,
          expired: false,
          idempotent: true,
          events: [],
        };
      }

      if (subscription.status !== "active") {
        throw this.createError({
          message: "This subscription cannot be expired from its current state.",
          code: "SUBSCRIPTION_EXPIRY_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      if (subscription.cancelAtPeriodEnd) {
        throw this.createError({
          message: "A subscription scheduled for cancellation should be finalized as cancelled.",
          code: "SUBSCRIPTION_EXPIRY_BLOCKED_BY_CANCELLATION",
          statusCode: 409,
        });
      }

      const expiredAt = this.cloneDate(subscription.currentPeriodEnd);

      if (!expiredAt) {
        throw this.createError({
          message: "The subscription is missing its current billing-period end.",
          code: "SUBSCRIPTION_EXPIRY_PERIOD_MISSING",
          statusCode: 500,
        });
      }

      if (processedAt < expiredAt) {
        throw this.createError({
          message: "The subscription billing period has not ended yet.",
          code: "SUBSCRIPTION_EXPIRY_TOO_EARLY",
          statusCode: 409,
        });
      }

      // Coordinate with preparation and settlement before reading payment state.
      // This must be a real write in the same transaction as terminal expiry.
      // Preserve MongoDB conflict errors so the owner retries the whole callback.
      const coordination = await Subscription.updateOne(
        { _id: subscription._id, business: subscription.business, status: "active" },
        { $inc: { __v: 1 } },
        { session, timestamps: false }
      );

      if (coordination.matchedCount !== 1 || coordination.modifiedCount !== 1) {
        throw this.createError({
          message: "Subscription changed before expiry could be decided.",
          code: "SUBSCRIPTION_EXPIRY_AUTHORITY_CHANGED",
          statusCode: 409,
        });
      }

      const unresolvedPayment = await this.applySession(
        SubscriptionPayment.exists({
          subscription: subscription._id,
          business: subscription.business,
          $or: [{ paymentStatus: "pending" }, { paymentStatus: "paid", appliedAt: null }],
        }),
        session
      );

      if (unresolvedPayment) {
        throw this.createError({
          message: "Subscription payment reconciliation is required before expiry.",
          code: "SUBSCRIPTION_EXPIRY_PAYMENT_RECONCILIATION_REQUIRED",
          statusCode: 409,
          details: { subscriptionId: String(subscription._id) },
        });
      }

      const pendingPlanChange = subscription.pendingPlanChange
        ? {
            targetPlan: subscription.pendingPlanChange.targetPlan,
            changeType: subscription.pendingPlanChange.changeType,
            paymentReference: subscription.pendingPlanChange.paymentReference,
          }
        : null;

      const lifecycle = await SubscriptionJobLifecycleService.endActiveSubscriptionPublications(
        {
          subscriptionId: subscription._id,
          businessId: subscription.business,
          currentTime: expiredAt,
          reason: "Subscription expired and no longer provides Job-slot publication authority.",
        },
        {
          session,
        }
      );

      subscription.status = "expired";
      subscription.endedAt = expiredAt;
      subscription.cancelAtPeriodEnd = false;
      subscription.pendingPlanChange = null;

      await subscription.save(this.saveOptions(session));

      const events = [...(lifecycle.events || [])];

      if (pendingPlanChange) {
        events.push({
          type: "subscription_plan_change_purchase_cancelled",
          subscriptionId: String(subscription._id),
          employerProfileId: String(subscription.business),
          targetPlanId: String(pendingPlanChange.targetPlan),
          changeType: pendingPlanChange.changeType,
          paymentReference: pendingPlanChange.paymentReference,
          reason: "subscription_expired_before_payment_completed",
        });
      }

      events.push({
        type: "subscription_expired",
        subscriptionId: String(subscription._id),
        employerProfileId: String(subscription.business),
        expiredAt,
      });

      return {
        subscription,
        expired: true,
        idempotent: false,
        endedPublicationIds: lifecycle.endedPublicationIds,
        events,
      };
    });
  }

  /* ─────────────────────────────── CANCELLATION ─────────────────────────────── */

  static async requestCancellation(
    {
      subscriptionId,
      employerProfileId,
      employerContext = null,
      requestedByUserId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    this.assertCanManageSubscription(employerContext);

    const requestedAt = this.normalizeCurrentTime(currentTime);

    const normalizedRequestedByUserId = this.normalizeObjectId(
      requestedByUserId,
      "cancellation-request user ID"
    );

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (subscription.cancelAtPeriodEnd) {
        return {
          subscription,
          scheduled: false,
          idempotent: true,
          events: [],
        };
      }

      if (subscription.status !== "active") {
        throw this.createError({
          message: "Only an active subscription can be scheduled for cancellation.",
          code: "SUBSCRIPTION_CANCELLATION_REQUEST_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      if (
        !subscription.currentPeriodEnd ||
        requestedAt >= new Date(subscription.currentPeriodEnd)
      ) {
        throw this.createError({
          message:
            "A cancellation cannot be scheduled after the paid subscription period has ended.",
          code: "SUBSCRIPTION_CANCELLATION_PERIOD_ENDED",
          statusCode: 409,
          details: {
            currentPeriodEnd: subscription.currentPeriodEnd || null,
          },
        });
      }

      if (subscription.pendingPlanChange) {
        throw this.createError({
          message:
            "A plan-change payment in progress must be resolved before subscription cancellation can be scheduled.",
          code: "SUBSCRIPTION_CANCELLATION_BLOCKED_BY_PLAN_CHANGE",
          statusCode: 409,
          details: {
            targetPlanId: String(subscription.pendingPlanChange.targetPlan),
            paymentReference: subscription.pendingPlanChange.paymentReference,
          },
        });
      }

      subscription.cancelAtPeriodEnd = true;
      subscription.cancellationRequestedAt = requestedAt;
      subscription.cancellationRequestedBy = normalizedRequestedByUserId;

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        scheduled: true,
        idempotent: false,
        events: [
          {
            type: "subscription_cancellation_scheduled",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            currentPeriodEnd: subscription.currentPeriodEnd,
          },
        ],
      };
    });
  }

  static async finalizeScheduledCancellation(
    { subscriptionId, employerProfileId, currentTime = new Date() },
    options = {}
  ) {
    const processedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const subscription = await this.getSubscription({
        subscriptionId,
        employerProfileId,
        session,
      });

      if (subscription.status === "cancelled") {
        return {
          subscription,
          cancelled: false,
          idempotent: true,
          events: [],
        };
      }

      if (subscription.status !== "active") {
        throw this.createError({
          message: "This subscription cannot be finalized as cancelled from its current state.",
          code: "SUBSCRIPTION_CANCELLATION_FINALIZATION_NOT_ALLOWED",
          statusCode: 409,
          details: {
            status: subscription.status,
          },
        });
      }

      if (!subscription.cancelAtPeriodEnd || !subscription.cancellationRequestedAt) {
        throw this.createError({
          message: "This subscription is not scheduled for cancellation.",
          code: "SUBSCRIPTION_CANCELLATION_NOT_SCHEDULED",
          statusCode: 409,
        });
      }

      const cancelledAt = this.cloneDate(subscription.currentPeriodEnd);

      if (!cancelledAt) {
        throw this.createError({
          message: "The subscription is missing its current billing-period end.",
          code: "SUBSCRIPTION_CANCELLATION_PERIOD_MISSING",
          statusCode: 500,
        });
      }

      if (processedAt < cancelledAt) {
        throw this.createError({
          message: "The subscription cannot end before its current billing period finishes.",
          code: "SUBSCRIPTION_CANCELLATION_TOO_EARLY",
          statusCode: 409,
        });
      }

      if (subscription.pendingPlanChange) {
        throw this.createError({
          message:
            "A plan-change payment in progress must be resolved before cancellation can be finalized.",
          code: "SUBSCRIPTION_CANCELLATION_FINALIZATION_BLOCKED_BY_PLAN_CHANGE",
          statusCode: 409,
        });
      }

      const lifecycle = await SubscriptionJobLifecycleService.endActiveSubscriptionPublications(
        {
          subscriptionId: subscription._id,
          businessId: subscription.business,
          currentTime: cancelledAt,
          reason: "Subscription cancelled and no longer provides Job-slot publication authority.",
        },
        {
          session,
        }
      );

      subscription.status = "cancelled";
      subscription.cancelledAt = cancelledAt;
      subscription.endedAt = cancelledAt;
      subscription.cancelAtPeriodEnd = false;
      subscription.pendingPlanChange = null;

      await subscription.save(this.saveOptions(session));

      return {
        subscription,
        cancelled: true,
        idempotent: false,
        endedPublicationIds: lifecycle.endedPublicationIds,
        events: [
          ...(lifecycle.events || []),
          {
            type: "subscription_cancelled",
            subscriptionId: String(subscription._id),
            employerProfileId: String(subscription.business),
            cancelledAt,
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── ACTIVE SUBSCRIPTION ─────────────────────────────── */

  static async getActiveSubscription(
    { employerProfileId, currentTime = new Date() },
    options = {}
  ) {
    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const currentTimeValue = this.normalizeCurrentTime(currentTime);

    const query = Subscription.find({
      business: normalizedEmployerProfileId,
      status: BENEFIT_ELIGIBLE_SUBSCRIPTION_STATUS,
      currentPeriodStart: {
        $lte: currentTimeValue,
      },
      currentPeriodEnd: {
        $gt: currentTimeValue,
      },
    })
      .sort({
        currentPeriodEnd: -1,
        createdAt: -1,
      })
      .limit(2);

    const subscriptions = await this.applySession(query, options.session || null);

    if (subscriptions.length > 1) {
      throw this.createError({
        message: "Multiple active subscriptions were found for this employer.",
        code: "MULTIPLE_ACTIVE_EMPLOYER_SUBSCRIPTIONS",
        statusCode: 500,
        details: {
          employerProfileId: String(normalizedEmployerProfileId),
        },
      });
    }

    return subscriptions[0] || null;
  }

  static async getActiveSubscriptionBenefits(
    { employerProfileId, currentTime = new Date() },
    options = {}
  ) {
    const subscription = await this.getActiveSubscription(
      {
        employerProfileId,
        currentTime,
      },
      options
    );

    if (!subscription) {
      return null;
    }

    return {
      subscription,
      subscriptionId: subscription._id,
      planCode: subscription.planSnapshot.code,
      planName: subscription.planSnapshot.name,
      billingCycle: subscription.planSnapshot.billingCycle,
      activeJobSlots: subscription.planSnapshot?.benefits?.activeJobSlots ?? 0,
      basePlatformFeeRate: subscription.planSnapshot?.benefits?.basePlatformFeeRate ?? null,
      featureKeys: Array.isArray(subscription.planSnapshot?.benefits?.featureKeys)
        ? [...subscription.planSnapshot.benefits.featureKeys]
        : [],
      currentPlanStartedAt: subscription.currentPlanStartedAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }
}

module.exports = SubscriptionService;
