// jobs/shiftCaseDeadlineScheduler.js

const ShiftOccurrenceClaimService = require("../services/shiftOccurrenceClaimService");
const ShiftOccurrenceDisputeService = require("../services/shiftOccurrenceDisputeService");
const ShiftOvertimeService = require("../services/shiftOvertimeService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;

const DEFAULT_CLAIM_EMPLOYER_REVIEW_LIMIT = 100;
const DEFAULT_CLAIM_APPEAL_LIMIT = 100;
const DEFAULT_CLAIM_REBUTTAL_LIMIT = 100;

const DEFAULT_DISPUTE_PROFESSIONAL_RESPONSE_LIMIT = 100;

const DEFAULT_OVERTIME_EMPLOYER_RESPONSE_LIMIT = 100;

const MAX_CLAIM_BATCH_LIMIT = 100;
const MAX_DISPUTE_BATCH_LIMIT = 100;
const MAX_OVERTIME_BATCH_LIMIT = 500;

/**
 * SHIFT CASE DEADLINE SCHEDULER
 *
 * This scheduler is the periodic trigger for time-based claim, dispute and
 * overtime case transitions.
 *
 * It owns timing/orchestration only.
 *
 * PROFESSIONAL CLAIM DEADLINES
 *
 * ShiftOccurrenceClaimService owns:
 *
 * - employer non-response escalation;
 * - professional appeal expiry; and
 * - professional rebuttal expiry.
 *
 * Employer non-response:
 *
 * employer response deadline expires
 * → unresolved employer-review issues escalate to admin
 *
 * Professional appeal expiry:
 *
 * employer rejection
 * → professional does not appeal before appealDeadlineAt
 * → ShiftOccurrenceClaimService finalizes the applicable rejected issue path
 *
 * Professional rebuttal expiry:
 *
 * employer supplied a counter-position
 * → professional does not rebut before rebuttalDeadlineAt
 * → issue escalates to admin
 *
 * Professional silence on a counter-position is NOT treated as acceptance of
 * the employer's position.
 *
 * EMPLOYER DISPUTE DEADLINES
 *
 * ShiftOccurrenceDisputeService owns:
 *
 * professional response deadline expires
 * → unresolved employer-originated dispute issues escalate to admin
 *
 * OVERTIME DEADLINES
 *
 * ShiftOvertimeService owns:
 *
 * employer response deadline expires
 * → employer decision authority is lost
 * → OT moves to disputed
 * → admin review opens with employer_non_response
 *
 * This scheduler does not:
 *
 * - query or mutate claim/dispute/overtime documents directly;
 * - decide any claim issue;
 * - decide any employer dispute;
 * - approve or reject overtime;
 * - perform admin adjudication;
 * - calculate settlement amounts;
 * - execute professional payouts;
 * - execute employer refunds;
 * - process OT top-up delinquency;
 * - reconcile parent Shift state; or
 * - alter the shared occurrence challenge window.
 */

class ShiftCaseDeadlineScheduler {
  static intervalHandle = null;
  static isRunning = false;

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeDate(value, fieldName = "current time") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Shift case deadline scheduler ${fieldName} is invalid.`);
    }

    return date;
  }

  static normalizePositiveInteger(value, fieldName, maximum) {
    const normalizedValue = Number(value);

    if (
      !Number.isSafeInteger(normalizedValue) ||
      normalizedValue < 1 ||
      normalizedValue > maximum
    ) {
      throw new Error(
        `Shift case deadline scheduler ${fieldName} must be a whole number between 1 and ${maximum}.`
      );
    }

    return normalizedValue;
  }

  static normalizeRunOptions({
    claimEmployerReviewLimit = DEFAULT_CLAIM_EMPLOYER_REVIEW_LIMIT,
    claimAppealLimit = DEFAULT_CLAIM_APPEAL_LIMIT,
    claimRebuttalLimit = DEFAULT_CLAIM_REBUTTAL_LIMIT,
    disputeProfessionalResponseLimit = DEFAULT_DISPUTE_PROFESSIONAL_RESPONSE_LIMIT,
    overtimeEmployerResponseLimit = DEFAULT_OVERTIME_EMPLOYER_RESPONSE_LIMIT,
  } = {}) {
    return {
      claimEmployerReviewLimit: ShiftCaseDeadlineScheduler.normalizePositiveInteger(
        claimEmployerReviewLimit,
        "claim employer-review limit",
        MAX_CLAIM_BATCH_LIMIT
      ),

      claimAppealLimit: ShiftCaseDeadlineScheduler.normalizePositiveInteger(
        claimAppealLimit,
        "claim appeal limit",
        MAX_CLAIM_BATCH_LIMIT
      ),

      claimRebuttalLimit: ShiftCaseDeadlineScheduler.normalizePositiveInteger(
        claimRebuttalLimit,
        "claim rebuttal limit",
        MAX_CLAIM_BATCH_LIMIT
      ),

      disputeProfessionalResponseLimit: ShiftCaseDeadlineScheduler.normalizePositiveInteger(
        disputeProfessionalResponseLimit,
        "dispute professional-response limit",
        MAX_DISPUTE_BATCH_LIMIT
      ),

      overtimeEmployerResponseLimit: ShiftCaseDeadlineScheduler.normalizePositiveInteger(
        overtimeEmployerResponseLimit,
        "overtime employer-response limit",
        MAX_OVERTIME_BATCH_LIMIT
      ),
    };
  }

  /* ─────────────────────────────── INTERVAL ─────────────────────────────── */

  static getIntervalMs(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    const normalizedIntervalMinutes = ShiftCaseDeadlineScheduler.normalizePositiveInteger(
      intervalMinutes,
      "interval minutes",
      24 * 60
    );

    return normalizedIntervalMinutes * 60 * 1000;
  }

  /* ─────────────────────────────── STEP EXECUTION ─────────────────────────────── */

  static async runStep(stepName, callback) {
    try {
      const result = await callback();

      return {
        failed: false,
        result,
      };
    } catch (error) {
      logger.error(`Shift case deadline scheduler ${stepName} step failed:`, error);

      return {
        failed: true,

        errorCode: error.code || "SHIFT_CASE_DEADLINE_STEP_FAILED",

        errorMessage: error.message || `Shift case deadline ${stepName} step failed.`,

        result: null,
      };
    }
  }

  static getStepResult(step) {
    return step?.result || null;
  }

  static countExpiredOvertimeResults(result) {
    return Array.isArray(result?.results)
      ? result.results.filter((item) => item?.expired === true).length
      : 0;
  }

  /* ─────────────────────────────── RUN ONCE ─────────────────────────────── */

  static async runOnce({
    currentTime = new Date(),

    claimEmployerReviewLimit = DEFAULT_CLAIM_EMPLOYER_REVIEW_LIMIT,
    claimAppealLimit = DEFAULT_CLAIM_APPEAL_LIMIT,
    claimRebuttalLimit = DEFAULT_CLAIM_REBUTTAL_LIMIT,

    disputeProfessionalResponseLimit = DEFAULT_DISPUTE_PROFESSIONAL_RESPONSE_LIMIT,

    overtimeEmployerResponseLimit = DEFAULT_OVERTIME_EMPLOYER_RESPONSE_LIMIT,
  } = {}) {
    if (ShiftCaseDeadlineScheduler.isRunning) {
      logger.info(
        "Shift case deadline scheduler skipped because the previous run is still active."
      );

      return {
        skipped: true,
        reason: "Previous run is still active.",
      };
    }

    ShiftCaseDeadlineScheduler.isRunning = true;

    try {
      const normalizedCurrentTime = ShiftCaseDeadlineScheduler.normalizeDate(
        currentTime,
        "current time"
      );

      const limits = ShiftCaseDeadlineScheduler.normalizeRunOptions({
        claimEmployerReviewLimit,
        claimAppealLimit,
        claimRebuttalLimit,
        disputeProfessionalResponseLimit,
        overtimeEmployerResponseLimit,
      });

      logger.info("Shift case deadline scheduler run started.", {
        currentTime: normalizedCurrentTime,
        ...limits,
      });

      /*
       * Each workflow is isolated at scheduler level.
       *
       * One unexpected service-level failure must not prevent unrelated
       * claim, dispute or overtime deadlines from being processed during the
       * same scheduler pass.
       */

      const claimEmployerReviewsStep = await ShiftCaseDeadlineScheduler.runStep(
        "claim employer-review expiry",
        () =>
          ShiftOccurrenceClaimService.processOverdueEmployerReviews({
            currentTime: normalizedCurrentTime,
            limit: limits.claimEmployerReviewLimit,
          })
      );

      const claimAppealsStep = await ShiftCaseDeadlineScheduler.runStep("claim appeal expiry", () =>
        ShiftOccurrenceClaimService.processExpiredAppealWindows({
          currentTime: normalizedCurrentTime,
          limit: limits.claimAppealLimit,
        })
      );

      const claimRebuttalsStep = await ShiftCaseDeadlineScheduler.runStep(
        "claim rebuttal expiry",
        () =>
          ShiftOccurrenceClaimService.processExpiredRebuttalWindows({
            currentTime: normalizedCurrentTime,
            limit: limits.claimRebuttalLimit,
          })
      );

      const disputeProfessionalResponsesStep = await ShiftCaseDeadlineScheduler.runStep(
        "dispute professional-response expiry",
        () =>
          ShiftOccurrenceDisputeService.processOverdueProfessionalResponses({
            currentTime: normalizedCurrentTime,
            limit: limits.disputeProfessionalResponseLimit,
          })
      );

      const overtimeEmployerResponsesStep = await ShiftCaseDeadlineScheduler.runStep(
        "overtime employer-response expiry",
        () =>
          ShiftOvertimeService.processEmployerResponseExpiries({
            currentTime: normalizedCurrentTime,
            limit: limits.overtimeEmployerResponseLimit,
          })
      );

      const claimEmployerReviews =
        ShiftCaseDeadlineScheduler.getStepResult(claimEmployerReviewsStep);

      const claimAppeals = ShiftCaseDeadlineScheduler.getStepResult(claimAppealsStep);

      const claimRebuttals = ShiftCaseDeadlineScheduler.getStepResult(claimRebuttalsStep);

      const disputeProfessionalResponses = ShiftCaseDeadlineScheduler.getStepResult(
        disputeProfessionalResponsesStep
      );

      const overtimeEmployerResponses = ShiftCaseDeadlineScheduler.getStepResult(
        overtimeEmployerResponsesStep
      );

      const steps = {
        claimEmployerReviews: claimEmployerReviewsStep,

        claimAppeals: claimAppealsStep,

        claimRebuttals: claimRebuttalsStep,

        disputeProfessionalResponses: disputeProfessionalResponsesStep,

        overtimeEmployerResponses: overtimeEmployerResponsesStep,
      };

      const failedSteps = Object.entries(steps)
        .filter(([, step]) => step.failed)
        .map(([name, step]) => ({
          name,
          errorCode: step.errorCode,
          errorMessage: step.errorMessage,
        }));

      const result = {
        currentTime: normalizedCurrentTime,

        claimEmployerReviews,
        claimAppeals,
        claimRebuttals,

        disputeProfessionalResponses,

        overtimeEmployerResponses,

        partialFailure: failedSteps.length > 0,

        failedStepCount: failedSteps.length,

        failedSteps,
      };

      logger.info("Shift case deadline scheduler run completed.", {
        claimEmployerReviewInspected: claimEmployerReviews?.inspectedCount || 0,

        claimEmployerReviewEscalatedClaims: claimEmployerReviews?.escalatedClaimCount || 0,

        claimEmployerReviewEscalatedIssues: claimEmployerReviews?.escalatedIssueCount || 0,

        claimEmployerReviewFailed: claimEmployerReviews?.failedCount || 0,

        claimAppealInspected: claimAppeals?.inspectedCount || 0,

        claimAppealResolvedClaims: claimAppeals?.resolvedClaimCount || 0,

        claimAppealExpiredIssues: claimAppeals?.expiredIssueCount || 0,

        claimAppealFailed: claimAppeals?.failedCount || 0,

        claimRebuttalInspected: claimRebuttals?.inspectedCount || 0,

        claimRebuttalEscalatedClaims: claimRebuttals?.escalatedClaimCount || 0,

        claimRebuttalExpiredIssues: claimRebuttals?.expiredIssueCount || 0,

        claimRebuttalFailed: claimRebuttals?.failedCount || 0,

        disputeResponseInspected: disputeProfessionalResponses?.inspectedCount || 0,

        disputeResponseEscalatedCases: disputeProfessionalResponses?.escalatedCaseCount || 0,

        disputeResponseEscalatedIssues: disputeProfessionalResponses?.escalatedIssueCount || 0,

        disputeResponseFailed: disputeProfessionalResponses?.failedCount || 0,

        overtimeEmployerResponseProcessed: overtimeEmployerResponses?.processed || 0,

        overtimeEmployerResponseExpired:
          ShiftCaseDeadlineScheduler.countExpiredOvertimeResults(overtimeEmployerResponses),

        failedSteps: failedSteps.length,
      });

      return result;
    } catch (error) {
      logger.error("Shift case deadline scheduler run failed:", error);

      return {
        failed: true,

        errorCode: error.code || "SHIFT_CASE_DEADLINE_SCHEDULER_FAILED",

        errorMessage: error.message || "Shift case deadline scheduler failed.",
      };
    } finally {
      ShiftCaseDeadlineScheduler.isRunning = false;
    }
  }

  /* ─────────────────────────────── START ─────────────────────────────── */

  static start({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,

    claimEmployerReviewLimit = DEFAULT_CLAIM_EMPLOYER_REVIEW_LIMIT,

    claimAppealLimit = DEFAULT_CLAIM_APPEAL_LIMIT,

    claimRebuttalLimit = DEFAULT_CLAIM_REBUTTAL_LIMIT,

    disputeProfessionalResponseLimit = DEFAULT_DISPUTE_PROFESSIONAL_RESPONSE_LIMIT,

    overtimeEmployerResponseLimit = DEFAULT_OVERTIME_EMPLOYER_RESPONSE_LIMIT,

    runImmediately = false,
  } = {}) {
    if (ShiftCaseDeadlineScheduler.intervalHandle) {
      logger.info("Shift case deadline scheduler is already running.");

      return ShiftCaseDeadlineScheduler.intervalHandle;
    }

    const intervalMs = ShiftCaseDeadlineScheduler.getIntervalMs(intervalMinutes);

    const runOptions = ShiftCaseDeadlineScheduler.normalizeRunOptions({
      claimEmployerReviewLimit,
      claimAppealLimit,
      claimRebuttalLimit,
      disputeProfessionalResponseLimit,
      overtimeEmployerResponseLimit,
    });

    if (typeof runImmediately !== "boolean") {
      throw new Error(
        "Shift case deadline scheduler run-immediately option must be true or false."
      );
    }

    logger.info("Shift case deadline scheduler started.", {
      intervalMinutes,
      ...runOptions,
      runImmediately,
    });

    if (runImmediately) {
      void ShiftCaseDeadlineScheduler.runOnce(runOptions);
    }

    ShiftCaseDeadlineScheduler.intervalHandle = setInterval(() => {
      void ShiftCaseDeadlineScheduler.runOnce(runOptions);
    }, intervalMs);

    return ShiftCaseDeadlineScheduler.intervalHandle;
  }

  /* ─────────────────────────────── STOP ─────────────────────────────── */

  static stop() {
    if (!ShiftCaseDeadlineScheduler.intervalHandle) {
      return;
    }

    clearInterval(ShiftCaseDeadlineScheduler.intervalHandle);

    ShiftCaseDeadlineScheduler.intervalHandle = null;

    /*
     * Do not force isRunning to false here.
     *
     * stop() prevents future scheduler ticks. It does not cancel a case
     * deadline pass that is already executing. The active pass releases its
     * own overlap lock in runOnce()'s finally block.
     */

    logger.info("Shift case deadline scheduler stopped.");
  }
}

module.exports = ShiftCaseDeadlineScheduler;
