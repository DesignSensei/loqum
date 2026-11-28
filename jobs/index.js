// jobs/index.js

const ShiftLifecycleScheduler = require("./shiftLifecycleScheduler");
const ShiftSettlementScheduler = require("./shiftSettlementScheduler");
const WithdrawalReversalScheduler = require("./withdrawalReversalScheduler");
const EmployerRefundBatchScheduler = require("./employerRefundBatchScheduler");
const ProviderEventRetryScheduler = require("./providerEventRetryScheduler");
const SubscriptionLifecycleScheduler = require("./subscriptionLifecycleScheduler");
const FacilityPermitActivationScheduler = require("./facilityPermitActivationScheduler");

const logger = require("../utils/logger");

/**
 * BACKGROUND JOB REGISTRY
 *
 * Starts and stops background schedulers only.
 *
 * Each scheduler remains responsible for:
 *
 * - its own interval timer;
 * - preventing overlapping runs;
 * - its own processing lifecycle;
 * - its own start/stop behavior; and
 * - delegating business operations to the appropriate services.
 *
 * This registry does not:
 *
 * - process financial transactions;
 * - create processing claims;
 * - directly modify domain records; or
 * - own individual scheduler execution state.
 *
 * If scheduler startup fails, the registry attempts to
 * stop previously started schedulers before propagating
 * the original startup error.
 */

const backgroundSchedulers = [
  ShiftLifecycleScheduler,
  ShiftSettlementScheduler,
  WithdrawalReversalScheduler,
  EmployerRefundBatchScheduler,
  ProviderEventRetryScheduler,
  SubscriptionLifecycleScheduler,
  FacilityPermitActivationScheduler,
];

/* ─────────────────────────────── START BACKGROUND JOBS ─────────────────────────────── */

exports.startBackgroundJobs = function startBackgroundJobs() {
  logger.info("Background jobs starting.");

  try {
    ShiftLifecycleScheduler.start({
      intervalMinutes: 5,
      limit: 100,
      runImmediately: false,
    });

    ShiftSettlementScheduler.start({
      intervalMinutes: 5,
      releaseReadinessLimit: 100,
      batchOccurrenceLimit: 1000,
      batchProcessingLimit: 100,
      maximumProcessingAttempts: 5,
      staleProcessingMinutes: 30,
      payoutPolicy: {},
      runImmediately: false,
    });

    WithdrawalReversalScheduler.start({
      intervalMinutes: 10,
      olderThanMinutes: 30,
      limit: 50,
      completeSuccessfulTransfers: true,
      runImmediately: false,
    });

    EmployerRefundBatchScheduler.start({
      intervalMinutes: 5,
      processingLimit: 100,
      reconciliationLimit: 100,
      lockTtlMs: 5 * 60 * 1000,
      reconciliationMinAgeMs: 5 * 60 * 1000,
      runImmediately: false,
    });

    ProviderEventRetryScheduler.start({
      intervalMinutes: 5,
      retryLimit: 100,
      staleProcessingMinutes: 30,
      staleProcessingLimit: 100,
      runImmediately: false,
    });

    SubscriptionLifecycleScheduler.start({
      intervalMinutes: 5,
      renewalLeadMinutes: 24 * 60,
      applicationLimit: 100,
      renewalLimit: 100,
      boundaryLimit: 100,
      runImmediately: false,
    });

    /* ───────────────────── FACILITY PERMIT ACTIVATION ───────────────────── */

    /*
     * Discover verified, future-approved facility permits whose
     * effective dates have arrived.
     *
     * The scheduler owns discovery coordination, processing limits,
     * overlap prevention and distributed lease management.
     *
     * FacilityPermitVerificationService remains authoritative
     * for transactional activation, regulatory requirements,
     * permit validity and premises verification.
     *
     * runImmediately is disabled so the first scheduled pass
     * runs after the configured interval.
     */
    FacilityPermitActivationScheduler.start({
      intervalMinutes: 5,
      limit: 100,
      leaseTtlMs: 15 * 60 * 1000,
      runImmediately: false,
    });

    logger.info("Background jobs started.");
  } catch (error) {
    logger.error("Background job startup failed:", error);

    /*
     * A scheduler may have failed after other schedulers
     * successfully created their interval timers.
     *
     * Attempt cleanup for every registered scheduler.
     * Scheduler.stop() must safely handle the case where
     * its timer was never started.
     *
     * Keep cleanup errors separate so the original
     * startup failure is not lost.
     */
    for (const scheduler of backgroundSchedulers) {
      try {
        scheduler.stop();
      } catch (cleanupError) {
        logger.error("Background scheduler startup cleanup failed:", cleanupError);
      }
    }

    throw error;
  }
};

/* ─────────────────────────────── STOP BACKGROUND JOBS ─────────────────────────────── */

exports.stopBackgroundJobs = function stopBackgroundJobs() {
  for (const scheduler of backgroundSchedulers) {
    try {
      scheduler.stop();
    } catch (error) {
      logger.error("Background scheduler shutdown failed:", error);
    }
  }

  logger.info("Background jobs stopped.");
};
