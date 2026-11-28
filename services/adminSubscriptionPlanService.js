// services/adminSubscriptionPlanService.js

const SubscriptionPlan = require("../models/SubscriptionPlan");
const PlatformSettingsService = require("./platformSettingsService");

const {
  SUBSCRIPTION_PLAN_STATUSES,
  SUBSCRIPTION_BILLING_CYCLES,
  MAX_COMMERCIAL_PLAN_CODE_LENGTH,
  MAX_COMMERCIAL_PLAN_NAME_LENGTH,
  MAX_COMMERCIAL_PLAN_DESCRIPTION_LENGTH,
  MAX_COMMERCIAL_FEATURE_KEYS,
  MAX_COMMERCIAL_FEATURE_KEY_LENGTH,
} = require("../constants/employerMonetization");

const ERROR_NAME = "AdminSubscriptionPlanServiceError";

const PAGE_SIZE = 30;
const MAX_PAGE = 1000;

class AdminSubscriptionPlanService {
  /* ─────────────────────────────── VALIDATION ─────────────────────────────── */

  static createError({
    message,
    code,
    statusCode = 400,
  }) {
    const error = new Error(message);

    error.name = ERROR_NAME;
    error.code = code;
    error.statusCode = statusCode;

    return error;
  }

  static invalidField(fieldName) {
    return this.createError({
      message: "Invalid subscription plan field: " + fieldName + ".",
      code: "ADMIN_SUBSCRIPTION_PLAN_INVALID_FIELD",
    });
  }

  static normalizeObjectId(value, fieldName) {
    const normalized = String(value || "").trim();

    if (!/^[a-fA-F0-9]{24}$/.test(normalized)) {
      throw this.invalidField(fieldName);
    }

    return normalized;
  }

  static normalizeString(
    value,
    fieldName,
    maximum,
    optional = false
  ) {
    if (
      optional &&
      (value === null ||
        value === undefined ||
        value === "")
    ) {
      return null;
    }

    if (typeof value !== "string") {
      throw this.invalidField(fieldName);
    }

    const normalized = value.trim();

    if (!normalized && optional) {
      return null;
    }

    if (
      !normalized ||
      normalized.length > maximum
    ) {
      throw this.invalidField(fieldName);
    }

    return normalized;
  }

  static normalizeInteger(value, fieldName, minimum = 0) {
    if (
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      throw this.invalidField(fieldName);
    }

    if (
      typeof value === "string" &&
      !/^\d+$/.test(value.trim())
    ) {
      throw this.invalidField(fieldName);
    }

    const normalized = Number(value);

    if (
      !Number.isSafeInteger(normalized) ||
      normalized < minimum
    ) {
      throw this.invalidField(fieldName);
    }

    return normalized;
  }

  static normalizeCode(value) {
    const code = this.normalizeString(
      value,
      "code",
      MAX_COMMERCIAL_PLAN_CODE_LENGTH
    ).toUpperCase();

    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
      throw this.invalidField("code");
    }

    return code;
  }

  static normalizeCountryCode(value) {
    const countryCode = this.normalizeString(
      value,
      "countryCode",
      2
    ).toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw this.invalidField("countryCode");
    }

    return countryCode;
  }

  static normalizeCurrency(value) {
    const currency = this.normalizeString(
      value,
      "currency",
      3
    ).toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw this.invalidField("currency");
    }

    return currency;
  }

  static normalizeBillingCycle(value) {
    if (!SUBSCRIPTION_BILLING_CYCLES.includes(value)) {
      throw this.invalidField("billingCycle");
    }

    return value;
  }

  static normalizeOptionalRate(value) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return null;
    }

    if (
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      throw this.invalidField("basePlatformFeeRate");
    }

    if (
      typeof value === "string" &&
      !/^\d+(?:\.\d+)?$/.test(value.trim())
    ) {
      throw this.invalidField("basePlatformFeeRate");
    }

    const rate = Number(value);

    return PlatformSettingsService.assertRate(
      rate,
      "basePlatformFeeRate"
    );
  }

  static normalizeFeatureKeys(values) {
    if (
      values === undefined ||
      values === null
    ) {
      return [];
    }

    if (
      !Array.isArray(values) ||
      values.length > MAX_COMMERCIAL_FEATURE_KEYS
    ) {
      throw this.invalidField("featureKeys");
    }

    const normalized = values.map((value) => {
      const key = this.normalizeString(
        value,
        "featureKeys",
        MAX_COMMERCIAL_FEATURE_KEY_LENGTH
      ).toLowerCase();

      if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
        throw this.invalidField("featureKeys");
      }

      return key;
    });

    if (
      new Set(normalized).size !== normalized.length
    ) {
      throw this.invalidField("featureKeys");
    }

    return normalized;
  }

  static normalizeCommercialTerms(input = {}) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      throw this.invalidField("plan");
    }

    return {
      name: this.normalizeString(
        input.name,
        "name",
        MAX_COMMERCIAL_PLAN_NAME_LENGTH
      ),

      description: this.normalizeString(
        input.description,
        "description",
        MAX_COMMERCIAL_PLAN_DESCRIPTION_LENGTH,
        true
      ),

      billingCycle: this.normalizeBillingCycle(
        input.billingCycle
      ),

      priceMinor: this.normalizeInteger(
        input.priceMinor,
        "priceMinor",
        1
      ),

      benefits: {
        activeJobSlots: this.normalizeInteger(
          input.activeJobSlots,
          "activeJobSlots",
          0
        ),

        basePlatformFeeRate:
          this.normalizeOptionalRate(
            input.basePlatformFeeRate
          ),

        featureKeys: this.normalizeFeatureKeys(
          input.featureKeys
        ),
      },
    };
  }

  static async assertMarket({
    countryCode,
    currency,
    basePlatformFeeRate,
  }) {
    const settings =
      await PlatformSettingsService.getCountrySettings(
        countryCode
      );

    if (settings.currency !== currency) {
      throw this.createError({
        message:
          "The plan currency does not match the configured country currency.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_MARKET_MISMATCH",
      });
    }

    if (
      basePlatformFeeRate !== null &&
      basePlatformFeeRate >
        settings.platformFeeRate
    ) {
      throw this.createError({
        message:
          "The subscriber BASE platform fee cannot exceed the current standard platform fee.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_FEE_INVALID",
      });
    }

    return settings;
  }

  /* ─────────────────────────────── SAFE PLAN PROJECTION ─────────────────────────────── */

  static buildPlanView(plan) {
    return {
      id: String(plan._id),

      code: plan.code,

      version: plan.version,

      revision: Number(plan.__v || 0),

      name: plan.name,

      description: plan.description || null,

      countryCode: plan.countryCode,

      currency: plan.currency,

      priceMinor: plan.priceMinor,

      billingCycle: plan.billingCycle,

      benefits: {
        activeJobSlots:
          plan.benefits?.activeJobSlots || 0,

        basePlatformFeeRate:
          plan.benefits?.basePlatformFeeRate ?? null,

        featureKeys: Array.isArray(
          plan.benefits?.featureKeys
        )
          ? [...plan.benefits.featureKeys]
          : [],
      },

      status: plan.status,

      activatedAt: plan.activatedAt || null,

      retiredAt: plan.retiredAt || null,

      createdBy: plan.createdBy
        ? String(plan.createdBy)
        : null,

      updatedBy: plan.updatedBy
        ? String(plan.updatedBy)
        : null,

      createdAt: plan.createdAt || null,

      updatedAt: plan.updatedAt || null,
    };
  }

  /* ─────────────────────────────── PLAN READS ─────────────────────────────── */

  static async getPlanDocument(planId) {
    const id = this.normalizeObjectId(
      planId,
      "planId"
    );

    const plan = await SubscriptionPlan.findById(id);

    if (!plan) {
      throw this.createError({
        message: "Subscription plan not found.",
        code: "ADMIN_SUBSCRIPTION_PLAN_NOT_FOUND",
        statusCode: 404,
      });
    }

    return plan;
  }

  static async getPlan({ planId }) {
    const plan = await this.getPlanDocument(planId);

    return this.buildPlanView(plan);
  }

  static async listPlans({
    status = null,
    countryCode = null,
    currency = null,
    billingCycle = null,
    code = null,
    page = 1,
  } = {}) {
    const filter = {};

    if (status && status !== "all") {
      if (
        !SUBSCRIPTION_PLAN_STATUSES.includes(status)
      ) {
        throw this.invalidField("status");
      }

      filter.status = status;
    }

    if (countryCode) {
      filter.countryCode =
        this.normalizeCountryCode(countryCode);
    }

    if (currency) {
      filter.currency =
        this.normalizeCurrency(currency);
    }

    if (billingCycle) {
      filter.billingCycle =
        this.normalizeBillingCycle(billingCycle);
    }

    if (code) {
      filter.code = this.normalizeCode(code);
    }

    const currentPage = this.normalizeInteger(
      page,
      "page",
      1
    );

    if (currentPage > MAX_PAGE) {
      throw this.invalidField("page");
    }

    const [plans, total] = await Promise.all([
      SubscriptionPlan.find(filter)
        .sort({
          countryCode: 1,
          code: 1,
          version: -1,
          _id: -1,
        })
        .skip((currentPage - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),

      SubscriptionPlan.countDocuments(filter),
    ]);

    return {
      plans: plans.map((plan) =>
        this.buildPlanView(plan)
      ),

      pagination: {
        page: currentPage,
        pageSize: PAGE_SIZE,
        total,
        totalPages: Math.ceil(total / PAGE_SIZE),
        hasPrevious: currentPage > 1,
        hasNext: currentPage * PAGE_SIZE < total,
      },
    };
  }

  /* ─────────────────────────────── DRAFT CREATION AND VERSIONING ─────────────────────────────── */

  static async createDraft({
    input,
    adminId,
  }) {
    const normalizedAdminId = this.normalizeObjectId(
      adminId,
      "adminId"
    );

    const code = this.normalizeCode(input?.code);

    const countryCode = this.normalizeCountryCode(
      input?.countryCode
    );

    const currency = this.normalizeCurrency(
      input?.currency
    );

    const terms = this.normalizeCommercialTerms(input);

    await this.assertMarket({
      countryCode,
      currency,
      basePlatformFeeRate:
        terms.benefits.basePlatformFeeRate,
    });

    // The plan code and market identify the commercial
    // product family. A new draft receives the next version.
    const previous = await SubscriptionPlan.findOne({
      code,
      countryCode,
      currency,
    })
      .sort({ version: -1 })
      .select("version")
      .lean();

    const version = Number(previous?.version || 0) + 1;

    if (!Number.isSafeInteger(version)) {
      throw this.createError({
        message: "The plan version limit has been reached.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_VERSION_LIMIT",
        statusCode: 409,
      });
    }

    // The unique commercial identity index rejects concurrent
    // attempts to create the same version.
    const plan = await SubscriptionPlan.create({
      code,
      version,
      countryCode,
      currency,

      ...terms,

      status: "draft",

      activatedAt: null,
      retiredAt: null,

      createdBy: normalizedAdminId,
      updatedBy: normalizedAdminId,
    });

    return this.buildPlanView(plan);
  }

  /* ─────────────────────────────── CONCURRENT UPDATE PROTECTION ─────────────────────────────── */

  static assertRevision(plan, expectedRevision) {
    const revision = this.normalizeInteger(
      expectedRevision,
      "expectedRevision",
      0
    );

    if (revision !== Number(plan.__v || 0)) {
      throw this.createError({
        message:
          "This plan changed after it was loaded. Refresh and try again.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_REVISION_CONFLICT",
        statusCode: 409,
      });
    }

    return revision;
  }

  static async commitPlanUpdate({
    plan,
    previousStatus,
    expectedRevision,
    changes,
    adminId,
  }) {
    const revision = this.assertRevision(
      plan,
      expectedRevision
    );

    const normalizedAdminId = this.normalizeObjectId(
      adminId,
      "adminId"
    );

    const fields = {
      ...changes,
      updatedBy: normalizedAdminId,
    };

    // Run complete document validation, including lifecycle
    // validation, before performing the conditional update.
    plan.set(fields);

    await plan.validate();

    const updated = await SubscriptionPlan.findOneAndUpdate(
      {
        _id: plan._id,
        status: previousStatus,
        __v: revision,
      },
      {
        $set: fields,
        $inc: { __v: 1 },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updated) {
      throw this.createError({
        message:
          "This plan was modified by another administrator. Refresh and try again.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_REVISION_CONFLICT",
        statusCode: 409,
      });
    }

    return this.buildPlanView(updated);
  }

  /* ─────────────────────────────── DRAFT EDITING ─────────────────────────────── */

  static async updateDraft({
    planId,
    expectedRevision,
    input,
    adminId,
  }) {
    const plan = await this.getPlanDocument(planId);

    this.assertRevision(plan, expectedRevision);

    if (plan.status !== "draft") {
      throw this.createError({
        message:
          "Only draft plans can be edited. Create a new version instead.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_NOT_EDITABLE",
        statusCode: 409,
      });
    }

    const terms = this.normalizeCommercialTerms(input);

    await this.assertMarket({
      countryCode: plan.countryCode,
      currency: plan.currency,
      basePlatformFeeRate:
        terms.benefits.basePlatformFeeRate,
    });

    // Commercial identity and market remain fixed.
    return this.commitPlanUpdate({
      plan,
      previousStatus: "draft",
      expectedRevision,
      changes: terms,
      adminId,
    });
  }

  /* ─────────────────────────────── PLAN ACTIVATION ─────────────────────────────── */

  static async activatePlan({
    planId,
    expectedRevision,
    adminId,
  }) {
    const plan = await this.getPlanDocument(planId);

    this.assertRevision(plan, expectedRevision);

    if (plan.status !== "draft") {
      throw this.createError({
        message:
          "Only a draft subscription plan can be activated.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_ACTIVATION_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    await this.assertMarket({
      countryCode: plan.countryCode,
      currency: plan.currency,
      basePlatformFeeRate:
        plan.benefits?.basePlatformFeeRate ?? null,
    });

    const existingActive =
      await SubscriptionPlan.findOne({
        code: plan.code,
        countryCode: plan.countryCode,
        currency: plan.currency,
        status: "active",
      })
        .select("_id version")
        .lean();

    if (existingActive) {
      throw this.createError({
        message:
          "Retire the currently active version before activating this version.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_ACTIVE_VERSION_EXISTS",
        statusCode: 409,
      });
    }

    // The existing partial unique index remains the final
    // safeguard against simultaneous active versions.
    return this.commitPlanUpdate({
      plan,
      previousStatus: "draft",
      expectedRevision,
      changes: {
        status: "active",
        activatedAt: new Date(),
        retiredAt: null,
      },
      adminId,
    });
  }

  /* ─────────────────────────────── PLAN RETIREMENT ─────────────────────────────── */

  static async retirePlan({
    planId,
    expectedRevision,
    adminId,
  }) {
    const plan = await this.getPlanDocument(planId);

    this.assertRevision(plan, expectedRevision);

    if (plan.status !== "active") {
      throw this.createError({
        message:
          "Only an active subscription plan can be retired.",
        code:
          "ADMIN_SUBSCRIPTION_PLAN_RETIREMENT_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    // Retirement affects product availability only.
    // Purchased subscriptions and payment snapshots are untouched.
    return this.commitPlanUpdate({
      plan,
      previousStatus: "active",
      expectedRevision,
      changes: {
        status: "retired",
        retiredAt: new Date(),
      },
      adminId,
    });
  }
}

module.exports = AdminSubscriptionPlanService;
