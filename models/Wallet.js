// models/Wallet.js

const mongoose = require("mongoose");

/**
 * WALLET TYPES:
 *
 * employer:
 * Stores employer funds that can be used to fund shifts, receive refunds,
 * pay overtime top-ups, and hold unused balances for future shifts.
 *
 * Employers can fund a shift in two ways:
 *
 * 1. Fund with Wallet:
 *    Employer wallet availableBalance is debited.
 *    Escrow wallet is credited.
 *
 * 2. Fund with Paystack Checkout:
 *    Employer pays the exact shift amount through Paystack Checkout.
 *    Once Paystack confirms the payment, escrow wallet is credited directly
 *    for that shift.
 *
 * DVA WALLET TOP-UP:
 * DVA is only for employer wallet top-up.
 * DVA should not directly fund shifts.
 * DVA should not directly credit escrow.
 *
 * professional:
 * Stores professional earnings after completed and cleared shifts.
 * Professionals receive their approved shift pay.
 * No professional-side commission deduction at launch.
 *
 * escrow:
 * Platform-owned wallet used as the Protected Shift holding balance.
 * It holds employer-funded shift money between confirmation and settlement.
 *
 * platform:
 * Platform-owned wallet used to record Loqum's earned service fees.
 * The service fee is employer-side and should be calculated using the
 * platformFeeRate snapshotted on the shift.
 *
 * BALANCE MEANING:
 *
 * availableBalance:
 * - Employer: spendable wallet funds.
 * - Professional: withdrawable earnings.
 * - Escrow: protected shift funds currently held.
 * - Platform: earned Loqum fees.
 *
 * pendingBalance:
 * Funds still being processed or verified.
 *
 * outstandingBalance:
 * Employer-only unpaid obligations such as approved overtime top-up,
 * cancellation fee, or admin-confirmed charge.
 *
 * IMPORTANT:
 * Wallets are internal ledger records.
 * The DVA is only the payment rail that receives wallet top-up bank transfers.
 * The Wallet is where usable platform balance is recorded.
 *
 * Protected shift money lives in escrow, not in employer heldBalance.
 *
 * No wallet balance should go negative.
 * Service layer must enforce all debit checks before updating balances.
 */

const walletSchema = new mongoose.Schema(
  {
    // --- OWNERSHIP ---

    ownerType: {
      type: String,
      enum: ["employer", "professional", "escrow", "platform"],
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

    // --- COUNTRY / CURRENCY ---

    countryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
      required: true,
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      required: true,
    },

    // --- BALANCES ---

    availableBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    pendingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    outstandingBalance: {
      type: Number,
      default: 0,
      min: 0,
      // Employer-only aggregate of unfunded platform obligations.
      // Example: approved overtime top-up, cancellation fee, or admin-confirmed charge.
      // This is not spendable money and not a negative wallet balance.
      // Source of truth should remain Shift and Transaction records.
    },

    lifetimeCredit: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative value ever credited to this wallet.
    },

    lifetimeDebit: {
      type: Number,
      default: 0,
      min: 0,
      // Cumulative value ever debited from this wallet.
    },

    // --- LIMITS ---

    maximumBalance: {
      type: Number,
      default: null,
      min: 0,
      // Optional wallet-specific balance cap.
      // Employer wallets may fall back to PlatformSettings.maximumEmployerWalletBalance.
    },

    minimumWithdrawalAmount: {
      type: Number,
      default: null,
      min: 0,
      // Optional wallet-specific withdrawal threshold.
      // If null, service layer can fall back to PlatformSettings.
    },

    // --- STATUS ---

    status: {
      type: String,
      enum: ["active", "frozen", "closed"],
      default: "active",
      // active: transactions allowed.
      // frozen: no wallet movement allowed pending review.
      // closed: wallet terminated. Balance should be zero before closing.
    },

    frozenReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    frozenAt: {
      type: Date,
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    lastTransactionAt: {
      type: Date,
      default: null,
      // Updated by wallet service after successful wallet movement.
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One employer wallet per country and currency.
// Launch: one NGN wallet per employer.
// Future: allows same employer to have separate wallets if Loqum expands.
walletSchema.index(
  { employer: 1, countryCode: 1, currency: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: "employer",
      employer: { $type: "objectId" },
    },
  }
);

// One professional wallet per country and currency.
// Launch: one NGN wallet per professional.
walletSchema.index(
  { professional: 1, countryCode: 1, currency: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: "professional",
      professional: { $type: "objectId" },
    },
  }
);

// One escrow wallet per country and currency.
// One platform wallet per country and currency.
// Launch: one NGN escrow wallet and one NGN platform wallet.
walletSchema.index(
  { ownerType: 1, countryCode: 1, currency: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: { $in: ["escrow", "platform"] },
    },
  }
);

// General lookup indexes
walletSchema.index({ ownerType: 1 });
walletSchema.index({ status: 1 });
walletSchema.index({ countryCode: 1 });
walletSchema.index({ currency: 1 });
walletSchema.index({ countryCode: 1, currency: 1 });
walletSchema.index({ ownerType: 1, status: 1 });
walletSchema.index({ lastTransactionAt: -1 });

// --- VALIDATION / AUTO-CLEANUP ---

walletSchema.pre("validate", function () {
  if (!this.countryCode) {
    this.countryCode = "NG";
  }

  if (!this.currency) {
    this.currency = "NGN";
  }

  this.countryCode = String(this.countryCode).toUpperCase().trim();
  this.currency = String(this.currency).toUpperCase().trim();

  if (this.ownerType === "employer") {
    if (!this.employer) {
      throw new Error("Employer wallet must reference an employer profile.");
    }

    if (this.professional) {
      throw new Error("Employer wallet cannot reference a professional profile.");
    }
  }

  if (this.ownerType === "professional") {
    if (!this.professional) {
      throw new Error("Professional wallet must reference a professional profile.");
    }

    if (this.employer) {
      throw new Error("Professional wallet cannot reference an employer profile.");
    }
  }

  if (this.ownerType === "escrow" || this.ownerType === "platform") {
    if (this.employer || this.professional) {
      throw new Error("System wallets cannot reference an employer or professional profile.");
    }
  }

  if (this.ownerType !== "employer" && this.outstandingBalance > 0) {
    throw new Error("Only employer wallets can have outstanding balance.");
  }

  if (this.availableBalance < 0 || this.pendingBalance < 0 || this.outstandingBalance < 0) {
    throw new Error("Wallet balances cannot be negative.");
  }

  if (this.lifetimeCredit < 0 || this.lifetimeDebit < 0) {
    throw new Error("Wallet lifetime totals cannot be negative.");
  }

  if (this.status === "frozen") {
    if (!this.frozenAt) {
      this.frozenAt = new Date();
    }

    if (!this.frozenReason) {
      this.frozenReason = "Wallet frozen pending review.";
    }
  }

  if (this.status !== "frozen") {
    this.frozenReason = null;
    this.frozenAt = null;
  }

  if (this.status === "closed") {
    const hasBalance =
      this.availableBalance > 0 || this.pendingBalance > 0 || this.outstandingBalance > 0;

    if (hasBalance) {
      throw new Error("Wallet balance must be zero before closing.");
    }

    if (!this.closedAt) {
      this.closedAt = new Date();
    }
  }

  if (this.status !== "closed") {
    this.closedAt = null;
  }
});

module.exports = mongoose.model("Wallet", walletSchema);
