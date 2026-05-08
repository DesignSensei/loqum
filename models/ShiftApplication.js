// models/ShiftApplication.js

const mongoose = require("mongoose");

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

    withdrawnAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    acceptedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// One professional can only apply once per shift
shiftApplicationSchema.index({ shift: 1, professional: 1 }, { unique: true });

// Efficient querying — all applications for a shift, all applications by a professional
shiftApplicationSchema.index({ shift: 1, status: 1 });
shiftApplicationSchema.index({ professional: 1, status: 1 });

module.exports = mongoose.model("ShiftApplication", shiftApplicationSchema);
