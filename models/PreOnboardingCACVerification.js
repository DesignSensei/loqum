// models/PreOnboardingCACVerification.js

const mongoose = require("mongoose");

const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;

const SUCCESSFUL_STATUSES = new Set(["matched", "consumed"]);

// ───────────────────── REGISTRY BUSINESS NAME VALIDATION ─────────────────────

/*
 * Registered legal business names must originate
 * from trusted CAC registry evidence.
 *
 * A business name must not consist solely of
 * whitespace or contain control characters.
 *
 * This helper validates the stored value.
 *
 * It does not establish that the provider
 * supplied the value. That responsibility
 * belongs to the trusted verification service.
 */

function isValidRegisteredBusinessName(value) {
  return (
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001F\u007F]/.test(value)
  );
}

// ───────────────────── PRE-ONBOARDING CAC EVIDENCE ─────────────────────

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
     * The configured provider performs the CAC lookup.
     *
     * Provider selection is controlled through
     * the application's verification configuration.
     *
     * No automatic provider fallback or double-charging.
     *
     * Staging lookups may be used for testing but
     * cannot authorise production onboarding.
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
     * The registration number identifies the
     * business being checked.
     *
     * Only RC and BN registrations are supported
     * by the current automated onboarding workflow.
     *
     * The verification service must normalise
     * registration numbers before persistence.
     *
     * The applicant does not supply an authoritative
     * registered business name.
     *
     * That name comes directly from CAC evidence.
     *
     * Ninja and Dojah may support different
     * registration categories.
     *
     * The selected provider must explicitly support
     * the supplied category before a paid lookup.
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
     * A CAC lookup has been claimed and is in progress.
     *
     * matched:
     * A registered business was found and its
     * registration details passed the required checks.
     *
     * needs_review:
     * Registry evidence is incomplete or inconclusive.
     *
     * not_found:
     * The registry did not confirm the registration.
     *
     * failed:
     * The lookup could not be completed.
     *
     * consumed:
     * Successfully matched production evidence has
     * been consumed during employer onboarding.
     *
     * A successful CAC lookup verifies the business
     * registration only.
     *
     * It does not prove the applicant is authorised
     * to represent the business.
     *
     * It does not establish PCN premises verification
     * or final employer KYB approval.
     *
     * The service must enforce permitted status
     * transitions through atomic database updates.
     */

    status: {
      type: String,
      enum: ["processing", "matched", "needs_review", "not_found", "failed", "consumed"],
      required: true,
      default: "processing",
    },

    // ───────────────────── REGISTRY EVIDENCE ─────────────────────

    /*
     * Authoritative registered legal business name
     * returned by the configured CAC provider.
     *
     * This value must originate from trusted
     * server-side verification evidence.
     *
     * Never populate this field from request-body
     * businessName or user-entered display names.
     *
     * Required for matched and consumed records.
     *
     * OnboardingService uses this field to populate
     * EmployerProfile.businessName.
     *
     * Partial names may be retained for controlled
     * review when status is needs_review.
     *
     * Only successful evidence may authorise
     * normal employer onboarding.
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
     * Registration number returned by the registry.
     *
     * The provider adapter must normalise this
     * value into the same RC/BN format used
     * by registrationNumber.
     *
     * A successful lookup requires both registration
     * numbers to refer to the same registration.
     *
     * A provider response that does not provide
     * sufficient registration-number evidence
     * must not be treated as a successful match.
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
     * These are obtained from the provider response.
     *
     * EmployerVerificationService remains responsible
     * for interpreting supported entity categories
     * and acceptable registration statuses.
     *
     * Do not assume that a record is active merely
     * because the provider returned company details.
     *
     * Missing or ambiguous registry status must
     * not be interpreted as an active registration.
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
     * These checks must be calculated by trusted
     * verification services using provider evidence.
     *
     * registrationNumberMatches:
     * The returned registration number matches
     * the registration number requested.
     *
     * entityCategoryMatches:
     * The returned business category satisfies
     * Loqum's supported-registration policy.
     *
     * registrationIsActive:
     * The registry confirms an acceptable active
     * business-registration status.
     *
     * No businessNameMatches check is required.
     *
     * The registered legal business name is
     * provided directly by CAC and is not matched
     * against a user-submitted legal name.
     *
     * All three checks must be true before
     * evidence can be marked as matched
     * or consumed.
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
     * Internal lookup ownership and correlation.
     *
     * These fields support:
     *
     * - Atomic lookup claims;
     * - Duplicate-request prevention;
     * - Provider response correlation;
     * - Controlled retry handling;
     * - Transactional evidence consumption.
     *
     * processingClaimId identifies the active
     * lookup claim.
     *
     * A completed result must not retain
     * an active processing claim.
     *
     * Never store provider credentials or
     * sensitive authentication tokens.
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
     * Store concise, sanitised error and
     * review information.
     *
     * Never persist raw provider errors containing
     * credentials or sensitive request information.
     *
     * needs_review may retain partial registry
     * evidence for authorised investigation.
     *
     * Review information must not independently
     * authorise employer onboarding.
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
     * lookupStartedAt identifies when the
     * chargeable lookup was claimed.
     *
     * processingLeaseExpiresAt controls
     * the active processing lease.
     *
     * checkedAt identifies when the provider
     * result was assessed and recorded.
     *
     * nextLookupAllowedAt remains available
     * for the CAC verification service's
     * controlled retry policy.
     *
     * A timed-out provider request must not
     * automatically trigger another paid lookup
     * when its outcome is uncertain.
     *
     * No retry should silently switch providers.
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

    nextLookupAllowedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── TRANSACTIONAL CONSUMPTION ─────────────────────

    /*
     * Only successfully matched production
     * CAC evidence may be consumed.
     *
     * The trusted onboarding service must
     * persist the authoritative registered
     * business name and permanent CAC evidence
     * in the same onboarding transaction.
     *
     * Consumption does not establish
     * representative authority, PCN premises
     * approval or final employer KYB approval.
     */

    consumedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── TEMPORARY EVIDENCE RETENTION ─────────────────────

    /*
     * Temporary CAC lookup evidence only.
     *
     * Expiration here does not revoke permanent
     * CAC verification or employer approval.
     *
     * Permanent verification history is maintained
     * through KYCVerification.
     *
     * The verification service must check expiresAt
     * independently because MongoDB TTL cleanup
     * is asynchronous.
     *
     * Expiration is an evidence validity control,
     * not proof that provider verification was
     * unsuccessful.
     */

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

preOnboardingCACVerificationSchema.pre("validate", function () {
  /*
   * Temporary evidence must include a valid
   * lookup claim timestamp and retention period.
   *
   * MongoDB TTL cleanup is asynchronous.
   *
   * The service must independently enforce
   * expiry before consuming evidence.
   */

  if (!this.lookupStartedAt) {
    throw new Error("CAC verification evidence requires a lookup start timestamp.");
  }

  if (!this.expiresAt || this.expiresAt <= this.lookupStartedAt) {
    throw new Error("CAC evidence expiration must be later than the lookup start.");
  }

  /*
   * A processing lookup must retain its
   * active claim and processing lease.
   *
   * It must not contain completed verification
   * evidence from a previous lookup.
   *
   * Replacing temporary evidence must clear
   * previous registry details and checks.
   */

  if (this.status === "processing") {
    if (!this.processingClaimId || !this.processingLeaseExpiresAt) {
      throw new Error("Processing CAC verification requires an active claim and lease.");
    }

    if (this.processingLeaseExpiresAt <= this.lookupStartedAt) {
      throw new Error("CAC processing lease must extend beyond the lookup start.");
    }

    if (
      this.checkedAt ||
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
  } else {
    /*
     * Completed lookup results must include a
     * completed lookup timestamp.
     *
     * The processing claim and lease must be
     * cleared when the lookup is completed.
     */

    if (!this.checkedAt || this.checkedAt < this.lookupStartedAt) {
      throw new Error("Completed CAC verification requires a valid lookup timestamp.");
    }

    if (this.processingClaimId || this.processingLeaseExpiresAt) {
      throw new Error("Completed CAC verification cannot retain an active processing claim.");
    }

    if (this.checkedAt > this.expiresAt) {
      throw new Error("Completed CAC verification evidence has expired.");
    }
  }

  /*
   * Matched and consumed records must contain
   * complete, internally consistent CAC evidence.
   *
   * A provider returning a registered name alone
   * is not sufficient to confirm eligibility.
   *
   * All required registry checks must pass.
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

  /*
   * Only successful production evidence may
   * be consumed during normal onboarding.
   *
   * Staging evidence may be matched for testing
   * but cannot establish production CAC verification.
   */

  if (this.status === "consumed" && this.providerEnvironment !== "production") {
    throw new Error("Staging CAC evidence cannot be consumed for production onboarding.");
  }

  /*
   * Consumption must be explicitly recorded.
   *
   * Unconsumed records must not have consumedAt.
   *
   * The service must enforce the matched-to-consumed
   * transition atomically.
   */

  if (this.status === "consumed" && !this.consumedAt) {
    throw new Error("Consumed CAC evidence must include a consumption timestamp.");
  }

  if (this.status !== "consumed" && this.consumedAt) {
    throw new Error("Unconsumed CAC evidence cannot have a consumption timestamp.");
  }

  /*
   * Failed and not-found results must not retain
   * a registered business name that could be
   * mistaken for successful verification evidence.
   *
   * Partial evidence may be retained in needs_review
   * for controlled administrative investigation.
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
 * Replacement and processing claims must be
 * managed atomically by the verification service.
 *
 * Prevent duplicate concurrent provider lookups.
 */

preOnboardingCACVerificationSchema.index({ user: 1 }, { unique: true });

/*
 * Automatic cleanup of temporary CAC evidence.
 *
 * MongoDB TTL cleanup is asynchronous.
 *
 * Services must independently verify expiration
 * before consuming evidence.
 *
 * This does not expire permanent CAC verification
 * or employer KYB approval.
 */

preOnboardingCACVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ───────────────────── SAFE SERIALIZATION ─────────────────────

/*
 * Internal processing references must not be
 * exposed through ordinary JSON serialisation.
 *
 * Controllers and verification services should
 * construct explicit public response objects.
 *
 * Provider evidence must not be exposed before
 * the caller's account ownership is established.
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
