// services/shiftSettlementService.js

const mongoose = require("mongoose");

const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const { SETTLEMENT_APPROVAL_SOURCES } = require("../constants/shiftLifecycle");

const {
  SETTLEMENT_BATCH_COMPONENTS,
  SETTLEMENT_COMPONENT_STATUSES,
  SETTLEMENT_LINE_EARNING_TYPES,
  DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY,
} = require("../constants/shiftSettlement");

const money = require("../utils/money");
const logger = require("../utils/logger");

const MINUTES_PER_DAY = 24 * 60;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SHARED_REVIEW_WINDOW_HOURS = 24;

const DEFAULT_PAYOUT_WEEKDAY = Number.isSafeInteger(DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY)
  ? DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY
  : 1;

const DEFAULT_PAYOUT_HOUR = 9;
const DEFAULT_PAYOUT_MINUTE = 0;
const DEFAULT_PAYOUT_TIME_ZONE = "Africa/Lagos";

const COMPONENT_RELEASE_READY_STATUSES = Object.freeze([
  "approved_for_release",
  "release_pending",
  "released",
]);

const COMPONENT_EXECUTION_STARTED_STATUSES = Object.freeze(["release_pending", "released"]);

const COMPONENT_SETTLEMENT_PATHS = Object.freeze({
  base: "baseSettlement",
  overtime: "overtimeSettlement",
});

const BASE_SETTLEMENT_EARNING_TYPES = Object.freeze([
  "worked_base",
  "cancellation_compensation",
  "active_work_cancellation",
]);

/**
 * PROFESSIONAL SETTLEMENT AUTHORITY
 *
 * This service owns:
 *
 * - BASE professional entitlement;
 * - BASE billable-time calculation;
 * - professional payout-component initialization;
 * - component-specific challenge finality;
 * - component payout readiness;
 * - payout scheduling; and
 * - occurrence-level professional settlement state.
 *
 * This service may READ final OT facts created by:
 *
 * - shiftOvertimeService; and
 * - shiftOvertimeFundingService.
 *
 * It does not create, decide, fund, collect, reverse, or adjudicate OT.
 *
 * This service does NOT own:
 *
 * - OT request creation;
 * - OT employer approval/rejection;
 * - OT response expiry;
 * - OT appeal;
 * - OT admin adjudication;
 * - OT pricing authority;
 * - OT top-up establishment;
 * - OT top-up deadlines;
 * - OT delinquency;
 * - employer restrictions;
 * - OT funding verification;
 * - platform-fee earning or collection;
 * - employer refund execution;
 * - parent Shift reconciliation; or
 * - professional payout execution.
 *
 * CHALLENGE MODEL
 *
 * The occurrence owns one shared initial 24-hour review window.
 *
 * Submitting a professional claim or employer dispute does not close that
 * window.
 *
 * activeClaim and activeDispute may coexist.
 *
 * Settlement finality is component-specific:
 *
 * 1. the component must no longer have an ordinary challenge opportunity;
 * 2. no unresolved professional-claim ISSUE may affect the component; and
 * 3. no unresolved employer-dispute ISSUE may affect the component.
 *
 * IMPORTANT:
 *
 * Professional-claim settlement scope is stored only on:
 *
 * issues[].affectedSettlementComponents
 *
 * Employer-dispute issue scope is likewise stored on:
 *
 * issues[].affectedSettlementComponents
 *
 * Live professional-claim scope is derived only from claim issues whose status
 * is not "resolved".
 *
 * Live employer-dispute scope is derived only from dispute issues whose status
 * is not "resolved".
 *
 * An active challenge affecting BASE does not block OT settlement.
 *
 * An OT-only workflow does not block BASE settlement.
 */

class ShiftSettlementService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftSettlementServiceError";
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
    return String(value)
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  static normalizeObjectId(value, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
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

  static normalizeDate(value, fieldName, statusCode = 400) {
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

  static normalizeNonNegativeAmount(value, fieldName) {
    try {
      return money.normalizeMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw this.createError({
        message: `${fieldName} must be a non-negative whole minor-unit amount.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
      });
    }
  }

  static normalizeReleaseSource(value = "automatic") {
    const source = String(value || "automatic")
      .trim()
      .toLowerCase();

    if (!SETTLEMENT_APPROVAL_SOURCES.includes(source)) {
      throw this.createError({
        message: "Settlement release source is invalid.",
        code: "INVALID_SETTLEMENT_RELEASE_SOURCE",
      });
    }

    return source;
  }

  static normalizeReleaseActor({ releaseSource, releasedByUserId = null }) {
    const source = this.normalizeReleaseSource(releaseSource);

    const releasedBy = this.normalizeObjectId(
      releasedByUserId,
      "released-by user ID",
      source !== "automatic"
    );

    if (source === "automatic" && releasedBy) {
      throw this.createError({
        message: "System release-readiness cannot contain a released-by user ID.",
        code: "AUTOMATIC_SETTLEMENT_RELEASE_USER_NOT_ALLOWED",
      });
    }

    return {
      releaseSource: source,
      releasedBy,
    };
  }

  static normalizeComponent(value) {
    const component = String(value || "")
      .trim()
      .toLowerCase();

    if (!SETTLEMENT_BATCH_COMPONENTS.includes(component)) {
      throw this.createError({
        message: "Settlement component is invalid.",
        code: "INVALID_SETTLEMENT_COMPONENT",
        details: {
          component: component || null,
          supportedComponents: SETTLEMENT_BATCH_COMPONENTS,
        },
      });
    }

    return component;
  }

  static normalizeAffectedSettlementComponents(
    values,
    { allowEmpty = false, fieldLabel = "active challenge" } = {}
  ) {
    const source = Array.isArray(values) ? values : [];

    const normalized = source.map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    );

    const unique = [...new Set(normalized)];

    if (
      unique.length !== normalized.length ||
      unique.some((component) => !SETTLEMENT_BATCH_COMPONENTS.includes(component)) ||
      (!allowEmpty && unique.length === 0)
    ) {
      throw this.createError({
        message: `The ${fieldLabel} contains an invalid settlement-component scope.`,
        code: "INVALID_ACTIVE_CHALLENGE_SETTLEMENT_SCOPE",
        statusCode: 500,
      });
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => unique.includes(component));
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getOccurrence(occurrenceId, session = null) {
    const id = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const query = ShiftOccurrence.findById(id);

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

  static assertCompleteAssignment(occurrence) {
    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignedProfessional ||
      !occurrence.assignment ||
      !occurrence.assignedAt
    ) {
      throw this.createError({
        message: "The occurrence does not have a complete professional assignment.",
        code: "OCCURRENCE_ASSIGNMENT_INCOMPLETE",
        statusCode: 409,
      });
    }

    return occurrence;
  }

  /* ─────────────────────────────── COMPONENT AUDIT ─────────────────────────────── */

  static getComponentAuditPath(component) {
    return COMPONENT_SETTLEMENT_PATHS[this.normalizeComponent(component)];
  }

  static getComponentAudit(occurrence, component) {
    return occurrence[this.getComponentAuditPath(component)] || {};
  }

  static getComponentStatus(occurrence, component) {
    const normalizedComponent = this.normalizeComponent(component);

    const status = this.getComponentAudit(occurrence, normalizedComponent).status || "not_due";

    if (!SETTLEMENT_COMPONENT_STATUSES.includes(status)) {
      throw this.createError({
        message: "The occurrence contains an invalid settlement-component status.",
        code: "INVALID_COMPONENT_SETTLEMENT_STATUS",
        statusCode: 500,
        details: {
          component: normalizedComponent,
          status,
        },
      });
    }

    return status;
  }

  static assertComponentNotInExecution({ occurrence, component, actionLabel = "change" }) {
    const normalizedComponent = this.normalizeComponent(component);

    const status = this.getComponentStatus(occurrence, normalizedComponent);

    if (COMPONENT_EXECUTION_STARTED_STATUSES.includes(status)) {
      throw this.createError({
        message:
          normalizedComponent === "base"
            ? `Regular Shift pay has already entered payout execution and cannot ${actionLabel}.`
            : `Overtime pay has already entered payout execution and cannot ${actionLabel}.`,
        code:
          normalizedComponent === "base"
            ? "BASE_SETTLEMENT_ALREADY_IN_EXECUTION"
            : "OVERTIME_SETTLEMENT_ALREADY_IN_EXECUTION",
        statusCode: 409,
      });
    }

    return status;
  }

  static getBaseSettlementAmounts(occurrence) {
    if (occurrence.activeWorkCancellation?.occurred === true) {
      return {
        earningType: "active_work_cancellation",

        professionalPay: Number(occurrence.activeWorkCancellation.professionalPay || 0),
      };
    }

    if (occurrence.cancellationCompensation?.applicable === true) {
      return {
        earningType: "cancellation_compensation",

        professionalPay: Number(occurrence.cancellationCompensation.professionalPay || 0),
      };
    }

    return {
      earningType: "worked_base",

      professionalPay: Number(occurrence.baseProfessionalPay || 0),
    };
  }

  static getComponentAmounts({ occurrence, component }) {
    const normalizedComponent = this.normalizeComponent(component);

    if (normalizedComponent === "base") {
      return this.getBaseSettlementAmounts(occurrence);
    }

    return {
      earningType: "overtime",

      professionalPay: Number(occurrence.overtimeProfessionalPay || 0),
    };
  }

  static assertComponentAmounts({ component, amounts, requirePayable = false }) {
    const normalizedComponent = this.normalizeComponent(component);

    if (!SETTLEMENT_LINE_EARNING_TYPES.includes(amounts?.earningType)) {
      throw this.createError({
        message: "Settlement earning type is invalid.",
        code: "INVALID_SETTLEMENT_EARNING_TYPE",
        statusCode: 500,
        details: {
          component: normalizedComponent,
          earningType: amounts?.earningType || null,
        },
      });
    }

    const professionalPay = Number(amounts?.professionalPay || 0);

    if (!Number.isSafeInteger(professionalPay) || professionalPay < 0) {
      throw this.createError({
        message: "Professional settlement amount is incomplete or invalid.",
        code: "INVALID_COMPONENT_SETTLEMENT_PRICING",
        statusCode: 409,
        details: {
          component: normalizedComponent,
        },
      });
    }

    if (requirePayable && professionalPay <= 0) {
      throw this.createError({
        message:
          "A settlement component with no professional earnings cannot enter payout release.",
        code:
          normalizedComponent === "base"
            ? "BASE_COMPONENT_HAS_NO_PAYABLE_EARNINGS"
            : "OVERTIME_COMPONENT_HAS_NO_PAYABLE_EARNINGS",
        statusCode: 409,
      });
    }

    return {
      earningType: amounts.earningType,
      professionalPay,
    };
  }

  static isComponentPayable({ occurrence, component }) {
    const amount = Number(
      this.getComponentAmounts({
        occurrence,
        component,
      }).professionalPay
    );

    return Number.isSafeInteger(amount) && amount > 0;
  }

  static initializeComponentSettlement({ occurrence, component }) {
    const normalizedComponent = this.normalizeComponent(component);

    const path = this.getComponentAuditPath(normalizedComponent);

    const amounts = this.assertComponentAmounts({
      component: normalizedComponent,

      amounts: this.getComponentAmounts({
        occurrence,
        component: normalizedComponent,
      }),
    });

    const existing = occurrence[path] || {};

    const status = existing.status || "not_due";

    if (COMPONENT_EXECUTION_STARTED_STATUSES.includes(status)) {
      if (
        existing.earningType !== amounts.earningType ||
        Number(existing.professionalPay || 0) !== amounts.professionalPay
      ) {
        throw this.createError({
          message:
            normalizedComponent === "base"
              ? "Regular Shift pay is already in payout execution and cannot be repriced."
              : "Overtime pay is already in payout execution and cannot be repriced.",
          code:
            normalizedComponent === "base"
              ? "BASE_EXECUTING_PRICING_CHANGE_NOT_ALLOWED"
              : "OVERTIME_EXECUTING_PRICING_CHANGE_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      return occurrence[path];
    }

    if (status === "approved_for_release") {
      if (
        existing.earningType !== amounts.earningType ||
        Number(existing.professionalPay || 0) !== amounts.professionalPay
      ) {
        throw this.createError({
          message:
            normalizedComponent === "base"
              ? "Approved regular Shift pay must be reset through authoritative resolution before it can change."
              : "Approved overtime pay cannot be repriced by the settlement service.",
          code:
            normalizedComponent === "base"
              ? "BASE_APPROVED_PRICING_CHANGE_NOT_ALLOWED"
              : "OVERTIME_APPROVED_PRICING_CHANGE_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      return occurrence[path];
    }

    occurrence.set(path, {
      status: "not_due",
    });

    return occurrence[path];
  }

  static resetComponentSettlement({ occurrence, component }) {
    const normalizedComponent = this.normalizeComponent(component);

    this.assertComponentNotInExecution({
      occurrence,
      component: normalizedComponent,
      actionLabel: "be reset",
    });

    const path = this.getComponentAuditPath(normalizedComponent);

    occurrence.set(path, {
      status: "not_due",
    });

    return occurrence[path];
  }

  static isFinalApprovedOvertimeEntitlement(occurrence) {
    const requestedMinutes = Number(occurrence.overtime?.requestedMinutes);

    const professionalPay = Number(occurrence.overtimeProfessionalPay);

    return Boolean(
      occurrence.overtime?.requested === true &&
      occurrence.overtime?.status === "approved" &&
      Number.isSafeInteger(requestedMinutes) &&
      requestedMinutes > 0 &&
      Number.isSafeInteger(professionalPay) &&
      professionalPay > 0
    );
  }

  static isFundedOvertimeHandoffComplete(occurrence) {
    return Boolean(
      this.isFinalApprovedOvertimeEntitlement(occurrence) &&
      occurrence.overtime?.topUpPaid === true &&
      occurrence.overtime?.topUpPaidAt &&
      occurrence.topUpTransaction &&
      Number(occurrence.topUpRequired || 0) === 0
    );
  }

  static getPayableSettlementComponents(occurrence) {
    const components = [];

    if (
      this.isComponentPayable({
        occurrence,
        component: "base",
      })
    ) {
      components.push("base");
    }

    if (
      this.isFinalApprovedOvertimeEntitlement(occurrence) &&
      this.isComponentPayable({
        occurrence,
        component: "overtime",
      })
    ) {
      components.push("overtime");
    }

    return components;
  }

  /* ─────────────────────────────── SHARED REVIEW WINDOW ─────────────────────────────── */

  static getOrdinarilyChallengeableComponents(occurrence) {
    const source = Array.isArray(occurrence.challengeableSettlementComponents)
      ? occurrence.challengeableSettlementComponents
      : [];

    const normalized = source.map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    );

    const unique = [...new Set(normalized)];

    if (
      unique.length !== normalized.length ||
      unique.some((component) => !SETTLEMENT_BATCH_COMPONENTS.includes(component))
    ) {
      throw this.createError({
        message: "The occurrence contains invalid ordinary challenge component scope.",
        code: "INVALID_OCCURRENCE_CHALLENGE_COMPONENT_SCOPE",
        statusCode: 500,
      });
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => unique.includes(component));
  }

  static getChallengeWindowDeadline(occurrence, { required = false } = {}) {
    if (!occurrence.challengeDeadlineAt) {
      if (required) {
        throw this.createError({
          message: "The occurrence is missing its shared challenge deadline.",
          code: "OCCURRENCE_CHALLENGE_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      return null;
    }

    return this.normalizeDate(occurrence.challengeDeadlineAt, "challenge deadline", 500);
  }

  static isChallengeWindowOpen({ occurrence, currentTime }) {
    const challengeableComponents = this.getOrdinarilyChallengeableComponents(occurrence);

    if (challengeableComponents.length === 0) {
      return false;
    }

    if (!occurrence.challengeWindowOpenedAt) {
      throw this.createError({
        message:
          "The occurrence has challengeable components but no challenge-window opening time.",
        code: "OCCURRENCE_CHALLENGE_WINDOW_OPENING_MISSING",
        statusCode: 500,
      });
    }

    const deadline = this.getChallengeWindowDeadline(occurrence, {
      required: true,
    });

    const now = this.normalizeDate(currentTime, "challenge-window evaluation time", 500);

    /**
     * The deadline is authoritative.
     *
     * A claim/dispute submission must not cause the
     * ordinary 24-hour window to be treated as closed early.
     */
    return now < deadline;
  }

  static isComponentOrdinarilyChallengeable({ occurrence, component, currentTime }) {
    const normalizedComponent = this.normalizeComponent(component);

    if (!this.getOrdinarilyChallengeableComponents(occurrence).includes(normalizedComponent)) {
      return false;
    }

    return this.isChallengeWindowOpen({
      occurrence,
      currentTime,
    });
  }

  static establishInitialChallengeWindow({ occurrence, openedAt, components }) {
    const normalizedOpenedAt = this.normalizeDate(openedAt, "challenge window opening time", 500);

    const normalizedComponents = this.normalizeAffectedSettlementComponents(components, {
      allowEmpty: false,
      fieldLabel: "initial challenge window",
    });

    if (occurrence.challengeWindowOpenedAt) {
      const existingOpenedAt = this.normalizeDate(
        occurrence.challengeWindowOpenedAt,
        "challenge window opening time",
        500
      );

      const existingDeadline = this.getChallengeWindowDeadline(occurrence, {
        required: true,
      });

      const currentComponents = this.getOrdinarilyChallengeableComponents(occurrence);

      if (normalizedOpenedAt < existingDeadline) {
        occurrence.challengeableSettlementComponents = SETTLEMENT_BATCH_COMPONENTS.filter(
          (component) =>
            currentComponents.includes(component) || normalizedComponents.includes(component)
        );
      }

      return {
        openedAt: existingOpenedAt,
        deadlineAt: existingDeadline,

        challengeableSettlementComponents: this.getOrdinarilyChallengeableComponents(occurrence),

        idempotent: true,
      };
    }

    const deadlineAt = new Date(
      normalizedOpenedAt.getTime() + SHARED_REVIEW_WINDOW_HOURS * HOUR_MS
    );

    occurrence.challengeWindowOpenedAt = normalizedOpenedAt;

    occurrence.challengeDeadlineAt = deadlineAt;

    occurrence.challengeWindowClosedAt = null;

    occurrence.challengeableSettlementComponents = normalizedComponents;

    return {
      openedAt: normalizedOpenedAt,
      deadlineAt,

      challengeableSettlementComponents: normalizedComponents,

      idempotent: false,
    };
  }

  static synchronizeExpiredChallengeWindow({ occurrence, currentTime }) {
    const now = this.normalizeDate(currentTime, "challenge-window synchronization time", 500);

    const components = this.getOrdinarilyChallengeableComponents(occurrence);

    if (components.length === 0) {
      if (
        occurrence.challengeDeadlineAt &&
        now >=
          this.getChallengeWindowDeadline(occurrence, {
            required: true,
          })
      ) {
        occurrence.challengeWindowClosedAt =
          occurrence.challengeWindowClosedAt ||
          this.getChallengeWindowDeadline(occurrence, {
            required: true,
          });
      }

      return {
        expired: Boolean(occurrence.challengeWindowClosedAt),

        finalizedComponents: [],

        idempotent: true,
      };
    }

    const deadline = this.getChallengeWindowDeadline(occurrence, {
      required: true,
    });

    if (now < deadline) {
      return {
        expired: false,

        finalizedComponents: [],

        challengeableSettlementComponents: components,

        idempotent: true,
      };
    }

    occurrence.challengeWindowClosedAt = occurrence.challengeWindowClosedAt || deadline;

    occurrence.challengeableSettlementComponents = [];

    return {
      expired: true,

      finalizedComponents: components,

      challengeableSettlementComponents: [],

      idempotent: false,
    };
  }

  /* ─────────────────────────────── ACTIVE CHALLENGE SCOPE ─────────────────────────────── */

  static getUnresolvedClaimAffectedSettlementComponents(claim) {
    const issues = Array.isArray(claim?.issues) ? claim.issues : [];

    const unresolvedIssues = issues.filter(
      (issue) =>
        String(issue?.status || "")
          .trim()
          .toLowerCase() !== "resolved"
    );

    const aggregate = new Set();

    for (const issue of unresolvedIssues) {
      const issueScope = this.normalizeAffectedSettlementComponents(
        Array.isArray(issue?.affectedSettlementComponents)
          ? issue.affectedSettlementComponents
          : [],
        {
          allowEmpty: false,
          fieldLabel: "active professional claim issue",
        }
      );

      for (const component of issueScope) {
        aggregate.add(component);
      }
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => aggregate.has(component));
  }

  static async getActiveClaimCase({ caseId, session }) {
    if (!caseId) {
      return null;
    }

    const query = ShiftOccurrenceClaim.findById(caseId).select(
      "status issues.status issues.affectedSettlementComponents"
    );

    if (session) {
      query.session(session);
    }

    const claim = await query;

    if (!claim) {
      throw this.createError({
        message:
          "The occurrence references an active professional claim record that does not exist.",
        code: "ACTIVE_OCCURRENCE_CLAIM_NOT_FOUND",
        statusCode: 500,
      });
    }

    if (claim.status !== "active") {
      throw this.createError({
        message: "The occurrence references a professional claim that is no longer active.",
        code: "ACTIVE_OCCURRENCE_CLAIM_STATUS_INVALID",
        statusCode: 500,
        details: {
          claimId: String(claim._id),
          claimStatus: claim.status || null,
        },
      });
    }

    const affectedSettlementComponents = this.getUnresolvedClaimAffectedSettlementComponents(claim);

    if (affectedSettlementComponents.length === 0) {
      throw this.createError({
        message:
          "The occurrence references an active professional claim with no unresolved issue scope.",
        code: "ACTIVE_OCCURRENCE_CLAIM_HAS_NO_UNRESOLVED_SCOPE",
        statusCode: 500,
        details: {
          claimId: String(claim._id),
        },
      });
    }

    return {
      type: "claim",
      caseDocument: claim,
      affectedSettlementComponents,
    };
  }

  static getUnresolvedDisputeAffectedSettlementComponents(dispute) {
    const issues = Array.isArray(dispute?.issues) ? dispute.issues : [];

    const unresolvedIssues = issues.filter(
      (issue) =>
        String(issue?.status || "")
          .trim()
          .toLowerCase() !== "resolved"
    );

    const aggregate = new Set();

    for (const issue of unresolvedIssues) {
      const issueScope = this.normalizeAffectedSettlementComponents(
        Array.isArray(issue?.affectedSettlementComponents)
          ? issue.affectedSettlementComponents
          : [],
        {
          allowEmpty: false,
          fieldLabel: "active employer dispute issue",
        }
      );

      for (const component of issueScope) {
        aggregate.add(component);
      }
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => aggregate.has(component));
  }

  static async getActiveDisputeCase({ caseId, session }) {
    if (!caseId) {
      return null;
    }

    const query = ShiftOccurrenceDispute.findById(caseId).select(
      "status issues.status issues.affectedSettlementComponents"
    );

    if (session) {
      query.session(session);
    }

    const dispute = await query;

    if (!dispute) {
      throw this.createError({
        message: "The occurrence references an active employer dispute record that does not exist.",
        code: "ACTIVE_OCCURRENCE_DISPUTE_NOT_FOUND",
        statusCode: 500,
      });
    }

    if (dispute.status !== "active") {
      throw this.createError({
        message: "The occurrence references an employer dispute that is no longer active.",
        code: "ACTIVE_OCCURRENCE_DISPUTE_STATUS_INVALID",
        statusCode: 500,
        details: {
          disputeId: String(dispute._id),
          disputeStatus: dispute.status || null,
        },
      });
    }

    const affectedSettlementComponents =
      this.getUnresolvedDisputeAffectedSettlementComponents(dispute);

    if (affectedSettlementComponents.length === 0) {
      throw this.createError({
        message:
          "The occurrence references an active employer dispute with no unresolved issue scope.",
        code: "ACTIVE_OCCURRENCE_DISPUTE_HAS_NO_UNRESOLVED_SCOPE",
        statusCode: 500,
        details: {
          disputeId: String(dispute._id),
        },
      });
    }

    return {
      type: "dispute",
      caseDocument: dispute,
      affectedSettlementComponents,
    };
  }

  static async getActiveChallengeContext({ occurrence, session = null }) {
    const [claimContext, disputeContext] = await Promise.all([
      this.getActiveClaimCase({
        caseId: occurrence.activeClaim,
        session,
      }),

      this.getActiveDisputeCase({
        caseId: occurrence.activeDispute,
        session,
      }),
    ]);

    const affectedSettlementComponents = SETTLEMENT_BATCH_COMPONENTS.filter((component) =>
      Boolean(
        claimContext?.affectedSettlementComponents.includes(component) ||
        disputeContext?.affectedSettlementComponents.includes(component)
      )
    );

    return {
      claim: claimContext,
      dispute: disputeContext,

      hasActiveClaim: Boolean(claimContext),
      hasActiveDispute: Boolean(disputeContext),
      hasAnyActiveChallenge: Boolean(claimContext || disputeContext),

      affectedSettlementComponents,
    };
  }

  static isComponentChallenged({ component, challengeContext }) {
    const normalizedComponent = this.normalizeComponent(component);

    return Boolean(challengeContext?.affectedSettlementComponents?.includes(normalizedComponent));
  }

  static assertComponentChallengeFinal({
    occurrence,
    component,
    challengeContext,
    currentTime,
    actionLabel = "continue settlement",
  }) {
    const normalizedComponent = this.normalizeComponent(component);

    if (
      this.isComponentChallenged({
        component: normalizedComponent,
        challengeContext,
      })
    ) {
      throw this.createError({
        message:
          normalizedComponent === "base"
            ? `Regular Shift pay has an unresolved challenge and cannot ${actionLabel}.`
            : `Overtime pay has an unresolved challenge and cannot ${actionLabel}.`,
        code:
          normalizedComponent === "base"
            ? "BASE_ACTIVE_CHALLENGE_BLOCKS_SETTLEMENT"
            : "OVERTIME_ACTIVE_CHALLENGE_BLOCKS_SETTLEMENT",
        statusCode: 409,
      });
    }

    if (
      this.isComponentOrdinarilyChallengeable({
        occurrence,
        component: normalizedComponent,
        currentTime,
      })
    ) {
      throw this.createError({
        message:
          normalizedComponent === "base"
            ? `Regular Shift pay is still challengeable and cannot ${actionLabel}.`
            : `Overtime is still challengeable and cannot ${actionLabel}.`,
        code:
          normalizedComponent === "base"
            ? "BASE_COMPONENT_STILL_CHALLENGEABLE"
            : "OVERTIME_COMPONENT_STILL_CHALLENGEABLE",
        statusCode: 409,
        details: {
          challengeDeadlineAt: occurrence.challengeDeadlineAt || null,
        },
      });
    }

    return true;
  }

  static isComponentFinal({ occurrence, component, challengeContext, currentTime }) {
    const normalizedComponent = this.normalizeComponent(component);

    if (
      this.isComponentChallenged({
        component: normalizedComponent,
        challengeContext,
      })
    ) {
      return false;
    }

    if (
      this.isComponentOrdinarilyChallengeable({
        occurrence,
        component: normalizedComponent,
        currentTime,
      })
    ) {
      return false;
    }

    return true;
  }

  /* ─────────────────────────────── BASE PRICING ─────────────────────────────── */

  static calculateProfessionalPay({ hourlyRate, minutes }) {
    if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) {
      throw this.createError({
        message: "Occurrence hourly rate is invalid.",

        code: "INVALID_OCCURRENCE_HOURLY_RATE",

        statusCode: 500,
      });
    }

    if (!Number.isSafeInteger(minutes) || minutes < 0) {
      throw this.createError({
        message: "Billable minutes are invalid.",

        code: "INVALID_OCCURRENCE_BILLABLE_MINUTES",

        statusCode: 500,
      });
    }

    try {
      return money.calculateMinorPayFromMinutes({
        hourlyRateMinor: hourlyRate,
        minutes,
        fieldName: "Professional settlement amount",
      });
    } catch (error) {
      throw this.createError({
        message: "The calculated settlement amount is invalid or too large.",
        code: "SETTLEMENT_AMOUNT_TOO_LARGE",
        statusCode: 500,
      });
    }
  }

  /* ─────────────────────────────── ATTENDANCE / BASE BILLABLE TIME ─────────────────────────────── */

  static resolveAttendanceStart(occurrence) {
    return occurrence.attendanceOverride?.approvedStartTime || occurrence.checkedInAt || null;
  }

  static resolveAttendanceEnd(occurrence) {
    return (
      occurrence.attendanceOverride?.approvedEndTime ||
      occurrence.checkoutFallback?.approvedEndTime ||
      occurrence.checkedOutAt ||
      null
    );
  }

  static calculateBaseBillableTime(occurrence) {
    const attendanceStart = this.resolveAttendanceStart(occurrence);
    const attendanceEnd = this.resolveAttendanceEnd(occurrence);

    if (!attendanceStart || !attendanceEnd) {
      throw this.createError({
        message:
          "Approved check-in and check-out times are required before settlement preparation.",
        code: "OCCURRENCE_ATTENDANCE_TIMES_REQUIRED",
        statusCode: 409,
      });
    }

    const actualStart = this.normalizeDate(attendanceStart, "approved attendance start time", 409);

    const actualEnd = this.normalizeDate(attendanceEnd, "approved attendance end time", 409);

    if (actualEnd <= actualStart) {
      throw this.createError({
        message: "The approved attendance time range is invalid.",
        code: "INVALID_OCCURRENCE_ATTENDANCE_RANGE",
        statusCode: 409,
      });
    }

    const scheduledStart = this.normalizeDate(occurrence.startTime, "occurrence start time", 500);

    const scheduledEnd = this.normalizeDate(occurrence.endTime, "occurrence end time", 500);

    const baseStart = new Date(Math.max(actualStart.getTime(), scheduledStart.getTime()));

    const baseEnd = new Date(Math.min(actualEnd.getTime(), scheduledEnd.getTime()));

    const durationMs = baseEnd.getTime() - baseStart.getTime();

    if (durationMs <= 0 || durationMs % MINUTE_MS !== 0) {
      throw this.createError({
        message: "No valid whole-minute BASE billable period could be determined.",
        code: "NO_BILLABLE_OCCURRENCE_TIME",
        statusCode: 409,
      });
    }

    const baseBillableMinutes = durationMs / MINUTE_MS;

    if (
      !Number.isSafeInteger(baseBillableMinutes) ||
      baseBillableMinutes <= 0 ||
      baseBillableMinutes > MINUTES_PER_DAY
    ) {
      throw this.createError({
        message: "The calculated BASE billable period is invalid.",
        code: "INVALID_BASE_BILLABLE_TIME",
        statusCode: 409,
      });
    }

    return {
      attendanceStart: actualStart,
      attendanceEnd: actualEnd,
      baseStart,
      baseEnd,
      baseBillableMinutes,
      baseBillableHours: Number((baseBillableMinutes / 60).toFixed(4)),
    };
  }

  static applyBasePricing({ occurrence, baseBillableMinutes }) {
    const professionalPay = this.calculateProfessionalPay({
      hourlyRate: occurrence.hourlyRate,
      minutes: baseBillableMinutes,
    });

    occurrence.baseBillableHours = Number((baseBillableMinutes / 60).toFixed(4));
    occurrence.baseProfessionalPay = professionalPay;

    return {
      professionalPay,
      retainedBasePlatformFee: Number(occurrence.basePlatformFee || 0),
    };
  }

  static synchronizeBillableHours(occurrence) {
    const baseHours = Number(occurrence.baseBillableHours || 0);

    if (!Number.isFinite(baseHours) || baseHours < 0) {
      throw this.createError({
        message: "The occurrence BASE billable hours are invalid.",
        code: "INVALID_BASE_BILLABLE_HOURS",
        statusCode: 500,
      });
    }

    let approvedOvertimeHours = 0;

    if (this.isFinalApprovedOvertimeEntitlement(occurrence)) {
      const requestedMinutes = Number(occurrence.overtime?.requestedMinutes);

      if (!Number.isSafeInteger(requestedMinutes) || requestedMinutes <= 0) {
        throw this.createError({
          message: "Final approved overtime minutes are invalid.",
          code: "INVALID_FINAL_APPROVED_OVERTIME_MINUTES",
          statusCode: 500,
        });
      }

      approvedOvertimeHours = requestedMinutes / 60;
    }

    occurrence.billableHours = Number((baseHours + approvedOvertimeHours).toFixed(4));

    return occurrence;
  }

  static isBasePricingComplete(occurrence) {
    return Boolean(
      occurrence.baseBillableHours !== null &&
      occurrence.baseBillableHours !== undefined &&
      Number.isSafeInteger(Number(occurrence.baseProfessionalPay)) &&
      Number(occurrence.baseProfessionalPay) >= 0
    );
  }

  /* ─────────────────────────────── PAYOUT SCHEDULING ─────────────────────────────── */

  static validatePayoutPolicy({
    payoutWeekday = DEFAULT_PAYOUT_WEEKDAY,
    payoutHour = DEFAULT_PAYOUT_HOUR,
    payoutMinute = DEFAULT_PAYOUT_MINUTE,
    timeZone = DEFAULT_PAYOUT_TIME_ZONE,
  } = {}) {
    if (!Number.isSafeInteger(payoutWeekday) || payoutWeekday < 0 || payoutWeekday > 6) {
      throw this.createError({
        message: "Payout weekday must be a whole number from 0 to 6.",
        code: "INVALID_PAYOUT_WEEKDAY",
        statusCode: 500,
      });
    }

    if (!Number.isSafeInteger(payoutHour) || payoutHour < 0 || payoutHour > 23) {
      throw this.createError({
        message: "Payout hour must be a whole number from 0 to 23.",
        code: "INVALID_PAYOUT_HOUR",
        statusCode: 500,
      });
    }

    if (!Number.isSafeInteger(payoutMinute) || payoutMinute < 0 || payoutMinute > 59) {
      throw this.createError({
        message: "Payout minute must be a whole number from 0 to 59.",
        code: "INVALID_PAYOUT_MINUTE",
        statusCode: 500,
      });
    }

    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone,
      }).format();
    } catch (error) {
      throw this.createError({
        message: "Payout timezone is invalid.",
        code: "INVALID_PAYOUT_TIME_ZONE",
        statusCode: 500,
      });
    }

    return {
      payoutWeekday,
      payoutHour,
      payoutMinute,
      timeZone,
    };
  }

  static getZonedDateTimeParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(this.normalizeDate(date, "payout date", 500));

    const map = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );

    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second),
    };
  }

  static getTimeZoneOffsetMilliseconds(date, timeZone) {
    const parsed = new Date(date);

    const parts = this.getZonedDateTimeParts(parsed, timeZone);

    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );

    return representedAsUtc - Math.floor(parsed.getTime() / 1000) * 1000;
  }

  static zonedDateTimeToUtc({ year, month, day, hour, minute, second = 0, timeZone }) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);

    let candidate = new Date(utcGuess);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      candidate = new Date(utcGuess - this.getTimeZoneOffsetMilliseconds(candidate, timeZone));
    }

    return candidate;
  }

  static calculateNextPayoutAt({ readyAt, payoutPolicy = {} }) {
    const policy = this.validatePayoutPolicy(payoutPolicy);

    const readyDate = this.normalizeDate(readyAt, "settlement release-readiness time", 500);

    const local = this.getZonedDateTimeParts(readyDate, policy.timeZone);

    const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));

    const daysUntil = (policy.payoutWeekday - localDate.getUTCDay() + 7) % 7;

    let candidateLocalDate = new Date(localDate.getTime() + daysUntil * DAY_MS);

    let candidate = this.zonedDateTimeToUtc({
      year: candidateLocalDate.getUTCFullYear(),
      month: candidateLocalDate.getUTCMonth() + 1,
      day: candidateLocalDate.getUTCDate(),
      hour: policy.payoutHour,
      minute: policy.payoutMinute,
      timeZone: policy.timeZone,
    });

    if (candidate <= readyDate) {
      candidateLocalDate = new Date(candidateLocalDate.getTime() + 7 * DAY_MS);

      candidate = this.zonedDateTimeToUtc({
        year: candidateLocalDate.getUTCFullYear(),
        month: candidateLocalDate.getUTCMonth() + 1,
        day: candidateLocalDate.getUTCDate(),
        hour: policy.payoutHour,
        minute: policy.payoutMinute,
        timeZone: policy.timeZone,
      });
    }

    return candidate;
  }

  /* ─────────────────────────────── COMPONENT READINESS ─────────────────────────────── */

  static assertComponentEntitlementReady({ occurrence, component }) {
    const normalizedComponent = this.normalizeComponent(component);

    if (normalizedComponent === "base") {
      if (!this.isBasePricingComplete(occurrence)) {
        throw this.createError({
          message: "BASE professional entitlement has not been established.",
          code: "BASE_SETTLEMENT_ENTITLEMENT_NOT_READY",
          statusCode: 409,
        });
      }

      return true;
    }

    if (!this.isFinalApprovedOvertimeEntitlement(occurrence)) {
      throw this.createError({
        message: "Overtime has not reached a final approved professional entitlement.",
        code: "OVERTIME_SETTLEMENT_ENTITLEMENT_NOT_FINAL",
        statusCode: 409,
      });
    }

    if (!this.isFundedOvertimeHandoffComplete(occurrence)) {
      throw this.createError({
        message: "Final overtime entitlement has not been handed to settlement as funded.",
        code: "OVERTIME_SETTLEMENT_FUNDING_HANDOFF_INCOMPLETE",
        statusCode: 409,
      });
    }

    return true;
  }

  static applyComponentReleaseReadiness({
    occurrence,
    component,
    readyAt,
    releaseSource = "automatic",
    releasedByUserId = null,
    payoutPolicy = {},
    challengeContext = null,
  }) {
    const normalizedComponent = this.normalizeComponent(component);

    const normalizedReadyAt = this.normalizeDate(readyAt, "settlement release-readiness time", 500);

    const actor = this.normalizeReleaseActor({
      releaseSource,
      releasedByUserId,
    });

    const currentStatus = this.getComponentStatus(occurrence, normalizedComponent);

    if (COMPONENT_RELEASE_READY_STATUSES.includes(currentStatus)) {
      const audit = this.getComponentAudit(occurrence, normalizedComponent);

      return {
        component: normalizedComponent,
        readyAt: audit.approvedForReleaseAt || null,
        scheduledPayoutAt: audit.scheduledPayoutAt || null,
        releaseSource: audit.approvalSource || null,
        releasedBy: audit.approvedForReleaseBy || null,
        idempotent: true,
      };
    }

    this.assertComponentChallengeFinal({
      occurrence,
      component: normalizedComponent,
      challengeContext,
      currentTime: normalizedReadyAt,
      actionLabel: "become ready for payout release",
    });

    this.assertComponentEntitlementReady({
      occurrence,
      component: normalizedComponent,
    });

    const amounts = this.assertComponentAmounts({
      component: normalizedComponent,
      amounts: this.getComponentAmounts({
        occurrence,
        component: normalizedComponent,
      }),
      requirePayable: true,
    });

    this.initializeComponentSettlement({
      occurrence,
      component: normalizedComponent,
    });

    const scheduledPayoutAt = this.calculateNextPayoutAt({
      readyAt: normalizedReadyAt,
      payoutPolicy,
    });

    occurrence.set(this.getComponentAuditPath(normalizedComponent), {
      status: "approved_for_release",
      earningType: amounts.earningType,
      professionalPay: amounts.professionalPay,
      approvedForReleaseAt: normalizedReadyAt,
      approvalSource: actor.releaseSource,
      approvedForReleaseBy: actor.releasedBy,
      scheduledPayoutAt,
      settlementBatch: null,
      releasePendingAt: null,
      releasedAt: null,
      payoutTransaction: null,
    });

    return {
      component: normalizedComponent,
      readyAt: normalizedReadyAt,
      scheduledPayoutAt,
      releaseSource: actor.releaseSource,
      releasedBy: actor.releasedBy,
      idempotent: false,
    };
  }

  /* ─────────────────────────────── OVERALL PROFESSIONAL SETTLEMENT STATE ─────────────────────────────── */

  static synchronizeOverallSettlementState({
    occurrence,
    currentTime = new Date(),
    challengeContext = null,
  }) {
    const now = this.normalizeDate(currentTime, "settlement-state synchronization time", 500);

    if (
      challengeContext?.hasAnyActiveChallenge ||
      occurrence.activeClaim ||
      occurrence.activeDispute
    ) {
      occurrence.settlementStatus = "disputed";
      occurrence.settledAt = null;

      return occurrence;
    }

    const overtime = occurrence.overtime || {};

    if (overtime.requested === true && !["approved", "rejected"].includes(overtime.status)) {
      occurrence.settlementStatus = "awaiting_overtime_review";
      occurrence.settledAt = null;

      return occurrence;
    }

    if (
      this.isFinalApprovedOvertimeEntitlement(occurrence) &&
      !this.isFundedOvertimeHandoffComplete(occurrence)
    ) {
      occurrence.settlementStatus = "awaiting_topup";
      occurrence.settledAt = null;

      return occurrence;
    }

    const payableComponents = this.getPayableSettlementComponents(occurrence);

    if (payableComponents.length === 0) {
      occurrence.settlementStatus = "not_due";
      occurrence.settledAt = null;

      return occurrence;
    }

    const states = payableComponents.map((component) => ({
      component,
      audit: this.getComponentAudit(occurrence, component),
      status: this.getComponentStatus(occurrence, component),
    }));

    if (states.some((item) => item.status === "release_pending")) {
      occurrence.settlementStatus = "release_pending";
      occurrence.settledAt = null;

      return occurrence;
    }

    if (states.some((item) => item.status === "approved_for_release")) {
      occurrence.settlementStatus = "approved_for_release";
      occurrence.settledAt = null;

      return occurrence;
    }

    if (states.every((item) => item.status === "released")) {
      occurrence.settlementStatus = "released";

      occurrence.settledAt =
        states
          .map((item) => item.audit?.releasedAt)
          .filter(Boolean)
          .sort((a, b) => new Date(b) - new Date(a))[0] || null;

      const ordinaryWindowOpen = this.isChallengeWindowOpen({
        occurrence,
        currentTime: now,
      });

      if (
        !ordinaryWindowOpen &&
        !occurrence.activeClaim &&
        !occurrence.activeDispute &&
        occurrence.status !== "cancelled" &&
        occurrence.status !== "no_show"
      ) {
        occurrence.status = "completed";
        occurrence.attendanceStatus = "settled";
      }

      return occurrence;
    }

    occurrence.settlementStatus = "pending_review";
    occurrence.settledAt = null;

    return occurrence;
  }

  /* ─────────────────────────────── BASE OUTCOME HANDOFF ─────────────────────────────── */

  static async establishBaseSettlementOutcome(
    { shiftId = null, occurrenceId, earningType, professionalPay, currentTime = new Date() },
    options = {}
  ) {
    const now = this.normalizeDate(currentTime, "base settlement outcome time");

    const normalizedEarningType = String(earningType || "")
      .trim()
      .toLowerCase();

    if (!BASE_SETTLEMENT_EARNING_TYPES.includes(normalizedEarningType)) {
      throw this.createError({
        message: "Base settlement earning type is invalid.",
        code: "INVALID_BASE_SETTLEMENT_EARNING_TYPE",
      });
    }

    const amount = this.normalizeNonNegativeAmount(professionalPay, "base professional pay");

    return this.runWithOptionalTransaction(options, async (session) => {
      const occurrence = await this.getOccurrence(occurrenceId, session);

      if (
        shiftId &&
        String(occurrence.shift) !== String(this.normalizeObjectId(shiftId, "shift ID"))
      ) {
        throw this.createError({
          message: "The occurrence does not belong to the supplied Shift.",
          code: "OCCURRENCE_SHIFT_MISMATCH",
          statusCode: 409,
        });
      }

      this.assertCompleteAssignment(occurrence);

      this.assertComponentNotInExecution({
        occurrence,
        component: "base",
        actionLabel: "be replaced by a new BASE outcome",
      });

      occurrence.baseProfessionalPay = amount;

      if (normalizedEarningType === "active_work_cancellation") {
        const minutes = Number(occurrence.activeWorkCancellation?.actualWorkedMinutes || 0);

        occurrence.baseBillableHours = Number((minutes / 60).toFixed(4));
      } else if (normalizedEarningType === "cancellation_compensation") {
        occurrence.baseBillableHours = 0;
      }

      this.synchronizeBillableHours(occurrence);

      if (amount > 0) {
        this.initializeComponentSettlement({
          occurrence,
          component: "base",
        });
      } else {
        this.resetComponentSettlement({
          occurrence,
          component: "base",
        });
      }

      const reviewWindow = this.establishInitialChallengeWindow({
        occurrence,
        openedAt: now,
        components: ["base"],
      });

      this.synchronizeExpiredChallengeWindow({
        occurrence,
        currentTime: now,
      });

      const challengeContext = await this.getActiveChallengeContext({
        occurrence,
        session,
      });

      this.synchronizeOverallSettlementState({
        occurrence,
        currentTime: now,
        challengeContext,
      });

      await occurrence.save({
        session,
      });

      return {
        occurrence,
        earningType: normalizedEarningType,
        professionalPay: amount,
        reviewWindow,
      };
    });
  }

  /* ─────────────────────────────── WORKED OCCURRENCE PREPARATION ─────────────────────────────── */

  static async startOccurrenceReview(
    { occurrenceId, currentTime = new Date(), payoutPolicy = {} },
    options = {}
  ) {
    const now = this.normalizeDate(currentTime, "settlement preparation time");

    return this.runWithOptionalTransaction(options, async (session) => {
      const occurrence = await this.getOccurrence(occurrenceId, session);

      this.assertCompleteAssignment(occurrence);

      if (["no_show", "cancelled"].includes(occurrence.status)) {
        throw this.createError({
          message: "Worked settlement preparation is not available for this occurrence outcome.",
          code: "WORKED_SETTLEMENT_PREPARATION_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      if (!["in_progress", "pending_settlement"].includes(occurrence.status)) {
        throw this.createError({
          message: "The occurrence is not ready for worked settlement preparation.",
          code: "OCCURRENCE_NOT_READY_FOR_SETTLEMENT_PREPARATION",
          statusCode: 409,
        });
      }

      if (
        occurrence.attendanceStatus !== "checked_out" ||
        !this.resolveAttendanceStart(occurrence) ||
        !this.resolveAttendanceEnd(occurrence)
      ) {
        throw this.createError({
          message:
            "Successful or approved check-in and check-out are required before settlement preparation.",
          code: "OCCURRENCE_CHECKOUT_REQUIRED_FOR_SETTLEMENT",
          statusCode: 409,
        });
      }

      const existingBaseStatus = this.getComponentStatus(occurrence, "base");

      if (COMPONENT_RELEASE_READY_STATUSES.includes(existingBaseStatus)) {
        return {
          occurrence,
          idempotent: true,
          reason: "base_settlement_already_release_ready",
        };
      }

      const billableTime = this.calculateBaseBillableTime(occurrence);

      this.applyBasePricing({
        occurrence,
        baseBillableMinutes: billableTime.baseBillableMinutes,
      });

      occurrence.status = "pending_settlement";

      this.synchronizeBillableHours(occurrence);

      this.initializeComponentSettlement({
        occurrence,
        component: "base",
      });

      const challengeComponents = ["base"];

      if (occurrence.overtime?.requested !== true) {
        challengeComponents.push("overtime");
      }

      const reviewWindow = this.establishInitialChallengeWindow({
        occurrence,
        openedAt: now,
        components: challengeComponents,
      });

      this.synchronizeExpiredChallengeWindow({
        occurrence,
        currentTime: now,
      });

      const challengeContext = await this.getActiveChallengeContext({
        occurrence,
        session,
      });

      let releaseReadiness = null;

      if (
        this.isComponentPayable({
          occurrence,
          component: "base",
        }) &&
        this.isComponentFinal({
          occurrence,
          component: "base",
          challengeContext,
          currentTime: now,
        })
      ) {
        releaseReadiness = this.applyComponentReleaseReadiness({
          occurrence,
          component: "base",
          readyAt: now,
          releaseSource: "automatic",
          releasedByUserId: null,
          payoutPolicy,
          challengeContext,
        });
      }

      this.synchronizeOverallSettlementState({
        occurrence,
        currentTime: now,
        challengeContext,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Settlement review prepared for occurrence ${occurrence.referenceCode}; ` +
          `BASE component status: ${this.getComponentStatus(occurrence, "base")}`
      );

      return {
        occurrence,
        idempotent: false,
        reviewWindow,
        releaseReadiness,

        baseEntitlement: {
          billableMinutes: billableTime.baseBillableMinutes,
          billableHours: occurrence.baseBillableHours,
          professionalPay: occurrence.baseProfessionalPay,
          retainedPlatformFee: occurrence.basePlatformFee,
        },

        components: {
          base: occurrence.baseSettlement,
          overtime: occurrence.overtimeSettlement,
        },

        settlement: {
          preparedAt: now,
          settlementStatus: occurrence.settlementStatus,
          baseBillableMinutes: billableTime.baseBillableMinutes,
          baseBillableHours: occurrence.baseBillableHours,
        },
      };
    });
  }

  /* ─────────────────────────────── COMPONENT RELEASE READINESS ─────────────────────────────── */

  static async markOccurrenceComponentReadyForRelease(
    {
      occurrenceId,
      component,
      releaseSource = "automatic",
      releasedByUserId = null,
      readyAt = new Date(),
      payoutPolicy = {},
    },
    options = {}
  ) {
    const normalizedComponent = this.normalizeComponent(component);

    const now = this.normalizeDate(readyAt, "settlement release-readiness time");

    const actor = this.normalizeReleaseActor({
      releaseSource,
      releasedByUserId,
    });

    return this.runWithOptionalTransaction(options, async (session) => {
      const occurrence = await this.getOccurrence(occurrenceId, session);

      this.assertCompleteAssignment(occurrence);

      this.synchronizeExpiredChallengeWindow({
        occurrence,
        currentTime: now,
      });

      const challengeContext = await this.getActiveChallengeContext({
        occurrence,
        session,
      });

      const currentStatus = this.getComponentStatus(occurrence, normalizedComponent);

      if (COMPONENT_RELEASE_READY_STATUSES.includes(currentStatus)) {
        return {
          occurrence,
          component: normalizedComponent,

          releaseReadiness: this.applyComponentReleaseReadiness({
            occurrence,
            component: normalizedComponent,
            readyAt: now,
            releaseSource: actor.releaseSource,
            releasedByUserId: actor.releasedBy,
            payoutPolicy,
            challengeContext,
          }),

          idempotent: true,
        };
      }

      const worked =
        occurrence.status === "pending_settlement" && occurrence.attendanceStatus === "checked_out";

      const compensatedCancellation =
        occurrence.status === "cancelled" &&
        occurrence.attendanceStatus === "not_started" &&
        occurrence.cancellationCompensation?.applicable === true;

      const activeWorkCancellation = occurrence.activeWorkCancellation?.occurred === true;

      if (
        normalizedComponent === "base" &&
        !worked &&
        !compensatedCancellation &&
        !activeWorkCancellation
      ) {
        throw this.createError({
          message: "The occurrence does not contain a payable BASE settlement outcome.",
          code: "BASE_SETTLEMENT_OUTCOME_NOT_PAYABLE",
          statusCode: 409,
        });
      }

      if (
        normalizedComponent === "overtime" &&
        (!worked || !this.isFinalApprovedOvertimeEntitlement(occurrence))
      ) {
        throw this.createError({
          message: "The occurrence does not contain a final payable overtime entitlement.",
          code: "OVERTIME_SETTLEMENT_OUTCOME_NOT_PAYABLE",
          statusCode: 409,
        });
      }

      this.initializeComponentSettlement({
        occurrence,
        component: normalizedComponent,
      });

      const releaseReadiness = this.applyComponentReleaseReadiness({
        occurrence,
        component: normalizedComponent,
        readyAt: now,
        releaseSource: actor.releaseSource,
        releasedByUserId: actor.releasedBy,
        payoutPolicy,
        challengeContext,
      });

      this.synchronizeOverallSettlementState({
        occurrence,
        currentTime: now,
        challengeContext,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `${normalizedComponent.toUpperCase()} settlement ready for occurrence ` +
          `${occurrence.referenceCode}; scheduled payout: ` +
          `${releaseReadiness.scheduledPayoutAt.toISOString()}`
      );

      return {
        occurrence,
        component: normalizedComponent,
        releaseReadiness,
        idempotent: false,
      };
    });
  }

  static async markOccurrenceReadyForRelease(
    {
      occurrenceId,
      releaseSource = "automatic",
      releasedByUserId = null,
      readyAt = new Date(),
      payoutPolicy = {},
    },
    options = {}
  ) {
    const now = this.normalizeDate(readyAt, "settlement release-readiness time");

    const actor = this.normalizeReleaseActor({
      releaseSource,
      releasedByUserId,
    });

    return this.runWithOptionalTransaction(options, async (session) => {
      const occurrence = await this.getOccurrence(occurrenceId, session);

      this.assertCompleteAssignment(occurrence);

      this.synchronizeExpiredChallengeWindow({
        occurrence,
        currentTime: now,
      });

      const challengeContext = await this.getActiveChallengeContext({
        occurrence,
        session,
      });

      const payableComponents = this.getPayableSettlementComponents(occurrence);

      if (payableComponents.length === 0) {
        throw this.createError({
          message: "The occurrence does not contain a payable settlement component.",
          code: "OCCURRENCE_HAS_NO_PAYABLE_SETTLEMENT_COMPONENT",
          statusCode: 409,
        });
      }

      const componentResults = [];

      for (const component of payableComponents) {
        this.initializeComponentSettlement({
          occurrence,
          component,
        });

        const status = this.getComponentStatus(occurrence, component);

        if (COMPONENT_RELEASE_READY_STATUSES.includes(status)) {
          componentResults.push({
            component,
            ready: true,
            skipped: false,
            reason: null,
            idempotent: true,

            scheduledPayoutAt:
              this.getComponentAudit(occurrence, component).scheduledPayoutAt || null,
          });

          continue;
        }

        if (
          this.isComponentChallenged({
            component,
            challengeContext,
          })
        ) {
          componentResults.push({
            component,
            ready: false,
            skipped: true,
            reason: "active_component_challenge",
            idempotent: false,
          });

          continue;
        }

        if (
          this.isComponentOrdinarilyChallengeable({
            occurrence,
            component,
            currentTime: now,
          })
        ) {
          componentResults.push({
            component,
            ready: false,
            skipped: true,
            reason: "component_still_challengeable",
            idempotent: false,
          });

          continue;
        }

        if (component === "overtime" && !this.isFundedOvertimeHandoffComplete(occurrence)) {
          componentResults.push({
            component,
            ready: false,
            skipped: true,
            reason: "overtime_funding_handoff_incomplete",
            idempotent: false,
          });

          continue;
        }

        const readiness = this.applyComponentReleaseReadiness({
          occurrence,
          component,
          readyAt: now,
          releaseSource: actor.releaseSource,
          releasedByUserId: actor.releasedBy,
          payoutPolicy,
          challengeContext,
        });

        componentResults.push({
          component,
          ready: true,
          skipped: false,
          reason: null,
          idempotent: readiness.idempotent,
          scheduledPayoutAt: readiness.scheduledPayoutAt,
        });
      }

      this.synchronizeOverallSettlementState({
        occurrence,
        currentTime: now,
        challengeContext,
      });

      await occurrence.save({
        session,
      });

      const newlyReady = componentResults.filter((item) => item.ready && !item.idempotent);

      return {
        occurrence,
        componentResults,
        idempotent: newlyReady.length === 0,
      };
    });
  }

  static async approveOccurrenceForRelease(
    {
      occurrenceId,
      approvalSource = "admin",
      approvedByUserId = null,
      approvedAt = new Date(),
      payoutPolicy = {},
    },
    options = {}
  ) {
    return this.markOccurrenceReadyForRelease(
      {
        occurrenceId,
        releaseSource: approvalSource,
        releasedByUserId: approvedByUserId,
        readyAt: approvedAt,
        payoutPolicy,
      },
      options
    );
  }

  /* ─────────────────────────────── NO-SHOW FINALIZATION ─────────────────────────────── */

  static async finalizeConfirmedNoShow({ occurrenceId, currentTime = new Date() }, options = {}) {
    const now = this.normalizeDate(currentTime, "no-show finalization time");

    return this.runWithOptionalTransaction(options, async (session) => {
      const occurrence = await this.getOccurrence(occurrenceId, session);

      this.assertCompleteAssignment(occurrence);

      if (occurrence.status !== "no_show" || occurrence.attendanceStatus !== "no_show") {
        throw this.createError({
          message: "The occurrence has not been confirmed as a no-show.",
          code: "OCCURRENCE_NOT_CONFIRMED_NO_SHOW",
          statusCode: 409,
        });
      }

      this.synchronizeExpiredChallengeWindow({
        occurrence,
        currentTime: now,
      });

      const challengeContext = await this.getActiveChallengeContext({
        occurrence,
        session,
      });

      this.assertComponentChallengeFinal({
        occurrence,
        component: "base",
        challengeContext,
        currentTime: now,
        actionLabel: "be finalized as a no-show",
      });

      for (const component of SETTLEMENT_BATCH_COMPONENTS) {
        const status = this.getComponentStatus(occurrence, component);

        if (COMPONENT_EXECUTION_STARTED_STATUSES.includes(status)) {
          throw this.createError({
            message:
              "A confirmed no-show cannot overwrite professional pay already in payout execution.",
            code: "NO_SHOW_SETTLEMENT_EXECUTION_CONFLICT",
            statusCode: 409,
            details: {
              component,
              status,
            },
          });
        }
      }

      const idempotent =
        Number(occurrence.baseProfessionalPay || 0) === 0 &&
        Number(occurrence.overtimeProfessionalPay || 0) === 0 &&
        this.getComponentStatus(occurrence, "base") === "not_due" &&
        this.getComponentStatus(occurrence, "overtime") === "not_due";

      occurrence.baseBillableHours = 0;
      occurrence.billableHours = 0;
      occurrence.baseProfessionalPay = 0;

      if (
        occurrence.overtime?.requested === true ||
        Number(occurrence.overtimeProfessionalPay || 0) > 0
      ) {
        throw this.createError({
          message:
            "The confirmed no-show contains an overtime record that must be resolved " +
            "by the overtime domain before no-show finalization.",
          code: "NO_SHOW_OVERTIME_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      this.resetComponentSettlement({
        occurrence,
        component: "base",
      });

      this.resetComponentSettlement({
        occurrence,
        component: "overtime",
      });

      this.synchronizeOverallSettlementState({
        occurrence,
        currentTime: now,
        challengeContext,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Confirmed no-show settlement finalized for occurrence ${occurrence.referenceCode}`
      );

      return {
        occurrence,
        idempotent,
        professionalPay: 0,
        settlementStatus: occurrence.settlementStatus,
      };
    });
  }
}

module.exports = ShiftSettlementService;
