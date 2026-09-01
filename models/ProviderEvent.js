// models/ProviderEvent.js

const mongoose = require("mongoose");

/**
 * PROVIDER EVENT MODEL:
 *
 * Stores raw and normalized payment-provider events before they affect wallets,
 * transactions, Shifts, withdrawals or employer refund execution.
 *
 * This model is provider-facing.
 * Transaction.js remains the wallet ledger.
 *
 * Why this exists:
 * - Prevent duplicate provider events from being processed twice.
 * - Store raw provider payloads for audit/debugging.
 * - Track whether an event was processed, failed or ignored.
 * - Preserve first and latest processing-attempt timestamps.
 * - Fence each active processing attempt with a unique ownership claim.
 * - Keep provider webhook logic separate from wallet ledger logic.
 * - Preserve provider-side refund state independently from Loqum refund obligations.
 *
 * EMPLOYER REFUND FLOW:
 *
 * Paystack refund webhook received
 * → ProviderEvent recorded first
 * → refund event normalized
 * → employer refund batch/line resolved
 * → EmployerRefundBatchService synchronizes provider refund state
 * → escrow ledger movement is written only when the provider refund is processed
 * → ProviderEvent marked processed
 *
 * IMPORTANT:
 *
 * EmployerRefund is the occurrence-level refund obligation.
 * EmployerRefundBatch is the execution container.
 *
 * A Paystack refund provider event belongs to the batch execution line, not to
 * one individual EmployerRefund allocation, because one external refund can
 * aggregate multiple occurrence-level refund obligations from the same Shift
 * payment.
 *
 * PROCESSING OWNERSHIP:
 *
 * processingStartedAt
 * → first-ever processing attempt.
 *
 * lastProcessingStartedAt
 * → latest successful processing claim.
 *
 * processingClaimId
 * → current processing attempt's ownership token.
 *
 * processingClaimId exists only while status is processing. A worker must
 * present the same claim when attempting to complete, fail or ignore that
 * processing attempt. Once the event leaves processing, the claim is cleared.
 */

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const isOptionalNonNegativeInteger = (value) =>
  value === null || value === undefined || isNonNegativeInteger(value);

const PAYSTACK_REFUND_EVENT_NAMES = Object.freeze([
  "refund.pending",
  "refund.processing",
  "refund.needs-attention",
  "refund.failed",
  "refund.processed",
]);

const providerEventSchema = new mongoose.Schema(
  {
    // --- PROVIDER IDENTITY ---

    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      // Example: paystack.
    },

    eventKey: {
      type: String,
      required: true,
      trim: true,
      // Internal unique key used for idempotency.
      //
      // Example:
      // paystack:event:123456
      //
      // Example:
      // paystack:charge.success:reference:trx_xxxxx
    },

    providerEventId: {
      type: String,
      trim: true,
      default: null,
      // Provider's own webhook/event ID if available.
    },

    providerReference: {
      type: String,
      trim: true,
      default: null,
      // Provider payment/transfer/reference used for general event lookup.
    },

    providerRefundId: {
      type: String,
      trim: true,
      default: null,
      // Provider refund ID when available.
      // Example: Paystack refund ID returned by the Refund API.
    },

    providerRefundReference: {
      type: String,
      trim: true,
      default: null,
      // Provider refund reference from refund webhook/API payload when available.
    },

    eventName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      // Examples:
      // charge.success
      // transfer.success
      // refund.pending
      // refund.processing
      // refund.needs-attention
      // refund.failed
      // refund.processed
    },

    eventCategory: {
      type: String,
      enum: [
        "employer_wallet_funding",
        "shift_checkout_payment",

        "employer_refund",

        "employer_withdrawal_payout",
        "employer_withdrawal_reversal",

        "professional_withdrawal_payout",
        "professional_withdrawal_reversal",

        // Legacy/general compatibility categories.
        "wallet_funding",
        "checkout_payment",
        "withdrawal_transfer",
        "transfer_reversal",

        "other",
      ],
      default: "other",
      required: true,
      trim: true,
      lowercase: true,
    },

    // --- VERIFICATION ---

    isVerified: {
      type: Boolean,
      default: false,
      required: true,
      // True after provider signature verification.
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    // --- PROCESSING STATUS ---

    status: {
      type: String,
      enum: ["received", "processing", "processed", "failed", "ignored"],
      default: "received",
      required: true,
      index: true,
    },

    receivedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },

    processingStartedAt: {
      type: Date,
      default: null,
      // First time this ProviderEvent ever entered processing.
      // Preserved permanently as audit history.
    },

    lastProcessingStartedAt: {
      type: Date,
      default: null,
      // Most recent successful processing claim.
      // Updated on each retry attempt.
    },

    processingClaimId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
      // Current processing attempt's ownership token.
      //
      // Generated by ProviderEventService.markProcessing().
      // Cleared whenever status leaves processing.
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
      maxlength: 500,
      default: null,
    },

    ignoredAt: {
      type: Date,
      default: null,
    },

    ignoredReason: {
      type: String,
      trim: true,
      maxlength: 500,
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

    nextRetryAt: {
      type: Date,
      default: null,
    },

    // --- MONEY DETAILS ---
    // Stored in minor units where available.

    amount: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: isOptionalNonNegativeInteger,
        message: "Provider event amount must be a non-negative integer.",
      },
    },

    providerFee: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: isOptionalNonNegativeInteger,
        message: "Provider event fee must be a non-negative integer.",
      },
    },

    netAmount: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: isOptionalNonNegativeInteger,
        message: "Provider event net amount must be a non-negative integer.",
      },
    },

    countryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
    },

    // --- LINKED RECORDS ---

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null,
    },

    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Ledger transaction created/affected after provider-event processing.
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

    employerRefundBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefundBatch",
      default: null,
      // External provider refund execution belongs to the batch line.
    },

    employerRefundBatchLineId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      // _id of the embedded EmployerRefundBatch.lines subdocument.
    },

    // --- RAW / NORMALIZED PAYLOADS ---

    rawHeaders: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    normalizedPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
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

providerEventSchema.index(
  {
    eventKey: 1,
  },
  {
    unique: true,
  }
);

providerEventSchema.index(
  {
    provider: 1,
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

providerEventSchema.index({
  provider: 1,
  providerReference: 1,
});

providerEventSchema.index({
  provider: 1,
  providerRefundId: 1,
});

providerEventSchema.index({
  provider: 1,
  providerRefundReference: 1,
});

providerEventSchema.index({
  provider: 1,
  eventName: 1,
});

providerEventSchema.index({
  provider: 1,
  eventCategory: 1,
});

providerEventSchema.index({
  status: 1,
  receivedAt: -1,
});

providerEventSchema.index({
  status: 1,
  nextRetryAt: 1,
});

providerEventSchema.index({
  isVerified: 1,
  status: 1,
});

providerEventSchema.index({
  employer: 1,
  receivedAt: -1,
});

providerEventSchema.index({
  professional: 1,
  receivedAt: -1,
});

providerEventSchema.index({
  wallet: 1,
  receivedAt: -1,
});

providerEventSchema.index(
  {
    transaction: 1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    dva: 1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    bankAccount: 1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    shift: 1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    employerRefundBatch: 1,
    receivedAt: -1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    employerRefundBatch: 1,
    employerRefundBatchLineId: 1,
    receivedAt: -1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index({
  countryCode: 1,
  currency: 1,
});

providerEventSchema.index({
  createdAt: -1,
});

providerEventSchema.index({
  status: 1,
  lastProcessingStartedAt: 1,
});

// --- VALIDATION / NORMALIZATION ---

providerEventSchema.pre("validate", function () {
  if (this.provider) {
    this.provider = String(this.provider).toLowerCase().trim();
  }

  if (this.eventKey) {
    this.eventKey = String(this.eventKey).trim();
  }

  if (this.providerEventId) {
    this.providerEventId = String(this.providerEventId).trim();
  }

  if (this.providerReference) {
    this.providerReference = String(this.providerReference).trim();
  }

  if (this.providerRefundId) {
    this.providerRefundId = String(this.providerRefundId).trim();
  }

  if (this.providerRefundReference) {
    this.providerRefundReference = String(this.providerRefundReference).trim();
  }

  if (this.eventName) {
    this.eventName = String(this.eventName).toLowerCase().trim();
  }

  if (this.eventCategory) {
    this.eventCategory = String(this.eventCategory).toLowerCase().trim();
  }

  if (this.processingClaimId) {
    this.processingClaimId = String(this.processingClaimId).trim();

    if (!this.processingClaimId) {
      this.processingClaimId = null;
    }
  }

  if (!this.countryCode) {
    this.countryCode = "NG";
  }

  if (!this.currency) {
    this.currency = "NGN";
  }

  this.countryCode = String(this.countryCode).toUpperCase().trim();

  this.currency = String(this.currency).toUpperCase().trim();

  if (!this.eventKey) {
    throw new Error("Provider event key is required.");
  }

  if (!this.provider) {
    throw new Error("Provider is required.");
  }

  if (!this.eventName) {
    throw new Error("Provider event name is required.");
  }

  /*
   * ProviderEvent must be recordable before an
   * employer refund execution line is resolved.
   *
   * Once either execution link exists, both are
   * required because one provider refund belongs
   * to one exact embedded batch line.
   */
  const hasEmployerRefundBatch = Boolean(this.employerRefundBatch);

  const hasEmployerRefundBatchLineId = Boolean(this.employerRefundBatchLineId);

  if (hasEmployerRefundBatch !== hasEmployerRefundBatchLineId) {
    throw new Error("Provider event employer refund batch and batch line must be linked together.");
  }

  /*
   * Only documented Paystack refund lifecycle
   * webhooks may be classified as employer_refund.
   */
  if (
    this.eventCategory === "employer_refund" &&
    this.provider === "paystack" &&
    !PAYSTACK_REFUND_EVENT_NAMES.includes(this.eventName)
  ) {
    throw new Error(`Unsupported Paystack employer refund event name: ${this.eventName}.`);
  }

  if (this.isVerified && !this.verifiedAt) {
    this.verifiedAt = new Date();
  }

  if (!this.isVerified) {
    this.verifiedAt = null;
  }

  /*
   * processingStartedAt is permanent audit history:
   * the first time this event ever entered processing.
   *
   * lastProcessingStartedAt tracks the latest
   * processing attempt.
   *
   * processingClaimId is different: it represents
   * only the currently active processing owner.
   */
  if (this.status === "processing") {
    const processingTime = new Date();

    if (!this.processingStartedAt) {
      this.processingStartedAt = processingTime;
    }

    if (!this.lastProcessingStartedAt) {
      this.lastProcessingStartedAt = this.processingStartedAt || processingTime;
    }

    if (!this.processingClaimId) {
      throw new Error("Processing provider event requires a processing claim ID.");
    }
  }

  /*
   * No worker owns the ProviderEvent after it leaves
   * processing. The historical processing timestamps
   * remain, but the active claim is invalidated.
   */
  if (this.status !== "processing") {
    this.processingClaimId = null;
  }

  /*
   * Backfill legacy records that have the original
   * first-processing timestamp but no latest timestamp.
   */
  if (this.processingStartedAt && !this.lastProcessingStartedAt) {
    this.lastProcessingStartedAt = this.processingStartedAt;
  }

  if (
    this.processingStartedAt &&
    this.lastProcessingStartedAt &&
    this.lastProcessingStartedAt.getTime() < this.processingStartedAt.getTime()
  ) {
    throw new Error(
      "Provider event latest processing start cannot be earlier than first processing start."
    );
  }

  if (this.status === "processed") {
    if (!this.processedAt) {
      this.processedAt = new Date();
    }

    this.failedAt = null;
    this.failureReason = null;

    this.ignoredAt = null;
    this.ignoredReason = null;

    this.nextRetryAt = null;
  }

  if (this.status !== "processed") {
    this.processedAt = null;
  }

  if (this.status === "failed") {
    if (!this.failedAt) {
      this.failedAt = new Date();
    }

    if (!this.failureReason) {
      this.failureReason = "Provider event processing failed.";
    }
  }

  if (this.status !== "failed") {
    this.failedAt = null;
    this.failureReason = null;
  }

  if (this.status === "ignored") {
    if (!this.ignoredAt) {
      this.ignoredAt = new Date();
    }

    if (!this.ignoredReason) {
      this.ignoredReason = "Provider event ignored.";
    }
  }

  if (this.status !== "ignored") {
    this.ignoredAt = null;
    this.ignoredReason = null;
  }

  if (
    this.amount !== null &&
    this.amount !== undefined &&
    this.providerFee !== null &&
    this.providerFee !== undefined &&
    this.providerFee > this.amount
  ) {
    throw new Error("Provider event fee cannot be greater than amount.");
  }

  if (
    this.amount !== null &&
    this.amount !== undefined &&
    this.netAmount !== null &&
    this.netAmount !== undefined &&
    this.netAmount > this.amount
  ) {
    throw new Error("Provider event net amount cannot be greater than amount.");
  }
});

module.exports = mongoose.model("ProviderEvent", providerEventSchema);
