// controllers/employerBillingController.js

const crypto = require("crypto");

const money = require("../utils/money");

const WalletWithdrawalService = require("../services/walletWithdrawalService");
const PaystackTransferService = require("../services/paystackTransferService");
const EmployerBillingService = require("../services/employerBillingService");
const logger = require("../utils/logger");

const EMPLOYER_BILLING_URL = "/employer/billing";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function cleanString(value) {
  const cleanValue = String(value || "").trim();

  return cleanValue || null;
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
    error.statusCode = 403;
    throw error;
  }
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

function sendBadRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
}

/* ─────────────────────────────── EMPLOYER BILLING / WALLET ─────────────────────────────── */

exports.getBilling = async (req, res, next) => {
  try {
    const billingView = await EmployerBillingService.getEmployerBillingPageData({
      userId: req.user._id,
      employerProfile: req.employerProfile,
      transactionsPage: req.query.transactionsPage,
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
        <script src="/js/employer/billing.js"></script>
      `,
    });
  } catch (error) {
    logger.error("Employer billing error:", error);

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
      redirectUrl: `${EMPLOYER_BILLING_URL}?saved=withdrawal-account#withdrawal-account`,
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
      redirectUrl: `${EMPLOYER_BILLING_URL}?removed=withdrawal-account#withdrawal-account`,
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
        redirectUrl: `${EMPLOYER_BILLING_URL}?failed=withdrawal#withdrawal-status`,
      });
    }

    return res.json({
      success: true,
      message: "Withdrawal request submitted successfully.",
      transactionId: String(transferResult.transaction._id),
      redirectUrl: `${EMPLOYER_BILLING_URL}?submitted=withdrawal#withdrawal-status`,
    });
  } catch (error) {
    logger.error("Employer withdrawal initiation error:", error);

    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message || "Unable to submit withdrawal request.",
    });
  }
};
