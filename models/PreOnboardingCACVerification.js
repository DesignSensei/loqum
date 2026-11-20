// models/PreOnboardingCACVerification.js

const mongoose = require("mongoose");

const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;

const SUCCESSFUL_STATUSES = new Set(["matched", "consumed"]);

// ───────────────────── REGISTRY BUSINESS NAME VALIDATION ─────────────────────

/*
 * Registered legal business names must originate
 * from trusted CAC registry evidence.
 *
 * This helper validates the stored value.
 *
 * It does not establish that a provider supplied
 * the value. That responsibility belongs to the
 * trusted CAC verification service.
 */

function isValidRegisteredBusinessName(value) {
  return (
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001F\u007F]/.test(value)
  );
}

// ───────────────────── PRE-ONBOARDING CAC EVIDENCE ─────────────────────

/*
 * This model stores temporary CAC verification
 * evidence for employer onboarding.
 *
 * LOOKUP POLICY
 *
 * - Eight lookups per rolling 24-hour period;
 * - Six distinct registration numbers;
 * - No mandatory cooldown between completed lookups;
 * - One active processing claim per employer;
 * - No automatic provider retries;
 * - Uncertain outcomes require support review.
 *
 * Rolling limits are enforced using CACLookupAttempt.
 *
 * This model does not store the employer's remaining
 * lookup allowance or next eligible lookup time.
 *
 * CAC verification does not independently establish
 * representative authority, PCN premises eligibility
 * or final employer approval.
 */

const preOnboardingCACVerificationSchema = new mongoose.Schema(
  {
    // ───────────────────── OWNERSHIP ─────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // ───────────────────── VERIFICATION PROVIDER ─────────────────────

    /*
     * The provider is selected by the verification
     * configuration, not by the applicant.
     *
     * Staging evidence cannot authorize
     * production employer onboarding.
     *
     * No automatic provider fallback.
     */

    provider: {
      type: String,
      enum: ["ninja", "dojah"],
      required: true,
    },

    providerEnvironment: {
      type: String,
      enum: ["staging", "production"],
      required: true,
    },

    // ───────────────────── CAC REGISTRATION IDENTITY ─────────────────────

    /*
     * Only RC and BN registrations are supported
     * by the current automated onboarding workflow.
     *
     * Registration identifiers must be normalized
     * before persistence.
     *
     * The applicant does not supply the authoritative
     * registered legal business name.
     *
     * Provider capability must be checked before
     * starting a chargeable lookup.
     */

    registrationNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: CAC_REGISTRATION_PATTERN,
    },

    // ───────────────────── VERIFICATION STATUS ─────────────────────

    /*
     * processing:
     * A provider lookup has been claimed.
     *
     * matched:
     * The registration passed required CAC checks.
     *
     * needs_review:
     * Registry evidence is incomplete or inconclusive.
     *
     * not_found:
     * The registration could not be confirmed.
     *
     * failed:
     * The lookup could not be completed safely.
     *
     * cancelled:
     * An unconsumed lookup was invalidated
     * before completion.
     *
     * consumed:
     * Successful production CAC verification confirms
     * the registered business identity.
     * Branch facility permits and marketplace
     * eligibility are assessed separately.
     */

    status: {
      type: String,
      enum: [
        "processing",
        "matched",
        "needs_review",
        "not_found",
        "failed",
        "cancelled",
        "consumed",
      ],
      required: true,
      default: "processing",
    },

    // ───────────────────── REGISTRY EVIDENCE ─────────────────────

    /*
     * Authoritative legal business name returned
     * by the configured CAC verification provider.
     *
     * Never populate this field using a
     * request-body businessName.
     *
     * Required for matched and consumed records.
     *
     * Partial evidence may be retained when the
     * result requires controlled administrative review.
     */

    nameOnRecord: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
      validate: {
        validator: (value) => value == null || isValidRegisteredBusinessName(value),
        message: "CAC registered business name is invalid.",
      },
    },

    /*
     * Registration number returned by CAC.
     *
     * The provider adapter must normalize it
     * into the same RC/BN format.
     *
     * Successful evidence requires matching
     * requested and returned identifiers.
     */

    responseRegistrationNumber: {
      type: String,
      trim: true,
      uppercase: true,
      match: CAC_REGISTRATION_PATTERN,
      default: null,
    },

    /*
     * Registry entity category and status.
     *
     * EmployerVerificationService interprets
     * whether these satisfy Loqum's business
     * registration requirements.
     *
     * A registration must not be assumed active
     * merely because the provider returned details.
     */

    entityType: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    entityStatus: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    registrationDate: {
      type: String,
      trim: true,
      default: null,
    },

    // ───────────────────── REGISTRATION VALIDATION ─────────────────────

    /*
     * These checks are calculated by trusted
     * verification services from provider evidence.
     *
     * registrationNumberMatches:
     * Returned registration matches the request.
     *
     * entityCategoryMatches:
     * Entity category is supported by Loqum.
     *
     * registrationIsActive:
     * CAC confirms an acceptable active status.
     *
     * All three must be true for matched
     * or consumed evidence.
     *
     * No applicant-entered business-name match
     * is required.
     */

    checks: {
      registrationNumberMatches: {
        type: Boolean,
        default: null,
      },

      entityCategoryMatches: {
        type: Boolean,
        default: null,
      },

      registrationIsActive: {
        type: Boolean,
        default: null,
      },
    },

    // ───────────────────── PROCESSING REFERENCES ─────────────────────

    /*
     * Internal ownership and correlation fields.
     *
     * processingClaimId:
     * Identifies the active lookup claim.
     *
     * requestReference:
     * Correlates evidence with the durable
     * CACLookupAttempt audit record.
     *
     * providerReference:
     * Tracks the provider's returned reference.
     *
     * Never store provider credentials or
     * sensitive authentication tokens.
     *
     * These fields are excluded from ordinary
     * queries unless explicitly selected.
     */

    processingClaimId: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
      select: false,
    },

    requestReference: {
      type: String,
      required: true,
      match: /^[A-Za-z0-9_.:-]{1,128}$/,
      trim: true,
      maxlength: 128,
      default: null,
      select: false,
    },

    providerReference: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    // ───────────────────── REVIEW AND ERROR INFORMATION ─────────────────────

    /*
     * Only concise, sanitized review information
     * may be stored here.
     *
     * Do not persist raw provider errors that
     * could expose credentials or sensitive data.
     *
     * Review status must never independently
     * authorize employer onboarding.
     */

    reason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    errorCode: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    // ───────────────────── LOOKUP TIMESTAMPS ─────────────────────

    /*
     * lookupStartedAt:
     * Time the potentially chargeable lookup
     * was claimed.
     *
     * processingLeaseExpiresAt:
     * Deadline for the active processing claim.
     *
     * checkedAt:
     * Time the provider result was assessed.
     *
     * There is no nextLookupAllowedAt field.
     *
     * The rolling 24-hour budget and next eligible
     * lookup time are calculated from persistent
     * CACLookupAttempt history.
     *
     * An expired processing lease does not
     * authorize an automatic provider retry.
     */

    lookupStartedAt: {
      type: Date,
      default: null,
    },

    processingLeaseExpiresAt: {
      type: Date,
      default: null,
    },

    checkedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── CORRECTION CANCELLATION ─────────────────────

    /*
     * Cancellation invalidates an unfinished
     * lookup before a replacement claim.
     *
     * A completed lookup can be superseded by
     * a new explicit verification request,
     * subject to the rolling-window policy.
     *
     * Services must reject late provider responses
     * and clear cancellation state when claiming
     * another lookup.
     */

    cancelledAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── TRANSACTIONAL CONSUMPTION ─────────────────────

    /*
     * Only successfully matched production
     * CAC evidence may be consumed.
     *
     * The onboarding service must save permanent
     * CAC verification evidence and the registered
     * legal business name in the same transaction.
     *
     * Consumption transfers verified production CAC
     * evidence into permanent onboarding records.
     *
     * Branch permit readiness and posting eligibility
     * remain separate checks.
     */

    consumedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── TEMPORARY EVIDENCE RETENTION ─────────────────────

    /*
     * This is temporary verification evidence.
     *
     * Expiration does not revoke previously
     * transferred permanent CAC verification.
     *
     * Permanent verification history is maintained
     * through KYCVerification.
     *
     * MongoDB TTL cleanup is asynchronous.
     *
     * The service must check expiresAt before
     * reusing or consuming evidence.
     *
     * Removing temporary evidence does not reset
     * the lookup budget because CACLookupAttempt
     * retains the durable lookup history.
     */

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

preOnboardingCACVerificationSchema.pre("validate", function () {
  /*
   * Every temporary record must include
   * a lookup start and valid retention period.
   *
   * Document validation does not run for
   * findOneAndUpdate().
   *
   * Services must independently enforce
   * equivalent atomic update conditions.
   */

  if (!this.lookupStartedAt) {
    throw new Error("CAC verification evidence requires a lookup start timestamp.");
  }

  if (!this.expiresAt || this.expiresAt <= this.lookupStartedAt) {
    throw new Error("CAC evidence expiration must be later than the lookup start.");
  }

  // ───────── PROCESSING VALIDATION ─────────

  if (this.status === "processing") {
    if (!this.processingClaimId || !this.processingLeaseExpiresAt) {
      throw new Error("Processing CAC verification requires an active claim and lease.");
    }

    if (
      this.processingLeaseExpiresAt <= this.lookupStartedAt ||
      this.processingLeaseExpiresAt > this.expiresAt
    ) {
      throw new Error(
        "CAC processing lease must extend beyond lookup start and remain within retention."
      );
    }

    /*
     * A new processing claim must not retain
     * completed evidence from an earlier lookup.
     */

    if (
      this.checkedAt ||
      this.providerReference ||
      this.consumedAt ||
      this.nameOnRecord ||
      this.responseRegistrationNumber ||
      this.entityType ||
      this.entityStatus ||
      this.registrationDate ||
      this.checks?.registrationNumberMatches != null ||
      this.checks?.entityCategoryMatches != null ||
      this.checks?.registrationIsActive != null
    ) {
      throw new Error("Processing CAC verification cannot retain completed registry evidence.");
    }

    // ───────── CANCELLATION VALIDATION ─────────
  } else if (this.status === "cancelled") {
    if (
      !this.cancelledAt ||
      this.cancelledAt < this.lookupStartedAt ||
      this.processingClaimId ||
      this.processingLeaseExpiresAt ||
      this.checkedAt ||
      this.consumedAt ||
      this.providerReference ||
      this.nameOnRecord ||
      this.responseRegistrationNumber ||
      this.entityType ||
      this.entityStatus ||
      this.registrationDate ||
      this.checks?.registrationNumberMatches != null ||
      this.checks?.entityCategoryMatches != null ||
      this.checks?.registrationIsActive != null
    ) {
      throw new Error(
        "Cancelled CAC evidence must record cancellation and clear claims and registry results."
      );
    }

    // ───────── COMPLETED RESULT VALIDATION ─────────
  } else {
    /*
     * Completed outcomes must contain a
     * checkedAt timestamp.
     *
     * Processing ownership must be cleared.
     */

    if (!this.checkedAt || this.checkedAt < this.lookupStartedAt) {
      throw new Error("Completed CAC verification requires a valid lookup timestamp.");
    }

    if (this.processingClaimId || this.processingLeaseExpiresAt) {
      throw new Error("Completed CAC verification cannot retain an active processing claim.");
    }

    if (this.checkedAt >= this.expiresAt) {
      throw new Error("Completed CAC verification evidence has expired.");
    }
  }

  // ───────── CANCELLATION CONSISTENCY ─────────

  if (this.status !== "cancelled" && this.cancelledAt) {
    throw new Error("Only cancelled CAC evidence may retain a cancellation timestamp.");
  }

  // ───────── SUCCESSFUL EVIDENCE ─────────

  /*
   * Matched and consumed records must contain
   * complete, internally consistent CAC evidence.
   *
   * A registered business name alone is not
   * sufficient for successful verification.
   */

  if (SUCCESSFUL_STATUSES.has(this.status)) {
    if (!isValidRegisteredBusinessName(this.nameOnRecord)) {
      throw new Error("Successful CAC verification requires a valid registered business name.");
    }

    if (
      !this.responseRegistrationNumber ||
      this.responseRegistrationNumber !== this.registrationNumber
    ) {
      throw new Error("Successful CAC verification requires matching registration numbers.");
    }

    if (
      !this.entityType ||
      typeof this.entityType !== "string" ||
      !this.entityType.trim() ||
      !this.entityStatus ||
      typeof this.entityStatus !== "string" ||
      !this.entityStatus.trim()
    ) {
      throw new Error(
        "Successful CAC verification requires registration category and status evidence."
      );
    }

    if (
      this.checks?.registrationNumberMatches !== true ||
      this.checks?.entityCategoryMatches !== true ||
      this.checks?.registrationIsActive !== true
    ) {
      throw new Error("Successful CAC verification requires all registration checks to pass.");
    }

    if (!this.checkedAt) {
      throw new Error("Successful CAC verification requires a completed lookup timestamp.");
    }
  }

  // ───────── PRODUCTION CONSUMPTION ─────────

  /*
   * Staging records may be matched for testing.
   *
   * Only successful production CAC evidence
   * can be consumed during normal onboarding.
   */

  if (this.status === "consumed" && this.providerEnvironment !== "production") {
    throw new Error("Staging CAC evidence cannot be consumed for production onboarding.");
  }

  // ───────── CONSUMPTION TIMESTAMPS ─────────

  if (this.status === "consumed" && !this.consumedAt) {
    throw new Error("Consumed CAC evidence must include a consumption timestamp.");
  }

  if (
    this.status === "consumed" &&
    (this.consumedAt < this.checkedAt || this.consumedAt >= this.expiresAt)
  ) {
    throw new Error("CAC evidence must be consumed after lookup completion and before expiry.");
  }

  if (this.status !== "consumed" && this.consumedAt) {
    throw new Error("Unconsumed CAC evidence cannot have a consumption timestamp.");
  }

  // ───────── UNSUCCESSFUL EVIDENCE ─────────

  /*
   * Failed and not-found outcomes must not
   * retain authoritative business names.
   *
   * needs_review may retain partial registry
   * evidence for authorized investigation.
   */

  if (["processing", "not_found", "failed"].includes(this.status) && this.nameOnRecord) {
    throw new Error(
      "Incomplete or unsuccessful CAC verification cannot contain an authoritative business name."
    );
  }
});

// ───────────────────── INDEXES ─────────────────────

/*
 * One temporary CAC verification record per user.
 *
 * Lookup claims and replacement updates must
 * be coordinated atomically by the service.
 */

preOnboardingCACVerificationSchema.index(
  {
    user: 1,
  },
  {
    unique: true,
  }
);

/*
 * Automatic cleanup of temporary evidence.
 *
 * MongoDB TTL cleanup is asynchronous.
 *
 * The service independently enforces expiry.
 *
 * This index does not delete permanent CAC
 * verification history or lookup attempt history.
 */

preOnboardingCACVerificationSchema.index(
  {
    expiresAt: 1,
  },
  {
    expireAfterSeconds: 0,
  }
);

// ───────────────────── SAFE SERIALIZATION ─────────────────────

/*
 * Internal processing references must not
 * be exposed through ordinary JSON serialization.
 *
 * Controllers and services must construct
 * explicitly approved public response objects.
 *
 * Provider evidence must not be exposed until
 * account ownership is established.
 */

preOnboardingCACVerificationSchema.set("toJSON", {
  transform(_document, result) {
    delete result.processingClaimId;
    delete result.requestReference;
    delete result.providerReference;
    delete result.errorCode;

    return result;
  },
});

module.exports = mongoose.model("PreOnboardingCACVerification", preOnboardingCACVerificationSchema);
