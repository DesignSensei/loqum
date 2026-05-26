// models/Transaction.js

const mongoose = require("mongoose");

/**
 * ARCHITECTURE: Single-entry ledger (one record per wallet per event).
 *
 * Internal transfers (e.g. shift_escrow) produce TWO Transaction documents —
 * one debit on the employer wallet, one credit on the escrow wallet —
 * linked via relatedTransaction. Per-wallet history queries are trivial.
 * counterpartyWallet lets you find the other side without a second round-trip.
 *
 * Paystack is only involved at two points:
 *   Entry — DVA deposit → wallet_funding
 *   Exit  — wallet withdrawal → withdrawal
 * Everything in between is internal ledger movement.
 */

const transactionSchema = new mongoose.Schema(
  {
    // ─── REFERENCE ────────────────────────────────────────────────────────────

    reference: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // e.g. TXN-20260514-xxxxxx — generated in service layer before insert
    },

    paystackReference: {
      type: String,
      trim: true,
      default: null,
      // Present for wallet_funding and withdrawal transactions only
    },

    // ─── TYPE ─────────────────────────────────────────────────────────────────

    type: {
      type: String,
      required: true,
      enum: [
        // --- EMPLOYER ---
        "wallet_funding", // DVA inbound → employer wallet credited
        "shift_escrow", // Employer wallet debited on shift confirmation → escrow wallet credited
        "shift_refund", // Escrow wallet debited → employer wallet credited (cancellation or proration)

        // --- PROFESSIONAL ---
        "shift_earning", // Escrow wallet debited → professional wallet credited (post settlement)
        "commission_deduction", // Commission deducted from professional wallet at settlement

        // --- SHARED ---
        "withdrawal", // Wallet → linked bank account (employer or professional)
        "withdrawal_reversal", // Failed withdrawal swept back to wallet

        // --- SYSTEM / ADMIN ---
        "dispute_refund", // Dispute resolved — funds returned to aggrieved party
        "penalty_debit", // Platform-imposed deduction
        "adjustment", // Manual correction by Loqum admin
      ],
    },

    // ─── DIRECTION ────────────────────────────────────────────────────────────

    direction: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },

    // ─── WALLET ───────────────────────────────────────────────────────────────

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      // The wallet this ledger entry belongs to
    },

    counterpartyWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null,
      // The other side of an internal transfer.
      // Null for external inflows (DVA deposits) and outflows (withdrawals).
    },

    // ─── AMOUNTS ──────────────────────────────────────────────────────────────

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      enum: ["NGN"],
      default: "NGN",
    },

    // ─── BALANCE SNAPSHOT ─────────────────────────────────────────────────────
    // Wallet state captured atomically at write time — required for audit trail.

    balanceBefore: {
      type: Number,
      required: true,
    },

    balanceAfter: {
      type: Number,
      required: true,
    },

    // ─── LINKED RECORDS ───────────────────────────────────────────────────────

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    dva: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DVA",
      default: null,
      // Populated for wallet_funding only
    },

    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
      // Populated for withdrawal and withdrawal_reversal
    },

    dispute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Dispute",
      default: null,
      // Populated for dispute_refund
    },

    relatedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Cross-links the paired record in an internal transfer,
      // or links a refund / reversal back to its originating transaction
    },

    // ─── EXTERNAL PAYMENT ─────────────────────────────────────────────────────

    paystackStatus: {
      type: String,
      enum: ["pending", "success", "failed", "reversed", null],
      default: null,
      // Tracks the gateway's own status independently of internal status.
      // Only set for wallet_funding and withdrawal transactions.
    },

    // ─── STATUS ───────────────────────────────────────────────────────────────

    status: {
      type: String,
      enum: ["pending", "completed", "failed", "reversed"],
      default: "pending",
      // Always starts pending — never assume completion before confirmation.
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      default: null,
    },

    reversedAt: {
      type: Date,
      default: null,
    },

    retryCount: {
      type: Number,
      default: 0,
      min: 0,
      // Incremented by cron on each retry attempt for failed transactions
    },

    // ─── INITIATED BY ─────────────────────────────────────────────────────────

    initiatedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
        // Null when system / cron / webhook triggered
      },
      role: {
        type: String,
        enum: ["system", "employer", "professional", "admin"],
        required: true,
      },
    },

    // ─── METADATA ─────────────────────────────────────────────────────────────

    description: {
      type: String,
      trim: true,
      // Human-readable, e.g. "Commission deduction for shift LQ-8821"
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      // Paystack webhook payloads, proration breakdowns,
      // shift hours/rates used in settlement calculation, etc.
    },
  },
  {
    timestamps: true,
  }
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

transactionSchema.index({ reference: 1 }); // unique lookup
transactionSchema.index({ paystackReference: 1 }, { sparse: true }); // gateway lookup
transactionSchema.index({ wallet: 1, createdAt: -1 }); // per-wallet history (primary read path)
transactionSchema.index({ counterpartyWallet: 1 }, { sparse: true }); // reverse-side lookup
transactionSchema.index({ shift: 1 }, { sparse: true }); // all txns for a shift
transactionSchema.index({ dva: 1 }, { sparse: true }); // all txns for a DVA
transactionSchema.index({ dispute: 1 }, { sparse: true }); // all txns for a dispute
transactionSchema.index({ relatedTransaction: 1 }, { sparse: true }); // follow the link
transactionSchema.index({ type: 1, status: 1 }); // cron job filters
transactionSchema.index({ createdAt: -1 }); // global audit / admin view

module.exports = mongoose.model("Transaction", transactionSchema);
