// middleware/employerMiddleware.js

const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const EmployerDelinquencyService = require("../services/employerDelinquencyService");

// ───────────────────── GENERAL HELPERS ─────────────────────

function getId(value) {
  return value ? String(value._id || value) : "";
}

function expectsJSON(req) {
  const accept = req.get("Accept") || "";

  return (
    Boolean(req.xhr) || accept.includes("application/json") || Boolean(req.is("application/json"))
  );
}

/**
 * Business eligibility is independent of the user's team role.
 * Every verification and approval condition must pass.
 */
function isBusinessEligibleToOperate(profile) {
  return Boolean(
    profile &&
    profile.cacVerificationStatus === "verified" &&
    profile.regulatoryVerificationStatus === "verified" &&
    profile.employerApprovalStatus === "approved" &&
    profile.accountStatus === "active"
  );
}

// ───────────────────── ACTIVE EMPLOYER MEMBERSHIP ─────────────────────

/**
 * Employer team access requires an active, current membership.
 *
 * EmployerMember.role "admin" is a business administrator,
 * not a Loqum platform administrator.
 *
 * Historical or removed memberships must not grant access.
 */
async function loadEmployerMember({ userId, businessId }) {
  if (!userId || !businessId) {
    return null;
  }

  return EmployerMember.findOne({
    user: userId,
    business: businessId,
    accountStatus: "active",
    isCurrent: true,
  }).lean();
}

// ───────────────────── RESOLVE EMPLOYER BUSINESS ─────────────────────

/**
 * Resolve the employer's business using verified account
 * ownership or an active, current team membership.
 *
 * A stored business reference alone does not grant access.
 */
async function resolveEmployerProfileAndMember(user) {
  if (
    !user ||
    !user._id ||
    user.role !== "employer" ||
    user.accountStatus !== "active" ||
    user.isVerified !== true
  ) {
    return {
      profile: null,
      employerMember: null,
    };
  }

  // ───────── PRIMARY BUSINESS OWNER ─────────

  const ownedProfile = await EmployerProfile.findOne({
    user: user._id,
  });

  if (ownedProfile) {
    return {
      profile: ownedProfile,

      employerMember: await loadEmployerMember({
        userId: user._id,
        businessId: ownedProfile._id,
      }),
    };
  }

  // ───────── LINKED EMPLOYER MEMBER ─────────

  /**
   * Invited members must have a current membership for
   * their linked business. A stale User.employerProfile
   * reference must not silently grant another business.
   */
  if (user.employerProfile) {
    const businessId = getId(user.employerProfile);

    const member = await loadEmployerMember({
      userId: user._id,
      businessId,
    });

    if (!member) {
      return {
        profile: null,
        employerMember: null,
      };
    }

    const profile = await EmployerProfile.findById(businessId);

    if (!profile) {
      return {
        profile: null,
        employerMember: null,
      };
    }

    return {
      profile,
      employerMember: member,
    };
  }

  // ───────── LEGACY MEMBERSHIP COMPATIBILITY ─────────

  /**
   * Support older invited accounts whose User record
   * lacks an employerProfile reference.
   *
   * The membership itself must still be active and current.
   */
  const member = await EmployerMember.findOne({
    user: user._id,
    accountStatus: "active",
    isCurrent: true,
  }).lean();

  if (!member?.business) {
    return {
      profile: null,
      employerMember: null,
    };
  }

  const profile = await EmployerProfile.findById(member.business);

  return {
    profile,
    employerMember: profile ? member : null,
  };
}

// ───────────────────── BUILD EMPLOYER PERMISSIONS ─────────────────────

/**
 * Calculate permissions from current ownership, membership,
 * account eligibility and delinquency restrictions.
 *
 * Membership is rechecked against MongoDB rather than
 * trusting a previously attached request context.
 */
async function buildEmployerContext({
  user,
  profile,
  employerMember = null,
  currentTime = new Date(),
}) {
  if (!user || !profile) {
    return {
      employerMember: null,
      employerContext: null,
    };
  }

  const userId = getId(user._id);
  const businessId = getId(profile._id);

  // ───────── CURRENT BUSINESS MEMBERSHIP ─────────

  // Retain the employerMember argument for caller compatibility.
  const resolvedEmployerMember = await loadEmployerMember({
    userId,
    businessId,
  });

  const isPrimaryEmployer = getId(profile.user) === userId;

  if (!isPrimaryEmployer && !resolvedEmployerMember) {
    return {
      employerMember: null,
      employerContext: null,
    };
  }

  // ───────── BUSINESS ROLES ─────────

  const employerMemberRole = resolvedEmployerMember?.role || null;

  const isBusinessAdmin = employerMemberRole === "admin";

  const isBranchManager = employerMemberRole === "branch_manager";

  const isBranchStaff = employerMemberRole === "branch_staff";

  const assignedBranchIds =
    resolvedEmployerMember?.branches
      ?.map((assignment) => getId(assignment.branch))
      .filter(Boolean) || [];

  // ───────── SHIFT PERMISSIONS ─────────

  const canManageAllShifts = isPrimaryEmployer || isBusinessAdmin;

  const canManageAssignedBranchShifts = isBranchManager;

  const canViewShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager || isBranchStaff;

  const roleCanPostShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  // ───────── EXISTING WORK AND DISPUTES ─────────

  // Delinquency must not automatically block existing obligations.
  const canViewClaims = canViewShifts;

  const canManageClaims = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewDisputes = canViewShifts;

  const canManageDisputes = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canManagePostShiftWorkflows = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  // ───────── WALLET AND FUNDING ─────────

  const canViewWallet = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canManageWallet = isPrimaryEmployer || isBusinessAdmin;

  const canManageFinancialObligations = isPrimaryEmployer || isBusinessAdmin;

  const canFundShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewRefunds = isPrimaryEmployer || isBusinessAdmin;

  const canManageRefundActions = isPrimaryEmployer || isBusinessAdmin;

  // ───────── BUSINESS RESTRICTIONS ─────────

  const delinquency = await EmployerDelinquencyService.getRestrictionState({
    businessId: profile._id,
    currentTime,
  });

  const businessEligible = isBusinessEligibleToOperate(profile);

  const canPostShifts = roleCanPostShifts && businessEligible && delinquency.canPostShifts;

  // ───────── INVITATION MANAGEMENT ─────────

  /**
   * Only owners and business administrators may manage
   * invitations, and the business account must be active.
   *
   * The invitation controller independently checks permission
   * before performing mutations.
   */
  const canManageInvites =
    (isPrimaryEmployer || isBusinessAdmin) && profile.accountStatus === "active";

  // ───────── EMPLOYER CONTEXT ─────────

  const employerContext = {
    employerMemberRole,

    isPrimaryEmployer,
    isBusinessAdmin,
    isBranchManager,
    isBranchStaff,

    assignedBranchIds,

    // Business profile
    canViewBusinessProfile: true,
    canManageBusinessProfile: isPrimaryEmployer || isBusinessAdmin,

    // Branches
    canViewBranches: true,
    canManageBranches: isPrimaryEmployer || isBusinessAdmin,

    // Team
    canViewTeamMembers: isPrimaryEmployer || isBusinessAdmin,

    canInviteMembers: canManageInvites,

    // Wallet and funding
    canViewWallet,
    canManageWallet,
    canManageFinancialObligations,
    canFundShifts,

    // Shifts
    canViewShifts,
    roleCanPostShifts,
    canPostShifts,
    canManageAllShifts,
    canManageAssignedBranchShifts,
    canManagePostShiftWorkflows,

    // Claims
    canViewClaims,
    canManageClaims,

    // Disputes
    canViewDisputes,
    canManageDisputes,

    // Refunds
    canViewRefunds,
    canManageRefundActions,

    // Business restrictions
    canCreateNewObligations:
      roleCanPostShifts && businessEligible && delinquency.canCreateNewObligations,

    newObligationsRestricted: delinquency.restricted,

    restrictionReason: delinquency.restrictionReason,

    delinquency,
  };

  return {
    employerMember: resolvedEmployerMember,
    employerContext,
  };
}

// ───────────────────── ACCESS FAILURE ─────────────────────

function noEmployerAccess(req, res) {
  if (!req.user?.isOnboarded) {
    return res.redirect("/onboarding/employer");
  }

  if (expectsJSON(req)) {
    return res.status(403).json({
      success: false,
      message: "You do not have access to an active employer business.",
    });
  }

  return res.status(403).render("auth/not-found", {
    layout: "layouts/auth-layout-no-index",
    title: "Forbidden",
  });
}

// ───────────────────── ATTACH EMPLOYER PROFILE ─────────────────────

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

    const { profile, employerMember } = await resolveEmployerProfileAndMember(req.user);

    if (!profile) {
      return noEmployerAccess(req, res);
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

// ───────────────────── ATTACH EMPLOYER CONTEXT ─────────────────────

exports.attachEmployerContext = async (req, res, next) => {
  try {
    req.employerContext = null;
    res.locals.employerContext = null;

    if (!req.user || req.user.role !== "employer" || !req.employerProfile) {
      return next();
    }

    const { employerMember, employerContext } = await buildEmployerContext({
      user: req.user,
      profile: req.employerProfile,
      employerMember: req.employerMember,
      currentTime: new Date(),
    });

    if (!employerContext) {
      req.employerProfile = null;
      req.employerMember = null;

      res.locals.employerProfile = null;
      res.locals.employerMember = null;

      return noEmployerAccess(req, res);
    }

    req.employerMember = employerMember;
    req.employerContext = employerContext;

    res.locals.employerMember = employerMember;
    res.locals.employerContext = employerContext;

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── OPTIONAL EMPLOYER CONTEXT ─────────────────────

/**
 * Optional context must resolve access independently from
 * current database records, not previously attached objects.
 *
 * Clear existing request and template values before resolution.
 */
exports.attachOptionalEmployerContext = async (req, res, next) => {
  try {
    req.employerProfile = null;
    req.employerMember = null;
    req.employerContext = null;

    res.locals.employerProfile = null;
    res.locals.employerMember = null;
    res.locals.employerContext = null;

    if (!req.user || req.user.role !== "employer") {
      return next();
    }

    const resolved = await resolveEmployerProfileAndMember(req.user);

    const profile = resolved.profile;
    const employerMember = resolved.employerMember;

    if (!profile) {
      return next();
    }

    const contextResult = await buildEmployerContext({
      user: req.user,
      profile,
      employerMember,
      currentTime: new Date(),
    });

    if (!contextResult.employerContext) {
      return next();
    }

    req.employerProfile = profile;
    req.employerMember = contextResult.employerMember;

    req.employerContext = contextResult.employerContext;

    res.locals.employerProfile = profile;
    res.locals.employerMember = contextResult.employerMember;

    res.locals.employerContext = contextResult.employerContext;

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── BUSINESS ELIGIBILITY ─────────────────────

function assertBusinessEligible(profile, res) {
  if (isBusinessEligibleToOperate(profile)) {
    return true;
  }

  res.status(403).json({
    success: false,

    message:
      "Your business profile must be verified and approved before you can perform this action.",

    requirements: {
      cacVerificationStatus: profile?.cacVerificationStatus,

      regulatoryVerificationStatus: profile?.regulatoryVerificationStatus,

      employerApprovalStatus: profile?.employerApprovalStatus,

      accountStatus: profile?.accountStatus,
    },
  });

  return false;
}

/**
 * Re-read the authoritative employer verification state
 * before permitting new marketplace obligations.
 */
async function assertCurrentBusinessEligible(profile, res) {
  const current = await EmployerProfile.findById(profile._id)
    .select(
      "cacVerificationStatus regulatoryVerificationStatus employerApprovalStatus accountStatus"
    )
    .lean();

  if (!current) {
    res.status(404).json({
      success: false,
      message: "Employer profile not found.",
    });

    return false;
  }

  return assertBusinessEligible(current, res);
}

// ───────────────────── NEW OBLIGATION GUARD ─────────────────────

/**
 * Control creation of new marketplace obligations.
 *
 * Existing claims, disputes, overtime top-ups and active work
 * remain governed by their respective workflow policies.
 */
exports.canCreateNewObligations = async (req, res, next) => {
  try {
    const profile = req.employerProfile;

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Employer profile not found.",
      });
    }

    if (!req.employerContext?.roleCanPostShifts) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to create new employer obligations.",
      });
    }

    if (!(await assertCurrentBusinessEligible(profile, res))) {
      return;
    }

    try {
      await EmployerDelinquencyService.assertCanCreateNewObligation({
        businessId: profile._id,
        currentTime: new Date(),
      });
    } catch (error) {
      if (error.code === "EMPLOYER_NEW_OBLIGATIONS_RESTRICTED") {
        return res.status(403).json({
          success: false,
          code: error.code,

          message: "Please resolve the outstanding Shift payment before creating a new obligation.",

          restrictionReason: error.details?.restrictionReason || "overdue_overtime_topup",
        });
      }

      throw error;
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── SHIFT POSTING GUARD ─────────────────────

exports.canPostShifts = async (req, res, next) => {
  try {
    const profile = req.employerProfile;
    const employerContext = req.employerContext;

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Employer profile not found.",
      });
    }

    // User-level permission is checked independently.
    if (!employerContext?.roleCanPostShifts) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to post shifts.",
      });
    }

    // Re-read verification state to avoid relying on stale context.
    if (!(await assertCurrentBusinessEligible(profile, res))) {
      return;
    }

    try {
      await EmployerDelinquencyService.assertCanPostShifts({
        businessId: profile._id,
        currentTime: new Date(),
      });
    } catch (error) {
      if (error.code === "EMPLOYER_NEW_OBLIGATIONS_RESTRICTED") {
        return res.status(403).json({
          success: false,
          code: error.code,

          message: "Please resolve the outstanding Shift payment before posting another shift.",

          restrictionReason: error.details?.restrictionReason || "overdue_overtime_topup",
        });
      }

      throw error;
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── SHIFT FUNDING GUARD ─────────────────────

/**
 * Funding permission remains separate from eligibility
 * to post new shifts, allowing existing obligations to
 * be settled according to their normal workflow.
 */
exports.canFundShifts = (req, res, next) => {
  try {
    if (req.employerContext?.canFundShifts !== true) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to fund Shifts.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── WALLET VIEW GUARD ─────────────────────

exports.canViewWallet = (req, res, next) => {
  try {
    if (req.employerContext?.canViewWallet !== true) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to view the employer wallet.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── WALLET MANAGEMENT GUARD ─────────────────────

exports.canManageWallet = (req, res, next) => {
  try {
    if (req.employerContext?.canManageWallet !== true) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to manage the employer wallet.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
