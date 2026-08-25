// controllers/adminShiftClaimController.js

const ShiftOccurrenceClaimService = require("../services/shiftOccurrenceClaimService");

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
    "ShiftOccurrenceClaimServiceError",
    "ShiftRefundServiceError",
    "ShiftOccurrenceReconciliationServiceError",
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

function getAdminUserId(req) {
  const adminUserId = req.user?._id;

  if (!adminUserId) {
    const error = new Error("Administrator user context is unavailable.");

    error.name = "ShiftOccurrenceClaimServiceError";

    error.code = "ADMIN_USER_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return adminUserId;
}

function buildClaimResponse(claim) {
  if (!claim) {
    return null;
  }

  return {
    id: String(claim._id),

    referenceCode: claim.referenceCode,

    shiftId: claim.shift ? String(claim.shift) : null,

    occurrenceId: claim.occurrence ? String(claim.occurrence) : null,

    professionalId: claim.professional ? String(claim.professional) : null,

    businessId: claim.business ? String(claim.business) : null,

    branchId: claim.branch ? String(claim.branch) : null,

    claimType: claim.claimType,

    financiallyRelevant: claim.financiallyRelevant === true,

    status: claim.status,

    submittedAt: claim.submittedAt,

    employerResponseDeadlineAt: claim.employerResponseDeadlineAt || null,

    employerFinancialDecision: claim.employerFinancialDecision || null,

    employerAbsenceDecision: claim.employerAbsenceDecision || null,

    appealStatus: claim.appealStatus,

    appealDeadlineAt: claim.appealDeadlineAt || null,

    appealedAt: claim.appealedAt || null,

    escalationReason: claim.escalationReason || null,

    escalatedAt: claim.escalatedAt || null,

    escalationNotes: claim.escalationNotes || null,

    adminFinancialDecision: claim.adminFinancialDecision || null,

    adminAbsenceDecision: claim.adminAbsenceDecision || null,

    adminDecisionReason: claim.adminDecisionReason || null,

    adminDecidedAt: claim.adminDecidedAt || null,

    resolvedAt: claim.resolvedAt || null,
  };
}

function buildOccurrenceResponse(occurrence) {
  if (!occurrence) {
    return null;
  }

  return {
    id: String(occurrence._id),

    referenceCode: occurrence.referenceCode,

    sequenceNumber: Number(occurrence.sequenceNumber || 0),

    occurrenceDate: occurrence.occurrenceDate || null,

    status: occurrence.status,

    attendanceStatus: occurrence.attendanceStatus,

    settlementStatus: occurrence.settlementStatus,

    refundStatus: occurrence.refundStatus,

    refundableAmount: Number(occurrence.refundableAmount || 0),

    activeClaimId: occurrence.activeClaim ? String(occurrence.activeClaim) : null,
  };
}

function buildRefundResponse(refundResult) {
  if (!refundResult) {
    return null;
  }

  const employerRefund = refundResult.employerRefund || null;

  return {
    expectedRefund: Number(refundResult.expectedRefund || 0),

    refundReason: refundResult.refundReason || null,

    voided: refundResult.voided === true,

    employerRefundId: employerRefund?._id ? String(employerRefund._id) : null,

    status: employerRefund?.status || null,

    amount: employerRefund ? Number(employerRefund.amount || 0) : 0,
  };
}

function buildResolutionMessage(claim) {
  if (claim?.adminAbsenceDecision === "excused") {
    return "The absence has been classified as excused.";
  }

  if (claim?.adminAbsenceDecision === "unexcused") {
    return "The absence has been classified as unexcused.";
  }

  if (claim?.adminFinancialDecision === "approved") {
    return "The claim has been approved.";
  }

  if (claim?.adminFinancialDecision === "rejected") {
    return "The claim has been rejected.";
  }

  return "The claim has been resolved.";
}

/* ─────────────────────────────── RESOLVE CLAIM ─────────────────────────────── */

/**
 * Administrator makes the final decision on a claim already awaiting admin
 * review.
 *
 * Financial claims:
 * - approved
 * - rejected
 *
 * Absence explanation after employer non-response:
 * - excused
 * - unexcused
 *
 * occurrenceResolution is accepted only where the claim service permits a
 * financial approval to alter the occurrence outcome.
 */
exports.resolveClaim = async (req, res) => {
  try {
    const result = await ShiftOccurrenceClaimService.resolveClaimByAdmin({
      claimId: req.params.claimId,

      adminUserId: getAdminUserId(req),

      decision: req.body.decision,

      reason: req.body.reason,

      occurrenceResolution: req.body.occurrenceResolution || null,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildResolutionMessage(result.claim),

      resolved: result.resolved === true,

      final: result.final === true,

      claim: buildClaimResponse(result.claim),

      occurrence: buildOccurrenceResponse(result.occurrence),

      refund: buildRefundResponse(result.refundResult),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Admin occurrence claim resolution",

      fallbackMessage: "The claim could not be resolved.",

      fallbackCode: "OCCURRENCE_CLAIM_ADMIN_RESOLUTION_FAILED",
    });
  }
};
