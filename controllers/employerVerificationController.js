// controllers/employerVerificationController.js

const mongoose = require("mongoose");

const EmployerVerificationService = require("../services/employerVerificationService");
const FacilityPermitVerificationService = require("../services/facilityPermitVerificationService");

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

  if (res.headersSent) {
    return;
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

  error.name = "EmployerVerificationControllerError";
  error.code = code;
  error.statusCode = statusCode;

  return error;
}

// ───────────────────── PUBLIC VERIFICATION MESSAGES ─────────────────────

/**
 * Stored verification notes may contain internal
 * provider or administrative review details.
 *
 * Employer-facing responses use controlled messages.
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
      return "CAC registration could not be verified. Contact Loqum Support for assistance.";

    case "failed":
      return "Verification could not be completed. Contact Loqum Support if the issue continues.";

    case "expired":
      return "This verification has expired. Contact Loqum Support for assistance.";

    default:
      return "Verification status is not yet available.";
  }
}

/**
 * Return a controlled CAC verification message.
 *
 * Internal provider diagnostics and reconciliation
 * details must not be exposed to the employer.
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

  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw createControllerError(
      "Authentication is required.",
      "EMPLOYER_VERIFICATION_AUTH_REQUIRED",
      401
    );
  }

  return userId;
}

// ───────────────────── EMPLOYER OWNERSHIP ─────────────────────

/**
 * CAC verification belongs to the business identity.
 *
 * Only the owner may access these CAC verification
 * endpoints under the current ownership contract.
 *
 * Business-wide administrative authority for branch
 * permits does not automatically grant permission
 * to initiate or inspect owner-scoped CAC verification.
 *
 * Return 404 when the requested business does not
 * belong to the authenticated owner.
 */

async function getOwnedEmployer(employerProfileId, userId) {
  const employer = await EmployerVerificationService.getEmployer(employerProfileId);

  if (!employer.user || String(employer.user) !== String(userId)) {
    throw createControllerError(
      "Employer profile not found.",
      "EMPLOYER_VERIFICATION_PROFILE_NOT_FOUND",
      404
    );
  }

  return employer;
}

// ───────────────────── FACILITY PERMIT CONTEXT ─────────────────────

/**
 * CAC verification belongs to EmployerProfile.
 *
 * Facility permits belong to individual branches.
 *
 * The business context must come from trusted
 * employer middleware or an explicit route parameter.
 *
 * A request body cannot select another business.
 *
 * Authorised business-wide administrators may manage
 * branch permits. Branch managers and branch staff
 * cannot manage facility permits.
 *
 * FacilityPermitVerificationService performs the
 * authoritative ownership and branch checks.
 */

function getFacilityPermitContext(req) {
  const actorUserId = getAuthenticatedUserId(req);

  const attachedBusinessId = req.employerProfile?._id;

  const routeBusinessId = req.params?.employerProfileId || req.params?.businessId;

  const branchId = req.params?.branchId;

  const businessId = attachedBusinessId || routeBusinessId;

  if (!businessId || !mongoose.isValidObjectId(businessId)) {
    throw createControllerError(
      "A valid employer business is required.",
      "FACILITY_PERMIT_BUSINESS_REQUIRED",
      403
    );
  }

  if (
    attachedBusinessId &&
    routeBusinessId &&
    String(attachedBusinessId) !== String(routeBusinessId)
  ) {
    throw createControllerError(
      "Employer business context does not match.",
      "FACILITY_PERMIT_BUSINESS_CONTEXT_MISMATCH",
      403
    );
  }

  if (!branchId || !mongoose.isValidObjectId(branchId)) {
    throw createControllerError(
      "A valid branch ID is required.",
      "FACILITY_PERMIT_BRANCH_REQUIRED",
      400
    );
  }

  return {
    businessId,
    branchId,
    actorUserId,
  };
}

/**
 * Reuse the facility-permit service's authorization
 * policy rather than duplicating business owner
 * and administrator permission rules.
 */

async function assertFacilityPermitAccess(context) {
  await FacilityPermitVerificationService.assertEmployerManager({
    businessId: context.businessId,
    actorUserId: context.actorUserId,
  });

  await FacilityPermitVerificationService.getOwnedBranch({
    businessId: context.businessId,
    branchId: context.branchId,
  });
}

// ───────────────────── PRIVATE UPLOAD LIFECYCLE ─────────────────────

/**
 * parseFacilityPermitUpload executes before
 * the submission controller.
 *
 * The middleware provides:
 *
 * req.facilityPermitUpload
 * req.cleanupFacilityPermitUpload()
 * req.commitFacilityPermitUpload()
 *
 * Successful database persistence is required
 * before committing the uploaded document.
 *
 * Rejected submissions must not leave orphaned
 * private documents.
 */

function requireFacilityPermitUpload(req) {
  if (
    !req.facilityPermitUpload ||
    typeof req.facilityPermitUpload !== "object" ||
    typeof req.commitFacilityPermitUpload !== "function" ||
    typeof req.cleanupFacilityPermitUpload !== "function"
  ) {
    throw createControllerError(
      "A valid facility permit document upload is required.",
      "FACILITY_PERMIT_UPLOAD_REQUIRED",
      400
    );
  }

  return req.facilityPermitUpload;
}

async function cleanupUncommittedFacilityPermitUpload(req) {
  if (typeof req.cleanupFacilityPermitUpload !== "function") {
    return;
  }

  await req.cleanupFacilityPermitUpload();
}

// ───────────────────── CAC VERIFICATION STATUS ─────────────────────

/**
 * Read-only CAC verification summary.
 *
 * This endpoint:
 *
 * - Checks authenticated business ownership;
 * - Reports the current CAC verification state;
 * - Does not perform an external provider lookup;
 * - Does not determine shift-posting eligibility;
 * - Does not expose Employer Approval;
 * - Does not expose business-wide regulatory approval.
 *
 * Branch facility permits are assessed through
 * separate branch-specific endpoints.
 *
 * Historical evidence remains available internally
 * where required for audit.
 */

exports.getVerificationStatus = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const employer = await getOwnedEmployer(req.params.employerProfileId, userId);

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
      },
    });
  } catch (error) {
    return sendError(res, error, "Get employer verification status");
  }
};

// ───────────────────── CAC VERIFICATION ─────────────────────

/**
 * Authenticated employer CAC verification endpoint.
 *
 * Provider selection is server-controlled.
 * Forced rechecks belong to administrative workflows.
 *
 * Successful CAC verification establishes trusted
 * business registration evidence.
 *
 * It does not establish branch facility eligibility.
 * No separate Employer Approval stage applies.
 */

exports.verifyCAC = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    const employerProfileId = req.params.employerProfileId;

    await getOwnedEmployer(employerProfileId, userId);

    const result = await EmployerVerificationService.verifyCAC({
      employerProfileId,
      force: false,
    });

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

// ───────────────────── FACILITY PERMIT SUBMISSION ─────────────────────

/**
 * POST: Submit a facility permit for one branch.
 *
 * Required middleware:
 *
 * 1. Employer authentication;
 * 2. Employer profile/context attachment;
 * 3. CSRF protection;
 * 4. parseFacilityPermitUpload;
 * 5. submitFacilityPermit.
 *
 * Expected multipart document field:
 *
 * permitDocument
 *
 * Expected submission fields:
 *
 * requirementKey
 * permitNumber
 * permitDescription (optional)
 *
 * FacilityPermitVerificationService determines the
 * regulator, requirement scope and applicability.
 *
 * Employers cannot assign verification status,
 * permit validity or administrative decisions.
 *
 * Renewals use this submission workflow while
 * retaining relevant permit history.
 */

exports.submitFacilityPermit = async (req, res) => {
  setNoStoreHeaders(res);

  let persisted = false;

  try {
    const context = getFacilityPermitContext(req);

    const permitUpload = requireFacilityPermitUpload(req);

    await assertFacilityPermitAccess(context);

    const submission = {
      requirementKey: req.body?.requirementKey,
      permitNumber: req.body?.permitNumber,
      permitDescription: req.body?.permitDescription,
    };

    const result = await FacilityPermitVerificationService.submitPermit({
      businessId: context.businessId,
      branchId: context.branchId,
      actorUserId: context.actorUserId,
      submission,
      permitUpload,
    });

    // The service returns only after its database
    // transaction has completed successfully.
    persisted = true;

    // Commit before sending a successful response.
    // The middleware then retains the private document.
    req.commitFacilityPermitUpload();

    return res.status(201).json({
      success: true,

      message:
        "Facility permit submitted successfully. Administrative review is required before it can be used for branch eligibility.",

      data: {
        permitId: String(result.permitId),
        branchId: String(result.branchId),
        requirementKey: result.requirementKey,
        status: result.status,
        submittedAt: result.submittedAt,
      },
    });
  } catch (error) {
    if (!persisted) {
      try {
        await cleanupUncommittedFacilityPermitUpload(req);
      } catch (cleanupError) {
        logger.error(
          "Facility permit upload cleanup failed:",
          cleanupError?.code || cleanupError?.name || "FACILITY_PERMIT_CLEANUP_ERROR"
        );
      }
    }

    return sendError(res, error, "Submit employer facility permit");
  }
};

// ───────────────────── BRANCH PERMIT STATUS AND HISTORY ─────────────────────

/**
 * GET: List permits for one employer-owned branch.
 *
 * The facility-permit service:
 *
 * - Validates business-wide management authority;
 * - Confirms that the branch belongs to the business;
 * - Returns permit history without private documentRef;
 * - Derives branch readiness from current requirements.
 *
 * Do not expose private storage keys or file URLs.
 */

exports.getBranchFacilityPermits = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const context = getFacilityPermitContext(req);

    const result = await FacilityPermitVerificationService.listBranchPermits({
      businessId: context.businessId,
      branchId: context.branchId,
      actorUserId: context.actorUserId,
    });

    return res.status(200).json({
      success: true,

      data: {
        businessId: String(context.businessId),
        branchId: String(context.branchId),

        permits: result.permits,
        readiness: result.readiness,
      },
    });
  } catch (error) {
    return sendError(res, error, "Get employer branch facility permits");
  }
};

// ───────────────────── BRANCH REGULATORY READINESS ─────────────────────

/**
 * GET: Retrieve current branch posting readiness.
 *
 * This is an employer-facing status endpoint.
 * It does not grant shift-posting permission.
 *
 * Marketplace creation, funding, acceptance
 * and assignment flows independently revalidate
 * branch eligibility where required.
 */

exports.getBranchVerificationReadiness = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const context = getFacilityPermitContext(req);

    await assertFacilityPermitAccess(context);

    // Activate approved future permits whose validity
    // start date has arrived before calculating readiness.
    await FacilityPermitVerificationService.activateDuePermits({
      businessId: context.businessId,
      branchId: context.branchId,
    });

    const readiness = await FacilityPermitVerificationService.getBranchReadiness({
      businessId: context.businessId,
      branchId: context.branchId,
    });

    return res.status(200).json({
      success: true,

      data: {
        businessId: String(context.businessId),
        branchId: String(context.branchId),
        readiness,
      },
    });
  } catch (error) {
    return sendError(res, error, "Get employer branch verification readiness");
  }
};
