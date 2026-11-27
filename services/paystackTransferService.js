// services/paystackTransferService.js

const BankAccount = require("../models/BankAccount");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const FinancialObligation = require("../models/FinancialObligation");

const PaystackService = require("./paystackService");
const WalletService = require("./walletService");
const WalletWithdrawalService = require("./walletWithdrawalService");

class PaystackTransferService {
  /* ---------- NORMALIZATION ---------- */

  static cleanString(value) {
    return String(value || "").trim() || null;
  }

  static cleanAccountNumber(value) {
    return (
      String(value || "")
        .replace(/\s+/g, "")
        .trim() || null
    );
  }

  static cleanCurrency(value) {
    const currency = String(value ?? "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Withdrawal currency must be a valid three-letter currency code.");
    }

    return currency;
  }

  static cleanCountryCode(value) {
    const countryCode = String(value ?? "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error("Withdrawal country code must contain exactly two letters.");
    }

    return countryCode;
  }

  static normalizeCurrentTime(value) {
    const currentTime =
      value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(currentTime.getTime())) {
      throw new Error("Current time is invalid.");
    }

    return currentTime;
  }

  static assertNoExternalProviderSession(options = {}) {
    if (options.session) {
      throw new Error(
        "Paystack Transfer orchestration cannot run inside a caller-managed MongoDB transaction."
      );
    }
  }

  /* ---------- PROVIDER ENVIRONMENT ---------- */

  static getRequiredProviderMode() {
    const mode = PaystackService.getMode();

    if (!["test", "live"].includes(mode)) {
      throw new Error("A configured Paystack environment is required.");
    }

    return mode;
  }

  static assertOriginalProviderMode(withdrawalTransaction) {
    const mode = withdrawalTransaction.metadata?.paystackMode;

    if (!["test", "live"].includes(mode)) {
      throw new Error(
        "Original withdrawal Paystack environment is missing. Manual reconciliation is required."
      );
    }

    if (mode !== PaystackTransferService.getRequiredProviderMode()) {
      throw new Error("Withdrawal belongs to another Paystack environment.");
    }

    return mode;
  }

  /* ---------- HISTORICAL FINANCIAL OBLIGATION ---------- */

  static async getHistoricalObligation(withdrawalTransaction) {
    const obligation = await FinancialObligation.findOne({
      type: "closed_wallet_withdrawal_reversal",
      withdrawalTransaction: withdrawalTransaction._id,
    });

    const metadata = withdrawalTransaction.metadata || {};

    const marked =
      metadata.providerReversalDisposition === "financial_obligation" ||
      Boolean(metadata.financialObligationId);

    if (!obligation && !marked) {
      return null;
    }

    if (
      !obligation ||
      metadata.providerReversalDisposition !== "financial_obligation" ||
      metadata.providerReversalStatus !== "reversed" ||
      String(metadata.financialObligationId) !== String(obligation._id) ||
      withdrawalTransaction.status !== "completed" ||
      String(obligation.wallet) !== String(withdrawalTransaction.wallet) ||
      obligation.providerReference !== withdrawalTransaction.paystackTransferReference ||
      obligation.providerTransferCode !== withdrawalTransaction.paystackTransferCode ||
      obligation.providerMode !== metadata.paystackMode ||
      obligation.currency !== withdrawalTransaction.currency ||
      obligation.amount !== withdrawalTransaction.amount ||
      obligation.providerAmount !== PaystackTransferService.getPayoutAmount(withdrawalTransaction)
    ) {
      throw new Error(
        "Historical withdrawal disposition is inconsistent. Manual reconciliation is required."
      );
    }

    return obligation;
  }

  static assertNoDispositionMetadata(metadata = {}) {
    for (const field of [
      "financialObligationId",
      "providerReversalDisposition",
      "providerReversalStatus",
      "providerReversalVerifiedAt",
      "reversalTransactionId",
    ]) {
      if (Object.prototype.hasOwnProperty.call(metadata || {}, field)) {
        throw new Error(`Transfer metadata cannot supply ${field}.`);
      }
    }
  }

  static historicalObligationResult(transaction, financialObligation) {
    return {
      transaction,
      financialObligation,
      historicalFinancialObligation: true,
      persisted: true,
      terminal: true,
      completed: false,
      reversed: true,
      submitted: false,
      idempotent: true,
    };
  }

  /* ---------- TRANSFER REFERENCE / MARKET ---------- */

  static buildTransferReference(withdrawalTransaction) {
    if (!withdrawalTransaction?._id) {
      throw new Error("Withdrawal Transaction is required to build Transfer reference.");
    }

    const reference = `lq_withdrawal_${String(withdrawalTransaction._id)}`.toLowerCase();

    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) {
      throw new Error("Generated Paystack withdrawal Transfer reference is invalid.");
    }

    return reference;
  }

  static resolveTransferRecipientType({ countryCode, currency }) {
    const normalizedCountryCode = PaystackTransferService.cleanCountryCode(countryCode);

    const normalizedCurrency = PaystackTransferService.cleanCurrency(currency);

    const recipientTypes = {
      "NG:NGN": "nuban",
      "GH:GHS": "ghipss",
      "KE:KES": "kepss",
      "KE:USD": "kepss",
      "ZA:ZAR": "basa",
    };

    const recipientType = recipientTypes[`${normalizedCountryCode}:${normalizedCurrency}`] || null;

    if (!recipientType) {
      throw new Error(
        `Paystack bank withdrawal Transfer is not configured for ${normalizedCountryCode}/${normalizedCurrency}.`
      );
    }

    return recipientType;
  }

  /* ---------- PROVIDER OUTCOME ---------- */

  static normalizeTransferOutcome(value) {
    const rawStatus = PaystackTransferService.cleanString(value?.status)?.toLowerCase() || null;

    let status = "ambiguous";

    if (["success", "successful", "completed"].includes(rawStatus)) {
      status = "success";
    } else if (["pending", "queued", "processing", "received"].includes(rawStatus)) {
      status = "pending";
    } else if (rawStatus === "otp") {
      status = "otp";
    } else if (["failed", "failure", "rejected", "abandoned", "blocked"].includes(rawStatus)) {
      status = "failed";
    } else if (rawStatus === "reversed") {
      status = "reversed";
    }

    const amountValue = value?.amount == null ? null : Number(value.amount);

    return {
      status,

      rawStatus,

      domain: PaystackTransferService.cleanString(value?.domain),

      reference: PaystackTransferService.cleanString(value?.reference),

      transferCode: PaystackTransferService.cleanString(
        value?.transferCode || value?.transfer_code
      ),

      recipientCode: PaystackTransferService.cleanString(
        value?.recipientCode || value?.recipient_code
      ),

      amount:
        amountValue !== null && Number.isSafeInteger(amountValue) && amountValue >= 0
          ? amountValue
          : null,

      currency: value?.currency ? PaystackTransferService.cleanCurrency(value.currency) : null,

      providerTransferId: value?.id == null ? null : String(value.id),

      raw: value?.raw || value || null,
    };
  }

  static getPayoutAmount(transaction) {
    const amount = transaction.netAmount ?? transaction.amount;

    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > transaction.amount) {
      throw new Error(
        "Withdrawal bank payout must be a positive safe integer no greater than the wallet debit."
      );
    }

    return amount;
  }

  static assertBankAccountMatches(transaction, bankAccount) {
    const owner = PaystackTransferService.getWithdrawalOwnerContext(transaction);

    const profileId =
      owner.ownerType === "employer" ? owner.employerProfileId : owner.professionalProfileId;

    if (
      String(bankAccount?._id) !== String(transaction.bankAccount) ||
      bankAccount.ownerType !== owner.ownerType ||
      String(bankAccount[owner.ownerType]) !== String(profileId)
    ) {
      throw new Error("Withdrawal bank account does not match the recorded owner and account.");
    }
  }

  static assertTransferOutcomeMatches({ withdrawalTransaction, outcome }) {
    if (!withdrawalTransaction || !outcome) {
      throw new Error("Withdrawal Transaction and Paystack Transfer outcome are required.");
    }

    const originalMode = PaystackTransferService.assertOriginalProviderMode(withdrawalTransaction);

    if (outcome.domain !== originalMode) {
      throw new Error(
        "Paystack Transfer response has a missing or conflicting environment. Reconcile the original reference."
      );
    }

    const expectedReference = PaystackTransferService.cleanString(
      withdrawalTransaction.paystackTransferReference
    );

    if (!expectedReference) {
      throw new Error("Withdrawal Transaction has no deterministic Paystack Transfer reference.");
    }

    if (!outcome.reference || outcome.reference !== expectedReference) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer reference.");
    }

    if (
      outcome.amount !== null &&
      outcome.amount !== PaystackTransferService.getPayoutAmount(withdrawalTransaction)
    ) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer amount.");
    }

    if (
      outcome.currency &&
      outcome.currency !== PaystackTransferService.cleanCurrency(withdrawalTransaction.currency)
    ) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer currency.");
    }

    if (
      outcome.transferCode &&
      withdrawalTransaction.paystackTransferCode &&
      outcome.transferCode !== withdrawalTransaction.paystackTransferCode
    ) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer code.");
    }

    const expectedRecipient = withdrawalTransaction.metadata?.paystackRecipientCode;

    if (outcome.recipientCode && expectedRecipient && outcome.recipientCode !== expectedRecipient) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer recipient.");
    }

    return true;
  }

  static isDefinitiveTransferSubmissionFailure(_error) {
    // HTTP errors do not establish final Transfer status.
    return false;
  }

  /* ---------- LOADERS ---------- */

  static async getWithdrawalTransaction(withdrawalTransactionId, options = {}) {
    if (!withdrawalTransactionId) {
      throw new Error("Withdrawal Transaction ID is required.");
    }

    const query = Transaction.findById(withdrawalTransactionId);

    if (options.session) {
      query.session(options.session);
    }

    const withdrawalTransaction = await query;

    if (!withdrawalTransaction) {
      throw new Error("Withdrawal Transaction not found.");
    }

    if (withdrawalTransaction.type !== "withdrawal") {
      throw new Error("Transaction is not a withdrawal.");
    }

    if (withdrawalTransaction.direction !== "debit") {
      throw new Error("Withdrawal Transaction must be a debit.");
    }

    if (withdrawalTransaction.paymentRail !== "paystack_transfer") {
      throw new Error("Withdrawal Transaction must use Paystack Transfer.");
    }

    if (withdrawalTransaction.provider !== "paystack") {
      throw new Error("Withdrawal Transaction must use Paystack as provider.");
    }

    if (!withdrawalTransaction.bankAccount) {
      throw new Error("Withdrawal Transaction must reference a bank account.");
    }

    return withdrawalTransaction;
  }

  static async getBankAccount(bankAccountId, options = {}) {
    if (!bankAccountId) {
      throw new Error("Bank account ID is required.");
    }

    const query = BankAccount.findById(bankAccountId).select(
      "+accountNumber +paystackBankCode +paystackRecipientCode"
    );

    if (options.session) {
      query.session(options.session);
    }

    const bankAccount = await query;

    if (!bankAccount) {
      throw new Error("Withdrawal bank account not found.");
    }

    if (!bankAccount.isActive) {
      throw new Error("Withdrawal bank account is no longer active.");
    }

    if (bankAccount.verificationStatus !== "verified") {
      throw new Error("Withdrawal bank account must be verified before Transfer.");
    }

    if (!PaystackTransferService.cleanAccountNumber(bankAccount.accountNumber)) {
      throw new Error("Withdrawal bank account number is required.");
    }

    if (!PaystackTransferService.cleanString(bankAccount.accountName)) {
      throw new Error("Withdrawal bank account name is required.");
    }

    if (!PaystackTransferService.cleanString(bankAccount.paystackBankCode)) {
      throw new Error("Paystack bank code is required before Transfer.");
    }

    return bankAccount;
  }

  /* ---------- DURABLE TRANSFER REFERENCE ---------- */

  static async ensureWithdrawalTransferReference(withdrawalTransactionId) {
    return WalletService.runWithOptionalTransaction({}, async (session) => {
      const withdrawalTransaction = await PaystackTransferService.getWithdrawalTransaction(
        withdrawalTransactionId,
        { session }
      );

      const directReference = PaystackTransferService.cleanString(
        withdrawalTransaction.paystackTransferReference
      );

      const metadataReference = PaystackTransferService.cleanString(
        withdrawalTransaction.metadata?.paystackTransferReference
      );

      if (directReference && metadataReference && directReference !== metadataReference) {
        throw new Error(
          "Withdrawal Transaction contains conflicting Paystack Transfer references. Manual reconciliation is required."
        );
      }

      const existingReference = directReference || metadataReference;

      if (existingReference) {
        if (!/^[a-z0-9_-]{16,50}$/.test(existingReference)) {
          throw new Error("Stored Paystack withdrawal Transfer reference is invalid.");
        }

        if (!directReference) {
          withdrawalTransaction.paystackTransferReference = existingReference;

          await withdrawalTransaction.save({
            session,
          });
        }

        return {
          transaction: withdrawalTransaction,
          transferReference: existingReference,
          created: false,
        };
      }

      if (withdrawalTransaction.status !== "pending") {
        throw new Error(
          "A provider-bound withdrawal without a Transfer reference requires manual reconciliation."
        );
      }

      const transferReference =
        PaystackTransferService.buildTransferReference(withdrawalTransaction);

      withdrawalTransaction.paystackTransferReference = transferReference;

      withdrawalTransaction.metadata = {
        ...(withdrawalTransaction.metadata || {}),
        paystackTransferReference: transferReference,
      };

      await withdrawalTransaction.save({
        session,
      });

      return {
        transaction: withdrawalTransaction,
        transferReference,
        created: true,
      };
    });
  }

  /* ---------- TRANSFER RECIPIENT ---------- */

  static async createTransferRecipient({ bankAccount, countryCode, currency, metadata = {} }) {
    const accountNumber = PaystackTransferService.cleanAccountNumber(bankAccount.accountNumber);

    const accountName = PaystackTransferService.cleanString(bankAccount.accountName);

    const bankCode = PaystackTransferService.cleanString(bankAccount.paystackBankCode);

    const cleanCurrency = PaystackTransferService.cleanCurrency(currency);

    if (!accountNumber) {
      throw new Error("Account number is required to create Transfer recipient.");
    }

    if (!accountName) {
      throw new Error("Account name is required to create Transfer recipient.");
    }

    if (!bankCode) {
      throw new Error("Paystack bank code is required to create Transfer recipient.");
    }

    const recipientType = PaystackTransferService.resolveTransferRecipientType({
      countryCode,
      currency: cleanCurrency,
    });

    return PaystackService.createTransferRecipient({
      type: recipientType,
      name: accountName,
      accountNumber,
      bankCode,
      currency: cleanCurrency,
      metadata,
    });
  }

  static async ensureTransferRecipient({ bankAccount, countryCode, currency, metadata = {} }) {
    const mode = PaystackTransferService.getRequiredProviderMode();

    // Reconfirm the recipient in the current environment.

    const recipient = await PaystackTransferService.createTransferRecipient({
      bankAccount,
      countryCode,
      currency,
      metadata,
    });

    const recipientCode = PaystackTransferService.cleanString(recipient?.recipientCode);

    if (!recipientCode) {
      throw new Error("Paystack Transfer recipient code was not returned.");
    }

    if (
      PaystackTransferService.getRequiredProviderMode() !== mode ||
      (recipient.raw?.domain && recipient.raw.domain !== mode) ||
      recipient.accountNumber !==
        PaystackTransferService.cleanAccountNumber(bankAccount.accountNumber) ||
      recipient.bankCode !== PaystackTransferService.cleanString(bankAccount.paystackBankCode) ||
      recipient.currency !== PaystackTransferService.cleanCurrency(currency) ||
      recipient.active !== true ||
      recipient.isDeleted === true
    ) {
      throw new Error("Transfer recipient identity or environment could not be confirmed.");
    }

    bankAccount.paystackRecipientCode = recipientCode;

    await bankAccount.save();

    return {
      bankAccount,
      recipient,
      recipientCode,
      created: true,
    };
  }

  /* ---------- WITHDRAWAL CONTEXT ---------- */

  static getWithdrawalOwnerContext(withdrawalTransaction) {
    const metadata = withdrawalTransaction?.metadata || {};

    const ownerType =
      PaystackTransferService.cleanString(metadata.ownerType)?.toLowerCase() || null;

    const employerProfileId = PaystackTransferService.cleanString(metadata.employerProfileId);

    const professionalProfileId = PaystackTransferService.cleanString(
      metadata.professionalProfileId
    );

    if (!["employer", "professional"].includes(ownerType)) {
      throw new Error("Withdrawal Transaction must belong to an employer or professional.");
    }

    if (employerProfileId && professionalProfileId) {
      throw new Error(
        "Withdrawal Transaction cannot belong to both an employer and a professional."
      );
    }

    if (ownerType === "employer" && (!employerProfileId || professionalProfileId)) {
      throw new Error("Employer withdrawal contains an invalid owner identity.");
    }

    if (ownerType === "professional" && (!professionalProfileId || employerProfileId)) {
      throw new Error("Professional withdrawal contains an invalid owner identity.");
    }

    return {
      ownerType,
      employerProfileId,
      professionalProfileId,
    };
  }

  static buildTransferReason(withdrawalTransaction) {
    const { ownerType } = PaystackTransferService.getWithdrawalOwnerContext(withdrawalTransaction);

    return ownerType === "professional"
      ? "Loqum professional wallet withdrawal"
      : "Loqum employer wallet withdrawal";
  }

  static buildTransferMetadata({ withdrawalTransaction, bankAccount, transferReference }) {
    const { ownerType, employerProfileId, professionalProfileId } =
      PaystackTransferService.getWithdrawalOwnerContext(withdrawalTransaction);

    return {
      source: "loqum_withdrawal_transfer",

      withdrawalTransactionId: String(withdrawalTransaction._id),

      withdrawalReference: withdrawalTransaction.reference,

      paystackTransferReference: transferReference,

      ownerType,

      employerProfileId: employerProfileId || null,

      professionalProfileId: professionalProfileId || null,

      bankAccountId: String(bankAccount._id),
    };
  }

  /* ---------- OUTCOME PERSISTENCE ---------- */

  static async persistTransferOutcome({
    withdrawalTransactionId,
    outcome,
    recipientCode = null,
    recipientCreated = false,
    metadata = {},
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const withdrawalTransaction =
      await PaystackTransferService.getWithdrawalTransaction(withdrawalTransactionId);

    PaystackTransferService.assertNoDispositionMetadata(metadata);

    PaystackTransferService.assertTransferOutcomeMatches({
      withdrawalTransaction,
      outcome,
    });

    /* ---------- HISTORICAL DISPOSITION ---------- */

    const historicalObligation =
      await PaystackTransferService.getHistoricalObligation(withdrawalTransaction);

    if (historicalObligation) {
      if (outcome.status !== "reversed") {
        throw new Error(
          "Provider outcome conflicts with an existing historical withdrawal reversal."
        );
      }

      return PaystackTransferService.historicalObligationResult(
        withdrawalTransaction,
        historicalObligation
      );
    }

    /* ---------- CLOSED-WALLET REVERSAL ---------- */

    if (withdrawalTransaction.status === "completed" && outcome.status === "reversed") {
      const wallet = await Wallet.findById(withdrawalTransaction.wallet);

      if (!wallet) {
        throw new Error("Original withdrawal wallet was not found.");
      }

      if (wallet.status === "closed") {
        const error = new Error(
          "Closed-wallet reversal requires verified provider-event reconciliation."
        );

        error.code = "CLOSED_WALLET_REVERSAL_RECONCILIATION_REQUIRED";

        error.retryable = true;

        throw error;
      }
    }

    /* ---------- COMPLETED OUTCOME REPLAY ---------- */

    if (
      withdrawalTransaction.status === "reversed" ||
      (withdrawalTransaction.status === "completed" &&
        ["success", "pending", "otp"].includes(outcome.status))
    ) {
      return {
        transaction: withdrawalTransaction,
        outcome,
        persisted: true,
        idempotent: true,

        completed: withdrawalTransaction.status === "completed",

        reversed: withdrawalTransaction.status === "reversed",
      };
    }

    /* ---------- ORIGINAL RECIPIENT ---------- */

    const persistedRecipientCode = PaystackTransferService.cleanString(
      withdrawalTransaction.metadata?.paystackRecipientCode
    );

    const suppliedRecipientCode = PaystackTransferService.cleanString(recipientCode);

    const providerRecipientCode = PaystackTransferService.cleanString(outcome.recipientCode);

    if (!persistedRecipientCode) {
      throw new Error(
        "Withdrawal has no persisted Paystack Transfer recipient. Manual reconciliation is required."
      );
    }

    if (
      (suppliedRecipientCode && suppliedRecipientCode !== persistedRecipientCode) ||
      (providerRecipientCode && providerRecipientCode !== persistedRecipientCode)
    ) {
      throw new Error(
        "Paystack Transfer recipient conflicts with the persisted withdrawal recipient."
      );
    }

    const transferMetadata = {
      ...metadata,

      paystackTransferStatus: outcome.rawStatus || outcome.status,

      paystackTransferId:
        outcome.providerTransferId || withdrawalTransaction.metadata?.paystackTransferId || null,

      paystackTransferReference: withdrawalTransaction.paystackTransferReference,

      paystackTransferCode:
        outcome.transferCode || withdrawalTransaction.paystackTransferCode || null,

      paystackRecipientCode: persistedRecipientCode,

      paystackMode: withdrawalTransaction.metadata.paystackMode,

      paystackRecipientCreated:
        Boolean(withdrawalTransaction.metadata?.paystackRecipientCreated) ||
        Boolean(recipientCreated),

      providerObservedAt: normalizedCurrentTime,
    };

    /* ---------- PENDING / OTP ---------- */

    if (["pending", "otp"].includes(outcome.status)) {
      if (!outcome.transferCode) {
        return {
          transaction: withdrawalTransaction,
          outcome,
          persisted: false,
          unresolved: true,
          requiresOtp: outcome.status === "otp",
          reason: "provider_transfer_code_missing",
        };
      }

      const submittedResult = await WalletWithdrawalService.markWithdrawalSubmittedToProvider({
        withdrawalTransactionId: withdrawalTransaction._id,

        paystackTransferCode: outcome.transferCode,

        metadata: transferMetadata,
      });

      return {
        transaction: submittedResult.transaction,
        outcome,
        persisted: true,
        completed: false,
        requiresOtp: outcome.status === "otp",
      };
    }

    /* ---------- SUCCESSFUL TRANSFER ---------- */

    if (outcome.status === "success") {
      if (!outcome.transferCode) {
        throw new Error("Successful Paystack withdrawal Transfer has no Transfer code.");
      }

      await WalletWithdrawalService.markWithdrawalSubmittedToProvider({
        withdrawalTransactionId: withdrawalTransaction._id,

        paystackTransferCode: outcome.transferCode,

        metadata: transferMetadata,
      });

      const completedResult = await WalletWithdrawalService.markWithdrawalCompleted({
        withdrawalTransactionId: withdrawalTransaction._id,

        metadata: transferMetadata,
      });

      return {
        transaction: completedResult.transaction,
        outcome,
        persisted: true,
        completed: true,
        requiresOtp: false,
      };
    }

    /* ---------- FAILED / REVERSED TRANSFER ---------- */

    if (["failed", "reversed"].includes(outcome.status)) {
      if (outcome.transferCode && withdrawalTransaction.status === "processing") {
        await WalletWithdrawalService.markWithdrawalSubmittedToProvider({
          withdrawalTransactionId: withdrawalTransaction._id,

          paystackTransferCode: outcome.transferCode,

          metadata: transferMetadata,
        });
      }

      const reverse =
        withdrawalTransaction.status === "completed"
          ? WalletWithdrawalService.reverseCompletedWithdrawal
          : WalletWithdrawalService.reverseFailedWithdrawal;

      const reversedResult = await reverse({
        currentTime: normalizedCurrentTime,

        withdrawalTransactionId: withdrawalTransaction._id,

        reversalReason:
          outcome.status === "reversed"
            ? "Paystack reversed the withdrawal Transfer."
            : `Paystack withdrawal Transfer failed with status ${outcome.rawStatus || "failed"}.`,

        metadata: transferMetadata,
      });

      return {
        transaction: reversedResult.originalTransaction || withdrawalTransaction,

        reversalTransaction:
          reversedResult.originalTransaction?.status === "reversed"
            ? reversedResult.transaction
            : null,

        wallet: reversedResult.wallet || null,

        outcome,

        persisted: true,

        completed: false,

        failed: outcome.status === "failed",

        reversed: outcome.status === "reversed",

        requiresOtp: false,
      };
    }

    throw new Error("Ambiguous Paystack Transfer outcome cannot be persisted automatically.");
  }

  /* ---------- PREPARED TRANSFER SUBMISSION ---------- */

  static async submitPreparedWithdrawalTransfer({
    withdrawalTransaction,
    transferReference,
    bankAccount = null,
    recipientResult = null,
    reason = null,
    metadata = {},
    currentTime = new Date(),
    recoverySubmission = false,
  }) {
    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    if (!withdrawalTransaction?._id) {
      throw new Error("Withdrawal Transaction is required for Paystack Transfer submission.");
    }

    PaystackTransferService.assertNoDispositionMetadata(metadata);

    // Reload the authoritative withdrawal before submission.

    withdrawalTransaction = await PaystackTransferService.getWithdrawalTransaction(
      withdrawalTransaction._id
    );

    const historicalObligation =
      await PaystackTransferService.getHistoricalObligation(withdrawalTransaction);

    if (historicalObligation) {
      throw new Error("Historical withdrawal obligation cannot be submitted as a new Transfer.");
    }

    const originalMode = PaystackTransferService.assertOriginalProviderMode(withdrawalTransaction);

    const wallet = await Wallet.findById(withdrawalTransaction.wallet);

    WalletService.assertTransactionWallet(withdrawalTransaction, wallet);

    if (wallet.status === "closed") {
      throw new Error("Closed wallet cannot submit a Transfer.");
    }

    if (withdrawalTransaction.status !== "processing") {
      throw new Error(
        `Paystack Transfer can only be submitted while withdrawal is processing, not ${withdrawalTransaction.status}.`
      );
    }

    /* ---------- ORIGINAL TRANSFER REFERENCE ---------- */

    const persistedTransferReference = PaystackTransferService.cleanString(
      withdrawalTransaction.paystackTransferReference
    );

    const normalizedTransferReference = PaystackTransferService.cleanString(transferReference);

    if (!persistedTransferReference) {
      throw new Error("Withdrawal Transaction has no persisted Paystack Transfer reference.");
    }

    if (normalizedTransferReference && normalizedTransferReference !== persistedTransferReference) {
      throw new Error(
        "Paystack Transfer submission reference conflicts with the persisted withdrawal reference."
      );
    }

    const authoritativeTransferReference = persistedTransferReference;

    /* ---------- ORIGINAL BANK ACCOUNT ---------- */

    const resolvedBankAccount =
      bankAccount ||
      (await PaystackTransferService.getBankAccount(withdrawalTransaction.bankAccount));

    PaystackTransferService.assertBankAccountMatches(withdrawalTransaction, resolvedBankAccount);

    const authoritativeMetadata = {
      ...metadata,

      ...PaystackTransferService.buildTransferMetadata({
        withdrawalTransaction,

        bankAccount: resolvedBankAccount,

        transferReference: authoritativeTransferReference,
      }),

      recoverySubmission: Boolean(recoverySubmission),
    };

    /* ---------- ORIGINAL RECIPIENT ---------- */

    const persistedRecipient = PaystackTransferService.cleanString(
      withdrawalTransaction.metadata?.paystackRecipientCode
    );

    const resolvedRecipientResult = recipientResult || {
      bankAccount: resolvedBankAccount,
      recipientCode: persistedRecipient,
      created: false,
    };

    if (!persistedRecipient || resolvedRecipientResult.recipientCode !== persistedRecipient) {
      throw new Error(
        "Transfer recipient differs from the persisted provider boundary. Manual reconciliation is required."
      );
    }

    const transferReason =
      PaystackTransferService.cleanString(withdrawalTransaction.metadata?.paystackTransferReason) ||
      PaystackTransferService.cleanString(reason) ||
      PaystackTransferService.buildTransferReason(withdrawalTransaction);

    if (PaystackTransferService.getRequiredProviderMode() !== originalMode) {
      throw new Error("Paystack environment changed before submission.");
    }

    /* ---------- PROVIDER SUBMISSION ---------- */

    let transfer;

    try {
      transfer = await PaystackService.initiateTransfer({
        source: "balance",

        amount: PaystackTransferService.getPayoutAmount(withdrawalTransaction),

        recipient: resolvedRecipientResult.recipientCode,

        reference: authoritativeTransferReference,

        reason: transferReason,

        currency: PaystackTransferService.cleanCurrency(withdrawalTransaction.currency),
      });
    } catch (error) {
      // Preserve reservations until provider reconciliation.

      throw new Error(
        recoverySubmission
          ? "Paystack same-reference recovery submission could not be conclusively confirmed. The wallet reservation remains intact and the deterministic Transfer reference must be reconciled again."
          : "Paystack withdrawal Transfer submission could not be conclusively confirmed. The wallet reservation remains intact, and the next attempt must verify the deterministic Transfer reference before any new submission."
      );
    }

    const outcome = PaystackTransferService.normalizeTransferOutcome(transfer);

    if (outcome.status === "ambiguous") {
      throw new Error(
        recoverySubmission
          ? "Paystack same-reference recovery returned an ambiguous Transfer response. The wallet reservation remains intact and the deterministic reference must be reconciled again."
          : "Paystack withdrawal Transfer returned an ambiguous response. The wallet reservation remains intact until the deterministic Transfer reference is reconciled."
      );
    }

    PaystackTransferService.assertTransferOutcomeMatches({
      withdrawalTransaction,
      outcome,
    });

    const persisted = await PaystackTransferService.persistTransferOutcome({
      withdrawalTransactionId: withdrawalTransaction._id,

      outcome,

      recipientCode: resolvedRecipientResult.recipientCode,

      recipientCreated: resolvedRecipientResult.created,

      metadata: authoritativeMetadata,

      currentTime: normalizedCurrentTime,
    });

    return {
      ...persisted,

      bankAccount: resolvedRecipientResult.bankAccount || resolvedBankAccount,

      recipientCode: resolvedRecipientResult.recipientCode,

      transfer,

      transferReference: authoritativeTransferReference,

      paystackTransferCode: outcome.transferCode,

      requiresOtp: outcome.status === "otp",

      submitted: ["pending", "otp", "success"].includes(outcome.status),

      recoverySubmission: Boolean(recoverySubmission),
    };
  }

  /* ---------- TRANSFER RECONCILIATION ---------- */

  static async reconcileWithdrawalTransfer(
    { withdrawalTransactionId, currentTime = new Date() },
    options = {}
  ) {
    PaystackTransferService.assertNoExternalProviderSession(options);

    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const referenceResult =
      await PaystackTransferService.ensureWithdrawalTransferReference(withdrawalTransactionId);

    const withdrawalTransaction = referenceResult.transaction;

    /* ---------- HISTORICAL DISPOSITION REPLAY ---------- */

    const historicalObligation =
      await PaystackTransferService.getHistoricalObligation(withdrawalTransaction);

    if (historicalObligation) {
      return {
        ...PaystackTransferService.historicalObligationResult(
          withdrawalTransaction,
          historicalObligation
        ),

        reconciled: true,
      };
    }

    /* ---------- TERMINAL WITHDRAWALS ---------- */

    if (["failed", "reversed", "cancelled"].includes(withdrawalTransaction.status)) {
      return {
        transaction: withdrawalTransaction,

        reconciled: true,

        completed: false,

        terminal: true,

        idempotent: true,
      };
    }

    if (!["processing", "completed"].includes(withdrawalTransaction.status)) {
      return {
        transaction: withdrawalTransaction,

        reconciled: false,

        reason: "withdrawal_not_in_provider_processing",
      };
    }

    /* ---------- VERIFY ORIGINAL PROVIDER ENVIRONMENT ---------- */

    PaystackTransferService.assertOriginalProviderMode(withdrawalTransaction);

    let transfer;

    try {
      transfer = await PaystackService.verifyTransfer(referenceResult.transferReference);
    } catch (error) {
      if (
        Number(error?.providerStatusCode) === 404 &&
        withdrawalTransaction.status === "processing"
      ) {
        // Recovery must reuse the same persisted reference.

        const bankAccount = await PaystackTransferService.getBankAccount(
          withdrawalTransaction.bankAccount
        );

        const recoveryResult = await PaystackTransferService.submitPreparedWithdrawalTransfer({
          withdrawalTransaction,

          transferReference: referenceResult.transferReference,

          bankAccount,

          reason: withdrawalTransaction.metadata?.paystackTransferReason || null,

          metadata: {
            reconciledBy: "paystackTransferService",

            reconciliationReference: referenceResult.transferReference,

            recoveryReason: "provider_reference_not_found",

            sameReferenceRecovery: true,
          },

          currentTime: normalizedCurrentTime,

          recoverySubmission: true,
        });

        return {
          ...recoveryResult,

          reconciled: true,

          recoverySubmitted: true,

          sameReferenceRecovery: true,
        };
      }

      throw new Error(
        `Paystack withdrawal Transfer reconciliation failed. No new Transfer was submitted. ${error.message}`
      );
    }

    const outcome = PaystackTransferService.normalizeTransferOutcome(transfer);

    if (outcome.status === "ambiguous") {
      throw new Error(
        "Paystack withdrawal Transfer remains ambiguous. No second Transfer will be submitted."
      );
    }

    const persisted = await PaystackTransferService.persistTransferOutcome({
      withdrawalTransactionId: withdrawalTransaction._id,

      outcome,

      metadata: {
        reconciledBy: "paystackTransferService",

        reconciliationReference: referenceResult.transferReference,
      },

      currentTime: normalizedCurrentTime,
    });

    return {
      ...persisted,

      reconciled: true,
    };
  }

  /* ---------- TRANSFER INITIATION ---------- */

  static async initiateWithdrawalTransfer(
    { withdrawalTransactionId, reason = null, metadata = {}, currentTime = new Date() },
    options = {}
  ) {
    PaystackTransferService.assertNoExternalProviderSession(options);

    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const referenceResult =
      await PaystackTransferService.ensureWithdrawalTransferReference(withdrawalTransactionId);

    let withdrawalTransaction = referenceResult.transaction;

    PaystackTransferService.assertNoDispositionMetadata(metadata);

    /* ---------- HISTORICAL FINANCIAL OBLIGATION ---------- */

    const historicalObligation =
      await PaystackTransferService.getHistoricalObligation(withdrawalTransaction);

    if (historicalObligation) {
      return PaystackTransferService.historicalObligationResult(
        withdrawalTransaction,
        historicalObligation
      );
    }

    /* ---------- COMPLETED WITHDRAWAL REPLAY ---------- */

    if (withdrawalTransaction.status === "completed") {
      return {
        transaction: withdrawalTransaction,

        alreadyCompleted: true,

        submitted: false,

        idempotent: true,
      };
    }

    if (["failed", "reversed", "cancelled"].includes(withdrawalTransaction.status)) {
      throw new Error(
        `A ${withdrawalTransaction.status} withdrawal cannot be submitted to Paystack.`
      );
    }

    /* ---------- EXISTING PROVIDER BOUNDARY ---------- */

    if (withdrawalTransaction.status === "processing") {
      return PaystackTransferService.reconcileWithdrawalTransfer(
        {
          withdrawalTransactionId: withdrawalTransaction._id,

          currentTime: normalizedCurrentTime,
        },
        options
      );
    }

    if (withdrawalTransaction.status !== "pending") {
      throw new Error(
        `Withdrawal cannot be submitted to Paystack while ${withdrawalTransaction.status}.`
      );
    }

    /* ---------- BANK ACCOUNT ---------- */

    const bankAccount = await PaystackTransferService.getBankAccount(
      withdrawalTransaction.bankAccount
    );

    PaystackTransferService.assertBankAccountMatches(withdrawalTransaction, bankAccount);

    const transferReference = referenceResult.transferReference;

    /* ---------- ORIGINAL PAYSTACK ENVIRONMENT ---------- */

    const paystackMode = PaystackTransferService.getRequiredProviderMode();

    if (
      withdrawalTransaction.metadata?.paystackMode != null &&
      withdrawalTransaction.metadata.paystackMode !== paystackMode
    ) {
      throw new Error("Pending withdrawal contains a conflicting Paystack environment.");
    }

    const transferReason =
      PaystackTransferService.cleanString(reason) ||
      PaystackTransferService.buildTransferReason(withdrawalTransaction);

    const transferMetadata = {
      ...metadata,

      ...PaystackTransferService.buildTransferMetadata({
        withdrawalTransaction,
        bankAccount,
        transferReference,
      }),

      paystackTransferReason: transferReason,

      paystackMode,
    };

    /* ---------- CONFIRM TRANSFER RECIPIENT ---------- */

    const recipientResult = await PaystackTransferService.ensureTransferRecipient({
      bankAccount,

      countryCode: withdrawalTransaction.countryCode,

      currency: withdrawalTransaction.currency,

      metadata: {
        source: "loqum_withdrawal_recipient",
      },
    });

    if (PaystackTransferService.getRequiredProviderMode() !== paystackMode) {
      throw new Error("Paystack environment changed before committing the provider boundary.");
    }

    /* ---------- COMMIT PROVIDER BOUNDARY ---------- */

    const processingResult = await WalletService.markPendingExternalDebitProcessing({
      transactionId: withdrawalTransaction._id,

      currentTime: normalizedCurrentTime,

      metadata: {
        ...transferMetadata,

        paystackRecipientCode: recipientResult.recipientCode,

        paystackRecipientCreated: Boolean(recipientResult.created),

        paystackTransferReason: transferReason,
      },
    });

    withdrawalTransaction = processingResult.transaction;

    /* ---------- CONCURRENT SUBMISSION RECOVERY ---------- */

    if (processingResult.idempotent || processingResult.alreadyCompleted) {
      return PaystackTransferService.reconcileWithdrawalTransfer({
        withdrawalTransactionId: withdrawalTransaction._id,

        currentTime: normalizedCurrentTime,
      });
    }

    /* ---------- SUBMIT PERSISTED TRANSFER ---------- */

    return PaystackTransferService.submitPreparedWithdrawalTransfer({
      withdrawalTransaction,

      transferReference,

      bankAccount: recipientResult.bankAccount || bankAccount,

      recipientResult,

      reason: transferReason,

      metadata: transferMetadata,

      currentTime: normalizedCurrentTime,

      recoverySubmission: false,
    });
  }

  /* ---------- OTP FINALIZATION ---------- */

  static async submitWithdrawalTransferOtp(
    { withdrawalTransactionId, otp, currentTime = new Date() },
    options = {}
  ) {
    PaystackTransferService.assertNoExternalProviderSession(options);

    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const withdrawalTransaction =
      await PaystackTransferService.getWithdrawalTransaction(withdrawalTransactionId);

    /* ---------- HISTORICAL DISPOSITION PROTECTION ---------- */

    const historicalObligation =
      await PaystackTransferService.getHistoricalObligation(withdrawalTransaction);

    if (historicalObligation) {
      return PaystackTransferService.historicalObligationResult(
        withdrawalTransaction,
        historicalObligation
      );
    }

    if (withdrawalTransaction.status === "completed") {
      return {
        transaction: withdrawalTransaction,

        completed: true,

        idempotent: true,
      };
    }

    if (withdrawalTransaction.status !== "processing") {
      throw new Error(
        `A ${withdrawalTransaction.status} withdrawal cannot accept a Paystack Transfer OTP.`
      );
    }

    if (!withdrawalTransaction.paystackTransferReference) {
      throw new Error("Withdrawal Transfer reference is required before OTP finalization.");
    }

    if (!withdrawalTransaction.paystackTransferCode) {
      throw new Error("Paystack Transfer code is required before OTP finalization.");
    }

    /* ---------- PROVIDER ENVIRONMENT / WALLET ---------- */

    PaystackTransferService.assertOriginalProviderMode(withdrawalTransaction);

    const wallet = await Wallet.findById(withdrawalTransaction.wallet);

    WalletService.assertTransactionWallet(withdrawalTransaction, wallet);

    if (wallet.status === "closed") {
      throw new Error("Closed wallet cannot finalize a Transfer.");
    }

    /* ---------- FINALIZE TRANSFER ---------- */

    let transfer;

    try {
      transfer = await PaystackService.finalizeTransfer({
        transferCode: withdrawalTransaction.paystackTransferCode,

        otp,
      });
    } catch (_error) {
      throw new Error(
        "Paystack withdrawal Transfer OTP completion could not be conclusively confirmed. The wallet reservation remains intact and the Transfer must be reconciled by reference before another action."
      );
    }

    const outcome = PaystackTransferService.normalizeTransferOutcome(transfer);

    if (outcome.status === "ambiguous") {
      throw new Error(
        "Paystack withdrawal Transfer OTP completion returned an ambiguous response. Reconcile the deterministic Transfer reference before another action."
      );
    }

    PaystackTransferService.assertTransferOutcomeMatches({
      withdrawalTransaction,
      outcome,
    });

    return PaystackTransferService.persistTransferOutcome({
      withdrawalTransactionId: withdrawalTransaction._id,

      outcome,

      metadata: {
        otpFinalizedBy: "paystackTransferService",
      },

      currentTime: normalizedCurrentTime,
    });
  }
}

module.exports = PaystackTransferService;
