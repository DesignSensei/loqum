// models/ProviderEvent.js

const mongoose = require("mongoose");

/**
 * PROVIDER EVENT MODEL:
 *
 * Stores raw and normalized payment provider events before they affect wallets,
 * transactions, shifts or withdrawals.
 *
 * This model is provider-facing.
 * Transaction.js remains the wallet ledger.
 *
 * Why this exists:
 * - Prevent duplicate provider events from being processed twice.
 * - Store raw provider payloads for audit/debugging.
 * - Track whether an event was processed, failed or ignored.
 * - Keep provider webhook logic separate from wallet ledger logic.
 *
 * Example future flow:
 *
 * Paystack webhook received
 * → ProviderEvent recorded
 * → event normalized
 * → WalletFundingService credits wallet
 * → Transaction written
 * → ProviderEvent marked processed
 */

const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const isOptionalNonNegativeInteger = (value) =>
  value === null || value === undefined || isNonNegativeInteger(value);

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
      // Example: paystack:event:123456
      // Example: paystack:reference:trx_xxxxx
    },

    providerEventId: {
      type: String,
      trim: true,
      default: null,
      // Provider's own event ID if available.
    },

    providerReference: {
      type: String,
      trim: true,
      default: null,
      // Provider payment/transfer/reference if available.
    },

    eventName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      // Example: charge.success, transfer.success.
    },

    eventCategory: {
      type: String,
      enum: [
        "employer_wallet_funding",
        "shift_checkout_payment",
        "employer_withdrawal_payout",
        "employer_withdrawal_reversal",
        "professional_withdrawal_payout",
        "professional_withdrawal_reversal",
        "wallet_funding",
        "checkout_payment",
        "withdrawal_transfer",
        "transfer_reversal",
        "other",
      ],
      default: "other",
      required: true,
    },

    // --- VERIFICATION ---

    isVerified: {
      type: Boolean,
      default: false,
      required: true,
      // True after signature verification.
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

providerEventSchema.index({ eventKey: 1 }, { unique: true });

providerEventSchema.index(
  { provider: 1, providerEventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerEventId: { $type: "string" },
    },
  }
);

providerEventSchema.index({ provider: 1, providerReference: 1 });
providerEventSchema.index({ provider: 1, eventName: 1 });
providerEventSchema.index({ provider: 1, eventCategory: 1 });

providerEventSchema.index({ status: 1, receivedAt: -1 });
providerEventSchema.index({ status: 1, nextRetryAt: 1 });
providerEventSchema.index({ isVerified: 1, status: 1 });

providerEventSchema.index({ employer: 1, receivedAt: -1 });
providerEventSchema.index({ professional: 1, receivedAt: -1 });
providerEventSchema.index({ wallet: 1, receivedAt: -1 });
providerEventSchema.index({ transaction: 1 }, { sparse: true });
providerEventSchema.index({ dva: 1 }, { sparse: true });
providerEventSchema.index({ bankAccount: 1 }, { sparse: true });
providerEventSchema.index({ shift: 1 }, { sparse: true });

providerEventSchema.index({ countryCode: 1, currency: 1 });
providerEventSchema.index({ createdAt: -1 });

// --- VALIDATION / NORMALISATION ---

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

  if (this.eventName) {
    this.eventName = String(this.eventName).toLowerCase().trim();
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

  if (this.isVerified && !this.verifiedAt) {
    this.verifiedAt = new Date();
  }

  if (!this.isVerified) {
    this.verifiedAt = null;
  }

  if (this.status === "processing" && !this.processingStartedAt) {
    this.processingStartedAt = new Date();
  }

  if (this.status !== "processing") {
    this.processingStartedAt = null;
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
