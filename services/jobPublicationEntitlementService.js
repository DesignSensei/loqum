// services/jobPublicationEntitlementService.js

const crypto = require("crypto");

const JobPublication = require("../models/JobPublication");

const PlatformSettingsService = require("./platformSettingsService");
const JobPublicationService = require("./jobPublicationService");

const { JOB_PUBLICATION_ENTITLEMENT_SOURCES } = require("../constants/jobPosting");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const ERROR_NAME = "JobPublicationEntitlementServiceError";

const FREE_ENTITLEMENT_SOURCE = "free";

const SUPPORTED_PUBLICATION_MODES = Object.freeze(["free", "paid", "subscription", "hybrid"]);

/**
 * JobPublicationEntitlementService is the commercial-authorization boundary
 * between permanent-Job publication and employer monetisation.
 *
 * CURRENT AUTHORITY:
 *
 * - free publication mode grants unrestricted free publication entitlements;
 * - hybrid mode may consume the configured recurring monthly free allowance;
 * - paid and subscription publication authority are deliberately unavailable
 *   until JobPayment / JobPostingPlan and Subscription / SubscriptionAllowance
 *   become authoritative monetisation records.
 *
 * FUTURE AUTHORITY:
 *
 * - subscription mode will consume an eligible SubscriptionAllowance;
 * - paid mode will consume an eligible paid JobPostingPlan / JobPayment purchase;
 * - hybrid mode will try the monthly free allowance, then subscription allowance,
 *   then PAYG authority according to the eventual commercial orchestration rules.
 *
 * This service does not trust entitlement grants supplied by controllers. It
 * obtains the grant from platform policy and, later, from authoritative
 * monetisation services before passing it to JobPublicationService.
 *
 * Free monthly allowance consumption is represented durably by the resulting
 * JobPublication entitlementSnapshot. No temporary allowance document is
 * invented before the dedicated monetisation models exist.
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

  static assertFreeEntitlementSourceSupported() {
    if (
      !Array.isArray(JOB_PUBLICATION_ENTITLEMENT_SOURCES) ||
      !JOB_PUBLICATION_ENTITLEMENT_SOURCES.includes(FREE_ENTITLEMENT_SOURCE)
    ) {
      throw this.createError({
        message: "Free Job publication entitlement is not configured as a supported source.",
        code: "FREE_JOB_PUBLICATION_ENTITLEMENT_SOURCE_NOT_CONFIGURED",
        statusCode: 500,
      });
    }
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
    this.assertFreeEntitlementSourceSupported();

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
   * Monthly free posting allowance currently uses a UTC calendar month.
   *
   * Subscription allowances may later use their own billing-cycle boundaries.
   * The recurring free allowance is intentionally independent of subscription
   * billing cycles.
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
    if (!Number.isSafeInteger(freeJobPostsPerMonth) || freeJobPostsPerMonth < 0) {
      throw this.createError({
        message: "The configured monthly free Job posting allowance is invalid.",
        code: "INVALID_FREE_JOB_POSTING_ALLOWANCE",
        statusCode: 500,
      });
    }

    /*
     * Rollover is deliberately unsupported because the current locked
     * commercial policy is recurring monthly allowance with no rollover.
     *
     * Supporting rollover later would require an explicit accumulation policy,
     * expiry rules and usually a durable allowance ledger.
     */
    if (freeJobPostRolloverEnabled === true) {
      throw this.createError({
        message: "Free Job posting rollover is not yet supported.",
        code: "FREE_JOB_POSTING_ROLLOVER_NOT_SUPPORTED",
        statusCode: 500,
      });
    }

    if (freeJobPostsPerMonth === 0) {
      return null;
    }

    const { periodKey, periodStart, periodEnd } = this.buildMonthlyAllowancePeriod(currentTime);

    const usedCount = await this.countConsumedMonthlyFreeEntitlements({
      employerProfileId,
      periodStart,
      periodEnd,
      periodKey,
      session,
    });

    if (usedCount >= freeJobPostsPerMonth) {
      return null;
    }

    const slotNumber = usedCount + 1;

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

        limit: freeJobPostsPerMonth,

        used: usedCount,

        remainingAfterGrant: Math.max(freeJobPostsPerMonth - slotNumber, 0),

        rolloverEnabled: false,
      },
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

    const policy = await this.getPublicationPolicy();

    /*
     * FREE MODE
     *
     * Free mode means publication is currently unrestricted by paid,
     * subscription or monthly-free-allocation limits.
     *
     * This allows Loqum to operate the Job Board freely before monetisation
     * goes live without pretending a SubscriptionAllowance or JobPayment exists.
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
      };
    }

    /*
     * HYBRID MODE
     *
     * Current implementation resolves only the first layer:
     *
     * monthly free allowance
     *
     * Later:
     *
     * monthly free allowance
     *   → subscription allowance
     *   → PAYG
     */
    if (policy.publicationMode === "hybrid") {
      const monthlyFreeEntitlement = await this.obtainMonthlyFreeEntitlement({
        employerProfileId: employerId,

        currentTime: entitlementTime,

        freeJobPostsPerMonth: policy.freeJobPostsPerMonth,

        freeJobPostRolloverEnabled: policy.freeJobPostRolloverEnabled,

        session: options.session || null,
      });

      if (monthlyFreeEntitlement) {
        return {
          entitlementGrant: monthlyFreeEntitlement.grant,

          /*
           * sourceType is orchestration metadata returned to callers.
           * The durable JobPublication entitlement source remains "free",
           * which is already part of the publication entitlement contract.
           */
          sourceType: "free_monthly",

          publicationMode: policy.publicationMode,

          freeAllowance: monthlyFreeEntitlement.allowance,
        };
      }

      /*
       * SubscriptionAllowance and JobPayment do not yet exist as
       * authoritative commercial records. Do not invent either authority.
       */
      throw this.createError({
        message:
          "The employer's free monthly Job posting allowance has been used. A subscription allowance or PAYG purchase is required.",

        code: "JOB_PUBLICATION_MONETIZATION_REQUIRED",

        statusCode: 409,

        details: {
          publicationMode: policy.publicationMode,

          freeJobPostsPerMonth: policy.freeJobPostsPerMonth,

          nextOptions: ["subscription", "payg"],
        },
      });
    }

    /*
     * SUBSCRIPTION MODE
     *
     * This branch will later resolve an active Subscription and atomically
     * consume the appropriate SubscriptionAllowance before publication.
     */
    if (policy.publicationMode === "subscription") {
      throw this.createError({
        message: "A subscription Job publication allowance is required.",

        code: "JOB_PUBLICATION_SUBSCRIPTION_ENTITLEMENT_REQUIRED",

        statusCode: 409,

        details: {
          publicationMode: policy.publicationMode,
        },
      });
    }

    /*
     * PAID MODE
     *
     * This branch will later validate and consume an authoritative
     * JobPayment linked to an applicable JobPostingPlan.
     */
    throw this.createError({
      message: "A PAYG Job publication purchase is required.",

      code: "JOB_PUBLICATION_PAYG_ENTITLEMENT_REQUIRED",

      statusCode: 409,

      details: {
        publicationMode: policy.publicationMode,
      },
    });
  }

  /* ─────────────────────────────── PUBLICATION ORCHESTRATION ─────────────────────────────── */

  /**
   * Preferred publication entry point for controllers.
   *
   * Publication entitlement resolution and Job publication execute within the
   * same transaction boundary.
   *
   * Controllers therefore do not need to:
   *
   * - construct entitlement grants;
   * - understand free/subscription/PAYG sources;
   * - inject commercial authority into req;
   * - call JobPublicationService directly for publication.
   *
   * Later monetisation integrations can change the entitlement-resolution
   * internals without changing this controller-facing contract.
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

      return {
        ...publicationResult,

        entitlement: {
          sourceType: entitlement.sourceType,

          publicationMode: entitlement.publicationMode,

          freeAllowance: entitlement.freeAllowance,
        },
      };
    });
  }
}

module.exports = JobPublicationEntitlementService;
