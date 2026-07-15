// services/paystackTransferService.js

const BankAccount = require("../models/BankAccount");
const Transaction = require("../models/Transaction");

const PaystackService = require("./paystackService");
const WalletService = require("./walletService");
const WalletWithdrawalService = require("./walletWithdrawalService");

class PaystackTransferService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Clean account number ---------- */
  static cleanAccountNumber(value) {
    const cleanValue = String(value || "")
      .replace(/\s+/g, "")
      .trim();

    return cleanValue || null;
  }

  /* ---------- Clean currency ---------- */
  static cleanCurrency(value) {
    return String(value || "NGN")
      .toUpperCase()
      .trim();
  }

  /* ---------- Build Paystack-safe transfer reference ---------- */
  static buildTransferReference(withdrawalTransaction) {
    if (!withdrawalTransaction?._id) {
      throw new Error("Withdrawal transaction is required to build transfer reference.");
    }

    return `lq_withdrawal_${String(withdrawalTransaction._id)}`;
  }

  /* ---------- Get withdrawal transaction ---------- */
  static async getWithdrawalTransaction(withdrawalTransactionId, options = {}) {
    if (!withdrawalTransactionId) {
      throw new Error("Withdrawal transaction ID is required.");
    }

    const query = Transaction.findById(withdrawalTransactionId);

    if (options.session) {
      query.session(options.session);
    }

    const withdrawalTransaction = await query;

    if (!withdrawalTransaction) {
      throw new Error("Withdrawal transaction not found.");
    }

    if (withdrawalTransaction.type !== "withdrawal") {
      throw new Error("Transaction is not a withdrawal.");
    }

    if (withdrawalTransaction.status === "completed") {
      throw new Error("Completed withdrawal cannot be submitted to Paystack.");
    }

    if (withdrawalTransaction.status === "reversed") {
      throw new Error("Reversed withdrawal cannot be submitted to Paystack.");
    }

    if (withdrawalTransaction.status !== "processing") {
      throw new Error("Only processing withdrawals can be submitted to Paystack.");
    }

    if (!withdrawalTransaction.bankAccount) {
      throw new Error("Withdrawal transaction must reference a bank account.");
    }

    return withdrawalTransaction;
  }

  /* ---------- Get bank account for transfer ---------- */
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
      throw new Error("Withdrawal bank account must be verified before transfer.");
    }

    if (!PaystackTransferService.cleanAccountNumber(bankAccount.accountNumber)) {
      throw new Error("Withdrawal bank account number is required.");
    }

    if (!PaystackTransferService.cleanString(bankAccount.accountName)) {
      throw new Error("Withdrawal bank account name is required.");
    }

    if (!PaystackTransferService.cleanString(bankAccount.paystackBankCode)) {
      throw new Error("Paystack bank code is required before transfer.");
    }

    return bankAccount;
  }

  /* ---------- Create Paystack transfer recipient ---------- */
  static async createTransferRecipient({ bankAccount, currency, metadata = {} }) {
    const cleanAccountNumber = PaystackTransferService.cleanAccountNumber(
      bankAccount.accountNumber
    );

    const cleanAccountName = PaystackTransferService.cleanString(bankAccount.accountName);
    const cleanBankCode = PaystackTransferService.cleanString(bankAccount.paystackBankCode);
    const cleanCurrency = PaystackTransferService.cleanCurrency(currency);

    if (!cleanAccountNumber) {
      throw new Error("Account number is required to create transfer recipient.");
    }

    if (!cleanAccountName) {
      throw new Error("Account name is required to create transfer recipient.");
    }

    if (!cleanBankCode) {
      throw new Error("Paystack bank code is required to create transfer recipient.");
    }

    const response = await PaystackService.request({
      method: "post",
      path: "/transferrecipient",
      data: {
        type: "nuban",
        name: cleanAccountName,
        account_number: cleanAccountNumber,
        bank_code: cleanBankCode,
        currency: cleanCurrency,
        metadata,
      },
    });

    if (!response.data?.recipient_code) {
      throw new Error("Paystack transfer recipient code was not returned.");
    }

    return response.data;
  }

  /* ---------- Ensure Paystack transfer recipient exists ---------- */
  static async ensureTransferRecipient({ bankAccount, currency, metadata = {} }, options = {}) {
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

    const recipient = await PaystackTransferService.createTransferRecipient({
      bankAccount,
      currency,
      metadata,
    });

    bankAccount.paystackRecipientCode = recipient.recipient_code;

    await bankAccount.save({
      session: options.session,
    });

    return {
      bankAccount,
      recipient,
      recipientCode: recipient.recipient_code,
      created: true,
    };
  }

  /* ---------- Build transfer reason ---------- */
  static buildTransferReason(withdrawalTransaction) {
    const ownerType = withdrawalTransaction.metadata?.ownerType;

    if (ownerType === "professional") {
      return "Loqum professional wallet withdrawal";
    }

    if (ownerType === "employer") {
      return "Loqum employer wallet withdrawal";
    }

    return "Loqum wallet withdrawal";
  }

  /* ---------- Build transfer metadata ---------- */
  static buildTransferMetadata({ withdrawalTransaction, bankAccount, transferReference }) {
    return {
      source: "loqum_withdrawal_transfer",
      withdrawalTransactionId: String(withdrawalTransaction._id),
      withdrawalReference: withdrawalTransaction.reference,
      paystackTransferReference: transferReference,

      ownerType: withdrawalTransaction.metadata?.ownerType || null,
      employerProfileId: withdrawalTransaction.metadata?.employerProfileId || null,
      professionalProfileId: withdrawalTransaction.metadata?.professionalProfileId || null,

      bankAccountId: String(bankAccount._id),
    };
  }

  /* ---------- Initiate Paystack transfer for withdrawal ---------- */
  static async initiateWithdrawalTransfer(
    { withdrawalTransactionId, reason = null, metadata = {} },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const withdrawalTransaction = await PaystackTransferService.getWithdrawalTransaction(
        withdrawalTransactionId,
        {
          session,
        }
      );

      if (withdrawalTransaction.paystackTransferCode) {
        return {
          transaction: withdrawalTransaction,
          alreadySubmitted: true,
        };
      }

      const bankAccount = await PaystackTransferService.getBankAccount(
        withdrawalTransaction.bankAccount,
        {
          session,
        }
      );

      const transferReference =
        withdrawalTransaction.metadata?.paystackTransferReference ||
        PaystackTransferService.buildTransferReference(withdrawalTransaction);

      const transferMetadata = {
        ...PaystackTransferService.buildTransferMetadata({
          withdrawalTransaction,
          bankAccount,
          transferReference,
        }),
        ...metadata,
      };

      const recipientResult = await PaystackTransferService.ensureTransferRecipient(
        {
          bankAccount,
          currency: withdrawalTransaction.currency,
          metadata: {
            source: "loqum_withdrawal_recipient",
            ownerType: withdrawalTransaction.metadata?.ownerType || null,
            employerProfileId: withdrawalTransaction.metadata?.employerProfileId || null,
            professionalProfileId: withdrawalTransaction.metadata?.professionalProfileId || null,
            bankAccountId: String(bankAccount._id),
          },
        },
        {
          session,
        }
      );

      const transferResponse = await PaystackService.request({
        method: "post",
        path: "/transfer",
        data: {
          source: "balance",
          amount: withdrawalTransaction.amount,
          recipient: recipientResult.recipientCode,
          reference: transferReference,
          reason: reason || PaystackTransferService.buildTransferReason(withdrawalTransaction),
          currency: PaystackTransferService.cleanCurrency(withdrawalTransaction.currency),
        },
      });

      const transferData = transferResponse.data || {};
      const paystackTransferCode = PaystackTransferService.cleanString(transferData.transfer_code);

      if (!paystackTransferCode) {
        throw new Error("Paystack transfer code was not returned.");
      }

      const submittedResult = await WalletWithdrawalService.markWithdrawalSubmittedToProvider(
        {
          withdrawalTransactionId: withdrawalTransaction._id,
          paystackTransferCode,

          metadata: {
            ...transferMetadata,
            paystackTransferStatus: transferData.status || null,
            paystackTransferId: transferData.id || null,
            paystackRecipientCode: recipientResult.recipientCode,
            paystackRecipientCreated: Boolean(recipientResult.created),
          },
        },
        {
          session,
        }
      );

      return {
        transaction: submittedResult.transaction,
        bankAccount: recipientResult.bankAccount,
        recipientCode: recipientResult.recipientCode,
        transfer: transferData,
        transferReference,
        paystackTransferCode,
        requiresOtp: transferData.status === "otp",
        submitted: true,
      };
    });
  }
}

module.exports = PaystackTransferService;
