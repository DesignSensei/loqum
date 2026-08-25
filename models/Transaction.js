// models/Transaction.js

const mongoose = require("mongoose");

const {
  TRANSACTION_TYPES,
  TRANSACTION_PURPOSES,
  TRANSACTION_STATUSES,
  TRANSACTION_PROVIDERS,
  TRANSACTION_DIRECTIONS,
  TRANSACTION_PAYMENT_RAILS,
  PAYSTACK_TRANSACTION_STATUSES,
  TRANSACTION_INITIATOR_ROLES,

  DIRECT_SHIFT_TRANSACTION_TYPES,
  SHIFT_FUNDING_TRANSACTION_TYPES,
  SETTLEMENT_BATCH_TRANSACTION_TYPES,
  EMPLOYER_REFUND_BATCH_TRANSACTION_TYPES,
  ASSIGNMENT_CASE_ALLOWED_TRANSACTION_TYPES,

  INTERNAL_PAYMENT_RAILS,
  PAYSTACK_PAYMENT_RAILS,
  PAYSTACK_PAYMENT_REFERENCE_RAILS,
  SHIFT_FUNDING_PAYMENT_RAILS,
  SHIFT_REFUND_PAYMENT_RAILS,
  EMPLOYER_REFUND_BATCH_PAYMENT_RAILS,
  PAYSTACK_TRANSFER_ALLOWED_TRANSACTION_TYPES,

  PLATFORM_FEE_PURPOSES,
  PLATFORM_FEE_PAYMENT_RAILS,

  OCCURRENCE_REFUND_PURPOSES,
  SHIFT_LEVEL_REFUND_PURPOSES,
  DIRECT_SHIFT_REFUND_PURPOSES,
  EMPLOYER_REFUND_BATCH_PURPOSES,
  SHIFT_REFUND_PURPOSES,

  REQUIRED_PURPOSE_BY_TRANSACTION_TYPE,
  SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE,
  SETTLEMENT_BATCH_PURPOSES,
  EMPLOYER_REFUND_BATCH_PURPOSE_BY_TRANSACTION_TYPE,

  MAX_TRANSACTION_FAILURE_REASON_LENGTH,
  MAX_TRANSACTION_REVERSAL_REASON_LENGTH,
  MAX_TRANSACTION_CANCELLATION_REASON_LENGTH,
  MAX_TRANSACTION_DESCRIPTION_LENGTH,
} = require("../constants/transaction");

const {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isSignedSafeInteger,
  sameId,
} = require("./helpers/schemaValidators");

/**
 * TRANSACTION ARCHITECTURE
 *
 * One Transaction represents one wallet-side ledger movement.
 *
 * INTERNAL WALLET MOVEMENTS
 *
 * A transfer between two Loqum wallets creates two Transaction records:
 *
 * 1. Debit on the source wallet.
 * 2. Credit on the destination wallet.
 *
 * Both records:
 *
 * - share groupReference;
 * - identify the opposite wallet through counterpartyWallet; and
 * - point to each other through relatedTransaction.
 *
 * EXTERNAL PROVIDER MOVEMENTS
 *
 * External provider movements are one-sided inside Loqum's wallet ledger:
 *
 * - Paystack DVA credits the employer wallet.
 * - Paystack Checkout credits escrow for one Shift.
 * - Paystack Refund debits escrow when Paystack returns protected funds.
 * - Paystack Transfer is represented before provider submission as a durable
 *   external-transfer instruction, but it must not reduce the linked wallet's
 *   total recorded balance until the transfer is conclusively successful.
 *
 * PAYSTACK TRANSFER SAFETY
 *
 * A Paystack Transfer may be created in pending/processing state before the
 * provider call so Loqum can persist:
 *
 * - a deterministic provider transfer reference;
 * - the exact wallet/bank-account/batch relationship; and
 * - the idempotency boundary needed for reconciliation.
 *
 * While the transfer remains pending/processing, its cumulative balance delta
 * must have zero net effect on the wallet. A service may optionally reserve
 * value between availableBalance and pendingBalance, but it must not consume
 * wallet value before provider success.
 *
 * Only a completed Paystack Transfer may have a cumulative net wallet debit
 * equal to amount.
 *
 * MONEY STORAGE
 *
 * All monetary values are stored in minor units.
 *
 * amount is always positive.
 * direction determines whether the linked wallet is credited or debited.
 * balanceDelta records the exact movement against that wallet.
 *
 * SHIFT FUNDING
 *
 * A Shift may be funded through:
 *
 * 1. Employer wallet balance.
 * 2. Paystack Checkout for that Shift.
 *
 * Wallet funding creates paired employer-wallet and escrow transactions.
 * Paystack Checkout creates one external-provider escrow credit.
 *
 * PROFESSIONAL SETTLEMENT
 *
 * ShiftSettlementBatch is the authoritative allocation record for weekly
 * professional pay only.
 *
 * Platform fees do not belong to ShiftSettlementBatch. They are earned and
 * collected directly against the exact ShiftOccurrence that created the fee.
 *
 * PLATFORM FEES
 *
 * A base platform fee is earned when a professional is successfully confirmed
 * for the occurrence.
 *
 * An overtime platform fee is earned only after the final payable overtime
 * obligation is established.
 *
 * Both use direct Shift + ShiftOccurrence links and internal wallet transfers
 * from escrow to the platform wallet.
 *
 * EMPLOYER REFUNDS
 *
 * Direct refunds reference one Shift and may reference one ShiftOccurrence.
 *
 * Weekly employer refunds reference:
 *
 * - EmployerRefundBatch; and
 * - the exact embedded EmployerRefundBatch line.
 *
 * The batch line remains authoritative for the individual EmployerRefund
 * allocations behind an aggregated financial movement.
 */

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function hasAnyNonZeroBalanceDelta(balanceDelta) {
  if (!balanceDelta) {
    return false;
  }

  return [
    balanceDelta.availableBalance,
    balanceDelta.pendingBalance,
    balanceDelta.outstandingBalance,
  ].some((value) => Number(value || 0) !== 0);
}

function getNetBalanceDelta(balanceDelta) {
  if (!balanceDelta) {
    return 0;
  }

  return [
    balanceDelta.availableBalance,
    balanceDelta.pendingBalance,
    balanceDelta.outstandingBalance,
  ].reduce((total, value) => total + Number(value || 0), 0);
}

/* ─────────────────────────────── BALANCE SUB-SCHEMAS ─────────────────────────────── */

const balanceSnapshotSchema = new mongoose.Schema(
  {
    availableBalance: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "Available balance snapshot must be a non-negative whole number.",
      },
    },

    pendingBalance: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "Pending balance snapshot must be a non-negative whole number.",
      },
    },

    outstandingBalance: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "Outstanding balance snapshot must be a non-negative whole number.",
      },
    },
  },
  {
    _id: false,
  }
);

const balanceDeltaSchema = new mongoose.Schema(
  {
    availableBalance: {
      type: Number,
      default: 0,
      validate: {
        validator: isSignedSafeInteger,
        message: "Available balance delta must be a whole number.",
      },
    },

    pendingBalance: {
      type: Number,
      default: 0,
      validate: {
        validator: isSignedSafeInteger,
        message: "Pending balance delta must be a whole number.",
      },
    },

    outstandingBalance: {
      type: Number,
      default: 0,
      validate: {
        validator: isSignedSafeInteger,
        message: "Outstanding balance delta must be a whole number.",
      },
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── TRANSACTION SCHEMA ─────────────────────────────── */

const transactionSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    reference: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    groupReference: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    // --- EXTERNAL PROVIDER REFERENCES ---

    /**
     * Paystack Checkout and DVA:
     * → confirmed payment reference
     *
     * Paystack Refund:
     * → provider refund reference
     *
     * The original Checkout reference for an employer refund remains on the
     * EmployerRefundBatch execution line.
     */
    paystackReference: {
      type: String,
      trim: true,
      default: null,
    },

    /**
     * Paystack Transfer:
     * → Loqum-generated deterministic provider reference.
     *
     * This is deliberately separate from Transaction.reference.
     *
     * Transaction.reference is the Loqum ledger reference and is normalized
     * to uppercase. Paystack Transfer references are provider-facing,
     * lowercase reconciliation keys with a different format contract.
     */
    paystackTransferReference: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 50,
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
      enum: [...TRANSACTION_PROVIDERS, null],
      default: null,
    },

    // --- CLASSIFICATION ---

    type: {
      type: String,
      required: true,
      enum: TRANSACTION_TYPES,
    },

    purpose: {
      type: String,
      enum: [...TRANSACTION_PURPOSES, null],
      default: null,
    },

    direction: {
      type: String,
      enum: TRANSACTION_DIRECTIONS,
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
    // All values are stored in minor units.

    amount: {
      type: Number,
      required: true,
      validate: {
        validator: isPositiveSafeInteger,
        message: "Transaction amount must be a positive whole number in minor units.",
      },
    },

    countryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 2,
      required: true,
      match: [/^[A-Z]{2}$/, "countryCode must contain exactly 2 uppercase letters."],
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      required: true,
      match: [/^[A-Z]{3}$/, "currency must contain exactly 3 uppercase letters."],
    },

    providerFee: {
      type: Number,
      default: 0,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "Provider fee must be a non-negative whole number in minor units.",
      },
    },

    netAmount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "Net amount must be a non-negative whole number in minor units.",
      },
    },

    // --- WALLET BALANCE AUDIT ---

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

    // --- DIRECT SHIFT LINKS ---

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    shiftOccurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    assignmentCase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignmentCase",
      default: null,
    },

    shiftApplication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftApplication",
      default: null,
    },

    // --- PROFESSIONAL SETTLEMENT BATCH ---

    settlementBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftSettlementBatch",
      default: null,
    },

    // --- EMPLOYER REFUND BATCH ---

    employerRefundBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefundBatch",
      default: null,
    },

    /**
     * EmployerRefundBatch.lines is an embedded subdocument array.
     *
     * employerRefundBatchLineId points to the exact execution line whose
     * allocations produced this Transaction.
     */
    employerRefundBatchLineId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // --- OTHER FINANCIAL LINKS ---

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

      /**
       * Internal movement:
       * → exact paired debit or credit
       *
       * Withdrawal reversal:
       * → original withdrawal
       *
       * Paystack refund:
       * → may reference the original Checkout funding transaction
       */
    },

    // --- PAYMENT ROUTE ---

    paymentRail: {
      type: String,
      enum: [...TRANSACTION_PAYMENT_RAILS, null],
      default: null,
    },

    paystackStatus: {
      type: String,
      enum: [...PAYSTACK_TRANSACTION_STATUSES, null],
      default: null,
    },

    // --- INTERNAL STATUS ---

    status: {
      type: String,
      enum: TRANSACTION_STATUSES,
      default: "pending",
      required: true,
    },

    processingStartedAt: {
      type: Date,
      default: null,
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
      maxlength: MAX_TRANSACTION_FAILURE_REASON_LENGTH,
      default: null,
    },

    reversedAt: {
      type: Date,
      default: null,
    },

    reversalReason: {
      type: String,
      trim: true,
      maxlength: MAX_TRANSACTION_REVERSAL_REASON_LENGTH,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: MAX_TRANSACTION_CANCELLATION_REASON_LENGTH,
      default: null,
    },

    retryCount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "Retry count must be a non-negative whole number.",
      },
    },

    // --- INITIATOR ---

    initiatedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      role: {
        type: String,
        enum: TRANSACTION_INITIATOR_ROLES,
        default: "system",
        required: true,
      },
    },

    // --- DISPLAY AND PROVIDER METADATA ---

    description: {
      type: String,
      trim: true,
      maxlength: MAX_TRANSACTION_DESCRIPTION_LENGTH,
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

/* ─────────────────────────────── MODEL VALIDATION ─────────────────────────────── */

transactionSchema.pre("validate", function validateTransaction() {
  const now = new Date();

  // --- DEFAULT NORMALIZATION ---

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

  const isInternalWalletMovement = INTERNAL_PAYMENT_RAILS.includes(this.paymentRail);

  const isPaystackMovement = PAYSTACK_PAYMENT_RAILS.includes(this.paymentRail);

  const hasSettlementBatch = Boolean(this.settlementBatch);

  const hasEmployerRefundBatch = Boolean(this.employerRefundBatch);

  const hasEmployerRefundBatchLine = Boolean(this.employerRefundBatchLineId);

  const isEmployerRefundBatchTransaction =
    hasEmployerRefundBatch && EMPLOYER_REFUND_BATCH_TRANSACTION_TYPES.includes(this.type);

  const isDirectShiftRefund = this.type === "shift_refund" && !hasEmployerRefundBatch;

  const isBatchShiftRefund = this.type === "shift_refund" && hasEmployerRefundBatch;

  // --- BATCH LINK EXCLUSIVITY ---

  if (hasSettlementBatch && hasEmployerRefundBatch) {
    this.invalidate(
      "employerRefundBatch",
      "A Transaction cannot belong to both a professional settlement batch and an employer refund batch."
    );
  }

  if (hasEmployerRefundBatch !== hasEmployerRefundBatchLine) {
    this.invalidate(
      "employerRefundBatchLineId",
      "employerRefundBatch and employerRefundBatchLineId must be recorded together."
    );
  }

  // --- DIRECT SHIFT LINKS ---

  if (DIRECT_SHIFT_TRANSACTION_TYPES.includes(this.type) && !this.shift) {
    this.invalidate("shift", `${this.type} transaction must reference a Shift.`);
  }

  if (this.shiftOccurrence && !this.shift) {
    this.invalidate(
      "shiftOccurrence",
      "shiftOccurrence cannot be linked without its parent Shift."
    );
  }

  if (this.assignmentCase && !this.shift) {
    this.invalidate("assignmentCase", "assignmentCase cannot be linked without its parent Shift.");
  }

  if (this.shiftApplication && !this.shift) {
    this.invalidate(
      "shiftApplication",
      "shiftApplication cannot be linked without its parent Shift."
    );
  }

  // --- PROFESSIONAL SETTLEMENT BATCH ---

  if (hasSettlementBatch && !SETTLEMENT_BATCH_TRANSACTION_TYPES.includes(this.type)) {
    this.invalidate(
      "settlementBatch",
      "settlementBatch may only be linked to a professional payout Transaction."
    );
  }

  if (hasSettlementBatch) {
    if (this.shift) {
      this.invalidate(
        "shift",
        "A professional settlement-batch Transaction cannot reference one Shift because the batch may contain several Shifts."
      );
    }

    if (this.shiftOccurrence) {
      this.invalidate(
        "shiftOccurrence",
        "A professional settlement-batch Transaction cannot reference one occurrence."
      );
    }

    if (this.assignmentCase) {
      this.invalidate(
        "assignmentCase",
        "A professional settlement-batch Transaction cannot reference one assignment case."
      );
    }

    if (this.shiftApplication) {
      this.invalidate(
        "shiftApplication",
        "A professional settlement-batch Transaction cannot reference one Shift application."
      );
    }

    const requiredBatchPurpose = SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE[this.type];

    if (this.purpose !== requiredBatchPurpose) {
      this.invalidate(
        "purpose",
        `${this.type} settlement-batch Transaction must have ${requiredBatchPurpose} purpose.`
      );
    }

    if (this.paymentRail !== "internal_transfer") {
      this.invalidate(
        "paymentRail",
        "Professional settlement-batch wallet movements must use internal_transfer."
      );
    }

    if (this.provider !== "internal") {
      this.invalidate(
        "provider",
        "Professional settlement-batch Transactions must use internal provider."
      );
    }
  }

  // --- EMPLOYER REFUND BATCH ---

  if (hasEmployerRefundBatch && !EMPLOYER_REFUND_BATCH_TRANSACTION_TYPES.includes(this.type)) {
    this.invalidate(
      "employerRefundBatch",
      "employerRefundBatch may only be linked to an employer refund Transaction."
    );
  }

  if (hasEmployerRefundBatch) {
    if (!isEmployerRefundBatchTransaction) {
      this.invalidate(
        "type",
        "An employer refund batch Transaction must use a supported employer refund transaction type."
      );
    }

    if (this.shift || this.shiftOccurrence || this.assignmentCase || this.shiftApplication) {
      this.invalidate(
        "employerRefundBatch",
        "An employer refund batch Transaction cannot reference one Shift, occurrence, assignment case or Shift application."
      );
    }

    const requiredBatchPurpose = EMPLOYER_REFUND_BATCH_PURPOSE_BY_TRANSACTION_TYPE[this.type];

    if (this.purpose !== requiredBatchPurpose) {
      this.invalidate(
        "purpose",
        `${this.type} employer-refund-batch Transaction must have ${requiredBatchPurpose} purpose.`
      );
    }

    if (!EMPLOYER_REFUND_BATCH_PAYMENT_RAILS.includes(this.paymentRail)) {
      this.invalidate(
        "paymentRail",
        "An employer refund batch Transaction must use internal_transfer, paystack_refund or paystack_transfer."
      );
    }
  }

  if (hasEmployerRefundBatchLine && !hasEmployerRefundBatch) {
    this.invalidate(
      "employerRefundBatchLineId",
      "employerRefundBatchLineId requires employerRefundBatch."
    );
  }

  // --- PROFESSIONAL SETTLEMENT ---

  if (this.type === "professional_payout" && !hasSettlementBatch) {
    this.invalidate(
      "settlementBatch",
      "A professional payout Transaction must belong to a ShiftSettlementBatch."
    );
  }

  if (SETTLEMENT_BATCH_PURPOSES.includes(this.purpose)) {
    if (this.type !== "professional_payout") {
      this.invalidate(
        "type",
        `${this.purpose} may only be used by a professional_payout Transaction.`
      );
    }

    if (!hasSettlementBatch) {
      this.invalidate("settlementBatch", `${this.purpose} requires a ShiftSettlementBatch.`);
    }
  }

  // --- PLATFORM FEE ---

  if (this.type === "platform_fee") {
    if (hasSettlementBatch) {
      this.invalidate(
        "settlementBatch",
        "Platform-fee Transactions cannot belong to ShiftSettlementBatch."
      );
    }

    if (!this.shift) {
      this.invalidate("shift", "A platform-fee Transaction must reference its Shift.");
    }

    if (!this.shiftOccurrence) {
      this.invalidate(
        "shiftOccurrence",
        "A platform-fee Transaction must reference the exact occurrence whose fee was earned."
      );
    }

    if (!PLATFORM_FEE_PURPOSES.includes(this.purpose)) {
      this.invalidate(
        "purpose",
        "A platform-fee Transaction must use base_platform_fee_earned or overtime_platform_fee_earned."
      );
    }

    if (!PLATFORM_FEE_PAYMENT_RAILS.includes(this.paymentRail)) {
      this.invalidate("paymentRail", "Platform-fee Transactions must use internal_transfer.");
    }

    if (this.provider !== "internal") {
      this.invalidate("provider", "Platform-fee Transactions must use internal provider.");
    }

    if (this.assignmentCase) {
      this.invalidate(
        "assignmentCase",
        "A platform-fee Transaction cannot reference an assignment case."
      );
    }

    if (this.shiftApplication) {
      this.invalidate(
        "shiftApplication",
        "A platform-fee Transaction cannot reference a Shift application."
      );
    }
  }

  if (PLATFORM_FEE_PURPOSES.includes(this.purpose) && this.type !== "platform_fee") {
    this.invalidate("type", `${this.purpose} may only be used by a platform_fee Transaction.`);
  }

  // --- TYPE AND PURPOSE ---

  const requiredPurpose = REQUIRED_PURPOSE_BY_TRANSACTION_TYPE[this.type];

  if (requiredPurpose && this.purpose !== requiredPurpose) {
    this.invalidate("purpose", `${this.type} transaction must have ${requiredPurpose} purpose.`);
  }

  const hasRefundPurpose = SHIFT_REFUND_PURPOSES.includes(this.purpose);

  if (hasRefundPurpose && this.type !== "shift_refund") {
    this.invalidate("type", `${this.purpose} may only be used by a shift_refund Transaction.`);
  }

  // --- DIRECT AND BATCH REFUND PURPOSES ---

  if (EMPLOYER_REFUND_BATCH_PURPOSES.includes(this.purpose) && !hasEmployerRefundBatch) {
    this.invalidate(
      "employerRefundBatch",
      `${this.purpose} requires EmployerRefundBatch and employerRefundBatchLineId.`
    );
  }

  if (DIRECT_SHIFT_REFUND_PURPOSES.includes(this.purpose) && hasEmployerRefundBatch) {
    this.invalidate(
      "purpose",
      "A weekly employer refund batch cannot use a direct Shift refund purpose."
    );
  }

  // --- SHIFT REFUND ---

  if (this.type === "shift_refund") {
    if (!SHIFT_REFUND_PURPOSES.includes(this.purpose)) {
      this.invalidate(
        "purpose",
        "shift_refund must use a supported direct or weekly employer refund purpose."
      );
    }

    if (!SHIFT_REFUND_PAYMENT_RAILS.includes(this.paymentRail)) {
      this.invalidate(
        "paymentRail",
        "shift_refund must use internal_transfer, paystack_refund or paystack_transfer."
      );
    }

    if (isDirectShiftRefund) {
      if (!this.shift) {
        this.invalidate("shift", "A direct Shift refund must reference its Shift.");
      }

      if (!DIRECT_SHIFT_REFUND_PURPOSES.includes(this.purpose)) {
        this.invalidate(
          "purpose",
          "A direct Shift refund must use a direct Shift or occurrence refund purpose."
        );
      }

      if (OCCURRENCE_REFUND_PURPOSES.includes(this.purpose) && !this.shiftOccurrence) {
        this.invalidate(
          "shiftOccurrence",
          `${this.purpose} must reference the occurrence that created the refund.`
        );
      }

      if (SHIFT_LEVEL_REFUND_PURPOSES.includes(this.purpose) && this.shiftOccurrence) {
        this.invalidate(
          "shiftOccurrence",
          `${this.purpose} is a parent-Shift reconciliation and cannot reference one occurrence.`
        );
      }

      if (this.paymentRail === "paystack_transfer") {
        this.invalidate(
          "paymentRail",
          "A Paystack Transfer refund fallback must belong to an EmployerRefundBatch line."
        );
      }
    }

    if (isBatchShiftRefund) {
      if (!EMPLOYER_REFUND_BATCH_PURPOSES.includes(this.purpose)) {
        this.invalidate(
          "purpose",
          "An employer refund batch Transaction must use weekly_employer_refund purpose."
        );
      }
    }
  }

  if (this.assignmentCase && !ASSIGNMENT_CASE_ALLOWED_TRANSACTION_TYPES.includes(this.type)) {
    this.invalidate(
      "assignmentCase",
      "assignmentCase may only trace a refund, dispute refund or cancellation fee."
    );
  }

  // --- DVA WALLET FUNDING ---

  if (this.type === "wallet_funding") {
    if (this.direction !== "credit") {
      this.invalidate("direction", "Employer wallet funding must be a credit Transaction.");
    }

    if (this.paymentRail !== "paystack_dva") {
      this.invalidate("paymentRail", "Employer wallet funding must use Paystack DVA.");
    }
  }

  if (this.paymentRail === "paystack_dva") {
    if (this.type !== "wallet_funding") {
      this.invalidate("type", "Paystack DVA can only be used for wallet funding.");
    }

    if (!this.dva) {
      this.invalidate("dva", "Paystack DVA wallet funding must reference a DVA.");
    }

    if (this.provider !== "paystack") {
      this.invalidate("provider", "Paystack DVA Transaction must use Paystack provider.");
    }
  }

  if (this.dva && this.paymentRail !== "paystack_dva") {
    this.invalidate("dva", "DVA may only be linked to Paystack DVA wallet funding.");
  }

  // --- SHIFT FUNDING AND TOP-UP ---

  if (SHIFT_FUNDING_TRANSACTION_TYPES.includes(this.type)) {
    if (!SHIFT_FUNDING_PAYMENT_RAILS.includes(this.paymentRail)) {
      this.invalidate(
        "paymentRail",
        `${this.type} must be funded through wallet balance or Paystack Checkout.`
      );
    }

    if (this.paymentRail === "paystack_checkout" && this.direction !== "credit") {
      this.invalidate(
        "direction",
        "Paystack Checkout Shift funding must credit the escrow wallet."
      );
    }
  }

  // --- INTERNAL WALLET MOVEMENT ---

  if (isInternalWalletMovement) {
    if (!this.counterpartyWallet) {
      this.invalidate(
        "counterpartyWallet",
        `${this.paymentRail} Transaction must reference a counterparty wallet.`
      );
    }

    if (!this.groupReference) {
      this.invalidate(
        "groupReference",
        `${this.paymentRail} Transaction must share a groupReference with its paired wallet entry.`
      );
    }

    if (this.provider !== "internal") {
      this.invalidate("provider", `${this.paymentRail} Transaction must use internal provider.`);
    }

    if (this.status === "completed" && !this.relatedTransaction) {
      this.invalidate(
        "relatedTransaction",
        "A completed internal wallet movement must reference its exact paired Transaction."
      );
    }

    if (
      this.paystackReference ||
      this.paystackTransferReference ||
      this.paystackTransferCode ||
      this.paystackStatus ||
      this.providerEventId
    ) {
      this.invalidate(
        "provider",
        "Internal wallet movements cannot contain Paystack payment, Transfer or event references."
      );
    }
  }

  if (this.counterpartyWallet && this.wallet && sameId(this.counterpartyWallet, this.wallet)) {
    this.invalidate("counterpartyWallet", "A wallet cannot be its own counterparty.");
  }

  // --- EXTERNAL PAYSTACK MOVEMENT ---

  if (isPaystackMovement && this.counterpartyWallet) {
    this.invalidate(
      "counterpartyWallet",
      "External Paystack movements cannot reference a Loqum counterparty wallet."
    );
  }

  if (isPaystackMovement && this.provider !== "paystack") {
    this.invalidate("provider", `${this.paymentRail} Transaction must use Paystack provider.`);
  }

  // --- PAYSTACK CHECKOUT ---

  if (this.paymentRail === "paystack_checkout") {
    if (this.type === "wallet_funding") {
      this.invalidate("type", "Paystack Checkout cannot be used for employer wallet funding.");
    }
  }

  // --- PAYSTACK REFUND ---

  if (this.paymentRail === "paystack_refund") {
    if (this.type !== "shift_refund") {
      this.invalidate("type", "Paystack Refund may only execute a Shift refund.");
    }

    if (this.direction !== "debit") {
      this.invalidate("direction", "Paystack Refund must debit protected escrow funds.");
    }

    if (this.bankAccount) {
      this.invalidate(
        "bankAccount",
        "Paystack Refund returns money through the original payment route and cannot reference a bank account."
      );
    }

    if (this.paystackTransferCode) {
      this.invalidate(
        "paystackTransferCode",
        "Paystack Refund cannot contain a Paystack Transfer code."
      );
    }

    if (["processing", "completed"].includes(this.status) && !this.paystackReference) {
      this.invalidate(
        "paystackReference",
        "A processing or completed Paystack Refund must reference its provider refund."
      );
    }
  }

  // --- PAYSTACK PAYMENT REFERENCE ---

  if (
    PAYSTACK_PAYMENT_REFERENCE_RAILS.includes(this.paymentRail) &&
    this.status === "completed" &&
    !this.paystackReference
  ) {
    this.invalidate(
      "paystackReference",
      `${this.paymentRail} Transaction must reference the confirmed Paystack operation.`
    );
  }

  if (this.paystackReference && this.provider !== "paystack") {
    this.invalidate(
      "paystackReference",
      "paystackReference may only be set for Paystack Transactions."
    );
  }

  if (this.providerEventId && this.provider !== "paystack") {
    this.invalidate(
      "providerEventId",
      "providerEventId may only be set for Paystack Transactions."
    );
  }

  if (this.paystackStatus && this.provider !== "paystack") {
    this.invalidate("paystackStatus", "paystackStatus may only be set for Paystack Transactions.");
  }

  if (
    this.provider === "paystack" &&
    this.status === "completed" &&
    this.paystackStatus !== "success"
  ) {
    this.invalidate(
      "paystackStatus",
      "A completed Paystack Transaction must have success paystackStatus."
    );
  }

  // --- WITHDRAWAL ---

  if (this.type === "withdrawal") {
    if (this.direction !== "debit") {
      this.invalidate("direction", "Withdrawal Transaction must be a debit.");
    }

    if (this.paymentRail !== "paystack_transfer") {
      this.invalidate("paymentRail", "Withdrawal Transaction must use Paystack Transfer.");
    }

    if (!this.bankAccount) {
      this.invalidate("bankAccount", "Withdrawal Transaction must reference a bank account.");
    }

    if (
      ["processing", "completed", "failed", "reversed"].includes(this.status) &&
      !this.paystackTransferReference
    ) {
      this.invalidate(
        "paystackTransferReference",
        "A started withdrawal must retain its deterministic Paystack Transfer reference for reconciliation."
      );
    }

    if (["completed", "reversed"].includes(this.status) && !this.paystackTransferCode) {
      this.invalidate(
        "paystackTransferCode",
        "A completed or subsequently reversed withdrawal must reference its Paystack Transfer code."
      );
    }
  }

  // --- EMPLOYER REFUND FALLBACK TRANSFER ---

  if (this.type === "shift_refund" && this.paymentRail === "paystack_transfer") {
    if (!hasEmployerRefundBatch) {
      this.invalidate(
        "employerRefundBatch",
        "An employer refund fallback Transfer must reference EmployerRefundBatch and its exact line."
      );
    }

    if (this.purpose !== "weekly_employer_refund") {
      this.invalidate(
        "purpose",
        "An employer refund fallback Transfer must use weekly_employer_refund purpose."
      );
    }

    if (this.direction !== "debit") {
      this.invalidate(
        "direction",
        "An employer refund fallback Transfer must debit protected escrow funds."
      );
    }

    if (!this.bankAccount) {
      this.invalidate(
        "bankAccount",
        "An employer refund fallback Transfer must reference the employer-approved bank account."
      );
    }

    if (
      ["processing", "completed", "failed", "reversed"].includes(this.status) &&
      !this.paystackTransferReference
    ) {
      this.invalidate(
        "paystackTransferReference",
        "A started employer refund fallback Transfer must retain its deterministic Paystack Transfer reference for reconciliation."
      );
    }

    if (["completed", "reversed"].includes(this.status) && !this.paystackTransferCode) {
      this.invalidate(
        "paystackTransferCode",
        "A completed or subsequently reversed employer refund fallback Transfer must reference its Paystack Transfer code."
      );
    }
  }

  // --- WITHDRAWAL REVERSAL ---

  if (this.type === "withdrawal_reversal") {
    if (this.direction !== "credit") {
      this.invalidate("direction", "Withdrawal reversal Transaction must be a credit.");
    }

    if (this.paymentRail !== "system_action") {
      this.invalidate("paymentRail", "Withdrawal reversal Transaction must use system_action.");
    }

    if (this.provider !== "internal") {
      this.invalidate("provider", "Withdrawal reversal must use internal provider.");
    }

    if (!this.bankAccount) {
      this.invalidate("bankAccount", "Withdrawal reversal must reference a bank account.");
    }

    if (!this.relatedTransaction) {
      this.invalidate(
        "relatedTransaction",
        "Withdrawal reversal must reference the original withdrawal."
      );
    }
  }

  // --- PAYSTACK TRANSFER GENERAL RULES ---

  if (
    this.paymentRail === "paystack_transfer" &&
    !PAYSTACK_TRANSFER_ALLOWED_TRANSACTION_TYPES.includes(this.type)
  ) {
    this.invalidate(
      "type",
      "Paystack Transfer may only be used for a withdrawal or approved employer refund fallback."
    );
  }

  if (this.paystackTransferReference && this.paymentRail !== "paystack_transfer") {
    this.invalidate(
      "paystackTransferReference",
      "paystackTransferReference may only be linked to Paystack Transfer Transactions."
    );
  }

  if (this.paystackTransferReference && this.provider !== "paystack") {
    this.invalidate(
      "paystackTransferReference",
      "paystackTransferReference may only be set for Paystack Transactions."
    );
  }

  if (
    this.paystackTransferReference &&
    !/^[a-z0-9_-]{16,50}$/.test(this.paystackTransferReference)
  ) {
    this.invalidate(
      "paystackTransferReference",
      "Paystack Transfer reference must contain 16 to 50 lowercase letters, digits, hyphens or underscores."
    );
  }

  if (this.paystackTransferCode && this.paymentRail !== "paystack_transfer") {
    this.invalidate(
      "paystackTransferCode",
      "paystackTransferCode may only be linked to Paystack Transfer Transactions."
    );
  }

  if (this.paystackTransferCode && this.provider !== "paystack") {
    this.invalidate(
      "paystackTransferCode",
      "paystackTransferCode may only be set for Paystack Transactions."
    );
  }

  if (this.paystackTransferCode && !this.paystackTransferReference) {
    this.invalidate(
      "paystackTransferReference",
      "A Paystack Transfer code requires the deterministic provider transfer reference used to create or verify that Transfer."
    );
  }

  if (this.paymentRail === "paystack_transfer" && this.paystackReference) {
    this.invalidate(
      "paystackReference",
      "Paystack Transfer uses paystackTransferReference and paystackTransferCode, not paystackReference."
    );
  }

  // --- BANK ACCOUNT RELATIONSHIP ---

  const isBankAccountTransaction =
    this.type === "withdrawal" ||
    this.type === "withdrawal_reversal" ||
    (this.type === "shift_refund" && this.paymentRail === "paystack_transfer");

  if (this.bankAccount && !isBankAccountTransaction) {
    this.invalidate(
      "bankAccount",
      "bankAccount may only be linked to a withdrawal, withdrawal reversal or employer refund fallback Transfer."
    );
  }

  // --- AMOUNT CONSISTENCY ---

  if (this.providerFee > this.amount) {
    this.invalidate("providerFee", "Provider fee cannot be greater than Transaction amount.");
  }

  if (this.netAmount > this.amount) {
    this.invalidate("netAmount", "Net amount cannot be greater than Transaction amount.");
  }

  if (this.provider === "internal" && this.providerFee !== 0) {
    this.invalidate("providerFee", "Internal wallet movements cannot contain a provider fee.");
  }

  if (this.provider === "internal" && this.netAmount !== this.amount) {
    this.invalidate("netAmount", "Internal wallet movements must have netAmount equal to amount.");
  }

  if (this.relatedTransaction && sameId(this.relatedTransaction, this._id)) {
    this.invalidate("relatedTransaction", "A Transaction cannot be related to itself.");
  }

  // --- BALANCE CONSISTENCY ---

  const balanceFields = ["availableBalance", "pendingBalance", "outstandingBalance"];

  if (this.balanceBefore && this.balanceAfter && this.balanceDelta) {
    for (const field of balanceFields) {
      const before = Number(this.balanceBefore[field]);

      const delta = Number(this.balanceDelta[field]);

      const after = Number(this.balanceAfter[field]);

      const expectedAfter = before + delta;

      if (after !== expectedAfter) {
        this.invalidate(
          `balanceDelta.${field}`,
          `Invalid balanceDelta for ${field}. Expected balanceAfter.${field} to be ${expectedAfter}.`
        );
      }
    }
  }

  if (this.paymentRail === "paystack_transfer") {
    const netBalanceDelta = getNetBalanceDelta(this.balanceDelta);

    if (
      ["pending", "processing", "failed", "cancelled"].includes(this.status) &&
      netBalanceDelta !== 0
    ) {
      this.invalidate(
        "balanceDelta",
        "A Paystack Transfer cannot consume wallet value before conclusive provider success. Pending, processing, failed and cancelled Transfer records must have zero cumulative net wallet movement."
      );
    }

    if (
      ["completed", "reversed"].includes(this.status) &&
      netBalanceDelta !== -Number(this.amount)
    ) {
      this.invalidate(
        "balanceDelta",
        "A completed or subsequently reversed Paystack Transfer must retain the original cumulative wallet debit equal to Transaction amount. Any reversal credit belongs in its own reversal Transaction."
      );
    }
  }

  if (
    ["completed", "reversed"].includes(this.status) &&
    !hasAnyNonZeroBalanceDelta(this.balanceDelta)
  ) {
    this.invalidate(
      "balanceDelta",
      "A completed or reversed Transaction must record a non-zero wallet balance movement."
    );
  }

  // --- STATUS TIMESTAMPS ---

  if (this.status === "processing" && !this.processingStartedAt) {
    this.processingStartedAt = now;
  }

  if (this.status === "pending") {
    this.processingStartedAt = null;
  }

  if (this.status === "completed" && !this.completedAt) {
    this.completedAt = now;
  }

  if (!["completed", "reversed"].includes(this.status)) {
    this.completedAt = null;
  }

  if (this.status === "failed") {
    if (!this.failedAt) {
      this.failedAt = now;
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
    if (!this.completedAt) {
      this.invalidate(
        "completedAt",
        "A reversed Transaction must retain the time it originally completed."
      );
    }

    if (!this.reversedAt) {
      this.reversedAt = now;
    }

    if (!this.reversalReason) {
      this.reversalReason = "Transaction reversed.";
    }
  }

  if (this.status !== "reversed") {
    this.reversedAt = null;
    this.reversalReason = null;
  }

  if (this.status === "cancelled") {
    if (!this.cancelledAt) {
      this.cancelledAt = now;
    }

    if (!this.cancellationReason) {
      this.cancellationReason = "Transaction cancelled.";
    }
  }

  if (this.status !== "cancelled") {
    this.cancelledAt = null;
    this.cancellationReason = null;
  }

  // --- INITIATOR ---

  if (this.initiatedBy?.role !== "system" && !this.initiatedBy?.userId) {
    this.invalidate(
      "initiatedBy.userId",
      "initiatedBy.userId is required when a user initiates the Transaction."
    );
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

transactionSchema.index(
  {
    reference: 1,
  },
  {
    unique: true,
  }
);

transactionSchema.index(
  {
    idempotencyKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: {
        $type: "string",
      },
    },
  }
);

transactionSchema.index(
  {
    providerEventId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerEventId: {
        $type: "string",
      },
    },
  }
);

transactionSchema.index(
  {
    paystackReference: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      paystackReference: {
        $type: "string",
      },
    },
  }
);

transactionSchema.index(
  {
    paystackTransferReference: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      paystackTransferReference: {
        $type: "string",
      },
    },
  }
);

transactionSchema.index(
  {
    paystackTransferCode: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      paystackTransferCode: {
        $type: "string",
      },
    },
  }
);

transactionSchema.index(
  {
    settlementBatch: 1,
    type: 1,
    direction: 1,
    wallet: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      settlementBatch: {
        $type: "objectId",
      },
    },
  }
);

/**
 * One occurrence may earn each platform-fee component only once.
 *
 * The internal transfer produces:
 *
 * - one escrow debit; and
 * - one platform-wallet credit.
 *
 * direction and wallet distinguish the valid pair while preventing a second
 * ordinary collection for the same occurrence-component fee.
 */
transactionSchema.index(
  {
    shiftOccurrence: 1,
    purpose: 1,
    direction: 1,
    wallet: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      type: "platform_fee",
      shiftOccurrence: {
        $type: "objectId",
      },
    },
  }
);

/**
 * One employer refund batch line may create:
 *
 * internal_transfer
 * → one escrow debit and one employer-wallet credit
 *
 * paystack_refund
 * → one escrow debit
 *
 * paystack_transfer
 * → one escrow debit after the refund route fails
 *
 * paymentRail, direction and wallet distinguish these valid movements while
 * preventing duplicate execution for the same route.
 */
transactionSchema.index(
  {
    employerRefundBatch: 1,
    employerRefundBatchLineId: 1,
    paymentRail: 1,
    direction: 1,
    wallet: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      employerRefundBatch: {
        $type: "objectId",
      },

      employerRefundBatchLineId: {
        $type: "objectId",
      },
    },
  }
);

transactionSchema.index({
  wallet: 1,
  createdAt: -1,
});

transactionSchema.index(
  {
    counterpartyWallet: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    groupReference: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    relatedTransaction: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    shift: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    shiftOccurrence: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    assignmentCase: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    shiftApplication: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    settlementBatch: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    employerRefundBatch: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    employerRefundBatchLineId: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    employerRefundBatch: 1,
    status: 1,
    paymentRail: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    dva: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    bankAccount: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index(
  {
    dispute: 1,
  },
  {
    sparse: true,
  }
);

transactionSchema.index({
  type: 1,
  status: 1,
});

transactionSchema.index({
  purpose: 1,
  status: 1,
});

transactionSchema.index({
  paymentRail: 1,
  status: 1,
});

transactionSchema.index({
  countryCode: 1,
});

transactionSchema.index({
  currency: 1,
});

transactionSchema.index({
  countryCode: 1,
  currency: 1,
});

transactionSchema.index({
  countryCode: 1,
  currency: 1,
  createdAt: -1,
});

transactionSchema.index({
  type: 1,
  countryCode: 1,
  currency: 1,
  createdAt: -1,
});

transactionSchema.index({
  wallet: 1,
  countryCode: 1,
  currency: 1,
  createdAt: -1,
});

transactionSchema.index({
  shiftOccurrence: 1,
  type: 1,
  createdAt: -1,
});

transactionSchema.index({
  shiftOccurrence: 1,
  purpose: 1,
  direction: 1,
  createdAt: -1,
});

transactionSchema.index({
  assignmentCase: 1,
  type: 1,
  createdAt: -1,
});

transactionSchema.index({
  status: 1,
  processingStartedAt: 1,
});

transactionSchema.index({
  createdAt: -1,
});

module.exports = mongoose.model("Transaction", transactionSchema);
