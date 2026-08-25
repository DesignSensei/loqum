// jobs/shiftOccurrenceReconciliationScheduler.js

const ShiftOccurrenceReconciliationService = require("../services/shiftOccurrenceReconciliationService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_DEADLINE_BACKFILL_LIMIT = 100;
const DEFAULT_EXPIRATION_LIMIT = 100;
const DEFAULT_REFUND_LIMIT = 100;

class ShiftOccurrenceReconciliationScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ---------- Get interval in milliseconds ---------- */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    return intervalMinutes * 60 * 1000;
  }

  /* ---------- Run one scheduler pass ---------- */

  static async runOnce({
    currentTime = new Date(),
    deadlineBackfillLimit = DEFAULT_DEADLINE_BACKFILL_LIMIT,
    expirationLimit = DEFAULT_EXPIRATION_LIMIT,
    refundLimit = DEFAULT_REFUND_LIMIT,
  } = {}) {
    if (ShiftOccurrenceReconciliationScheduler.isRunning) {
      logger.info(
        "Shift occurrence reconciliation scheduler skipped because previous run is still active."
      );

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    ShiftOccurrenceReconciliationScheduler.isRunning = true;

    try {
      logger.info("Shift occurrence reconciliation scheduler run started.", {
        currentTime,
        deadlineBackfillLimit,
        expirationLimit,
        refundLimit,
      });

      const result = await ShiftOccurrenceReconciliationService.runReconciliationCycle({
        currentTime,
        deadlineBackfillLimit,
        expirationLimit,
        refundLimit,
      });

      logger.info("Shift occurrence reconciliation scheduler run completed.", {
        deadlineBackfillInspected: result.deadlineBackfill?.inspectedCount || 0,

        deadlineBackfillUpdated: result.deadlineBackfill?.updatedCount || 0,

        expirationInspected: result.expiration?.inspectedCount || 0,

        expired: result.expiration?.expiredCount || 0,

        expirationRefundAttempts: result.expiration?.refundAttemptCount || 0,

        expirationRefundDeferred: result.expiration?.refundDeferredCount || 0,

        expirationFailed: result.expiration?.failedCount || 0,

        refundInspected: result.refunds?.inspectedCount || 0,

        refunded: result.refunds?.refundedCount || 0,

        refundIdempotent: result.refunds?.idempotentCount || 0,

        refundFailed: result.refunds?.failedCount || 0,
      });

      return result;
    } catch (error) {
      logger.error("Shift occurrence reconciliation scheduler run failed:", error);

      return {
        failed: true,

        errorCode: error.code || "SHIFT_OCCURRENCE_RECONCILIATION_SCHEDULER_FAILED",

        errorMessage: error.message || "Shift occurrence reconciliation scheduler failed.",
      };
    } finally {
      ShiftOccurrenceReconciliationScheduler.isRunning = false;
    }
  }

  /* ---------- Start scheduler ---------- */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    deadlineBackfillLimit = DEFAULT_DEADLINE_BACKFILL_LIMIT,
    expirationLimit = DEFAULT_EXPIRATION_LIMIT,
    refundLimit = DEFAULT_REFUND_LIMIT,
    runImmediately = false,
  } = {}) {
    if (ShiftOccurrenceReconciliationScheduler.intervalHandle) {
      logger.info("Shift occurrence reconciliation scheduler is already running.");

      return ShiftOccurrenceReconciliationScheduler.intervalHandle;
    }

    const intervalMs = ShiftOccurrenceReconciliationScheduler.getIntervalMs(intervalMinutes);

    logger.info("Shift occurrence reconciliation scheduler started.", {
      intervalMinutes,
      deadlineBackfillLimit,
      expirationLimit,
      refundLimit,
      runImmediately,
    });

    if (runImmediately) {
      void ShiftOccurrenceReconciliationScheduler.runOnce({
        deadlineBackfillLimit,
        expirationLimit,
        refundLimit,
      });
    }

    ShiftOccurrenceReconciliationScheduler.intervalHandle = setInterval(() => {
      void ShiftOccurrenceReconciliationScheduler.runOnce({
        deadlineBackfillLimit,
        expirationLimit,
        refundLimit,
      });
    }, intervalMs);

    return ShiftOccurrenceReconciliationScheduler.intervalHandle;
  }

  /* ---------- Stop scheduler ---------- */

  static stop() {
    if (!ShiftOccurrenceReconciliationScheduler.intervalHandle) {
      return;
    }

    clearInterval(ShiftOccurrenceReconciliationScheduler.intervalHandle);

    ShiftOccurrenceReconciliationScheduler.intervalHandle = null;
    ShiftOccurrenceReconciliationScheduler.isRunning = false;

    logger.info("Shift occurrence reconciliation scheduler stopped.");
  }
}

module.exports = ShiftOccurrenceReconciliationScheduler;
