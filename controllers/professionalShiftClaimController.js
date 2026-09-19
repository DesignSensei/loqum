// controllers/professionalShiftClaimController.js

const ShiftOccurrenceClaimService = require("../services/shiftOccurrenceClaimService");
const ShiftOccurrenceDisputeService = require("../services/shiftOccurrenceDisputeService");
const ShiftCasePageService = require("../services/shiftCasePageService");

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
    "ShiftRefundServiceError",
    "ShiftOccurrenceReconciliationServiceError",
    "ShiftOccurrenceResolutionServiceError",
    "ShiftSettlementServiceError",
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

function getEntityId(value) {
  if (!value) {
    return null;
  }

  return value._id ? String(value._id) : String(value);
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

function getProfessionalUserId(req) {
  const professionalUserId = req.user?._id;

  if (!professionalUserId) {
    const error = new Error("Professional user context is unavailable.");

    error.name = "ProfessionalShiftClaimControllerError";

    error.code = "PROFESSIONAL_USER_CONTEXT_REQUIRED";

    error.statusCode = 500;

    throw error;
  }

  return professionalUserId;
}

function getIdempotencyKey(req) {
  return String(req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim();
}

/* ─────────────────────────────── EVIDENCE RESPONSE ─────────────────────────────── */

/**
 * Expose only the evidence fields intentionally
 * supported by the Cases workflow.
 *
 * Raw Mongoose evidence subdocuments should not
 * become part of the browser API contract.
 */
function buildEvidenceResponse(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    type: item?.type || null,

    reference: item?.reference || null,

    description: item?.description || null,

    submittedByRole: item?.submittedByRole || null,

    submittedByUserId: getEntityId(item?.submittedByUser),

    recordedAt: item?.recordedAt || null,
  }));
}

/* ─────────────────────────────── SETTLEMENT SCOPE HELPERS ─────────────────────────────── */

function getClaimChallengedSettlementComponents(claim) {
  if (!claim || !Array.isArray(claim.issues)) {
    return [];
  }

  return [
    ...new Set(
      claim.issues.flatMap((issue) =>
        Array.isArray(issue.challengedSettlementComponents)
          ? issue.challengedSettlementComponents
          : []
      )
    ),
  ];
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

function getRemainingProfessionalResponseIssueIds(dispute) {
  if (!dispute || !Array.isArray(dispute.issues)) {
    return [];
  }

  return dispute.issues
    .filter((issue) => issue?.status === "awaiting_professional_response")
    .map((issue) => getEntityId(issue?._id))
    .filter(Boolean);
}

/* ─────────────────────────────── CLAIM RESPONSE ─────────────────────────────── */

function buildClaimIssueResponse(issue) {
  if (!issue) {
    return null;
  }

  return {
    id: getEntityId(issue._id),

    type: issue.type,

    challengedSettlementComponents: Array.isArray(issue.challengedSettlementComponents)
      ? [...issue.challengedSettlementComponents]
      : [],

    details: issue.details || null,

    statement: issue.statement || null,

    evidence: buildEvidenceResponse(issue.evidence),

    status: issue.status,

    employerDecision: issue.employerDecision || null,

    employerDecisionReason: issue.employerDecisionReason || null,

    employerDecidedAt: issue.employerDecidedAt || null,

    employerDecidedBy: getEntityId(issue.employerDecidedBy),

    employerCounterPosition: issue.employerCounterPosition || null,

    employerEvidence: buildEvidenceResponse(issue.employerEvidence),

    escalatedAt: issue.escalatedAt || null,

    escalationReason: issue.escalationReason || null,

    escalatedBy: getEntityId(issue.escalatedBy),

    escalationNotes: issue.escalationNotes || null,

    adminDecision: issue.adminDecision || null,

    adminDecisionReason: issue.adminDecisionReason || null,

    adminDecidedAt: issue.adminDecidedAt || null,

    adminDecidedBy: getEntityId(issue.adminDecidedBy),

    adminOutcome: issue.adminOutcome || null,

    adminEvidence: buildEvidenceResponse(issue.adminEvidence),

    resolvedAt: issue.resolvedAt || null,
  };
}

function buildClaimResponse(claim) {
  if (!claim) {
    return null;
  }

  return {
    id: getEntityId(claim._id),

    referenceCode: claim.referenceCode,

    shiftId: getEntityId(claim.shift),

    occurrenceId: getEntityId(claim.occurrence),

    submittedIssueTypes: Array.isArray(claim.submittedIssueTypes)
      ? [...claim.submittedIssueTypes]
      : [],

    challengedSettlementComponents: getClaimChallengedSettlementComponents(claim),

    issues: Array.isArray(claim.issues) ? claim.issues.map(buildClaimIssueResponse) : [],

    status: claim.status,

    submittedAt: claim.submittedAt || null,

    challengeWindowOpenedAt: claim.challengeWindowOpenedAt || null,

    challengeDeadlineAt: claim.challengeDeadlineAt || null,

    employerResponseDeadlineAt: claim.employerResponseDeadlineAt || null,

    employerRefundId: getEntityId(claim.employerRefund),

    resolvedAt: claim.resolvedAt || null,

    withdrawnAt: claim.withdrawnAt || null,

    withdrawnBy: getEntityId(claim.withdrawnBy),

    withdrawalReason: claim.withdrawalReason || null,
  };
}

/* ─────────────────────────────── DISPUTE RESPONSE ─────────────────────────────── */

function buildDisputeIssueResponse(issue) {
  if (!issue) {
    return null;
  }

  return {
    id: getEntityId(issue._id),

    type: issue.type,

    affectedSettlementComponents: Array.isArray(issue.affectedSettlementComponents)
      ? [...issue.affectedSettlementComponents]
      : [],

    details: issue.details || null,

    statement: issue.statement || null,

    evidence: buildEvidenceResponse(issue.evidence),

    status: issue.status,

    professionalResponseStatement: issue.professionalResponseStatement || null,

    professionalCounterPosition: issue.professionalCounterPosition || null,

    professionalResponseEvidence: buildEvidenceResponse(issue.professionalResponseEvidence),

    professionalRespondedAt: issue.professionalRespondedAt || null,

    professionalRespondedBy: getEntityId(issue.professionalRespondedBy),

    professionalResponseExpiredAt: issue.professionalResponseExpiredAt || null,

    adminReviewStartedAt: issue.adminReviewStartedAt || null,

    adminDecision: issue.adminDecision || null,

    adminDecisionReason: issue.adminDecisionReason || null,

    adminDecidedAt: issue.adminDecidedAt || null,

    adminDecidedBy: getEntityId(issue.adminDecidedBy),

    adminOutcome: issue.adminOutcome || null,

    adminEvidence: buildEvidenceResponse(issue.adminEvidence),

    resolvedAt: issue.resolvedAt || null,
  };
}

function buildDisputeResponse(dispute) {
  if (!dispute) {
    return null;
  }

  return {
    id: getEntityId(dispute._id),

    referenceCode: dispute.referenceCode,

    shiftId: getEntityId(dispute.shift),

    occurrenceId: getEntityId(dispute.occurrence),

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

    employerRefundId: getEntityId(dispute.employerRefund),

    resolvedAt: dispute.resolvedAt || null,

    withdrawnAt: dispute.withdrawnAt || null,

    withdrawnBy: getEntityId(dispute.withdrawnBy),

    withdrawalReason: dispute.withdrawalReason || null,
  };
}

/* ─────────────────────────────── OCCURRENCE RESPONSE ─────────────────────────────── */

/**
 * BASE and overtime settlement state are exposed
 * independently.
 *
 * Ordinary claim/dispute workflows belong to
 * BASE-side authority.
 *
 * The overtime workflow remains separate.
 */
function buildOccurrenceResponse(occurrence) {
  if (!occurrence) {
    return null;
  }

  return {
    id: getEntityId(occurrence._id),

    referenceCode: occurrence.referenceCode,

    slotNumber: Number(occurrence.slotNumber || 0),

    sequenceNumber: Number(occurrence.sequenceNumber || 0),

    occurrenceDate: occurrence.occurrenceDate || null,

    status: occurrence.status,

    attendanceStatus: occurrence.attendanceStatus,

    baseSettlementStatus: occurrence.baseSettlement?.status || "not_due",

    overtimeSettlementStatus: occurrence.overtimeSettlement?.status || "not_due",

    refundStatus: occurrence.refundStatus || null,

    activeClaimId: getEntityId(occurrence.activeClaim),

    activeDisputeId: getEntityId(occurrence.activeDispute),
  };
}

/* ─────────────────────────────── CASES PAGE ─────────────────────────────── */

exports.getCases = async (req, res, next) => {
  try {
    const casesView = await ShiftCasePageService.getProfessionalCasesPageData({
      professionalId: getProfessionalProfileId(req),

      type: req.query.type,

      status: req.query.status,

      page: req.query.page,
    });

    setNoStoreHeaders(res);

    return res.render("professional/cases/index", {
      layout: "layouts/app-layout",

      title: casesView.pageTitle,

      breadcrumbs: [
        {
          label: "Home",
          url: "/professional/dashboard",
        },

        {
          label: "Cases",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      casesView,

      scripts: '<script src="/js/cases.js"></script>',
    });
  } catch (error) {
    logger.error("Professional cases page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── RESPOND TO EMPLOYER DISPUTE ─────────────────────────────── */

/**
 * Professional submits the one permitted response
 * to one issue in an employer occurrence dispute.
 *
 * The professional may provide:
 *
 * - a response statement;
 * - a counter-position;
 * - evidence.
 *
 * After response submission, the issue proceeds
 * toward admin review.
 *
 * There is no later rebuttal or appeal stage.
 *
 * Eligibility, response-window enforcement and
 * transition to admin review remain service-owned.
 */
exports.respondToDispute = async (req, res) => {
  try {
    const result = await ShiftOccurrenceDisputeService.submitProfessionalResponse({
      disputeId: req.params.disputeId,

      issueId: req.params.issueId,

      professionalId: getProfessionalProfileId(req),

      submittedByUserId: getProfessionalUserId(req),

      statement: req.body.statement,

      counterPosition: req.body.counterPosition === undefined ? null : req.body.counterPosition,

      evidence: req.body.evidence === undefined ? [] : req.body.evidence,

      currentTime: new Date(),
    });

    const remainingProfessionalResponseIssueIds = Array.isArray(
      result?.remainingProfessionalResponseIssueIds
    )
      ? result.remainingProfessionalResponseIssueIds.map(getEntityId).filter(Boolean)
      : getRemainingProfessionalResponseIssueIds(result?.dispute);

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message:
        result?.idempotent === true
          ? "Your response has already been submitted."
          : "Your response has been submitted for admin review.",

      submitted: result?.submitted === true,

      idempotent: result?.idempotent === true,

      finalAdminReviewRequired: result?.finalAdminReviewRequired === true,

      remainingProfessionalResponseIssueIds,

      dispute: buildDisputeResponse(result?.dispute),

      issue: buildDisputeIssueResponse(result?.issue),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Professional employer-dispute response",

      fallbackMessage: "Your response could not be submitted. Please try again.",

      fallbackCode: "OCCURRENCE_DISPUTE_PROFESSIONAL_RESPONSE_FAILED",
    });
  }
};

/* ─────────────────────────────── SUBMIT CLAIM ─────────────────────────────── */

/**
 * Professional submits one original occurrence
 * claim case.
 *
 * One case may contain multiple ordinary
 * financial/factual BASE-side issues.
 *
 * The professional's original submission becomes
 * immutable once accepted.
 *
 * Issue validation, duplicate controversy checks,
 * challenge-window eligibility and settlement
 * scope remain service-owned.
 */
exports.submitClaim = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.submitClaim({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalId: professionalProfileId,

      submittedByUserId: getProfessionalUserId(req),

      issues: req.body.issues,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    const submittedIssueTypes = Array.isArray(result?.submittedIssueTypes)
      ? [...result.submittedIssueTypes]
      : Array.isArray(result?.claim?.submittedIssueTypes)
        ? [...result.claim.submittedIssueTypes]
        : [];

    const challengedSettlementComponents = Array.isArray(result?.challengedSettlementComponents)
      ? [...result.challengedSettlementComponents]
      : getClaimChallengedSettlementComponents(result?.claim);

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

      challengedSettlementComponents,

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

/* ─────────────────────────────── WITHDRAW CLAIM ─────────────────────────────── */

/**
 * Withdrawal applies to the entire professional
 * claim case.
 *
 * Withdrawal consumes the original claim right.
 *
 * A professional may not use withdrawal as a
 * mechanism to replace or revise an immutable
 * original submission.
 *
 * Eligibility, timing, restoration/finalization
 * consequences and lifecycle transitions remain
 * service-owned.
 */
exports.withdrawClaim = async (req, res) => {
  try {
    const result = await ShiftOccurrenceClaimService.withdrawClaim({
      claimId: req.params.claimId,

      professionalId: getProfessionalProfileId(req),

      withdrawnByUserId: getProfessionalUserId(req),

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
