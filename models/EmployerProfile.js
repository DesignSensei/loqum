// models/EmployerProfile.js

const mongoose = require("mongoose");

/**
 * EMPLOYER PROFILE:
 * Stores the employer's business profile, KYC summary, location,
 * contact person, financial summary, reputation, and posting approval status.
 *
 * FINANCIAL ARCHITECTURE:
 *
 * Employers pay for shifts.
 * Professionals do not pay Loqum commission at launch.
 *
 * Employer pays:
 * professional approved pay + Loqum platform fee.
 *
 * SHIFT FUNDING OPTIONS:
 *
 * 1. Fund with Wallet:
 *    Employer wallet availableBalance is debited.
 *    Escrow wallet is credited.
 *
 * 2. Fund with Paystack Checkout:
 *    Employer pays the exact shift amount through Paystack Checkout.
 *    When Paystack confirms payment, escrow is credited directly.
 *    The money does not become employer available wallet balance first.
 *
 * DVA WALLET TOP-UP:
 * DVA is only for employer wallet top-up.
 * DVA should not directly fund shifts.
 * DVA should not directly credit escrow.
 *
 * GENERAL WALLET TOP-UP:
 * If the employer intentionally tops up their wallet, or sends a transfer
 * not tied to a shift funding attempt, the employer wallet is credited.
 *
 * REFUNDS:
 * Excess escrow from cancellation, dispute resolution, or proration can be
 * returned to the employer wallet.
 *
 * KYC:
 * This model stores employer KYC summary fields.
 * Detailed documents, provider references, and review history should live in
 * KYCVerification.
 *
 * BANK ACCOUNT:
 * Withdrawal destination is managed through the BankAccount model.
 * No bank account details are embedded here.
 */

const employerProfileSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

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
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      required: true,
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    businessPhone: {
      type: String,
      trim: true,
      required: true,
    },

    address: {
      type: String,
      trim: true,
      required: true,
    },

    googlePlaceId: {
      type: String,
      trim: true,
      default: "",
    },

    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
        required: true,
      },

      coordinates: {
        type: [Number],
        required: true,
        // [longitude, latitude]
        validate: {
          validator: function (value) {
            if (!Array.isArray(value) || value.length !== 2) return false;

            const [lng, lat] = value;

            return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
          },
          message: "Coordinates must be [longitude, latitude] with valid ranges.",
        },
      },
    },

    state: {
      type: String,
      trim: true,
      required: true,
    },

    lga: {
      type: String,
      trim: true,
      required: true,
    },

    // --- BUSINESS REGISTRATION / CAC SUMMARY ---
    // Employer submits cacRegistrationNumber during onboarding.
    // cacNameOnRecord is entered by admin or saved from provider result
    // after CAC verification.

    cacRegistrationNumber: {
      type: String,
      trim: true,
      required: true,
    },

    cacVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
    },

    cacVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
    },

    cacVerificationSource: {
      type: String,
      enum: ["cac_portal", "uploaded_document", "provider", "internal_review"],
      default: "internal_review",
    },

    cacNameOnRecord: {
      type: String,
      trim: true,
      default: null,
      // Official business name found during CAC verification.
      // This is not entered by the employer during normal onboarding.
      // It is entered by admin or saved from provider/API result.
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

    // --- FACILITY / REGULATORY REGISTRATION SUMMARY ---
    // Employer submits regulatoryBody and regulatoryRegistrationNumber
    // during onboarding.
    // regulatoryNameOnRecord is entered by admin or saved from provider result
    // after facility/regulatory verification.

    regulatoryBody: {
      type: String,
      enum: ["pcn", "hefamaa", "state_moh", "mlscn", "other"],
      required: true,
    },

    regulatoryRegistrationNumber: {
      type: String,
      trim: true,
      required: true,
    },

    regulatoryVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
    },

    regulatoryVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
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
      ],
      default: "internal_review",
    },

    regulatoryNameOnRecord: {
      type: String,
      trim: true,
      default: null,
      // Official facility or business name found during regulatory verification.
      // This is not entered by the employer during normal onboarding.
      // It is entered by admin or saved from provider/API result.
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

    // --- CONTACT PERSON ---

    contactFirstName: {
      type: String,
      trim: true,
      required: true,
    },

    contactLastName: {
      type: String,
      trim: true,
      required: true,
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
    },

    contactPhone: {
      type: String,
      trim: true,
      required: true,
    },

    // --- FINANCIAL SUMMARY ---
    // Wallet balance is managed through Wallet.
    // Actual money movements are recorded through Transaction.
    // This profile only stores high-level employer spending metrics.

    totalShiftsPaid: {
      type: Number,
      default: 0,
      min: 0,
      // Incremented when a shift is successfully funded.
    },

    totalAmountFunded: {
      type: Number,
      default: 0,
      min: 0,
      // Total amount employer has funded into escrow for shifts.
      // Includes professional pay and Loqum platform fee.
    },

    totalAmountSpent: {
      type: Number,
      default: 0,
      min: 0,
      // Final settled amount spent after completion, proration, refunds, or disputes.
      // Includes professional pay and Loqum platform fee.
    },

    totalProfessionalPayFunded: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative professional pay portion funded by this employer.
    },

    totalPlatformFeesPaid: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
      // Internal admin/reporting metric.
      // Do not expose in employer-facing responses unless deliberately needed.
    },

    totalRefundedAmount: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative amount returned to employer wallet.
    },

    // --- ACCOUNT STATUS ---

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active",
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

    // --- REPUTATION ---

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

    totalReviews: {
      type: Number,
      default: 0,
      min: 0,
    },

    // --- SHIFT ACTIVITY ---

    totalShiftsPosted: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalShiftsCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },

    activeShiftCount: {
      type: Number,
      default: 0,
      min: 0,
      // Optional counter for active confirmed or in-progress shifts.
    },

    lastShiftPostedAt: {
      type: Date,
      default: null,
    },

    lastShiftCompletedAt: {
      type: Date,
      default: null,
    },

    // --- EMPLOYER APPROVAL ---

    employerApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "restricted", "needs_review"],
      default: "pending",
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

// --- INDEXES ---
employerProfileSchema.index({ user: 1 }, { unique: true });

employerProfileSchema.index({ accountStatus: 1 });
employerProfileSchema.index({ type: 1 });

employerProfileSchema.index({ state: 1, lga: 1 });
employerProfileSchema.index({ location: "2dsphere" });

employerProfileSchema.index({ countryCode: 1, cacRegistrationNumber: 1 }, { unique: true });

employerProfileSchema.index(
  {
    countryCode: 1,
    regulatoryBody: 1,
    regulatoryRegistrationNumber: 1,
  },
  { unique: true }
);

employerProfileSchema.index({ cacVerificationStatus: 1 });
employerProfileSchema.index({ regulatoryVerificationStatus: 1 });
employerProfileSchema.index({ employerApprovalStatus: 1 });

employerProfileSchema.index({
  type: 1,
  state: 1,
  lga: 1,
  employerApprovalStatus: 1,
  accountStatus: 1,
});

// --- VALIDATION / AUTO-CLEANUP ---

employerProfileSchema.pre("validate", function (next) {
  if (this.cacVerificationStatus === "verified") {
    if (!this.cacVerifiedAt) {
      this.cacVerifiedAt = new Date();
    }

    this.cacRejectionReason = null;
  }

  if (this.regulatoryVerificationStatus === "verified") {
    if (!this.regulatoryVerifiedAt) {
      this.regulatoryVerifiedAt = new Date();
    }

    this.regulatoryRejectionReason = null;
  }

  if (this.employerApprovalStatus === "approved") {
    if (!this.approvedToPostShiftsAt) {
      this.approvedToPostShiftsAt = new Date();
    }

    this.employerRejectionReason = null;
  }

  if (typeof this.isModified === "function" && this.isModified("accountStatus")) {
    this.accountStatusUpdatedAt = new Date();
  }

  next();
});

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
