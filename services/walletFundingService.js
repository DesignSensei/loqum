// services/walletFundingService.js

const mongoose = require("mongoose");

const DVA = require("../models/DVA");
const Wallet = require("../models/Wallet");
const FinancialObligation = require("../models/FinancialObligation");

const WalletService = require("./walletService");
const NotificationService = require("./notificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const money = require("../utils/money");

const SUPPORTED_DVA_FUNDING_PROVIDER = "paystack";

class WalletFundingService {
  /* ---------- ERRORS / NORMALIZATION ---------- */

  static createFundingError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: "WalletFundingServiceError",
      message,
      code,
      statusCode,
      details,
    });

    if (cause) {
      error.cause = cause;
    }

    return error;
  }

  static cleanString(value) {
    return String(value ?? "").trim() || null;
  }

  static normalizeObjectId(value, fieldName) {
    if (!value || !mongoose.isValidObjectId(value)) {
      throw WalletFundingService.createFundingError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeProvider(value) {
    const provider = WalletFundingService.cleanString(value)?.toLowerCase();

    if (provider !== SUPPORTED_DVA_FUNDING_PROVIDER) {
      throw WalletFundingService.createFundingError({
        message: "DVA wallet funding currently supports Paystack only.",
        code: "UNSUPPORTED_DVA_FUNDING_PROVIDER",
        statusCode: 409,
        details: {
          provider: provider || null,
          supportedProvider: SUPPORTED_DVA_FUNDING_PROVIDER,
        },
      });
    }

    return provider;
  }

  static normalizeCurrency(value, fieldName = "currency") {
    const currency = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw WalletFundingService.createFundingError({
        message: `The ${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return currency;
  }

  static normalizePositiveAmount(value, fieldName) {
    try {
      return money.normalizePositiveMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw WalletFundingService.createFundingError({
        message: `${fieldName} must be a positive whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        cause: error,
      });
    }
  }

  static normalizeNonNegativeAmount(value, fieldName) {
    try {
      return money.normalizeMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw WalletFundingService.createFundingError({
        message: `${fieldName} must be a non-negative whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        cause: error,
      });
    }
  }

  static normalizeMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return value;
  }

  /* ---------- IDEMPOTENCY ---------- */

  static buildFundingIdempotencyKey({ provider, providerReference }) {
    const normalizedProvider = WalletFundingService.normalizeProvider(provider);

    const normalizedProviderReference = WalletFundingService.cleanString(providerReference);

    if (!normalizedProviderReference) {
      throw WalletFundingService.createFundingError({
        message: "Paystack reference is required for wallet funding.",
        code: "PAYSTACK_WALLET_FUNDING_REFERENCE_REQUIRED",
      });
    }

    // The payment reference identifies the actual money movement.

    return `wallet_funding:${normalizedProvider}:reference:${normalizedProviderReference}`;
  }

  /* ---------- DVA FINANCIAL LOCK ---------- */

  static async lockDVAFundingDisposition({ dvaId, employerProfileId }, session) {
    if (!session?.inTransaction?.()) {
      throw new Error("DVA financial reconciliation requires an active transaction.");
    }

    const normalizedDvaId = WalletFundingService.normalizeObjectId(dvaId, "DVA ID");

    const normalizedEmployerProfileId = WalletFundingService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const versionKey = DVA.schema.options.versionKey;

    if (typeof versionKey !== "string" || !DVA.schema.path(versionKey)) {
      throw new Error("DVA financial locking requires an enabled document version key.");
    }

    // Force a transactional write against the historical DVA.

    const result = await DVA.updateOne(
      {
        _id: normalizedDvaId,
        employer: normalizedEmployerProfileId,
        provider: SUPPORTED_DVA_FUNDING_PROVIDER,
      },
      {
        $inc: {
          [versionKey]: 1,
        },
      },
      {
        session,
        timestamps: false,
      }
    );

    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw WalletFundingService.createFundingError({
        message: "The original DVA could not be locked for financial reconciliation.",
        code: "DVA_FINANCIAL_LOCK_FAILED",
        statusCode: 409,
        details: {
          dvaId: String(normalizedDvaId),
          employerProfileId: String(normalizedEmployerProfileId),
        },
      });
    }

    return true;
  }

  /* ---------- DVA / WALLET RESOLUTION ---------- */

  static async getEmployerDVAForFunding({ employerProfileId, dvaId }, options = {}) {
    const normalizedEmployerProfileId = WalletFundingService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedDvaId = WalletFundingService.normalizeObjectId(dvaId, "DVA ID");

    const query = DVA.findOne({
      _id: normalizedDvaId,
      employer: normalizedEmployerProfileId,
      provider: SUPPORTED_DVA_FUNDING_PROVIDER,
    }).select(
      [
        "ownerUser",
        "employer",
        "wallet",
        "provider",
        "status",
        "countryCode",
        "currency",
        "accountNumber",
        "accountName",
        "bankName",
        "retirementStartedAt",
        "retirementResolution",
        "retirementConfirmedAt",
        "deactivatedAt",
      ].join(" ")
    );

    if (options.session) {
      query.session(options.session);
    }

    const dva = await query;

    if (!dva) {
      throw WalletFundingService.createFundingError({
        message: "Dedicated virtual account was not found for this employer.",
        code: "EMPLOYER_DVA_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!dva.ownerUser) {
      throw WalletFundingService.createFundingError({
        message: "The dedicated virtual account has no owner user.",
        code: "EMPLOYER_DVA_OWNER_USER_REQUIRED",
        statusCode: 500,
      });
    }

    if (!dva.wallet) {
      throw WalletFundingService.createFundingError({
        message: "The dedicated virtual account has no linked wallet.",
        code: "EMPLOYER_DVA_WALLET_REQUIRED",
        statusCode: 500,
      });
    }

    return dva;
  }

  static async getLinkedEmployerWallet({ dva, employerProfileId, session }) {
    const query = Wallet.findById(dva.wallet);

    if (session) {
      query.session(session);
    }

    const wallet = await query;

    if (!wallet) {
      throw WalletFundingService.createFundingError({
        message: "The wallet linked to the DVA was not found.",
        code: "DVA_EMPLOYER_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    const walletMatchesDva =
      wallet.ownerType === "employer" &&
      !wallet.professional &&
      String(wallet.employer) === String(employerProfileId) &&
      String(wallet.employer) === String(dva.employer) &&
      String(wallet._id) === String(dva.wallet) &&
      wallet.countryCode === dva.countryCode &&
      wallet.currency === dva.currency;

    if (!walletMatchesDva) {
      throw WalletFundingService.createFundingError({
        message: "The DVA does not match its original employer wallet.",
        code: "DVA_EMPLOYER_WALLET_MISMATCH",
        statusCode: 409,
        details: {
          dvaId: String(dva._id),
          dvaWalletId: String(dva.wallet),
          resolvedWalletId: String(wallet._id),
          employerProfileId: String(employerProfileId),
        },
      });
    }

    return wallet;
  }

  /* ---------- NEW FUNDING ELIGIBILITY ---------- */

  static assertDvaAcceptsNewFunding({ dva, wallet, providerReference }) {
    if (["retiring", "deactivated"].includes(dva.status) || dva.retirementStartedAt) {
      const error = WalletFundingService.createFundingError({
        message: "Payment requires historical DVA funding reconciliation.",
        code: "DVA_RETIRED_FUNDING_RECONCILIATION_REQUIRED",
        statusCode: 409,
        details: {
          dvaId: String(dva._id),
          employerProfileId: String(dva.employer),
          walletId: String(wallet._id),
          dvaStatus: dva.status,
          walletStatus: wallet.status,
          providerReference,
        },
      });

      error.retryable = true;

      throw error;
    }

    if (dva.status !== "active") {
      throw WalletFundingService.createFundingError({
        message: "Dedicated virtual account is not active.",
        code: "EMPLOYER_DVA_NOT_ACTIVE",
        statusCode: 409,
        details: {
          dvaId: String(dva._id),
          status: dva.status,
        },
      });
    }

    WalletService.assertWalletIsActive(wallet);
  }

  /* ---------- FINANCIAL OBLIGATION PROTECTION ---------- */

  static async assertNoHistoricalFundingObligation({ provider, providerReference }, session) {
    if (!session?.inTransaction?.()) {
      throw new Error("Financial obligation validation requires an active transaction.");
    }

    const normalizedProvider = WalletFundingService.normalizeProvider(provider);

    const normalizedProviderReference = WalletFundingService.cleanString(providerReference);

    if (!normalizedProviderReference) {
      throw WalletFundingService.createFundingError({
        message: "Provider payment reference is required.",
        code: "PAYSTACK_WALLET_FUNDING_REFERENCE_REQUIRED",
      });
    }

    const obligation = await FinancialObligation.findOne({
      type: "retired_dva_funding",
      provider: normalizedProvider,
      providerReference: normalizedProviderReference,
    })
      .select("_id status wallet dva amount currency")
      .session(session);

    // Even settled obligations permanently exclude wallet credits.

    if (obligation) {
      const error = WalletFundingService.createFundingError({
        message: "This DVA payment already has a historical financial obligation.",
        code: "DVA_FUNDING_FINANCIAL_OBLIGATION_EXISTS",
        statusCode: 409,
        details: {
          financialObligationId: String(obligation._id),
          financialObligationStatus: obligation.status,
          providerReference: normalizedProviderReference,
        },
      });

      error.retryable = false;

      throw error;
    }

    return true;
  }

  /* ---------- RESULT VALIDATION ---------- */

  static assertCompletedDvaFunding({
    fundingResult,
    employerWallet,
    dva,
    amount,
    providerFee,
    netAmount,
    currency,
    providerReference,
  }) {
    const wallet = fundingResult?.wallet;
    const transaction = fundingResult?.transaction;

    const validWallet =
      wallet &&
      String(wallet._id) === String(employerWallet._id) &&
      wallet.ownerType === "employer" &&
      !wallet.professional &&
      String(wallet.employer) === String(dva.employer) &&
      wallet.countryCode === employerWallet.countryCode &&
      wallet.currency === currency;

    if (!validWallet) {
      throw WalletFundingService.createFundingError({
        message: "The completed DVA funding result contains an invalid employer wallet.",
        code: "INVALID_DVA_FUNDING_WALLET_RESULT",
        statusCode: 409,
      });
    }

    const validTransaction =
      transaction &&
      transaction.type === "wallet_funding" &&
      transaction.purpose === "wallet_topup" &&
      transaction.direction === "credit" &&
      transaction.paymentRail === "paystack_dva" &&
      transaction.provider === SUPPORTED_DVA_FUNDING_PROVIDER &&
      transaction.status === "completed" &&
      transaction.paystackStatus === "success" &&
      transaction.paystackReference === providerReference &&
      transaction.amount === amount &&
      transaction.providerFee === providerFee &&
      transaction.netAmount === netAmount &&
      transaction.countryCode === dva.countryCode &&
      transaction.currency === currency &&
      String(transaction.wallet) === String(employerWallet._id) &&
      String(transaction.dva) === String(dva._id);

    if (!validTransaction) {
      throw WalletFundingService.createFundingError({
        message: "The completed transaction does not match the DVA wallet funding event.",
        code: "DVA_FUNDING_TRANSACTION_MISMATCH",
        statusCode: 409,
        details: {
          transactionId: transaction?._id ? String(transaction._id) : null,
          providerReference,
          amount,
          currency,
          dvaId: String(dva._id),
          walletId: String(employerWallet._id),
        },
      });
    }

    return true;
  }

  /* ---------- DVA WALLET FUNDING ---------- */

  static async creditEmployerWalletFromDvaFunding(
    {
      employerProfileId,
      dvaId,
      amount,
      currency = "NGN",
      provider = SUPPORTED_DVA_FUNDING_PROVIDER,
      providerReference,
      providerEventId = null,
      providerFee = null,
      netAmount = null,
      metadata = {},
    },
    options = {}
  ) {
    const normalizedEmployerProfileId = WalletFundingService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedDvaId = WalletFundingService.normalizeObjectId(dvaId, "DVA ID");

    const normalizedProvider = WalletFundingService.normalizeProvider(provider);

    const normalizedProviderReference = WalletFundingService.cleanString(providerReference);

    if (!normalizedProviderReference) {
      throw WalletFundingService.createFundingError({
        message: "Paystack reference is required for wallet funding.",
        code: "PAYSTACK_WALLET_FUNDING_REFERENCE_REQUIRED",
      });
    }

    const normalizedProviderEventId = WalletFundingService.cleanString(providerEventId);

    const normalizedAmount = WalletFundingService.normalizePositiveAmount(
      amount,
      "wallet funding amount"
    );

    if (providerFee == null) {
      throw WalletFundingService.createFundingError({
        message: "DVA funding requires confirmed provider fees.",
        code: "DVA_FUNDING_PROVIDER_FEE_REQUIRED",
        statusCode: 409,
      });
    }

    const normalizedProviderFee = WalletFundingService.normalizeNonNegativeAmount(
      providerFee,
      "provider fee"
    );

    if (normalizedProviderFee > normalizedAmount) {
      throw WalletFundingService.createFundingError({
        message: "Provider fee cannot exceed the wallet funding amount.",
        code: "DVA_FUNDING_PROVIDER_FEE_EXCEEDS_AMOUNT",
        statusCode: 409,
        details: {
          amount: normalizedAmount,
          providerFee: normalizedProviderFee,
        },
      });
    }

    const normalizedNetAmount =
      netAmount == null
        ? normalizedAmount - normalizedProviderFee
        : WalletFundingService.normalizeNonNegativeAmount(netAmount, "net amount");

    if (normalizedProviderFee + normalizedNetAmount !== normalizedAmount) {
      throw WalletFundingService.createFundingError({
        message: "Wallet funding amount must equal provider fee plus net amount.",
        code: "DVA_FUNDING_AMOUNT_TRIPLE_MISMATCH",
        statusCode: 409,
        details: {
          amount: normalizedAmount,
          providerFee: normalizedProviderFee,
          netAmount: normalizedNetAmount,
        },
      });
    }

    const normalizedCurrency = WalletFundingService.normalizeCurrency(
      currency,
      "wallet funding currency"
    );

    const normalizedMetadata = WalletFundingService.normalizeMetadata(metadata);

    const idempotencyKey = WalletFundingService.buildFundingIdempotencyKey({
      provider: normalizedProvider,
      providerReference: normalizedProviderReference,
    });

    return runWithOptionalTransaction(options, async (session) => {
      /* ---------- LOCK FINANCIAL DISPOSITION ---------- */

      await WalletFundingService.lockDVAFundingDisposition(
        {
          dvaId: normalizedDvaId,
          employerProfileId: normalizedEmployerProfileId,
        },
        session
      );

      await WalletFundingService.assertNoHistoricalFundingObligation(
        {
          provider: normalizedProvider,
          providerReference: normalizedProviderReference,
        },
        session
      );

      /* ---------- RESOLVE HISTORICAL OWNERSHIP ---------- */

      const dva = await WalletFundingService.getEmployerDVAForFunding(
        {
          employerProfileId: normalizedEmployerProfileId,
          dvaId: normalizedDvaId,
        },
        { session }
      );

      const dvaCurrency = WalletFundingService.normalizeCurrency(dva.currency, "DVA currency");

      if (dvaCurrency !== normalizedCurrency) {
        throw WalletFundingService.createFundingError({
          message: "Funding currency does not match the DVA currency.",
          code: "DVA_FUNDING_CURRENCY_MISMATCH",
          statusCode: 409,
          details: {
            fundingCurrency: normalizedCurrency,
            dvaCurrency,
          },
        });
      }

      const employerWallet = await WalletFundingService.getLinkedEmployerWallet({
        dva,
        employerProfileId: normalizedEmployerProfileId,
        session,
      });

      if (employerWallet.currency !== normalizedCurrency) {
        throw WalletFundingService.createFundingError({
          message: "Funding currency does not match the employer wallet currency.",
          code: "DVA_FUNDING_WALLET_CURRENCY_MISMATCH",
          statusCode: 409,
          details: {
            fundingCurrency: normalizedCurrency,
            walletCurrency: employerWallet.currency,
          },
        });
      }

      /* ---------- IDEMPOTENT FUNDING ---------- */

      const existingFunding = await WalletService.getExistingTransactionByIdempotencyKey(
        idempotencyKey,
        session
      );

      // Existing credits remain replayable after retirement.

      if (!existingFunding) {
        WalletFundingService.assertDvaAcceptsNewFunding({
          dva,
          wallet: employerWallet,
          providerReference: normalizedProviderReference,
        });
      }

      /* ---------- WALLET CREDIT ---------- */

      const fundingResult = await WalletService.creditWallet(
        {
          walletId: employerWallet._id,

          amount: normalizedAmount,

          type: "wallet_funding",
          purpose: "wallet_topup",
          paymentRail: "paystack_dva",
          provider: normalizedProvider,

          status: "completed",
          paystackStatus: "success",

          idempotencyKey,

          paystackReference: normalizedProviderReference,
          providerEventId: normalizedProviderEventId,

          dva: dva._id,

          providerFee: normalizedProviderFee,
          netAmount: normalizedNetAmount,

          initiatedBy: {
            role: "system",
            userId: null,
          },

          description: "Employer wallet top-up received through Paystack DVA.",

          metadata: {
            ...normalizedMetadata,

            source: "dva_funding",

            provider: normalizedProvider,
            providerReference: normalizedProviderReference,
            providerEventId: normalizedProviderEventId,

            employerProfileId: String(normalizedEmployerProfileId),

            ownerUserId: String(dva.ownerUser),

            dvaId: String(dva._id),
            walletId: String(employerWallet._id),

            providerFee: normalizedProviderFee,
            netAmount: normalizedNetAmount,
          },
        },
        { session }
      );

      /* ---------- VALIDATE COMPLETED FUNDING ---------- */

      WalletFundingService.assertCompletedDvaFunding({
        fundingResult,
        employerWallet,
        dva,
        amount: normalizedAmount,
        providerFee: normalizedProviderFee,
        netAmount: normalizedNetAmount,
        currency: normalizedCurrency,
        providerReference: normalizedProviderReference,
      });

      if (existingFunding && fundingResult.idempotent !== true) {
        throw WalletFundingService.createFundingError({
          message: "Historical funding must resolve as an idempotent replay.",
          code: "DVA_FUNDING_REPLAY_MISMATCH",
          statusCode: 409,
        });
      }

      /* ---------- FUNDING NOTIFICATION ---------- */

      // Historical replays must not notify closed accounts.

      if (
        dva.status !== "active" ||
        dva.retirementStartedAt ||
        fundingResult.wallet.status !== "active"
      ) {
        return fundingResult;
      }

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

            provider: normalizedProvider,
            providerReference: normalizedProviderReference,
            providerEventId: normalizedProviderEventId,

            employerProfileId: String(normalizedEmployerProfileId),

            dvaId: String(dva._id),

            walletId: String(fundingResult.wallet._id),

            transactionId: String(fundingResult.transaction._id),

            idempotent: fundingResult.idempotent === true,
          },
        },
        { session }
      );

      return fundingResult;
    });
  }
}

module.exports = WalletFundingService;
