// models/ProfessionalProfile.js

const mongoose = require("mongoose");

/**
 * TIER SYSTEM:
 * Tier is evaluated periodically by a cron job against live profile metrics.
 * It determines commission rate at shift assignment time.
 * The mapping lives in config/policy.js, not here.
 *
 *   newcomer   → 7.5% commission,  max 1 active shift
 *   accredited → 6.25% commission, max 3 active shifts
 *   elite      → 5% commission,    unlimited active shifts, priority placement
 *
 * All professionals receive instant payout after settlement regardless of tier.
 *
 * PAYOUT ACCOUNT:
 * Managed via the BankAccount model (ownerType: "professional").
 * No account details embedded here.
 */

const professionalProfileSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
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
    },

    phoneCode: {
      type: String,
      trim: true,
    },

    specialty: {
      type: String,
      trim: true,
      required: true,
    },

    address: {
      type: String,
      trim: true,
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
        required: true,
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
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
      required: true,
    },

    lga: {
      type: String,
      required: true,
    },

    bio: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // --- LICENSING ---

    licenceNumber: {
      type: String,
      trim: true,
      required: true,
    },

    licenceVerified: {
      type: Boolean,
      default: false,
    },

    yearsOfExperience: {
      type: Number,
      min: 0,
    },

    certifications: [
      {
        name: { type: String, trim: true, required: true },
        issuingBody: { type: String, trim: true },
        dateObtained: { type: Date },
        expiryDate: { type: Date, default: null },
        documentUrl: { type: String, trim: true },
        verified: { type: Boolean, default: false },
      },
    ],

    // --- AVAILABILITY ---

    availableDates: [
      {
        type: Date,
      },
    ],

    // --- FINANCIAL ---
    // Payout account is managed via the BankAccount model.
    // No account details embedded here.

    bvn: {
      type: String,
      trim: true,
      select: false, // never returned in queries unless explicitly requested
    },

    totalEarnings: {
      type: Number,
      default: 0, // cumulative net earnings credited to wallet across all shifts
    },

    // --- TIER ---

    tier: {
      type: String,
      enum: ["newcomer", "accredited", "elite"],
      default: "newcomer",
    },

    tierSnapshot: {
      averageRating: { type: Number, default: null },
      totalShiftsCompleted: { type: Number, default: null },
      reliabilityScore: { type: Number, default: null },
      evaluatedAt: { type: Date, default: null },
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

    // --- STRIKES ---

    strikes: {
      noShows: { type: Number, default: 0 },
      lateArrivals: { type: Number, default: 0 },
      earlyDepartures: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      // Feeds into tier evaluation and reliabilityScore.
      // A strike threshold breach can trigger immediate tier demotion
      // independent of the scheduled cron evaluation.
    },

    // --- SHIFT ACTIVITY ---

    totalShiftsCompleted: {
      type: Number,
      default: 0,
    },

    activeShiftCount: {
      type: Number,
      default: 0,
      // Incremented on assignment, decremented on completion or cancellation.
      // Checked against tier limit before any new assignment:
      //   newcomer   → max 1
      //   accredited → max 3
      //   elite      → unlimited
    },

    totalHoursWorked: {
      type: Number,
      default: 0,
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
    },

    totalReviews: {
      type: Number,
      default: 0,
    },

    reliabilityScore: {
      type: Number,
      default: 100,
      // Starts at 100. Decremented by strikes.
      // Input to tier evaluation alongside averageRating and totalShiftsCompleted.
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

professionalProfileSchema.index({ tier: 1 });
professionalProfileSchema.index({ accountStatus: 1 });
professionalProfileSchema.index({ type: 1 });
professionalProfileSchema.index({ averageRating: -1 });
professionalProfileSchema.index({ state: 1, lga: 1 });
professionalProfileSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("ProfessionalProfile", professionalProfileSchema);
