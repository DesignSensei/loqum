// middleware/employerMiddleware.js

const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");

const EmployerDelinquencyService = require("../services/employerDelinquencyService");

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getId(value) {
  if (!value) {
    return "";
  }

  return String(value._id || value);
}

function isBusinessEligibleToOperate(profile) {
  return Boolean(
    profile &&
    profile.cacVerificationStatus === "verified" &&
    profile.regulatoryVerificationStatus === "verified" &&
    profile.employerApprovalStatus === "approved" &&
    profile.accountStatus === "active"
  );
}

async function loadEmployerMember({ userId, businessId }) {
  return EmployerMember.findOne({
    user: userId,
    business: businessId,
    accountStatus: "active",
  }).lean();
}

async function resolveEmployerProfileAndMember(user) {
  let profile = null;
  let employerMember = null;

  /*
   * 1. Invited employer user with direct business link.
   */
  if (user.employerProfile) {
    profile = await EmployerProfile.findById(user.employerProfile);
  }

  /*
   * 2. Original employer account.
   */
  if (!profile) {
    profile = await EmployerProfile.findOne({
      user: user._id,
    });
  }

  /*
   * 3. EmployerMember relationship.
   */
  if (!profile) {
    employerMember = await EmployerMember.findOne({
      user: user._id,
      accountStatus: "active",
    }).lean();

    if (employerMember?.business) {
      profile = await EmployerProfile.findById(employerMember.business);
    }
  }

  return {
    profile,
    employerMember,
  };
}

/**
 * Builds role, business and product-restriction context.
 *
 * IMPORTANT:
 *
 * Role permission and delinquency restriction are separate concepts.
 *
 * Example:
 *
 * A branch manager may normally have role permission to post Shifts,
 * but the business may temporarily be restricted from creating new
 * obligations because an overdue overtime top-up remains unresolved.
 *
 * Therefore:
 *
 * roleCanPostShifts
 *     = does this person's employer role permit posting?
 *
 * canPostShifts
 *     = role permits posting AND business is not currently restricted.
 */
async function buildEmployerContext({
  user,
  profile,
  employerMember = null,
  currentTime = new Date(),
}) {
  const userId = getId(user._id);
  const businessId = getId(profile._id);

  let resolvedEmployerMember = employerMember || null;

  if (!resolvedEmployerMember) {
    resolvedEmployerMember = await loadEmployerMember({
      userId,
      businessId,
    });
  }

  const primaryEmployerUserId = getId(profile.user);

  const isPrimaryEmployer = Boolean(primaryEmployerUserId) && primaryEmployerUserId === userId;

  const employerMemberRole = resolvedEmployerMember?.role || null;

  const isBusinessAdmin = employerMemberRole === "admin";

  const isBranchManager = employerMemberRole === "branch_manager";

  const isBranchStaff = employerMemberRole === "branch_staff";

  const assignedBranchIds =
    resolvedEmployerMember?.branches
      ?.map((assignment) => getId(assignment.branch))
      .filter(Boolean) || [];

  /* ─────────────────────────────── ROLE PERMISSIONS ─────────────────────────────── */

  const canManageAllShifts = isPrimaryEmployer || isBusinessAdmin;

  const canManageAssignedBranchShifts = isBranchManager;

  const canViewShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager || isBranchStaff;

  /*
   * This is role permission only.
   *
   * Delinquency is applied separately below.
   */
  const roleCanPostShifts = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  /*
   * Claims and disputes belong to existing Shift
   * obligations.
   *
   * A delinquency restriction must NOT prevent the
   * employer from resolving them.
   *
   * Branch managers may manage these workflows only
   * for their assigned branches; actual resource-level
   * branch authorization still belongs in the relevant
   * route/service guard.
   */
  const canViewClaims = canViewShifts;

  const canManageClaims = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  const canViewDisputes = canViewShifts;

  const canManageDisputes = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  /*
   * Attendance/overtime responses are existing Shift
   * management actions.
   *
   * They remain available during delinquency because
   * they may be necessary to resolve the underlying
   * obligation.
   */
  const canManagePostShiftWorkflows = isPrimaryEmployer || isBusinessAdmin || isBranchManager;

  /*
   * Actual financial actions remain limited to the
   * primary employer and business administrators.
   */
  const canManageFinancialObligations = isPrimaryEmployer || isBusinessAdmin;

  /*
   * Employer refunds can contain sensitive financial
   * information and consent-controlled fallback actions.
   *
   * Branch managers/staff should not gain wallet-level
   * refund authority merely because they manage Shifts.
   */
  const canViewRefunds = isPrimaryEmployer || isBusinessAdmin;

  const canManageRefundActions = isPrimaryEmployer || isBusinessAdmin;

  /* ─────────────────────────────── DELINQUENCY STATE ─────────────────────────────── */

  const delinquency = await EmployerDelinquencyService.getRestrictionState({
    businessId: profile._id,
    currentTime,
  });

  /*
   * This is the effective posting capability exposed to
   * views/controllers.
   *
   * roleCanPostShifts remains available when code needs
   * to distinguish "not authorized by role" from
   * "temporarily restricted by business delinquency".
   */
  const canPostShifts = roleCanPostShifts && delinquency.canPostShifts;

  const employerContext = {
    employerMemberRole,

    isPrimaryEmployer,
    isBusinessAdmin,
    isBranchManager,
    isBranchStaff,

    assignedBranchIds,

    /* ───────── BUSINESS PROFILE ───────── */

    canViewBusinessProfile: true,

    canManageBusinessProfile: isPrimaryEmployer || isBusinessAdmin,

    /* ───────── BRANCHES ───────── */

    canViewBranches: true,

    canManageBranches: isPrimaryEmployer || isBusinessAdmin,

    /* ───────── TEAM ───────── */

    canViewTeamMembers: isPrimaryEmployer || isBusinessAdmin,

    canInviteMembers: isPrimaryEmployer || isBusinessAdmin,

    /* ───────── WALLET / FINANCIAL ───────── */

    canViewWallet: isPrimaryEmployer || isBusinessAdmin,

    canManageWallet: isPrimaryEmployer || isBusinessAdmin,

    canManageFinancialObligations,

    /* ───────── SHIFTS ───────── */

    canViewShifts,

    roleCanPostShifts,

    canPostShifts,

    canManageAllShifts,

    canManageAssignedBranchShifts,

    canManagePostShiftWorkflows,

    /* ───────── CLAIMS ───────── */

    canViewClaims,

    canManageClaims,

    /* ───────── DISPUTES ───────── */

    canViewDisputes,

    canManageDisputes,

    /* ───────── REFUNDS ───────── */

    canViewRefunds,

    canManageRefundActions,

    /* ───────── PRODUCT RESTRICTION ───────── */

    canCreateNewObligations: delinquency.canCreateNewObligations,

    newObligationsRestricted: delinquency.restricted,

    restrictionReason: delinquency.restrictionReason,

    delinquency,
  };

  return {
    employerMember: resolvedEmployerMember,

    employerContext,
  };
}

/* ─────────────────────────────── ATTACH EMPLOYER PROFILE ─────────────────────────────── */

/**
 * Attaches the employer's business profile to the request.
 *
 * Use this on protected employer routes.
 *
 * Supports:
 *
 * 1. Original employer account that owns/created EmployerProfile.
 * 2. Invited employer users attached through User.employerProfile.
 * 3. Invited employer users attached through EmployerMember.
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

    const { profile, employerMember } = await resolveEmployerProfileAndMember(req.user);

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

/* ─────────────────────────────── ATTACH EMPLOYER CONTEXT ─────────────────────────────── */

/**
 * Attaches employer-specific role, permission and
 * delinquency context.
 *
 * The original employer account is computed as
 * `isPrimaryEmployer`.
 */
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

    req.employerMember = employerMember;

    req.employerContext = employerContext;

    res.locals.employerMember = employerMember;

    res.locals.employerContext = employerContext;

    return next();
  } catch (error) {
    return next(error);
  }
};

/* ─────────────────────────────── OPTIONAL EMPLOYER CONTEXT ─────────────────────────────── */

/**
 * Optionally attaches employer profile/context for
 * shared routes.
 *
 * Use this on routes such as Account Settings that
 * are available to admin, professional and employer
 * users.
 *
 * It does not redirect non-employer users.
 * It does not block admin/professional users.
 */
exports.attachOptionalEmployerContext = async (req, res, next) => {
  try {
    req.employerProfile = req.employerProfile || null;

    req.employerMember = req.employerMember || null;

    req.employerContext = req.employerContext || null;

    res.locals.employerProfile = res.locals.employerProfile || null;

    res.locals.employerMember = res.locals.employerMember || null;

    res.locals.employerContext = res.locals.employerContext || null;

    if (!req.user || req.user.role !== "employer") {
      return next();
    }

    let profile = req.employerProfile;

    let employerMember = req.employerMember;

    if (!profile) {
      const resolved = await resolveEmployerProfileAndMember(req.user);

      profile = resolved.profile;

      employerMember = resolved.employerMember;
    }

    if (!profile) {
      return next();
    }

    const contextResult = await buildEmployerContext({
      user: req.user,

      profile,

      employerMember,

      currentTime: new Date(),
    });

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

/* ─────────────────────────────── BUSINESS ELIGIBILITY GUARD ─────────────────────────────── */

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

/* ─────────────────────────────── NEW-OBLIGATION GUARD ─────────────────────────────── */

/**
 * Generic restriction guard for routes that CREATE a
 * new business obligation.
 *
 * Do NOT use this middleware on:
 *
 * - claim/dispute responses;
 * - overtime top-up payment;
 * - attendance correction;
 * - existing Shift management;
 * - wallet access needed to resolve an obligation;
 * - refund receipt;
 * - refund fallback consent.
 *
 * Those workflows must remain accessible while the
 * employer is restricted.
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

    if (!assertBusinessEligible(profile, res)) {
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

/* ─────────────────────────────── SHIFT POSTING GUARD ─────────────────────────────── */

/**
 * Checks whether an employer user may post Shifts.
 *
 * Three independent conditions are enforced:
 *
 * 1. Their employer ROLE permits Shift posting.
 * 2. The BUSINESS is verified, approved and active.
 * 3. The BUSINESS is not currently restricted from
 *    creating new obligations.
 *
 * The delinquency check is deliberately repeated here,
 * even though attachEmployerContext already exposes the
 * state for UI purposes.
 *
 * Enforcement must use fresh authoritative data at the
 * moment the new obligation is created.
 */
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

    /*
     * Check ROLE permission rather than the derived
     * canPostShifts value.
     *
     * canPostShifts can also be false because of
     * delinquency. In that case the employer should
     * receive the correct restriction explanation,
     * not a misleading role-permission error.
     */
    if (!employerContext?.roleCanPostShifts) {
      return res.status(403).json({
        success: false,

        message: "You do not have permission to post shifts.",
      });
    }

    if (!assertBusinessEligible(profile, res)) {
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
