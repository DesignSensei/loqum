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

  CHECKOUT_QUERY_UPDATE_FIELDS,
  PROTECTED_FINANCIAL_TRANSACTION_TYPES,
  WITHDRAWAL_STATUS_TRANSITIONS,
  PROTECTED_FINANCIAL_IDENTITY_FIELDS,
  WITHDRAWAL_OWNER_METADATA_FIELDS,
  WITHDRAWAL_PROVIDER_METADATA_FIELDS,
  WITHDRAWAL_DISPOSITION_METADATA_FIELDS,
} = require("../constants/transaction");

const {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isSignedSafeInteger,
} = require("./helpers/schemaValidators");

const {
  sameId,
  hasAnyNonZeroBalanceDelta,
  getNetBalanceDelta,
  getStoredTransactionValue,
  assertProtectedTransactionField,
  assertProtectedTransactionWriteOnce,
  assertProtectedTransactionBalances,
  assertActiveFinancialTransaction,
  isExactTransactionIdentifier,
} = require("./helpers/transactionValidators");

/* ---------- BALANCE SUB-SCHEMAS ---------- */

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

/* ---------- TRANSACTION SCHEMA ---------- */

const transactionSchema = new mongoose.Schema(
  {
    /* ---------- IDENTITY ---------- */

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

    /* ---------- PROVIDER REFERENCES ---------- */

    paystackReference: {
      type: String,
      trim: true,
      default: null,
    },

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

    /* ---------- CLASSIFICATION ---------- */

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

    /* ---------- WALLET ---------- */

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

    /* ---------- AMOUNTS ---------- */

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

    /* ---------- BALANCE AUDIT ---------- */

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
      required: true,
      default: () => ({}),
    },

    /* ---------- DIRECT SHIFT LINKS ---------- */

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

    /* ---------- SETTLEMENT BATCH ---------- */

    settlementBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftSettlementBatch",
      default: null,
    },

    /* ---------- EMPLOYER REFUND BATCH ---------- */

    employerRefundBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefundBatch",
      default: null,
    },

    employerRefundBatchLineId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    /* ---------- OTHER FINANCIAL LINKS ---------- */

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

    /* ---------- PAYMENT ROUTE ---------- */

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

    /* ---------- LIFECYCLE ---------- */

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

    /* ---------- INITIATOR ---------- */

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

    /* ---------- METADATA ---------- */

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

/* ---------- MODEL VALIDATION ---------- */

transactionSchema.pre("validate", function validateTransaction() {
  const now = new Date();

  /* ---------- NORMALIZATION ---------- */

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

  /* ---------- BATCH EXCLUSIVITY ---------- */

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

  /* ---------- DIRECT SHIFT LINKS ---------- */

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

  /* ---------- PROFESSIONAL SETTLEMENT BATCH ---------- */

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

  /* ---------- EMPLOYER REFUND BATCH ---------- */

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
        "An employer refund batch Transaction must use internal_transfer or paystack_refund."
      );
    }
  }

  if (hasEmployerRefundBatchLine && !hasEmployerRefundBatch) {
    this.invalidate(
      "employerRefundBatchLineId",
      "employerRefundBatchLineId requires employerRefundBatch."
    );
  }

  /* ---------- PROFESSIONAL SETTLEMENT ---------- */

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

  /* ---------- PLATFORM FEES ---------- */

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

  /* ---------- TYPE AND PURPOSE ---------- */

  const requiredPurpose = REQUIRED_PURPOSE_BY_TRANSACTION_TYPE[this.type];

  if (requiredPurpose && this.purpose !== requiredPurpose) {
    this.invalidate("purpose", `${this.type} transaction must have ${requiredPurpose} purpose.`);
  }

  const hasRefundPurpose = SHIFT_REFUND_PURPOSES.includes(this.purpose);

  if (hasRefundPurpose && this.type !== "shift_refund") {
    this.invalidate("type", `${this.purpose} may only be used by a shift_refund Transaction.`);
  }

  /* ---------- REFUND PURPOSES ---------- */

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

  /* ---------- SHIFT REFUNDS ---------- */

  if (this.type === "shift_refund") {
    if (!SHIFT_REFUND_PURPOSES.includes(this.purpose)) {
      this.invalidate(
        "purpose",
        "shift_refund must use a supported direct or weekly employer refund purpose."
      );
    }

    if (!SHIFT_REFUND_PAYMENT_RAILS.includes(this.paymentRail)) {
      this.invalidate("paymentRail", "shift_refund must use internal_transfer or paystack_refund.");
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

  /* ---------- DVA WALLET FUNDING ---------- */

  if (this.type === "wallet_funding") {
    if (this.direction !== "credit") {
      this.invalidate("direction", "Employer wallet funding must be a credit Transaction.");
    }

    if (this.paymentRail !== "paystack_dva") {
      this.invalidate("paymentRail", "Employer wallet funding must use Paystack DVA.");
    }

    if (this.purpose !== "wallet_topup") {
      this.invalidate("purpose", "Employer wallet funding must use wallet_topup purpose.");
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

    if (this.countryCode !== "NG" || this.currency !== "NGN") {
      this.invalidate("currency", "Paystack DVA wallet funding requires NG/NGN.");
    }

    if (this.status !== "completed" || this.paystackStatus !== "success") {
      this.invalidate("status", "Paystack DVA funding must be a confirmed completed payment.");
    }

    if (
      this.balanceDelta?.availableBalance !== this.amount ||
      this.balanceDelta?.pendingBalance !== 0 ||
      this.balanceDelta?.outstandingBalance !== 0
    ) {
      this.invalidate("balanceDelta", "DVA funding must credit the original gross payment amount.");
    }

    if (
      !isNonNegativeSafeInteger(this.providerFee) ||
      !isNonNegativeSafeInteger(this.netAmount) ||
      this.providerFee > this.amount ||
      this.netAmount !== this.amount - this.providerFee
    ) {
      this.invalidate("netAmount", "DVA payment net amount must equal amount minus provider fee.");
    }

    if (this.isNew && !["test", "live"].includes(this.metadata?.verifiedProviderMode)) {
      this.invalidate("metadata", "New DVA funding requires its verified Paystack environment.");
    }

    if (
      this.metadata?.verifiedProviderMode != null &&
      !["test", "live"].includes(this.metadata.verifiedProviderMode)
    ) {
      this.invalidate("metadata", "DVA funding contains an invalid Paystack environment.");
    }
  }

  if (this.dva && this.paymentRail !== "paystack_dva") {
    this.invalidate("dva", "DVA may only be linked to Paystack DVA wallet funding.");
  }

  /* ---------- SHIFT FUNDING ---------- */

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

  /* ---------- INTERNAL WALLET MOVEMENTS ---------- */

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

  /* ---------- EXTERNAL PAYSTACK MOVEMENTS ---------- */

  if (isPaystackMovement && this.counterpartyWallet) {
    this.invalidate(
      "counterpartyWallet",
      "External Paystack movements cannot reference a Loqum counterparty wallet."
    );
  }

  if (isPaystackMovement && this.provider !== "paystack") {
    this.invalidate("provider", `${this.paymentRail} Transaction must use Paystack provider.`);
  }

  /* ---------- PAYSTACK CHECKOUT ---------- */

  if (this.paymentRail === "paystack_checkout") {
    if (this.type === "wallet_funding") {
      this.invalidate("type", "Paystack Checkout cannot be used for employer wallet funding.");
    }
  }

  /* ---------- PAYSTACK REFUND ---------- */

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

  /* ---------- PAYSTACK PAYMENT REFERENCES ---------- */

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

  /* ---------- WITHDRAWAL ---------- */

  if (this.type === "withdrawal") {
    const metadata = this.metadata || {};

    const providerBound = ["processing", "completed", "failed", "reversed"].includes(this.status);

    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      this.invalidate("metadata", "Withdrawal requires a metadata object.");
    }

    if (["pending", "cancelled"].includes(this.status) && this.paystackTransferCode) {
      this.invalidate(
        "paystackTransferCode",
        "An unsubmitted withdrawal cannot contain a Transfer code."
      );
    }

    if (this.direction !== "debit") {
      this.invalidate("direction", "Withdrawal Transaction must be a debit.");
    }

    if (this.paymentRail !== "paystack_transfer" || this.provider !== "paystack") {
      this.invalidate("paymentRail", "Withdrawal Transaction must use Paystack Transfer.");
    }

    if (this.purpose !== "withdrawal") {
      this.invalidate("purpose", "Withdrawal Transaction must use withdrawal purpose.");
    }

    if (!this.bankAccount) {
      this.invalidate("bankAccount", "Withdrawal Transaction must reference a bank account.");
    }

    if (!isPositiveSafeInteger(this.netAmount) || this.netAmount > this.amount) {
      this.invalidate(
        "netAmount",
        "Withdrawal bank payout must be positive and cannot exceed the wallet debit."
      );
    }

    if (providerBound && !this.paystackTransferReference) {
      this.invalidate(
        "paystackTransferReference",
        "Provider-bound withdrawal requires its deterministic Transfer reference."
      );
    }

    const expectedTransferReference = `lq_withdrawal_${String(this._id)}`.toLowerCase();

    if (
      this.paystackTransferReference &&
      this.paystackTransferReference !== expectedTransferReference
    ) {
      this.invalidate(
        "paystackTransferReference",
        "Withdrawal Transfer reference does not match its original transaction."
      );
    }

    if (
      metadata.paystackTransferReference != null &&
      metadata.paystackTransferReference !== this.paystackTransferReference
    ) {
      this.invalidate("metadata", "Withdrawal contains conflicting Transfer references.");
    }

    if (["completed", "reversed"].includes(this.status) && !this.paystackTransferCode) {
      this.invalidate(
        "paystackTransferCode",
        "Completed or reversed withdrawal requires its original Transfer code."
      );
    }

    if (
      metadata.paystackTransferCode != null &&
      metadata.paystackTransferCode !== this.paystackTransferCode
    ) {
      this.invalidate("metadata", "Withdrawal contains conflicting Transfer codes.");
    }

    /* ---------- ORIGINAL PROVIDER IDENTITY ---------- */

    if (providerBound) {
      if (!["test", "live"].includes(metadata.paystackMode)) {
        this.invalidate(
          "metadata",
          "Provider-bound withdrawal requires its original Paystack environment."
        );
      }

      if (
        typeof metadata.paystackRecipientCode !== "string" ||
        !metadata.paystackRecipientCode.trim() ||
        metadata.paystackRecipientCode !== metadata.paystackRecipientCode.trim()
      ) {
        this.invalidate(
          "metadata",
          "Provider-bound withdrawal requires its original Paystack recipient."
        );
      }
    } else {
      if (WITHDRAWAL_PROVIDER_METADATA_FIELDS.some((field) => metadata[field] != null)) {
        this.invalidate(
          "metadata",
          "Withdrawal cannot contain provider identity before the processing boundary."
        );
      }
    }

    /* ---------- REVERSAL DISPOSITION ---------- */

    const disposition = metadata.providerReversalDisposition;

    const hasValidObjectId = (value) =>
      typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value);

    if (disposition != null && !["wallet_credit", "financial_obligation"].includes(disposition)) {
      this.invalidate("metadata", "Withdrawal contains an invalid reversal disposition.");
    }

    /* ---------- NORMAL WALLET REVERSAL ---------- */

    if (disposition === "wallet_credit") {
      if (
        this.status !== "reversed" ||
        this.paystackStatus !== "reversed" ||
        !hasValidObjectId(metadata.reversalTransactionId) ||
        metadata.financialObligationId != null
      ) {
        this.invalidate(
          "metadata",
          "Wallet reversal disposition requires its separate reversal credit."
        );
      }
    }

    /* ---------- HISTORICAL FINANCIAL OBLIGATION ---------- */

    if (disposition === "financial_obligation") {
      if (
        this.status !== "completed" ||
        this.paystackStatus !== "success" ||
        metadata.providerReversalStatus !== "reversed" ||
        !hasValidObjectId(metadata.financialObligationId) ||
        metadata.reversalTransactionId != null
      ) {
        this.invalidate(
          "metadata",
          "Historical withdrawal reversal must preserve the original completed debit."
        );
      }

      const verifiedAt = metadata.providerReversalVerifiedAt;

      if (
        !(verifiedAt instanceof Date) ||
        !Number.isFinite(verifiedAt.getTime()) ||
        !this.completedAt ||
        verifiedAt < this.completedAt
      ) {
        this.invalidate(
          "metadata",
          "Historical withdrawal reversal requires a valid verification time."
        );
      }
    }

    if (disposition !== "financial_obligation") {
      if (
        metadata.financialObligationId != null ||
        metadata.providerReversalStatus != null ||
        metadata.providerReversalVerifiedAt != null
      ) {
        this.invalidate(
          "metadata",
          "Historical reversal evidence requires a financial obligation disposition."
        );
      }
    }

    if (disposition !== "wallet_credit" && metadata.reversalTransactionId != null) {
      this.invalidate("metadata", "Reversal transaction requires a wallet credit disposition.");
    }

    if (this.status === "reversed" && disposition !== "wallet_credit") {
      this.invalidate(
        "metadata",
        "Reversed withdrawal must identify its wallet reversal disposition."
      );
    }
  }

  /* ---------- WITHDRAWAL REVERSAL CREDIT ---------- */

  if (this.type === "withdrawal_reversal") {
    if (this.direction !== "credit") {
      this.invalidate("direction", "Withdrawal reversal Transaction must be a credit.");
    }

    if (this.purpose !== "withdrawal_reversal") {
      this.invalidate("purpose", "Withdrawal reversal must use withdrawal_reversal purpose.");
    }

    if (this.paymentRail !== "system_action") {
      this.invalidate("paymentRail", "Withdrawal reversal Transaction must use system_action.");
    }

    if (this.provider !== "internal") {
      this.invalidate("provider", "Withdrawal reversal must use internal provider.");
    }

    if (this.status !== "completed") {
      this.invalidate("status", "Withdrawal reversal credit must be completed.");
    }

    if (!this.bankAccount) {
      this.invalidate(
        "bankAccount",
        "Withdrawal reversal must reference its original bank account."
      );
    }

    if (!this.relatedTransaction) {
      this.invalidate(
        "relatedTransaction",
        "Withdrawal reversal must reference the original withdrawal."
      );
    }

    if (this.counterpartyWallet) {
      this.invalidate(
        "counterpartyWallet",
        "Withdrawal reversal cannot reference a counterparty wallet."
      );
    }

    if (this.providerFee !== 0 || this.netAmount !== this.amount) {
      this.invalidate(
        "amount",
        "Withdrawal reversal must restore the original wallet debit without deducting fees."
      );
    }

    if (
      this.balanceDelta?.availableBalance !== this.amount ||
      this.balanceDelta?.pendingBalance !== 0 ||
      this.balanceDelta?.outstandingBalance !== 0
    ) {
      this.invalidate(
        "balanceDelta",
        "Withdrawal reversal must restore funds to available balance only."
      );
    }

    const expectedIdempotencyKey = `withdrawal-reversal:${String(this.relatedTransaction)}`;

    if (
      (this.isNew || this.isModified("idempotencyKey")) &&
      this.idempotencyKey !== expectedIdempotencyKey
    ) {
      this.invalidate(
        "idempotencyKey",
        "Withdrawal reversal requires its canonical idempotency key."
      );
    }

    if (
      String(this.metadata?.originalWithdrawalId || "") !== String(this.relatedTransaction || "")
    ) {
      this.invalidate(
        "metadata",
        "Withdrawal reversal metadata must identify its original withdrawal."
      );
    }
  }

  /* ---------- PAYSTACK TRANSFER RULES ---------- */

  if (
    this.paymentRail === "paystack_transfer" &&
    !PAYSTACK_TRANSFER_ALLOWED_TRANSACTION_TYPES.includes(this.type)
  ) {
    this.invalidate(
      "type",
      "Paystack Transfer API may only be used for employer or professional wallet withdrawals."
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

  /* ---------- BANK ACCOUNT RELATIONSHIP ---------- */

  const isBankAccountTransaction =
    this.type === "withdrawal" || this.type === "withdrawal_reversal";

  if (this.bankAccount && !isBankAccountTransaction) {
    this.invalidate(
      "bankAccount",
      "bankAccount may only be linked to a withdrawal or withdrawal reversal."
    );
  }

  /* ---------- AMOUNT CONSISTENCY ---------- */

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

  /* ---------- BALANCE CONSISTENCY ---------- */

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

  /* ---------- WITHDRAWAL BALANCE CONSISTENCY ---------- */

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

  /* ---------- LIFECYCLE TIMESTAMPS ---------- */

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

  /* ---------- TIMESTAMP ORDER ---------- */

  const lifecycleDateFields = [
    "processingStartedAt",
    "completedAt",
    "failedAt",
    "reversedAt",
    "cancelledAt",
  ];

  for (const field of lifecycleDateFields) {
    if (this[field] && this.createdAt && this[field] < this.createdAt) {
      this.invalidate(field, `${field} cannot precede Transaction creation.`);
    }
  }

  for (const field of ["completedAt", "failedAt", "reversedAt", "cancelledAt"]) {
    if (this[field] && this.processingStartedAt && this[field] < this.processingStartedAt) {
      this.invalidate(field, `${field} cannot precede processingStartedAt.`);
    }
  }

  if (this.reversedAt && this.completedAt && this.reversedAt < this.completedAt) {
    this.invalidate("reversedAt", "reversedAt cannot precede completedAt.");
  }

  /* ---------- INITIATOR ---------- */

  if (this.initiatedBy?.role !== "system" && !this.initiatedBy?.userId) {
    this.invalidate(
      "initiatedBy.userId",
      "initiatedBy.userId is required when a user initiates the Transaction."
    );
  }
});

/* ---------- QUERY UPDATE PROTECTION ---------- */

transactionSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  {
    query: true,
    document: false,
  },
  function protectTransactionQueryUpdate() {
    const operation = this.op;

    const options = this.getOptions();

    const filter = this.getFilter();

    const update = this.getUpdate();

    if (
      !["updateOne", "findOneAndUpdate"].includes(operation) ||
      options.upsert ||
      options.overwrite
    ) {
      throw new Error("Transaction replacement, bulk query updates and upserts are prohibited.");
    }

    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("Invalid Transaction query update.");
    }

    if (
      !isExactTransactionIdentifier(filter._id) &&
      !isExactTransactionIdentifier(filter.paystackReference)
    ) {
      throw new Error("Transaction query update requires a specific transaction identifier.");
    }

    for (const operator of Object.keys(update)) {
      if (!["$set", "$setOnInsert"].includes(operator)) {
        throw new Error(`Transaction query update does not permit ${operator}.`);
      }
    }

    /* Permit Mongoose-generated timestamps. */

    if (update.$setOnInsert) {
      for (const field of Object.keys(update.$setOnInsert)) {
        if (field !== "createdAt") {
          throw new Error(`Transaction query update cannot initialise ${field}.`);
        }
      }
    }

    const fields = update.$set || {};

    const updatedPaths = Object.keys(fields);

    if (updatedPaths.length === 0) {
      throw new Error("Transaction query update has no permitted changes.");
    }

    const isProcessingClaim = operation === "findOneAndUpdate";

    /* ---------- ATOMIC CHECKOUT PROCESSING CLAIM ---------- */

    if (isProcessingClaim) {
      if (
        fields.status !== "processing" ||
        updatedPaths.some((field) => !["status", "updatedAt"].includes(field))
      ) {
        throw new Error(
          "Transaction findOneAndUpdate is restricted to external credit processing claims."
        );
      }

      assertActiveFinancialTransaction(options.session);
    } else {
      /* ---------- CHECKOUT METADATA UPDATES ---------- */

      for (const field of updatedPaths) {
        if (!CHECKOUT_QUERY_UPDATE_FIELDS.includes(field)) {
          throw new Error(`Transaction query update cannot modify ${field}.`);
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(fields, "paystackStatus") &&
        fields.paystackStatus !== "pending"
      ) {
        throw new Error("Direct Checkout updates cannot establish a final provider status.");
      }

      if (
        Object.prototype.hasOwnProperty.call(fields, "metadata.paystackMode") &&
        !["test", "live"].includes(fields["metadata.paystackMode"])
      ) {
        throw new Error("Checkout update contains an invalid Paystack environment.");
      }
    }

    /* ---------- ATOMIC RAIL RESTRICTION ---------- */

    this.setQuery({
      $and: [
        filter,

        {
          provider: "paystack",

          paymentRail: "paystack_checkout",

          direction: "credit",

          dva: null,

          type: {
            $nin: PROTECTED_FINANCIAL_TRANSACTION_TYPES,
          },
        },

        ...(isProcessingClaim
          ? [
              {
                status: {
                  $in: ["pending", "failed"],
                },
              },
            ]
          : []),

        ...(!isProcessingClaim && fields.paystackStatus === "pending"
          ? [
              {
                status: "pending",
              },
            ]
          : []),
      ],
    });

    this.setOptions({
      runValidators: true,
      upsert: false,
    });
  }
);

/* ---------- PROTECTED FINANCIAL DOCUMENT SAVES ---------- */

transactionSchema.pre("save", async function protectFinancialTransactionSave() {
  const isProtected = PROTECTED_FINANCIAL_TRANSACTION_TYPES.includes(this.type);

  /* ---------- NEW RECORDS ---------- */

  if (this.isNew) {
    if (!isProtected) {
      return;
    }

    assertActiveFinancialTransaction(this.$session());

    if (this.type === "withdrawal" && (this.status !== "pending" || this.paystackTransferCode)) {
      throw new Error("A new withdrawal must begin as a pending wallet reservation.");
    }

    return;
  }

  /* ---------- EXISTING RECORDS ---------- */

  if (!isProtected && !this.isModified("type") && this.isSelected("type")) {
    return;
  }

  const session = this.$session();

  assertActiveFinancialTransaction(session);

  const previous = await this.constructor
    .findById(this._id)
    .select("+idempotencyKey")
    .session(session)
    .lean();

  if (!previous) {
    throw new Error("Original financial Transaction no longer exists.");
  }

  const wasProtected = PROTECTED_FINANCIAL_TRANSACTION_TYPES.includes(previous.type);

  if (!wasProtected && !isProtected) {
    return;
  }

  if (!wasProtected || previous.type !== this.type) {
    throw new Error("A protected financial Transaction cannot change its classification.");
  }

  /* ---------- FINANCIAL IDENTITY ---------- */

  for (const field of PROTECTED_FINANCIAL_IDENTITY_FIELDS) {
    assertProtectedTransactionField(this, previous, field);
  }

  if (this.isSelected("idempotencyKey") || this.isModified("idempotencyKey")) {
    assertProtectedTransactionField(this, previous, "idempotencyKey");
  }

  /* ---------- COMPLETED CREDITS ---------- */

  if (this.type === "wallet_funding" || this.type === "withdrawal_reversal") {
    for (const field of ["status", "paystackStatus", "completedAt", "providerEventId"]) {
      assertProtectedTransactionField(this, previous, field);
    }

    const evidencePath =
      this.type === "wallet_funding"
        ? "metadata.verifiedProviderMode"
        : "metadata.originalWithdrawalId";

    assertProtectedTransactionField(this, previous, evidencePath);

    assertProtectedTransactionBalances(this, previous);

    return;
  }

  /* ---------- WITHDRAWAL LIFECYCLE ---------- */

  const allowedStatuses = WITHDRAWAL_STATUS_TRANSITIONS[previous.status] || [];

  if (!allowedStatuses.includes(this.status)) {
    throw new Error(`Withdrawal cannot transition from ${previous.status} to ${this.status}.`);
  }

  /* ---------- OWNER IDENTITY ---------- */

  for (const field of WITHDRAWAL_OWNER_METADATA_FIELDS) {
    assertProtectedTransactionField(this, previous, `metadata.${field}`);
  }

  /* ---------- TRANSFER REFERENCE ---------- */

  for (const field of ["paystackTransferReference", "metadata.paystackTransferReference"]) {
    assertProtectedTransactionWriteOnce(this, previous, field);

    if (
      getStoredTransactionValue(previous, field) == null &&
      this.get(field) != null &&
      previous.status !== "pending"
    ) {
      throw new Error("Transfer reference must be established before provider processing.");
    }
  }

  /* ---------- TRANSFER CODE ---------- */

  for (const field of ["paystackTransferCode", "metadata.paystackTransferCode"]) {
    assertProtectedTransactionWriteOnce(this, previous, field);

    if (
      getStoredTransactionValue(previous, field) == null &&
      this.get(field) != null &&
      previous.status !== "processing"
    ) {
      throw new Error("Transfer code can only be established during provider processing.");
    }
  }

  /* ---------- PROVIDER IDENTITY ---------- */

  for (const field of WITHDRAWAL_PROVIDER_METADATA_FIELDS) {
    const path = `metadata.${field}`;

    assertProtectedTransactionWriteOnce(this, previous, path);

    if (
      getStoredTransactionValue(previous, path) == null &&
      this.get(path) != null &&
      !(previous.status === "pending" && this.status === "processing")
    ) {
      throw new Error(`${field} can only be established at the provider processing boundary.`);
    }
  }

  /* ---------- REVERSAL DISPOSITION ---------- */

  for (const field of WITHDRAWAL_DISPOSITION_METADATA_FIELDS) {
    const path = `metadata.${field}`;

    assertProtectedTransactionWriteOnce(this, previous, path);

    if (
      getStoredTransactionValue(previous, path) == null &&
      this.get(path) != null &&
      previous.status !== "completed"
    ) {
      throw new Error("Reversal evidence requires an originally completed withdrawal.");
    }
  }

  /* ---------- WRITE-ONCE TIMESTAMPS ---------- */

  for (const field of [
    "processingStartedAt",
    "completedAt",
    "failedAt",
    "reversedAt",
    "cancelledAt",
  ]) {
    assertProtectedTransactionWriteOnce(this, previous, field);
  }

  /* ---------- BALANCE AUDIT PROTECTION ---------- */

  const wasTerminal = ["completed", "reversed", "failed", "cancelled"].includes(previous.status);

  if (wasTerminal || this.status === previous.status || this.status === "processing") {
    assertProtectedTransactionBalances(this, previous);
  }

  /* ---------- TERMINAL PROVIDER EVIDENCE ---------- */

  if (wasTerminal) {
    assertProtectedTransactionField(this, previous, "providerEventId");

    if (this.status === previous.status) {
      assertProtectedTransactionField(this, previous, "paystackStatus");
    }
  }

  /* ---------- PERMANENT REVERSAL DISPOSITION ---------- */

  if (previous.metadata?.providerReversalDisposition) {
    assertProtectedTransactionField(this, previous, "status");

    assertProtectedTransactionField(this, previous, "paystackStatus");
  }
});

/* ---------- UNIQUE INDEXES ---------- */

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

/* ---------- SETTLEMENT UNIQUENESS ---------- */

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

/* ---------- PLATFORM FEE UNIQUENESS ---------- */

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

/* ---------- EMPLOYER REFUND UNIQUENESS ---------- */

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

/* ---------- WITHDRAWAL REVERSAL UNIQUENESS ---------- */

transactionSchema.index(
  {
    relatedTransaction: 1,
    type: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      type: "withdrawal_reversal",

      relatedTransaction: {
        $type: "objectId",
      },
    },

    name: "unique_withdrawal_reversal_credit",
  }
);

/* ---------- WALLET INDEXES ---------- */

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

/* ---------- SHIFT INDEXES ---------- */

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

/* ---------- BATCH INDEXES ---------- */

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

/* ---------- OTHER FINANCIAL INDEXES ---------- */

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

/* ---------- CLASSIFICATION INDEXES ---------- */

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

/* ---------- MARKET INDEXES ---------- */

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

/* ---------- FINANCIAL REPORTING INDEXES ---------- */

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

/* ---------- RECONCILIATION INDEXES ---------- */

transactionSchema.index({
  status: 1,
  processingStartedAt: 1,
});

transactionSchema.index({
  createdAt: -1,
});

module.exports = mongoose.model("Transaction", transactionSchema);
