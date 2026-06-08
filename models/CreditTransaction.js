// models/CreditTransaction.js

const mongoose = require("mongoose");

/**
 * CREDIT TRANSACTION MODEL:
 *
 * Ledger for every Credits movement on a professional's Credit account.
 *
 * Credits are dormant at launch.
 * Professionals apply for shifts for free in the MVP.
 *
 * This model is future-ready for:
 * - buying Credits
 * - using Credits to apply for shifts
 * - using Credits to boost applications
 * - promotional Credits
 * - refunds
 * - admin corrections
 * - expiry
 *
 * IMPORTANT:
 * Credits are not wallet money.
 * Wallet and Transaction handle Naira.
 * Credit and CreditTransaction handle platform Credits.
 *
 * If Credits are bought with money in the future, the Naira-side record
 * should live in Transaction.js, and this model should reference it through
 * paymentTransaction.
 *
 * paymentTransaction can represent:
 * 1. Pay with Wallet
 * 2. Pay through Paystack / bank transfer / external payment
 */

const creditBalanceSnapshotSchema = new mongoose.Schema(
  {
    availableCredits: {
      type: Number,
      required: true,
      min: 0,
    },

    pendingCredits: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const creditBalanceDeltaSchema = new mongoose.Schema(
  {
    availableCredits: {
      type: Number,
      default: 0,
    },

    pendingCredits: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const creditTransactionSchema = new mongoose.Schema(
  {
    // --- REFERENCE ---

    reference: {
      type: String,
      required: true,
      trim: true,
      // Example: CTX-20260603-xxxxxx.
      // Generated in service layer before insert.
    },

    groupReference: {
      type: String,
      trim: true,
      default: null,
      // Links multiple CreditTransaction records from one event if needed.
    },

    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      // Prevents duplicate processing of the same credit event.
    },

    // --- OWNERSHIP ---

    credit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Credit",
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    // --- TYPE ---

    type: {
      type: String,
      required: true,
      enum: [
        "credit_purchase",
        "application_credit_used",
        "boost_credit_used",
        "credit_refund",
        "admin_credit",
        "admin_debit",
        "promo_credit",
        "expiry",
        "adjustment",
      ],
    },

    // --- DIRECTION ---

    direction: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
      // credit increases available or pending Credits.
      // debit reduces available or pending Credits.
    },

    // --- AMOUNT ---

    amount: {
      type: Number,
      required: true,
      min: [0.01, "Credit transaction amount must be greater than zero."],
    },

    // --- BALANCE SNAPSHOT ---

    balanceBefore: {
      type: creditBalanceSnapshotSchema,
      required: true,
    },

    balanceAfter: {
      type: creditBalanceSnapshotSchema,
      required: true,
    },

    balanceDelta: {
      type: creditBalanceDeltaSchema,
      default: () => ({}),
      // Exact movement applied to the Credit account.
      // Example:
      // availableCredits: -1
    },

    // --- LINKED RECORDS ---

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

    paymentTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      // Naira-side transaction that paid for this Credit purchase.
      // Can represent wallet payment or Paystack / bank transfer / external payment.
    },

    relatedCreditTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CreditTransaction",
      default: null,
      // Links a refund, reversal, or correction to the original Credit transaction.
    },

    // --- STATUS ---

    status: {
      type: String,
      enum: ["pending", "completed", "failed", "reversed", "cancelled"],
      default: "pending",
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
      maxlength: 300,
      default: null,
    },

    reversedAt: {
      type: Date,
      default: null,
    },

    reversalReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    // --- EXPIRY SUPPORT ---

    expiresAt: {
      type: Date,
      default: null,
      // Useful for promo Credits that expire.
    },

    // --- INITIATED BY ---

    initiatedBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      role: {
        type: String,
        enum: ["system", "professional", "admin"],
        required: true,
      },
    },

    // --- METADATA ---

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

creditTransactionSchema.index({ reference: 1 }, { unique: true });

creditTransactionSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
  }
);

creditTransactionSchema.index({ credit: 1, createdAt: -1 });
creditTransactionSchema.index({ professional: 1, createdAt: -1 });

creditTransactionSchema.index({ type: 1, status: 1 });
creditTransactionSchema.index({ direction: 1, status: 1 });

creditTransactionSchema.index({ shift: 1 }, { sparse: true });
creditTransactionSchema.index({ shiftApplication: 1 }, { sparse: true });
creditTransactionSchema.index({ paymentTransaction: 1 }, { sparse: true });
creditTransactionSchema.index({ relatedCreditTransaction: 1 }, { sparse: true });

creditTransactionSchema.index({ groupReference: 1 }, { sparse: true });
creditTransactionSchema.index({ expiresAt: 1 }, { sparse: true });

creditTransactionSchema.index({ createdAt: -1 });

// --- VALIDATION / AUTO-CLEANUP ---

creditTransactionSchema.pre("validate", function (next) {
  const creditTypes = ["credit_purchase", "credit_refund", "admin_credit", "promo_credit"];

  const debitTypes = ["application_credit_used", "boost_credit_used", "admin_debit", "expiry"];

  if (creditTypes.includes(this.type) && this.direction !== "credit") {
    return next(new Error(`${this.type} must be a credit transaction.`));
  }

  if (debitTypes.includes(this.type) && this.direction !== "debit") {
    return next(new Error(`${this.type} must be a debit transaction.`));
  }

  if (
    ["application_credit_used", "boost_credit_used"].includes(this.type) &&
    !this.shiftApplication
  ) {
    return next(new Error(`${this.type} must reference a shift application.`));
  }

  if (this.type === "credit_purchase" && !this.paymentTransaction) {
    return next(new Error("Credit purchase must reference a payment transaction."));
  }

  const balanceFields = ["availableCredits", "pendingCredits"];

  if (this.balanceBefore && this.balanceAfter && this.balanceDelta) {
    for (const field of balanceFields) {
      const before = Number(this.balanceBefore[field] || 0);
      const delta = Number(this.balanceDelta[field] || 0);
      const after = Number(this.balanceAfter[field] || 0);

      const expectedAfter = before + delta;
      const difference = Math.abs(after - expectedAfter);

      if (difference > 0.001) {
        return next(
          new Error(
            `Invalid balanceDelta for ${field}. Expected balanceAfter.${field} to be ${expectedAfter}.`
          )
        );
      }
    }
  }

  if (this.status === "completed" && !this.completedAt) {
    this.completedAt = new Date();
  }

  if (this.status === "failed" && !this.failedAt) {
    this.failedAt = new Date();
  }

  if (this.status === "reversed" && !this.reversedAt) {
    this.reversedAt = new Date();
  }

  next();
});

module.exports = mongoose.model("CreditTransaction", creditTransactionSchema);
