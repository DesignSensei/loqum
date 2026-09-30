// models/JobPayment.js

const mongoose = require("mongoose");

const {
  requiredPositiveMinorUnitAmountField,
  requiredPositiveSafeIntegerField,
} = require("./helpers/schemaFields");

const {
  JOB_PAYMENT_METHODS,
  JOB_PAYMENT_STATUSES,
  JOB_PAYMENT_PROVIDERS,
  JOB_PAYMENT_PROVIDER_STATUSES,
  MAX_COMMERCIAL_PLAN_CODE_LENGTH,
  MAX_COMMERCIAL_PLAN_NAME_LENGTH,
  MAX_COMMERCIAL_FEATURE_KEYS,
  MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
  MAX_JOB_PAYMENT_PURCHASE_REFERENCE_LENGTH,
  MAX_JOB_PAYMENT_ENTITLEMENT_REFERENCE_LENGTH,
  MAX_JOB_PAYMENT_PROVIDER_REFERENCE_LENGTH,
  MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH,
} = require("../constants/employerMonetization");

const { FIXED_JOB_PUBLICATION_PERIOD_DAYS } = require("../constants/jobPosting");

/**
 * JOB PAYMENT:
 *
 * Represents one employer PAYG purchase of a JobPostingPlan.
 *
 * JobPostingPlan defines the product currently sold by Loqum. JobPayment
 * preserves the exact purchased terms and payment lifecycle for one employer.
 * A successful payment grants one permanent-Job publication entitlement.
 *
 * PAYMENT METHODS:
 *
 * Employers may pay through:
 *
 * 1. wallet
 *    - Loqum transfers the purchase amount from the employer wallet to the
 *      platform wallet;
 *    - paymentTransaction references the platform-wallet credit Transaction;
 *    - the paired employer-wallet debit remains linked through the normal
 *      Transaction relatedTransaction/groupReference relationship.
 *
 * 2. paystack_checkout
 *    - Paystack Checkout credits the Loqum platform wallet directly;
 *    - paymentTransaction references that platform-wallet external-credit
 *      Transaction;
 *    - providerReference/providerStatus preserve the Paystack payment audit.
 *
 * PAYMENT VS ENTITLEMENT STATE:
 *
 * Payment state and entitlement consumption are deliberately separate.
 * A payment may be successful while its publication entitlement remains unused.
 * Consuming the entitlement does not change paymentStatus from paid.
 *
 * entitlementConsumptionReference is the stable one-use identifier passed into
 * JobPublication.entitlementSnapshot.consumptionReference. It must be unique so
 * the same PAYG purchase cannot authorize multiple publication cycles.
 *
 * The service layer must claim an unused paid entitlement transactionally with
 * JobPublication creation. A failed publication transaction must not leave the
 * purchase consumed.
 *
 * Consumption is one-use and durable. Ending a PAYG-funded JobPublication early
 * does not restore the purchase. Republishing requires another eligible purchase.
 *
 * HISTORICAL TERMS:
 *
 * planSnapshot records the exact PAYG product purchased. Later JobPostingPlan
 * edits, retirement or replacement must never rewrite these purchased terms.
 */

const planSnapshotSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      maxlength: MAX_COMMERCIAL_PLAN_CODE_LENGTH,
      match: [
        /^[A-Z0-9][A-Z0-9_-]*$/,
        "Job posting plan code must contain only uppercase letters, numbers, underscores or hyphens.",
      ],
    },

    version: requiredPositiveSafeIntegerField({
      label: "planSnapshot.version",
    }),

    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_COMMERCIAL_PLAN_NAME_LENGTH,
    },

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      minlength: 2,
      maxlength: 2,
      match: [/^[A-Z]{2}$/, "planSnapshot.countryCode must contain exactly 2 uppercase letters."],
    },

    currency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, "planSnapshot.currency must contain exactly 3 uppercase letters."],
    },

    priceMinor: requiredPositiveMinorUnitAmountField("planSnapshot.priceMinor"),

    publicationPeriodDays: {
      type: Number,
      required: true,
      min: FIXED_JOB_PUBLICATION_PERIOD_DAYS,
      max: FIXED_JOB_PUBLICATION_PERIOD_DAYS,
      validate: {
        validator: (value) =>
          Number.isSafeInteger(value) && value === FIXED_JOB_PUBLICATION_PERIOD_DAYS,
        message: `planSnapshot.publicationPeriodDays must be ${FIXED_JOB_PUBLICATION_PERIOD_DAYS}.`,
      },
    },

    featureKeys: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
          maxlength: MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
          match: [
            /^[a-z0-9][a-z0-9_-]*$/,
            "Each Job posting feature key must contain only lowercase letters, numbers, underscores or hyphens.",
          ],
        },
      ],
      default: [],
      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= MAX_COMMERCIAL_FEATURE_KEYS &&
          new Set(values.map((value) => String(value).trim().toLowerCase())).size === values.length,
        message: `featureKeys must contain no more than ${MAX_COMMERCIAL_FEATURE_KEYS} unique values.`,
      },
    },
  },
  {
    _id: false,
  }
);

const jobPaymentSchema = new mongoose.Schema(
  {
    // --- PURCHASE IDENTITY / OWNERSHIP ---

    purchaseReference: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      immutable: true,
      maxlength: MAX_JOB_PAYMENT_PURCHASE_REFERENCE_LENGTH,
    },

    entitlementConsumptionReference: {
      type: String,
      trim: true,
      required: true,
      immutable: true,
      maxlength: MAX_JOB_PAYMENT_ENTITLEMENT_REFERENCE_LENGTH,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobPostingPlan",
      required: true,
      immutable: true,
    },

    purchasedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // --- PURCHASED TERMS ---

    planSnapshot: {
      type: planSnapshotSchema,
      required: true,
      immutable: true,
    },

    // --- PAYMENT METHOD / LEDGER PROVENANCE ---

    paymentMethod: {
      type: String,
      enum: JOB_PAYMENT_METHODS,
      required: true,
      immutable: true,
    },

    /**
     * Canonical platform-side money receipt for the purchase.
     *
     * wallet:
     *   platform-wallet credit from the employer-wallet transfer.
     *
     * paystack_checkout:
     *   platform-wallet external Paystack credit.
     */
    paymentTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    paymentProvider: {
      type: String,
      enum: JOB_PAYMENT_PROVIDERS,
      default: null,
    },

    providerReference: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_PAYMENT_PROVIDER_REFERENCE_LENGTH,
      default: null,
    },

    providerStatus: {
      type: String,
      enum: JOB_PAYMENT_PROVIDER_STATUSES,
      default: null,
    },

    // --- PAYMENT LIFECYCLE ---

    paymentStatus: {
      type: String,
      enum: JOB_PAYMENT_STATUSES,
      default: "pending",
      required: true,
    },

    paidAt: {
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
      maxlength: MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    refundedAt: {
      type: Date,
      default: null,
    },

    // --- PUBLICATION ENTITLEMENT CONSUMPTION ---

    consumedAt: {
      type: Date,
      default: null,
    },

    consumedForJob: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      default: null,
    },

    consumedByPublication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobPublication",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

jobPaymentSchema.pre("validate", function validateJobPayment() {
  // Parent immutability alone does not reject edits to nested purchased terms.
  if (!this.isNew && this.isModified("planSnapshot")) {
    this.invalidate("planSnapshot", "Purchased Job payment terms cannot change after creation.");
  }

  const hasConsumption = Boolean(
    this.consumedAt || this.consumedForJob || this.consumedByPublication
  );

  if (this.paymentMethod === "wallet") {
    if (this.paymentProvider || this.providerReference || this.providerStatus) {
      this.invalidate(
        "paymentProvider",
        "Wallet Job payments cannot contain external payment-provider details."
      );
    }

    if (["paid", "refunded"].includes(this.paymentStatus) && !this.paymentTransaction) {
      this.invalidate(
        "paymentTransaction",
        "A paid or refunded wallet Job payment requires its platform-wallet credit Transaction."
      );
    }
  }

  if (this.paymentMethod === "paystack_checkout") {
    if (!this.paymentTransaction) {
      this.invalidate(
        "paymentTransaction",
        "Paystack Checkout Job payments require their platform-wallet payment Transaction."
      );
    }

    if (this.paymentProvider !== "paystack") {
      this.invalidate(
        "paymentProvider",
        "Paystack Checkout Job payments must use paystack as the payment provider."
      );
    }

    if (!this.providerReference) {
      this.invalidate(
        "providerReference",
        "Paystack Checkout Job payments require a provider reference."
      );
    }

    if (!this.providerStatus) {
      this.invalidate(
        "providerStatus",
        "Paystack Checkout Job payments require a provider status."
      );
    }

    if (this.paymentStatus === "paid" && this.providerStatus !== "success") {
      this.invalidate(
        "providerStatus",
        "A paid Paystack Checkout Job payment requires providerStatus success."
      );
    }

    if (this.paymentStatus === "failed" && this.providerStatus !== "failed") {
      this.invalidate(
        "providerStatus",
        "A failed Paystack Checkout Job payment requires providerStatus failed."
      );
    }

    if (
      this.paymentStatus === "refunded" &&
      !["success", "reversed"].includes(this.providerStatus)
    ) {
      this.invalidate(
        "providerStatus",
        "A refunded Paystack Checkout Job payment requires a successful or reversed provider state."
      );
    }
  }

  if (this.paymentStatus === "pending") {
    if (this.paidAt || this.failedAt || this.cancelledAt || this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "A pending Job payment cannot contain completed payment lifecycle timestamps."
      );
    }

    if (hasConsumption) {
      this.invalidate("consumedAt", "A pending Job payment cannot be consumed.");
    }
  }

  if (this.paymentStatus === "paid") {
    if (!this.paidAt) {
      this.invalidate("paidAt", "A paid Job payment requires paidAt.");
    }

    if (!this.paymentTransaction) {
      this.invalidate(
        "paymentTransaction",
        "A paid Job payment requires its platform-side payment Transaction."
      );
    }

    if (this.failedAt || this.cancelledAt || this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "A paid Job payment cannot contain failed, cancelled or refunded lifecycle timestamps."
      );
    }
  }

  if (this.paymentStatus === "failed") {
    if (!this.failedAt) {
      this.invalidate("failedAt", "A failed Job payment requires failedAt.");
    }

    if (this.paidAt || this.cancelledAt || this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "A failed Job payment cannot contain paid, cancelled or refunded lifecycle timestamps."
      );
    }

    if (hasConsumption) {
      this.invalidate("consumedAt", "A failed Job payment cannot be consumed.");
    }
  }

  if (this.paymentStatus === "cancelled") {
    if (!this.cancelledAt) {
      this.invalidate("cancelledAt", "A cancelled Job payment requires cancelledAt.");
    }

    if (this.paidAt || this.failedAt || this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "A cancelled Job payment cannot contain paid, failed or refunded lifecycle timestamps."
      );
    }

    if (hasConsumption) {
      this.invalidate("consumedAt", "A cancelled Job payment cannot be consumed.");
    }
  }

  if (this.paymentStatus === "refunded") {
    if (!this.paidAt) {
      this.invalidate("paidAt", "A refunded Job payment requires the original paidAt timestamp.");
    }

    if (!this.paymentTransaction) {
      this.invalidate(
        "paymentTransaction",
        "A refunded Job payment requires its original platform-side payment Transaction."
      );
    }

    if (!this.refundedAt) {
      this.invalidate("refundedAt", "A refunded Job payment requires refundedAt.");
    }

    if (this.failedAt || this.cancelledAt) {
      this.invalidate(
        "paymentStatus",
        "A refunded Job payment cannot contain failed or cancelled lifecycle timestamps."
      );
    }

    if (this.paidAt && this.refundedAt && this.refundedAt < this.paidAt) {
      this.invalidate("refundedAt", "A Job payment cannot be refunded before it was paid.");
    }
  }

  if (Boolean(this.failureReason) !== Boolean(this.failedAt)) {
    this.invalidate(
      "failureReason",
      "failureReason and failedAt must either both be set or both be empty."
    );
  }

  if (Boolean(this.consumedAt) !== Boolean(this.consumedForJob)) {
    this.invalidate(
      "consumedForJob",
      "consumedAt and consumedForJob must either both be set or both be empty."
    );
  }

  if (this.consumedByPublication && !this.consumedAt) {
    this.invalidate(
      "consumedByPublication",
      "consumedByPublication requires the PAYG entitlement to have been consumed."
    );
  }

  if (this.consumedAt && !["paid", "refunded"].includes(this.paymentStatus)) {
    this.invalidate(
      "consumedAt",
      "Only a successfully paid PAYG Job publication entitlement can have consumption history."
    );
  }

  if (this.consumedAt && this.refundedAt && this.consumedAt > this.refundedAt) {
    this.invalidate(
      "consumedAt",
      "A refunded PAYG entitlement cannot be consumed after the refund occurred."
    );
  }

  if (this.consumedAt && !this.paidAt) {
    this.invalidate(
      "consumedAt",
      "A PAYG publication entitlement cannot be consumed before payment."
    );
  }

  if (this.consumedAt && this.paidAt && this.consumedAt < this.paidAt) {
    this.invalidate(
      "consumedAt",
      "A PAYG publication entitlement cannot be consumed before paidAt."
    );
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

jobPaymentSchema.index(
  {
    purchaseReference: 1,
  },
  {
    unique: true,
  }
);

jobPaymentSchema.index(
  {
    entitlementConsumptionReference: 1,
  },
  {
    unique: true,
  }
);

jobPaymentSchema.index(
  {
    providerReference: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerReference: {
        $type: "string",
      },
    },
  }
);

jobPaymentSchema.index({
  business: 1,
  paymentStatus: 1,
  consumedAt: 1,
  createdAt: -1,
});

jobPaymentSchema.index({
  plan: 1,
  paymentStatus: 1,
  createdAt: -1,
});

jobPaymentSchema.index(
  {
    paymentTransaction: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      paymentTransaction: {
        $type: "objectId",
      },
    },
  }
);

jobPaymentSchema.index(
  {
    consumedByPublication: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      consumedByPublication: {
        $type: "objectId",
      },
    },
  }
);

jobPaymentSchema.index({
  consumedForJob: 1,
  consumedAt: -1,
});

module.exports = mongoose.model("JobPayment", jobPaymentSchema);
