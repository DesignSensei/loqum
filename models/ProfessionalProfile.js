// models/ProfessionalProfile.js

const mongoose = require("mongoose");

/**
 * PROFESSIONAL PROFILE:
 * Stores the professional's work profile, verification summary, location,
 * availability, reputation, and platform activity.
 *
 * PLATFORM FEE DIRECTION:
 * Loqum's platform fee is paid by the employer.
 * Professionals receive their agreed or approved pay.
 * No pharmacist-side commission deduction at launch.
 *
 * TIER SYSTEM:
 * Tier is evaluated periodically by the service layer or cron job using live
 * profile metrics such as completed shifts, average rating, reliability score,
 * and strike history.
 *
 * Tier should control trust, visibility, active shift limits, and possible
 * priority placement. It should not control pharmacist-side commission at launch.
 *
 * LOCATION:
 * The saved profile location can help Loqum show nearby shifts by default.
 * MVP should still rely mainly on filters such as state, LGA, date, rate,
 * professional type, and specialty.
 *
 * PAYOUT ACCOUNT:
 * Managed through the BankAccount model.
 * No bank account details are embedded here.
 *
 * BVN / KYC:
 * Do not store raw BVN directly in this profile.
 * Store only a verification summary here.
 * Detailed KYC records should live in KYCVerification.
 */

const professionalProfileSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    type: {
      type: String,
      enum: [
        "pharmacist",
        "pharmacy_technician",
        "nurse",
        "doctor",
        "lab_scientist",
        "radiographer",
        "physiotherapist",
      ],
      required: true,
    },

    phone: {
      type: String,
      trim: true,
      required: true,
    },

    phoneCode: {
      type: String,
      trim: true,
      required: true,
      default: "+234",
    },

    specialty: {
      type: String,
      trim: true,
      required: true,
    },

    bio: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    yearsOfExperience: {
      type: Number,
      min: 0,
      default: 0,
    },

    // --- LOCATION ---

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

    // --- LICENCE VERIFICATION ---

    licenceNumber: {
      type: String,
      trim: true,
      required: true,
    },

    licenceIssuingBody: {
      type: String,
      trim: true,
      default: null,
      // Example: PCN, NMCN, MDCN, MLSCN, RRBN, or another relevant council.
    },

    licenceVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
    },

    licenceVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
    },

    licenceVerificationSource: {
      type: String,
      enum: [
        "pcn_public_portal",
        "professional_council_portal",
        "uploaded_document",
        "provider",
        "internal_review",
        "not_checked",
      ],
      default: "internal_review",
    },

    licenceNameOnRecord: {
      type: String,
      trim: true,
      default: null,
    },

    licenceDocumentUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    licenceExpiryDate: {
      type: Date,
      default: null,
    },

    licenceVerifiedAt: {
      type: Date,
      default: null,
    },

    licenceLastCheckedAt: {
      type: Date,
      default: null,
    },

    licenceVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    licenceVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // --- CERTIFICATIONS ---

    certifications: [
      {
        name: {
          type: String,
          trim: true,
          required: true,
        },

        issuingBody: {
          type: String,
          trim: true,
        },

        dateObtained: {
          type: Date,
        },

        expiryDate: {
          type: Date,
          default: null,
        },

        documentUrl: {
          type: String,
          trim: true,
          default: null,
          select: false,
        },

        verified: {
          type: Boolean,
          default: false,
        },

        verifiedAt: {
          type: Date,
          default: null,
        },

        verifiedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
    ],

    // --- IDENTITY VERIFICATION ---

    identityVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
    },

    identityVerificationMethod: {
      type: String,
      enum: ["manual", "provider", "not_checked"],
      default: "not_checked",
    },

    identityVerificationSource: {
      type: String,
      enum: ["government_id", "nin", "bvn", "selfie_match", "internal_review"],
      default: "internal_review",
    },

    identityNameOnDocument: {
      type: String,
      trim: true,
      default: null,
    },

    identityDocumentType: {
      type: String,
      enum: [
        "nin_slip",
        "national_id",
        "passport",
        "drivers_license",
        "voters_card",
        "other",
        null,
      ],
      default: null,
    },

    identityDocumentUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    identityVerifiedAt: {
      type: Date,
      default: null,
    },

    identityLastCheckedAt: {
      type: Date,
      default: null,
    },

    identityVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    identityVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // --- BVN / KYC VERIFICATION SUMMARY ---
    // Full KYC records live in KYCVerification.
    // This summary is only for quick profile and payout readiness checks.

    bvnVerification: {
      status: {
        type: String,
        enum: ["not_started", "pending", "verified", "rejected", "needs_review"],
        default: "not_started",
      },

      provider: {
        type: String,
        enum: ["paystack", "dojah", "smile_identity", "manual", null],
        default: null,
      },

      providerReference: {
        type: String,
        trim: true,
        default: null,
        select: false,
      },

      last4: {
        type: String,
        trim: true,
        default: null,
        select: false,
        // Optional masked BVN ending only.
      },

      verifiedAt: {
        type: Date,
        default: null,
      },

      lastCheckedAt: {
        type: Date,
        default: null,
      },

      verifiedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      note: {
        type: String,
        trim: true,
        maxlength: 500,
        default: null,
      },
    },

    // --- AVAILABILITY ---

    availabilityStatus: {
      type: String,
      enum: ["available", "unavailable", "busy", "paused"],
      default: "available",
      // Professionals can pause availability without being suspended.
    },

    availableDates: [
      {
        type: Date,
      },
    ],

    availabilityNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    // --- FINANCIAL SUMMARY ---
    // Payout account is managed through BankAccount.
    // Wallet balance is managed through Wallet.
    // This profile only stores high-level professional earnings metrics.

    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative approved professional pay credited from completed shifts.
      // This does not include Loqum platform fee.
    },

    // --- TIER ---

    tier: {
      type: String,
      enum: ["newcomer", "accredited", "elite"],
      default: "newcomer",
    },

    tierSnapshot: {
      averageRating: {
        type: Number,
        default: null,
        min: 0,
        max: 5,
      },

      totalShiftsCompleted: {
        type: Number,
        default: null,
        min: 0,
      },

      reliabilityScore: {
        type: Number,
        default: null,
        min: 0,
        max: 100,
      },

      evaluatedAt: {
        type: Date,
        default: null,
      },

      // Captured each time tier is evaluated and assigned.
      // Audit trail for why a professional is at their current tier.
    },

    tierUpdatedAt: {
      type: Date,
      default: null,
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

    // --- MARKETPLACE VISIBILITY ---

    marketplaceStatus: {
      type: String,
      enum: ["hidden", "visible", "paused"],
      default: "hidden",
      // hidden: not shown to employers or matching suggestions.
      // visible: can appear in matching, suggestions, and employer-side views.
      // paused: professional temporarily paused visibility.
    },

    // --- STRIKES ---

    strikes: {
      noShows: {
        type: Number,
        default: 0,
        min: 0,
      },

      lateArrivals: {
        type: Number,
        default: 0,
        min: 0,
      },

      earlyDepartures: {
        type: Number,
        default: 0,
        min: 0,
      },

      total: {
        type: Number,
        default: 0,
        min: 0,
      },

      // Feeds into tier evaluation and reliabilityScore.
      // A strike threshold breach can trigger restriction or tier demotion.
    },

    // --- SHIFT ACTIVITY ---

    totalShiftsCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },

    activeShiftCount: {
      type: Number,
      default: 0,
      min: 0,
      // Incremented on assignment, decremented on completion or cancellation.
      // Checked against tier limits before new assignment.
    },

    totalHoursWorked: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastShiftCompletedAt: {
      type: Date,
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

    reliabilityScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
      // Starts at 100. Decremented by strikes or poor attendance behaviour.
      // Used in tier evaluation and employer confidence signals.
    },

    // --- PROFESSIONAL APPROVAL ---

    professionalApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "restricted", "needs_review"],
      default: "pending",
    },

    approvedForShiftsAt: {
      type: Date,
      default: null,
    },

    approvedForShiftsBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvalNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    rejectionReason: {
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

professionalProfileSchema.index({ user: 1 }, { unique: true });

professionalProfileSchema.index({ type: 1 });
professionalProfileSchema.index({ specialty: 1 });
professionalProfileSchema.index({ tier: 1 });

professionalProfileSchema.index({ accountStatus: 1 });
professionalProfileSchema.index({ marketplaceStatus: 1 });
professionalProfileSchema.index({ availabilityStatus: 1 });

professionalProfileSchema.index({ averageRating: -1 });
professionalProfileSchema.index({ reliabilityScore: -1 });

professionalProfileSchema.index({ state: 1, lga: 1 });
professionalProfileSchema.index({ location: "2dsphere" });

professionalProfileSchema.index({ type: 1, licenceNumber: 1 }, { unique: true });

professionalProfileSchema.index({ licenceVerificationStatus: 1 });
professionalProfileSchema.index({ identityVerificationStatus: 1 });
professionalProfileSchema.index({ "bvnVerification.status": 1 });
professionalProfileSchema.index({ professionalApprovalStatus: 1 });

professionalProfileSchema.index({
  type: 1,
  state: 1,
  lga: 1,
  professionalApprovalStatus: 1,
  accountStatus: 1,
  marketplaceStatus: 1,
});

// --- VALIDATION / AUTO-CLEANUP ---

professionalProfileSchema.pre("validate", function () {
  if (this.strikes) {
    const noShows = Number(this.strikes.noShows || 0);
    const lateArrivals = Number(this.strikes.lateArrivals || 0);
    const earlyDepartures = Number(this.strikes.earlyDepartures || 0);

    this.strikes.total = noShows + lateArrivals + earlyDepartures;
  }

  if (this.professionalApprovalStatus === "approved") {
    if (!this.approvedForShiftsAt) {
      this.approvedForShiftsAt = new Date();
    }

    if (this.marketplaceStatus === "hidden") {
      this.marketplaceStatus = "visible";
    }
  }

  if (["restricted", "suspended"].includes(this.accountStatus)) {
    this.marketplaceStatus = "hidden";
  }
});

module.exports = mongoose.model("ProfessionalProfile", professionalProfileSchema);
