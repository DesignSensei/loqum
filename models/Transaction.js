// models/Transaction.js

const mongoose = require("mongoose");

/**
 * TRANSACTION ARCHITECTURE:
 *
 * Wallet ledger entries with paired internal transactions.
 *
 * One Transaction document represents one wallet-side movement.
 *
 * Internal wallet-to-wallet transfers must create paired Transaction documents:
 * 1. One debit entry.
 * 2. One credit entry.
 *
 * Both entries should share a groupReference and be linked through
 * relatedTransaction.
 *
 * Example:
 * Employer funds a shift using wallet balance:
 * 1. Employer wallet is debited.
 * 2. Escrow wallet is credited.
 *
 * The service layer must write paired internal entries atomically using a
 * MongoDB session.
 *
 * CURRENT EMPLOYER WALLET TOP-UP FLOW:
 *
 * Employers top up their wallet through their Paystack DVA.
 * Each employer receives a dedicated virtual account during onboarding.
 * When the employer transfers money to that DVA, Paystack confirms the deposit,
 * and Loqum credits the employer wallet.
 *
 * DVA:
 * DVA is an inbound rail for employer wallet funding only.
 * DVA should not directly fund a shift.
 * DVA should not directly credit escrow.
 *
 * CURRENT SHIFT FUNDING OPTIONS:
 *
 * Employers can confirm a selected shift through:
 * 1. Fund with Wallet
 * 2. Pay with Paystack
 *
 * FUND WITH WALLET:
 * Employer wallet availableBalance is debited.
 * Escrow wallet availableBalance is credited.
 *
 * PAY WITH PAYSTACK:
 * Employer pays for a specific shift through Paystack Checkout.
 * When Paystack confirms payment, Loqum credits the escrow wallet directly
 * for that shift.
 *
 * This does not become employer available wallet balance first.
 *
 * PLATFORM FEE:
 * Loqum's fee is employer-side.
 * There is no pharmacist-side commission deduction at launch.
 *
 * SETTLEMENT:
 * Escrow releases professional pay to professional wallet.
 * Escrow releases Loqum platform fee to platform wallet.
 *
 * Wallet balance changes must always be backed by Transaction records.
 */

const balanceSnapshotSchema = new mongoose.Schema(
  {
    availableBalance: {
      type: Number,
      required: true,
      min: 0,
    },

    pendingBalance: {
      type: Number,
      required: true,
      min: 0,
    },

    outstandingBalance: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const balanceDeltaSchema = new mongoose.Schema(
  {
    availableBalance: {
      type: Number,
      default: 0,
    },

    pendingBalance: {
      type: Number,
      default: 0,
    },

    outstandingBalance: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const transactionSchema = new mongoose.Schema(
  {
    // --- REFERENCE ---

    reference: {
      type: String,
      required: true,
      trim: true,
      // e.g. TXN-20260602-xxxxxx.
      // Generated in service layer before insert.
    },

    groupReference: {
      type: String,
      trim: true,
      default: null,
      // Links multiple transactions from one larger event.
      // Example: one shift settlement may create escrow debit,
      // professional wallet credit, and platform wallet credit records.
    },

    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      // Used to prevent duplicate processing of the same webhook,
      // payout retry, admin action, or internal transfer.
    },

    // --- EXTERNAL PROVIDER REFERENCES ---

    paystackReference: {
      type: String,
      trim: true,
      default: null,
      // Present for Paystack Checkout payments, DVA deposits,
      // or reversal-related Paystack records.
    },

    paystackTransferCode: {
      type: String,
      trim: true,
      default: null,
      // Useful for withdrawals sent through Paystack Transfer.
    },

    providerEventId: {
      type: String,
      trim: true,
      default: null,
      // Webhook event id where available.
      // Helps prevent duplicate webhook processing.
    },

    provider: {
      type: String,
      enum: ["paystack", "internal", "manual", null],
      default: null,
    },

    // --- TYPE ---

    type: {
      type: String,
      required: true,
      enum: [
        // --- WALLET FUNDING ---
        "wallet_funding",
        // Employer wallet top-up.
        // For MVP, this should come through Paystack DVA only.

        // --- SHIFT FUNDING ---
        "shift_funding",
        // Used when a shift is funded.
        // Fund with Wallet: employer wallet debited, escrow wallet credited.
        // Pay with Paystack: escrow wallet credited after Paystack confirms payment.

        "shift_topup",
        // Extra funding for approved overtime.
        // Can come from employer wallet balance or Paystack Checkout.

        "shift_refund",
        // Escrow debited, employer wallet credited after cancellation or proration.

        // --- PROFESSIONAL PAYOUT ---
        "professional_payout",
        // Escrow debited, professional wallet credited.

        // --- PLATFORM REVENUE ---
        "platform_fee",
        // Escrow debited, platform wallet credited.

        // --- OBLIGATIONS ---
        "outstanding_charge",
        // Employer outstandingBalance increased.
        // Example: approved overtime top-up not yet funded.

        "outstanding_settlement",
        // Employer outstandingBalance reduced after funding an obligation.

        // --- WITHDRAWALS ---
        "withdrawal",
        // Wallet debited for transfer to linked bank account.

        "withdrawal_reversal",
        // Failed withdrawal swept back to wallet.

        // --- DISPUTES / ADMIN ---
        "dispute_refund",
        // Dispute resolved and funds returned to the entitled party.

        "cancellation_fee",
        // Cancellation fee charged or moved.

        "penalty_debit",
        // Platform-imposed penalty.

        "adjustment",
        // Manual correction by Loqum admin.

        // --- FUTURE CREDITS ---
        "credit_purchase",
        // Future use if professionals can buy Credits.
      ],
    },

    purpose: {
      type: String,
      enum: [
        "wallet_topup",
        "shift_base_funding",
        "shift_overtime_topup",
        "shift_refund",
        "base_professional_payout",
        "overtime_professional_payout",
        "base_platform_fee",
        "overtime_platform_fee",
        "withdrawal",
        "withdrawal_reversal",
        "cancellation_fee",
        "dispute_resolution",
        "admin_adjustment",
        "credit_purchase",
        null,
      ],
      default: null,
      // More specific reason for the transaction.
      // type tells what kind of ledger event this is.
      // purpose tells why it happened.
    },

    // --- DIRECTION ---

    direction: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
      // credit means this wallet-side entry increases value or reduces an obligation.
      // debit means this wallet-side entry removes value or increases an obligation.
      // balanceDelta gives the exact field-level movement.
    },

    // --- WALLET ---

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      // The wallet this ledger entry belongs to.
    },

    counterpartyWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null,
      // The other side of an internal wallet-to-wallet transfer.
      // Null for external inflows such as Paystack Checkout or DVA wallet top-up.
    },

    // --- AMOUNTS ---

    amount: {
      type: Number,
      required: true,
      min: [0.01, "Transaction amount must be greater than zero."],
    },

    currency: {
      type: String,
      enum: ["NGN"],
      default: "NGN",
    },

    providerFee: {
      type: Number,
      default: 0,
      min: 0,
      // Optional payment provider fee where applicable.
    },

    netAmount: {
      type: Number,
      default: null,
      min: 0,
      // Optional. Useful if provider fees are deducted.
    },

    // --- BALANCE SNAPSHOT ---
    // Full wallet state captured at write time for audit.

    balanceBefore: {
      type: balanceSnapshotSchema,
      required: true,
    },

    balanceAfter: {
      type: balanceSnapshotSchema,
      required: true,
    },

    balanceDelta: {
      type: balanceDeltaSchema,
      default: () => ({}),
      // Exact movement applied to wallet balances.
      // Example:
      // availableBalance: -53750
    },

    // --- LINKED RECORDS ---

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    shiftApplication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftApplication",
      default: null,
    },

    dva: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DVA",
      default: null,
      // Populated only for DVA-related employer wallet funding.
    },

    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
      // Populated for withdrawals and withdrawal reversals.
    },

    dispute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Dispute",
      default: null,
      // Populated for dispute-related records.
    },

    relatedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Cross-links paired internal transfer entries,
      // or links a refund/reversal back to its originating transaction.
    },

    // --- PAYMENT RAIL ---

    paymentRail: {
      type: String,
      enum: [
        "wallet_balance",
        "paystack_checkout",
        "paystack_dva",
        "paystack_transfer",
        "internal_transfer",
        "platform_wallet",
        "admin_action",
        "system_action",
        null,
      ],
      default: null,
      // How this transaction was funded or triggered.
      //
      // wallet_balance:
      // Employer wallet funds a shift or approved top-up obligation.
      //
      // paystack_checkout:
      // Paystack Checkout funds a specific shift directly,
      // or a future professional Credit purchase.
      // It should not be used for employer wallet top-up in the MVP.
      //
      // paystack_dva:
      // Paystack DVA funds employer wallet top-up only.
      //
      // paystack_transfer:
      // Paystack Transfer sends withdrawal to a bank account.
      //
      // internal_transfer:
      // Wallet-to-wallet movement inside Loqum.
    },

    // --- EXTERNAL PAYMENT STATUS ---

    paystackStatus: {
      type: String,
      enum: ["pending", "success", "failed", "reversed", null],
      default: null,
      // Tracks Paystack's status independently of internal transaction status.
    },

    // --- INTERNAL STATUS ---

    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "reversed", "cancelled"],
      default: "pending",
    },

    completedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    reversedAt: {
      type: Date,
      default: null,
    },

    reversalReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // --- INITIATED BY ---

    initiatedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
        // Null when system, cron, or webhook triggered.
      },

      role: {
        type: String,
        enum: ["system", "employer", "professional", "admin"],
        required: true,
      },
    },

    // --- METADATA ---

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
      // Human-readable explanation.
      // Example: "Platform fee for shift LQM-8821"
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      // Paystack webhook payloads, proration breakdowns,
      // shift hours/rates, settlement calculation, admin notes, etc.
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

transactionSchema.index({ reference: 1 }, { unique: true });

// Unique nullable fields should use partial indexes.
// This avoids duplicate key errors for many documents with null values.

transactionSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
  }
);

transactionSchema.index(
  { providerEventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerEventId: { $type: "string" },
    },
  }
);

transactionSchema.index(
  { paystackReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paystackReference: { $type: "string" },
    },
  }
);

transactionSchema.index(
  { paystackTransferCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paystackTransferCode: { $type: "string" },
    },
  }
);

transactionSchema.index({ wallet: 1, createdAt: -1 });
transactionSchema.index({ counterpartyWallet: 1 }, { sparse: true });

transactionSchema.index({ groupReference: 1 }, { sparse: true });
transactionSchema.index({ relatedTransaction: 1 }, { sparse: true });

transactionSchema.index({ shift: 1 }, { sparse: true });
transactionSchema.index({ shiftApplication: 1 }, { sparse: true });
transactionSchema.index({ dva: 1 }, { sparse: true });
transactionSchema.index({ bankAccount: 1 }, { sparse: true });
transactionSchema.index({ dispute: 1 }, { sparse: true });

transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ purpose: 1, status: 1 });
transactionSchema.index({ paymentRail: 1, status: 1 });

transactionSchema.index({ createdAt: -1 });

// --- VALIDATION ---

transactionSchema.pre("validate", function (next) {
  const shiftRelatedTypes = [
    "shift_funding",
    "shift_topup",
    "shift_refund",
    "professional_payout",
    "platform_fee",
    "outstanding_charge",
    "outstanding_settlement",
    "dispute_refund",
    "cancellation_fee",
  ];

  if (shiftRelatedTypes.includes(this.type) && !this.shift) {
    return next(new Error(`${this.type} transaction must reference a shift.`));
  }

  if (this.type === "wallet_funding") {
    if (this.purpose !== "wallet_topup") {
      return next(new Error("Wallet funding transaction must have wallet_topup purpose."));
    }

    if (this.paymentRail !== "paystack_dva") {
      return next(new Error("Employer wallet funding must use Paystack DVA."));
    }
  }

  if (this.paymentRail === "paystack_dva") {
    if (this.type !== "wallet_funding") {
      return next(new Error("Paystack DVA can only be used for wallet funding."));
    }

    if (this.purpose !== "wallet_topup") {
      return next(new Error("Paystack DVA transactions must have wallet_topup purpose."));
    }

    if (!this.dva) {
      return next(new Error("Paystack DVA wallet funding transaction must reference a DVA."));
    }
  }

  if (this.dva && this.paymentRail !== "paystack_dva") {
    return next(new Error("DVA should only be linked to Paystack DVA wallet funding."));
  }

  if (["shift_funding", "shift_topup"].includes(this.type)) {
    const allowedShiftFundingRails = ["wallet_balance", "paystack_checkout"];

    if (!allowedShiftFundingRails.includes(this.paymentRail)) {
      return next(
        new Error(`${this.type} must be funded through wallet balance or Paystack Checkout.`)
      );
    }
  }

  if (
    this.paymentRail === "wallet_balance" ||
    this.paymentRail === "internal_transfer" ||
    this.paymentRail === "platform_wallet"
  ) {
    if (!this.counterpartyWallet) {
      return next(
        new Error(`${this.paymentRail} transaction must reference a counterparty wallet.`)
      );
    }
  }

  if (this.paymentRail === "paystack_checkout") {
    if (this.type === "wallet_funding") {
      return next(
        new Error("Paystack Checkout should not be used for employer wallet funding in the MVP.")
      );
    }

    if (this.provider !== "paystack") {
      return next(new Error("Paystack Checkout transaction must have paystack as provider."));
    }
  }

  if (this.paymentRail === "paystack_dva" && this.provider !== "paystack") {
    return next(new Error("Paystack DVA transaction must have paystack as provider."));
  }

  if (
    ["paystack_checkout", "paystack_dva"].includes(this.paymentRail) &&
    this.status === "completed" &&
    !this.paystackReference
  ) {
    return next(new Error(`${this.paymentRail} transaction must reference Paystack payment.`));
  }

  if (this.paymentRail === "paystack_transfer") {
    if (this.type !== "withdrawal") {
      return next(new Error("Paystack Transfer should only be used for withdrawals."));
    }

    if (!this.bankAccount) {
      return next(new Error("Paystack Transfer withdrawal must reference a bank account."));
    }
  }

  if (["withdrawal", "withdrawal_reversal"].includes(this.type) && !this.bankAccount) {
    return next(new Error(`${this.type} transaction must reference a bank account.`));
  }

  const balanceFields = ["availableBalance", "pendingBalance", "outstandingBalance"];

  if (this.balanceBefore && this.balanceAfter && this.balanceDelta) {
    for (const field of balanceFields) {
      const before = Number(this.balanceBefore[field] || 0);
      const delta = Number(this.balanceDelta[field] || 0);
      const after = Number(this.balanceAfter[field] || 0);

      const expectedAfter = before + delta;
      const difference = Math.abs(after - expectedAfter);

      if (difference > 0.001) {
        return next(
          new Error(
            `Invalid balanceDelta for ${field}. Expected balanceAfter.${field} to be ${expectedAfter}.`
          )
        );
      }
    }
  }

  if (this.status === "completed" && !this.completedAt) {
    this.completedAt = new Date();
  }

  if (this.status !== "completed") {
    this.completedAt = null;
  }

  if (this.status === "failed" && !this.failedAt) {
    this.failedAt = new Date();
  }

  if (this.status !== "failed") {
    this.failedAt = null;
    this.failureReason = null;
  }

  if (this.status === "reversed" && !this.reversedAt) {
    this.reversedAt = new Date();
  }

  if (this.status !== "reversed") {
    this.reversedAt = null;
    this.reversalReason = null;
  }

  next();
});

module.exports = mongoose.model("Transaction", transactionSchema);
