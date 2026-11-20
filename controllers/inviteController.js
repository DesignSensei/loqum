// controllers/inviteController.js

const InviteService = require("../services/inviteService");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const User = require("../models/User");
const mongoose = require("mongoose");
const logger = require("../utils/logger");

const BUSINESS_PROFILE_INVITES_URL = "/employer/business-profile?tab=invites";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getInviteId(req) {
  return req.params?.inviteId || req.body?.inviteId;
}

function sendBadRequest(res, message, statusCode = 400) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}

function createInviteError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/* ─────────────────────────────── INVITE AUTHORISATION ─────────────────────────────── */

/**
 * Only the employer business owner or an active,
 * current business-wide administrator may manage
 * invitations for the employer business.
 *
 * EmployerMember.role = "admin" represents an
 * employer team administrator, not a platform
 * administrator.
 *
 * Branch managers and branch staff cannot create,
 * edit, resend or revoke business invitations.
 *
 * Professional and platform admin User accounts
 * are not eligible to act as employer team members.
 *
 * Do not rely solely on req.employerProfile,
 * req.employerContext or session role information.
 *
 * Recheck the authenticated user, employer profile
 * ownership and team membership against MongoDB.
 *
 * This check must run before each invitation
 * mutation, including requests sent directly
 * to the API instead of through the interface.
 */

async function assertCanManageInvites(req) {
  const actorUserId = req.user?._id || req.user?.id;
  const employerProfileId = req.employerProfile?._id;

  if (!actorUserId || !mongoose.isValidObjectId(actorUserId)) {
    throw createInviteError("Authentication is required to manage invitations.", 401);
  }

  if (!employerProfileId || !mongoose.isValidObjectId(employerProfileId)) {
    throw createInviteError("Employer business access is required to manage invitations.", 403);
  }

  /**
   * Confirm that the authenticated account
   * is an active, email-verified employer user.
   *
   * A restricted, suspended, deactivated or
   * banned account cannot manage invitations.
   *
   * Email verification does not establish
   * CAC verification or regulatory approval.
   * Those remain separate employer workflows.
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
    throw createInviteError(
      "An active, verified employer account is required to manage invitations.",
      403
    );
  }

  /**
   * Load the business from the database.
   *
   * req.employerProfile provides the current
   * business identifier, but does not itself
   * establish the actor's authority.
   */

  const employerProfile = await EmployerProfile.findById(employerProfileId)
    .select("_id user accountStatus")
    .lean();

  if (!employerProfile) {
    throw createInviteError("Employer business profile not found.", 404);
  }

  if (employerProfile.accountStatus !== "active") {
    throw createInviteError(
      "Invitations cannot be managed while this business account is inactive or restricted.",
      403
    );
  }

  /**
   * The primary employer account owns the
   * business through EmployerProfile.user.
   *
   * Business ownership grants invitation
   * management authority independently of
   * a separate EmployerMember record.
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

  /**
   * Other employer users must be active,
   * current members of this exact business
   * with the business-wide admin role.
   *
   * Branch managers and branch staff do not
   * inherit invitation management authority.
   *
   * Removed, restricted or suspended members
   * must not retain invitation permissions.
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
    throw createInviteError(
      "Only the business owner or an active business administrator can manage invitations.",
      403
    );
  }

  return {
    businessId: employerProfile._id,
    actorUserId: actor._id,
  };
}

/* ─────────────────────────────── EMPLOYER INVITE ACTIONS ─────────────────────────────── */

exports.getInvites = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_INVITES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.postSendInvite = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageInvites(req);

    const { email, role, branchId } = req.body;

    const result = await InviteService.sendInvite({
      businessId,
      branchId,
      role,
      email,
      invitedBy: actorUserId,
    });

    return res.status(201).json({
      success: true,
      message: result.resent ? "Invite resent successfully." : "Invite sent successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Send invite error:", error);

    return sendBadRequest(res, error.message || "Unable to send invite.", error.statusCode || 400);
  }
};

exports.postResendInvite = async (req, res) => {
  try {
    const { businessId } = await assertCanManageInvites(req);

    const inviteId = getInviteId(req);

    if (!inviteId) {
      return sendBadRequest(res, "Invite ID is required.");
    }

    await InviteService.resendInvite({
      inviteId,
      businessId,
    });

    return res.json({
      success: true,
      message: "Invite resent successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Resend invite error:", error);

    return sendBadRequest(
      res,
      error.message || "Unable to resend invite.",
      error.statusCode || 400
    );
  }
};

exports.postUpdateInvite = async (req, res) => {
  try {
    const { businessId, actorUserId } = await assertCanManageInvites(req);

    const inviteId = getInviteId(req);
    const { email, role, branchId } = req.body;

    if (!inviteId) {
      return sendBadRequest(res, "Invite ID is required.");
    }

    await InviteService.updateInviteAndResend({
      inviteId,
      businessId,
      email,
      role,
      branchId,
      invitedBy: actorUserId,
    });

    return res.json({
      success: true,
      message: "Invite updated and resent successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Update invite error:", error);

    return sendBadRequest(
      res,
      error.message || "Unable to update invite.",
      error.statusCode || 400
    );
  }
};

exports.postRevokeInvite = async (req, res) => {
  try {
    const { businessId } = await assertCanManageInvites(req);

    const inviteId = getInviteId(req);

    if (!inviteId) {
      return sendBadRequest(res, "Invite ID is required.");
    }

    await InviteService.revokeInvite({
      inviteId,
      businessId,
    });

    return res.json({
      success: true,
      message: "Invite deleted successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Revoke invite error:", error);

    return sendBadRequest(
      res,
      error.message || "Unable to delete invite.",
      error.statusCode || 400
    );
  }
};
