// services/adminPlatformSettingsService.js

const mongoose = require("mongoose");

const PlatformSettings = require("../models/PlatformSettings");

const { FINANCIAL_RATE_SCALE, MAX_SHIFT_OCCURRENCES } = require("../constants/shiftPosting");

const money = require("../utils/money");

const FACILITY_TYPES = Object.freeze(["pharmacy", "clinic", "hospital", "laboratory"]);

class AdminPlatformSettingsService {
  /* ─────────────────────────────── GENERIC HELPERS ─────────────────────────────── */

  static isProvided(value) {
    return value !== undefined;
  }

  static assertAtLeastOneProvided(entries, message) {
    if (!entries.some((value) => AdminPlatformSettingsService.isProvided(value))) {
      throw new Error(message);
    }
  }

  static normalizeCountryCode(countryCode) {
    const normalizedCountryCode = String(countryCode || "")
      .toUpperCase()
      .trim();

    if (!/^[A-Z]{2}$/.test(normalizedCountryCode)) {
      throw new Error("A valid two-letter country code is required.");
    }

    return normalizedCountryCode;
  }

  static normalizeCurrency(currency) {
    const normalizedCurrency = String(currency || "")
      .toUpperCase()
      .trim();

    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new Error("A valid three-letter currency code is required.");
    }

    return normalizedCurrency;
  }

  static normalizeFinancialRate(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      throw new Error(`${fieldName} is required.`);
    }

    const normalizedRate = Number(value);

    if (!Number.isFinite(normalizedRate) || normalizedRate < 0 || normalizedRate > 1) {
      throw new Error(`${fieldName} must be a number between 0 and 1.`);
    }

    try {
      money.scaleRate({
        rate: normalizedRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName,
      });
    } catch (error) {
      throw new Error(`${fieldName} must use the supported financial rate precision.`);
    }

    return normalizedRate;
  }

  static normalizePlatformFeeRate(platformFeeRate) {
    return AdminPlatformSettingsService.normalizeFinancialRate(
      platformFeeRate,
      "Platform fee rate"
    );
  }

  static normalizePositiveMinorUnitAmount(value, fieldName) {
    try {
      return money.normalizePositiveMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw new Error(`${fieldName} must be a positive whole number in minor units.`);
    }
  }

  static normalizeNonNegativeInteger(value, fieldName) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 0) {
      throw new Error(`${fieldName} must be a non-negative whole number.`);
    }

    return normalizedValue;
  }

  static normalizePositiveInteger(value, fieldName, { maximum = null } = {}) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
      throw new Error(`${fieldName} must be a positive whole number.`);
    }

    if (maximum !== null && normalizedValue > maximum) {
      throw new Error(`${fieldName} cannot exceed ${maximum}.`);
    }

    return normalizedValue;
  }

  static normalizeBoolean(value, fieldName) {
    if (typeof value !== "boolean") {
      throw new Error(`${fieldName} must be true or false.`);
    }

    return value;
  }

  static normalizeTimeZone(value, fieldName) {
    const normalizedTimeZone = String(value || "").trim();

    if (!normalizedTimeZone) {
      throw new Error(`${fieldName} is required.`);
    }

    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: normalizedTimeZone,
      }).format();
    } catch (error) {
      throw new Error(`${fieldName} must be a valid IANA time zone.`);
    }

    return normalizedTimeZone;
  }

  static normalizeUpdatedBy(updatedBy) {
    if (!updatedBy || !mongoose.Types.ObjectId.isValid(updatedBy)) {
      throw new Error("A valid administrator user ID is required.");
    }

    return new mongoose.Types.ObjectId(String(updatedBy));
  }

  static normalizeFacilityType(facilityType) {
    const normalizedFacilityType = String(facilityType || "")
      .trim()
      .toLowerCase();

    if (!FACILITY_TYPES.includes(normalizedFacilityType)) {
      throw new Error("A valid facility type is required.");
    }

    return normalizedFacilityType;
  }

  /* ─────────────────────────────── SETTINGS / COUNTRY LOOKUP ─────────────────────────────── */

  static async getActivePlatformSettings({ session = null } = {}) {
    const query = PlatformSettings.findOne({
      key: "global",
      isActive: true,
    });

    if (session) {
      query.session(session);
    }

    const settings = await query;

    if (!settings) {
      throw new Error("Active platform settings could not be found.");
    }

    return settings;
  }

  static findCountrySetting(settings, countryCode) {
    const normalizedCountryCode = AdminPlatformSettingsService.normalizeCountryCode(countryCode);

    const countrySetting = settings.countrySettings.find(
      (setting) => setting.countryCode === normalizedCountryCode
    );

    if (!countrySetting) {
      throw new Error(`No country setting exists for ${normalizedCountryCode}.`);
    }

    return countrySetting;
  }

  static synchronizeActiveCountryRegistries(settings) {
    const activeCountrySettings = settings.countrySettings.filter(
      (countrySetting) => countrySetting.isActive === true
    );

    if (activeCountrySettings.length === 0) {
      throw new Error("At least one country setting must remain active.");
    }

    settings.activeCountryCodes = [
      ...new Set(activeCountrySettings.map((countrySetting) => countrySetting.countryCode)),
    ];

    settings.supportedCurrencies = [
      ...new Set(activeCountrySettings.map((countrySetting) => countrySetting.currency)),
    ];
  }

  static async saveSettings(settings, updatedBy, session) {
    settings.updatedBy = AdminPlatformSettingsService.normalizeUpdatedBy(updatedBy);

    await settings.save({
      session,
    });

    return settings;
  }

  /* ─────────────────────────────── PROTECTED SHIFT LIMITS ─────────────────────────────── */

  static normalizeProtectedShiftFacilityPolicy(policyInput, facilityType) {
    if (!policyInput || typeof policyInput !== "object" || Array.isArray(policyInput)) {
      throw new Error(`Complete Protected Shift limits are required for ${facilityType}.`);
    }

    const policy = {
      maxOccurrencesPerParentShift: AdminPlatformSettingsService.normalizePositiveInteger(
        policyInput.maxOccurrencesPerParentShift,
        `${facilityType}.maxOccurrencesPerParentShift`,
        {
          maximum: MAX_SHIFT_OCCURRENCES,
        }
      ),

      maxOpenFundedUnassignedParentsPerBranch:
        AdminPlatformSettingsService.normalizePositiveInteger(
          policyInput.maxOpenFundedUnassignedParentsPerBranch,
          `${facilityType}.maxOpenFundedUnassignedParentsPerBranch`
        ),

      maxOpenFundedUnassignedAmountMinorPerBranch:
        AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
          policyInput.maxOpenFundedUnassignedAmountMinorPerBranch,
          `${facilityType}.maxOpenFundedUnassignedAmountMinorPerBranch`
        ),

      maxOpenFundedUnassignedAmountMinorPerBusiness:
        AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
          policyInput.maxOpenFundedUnassignedAmountMinorPerBusiness,
          `${facilityType}.maxOpenFundedUnassignedAmountMinorPerBusiness`
        ),

      maxAdvanceBookingDays: AdminPlatformSettingsService.normalizePositiveInteger(
        policyInput.maxAdvanceBookingDays,
        `${facilityType}.maxAdvanceBookingDays`
      ),
    };

    if (
      policy.maxOpenFundedUnassignedAmountMinorPerBranch >
      policy.maxOpenFundedUnassignedAmountMinorPerBusiness
    ) {
      throw new Error(
        `${facilityType}.maxOpenFundedUnassignedAmountMinorPerBusiness cannot be lower than the branch limit.`
      );
    }

    return policy;
  }

  static normalizeProtectedShiftLimits(protectedShiftLimits) {
    if (
      !protectedShiftLimits ||
      typeof protectedShiftLimits !== "object" ||
      Array.isArray(protectedShiftLimits)
    ) {
      throw new Error("Complete Protected Shift limits are required.");
    }

    const normalizedLimits = {};

    for (const facilityType of FACILITY_TYPES) {
      normalizedLimits[facilityType] =
        AdminPlatformSettingsService.normalizeProtectedShiftFacilityPolicy(
          protectedShiftLimits[facilityType],
          facilityType
        );
    }

    return normalizedLimits;
  }

  /* ─────────────────────────────── COUNTRY MANAGEMENT ─────────────────────────────── */

  static async updateCountryPlatformFee({
    countryCode,
    platformFeeRate,
    updatedBy,
    session = null,
  }) {
    const normalizedPlatformFeeRate =
      AdminPlatformSettingsService.normalizePlatformFeeRate(platformFeeRate);

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(settings, countryCode);

    countrySetting.platformFeeRate = normalizedPlatformFeeRate;

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
    };
  }

  static async updateCountryCurrency({ countryCode, currency, updatedBy, session = null }) {
    const normalizedCurrency = AdminPlatformSettingsService.normalizeCurrency(currency);

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(settings, countryCode);

    countrySetting.currency = normalizedCurrency;

    if (countrySetting.countryCode === settings.defaultCountryCode) {
      settings.defaultCurrency = normalizedCurrency;
    }

    AdminPlatformSettingsService.synchronizeActiveCountryRegistries(settings);

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
    };
  }

  static async updateCountryFinancialLimits({
    countryCode,
    maximumEmployerWalletExternalTopupBalance,
    minimumEmployerWithdrawalAmount,
    minimumProfessionalWithdrawalAmount,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        maximumEmployerWalletExternalTopupBalance,
        minimumEmployerWithdrawalAmount,
        minimumProfessionalWithdrawalAmount,
      ],
      "At least one country financial limit must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(settings, countryCode);

    if (AdminPlatformSettingsService.isProvided(maximumEmployerWalletExternalTopupBalance)) {
      countrySetting.maximumEmployerWalletExternalTopupBalance =
        AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
          maximumEmployerWalletExternalTopupBalance,
          "maximumEmployerWalletExternalTopupBalance"
        );
    }

    if (AdminPlatformSettingsService.isProvided(minimumEmployerWithdrawalAmount)) {
      countrySetting.minimumEmployerWithdrawalAmount =
        AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
          minimumEmployerWithdrawalAmount,
          "minimumEmployerWithdrawalAmount"
        );
    }

    if (AdminPlatformSettingsService.isProvided(minimumProfessionalWithdrawalAmount)) {
      countrySetting.minimumProfessionalWithdrawalAmount =
        AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
          minimumProfessionalWithdrawalAmount,
          "minimumProfessionalWithdrawalAmount"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
    };
  }

  static async updateCountryProtectedShiftLimits({
    countryCode,
    facilityType,
    policyInput,
    updatedBy,
    session = null,
  }) {
    const normalizedFacilityType = AdminPlatformSettingsService.normalizeFacilityType(facilityType);

    const normalizedPolicy = AdminPlatformSettingsService.normalizeProtectedShiftFacilityPolicy(
      policyInput,
      normalizedFacilityType
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(settings, countryCode);

    countrySetting.set(`protectedShiftLimits.${normalizedFacilityType}`, normalizedPolicy);

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
      facilityType: normalizedFacilityType,
      policy: countrySetting.protectedShiftLimits[normalizedFacilityType],
    };
  }

  static async addCountrySetting({ countrySettingInput, updatedBy, session = null }) {
    if (
      !countrySettingInput ||
      typeof countrySettingInput !== "object" ||
      Array.isArray(countrySettingInput)
    ) {
      throw new Error("Country setting input is required.");
    }

    const countryCode = AdminPlatformSettingsService.normalizeCountryCode(
      countrySettingInput.countryCode
    );

    const currency = AdminPlatformSettingsService.normalizeCurrency(countrySettingInput.currency);

    const platformFeeRate = AdminPlatformSettingsService.normalizePlatformFeeRate(
      countrySettingInput.platformFeeRate
    );

    const maximumEmployerWalletExternalTopupBalance =
      AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
        countrySettingInput.maximumEmployerWalletExternalTopupBalance,
        "maximumEmployerWalletExternalTopupBalance"
      );

    const minimumEmployerWithdrawalAmount =
      AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
        countrySettingInput.minimumEmployerWithdrawalAmount,
        "minimumEmployerWithdrawalAmount"
      );

    const minimumProfessionalWithdrawalAmount =
      AdminPlatformSettingsService.normalizePositiveMinorUnitAmount(
        countrySettingInput.minimumProfessionalWithdrawalAmount,
        "minimumProfessionalWithdrawalAmount"
      );

    const protectedShiftLimits = AdminPlatformSettingsService.normalizeProtectedShiftLimits(
      countrySettingInput.protectedShiftLimits
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countryAlreadyExists = settings.countrySettings.some(
      (setting) => setting.countryCode === countryCode
    );

    if (countryAlreadyExists) {
      throw new Error(`A country setting already exists for ${countryCode}.`);
    }

    settings.countrySettings.push({
      countryCode,
      currency,
      platformFeeRate,

      maximumEmployerWalletExternalTopupBalance,

      minimumEmployerWithdrawalAmount,

      minimumProfessionalWithdrawalAmount,

      protectedShiftLimits,

      isActive: true,
    });

    AdminPlatformSettingsService.synchronizeActiveCountryRegistries(settings);

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    const addedCountrySetting = AdminPlatformSettingsService.findCountrySetting(
      settings,
      countryCode
    );

    return {
      settings,
      countrySetting: addedCountrySetting,
    };
  }

  static async activateCountrySetting({ countryCode, updatedBy, session = null }) {
    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(settings, countryCode);

    countrySetting.isActive = true;

    AdminPlatformSettingsService.synchronizeActiveCountryRegistries(settings);

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
    };
  }

  static async deactivateCountrySetting({ countryCode, updatedBy, session = null }) {
    const normalizedCountryCode = AdminPlatformSettingsService.normalizeCountryCode(countryCode);

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (normalizedCountryCode === settings.defaultCountryCode) {
      throw new Error(
        "The default country cannot be deactivated. Set another active country as default first."
      );
    }

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(
      settings,
      normalizedCountryCode
    );

    countrySetting.isActive = false;

    AdminPlatformSettingsService.synchronizeActiveCountryRegistries(settings);

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
    };
  }

  static async setDefaultCountry({ countryCode, updatedBy, session = null }) {
    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const countrySetting = AdminPlatformSettingsService.findCountrySetting(settings, countryCode);

    if (countrySetting.isActive !== true) {
      throw new Error("Only an active country setting can become the default country.");
    }

    settings.defaultCountryCode = countrySetting.countryCode;
    settings.defaultCurrency = countrySetting.currency;

    AdminPlatformSettingsService.synchronizeActiveCountryRegistries(settings);

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      countrySetting,
    };
  }

  /* ─────────────────────────────── SHIFT CANCELLATION POLICY ─────────────────────────────── */

  static async updateShiftCancellationPolicy({
    lateCancellationWindowMinutes,
    lateCancellationProfessionalPayRate,
    activeWorkCancellationMinimumPayRate,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        lateCancellationWindowMinutes,
        lateCancellationProfessionalPayRate,
        activeWorkCancellationMinimumPayRate,
      ],
      "At least one Shift cancellation policy setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (AdminPlatformSettingsService.isProvided(lateCancellationWindowMinutes)) {
      settings.shiftCancellationPolicy.lateCancellationWindowMinutes =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          lateCancellationWindowMinutes,
          "lateCancellationWindowMinutes"
        );
    }

    if (AdminPlatformSettingsService.isProvided(lateCancellationProfessionalPayRate)) {
      settings.shiftCancellationPolicy.lateCancellationProfessionalPayRate =
        AdminPlatformSettingsService.normalizeFinancialRate(
          lateCancellationProfessionalPayRate,
          "lateCancellationProfessionalPayRate"
        );
    }

    if (AdminPlatformSettingsService.isProvided(activeWorkCancellationMinimumPayRate)) {
      settings.shiftCancellationPolicy.activeWorkCancellationMinimumPayRate =
        AdminPlatformSettingsService.normalizeFinancialRate(
          activeWorkCancellationMinimumPayRate,
          "activeWorkCancellationMinimumPayRate"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,
      shiftCancellationPolicy: settings.shiftCancellationPolicy,
    };
  }

  /* ─────────────────────────────── ATTENDANCE / OCCURRENCE POLICY ─────────────────────────────── */

  static async updateAttendancePolicy({
    checkInWindowBeforeMinutes,
    noShowGraceMinutes,
    unfilledFinalizationGraceMinutes,
    singleOccurrenceReleaseNoticeHours,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        checkInWindowBeforeMinutes,
        noShowGraceMinutes,
        unfilledFinalizationGraceMinutes,
        singleOccurrenceReleaseNoticeHours,
      ],
      "At least one attendance or occurrence policy setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (AdminPlatformSettingsService.isProvided(checkInWindowBeforeMinutes)) {
      settings.checkInWindowBeforeMinutes =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          checkInWindowBeforeMinutes,
          "checkInWindowBeforeMinutes"
        );
    }

    if (AdminPlatformSettingsService.isProvided(noShowGraceMinutes)) {
      settings.noShowGraceMinutes = AdminPlatformSettingsService.normalizeNonNegativeInteger(
        noShowGraceMinutes,
        "noShowGraceMinutes"
      );
    }

    if (AdminPlatformSettingsService.isProvided(unfilledFinalizationGraceMinutes)) {
      settings.unfilledFinalizationGraceMinutes =
        AdminPlatformSettingsService.normalizePositiveInteger(
          unfilledFinalizationGraceMinutes,
          "unfilledFinalizationGraceMinutes"
        );
    }

    if (AdminPlatformSettingsService.isProvided(singleOccurrenceReleaseNoticeHours)) {
      settings.singleOccurrenceReleaseNoticeHours =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          singleOccurrenceReleaseNoticeHours,
          "singleOccurrenceReleaseNoticeHours"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,

      attendancePolicy: {
        checkInWindowBeforeMinutes: settings.checkInWindowBeforeMinutes,

        noShowGraceMinutes: settings.noShowGraceMinutes,

        unfilledFinalizationGraceMinutes: settings.unfilledFinalizationGraceMinutes,

        singleOccurrenceReleaseNoticeHours: settings.singleOccurrenceReleaseNoticeHours,
      },
    };
  }

  /* ─────────────────────────────── OCCURRENCE CHALLENGE POLICY ─────────────────────────────── */

  static async updateOccurrenceChallengePolicy({
    occurrenceClaimWindowHours,
    employerClaimResponseHours,
    professionalDisputeResponseHours,
    professionalAppealWindowHours,
    professionalRebuttalWindowHours,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        occurrenceClaimWindowHours,
        employerClaimResponseHours,
        professionalDisputeResponseHours,
        professionalAppealWindowHours,
        professionalRebuttalWindowHours,
      ],
      "At least one occurrence challenge policy setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (AdminPlatformSettingsService.isProvided(occurrenceClaimWindowHours)) {
      settings.occurrenceClaimWindowHours = AdminPlatformSettingsService.normalizePositiveInteger(
        occurrenceClaimWindowHours,
        "occurrenceClaimWindowHours"
      );
    }

    if (AdminPlatformSettingsService.isProvided(employerClaimResponseHours)) {
      settings.employerClaimResponseHours = AdminPlatformSettingsService.normalizePositiveInteger(
        employerClaimResponseHours,
        "employerClaimResponseHours"
      );
    }

    if (AdminPlatformSettingsService.isProvided(professionalRebuttalWindowHours)) {
      settings.professionalRebuttalWindowHours =
        AdminPlatformSettingsService.normalizePositiveInteger(
          professionalRebuttalWindowHours,
          "professionalRebuttalWindowHours"
        );
    }

    if (AdminPlatformSettingsService.isProvided(professionalDisputeResponseHours)) {
      settings.professionalDisputeResponseHours =
        AdminPlatformSettingsService.normalizePositiveInteger(
          professionalDisputeResponseHours,
          "professionalDisputeResponseHours"
        );
    }

    if (AdminPlatformSettingsService.isProvided(professionalAppealWindowHours)) {
      settings.professionalAppealWindowHours =
        AdminPlatformSettingsService.normalizePositiveInteger(
          professionalAppealWindowHours,
          "professionalAppealWindowHours"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,

      occurrenceChallengePolicy: {
        occurrenceClaimWindowHours: settings.occurrenceClaimWindowHours,

        employerClaimResponseHours: settings.employerClaimResponseHours,

        professionalDisputeResponseHours: settings.professionalDisputeResponseHours,

        professionalAppealWindowHours: settings.professionalAppealWindowHours,

        professionalRebuttalWindowHours: settings.professionalRebuttalWindowHours,
      },
    };
  }

  /* ─────────────────────────────── OVERTIME POLICY ─────────────────────────────── */

  static async updateOvertimePolicy({
    overtimeResponseHours,
    overtimeTopUpDeadlineHours,
    overtimeTopUpRestrictionGraceHours,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [overtimeResponseHours, overtimeTopUpDeadlineHours, overtimeTopUpRestrictionGraceHours],
      "At least one overtime policy setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (AdminPlatformSettingsService.isProvided(overtimeResponseHours)) {
      settings.overtimeResponseHours = AdminPlatformSettingsService.normalizePositiveInteger(
        overtimeResponseHours,
        "overtimeResponseHours"
      );
    }

    if (AdminPlatformSettingsService.isProvided(overtimeTopUpDeadlineHours)) {
      settings.overtimeTopUpDeadlineHours = AdminPlatformSettingsService.normalizePositiveInteger(
        overtimeTopUpDeadlineHours,
        "overtimeTopUpDeadlineHours"
      );
    }

    if (AdminPlatformSettingsService.isProvided(overtimeTopUpRestrictionGraceHours)) {
      settings.overtimeTopUpRestrictionGraceHours =
        AdminPlatformSettingsService.normalizePositiveInteger(
          overtimeTopUpRestrictionGraceHours,
          "overtimeTopUpRestrictionGraceHours"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,

      overtimePolicy: {
        overtimeResponseHours: settings.overtimeResponseHours,

        overtimeTopUpDeadlineHours: settings.overtimeTopUpDeadlineHours,

        overtimeTopUpRestrictionGraceHours: settings.overtimeTopUpRestrictionGraceHours,
      },
    };
  }

  /* ─────────────────────────────── PROFESSIONAL SETTLEMENT SCHEDULE ─────────────────────────────── */

  static async updateProfessionalSettlementSchedule({
    professionalSettlementPayoutWeekday,
    professionalSettlementPayoutHour,
    professionalSettlementPayoutMinute,
    professionalSettlementPayoutTimeZone,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        professionalSettlementPayoutWeekday,
        professionalSettlementPayoutHour,
        professionalSettlementPayoutMinute,
        professionalSettlementPayoutTimeZone,
      ],
      "At least one professional settlement schedule setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (AdminPlatformSettingsService.isProvided(professionalSettlementPayoutWeekday)) {
      const weekday = Number(professionalSettlementPayoutWeekday);

      if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new Error("professionalSettlementPayoutWeekday must be a whole number from 0 to 6.");
      }

      settings.professionalSettlementPayoutWeekday = weekday;
    }

    if (AdminPlatformSettingsService.isProvided(professionalSettlementPayoutHour)) {
      const hour = Number(professionalSettlementPayoutHour);

      if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
        throw new Error("professionalSettlementPayoutHour must be a whole number from 0 to 23.");
      }

      settings.professionalSettlementPayoutHour = hour;
    }

    if (AdminPlatformSettingsService.isProvided(professionalSettlementPayoutMinute)) {
      const minute = Number(professionalSettlementPayoutMinute);

      if (!Number.isSafeInteger(minute) || minute < 0 || minute > 59) {
        throw new Error("professionalSettlementPayoutMinute must be a whole number from 0 to 59.");
      }

      settings.professionalSettlementPayoutMinute = minute;
    }

    if (AdminPlatformSettingsService.isProvided(professionalSettlementPayoutTimeZone)) {
      settings.professionalSettlementPayoutTimeZone =
        AdminPlatformSettingsService.normalizeTimeZone(
          professionalSettlementPayoutTimeZone,
          "professionalSettlementPayoutTimeZone"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,

      professionalSettlementSchedule: {
        professionalSettlementPayoutWeekday: settings.professionalSettlementPayoutWeekday,

        professionalSettlementPayoutHour: settings.professionalSettlementPayoutHour,

        professionalSettlementPayoutMinute: settings.professionalSettlementPayoutMinute,

        professionalSettlementPayoutTimeZone: settings.professionalSettlementPayoutTimeZone,
      },
    };
  }

  /* ─────────────────────────────── LOCATION POLICY ─────────────────────────────── */

  static async updateLocationPolicy({
    defaultGeofenceRadiusMeters,
    minimumGeofenceRadiusMeters,
    maximumGeofenceRadiusMeters,
    maximumLocationAccuracyMeters,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        defaultGeofenceRadiusMeters,
        minimumGeofenceRadiusMeters,
        maximumGeofenceRadiusMeters,
        maximumLocationAccuracyMeters,
      ],
      "At least one location policy setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    const nextMinimum = AdminPlatformSettingsService.isProvided(minimumGeofenceRadiusMeters)
      ? AdminPlatformSettingsService.normalizePositiveInteger(
          minimumGeofenceRadiusMeters,
          "minimumGeofenceRadiusMeters"
        )
      : settings.minimumGeofenceRadiusMeters;

    const nextMaximum = AdminPlatformSettingsService.isProvided(maximumGeofenceRadiusMeters)
      ? AdminPlatformSettingsService.normalizePositiveInteger(
          maximumGeofenceRadiusMeters,
          "maximumGeofenceRadiusMeters"
        )
      : settings.maximumGeofenceRadiusMeters;

    const nextDefault = AdminPlatformSettingsService.isProvided(defaultGeofenceRadiusMeters)
      ? AdminPlatformSettingsService.normalizePositiveInteger(
          defaultGeofenceRadiusMeters,
          "defaultGeofenceRadiusMeters"
        )
      : settings.defaultGeofenceRadiusMeters;

    if (nextMinimum > nextMaximum) {
      throw new Error("minimumGeofenceRadiusMeters cannot exceed maximumGeofenceRadiusMeters.");
    }

    if (nextDefault < nextMinimum || nextDefault > nextMaximum) {
      throw new Error(
        "defaultGeofenceRadiusMeters must be within the configured minimum and maximum geofence radii."
      );
    }

    settings.minimumGeofenceRadiusMeters = nextMinimum;

    settings.maximumGeofenceRadiusMeters = nextMaximum;

    settings.defaultGeofenceRadiusMeters = nextDefault;

    if (AdminPlatformSettingsService.isProvided(maximumLocationAccuracyMeters)) {
      settings.maximumLocationAccuracyMeters =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          maximumLocationAccuracyMeters,
          "maximumLocationAccuracyMeters"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,

      locationPolicy: {
        defaultGeofenceRadiusMeters: settings.defaultGeofenceRadiusMeters,

        minimumGeofenceRadiusMeters: settings.minimumGeofenceRadiusMeters,

        maximumGeofenceRadiusMeters: settings.maximumGeofenceRadiusMeters,

        maximumLocationAccuracyMeters: settings.maximumLocationAccuracyMeters,
      },
    };
  }

  /* ─────────────────────────────── CREDITS POLICY ─────────────────────────────── */

  static async updateCreditsPolicy({
    creditsEnabled,
    freeMonthlyCredits,
    normalApplicationCreditCost,
    urgentApplicationCreditCost,
    boostApplicationCreditCost,
    updatedBy,
    session = null,
  }) {
    AdminPlatformSettingsService.assertAtLeastOneProvided(
      [
        creditsEnabled,
        freeMonthlyCredits,
        normalApplicationCreditCost,
        urgentApplicationCreditCost,
        boostApplicationCreditCost,
      ],
      "At least one credits policy setting must be provided."
    );

    const settings = await AdminPlatformSettingsService.getActivePlatformSettings({
      session,
    });

    if (AdminPlatformSettingsService.isProvided(creditsEnabled)) {
      settings.creditsEnabled = AdminPlatformSettingsService.normalizeBoolean(
        creditsEnabled,
        "creditsEnabled"
      );
    }

    if (AdminPlatformSettingsService.isProvided(freeMonthlyCredits)) {
      settings.freeMonthlyCredits = AdminPlatformSettingsService.normalizeNonNegativeInteger(
        freeMonthlyCredits,
        "freeMonthlyCredits"
      );
    }

    if (AdminPlatformSettingsService.isProvided(normalApplicationCreditCost)) {
      settings.normalApplicationCreditCost =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          normalApplicationCreditCost,
          "normalApplicationCreditCost"
        );
    }

    if (AdminPlatformSettingsService.isProvided(urgentApplicationCreditCost)) {
      settings.urgentApplicationCreditCost =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          urgentApplicationCreditCost,
          "urgentApplicationCreditCost"
        );
    }

    if (AdminPlatformSettingsService.isProvided(boostApplicationCreditCost)) {
      settings.boostApplicationCreditCost =
        AdminPlatformSettingsService.normalizeNonNegativeInteger(
          boostApplicationCreditCost,
          "boostApplicationCreditCost"
        );
    }

    await AdminPlatformSettingsService.saveSettings(settings, updatedBy, session);

    return {
      settings,

      creditsPolicy: {
        creditsEnabled: settings.creditsEnabled,

        freeMonthlyCredits: settings.freeMonthlyCredits,

        normalApplicationCreditCost: settings.normalApplicationCreditCost,

        urgentApplicationCreditCost: settings.urgentApplicationCreditCost,

        boostApplicationCreditCost: settings.boostApplicationCreditCost,
      },
    };
  }
}

module.exports = AdminPlatformSettingsService;
