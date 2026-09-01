// jobs/index.js

const ShiftLifecycleScheduler = require("./shiftLifecycleScheduler");
const ShiftSettlementScheduler = require("./shiftSettlementScheduler");
const WithdrawalReversalScheduler = require("./withdrawalReversalScheduler");
const EmployerRefundBatchScheduler = require("./employerRefundBatchScheduler");
const ProviderEventRetryScheduler = require("./providerEventRetryScheduler");

const logger = require("../utils/logger");

/**
 * BACKGROUND JOB REGISTRY
 *
 * This module owns background scheduler startup and shutdown only.
 *
 * It does not own lifecycle, settlement, refund, withdrawal, ProviderEvent
 * processing or reconciliation business logic. Each scheduler delegates those
 * responsibilities to its authoritative service layer.
 */

exports.startBackgroundJobs = function startBackgroundJobs() {
  logger.info("Background jobs starting.");

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

  logger.info("Background jobs started.");
};

exports.stopBackgroundJobs = function stopBackgroundJobs() {
  ShiftLifecycleScheduler.stop();
  ShiftSettlementScheduler.stop();
  WithdrawalReversalScheduler.stop();
  EmployerRefundBatchScheduler.stop();
  ProviderEventRetryScheduler.stop();

  logger.info("Background jobs stopped.");
};
