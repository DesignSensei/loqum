// services/inviteService.js

const crypto = require("crypto");
const mongoose = require("mongoose");

const Invite = require("../models/Invite");
const EmployerMember = require("../models/EmployerMember");
const Branch = require("../models/Branch");
const User = require("../models/User");
const EmployerProfile = require("../models/EmployerProfile");
const EmailService = require("./emailService");
const logger = require("../utils/logger");

class InviteService {
  static allowedRoles = ["admin", "branch_manager", "branch_staff"];

  static isAdminRole(role) {
    return role === "admin";
  }

  static requiresBranch(role) {
    return role === "branch_manager" || role === "branch_staff";
  }

  static normalizeEmail(email) {
    return String(email || "")
      .trim()
      .toLowerCase();
  }

  static normalizeToken(token) {
    return String(token || "").trim();
  }

  static validateRole(role) {
    if (!InviteService.allowedRoles.includes(role)) {
      throw new Error("Invalid invite role selected.");
    }
  }

  static getObjectId(value) {
    return value && value._id ? value._id : value;
  }

  static idsMatch(firstValue, secondValue) {
    if (!firstValue || !secondValue) return false;

    return (
      String(InviteService.getObjectId(firstValue)) ===
      String(InviteService.getObjectId(secondValue))
    );
  }

  static getInviteUrl(token) {
    const clientUrl = String(process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");

    const normalizedToken = InviteService.normalizeToken(token);

    return `${clientUrl}/signup?inviteToken=${encodeURIComponent(normalizedToken)}`;
  }

  static formatInviteText(value) {
    const cleanValue = String(value || "");

    if (cleanValue === "revoked") {
      return "Deleted";
    }

    return cleanValue.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }

  static formatInviteRole(role) {
    return InviteService.formatInviteText(role);
  }

  static getBusinessName(business) {
    return business?.businessName || business?.name || "this business";
  }

  static getBranchName(branch) {
    return branch?.name || "";
  }

  static getMemberBranches(member) {
    return Array.isArray(member?.branches) ? member.branches : [];
  }

  static deriveMemberRoleFromBranches(branches = []) {
    const hasManagerRole = branches.some((assignment) => assignment.role === "branch_manager");

    return hasManagerRole ? "branch_manager" : "branch_staff";
  }

  static buildMemberPayload({ userId, businessId, branchId, role }) {
    /*
     * EmployerMember.role "admin" is business-wide
     * administration, not platform User.role "admin".
     */

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

  // ───────────────────── EMPLOYER INVITATION ELIGIBILITY ─────────────────────

  static async validateExistingUserForInvite({ user, businessId, session = null }) {
    if (!user) return null;

    if (user.role !== "employer") {
      throw new Error("This user account cannot accept employer team invites.");
    }

    if (user.accountStatus !== "active") {
      throw new Error("This account cannot accept team invites while restricted or inactive.");
    }

    /*
     * Only current membership counts as an
     * existing employer team membership.
     */

    const memberQuery = EmployerMember.findOne({
      user: user._id,
      isCurrent: true,
    });

    if (session) {
      memberQuery.session(session);
    }

    const existingMember = await memberQuery;

    if (existingMember && !InviteService.idsMatch(existingMember.business, businessId)) {
      throw new Error("This user already belongs to another business.");
    }

    /*
     * Business ownership is independent of
     * employer team membership.
     */

    const ownedBusinessQuery = EmployerProfile.findOne({
      user: user._id,
    }).select("_id");

    if (session) {
      ownedBusinessQuery.session(session);
    }

    const ownedBusiness = await ownedBusinessQuery;

    if (ownedBusiness && !InviteService.idsMatch(ownedBusiness._id, businessId)) {
      throw new Error(
        "This user owns another employer business and cannot join a different business through a team invite."
      );
    }

    /*
     * A previous employerProfile reference may
     * remain after documented membership removal.
     *
     * Permit a new membership only when the
     * previous membership is confirmed removed.
     */

    if (user.employerProfile && !InviteService.idsMatch(user.employerProfile, businessId)) {
      const previousBusinessId = InviteService.getObjectId(user.employerProfile);

      const previousMembershipQuery = EmployerMember.findOne({
        user: user._id,
        business: previousBusinessId,
        accountStatus: "removed",
        isCurrent: false,
      }).select("_id");

      if (session) {
        previousMembershipQuery.session(session);
      }

      const previousMembership = await previousMembershipQuery;

      if (!previousMembership) {
        throw new Error(
          "This user is linked to another employer business without a confirmed removed membership."
        );
      }
    }

    return existingMember;
  }

  static userIsAssignedToBranch(member, branchId) {
    const branches = InviteService.getMemberBranches(member);

    return branches.some((assignment) => InviteService.idsMatch(assignment.branch, branchId));
  }

  static addOrReplaceBranchAssignment({ member, branchId, role }) {
    const existingBranches = InviteService.getMemberBranches(member);

    const branchesWithoutCurrentBranch = existingBranches.filter(
      (assignment) => !InviteService.idsMatch(assignment.branch, branchId)
    );

    branchesWithoutCurrentBranch.push({
      branch: branchId,
      role,
    });

    member.branches = branchesWithoutCurrentBranch;

    member.role = InviteService.deriveMemberRoleFromBranches(branchesWithoutCurrentBranch);

    return member;
  }

  static assertInviteRecipientAssignment({ member, role, branchId }) {
    if (!member) return;

    if (member.role === "admin") {
      throw new Error("This user already has business-wide access.");
    }

    if (
      !InviteService.isAdminRole(role) &&
      InviteService.userIsAssignedToBranch(member, branchId)
    ) {
      throw new Error("This user is already assigned to this branch.");
    }
  }

  // ───────────────────── CONDITIONAL INVITE ROTATION ─────────────────────

  static async rotateInviteIfUnchanged({ invite, businessId, updates, unset = {} }) {
    const replacement = await Invite.findOneAndUpdate(
      {
        _id: invite._id,
        business: businessId,
        token: invite.token,
        status: { $in: ["pending", "expired"] },
      },
      {
        $set: {
          ...updates,
          status: "pending",
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
          token: crypto.randomBytes(32).toString("hex"),
        },
        $unset: {
          acceptedAt: "",
          revokedAt: "",
          ...unset,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!replacement) {
      throw new Error("This invitation has changed or is no longer editable. Please reload.");
    }

    return replacement;
  }

  // ───────────────────── BRANCH MANAGER REPLACEMENT ─────────────────────

  /*
   * IMPORTANT:
   *
   * TeamMemberService uses a write to the
   * relevant Branch document to coordinate
   * competing manager assignments.
   *
   * Invitation acceptance must use that
   * same coordination mechanism.
   *
   * Both operations must execute inside a
   * MongoDB transaction.
   */

  static async demoteExistingBranchManagers({
    businessId,
    branchId,
    newManagerUserId,
    session = null,
  }) {
    if (!branchId || !newManagerUserId) {
      return;
    }

    if (!session) {
      throw new Error("Branch manager reassignment requires a MongoDB transaction.");
    }

    /*
     * Write to the shared Branch document before
     * inspecting or modifying existing managers.
     *
     * Concurrent transactions assigning managers
     * to this branch must coordinate through
     * this same database document.
     *
     * timestamps: false prevents Mongoose from
     * adding another updatedAt update operator.
     *
     * This matches the branch coordination used
     * by TeamMemberService.
     */

    const lockedBranch = await Branch.findOneAndUpdate(
      {
        _id: branchId,
        business: businessId,
      },
      {
        $currentDate: {
          updatedAt: true,
        },
      },
      {
        session,
        new: true,
        timestamps: false,
      }
    ).select("_id");

    if (!lockedBranch) {
      throw new Error("Selected branch no longer belongs to this business.");
    }

    /*
     * Removed historical memberships must never
     * be changed during manager replacement.
     *
     * Restricted and suspended current managers
     * are included so their outdated manager
     * assignments cannot return if reactivated.
     */

    const existingManagers = await EmployerMember.find({
      business: businessId,
      user: { $ne: newManagerUserId },
      isCurrent: true,
      accountStatus: { $ne: "removed" },
      branches: {
        $elemMatch: {
          branch: branchId,
          role: "branch_manager",
        },
      },
    }).session(session);

    /*
     * Process sequentially because all writes
     * share the same transaction session.
     */

    for (const member of existingManagers) {
      let changed = false;

      for (const assignment of InviteService.getMemberBranches(member)) {
        if (
          InviteService.idsMatch(assignment.branch, branchId) &&
          assignment.role === "branch_manager"
        ) {
          assignment.role = "branch_staff";
          changed = true;
        }
      }

      if (!changed) {
        continue;
      }

      member.role = InviteService.deriveMemberRoleFromBranches(
        InviteService.getMemberBranches(member)
      );

      await member.save({ session });
    }
  }

  // ───────────────────── SEND / RESEND INVITE ─────────────────────

  static async sendInvite({ businessId, branchId, role, email, invitedBy }) {
    InviteService.validateRole(role);

    const normalizedEmail = InviteService.normalizeEmail(email);

    if (!normalizedEmail || normalizedEmail.endsWith("@closed.loqum.invalid")) {
      throw new Error("A valid invitation email is required.");
    }

    const business = await EmployerProfile.findOne({
      _id: businessId,
      accountStatus: "active",
    }).select("businessName");

    if (!business) {
      throw new Error("Business profile not found.");
    }

    let branch = null;

    if (InviteService.requiresBranch(role)) {
      if (!branchId) {
        throw new Error("Branch is required for branch managers and branch staff.");
      }

      branch = await Branch.findOne({
        _id: branchId,
        business: businessId,
      });

      if (!branch) {
        throw new Error("Branch not found.");
      }
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
    });

    const existingMember = await InviteService.validateExistingUserForInvite({
      user: existingUser,
      businessId,
    });

    InviteService.assertInviteRecipientAssignment({
      member: existingMember,
      role,
      branchId,
    });

    const inviteLabel = InviteService.isAdminRole(role)
      ? business.businessName || "your business"
      : branch.name;

    const existingPendingBusinessInvite = await Invite.findOne({
      email: normalizedEmail,
      business: businessId,
      status: "pending",
    });

    if (existingPendingBusinessInvite) {
      const updatedInvite = await InviteService.rotateInviteIfUnchanged({
        invite: existingPendingBusinessInvite,
        businessId,
        updates: {
          invitedBy,
          role,
          ...(InviteService.isAdminRole(role) ? {} : { branch: branch._id }),
        },
        unset: InviteService.isAdminRole(role) ? { branch: "" } : {},
      });

      await EmailService.sendInvite(
        normalizedEmail,
        InviteService.getInviteUrl(updatedInvite.token),
        inviteLabel
      );

      logger.info(`Invite resent to ${normalizedEmail} for ${inviteLabel}`);

      return {
        invite: updatedInvite,
        resent: true,
      };
    }

    const invitePayload = {
      email: normalizedEmail,
      business: businessId,
      role,
      invitedBy,
    };

    if (!InviteService.isAdminRole(role)) {
      invitePayload.branch = branch._id;
    }

    const invite = new Invite(invitePayload);

    try {
      await invite.save();
    } catch (error) {
      if (error?.code === 11000) {
        throw new Error("This email already has an invitation for this business. Please retry.");
      }

      throw error;
    }

    await EmailService.sendInvite(
      normalizedEmail,
      InviteService.getInviteUrl(invite.token),
      inviteLabel
    );

    logger.info(`Invite sent to ${normalizedEmail} for ${inviteLabel}`);

    return {
      invite,
      resent: false,
    };
  }

  // ───────────────────── VALIDATE INVITE TOKEN ─────────────────────

  static async validateInviteToken(token) {
    const normalizedToken = InviteService.normalizeToken(token);

    if (!normalizedToken) {
      throw new Error("Invite token is required.");
    }

    const invite = await Invite.findOne({
      token: normalizedToken,
    })
      .populate("business")
      .populate("branch");

    if (!invite) {
      throw new Error("Invalid invite link.");
    }

    if (invite.status === "accepted") {
      throw new Error("This invite has already been accepted.");
    }

    if (invite.status === "revoked") {
      throw new Error("This invite has been revoked.");
    }

    const now = new Date();

    if (invite.status === "expired" || !invite.expiresAt || invite.expiresAt <= now) {
      if (invite.status === "pending" && invite.expiresAt && invite.expiresAt <= now) {
        await Invite.updateOne(
          {
            _id: invite._id,
            token: normalizedToken,
            status: "pending",
            expiresAt: { $lte: now },
          },
          {
            $set: {
              status: "expired",
            },
          }
        );
      }

      throw new Error("This invite link has expired. Please request a new one.");
    }

    if (invite.status !== "pending") {
      throw new Error("This invite is no longer active.");
    }

    InviteService.validateRole(invite.role);

    if (!invite.business || invite.business.accountStatus !== "active") {
      throw new Error("The business associated with this invite is not active.");
    }

    if (InviteService.normalizeEmail(invite.email).endsWith("@closed.loqum.invalid")) {
      throw new Error("This invitation has an invalid email address.");
    }

    if (InviteService.isAdminRole(invite.role) && invite.branch) {
      throw new Error("Business-wide administrator invites cannot have a branch assignment.");
    }

    if (InviteService.requiresBranch(invite.role)) {
      if (!invite.branch) {
        throw new Error("This invite is missing a branch assignment.");
      }

      if (
        !InviteService.idsMatch(invite.branch.business, InviteService.getObjectId(invite.business))
      ) {
        throw new Error("This invite has an invalid business branch assignment.");
      }
    }

    return invite;
  }

  // ───────────────────── INVITATION STATE CHANGES ─────────────────────

  static async markInviteAccepted() {
    throw new Error(
      "Use acceptAuthenticatedInvite so membership and invitation acceptance happen atomically."
    );
  }

  static async markInviteRevoked(invite) {
    const updated = await Invite.findOneAndUpdate(
      {
        _id: invite._id,
        token: invite.token,
        status: { $in: ["pending", "expired"] },
      },
      {
        $set: {
          status: "revoked",
          revokedAt: new Date(),
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updated) {
      throw new Error("This invitation has already changed or is no longer revocable.");
    }

    return updated;
  }

  // ───────────────────── SIGNUP INVITE CONTEXT ─────────────────────

  static async getSignupInviteContext(inviteToken) {
    const token = InviteService.normalizeToken(inviteToken);

    const defaultContext = {
      isInviteSignup: Boolean(token),
      hasInviteError: false,
      existingInviteUser: false,

      inviteToken: token,
      inviteError: null,

      inviteEmail: "",
      inviteBusinessName: "this business",
      inviteBranchName: "",
      inviteRoleLabel: "",

      pageTitle: token ? "Accept Team Invite" : "Sign Up",
      subtitle: token
        ? "Create your account to accept your team invite."
        : "Choose how you want to use Loqum",

      submitLabel: token ? "Accept Invite" : "Continue",
      loginUrl: token ? `/login?inviteToken=${encodeURIComponent(token)}` : "/login",

      shouldDisableSubmit: false,

      showGoogleSignup: !token,
      googleSignupUrl: "",
    };

    if (!token) {
      return defaultContext;
    }

    try {
      const invite = await InviteService.validateInviteToken(token);

      const existingUser = await User.findOne({
        email: invite.email,
      });

      if (existingUser) {
        await InviteService.validateExistingUserForInvite({
          user: existingUser,
          businessId: InviteService.getObjectId(invite.business),
        });
      }

      const existingInviteUser = Boolean(existingUser);

      const inviteBusinessName = InviteService.getBusinessName(invite.business);

      return {
        ...defaultContext,

        existingInviteUser,

        inviteEmail: invite.email || "",
        inviteBusinessName,
        inviteBranchName: InviteService.getBranchName(invite.branch),
        inviteRoleLabel: InviteService.formatInviteRole(invite.role),

        pageTitle: existingInviteUser ? "Log In to Accept Invite" : "Accept Team Invite",

        subtitle: existingInviteUser
          ? "This email already has a Loqum account. Please log in to accept the invite."
          : `Create your account to join ${inviteBusinessName}.`,

        shouldDisableSubmit: existingInviteUser,

        showGoogleSignup: !existingInviteUser,

        googleSignupUrl: `/auth/google?intent=signup&inviteToken=${encodeURIComponent(token)}`,
      };
    } catch (error) {
      return {
        ...defaultContext,

        hasInviteError: true,
        inviteError: error.message || "Invalid invite link.",
        shouldDisableSubmit: true,
      };
    }
  }

  // ───────────────────── LOGIN INVITE CONTEXT ─────────────────────

  static async getLoginInviteContext(inviteToken) {
    const token = InviteService.normalizeToken(inviteToken);

    const defaultContext = {
      isInviteLogin: Boolean(token),
      hasInviteError: false,

      inviteToken: token,
      inviteError: null,

      inviteEmail: "",
      inviteBusinessName: "this business",
      inviteBranchName: "",
      inviteRoleLabel: "",

      pageTitle: token ? "Log In to Accept Invite" : "Log In",

      subtitle: token ? "Log in to accept your team invite." : "Log in to continue.",

      submitLabel: token ? "Log In & Accept Invite" : "Log In",

      signupUrl: token ? `/signup?inviteToken=${encodeURIComponent(token)}` : "/signup",

      showGoogleLogin: true,

      googleLoginUrl: token
        ? `/auth/google?intent=login&inviteToken=${encodeURIComponent(token)}`
        : "/auth/google",

      shouldDisableSubmit: false,
    };

    if (!token) {
      return defaultContext;
    }

    try {
      const invite = await InviteService.validateInviteToken(token);

      const inviteBusinessName = InviteService.getBusinessName(invite.business);

      const existingUser = await User.findOne({
        email: invite.email,
      });

      if (existingUser) {
        await InviteService.validateExistingUserForInvite({
          user: existingUser,
          businessId: InviteService.getObjectId(invite.business),
        });
      }

      return {
        ...defaultContext,

        inviteEmail: invite.email || "",
        inviteBusinessName,
        inviteBranchName: InviteService.getBranchName(invite.branch),
        inviteRoleLabel: InviteService.formatInviteRole(invite.role),

        pageTitle: "Log In to Accept Invite",
        subtitle: `Log in to join ${inviteBusinessName}.`,
      };
    } catch (error) {
      return {
        ...defaultContext,

        hasInviteError: true,
        inviteError: error.message || "Invalid invite link.",
        shouldDisableSubmit: true,

        showGoogleLogin: false,
      };
    }
  }

  // ───────────────────── ACCEPT INVITE FROM SIGNUP ─────────────────────

  static async acceptSignupInvite({ token, firstName, lastName, password, confirmPassword }) {
    const invite = await InviteService.validateInviteToken(token);

    const existingUser = await User.findOne({
      email: invite.email,
    })
      .select("_id")
      .lean();

    if (existingUser) {
      throw new Error(
        "An account already exists for this invite email. Please log in to accept this invite."
      );
    }

    if (
      typeof firstName !== "string" ||
      typeof lastName !== "string" ||
      !firstName.trim() ||
      !lastName.trim() ||
      !password ||
      !confirmPassword
    ) {
      throw new Error("All fields are required.");
    }

    if (password !== confirmPassword) {
      throw new Error("Passwords do not match.");
    }

    const cleanFirstName = firstName.trim();
    const cleanLastName = lastName.trim();

    const user = new User({
      firstName: cleanFirstName,
      lastName: cleanLastName,
      displayName: `${cleanFirstName} ${cleanLastName}`,

      legalNameSource: "unverified",
      legalNameEvidence: null,

      email: InviteService.normalizeEmail(invite.email),
      password,

      role: "employer",
      authProvider: "local",

      isVerified: false,
      isOnboarded: false,
      twoFactorEnabled: true,
    });

    await user.save();

    logger.info(`New invited user created pending OTP verification for ${invite.email}`);

    return {
      user,
      invite,

      pendingAuth: {
        userId: user._id,
        inviteToken: InviteService.normalizeToken(token),
        flow: "signup_invite",
      },
    };
  }

  // ───────────────────── ACCEPT INVITE AFTER LOGIN / OTP ─────────────────────

  static async acceptLoginInvite({ token, userId }) {
    return InviteService.acceptAuthenticatedInvite({
      token,
      userId,
    });
  }

  static async acceptAuthenticatedInvite({ token, userId }) {
    const invite = await InviteService.validateInviteToken(token);

    if (!userId) {
      throw new Error("User is required to accept this invite.");
    }

    const businessId = InviteService.getObjectId(invite.business);

    const branchId = invite.branch ? InviteService.getObjectId(invite.branch) : null;

    /*
     * The following operations must commit together:
     *
     * - Claim the pending invitation;
     * - Validate the invited user;
     * - Create or update current team membership;
     * - Replace existing branch managers if needed;
     * - Update the user's employer profile link.
     */

    const session = await mongoose.startSession();

    let acceptedResult;

    try {
      await session.withTransaction(async () => {
        // Coordinate acceptance with final business closure through a
        // write to the same EmployerProfile document.
        const activeBusiness = await EmployerProfile.findOneAndUpdate(
          { _id: businessId, accountStatus: "active" },
          { $inc: { __v: 1 } },
          { session, new: true }
        ).select("_id");

        if (!activeBusiness) {
          throw new Error("The business is no longer eligible to accept invitations.");
        }

        const acceptedInvite = await Invite.findOneAndUpdate(
          {
            _id: invite._id,
            token: InviteService.normalizeToken(token),
            status: "pending",
            expiresAt: { $gt: new Date() },
          },
          {
            $set: {
              status: "accepted",
              acceptedAt: new Date(),
            },
          },
          {
            new: true,
            session,
          }
        );

        if (!acceptedInvite) {
          throw new Error("This invite is no longer active or has expired.");
        }

        const user = await User.findById(userId).session(session);

        if (!user) {
          throw new Error("User not found.");
        }

        const inviteEmail = InviteService.normalizeEmail(invite.email);
        const userEmail = InviteService.normalizeEmail(user.email);

        if (inviteEmail !== userEmail) {
          throw new Error("This invite was sent to a different email address.");
        }

        if (user.role !== "employer") {
          throw new Error("This user account cannot accept employer team invites.");
        }

        if (user.accountStatus !== "active") {
          throw new Error("This account cannot accept team invites while restricted or inactive.");
        }

        if (!user.isVerified) {
          throw new Error("Please verify your email before accepting this invite.");
        }

        /*
         * Validate branch ownership again inside
         * the invitation acceptance transaction.
         */

        if (InviteService.requiresBranch(invite.role)) {
          const validBranch = await Branch.findOne({
            _id: branchId,
            business: businessId,
          }).session(session);

          if (!validBranch) {
            throw new Error("This invite has an invalid business branch assignment.");
          }
        }

        const existingMember = await InviteService.validateExistingUserForInvite({
          user,
          businessId,
          session,
        });

        let member;

        if (existingMember) {
          if (InviteService.isAdminRole(invite.role)) {
            existingMember.role = "admin";
            existingMember.branches = [];
          } else {
            if (existingMember.role === "admin") {
              throw new Error("This user already has business-wide access.");
            }

            const alreadyAssignedToBranch = InviteService.userIsAssignedToBranch(
              existingMember,
              branchId
            );

            if (alreadyAssignedToBranch) {
              throw new Error("This user is already assigned to this branch.");
            }

            InviteService.addOrReplaceBranchAssignment({
              member: existingMember,
              branchId,
              role: invite.role,
            });
          }

          await existingMember.save({ session });

          member = existingMember;
        } else {
          const memberPayload = InviteService.buildMemberPayload({
            userId: user._id,
            businessId,
            branchId,
            role: invite.role,
          });

          member = new EmployerMember(memberPayload);

          await member.save({ session });
        }

        /*
         * Branch-manager invitations now use
         * the same branch-level transactional
         * coordination as TeamMemberService.
         */

        if (invite.role === "branch_manager") {
          await InviteService.demoteExistingBranchManagers({
            businessId,
            branchId,
            newManagerUserId: user._id,
            session,
          });
        }

        /*
         * Business-team admin does not change
         * the platform-level User.role.
         *
         * Previous removed memberships remain
         * intact as audit records.
         */

        user.role = "employer";
        user.employerProfile = businessId;
        user.isOnboarded = true;

        await user.save({ session });

        invite.status = acceptedInvite.status;
        invite.acceptedAt = acceptedInvite.acceptedAt;

        acceptedResult = {
          user,
          member,
          invite,
          redirectTo: "/employer/dashboard",
        };
      });
    } finally {
      await session.endSession();
    }

    logger.info(`User ${invite.email} accepted invite after authentication`);

    return acceptedResult;
  }

  // ───────────────────── MANAGE EXISTING INVITES ─────────────────────

  static async getInviteForBusiness({ inviteId, businessId }) {
    const invite = await Invite.findOne({
      _id: inviteId,
      business: businessId,
    });

    if (!invite) {
      throw new Error("Invite not found.");
    }

    return invite;
  }

  // ───────────────────── RESEND EXISTING INVITE ─────────────────────

  static async resendInvite({ inviteId, businessId }) {
    const invite = await InviteService.getInviteForBusiness({
      inviteId,
      businessId,
    });

    if (invite.status === "accepted") {
      throw new Error("Accepted invites cannot be resent.");
    }

    if (invite.status === "revoked") {
      throw new Error("Deleted invites cannot be resent. Please create a new invite.");
    }

    InviteService.validateRole(invite.role);

    const business = await EmployerProfile.findOne({
      _id: businessId,
      accountStatus: "active",
    }).select("businessName");

    if (!business) {
      throw new Error("Business profile not found.");
    }

    let branch = null;

    if (InviteService.requiresBranch(invite.role)) {
      branch = await Branch.findOne({
        _id: invite.branch,
        business: businessId,
      });

      if (!branch) {
        throw new Error("Branch not found.");
      }
    }

    const normalizedEmail = InviteService.normalizeEmail(invite.email);

    const existingUser = await User.findOne({
      email: normalizedEmail,
    });

    const member = await InviteService.validateExistingUserForInvite({
      user: existingUser,
      businessId,
    });

    InviteService.assertInviteRecipientAssignment({
      member,
      role: invite.role,
      branchId: invite.branch,
    });

    const duplicatePendingInvite = await Invite.findOne({
      _id: { $ne: invite._id },
      email: normalizedEmail,
      business: businessId,
      status: "pending",
    });

    if (duplicatePendingInvite) {
      throw new Error("This email already has a pending invite for this business.");
    }

    const updatedInvite = await InviteService.rotateInviteIfUnchanged({
      invite,
      businessId,
      updates: {},
    });

    const inviteLabel = InviteService.isAdminRole(updatedInvite.role)
      ? business.businessName || "your business"
      : branch.name;

    await EmailService.sendInvite(
      updatedInvite.email,
      InviteService.getInviteUrl(updatedInvite.token),
      inviteLabel
    );

    logger.info(`Invite resent to ${updatedInvite.email} for ${inviteLabel}`);

    return updatedInvite;
  }

  // ───────────────────── EDIT AND RESEND INVITE ─────────────────────

  static async updateInviteAndResend({ inviteId, businessId, email, role, branchId, invitedBy }) {
    InviteService.validateRole(role);

    const invite = await InviteService.getInviteForBusiness({
      inviteId,
      businessId,
    });

    if (invite.status === "accepted") {
      throw new Error("Accepted invites cannot be edited.");
    }

    if (invite.status === "revoked") {
      throw new Error("Deleted invites cannot be edited. Please create a new invite.");
    }

    const normalizedEmail = InviteService.normalizeEmail(email);

    if (!normalizedEmail || normalizedEmail.endsWith("@closed.loqum.invalid")) {
      throw new Error("A valid invitation email is required.");
    }

    const business = await EmployerProfile.findOne({
      _id: businessId,
      accountStatus: "active",
    }).select("businessName");

    if (!business) {
      throw new Error("Business profile not found.");
    }

    let branch = null;

    if (InviteService.requiresBranch(role)) {
      if (!branchId) {
        throw new Error("Branch is required for branch managers and branch staff.");
      }

      branch = await Branch.findOne({
        _id: branchId,
        business: businessId,
      });

      if (!branch) {
        throw new Error("Branch not found.");
      }
    }

    const duplicatePendingInvite = await Invite.findOne({
      _id: { $ne: invite._id },
      email: normalizedEmail,
      business: businessId,
      status: "pending",
    });

    if (duplicatePendingInvite) {
      throw new Error("This email already has a pending invite for this business.");
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
    });

    const existingMember = await InviteService.validateExistingUserForInvite({
      user: existingUser,
      businessId,
    });

    InviteService.assertInviteRecipientAssignment({
      member: existingMember,
      role,
      branchId,
    });

    const updatedInvite = await InviteService.rotateInviteIfUnchanged({
      invite,
      businessId,
      updates: {
        email: normalizedEmail,
        role,
        invitedBy,
        ...(InviteService.isAdminRole(role) ? {} : { branch: branch._id }),
      },
      unset: InviteService.isAdminRole(role) ? { branch: "" } : {},
    });

    const inviteLabel = InviteService.isAdminRole(role)
      ? business.businessName || "your business"
      : branch.name;

    await EmailService.sendInvite(
      normalizedEmail,
      InviteService.getInviteUrl(updatedInvite.token),
      inviteLabel
    );

    logger.info(`Invite ${inviteId} updated and resent to ${normalizedEmail}`);

    return updatedInvite;
  }

  // ───────────────────── REVOKE INVITE ─────────────────────

  /* ---------- Business closure offboarding ---------- */

  static async revokeForBusinessClosure({ businessId, actorUserId, session }) {
    if (
      !session?.inTransaction?.() ||
      !mongoose.isValidObjectId(businessId) ||
      !mongoose.isValidObjectId(actorUserId)
    ) {
      throw new Error("Business closure requires valid ownership and an active transaction.");
    }

    const business = await EmployerProfile.findOne({
      _id: businessId,
      user: actorUserId,
      accountStatus: "closed",
    }).select("_id closedAt").session(session);

    if (!business?.closedAt) {
      throw new Error("The business must be marked closed within the final closure transaction.");
    }

    // Expired invitations are also revocable because they can otherwise
    // be resent. Accepted invitations remain historical records.
    const result = await Invite.updateMany(
      { business: businessId, status: { $in: ["pending", "expired"] } },
      { $set: { status: "revoked", revokedAt: new Date() } },
      { session, runValidators: true }
    );

    return { invitationsRevoked: result.modifiedCount };
  }

  static async revokeInvite({ inviteId, businessId }) {
    const invite = await InviteService.getInviteForBusiness({
      inviteId,
      businessId,
    });

    if (invite.status === "accepted") {
      throw new Error("Cannot delete an already accepted invite.");
    }

    if (invite.status === "revoked") {
      throw new Error("This invite has already been deleted.");
    }

    const revokedInvite = await InviteService.markInviteRevoked(invite);

    logger.info(`Invite ${inviteId} revoked`);

    return revokedInvite;
  }

  // ───────────────────── BUSINESS INVITES VIEW ─────────────────────

  static normalizeInviteStatus(status) {
    const normalizedStatus = String(status || "active")
      .trim()
      .toLowerCase();

    const allowedStatuses = [
      "active",
      "pending",
      "accepted",
      "expired",
      "deleted",
      "revoked",
      "all",
    ];

    if (!allowedStatuses.includes(normalizedStatus)) {
      return "active";
    }

    if (normalizedStatus === "revoked") {
      return "deleted";
    }

    return normalizedStatus;
  }

  static getInviteStatusBadgeClass(status) {
    const badgeClasses = {
      pending: "badge-light-warning",
      accepted: "badge-light-success",
      revoked: "badge-light-danger",
      expired: "badge-light-dark",
    };

    return badgeClasses[status] || "badge-light-warning";
  }

  static getInviteFilterOptions(activeStatus) {
    const filters = [
      { key: "active", label: "Active" },
      { key: "pending", label: "Pending" },
      { key: "accepted", label: "Accepted" },
      { key: "expired", label: "Expired" },
      { key: "deleted", label: "Deleted" },
      { key: "all", label: "All" },
    ];

    return filters.map((filter) => ({
      ...filter,
      url: `/employer/business-profile?tab=invites&inviteStatus=${filter.key}`,
      isActive: filter.key === activeStatus,
    }));
  }

  static async expireBusinessInvites({ businessId }) {
    await Invite.updateMany(
      {
        business: businessId,
        status: "pending",
        expiresAt: { $lt: new Date() },
      },
      {
        $set: {
          status: "expired",
        },
      }
    );
  }

  static getInviteQueryStatus(status) {
    const normalizedStatus = InviteService.normalizeInviteStatus(status);

    if (normalizedStatus === "deleted") {
      return "revoked";
    }

    return normalizedStatus;
  }

  static async countBusinessInvites({ businessId, status }) {
    await InviteService.expireBusinessInvites({ businessId });

    const query = {
      business: businessId,
    };

    if (status) {
      const queryStatus = InviteService.getInviteQueryStatus(status);

      if (queryStatus === "active") {
        query.status = { $ne: "revoked" };
      } else if (queryStatus !== "all") {
        query.status = queryStatus;
      }
    }

    return Invite.countDocuments(query);
  }

  static async getBusinessInvites({ businessId, status = "active" }) {
    await InviteService.expireBusinessInvites({ businessId });

    const normalizedStatus = InviteService.normalizeInviteStatus(status);

    const query = {
      business: businessId,
    };

    if (normalizedStatus === "pending") {
      query.status = "pending";
    } else if (normalizedStatus === "accepted") {
      query.status = "accepted";
    } else if (normalizedStatus === "expired") {
      query.status = "expired";
    } else if (normalizedStatus === "deleted") {
      query.status = "revoked";
    } else if (normalizedStatus === "all") {
      // Show every status.
    } else {
      query.status = { $ne: "revoked" };
    }

    const invites = await Invite.find(query)
      .populate("branch", "name address state lga")
      .populate("invitedBy", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    return invites;
  }

  static buildInviteRow(invite) {
    const inviteStatus = invite.status || "pending";
    const inviteRole = String(invite.role || "");
    const inviteBranch = invite.branch || null;

    return {
      id: String(invite._id),
      email: invite.email || "-",

      role: inviteRole,
      roleLabel: inviteRole ? InviteService.formatInviteText(inviteRole) : "-",

      branchId: inviteBranch && inviteBranch._id ? String(inviteBranch._id) : "",

      branchName: inviteBranch && inviteBranch.name ? inviteBranch.name : "Business-wide",

      status: inviteStatus,
      statusLabel: InviteService.formatInviteText(inviteStatus),

      statusBadgeClass: InviteService.getInviteStatusBadgeClass(inviteStatus),

      canModify: inviteStatus === "pending" || inviteStatus === "expired",
    };
  }

  static getInviteEmptyMessage(activeStatus) {
    if (activeStatus === "active") {
      return "Active invites will appear here.";
    }

    if (activeStatus === "deleted") {
      return "Deleted invites will appear here.";
    }

    if (activeStatus === "all") {
      return "All invites will appear here.";
    }

    return `${InviteService.formatInviteText(activeStatus)} invites will appear here.`;
  }

  static async getBusinessInviteView({ businessId, status = "active" }) {
    const activeStatus = InviteService.normalizeInviteStatus(status);

    const invites = await InviteService.getBusinessInvites({
      businessId,
      status: activeStatus,
    });

    const filters = InviteService.getInviteFilterOptions(activeStatus);

    const activeFilter = filters.find((filter) => filter.isActive);

    return {
      activeStatus,
      activeFilterLabel: activeFilter?.label || "Active",
      filters,
      rows: invites.map((invite) => InviteService.buildInviteRow(invite)),
      emptyMessage: InviteService.getInviteEmptyMessage(activeStatus),
    };
  }
}

module.exports = InviteService;
