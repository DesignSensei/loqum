// services/platformSettingsService.js

const PlatformSettings = require("../models/PlatformSettings");
const logger = require("../utils/logger");

class PlatformSettingsService {
  static createSettingsError({ message, code, statusCode = 500 }) {
    const error = new Error(message);

    error.name = "PlatformSettingsError";
    error.code = code;
    error.statusCode = statusCode;

    return error;
  }

  static normalizeCountryCode(countryCode) {
    if (countryCode === null || countryCode === undefined) {
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

    return platformFeeRate;
  }

  static assertMinorUnitAmount(amount, fieldName) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw this.createSettingsError({
        message: `${fieldName} must be a non-negative whole number in minor units.`,
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

  /**
   * Returns the active global PlatformSettings document.
   *
   * No in-memory cache is used yet so changes to platform settings take
   * effect immediately for newly posted shifts and other new operations.
   */
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

  /**
   * Resolves the applicable country setting from an already loaded global
   * settings document.
   *
   * An active countrySettings entry is the preferred source.
   * The global financial fields are fallback values for the default country.
   */
  static resolveCountrySettings(settings, requestedCountryCode) {
    const defaultCountryCode = this.normalizeCountryCode(settings.defaultCountryCode);

    const countryCode = this.normalizeCountryCode(requestedCountryCode) || defaultCountryCode;

    const activeCountryCodes = Array.isArray(settings.activeCountryCodes)
      ? settings.activeCountryCodes.map((code) => String(code).trim().toUpperCase())
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

        maximumEmployerWalletBalance: this.assertMinorUnitAmount(
          matchingCountrySetting.maximumEmployerWalletBalance,
          "maximumEmployerWalletBalance"
        ),

        minimumEmployerWithdrawalAmount: this.assertMinorUnitAmount(
          matchingCountrySetting.minimumEmployerWithdrawalAmount,
          "minimumEmployerWithdrawalAmount"
        ),

        minimumProfessionalWithdrawalAmount: this.assertMinorUnitAmount(
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

      maximumEmployerWalletBalance: this.assertMinorUnitAmount(
        settings.maximumEmployerWalletBalance,
        "maximumEmployerWalletBalance"
      ),

      minimumEmployerWithdrawalAmount: this.assertMinorUnitAmount(
        settings.minimumEmployerWithdrawalAmount,
        "minimumEmployerWithdrawalAmount"
      ),

      minimumProfessionalWithdrawalAmount: this.assertMinorUnitAmount(
        settings.minimumProfessionalWithdrawalAmount,
        "minimumProfessionalWithdrawalAmount"
      ),
    };
  }

  /**
   * Builds the attendance configuration from the active platform settings.
   */
  static buildAttendanceSettings(settings) {
    /*
     * This fallback supports settings documents created before
     * checkInPinRevealBeforeMinutes was added.
     */
    const checkInPinRevealBeforeMinutes =
      settings.checkInPinRevealBeforeMinutes ?? settings.checkInWindowBeforeMinutes;

    const attendanceSettings = {
      checkInWindowBeforeMinutes: this.assertNonNegativeInteger(
        settings.checkInWindowBeforeMinutes,
        "checkInWindowBeforeMinutes"
      ),

      checkInPinRevealBeforeMinutes: this.assertNonNegativeInteger(
        checkInPinRevealBeforeMinutes,
        "checkInPinRevealBeforeMinutes"
      ),

      noShowGraceMinutes: this.assertNonNegativeInteger(
        settings.noShowGraceMinutes,
        "noShowGraceMinutes"
      ),

      defaultGeofenceRadiusMeters: this.assertNonNegativeInteger(
        settings.defaultGeofenceRadiusMeters,
        "defaultGeofenceRadiusMeters"
      ),

      minimumGeofenceRadiusMeters: this.assertNonNegativeInteger(
        settings.minimumGeofenceRadiusMeters,
        "minimumGeofenceRadiusMeters"
      ),

      maximumGeofenceRadiusMeters: this.assertNonNegativeInteger(
        settings.maximumGeofenceRadiusMeters,
        "maximumGeofenceRadiusMeters"
      ),

      maximumLocationAccuracyMeters: this.assertNonNegativeInteger(
        settings.maximumLocationAccuracyMeters,
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

  /**
   * Returns the resolved financial configuration for a country.
   */
  static async getCountrySettings(countryCode) {
    const settings = await this.getActiveSettings();

    return this.resolveCountrySettings(settings, countryCode);
  }

  /**
   * Returns only the pricing data needed when a shift is posted.
   */
  static async getShiftPricingSettings(countryCode) {
    const countrySettings = await this.getCountrySettings(countryCode);

    return {
      countryCode: countrySettings.countryCode,
      currency: countrySettings.currency,
      platformFeeRate: countrySettings.platformFeeRate,
    };
  }

  /**
   * Returns the attendance rules used for PIN visibility, check-in,
   * no-show handling and geofencing.
   */
  static async getAttendanceSettings() {
    const settings = await this.getActiveSettings();

    return this.buildAttendanceSettings(settings);
  }

  /**
   * Returns the settings needed to post a shift.
   *
   * Pricing and attendance settings are resolved through one database query.
   */
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
    };

    logger.info(`Shift posting settings resolved for country: ${countrySettings.countryCode}`);

    return shiftPostingSettings;
  }
}

module.exports = PlatformSettingsService;
