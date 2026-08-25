// services/shiftOccurrenceDisputeService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");
const PlatformSettings = require("../models/PlatformSettings");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const ShiftSettlementService = require("./shiftSettlementService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");

const {
  EMPLOYER_OCCURRENCE_DISPUTE_TYPES,
  ACTIVE_EMPLOYER_OCCURRENCE_DISPUTE_STATUSES,
  OCCURRENCE_EVIDENCE_TYPES,
  OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,
} = require("../constants/shiftLifecycle");

const { SETTLEMENT_BATCH_COMPONENTS } = require("../constants/shiftSettlement");

const money = require("../utils/money");
const logger = require("../utils/logger");

const HOUR_MS = 60 * 60 * 1000;

const MAX_BATCH_SIZE = 100;

const MIN_STATEMENT_LENGTH = 10;
const MAX_STATEMENT_LENGTH = 2000;

const MIN_WITHDRAWAL_REASON_LENGTH = 10;
const MAX_WITHDRAWAL_REASON_LENGTH = 500;

const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_REFERENCE_LENGTH = 1000;
const MAX_EVIDENCE_DESCRIPTION_LENGTH = 500;

const PAYOUT_EXECUTION_STATUSES = Object.freeze([
  "approved_for_release",
  "release_pending",
  "released",
]);

const SNAPSHOT_FIELDS = Object.freeze([
  "status",
  "attendanceStatus",

  "startTime",
  "endTime",

  "checkedInAt",
  "checkedOutAt",

  "attendanceOverride",
  "checkoutFallback",
  "lateCheckout",

  "baseBillableHours",
  "billableHours",
]);

/**
 * PROFESSIONAL CLAIM ISSUE → EMPLOYER DISPUTE ISSUE
 *
 * A dispute must not recreate a controversy that already belongs to the
 * employer-response/counter-position stage of a professional claim.
 *
 * These pairs represent the same broad ordinary controversy.
 *
 * A withdrawn professional claim does not block the employer from later using
 * its own unused original dispute right while the shared challenge window is
 * still open.
 */
const PROFESSIONAL_CLAIM_OVERLAP_MAP = Object.freeze({
  attendance_correction: "attendance_correction",
  payment_calculation: "payment_calculation",
  other_financial_fact: "employer_fault",
});

/**
 * EMPLOYER OCCURRENCE DISPUTE AUTHORITY
 *
 * This service owns:
 *
 * - employer dispute eligibility;
 * - one original employer dispute case per occurrence;
 * - one or more immutable employer-originated ordinary issues;
 * - employer evidence per issue;
 * - professional response opportunity per issue;
 * - professional counter-position and evidence per issue;
 * - professional non-response escalation per issue;
 * - employer withdrawal before adjudication begins; and
 * - professional-response deadline processing.
 *
 * This service does NOT own:
 *
 * - OT request creation;
 * - OT approval/rejection;
 * - OT appeals;
 * - OT admin adjudication;
 * - OT funding;
 * - platform-fee authority;
 * - professional payout execution;
 * - employer refund eligibility or execution;
 * - final claim/dispute financial resolution; or
 * - parent Shift reconciliation.
 *
 * MULTI-ISSUE CASE
 *
 * One ShiftOccurrenceDispute contains one or more employer-originated issues:
 *
 * - attendance_correction
 * - payment_calculation
 * - other_financial_fact
 *
 * Overtime is deliberately excluded.
 *
 * All generic employer dispute issues affect BASE only.
 *
 * Each issue independently progresses:
 *
 * awaiting_professional_response
 * → awaiting_admin_review
 * → resolved
 *
 * Mixed outcomes are therefore supported.
 *
 * The dispute case remains active until every issue is final.
 *
 * SHARED CHALLENGE WINDOW
 *
 * ShiftOccurrence owns the shared initial ordinary challenge window.
 *
 * Employer dispute submission:
 *
 * - does NOT close the shared window;
 * - does NOT clear challengeableSettlementComponents;
 * - does NOT clear a disjoint activeClaim; and
 * - may create activeDispute while a professional claim remains active only
 *   when their unresolved settlement-component scopes do not overlap.
 *
 * activeClaim + activeDispute may therefore coexist only on disjoint live
 * component scopes.
 *
 * DUPLICATE CONTROVERSIES
 *
 * If a professional claim already contains the corresponding controversy,
 * the employer must respond/counter inside that professional claim.
 *
 * The employer must not create a duplicate dispute for the same controversy.
 *
 * A genuinely separate employer issue may still create a dispute only when
 * its live settlement-component scope is disjoint from any active claim.
 *
 * WITHDRAWAL
 *
 * The employer may withdraw the whole dispute only before:
 *
 * - the professional responds to any issue;
 * - any issue's response opportunity expires; or
 * - admin review begins on any issue.
 *
 * Withdrawal:
 *
 * - clears only occurrence.activeDispute;
 * - does not clear occurrence.activeClaim;
 * - does not restore lifecycle snapshots;
 * - does not reopen a second employer dispute right;
 * - does not close the shared challenge window; and
 * - does not directly reevaluate refunds.
 *
 * FINAL ADMIN OUTCOME
 *
 * Final issue adjudication belongs exclusively to:
 *
 * shiftOccurrenceResolutionService.js
 */
class ShiftOccurrenceDisputeService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftOccurrenceDisputeServiceError";
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

  static normalizeText(value, fieldName, minLength, maxLength) {
    const text = String(value || "").trim();

    if (text.length < minLength) {
      throw this.createError({
        message: `${fieldName} must contain at least ${minLength} characters.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_SHORT`,
      });
    }

    if (text.length > maxLength) {
      throw this.createError({
        message: `${fieldName} cannot exceed ${maxLength} characters.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return text;
  }

  static normalizeOptionalText(value, maxLength) {
    const text = String(value || "").trim();

    if (!text) {
      return null;
    }

    if (text.length > maxLength) {
      throw this.createError({
        message: `Text cannot exceed ${maxLength} characters.`,
        code: "OPTIONAL_TEXT_TOO_LONG",
      });
    }

    return text;
  }

  static normalizePositiveSetting(value, fieldName) {
    const number = Number(value);

    if (!Number.isSafeInteger(number) || number <= 0) {
      throw this.createError({
        message: `${fieldName} must be a positive whole number.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return number;
  }

  static normalizeBatchLimit(value) {
    const limit = Number.parseInt(value, 10);

    return Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, MAX_BATCH_SIZE)
      : MAX_BATCH_SIZE;
  }

  static normalizeIdempotencyKey(value) {
    const key = String(value || "").trim();

    if (!key) {
      throw this.createError({
        message: "Idempotency key is required to submit an employer occurrence dispute.",
        code: "DISPUTE_IDEMPOTENCY_KEY_REQUIRED",
      });
    }

    if (key.length > 200) {
      throw this.createError({
        message: "Dispute idempotency key cannot exceed 200 characters.",
        code: "DISPUTE_IDEMPOTENCY_KEY_TOO_LONG",
      });
    }

    return key;
  }

  static normalizeIssueType(value) {
    const type = String(value || "")
      .trim()
      .toLowerCase();

    if (!EMPLOYER_OCCURRENCE_DISPUTE_TYPES.includes(type)) {
      throw this.createError({
        message: "Unsupported employer occurrence dispute issue type.",
        code: "INVALID_EMPLOYER_OCCURRENCE_DISPUTE_TYPE",
        details: {
          disputeType: type || null,
          supportedTypes: EMPLOYER_OCCURRENCE_DISPUTE_TYPES,
        },
      });
    }

    return type;
  }

  static normalizeNonNegativeAmount(value, fieldName, { nullable = false, statusCode = 400 } = {}) {
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

    try {
      return money.normalizeMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw this.createError({
        message: `${fieldName} must be a non-negative whole minor-unit amount.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
        statusCode,
      });
    }
  }

  static normalizeSettlementComponents(components, { allowEmpty = false } = {}) {
    if (!Array.isArray(components)) {
      throw this.createError({
        message: "Settlement component scope must be an array.",
        code: "INVALID_SETTLEMENT_COMPONENT_SCOPE",
        statusCode: 500,
      });
    }

    const normalized = components.map((component) =>
      String(component || "")
        .trim()
        .toLowerCase()
    );

    const unique = [...new Set(normalized)];

    if (
      unique.length !== normalized.length ||
      unique.some((component) => !SETTLEMENT_BATCH_COMPONENTS.includes(component))
    ) {
      throw this.createError({
        message: "Settlement component scope contains an invalid or duplicate component.",
        code: "INVALID_SETTLEMENT_COMPONENT_SCOPE",
        statusCode: 500,
      });
    }

    const ordered = SETTLEMENT_BATCH_COMPONENTS.filter((component) => unique.includes(component));

    if (!allowEmpty && ordered.length === 0) {
      throw this.createError({
        message: "At least one settlement component is required.",
        code: "SETTLEMENT_COMPONENT_SCOPE_REQUIRED",
        statusCode: 500,
      });
    }

    return ordered;
  }

  static addHours(value, hours) {
    const date = this.normalizeCurrentTime(value);

    const normalizedHours = this.normalizePositiveSetting(hours, "dispute duration");

    return new Date(date.getTime() + normalizedHours * HOUR_MS);
  }

  /* ─────────────────────────────── EVIDENCE ─────────────────────────────── */

  static normalizeEvidence(
    evidence = [],
    { submittedByRole, submittedByUser, recordedAt = new Date() } = {}
  ) {
    if (!Array.isArray(evidence)) {
      throw this.createError({
        message: "Evidence must be an array.",
        code: "INVALID_DISPUTE_EVIDENCE",
      });
    }

    if (evidence.length > MAX_EVIDENCE_ITEMS) {
      throw this.createError({
        message: `A dispute issue cannot contain more than ${MAX_EVIDENCE_ITEMS} evidence items.`,
        code: "TOO_MANY_DISPUTE_EVIDENCE_ITEMS",
      });
    }

    if (evidence.length === 0) {
      return [];
    }

    const normalizedRole = String(submittedByRole || "")
      .trim()
      .toLowerCase();

    if (!OCCURRENCE_EVIDENCE_SUBMITTER_ROLES.includes(normalizedRole)) {
      throw this.createError({
        message: "A valid evidence submitter role is required.",
        code: "INVALID_EVIDENCE_SUBMITTER_ROLE",
      });
    }

    const normalizedSubmittedByUser = this.normalizeObjectId(
      submittedByUser,
      "evidence submitting user ID"
    );

    const normalizedRecordedAt = this.normalizeCurrentTime(recordedAt);

    return evidence.map((item, index) => {
      const type = String(item?.type || "")
        .trim()
        .toLowerCase();

      if (!OCCURRENCE_EVIDENCE_TYPES.includes(type)) {
        throw this.createError({
          message: `Evidence item ${index + 1} has an unsupported evidence type.`,
          code: "INVALID_DISPUTE_EVIDENCE_TYPE",
          details: {
            evidenceIndex: index,
            evidenceType: type || null,
            supportedTypes: OCCURRENCE_EVIDENCE_TYPES,
          },
        });
      }

      const reference = this.normalizeOptionalText(item?.reference, MAX_EVIDENCE_REFERENCE_LENGTH);

      const description = this.normalizeOptionalText(
        item?.description,
        MAX_EVIDENCE_DESCRIPTION_LENGTH
      );

      if (!reference) {
        throw this.createError({
          message: `Evidence item ${index + 1} requires a reference.`,
          code: "EMPTY_DISPUTE_EVIDENCE_ITEM",
        });
      }

      return {
        type,
        reference,
        description,
        submittedByRole: normalizedRole,
        submittedByUser: normalizedSubmittedByUser,
        recordedAt: normalizedRecordedAt,
      };
    });
  }

  /* ─────────────────────────────── ISSUE INPUT ─────────────────────────────── */

  static normalizeAttendanceCorrectionInput(attendanceCorrection) {
    if (
      !attendanceCorrection ||
      typeof attendanceCorrection !== "object" ||
      Array.isArray(attendanceCorrection)
    ) {
      throw this.createError({
        message: "Attendance correction details are required.",
        code: "ATTENDANCE_CORRECTION_DETAILS_REQUIRED",
      });
    }

    const correctedCheckInAt = this.normalizeDate(
      attendanceCorrection.correctedCheckInAt,
      "corrected check-in time",
      {
        nullable: true,
      }
    );

    const correctedCheckOutAt = this.normalizeDate(
      attendanceCorrection.correctedCheckOutAt,
      "corrected checkout time",
      {
        nullable: true,
      }
    );

    if (!correctedCheckInAt && !correctedCheckOutAt) {
      throw this.createError({
        message:
          "Attendance correction requires a corrected check-in time, corrected checkout time, or both.",
        code: "ATTENDANCE_CORRECTION_TIME_REQUIRED",
      });
    }

    if (correctedCheckInAt && correctedCheckOutAt && correctedCheckOutAt <= correctedCheckInAt) {
      throw this.createError({
        message: "Corrected checkout time must be later than corrected check-in time.",
        code: "INVALID_ATTENDANCE_CORRECTION_RANGE",
      });
    }

    return {
      correctedCheckInAt,
      correctedCheckOutAt,
    };
  }

  static normalizeIssueInput({ issue, submittedByUser, currentTime }) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
      throw this.createError({
        message: "Each employer dispute issue must be an object.",
        code: "INVALID_EMPLOYER_DISPUTE_ISSUE",
      });
    }

    if (Object.prototype.hasOwnProperty.call(issue, "affectedSettlementComponents")) {
      throw this.createError({
        message: "Settlement component scope cannot be supplied by the employer.",
        code: "DISPUTE_COMPONENT_SCOPE_CLIENT_CONTROL_NOT_ALLOWED",
      });
    }

    const type = this.normalizeIssueType(issue.type);

    const statement = this.normalizeText(
      issue.statement,
      "Dispute issue statement",
      MIN_STATEMENT_LENGTH,
      MAX_STATEMENT_LENGTH
    );

    const evidence = this.normalizeEvidence(issue.evidence || [], {
      submittedByRole: "employer",
      submittedByUser,
      recordedAt: currentTime,
    });

    if (evidence.length === 0) {
      throw this.createError({
        message: "Employer dispute evidence is required for each issue.",
        code: "EMPLOYER_DISPUTE_EVIDENCE_REQUIRED",
      });
    }

    let attendanceCorrection = null;
    let proposedBaseProfessionalPay = null;

    if (type === "attendance_correction") {
      attendanceCorrection = this.normalizeAttendanceCorrectionInput(issue.attendanceCorrection);

      if (
        issue.proposedBaseProfessionalPay !== null &&
        issue.proposedBaseProfessionalPay !== undefined &&
        issue.proposedBaseProfessionalPay !== ""
      ) {
        throw this.createError({
          message:
            "attendance_correction must state attendance facts rather than a replacement BASE-pay amount.",
          code: "ATTENDANCE_CORRECTION_BASE_PAY_NOT_ALLOWED",
        });
      }
    }

    if (type === "payment_calculation") {
      if (issue.attendanceCorrection) {
        throw this.createError({
          message: "payment_calculation cannot contain attendance-correction details.",
          code: "PAYMENT_CALCULATION_ATTENDANCE_NOT_ALLOWED",
        });
      }

      proposedBaseProfessionalPay = this.normalizeNonNegativeAmount(
        issue.proposedBaseProfessionalPay,
        "proposed BASE professional pay"
      );
    }

    if (type === "other_financial_fact") {
      if (issue.attendanceCorrection) {
        throw this.createError({
          message: "other_financial_fact cannot contain attendance-correction details.",
          code: "OTHER_FINANCIAL_FACT_ATTENDANCE_NOT_ALLOWED",
        });
      }

      proposedBaseProfessionalPay = this.normalizeNonNegativeAmount(
        issue.proposedBaseProfessionalPay,
        "proposed BASE professional pay",
        {
          nullable: true,
        }
      );
    }

    return {
      type,

      affectedSettlementComponents: ["base"],

      details: {
        attendanceCorrection,

        proposedBaseProfessionalPay,
      },

      statement,

      evidence,
    };
  }

  static normalizeIssueInputs({ issues, submittedByUser, currentTime }) {
    if (!Array.isArray(issues) || issues.length === 0) {
      throw this.createError({
        message: "At least one employer dispute issue is required.",
        code: "EMPLOYER_DISPUTE_ISSUES_REQUIRED",
      });
    }

    if (issues.length > EMPLOYER_OCCURRENCE_DISPUTE_TYPES.length) {
      throw this.createError({
        message: "Too many employer dispute issues were submitted.",
        code: "TOO_MANY_EMPLOYER_DISPUTE_ISSUES",
      });
    }

    const normalizedIssues = issues.map((issue) =>
      this.normalizeIssueInput({
        issue,
        submittedByUser,
        currentTime,
      })
    );

    const types = normalizedIssues.map((issue) => issue.type);

    if (types.length !== new Set(types).size) {
      throw this.createError({
        message: "An employer dispute cannot contain duplicate issue types.",
        code: "DUPLICATE_EMPLOYER_DISPUTE_ISSUE_TYPE",
      });
    }

    return EMPLOYER_OCCURRENCE_DISPUTE_TYPES.filter((type) => types.includes(type)).map((type) =>
      normalizedIssues.find((issue) => issue.type === type)
    );
  }

  /* ─────────────────────────────── SETTINGS / LOADERS ─────────────────────────────── */

  static async getPlatformSettings(session = null) {
    const query = PlatformSettings.findOne({
      key: "global",
      isActive: true,
    });

    if (session) {
      query.session(session);
    }

    const settings = await query;

    if (!settings) {
      throw this.createError({
        message: "Active platform settings were not found.",
        code: "PLATFORM_SETTINGS_NOT_FOUND",
        statusCode: 500,
      });
    }

    return settings;
  }

  static async getOccurrenceContext({ shiftId, occurrenceId, session = null }) {
    const shiftObjectId = this.normalizeObjectId(shiftId, "shift ID");

    const occurrenceObjectId = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const shiftQuery = Shift.findById(shiftObjectId);

    const occurrenceQuery = ShiftOccurrence.findOne({
      _id: occurrenceObjectId,
      shift: shiftObjectId,
    });

    if (session) {
      shiftQuery.session(session);
      occurrenceQuery.session(session);
    }

    const [shift, occurrence] = await Promise.all([shiftQuery, occurrenceQuery]);

    if (!shift) {
      throw this.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!occurrence) {
      throw this.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return {
      shift,
      occurrence,
    };
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

  static async getProfessionalClaimForOccurrence(occurrenceId, session = null) {
    const query = ShiftOccurrenceClaim.findOne({
      occurrence: this.normalizeObjectId(occurrenceId, "occurrence ID"),
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  /* ─────────────────────────────── AUTHORIZATION ─────────────────────────────── */

  static assertEmployerCanManageOccurrence({
    shift,
    occurrence,
    employerProfileId,
    employerContext = null,
  }) {
    const employerProfile = this.normalizeObjectId(employerProfileId, "employer profile ID");

    if (
      String(shift.business) !== String(employerProfile) ||
      String(occurrence.business) !== String(employerProfile)
    ) {
      throw this.createError({
        message: "The employer cannot dispute this occurrence.",
        code: "EMPLOYER_CANNOT_DISPUTE_OCCURRENCE",
        statusCode: 403,
      });
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    if (!canManageAllBranches && !isBranchManager) {
      throw this.createError({
        message: "You do not have permission to manage occurrence disputes.",
        code: "OCCURRENCE_DISPUTE_MANAGEMENT_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    if (!canManageAllBranches) {
      const assignedBranchIds = (employerContext?.assignedBranchIds || [])
        .filter((branchId) => mongoose.isValidObjectId(branchId))
        .map(String);

      if (!occurrence.branch || !assignedBranchIds.includes(String(occurrence.branch))) {
        throw this.createError({
          message: "You do not have permission to manage disputes for this branch.",
          code: "BRANCH_OCCURRENCE_DISPUTE_NOT_ALLOWED",
          statusCode: 403,
        });
      }
    }

    return employerProfile;
  }

  static async assertUserOwnsProfessionalProfile({ professionalId, userId, session = null }) {
    const professional = this.normalizeObjectId(professionalId, "professional profile ID");

    const user = this.normalizeObjectId(userId, "professional user ID");

    const query = ProfessionalProfile.findById(professional).select("user");

    if (session) {
      query.session(session);
    }

    const profile = await query;

    if (!profile?.user) {
      throw this.createError({
        message: "Professional profile was not found.",
        code: "PROFESSIONAL_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (String(profile.user) !== String(user)) {
      throw this.createError({
        message: "The user does not belong to this professional profile.",
        code: "PROFESSIONAL_USER_MISMATCH",
        statusCode: 403,
      });
    }

    return {
      professional,
      user,
    };
  }

  /* ─────────────────────────────── SHARED CHALLENGE WINDOW ─────────────────────────────── */

  static getOpenOccurrenceChallengeWindow({ occurrence, currentTime }) {
    const now = this.normalizeCurrentTime(currentTime);

    if (!occurrence.challengeWindowOpenedAt || !occurrence.challengeDeadlineAt) {
      throw this.createError({
        message: "This occurrence does not currently have an available challenge opportunity.",
        code: "OCCURRENCE_CHALLENGE_ELIGIBILITY_NOT_ESTABLISHED",
        statusCode: 409,
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
        message: "The occurrence contains an invalid challenge-window audit.",
        code: "INVALID_OCCURRENCE_CHALLENGE_WINDOW_AUDIT",
        statusCode: 500,
      });
    }

    if (occurrence.challengeWindowClosedAt) {
      throw this.createError({
        message: "The occurrence shared challenge window has closed.",
        code: "OCCURRENCE_CHALLENGE_WINDOW_ALREADY_CLOSED",
        statusCode: 409,
        details: {
          challengeWindowOpenedAt: openedAt,
          challengeDeadlineAt: deadlineAt,
          challengeWindowClosedAt: occurrence.challengeWindowClosedAt,
        },
      });
    }

    if (now < openedAt) {
      throw this.createError({
        message: "The occurrence challenge window is not open yet.",
        code: "OCCURRENCE_CHALLENGE_WINDOW_NOT_OPEN",
        statusCode: 409,
      });
    }

    if (now >= deadlineAt) {
      throw this.createError({
        message: "The occurrence challenge window has closed.",
        code: "OCCURRENCE_CHALLENGE_WINDOW_CLOSED",
        statusCode: 409,
        details: {
          challengeWindowOpenedAt: openedAt,
          challengeDeadlineAt: deadlineAt,
        },
      });
    }

    const challengeableComponents = this.normalizeSettlementComponents(
      Array.isArray(occurrence.challengeableSettlementComponents)
        ? occurrence.challengeableSettlementComponents
        : [],
      {
        allowEmpty: true,
      }
    );

    if (!challengeableComponents.includes("base")) {
      throw this.createError({
        message: "Regular Shift pay is no longer available for an employer ordinary dispute.",
        code: "BASE_COMPONENT_NOT_CHALLENGEABLE",
        statusCode: 409,
      });
    }

    /**
     * activeClaim is not automatically rejected here.
     *
     * Submission separately verifies that an active professional claim has no
     * unresolved BASE scope before the employer dispute is created.
     */
    if (occurrence.activeDispute) {
      throw this.createError({
        message: "An employer dispute is already active for this occurrence.",
        code: "OCCURRENCE_ACTIVE_DISPUTE_ALREADY_EXISTS",
        statusCode: 409,
        details: {
          activeDisputeId: String(occurrence.activeDispute),
        },
      });
    }

    return {
      challengeWindowOpenedAt: openedAt,
      challengeDeadlineAt: deadlineAt,
    };
  }

  /* ─────────────────────────────── OCCURRENCE FACTS ─────────────────────────────── */

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

  static getCurrentBaseProfessionalPay(occurrence) {
    if (occurrence.activeWorkCancellation?.occurred === true) {
      return this.normalizeNonNegativeAmount(
        occurrence.activeWorkCancellation.professionalPay,
        "active-work cancellation professional pay",
        {
          statusCode: 500,
        }
      );
    }

    if (occurrence.cancellationCompensation?.applicable === true) {
      return this.normalizeNonNegativeAmount(
        occurrence.cancellationCompensation.professionalPay,
        "cancellation compensation professional pay",
        {
          statusCode: 500,
        }
      );
    }

    return this.normalizeNonNegativeAmount(
      occurrence.baseProfessionalPay,
      "BASE professional pay",
      {
        statusCode: 500,
      }
    );
  }

  static hasReviewableBaseCalculation(occurrence) {
    let amount;

    try {
      amount = this.getCurrentBaseProfessionalPay(occurrence);
    } catch (error) {
      return false;
    }

    if (!Number.isSafeInteger(amount) || amount < 0) {
      return false;
    }

    if (
      occurrence.activeWorkCancellation?.occurred === true ||
      occurrence.cancellationCompensation?.applicable === true
    ) {
      return true;
    }

    return occurrence.baseBillableHours !== null && occurrence.baseBillableHours !== undefined;
  }

  static assertBaseNotInPayoutExecution(occurrence) {
    const status = occurrence.baseSettlement?.status || "not_due";

    if (PAYOUT_EXECUTION_STATUSES.includes(status)) {
      throw this.createError({
        message:
          "Regular Shift pay has already entered payout execution and can no longer receive an employer dispute.",
        code: "BASE_SETTLEMENT_RELEASE_ALREADY_STARTED",
        statusCode: 409,
        details: {
          baseSettlementStatus: status,
        },
      });
    }

    return status;
  }

  /* ─────────────────────────────── ISSUE ELIGIBILITY ─────────────────────────────── */

  static assertAttendanceCorrectionAffectsBase({ occurrence, issue }) {
    const attendanceCorrection = issue.details?.attendanceCorrection;

    if (!attendanceCorrection) {
      throw this.createError({
        message: "Attendance correction details are missing.",
        code: "ATTENDANCE_CORRECTION_DETAILS_REQUIRED",
        statusCode: 500,
      });
    }

    const correctedCheckInAt = attendanceCorrection.correctedCheckInAt
      ? this.normalizeDate(attendanceCorrection.correctedCheckInAt, "corrected check-in time")
      : null;

    const correctedCheckOutAt = attendanceCorrection.correctedCheckOutAt
      ? this.normalizeDate(attendanceCorrection.correctedCheckOutAt, "corrected checkout time")
      : null;

    const currentStartValue = this.resolveAttendanceStart(occurrence);

    const currentEndValue = this.resolveAttendanceEnd(occurrence);

    const currentStart = currentStartValue
      ? this.normalizeDate(currentStartValue, "current attendance start", {
          statusCode: 500,
        })
      : null;

    const currentEnd = currentEndValue
      ? this.normalizeDate(currentEndValue, "current attendance end", {
          statusCode: 500,
        })
      : null;

    const scheduledEnd = this.normalizeDate(occurrence.endTime, "occurrence end time", {
      statusCode: 500,
    });

    if (
      occurrence.attendanceStatus === "no_show" &&
      (!correctedCheckInAt || !correctedCheckOutAt)
    ) {
      throw this.createError({
        message:
          "Changing a no-show record to worked attendance requires both corrected check-in and checkout times.",
        code: "NO_SHOW_TO_WORKED_ATTENDANCE_RANGE_REQUIRED",
      });
    }

    if (correctedCheckInAt && correctedCheckInAt >= scheduledEnd) {
      throw this.createError({
        message: "Corrected check-in time must be before the scheduled end of the occurrence.",
        code: "CORRECTED_CHECKIN_AFTER_OCCURRENCE_END",
      });
    }

    const resultingStart = correctedCheckInAt || currentStart;

    const resultingEnd = correctedCheckOutAt || currentEnd;

    if (resultingStart && resultingEnd && resultingEnd <= resultingStart) {
      throw this.createError({
        message: "Corrected attendance would create an invalid attendance range.",
        code: "INVALID_ATTENDANCE_CORRECTION_RANGE",
      });
    }

    const checkInChanges = Boolean(
      correctedCheckInAt &&
      (!currentStart || correctedCheckInAt.getTime() !== currentStart.getTime())
    );

    const checkOutChanges = Boolean(
      correctedCheckOutAt && (!currentEnd || correctedCheckOutAt.getTime() !== currentEnd.getTime())
    );

    if (!checkInChanges && !checkOutChanges) {
      throw this.createError({
        message:
          "The proposed attendance correction does not change the authoritative attendance record.",
        code: "ATTENDANCE_CORRECTION_HAS_NO_CHANGE",
        statusCode: 409,
      });
    }

    let baseAffected = false;

    /**
     * Check-in changes affect scheduled/base work.
     */
    if (checkInChanges) {
      baseAffected = true;
    }

    /**
     * Checkout changes affect BASE only where either the current or proposed
     * checkout intersects scheduled work.
     *
     * A disagreement solely about time after scheduled end belongs to the OT
     * domain and cannot be converted into an employer ordinary dispute.
     */
    if (checkOutChanges) {
      if (!currentEnd || currentEnd < scheduledEnd || correctedCheckOutAt < scheduledEnd) {
        baseAffected = true;
      }
    }

    if (!baseAffected) {
      throw this.createError({
        message:
          "This attendance disagreement affects only post-scheduled-end time and must not enter the employer ordinary dispute workflow.",
        code: "ATTENDANCE_CORRECTION_DOES_NOT_AFFECT_BASE",
        statusCode: 409,
      });
    }

    return true;
  }

  static assertIssueAgainstOccurrence({ occurrence, issue }) {
    this.assertBaseNotInPayoutExecution(occurrence);

    if (issue.type === "attendance_correction") {
      const validAttendanceStatus = ["checked_out", "no_show", "settled"].includes(
        occurrence.attendanceStatus
      );

      if (!validAttendanceStatus) {
        throw this.createError({
          message: "No contestable attendance outcome exists for this occurrence.",
          code: "ATTENDANCE_OUTCOME_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      return this.assertAttendanceCorrectionAffectsBase({
        occurrence,
        issue,
      });
    }

    if (issue.type === "payment_calculation") {
      if (!this.hasReviewableBaseCalculation(occurrence)) {
        throw this.createError({
          message: "No reviewable regular Shift pay calculation exists for this occurrence.",
          code: "BASE_PAYMENT_CALCULATION_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      const currentAmount = this.getCurrentBaseProfessionalPay(occurrence);

      const proposedAmount = this.normalizeNonNegativeAmount(
        issue.details?.proposedBaseProfessionalPay,
        "proposed BASE professional pay"
      );

      if (currentAmount === proposedAmount) {
        throw this.createError({
          message:
            "The employer's proposed BASE pay does not differ from the current authoritative BASE pay.",
          code: "PAYMENT_CALCULATION_HAS_NO_CHANGE",
          statusCode: 409,
        });
      }

      return true;
    }

    if (issue.type === "other_financial_fact") {
      return true;
    }

    throw this.createError({
      message: "This employer dispute issue does not have a supported workflow.",
      code: "DISPUTE_ISSUE_FLOW_NOT_SUPPORTED",
      statusCode: 409,
    });
  }

  static assertOccurrenceIsDisputable({ shift, occurrence, issues }) {
    const fundedAmount = this.normalizeNonNegativeAmount(
      shift.fundedAmount ?? 0,
      "Shift funded amount",
      {
        statusCode: 500,
      }
    );

    if (!shift.publishedAt || shift.paymentStatus === "unpaid" || fundedAmount <= 0) {
      throw this.createError({
        message: "An unfunded occurrence cannot receive an employer dispute.",
        code: "UNFUNDED_OCCURRENCE_NOT_DISPUTABLE",
        statusCode: 409,
      });
    }

    if (
      occurrence.assignmentStatus === "expired_unfilled" ||
      occurrence.status === "expired_unfilled"
    ) {
      throw this.createError({
        message: "An expired-unfilled occurrence cannot receive an employer dispute.",
        code: "EXPIRED_UNFILLED_OCCURRENCE_NOT_DISPUTABLE",
        statusCode: 409,
      });
    }

    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignment ||
      !occurrence.assignedProfessional ||
      !occurrence.assignedAt
    ) {
      throw this.createError({
        message: "Only an assigned occurrence can receive an employer dispute.",
        code: "UNASSIGNED_OCCURRENCE_NOT_DISPUTABLE",
        statusCode: 409,
      });
    }

    for (const issue of issues) {
      this.assertIssueAgainstOccurrence({
        occurrence,
        issue,
      });
    }

    return true;
  }

  /* ─────────────────────────────── PROFESSIONAL CLAIM COEXISTENCE ─────────────────────────────── */

  static async assertNoActiveClaimScopeOverlap({ occurrence, disputeIssues, session }) {
    if (!occurrence.activeClaim) {
      return true;
    }

    const disputeComponents = this.normalizeSettlementComponents(
      Array.from(
        new Set(
          disputeIssues.flatMap((issue) =>
            Array.from(issue.affectedSettlementComponents || []).map(String)
          )
        )
      )
    );

    const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
      occurrence,
      session,
    });

    const claimComponents = this.normalizeSettlementComponents(
      challengeContext?.claim?.affectedSettlementComponents || [],
      {
        allowEmpty: true,
      }
    );

    const overlappingComponents = disputeComponents.filter((component) =>
      claimComponents.includes(component)
    );

    if (overlappingComponents.length > 0) {
      throw this.createError({
        message:
          "An employer dispute cannot overlap an unresolved professional claim on the same settlement component.",
        code: "DISPUTE_CLAIM_SETTLEMENT_SCOPE_OVERLAP",
        statusCode: 409,
        details: {
          activeClaimId: String(occurrence.activeClaim),
          disputeComponents,
          claimComponents,
          overlappingComponents,
        },
      });
    }

    return true;
  }

  static assertNoDuplicateProfessionalClaimControversy({ claim, disputeIssues }) {
    if (!claim) {
      return true;
    }

    /**
     * A fully withdrawn claim was never adjudicated and consumed no employer
     * response/counter-position.
     *
     * It therefore does not itself prohibit the employer from using its own
     * unused dispute right before the shared deadline.
     */
    if (claim.status === "withdrawn") {
      return true;
    }

    const claimIssues = Array.isArray(claim.issues) ? claim.issues : [];

    const overlaps = [];

    for (const disputeIssue of disputeIssues) {
      const correspondingClaimType = PROFESSIONAL_CLAIM_OVERLAP_MAP[disputeIssue.type];

      const matchingClaimIssue = claimIssues.find(
        (claimIssue) => claimIssue?.type === correspondingClaimType
      );

      if (matchingClaimIssue) {
        overlaps.push({
          disputeIssueType: disputeIssue.type,

          claimIssueType: matchingClaimIssue.type,

          claimIssueId: String(matchingClaimIssue._id),

          claimIssueStatus: matchingClaimIssue.status,
        });
      }
    }

    if (overlaps.length > 0) {
      throw this.createError({
        message:
          "One or more employer dispute issues already belong to the existing professional claim and must be handled through the employer response/counter-position workflow there.",
        code: "DISPUTE_DUPLICATES_PROFESSIONAL_CLAIM_CONTROVERSY",
        statusCode: 409,
        details: {
          claimId: String(claim._id),
          claimStatus: claim.status,
          overlappingIssues: overlaps,
        },
      });
    }

    return true;
  }

  /* ─────────────────────────────── SNAPSHOT ─────────────────────────────── */

  static cloneSnapshotValue(value) {
    if (value === null || value === undefined) {
      return value;
    }

    if (value instanceof Date) {
      return new Date(value.getTime());
    }

    if (value instanceof mongoose.Types.ObjectId) {
      return new mongoose.Types.ObjectId(String(value));
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.cloneSnapshotValue(item));
    }

    if (value && typeof value.toObject === "function") {
      return this.cloneSnapshotValue(
        value.toObject({
          depopulate: true,
        })
      );
    }

    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.cloneSnapshotValue(item)])
      );
    }

    return value;
  }

  static buildLifecycleSnapshot(occurrence) {
    return SNAPSHOT_FIELDS.reduce((snapshot, field) => {
      snapshot[field] = this.cloneSnapshotValue(occurrence.get(field));

      return snapshot;
    }, {});
  }

  /* ─────────────────────────────── CASE STATUS ─────────────────────────────── */

  static synchronizeCaseStatus(dispute) {
    const issues = Array.isArray(dispute.issues) ? dispute.issues : [];

    if (dispute.status === "withdrawn") {
      return dispute;
    }

    if (issues.length === 0) {
      throw this.createError({
        message: "An employer dispute must contain at least one issue.",
        code: "EMPLOYER_DISPUTE_ISSUES_REQUIRED",
        statusCode: 500,
        details: {
          disputeId: dispute._id ? String(dispute._id) : null,
        },
      });
    }

    const allResolved = issues.every((issue) => issue.status === "resolved");

    if (allResolved) {
      dispute.status = "resolved";

      dispute.resolvedAt =
        issues
          .map((issue) => issue.resolvedAt)
          .filter(Boolean)
          .sort((left, right) => new Date(right) - new Date(left))[0] || new Date();

      return dispute;
    }

    const hasSupportedActiveIssue = issues.some((issue) =>
      ["awaiting_professional_response", "awaiting_admin_review"].includes(issue.status)
    );

    if (hasSupportedActiveIssue) {
      dispute.status = "active";

      dispute.resolvedAt = null;

      return dispute;
    }

    throw this.createError({
      message: "Employer dispute issue statuses cannot be reconciled into a valid case status.",
      code: "INVALID_EMPLOYER_DISPUTE_CASE_STATE",
      statusCode: 500,
      details: {
        disputeId: dispute._id ? String(dispute._id) : null,
      },
    });
  }

  static getIssueById(dispute, issueId) {
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

  /* ─────────────────────────────── IDEMPOTENCY ─────────────────────────────── */

  static canonicalDate(value) {
    if (!value) {
      return null;
    }

    return this.normalizeDate(value, "canonical date", {
      statusCode: 500,
    }).toISOString();
  }

  static buildIssueSignature(issue) {
    const attendance = issue.details?.attendanceCorrection || null;

    return {
      type: issue.type,

      affectedSettlementComponents: Array.from(issue.affectedSettlementComponents || [])
        .map(String)
        .sort(),

      details: {
        attendanceCorrection: attendance
          ? {
              correctedCheckInAt: this.canonicalDate(attendance.correctedCheckInAt),

              correctedCheckOutAt: this.canonicalDate(attendance.correctedCheckOutAt),
            }
          : null,

        proposedBaseProfessionalPay: issue.details?.proposedBaseProfessionalPay ?? null,
      },

      statement: String(issue.statement || "").trim(),

      evidence: Array.from(issue.evidence || []).map((item) => ({
        type: String(item.type || ""),

        reference: String(item.reference || ""),

        description: item.description ? String(item.description) : null,
      })),
    };
  }

  static buildIssueSetSignature(issues) {
    return JSON.stringify(
      Array.from(issues || [])
        .map((issue) => this.buildIssueSignature(issue))
        .sort(
          (left, right) =>
            EMPLOYER_OCCURRENCE_DISPUTE_TYPES.indexOf(left.type) -
            EMPLOYER_OCCURRENCE_DISPUTE_TYPES.indexOf(right.type)
        )
    );
  }

  static assertIdempotentDisputeMatchesRequest({
    dispute,
    shiftId,
    occurrenceId,
    employerProfileId,
    submittedByUserId,
    normalizedIssues,
  }) {
    const shift = this.normalizeObjectId(shiftId, "shift ID");

    const occurrence = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const business = this.normalizeObjectId(employerProfileId, "employer profile ID");

    const submittedByUser = this.normalizeObjectId(submittedByUserId, "submitting user ID");

    const identityMatches =
      String(dispute.shift) === String(shift) &&
      String(dispute.occurrence) === String(occurrence) &&
      String(dispute.business) === String(business) &&
      String(dispute.submittedByUser) === String(submittedByUser);

    const issueSetMatches =
      this.buildIssueSetSignature(dispute.issues) === this.buildIssueSetSignature(normalizedIssues);

    if (!identityMatches || !issueSetMatches) {
      throw this.createError({
        message:
          "This idempotency key has already been used for a different employer dispute request.",
        code: "DISPUTE_IDEMPOTENCY_KEY_CONFLICT",
        statusCode: 409,
        details: {
          existingDisputeId: String(dispute._id),
        },
      });
    }

    return dispute;
  }

  /* ─────────────────────────────── ACTIVE DISPUTE ACTIVATION ─────────────────────────────── */

  static async activateDisputeOnOccurrence({ occurrence, dispute, currentTime, session }) {
    /**
     * activeClaim is pinned to the value whose unresolved scope was checked
     * before dispute creation.
     *
     * This permits a disjoint professional claim to coexist while preventing
     * an unnoticed claim-pointer race during dispute activation.
     *
     * The shared ordinary window remains open until its actual deadline.
     */
    const result = await ShiftOccurrence.updateOne(
      {
        _id: occurrence._id,

        shift: occurrence.shift,

        activeClaim: occurrence.activeClaim || null,

        activeDispute: null,

        challengeWindowClosedAt: null,

        challengeWindowOpenedAt: {
          $lte: currentTime,
        },

        challengeDeadlineAt: {
          $gt: currentTime,
        },

        challengeableSettlementComponents: "base",
      },
      {
        $set: {
          activeDispute: dispute._id,

          settlementStatus: "disputed",
        },
      },
      {
        session,
      }
    );

    if (result.modifiedCount !== 1) {
      throw this.createError({
        message: "The occurrence changed before the employer dispute could be activated.",
        code: "OCCURRENCE_DISPUTE_ACTIVATION_CONFLICT",
        statusCode: 409,
      });
    }

    occurrence.activeDispute = dispute._id;

    occurrence.settlementStatus = "disputed";

    return occurrence;
  }

  /* ─────────────────────────────── SUBMISSION ─────────────────────────────── */

  static async submitDispute(
    {
      shiftId,
      occurrenceId,

      employerProfileId,
      employerUserId,
      employerContext = null,

      issues,

      idempotencyKey,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    const cleanIdempotencyKey = this.normalizeIdempotencyKey(idempotencyKey);

    const submittedByUser = this.normalizeObjectId(employerUserId, "employer user ID");

    const normalizedIssues = this.normalizeIssueInputs({
      issues,
      submittedByUser,
      currentTime: now,
    });

    return this.runWithOptionalTransaction(options, async (session) => {
      const idempotentDispute = await ShiftOccurrenceDispute.findOne({
        idempotencyKey: cleanIdempotencyKey,
      }).session(session);

      if (idempotentDispute) {
        this.assertIdempotentDisputeMatchesRequest({
          dispute: idempotentDispute,

          shiftId,
          occurrenceId,

          employerProfileId,

          submittedByUserId: submittedByUser,

          normalizedIssues,
        });

        return {
          dispute: idempotentDispute,

          created: false,

          idempotent: true,
        };
      }

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId,
        occurrenceId,
        session,
      });

      this.assertEmployerCanManageOccurrence({
        shift,
        occurrence,
        employerProfileId,
        employerContext,
      });

      /**
       * Maximum one original employer dispute case per occurrence.
       *
       * Resolved and withdrawn cases still consume that original right.
       */
      const existingDispute = await ShiftOccurrenceDispute.findOne({
        occurrence: occurrence._id,
      }).session(session);

      if (existingDispute) {
        throw this.createError({
          message:
            "The employer has already submitted its original dispute case for this occurrence.",
          code: "ORIGINAL_OCCURRENCE_DISPUTE_ALREADY_EXISTS",
          statusCode: 409,
          details: {
            disputeId: String(existingDispute._id),
            status: existingDispute.status,
          },
        });
      }

      const { challengeWindowOpenedAt, challengeDeadlineAt } =
        this.getOpenOccurrenceChallengeWindow({
          occurrence,
          currentTime: now,
        });

      this.assertOccurrenceIsDisputable({
        shift,
        occurrence,
        issues: normalizedIssues,
      });

      /**
       * A professional claim does not globally prohibit this dispute.
       *
       * A live claim must first be disjoint at settlement-component level.
       * Historical duplicate controversy is then checked separately.
       */
      await this.assertNoActiveClaimScopeOverlap({
        occurrence,
        disputeIssues: normalizedIssues,
        session,
      });

      const professionalClaim = await this.getProfessionalClaimForOccurrence(
        occurrence._id,
        session
      );

      this.assertNoDuplicateProfessionalClaimControversy({
        claim: professionalClaim,

        disputeIssues: normalizedIssues,
      });

      const settings = await this.getPlatformSettings(session);

      const professionalResponseHours = this.normalizePositiveSetting(
        settings.professionalDisputeResponseHours,
        "professionalDisputeResponseHours"
      );

      const professionalResponseDeadlineAt = this.addHours(now, professionalResponseHours);

      const submittedIssueTypes = normalizedIssues.map((issue) => issue.type);

      const lifecycleSnapshot = this.buildLifecycleSnapshot(occurrence);

      const [dispute] = await ShiftOccurrenceDispute.create(
        [
          {
            referenceCode: generateReference("LQ-DSP"),

            idempotencyKey: cleanIdempotencyKey,

            shift: shift._id,

            occurrence: occurrence._id,

            assignment: occurrence.assignment,

            business: occurrence.business,

            branch: occurrence.branch,

            professional: occurrence.assignedProfessional,

            submittedByUser,

            submittedIssueTypes,

            issues: normalizedIssues.map((issue) => ({
              type: issue.type,

              affectedSettlementComponents: issue.affectedSettlementComponents,

              details: issue.details,

              statement: issue.statement,

              evidence: issue.evidence,

              status: "awaiting_professional_response",

              professionalResponseStatement: null,

              professionalCounterPosition: null,

              professionalResponseEvidence: [],

              professionalRespondedAt: null,

              professionalRespondedBy: null,

              professionalResponseExpiredAt: null,

              adminReviewStartedAt: null,

              adminDecision: null,

              adminDecisionReason: null,

              adminDecidedAt: null,

              adminDecidedBy: null,

              adminOutcome: null,

              adminEvidence: [],

              resolvedAt: null,
            })),

            /**
             * Immutable historical aggregate scope.
             *
             * #7 derives the LIVE hold from unresolved issues[] instead.
             */
            affectedSettlementComponents: ["base"],

            submittedAt: now,

            challengeWindowOpenedAt,

            challengeDeadlineAt,

            professionalResponseDeadlineAt,

            lifecycleSnapshot,

            status: "active",

            employerRefund: occurrence.employerRefund || null,

            resolvedAt: null,

            withdrawnAt: null,
            withdrawnBy: null,
            withdrawalReason: null,
          },
        ],
        {
          session,
        }
      );

      await this.activateDisputeOnOccurrence({
        occurrence,
        dispute,
        currentTime: now,
        session,
      });

      logger.info(
        `Employer dispute ${dispute.referenceCode} created for occurrence ` +
          `${occurrence.referenceCode}; issues: ${submittedIssueTypes.join(", ")}`
      );

      return {
        dispute,

        occurrence,

        shift,

        created: true,

        idempotent: false,

        coexistsWithProfessionalClaim: Boolean(occurrence.activeClaim),

        events: [
          {
            type: "shift_occurrence_dispute_submitted",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            disputeId: String(dispute._id),

            professionalId: String(occurrence.assignedProfessional),

            employerProfileId: String(occurrence.business),

            submittedIssueTypes,

            affectedSettlementComponents: ["base"],

            professionalResponseDeadlineAt,
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── PROFESSIONAL COUNTER-POSITION ─────────────────────────────── */

  static normalizeProfessionalCounterPosition({ issue, counterPosition }) {
    if (counterPosition === null || counterPosition === undefined) {
      return null;
    }

    if (typeof counterPosition !== "object" || Array.isArray(counterPosition)) {
      throw this.createError({
        message: "Professional counter-position must be an object.",
        code: "INVALID_PROFESSIONAL_DISPUTE_COUNTER_POSITION",
      });
    }

    const hasCheckIn =
      counterPosition.correctedCheckInAt !== null &&
      counterPosition.correctedCheckInAt !== undefined &&
      counterPosition.correctedCheckInAt !== "";

    const hasCheckOut =
      counterPosition.correctedCheckOutAt !== null &&
      counterPosition.correctedCheckOutAt !== undefined &&
      counterPosition.correctedCheckOutAt !== "";

    const hasProposedPay =
      counterPosition.proposedBaseProfessionalPay !== null &&
      counterPosition.proposedBaseProfessionalPay !== undefined &&
      counterPosition.proposedBaseProfessionalPay !== "";

    if (!hasCheckIn && !hasCheckOut && !hasProposedPay) {
      return null;
    }

    if (issue.type === "attendance_correction") {
      if (hasProposedPay) {
        throw this.createError({
          message:
            "An attendance response must state attendance facts rather than a replacement BASE-pay amount.",
          code: "ATTENDANCE_RESPONSE_BASE_PAY_NOT_ALLOWED",
        });
      }

      const correctedCheckInAt = hasCheckIn
        ? this.normalizeDate(
            counterPosition.correctedCheckInAt,
            "professional corrected check-in time"
          )
        : null;

      const correctedCheckOutAt = hasCheckOut
        ? this.normalizeDate(
            counterPosition.correctedCheckOutAt,
            "professional corrected checkout time"
          )
        : null;

      if (correctedCheckInAt && correctedCheckOutAt && correctedCheckOutAt <= correctedCheckInAt) {
        throw this.createError({
          message: "Professional corrected checkout must be later than corrected check-in.",
          code: "INVALID_PROFESSIONAL_ATTENDANCE_COUNTER_POSITION",
        });
      }

      return {
        correctedCheckInAt,
        correctedCheckOutAt,
        proposedBaseProfessionalPay: null,
      };
    }

    if (hasCheckIn || hasCheckOut) {
      throw this.createError({
        message: "Attendance timestamps are only valid for an attendance_correction response.",
        code: "PROFESSIONAL_COUNTER_POSITION_ATTENDANCE_NOT_ALLOWED",
      });
    }

    return {
      correctedCheckInAt: null,

      correctedCheckOutAt: null,

      proposedBaseProfessionalPay: hasProposedPay
        ? this.normalizeNonNegativeAmount(
            counterPosition.proposedBaseProfessionalPay,
            "professional proposed BASE professional pay"
          )
        : null,
    };
  }

  /* ─────────────────────────────── PROFESSIONAL RESPONSE ─────────────────────────────── */

  static async submitProfessionalResponse(
    {
      disputeId,
      issueId,

      professionalId,
      submittedByUserId,

      statement,
      counterPosition = null,
      evidence = [],

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const dispute = await this.getDispute(disputeId, session);

      const issue = this.getIssueById(dispute, issueId);

      const { professional, user: submittedByUser } = await this.assertUserOwnsProfessionalProfile({
        professionalId,
        userId: submittedByUserId,
        session,
      });

      if (String(dispute.professional) !== String(professional)) {
        throw this.createError({
          message: "The professional cannot respond to this dispute.",
          code: "PROFESSIONAL_CANNOT_RESPOND_TO_DISPUTE",
          statusCode: 403,
        });
      }

      /**
       * Safe duplicate submission after the original response has already
       * moved this issue to admin review.
       */
      if (issue.status === "awaiting_admin_review" && issue.professionalRespondedAt) {
        return {
          dispute,
          issue,

          submitted: false,

          idempotent: true,

          finalAdminReviewRequired: true,
        };
      }

      if (issue.status !== "awaiting_professional_response") {
        throw this.createError({
          message: "This dispute issue is not awaiting a professional response.",
          code: "DISPUTE_ISSUE_NOT_AWAITING_PROFESSIONAL_RESPONSE",
          statusCode: 409,
          details: {
            issueStatus: issue.status,
          },
        });
      }

      if (
        !dispute.professionalResponseDeadlineAt ||
        now >= dispute.professionalResponseDeadlineAt
      ) {
        throw this.createError({
          message: "The professional response window has closed.",
          code: "DISPUTE_PROFESSIONAL_RESPONSE_WINDOW_CLOSED",
          statusCode: 409,
        });
      }

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: dispute.shift,

        occurrenceId: dispute.occurrence,

        session,
      });

      /**
       * A disjoint activeClaim may coexist and is deliberately not treated as
       * a conflict.
       */
      if (!occurrence.activeDispute || String(occurrence.activeDispute) !== String(dispute._id)) {
        throw this.createError({
          message: "This dispute is no longer the occurrence's active employer dispute.",
          code: "DISPUTE_NOT_ACTIVE_OCCURRENCE_DISPUTE",
          statusCode: 409,
        });
      }

      const cleanStatement = this.normalizeText(
        statement,
        "Professional response statement",
        MIN_STATEMENT_LENGTH,
        MAX_STATEMENT_LENGTH
      );

      const normalizedCounterPosition = this.normalizeProfessionalCounterPosition({
        issue,
        counterPosition,
      });

      const normalizedEvidence = this.normalizeEvidence(evidence, {
        submittedByRole: "professional",

        submittedByUser,

        recordedAt: now,
      });

      issue.professionalResponseStatement = cleanStatement;

      issue.professionalCounterPosition = normalizedCounterPosition;

      issue.professionalResponseEvidence = normalizedEvidence;

      issue.professionalRespondedAt = now;

      issue.professionalRespondedBy = submittedByUser;

      issue.professionalResponseExpiredAt = null;

      /**
       * Employer-originated disputes always require final admin judgment.
       *
       * The professional response supplies evidence/position only.
       */
      issue.adminReviewStartedAt = now;

      issue.status = "awaiting_admin_review";

      this.synchronizeCaseStatus(dispute);

      await dispute.save({
        session,
      });

      return {
        dispute,
        issue,

        shift,
        occurrence,

        submitted: true,

        idempotent: false,

        finalAdminReviewRequired: true,

        remainingProfessionalResponseIssueIds: dispute.issues
          .filter((item) => item.status === "awaiting_professional_response")
          .map((item) => String(item._id)),

        events: [
          {
            type: "shift_occurrence_dispute_professional_response_submitted",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            disputeId: String(dispute._id),

            disputeIssueId: String(issue._id),

            disputeIssueType: issue.type,

            professionalId: String(dispute.professional),
          },

          {
            type: "shift_occurrence_dispute_issue_admin_review_required",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            disputeId: String(dispute._id),

            disputeIssueId: String(issue._id),
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── PROFESSIONAL NON-RESPONSE ─────────────────────────────── */

  static async escalateProfessionalNonResponseToAdmin(
    { disputeId, currentTime = new Date() },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const dispute = await this.getDispute(disputeId, session);

      const waitingIssues = dispute.issues.filter(
        (issue) => issue.status === "awaiting_professional_response"
      );

      if (waitingIssues.length === 0) {
        if (dispute.status === "active" || dispute.status === "resolved") {
          return {
            dispute,

            escalated: false,

            escalatedIssueIds: [],

            idempotent: true,
          };
        }

        throw this.createError({
          message: "This dispute has no issue awaiting professional response.",
          code: "DISPUTE_HAS_NO_PENDING_PROFESSIONAL_RESPONSE",
          statusCode: 409,
        });
      }

      if (!dispute.professionalResponseDeadlineAt || now < dispute.professionalResponseDeadlineAt) {
        throw this.createError({
          message: "The professional response deadline has not expired.",
          code: "PROFESSIONAL_RESPONSE_DEADLINE_NOT_EXPIRED",
          statusCode: 409,
        });
      }

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: dispute.shift,

        occurrenceId: dispute.occurrence,

        session,
      });

      if (!occurrence.activeDispute || String(occurrence.activeDispute) !== String(dispute._id)) {
        throw this.createError({
          message: "This dispute is no longer the occurrence's active employer dispute.",
          code: "DISPUTE_NOT_ACTIVE_OCCURRENCE_DISPUTE",
          statusCode: 409,
        });
      }

      const escalatedIssueIds = [];

      for (const issue of waitingIssues) {
        /**
         * Professional silence is not acceptance of the employer's position.
         */
        issue.professionalResponseExpiredAt = now;

        issue.adminReviewStartedAt = now;

        issue.status = "awaiting_admin_review";

        escalatedIssueIds.push(String(issue._id));
      }

      this.synchronizeCaseStatus(dispute);

      await dispute.save({
        session,
      });

      return {
        dispute,

        shift,
        occurrence,

        escalated: true,

        idempotent: false,

        escalatedIssueIds,

        professionalSilenceIsAdmission: false,

        employerAutomaticallyWins: false,

        events: escalatedIssueIds.flatMap((issueId) => [
          {
            type: "shift_occurrence_dispute_professional_response_expired",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            disputeId: String(dispute._id),

            disputeIssueId: issueId,
          },

          {
            type: "shift_occurrence_dispute_issue_admin_review_required",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            disputeId: String(dispute._id),

            disputeIssueId: issueId,
          },
        ]),
      };
    });
  }

  /* ─────────────────────────────── WITHDRAWAL ─────────────────────────────── */

  static assertDisputeUntouchedForWithdrawal(dispute) {
    for (const issue of dispute.issues) {
      const hasProfessionalActivity = Boolean(
        issue.professionalResponseStatement ||
        issue.professionalRespondedAt ||
        issue.professionalRespondedBy ||
        issue.professionalResponseExpiredAt ||
        (Array.isArray(issue.professionalResponseEvidence) &&
          issue.professionalResponseEvidence.length > 0) ||
        issue.professionalCounterPosition
      );

      const hasAdminActivity = Boolean(
        issue.adminReviewStartedAt ||
        issue.adminDecision ||
        issue.adminDecisionReason ||
        issue.adminDecidedAt ||
        issue.adminDecidedBy ||
        issue.adminOutcome ||
        issue.resolvedAt ||
        (Array.isArray(issue.adminEvidence) && issue.adminEvidence.length > 0)
      );

      if (
        issue.status !== "awaiting_professional_response" ||
        hasProfessionalActivity ||
        hasAdminActivity
      ) {
        throw this.createError({
          message:
            "The employer dispute can no longer be withdrawn because professional response or adjudication has begun on at least one issue.",
          code: "EMPLOYER_DISPUTE_WITHDRAWAL_NO_LONGER_AVAILABLE",
          statusCode: 409,
          details: {
            issueId: String(issue._id),
            issueType: issue.type,
            issueStatus: issue.status,
          },
        });
      }
    }

    return true;
  }

  static async withdrawDispute(
    {
      disputeId,

      employerProfileId,
      employerUserId,
      employerContext = null,

      reason,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const dispute = await this.getDispute(disputeId, session);

      if (dispute.status === "withdrawn") {
        return {
          dispute,

          withdrawn: true,

          idempotent: true,
        };
      }

      if (!ACTIVE_EMPLOYER_OCCURRENCE_DISPUTE_STATUSES.includes(dispute.status)) {
        throw this.createError({
          message: "Only an active employer dispute can be withdrawn.",
          code: "EMPLOYER_OCCURRENCE_DISPUTE_NOT_WITHDRAWABLE",
          statusCode: 409,
        });
      }

      this.assertDisputeUntouchedForWithdrawal(dispute);

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: dispute.shift,

        occurrenceId: dispute.occurrence,

        session,
      });

      this.assertEmployerCanManageOccurrence({
        shift,
        occurrence,
        employerProfileId,
        employerContext,
      });

      const withdrawnBy = this.normalizeObjectId(employerUserId, "employer user ID");

      if (!occurrence.activeDispute || String(occurrence.activeDispute) !== String(dispute._id)) {
        throw this.createError({
          message: "This dispute is no longer the occurrence's active employer dispute.",
          code: "DISPUTE_NOT_ACTIVE_OCCURRENCE_DISPUTE",
          statusCode: 409,
        });
      }

      const cleanReason = this.normalizeText(
        reason,
        "Dispute withdrawal reason",
        MIN_WITHDRAWAL_REASON_LENGTH,
        MAX_WITHDRAWAL_REASON_LENGTH
      );

      dispute.status = "withdrawn";

      dispute.withdrawnAt = now;

      dispute.withdrawnBy = withdrawnBy;

      dispute.withdrawalReason = cleanReason;

      dispute.resolvedAt = null;

      await dispute.save({
        session,
      });

      /**
       * Clear only activeDispute.
       *
       * activeClaim may legitimately remain.
       */
      const clearResult = await ShiftOccurrence.updateOne(
        {
          _id: occurrence._id,

          activeDispute: dispute._id,
        },
        {
          $set: {
            activeDispute: null,
          },
        },
        {
          session,
        }
      );

      if (clearResult.modifiedCount !== 1) {
        throw this.createError({
          message: "The occurrence active dispute changed before withdrawal completed.",
          code: "OCCURRENCE_ACTIVE_DISPUTE_CLEAR_CONFLICT",
          statusCode: 409,
        });
      }

      occurrence.activeDispute = null;

      /**
       * Withdrawal does not restore any occurrence snapshot.
       *
       * The dispute has not changed authoritative occurrence facts yet.
       *
       * The shared window remains open until its real deadline.
       */
      ShiftSettlementService.synchronizeExpiredChallengeWindow({
        occurrence,
        currentTime: now,
      });

      const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
        occurrence,
        session,
      });

      ShiftSettlementService.synchronizeOverallSettlementState({
        occurrence,
        currentTime: now,
        challengeContext,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Employer dispute ${dispute.referenceCode} withdrawn for occurrence ` +
          `${occurrence.referenceCode}`
      );

      return {
        dispute,

        occurrence,

        shift,

        withdrawn: true,

        idempotent: false,

        professionalClaimStillActive: Boolean(occurrence.activeClaim),

        events: [
          {
            type: "shift_occurrence_dispute_withdrawn",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            disputeId: String(dispute._id),

            employerProfileId: String(dispute.business),
          },
        ],
      };
    });
  }

  /*
   * Deliberately no admin-resolution method here.
   *
   * Final admin adjudication of each employer-originated issue belongs only
   * to services/shiftOccurrenceResolutionService.js.
   */

  /* ─────────────────────────────── DEADLINES ─────────────────────────────── */

  static async processOverdueProfessionalResponses({
    currentTime = new Date(),
    limit = MAX_BATCH_SIZE,
  } = {}) {
    const now = this.normalizeCurrentTime(currentTime);

    const normalizedLimit = this.normalizeBatchLimit(limit);

    const disputes = await ShiftOccurrenceDispute.find({
      status: "active",

      professionalResponseDeadlineAt: {
        $ne: null,
        $lte: now,
      },

      "issues.status": "awaiting_professional_response",
    })
      .select("_id professionalResponseDeadlineAt")
      .sort({
        professionalResponseDeadlineAt: 1,
      })
      .limit(normalizedLimit)
      .lean();

    const results = [];

    for (const dispute of disputes) {
      try {
        const result = await this.escalateProfessionalNonResponseToAdmin({
          disputeId: dispute._id,

          currentTime: now,
        });

        results.push({
          disputeId: String(dispute._id),

          escalated: result.escalated,

          escalatedIssueIds: result.escalatedIssueIds || [],

          error: null,
        });
      } catch (error) {
        results.push({
          disputeId: String(dispute._id),

          escalated: false,

          escalatedIssueIds: [],

          error: {
            message: error.message,

            code: error.code || "PROFESSIONAL_RESPONSE_ESCALATION_FAILED",
          },
        });
      }
    }

    return {
      inspectedCount: disputes.length,

      escalatedCaseCount: results.filter((item) => item.escalated).length,

      escalatedIssueCount: results.reduce(
        (total, item) => total + item.escalatedIssueIds.length,
        0
      ),

      failedCount: results.filter((item) => item.error).length,

      results,
    };
  }
}

module.exports = ShiftOccurrenceDisputeService;
