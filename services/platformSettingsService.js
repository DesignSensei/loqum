// services/platformSettingsService.js

const PlatformSettings = require("../models/PlatformSettings");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");
const logger = require("../utils/logger");

class PlatformSettingsService {
  /* ─────────────────────────────── ERRORS ─────────────────────────────── */

  static createSettingsError({ message, code, statusCode = 500 }) {
    const error = new Error(message);

    error.name = "PlatformSettingsError";
    error.code = code;
    error.statusCode = statusCode;

    return error;
  }

  /* ─────────────────────────────── BASIC VALIDATION ─────────────────────────────── */

  static normalizeCountryCode(countryCode) {
    if (countryCode === null || countryCode === undefined || countryCode === "") {
      return null;
    }

    const normalizedCountryCode = String(countryCode).trim().toUpperCase();

    if (!/^[A-Z]{2}$/.test(normalizedCountryCode)) {
      throw this.createSettingsError({
        message: "A valid two-letter country code is required.",
        code: "INVALID_COUNTRY_CODE",
        statusCode: 400,
      });
    }

    return normalizedCountryCode;
  }

  static assertCurrency(currency) {
    const normalizedCurrency = String(currency || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw this.createSettingsError({
        message: "The configured currency is invalid.",
        code: "INVALID_CURRENCY",
      });
    }

    return normalizedCurrency;
  }

  static assertRate(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw this.createSettingsError({
        message: `${fieldName} must be a number between 0 and 1.`,
        code: "INVALID_RATE_SETTING",
      });
    }

    try {
      money.scaleRate({
        rate: value,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName,
      });
    } catch (error) {
      throw this.createSettingsError({
        message: `${fieldName} must use the supported financial rate precision.`,
        code: "INVALID_RATE_SETTING",
      });
    }

    return value;
  }

  static assertPlatformFeeRate(platformFeeRate) {
    if (
      typeof platformFeeRate !== "number" ||
      !Number.isFinite(platformFeeRate) ||
      platformFeeRate < 0 ||
      platformFeeRate > 1
    ) {
      throw this.createSettingsError({
        message: "The configured platform fee rate is invalid.",
        code: "INVALID_PLATFORM_FEE_RATE",
      });
    }

    try {
      money.scaleRate({
        rate: platformFeeRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "platformFeeRate",
      });
    } catch (error) {
      throw this.createSettingsError({
        message: "The configured platform fee rate uses unsupported financial precision.",
        code: "INVALID_PLATFORM_FEE_RATE",
      });
    }

    return platformFeeRate;
  }

  static assertPositiveMinorUnitAmount(amount, fieldName) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw this.createSettingsError({
        message: `${fieldName} must be a positive whole number in minor units.`,
        code: "INVALID_FINANCIAL_SETTING",
      });
    }

    return amount;
  }

  static assertNonNegativeInteger(value, fieldName) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw this.createSettingsError({
        message: `${fieldName} must be a non-negative whole number.`,
        code: "INVALID_PLATFORM_SETTING",
      });
    }

    return value;
  }

  static assertPositiveInteger(value, fieldName) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw this.createSettingsError({
        message: `${fieldName} must be a positive whole number.`,
        code: "INVALID_PLATFORM_SETTING",
      });
    }

    return value;
  }

  /* ─────────────────────────────── ACTIVE SETTINGS ─────────────────────────────── */

  static async getActiveSettings() {
    const settings = await PlatformSettings.findOne({
      key: "global",
      isActive: true,
    }).lean();

    if (!settings) {
      throw this.createSettingsError({
        message: "Active global platform settings have not been configured.",
        code: "PLATFORM_SETTINGS_NOT_FOUND",
      });
    }

    return settings;
  }

  /* ─────────────────────────────── COUNTRY SETTINGS ─────────────────────────────── */

  static resolveCountrySettings(settings, requestedCountryCode) {
    const defaultCountryCode = this.normalizeCountryCode(settings.defaultCountryCode);

    if (!defaultCountryCode) {
      throw this.createSettingsError({
        message: "The default platform country has not been configured.",
        code: "DEFAULT_COUNTRY_NOT_CONFIGURED",
      });
    }

    const countryCode = this.normalizeCountryCode(requestedCountryCode) || defaultCountryCode;

    const activeCountryCodes = Array.isArray(settings.activeCountryCodes)
      ? settings.activeCountryCodes
          .map((code) =>
            String(code || "")
              .trim()
              .toUpperCase()
          )
          .filter(Boolean)
      : [];

    if (!activeCountryCodes.includes(countryCode)) {
      throw this.createSettingsError({
        message: `Loqum is not currently active in ${countryCode}.`,
        code: "COUNTRY_NOT_ACTIVE",
        statusCode: 400,
      });
    }

    const countrySettings = Array.isArray(settings.countrySettings) ? settings.countrySettings : [];

    const matchingCountrySetting = countrySettings.find(
      (countrySetting) =>
        String(countrySetting.countryCode || "")
          .trim()
          .toUpperCase() === countryCode && countrySetting.isActive === true
    );

    if (matchingCountrySetting) {
      return {
        countryCode,

        currency: this.assertCurrency(matchingCountrySetting.currency),

        platformFeeRate: this.assertPlatformFeeRate(matchingCountrySetting.platformFeeRate),

        maximumEmployerWalletExternalTopupBalance: this.assertPositiveMinorUnitAmount(
          matchingCountrySetting.maximumEmployerWalletExternalTopupBalance,
          "maximumEmployerWalletExternalTopupBalance"
        ),

        minimumEmployerWithdrawalAmount: this.assertPositiveMinorUnitAmount(
          matchingCountrySetting.minimumEmployerWithdrawalAmount,
          "minimumEmployerWithdrawalAmount"
        ),

        minimumProfessionalWithdrawalAmount: this.assertPositiveMinorUnitAmount(
          matchingCountrySetting.minimumProfessionalWithdrawalAmount,
          "minimumProfessionalWithdrawalAmount"
        ),
      };
    }

    if (countryCode !== defaultCountryCode) {
      throw this.createSettingsError({
        message: `Active country settings have not been configured for ${countryCode}.`,
        code: "COUNTRY_SETTINGS_NOT_FOUND",
      });
    }

    return {
      countryCode,

      currency: this.assertCurrency(settings.defaultCurrency),

      platformFeeRate: this.assertPlatformFeeRate(settings.platformFeeRate),

      maximumEmployerWalletExternalTopupBalance: this.assertPositiveMinorUnitAmount(
        settings.maximumEmployerWalletExternalTopupBalance,
        "maximumEmployerWalletExternalTopupBalance"
      ),

      minimumEmployerWithdrawalAmount: this.assertPositiveMinorUnitAmount(
        settings.minimumEmployerWithdrawalAmount,
        "minimumEmployerWithdrawalAmount"
      ),

      minimumProfessionalWithdrawalAmount: this.assertPositiveMinorUnitAmount(
        settings.minimumProfessionalWithdrawalAmount,
        "minimumProfessionalWithdrawalAmount"
      ),
    };
  }

  /* ─────────────────────────────── ATTENDANCE SETTINGS ─────────────────────────────── */

  static buildAttendanceSettings(settings) {
    const overtimeResponseHours = settings.overtimeResponseHours ?? 24;

    const checkInWindowBeforeMinutes = settings.checkInWindowBeforeMinutes ?? 30;

    const noShowGraceMinutes = settings.noShowGraceMinutes ?? 30;

    const unfilledFinalizationGraceMinutes = settings.unfilledFinalizationGraceMinutes ?? 15;

    const defaultGeofenceRadiusMeters = settings.defaultGeofenceRadiusMeters ?? 100;

    const minimumGeofenceRadiusMeters = settings.minimumGeofenceRadiusMeters ?? 20;

    const maximumGeofenceRadiusMeters = settings.maximumGeofenceRadiusMeters ?? 1000;

    const maximumLocationAccuracyMeters = settings.maximumLocationAccuracyMeters ?? 100;

    const attendanceSettings = {
      overtimeResponseHours: this.assertPositiveInteger(
        overtimeResponseHours,
        "overtimeResponseHours"
      ),

      checkInWindowBeforeMinutes: this.assertNonNegativeInteger(
        checkInWindowBeforeMinutes,
        "checkInWindowBeforeMinutes"
      ),

      noShowGraceMinutes: this.assertNonNegativeInteger(noShowGraceMinutes, "noShowGraceMinutes"),

      /*
       * ShiftOccurrence requires unfilledFinalizationAt to be strictly later
       * than fillCutoffAt, so zero is not a valid runtime configuration.
       */
      unfilledFinalizationGraceMinutes: this.assertPositiveInteger(
        unfilledFinalizationGraceMinutes,
        "unfilledFinalizationGraceMinutes"
      ),

      defaultGeofenceRadiusMeters: this.assertPositiveInteger(
        defaultGeofenceRadiusMeters,
        "defaultGeofenceRadiusMeters"
      ),

      minimumGeofenceRadiusMeters: this.assertPositiveInteger(
        minimumGeofenceRadiusMeters,
        "minimumGeofenceRadiusMeters"
      ),

      maximumGeofenceRadiusMeters: this.assertPositiveInteger(
        maximumGeofenceRadiusMeters,
        "maximumGeofenceRadiusMeters"
      ),

      maximumLocationAccuracyMeters: this.assertNonNegativeInteger(
        maximumLocationAccuracyMeters,
        "maximumLocationAccuracyMeters"
      ),
    };

    if (
      attendanceSettings.minimumGeofenceRadiusMeters >
      attendanceSettings.maximumGeofenceRadiusMeters
    ) {
      throw this.createSettingsError({
        message: "The minimum geofence radius cannot exceed the maximum geofence radius.",
        code: "INVALID_GEOFENCE_CONFIGURATION",
      });
    }

    if (
      attendanceSettings.defaultGeofenceRadiusMeters <
        attendanceSettings.minimumGeofenceRadiusMeters ||
      attendanceSettings.defaultGeofenceRadiusMeters >
        attendanceSettings.maximumGeofenceRadiusMeters
    ) {
      throw this.createSettingsError({
        message:
          "The default geofence radius must be within the configured minimum and maximum radii.",
        code: "INVALID_GEOFENCE_CONFIGURATION",
      });
    }

    return attendanceSettings;
  }

  /* ─────────────────────────────── CANCELLATION POLICY ─────────────────────────────── */

  static buildShiftCancellationPolicy(settings) {
    const configuredPolicy =
      settings.shiftCancellationPolicy && typeof settings.shiftCancellationPolicy === "object"
        ? settings.shiftCancellationPolicy
        : {};

    const lateCancellationWindowMinutes = configuredPolicy.lateCancellationWindowMinutes ?? 30;

    const lateCancellationProfessionalPayRate =
      configuredPolicy.lateCancellationProfessionalPayRate ?? 0.25;

    const activeWorkCancellationMinimumPayRate =
      configuredPolicy.activeWorkCancellationMinimumPayRate ?? 0.25;

    return {
      lateCancellationWindowMinutes: this.assertNonNegativeInteger(
        lateCancellationWindowMinutes,
        "lateCancellationWindowMinutes"
      ),

      lateCancellationProfessionalPayRate: this.assertRate(
        lateCancellationProfessionalPayRate,
        "lateCancellationProfessionalPayRate"
      ),

      activeWorkCancellationMinimumPayRate: this.assertRate(
        activeWorkCancellationMinimumPayRate,
        "activeWorkCancellationMinimumPayRate"
      ),
    };
  }

  /* ─────────────────────────────── PUBLIC GETTERS ─────────────────────────────── */

  static async getCountrySettings(countryCode) {
    const settings = await this.getActiveSettings();

    return this.resolveCountrySettings(settings, countryCode);
  }

  static async getShiftPricingSettings(countryCode) {
    const countrySettings = await this.getCountrySettings(countryCode);

    return {
      countryCode: countrySettings.countryCode,

      currency: countrySettings.currency,

      platformFeeRate: countrySettings.platformFeeRate,
    };
  }

  static async getAttendanceSettings() {
    const settings = await this.getActiveSettings();

    return this.buildAttendanceSettings(settings);
  }

  static async getShiftCancellationPolicy() {
    const settings = await this.getActiveSettings();

    return this.buildShiftCancellationPolicy(settings);
  }

  static async getShiftPostingSettings(countryCode) {
    const settings = await this.getActiveSettings();

    const countrySettings = this.resolveCountrySettings(settings, countryCode);

    const shiftPostingSettings = {
      pricing: {
        countryCode: countrySettings.countryCode,

        currency: countrySettings.currency,

        platformFeeRate: countrySettings.platformFeeRate,
      },

      attendance: this.buildAttendanceSettings(settings),

      cancellationPolicy: this.buildShiftCancellationPolicy(settings),
    };

    logger.info(`Shift posting settings resolved for country: ${countrySettings.countryCode}`);

    return shiftPostingSettings;
  }
}

module.exports = PlatformSettingsService;
