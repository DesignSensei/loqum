// models/EmployerMember.js

const mongoose = require("mongoose");

const employerMemberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
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
      enum: ["admin", "branch_manager", "branch_staff"],
      required: true,
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

module.exports = mongoose.model("EmployerMember", employerMemberSchema);
