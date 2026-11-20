// models/FacilityPermit.js

const mongoose = require("mongoose");
const geoPointSchema = require("./helpers/geoPointSchema");

// ───────────────────── CONSTANTS ─────────────────────

const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const VERIFICATION_STATUSES = ["pending", "needs_review", "verified", "rejected"];
const VALIDITY_TYPES = ["expiry_date", "licensing_year", "indefinite"];
const PERMIT_SCOPES = ["facility", "service", "equipment"];
const REQUIREMENT_KEY_PATTERN = /^[a-z][a-z0-9_:-]*$/;
const AUTHORITY_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

// ───────────────────── HELPERS ─────────────────────

function isValidCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidPrivateDocumentRef(value) {
  return (
    typeof value === "string" &&
    value.startsWith("private://") &&
    value.length > "private://".length &&
    value.length <= 1000 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

// ───────────────────── BRANCH LOCATION SNAPSHOT ─────────────────────

/**
 * Captures the branch location at the time of permit submission.
 * The snapshot must come from the trusted Branch record, not the
 * employer's submitted form.
 *
 * An approved permit must not silently carry forward to different
 * physical premises.
 */
const branchLocationSnapshotSchema = new mongoose.Schema(
  {
    address: {
      type: String,
      required: true,
      trim: true,
      maxlength: 250,
    },
    state: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    lga: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    googlePlaceId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 250,
    },
    location: {
      type: geoPointSchema,
      required: true,
    },
  },
  {
    _id: false,
  }
);

// ───────────────────── FACILITY PERMIT SCHEMA ─────────────────────

const facilityPermitSchema = new mongoose.Schema(
  {
    // ───────── OWNERSHIP ─────────

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      immutable: true,
    },

    // ───────── PERMIT REQUIREMENT ─────────

    /**
     * Stable, server-controlled requirement identifier.
     * Applicable requirements are resolved by the verification service,
     * not invented or marked satisfied by employers.
     */
    requirementKey: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      trim: true,
      maxlength: 120,
      match: [REQUIREMENT_KEY_PATTERN, "Invalid facility permit requirement key."],
    },

    /**
     * The permit may cover a facility, regulated service, or equipment.
     * Different requirements may apply independently to a branch.
     */
    scope: {
      type: String,
      enum: PERMIT_SCOPES,
      required: true,
      immutable: true,
    },

    // ───────── REGULATORY AUTHORITY ─────────

    /**
     * The regulator is selected from trusted regulatory configuration.
     * This model deliberately does not assume PCN is the only regulator.
     */
    authorityCode: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      trim: true,
      maxlength: 80,
      match: [AUTHORITY_CODE_PATTERN, "Invalid regulatory authority code."],
    },

    authorityName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    // ───────── REGISTRATION DETAILS ─────────

    permitNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    permitDescription: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    // ───────── LOCATION EVIDENCE ─────────

    branchLocationSnapshot: {
      type: branchLocationSnapshotSchema,
      required: true,
    },

    // ───────── DOCUMENT EVIDENCE ─────────

    /**
     * Private document references come from trusted upload storage.
     * Client-supplied storage URLs cannot serve as verification evidence.
     */
    documentRef: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
      validate: {
        validator: isValidPrivateDocumentRef,
        message: "A trusted private facility permit document is required.",
      },
    },

    documentMimeType: {
      type: String,
      enum: ALLOWED_DOCUMENT_TYPES,
      required: true,
    },

    documentSizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_DOCUMENT_SIZE,
      validate: {
        validator: Number.isSafeInteger,
        message: "Document size must be a whole number of bytes.",
      },
    },

    submittedAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true,
    },

    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // ───────── VERIFICATION STATUS ─────────

    /**
     * Uploads are pending until reviewed by an authorised administrator.
     * Expiry is derived from approved validity, rather than rewriting
     * historical review status to "expired".
     */
    status: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: "pending",
      required: true,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    reviewNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────── PERMIT VALIDITY ─────────

    /**
     * expiry_date: explicit date.
     * licensing_year: approved year ending on 31 December, only where
     * that official rule applies.
     * indefinite: genuinely non-expiring authorisation.
     */
    validityType: {
      type: String,
      enum: [...VALIDITY_TYPES, null],
      default: null,
    },

    validFromDate: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, "validFromDate must use YYYY-MM-DD."],
    },

    expiryDate: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, "expiryDate must use YYYY-MM-DD."],
    },

    licensingYear: {
      type: Number,
      default: null,
      min: 1900,
      max: 2199,
      validate: {
        validator(value) {
          return value == null || Number.isSafeInteger(value);
        },
        message: "licensingYear must be a whole calendar year.",
      },
    },

    // ───────── CURRENT PERMIT / RENEWAL ─────────

    /**
     * isCurrent identifies the selected permit for a branch requirement.
     * A verified future-dated renewal remains non-current until eligible
     * for transactional activation.
     */
    isCurrent: {
      type: Boolean,
      default: false,
      required: true,
    },

    renewalOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FacilityPermit",
      default: null,
      immutable: true,
    },

    activatedAt: {
      type: Date,
      default: null,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },

    // ───────── REVOCATION ─────────

    /**
     * Revocation immediately removes eligibility without destroying
     * the historical permit evidence.
     */
    revokedAt: {
      type: Date,
      default: null,
    },

    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    revocationReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────────────────── INDEXES ─────────────────────

// Permit and renewal history for one branch.
facilityPermitSchema.index({
  business: 1,
  branch: 1,
  createdAt: -1,
});

// Submission/review history for a particular requirement.
facilityPermitSchema.index({
  branch: 1,
  requirementKey: 1,
  status: 1,
  createdAt: -1,
});

// Only one current permit per branch requirement.
facilityPermitSchema.index(
  {
    branch: 1,
    requirementKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      isCurrent: true,
    },
    name: "unique_current_facility_permit",
  }
);

// Admin verification queue.
facilityPermitSchema.index({
  status: 1,
  submittedAt: -1,
});

// Authority and permit-number lookup. Not globally unique.
facilityPermitSchema.index({
  authorityCode: 1,
  permitNumber: 1,
});

// Renewal history.
facilityPermitSchema.index({
  renewalOf: 1,
  submittedAt: -1,
});

/**
 * Due-renewal optimization.
 *
 * Only verified, non-current, non-revoked, never-activated permits
 * enter this index. Business/branch filtering and validity-start
 * lookup can therefore avoid scanning unrelated historical records.
 *
 * The service must still validate expiry, policy, and premises
 * inside the activation transaction.
 */
facilityPermitSchema.index(
  {
    business: 1,
    branch: 1,
    validFromDate: 1,
  },
  {
    name: "due_facility_permit_activation",
    partialFilterExpression: {
      status: "verified",
      isCurrent: false,
      activatedAt: null,
      revokedAt: null,
    },
  }
);

/**
 * Global due-renewal discovery for the activation scheduler.
 *
 * Supports ordered pagination across all businesses without
 * requiring a business or branch prefix.
 */
facilityPermitSchema.index(
  {
    validFromDate: 1,
    _id: 1,
    business: 1,
    branch: 1,
  },
  {
    name: "global_due_facility_permit_activation",
    partialFilterExpression: {
      status: "verified",
      isCurrent: false,
      activatedAt: null,
      revokedAt: null,
    },
  }
);

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

facilityPermitSchema.pre("validate", function validateFacilityPermit() {
  // ───────── OWNERSHIP ─────────

  if (this.business && this.branch && !mongoose.isValidObjectId(this.business)) {
    this.invalidate("business", "A valid employer business is required.");
  }

  if (this.renewalOf && String(this.renewalOf) === String(this._id)) {
    this.invalidate("renewalOf", "A facility permit cannot renew itself.");
  }

  // ───────── SUBMISSION EVIDENCE ─────────

  if (this.submittedBy && this.reviewedBy && String(this.submittedBy) === String(this.reviewedBy)) {
    this.invalidate("reviewedBy", "An applicant cannot review their own facility permit.");
  }

  // ───────── REVIEW DECISION ─────────

  if (this.status === "pending") {
    if (this.reviewedBy || this.reviewedAt || this.verifiedAt || this.rejectionReason) {
      this.invalidate("status", "Pending permits cannot contain a completed review decision.");
    }
  } else {
    if (!this.reviewedBy || !this.reviewedAt) {
      this.invalidate(
        "reviewedBy",
        "A completed facility permit review requires an administrator and timestamp."
      );
    }
  }

  if (this.status === "verified") {
    if (!this.verifiedAt) {
      this.invalidate("verifiedAt", "Verified facility permits require a verification timestamp.");
    }

    if (this.rejectionReason) {
      this.invalidate("rejectionReason", "Verified permits cannot retain a rejection reason.");
    }
  } else if (this.verifiedAt) {
    this.invalidate("verifiedAt", "Verification timestamps belong only to verified permits.");
  }

  if (this.status === "rejected") {
    if (!this.rejectionReason) {
      this.invalidate("rejectionReason", "Rejected facility permits require a reason.");
    }
  } else if (this.rejectionReason) {
    this.invalidate("rejectionReason", "Rejection reasons belong only to rejected permits.");
  }

  if (this.status === "needs_review" && !this.reviewNote) {
    this.invalidate("reviewNote", "Facility permits requiring further review must include a note.");
  }

  // ───────── VALIDITY DATES ─────────

  if (this.validFromDate != null && !isValidCalendarDate(this.validFromDate)) {
    this.invalidate("validFromDate", "Invalid permit start date.");
  }

  if (this.expiryDate != null && !isValidCalendarDate(this.expiryDate)) {
    this.invalidate("expiryDate", "Invalid permit expiry date.");
  }

  if (this.status === "verified") {
    if (!this.validityType || !this.validFromDate) {
      this.invalidate(
        "validityType",
        "Verified permits require an approved validity type and start date."
      );
    }

    if (this.validityType === "expiry_date") {
      if (
        !this.expiryDate ||
        !isValidCalendarDate(this.expiryDate) ||
        !isValidCalendarDate(this.validFromDate) ||
        this.expiryDate < this.validFromDate ||
        this.licensingYear != null
      ) {
        this.invalidate(
          "expiryDate",
          "Expiry-date permits require a valid expiry date on or after the start date."
        );
      }
    }

    if (this.validityType === "licensing_year") {
      if (
        !Number.isSafeInteger(this.licensingYear) ||
        this.expiryDate !== `${this.licensingYear}-12-31` ||
        !isValidCalendarDate(this.validFromDate) ||
        this.validFromDate > this.expiryDate
      ) {
        this.invalidate(
          "licensingYear",
          "Licensing-year permits must expire on 31 December of the approved year."
        );
      }
    }

    if (this.validityType === "indefinite") {
      if (this.expiryDate != null || this.licensingYear != null) {
        this.invalidate(
          "validityType",
          "Indefinite permits cannot have an expiry date or licensing year."
        );
      }
    }
  }

  // ───────── CURRENT PERMIT ─────────

  if (this.isCurrent) {
    if (this.status !== "verified" || !this.activatedAt || this.revokedAt) {
      this.invalidate(
        "isCurrent",
        "Only an activated, verified and non-revoked permit may be current."
      );
    }

    if (this.deactivatedAt) {
      this.invalidate("deactivatedAt", "A current permit cannot have a deactivation timestamp.");
    }
  }

  // ───────── REVOCATION ─────────

  const hasRevocationEvidence = Boolean(this.revokedAt || this.revokedBy || this.revocationReason);

  if (hasRevocationEvidence) {
    if (!this.revokedAt || !this.revokedBy || !this.revocationReason) {
      this.invalidate("revokedAt", "Revocation requires a timestamp, administrator and reason.");
    }

    if (this.isCurrent) {
      this.invalidate("isCurrent", "A revoked permit cannot remain current.");
    }
  }

  // ───────── TIMESTAMP ORDER ─────────

  if (this.reviewedAt && this.submittedAt && this.reviewedAt < this.submittedAt) {
    this.invalidate("reviewedAt", "Review cannot precede permit submission.");
  }

  if (this.verifiedAt && this.reviewedAt && this.verifiedAt < this.reviewedAt) {
    this.invalidate("verifiedAt", "Verification cannot precede administrative review.");
  }

  if (this.activatedAt && this.verifiedAt && this.activatedAt < this.verifiedAt) {
    this.invalidate("activatedAt", "Activation cannot precede verification.");
  }

  if (this.deactivatedAt && this.activatedAt && this.deactivatedAt < this.activatedAt) {
    this.invalidate("deactivatedAt", "Deactivation cannot precede activation.");
  }
});

// ───────────────────── SUBMISSION EVIDENCE PROTECTION ─────────────────────

/**
 * Submitted ownership, requirement, authority, document, and premises
 * evidence cannot be silently replaced.
 *
 * Review and lifecycle changes remain service-owned.
 */
const IMMUTABLE_SUBMISSION_FIELDS = [
  "business",
  "branch",
  "requirementKey",
  "scope",
  "authorityCode",
  "authorityName",
  "permitNumber",
  "permitDescription",
  "branchLocationSnapshot",
  "documentRef",
  "documentMimeType",
  "documentSizeBytes",
  "submittedAt",
  "submittedBy",
  "renewalOf",
];

facilityPermitSchema.pre("save", function protectSubmissionEvidence() {
  if (this.isNew) {
    return;
  }

  for (const field of IMMUTABLE_SUBMISSION_FIELDS) {
    if (this.isModified(field)) {
      throw new Error(`Facility permit submission evidence cannot be changed: ${field}.`);
    }
  }
});

// ───────────────────── QUERY UPDATE PROTECTION ─────────────────────

/**
 * Permit review and activation must use validated document saves
 * within service-owned transactions.
 *
 * Direct query updates, replacements, and bulk updates are disabled
 * to avoid bypassing document validation.
 */
facilityPermitSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  function () {
    throw new Error("Facility permit updates must use a validated document save.");
  }
);

facilityPermitSchema.pre("bulkWrite", function () {
  throw new Error("Bulk facility permit updates are unsupported.");
});

module.exports = mongoose.model("FacilityPermit", facilityPermitSchema);
