// models/DVA.js

const mongoose = require("mongoose");

const dvaSchema = new mongoose.Schema(
  {
    // --- OWNERSHIP ---

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    // --- PAYSTACK RESPONSE FIELDS ---

    customerId: {
      type: String,
      trim: true,
      required: true,
    },

    customerCode: {
      type: String,
      trim: true,
      required: true, // e.g. CUS_xxxxxxxxxxxx
    },

    dedicatedAccountId: {
      type: Number,
      required: true, // Paystack's internal DVA id
    },

    accountNumber: {
      type: String,
      trim: true,
      required: true,
    },

    accountName: {
      type: String,
      trim: true,
      required: true,
    },

    bankName: {
      type: String,
      trim: true,
      required: true,
    },

    bankCode: {
      type: String,
      trim: true,
      required: true,
    },

    bankSlug: {
      type: String,
      trim: true,
      default: null,
    },

    // --- STATUS ---

    active: {
      type: Boolean,
      default: true,
    },

    assignedAt: {
      type: Date,
      default: Date.now,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One active DVA per employer
dvaSchema.index(
  { employer: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      active: true,
      employer: { $type: "objectId" },
    },
  }
);

dvaSchema.index({ accountNumber: 1 });

module.exports = mongoose.model("DVA", dvaSchema);
