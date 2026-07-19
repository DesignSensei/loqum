// scripts/seedPlatformSettings.js

require("dotenv").config();

const mongoose = require("mongoose");
const PlatformSettings = require("../models/PlatformSettings");
const logger = require("../utils/logger");

/* ---------- Default global platform settings ---------- */

const defaultSettings = {
  key: "global",

  activeCountryCodes: ["NG"],
  supportedCurrencies: ["NGN"],
  defaultCountryCode: "NG",
  defaultCurrency: "NGN",

  // --- GLOBAL FINANCIAL FALLBACKS ---

  platformFeeRate: 0.075,

  // Wallet monetary limits are stored in minor units using a factor of 100.
  // Example: ₦1,000,000.00 is stored as 100000000.
  maximumEmployerWalletBalance: 100000000,
  minimumEmployerWithdrawalAmount: 500000,
  minimumProfessionalWithdrawalAmount: 500000,

  // --- COUNTRY-SPECIFIC SETTINGS ---

  countrySettings: [
    {
      countryCode: "NG",
      currency: "NGN",
      platformFeeRate: 0.075,

      // Wallet monetary limits are stored in minor units.
      maximumEmployerWalletBalance: 100000000,
      minimumEmployerWithdrawalAmount: 500000,
      minimumProfessionalWithdrawalAmount: 500000,

      isActive: true,
    },
  ],

  // --- OVERTIME RULES ---

  overtimeResponseHours: 24,

  // --- SHIFT ATTENDANCE RULES ---

  checkInWindowBeforeMinutes: 30,

  // Employer can see the check-in PIN this many minutes before shift start.
  checkInPinRevealBeforeMinutes: 30,

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

  // --- STATUS ---

  isActive: true,
};

/* ---------- Seed or update global platform settings ---------- */

const seedPlatformSettings = async () => {
  let settings = await PlatformSettings.findOne({
    key: "global",
  });

  if (!settings) {
    settings = new PlatformSettings(defaultSettings);
  } else {
    settings.set(defaultSettings);
  }

  /*
   * Using document.save() instead of findOneAndUpdate() ensures:
   *
   * - schema field validation runs
   * - nested countrySettings validation runs
   * - PlatformSettings pre("validate") middleware runs
   * - timestamps are updated normally
   */

  await settings.save();

  /*
   * Remove the retired field directly from the stored document.
   *
   * It is no longer part of the Mongoose schema, so a direct collection
   * update is used only for this one-time legacy cleanup.
   */

  await PlatformSettings.collection.updateOne(
    { _id: settings._id },
    {
      $unset: {
        checkInPinVisibilityMinutes: "",
      },
    }
  );

  logger.info("Platform settings seeded or updated successfully.");

  return settings;
};

/* ---------- Run script ---------- */

const run = async () => {
  let exitCode = 0;

  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not configured.");
    }

    await mongoose.connect(process.env.MONGO_URI);

    logger.info("MongoDB connected for platform settings seeder.");

    await seedPlatformSettings();

    logger.info("Platform settings seeder completed.");
  } catch (error) {
    exitCode = 1;

    logger.error(`Platform settings seeder failed: ${error.message}`);
  } finally {
    try {
      await mongoose.disconnect();

      logger.info("MongoDB disconnected after platform settings seeding.");
    } catch (disconnectError) {
      exitCode = 1;

      logger.error(`MongoDB disconnection failed: ${disconnectError.message}`);
    }

    process.exitCode = exitCode;
  }
};

run();
