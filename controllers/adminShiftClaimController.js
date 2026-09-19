// controllers/adminShiftClaimController.js

const ShiftOccurrenceResolutionService = require("../services/shiftOccurrenceResolutionService");
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

function getEntityId(value) {
  if (!value) {
    return null;
  }

  return value._id ? String(value._id) : String(value);
}

/* ─────────────────────────────── EVIDENCE RESPONSE ─────────────────────────────── */

/**
 * Exposes only the evidence fields intentionally supported by
 * the Cases workflow rather than returning raw Mongoose subdocuments.
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

/* ─────────────────────────────── CLAIM RESPONSES ─────────────────────────────── */

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
    assignmentId: getEntityId(claim.assignment),
    professionalId: getEntityId(claim.professional),
    businessId: getEntityId(claim.business),
    branchId: getEntityId(claim.branch),

    submittedByUserId: getEntityId(claim.submittedByUser),

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

/* ─────────────────────────────── DISPUTE RESPONSES ─────────────────────────────── */

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
    assignmentId: getEntityId(dispute.assignment),
    professionalId: getEntityId(dispute.professional),
    businessId: getEntityId(dispute.business),
    branchId: getEntityId(dispute.branch),

    submittedByUserId: getEntityId(dispute.submittedByUser),

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
 * BASE and overtime settlement state are intentionally exposed
 * independently.
 *
 * Ordinary claim/dispute adjudication belongs to BASE-side authority.
 * The overtime workflow remains independently represented.
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

    refundStatus: occurrence.refundStatus || null,

    refundableAmount: Number(occurrence.refundableAmount || 0),

    refundedAmount: Number(occurrence.refundedAmount || 0),

    activeClaimId: getEntityId(occurrence.activeClaim),

    activeDisputeId: getEntityId(occurrence.activeDispute),
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

    employerRefundId: getEntityId(employerRefund),

    status: employerRefund?.status || null,

    amount: employerRefund ? Number(employerRefund.amount || 0) : 0,

    reason: employerRefund?.reason || null,

    eligible: refundResult.eligible === true,

    voided: refundResult.voided === true,

    idempotent: refundResult.idempotent === true,

    executionLocked: refundResult.executionLocked === true,

    revalidationRequired: refundResult.revalidationRequired === true,

    reconciliationRequired: refundResult.reconciliationRequired === true,
  };
}

/* ─────────────────────────────── PREVIEW RESPONSE ─────────────────────────────── */

/**
 * ShiftOccurrenceResolutionService.buildResolutionPreview()
 * currently exposes:
 *
 * current
 * proposed
 * impact
 * refundRequiresReevaluation
 * attendanceChanged
 * basePlatformFeeUnchanged
 * settlementImpact
 *
 * Keep the controller response explicit so service internals cannot
 * accidentally become part of the public Cases frontend contract.
 */
function buildResolutionPreviewResponse(preview) {
  if (!preview || typeof preview !== "object") {
    return null;
  }

  const current = preview.current || {};
  const proposed = preview.proposed || {};
  const impact = preview.impact || {};
  const settlementImpact = preview.settlementImpact || {};

  return {
    current: {
      baseProfessionalPay: Number(current.baseProfessionalPay || 0),

      basePlatformFee: Number(current.basePlatformFee || 0),
    },

    proposed: {
      baseProfessionalPay: Number(proposed.baseProfessionalPay || 0),

      basePlatformFee: Number(proposed.basePlatformFee || 0),
    },

    impact: {
      professionalPayoutChange: Number(impact.professionalPayoutChange || 0),

      employerRefundChange:
        impact.employerRefundChange === undefined || impact.employerRefundChange === null
          ? null
          : Number(impact.employerRefundChange),

      employerRefundRequiresReevaluation: impact.employerRefundRequiresReevaluation === true,
    },

    refundRequiresReevaluation: preview.refundRequiresReevaluation === true,

    attendanceChanged: preview.attendanceChanged === true,

    basePlatformFeeUnchanged: preview.basePlatformFeeUnchanged === true,

    settlementImpact: {
      requiresSettlementRecheck: settlementImpact.requiresSettlementRecheck === true,
    },
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
      return "The employer dispute issue was upheld and the final authoritative outcome was recorded.";

    case "rejected":
      return "The employer dispute issue was rejected and the current Loqum record was maintained.";

    default:
      return "The employer dispute issue has been resolved.";
  }
}

/* ─────────────────────────────── CASES PAGE ─────────────────────────────── */

exports.getCases = async (req, res, next) => {
  try {
    const casesView = await ShiftCasePageService.getAdminCasesPageData({
      type: req.query.type,
      status: req.query.status,
      page: req.query.page,
    });

    setNoStoreHeaders(res);

    return res.render("admin/cases/index", {
      layout: "layouts/app-layout",

      title: casesView.pageTitle,

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },
        {
          label: casesView.pageTitle,
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      casesView,

      scripts: '<script src="/js/cases.js"></script>',
    });
  } catch (error) {
    logger.error("Admin cases page error:", error);

    return next(error);
  }
};

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
 * Approval means the employer established that current Loqum
 * authority requires correction.
 *
 * adminOutcome records the final evidence-supported
 * authoritative fact/value.
 *
 * Rejection maintains current Loqum authority.
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

/* ─────────────────────────────── PREVIEW CLAIM RESOLUTION ─────────────────────────────── */

exports.previewClaimResolution = async (req, res) => {
  try {
    const result = await ShiftOccurrenceResolutionService.previewClaimIssueResolution({
      claimId: req.params.claimId,

      issueId: req.params.issueId,

      adminUserId: getAdminUserId(req),

      decision: req.body.decision,

      adminOutcome: req.body.adminOutcome === undefined ? null : req.body.adminOutcome,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      preview: buildResolutionPreviewResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Admin professional claim issue resolution preview",

      fallbackMessage: "The claim issue preview could not be generated.",

      fallbackCode: "OCCURRENCE_CLAIM_ISSUE_ADMIN_PREVIEW_FAILED",
    });
  }
};

/* ─────────────────────────────── PREVIEW DISPUTE RESOLUTION ─────────────────────────────── */

exports.previewDisputeResolution = async (req, res) => {
  try {
    const result = await ShiftOccurrenceResolutionService.previewDisputeIssueResolution({
      disputeId: req.params.disputeId,

      issueId: req.params.issueId,

      adminUserId: getAdminUserId(req),

      decision: req.body.decision,

      adminOutcome: req.body.adminOutcome === undefined ? null : req.body.adminOutcome,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      preview: buildResolutionPreviewResponse(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Admin employer dispute issue resolution preview",

      fallbackMessage: "The employer dispute preview could not be generated.",

      fallbackCode: "OCCURRENCE_DISPUTE_ISSUE_ADMIN_PREVIEW_FAILED",
    });
  }
};
