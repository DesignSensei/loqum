// controllers/employerShiftClaimController.js

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

function getEntityId(value) {
  if (!value) {
    return null;
  }

  return value._id ? String(value._id) : String(value);
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

/* ─────────────────────────────── EVIDENCE RESPONSE ─────────────────────────────── */

/**
 * Expose only the evidence fields supported by
 * the Cases workflow.
 *
 * Do not return raw Mongoose subdocuments to
 * the browser.
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

/* ─────────────────────────────── CLAIM RESPONSE ─────────────────────────────── */

function buildClaimIssueResponse(issue) {
  if (!issue) {
    return null;
  }

  return {
    id: issue._id ? String(issue._id) : null,

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
    id: String(claim._id),

    referenceCode: claim.referenceCode,

    shiftId: getEntityId(claim.shift),

    occurrenceId: getEntityId(claim.occurrence),

    professionalId: getEntityId(claim.professional),

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
    id: issue._id ? String(issue._id) : null,

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
    id: String(dispute._id),

    referenceCode: dispute.referenceCode,

    shiftId: getEntityId(dispute.shift),

    occurrenceId: getEntityId(dispute.occurrence),

    professionalId: getEntityId(dispute.professional),

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
 * BASE and overtime settlement states are
 * deliberately exposed separately.
 *
 * Ordinary claim/dispute cases operate on the
 * BASE-side authority.
 *
 * The overtime workflow remains independently
 * represented and is not collapsed into a generic
 * settlement status.
 */
function buildOccurrenceResponse(occurrence) {
  if (!occurrence) {
    return null;
  }

  return {
    id: String(occurrence._id),

    referenceCode: occurrence.referenceCode,

    slotNumber: Number(occurrence.slotNumber || 0),

    sequenceNumber: Number(occurrence.sequenceNumber || 0),

    occurrenceDate: occurrence.occurrenceDate || null,

    status: occurrence.status,

    attendanceStatus: occurrence.attendanceStatus,

    baseSettlementStatus: occurrence.baseSettlement?.status || "not_due",

    overtimeSettlementStatus: occurrence.overtimeSettlement?.status || "not_due",

    refundStatus: occurrence.refundStatus || null,

    refundableAmount: Number(occurrence.refundableAmount || 0),

    refundedAmount: Number(occurrence.refundedAmount || 0),

    topUpRequired: Number(occurrence.topUpRequired || 0),

    activeClaimId: getEntityId(occurrence.activeClaim),

    activeDisputeId: getEntityId(occurrence.activeDispute),
  };
}

/* ─────────────────────────────── CLAIM REVIEW MESSAGE ─────────────────────────────── */

function buildClaimReviewSuccessMessage(result) {
  const decision = result?.issue?.employerDecision;

  if (decision === "approved") {
    return "The claim issue has been approved.";
  }

  if (decision === "rejected") {
    return "The claim issue has been rejected and sent for admin review.";
  }

  return "The claim issue has been reviewed.";
}

/* ─────────────────────────────── CASES PAGE ─────────────────────────────── */

exports.getCases = async (req, res, next) => {
  try {
    const casesView = await ShiftCasePageService.getEmployerCasesPageData({
      businessId: getEmployerProfileId(req),

      employerContext: req.employerContext || null,

      type: req.query.type,

      status: req.query.status,

      page: req.query.page,
    });

    setNoStoreHeaders(res);

    return res.render("employer/cases/index", {
      layout: "layouts/app-layout",

      title: casesView.pageTitle,

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
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
    logger.error("Employer cases page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── SUBMIT EMPLOYER DISPUTE ─────────────────────────────── */

/**
 * Employer submits one original occurrence
 * dispute case.
 *
 * The case may contain one or more ordinary
 * BASE-side issues.
 *
 * The dispute service owns:
 *
 * - business / branch authorization;
 * - issue validation;
 * - financial scope derivation;
 * - duplicate controversy prevention;
 * - challenge-window enforcement;
 * - coexistence rules with professional claims.
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

/* ─────────────────────────────── WITHDRAW EMPLOYER DISPUTE ─────────────────────────────── */

/**
 * Employer withdrawal eligibility remains
 * service-owned.
 *
 * The service must ensure that the dispute:
 *
 * - belongs to the employer;
 * - is within branch scope;
 * - remains withdrawable;
 * - has not received a professional response;
 * - has not entered admin review;
 * - remains inside the response window.
 */
exports.withdrawDispute = async (req, res) => {
  try {
    const result = await ShiftOccurrenceDisputeService.withdrawDispute({
      disputeId: req.params.disputeId,

      employerProfileId: getEmployerProfileId(req),

      employerUserId: getEmployerUserId(req),

      employerContext: req.employerContext || null,

      reason: req.body.reason,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message:
        result?.idempotent === true
          ? "This dispute has already been withdrawn."
          : "The dispute has been withdrawn.",

      withdrawn: result?.withdrawn === true,

      idempotent: result?.idempotent === true,

      professionalClaimStillActive: result?.professionalClaimStillActive === true,

      dispute: buildDisputeResponse(result?.dispute),

      occurrence: buildOccurrenceResponse(result?.occurrence),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer occurrence dispute withdrawal",

      fallbackMessage: "The dispute could not be withdrawn. Please try again.",

      fallbackCode: "OCCURRENCE_DISPUTE_WITHDRAWAL_FAILED",
    });
  }
};

/* ─────────────────────────────── REVIEW CLAIM ISSUE ─────────────────────────────── */

/**
 * Employer reviews one issue in an active
 * professional claim.
 *
 * The original professional submission remains
 * immutable.
 *
 * Employer may:
 *
 * - approve the professional position; or
 * - reject/disagree and optionally provide a
 *   counter-position and evidence.
 *
 * Rejection/disagreement moves the issue to
 * admin review.
 *
 * There is no professional rebuttal or appeal
 * stage.
 *
 * Issue scope, response eligibility, business /
 * branch authorization and final financial
 * authority remain service-owned.
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
