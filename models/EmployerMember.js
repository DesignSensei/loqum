// models/EmployerMember.js

const mongoose = require("mongoose");

const branchAssignmentSchema = new mongoose.Schema(
  {
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    role: {
      type: String,
      enum: ["branch_manager", "branch_staff"],
      required: true,
    },

    assignedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const employerMemberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // One membership record per user across the platform.
      // This means a user cannot belong to two different employer businesses at once.
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    // --- BUSINESS-LEVEL ROLE ---
    // admin: full business access, not tied to a specific branch.
    // branch_manager / branch_staff: access is determined by the branches array.

    role: {
      type: String,
      enum: ["admin", "branch_manager", "branch_staff"],
      required: true,
    },

    // --- BRANCH ASSIGNMENTS ---
    // Empty for admins.
    // One or more entries for branch_manager and branch_staff.
    // A member can be assigned to multiple branches under the same business.

    branches: {
      type: [branchAssignmentSchema],
      default: [],
    },

    // --- STATUS ---

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

employerMemberSchema.index({ user: 1 }, { unique: true });

// Efficient lookup: all members of a business
employerMemberSchema.index({ business: 1 });

// Efficient lookup: all members assigned to a specific branch
employerMemberSchema.index({ "branches.branch": 1 });

// Useful for member access checks
employerMemberSchema.index({ user: 1, business: 1 });

// Useful for filtering active/restricted/suspended members
employerMemberSchema.index({ business: 1, accountStatus: 1 });

// --- VALIDATION ---

employerMemberSchema.pre("validate", function (next) {
  if (this.role === "admin" && this.branches.length > 0) {
    return next(
      new Error("Admins have business-wide access and cannot be assigned to specific branches.")
    );
  }

  if (
    (this.role === "branch_manager" || this.role === "branch_staff") &&
    this.branches.length === 0
  ) {
    return next(new Error("Branch-level members must be assigned to at least one branch."));
  }

  // No duplicate branch assignments
  const branchIds = this.branches.map((assignment) => assignment.branch.toString());
  const uniqueBranchIds = new Set(branchIds);

  if (branchIds.length !== uniqueBranchIds.size) {
    return next(new Error("Duplicate branch assignments are not allowed."));
  }

  // Keep top-level role aligned with branch assignment roles.
  // If any branch assignment is branch_manager, the member's top-level role
  // must also be branch_manager.

  const hasManagerBranch = this.branches.some((assignment) => assignment.role === "branch_manager");

  if (this.role === "branch_staff" && hasManagerBranch) {
    return next(
      new Error(
        "A member with a branch manager assignment must have branch_manager as top-level role."
      )
    );
  }

  if (this.role === "branch_manager" && !hasManagerBranch) {
    return next(new Error("A branch_manager member must manage at least one branch."));
  }

  next();
});

module.exports = mongoose.model("EmployerMember", employerMemberSchema);
