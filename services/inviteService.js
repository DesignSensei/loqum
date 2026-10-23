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
     * The admin role here belongs to EmployerMember.
     * It is business-wide employer administration,
     * never the platform-level User.role "admin".
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

  /* ---------- EMPLOYER-ONLY INVITATION ELIGIBILITY ---------- */

  /*
   * Employer team invitations are exclusively
   * for accounts with User.role "employer".
   *
   * Professionals and platform administrators
   * cannot accept employer team invitations.
   *
   * Existing users must also belong to the
   * same employer business, if already linked.
   *
   * An invitation must not reactivate a
   * restricted, suspended, deactivated or
   * banned account.
   *
   * Historical memberships are not current
   * memberships and must remain available
   * for audit without blocking legitimate
   * subsequent employer team membership.
   */

  static async validateExistingUserForInvite({ user, businessId, session = null }) {
    if (!user) return null;

    if (user.role !== "employer") {
      throw new Error("This user account cannot accept employer team invites.");
    }

    if (user.accountStatus !== "active") {
      throw new Error("This account cannot accept team invites while restricted or inactive.");
    }

    /*
     * Only a current EmployerMember record
     * represents an existing team membership.
     *
     * Removed historical memberships have
     * isCurrent: false and must not be returned.
     *
     * The current membership is checked before
     * considering the User.employerProfile link
     * because that link may still point to a
     * previously removed employer membership.
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
     * A primary business owner is different
     * from an invited employer team member.
     *
     * Removing an EmployerMember record does
     * not remove EmployerProfile.user ownership.
     *
     * A user who owns another employer business
     * cannot use a team invitation to silently
     * transfer or replace that ownership.
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
     * User.employerProfile may retain the ID
     * of a former employer after a team member
     * has been removed.
     *
     * A stale link must not permanently prevent
     * the user from joining a different business.
     *
     * However, a mismatched employerProfile
     * reference must not be ignored without
     * evidence that the previous membership
     * was genuinely removed.
     *
     * Allow the new invitation only when:
     *
     * - The user has no current membership
     *   in another business;
     *
     * - The previous business membership
     *   exists as a removed historical record;
     *
     * - The user is not the primary owner
     *   of another business.
     *
     * Successful invitation acceptance updates
     * User.employerProfile to the new business
     * within the existing transaction.
     *
     * The previous EmployerMember document
     * remains untouched for audit purposes.
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

  static async demoteExistingBranchManagers({
    businessId,
    branchId,
    newManagerUserId,
    session = null,
  }) {
    if (!branchId || !newManagerUserId) return;

    const query = EmployerMember.find({
      business: businessId,
      user: { $ne: newManagerUserId },
      branches: {
        $elemMatch: {
          branch: branchId,
          role: "branch_manager",
        },
      },
    });

    if (session) {
      query.session(session);
    }

    const existingManagers = await query;

    /*
     * Save sequentially so that all writes can
     * safely share the same MongoDB transaction
     * session when invitation acceptance
     * promotes a new branch manager.
     */

    for (const member of existingManagers) {
      const updatedBranches = InviteService.getMemberBranches(member).map((assignment) => {
        if (
          InviteService.idsMatch(assignment.branch, branchId) &&
          assignment.role === "branch_manager"
        ) {
          assignment.role = "branch_staff";
        }

        return assignment;
      });

      member.branches = updatedBranches;
      member.role = InviteService.deriveMemberRoleFromBranches(updatedBranches);

      await member.save(session ? { session } : {});
    }
  }

  //─────────────────────────────── SEND / RESEND INVITE ───────────────────────────────//

  static async sendInvite({ businessId, branchId, role, email, invitedBy }) {
    InviteService.validateRole(role);

    const normalizedEmail = InviteService.normalizeEmail(email);

    if (!normalizedEmail) {
      throw new Error("Email is required.");
    }

    const business = await EmployerProfile.findById(businessId).select("businessName");

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

    /*
     * Check the recipient's existing account.
     *
     * A pharmacist or platform administrator
     * must never receive an employer team invite
     * through an existing Loqum account.
     */

    const existingUser = await User.findOne({ email: normalizedEmail });

    const existingMember = await InviteService.validateExistingUserForInvite({
      user: existingUser,
      businessId,
    });

    if (existingMember) {
      if (existingMember.role === "admin") {
        throw new Error("This user already has business-wide access.");
      }

      if (!InviteService.isAdminRole(role)) {
        const alreadyAssignedToBranch = InviteService.userIsAssignedToBranch(
          existingMember,
          branchId
        );

        if (alreadyAssignedToBranch) {
          throw new Error("This user is already assigned to this branch.");
        }
      }
    }

    const inviteLabel = InviteService.isAdminRole(role)
      ? business.businessName || "your business"
      : branch.name;

    const existingPendingBusinessInvite = await Invite.findOne({
      email: normalizedEmail,
      business: businessId,
      status: "pending",
    });

    if (existingPendingBusinessInvite) {
      existingPendingBusinessInvite.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      existingPendingBusinessInvite.invitedBy = invitedBy;
      existingPendingBusinessInvite.role = role;

      /*
       * Rotate the token when resending.
       *
       * Previously issued links must not
       * remain usable after a resend.
       */

      existingPendingBusinessInvite.token = crypto.randomBytes(32).toString("hex");

      if (InviteService.isAdminRole(role)) {
        existingPendingBusinessInvite.branch = undefined;
      } else {
        existingPendingBusinessInvite.branch = branch._id;
      }

      await existingPendingBusinessInvite.save();

      const inviteUrl = InviteService.getInviteUrl(existingPendingBusinessInvite.token);

      await EmailService.sendInvite(normalizedEmail, inviteUrl, inviteLabel);

      logger.info(`Invite resent to ${normalizedEmail} for ${inviteLabel}`);

      return {
        invite: existingPendingBusinessInvite,
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

    await invite.save();

    const inviteUrl = InviteService.getInviteUrl(invite.token);

    await EmailService.sendInvite(normalizedEmail, inviteUrl, inviteLabel);

    logger.info(`Invite sent to ${normalizedEmail} for ${inviteLabel}`);

    return {
      invite,
      resent: false,
    };
  }

  //─────────────────────────────── VALIDATE INVITE TOKEN ───────────────────────────────//

  static async validateInviteToken(token) {
    const normalizedToken = InviteService.normalizeToken(token);

    if (!normalizedToken) {
      throw new Error("Invite token is required.");
    }

    const invite = await Invite.findOne({ token: normalizedToken })
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

    if (invite.status === "expired" || (invite.expiresAt && invite.expiresAt < new Date())) {
      if (invite.status !== "expired") {
        invite.status = "expired";
        await invite.save();
      }

      throw new Error("This invite link has expired. Please request a new one.");
    }

    if (invite.status !== "pending") {
      throw new Error("This invite is no longer active.");
    }

    InviteService.validateRole(invite.role);

    /*
     * Every invitation must belong to an
     * existing employer business.
     *
     * Branch-scoped invitations must reference
     * a branch belonging to that same business.
     */

    if (!invite.business) {
      throw new Error("The business associated with this invite no longer exists.");
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

  static async markInviteAccepted(invite) {
    invite.status = "accepted";
    invite.acceptedAt = new Date();

    await invite.save();

    return invite;
  }

  static async markInviteRevoked(invite) {
    invite.status = "revoked";
    invite.revokedAt = new Date();

    await invite.save();

    return invite;
  }

  //─────────────────────────────── SIGNUP INVITE CONTEXT ───────────────────────────────//

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

      /*
       * Reject invitations addressed to an
       * existing professional or platform admin.
       *
       * Do not direct an ineligible account to
       * log in merely to discover the restriction
       * at the final acceptance step.
       */

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

  //─────────────────────────────── LOGIN INVITE CONTEXT ───────────────────────────────//

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

  //─────────────────────────────── ACCEPT INVITE FROM SIGNUP ───────────────────────────────//

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

    /*
     * Employer team invitations create only
     * employer User accounts.
     *
     * These names identify the team member.
     * They are not NIN-derived professional
     * names or CAC-registered business names.
     */

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

  //─────────────────────────────── ACCEPT INVITE AFTER LOGIN / OTP ───────────────────────────────//

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
     * Accepting an invitation updates:
     *
     * - The employer team membership;
     * - Any existing branch manager assignments;
     * - The invited user's employer profile;
     * - The invitation acceptance status.
     *
     * These updates must succeed or fail together.
     *
     * A conditional update claims the pending
     * invitation within the same transaction,
     * preventing successful reuse of a token.
     *
     * This requires MongoDB transaction support.
     */

    const session = await mongoose.startSession();

    let acceptedResult;

    try {
      await session.withTransaction(async () => {
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
         * Recheck the branch assignment inside
         * the transaction before changing team
         * membership records.
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

        /*
         * Membership validation now ignores
         * removed historical EmployerMember
         * records and permits documented
         * previous-business removal.
         *
         * The current membership and any stale
         * User.employerProfile reference are
         * checked within this transaction.
         */

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

        if (invite.role === "branch_manager") {
          await InviteService.demoteExistingBranchManagers({
            businessId,
            branchId,
            newManagerUserId: user._id,
            session,
          });
        }

        /*
         * The platform-level User.role remains
         * "employer" regardless of the invited
         * business team role.
         *
         * An EmployerMember admin invitation
         * never creates a platform administrator.
         *
         * Updating employerProfile here replaces
         * a stale link to a previous business
         * only after the membership checks pass.
         *
         * The historical membership itself
         * remains unchanged.
         */

        user.role = "employer";
        user.employerProfile = businessId;
        user.isOnboarded = true;

        await user.save({ session });

        /*
         * Keep the populated invitation returned
         * by validateInviteToken() for callers
         * that use the linked business or branch.
         */

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

  //─────────────────────────────── MANAGE EXISTING INVITES ───────────────────────────────//

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

    const business = await EmployerProfile.findById(businessId).select("businessName");

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

    /*
     * The recipient may have created or changed
     * a Loqum account since the invitation was
     * originally issued.
     *
     * Recheck employer-only eligibility before
     * sending a replacement invitation link.
     */

    const existingUser = await User.findOne({
      email: InviteService.normalizeEmail(invite.email),
    });

    await InviteService.validateExistingUserForInvite({
      user: existingUser,
      businessId,
    });

    invite.status = "pending";
    invite.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    invite.revokedAt = undefined;
    invite.acceptedAt = undefined;

    /*
     * Issue a new token when resending so the
     * previous invitation link is invalidated.
     */

    invite.token = crypto.randomBytes(32).toString("hex");

    await invite.save();

    const inviteLabel = InviteService.isAdminRole(invite.role)
      ? business.businessName || "your business"
      : branch.name;

    const inviteUrl = InviteService.getInviteUrl(invite.token);

    await EmailService.sendInvite(invite.email, inviteUrl, inviteLabel);

    logger.info(`Invite resent to ${invite.email} for ${inviteLabel}`);

    return invite;
  }

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

    if (!normalizedEmail) {
      throw new Error("Email is required.");
    }

    const business = await EmployerProfile.findById(businessId).select("businessName");

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

    const existingUser = await User.findOne({ email: normalizedEmail });

    const existingMember = await InviteService.validateExistingUserForInvite({
      user: existingUser,
      businessId,
    });

    if (existingMember) {
      if (existingMember.role === "admin") {
        throw new Error("This user already has business-wide access.");
      }

      if (!InviteService.isAdminRole(role)) {
        const alreadyAssignedToBranch = InviteService.userIsAssignedToBranch(
          existingMember,
          branchId
        );

        if (alreadyAssignedToBranch) {
          throw new Error("This user is already assigned to this branch.");
        }
      }
    }

    invite.email = normalizedEmail;
    invite.role = role;
    invite.invitedBy = invitedBy;
    invite.status = "pending";
    invite.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    invite.revokedAt = undefined;
    invite.acceptedAt = undefined;
    invite.token = crypto.randomBytes(32).toString("hex");

    if (InviteService.isAdminRole(role)) {
      invite.branch = undefined;
    } else {
      invite.branch = branch._id;
    }

    await invite.save();

    const inviteLabel = InviteService.isAdminRole(role)
      ? business.businessName || "your business"
      : branch.name;

    const inviteUrl = InviteService.getInviteUrl(invite.token);

    await EmailService.sendInvite(normalizedEmail, inviteUrl, inviteLabel);

    logger.info(`Invite ${inviteId} updated and resent to ${normalizedEmail}`);

    return invite;
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

    await InviteService.markInviteRevoked(invite);

    logger.info(`Invite ${inviteId} revoked`);

    return invite;
  }

  //─────────────────────────────── BUSINESS INVITES VIEW ───────────────────────────────//

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

      if (queryStatus !== "active" && queryStatus !== "all") {
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
