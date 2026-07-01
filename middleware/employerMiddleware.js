// middleware/employerMiddleware.js

const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");

function getId(value) {
  if (!value) return "";
  return (value._id || value).toString();
}

/**
 * Attaches the employer's business profile to the request.
 * Use this on protected employer routes.
 *
 * This supports:
 * 1. Original employer account that owns/created the EmployerProfile
 * 2. Invited employer users attached through User.employerProfile
 * 3. Invited employer users attached through EmployerMember
 */
exports.attachEmployerProfile = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.redirect("/login");
    }

    if (req.user.role !== "employer") {
      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    }

    let profile = null;
    let employerMember = null;

    /**
     * First: check if the user has employerProfile directly attached.
     * This is useful for invited employer users if your invite flow saves:
     * user.employerProfile = businessId
     */
    if (req.user.employerProfile) {
      profile = await EmployerProfile.findById(req.user.employerProfile);
    }

    /**
     * Second: check if this user is the original employer profile user.
     */
    if (!profile) {
      profile = await EmployerProfile.findOne({ user: req.user._id });
    }

    /**
     * Third: check EmployerMember.
     * This supports invited admins, branch managers, and branch staff.
     */
    if (!profile) {
      employerMember = await EmployerMember.findOne({
        user: req.user._id,
        accountStatus: "active",
      }).lean();

      if (employerMember?.business) {
        profile = await EmployerProfile.findById(employerMember.business);
      }
    }

    if (!profile) {
      return res.redirect("/onboarding/employer");
    }

    req.employerProfile = profile;
    req.employerMember = employerMember;

    res.locals.employerProfile = profile;
    res.locals.employerMember = employerMember;

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Attaches employer-specific role and permission context.
 *
 * The original employer account is computed as `isPrimaryEmployer`.
 */
exports.attachEmployerContext = async (req, res, next) => {
  try {
    req.employerContext = null;
    res.locals.employerContext = null;

    if (!req.user || req.user.role !== "employer" || !req.employerProfile) {
      return next();
    }

    const userId = getId(req.user._id);
    const businessId = getId(req.employerProfile._id);

    let employerMember = req.employerMember || null;

    if (!employerMember) {
      employerMember = await EmployerMember.findOne({
        user: userId,
        business: businessId,
        accountStatus: "active",
      }).lean();
    }

    const primaryEmployerUserId = getId(req.employerProfile.user);

    const isPrimaryEmployer = Boolean(primaryEmployerUserId) && primaryEmployerUserId === userId;

    const employerMemberRole = employerMember?.role || null;

    const isBusinessAdmin = employerMemberRole === "admin";
    const isBranchManager = employerMemberRole === "branch_manager";
    const isBranchStaff = employerMemberRole === "branch_staff";

    const assignedBranchIds =
      employerMember?.branches?.map((assignment) => getId(assignment.branch)).filter(Boolean) || [];

    const employerContext = {
      employerMemberRole,

      isPrimaryEmployer,
      isBusinessAdmin,
      isBranchManager,
      isBranchStaff,

      assignedBranchIds,

      canViewBusinessProfile: true,
      canManageBusinessProfile: isPrimaryEmployer || isBusinessAdmin,

      canViewBranches: true,
      canManageBranches: isPrimaryEmployer || isBusinessAdmin,

      canViewTeamMembers: isPrimaryEmployer || isBusinessAdmin,
      canInviteMembers: isPrimaryEmployer || isBusinessAdmin,

      canViewWallet: isPrimaryEmployer || isBusinessAdmin,
      canManageWallet: isPrimaryEmployer || isBusinessAdmin,
    };

    req.employerMember = employerMember;
    req.employerContext = employerContext;

    res.locals.employerMember = employerMember;
    res.locals.employerContext = employerContext;

    return next();
  } catch (error) {
    return next(error);
  }
};

// Checks whether an employer is approved to post shifts
exports.canPostShifts = (req, res, next) => {
  const profile = req.employerProfile;

  if (!profile) {
    return res.redirect("/onboarding/employer");
  }

  const isApprovedToPost =
    profile.cacVerificationStatus === "verified" &&
    profile.regulatoryVerificationStatus === "verified" &&
    profile.employerApprovalStatus === "approved" &&
    profile.accountStatus === "active";

  if (!isApprovedToPost) {
    return res.status(403).json({
      success: false,
      message: "Your business profile must be verified and approved before you can post shifts.",
      requirements: {
        cacVerificationStatus: profile.cacVerificationStatus,
        regulatoryVerificationStatus: profile.regulatoryVerificationStatus,
        employerApprovalStatus: profile.employerApprovalStatus,
        accountStatus: profile.accountStatus,
      },
    });
  }

  return next();
};
