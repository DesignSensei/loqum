// services/teamMemberService.js

const mongoose = require("mongoose");

const EmployerMember = require("../models/EmployerMember");
const Branch = require("../models/Branch");

const { badgeClass, formatStatus } = require("../utils/statusHelper");

const allowedMemberRoles = ["admin", "branch_manager", "branch_staff"];
const allowedEditableStatuses = ["active", "restricted", "suspended"];

function normalizeId(value) {
  return String(value || "").trim();
}

function assertValidObjectId(value, message) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error(message);
  }
}

function normalizeRole(role) {
  const normalizedRole = String(role || "")
    .toLowerCase()
    .trim();

  if (!allowedMemberRoles.includes(normalizedRole)) {
    throw new Error("Invalid team member role.");
  }

  return normalizedRole;
}

function normalizeAccountStatus(accountStatus) {
  const normalizedStatus = String(accountStatus || "active")
    .toLowerCase()
    .trim();

  if (!allowedEditableStatuses.includes(normalizedStatus)) {
    throw new Error("Invalid team member status.");
  }

  return normalizedStatus;
}

function normalizeBranchIds(branchIds) {
  if (!branchIds) {
    return [];
  }

  const values = Array.isArray(branchIds) ? branchIds : String(branchIds).split(",");

  const cleanIds = values.map((value) => normalizeId(value)).filter(Boolean);

  return [...new Set(cleanIds)];
}

function getMemberDisplayName(member) {
  const user = member.user;

  if (!user) {
    return "Unknown member";
  }

  if (user.displayName) {
    return user.displayName;
  }

  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

  if (fullName) {
    return fullName;
  }

  return user.email || "Unknown member";
}

function formatMemberRole(role) {
  const roleLabels = {
    admin: "Admin",
    branch_manager: "Branch Manager",
    branch_staff: "Branch Staff",
  };

  return roleLabels[role] || formatStatus(role || "");
}

function syncMemberTopLevelRole(member) {
  if (member.role === "admin") {
    member.branches = [];
    return;
  }

  const hasManagerBranch = member.branches.some(
    (assignment) => assignment.role === "branch_manager"
  );

  member.role = hasManagerBranch ? "branch_manager" : "branch_staff";
}

function getExistingAssignedAtMap(member) {
  const assignedAtByBranchId = new Map();

  const assignments = Array.isArray(member.branches) ? member.branches : [];

  assignments.forEach((assignment) => {
    if (!assignment.branch) return;

    assignedAtByBranchId.set(
      String(assignment.branch._id || assignment.branch),
      assignment.assignedAt
    );
  });

  return assignedAtByBranchId;
}

function buildBranchAssignments({ member, branchIds, role }) {
  const assignedAtByBranchId = getExistingAssignedAtMap(member);

  return branchIds.map((branchId) => ({
    branch: branchId,
    role,
    assignedAt: assignedAtByBranchId.get(String(branchId)) || new Date(),
  }));
}

function shapeBranchAssignment(assignment) {
  const branch = assignment.branch;

  return {
    branchId: String(branch?._id || branch || ""),
    branchName: branch?.name || "Unknown branch",
    branchAddress: branch?.address || "",
    branchState: branch?.state || "",
    branchLga: branch?.lga || "",
    role: assignment.role,
    roleLabel: formatMemberRole(assignment.role),
    assignedAt: assignment.assignedAt || null,
  };
}

function shapeTeamMember(member) {
  const accountStatus = member.accountStatus || "active";
  const isRemoved = accountStatus === "removed";
  const isCurrent = member.isCurrent !== false;

  return {
    _id: member._id,

    name: getMemberDisplayName(member),
    email: member.user?.email || "-",
    photo: member.user?.photo || "",

    userId: member.user?._id || member.user || null,

    role: member.role,
    roleLabel: formatMemberRole(member.role),
    roleBadgeClass: "badge-light-primary",

    accountStatus,
    statusLabel: formatStatus(accountStatus),
    statusBadgeClass: badgeClass[accountStatus] || "badge-light-secondary",

    isCurrent,
    isRemoved,

    branches: Array.isArray(member.branches) ? member.branches.map(shapeBranchAssignment) : [],

    removedAt: member.removedAt || null,
    removedBy: member.removedBy || null,
    removalReason: member.removalReason || "",

    canEdit: isCurrent && !isRemoved,
    canRemove: isCurrent && !isRemoved,
  };
}

async function getMemberForBusiness({ memberId, businessId }) {
  const cleanMemberId = normalizeId(memberId);

  if (!cleanMemberId) {
    throw new Error("Team member ID is required.");
  }

  assertValidObjectId(cleanMemberId, "Invalid team member ID.");

  const member = await EmployerMember.findOne({
    _id: cleanMemberId,
    business: businessId,
  })
    .populate("user", "firstName lastName displayName email photo accountStatus")
    .populate("branches.branch", "name address state lga");

  if (!member) {
    throw new Error("Team member not found.");
  }

  return member;
}

async function validateBranchesForBusiness({ branchIds, businessId }) {
  if (branchIds.length === 0) {
    return [];
  }

  branchIds.forEach((branchId) => {
    assertValidObjectId(branchId, "Invalid branch ID.");
  });

  const branches = await Branch.find({
    _id: { $in: branchIds },
    business: businessId,
  }).select("_id name");

  if (branches.length !== branchIds.length) {
    throw new Error("One or more selected branches were not found for this business.");
  }

  return branches;
}

async function demoteExistingBranchManagers({ businessId, branchIds, newManagerMemberId }) {
  if (!branchIds.length) {
    return;
  }

  const existingManagers = await EmployerMember.find({
    business: businessId,
    _id: { $ne: newManagerMemberId },
    isCurrent: { $ne: false },
    accountStatus: { $ne: "removed" },
    branches: {
      $elemMatch: {
        branch: { $in: branchIds },
        role: "branch_manager",
      },
    },
  });

  for (const member of existingManagers) {
    let changed = false;

    member.branches.forEach((assignment) => {
      const assignmentBranchId = String(assignment.branch);

      if (
        branchIds.map(String).includes(assignmentBranchId) &&
        assignment.role === "branch_manager"
      ) {
        assignment.role = "branch_staff";
        changed = true;
      }
    });

    if (changed) {
      syncMemberTopLevelRole(member);
      await member.save();
    }
  }
}

class TeamMemberService {
  static async getTeamMember({ memberId, businessId }) {
    const member = await getMemberForBusiness({
      memberId,
      businessId,
    });

    return shapeTeamMember(member);
  }

  static async updateTeamMember({
    memberId,
    businessId,
    updatedBy,
    role,
    accountStatus,
    branchIds,
  }) {
    const member = await getMemberForBusiness({
      memberId,
      businessId,
    });

    if (member.accountStatus === "removed" || member.isCurrent === false) {
      throw new Error("Removed team members cannot be edited.");
    }

    const nextRole = normalizeRole(role || member.role);
    const nextAccountStatus = normalizeAccountStatus(accountStatus || member.accountStatus);
    const nextBranchIds = normalizeBranchIds(branchIds);

    if (nextRole !== "admin" && nextBranchIds.length === 0) {
      throw new Error("Branch-level team members must be assigned to at least one branch.");
    }

    await validateBranchesForBusiness({
      branchIds: nextBranchIds,
      businessId,
    });

    if (nextRole === "branch_manager") {
      await demoteExistingBranchManagers({
        businessId,
        branchIds: nextBranchIds,
        newManagerMemberId: member._id,
      });
    }

    member.role = nextRole;
    member.accountStatus = nextAccountStatus;

    if (nextRole === "admin") {
      member.branches = [];
    } else {
      member.branches = buildBranchAssignments({
        member,
        branchIds: nextBranchIds,
        role: nextRole,
      });
    }

    member.updatedBy = updatedBy;

    await member.save();

    const updatedMember = await getMemberForBusiness({
      memberId: member._id,
      businessId,
    });

    return shapeTeamMember(updatedMember);
  }

  static async removeTeamMember({ memberId, businessId, removedBy, removalReason }) {
    const member = await getMemberForBusiness({
      memberId,
      businessId,
    });

    if (member.accountStatus === "removed" || member.isCurrent === false) {
      throw new Error("This team member has already been removed.");
    }

    if (String(member.user?._id || member.user) === String(removedBy)) {
      throw new Error("You cannot remove yourself from the team.");
    }

    member.accountStatus = "removed";
    member.isCurrent = false;
    member.removedAt = new Date();
    member.removedBy = removedBy;
    member.removalReason = String(removalReason || "").trim();

    await member.save();

    return shapeTeamMember(member);
  }
}

module.exports = TeamMemberService;
