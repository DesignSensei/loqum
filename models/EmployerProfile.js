// models/EmployerProfile.js

const mongoose = require("mongoose");

const { minorUnitAmountField, nonNegativeIntegerField } = require("./helpers/schemaFields");

/**
 * EMPLOYER PROFILE:
 *
 * Stores the employer's business profile, KYC summary, location,
 * contact person, financial summary, reputation and posting approval status.
 *
 * COUNTRY AND CURRENCY:
 *
 * EmployerProfile.countryCode and EmployerProfile.currency are the
 * authoritative values used when resolving country-specific platform settings.
 *
 * Branches belong to an employer profile and do not independently determine
 * country or currency.
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
 * If the employer intentionally tops up their wallet or sends a transfer
 * not tied to a shift funding attempt, the employer wallet is credited.
 *
 * REFUNDS:
 * Excess escrow from cancellation, dispute resolution or proration can be
 * returned to the employer wallet.
 *
 * KYC:
 * This model stores employer KYC summary fields.
 * Detailed documents, provider references and review history should live in
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

    businessName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

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

    address: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    googlePlaceId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 250,
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
        validate: {
          validator: (value) => {
            if (!Array.isArray(value) || value.length !== 2) {
              return false;
            }

            const [longitude, latitude] = value;

            return (
              Number.isFinite(longitude) &&
              Number.isFinite(latitude) &&
              longitude >= -180 &&
              longitude <= 180 &&
              latitude >= -90 &&
              latitude <= 90
            );
          },
          message: "Coordinates must be [longitude, latitude] with valid ranges.",
        },
      },
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

    // --- BUSINESS REGISTRATION / CAC SUMMARY ---

    cacRegistrationNumber: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
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
      maxlength: 150,
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

    // --- FACILITY OR REGULATORY REGISTRATION SUMMARY ---

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

    // --- CONTACT PERSON ---

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

    // --- FINANCIAL SUMMARY ---
    //
    // Wallet balance is managed through Wallet.
    // Actual money movements are recorded through Transaction.
    //
    // Monetary summaries are stored as whole minor-unit amounts.

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

    totalReviews: nonNegativeIntegerField(),

    // --- SHIFT ACTIVITY ---

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

employerProfileSchema.index(
  {
    user: 1,
  },
  {
    unique: true,
  }
);

employerProfileSchema.index({ accountStatus: 1 });
employerProfileSchema.index({ type: 1 });

employerProfileSchema.index({ state: 1, lga: 1 });
employerProfileSchema.index({ location: "2dsphere" });

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

employerProfileSchema.index({ cacVerificationStatus: 1 });

employerProfileSchema.index({
  regulatoryVerificationStatus: 1,
});

employerProfileSchema.index({ employerApprovalStatus: 1 });

employerProfileSchema.index({
  type: 1,
  state: 1,
  lga: 1,
  employerApprovalStatus: 1,
  accountStatus: 1,
});

// Used when checking whether an employer can post shifts.

employerProfileSchema.index({
  _id: 1,
  employerApprovalStatus: 1,
  accountStatus: 1,
});

// --- VALIDATION AND AUTO-CLEANUP ---

employerProfileSchema.pre("validate", function validateEmployerProfile() {
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
});

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
