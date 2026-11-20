// controllers/branchController.js

const mongoose = require("mongoose");

const BranchService = require("../services/branchService");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const User = require("../models/User");

const logger = require("../utils/logger");

const BUSINESS_PROFILE_BRANCHES_URL = "/employer/business-profile?tab=branches";

const BUSINESS_PROFILE_TEAM_URL = "/employer/business-profile?tab=team";

// ───────────────────── HELPERS ─────────────────────

function createBranchAccessError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendBranchError(res, error, fallbackMessage) {
  const requestedStatus = Number(error?.statusCode);

  const isClientError =
    Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus < 500;

  if (!isClientError) {
    logger.error("Branch management request failed:", error);
  }

  return res.status(isClientError ? requestedStatus : 500).json({
    success: false,
    message: isClientError ? error.message || fallbackMessage : fallbackMessage,
  });
}

/*
 * Only the primary business owner or an active,
 * current business-wide administrator may create
 * or modify business branches.
 *
 * Branch managers and branch staff cannot use
 * business-wide branch management endpoints.
 *
 * Always establish authority from MongoDB rather
 * than submitted form fields or client-side flags.
 */

async function assertCanManageBranches(req) {
  const actorUserId = req.user?._id || req.user?.id;
  const employerProfileId = req.employerProfile?._id;

  if (!actorUserId || !mongoose.isValidObjectId(actorUserId)) {
    throw createBranchAccessError("Authentication is required to manage branches.", 401);
  }

  if (!employerProfileId || !mongoose.isValidObjectId(employerProfileId)) {
    throw createBranchAccessError("Employer business access is required.", 403);
  }

  const [actor, business] = await Promise.all([
    User.findOne({
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .lean(),

    EmployerProfile.findById(employerProfileId).select("_id user accountStatus").lean(),
  ]);

  if (!actor) {
    throw createBranchAccessError("An active, verified employer account is required.", 403);
  }

  if (!business) {
    throw createBranchAccessError("Employer business profile not found.", 404);
  }

  if (business.accountStatus !== "active") {
    throw createBranchAccessError(
      "Branch management is unavailable while the employer business account is restricted or inactive.",
      403
    );
  }

  const isBusinessOwner = business.user && String(business.user) === String(actor._id);

  if (isBusinessOwner) {
    return {
      businessId: business._id,
      actorUserId: actor._id,
    };
  }

  const adminMember = await EmployerMember.findOne({
    business: business._id,
    user: actor._id,
    role: "admin",
    accountStatus: "active",
    isCurrent: true,
  })
    .select("_id")
    .lean();

  if (!adminMember) {
    throw createBranchAccessError(
      "Only the business owner or an active business administrator can manage branches.",
      403
    );
  }

  return {
    businessId: business._id,
    actorUserId: actor._id,
  };
}

// ───────────────────── SAFE GET REDIRECTS ─────────────────────

exports.getBranches = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_BRANCHES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.getNewBranch = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_BRANCHES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.getEditBranch = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_BRANCHES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.getBranchMembers = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_TEAM_URL);
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── BRANCH ACTIONS ─────────────────────

exports.postNewBranch = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageBranches(req);

    await BranchService.createBranch({
      businessId,
      body: req.body,
      actorUserId,
    });

    return res.status(201).json({
      success: true,
      message: "Branch added successfully.",
      redirectUrl: BUSINESS_PROFILE_BRANCHES_URL,
    });
  } catch (error) {
    return sendBranchError(res, error, "Unable to add branch.");
  }
};

exports.postEditBranch = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageBranches(req);

    const branchId = req.params?.branchId || req.body?.branchId;

    if (!branchId) {
      return res.status(400).json({
        success: false,
        message: "Branch ID is required.",
      });
    }

    if (!mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch ID.",
      });
    }

    await BranchService.updateBranch({
      branchId,
      businessId,
      body: req.body,
      actorUserId,
    });

    return res.json({
      success: true,
      message: "Branch updated successfully.",
      redirectUrl: BUSINESS_PROFILE_BRANCHES_URL,
    });
  } catch (error) {
    return sendBranchError(res, error, "Unable to update branch.");
  }
};

// ───────────────────── BRANCH ACTIVATION / DEACTIVATION ─────────────────────

/*
 * POST /employer/branches/:branchId/status
 *
 * Accepted body:
 * {
 *   action: "activate" | "deactivate"
 * }
 *
 * Only the business owner or an active business
 * administrator may change a branch's active status.
 *
 * Important separation:
 *
 * - isActive is the branch's administrative status.
 * - It is not CAC verification.
 * - It is not facility permit approval.
 * - Reactivating a branch does not automatically
 *   reactivate previously deactivated permits.
 * - Permit readiness and shift-posting eligibility
 *   remain independently enforced by their services.
 *
 * BranchService is responsible for performing the
 * business-scoped database mutation.
 */

exports.postSetBranchStatus = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageBranches(req);

    const branchId = req.params?.branchId;
    const action = req.body?.action;

    if (!branchId) {
      return res.status(400).json({
        success: false,
        message: "Branch ID is required.",
      });
    }

    if (!mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch ID.",
      });
    }

    if (typeof action !== "string" || !["activate", "deactivate"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Invalid branch action. Use activate or deactivate.",
      });
    }

    const isActive = action === "activate";

    const updatedBranch = await BranchService.setBranchActiveStatus({
      branchId,
      businessId,
      actorUserId,
      isActive,
    });

    return res.status(200).json({
      success: true,

      message: isActive ? "Branch reactivated successfully." : "Branch deactivated successfully.",

      branchId: String(updatedBranch._id),
      isActive: updatedBranch.isActive === true,

      redirectUrl: BUSINESS_PROFILE_BRANCHES_URL,
    });
  } catch (error) {
    return sendBranchError(res, error, "Unable to change branch status.");
  }
};
