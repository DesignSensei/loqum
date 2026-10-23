// controllers/adminProfessionalVerificationController.js

const AdminProfessionalVerificationService = require("../services/adminProfessionalVerificationService");

const logger = require("../utils/logger");

/**
 * ADMIN PROFESSIONAL VERIFICATION CONTROLLER
 *
 * This controller owns HTTP request and response
 * handling for administrative professional verification.
 *
 * It delegates administrative query and review
 * orchestration to AdminProfessionalVerificationService.
 *
 * RESPONSIBILITIES
 *
 * - Professional verification dashboard;
 * - Paginated verification queue;
 * - Individual professional verification details;
 * - Individual KYC attempt details;
 * - Administrative identity reviews;
 * - Manual professional licence reviews;
 * - Final professional approval decisions.
 *
 * It does NOT own:
 *
 * - Identity or licence verification logic;
 * - Ninja or Dojah API requests;
 * - Provider selection;
 * - Biometric verification decisions;
 * - KYC record persistence;
 * - Marketplace eligibility decisions.
 *
 * SECURITY
 *
 * All routes must require authentication and
 * administrator authorization.
 *
 * The administrative service independently
 * verifies administrator access.
 *
 * Administrative identity comes from req.user._id.
 *
 * Never accept adminUserId from request bodies.
 *
 * Never log:
 *
 * - NIN or BVN numbers;
 * - Provider credentials;
 * - Identity document URLs;
 * - Selfie URLs;
 * - Raw provider verification payloads.
 *
 * State-changing routes must enforce CSRF
 * protection through the application's middleware.
 */

// ───────────────────────── ERROR HANDLING ─────────────────────────

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
  if (statusCode >= 500) {
    /*
     * Log a sanitized error code rather than
     * potentially sensitive provider information.
     */
    logger.error(`${operation}: ${error?.code || "ADMIN_PROFESSIONAL_VERIFICATION_ERROR"}`);
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

// ───────────────────────── DASHBOARD DATA ─────────────────────────

/**
 * GET PROFESSIONAL VERIFICATION DASHBOARD
 *
 * Returns:
 *
 * - Total professional profiles;
 * - Profiles awaiting review;
 * - Profiles ready for approval;
 * - Pending identity reviews;
 * - Pending licence reviews;
 * - Approved professionals;
 * - Rejected professionals;
 * - Available filters.
 *
 * This is a JSON endpoint.
 *
 * A server-rendered dashboard page can be
 * added separately when its EJS template exists.
 *
 * Do not reference a view that has not been created.
 */
exports.getDashboard = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.getDashboardPageOptions({
      adminUserId: req.user?._id,
    });
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Get professional verification dashboard");
  }
};

// ───────────────────────── VERIFICATION QUEUE ─────────────────────────

/**
 * GET PROFESSIONAL VERIFICATION QUEUE
 *
 * Supported query parameters:
 *
 * status:
 * - all
 * - awaiting_review
 * - ready_for_approval
 * - identity_review
 * - licence_review
 * - pending
 * - needs_review
 * - approved
 * - rejected
 *
 * type:
 * - pharmacist
 * - pharmacy_technician
 * - nurse
 * - doctor
 * - lab_scientist
 * - radiographer
 * - physiotherapist
 *
 * search:
 * - Licence number
 * - Specialty
 * - Licence issuing body
 *
 * page:
 * - Default: 1
 *
 * limit:
 * - Default: 20
 * - Maximum: 100
 *
 * The service owns filtering, pagination
 * and administrator authorization.
 */
exports.listProfessionals = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.listProfessionals({
      adminUserId: req.user?._id,
      status: req.query?.status,
      type: req.query?.type,
      search: req.query?.search,
      page: req.query?.page,
      limit: req.query?.limit,
    });
    /*
     * The service already returns:
     *
     * {
     *   success: true,
     *   data: [...],
     *   pagination: {...},
     *   filters: {...}
     * }
     *
     * Preserve that response contract.
     */
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "List professional verifications");
  }
};

// ───────────────────────── PROFESSIONAL VERIFICATION DETAILS ─────────────────────────

/**
 * GET PROFESSIONAL VERIFICATION DETAILS
 *
 * Route parameter:
 *
 * professionalProfileId
 *
 * Returns:
 *
 * - Professional verification summary;
 * - Identity verification status;
 * - Licence verification status;
 * - Final professional approval;
 * - Account and marketplace status;
 * - Verification readiness;
 * - Recent KYC verification attempts.
 *
 * Sensitive provider data is excluded by
 * AdminProfessionalVerificationService.
 */
exports.getProfessionalVerification = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.getProfessionalVerification({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
    });
    /*
     * The service returns:
     *
     * {
     *   success: true,
     *   data: {...}
     * }
     */
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get professional verification");
  }
};

// ───────────────────────── INDIVIDUAL KYC ATTEMPT ─────────────────────────

/**
 * GET PROFESSIONAL KYC ATTEMPT
 *
 * Route parameter:
 *
 * verificationId
 *
 * Returns sanitized verification evidence for
 * one professional verification attempt.
 *
 * This can include:
 *
 * - Verification type;
 * - Provider and environment;
 * - Verification status;
 * - Registry matching evidence;
 * - Hosted KYC completion status;
 * - Review information;
 * - Verification timestamps.
 *
 * It must not expose:
 *
 * - Raw NIN/BVN numbers;
 * - API credentials;
 * - Raw provider responses;
 * - Identity document URLs;
 * - Selfie access URLs;
 * - Internal request references;
 * - Provider webhook identifiers.
 */
exports.getVerificationAttempt = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.getVerificationAttempt({
      adminUserId: req.user?._id,
      verificationId: req.params.verificationId,
    });
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get professional verification attempt");
  }
};

// ───────────────────────── IDENTITY REVIEW ─────────────────────────

/**
 * REVIEW PROFESSIONAL IDENTITY
 *
 * Route parameter:
 * - professionalProfileId
 *
 * Request body:
 * - verificationId: the KYC attempt being reviewed
 * - decision: "verified" | "rejected" | "needs_review"
 * - note: meaningful review notes
 *
 * Identity approval requires trusted identity-holder
 * evidence, independently enforced by
 * ProfessionalVerificationService.recordIdentityReview.
 *
 * A NIN registry match or completed hosted KYC flow
 * cannot independently establish identity-holder proof.
 *
 * The administrator identity comes only from req.user._id.
 * Authentication, administrator authorization and CSRF
 * protection must be enforced by the route middleware.
 */
exports.reviewIdentity = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.reviewIdentity({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
      verificationId: req.body?.verificationId,
      decision: req.body?.decision,
      note: req.body?.note,
    });
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Review professional identity");
  }
};

// ───────────────────────── MANUAL LICENCE REVIEW ─────────────────────────

/**
 * REVIEW PROFESSIONAL LICENCE
 *
 * Route parameter:
 *
 * professionalProfileId
 *
 * Request body:
 *
 * {
 *   decision: "verified" | "rejected" | "needs_review",
 *   nameOnRecord: "...",
 *   note: "..."
 * }
 *
 * Administrator responsibilities:
 *
 * - Inspect the relevant professional register;
 * - Confirm licence number and holder details;
 * - Record a clear verification decision;
 * - Provide a meaningful review note.
 *
 * The administrative service delegates
 * the decision to ProfessionalVerificationService.
 *
 * IMPORTANT
 *
 * Licence verification is one-time.
 *
 * A verified licence is not automatically
 * rechecked because of its expiry date.
 *
 * Only changing the licence number requires
 * fresh licence verification and approval.
 */
exports.reviewLicence = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.reviewLicence({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
      decision: req.body?.decision,
      nameOnRecord: req.body?.nameOnRecord,
      note: req.body?.note,
    });
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Review professional licence");
  }
};

// ───────────────────────── FINAL PROFESSIONAL APPROVAL ─────────────────────────

/**
 * REVIEW PROFESSIONAL APPROVAL
 *
 * Route parameter:
 *
 * professionalProfileId
 *
 * Request body:
 *
 * {
 *   decision: "approved" | "rejected" | "needs_review",
 *   note: "..."
 * }
 *
 * Final approval requirements:
 *
 * - Authorized active administrator;
 * - Verified professional identity;
 * - Verified professional licence;
 * - Active professional account.
 *
 * The administrative service delegates
 * approval authority to ProfessionalVerificationService.
 *
 * A successful registry lookup does not
 * automatically authenticate the identity holder.
 *
 * A completed Ninja hosted KYC flow does not
 * automatically prove selfie/liveness approval.
 *
 * No approval is granted merely because the
 * verification provider has returned a response.
 *
 * Marketplace visibility remains a separate
 * eligibility and profile preference decision.
 */
exports.reviewProfessionalApproval = async (req, res) => {
  setNoStoreHeaders(res);
  try {
    const result = await AdminProfessionalVerificationService.reviewProfessionalApproval({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
      decision: req.body?.decision,
      note: req.body?.note,
    });
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Review professional approval");
  }
};
