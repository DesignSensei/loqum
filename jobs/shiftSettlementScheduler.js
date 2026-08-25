// jobs/shiftSettlementScheduler.js

const ShiftSettlementService = require("../services/shiftSettlementService");

const ShiftSettlementBatchService = require("../services/shiftSettlementBatchService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_APPROVAL_LIMIT = 100;
const DEFAULT_REFUND_LIMIT = 100;
const DEFAULT_BATCH_OCCURRENCE_LIMIT = 1000;
const DEFAULT_BATCH_PROCESSING_LIMIT = 100;
const DEFAULT_MAXIMUM_PROCESSING_ATTEMPTS = 5;
const DEFAULT_STALE_PROCESSING_MINUTES = 30;

class ShiftSettlementScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ---------- Get interval in milliseconds ---------- */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    return intervalMinutes * 60 * 1000;
  }

  /* ---------- Run one scheduler pass ---------- */

  static async runOnce({
    currentTime = new Date(),
    approvalLimit = DEFAULT_APPROVAL_LIMIT,
    refundLimit = DEFAULT_REFUND_LIMIT,
    batchOccurrenceLimit = DEFAULT_BATCH_OCCURRENCE_LIMIT,
    batchProcessingLimit = DEFAULT_BATCH_PROCESSING_LIMIT,
    maximumProcessingAttempts = DEFAULT_MAXIMUM_PROCESSING_ATTEMPTS,
    staleProcessingMinutes = DEFAULT_STALE_PROCESSING_MINUTES,
    payoutPolicy = {},
  } = {}) {
    if (ShiftSettlementScheduler.isRunning) {
      logger.info("Shift settlement scheduler skipped because previous run is still active.");

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    ShiftSettlementScheduler.isRunning = true;

    try {
      const normalizedCurrentTime = new Date(currentTime);

      if (Number.isNaN(normalizedCurrentTime.getTime())) {
        throw new Error("Shift settlement scheduler current time is invalid.");
      }

      const staleBefore = new Date(
        normalizedCurrentTime.getTime() - staleProcessingMinutes * 60 * 1000
      );

      logger.info("Shift settlement scheduler run started.", {
        currentTime: normalizedCurrentTime,
        approvalLimit,
        refundLimit,
        batchOccurrenceLimit,
        batchProcessingLimit,
        maximumProcessingAttempts,
        staleProcessingMinutes,
        payoutPolicy,
      });

      const staleRecovery = await ShiftSettlementBatchService.recoverStaleProcessingBatches({
        staleBefore,
        limit: batchProcessingLimit,
      });

      const approvals = await ShiftSettlementService.approveDueOccurrences({
        now: normalizedCurrentTime,
        limit: approvalLimit,
        payoutPolicy,
      });

      const refunds = await ShiftSettlementService.processPendingSettlementRefunds({
        now: normalizedCurrentTime,
        limit: refundLimit,
      });

      const batchCreation = await ShiftSettlementBatchService.createDueSettlementBatches({
        now: normalizedCurrentTime,
        occurrenceLimit: batchOccurrenceLimit,
      });

      const batchProcessing = await ShiftSettlementBatchService.processDueBatches({
        now: normalizedCurrentTime,
        limit: batchProcessingLimit,
        maximumAttempts: maximumProcessingAttempts,
      });

      const result = {
        currentTime: normalizedCurrentTime,
        staleBefore,
        staleRecovery,
        approvals,
        refunds,
        batchCreation,
        batchProcessing,
      };

      logger.info("Shift settlement scheduler run completed.", {
        staleInspected: staleRecovery.inspected || 0,

        staleRecovered: staleRecovery.recovered || 0,

        approvalInspected: approvals.inspected || 0,

        approved: approvals.approved?.length || 0,

        approvalRejected: approvals.rejected?.length || 0,

        refundInspected: refunds.inspected || 0,

        refunded: refunds.refunded?.length || 0,

        refundFailed: refunds.failed?.length || 0,

        batchOccurrenceInspected: batchCreation.inspectedOccurrenceCount || 0,

        batchGroups: batchCreation.groupCount || 0,

        batchesCreated: batchCreation.created?.length || 0,

        batchesUpdated: batchCreation.updated?.length || 0,

        batchesDeferred: batchCreation.deferred?.length || 0,

        batchCreationFailed: batchCreation.failed?.length || 0,

        batchesInspected: batchProcessing.inspected || 0,

        batchesReleased: batchProcessing.released?.length || 0,

        batchReleaseFailed: batchProcessing.failed?.length || 0,
      });

      return result;
    } catch (error) {
      logger.error("Shift settlement scheduler run failed:", error);

      return {
        failed: true,

        errorCode: error.code || "SHIFT_SETTLEMENT_SCHEDULER_FAILED",

        errorMessage: error.message || "Shift settlement scheduler failed.",
      };
    } finally {
      ShiftSettlementScheduler.isRunning = false;
    }
  }

  /* ---------- Start scheduler ---------- */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    approvalLimit = DEFAULT_APPROVAL_LIMIT,
    refundLimit = DEFAULT_REFUND_LIMIT,
    batchOccurrenceLimit = DEFAULT_BATCH_OCCURRENCE_LIMIT,
    batchProcessingLimit = DEFAULT_BATCH_PROCESSING_LIMIT,
    maximumProcessingAttempts = DEFAULT_MAXIMUM_PROCESSING_ATTEMPTS,
    staleProcessingMinutes = DEFAULT_STALE_PROCESSING_MINUTES,
    payoutPolicy = {},
    runImmediately = false,
  } = {}) {
    if (ShiftSettlementScheduler.intervalHandle) {
      logger.info("Shift settlement scheduler is already running.");

      return ShiftSettlementScheduler.intervalHandle;
    }

    const intervalMs = ShiftSettlementScheduler.getIntervalMs(intervalMinutes);

    logger.info("Shift settlement scheduler started.", {
      intervalMinutes,
      approvalLimit,
      refundLimit,
      batchOccurrenceLimit,
      batchProcessingLimit,
      maximumProcessingAttempts,
      staleProcessingMinutes,
      payoutPolicy,
      runImmediately,
    });

    const runOptions = {
      approvalLimit,
      refundLimit,
      batchOccurrenceLimit,
      batchProcessingLimit,
      maximumProcessingAttempts,
      staleProcessingMinutes,
      payoutPolicy,
    };

    if (runImmediately) {
      void ShiftSettlementScheduler.runOnce(runOptions);
    }

    ShiftSettlementScheduler.intervalHandle = setInterval(() => {
      void ShiftSettlementScheduler.runOnce(runOptions);
    }, intervalMs);

    return ShiftSettlementScheduler.intervalHandle;
  }

  /* ---------- Stop scheduler ---------- */

  static stop() {
    if (!ShiftSettlementScheduler.intervalHandle) {
      return;
    }

    clearInterval(ShiftSettlementScheduler.intervalHandle);

    ShiftSettlementScheduler.intervalHandle = null;
    ShiftSettlementScheduler.isRunning = false;

    logger.info("Shift settlement scheduler stopped.");
  }
}

module.exports = ShiftSettlementScheduler;
