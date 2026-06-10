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

    maximumEmployerWalletBalance: 1000000,
    minimumEmployerWithdrawalAmount: 5000,
    minimumProfessionalWithdrawalAmount: 5000,

    countrySettings: [
      {
        countryCode: "NG",
        currency: "NGN",
        platformFeeRate: 0.075,
        maximumEmployerWalletBalance: 1000000,
        minimumEmployerWithdrawalAmount: 5000,
        minimumProfessionalWithdrawalAmount: 5000,
        isActive: true,
      },
    ],

    overtimeResponseHours: 24,

    checkInPinVisibilityMinutes: 30,
    noShowGraceMinutes: 30,

    creditsEnabled: false,
    freeMonthlyCredits: 20,
    normalApplicationCreditCost: 1,
    urgentApplicationCreditCost: 2,
    boostApplicationCreditCost: 3,

    isActive: true,
  };

  const settings = await PlatformSettings.findOneAndUpdate(
    { key: "global" },
    { $set: defaultSettings },
    {
      returnDocument: "after",
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
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
