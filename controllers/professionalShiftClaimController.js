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

function buildAttendanceCorrectionInput(body = {}) {
  if (
    body.attendanceCorrection &&
    typeof body.attendanceCorrection === "object" &&
    !Array.isArray(body.attendanceCorrection)
  ) {
    return body.attendanceCorrection;
  }

  const correctedCheckInAt = body.correctedCheckInAt;
  const correctedCheckOutAt = body.correctedCheckOutAt;

  const hasCorrectedCheckInAt =
    correctedCheckInAt !== undefined && correctedCheckInAt !== null && correctedCheckInAt !== "";

  const hasCorrectedCheckOutAt =
    correctedCheckOutAt !== undefined && correctedCheckOutAt !== null && correctedCheckOutAt !== "";

  if (!hasCorrectedCheckInAt && !hasCorrectedCheckOutAt) {
    return null;
  }

  return {
    correctedCheckInAt: hasCorrectedCheckInAt ? correctedCheckInAt : null,

    correctedCheckOutAt: hasCorrectedCheckOutAt ? correctedCheckOutAt : null,
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

    claimType: claim.claimType,

    affectedSettlementComponents: Array.isArray(claim.affectedSettlementComponents)
      ? [...claim.affectedSettlementComponents]
      : [],

    issueDetails: claim.issueDetails || null,

    status: claim.status,

    submittedAt: claim.submittedAt,

    claimWindowOpenedAt: claim.claimWindowOpenedAt || null,

    claimDeadlineAt: claim.claimDeadlineAt,

    employerResponseDeadlineAt: claim.employerResponseDeadlineAt || null,

    employerFinancialDecision: claim.employerFinancialDecision || null,

    employerDecisionReason: claim.employerDecisionReason || null,

    employerDecidedAt: claim.employerDecidedAt || null,

    appealStatus: claim.appealStatus,

    appealDeadlineAt: claim.appealDeadlineAt || null,

    appealedAt: claim.appealedAt || null,

    escalationReason: claim.escalationReason || null,

    escalatedAt: claim.escalatedAt || null,

    adminFinancialDecision: claim.adminFinancialDecision || null,

    adminDecisionReason: claim.adminDecisionReason || null,

    adminDecidedAt: claim.adminDecidedAt || null,

    employerRefundId: claim.employerRefund ? String(claim.employerRefund) : null,

    resolvedAt: claim.resolvedAt || null,

    withdrawnAt: claim.withdrawnAt || null,

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
 * Professional submits the one original financially relevant claim available
 * for an assigned occurrence.
 *
 * Supported claim flows are service-owned:
 *
 * - attendance_correction
 * - payment_calculation
 * - employer_fault
 *
 * Absence explanations do not enter this controller. They belong to the
 * professional attendance controller.
 *
 * The claim service derives and freezes affectedSettlementComponents from the
 * submitted issue details. The controller never accepts a client-supplied
 * settlement-component scope as authority.
 */
exports.submitClaim = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.submitClaim({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      professionalId: professionalProfileId,

      submittedByUserId: req.user._id,

      claimType: req.body.claimType,

      attendanceCorrection: buildAttendanceCorrectionInput(req.body),

      payIssueArea: req.body.payIssueArea,

      statement: req.body.statement,

      evidence: req.body.evidence || [],

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(result.created === true ? 201 : 200).json({
      success: true,

      message:
        result.idempotent === true
          ? "This claim has already been submitted."
          : "Your claim has been submitted.",

      created: result.created === true,

      idempotent: result.idempotent === true,

      claim: buildClaimResponse(result.claim),

      occurrence: buildOccurrenceResponse(result.occurrence),
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
 * Professional submits the one appeal available after an employer rejects an
 * original financial claim.
 *
 * Appeal eligibility and appealDeadlineAt are authoritative in the claim
 * service/model. The controller does not reopen or extend that window.
 */
exports.submitAppeal = async (req, res) => {
  try {
    const professionalProfileId = getProfessionalProfileId(req);

    const result = await ShiftOccurrenceClaimService.submitAppeal({
      claimId: req.params.claimId,

      professionalId: professionalProfileId,

      submittedByUserId: req.user._id,

      statement: req.body.statement,

      evidence: req.body.evidence || [],

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message: "Your appeal has been submitted for review.",

      submitted: result.submitted === true,

      finalAdminReviewRequired: result.finalAdminReviewRequired === true,

      claim: buildClaimResponse(result.claim),
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

/* ─────────────────────────────── WITHDRAW CLAIM ─────────────────────────────── */

/**
 * Professional withdraws an active occurrence claim.
 *
 * Withdrawal consumes the one original claim opportunity. The service restores
 * the pre-claim occurrence state for the affected financial scope, clears the
 * active claim and reevaluates any employer refund dependency.
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

      withdrawn: result.withdrawn === true,

      claim: buildClaimResponse(result.claim),

      occurrence: buildOccurrenceResponse(result.occurrence),
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
