// services/teamMemberService.js

const mongoose = require("mongoose");

const EmployerMember = require("../models/EmployerMember");
const EmployerProfile = require("../models/EmployerProfile");
const Branch = require("../models/Branch");
const User = require("../models/User");

const { badgeClass, formatStatus } = require("../utils/statusHelper");

const allowedMemberRoles = ["admin", "branch_manager", "branch_staff"];
const allowedEditableStatuses = ["active", "restricted", "suspended"];

function normalizeId(value) {
  return String(value?._id || value || "").trim();
}

function assertValidObjectId(value, message) {
  if (!mongoose.isValidObjectId(value)) {
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
  if (branchIds === undefined || branchIds === null || branchIds === "") {
    return [];
  }

  const values = Array.isArray(branchIds) ? branchIds : String(branchIds).split(",");

  const cleanIds = values.map(normalizeId).filter(Boolean);
  return [...new Set(cleanIds)];
}

function getMemberDisplayName(member) {
  const user = member.user;

  if (!user) return "Unknown member";
  if (user.displayName) return user.displayName;

  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
  return fullName || user.email || "Unknown member";
}

function formatMemberRole(role) {
  const labels = {
    admin: "Admin",
    branch_manager: "Branch Manager",
    branch_staff: "Branch Staff",
  };

  return labels[role] || formatStatus(role || "");
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

/*
 * Preserve assignment dates and existing per-branch roles
 * when the caller only edits status or selects the same
 * top-level role.
 *
 * An actual top-level role change intentionally changes
 * every selected branch to the new role.
 *
 * Newly added branches inherit the selected top-level role.
 */

function buildBranchAssignments({ member, branchIds, nextRole, roleChanged }) {
  const previous = new Map(
    (Array.isArray(member.branches) ? member.branches : [])
      .filter((assignment) => assignment.branch)
      .map((assignment) => [normalizeId(assignment.branch), assignment])
  );

  return branchIds.map((branchId) => {
    const existing = previous.get(normalizeId(branchId));

    return {
      branch: branchId,
      role: roleChanged ? nextRole : existing?.role || nextRole,
      assignedAt: existing?.assignedAt || new Date(),
    };
  });
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
  const isCurrent = member.isCurrent === true;

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

/* ─────────────────────────────── MEMBER LOOKUP ─────────────────────────────── */

async function getMemberForBusiness({ memberId, businessId, session = null, populate = true }) {
  const cleanMemberId = normalizeId(memberId);

  if (!cleanMemberId) {
    throw new Error("Team member ID is required.");
  }

  assertValidObjectId(cleanMemberId, "Invalid team member ID.");
  assertValidObjectId(normalizeId(businessId), "Invalid employer business ID.");

  const query = EmployerMember.findOne({
    _id: cleanMemberId,
    business: businessId,
  });

  if (session) query.session(session);

  if (populate) {
    query
      .populate("user", "firstName lastName displayName email photo accountStatus")
      .populate("branches.branch", "name address state lga");
  }

  const member = await query;

  if (!member) {
    throw new Error("Team member not found.");
  }

  return member;
}

/* ─────────────────────────────── BUSINESS AUTHORITY ─────────────────────────────── */

/*
 * Controllers perform their own authorization.
 *
 * Recheck at service level for writes so a direct
 * service caller cannot bypass that protection.
 *
 * Business-level admin is distinct from the
 * platform User.role.
 */

async function assertCanManageTeam({ actorUserId, businessId, session }) {
  assertValidObjectId(normalizeId(actorUserId), "Valid actor ID is required.");
  assertValidObjectId(normalizeId(businessId), "Valid employer business ID is required.");

  const actorQuery = User.findOne({
    _id: actorUserId,
    role: "employer",
    accountStatus: "active",
    isVerified: true,
  }).select("_id");

  const businessQuery = EmployerProfile.findById(businessId).select("_id user");

  if (session) {
    actorQuery.session(session);
    businessQuery.session(session);
  }

  const actor = await actorQuery;
  const business = await businessQuery;

  if (!actor || !business) {
    throw new Error("An active employer account and business are required.");
  }

  if (normalizeId(business.user) === normalizeId(actor._id)) {
    return business;
  }

  const adminQuery = EmployerMember.findOne({
    user: actor._id,
    business: business._id,
    role: "admin",
    accountStatus: "active",
    isCurrent: true,
  }).select("_id");

  if (session) {
    adminQuery.session(session);
  }

  const adminMember = await adminQuery;

  if (!adminMember) {
    throw new Error(
      "Only the business owner or an active business administrator can manage team members."
    );
  }

  return business;
}

async function assertNotPrimaryEmployer({ member, businessId, session = null }) {
  const query = EmployerProfile.findById(businessId).select("user");

  if (session) query.session(session);

  const business = await query;

  if (!business) {
    throw new Error("Employer business profile not found.");
  }

  if (normalizeId(business.user) === normalizeId(member.user)) {
    throw new Error(
      "The primary business owner cannot be modified or removed through team management."
    );
  }

  return business;
}

/* ─────────────────────────────── BRANCH VALIDATION ─────────────────────────────── */

async function validateBranchesForBusiness({ branchIds, businessId, session = null }) {
  if (branchIds.length === 0) return [];

  branchIds.forEach((branchId) => {
    assertValidObjectId(branchId, "Invalid branch ID.");
  });

  const query = Branch.find({
    _id: { $in: branchIds },
    business: businessId,
  }).select("_id name");

  if (session) query.session(session);

  const branches = await query;

  if (branches.length !== branchIds.length) {
    throw new Error("One or more selected branches were not found for this business.");
  }

  return branches;
}

/* ─────────────────────────────── BRANCH MANAGER REPLACEMENT ─────────────────────────────── */

async function demoteExistingBranchManagers({
  businessId,
  branchIds,
  newManagerMemberId,
  updatedBy,
  session,
}) {
  if (!branchIds.length) return;

  /*
   * Write branch documents inside the transaction
   * to serialize competing manager replacements.
   *
   * Without a shared write, two transactions could
   * each see no existing manager and both promote
   * different members.
   *
   * timestamps: false prevents Mongoose from
   * adding a conflicting updatedAt operator.
   */

  for (const branchId of [...branchIds].map(normalizeId).sort()) {
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
  }

  /*
   * Historical removed memberships are excluded.
   *
   * Restricted and suspended current memberships
   * are included, preventing obsolete manager
   * assignments from returning after reactivation.
   */

  const query = EmployerMember.find({
    business: businessId,
    _id: { $ne: newManagerMemberId },
    isCurrent: true,
    accountStatus: { $ne: "removed" },
    branches: {
      $elemMatch: {
        branch: { $in: branchIds },
        role: "branch_manager",
      },
    },
  }).session(session);

  const existingManagers = await query;
  const selectedBranchIds = new Set(branchIds.map(normalizeId));

  for (const member of existingManagers) {
    let changed = false;

    for (const assignment of member.branches) {
      if (
        selectedBranchIds.has(normalizeId(assignment.branch)) &&
        assignment.role === "branch_manager"
      ) {
        assignment.role = "branch_staff";
        changed = true;
      }
    }

    if (changed) {
      syncMemberTopLevelRole(member);
      member.updatedBy = updatedBy;
      await member.save({ session });
    }
  }
}

/* ─────────────────────────────── TEAM MEMBER SERVICE ─────────────────────────────── */

class TeamMemberService {
  static async getTeamMember({ memberId, businessId }) {
    const member = await getMemberForBusiness({
      memberId,
      businessId,
    });

    return shapeTeamMember(member);
  }

  /* ─────────────────────────────── UPDATE TEAM MEMBER ─────────────────────────────── */

  static async updateTeamMember({
    memberId,
    businessId,
    updatedBy,
    role,
    accountStatus,
    branchIds,
  }) {
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        await assertCanManageTeam({
          actorUserId: updatedBy,
          businessId,
          session,
        });

        const member = await getMemberForBusiness({
          memberId,
          businessId,
          session,
          populate: false,
        });

        if (member.accountStatus === "removed" || member.isCurrent !== true) {
          throw new Error("Removed team members cannot be edited.");
        }

        await assertNotPrimaryEmployer({
          member,
          businessId,
          session,
        });

        /*
         * Administrators cannot modify their own
         * team roles or account statuses through
         * ordinary membership management.
         */

        if (normalizeId(member.user) === normalizeId(updatedBy)) {
          throw new Error("You cannot update your own team membership.");
        }

        const nextRole = normalizeRole(role || member.role);

        const nextAccountStatus = normalizeAccountStatus(accountStatus || member.accountStatus);

        const roleChanged = nextRole !== member.role;

        /*
         * Omitted branchIds preserves existing
         * branch assignments.
         *
         * Explicitly empty branch selections are
         * not permitted for branch-level roles.
         */

        const nextBranchIds =
          branchIds === undefined || branchIds === null
            ? normalizeBranchIds((member.branches || []).map((assignment) => assignment.branch))
            : normalizeBranchIds(branchIds);

        if (nextRole !== "admin" && nextBranchIds.length === 0) {
          throw new Error("Branch-level team members must be assigned to at least one branch.");
        }

        if (nextRole !== "admin") {
          await validateBranchesForBusiness({
            branchIds: nextBranchIds,
            businessId,
            session,
          });
        }

        member.accountStatus = nextAccountStatus;
        member.role = nextRole;

        if (nextRole === "admin") {
          member.branches = [];
        } else {
          member.branches = buildBranchAssignments({
            member,
            branchIds: nextBranchIds,
            nextRole,
            roleChanged,
          });

          syncMemberTopLevelRole(member);
        }

        member.updatedBy = updatedBy;

        await member.save({ session });

        /*
         * Only an active manager replaces existing
         * managers.
         *
         * Apply replacement only to branches where
         * this member has branch_manager authority.
         *
         * A member can manage one branch while
         * serving as ordinary staff at another.
         */

        if (member.role === "branch_manager" && nextAccountStatus === "active") {
          const managedBranchIds = member.branches
            .filter((assignment) => assignment.role === "branch_manager")
            .map((assignment) => assignment.branch);

          await demoteExistingBranchManagers({
            businessId,
            branchIds: managedBranchIds,
            newManagerMemberId: member._id,
            updatedBy,
            session,
          });
        }
      });
    } finally {
      await session.endSession();
    }

    const updatedMember = await getMemberForBusiness({
      memberId,
      businessId,
    });

    return shapeTeamMember(updatedMember);
  }

  /* ─────────────────────────────── REMOVE TEAM MEMBER ─────────────────────────────── */

  static async removeTeamMember({ memberId, businessId, removedBy, removalReason }) {
    const session = await mongoose.startSession();

    let removedMemberId;

    try {
      await session.withTransaction(async () => {
        await assertCanManageTeam({
          actorUserId: removedBy,
          businessId,
          session,
        });

        const member = await getMemberForBusiness({
          memberId,
          businessId,
          session,
          populate: false,
        });

        if (member.accountStatus === "removed" || member.isCurrent !== true) {
          throw new Error("This team member has already been removed.");
        }

        if (normalizeId(member.user) === normalizeId(removedBy)) {
          throw new Error("You cannot remove yourself from the team.");
        }

        await assertNotPrimaryEmployer({
          member,
          businessId,
          session,
        });

        /*
         * Atomically mark the current membership
         * as removed and preserve its audit record.
         *
         * The platform User account is not deleted,
         * suspended or deactivated.
         */

        const result = await EmployerMember.findOneAndUpdate(
          {
            _id: member._id,
            business: businessId,
            isCurrent: true,
            accountStatus: { $ne: "removed" },
          },
          {
            $set: {
              accountStatus: "removed",
              isCurrent: false,
              removedAt: new Date(),
              removedBy,
              removalReason: String(removalReason || "").trim(),
              updatedBy: removedBy,
            },
          },
          {
            new: true,
            runValidators: true,
            session,
          }
        );

        if (!result) {
          throw new Error("This team member is no longer current or has already been removed.");
        }

        removedMemberId = result._id;
      });
    } finally {
      await session.endSession();
    }

    /*
     * Preserve the historical membership.
     *
     * Do not clear User.employerProfile or alter
     * the platform-level User account here.
     *
     * A future invitation may establish a new
     * employer membership after eligibility checks.
     */

    const historicalMember = await getMemberForBusiness({
      memberId: removedMemberId,
      businessId,
    });

    return shapeTeamMember(historicalMember);
  }
}

module.exports = TeamMemberService;
