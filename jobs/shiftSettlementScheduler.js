// jobs/shiftSettlementScheduler.js

const ShiftOccurrence = require("../models/ShiftOccurrence");

const ShiftSettlementService = require("../services/shiftSettlementService");
const ShiftSettlementBatchService = require("../services/shiftSettlementBatchService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_RELEASE_READINESS_LIMIT = 100;
const DEFAULT_BATCH_OCCURRENCE_LIMIT = 1000;
const DEFAULT_BATCH_PROCESSING_LIMIT = 100;
const DEFAULT_MAXIMUM_PROCESSING_ATTEMPTS = 5;
const DEFAULT_STALE_PROCESSING_MINUTES = 30;

/**
 * SHIFT SETTLEMENT SCHEDULER
 *
 * This scheduler periodically advances professional settlement execution.
 *
 * It owns timing/orchestration only.
 *
 * It may:
 *
 * - discover occurrences whose shared challenge window has reached its
 *   authoritative deadline;
 * - hand those occurrences to ShiftSettlementService for component-specific
 *   release-readiness evaluation;
 * - recover stale settlement-batch processing locks;
 * - ask ShiftSettlementBatchService to create due professional payout batches;
 * - ask ShiftSettlementBatchService to process due professional payout batches;
 *   and
 * - prevent overlapping scheduler passes.
 *
 * It does not:
 *
 * - decide BASE or overtime professional entitlement;
 * - decide whether a settlement component is final;
 * - bypass an active professional claim or employer dispute;
 * - mutate settlement-component state directly;
 * - execute employer refunds;
 * - earn or collect platform fees;
 * - calculate overtime;
 * - fund overtime;
 * - reconcile parent Shift lifecycle state; or
 * - move professional payout funds directly.
 *
 * RELEASE-READINESS POLICY
 *
 * The scheduler only discovers expired shared challenge windows.
 *
 * ShiftSettlementService remains authoritative for:
 *
 * - synchronizing the expired challenge window;
 * - determining which BASE / overtime components are payable;
 * - determining which components remain blocked by active case issues;
 * - determining whether funded overtime handoff is complete;
 * - marking safe components approved_for_release; and
 * - assigning their scheduled payout time.
 *
 * EMPLOYER REFUNDS
 *
 * Employer refund processing is intentionally absent from this scheduler.
 *
 * ShiftSettlementService does not own employer refund execution, and
 * ShiftSettlementBatchService batches professional payouts only.
 */

class ShiftSettlementScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeDate(value, fieldName = "date") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Shift settlement scheduler ${fieldName} is invalid.`);
    }

    return date;
  }

  static normalizePositiveInteger(value, fieldName, maximum = 10000) {
    const normalizedValue = Number(value);

    if (
      !Number.isSafeInteger(normalizedValue) ||
      normalizedValue < 1 ||
      normalizedValue > maximum
    ) {
      throw new Error(
        `Shift settlement scheduler ${fieldName} must be a whole number between 1 and ${maximum}.`
      );
    }

    return normalizedValue;
  }

  static normalizePayoutPolicy(value) {
    if (value === null || value === undefined) {
      return {};
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Shift settlement scheduler payout policy must be an object.");
    }

    return value;
  }

  /* ─────────────────────────────── INTERVAL ─────────────────────────────── */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    const normalizedIntervalMinutes = ShiftSettlementScheduler.normalizePositiveInteger(
      intervalMinutes,
      "interval minutes",
      24 * 60
    );

    return normalizedIntervalMinutes * 60 * 1000;
  }

  /* ─────────────────────────────── RELEASE-READINESS DISCOVERY ─────────────────────────────── */

  static async processExpiredChallengeWindows({ currentTime, limit, payoutPolicy }) {
    const candidates = await ShiftOccurrence.find({
      assignmentStatus: "assigned",

      assignedProfessional: {
        $ne: null,
      },

      assignment: {
        $ne: null,
      },

      assignedAt: {
        $ne: null,
      },

      settlementStatus: "pending_review",

      challengeWindowOpenedAt: {
        $ne: null,
      },

      challengeDeadlineAt: {
        $ne: null,
        $lte: currentTime,
      },

      challengeWindowClosedAt: null,

      "challengeableSettlementComponents.0": {
        $exists: true,
      },

      $or: [
        {
          status: "pending_settlement",
          attendanceStatus: "checked_out",
        },

        {
          status: "cancelled",
          "cancellationCompensation.applicable": true,
        },
      ],
    })
      .select("_id referenceCode challengeDeadlineAt activeClaim activeDispute")
      .sort({
        challengeDeadlineAt: 1,
        _id: 1,
      })
      .limit(limit)
      .lean();

    const results = {
      inspected: candidates.length,

      evaluated: [],
      deferred: [],
      failed: [],

      readyComponentCount: 0,
      newlyReadyComponentCount: 0,
      idempotentReadyComponentCount: 0,
      skippedComponentCount: 0,
    };

    for (const candidate of candidates) {
      try {
        const result = await ShiftSettlementService.markOccurrenceReadyForRelease({
          occurrenceId: candidate._id,

          releaseSource: "automatic",
          releasedByUserId: null,

          readyAt: currentTime,

          payoutPolicy,
        });

        const componentResults = Array.isArray(result?.componentResults)
          ? result.componentResults
          : [];

        const readyComponents = componentResults.filter((item) => item?.ready === true);

        const newlyReadyComponents = readyComponents.filter((item) => item?.idempotent !== true);

        const idempotentReadyComponents = readyComponents.filter(
          (item) => item?.idempotent === true
        );

        const skippedComponents = componentResults.filter((item) => item?.skipped === true);

        results.readyComponentCount += readyComponents.length;

        results.newlyReadyComponentCount += newlyReadyComponents.length;

        results.idempotentReadyComponentCount += idempotentReadyComponents.length;

        results.skippedComponentCount += skippedComponents.length;

        results.evaluated.push({
          occurrenceId: String(candidate._id),

          referenceCode: candidate.referenceCode,

          challengeDeadlineAt: candidate.challengeDeadlineAt,

          readyComponents: readyComponents.map((item) => ({
            component: item.component,
            idempotent: item.idempotent === true,
            scheduledPayoutAt: item.scheduledPayoutAt || null,
          })),

          skippedComponents: skippedComponents.map((item) => ({
            component: item.component,
            reason: item.reason || "not_ready",
          })),

          idempotent: result?.idempotent === true,
        });
      } catch (error) {
        const failure = {
          occurrenceId: String(candidate._id),

          referenceCode: candidate.referenceCode,

          challengeDeadlineAt: candidate.challengeDeadlineAt,

          code: error.code || "SETTLEMENT_RELEASE_READINESS_EVALUATION_FAILED",

          message: error.message || "Settlement release-readiness evaluation failed.",
        };

        if (Number(error?.statusCode) === 409) {
          results.deferred.push(failure);

          logger.info(
            `Automatic settlement release-readiness deferred for occurrence ` +
              `${candidate.referenceCode}: ` +
              `${failure.code} - ${failure.message}`
          );

          continue;
        }

        results.failed.push(failure);

        logger.error(
          `Automatic settlement release-readiness failed for occurrence ` +
            `${candidate.referenceCode}: ` +
            `${failure.code} - ${failure.message}`
        );
      }
    }

    return results;
  }

  /* ─────────────────────────────── RUN ONCE ─────────────────────────────── */

  static async runOnce({
    currentTime = new Date(),

    releaseReadinessLimit = DEFAULT_RELEASE_READINESS_LIMIT,

    batchOccurrenceLimit = DEFAULT_BATCH_OCCURRENCE_LIMIT,

    batchProcessingLimit = DEFAULT_BATCH_PROCESSING_LIMIT,

    maximumProcessingAttempts = DEFAULT_MAXIMUM_PROCESSING_ATTEMPTS,

    staleProcessingMinutes = DEFAULT_STALE_PROCESSING_MINUTES,

    payoutPolicy = {},
  } = {}) {
    if (ShiftSettlementScheduler.isRunning) {
      logger.info("Shift settlement scheduler skipped because the previous run is still active.");

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    ShiftSettlementScheduler.isRunning = true;

    try {
      const normalizedCurrentTime = ShiftSettlementScheduler.normalizeDate(
        currentTime,
        "current time"
      );

      const normalizedReleaseReadinessLimit = ShiftSettlementScheduler.normalizePositiveInteger(
        releaseReadinessLimit,
        "release-readiness limit",
        1000
      );

      const normalizedBatchOccurrenceLimit = ShiftSettlementScheduler.normalizePositiveInteger(
        batchOccurrenceLimit,
        "batch occurrence limit",
        10000
      );

      const normalizedBatchProcessingLimit = ShiftSettlementScheduler.normalizePositiveInteger(
        batchProcessingLimit,
        "batch processing limit",
        1000
      );

      const normalizedMaximumProcessingAttempts = ShiftSettlementScheduler.normalizePositiveInteger(
        maximumProcessingAttempts,
        "maximum processing attempts",
        20
      );

      const normalizedStaleProcessingMinutes = ShiftSettlementScheduler.normalizePositiveInteger(
        staleProcessingMinutes,
        "stale processing minutes",
        7 * 24 * 60
      );

      const normalizedPayoutPolicy = ShiftSettlementScheduler.normalizePayoutPolicy(payoutPolicy);

      const staleBefore = new Date(
        normalizedCurrentTime.getTime() - normalizedStaleProcessingMinutes * 60 * 1000
      );

      logger.info("Shift settlement scheduler run started.", {
        currentTime: normalizedCurrentTime,

        releaseReadinessLimit: normalizedReleaseReadinessLimit,

        batchOccurrenceLimit: normalizedBatchOccurrenceLimit,

        batchProcessingLimit: normalizedBatchProcessingLimit,

        maximumProcessingAttempts: normalizedMaximumProcessingAttempts,

        staleProcessingMinutes: normalizedStaleProcessingMinutes,

        payoutPolicy: normalizedPayoutPolicy,
      });

      /*
       * Recover stale locks first so a previously interrupted batch may
       * become eligible for normal retry during this same scheduler pass.
       */
      const staleRecovery = await ShiftSettlementBatchService.recoverStaleProcessingBatches({
        staleBefore,

        limit: normalizedBatchProcessingLimit,
      });

      /*
       * Close due shared challenge windows and ask the settlement service
       * which components may now become approved_for_release.
       */
      const releaseReadiness = await ShiftSettlementScheduler.processExpiredChallengeWindows({
        currentTime: normalizedCurrentTime,

        limit: normalizedReleaseReadinessLimit,

        payoutPolicy: normalizedPayoutPolicy,
      });

      /*
       * Batch only components already made authoritative and
       * approved_for_release by ShiftSettlementService.
       */
      const batchCreation = await ShiftSettlementBatchService.createDueSettlementBatches({
        now: normalizedCurrentTime,

        occurrenceLimit: normalizedBatchOccurrenceLimit,
      });

      /*
       * Execute only professional payout batches whose scheduled execution
       * time has been reached.
       */
      const batchProcessing = await ShiftSettlementBatchService.processDueBatches({
        now: normalizedCurrentTime,

        limit: normalizedBatchProcessingLimit,

        maximumAttempts: normalizedMaximumProcessingAttempts,
      });

      const result = {
        currentTime: normalizedCurrentTime,

        staleBefore,

        staleRecovery,

        releaseReadiness,

        batchCreation,

        batchProcessing,
      };

      logger.info("Shift settlement scheduler run completed.", {
        staleInspected: staleRecovery?.inspected || 0,

        staleRecovered: staleRecovery?.recovered || 0,

        releaseReadinessInspected: releaseReadiness?.inspected || 0,

        releaseReadinessEvaluated: releaseReadiness?.evaluated?.length || 0,

        releaseReadinessDeferred: releaseReadiness?.deferred?.length || 0,

        releaseReadinessFailed: releaseReadiness?.failed?.length || 0,

        readyComponents: releaseReadiness?.readyComponentCount || 0,

        newlyReadyComponents: releaseReadiness?.newlyReadyComponentCount || 0,

        idempotentReadyComponents: releaseReadiness?.idempotentReadyComponentCount || 0,

        skippedComponents: releaseReadiness?.skippedComponentCount || 0,

        batchComponentsInspected: batchCreation?.inspectedComponentCount || 0,

        batchGroups: batchCreation?.groupCount || 0,

        batchesCreated: batchCreation?.created?.length || 0,

        batchesUpdated: batchCreation?.updated?.length || 0,

        batchesDeferred: batchCreation?.deferred?.length || 0,

        batchCreationFailed: batchCreation?.failed?.length || 0,

        batchesInspected: batchProcessing?.inspected || 0,

        batchesReleased: batchProcessing?.released?.length || 0,

        batchReleaseFailed: batchProcessing?.failed?.length || 0,
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

  /* ─────────────────────────────── START ─────────────────────────────── */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,

    releaseReadinessLimit = DEFAULT_RELEASE_READINESS_LIMIT,

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

    if (typeof runImmediately !== "boolean") {
      throw new Error("Shift settlement scheduler run-immediately option must be true or false.");
    }

    logger.info("Shift settlement scheduler started.", {
      intervalMinutes,

      releaseReadinessLimit,

      batchOccurrenceLimit,

      batchProcessingLimit,

      maximumProcessingAttempts,

      staleProcessingMinutes,

      payoutPolicy,

      runImmediately,
    });

    const runOptions = {
      releaseReadinessLimit,

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

  /* ─────────────────────────────── STOP ─────────────────────────────── */

  static stop() {
    if (!ShiftSettlementScheduler.intervalHandle) {
      return;
    }

    clearInterval(ShiftSettlementScheduler.intervalHandle);

    ShiftSettlementScheduler.intervalHandle = null;

    logger.info("Shift settlement scheduler stopped.");
  }
}

module.exports = ShiftSettlementScheduler;
