// controllers/adminPlatformSettingsController.js

const AdminPlatformSettingsService = require("../services/adminPlatformSettingsService");

const logger = require("../utils/logger");

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function createControllerError({ message, code, statusCode = 400, details = null }) {
  const error = new Error(message);

  error.name = "AdminPlatformSettingsControllerError";
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;

  return error;
}

function normalizeServiceError(error) {
  if (!error || error.name !== "Error" || error.statusCode) {
    return error;
  }

  if (error.message === "Active platform settings could not be found.") {
    return createControllerError({
      message: error.message,
      code: "PLATFORM_SETTINGS_UNAVAILABLE",
      statusCode: 500,
    });
  }

  return createControllerError({
    message: error.message || "Platform settings request could not be completed.",
    code: "ADMIN_PLATFORM_SETTINGS_REQUEST_INVALID",
    statusCode: 400,
  });
}

function isOperationalError(error) {
  return error?.name === "AdminPlatformSettingsControllerError";
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const normalizedError = normalizeServiceError(error);
  const operationalError = isOperationalError(normalizedError);

  const candidateStatusCode = Number(normalizedError?.statusCode);

  const statusCode =
    operationalError &&
    Number.isInteger(candidateStatusCode) &&
    candidateStatusCode >= 400 &&
    candidateStatusCode <= 599
      ? candidateStatusCode
      : operationalError
        ? 400
        : 500;

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, normalizedError);
  } else {
    logger.warn(
      `${logContext} rejected: ` +
        `${normalizedError.code || "UNKNOWN"} - ` +
        `${normalizedError.message}`
    );
  }

  const response = {
    success: false,
    message: operationalError ? normalizedError.message : fallbackMessage,
    code: operationalError ? normalizedError.code || fallbackCode : fallbackCode,
  };

  if (operationalError && normalizedError.details && typeof normalizedError.details === "object") {
    response.details = normalizedError.details;
  }

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

function getAdminUserId(req) {
  const adminUserId = req.user?._id;

  if (!adminUserId) {
    throw createControllerError({
      message: "Administrator user context is unavailable.",
      code: "ADMIN_USER_CONTEXT_REQUIRED",
      statusCode: 500,
    });
  }

  return adminUserId;
}

function sendJsonSuccess(res, data, statusCode = 200) {
  setNoStoreHeaders(res);

  return res.status(statusCode).json({
    success: true,
    data,
  });
}

/* ─────────────────────────────── SETTINGS READ ─────────────────────────────── */

exports.getPlatformSettings = async (req, res) => {
  try {
    const settings = await AdminPlatformSettingsService.getActivePlatformSettings();

    return sendJsonSuccess(res, {
      settings,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin platform settings read",
      fallbackMessage: "Platform settings could not be loaded.",
      fallbackCode: "ADMIN_PLATFORM_SETTINGS_READ_FAILED",
    });
  }
};

/* ─────────────────────────────── COUNTRY MANAGEMENT ─────────────────────────────── */

exports.updateCountryPlatformFee = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateCountryPlatformFee({
      countryCode: req.params.countryCode,
      platformFeeRate: req.body?.platformFeeRate,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country platform fee update",
      fallbackMessage: "Country platform fee could not be updated.",
      fallbackCode: "ADMIN_COUNTRY_PLATFORM_FEE_UPDATE_FAILED",
    });
  }
};

exports.updateCountryCurrency = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateCountryCurrency({
      countryCode: req.params.countryCode,
      currency: req.body?.currency,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country currency update",
      fallbackMessage: "Country currency could not be updated.",
      fallbackCode: "ADMIN_COUNTRY_CURRENCY_UPDATE_FAILED",
    });
  }
};

exports.updateCountryFinancialLimits = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateCountryFinancialLimits({
      countryCode: req.params.countryCode,
      maximumEmployerWalletExternalTopupBalance:
        req.body?.maximumEmployerWalletExternalTopupBalance,
      minimumEmployerWithdrawalAmount: req.body?.minimumEmployerWithdrawalAmount,
      minimumProfessionalWithdrawalAmount: req.body?.minimumProfessionalWithdrawalAmount,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country financial limits update",
      fallbackMessage: "Country financial limits could not be updated.",
      fallbackCode: "ADMIN_COUNTRY_FINANCIAL_LIMITS_UPDATE_FAILED",
    });
  }
};

exports.updateCountryProtectedShiftLimits = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateCountryProtectedShiftLimits({
      countryCode: req.params.countryCode,
      facilityType: req.params.facilityType,
      policyInput: req.body,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
      facilityType: result.facilityType,
      policy: result.policy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country Protected Shift limits update",
      fallbackMessage: "Country Protected Shift limits could not be updated.",
      fallbackCode: "ADMIN_COUNTRY_PROTECTED_SHIFT_LIMITS_UPDATE_FAILED",
    });
  }
};

exports.addCountrySetting = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.addCountrySetting({
      countrySettingInput: req.body,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(
      res,
      {
        countrySetting: result.countrySetting,
      },
      201
    );
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country setting creation",
      fallbackMessage: "Country setting could not be created.",
      fallbackCode: "ADMIN_COUNTRY_SETTING_CREATE_FAILED",
    });
  }
};

exports.activateCountrySetting = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.activateCountrySetting({
      countryCode: req.params.countryCode,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country setting activation",
      fallbackMessage: "Country setting could not be activated.",
      fallbackCode: "ADMIN_COUNTRY_SETTING_ACTIVATION_FAILED",
    });
  }
};

exports.deactivateCountrySetting = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.deactivateCountrySetting({
      countryCode: req.params.countryCode,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin country setting deactivation",
      fallbackMessage: "Country setting could not be deactivated.",
      fallbackCode: "ADMIN_COUNTRY_SETTING_DEACTIVATION_FAILED",
    });
  }
};

exports.setDefaultCountry = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.setDefaultCountry({
      countryCode: req.params.countryCode,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      countrySetting: result.countrySetting,
      defaultCountryCode: result.settings.defaultCountryCode,
      defaultCurrency: result.settings.defaultCurrency,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin default country update",
      fallbackMessage: "Default country could not be updated.",
      fallbackCode: "ADMIN_DEFAULT_COUNTRY_UPDATE_FAILED",
    });
  }
};

/* ─────────────────────────────── SHIFT POLICY ─────────────────────────────── */

exports.updateShiftCancellationPolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateShiftCancellationPolicy({
      lateCancellationWindowMinutes: req.body?.lateCancellationWindowMinutes,
      lateCancellationProfessionalPayRate: req.body?.lateCancellationProfessionalPayRate,
      activeWorkCancellationMinimumPayRate: req.body?.activeWorkCancellationMinimumPayRate,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      shiftCancellationPolicy: result.shiftCancellationPolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Shift cancellation policy update",
      fallbackMessage: "Shift cancellation policy could not be updated.",
      fallbackCode: "ADMIN_SHIFT_CANCELLATION_POLICY_UPDATE_FAILED",
    });
  }
};

exports.updateAttendancePolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateAttendancePolicy({
      checkInWindowBeforeMinutes: req.body?.checkInWindowBeforeMinutes,
      noShowGraceMinutes: req.body?.noShowGraceMinutes,
      unfilledFinalizationGraceMinutes: req.body?.unfilledFinalizationGraceMinutes,
      singleOccurrenceReleaseNoticeHours: req.body?.singleOccurrenceReleaseNoticeHours,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      attendancePolicy: result.attendancePolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin attendance policy update",
      fallbackMessage: "Attendance policy could not be updated.",
      fallbackCode: "ADMIN_ATTENDANCE_POLICY_UPDATE_FAILED",
    });
  }
};

exports.updateOccurrenceChallengePolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateOccurrenceChallengePolicy({
      occurrenceClaimWindowHours: req.body?.occurrenceClaimWindowHours,
      employerClaimResponseHours: req.body?.employerClaimResponseHours,
      professionalDisputeResponseHours: req.body?.professionalDisputeResponseHours,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      occurrenceChallengePolicy: result.occurrenceChallengePolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin occurrence challenge policy update",
      fallbackMessage: "Occurrence challenge policy could not be updated.",
      fallbackCode: "ADMIN_OCCURRENCE_CHALLENGE_POLICY_UPDATE_FAILED",
    });
  }
};

exports.updateOvertimePolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateOvertimePolicy({
      overtimeResponseHours: req.body?.overtimeResponseHours,
      overtimeTopUpDeadlineHours: req.body?.overtimeTopUpDeadlineHours,
      overtimeTopUpRestrictionGraceHours: req.body?.overtimeTopUpRestrictionGraceHours,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      overtimePolicy: result.overtimePolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin overtime policy update",
      fallbackMessage: "Overtime policy could not be updated.",
      fallbackCode: "ADMIN_OVERTIME_POLICY_UPDATE_FAILED",
    });
  }
};

exports.updateProfessionalSettlementSchedule = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateProfessionalSettlementSchedule({
      professionalSettlementPayoutWeekday: req.body?.professionalSettlementPayoutWeekday,
      professionalSettlementPayoutHour: req.body?.professionalSettlementPayoutHour,
      professionalSettlementPayoutMinute: req.body?.professionalSettlementPayoutMinute,
      professionalSettlementPayoutTimeZone: req.body?.professionalSettlementPayoutTimeZone,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      professionalSettlementSchedule: result.professionalSettlementSchedule,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin professional settlement schedule update",
      fallbackMessage: "Professional settlement schedule could not be updated.",
      fallbackCode: "ADMIN_PROFESSIONAL_SETTLEMENT_SCHEDULE_UPDATE_FAILED",
    });
  }
};

exports.updateLocationPolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateLocationPolicy({
      defaultGeofenceRadiusMeters: req.body?.defaultGeofenceRadiusMeters,
      minimumGeofenceRadiusMeters: req.body?.minimumGeofenceRadiusMeters,
      maximumGeofenceRadiusMeters: req.body?.maximumGeofenceRadiusMeters,
      maximumLocationAccuracyMeters: req.body?.maximumLocationAccuracyMeters,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      locationPolicy: result.locationPolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin location policy update",
      fallbackMessage: "Location policy could not be updated.",
      fallbackCode: "ADMIN_LOCATION_POLICY_UPDATE_FAILED",
    });
  }
};

/* ─────────────────────────────── JOB BOARD POLICY ─────────────────────────────── */

exports.updateJobBoardPolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateJobBoardPolicy({
      isEnabled: req.body?.isEnabled,
      publicationEnabled: req.body?.publicationEnabled,
      publicationMode: req.body?.publicationMode,
      freeJobPostsPerMonth: req.body?.freeJobPostsPerMonth,
      freeJobPostRolloverEnabled: req.body?.freeJobPostRolloverEnabled,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      jobBoardPolicy: result.jobBoardPolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job Board policy update",
      fallbackMessage: "Job Board policy could not be updated.",
      fallbackCode: "ADMIN_JOB_BOARD_POLICY_UPDATE_FAILED",
    });
  }
};

/* ─────────────────────────────── CREDITS POLICY ─────────────────────────────── */

exports.updateCreditsPolicy = async (req, res) => {
  try {
    const result = await AdminPlatformSettingsService.updateCreditsPolicy({
      creditsEnabled: req.body?.creditsEnabled,
      freeMonthlyCredits: req.body?.freeMonthlyCredits,
      normalApplicationCreditCost: req.body?.normalApplicationCreditCost,
      urgentApplicationCreditCost: req.body?.urgentApplicationCreditCost,
      boostApplicationCreditCost: req.body?.boostApplicationCreditCost,
      updatedBy: getAdminUserId(req),
    });

    return sendJsonSuccess(res, {
      creditsPolicy: result.creditsPolicy,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin credits policy update",
      fallbackMessage: "Credits policy could not be updated.",
      fallbackCode: "ADMIN_CREDITS_POLICY_UPDATE_FAILED",
    });
  }
};
