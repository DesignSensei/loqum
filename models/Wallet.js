// models/Wallet.js

const mongoose = require("mongoose");

/**
 * WALLET TYPES:
 *
 * employer  — funded via DVA deposits. Debited on shift confirmation (escrow hold).
 *             availableBalance = spendable funds.
 *             heldBalance      = funds committed to confirmed shifts, sitting in escrow wallet.
 *
 * professional — credited via escrow release at shift settlement (net of commission).
 *                availableBalance = withdrawable earnings.
 *                heldBalance      = always 0. Professionals never hold escrow.
 *
 * escrow    — platform-owned. Holds employer funds between shift confirmation and settlement.
 *             Debited to professional wallet on completion.
 *             Debited back to employer wallet on cancellation or proration refund.
 *             One escrow wallet per platform — not per shift, not per user.
 *
 * No wallet can go negative. Commission is deducted at source before professional wallet
 * is credited, so professional balance is always net and always >= 0.
 */

const walletSchema = new mongoose.Schema(
  {
    // --- OWNERSHIP ---

    ownerType: {
      type: String,
      enum: ["employer", "professional", "escrow"],
      required: true,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      default: null,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    // --- BALANCES ---

    availableBalance: {
      type: Number,
      default: 0,
      min: 0,
      // Employer: spendable / withdrawable funds
      // Professional: withdrawable earnings
      // Escrow: total funds held across all active shifts
    },

    heldBalance: {
      type: Number,
      default: 0,
      min: 0,
      // Employer only: mirrors what is currently sitting in the escrow wallet
      // on behalf of this employer's confirmed shifts.
      // Updated in sync with escrow wallet movements.
      // Always 0 for professional and escrow wallets.
    },

    pendingBalance: {
      type: Number,
      default: 0,
      min: 0,
      // Funds in transit — DVA deposit received by Paystack but webhook
      // not yet fully processed and credited to availableBalance.
    },

    lifetimeCredit: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative total of all credits ever posted to this wallet.
    },

    lifetimeDebit: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative total of all debits ever posted to this wallet.
    },

    currency: {
      type: String,
      enum: ["NGN"],
      default: "NGN",
    },

    // --- STATUS ---

    status: {
      type: String,
      enum: ["active", "frozen", "closed"],
      default: "active",
      // frozen — no transactions allowed, pending investigation or admin review
      // closed — account terminated, balance must be zero before closing
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One active wallet per employer
walletSchema.index(
  { employer: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      ownerType: "employer",
      employer: { $type: "objectId" },
    },
  }
);

// One active wallet per professional
walletSchema.index(
  { professional: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: {
      ownerType: "professional",
      professional: { $type: "objectId" },
    },
  }
);

walletSchema.index({ ownerType: 1 });
// Locate the escrow wallet quickly: Wallet.findOne({ ownerType: "escrow" })

// --- VALIDATION ---

walletSchema.pre("validate", function (next) {
  if (this.ownerType === "employer") {
    if (!this.employer)
      return next(new Error("Employer wallet must reference an employer profile."));
    if (this.professional)
      return next(new Error("Employer wallet cannot reference a professional profile."));
  }

  if (this.ownerType === "professional") {
    if (!this.professional)
      return next(new Error("Professional wallet must reference a professional profile."));
    if (this.employer)
      return next(new Error("Professional wallet cannot reference an employer profile."));
  }

  if (this.ownerType === "escrow") {
    if (this.employer || this.professional)
      return next(new Error("Escrow wallet cannot reference an employer or professional profile."));
  }

  next();
});

module.exports = mongoose.model("Wallet", walletSchema);
