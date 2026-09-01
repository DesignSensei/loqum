// models/EmployerRefund.js

const mongoose = require("mongoose");

const {
  minorUnitAmountField,
  requiredPositiveMinorUnitAmountField,
} = require("./helpers/schemaFields");

const {
  REFUND_STATUSES,
  REFUND_EXECUTION_STATUSES,
  REFUND_HOLD_REASONS,
  REFUND_REASONS,
  EMPLOYER_REFUND_FUNDING_METHODS,
} = require("../constants/shiftLifecycle");

/* ─────────────────────────────── CONSTANTS ─────────────────────────────── */

const EMPLOYER_REFUND_STATUSES = Object.freeze([
  ...REFUND_STATUSES.filter((status) => status !== "not_eligible"),
  "voided",
]);

const EMPLOYER_REFUND_RESERVATION_STATUSES = Object.freeze(["reserved", "released"]);

const EMPLOYER_REFUND_FINAL_EXECUTION_METHODS = Object.freeze([
  "wallet_balance",
  "paystack_refund",
]);

const REFUND_PROCESSING_STATUSES = Object.freeze(
  REFUND_EXECUTION_STATUSES.filter((status) => status !== "batched")
);

const PROFESSIONAL_CLAIM_HOLD_REASON = "professional_claim_pending";
const EMPLOYER_DISPUTE_HOLD_REASON = "employer_dispute_pending";

const TERMINAL_EMPLOYER_REFUND_STATUSES = Object.freeze(["refunded", "voided"]);

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

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

const hasArrayValues = (values) => Array.isArray(values) && values.length > 0;

/* ─────────────────────────────── EMPLOYER REFUND ─────────────────────────────── */

/*
 * One positive scheduled/base refund obligation per occurrence.
 * ShiftRefundService owns amount/blocker truth; EmployerRefundBatch owns execution.
 */
const employerRefundSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
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

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
      immutable: true,
    },

    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      required: true,
      immutable: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      immutable: true,
    },

    // --- CURRENT HOLD CASE ---

    claim: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrenceClaim",
      default: null,
    },

    dispute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrenceDispute",
      default: null,
    },

    // --- MONEY ---

    amount: requiredPositiveMinorUnitAmountField(),

    refundedAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

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

    // --- ORIGINAL SHIFT FUNDING SOURCE ---

    // Immutable source used to fund the parent Shift.
    fundingMethod: {
      type: String,
      enum: EMPLOYER_REFUND_FUNDING_METHODS,
      required: true,
      immutable: true,
    },

    originalFundingTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
      immutable: true,
    },

    originalPaystackReference: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
      immutable: true,
    },

    // --- REFUND ENTITLEMENT ---

    status: {
      type: String,
      enum: EMPLOYER_REFUND_STATUSES,
      required: true,
    },

    reason: {
      type: String,
      enum: REFUND_REASONS,
      required: true,
    },

    holdReason: {
      type: String,
      enum: [...REFUND_HOLD_REASONS, null],
      default: null,
    },

    lastEvaluatedAt: {
      type: Date,
      required: true,
    },

    heldAt: {
      type: Date,
      default: null,
    },

    eligibleAt: {
      type: Date,
      default: null,
    },

    scheduledProcessingAt: {
      type: Date,
      default: null,
    },

    // --- ESCROW RESERVATION ---

    reservationStatus: {
      type: String,
      enum: EMPLOYER_REFUND_RESERVATION_STATUSES,
      default: "reserved",
      required: true,
    },

    reservedAt: {
      type: Date,
      default: null,
      required: true,
    },

    reservationReleasedAt: {
      type: Date,
      default: null,
    },

    // --- WEEKLY REFUND BATCH ---

    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefundBatch",
      default: null,
    },

    batchLineId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    batchedAt: {
      type: Date,
      default: null,
    },

    // --- FINANCIAL EXECUTION ---

    executionMethod: {
      type: String,
      enum: [...EMPLOYER_REFUND_FINAL_EXECUTION_METHODS, null],
      default: null,
    },

    executionStartedAt: {
      type: Date,
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

    refundedAt: {
      type: Date,
      default: null,
    },

    // --- VOID AUDIT ---

    voidedAt: {
      type: Date,
      default: null,
    },

    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    voidReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

employerRefundSchema.pre("validate", function validateEmployerRefund() {
  if (!this.reservedAt && this.lastEvaluatedAt) {
    this.reservedAt = this.lastEvaluatedAt;
  }

  const refundedAmount = Number(this.refundedAmount || 0);

  const executionTransactions = Array.isArray(this.executionTransactions)
    ? this.executionTransactions
    : [];

  const hasBatchAudit = hasAny([this.batch, this.batchLineId, this.batchedAt]);

  const hasExecutionAudit =
    REFUND_PROCESSING_STATUSES.includes(this.status) ||
    hasAny([
      this.executionMethod,
      this.executionStartedAt,
      this.completedTransaction,
      this.refundedAt,
    ]) ||
    hasArrayValues(executionTransactions) ||
    refundedAmount > 0;

  const hasVoidAudit = hasAny([this.voidedAt, this.voidedBy, this.voidReason]);

  /* ─────────────────────────────── FUNDING SOURCE ─────────────────────────────── */

  if (this.fundingMethod === "wallet_balance" && this.originalPaystackReference) {
    this.invalidate(
      "originalPaystackReference",
      "A wallet-funded employer refund cannot contain an original Paystack reference."
    );
  }

  if (this.fundingMethod === "paystack_checkout" && !this.originalPaystackReference) {
    this.invalidate(
      "originalPaystackReference",
      "A Paystack-funded employer refund requires the original Paystack reference."
    );
  }

  /* ─────────────────────────────── REFUNDED AMOUNT ─────────────────────────────── */

  if (!Number.isSafeInteger(refundedAmount) || refundedAmount < 0) {
    this.invalidate(
      "refundedAmount",
      "refundedAmount must be a non-negative integer minor-unit amount."
    );
  }

  if (refundedAmount > Number(this.amount || 0)) {
    this.invalidate("refundedAmount", "refundedAmount cannot exceed amount.");
  }

  /* ─────────────────────────────── CURRENT HOLD CASE ─────────────────────────────── */

  if (this.status === "held") {
    if (!this.holdReason || !this.heldAt) {
      this.invalidate("holdReason", "A held employer refund requires holdReason and heldAt.");
    }

    if (this.holdReason === PROFESSIONAL_CLAIM_HOLD_REASON) {
      if (!this.claim) {
        this.invalidate(
          "claim",
          "professional_claim_pending requires the active professional claim."
        );
      }

      if (this.dispute) {
        this.invalidate(
          "dispute",
          "professional_claim_pending cannot simultaneously reference an employer dispute."
        );
      }
    } else if (this.holdReason === EMPLOYER_DISPUTE_HOLD_REASON) {
      if (!this.dispute) {
        this.invalidate(
          "dispute",
          "employer_dispute_pending requires the active employer dispute."
        );
      }

      if (this.claim) {
        this.invalidate(
          "claim",
          "employer_dispute_pending cannot simultaneously reference a professional claim."
        );
      }
    } else if (this.claim || this.dispute) {
      this.invalidate(
        "holdReason",
        "Only claim- or dispute-specific hold reasons may carry a current claim or dispute link."
      );
    }
  } else {
    if (this.holdReason || this.heldAt) {
      this.invalidate("holdReason", "holdReason and heldAt require held status.");
    }

    if (this.claim || this.dispute) {
      this.invalidate(
        "status",
        "Current claim and dispute links may exist only while the refund is held by that case."
      );
    }
  }

  /* ─────────────────────────────── HELD ─────────────────────────────── */

  if (this.status === "held") {
    if (this.eligibleAt || this.scheduledProcessingAt) {
      this.invalidate(
        "eligibleAt",
        "A held employer refund cannot contain eligibility or scheduled-processing audit."
      );
    }

    if (hasBatchAudit || hasExecutionAudit || hasVoidAudit) {
      this.invalidate(
        "status",
        "A held employer refund cannot contain batch, execution, completion or void audit."
      );
    }

    if (this.reservationStatus !== "reserved" || this.reservationReleasedAt) {
      this.invalidate(
        "reservationStatus",
        "A held employer refund must retain its escrow reservation."
      );
    }
  }

  /* ─────────────────────────────── ELIGIBLE ─────────────────────────────── */

  if (this.status === "eligible") {
    if (!this.eligibleAt || !this.scheduledProcessingAt) {
      this.invalidate(
        "eligibleAt",
        "An eligible employer refund requires eligibleAt and scheduledProcessingAt."
      );
    }

    if (hasBatchAudit || hasExecutionAudit || hasVoidAudit) {
      this.invalidate(
        "status",
        "An eligible employer refund cannot contain batch, execution, completion or void audit."
      );
    }

    if (this.reservationStatus !== "reserved" || this.reservationReleasedAt) {
      this.invalidate(
        "reservationStatus",
        "An eligible employer refund must retain its escrow reservation."
      );
    }
  }

  /* ─────────────────────────────── BATCHED ─────────────────────────────── */

  if (this.status === "batched") {
    if (!this.batch || !this.batchLineId || !this.batchedAt) {
      this.invalidate(
        "status",
        "A batched employer refund requires batch, batchLineId and batchedAt."
      );
    }

    if (!this.eligibleAt || !this.scheduledProcessingAt) {
      this.invalidate(
        "eligibleAt",
        "A batched employer refund must retain its eligibility and scheduling audit."
      );
    }

    if (
      this.executionMethod ||
      this.executionStartedAt ||
      hasArrayValues(executionTransactions) ||
      this.completedTransaction ||
      refundedAmount > 0 ||
      this.refundedAt
    ) {
      this.invalidate(
        "status",
        "A batched employer refund cannot contain financial execution or completion audit."
      );
    }

    if (hasVoidAudit) {
      this.invalidate("voidedAt", "A batched employer refund cannot contain void audit.");
    }

    if (this.reservationStatus !== "reserved" || this.reservationReleasedAt) {
      this.invalidate(
        "reservationStatus",
        "A batched employer refund must retain its escrow reservation."
      );
    }
  }

  /* ─────────────────────────────── PROCESSING ─────────────────────────────── */

  if (this.status === "processing") {
    if (!this.batch || !this.batchLineId || !this.batchedAt) {
      this.invalidate(
        "status",
        "A processing employer refund requires its exact batch and execution-line ownership."
      );
    }

    if (!this.executionMethod || !this.executionStartedAt) {
      this.invalidate(
        "executionMethod",
        "A processing employer refund requires executionMethod and executionStartedAt."
      );
    }

    if (refundedAmount > 0 || this.completedTransaction || this.refundedAt) {
      this.invalidate(
        "status",
        "A processing employer refund cannot contain completed-refund audit."
      );
    }

    if (hasVoidAudit) {
      this.invalidate("voidedAt", "A processing employer refund cannot contain void audit.");
    }

    if (this.reservationStatus !== "reserved" || this.reservationReleasedAt) {
      this.invalidate(
        "reservationStatus",
        "A processing employer refund must retain its escrow reservation until completion."
      );
    }
  }

  /* ─────────────────────────────── REFUNDED ─────────────────────────────── */

  if (this.status === "refunded") {
    if (!this.batch || !this.batchLineId || !this.batchedAt) {
      this.invalidate(
        "status",
        "A refunded employer refund must retain its exact batch and execution-line audit."
      );
    }

    if (!this.executionMethod || !this.executionStartedAt) {
      this.invalidate(
        "executionMethod",
        "A refunded employer refund requires executionMethod and executionStartedAt."
      );
    }

    if (!hasArrayValues(executionTransactions)) {
      this.invalidate(
        "executionTransactions",
        "A refunded employer refund requires at least one execution Transaction."
      );
    }

    if (!this.completedTransaction || !this.refundedAt) {
      this.invalidate(
        "completedTransaction",
        "A refunded employer refund requires completedTransaction and refundedAt."
      );
    }

    if (refundedAmount !== Number(this.amount)) {
      this.invalidate(
        "refundedAmount",
        "A refunded employer refund requires refundedAmount to equal the full obligation amount."
      );
    }

    if (hasVoidAudit) {
      this.invalidate("voidedAt", "A refunded employer refund cannot contain void audit.");
    }

    if (this.reservationStatus !== "released" || !this.reservationReleasedAt) {
      this.invalidate(
        "reservationStatus",
        "A refunded obligation must release its escrow reservation."
      );
    }
  }

  /* ─────────────────────────────── VOIDED ─────────────────────────────── */

  if (this.status === "voided") {
    if (!this.voidedAt || !this.voidReason) {
      this.invalidate("voidedAt", "A voided employer refund requires voidedAt and voidReason.");
    }

    if (this.holdReason || this.claim || this.dispute || this.heldAt) {
      this.invalidate(
        "status",
        "A voided employer refund cannot retain an active hold or current case link."
      );
    }

    if (this.eligibleAt || this.scheduledProcessingAt) {
      this.invalidate(
        "eligibleAt",
        "A voided employer refund cannot retain active eligibility or scheduling audit."
      );
    }

    if (hasBatchAudit || hasExecutionAudit || refundedAmount !== 0) {
      this.invalidate(
        "status",
        "An employer refund may only be voided before batching or execution."
      );
    }

    if (this.reservationStatus !== "released" || !this.reservationReleasedAt) {
      this.invalidate(
        "reservationStatus",
        "A voided obligation must release its escrow reservation."
      );
    }
  } else if (hasVoidAudit) {
    this.invalidate("voidedAt", "Void audit details require status voided.");
  }

  /* ─────────────────────────────── RESERVATION ─────────────────────────────── */

  if (
    this.reservationReleasedAt &&
    this.reservedAt &&
    this.reservationReleasedAt < this.reservedAt
  ) {
    this.invalidate(
      "reservationReleasedAt",
      "reservationReleasedAt cannot be earlier than reservedAt."
    );
  }

  if (this.reservationStatus === "reserved" && this.reservationReleasedAt) {
    this.invalidate(
      "reservationReleasedAt",
      "A reserved obligation cannot contain reservationReleasedAt."
    );
  }

  if (this.reservationStatus === "released" && !this.reservationReleasedAt) {
    this.invalidate(
      "reservationReleasedAt",
      "A released reservation requires reservationReleasedAt."
    );
  }

  if (
    !TERMINAL_EMPLOYER_REFUND_STATUSES.includes(this.status) &&
    this.reservationStatus !== "reserved"
  ) {
    this.invalidate(
      "reservationStatus",
      "An open employer refund obligation must remain reserved."
    );
  }

  /* ─────────────────────────────── DATE ORDERING ─────────────────────────────── */

  if (this.reservedAt && this.lastEvaluatedAt && this.reservedAt > this.lastEvaluatedAt) {
    this.invalidate("reservedAt", "reservedAt cannot be later than lastEvaluatedAt.");
  }

  if (this.eligibleAt && this.lastEvaluatedAt && this.eligibleAt > this.lastEvaluatedAt) {
    this.invalidate("eligibleAt", "eligibleAt cannot be later than lastEvaluatedAt.");
  }

  if (
    this.scheduledProcessingAt &&
    this.eligibleAt &&
    this.scheduledProcessingAt < this.eligibleAt
  ) {
    this.invalidate(
      "scheduledProcessingAt",
      "scheduledProcessingAt cannot be earlier than eligibleAt."
    );
  }

  if (this.batchedAt && this.eligibleAt && this.batchedAt < this.eligibleAt) {
    this.invalidate("batchedAt", "batchedAt cannot be earlier than eligibleAt.");
  }

  if (this.executionStartedAt && this.batchedAt && this.executionStartedAt < this.batchedAt) {
    this.invalidate("executionStartedAt", "executionStartedAt cannot be earlier than batchedAt.");
  }

  if (this.refundedAt && this.executionStartedAt && this.refundedAt < this.executionStartedAt) {
    this.invalidate("refundedAt", "refundedAt cannot be earlier than executionStartedAt.");
  }

  /* ─────────────────────────────── EXECUTION METHOD COMPATIBILITY ─────────────────────────────── */

  if (
    this.fundingMethod === "wallet_balance" &&
    this.executionMethod &&
    this.executionMethod !== "wallet_balance"
  ) {
    this.invalidate(
      "executionMethod",
      "A wallet-funded employer refund can only execute through wallet_balance."
    );
  }

  if (
    this.fundingMethod === "paystack_checkout" &&
    this.executionMethod &&
    !["paystack_refund", "wallet_balance"].includes(this.executionMethod)
  ) {
    this.invalidate(
      "executionMethod",
      "A Paystack-funded employer refund may complete only through paystack_refund or wallet_balance."
    );
  }

  if (this.executionMethod === "paystack_refund" && this.fundingMethod !== "paystack_checkout") {
    this.invalidate(
      "executionMethod",
      "paystack_refund execution requires Paystack Checkout funding."
    );
  }

  /* ─────────────────────────────── EXECUTION TRANSACTION UNIQUENESS ─────────────────────────────── */

  const transactionIds = executionTransactions.map((transactionId) => String(transactionId));

  if (new Set(transactionIds).size !== transactionIds.length) {
    this.invalidate(
      "executionTransactions",
      "executionTransactions cannot contain duplicate Transaction references."
    );
  }

  if (this.completedTransaction && !transactionIds.includes(String(this.completedTransaction))) {
    this.invalidate(
      "completedTransaction",
      "completedTransaction must also be included in executionTransactions."
    );
  }

  /* ─────────────────────────────── COMPLETED DETAILS ─────────────────────────────── */

  if (
    this.status !== "refunded" &&
    (refundedAmount > 0 || this.completedTransaction || this.refundedAt)
  ) {
    this.invalidate("status", "Completed refund details require refunded status.");
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

employerRefundSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

employerRefundSchema.index(
  {
    idempotencyKey: 1,
  },
  {
    unique: true,
  }
);

// One authoritative refund obligation per occurrence; voided records may be reactivated.
employerRefundSchema.index(
  {
    occurrence: 1,
  },
  {
    unique: true,
  }
);

employerRefundSchema.index({
  shift: 1,
  status: 1,
});

employerRefundSchema.index({
  business: 1,
  status: 1,
  scheduledProcessingAt: 1,
});

employerRefundSchema.index({
  status: 1,
  scheduledProcessingAt: 1,
  lastEvaluatedAt: 1,
});

employerRefundSchema.index({
  batch: 1,
  batchLineId: 1,
});

employerRefundSchema.index({
  originalFundingTransaction: 1,
  status: 1,
});

employerRefundSchema.index({
  originalPaystackReference: 1,
  status: 1,
});

employerRefundSchema.index({
  fundingMethod: 1,
  status: 1,
  scheduledProcessingAt: 1,
});

employerRefundSchema.index({
  reservationStatus: 1,
  status: 1,
});

employerRefundSchema.index({
  claim: 1,
});

employerRefundSchema.index({
  dispute: 1,
});

employerRefundSchema.index({
  completedTransaction: 1,
});

employerRefundSchema.index({
  executionTransactions: 1,
});

module.exports = mongoose.model("EmployerRefund", employerRefundSchema);
