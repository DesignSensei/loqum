// controllers/employerShiftClaimController.js

const ShiftOccurrenceClaimService = require("../services/shiftOccurrenceClaimService");
const ShiftOccurrenceDisputeService = require("../services/shiftOccurrenceDisputeService");

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
    "ShiftOccurrenceDisputeServiceError",
    "ShiftOccurrenceResolutionServiceError",
    "ShiftOccurrenceReconciliationServiceError",
    "ShiftRefundServiceError",
    "ShiftSettlementServiceError",
    "EmployerShiftClaimControllerError",
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

    error.name = "EmployerShiftClaimControllerError";

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

    error.name = "EmployerShiftClaimControllerError";

    error.code = "EMPLOYER_USER_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return employerUserId;
}

function getIdempotencyKey(req) {
  return String(req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim();
}

/* ─────────────────────────────── CLAIM RESPONSE ─────────────────────────────── */

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

    professionalId: claim.professional ? String(claim.professional) : null,

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

/* ─────────────────────────────── DISPUTE RESPONSE ─────────────────────────────── */

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

function getDisputeAffectedSettlementComponents(dispute) {
  if (!dispute || !Array.isArray(dispute.issues)) {
    return [];
  }

  return [
    ...new Set(
      dispute.issues.flatMap((issue) =>
        Array.isArray(issue.affectedSettlementComponents) ? issue.affectedSettlementComponents : []
      )
    ),
  ];
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

    professionalId: dispute.professional ? String(dispute.professional) : null,

    submittedIssueTypes: Array.isArray(dispute.submittedIssueTypes)
      ? [...dispute.submittedIssueTypes]
      : [],

    affectedSettlementComponents: getDisputeAffectedSettlementComponents(dispute),

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

    baseSettlementStatus: occurrence.baseSettlement?.status || "not_due",

    overtimeSettlementStatus: occurrence.overtimeSettlement?.status || "not_due",

    refundStatus: occurrence.refundStatus,

    refundableAmount: Number(occurrence.refundableAmount || 0),

    refundedAmount: Number(occurrence.refundedAmount || 0),

    topUpRequired: Number(occurrence.topUpRequired || 0),

    activeClaimId: occurrence.activeClaim ? String(occurrence.activeClaim) : null,

    activeDisputeId: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
  };
}

/* ─────────────────────────────── CLAIM REVIEW MESSAGE ─────────────────────────────── */

function buildClaimReviewSuccessMessage(result) {
  const decision = result?.issue?.employerDecision;

  if (decision === "approved") {
    return "The claim issue has been approved.";
  }

  if (decision === "rejected") {
    if (result?.appealAvailable === true) {
      return "The claim issue has been rejected. " + "The professional may request a review.";
    }

    if (result?.rebuttalAvailable === true) {
      return (
        "The claim issue has been rejected. " +
        "The professional may respond to the employer's position."
      );
    }

    return "The claim issue has been rejected.";
  }

  return "The claim issue has been reviewed.";
}

/* ─────────────────────────────── SUBMIT EMPLOYER DISPUTE ─────────────────────────────── */

/**
 * Employer submits one original occurrence dispute case.
 *
 * The case may contain one or more ordinary BASE-side issues.
 * The dispute service validates issue details, derives financial scope,
 * prevents duplicate controversy and owns the shared challenge-window rules.
 */
exports.submitDispute = async (req, res) => {
  try {
    const result = await ShiftOccurrenceDisputeService.submitDispute({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      employerProfileId: getEmployerProfileId(req),

      employerUserId: getEmployerUserId(req),

      employerContext: req.employerContext || null,

      issues: req.body.issues,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    const dispute = buildDisputeResponse(result?.dispute);

    const submittedIssueTypes = Array.isArray(result?.dispute?.submittedIssueTypes)
      ? [...result.dispute.submittedIssueTypes]
      : [];

    const affectedSettlementComponents = getDisputeAffectedSettlementComponents(result?.dispute);

    setNoStoreHeaders(res);

    return res.status(result?.created === true ? 201 : 200).json({
      success: true,

      message:
        result?.idempotent === true
          ? "This dispute has already been submitted."
          : "The dispute has been submitted.",

      created: result?.created === true,

      idempotent: result?.idempotent === true,

      coexistsWithProfessionalClaim: result?.coexistsWithProfessionalClaim === true,

      submittedIssueTypes,

      affectedSettlementComponents,

      professionalResponseDeadlineAt: result?.dispute?.professionalResponseDeadlineAt || null,

      dispute,

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer occurrence dispute submission",

      fallbackMessage: "The dispute could not be submitted. Please try again.",

      fallbackCode: "OCCURRENCE_DISPUTE_SUBMISSION_FAILED",
    });
  }
};

/* ─────────────────────────────── REVIEW CLAIM ISSUE ─────────────────────────────── */

/**
 * Employer reviews one issue in an active professional claim.
 *
 * Employer review resolves an existing controversy. Issue scope,
 * response eligibility and final financial authority remain service-owned.
 */
exports.reviewClaim = async (req, res) => {
  try {
    const result = await ShiftOccurrenceClaimService.reviewClaimByEmployer({
      claimId: req.params.claimId,

      issueId: req.params.issueId,

      employerProfileId: getEmployerProfileId(req),

      employerUserId: getEmployerUserId(req),

      employerContext: req.employerContext || null,

      decision: req.body.decision,

      reason: req.body.reason,

      counterPosition: req.body.counterPosition === undefined ? null : req.body.counterPosition,

      evidence: req.body.evidence === undefined ? [] : req.body.evidence,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildClaimReviewSuccessMessage(result),

      resolved: result?.resolved === true,

      issueResolved: result?.issueResolved === true,

      caseResolved: result?.caseResolved === true,

      appealAvailable: result?.appealAvailable === true,

      appealDeadlineAt: result?.appealDeadlineAt || result?.issue?.appealDeadlineAt || null,

      rebuttalAvailable: result?.rebuttalAvailable === true,

      rebuttalDeadlineAt: result?.rebuttalDeadlineAt || result?.issue?.rebuttalDeadlineAt || null,

      employerCounterPosition:
        result?.employerCounterPosition || result?.issue?.employerCounterPosition || null,

      claim: buildClaimResponse(result?.claim),

      issue: buildClaimIssueResponse(result?.issue),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer occurrence claim issue review",

      fallbackMessage: "The claim issue could not be reviewed. Please try again.",

      fallbackCode: "OCCURRENCE_CLAIM_REVIEW_FAILED",
    });
  }
};
