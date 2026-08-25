// scripts/seedPlatformSettings.js

require("dotenv").config();

const mongoose = require("mongoose");

const PlatformSettings = require("../models/PlatformSettings");
const logger = require("../utils/logger");

const FACILITY_TYPES = ["pharmacy", "clinic", "hospital", "laboratory"];

/* ---------- Nigeria Protected Shift defaults ---------- */

const createNigeriaProtectedShiftLimits = () => ({
  pharmacy: {
    maxOccurrencesPerParentShift: 30,
    maxOpenFundedUnassignedParentsPerBranch: 3,

    // ₦4,000,000
    maxOpenFundedUnassignedAmountMinorPerBranch: 400_000_000,

    // ₦10,000,000
    maxOpenFundedUnassignedAmountMinorPerBusiness: 1_000_000_000,

    maxAdvanceBookingDays: 90,
  },

  clinic: {
    maxOccurrencesPerParentShift: 30,
    maxOpenFundedUnassignedParentsPerBranch: 6,

    // ₦8,000,000
    maxOpenFundedUnassignedAmountMinorPerBranch: 800_000_000,

    // ₦20,000,000
    maxOpenFundedUnassignedAmountMinorPerBusiness: 2_000_000_000,

    maxAdvanceBookingDays: 90,
  },

  hospital: {
    maxOccurrencesPerParentShift: 30,
    maxOpenFundedUnassignedParentsPerBranch: 15,

    // ₦20,000,000
    maxOpenFundedUnassignedAmountMinorPerBranch: 2_000_000_000,

    // ₦75,000,000
    maxOpenFundedUnassignedAmountMinorPerBusiness: 7_500_000_000,

    maxAdvanceBookingDays: 90,
  },

  laboratory: {
    maxOccurrencesPerParentShift: 30,
    maxOpenFundedUnassignedParentsPerBranch: 5,

    // ₦6,000,000
    maxOpenFundedUnassignedAmountMinorPerBranch: 600_000_000,

    // ₦15,000,000
    maxOpenFundedUnassignedAmountMinorPerBusiness: 1_500_000_000,

    maxAdvanceBookingDays: 90,
  },
});

/* ---------- Nigeria country defaults ---------- */

const createNigeriaCountrySetting = () => ({
  countryCode: "NG",
  currency: "NGN",
  platformFeeRate: 0.075,

  // ₦1,000,000 external employer-wallet top-up balance cap.
  // Refund credits may take the wallet above this amount; the cap applies to
  // new external top-ups, not to refund restoration.
  maximumEmployerWalletExternalTopupBalance: 100_000_000,

  // ₦5,000
  minimumEmployerWithdrawalAmount: 500_000,

  // ₦5,000
  minimumProfessionalWithdrawalAmount: 500_000,

  protectedShiftLimits: createNigeriaProtectedShiftLimits(),

  isActive: true,
});

/* ---------- Normalise code list ---------- */

const normalizeCodeList = (values) => {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) =>
          String(value || "")
            .toUpperCase()
            .trim()
        )
        .filter(Boolean)
    ),
  ];
};

/* ---------- Merge facility policy ---------- */

const mergeFacilityPolicy = (existingPolicy, defaultPolicy) => ({
  maxOccurrencesPerParentShift:
    existingPolicy?.maxOccurrencesPerParentShift ?? defaultPolicy.maxOccurrencesPerParentShift,

  maxOpenFundedUnassignedParentsPerBranch:
    existingPolicy?.maxOpenFundedUnassignedParentsPerBranch ??
    defaultPolicy.maxOpenFundedUnassignedParentsPerBranch,

  maxOpenFundedUnassignedAmountMinorPerBranch:
    existingPolicy?.maxOpenFundedUnassignedAmountMinorPerBranch ??
    defaultPolicy.maxOpenFundedUnassignedAmountMinorPerBranch,

  maxOpenFundedUnassignedAmountMinorPerBusiness:
    existingPolicy?.maxOpenFundedUnassignedAmountMinorPerBusiness ??
    defaultPolicy.maxOpenFundedUnassignedAmountMinorPerBusiness,

  maxAdvanceBookingDays:
    existingPolicy?.maxAdvanceBookingDays ?? defaultPolicy.maxAdvanceBookingDays,
});

/* ---------- Merge Protected Shift limits ---------- */

const mergeProtectedShiftLimits = (existingLimits) => {
  const defaultLimits = createNigeriaProtectedShiftLimits();

  const mergedLimits = {};

  for (const facilityType of FACILITY_TYPES) {
    mergedLimits[facilityType] = mergeFacilityPolicy(
      existingLimits?.[facilityType],
      defaultLimits[facilityType]
    );
  }

  return mergedLimits;
};

/* ---------- Set value only when missing ---------- */

const setWhenMissing = (document, path, value) => {
  const currentValue = document.get(path);

  if (currentValue === null || currentValue === undefined) {
    document.set(path, value);
  }
};

/* ---------- Read retired values from the raw MongoDB document ---------- */

const getRetiredValues = (rawSettings) => {
  const rawCountrySettings = Array.isArray(rawSettings?.countrySettings)
    ? rawSettings.countrySettings
    : [];

  const rawNigeriaSetting = rawCountrySettings.find(
    (countrySetting) =>
      String(countrySetting?.countryCode || "")
        .toUpperCase()
        .trim() === "NG"
  );

  return {
    retiredEarlyTerminationMinimumPayRate:
      rawSettings?.shiftCancellationPolicy?.earlyTerminationMinimumPayRate,

    retiredGlobalMaximumEmployerWalletBalance: rawSettings?.maximumEmployerWalletBalance,

    retiredNigeriaMaximumEmployerWalletBalance: rawNigeriaSetting?.maximumEmployerWalletBalance,
  };
};

/* ---------- Create new global platform settings ---------- */

const createNewPlatformSettings = () => {
  const nigeriaSetting = createNigeriaCountrySetting();

  return new PlatformSettings({
    key: "global",

    defaultCountryCode: "NG",
    defaultCurrency: "NGN",

    activeCountryCodes: ["NG"],
    supportedCurrencies: ["NGN"],

    countrySettings: [nigeriaSetting],

    // Compatibility fallbacks for existing services.
    platformFeeRate: nigeriaSetting.platformFeeRate,

    maximumEmployerWalletExternalTopupBalance:
      nigeriaSetting.maximumEmployerWalletExternalTopupBalance,

    minimumEmployerWithdrawalAmount: nigeriaSetting.minimumEmployerWithdrawalAmount,

    minimumProfessionalWithdrawalAmount: nigeriaSetting.minimumProfessionalWithdrawalAmount,

    // Overtime rules
    overtimeResponseHours: 24,
    overtimeTopUpDeadlineHours: 24,
    overtimeTopUpRestrictionGraceHours: 72,

    // Professional settlement payout rules
    professionalSettlementPayoutWeekday: 1,
    professionalSettlementPayoutHour: 9,
    professionalSettlementPayoutMinute: 0,
    professionalSettlementPayoutTimeZone: "Africa/Lagos",

    // Attendance rules
    checkInWindowBeforeMinutes: 30,
    noShowGraceMinutes: 30,

    // Single-occurrence professional release
    singleOccurrenceReleaseNoticeHours: 72,

    // Unfilled occurrence finalisation
    unfilledFinalizationGraceMinutes: 15,

    // Shared occurrence challenge rules
    occurrenceClaimWindowHours: 24,
    employerClaimResponseHours: 24,
    professionalDisputeResponseHours: 24,
    professionalAppealWindowHours: 12,

    // Location rules
    defaultGeofenceRadiusMeters: 100,
    minimumGeofenceRadiusMeters: 20,
    maximumGeofenceRadiusMeters: 1000,
    maximumLocationAccuracyMeters: 100,

    // Cancellation rules
    cancellationSettlementReviewHours: 24,

    shiftCancellationPolicy: {
      lateCancellationWindowMinutes: 30,
      lateCancellationProfessionalPayRate: 0.25,
      activeWorkCancellationMinimumPayRate: 0.25,
    },

    // Credits remain dormant
    creditsEnabled: false,
    freeMonthlyCredits: 20,
    normalApplicationCreditCost: 1,
    urgentApplicationCreditCost: 2,
    boostApplicationCreditCost: 3,

    isActive: true,
  });
};

/* ---------- Backfill Nigeria country setting ---------- */

const backfillNigeriaCountrySetting = ({
  settings,

  retiredNigeriaMaximumEmployerWalletBalance,
}) => {
  const nigeriaDefaults = createNigeriaCountrySetting();

  if (!Array.isArray(settings.countrySettings)) {
    settings.countrySettings = [];
  }

  let nigeriaSetting = settings.countrySettings.find(
    (countrySetting) => countrySetting.countryCode === "NG"
  );

  if (!nigeriaSetting) {
    settings.countrySettings.push({
      ...nigeriaDefaults,

      maximumEmployerWalletExternalTopupBalance:
        retiredNigeriaMaximumEmployerWalletBalance ??
        nigeriaDefaults.maximumEmployerWalletExternalTopupBalance,
    });

    nigeriaSetting = settings.countrySettings.find(
      (countrySetting) => countrySetting.countryCode === "NG"
    );

    return nigeriaSetting;
  }

  nigeriaSetting.set({
    countryCode: "NG",
    currency: "NGN",

    platformFeeRate: nigeriaSetting.platformFeeRate ?? nigeriaDefaults.platformFeeRate,

    maximumEmployerWalletExternalTopupBalance:
      nigeriaSetting.maximumEmployerWalletExternalTopupBalance ??
      retiredNigeriaMaximumEmployerWalletBalance ??
      nigeriaDefaults.maximumEmployerWalletExternalTopupBalance,

    minimumEmployerWithdrawalAmount:
      nigeriaSetting.minimumEmployerWithdrawalAmount ??
      nigeriaDefaults.minimumEmployerWithdrawalAmount,

    minimumProfessionalWithdrawalAmount:
      nigeriaSetting.minimumProfessionalWithdrawalAmount ??
      nigeriaDefaults.minimumProfessionalWithdrawalAmount,

    protectedShiftLimits: mergeProtectedShiftLimits(nigeriaSetting.protectedShiftLimits),

    isActive: true,
  });

  return nigeriaSetting;
};

/* ---------- Backfill general platform rules ---------- */

const backfillGeneralPlatformRules = ({
  settings,

  retiredEarlyTerminationMinimumPayRate,

  retiredGlobalMaximumEmployerWalletBalance,
}) => {
  // Compatibility fallback migration.
  setWhenMissing(
    settings,
    "maximumEmployerWalletExternalTopupBalance",
    retiredGlobalMaximumEmployerWalletBalance ?? 100_000_000
  );

  // Overtime rules.
  setWhenMissing(settings, "overtimeResponseHours", 24);

  setWhenMissing(settings, "overtimeTopUpDeadlineHours", 24);

  setWhenMissing(settings, "overtimeTopUpRestrictionGraceHours", 72);

  // Professional settlement payout rules.
  setWhenMissing(settings, "professionalSettlementPayoutWeekday", 1);

  setWhenMissing(settings, "professionalSettlementPayoutHour", 9);

  setWhenMissing(settings, "professionalSettlementPayoutMinute", 0);

  setWhenMissing(settings, "professionalSettlementPayoutTimeZone", "Africa/Lagos");

  // Attendance rules.
  setWhenMissing(settings, "checkInWindowBeforeMinutes", 30);

  setWhenMissing(settings, "noShowGraceMinutes", 30);

  // Single-occurrence professional release.
  setWhenMissing(settings, "singleOccurrenceReleaseNoticeHours", 72);

  // Unfilled occurrence finalisation.
  setWhenMissing(settings, "unfilledFinalizationGraceMinutes", 15);

  // Shared occurrence challenge rules.
  setWhenMissing(settings, "occurrenceClaimWindowHours", 24);

  setWhenMissing(settings, "employerClaimResponseHours", 24);

  setWhenMissing(settings, "professionalDisputeResponseHours", 24);

  setWhenMissing(settings, "professionalAppealWindowHours", 12);

  // Location rules.
  setWhenMissing(settings, "defaultGeofenceRadiusMeters", 100);

  setWhenMissing(settings, "minimumGeofenceRadiusMeters", 20);

  setWhenMissing(settings, "maximumGeofenceRadiusMeters", 1000);

  setWhenMissing(settings, "maximumLocationAccuracyMeters", 100);

  // Cancellation rules.
  setWhenMissing(settings, "cancellationSettlementReviewHours", 24);

  if (!settings.shiftCancellationPolicy) {
    settings.shiftCancellationPolicy = {};
  }

  const cancellationPolicy = settings.shiftCancellationPolicy;

  cancellationPolicy.lateCancellationWindowMinutes =
    cancellationPolicy.lateCancellationWindowMinutes ?? 30;

  cancellationPolicy.lateCancellationProfessionalPayRate =
    cancellationPolicy.lateCancellationProfessionalPayRate ?? 0.25;

  cancellationPolicy.activeWorkCancellationMinimumPayRate =
    cancellationPolicy.activeWorkCancellationMinimumPayRate ??
    retiredEarlyTerminationMinimumPayRate ??
    0.25;

  // Credits remain dormant.
  setWhenMissing(settings, "creditsEnabled", false);

  setWhenMissing(settings, "freeMonthlyCredits", 20);

  setWhenMissing(settings, "normalApplicationCreditCost", 1);

  setWhenMissing(settings, "urgentApplicationCreditCost", 2);

  setWhenMissing(settings, "boostApplicationCreditCost", 3);

  settings.isActive = true;
};

/* ---------- Rebuild active code and currency lists ---------- */

const synchroniseActiveCountryLists = (settings) => {
  const activeCountrySettings = settings.countrySettings.filter(
    (countrySetting) => countrySetting.isActive === true
  );

  settings.activeCountryCodes = normalizeCodeList(
    activeCountrySettings.map((countrySetting) => countrySetting.countryCode)
  );

  settings.supportedCurrencies = normalizeCodeList([
    ...(settings.supportedCurrencies || []),

    ...activeCountrySettings.map((countrySetting) => countrySetting.currency),
  ]);
};

/* ---------- Resolve and synchronise default country ---------- */

const synchroniseDefaultCountry = (settings) => {
  let defaultCountryCode = String(settings.defaultCountryCode || "NG")
    .toUpperCase()
    .trim();

  let defaultCountrySetting = settings.countrySettings.find(
    (countrySetting) =>
      countrySetting.countryCode === defaultCountryCode && countrySetting.isActive === true
  );

  if (!defaultCountrySetting) {
    defaultCountryCode = "NG";

    defaultCountrySetting = settings.countrySettings.find(
      (countrySetting) => countrySetting.countryCode === "NG" && countrySetting.isActive === true
    );
  }

  if (!defaultCountrySetting) {
    throw new Error("An active default country setting could not be resolved.");
  }

  settings.defaultCountryCode = defaultCountryCode;

  settings.defaultCurrency = defaultCountrySetting.currency;

  if (!settings.activeCountryCodes.includes(defaultCountryCode)) {
    settings.activeCountryCodes.push(defaultCountryCode);
  }

  if (!settings.supportedCurrencies.includes(defaultCountrySetting.currency)) {
    settings.supportedCurrencies.push(defaultCountrySetting.currency);
  }

  /*
   * Keep the compatibility fallback fields aligned with the active
   * default-country setting.
   */

  settings.platformFeeRate = defaultCountrySetting.platformFeeRate;

  settings.maximumEmployerWalletExternalTopupBalance =
    defaultCountrySetting.maximumEmployerWalletExternalTopupBalance;

  settings.minimumEmployerWithdrawalAmount = defaultCountrySetting.minimumEmployerWithdrawalAmount;

  settings.minimumProfessionalWithdrawalAmount =
    defaultCountrySetting.minimumProfessionalWithdrawalAmount;
};

/* ---------- Remove retired MongoDB fields ---------- */

const removeRetiredFields = async (settingsId) => {
  await PlatformSettings.collection.updateOne(
    {
      _id: settingsId,
    },

    {
      $unset: {
        maximumEmployerWalletBalance: "",

        "countrySettings.$[].maximumEmployerWalletBalance": "",

        checkInPinVisibilityMinutes: "",

        checkInPinRevealBeforeMinutes: "",

        "shiftCancellationPolicy.earlyTerminationMinimumPayRate": "",
      },
    }
  );
};

/* ---------- Seed or migrate global platform settings ---------- */

const seedPlatformSettings = async () => {
  const rawSettings = await PlatformSettings.collection.findOne({
    key: "global",
  });

  const retiredValues = getRetiredValues(rawSettings);

  let settings = await PlatformSettings.findOne({
    key: "global",
  });

  if (!settings) {
    settings = createNewPlatformSettings();
  } else {
    /*
     * Do not call settings.set(defaultSettings) here.
     *
     * Replacing the entire settings document would:
     *
     * - remove countries added through the admin UI
     * - reset administrator-edited country policies
     * - replace active country and currency lists
     */

    backfillNigeriaCountrySetting({
      settings,

      retiredNigeriaMaximumEmployerWalletBalance:
        retiredValues.retiredNigeriaMaximumEmployerWalletBalance,
    });

    backfillGeneralPlatformRules({
      settings,

      retiredEarlyTerminationMinimumPayRate: retiredValues.retiredEarlyTerminationMinimumPayRate,

      retiredGlobalMaximumEmployerWalletBalance:
        retiredValues.retiredGlobalMaximumEmployerWalletBalance,
    });

    synchroniseActiveCountryLists(settings);

    synchroniseDefaultCountry(settings);
  }

  /*
   * Document save is required so:
   *
   * - schema validation runs
   * - nested countrySettings validation runs
   * - Protected Shift policy validation runs
   * - cancellation policy validation runs
   * - PlatformSettings pre("validate") middleware runs
   * - timestamps are updated normally
   */

  await settings.save();

  /*
   * Fields removed from a Mongoose schema are not automatically removed
   * from existing MongoDB documents.
   *
   * Remove them only after the new document has saved successfully so a
   * failed migration cannot destroy the legacy value before it is copied.
   */

  await removeRetiredFields(settings._id);

  logger.info("Platform settings seeded or migrated successfully.");

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

if (require.main === module) {
  run();
}

module.exports = {
  seedPlatformSettings,
};
