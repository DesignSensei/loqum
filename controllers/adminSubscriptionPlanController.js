// controllers/adminSubscriptionPlanController.js

const AdminSubscriptionPlanService = require(
  "../services/adminSubscriptionPlanService"
);

const logger = require("../utils/logger");

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, private"
  );

  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function sendSuccess(res, data, statusCode = 200) {
  setNoStoreHeaders(res);

  return res.status(statusCode).json({
    success: true,
    data,
  });
}

function handleError(res, error, operation) {
  setNoStoreHeaders(res);

  if (error?.code === 11000) {
    return res.status(409).json({
      success: false,
      code: "ADMIN_SUBSCRIPTION_PLAN_CONFLICT",
      message:
        "A conflicting plan version or active plan already exists. Refresh and try again.",
    });
  }

  if (
    ["ValidationError", "CastError"].includes(error?.name)
  ) {
    return res.status(400).json({
      success: false,
      code: "ADMIN_SUBSCRIPTION_PLAN_VALIDATION_FAILED",
      message:
        "The subscription plan contains invalid commercial terms.",
    });
  }

  const operationalError = [
    "AdminSubscriptionPlanServiceError",
    "PlatformSettingsError",
  ].includes(error?.name);

  const candidateStatus = Number(error?.statusCode);

  const statusCode =
    operationalError &&
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 400 &&
    candidateStatus < 500
      ? candidateStatus
      : 500;

  if (statusCode >= 500) {
    logger.error(
      "Admin subscription plan " + operation + " failed:",
      error
    );
  } else {
    logger.warn(
      "Admin subscription plan " +
        operation +
        " rejected: " +
        error.code
    );
  }

  return res.status(statusCode).json({
    success: false,

    code:
      statusCode < 500
        ? error.code ||
          "ADMIN_SUBSCRIPTION_PLAN_REQUEST_INVALID"
        : "ADMIN_SUBSCRIPTION_PLAN_REQUEST_FAILED",

    message:
      statusCode < 500
        ? error.message
        : "The subscription plan request could not be completed.",
  });
}

/* ─────────────────────────────── PLAN READS ─────────────────────────────── */

exports.listPlans = async (req, res) => {
  try {
    const result =
      await AdminSubscriptionPlanService.listPlans({
        status: req.query?.status,
        countryCode: req.query?.countryCode,
        currency: req.query?.currency,
        billingCycle: req.query?.billingCycle,
        code: req.query?.code,
        page: req.query?.page ?? 1,
      });

    return sendSuccess(res, result);
  } catch (error) {
    return handleError(res, error, "list");
  }
};

exports.getPlan = async (req, res) => {
  try {
    const plan =
      await AdminSubscriptionPlanService.getPlan({
        planId: req.params.planId,
      });

    return sendSuccess(res, { plan });
  } catch (error) {
    return handleError(res, error, "read");
  }
};

/* ─────────────────────────────── PLAN COMMANDS ─────────────────────────────── */

exports.createDraft = async (req, res) => {
  try {
    const plan =
      await AdminSubscriptionPlanService.createDraft({
        input: req.body,

        adminId: req.user?._id,
      });

    return sendSuccess(res, { plan }, 201);
  } catch (error) {
    return handleError(res, error, "creation");
  }
};

exports.updateDraft = async (req, res) => {
  try {
    const plan =
      await AdminSubscriptionPlanService.updateDraft({
        planId: req.params.planId,

        expectedRevision:
          req.body?.expectedRevision,

        input: req.body,

        adminId: req.user?._id,
      });

    return sendSuccess(res, { plan });
  } catch (error) {
    return handleError(res, error, "update");
  }
};

exports.activatePlan = async (req, res) => {
  try {
    const plan =
      await AdminSubscriptionPlanService.activatePlan({
        planId: req.params.planId,

        expectedRevision:
          req.body?.expectedRevision,

        adminId: req.user?._id,
      });

    return sendSuccess(res, { plan });
  } catch (error) {
    return handleError(res, error, "activation");
  }
};

exports.retirePlan = async (req, res) => {
  try {
    const plan =
      await AdminSubscriptionPlanService.retirePlan({
        planId: req.params.planId,

        expectedRevision:
          req.body?.expectedRevision,

        adminId: req.user?._id,
      });

    return sendSuccess(res, { plan });
  } catch (error) {
    return handleError(res, error, "retirement");
  }
};

/* ─────────────────────────────── SUBSCRIPTION PLAN PAGE ─────────────────────────────── */

exports.getPlansPage = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const query = req.query || {};

    const filters = {
      status: query.status || "",
      countryCode: query.countryCode || "",
      currency: query.currency || "",
      billingCycle: query.billingCycle || "",
      code: query.code || "",
    };

    const result = await AdminSubscriptionPlanService.listPlans({
      ...filters,
      page: query.page ?? 1,
    });

    const buildPageUrl = (page) => {
      const params = new URLSearchParams();

      for (const [key, value] of Object.entries(filters)) {
        if (value && value !== "all") {
          params.set(key, value);
        }
      }

      params.set("page", String(page));

      return "/admin/subscription-plans?" + params.toString();
    };

    const statusClasses = {
      draft: "badge-light-secondary",
      active: "badge-light-success",
      retired: "badge-light-warning",
    };

    const plans = result.plans.map((plan) => ({
      ...plan,

      marketDisplay: plan.countryCode + " / " + plan.currency,

      priceDisplay: plan.priceMinor.toLocaleString("en-GB"),

      billingCycleDisplay:
        plan.billingCycle === "yearly" ? "Yearly" : "Monthly",

      feeDisplay:
        plan.benefits.basePlatformFeeRate == null
          ? "Standard fee"
          : (plan.benefits.basePlatformFeeRate * 100).toFixed(2) + "%",

      statusLabel:
        plan.status.charAt(0).toUpperCase() + plan.status.slice(1),

      statusBadgeClass:
        statusClasses[plan.status] || "badge-light-secondary",

      canEdit: plan.status === "draft",

      canActivate: plan.status === "draft",

      canRetire: plan.status === "active",

      updatedAtDisplay: plan.updatedAt
        ? new Date(plan.updatedAt).toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }) + " UTC"
        : "-",

      formData: JSON.stringify({
        id: plan.id,
        revision: plan.revision,
        code: plan.code,
        name: plan.name,
        description: plan.description || "",
        countryCode: plan.countryCode,
        currency: plan.currency,
        billingCycle: plan.billingCycle,
        priceMinor: plan.priceMinor,
        activeJobSlots: plan.benefits.activeJobSlots,
        basePlatformFeeRate: plan.benefits.basePlatformFeeRate,
        featureKeys: plan.benefits.featureKeys.join("\n"),
      }),
    }));

    const pagination = {
      ...result.pagination,

      previousUrl: result.pagination.hasPrevious
        ? buildPageUrl(result.pagination.page - 1)
        : null,

      nextUrl: result.pagination.hasNext
        ? buildPageUrl(result.pagination.page + 1)
        : null,
    };

    return res.render("admin/subscription-plans/index", {
      layout: "layouts/app-layout",

      title: "Subscription Plans",

      breadcrumbs: [
        { label: "Home", url: "/admin/dashboard" },
        { label: "Subscription Plans", url: null },
      ],

      csrfToken: req.csrfToken(),

      planView: {
        plans,
        filters,
        pagination,

        summary: {
          total: result.pagination.total,
          displayed: plans.length,
        },
      },

      scripts:
        '<script src="/js/admin/subscription-plans.js"></script>',
    });
  } catch (error) {
    return next(error);
  }
};
