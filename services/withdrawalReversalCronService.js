// services/withdrawalReversalCronService.js

const Transaction = require("../models/Transaction");

const PaystackTransferService = require("./paystackTransferService");

const logger = require("../utils/logger");

class WithdrawalReversalCronService {
  /* ---------- Normalize current time ---------- */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw new Error("Current time is invalid.");
    }

    return currentTime;
  }

  /* ---------- Normalize positive whole number ---------- */

  static normalizePositiveInteger(value, fieldName) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
      throw new Error(`${fieldName} must be a positive whole number.`);
    }

    return normalizedValue;
  }

  /* ---------- Normalize provider status ---------- */

  static normalizeProviderStatus(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  /* ---------- Get provider-processing cutoff ---------- */

  static getProcessingCutoff({ currentTime, olderThanMinutes }) {
    const normalizedCurrentTime = WithdrawalReversalCronService.normalizeCurrentTime(currentTime);

    const normalizedOlderThanMinutes = WithdrawalReversalCronService.normalizePositiveInteger(
      olderThanMinutes,
      "Withdrawal reconciliation age"
    );

    const offset = normalizedOlderThanMinutes * 60 * 1000;

    if (!Number.isSafeInteger(offset)) {
      throw new Error("Withdrawal reconciliation age is too large.");
    }

    return new Date(normalizedCurrentTime.getTime() - offset);
  }

  /* ---------- Find old provider-processing withdrawals ---------- */

  static async findProcessingWithdrawalsForReview({
    olderThanMinutes = 30,

    limit = 50,

    currentTime = new Date(),
  } = {}) {
    const normalizedLimit = WithdrawalReversalCronService.normalizePositiveInteger(
      limit,
      "Withdrawal reconciliation limit"
    );

    const cutoffDate = WithdrawalReversalCronService.getProcessingCutoff({
      currentTime,

      olderThanMinutes,
    });

    /*
     * processingStartedAt is the durable provider-boundary clock.
     *
     * Do not fall back to createdAt.
     *
     * A withdrawal may remain pending locally for some time before provider
     * submission begins. Its creation time must not make a fresh provider
     * attempt look stale.
     */
    return Transaction.find({
      type: "withdrawal",

      purpose: "withdrawal",

      direction: "debit",

      paymentRail: "paystack_transfer",

      provider: "paystack",

      status: "processing",

      processingStartedAt: {
        $ne: null,

        $lte: cutoffDate,
      },
    })
      .select("_id processingStartedAt")
      .sort({
        processingStartedAt: 1,

        _id: 1,
      })
      .limit(normalizedLimit)
      .lean();
  }

  /* ---------- Process one withdrawal reconciliation ---------- */

  static async processWithdrawal(withdrawalTransaction, options = {}) {
    const transactionId = String(withdrawalTransaction?._id || "").trim();

    if (!transactionId) {
      throw new Error("Withdrawal Transaction ID is required for reconciliation.");
    }

    const currentTime = WithdrawalReversalCronService.normalizeCurrentTime(
      options.currentTime || new Date()
    );

    /*
     * PaystackTransferService owns provider reconciliation.
     *
     * It:
     *
     * - verifies the deterministic Transfer reference;
     * - performs controlled SAME-reference recovery after provider 404;
     * - validates the returned provider Transfer;
     * - records provider Transfer codes; and
     * - delegates terminal wallet state to WalletWithdrawalService.
     *
     * This cron must never issue an independent blind Transfer POST or release
     * a wallet reservation from an ambiguous provider result.
     */
    const reconciliationResult = await PaystackTransferService.reconcileWithdrawalTransfer({
      withdrawalTransactionId: transactionId,

      currentTime,
    });

    const transaction = reconciliationResult?.transaction || null;

    const status = String(transaction?.status || "")
      .trim()
      .toLowerCase();

    const providerStatus =
      WithdrawalReversalCronService.normalizeProviderStatus(
        reconciliationResult?.outcome?.rawStatus ||
          reconciliationResult?.outcome?.status ||
          transaction?.paystackStatus
      ) || null;

    if (status === "completed") {
      return {
        transactionId,

        completed: true,

        terminalStatus: status,

        providerStatus,

        recoverySubmitted: reconciliationResult?.recoverySubmitted === true,

        idempotent: reconciliationResult?.idempotent === true,
      };
    }

    /*
     * WalletWithdrawalService now terminates failed/reversed provider
     * withdrawals on the SAME withdrawal Transaction.
     *
     * "reversed" here is only the cron result classification meaning the
     * reserved value was released. There is no second reversal Transaction.
     */
    if (status === "failed") {
      return {
        transactionId,

        reversed: true,

        reservationReleased: true,

        terminalStatus: status,

        providerStatus,

        recoverySubmitted: reconciliationResult?.recoverySubmitted === true,

        idempotent: reconciliationResult?.idempotent === true,
      };
    }

    /*
     * A terminal status may appear if another worker or webhook completed the
     * lifecycle after this cron selected the processing candidate.
     */
    if (["cancelled", "reversed"].includes(status)) {
      return {
        transactionId,

        skipped: true,

        terminal: true,

        terminalStatus: status,

        providerStatus,

        reason: `Withdrawal is already ${status}.`,

        idempotent: reconciliationResult?.idempotent === true,
      };
    }

    /*
     * Pending / OTP / unresolved provider state keeps the wallet reservation
     * intact.
     */
    if (status === "processing") {
      return {
        transactionId,

        pending: true,

        terminalStatus: null,

        providerStatus,

        requiresOtp: reconciliationResult?.requiresOtp === true,

        unresolved: reconciliationResult?.unresolved === true,

        recoverySubmitted: reconciliationResult?.recoverySubmitted === true,

        sameReferenceRecovery: reconciliationResult?.sameReferenceRecovery === true,

        reason: reconciliationResult?.reason || "Paystack withdrawal Transfer is still unresolved.",
      };
    }

    return {
      transactionId,

      skipped: true,

      terminalStatus: status || null,

      providerStatus,

      reason:
        reconciliationResult?.reason ||
        "Withdrawal reconciliation did not produce an actionable processing state.",
    };
  }

  /* ---------- Run withdrawal reconciliation cron pass ---------- */

  static async run({
    olderThanMinutes = 30,

    limit = 50,

    currentTime = new Date(),
  } = {}) {
    const normalizedCurrentTime = WithdrawalReversalCronService.normalizeCurrentTime(currentTime);

    const withdrawals = await WithdrawalReversalCronService.findProcessingWithdrawalsForReview({
      olderThanMinutes,

      limit,

      currentTime: normalizedCurrentTime,
    });

    const results = {
      checked: withdrawals.length,

      reversed: 0,

      completed: 0,

      pending: 0,

      recoverySubmitted: 0,

      skipped: 0,

      failed: 0,

      items: [],
    };

    for (const withdrawalTransaction of withdrawals) {
      try {
        const result = await WithdrawalReversalCronService.processWithdrawal(
          withdrawalTransaction,
          {
            currentTime: normalizedCurrentTime,
          }
        );

        if (result.recoverySubmitted) {
          results.recoverySubmitted += 1;
        }

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

          errorMessage: error.message || "Withdrawal reconciliation failed.",
        };

        results.items.push(failedResult);

        logger.error("Withdrawal reconciliation cron item failed:", {
          transactionId: failedResult.transactionId,

          error: error.message,

          stack: error.stack,
        });
      }
    }

    logger.info("Withdrawal reconciliation cron completed.", {
      checked: results.checked,

      reversed: results.reversed,

      completed: results.completed,

      pending: results.pending,

      recoverySubmitted: results.recoverySubmitted,

      skipped: results.skipped,

      failed: results.failed,
    });

    return results;
  }
}

module.exports = WithdrawalReversalCronService;
