// models/KYCVerification.js

const mongoose = require("mongoose");

// ───────────────────── CONSTANTS ─────────────────────

const EXTERNAL_VERIFICATION_PROVIDERS = new Set(["ninja", "dojah"]);

const PROFESSIONAL_TYPES = new Set([
  "pharmacist",
  "pharmacy_technician",
  "nurse",
  "doctor",
  "lab_scientist",
  "radiographer",
  "physiotherapist",
]);

const LICENCE_VALIDITY_TYPES = new Set(["expiry_date", "licensing_year", "life"]);

const NON_EXPIRING_EVIDENCE_TYPES = new Set(["nin", "bvn", "licence"]);

const VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "rejected",
  "needs_review",
  "failed",
  "expired",
];

const PROTECTED_QUERY_PATHS = new Set([
  "user",
  "professional",
  "employer",
  "ownerType",
  "type",
  "provider",
  "providerEnvironment",
  "registryLegalName",
  "valueHash",
  "valueLast4",
  "maskedValue",
  "nameOnRecord",
  "reviewedBy",
  "verifiedAt",
  "rejectedAt",
  "rejectionReason",
  "submittedAt",
  "expiresAt",
]);

// ───────────────────── VALIDATION HELPERS ─────────────────────

function isValidRegistryNameComponent(value, optional = false) {
  if (optional && (value === "" || value == null)) {
    return true;
  }

  return (
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isValidDate(value) {
  return value != null && Number.isFinite(new Date(value).getTime());
}

function isValidISOCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function datesEqual(left, right) {
  return (
    isValidDate(left) &&
    isValidDate(right) &&
    new Date(left).getTime() === new Date(right).getTime()
  );
}

function assertValidReviewTimestamp(document) {
  if (!isValidDate(document.lastCheckedAt)) {
    throw new Error("Verified administrative review requires a valid last-checked timestamp.");
  }

  if (!isValidDate(document.verifiedAt)) {
    throw new Error("Verified administrative review requires a valid verification timestamp.");
  }

  if (new Date(document.verifiedAt).getTime() > new Date(document.lastCheckedAt).getTime()) {
    throw new Error("Administrative verification cannot occur after its last check.");
  }
}

// ───────────────────── REGISTRY LEGAL NAME ─────────────────────

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

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      immutable: true,
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      immutable: true,
      default: null,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      immutable: true,
      default: null,
    },

    ownerType: {
      type: String,
      immutable: true,
      enum: ["professional", "employer"],
      required: true,
    },

    // ───────────────────── VERIFICATION TYPE ─────────────────────

    type: {
      type: String,
      immutable: true,
      enum: ["bvn", "nin", "licence", "cac", "facility_regulatory"],
      required: true,
    },

    // ───────────────────── PROVIDER ─────────────────────

    provider: {
      type: String,
      immutable: true,
      enum: ["ninja", "dojah", "paystack", "smile_identity", "manual", "internal_review", null],
      default: null,
    },

    providerEnvironment: {
      type: String,
      immutable: true,
      enum: ["staging", "production", null],
      default: null,
    },

    // ───────────────────── PROVIDER REFERENCES ─────────────────────

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

    status: {
      type: String,
      enum: VERIFICATION_STATUSES,
      required: true,
      default: "pending",
    },

    // ───────────────────── MATCHING EVIDENCE ─────────────────────

    nameOnRecord: {
      type: String,
      trim: true,
      default: null,
    },

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

    // ───────────────────── TIMESTAMPS ─────────────────────

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

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ───────────────────── EXPIRY ─────────────────────

    expiresAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── METADATA ─────────────────────

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
      select: false,
    },

    // ───────────────────── VERIFICATION HISTORY ─────────────────────

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────────────────── GENERAL INDEXES ─────────────────────

kycVerificationSchema.index({
  user: 1,
  type: 1,
  isActive: 1,
});

kycVerificationSchema.index({
  ownerType: 1,
  type: 1,
  status: 1,
});

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

kycVerificationSchema.index({
  status: 1,
});

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

// ───────────────────── ACTIVE REVIEW UNIQUENESS ─────────────────────

/*
 * One active professional licence review.
 *
 * This includes the pending review created after
 * a professional changes their licence number.
 */

kycVerificationSchema.index(
  {
    professional: 1,
    type: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      professional: { $type: "objectId" },
      type: "licence",
      isActive: true,
    },
  }
);

// ───────────────────── PROVIDER REFERENCE INDEXES ─────────────────────

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
  // ───────────────────── OWNERSHIP ─────────────────────

  if (this.ownerType === "professional" && (!this.professional || this.employer)) {
    throw new Error("Professional verification must reference only a professional profile.");
  }

  if (this.ownerType === "employer" && (!this.employer || this.professional)) {
    throw new Error("Employer verification must reference only an employer profile.");
  }

  // ───────────────────── PROVIDER ENVIRONMENT ─────────────────────

  if (EXTERNAL_VERIFICATION_PROVIDERS.has(this.provider) && !this.providerEnvironment) {
    throw new Error("External verification records must identify staging or production.");
  }

  if (
    EXTERNAL_VERIFICATION_PROVIDERS.has(this.provider) &&
    this.status === "verified" &&
    this.providerEnvironment !== "production"
  ) {
    throw new Error("Staging verification cannot be recorded as authoritative.");
  }

  // ───────────────────── STRUCTURED NIN NAME ─────────────────────

  if (this.registryLegalName && this.type !== "nin") {
    throw new Error("Structured NIN registry-name evidence must belong to a NIN verification.");
  }

  // ───────────────────── NIN IDENTIFIER VALIDATION ─────────────────────

  if (this.type === "nin") {
    if (this.valueLast4 != null && !/^\d{4}$/.test(this.valueLast4)) {
      throw new Error("NIN evidence requires exactly four trailing digits.");
    }

    if (this.valueHash != null && !/^[a-f0-9]{64}$/.test(this.valueHash)) {
      throw new Error("NIN evidence requires a valid keyed SHA-256 hash.");
    }

    if (this.maskedValue != null && !/^\*{7}\d{4}$/.test(this.maskedValue)) {
      throw new Error("NIN masked evidence must contain seven mask characters and four digits.");
    }

    if (
      this.maskedValue != null &&
      this.valueLast4 != null &&
      this.maskedValue.slice(-4) !== this.valueLast4
    ) {
      throw new Error("NIN masked evidence and trailing digits must agree.");
    }

    // ───────────────────── NIN PROVENANCE ─────────────────────

    const evidence = this.metadata || {};

    // The production provider's "needs_review" status records legal-name
    // evidence; it does not demand a second admin identity approval.
    const preOnboarding = evidence.verificationSource === "pre_onboarding";

    const permanentEvidence =
      preOnboarding ||
      evidence.legalNameSource === "nin_registry" ||
      this.status === "verified" ||
      Boolean(this.registryLegalName);

    if (permanentEvidence) {
      if (
        !this.registryLegalName ||
        !isValidRegistryNameComponent(this.registryLegalName.firstName) ||
        !isValidRegistryNameComponent(this.registryLegalName.middleName, true) ||
        !isValidRegistryNameComponent(this.registryLegalName.lastName) ||
        !this.valueHash ||
        !this.valueLast4 ||
        !this.requestReference ||
        !this.lastCheckedAt
      ) {
        throw new Error("Permanent NIN registry evidence is incomplete.");
      }

      const legalName = [
        this.registryLegalName.firstName,
        this.registryLegalName.middleName,
        this.registryLegalName.lastName,
      ]
        .filter(Boolean)
        .join(" ");

      if (this.nameOnRecord !== legalName) {
        throw new Error("NIN name on record must match its structured registry name.");
      }
    }

    // ───────────────────── PRE-ONBOARDING EVIDENCE ─────────────────────

    if (preOnboarding) {
      if (
        !EXTERNAL_VERIFICATION_PROVIDERS.has(this.provider) ||
        this.providerEnvironment !== "production" ||
        evidence.registryFound !== true ||
        evidence.registryMatched !== true ||
        evidence.legalNameSource !== "nin_registry" ||
        evidence.nameAcknowledged !== true ||
        evidence.stagingOnly !== false ||
        evidence.holderAuthenticated !== false ||
        evidence.nameAcknowledgedRequestReference !== this.requestReference ||
        !isValidDate(evidence.nameAcknowledgedAt) ||
        !isValidDate(evidence.consentAcceptedAt) ||
        !isValidDate(this.submittedAt) ||
        !isValidDate(this.lastCheckedAt) ||
        new Date(evidence.consentAcceptedAt) > new Date(this.submittedAt) ||
        new Date(this.lastCheckedAt) > new Date(evidence.nameAcknowledgedAt) ||
        new Date(evidence.nameAcknowledgedAt) > new Date()
      ) {
        throw new Error(
          "Pre-onboarding NIN evidence requires acknowledged production registry evidence with consistent timestamps."
        );
      }

      // A production registry-name match does not itself authenticate
      // the identifier holder. The stored onboarding evidence records
      // holderAuthenticated as false.
    }

    // ───────────────────── NIN VERIFIED STATUS ─────────────────────

    if (
      this.status === "verified" &&
      (evidence.holderAuthenticated !== true || evidence.requiresHolderAuthentication === true)
    ) {
      throw new Error(
        "NIN evidence cannot establish verified identity without holder authentication."
      );
    }
  }

  // ───────────────────── ONE-TIME VERIFICATION ─────────────────────

  if (NON_EXPIRING_EVIDENCE_TYPES.has(this.type)) {
    if (this.status === "expired" || this.expiresAt) {
      throw new Error("NIN, BVN and licence evidence history cannot expire automatically.");
    }
  }

  // ───────────────────── TIMESTAMP NORMALISATION ─────────────────────

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

  // ───────────────────── TIMESTAMP ORDER ─────────────────────

  for (const field of ["verifiedAt", "rejectedAt", "failedAt", "lastCheckedAt"]) {
    if (this[field] && new Date(this[field]) < new Date(this.submittedAt)) {
      throw new Error("Verification outcome timestamps cannot precede submission.");
    }
  }

  // ───────────────────── ADMINISTRATIVE REVIEW ─────────────────────

  const administrativeReview = this.type === "licence" && this.provider === "manual";

  if (administrativeReview) {
    if (!this.reviewedBy) {
      throw new Error("Administrative verification requires a reviewer.");
    }

    if (!this.lastCheckedAt) {
      throw new Error("Administrative verification requires a review timestamp.");
    }

    if (String(this.user) === String(this.reviewedBy)) {
      throw new Error("An account holder cannot review their own verification.");
    }

    if (this.status === "verified") {
      assertValidReviewTimestamp(this);

      if (
        typeof this.nameOnRecord !== "string" ||
        !this.nameOnRecord.trim() ||
        /[\u0000-\u001f\u007f]/.test(this.nameOnRecord)
      ) {
        throw new Error("Verified administrative review requires a valid name on record.");
      }
    }
  }

  // ───────────────────── PROFESSIONAL LICENCE REVIEW CONTRACT ─────────────────────

  /*
   * A council lookup is optional, never a prerequisite for approval.
   *
   * The administrator compares the uploaded licence against the stored
   * production NIN legal-name evidence and the existing registration number.
   *
   * The credential's expiry is stored on ProfessionalProfile and in
   * review metadata. It does not expire the historical review record.
   */

  if (
    this.type === "licence" &&
    this.provider === "manual" &&
    this.status === "verified" &&
    this.ownerType === "professional"
  ) {
    const meta = this.metadata || {};
    const validFrom = meta.validFromDate;
    const expiry = meta.expiryDate;
    const mode = meta.validityType;

    const validityMatches =
      LICENCE_VALIDITY_TYPES.has(mode) &&
      isValidISOCalendarDate(validFrom) &&
      (mode === "life"
        ? expiry == null && meta.licensingYear == null
        : isValidISOCalendarDate(expiry) &&
          validFrom <= expiry &&
          (mode === "expiry_date"
            ? meta.licensingYear == null
            : Number.isInteger(meta.licensingYear) &&
              meta.licensingYear >= 1900 &&
              meta.licensingYear <= 2199 &&
              expiry === `${meta.licensingYear}-12-31` &&
              validFrom >= `${meta.licensingYear}-01-01`));

    const councilEvidenceConsistent =
      typeof meta.councilReviewed === "boolean" &&
      (meta.councilReviewed
        ? typeof meta.councilSource === "string" &&
          meta.councilSource.trim().length >= 3 &&
          meta.councilSource.length <= 150
        : meta.councilSource == null);

    if (
      meta.verificationSource !== "uploaded_document" ||
      meta.documentReviewed !== true ||
      meta.currentAuthorisationReviewed !== true ||
      meta.ninLicenceNameMatched !== true ||
      !mongoose.isValidObjectId(meta.ninEvidenceId) ||
      typeof meta.licenceNumber !== "string" ||
      !meta.licenceNumber.trim() ||
      !PROFESSIONAL_TYPES.has(meta.professionalType) ||
      this.documentType !== "licence_certificate" ||
      typeof this.documentUrl !== "string" ||
      !this.documentUrl.trim() ||
      meta.documentRef !== this.documentUrl ||
      !councilEvidenceConsistent ||
      !validityMatches ||
      typeof meta.futureApproved !== "boolean" ||
      typeof meta.renewal !== "boolean" ||
      (meta.futureApproved && !meta.renewal)
    ) {
      throw new Error(
        "Verified professional licence requires matching uploaded-document, NIN, and validity evidence."
      );
    }
  }

  // ───────────────────── SUCCESSFUL VERIFICATION ─────────────────────

  if (this.status === "verified") {
    this.rejectionReason = null;
    this.failureReason = null;
  }
});

// ───────────────────── QUERY UPDATE PROTECTION ─────────────────────

/*
 * Document save() remains the required path for granting
 * verified status and changing authoritative evidence.
 *
 * Query updates are retained for:
 * - Provider attempt reconciliation;
 * - Pending provider-result transitions;
 * - Administrative review deactivation.
 *
 * These protections do not replace service-level
 * authorisation or atomic state-transition guards.
 */

function isApprovedFutureActivation(update, options, operation, filter) {
  // Precisely match the transactional future-licence activation.
  // Only this single-field transition may reactivate a review record.

  if (
    operation !== "updateOne" ||
    !options?.session?.inTransaction?.() ||
    !filter ||
    !mongoose.isValidObjectId(filter._id) ||
    filter.isActive !== false ||
    !update ||
    Object.keys(update).length !== 1 ||
    !update.$set ||
    Object.keys(update.$set).length !== 1
  ) {
    return false;
  }

  return update.$set.isActive === true;
}

function assertSafeVerificationUpdate(update, options = {}, operation, filter = null) {
  if (
    !update ||
    typeof update !== "object" ||
    Array.isArray(update) ||
    options.overwrite === true ||
    options.upsert === true ||
    ["replaceOne", "findOneAndReplace"].includes(operation)
  ) {
    throw new Error(
      "Verification replacements, upserts and update pipelines are unsupported; use document save()."
    );
  }

  // The approved future-licence activation path has a narrowly scoped
  // exception. The query hook below checks the stored review record.

  if (isApprovedFutureActivation(update, options, operation, filter)) {
    return "future_activation";
  }

  const protectedPath = (path) => {
    const root = String(path).split(".")[0];

    return PROTECTED_QUERY_PATHS.has(root);
  };

  const assertStatus = (value) => {
    if (value === "verified" || !VERIFICATION_STATUSES.includes(value)) {
      throw new Error(
        "Verified or invalid verification status cannot be assigned through query updates."
      );
    }
  };

  for (const [operator, values] of Object.entries(update)) {
    if (!operator.startsWith("$")) {
      if (protectedPath(operator) || operator === "status" || operator === "isActive") {
        throw new Error("Protected verification evidence cannot be changed through query updates.");
      }

      continue;
    }

    if (!["$set", "$unset", "$inc", "$currentDate", "$setOnInsert"].includes(operator)) {
      throw new Error("Unsupported verification query-update operator.");
    }

    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Invalid verification query-update structure.");
    }

    for (const [path, value] of Object.entries(values)) {
      if (protectedPath(path) || path === "__v") {
        throw new Error("Protected verification evidence requires document save().");
      }

      if (path === "status") {
        if (operator !== "$set") {
          throw new Error("Verification status must use an explicit assignment.");
        }

        assertStatus(value);
      }

      if (path === "isActive" && (operator !== "$set" || value !== false)) {
        throw new Error(
          "Query updates may only deactivate verification records outside approved renewal activation."
        );
      }

      if (path === "metadata" || path.startsWith("metadata.")) {
        if (operator !== "$set") {
          throw new Error("Verification metadata requires an explicit assignment.");
        }
      }
    }
  }

  return "regular_update";
}

// ───────────────────── QUERY MIDDLEWARE ─────────────────────

kycVerificationSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  async function () {
    const mode = assertSafeVerificationUpdate(
      this.getUpdate(),
      this.getOptions(),
      this.op,
      this.getFilter()
    );

    if (mode !== "future_activation") {
      return;
    }

    const session = this.getOptions().session;

    const record = await this.model
      .findOne(this.getFilter())
      .select("+metadata +documentUrl")
      .session(session);

    if (
      !record ||
      record.ownerType !== "professional" ||
      record.type !== "licence" ||
      record.provider !== "manual" ||
      record.status !== "verified" ||
      record.isActive !== false ||
      record.metadata?.futureApproved !== true ||
      record.metadata?.renewal !== true ||
      record.metadata?.verificationSource !== "uploaded_document" ||
      !isValidISOCalendarDate(record.metadata?.validFromDate)
    ) {
      throw new Error("Only an approved future professional licence may be activated.");
    }

    // Do not activate an approved renewal early or without
    // a matching upcomingLicence on the professional's profile.

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());

    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    const day = `${values.year}-${values.month}-${values.day}`;

    const owner = await mongoose
      .model("ProfessionalProfile")
      .findOne({
        _id: record.professional,
        user: record.user,
        "upcomingLicence.reviewId": record._id,
      })
      .select("+upcomingLicence.documentUrl")
      .session(session);

    const validFrom = owner?.upcomingLicence?.validFrom;

    const fromISO =
      validFrom instanceof Date && Number.isFinite(validFrom.getTime())
        ? validFrom.toISOString().slice(0, 10)
        : null;

    if (
      !owner ||
      fromISO !== record.metadata.validFromDate ||
      fromISO > day ||
      owner.upcomingLicence.documentUrl !== record.documentUrl
    ) {
      throw new Error("Future licence activation is not due or its approval does not match.");
    }
  }
);

// ───────────────────── BULK UPDATE PROTECTION ─────────────────────

function assertSafeVerificationBulkOperations(operations) {
  if (!Array.isArray(operations)) {
    throw new TypeError("Verification bulk operations must be an array.");
  }

  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new Error("Invalid verification bulk operation.");
    }

    if (operation.insertOne || operation.replaceOne) {
      throw new Error(
        "Bulk verification creation and replacement are unsupported; use document creation or save()."
      );
    }

    let supported = false;

    for (const name of ["updateOne", "updateMany"]) {
      if (operation[name]) {
        supported = true;

        // Future-licence reactivation must not use bulkWrite.
        assertSafeVerificationUpdate(operation[name].update, operation[name], name);
      }
    }

    if (!supported) {
      throw new Error("Unsupported verification bulk operation.");
    }
  }
}

kycVerificationSchema.pre("bulkWrite", function (operations) {
  assertSafeVerificationBulkOperations(operations);
});

// ───────────────────── SAFE SERIALISATION ─────────────────────

kycVerificationSchema.set("toJSON", {
  transform(_document, result) {
    for (const field of [
      "requestReference",
      "providerReference",
      "providerEventId",
      "maskedValue",
      "valueLast4",
      "valueHash",
      "nameOnRecord",
      "registryLegalName",
      "documentUrl",
      "metadata",
    ]) {
      delete result[field];
    }

    return result;
  },
});

// ───────────────────── EXPORT ─────────────────────

const KYCVerification = mongoose.model("KYCVerification", kycVerificationSchema);

// Some Mongoose versions do not execute model bulkWrite middleware.
// Guard the model method directly as well.
const originalBulkWrite = KYCVerification.bulkWrite;

KYCVerification.bulkWrite = function guardedBulkWrite(operations, ...args) {
  assertSafeVerificationBulkOperations(operations);

  return originalBulkWrite.call(this, operations, ...args);
};

module.exports = KYCVerification;
