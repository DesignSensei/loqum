// models/Invite.js

const mongoose = require("mongoose");
const crypto = require("crypto");

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

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    role: {
      type: String,
      enum: ["admin", "hr", "branch_manager", "branch_staff"],
      required: true,
    },

    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    token: {
      type: String,
      default: () => crypto.randomBytes(32).toString("hex"),
    },

    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "revoked"],
      default: "pending",
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

// Prevent duplicate pending invites for the same email and branch
inviteSchema.index({ token: 1 }, { unique: true });

inviteSchema.index(
  { email: 1, branch: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: "pending",
    },
  }
);

module.exports = mongoose.model("Invite", inviteSchema);
