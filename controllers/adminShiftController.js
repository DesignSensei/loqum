// controllers/adminShiftController.js

const ShiftQueryService = require("../services/shifts/shiftQueryService");
const ShiftViewService = require("../services/shifts/shiftViewService");
const EmployerCancellationRequestService = require("../services/employerCancellationRequestService");
const { createServiceError } = require("../services/helpers/serviceErrorHelper");
const logger = require("../utils/logger");

/**
 * Mount all handlers behind authentication/admin middleware. Employer-targeted
 * preview and cancellation routes also require attachAdminEmployerContext and
 * requireAdminEmployerContext, with :employerProfileId and :shiftId parameters.
 * Protect POST cancellation with the application's CSRF middleware.
 *
 * Page handlers use the existing app layout. Their admin EJS templates still need
 * implementing. Separate *Data handlers support JSON clients without templates.
 * No upload/download, wallet spending or platform-intervention endpoint is added.
 */

function error(message, code, statusCode = 400) {
  return createServiceError({
    name: "AdminShiftControllerError",
    message,
    code,
    statusCode,
  });
}

function noStore(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function authenticatedAdmin(req) {
  if (!req.user?._id) throw error("Sign in to continue.", "AUTHENTICATION_REQUIRED", 401);
  if (req.user.role !== "admin")
    throw error("Admin access is required.", "ADMIN_ACCESS_REQUIRED", 403);
  return req.user._id;
}

function scalar(value, field) {
  if (value != null && typeof value !== "string") {
    throw error(`${field} must be a single text value.`, "INVALID_QUERY_VALUE");
  }
  return value;
}

function consistentId(field, values, required = false) {
  const normalized = values
    .filter((value) => value != null && value !== "")
    .map((value) => {
      if (Array.isArray(value) || !/^[a-f0-9]{24}$/i.test(String(value)))
        throw error(`${field} is invalid.`, "INVALID_ID");
      return String(value).toLowerCase();
    });
  if (!normalized.length && required) throw error(`${field} is required.`, "MISSING_TARGET_ID");
  if (new Set(normalized).size > 1)
    throw error(`${field} conflicts with the request target.`, "ADMIN_TARGET_MISMATCH", 403);
  return normalized[0];
}

function employerTarget(req, required = false) {
  const admin = authenticatedAdmin(req);
  const context = req.adminEmployerContext;

  if (required && !context) {
    throw error("Employer context middleware is required.", "ADMIN_EMPLOYER_CONTEXT_REQUIRED", 500);
  }

  if (
    context &&
    (!context.adminUserId ||
      !context.employerProfileId ||
      !context.employerProfile?._id ||
      String(context.adminUserId) !== String(admin))
  ) {
    throw error("Invalid admin employer context.", "ADMIN_EMPLOYER_CONTEXT_INVALID", 500);
  }

  return consistentId(
    "Employer profile ID",
    [
      req.params?.employerProfileId,
      context?.employerProfileId,
      context?.employerProfile?._id,
      scalar(req.query?.employerProfileId, "Employer profile ID"),
      required ? req.body?.employerProfileId : undefined,
    ],
    required
  );
}

function readInput(req) {
  const query = req.query || {};
  const input = {
    adminUserId: authenticatedAdmin(req),
    employerProfileId: employerTarget(req),
    shiftId: consistentId("Shift ID", [req.params?.shiftId, scalar(query.shiftId, "Shift ID")]),
    requestReference: consistentId("Request reference", [
      req.params?.requestReference,
      scalar(query.requestReference, "Request reference"),
    ]),
  };

  for (const field of [
    "branchId",
    "occurrenceId",
    "status",
    "referenceCode",
    "startFrom",
    "startTo",
    "page",
    "pageSize",
    "category",
  ]) {
    input[field] = scalar(query[field], field);
  }

  return input;
}

function writeTarget(req) {
  if (!req.params?.employerProfileId || !req.params?.shiftId) {
    throw error("Employer and shift route parameters are required.", "MISSING_TARGET_ID");
  }

  return {
    adminUserId: authenticatedAdmin(req),
    employerProfileId: employerTarget(req, true),
    shiftId: consistentId(
      "Shift ID",
      [req.params.shiftId, req.body?.shiftId, scalar(req.query?.shiftId, "Shift ID")],
      true
    ),
    occurrenceId: consistentId("Occurrence ID", [
      req.params?.occurrenceId,
      req.body?.occurrenceId,
      scalar(req.query?.occurrenceId, "Occurrence ID"),
    ]),
  };
}

function jsonError(res, failure) {
  const operational = [
    "AdminShiftControllerError",
    "AdminMiddlewareError",
    "EmployerCancellationRequestError",
    "ShiftServiceError",
    "ShiftLifecycleServiceError",
    "ShiftOccurrenceCancellationServiceError",
  ].includes(failure?.name);
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
    `Admin shift request failed: ${failure?.code || failure?.name || "UNKNOWN"}`
  );
  noStore(res);

  return res.status(status).json({
    success: false,
    code: validation
      ? "INVALID_CANCELLATION_RECORD"
      : expose
        ? failure.code
        : "ADMIN_SHIFT_REQUEST_FAILED",
    message: validation
      ? "Some cancellation details are invalid. Review the submitted information."
      : expose
        ? failure.message
        : "Unable to complete the admin shift request.",
  });
}

function readHandler(queryMethod, viewMethod, template, localName, json) {
  return async (req, res, next) => {
    noStore(res);

    try {
      const data = await ShiftQueryService[queryMethod](readInput(req));
      const view = ShiftViewService[viewMethod](data);
      if (json) return res.json({ success: true, [localName]: view });

      return res.render(template, {
        layout: "layouts/app-layout",
        title: view.pageTitle,
        breadcrumbs: [
          { label: "Shifts", url: "/admin/shifts" },
          { label: view.pageTitle, url: null },
        ],
        csrfToken: req.csrfToken(),
        [localName]: view,
      });
    } catch (failure) {
      if (json) return jsonError(res, failure);
      logger.error(`Admin shift page failed: ${failure?.code || failure?.name || "UNKNOWN"}`);
      return next(failure);
    }
  };
}

exports.getShifts = readHandler(
  "getAdminShiftsPageData",
  "buildAdminShiftsPageView",
  "admin/shifts/index",
  "shiftsView",
  false
);
exports.getShiftsData = readHandler(
  "getAdminShiftsPageData",
  "buildAdminShiftsPageView",
  null,
  "shiftsView",
  true
);

exports.getShiftDetails = readHandler(
  "getAdminShiftDetailsPageData",
  "buildAdminShiftDetailsView",
  "admin/shifts/show",
  "shiftDetailsView",
  false
);
exports.getShiftDetailsData = readHandler(
  "getAdminShiftDetailsPageData",
  "buildAdminShiftDetailsView",
  null,
  "shiftDetailsView",
  true
);

exports.getAttentionQueue = readHandler(
  "getAdminAttentionQueuePageData",
  "buildAdminAttentionQueueView",
  "admin/shifts/attention",
  "attentionView",
  false
);
exports.getAttentionQueueData = readHandler(
  "getAdminAttentionQueuePageData",
  "buildAdminAttentionQueueView",
  null,
  "attentionView",
  true
);

exports.getCancellationRequests = readHandler(
  "getAdminCancellationRequestsPageData",
  "buildAdminCancellationRequestsPageView",
  "admin/shifts/cancellations/index",
  "cancellationsView",
  false
);
exports.getCancellationRequestsData = readHandler(
  "getAdminCancellationRequestsPageData",
  "buildAdminCancellationRequestsPageView",
  null,
  "cancellationsView",
  true
);

exports.getCancellationRequestDetails = readHandler(
  "getAdminCancellationRequestDetails",
  "buildAdminCancellationRequestDetailsView",
  "admin/shifts/cancellations/show",
  "cancellationView",
  false
);
exports.getCancellationRequestDetailsData = readHandler(
  "getAdminCancellationRequestDetails",
  "buildAdminCancellationRequestDetailsView",
  null,
  "cancellationView",
  true
);

// GET preview: target comes from the employer-scoped route, requester and scope
// from scalar query parameters. No request or evidence is saved by preview.
exports.getCancellationPreview = async (req, res) => {
  noStore(res);

  try {
    const target = writeTarget(req);
    const preview = await EmployerCancellationRequestService.getCancellationPreview({
      ...target,
      requestedBy: scalar(req.query?.requestedBy, "Employer requester"),
      scope: scalar(req.query?.scope, "Scope"),
      mode: scalar(req.query?.mode, "Mode"),
    });

    const cancellationPreview = ShiftViewService.buildAdminCancellationPreviewView(
      preview,
      preview.currency
    );
    return res.json({
      success: true,
      cancellationPreview: {
        ...cancellationPreview,
        occurrenceId: preview.occurrenceId || null,
      },
    });
  } catch (failure) {
    return jsonError(res, failure);
  }
};

// POST Confirm: one service transaction records the instruction and cancels.
exports.cancelOnEmployerBehalf = async (req, res) => {
  noStore(res);

  try {
    const target = writeTarget(req);
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw error("A cancellation command is required.", "INVALID_CANCELLATION_COMMAND");
    }

    if (
      body.expiresAt != null ||
      body.consent?.evidenceIndex != null ||
      body.consent?.maxProfessionalCompensationMinor != null ||
      body.consent?.financialTerms != null
    ) {
      throw error(
        "Use the immediate written-instruction request format.",
        "OUTDATED_CANCELLATION_REQUEST"
      );
    }

    const result = await EmployerCancellationRequestService.recordAndExecute({
      ...target,
      requestReference: body.requestReference,
      requestedBy: body.requestedBy,
      requestedAt: body.requestedAt,
      scope: body.scope,
      action: body.action,
      mode: body.mode,
      cancellationReasonCode: body.cancellationReasonCode,
      cancellationReason: body.cancellationReason,
      reason: body.reason,
      evidenceReviewed: body.evidenceReviewed,
      evidenceReviewNotes: body.evidenceReviewNotes,
      evidence: Array.isArray(body.evidence)
        ? body.evidence.map((item) => ({
            _id: item?._id,
            type: item?.type,
            reference: item?.reference,
            description: item?.description,
          }))
        : body.evidence,
      consent: {
        confirmedAt: body.consent?.confirmedAt,
        evidenceId: body.consent?.evidenceId,
      },
    });

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      message: result.idempotent
        ? "This cancellation was already completed."
        : "Cancellation completed.",
      idempotent: result.idempotent === true,
      cancellation: ShiftViewService.buildAdminCancellationRequestView(result.request),
      professionalPay: ShiftViewService.buildAdminAmountView(
        result.professionalCompensation,
        result.currency
      ),
    });
  } catch (failure) {
    return jsonError(res, failure);
  }
};
