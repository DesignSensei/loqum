// services/walletWithdrawalService.js

const mongoose = require("mongoose");

const EmployerProfile = require("../models/EmployerProfile");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const BankAccount = require("../models/BankAccount");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");

const WalletService = require("./walletService");
const NotificationService = require("./notificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const money = require("../utils/money");

const WITHDRAWAL_OWNER_TYPES = ["employer", "professional"];

const WITHDRAWAL_STATUSES = ["pending", "processing", "completed", "failed", "cancelled"];

const MAX_REASON_LENGTH = 300;

class WalletWithdrawalService {
  /* ─────────────────────────────── ERRORS / NORMALIZATION ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: "WalletWithdrawalServiceError",
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

  static normalizeObjectId(value, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw WalletWithdrawalService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw WalletWithdrawalService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(date.getTime())) {
      throw WalletWithdrawalService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return date;
  }

  static cleanOwnerType(ownerType) {
    const normalized = WalletWithdrawalService.cleanString(ownerType)?.toLowerCase();

    if (!WITHDRAWAL_OWNER_TYPES.includes(normalized)) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal owner type must be employer or professional.",
        code: "INVALID_WITHDRAWAL_OWNER_TYPE",
      });
    }

    return normalized;
  }

  static normalizeReason(value, fallback) {
    const reason = WalletWithdrawalService.cleanString(value) || fallback;

    if (reason.length > MAX_REASON_LENGTH) {
      throw WalletWithdrawalService.createError({
        message: `Withdrawal reason cannot exceed ` + `${MAX_REASON_LENGTH} characters.`,
        code: "WITHDRAWAL_REASON_TOO_LONG",
      });
    }

    return reason;
  }

  static normalizeMetadata(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  static hasDefinitiveProviderFailureEvidence(transaction, metadata = {}) {
    const cleanMetadata = WalletWithdrawalService.normalizeMetadata(metadata);

    const statusValues = [
      transaction?.paystackStatus,
      cleanMetadata.paystackTransferStatus,
      cleanMetadata.providerTransferStatus,
      cleanMetadata.paystackStatus,
    ]
      .map((value) => WalletWithdrawalService.cleanString(value)?.toLowerCase())
      .filter(Boolean);

    if (
      statusValues.some((value) =>
        ["failed", "failure", "rejected", "abandoned", "blocked", "reversed"].includes(value)
      )
    ) {
      return true;
    }

    const sourceEventName =
      WalletWithdrawalService.cleanString(cleanMetadata.sourceEventName)?.toLowerCase() || null;

    if (["transfer.failed", "transfer.reversed"].includes(sourceEventName)) {
      return true;
    }

    return cleanMetadata.source === "withdrawal_reversal_cron";
  }

  /* ─────────────────────────────── OWNER CONFIGURATION ─────────────────────────────── */

  static getOwnerConfig(ownerType) {
    const normalized = WalletWithdrawalService.cleanOwnerType(ownerType);

    if (normalized === "employer") {
      return {
        ownerType: "employer",
        ownerField: "employer",
        profileModel: EmployerProfile,
        profileLabel: "Employer profile",
        walletCreatorName: "createEmployerWalletIfMissing",
        metadataProfileKey: "employerProfileId",
        source: "employer_withdrawal_request",
        defaultDescription: "Employer wallet withdrawal requested.",
      };
    }

    return {
      ownerType: "professional",
      ownerField: "professional",
      profileModel: ProfessionalProfile,
      profileLabel: "Professional profile",
      walletCreatorName: "createProfessionalWalletIfMissing",
      metadataProfileKey: "professionalProfileId",
      source: "professional_withdrawal_request",
      defaultDescription: "Professional wallet withdrawal requested.",
    };
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getProfile({ ownerType, ownerProfileId }, options = {}) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    const profileId = WalletWithdrawalService.normalizeObjectId(
      ownerProfileId,
      `${config.ownerType} profile ID`
    );

    const query = config.profileModel.findById(profileId);

    if (options.session) {
      query.session(options.session);
    }

    const profile = await query;

    if (!profile) {
      throw WalletWithdrawalService.createError({
        message: `${config.profileLabel} not found.`,
        code: `${normalizeFieldCode(config.profileLabel)}_NOT_FOUND`,
        statusCode: 404,
      });
    }

    return profile;
  }

  static async getEmployerProfile(employerProfileId, options = {}) {
    return WalletWithdrawalService.getProfile(
      {
        ownerType: "employer",
        ownerProfileId: employerProfileId,
      },
      options
    );
  }

  static async getProfessionalProfile(professionalProfileId, options = {}) {
    return WalletWithdrawalService.getProfile(
      {
        ownerType: "professional",
        ownerProfileId: professionalProfileId,
      },
      options
    );
  }

  static async getActiveBankAccount(
    { ownerType, ownerProfileId, bankAccountId = null },
    options = {}
  ) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    const profileId = WalletWithdrawalService.normalizeObjectId(
      ownerProfileId,
      `${config.ownerType} profile ID`
    );

    const accountId = WalletWithdrawalService.normalizeObjectId(
      bankAccountId,
      "bank account ID",
      false
    );

    const filter = {
      ownerType: config.ownerType,
      [config.ownerField]: profileId,
      isActive: true,
    };

    if (accountId) {
      filter._id = accountId;
    }

    const query = BankAccount.findOne(filter).select("+accountNumber +paystackBankCode").sort({
      updatedAt: -1,
      _id: -1,
    });

    if (options.session) {
      query.session(options.session);
    }

    const bankAccount = await query;

    if (!bankAccount) {
      throw WalletWithdrawalService.createError({
        message: "Active withdrawal bank account not found.",
        code: "ACTIVE_WITHDRAWAL_BANK_ACCOUNT_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (bankAccount.verificationStatus !== "verified") {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal bank account must be verified before withdrawal.",
        code: "WITHDRAWAL_BANK_ACCOUNT_NOT_VERIFIED",
        statusCode: 409,
        details: {
          bankAccountId: String(bankAccount._id),
          verificationStatus: bankAccount.verificationStatus,
        },
      });
    }

    if (
      bankAccount.ownerType !== config.ownerType ||
      String(bankAccount[config.ownerField]) !== String(profileId)
    ) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal bank account does not belong to the supplied wallet owner.",
        code: "WITHDRAWAL_BANK_ACCOUNT_OWNERSHIP_MISMATCH",
        statusCode: 409,
      });
    }

    const accountNumber = String(bankAccount.accountNumber || "")
      .replace(/\s+/g, "")
      .trim();

    if (!accountNumber) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal bank account number is required.",
        code: "WITHDRAWAL_BANK_ACCOUNT_NUMBER_REQUIRED",
        statusCode: 409,
      });
    }

    if (!WalletWithdrawalService.cleanString(bankAccount.accountName)) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal bank account name is required.",
        code: "WITHDRAWAL_BANK_ACCOUNT_NAME_REQUIRED",
        statusCode: 409,
      });
    }

    if (!WalletWithdrawalService.cleanString(bankAccount.paystackBankCode)) {
      throw WalletWithdrawalService.createError({
        message: "Paystack bank code is required before withdrawal.",
        code: "WITHDRAWAL_PAYSTACK_BANK_CODE_REQUIRED",
        statusCode: 409,
      });
    }

    return bankAccount;
  }

  static async getActiveEmployerBankAccount(
    { employerProfileId, bankAccountId = null },
    options = {}
  ) {
    return WalletWithdrawalService.getActiveBankAccount(
      {
        ownerType: "employer",
        ownerProfileId: employerProfileId,
        bankAccountId,
      },
      options
    );
  }

  static async getActiveProfessionalBankAccount(
    { professionalProfileId, bankAccountId = null },
    options = {}
  ) {
    return WalletWithdrawalService.getActiveBankAccount(
      {
        ownerType: "professional",
        ownerProfileId: professionalProfileId,
        bankAccountId,
      },
      options
    );
  }

  static async getOrCreateOwnerWallet({ ownerType, profile }, options = {}) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    const creator = WalletService[config.walletCreatorName];

    if (typeof creator !== "function") {
      throw WalletWithdrawalService.createError({
        message: `${config.walletCreatorName} is not ` + "available on WalletService.",
        code: "WITHDRAWAL_WALLET_CREATOR_NOT_AVAILABLE",
        statusCode: 500,
      });
    }

    const wallet = await creator.call(WalletService, profile, options);

    if (
      !wallet ||
      wallet.ownerType !== config.ownerType ||
      String(wallet[config.ownerField]) !== String(profile._id)
    ) {
      throw WalletWithdrawalService.createError({
        message: "The resolved wallet does not match the withdrawal owner.",
        code: "WITHDRAWAL_WALLET_OWNERSHIP_MISMATCH",
        statusCode: 500,
      });
    }

    return wallet;
  }

  static async getWithdrawalTransaction(withdrawalTransactionId, session) {
    const transactionId = WalletWithdrawalService.normalizeObjectId(
      withdrawalTransactionId,
      "withdrawal transaction ID"
    );

    const transaction = await Transaction.findById(transactionId).session(session);

    if (!transaction) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal transaction not found.",
        code: "WITHDRAWAL_TRANSACTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return transaction;
  }

  /* ─────────────────────────────── AMOUNTS / IDEMPOTENCY ─────────────────────────────── */

  static buildWithdrawalIdempotencyKey({ ownerType, ownerProfileId, requestReference }) {
    const normalizedOwnerType = WalletWithdrawalService.cleanOwnerType(ownerType);

    const profileId = WalletWithdrawalService.normalizeObjectId(ownerProfileId, "owner profile ID");

    const reference = WalletWithdrawalService.cleanString(requestReference);

    if (!reference) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal request reference is required.",
        code: "WITHDRAWAL_REQUEST_REFERENCE_REQUIRED",
      });
    }

    return `withdrawal:${normalizedOwnerType}:` + `${profileId}:${reference}`;
  }

  static validateWithdrawalAmount({ wallet, amount }) {
    let normalizedAmount;
    let availableBalance;

    try {
      normalizedAmount = money.normalizePositiveMinorUnitAmount(amount, "Withdrawal amount");

      availableBalance = money.normalizeMinorUnitAmount(
        wallet.availableBalance || 0,
        "Available balance"
      );
    } catch (error) {
      throw WalletWithdrawalService.createError({
        message: error.message,
        code: "INVALID_WITHDRAWAL_AMOUNT",
        cause: error,
      });
    }

    const minimum = Number(wallet.minimumWithdrawalAmount || 0);

    if (minimum > 0 && normalizedAmount < minimum) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal amount is below the minimum withdrawal amount.",
        code: "WITHDRAWAL_AMOUNT_BELOW_MINIMUM",
        statusCode: 409,
        details: {
          requestedAmount: normalizedAmount,
          minimumWithdrawalAmount: minimum,
          currency: wallet.currency,
        },
      });
    }

    if (availableBalance < normalizedAmount) {
      throw WalletWithdrawalService.createError({
        message: "Insufficient available wallet balance.",
        code: "INSUFFICIENT_WITHDRAWAL_BALANCE",
        statusCode: 409,
        details: {
          availableBalance,
          requestedAmount: normalizedAmount,
          shortfall: normalizedAmount - availableBalance,
          currency: wallet.currency,
        },
      });
    }

    return normalizedAmount;
  }

  static validateWithdrawalFeeAmounts({ amount, providerFee = 0, netAmount = null }) {
    let normalizedProviderFee;
    let normalizedNetAmount;

    try {
      normalizedProviderFee = money.normalizeMinorUnitAmount(providerFee ?? 0, "Provider fee");

      normalizedNetAmount =
        netAmount === null || netAmount === undefined
          ? amount
          : money.normalizePositiveMinorUnitAmount(netAmount, "Net amount");
    } catch (error) {
      throw WalletWithdrawalService.createError({
        message: error.message,
        code: "INVALID_WITHDRAWAL_PROVIDER_AMOUNTS",
        cause: error,
      });
    }

    if (normalizedProviderFee > amount) {
      throw WalletWithdrawalService.createError({
        message: "Provider fee cannot be greater than withdrawal amount.",
        code: "WITHDRAWAL_PROVIDER_FEE_EXCEEDS_AMOUNT",
        statusCode: 409,
      });
    }

    if (normalizedNetAmount > amount) {
      throw WalletWithdrawalService.createError({
        message: "Net amount cannot be greater than withdrawal amount.",
        code: "WITHDRAWAL_NET_AMOUNT_EXCEEDS_AMOUNT",
        statusCode: 409,
      });
    }

    /*
     * amount is the wallet debit.
     * netAmount is the bank payout.
     *
     * They do not have to satisfy:
     *
     * amount = providerFee + netAmount
     *
     * because Loqum may bear the provider fee rather than
     * deducting that fee from the wallet owner's payout.
     */
    return {
      normalizedProviderFee,
      normalizedNetAmount,
    };
  }

  /* ─────────────────────────────── TRANSACTION VALIDATION ─────────────────────────────── */

  static assertWithdrawalTransaction(transaction) {
    const valid =
      transaction &&
      transaction.type === "withdrawal" &&
      transaction.purpose === "withdrawal" &&
      transaction.direction === "debit" &&
      transaction.paymentRail === "paystack_transfer" &&
      transaction.provider === "paystack" &&
      transaction.bankAccount &&
      transaction.wallet &&
      !transaction.counterpartyWallet &&
      WITHDRAWAL_STATUSES.includes(transaction.status);

    if (!valid) {
      throw WalletWithdrawalService.createError({
        message: "Transaction is not a valid Paystack wallet withdrawal.",
        code: "INVALID_WITHDRAWAL_TRANSACTION",
        statusCode: 409,
      });
    }

    const transferReference = WalletWithdrawalService.cleanString(
      transaction.paystackTransferReference
    );

    if (["processing", "completed", "failed"].includes(transaction.status) && !transferReference) {
      throw WalletWithdrawalService.createError({
        message:
          "Provider-bound withdrawal does not contain its deterministic Paystack transfer reference.",
        code: "WITHDRAWAL_PAYSTACK_TRANSFER_REFERENCE_REQUIRED",
        statusCode: 409,
      });
    }

    if (transferReference && !/^[a-z0-9_-]{16,50}$/.test(transferReference.toLowerCase())) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal contains an invalid Paystack transfer reference.",
        code: "INVALID_WITHDRAWAL_PAYSTACK_TRANSFER_REFERENCE",
        statusCode: 409,
      });
    }

    if (transaction.status === "completed" && !transaction.paystackTransferCode) {
      throw WalletWithdrawalService.createError({
        message: "Completed withdrawal does not contain a Paystack transfer code.",
        code: "WITHDRAWAL_PAYSTACK_TRANSFER_CODE_REQUIRED",
        statusCode: 409,
      });
    }

    return true;
  }

  static assertWithdrawalMatchesRequest({
    result,
    config,
    profile,
    bankAccount,
    userId,
    amount,
    providerFee,
    netAmount,
    requestReference,
  }) {
    const wallet = result?.wallet;
    const transaction = result?.transaction;

    WalletWithdrawalService.assertWithdrawalTransaction(transaction);

    const expectedPaystackStatus = {
      pending: "pending",
      processing: "pending",
      completed: "success",
      failed: "failed",
      cancelled: null,
    }[transaction.status];

    const expectedBalanceDelta = {
      pending: {
        availableBalance: -amount,
        pendingBalance: amount,
      },

      processing: {
        availableBalance: -amount,
        pendingBalance: amount,
      },

      completed: {
        availableBalance: 0,
        pendingBalance: -amount,
      },

      failed: {
        availableBalance: amount,
        pendingBalance: -amount,
      },

      cancelled: {
        availableBalance: amount,
        pendingBalance: -amount,
      },
    }[transaction.status];

    const valid =
      wallet &&
      wallet.ownerType === config.ownerType &&
      String(wallet[config.ownerField]) === String(profile._id) &&
      String(transaction.wallet) === String(wallet._id) &&
      String(transaction.bankAccount) === String(bankAccount._id) &&
      Number(transaction.amount) === amount &&
      Number(transaction.providerFee) === providerFee &&
      Number(transaction.netAmount) === netAmount &&
      transaction.paystackStatus === expectedPaystackStatus &&
      transaction.initiatedBy?.role === config.ownerType &&
      String(transaction.initiatedBy?.userId || "") === String(userId) &&
      transaction.metadata?.ownerType === config.ownerType &&
      String(transaction.metadata?.[config.metadataProfileKey] || "") === String(profile._id) &&
      transaction.metadata?.requestReference === requestReference &&
      Number(transaction.balanceDelta?.availableBalance) ===
        expectedBalanceDelta.availableBalance &&
      Number(transaction.balanceDelta?.pendingBalance || 0) ===
        expectedBalanceDelta.pendingBalance &&
      Number(transaction.balanceDelta?.outstandingBalance || 0) === 0;

    if (!valid) {
      throw WalletWithdrawalService.createError({
        message: "Existing withdrawal does not match the requested withdrawal.",
        code: "WITHDRAWAL_IDEMPOTENCY_CONFLICT",
        statusCode: 409,
        details: {
          transactionId: transaction?._id ? String(transaction._id) : null,
          status: transaction?.status || null,
        },
      });
    }

    return true;
  }

  static getWithdrawalOwnerType(transaction) {
    const ownerType = WalletWithdrawalService.cleanString(
      transaction.metadata?.ownerType
    )?.toLowerCase();

    return WITHDRAWAL_OWNER_TYPES.includes(ownerType) ? ownerType : null;
  }

  static getWithdrawalRecipientUser(transaction) {
    return transaction.metadata?.recipientUserId || transaction.initiatedBy?.userId || null;
  }

  static getWithdrawalEmployerProfileId(transaction) {
    return transaction.metadata?.employerProfileId || null;
  }

  /* ─────────────────────────────── CREATE REQUEST ─────────────────────────────── */

  static async createWithdrawalRequest(
    {
      ownerType,
      userId,
      ownerProfileId,
      bankAccountId = null,
      amount,
      requestReference,
      providerFee = 0,
      netAmount = null,
      description = null,
      metadata = {},
    },
    options = {}
  ) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    const actorUserId = WalletWithdrawalService.normalizeObjectId(userId, "user ID");

    const profileId = WalletWithdrawalService.normalizeObjectId(
      ownerProfileId,
      `${config.ownerType} profile ID`
    );

    const accountId = WalletWithdrawalService.normalizeObjectId(
      bankAccountId,
      "bank account ID",
      false
    );

    const requestRef = WalletWithdrawalService.cleanString(requestReference);

    const cleanMetadata = WalletWithdrawalService.normalizeMetadata(metadata);

    if (!requestRef) {
      throw WalletWithdrawalService.createError({
        message: "Withdrawal request reference is required.",
        code: "WITHDRAWAL_REQUEST_REFERENCE_REQUIRED",
      });
    }

    return runWithOptionalTransaction(options, async (session) => {
      const profile = await WalletWithdrawalService.getProfile(
        {
          ownerType: config.ownerType,

          ownerProfileId: profileId,
        },
        {
          session,
        }
      );

      if (!profile.user || String(profile.user) !== String(actorUserId)) {
        throw WalletWithdrawalService.createError({
          message: `${config.profileLabel} does not belong to the current user.`,
          code: "WITHDRAWAL_PROFILE_OWNERSHIP_MISMATCH",
          statusCode: 403,
        });
      }

      const bankAccount = await WalletWithdrawalService.getActiveBankAccount(
        {
          ownerType: config.ownerType,

          ownerProfileId: profile._id,

          bankAccountId: accountId,
        },
        {
          session,
        }
      );

      const wallet = await WalletWithdrawalService.getOrCreateOwnerWallet(
        {
          ownerType: config.ownerType,

          profile,
        },
        {
          session,
        }
      );

      WalletService.assertWalletIsActive(wallet);

      const normalizedAmount = WalletWithdrawalService.validateWithdrawalAmount({
        wallet,
        amount,
      });

      const { normalizedProviderFee, normalizedNetAmount } =
        WalletWithdrawalService.validateWithdrawalFeeAmounts({
          amount: normalizedAmount,

          providerFee,

          netAmount,
        });

      const idempotencyKey = WalletWithdrawalService.buildWithdrawalIdempotencyKey({
        ownerType: config.ownerType,

        ownerProfileId: profile._id,

        requestReference: requestRef,
      });

      /*
       * Reserve the requested value before any provider call:
       *
       * availableBalance -= amount
       * pendingBalance   += amount
       *
       * The value has not left the wallet yet. PaystackTransferService later
       * persists the deterministic Transfer reference and crosses the provider
       * boundary before POST /transfer.
       */
      const result = await WalletService.createPendingExternalDebit(
        {
          walletId: wallet._id,

          amount: normalizedAmount,

          type: "withdrawal",

          purpose: "withdrawal",

          paymentRail: "paystack_transfer",

          provider: "paystack",

          idempotencyKey,

          paystackTransferReference: null,

          bankAccount: bankAccount._id,

          providerFee: normalizedProviderFee,

          netAmount: normalizedNetAmount,

          initiatedBy: {
            role: config.ownerType,

            userId: actorUserId,
          },

          description:
            WalletWithdrawalService.cleanString(description) || config.defaultDescription,

          metadata: {
            ...cleanMetadata,

            source: config.source,

            ownerType: config.ownerType,

            [config.metadataProfileKey]: String(profile._id),

            recipientUserId: String(profile.user),

            bankAccountId: String(bankAccount._id),

            requestReference: requestRef,
          },
        },
        {
          session,
        }
      );

      WalletWithdrawalService.assertWithdrawalMatchesRequest({
        result,

        config,

        profile,

        bankAccount,

        userId: actorUserId,

        amount: normalizedAmount,

        providerFee: normalizedProviderFee,

        netAmount: normalizedNetAmount,

        requestReference: requestRef,
      });

      if (config.ownerType === "employer" && result.idempotent !== true) {
        await NotificationService.notifyEmployerWithdrawalSubmitted(
          {
            recipientUser: profile.user,

            employer: profile._id,

            wallet: result.wallet,

            transaction: result.transaction,

            amount: result.transaction.amount,

            currency: result.transaction.currency,

            metadata: {
              source: "wallet_withdrawal_service",

              withdrawalTransactionId: String(result.transaction._id),

              idempotent: false,
            },
          },
          {
            session,
          }
        );
      }

      return {
        ...result,

        providerSubmissionRequired: result.transaction.status === "pending",
      };
    });
  }

  static async createEmployerWithdrawalRequest(payload, options = {}) {
    return WalletWithdrawalService.createWithdrawalRequest(
      {
        ownerType: "employer",

        userId: payload.userId,

        ownerProfileId: payload.employerProfileId,

        bankAccountId: payload.bankAccountId ?? null,

        amount: payload.amount,

        requestReference: payload.requestReference,

        providerFee: payload.providerFee ?? 0,

        netAmount: payload.netAmount ?? null,

        description: payload.description ?? null,

        metadata: payload.metadata ?? {},
      },
      options
    );
  }

  static async createProfessionalWithdrawalRequest(payload, options = {}) {
    return WalletWithdrawalService.createWithdrawalRequest(
      {
        ownerType: "professional",

        userId: payload.userId,

        ownerProfileId: payload.professionalProfileId,

        bankAccountId: payload.bankAccountId ?? null,

        amount: payload.amount,

        requestReference: payload.requestReference,

        providerFee: payload.providerFee ?? 0,

        netAmount: payload.netAmount ?? null,

        description: payload.description ?? null,

        metadata: payload.metadata ?? {},
      },
      options
    );
  }

  /* ─────────────────────────────── PROVIDER SUBMISSION ─────────────────────────────── */

  static async markWithdrawalSubmittedToProvider(
    {
      withdrawalTransactionId,

      paystackTransferCode,

      currentTime = new Date(),

      metadata = {},
    },
    options = {}
  ) {
    const transferCode = WalletWithdrawalService.cleanString(paystackTransferCode);

    const submittedAt = WalletWithdrawalService.normalizeCurrentTime(currentTime);

    const cleanMetadata = WalletWithdrawalService.normalizeMetadata(metadata);

    if (!transferCode) {
      throw WalletWithdrawalService.createError({
        message: "Paystack transfer code is required.",
        code: "PAYSTACK_TRANSFER_CODE_REQUIRED",
      });
    }

    return runWithOptionalTransaction(options, async (session) => {
      const transaction = await WalletWithdrawalService.getWithdrawalTransaction(
        withdrawalTransactionId,
        session
      );

      WalletWithdrawalService.assertWithdrawalTransaction(transaction);

      if (transaction.status === "completed") {
        if (transaction.paystackTransferCode !== transferCode) {
          throw WalletWithdrawalService.createError({
            message: "Completed withdrawal has a different Paystack transfer code.",
            code: "WITHDRAWAL_TRANSFER_CODE_CONFLICT",
            statusCode: 409,
          });
        }

        return {
          transaction,
          alreadyCompleted: true,
          idempotent: true,
        };
      }

      if (["failed", "cancelled"].includes(transaction.status)) {
        throw WalletWithdrawalService.createError({
          message: `A ${transaction.status} withdrawal cannot accept a provider transfer code.`,
          code: "TERMINAL_WITHDRAWAL_CANNOT_BE_SUBMITTED",
          statusCode: 409,
          details: {
            status: transaction.status,
          },
        });
      }

      if (transaction.status !== "processing") {
        throw WalletWithdrawalService.createError({
          message:
            "Withdrawal must cross the persisted provider boundary before a Paystack transfer code can be recorded.",
          code: "WITHDRAWAL_PROVIDER_BOUNDARY_NOT_COMMITTED",
          statusCode: 409,
          details: {
            status: transaction.status,
          },
        });
      }

      const transferReference = WalletWithdrawalService.cleanString(
        transaction.paystackTransferReference
      );

      if (!transferReference) {
        throw WalletWithdrawalService.createError({
          message: "Withdrawal has no persisted Paystack transfer reference.",
          code: "WITHDRAWAL_PAYSTACK_TRANSFER_REFERENCE_REQUIRED",
          statusCode: 409,
        });
      }

      if (transaction.paystackTransferCode) {
        if (transaction.paystackTransferCode !== transferCode) {
          throw WalletWithdrawalService.createError({
            message: "Withdrawal already contains a different Paystack transfer code.",
            code: "WITHDRAWAL_TRANSFER_CODE_CONFLICT",
            statusCode: 409,
          });
        }

        return {
          transaction,
          alreadyCompleted: false,
          idempotent: true,
        };
      }

      transaction.paystackTransferCode = transferCode;

      transaction.paystackStatus = "pending";

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...cleanMetadata,

        providerSubmissionAt: submittedAt,
      };

      transaction.markModified("metadata");

      await transaction.save({
        session,
      });

      return {
        transaction,
        alreadyCompleted: false,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── PROVIDER COMPLETION ─────────────────────────────── */

  static async markWithdrawalCompleted(
    {
      withdrawalTransactionId,

      paystackTransferCode = null,

      providerEventId = null,

      currentTime = new Date(),

      metadata = {},
    },
    options = {}
  ) {
    const completedAt = WalletWithdrawalService.normalizeCurrentTime(currentTime);

    const eventId = WalletWithdrawalService.cleanString(providerEventId);

    const cleanMetadata = WalletWithdrawalService.normalizeMetadata(metadata);

    return runWithOptionalTransaction(options, async (session) => {
      const transaction = await WalletWithdrawalService.getWithdrawalTransaction(
        withdrawalTransactionId,
        session
      );

      WalletWithdrawalService.assertWithdrawalTransaction(transaction);

      if (transaction.status === "completed") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        if (!wallet) {
          throw WalletWithdrawalService.createError({
            message: "Wallet not found for completed withdrawal.",
            code: "WITHDRAWAL_WALLET_NOT_FOUND",
            statusCode: 404,
          });
        }

        return {
          wallet,
          transaction,
          alreadyCompleted: true,
          idempotent: true,
        };
      }

      if (["failed", "cancelled"].includes(transaction.status)) {
        throw WalletWithdrawalService.createError({
          message: `A ${transaction.status} withdrawal cannot be marked as completed.`,
          code: "TERMINAL_WITHDRAWAL_CANNOT_BE_COMPLETED",
          statusCode: 409,
        });
      }

      if (transaction.status !== "processing") {
        throw WalletWithdrawalService.createError({
          message: "Only a provider-processing withdrawal can be marked as completed.",
          code: "WITHDRAWAL_NOT_PROCESSING",
          statusCode: 409,
          details: {
            status: transaction.status,
          },
        });
      }

      const transferCode =
        WalletWithdrawalService.cleanString(transaction.paystackTransferCode) ||
        WalletWithdrawalService.cleanString(paystackTransferCode) ||
        WalletWithdrawalService.cleanString(cleanMetadata.paystackTransferCode) ||
        WalletWithdrawalService.cleanString(cleanMetadata.transferCode);

      if (!transferCode) {
        throw WalletWithdrawalService.createError({
          message: "Successful withdrawal cannot be completed without the Paystack transfer code.",
          code: "WITHDRAWAL_PAYSTACK_TRANSFER_CODE_REQUIRED",
          statusCode: 409,
        });
      }

      if (!transaction.paystackTransferCode) {
        transaction.paystackTransferCode = transferCode;

        transaction.metadata = {
          ...(transaction.metadata || {}),

          ...cleanMetadata,

          providerTransferCodeRecoveredAt: completedAt,
        };

        transaction.markModified("metadata");

        await transaction.save({
          session,
        });
      } else if (transaction.paystackTransferCode !== transferCode) {
        throw WalletWithdrawalService.createError({
          message: "Successful withdrawal contains a conflicting Paystack transfer code.",
          code: "WITHDRAWAL_TRANSFER_CODE_CONFLICT",
          statusCode: 409,
        });
      }

      const completedResult = await WalletService.completePendingExternalDebit(
        {
          transactionId: transaction._id,

          paystackTransferCode: transferCode,

          providerEventId: eventId,

          metadata: cleanMetadata,

          currentTime: completedAt,
        },
        {
          session,
        }
      );

      const completedTransaction = completedResult.transaction;

      const wallet = completedResult.wallet;

      const ownerType = WalletWithdrawalService.getWithdrawalOwnerType(completedTransaction);

      const recipientUser =
        WalletWithdrawalService.getWithdrawalRecipientUser(completedTransaction);

      const employer = WalletWithdrawalService.getWithdrawalEmployerProfileId(completedTransaction);

      if (
        completedResult.idempotent !== true &&
        ownerType === "employer" &&
        recipientUser &&
        employer
      ) {
        await NotificationService.notifyEmployerWithdrawalCompleted(
          {
            recipientUser,

            employer,

            wallet,

            transaction: completedTransaction,

            amount: completedTransaction.amount,

            currency: completedTransaction.currency,

            metadata: {
              source: "wallet_withdrawal_service",

              withdrawalTransactionId: String(completedTransaction._id),
            },
          },
          {
            session,
          }
        );
      }

      return {
        wallet,

        transaction: completedTransaction,

        alreadyCompleted: completedResult.idempotent === true,

        idempotent: completedResult.idempotent === true,
      };
    });
  }

  /* ─────────────────────────────── FAILED WITHDRAWAL RESTORATION ─────────────────────────────── */

  static async reverseFailedWithdrawal(
    {
      withdrawalTransactionId,

      paystackTransferCode = null,

      providerEventId = null,

      reversalReason = "Withdrawal failed. Wallet balance restored.",

      currentTime = new Date(),

      metadata = {},
    },
    options = {}
  ) {
    const restoredAt = WalletWithdrawalService.normalizeCurrentTime(currentTime);

    const eventId = WalletWithdrawalService.cleanString(providerEventId);

    const reason = WalletWithdrawalService.normalizeReason(
      reversalReason,
      "Withdrawal failed. Wallet balance restored."
    );

    const cleanMetadata = WalletWithdrawalService.normalizeMetadata(metadata);

    return runWithOptionalTransaction(options, async (session) => {
      const withdrawal = await WalletWithdrawalService.getWithdrawalTransaction(
        withdrawalTransactionId,
        session
      );

      WalletWithdrawalService.assertWithdrawalTransaction(withdrawal);

      if (withdrawal.status === "completed") {
        throw WalletWithdrawalService.createError({
          message: "A completed withdrawal cannot use the failed-withdrawal restoration flow.",
          code: "COMPLETED_WITHDRAWAL_CANNOT_BE_FAILED_REVERSED",
          statusCode: 409,
        });
      }

      if (withdrawal.status === "failed") {
        const wallet = await Wallet.findById(withdrawal.wallet).session(session);

        if (!wallet) {
          throw WalletWithdrawalService.createError({
            message: "Wallet not found for withdrawal restoration.",
            code: "WITHDRAWAL_WALLET_NOT_FOUND",
            statusCode: 404,
          });
        }

        return {
          wallet,

          transaction: withdrawal,

          originalTransaction: withdrawal,

          idempotent: true,

          released: true,

          cancelledBeforeProvider: false,
        };
      }

      if (withdrawal.status === "cancelled") {
        const wallet = await Wallet.findById(withdrawal.wallet).session(session);

        if (!wallet) {
          throw WalletWithdrawalService.createError({
            message: "Wallet not found for withdrawal restoration.",
            code: "WITHDRAWAL_WALLET_NOT_FOUND",
            statusCode: 404,
          });
        }

        return {
          wallet,

          transaction: withdrawal,

          originalTransaction: withdrawal,

          idempotent: true,

          released: true,

          cancelledBeforeProvider: true,
        };
      }

      let releaseResult;

      if (withdrawal.status === "pending") {
        releaseResult = await WalletService.cancelPendingExternalDebit(
          {
            transactionId: withdrawal._id,

            cancellationReason: reason,

            metadata: {
              ...cleanMetadata,

              withdrawalReleaseSource: "wallet_withdrawal_service",
            },

            currentTime: restoredAt,
          },
          {
            session,
          }
        );
      } else if (withdrawal.status === "processing") {
        if (
          !WalletWithdrawalService.hasDefinitiveProviderFailureEvidence(withdrawal, cleanMetadata)
        ) {
          throw WalletWithdrawalService.createError({
            message:
              "Provider-processing withdrawal cannot release reserved funds without definitive Paystack failure or reversal evidence.",
            code: "WITHDRAWAL_PROVIDER_FAILURE_NOT_CONFIRMED",
            statusCode: 409,
          });
        }

        releaseResult = await WalletService.markPendingExternalDebitFailed(
          {
            transactionId: withdrawal._id,

            failureReason: reason,

            paystackTransferCode:
              WalletWithdrawalService.cleanString(withdrawal.paystackTransferCode) ||
              WalletWithdrawalService.cleanString(paystackTransferCode) ||
              WalletWithdrawalService.cleanString(cleanMetadata.paystackTransferCode) ||
              WalletWithdrawalService.cleanString(cleanMetadata.transferCode),

            providerEventId: eventId,

            metadata: {
              ...cleanMetadata,

              withdrawalReleaseSource: "wallet_withdrawal_service",
            },

            currentTime: restoredAt,
          },
          {
            session,
          }
        );
      } else {
        throw WalletWithdrawalService.createError({
          message: `A ${withdrawal.status} withdrawal cannot release reserved funds.`,
          code: "WITHDRAWAL_RELEASE_STATE_INVALID",
          statusCode: 409,
        });
      }

      const releasedTransaction = releaseResult.transaction;

      const wallet = releaseResult.wallet;

      const ownerType = WalletWithdrawalService.getWithdrawalOwnerType(releasedTransaction);

      const recipientUser = WalletWithdrawalService.getWithdrawalRecipientUser(releasedTransaction);

      const employer = WalletWithdrawalService.getWithdrawalEmployerProfileId(releasedTransaction);

      if (
        releaseResult.idempotent !== true &&
        ownerType === "employer" &&
        recipientUser &&
        employer
      ) {
        await NotificationService.notifyEmployerWithdrawalReversed(
          {
            recipientUser,

            employer,

            wallet,

            transaction: releasedTransaction,

            amount: releasedTransaction.amount,

            currency: releasedTransaction.currency,

            metadata: {
              source: "wallet_withdrawal_service",

              withdrawalTransactionId: String(releasedTransaction._id),

              releaseStatus: releasedTransaction.status,
            },
          },
          {
            session,
          }
        );
      }

      return {
        wallet,

        transaction: releasedTransaction,

        originalTransaction: releasedTransaction,

        idempotent: releaseResult.idempotent === true,

        released: true,

        cancelledBeforeProvider: releasedTransaction.status === "cancelled",
      };
    });
  }
}

module.exports = WalletWithdrawalService;
