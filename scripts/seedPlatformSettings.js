// scripts/seedPlatformSettings.js

require("dotenv").config();

const mongoose = require("mongoose");
const PlatformSettings = require("../models/PlatformSettings");
const logger = require("../utils/logger");

/* ---------- Seed or update global platform settings ---------- */
const seedPlatformSettings = async () => {
  const defaultSettings = {
    key: "global",

    activeCountryCodes: ["NG"],
    supportedCurrencies: ["NGN"],
    defaultCountryCode: "NG",
    defaultCurrency: "NGN",

    platformFeeRate: 0.075,

    // Wallet monetary limits are stored in minor units using a factor of 100.
    // Example: ₦1,000,000.00 is stored as 100000000.
    maximumEmployerWalletBalance: 100000000,
    minimumEmployerWithdrawalAmount: 500000,
    minimumProfessionalWithdrawalAmount: 500000,

    countrySettings: [
      {
        countryCode: "NG",
        currency: "NGN",
        platformFeeRate: 0.075,

        // Wallet monetary limits are stored in minor units using a factor of 100.
        // Example: ₦5,000.00 is stored as 500000.
        maximumEmployerWalletBalance: 100000000,
        minimumEmployerWithdrawalAmount: 500000,
        minimumProfessionalWithdrawalAmount: 500000,

        isActive: true,
      },
    ],

    overtimeResponseHours: 24,

    // --- GEOFENCE ATTENDANCE RULES ---

    checkInWindowBeforeMinutes: 30,
    noShowGraceMinutes: 30,

    defaultGeofenceRadiusMeters: 100,
    minimumGeofenceRadiusMeters: 20,
    maximumGeofenceRadiusMeters: 1000,
    maximumLocationAccuracyMeters: 100,

    // --- CREDITS, DORMANT FOR NOW ---

    creditsEnabled: false,
    freeMonthlyCredits: 20,
    normalApplicationCreditCost: 1,
    urgentApplicationCreditCost: 2,
    boostApplicationCreditCost: 3,

    isActive: true,
  };

  const settings = await PlatformSettings.findOneAndUpdate(
    { key: "global" },
    {
      $set: defaultSettings,

      // Removes old PIN setting from existing settings document if it exists.
      $unset: {
        checkInPinVisibilityMinutes: "",
      },
    },
    {
      returnDocument: "after",
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      strict: false,
    }
  );

  logger.info("Platform settings seeded or updated successfully.");

  return settings;
};

/* ---------- Run script ---------- */
const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    logger.info("MongoDB connected for platform settings seeder.");

    await seedPlatformSettings();

    logger.info("Platform settings seeder completed.");
    process.exit(0);
  } catch (error) {
    logger.error(`Platform settings seeder failed: ${error.message}`);
    process.exit(1);
  }
};

run();
