// controllers/employerShiftAssignmentController.js

const ShiftAssignmentCaseService = require("../services/shiftAssignmentCaseService");

const ShiftAssignmentQueryService = require("../services/shifts/assignments/shiftAssignmentQueryService");

const ShiftAssignmentViewService = require("../services/shifts/assignments/shiftAssignmentViewService");

const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const EMPLOYER_ASSIGNMENTS_VIEW = "employer/shifts/assignments";

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
    "ShiftAssignmentCaseServiceError",
    "ShiftAssignmentQueryServiceError",
    "ShiftAssignmentServiceError",
    "ShiftOccurrenceReconciliationServiceError",
    "EmployerShiftAssignmentControllerError",
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

    error.name = "EmployerShiftAssignmentControllerError";
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

    error.name = "EmployerShiftAssignmentControllerError";
    error.code = "EMPLOYER_USER_CONTEXT_REQUIRED";
    error.statusCode = 500;

    throw error;
  }

  return employerUserId;
}

function getEmployerActor(req) {
  return {
    role: "employer",

    userId: getEmployerUserId(req),

    businessId: getEmployerProfileId(req),

    employerContext: req.employerContext || null,
  };
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

function normalizeOptionalDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function buildExitRangeResponse(range) {
  if (!range) {
    return null;
  }

  return {
    lastWorkingSequenceNumber: toNullableSafeInteger(range.lastWorkingSequenceNumber),

    replacementStartSequenceNumber: toNullableSafeInteger(range.replacementStartSequenceNumber),

    replacementEndSequenceNumber: toNullableSafeInteger(range.replacementEndSequenceNumber),

    replacementOccurrenceCount: toNullableSafeInteger(range.replacementOccurrenceCount),
  };
}

function buildAssignmentCaseResponse(assignmentCase) {
  if (!assignmentCase) {
    return null;
  }

  return {
    id: toId(assignmentCase),

    referenceCode: assignmentCase.referenceCode || null,

    caseType: assignmentCase.caseType || null,

    status: assignmentCase.status || null,

    isOpen: assignmentCase.isOpen === true,

    shiftId: toId(assignmentCase.shift),

    assignmentId: toId(assignmentCase.assignment),

    businessId: toId(assignmentCase.business),

    branchId: toId(assignmentCase.branch),

    professionalId: toId(assignmentCase.professional),

    initiatedBy: assignmentCase.initiatedBy
      ? {
          role: assignmentCase.initiatedBy.role || null,

          userId: toId(assignmentCase.initiatedBy.userId),
        }
      : null,

    exitProposal: assignmentCase.exitProposal
      ? {
          source: assignmentCase.exitProposal.source || null,

          reason: assignmentCase.exitProposal.reason || null,

          details: assignmentCase.exitProposal.details || null,

          range: buildExitRangeResponse(assignmentCase.exitProposal.range),

          proposedAt: assignmentCase.exitProposal.proposedAt || null,

          proposedBy: toId(assignmentCase.exitProposal.proposedBy),
        }
      : null,

    employerIssue: assignmentCase.employerIssue
      ? {
          issueType: assignmentCase.employerIssue.issueType || null,

          occurrenceId: toId(assignmentCase.employerIssue.occurrence),

          occurrenceSequenceNumber: toNullableSafeInteger(
            assignmentCase.employerIssue.occurrenceSequenceNumber
          ),

          occurredAt: assignmentCase.employerIssue.occurredAt || null,

          details: assignmentCase.employerIssue.details || null,

          reportedAt: assignmentCase.employerIssue.reportedAt || null,
        }
      : null,

    professionalResponse: assignmentCase.professionalResponse
      ? {
          decision: assignmentCase.professionalResponse.decision || null,

          details: assignmentCase.professionalResponse.details || null,

          respondedAt: assignmentCase.professionalResponse.respondedAt || null,

          respondedBy: toId(assignmentCase.professionalResponse.respondedBy),
        }
      : null,

    employerResponse: assignmentCase.employerResponse
      ? {
          decision: assignmentCase.employerResponse.decision || null,

          details: assignmentCase.employerResponse.details || null,

          respondedAt: assignmentCase.employerResponse.respondedAt || null,

          respondedBy: toId(assignmentCase.employerResponse.respondedBy),
        }
      : null,

    replacementRequestedAt: assignmentCase.replacementRequestedAt || null,

    replacementRequestedBy: toId(assignmentCase.replacementRequestedBy),

    escalatedAt: assignmentCase.escalatedAt || null,

    escalatedBy: toId(assignmentCase.escalatedBy),

    escalationReason: assignmentCase.escalationReason || null,

    resolution: assignmentCase.resolution
      ? {
          outcome: assignmentCase.resolution.outcome || null,

          reason: assignmentCase.resolution.reason || null,

          effectiveExitRange: buildExitRangeResponse(assignmentCase.resolution.effectiveExitRange),

          resolvedAt: assignmentCase.resolution.resolvedAt || null,

          resolvedBy: toId(assignmentCase.resolution.resolvedBy),

          resolvedByRole: assignmentCase.resolution.resolvedByRole || null,
        }
      : null,

    createdAt: assignmentCase.createdAt || null,

    updatedAt: assignmentCase.updatedAt || null,
  };
}

function buildAssignmentResponse(assignment) {
  if (!assignment) {
    return null;
  }

  return {
    id: toId(assignment),

    referenceCode: assignment.referenceCode || null,

    shiftId: toId(assignment.shift),

    professionalId: toId(assignment.professional),

    businessId: toId(assignment.business),

    branchId: toId(assignment.branch),

    slotNumber: toNullableSafeInteger(assignment.slotNumber),

    assignmentType: assignment.assignmentType || null,

    source: assignment.source || null,

    applicationId: toId(assignment.application),

    occurrenceId: toId(assignment.occurrence),

    replacesAssignmentId: toId(assignment.replacesAssignment),

    replacedByAssignmentId: toId(assignment.replacedByAssignment),

    replacementCaseId: toId(assignment.replacementCase),

    openCaseId: toId(assignment.openCase),

    endCaseId: toId(assignment.endCase),

    startSequence: toNullableSafeInteger(assignment.startSequence),

    plannedEndSequence: toNullableSafeInteger(assignment.plannedEndSequence),

    plannedOccurrenceCount: toNullableSafeInteger(assignment.plannedOccurrenceCount),

    effectiveEndSequence: toNullableSafeInteger(assignment.effectiveEndSequence),

    effectiveOccurrenceCount: toNullableSafeInteger(assignment.effectiveOccurrenceCount),

    startsAt: assignment.startsAt || null,

    plannedEndsAt: assignment.plannedEndsAt || null,

    effectiveEndsAt: assignment.effectiveEndsAt || null,

    status: assignment.status || null,

    isCurrentAssignment: assignment.isCurrentAssignment === true,

    assignedAt: assignment.assignedAt || null,

    activatedAt: assignment.activatedAt || null,

    endingRequestedAt: assignment.endingRequestedAt || null,

    endingConfirmedAt: assignment.endingConfirmedAt || null,

    endedAt: assignment.endedAt || null,

    cancelledAt: assignment.cancelledAt || null,
  };
}

function buildShiftResponse(shift) {
  if (!shift) {
    return null;
  }

  return {
    id: toId(shift),

    referenceCode: shift.referenceCode || null,

    status: shift.status || null,

    paymentStatus: shift.paymentStatus || null,

    hiringSummary: shift.hiringSummary || null,

    assignmentSummary: shift.assignmentSummary || null,

    occurrenceProgress: shift.occurrenceProgress || null,
  };
}

function buildCaseCommandResponse(result) {
  return {
    assignmentCase: buildAssignmentCaseResponse(result?.assignmentCase),

    assignment: buildAssignmentResponse(result?.assignment),

    shift: buildShiftResponse(result?.shift),
  };
}

/* ─────────────────────────────── ASSIGNMENTS PAGE ─────────────────────────────── */

/**
 * Employer assignment page reads are orchestrated here.
 *
 * ShiftAssignmentQueryService owns:
 *
 * - employer/business authorization;
 * - branch scope;
 * - optional focused Shift scope;
 * - assignment status/type filtering;
 * - assignment/case/occurrence reads;
 * - raw counts; and
 * - pagination facts.
 *
 * ShiftAssignmentViewService owns:
 *
 * - labels;
 * - badges;
 * - formatted dates/ranges;
 * - assignment and occurrence presentation;
 * - case presentation;
 * - filters;
 * - summary cards;
 * - read-only state; and
 * - pagination presentation.
 *
 * EJS receives only the finalized assignmentsView.
 */
exports.getAssignments = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const assignmentPageData = await ShiftAssignmentQueryService.getEmployerAssignmentsPageData({
      userId: getEmployerUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,

      status: req.query.status,

      assignmentType: req.query.type,

      shiftId: req.query.shift,

      page: req.query.page,

      currentTime,
    });

    const assignmentsView =
      ShiftAssignmentViewService.buildEmployerAssignmentsPageView(assignmentPageData);

    setNoStoreHeaders(res);

    return res.render(EMPLOYER_ASSIGNMENTS_VIEW, {
      layout: "layouts/app-layout",

      title: assignmentsView.pageTitle || "Shift Assignments",

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
          label: "Assignments",

          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      assignmentsView,

      scripts: `
          <script src="/js/employer/shift-assignments.js"></script>
        `,
    });
  } catch (error) {
    logger.error("Employer shift assignments page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── REPORT ASSIGNMENT ISSUE ─────────────────────────────── */

/**
 * Opens an employer_issue case against one assignment.
 *
 * The service owns:
 *
 * - assignment/business/branch authorization;
 * - whether another case may be opened;
 * - occurrence ownership validation;
 * - issue-type validation;
 * - missed-occurrence requirements; and
 * - creation of the authoritative case.
 */
exports.reportAssignmentIssue = async (req, res) => {
  try {
    const result = await ShiftAssignmentCaseService.openEmployerIssue({
      assignmentId: req.params.assignmentId,

      actor: getEmployerActor(req),

      issueType: req.body?.issueType,

      occurrenceId: req.body?.occurrenceId || null,

      occurredAt: normalizeOptionalDate(req.body?.occurredAt),

      details: req.body?.details,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(201).json({
      success: true,

      message: "The assignment issue has been reported.",

      ...buildCaseCommandResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer assignment issue reporting",

      fallbackMessage: "The assignment issue could not be reported. Please try again.",

      fallbackCode: "SHIFT_ASSIGNMENT_ISSUE_REPORT_FAILED",
    });
  }
};

/* ─────────────────────────────── RESPOND TO ASSIGNMENT CASE ─────────────────────────────── */

/**
 * Records the employer response to a professional-exit or employer-issue case.
 *
 * The service decides whether the requested decision is valid for:
 *
 * - the case type;
 * - the current case status;
 * - the professional's response;
 * - the confirmed exit range; and
 * - the assignment's current lifecycle.
 *
 * The controller does not reproduce those rules.
 */
exports.respondToAssignmentCase = async (req, res) => {
  try {
    const result = await ShiftAssignmentCaseService.respondAsEmployer({
      assignmentId: req.params.assignmentId,

      caseId: req.params.caseId,

      actor: getEmployerActor(req),

      decision: req.body?.decision,

      details: req.body?.details,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "The assignment case response has been recorded.",

      ...buildCaseCommandResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer assignment case response",

      fallbackMessage: "The assignment case response could not be recorded. Please try again.",

      fallbackCode: "SHIFT_ASSIGNMENT_CASE_RESPONSE_FAILED",
    });
  }
};

/* ─────────────────────────────── ESCALATE ASSIGNMENT CASE ─────────────────────────────── */

/**
 * Explicitly escalates an open assignment case for admin review.
 *
 * ShiftAssignmentCaseService owns the allowed current statuses and
 * preserves the case/assignment/Shift transaction boundary.
 */
exports.escalateAssignmentCase = async (req, res) => {
  try {
    const result = await ShiftAssignmentCaseService.escalateCase({
      assignmentId: req.params.assignmentId,

      caseId: req.params.caseId,

      actor: getEmployerActor(req),

      reason: req.body?.reason,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "The assignment case has been escalated for admin review.",

      ...buildCaseCommandResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer assignment case escalation",

      fallbackMessage: "The assignment case could not be escalated. Please try again.",

      fallbackCode: "SHIFT_ASSIGNMENT_CASE_ESCALATION_FAILED",
    });
  }
};
