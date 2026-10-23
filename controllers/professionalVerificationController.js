// controllers/professionalVerificationController.js

const ProfessionalVerificationService = require("../services/professionalVerificationService");

const logger = require("../utils/logger");

/**
 * PROFESSIONAL VERIFICATION CONTROLLER
 *
 * PROFESSIONAL-FACING OPERATIONS ONLY
 *
 * This controller allows authenticated professionals to:
 *
 * - Read their verification status;
 * - Submit NIN/BVN registry evidence;
 * - Start hosted identity verification;
 * - Check an existing hosted verification result;
 * - Update their professional licence number.
 *
 * Administrative licence decisions and final
 * professional approval must be handled by
 * adminProfessionalVerificationController.
 *
 * VERIFICATION AUTHORITY
 *
 * ProfessionalVerificationService owns the underlying
 * verification business logic and persistence.
 *
 * Ninja and Dojah API requests are coordinated through
 * IdentityVerificationService.
 *
 * SECURITY
 *
 * - Authentication must be enforced by route middleware.
 * - req.user._id must come from trusted authentication.
 * - Never accept userId from request body or query.
 * - Never log NIN, BVN, provider credentials, or KYC URLs.
 * - Never automatically approve identity from a registry lookup.
 * - Never allow ordinary professionals to approve themselves.
 */

// ───────────────────────── ERROR HANDLING ─────────────────────────

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    logger.error(`${operation}: ${error?.code || "PROFESSIONAL_VERIFICATION_ERROR"}`);
  }

  return res.status(statusCode).json({
    success: false,

    message: statusCode === 500 ? "Unable to complete the verification request." : error.message,
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

  if (!userId) {
    const error = new Error("Authentication is required.");

    error.code = "PROFESSIONAL_VERIFICATION_AUTH_REQUIRED";
    error.statusCode = 401;

    throw error;
  }

  return userId;
}

// ───────────────────────── VERIFICATION STATUS ─────────────────────────

/**
 * Returns the authenticated professional's
 * verification and marketplace-readiness summary.
 *
 * This is a read-only operation.
 */
exports.getVerificationStatus = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const profile = await ProfessionalVerificationService.getOwnedProfessional(
      req.params.professionalProfileId,
      userId
    );

    const readiness = ProfessionalVerificationService.getVerificationReadiness(profile);

    return res.status(200).json({
      success: true,

      data: {
        professionalProfileId: String(profile._id),

        identityVerificationStatus: profile.identityVerificationStatus,

        licenceVerificationStatus: profile.licenceVerificationStatus,

        professionalApprovalStatus: profile.professionalApprovalStatus,

        marketplaceStatus: profile.marketplaceStatus,

        verificationReadiness: readiness,
      },
    });
  } catch (error) {
    return sendError(res, error, "Get professional verification status");
  }
};

// ───────────────────────── IDENTITY REGISTRY LOOKUP ─────────────────────────

/**
 * Performs a provider-selected NIN/BVN registry lookup.
 *
 * Ninja or Dojah is selected through:
 *
 * IDENTITY_VERIFICATION_PROVIDER
 *
 * A matching registry record does not authenticate
 * the person submitting the identity number.
 *
 * The professional service stores non-authoritative
 * lookup evidence without automatically approving
 * the professional.
 */
exports.lookupIdentityEvidence = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const result = await ProfessionalVerificationService.lookupIdentityEvidence({
      professionalProfileId: req.params.professionalProfileId,

      userId,

      method: req.body?.method,

      identifier: req.body?.identifier,

      firstName: req.body?.firstName,

      lastName: req.body?.lastName,

      dateOfBirth: req.body?.dateOfBirth,
    });

    return res.status(result.skipped ? 200 : 201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Lookup professional identity evidence");
  }
};

// ───────────────────────── HOSTED IDENTITY VERIFICATION ─────────────────────────

/**
 * Initiates a hosted identity verification.
 *
 * Currently uses Ninja hosted KYC.
 *
 * The service must:
 *
 * - Confirm professional ownership;
 * - Prevent unnecessary repeated paid attempts;
 * - Enforce selected-provider configuration;
 * - Create a pending KYC record;
 * - Return a trusted provider verification URL.
 *
 * The verification URL is returned only to
 * the authenticated professional.
 */
exports.startHostedIdentityVerification = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const result = await ProfessionalVerificationService.startHostedIdentityVerification({
      professionalProfileId: req.params.professionalProfileId,

      userId,

      firstName: req.body?.firstName,

      lastName: req.body?.lastName,

      email: req.body?.email,
    });

    return res.status(result.skipped ? 200 : 201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Start professional hosted identity verification");
  }
};

// ───────────────────────── HOSTED RESULT SYNCHRONIZATION ─────────────────────────

/**
 * Checks the result of an existing hosted
 * verification attempt.
 *
 * The verification ID refers to Loqum's
 * KYCVerification document.
 *
 * The service verifies:
 *
 * - Professional ownership;
 * - Original provider;
 * - Original provider environment;
 * - Original flow and request references.
 *
 * A completed hosted flow does not automatically
 * establish that selfie/liveness checks passed.
 *
 * Identity approval remains blocked until the
 * trusted biometric evidence contract is satisfied.
 */
exports.syncHostedIdentityResult = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const result = await ProfessionalVerificationService.syncHostedIdentityResult({
      professionalProfileId: req.params.professionalProfileId,

      userId,

      verificationId: req.params.verificationId,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Synchronize professional hosted identity result");
  }
};

// ───────────────────────── LICENCE NUMBER CHANGE ─────────────────────────

/**
 * Updates the professional's licence number.
 *
 * Changing the licence number requires:
 *
 * - Reset of licence verification;
 * - Creation of a fresh pending licence attempt;
 * - Reset of professional platform approval;
 * - Withdrawal of marketplace visibility.
 *
 * Existing verified identity remains unchanged.
 *
 * An unchanged licence number does not trigger
 * unnecessary re-verification.
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
