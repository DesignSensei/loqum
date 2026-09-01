// models/EmployerRefundBatch.js

const mongoose = require("mongoose");

const {
  minorUnitAmountField,
  nonNegativeIntegerField,
  requiredPositiveMinorUnitAmountField,
} = require("./helpers/schemaFields");

const { isValidLocalDateString, isValidTimeZone } = require("./helpers/schemaValidators");

const {
  EMPLOYER_REFUND_FUNDING_METHODS,
  EMPLOYER_REFUND_BATCH_EXECUTION_METHODS,
  PAYSTACK_REFUND_STATUSES,
} = require("../constants/shiftLifecycle");

const MONDAY_WEEKDAY = 1;

const EMPLOYER_REFUND_BATCH_STATUSES = Object.freeze([
  "scheduled",
  "processing",
  "awaiting_provider",
  "awaiting_action",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
]);

const EMPLOYER_REFUND_LINE_STATUSES = Object.freeze([
  "queued",
  "processing",
  "pending_provider",
  "awaiting_action",
  "completed",
  "failed",
  "cancelled",
]);

const REFUND_BANK_CONSENT_STATUSES = Object.freeze([
  "not_required",
  "awaiting_consent",
  "confirmed",
]);

const PAYSTACK_REFUND_RETRY_STATUSES = Object.freeze([
  "not_required",
  "queued",
  "submitting",
  "submitted",
  "completed",
  "failed",
]);

const EMPLOYER_REFUND_FINAL_EXECUTION_METHODS = Object.freeze([
  "wallet_balance",
  "paystack_refund",
]);

const BATCH_INITIATORS = Object.freeze(["system", "admin"]);
const BATCH_CANCELLATION_ACTORS = Object.freeze(["system", "admin"]);
const TERMINAL_REFUND_LINE_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

const hasValue = (value) => {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
};

const hasAny = (values) => Array.isArray(values) && values.some(hasValue);

const hasAll = (values) => Array.isArray(values) && values.length > 0 && values.every(hasValue);

const hasArrayValues = (values) => Array.isArray(values) && values.length > 0;

const normalizeIdStrings = (values) =>
  (Array.isArray(values) ? values : []).map((value) => String(value));

const hasDuplicateValues = (values) => new Set(values).size !== values.length;

const sumSafeIntegerValues = (values) => {
  let total = 0;

  for (const value of values) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 0) {
      return null;
    }

    total += normalizedValue;

    if (!Number.isSafeInteger(total)) {
      return null;
    }
  }

  return total;
};

const getLocalDateWeekday = (localDate) => {
  if (!isValidLocalDateString(localDate)) {
    return null;
  }

  const date = new Date(`${localDate}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.getUTCDay();
};

const validateBankConsent = ({ document, consent, path = "bankConsent" }) => {
  const status = consent?.status || "not_required";

  const hasConsentAudit = hasAny([
    consent?.bankAccount,
    consent?.requestedAt,
    consent?.confirmedAt,
    consent?.confirmedBy,
  ]);

  if (status === "not_required") {
    if (hasConsentAudit) {
      document.invalidate(
        `${path}.status`,
        "Bank-consent audit fields require an active consent workflow."
      );
    }

    return;
  }

  if (status === "awaiting_consent") {
    if (!consent.bankAccount || !consent.requestedAt) {
      document.invalidate(
        `${path}.status`,
        "awaiting_consent requires bankAccount and requestedAt."
      );
    }

    if (consent.confirmedAt || consent.confirmedBy) {
      document.invalidate(
        `${path}.status`,
        "awaiting_consent cannot contain confirmation details."
      );
    }

    return;
  }

  if (status === "confirmed") {
    if (
      !consent.bankAccount ||
      !consent.requestedAt ||
      !consent.confirmedAt ||
      !consent.confirmedBy
    ) {
      document.invalidate(
        `${path}.status`,
        "Confirmed bank consent requires bankAccount, requestedAt, confirmedAt and confirmedBy."
      );
    }

    if (consent.confirmedAt && consent.requestedAt && consent.confirmedAt < consent.requestedAt) {
      document.invalidate(
        `${path}.confirmedAt`,
        "Bank consent cannot be confirmed before it is requested."
      );
    }
  }
};

const employerRefundAllocationSchema = new mongoose.Schema(
  {
    employerRefund: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefund",
      required: true,
    },

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      required: true,
    },

    originalFundingTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },

    amount: requiredPositiveMinorUnitAmountField(),
  },
  {
    _id: true,
  }
);

const walletRefundMovementSchema = new mongoose.Schema(
  {
    groupReference: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    escrowDebitTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    employerCreditTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

// Used only when Paystack needs customer bank details to continue the same refund.
const refundBankConsentSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: REFUND_BANK_CONSENT_STATUSES,
      default: "not_required",
      required: true,
    },

    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },

    requestedAt: {
      type: Date,
      default: null,
    },

    confirmedAt: {
      type: Date,
      default: null,
    },

    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    _id: false,
  }
);

const paystackRefundSchema = new mongoose.Schema(
  {
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    refundId: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    reference: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    status: {
      type: String,
      enum: PAYSTACK_REFUND_STATUSES,
      default: "not_started",
      required: true,
    },

    submittedAt: {
      type: Date,
      default: null,
    },

    processingAt: {
      type: Date,
      default: null,
    },

    needsAttentionAt: {
      type: Date,
      default: null,
    },

    processedAt: {
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
      maxlength: 1000,
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    lastProviderEventId: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    rawStatus: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
  },
  {
    _id: false,
  }
);

// Continues a needs_attention refund with an employer-confirmed verified bank account.
const paystackRefundRetrySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: PAYSTACK_REFUND_RETRY_STATUSES,
      default: "not_required",
      required: true,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    attemptCount: nonNegativeIntegerField({
      defaultValue: 0,
    }),

    queuedAt: {
      type: Date,
      default: null,
    },

    submittingAt: {
      type: Date,
      default: null,
    },

    submittedAt: {
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

    lastError: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/*
 * Wallet-funded refunds complete by internal escrow-to-wallet transfer.
 * Paystack-funded refunds try Paystack first, use Retry Refund only for
 * needs_attention, and fall back automatically to Loqum wallet after failed.
 */
const employerRefundLineSchema = new mongoose.Schema(
  {
    lineReference: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      required: true,
    },

    fundingMethod: {
      type: String,
      enum: EMPLOYER_REFUND_FUNDING_METHODS,
      required: true,
    },

    initialExecutionMethod: {
      type: String,
      enum: EMPLOYER_REFUND_BATCH_EXECUTION_METHODS,
      required: true,
    },

    finalExecutionMethod: {
      type: String,
      enum: [...EMPLOYER_REFUND_FINAL_EXECUTION_METHODS, null],
      default: null,
    },

    originalPaystackReference: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    allocations: {
      type: [employerRefundAllocationSchema],
      required: true,
      default: undefined,
      validate: {
        validator: (values) => Array.isArray(values) && values.length > 0,
        message: "A refund execution line requires at least one refund allocation.",
      },
    },

    allocationCount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "allocationCount must be a whole number.",
      },
    },

    shiftCount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "shiftCount must be a whole number.",
      },
    },

    totalAmount: requiredPositiveMinorUnitAmountField(),

    eligibilityCheckedAt: {
      type: Date,
      required: true,
    },

    // Final entitlement check before any money or provider request moves.
    executionEligibilityCheckedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: EMPLOYER_REFUND_LINE_STATUSES,
      default: "queued",
      required: true,
    },

    attemptCount: nonNegativeIntegerField({
      defaultValue: 0,
    }),

    lastAttemptAt: {
      type: Date,
      default: null,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    pendingProviderAt: {
      type: Date,
      default: null,
    },

    awaitingActionAt: {
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
      maxlength: 1000,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    executionTransactions: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Transaction",
        },
      ],
      default: [],
    },

    completedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    walletMovement: {
      type: walletRefundMovementSchema,
      default: () => ({}),
    },

    paystackRefund: {
      type: paystackRefundSchema,
      default: () => ({}),
    },

    bankConsent: {
      type: refundBankConsentSchema,
      default: () => ({}),
    },

    retry: {
      type: paystackRefundRetrySchema,
      default: () => ({}),
    },
  },
  {
    _id: true,
  }
);

// One weekly employer/country/currency refund cycle. Lines revalidate before execution.
const employerRefundBatchSchema = new mongoose.Schema(
  {
    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      immutable: true,
    },

    cycleKey: {
      type: String,
      trim: true,
      maxlength: 200,
      required: true,
      immutable: true,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      required: true,
      immutable: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    employerWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      immutable: true,
    },

    escrowWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      immutable: true,
    },

    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
      immutable: true,
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
      immutable: true,
    },

    refundDate: {
      type: String,
      trim: true,
      required: true,
      immutable: true,
      validate: {
        validator: isValidLocalDateString,
        message: "refundDate must be a valid date in YYYY-MM-DD format.",
      },
    },

    timeZone: {
      type: String,
      trim: true,
      maxlength: 100,
      required: true,
      immutable: true,
      validate: {
        validator: isValidTimeZone,
        message: "timeZone must be a valid IANA timezone.",
      },
    },

    cutoffAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    scheduledFor: {
      type: Date,
      required: true,
      immutable: true,
    },

    lines: {
      type: [employerRefundLineSchema],
      required: true,
      default: undefined,
      validate: {
        validator: (values) => Array.isArray(values) && values.length > 0,
        message: "An employer refund batch requires at least one execution line.",
      },
    },

    lineCount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "lineCount must be a whole number.",
      },
    },

    shiftCount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "shiftCount must be a whole number.",
      },
    },

    occurrenceCount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "occurrenceCount must be a whole number.",
      },
    },

    refundCount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "refundCount must be a whole number.",
      },
    },

    totalAmount: requiredPositiveMinorUnitAmountField(),

    completedAmount: minorUnitAmountField({
      required: true,
      defaultValue: 0,
    }),

    failedAmount: minorUnitAmountField({
      required: true,
      defaultValue: 0,
    }),

    status: {
      type: String,
      enum: EMPLOYER_REFUND_BATCH_STATUSES,
      default: "scheduled",
      required: true,
    },

    processingToken: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
      select: false,
    },

    lockedAt: {
      type: Date,
      default: null,
    },

    lockExpiresAt: {
      type: Date,
      default: null,
    },

    attemptCount: nonNegativeIntegerField({
      defaultValue: 0,
    }),

    lastAttemptAt: {
      type: Date,
      default: null,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    awaitingProviderAt: {
      type: Date,
      default: null,
    },

    awaitingActionAt: {
      type: Date,
      default: null,
    },

    partiallyCompletedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    lastFailedAt: {
      type: Date,
      default: null,
    },

    lastFailureReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: String,
      enum: [...BATCH_CANCELLATION_ACTORS, null],
      default: null,
    },

    cancelledByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    initiatedBy: {
      type: String,
      enum: BATCH_INITIATORS,
      default: "system",
      required: true,
    },

    initiatedByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

employerRefundLineSchema.pre("validate", function validateEmployerRefundLine() {
  const allocations = Array.isArray(this.allocations) ? this.allocations : [];

  const executionTransactions = Array.isArray(this.executionTransactions)
    ? this.executionTransactions
    : [];

  const walletMovement = this.walletMovement || {};
  const paystackRefund = this.paystackRefund || {};
  const bankConsent = this.bankConsent || {};
  const retry = this.retry || {};

  const refundIds = allocations.map((allocation) => String(allocation.employerRefund));
  const occurrenceIds = allocations.map((allocation) => String(allocation.occurrence));
  const shiftIds = allocations.map((allocation) => String(allocation.shift));

  const fundingTransactionIds = allocations.map((allocation) =>
    String(allocation.originalFundingTransaction)
  );

  const allocationAmounts = allocations.map((allocation) => allocation.amount);

  const executionTransactionIds = normalizeIdStrings(executionTransactions);

  const uniqueShiftIds = [...new Set(shiftIds)];
  const uniqueFundingTransactionIds = [...new Set(fundingTransactionIds)];

  const hasWalletMovementAudit = hasAny([
    walletMovement.groupReference,
    walletMovement.escrowDebitTransaction,
    walletMovement.employerCreditTransaction,
    walletMovement.completedAt,
  ]);

  const hasPaystackRefundAudit = hasAny([
    paystackRefund.idempotencyKey,
    paystackRefund.refundId,
    paystackRefund.reference,
    paystackRefund.submittedAt,
    paystackRefund.processingAt,
    paystackRefund.needsAttentionAt,
    paystackRefund.processedAt,
    paystackRefund.failedAt,
    paystackRefund.failureReason,
    paystackRefund.lastSyncedAt,
    paystackRefund.lastProviderEventId,
    paystackRefund.rawStatus,
  ]);

  const hasRetryAudit =
    Number(retry.attemptCount || 0) > 0 ||
    hasAny([
      retry.idempotencyKey,
      retry.queuedAt,
      retry.submittingAt,
      retry.submittedAt,
      retry.completedAt,
      retry.failedAt,
      retry.lastError,
    ]);

  const hasCancellationAudit = hasAny([this.cancelledAt, this.cancellationReason]);

  if (hasDuplicateValues(refundIds)) {
    this.invalidate(
      "allocations",
      "A refund line cannot contain the same EmployerRefund more than once."
    );
  }

  if (hasDuplicateValues(occurrenceIds)) {
    this.invalidate(
      "allocations",
      "A refund line cannot contain the same ShiftOccurrence more than once."
    );
  }

  if (this.allocationCount !== allocations.length) {
    this.invalidate(
      "allocationCount",
      "allocationCount must match the number of refund allocations."
    );
  }

  if (this.shiftCount !== uniqueShiftIds.length) {
    this.invalidate("shiftCount", "shiftCount must match the number of unique included Shifts.");
  }

  const calculatedTotalAmount = sumSafeIntegerValues(allocationAmounts);

  if (calculatedTotalAmount === null) {
    this.invalidate("totalAmount", "Refund allocations contain an invalid amount.");
  } else if (Number(this.totalAmount) !== calculatedTotalAmount) {
    this.invalidate("totalAmount", "totalAmount must equal the sum of all refund allocations.");
  }

  if (this.fundingMethod === "wallet_balance") {
    if (this.initialExecutionMethod !== "wallet_balance") {
      this.invalidate(
        "initialExecutionMethod",
        "A wallet-funded line must initially execute through wallet_balance."
      );
    }

    if (this.originalPaystackReference) {
      this.invalidate(
        "originalPaystackReference",
        "A wallet-funded line cannot contain an original Paystack reference."
      );
    }

    if (paystackRefund.status !== "not_started" || hasPaystackRefundAudit) {
      this.invalidate(
        "paystackRefund.status",
        "A wallet-funded line cannot contain Paystack refund details."
      );
    }

    if (bankConsent.status !== "not_required" || retry.status !== "not_required" || hasRetryAudit) {
      this.invalidate(
        "fundingMethod",
        "A wallet-funded line cannot contain Paystack bank-consent or Retry Refund details."
      );
    }

    if (this.finalExecutionMethod && this.finalExecutionMethod !== "wallet_balance") {
      this.invalidate(
        "finalExecutionMethod",
        "A wallet-funded line can only complete through wallet_balance."
      );
    }
  }

  if (this.fundingMethod === "paystack_checkout") {
    if (this.initialExecutionMethod !== "paystack_refund") {
      this.invalidate(
        "initialExecutionMethod",
        "A Paystack-funded line must initially execute through paystack_refund."
      );
    }

    if (!this.originalPaystackReference) {
      this.invalidate(
        "originalPaystackReference",
        "A Paystack-funded line requires the original Paystack payment reference."
      );
    }

    if (uniqueShiftIds.length !== 1) {
      this.invalidate(
        "allocations",
        "A Paystack refund line must contain allocations from exactly one parent Shift."
      );
    }

    if (uniqueFundingTransactionIds.length !== 1) {
      this.invalidate(
        "allocations",
        "A Paystack refund line must reference exactly one original Shift funding transaction."
      );
    }

    if (
      this.finalExecutionMethod &&
      !["paystack_refund", "wallet_balance"].includes(this.finalExecutionMethod)
    ) {
      this.invalidate(
        "finalExecutionMethod",
        "A Paystack-funded line may complete only through paystack_refund or wallet_balance."
      );
    }

    if (this.finalExecutionMethod === "wallet_balance" && paystackRefund.status !== "failed") {
      this.invalidate(
        "paystackRefund.status",
        "Automatic wallet fallback requires a conclusively failed Paystack refund."
      );
    }
  }

  if (Number(this.attemptCount || 0) === 0 && this.lastAttemptAt) {
    this.invalidate(
      "lastAttemptAt",
      "lastAttemptAt requires at least one line-processing attempt."
    );
  }

  if (Number(this.attemptCount || 0) > 0 && !this.lastAttemptAt) {
    this.invalidate("lastAttemptAt", "A line with processing attempts requires lastAttemptAt.");
  }

  if (this.processingStartedAt && (Number(this.attemptCount || 0) < 1 || !this.lastAttemptAt)) {
    this.invalidate(
      "processingStartedAt",
      "processingStartedAt requires at least one line-processing attempt."
    );
  }

  if (
    this.processingStartedAt &&
    this.lastAttemptAt &&
    this.processingStartedAt > this.lastAttemptAt
  ) {
    this.invalidate(
      "processingStartedAt",
      "processingStartedAt cannot be later than lastAttemptAt."
    );
  }

  if (
    this.executionEligibilityCheckedAt &&
    this.eligibilityCheckedAt &&
    this.executionEligibilityCheckedAt < this.eligibilityCheckedAt
  ) {
    this.invalidate(
      "executionEligibilityCheckedAt",
      "executionEligibilityCheckedAt cannot be earlier than the original batch eligibility check."
    );
  }

  if (
    this.processingStartedAt &&
    this.executionEligibilityCheckedAt &&
    this.executionEligibilityCheckedAt > this.processingStartedAt
  ) {
    this.invalidate(
      "executionEligibilityCheckedAt",
      "Execution eligibility must be rechecked before processing starts."
    );
  }

  if (this.status === "queued" && this.executionEligibilityCheckedAt) {
    this.invalidate(
      "executionEligibilityCheckedAt",
      "A queued refund line has not reached its final execution eligibility check."
    );
  }

  if (
    ["processing", "pending_provider", "awaiting_action", "completed", "failed"].includes(
      this.status
    ) &&
    !this.executionEligibilityCheckedAt
  ) {
    this.invalidate(
      "executionEligibilityCheckedAt",
      `${this.status} requires a final execution eligibility check.`
    );
  }

  if (hasWalletMovementAudit) {
    if (
      !walletMovement.groupReference ||
      !walletMovement.escrowDebitTransaction ||
      !walletMovement.employerCreditTransaction ||
      !walletMovement.completedAt
    ) {
      this.invalidate(
        "walletMovement",
        "Wallet movement requires groupReference, escrowDebitTransaction, employerCreditTransaction and completedAt together."
      );
    }

    const walletMovementAllowed =
      this.fundingMethod === "wallet_balance" ||
      (this.fundingMethod === "paystack_checkout" && paystackRefund.status === "failed");

    if (!walletMovementAllowed) {
      this.invalidate(
        "walletMovement",
        "A Paystack-funded wallet fallback requires a conclusively failed provider refund."
      );
    }

    if (
      walletMovement.escrowDebitTransaction &&
      walletMovement.employerCreditTransaction &&
      String(walletMovement.escrowDebitTransaction) ===
        String(walletMovement.employerCreditTransaction)
    ) {
      this.invalidate(
        "walletMovement.employerCreditTransaction",
        "The escrow debit and employer credit must be different Transactions."
      );
    }

    if (
      walletMovement.escrowDebitTransaction &&
      !executionTransactionIds.includes(String(walletMovement.escrowDebitTransaction))
    ) {
      this.invalidate(
        "executionTransactions",
        "executionTransactions must include the escrow refund debit."
      );
    }

    if (
      walletMovement.employerCreditTransaction &&
      !executionTransactionIds.includes(String(walletMovement.employerCreditTransaction))
    ) {
      this.invalidate(
        "executionTransactions",
        "executionTransactions must include the employer wallet refund credit."
      );
    }
  }

  if (this.status !== "completed" && hasWalletMovementAudit) {
    this.invalidate("walletMovement", "Completed wallet movement requires completed line status.");
  }

  if (paystackRefund.status === "not_started" && hasPaystackRefundAudit) {
    this.invalidate(
      "paystackRefund.status",
      "Paystack refund audit fields require a started provider refund."
    );
  }

  if (paystackRefund.status === "pending") {
    if (
      !paystackRefund.idempotencyKey ||
      !paystackRefund.submittedAt ||
      (!paystackRefund.refundId && !paystackRefund.reference)
    ) {
      this.invalidate(
        "paystackRefund.status",
        "A pending Paystack refund requires idempotencyKey, submittedAt and a provider identifier."
      );
    }
  }

  if (paystackRefund.status === "processing") {
    if (
      !paystackRefund.idempotencyKey ||
      !paystackRefund.submittedAt ||
      !paystackRefund.processingAt ||
      (!paystackRefund.refundId && !paystackRefund.reference)
    ) {
      this.invalidate(
        "paystackRefund.status",
        "A processing Paystack refund requires submission, processingAt and a provider identifier."
      );
    }

    if (
      paystackRefund.processingAt &&
      paystackRefund.submittedAt &&
      paystackRefund.processingAt < paystackRefund.submittedAt
    ) {
      this.invalidate(
        "paystackRefund.processingAt",
        "Paystack refund processing cannot begin before submission."
      );
    }
  }

  if (paystackRefund.status === "needs_attention") {
    if (
      !paystackRefund.idempotencyKey ||
      !paystackRefund.submittedAt ||
      !paystackRefund.needsAttentionAt ||
      (!paystackRefund.refundId && !paystackRefund.reference)
    ) {
      this.invalidate(
        "paystackRefund.status",
        "needs_attention requires submission, needsAttentionAt and a provider identifier."
      );
    }
  }

  if (paystackRefund.status === "processed") {
    if (
      !paystackRefund.idempotencyKey ||
      !paystackRefund.submittedAt ||
      !paystackRefund.processedAt ||
      (!paystackRefund.refundId && !paystackRefund.reference)
    ) {
      this.invalidate(
        "paystackRefund.status",
        "A processed Paystack refund requires submission, processedAt and a provider identifier."
      );
    }

    if (paystackRefund.failedAt || paystackRefund.failureReason) {
      this.invalidate(
        "paystackRefund.status",
        "A processed Paystack refund cannot retain terminal failure audit."
      );
    }

    if (paystackRefund.needsAttentionAt && retry.status !== "completed") {
      this.invalidate(
        "retry.status",
        "A refund that reached needs_attention can complete only through a completed Retry Refund."
      );
    }

    if (hasRetryAudit && retry.status !== "completed") {
      this.invalidate(
        "retry.status",
        "A processed refund with Retry Refund audit must close the retry as completed."
      );
    }

    if (hasWalletMovementAudit) {
      this.invalidate(
        "walletMovement",
        "A processed Paystack refund cannot also complete through wallet fallback."
      );
    }
  }

  if (paystackRefund.status === "failed") {
    if (
      !paystackRefund.idempotencyKey ||
      !paystackRefund.submittedAt ||
      !paystackRefund.failedAt ||
      !paystackRefund.failureReason
    ) {
      this.invalidate(
        "paystackRefund.status",
        "A failed Paystack refund requires submission, failedAt and failureReason."
      );
    }

    if (paystackRefund.processedAt) {
      this.invalidate(
        "paystackRefund.status",
        "A failed Paystack refund cannot retain processed completion audit."
      );
    }
  }

  if (
    paystackRefund.processedAt &&
    paystackRefund.submittedAt &&
    paystackRefund.processedAt < paystackRefund.submittedAt
  ) {
    this.invalidate(
      "paystackRefund.processedAt",
      "Paystack refund cannot complete before submission."
    );
  }

  if (
    paystackRefund.failedAt &&
    paystackRefund.submittedAt &&
    paystackRefund.failedAt < paystackRefund.submittedAt
  ) {
    this.invalidate("paystackRefund.failedAt", "Paystack refund cannot fail before submission.");
  }

  validateBankConsent({
    document: this,
    consent: bankConsent,
  });

  if (this.fundingMethod !== "paystack_checkout" && bankConsent.status !== "not_required") {
    this.invalidate(
      "bankConsent.status",
      "Bank consent applies only to Paystack-funded refund recovery."
    );
  }

  if (bankConsent.status !== "not_required" && !paystackRefund.needsAttentionAt) {
    this.invalidate(
      "bankConsent.status",
      "Bank consent requires a recorded Paystack needs_attention event."
    );
  }

  if (
    bankConsent.status !== "not_required" &&
    !["needs_attention", "pending", "processing", "processed", "failed"].includes(
      paystackRefund.status
    )
  ) {
    this.invalidate(
      "bankConsent.status",
      "Bank consent requires a Paystack refund that reached needs_attention."
    );
  }

  if (retry.status === "not_required" && hasRetryAudit) {
    this.invalidate("retry.status", "Retry audit fields require an active Retry Refund workflow.");
  }

  if (retry.status === "queued") {
    if (
      !retry.idempotencyKey ||
      !retry.queuedAt ||
      paystackRefund.status !== "needs_attention" ||
      !["awaiting_consent", "confirmed"].includes(bankConsent.status)
    ) {
      this.invalidate(
        "retry.status",
        "A queued Retry Refund requires queue audit, needs_attention and active bank consent."
      );
    }

    if (
      Number(retry.attemptCount || 0) !== 0 ||
      retry.submittingAt ||
      retry.submittedAt ||
      retry.completedAt ||
      retry.failedAt ||
      retry.lastError
    ) {
      this.invalidate(
        "retry.status",
        "A queued Retry Refund cannot contain attempt or outcome details."
      );
    }
  }

  if (retry.status === "submitting") {
    if (
      !retry.idempotencyKey ||
      !retry.queuedAt ||
      !retry.submittingAt ||
      Number(retry.attemptCount || 0) < 1 ||
      paystackRefund.status !== "needs_attention" ||
      bankConsent.status !== "confirmed"
    ) {
      this.invalidate(
        "retry.status",
        "A submitting Retry Refund requires confirmed bank consent, queue audit and an attempt."
      );
    }

    if (retry.submittedAt || retry.completedAt || retry.failedAt || retry.lastError) {
      this.invalidate(
        "retry.status",
        "A submitting Retry Refund cannot contain submitted or outcome details."
      );
    }
  }

  if (retry.status === "submitted") {
    if (
      !retry.idempotencyKey ||
      !retry.queuedAt ||
      !retry.submittingAt ||
      !retry.submittedAt ||
      Number(retry.attemptCount || 0) < 1 ||
      !["pending", "processing"].includes(paystackRefund.status) ||
      bankConsent.status !== "confirmed"
    ) {
      this.invalidate(
        "retry.status",
        "A submitted Retry Refund requires confirmed bank consent and a pending or processing refund."
      );
    }

    if (retry.completedAt || retry.failedAt || retry.lastError) {
      this.invalidate(
        "retry.status",
        "A submitted Retry Refund cannot contain completion or failure details."
      );
    }
  }

  if (retry.status === "completed") {
    if (
      !retry.idempotencyKey ||
      !retry.queuedAt ||
      !retry.submittingAt ||
      !retry.submittedAt ||
      !retry.completedAt ||
      Number(retry.attemptCount || 0) < 1 ||
      paystackRefund.status !== "processed" ||
      bankConsent.status !== "confirmed"
    ) {
      this.invalidate(
        "retry.status",
        "A completed Retry Refund requires confirmed bank consent and processed provider refund."
      );
    }

    if (retry.failedAt || retry.lastError) {
      this.invalidate("retry.status", "A completed Retry Refund cannot contain failure details.");
    }
  }

  if (retry.status === "failed") {
    if (
      !retry.idempotencyKey ||
      !retry.queuedAt ||
      !retry.submittingAt ||
      !retry.failedAt ||
      !retry.lastError ||
      retry.completedAt ||
      Number(retry.attemptCount || 0) < 1 ||
      paystackRefund.status !== "failed" ||
      bankConsent.status !== "confirmed"
    ) {
      this.invalidate(
        "retry.status",
        "A failed Retry Refund requires confirmed bank consent and a failed provider refund."
      );
    }
  }

  if (retry.submittingAt && retry.queuedAt && retry.submittingAt < retry.queuedAt) {
    this.invalidate(
      "retry.submittingAt",
      "Retry Refund submission cannot begin before it is queued."
    );
  }

  if (retry.submittedAt && retry.submittingAt && retry.submittedAt < retry.submittingAt) {
    this.invalidate(
      "retry.submittedAt",
      "Retry Refund submission cannot complete before it begins."
    );
  }

  if (retry.completedAt && retry.submittedAt && retry.completedAt < retry.submittedAt) {
    this.invalidate("retry.completedAt", "Retry Refund cannot complete before submission.");
  }

  if (
    retry.completedAt &&
    paystackRefund.processedAt &&
    retry.completedAt < paystackRefund.processedAt
  ) {
    this.invalidate(
      "retry.completedAt",
      "Retry Refund completedAt cannot precede provider processedAt."
    );
  }

  if (retry.failedAt && retry.submittingAt && retry.failedAt < retry.submittingAt) {
    this.invalidate("retry.failedAt", "Retry Refund cannot fail before submission begins.");
  }

  if (this.status === "queued") {
    if (
      Number(this.attemptCount || 0) !== 0 ||
      this.lastAttemptAt ||
      this.processingStartedAt ||
      this.pendingProviderAt ||
      this.awaitingActionAt ||
      this.completedAt ||
      this.failedAt ||
      this.failureReason ||
      hasCancellationAudit ||
      hasArrayValues(executionTransactions) ||
      this.completedTransaction ||
      this.finalExecutionMethod ||
      hasWalletMovementAudit ||
      hasPaystackRefundAudit ||
      bankConsent.status !== "not_required" ||
      retry.status !== "not_required"
    ) {
      this.invalidate(
        "status",
        "A queued refund line cannot contain processing, provider, consent or outcome audit."
      );
    }
  }

  if (this.status === "processing") {
    if (!this.processingStartedAt || Number(this.attemptCount || 0) < 1 || !this.lastAttemptAt) {
      this.invalidate(
        "status",
        "A processing refund line requires processingStartedAt and at least one attempt."
      );
    }

    if (
      this.completedAt ||
      this.failedAt ||
      this.failureReason ||
      hasCancellationAudit ||
      this.finalExecutionMethod
    ) {
      this.invalidate(
        "status",
        "A processing refund line cannot contain terminal outcome details."
      );
    }
  }

  if (this.status === "pending_provider") {
    const waitingForPaystack = ["pending", "processing"].includes(paystackRefund.status);
    const waitingForRetry = retry.status === "submitted";

    if (
      !this.processingStartedAt ||
      !this.pendingProviderAt ||
      Number(this.attemptCount || 0) < 1 ||
      (!waitingForPaystack && !waitingForRetry)
    ) {
      this.invalidate(
        "status",
        "pending_provider requires processing audit and a pending provider refund."
      );
    }

    if (
      this.completedAt ||
      this.failedAt ||
      this.failureReason ||
      hasCancellationAudit ||
      this.finalExecutionMethod
    ) {
      this.invalidate("status", "A provider-pending line cannot contain terminal outcome details.");
    }
  }

  if (this.status === "awaiting_action") {
    const needsBankConfirmation =
      this.fundingMethod === "paystack_checkout" &&
      paystackRefund.status === "needs_attention" &&
      ["not_required", "awaiting_consent"].includes(bankConsent.status) &&
      retry.status === "not_required";

    const retryActionPending =
      this.fundingMethod === "paystack_checkout" &&
      paystackRefund.status === "needs_attention" &&
      ((bankConsent.status === "confirmed" && ["not_required", "queued"].includes(retry.status)) ||
        (bankConsent.status === "awaiting_consent" && retry.status === "queued"));

    if (
      !this.processingStartedAt ||
      !this.awaitingActionAt ||
      Number(this.attemptCount || 0) < 1 ||
      (!needsBankConfirmation && !retryActionPending)
    ) {
      this.invalidate(
        "status",
        "awaiting_action requires a needs_attention refund awaiting bank confirmation or Retry Refund."
      );
    }

    if (
      this.completedAt ||
      this.failedAt ||
      this.failureReason ||
      hasCancellationAudit ||
      this.finalExecutionMethod
    ) {
      this.invalidate("status", "An action-required line cannot contain terminal outcome details.");
    }
  }

  if (this.status === "completed") {
    if (
      !this.processingStartedAt ||
      !this.completedAt ||
      !this.completedTransaction ||
      !this.finalExecutionMethod ||
      Number(this.attemptCount || 0) < 1
    ) {
      this.invalidate(
        "status",
        "A completed refund line requires processing, completion and Transaction audit."
      );
    }

    if (!executionTransactionIds.includes(String(this.completedTransaction))) {
      this.invalidate(
        "completedTransaction",
        "completedTransaction must also be included in executionTransactions."
      );
    }

    if (this.failedAt || this.failureReason || hasCancellationAudit) {
      this.invalidate(
        "status",
        "A completed refund line cannot contain failed or cancelled audit."
      );
    }

    if (this.fundingMethod === "wallet_balance") {
      if (
        this.finalExecutionMethod !== "wallet_balance" ||
        !walletMovement.groupReference ||
        !walletMovement.escrowDebitTransaction ||
        !walletMovement.employerCreditTransaction ||
        !walletMovement.completedAt
      ) {
        this.invalidate(
          "walletMovement",
          "A completed wallet refund requires complete paired wallet movement audit."
        );
      }

      if (String(this.completedTransaction) !== String(walletMovement.employerCreditTransaction)) {
        this.invalidate(
          "completedTransaction",
          "The completed wallet refund Transaction must be the employer wallet credit."
        );
      }
    }

    if (this.fundingMethod === "paystack_checkout") {
      const completedByRefund =
        paystackRefund.status === "processed" &&
        this.finalExecutionMethod === "paystack_refund" &&
        !hasWalletMovementAudit;

      const completedByWallet =
        paystackRefund.status === "failed" &&
        this.finalExecutionMethod === "wallet_balance" &&
        Boolean(walletMovement.groupReference) &&
        Boolean(walletMovement.escrowDebitTransaction) &&
        Boolean(walletMovement.employerCreditTransaction) &&
        Boolean(walletMovement.completedAt) &&
        String(this.completedTransaction) === String(walletMovement.employerCreditTransaction);

      if (!completedByRefund && !completedByWallet) {
        this.invalidate(
          "status",
          "A completed Paystack line requires a processed provider refund or automatic wallet fallback after provider failure."
        );
      }
    }
  }

  if (this.status === "failed") {
    if (
      !this.processingStartedAt ||
      !this.failedAt ||
      !this.failureReason ||
      Number(this.attemptCount || 0) < 1
    ) {
      this.invalidate("status", "A failed refund line requires processing and failure audit.");
    }

    if (
      this.completedAt ||
      this.completedTransaction ||
      this.finalExecutionMethod ||
      hasCancellationAudit ||
      hasWalletMovementAudit
    ) {
      this.invalidate("status", "A failed refund line cannot contain completion audit.");
    }

    if (this.fundingMethod === "paystack_checkout" && paystackRefund.status !== "failed") {
      this.invalidate(
        "status",
        "A Paystack line can fail only after the provider refund failed and wallet fallback also failed."
      );
    }
  }

  if (this.status === "cancelled") {
    if (!this.cancelledAt || !this.cancellationReason) {
      this.invalidate(
        "status",
        "A cancelled refund line requires cancelledAt and cancellationReason."
      );
    }

    if (
      this.pendingProviderAt ||
      this.awaitingActionAt ||
      this.completedAt ||
      this.failedAt ||
      this.failureReason ||
      hasArrayValues(executionTransactions) ||
      this.completedTransaction ||
      this.finalExecutionMethod ||
      hasWalletMovementAudit ||
      hasPaystackRefundAudit ||
      bankConsent.status !== "not_required" ||
      retry.status !== "not_required"
    ) {
      this.invalidate(
        "status",
        "A cancelled refund line cannot retain financial, provider, consent or terminal outcome audit."
      );
    }
  } else if (hasCancellationAudit) {
    this.invalidate("cancelledAt", "Refund-line cancellation details require cancelled status.");
  }

  if (this.status !== "completed" && this.finalExecutionMethod) {
    this.invalidate(
      "finalExecutionMethod",
      "finalExecutionMethod may only be set when the line is completed."
    );
  }

  if (
    this.completedTransaction &&
    !executionTransactionIds.includes(String(this.completedTransaction))
  ) {
    this.invalidate(
      "completedTransaction",
      "completedTransaction must be included in executionTransactions."
    );
  }

  if (hasDuplicateValues(executionTransactionIds)) {
    this.invalidate(
      "executionTransactions",
      "executionTransactions cannot contain duplicate Transaction references."
    );
  }

  if (
    this.pendingProviderAt &&
    this.processingStartedAt &&
    this.pendingProviderAt < this.processingStartedAt
  ) {
    this.invalidate(
      "pendingProviderAt",
      "pendingProviderAt cannot be earlier than processingStartedAt."
    );
  }

  if (
    this.awaitingActionAt &&
    this.processingStartedAt &&
    this.awaitingActionAt < this.processingStartedAt
  ) {
    this.invalidate(
      "awaitingActionAt",
      "awaitingActionAt cannot be earlier than processingStartedAt."
    );
  }

  if (this.completedAt && this.processingStartedAt && this.completedAt < this.processingStartedAt) {
    this.invalidate("completedAt", "completedAt cannot be earlier than processingStartedAt.");
  }

  if (this.failedAt && this.processingStartedAt && this.failedAt < this.processingStartedAt) {
    this.invalidate("failedAt", "failedAt cannot be earlier than processingStartedAt.");
  }

  if (this.cancelledAt && this.processingStartedAt && this.cancelledAt < this.processingStartedAt) {
    this.invalidate("cancelledAt", "cancelledAt cannot be earlier than processingStartedAt.");
  }
});

employerRefundBatchSchema.pre("validate", function validateEmployerRefundBatch() {
  const lines = Array.isArray(this.lines) ? this.lines : [];

  const lineReferences = [];
  const lineIdempotencyKeys = [];
  const allRefundIds = [];
  const allOccurrenceIds = [];
  const allShiftIds = [];
  const lineAmounts = [];
  const completedLineAmounts = [];
  const failedLineAmounts = [];
  const lineStatuses = [];
  const paystackRefundIds = [];
  const paystackRefundReferences = [];
  const paystackRefundIdempotencyKeys = [];
  const retryIdempotencyKeys = [];

  let walletLineCount = 0;

  for (const line of lines) {
    const allocations = Array.isArray(line.allocations) ? line.allocations : [];

    lineReferences.push(String(line.lineReference || ""));
    lineIdempotencyKeys.push(String(line.idempotencyKey || ""));
    lineAmounts.push(line.totalAmount);
    lineStatuses.push(line.status);

    if (line.status === "completed") {
      completedLineAmounts.push(line.totalAmount);
    }

    if (line.status === "failed") {
      failedLineAmounts.push(line.totalAmount);
    }

    if (line.fundingMethod === "wallet_balance") {
      walletLineCount += 1;
    }

    for (const allocation of allocations) {
      allRefundIds.push(String(allocation.employerRefund));
      allOccurrenceIds.push(String(allocation.occurrence));
      allShiftIds.push(String(allocation.shift));
    }

    const paystackRefund = line.paystackRefund || {};
    const retry = line.retry || {};

    if (paystackRefund.refundId) {
      paystackRefundIds.push(String(paystackRefund.refundId));
    }

    if (paystackRefund.reference) {
      paystackRefundReferences.push(String(paystackRefund.reference));
    }

    if (paystackRefund.idempotencyKey) {
      paystackRefundIdempotencyKeys.push(String(paystackRefund.idempotencyKey));
    }

    if (retry.idempotencyKey) {
      retryIdempotencyKeys.push(String(retry.idempotencyKey));
    }
  }

  if (this.refundDate && getLocalDateWeekday(this.refundDate) !== MONDAY_WEEKDAY) {
    this.invalidate("refundDate", "refundDate must be a Monday.");
  }

  if (this.cutoffAt && this.scheduledFor && this.scheduledFor <= this.cutoffAt) {
    this.invalidate("scheduledFor", "scheduledFor must be later than cutoffAt.");
  }

  if (hasDuplicateValues(lineReferences)) {
    this.invalidate("lines", "Each refund line must have a unique lineReference within the batch.");
  }

  if (hasDuplicateValues(lineIdempotencyKeys)) {
    this.invalidate(
      "lines",
      "Each refund line must have a unique idempotencyKey within the batch."
    );
  }

  if (hasDuplicateValues(allRefundIds)) {
    this.invalidate("lines", "An EmployerRefund cannot appear more than once in the batch.");
  }

  if (hasDuplicateValues(allOccurrenceIds)) {
    this.invalidate("lines", "A ShiftOccurrence cannot appear more than once in the batch.");
  }

  const shiftLineOwnership = new Map();

  for (const line of lines) {
    const allocations = Array.isArray(line.allocations) ? line.allocations : [];

    for (const allocation of allocations) {
      const shiftId = String(allocation.shift);
      const existingLineId = shiftLineOwnership.get(shiftId);

      if (existingLineId && existingLineId !== String(line._id)) {
        this.invalidate(
          "lines",
          "A Shift cannot appear in more than one execution line in the same batch."
        );

        break;
      }

      shiftLineOwnership.set(shiftId, String(line._id));
    }
  }

  const fundingTransactionLineOwnership = new Map();

  for (const line of lines) {
    const allocations = Array.isArray(line.allocations) ? line.allocations : [];

    for (const allocation of allocations) {
      const transactionId = String(allocation.originalFundingTransaction);
      const existingLineId = fundingTransactionLineOwnership.get(transactionId);

      if (existingLineId && existingLineId !== String(line._id)) {
        this.invalidate(
          "lines",
          "An original funding Transaction cannot appear in more than one execution line in the same batch."
        );

        break;
      }

      fundingTransactionLineOwnership.set(transactionId, String(line._id));
    }
  }

  if (hasDuplicateValues(paystackRefundIds)) {
    this.invalidate("lines", "A Paystack refund ID cannot appear in more than one line.");
  }

  if (hasDuplicateValues(paystackRefundReferences)) {
    this.invalidate("lines", "A Paystack refund reference cannot appear in more than one line.");
  }

  if (hasDuplicateValues(paystackRefundIdempotencyKeys)) {
    this.invalidate(
      "lines",
      "A Paystack refund idempotency key cannot appear in more than one line."
    );
  }

  if (hasDuplicateValues(retryIdempotencyKeys)) {
    this.invalidate("lines", "A Retry Refund idempotency key cannot appear in more than one line.");
  }

  if (walletLineCount > 1) {
    this.invalidate(
      "lines",
      "An employer refund batch may contain only one aggregated wallet refund line."
    );
  }

  const uniqueShiftIds = [...new Set(allShiftIds)];

  if (this.lineCount !== lines.length) {
    this.invalidate("lineCount", "lineCount must match the number of refund lines.");
  }

  if (this.shiftCount !== uniqueShiftIds.length) {
    this.invalidate("shiftCount", "shiftCount must match the number of unique included Shifts.");
  }

  if (this.occurrenceCount !== allOccurrenceIds.length) {
    this.invalidate(
      "occurrenceCount",
      "occurrenceCount must match the number of included ShiftOccurrences."
    );
  }

  if (this.refundCount !== allRefundIds.length) {
    this.invalidate(
      "refundCount",
      "refundCount must match the number of included EmployerRefund obligations."
    );
  }

  if (allOccurrenceIds.length !== allRefundIds.length) {
    this.invalidate(
      "refundCount",
      "Each included occurrence must have exactly one included EmployerRefund."
    );
  }

  const calculatedTotalAmount = sumSafeIntegerValues(lineAmounts);
  const calculatedCompletedAmount = sumSafeIntegerValues(completedLineAmounts);
  const calculatedFailedAmount = sumSafeIntegerValues(failedLineAmounts);

  if (calculatedTotalAmount === null) {
    this.invalidate("totalAmount", "Refund lines contain an invalid amount.");
  } else if (Number(this.totalAmount) !== calculatedTotalAmount) {
    this.invalidate("totalAmount", "totalAmount must equal the sum of all refund lines.");
  }

  if (calculatedCompletedAmount === null) {
    this.invalidate("completedAmount", "Completed refund lines contain an invalid amount.");
  } else if (Number(this.completedAmount) !== calculatedCompletedAmount) {
    this.invalidate(
      "completedAmount",
      "completedAmount must equal the sum of completed refund lines."
    );
  }

  if (calculatedFailedAmount === null) {
    this.invalidate("failedAmount", "Failed refund lines contain an invalid amount.");
  } else if (Number(this.failedAmount) !== calculatedFailedAmount) {
    this.invalidate("failedAmount", "failedAmount must equal the sum of failed refund lines.");
  }

  if (
    Number(this.completedAmount || 0) + Number(this.failedAmount || 0) >
    Number(this.totalAmount || 0)
  ) {
    this.invalidate(
      "completedAmount",
      "completedAmount and failedAmount cannot exceed totalAmount."
    );
  }

  if (this.initiatedBy === "system" && this.initiatedByUser) {
    this.invalidate(
      "initiatedByUser",
      "A system-initiated refund batch cannot contain initiatedByUser."
    );
  }

  if (this.initiatedBy === "admin" && !this.initiatedByUser) {
    this.invalidate("initiatedByUser", "An admin-initiated refund batch requires initiatedByUser.");
  }

  const lockValues = [this.processingToken, this.lockedAt, this.lockExpiresAt];
  const hasAnyLock = hasAny(lockValues);
  const hasCompleteLock = hasAll(lockValues);

  if (hasAnyLock && !hasCompleteLock) {
    this.invalidate(
      "processingToken",
      "The refund-run lock requires processingToken, lockedAt and lockExpiresAt together."
    );
  }

  if (this.lockedAt && this.lockExpiresAt && this.lockExpiresAt <= this.lockedAt) {
    this.invalidate("lockExpiresAt", "lockExpiresAt must be later than lockedAt.");
  }

  if (hasCompleteLock && this.status !== "processing") {
    this.invalidate("status", "An active refund-run lock requires processing status.");
  }

  if (Number(this.attemptCount || 0) === 0 && this.lastAttemptAt) {
    this.invalidate(
      "lastAttemptAt",
      "lastAttemptAt requires at least one batch-processing attempt."
    );
  }

  if (Number(this.attemptCount || 0) > 0 && !this.lastAttemptAt) {
    this.invalidate("lastAttemptAt", "A batch with processing attempts requires lastAttemptAt.");
  }

  if (this.processingStartedAt && (Number(this.attemptCount || 0) < 1 || !this.lastAttemptAt)) {
    this.invalidate(
      "processingStartedAt",
      "processingStartedAt requires at least one batch-processing attempt."
    );
  }

  if (
    this.processingStartedAt &&
    this.lastAttemptAt &&
    this.processingStartedAt > this.lastAttemptAt
  ) {
    this.invalidate(
      "processingStartedAt",
      "processingStartedAt cannot be later than lastAttemptAt."
    );
  }

  if (Boolean(this.lastFailedAt) !== Boolean(this.lastFailureReason)) {
    this.invalidate(
      "lastFailureReason",
      "lastFailedAt and lastFailureReason must be recorded together."
    );
  }

  const queuedLineCount = lineStatuses.filter((status) => status === "queued").length;
  const processingLineCount = lineStatuses.filter((status) => status === "processing").length;

  const pendingProviderLineCount = lineStatuses.filter(
    (status) => status === "pending_provider"
  ).length;

  const awaitingActionLineCount = lineStatuses.filter(
    (status) => status === "awaiting_action"
  ).length;

  const completedLineCount = lineStatuses.filter((status) => status === "completed").length;
  const failedLineCount = lineStatuses.filter((status) => status === "failed").length;
  const cancelledLineCount = lineStatuses.filter((status) => status === "cancelled").length;

  const allLinesQueued = lines.length > 0 && queuedLineCount === lines.length;
  const allLinesCompleted = lines.length > 0 && completedLineCount === lines.length;
  const allLinesCancelled = lines.length > 0 && cancelledLineCount === lines.length;

  const allLinesTerminal =
    lines.length > 0 &&
    lineStatuses.every((status) => TERMINAL_REFUND_LINE_STATUSES.includes(status));

  if (this.status === "scheduled") {
    if (!allLinesQueued) {
      this.invalidate("status", "A scheduled refund batch requires every line to remain queued.");
    }

    if (
      Number(this.attemptCount || 0) !== 0 ||
      this.lastAttemptAt ||
      this.processingStartedAt ||
      this.awaitingProviderAt ||
      this.awaitingActionAt ||
      this.partiallyCompletedAt ||
      this.completedAt ||
      this.lastFailedAt ||
      this.lastFailureReason ||
      hasAnyLock
    ) {
      this.invalidate("status", "A scheduled refund batch cannot contain processing audit.");
    }
  }

  if (this.status === "processing") {
    if (
      !this.processingStartedAt ||
      Number(this.attemptCount || 0) < 1 ||
      !this.lastAttemptAt ||
      !hasCompleteLock
    ) {
      this.invalidate(
        "status",
        "A processing refund batch requires processing audit and a complete lock."
      );
    }

    if (queuedLineCount + processingLineCount < 1) {
      this.invalidate(
        "status",
        "A processing refund batch requires at least one queued or processing line."
      );
    }

    if (this.completedAt || this.cancelledAt) {
      this.invalidate(
        "status",
        "A processing refund batch cannot contain completion or cancellation audit."
      );
    }
  }

  if (this.status === "awaiting_provider") {
    if (pendingProviderLineCount < 1) {
      this.invalidate("status", "awaiting_provider requires a provider-pending line.");
    }

    if (queuedLineCount > 0 || processingLineCount > 0 || awaitingActionLineCount > 0) {
      this.invalidate(
        "status",
        "awaiting_provider cannot retain queued, processing or action-required lines."
      );
    }

    if (!this.awaitingProviderAt) {
      this.invalidate("awaitingProviderAt", "awaiting_provider requires awaitingProviderAt.");
    }

    if (hasAnyLock) {
      this.invalidate("processingToken", "A provider-pending batch cannot retain its lock.");
    }

    if (this.completedAt || this.cancelledAt) {
      this.invalidate(
        "status",
        "A provider-pending batch cannot contain completion or cancellation audit."
      );
    }
  }

  if (this.status === "awaiting_action") {
    if (awaitingActionLineCount < 1) {
      this.invalidate("status", "awaiting_action requires an action-required line.");
    }

    if (queuedLineCount > 0 || processingLineCount > 0) {
      this.invalidate("status", "awaiting_action cannot retain queued or processing lines.");
    }

    if (!this.awaitingActionAt) {
      this.invalidate("awaitingActionAt", "awaiting_action requires awaitingActionAt.");
    }

    if (hasAnyLock) {
      this.invalidate("processingToken", "An action-required batch cannot retain its lock.");
    }

    if (this.completedAt || this.cancelledAt) {
      this.invalidate(
        "status",
        "An action-required batch cannot contain completion or cancellation audit."
      );
    }
  }

  if (this.status === "partially_completed") {
    if (!allLinesTerminal || completedLineCount < 1 || completedLineCount === lines.length) {
      this.invalidate(
        "status",
        "partially_completed requires terminal lines with both completed and failed/cancelled outcomes."
      );
    }

    if (failedLineCount + cancelledLineCount < 1) {
      this.invalidate(
        "status",
        "partially_completed requires at least one failed or cancelled line."
      );
    }

    if (!this.partiallyCompletedAt) {
      this.invalidate("partiallyCompletedAt", "partially_completed requires partiallyCompletedAt.");
    }

    if (this.completedAt || this.cancelledAt || hasAnyLock) {
      this.invalidate(
        "status",
        "A partially completed batch cannot retain completion, cancellation or lock details."
      );
    }
  } else if (this.partiallyCompletedAt) {
    this.invalidate(
      "partiallyCompletedAt",
      "partiallyCompletedAt requires partially_completed status."
    );
  }

  if (this.status === "completed") {
    if (!allLinesCompleted) {
      this.invalidate("status", "A completed refund batch requires every line to be completed.");
    }

    if (!this.completedAt) {
      this.invalidate("completedAt", "A completed refund batch requires completedAt.");
    }

    if (
      Number(this.completedAmount) !== Number(this.totalAmount) ||
      Number(this.failedAmount) !== 0
    ) {
      this.invalidate(
        "completedAmount",
        "A completed refund batch requires full completedAmount and zero failedAmount."
      );
    }

    if (hasAnyLock || this.cancelledAt) {
      this.invalidate(
        "status",
        "A completed refund batch cannot retain lock or cancellation details."
      );
    }
  } else if (this.completedAt) {
    this.invalidate("completedAt", "completedAt may only be set when the batch is completed.");
  }

  if (this.status === "failed") {
    if (!allLinesTerminal || failedLineCount < 1 || completedLineCount > 0) {
      this.invalidate(
        "status",
        "A failed refund batch requires terminal lines, at least one failed line and no completed lines."
      );
    }

    if (!this.lastFailedAt || !this.lastFailureReason) {
      this.invalidate(
        "lastFailureReason",
        "A failed refund batch requires lastFailedAt and lastFailureReason."
      );
    }

    if (hasAnyLock || this.completedAt || this.cancelledAt) {
      this.invalidate(
        "status",
        "A failed refund batch cannot retain lock, completion or cancellation details."
      );
    }
  }

  const hasCancellationAudit = hasAny([
    this.cancelledAt,
    this.cancelledBy,
    this.cancelledByUser,
    this.cancellationReason,
  ]);

  if (this.status === "cancelled") {
    if (!allLinesCancelled) {
      this.invalidate("status", "A cancelled refund batch requires every line to be cancelled.");
    }

    if (!this.cancelledAt || !this.cancelledBy || !this.cancellationReason) {
      this.invalidate(
        "status",
        "A cancelled refund batch requires cancelledAt, cancelledBy and cancellationReason."
      );
    }

    if (this.cancelledBy === "admin" && !this.cancelledByUser) {
      this.invalidate("cancelledByUser", "Admin cancellation requires cancelledByUser.");
    }

    if (this.cancelledBy === "system" && this.cancelledByUser) {
      this.invalidate("cancelledByUser", "System cancellation cannot contain cancelledByUser.");
    }

    if (
      this.awaitingProviderAt ||
      this.awaitingActionAt ||
      this.partiallyCompletedAt ||
      this.completedAt ||
      hasAnyLock
    ) {
      this.invalidate(
        "status",
        "A cancelled refund batch cannot retain provider, action, completion or active-lock audit."
      );
    }
  } else if (hasCancellationAudit) {
    this.invalidate("cancelledAt", "Batch cancellation audit requires cancelled status.");
  }

  if (
    this.awaitingProviderAt &&
    this.processingStartedAt &&
    this.awaitingProviderAt < this.processingStartedAt
  ) {
    this.invalidate(
      "awaitingProviderAt",
      "awaitingProviderAt cannot be earlier than processingStartedAt."
    );
  }

  if (
    this.awaitingActionAt &&
    this.processingStartedAt &&
    this.awaitingActionAt < this.processingStartedAt
  ) {
    this.invalidate(
      "awaitingActionAt",
      "awaitingActionAt cannot be earlier than processingStartedAt."
    );
  }

  if (
    this.partiallyCompletedAt &&
    this.processingStartedAt &&
    this.partiallyCompletedAt < this.processingStartedAt
  ) {
    this.invalidate(
      "partiallyCompletedAt",
      "partiallyCompletedAt cannot be earlier than processingStartedAt."
    );
  }

  if (this.completedAt && this.processingStartedAt && this.completedAt < this.processingStartedAt) {
    this.invalidate("completedAt", "completedAt cannot be earlier than processingStartedAt.");
  }

  if (
    this.lastFailedAt &&
    this.processingStartedAt &&
    this.lastFailedAt < this.processingStartedAt
  ) {
    this.invalidate("lastFailedAt", "lastFailedAt cannot be earlier than processingStartedAt.");
  }

  if (this.cancelledAt && this.processingStartedAt && this.cancelledAt < this.processingStartedAt) {
    this.invalidate("cancelledAt", "cancelledAt cannot be earlier than processingStartedAt.");
  }
});

employerRefundBatchSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

employerRefundBatchSchema.index(
  {
    idempotencyKey: 1,
  },
  {
    unique: true,
  }
);

employerRefundBatchSchema.index(
  {
    business: 1,
    countryCode: 1,
    currency: 1,
    cycleKey: 1,
  },
  {
    unique: true,
  }
);

employerRefundBatchSchema.index(
  {
    processingToken: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      processingToken: {
        $type: "string",
      },
    },
  }
);

employerRefundBatchSchema.index(
  {
    "lines.idempotencyKey": 1,
  },
  {
    unique: true,
  }
);

employerRefundBatchSchema.index(
  {
    "lines.paystackRefund.idempotencyKey": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "lines.paystackRefund.idempotencyKey": {
        $type: "string",
      },
    },
  }
);

employerRefundBatchSchema.index(
  {
    "lines.retry.idempotencyKey": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "lines.retry.idempotencyKey": {
        $type: "string",
      },
    },
  }
);

employerRefundBatchSchema.index(
  {
    "lines.paystackRefund.refundId": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "lines.paystackRefund.refundId": {
        $type: "string",
      },
    },
  }
);

employerRefundBatchSchema.index(
  {
    "lines.paystackRefund.reference": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "lines.paystackRefund.reference": {
        $type: "string",
      },
    },
  }
);

// Historical cancelled allocations remain indexed but non-unique so they can be rebatched.
employerRefundBatchSchema.index({
  "lines.allocations.employerRefund": 1,
});

employerRefundBatchSchema.index({
  "lines.allocations.occurrence": 1,
});

employerRefundBatchSchema.index({
  status: 1,
  scheduledFor: 1,
});

employerRefundBatchSchema.index({
  business: 1,
  refundDate: -1,
});

employerRefundBatchSchema.index({
  business: 1,
  status: 1,
  scheduledFor: 1,
});

employerRefundBatchSchema.index({
  countryCode: 1,
  currency: 1,
  status: 1,
  scheduledFor: 1,
});

employerRefundBatchSchema.index({
  lockExpiresAt: 1,
});

employerRefundBatchSchema.index({
  "lines.allocations.shift": 1,
});

employerRefundBatchSchema.index({
  "lines.allocations.originalFundingTransaction": 1,
});

employerRefundBatchSchema.index({
  "lines.status": 1,
  scheduledFor: 1,
});

employerRefundBatchSchema.index({
  "lines.originalPaystackReference": 1,
});

employerRefundBatchSchema.index({
  "lines.paystackRefund.status": 1,
  "lines.paystackRefund.lastSyncedAt": 1,
});

employerRefundBatchSchema.index({
  "lines.bankConsent.status": 1,
  "lines.bankConsent.requestedAt": 1,
});

employerRefundBatchSchema.index({
  "lines.retry.status": 1,
  "lines.retry.queuedAt": 1,
});

employerRefundBatchSchema.index({
  employerWallet: 1,
  refundDate: -1,
});

employerRefundBatchSchema.index({
  escrowWallet: 1,
  refundDate: -1,
});

module.exports = mongoose.model("EmployerRefundBatch", employerRefundBatchSchema);
