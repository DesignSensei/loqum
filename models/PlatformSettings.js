// models/PlatformSettings.js

const mongoose = require("mongoose");

/**
 * PLATFORM SETTINGS MODEL:
 *
 * Stores global platform-wide rules for Loqum.
 *
 * There should only be one active global settings document.
 *
 * Current financial direction:
 * - Employers pay for shifts.
 * - Professionals do not pay Loqum commission at launch.
 * - Employer pays professional approved pay + Loqum platform fee.
 * - Platform fee is employer-side.
 * - Shift pricing is locked when the shift is posted.
 * - The active platformFeeRate is snapshotted into each Shift.
 *
 * Credits are dormant at launch.
 * creditsEnabled must remain false until the Credits system is deliberately activated.
 */

const platformSettingsSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    key: {
      type: String,
      enum: ["global"],
      default: "global",
      required: true,
    },

    defaultCountryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
    },

    defaultCurrency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
    },

    activeCountryCodes: {
      type: [String],
      default: ["NG"],
      set: (countryCodes) =>
        Array.isArray(countryCodes)
          ? countryCodes.map((countryCode) => String(countryCode).toUpperCase().trim())
          : ["NG"],
      validate: {
        validator: (countryCodes) => Array.isArray(countryCodes) && countryCodes.length > 0,
        message: "At least one active country code is required.",
      },
    },

    supportedCurrencies: {
      type: [String],
      default: ["NGN"],
      set: (currencies) =>
        Array.isArray(currencies)
          ? currencies.map((currency) => String(currency).toUpperCase().trim())
          : ["NGN"],
      validate: {
        validator: (currencies) => Array.isArray(currencies) && currencies.length > 0,
        message: "At least one supported currency is required.",
      },
    },

    // --- PLATFORM FEES ---

    platformFeeRate: {
      type: Number,
      default: 0.075,
      min: 0,
      max: 1,
      // 0.075 means 7.50%.
      // This is the employer-side fee used for new shifts.
      // Each shift should snapshot this rate when pricing is locked at posting.
    },

    // --- WALLET LIMITS ---

    maximumEmployerWalletBalance: {
      type: Number,
      default: 1000000,
      min: 0,
      // Maximum amount an employer can keep in wallet.
      // Helps prevent employers from parking unlimited funds on Loqum.
    },

    minimumEmployerWithdrawalAmount: {
      type: Number,
      default: 5000,
      min: 0,
      // Minimum amount an employer can withdraw from eligible wallet balance.
    },

    minimumProfessionalWithdrawalAmount: {
      type: Number,
      default: 5000,
      min: 0,
      // Minimum amount a professional can withdraw.
    },

    // --- OVERTIME RULES ---

    overtimeResponseHours: {
      type: Number,
      default: 24,
      min: 1,
      // Number of hours employer has to approve, reject, or dispute overtime.
    },

    // --- SHIFT ATTENDANCE RULES ---

    checkInPinVisibilityMinutes: {
      type: Number,
      default: 30,
      min: 0,
      // Number of minutes before shift start when employer can see check-in PIN.
    },

    noShowGraceMinutes: {
      type: Number,
      default: 30,
      min: 0,
      // Number of minutes after shift start before a confirmed shift can be treated as no-show.
    },

    // --- CREDITS, DORMANT FOR NOW ---

    creditsEnabled: {
      type: Boolean,
      default: false,
    },

    freeMonthlyCredits: {
      type: Number,
      default: 20,
      min: 0,
      // Future use only.
      // Ignored while creditsEnabled is false.
    },

    normalApplicationCreditCost: {
      type: Number,
      default: 1,
      min: 0,
      // Future use only.
    },

    urgentApplicationCreditCost: {
      type: Number,
      default: 2,
      min: 0,
      // Future use only.
    },

    boostApplicationCreditCost: {
      type: Number,
      default: 3,
      min: 0,
      // Future use only.
    },

    // --- STATUS & AUDIT ---

    isActive: {
      type: Boolean,
      default: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

platformSettingsSchema.index({ key: 1 }, { unique: true });
platformSettingsSchema.index({ isActive: 1 });

module.exports = mongoose.model("PlatformSettings", platformSettingsSchema);
