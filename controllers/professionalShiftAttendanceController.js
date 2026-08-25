// controllers/professionalShiftAttendanceController.js

const ShiftAttendanceService = require("../services/shiftAttendanceService");

const logger = require("../utils/logger");

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function isOperationalServiceError(error) {
  return [
    "ShiftAttendanceServiceError",
    "ShiftOccurrenceClaimServiceError",
    "ShiftOccurrenceReconciliationServiceError",
    "ProfessionalShiftAttendanceControllerError",
  ].includes(error?.name);
}

function getProfessionalProfileId(req) {
  const professionalProfileId = req.professionalProfile?._id;

  if (!professionalProfileId) {
    const error = new Error("Professional profile context is unavailable.");

    error.name = "ProfessionalShiftAttendanceControllerError";
    error.code = "PROFESSIONAL_PROFILE_CONTEXT_REQUIRED";
    error.statusCode = 500;

    throw error;
  }

  return professionalProfileId;
}

function buildLocationInput(body = {}) {
  const source =
    body.location && typeof body.location === "object" && !Array.isArray(body.location)
      ? body.location
      : body;

  return {
    latitude: source.latitude,

    longitude: source.longitude,

    accuracyMeters: source.accuracyMeters ?? source.accuracy,

    capturedAt: source.capturedAt,

    locationSource: source.locationSource,
  };
}

function buildAbsenceExplanationResponse(result) {
  const occurrence = result?.occurrence || null;

  return {
    shiftId: result?.shift?._id
      ? String(result.shift._id)
      : occurrence?.shift
        ? String(occurrence.shift)
        : null,

    occurrenceId: occurrence?._id ? String(occurrence._id) : null,

    occurrenceReferenceCode: occurrence?.referenceCode || null,

    sequenceNumber: Number(occurrence?.sequenceNumber || 0),

    occurrenceDate: occurrence?.occurrenceDate || null,

    occurrenceStatus: occurrence?.status || null,

    attendanceStatus: occurrence?.attendanceStatus || null,

    absenceExplanation: result?.absenceExplanation || null,

    absenceExplainedAt: result?.absenceExplainedAt || null,

    submitted: result?.submitted === true,

    idempotent: result?.idempotent === true,
  };
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

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

/* ─────────────────────────────── CHECK-IN ─────────────────────────────── */

exports.checkIn = async (req, res) => {
  try {
    const result = await ShiftAttendanceService.checkIn({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalProfileId: getProfessionalProfileId(req),

      pin: req.body.pin,

      location: buildLocationInput(req.body),

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "You have checked in successfully.",

      data: result,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional occurrence check-in",

      fallbackMessage: "You could not check in. Please try again.",

      fallbackCode: "PROFESSIONAL_CHECK_IN_FAILED",
    });
  }
};

/* ─────────────────────────────── CHECKOUT ─────────────────────────────── */

exports.checkOut = async (req, res) => {
  try {
    const result = await ShiftAttendanceService.checkOut({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalProfileId: getProfessionalProfileId(req),

      professionalUserId: req.user._id,

      pin: req.body.pin,

      location: buildLocationInput(req.body),

      lateCheckoutOption: req.body.lateCheckoutOption,

      lateCheckoutReason: req.body.lateCheckoutReason,

      lateCheckoutNotes: req.body.lateCheckoutNotes,

      requestedOvertimeHours: req.body.requestedOvertimeHours,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    const message =
      result.overtime?.requested === true
        ? "You have checked out successfully. Your overtime request has been submitted."
        : "You have checked out successfully.";

    return res.status(200).json({
      success: true,

      message,

      data: result,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional occurrence checkout",

      fallbackMessage: "You could not check out. Please try again.",

      fallbackCode: "PROFESSIONAL_CHECK_OUT_FAILED",
    });
  }
};

/* ─────────────────────────────── CHECKOUT FALLBACK ─────────────────────────────── */

exports.requestCheckoutFallback = async (req, res) => {
  try {
    const result = await ShiftAttendanceService.requestCheckoutFallback({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalProfileId: getProfessionalProfileId(req),

      reason: req.body.reason,

      notes: req.body.notes,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(202).json({
      success: true,

      message: "Your checkout review request has been submitted.",

      data: result,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional checkout fallback request",

      fallbackMessage: "Your checkout review request could not be submitted. Please try again.",

      fallbackCode: "CHECKOUT_FALLBACK_REQUEST_FAILED",
    });
  }
};

/* ─────────────────────────────── ABSENCE EXPLANATION ─────────────────────────────── */

/**
 * Professional confirms that they did not work a recorded no-show occurrence
 * and provides the one immutable absence explanation audit.
 *
 * This is not a claim and does not change the no-show financial outcome.
 *
 * If the professional says they actually worked, the separate claim flow is
 * used for an attendance_correction claim instead.
 */
exports.submitAbsenceExplanation = async (req, res) => {
  try {
    const result = await ShiftAttendanceService.submitAbsenceExplanation({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalProfileId: getProfessionalProfileId(req),

      explanation: req.body.explanation,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message:
        result.idempotent === true
          ? "Your absence explanation has already been submitted."
          : "Your absence explanation has been submitted.",

      data: buildAbsenceExplanationResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional absence explanation submission",

      fallbackMessage: "Your absence explanation could not be submitted. Please try again.",

      fallbackCode: "ABSENCE_EXPLANATION_SUBMISSION_FAILED",
    });
  }
};
