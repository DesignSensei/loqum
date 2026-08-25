// controllers/employerShiftClaimController.js

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
    "ShiftOccurrenceResolutionServiceError",
    "ShiftRefundServiceError",
    "ShiftOccurrenceReconciliationServiceError",
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

    claimType: claim.claimType,

    affectedSettlementComponents: Array.isArray(claim.affectedSettlementComponents)
      ? [...claim.affectedSettlementComponents]
      : [],

    issueDetails: claim.issueDetails || null,

    status: claim.status,

    submittedAt: claim.submittedAt,

    claimWindowOpenedAt: claim.claimWindowOpenedAt || null,

    claimDeadlineAt: claim.claimDeadlineAt || null,

    employerResponseDeadlineAt: claim.employerResponseDeadlineAt || null,

    employerFinancialDecision: claim.employerFinancialDecision || null,

    employerDecisionReason: claim.employerDecisionReason || null,

    employerDecidedAt: claim.employerDecidedAt || null,

    employerDecidedBy: claim.employerDecidedBy ? String(claim.employerDecidedBy) : null,

    appealStatus: claim.appealStatus,

    appealDeadlineAt: claim.appealDeadlineAt || null,

    appealedAt: claim.appealedAt || null,

    escalatedAt: claim.escalatedAt || null,

    escalationReason: claim.escalationReason || null,

    adminFinancialDecision: claim.adminFinancialDecision || null,

    adminDecisionReason: claim.adminDecisionReason || null,

    adminDecidedAt: claim.adminDecidedAt || null,

    employerRefundId: claim.employerRefund ? String(claim.employerRefund) : null,

    resolvedAt: claim.resolvedAt || null,

    withdrawnAt: claim.withdrawnAt || null,
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

    refundableAmount: Number(occurrence.refundableAmount || 0),

    refundedAmount: Number(occurrence.refundedAmount || 0),

    topUpRequired: Number(occurrence.topUpRequired || 0),

    activeClaimId: occurrence.activeClaim ? String(occurrence.activeClaim) : null,

    activeDisputeId: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
  };
}

function buildRefundResponse(refundResult) {
  if (!refundResult) {
    return null;
  }

  const employerRefund = refundResult.employerRefund || refundResult.refund || null;

  return {
    expectedRefund: Number(refundResult.expectedRefund || 0),

    refundReason: refundResult.refundReason || null,

    voided: refundResult.voided === true,

    created: refundResult.created === true,

    idempotent: refundResult.idempotent === true,

    employerRefundId: employerRefund?._id ? String(employerRefund._id) : null,

    status: employerRefund?.status || null,

    amount: employerRefund ? Number(employerRefund.amount || 0) : 0,
  };
}

function buildSuccessMessage(result) {
  const decision = result?.claim?.employerFinancialDecision;

  if (decision === "approved") {
    return "The claim has been approved.";
  }

  if (decision === "rejected") {
    return result.appealAvailable === true
      ? "The claim has been rejected. The professional may appeal."
      : "The claim has been rejected.";
  }

  return "The claim has been reviewed.";
}

/* ─────────────────────────────── REVIEW CLAIM ─────────────────────────────── */

/**
 * Employer reviews one original professional occurrence claim.
 *
 * Claims in this workflow are financially relevant:
 *
 * - attendance_correction
 * - payment_calculation
 * - employer_fault
 *
 * Employer decision:
 *
 * - approved
 * - rejected
 *
 * Absence explanations do not enter this controller. They belong to the
 * attendance workflow and are not classified as excused or unexcused.
 *
 * affectedSettlementComponents was derived and frozen when the professional
 * submitted the claim. The employer cannot expand or replace that scope.
 *
 * APPROVAL
 *
 * An approved claim may apply occurrenceResolution. The claim service passes
 * that resolution to the authoritative occurrence-resolution layer, clears
 * the active claim and reevaluates the employer refund dependency.
 *
 * REJECTION
 *
 * A rejected claim cannot apply occurrenceResolution. The occurrence remains
 * protected while the professional's appeal opportunity is available.
 *
 * Employer/business/branch authority comes exclusively from authenticated
 * request context and employer middleware.
 */
exports.reviewClaim = async (req, res) => {
  try {
    const result = await ShiftOccurrenceClaimService.reviewClaimByEmployer({
      claimId: req.params.claimId,

      employerProfileId: getEmployerProfileId(req),

      employerUserId: getEmployerUserId(req),

      employerContext: req.employerContext || null,

      decision: req.body.decision,

      reason: req.body.reason,

      occurrenceResolution:
        req.body.occurrenceResolution &&
        typeof req.body.occurrenceResolution === "object" &&
        !Array.isArray(req.body.occurrenceResolution)
          ? req.body.occurrenceResolution
          : null,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: buildSuccessMessage(result),

      resolved: result.resolved === true,

      appealAvailable: result.appealAvailable === true,

      appealDeadlineAt: result.appealDeadlineAt || result.claim?.appealDeadlineAt || null,

      claim: buildClaimResponse(result.claim),

      occurrence: buildOccurrenceResponse(result.occurrence),

      refund: buildRefundResponse(result.refundResult),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer occurrence claim review",

      fallbackMessage: "The claim could not be reviewed. Please try again.",

      fallbackCode: "OCCURRENCE_CLAIM_REVIEW_FAILED",
    });
  }
};
