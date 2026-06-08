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
 *    Escrow wallet availableBalance is credited.
 *
 * 2. Fund with Transfer:
 *    Employer transfers into their assigned DVA for a specific shift funding
 *    instruction. Once Paystack confirms the payment, escrow wallet
 *    availableBalance is credited directly for that shift.
 *
 * Random DVA deposits that are not tied to a specific shift funding instruction
 * should only top up the employer wallet. They should not automatically fund
 * any shift.
 *
 * professional:
 * Stores professional earnings after completed and cleared shifts.
 * Professionals receive their approved shift pay.
 * No pharmacist-side commission deduction at launch.
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
 * The DVA is only the payment rail that receives bank transfers.
 * The Wallet is where usable platform balance is recorded.
 *
 * Protected Shift money lives in escrow, not in employer heldBalance.
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

    currency: {
      type: String,
      enum: ["NGN"],
      default: "NGN",
    },

    // --- LIMITS ---

    maximumBalance: {
      type: Number,
      default: null,
      min: 0,
      // Optional employer wallet cap.
      // Useful to prevent employers from parking unlimited funds on Loqum.
      // If null, service layer can fall back to platform config.
    },

    minimumWithdrawalAmount: {
      type: Number,
      default: null,
      min: 0,
      // Optional professional withdrawal threshold.
      // If null, service layer can fall back to platform config.
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
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One wallet per employer
walletSchema.index(
  { employer: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: "employer",
      employer: { $type: "objectId" },
    },
  }
);

// One wallet per professional
walletSchema.index(
  { professional: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: "professional",
      professional: { $type: "objectId" },
    },
  }
);

// One escrow wallet and one platform wallet
walletSchema.index(
  { ownerType: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: { $in: ["escrow", "platform"] },
    },
  }
);

walletSchema.index({ ownerType: 1 });
walletSchema.index({ status: 1 });
walletSchema.index({ currency: 1 });

// --- VALIDATION ---

walletSchema.pre("validate", function (next) {
  if (this.ownerType === "employer") {
    if (!this.employer) {
      return next(new Error("Employer wallet must reference an employer profile."));
    }

    if (this.professional) {
      return next(new Error("Employer wallet cannot reference a professional profile."));
    }
  }

  if (this.ownerType === "professional") {
    if (!this.professional) {
      return next(new Error("Professional wallet must reference a professional profile."));
    }

    if (this.employer) {
      return next(new Error("Professional wallet cannot reference an employer profile."));
    }
  }

  if (this.ownerType === "escrow" || this.ownerType === "platform") {
    if (this.employer || this.professional) {
      return next(
        new Error("System wallets cannot reference an employer or professional profile.")
      );
    }
  }

  // Only employer wallets can carry unpaid obligations.
  if (this.ownerType !== "employer" && this.outstandingBalance > 0) {
    return next(new Error("Only employer wallets can have outstanding balance."));
  }

  if (this.status === "closed") {
    const hasBalance =
      this.availableBalance > 0 || this.pendingBalance > 0 || this.outstandingBalance > 0;

    if (hasBalance) {
      return next(new Error("Wallet balance must be zero before closing."));
    }
  }

  next();
});

module.exports = mongoose.model("Wallet", walletSchema);
