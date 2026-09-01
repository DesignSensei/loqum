// jobs/employerRefundBatchScheduler.js

const EmployerRefundBatch = require("../models/EmployerRefundBatch");

const EmployerRefundBatchService = require("../services/employerRefundBatchService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;

const DEFAULT_PROCESSING_LIMIT = 100;
const DEFAULT_RECONCILIATION_LIMIT = 100;

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RECONCILIATION_MIN_AGE_MS = 5 * 60 * 1000;

const ACTIVE_PROVIDER_LINE_STATUSES = Object.freeze(["pending_provider", "awaiting_action"]);

/**
 * EMPLOYER REFUND BATCH SCHEDULER
 *
 * This scheduler owns periodic orchestration for already-created
 * EmployerRefundBatch records.
 *
 * It has two independent passes:
 *
 * 1. ordinary batch execution/recovery; and
 * 2. unresolved Paystack refund reconciliation.
 *
 * ORDINARY BATCH EXECUTION
 *
 * The scheduler may:
 *
 * - discover scheduled batches whose scheduledFor time has been reached;
 * - rediscover processing batches whose execution lock is stale or missing;
 * - hand each eligible batch to EmployerRefundBatchService.processBatch(); and
 * - prevent overlapping scheduler passes in this process.
 *
 * PROVIDER RECONCILIATION
 *
 * The scheduler also calls
 * EmployerRefundBatchService.reconcilePendingPaystackRefunds().
 *
 * EmployerRefundBatchService owns:
 *
 * - deciding which Paystack lines actually require reconciliation;
 * - minimum-age checks;
 * - original refund reconciliation;
 * - Retry Refund reconciliation;
 * - provider-state synchronization;
 * - needs_attention handling;
 * - terminal success;
 * - conclusive failure; and
 * - automatic Loqum-wallet fallback.
 *
 * This scheduler never queries Paystack directly and never implements provider
 * state transitions itself.
 *
 * ShiftRefundService.reconciliationRequired is a different signal: it means
 * authoritative occurrence-level refund truth conflicts with an execution that
 * has already crossed the batching/execution boundary. This scheduler does not
 * treat that signal as ordinary Paystack polling.
 *
 * WEEKLY BATCH CREATION
 *
 * This scheduler intentionally does not create weekly refund batches.
 * Weekly-cycle creation remains a separate orchestration concern. This file
 * only processes already-created batches and reconciles their async Paystack
 * execution state.
 *
 * ASYNC PROVIDER / EMPLOYER-ACTION STATES
 *
 * Ordinary batch execution does not repeatedly reacquire a processing batch
 * containing pending_provider or awaiting_action lines.
 *
 * Those lines are handled by:
 *
 * - Paystack webhooks;
 * - the reconciliation pass in this scheduler; or
 * - employer bank confirmation where needs_attention requires it.
 *
 * This scheduler does not:
 *
 * - create EmployerRefund obligations;
 * - decide refund entitlement;
 * - mutate EmployerRefund or ShiftOccurrence directly;
 * - call Paystack directly;
 * - credit employer wallets directly;
 * - perform professional settlement; or
 * - adjudicate claims or disputes.
 */

class EmployerRefundBatchScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeDate(value, fieldName = "current time") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Employer refund batch scheduler ${fieldName} is invalid.`);
    }

    return date;
  }

  static normalizePositiveInteger(value, fieldName, maximum = null) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 1) {
      throw new Error(
        `Employer refund batch scheduler ${fieldName} must be a positive whole number.`
      );
    }

    if (maximum !== null && normalizedValue > maximum) {
      throw new Error(`Employer refund batch scheduler ${fieldName} cannot exceed ${maximum}.`);
    }

    return normalizedValue;
  }

  static normalizeNonNegativeInteger(value, fieldName, maximum = null) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 0) {
      throw new Error(
        `Employer refund batch scheduler ${fieldName} must be a non-negative whole number.`
      );
    }

    if (maximum !== null && normalizedValue > maximum) {
      throw new Error(`Employer refund batch scheduler ${fieldName} cannot exceed ${maximum}.`);
    }

    return normalizedValue;
  }

  /* ─────────────────────────────── INTERVAL ─────────────────────────────── */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    const normalizedIntervalMinutes = EmployerRefundBatchScheduler.normalizePositiveInteger(
      intervalMinutes,
      "interval minutes",
      24 * 60
    );

    return normalizedIntervalMinutes * 60 * 1000;
  }

  /* ─────────────────────────────── DUE BATCH DISCOVERY ─────────────────────────────── */

  static async getDueBatches({ currentTime, limit }) {
    return EmployerRefundBatch.find({
      $or: [
        /*
         * Normal first execution.
         */
        {
          status: "scheduled",

          scheduledFor: {
            $lte: currentTime,
          },
        },

        /*
         * Recovery of a processing batch whose worker lock expired or
         * disappeared before ordinary execution finished.
         *
         * pending_provider and awaiting_action are intentionally excluded
         * from ordinary reacquisition. Their provider state is handled by the
         * reconciliation pass instead.
         */
        {
          status: "processing",

          "lines.status": {
            $nin: ACTIVE_PROVIDER_LINE_STATUSES,
          },

          $or: [
            {
              lockExpiresAt: {
                $lte: currentTime,
              },
            },

            {
              lockExpiresAt: null,
            },

            {
              lockExpiresAt: {
                $exists: false,
              },
            },

            {
              processingToken: null,
            },

            {
              processingToken: {
                $exists: false,
              },
            },
          ],
        },
      ],
    })
      .select("_id referenceCode business status scheduledFor lockExpiresAt attemptCount")
      .sort({
        scheduledFor: 1,
        attemptCount: 1,
        _id: 1,
      })
      .limit(limit)
      .lean();
  }

  /* ─────────────────────────────── PROCESS DUE BATCHES ─────────────────────────────── */

  static async processDueBatches({ currentTime, limit, lockTtlMs }) {
    const dueBatches = await EmployerRefundBatchScheduler.getDueBatches({
      currentTime,
      limit,
    });

    const result = {
      inspected: dueBatches.length,

      processed: [],
      deferred: [],
      failed: [],
    };

    for (const batch of dueBatches) {
      try {
        const processingResult = await EmployerRefundBatchService.processBatch({
          batchId: batch._id,
          currentTime,
          lockTtlMs,
        });

        if (processingResult?.processed === true) {
          result.processed.push({
            batchId: String(batch._id),

            referenceCode: batch.referenceCode,

            previousStatus: batch.status,

            finalStatus: processingResult.batch?.status || null,

            resultCount: Array.isArray(processingResult.results)
              ? processingResult.results.length
              : 0,
          });

          continue;
        }

        result.deferred.push({
          batchId: String(batch._id),

          referenceCode: batch.referenceCode,

          status: processingResult?.batch?.status || batch.status,

          reason: processingResult?.reason || "batch_not_processed",

          blockingLineId: processingResult?.blockingLineId || null,
        });
      } catch (error) {
        logger.error(`Employer refund batch ${batch.referenceCode} processing failed:`, error);

        result.failed.push({
          batchId: String(batch._id),

          referenceCode: batch.referenceCode,

          code: error.code || "EMPLOYER_REFUND_BATCH_PROCESSING_FAILED",

          message: error.message || "Employer refund batch processing failed.",
        });
      }
    }

    return result;
  }

  /* ─────────────────────────────── PAYSTACK RECONCILIATION ─────────────────────────────── */

  static async reconcilePendingPaystackRefunds({ currentTime, limit, minAgeMs }) {
    try {
      return await EmployerRefundBatchService.reconcilePendingPaystackRefunds({
        currentTime,
        limit,
        minAgeMs,
      });
    } catch (error) {
      logger.error("Employer refund Paystack reconciliation pass failed:", error);

      return {
        inspected: 0,
        reconciled: [],
        unresolved: [],
        skipped: [],
        failed: [
          {
            batchId: null,
            lineId: null,
            code: error.code || "EMPLOYER_REFUND_RECONCILIATION_PASS_FAILED",
            message: error.message || "Employer refund reconciliation pass failed.",
          },
        ],
        passFailed: true,
      };
    }
  }

  /* ─────────────────────────────── RUN ONCE ─────────────────────────────── */

  static async runOnce({
    currentTime = new Date(),

    processingLimit = DEFAULT_PROCESSING_LIMIT,

    reconciliationLimit = DEFAULT_RECONCILIATION_LIMIT,

    lockTtlMs = DEFAULT_LOCK_TTL_MS,

    reconciliationMinAgeMs = DEFAULT_RECONCILIATION_MIN_AGE_MS,
  } = {}) {
    if (EmployerRefundBatchScheduler.isRunning) {
      logger.info(
        "Employer refund batch scheduler skipped because the previous run is still active."
      );

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    EmployerRefundBatchScheduler.isRunning = true;

    try {
      const normalizedCurrentTime = EmployerRefundBatchScheduler.normalizeDate(
        currentTime,
        "current time"
      );

      const normalizedProcessingLimit = EmployerRefundBatchScheduler.normalizePositiveInteger(
        processingLimit,
        "processing limit",
        1000
      );

      const normalizedReconciliationLimit = EmployerRefundBatchScheduler.normalizePositiveInteger(
        reconciliationLimit,
        "reconciliation limit",
        1000
      );

      const normalizedLockTtlMs = EmployerRefundBatchScheduler.normalizePositiveInteger(
        lockTtlMs,
        "processing lock TTL milliseconds",
        24 * 60 * 60 * 1000
      );

      const normalizedReconciliationMinAgeMs =
        EmployerRefundBatchScheduler.normalizeNonNegativeInteger(
          reconciliationMinAgeMs,
          "reconciliation minimum age milliseconds",
          24 * 60 * 60 * 1000
        );

      logger.info("Employer refund batch scheduler run started.", {
        currentTime: normalizedCurrentTime,

        processingLimit: normalizedProcessingLimit,

        reconciliationLimit: normalizedReconciliationLimit,

        lockTtlMs: normalizedLockTtlMs,

        reconciliationMinAgeMs: normalizedReconciliationMinAgeMs,
      });

      /*
       * Run ordinary batch execution first.
       *
       * If a Paystack call in this pass becomes async/unresolved, the service
       * records a fresh attempt/sync timestamp. The minimum-age rule prevents
       * the reconciliation pass below from immediately polling the same refund
       * again during this scheduler tick.
       */
      const processing = await EmployerRefundBatchScheduler.processDueBatches({
        currentTime: normalizedCurrentTime,

        limit: normalizedProcessingLimit,

        lockTtlMs: normalizedLockTtlMs,
      });

      const reconciliation = await EmployerRefundBatchScheduler.reconcilePendingPaystackRefunds({
        currentTime: normalizedCurrentTime,

        limit: normalizedReconciliationLimit,

        minAgeMs: normalizedReconciliationMinAgeMs,
      });

      const result = {
        currentTime: normalizedCurrentTime,

        processing,

        reconciliation,
      };

      logger.info("Employer refund batch scheduler run completed.", {
        processingInspected: processing.inspected || 0,

        processed: processing.processed?.length || 0,

        processingDeferred: processing.deferred?.length || 0,

        processingFailed: processing.failed?.length || 0,

        reconciliationInspected: reconciliation.inspected || 0,

        reconciled: reconciliation.reconciled?.length || 0,

        reconciliationUnresolved: reconciliation.unresolved?.length || 0,

        reconciliationSkipped: reconciliation.skipped?.length || 0,

        reconciliationFailed: reconciliation.failed?.length || 0,
      });

      return result;
    } catch (error) {
      logger.error("Employer refund batch scheduler run failed:", error);

      return {
        failed: true,

        errorCode: error.code || "EMPLOYER_REFUND_BATCH_SCHEDULER_FAILED",

        errorMessage: error.message || "Employer refund batch scheduler failed.",
      };
    } finally {
      EmployerRefundBatchScheduler.isRunning = false;
    }
  }

  /* ─────────────────────────────── START ─────────────────────────────── */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,

    processingLimit = DEFAULT_PROCESSING_LIMIT,

    reconciliationLimit = DEFAULT_RECONCILIATION_LIMIT,

    lockTtlMs = DEFAULT_LOCK_TTL_MS,

    reconciliationMinAgeMs = DEFAULT_RECONCILIATION_MIN_AGE_MS,

    runImmediately = false,
  } = {}) {
    if (EmployerRefundBatchScheduler.intervalHandle) {
      logger.info("Employer refund batch scheduler is already running.");

      return EmployerRefundBatchScheduler.intervalHandle;
    }

    const intervalMs = EmployerRefundBatchScheduler.getIntervalMs(intervalMinutes);

    const normalizedProcessingLimit = EmployerRefundBatchScheduler.normalizePositiveInteger(
      processingLimit,
      "processing limit",
      1000
    );

    const normalizedReconciliationLimit = EmployerRefundBatchScheduler.normalizePositiveInteger(
      reconciliationLimit,
      "reconciliation limit",
      1000
    );

    const normalizedLockTtlMs = EmployerRefundBatchScheduler.normalizePositiveInteger(
      lockTtlMs,
      "processing lock TTL milliseconds",
      24 * 60 * 60 * 1000
    );

    const normalizedReconciliationMinAgeMs =
      EmployerRefundBatchScheduler.normalizeNonNegativeInteger(
        reconciliationMinAgeMs,
        "reconciliation minimum age milliseconds",
        24 * 60 * 60 * 1000
      );

    if (typeof runImmediately !== "boolean") {
      throw new Error(
        "Employer refund batch scheduler run-immediately option must be true or false."
      );
    }

    const runOptions = {
      processingLimit: normalizedProcessingLimit,

      reconciliationLimit: normalizedReconciliationLimit,

      lockTtlMs: normalizedLockTtlMs,

      reconciliationMinAgeMs: normalizedReconciliationMinAgeMs,
    };

    logger.info("Employer refund batch scheduler started.", {
      intervalMinutes,

      ...runOptions,

      runImmediately,
    });

    if (runImmediately) {
      void EmployerRefundBatchScheduler.runOnce(runOptions);
    }

    EmployerRefundBatchScheduler.intervalHandle = setInterval(() => {
      void EmployerRefundBatchScheduler.runOnce(runOptions);
    }, intervalMs);

    return EmployerRefundBatchScheduler.intervalHandle;
  }

  /* ─────────────────────────────── STOP ─────────────────────────────── */

  static stop() {
    if (!EmployerRefundBatchScheduler.intervalHandle) {
      return;
    }

    clearInterval(EmployerRefundBatchScheduler.intervalHandle);

    EmployerRefundBatchScheduler.intervalHandle = null;

    /*
     * Do not force isRunning to false here.
     *
     * stop() prevents future scheduler ticks but cannot cancel a
     * processBatch() or provider-reconciliation call already in progress.
     * The active scheduler pass releases its own overlap lock in finally.
     */

    logger.info("Employer refund batch scheduler stopped.");
  }
}

module.exports = EmployerRefundBatchScheduler;
