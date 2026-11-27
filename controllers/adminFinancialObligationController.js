// controllers/adminFinancialObligationController.js

const FinancialObligation = require("../models/FinancialObligation");
const RefundService = require("../services/financialObligationRefundService");
const PayoutService = require("../services/financialObligationPayoutService");

function summary(o) {
  const result = o.toObject ? o.toObject() : o;

  const {
    _id,
    type,
    status,
    employer,
    professional,
    amount,
    currency,
    providerMode,
    providerReference,
    reviewReason,
    refundExecution,
    payoutExecution,
    createdAt,
  } = result;

  return {
    _id,
    type,
    status,
    employer,
    professional,
    amount,
    currency,
    providerMode,
    providerReference,
    reviewReason,
    refundExecution,
    payoutExecution,
    createdAt,
  };
}

function adminId(req) {
  return req.user?._id || req.user?.id;
}

function handleError(res, error) {
  const code = Number(error.statusCode);
  const status = [400, 403, 404, 409, 422, 503].includes(code) ? code : 500;

  return res.status(status).json({
    success: false,
    message: status === 500 ? "Financial reconciliation request failed." : error.message,
  });
}

exports.list = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    await RefundService.assertAdmin(adminId(req));

    const filter = { status: { $in: ["open", "review_required"] } };

    if (req.query.status === "settled") filter.status = "settled";

    if (req.query.before) {
      if (typeof req.query.before !== "string" || !/^[a-f0-9]{24}$/i.test(req.query.before)) {
        return res.status(400).json({
          success: false,
          message: "Invalid cursor.",
        });
      }

      filter._id = { $lt: req.query.before };
    }

    const rows = await FinancialObligation.find(filter).sort({ _id: -1 }).limit(51).lean();

    return res.json({
      success: true,
      obligations: rows.slice(0, 50).map(summary),
      nextCursor: rows.length > 50 ? String(rows[49]._id) : null,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.refund = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    if (req.body?.confirmation !== "REFUND") {
      return res.status(400).json({
        success: false,
        message: "Refund confirmation required.",
      });
    }

    const obligation = await RefundService.authorizeAndRefund({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
      reason: req.body.reason,
    });

    return res.json({
      success: true,
      obligation: summary(obligation),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.reconcile = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const obligation = await RefundService.reconcile({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
    });

    return res.json({
      success: true,
      obligation: summary(obligation),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.payout = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    if (req.body?.confirmation !== "PAYOUT") {
      return res.status(400).json({
        success: false,
        message: "Payout confirmation required.",
      });
    }

    const obligation = await PayoutService.authorizeAndPay({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
      reason: req.body.reason,
    });

    return res.json({
      success: true,
      obligation: summary(obligation),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.reconcilePayout = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const obligation = await PayoutService.reconcile({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
    });

    return res.json({
      success: true,
      obligation: summary(obligation),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

exports.recoverRefund = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (req.body?.confirmation !== "RECOVER REFUND") {
      return res.status(400).json({ success: false, message: "Recovery confirmation required." });
    }
    const obligation = await RefundService.recoverExistingRefund({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
      refundId: req.body.refundId,
      reason: req.body.reason,
    });
    return res.json({ success: true, obligation: summary(obligation) });
  } catch (error) { return handleError(res, error); }
};

exports.retryPayout = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (req.body?.confirmation !== "RETRY PAYOUT") {
      return res.status(400).json({ success: false, message: "Retry confirmation required." });
    }
    const obligation = await PayoutService.authorizeAndPay({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
      reason: req.body.reason,
      retry: true,
    });
    return res.json({ success: true, obligation: summary(obligation) });
  } catch (error) { return handleError(res, error); }
};

exports.payoutOtp = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const obligation = await PayoutService.submitOtp({
      obligationId: req.params.obligationId,
      adminId: adminId(req),
      otp: req.body?.otp,
    });
    return res.json({ success: true, obligation: summary(obligation) });
  } catch (error) { return handleError(res, error); }
};

exports.getDashboardPage = async (req, res, next) => {
  res.set("Cache-Control", "no-store, private");

  try {
    const service = require("../services/adminFinancialObligationViewService");

    const page = await service.getListPage({
      adminId: req.user?._id,
      query: req.query,
    });

    return res.render("admin/financial-obligations/index", {
      ...page,
      layout: "layouts/app-layout",
      title: "Financial Obligations",
      breadcrumbs: [
        { label: "Home", url: "/admin/dashboard" },
        { label: "Financial Obligations", url: null },
      ],
      scripts: "",
      csrfToken: req.csrfToken(),
    });
  } catch (error) {
    return next(error);
  }
};

exports.getObligationPage = async (req, res, next) => {
  res.set("Cache-Control", "no-store, private");

  try {
    const service = require("../services/adminFinancialObligationViewService");

    const page = await service.getDetailPage({
      adminId: req.user?._id,
      obligationId: req.params.obligationId,
    });

    return res.render("admin/financial-obligations/show", {
      ...page,
      layout: "layouts/app-layout",
      title: "Financial Obligation Details",
      breadcrumbs: [
        { label: "Home", url: "/admin/dashboard" },
        { label: "Financial Obligations", url: "/admin/financial-obligations" },
        { label: "Details", url: null },
      ],
      scripts: '<script src="/js/admin/financial-obligations.js"></script>',
      csrfToken: req.csrfToken(),
    });
  } catch (error) {
    return next(error);
  }
};
