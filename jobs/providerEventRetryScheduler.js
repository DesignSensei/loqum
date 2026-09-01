// jobs/providerEventRetryScheduler.js

const ProviderEventService = require("../services/providerEventService");
const ProviderEventProcessorService = require("../services/providerEventProcessorService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;

const DEFAULT_RETRY_LIMIT = 100;
const DEFAULT_STALE_PROCESSING_LIMIT = 100;

const DEFAULT_STALE_PROCESSING_MINUTES = 30;

const MAXIMUM_PROCESSING_LIMIT = 1000;

/**
 * PROVIDER EVENT RETRY SCHEDULER
 *
 * This scheduler owns periodic recovery and retry triggering for ProviderEvents.
 *
 * It performs two passes:
 *
 * 1. Recover verified processing events whose worker claim has become stale.
 * 2. Process verified failed events whose nextRetryAt deadline has arrived.
 *
 * It delegates:
 *
 * - retry/stale-event discovery to ProviderEventService;
 * - stale processing recovery to ProviderEventService; and
 * - actual event processing to ProviderEventProcessorService.
 *
 * ProviderEventService remains authoritative for:
 *
 * - atomic processing claims;
 * - stale processing claim recovery;
 * - ProviderEvent state transitions; and
 * - processing audit timestamps.
 *
 * ProviderEventProcessorService remains authoritative for:
 *
 * - processing-claim ownership;
 * - event-category dispatch;
 * - Shift Checkout finalization;
 * - employer wallet funding;
 * - employer refund synchronization;
 * - withdrawal completion / reversal;
 * - retryability classification; and
 * - persisted failure / next-retry state.
 *
 * This scheduler does not:
 *
 * - create or own processingClaimId values;
 * - mutate ProviderEvent documents directly;
 * - verify provider payloads;
 * - call Paystack directly;
 * - decide Shift funding outcomes;
 * - decide late / duplicate / timely-expired / employer-cancelled returns;
 * - move wallet or escrow money directly; or
 * - retry non-retryable ProviderEvent failures.
 */

class ProviderEventRetryScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeDate(value, fieldName = "current time") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Provider event retry scheduler ${fieldName} is invalid.`);
    }

    return date;
  }

  static normalizePositiveInteger(value, fieldName, maximum = null) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 1) {
      throw new Error(
        `Provider event retry scheduler ${fieldName} must be a positive whole number.`
      );
    }

    if (maximum !== null && normalizedValue > maximum) {
      throw new Error(`Provider event retry scheduler ${fieldName} cannot exceed ${maximum}.`);
    }

    return normalizedValue;
  }

  /* ─────────────────────────────── INTERVAL ─────────────────────────────── */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    const normalizedIntervalMinutes = ProviderEventRetryScheduler.normalizePositiveInteger(
      intervalMinutes,
      "interval minutes",
      24 * 60
    );

    return normalizedIntervalMinutes * 60 * 1000;
  }

  /* ─────────────────────────────── RECOVER STALE PROCESSING ─────────────────────────────── */

  static async recoverStaleProcessing({ currentTime, staleProcessingMinutes, limit }) {
    /*
     * Discovery does not release ownership.
     *
     * Multiple app instances may discover the same
     * stale ProviderEvent. ProviderEventService performs
     * the actual processing → failed recovery atomically.
     */
    const providerEventIds = await ProviderEventService.getStaleProcessingProviderEventIds({
      currentTime,

      staleProcessingMinutes,

      limit,
    });

    const result = {
      inspected: providerEventIds.length,

      recovered: [],

      deferred: [],

      failed: [],
    };

    for (const providerEventRecordId of providerEventIds) {
      try {
        const recoveryResult = await ProviderEventService.recoverStaleProcessingProviderEvent({
          providerEventRecordId,

          currentTime,

          staleProcessingMinutes,
        });

        const providerEvent = recoveryResult?.providerEvent || null;

        const eventId = providerEvent?._id
          ? String(providerEvent._id)
          : String(providerEventRecordId);

        if (recoveryResult?.recovered === true) {
          result.recovered.push({
            providerEventRecordId: eventId,

            eventName: providerEvent?.eventName || null,

            eventCategory: providerEvent?.eventCategory || null,

            retryCount: Number(providerEvent?.retryCount || 0),

            processingStartedAt: providerEvent?.processingStartedAt || null,

            lastProcessingStartedAt: providerEvent?.lastProcessingStartedAt || null,

            nextRetryAt: providerEvent?.nextRetryAt || currentTime,
          });

          continue;
        }

        /*
         * State may have changed between discovery
         * and recovery. That is normal under concurrent
         * workers and does not constitute a failure.
         */
        result.deferred.push({
          providerEventRecordId: eventId,

          eventName: providerEvent?.eventName || null,

          eventCategory: providerEvent?.eventCategory || null,

          reason:
            recoveryResult?.alreadyProcessed === true
              ? "already_processed"
              : recoveryResult?.alreadyIgnored === true
                ? "already_ignored"
                : recoveryResult?.alreadyFailed === true
                  ? "already_failed"
                  : recoveryResult?.unverified === true
                    ? "unverified"
                    : recoveryResult?.stillProcessing === true
                      ? recoveryResult?.stale === true
                        ? "stale_recovery_not_claimed"
                        : "still_processing"
                      : "recovery_not_required",

          status: providerEvent?.status || null,

          nextRetryAt: providerEvent?.nextRetryAt || null,
        });
      } catch (error) {
        logger.error(
          `Provider event ${providerEventRecordId} stale-processing recovery failed:`,
          error
        );

        result.failed.push({
          providerEventRecordId: String(providerEventRecordId),

          errorCode: error.code || "PROVIDER_EVENT_STALE_RECOVERY_FAILED",

          errorMessage: error.message || "Provider event stale-processing recovery failed.",
        });
      }
    }

    return result;
  }

  /* ─────────────────────────────── PROCESS DUE RETRIES ─────────────────────────────── */

  static async processDueRetries({ currentTime, limit }) {
    /*
     * Discovery is intentionally separate from
     * processing ownership.
     *
     * Multiple app instances may discover the same
     * ProviderEvent. ProviderEventService.markProcessing()
     * decides atomically which worker actually owns it.
     */
    const providerEventIds = await ProviderEventService.getDueRetryProviderEventIds({
      currentTime,

      limit,
    });

    const result = {
      inspected: providerEventIds.length,

      processed: [],

      rescheduled: [],

      terminalFailed: [],

      deferred: [],

      ignored: [],
    };

    for (const providerEventRecordId of providerEventIds) {
      try {
        const processingResult = await ProviderEventProcessorService.processProviderEvent({
          providerEventRecordId,

          currentTime,
        });

        const providerEvent = processingResult?.providerEvent || null;

        const eventId = providerEvent?._id
          ? String(providerEvent._id)
          : String(providerEventRecordId);

        /*
         * Successfully processed during this pass,
         * or another worker completed it after
         * discovery but before this worker claimed it.
         */
        if (processingResult?.processed === true || processingResult?.alreadyProcessed === true) {
          result.processed.push({
            providerEventRecordId: eventId,

            eventName: providerEvent?.eventName || null,

            eventCategory: providerEvent?.eventCategory || null,

            alreadyProcessed: processingResult?.alreadyProcessed === true,
          });

          continue;
        }

        /*
         * Retryable processing failures persist
         * their own next retry deadline.
         */
        if (
          processingResult?.failed === true &&
          processingResult?.retryable === true &&
          processingResult?.nextRetryAt
        ) {
          result.rescheduled.push({
            providerEventRecordId: eventId,

            eventName: providerEvent?.eventName || null,

            eventCategory: providerEvent?.eventCategory || null,

            retryCount: Number(providerEvent?.retryCount || 0),

            nextRetryAt: processingResult.nextRetryAt,

            errorCode: processingResult.errorCode || null,

            errorMessage:
              processingResult.errorMessage ||
              providerEvent?.failureReason ||
              "Provider event processing failed.",
          });

          continue;
        }

        /*
         * Non-retryable failures remain terminal.
         * nextRetryAt intentionally remains null.
         */
        if (processingResult?.failed === true && processingResult?.retryable !== true) {
          result.terminalFailed.push({
            providerEventRecordId: eventId,

            eventName: providerEvent?.eventName || null,

            eventCategory: providerEvent?.eventCategory || null,

            retryCount: Number(providerEvent?.retryCount || 0),

            errorCode: processingResult.errorCode || null,

            errorMessage:
              processingResult.errorMessage ||
              providerEvent?.failureReason ||
              "Provider event processing failed.",
          });

          continue;
        }

        if (processingResult?.ignored === true || processingResult?.alreadyIgnored === true) {
          result.ignored.push({
            providerEventRecordId: eventId,

            eventName: providerEvent?.eventName || null,

            eventCategory: providerEvent?.eventCategory || null,

            alreadyIgnored: processingResult?.alreadyIgnored === true,
          });

          continue;
        }

        /*
         * Deferred results are expected concurrency
         * outcomes rather than processing failures.
         *
         * processingClaimLost means this worker did
         * originally own the event, but its claim was
         * invalidated before it could finish. A newer
         * processing attempt is now authoritative.
         */
        result.deferred.push({
          providerEventRecordId: eventId,

          eventName: providerEvent?.eventName || null,

          eventCategory: providerEvent?.eventCategory || null,

          reason:
            processingResult?.processingClaimLost === true
              ? "processing_claim_lost"
              : processingResult?.alreadyProcessing === true
                ? "already_processing"
                : processingResult?.retryNotDue === true
                  ? "retry_not_due"
                  : processingResult?.retryUnavailable === true
                    ? "retry_unavailable"
                    : processingResult?.skipped === true
                      ? "processing_not_claimed"
                      : "provider_event_not_processed",

          nextRetryAt: processingResult?.nextRetryAt || providerEvent?.nextRetryAt || null,

          errorCode:
            processingResult?.processingClaimLost === true
              ? processingResult?.errorCode || null
              : null,

          errorMessage:
            processingResult?.processingClaimLost === true
              ? processingResult?.errorMessage || null
              : null,
        });
      } catch (error) {
        /*
         * Normal event-processing errors should already
         * be persisted by ProviderEventProcessorService.
         *
         * This catch protects the scheduler from an
         * unexpected execution-level failure.
         */
        logger.error(`Provider event ${providerEventRecordId} retry execution failed:`, error);

        result.terminalFailed.push({
          providerEventRecordId: String(providerEventRecordId),

          eventName: null,

          eventCategory: null,

          retryCount: null,

          errorCode: error.code || "PROVIDER_EVENT_RETRY_EXECUTION_FAILED",

          errorMessage: error.message || "Provider event retry execution failed.",

          schedulerLevelFailure: true,
        });
      }
    }

    return result;
  }

  /* ─────────────────────────────── RUN ONCE ─────────────────────────────── */

  static async runOnce({
    currentTime = new Date(),

    retryLimit = DEFAULT_RETRY_LIMIT,

    staleProcessingMinutes = DEFAULT_STALE_PROCESSING_MINUTES,

    staleProcessingLimit = DEFAULT_STALE_PROCESSING_LIMIT,
  } = {}) {
    if (ProviderEventRetryScheduler.isRunning) {
      logger.info(
        "Provider event retry scheduler skipped because the previous run is still active."
      );

      return {
        skipped: true,

        reason: "Previous run is still active.",
      };
    }

    ProviderEventRetryScheduler.isRunning = true;

    try {
      const normalizedCurrentTime = ProviderEventRetryScheduler.normalizeDate(
        currentTime,
        "current time"
      );

      const normalizedRetryLimit = ProviderEventRetryScheduler.normalizePositiveInteger(
        retryLimit,
        "retry limit",
        MAXIMUM_PROCESSING_LIMIT
      );

      const normalizedStaleProcessingMinutes = ProviderEventRetryScheduler.normalizePositiveInteger(
        staleProcessingMinutes,
        "stale processing minutes"
      );

      const normalizedStaleProcessingLimit = ProviderEventRetryScheduler.normalizePositiveInteger(
        staleProcessingLimit,
        "stale processing limit",
        MAXIMUM_PROCESSING_LIMIT
      );

      logger.info("Provider event retry scheduler run started.", {
        currentTime: normalizedCurrentTime,

        retryLimit: normalizedRetryLimit,

        staleProcessingMinutes: normalizedStaleProcessingMinutes,

        staleProcessingLimit: normalizedStaleProcessingLimit,
      });

      /*
       * Recover abandoned processing claims first.
       *
       * Recovery changes stale processing events to
       * failed with nextRetryAt = currentTime and
       * invalidates the old processingClaimId.
       */
      const staleRecovery = await ProviderEventRetryScheduler.recoverStaleProcessing({
        currentTime: normalizedCurrentTime,

        staleProcessingMinutes: normalizedStaleProcessingMinutes,

        limit: normalizedStaleProcessingLimit,
      });

      /*
       * This pass handles both:
       *
       * - previously failed events whose retry deadline
       *   was already due; and
       * - stale processing events recovered immediately
       *   above.
       *
       * ProviderEventProcessorService must still win a
       * fresh processing claim before business logic runs.
       */
      const processing = await ProviderEventRetryScheduler.processDueRetries({
        currentTime: normalizedCurrentTime,

        limit: normalizedRetryLimit,
      });

      const result = {
        currentTime: normalizedCurrentTime,

        staleRecovery,

        processing,
      };

      logger.info("Provider event retry scheduler run completed.", {
        staleInspected: staleRecovery.inspected || 0,

        staleRecovered: staleRecovery.recovered?.length || 0,

        staleDeferred: staleRecovery.deferred?.length || 0,

        staleFailed: staleRecovery.failed?.length || 0,

        retryInspected: processing.inspected || 0,

        processed: processing.processed?.length || 0,

        rescheduled: processing.rescheduled?.length || 0,

        terminalFailed: processing.terminalFailed?.length || 0,

        deferred: processing.deferred?.length || 0,

        processingClaimsLost:
          processing.deferred?.filter((entry) => entry.reason === "processing_claim_lost").length ||
          0,

        ignored: processing.ignored?.length || 0,
      });

      return result;
    } catch (error) {
      logger.error("Provider event retry scheduler run failed:", error);

      return {
        failed: true,

        errorCode: error.code || "PROVIDER_EVENT_RETRY_SCHEDULER_FAILED",

        errorMessage: error.message || "Provider event retry scheduler failed.",
      };
    } finally {
      ProviderEventRetryScheduler.isRunning = false;
    }
  }

  /* ─────────────────────────────── START ─────────────────────────────── */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,

    retryLimit = DEFAULT_RETRY_LIMIT,

    staleProcessingMinutes = DEFAULT_STALE_PROCESSING_MINUTES,

    staleProcessingLimit = DEFAULT_STALE_PROCESSING_LIMIT,

    runImmediately = false,
  } = {}) {
    if (ProviderEventRetryScheduler.intervalHandle) {
      logger.info("Provider event retry scheduler is already running.");

      return ProviderEventRetryScheduler.intervalHandle;
    }

    const intervalMs = ProviderEventRetryScheduler.getIntervalMs(intervalMinutes);

    const normalizedRetryLimit = ProviderEventRetryScheduler.normalizePositiveInteger(
      retryLimit,
      "retry limit",
      MAXIMUM_PROCESSING_LIMIT
    );

    const normalizedStaleProcessingMinutes = ProviderEventRetryScheduler.normalizePositiveInteger(
      staleProcessingMinutes,
      "stale processing minutes"
    );

    const normalizedStaleProcessingLimit = ProviderEventRetryScheduler.normalizePositiveInteger(
      staleProcessingLimit,
      "stale processing limit",
      MAXIMUM_PROCESSING_LIMIT
    );

    if (typeof runImmediately !== "boolean") {
      throw new Error(
        "Provider event retry scheduler run-immediately option must be true or false."
      );
    }

    const runOptions = {
      retryLimit: normalizedRetryLimit,

      staleProcessingMinutes: normalizedStaleProcessingMinutes,

      staleProcessingLimit: normalizedStaleProcessingLimit,
    };

    logger.info("Provider event retry scheduler started.", {
      intervalMinutes,

      ...runOptions,

      runImmediately,
    });

    if (runImmediately) {
      void ProviderEventRetryScheduler.runOnce(runOptions);
    }

    ProviderEventRetryScheduler.intervalHandle = setInterval(() => {
      void ProviderEventRetryScheduler.runOnce(runOptions);
    }, intervalMs);

    return ProviderEventRetryScheduler.intervalHandle;
  }

  /* ─────────────────────────────── STOP ─────────────────────────────── */

  static stop() {
    if (!ProviderEventRetryScheduler.intervalHandle) {
      return;
    }

    clearInterval(ProviderEventRetryScheduler.intervalHandle);

    ProviderEventRetryScheduler.intervalHandle = null;

    /*
     * Do not force isRunning to false here.
     *
     * stop() prevents future scheduler ticks but
     * cannot cancel processing already in progress.
     * The active run releases its own overlap guard.
     */
    logger.info("Provider event retry scheduler stopped.");
  }
}

module.exports = ProviderEventRetryScheduler;
