// services/walletWithdrawalService.js

const EmployerProfile = require("../models/EmployerProfile");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const BankAccount = require("../models/BankAccount");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");

const WalletService = require("./walletService");
const NotificationService = require("./notificationService");

const money = require("../utils/money");

class WalletWithdrawalService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Clean owner type ---------- */
  static cleanOwnerType(ownerType) {
    const cleanOwnerType = WalletWithdrawalService.cleanString(ownerType)?.toLowerCase();

    if (!["employer", "professional"].includes(cleanOwnerType)) {
      throw new Error("Withdrawal owner type must be employer or professional.");
    }

    return cleanOwnerType;
  }

  /* ---------- Get owner config ---------- */
  static getOwnerConfig(ownerType) {
    const cleanOwnerType = WalletWithdrawalService.cleanOwnerType(ownerType);

    if (cleanOwnerType === "employer") {
      return {
        ownerType: "employer",
        profileModel: EmployerProfile,
        profileLabel: "Employer profile",
        bankAccountField: "employer",
        walletCreatorName: "createEmployerWalletIfMissing",
        profileMetadataKey: "employerProfileId",
        defaultDescription: "Employer wallet withdrawal requested.",
        source: "employer_withdrawal_request",
      };
    }

    return {
      ownerType: "professional",
      profileModel: ProfessionalProfile,
      profileLabel: "Professional profile",
      bankAccountField: "professional",
      walletCreatorName: "createProfessionalWalletIfMissing",
      profileMetadataKey: "professionalProfileId",
      defaultDescription: "Professional wallet withdrawal requested.",
      source: "professional_withdrawal_request",
    };
  }

  /* ---------- Get generic owner profile ---------- */
  static async getProfile({ ownerType, ownerProfileId }, options = {}) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    if (!ownerProfileId) {
      throw new Error(`${config.profileLabel} ID is required.`);
    }

    const query = config.profileModel.findById(ownerProfileId);

    if (options.session) {
      query.session(options.session);
    }

    const profile = await query;

    if (!profile) {
      throw new Error(`${config.profileLabel} not found.`);
    }

    return profile;
  }

  /* ---------- Get employer profile ---------- */
  static async getEmployerProfile(employerProfileId, options = {}) {
    return WalletWithdrawalService.getProfile(
      {
        ownerType: "employer",
        ownerProfileId: employerProfileId,
      },
      options
    );
  }

  /* ---------- Get professional profile ---------- */
  static async getProfessionalProfile(professionalProfileId, options = {}) {
    return WalletWithdrawalService.getProfile(
      {
        ownerType: "professional",
        ownerProfileId: professionalProfileId,
      },
      options
    );
  }

  /* ---------- Get generic active withdrawal bank account ---------- */
  static async getActiveBankAccount(
    { ownerType, ownerProfileId, bankAccountId = null },
    options = {}
  ) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    if (!ownerProfileId) {
      throw new Error(`${config.profileLabel} ID is required.`);
    }

    const filter = {
      ownerType: config.ownerType,
      [config.bankAccountField]: ownerProfileId,
      isActive: true,
    };

    if (bankAccountId) {
      filter._id = bankAccountId;
    }

    const query = BankAccount.findOne(filter);

    if (options.session) {
      query.session(options.session);
    }

    const bankAccount = await query;

    if (!bankAccount) {
      throw new Error("Active withdrawal bank account not found.");
    }

    if (bankAccount.verificationStatus !== "verified") {
      throw new Error("Withdrawal bank account must be verified before withdrawal.");
    }

    return bankAccount;
  }

  /* ---------- Get active employer withdrawal bank account ---------- */
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

  /* ---------- Get active professional withdrawal bank account ---------- */
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

  /* ---------- Get or create owner wallet ---------- */
  static async getOrCreateOwnerWallet({ ownerType, profile }, options = {}) {
    const config = WalletWithdrawalService.getOwnerConfig(ownerType);

    const walletCreator = WalletService[config.walletCreatorName];

    if (typeof walletCreator !== "function") {
      throw new Error(`${config.walletCreatorName} is not available on WalletService.`);
    }

    return walletCreator.call(WalletService, profile, options);
  }

  /* ---------- Build withdrawal idempotency key ---------- */
  static buildWithdrawalIdempotencyKey({ ownerType, ownerProfileId, requestReference }) {
    const cleanOwnerType = WalletWithdrawalService.cleanOwnerType(ownerType);

    if (!ownerProfileId) {
      throw new Error("Owner profile ID is required for withdrawal idempotency.");
    }

    const cleanRequestReference = WalletWithdrawalService.cleanString(requestReference);

    if (!cleanRequestReference) {
      throw new Error("Withdrawal request reference is required.");
    }

    return `withdrawal:${cleanOwnerType}:${ownerProfileId}:${cleanRequestReference}`;
  }

  /* ---------- Validate withdrawal amount against wallet ---------- */
  static validateWithdrawalAmount({ wallet, amount }) {
    const normalizedAmount = money.normalizePositiveMinorUnitAmount(amount, "Withdrawal amount");

    const availableBalance = money.normalizeMinorUnitAmount(
      wallet.availableBalance || 0,
      "Available balance"
    );

    if (wallet.minimumWithdrawalAmount && normalizedAmount < wallet.minimumWithdrawalAmount) {
      throw new Error("Withdrawal amount is below the minimum withdrawal amount.");
    }

    if (availableBalance < normalizedAmount) {
      throw new Error("Insufficient available wallet balance.");
    }

    return normalizedAmount;
  }

  /* ---------- Validate provider fee and net amount ---------- */
  static validateWithdrawalFeeAmounts({ amount, providerFee = 0, netAmount = null }) {
    const normalizedProviderFee = money.normalizeMinorUnitAmount(providerFee || 0, "Provider fee");

    const normalizedNetAmount =
      netAmount === null || netAmount === undefined
        ? amount
        : money.normalizeMinorUnitAmount(netAmount, "Net amount");

    if (normalizedProviderFee > amount) {
      throw new Error("Provider fee cannot be greater than withdrawal amount.");
    }

    if (normalizedNetAmount > amount) {
      throw new Error("Net amount cannot be greater than withdrawal amount.");
    }

    return {
      normalizedProviderFee,
      normalizedNetAmount,
    };
  }

  /* ---------- Get withdrawal owner type ---------- */
  static getWithdrawalOwnerType(withdrawalTransaction) {
    return WalletWithdrawalService.cleanString(
      withdrawalTransaction.metadata?.ownerType || withdrawalTransaction.ownerType
    )?.toLowerCase();
  }

  /* ---------- Get withdrawal recipient user ---------- */
  static getWithdrawalRecipientUser(withdrawalTransaction) {
    return (
      withdrawalTransaction.initiatedBy?.userId ||
      withdrawalTransaction.user ||
      withdrawalTransaction.metadata?.recipientUser ||
      withdrawalTransaction.metadata?.userId ||
      null
    );
  }

  /* ---------- Get withdrawal employer profile ID ---------- */
  static getWithdrawalEmployerProfileId(withdrawalTransaction) {
    return (
      withdrawalTransaction.metadata?.employerProfileId || withdrawalTransaction.employer || null
    );
  }

  /* ---------- Create generic withdrawal request ---------- */
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
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const config = WalletWithdrawalService.getOwnerConfig(ownerType);

      const cleanRequestReference = WalletWithdrawalService.cleanString(requestReference);

      if (!cleanRequestReference) {
        throw new Error("Withdrawal request reference is required.");
      }

      const profile = await WalletWithdrawalService.getProfile(
        {
          ownerType: config.ownerType,
          ownerProfileId,
        },
        {
          session,
        }
      );

      const bankAccount = await WalletWithdrawalService.getActiveBankAccount(
        {
          ownerType: config.ownerType,
          ownerProfileId: profile._id,
          bankAccountId,
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
        requestReference: cleanRequestReference,
      });

      const withdrawalResult = await WalletService.debitWallet(
        {
          walletId: wallet._id,

          amount: normalizedAmount,

          type: "withdrawal",
          purpose: "withdrawal",
          paymentRail: "paystack_transfer",
          provider: "paystack",

          status: "processing",
          paystackStatus: "pending",

          idempotencyKey,

          bankAccount: bankAccount._id,

          providerFee: normalizedProviderFee,
          netAmount: normalizedNetAmount,

          initiatedBy: {
            role: config.ownerType,
            userId,
          },

          description: description || config.defaultDescription,

          metadata: {
            ...metadata,
            source: config.source,
            ownerType: config.ownerType,
            [config.profileMetadataKey]: String(profile._id),
            bankAccountId: String(bankAccount._id),
            requestReference: cleanRequestReference,
          },
        },
        {
          session,
        }
      );

      if (config.ownerType === "employer") {
        await NotificationService.notifyEmployerWithdrawalSubmitted(
          {
            recipientUser: profile.user,
            employer: profile._id,
            wallet: withdrawalResult.wallet,
            transaction: withdrawalResult.transaction,

            amount: withdrawalResult.transaction.amount,
            currency: withdrawalResult.transaction.currency,

            metadata: {
              source: "wallet_withdrawal_service",
              ownerType: config.ownerType,
              withdrawalTransactionId: String(withdrawalResult.transaction._id),
            },
          },
          {
            session,
          }
        );
      }

      return withdrawalResult;
    });
  }

  /* ---------- Create employer withdrawal request ---------- */
  static async createEmployerWithdrawalRequest(
    {
      userId,
      employerProfileId,
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
    return WalletWithdrawalService.createWithdrawalRequest(
      {
        ownerType: "employer",
        userId,
        ownerProfileId: employerProfileId,
        bankAccountId,

        amount,

        requestReference,

        providerFee,
        netAmount,

        description,
        metadata,
      },
      options
    );
  }

  /* ---------- Create professional withdrawal request ---------- */
  static async createProfessionalWithdrawalRequest(
    {
      userId,
      professionalProfileId,
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
    return WalletWithdrawalService.createWithdrawalRequest(
      {
        ownerType: "professional",
        userId,
        ownerProfileId: professionalProfileId,
        bankAccountId,

        amount,

        requestReference,

        providerFee,
        netAmount,

        description,
        metadata,
      },
      options
    );
  }

  /* ---------- Mark withdrawal as submitted to provider ---------- */
  static async markWithdrawalSubmittedToProvider(
    { withdrawalTransactionId, paystackTransferCode, metadata = {} },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const cleanPaystackTransferCode = WalletWithdrawalService.cleanString(paystackTransferCode);

      if (!cleanPaystackTransferCode) {
        throw new Error("Paystack transfer code is required.");
      }

      const withdrawalTransaction =
        await Transaction.findById(withdrawalTransactionId).session(session);

      if (!withdrawalTransaction) {
        throw new Error("Withdrawal transaction not found.");
      }

      if (withdrawalTransaction.type !== "withdrawal") {
        throw new Error("Transaction is not a withdrawal.");
      }

      if (withdrawalTransaction.status === "completed") {
        return {
          transaction: withdrawalTransaction,
          alreadyCompleted: true,
        };
      }

      if (withdrawalTransaction.status === "reversed") {
        throw new Error("Withdrawal has already been reversed.");
      }

      withdrawalTransaction.paystackTransferCode = cleanPaystackTransferCode;
      withdrawalTransaction.paystackStatus = "pending";
      withdrawalTransaction.status = "processing";
      withdrawalTransaction.metadata = {
        ...(withdrawalTransaction.metadata || {}),
        ...metadata,
        providerSubmissionAt: new Date(),
      };

      await withdrawalTransaction.save({ session });

      return {
        transaction: withdrawalTransaction,
      };
    });
  }

  /* ---------- Mark withdrawal as completed ---------- */
  static async markWithdrawalCompleted({ withdrawalTransactionId, metadata = {} }, options = {}) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const withdrawalTransaction =
        await Transaction.findById(withdrawalTransactionId).session(session);

      if (!withdrawalTransaction) {
        throw new Error("Withdrawal transaction not found.");
      }

      if (withdrawalTransaction.type !== "withdrawal") {
        throw new Error("Transaction is not a withdrawal.");
      }

      if (withdrawalTransaction.status === "completed") {
        return {
          transaction: withdrawalTransaction,
          alreadyCompleted: true,
        };
      }

      if (withdrawalTransaction.status === "reversed") {
        throw new Error("Reversed withdrawal cannot be marked as completed.");
      }

      if (withdrawalTransaction.status !== "processing") {
        throw new Error("Only processing withdrawals can be marked as completed.");
      }

      if (!withdrawalTransaction.paystackTransferCode) {
        throw new Error("Withdrawal cannot be completed without a Paystack transfer code.");
      }

      const wallet = await Wallet.findById(withdrawalTransaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Wallet not found for completed withdrawal.");
      }

      withdrawalTransaction.status = "completed";
      withdrawalTransaction.paystackStatus = "success";
      withdrawalTransaction.metadata = {
        ...(withdrawalTransaction.metadata || {}),
        ...metadata,
        providerCompletedAt: new Date(),
      };

      await withdrawalTransaction.save({ session });

      const ownerType = WalletWithdrawalService.getWithdrawalOwnerType(withdrawalTransaction);
      const recipientUser =
        WalletWithdrawalService.getWithdrawalRecipientUser(withdrawalTransaction);
      const employer =
        WalletWithdrawalService.getWithdrawalEmployerProfileId(withdrawalTransaction);

      if (ownerType === "employer" && recipientUser && employer) {
        await NotificationService.notifyEmployerWithdrawalCompleted(
          {
            recipientUser,
            employer,
            wallet,
            transaction: withdrawalTransaction,

            amount: withdrawalTransaction.amount,
            currency: withdrawalTransaction.currency,

            metadata: {
              source: "wallet_withdrawal_service",
              withdrawalTransactionId: String(withdrawalTransaction._id),
            },
          },
          {
            session,
          }
        );
      }

      return {
        transaction: withdrawalTransaction,
      };
    });
  }

  /* ---------- Reverse failed withdrawal ---------- */
  static async reverseFailedWithdrawal(
    {
      withdrawalTransactionId,
      reversalReason = "Withdrawal failed. Wallet balance reversed.",
      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const withdrawalTransaction =
        await Transaction.findById(withdrawalTransactionId).session(session);

      if (!withdrawalTransaction) {
        throw new Error("Withdrawal transaction not found.");
      }

      if (withdrawalTransaction.type !== "withdrawal") {
        throw new Error("Transaction is not a withdrawal.");
      }

      if (withdrawalTransaction.status === "completed") {
        throw new Error("Completed withdrawal cannot be reversed automatically.");
      }

      const existingReversal = await Transaction.findOne({
        type: "withdrawal_reversal",
        relatedTransaction: withdrawalTransaction._id,
      }).session(session);

      if (existingReversal) {
        const wallet = await Wallet.findById(existingReversal.wallet).session(session);

        return {
          wallet,
          transaction: existingReversal,
          originalTransaction: withdrawalTransaction,
          idempotent: true,
        };
      }

      const wallet = await Wallet.findById(withdrawalTransaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Wallet not found for withdrawal reversal.");
      }

      WalletService.assertWalletIsActive(wallet);

      const reversalResult = await WalletService.creditWallet(
        {
          walletId: wallet._id,

          amount: withdrawalTransaction.amount,

          type: "withdrawal_reversal",
          purpose: "withdrawal_reversal",
          paymentRail: "system_action",
          provider: "internal",

          status: "completed",

          idempotencyKey: `withdrawal_reversal:${withdrawalTransaction.reference}`,

          bankAccount: withdrawalTransaction.bankAccount,
          relatedTransaction: withdrawalTransaction._id,

          initiatedBy: {
            role: "system",
            userId: null,
          },

          description: reversalReason,

          metadata: {
            ...metadata,
            source: "withdrawal_reversal",
            ownerType: withdrawalTransaction.metadata?.ownerType || null,
            originalWithdrawalTransactionId: String(withdrawalTransaction._id),
            originalWithdrawalReference: withdrawalTransaction.reference,
          },
        },
        {
          session,
        }
      );

      withdrawalTransaction.status = "reversed";
      withdrawalTransaction.paystackStatus = "reversed";
      withdrawalTransaction.reversalReason = reversalReason;
      withdrawalTransaction.relatedTransaction = reversalResult.transaction._id;
      withdrawalTransaction.metadata = {
        ...(withdrawalTransaction.metadata || {}),
        reversedBy: "walletWithdrawalService",
        reversedAt: new Date(),
      };

      await withdrawalTransaction.save({ session });

      const ownerType = WalletWithdrawalService.getWithdrawalOwnerType(withdrawalTransaction);
      const recipientUser =
        WalletWithdrawalService.getWithdrawalRecipientUser(withdrawalTransaction);
      const employer =
        WalletWithdrawalService.getWithdrawalEmployerProfileId(withdrawalTransaction);

      if (ownerType === "employer" && recipientUser && employer) {
        await NotificationService.notifyEmployerWithdrawalReversed(
          {
            recipientUser,
            employer,
            wallet: reversalResult.wallet,
            transaction: reversalResult.transaction,

            amount: withdrawalTransaction.amount,
            currency: withdrawalTransaction.currency,

            metadata: {
              source: "wallet_withdrawal_service",
              withdrawalTransactionId: String(withdrawalTransaction._id),
              reversalTransactionId: String(reversalResult.transaction._id),
            },
          },
          {
            session,
          }
        );
      }

      return {
        wallet: reversalResult.wallet,
        transaction: reversalResult.transaction,
        originalTransaction: withdrawalTransaction,
        idempotent: false,
      };
    });
  }
}

module.exports = WalletWithdrawalService;
