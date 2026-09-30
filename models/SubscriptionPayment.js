// models/SubscriptionPayment.js
const mongoose = require("mongoose");

const {
  SUBSCRIPTION_BILLING_CYCLES,
  MAX_COMMERCIAL_PLAN_CODE_LENGTH,
  MAX_COMMERCIAL_PLAN_NAME_LENGTH,
  MAX_COMMERCIAL_FEATURE_KEYS,
  MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
  MAX_SUBSCRIPTION_BILLING_CYCLE_KEY_LENGTH,
  MAX_JOB_PAYMENT_PROVIDER_REFERENCE_LENGTH,
  MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH,
} = require("../constants/employerMonetization");

const { isNonNegativeSafeInteger, isPositiveSafeInteger } = require("./helpers/schemaValidators");

/**
 * SUBSCRIPTION PAYMENT ARCHITECTURE
 *
 * SubscriptionPayment is the authoritative commercial payment record for one
 * purchased subscription period or immediate plan-change purchase.
 *
 * It is deliberately separate from Subscription lifecycle state.
 *
 * PAYMENT KINDS:
 *
 * - initial_purchase:
 *   creates and pays for the first active period of a new Subscription;
 *
 * - plan_change:
 *   pays for an immediate replacement plan on the same continuing Subscription.
 *   The previous plan stops being effective when the paid plan change is applied,
 *   unused value/time from that previous plan is forfeited, and the target plan
 *   starts a fresh purchased billing period;
 *
 * - renewal:
 *   pays for the next period of the currently effective plan. A renewal may be
 *   paid early and remain unapplied until currentPeriodEnd.
 *
 * PERIOD IDENTITY:
 *
 * Renewal payments know their future billingCycleKey, periodStart and periodEnd
 * when the payment record is created. Initial purchases and plan changes do not
 * know their applied period until SubscriptionService successfully applies them;
 * their period fields are stamped together with appliedAt.
 *
 * Canonical receipt rule:
 *
 * - wallet purchase:
 *   Employer wallet -> Platform wallet
 *   SubscriptionPayment.paymentTransaction points to the platform credit.
 *
 * - Paystack purchase / plan change / renewal:
 *   Paystack -> Platform wallet
 *   SubscriptionPayment.paymentTransaction points to the platform credit.
 *
 * Therefore paymentTransaction always represents the canonical platform-side
 * receipt of subscription money.
 */

const SUBSCRIPTION_PAYMENT_KINDS = Object.freeze(["initial_purchase", "plan_change", "renewal"]);

const SUBSCRIPTION_PAYMENT_METHODS = Object.freeze([
  "wallet",
  "paystack_checkout",
  "paystack_authorization",
]);

const SUBSCRIPTION_PAYMENT_STATUSES = Object.freeze([
  "pending",
  "paid",
  "failed",
  "cancelled",
  "refunded",
]);

const SUBSCRIPTION_PAYMENT_PROVIDERS = Object.freeze(["paystack", null]);

const SUBSCRIPTION_PAYMENT_PROVIDER_STATUSES = Object.freeze([
  "pending",
  "success",
  "failed",
  "reversed",
  null,
]);

const MAX_SUBSCRIPTION_PAYMENT_REFERENCE_LENGTH = 180;
const MAX_PROVIDER_AUTHORIZATION_CODE_LENGTH = 250;
const MAX_PROVIDER_AUTHORIZATION_SIGNATURE_LENGTH = 250;
const MAX_PROVIDER_AUTHORIZATION_EMAIL_LENGTH = 320;
const MAX_PROVIDER_AUTHORIZATION_LABEL_LENGTH = 120;

function requiredPositiveMinorUnitAmountField(label) {
  return {
    type: Number,
    required: true,
    min: [1, `${label} must be greater than zero.`],
    validate: {
      validator: isPositiveSafeInteger,
      message: `${label} must be a positive whole-number minor-unit amount.`,
    },
  };
}

function requiredPositiveSafeIntegerField(label) {
  return {
    type: Number,
    required: true,
    min: [1, `${label} must be greater than zero.`],
    validate: {
      validator: isPositiveSafeInteger,
      message: `${label} must be a positive whole number.`,
    },
  };
}

function optionalTrimmedStringField(maxlength) {
  return {
    type: String,
    trim: true,
    maxlength,
    default: null,
  };
}

const subscriptionBenefitsSnapshotSchema = new mongoose.Schema(
  {
    activeJobSlots: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: "activeJobSlots must be a non-negative whole number.",
      },
    },

    basePlatformFeeRate: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },

    featureKeys: {
      type: [String],
      default: () => [],
      validate: [
        {
          validator(value) {
            return Array.isArray(value) && value.length <= MAX_COMMERCIAL_FEATURE_KEYS;
          },
          message: `featureKeys cannot contain more than ${MAX_COMMERCIAL_FEATURE_KEYS} values.`,
        },
        {
          validator(value) {
            return new Set(value).size === value.length;
          },
          message: "featureKeys cannot contain duplicates.",
        },
      ],
    },
  },
  {
    _id: false,
  }
);

subscriptionBenefitsSnapshotSchema.path("featureKeys").set((value) => {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item) => String(item).trim().toLowerCase());
});

subscriptionBenefitsSnapshotSchema
  .path("featureKeys")
  .validate(
    (value) =>
      Array.isArray(value) &&
      value.every(
        (item) =>
          item.length > 0 &&
          item.length <= MAX_COMMERCIAL_FEATURE_KEY_LENGTH &&
          /^[a-z0-9][a-z0-9_-]*$/.test(item)
      ),
    `Each feature key must be lowercase, valid and no longer than ${MAX_COMMERCIAL_FEATURE_KEY_LENGTH} characters.`
  );

const subscriptionPlanSnapshotSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_COMMERCIAL_PLAN_CODE_LENGTH,
      immutable: true,
    },

    version: {
      ...requiredPositiveSafeIntegerField("planSnapshot.version"),
      immutable: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_COMMERCIAL_PLAN_NAME_LENGTH,
      immutable: true,
    },

    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "planSnapshot.countryCode must be a valid two-letter country code."],
      immutable: true,
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "planSnapshot.currency must be a valid three-letter currency code."],
      immutable: true,
    },

    priceMinor: {
      ...requiredPositiveMinorUnitAmountField("planSnapshot.priceMinor"),
      immutable: true,
    },

    billingCycle: {
      type: String,
      enum: SUBSCRIPTION_BILLING_CYCLES,
      required: true,
      immutable: true,
    },

    benefits: {
      type: subscriptionBenefitsSnapshotSchema,
      required: true,
      immutable: true,
    },
  },
  {
    _id: false,
  }
);

const providerAuthorizationSchema = new mongoose.Schema(
  {
    authorizationCode: {
      type: String,
      trim: true,
      maxlength: MAX_PROVIDER_AUTHORIZATION_CODE_LENGTH,
      default: null,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: MAX_PROVIDER_AUTHORIZATION_EMAIL_LENGTH,
      default: null,
    },

    signature: {
      type: String,
      trim: true,
      maxlength: MAX_PROVIDER_AUTHORIZATION_SIGNATURE_LENGTH,
      default: null,
    },

    reusable: {
      type: Boolean,
      default: false,
    },

    channel: optionalTrimmedStringField(MAX_PROVIDER_AUTHORIZATION_LABEL_LENGTH),
    cardType: optionalTrimmedStringField(MAX_PROVIDER_AUTHORIZATION_LABEL_LENGTH),
    bank: optionalTrimmedStringField(MAX_PROVIDER_AUTHORIZATION_LABEL_LENGTH),
    last4: optionalTrimmedStringField(4),
    expMonth: optionalTrimmedStringField(2),
    expYear: optionalTrimmedStringField(4),
    countryCode: optionalTrimmedStringField(2),
    accountName: optionalTrimmedStringField(MAX_PROVIDER_AUTHORIZATION_LABEL_LENGTH),
  },
  {
    _id: false,
  }
);

providerAuthorizationSchema.pre("validate", function validateProviderAuthorization() {
  if (this.reusable === true) {
    if (!this.authorizationCode) {
      this.invalidate(
        "authorizationCode",
        "Reusable provider authorization requires authorizationCode."
      );
    }

    if (!this.email) {
      this.invalidate(
        "email",
        "Reusable provider authorization requires the original payment email."
      );
    }
  }
});

const subscriptionPaymentSchema = new mongoose.Schema(
  {
    paymentReference: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_SUBSCRIPTION_PAYMENT_REFERENCE_LENGTH,
      immutable: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
      immutable: true,
    },

    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
      immutable: true,
    },

    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      immutable: true,
    },

    paymentKind: {
      type: String,
      enum: SUBSCRIPTION_PAYMENT_KINDS,
      required: true,
      immutable: true,
    },

    planSnapshot: {
      type: subscriptionPlanSnapshotSchema,
      required: true,
      immutable: true,
    },

    billingCycleKey: {
      type: String,
      trim: true,
      maxlength: MAX_SUBSCRIPTION_BILLING_CYCLE_KEY_LENGTH,
      default: null,
    },

    periodStart: {
      type: Date,
      default: null,
    },

    periodEnd: {
      type: Date,
      default: null,
    },

    paymentMethod: {
      type: String,
      enum: SUBSCRIPTION_PAYMENT_METHODS,
      required: true,
      immutable: true,
    },

    paymentTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    paymentProvider: {
      type: String,
      enum: SUBSCRIPTION_PAYMENT_PROVIDERS,
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
      enum: SUBSCRIPTION_PAYMENT_PROVIDER_STATUSES,
      default: null,
    },

    providerAuthorization: {
      type: providerAuthorizationSchema,
      default: null,
    },

    paymentStatus: {
      type: String,
      enum: SUBSCRIPTION_PAYMENT_STATUSES,
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

    appliedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

subscriptionPaymentSchema.pre("validate", function validateSubscriptionPayment() {
  const isWallet = this.paymentMethod === "wallet";
  const isPaystackCheckout = this.paymentMethod === "paystack_checkout";
  const isPaystackAuthorization = this.paymentMethod === "paystack_authorization";
  const isPaystack = isPaystackCheckout || isPaystackAuthorization;

  if (this.periodStart && this.periodEnd && this.periodEnd <= this.periodStart) {
    this.invalidate("periodEnd", "periodEnd must be after periodStart.");
  }

  if (Boolean(this.periodStart) !== Boolean(this.periodEnd)) {
    this.invalidate(
      this.periodStart ? "periodEnd" : "periodStart",
      "periodStart and periodEnd must be set together."
    );
  }

  const isImmediatePurchase = ["initial_purchase", "plan_change"].includes(this.paymentKind);

  if (this.paymentKind === "renewal") {
    if (!this.billingCycleKey || !this.periodStart || !this.periodEnd) {
      this.invalidate(
        "billingCycleKey",
        "A renewal payment must identify its target billing cycle and purchased period."
      );
    }
  }

  if (isImmediatePurchase && !this.appliedAt) {
    if (this.billingCycleKey || this.periodStart || this.periodEnd) {
      this.invalidate(
        "billingCycleKey",
        "An unapplied initial purchase or plan change cannot identify its billing period yet."
      );
    }
  }

  if (isPaystackAuthorization && this.paymentKind !== "renewal") {
    this.invalidate(
      "paymentMethod",
      "Stored Paystack authorization may only be used for a subscription renewal."
    );
  }

  if (isWallet) {
    if (this.paymentProvider !== null) {
      this.invalidate(
        "paymentProvider",
        "Wallet subscription payment cannot have a payment provider."
      );
    }

    if (this.providerReference !== null) {
      this.invalidate(
        "providerReference",
        "Wallet subscription payment cannot have a provider reference."
      );
    }

    if (this.providerStatus !== null) {
      this.invalidate(
        "providerStatus",
        "Wallet subscription payment cannot have a provider status."
      );
    }

    if (this.providerAuthorization !== null) {
      this.invalidate(
        "providerAuthorization",
        "Wallet subscription payment cannot have provider authorization details."
      );
    }
  }

  if (isPaystack) {
    if (this.paymentProvider !== "paystack") {
      this.invalidate(
        "paymentProvider",
        "Paystack subscription payment must use paymentProvider paystack."
      );
    }

    if (!this.providerReference) {
      this.invalidate(
        "providerReference",
        "Paystack subscription payment requires providerReference."
      );
    }

    if (!this.providerStatus) {
      this.invalidate("providerStatus", "Paystack subscription payment requires providerStatus.");
    }

    if (isPaystackAuthorization) {
      const authorization = this.providerAuthorization;

      if (
        !authorization ||
        !authorization.authorizationCode ||
        !authorization.email ||
        authorization.reusable !== true
      ) {
        this.invalidate(
          "providerAuthorization",
          "Paystack authorization renewal requires a reusable authorization code and original payment email."
        );
      }
    }
  }

  if (this.paymentStatus === "pending") {
    if (this.paidAt || this.failedAt || this.cancelledAt || this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "Pending payment cannot contain a terminal payment timestamp."
      );
    }
  }

  if (this.paymentStatus === "paid") {
    if (!this.paidAt) {
      this.invalidate("paidAt", "Paid subscription payment requires paidAt.");
    }

    if (!this.paymentTransaction) {
      this.invalidate(
        "paymentTransaction",
        "Paid subscription payment requires the canonical platform receipt transaction."
      );
    }

    if (this.failedAt || this.cancelledAt || this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "Paid payment cannot contain failed, cancelled or refunded timestamps."
      );
    }

    if (isPaystack && this.providerStatus !== "success") {
      this.invalidate(
        "providerStatus",
        "Paid Paystack subscription payment requires providerStatus success."
      );
    }
  }

  if (this.paymentStatus === "failed") {
    if (!this.failedAt) {
      this.invalidate("failedAt", "Failed subscription payment requires failedAt.");
    }

    if (!this.failureReason) {
      this.invalidate("failureReason", "Failed subscription payment requires failureReason.");
    }

    if (this.paidAt || this.cancelledAt || this.refundedAt || this.appliedAt) {
      this.invalidate(
        "paymentStatus",
        "Failed payment cannot be paid, cancelled, refunded or applied."
      );
    }

    if (isPaystack && this.providerStatus !== "failed") {
      this.invalidate(
        "providerStatus",
        "Failed Paystack subscription payment requires providerStatus failed."
      );
    }
  }

  if (this.paymentStatus === "cancelled") {
    if (!this.cancelledAt) {
      this.invalidate("cancelledAt", "Cancelled subscription payment requires cancelledAt.");
    }

    if (this.paidAt || this.failedAt || this.refundedAt || this.appliedAt) {
      this.invalidate(
        "paymentStatus",
        "Cancelled payment cannot be paid, failed, refunded or applied."
      );
    }
  }

  if (this.paymentStatus === "refunded") {
    if (!this.paidAt || !this.refundedAt) {
      this.invalidate(
        "paymentStatus",
        "Refunded subscription payment requires paidAt and refundedAt."
      );
    }

    if (!this.paymentTransaction) {
      this.invalidate(
        "paymentTransaction",
        "Refunded subscription payment requires the original canonical platform receipt transaction."
      );
    }

    if (this.failedAt || this.cancelledAt) {
      this.invalidate("paymentStatus", "Refunded payment cannot also be failed or cancelled.");
    }

    if (this.refundedAt < this.paidAt) {
      this.invalidate("refundedAt", "refundedAt cannot be before paidAt.");
    }

    if (isPaystack && !["success", "reversed"].includes(this.providerStatus)) {
      this.invalidate(
        "providerStatus",
        "Refunded Paystack subscription payment requires providerStatus success or reversed."
      );
    }
  }

  if (Boolean(this.failedAt) !== Boolean(this.failureReason)) {
    this.invalidate(
      this.failedAt ? "failureReason" : "failedAt",
      "failedAt and failureReason must be set together."
    );
  }

  if (this.appliedAt) {
    if (!["paid", "refunded"].includes(this.paymentStatus)) {
      this.invalidate("appliedAt", "Only a successfully paid subscription payment can be applied.");
    }

    if (!this.paidAt) {
      this.invalidate("paidAt", "Applied subscription payment requires paidAt.");
    }

    if (!this.periodStart || !this.periodEnd || !this.billingCycleKey) {
      this.invalidate(
        "appliedAt",
        "Applied subscription payment must identify the applied billing cycle and period."
      );
    }

    if (this.appliedAt < this.paidAt) {
      this.invalidate("appliedAt", "appliedAt cannot be before paidAt.");
    }
  }

  // Persist late verified money for reconciliation, but never represent it as
  // applied renewal authority. This mirrors the payment service's boundary rule.
  if (this.paymentKind === "renewal" && this.appliedAt) {
    if (this.periodStart && this.appliedAt < this.periodStart) {
      this.invalidate(
        "appliedAt",
        "A renewal cannot be applied before its purchased period starts."
      );
    }
    if (this.paidAt && this.periodStart && this.paidAt > this.periodStart) {
      this.invalidate(
        "appliedAt",
        "A renewal paid after its period starts requires reconciliation and cannot be applied."
      );
    }
  }

  // Early renewal is intentionally valid. paidAt may be before periodStart.
  // Initial purchases and plan changes receive period identity only when applied.
});

subscriptionPaymentSchema.index(
  { paymentReference: 1 },
  {
    unique: true,
    name: "subscription_payment_reference_unique",
  }
);

subscriptionPaymentSchema.index(
  { providerReference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerReference: {
        $type: "string",
      },
    },
    name: "subscription_payment_provider_reference_unique",
  }
);

subscriptionPaymentSchema.index(
  { business: 1, paymentStatus: 1, createdAt: -1 },
  {
    name: "subscription_payment_business_status_created",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, paymentStatus: 1, createdAt: -1 },
  {
    name: "subscription_payment_subscription_status_created",
  }
);

subscriptionPaymentSchema.index(
  { plan: 1, paymentStatus: 1, createdAt: -1 },
  {
    name: "subscription_payment_plan_status_created",
  }
);

subscriptionPaymentSchema.index(
  { paymentTransaction: 1 },
  {
    name: "subscription_payment_transaction",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, billingCycleKey: 1, paymentStatus: 1 },
  {
    unique: true,
    partialFilterExpression: {
      billingCycleKey: {
        $type: "string",
      },
      paymentStatus: "paid",
    },
    name: "subscription_paid_billing_cycle_unique",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, paymentKind: 1, paymentStatus: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentKind: "initial_purchase",
      paymentStatus: "paid",
    },
    name: "subscription_initial_paid_once",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, paymentKind: 1, paymentStatus: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentKind: "initial_purchase",
      paymentStatus: "pending",
    },
    name: "subscription_initial_pending_once",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, paymentKind: 1, paymentStatus: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentKind: "plan_change",
      paymentStatus: "pending",
    },
    name: "subscription_plan_change_pending_once",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, paymentKind: 1, appliedAt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentKind: "plan_change",
      paymentStatus: "paid",
      appliedAt: null,
    },
    name: "subscription_paid_unapplied_plan_change_once",
  }
);

subscriptionPaymentSchema.index(
  {
    subscription: 1,
    billingCycleKey: 1,
    paymentKind: 1,
    paymentStatus: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      paymentKind: "renewal",
      billingCycleKey: {
        $type: "string",
      },
      paymentStatus: "pending",
    },
    name: "subscription_renewal_pending_billing_cycle_unique",
  }
);

subscriptionPaymentSchema.index(
  { subscription: 1, paymentKind: 1, appliedAt: 1 },
  {
    unique: true,
    partialFilterExpression: {
      paymentKind: "renewal",
      paymentStatus: "paid",
      appliedAt: null,
    },
    name: "subscription_paid_unapplied_renewal_once",
  }
);

subscriptionPaymentSchema.index(
  { paymentStatus: 1, appliedAt: 1, periodStart: 1 },
  {
    name: "subscription_payment_pending_application",
  }
);

// ID-ordered recovery sweeps; period eligibility remains a query filter.
subscriptionPaymentSchema.index(
  { paymentStatus: 1, appliedAt: 1, _id: 1 },
  { name: "subscription_payment_application_sweep" }
);
subscriptionPaymentSchema.index(
  { paymentStatus: 1, paymentProvider: 1, _id: 1 },
  { name: "subscription_payment_verification_sweep" }
);

module.exports = mongoose.model("SubscriptionPayment", subscriptionPaymentSchema);
