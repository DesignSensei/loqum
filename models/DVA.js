// models/DVA.js

const mongoose = require("mongoose");

/**
 * DVA MODEL:
 * Stores the employer's Paystack Dedicated Virtual Account details.
 *
 * DVA is a payment rail, not the wallet.
 *
 * Each employer receives a DVA after onboarding.
 * Employers transfer money to this account from their banking app.
 *
 * Paystack confirms the deposit through webhook.
 * Loqum credits the employer wallet.
 *
 * DVA should only fund employer wallet top-up.
 * DVA should not directly fund a shift.
 * DVA should not directly credit escrow.
 */

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
      required: true,
      // e.g. CUS_xxxxxxxxxxxx
    },

    dedicatedAccountId: {
      type: Number,
      required: true,
      // Paystack's internal DVA id.
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

    status: {
      type: String,
      enum: ["active", "inactive", "deactivated", "failed"],
      default: "active",
    },

    assignedAt: {
      type: Date,
      default: Date.now,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: 300,
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
    partialFilterExpression: {
      status: "active",
      employer: { $type: "objectId" },
    },
  }
);

// Prevent the same bank account from being assigned twice
dvaSchema.index({ bankCode: 1, accountNumber: 1 }, { unique: true });

// Paystack customer and dedicated account references should not duplicate
dvaSchema.index({ customerCode: 1 }, { unique: true });
dvaSchema.index({ dedicatedAccountId: 1 }, { unique: true });

module.exports = mongoose.model("DVA", dvaSchema);
