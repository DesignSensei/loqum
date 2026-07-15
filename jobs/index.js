// jobs/index.js

const WithdrawalReversalScheduler = require("./withdrawalReversalScheduler");

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

  logger.info("Background jobs started.");
};

exports.stopBackgroundJobs = function stopBackgroundJobs() {
  WithdrawalReversalScheduler.stop();

  logger.info("Background jobs stopped.");
};
