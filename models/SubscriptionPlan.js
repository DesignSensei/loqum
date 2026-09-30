// models/SubscriptionPlan.js

const mongoose = require("mongoose");

const {
  nonNegativeIntegerField,
  requiredPositiveMinorUnitAmountField,
  requiredPositiveSafeIntegerField,
} = require("./helpers/schemaFields");

const {
  SUBSCRIPTION_PLAN_STATUSES,
  SUBSCRIPTION_BILLING_CYCLES,
  MAX_COMMERCIAL_PLAN_CODE_LENGTH,
  MAX_COMMERCIAL_PLAN_NAME_LENGTH,
  MAX_COMMERCIAL_PLAN_DESCRIPTION_LENGTH,
  MAX_COMMERCIAL_FEATURE_KEYS,
  MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
} = require("../constants/employerMonetization");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");

/**
 * SUBSCRIPTION PLAN:
 *
 * Defines one recurring employer commercial product sold by Loqum.
 *
 * A SubscriptionPlan is product configuration, not employer subscription state.
 * Employers receive their own Subscription records when they actually subscribe.
 *
 * COMMERCIAL HISTORY:
 *
 * code + version identify one commercial version of a plan. Once a plan version
 * has been used commercially, administrative services should retire/version it
 * instead of rewriting historical terms relied upon by existing subscriptions.
 * Subscription records must snapshot the exact purchased terms.
 *
 * BENEFITS:
 *
 * activeJobSlots defines how many subscription-funded permanent Jobs the employer
 * may have actively published at the same time. Slots are reusable capacity, not
 * consumable publication credits. Ending or closing a qualifying Job publication
 * releases its slot for another Job while the subscription remains active.
 *
 * Subscription-funded publications do not have a fixed publication-duration
 * clock. Subscription cancellation, expiry or downgrade enforcement belongs to
 * the subscription Job lifecycle layer rather than this plan model.
 *
 * basePlatformFeeRate is an optional subscriber BASE Shift platform-fee benefit.
 * Overtime does not inherit this benefit at launch. Individual Shifts still
 * preserve the exact standard and applied fee-rate snapshots used when priced.
 *
 * COUNTRY / CURRENCY:
 *
 * Plans are scoped to a country and currency. Monetary values are stored in
 * currency minor units.
 */

const isSupportedFinancialRate = (value) => {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return false;
  }

  try {
    money.scaleRate({
      rate: value,
      rateScale: FINANCIAL_RATE_SCALE,
      fieldName: "basePlatformFeeRate",
    });

    return true;
  } catch (error) {
    return false;
  }
};

const subscriptionBenefitsSchema = new mongoose.Schema(
  {
    activeJobSlots: nonNegativeIntegerField({
      required: true,
      defaultValue: 0,
    }),

    basePlatformFeeRate: {
      type: Number,
      default: null,
      min: 0,
      max: 1,
      validate: {
        validator: isSupportedFinancialRate,
        message: "basePlatformFeeRate must use the supported financial rate precision.",
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
            "Each subscription feature key must contain only lowercase letters, numbers, underscores or hyphens.",
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

const subscriptionPlanSchema = new mongoose.Schema(
  {
    // --- COMMERCIAL IDENTITY ---

    code: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      immutable: true,
      maxlength: MAX_COMMERCIAL_PLAN_CODE_LENGTH,
      match: [
        /^[A-Z0-9][A-Z0-9_-]*$/,
        "Subscription plan code must contain only uppercase letters, numbers, underscores or hyphens.",
      ],
    },

    version: {
      ...requiredPositiveSafeIntegerField({
        label: "version",
      }),
      default: 1,
      immutable: true,
    },

    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_COMMERCIAL_PLAN_NAME_LENGTH,
    },

    description: {
      type: String,
      trim: true,
      default: null,
      maxlength: MAX_COMMERCIAL_PLAN_DESCRIPTION_LENGTH,
    },

    // --- MARKET / PRICING ---

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      minlength: 2,
      maxlength: 2,
      match: [/^[A-Z]{2}$/, "countryCode must contain exactly 2 uppercase letters."],
    },

    currency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, "currency must contain exactly 3 uppercase letters."],
    },

    priceMinor: requiredPositiveMinorUnitAmountField("priceMinor"),

    billingCycle: {
      type: String,
      enum: SUBSCRIPTION_BILLING_CYCLES,
      required: true,
    },

    // --- BENEFITS ---

    benefits: {
      type: subscriptionBenefitsSchema,
      default: () => ({}),
      required: true,
    },

    // --- PRODUCT LIFECYCLE ---

    status: {
      type: String,
      enum: SUBSCRIPTION_PLAN_STATUSES,
      default: "draft",
      required: true,
    },

    activatedAt: {
      type: Date,
      default: null,
    },

    retiredAt: {
      type: Date,
      default: null,
    },

    // --- ADMIN AUDIT ---

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

subscriptionPlanSchema.pre("validate", function validateSubscriptionPlanLifecycle() {
  if (this.status === "draft") {
    if (this.activatedAt) {
      this.invalidate("activatedAt", "A draft subscription plan cannot have activatedAt set.");
    }

    if (this.retiredAt) {
      this.invalidate("retiredAt", "A draft subscription plan cannot have retiredAt set.");
    }

    return;
  }

  if (!this.activatedAt) {
    this.invalidate("activatedAt", "An active or retired subscription plan requires activatedAt.");
  }

  if (this.status === "active") {
    if (this.retiredAt) {
      this.invalidate("retiredAt", "An active subscription plan cannot have retiredAt set.");
    }

    return;
  }

  if (!this.retiredAt) {
    this.invalidate("retiredAt", "A retired subscription plan requires retiredAt.");
  }

  if (this.activatedAt && this.retiredAt && this.retiredAt < this.activatedAt) {
    this.invalidate("retiredAt", "A subscription plan cannot retire before it was activated.");
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

subscriptionPlanSchema.index(
  {
    code: 1,
    countryCode: 1,
    currency: 1,
    version: 1,
  },
  {
    unique: true,
  }
);

subscriptionPlanSchema.index(
  {
    code: 1,
    countryCode: 1,
    currency: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      status: "active",
    },
  }
);

subscriptionPlanSchema.index({
  countryCode: 1,
  currency: 1,
  status: 1,
  billingCycle: 1,
  name: 1,
});

module.exports = mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
