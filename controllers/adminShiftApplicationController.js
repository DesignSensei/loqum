// controllers/adminShiftApplicationController.js

const ShiftQueryService = require("../services/shifts/shiftQueryService");
const ShiftViewService = require("../services/shifts/shiftViewService");

const { createServiceError } = require("../services/helpers/serviceErrorHelper");
const logger = require("../utils/logger");

const ADMIN_SHIFTS_URL = "/admin/shifts";
const ADMIN_APPLICATIONS_VIEW = "admin/shifts/applications/index";
const ADMIN_APPLICATION_DETAILS_VIEW = "admin/shifts/applications/show";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function createControllerError(message, code, statusCode = 400) {
  return createServiceError({
    name: "AdminShiftApplicationControllerError",
    message,
    code,
    statusCode,
  });
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function getAdminUserId(req) {
  if (!req.user?._id) {
    throw createControllerError("Sign in to continue.", "AUTHENTICATION_REQUIRED", 401);
  }

  if (req.user.role !== "admin") {
    throw createControllerError("Admin access is required.", "ADMIN_ACCESS_REQUIRED", 403);
  }

  return req.user._id;
}

function getScalarQueryValue(value, field) {
  if (value != null && typeof value !== "string") {
    throw createControllerError(`${field} must be a single text value.`, "INVALID_QUERY_VALUE");
  }

  return value;
}

function getConsistentId(field, values, required = false) {
  const normalized = values
    .filter((value) => value != null && value !== "")
    .map((value) => {
      if (Array.isArray(value) || !/^[a-f0-9]{24}$/i.test(String(value))) {
        throw createControllerError(`${field} is invalid.`, "INVALID_ID");
      }

      return String(value).toLowerCase();
    });

  if (!normalized.length && required) {
    throw createControllerError(`${field} is required.`, "MISSING_TARGET_ID");
  }

  if (new Set(normalized).size > 1) {
    throw createControllerError(
      `${field} conflicts with the request target.`,
      "ADMIN_TARGET_MISMATCH",
      403
    );
  }

  return normalized[0];
}

function getEmployerProfileId(req, required = false) {
  const admin = getAdminUserId(req);
  const context = req.adminEmployerContext;

  if (required && !context) {
    throw createControllerError(
      "Employer context middleware is required.",
      "ADMIN_EMPLOYER_CONTEXT_REQUIRED",
      500
    );
  }

  if (
    context &&
    (!context.adminUserId ||
      !context.employerProfileId ||
      !context.employerProfile?._id ||
      String(context.adminUserId) !== String(admin))
  ) {
    throw createControllerError(
      "Invalid admin employer context.",
      "ADMIN_EMPLOYER_CONTEXT_INVALID",
      500
    );
  }

  return getConsistentId(
    "Employer profile ID",
    [
      req.params?.employerProfileId,
      context?.employerProfileId,
      context?.employerProfile?._id,
      getScalarQueryValue(req.query?.employerProfileId, "Employer profile ID"),
      required ? req.body?.employerProfileId : undefined,
    ],
    required
  );
}

function getApplicationQueryInput(req, detail) {
  const query = req.query || {};

  const input = {
    adminUserId: getAdminUserId(req),

    employerProfileId: getEmployerProfileId(req),

    shiftId: getConsistentId(
      "Shift ID",
      [req.params?.shiftId, getScalarQueryValue(query.shiftId, "Shift ID")],
      true
    ),

    branchId: getConsistentId("Branch ID", [
      req.params?.branchId,
      getScalarQueryValue(query.branchId, "Branch ID"),
    ]),
  };

  if (detail) {
    input.applicationId = getConsistentId(
      "Application ID",
      [req.params?.applicationId, getScalarQueryValue(query.applicationId, "Application ID")],
      true
    );

    return input;
  }

  for (const field of [
    "status",
    "applicationType",
    "professionalProfileId",
    "occurrenceId",
    "replacementForAssignmentId",
    "slotNumber",
    "applicationRound",
    "page",
    "pageSize",
  ]) {
    input[field] = getScalarQueryValue(query[field], field);
  }

  return input;
}

function isOperationalServiceError(error) {
  return [
    "AdminShiftApplicationControllerError",
    "AdminMiddlewareError",
    "ShiftServiceError",
  ].includes(error?.name);
}

function handleJsonError({ res, error: failure, logContext, fallbackMessage, fallbackCode }) {
  const operational = isOperationalServiceError(failure);

  const validation = failure?.name === "ValidationError" || failure?.name === "CastError";

  const requested = Number(failure?.statusCode);

  const status = validation
    ? 400
    : operational && Number.isInteger(requested) && requested >= 400 && requested <= 599
      ? requested
      : 500;

  const expose = operational && status < 500;

  // Do not log instruction contents, evidence references or arbitrary provider data.
  logger[status >= 500 ? "error" : "warn"](
    `${logContext}: ${failure?.code || failure?.name || "UNKNOWN"}`
  );

  setNoStoreHeaders(res);

  return res.status(status).json({
    success: false,

    code: validation ? "INVALID_APPLICATION_QUERY" : expose ? failure.code : fallbackCode,

    message: validation
      ? "Some application filters or identifiers are invalid."
      : expose
        ? failure.message
        : fallbackMessage,
  });
}

/**
 * Admin application reads use the existing shared query and view services.
 * The query service verifies admin authority and the application's parent shift.
 * The view service prepares the presentation data returned below.
 *
 * Mount behind authentication/admin middleware. Page handlers require
 * req.csrfToken(); the referenced templates still need implementation.
 * Application oversight is read-only. Hiring decisions remain with employers.
 */

/* ─────────────────────────────── APPLICATIONS PAGE ─────────────────────────────── */

exports.getApplications = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const queryInput = getApplicationQueryInput(req, false);

    const applicationPageData =
      await ShiftQueryService.getAdminShiftApplicationsPageData(queryInput);

    const applicationsView =
      ShiftViewService.buildAdminShiftApplicationsPageView(applicationPageData);

    return res.render(ADMIN_APPLICATIONS_VIEW, {
      layout: "layouts/app-layout",

      title: applicationsView.pageTitle || "Applications",

      breadcrumbs: [
        {
          label: "Shifts",
          url: ADMIN_SHIFTS_URL,
        },
        {
          label: "Applications",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      applicationsView,
    });
  } catch (error) {
    logger.error(
      "Admin shift applications page error: " + (error?.code || error?.name || "UNKNOWN")
    );

    return next(error);
  }
};

/* ─────────────────────────────── APPLICATIONS DATA ─────────────────────────────── */

exports.getApplicationsData = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const queryInput = getApplicationQueryInput(req, false);

    const applicationPageData =
      await ShiftQueryService.getAdminShiftApplicationsPageData(queryInput);

    const applicationsView =
      ShiftViewService.buildAdminShiftApplicationsPageView(applicationPageData);

    return res.status(200).json({
      success: true,

      applicationsView,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Admin shift applications",

      fallbackMessage: "Unable to complete the admin application request.",

      fallbackCode: "ADMIN_APPLICATION_REQUEST_FAILED",
    });
  }
};

/* ─────────────────────────────── APPLICATION DETAILS PAGE ─────────────────────────────── */

exports.getApplicationDetails = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const queryInput = getApplicationQueryInput(req, true);

    const applicationDetailsData =
      await ShiftQueryService.getAdminShiftApplicationDetailsPageData(queryInput);

    const applicationView =
      ShiftViewService.buildAdminShiftApplicationDetailsView(applicationDetailsData);

    return res.render(ADMIN_APPLICATION_DETAILS_VIEW, {
      layout: "layouts/app-layout",

      title: applicationView.pageTitle || "Application Details",

      breadcrumbs: [
        {
          label: "Shifts",
          url: ADMIN_SHIFTS_URL,
        },
        {
          label: "Application Details",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      applicationView,
    });
  } catch (error) {
    logger.error(
      "Admin shift application details page error: " + (error?.code || error?.name || "UNKNOWN")
    );

    return next(error);
  }
};

/* ─────────────────────────────── APPLICATION DETAILS DATA ─────────────────────────────── */

exports.getApplicationDetailsData = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const queryInput = getApplicationQueryInput(req, true);

    const applicationDetailsData =
      await ShiftQueryService.getAdminShiftApplicationDetailsPageData(queryInput);

    const applicationView =
      ShiftViewService.buildAdminShiftApplicationDetailsView(applicationDetailsData);

    return res.status(200).json({
      success: true,

      applicationView,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Admin shift application details",

      fallbackMessage: "Unable to complete the admin application request.",

      fallbackCode: "ADMIN_APPLICATION_REQUEST_FAILED",
    });
  }
};
