// models/Wallet.js

const mongoose = require("mongoose");

const { isNonNegativeSafeInteger, isNullableSafeInteger } = require("./helpers/schemaValidators");

const WALLET_OWNER_TYPES = ["employer", "professional", "escrow", "platform"];

const WALLET_STATUSES = ["active", "frozen", "closed"];

/**
 * WALLET ARCHITECTURE:
 *
 * employer:
 * Employer-owned spendable money. It can fund Shifts, pay approved top-ups,
 * receive protected-fund returns and remain available for future use.
 *
 * professional:
 * Professional-owned earnings after Loqum releases approved settlement money.
 *
 * escrow:
 * Platform-controlled protected Shift money. Employer-funded Shift money stays
 * here until it is released through settlement or returned to the employer.
 *
 * platform:
 * Platform-controlled earned Loqum fees after fee release.
 *
 * FUNDING RAILS:
 *
 * Employer wallet funding:
 * employer.availableBalance -> escrow.availableBalance
 *
 * Paystack Checkout Shift funding:
 * external Paystack payment -> escrow.availableBalance
 *
 * Paystack DVA wallet top-up:
 * external Paystack bank transfer -> employer.availableBalance
 *
 * A DVA does not directly fund a Shift and does not directly credit escrow.
 *
 * BALANCE MEANING:
 *
 * availableBalance:
 * Money currently usable by the wallet owner or wallet purpose.
 *
 * pendingBalance:
 * Money already recognized inside Loqum's wallet ledger but temporarily
 * unavailable while an outbound or review process is unresolved.
 *
 * A merely pending external inbound payment remains a pending Transaction and
 * does not enter a wallet balance until the provider payment is confirmed.
 *
 * outstandingBalance:
 * Employer-only unpaid obligations. It is not protected escrow money.
 *
 * lifetimeCredit / lifetimeDebit:
 * Cumulative completed wallet movements. Pending external payment attempts do
 * not affect these totals until their wallet movement is completed.
 *
 * All monetary fields use minor units and must remain safe integers.
 * No wallet balance may become negative.
 */

const walletSchema = new mongoose.Schema(
  {
    // ─────────────────────────────── OWNERSHIP ───────────────────────────────

    ownerType: {
      type: String,
      enum: WALLET_OWNER_TYPES,
      required: true,
      immutable: true,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      default: null,
      immutable: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
      immutable: true,
    },

    // ─────────────────────────────── COUNTRY / CURRENCY ───────────────────────────────

    countryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 2,
      match: /^[A-Z]{2}$/,
      required: true,
      immutable: true,
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      match: /^[A-Z]{3}$/,
      required: true,
      immutable: true,
    },

    // ─────────────────────────────── BALANCES ───────────────────────────────
    // Example: ₦1,000.00 is stored as 100000 kobo.

    availableBalance: {
      type: Number,
      default: 0,
      required: true,
      min: 0,

      validate: {
        validator: isNonNegativeSafeInteger,

        message: "availableBalance must be a non-negative safe integer.",
      },
    },

    pendingBalance: {
      type: Number,
      default: 0,
      required: true,
      min: 0,

      validate: {
        validator: isNonNegativeSafeInteger,

        message: "pendingBalance must be a non-negative safe integer.",
      },
    },

    outstandingBalance: {
      type: Number,
      default: 0,
      required: true,
      min: 0,

      validate: {
        validator: isNonNegativeSafeInteger,

        message: "outstandingBalance must be a non-negative safe integer.",
      },
    },

    lifetimeCredit: {
      type: Number,
      default: 0,
      required: true,
      min: 0,

      validate: {
        validator: isNonNegativeSafeInteger,

        message: "lifetimeCredit must be a non-negative safe integer.",
      },
    },

    lifetimeDebit: {
      type: Number,
      default: 0,
      required: true,
      min: 0,

      validate: {
        validator: isNonNegativeSafeInteger,

        message: "lifetimeDebit must be a non-negative safe integer.",
      },
    },

    // ─────────────────────────────── LIMITS ───────────────────────────────
    // null means that the limit is not configured for this wallet.

    maximumExternalTopupBalance: {
      type: Number,
      default: null,
      min: 1,

      validate: {
        validator: isNullableSafeInteger,

        message: "maximumExternalTopupBalance must be null or a positive safe integer.",
      },
    },

    minimumWithdrawalAmount: {
      type: Number,
      default: null,
      min: 1,

      validate: {
        validator: isNullableSafeInteger,

        message: "minimumWithdrawalAmount must be null or a positive safe integer.",
      },
    },

    // ─────────────────────────────── STATUS ───────────────────────────────

    status: {
      type: String,
      enum: WALLET_STATUSES,
      default: "active",
      required: true,
    },

    frozenReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    frozenAt: {
      type: Date,
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    lastTransactionAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,

    /*
     * WalletService loads and saves wallet documents while applying
     * ledger movements. Version checking helps prevent silent lost updates.
     */
    optimisticConcurrency: true,
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

// One employer wallet per country and currency.
walletSchema.index(
  {
    employer: 1,
    countryCode: 1,
    currency: 1,
  },
  {
    name: "unique_employer_wallet_by_country_currency",

    unique: true,

    partialFilterExpression: {
      ownerType: "employer",

      employer: {
        $type: "objectId",
      },
    },
  }
);

// One professional wallet per country and currency.
walletSchema.index(
  {
    professional: 1,
    countryCode: 1,
    currency: 1,
  },
  {
    name: "unique_professional_wallet_by_country_currency",

    unique: true,

    partialFilterExpression: {
      ownerType: "professional",

      professional: {
        $type: "objectId",
      },
    },
  }
);

// One escrow wallet and one platform wallet per country and currency.
walletSchema.index(
  {
    ownerType: 1,
    countryCode: 1,
    currency: 1,
  },
  {
    name: "unique_system_wallet_by_type_country_currency",

    unique: true,

    partialFilterExpression: {
      ownerType: {
        $in: ["escrow", "platform"],
      },
    },
  }
);

// Operational and administrative lookup indexes.
walletSchema.index({
  ownerType: 1,
  status: 1,
});

walletSchema.index({
  countryCode: 1,
  currency: 1,
  status: 1,
});

walletSchema.index({
  lastTransactionAt: -1,
});

/* ─────────────────────────────── MODEL VALIDATION ─────────────────────────────── */

walletSchema.pre("validate", function validateWallet() {
  const isEmployerWallet = this.ownerType === "employer";

  const isProfessionalWallet = this.ownerType === "professional";

  const isSystemWallet = ["escrow", "platform"].includes(this.ownerType);

  // ─────────────────────────────── OWNERSHIP ───────────────────────────────

  if (isEmployerWallet) {
    if (!this.employer) {
      this.invalidate(
        "employer",

        "Employer wallet must reference an employer profile."
      );
    }

    if (this.professional) {
      this.invalidate(
        "professional",

        "Employer wallet cannot reference a professional profile."
      );
    }
  }

  if (isProfessionalWallet) {
    if (!this.professional) {
      this.invalidate(
        "professional",

        "Professional wallet must reference a professional profile."
      );
    }

    if (this.employer) {
      this.invalidate(
        "employer",

        "Professional wallet cannot reference an employer profile."
      );
    }
  }

  if (isSystemWallet && (this.employer || this.professional)) {
    this.invalidate(
      "ownerType",

      "Escrow and platform wallets cannot reference employer or professional profiles."
    );
  }

  // ─────────────────────────────── OWNER-SPECIFIC BALANCES ───────────────────────────────

  if (!isEmployerWallet && Number(this.outstandingBalance || 0) !== 0) {
    this.invalidate(
      "outstandingBalance",

      "Only employer wallets can have an outstanding balance."
    );
  }

  // ─────────────────────────────── OWNER-SPECIFIC LIMITS ───────────────────────────────

  if (!isEmployerWallet && this.maximumExternalTopupBalance !== null) {
    this.invalidate(
      "maximumExternalTopupBalance",

      "Only employer wallets can have an external top-up balance limit."
    );
  }

  if (isSystemWallet && this.minimumWithdrawalAmount !== null) {
    this.invalidate(
      "minimumWithdrawalAmount",

      "System wallets cannot have a minimum withdrawal amount."
    );
  }

  // ─────────────────────────────── FROZEN STATUS ───────────────────────────────

  if (this.status === "frozen") {
    if (!this.frozenAt) {
      this.frozenAt = new Date();
    }

    if (!String(this.frozenReason || "").trim()) {
      this.frozenReason = "Wallet frozen pending review.";
    }
  } else {
    this.frozenReason = null;
    this.frozenAt = null;
  }

  // ─────────────────────────────── CLOSED STATUS ───────────────────────────────

  if (this.status === "closed") {
    const hasBalance =
      Number(this.availableBalance || 0) > 0 ||
      Number(this.pendingBalance || 0) > 0 ||
      Number(this.outstandingBalance || 0) > 0;

    if (hasBalance) {
      this.invalidate(
        "status",

        "Wallet balances must be zero before the wallet is closed."
      );
    }

    if (!this.closedAt) {
      this.closedAt = new Date();
    }
  } else {
    this.closedAt = null;
  }
});

module.exports = mongoose.model("Wallet", walletSchema);
