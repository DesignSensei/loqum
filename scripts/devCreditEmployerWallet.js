// scripts/devCreditEmployerWallet.js

require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("../config/db");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");

const WalletService = require("../services/walletService");

const money = require("../utils/money");
const logger = require("../utils/logger");

function getArg(name) {
  const prefix = `--${name}=`;

  const arg = process.argv.find((item) => item.startsWith(prefix));

  return arg ? arg.slice(prefix.length).trim() : null;
}

function cleanString(value) {
  const cleanValue = String(value || "").trim();

  return cleanValue || null;
}

async function getEmployerProfile({ employerProfileId, email }) {
  if (employerProfileId) {
    const employerProfile = await EmployerProfile.findById(employerProfileId);

    if (!employerProfile) {
      throw new Error("Employer profile not found.");
    }

    return employerProfile;
  }

  if (email) {
    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    });

    if (!user) {
      throw new Error("User not found for this email.");
    }

    const employerProfile = await EmployerProfile.findOne({
      user: user._id,
    });

    if (!employerProfile) {
      throw new Error("Employer profile not found for this email.");
    }

    return employerProfile;
  }

  throw new Error("Pass --employerProfileId=<id> or --email=<email>.");
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("This script cannot run in production.");
  }

  const employerProfileId = cleanString(getArg("employerProfileId"));
  const email = cleanString(getArg("email"));
  const amountMajor = cleanString(getArg("amount"));
  const note = cleanString(getArg("note")) || "Development wallet credit.";

  if (!amountMajor) {
    throw new Error("Pass --amount=<amount>. Example: --amount=50000");
  }

  const amount = money.toMinorUnit(amountMajor);

  if (amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  await connectDB();

  const employerProfile = await getEmployerProfile({
    employerProfileId,
    email,
  });

  const wallet = await WalletService.createEmployerWalletIfMissing(employerProfile);

  const requestReference = `dev_credit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  logger.info("Employer wallet credit pre-check.", {
    employerProfileId: String(employerProfile._id),
    walletId: String(wallet._id),
    currentAvailableBalance: wallet.availableBalance,
    currentAvailableBalanceDisplay: money.formatMoney(wallet.availableBalance, wallet.currency),
    maximumBalance: wallet.maximumBalance,
    maximumBalanceDisplay:
      wallet.maximumBalance === null || wallet.maximumBalance === undefined
        ? "No limit"
        : money.formatMoney(wallet.maximumBalance, wallet.currency),
    creditAmount: amount,
    creditAmountDisplay: money.formatMoney(amount, wallet.currency),
  });

  const result = await WalletService.creditWallet({
    walletId: wallet._id,

    amount,

    type: "adjustment",
    purpose: "admin_adjustment",
    paymentRail: "admin_action",
    provider: "manual",

    status: "completed",

    idempotencyKey: `dev_wallet_credit:${employerProfile._id}:${requestReference}`,

    initiatedBy: {
      role: "admin",
      userId: null,
    },

    description: note,

    metadata: {
      source: "dev_credit_employer_wallet_script",
      requestReference,
      warning: "Development-only ledger credit. This is not Paystack-funded money.",
      amountMajor,
    },
  });

  const logPayload = {
    employerProfileId: String(employerProfile._id),
    walletId: String(result.wallet._id),
    transactionId: String(result.transaction._id),
    transactionReference: result.transaction.reference,
    amountMinor: amount,
    amountDisplay: money.formatMoney(amount, result.wallet.currency),
    newAvailableBalance: result.wallet.availableBalance,
    newAvailableBalanceDisplay: money.formatMoney(
      result.wallet.availableBalance,
      result.wallet.currency
    ),
  };

  logger.info("Development wallet credit completed.", logPayload);

  return logPayload;
}

main()
  .catch((error) => {
    logger.error("Development wallet credit failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
