// models/EmployerProfile.js

const mongoose = require("mongoose");

/**
 * FINANCIAL ARCHITECTURE:
 * Employers fund their wallet via DVA (bank transfer → Paystack webhook → wallet credit).
 * Wallet balance is debited when a shift is confirmed (escrow hold).
 * Excess escrow is returned to the wallet on proration or cancellation.
 * Wallet withdrawals go to the employer's linked BankAccount (accountType: "withdrawal").
 */

const employerProfileSchema = new mongoose.Schema(
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
      enum: ["pharmacy", "clinic", "hospital", "laboratory"],
      required: true,
    },

    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    businessRegistrationNumber: {
      type: String,
      trim: true,
      default: null,
    },

    cacVerified: {
      type: Boolean,
      default: false,
    },

    businessPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    businessPhone: {
      type: String,
      trim: true,
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

    // --- CONTACT ---

    contactFirstName: {
      type: String,
      trim: true,
    },

    contactLastName: {
      type: String,
      trim: true,
    },

    contactPhone: {
      type: String,
      trim: true,
    },

    contactPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    // --- FINANCIAL ---
    // Withdrawal destination is managed via the BankAccount model.
    // No account details embedded here.

    totalShiftsPaid: {
      type: Number,
      default: 0, // incremented each time escrow is funded for a shift
    },

    totalAmountSpent: {
      type: Number,
      default: 0, // cumulative escrow funded across all confirmed shifts
    },

    // --- ACCOUNT STATUS ---

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active",
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

    // --- SHIFT ACTIVITY ---

    totalShiftsPosted: {
      type: Number,
      default: 0,
    },

    totalShiftsCompleted: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---
employerProfileSchema.index({ accountStatus: 1 });
employerProfileSchema.index({ type: 1 });
employerProfileSchema.index({ state: 1, lga: 1 });
employerProfileSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
