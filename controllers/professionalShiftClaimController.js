// controllers/professionalShiftClaimController.js

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
    "ShiftOccurrenceResolutionServiceError",
    "ProfessionalShiftClaimControllerError",
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

function getProfessionalProfileId(req) {
  const professionalProfileId = req.professionalProfile?._id;

  if (!professionalProfileId) {
    const error = new Error("Professional profile context is unavailable.");

    error.name = "ProfessionalShiftClaimControllerError";
    error.code = "PROFESSIONAL_PROFILE_CONTEXT_REQUIRED";
    error.statusCode = 500;

    throw error;
  }

  return professionalProfileId;
}

function getIdempotencyKey(req) {
  return String(req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim();
}

function getClaimAffectedSettlementComponents(claim) {
  if (!claim || !Array.isArray(claim.issues)) {
    return [];
  }

  return [
    ...new Set(
      claim.issues.flatMap((issue) =>
        Array.isArray(issue.affectedSettlementComponents) ? issue.affectedSettlementComponents : []
      )
    ),
  ];
}

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

    submittedIssueTypes: Array.isArray(claim.submittedIssueTypes)
      ? [...claim.submittedIssueTypes]
      : [],

    issues: Array.isArray(claim.issues)
      ? claim.issues.map((issue) => buildClaimIssueResponse(issue))
      : [],

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

    activeClaimId: occurrence.activeClaim ? String(occurrence.activeClaim) : null,

    activeDisputeId: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
  };
}

/* ─────────────────────────────── SUBMIT CLAIM ─────────────────────────────── */

/**
 * One occurrence claim case may contain multiple financial issues.
 * Issue validation and settlement scope are service-owned.
 */
exports.submitClaim = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.submitClaim({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalId: professionalProfileId,

      submittedByUserId: req.user._id,

      issues: req.body.issues,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    const submittedIssueTypes = Array.isArray(result?.submittedIssueTypes)
      ? [...result.submittedIssueTypes]
      : Array.isArray(result?.claim?.submittedIssueTypes)
        ? [...result.claim.submittedIssueTypes]
        : [];

    const affectedSettlementComponents = Array.isArray(result?.affectedSettlementComponents)
      ? [...result.affectedSettlementComponents]
      : getClaimAffectedSettlementComponents(result?.claim);

    setNoStoreHeaders(res);

    return res.status(result?.created === true ? 201 : 200).json({
      success: true,

      message:
        result?.idempotent === true
          ? "This claim has already been submitted."
          : "Your claim has been submitted.",

      created: result?.created === true,

      idempotent: result?.idempotent === true,

      submittedIssueTypes,

      affectedSettlementComponents,

      employerResponseDeadlineAt:
        result?.employerResponseDeadlineAt || result?.claim?.employerResponseDeadlineAt || null,

      claim: buildClaimResponse(result?.claim),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional occurrence claim submission",

      fallbackMessage: "Your claim could not be submitted. Please try again.",

      fallbackCode: "OCCURRENCE_CLAIM_SUBMISSION_FAILED",
    });
  }
};

/* ─────────────────────────────── SUBMIT APPEAL ─────────────────────────────── */

/**
 * Appeal applies to one rejected issue without an employer counter-position.
 */
exports.submitAppeal = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.submitAppeal({
      claimId: req.params.claimId,

      issueId: req.params.issueId,

      professionalId: professionalProfileId,

      submittedByUserId: req.user._id,

      statement: req.body.statement,

      evidence: req.body.evidence === undefined ? [] : req.body.evidence,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "Your appeal has been submitted for review.",

      submitted: result?.submitted === true,

      issueStatus: result?.issueStatus || result?.issue?.status || null,

      finalAdminReviewRequired: result?.finalAdminReviewRequired === true,

      claim: buildClaimResponse(result?.claim),

      issue: buildClaimIssueResponse(result?.issue),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional occurrence claim appeal",

      fallbackMessage: "Your appeal could not be submitted. Please try again.",

      fallbackCode: "OCCURRENCE_CLAIM_APPEAL_FAILED",
    });
  }
};

/* ─────────────────────────────── SUBMIT REBUTTAL ─────────────────────────────── */

/**
 * Rebuttal applies to one rejected issue with an employer counter-position.
 */
exports.submitRebuttal = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.submitRebuttal({
      claimId: req.params.claimId,

      issueId: req.params.issueId,

      professionalId: professionalProfileId,

      submittedByUserId: req.user._id,

      statement: req.body.statement,

      evidence: req.body.evidence === undefined ? [] : req.body.evidence,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "Your response has been submitted for review.",

      submitted: result?.submitted === true,

      issueStatus: result?.issueStatus || result?.issue?.status || null,

      rebuttalStatus: result?.rebuttalStatus || result?.issue?.rebuttalStatus || null,

      finalAdminReviewRequired: result?.finalAdminReviewRequired === true,

      claim: buildClaimResponse(result?.claim),

      issue: buildClaimIssueResponse(result?.issue),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional occurrence claim rebuttal",

      fallbackMessage: "Your response could not be submitted. Please try again.",

      fallbackCode: "OCCURRENCE_CLAIM_REBUTTAL_FAILED",
    });
  }
};

/* ─────────────────────────────── WITHDRAW CLAIM ─────────────────────────────── */

/**
 * Withdrawal applies to the entire claim case and consumes the original claim right.
 */
exports.withdrawClaim = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.withdrawClaim({
      claimId: req.params.claimId,

      professionalId: professionalProfileId,

      withdrawnByUserId: req.user._id,

      reason: req.body.reason,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "Your claim has been withdrawn.",

      withdrawn: result?.withdrawn === true,

      claim: buildClaimResponse(result?.claim),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional occurrence claim withdrawal",

      fallbackMessage: "Your claim could not be withdrawn. Please try again.",

      fallbackCode: "OCCURRENCE_CLAIM_WITHDRAWAL_FAILED",
    });
  }
};
