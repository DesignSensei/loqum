// controllers/teamMemberController.js

const TeamMemberService = require("../services/teamMemberService");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const User = require("../models/User");
const mongoose = require("mongoose");
const logger = require("../utils/logger");

const BUSINESS_PROFILE_TEAM_URL = "/employer/business-profile?tab=team";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getMemberId(req) {
  return req.params?.memberId || req.body?.memberId;
}

function getMemberStatus(req) {
  return String(req.body?.memberStatus || req.query?.memberStatus || "active")
    .toLowerCase()
    .trim();
}

function getTeamRedirectUrl(req) {
  const memberStatus = getMemberStatus(req);

  return `${BUSINESS_PROFILE_TEAM_URL}&memberStatus=${encodeURIComponent(memberStatus)}`;
}

function sendBadRequest(res, message, statusCode = 400) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}

function createTeamMemberError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/* ─────────────────────────────── TEAM MEMBER AUTHORISATION ─────────────────────────────── */

/**
 * Only the primary business owner or an active,
 * current business-wide employer administrator
 * may view, update or remove team members.
 *
 * EmployerMember.role = "admin" represents
 * business-level administration.
 *
 * It is not the platform-level User.role "admin".
 *
 * Branch managers and branch staff cannot
 * independently manage business team membership.
 *
 * Professionals cannot access this workflow.
 *
 * The employer business must be resolved
 * from the authenticated request context.
 *
 * Recheck the actor's account, business ownership
 * and current membership against MongoDB.
 *
 * Do not trust a submitted user ID, business ID
 * or role as evidence of authority.
 *
 * Member updates and removals remain scoped
 * to the authenticated employer business.
 */

async function assertCanManageTeamMembers(req) {
  const actorUserId = req.user?._id || req.user?.id;
  const employerProfileId = req.employerProfile?._id;

  if (!actorUserId || !mongoose.isValidObjectId(actorUserId)) {
    throw createTeamMemberError("Authentication is required to manage team members.", 401);
  }

  if (!employerProfileId || !mongoose.isValidObjectId(employerProfileId)) {
    throw createTeamMemberError(
      "Employer business access is required to manage team members.",
      403
    );
  }

  /*
   * Confirm the requesting user is an
   * active, email-verified employer account.
   *
   * A removed team member may retain an
   * active Loqum User account.
   *
   * That does not grant business access.
   * Business membership must be checked
   * independently below.
   */

  const actor = await User.findOne({
    _id: actorUserId,
    role: "employer",
    accountStatus: "active",
    isVerified: true,
  })
    .select("_id role accountStatus isVerified")
    .lean();

  if (!actor) {
    throw createTeamMemberError(
      "An active, verified employer account is required to manage team members.",
      403
    );
  }

  /*
   * Reload the employer business instead
   * of treating req.employerProfile as
   * independent proof of ownership.
   */

  const employerProfile = await EmployerProfile.findById(employerProfileId)
    .select("_id user accountStatus")
    .lean();

  if (!employerProfile) {
    throw createTeamMemberError("Employer business profile not found.", 404);
  }

  /*
   * Primary employer ownership is established
   * by EmployerProfile.user.
   *
   * The business owner does not need a
   * separate EmployerMember record.
   */

  const isBusinessOwner = Boolean(
    employerProfile.user && String(employerProfile.user) === String(actor._id)
  );

  if (isBusinessOwner) {
    return {
      businessId: employerProfile._id,
      actorUserId: actor._id,
    };
  }

  /*
   * Invited business administrators must have
   * an active, current membership in this
   * exact employer business.
   *
   * Removed historical memberships cannot
   * authorise team management, even when
   * the user's Loqum account remains active.
   *
   * Branch managers and branch staff do not
   * receive business-wide team management
   * permissions.
   */

  const adminMember = await EmployerMember.findOne({
    business: employerProfile._id,
    user: actor._id,
    role: "admin",
    accountStatus: "active",
    isCurrent: true,
  })
    .select("_id")
    .lean();

  if (!adminMember) {
    throw createTeamMemberError(
      "Only the business owner or an active business administrator can manage team members.",
      403
    );
  }

  return {
    businessId: employerProfile._id,
    actorUserId: actor._id,
  };
}

/* ─────────────────────────────── EMPLOYER TEAM MEMBER ACTIONS ─────────────────────────────── */

exports.getTeamMember = async (req, res) => {
  try {
    const { businessId } = await assertCanManageTeamMembers(req);

    const memberId = getMemberId(req);

    if (!memberId) {
      return sendBadRequest(res, "Team member ID is required.");
    }

    const member = await TeamMemberService.getTeamMember({
      memberId,
      businessId,
    });

    return res.json({
      success: true,
      member,
    });
  } catch (error) {
    logger.error("Get team member error:", error);

    return sendBadRequest(
      res,
      error.message || "Unable to load team member.",
      error.statusCode || 400
    );
  }
};

exports.postUpdateTeamMember = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageTeamMembers(req);

    const memberId = getMemberId(req);

    if (!memberId) {
      return sendBadRequest(res, "Team member ID is required.");
    }

    const { role, accountStatus, branchIds } = req.body;

    await TeamMemberService.updateTeamMember({
      memberId,
      businessId,
      updatedBy: actorUserId,
      role,
      accountStatus,
      branchIds,
    });

    return res.json({
      success: true,
      message: "Team member updated successfully.",
      redirectUrl: getTeamRedirectUrl(req),
    });
  } catch (error) {
    logger.error("Update team member error:", error);

    return sendBadRequest(
      res,
      error.message || "Unable to update team member.",
      error.statusCode || 400
    );
  }
};

exports.postRemoveTeamMember = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageTeamMembers(req);

    const memberId = getMemberId(req);

    if (!memberId) {
      return sendBadRequest(res, "Team member ID is required.");
    }

    await TeamMemberService.removeTeamMember({
      memberId,
      businessId,
      removedBy: actorUserId,
      removalReason: req.body?.removalReason,
    });

    return res.json({
      success: true,
      message: "Team member removed successfully.",
      redirectUrl: getTeamRedirectUrl(req),
    });
  } catch (error) {
    logger.error("Remove team member error:", error);

    return sendBadRequest(
      res,
      error.message || "Unable to remove team member.",
      error.statusCode || 400
    );
  }
};
