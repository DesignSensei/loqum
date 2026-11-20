// middleware/employerMiddleware.js

const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");

const EmployerDelinquencyService = require("../services/employerDelinquencyService");

function getId(value) {
  return value ? String(value._id || value) : "";
}

function expectsJSON(req) {
  const accept = req.get("Accept") || "";

  return (
    Boolean(req.xhr) || accept.includes("application/json") || Boolean(req.is("application/json"))
  );
}

// Business eligibility is separate from branch permit readiness.
function isBusinessEligibleToOperate(profile) {
  return Boolean(
    profile && profile.cacVerificationStatus === "verified" && profile.accountStatus === "active"
  );
}

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

  return {
    profile: null,
    employerMember: null,
  };
}

async function buildEmployerContext({ user, profile, currentTime = new Date() }) {
  if (
    !user?._id ||
    !profile?._id ||
    user.role !== "employer" ||
    user.accountStatus !== "active" ||
    user.isVerified !== true
  ) {
    return {
      employerMember: null,
      employerContext: null,
    };
  }

  const userId = getId(user._id);
  const businessId = getId(profile._id);

  // Always recheck current membership.
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

  const employerMemberRole = resolvedEmployerMember?.role || null;

  const isBusinessAdmin = employerMemberRole === "admin";

  const isBranchManager = employerMemberRole === "branch_manager";

  const isBranchStaff = employerMemberRole === "branch_staff";

  const assignedBranchIds =
    resolvedEmployerMember?.branches
      ?.map((assignment) => getId(assignment.branch))
      .filter(Boolean) || [];

  const canManageAllShifts = isPrimaryEmployer || isBusinessAdmin;

  const canManageAssignedBranchShifts = isBranchManager;

  const canViewShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager || isBranchStaff;

  const roleCanPostShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewClaims = canViewShifts;

  const canManageClaims = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewDisputes = canViewShifts;

  const canManageDisputes = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canManagePostShiftWorkflows = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewWallet = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canManageWallet = isPrimaryEmployer || isBusinessAdmin;

  const canManageFinancialObligations = isPrimaryEmployer || isBusinessAdmin;

  const canFundShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewRefunds = isPrimaryEmployer || isBusinessAdmin;

  const canManageRefundActions = isPrimaryEmployer || isBusinessAdmin;

  const delinquency = await EmployerDelinquencyService.getRestrictionState({
    businessId: profile._id,
    currentTime,
  });

  const businessEligible = isBusinessEligibleToOperate(profile);

  // Branch permit readiness is enforced by the shift services.
  const canPostShifts = roleCanPostShifts && businessEligible && delinquency.canPostShifts;

  const canManageInvites =
    (isPrimaryEmployer || isBusinessAdmin) && profile.accountStatus === "active";

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

    canInviteMembers: canManageInvites,

    canViewWallet,
    canManageWallet,
    canManageFinancialObligations,
    canFundShifts,

    canViewShifts,
    roleCanPostShifts,
    canPostShifts,
    canManageAllShifts,
    canManageAssignedBranchShifts,
    canManagePostShiftWorkflows,

    canViewClaims,
    canManageClaims,

    canViewDisputes,
    canManageDisputes,

    canViewRefunds,
    canManageRefundActions,

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
      currentTime: new Date(),
    });

    if (!employerContext) {
      req.employerProfile = null;
      req.employerMember = null;

      res.locals.employerProfile = null;
      res.locals.employerContext = null;

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

    if (!profile) {
      return next();
    }

    const contextResult = await buildEmployerContext({
      user: req.user,
      profile,
      currentTime: new Date(),
    });

    if (!contextResult.employerContext) {
      return next();
    }

    req.employerProfile = profile;
    req.employerMember = contextResult.employerMember;

    req.employerContext = contextResult.employerContext;

    res.locals.employerProfile = profile;
    res.locals.employerMember = contextResult.employerContext ? contextResult.employerMember : null;

    res.locals.employerContext = contextResult.employerContext;

    return next();
  } catch (error) {
    return next(error);
  }
};

function assertBusinessEligible(profile, res) {
  if (isBusinessEligibleToOperate(profile)) {
    return true;
  }

  res.status(403).json({
    success: false,

    message:
      "Your CAC registration must be verified and your business account active before you can perform this action.",

    requirements: {
      cacVerificationStatus: profile?.cacVerificationStatus,

      accountStatus: profile?.accountStatus,
    },
  });

  return false;
}

async function assertCurrentBusinessEligible(profile, res) {
  const current = await EmployerProfile.findById(profile._id)
    .select("cacVerificationStatus accountStatus")
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

    if (!employerContext?.roleCanPostShifts) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to post shifts.",
      });
    }

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
