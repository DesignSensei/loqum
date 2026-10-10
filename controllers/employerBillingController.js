// controllers/employerBillingController.js

const crypto = require("crypto");
const money = require("../utils/money");

const WalletWithdrawalService = require("../services/walletWithdrawalService");
const PaystackTransferService = require("../services/paystackTransferService");
const EmployerBillingService = require("../services/employerBillingService");
const JobPublicationPaymentService = require("../services/jobPublicationPaymentService");
const SubscriptionService = require("../services/subscriptionService");
const SubscriptionPaymentService = require("../services/subscriptionPaymentService");

const logger = require("../utils/logger");

const EMPLOYER_BILLING_URL = "/employer/billing";

const PAYSTACK_JOB_PUBLICATION_CALLBACK_PATH = "/payments/paystack/job-publication-callback";

const PAYSTACK_SUBSCRIPTION_CALLBACK_PATH = "/payments/paystack/subscription-callback";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function billingError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), {
    name: "EmployerBillingControllerError",
    code,
    statusCode,
  });
}

function cleanString(value) {
  const cleanValue = String(value || "").trim();

  return cleanValue || null;
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function assertCanViewWallet(req) {
  if (!req.employerContext?.canViewWallet) {
    const error = new Error("You do not have permission to view this wallet.");

    error.name = "EmployerBillingControllerError";
    error.code = "WALLET_PERMISSION_DENIED";
    error.statusCode = 403;

    throw error;
  }
}

function getEmployerProfileFromRequest(req) {
  const employerProfile = req.employerProfile;

  if (!employerProfile?._id) {
    throw new Error("Employer profile not found.");
  }

  return employerProfile;
}

function assertCanManageWallet(req) {
  if (!req.employerContext?.canManageWallet) {
    const error = new Error("You do not have permission to manage this wallet.");

    error.name = "EmployerBillingControllerError";
    error.code = "WALLET_PERMISSION_DENIED";
    error.statusCode = 403;

    throw error;
  }
}

function getApplicationBaseUrl() {
  const configured = (process.env.APP_BASE_URL || process.env.BASE_URL || "").trim();
  try {
    const url = new URL(configured);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid application URL");
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    throw billingError(
      "A valid application base URL must be configured before starting Checkout.",
      "BILLING_CALLBACK_URL_NOT_CONFIGURED",
      500
    );
  }
}

function buildAbsoluteUrl(req, path) {
  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : `/${String(path || "")}`;

  return `${getApplicationBaseUrl(req)}${normalizedPath}`;
}

function getIdempotencyKey(req) {
  const header = req.get("Idempotency-Key");
  const body = req.body?.idempotencyKey;
  if ([header, body].some((value) => value != null && typeof value !== "string")) {
    throw billingError("The idempotency key must be a string.", "INVALID_BILLING_IDEMPOTENCY_KEY");
  }
  const headerKey = cleanString(header);
  const bodyKey = cleanString(body);
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw billingError(
      "The supplied idempotency keys must match.",
      "BILLING_IDEMPOTENCY_KEY_CONFLICT"
    );
  }
  return headerKey || bodyKey;
}

function subscriptionPaymentMessage(result) {
  if (result.paid !== true)
    return "Payment is unresolved. Check its status before starting another purchase.";
  if (result.applied === true) return "Payment completed and subscription updated.";
  if (
    !result.applicationError &&
    result.payment?.paymentKind === "renewal" &&
    result.application?.reason === "billing_period_not_started"
  ) {
    return "Renewal payment completed. It will take effect at the billing boundary.";
  }
  return "Payment completed, but the subscription update is pending. Do not pay again for this purchase.";
}

function normalizeWithdrawalAmountToMinorUnit(value) {
  const cleanValue = cleanString(value);

  if (!cleanValue) {
    throw new Error("Withdrawal amount is required.");
  }

  const normalizedValue = cleanValue.replace(/,/g, "");

  const amount = Number(normalizedValue);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a valid withdrawal amount.");
  }

  return money.toMinorUnit(amount);
}

function buildWithdrawalRequestReference(req) {
  return cleanString(req.body.requestReference) || `employer_withdrawal_${crypto.randomUUID()}`;
}

function sendBadRequest(res, message, extra = {}) {
  return res.status(400).json({
    success: false,
    message,
    ...extra,
  });
}

function isCommercialOperationalError(error) {
  return [
    "EmployerBillingControllerError",
    "JobPublicationPaymentServiceError",
    "SubscriptionServiceError",
    "SubscriptionPaymentServiceError",
    "WalletServiceError",
    "PaystackServiceError",
  ].includes(error?.name);
}

function handleCommercialJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operationalError = isCommercialOperationalError(error);

  const requestedStatusCode = Number(error?.statusCode);

  const statusCode = operationalError
    ? Number.isInteger(requestedStatusCode) &&
      requestedStatusCode >= 400 &&
      requestedStatusCode <= 599
      ? requestedStatusCode
      : 400
    : 500;

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ${error.code || "UNKNOWN"} - ${error.message}`);
  }

  const response = {
    success: false,
    message: operationalError ? error.message : fallbackMessage,
    code: operationalError ? error.code || fallbackCode : fallbackCode,
  };

  if (operationalError && error.details && typeof error.details === "object") {
    response.details = error.details;
  }

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

/* ─────────────────────────────── EMPLOYER BILLING / WALLET ─────────────────────────────── */

exports.getBilling = async (req, res, next) => {
  setNoStoreHeaders(res);
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    assertCanViewWallet(req);

    const billingView = await EmployerBillingService.getEmployerBillingPageData({
      userId: req.user._id,

      employerProfile,

      transactionsPage: req.query.transactionsPage,

      transactionFilter: req.query.transactionFilter,
    });

    return res.render("employer/billing/index", {
      layout: "layouts/app-layout",

      title: "Billing & Wallet",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Billing & Wallet",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      billingView,

      scripts: `
          \<script src="/js/employer/billing.js">\</script>
        `,
    });
  } catch (error) {
    logger.error("Employer billing error:", error);

    if (error.statusCode === 403) {
      return res.redirect("/employer/dashboard?notice=wallet-permission");
    }

    return next(error);
  }
};

exports.postSetupDVA = async (req, res) => {
  try {
    assertCanManageWallet(req);

    const result = await EmployerBillingService.requestEmployerDVASetup({
      userId: req.user._id,

      employerProfile: req.employerProfile,
    });

    return res.json({
      success: true,

      message: result.message,

      redirectUrl: EMPLOYER_BILLING_URL,
    });
  } catch (error) {
    logger.error("Employer DVA setup error:", error);

    return sendBadRequest(res, error.message || "Unable to set up wallet bank account.");
  }
};

exports.resolveWithdrawalAccount = async (req, res) => {
  try {
    assertCanManageWallet(req);

    const result = await EmployerBillingService.resolveWithdrawalAccount({
      paystackBankCode: req.body.paystackBankCode,

      accountNumber: req.body.accountNumber,
    });

    return res.json({
      success: true,

      accountName: result.accountName,

      accountNumber: result.accountNumber,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,

      message: error.message || "Unable to resolve bank account.",
    });
  }
};

exports.saveWithdrawalAccount = async (req, res) => {
  try {
    assertCanManageWallet(req);

    const result = await EmployerBillingService.saveEmployerWithdrawalAccount({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      bankName: req.body.bankName,

      accountNumber: req.body.accountNumber,

      accountName: req.body.accountName,

      paystackBankCode: req.body.paystackBankCode,

      replaceExisting: req.body.replaceExisting === "true",
    });

    return res.json({
      success: true,

      message: result.message || "Withdrawal bank account saved successfully.",

      redirectUrl: `${EMPLOYER_BILLING_URL}` + "?saved=withdrawal-account#withdrawal-account",
    });
  } catch (error) {
    logger.error("Employer withdrawal account save error:", error);

    return sendBadRequest(res, error.message || "Unable to save withdrawal bank account.");
  }
};

exports.removeWithdrawalAccount = async (req, res) => {
  try {
    assertCanManageWallet(req);

    const result = await EmployerBillingService.removeEmployerWithdrawalAccount({
      userId: req.user._id,

      employerProfile: req.employerProfile,
    });

    return res.json({
      success: true,

      message: result.message || "Withdrawal bank account removed successfully.",

      redirectUrl: `${EMPLOYER_BILLING_URL}` + "?removed=withdrawal-account#withdrawal-account",
    });
  } catch (error) {
    logger.error("Employer withdrawal account remove error:", error);

    return sendBadRequest(res, error.message || "Unable to remove withdrawal bank account.");
  }
};

exports.initiateWithdrawal = async (req, res) => {
  let withdrawalResult = null;

  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    assertCanManageWallet(req);

    const amount = normalizeWithdrawalAmountToMinorUnit(req.body.amount);

    const requestReference = buildWithdrawalRequestReference(req);

    withdrawalResult = await WalletWithdrawalService.createEmployerWithdrawalRequest({
      userId: req.user._id,

      employerProfileId: employerProfile._id,

      amount,

      requestReference,

      description: "Employer wallet withdrawal requested.",

      metadata: {
        source: "employer_billing_withdrawal",

        submittedFrom: "employer_billing_page",
      },
    });

    let transferResult = null;

    try {
      transferResult = await PaystackTransferService.initiateWithdrawalTransfer({
        withdrawalTransactionId: withdrawalResult.transaction._id,

        metadata: {
          source: "employer_billing_withdrawal_transfer",
        },
      });
    } catch (transferError) {
      logger.error("Employer withdrawal Paystack transfer submission failed:", transferError);

      await WalletWithdrawalService.reverseFailedWithdrawal({
        withdrawalTransactionId: withdrawalResult.transaction._id,

        reversalReason:
          transferError.message ||
          "Withdrawal could not be submitted to Paystack. Wallet balance reversed.",

        metadata: {
          source: "employer_billing_withdrawal_transfer_failure",

          transferSubmissionFailed: true,
        },
      });

      return res.status(400).json({
        success: false,

        message:
          transferError.message ||
          "Withdrawal could not be submitted. Your wallet balance has been reversed.",

        redirectUrl: `${EMPLOYER_BILLING_URL}` + "?failed=withdrawal#withdrawal-status",
      });
    }

    return res.json({
      success: true,

      message: "Withdrawal request submitted successfully.",

      transactionId: String(transferResult.transaction._id),

      redirectUrl: `${EMPLOYER_BILLING_URL}` + "?submitted=withdrawal#withdrawal-status",
    });
  } catch (error) {
    logger.error("Employer withdrawal initiation error:", error);

    return res.status(error.statusCode || 400).json({
      success: false,

      message: error.message || "Unable to submit withdrawal request.",
    });
  }
};

/* ─────────────────────────────── EMPLOYER MONETISATION READS ─────────────────────────────── */

exports.getJobPublicationPlans = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const plans = await JobPublicationPaymentService.listActivePlans({
      employerProfileId: employerProfile._id,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: {
        plans,
      },
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer PAYG Job publication plan request",

      fallbackMessage: "Unable to retrieve PAYG Job publication plans.",

      fallbackCode: "JOB_PUBLICATION_PLAN_RETRIEVAL_FAILED",
    });
  }
};

exports.getSubscriptionPlans = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const plans = await SubscriptionService.listActivePlans({
      countryCode: employerProfile.countryCode,

      currency: employerProfile.currency,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: {
        plans,
      },
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer subscription plan request",

      fallbackMessage: "Unable to retrieve subscription plans.",

      fallbackCode: "SUBSCRIPTION_PLAN_RETRIEVAL_FAILED",
    });
  }
};

exports.getActiveSubscription = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const benefits = await SubscriptionService.getActiveSubscriptionBenefits({
      employerProfileId: employerProfile._id,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: {
        active: Boolean(benefits),

        benefits,
      },
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer active subscription request",

      fallbackMessage: "Unable to retrieve the current subscription.",

      fallbackCode: "ACTIVE_SUBSCRIPTION_RETRIEVAL_FAILED",
    });
  }
};

/* ─────────────────────────────── PAYG JOB PUBLICATION PURCHASES ─────────────────────────────── */

exports.purchaseJobPublicationFromWallet = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    /*
     * Spending an existing employer wallet balance retains the
     * established wallet-management permission boundary.
     *
     * JobPublicationPaymentService independently enforces that the actor
     * is the primary employer or a business admin.
     */
    assertCanManageWallet(req);

    const result = await JobPublicationPaymentService.purchaseFromWallet({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      planId: req.body.planId,
      expectedPriceMinor: req.body.expectedPriceMinor ?? null,
      expectedCurrency: req.body.expectedCurrency ?? null,

      purchasedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,

      data: result,

      redirectUrl: `${EMPLOYER_BILLING_URL}` + "?purchased=job-publication#job-publications",
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer wallet PAYG Job publication purchase",

      fallbackMessage: "The Job publication purchase could not be completed from the wallet.",

      fallbackCode: "JOB_PUBLICATION_WALLET_PURCHASE_FAILED",
    });
  }
};

exports.initializeJobPublicationCheckout = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const callbackUrl = buildAbsoluteUrl(req, PAYSTACK_JOB_PUBLICATION_CALLBACK_PATH);

    const result = await JobPublicationPaymentService.initializePaystackCheckout({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      planId: req.body.planId,
      expectedPriceMinor: req.body.expectedPriceMinor ?? null,
      expectedCurrency: req.body.expectedCurrency ?? null,

      purchasedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      callbackUrl,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,

      billingUrl: EMPLOYER_BILLING_URL,
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer PAYG Job publication Paystack Checkout initialization",

      fallbackMessage:
        "Paystack Checkout could not be initialized for the Job publication purchase.",

      fallbackCode: "JOB_PUBLICATION_CHECKOUT_INITIALIZATION_FAILED",
    });
  }
};

exports.verifyJobPublicationPayment = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const data = await JobPublicationPaymentService.verifyEmployerPurchase({
      employerProfileId: employerProfile._id,
      employerContext: req.employerContext || null,
      paymentId: req.body?.paymentId,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,
      error,
      logContext: "Employer Job payment verification",
      fallbackMessage:
        "Payment verification is unavailable. Check again before making another payment.",
      fallbackCode: "JOB_PAYMENT_VERIFICATION_FAILED",
    });
  }
};

/* ─────────────────────────────── SUBSCRIPTION PAYMENTS ─────────────────────────────── */

/**
 * Initial subscription purchase from the employer wallet.
 *
 * Successful payment activates the new Subscription immediately.
 */
exports.purchaseInitialSubscriptionFromWallet = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    assertCanManageWallet(req);

    const result = await SubscriptionPaymentService.purchaseInitialFromWallet({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      planId: req.body.planId,

      initiatedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,

      data: result,

      message: subscriptionPaymentMessage(result),

      redirectUrl: `${EMPLOYER_BILLING_URL}` + "?subscription=payment-completed#subscription",
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer wallet initial subscription purchase",

      fallbackMessage: "The subscription purchase could not be completed from the wallet.",

      fallbackCode: "SUBSCRIPTION_WALLET_PURCHASE_FAILED",
    });
  }
};

/**
 * Initial subscription purchase through Paystack Checkout.
 */
exports.initializeInitialSubscriptionCheckout = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const callbackUrl = buildAbsoluteUrl(req, PAYSTACK_SUBSCRIPTION_CALLBACK_PATH);

    const result = await SubscriptionPaymentService.initializeInitialPaystackCheckout({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      planId: req.body.planId,

      initiatedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      callbackUrl,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,

      billingUrl: EMPLOYER_BILLING_URL,
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer initial subscription Paystack Checkout initialization",

      fallbackMessage: "Paystack Checkout could not be initialized for the subscription purchase.",

      fallbackCode: "SUBSCRIPTION_CHECKOUT_INITIALIZATION_FAILED",
    });
  }
};

/**
 * Immediate subscription plan change from the employer wallet.
 *
 * The target plan does not coexist with the current plan. After successful
 * payment the target plan replaces the current plan immediately and starts a
 * fresh purchased billing period. Any unused value/time on the previous plan
 * is forfeited.
 */
exports.purchaseSubscriptionPlanChangeFromWallet = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    assertCanManageWallet(req);

    const result = await SubscriptionPaymentService.purchasePlanChangeFromWallet({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      subscriptionId: req.params.subscriptionId,

      planId: req.body.planId,

      retainedPublicationIds: req.body.retainedPublicationIds || [],

      initiatedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,

      data: result,

      message: subscriptionPaymentMessage(result),

      redirectUrl:
        `${EMPLOYER_BILLING_URL}` + "?subscription=plan-change-payment-completed#subscription",
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer wallet subscription plan-change purchase",

      fallbackMessage: "The subscription plan change could not be completed from the wallet.",

      fallbackCode: "SUBSCRIPTION_PLAN_CHANGE_WALLET_PURCHASE_FAILED",
    });
  }
};

/**
 * Immediate subscription plan change through Paystack Checkout.
 *
 * The current plan remains the only effective plan while Checkout is unresolved.
 * The target plan becomes effective only after payment verification succeeds.
 */
exports.initializeSubscriptionPlanChangeCheckout = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const callbackUrl = buildAbsoluteUrl(req, PAYSTACK_SUBSCRIPTION_CALLBACK_PATH);

    const result = await SubscriptionPaymentService.initializePlanChangePaystackCheckout({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      subscriptionId: req.params.subscriptionId,

      planId: req.body.planId,

      retainedPublicationIds: req.body.retainedPublicationIds || [],

      initiatedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      callbackUrl,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,

      billingUrl: EMPLOYER_BILLING_URL,
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer subscription plan-change Paystack Checkout initialization",

      fallbackMessage:
        "Paystack Checkout could not be initialized for the subscription plan change.",

      fallbackCode: "SUBSCRIPTION_PLAN_CHANGE_CHECKOUT_INITIALIZATION_FAILED",
    });
  }
};

/**
 * Buy the next period of the one currently effective subscription plan from
 * the employer wallet.
 *
 * An early renewal payment may be paid before currentPeriodEnd, but it does not
 * create a second current plan and does not change current benefits early.
 */
exports.purchaseSubscriptionRenewalFromWallet = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    assertCanManageWallet(req);

    const result = await SubscriptionPaymentService.purchaseRenewalFromWallet({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      subscriptionId: req.params.subscriptionId,

      initiatedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,

      data: result,

      message: subscriptionPaymentMessage(result),

      redirectUrl:
        `${EMPLOYER_BILLING_URL}` + "?subscription=renewal-payment-completed#subscription",
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer wallet subscription renewal purchase",

      fallbackMessage: "The subscription renewal could not be completed from the wallet.",

      fallbackCode: "SUBSCRIPTION_RENEWAL_WALLET_PURCHASE_FAILED",
    });
  }
};

/**
 * Buy the next period of the one currently effective subscription plan through
 * Paystack Checkout.
 */
exports.initializeSubscriptionRenewalCheckout = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const callbackUrl = buildAbsoluteUrl(req, PAYSTACK_SUBSCRIPTION_CALLBACK_PATH);

    const result = await SubscriptionPaymentService.initializeRenewalPaystackCheckout({
      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      subscriptionId: req.params.subscriptionId,

      initiatedByUserId: req.user._id,

      idempotencyKey: getIdempotencyKey(req),

      callbackUrl,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,

      billingUrl: EMPLOYER_BILLING_URL,
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer subscription renewal Paystack Checkout initialization",

      fallbackMessage: "Paystack Checkout could not be initialized for the subscription renewal.",

      fallbackCode: "SUBSCRIPTION_RENEWAL_CHECKOUT_INITIALIZATION_FAILED",
    });
  }
};

/* ─────────────────────────────── SUBSCRIPTION MANAGEMENT ─────────────────────────────── */

exports.requestSubscriptionCancellation = async (req, res) => {
  try {
    const employerProfile = getEmployerProfileFromRequest(req);

    const result = await SubscriptionService.requestCancellation({
      subscriptionId: req.params.subscriptionId,

      employerProfileId: employerProfile._id,

      employerContext: req.employerContext || null,

      requestedByUserId: req.user._id,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: result,

      redirectUrl: `${EMPLOYER_BILLING_URL}` + "?subscription=cancellation-scheduled#subscription",
    });
  } catch (error) {
    return handleCommercialJsonError({
      res,

      error,

      logContext: "Employer subscription cancellation request",

      fallbackMessage: "The subscription cancellation request could not be completed.",

      fallbackCode: "SUBSCRIPTION_CANCELLATION_REQUEST_FAILED",
    });
  }
};
