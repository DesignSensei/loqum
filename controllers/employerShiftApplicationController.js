// controllers/employerShiftApplicationController.js

const ShiftApplicationService = require("../services/shiftApplicationService");
const ShiftApplicationQueryService = require("../services/shifts/applications/shiftApplicationQueryService");
const ShiftApplicationViewService = require("../services/shifts/applications/shiftApplicationViewService");

const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const EMPLOYER_APPLICATIONS_VIEW = "employer/shifts/applications";

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
    "ShiftApplicationServiceError",
    "ShiftAssignmentServiceError",
    "ShiftOccurrenceReconciliationServiceError",
    "EmployerShiftApplicationControllerError",
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

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

function getEmployerProfileId(req) {
  const employerProfileId = req.employerProfile?._id;

  if (!employerProfileId) {
    const error = new Error("Employer profile context is unavailable.");

    error.name = "EmployerShiftApplicationControllerError";
    error.code = "EMPLOYER_PROFILE_CONTEXT_REQUIRED";
    error.statusCode = 500;

    throw error;
  }

  return employerProfileId;
}

function getEmployerUserId(req) {
  const employerUserId = req.user?._id;

  if (!employerUserId) {
    const error = new Error("Employer user context is unavailable.");

    error.name = "EmployerShiftApplicationControllerError";
    error.code = "EMPLOYER_USER_CONTEXT_REQUIRED";
    error.statusCode = 500;

    throw error;
  }

  return employerUserId;
}

function toId(value) {
  if (!value) {
    return null;
  }

  return String(value._id || value);
}

function toNullableSafeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = Number(value);

  return Number.isSafeInteger(normalized) ? normalized : null;
}

function toNonNegativeSafeInteger(value, fallback = 0) {
  const normalized = Number(value);

  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function toPositiveSafeInteger(value) {
  const normalized = Number(value);

  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeApplicationType(value, fallback = "initial") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();

  return normalized || fallback;
}

function buildApplicationResponse(application) {
  if (!application) {
    return null;
  }

  return {
    id: toId(application),

    shiftId: toId(application.shift),

    professionalId: toId(application.professional),

    applicationType: normalizeApplicationType(application.applicationType),

    applicationRound: toPositiveSafeInteger(application.applicationRound) || 1,

    slotNumber: toPositiveSafeInteger(application.slotNumber),

    occurrenceId: toId(application.occurrence),

    replacementForAssignmentId: toId(application.replacementForAssignment),

    acceptedAssignmentId: toId(application.acceptedAssignment),

    status: application.status,

    appliedAt: application.createdAt || null,

    shortlistedAt: application.shortlistedAt || null,

    acceptedAt: application.acceptedAt || null,

    rejectedAt: application.rejectedAt || null,

    reviewedAt: application.reviewedAt || null,

    reviewedBy: toId(application.reviewedBy),

    rejectedReason: application.rejectedReason || null,

    employerPrivateNote: application.employerPrivateNote || null,
  };
}

function buildAssignmentResponse(assignment) {
  if (!assignment) {
    return null;
  }

  return {
    id: toId(assignment),

    referenceCode: assignment.referenceCode,

    shiftId: toId(assignment.shift),

    slotNumber: toPositiveSafeInteger(assignment.slotNumber),

    professionalId: toId(assignment.professional),

    assignmentType: assignment.assignmentType || null,

    source: assignment.source || null,

    applicationId: toId(assignment.application),

    occurrenceId: toId(assignment.occurrence),

    replacesAssignmentId: toId(assignment.replacesAssignment),

    replacementCaseId: toId(assignment.replacementCase),

    startSequence: toNullableSafeInteger(assignment.startSequence),

    plannedEndSequence: toNullableSafeInteger(assignment.plannedEndSequence),

    plannedOccurrenceCount: toNonNegativeSafeInteger(assignment.plannedOccurrenceCount),

    startsAt: assignment.startsAt || null,

    plannedEndsAt: assignment.plannedEndsAt || null,

    effectiveEndSequence: toNullableSafeInteger(assignment.effectiveEndSequence),

    effectiveOccurrenceCount: toNullableSafeInteger(assignment.effectiveOccurrenceCount),

    effectiveEndsAt: assignment.effectiveEndsAt || null,

    status: assignment.status,

    assignedAt: assignment.assignedAt || null,

    assignedBy: toId(assignment.assignedBy),

    activatedAt: assignment.activatedAt || null,

    activatedBy: toId(assignment.activatedBy),
  };
}

function getAcceptedOccurrenceId(result) {
  const candidates = [
    result?.application?.occurrence,
    result?.occurrence?._id,
    result?.assignmentResult?.occurrenceId,
    result?.assignmentResult?.occurrence?._id,
    result?.assignment?.occurrence,
  ];

  const occurrenceId = candidates.find(Boolean);

  return toId(occurrenceId);
}

function getAcceptedSlotNumber(result) {
  const candidates = [
    result?.application?.slotNumber,
    result?.assignment?.slotNumber,
    result?.assignmentResult?.slotNumber,
    result?.assignmentResult?.assignment?.slotNumber,
    result?.occurrence?.slotNumber,
  ];

  for (const candidate of candidates) {
    const slotNumber = toPositiveSafeInteger(candidate);

    if (slotNumber) {
      return slotNumber;
    }
  }

  return null;
}

function getAssignedOccurrenceCount(result) {
  const candidates = [
    result?.assignmentResult?.assignedOccurrenceCount,
    result?.assignmentResult?.occurrenceCount,
    result?.assignment?.plannedOccurrenceCount,
  ];

  for (const candidate of candidates) {
    const count = toPositiveSafeInteger(candidate);

    if (count) {
      return count;
    }
  }

  if (Array.isArray(result?.assignmentResult?.occurrences)) {
    return result.assignmentResult.occurrences.length;
  }

  return 0;
}

function getReplacementScope(result) {
  const applicationType = normalizeApplicationType(
    result?.applicationType || result?.application?.applicationType,
    ""
  );

  if (applicationType !== "replacement") {
    return null;
  }

  const explicitScope = String(
    result?.replacementScope || result?.assignmentResult?.replacementScope || ""
  )
    .trim()
    .toLowerCase();

  if (["isolated", "tail"].includes(explicitScope)) {
    return explicitScope;
  }

  return getAcceptedOccurrenceId(result) ? "isolated" : "tail";
}

function getAuthoritativeShift(result) {
  return result?.shift || result?.assignmentResult?.shift || null;
}

function buildHiringSummary(shift) {
  if (!shift?.hiringSummary) {
    return null;
  }

  return {
    initialAcceptedCount: toNonNegativeSafeInteger(shift.hiringSummary.initialAcceptedCount),

    openReplacementCount: toNonNegativeSafeInteger(shift.hiringSummary.openReplacementCount),

    lastReconciledAt: shift.hiringSummary.lastReconciledAt || null,
  };
}

function buildAssignmentCountSummary(shift) {
  if (!shift?.assignmentSummary) {
    return null;
  }

  return {
    scheduled: toNonNegativeSafeInteger(shift.assignmentSummary.scheduled),

    active: toNonNegativeSafeInteger(shift.assignmentSummary.active),

    ending: toNonNegativeSafeInteger(shift.assignmentSummary.ending),

    ended: toNonNegativeSafeInteger(shift.assignmentSummary.ended),

    cancelled: toNonNegativeSafeInteger(shift.assignmentSummary.cancelled),

    lastReconciledAt: shift.assignmentSummary.lastReconciledAt || null,
  };
}

function buildShiftResponse(result) {
  const shift = getAuthoritativeShift(result);

  const shiftId =
    shift?._id ||
    result?.shiftId ||
    result?.assignment?.shift ||
    result?.application?.shift ||
    null;

  if (!shift && !shiftId) {
    return null;
  }

  return {
    id: toId(shiftId),

    referenceCode: shift?.referenceCode || null,

    status: shift?.status || null,

    paymentStatus: shift?.paymentStatus || null,

    scheduleMode: shift?.scheduleMode || null,

    occurrenceCount: toPositiveSafeInteger(shift?.occurrenceCount),

    requiredProfessionals: toPositiveSafeInteger(shift?.requiredProfessionals),

    totalOccurrenceCount: toPositiveSafeInteger(shift?.totalOccurrenceCount),

    applicationRound: toPositiveSafeInteger(shift?.applicationRound),

    totalApplications: toNonNegativeSafeInteger(shift?.totalApplications),

    currentRoundApplications: toNonNegativeSafeInteger(shift?.currentRoundApplications),

    hiringSummary: buildHiringSummary(shift),

    assignmentSummary: buildAssignmentCountSummary(shift),

    occurrenceProgress: shift?.occurrenceProgress || null,
  };
}

function buildAcceptanceMessage(result) {
  const applicationType = normalizeApplicationType(
    result?.applicationType || result?.application?.applicationType
  );

  const slotNumber = getAcceptedSlotNumber(result);
  const assignedOccurrenceCount = getAssignedOccurrenceCount(result);
  const positionText = slotNumber ? `position ${slotNumber}` : "the selected position";

  if (applicationType === "replacement") {
    const replacementScope = getReplacementScope(result);

    if (replacementScope === "isolated") {
      return `The replacement professional has been accepted for ${positionText} on this work date.`;
    }

    if (assignedOccurrenceCount > 1) {
      return (
        `The replacement professional has been accepted for ${positionText} across the remaining ` +
        `${assignedOccurrenceCount} work dates.`
      );
    }

    return `The replacement professional has been accepted for ${positionText} for the remaining work date.`;
  }

  if (assignedOccurrenceCount > 1) {
    return (
      `The professional has been accepted for ${positionText} across ` +
      `${assignedOccurrenceCount} work dates.`
    );
  }

  return `The professional has been accepted for ${positionText}.`;
}

function buildAssignmentSummary(result) {
  const assignment = result?.assignment || result?.assignmentResult?.assignment || null;

  const replacedAssignmentId =
    result?.assignmentResult?.replacedAssignmentId || assignment?.replacesAssignment || null;

  return {
    slotNumber: getAcceptedSlotNumber(result),

    assignedOccurrenceCount: getAssignedOccurrenceCount(result),

    startSequence: toNullableSafeInteger(
      result?.assignmentResult?.startSequence ?? assignment?.startSequence
    ),

    plannedEndSequence: toNullableSafeInteger(
      result?.assignmentResult?.plannedEndSequence ?? assignment?.plannedEndSequence
    ),

    replacementScope: getReplacementScope(result),

    occurrenceId: getAcceptedOccurrenceId(result),

    replacedAssignmentId: toId(replacedAssignmentId),

    replacementCaseId: toId(
      result?.assignmentResult?.replacementCaseId || assignment?.replacementCase
    ),
  };
}

/* ─────────────────────────────── SHORTLIST APPLICATION ─────────────────────────────── */

exports.shortlistApplication = async (req, res) => {
  try {
    const result = await ShiftApplicationService.shortlistApplication({
      applicationId: req.params.applicationId,

      employerProfileId: getEmployerProfileId(req),

      employerContext: req.employerContext || null,

      reviewedByUserId: getEmployerUserId(req),

      employerPrivateNote: req.body?.employerPrivateNote,
    });

    const message =
      result.idempotent === true
        ? "This application is already shortlisted."
        : "The professional has been shortlisted.";

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message,

      idempotent: result.idempotent === true,

      application: buildApplicationResponse(result.application),

      shift: buildShiftResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer shift application shortlisting",

      fallbackMessage: "The application could not be shortlisted. Please try again.",

      fallbackCode: "SHIFT_APPLICATION_SHORTLIST_FAILED",
    });
  }
};

/* ─────────────────────────────── APPLICATIONS PAGE ─────────────────────────────── */

/**
 * Employer application page reads are orchestrated here.
 *
 * ShiftApplicationQueryService resolves and returns authorized raw page data:
 *
 * - employer/business ownership;
 * - branch scope;
 * - optional focused Shift scope;
 * - status/type filtering;
 * - application records;
 * - raw counts;
 * - pagination facts; and
 * - read-only vs management capability.
 *
 * ShiftApplicationViewService then converts that data into the finalized
 * presentation model passed to EJS.
 */

exports.getApplications = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const applicationPageData = await ShiftApplicationQueryService.getEmployerApplicationsPageData({
      userId: getEmployerUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,

      status: req.query.status,

      applicationType: req.query.type,

      shiftId: req.query.shift,

      page: req.query.page,

      currentTime,
    });

    const applicationsView =
      ShiftApplicationViewService.buildEmployerApplicationsPageView(applicationPageData);

    setNoStoreHeaders(res);

    return res.render(EMPLOYER_APPLICATIONS_VIEW, {
      layout: "layouts/app-layout",

      title: applicationsView.pageTitle || "Shift Applications",

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
          label: "Applications",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      applicationsView,

      scripts: `
        <script src="/js/employer/shift-applications.js"></script>
      `,
    });
  } catch (error) {
    logger.error("Employer shift applications page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── REJECT APPLICATION ─────────────────────────────── */

exports.rejectApplication = async (req, res) => {
  try {
    const result = await ShiftApplicationService.rejectApplication({
      applicationId: req.params.applicationId,

      employerProfileId: getEmployerProfileId(req),

      employerContext: req.employerContext || null,

      reviewedByUserId: getEmployerUserId(req),

      rejectedReason: req.body?.rejectedReason,

      employerPrivateNote: req.body?.employerPrivateNote,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "The Shift application has been rejected.",

      application: buildApplicationResponse(result.application),

      shift: buildShiftResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer shift application rejection",

      fallbackMessage: "The application could not be rejected. Please try again.",

      fallbackCode: "SHIFT_APPLICATION_REJECTION_FAILED",
    });
  }
};

/* ─────────────────────────────── ACCEPT APPLICATION ─────────────────────────────── */

/**
 * ShiftApplicationService owns acceptance and capacity enforcement.
 *
 * One accepted professional receives one stable staffing position. A
 * replacement retains that position and may cover either one exact occurrence
 * or a future sequence range. The parent Shift returns aggregate staffing
 * summaries only; occurrence and assignment records remain authoritative for
 * individual professional ownership.
 */
exports.acceptApplication = async (req, res) => {
  try {
    const currentTime = new Date();

    const result = await ShiftApplicationService.acceptApplication({
      applicationId: req.params.applicationId,

      employerProfileId: getEmployerProfileId(req),

      employerContext: req.employerContext || null,

      reviewedByUserId: getEmployerUserId(req),

      employerPrivateNote: req.body?.employerPrivateNote,

      currentTime,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildAcceptanceMessage(result),

      applicationType: normalizeApplicationType(
        result.applicationType || result.application?.applicationType
      ),

      applicationRound:
        toPositiveSafeInteger(result.applicationRound || result.application?.applicationRound) || 1,

      slotNumber: getAcceptedSlotNumber(result),

      replacementScope: getReplacementScope(result),

      occurrenceId: getAcceptedOccurrenceId(result),

      rejectedOtherApplicationCount: toNonNegativeSafeInteger(result.rejectedOtherApplicationCount),

      application: buildApplicationResponse(result.application),

      assignment: buildAssignmentResponse(
        result.assignment || result.assignmentResult?.assignment || null
      ),

      shift: buildShiftResponse(result),

      assignmentSummary: buildAssignmentSummary(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer shift application acceptance",

      fallbackMessage: "The professional could not be accepted for this Shift. Please try again.",

      fallbackCode: "SHIFT_APPLICATION_ACCEPTANCE_FAILED",
    });
  }
};
