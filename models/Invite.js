// models/Invite.js

const mongoose = require("mongoose");
const crypto = require("crypto");

const allowedInviteRoles = ["admin", "branch_manager", "branch_staff"];
const branchScopedRoles = ["branch_manager", "branch_staff"];

const inviteSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    /**
     * Admin invites are business-wide and should not have a branch.
     * Branch managers and branch staff must be assigned to a branch.
     */
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: undefined,
    },

    role: {
      type: String,
      enum: allowedInviteRoles,
      required: true,
    },

    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    token: {
      type: String,
      required: true,
      default: () => crypto.randomBytes(32).toString("hex"),
    },

    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "revoked"],
      default: "pending",
    },

    acceptedAt: {
      type: Date,
      default: undefined,
    },

    revokedAt: {
      type: Date,
      default: undefined,
    },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  },
  {
    timestamps: true,
  }
);

/* ---------- INDEXES ---------- */

inviteSchema.index({ token: 1 }, { unique: true });
inviteSchema.index({ business: 1, status: 1, createdAt: -1 });

/**
 * Prevent more than one pending invite for the same email
 * under the same employer business.
 *
 * This keeps invite logic simple:
 * - admin invite
 * - branch manager invite
 * - branch staff invite
 *
 * Only one pending invite can exist at a time.
 */
inviteSchema.index(
  { email: 1, business: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: "pending",
    },
  }
);

/* ---------- VALIDATION ---------- */

inviteSchema.pre("validate", function () {
  if (this.role === "admin") {
    this.branch = undefined;
    return;
  }

  if (branchScopedRoles.includes(this.role) && !this.branch) {
    throw new Error("Branch managers and branch staff must be assigned to a branch.");
  }
});

module.exports = mongoose.model("Invite", inviteSchema);
