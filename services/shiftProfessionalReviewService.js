// services/shiftProfessionalReviewService.js

const mongoose = require("mongoose");

const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");

const ShiftOvertimeService = require("./shiftOvertimeService");
const ShiftOccurrenceClaimService = require("./shiftOccurrenceClaimService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const logger = require("../utils/logger");

const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

const REVIEW_SELECTIONS = Object.freeze(["overtime", "ordinary_claim"]);

const PROFESSIONAL_CLAIM_APPEAL_ACTION = "submit_claim_issue_appeal";
const PROFESSIONAL_OVERTIME_APPEAL_ACTION = "submit_overtime_appeal";

const PROFESSIONAL_CLAIM_REBUTTAL_ACTION = "submit_claim_issue_rebuttal";

/**
 * SINGLE PROFESSIONAL REVIEW ENTRY POINT
 *
 * This service owns orchestration only.
 *
 * It does NOT own:
 *
 * - overtime request rules;
 * - overtime employer decisions;
 * - overtime appeal/adjudication;
 * - ordinary claim issue validation;
 * - ordinary claim employer review;
 * - claim issue resolution;
 * - settlement calculations;
 * - payout readiness;
 * - platform-fee authority;
 * - overtime funding;
 * - refunds; or
 * - parent Shift reconciliation.
 *
 * SHARED WINDOW
 *
 * ShiftOccurrence owns the single initial professional review envelope:
 *
 * - challengeWindowOpenedAt
 * - challengeDeadlineAt
 * - challengeWindowClosedAt
 * - challengeableSettlementComponents
 *
 * During the remaining shared window:
 *
 * - overtime may be selected only if no OT request already exists;
 * - ordinary claim issues may be selected only if no professional claim case
 *   has ever been submitted for the occurrence; and
 * - one submission may contain BOTH overtime and ordinary claim issues.
 *
 * EXISTING WORKFLOWS
 *
 * Once overtime exists:
 *
 * - overtime is no longer offered as a new selection;
 * - its existing workflow state is returned instead.
 *
 * Once a professional claim case exists:
 *
 * - ordinary claim issue selection is no longer offered;
 * - its existing case/issue workflow is returned instead.
 *
 * A withdrawn or resolved professional claim still consumes the one original
 * professional claim case opportunity.
 *
 * COMBINED SUBMISSION
 *
 * When the professional submits OT + ordinary issues together:
 *
 * 1. validate the shared occurrence window;
 * 2. create the ordinary professional claim case;
 * 3. create the manual OT request;
 * 4. perform both inside one MongoDB transaction.
 *
 * Ordinary claim creation deliberately runs first.
 *
 * This lets ShiftOccurrenceClaimService derive the immutable ordinary issue
 * scope from the occurrence state that existed at the moment the professional
 * submitted the combined review.
 *
 * If either routed workflow fails, the transaction rolls back both.
 *
 * CLAIM / DISPUTE COEXISTENCE
 *
 * An employer dispute does not automatically prohibit this professional
 * review entry point.
 *
 * activeClaim and activeDispute may coexist where they concern genuinely
 * separate controversies.
 */
class ShiftProfessionalReviewService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftProfessionalReviewServiceError";
    error.code = code;
    error.statusCode = statusCode;

    if (details && typeof details === "object") {
      error.details = details;
    }

    return error;
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    return runServiceTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeFieldCode(value) {
    return String(value || "")
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  static normalizeObjectId(value, fieldName, { nullable = false } = {}) {
    if (value === null || value === undefined || value === "") {
      if (nullable) {
        return null;
      }

      throw this.createError({
        message: `${fieldName} is required.`,
        code: `${this.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw this.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeDate(value, fieldName, { nullable = false, statusCode = 400 } = {}) {
    if (value === null || value === undefined || value === "") {
      if (nullable) {
        return null;
      }

      throw this.createError({
        message: `${fieldName} is required.`,
        code: `${this.normalizeFieldCode(fieldName)}_REQUIRED`,
        statusCode,
      });
    }

    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw this.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
        statusCode,
      });
    }

    return date;
  }

  static normalizeIdempotencyKey(value) {
    const key = String(value || "").trim();

    if (!key) {
      throw this.createError({
        message: "Idempotency key is required for a professional review submission.",
        code: "PROFESSIONAL_REVIEW_IDEMPOTENCY_KEY_REQUIRED",
      });
    }

    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw this.createError({
        message:
          `Professional review idempotency key cannot exceed ` +
          `${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        code: "PROFESSIONAL_REVIEW_IDEMPOTENCY_KEY_TOO_LONG",
      });
    }

    return key;
  }

  static deriveWorkflowIdempotencyKey(rootKey, workflow) {
    const normalizedRootKey = this.normalizeIdempotencyKey(rootKey);

    const normalizedWorkflow = String(workflow || "")
      .trim()
      .toLowerCase();

    if (!REVIEW_SELECTIONS.includes(normalizedWorkflow)) {
      throw this.createError({
        message: "Professional review workflow idempotency scope is invalid.",
        code: "INVALID_PROFESSIONAL_REVIEW_WORKFLOW",
        statusCode: 500,
      });
    }

    return `${normalizedRootKey}:${normalizedWorkflow}`;
  }

  static normalizeOrdinaryIssues(issues) {
    if (issues === null || issues === undefined) {
      return [];
    }

    if (!Array.isArray(issues)) {
      throw this.createError({
        message: "Ordinary professional review issues must be supplied as an array.",
        code: "INVALID_PROFESSIONAL_REVIEW_ISSUES",
      });
    }

    return issues;
  }

  static normalizeOvertimeSelection(overtime) {
    if (overtime === null || overtime === undefined || overtime === false) {
      return null;
    }

    if (typeof overtime !== "object" || Array.isArray(overtime)) {
      throw this.createError({
        message: "Overtime review selection must be an object.",
        code: "INVALID_PROFESSIONAL_REVIEW_OVERTIME",
      });
    }

    return {
      ...overtime,
    };
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getOccurrence({ shiftId, occurrenceId, session = null }) {
    const normalizedShiftId = this.normalizeObjectId(shiftId, "shift ID");

    const normalizedOccurrenceId = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const query = ShiftOccurrence.findOne({
      _id: normalizedOccurrenceId,
      shift: normalizedShiftId,
    });

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw this.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static async getProfessionalClaimCase({ occurrenceId, session = null }) {
    const normalizedOccurrenceId = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const query = ShiftOccurrenceClaim.findOne({
      occurrence: normalizedOccurrenceId,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  static assertProfessionalOwnsOccurrence({ occurrence, professionalId }) {
    const normalizedProfessionalId = this.normalizeObjectId(
      professionalId,
      "professional profile ID"
    );

    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignment ||
      !occurrence.assignedProfessional ||
      !occurrence.assignedAt
    ) {
      throw this.createError({
        message: "The occurrence does not have a complete professional assignment.",
        code: "OCCURRENCE_ASSIGNMENT_INCOMPLETE",
        statusCode: 409,
      });
    }

    if (String(occurrence.assignedProfessional) !== String(normalizedProfessionalId)) {
      throw this.createError({
        message: "This occurrence is not assigned to the professional.",
        code: "PROFESSIONAL_NOT_ASSIGNED_TO_OCCURRENCE",
        statusCode: 403,
      });
    }

    return normalizedProfessionalId;
  }

  /* ─────────────────────────────── SHARED REVIEW WINDOW ─────────────────────────────── */

  static getChallengeableSettlementComponents(occurrence) {
    const values = Array.isArray(occurrence.challengeableSettlementComponents)
      ? occurrence.challengeableSettlementComponents
      : [];

    const normalized = values.map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    );

    const unique = [...new Set(normalized)];

    if (
      unique.length !== normalized.length ||
      unique.some((component) => !["base", "overtime"].includes(component))
    ) {
      throw this.createError({
        message: "The occurrence contains an invalid challenge-component scope.",
        code: "INVALID_OCCURRENCE_CHALLENGE_COMPONENT_SCOPE",
        statusCode: 500,
      });
    }

    return ["base", "overtime"].filter((component) => unique.includes(component));
  }

  static getReviewWindowState({ occurrence, currentTime }) {
    const now = this.normalizeCurrentTime(currentTime);

    const challengeableSettlementComponents = this.getChallengeableSettlementComponents(occurrence);

    if (!occurrence.challengeWindowOpenedAt && !occurrence.challengeDeadlineAt) {
      return {
        status: "not_established",

        openedAt: null,
        deadlineAt: null,
        closedAt: occurrence.challengeWindowClosedAt || null,

        remainingMilliseconds: 0,

        challengeableSettlementComponents,
      };
    }

    if (!occurrence.challengeWindowOpenedAt || !occurrence.challengeDeadlineAt) {
      throw this.createError({
        message: "The occurrence contains an incomplete shared review-window audit.",
        code: "INCOMPLETE_OCCURRENCE_REVIEW_WINDOW_AUDIT",
        statusCode: 500,
      });
    }

    const openedAt = this.normalizeDate(
      occurrence.challengeWindowOpenedAt,
      "challenge window opening time",
      {
        statusCode: 500,
      }
    );

    const deadlineAt = this.normalizeDate(occurrence.challengeDeadlineAt, "challenge deadline", {
      statusCode: 500,
    });

    if (deadlineAt <= openedAt) {
      throw this.createError({
        message: "The occurrence contains an invalid shared review-window audit.",
        code: "INVALID_OCCURRENCE_REVIEW_WINDOW_AUDIT",
        statusCode: 500,
      });
    }

    if (occurrence.challengeWindowClosedAt) {
      const closedAt = this.normalizeDate(
        occurrence.challengeWindowClosedAt,
        "challenge window closing time",
        {
          statusCode: 500,
        }
      );

      return {
        status: "closed",

        openedAt,
        deadlineAt,
        closedAt,

        remainingMilliseconds: 0,

        challengeableSettlementComponents,
      };
    }

    if (now < openedAt) {
      return {
        status: "not_open",

        openedAt,
        deadlineAt,
        closedAt: null,

        remainingMilliseconds: deadlineAt.getTime() - openedAt.getTime(),

        challengeableSettlementComponents,
      };
    }

    if (now >= deadlineAt) {
      return {
        status: "closed",

        openedAt,
        deadlineAt,
        closedAt: null,

        remainingMilliseconds: 0,

        challengeableSettlementComponents,
      };
    }

    return {
      status: "open",

      openedAt,
      deadlineAt,
      closedAt: null,

      remainingMilliseconds: deadlineAt.getTime() - now.getTime(),

      challengeableSettlementComponents,
    };
  }

  static assertSharedReviewWindowOpen({ occurrence, currentTime }) {
    const state = this.getReviewWindowState({
      occurrence,
      currentTime,
    });

    if (state.status !== "open") {
      throw this.createError({
        message:
          state.status === "not_established"
            ? "This occurrence does not have an available professional review window."
            : state.status === "not_open"
              ? "The professional review window is not open yet."
              : "The professional review window has closed.",
        code:
          state.status === "not_established"
            ? "PROFESSIONAL_REVIEW_WINDOW_NOT_ESTABLISHED"
            : state.status === "not_open"
              ? "PROFESSIONAL_REVIEW_WINDOW_NOT_OPEN"
              : "PROFESSIONAL_REVIEW_WINDOW_CLOSED",
        statusCode: 409,
        details: {
          challengeWindowOpenedAt: state.openedAt,
          challengeDeadlineAt: state.deadlineAt,
          challengeWindowClosedAt: state.closedAt,
        },
      });
    }

    if (state.challengeableSettlementComponents.length === 0) {
      throw this.createError({
        message: "No settlement component remains available for professional review.",
        code: "NO_PROFESSIONAL_REVIEW_COMPONENT_AVAILABLE",
        statusCode: 409,
      });
    }

    return state;
  }

  /* ─────────────────────────────── WORKFLOW VIEW ─────────────────────────────── */

  static getProfessionalClaimIssueActions(issue) {
    const actions = [];

    if (issue?.status === "awaiting_professional_appeal" && issue?.appealStatus === "available") {
      actions.push(PROFESSIONAL_CLAIM_APPEAL_ACTION);
    }

    if (
      issue?.status === "awaiting_professional_rebuttal" &&
      issue?.rebuttalStatus === "available"
    ) {
      actions.push(PROFESSIONAL_CLAIM_REBUTTAL_ACTION);
    }

    return actions;
  }

  static buildProfessionalClaimWorkflow(claim) {
    if (!claim) {
      return null;
    }

    return {
      exists: true,

      id: String(claim._id),

      referenceCode: claim.referenceCode,

      status: claim.status,

      submittedAt: claim.submittedAt,

      employerResponseDeadlineAt: claim.employerResponseDeadlineAt || null,

      resolvedAt: claim.resolvedAt || null,

      withdrawnAt: claim.withdrawnAt || null,

      submittedIssueTypes: Array.from(claim.submittedIssueTypes || []),

      issues: Array.from(claim.issues || []).map((issue) => ({
        id: String(issue._id),

        type: issue.type,

        status: issue.status,

        affectedSettlementComponents: Array.from(issue.affectedSettlementComponents || []),

        employerDecision: issue.employerDecision || null,

        employerDecidedAt: issue.employerDecidedAt || null,

        appealStatus: issue.appealStatus || "not_available",

        appealDeadlineAt: issue.appealDeadlineAt || null,

        appealedAt: issue.appealedAt || null,

        rebuttalStatus: issue.rebuttalStatus || "not_available",

        rebuttalDeadlineAt: issue.rebuttalDeadlineAt || null,

        rebuttedAt: issue.rebuttedAt || null,

        escalationReason: issue.escalationReason || null,

        escalatedAt: issue.escalatedAt || null,

        adminDecision: issue.adminDecision || null,

        adminDecidedAt: issue.adminDecidedAt || null,

        resolvedAt: issue.resolvedAt || null,

        availableActions: this.getProfessionalClaimIssueActions(issue),
      })),
    };
  }

  static getProfessionalOvertimeActions(overtime) {
    const actions = [];

    if (overtime?.appealStatus === "available" && overtime?.appealDeadlineAt) {
      actions.push(PROFESSIONAL_OVERTIME_APPEAL_ACTION);
    }

    return actions;
  }

  static buildOvertimeWorkflow(occurrence) {
    const overtime = occurrence.overtime || {};

    if (overtime.requested !== true) {
      return null;
    }

    return {
      exists: true,

      status: overtime.status || null,

      source: overtime.source || null,

      requestedAt: overtime.requestedAt || null,

      requestedBy: overtime.requestedBy || null,

      reason: overtime.reason || null,

      /**
       * Newer OT audit fields are returned when present.
       *
       * The orchestrator does not interpret or mutate them.
       */
      requestedExtraMinutes: overtime.requestedExtraMinutes ?? null,

      requestedExtraHours: overtime.requestedExtraHours ?? null,

      requestedProfessionalPay: overtime.requestedProfessionalPay ?? null,

      finalApprovedExtraMinutes: overtime.finalApprovedExtraMinutes ?? null,

      finalApprovedExtraHours: overtime.finalApprovedExtraHours ?? overtime.extraHours ?? null,

      employerResponseDeadlineAt: overtime.employerResponseDeadlineAt || null,

      employerRespondedAt: overtime.employerRespondedAt || null,

      employerResponseOverdueAt: overtime.employerResponseOverdueAt || null,

      approvedAt: overtime.approvedAt || null,

      rejectedAt: overtime.rejectedAt || null,

      rejectionReason: overtime.rejectionReason || null,

      appealStatus: overtime.appealStatus || null,

      appealDeadlineAt: overtime.appealDeadlineAt || null,

      appealedAt: overtime.appealedAt || null,

      adminDecidedAt: overtime.adminDecidedAt || null,

      topUpAmount: overtime.topUpAmount || 0,

      topUpDeadlineAt: overtime.topUpDeadlineAt || null,

      topUpOverdueAt: overtime.topUpOverdueAt || null,

      restrictionTriggeredAt: overtime.restrictionTriggeredAt || null,

      topUpPaid: overtime.topUpPaid === true,

      topUpPaidAt: overtime.topUpPaidAt || null,

      availableActions: this.getProfessionalOvertimeActions(overtime),
    };
  }

  static buildSelectionAvailability({ occurrence, claim, reviewWindow }) {
    const windowOpen = reviewWindow.status === "open";

    const challengeableComponents = reviewWindow.challengeableSettlementComponents;

    const overtimeExists = occurrence.overtime?.requested === true;

    const claimExists = Boolean(claim);

    let overtimeUnavailableReason = null;

    if (!windowOpen) {
      overtimeUnavailableReason = "review_window_not_open";
    } else if (overtimeExists) {
      overtimeUnavailableReason = "overtime_request_already_exists";
    } else if (!challengeableComponents.includes("overtime")) {
      overtimeUnavailableReason = "overtime_not_challengeable";
    }

    let ordinaryClaimUnavailableReason = null;

    if (!windowOpen) {
      ordinaryClaimUnavailableReason = "review_window_not_open";
    } else if (claimExists) {
      ordinaryClaimUnavailableReason = "professional_claim_case_already_exists";
    } else if (challengeableComponents.length === 0) {
      ordinaryClaimUnavailableReason = "no_challengeable_component";
    }

    return {
      overtime: {
        selectable: overtimeUnavailableReason === null,

        unavailableReason: overtimeUnavailableReason,
      },

      ordinaryClaim: {
        selectable: ordinaryClaimUnavailableReason === null,

        unavailableReason: ordinaryClaimUnavailableReason,
      },
    };
  }

  static buildReviewState({ occurrence, claim, currentTime }) {
    const reviewWindow = this.getReviewWindowState({
      occurrence,
      currentTime,
    });

    const selections = this.buildSelectionAvailability({
      occurrence,
      claim,
      reviewWindow,
    });

    return {
      occurrence: {
        id: String(occurrence._id),

        shiftId: occurrence.shift ? String(occurrence.shift) : null,

        referenceCode: occurrence.referenceCode,

        status: occurrence.status,

        attendanceStatus: occurrence.attendanceStatus,

        settlementStatus: occurrence.settlementStatus,
      },

      reviewWindow,

      selections,

      workflows: {
        overtime: this.buildOvertimeWorkflow(occurrence),

        ordinaryClaim: this.buildProfessionalClaimWorkflow(claim),

        employerDisputeActive: Boolean(occurrence.activeDispute),

        employerDisputeId: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
      },
    };
  }

  static async getReviewState(
    { shiftId, occurrenceId, professionalId, currentTime = new Date() },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    const session = options.session || null;

    const occurrence = await this.getOccurrence({
      shiftId,
      occurrenceId,
      session,
    });

    this.assertProfessionalOwnsOccurrence({
      occurrence,
      professionalId,
    });

    const claim = await this.getProfessionalClaimCase({
      occurrenceId: occurrence._id,
      session,
    });

    return this.buildReviewState({
      occurrence,
      claim,
      currentTime: now,
    });
  }

  /* ─────────────────────────────── SUBMISSION VALIDATION ─────────────────────────────── */

  static assertSubmissionAvailability({ occurrence, claim, overtime, issues, currentTime }) {
    const reviewWindow = this.assertSharedReviewWindowOpen({
      occurrence,
      currentTime,
    });

    const hasOvertime = Boolean(overtime);

    const hasOrdinaryIssues = Array.isArray(issues) && issues.length > 0;

    if (!hasOvertime && !hasOrdinaryIssues) {
      throw this.createError({
        message: "Select overtime, at least one ordinary claim issue, or both.",
        code: "PROFESSIONAL_REVIEW_SELECTION_REQUIRED",
      });
    }

    if (hasOvertime) {
      if (occurrence.overtime?.requested === true) {
        throw this.createError({
          message: "An overtime request already exists for this occurrence.",
          code: "OVERTIME_REQUEST_ALREADY_EXISTS",
          statusCode: 409,
        });
      }

      if (!reviewWindow.challengeableSettlementComponents.includes("overtime")) {
        throw this.createError({
          message: "Overtime is no longer available as a new professional review selection.",
          code: "OVERTIME_REVIEW_SELECTION_NOT_AVAILABLE",
          statusCode: 409,
        });
      }
    }

    if (hasOrdinaryIssues && claim) {
      throw this.createError({
        message: "A professional claim case has already been submitted for this occurrence.",
        code: "PROFESSIONAL_CLAIM_CASE_ALREADY_EXISTS",
        statusCode: 409,
        details: {
          claimId: String(claim._id),
          claimStatus: claim.status,
        },
      });
    }

    return {
      reviewWindow,

      hasOvertime,
      hasOrdinaryIssues,
    };
  }

  /* ─────────────────────────────── ROUTING ─────────────────────────────── */

  static async submitOrdinaryClaimIssues({
    shiftId,
    occurrenceId,
    professionalId,
    submittedByUserId,
    issues,
    idempotencyKey,
    currentTime,
    session,
  }) {
    return ShiftOccurrenceClaimService.submitClaim(
      {
        shiftId,
        occurrenceId,

        professionalId,
        submittedByUserId,

        issues,

        idempotencyKey,

        currentTime,
      },
      {
        session,
      }
    );
  }

  static async submitManualOvertime({
    shiftId,
    occurrenceId,
    professionalId,
    submittedByUserId,
    overtime,
    idempotencyKey,
    currentTime,
    session,
  }) {
    if (typeof ShiftOvertimeService.submitManualOvertimeRequest !== "function") {
      throw this.createError({
        message: "shiftOvertimeService does not expose submitManualOvertimeRequest().",
        code: "MANUAL_OVERTIME_SERVICE_CONTRACT_MISSING",
        statusCode: 500,
      });
    }

    /**
     * OT-specific request fields remain owned by shiftOvertimeService.
     *
     * This orchestrator does not interpret them.
     *
     * Examples may include the professional's requested minutes, reason,
     * statement or evidence depending on the final #5 contract.
     */
    return ShiftOvertimeService.submitManualOvertimeRequest(
      {
        ...overtime,

        shiftId,
        occurrenceId,

        professionalId,

        submittedByUserId,

        /**
         * Keep the actor alias explicit for #5's request audit.
         *
         * Extra object properties are harmless where #5 destructures only
         * the fields it owns.
         */
        requestedByUserId: submittedByUserId,

        idempotencyKey,

        currentTime,
      },
      {
        session,
      }
    );
  }

  /* ─────────────────────────────── SINGLE PROFESSIONAL REVIEW SUBMISSION ─────────────────────────────── */

  static async submitReview(
    {
      shiftId,
      occurrenceId,

      professionalId,
      submittedByUserId,

      overtime = null,
      issues = [],

      idempotencyKey,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    const normalizedOvertime = this.normalizeOvertimeSelection(overtime);

    const normalizedIssues = this.normalizeOrdinaryIssues(issues);

    const rootIdempotencyKey = this.normalizeIdempotencyKey(idempotencyKey);

    /**
     * Validate the submitting user ID at orchestration level so both routed
     * workflows receive one stable actor identity.
     *
     * ProfessionalProfile ownership is still authoritatively checked by the
     * downstream domain service.
     */
    const normalizedSubmittedByUserId = this.normalizeObjectId(
      submittedByUserId,
      "submitting user ID"
    );

    return this.runWithOptionalTransaction(options, async (session) => {
      const occurrence = await this.getOccurrence({
        shiftId,
        occurrenceId,
        session,
      });

      this.assertProfessionalOwnsOccurrence({
        occurrence,
        professionalId,
      });

      const existingClaim = await this.getProfessionalClaimCase({
        occurrenceId: occurrence._id,
        session,
      });

      const availability = this.assertSubmissionAvailability({
        occurrence,

        claim: existingClaim,

        overtime: normalizedOvertime,

        issues: normalizedIssues,

        currentTime: now,
      });

      let ordinaryClaimResult = null;
      let overtimeResult = null;

      /**
       * IMPORTANT ORDER
       *
       * Ordinary issues are routed first.
       *
       * The claim service derives the professional's immutable ordinary
       * issue scope against the still-open shared occurrence window.
       *
       * Claim submission does not close that shared window, so #5 may then
       * create the manual OT request inside the same transaction.
       */
      if (availability.hasOrdinaryIssues) {
        ordinaryClaimResult = await this.submitOrdinaryClaimIssues({
          shiftId,
          occurrenceId,

          professionalId,

          submittedByUserId: normalizedSubmittedByUserId,

          issues: normalizedIssues,

          idempotencyKey: this.deriveWorkflowIdempotencyKey(rootIdempotencyKey, "ordinary_claim"),

          currentTime: now,

          session,
        });
      }

      if (availability.hasOvertime) {
        overtimeResult = await this.submitManualOvertime({
          shiftId,
          occurrenceId,

          professionalId,

          submittedByUserId: normalizedSubmittedByUserId,

          overtime: normalizedOvertime,

          idempotencyKey: this.deriveWorkflowIdempotencyKey(rootIdempotencyKey, "overtime"),

          currentTime: now,

          session,
        });
      }

      /**
       * Reload authoritative state after both routed services have run.
       *
       * The original occurrence instance above may be stale because the
       * downstream services load and save their own occurrence documents
       * inside this same session.
       */
      const refreshedOccurrence = await this.getOccurrence({
        shiftId,
        occurrenceId,
        session,
      });

      const refreshedClaim = await this.getProfessionalClaimCase({
        occurrenceId: refreshedOccurrence._id,
        session,
      });

      const reviewState = this.buildReviewState({
        occurrence: refreshedOccurrence,

        claim: refreshedClaim,

        currentTime: now,
      });

      logger.info(
        `Professional review submitted for occurrence ${refreshedOccurrence.referenceCode}; ` +
          `ordinary claim: ${availability.hasOrdinaryIssues ? "yes" : "no"}; overtime: ${
            availability.hasOvertime ? "yes" : "no"
          }`
      );

      return {
        occurrence: refreshedOccurrence,

        submitted: true,

        combined: availability.hasOrdinaryIssues && availability.hasOvertime,

        ordinaryClaimSubmitted: availability.hasOrdinaryIssues,

        overtimeSubmitted: availability.hasOvertime,

        ordinaryClaimResult,

        overtimeResult,

        reviewState,
      };
    });
  }
}

module.exports = ShiftProfessionalReviewService;
