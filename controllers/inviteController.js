// controllers/inviteController.js

const InviteService = require("../services/inviteService");
const logger = require("../utils/logger");

const BUSINESS_PROFILE_INVITES_URL = "/employer/business-profile?tab=invites";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getInviteId(req) {
  return req.params.inviteId || req.body.inviteId;
}

function sendBadRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
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
    const { email, role, branchId } = req.body;

    const result = await InviteService.sendInvite({
      businessId: req.employerProfile._id,
      branchId,
      role,
      email,
      invitedBy: req.user._id,
    });

    return res.status(201).json({
      success: true,
      message: result.resent ? "Invite resent successfully." : "Invite sent successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Send invite error:", error);

    return sendBadRequest(res, error.message || "Unable to send invite.");
  }
};

exports.postResendInvite = async (req, res) => {
  try {
    const inviteId = getInviteId(req);

    if (!inviteId) {
      return sendBadRequest(res, "Invite ID is required.");
    }

    await InviteService.resendInvite({
      inviteId,
      businessId: req.employerProfile._id,
    });

    return res.json({
      success: true,
      message: "Invite resent successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Resend invite error:", error);

    return sendBadRequest(res, error.message || "Unable to resend invite.");
  }
};

exports.postUpdateInvite = async (req, res) => {
  try {
    const inviteId = getInviteId(req);
    const { email, role, branchId } = req.body;

    if (!inviteId) {
      return sendBadRequest(res, "Invite ID is required.");
    }

    await InviteService.updateInviteAndResend({
      inviteId,
      businessId: req.employerProfile._id,
      email,
      role,
      branchId,
      invitedBy: req.user._id,
    });

    return res.json({
      success: true,
      message: "Invite updated and resent successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Update invite error:", error);

    return sendBadRequest(res, error.message || "Unable to update invite.");
  }
};

exports.postRevokeInvite = async (req, res) => {
  try {
    const inviteId = getInviteId(req);

    if (!inviteId) {
      return sendBadRequest(res, "Invite ID is required.");
    }

    await InviteService.revokeInvite({
      inviteId,
      businessId: req.employerProfile._id,
    });

    return res.json({
      success: true,
      message: "Invite deleted successfully.",
      redirectUrl: BUSINESS_PROFILE_INVITES_URL,
    });
  } catch (error) {
    logger.error("Revoke invite error:", error);

    return sendBadRequest(res, error.message || "Unable to delete invite.");
  }
};
