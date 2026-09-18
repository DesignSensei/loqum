// services/paystackTransferService.js

const BankAccount = require("../models/BankAccount");
const Transaction = require("../models/Transaction");

const PaystackService = require("./paystackService");
const WalletService = require("./walletService");
const WalletWithdrawalService = require("./walletWithdrawalService");

/**
 * PAYSTACK TRANSFER SERVICE
 *
 * Owns Paystack Transfer orchestration for ordinary employer/professional
 * wallet withdrawals only.
 *
 * Employer-refund fallback Transfers do not belong here. They are owned by
 * EmployerRefundBatchService because that service owns fallback eligibility,
 * consent, admin approval and escrow reservation.
 *
 * WITHDRAWAL SAFETY
 *
 * A withdrawal is expected to exist first as a reserved external debit:
 *
 *   availableBalance -= amount
 *   pendingBalance   += amount
 *
 * The wallet's total value is unchanged until Paystack conclusively succeeds.
 *
 * Before POST /transfer, Loqum persists a deterministic
 * paystackTransferReference and marks the withdrawal as provider-processing.
 * Once that boundary has been crossed, every later attempt must reconcile the
 * persisted deterministic reference first. A provider-not-found result may
 * recover by resubmitting that SAME reference; a new Transfer reference must
 * never be generated for the same withdrawal.
 *
 * External Paystack requests are deliberately kept outside MongoDB transaction
 * boundaries because a database rollback cannot roll back a provider Transfer.
 */
class PaystackTransferService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    const cleanValue = String(value || "").trim();
    return cleanValue || null;
  }

  static cleanAccountNumber(value) {
    const cleanValue = String(value || "")
      .replace(/\s+/g, "")
      .trim();

    return cleanValue || null;
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
        "Paystack Transfer provider orchestration cannot run inside a caller-managed MongoDB transaction. Persist local provider-boundary state first, then call Paystack outside the database transaction."
      );
    }
  }

  /* ─────────────────────────────── TRANSFER REFERENCE / MARKET ─────────────────────────────── */

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

  /* ─────────────────────────────── PROVIDER OUTCOME ─────────────────────────────── */

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

    const amountValue =
      value?.amount === null || value?.amount === undefined ? null : Number(value.amount);

    return {
      status,

      rawStatus,

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

      providerTransferId: value?.id === null || value?.id === undefined ? null : String(value.id),

      raw: value?.raw || value || null,
    };
  }

  static assertTransferOutcomeMatches({ withdrawalTransaction, outcome }) {
    if (!withdrawalTransaction || !outcome) {
      throw new Error("Withdrawal Transaction and Paystack Transfer outcome are required.");
    }

    const expectedReference = PaystackTransferService.cleanString(
      withdrawalTransaction.paystackTransferReference
    );

    if (!expectedReference) {
      throw new Error("Withdrawal Transaction has no deterministic Paystack Transfer reference.");
    }

    if (outcome.reference && outcome.reference !== expectedReference) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer reference.");
    }

    if (outcome.amount !== null && outcome.amount !== Number(withdrawalTransaction.amount)) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer amount.");
    }

    if (
      outcome.currency &&
      outcome.currency !== PaystackTransferService.cleanCurrency(withdrawalTransaction.currency)
    ) {
      throw new Error("Paystack returned an unexpected withdrawal Transfer currency.");
    }

    return true;
  }

  static isDefinitiveTransferSubmissionFailure(error) {
    if (!error || error.code === "PAYSTACK_REQUEST_TIMEOUT") {
      return false;
    }

    const providerStatusCode = Number(error.providerStatusCode);

    if (
      Number.isInteger(providerStatusCode) &&
      providerStatusCode >= 400 &&
      providerStatusCode < 500
    ) {
      return true;
    }

    return Boolean(error.code === "PAYSTACK_PROVIDER_REJECTED_REQUEST" && error.providerResponse);
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

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

  /* ─────────────────────────────── DURABLE TRANSFER REFERENCE ─────────────────────────────── */

  static async ensureWithdrawalTransferReference(withdrawalTransactionId) {
    return WalletService.runWithOptionalTransaction({}, async (session) => {
      const withdrawalTransaction = await PaystackTransferService.getWithdrawalTransaction(
        withdrawalTransactionId,
        {
          session,
        }
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
          "A withdrawal that has already entered provider processing without a Transfer reference cannot be repaired automatically. Manual reconciliation is required."
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

  /* ─────────────────────────────── TRANSFER RECIPIENT ─────────────────────────────── */

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
    const existingRecipientCode = PaystackTransferService.cleanString(
      bankAccount.paystackRecipientCode
    );

    if (existingRecipientCode) {
      return {
        bankAccount,

        recipientCode: existingRecipientCode,

        created: false,
      };
    }

    /*
     * Paystack treats duplicate recipient creation for the same account as a
     * retrieval of the existing recipient. A crash after provider creation but
     * before the local cache is saved can therefore safely retry this step.
     */
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

    bankAccount.paystackRecipientCode = recipientCode;

    await bankAccount.save();

    return {
      bankAccount,

      recipient,

      recipientCode,

      created: true,
    };
  }

  /* ─────────────────────────────── WITHDRAWAL CONTEXT ─────────────────────────────── */

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

  /* ─────────────────────────────── OUTCOME PERSISTENCE ─────────────────────────────── */

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

    PaystackTransferService.assertTransferOutcomeMatches({
      withdrawalTransaction,
      outcome,
    });

    const transferMetadata = {
      ...metadata,

      paystackTransferStatus: outcome.rawStatus || outcome.status,

      paystackTransferId: outcome.providerTransferId,

      paystackTransferReference: withdrawalTransaction.paystackTransferReference,

      paystackTransferCode: outcome.transferCode || null,

      paystackRecipientCode: recipientCode || outcome.recipientCode || null,

      paystackRecipientCreated: Boolean(recipientCreated),

      providerObservedAt: normalizedCurrentTime,
    };

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

    if (["failed", "reversed"].includes(outcome.status)) {
      if (outcome.transferCode) {
        await WalletWithdrawalService.markWithdrawalSubmittedToProvider({
          withdrawalTransactionId: withdrawalTransaction._id,

          paystackTransferCode: outcome.transferCode,

          metadata: transferMetadata,
        });
      }

      const reversedResult = await WalletWithdrawalService.reverseFailedWithdrawal({
        withdrawalTransactionId: withdrawalTransaction._id,

        reversalReason:
          outcome.status === "reversed"
            ? "Paystack reversed the withdrawal Transfer."
            : `Paystack withdrawal Transfer failed with status ${outcome.rawStatus || "failed"}.`,

        metadata: transferMetadata,
      });

      return {
        transaction: reversedResult.originalTransaction || withdrawalTransaction,

        reversalTransaction: reversedResult.transaction || null,

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

  /* ─────────────────────────────── RECONCILIATION ─────────────────────────────── */

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

    if (withdrawalTransaction.status !== "processing") {
      throw new Error(
        `Paystack Transfer can only be submitted while withdrawal is processing, not ${withdrawalTransaction.status}.`
      );
    }

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

    const resolvedBankAccount =
      bankAccount ||
      (await PaystackTransferService.getBankAccount(withdrawalTransaction.bankAccount));

    const authoritativeMetadata = {
      ...metadata,

      ...PaystackTransferService.buildTransferMetadata({
        withdrawalTransaction,
        bankAccount: resolvedBankAccount,
        transferReference: authoritativeTransferReference,
      }),

      recoverySubmission: Boolean(recoverySubmission),
    };

    const resolvedRecipientResult =
      recipientResult ||
      (await PaystackTransferService.ensureTransferRecipient({
        bankAccount: resolvedBankAccount,

        countryCode: withdrawalTransaction.countryCode,

        currency: withdrawalTransaction.currency,

        metadata: {
          source: "loqum_withdrawal_recipient",

          ownerType: withdrawalTransaction.metadata?.ownerType || null,

          employerProfileId: withdrawalTransaction.metadata?.employerProfileId || null,

          professionalProfileId: withdrawalTransaction.metadata?.professionalProfileId || null,

          bankAccountId: String(resolvedBankAccount._id),
        },
      }));

    const transferReason =
      PaystackTransferService.cleanString(withdrawalTransaction.metadata?.paystackTransferReason) ||
      PaystackTransferService.cleanString(reason) ||
      PaystackTransferService.buildTransferReason(withdrawalTransaction);

    let transfer;

    try {
      transfer = await PaystackService.initiateTransfer({
        source: "balance",

        amount: withdrawalTransaction.amount,

        recipient: resolvedRecipientResult.recipientCode,

        reference: authoritativeTransferReference,

        reason: transferReason,

        currency: PaystackTransferService.cleanCurrency(withdrawalTransaction.currency),
      });
    } catch (error) {
      /*
       * On the original submission, a conclusive provider
       * rejection can safely fail/reverse the withdrawal.
       *
       * During SAME-REFERENCE recovery, however, a provider
       * rejection must not automatically reverse funds.
       * The original request may have reached Paystack even
       * though verification had not exposed it yet.
       */
      if (
        recoverySubmission &&
        PaystackTransferService.isDefinitiveTransferSubmissionFailure(error)
      ) {
        throw new Error(
          "Paystack rejected the same-reference recovery submission. The withdrawal remains reserved and requires another reference reconciliation before any reversal."
        );
      }

      if (PaystackTransferService.isDefinitiveTransferSubmissionFailure(error)) {
        const failedOutcome = {
          status: "failed",

          rawStatus: "provider_rejected",

          reference: authoritativeTransferReference,

          transferCode: null,

          recipientCode: resolvedRecipientResult.recipientCode,

          amount: Number(withdrawalTransaction.amount),

          currency: PaystackTransferService.cleanCurrency(withdrawalTransaction.currency),

          providerTransferId: null,

          raw: error.providerResponse || null,
        };

        const failed = await PaystackTransferService.persistTransferOutcome({
          withdrawalTransactionId: withdrawalTransaction._id,

          outcome: failedOutcome,

          recipientCode: resolvedRecipientResult.recipientCode,

          recipientCreated: resolvedRecipientResult.created,

          metadata: {
            ...authoritativeMetadata,

            providerSubmissionRejected: true,

            providerSubmissionError: error.message,
          },

          currentTime: normalizedCurrentTime,
        });

        return {
          ...failed,

          definitiveProviderFailure: true,

          submitted: false,

          recoverySubmission: Boolean(recoverySubmission),
        };
      }

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

  static async reconcileWithdrawalTransfer(
    { withdrawalTransactionId, currentTime = new Date() },
    options = {}
  ) {
    PaystackTransferService.assertNoExternalProviderSession(options);

    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const referenceResult =
      await PaystackTransferService.ensureWithdrawalTransferReference(withdrawalTransactionId);

    const withdrawalTransaction = referenceResult.transaction;

    if (withdrawalTransaction.status === "completed") {
      return {
        transaction: withdrawalTransaction,

        reconciled: true,

        completed: true,

        idempotent: true,
      };
    }

    if (["failed", "reversed", "cancelled"].includes(withdrawalTransaction.status)) {
      return {
        transaction: withdrawalTransaction,

        reconciled: true,

        completed: false,

        terminal: true,

        idempotent: true,
      };
    }

    if (withdrawalTransaction.status !== "processing") {
      return {
        transaction: withdrawalTransaction,

        reconciled: false,

        reason: "withdrawal_not_in_provider_processing",
      };
    }

    let transfer;

    try {
      transfer = await PaystackService.verifyTransfer(referenceResult.transferReference);
    } catch (error) {
      if (Number(error?.providerStatusCode) === 404) {
        /*
         * The local processing boundary may have committed
         * before this process actually reached POST /transfer.
         *
         * Recover with the SAME deterministic reference.
         * Never generate another reference for this withdrawal.
         */
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

  /* ─────────────────────────────── TRANSFER INITIATION ─────────────────────────────── */

  static async initiateWithdrawalTransfer(
    {
      withdrawalTransactionId,

      reason = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    PaystackTransferService.assertNoExternalProviderSession(options);

    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const referenceResult =
      await PaystackTransferService.ensureWithdrawalTransferReference(withdrawalTransactionId);

    let withdrawalTransaction = referenceResult.transaction;

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

    /*
     * Once a withdrawal is already processing, never start
     * another ordinary submission path.
     *
     * Reconciliation checks the same deterministic reference
     * and owns same-reference recovery when required.
     */
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

    const bankAccount = await PaystackTransferService.getBankAccount(
      withdrawalTransaction.bankAccount
    );

    const transferReference = referenceResult.transferReference;

    /*
     * Persist the exact reason intended for this provider
     * attempt so crash recovery can reconstruct the same
     * submission without inventing different provider data.
     */
    const transferReason =
      PaystackTransferService.cleanString(reason) ||
      PaystackTransferService.buildTransferReason(withdrawalTransaction);

    /*
     * Caller metadata is applied first.
     *
     * Authoritative withdrawal identity is applied afterwards
     * so callers cannot overwrite owner, bank-account,
     * transaction or deterministic-reference metadata.
     */
    const transferMetadata = {
      ...metadata,

      ...PaystackTransferService.buildTransferMetadata({
        withdrawalTransaction,
        bankAccount,
        transferReference,
      }),

      paystackTransferReason: transferReason,
    };

    const ownerContext = PaystackTransferService.getWithdrawalOwnerContext(withdrawalTransaction);

    /*
     * Resolve/create the provider recipient before crossing
     * the provider-processing boundary.
     *
     * The recipient carries the authoritative withdrawal owner
     * identity used by downstream Paystack transfer webhooks.
     */
    const recipientResult = await PaystackTransferService.ensureTransferRecipient({
      bankAccount,

      countryCode: withdrawalTransaction.countryCode,

      currency: withdrawalTransaction.currency,

      metadata: {
        source: "loqum_withdrawal_recipient",

        ownerType: ownerContext.ownerType,

        employerProfileId: ownerContext.employerProfileId || null,

        professionalProfileId: ownerContext.professionalProfileId || null,

        bankAccountId: String(bankAccount._id),
      },
    });

    /*
     * Commit the local provider boundary BEFORE POST /transfer.
     *
     * After this succeeds, the withdrawal is processing and
     * every later retry must reconcile the same deterministic
     * reference.
     *
     * If the process crashes immediately after this point and
     * before Paystack receives POST /transfer,
     * reconcileWithdrawalTransfer() may perform controlled
     * SAME-reference recovery.
     */
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

    /*
     * The actual provider POST is centralized in
     * submitPreparedWithdrawalTransfer().
     *
     * That same helper is also used by 404 reconciliation
     * recovery, guaranteeing that recovery reuses this exact
     * deterministic reference instead of generating another
     * transfer identity.
     */
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

  /* ─────────────────────────────── OTP FINALIZATION ─────────────────────────────── */

  static async submitWithdrawalTransferOtp(
    {
      withdrawalTransactionId,

      otp,

      currentTime = new Date(),
    },
    options = {}
  ) {
    PaystackTransferService.assertNoExternalProviderSession(options);

    const normalizedCurrentTime = PaystackTransferService.normalizeCurrentTime(currentTime);

    const withdrawalTransaction =
      await PaystackTransferService.getWithdrawalTransaction(withdrawalTransactionId);

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
