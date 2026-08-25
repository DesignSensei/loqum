// controllers/employerShiftAttendanceController.js

const ShiftAttendanceService = require("../services/shiftAttendanceService");

const logger = require("../utils/logger");

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setSensitiveResponseHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function isOperationalServiceError(error) {
  return ["ShiftAttendanceServiceError", "EmployerShiftAttendanceControllerError"].includes(
    error?.name
  );
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operationalError = isOperationalServiceError(error);

  const requestedStatusCode = Number(error?.statusCode);

  const statusCode = operationalError
    ? Number.isInteger(requestedStatusCode) &&
      requestedStatusCode >= 400 &&
      requestedStatusCode <= 599
      ? requestedStatusCode
      : 400
    : 500;

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ` + `${error.code || "UNKNOWN"} - ` + `${error.message}`);
  }

  const response = {
    success: false,

    message: operationalError ? error.message : fallbackMessage,

    code: operationalError ? error.code || fallbackCode : fallbackCode,
  };

  if (operationalError && error.details && typeof error.details === "object") {
    response.details = error.details;
  }

  setSensitiveResponseHeaders(res);

  return res.status(statusCode).json(response);
}

/* ─────────────────────────────── REQUEST CONTEXT ─────────────────────────────── */

function getEmployerAttendanceContext(req) {
  const employerProfileId = req.employerProfile?._id;

  if (!employerProfileId) {
    const error = new Error("Employer profile context is unavailable.");

    error.name = "EmployerShiftAttendanceControllerError";

    error.code = "EMPLOYER_PROFILE_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return {
    shiftId: req.params.shiftId,

    occurrenceId: req.params.occurrenceId || null,

    employerProfileId,

    employerContext: req.employerContext || null,
  };
}

/* ─────────────────────────────── CHECK-IN PIN ─────────────────────────────── */

/**
 * Returns the check-in PIN for one exact ShiftOccurrence.
 *
 * occurrenceId may be omitted only for a single-date Shift. In that case the
 * attendance service resolves occurrence sequence 1.
 *
 * Employer access and branch scope are enforced by ShiftAttendanceService.
 * PIN access is not controlled by a time-based reveal window.
 */
exports.getCheckInPin = async (req, res) => {
  try {
    const result = await ShiftAttendanceService.getEmployerCheckInPin(
      getEmployerAttendanceContext(req)
    );

    setSensitiveResponseHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer occurrence check-in PIN request",

      fallbackMessage: "Unable to retrieve the check-in PIN.",

      fallbackCode: "CHECK_IN_PIN_RETRIEVAL_FAILED",
    });
  }
};

/* ─────────────────────────────── CHECK-OUT PIN ─────────────────────────────── */

/**
 * Returns the check-out PIN for one exact ShiftOccurrence.
 *
 * occurrenceId may be omitted only for a single-date Shift. In that case the
 * attendance service resolves occurrence sequence 1.
 *
 * The attendance service permits check-out PIN access only after a successful
 * check-in and enforces employer/branch authorization.
 */
exports.getCheckOutPin = async (req, res) => {
  try {
    const result = await ShiftAttendanceService.getEmployerCheckOutPin(
      getEmployerAttendanceContext(req)
    );

    setSensitiveResponseHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer occurrence check-out PIN request",

      fallbackMessage: "Unable to retrieve the check-out PIN.",

      fallbackCode: "CHECK_OUT_PIN_RETRIEVAL_FAILED",
    });
  }
};
