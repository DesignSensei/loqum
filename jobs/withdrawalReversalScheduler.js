// jobs/withdrawalReversalScheduler.js

const WithdrawalReversalCronService = require("../services/withdrawalReversalCronService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 10;
const DEFAULT_OLDER_THAN_MINUTES = 30;
const DEFAULT_LIMIT = 50;

/**
 * WITHDRAWAL REVERSAL SCHEDULER
 *
 * This scheduler periodically asks WithdrawalReversalCronService to reconcile
 * stale withdrawal Transfers.
 *
 * It may trigger the service to:
 *
 * - inspect stale withdrawal Transactions;
 * - confirm successful Paystack Transfers and finalize them when configured;
 * - keep still-pending Transfers pending; and
 * - reverse withdrawals whose external Transfer has definitively failed.
 *
 * The scheduler owns timing and overlap protection only.
 *
 * It does not:
 *
 * - query Paystack directly;
 * - mutate Transactions directly;
 * - credit professional wallets directly;
 * - decide whether a Transfer succeeded or failed;
 * - create withdrawal-reversal Transactions directly; or
 * - participate in Shift settlement, employer refunds or Shift lifecycle state.
 */

class WithdrawalReversalScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizePositiveInteger(value, fieldName) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 1) {
      throw new Error(
        `Withdrawal reversal scheduler ${fieldName} must be a positive whole number.`
      );
    }

    return normalizedValue;
  }

  static normalizeBoolean(value, fieldName) {
    if (typeof value !== "boolean") {
      throw new Error(`Withdrawal reversal scheduler ${fieldName} must be true or false.`);
    }

    return value;
  }

  /* ─────────────────────────────── INTERVAL ─────────────────────────────── */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    const normalizedIntervalMinutes = WithdrawalReversalScheduler.normalizePositiveInteger(
      intervalMinutes,
      "interval minutes"
    );

    return normalizedIntervalMinutes * 60 * 1000;
  }

  /* ─────────────────────────────── RUN ONCE ─────────────────────────────── */

  static async runOnce({
    olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES,
    limit = DEFAULT_LIMIT,
    completeSuccessfulTransfers = true,
  } = {}) {
    if (WithdrawalReversalScheduler.isRunning) {
      logger.info(
        "Withdrawal reversal scheduler skipped because the previous run is still active."
      );

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    WithdrawalReversalScheduler.isRunning = true;

    try {
      const normalizedOlderThanMinutes = WithdrawalReversalScheduler.normalizePositiveInteger(
        olderThanMinutes,
        "older-than minutes"
      );

      const normalizedLimit = WithdrawalReversalScheduler.normalizePositiveInteger(limit, "limit");

      const normalizedCompleteSuccessfulTransfers = WithdrawalReversalScheduler.normalizeBoolean(
        completeSuccessfulTransfers,
        "complete-successful-transfers option"
      );

      logger.info("Withdrawal reversal scheduler run started.", {
        olderThanMinutes: normalizedOlderThanMinutes,
        limit: normalizedLimit,
        completeSuccessfulTransfers: normalizedCompleteSuccessfulTransfers,
      });

      const result = await WithdrawalReversalCronService.run({
        olderThanMinutes: normalizedOlderThanMinutes,
        limit: normalizedLimit,
        completeSuccessfulTransfers: normalizedCompleteSuccessfulTransfers,
      });

      logger.info("Withdrawal reversal scheduler run completed.", {
        checked: result?.checked || 0,
        reversed: result?.reversed || 0,
        completed: result?.completed || 0,
        pending: result?.pending || 0,
        skipped: result?.skipped || 0,
        failed: result?.failed || 0,
      });

      return result;
    } catch (error) {
      logger.error("Withdrawal reversal scheduler run failed:", error);

      return {
        failed: true,
        errorCode: error.code || "WITHDRAWAL_REVERSAL_SCHEDULER_FAILED",
        errorMessage: error.message || "Withdrawal reversal scheduler failed.",
      };
    } finally {
      WithdrawalReversalScheduler.isRunning = false;
    }
  }

  /* ─────────────────────────────── START ─────────────────────────────── */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES,
    limit = DEFAULT_LIMIT,
    completeSuccessfulTransfers = true,
    runImmediately = false,
  } = {}) {
    if (WithdrawalReversalScheduler.intervalHandle) {
      logger.info("Withdrawal reversal scheduler is already running.");

      return WithdrawalReversalScheduler.intervalHandle;
    }

    const intervalMs = WithdrawalReversalScheduler.getIntervalMs(intervalMinutes);

    const normalizedOlderThanMinutes = WithdrawalReversalScheduler.normalizePositiveInteger(
      olderThanMinutes,
      "older-than minutes"
    );

    const normalizedLimit = WithdrawalReversalScheduler.normalizePositiveInteger(limit, "limit");

    const normalizedCompleteSuccessfulTransfers = WithdrawalReversalScheduler.normalizeBoolean(
      completeSuccessfulTransfers,
      "complete-successful-transfers option"
    );

    if (typeof runImmediately !== "boolean") {
      throw new Error(
        "Withdrawal reversal scheduler run-immediately option must be true or false."
      );
    }

    const runOptions = {
      olderThanMinutes: normalizedOlderThanMinutes,
      limit: normalizedLimit,
      completeSuccessfulTransfers: normalizedCompleteSuccessfulTransfers,
    };

    logger.info("Withdrawal reversal scheduler started.", {
      intervalMinutes,
      ...runOptions,
      runImmediately,
    });

    if (runImmediately) {
      void WithdrawalReversalScheduler.runOnce(runOptions);
    }

    WithdrawalReversalScheduler.intervalHandle = setInterval(() => {
      void WithdrawalReversalScheduler.runOnce(runOptions);
    }, intervalMs);

    return WithdrawalReversalScheduler.intervalHandle;
  }

  /* ─────────────────────────────── STOP ─────────────────────────────── */

  static stop() {
    if (!WithdrawalReversalScheduler.intervalHandle) {
      return;
    }

    clearInterval(WithdrawalReversalScheduler.intervalHandle);

    WithdrawalReversalScheduler.intervalHandle = null;

    /*
     * Do not force isRunning to false here.
     *
     * stop() cancels future scheduler ticks, but it does not cancel an
     * already-running WithdrawalReversalCronService.run(). The active pass
     * retains the overlap lock until its finally block completes.
     */

    logger.info("Withdrawal reversal scheduler stopped.");
  }
}

module.exports = WithdrawalReversalScheduler;
