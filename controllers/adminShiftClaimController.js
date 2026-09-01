// controllers/adminShiftClaimController.js

const ShiftOccurrenceResolutionService = require("../services/shiftOccurrenceResolutionService");

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
    "ShiftOccurrenceResolutionServiceError",
    "ShiftSettlementServiceError",
    "ShiftRefundServiceError",
    "ShiftOccurrenceReconciliationServiceError",
    "AdminShiftClaimControllerError",
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

    error.name = "AdminShiftClaimControllerError";

    error.code = "ADMIN_USER_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return adminUserId;
}

/* ─────────────────────────────── CLAIM RESPONSES ─────────────────────────────── */

function buildClaimIssueResponse(issue) {
  if (!issue) {
    return null;
  }

  return {
    id: issue._id ? String(issue._id) : null,

    type: issue.type,

    affectedSettlementComponents: Array.isArray(issue.affectedSettlementComponents)
      ? [...issue.affectedSettlementComponents]
      : [],

    details: issue.details || null,

    statement: issue.statement || null,

    evidence: Array.isArray(issue.evidence) ? [...issue.evidence] : [],

    status: issue.status,

    employerDecision: issue.employerDecision || null,

    employerDecisionReason: issue.employerDecisionReason || null,

    employerDecidedAt: issue.employerDecidedAt || null,

    employerDecidedBy: issue.employerDecidedBy ? String(issue.employerDecidedBy) : null,

    employerCounterPosition: issue.employerCounterPosition || null,

    employerEvidence: Array.isArray(issue.employerEvidence) ? [...issue.employerEvidence] : [],

    appealStatus: issue.appealStatus || "not_available",

    appealDeadlineAt: issue.appealDeadlineAt || null,

    appealedAt: issue.appealedAt || null,

    appealedBy: issue.appealedBy ? String(issue.appealedBy) : null,

    appealStatement: issue.appealStatement || null,

    appealEvidence: Array.isArray(issue.appealEvidence) ? [...issue.appealEvidence] : [],

    rebuttalStatus: issue.rebuttalStatus || "not_available",

    rebuttalDeadlineAt: issue.rebuttalDeadlineAt || null,

    rebuttedAt: issue.rebuttedAt || null,

    rebuttedBy: issue.rebuttedBy ? String(issue.rebuttedBy) : null,

    rebuttalStatement: issue.rebuttalStatement || null,

    rebuttalEvidence: Array.isArray(issue.rebuttalEvidence) ? [...issue.rebuttalEvidence] : [],

    escalatedAt: issue.escalatedAt || null,

    escalationReason: issue.escalationReason || null,

    escalatedBy: issue.escalatedBy ? String(issue.escalatedBy) : null,

    escalationNotes: issue.escalationNotes || null,

    adminDecision: issue.adminDecision || null,

    adminDecisionReason: issue.adminDecisionReason || null,

    adminDecidedAt: issue.adminDecidedAt || null,

    adminDecidedBy: issue.adminDecidedBy ? String(issue.adminDecidedBy) : null,

    adminOutcome: issue.adminOutcome || null,

    adminEvidence: Array.isArray(issue.adminEvidence) ? [...issue.adminEvidence] : [],

    resolvedAt: issue.resolvedAt || null,
  };
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

    assignmentId: claim.assignment ? String(claim.assignment) : null,

    professionalId: claim.professional ? String(claim.professional) : null,

    businessId: claim.business ? String(claim.business) : null,

    branchId: claim.branch ? String(claim.branch) : null,

    submittedByUserId: claim.submittedByUser ? String(claim.submittedByUser) : null,

    submittedIssueTypes: Array.isArray(claim.submittedIssueTypes)
      ? [...claim.submittedIssueTypes]
      : [],

    issues: Array.isArray(claim.issues) ? claim.issues.map(buildClaimIssueResponse) : [],

    status: claim.status,

    submittedAt: claim.submittedAt || null,

    challengeWindowOpenedAt: claim.challengeWindowOpenedAt || null,

    challengeDeadlineAt: claim.challengeDeadlineAt || null,

    employerResponseDeadlineAt: claim.employerResponseDeadlineAt || null,

    employerRefundId: claim.employerRefund ? String(claim.employerRefund) : null,

    resolvedAt: claim.resolvedAt || null,

    withdrawnAt: claim.withdrawnAt || null,

    withdrawnBy: claim.withdrawnBy ? String(claim.withdrawnBy) : null,

    withdrawalReason: claim.withdrawalReason || null,
  };
}

/* ─────────────────────────────── DISPUTE RESPONSES ─────────────────────────────── */

function buildDisputeIssueResponse(issue) {
  if (!issue) {
    return null;
  }

  return {
    id: issue._id ? String(issue._id) : null,

    type: issue.type,

    affectedSettlementComponents: Array.isArray(issue.affectedSettlementComponents)
      ? [...issue.affectedSettlementComponents]
      : [],

    details: issue.details || null,

    statement: issue.statement || null,

    evidence: Array.isArray(issue.evidence) ? [...issue.evidence] : [],

    status: issue.status,

    professionalResponseStatement: issue.professionalResponseStatement || null,

    professionalCounterPosition: issue.professionalCounterPosition || null,

    professionalResponseEvidence: Array.isArray(issue.professionalResponseEvidence)
      ? [...issue.professionalResponseEvidence]
      : [],

    professionalRespondedAt: issue.professionalRespondedAt || null,

    professionalRespondedBy: issue.professionalRespondedBy
      ? String(issue.professionalRespondedBy)
      : null,

    professionalResponseExpiredAt: issue.professionalResponseExpiredAt || null,

    adminReviewStartedAt: issue.adminReviewStartedAt || null,

    adminDecision: issue.adminDecision || null,

    adminDecisionReason: issue.adminDecisionReason || null,

    adminDecidedAt: issue.adminDecidedAt || null,

    adminDecidedBy: issue.adminDecidedBy ? String(issue.adminDecidedBy) : null,

    adminOutcome: issue.adminOutcome || null,

    adminEvidence: Array.isArray(issue.adminEvidence) ? [...issue.adminEvidence] : [],

    resolvedAt: issue.resolvedAt || null,
  };
}

function buildDisputeResponse(dispute) {
  if (!dispute) {
    return null;
  }

  return {
    id: String(dispute._id),

    referenceCode: dispute.referenceCode,

    shiftId: dispute.shift ? String(dispute.shift) : null,

    occurrenceId: dispute.occurrence ? String(dispute.occurrence) : null,

    assignmentId: dispute.assignment ? String(dispute.assignment) : null,

    professionalId: dispute.professional ? String(dispute.professional) : null,

    businessId: dispute.business ? String(dispute.business) : null,

    branchId: dispute.branch ? String(dispute.branch) : null,

    submittedByUserId: dispute.submittedByUser ? String(dispute.submittedByUser) : null,

    submittedIssueTypes: Array.isArray(dispute.submittedIssueTypes)
      ? [...dispute.submittedIssueTypes]
      : [],

    affectedSettlementComponents: Array.isArray(dispute.affectedSettlementComponents)
      ? [...dispute.affectedSettlementComponents]
      : [],

    issues: Array.isArray(dispute.issues) ? dispute.issues.map(buildDisputeIssueResponse) : [],

    status: dispute.status,

    submittedAt: dispute.submittedAt || null,

    challengeWindowOpenedAt: dispute.challengeWindowOpenedAt || null,

    challengeDeadlineAt: dispute.challengeDeadlineAt || null,

    professionalResponseDeadlineAt: dispute.professionalResponseDeadlineAt || null,

    employerRefundId: dispute.employerRefund ? String(dispute.employerRefund) : null,

    resolvedAt: dispute.resolvedAt || null,

    withdrawnAt: dispute.withdrawnAt || null,

    withdrawnBy: dispute.withdrawnBy ? String(dispute.withdrawnBy) : null,

    withdrawalReason: dispute.withdrawalReason || null,
  };
}

/* ─────────────────────────────── OCCURRENCE RESPONSE ─────────────────────────────── */

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

    checkedInAt: occurrence.checkedInAt || null,

    checkedOutAt: occurrence.checkedOutAt || null,

    attendanceOverride: occurrence.attendanceOverride || null,

    baseBillableHours: occurrence.baseBillableHours ?? null,

    billableHours: occurrence.billableHours ?? null,

    baseProfessionalPay: Number(occurrence.baseProfessionalPay || 0),

    basePlatformFee: Number(occurrence.basePlatformFee || 0),

    baseSettlementStatus: occurrence.baseSettlement?.status || "not_due",

    overtimeProfessionalPay: Number(occurrence.overtimeProfessionalPay || 0),

    overtimePlatformFee: Number(occurrence.overtimePlatformFee || 0),

    overtimeSettlementStatus: occurrence.overtimeSettlement?.status || "not_due",

    topUpRequired: Number(occurrence.topUpRequired || 0),

    refundStatus: occurrence.refundStatus,

    refundableAmount: Number(occurrence.refundableAmount || 0),

    refundedAmount: Number(occurrence.refundedAmount || 0),

    activeClaimId: occurrence.activeClaim ? String(occurrence.activeClaim) : null,

    activeDisputeId: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
  };
}

/* ─────────────────────────────── REFUND RESPONSE ─────────────────────────────── */

function buildRefundReevaluationResponse(refundResult) {
  if (!refundResult) {
    return null;
  }

  const employerRefund = refundResult.employerRefund || null;

  let expectedRefundAmount = null;

  if (
    refundResult.expectedRefundAmount !== undefined &&
    refundResult.expectedRefundAmount !== null
  ) {
    expectedRefundAmount = Number(refundResult.expectedRefundAmount);
  } else if (refundResult.expectedRefund !== undefined && refundResult.expectedRefund !== null) {
    expectedRefundAmount = Number(refundResult.expectedRefund);
  } else if (employerRefund) {
    expectedRefundAmount = Number(employerRefund.amount || 0);
  }

  return {
    expectedRefundAmount,

    employerRefundId: employerRefund?._id ? String(employerRefund._id) : null,

    status: employerRefund?.status || null,

    amount: employerRefund ? Number(employerRefund.amount || 0) : 0,

    reason: employerRefund?.reason || null,

    eligible: refundResult.eligible === true,

    voided: refundResult.voided === true,

    idempotent: refundResult.idempotent === true,

    executionLocked: refundResult.executionLocked === true,

    reconciliationRequired: refundResult.reconciliationRequired === true,
  };
}

/* ─────────────────────────────── RESOLUTION MESSAGES ─────────────────────────────── */

function buildClaimResolutionMessage(decision) {
  switch (decision) {
    case "approve_professional":
      return "The claim issue was resolved in favor of the professional.";

    case "approve_employer":
      return "The claim issue was resolved in favor of the employer's position.";

    case "maintain_current":
      return "The claim issue was resolved with the current Loqum record maintained.";

    case "adjusted":
      return "The claim issue was resolved with an adjusted outcome.";

    default:
      return "The claim issue has been resolved.";
  }
}

function buildDisputeResolutionMessage(decision) {
  switch (decision) {
    case "approved":
      return "The employer dispute issue was approved.";

    case "rejected":
      return "The employer dispute issue was rejected.";

    case "adjusted":
      return "The employer dispute issue was resolved with an adjusted outcome.";

    default:
      return "The employer dispute issue has been resolved.";
  }
}

/* ─────────────────────────────── RESOLVE CLAIM ISSUE ─────────────────────────────── */

/**
 * Admin resolves one issue in a professional claim.
 *
 * Final occurrence facts, settlement continuation and refund
 * reevaluation remain owned by the resolution service.
 */
exports.resolveClaim = async (req, res) => {
  try {
    const result = await ShiftOccurrenceResolutionService.resolveClaimIssueByAdmin({
      claimId: req.params.claimId,

      issueId: req.params.issueId,

      adminUserId: getAdminUserId(req),

      decision: req.body.decision,

      reason: req.body.reason,

      adminOutcome: req.body.adminOutcome === undefined ? null : req.body.adminOutcome,

      evidence: req.body.evidence === undefined ? [] : req.body.evidence,

      currentTime: new Date(),
    });

    const decision = result?.decision || result?.issue?.adminDecision || null;

    const caseResolved = result?.caseResolved === true || result?.claim?.status === "resolved";

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildClaimResolutionMessage(decision),

      resolved: result?.resolved === true,

      final: result?.final === true,

      idempotent: result?.idempotent === true,

      caseResolved,

      decision,

      authoritativeChange: result?.authoritativeChange || null,

      settlementContinuation: Array.isArray(result?.settlementContinuation)
        ? result.settlementContinuation
        : [],

      refundReevaluation: buildRefundReevaluationResponse(result?.refundReevaluation),

      claim: buildClaimResponse(result?.claim),

      issue: buildClaimIssueResponse(result?.issue),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Admin professional claim issue resolution",

      fallbackMessage: "The claim issue could not be resolved.",

      fallbackCode: "OCCURRENCE_CLAIM_ISSUE_ADMIN_RESOLUTION_FAILED",
    });
  }
};

/* ─────────────────────────────── RESOLVE EMPLOYER DISPUTE ISSUE ─────────────────────────────── */

/**
 * Admin resolves one issue in an employer standalone dispute.
 *
 * Approval accepts the employer dispute position, rejection keeps the
 * professional/current authoritative position, and adjusted establishes
 * evidence-supported final facts through the resolution service.
 */
exports.resolveDispute = async (req, res) => {
  try {
    const result = await ShiftOccurrenceResolutionService.resolveDisputeIssueByAdmin({
      disputeId: req.params.disputeId,

      issueId: req.params.issueId,

      adminUserId: getAdminUserId(req),

      decision: req.body.decision,

      reason: req.body.reason,

      adminOutcome: req.body.adminOutcome === undefined ? null : req.body.adminOutcome,

      evidence: req.body.evidence === undefined ? [] : req.body.evidence,

      currentTime: new Date(),
    });

    const decision = result?.decision || result?.issue?.adminDecision || null;

    const caseResolved = result?.caseResolved === true || result?.dispute?.status === "resolved";

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildDisputeResolutionMessage(decision),

      resolved: result?.resolved === true,

      final: result?.final === true,

      idempotent: result?.idempotent === true,

      caseResolved,

      decision,

      authoritativeChange: result?.authoritativeChange || null,

      settlementContinuation: Array.isArray(result?.settlementContinuation)
        ? result.settlementContinuation
        : [],

      refundReevaluation: buildRefundReevaluationResponse(result?.refundReevaluation),

      dispute: buildDisputeResponse(result?.dispute),

      issue: buildDisputeIssueResponse(result?.issue),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Admin employer dispute issue resolution",

      fallbackMessage: "The employer dispute issue could not be resolved.",

      fallbackCode: "OCCURRENCE_DISPUTE_ISSUE_ADMIN_RESOLUTION_FAILED",
    });
  }
};
