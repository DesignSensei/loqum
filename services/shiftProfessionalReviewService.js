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

const IDEMPOTENT_REVIEW_WORKFLOWS = Object.freeze(["ordinary_claim"]);

/**
 * Orchestrates the professional's shared post-occurrence review entry point.
 *
 * ShiftOccurrence owns the shared review window. Ordinary claims remain BASE
 * workflow authority in ShiftOccurrenceClaimService. Overtime remains separate
 * in ShiftOvertimeService.
 *
 * Combined BASE claim + OT submission runs atomically, with the ordinary claim
 * routed first. Domain services own fresh-submission validation and idempotent
 * replay so this orchestrator never blocks a valid replay merely because the
 * underlying claim or OT request now exists.
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

    if (!IDEMPOTENT_REVIEW_WORKFLOWS.includes(normalizedWorkflow)) {
      throw this.createError({
        message: "Professional review workflow idempotency scope is invalid.",
        code: "INVALID_PROFESSIONAL_REVIEW_WORKFLOW",
        statusCode: 500,
      });
    }

    return `${normalizedRootKey}:` + `${normalizedWorkflow}`;
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
      requestedMinutes: overtime.requestedMinutes,

      requestStatement: overtime.requestStatement,

      requestEvidence: overtime.requestEvidence === undefined ? [] : overtime.requestEvidence,
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

        challengedSettlementComponents: Array.from(issue.challengedSettlementComponents || []),

        employerDecision: issue.employerDecision || null,

        employerDecidedAt: issue.employerDecidedAt || null,

        escalationReason: issue.escalationReason || null,

        escalatedAt: issue.escalatedAt || null,

        adminDecision: issue.adminDecision || null,

        adminDecidedAt: issue.adminDecidedAt || null,

        resolvedAt: issue.resolvedAt || null,

        availableActions: [],
      })),
    };
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

      requestedMinutes: overtime.requestedMinutes ?? null,

      requestStatement: overtime.requestStatement || null,

      requestEvidence: Array.from(overtime.requestEvidence || []),

      employerResponseDeadlineAt: overtime.employerResponseDeadlineAt || null,

      employerRespondedAt: overtime.employerRespondedAt || null,

      employerResponseOverdueAt: overtime.employerResponseOverdueAt || null,

      decisionSource: overtime.decisionSource || null,

      approvedMinutes: overtime.approvedMinutes ?? null,

      approvedAt: overtime.approvedAt || null,

      approvedBy: overtime.approvedBy || null,

      rejectedAt: overtime.rejectedAt || null,

      rejectedBy: overtime.rejectedBy || null,

      rejectionBasis: overtime.rejectionBasis || null,

      rejectionReason: overtime.rejectionReason || null,

      employerProposedMinutes: overtime.employerProposedMinutes ?? null,

      rejectionEvidence: Array.from(overtime.rejectionEvidence || []),

      rejectionNoSupportingEvidence: overtime.rejectionNoSupportingEvidence === true,

      adminReviewReason: overtime.adminReviewReason || null,

      adminReviewStartedAt: overtime.adminReviewStartedAt || null,

      adminEvidence: Array.from(overtime.adminEvidence || []),

      adminDecision: overtime.adminDecision || null,

      adminDecidedAt: overtime.adminDecidedAt || null,

      adminDecidedBy: overtime.adminDecidedBy || null,

      adminDecisionReason: overtime.adminDecisionReason || null,

      professionalPay: Number(occurrence.overtimeProfessionalPay || 0),

      platformFee: Number(occurrence.overtimePlatformFee || 0),

      topUpRequired: Number(occurrence.topUpRequired || 0),

      topUpTransactionId: occurrence.topUpTransaction ? String(occurrence.topUpTransaction) : null,

      topUpAmount: Number(overtime.topUpAmount || 0),

      topUpDeadlineAt: overtime.topUpDeadlineAt || null,

      topUpOverdueAt: overtime.topUpOverdueAt || null,

      restrictionTriggeredAt: overtime.restrictionTriggeredAt || null,

      topUpPaid: overtime.topUpPaid === true,

      topUpPaidAt: overtime.topUpPaidAt || null,

      availableActions: [],
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
    } else if (!challengeableComponents.includes("base")) {
      ordinaryClaimUnavailableReason = "base_not_challengeable";
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

  static getSubmissionSelections({ overtime, issues }) {
    const hasOvertime = Boolean(overtime);

    const hasOrdinaryIssues = Array.isArray(issues) && issues.length > 0;

    if (!hasOvertime && !hasOrdinaryIssues) {
      throw this.createError({
        message: "Select overtime, at least one ordinary claim issue, or both.",
        code: "PROFESSIONAL_REVIEW_SELECTION_REQUIRED",
      });
    }

    return {
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
    occurrenceId,
    submittedByUserId,
    overtime,
    currentTime,
    session,
  }) {
    if (typeof ShiftOvertimeService.createOvertimeRequest !== "function") {
      throw this.createError({
        message: "shiftOvertimeService does not expose createOvertimeRequest().",
        code: "MANUAL_OVERTIME_SERVICE_CONTRACT_MISSING",
        statusCode: 500,
      });
    }

    return ShiftOvertimeService.createOvertimeRequest(
      {
        occurrenceId,

        professionalUserId: submittedByUserId,

        requestedMinutes: overtime.requestedMinutes,

        source: "manual_request",

        requestStatement: overtime.requestStatement,

        requestEvidence: overtime.requestEvidence,

        requestedAt: currentTime,
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

    // Domain services still verify that this user owns the professional profile.
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

      const selections = this.getSubmissionSelections({
        overtime: normalizedOvertime,

        issues: normalizedIssues,
      });

      let ordinaryClaimResult = null;

      let overtimeResult = null;

      /*
       * Ordinary claim runs first so its BASE scope is fixed before OT is
       * staged. Both writes remain inside the same transaction.
       */
      if (selections.hasOrdinaryIssues) {
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

      if (selections.hasOvertime) {
        overtimeResult = await this.submitManualOvertime({
          occurrenceId,

          submittedByUserId: normalizedSubmittedByUserId,

          overtime: normalizedOvertime,

          currentTime: now,

          session,
        });
      }

      // Reload after routed services mutate their own occurrence documents.
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

      const idempotent =
        (!selections.hasOrdinaryIssues || ordinaryClaimResult?.idempotent === true) &&
        (!selections.hasOvertime || overtimeResult?.idempotent === true);

      logger.info(
        `Professional review processed for occurrence ${refreshedOccurrence.referenceCode}; ` +
          `ordinary claim: ${selections.hasOrdinaryIssues ? "yes" : "no"}; overtime: ${
            selections.hasOvertime ? "yes" : "no"
          }; idempotent: ${idempotent ? "yes" : "no"}`
      );

      return {
        occurrence: refreshedOccurrence,

        submitted: true,

        idempotent,

        combined: selections.hasOrdinaryIssues && selections.hasOvertime,

        ordinaryClaimSubmitted: selections.hasOrdinaryIssues,

        overtimeSubmitted: selections.hasOvertime,

        ordinaryClaimResult,

        overtimeResult,

        reviewState,
      };
    });
  }
}

module.exports = ShiftProfessionalReviewService;
