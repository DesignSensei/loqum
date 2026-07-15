// jobs/withdrawalReversalScheduler.js

const WithdrawalReversalCronService = require("../services/withdrawalReversalCronService");
const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 10;
const DEFAULT_OLDER_THAN_MINUTES = 30;
const DEFAULT_LIMIT = 50;

class WithdrawalReversalScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ---------- Get interval in milliseconds ---------- */
  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    return intervalMinutes * 60 * 1000;
  }

  /* ---------- Run one scheduler pass ---------- */
  static async runOnce({
    olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES,
    limit = DEFAULT_LIMIT,
    completeSuccessfulTransfers = true,
  } = {}) {
    if (WithdrawalReversalScheduler.isRunning) {
      logger.info("Withdrawal reversal scheduler skipped because previous run is still active.");
      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    WithdrawalReversalScheduler.isRunning = true;

    try {
      logger.info("Withdrawal reversal scheduler run started.", {
        olderThanMinutes,
        limit,
        completeSuccessfulTransfers,
      });

      const result = await WithdrawalReversalCronService.run({
        olderThanMinutes,
        limit,
        completeSuccessfulTransfers,
      });

      logger.info("Withdrawal reversal scheduler run completed.", {
        checked: result.checked,
        reversed: result.reversed,
        completed: result.completed,
        pending: result.pending,
        skipped: result.skipped,
        failed: result.failed,
      });

      return result;
    } catch (error) {
      logger.error("Withdrawal reversal scheduler run failed:", error);

      return {
        failed: true,
        errorMessage: error.message || "Withdrawal reversal scheduler failed.",
      };
    } finally {
      WithdrawalReversalScheduler.isRunning = false;
    }
  }

  /* ---------- Start scheduler ---------- */
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

    logger.info("Withdrawal reversal scheduler started.", {
      intervalMinutes,
      olderThanMinutes,
      limit,
      completeSuccessfulTransfers,
      runImmediately,
    });

    if (runImmediately) {
      WithdrawalReversalScheduler.runOnce({
        olderThanMinutes,
        limit,
        completeSuccessfulTransfers,
      });
    }

    WithdrawalReversalScheduler.intervalHandle = setInterval(() => {
      WithdrawalReversalScheduler.runOnce({
        olderThanMinutes,
        limit,
        completeSuccessfulTransfers,
      });
    }, intervalMs);

    return WithdrawalReversalScheduler.intervalHandle;
  }

  /* ---------- Stop scheduler ---------- */
  static stop() {
    if (!WithdrawalReversalScheduler.intervalHandle) {
      return;
    }

    clearInterval(WithdrawalReversalScheduler.intervalHandle);

    WithdrawalReversalScheduler.intervalHandle = null;
    WithdrawalReversalScheduler.isRunning = false;

    logger.info("Withdrawal reversal scheduler stopped.");
  }
}

module.exports = WithdrawalReversalScheduler;
