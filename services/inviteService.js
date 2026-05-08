// services/inviteService.js

const Invite = require("../models/Invite");
const EmployerMember = require("../models/EmployerMember");
const Branch = require("../models/Branch");
const User = require("../models/User");
const EmailService = require("./emailService");
const crypto = require("crypto");
const logger = require("../utils/logger");

class InviteService {
  /* ---------- Send or Resend an Invite ---------- */
  static async sendInvite({ businessId, branchId, role, email, invitedBy }) {
    // Validate branch belongs to this business
    const branch = await Branch.findOne({ _id: branchId, business: businessId });
    if (!branch) throw new Error("Branch not found");

    // Check if this email already has an account on this business
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      const existingMember = await EmployerMember.findOne({
        user: existingUser._id,
        business: businessId,
      });
      if (existingMember) throw new Error("This user is already a member of your business");
    }

    // Check for existing pending invite
    const existingInvite = await Invite.findOne({
      email,
      branch: branchId,
      status: "pending",
    });

    if (existingInvite) {
      // Resend — regenerate token and reset expiry
      existingInvite.token = crypto.randomBytes(32).toString("hex");
      existingInvite.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      existingInvite.invitedBy = invitedBy;
      await existingInvite.save();

      const inviteUrl = `${process.env.CLIENT_URL}/invite?token=${existingInvite.token}`;
      await EmailService.sendInvite(email, inviteUrl, branch.name);

      logger.info(`Invite resent to ${email} for branch: ${branch.name}`);
      return { invite: existingInvite, resent: true };
    }

    // No existing invite — create fresh
    const invite = new Invite({
      email,
      business: businessId,
      branch: branchId,
      role,
      invitedBy,
    });

    await invite.save();

    const inviteUrl = `${process.env.CLIENT_URL}/invite?token=${invite.token}`;
    await EmailService.sendInvite(email, inviteUrl, branch.name);

    logger.info(`Invite sent to ${email} for branch: ${branch.name}`);
    return { invite, resent: false };
  }

  /* ---------- Validate Invite Token ---------- */
  static async validateInviteToken(token) {
    const invite = await Invite.findOne({ token }).populate("business").populate("branch");

    if (!invite) throw new Error("Invalid invite link");

    if (invite.status === "accepted") {
      throw new Error("This invite has already been accepted");
    }

    if (invite.status === "revoked") {
      throw new Error("This invite has been revoked");
    }

    if (invite.status === "expired" || invite.expiresAt < new Date()) {
      if (invite.status !== "expired") {
        invite.status = "expired";
        await invite.save();
      }
      throw new Error("This invite link has expired. Please request a new one");
    }

    return invite;
  }

  /* ---------- Accept Invite ---------- */
  static async acceptInvite({ token, firstName, lastName, password, confirmPassword }) {
    // Validate the token first
    const invite = await InviteService.validateInviteToken(token);

    let user = await User.findOne({ email: invite.email });

    if (user) {
      // User already exists — skip account creation
      // Just create the EmployerMember and link them to the business

      const member = new EmployerMember({
        user: user._id,
        business: invite.business._id,
        branch: invite.branch._id,
        role: invite.role,
      });

      await member.save();

      // Update employerProfile reference if not already set
      if (!user.employerProfile) {
        await User.findByIdAndUpdate(user._id, {
          employerProfile: invite.business._id,
        });
      }

      invite.status = "accepted";
      await invite.save();

      logger.info(`Existing user ${invite.email} accepted invite`);
      return { user, member };
    } else {
      // User does not exist — validate signup fields and create account
      if (!firstName || !lastName || !password || !confirmPassword) {
        throw new Error("All fields are required");
      }

      if (password !== confirmPassword) {
        throw new Error("Passwords do not match");
      }

      user = new User({
        firstName,
        lastName,
        email: invite.email,
        password,
        role: "employer",
        isVerified: true, // email confirmed by clicking invite link
        isOnboarded: true, // joining existing business, no onboarding needed
        employerProfile: invite.business._id,
      });

      await user.save();

      const member = new EmployerMember({
        user: user._id,
        business: invite.business._id,
        branch: invite.branch._id,
        role: invite.role,
      });

      await member.save();

      invite.status = "accepted";
      await invite.save();

      logger.info(`New user created and invite accepted for ${invite.email}`);
      return { user, member };
    }
  }

  /* ---------- Revoke a Pending Invite ---------- */
  static async revokeInvite({ inviteId, businessId }) {
    const invite = await Invite.findOne({
      _id: inviteId,
      business: businessId,
    });

    if (!invite) throw new Error("Invite not found");

    if (invite.status === "accepted") {
      throw new Error("Cannot revoke an already accepted invite");
    }

    if (invite.status === "revoked") {
      throw new Error("This invite has already been revoked");
    }

    invite.status = "revoked";
    await invite.save();

    logger.info(`Invite ${inviteId} revoked`);
    return invite;
  }

  /* ---------- Get All Invites for a Business ---------- */
  static async getBusinessInvites({ businessId, status }) {
    const query = { business: businessId };
    if (status) query.status = status;

    const invites = await Invite.find(query)
      .populate("branch", "name address")
      .populate("invitedBy", "firstName lastName email")
      .sort({ createdAt: -1 });

    return invites;
  }
}

module.exports = InviteService;
