// services/walletFundingService.js

const mongoose = require("mongoose");

const DVA = require("../models/DVA");

const WalletService = require("./walletService");
const NotificationService = require("./notificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const money = require("../utils/money");

const SUPPORTED_DVA_FUNDING_PROVIDER = "paystack";

class WalletFundingService {
  /* ─────────────────────────────── ERRORS / NORMALIZATION ─────────────────────────────── */

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
    const cleanValue = String(value ?? "").trim();

    return cleanValue || null;
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

  /* ─────────────────────────────── IDEMPOTENCY ─────────────────────────────── */

  static buildFundingIdempotencyKey({ provider, providerReference }) {
    const normalizedProvider = WalletFundingService.normalizeProvider(provider);

    const normalizedProviderReference = WalletFundingService.cleanString(providerReference);

    if (!normalizedProviderReference) {
      throw WalletFundingService.createFundingError({
        message: "Paystack reference is required for wallet funding.",

        code: "PAYSTACK_WALLET_FUNDING_REFERENCE_REQUIRED",
      });
    }

    /*
     * The provider payment reference identifies the actual money movement.
     *
     * Callback processing, webhook retries and later reconciliation may carry
     * different provider event IDs for the same successful payment. Using the
     * event ID as the wallet-credit idempotency boundary could therefore credit
     * the same payment more than once.
     */
    return `wallet_funding:${normalizedProvider}:reference:` + `${normalizedProviderReference}`;
  }

  /* ─────────────────────────────── DVA / WALLET RESOLUTION ─────────────────────────────── */

  static async getActiveEmployerDVA({ employerProfileId, dvaId }, options = {}) {
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
      ].join(" ")
    );

    if (options.session) {
      query.session(options.session);
    }

    const dva = await query;

    if (!dva) {
      throw WalletFundingService.createFundingError({
        message: "Wallet bank account was not found for this employer.",

        code: "EMPLOYER_DVA_NOT_FOUND",

        statusCode: 404,
      });
    }

    if (dva.status !== "active") {
      throw WalletFundingService.createFundingError({
        message: "Wallet bank account is not active.",

        code: "EMPLOYER_DVA_NOT_ACTIVE",

        statusCode: 409,

        details: {
          dvaId: String(dva._id),

          status: dva.status,
        },
      });
    }

    if (!dva.ownerUser) {
      throw WalletFundingService.createFundingError({
        message: "The wallet bank account does not have an owner user.",

        code: "EMPLOYER_DVA_OWNER_USER_REQUIRED",

        statusCode: 500,
      });
    }

    if (!dva.wallet) {
      throw WalletFundingService.createFundingError({
        message: "Wallet bank account is not linked to an employer wallet.",

        code: "EMPLOYER_DVA_WALLET_REQUIRED",

        statusCode: 500,
      });
    }

    return dva;
  }

  static async getLinkedEmployerWallet({ dva, employerProfileId, session }) {
    const wallet = await WalletService.getEmployerWallet(
      {
        employerProfileId,

        countryCode: dva.countryCode,

        currency: dva.currency,
      },
      {
        session,
      }
    );

    if (!wallet) {
      throw WalletFundingService.createFundingError({
        message: "The employer wallet linked to the DVA was not found.",

        code: "DVA_EMPLOYER_WALLET_NOT_FOUND",

        statusCode: 500,
      });
    }

    const walletMatchesDva =
      wallet.ownerType === "employer" &&
      String(wallet.employer) === String(employerProfileId) &&
      String(wallet._id) === String(dva.wallet);

    if (!walletMatchesDva) {
      throw WalletFundingService.createFundingError({
        message: "The DVA is not linked to the employer's authoritative wallet.",

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

    WalletService.assertWalletIsActive(wallet);

    return wallet;
  }

  /* ─────────────────────────────── RESULT VALIDATION ─────────────────────────────── */

  static assertCompletedDvaFunding({
    fundingResult,

    employerWallet,
    dva,

    amount,
    currency,

    providerReference,
  }) {
    const wallet = fundingResult?.wallet;

    const transaction = fundingResult?.transaction;

    const validWallet =
      wallet &&
      String(wallet._id) === String(employerWallet._id) &&
      wallet.ownerType === "employer" &&
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
      Number(transaction.amount) === amount &&
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

  /* ─────────────────────────────── DVA WALLET FUNDING ─────────────────────────────── */

  static async creditEmployerWalletFromDvaFunding(
    {
      employerProfileId,
      dvaId,

      amount,
      currency = "NGN",

      provider = SUPPORTED_DVA_FUNDING_PROVIDER,

      providerReference,
      providerEventId = null,

      providerFee = 0,
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

    const normalizedProviderFee = WalletFundingService.normalizeNonNegativeAmount(
      providerFee ?? 0,
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
      netAmount === null || netAmount === undefined
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

    return runWithOptionalTransaction(
      options,

      async (session) => {
        const dva = await WalletFundingService.getActiveEmployerDVA(
          {
            employerProfileId: normalizedEmployerProfileId,

            dvaId: normalizedDvaId,
          },
          {
            session,
          }
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
          {
            session,
          }
        );

        WalletFundingService.assertCompletedDvaFunding({
          fundingResult,

          employerWallet,

          dva,

          amount: normalizedAmount,

          currency: normalizedCurrency,

          providerReference: normalizedProviderReference,
        });

        /*
         * This runs on both the first credit and idempotent replays.
         * NotificationService uses the completed transaction as its own
         * idempotency boundary, so a previously missed notification can
         * be created without duplicating an existing one.
         */
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
          {
            session,
          }
        );

        return fundingResult;
      }
    );
  }
}

module.exports = WalletFundingService;
