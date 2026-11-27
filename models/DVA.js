// models/DVA.js

const mongoose = require("mongoose");

/**
 * Paystack DVA for employer wallet funding.
 * A DVA is a payment rail, not a wallet.
 * Direct Shift funding uses Paystack Checkout.
 * Retired DVAs retain their historical financial identity.
 */

const dvaSchema = new mongoose.Schema(
  {
    // --- OWNERSHIP ---

    ownerUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
      index: true,
    },

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      immutable: true,
      index: true,
    },

    // --- COUNTRY / CURRENCY ---

    countryCode: {
      type: String,
      required: true,
      default: "NG",
      uppercase: true,
      trim: true,
    },

    currency: {
      type: String,
      required: true,
      default: "NGN",
      uppercase: true,
      trim: true,
    },

    // --- PROVIDER ---

    provider: {
      type: String,
      enum: ["paystack"],
      default: "paystack",
      required: true,
    },

    providerSlug: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    // --- BANK DETAILS ---

    bankId: {
      type: Number,
      default: null,
    },

    bankName: {
      type: String,
      trim: true,
      default: null,
    },

    bankCode: {
      type: String,
      trim: true,
      default: null,
    },

    bankSlug: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    // --- ACCOUNT DETAILS ---

    accountNumber: {
      type: String,
      trim: true,
      default: null,
    },

    accountName: {
      type: String,
      trim: true,
      default: null,
    },

    // --- PAYSTACK IDENTIFIERS ---

    paystackCustomerId: {
      type: Number,
      default: null,
    },

    paystackCustomerCode: {
      type: String,
      trim: true,
      default: null,
    },

    paystackDedicatedAccountId: {
      type: Number,
      default: null,
    },

    paystackReference: {
      type: String,
      trim: true,
      default: null,
    },

    // --- STATUS ---

    status: {
      type: String,
      enum: ["pending", "active", "failed", "retiring", "deactivated"],
      default: "pending",
      required: true,
      index: true,
    },

    isDefault: {
      type: Boolean,
      default: true,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },

    activatedAt: {
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

    // --- RETIREMENT ---

    retirementStartedAt: {
      type: Date,
      default: null,
    },

    retirementResolution: {
      type: String,
      enum: ["provider_unassigned", "assignment_never_created", null],
      default: null,
    },

    retirementConfirmedAt: {
      type: Date,
      default: null,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    // --- PROVIDER METADATA ---

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

// One DVA per wallet, provider, country and currency.
dvaSchema.index(
  {
    wallet: 1,
    provider: 1,
    countryCode: 1,
    currency: 1,
  },
  { unique: true }
);

// Dedicated account IDs remain unique after retirement.
dvaSchema.index(
  { provider: 1, paystackDedicatedAccountId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paystackDedicatedAccountId: { $type: "number" },
    },
  }
);

// Preserve historical bank account identity.
dvaSchema.index(
  { provider: 1, bankId: 1, accountNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      bankId: { $type: "number" },
      accountNumber: { $type: "string" },
    },
  }
);

// Alternative bank identity when no numeric bank ID is supplied.
dvaSchema.index(
  {
    provider: 1,
    providerSlug: 1,
    accountNumber: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerSlug: { $type: "string" },
      accountNumber: { $type: "string" },
    },
  }
);

dvaSchema.index({ ownerUser: 1, status: 1 });
dvaSchema.index({ employer: 1, status: 1 });
dvaSchema.index({ wallet: 1, status: 1 });
dvaSchema.index({ provider: 1, providerSlug: 1 });
dvaSchema.index({ countryCode: 1, currency: 1 });
dvaSchema.index({ paystackCustomerCode: 1 });

// --- VALIDATION / NORMALISATION ---

dvaSchema.pre("validate", function () {
  if (this.countryCode) {
    this.countryCode = String(this.countryCode).toUpperCase().trim();
  }

  if (this.currency) {
    this.currency = String(this.currency).toUpperCase().trim();
  }

  if (this.providerSlug) {
    this.providerSlug = String(this.providerSlug).toLowerCase().trim();
  }

  if (this.bankSlug) {
    this.bankSlug = String(this.bankSlug).toLowerCase().trim();
  }

  if (this.accountNumber) {
    this.accountNumber = String(this.accountNumber).trim();
  }

  if (this.accountName) {
    this.accountName = String(this.accountName).trim();
  }

  if (this.bankName) {
    this.bankName = String(this.bankName).trim();
  }

  if (this.bankCode) {
    this.bankCode = String(this.bankCode).trim();
  }

  if (this.paystackCustomerCode) {
    this.paystackCustomerCode = String(this.paystackCustomerCode).trim();
  }

  // --- ACTIVE DVA ---

  if (this.status === "active") {
    if (
      !this.accountNumber ||
      !this.accountName ||
      !this.bankName ||
      !this.providerSlug ||
      !this.paystackDedicatedAccountId ||
      !this.paystackCustomerCode
    ) {
      throw new Error(
        "Active DVA requires complete bank details, dedicated account ID and customer code."
      );
    }

    if (!this.activatedAt) {
      this.activatedAt = new Date();
    }

    this.failedAt = null;
    this.failureReason = null;
  }

  // --- FAILED ASSIGNMENT ---

  if (this.status === "failed") {
    if (!this.failedAt) {
      this.failedAt = new Date();
    }

    if (!this.failureReason) {
      this.failureReason = "DVA creation failed.";
    }
  }

  // --- RETIREMENT LIFECYCLE ---

  const isRetiring = this.status === "retiring";
  const isDeactivated = this.status === "deactivated";

  const hasRetirementResolution = Boolean(this.retirementResolution);
  const hasRetirementConfirmation = Boolean(this.retirementConfirmedAt);

  if (isRetiring || isDeactivated) {
    this.isDefault = false;

    if (!this.retirementStartedAt) {
      this.invalidate("retirementStartedAt", "DVA retirement requires a start time.");
    }
  } else if (
    this.retirementStartedAt ||
    this.retirementResolution ||
    this.retirementConfirmedAt ||
    this.deactivatedAt
  ) {
    this.invalidate("status", "A DVA with retirement history cannot return to normal operation.");
  }

  if (hasRetirementResolution !== hasRetirementConfirmation) {
    this.invalidate(
      "retirementResolution",
      "Retirement resolution and confirmation must be recorded together."
    );
  }

  if (this.retirementResolution === "provider_unassigned" && !this.paystackDedicatedAccountId) {
    this.invalidate(
      "paystackDedicatedAccountId",
      "Provider unassignment requires the dedicated account ID."
    );
  }

  if (
    this.retirementResolution === "assignment_never_created" &&
    (this.activatedAt || this.paystackDedicatedAccountId || this.accountNumber)
  ) {
    this.invalidate(
      "retirementResolution",
      "An existing dedicated account requires provider unassignment."
    );
  }

  if (isDeactivated) {
    if (!hasRetirementResolution || !hasRetirementConfirmation) {
      this.invalidate(
        "retirementConfirmedAt",
        "DVA deactivation requires verified retirement resolution."
      );
    }

    if (!this.deactivatedAt) {
      this.invalidate("deactivatedAt", "DVA deactivation requires a completion time.");
    }
  } else if (this.deactivatedAt) {
    this.invalidate("deactivatedAt", "Only a deactivated DVA may have a deactivation time.");
  }

  // --- RETIREMENT TIMESTAMP ORDER ---

  if (
    this.retirementStartedAt &&
    this.retirementConfirmedAt &&
    this.retirementConfirmedAt < this.retirementStartedAt
  ) {
    this.invalidate("retirementConfirmedAt", "Retirement confirmation cannot precede initiation.");
  }

  if (
    this.retirementConfirmedAt &&
    this.deactivatedAt &&
    this.deactivatedAt < this.retirementConfirmedAt
  ) {
    this.invalidate("deactivatedAt", "Deactivation cannot precede retirement confirmation.");
  }
});

module.exports = mongoose.model("DVA", dvaSchema);
