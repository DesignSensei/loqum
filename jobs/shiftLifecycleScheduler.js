// jobs/shiftLifecycleScheduler.js

const ShiftLifecycleService = require("../services/shiftLifecycleService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_LIFECYCLE_LIMIT = 100;

/**
 * SHIFT LIFECYCLE SCHEDULER
 *
 * This scheduler is the periodic trigger for automatic Shift lifecycle
 * deadlines.
 *
 * It delegates lifecycle authority to ShiftLifecycleService.
 *
 * It may trigger:
 *
 * - expiration of unpaid pending-funding Shifts whose scheduled start has
 *   been reached; and
 * - finalization of funded unassigned / replacement-required occurrences
 *   whose persisted unfilledFinalizationAt deadline has been reached.
 *
 * ShiftLifecycleService owns all resulting lifecycle mutations and invokes
 * ShiftOccurrenceReconciliationService after affected occurrence truth has
 * changed.
 *
 * This scheduler does not:
 *
 * - calculate or backfill lifecycle deadlines;
 * - mutate Shift or ShiftOccurrence documents directly;
 * - rebuild parent Shift summaries;
 * - execute employer refunds;
 * - process professional settlement batches; or
 * - reverse withdrawals.
 */

class ShiftLifecycleScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ─────────────────────────────── CONFIGURATION ─────────────────────────────── */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    const normalizedIntervalMinutes = Number(intervalMinutes);

    if (!Number.isFinite(normalizedIntervalMinutes) || normalizedIntervalMinutes <= 0) {
      throw new Error("Shift lifecycle scheduler interval must be greater than zero.");
    }

    return normalizedIntervalMinutes * 60 * 1000;
  }

  /* ─────────────────────────────── RUN ONCE ─────────────────────────────── */

  static async runOnce({ currentTime = new Date(), limit = DEFAULT_LIFECYCLE_LIMIT } = {}) {
    if (ShiftLifecycleScheduler.isRunning) {
      logger.info("Shift lifecycle scheduler skipped because the previous run is still active.");

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    ShiftLifecycleScheduler.isRunning = true;

    try {
      logger.info("Shift lifecycle scheduler run started.", {
        currentTime,
        limit,
      });

      const result = await ShiftLifecycleService.runLifecycleDeadlineCycle({
        now: currentTime,
        limit,
      });

      logger.info("Shift lifecycle scheduler run completed.", {
        checked: result.checked || 0,
        expired: result.expired || 0,
        failed: result.failed || 0,

        unfundedChecked: result.unfundedExpiration?.checked || 0,
        unfundedExpired: result.unfundedExpiration?.expired || 0,
        unfundedFailed: result.unfundedExpiration?.failed || 0,

        unfilledChecked: result.unfilledOccurrenceExpiration?.checked || 0,
        unfilledExpired: result.unfilledOccurrenceExpiration?.expired || 0,
        unfilledSkipped: result.unfilledOccurrenceExpiration?.skipped || 0,
        unfilledFailed: result.unfilledOccurrenceExpiration?.failed || 0,
      });

      return result;
    } catch (error) {
      logger.error("Shift lifecycle scheduler run failed:", error);

      return {
        failed: true,
        errorCode: error.code || "SHIFT_LIFECYCLE_SCHEDULER_FAILED",
        errorMessage: error.message || "Shift lifecycle scheduler failed.",
      };
    } finally {
      ShiftLifecycleScheduler.isRunning = false;
    }
  }

  /* ─────────────────────────────── START ─────────────────────────────── */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    limit = DEFAULT_LIFECYCLE_LIMIT,
    runImmediately = false,
  } = {}) {
    if (ShiftLifecycleScheduler.intervalHandle) {
      logger.info("Shift lifecycle scheduler is already running.");

      return ShiftLifecycleScheduler.intervalHandle;
    }

    const intervalMs = ShiftLifecycleScheduler.getIntervalMs(intervalMinutes);

    if (typeof runImmediately !== "boolean") {
      throw new Error("Shift lifecycle scheduler run-immediately option must be true or false.");
    }

    logger.info("Shift lifecycle scheduler started.", {
      intervalMinutes,
      limit,
      runImmediately,
    });

    if (runImmediately) {
      void ShiftLifecycleScheduler.runOnce({
        limit,
      });
    }

    ShiftLifecycleScheduler.intervalHandle = setInterval(() => {
      void ShiftLifecycleScheduler.runOnce({
        limit,
      });
    }, intervalMs);

    return ShiftLifecycleScheduler.intervalHandle;
  }

  /* ─────────────────────────────── STOP ─────────────────────────────── */

  static stop() {
    if (!ShiftLifecycleScheduler.intervalHandle) {
      return;
    }

    clearInterval(ShiftLifecycleScheduler.intervalHandle);

    ShiftLifecycleScheduler.intervalHandle = null;

    logger.info("Shift lifecycle scheduler stopped.");
  }
}

module.exports = ShiftLifecycleScheduler;
