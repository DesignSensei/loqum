// controllers/employerShiftAttendanceController.js

const ShiftAttendanceService = require("../services/shiftAttendanceService");

const ShiftAttendanceQueryService = require("../services/shifts/attendance/shiftAttendanceQueryService");

const ShiftAttendanceViewService = require("../services/shifts/attendance/shiftAttendanceViewService");

const logger = require("../utils/logger");

const EMPLOYER_ATTENDANCE_VIEW = "employer/shifts/attendance";
const EMPLOYER_SHIFTS_URL = "/employer/shifts";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setSensitiveResponseHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function isOperationalServiceError(error) {
  return [
    "ShiftAttendanceServiceError",
    "ShiftAttendanceQueryServiceError",
    "EmployerShiftAttendanceControllerError",
  ].includes(error?.name);
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

function getEmployerUserId(req) {
  const employerUserId = req.user?._id;

  if (!employerUserId) {
    const error = new Error("Employer user context is unavailable.");

    error.name = "EmployerShiftAttendanceControllerError";

    error.code = "EMPLOYER_USER_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return employerUserId;
}

function getEmployerProfileId(req) {
  const employerProfileId = req.employerProfile?._id;

  if (!employerProfileId) {
    const error = new Error("Employer profile context is unavailable.");

    error.name = "EmployerShiftAttendanceControllerError";

    error.code = "EMPLOYER_PROFILE_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return employerProfileId;
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
 * - branch scope;
 * - focused Shift scope;
 * - attendance-status filtering;
 * - occurrence reads;
 * - raw attendance counts; and
 * - pagination facts.
 *
 * ShiftAttendanceViewService owns:
 *
 * - occurrence identity presentation;
 * - professional presentation;
 * - attendance status presentation;
 * - attendance audit presentation;
 * - PIN action availability;
 * - filters;
 * - summary cards;
 * - empty state; and
 * - pagination presentation.
 *
 * Raw attendance PINs are never loaded by this page request.
 * PIN values remain behind the exact occurrence PIN endpoints below.
 */
exports.getAttendance = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const attendancePageData = await ShiftAttendanceQueryService.getEmployerAttendancePageData({
      userId: getEmployerUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,

      attendanceStatus: req.query.status,

      shiftId: req.query.shift,

      page: req.query.page,

      currentTime,
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
 * Employer/branch authorization and PIN availability are service-owned.
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
 * Employer/branch authorization and PIN availability are service-owned.
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
