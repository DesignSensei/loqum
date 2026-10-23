// models/EmployerProfile.js

const mongoose = require("mongoose");

const geoPointSchema = require("./helpers/geoPointSchema");

const { minorUnitAmountField, nonNegativeIntegerField } = require("./helpers/schemaFields");

const { hasAnyValue, validateVerificationState } = require("./helpers/employerProfileHelpers");

/**
 * EMPLOYER PROFILE
 *
 * Stores business identity, contact information, location,
 * verification status, financial summaries and approval.
 *
 * Registered business names originate from trusted CAC evidence.
 * Verification and approval remain separate processes.
 *
 * Services must independently enforce authorisation because
 * schema validation does not protect query-based updates.
 */

// ───────────────────── REGISTRY VALIDATION ─────────────────────

const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;

// Reject invalid CAC names without modifying authoritative evidence.
function isValidRegisteredBusinessName(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 150 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

// ───────────────────── SCHEMA ─────────────────────

const employerProfileSchema = new mongoose.Schema(
  {
    // ───────────────────── BUSINESS IDENTITY ─────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    type: {
      type: String,
      enum: ["pharmacy", "clinic", "hospital", "laboratory"],
      required: true,
    },

    countryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
      required: true,
      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      required: true,
      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
    },

    /**
     * Authoritative registered business name.
     * Obtained from successful production CAC verification.
     * Ordinary profile editing must not modify this field.
     */
    businessName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,

      validate: {
        validator: isValidRegisteredBusinessName,
        message: "businessName must contain a valid CAC registered legal business name.",
      },
    },

    // ───────────────────── BUSINESS BRANDING ─────────────────────

    logoUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    publicDescription: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: null,
    },

    websiteUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
      match: [/^https?:\/\/\S+$/i, "websiteUrl must be a valid HTTP or HTTPS URL."],
    },

    // ───────────────────── BUSINESS CONTACT ─────────────────────

    businessEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      maxlength: 254,
    },

    businessPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
      maxlength: 10,
    },

    businessPhone: {
      type: String,
      trim: true,
      required: true,
      maxlength: 30,
    },

    // ───────────────────── BUSINESS LOCATION ─────────────────────

    // Coordinates use GeoJSON order: [longitude, latitude].
    address: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    googlePlaceId: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    location: {
      type: geoPointSchema,
      required: true,
    },

    state: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    lga: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    // ───────────────────── CAC VERIFICATION ─────────────────────

    /**
     * CAC registration is verified through the configured provider.
     * RC and BN support depends on provider capabilities.
     *
     * No automatic provider fallback or duplicate paid lookup.
     * Staging evidence cannot establish production verification.
     *
     * CAC verification does not prove representative authority
     * or grant final employer approval.
     */

    cacRegistrationNumber: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      maxlength: 100,

      match: [
        CAC_REGISTRATION_PATTERN,
        "cacRegistrationNumber must be a valid RC or BN registration number.",
      ],
    },

    cacVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
      required: true,
    },

    cacVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
      required: true,
    },

    cacVerificationSource: {
      type: String,
      enum: ["cac_portal", "uploaded_document", "provider", "internal_review", "not_checked"],
      default: "not_checked",
      required: true,
    },

    /**
     * Registered legal name returned by CAC.
     * Must match businessName when CAC status is verified.
     * A changed registry name requires controlled review.
     */
    cacNameOnRecord: {
      type: String,
      trim: true,
      default: null,
      maxlength: 150,

      validate: {
        validator(value) {
          return value == null || isValidRegisteredBusinessName(value);
        },

        message: "cacNameOnRecord must contain a valid registered legal business name.",
      },
    },

    cacVerifiedAt: {
      type: Date,
      default: null,
    },

    cacLastCheckedAt: {
      type: Date,
      default: null,
    },

    cacVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cacVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    cacRejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────────────────── REGULATORY VERIFICATION ─────────────────────

    /**
     * Nigerian pharmacy premises are checked through PCN.
     * PCN verification is manual until an authorised API exists.
     *
     * Regulatory verification is independent of CAC registration,
     * representative authority and final employer approval.
     * Detailed review records belong in KYCVerification.
     */

    regulatoryBody: {
      type: String,
      enum: ["pcn", "hefamaa", "state_moh", "mlscn", "other"],
      required: true,
    },

    regulatoryRegistrationNumber: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    regulatoryVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
      required: true,
    },

    regulatoryVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
      required: true,
    },

    regulatoryVerificationSource: {
      type: String,
      enum: [
        "pcn_public_portal",
        "hefamaa_portal",
        "state_moh",
        "mlscn_portal",
        "uploaded_document",
        "provider",
        "internal_review",
        "not_checked",
      ],
      default: "not_checked",
      required: true,
    },

    regulatoryNameOnRecord: {
      type: String,
      trim: true,
      default: null,
      maxlength: 150,
    },

    regulatoryVerifiedAt: {
      type: Date,
      default: null,
    },

    regulatoryLastCheckedAt: {
      type: Date,
      default: null,
    },

    regulatoryVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    regulatoryVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    regulatoryRejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────────────────── CONTACT PERSON ─────────────────────

    /**
     * Employer-declared contact information.
     * These details do not independently verify authority
     * to represent the registered business.
     */

    contactFirstName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    contactLastName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    contactRole: {
      type: String,
      enum: [
        "owner",
        "director",
        "superintendent_pharmacist",
        "branch_manager",
        "hr_admin",
        "operations_manager",
        "procurement_manager",
        "other",
      ],
      required: true,
      trim: true,
    },

    contactPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
      maxlength: 10,
    },

    contactPhone: {
      type: String,
      trim: true,
      required: true,
      maxlength: 30,
    },

    // ───────────────────── FINANCIAL SUMMARY ─────────────────────

    /**
     * Summary values use whole minor currency units.
     * Wallet balances and transactions are stored separately.
     *
     * DVA provisioning occurs after onboarding commits.
     * Wallet setup does not establish final employer approval.
     */

    totalShiftsPaid: nonNegativeIntegerField(),

    totalAmountFunded: minorUnitAmountField({
      defaultValue: 0,
    }),

    totalAmountSpent: minorUnitAmountField({
      defaultValue: 0,
    }),

    totalProfessionalPayFunded: minorUnitAmountField({
      defaultValue: 0,
    }),

    totalPlatformFeesPaid: minorUnitAmountField({
      defaultValue: 0,
      select: false,
    }),

    totalRefundedAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

    // ───────────────────── ACCOUNT STATUS ─────────────────────

    /**
     * Account restrictions are separate from verification.
     * A previously approved employer may be suspended.
     *
     * Marketplace services must enforce account restrictions
     * regardless of historical approval status.
     */

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active",
      required: true,
    },

    accountStatusReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    accountStatusUpdatedAt: {
      type: Date,
      default: null,
    },

    accountStatusUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ───────────────────── REPUTATION ─────────────────────

    reviews: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Review",
      },
    ],

    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    totalReviews: nonNegativeIntegerField(),

    // ───────────────────── SHIFT ACTIVITY ─────────────────────

    totalShiftsPosted: nonNegativeIntegerField(),

    totalShiftsCompleted: nonNegativeIntegerField(),

    activeShiftCount: nonNegativeIntegerField(),

    lastShiftPostedAt: {
      type: Date,
      default: null,
    },

    lastShiftCompletedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── EMPLOYER APPROVAL ─────────────────────

    /**
     * Final marketplace approval is a separate admin decision.
     *
     * Approval requires verified CAC and regulatory registration,
     * independent representative checks and applicable eligibility.
     *
     * Account restrictions and sanctions must still be enforced
     * when deciding whether marketplace actions are permitted.
     */

    employerApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "restricted", "needs_review"],
      default: "pending",
      required: true,
    },

    employerApprovalStatusUpdatedAt: {
      type: Date,
      default: null,
    },

    employerApprovalStatusUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvedToPostShiftsAt: {
      type: Date,
      default: null,
    },

    approvedToPostShiftsBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    employerApprovalNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    employerRejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ───────────────────── INDEXES ─────────────────────

employerProfileSchema.index({ user: 1 }, { unique: true });

employerProfileSchema.index({
  accountStatus: 1,
});

employerProfileSchema.index({
  type: 1,
});

employerProfileSchema.index({
  state: 1,
  lga: 1,
});

employerProfileSchema.index({
  location: "2dsphere",
});

employerProfileSchema.index(
  {
    countryCode: 1,
    cacRegistrationNumber: 1,
  },
  {
    unique: true,
  }
);

employerProfileSchema.index(
  {
    countryCode: 1,
    regulatoryBody: 1,
    regulatoryRegistrationNumber: 1,
  },
  {
    unique: true,
  }
);

employerProfileSchema.index({
  cacVerificationStatus: 1,
});

employerProfileSchema.index({
  regulatoryVerificationStatus: 1,
});

employerProfileSchema.index({
  employerApprovalStatus: 1,
});

employerProfileSchema.index({
  type: 1,
  state: 1,
  lga: 1,
  employerApprovalStatus: 1,
  accountStatus: 1,
});

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

employerProfileSchema.pre("validate", function validateEmployerProfile() {
  // ───────────────────── CAC REGISTRATION ─────────────────────

  // Nigerian businesses require a normalised RC or BN number.
  // Provider-specific eligibility is checked before a paid lookup.
  if (
    this.countryCode === "NG" &&
    !CAC_REGISTRATION_PATTERN.test(this.cacRegistrationNumber || "")
  ) {
    this.invalidate(
      "cacRegistrationNumber",
      "A Nigerian employer requires a valid RC or BN registration number."
    );
  }

  // ───────────────────── CAC VERIFICATION STATE ─────────────────────

  validateVerificationState(this, {
    label: "CAC",
    pathPrefix: "cac",
    status: this.cacVerificationStatus,
    method: this.cacVerificationMethod,
    source: this.cacVerificationSource,
    nameOnRecord: this.cacNameOnRecord,
    verifiedAt: this.cacVerifiedAt,
    lastCheckedAt: this.cacLastCheckedAt,
    verifiedBy: this.cacVerifiedBy,
    verificationNote: this.cacVerificationNote,
    rejectionReason: this.cacRejectionReason,
  });

  // ───────────────────── CAC LEGAL IDENTITY ─────────────────────

  /**
   * A verified CAC record must match the profile's legal name.
   * Later registry-name changes may trigger review but must not
   * silently replace previously established business identity.
   */
  if (this.cacVerificationStatus === "verified") {
    if (!isValidRegisteredBusinessName(this.cacNameOnRecord)) {
      this.invalidate(
        "cacNameOnRecord",
        "Verified CAC registration requires a valid registry-derived legal business name."
      );
    }

    if (this.businessName !== this.cacNameOnRecord) {
      this.invalidate(
        "businessName",
        "The verified registered business name must match the CAC name on record."
      );
    }

    if (this.cacVerificationMethod !== "api" && this.cacVerificationMethod !== "provider") {
      this.invalidate(
        "cacVerificationMethod",
        "CAC verification must originate from the configured verification provider."
      );
    }

    if (this.cacVerificationSource !== "provider") {
      this.invalidate(
        "cacVerificationSource",
        "Verified CAC registration requires trusted provider evidence."
      );
    }
  }

  // ───────────────────── CAC REGISTRATION CHANGES ─────────────────────

  // A changed registration number cannot retain verified status.
  // Authorised changes require a fresh verification workflow.
  if (
    !this.isNew &&
    this.isModified("cacRegistrationNumber") &&
    this.cacVerificationStatus === "verified"
  ) {
    this.invalidate(
      "cacRegistrationNumber",
      "Changing the CAC registration number requires fresh CAC verification."
    );
  }

  // ───────────────────── REGULATORY VERIFICATION ─────────────────────

  validateVerificationState(this, {
    label: "Regulatory",
    pathPrefix: "regulatory",
    status: this.regulatoryVerificationStatus,
    method: this.regulatoryVerificationMethod,
    source: this.regulatoryVerificationSource,
    nameOnRecord: this.regulatoryNameOnRecord,
    verifiedAt: this.regulatoryVerifiedAt,
    lastCheckedAt: this.regulatoryLastCheckedAt,
    verifiedBy: this.regulatoryVerifiedBy,
    verificationNote: this.regulatoryVerificationNote,
    rejectionReason: this.regulatoryRejectionReason,
  });

  // ───────────────────── ACCOUNT STATUS AUDIT ─────────────────────

  // Restricted and suspended accounts require an audit reason and actor.
  const accountStatusHasAudit = hasAnyValue([
    this.accountStatusReason,
    this.accountStatusUpdatedAt,
    this.accountStatusUpdatedBy,
  ]);

  if (["restricted", "suspended"].includes(this.accountStatus)) {
    if (!this.accountStatusReason) {
      this.invalidate(
        "accountStatusReason",
        `${this.accountStatus} account status requires a reason.`
      );
    }

    if (!this.accountStatusUpdatedAt) {
      this.invalidate(
        "accountStatusUpdatedAt",
        `${this.accountStatus} account status requires an update timestamp.`
      );
    }

    if (!this.accountStatusUpdatedBy) {
      this.invalidate(
        "accountStatusUpdatedBy",
        `${this.accountStatus} account status requires an update actor.`
      );
    }
  } else if (
    accountStatusHasAudit &&
    (!this.accountStatusUpdatedAt || !this.accountStatusUpdatedBy)
  ) {
    this.invalidate(
      "accountStatusUpdatedAt",
      "Account-status audit data requires both accountStatusUpdatedAt and accountStatusUpdatedBy."
    );
  }

  // ───────────────────── EMPLOYER APPROVAL AUDIT ─────────────────────

  // Every non-pending approval decision requires an actor and timestamp.
  const approvalStatusHasAudit = hasAnyValue([
    this.employerApprovalStatusUpdatedAt,
    this.employerApprovalStatusUpdatedBy,
  ]);

  if (this.employerApprovalStatus !== "pending") {
    if (!this.employerApprovalStatusUpdatedAt) {
      this.invalidate(
        "employerApprovalStatusUpdatedAt",
        `${this.employerApprovalStatus} employer approval status requires an update timestamp.`
      );
    }

    if (!this.employerApprovalStatusUpdatedBy) {
      this.invalidate(
        "employerApprovalStatusUpdatedBy",
        `${this.employerApprovalStatus} employer approval status requires an update actor.`
      );
    }
  } else if (
    approvalStatusHasAudit &&
    (!this.employerApprovalStatusUpdatedAt || !this.employerApprovalStatusUpdatedBy)
  ) {
    this.invalidate(
      "employerApprovalStatusUpdatedAt",
      "Employer-approval audit data requires both employerApprovalStatusUpdatedAt and employerApprovalStatusUpdatedBy."
    );
  }

  // ───────────────────── APPROVAL TIMESTAMP PAIR ─────────────────────

  const hasApprovalTimestamp = Boolean(this.approvedToPostShiftsAt);
  const hasApprovalActor = Boolean(this.approvedToPostShiftsBy);

  if (hasApprovalTimestamp !== hasApprovalActor) {
    this.invalidate(
      "approvedToPostShiftsBy",
      "approvedToPostShiftsAt and approvedToPostShiftsBy must be set together."
    );
  }

  // ───────────────────── APPROVED EMPLOYERS ─────────────────────

  /**
   * Approval requires verified CAC and regulatory registration.
   * Independent representative checks remain service-owned.
   * Suspension can still block marketplace access after approval.
   */
  if (this.employerApprovalStatus === "approved") {
    if (!this.approvedToPostShiftsAt || !this.approvedToPostShiftsBy) {
      this.invalidate(
        "approvedToPostShiftsAt",
        "Approved employers require approval timestamp and approval actor."
      );
    }

    if (this.employerRejectionReason) {
      this.invalidate(
        "employerRejectionReason",
        "Approved employers cannot retain a rejection reason."
      );
    }

    if (
      this.cacVerificationStatus !== "verified" ||
      this.regulatoryVerificationStatus !== "verified"
    ) {
      this.invalidate(
        "employerApprovalStatus",
        "Employer approval requires verified CAC and regulatory registration."
      );
    }
  }

  // ───────────────────── REJECTED EMPLOYERS ─────────────────────

  if (this.employerApprovalStatus === "rejected") {
    if (!this.employerRejectionReason) {
      this.invalidate(
        "employerRejectionReason",
        "Rejected employer approval requires a rejection reason."
      );
    }

    if (this.approvedToPostShiftsAt || this.approvedToPostShiftsBy) {
      this.invalidate(
        "approvedToPostShiftsAt",
        "Rejected employer approval cannot retain posting approval details."
      );
    }
  } else if (this.employerRejectionReason) {
    this.invalidate(
      "employerRejectionReason",
      "employerRejectionReason may only be set when employerApprovalStatus is rejected."
    );
  }

  // ───────────────────── RESTRICTIONS AND REVIEW ─────────────────────

  if (
    ["restricted", "needs_review"].includes(this.employerApprovalStatus) &&
    !this.employerApprovalNote
  ) {
    this.invalidate(
      "employerApprovalNote",
      `${this.employerApprovalStatus} employer approval status requires an approval note.`
    );
  }

  if (
    !["approved", "restricted"].includes(this.employerApprovalStatus) &&
    (this.approvedToPostShiftsAt || this.approvedToPostShiftsBy)
  ) {
    this.invalidate(
      "approvedToPostShiftsAt",
      "Posting approval details may only be retained for approved or restricted employers."
    );
  }

  // ───────────────────── APPROVAL CHRONOLOGY ─────────────────────

  // A later approval-status update cannot precede posting approval.
  if (
    this.approvedToPostShiftsAt &&
    this.employerApprovalStatusUpdatedAt &&
    this.approvedToPostShiftsAt > this.employerApprovalStatusUpdatedAt
  ) {
    this.invalidate(
      "employerApprovalStatusUpdatedAt",
      "Employer approval status cannot be updated before posting approval was granted."
    );
  }
});

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
