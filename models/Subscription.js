// models/Subscription.js

const mongoose = require("mongoose");

const {
  nonNegativeIntegerField,
  requiredPositiveMinorUnitAmountField,
  requiredPositiveSafeIntegerField,
} = require("./helpers/schemaFields");

const {
  SUBSCRIPTION_BILLING_CYCLES,
  SUBSCRIPTION_STATUSES,
  MAX_COMMERCIAL_PLAN_CODE_LENGTH,
  MAX_COMMERCIAL_PLAN_NAME_LENGTH,
  MAX_COMMERCIAL_FEATURE_KEYS,
  MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
  MAX_SUBSCRIPTION_REFERENCE_LENGTH,
} = require("../constants/employerMonetization");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");

const MAX_PLAN_CHANGE_PAYMENT_REFERENCE_LENGTH = 180;

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

const sameDate = (left, right) => {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  const leftDate = left instanceof Date ? left : new Date(left);
  const rightDate = right instanceof Date ? right : new Date(right);

  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) {
    return false;
  }

  return leftDate.getTime() === rightDate.getTime();
};

const planBenefitsSnapshotSchema = new mongoose.Schema(
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
        "Subscription plan code must contain only uppercase letters, numbers, underscores or hyphens.",
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

    billingCycle: {
      type: String,
      enum: SUBSCRIPTION_BILLING_CYCLES,
      required: true,
    },

    benefits: {
      type: planBenefitsSnapshotSchema,
      required: true,
    },
  },
  {
    _id: false,
  }
);

const pendingPlanChangeSchema = new mongoose.Schema(
  {
    changeType: {
      type: String,
      enum: ["upgrade", "downgrade"],
      required: true,
    },

    targetPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },

    targetPlanSnapshot: {
      type: planSnapshotSchema,
      required: true,
    },

    paymentReference: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      maxlength: MAX_PLAN_CHANGE_PAYMENT_REFERENCE_LENGTH,
    },

    requestedAt: {
      type: Date,
      required: true,
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    retainedPublicationIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "JobPublication",
        },
      ],
      default: [],
      validate: {
        validator: (values) => {
          if (!Array.isArray(values)) {
            return false;
          }

          const normalizedValues = values.map((value) => String(value));

          return new Set(normalizedValues).size === normalizedValues.length;
        },
        message: "pendingPlanChange.retainedPublicationIds cannot contain duplicates.",
      },
    },
  },
  {
    _id: false,
  }
);

pendingPlanChangeSchema.pre("validate", function validatePendingPlanChange() {
  const retainedPublicationIds = Array.isArray(this.retainedPublicationIds)
    ? this.retainedPublicationIds
    : [];

  if (this.changeType === "upgrade" && retainedPublicationIds.length > 0) {
    this.invalidate(
      "retainedPublicationIds",
      "An upgrade cannot specify retained Job publications."
    );
  }

  const targetCapacity = Number(this.targetPlanSnapshot?.benefits?.activeJobSlots);

  if (
    this.changeType === "downgrade" &&
    Number.isSafeInteger(targetCapacity) &&
    retainedPublicationIds.length > targetCapacity
  ) {
    this.invalidate(
      "retainedPublicationIds",
      "Retained Job publications cannot exceed the target plan's active Job-slot capacity."
    );
  }
});

const planChangeHistoryEntrySchema = new mongoose.Schema(
  {
    changeType: {
      type: String,
      enum: ["upgrade", "downgrade"],
      required: true,
    },

    fromPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },

    toPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },

    paymentReference: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      maxlength: MAX_PLAN_CHANGE_PAYMENT_REFERENCE_LENGTH,
    },

    requestedAt: {
      type: Date,
      required: true,
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    effectiveAt: {
      type: Date,
      required: true,
    },

    appliedAt: {
      type: Date,
      required: true,
    },

    retainedPublicationIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "JobPublication",
        },
      ],
      default: [],
      validate: {
        validator: (values) => {
          if (!Array.isArray(values)) {
            return false;
          }

          const normalizedValues = values.map((value) => String(value));

          return new Set(normalizedValues).size === normalizedValues.length;
        },
        message: "planChangeHistory.retainedPublicationIds cannot contain duplicates.",
      },
    },
  },
  {
    _id: false,
  }
);

planChangeHistoryEntrySchema.pre("validate", function validatePlanChangeHistoryEntry() {
  if (String(this.fromPlan) === String(this.toPlan)) {
    this.invalidate(
      "toPlan",
      "A subscription plan-change history entry must move to a different plan."
    );
  }

  if (
    this.changeType === "upgrade" &&
    Array.isArray(this.retainedPublicationIds) &&
    this.retainedPublicationIds.length > 0
  ) {
    this.invalidate(
      "retainedPublicationIds",
      "An upgrade history entry cannot contain retained Job publications."
    );
  }

  if (this.requestedAt && this.effectiveAt && this.effectiveAt < this.requestedAt) {
    this.invalidate(
      "effectiveAt",
      "A subscription plan change cannot take effect before it was requested."
    );
  }

  if (this.appliedAt && this.effectiveAt && this.appliedAt < this.effectiveAt) {
    this.invalidate(
      "appliedAt",
      "A subscription plan change cannot be applied before its effective time."
    );
  }
});

const subscriptionSchema = new mongoose.Schema(
  {
    // --- IDENTITY / OWNERSHIP ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      immutable: true,
      maxlength: MAX_SUBSCRIPTION_REFERENCE_LENGTH,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },

    subscribedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // --- CURRENT PURCHASED TERMS ---

    planSnapshot: {
      type: planSnapshotSchema,
      required: true,
    },

    // --- LIFECYCLE ---

    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: "pending",
      required: true,
    },

    activatedAt: {
      type: Date,
      default: null,
    },

    currentPlanStartedAt: {
      type: Date,
      default: null,
    },

    currentPeriodStart: {
      type: Date,
      default: null,
    },

    currentPeriodEnd: {
      type: Date,
      default: null,
    },

    renewalCount: nonNegativeIntegerField({
      required: true,
      defaultValue: 0,
    }),

    // --- PLAN-CHANGE PURCHASE IN PROGRESS ---

    pendingPlanChange: {
      type: pendingPlanChangeSchema,
      default: null,
    },

    // --- APPLIED PLAN-CHANGE AUDIT ---

    planChangeHistory: {
      type: [planChangeHistoryEntrySchema],
      default: [],
    },

    // --- CANCELLATION / ENDING ---

    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
      required: true,
    },

    cancellationRequestedAt: {
      type: Date,
      default: null,
    },

    cancellationRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    endedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

subscriptionSchema.pre("validate", function validateSubscriptionLifecycle() {
  const hasCurrentPeriodStart = Boolean(this.currentPeriodStart);
  const hasCurrentPeriodEnd = Boolean(this.currentPeriodEnd);

  if (hasCurrentPeriodStart !== hasCurrentPeriodEnd) {
    this.invalidate(
      "currentPeriodEnd",
      "currentPeriodStart and currentPeriodEnd must either both be set or both be empty."
    );
  }

  if (
    this.currentPeriodStart &&
    this.currentPeriodEnd &&
    this.currentPeriodEnd <= this.currentPeriodStart
  ) {
    this.invalidate("currentPeriodEnd", "currentPeriodEnd must be later than currentPeriodStart.");
  }

  if (!this.isNew && this.isModified("plan") !== this.isModified("planSnapshot")) {
    this.invalidate("planSnapshot", "Subscription plan and planSnapshot must change together.");
  }

  const planChangeHistory = Array.isArray(this.planChangeHistory) ? this.planChangeHistory : [];

  for (let index = 0; index < planChangeHistory.length; index += 1) {
    const entry = planChangeHistory[index];
    const previousEntry = index > 0 ? planChangeHistory[index - 1] : null;

    if (previousEntry && String(entry.fromPlan) !== String(previousEntry.toPlan)) {
      this.invalidate(
        "planChangeHistory",
        "Subscription plan-change history must form a continuous plan chain."
      );

      break;
    }

    if (
      previousEntry &&
      entry.effectiveAt &&
      previousEntry.effectiveAt &&
      entry.effectiveAt < previousEntry.effectiveAt
    ) {
      this.invalidate(
        "planChangeHistory",
        "Subscription plan-change history must be chronological."
      );

      break;
    }

    if (
      previousEntry &&
      entry.appliedAt &&
      previousEntry.appliedAt &&
      entry.appliedAt < previousEntry.appliedAt
    ) {
      this.invalidate(
        "planChangeHistory",
        "Subscription plan-change application history must be chronological."
      );

      break;
    }
  }

  const latestPlanChange =
    planChangeHistory.length > 0 ? planChangeHistory[planChangeHistory.length - 1] : null;

  if (latestPlanChange && String(latestPlanChange.toPlan) !== String(this.plan)) {
    this.invalidate(
      "planChangeHistory",
      "The latest applied plan-change history entry must match the subscription's current plan."
    );
  }

  if (!this.isNew && this.isModified("plan")) {
    if (!this.isModified("planChangeHistory") || !latestPlanChange) {
      this.invalidate(
        "planChangeHistory",
        "Changing the current subscription plan requires an applied plan-change history entry."
      );
    }

    if (!this.isModified("currentPlanStartedAt")) {
      this.invalidate(
        "currentPlanStartedAt",
        "Changing the current subscription plan requires a new currentPlanStartedAt billing anchor."
      );
    }

    if (!this.isModified("currentPeriodStart") || !this.isModified("currentPeriodEnd")) {
      this.invalidate(
        "currentPeriodStart",
        "Changing the current subscription plan requires a fresh purchased billing period."
      );
    }

    if (!sameDate(this.currentPlanStartedAt, this.currentPeriodStart)) {
      this.invalidate(
        "currentPeriodStart",
        "A newly purchased plan must begin its billing period at currentPlanStartedAt."
      );
    }

    if (Number(this.renewalCount) !== 0) {
      this.invalidate(
        "renewalCount",
        "renewalCount must reset to zero when the current subscription plan changes."
      );
    }
  }

  if (Boolean(this.cancellationRequestedAt) !== Boolean(this.cancellationRequestedBy)) {
    this.invalidate(
      "cancellationRequestedBy",
      "cancellationRequestedAt and cancellationRequestedBy must either both be set or both be empty."
    );
  }

  if (this.cancelAtPeriodEnd && !this.cancellationRequestedAt) {
    this.invalidate(
      "cancellationRequestedAt",
      "A subscription scheduled to cancel at period end requires a cancellation request."
    );
  }

  if (!this.cancelAtPeriodEnd && this.status === "active" && this.cancellationRequestedAt) {
    this.invalidate(
      "cancelAtPeriodEnd",
      "An active subscription with a cancellation request must be scheduled to cancel at period end."
    );
  }

  if (this.pendingPlanChange && this.cancelAtPeriodEnd) {
    this.invalidate(
      "pendingPlanChange",
      "A subscription cannot have a plan-change purchase in progress and a period-end cancellation at the same time."
    );
  }

  if (this.cancelAtPeriodEnd && this.status !== "active") {
    this.invalidate(
      "cancelAtPeriodEnd",
      "Only an active subscription can await period-end cancellation."
    );
  }

  if (this.status === "pending") {
    if (this.renewalCount !== 0) {
      this.invalidate("renewalCount", "A pending subscription cannot have renewal history.");
    }
    if (planChangeHistory.length > 0) {
      this.invalidate(
        "planChangeHistory",
        "A pending subscription cannot have applied plan-change history."
      );
    }
    if (this.cancellationRequestedAt || this.cancellationRequestedBy) {
      this.invalidate(
        "cancellationRequestedAt",
        "A pending subscription cannot have a cancellation request."
      );
    }
    if (this.activatedAt) {
      this.invalidate("activatedAt", "A pending subscription cannot have activatedAt set.");
    }

    if (this.currentPlanStartedAt) {
      this.invalidate(
        "currentPlanStartedAt",
        "A pending subscription cannot have currentPlanStartedAt set."
      );
    }

    if (this.currentPeriodStart || this.currentPeriodEnd) {
      this.invalidate(
        "currentPeriodStart",
        "A pending subscription cannot have an active billing period."
      );
    }

    if (this.pendingPlanChange) {
      this.invalidate(
        "pendingPlanChange",
        "A pending subscription cannot have a plan-change purchase in progress."
      );
    }

    if (this.cancelledAt || this.endedAt) {
      this.invalidate("endedAt", "A pending subscription cannot already be ended.");
    }

    return;
  }

  if (!this.activatedAt) {
    this.invalidate("activatedAt", "A non-pending subscription requires activatedAt.");
  }

  if (!this.currentPlanStartedAt) {
    this.invalidate(
      "currentPlanStartedAt",
      "A non-pending subscription requires currentPlanStartedAt."
    );
  }

  if (!this.currentPeriodStart || !this.currentPeriodEnd) {
    this.invalidate(
      "currentPeriodStart",
      "A non-pending subscription requires a current billing period."
    );
  }

  if (
    this.activatedAt &&
    this.currentPlanStartedAt &&
    this.currentPlanStartedAt < this.activatedAt
  ) {
    this.invalidate(
      "currentPlanStartedAt",
      "The current plan cannot start before the Subscription was first activated."
    );
  }

  if (
    this.currentPlanStartedAt &&
    this.currentPeriodStart &&
    this.currentPeriodStart < this.currentPlanStartedAt
  ) {
    this.invalidate(
      "currentPeriodStart",
      "A subscription billing period cannot begin before the current plan started."
    );
  }

  if (!latestPlanChange) {
    if (
      this.activatedAt &&
      this.currentPlanStartedAt &&
      !sameDate(this.activatedAt, this.currentPlanStartedAt)
    ) {
      this.invalidate(
        "currentPlanStartedAt",
        "Before the first plan change, currentPlanStartedAt must equal activatedAt."
      );
    }
  } else if (
    this.currentPlanStartedAt &&
    latestPlanChange.effectiveAt &&
    !sameDate(this.currentPlanStartedAt, latestPlanChange.effectiveAt)
  ) {
    this.invalidate(
      "currentPlanStartedAt",
      "currentPlanStartedAt must match the effective time of the latest applied plan change."
    );
  }

  if (this.pendingPlanChange) {
    if (this.status !== "active") {
      this.invalidate(
        "pendingPlanChange",
        "Only an active subscription can have a plan-change purchase in progress."
      );
    }

    if (String(this.pendingPlanChange.targetPlan) === String(this.plan)) {
      this.invalidate(
        "pendingPlanChange.targetPlan",
        "A subscription plan change must target a different plan."
      );
    }

    const currentSnapshot = this.planSnapshot;
    const targetSnapshot = this.pendingPlanChange.targetPlanSnapshot;

    if (
      currentSnapshot &&
      targetSnapshot &&
      (currentSnapshot.countryCode !== targetSnapshot.countryCode ||
        currentSnapshot.currency !== targetSnapshot.currency)
    ) {
      this.invalidate(
        "pendingPlanChange.targetPlanSnapshot",
        "A subscription plan change must remain in the same country and currency."
      );
    }

    if (
      this.currentPeriodEnd &&
      this.pendingPlanChange.requestedAt &&
      this.pendingPlanChange.requestedAt >= this.currentPeriodEnd
    ) {
      this.invalidate(
        "pendingPlanChange.requestedAt",
        "A plan change must be requested before the current purchased period ends."
      );
    }

    if (
      this.currentPeriodStart &&
      this.pendingPlanChange.requestedAt &&
      this.pendingPlanChange.requestedAt < this.currentPeriodStart
    ) {
      this.invalidate(
        "pendingPlanChange.requestedAt",
        "A plan-change purchase request cannot predate the current purchased period."
      );
    }
  }

  if (this.status === "active") {
    if (this.cancelledAt || this.endedAt) {
      this.invalidate("endedAt", "An active subscription cannot already be ended.");
    }

    return;
  }

  if (this.pendingPlanChange) {
    this.invalidate(
      "pendingPlanChange",
      "An ended subscription cannot retain a plan-change purchase in progress."
    );
  }

  if (!this.endedAt) {
    this.invalidate("endedAt", "A cancelled or expired subscription requires endedAt.");
  }

  if (this.endedAt && this.currentPeriodEnd && !sameDate(this.endedAt, this.currentPeriodEnd)) {
    this.invalidate(
      "endedAt",
      "A cancelled or expired subscription must end exactly at currentPeriodEnd."
    );
  }

  if (this.status === "cancelled") {
    if (!this.cancellationRequestedAt || !this.cancellationRequestedBy) {
      this.invalidate(
        "cancellationRequestedAt",
        "A cancelled subscription must retain its original cancellation request."
      );
    }
    if (!this.cancelledAt) {
      this.invalidate("cancelledAt", "A cancelled subscription requires cancelledAt.");
    }

    if (
      this.cancelledAt &&
      this.currentPeriodEnd &&
      !sameDate(this.cancelledAt, this.currentPeriodEnd)
    ) {
      this.invalidate(
        "cancelledAt",
        "A cancelled subscription must be cancelled exactly at currentPeriodEnd."
      );
    }

    if (this.cancelledAt && this.endedAt && !sameDate(this.cancelledAt, this.endedAt)) {
      this.invalidate(
        "cancelledAt",
        "cancelledAt and endedAt must match for a cancelled subscription."
      );
    }
  }

  if (this.status === "expired" && this.cancelledAt) {
    this.invalidate("cancelledAt", "An expired subscription cannot contain cancelledAt.");
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

subscriptionSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

subscriptionSchema.index({
  business: 1,
  status: 1,
  currentPeriodEnd: 1,
});

subscriptionSchema.index({
  plan: 1,
  status: 1,
});

subscriptionSchema.index({
  "planSnapshot.code": 1,
  "planSnapshot.version": 1,
  status: 1,
});

subscriptionSchema.index({
  status: 1,
  "pendingPlanChange.requestedAt": 1,
});

subscriptionSchema.index(
  {
    "pendingPlanChange.paymentReference": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "pendingPlanChange.paymentReference": {
        $type: "string",
      },
    },
    name: "subscription_pending_plan_change_payment_reference_unique",
  }
);

// ID-ordered renewal/boundary sweeps; paid-date predicates remain query filters.
subscriptionSchema.index({ status: 1, _id: 1 }, { name: "subscription_lifecycle_sweep" });

module.exports = mongoose.model("Subscription", subscriptionSchema);
