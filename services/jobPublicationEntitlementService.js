// services/jobPublicationEntitlementService.js

const crypto = require("crypto");

const JobPublication = require("../models/JobPublication");
const Subscription = require("../models/Subscription");

const PlatformSettingsService = require("./platformSettingsService");
const JobPublicationService = require("./jobPublicationService");
const SubscriptionService = require("./subscriptionService");
const JobPublicationPaymentService = require("./jobPublicationPaymentService");

const { JOB_PUBLICATION_ENTITLEMENT_SOURCES } = require("../constants/jobPosting");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const ERROR_NAME = "JobPublicationEntitlementServiceError";

const FREE_ENTITLEMENT_SOURCE = "free";
const SUBSCRIPTION_ENTITLEMENT_SOURCE = "subscription_slot";
const PAYG_ENTITLEMENT_SOURCE = "paid_single_post";

const ACTIVE_SUBSCRIPTION_PUBLICATION_STATUSES = Object.freeze(["live", "paused"]);

const SUBSCRIPTION_SLOT_REFERENCE_PREFIX = "subscription-slot";
const MONTHLY_FREE_JOB_PUBLICATION_LIMIT = 1;

const SUPPORTED_PUBLICATION_MODES = Object.freeze(["free", "paid", "subscription", "hybrid"]);

const COMMERCIAL_SERVICE_ERROR_NAMES = Object.freeze([
  "SubscriptionServiceError",
  "JobPublicationPaymentServiceError",
]);

/**
 * JobPublicationEntitlementService is the commercial-authorization boundary
 * between permanent-Job publication and employer monetisation.
 *
 * AUTHORITY:
 *
 * - free mode grants unrestricted free publication entitlements;
 * - subscription mode authorizes publication when active Job-slot capacity exists;
 * - paid mode consumes an eligible paid JobPayment;
 * - hybrid mode resolves authority in this order:
 *
 *     monthly free allowance
 *     → available subscription Job slot
 *     → PAYG purchase
 *
 * Controllers never construct commercial entitlement grants. This service
 * resolves authoritative commercial records and passes the resulting grant to
 * JobPublicationService.
 *
 * DURABLE AUTHORITY:
 *
 * - monthly free usage is represented by the resulting JobPublication
 *   entitlementSnapshot;
 * - subscription slot occupancy is derived from live/paused JobPublication
 *   records belonging to the exact continuing Subscription;
 * - PAYG consumption is represented by JobPayment consumption fields and the
 *   resulting JobPublication entitlementSnapshot.
 *
 * PENDING PLAN CHANGES:
 *
 * A pending upgrade does not grant target-plan benefits before payment succeeds.
 * Subscription-slot resolution therefore continues to use only the current plan.
 *
 * If a pending downgrade reduces activeJobSlots, new subscription-funded Job
 * publications are temporarily blocked until that payment succeeds or the
 * plan-change purchase is cancelled. This prevents slot occupancy from changing
 * after the employer has selected which publications should survive the downgrade.
 * Free and PAYG publication paths remain independent.
 *
 * Subscription slot resolution, PAYG consumption and JobPublication creation
 * occur inside one MongoDB transaction. Failed publication therefore does not
 * create durable subscription occupancy or burn PAYG employer value.
 */
class JobPublicationEntitlementService {
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

  static normalizeCommercialServiceError(error) {
    if (!COMMERCIAL_SERVICE_ERROR_NAMES.includes(error?.name)) {
      return error;
    }

    const candidateStatusCode = Number(error?.statusCode);

    return this.createError({
      message: error.message || "Job publication commercial entitlement resolution failed.",
      code: error.code || "JOB_PUBLICATION_COMMERCIAL_ENTITLEMENT_FAILED",
      statusCode:
        Number.isInteger(candidateStatusCode) &&
        candidateStatusCode >= 400 &&
        candidateStatusCode <= 599
          ? candidateStatusCode
          : 500,
      details: error.details && typeof error.details === "object" ? error.details : null,
    });
  }

  /* ─────────────────────────────── CORE HELPERS ─────────────────────────────── */

  static normalizeObjectId(value, fieldName) {
    return normalizeObjectId({
      value,
      fieldName,
      createError: JobPublicationEntitlementService.createError,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_JOB_PUBLICATION_ENTITLEMENT_CURRENT_TIME",
        statusCode: 500,
      });
    }

    return currentTime;
  }

  static normalizePublicationMode(value) {
    const publicationMode = String(value || "")
      .trim()
      .toLowerCase();

    if (!SUPPORTED_PUBLICATION_MODES.includes(publicationMode)) {
      throw this.createError({
        message: "The configured Job publication mode is invalid.",
        code: "INVALID_JOB_PUBLICATION_MODE",
        statusCode: 500,
        details: {
          publicationMode: publicationMode || null,
        },
      });
    }

    return publicationMode;
  }

  static assertEntitlementSourceSupported(source) {
    if (
      !Array.isArray(JOB_PUBLICATION_ENTITLEMENT_SOURCES) ||
      !JOB_PUBLICATION_ENTITLEMENT_SOURCES.includes(source)
    ) {
      throw this.createError({
        message:
          `Job publication entitlement source ` + `${source} is not configured as supported.`,
        code: "JOB_PUBLICATION_ENTITLEMENT_SOURCE_NOT_CONFIGURED",
        statusCode: 500,
        details: {
          source,
        },
      });
    }
  }

  static assertCommercialConsumptionTransaction(session) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.createError({
        message:
          "Monthly-free, subscription-slot and PAYG Job publication entitlements " +
          "must be resolved inside the publication transaction.",
        code: "JOB_PUBLICATION_COMMERCIAL_ENTITLEMENT_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return true;
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    if (
      options.session &&
      (typeof options.session.inTransaction !== "function" || !options.session.inTransaction())
    ) {
      throw this.createError({
        message: "An active transaction is required for the supplied session.",
        code: "JOB_PUBLICATION_ENTITLEMENT_TRANSACTION_REQUIRED",
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

  /* ─────────────────────────────── PLATFORM POLICY ─────────────────────────────── */

  static assertPublicationAvailable(policy) {
    if (policy?.isEnabled !== true) {
      throw this.createError({
        message: "The permanent Job Board is currently unavailable.",
        code: "JOB_BOARD_DISABLED",
        statusCode: 503,
      });
    }

    if (policy?.publicationEnabled !== true) {
      throw this.createError({
        message: "New permanent Job publications are currently unavailable.",
        code: "JOB_PUBLICATION_DISABLED",
        statusCode: 503,
      });
    }
  }

  static async getPublicationPolicy() {
    const policy = await PlatformSettingsService.getJobBoardPolicy();

    this.assertPublicationAvailable(policy);

    return {
      ...policy,
      publicationMode: this.normalizePublicationMode(policy.publicationMode),
    };
  }

  /* ─────────────────────────────── FREE ENTITLEMENTS ─────────────────────────────── */

  static buildFreeEntitlementGrant({ consumptionReference, currentTime }) {
    this.assertEntitlementSourceSupported(FREE_ENTITLEMENT_SOURCE);

    return {
      source: FREE_ENTITLEMENT_SOURCE,
      consumptionReference,
      grantedAt: currentTime,
      consumedAt: currentTime,
    };
  }

  static buildUnrestrictedFreeConsumptionReference({ employerProfileId, jobId }) {
    return ["free-open", String(employerProfileId), String(jobId), crypto.randomUUID()].join(":");
  }

  /**
   * Monthly free posting allowance uses a UTC calendar month.
   *
   * Subscription Job slots use the active subscription lifecycle independently.
   * The free recurring allowance remains tied only to the UTC calendar month.
   */
  static buildMonthlyAllowancePeriod(currentTime) {
    const year = currentTime.getUTCFullYear();
    const monthIndex = currentTime.getUTCMonth();

    const periodStart = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));

    const periodEnd = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));

    const periodKey = `${year}-` + String(monthIndex + 1).padStart(2, "0");

    return {
      periodKey,
      periodStart,
      periodEnd,
    };
  }

  static buildMonthlyFreeConsumptionPrefix({ employerProfileId, periodKey }) {
    return `free-monthly:` + `${String(employerProfileId)}:` + `${periodKey}:`;
  }

  static buildMonthlyFreeConsumptionReference({ employerProfileId, periodKey, slotNumber }) {
    return (
      this.buildMonthlyFreeConsumptionPrefix({
        employerProfileId,
        periodKey,
      }) + slotNumber
    );
  }

  static async countConsumedMonthlyFreeEntitlements({
    employerProfileId,
    periodStart,
    periodEnd,
    periodKey,
    session = null,
  }) {
    const consumptionPrefix = this.buildMonthlyFreeConsumptionPrefix({
      employerProfileId,
      periodKey,
    });

    const query = JobPublication.countDocuments({
      business: employerProfileId,
      "entitlementSnapshot.source": FREE_ENTITLEMENT_SOURCE,
      "entitlementSnapshot.consumptionReference": {
        $regex: `^${consumptionPrefix}`,
      },
      publishedAt: {
        $gte: periodStart,
        $lt: periodEnd,
      },
    });

    return this.applySession(query, session);
  }

  static async obtainMonthlyFreeEntitlement({
    employerProfileId,
    currentTime,
    freeJobPostsPerMonth,
    freeJobPostRolloverEnabled,
    session = null,
  }) {
    this.assertCommercialConsumptionTransaction(session);

    if (freeJobPostsPerMonth !== MONTHLY_FREE_JOB_PUBLICATION_LIMIT) {
      throw this.createError({
        message: "The monthly free Job publication allowance must be exactly one publication.",
        code: "INVALID_FREE_JOB_POSTING_ALLOWANCE",
        statusCode: 500,
        details: {
          configuredLimit: freeJobPostsPerMonth ?? null,
          requiredLimit: MONTHLY_FREE_JOB_PUBLICATION_LIMIT,
        },
      });
    }

    if (freeJobPostRolloverEnabled !== false) {
      throw this.createError({
        message: "Free Job publication rollover must be disabled.",
        code: "FREE_JOB_POSTING_ROLLOVER_NOT_SUPPORTED",
        statusCode: 500,
      });
    }

    const { periodKey, periodStart, periodEnd } = this.buildMonthlyAllowancePeriod(currentTime);

    const usedCount = await this.countConsumedMonthlyFreeEntitlements({
      employerProfileId,
      periodStart,
      periodEnd,
      periodKey,
      session,
    });

    if (usedCount >= MONTHLY_FREE_JOB_PUBLICATION_LIMIT) {
      return null;
    }

    const slotNumber = 1;

    return {
      grant: this.buildFreeEntitlementGrant({
        consumptionReference: this.buildMonthlyFreeConsumptionReference({
          employerProfileId,
          periodKey,
          slotNumber,
        }),
        currentTime,
      }),
      allowance: {
        periodKey,
        periodStart,
        periodEnd,
        limit: MONTHLY_FREE_JOB_PUBLICATION_LIMIT,
        used: usedCount,
        remainingAfterGrant: 0,
        rolloverEnabled: false,
      },
    };
  }

  /* ─────────────────────────────── COMMERCIAL ENTITLEMENTS ─────────────────────────────── */

  static escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  static buildSubscriptionSlotPrefix({ subscriptionId, slotNumber = null }) {
    const base = `${SUBSCRIPTION_SLOT_REFERENCE_PREFIX}:` + `${String(subscriptionId)}`;

    if (slotNumber === null || slotNumber === undefined) {
      return `${base}:`;
    }

    const normalizedSlotNumber = Number(slotNumber);

    if (!Number.isSafeInteger(normalizedSlotNumber) || normalizedSlotNumber <= 0) {
      throw this.createError({
        message: "Subscription Job slot number is invalid.",
        code: "INVALID_SUBSCRIPTION_JOB_SLOT_NUMBER",
        statusCode: 500,
      });
    }

    return `${base}:${normalizedSlotNumber}:`;
  }

  static parseSubscriptionSlotNumber({ consumptionReference, subscriptionId }) {
    const prefix = this.buildSubscriptionSlotPrefix({
      subscriptionId,
    });

    const reference = String(consumptionReference || "");

    if (!reference.startsWith(prefix)) {
      return null;
    }

    const remainder = reference.slice(prefix.length);
    const [slotNumberText] = remainder.split(":");

    const slotNumber = Number(slotNumberText);

    return Number.isSafeInteger(slotNumber) && slotNumber > 0 ? slotNumber : null;
  }

  static async getActiveSubscriptionFundedPublications({
    employerProfileId,
    subscriptionId,
    session,
  }) {
    const query = JobPublication.find({
      business: employerProfileId,
      "entitlementSnapshot.source": SUBSCRIPTION_ENTITLEMENT_SOURCE,
      "entitlementSnapshot.subscription": subscriptionId,
      status: {
        $in: ACTIVE_SUBSCRIPTION_PUBLICATION_STATUSES,
      },
    })
      .select(
        "_id job status entitlementSnapshot.subscription " +
          "entitlementSnapshot.consumptionReference"
      )
      .lean();

    return this.applySession(query, session);
  }

  static async getNextSubscriptionSlotGeneration({
    employerProfileId,
    subscriptionId,
    slotNumber,
    session,
  }) {
    const slotPrefix = this.buildSubscriptionSlotPrefix({
      subscriptionId,
      slotNumber,
    });

    const query = JobPublication.countDocuments({
      business: employerProfileId,
      "entitlementSnapshot.source": SUBSCRIPTION_ENTITLEMENT_SOURCE,
      "entitlementSnapshot.subscription": subscriptionId,
      "entitlementSnapshot.consumptionReference": {
        $regex: `^${this.escapeRegex(slotPrefix)}`,
      },
    });

    const previousOccupancies = await this.applySession(query, session);

    return Number(previousOccupancies) + 1;
  }

  static getPendingDowngradeSlotRestriction({ benefits, activeJobSlots }) {
    const pendingPlanChange = benefits?.subscription?.pendingPlanChange || null;

    if (!pendingPlanChange || pendingPlanChange.changeType !== "downgrade") {
      return null;
    }

    const targetActiveJobSlots = Number(
      pendingPlanChange.targetPlanSnapshot?.benefits?.activeJobSlots
    );

    if (!Number.isSafeInteger(targetActiveJobSlots) || targetActiveJobSlots < 0) {
      throw this.createError({
        message: "The pending subscription downgrade has invalid Job-slot capacity.",
        code: "INVALID_PENDING_SUBSCRIPTION_DOWNGRADE_JOB_SLOT_CAPACITY",
        statusCode: 500,
        details: {
          subscriptionId: String(benefits.subscription?._id || ""),
          targetActiveJobSlots:
            pendingPlanChange.targetPlanSnapshot?.benefits?.activeJobSlots ?? null,
        },
      });
    }

    /*
     * Only a reduction in Job-slot capacity needs a publication freeze.
     *
     * A feature-only downgrade with unchanged slot capacity cannot invalidate
     * retained-publication selection. A pending upgrade likewise continues to
     * use current-plan capacity until payment succeeds.
     */
    if (targetActiveJobSlots >= activeJobSlots) {
      return null;
    }

    return {
      targetActiveJobSlots,
      targetPlanId: pendingPlanChange.targetPlan || null,
      paymentReference: pendingPlanChange.paymentReference || null,
    };
  }

  static async serializeSubscriptionPublicationGrant({
    employerProfileId,
    subscriptionId,
    currentTime,
    session,
  }) {
    this.assertCommercialConsumptionTransaction(session);

    /*
     * A snapshot read and a unique consumption reference do not serialize
     * publication creation with plan changes, renewal or termination.
     *
     * Make a real write to the same Subscription document that SubscriptionService
     * saves in its lifecycle transactions. If that document changed since our
     * snapshot, MongoDB aborts this transaction with a write conflict. Preserve
     * that error so the transaction owner can retry the entire operation with
     * fresh benefits, pending-plan state and occupancy.
     *
     * __v is the existing Mongoose version key, not a slot balance. Incrementing
     * it leaves purchased terms untouched; timestamps are disabled so a slot
     * grant does not masquerade as a billing/lifecycle update. This write rolls
     * back together with a failed publication.
     */
    const result = await Subscription.updateOne(
      {
        _id: subscriptionId,
        business: employerProfileId,
        status: "active",
        currentPeriodStart: { $type: "date", $lte: currentTime },
        currentPeriodEnd: { $type: "date", $gt: currentTime },
      },
      { $inc: { __v: 1 } },
      { session, timestamps: false }
    );

    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw this.createError({
        message: "The Subscription no longer authorizes this Job publication. Retry publication.",
        code: "JOB_PUBLICATION_SUBSCRIPTION_AUTHORITY_CHANGED",
        statusCode: 409,
        details: { subscriptionId: String(subscriptionId) },
      });
    }
  }

  static async obtainSubscriptionEntitlement({ employerProfileId, currentTime, session }) {
    this.assertCommercialConsumptionTransaction(session);

    this.assertEntitlementSourceSupported(SUBSCRIPTION_ENTITLEMENT_SOURCE);

    try {
      const benefits = await SubscriptionService.getActiveSubscriptionBenefits(
        {
          employerProfileId,
          currentTime,
        },
        {
          session,
        }
      );

      if (!benefits?.subscription) {
        return {
          eligible: false,
          reason: "no_active_subscription",
          entitlementGrant: null,
          subscription: null,
          activeJobSlots: 0,
          occupiedJobSlots: 0,
          remainingJobSlots: 0,
          slot: null,
        };
      }

      const subscriptionId = this.normalizeObjectId(
        benefits.subscriptionId || benefits.subscription?._id,
        "active subscription ID"
      );

      const activeJobSlots = Number(benefits.activeJobSlots);

      if (!Number.isSafeInteger(activeJobSlots) || activeJobSlots < 0) {
        throw this.createError({
          message: "The active subscription has invalid Job-slot capacity.",
          code: "INVALID_SUBSCRIPTION_JOB_SLOT_CAPACITY",
          statusCode: 500,
          details: {
            subscriptionId: String(subscriptionId),
            activeJobSlots: benefits.activeJobSlots,
          },
        });
      }

      if (activeJobSlots === 0) {
        return {
          eligible: false,
          reason: "subscription_has_no_job_slots",
          entitlementGrant: null,
          subscription: benefits.subscription,
          activeJobSlots,
          occupiedJobSlots: 0,
          remainingJobSlots: 0,
          slot: null,
        };
      }

      const activePublications = await this.getActiveSubscriptionFundedPublications({
        employerProfileId,
        subscriptionId,
        session,
      });

      const occupiedJobSlots = activePublications.length;

      const downgradeRestriction = this.getPendingDowngradeSlotRestriction({
        benefits,
        activeJobSlots,
      });

      if (downgradeRestriction) {
        return {
          eligible: false,
          reason: "subscription_downgrade_payment_pending",
          entitlementGrant: null,
          subscription: benefits.subscription,
          activeJobSlots,
          occupiedJobSlots,
          remainingJobSlots: 0,
          slot: null,
          pendingDowngrade: {
            targetActiveJobSlots: downgradeRestriction.targetActiveJobSlots,
            targetPlanId: downgradeRestriction.targetPlanId,
            paymentReference: downgradeRestriction.paymentReference,
          },
        };
      }

      if (occupiedJobSlots >= activeJobSlots) {
        return {
          eligible: false,
          reason: "subscription_slots_full",
          entitlementGrant: null,
          subscription: benefits.subscription,
          activeJobSlots,
          occupiedJobSlots,
          remainingJobSlots: 0,
          slot: null,
        };
      }

      // Serialize only a candidate grant; blocked/full subscription attempts
      // must leave the independent hybrid FREE/PAYG paths untouched.
      await this.serializeSubscriptionPublicationGrant({
        employerProfileId,
        subscriptionId,
        currentTime,
        session,
      });

      const occupiedCurrentSubscriptionSlots = new Set();

      for (const publication of activePublications) {
        const consumptionReference = publication?.entitlementSnapshot?.consumptionReference || null;

        const slotNumber = this.parseSubscriptionSlotNumber({
          consumptionReference,
          subscriptionId,
        });

        if (slotNumber === null) {
          continue;
        }

        if (occupiedCurrentSubscriptionSlots.has(slotNumber)) {
          throw this.createError({
            message: "Multiple active Job publications occupy the same subscription Job slot.",
            code: "SUBSCRIPTION_JOB_SLOT_OCCUPANCY_INTEGRITY_ERROR",
            statusCode: 500,
            details: {
              subscriptionId: String(subscriptionId),
              slotNumber,
            },
          });
        }

        occupiedCurrentSubscriptionSlots.add(slotNumber);
      }

      let slotNumber = null;

      for (let candidate = 1; candidate <= activeJobSlots; candidate += 1) {
        if (!occupiedCurrentSubscriptionSlots.has(candidate)) {
          slotNumber = candidate;
          break;
        }
      }

      if (slotNumber === null) {
        throw this.createError({
          message: "Subscription Job-slot capacity could not be resolved consistently.",
          code: "SUBSCRIPTION_JOB_SLOT_RESOLUTION_INTEGRITY_ERROR",
          statusCode: 500,
          details: {
            subscriptionId: String(subscriptionId),
            activeJobSlots,
            occupiedJobSlots,
          },
        });
      }

      const generation = await this.getNextSubscriptionSlotGeneration({
        employerProfileId,
        subscriptionId,
        slotNumber,
        session,
      });

      const slotPrefix = this.buildSubscriptionSlotPrefix({
        subscriptionId,
        slotNumber,
      });

      /*
       * billingCycleKey records the cycle in which this slot occupancy began.
       * It is historical grant metadata only; successful renewals do not create
       * a new JobPublication or reset the occupied slot.
       */
      const billingCycleKey = SubscriptionService.buildBillingCycleKey({
        subscriptionId,
        periodStart: benefits.currentPeriodStart,
      });

      const remainingJobSlots = Math.max(activeJobSlots - occupiedJobSlots - 1, 0);

      return {
        eligible: true,
        reason: null,
        subscription: benefits.subscription,
        activeJobSlots,
        occupiedJobSlots,
        remainingJobSlots,
        slot: {
          slotNumber,
          generation,
          capacity: activeJobSlots,
          occupiedBeforeGrant: occupiedJobSlots,
          remainingAfterGrant: remainingJobSlots,
        },
        entitlementGrant: {
          source: SUBSCRIPTION_ENTITLEMENT_SOURCE,
          consumptionReference: `${slotPrefix}${generation}`,
          subscription: subscriptionId,
          planCode: benefits.planCode,
          planName: benefits.planName,
          billingCycleKey,
          purchaseReference: null,
          paymentTransaction: null,
          grantedAt: benefits.currentPeriodStart,
          consumedAt: currentTime,
        },
      };
    } catch (error) {
      throw this.normalizeCommercialServiceError(error);
    }
  }

  static async obtainPaygEntitlement({ employerProfileId, jobId, currentTime, session }) {
    this.assertCommercialConsumptionTransaction(session);

    this.assertEntitlementSourceSupported(PAYG_ENTITLEMENT_SOURCE);

    try {
      const result = await JobPublicationPaymentService.consumePaidPublicationEntitlement(
        {
          employerProfileId,
          jobId,
          currentTime,
        },
        {
          session,
        }
      );

      if (!result?.eligible) {
        return {
          eligible: false,
          reason: result?.reason || "payg_entitlement_unavailable",
          payment: result?.payment || null,
          entitlementGrant: null,
        };
      }

      if (result.entitlementGrant?.source !== PAYG_ENTITLEMENT_SOURCE) {
        throw this.createError({
          message:
            "JobPublicationPaymentService returned an invalid Job publication entitlement source.",
          code: "INVALID_PAYG_JOB_PUBLICATION_ENTITLEMENT_SOURCE",
          statusCode: 500,
        });
      }

      if (!result.payment?._id) {
        throw this.createError({
          message: "PAYG Job publication entitlement is missing its JobPayment record.",
          code: "PAYG_JOB_PUBLICATION_PAYMENT_RECORD_REQUIRED",
          statusCode: 500,
        });
      }

      return result;
    } catch (error) {
      throw this.normalizeCommercialServiceError(error);
    }
  }

  static buildSubscriptionResolution({ result, publicationMode }) {
    return {
      entitlementGrant: result.entitlementGrant,
      sourceType: "subscription_slot",
      publicationMode,
      freeAllowance: null,
      subscriptionSlot: result.slot
        ? {
            subscriptionId: result.subscription?._id || null,
            slotNumber: result.slot.slotNumber,
            generation: result.slot.generation,
            capacity: result.slot.capacity,
            occupiedBeforeGrant: result.slot.occupiedBeforeGrant,
            remainingAfterGrant: result.slot.remainingAfterGrant,
          }
        : null,
      paygPaymentId: null,
    };
  }

  static buildPaygResolution({ result, publicationMode }) {
    return {
      entitlementGrant: result.entitlementGrant,
      sourceType: "paid_single_post",
      publicationMode,
      freeAllowance: null,
      subscriptionSlot: null,
      paygPaymentId: result.payment._id,
    };
  }

  /* ─────────────────────────────── ENTITLEMENT RESOLUTION ─────────────────────────────── */

  static async obtainPublicationEntitlement(
    { employerProfileId, jobId, currentTime = new Date() },
    options = {}
  ) {
    const employerId = this.normalizeObjectId(employerProfileId, "employerProfileId");

    const normalizedJobId = this.normalizeObjectId(jobId, "jobId");

    const entitlementTime = this.normalizeCurrentTime(currentTime);

    const session = options.session || null;

    const policy = await this.getPublicationPolicy();

    /*
     * FREE MODE
     *
     * Free mode means publication is unrestricted by monthly-free,
     * subscription or PAYG limits.
     */
    if (policy.publicationMode === "free") {
      return {
        entitlementGrant: this.buildFreeEntitlementGrant({
          consumptionReference: this.buildUnrestrictedFreeConsumptionReference({
            employerProfileId: employerId,
            jobId: normalizedJobId,
          }),
          currentTime: entitlementTime,
        }),
        sourceType: "free",
        publicationMode: policy.publicationMode,
        freeAllowance: null,
        subscriptionSlot: null,
        paygPaymentId: null,
      };
    }

    /*
     * HYBRID MODE
     *
     * Current resolution order:
     *
     * monthly free allowance
     * → available subscription Job slot
     * → PAYG purchase
     */
    if (policy.publicationMode === "hybrid") {
      const monthlyFreeEntitlement = await this.obtainMonthlyFreeEntitlement({
        employerProfileId: employerId,
        currentTime: entitlementTime,
        freeJobPostsPerMonth: policy.freeJobPostsPerMonth,
        freeJobPostRolloverEnabled: policy.freeJobPostRolloverEnabled,
        session,
      });

      if (monthlyFreeEntitlement) {
        return {
          entitlementGrant: monthlyFreeEntitlement.grant,
          sourceType: "free_monthly",
          publicationMode: policy.publicationMode,
          freeAllowance: monthlyFreeEntitlement.allowance,
          subscriptionSlot: null,
          paygPaymentId: null,
        };
      }

      const subscriptionResult = await this.obtainSubscriptionEntitlement({
        employerProfileId: employerId,
        currentTime: entitlementTime,
        session,
      });

      if (subscriptionResult.eligible) {
        return this.buildSubscriptionResolution({
          result: subscriptionResult,
          publicationMode: policy.publicationMode,
        });
      }

      const paygResult = await this.obtainPaygEntitlement({
        employerProfileId: employerId,
        jobId: normalizedJobId,
        currentTime: entitlementTime,
        session,
      });

      if (paygResult.eligible) {
        return this.buildPaygResolution({
          result: paygResult,
          publicationMode: policy.publicationMode,
        });
      }

      throw this.createError({
        message:
          "The employer's free monthly Job posting allowance has been used, " +
          "and no subscription Job slot or PAYG purchase is available.",
        code: "JOB_PUBLICATION_MONETIZATION_REQUIRED",
        statusCode: 409,
        details: {
          publicationMode: policy.publicationMode,
          freeJobPostsPerMonth: policy.freeJobPostsPerMonth,
          subscriptionReason: subscriptionResult.reason,
          paygReason: paygResult.reason,
          nextOptions: ["subscription", "payg"],
        },
      });
    }

    /*
     * SUBSCRIPTION MODE
     *
     * Only available active-subscription Job-slot capacity can authorize publication.
     */
    if (policy.publicationMode === "subscription") {
      this.assertCommercialConsumptionTransaction(session);

      const subscriptionResult = await this.obtainSubscriptionEntitlement({
        employerProfileId: employerId,
        currentTime: entitlementTime,
        session,
      });

      if (subscriptionResult.eligible) {
        return this.buildSubscriptionResolution({
          result: subscriptionResult,
          publicationMode: policy.publicationMode,
        });
      }

      if (subscriptionResult.reason === "subscription_downgrade_payment_pending") {
        throw this.createError({
          message:
            "New subscription-funded Job publications are temporarily unavailable while the subscription downgrade payment is being resolved.",
          code: "JOB_PUBLICATION_BLOCKED_BY_PENDING_SUBSCRIPTION_DOWNGRADE",
          statusCode: 409,
          details: {
            publicationMode: policy.publicationMode,
            reason: subscriptionResult.reason,
            pendingDowngrade: subscriptionResult.pendingDowngrade || null,
          },
        });
      }

      throw this.createError({
        message: "An available subscription Job slot is required.",
        code: "JOB_PUBLICATION_SUBSCRIPTION_ENTITLEMENT_REQUIRED",
        statusCode: 409,
        details: {
          publicationMode: policy.publicationMode,
          reason: subscriptionResult.reason,
        },
      });
    }

    /*
     * PAID MODE
     *
     * Only an unused successfully paid PAYG JobPayment can authorize
     * publication.
     */
    this.assertCommercialConsumptionTransaction(session);

    const paygResult = await this.obtainPaygEntitlement({
      employerProfileId: employerId,
      jobId: normalizedJobId,
      currentTime: entitlementTime,
      session,
    });

    if (paygResult.eligible) {
      return this.buildPaygResolution({
        result: paygResult,
        publicationMode: policy.publicationMode,
      });
    }

    throw this.createError({
      message: "A PAYG Job publication purchase is required.",
      code: "JOB_PUBLICATION_PAYG_ENTITLEMENT_REQUIRED",
      statusCode: 409,
      details: {
        publicationMode: policy.publicationMode,
        reason: paygResult.reason,
      },
    });
  }

  /* ─────────────────────────────── PUBLICATION ORCHESTRATION ─────────────────────────────── */

  /**
   * Preferred publication entry point for controllers.
   *
   * Entitlement resolution, subscription-slot occupancy, PAYG consumption,
   * publication creation and PAYG publication linking execute within the same
   * transaction boundary.
   *
   * Controllers therefore do not construct grants, select entitlement sources
   * or mutate subscription-slot / JobPayment commercial state directly.
   */
  static async publishJobWithEntitlement(
    {
      jobId,
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      publishedByUserId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const publishedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const entitlement = await this.obtainPublicationEntitlement(
        {
          employerProfileId,
          jobId,
          currentTime: publishedAt,
        },
        {
          session,
        }
      );

      const publicationResult = await JobPublicationService.publishJob(
        {
          jobId,
          employerProfileId,
          employerContext,
          adminEmployerContext,
          publishedByUserId,
          entitlementGrant: entitlement.entitlementGrant,
          currentTime: publishedAt,
        },
        {
          session,
        }
      );

      if (entitlement.sourceType === "paid_single_post") {
        if (!entitlement.paygPaymentId || !publicationResult?.publication?._id) {
          throw this.createError({
            message:
              "PAYG Job publication completed without the commercial records " +
              "required to finalize entitlement consumption.",
            code: "PAYG_JOB_PUBLICATION_LINKAGE_REQUIRED",
            statusCode: 500,
          });
        }

        try {
          await JobPublicationPaymentService.linkConsumedPublication(
            {
              jobPaymentId: entitlement.paygPaymentId,
              jobId,
              publicationId: publicationResult.publication._id,
            },
            {
              session,
            }
          );
        } catch (error) {
          throw this.normalizeCommercialServiceError(error);
        }
      }

      return {
        ...publicationResult,
        entitlement: {
          sourceType: entitlement.sourceType,
          publicationMode: entitlement.publicationMode,
          freeAllowance: entitlement.freeAllowance,
          subscriptionSlot: entitlement.subscriptionSlot || null,
        },
      };
    });
  }
}

module.exports = JobPublicationEntitlementService;
