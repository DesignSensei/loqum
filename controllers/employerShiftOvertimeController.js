// controllers/employerShiftOvertimeController.js

const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const ShiftOvertimeService = require("../services/shiftOvertimeService");
const ShiftFundingService = require("../services/shiftFundingService");
const UploadStorageService = require("../services/storage/uploadStorageService");
const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const PAYSTACK_SHIFT_CALLBACK_PATH = "/payments/paystack/shift-callback";
const PRIVATE_OVERTIME_EVIDENCE_CATEGORY = "occurrence_evidence";

const EVIDENCE_FILE_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

const INLINE_EVIDENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
]);

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

  return configuredBaseUrl || `${req.protocol}://${req.get("host")}`;
}

function buildAbsoluteUrl(req, pathname) {
  const normalizedPath = String(pathname || "").startsWith("/")
    ? String(pathname)
    : `/${String(pathname || "")}`;

  return `${getApplicationBaseUrl(req)}${normalizedPath}`;
}

function buildShiftDetailsUrl(shiftId, occurrenceId = null) {
  const baseUrl = `${EMPLOYER_SHIFTS_URL}/${shiftId}`;
  if (!occurrenceId) return baseUrl;

  const searchParams = new URLSearchParams({ occurrence: String(occurrenceId) });
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
    "UploadStorageServiceError",
    "EmployerShiftOvertimeControllerError",
  ].includes(error?.name);
}

function createControllerError({ message, code, statusCode = 400 }) {
  const error = new Error(message);
  error.name = "EmployerShiftOvertimeControllerError";
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function getErrorStatusCode(error) {
  if (!isOperationalError(error)) return 500;

  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 400;
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operationalError = isOperationalError(error);
  const statusCode = getErrorStatusCode(error);

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ${error.code || "UNKNOWN"} - ${error.message}`);
  }

  const response = {
    success: false,
    message: operationalError ? error.message : fallbackMessage,
    code: operationalError ? error.code || fallbackCode : fallbackCode,
  };

  if (operationalError && statusCode < 500 && error.details && typeof error.details === "object") {
    response.details = error.details;
  }

  setNoStoreHeaders(res);
  return res.status(statusCode).json(response);
}

function serializeOvertimeDecisionResult(result) {
  const occurrence = result?.occurrence || null;
  if (!occurrence) return null;

  const overtime = occurrence.overtime || {};

  return {
    id: String(occurrence._id),
    shiftId: occurrence.shift ? String(occurrence.shift) : null,
    referenceCode: occurrence.referenceCode || null,
    status: occurrence.status || null,
    settlementStatus: occurrence.settlementStatus || null,
    overtime: {
      requested: overtime.requested === true,
      source: overtime.source || null,
      status: overtime.status || null,
      requestedMinutes: Number(overtime.requestedMinutes || 0),
      requestedAt: overtime.requestedAt || null,
      employerResponseDeadlineAt: overtime.employerResponseDeadlineAt || null,
      employerRespondedAt: overtime.employerRespondedAt || null,
      decisionSource: overtime.decisionSource || null,
      approvedAt: overtime.approvedAt || null,
      approvedBy: overtime.approvedBy ? String(overtime.approvedBy) : null,
      rejectedAt: overtime.rejectedAt || null,
      rejectedBy: overtime.rejectedBy ? String(overtime.rejectedBy) : null,
      rejectionBasis: overtime.rejectionBasis || null,
      rejectionReason: overtime.rejectionReason || null,
      employerProposedMinutes: overtime.employerProposedMinutes ?? null,
      adminReviewReason: overtime.adminReviewReason || null,
      topUpAmount: Number(overtime.topUpAmount || 0),
      topUpDeadlineAt: overtime.topUpDeadlineAt || null,
      topUpPaid: overtime.topUpPaid === true,
      topUpPaidAt: overtime.topUpPaidAt || null,
      topUpOverdueAt: overtime.topUpOverdueAt || null,
      restrictionTriggeredAt: overtime.restrictionTriggeredAt || null,
    },
    overtimeProfessionalPay: Number(occurrence.overtimeProfessionalPay || 0),
    overtimePlatformFee: Number(occurrence.overtimePlatformFee || 0),
    topUpRequired: Number(occurrence.topUpRequired || 0),
    topUpTransaction: occurrence.topUpTransaction ? String(occurrence.topUpTransaction) : null,
  };
}

/* ─────────────────────────────── EVIDENCE HELPERS ─────────────────────────────── */

function getEvidenceIndex(req) {
  const rawIndex = String(req.params?.evidenceIndex ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(rawIndex)) {
    throw createControllerError({
      message: "The requested overtime evidence was not found.",
      code: "OVERTIME_EVIDENCE_NOT_FOUND",
      statusCode: 404,
    });
  }

  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index)) {
    throw createControllerError({
      message: "The requested overtime evidence was not found.",
      code: "OVERTIME_EVIDENCE_NOT_FOUND",
      statusCode: 404,
    });
  }

  return index;
}

// Accept one explicit-start range. The storage service validates file bounds.
function parseEvidenceRangeHeader(value) {
  if (!value) return null;

  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value).trim());
  if (!match) {
    throw createControllerError({
      message: "The requested file range is not supported.",
      code: "OVERTIME_EVIDENCE_RANGE_INVALID",
      statusCode: 416,
    });
  }

  const rangeStart = Number(match[1]);
  const rangeEnd = match[2] === "" ? null : Number(match[2]);

  if (
    !Number.isSafeInteger(rangeStart) ||
    rangeStart < 0 ||
    (rangeEnd !== null && (!Number.isSafeInteger(rangeEnd) || rangeEnd < rangeStart))
  ) {
    throw createControllerError({
      message: "The requested file range is invalid.",
      code: "OVERTIME_EVIDENCE_RANGE_INVALID",
      statusCode: 416,
    });
  }

  return { rangeStart, rangeEnd };
}

async function getAuthorizedOvertimeOccurrence(req) {
  const occurrence = await ShiftOvertimeService.getOccurrence(req.params.occurrenceId);

  // This helper verifies the shift, employer business, post-shift permission and branch.
  // The overtime decision window does not need to be open for historical viewing.
  await ShiftOvertimeService.assertEmployerCanDecide({
    occurrence,
    shiftId: req.params.shiftId,
    employerProfileId: req.employerProfile?._id,
    employerUserId: req.user?._id,
    employerContext: req.employerContext || null,
    session: null,
  });

  return occurrence;
}

function getStoredOvertimeEvidence(occurrence, evidenceIndex) {
  const overtime = occurrence.overtime || {};
  const evidenceItems = Array.isArray(overtime.requestEvidence) ? overtime.requestEvidence : [];
  const evidence = overtime.requested === true ? evidenceItems[evidenceIndex] : null;

  const reference = typeof evidence?.reference === "string" ? evidence.reference.trim() : "";

  const requiredPrefix = `private://${PRIVATE_OVERTIME_EVIDENCE_CATEGORY}/${String(occurrence._id)}/`;

  if (!reference.startsWith(requiredPrefix) || reference.length <= requiredPrefix.length) {
    throw createControllerError({
      message: "The requested overtime evidence was not found.",
      code: "OVERTIME_EVIDENCE_NOT_FOUND",
      statusCode: 404,
    });
  }

  return { reference };
}

function setEvidenceResponseHeaders({ res, file, evidenceIndex, requestedRange }) {
  const extension = path.extname(file.fileName || "").toLowerCase();
  const mimeType = EVIDENCE_FILE_TYPES[extension];

  if (!mimeType) {
    throw createControllerError({
      message: "This supporting file format cannot be displayed.",
      code: "OVERTIME_EVIDENCE_FILE_TYPE_UNSUPPORTED",
      statusCode: 415,
    });
  }

  const downloadName = `overtime-evidence-${evidenceIndex + 1}${extension}`;
  const disposition = INLINE_EVIDENCE_MIME_TYPES.has(mimeType) ? "inline" : "attachment";

  setNoStoreHeaders(res);
  res.set({
    "Content-Type": mimeType,
    "Content-Length": String(file.contentLength),
    "Content-Disposition": `${disposition}; filename="${downloadName}"`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });

  if (requestedRange) {
    const start = requestedRange.rangeStart;
    const end = requestedRange.rangeEnd ?? file.fileSizeBytes - 1;
    res.set("Content-Range", `bytes ${start}-${end}/${file.fileSizeBytes}`);
    res.status(206);
  } else {
    res.status(200);
  }
}

function handleEvidenceError({ req, res, error }) {
  if (res.headersSent) {
    logger.error("Employer overtime evidence stream failed:", error);
    if (!res.destroyed) res.destroy(error);
    return;
  }

  const statusCode = getErrorStatusCode(error);
  const message =
    statusCode >= 500
      ? "The evidence file could not be opened. Please try again."
      : statusCode === 403
        ? "You do not have permission to view this evidence."
        : error.message || "The evidence file could not be opened.";

  if (statusCode >= 500) {
    logger.error("Employer overtime evidence retrieval failed:", error);
  } else {
    logger.warn(
      `Employer overtime evidence retrieval rejected: ${error.code || "UNKNOWN"} - ${error.message}`
    );
  }

  setNoStoreHeaders(res);
  res.set("X-Content-Type-Options", "nosniff");

  if (statusCode === 416) {
    res.set("Accept-Ranges", "bytes");
    const fileSize = Number(error?.details?.fileSizeBytes);
    if (Number.isSafeInteger(fileSize) && fileSize >= 0) {
      res.set("Content-Range", `bytes */${fileSize}`);
    }
  }

  const acceptsJson = Boolean(req.xhr || req.get("Accept")?.includes("application/json"));
  if (acceptsJson) {
    return res.status(statusCode).json({
      success: false,
      message,
      code:
        statusCode >= 500
          ? "OVERTIME_EVIDENCE_RETRIEVAL_FAILED"
          : error.code || "OVERTIME_EVIDENCE_RETRIEVAL_FAILED",
    });
  }

  return res.status(statusCode).type("text/plain").send(message);
}

/* ─────────────────────────────── EMPLOYER OVERTIME APPROVAL ─────────────────────────────── */

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

/* ─────────────────────────────── EMPLOYER OVERTIME REJECTION ─────────────────────────────── */

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
          ? "This overtime rejection has already been submitted for admin review."
          : "The overtime request was disputed and sent for admin review.",
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

/* ─────────────────────────────── AUTHORIZED EVIDENCE RETRIEVAL ─────────────────────────────── */

exports.getOvertimeEvidence = async (req, res) => {
  let openedFile = null;

  try {
    const evidenceIndex = getEvidenceIndex(req);
    const occurrence = await getAuthorizedOvertimeOccurrence(req);
    const evidence = getStoredOvertimeEvidence(occurrence, evidenceIndex);
    const requestedRange = parseEvidenceRangeHeader(req.get("Range"));

    openedFile = await UploadStorageService.openPrivateFile({
      fileUrl: evidence.reference,
      expectedCategory: PRIVATE_OVERTIME_EVIDENCE_CATEGORY,
      expectedOwnerId: String(occurrence._id),
      rangeStart: requestedRange?.rangeStart ?? null,
      rangeEnd: requestedRange?.rangeEnd ?? null,
    });

    setEvidenceResponseHeaders({ res, file: openedFile, evidenceIndex, requestedRange });
    await pipeline(openedFile.stream, res);
  } catch (error) {
    if (openedFile?.stream && !openedFile.stream.destroyed) {
      openedFile.stream.destroy();
    }
    if (req.aborted || res.destroyed) return;
    return handleEvidenceError({ req, res, error });
  }
};

/* ─────────────────────────────── WALLET TOP-UP ─────────────────────────────── */

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

/* ─────────────────────────────── PAYSTACK TOP-UP CHECKOUT ─────────────────────────────── */

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
