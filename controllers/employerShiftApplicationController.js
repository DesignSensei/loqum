// controllers/employerShiftApplicationController.js

const ShiftApplicationService = require("../services/shiftApplicationService");

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

function buildApplicationResponse(application) {
  if (!application) {
    return null;
  }

  return {
    id: String(application._id),

    shiftId: application.shift ? String(application.shift) : null,

    professionalId: application.professional ? String(application.professional) : null,

    applicationType: application.applicationType || "initial",

    applicationRound: Number(application.applicationRound || 1),

    occurrenceId: application.occurrence ? String(application.occurrence) : null,

    replacementForAssignmentId: application.replacementForAssignment
      ? String(application.replacementForAssignment)
      : null,

    acceptedAssignmentId: application.acceptedAssignment
      ? String(application.acceptedAssignment)
      : null,

    status: application.status,

    appliedAt: application.createdAt || null,

    shortlistedAt: application.shortlistedAt || null,

    acceptedAt: application.acceptedAt || null,

    rejectedAt: application.rejectedAt || null,

    reviewedAt: application.reviewedAt || null,

    reviewedBy: application.reviewedBy ? String(application.reviewedBy) : null,

    rejectedReason: application.rejectedReason || null,

    employerPrivateNote: application.employerPrivateNote || null,
  };
}

function buildAssignmentResponse(assignment) {
  if (!assignment) {
    return null;
  }

  return {
    id: String(assignment._id),

    referenceCode: assignment.referenceCode,

    shiftId: assignment.shift ? String(assignment.shift) : null,

    professionalId: assignment.professional ? String(assignment.professional) : null,

    assignmentType: assignment.assignmentType || null,

    source: assignment.source || null,

    applicationId: assignment.application ? String(assignment.application) : null,

    replacesAssignmentId: assignment.replacesAssignment
      ? String(assignment.replacesAssignment)
      : null,

    occurrenceId: assignment.occurrence ? String(assignment.occurrence) : null,

    startSequence: assignment.startSequence ?? null,

    plannedEndSequence: assignment.plannedEndSequence ?? null,

    plannedOccurrenceCount: Number(assignment.plannedOccurrenceCount || 0),

    startsAt: assignment.startsAt || null,

    plannedEndsAt: assignment.plannedEndsAt || null,

    status: assignment.status,

    assignedAt: assignment.assignedAt || null,

    assignedBy: assignment.assignedBy ? String(assignment.assignedBy) : null,
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

  return occurrenceId ? String(occurrenceId) : null;
}

function getReplacementScope(result) {
  const applicationType = String(
    result?.applicationType || result?.application?.applicationType || ""
  )
    .trim()
    .toLowerCase();

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

  if (getAcceptedOccurrenceId(result)) {
    return "isolated";
  }

  return "tail";
}

function getAuthoritativeShift(result) {
  return result?.shift || result?.assignmentResult?.shift || null;
}

function buildShiftResponse(result) {
  const shift = getAuthoritativeShift(result);

  const shiftId =
    shift?._id ||
    result?.shiftId ||
    result?.assignment?.shift ||
    result?.application?.shift ||
    null;

  return {
    id: shiftId ? String(shiftId) : null,

    referenceCode: shift?.referenceCode || null,

    status: shift?.status || null,

    paymentStatus: shift?.paymentStatus || null,

    activeAssignmentId: shift?.activeAssignment ? String(shift.activeAssignment) : null,

    assignedProfessionalId: shift?.assignedProfessional ? String(shift.assignedProfessional) : null,

    applicationRound:
      shift?.applicationRound === null || shift?.applicationRound === undefined
        ? null
        : Number(shift.applicationRound),
  };
}

function buildAcceptanceMessage(result) {
  const applicationType = String(
    result?.applicationType || result?.application?.applicationType || "initial"
  )
    .trim()
    .toLowerCase();

  const assignedOccurrenceCount = Number(
    result?.assignmentResult?.assignedOccurrenceCount ||
      result?.assignment?.plannedOccurrenceCount ||
      0
  );

  if (applicationType === "replacement") {
    const replacementScope = getReplacementScope(result);

    if (replacementScope === "isolated") {
      return "The replacement professional has been accepted for this Shift occurrence.";
    }

    if (assignedOccurrenceCount > 1) {
      return (
        "The replacement professional has been accepted for the remaining " +
        `${assignedOccurrenceCount} scheduled Shift occurrences.`
      );
    }

    return "The replacement professional has been accepted for the remaining Shift occurrence.";
  }

  if (assignedOccurrenceCount > 1) {
    return (
      `The professional has been accepted for all ${assignedOccurrenceCount} ` +
      "scheduled Shift occurrences."
    );
  }

  return "The professional has been accepted for the Shift.";
}

function buildAssignmentSummary(result) {
  const replacedAssignmentId =
    result?.assignmentResult?.replacedAssignmentId ||
    result?.assignment?.replacesAssignment ||
    null;

  return {
    assignedOccurrenceCount: Number(
      result?.assignmentResult?.assignedOccurrenceCount ||
        result?.assignment?.plannedOccurrenceCount ||
        0
    ),

    replacementScope: getReplacementScope(result),

    occurrenceId: getAcceptedOccurrenceId(result),

    replacedAssignmentId: replacedAssignmentId ? String(replacedAssignmentId) : null,
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

      employerPrivateNote: req.body.employerPrivateNote,
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

/* ─────────────────────────────── REJECT APPLICATION ─────────────────────────────── */

exports.rejectApplication = async (req, res) => {
  try {
    const result = await ShiftApplicationService.rejectApplication({
      applicationId: req.params.applicationId,

      employerProfileId: getEmployerProfileId(req),

      employerContext: req.employerContext || null,

      reviewedByUserId: getEmployerUserId(req),

      rejectedReason: req.body.rejectedReason,

      employerPrivateNote: req.body.employerPrivateNote,
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
 * Employer accepts an application through ShiftApplicationService.
 *
 * The controller never decides parent Shift ownership or parent lifecycle
 * status itself.
 *
 * This matters for isolated replacement:
 *
 * - the replacement professional owns only the targeted occurrence;
 * - the continuing engagement professional remains the parent professional;
 * - the parent Shift may already be in progress, pending settlement or another
 *   occurrence-derived state; and
 * - the controller must therefore return the authoritative parent state that
 *   the service/assignment/reconciliation layer produced.
 */
exports.acceptApplication = async (req, res) => {
  try {
    const result = await ShiftApplicationService.acceptApplication({
      applicationId: req.params.applicationId,

      employerProfileId: getEmployerProfileId(req),

      employerContext: req.employerContext || null,

      reviewedByUserId: getEmployerUserId(req),

      employerPrivateNote: req.body.employerPrivateNote,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildAcceptanceMessage(result),

      applicationType: result.applicationType || result.application?.applicationType || "initial",

      applicationRound: Number(
        result.applicationRound || result.application?.applicationRound || 1
      ),

      replacementScope: getReplacementScope(result),

      rejectedOtherApplicationCount: Number(result.rejectedOtherApplicationCount || 0),

      application: buildApplicationResponse(result.application),

      assignment: buildAssignmentResponse(result.assignment),

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
