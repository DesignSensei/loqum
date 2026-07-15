// models/DVA.js

const mongoose = require("mongoose");

/**
 * DVA MODEL:
 *
 * Stores employer Paystack Dedicated Virtual Account details.
 *
 * DVA is a payment rail, not the wallet.
 *
 * Current payment direction:
 * - DVA is for employer wallet funding only.
 * - DVA should not directly fund a shift.
 * - DVA should not directly credit escrow.
 * - Money received through DVA is reconciled into the employer wallet.
 *
 * Paystack Checkout is separate:
 * - Paystack Checkout can fund a specific shift directly into escrow.
 * - That flow should not use this DVA model.
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
      index: true,
    },

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
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
      // Example: titan-paystack, wema-bank.
    },

    // --- BANK DETAILS ---

    bankId: {
      type: Number,
      default: null,
      // Example: 629 for Paystack-Titan provider.
    },

    bankName: {
      type: String,
      trim: true,
      default: null,
      // Example: Paystack-Titan, Wema Bank.
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
      // Example: CUS_xxxxxxxxxxxx.
    },

    paystackDedicatedAccountId: {
      type: Number,
      default: null,
      // Paystack's internal dedicated account ID.
    },

    paystackReference: {
      type: String,
      trim: true,
      default: null,
    },

    // --- STATUS ---

    status: {
      type: String,
      enum: ["pending", "active", "failed", "deactivated"],
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

    deactivatedAt: {
      type: Date,
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    // --- RAW PROVIDER DATA ---

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

// One DVA per employer wallet per provider/country/currency for launch.
dvaSchema.index(
  {
    wallet: 1,
    provider: 1,
    countryCode: 1,
    currency: 1,
  },
  { unique: true }
);

// Prevent duplicate Paystack dedicated account records.
dvaSchema.index(
  { provider: 1, paystackDedicatedAccountId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paystackDedicatedAccountId: { $type: "number" },
    },
  }
);

// Prevent the same bank account from being assigned twice by the same provider.
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
        "Active DVA must have account number, account name, bank name, provider slug, Paystack dedicated account ID, and Paystack customer code."
      );
    }

    if (!this.activatedAt) {
      this.activatedAt = new Date();
    }

    this.failedAt = null;
    this.failureReason = null;
    this.deactivatedAt = null;
  }

  if (this.status === "failed") {
    if (!this.failedAt) {
      this.failedAt = new Date();
    }

    if (!this.failureReason) {
      this.failureReason = "DVA creation failed.";
    }
  }

  if (this.status === "deactivated") {
    if (!this.deactivatedAt) {
      this.deactivatedAt = new Date();
    }
  }
});

module.exports = mongoose.model("DVA", dvaSchema);
