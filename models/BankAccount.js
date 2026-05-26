// models/BankAccount.js

const mongoose = require("mongoose");

/**
 * Stores the withdrawal destination for both employers and professionals.
 *
 * Employers withdraw their wallet balance here (excess escrow, refunds, etc).
 * Professionals withdraw their earned wallet balance here after shift settlement.
 *
 * One active account per owner — enforced via partial filter indexes.
 * paystackRecipientCode is required before any withdrawal can be initiated.
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
    },

    accountName: {
      type: String,
      trim: true,
      required: true,
    },

    bankName: {
      type: String,
      trim: true,
      required: true,
    },

    bankCode: {
      type: String,
      trim: true,
      required: true,
    },

    // --- PAYSTACK ---

    paystackRecipientCode: {
      type: String,
      trim: true,
      default: null,
      // Generated when a Paystack transfer recipient is created.
      // Must be present before a withdrawal transaction can be initiated.
    },

    // --- STATUS ---

    isActive: {
      type: Boolean,
      default: true,
    },

    verifiedAt: {
      type: Date,
      default: null,
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
    sparse: true,
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
    sparse: true,
    partialFilterExpression: {
      ownerType: "professional",
      isActive: true,
      professional: { $type: "objectId" },
    },
  }
);

// --- VALIDATION ---

bankAccountSchema.pre("validate", function (next) {
  if (this.ownerType === "employer") {
    if (!this.employer)
      return next(new Error("Employer bank account must reference an employer profile."));
    if (this.professional)
      return next(new Error("Employer bank account cannot reference a professional profile."));
  }

  if (this.ownerType === "professional") {
    if (!this.professional)
      return next(new Error("Professional bank account must reference a professional profile."));
    if (this.employer)
      return next(new Error("Professional bank account cannot reference an employer profile."));
  }

  next();
});

module.exports = mongoose.model("BankAccount", bankAccountSchema);
