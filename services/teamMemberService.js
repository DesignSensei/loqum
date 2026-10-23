// services/teamMemberService.js

const mongoose = require("mongoose");

const EmployerMember = require("../models/EmployerMember");
const EmployerProfile = require("../models/EmployerProfile");
const Branch = require("../models/Branch");

const { badgeClass, formatStatus } = require("../utils/statusHelper");

const allowedMemberRoles = ["admin", "branch_manager", "branch_staff"];
const allowedEditableStatuses = ["active", "restricted", "suspended"];

function normalizeId(value) {
  return String(value?._id || value || "").trim();
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

/* ─────────────────────────────── MEMBER LOOKUP ─────────────────────────────── */

async function getMemberForBusiness({ memberId, businessId, session = null, populate = true }) {
  const cleanMemberId = normalizeId(memberId);

  if (!cleanMemberId) {
    throw new Error("Team member ID is required.");
  }

  assertValidObjectId(cleanMemberId, "Invalid team member ID.");

  const query = EmployerMember.findOne({
    _id: cleanMemberId,
    business: businessId,
  });

  if (session) {
    query.session(session);
  }

  /*
   * Populate member details for read responses.
   *
   * Transactional mutations use the unpopulated
   * member document to avoid unnecessary
   * additional queries inside the transaction.
   */

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

/* ─────────────────────────────── BUSINESS OWNER PROTECTION ─────────────────────────────── */

/*
 * The primary employer is identified by
 * EmployerProfile.user, not by the existence
 * or role of an EmployerMember record.
 *
 * A primary business owner must not be
 * demoted, suspended, restricted or removed
 * through ordinary team membership actions.
 *
 * Ownership changes require a separate
 * authorised ownership-management workflow.
 */

async function assertNotPrimaryEmployer({ member, businessId, session = null }) {
  const query = EmployerProfile.findById(businessId).select("user");

  if (session) {
    query.session(session);
  }

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
  if (branchIds.length === 0) {
    return [];
  }

  branchIds.forEach((branchId) => {
    assertValidObjectId(branchId, "Invalid branch ID.");
  });

  const query = Branch.find({
    _id: { $in: branchIds },
    business: businessId,
  }).select("_id name");

  if (session) {
    query.session(session);
  }

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
  session = null,
}) {
  if (!branchIds.length) {
    return;
  }

  /*
   * Historical removed memberships must
   * not be modified during manager replacement.
   *
   * Restricted or suspended current memberships
   * are included so that restoring those members
   * later cannot restore an obsolete manager
   * assignment.
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
  });

  if (session) {
    query.session(session);
  }

  const existingManagers = await query;
  const selectedBranchIds = new Set(branchIds.map(String));

  for (const member of existingManagers) {
    let changed = false;

    member.branches.forEach((assignment) => {
      const assignmentBranchId = String(assignment.branch);

      if (selectedBranchIds.has(assignmentBranchId) && assignment.role === "branch_manager") {
        assignment.role = "branch_staff";
        changed = true;
      }
    });

    if (changed) {
      syncMemberTopLevelRole(member);

      await member.save(session ? { session } : {});
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
    /*
     * A team update may affect more than
     * one EmployerMember document when
     * assigning a new branch manager.
     *
     * The member update and existing manager
     * demotions must be atomic.
     *
     * If validation or any database write
     * fails, the transaction must roll back
     * all related membership changes.
     */

    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const member = await getMemberForBusiness({
          memberId,
          businessId,
          session,
          populate: false,
        });

        if (member.accountStatus === "removed" || member.isCurrent === false) {
          throw new Error("Removed team members cannot be edited.");
        }

        await assertNotPrimaryEmployer({
          member,
          businessId,
          session,
        });

        const nextRole = normalizeRole(role || member.role);

        const nextAccountStatus = normalizeAccountStatus(accountStatus || member.accountStatus);

        /*
         * When the caller omits branchIds,
         * preserve existing branch assignments.
         *
         * This allows a status-only update
         * without unintentionally clearing
         * a member's branches.
         *
         * An explicitly supplied empty array
         * still means no branches were selected.
         */

        const nextBranchIds =
          branchIds === undefined || branchIds === null
            ? normalizeBranchIds(
                (Array.isArray(member.branches) ? member.branches : []).map(
                  (assignment) => assignment.branch
                )
              )
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

        /*
         * Apply the intended member changes
         * inside the same transaction as
         * subsequent manager reassignment.
         *
         * An administrator always has
         * business-wide access without
         * individual branch assignments.
         */

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

        await member.save({ session });

        /*
         * Only an active branch manager should
         * replace other branch managers.
         *
         * Suspending or restricting a manager
         * must not demote active colleagues
         * or assign authority to someone
         * who currently cannot exercise it.
         *
         * When the member becomes active again,
         * an update with active status will
         * apply manager replacement as needed.
         */

        if (nextRole === "branch_manager" && nextAccountStatus === "active") {
          await demoteExistingBranchManagers({
            businessId,
            branchIds: nextBranchIds,
            newManagerMemberId: member._id,
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
    const member = await getMemberForBusiness({
      memberId,
      businessId,
      populate: false,
    });

    if (member.accountStatus === "removed" || member.isCurrent === false) {
      throw new Error("This team member has already been removed.");
    }

    /*
     * A business administrator cannot
     * remove their own membership through
     * the ordinary team removal endpoint.
     */

    if (normalizeId(member.user) === normalizeId(removedBy)) {
      throw new Error("You cannot remove yourself from the team.");
    }

    /*
     * Protect the primary employer account.
     *
     * The business owner cannot be removed
     * by another business administrator.
     */

    await assertNotPrimaryEmployer({
      member,
      businessId,
    });

    const removedAt = new Date();
    const cleanRemovalReason = String(removalReason || "").trim();

    /*
     * Update only a current, nonremoved
     * membership.
     *
     * This conditional database update
     * prevents two concurrent removal
     * requests from both succeeding.
     *
     * The historical EmployerMember record
     * is retained for audit.
     *
     * Do not delete, suspend, deactivate
     * or otherwise modify the user's
     * platform-level User account.
     *
     * Do not clear User.employerProfile here.
     * The employer context middleware denies
     * access when there is no active, current
     * membership.
     *
     * A subsequent invitation from another
     * business may update User.employerProfile
     * after validating the removal history.
     */

    const removedMember = await EmployerMember.findOneAndUpdate(
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
          removedAt,
          removedBy,
          removalReason: cleanRemovalReason,
          updatedBy: removedBy,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!removedMember) {
      throw new Error("This team member is no longer current or has already been removed.");
    }

    const historicalMember = await getMemberForBusiness({
      memberId: removedMember._id,
      businessId,
    });

    return shapeTeamMember(historicalMember);
  }
}

module.exports = TeamMemberService;
