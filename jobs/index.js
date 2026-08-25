// jobs/index.js

const WithdrawalReversalScheduler = require("./withdrawalReversalScheduler");

const ShiftOccurrenceReconciliationScheduler = require("./shiftOccurrenceReconciliationScheduler");

const ShiftSettlementScheduler = require("./shiftSettlementScheduler");

const logger = require("../utils/logger");

exports.startBackgroundJobs = function startBackgroundJobs() {
  logger.info("Background jobs starting.");

  WithdrawalReversalScheduler.start({
    intervalMinutes: 10,
    olderThanMinutes: 30,
    limit: 50,
    completeSuccessfulTransfers: true,
    runImmediately: false,
  });

  ShiftOccurrenceReconciliationScheduler.start({
    intervalMinutes: 5,
    deadlineBackfillLimit: 100,
    expirationLimit: 100,
    refundLimit: 100,
    runImmediately: false,
  });

  ShiftSettlementScheduler.start({
    intervalMinutes: 5,
    approvalLimit: 100,
    refundLimit: 100,
    batchOccurrenceLimit: 1000,
    batchProcessingLimit: 100,
    maximumProcessingAttempts: 5,
    staleProcessingMinutes: 30,
    payoutPolicy: {},
    runImmediately: false,
  });

  logger.info("Background jobs started.");
};

exports.stopBackgroundJobs = function stopBackgroundJobs() {
  WithdrawalReversalScheduler.stop();

  ShiftOccurrenceReconciliationScheduler.stop();

  ShiftSettlementScheduler.stop();

  logger.info("Background jobs stopped.");
};
