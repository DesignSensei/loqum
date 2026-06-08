// services/inviteService.js

const Invite = require("../models/Invite");
const EmployerMember = require("../models/EmployerMember");
const Branch = require("../models/Branch");
const User = require("../models/User");
const EmailService = require("./emailService");
const logger = require("../utils/logger");

class InviteService {
  static allowedRoles = ["admin", "branch_manager", "branch_staff"];

  static isAdminRole(role) {
    return role === "admin";
  }

  static normalizeEmail(email) {
    return String(email || "")
      .trim()
      .toLowerCase();
  }

  static validateRole(role) {
    if (!InviteService.allowedRoles.includes(role)) {
      throw new Error("Invalid invite role selected.");
    }
  }

  static deriveMemberRoleFromBranches(branches = []) {
    const hasManagerRole = branches.some((assignment) => assignment.role === "branch_manager");

    return hasManagerRole ? "branch_manager" : "branch_staff";
  }

  static buildMemberPayload({ userId, businessId, branchId, role }) {
    if (InviteService.isAdminRole(role)) {
      return {
        user: userId,
        business: businessId,
        role: "admin",
        branches: [],
      };
    }

    return {
      user: userId,
      business: businessId,
      role,
      branches: [
        {
          branch: branchId,
          role,
        },
      ],
    };
  }

  /* ---------- Send or Resend an Invite ---------- */

  static async sendInvite({ businessId, branchId, role, email, invitedBy }) {
    InviteService.validateRole(role);

    const normalizedEmail = InviteService.normalizeEmail(email);

    if (!normalizedEmail) {
      throw new Error("Email is required.");
    }

    const branch = await Branch.findOne({
      _id: branchId,
      business: businessId,
    });

    if (!branch) {
      throw new Error("Branch not found.");
    }

    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      const existingMember = await EmployerMember.findOne({
        user: existingUser._id,
      });

      if (existingMember) {
        const belongsToSameBusiness = String(existingMember.business) === String(businessId);

        if (!belongsToSameBusiness) {
          throw new Error("This user already belongs to another business.");
        }

        if (existingMember.role === "admin") {
          throw new Error("This user already has business-wide access.");
        }

        const alreadyAssignedToBranch = existingMember.branches.some(
          (assignment) => String(assignment.branch) === String(branchId)
        );

        if (alreadyAssignedToBranch) {
          throw new Error("This user is already assigned to this branch.");
        }
      }
    }

    const existingInvite = await Invite.findOne({
      email: normalizedEmail,
      branch: branchId,
      status: "pending",
    });

    if (existingInvite) {
      existingInvite.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      existingInvite.invitedBy = invitedBy;
      existingInvite.role = role;

      await existingInvite.save();

      const inviteUrl = `${process.env.CLIENT_URL}/invite?token=${existingInvite.token}`;

      await EmailService.sendInvite(normalizedEmail, inviteUrl, branch.name);

      logger.info(`Invite resent to ${normalizedEmail} for branch: ${branch.name}`);

      return {
        invite: existingInvite,
        resent: true,
      };
    }

    const invite = new Invite({
      email: normalizedEmail,
      business: businessId,
      branch: branchId,
      role,
      invitedBy,
    });

    await invite.save();

    const inviteUrl = `${process.env.CLIENT_URL}/invite?token=${invite.token}`;

    await EmailService.sendInvite(normalizedEmail, inviteUrl, branch.name);

    logger.info(`Invite sent to ${normalizedEmail} for branch: ${branch.name}`);

    return {
      invite,
      resent: false,
    };
  }

  /* ---------- Validate Invite Token ---------- */

  static async validateInviteToken(token) {
    const invite = await Invite.findOne({ token }).populate("business").populate("branch");

    if (!invite) {
      throw new Error("Invalid invite link.");
    }

    if (invite.status === "accepted") {
      throw new Error("This invite has already been accepted.");
    }

    if (invite.status === "revoked") {
      throw new Error("This invite has been revoked.");
    }

    if (invite.status === "expired" || invite.expiresAt < new Date()) {
      if (invite.status !== "expired") {
        invite.status = "expired";
        await invite.save();
      }

      throw new Error("This invite link has expired. Please request a new one.");
    }

    return invite;
  }

  /* ---------- Accept Invite ---------- */

  static async acceptInvite({ token, firstName, lastName, password, confirmPassword }) {
    const invite = await InviteService.validateInviteToken(token);

    InviteService.validateRole(invite.role);

    let user = await User.findOne({ email: invite.email });

    if (user) {
      const existingMember = await EmployerMember.findOne({
        user: user._id,
      });

      if (existingMember) {
        const belongsToSameBusiness =
          String(existingMember.business) === String(invite.business._id);

        if (!belongsToSameBusiness) {
          throw new Error("This user already belongs to another business.");
        }

        if (InviteService.isAdminRole(invite.role)) {
          existingMember.role = "admin";
          existingMember.branches = [];
        } else {
          if (existingMember.role === "admin") {
            throw new Error("This user already has business-wide access.");
          }

          const alreadyAssignedToBranch = existingMember.branches.some(
            (assignment) => String(assignment.branch) === String(invite.branch._id)
          );

          if (alreadyAssignedToBranch) {
            throw new Error("This user is already assigned to this branch.");
          }

          existingMember.branches.push({
            branch: invite.branch._id,
            role: invite.role,
          });

          existingMember.role = InviteService.deriveMemberRoleFromBranches(existingMember.branches);
        }

        await existingMember.save();

        if (!user.employerProfile) {
          await User.findByIdAndUpdate(user._id, {
            employerProfile: invite.business._id,
          });
        }

        invite.status = "accepted";
        await invite.save();

        logger.info(`Existing user ${invite.email} accepted invite`);

        return {
          user,
          member: existingMember,
        };
      }

      const memberPayload = InviteService.buildMemberPayload({
        userId: user._id,
        businessId: invite.business._id,
        branchId: invite.branch._id,
        role: invite.role,
      });

      const member = new EmployerMember(memberPayload);

      await member.save();

      if (!user.employerProfile) {
        await User.findByIdAndUpdate(user._id, {
          employerProfile: invite.business._id,
        });
      }

      invite.status = "accepted";
      await invite.save();

      logger.info(`Existing user ${invite.email} accepted invite`);

      return {
        user,
        member,
      };
    }

    if (!firstName || !lastName || !password || !confirmPassword) {
      throw new Error("All fields are required.");
    }

    if (password !== confirmPassword) {
      throw new Error("Passwords do not match.");
    }

    user = new User({
      firstName,
      lastName,
      email: invite.email,
      password,
      role: "employer",
      isVerified: true,
      isOnboarded: true,
      employerProfile: invite.business._id,
    });

    await user.save();

    const memberPayload = InviteService.buildMemberPayload({
      userId: user._id,
      businessId: invite.business._id,
      branchId: invite.branch._id,
      role: invite.role,
    });

    const member = new EmployerMember(memberPayload);

    await member.save();

    invite.status = "accepted";
    await invite.save();

    logger.info(`New user created and invite accepted for ${invite.email}`);

    return {
      user,
      member,
    };
  }

  /* ---------- Revoke a Pending Invite ---------- */

  static async revokeInvite({ inviteId, businessId }) {
    const invite = await Invite.findOne({
      _id: inviteId,
      business: businessId,
    });

    if (!invite) {
      throw new Error("Invite not found.");
    }

    if (invite.status === "accepted") {
      throw new Error("Cannot revoke an already accepted invite.");
    }

    if (invite.status === "revoked") {
      throw new Error("This invite has already been revoked.");
    }

    if (invite.status === "expired" || invite.expiresAt < new Date()) {
      if (invite.status !== "expired") {
        invite.status = "expired";
        await invite.save();
      }

      throw new Error("This invite has already expired.");
    }

    invite.status = "revoked";
    await invite.save();

    logger.info(`Invite ${inviteId} revoked`);

    return invite;
  }

  /* ---------- Get All Invites for a Business ---------- */

  static async getBusinessInvites({ businessId, status }) {
    const query = { business: businessId };

    if (status) {
      query.status = status;
    }

    const invites = await Invite.find(query)
      .populate("branch", "name address")
      .populate("invitedBy", "firstName lastName email")
      .sort({ createdAt: -1 });

    return invites;
  }
}

module.exports = InviteService;
