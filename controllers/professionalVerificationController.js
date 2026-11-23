// controllers/professionalVerificationController.js

const mongoose = require("mongoose");

const ProfessionalVerificationService = require("../services/professionalVerificationService");
const logger = require("../utils/logger");

/**
 * PROFESSIONAL VERIFICATION CONTROLLER — POST-ONBOARDING MVP
 *
 * The production NIN lookup and registry legal-name capture happen during
 * onboarding. Here, the professional can inspect verification readiness,
 * submit a practising-licence document and correct its registration number.
 * There is no second paid NIN/BVN lookup, government-ID approval,
 * hosted selfie/liveness step, or separate
 * admin NIN documentary review.
 *
 * An administrator reviews the uploaded practising licence against the
 * original NIN evidence, profession, number and validity period, then gives
 * an independent final approval. Council lookup is optional and recorded
 * accurately if undertaken. Expired licences do not authorize clinical work;
 * the 30-day grace period is for renewal access only.
 *
 * LICENCE UPLOAD CONTRACT:
 * parseProfessionalLicenceUpload must run before submitLicenceDocument.
 * It validates and stores the binary privately and populates a trusted
 * req.professionalLicenceUpload value, cleanup and commit callbacks.
 * Only the domain service persists that reference to a pending licence.
 * After transaction success the controller commits the private upload,
 * before responding. A failed submission deletes the uncommitted upload.
 * The professional router must mount the upload middleware before this handler.
 *
 * The router must enforce authentication, role/onboarding checks and CSRF
 * on mutations. The service independently checks profile ownership.
 */

const PUBLIC_ERROR_NAMES = new Set(["ProfessionalVerificationServiceError"]);

// ───────────────────────── ERROR HANDLING ─────────────────────────

function sendError(res, error, operation) {
  const rawCode = typeof error?.code === "string" ? error.code : "";
  const code = /^[A-Z][A-Z0-9_]{2,99}$/.test(rawCode) ? rawCode : "PROFESSIONAL_VERIFICATION_ERROR";

  const authenticationError = code === "PROFESSIONAL_VERIFICATION_AUTH_REQUIRED";

  const trustedError = authenticationError || PUBLIC_ERROR_NAMES.has(error?.name);

  const statusCode =
    trustedError &&
    Number.isInteger(error?.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    logger.error(`${operation}: ${code}`);
  }

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? "Unable to complete the verification request."
        : authenticationError
          ? "Authentication is required."
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

function getAuthenticatedUserId(req) {
  const userId = req.user?._id;

  if (!mongoose.isValidObjectId(userId)) {
    const error = new Error("Authentication is required.");
    error.code = "PROFESSIONAL_VERIFICATION_AUTH_REQUIRED";
    error.statusCode = 401;
    throw error;
  }

  return userId;
}

// ───────────────────────── EVIDENCE-BASED STATUS ─────────────────────────

/**
 * GET /verification/:professionalProfileId
 *
 * Status-only response; no NIN number, private document URL or provider
 * secret is included. It reports stored NIN evidence, current licence
 * validity, renewal state, final approval and verified KYC audit readiness.
 */
exports.getVerificationStatus = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const data = await ProfessionalVerificationService.getVerificationStatus({
      professionalProfileId: req.params.professionalProfileId,
      userId,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return sendError(res, error, "Get professional verification status");
  }
};

// ───────────────────────── LICENCE DOCUMENT SUBMISSION ─────────────────────────

/**
 * POST /verification/:professionalProfileId/licence-document
 *
 * Middleware (in order):
 *   1. Router-wide authentication, onboarding and profile attachment;
 *   2. parseProfessionalLicenceUpload;
 *   3. This handler.
 *
 * Multipart field: licenceDocument (one PDF, JPG, PNG or WEBP, up to 10 MB).
 *
 * Upload middleware creates a profile-scoped private:// file reference. The
 * domain service authenticates ownership again and transactionally records a
 * pending licence submission plus KYC audit. It preserves a currently verified
 * licence, final approval and any valid existing review evidence.
 *
 * req.commitProfessionalLicenceUpload must be called AFTER the transaction
 * succeeds and BEFORE sending success. For failed submissions, cleanup
 * removes the newly stored file, without touching existing approved files.
 *
 * Storage cleanup does not make database commits atomic with object storage.
 * An orphan reconciliation job is still appropriate for process crashes.
 */
exports.submitLicenceDocument = async (req, res) => {
  setNoStoreHeaders(res);

  // This distinguishes an uncommitted upload from a database write that has
  // already succeeded. Never remove a newly persisted document on a later
  // response/commit error, since that would leave a dangling DB reference.
  let persisted = false;

  try {
    const userId = getAuthenticatedUserId(req);

    if (
      !req.professionalLicenceUpload ||
      typeof req.commitProfessionalLicenceUpload !== "function" ||
      typeof req.cleanupProfessionalLicenceUpload !== "function"
    ) {
      const error = new Error("The practising-licence upload middleware is required.");
      error.name = "ProfessionalVerificationServiceError";
      error.code = "PROFESSIONAL_VERIFICATION_UPLOAD_CONTEXT_REQUIRED";
      error.statusCode = 500;
      throw error;
    }

    const result = await ProfessionalVerificationService.submitLicenceDocument({
      professionalProfileId: req.params.professionalProfileId,
      userId,
      licenceUpload: req.professionalLicenceUpload,
    });

    persisted = true;
    req.commitProfessionalLicenceUpload();

    return res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (!persisted && typeof req.cleanupProfessionalLicenceUpload === "function") {
      try {
        await req.cleanupProfessionalLicenceUpload();
      } catch (_cleanupError) {
        // Keep the original API error and avoid logging private file details.
        logger.error("Professional licence upload cleanup failed.");
      }
    }

    return sendError(res, error, "Submit professional practising licence");
  }
};

// ───────────────────────── LICENCE NUMBER CHANGE ─────────────────────────

/**
 * POST /verification/:professionalProfileId/licence-number
 *
 * Changing the licence number transactionally invalidates existing licence
 * verification and independent final approval, while retaining the original
 * production NIN evidence. Re-entering the same number is a no-op.
 * The service, not this controller, owns all verification mutations.
 */
exports.changeLicenceNumber = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const result = await ProfessionalVerificationService.changeLicenceNumber({
      professionalProfileId: req.params.professionalProfileId,
      userId,
      licenceNumber: req.body?.licenceNumber,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Change professional licence number");
  }
};
