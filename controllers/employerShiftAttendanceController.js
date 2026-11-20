// controllers/employerShiftAttendanceController.js

const ShiftAttendanceService = require("../services/shiftAttendanceService");

const ShiftAttendanceQueryService = require("../services/shifts/attendance/shiftAttendanceQueryService");

const ShiftAttendanceViewService = require("../services/shifts/attendance/shiftAttendanceViewService");

const logger = require("../utils/logger");

const EMPLOYER_ATTENDANCE_VIEW = "employer/shifts/attendance";
const EMPLOYER_SHIFTS_URL = "/employer/shifts";

const CONTROLLER_ERROR_NAME = "EmployerShiftAttendanceControllerError";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setSensitiveResponseHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
}

function createControllerError({ message, code, statusCode = 500, details = null }) {
  const error = new Error(message);

  error.name = CONTROLLER_ERROR_NAME;
  error.code = code;
  error.statusCode = statusCode;

  if (details && typeof details === "object") {
    error.details = details;
  }

  return error;
}

function isOperationalServiceError(error) {
  return [
    "ShiftAttendanceServiceError",
    "ShiftAttendanceQueryServiceError",
    CONTROLLER_ERROR_NAME,
  ].includes(error?.name);
}

function getErrorStatusCode(error) {
  if (!isOperationalServiceError(error)) {
    return 500;
  }

  const statusCode = Number(error?.statusCode);

  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 400;
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operationalError = isOperationalServiceError(error);
  const statusCode = getErrorStatusCode(error);

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ${error.code || "UNKNOWN"} - ${error.message}`);
  }

  const response = {
    success: false,

    message: operationalError && statusCode < 500 ? error.message : fallbackMessage,

    code: operationalError && statusCode < 500 ? error.code || fallbackCode : fallbackCode,
  };

  if (operationalError && statusCode < 500 && error.details && typeof error.details === "object") {
    response.details = error.details;
  }

  setSensitiveResponseHeaders(res);

  return res.status(statusCode).json(response);
}

/* ─────────────────────────────── REQUEST CONTEXT ─────────────────────────────── */

function getEmployerUserId(req) {
  const employerUserId = req.user?._id;

  if (!employerUserId) {
    throw createControllerError({
      message: "Employer user context is unavailable.",
      code: "EMPLOYER_USER_CONTEXT_REQUIRED",
    });
  }

  return employerUserId;
}

function getEmployerProfile(req) {
  const employerProfile = req.employerProfile;

  if (!employerProfile?._id) {
    throw createControllerError({
      message: "Employer profile context is unavailable.",
      code: "EMPLOYER_PROFILE_CONTEXT_REQUIRED",
    });
  }

  return employerProfile;
}

function getEmployerProfileId(req) {
  return getEmployerProfile(req)._id;
}

function getEmployerAttendanceContext(req) {
  return {
    shiftId: req.params.shiftId,

    occurrenceId: req.params.occurrenceId || null,

    employerProfileId: getEmployerProfileId(req),

    employerContext: req.employerContext || null,
  };
}

/* ─────────────────────────────── ATTENDANCE PAGE ─────────────────────────────── */

/**
 * Renders the employer attendance page.
 *
 * ShiftAttendanceQueryService owns:
 *
 * - employer/business authorization;
 * - branch-level access and filtering;
 * - focused Shift filtering;
 * - attendance-status filtering;
 * - occurrence retrieval;
 * - attendance summary counts; and
 * - pagination.
 *
 * ShiftAttendanceViewService owns:
 *
 * - occurrence and professional presentation;
 * - attendance status labels and styles;
 * - attendance audit presentation;
 * - PIN action availability;
 * - filter presentation;
 * - summary cards;
 * - empty states; and
 * - pagination presentation.
 *
 * The controller only orchestrates query, view-model
 * construction and rendering.
 *
 * Raw attendance PINs are not retrieved for this page.
 * They remain accessible only through the authorized
 * occurrence-specific PIN endpoints.
 *
 * The application layout owns the global page header
 * and toolbar. This controller supplies the title
 * and breadcrumbs without duplicating them in EJS.
 */
exports.getAttendance = async (req, res, next) => {
  try {
    const employerProfile = getEmployerProfile(req);

    const attendancePageData = await ShiftAttendanceQueryService.getEmployerAttendancePageData({
      userId: getEmployerUserId(req),

      employerProfile,

      employerContext: req.employerContext || null,

      attendanceStatus: req.query.status,

      shiftId: req.query.shift,

      page: req.query.page,

      currentTime: new Date(),
    });

    const attendanceView =
      ShiftAttendanceViewService.buildEmployerAttendancePageView(attendancePageData);

    setSensitiveResponseHeaders(res);

    return res.render(EMPLOYER_ATTENDANCE_VIEW, {
      layout: "layouts/app-layout",

      title: attendanceView.pageTitle || "Shift Attendance",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Manage Shifts",
          url: EMPLOYER_SHIFTS_URL,
        },
        {
          label: "Attendance",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      attendanceView,

      scripts: `
        <script src="/js/employer/shift-attendance.js"></script>
      `,
    });
  } catch (error) {
    logger.error("Employer shift attendance page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── CHECK-IN PIN ─────────────────────────────── */

/**
 * Returns the check-in PIN for one ShiftOccurrence.
 *
 * ShiftAttendanceService owns:
 *
 * - employer/business authorization;
 * - branch access;
 * - occurrence assignment validation;
 * - protected funding validation;
 * - occurrence attendance-state validation; and
 * - check-in PIN availability.
 *
 * An explicit occurrenceId selects the exact work occurrence.
 *
 * When occurrenceId is omitted, the service permits
 * implicit selection only when exactly one occurrence
 * belongs to the Shift.
 *
 * Check-in PIN availability is state-based rather
 * than restricted to a pre-check-in reveal window.
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
 * Returns the check-out PIN for one ShiftOccurrence.
 *
 * ShiftAttendanceService owns:
 *
 * - employer/business authorization;
 * - branch access;
 * - occurrence assignment validation;
 * - protected funding validation;
 * - successful check-in verification;
 * - occurrence attendance-state validation; and
 * - check-out PIN availability.
 *
 * The check-out PIN is available only after
 * successful professional check-in, while the
 * occurrence remains eligible for checkout.
 *
 * An explicit occurrenceId selects the exact work occurrence.
 *
 * Implicit selection is permitted only when the
 * Shift contains exactly one occurrence.
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
