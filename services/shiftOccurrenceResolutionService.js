// services/shiftOccurrenceResolutionService.js

const mongoose = require("mongoose");

const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");

const ShiftSettlementService = require("./shiftSettlementService");
const ShiftRefundService = require("./shiftRefundService");
const ShiftOccurrenceReconciliationService = require("./shiftOccurrenceReconciliationService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const {
  ADMIN_FINANCIAL_CLAIM_DECISIONS,
  ADMIN_EMPLOYER_OCCURRENCE_DISPUTE_DECISIONS,
  OCCURRENCE_EVIDENCE_TYPES,
  OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,
} = require("../constants/shiftLifecycle");

const { SETTLEMENT_BATCH_COMPONENTS } = require("../constants/shiftSettlement");

const money = require("../utils/money");
const logger = require("../utils/logger");

const MIN_DECISION_REASON_LENGTH = 10;
const MAX_DECISION_REASON_LENGTH = 1500;

const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_REFERENCE_LENGTH = 1000;
const MAX_EVIDENCE_DESCRIPTION_LENGTH = 500;

const COMPONENT_EXECUTION_STARTED_STATUSES = Object.freeze(["release_pending", "released"]);

/**
 * GENERIC OCCURRENCE FINAL RESOLUTION AUTHORITY
 *
 * This service owns:
 *
 * - final resolution of individual professional-claim issues;
 * - final resolution of individual employer-dispute issues;
 * - conversion of accepted party positions into authoritative occurrence facts;
 * - admin-established evidence-supported final facts/values;
 * - BASE recalculation after authoritative attendance changes;
 * - BASE amount replacement where a final adjudicated amount is explicit;
 * - settlement-component audit reset when authoritative BASE changes;
 * - case-level finality after all individual issues are resolved;
 * - clearing activeClaim only when the professional claim case is final;
 * - clearing activeDispute only when the employer dispute case is final;
 * - handing newly final payout components back to ShiftSettlementService;
 * - delegating BASE refund reevaluation to ShiftRefundService; and
 * - delegating parent aggregation to ShiftOccurrenceReconciliationService.
 *
 * This service does NOT own:
 *
 * - OT request creation;
 * - OT employer approval/rejection;
 * - OT appeal;
 * - OT admin adjudication;
 * - OT pricing;
 * - OT top-up establishment;
 * - OT funding verification;
 * - OT delinquency;
 * - platform-fee earning or collection;
 * - employer refund eligibility or execution;
 * - professional payout execution; or
 * - parent Shift reconciliation logic.
 *
 * It only orchestrates those downstream authorities after final issue
 * resolution so that occurrence, refund and parent summaries remain aligned.
 *
 * CLAIM / DISPUTE COEXISTENCE
 *
 * activeClaim and activeDispute may coexist.
 *
 * Resolving one claim issue never clears activeDispute.
 *
 * Resolving one dispute issue never clears activeClaim.
 *
 * Each pointer is cleared only when its own entire case becomes final.
 *
 * MIXED OUTCOMES
 *
 * Settlement-component authority is issue-level.
 *
 * Professional claim scope is stored only on:
 *
 * issues[].affectedSettlementComponents
 *
 * Live component finality is derived from unresolved issue scopes.
 *
 * Therefore:
 *
 * - one BASE issue may resolve;
 * - another OT-relevant ordinary factual issue may remain active;
 * - BASE may then become independently release-ready if the shared ordinary
 *   challenge window is also final and no other active case affects BASE.
 *
 * SNAPSHOTS
 *
 * lifecycleSnapshot is evidential context only.
 *
 * This service does not restore broad financial snapshots.
 *
 * Final authoritative facts are applied deliberately and narrowly.
 *
 * ATTENDANCE
 *
 * Raw checkedInAt / checkedOutAt timestamps are preserved.
 *
 * Corrected authoritative attendance is stored through attendanceOverride.
 *
 * BASE calculation then consumes the effective attendance through
 * ShiftSettlementService.
 *
 * OVERTIME
 *
 * An attendance correction may establish a final attendance fact that is
 * relevant evidence for the OT domain.
 *
 * This service does not convert that fact into an OT approval/rejection or
 * change an existing OT obligation.
 */
class ShiftOccurrenceResolutionService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftOccurrenceResolutionServiceError";
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

  static normalizeDecision(value, allowedValues, fieldName) {
    const decision = String(value || "")
      .trim()
      .toLowerCase();

    if (!allowedValues.includes(decision)) {
      throw this.createError({
        message: `${fieldName} must be one of: ${allowedValues.join(", ")}.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
      });
    }

    return decision;
  }

  static normalizeDecisionReason(value) {
    const reason = String(value || "").trim();

    if (reason.length < MIN_DECISION_REASON_LENGTH) {
      throw this.createError({
        message:
          `Admin decision reason must contain at least ` +
          `${MIN_DECISION_REASON_LENGTH} characters.`,
        code: "ADMIN_DECISION_REASON_TOO_SHORT",
      });
    }

    if (reason.length > MAX_DECISION_REASON_LENGTH) {
      throw this.createError({
        message:
          `Admin decision reason cannot exceed ` + `${MAX_DECISION_REASON_LENGTH} characters.`,
        code: "ADMIN_DECISION_REASON_TOO_LONG",
      });
    }

    return reason;
  }

  static normalizeOptionalText(value, maxLength, fieldName = "text") {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const text = String(value).trim();

    if (!text) {
      return null;
    }

    if (text.length > maxLength) {
      throw this.createError({
        message: `${fieldName} cannot exceed ${maxLength} characters.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return text;
  }

  static normalizeNonNegativeAmount(value, fieldName, { nullable = false } = {}) {
    if (value === null || value === undefined || value === "") {
      if (nullable) {
        return null;
      }

      throw this.createError({
        message: `${fieldName} is required.`,
        code: `${this.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    try {
      return money.normalizeMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw this.createError({
        message: `${fieldName} must be a non-negative whole minor-unit amount.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
      });
    }
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  /* ─────────────────────────────── EVIDENCE ─────────────────────────────── */

  static normalizeEvidence(evidence = [], { submittedByUser, recordedAt = new Date() } = {}) {
    if (!Array.isArray(evidence)) {
      throw this.createError({
        message: "Admin evidence must be an array.",
        code: "INVALID_ADMIN_RESOLUTION_EVIDENCE",
      });
    }

    if (evidence.length > MAX_EVIDENCE_ITEMS) {
      throw this.createError({
        message: `Admin resolution cannot contain more than ${MAX_EVIDENCE_ITEMS} evidence items.`,
        code: "TOO_MANY_ADMIN_RESOLUTION_EVIDENCE_ITEMS",
      });
    }

    if (evidence.length === 0) {
      return [];
    }

    if (!OCCURRENCE_EVIDENCE_SUBMITTER_ROLES.includes("admin")) {
      throw this.createError({
        message: "Admin is not a valid occurrence evidence role.",
        code: "ADMIN_EVIDENCE_ROLE_NOT_SUPPORTED",
        statusCode: 500,
      });
    }

    const user = this.normalizeObjectId(submittedByUser, "admin evidence user ID");

    const normalizedRecordedAt = this.normalizeCurrentTime(recordedAt);

    return evidence.map((item, index) => {
      const type = String(item?.type || "")
        .trim()
        .toLowerCase();

      if (!OCCURRENCE_EVIDENCE_TYPES.includes(type)) {
        throw this.createError({
          message: `Admin evidence item ${index + 1} has an unsupported evidence type.`,
          code: "INVALID_ADMIN_RESOLUTION_EVIDENCE_TYPE",
          details: {
            evidenceIndex: index,
            evidenceType: type || null,
          },
        });
      }

      const reference = this.normalizeOptionalText(
        item?.reference,
        MAX_EVIDENCE_REFERENCE_LENGTH,
        "admin evidence reference"
      );

      const description = this.normalizeOptionalText(
        item?.description,
        MAX_EVIDENCE_DESCRIPTION_LENGTH,
        "admin evidence description"
      );

      if (!reference) {
        throw this.createError({
          message: `Admin evidence item ${index + 1} requires a reference.`,
          code: "EMPTY_ADMIN_RESOLUTION_EVIDENCE_ITEM",
        });
      }

      return {
        type,
        reference,
        description,

        submittedByRole: "admin",

        submittedByUser: user,

        recordedAt: normalizedRecordedAt,
      };
    });
  }

  /* ─────────────────────────────── COMPONENT SCOPE ─────────────────────────────── */

  static getIssueAffectedSettlementComponents(issue) {
    const source = Array.isArray(issue?.affectedSettlementComponents)
      ? issue.affectedSettlementComponents
      : [];

    const normalized = source.map((value) =>
      String(value || "")
        .trim()
        .toLowerCase()
    );

    const unique = [...new Set(normalized)];

    if (
      unique.length === 0 ||
      unique.length !== normalized.length ||
      unique.some((component) => !SETTLEMENT_BATCH_COMPONENTS.includes(component))
    ) {
      throw this.createError({
        message: "The issue contains an invalid settlement-component scope.",
        code: "INVALID_ISSUE_SETTLEMENT_COMPONENT_SCOPE",
        statusCode: 500,
        details: {
          affectedSettlementComponents: normalized,
        },
      });
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => unique.includes(component));
  }

  static assertIssueComponentsMutable({ issue, occurrence }) {
    const components = this.getIssueAffectedSettlementComponents(issue);

    for (const component of components) {
      const status = ShiftSettlementService.getComponentStatus(occurrence, component);

      if (COMPONENT_EXECUTION_STARTED_STATUSES.includes(status)) {
        throw this.createError({
          message:
            component === "base"
              ? "Regular Shift pay has already entered payout execution and cannot be changed by issue resolution."
              : "Overtime pay has already entered payout execution and cannot be changed by ordinary issue resolution.",
          code:
            component === "base"
              ? "BASE_SETTLEMENT_ALREADY_IN_EXECUTION"
              : "OVERTIME_SETTLEMENT_ALREADY_IN_EXECUTION",
          statusCode: 409,
        });
      }
    }

    /**
     * Generic claim/dispute resolution may establish attendance facts relevant
     * to overtime evidence, but it must not reopen already-final OT.
     */
    if (components.includes("overtime") && occurrence.overtime?.status === "approved") {
      throw this.createError({
        message:
          "Approved overtime is final and cannot be reopened through ordinary claim/dispute resolution.",
        code: "FINAL_OVERTIME_ALREADY_ESTABLISHED",
        statusCode: 409,
      });
    }

    return components;
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getClaim(claimId, session = null) {
    const id = this.normalizeObjectId(claimId, "claim ID");

    const query = ShiftOccurrenceClaim.findById(id);

    if (session) {
      query.session(session);
    }

    const claim = await query;

    if (!claim) {
      throw this.createError({
        message: "Shift occurrence claim was not found.",
        code: "SHIFT_OCCURRENCE_CLAIM_NOT_FOUND",
        statusCode: 404,
      });
    }

    return claim;
  }

  static async getDispute(disputeId, session = null) {
    const id = this.normalizeObjectId(disputeId, "dispute ID");

    const query = ShiftOccurrenceDispute.findById(id);

    if (session) {
      query.session(session);
    }

    const dispute = await query;

    if (!dispute) {
      throw this.createError({
        message: "Shift occurrence dispute was not found.",
        code: "SHIFT_OCCURRENCE_DISPUTE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return dispute;
  }

  static async getOccurrenceForCase({ caseDocument, session = null }) {
    const query = ShiftOccurrence.findOne({
      _id: caseDocument.occurrence,

      shift: caseDocument.shift,
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

    if (
      !this.sameId(occurrence.business, caseDocument.business) ||
      !this.sameId(occurrence.assignment, caseDocument.assignment) ||
      !this.sameId(occurrence.assignedProfessional, caseDocument.professional)
    ) {
      throw this.createError({
        message: "The occurrence no longer matches the challenge case identity.",
        code: "OCCURRENCE_CHALLENGE_CASE_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }

    return occurrence;
  }

  static getClaimIssue(claim, issueId) {
    const id = this.normalizeObjectId(issueId, "claim issue ID");

    const issue = claim.issues?.id(id);

    if (!issue) {
      throw this.createError({
        message: "Professional claim issue was not found.",
        code: "PROFESSIONAL_CLAIM_ISSUE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return issue;
  }

  static getDisputeIssue(dispute, issueId) {
    const id = this.normalizeObjectId(issueId, "dispute issue ID");

    const issue = dispute.issues?.id(id);

    if (!issue) {
      throw this.createError({
        message: "Employer dispute issue was not found.",
        code: "EMPLOYER_DISPUTE_ISSUE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return issue;
  }

  /* ─────────────────────────────── ACTIVE CASE POINTERS ─────────────────────────────── */

  static assertClaimIsActiveOnOccurrence({ claim, occurrence }) {
    if (!occurrence.activeClaim || !this.sameId(occurrence.activeClaim, claim._id)) {
      throw this.createError({
        message: "This professional claim is no longer the occurrence's active professional claim.",
        code: "CLAIM_NOT_ACTIVE_ON_OCCURRENCE",
        statusCode: 409,
      });
    }

    /**
     * activeDispute may legitimately coexist.
     */
    return true;
  }

  static assertDisputeIsActiveOnOccurrence({ dispute, occurrence }) {
    if (!occurrence.activeDispute || !this.sameId(occurrence.activeDispute, dispute._id)) {
      throw this.createError({
        message: "This employer dispute is no longer the occurrence's active employer dispute.",
        code: "DISPUTE_NOT_ACTIVE_ON_OCCURRENCE",
        statusCode: 409,
      });
    }

    /**
     * activeClaim may legitimately coexist.
     */
    return true;
  }

  /* ─────────────────────────────── ADMIN OUTCOME NORMALIZATION ─────────────────────────────── */

  static normalizeClaimAdminOutcome({ issue, decision, adminOutcome }) {
    /**
     * approve_employer selects the employer's already-recorded counter-position.
     *
     * It is invalid where no such position exists, regardless of whether the
     * caller supplied an adminOutcome object.
     */
    if (decision === "approve_employer" && !this.getEmployerCounterPosition(issue)) {
      throw this.createError({
        message: "approve_employer requires an employer counter-position on the claim issue.",
        code: "CLAIM_EMPLOYER_POSITION_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    /**
     * The three selection decisions choose an existing position:
     *
     * - approve_professional -> professional position
     * - approve_employer     -> employer counter-position
     * - maintain_current     -> current Loqum authority
     *
     * Only adjusted may introduce replacement authoritative facts or values.
     */
    if (decision !== "adjusted") {
      if (adminOutcome !== null && adminOutcome !== undefined) {
        throw this.createError({
          message:
            "Only an adjusted professional-claim decision may contain a final admin outcome.",
          code: "CLAIM_ADMIN_OUTCOME_NOT_ALLOWED",
        });
      }

      return null;
    }

    if (!adminOutcome || typeof adminOutcome !== "object" || Array.isArray(adminOutcome)) {
      throw this.createError({
        message: "An adjusted professional-claim decision requires a final admin outcome.",
        code: "ADJUSTED_CLAIM_ADMIN_OUTCOME_REQUIRED",
      });
    }

    const finalCheckInAt = this.normalizeDate(adminOutcome.finalCheckInAt, "final check-in time", {
      nullable: true,
    });

    const finalCheckOutAt = this.normalizeDate(
      adminOutcome.finalCheckOutAt,
      "final checkout time",
      {
        nullable: true,
      }
    );

    const finalBaseProfessionalPay = this.normalizeNonNegativeAmount(
      adminOutcome.finalBaseProfessionalPay,
      "final BASE professional pay",
      {
        nullable: true,
      }
    );

    const adjustedOutcome = this.normalizeOptionalText(
      adminOutcome.adjustedOutcome,
      1500,
      "adjusted outcome"
    );

    if (finalCheckInAt && finalCheckOutAt && finalCheckOutAt <= finalCheckInAt) {
      throw this.createError({
        message: "Final checkout must be later than final check-in.",
        code: "INVALID_CLAIM_ADMIN_ATTENDANCE_OUTCOME",
      });
    }

    if (issue.type !== "attendance_correction" && (finalCheckInAt || finalCheckOutAt)) {
      throw this.createError({
        message: "Admin attendance outcome fields are only valid for attendance_correction.",
        code: "CLAIM_ADMIN_ATTENDANCE_OUTCOME_NOT_ALLOWED",
      });
    }

    if (issue.type === "attendance_correction") {
      if (finalBaseProfessionalPay !== null) {
        throw this.createError({
          message:
            "attendance_correction must establish attendance facts; BASE pay is recalculated from those facts.",
          code: "CLAIM_ATTENDANCE_ADMIN_PAY_NOT_ALLOWED",
        });
      }

      if (!finalCheckInAt && !finalCheckOutAt) {
        throw this.createError({
          message:
            "An adjusted attendance_correction requires final authoritative check-in, checkout, or both.",
          code: "ADJUSTED_CLAIM_ATTENDANCE_OUTCOME_REQUIRED",
        });
      }
    }

    if (issue.type === "payment_calculation" && finalBaseProfessionalPay === null) {
      throw this.createError({
        message:
          "An adjusted payment_calculation requires the final authoritative BASE professional-pay amount.",
        code: "ADJUSTED_CLAIM_FINAL_BASE_PAY_REQUIRED",
      });
    }

    const hasOutcome = Boolean(
      finalCheckInAt || finalCheckOutAt || finalBaseProfessionalPay !== null || adjustedOutcome
    );

    if (!hasOutcome) {
      throw this.createError({
        message: "An adjusted professional-claim decision requires a recorded final outcome.",
        code: "EMPTY_ADJUSTED_CLAIM_ADMIN_OUTCOME",
      });
    }

    return {
      finalCheckInAt,
      finalCheckOutAt,
      finalBaseProfessionalPay,
      adjustedOutcome,
    };
  }

  static normalizeDisputeAdminOutcome({ issue, decision, adminOutcome }) {
    /**
     * approved accepts the employer's submitted position.
     *
     * rejected leaves current Loqum authority unchanged.
     *
     * Only adjusted may introduce a different admin-established position.
     */
    if (decision !== "adjusted") {
      if (adminOutcome !== null && adminOutcome !== undefined) {
        throw this.createError({
          message: "Only an adjusted employer-dispute decision may contain a final admin outcome.",
          code: "DISPUTE_ADMIN_OUTCOME_NOT_ALLOWED",
        });
      }

      return null;
    }

    if (!adminOutcome || typeof adminOutcome !== "object" || Array.isArray(adminOutcome)) {
      throw this.createError({
        message: "An adjusted employer-dispute decision requires a final admin outcome.",
        code: "ADJUSTED_DISPUTE_ADMIN_OUTCOME_REQUIRED",
      });
    }

    const finalCheckInAt = this.normalizeDate(adminOutcome.finalCheckInAt, "final check-in time", {
      nullable: true,
    });

    const finalCheckOutAt = this.normalizeDate(
      adminOutcome.finalCheckOutAt,
      "final checkout time",
      {
        nullable: true,
      }
    );

    const finalBaseProfessionalPay = this.normalizeNonNegativeAmount(
      adminOutcome.finalBaseProfessionalPay,
      "final BASE professional pay",
      {
        nullable: true,
      }
    );

    const finalOutcome = this.normalizeOptionalText(
      adminOutcome.finalOutcome,
      1500,
      "final outcome"
    );

    if (finalCheckInAt && finalCheckOutAt && finalCheckOutAt <= finalCheckInAt) {
      throw this.createError({
        message: "Final checkout must be later than final check-in.",
        code: "INVALID_DISPUTE_ADMIN_ATTENDANCE_OUTCOME",
      });
    }

    if (issue.type !== "attendance_correction" && (finalCheckInAt || finalCheckOutAt)) {
      throw this.createError({
        message: "Admin attendance outcome fields are only valid for attendance_correction.",
        code: "DISPUTE_ADMIN_ATTENDANCE_OUTCOME_NOT_ALLOWED",
      });
    }

    if (issue.type === "attendance_correction") {
      if (finalBaseProfessionalPay !== null) {
        throw this.createError({
          message:
            "attendance_correction must establish attendance facts; BASE pay is recalculated from those facts.",
          code: "DISPUTE_ATTENDANCE_ADMIN_PAY_NOT_ALLOWED",
        });
      }

      if (!finalCheckInAt && !finalCheckOutAt) {
        throw this.createError({
          message:
            "An adjusted attendance_correction dispute requires final authoritative check-in, checkout, or both.",
          code: "ADJUSTED_DISPUTE_ATTENDANCE_OUTCOME_REQUIRED",
        });
      }
    }

    if (issue.type === "payment_calculation" && finalBaseProfessionalPay === null) {
      throw this.createError({
        message:
          "An adjusted payment_calculation dispute requires the final authoritative BASE professional-pay amount.",
        code: "ADJUSTED_DISPUTE_FINAL_BASE_PAY_REQUIRED",
      });
    }

    if (
      issue.type === "other_financial_fact" &&
      finalBaseProfessionalPay === null &&
      !finalOutcome
    ) {
      throw this.createError({
        message:
          "An adjusted other_financial_fact dispute requires a final BASE amount or recorded final outcome.",
        code: "ADJUSTED_DISPUTE_FINAL_FINANCIAL_FACT_REQUIRED",
      });
    }

    const hasOutcome = Boolean(
      finalCheckInAt || finalCheckOutAt || finalBaseProfessionalPay !== null || finalOutcome
    );

    if (!hasOutcome) {
      throw this.createError({
        message: "An adjusted employer-dispute decision requires a recorded final outcome.",
        code: "EMPTY_ADJUSTED_DISPUTE_ADMIN_OUTCOME",
      });
    }

    return {
      finalCheckInAt,
      finalCheckOutAt,
      finalBaseProfessionalPay,
      finalOutcome,
    };
  }

  /* ─────────────────────────────── AUTHORITATIVE ATTENDANCE ─────────────────────────────── */

  static getEffectiveAttendanceStart(occurrence) {
    return occurrence.attendanceOverride?.approvedStartTime || occurrence.checkedInAt || null;
  }

  static getEffectiveAttendanceEnd(occurrence) {
    return (
      occurrence.attendanceOverride?.approvedEndTime ||
      occurrence.checkoutFallback?.approvedEndTime ||
      occurrence.checkedOutAt ||
      null
    );
  }

  static getPlainSubdocument(value) {
    if (!value) {
      return {};
    }

    if (typeof value.toObject === "function") {
      return value.toObject({
        depopulate: true,
      });
    }

    return {
      ...value,
    };
  }

  static applyAttendancePosition({
    occurrence,
    position,
    reviewedByUser,
    currentTime,
    authorityRole,
  }) {
    if (!position) {
      return {
        changed: false,
        baseAffected: false,
      };
    }

    const proposedStart = this.normalizeDate(
      position.correctedCheckInAt ?? position.finalCheckInAt,
      "resolved check-in time",
      {
        nullable: true,
      }
    );

    const proposedEnd = this.normalizeDate(
      position.correctedCheckOutAt ?? position.finalCheckOutAt,
      "resolved checkout time",
      {
        nullable: true,
      }
    );

    if (!proposedStart && !proposedEnd) {
      return {
        changed: false,
        baseAffected: false,
      };
    }

    const currentStartValue = this.getEffectiveAttendanceStart(occurrence);

    const currentEndValue = this.getEffectiveAttendanceEnd(occurrence);

    const currentStart = currentStartValue
      ? this.normalizeDate(currentStartValue, "current authoritative check-in", {
          statusCode: 500,
        })
      : null;

    const currentEnd = currentEndValue
      ? this.normalizeDate(currentEndValue, "current authoritative checkout", {
          statusCode: 500,
        })
      : null;

    const finalStart = proposedStart || currentStart;

    const finalEnd = proposedEnd || currentEnd;

    if (!finalStart || !finalEnd) {
      throw this.createError({
        message: "Final attendance requires both an authoritative start and end time.",
        code: "FINAL_ATTENDANCE_RANGE_INCOMPLETE",
        statusCode: 409,
      });
    }

    if (finalEnd <= finalStart) {
      throw this.createError({
        message: "Final checkout must be later than final check-in.",
        code: "INVALID_FINAL_ATTENDANCE_RANGE",
        statusCode: 409,
      });
    }

    const scheduledEnd = this.normalizeDate(occurrence.endTime, "occurrence end time", {
      statusCode: 500,
    });

    if (finalStart >= scheduledEnd) {
      throw this.createError({
        message: "Final check-in must be before the scheduled end of the occurrence.",
        code: "FINAL_CHECKIN_AFTER_OCCURRENCE_END",
        statusCode: 409,
      });
    }

    const startChanged = Boolean(!currentStart || finalStart.getTime() !== currentStart.getTime());

    const endChanged = Boolean(!currentEnd || finalEnd.getTime() !== currentEnd.getTime());

    if (!startChanged && !endChanged) {
      return {
        changed: false,
        baseAffected: false,
      };
    }

    const baseAffected = Boolean(
      startChanged ||
      (endChanged && (!currentEnd || currentEnd < scheduledEnd || finalEnd < scheduledEnd))
    );

    const override = this.getPlainSubdocument(occurrence.attendanceOverride);

    occurrence.set("attendanceOverride", {
      ...override,

      used: true,

      type: startChanged && endChanged ? "both" : startChanged ? "checkin" : "checkout",

      reason:
        authorityRole === "admin" ? "admin_confirmed_presence" : "employer_confirmed_presence",

      approvedStartTime: finalStart,

      approvedEndTime: finalEnd,

      reviewedAt: currentTime,

      reviewedBy: reviewedByUser,

      notes:
        authorityRole === "admin"
          ? "Attendance finalized through occurrence adjudication."
          : "Attendance finalized through employer claim review.",
    });

    /**
     * Raw checkedInAt / checkedOutAt are deliberately preserved.
     */
    occurrence.status = "pending_settlement";

    occurrence.attendanceStatus = "checked_out";

    return {
      changed: true,
      baseAffected,
      finalStart,
      finalEnd,
    };
  }

  /* ─────────────────────────────── BASE AUTHORITY ─────────────────────────────── */

  static resetBaseSettlementForResolution(occurrence) {
    ShiftSettlementService.resetComponentSettlement({
      occurrence,
      component: "base",
    });

    return occurrence;
  }

  static recalculateBaseFromAttendance(occurrence) {
    /**
     * Specialized cancellation outcomes already own their BASE amount.
     *
     * Attendance recalculation is for worked BASE time.
     */
    if (
      occurrence.activeWorkCancellation?.occurred === true ||
      occurrence.cancellationCompensation?.applicable === true
    ) {
      return occurrence;
    }

    const billableTime = ShiftSettlementService.calculateBaseBillableTime(occurrence);

    ShiftSettlementService.applyBasePricing({
      occurrence,

      baseBillableMinutes: billableTime.baseBillableMinutes,
    });

    ShiftSettlementService.synchronizeBillableHours(occurrence);

    return occurrence;
  }

  static applyFinalBaseProfessionalPay({ occurrence, amount }) {
    const finalAmount = this.normalizeNonNegativeAmount(amount, "final BASE professional pay");

    /**
     * baseProfessionalPay is always the authoritative BASE entitlement used by
     * settlement and refund logic.
     *
     * Specialized cancellation structures retain their matching audit copy,
     * but they never replace baseProfessionalPay as the occurrence authority.
     */
    if (occurrence.activeWorkCancellation?.occurred === true) {
      occurrence.activeWorkCancellation.professionalPay = finalAmount;
    } else if (occurrence.cancellationCompensation?.applicable === true) {
      occurrence.cancellationCompensation.professionalPay = finalAmount;
    }

    occurrence.baseProfessionalPay = finalAmount;

    ShiftSettlementService.synchronizeBillableHours(occurrence);

    return occurrence;
  }

  static applyBaseRecalculation({ occurrence }) {
    this.resetBaseSettlementForResolution(occurrence);

    this.recalculateBaseFromAttendance(occurrence);

    return occurrence;
  }

  static applyBaseAmountResolution({ occurrence, amount }) {
    this.resetBaseSettlementForResolution(occurrence);

    this.applyFinalBaseProfessionalPay({
      occurrence,
      amount,
    });

    return occurrence;
  }

  /* ─────────────────────────────── PROFESSIONAL CLAIM OUTCOME APPLICATION ─────────────────────────────── */

  static getEmployerCounterPosition(issue) {
    const position = issue?.employerCounterPosition;

    if (!position) {
      return null;
    }

    const hasPosition = Boolean(
      position.correctedCheckInAt ||
      position.correctedCheckOutAt ||
      (position.proposedBaseProfessionalPay !== null &&
        position.proposedBaseProfessionalPay !== undefined)
    );

    return hasPosition ? position : null;
  }

  static async applyClaimIssueFinalPosition({
    issue,
    occurrence,
    decision,
    adminOutcome = null,
    resolvedByUser,
    currentTime,
    authorityRole,
  }) {
    const affectedComponents = this.assertIssueComponentsMutable({
      issue,
      occurrence,
    });

    const affectsBase = affectedComponents.includes("base");

    /**
     * ATTENDANCE
     *
     * Employer-level:
     *
     * approved
     * -> accept the professional attendance position.
     *
     * rejected
     * -> simple rejection finalization leaves current authority unchanged.
     *
     * Admin-level:
     *
     * approve_professional
     * -> professional position.
     *
     * approve_employer
     * -> employer counter-position.
     *
     * maintain_current
     * -> current Loqum authority.
     *
     * adjusted
     * -> admin-established attendance facts.
     */
    if (issue.type === "attendance_correction") {
      let position = null;

      if (decision === "approved" || decision === "approve_professional") {
        position = issue.details?.attendanceCorrection || null;
      } else if (decision === "approve_employer") {
        position = this.getEmployerCounterPosition(issue);
      } else if (decision === "adjusted") {
        position = adminOutcome;
      } else if (decision === "rejected" || decision === "maintain_current") {
        position = null;
      }

      const attendanceResult = this.applyAttendancePosition({
        occurrence,

        position,

        reviewedByUser: resolvedByUser,

        currentTime,

        authorityRole,
      });

      if (affectsBase && attendanceResult.baseAffected) {
        this.applyBaseRecalculation({
          occurrence,
        });
      }

      return {
        occurrence,

        attendanceChanged: attendanceResult.changed,

        baseChanged: affectsBase && attendanceResult.baseAffected,
      };
    }

    /**
     * SIMPLE EMPLOYER REJECTION / MAINTAIN CURRENT
     *
     * A simple employer rejection that reaches finality because the
     * professional did not appeal has no employer counter-position.
     *
     * No occurrence authority changes.
     *
     * maintain_current has the same occurrence consequence at admin level.
     */
    if (decision === "rejected" || decision === "maintain_current") {
      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: false,
      };
    }

    /**
     * PROFESSIONAL POSITION ACCEPTED
     *
     * The professional's expectedBaseProfessionalPay is an estimate/evidence,
     * not direct financial authority.
     *
     * For non-attendance BASE issues, accepting the professional position
     * therefore causes BASE to be recalculated from the authoritative
     * occurrence facts rather than blindly assigning the submitted estimate.
     */
    if ((decision === "approved" || decision === "approve_professional") && affectsBase) {
      this.applyBaseRecalculation({
        occurrence,
      });

      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: true,
      };
    }

    /**
     * EMPLOYER COUNTER-POSITION ACCEPTED
     *
     * approve_employer is only reachable after normalization has established
     * that a real employer counter-position exists.
     *
     * Where the counter-position contains an explicit BASE amount, that amount
     * becomes authoritative.
     *
     * A non-monetary factual counter-position may be recorded as the accepted
     * conclusion without requiring a separate occurrence amount mutation.
     */
    if (decision === "approve_employer") {
      const counterPosition = this.getEmployerCounterPosition(issue);

      if (
        affectsBase &&
        counterPosition?.proposedBaseProfessionalPay !== null &&
        counterPosition?.proposedBaseProfessionalPay !== undefined
      ) {
        this.applyBaseAmountResolution({
          occurrence,

          amount: counterPosition.proposedBaseProfessionalPay,
        });

        return {
          occurrence,

          attendanceChanged: false,

          baseChanged: true,
        };
      }

      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: false,
      };
    }

    /**
     * ADMIN-ADJUSTED POSITION
     *
     * Structured replacement authority belongs only to adjusted.
     */
    if (decision === "adjusted") {
      if (
        affectsBase &&
        adminOutcome?.finalBaseProfessionalPay !== null &&
        adminOutcome?.finalBaseProfessionalPay !== undefined
      ) {
        this.applyBaseAmountResolution({
          occurrence,

          amount: adminOutcome.finalBaseProfessionalPay,
        });

        return {
          occurrence,

          attendanceChanged: false,

          baseChanged: true,
        };
      }

      /**
       * adjustedOutcome may document an evidence-supported factual conclusion
       * that has no separate structured occurrence field.
       */
      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: false,
      };
    }

    throw this.createError({
      message: "Unsupported professional claim issue resolution decision.",
      code: "UNSUPPORTED_CLAIM_ISSUE_RESOLUTION_DECISION",
      statusCode: 500,
      details: {
        decision,
        issueType: issue.type,
      },
    });
  }

  /**
   * CONTRACT USED BY shiftOccurrenceClaimService.js
   *
   * This method applies the financial/factual consequence only.
   *
   * The claim service owns:
   *
   * - issue.status;
   * - appeal status;
   * - case status;
   * - activeClaim clearing; and
   * - case persistence.
   */
  static async applyProfessionalClaimIssueOutcome(
    {
      claim,
      issue,
      occurrence,

      decision,
      finalizationReason,

      resolvedByUser,

      currentTime,
    },
    options = {}
  ) {
    void claim;
    void finalizationReason;
    void options;

    const now = this.normalizeCurrentTime(currentTime);

    const normalizedDecision = this.normalizeDecision(
      decision,
      ["approved", "rejected"],
      "professional claim issue outcome"
    );

    const resolvingUser = this.normalizeObjectId(resolvedByUser, "resolving user ID");

    return this.applyClaimIssueFinalPosition({
      issue,
      occurrence,

      decision: normalizedDecision,

      adminOutcome: null,

      resolvedByUser: resolvingUser,

      currentTime: now,

      authorityRole: "employer",
    });
  }

  /* ─────────────────────────────── EMPLOYER DISPUTE OUTCOME APPLICATION ─────────────────────────────── */

  static async applyDisputeIssueFinalPosition({
    issue,
    occurrence,
    decision,
    adminOutcome,
    adminUser,
    currentTime,
  }) {
    const affectedComponents = this.assertIssueComponentsMutable({
      issue,
      occurrence,
    });

    const affectsBase = affectedComponents.includes("base");

    /**
     * REJECTED
     *
     * Current authoritative Loqum occurrence facts remain unchanged.
     */
    if (decision === "rejected") {
      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: false,
      };
    }

    /**
     * ATTENDANCE
     *
     * approved -> accept employer's submitted attendance correction.
     *
     * adjusted -> apply admin-established attendance facts.
     */
    if (issue.type === "attendance_correction") {
      const position =
        decision === "approved" ? issue.details?.attendanceCorrection || null : adminOutcome;

      const attendanceResult = this.applyAttendancePosition({
        occurrence,

        position,

        reviewedByUser: adminUser,

        currentTime,

        authorityRole: "admin",
      });

      if (affectsBase && attendanceResult.baseAffected) {
        this.applyBaseRecalculation({
          occurrence,
        });
      }

      return {
        occurrence,

        attendanceChanged: attendanceResult.changed,

        baseChanged: affectsBase && attendanceResult.baseAffected,
      };
    }

    /**
     * PAYMENT CALCULATION
     *
     * approved -> employer's submitted amount becomes authoritative.
     *
     * adjusted -> admin's different final amount becomes authoritative.
     */
    if (issue.type === "payment_calculation") {
      const amount =
        decision === "approved"
          ? issue.details?.proposedBaseProfessionalPay
          : adminOutcome?.finalBaseProfessionalPay;

      if (amount === null || amount === undefined) {
        throw this.createError({
          message:
            decision === "approved"
              ? "An approved payment_calculation dispute requires the employer's submitted BASE professional-pay amount."
              : "An adjusted payment_calculation dispute requires the admin-established final BASE professional-pay amount.",
          code:
            decision === "approved"
              ? "DISPUTE_EMPLOYER_BASE_PAY_REQUIRED"
              : "DISPUTE_FINAL_BASE_PAY_REQUIRED",
          statusCode: 409,
        });
      }

      this.applyBaseAmountResolution({
        occurrence,

        amount,
      });

      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: true,
      };
    }

    /**
     * OTHER FINANCIAL FACT
     *
     * approved accepts the employer's submitted position.
     *
     * adjusted accepts the admin-established different position.
     *
     * Either position may include an explicit BASE amount. If it does not,
     * the factual conclusion remains in the case audit without inventing a
     * separate occurrence monetary mutation.
     */
    if (issue.type === "other_financial_fact") {
      const amount =
        decision === "approved"
          ? issue.details?.proposedBaseProfessionalPay
          : adminOutcome?.finalBaseProfessionalPay;

      if (amount !== null && amount !== undefined) {
        this.applyBaseAmountResolution({
          occurrence,

          amount,
        });

        return {
          occurrence,

          attendanceChanged: false,

          baseChanged: true,
        };
      }

      return {
        occurrence,

        attendanceChanged: false,

        baseChanged: false,
      };
    }

    throw this.createError({
      message: "Unsupported employer dispute issue type.",
      code: "UNSUPPORTED_EMPLOYER_DISPUTE_ISSUE_TYPE",
      statusCode: 409,
    });
  }

  /* ─────────────────────────────── CASE STATUS ─────────────────────────────── */

  static synchronizeClaimCaseStatus(claim) {
    if (claim.status === "withdrawn") {
      return claim;
    }

    const issues = Array.isArray(claim.issues) ? claim.issues : [];

    const unresolvedIssues = issues.filter((issue) => issue.status !== "resolved");

    if (unresolvedIssues.length > 0) {
      claim.status = "active";

      claim.resolvedAt = null;

      return claim;
    }

    claim.status = "resolved";

    claim.resolvedAt =
      issues
        .map((issue) => issue.resolvedAt)
        .filter(Boolean)
        .sort((left, right) => new Date(right) - new Date(left))[0] || new Date();

    return claim;
  }

  static synchronizeDisputeCaseStatus(dispute) {
    if (dispute.status === "withdrawn") {
      return dispute;
    }

    const issues = Array.isArray(dispute.issues) ? dispute.issues : [];

    if (issues.length === 0) {
      throw this.createError({
        message: "An employer dispute must contain at least one issue.",
        code: "EMPLOYER_DISPUTE_ISSUES_REQUIRED",
        statusCode: 500,
      });
    }

    const unresolvedIssues = issues.filter((issue) => issue.status !== "resolved");

    if (unresolvedIssues.length > 0) {
      const hasUnsupportedIssueStatus = unresolvedIssues.some(
        (issue) =>
          !["awaiting_professional_response", "awaiting_admin_review"].includes(issue.status)
      );

      if (hasUnsupportedIssueStatus) {
        throw this.createError({
          message: "Employer dispute issue statuses cannot be reconciled into a valid case status.",
          code: "INVALID_EMPLOYER_DISPUTE_CASE_STATE",
          statusCode: 500,
        });
      }

      dispute.status = "active";

      dispute.resolvedAt = null;

      return dispute;
    }

    dispute.status = "resolved";

    dispute.resolvedAt =
      issues
        .map((issue) => issue.resolvedAt)
        .filter(Boolean)
        .sort((left, right) => new Date(right) - new Date(left))[0] || new Date();

    return dispute;
  }

  /* ─────────────────────────────── CASE POINTER FINALITY ─────────────────────────────── */

  static clearClaimPointerIfFinal({ claim, occurrence }) {
    if (claim.status !== "resolved") {
      return false;
    }

    if (!occurrence.activeClaim || !this.sameId(occurrence.activeClaim, claim._id)) {
      throw this.createError({
        message: "The resolved professional claim does not match occurrence.activeClaim.",
        code: "RESOLVED_CLAIM_ACTIVE_POINTER_MISMATCH",
        statusCode: 500,
      });
    }

    occurrence.activeClaim = null;

    return true;
  }

  static clearDisputePointerIfFinal({ dispute, occurrence }) {
    if (dispute.status !== "resolved") {
      return false;
    }

    if (!occurrence.activeDispute || !this.sameId(occurrence.activeDispute, dispute._id)) {
      throw this.createError({
        message: "The resolved employer dispute does not match occurrence.activeDispute.",
        code: "RESOLVED_DISPUTE_ACTIVE_POINTER_MISMATCH",
        statusCode: 500,
      });
    }

    occurrence.activeDispute = null;

    return true;
  }

  /* ─────────────────────────────── SETTLEMENT CONTINUATION ─────────────────────────────── */

  static async continueSettlementAfterIssueResolution({
    occurrence,
    currentTime,
    resolvedByUser,
    payoutPolicy = {},
    session,
  }) {
    const now = this.normalizeCurrentTime(currentTime);

    ShiftSettlementService.synchronizeExpiredChallengeWindow({
      occurrence,
      currentTime: now,
    });

    const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
      occurrence,
      session,
    });

    const componentResults = [];

    const payableComponents = ShiftSettlementService.getPayableSettlementComponents(occurrence);

    for (const component of payableComponents) {
      const status = ShiftSettlementService.getComponentStatus(occurrence, component);

      if (["approved_for_release", "release_pending", "released"].includes(status)) {
        componentResults.push({
          component,

          ready: true,

          skipped: true,

          reason: "already_release_ready",
        });

        continue;
      }

      if (
        !ShiftSettlementService.isComponentFinal({
          occurrence,
          component,
          challengeContext,
          currentTime: now,
        })
      ) {
        componentResults.push({
          component,

          ready: false,

          skipped: true,

          reason: "component_not_final",
        });

        continue;
      }

      if (
        component === "overtime" &&
        !ShiftSettlementService.isFundedOvertimeHandoffComplete(occurrence)
      ) {
        componentResults.push({
          component,

          ready: false,

          skipped: true,

          reason: "overtime_funding_handoff_incomplete",
        });

        continue;
      }

      const readiness = ShiftSettlementService.applyComponentReleaseReadiness({
        occurrence,

        component,

        readyAt: now,

        releaseSource: "dispute_resolution",

        releasedByUserId: resolvedByUser,

        payoutPolicy,

        challengeContext,
      });

      componentResults.push({
        component,

        ready: true,

        skipped: false,

        reason: null,

        scheduledPayoutAt: readiness.scheduledPayoutAt,
      });
    }

    ShiftSettlementService.synchronizeOverallSettlementState({
      occurrence,
      currentTime: now,
      challengeContext,
    });

    await occurrence.save({
      session,
    });

    return {
      occurrence,
      challengeContext,
      componentResults,
    };
  }

  /* ─────────────────────────────── POST-RESOLUTION DOWNSTREAM HANDOFF ─────────────────────────────── */

  static async reevaluateRefundAfterIssueResolution({
    occurrence,
    currentTime,
    adminUser,
    session,
  }) {
    return ShiftRefundService.reevaluateOccurrenceRefund(
      {
        shiftId: occurrence.shift,

        occurrence,

        reason: occurrence.refundReason || null,

        zeroAmountVoidReason:
          "The authoritative scheduled/base occurrence outcome leaves no employer refund balance.",

        currentTime,

        initiatedBy: {
          role: "admin",
          userId: adminUser,
        },
      },
      {
        session,
      }
    );
  }

  static async reconcileParentAfterIssueResolution({ occurrence, currentTime, session }) {
    return ShiftOccurrenceReconciliationService.reconcileShift(
      {
        shiftId: occurrence.shift,
        currentTime,
      },
      {
        session,
      }
    );
  }

  /* ─────────────────────────────── CLAIM ADMIN RESOLUTION ─────────────────────────────── */

  static async resolveClaimIssueByAdmin(
    {
      claimId,
      issueId,

      adminUserId,

      decision,
      reason,

      adminOutcome = null,
      evidence = [],

      payoutPolicy = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    const adminUser = this.normalizeObjectId(adminUserId, "admin user ID");

    const normalizedDecision = this.normalizeDecision(
      decision,
      ADMIN_FINANCIAL_CLAIM_DECISIONS,
      "admin claim decision"
    );

    const cleanReason = this.normalizeDecisionReason(reason);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      const issue = this.getClaimIssue(claim, issueId);

      /**
       * Idempotent replay of the same completed admin decision.
       */
      if (
        issue.status === "resolved" &&
        issue.adminDecision === normalizedDecision &&
        this.sameId(issue.adminDecidedBy, adminUser)
      ) {
        const occurrence = await this.getOccurrenceForCase({
          caseDocument: claim,
          session,
        });

        return {
          claim,
          issue,
          occurrence,

          resolved: true,
          final: true,
          idempotent: true,
        };
      }

      if (claim.status === "withdrawn") {
        throw this.createError({
          message: "A withdrawn professional claim cannot receive an admin decision.",
          code: "WITHDRAWN_CLAIM_NOT_RESOLVABLE",
          statusCode: 409,
        });
      }

      if (issue.status !== "awaiting_admin_review") {
        throw this.createError({
          message: "This professional claim issue is not awaiting admin review.",
          code: "CLAIM_ISSUE_NOT_AWAITING_ADMIN_REVIEW",
          statusCode: 409,
          details: {
            issueStatus: issue.status,
          },
        });
      }

      const occurrence = await this.getOccurrenceForCase({
        caseDocument: claim,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      const normalizedAdminOutcome = this.normalizeClaimAdminOutcome({
        issue,
        decision: normalizedDecision,
        adminOutcome,
      });

      const normalizedEvidence = this.normalizeEvidence(evidence, {
        submittedByUser: adminUser,

        recordedAt: now,
      });

      const outcomeResult = await this.applyClaimIssueFinalPosition({
        issue,
        occurrence,

        decision: normalizedDecision,

        adminOutcome: normalizedAdminOutcome,

        resolvedByUser: adminUser,

        currentTime: now,

        authorityRole: "admin",
      });

      issue.adminDecision = normalizedDecision;

      issue.adminDecisionReason = cleanReason;

      issue.adminDecidedAt = now;

      issue.adminDecidedBy = adminUser;

      issue.adminOutcome = normalizedAdminOutcome;

      issue.adminEvidence = normalizedEvidence;

      if (issue.escalationReason === "professional_appeal") {
        issue.appealStatus = "resolved";
      }

      if (
        issue.escalationReason === "employer_counter_position" &&
        issue.rebuttalStatus === "submitted"
      ) {
        issue.rebuttalStatus = "resolved";
      }

      issue.status = "resolved";

      issue.resolvedAt = now;

      this.synchronizeClaimCaseStatus(claim);

      this.clearClaimPointerIfFinal({
        claim,
        occurrence,
      });

      /**
       * Save the case before asking ShiftSettlementService for live challenge
       * scope.
       *
       * Live scope is derived from unresolved issues in the database.
       */
      await claim.save({
        session,
      });

      const continuation = await this.continueSettlementAfterIssueResolution({
        occurrence,

        currentTime: now,

        resolvedByUser: adminUser,

        payoutPolicy,

        session,
      });

      const issueComponents = this.getIssueAffectedSettlementComponents(issue);

      const refundReevaluation = issueComponents.includes("base")
        ? await this.reevaluateRefundAfterIssueResolution({
            occurrence: continuation.occurrence,

            currentTime: now,

            adminUser,

            session,
          })
        : null;

      const parentReconciliation = await this.reconcileParentAfterIssueResolution({
        occurrence: continuation.occurrence,

        currentTime: now,

        session,
      });

      logger.info(
        `Admin ${normalizedDecision} professional claim issue ${issue._id} ` +
          `in ${claim.referenceCode}`
      );

      return {
        claim,
        issue,

        occurrence: continuation.occurrence,

        resolved: true,

        final: true,

        idempotent: false,

        caseResolved: claim.status === "resolved",

        decision: normalizedDecision,

        authoritativeChange: {
          attendanceChanged: outcomeResult.attendanceChanged,

          baseChanged: outcomeResult.baseChanged,
        },

        settlementContinuation: continuation.componentResults,

        refundReevaluation,

        parentReconciliation,

        events: [
          {
            type: "shift_occurrence_claim_issue_admin_resolved",

            occurrenceId: String(claim.occurrence),

            claimId: String(claim._id),

            claimIssueId: String(issue._id),

            claimIssueType: issue.type,

            professionalId: String(claim.professional),

            employerProfileId: String(claim.business),

            decision: normalizedDecision,

            caseResolved: claim.status === "resolved",
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── DISPUTE ADMIN RESOLUTION ─────────────────────────────── */

  static async resolveDisputeIssueByAdmin(
    {
      disputeId,
      issueId,

      adminUserId,

      decision,
      reason,

      adminOutcome = null,
      evidence = [],

      payoutPolicy = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    const adminUser = this.normalizeObjectId(adminUserId, "admin user ID");

    const normalizedDecision = this.normalizeDecision(
      decision,
      ADMIN_EMPLOYER_OCCURRENCE_DISPUTE_DECISIONS,
      "admin employer dispute decision"
    );

    const cleanReason = this.normalizeDecisionReason(reason);

    return this.runWithOptionalTransaction(options, async (session) => {
      const dispute = await this.getDispute(disputeId, session);

      const issue = this.getDisputeIssue(dispute, issueId);

      if (
        issue.status === "resolved" &&
        issue.adminDecision === normalizedDecision &&
        this.sameId(issue.adminDecidedBy, adminUser)
      ) {
        const occurrence = await this.getOccurrenceForCase({
          caseDocument: dispute,
          session,
        });

        return {
          dispute,
          issue,
          occurrence,

          resolved: true,
          final: true,
          idempotent: true,
        };
      }

      if (dispute.status === "withdrawn") {
        throw this.createError({
          message: "A withdrawn employer dispute cannot receive an admin decision.",
          code: "WITHDRAWN_DISPUTE_NOT_RESOLVABLE",
          statusCode: 409,
        });
      }

      if (issue.status !== "awaiting_admin_review") {
        throw this.createError({
          message: "This employer dispute issue is not awaiting admin review.",
          code: "DISPUTE_ISSUE_NOT_AWAITING_ADMIN_REVIEW",
          statusCode: 409,
          details: {
            issueStatus: issue.status,
          },
        });
      }

      const occurrence = await this.getOccurrenceForCase({
        caseDocument: dispute,
        session,
      });

      this.assertDisputeIsActiveOnOccurrence({
        dispute,
        occurrence,
      });

      const normalizedAdminOutcome = this.normalizeDisputeAdminOutcome({
        issue,
        decision: normalizedDecision,
        adminOutcome,
      });

      const normalizedEvidence = this.normalizeEvidence(evidence, {
        submittedByUser: adminUser,

        recordedAt: now,
      });

      const outcomeResult = await this.applyDisputeIssueFinalPosition({
        issue,
        occurrence,

        decision: normalizedDecision,

        adminOutcome: normalizedAdminOutcome,

        adminUser,

        currentTime: now,
      });

      issue.adminDecision = normalizedDecision;

      issue.adminDecisionReason = cleanReason;

      issue.adminDecidedAt = now;

      issue.adminDecidedBy = adminUser;

      issue.adminOutcome = normalizedAdminOutcome;

      issue.adminEvidence = normalizedEvidence;

      issue.status = "resolved";

      issue.resolvedAt = now;

      this.synchronizeDisputeCaseStatus(dispute);

      this.clearDisputePointerIfFinal({
        dispute,
        occurrence,
      });

      /**
       * Save the dispute before settlement asks for live challenge scope.
       *
       * Live dispute scope is derived from unresolved issues.
       */
      await dispute.save({
        session,
      });

      const continuation = await this.continueSettlementAfterIssueResolution({
        occurrence,

        currentTime: now,

        resolvedByUser: adminUser,

        payoutPolicy,

        session,
      });

      const issueComponents = this.getIssueAffectedSettlementComponents(issue);

      const refundReevaluation = issueComponents.includes("base")
        ? await this.reevaluateRefundAfterIssueResolution({
            occurrence: continuation.occurrence,

            currentTime: now,

            adminUser,

            session,
          })
        : null;

      const parentReconciliation = await this.reconcileParentAfterIssueResolution({
        occurrence: continuation.occurrence,

        currentTime: now,

        session,
      });

      logger.info(
        `Admin ${normalizedDecision} employer dispute issue ${issue._id} ` +
          `in ${dispute.referenceCode}`
      );

      return {
        dispute,
        issue,

        occurrence: continuation.occurrence,

        resolved: true,

        final: true,

        idempotent: false,

        caseResolved: dispute.status === "resolved",

        decision: normalizedDecision,

        authoritativeChange: {
          attendanceChanged: outcomeResult.attendanceChanged,

          baseChanged: outcomeResult.baseChanged,
        },

        settlementContinuation: continuation.componentResults,

        refundReevaluation,

        parentReconciliation,

        events: [
          {
            type: "shift_occurrence_dispute_issue_admin_resolved",

            occurrenceId: String(dispute.occurrence),

            disputeId: String(dispute._id),

            disputeIssueId: String(issue._id),

            disputeIssueType: issue.type,

            professionalId: String(dispute.professional),

            employerProfileId: String(dispute.business),

            decision: normalizedDecision,

            caseResolved: dispute.status === "resolved",
          },
        ],
      };
    });
  }
}

module.exports = ShiftOccurrenceResolutionService;
