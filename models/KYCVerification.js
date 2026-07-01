// models/KYCVerification.js

const mongoose = require("mongoose");

/**
 * KYC VERIFICATION:
 *
 * Stores detailed identity, licence, business, and compliance verification records.
 *
 * This model keeps sensitive KYC evidence outside the main profile models.
 *
 * ProfessionalProfile and EmployerProfile should only store summary status fields.
 *
 * Example:
 * ProfessionalProfile:
 * - bvnVerification.status
 * - bvnVerification.provider
 * - bvnVerification.providerReference
 * - bvnVerification.last4
 *
 * EmployerProfile:
 * - cacVerification.status
 * - cacVerification.provider
 * - cacVerification.providerReference
 * - cacNameOnRecord
 * - regulatoryNameOnRecord
 *
 * Full raw BVN, NIN, or sensitive identity numbers should not be stored by default.
 * If a provider requires the raw value for verification, submit it to the provider,
 * store the masked value, valueLast4, valueHash, and provider reference,
 * then discard the raw value.
 */

const kycVerificationSchema = new mongoose.Schema(
  {
    // --- OWNER ---

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // The user who owns or submitted this verification.
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
      // Required when ownerType is professional.
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      default: null,
      // Required when ownerType is employer.
    },

    ownerType: {
      type: String,
      enum: ["professional", "employer"],
      required: true,
    },

    // --- VERIFICATION TYPE ---

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

    // --- PROVIDER ---

    provider: {
      type: String,
      enum: ["paystack", "dojah", "smile_identity", "manual", "internal_review", null],
      default: null,
    },

    providerReference: {
      type: String,
      trim: true,
      default: null,
      select: false,
      // Provider verification reference.
    },

    providerEventId: {
      type: String,
      trim: true,
      default: null,
      select: false,
      // Optional webhook or event id from provider.
    },

    // --- MASKED / SAFE VALUES ---

    maskedValue: {
      type: String,
      trim: true,
      default: null,
      select: false,
      // Example: ******1234.
      // Never store raw BVN or NIN here.
    },

    valueLast4: {
      type: String,
      trim: true,
      maxlength: 4,
      default: null,
      select: false,
      // Example: 1234.
    },

    valueHash: {
      type: String,
      trim: true,
      default: null,
      select: false,
      // Optional hash used to detect duplicate submissions
      // without storing the raw value.
    },

    // --- RESULT ---

    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review", "failed", "expired"],
      default: "pending",
    },

    nameOnRecord: {
      type: String,
      trim: true,
      default: null,
      // Can store BVN name, NIN name, licence name, CAC name,
      // or regulatory name returned by the verification source.
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
      // Optional provider or internal match score.
    },

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
      // Used when the verification is checked and rejected.
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
      // Used when provider/API/system verification fails.
    },

    reviewNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // --- DOCUMENTS ---

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

    // --- REVIEW / AUDIT ---

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

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    expiresAt: {
      type: Date,
      default: null,
      // Useful for documents, permits, or licences that expire.
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      select: false,
      // Store provider response summary, not raw sensitive payloads where avoidable.
    },

    isActive: {
      type: Boolean,
      default: true,
      // If a newer verification replaces this one, mark the old record inactive.
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

kycVerificationSchema.index({ user: 1, type: 1, isActive: 1 });

kycVerificationSchema.index({
  ownerType: 1,
  type: 1,
  status: 1,
});

kycVerificationSchema.index(
  { professional: 1, type: 1 },
  {
    partialFilterExpression: {
      professional: { $type: "objectId" },
    },
  }
);

kycVerificationSchema.index(
  { employer: 1, type: 1 },
  {
    partialFilterExpression: {
      employer: { $type: "objectId" },
    },
  }
);

kycVerificationSchema.index({ status: 1 });

kycVerificationSchema.index(
  { expiresAt: 1 },
  {
    partialFilterExpression: {
      expiresAt: { $type: "date" },
    },
  }
);

kycVerificationSchema.index(
  { providerReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerReference: { $type: "string" },
    },
  }
);

kycVerificationSchema.index(
  { providerEventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerEventId: { $type: "string" },
    },
  }
);

kycVerificationSchema.index(
  { valueHash: 1, type: 1 },
  {
    partialFilterExpression: {
      valueHash: { $type: "string" },
    },
  }
);

// --- VALIDATION / AUTO-CLEANUP ---

kycVerificationSchema.pre("validate", function () {
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

  if (!this.submittedAt) {
    this.submittedAt = new Date();
  }

  if (this.status === "verified" && !this.verifiedAt) {
    this.verifiedAt = new Date();
  }

  if (this.status !== "verified") {
    this.verifiedAt = null;
  }

  if (this.status === "rejected" && !this.rejectedAt) {
    this.rejectedAt = new Date();
  }

  if (this.status !== "rejected") {
    this.rejectedAt = null;
    this.rejectionReason = null;
  }

  if (this.status === "failed" && !this.failedAt) {
    this.failedAt = new Date();
  }

  if (this.status !== "failed") {
    this.failedAt = null;
    this.failureReason = null;
  }

  if (this.status === "verified") {
    this.rejectionReason = null;
    this.failureReason = null;
  }
});

module.exports = mongoose.model("KYCVerification", kycVerificationSchema);
