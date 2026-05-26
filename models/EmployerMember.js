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
      unique: true, // one membership record per user across the platform
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    // --- BUSINESS-LEVEL ROLE ---
    // admin → full business access, not tied to a specific branch
    // branch_manager / branch_staff → access determined by branches array below

    role: {
      type: String,
      enum: ["admin", "branch_manager", "branch_staff"],
      required: true,
    },

    // --- BRANCH ASSIGNMENTS ---
    // Empty for admins (they have full access)
    // One or more entries for branch_manager and branch_staff

    branches: {
      type: [branchAssignmentSchema],
      default: [],
    },

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

// Efficient lookup — all members of a business
employerMemberSchema.index({ business: 1 });

// Efficient lookup — all members assigned to a specific branch
employerMemberSchema.index({ "branches.branch": 1 });

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
  const branchIds = this.branches.map((b) => b.branch.toString());
  const uniqueBranchIds = new Set(branchIds);
  if (branchIds.length !== uniqueBranchIds.size) {
    return next(new Error("Duplicate branch assignments are not allowed."));
  }

  next();
});

module.exports = mongoose.model("EmployerMember", employerMemberSchema);
