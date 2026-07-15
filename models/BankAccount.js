// models/BankAccount.js

const mongoose = require("mongoose");

/**
 * BANK ACCOUNT MODEL:
 * Stores withdrawal destination accounts for employers and professionals.
 *
 * Employers can withdraw eligible wallet balances such as refunds,
 * excess wallet funds, or admin-approved refundable balances.
 *
 * Professionals withdraw earned wallet balances after shift settlement.
 *
 * This model does not store wallet balance.
 * Wallet balance is managed through Wallet.
 * Money movement is recorded through Transaction.
 *
 * One active bank account per owner is enforced through partial indexes.
 *
 * Paystack-specific fields are stored only when Paystack verification
 * and transfer recipient creation become available.
 */

const bankAccountSchema = new mongoose.Schema(
  {
    // --- OWNERSHIP ---

    ownerType: {
      type: String,
      enum: ["employer", "professional"],
      required: true,
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

    // --- ACCOUNT DETAILS ---

    accountNumber: {
      type: String,
      trim: true,
      required: true,
      select: false,
      // Hidden by default because this is sensitive payout information.
      // Select it explicitly only where the account owner needs to view it.
    },

    accountName: {
      type: String,
      trim: true,
      required: true,
      // This should eventually be populated from bank account resolution.
      // Until provider access is available, it may be saved from controlled/manual input.
    },

    bankName: {
      type: String,
      trim: true,
      required: true,
      // Selected by the user from a bank dropdown.
    },

    // --- PAYSTACK ---

    paystackBankCode: {
      type: String,
      trim: true,
      default: null,
      select: false,
      // Internal Paystack bank code.
      // Not user-facing and not required until Paystack account resolution is available.
    },

    paystackRecipientCode: {
      type: String,
      trim: true,
      default: null,
      select: false,
      // Generated when a Paystack transfer recipient is created.
      // Must be present before a Paystack withdrawal can be initiated.
    },

    // --- VERIFICATION ---

    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "failed"],
      default: "pending",
    },

    verificationProvider: {
      type: String,
      enum: ["paystack", "manual", null],
      default: null,
    },

    verificationReference: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    verificationFailureReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    // --- STATUS ---

    isActive: {
      type: Boolean,
      default: true,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

// One active bank account per employer
bankAccountSchema.index(
  { employer: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: "employer",
      isActive: true,
      employer: { $type: "objectId" },
    },
  }
);

// One active bank account per professional
bankAccountSchema.index(
  { professional: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerType: "professional",
      isActive: true,
      professional: { $type: "objectId" },
    },
  }
);

// Paystack recipient codes should not duplicate
bankAccountSchema.index(
  { paystackRecipientCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paystackRecipientCode: { $type: "string" },
    },
  }
);

// Useful owner/status lookups
bankAccountSchema.index({ ownerType: 1, isActive: 1 });
bankAccountSchema.index({ ownerType: 1, verificationStatus: 1 });
bankAccountSchema.index({ verificationStatus: 1 });

// Useful provider lookup when Paystack is enabled
bankAccountSchema.index(
  { paystackBankCode: 1 },
  {
    partialFilterExpression: {
      paystackBankCode: { $type: "string" },
    },
  }
);

// Optional admin/search convenience
bankAccountSchema.index({ bankName: 1 });

// --- VALIDATION / AUTO-CLEANUP ---

bankAccountSchema.pre("validate", function () {
  if (this.accountNumber) {
    this.accountNumber = String(this.accountNumber).replace(/\s+/g, "").trim();
  }

  if (this.accountName) {
    this.accountName = String(this.accountName).trim();
  }

  if (this.bankName) {
    this.bankName = String(this.bankName).trim();
  }

  if (this.paystackBankCode) {
    this.paystackBankCode = String(this.paystackBankCode).trim();
  }

  if (this.paystackRecipientCode) {
    this.paystackRecipientCode = String(this.paystackRecipientCode).trim();
  }

  if (this.ownerType === "employer") {
    if (!this.employer) {
      throw new Error("Employer bank account must reference an employer profile.");
    }

    if (this.professional) {
      throw new Error("Employer bank account cannot reference a professional profile.");
    }
  }

  if (this.ownerType === "professional") {
    if (!this.professional) {
      throw new Error("Professional bank account must reference a professional profile.");
    }

    if (this.employer) {
      throw new Error("Professional bank account cannot reference an employer profile.");
    }
  }

  if (this.verificationStatus === "verified") {
    if (!this.verifiedAt) {
      this.verifiedAt = new Date();
    }

    this.verificationFailureReason = null;
  }

  if (this.verificationStatus === "failed") {
    this.verifiedAt = null;
  }

  if (!this.isActive && !this.deactivatedAt) {
    this.deactivatedAt = new Date();
  }

  if (this.isActive) {
    this.deactivatedAt = null;
  }
});

module.exports = mongoose.model("BankAccount", bankAccountSchema);
