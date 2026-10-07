// controllers/professionalShiftController.js

const ShiftQueryService = require("../services/shifts/shiftQueryService");
const ShiftViewService = require("../services/shifts/shiftViewService");

const { createServiceError } = require("../services/helpers/serviceErrorHelper");

const logger = require("../utils/logger");

const PROFESSIONAL_SHIFTS_URL = "/professional/shifts";
const PROFESSIONAL_MY_SHIFTS_URL = "/professional/shifts/my";

const FIND_SHIFTS_VIEW = "professional/shifts/index";
const MY_SHIFTS_VIEW = "professional/shifts/my";
const SHIFT_DETAILS_VIEW = "professional/shifts/show";

/**
 * Professional GET handlers.
 *
 * Mount behind the existing authenticated-professional middleware. The query
 * service rechecks profile ownership; req.professionalProfile is only a hint.
 * Register /shifts/my before /shifts/:shiftId in the professional router.
 *
 * EJS locals mirror the employer controllers: shiftsView or shiftDetailsView.
 * The matching professional templates/client scripts must be provided by the UI.
 * Attendance commands remain in professionalShiftAttendanceController.
 */

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function createControllerError({ message, code, statusCode }) {
  return createServiceError({
    name: "ProfessionalShiftControllerError",
    message,
    code,
    statusCode,
  });
}

function getAuthenticatedUserId(req) {
  if (!req.user?._id) {
    throw createControllerError({
      message: "Sign in to view your professional shifts.",
      code: "AUTHENTICATION_REQUIRED",
      statusCode: 401,
    });
  }

  return req.user._id;
}

function getSelectedOccurrenceId(req) {
  const occurrenceId = req.query?.occurrenceId;
  const legacyOccurrenceId = req.query?.occurrence;

  // The professional URL builders use occurrenceId; employer-style links use occurrence.
  for (const value of [occurrenceId, legacyOccurrenceId]) {
    if (value != null && typeof value !== "string") {
      throw createControllerError({
        message: "Select one occurrence.",
        code: "INVALID_OCCURRENCE_SELECTION",
        statusCode: 400,
      });
    }
  }

  if (occurrenceId && legacyOccurrenceId && occurrenceId !== legacyOccurrenceId) {
    throw createControllerError({
      message: "The occurrence selections do not match.",
      code: "CONFLICTING_OCCURRENCE_SELECTION",
      statusCode: 400,
    });
  }

  return occurrenceId || legacyOccurrenceId || null;
}

async function getShiftDetailsView(req) {
  const currentTime = new Date();

  const pageData = await ShiftQueryService.getProfessionalShiftDetailsPageData({
    userId: getAuthenticatedUserId(req),
    professionalProfile: req.professionalProfile || null,
    shiftId: req.params.shiftId,
    occurrenceId: getSelectedOccurrenceId(req),
    currentTime,
  });

  return ShiftViewService.buildProfessionalShiftDetailsView(pageData, currentTime);
}

function handleJsonError(res, error) {
  const operational = [
    "ProfessionalShiftControllerError",
    "ShiftServiceError",
    "ShiftApplicationServiceError",
  ].includes(error?.name);

  const requestedStatus = Number(error?.statusCode);

  const statusCode =
    operational &&
    Number.isInteger(requestedStatus) &&
    requestedStatus >= 400 &&
    requestedStatus <= 599
      ? requestedStatus
      : 500;

  const expose = operational && statusCode < 500;

  if (statusCode >= 500) {
    logger.error("Professional Shift occurrence request failed:", error);
  } else {
    logger.warn(`Professional Shift occurrence request rejected: ${error.code || "UNKNOWN"}`);
  }

  setNoStoreHeaders(res);

  return res.status(statusCode).json({
    success: false,
    message: expose ? error.message : "Unable to retrieve the Shift schedule.",
    code: expose
      ? error.code || "SHIFT_OCCURRENCE_RETRIEVAL_FAILED"
      : "SHIFT_OCCURRENCE_RETRIEVAL_FAILED",
  });
}

/* ─────────────────────────────── FIND SHIFTS ─────────────────────────────── */

exports.getShifts = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const query = req.query || {};

    const pageData = await ShiftQueryService.getProfessionalShiftsPageData({
      userId: getAuthenticatedUserId(req),
      professionalProfile: req.professionalProfile || null,
      state: query.state,
      lga: query.lga,
      minHourlyRateMinor: query.minHourlyRateMinor,
      maxHourlyRateMinor: query.maxHourlyRateMinor,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      sortBy: query.sortBy,
      maxDistanceKm: query.maxDistanceKm,
      page: query.page,
      currentTime: new Date(),
    });

    const shiftsView = ShiftViewService.buildProfessionalShiftsPageView(pageData);

    return res.render(FIND_SHIFTS_VIEW, {
      layout: "layouts/app-layout",
      title: shiftsView.pageTitle || "Find Shifts",
      breadcrumbs: [
        { label: "Home", url: "/professional/dashboard" },
        { label: "Find Shifts", url: null },
      ],
      csrfToken: req.csrfToken(),
      shiftsView,
      scripts: '<script src="/js/professional/shifts.js"></script>',
    });
  } catch (error) {
    logger.error("Professional find shifts page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── MY SHIFTS ─────────────────────────────── */

exports.getMyShifts = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const pageData = await ShiftQueryService.getProfessionalMyShiftsPageData({
      userId: getAuthenticatedUserId(req),
      professionalProfile: req.professionalProfile || null,
      tab: req.query?.tab,
      page: req.query?.page,
      currentTime: new Date(),
    });

    const shiftsView = ShiftViewService.buildProfessionalMyShiftsPageView(pageData);

    return res.render(MY_SHIFTS_VIEW, {
      layout: "layouts/app-layout",
      title: shiftsView.pageTitle || "My Shifts",
      breadcrumbs: [
        { label: "Home", url: "/professional/dashboard" },
        { label: "Find Shifts", url: PROFESSIONAL_SHIFTS_URL },
        { label: "My Shifts", url: null },
      ],
      csrfToken: req.csrfToken(),
      shiftsView,
      scripts: '<script src="/js/professional/my-shifts.js"></script>',
    });
  } catch (error) {
    logger.error("Professional My Shifts page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── SHIFT DETAILS ─────────────────────────────── */

exports.getShiftDetails = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const shiftDetailsView = await getShiftDetailsView(req);

    return res.render(SHIFT_DETAILS_VIEW, {
      layout: "layouts/app-layout",
      title: shiftDetailsView.pageTitle || "Shift Details",
      breadcrumbs: [
        { label: "Home", url: "/professional/dashboard" },
        { label: "My Shifts", url: PROFESSIONAL_MY_SHIFTS_URL },
        { label: shiftDetailsView.shift?.referenceCode || "Shift Details", url: null },
      ],
      csrfToken: req.csrfToken(),
      shiftDetailsView,
      scripts: '<script src="/js/professional/shift-details.js"></script>',
    });
  } catch (error) {
    logger.error("Professional shift details page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── OCCURRENCE REFRESH ─────────────────────────────── */

exports.getShiftOccurrences = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const details = await getShiftDetailsView(req);

    return res.status(200).json({
      success: true,
      data: {
        shiftId: details.shift.id,
        referenceCode: details.shift.referenceCode,
        status: details.shift.status,
        statusView: details.shift.statusView,
        selectedOccurrenceId: details.selectedOccurrenceId,
        selectedOccurrence: details.selectedOccurrence,
        selectedOpportunity: details.selectedOpportunity,
        occurrences: details.shift.occurrences,
        applications: details.shift.applications,
        opportunities: details.shift.opportunities,
        canApply: details.shift.canApply,
      },
    });
  } catch (error) {
    return handleJsonError(res, error);
  }
};
