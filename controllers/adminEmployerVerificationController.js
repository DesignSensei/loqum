// controllers/adminEmployerVerificationController.js

const path = require("path");
const { pipeline } = require("stream/promises");

const AdminEmployerVerificationService = require("../services/adminEmployerVerificationService");
const FacilityPermitVerificationService = require("../services/facilityPermitVerificationService");
const UploadStorageService = require("../services/storage/uploadStorageService");

const FacilityPermit = require("../models/FacilityPermit");

const logger = require("../utils/logger");

// ───────────────────── CONSTANTS ─────────────────────

const FACILITY_PERMIT_STORAGE_CATEGORY = "facility_permit";

const FACILITY_PERMIT_DOCUMENT_MIME_TYPES = Object.freeze({
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

// ───────────────────── RESPONSE HELPERS ─────────────────────

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    logger.error(
      `${operation}: ${
        typeof error?.code === "string" && /^[A-Z0-9_]{2,100}$/.test(error.code)
          ? error.code
          : "ADMIN_EMPLOYER_VERIFICATION_ERROR"
      }`
    );
  }

  if (res.headersSent) {
    return res.destroy();
  }

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? "Unable to complete the verification request."
        : error?.message || "Invalid verification request.",
  });
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function createControllerError(message, code, statusCode = 400) {
  const error = new Error(message);

  error.name = "AdminEmployerVerificationControllerError";
  error.code = code;
  error.statusCode = statusCode;

  return error;
}

// ───────────────────── ADMIN CONTEXT ─────────────────────

function getAdminUserId(req) {
  return req.user?._id;
}

// ───────────────────── PERMIT DOCUMENT VALIDATION ─────────────────────

/*
 * The permitted file reference must come from
 * the stored FacilityPermit record.
 *
 * The request cannot provide a storage key,
 * filename, file URL or private filesystem path.
 *
 * The storage service independently enforces
 * the expected category and branch owner.
 */

function validatePermitDocument(permit, branchId) {
  if (!permit) {
    throw createControllerError(
      "Facility permit not found.",
      "FACILITY_PERMIT_DOCUMENT_NOT_FOUND",
      404
    );
  }

  const fileUrl = permit.documentRef;

  if (typeof fileUrl !== "string") {
    throw createControllerError(
      "The facility permit document is unavailable.",
      "FACILITY_PERMIT_DOCUMENT_UNAVAILABLE",
      404
    );
  }

  const expectedPrefix = `private://${FACILITY_PERMIT_STORAGE_CATEGORY}/${branchId}/`;

  if (!fileUrl.startsWith(expectedPrefix)) {
    throw createControllerError(
      "The facility permit document reference is invalid.",
      "FACILITY_PERMIT_DOCUMENT_REFERENCE_INVALID",
      500
    );
  }

  const mimeType = permit.documentMimeType;

  const extension = FACILITY_PERMIT_DOCUMENT_MIME_TYPES[mimeType];

  if (!extension) {
    throw createControllerError(
      "The facility permit document format is unsupported.",
      "FACILITY_PERMIT_DOCUMENT_FORMAT_INVALID",
      500
    );
  }

  const storedExtension = path.extname(fileUrl).toLowerCase();

  const allowedExtensions = mimeType === "image/jpeg" ? [".jpg", ".jpeg"] : [extension];

  if (!allowedExtensions.includes(storedExtension)) {
    throw createControllerError(
      "The facility permit document format is inconsistent.",
      "FACILITY_PERMIT_DOCUMENT_FORMAT_MISMATCH",
      500
    );
  }

  if (
    !Number.isSafeInteger(permit.documentSizeBytes) ||
    permit.documentSizeBytes <= 0 ||
    permit.documentSizeBytes > 10 * 1024 * 1024
  ) {
    throw createControllerError(
      "The facility permit document metadata is invalid.",
      "FACILITY_PERMIT_DOCUMENT_METADATA_INVALID",
      500
    );
  }

  return {
    fileUrl,
    mimeType,
    extension: storedExtension,
    expectedSize: permit.documentSizeBytes,
  };
}

// ───────────────────── DASHBOARD PAGE ─────────────────────

exports.getDashboardPage = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const pageOptions = await AdminEmployerVerificationService.getDashboardPageOptions({
      adminUserId: getAdminUserId(req),
    });

    return res.render("admin/employer-verifications/index", {
      ...pageOptions,
      csrfToken: req.csrfToken(),
    });
  } catch (error) {
    logger.error(
      `Render employer verification dashboard: ${
        typeof error?.code === "string" && /^[A-Z0-9_]{2,100}$/.test(error.code)
          ? error.code
          : "ADMIN_EMPLOYER_VERIFICATION_ERROR"
      }`
    );

    return next(error);
  }
};

// ───────────────────── EMPLOYER VERIFICATION QUEUE ─────────────────────

exports.listEmployers = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.listEmployers({
      adminUserId: getAdminUserId(req),
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "List employer verifications");
  }
};

// ───────────────────── EMPLOYER VERIFICATION DETAILS ─────────────────────

exports.getEmployerVerification = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.getEmployerVerification({
      adminUserId: getAdminUserId(req),
      employerProfileId: req.params.employerProfileId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get employer verification");
  }
};

// ───────────────────── ADMINISTRATOR CAC RECHECK ─────────────────────

exports.recheckCAC = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.recheckCAC({
      adminUserId: getAdminUserId(req),
      employerProfileId: req.params.employerProfileId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Recheck CAC registration");
  }
};

// ───────────────────── FACILITY PERMIT QUEUE ─────────────────────

/*
 * Lists branch-specific permit submissions
 * across healthcare business types.
 *
 * This endpoint returns no private document
 * storage references.
 */

exports.listFacilityPermits = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.listFacilityPermits({
      adminUserId: getAdminUserId(req),

      status: req.query?.status,
      page: req.query?.page,
      limit: req.query?.limit,

      employerProfileId: req.query?.employerProfileId,

      branchId: req.query?.branchId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "List facility permit verifications");
  }
};

// ───────────────────── FACILITY PERMIT DETAILS ─────────────────────

/*
 * Confirms the relationship between the employer,
 * branch and selected permit.
 *
 * Private document references are excluded.
 */

exports.getFacilityPermit = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.getFacilityPermit({
      adminUserId: getAdminUserId(req),

      employerProfileId: req.params.employerProfileId,

      branchId: req.params.branchId,

      permitId: req.params.permitId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get facility permit verification");
  }
};

// ───────────────────── SECURE FACILITY PERMIT DOCUMENT VIEW ─────────────────────

/*
 * GET: Stream a privately stored permit document
 * to an authenticated, authorised administrator.
 *
 * Required route parameters:
 *
 * employerProfileId
 * branchId
 * permitId
 *
 * The endpoint deliberately does not accept:
 *
 * - A storage key from the browser.
 * - A private file URL from the browser.
 * - A filesystem path.
 * - A submitted filename.
 *
 * Administrative authorization occurs before
 * reading document references or opening files.
 *
 * The FacilityPermit database query binds the
 * permit to both its business and branch.
 *
 * UploadStorageService.openPrivateFile() then
 * enforces the corresponding storage scope.
 *
 * Files are returned as attachments rather than
 * inline HTML or executable browser content.
 *
 * Full-document streaming is used here.
 * HTTP byte-range requests are not supported
 * by this particular controller endpoint.
 */

exports.viewFacilityPermitDocument = async (req, res) => {
  setNoStoreHeaders(res);

  let openedFile = null;

  try {
    const adminUserId = getAdminUserId(req);

    // ───────── ADMINISTRATIVE AUTHORIZATION ─────────

    await AdminEmployerVerificationService.assertAdmin(adminUserId);

    // ───────── VALIDATE RESOURCE IDENTIFIERS ─────────

    const employerProfileId = AdminEmployerVerificationService.validateEmployerProfileId(
      req.params.employerProfileId
    );

    const branchId = AdminEmployerVerificationService.validateBranchId(req.params.branchId);

    const permitId = AdminEmployerVerificationService.validatePermitId(req.params.permitId);

    // ───────── LOAD ONLY THE AUTHORISED RESOURCE ─────────

    /*
     * A permit is retrieved only when all three
     * relationships match.
     *
     * Selecting a valid permit ID belonging to
     * another business or branch returns nothing.
     */

    const permit = await FacilityPermit.findOne({
      _id: permitId,
      business: employerProfileId,
      branch: branchId,
    })
      .select("+documentRef documentMimeType documentSizeBytes business branch")
      .lean();

    if (!permit) {
      throw createControllerError(
        "Facility permit not found.",
        "FACILITY_PERMIT_DOCUMENT_NOT_FOUND",
        404
      );
    }

    // ───────── VALIDATE STORED FILE METADATA ─────────

    const document = validatePermitDocument(permit, String(branchId));

    // ───────── OPEN THE SCOPED PRIVATE FILE ─────────

    /*
     * This service supports both private local
     * storage and private Amazon S3 storage.
     *
     * Storage scope is checked independently
     * using the trusted category and branch ID.
     */

    openedFile = await UploadStorageService.openPrivateFile({
      fileUrl: document.fileUrl,

      expectedCategory: FACILITY_PERMIT_STORAGE_CATEGORY,

      expectedOwnerId: String(branchId),
    });

    // ───────── VERIFY RETURNED FILE METADATA ─────────

    if (
      openedFile.visibility !== "private" ||
      openedFile.mimeType !== document.mimeType ||
      openedFile.fileSizeBytes !== document.expectedSize ||
      openedFile.contentLength !== document.expectedSize ||
      openedFile.partial !== false ||
      !openedFile.stream ||
      typeof openedFile.stream.pipe !== "function"
    ) {
      openedFile.stream?.destroy?.();

      throw createControllerError(
        "The stored facility permit document failed integrity checks.",
        "FACILITY_PERMIT_DOCUMENT_INTEGRITY_FAILED",
        500
      );
    }

    // ───────── PRIVATE DOWNLOAD HEADERS ─────────

    /*
     * Use a generated download name instead of
     * exposing original filenames or storage keys.
     *
     * attachment prevents rendering uploaded
     * documents directly as active page content.
     */

    const downloadName = `facility-permit-${String(permit._id)}${document.extension}`;

    res.status(200);

    res.set({
      "Content-Type": document.mimeType,

      "Content-Length": String(openedFile.contentLength),

      "Content-Disposition": `attachment; filename="${downloadName}"`,

      "X-Content-Type-Options": "nosniff",

      "Content-Security-Policy": "sandbox",

      "Accept-Ranges": "none",

      "Cache-Control": "no-store, no-cache, must-revalidate, private",

      Pragma: "no-cache",

      Expires: "0",
    });

    // ───────── STREAM WITHOUT BUFFERING THE FILE ─────────

    /*
     * pipeline() coordinates backpressure,
     * closes the stream when finished and
     * destroys the pipeline on errors or
     * connection termination.
     */

    await pipeline(openedFile.stream, res);

    return;
  } catch (error) {
    openedFile?.stream?.destroy?.();

    if (res.headersSent) {
      if (!res.destroyed) {
        res.destroy();
      }
      return;
    }

    return sendError(res, error, "View private facility permit document");
  }
};

// ───────────────────── FACILITY PERMIT REVIEW ─────────────────────

/*
 * Supported decisions:
 *
 * verified
 * needs_review
 * rejected
 *
 * Administrative authorization, transition
 * validation, regulatory requirements and
 * validity checks belong to the service.
 *
 * Review results apply to one permit and
 * its respective branch requirement.
 */

exports.reviewFacilityPermit = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await FacilityPermitVerificationService.reviewPermit({
      businessId: req.params.employerProfileId,

      branchId: req.params.branchId,

      permitId: req.params.permitId,

      adminUserId: getAdminUserId(req),

      decision: req.body?.decision,

      note: req.body?.note,

      validity: req.body?.validity ?? null,
    });

    return res.status(200).json({
      success: true,

      message:
        result.status === "verified"
          ? "Facility permit approved successfully."
          : result.status === "needs_review"
            ? "Facility permit marked for additional review."
            : "Facility permit rejected.",

      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Review facility permit");
  }
};

// ───────────────────── FACILITY PERMIT REVOCATION ─────────────────────

/*
 * Revoke an approved permit without deleting
 * the original verification evidence.
 *
 * Revocation history remains available.
 */

exports.revokeFacilityPermit = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await FacilityPermitVerificationService.revokePermit({
      businessId: req.params.employerProfileId,

      branchId: req.params.branchId,

      permitId: req.params.permitId,

      adminUserId: getAdminUserId(req),

      reason: req.body?.reason,
    });

    return res.status(200).json({
      success: true,

      message: "Facility permit revoked successfully.",

      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Revoke facility permit");
  }
};

// ───────────────────── RETIRED PCN REVIEW ─────────────────────

/*
 * Keep the legacy export temporarily
 * for compatibility with existing routes.
 *
 * The current service rejects employer-wide
 * PCN mutation with HTTP 410.
 *
 * Permit verification is now performed per branch.
 */

exports.reviewPCN = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.reviewPCN({
      adminUserId: getAdminUserId(req),
      employerProfileId: req.params.employerProfileId,

      decision: req.body?.decision,

      nameOnRecord: req.body?.nameOnRecord,

      note: req.body?.note,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Retired employer-wide PCN review");
  }
};
