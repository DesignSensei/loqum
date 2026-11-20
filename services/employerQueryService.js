// services/employerQueryService.js

const mongoose = require("mongoose");
const Shift = require("../models/Shift");
const ShiftApplication = require("../models/ShiftApplication");
const Wallet = require("../models/Wallet");
const DVA = require("../models/DVA");
const Branch = require("../models/Branch");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const User = require("../models/User");
const InviteService = require("./inviteService");
const FacilityPermitVerificationService = require("./facilityPermitVerificationService");

const allowedBranchStatusFilters = ["active", "inactive", "all"];
const allowedMemberStatusFilters = ["active", "restricted", "suspended", "removed", "all"];

function normalizeBranchStatusFilter(status) {
  const normalizedStatus = String(status || "active")
    .toLowerCase()
    .trim();

  return allowedBranchStatusFilters.includes(normalizedStatus) ? normalizedStatus : "active";
}

function getBranchStatusQuery({ businessId, branchStatus, assignedBranchIds = null }) {
  const query = { business: businessId };

  if (assignedBranchIds !== null) {
    query._id = { $in: assignedBranchIds };
  }

  if (branchStatus === "all") {
    return query;
  }

  return {
    ...query,
    isActive: branchStatus === "active",
  };
}

function normalizeMemberStatusFilter(status) {
  const normalizedStatus = String(status || "active")
    .toLowerCase()
    .trim();

  return allowedMemberStatusFilters.includes(normalizedStatus) ? normalizedStatus : "active";
}

function getMemberStatusQuery({ businessId, memberStatus }) {
  const query = { business: businessId };

  if (memberStatus === "all") {
    return query;
  }

  if (memberStatus === "removed") {
    return {
      ...query,
      accountStatus: "removed",
      isCurrent: false,
    };
  }

  return {
    ...query,
    accountStatus: memberStatus,
    isCurrent: true,
  };
}

function createEmployerAccessError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

async function resolveEmployerDataAccess({ employerProfile, actorUserId, employerContext }) {
  if (!employerProfile?._id || !mongoose.isValidObjectId(employerProfile._id)) {
    throw new Error("Employer profile is required.");
  }

  if (!actorUserId || !mongoose.isValidObjectId(actorUserId)) {
    throw createEmployerAccessError("Authenticated employer access is required.");
  }

  if (!employerContext || employerContext.canViewBusinessProfile !== true) {
    throw createEmployerAccessError("Employer business access is required.");
  }

  const [actor, business] = await Promise.all([
    User.findOne({
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .lean(),

    EmployerProfile.findById(employerProfile._id)
      .select("_id user accountStatus cacVerificationStatus")
      .lean(),
  ]);

  if (!actor || !business) {
    throw createEmployerAccessError("Employer business access is not available.");
  }

  const isPrimaryEmployer = String(business.user) === String(actor._id);

  const member = isPrimaryEmployer
    ? null
    : await EmployerMember.findOne({
        user: actor._id,
        business: business._id,
        accountStatus: "active",
        isCurrent: true,
      })
        .select("role branches")
        .lean();

  if (!isPrimaryEmployer && !member) {
    throw createEmployerAccessError("You do not have access to this employer business.");
  }

  const memberRole = member?.role || null;
  const isBusinessAdmin = memberRole === "admin";
  const isBranchManager = memberRole === "branch_manager";
  const isBranchStaff = memberRole === "branch_staff";

  if (!isPrimaryEmployer && !isBusinessAdmin && !isBranchManager && !isBranchStaff) {
    throw createEmployerAccessError("You do not have an authorised employer team role.");
  }

  const isBusinessWide = isPrimaryEmployer || isBusinessAdmin;
  const branchAssignments = Array.isArray(member?.branches) ? member.branches : [];

  const assignedBranchIds = isBusinessWide
    ? []
    : branchAssignments
        .map((assignment) => assignment?.branch)
        .filter((branchId) => mongoose.isValidObjectId(branchId));

  // A mixed-role member can manage only branches assigned as branch_manager.
  const managedBranchIds = isBusinessWide
    ? []
    : branchAssignments
        .filter((assignment) => assignment?.role === "branch_manager")
        .map((assignment) => assignment.branch)
        .filter((branchId) => mongoose.isValidObjectId(branchId));

  const canViewShifts = Boolean(
    employerContext.canViewShifts === true && (isBusinessWide || isBranchManager || isBranchStaff)
  );

  const canViewTeamMembers = Boolean(isBusinessWide && employerContext.canViewTeamMembers === true);

  const canInviteMembers = Boolean(
    isBusinessWide &&
    employerContext.canInviteMembers === true &&
    business.accountStatus === "active"
  );

  const canViewBranches = employerContext.canViewBranches === true;

  const canManageBusinessProfile = Boolean(
    isBusinessWide &&
    employerContext.canManageBusinessProfile === true &&
    business.accountStatus === "active"
  );

  const canViewWallet = Boolean(
    (isBusinessWide || isBranchManager) && employerContext.canViewWallet === true
  );

  const canManageWallet = Boolean(isBusinessWide && employerContext.canManageWallet === true);

  const canPostShifts = Boolean(
    (isBusinessWide || isBranchManager) &&
    employerContext.canPostShifts === true &&
    business.accountStatus === "active" &&
    business.cacVerificationStatus === "verified"
  );

  return {
    actorUserId: actor._id,
    businessId: business._id,
    businessAccountStatus: business.accountStatus,
    cacVerificationStatus: business.cacVerificationStatus,

    isPrimaryEmployer,
    isBusinessAdmin,
    isBranchManager,
    isBranchStaff,
    isBusinessWide,

    assignedBranchIds,
    managedBranchIds,

    canViewShifts,
    canPostShifts,
    canManageAllShifts: isBusinessWide && employerContext.canManageAllShifts === true,

    canViewBranches,
    canManageBusinessProfile,
    canViewTeamMembers,
    canInviteMembers,

    canViewWallet,
    canManageWallet,
  };
}

class EmployerQueryService {
  static resolveEmployerDataAccess(args) {
    return resolveEmployerDataAccess(args);
  }

  static async countCurrentlyPostableBranches(businessId, access) {
    if (!access.canPostShifts) return 0;

    const query = { business: businessId, isActive: true };

    if (!access.isBusinessWide) {
      query._id = { $in: access.managedBranchIds || [] };
    }

    const branches = await Branch.find(query).select("_id").lean();

    const readiness = await Promise.all(
      branches.map((branch) =>
        FacilityPermitVerificationService.getBranchReadiness({
          businessId,
          branchId: branch._id,
        })
      )
    );

    return readiness.filter((item) => item?.canPost === true).length;
  }

  static async getBranchStatusCounts(businessId, assignedBranchIds = null) {
    const scope = getBranchStatusQuery({
      businessId,
      branchStatus: "all",
      assignedBranchIds,
    });

    const [active, inactive, all] = await Promise.all([
      Branch.countDocuments({ ...scope, isActive: true }),
      Branch.countDocuments({ ...scope, isActive: false }),
      Branch.countDocuments(scope),
    ]);

    return { active, inactive, all };
  }

  static async getMemberStatusCounts(businessId) {
    const [active, restricted, suspended, removed, current, all] = await Promise.all([
      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "active",
        isCurrent: true,
      }),
      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "restricted",
        isCurrent: true,
      }),
      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "suspended",
        isCurrent: true,
      }),
      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "removed",
        isCurrent: false,
      }),
      EmployerMember.countDocuments({
        business: businessId,
        isCurrent: true,
        accountStatus: { $ne: "removed" },
      }),
      EmployerMember.countDocuments({ business: businessId }),
    ]);

    return { active, restricted, suspended, removed, current, all };
  }

  static async getDashboardQueries({ access, countEligibleBranches = false }) {
    const businessId = access.businessId;

    const shiftScope = access.isBusinessWide
      ? { business: businessId }
      : {
          business: businessId,
          branch: { $in: access.assignedBranchIds },
        };

    const [wallet, defaultDva, eligibleBranchCount, openShiftIds] = await Promise.all([
      access.canViewWallet
        ? Wallet.findOne({
            ownerType: "employer",
            employer: businessId,
          }).lean()
        : null,

      access.canManageWallet
        ? DVA.findOne({
            provider: "paystack",
            employer: businessId,
            isDefault: true,
          }).lean()
        : null,

      countEligibleBranches ? this.countCurrentlyPostableBranches(businessId, access) : 0,

      access.canViewShifts
        ? Shift.distinct("_id", {
            ...shiftScope,
            status: "open",
          })
        : [],
    ]);

    const [
      openShiftsCount,
      applicationsToReviewCount,
      confirmedUpcomingShiftsCount,
      recentShiftsRaw,
    ] = await Promise.all([
      access.canViewShifts ? Shift.countDocuments({ ...shiftScope, status: "open" }) : 0,

      access.canViewShifts
        ? ShiftApplication.countDocuments({
            status: "pending",
            shift: { $in: openShiftIds },
          })
        : 0,

      access.canViewShifts
        ? Shift.countDocuments({
            ...shiftScope,
            status: { $in: ["confirmed", "assigned"] },
            startTime: { $gte: new Date() },
          })
        : 0,

      access.canViewShifts
        ? Shift.find(shiftScope).sort({ createdAt: -1 }).limit(10).populate("branch", "name").lean()
        : [],
    ]);

    return {
      wallet,
      defaultDva,
      eligibleBranchCount,
      openShiftsCount,
      applicationsToReviewCount,
      confirmedUpcomingShiftsCount,
      recentShiftsRaw,
    };
  }

  static async getBusinessProfileQueries({
    access,
    activeTab,
    inviteStatus,
    branchStatus,
    memberStatus,
  }) {
    if (activeTab === "team" && !access.canViewTeamMembers) {
      throw createEmployerAccessError("You do not have permission to view employer team members.");
    }

    if (activeTab === "invites" && !access.canInviteMembers) {
      throw createEmployerAccessError("You do not have permission to view employer invitations.");
    }

    if (activeTab === "branches" && !access.canViewBranches) {
      throw createEmployerAccessError("You do not have permission to view employer branches.");
    }

    const businessId = access.businessId;
    const branchScopeIds = access.isBusinessWide ? null : access.assignedBranchIds;

    const branchQuery = getBranchStatusQuery({
      businessId,
      branchStatus,
      assignedBranchIds: branchScopeIds,
    });

    const memberQuery = getMemberStatusQuery({ businessId, memberStatus });

    const activeCurrentMemberQuery = {
      business: businessId,
      accountStatus: "active",
      isCurrent: true,
    };

    const [
      branches,
      branchStatusCounts,
      members,
      activeCurrentMembers,
      memberStatusCounts,
      inviteView,
      pendingInvitesCount,
      wallet,
      defaultDva,
      verificationBranches,
    ] = await Promise.all([
      access.canViewBranches
        ? Branch.find(branchQuery).sort({ isActive: -1, createdAt: -1 }).lean()
        : [],

      access.canViewBranches
        ? this.getBranchStatusCounts(businessId, branchScopeIds)
        : { active: 0, inactive: 0, all: 0 },

      access.canViewTeamMembers
        ? EmployerMember.find(memberQuery)
            .populate("user", "firstName lastName displayName email photo accountStatus")
            .populate("branches.branch", "name address state lga")
            .sort({ createdAt: -1 })
            .lean()
        : [],

      access.canViewTeamMembers
        ? EmployerMember.find(activeCurrentMemberQuery)
            .populate("user", "firstName lastName displayName email photo accountStatus")
            .populate("branches.branch", "name address state lga")
            .sort({ createdAt: -1 })
            .lean()
        : [],

      access.canViewTeamMembers
        ? this.getMemberStatusCounts(businessId)
        : {
            active: 0,
            restricted: 0,
            suspended: 0,
            removed: 0,
            current: 0,
            all: 0,
          },

      access.canInviteMembers
        ? InviteService.getBusinessInviteView({
            businessId,
            status: inviteStatus,
          })
        : null,

      access.canInviteMembers
        ? InviteService.countBusinessInvites({
            businessId,
            status: "pending",
          })
        : 0,

      access.canViewWallet
        ? Wallet.findOne({
            ownerType: "employer",
            employer: businessId,
          }).lean()
        : null,

      access.canManageWallet
        ? DVA.findOne({
            provider: "paystack",
            employer: businessId,
            isDefault: true,
          }).lean()
        : null,

      activeTab === "verification" && access.canViewBranches
        ? Branch.find(
            getBranchStatusQuery({
              businessId,
              branchStatus: "all",
              assignedBranchIds: branchScopeIds,
            })
          )
            .sort({ isPrimary: -1, createdAt: 1, _id: 1 })
            .lean()
        : [],
    ]);

    const branchReadinessRows = await Promise.all(
      verificationBranches.map(async (branch) => ({
        branch,
        readiness: await FacilityPermitVerificationService.getBranchReadiness({
          businessId,
          branchId: branch._id,
        }),
      }))
    );

    return {
      branches,
      branchStatusCounts,
      members,
      activeCurrentMembers,
      memberStatusCounts,
      inviteView,
      pendingInvitesCount,
      wallet,
      defaultDva,
      branchReadinessRows,
    };
  }

  static normalizeBranchStatusFilter(value) {
    return normalizeBranchStatusFilter(value);
  }

  static normalizeMemberStatusFilter(value) {
    return normalizeMemberStatusFilter(value);
  }
}

module.exports = EmployerQueryService;
