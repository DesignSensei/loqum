// models/KYCVerification.js

const mongoose = require("mongoose");

/**
 * KYC VERIFICATION
 *
 * Stores verification evidence, provider results, review decisions,
 * document references and audit history for employers and professionals.
 *
 * Successful registry lookups do not independently establish identity
 * ownership, representative authority or final marketplace approval.
 *
 * Sensitive evidence must be accessed through trusted services.
 */

// ───────────────────── VERIFICATION CONSTANTS ─────────────────────

const EXTERNAL_VERIFICATION_PROVIDERS = new Set(["ninja", "dojah"]);

// These verification types do not use automatic expiry.
const ONE_TIME_VERIFICATION_TYPES = new Set([
  "nin",
  "bvn",
  "government_id",
  "selfie_match",
  "licence",
]);

// ───────────────────── REGISTRY LEGAL NAME ─────────────────────

/**
 * Structured legal names are obtained from trusted NIN evidence.
 * Name components must not be inferred from a combined full name.
 *
 * Registry-derived names establish provenance, not proof that
 * the applicant owns the identity or has completed final KYC.
 */

function isValidRegistryNameComponent(value, optional = false) {
  if (optional && (value === "" || value == null)) {
    return true;
  }

  return (
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001F\u007F]/.test(value)
  );
}

const registryLegalNameSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,

      validate: {
        validator: (value) => isValidRegistryNameComponent(value),
        message: "Registry first name is invalid.",
      },
    },

    middleName: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "",

      validate: {
        validator: (value) => isValidRegistryNameComponent(value, true),
        message: "Registry middle name is invalid.",
      },
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,

      validate: {
        validator: (value) => isValidRegistryNameComponent(value),
        message: "Registry last name is invalid.",
      },
    },
  },
  {
    _id: false,
  }
);

// ───────────────────── VERIFICATION SCHEMA ─────────────────────

const kycVerificationSchema = new mongoose.Schema(
  {
    // ───────────────────── OWNERSHIP ─────────────────────

    /**
     * Each verification belongs to either a professional or employer.
     * The ownerType must agree with the corresponding profile reference.
     */

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      default: null,
    },

    ownerType: {
      type: String,
      enum: ["professional", "employer"],
      required: true,
    },

    // ───────────────────── VERIFICATION TYPE ─────────────────────

    /**
     * Records the identity, licensing or business check performed.
     * Professional onboarding currently uses NIN; the presence of
     * other types does not authorise additional verification lookups.
     */

    type: {
      type: String,
      enum: [
        "bvn",
        "nin",
        "government_id",
        "selfie_match",
        "licence",
        "cac",
        "facility_regulatory",
      ],
      required: true,
    },

    // ───────────────────── VERIFICATION PROVIDER ─────────────────────

    /**
     * External providers must identify their environment.
     * Staging results are retained for testing and investigation,
     * but cannot establish authoritative production verification.
     */

    provider: {
      type: String,
      enum: ["ninja", "dojah", "paystack", "smile_identity", "manual", "internal_review", null],
      default: null,
    },

    providerEnvironment: {
      type: String,
      enum: ["staging", "production", null],
      default: null,
    },

    // ───────────────────── PROVIDER REFERENCES ─────────────────────

    /**
     * References support reconciliation and duplicate-event detection.
     * They are excluded from ordinary queries to limit exposure.
     */

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

    providerEventId: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    // ───────────────────── IDENTIFIER EVIDENCE ─────────────────────

    /**
     * Retain only masked or hashed identity references.
     * Raw NIN, BVN and other sensitive identifiers must not
     * be stored in these fields.
     */

    maskedValue: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    valueLast4: {
      type: String,
      trim: true,
      maxlength: 4,
      default: null,
      select: false,
    },

    valueHash: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    // ───────────────────── VERIFICATION STATUS ─────────────────────

    /**
     * Status reflects the individual verification outcome.
     * It does not automatically approve the account or grant
     * permission to access restricted marketplace operations.
     */

    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review", "failed", "expired"],
      default: "pending",
    },

    // ───────────────────── MATCHING EVIDENCE ─────────────────────

    /**
     * nameOnRecord contains the readable name returned by the check.
     * For NIN, it is the individual's legal name; for CAC, the
     * registered business name.
     */

    nameOnRecord: {
      type: String,
      trim: true,
      default: null,
    },

    /**
     * Structured NIN names provide permanent legal-name provenance.
     * Only NIN records may contain this evidence.
     *
     * Trusted services must explicitly select it when needed.
     * It does not independently authenticate the identity holder.
     */

    registryLegalName: {
      type: registryLegalNameSchema,
      default: null,
      select: false,
    },

    dateOfBirthMatch: {
      type: Boolean,
      default: null,
    },

    nameMatchScore: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },

    // ───────────────────── REVIEW INFORMATION ─────────────────────

    /**
     * Review notes, rejection reasons and provider failures
     * are recorded separately for accurate status reporting.
     */

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    reviewNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────────────────── DOCUMENT EVIDENCE ─────────────────────

    /**
     * Stores references to supporting verification documents.
     * Upload validation, storage permissions and resubmission
     * eligibility must be enforced by dedicated services.
     *
     * These fields do not constitute a complete document
     * request or resubmission workflow.
     */

    documentType: {
      type: String,
      enum: [
        "nin_slip",
        "national_id",
        "passport",
        "drivers_license",
        "voters_card",
        "licence_certificate",
        "cac_certificate",
        "facility_permit",
        "other",
        null,
      ],
      default: null,
    },

    documentUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    selfieUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    // ───────────────────── VERIFICATION TIMESTAMPS ─────────────────────

    /**
     * Timestamps record submission, successful verification,
     * rejection, provider failure and the most recent check.
     */

    submittedAt: {
      type: Date,
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    lastCheckedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── ADMINISTRATIVE REVIEW ─────────────────────

    // Identifies the administrator responsible for a manual decision.
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ───────────────────── EXPIRY ─────────────────────

    // One-time identity and licence checks cannot have automatic expiry.
    expiresAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── VERIFICATION METADATA ─────────────────────

    /**
     * Metadata contains only explicitly approved, sanitised evidence.
     *
     * Mongoose Mixed does not sanitise values. Services must
     * whitelist fields and exclude raw identifiers, API secrets,
     * access tokens and hosted verification URLs.
     */

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
      select: false,
    },

    // ───────────────────── VERIFICATION HISTORY ─────────────────────

    /**
     * New authoritative records may supersede earlier records.
     * Inactive records remain available for audit and history.
     */

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// ───────────────────── INDEXES ─────────────────────

// Efficient lookup of a user's active and historical verification records.
kycVerificationSchema.index({
  user: 1,
  type: 1,
  isActive: 1,
});

// Supports verification queues grouped by owner, type and status.
kycVerificationSchema.index({
  ownerType: 1,
  type: 1,
  status: 1,
});

// ───────────────────── PROFESSIONAL INDEX ─────────────────────

kycVerificationSchema.index(
  {
    professional: 1,
    type: 1,
  },
  {
    partialFilterExpression: {
      professional: { $type: "objectId" },
    },
  }
);

// ───────────────────── EMPLOYER INDEX ─────────────────────

kycVerificationSchema.index(
  {
    employer: 1,
    type: 1,
  },
  {
    partialFilterExpression: {
      employer: { $type: "objectId" },
    },
  }
);

// ───────────────────── STATUS INDEX ─────────────────────

kycVerificationSchema.index({
  status: 1,
});

// ───────────────────── EXPIRY INDEX ─────────────────────

kycVerificationSchema.index(
  {
    expiresAt: 1,
  },
  {
    partialFilterExpression: {
      expiresAt: { $type: "date" },
    },
  }
);

// ───────────────────── PROVIDER REFERENCE INDEXES ─────────────────────

/**
 * Provider-issued references and event IDs are unique within
 * the provider and environment, preventing duplicate evidence.
 */

kycVerificationSchema.index(
  {
    provider: 1,
    providerEnvironment: 1,
    providerReference: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      providerReference: { $type: "string" },
    },
  }
);

kycVerificationSchema.index(
  {
    provider: 1,
    providerEnvironment: 1,
    providerEventId: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      providerEventId: { $type: "string" },
    },
  }
);

// ───────────────────── INTERNAL REFERENCE INDEX ─────────────────────

// Internal request references are indexed but not globally unique.
kycVerificationSchema.index(
  {
    provider: 1,
    requestReference: 1,
  },
  {
    partialFilterExpression: {
      requestReference: { $type: "string" },
    },
  }
);

// ───────────────────── IDENTIFIER HASH INDEX ─────────────────────

kycVerificationSchema.index(
  {
    valueHash: 1,
    type: 1,
  },
  {
    partialFilterExpression: {
      valueHash: { $type: "string" },
    },
  }
);

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

kycVerificationSchema.pre("validate", function () {
  // ───────────────────── OWNERSHIP CONSISTENCY ─────────────────────

  // A verification must belong to the declared profile type.
  if (this.ownerType === "professional" && !this.professional) {
    throw new Error("Professional KYC verification must reference a professional profile.");
  }

  if (this.ownerType === "employer" && !this.employer) {
    throw new Error("Employer KYC verification must reference an employer profile.");
  }

  if (this.ownerType === "professional" && this.employer) {
    throw new Error("Professional KYC verification cannot reference an employer.");
  }

  if (this.ownerType === "employer" && this.professional) {
    throw new Error("Employer KYC verification cannot reference a professional.");
  }

  // ───────────────────── PROVIDER ENVIRONMENT ─────────────────────

  // Ninja and Dojah records must identify staging or production.
  if (EXTERNAL_VERIFICATION_PROVIDERS.has(this.provider) && !this.providerEnvironment) {
    throw new Error("External verification records must identify staging or production.");
  }

  // ───────────────────── STAGING SAFEGUARD ─────────────────────

  // External staging responses cannot establish authoritative verification.
  if (
    EXTERNAL_VERIFICATION_PROVIDERS.has(this.provider) &&
    this.status === "verified" &&
    this.providerEnvironment !== "production"
  ) {
    throw new Error("External staging verification cannot be recorded as verified.");
  }

  // ───────────────────── STRUCTURED NIN NAME ─────────────────────

  // Structured NIN names must not be attached to other verification types.
  if (this.registryLegalName && this.type !== "nin") {
    throw new Error("Structured NIN registry-name evidence must belong to a NIN verification.");
  }

  // ───────────────────── IDENTITY-HOLDER SAFEGUARD ─────────────────────

  /**
   * A successful pre-onboarding NIN lookup does not prove
   * that the applicant is the rightful identity holder.
   *
   * Verified status requires explicit holder authentication
   * established by the authorised verification service.
   */

  if (
    this.type === "nin" &&
    this.status === "verified" &&
    this.metadata?.verificationSource === "pre_onboarding" &&
    this.metadata?.holderAuthenticated !== true
  ) {
    throw new Error(
      "Pre-onboarding NIN registry evidence cannot establish verified identity without holder authentication."
    );
  }

  // ───────────────────── ONE-TIME VERIFICATION ─────────────────────

  /**
   * Identity and licence verification records do not expire
   * automatically. Any future renewal requirements must use
   * an explicitly authorised verification workflow.
   */

  if (ONE_TIME_VERIFICATION_TYPES.has(this.type)) {
    if (this.status === "expired") {
      throw new Error("One-time identity and licence verification cannot expire automatically.");
    }

    if (this.expiresAt) {
      throw new Error("One-time identity and licence verification cannot have an expiry date.");
    }
  }

  // ───────────────────── SUBMISSION TIMESTAMP ─────────────────────

  // Every verification record retains its original submission date.
  if (!this.submittedAt) {
    this.submittedAt = new Date();
  }

  // ───────────────────── VERIFIED STATUS ─────────────────────

  if (this.status === "verified" && !this.verifiedAt) {
    this.verifiedAt = new Date();
  }

  if (this.status !== "verified") {
    this.verifiedAt = null;
  }

  // ───────────────────── REJECTED STATUS ─────────────────────

  // Rejection timestamps and reasons belong only to rejected records.
  if (this.status === "rejected" && !this.rejectedAt) {
    this.rejectedAt = new Date();
  }

  if (this.status !== "rejected") {
    this.rejectedAt = null;
    this.rejectionReason = null;
  }

  // ───────────────────── FAILED STATUS ─────────────────────

  // Failure timestamps and reasons belong only to failed records.
  if (this.status === "failed" && !this.failedAt) {
    this.failedAt = new Date();
  }

  if (this.status !== "failed") {
    this.failedAt = null;
    this.failureReason = null;
  }

  // ───────────────────── SUCCESSFUL VERIFICATION CLEANUP ─────────────────────

  // Successful verification clears prior failure and rejection reasons.
  if (this.status === "verified") {
    this.rejectionReason = null;
    this.failureReason = null;
  }
});

module.exports = mongoose.model("KYCVerification", kycVerificationSchema);
