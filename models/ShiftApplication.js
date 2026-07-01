// models/ShiftApplication.js

const mongoose = require("mongoose");

/**
 * SHIFT APPLICATION MODEL:
 *
 * This model records a professional's interest in a shift.
 *
 * CURRENT MVP FLOW:
 * Professional applies for free.
 * Employer reviews applications.
 * Employer accepts/selects one application.
 * Once accepted, contact details can be shown.
 * Shift then moves to assigned.
 * Employer still needs to fund the shift before it becomes confirmed.
 *
 * IMPORTANT STATUS DISTINCTION:
 *
 * accepted:
 * Employer has selected the professional.
 * Contact details can be shown.
 *
 * confirmed:
 * Employer has funded the shift.
 * This is handled on Shift.js, not here.
 *
 * FUTURE CREDITS FLOW:
 * Credits are dormant at launch.
 * The fields exist so Credits can be activated later without rebuilding the model.
 *
 * OVERLAP ENFORCEMENT:
 * The service layer checks for time conflicts at two points:
 * 1. On application, as a soft guard.
 * 2. On assignment, as a hard guard before committing the selection.
 *
 * This model does not enforce overlap.
 */

const shiftApplicationSchema = new mongoose.Schema(
  {
    // --- CORE RELATIONSHIP ---

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    // --- APPLICATION STATUS ---

    status: {
      type: String,
      enum: [
        "pending",
        // Application submitted and awaiting employer review.

        "shortlisted",
        // Optional future state if employer wants to save candidates before selecting.

        "accepted",
        // Employer selected this professional.
        // Contact details can be shown from this point.
        // This does not mean the shift is funded yet.

        "rejected",
        // Employer rejected the application.

        "withdrawn",
        // Professional withdrew the application.

        "expired",
        // Shift was filled, expired, or closed before this application was accepted.

        "cancelled",
        // Shift was cancelled before application was resolved.
      ],
      default: "pending",
    },

    // --- APPLICATION NOTE ---

    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
      // Optional message from the professional when applying.
    },

    // --- EMPLOYER REVIEW ---

    reviewedAt: {
      type: Date,
      default: null,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      // Employer user who reviewed, shortlisted, accepted, or rejected.
    },

    employerPrivateNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
      // Optional internal note for the employer.
      // Not visible to the professional.
    },

    // --- STATUS TIMESTAMPS ---

    shortlistedAt: {
      type: Date,
      default: null,
    },

    acceptedAt: {
      type: Date,
      default: null,
      // Set when employer selects this professional.
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    rejectedReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    withdrawnAt: {
      type: Date,
      default: null,
    },

    withdrawalReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    expiredAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    // --- MATCHING SNAPSHOT ---
    // Stores what the system saw at the time of application.
    // This protects matching history from later profile edits.

    matchSnapshot: {
      professionalType: {
        type: String,
        trim: true,
        default: null,
      },

      specialty: {
        type: String,
        trim: true,
        default: null,
      },

      yearsOfExperience: {
        type: Number,
        min: 0,
        default: null,
      },

      preferredRate: {
        type: Number,
        min: 0,
        default: null,
      },

      distanceKm: {
        type: Number,
        min: 0,
        default: null,
      },

      rating: {
        type: Number,
        min: 0,
        max: 5,
        default: null,
      },

      completedShifts: {
        type: Number,
        min: 0,
        default: null,
      },
    },

    // --- FUTURE CREDITS FLOW ---
    // Credits are not active at launch.
    // Keep these fields dormant until creditsEnabled is true in PlatformSettings.

    credits: {
      used: {
        type: Boolean,
        default: false,
      },

      applicationCreditsUsed: {
        type: Number,
        min: 0,
        default: 0,
      },

      boostCreditsUsed: {
        type: Number,
        min: 0,
        default: 0,
      },

      totalCreditsUsed: {
        type: Number,
        min: 0,
        default: 0,
      },

      isBoosted: {
        type: Boolean,
        default: false,
      },

      boostLevel: {
        type: String,
        enum: ["standard", "priority", "premium", null],
        default: null,
      },

      creditTransactions: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "CreditTransaction",
        },
      ],

      refunded: {
        type: Boolean,
        default: false,
      },

      refundedAt: {
        type: Date,
        default: null,
      },

      refundReason: {
        type: String,
        enum: [
          "employer_cancelled_shift",
          "shift_withdrawn",
          "shift_expired_without_selection",
          "loqum_removed_shift",
          "shift_details_changed",
          "admin_refund",
          null,
        ],
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One application per professional per shift
shiftApplicationSchema.index({ shift: 1, professional: 1 }, { unique: true });

// All applications for a shift, used by employer reviewing candidates
shiftApplicationSchema.index({ shift: 1, status: 1 });

// All applications by a professional, used for their application history
shiftApplicationSchema.index({ professional: 1, status: 1 });

// General status lookup
shiftApplicationSchema.index({ status: 1 });

// Employer review workflow
shiftApplicationSchema.index({ reviewedBy: 1, status: 1 });
shiftApplicationSchema.index({ acceptedAt: 1 });
shiftApplicationSchema.index({ rejectedAt: 1 });

// Future boosted application sorting
shiftApplicationSchema.index({ "credits.isBoosted": 1, "credits.boostLevel": 1 });

// --- VALIDATION / AUTO-CLEANUP ---

shiftApplicationSchema.pre("validate", function () {
  const now = new Date();

  if (this.status === "shortlisted" && !this.shortlistedAt) {
    this.shortlistedAt = now;
  }

  if (this.status === "accepted" && !this.acceptedAt) {
    this.acceptedAt = now;
  }

  if (this.status === "rejected" && !this.rejectedAt) {
    this.rejectedAt = now;
  }

  if (this.status === "withdrawn" && !this.withdrawnAt) {
    this.withdrawnAt = now;
  }

  if (this.status === "expired" && !this.expiredAt) {
    this.expiredAt = now;
  }

  if (this.status === "cancelled" && !this.cancelledAt) {
    this.cancelledAt = now;
  }

  if (["shortlisted", "accepted", "rejected"].includes(this.status) && !this.reviewedAt) {
    this.reviewedAt = now;
  }

  if (this.credits) {
    const applicationCreditsUsed = Number(this.credits.applicationCreditsUsed || 0);
    const boostCreditsUsed = Number(this.credits.boostCreditsUsed || 0);

    this.credits.totalCreditsUsed = applicationCreditsUsed + boostCreditsUsed;
    this.credits.used = this.credits.totalCreditsUsed > 0;

    if (!this.credits.isBoosted) {
      this.credits.boostLevel = null;
    }
  }
});

module.exports = mongoose.model("ShiftApplication", shiftApplicationSchema);
