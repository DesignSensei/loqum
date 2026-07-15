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
 * MONEY STORAGE:
 *
 * All monetary values are stored in minor units using a factor of 100.
 * Example: ₦1,000.00 is stored as 100000.
 *
 * Transaction amount is always positive.
 * Direction explains whether the wallet was credited or debited.
 *
 * Example:
 * - direction: "credit", amount: 500000 means wallet received ₦5,000.00.
 * - direction: "debit", amount: 500000 means wallet paid out ₦5,000.00.
 *
 * balanceDelta can be positive or negative because it records how the wallet changed.
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
 * There is no professional-side commission deduction at launch.
 *
 * SETTLEMENT:
 * Escrow releases professional pay to professional wallet.
 * Escrow releases Loqum platform fee to platform wallet.
 *
 * Wallet balance changes must always be backed by Transaction records.
 */

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

const isSignedInteger = (value) => Number.isInteger(value);

const balanceSnapshotSchema = new mongoose.Schema(
  {
    availableBalance: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: "Available balance snapshot must be a non-negative integer.",
      },
    },

    pendingBalance: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: "Pending balance snapshot must be a non-negative integer.",
      },
    },

    outstandingBalance: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: "Outstanding balance snapshot must be a non-negative integer.",
      },
    },
  },
  { _id: false }
);

const balanceDeltaSchema = new mongoose.Schema(
  {
    availableBalance: {
      type: Number,
      default: 0,
      validate: {
        validator: isSignedInteger,
        message: "Available balance delta must be an integer.",
      },
    },

    pendingBalance: {
      type: Number,
      default: 0,
      validate: {
        validator: isSignedInteger,
        message: "Pending balance delta must be an integer.",
      },
    },

    outstandingBalance: {
      type: Number,
      default: 0,
      validate: {
        validator: isSignedInteger,
        message: "Outstanding balance delta must be an integer.",
      },
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
    },

    groupReference: {
      type: String,
      trim: true,
      default: null,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
    },

    // --- EXTERNAL PROVIDER REFERENCES ---

    paystackReference: {
      type: String,
      trim: true,
      default: null,
    },

    paystackTransferCode: {
      type: String,
      trim: true,
      default: null,
    },

    providerEventId: {
      type: String,
      trim: true,
      default: null,
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
        "wallet_funding",
        "shift_funding",
        "shift_topup",
        "shift_refund",
        "professional_payout",
        "platform_fee",
        "outstanding_charge",
        "outstanding_settlement",
        "withdrawal",
        "withdrawal_reversal",
        "dispute_refund",
        "cancellation_fee",
        "penalty_debit",
        "adjustment",
        "credit_purchase",
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
    },

    // --- DIRECTION ---

    direction: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },

    // --- WALLET ---

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
    },

    counterpartyWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null,
    },

    // --- AMOUNTS ---
    // Stored in minor units using a factor of 100.

    amount: {
      type: Number,
      required: true,
      validate: {
        validator: isPositiveInteger,
        message: "Transaction amount must be a positive integer minor-unit amount.",
      },
    },

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

    providerFee: {
      type: Number,
      default: 0,
      required: true,
      validate: {
        validator: isNonNegativeInteger,
        message: "Provider fee must be a non-negative integer minor-unit amount.",
      },
    },

    netAmount: {
      type: Number,
      required: true,
      validate: {
        validator: isNonNegativeInteger,
        message: "Net amount must be a non-negative integer minor-unit amount.",
      },
    },

    // --- BALANCE SNAPSHOT ---

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
    },

    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },

    dispute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Dispute",
      default: null,
    },

    relatedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
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
    },

    // --- EXTERNAL PAYMENT STATUS ---

    paystackStatus: {
      type: String,
      enum: ["pending", "success", "failed", "reversed", null],
      default: null,
    },

    // --- INTERNAL STATUS ---

    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "reversed", "cancelled"],
      default: "pending",
      required: true,
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
      validate: {
        validator: isNonNegativeInteger,
        message: "Retry count must be a non-negative integer.",
      },
    },

    // --- INITIATED BY ---

    initiatedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      role: {
        type: String,
        enum: ["system", "employer", "professional", "admin"],
        default: "system",
        required: true,
      },
    },

    // --- METADATA ---

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

transactionSchema.index({ reference: 1 }, { unique: true });

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

transactionSchema.index({ countryCode: 1 });
transactionSchema.index({ currency: 1 });
transactionSchema.index({ countryCode: 1, currency: 1 });
transactionSchema.index({ countryCode: 1, currency: 1, createdAt: -1 });
transactionSchema.index({ type: 1, countryCode: 1, currency: 1, createdAt: -1 });
transactionSchema.index({ wallet: 1, countryCode: 1, currency: 1, createdAt: -1 });

transactionSchema.index({ createdAt: -1 });

// --- VALIDATION ---

transactionSchema.pre("validate", function () {
  if (!this.countryCode) {
    this.countryCode = "NG";
  }

  if (!this.currency) {
    this.currency = "NGN";
  }

  this.countryCode = String(this.countryCode).toUpperCase().trim();
  this.currency = String(this.currency).toUpperCase().trim();

  if (this.netAmount === null || this.netAmount === undefined) {
    this.netAmount = this.amount;
  }

  if (this.providerFee === null || this.providerFee === undefined) {
    this.providerFee = 0;
  }

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
    throw new Error(`${this.type} transaction must reference a shift.`);
  }

  if (this.type === "wallet_funding") {
    if (this.purpose !== "wallet_topup") {
      throw new Error("Wallet funding transaction must have wallet_topup purpose.");
    }

    if (this.paymentRail !== "paystack_dva") {
      throw new Error("Employer wallet funding must use Paystack DVA.");
    }
  }

  if (this.paymentRail === "paystack_dva") {
    if (this.type !== "wallet_funding") {
      throw new Error("Paystack DVA can only be used for wallet funding.");
    }

    if (this.purpose !== "wallet_topup") {
      throw new Error("Paystack DVA transactions must have wallet_topup purpose.");
    }

    if (!this.dva) {
      throw new Error("Paystack DVA wallet funding transaction must reference a DVA.");
    }
  }

  if (this.dva && this.paymentRail !== "paystack_dva") {
    throw new Error("DVA should only be linked to Paystack DVA wallet funding.");
  }

  if (["shift_funding", "shift_topup"].includes(this.type)) {
    const allowedShiftFundingRails = ["wallet_balance", "paystack_checkout"];

    if (!allowedShiftFundingRails.includes(this.paymentRail)) {
      throw new Error(`${this.type} must be funded through wallet balance or Paystack Checkout.`);
    }
  }

  if (
    this.paymentRail === "wallet_balance" ||
    this.paymentRail === "internal_transfer" ||
    this.paymentRail === "platform_wallet"
  ) {
    if (!this.counterpartyWallet) {
      throw new Error(`${this.paymentRail} transaction must reference a counterparty wallet.`);
    }
  }

  if (this.paymentRail === "paystack_checkout") {
    if (this.type === "wallet_funding") {
      throw new Error(
        "Paystack Checkout should not be used for employer wallet funding in the MVP."
      );
    }

    if (this.provider !== "paystack") {
      throw new Error("Paystack Checkout transaction must have paystack as provider.");
    }
  }

  if (this.paymentRail === "paystack_dva" && this.provider !== "paystack") {
    throw new Error("Paystack DVA transaction must have paystack as provider.");
  }

  if (
    ["paystack_checkout", "paystack_dva"].includes(this.paymentRail) &&
    this.status === "completed" &&
    !this.paystackReference
  ) {
    throw new Error(`${this.paymentRail} transaction must reference Paystack payment.`);
  }

  if (this.type === "withdrawal") {
    if (this.purpose !== "withdrawal") {
      throw new Error("Withdrawal transaction must have withdrawal purpose.");
    }

    if (this.direction !== "debit") {
      throw new Error("Withdrawal transaction must be a debit.");
    }

    if (this.paymentRail !== "paystack_transfer") {
      throw new Error("Withdrawal transaction must use Paystack Transfer.");
    }

    if (this.provider !== "paystack") {
      throw new Error("Withdrawal transaction must have paystack as provider.");
    }

    if (!this.bankAccount) {
      throw new Error("Withdrawal transaction must reference a bank account.");
    }
  }

  if (this.type === "withdrawal_reversal") {
    if (this.purpose !== "withdrawal_reversal") {
      throw new Error("Withdrawal reversal transaction must have withdrawal_reversal purpose.");
    }

    if (this.direction !== "credit") {
      throw new Error("Withdrawal reversal transaction must be a credit.");
    }

    if (this.paymentRail !== "system_action") {
      throw new Error("Withdrawal reversal transaction must use system_action payment rail.");
    }

    if (this.provider !== "internal") {
      throw new Error("Withdrawal reversal transaction must have internal as provider.");
    }

    if (!this.bankAccount) {
      throw new Error("Withdrawal reversal transaction must reference a bank account.");
    }

    if (!this.relatedTransaction) {
      throw new Error("Withdrawal reversal transaction must reference the original withdrawal.");
    }
  }

  if (this.paymentRail === "paystack_transfer" && this.type !== "withdrawal") {
    throw new Error("Paystack Transfer should only be used for external bank withdrawals.");
  }

  if (this.providerFee > this.amount) {
    throw new Error("Provider fee cannot be greater than transaction amount.");
  }

  if (this.netAmount > this.amount) {
    throw new Error("Net amount cannot be greater than transaction amount.");
  }

  const balanceFields = ["availableBalance", "pendingBalance", "outstandingBalance"];

  if (this.balanceBefore && this.balanceAfter && this.balanceDelta) {
    for (const field of balanceFields) {
      const before = Number(this.balanceBefore[field] ?? 0);
      const delta = Number(this.balanceDelta[field] ?? 0);
      const after = Number(this.balanceAfter[field] ?? 0);

      const expectedAfter = before + delta;

      if (after !== expectedAfter) {
        throw new Error(
          `Invalid balanceDelta for ${field}. Expected balanceAfter.${field} to be ${expectedAfter}.`
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

  if (this.status === "failed") {
    if (!this.failedAt) {
      this.failedAt = new Date();
    }

    if (!this.failureReason) {
      this.failureReason = "Transaction failed.";
    }
  }

  if (this.status !== "failed") {
    this.failedAt = null;
    this.failureReason = null;
  }

  if (this.status === "reversed") {
    if (!this.reversedAt) {
      this.reversedAt = new Date();
    }

    if (!this.reversalReason) {
      this.reversalReason = "Transaction reversed.";
    }
  }

  if (this.status !== "reversed") {
    this.reversedAt = null;
    this.reversalReason = null;
  }
});

module.exports = mongoose.model("Transaction", transactionSchema);
