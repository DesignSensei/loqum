// controllers/teamMemberController.js

const TeamMemberService = require("../services/teamMemberService");
const logger = require("../utils/logger");

const BUSINESS_PROFILE_TEAM_URL = "/employer/business-profile?tab=team";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getMemberId(req) {
  return req.params.memberId || req.body.memberId;
}

function getMemberStatus(req) {
  return String(req.body.memberStatus || req.query.memberStatus || "active")
    .toLowerCase()
    .trim();
}

function getTeamRedirectUrl(req) {
  const memberStatus = getMemberStatus(req);

  return `${BUSINESS_PROFILE_TEAM_URL}&memberStatus=${encodeURIComponent(memberStatus)}`;
}

function sendBadRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
}

/* ─────────────────────────────── EMPLOYER TEAM MEMBER ACTIONS ─────────────────────────────── */

exports.getTeamMember = async (req, res) => {
  try {
    const memberId = getMemberId(req);

    if (!memberId) {
      return sendBadRequest(res, "Team member ID is required.");
    }

    const member = await TeamMemberService.getTeamMember({
      memberId,
      businessId: req.employerProfile._id,
    });

    return res.json({
      success: true,
      member,
    });
  } catch (error) {
    logger.error("Get team member error:", error);

    return sendBadRequest(res, error.message || "Unable to load team member.");
  }
};

exports.postUpdateTeamMember = async (req, res) => {
  try {
    const memberId = getMemberId(req);

    if (!memberId) {
      return sendBadRequest(res, "Team member ID is required.");
    }

    const { role, accountStatus, branchIds } = req.body;

    await TeamMemberService.updateTeamMember({
      memberId,
      businessId: req.employerProfile._id,
      updatedBy: req.user._id,
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

    return sendBadRequest(res, error.message || "Unable to update team member.");
  }
};

exports.postRemoveTeamMember = async (req, res) => {
  try {
    const memberId = getMemberId(req);

    if (!memberId) {
      return sendBadRequest(res, "Team member ID is required.");
    }

    await TeamMemberService.removeTeamMember({
      memberId,
      businessId: req.employerProfile._id,
      removedBy: req.user._id,
      removalReason: req.body.removalReason,
    });

    return res.json({
      success: true,
      message: "Team member removed successfully.",
      redirectUrl: getTeamRedirectUrl(req),
    });
  } catch (error) {
    logger.error("Remove team member error:", error);

    return sendBadRequest(res, error.message || "Unable to remove team member.");
  }
};
