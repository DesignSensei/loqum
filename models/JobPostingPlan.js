// models/JobPostingPlan.js

const mongoose = require("mongoose");

const {
  requiredPositiveMinorUnitAmountField,
  requiredPositiveSafeIntegerField,
} = require("./helpers/schemaFields");

const {
  MAX_COMMERCIAL_PLAN_CODE_LENGTH,
  MAX_COMMERCIAL_PLAN_NAME_LENGTH,
  MAX_COMMERCIAL_PLAN_DESCRIPTION_LENGTH,
  MAX_COMMERCIAL_FEATURE_KEYS,
  MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
} = require("../constants/employerMonetization");

const { FIXED_JOB_PUBLICATION_PERIOD_DAYS } = require("../constants/jobPosting");

/**
 * JOB POSTING PLAN:
 *
 * Defines one PAYG permanent-Job publication product sold by Loqum.
 *
 * This is not a subscription and does not represent an employer's purchase.
 * JobPayment owns an employer's actual PAYG purchase and snapshots the product
 * terms granted at purchase time.
 *
 * PRODUCT AVAILABILITY:
 *
 * isActive means Loqum is currently selling this product. It does not mean an
 * employer has an active Job posting plan and must never be used as employer
 * subscription state.
 *
 * Each purchase authorizes one permanent-Job publication entitlement. The
 * resulting JobPublication remains the authoritative publication-cycle record.
 *
 * COMMERCIAL HISTORY:
 *
 * Once a plan version has been commercially used, administrative services
 * should retire/version it instead of rewriting historical commercial terms.
 * JobPayment must snapshot price, duration and features so later plan changes
 * cannot alter an already-purchased entitlement.
 *
 * PUBLICATION PERIOD:
 *
 * Permanent PAYG Job publications currently have a fixed 30-day publication
 * period. The field is still stored on the product so the purchased commercial
 * terms remain explicit and can be snapshotted by JobPayment.
 *
 * COUNTRY / CURRENCY:
 *
 * PAYG products are scoped to a country and currency. Monetary values are
 * stored in currency minor units.
 */

const jobPostingPlanSchema = new mongoose.Schema(
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
        "Job posting plan code must contain only uppercase letters, numbers, underscores or hyphens.",
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

    // --- PUBLICATION PRODUCT ---

    publicationPeriodDays: {
      type: Number,
      default: FIXED_JOB_PUBLICATION_PERIOD_DAYS,
      required: true,
      min: FIXED_JOB_PUBLICATION_PERIOD_DAYS,
      max: FIXED_JOB_PUBLICATION_PERIOD_DAYS,
      validate: {
        validator: (value) =>
          Number.isSafeInteger(value) && value === FIXED_JOB_PUBLICATION_PERIOD_DAYS,
        message: `publicationPeriodDays must be ${FIXED_JOB_PUBLICATION_PERIOD_DAYS}.`,
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

    // --- PRODUCT AVAILABILITY ---

    isActive: {
      type: Boolean,
      default: false,
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

jobPostingPlanSchema.pre("validate", function validateJobPostingPlanLifecycle() {
  if (this.isActive) {
    if (!this.activatedAt) {
      this.invalidate("activatedAt", "An active Job posting plan requires activatedAt.");
    }

    if (this.retiredAt) {
      this.invalidate("retiredAt", "An active Job posting plan cannot have retiredAt set.");
    }

    return;
  }

  if (!this.activatedAt && this.retiredAt) {
    this.invalidate("activatedAt", "A retired Job posting plan requires activatedAt.");
  }

  if (this.activatedAt && !this.retiredAt) {
    this.invalidate(
      "retiredAt",
      "An inactive Job posting plan that was previously activated requires retiredAt."
    );
  }

  if (this.activatedAt && this.retiredAt && this.retiredAt < this.activatedAt) {
    this.invalidate("retiredAt", "A Job posting plan cannot retire before it was activated.");
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

jobPostingPlanSchema.index(
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

/*
 * Only one version of the same PAYG product may be actively sold in a given
 * country/currency market at once.
 */
jobPostingPlanSchema.index(
  {
    code: 1,
    countryCode: 1,
    currency: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      isActive: true,
    },
  }
);

jobPostingPlanSchema.index({
  countryCode: 1,
  currency: 1,
  isActive: 1,
  name: 1,
});

module.exports = mongoose.model("JobPostingPlan", jobPostingPlanSchema);
