// models/PlatformSettings.js

const mongoose = require("mongoose");

const { minorUnitAmountField, nonNegativeIntegerField } = require("./helpers/schemaFields");

const normalizeCodeList = (values, fallback) => {
  if (!Array.isArray(values)) {
    return fallback;
  }

  return [...new Set(values.map((value) => String(value).toUpperCase().trim()).filter(Boolean))];
};

/**
 * PLATFORM SETTINGS MODEL:
 *
 * Stores global platform-wide rules for Loqum.
 *
 * There should only be one global settings document.
 *
 * Current financial direction:
 * - Employers pay for shifts.
 * - Professionals do not pay Loqum commission at launch.
 * - Employer pays professional approved pay + Loqum platform fee.
 * - Platform fee is employer-side.
 * - Shift pricing is locked when the shift is posted.
 * - The active platformFeeRate is snapshotted into each Shift.
 *
 * COUNTRY-SPECIFIC SETTINGS:
 *
 * When a matching active countrySettings entry exists, it is the preferred
 * source for that country's fee and wallet limits.
 *
 * The global platformFeeRate and wallet-limit fields remain fallback values
 * for the default country and for existing Phase 2 services.
 *
 * Credits are dormant at launch.
 * creditsEnabled must remain false until the credits system is deliberately
 * activated.
 */

const countrySettingSchema = new mongoose.Schema(
  {
    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
    },

    platformFeeRate: {
      type: Number,
      default: 0.075,
      min: 0,
      max: 1,
      // Example: 0.075 means 7.50%.
    },

    maximumEmployerWalletBalance: minorUnitAmountField({
      required: true,
      defaultValue: 100000000,
    }),

    minimumEmployerWithdrawalAmount: minorUnitAmountField({
      required: true,
      defaultValue: 500000,
    }),

    minimumProfessionalWithdrawalAmount: minorUnitAmountField({
      required: true,
      defaultValue: 500000,
    }),

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    _id: false,
  }
);

const platformSettingsSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    key: {
      type: String,
      enum: ["global"],
      default: "global",
      required: true,
      immutable: true,
    },

    defaultCountryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "defaultCountryCode must be a valid two-letter country code."],
    },

    defaultCurrency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "defaultCurrency must be a valid three-letter currency code."],
    },

    activeCountryCodes: {
      type: [String],
      default: ["NG"],
      set: (countryCodes) => normalizeCodeList(countryCodes, ["NG"]),
      validate: {
        validator: (countryCodes) =>
          Array.isArray(countryCodes) &&
          countryCodes.length > 0 &&
          countryCodes.every((countryCode) => /^[A-Z]{2}$/.test(countryCode)),
        message: "At least one valid active two-letter country code is required.",
      },
    },

    supportedCurrencies: {
      type: [String],
      default: ["NGN"],
      set: (currencies) => normalizeCodeList(currencies, ["NGN"]),
      validate: {
        validator: (currencies) =>
          Array.isArray(currencies) &&
          currencies.length > 0 &&
          currencies.every((currency) => /^[A-Z]{3}$/.test(currency)),
        message: "At least one valid supported three-letter currency code is required.",
      },
    },

    countrySettings: {
      type: [countrySettingSchema],
      default: [
        {
          countryCode: "NG",
          currency: "NGN",
          platformFeeRate: 0.075,
          maximumEmployerWalletBalance: 100000000,
          minimumEmployerWithdrawalAmount: 500000,
          minimumProfessionalWithdrawalAmount: 500000,
          isActive: true,
        },
      ],
      validate: {
        validator: (settings) => Array.isArray(settings) && settings.length > 0,
        message: "At least one country setting is required.",
      },
    },

    // --- PLATFORM FEE FALLBACK ---
    //
    // Country-aware services should first use the matching active
    // countrySettings entry.
    //
    // This field remains the fallback fee for the default country and supports
    // existing Phase 2 services that read the global value directly.

    platformFeeRate: {
      type: Number,
      default: 0.075,
      min: 0,
      max: 1,
      // 0.075 means 7.50%.
      // Each shift snapshots the resolved rate when it is posted.
    },

    // --- WALLET-LIMIT FALLBACKS ---

    maximumEmployerWalletBalance: minorUnitAmountField({
      required: true,
      defaultValue: 100000000,
    }),

    minimumEmployerWithdrawalAmount: minorUnitAmountField({
      required: true,
      defaultValue: 500000,
    }),

    minimumProfessionalWithdrawalAmount: minorUnitAmountField({
      required: true,
      defaultValue: 500000,
    }),

    // --- OVERTIME RULES ---

    overtimeResponseHours: nonNegativeIntegerField({
      required: true,
      defaultValue: 24,
    }),

    // --- SHIFT ATTENDANCE RULES ---

    checkInWindowBeforeMinutes: nonNegativeIntegerField({
      required: true,
      defaultValue: 30,
    }),

    checkInPinRevealBeforeMinutes: nonNegativeIntegerField({
      required: true,
      defaultValue: 30,
    }),
    // Number of minutes before shift start when the employer can see
    // the check-in PIN.

    noShowGraceMinutes: nonNegativeIntegerField({
      required: true,
      defaultValue: 30,
    }),

    defaultGeofenceRadiusMeters: {
      type: Number,
      default: 100,
      min: 20,
      max: 1000,
      validate: {
        validator: Number.isSafeInteger,
        message: "defaultGeofenceRadiusMeters must be a whole number.",
      },
    },

    minimumGeofenceRadiusMeters: {
      type: Number,
      default: 20,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "minimumGeofenceRadiusMeters must be a whole number.",
      },
    },

    maximumGeofenceRadiusMeters: {
      type: Number,
      default: 1000,
      min: 20,
      validate: {
        validator: Number.isSafeInteger,
        message: "maximumGeofenceRadiusMeters must be a whole number.",
      },
    },

    maximumLocationAccuracyMeters: nonNegativeIntegerField({
      required: true,
      defaultValue: 100,
    }),

    // --- CREDITS, DORMANT FOR NOW ---

    creditsEnabled: {
      type: Boolean,
      default: false,
    },

    freeMonthlyCredits: nonNegativeIntegerField({
      defaultValue: 20,
    }),

    normalApplicationCreditCost: nonNegativeIntegerField({
      defaultValue: 1,
    }),

    urgentApplicationCreditCost: nonNegativeIntegerField({
      defaultValue: 2,
    }),

    boostApplicationCreditCost: nonNegativeIntegerField({
      defaultValue: 3,
    }),

    // --- STATUS AND AUDIT ---

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

// --- CROSS-FIELD VALIDATION ---

platformSettingsSchema.pre("validate", function validatePlatformSettings() {
  const countrySettings = Array.isArray(this.countrySettings) ? this.countrySettings : [];

  const countryCodes = countrySettings.map((setting) =>
    String(setting.countryCode || "")
      .toUpperCase()
      .trim()
  );

  if (new Set(countryCodes).size !== countryCodes.length) {
    this.invalidate("countrySettings", "Each country code can have only one country setting.");
  }

  if (!this.activeCountryCodes.includes(this.defaultCountryCode)) {
    this.invalidate(
      "defaultCountryCode",
      "defaultCountryCode must be included in activeCountryCodes."
    );
  }

  if (!this.supportedCurrencies.includes(this.defaultCurrency)) {
    this.invalidate("defaultCurrency", "defaultCurrency must be included in supportedCurrencies.");
  }

  for (const countryCode of this.activeCountryCodes) {
    const activeCountrySetting = countrySettings.find(
      (setting) => setting.countryCode === countryCode && setting.isActive === true
    );

    if (!activeCountrySetting) {
      this.invalidate(
        "countrySettings",
        `Active country ${countryCode} must have an active country setting.`
      );
    }
  }

  for (const countrySetting of countrySettings) {
    if (countrySetting.isActive && !this.activeCountryCodes.includes(countrySetting.countryCode)) {
      this.invalidate(
        "activeCountryCodes",
        `Active country setting ${countrySetting.countryCode} must be included in activeCountryCodes.`
      );
    }

    if (!this.supportedCurrencies.includes(countrySetting.currency)) {
      this.invalidate(
        "supportedCurrencies",
        `Currency ${countrySetting.currency} must be included in supportedCurrencies.`
      );
    }
  }

  const defaultCountrySetting = countrySettings.find(
    (setting) => setting.countryCode === this.defaultCountryCode && setting.isActive === true
  );

  if (defaultCountrySetting && defaultCountrySetting.currency !== this.defaultCurrency) {
    this.invalidate(
      "defaultCurrency",
      "defaultCurrency must match the active default country setting."
    );
  }

  if (this.minimumGeofenceRadiusMeters > this.maximumGeofenceRadiusMeters) {
    this.invalidate(
      "minimumGeofenceRadiusMeters",
      "minimumGeofenceRadiusMeters cannot exceed maximumGeofenceRadiusMeters."
    );
  }

  if (
    this.defaultGeofenceRadiusMeters < this.minimumGeofenceRadiusMeters ||
    this.defaultGeofenceRadiusMeters > this.maximumGeofenceRadiusMeters
  ) {
    this.invalidate(
      "defaultGeofenceRadiusMeters",
      "defaultGeofenceRadiusMeters must be within the configured minimum and maximum geofence radii."
    );
  }
});

// --- INDEXES ---

platformSettingsSchema.index(
  {
    key: 1,
  },
  {
    unique: true,
  }
);

platformSettingsSchema.index({ isActive: 1 });

module.exports = mongoose.model("PlatformSettings", platformSettingsSchema);
