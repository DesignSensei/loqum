// models/ShiftApplication.js

const mongoose = require("mongoose");

/**
 * OVERLAP ENFORCEMENT:
 * The service layer checks for time conflicts at two points:
 *   1. On application — soft guard, blocks applying to shifts that clash
 *      with already confirmed/assigned shifts. Saves wasted applications.
 *   2. On assignment — hard enforcement, final check before committing.
 *
 * This model does not enforce overlap — that is a service layer concern.
 */

const shiftApplicationSchema = new mongoose.Schema(
  {
    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "withdrawn"],
      default: "pending",
    },

    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
      // Optional message from the professional when applying.
      // e.g. "I have 3 years of experience in emergency pharmacy."
    },

    acceptedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    withdrawnAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One application per professional per shift
shiftApplicationSchema.index({ shift: 1, professional: 1 }, { unique: true });

// All applications for a shift — employer reviewing candidates
shiftApplicationSchema.index({ shift: 1, status: 1 });

// All applications by a professional — their application history
shiftApplicationSchema.index({ professional: 1, status: 1 });

module.exports = mongoose.model("ShiftApplication", shiftApplicationSchema);
