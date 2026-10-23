// controllers/employerVerificationController.js

const EmployerVerificationService = require("../services/employerVerificationService");
const logger = require("../utils/logger");

// ───────────────────── RESPONSE HELPERS ─────────────────────

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    logger.error(`${operation}: ${error?.code || "EMPLOYER_VERIFICATION_ERROR"}`);
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

// ───────────────────── PUBLIC VERIFICATION MESSAGES ─────────────────────

/**
 * Stored verification notes can contain internal review details.
 * Employer-facing responses must use controlled status messages.
 */
function getPublicVerificationNote(status) {
  switch (status) {
    case "verified":
      return "Verification completed successfully.";

    case "pending":
      return "Verification is pending.";

    case "needs_review":
      return "Additional review is required. Contact Loqum Support if you need assistance.";

    case "rejected":
      return "Verification was not approved. Contact Loqum Support for assistance.";

    case "failed":
      return "Verification could not be completed. Contact Loqum Support if the issue continues.";

    case "expired":
      return "This verification has expired. Contact Loqum Support for assistance.";

    default:
      return "Verification status is not yet available.";
  }
}

/**
 * CAC service results may contain provider-related diagnostics.
 * Replace the returned reason with a safe user-facing explanation.
 *
 * Other result properties are preserved for existing API consumers.
 */
function getPublicCACReason(result) {
  if (result?.providerFailure || result?.requiresManualReconciliation) {
    return "CAC verification could not be completed. Please contact Loqum Support if the issue continues.";
  }

  if (result?.stagingOnly || result?.requiresProductionVerification) {
    return "CAC verification is awaiting a production verification check.";
  }

  if (result?.requiresReview || result?.status === "needs_review") {
    return "Your CAC registration requires additional review. Contact Loqum Support if you need assistance.";
  }

  if (result?.skipped && result?.verified) {
    return "Your CAC registration is already verified.";
  }

  if (result?.skipped && result?.errorCode) {
    return "CAC verification could not be started. Contact Loqum Support if the issue continues.";
  }

  if (result?.skipped) {
    return "No additional CAC verification was performed. A recent attempt may still be within the waiting period.";
  }

  if (result?.verified) {
    return "Your CAC registration has been verified successfully.";
  }

  return getPublicVerificationNote(result?.status);
}

// ───────────────────── AUTHENTICATION ─────────────────────

function getAuthenticatedUserId(req) {
  const userId = req.user?._id;

  if (!userId) {
    const error = new Error("Authentication is required.");

    error.code = "EMPLOYER_VERIFICATION_AUTH_REQUIRED";
    error.statusCode = 401;

    throw error;
  }

  return userId;
}

// ───────────────────── EMPLOYER OWNERSHIP ─────────────────────

/**
 * Only the authenticated profile owner can access these
 * pre-onboarding verification endpoints.
 *
 * Return 404 for ownership mismatches to avoid disclosing
 * the existence of another employer's profile.
 */
async function getOwnedEmployer(employerProfileId, userId) {
  const employer = await EmployerVerificationService.getEmployer(employerProfileId);

  if (!employer.user || String(employer.user) !== String(userId)) {
    const error = new Error("Employer profile not found.");

    error.code = "EMPLOYER_VERIFICATION_PROFILE_NOT_FOUND";
    error.statusCode = 404;

    throw error;
  }

  return employer;
}

// ───────────────────── VERIFICATION STATUS ─────────────────────

/**
 * Read-only verification summary.
 *
 * Returns CAC, regulatory, approval and account statuses.
 * No external provider lookup is performed.
 */
exports.getVerificationStatus = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const employer = await getOwnedEmployer(req.params.employerProfileId, userId);

    const readiness = EmployerVerificationService.getVerificationReadiness(employer);

    return res.status(200).json({
      success: true,

      data: {
        employerProfileId: String(employer._id),

        cacVerification: {
          status: employer.cacVerificationStatus,

          method: employer.cacVerificationMethod,

          source: employer.cacVerificationSource,

          lastCheckedAt: employer.cacLastCheckedAt,

          verifiedAt: employer.cacVerifiedAt,

          note: getPublicVerificationNote(employer.cacVerificationStatus),
        },

        regulatoryVerification: {
          status: employer.regulatoryVerificationStatus,

          body: employer.regulatoryBody,

          method: employer.regulatoryVerificationMethod,

          source: employer.regulatoryVerificationSource,

          lastCheckedAt: employer.regulatoryLastCheckedAt,

          verifiedAt: employer.regulatoryVerifiedAt,

          note: getPublicVerificationNote(employer.regulatoryVerificationStatus),
        },

        employerApproval: {
          status: employer.employerApprovalStatus,

          approvedToPostShiftsAt: employer.approvedToPostShiftsAt,
        },

        accountStatus: employer.accountStatus,

        verificationReadiness: readiness,
      },
    });
  } catch (error) {
    return sendError(res, error, "Get employer verification status");
  }
};

// ───────────────────── CAC VERIFICATION ─────────────────────

/**
 * Request CAC verification for the authenticated employer.
 *
 * The verification provider is selected by server configuration.
 * Employers cannot force a recheck or submit provider parameters.
 *
 * The service enforces request locking, recent-attempt
 * suppression and authoritative verification persistence.
 */
exports.verifyCAC = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const employerProfileId = req.params.employerProfileId;

    // ───────── OWNERSHIP CHECK ─────────

    await getOwnedEmployer(employerProfileId, userId);

    // ───────── CAC VERIFICATION ─────────

    const result = await EmployerVerificationService.verifyCAC({
      employerProfileId,

      // Forced rechecks belong to administrative workflows.
      force: false,
    });

    // ───────── EMPLOYER-SAFE RESPONSE ─────────

    /*
     * Preserve the existing result structure, including flags
     * indicating whether verification was skipped or requires review.
     *
     * Replace the service reason so provider diagnostics are not
     * presented directly to employers.
     *
     * HTTP 200 means the request was handled, not necessarily
     * that the registration was verified.
     */
    return res.status(200).json({
      success: true,

      data: {
        ...result,
        reason: getPublicCACReason(result),
      },
    });
  } catch (error) {
    return sendError(res, error, "Verify employer CAC registration");
  }
};
