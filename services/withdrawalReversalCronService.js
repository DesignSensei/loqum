// services/withdrawalReversalCronService.js

const Transaction = require("../models/Transaction");

const PaystackService = require("./paystackService");
const WalletWithdrawalService = require("./walletWithdrawalService");

const logger = require("../utils/logger");

class WithdrawalReversalCronService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Get date before minutes ---------- */
  static getDateBeforeMinutes(minutes) {
    return new Date(Date.now() - minutes * 60 * 1000);
  }

  /* ---------- Normalize Paystack transfer status ---------- */
  static normalizePaystackStatus(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  /* ---------- Check failed Paystack transfer status ---------- */
  static isFailedTransferStatus(status) {
    const normalizedStatus = WithdrawalReversalCronService.normalizePaystackStatus(status);

    return ["failed", "reversed"].includes(normalizedStatus);
  }

  /* ---------- Check successful Paystack transfer status ---------- */
  static isSuccessfulTransferStatus(status) {
    const normalizedStatus = WithdrawalReversalCronService.normalizePaystackStatus(status);

    return normalizedStatus === "success";
  }

  /* ---------- Check pending Paystack transfer status ---------- */
  static isPendingTransferStatus(status) {
    const normalizedStatus = WithdrawalReversalCronService.normalizePaystackStatus(status);

    return ["pending", "otp", "processing", "queued"].includes(normalizedStatus);
  }

  /* ---------- Get Paystack transfer reference from withdrawal transaction ---------- */
  static getPaystackTransferReference(withdrawalTransaction) {
    return (
      WithdrawalReversalCronService.cleanString(
        withdrawalTransaction.metadata?.paystackTransferReference
      ) ||
      WithdrawalReversalCronService.cleanString(withdrawalTransaction.paystackReference) ||
      null
    );
  }

  /* ---------- Get Paystack transfer code from withdrawal transaction ---------- */
  static getPaystackTransferCode(withdrawalTransaction) {
    return (
      WithdrawalReversalCronService.cleanString(withdrawalTransaction.paystackTransferCode) ||
      WithdrawalReversalCronService.cleanString(
        withdrawalTransaction.metadata?.paystackTransferCode
      ) ||
      null
    );
  }

  /* ---------- Verify Paystack transfer by reference ---------- */
  static async verifyTransferByReference(reference) {
    const cleanReference = WithdrawalReversalCronService.cleanString(reference);

    if (!cleanReference) {
      throw new Error("Paystack transfer reference is required.");
    }

    const response = await PaystackService.request({
      method: "get",
      path: `/transfer/verify/${encodeURIComponent(cleanReference)}`,
    });

    return response.data;
  }

  /* ---------- Fetch Paystack transfer by transfer code ---------- */
  static async fetchTransferByCode(transferCode) {
    const cleanTransferCode = WithdrawalReversalCronService.cleanString(transferCode);

    if (!cleanTransferCode) {
      throw new Error("Paystack transfer code is required.");
    }

    const response = await PaystackService.request({
      method: "get",
      path: `/transfer/${encodeURIComponent(cleanTransferCode)}`,
    });

    return response.data;
  }

  /* ---------- Get Paystack transfer status for withdrawal ---------- */
  static async getPaystackTransferStatus(withdrawalTransaction) {
    const transferReference =
      WithdrawalReversalCronService.getPaystackTransferReference(withdrawalTransaction);

    const transferCode =
      WithdrawalReversalCronService.getPaystackTransferCode(withdrawalTransaction);

    if (transferReference) {
      const transfer =
        await WithdrawalReversalCronService.verifyTransferByReference(transferReference);

      return {
        transfer,
        lookupType: "reference",
        lookupValue: transferReference,
        status: WithdrawalReversalCronService.normalizePaystackStatus(transfer.status),
      };
    }

    if (transferCode) {
      const transfer = await WithdrawalReversalCronService.fetchTransferByCode(transferCode);

      return {
        transfer,
        lookupType: "transfer_code",
        lookupValue: transferCode,
        status: WithdrawalReversalCronService.normalizePaystackStatus(transfer.status),
      };
    }

    throw new Error("Withdrawal has no Paystack transfer reference or transfer code.");
  }

  /* ---------- Find old processing withdrawals for review ---------- */
  static async findProcessingWithdrawalsForReview({ olderThanMinutes = 30, limit = 50 } = {}) {
    const cutoffDate = WithdrawalReversalCronService.getDateBeforeMinutes(olderThanMinutes);

    return Transaction.find({
      type: "withdrawal",
      purpose: "withdrawal",
      paymentRail: "paystack_transfer",
      provider: "paystack",
      status: "processing",

      $or: [
        {
          "metadata.providerSubmissionAt": {
            $lte: cutoffDate,
          },
        },
        {
          createdAt: {
            $lte: cutoffDate,
          },
        },
      ],
    })
      .sort({
        createdAt: 1,
      })
      .limit(limit);
  }

  /* ---------- Process one withdrawal transaction ---------- */
  static async processWithdrawal(withdrawalTransaction, options = {}) {
    const transactionId = String(withdrawalTransaction._id);

    if (withdrawalTransaction.type !== "withdrawal") {
      return {
        transactionId,
        skipped: true,
        reason: "Transaction is not a withdrawal.",
      };
    }

    if (withdrawalTransaction.status !== "processing") {
      return {
        transactionId,
        skipped: true,
        reason: "Withdrawal is not processing.",
      };
    }

    const existingPaystackStatus = WithdrawalReversalCronService.normalizePaystackStatus(
      withdrawalTransaction.paystackStatus
    );

    if (WithdrawalReversalCronService.isFailedTransferStatus(existingPaystackStatus)) {
      const reversalResult = await WalletWithdrawalService.reverseFailedWithdrawal({
        withdrawalTransactionId: withdrawalTransaction._id,
        reversalReason:
          withdrawalTransaction.reversalReason ||
          "Paystack transfer failed or was reversed. Wallet balance reversed by cron.",
        metadata: {
          source: "withdrawal_reversal_cron",
          paystackStatus: existingPaystackStatus,
          reversalTrigger: "stored_paystack_status",
        },
      });

      return {
        transactionId,
        reversed: true,
        reversalTransactionId: String(reversalResult.transaction._id),
        trigger: "stored_paystack_status",
      };
    }

    const paystackResult =
      await WithdrawalReversalCronService.getPaystackTransferStatus(withdrawalTransaction);

    if (WithdrawalReversalCronService.isSuccessfulTransferStatus(paystackResult.status)) {
      if (options.completeSuccessfulTransfers === false) {
        return {
          transactionId,
          skipped: true,
          reason: "Paystack transfer is successful, but completion by cron is disabled.",
          paystackStatus: paystackResult.status,
        };
      }

      const completedResult = await WalletWithdrawalService.markWithdrawalCompleted({
        withdrawalTransactionId: withdrawalTransaction._id,
        metadata: {
          source: "withdrawal_reversal_cron",
          paystackStatus: paystackResult.status,
          paystackLookupType: paystackResult.lookupType,
          paystackLookupValue: paystackResult.lookupValue,
          providerCompletedByCronAt: new Date(),
        },
      });

      return {
        transactionId,
        completed: true,
        completedTransactionId: String(completedResult.transaction._id),
        paystackStatus: paystackResult.status,
      };
    }

    if (WithdrawalReversalCronService.isFailedTransferStatus(paystackResult.status)) {
      const reversalReason =
        paystackResult.transfer?.reason ||
        paystackResult.transfer?.failure_reason ||
        "Paystack transfer failed or was reversed. Wallet balance reversed by cron.";

      const reversalResult = await WalletWithdrawalService.reverseFailedWithdrawal({
        withdrawalTransactionId: withdrawalTransaction._id,
        reversalReason,
        metadata: {
          source: "withdrawal_reversal_cron",
          paystackStatus: paystackResult.status,
          paystackLookupType: paystackResult.lookupType,
          paystackLookupValue: paystackResult.lookupValue,
          providerReversalByCronAt: new Date(),
        },
      });

      return {
        transactionId,
        reversed: true,
        reversalTransactionId: String(reversalResult.transaction._id),
        paystackStatus: paystackResult.status,
      };
    }

    if (WithdrawalReversalCronService.isPendingTransferStatus(paystackResult.status)) {
      return {
        transactionId,
        pending: true,
        paystackStatus: paystackResult.status,
        reason: "Paystack transfer is still pending.",
      };
    }

    return {
      transactionId,
      skipped: true,
      paystackStatus: paystackResult.status,
      reason: "Paystack transfer status is not actionable.",
    };
  }

  /* ---------- Run withdrawal reversal cron pass ---------- */
  static async run({ olderThanMinutes = 30, limit = 50, completeSuccessfulTransfers = true } = {}) {
    const withdrawals = await WithdrawalReversalCronService.findProcessingWithdrawalsForReview({
      olderThanMinutes,
      limit,
    });

    const results = {
      checked: withdrawals.length,
      reversed: 0,
      completed: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };

    for (const withdrawalTransaction of withdrawals) {
      try {
        const result = await WithdrawalReversalCronService.processWithdrawal(
          withdrawalTransaction,
          {
            completeSuccessfulTransfers,
          }
        );

        if (result.reversed) {
          results.reversed += 1;
        } else if (result.completed) {
          results.completed += 1;
        } else if (result.pending) {
          results.pending += 1;
        } else {
          results.skipped += 1;
        }

        results.items.push(result);
      } catch (error) {
        results.failed += 1;

        const failedResult = {
          transactionId: String(withdrawalTransaction._id),
          failed: true,
          errorMessage: error.message || "Withdrawal cron processing failed.",
        };

        results.items.push(failedResult);

        logger.error("Withdrawal reversal cron item failed:", {
          transactionId: failedResult.transactionId,
          error: error.message,
          stack: error.stack,
        });
      }
    }

    logger.info("Withdrawal reversal cron completed.", {
      checked: results.checked,
      reversed: results.reversed,
      completed: results.completed,
      pending: results.pending,
      skipped: results.skipped,
      failed: results.failed,
    });

    return results;
  }
}

module.exports = WithdrawalReversalCronService;
