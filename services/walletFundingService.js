// services/walletFundingService.js

const DVA = require("../models/DVA");

const WalletService = require("./walletService");
const NotificationService = require("./notificationService");

const money = require("../utils/money");

class WalletFundingService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Build funding idempotency key ---------- */
  static buildFundingIdempotencyKey({ provider, providerReference, providerEventId }) {
    const cleanProvider = WalletFundingService.cleanString(provider)?.toLowerCase();
    const cleanProviderReference = WalletFundingService.cleanString(providerReference);
    const cleanProviderEventId = WalletFundingService.cleanString(providerEventId);

    if (!cleanProvider) {
      throw new Error("Provider is required.");
    }

    if (cleanProviderEventId) {
      return `wallet_funding:${cleanProvider}:event:${cleanProviderEventId}`;
    }

    if (cleanProviderReference) {
      return `wallet_funding:${cleanProvider}:reference:${cleanProviderReference}`;
    }

    throw new Error("Provider reference or provider event ID is required.");
  }

  /* ---------- Get active employer DVA ---------- */
  static async getActiveEmployerDVA({ employerProfileId, dvaId }, options = {}) {
    if (!employerProfileId) {
      throw new Error("Employer profile ID is required.");
    }

    if (!dvaId) {
      throw new Error("DVA ID is required.");
    }

    const query = DVA.findOne({
      _id: dvaId,
      employer: employerProfileId,
    });

    if (options.session) {
      query.session(options.session);
    }

    const dva = await query;

    if (!dva) {
      throw new Error("Wallet bank account not found for this employer.");
    }

    if (dva.status !== "active") {
      throw new Error("Wallet bank account is not active yet.");
    }

    if (!dva.wallet) {
      throw new Error("Wallet bank account is not linked to a wallet.");
    }

    return dva;
  }

  /* ---------- Credit employer wallet from normalized DVA funding event ---------- */
  static async creditEmployerWalletFromDvaFunding(
    {
      employerProfileId,
      dvaId,

      amount,
      currency = "NGN",

      provider = "paystack",
      providerReference,
      providerEventId = null,

      providerFee = 0,
      netAmount = null,

      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const cleanProvider = WalletFundingService.cleanString(provider)?.toLowerCase();

      if (cleanProvider !== "paystack") {
        throw new Error("DVA wallet funding currently supports Paystack only.");
      }

      const cleanProviderReference = WalletFundingService.cleanString(providerReference);
      const cleanProviderEventId = WalletFundingService.cleanString(providerEventId);

      if (!cleanProviderReference) {
        throw new Error("Paystack reference is required for wallet funding.");
      }

      const normalizedAmount = money.normalizePositiveMinorUnitAmount(
        amount,
        "Wallet funding amount"
      );

      const normalizedProviderFee = money.normalizeMinorUnitAmount(
        providerFee || 0,
        "Provider fee"
      );

      const normalizedNetAmount =
        netAmount === null || netAmount === undefined
          ? normalizedAmount
          : money.normalizeMinorUnitAmount(netAmount, "Net amount");

      if (normalizedProviderFee > normalizedAmount) {
        throw new Error("Provider fee cannot be greater than funding amount.");
      }

      if (normalizedNetAmount > normalizedAmount) {
        throw new Error("Net amount cannot be greater than funding amount.");
      }

      const dva = await WalletFundingService.getActiveEmployerDVA(
        {
          employerProfileId,
          dvaId,
        },
        {
          session,
        }
      );

      const normalizedCurrency = String(currency || "NGN")
        .toUpperCase()
        .trim();

      if (String(dva.currency || "").toUpperCase() !== normalizedCurrency) {
        throw new Error("Funding currency does not match DVA currency.");
      }

      const idempotencyKey = WalletFundingService.buildFundingIdempotencyKey({
        provider: cleanProvider,
        providerReference: cleanProviderReference,
        providerEventId: cleanProviderEventId,
      });

      const fundingResult = await WalletService.creditWallet(
        {
          walletId: dva.wallet,

          amount: normalizedAmount,

          type: "wallet_funding",
          purpose: "wallet_topup",
          paymentRail: "paystack_dva",
          provider: "paystack",

          status: "completed",
          paystackStatus: "success",

          idempotencyKey,
          paystackReference: cleanProviderReference,
          providerEventId: cleanProviderEventId,

          dva: dva._id,

          providerFee: normalizedProviderFee,
          netAmount: normalizedNetAmount,

          initiatedBy: {
            role: "system",
            userId: null,
          },

          description: "Employer wallet top-up received by bank transfer.",

          metadata: {
            ...metadata,
            source: "dva_funding",
            provider: cleanProvider,
            providerReference: cleanProviderReference,
            providerEventId: cleanProviderEventId,
            employerProfileId: String(employerProfileId),
            dvaId: String(dva._id),
          },
        },
        {
          session,
        }
      );

      await NotificationService.notifyEmployerWalletFunded(
        {
          recipientUser: dva.ownerUser,
          employer: dva.employer,
          wallet: fundingResult.wallet,
          transaction: fundingResult.transaction,

          amount: fundingResult.transaction.amount,
          currency: fundingResult.transaction.currency,

          metadata: {
            source: "dva_funding",
            provider: cleanProvider,
            providerReference: cleanProviderReference,
            providerEventId: cleanProviderEventId,
            employerProfileId: String(employerProfileId),
            dvaId: String(dva._id),
            walletId: String(fundingResult.wallet._id),
            transactionId: String(fundingResult.transaction._id),
          },
        },
        {
          session,
        }
      );

      return fundingResult;
    });
  }
}

module.exports = WalletFundingService;
