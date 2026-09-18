// controllers/employerShiftOvertimeController.js

const ShiftOvertimeService = require("../services/shiftOvertimeService");
const ShiftFundingService = require("../services/shiftFundingService");

const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const PAYSTACK_SHIFT_CALLBACK_PATH = "/payments/paystack/shift-callback";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function getApplicationBaseUrl(req) {
  const configuredBaseUrl = String(process.env.APP_BASE_URL || process.env.BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function buildAbsoluteUrl(req, path) {
  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : `/${String(path || "")}`;

  return `${getApplicationBaseUrl(req)}${normalizedPath}`;
}

function buildShiftDetailsUrl(shiftId, occurrenceId = null) {
  const baseUrl = `${EMPLOYER_SHIFTS_URL}/${shiftId}`;

  if (!occurrenceId) {
    return baseUrl;
  }

  const searchParams = new URLSearchParams({
    occurrence: String(occurrenceId),
  });

  return `${baseUrl}?${searchParams.toString()}`;
}

function isOperationalError(error) {
  return [
    "ShiftOvertimeServiceError",
    "ShiftOvertimeFundingServiceError",
    "ShiftFundingServiceError",
    "ShiftPlatformFeeServiceError",
    "ShiftSettlementServiceError",
    "WalletServiceError",
    "PlatformSettingsError",
    "PaystackServiceError",
  ].includes(error?.name);
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operationalError = isOperationalError(error);

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
    logger.warn(`${logContext} rejected: ` + `${error.code || "UNKNOWN"} - ${error.message}`);
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

function serializeOvertimeDecisionResult(result) {
  const occurrence = result?.occurrence || null;

  if (!occurrence) {
    return null;
  }

  return {
    id: String(occurrence._id),

    shiftId: occurrence.shift ? String(occurrence.shift) : null,

    referenceCode: occurrence.referenceCode || null,

    status: occurrence.status || null,

    settlementStatus: occurrence.settlementStatus || null,

    overtime: {
      requested: occurrence.overtime?.requested === true,

      source: occurrence.overtime?.source || null,

      status: occurrence.overtime?.status || null,

      requestedMinutes: Number(occurrence.overtime?.requestedMinutes || 0),

      requestedAt: occurrence.overtime?.requestedAt || null,

      employerResponseDeadlineAt: occurrence.overtime?.employerResponseDeadlineAt || null,

      employerRespondedAt: occurrence.overtime?.employerRespondedAt || null,

      decisionSource: occurrence.overtime?.decisionSource || null,

      approvedAt: occurrence.overtime?.approvedAt || null,

      approvedBy: occurrence.overtime?.approvedBy ? String(occurrence.overtime.approvedBy) : null,

      rejectedAt: occurrence.overtime?.rejectedAt || null,

      rejectedBy: occurrence.overtime?.rejectedBy ? String(occurrence.overtime.rejectedBy) : null,

      rejectionReason: occurrence.overtime?.rejectionReason || null,

      topUpAmount: Number(occurrence.overtime?.topUpAmount || 0),

      topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,

      topUpPaid: occurrence.overtime?.topUpPaid === true,

      topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,

      topUpOverdueAt: occurrence.overtime?.topUpOverdueAt || null,

      restrictionTriggeredAt: occurrence.overtime?.restrictionTriggeredAt || null,
    },

    overtimeProfessionalPay: Number(occurrence.overtimeProfessionalPay || 0),

    overtimePlatformFee: Number(occurrence.overtimePlatformFee || 0),

    topUpRequired: Number(occurrence.topUpRequired || 0),

    topUpTransaction: occurrence.topUpTransaction ? String(occurrence.topUpTransaction) : null,
  };
}

/* ─────────────────────────────── APPROVE PROFESSIONAL OT REQUEST ─────────────────────────────── */

/**
 * Employer approves the professional's submitted overtime request.
 *
 * ShiftOvertimeService remains authoritative for:
 *
 * - employer/business/branch authorization;
 * - employer response deadline;
 * - attendance support for requested overtime;
 * - final OT professional pay;
 * - OT platform-fee earning;
 * - OT top-up obligation establishment; and
 * - occurrence settlement-state synchronization.
 *
 * Employer approval is all-or-nothing.
 * There is no partial employer OT approval.
 */
exports.approveOvertime = async (req, res) => {
  try {
    const result = await ShiftOvertimeService.approveOvertimeByEmployer({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      employerProfileId: req.employerProfile._id,

      employerUserId: req.user._id,

      employerContext: req.employerContext,

      decidedAt: new Date(),
    });

    const occurrence = result.occurrence;

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      alreadyFinalized: result.idempotent === true,

      message:
        result.idempotent === true
          ? "This overtime request has already been approved."
          : "The professional's overtime request was approved.",

      data: serializeOvertimeDecisionResult(result),

      shiftDetailsUrl: buildShiftDetailsUrl(occurrence.shift, occurrence._id),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer approval of professional overtime request",

      fallbackMessage: "The overtime request could not be approved. Please try again.",

      fallbackCode: "EMPLOYER_OVERTIME_APPROVAL_FAILED",
    });
  }
};

/* ─────────────────────────────── REJECT PROFESSIONAL OT REQUEST ─────────────────────────────── */

/**
 * Employer rejects the professional's submitted overtime request.
 *
 * ShiftOvertimeService remains authoritative for the rejection
 * lifecycle and any downstream admin review required by the OT state.
 */
exports.rejectOvertime = async (req, res) => {
  try {
    const result = await ShiftOvertimeService.rejectOvertimeByEmployer({
      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      employerProfileId: req.employerProfile._id,

      employerUserId: req.user._id,

      employerContext: req.employerContext,

      rejectionBasis: req.body?.rejectionBasis,

      rejectionReason: req.body?.rejectionReason ?? req.body?.reason,

      employerProposedMinutes: req.body?.employerProposedMinutes,

      rejectionEvidence: req.body?.rejectionEvidence,

      rejectionNoSupportingEvidence: req.body?.rejectionNoSupportingEvidence,

      decidedAt: new Date(),
    });

    const occurrence = result.occurrence;

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      alreadyFinalized: result.idempotent === true,

      message:
        result.idempotent === true
          ? "This overtime request has already been rejected."
          : "The professional's overtime request was rejected.",

      data: serializeOvertimeDecisionResult(result),

      shiftDetailsUrl: buildShiftDetailsUrl(occurrence.shift, occurrence._id),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer rejection of professional overtime request",

      fallbackMessage: "The overtime request could not be rejected. Please try again.",

      fallbackCode: "EMPLOYER_OVERTIME_REJECTION_FAILED",
    });
  }
};

/* ─────────────────────────────── PAY OT TOP-UP FROM WALLET ─────────────────────────────── */

/**
 * Pays an already-established overtime top-up from the employer wallet.
 *
 * This is resolution of an existing Shift obligation.
 *
 * It deliberately does NOT use canPostShifts / delinquency-aware posting
 * authority. ShiftFundingService independently verifies employer role and
 * branch access before moving funds.
 *
 * ShiftFundingService owns the payment rail.
 *
 * ShiftOvertimeFundingService remains authoritative for:
 *
 * - the exact top-up amount;
 * - whether the top-up remains outstanding;
 * - recording topUpPaid / topUpTransaction;
 * - OT platform-fee collection; and
 * - settlement handoff.
 */
exports.fundOvertimeTopUpFromWallet = async (req, res) => {
  try {
    const result = await ShiftFundingService.fundOvertimeTopUpFromWallet({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      ...result,

      shiftDetailsUrl: buildShiftDetailsUrl(req.params.shiftId, req.params.occurrenceId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer wallet overtime top-up",

      fallbackMessage: "The overtime top-up could not be paid from your wallet. Please try again.",

      fallbackCode: "OVERTIME_TOPUP_WALLET_FUNDING_FAILED",
    });
  }
};

/* ─────────────────────────────── INITIALIZE OT TOP-UP CHECKOUT ─────────────────────────────── */

/**
 * Initializes Paystack Checkout for an already-established OT top-up.
 *
 * The resulting pending external credit is occurrence-specific:
 *
 * type:
 *   shift_topup
 *
 * purpose:
 *   shift_overtime_topup
 *
 * payment rail:
 *   paystack_checkout
 *
 * Final Paystack confirmation continues through the shared Shift payment
 * callback/webhook path, where ShiftFundingService dispatches the persisted
 * transaction to BASE funding or OT top-up finalization.
 */
exports.initializeOvertimeTopUpCheckout = async (req, res) => {
  try {
    const callbackUrl = buildAbsoluteUrl(req, PAYSTACK_SHIFT_CALLBACK_PATH);

    const result = await ShiftFundingService.initializeOvertimeTopUpCheckout({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftId: req.params.shiftId,

      occurrenceId: req.params.occurrenceId,

      callbackUrl,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      ...result,

      shiftDetailsUrl: buildShiftDetailsUrl(req.params.shiftId, req.params.occurrenceId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer Paystack overtime top-up initialization",

      fallbackMessage:
        "Paystack Checkout could not be initialized for the overtime top-up. Please try again.",

      fallbackCode: "OVERTIME_TOPUP_CHECKOUT_INITIALIZATION_FAILED",
    });
  }
};
