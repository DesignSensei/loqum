// services/shiftOccurrenceClaimService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const PlatformSettings = require("../models/PlatformSettings");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const ShiftOccurrenceResolutionService = require("./shiftOccurrenceResolutionService");
const ShiftSettlementService = require("./shiftSettlementService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");

const {
  FINANCIAL_OCCURRENCE_CLAIM_TYPES,
  EMPLOYER_FINANCIAL_CLAIM_DECISIONS,
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

const MIN_REASON_LENGTH = 10;
const MAX_EMPLOYER_DECISION_REASON_LENGTH = 1500;
const MAX_WITHDRAWAL_REASON_LENGTH = 500;

const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_REFERENCE_LENGTH = 1000;
const MAX_EVIDENCE_DESCRIPTION_LENGTH = 500;

const PAYOUT_EXECUTION_STATUSES = Object.freeze([
  "approved_for_release",
  "release_pending",
  "released",
]);

/**
 * The claim snapshot is evidential context only.
 *
 * It deliberately excludes:
 *
 * - settlement amount authority;
 * - platform-fee authority;
 * - refund authority;
 * - overtime decision/funding authority;
 * - challenge-window authority; and
 * - active claim/dispute pointers.
 *
 * Claim submission no longer restores this snapshot on withdrawal or
 * rejection. Final occurrence changes belong to
 * ShiftOccurrenceResolutionService.
 */
const SNAPSHOT_FIELDS = Object.freeze([
  "status",
  "attendanceStatus",

  "checkedInAt",
  "checkedOutAt",

  "attendanceOverride",
  "checkoutFallback",
  "lateCheckout",

  "baseBillableHours",
  "billableHours",
]);

/**
 * PROFESSIONAL CLAIM CASE AUTHORITY
 *
 * One ShiftOccurrenceClaim exists per occurrence.
 *
 * That one case may contain one or more immutable ordinary issues:
 *
 * - attendance_correction
 * - payment_calculation
 * - employer_fault
 *
 * The issue set is immutable after submission.
 *
 * Each issue independently owns:
 *
 * - professional position;
 * - professional statement;
 * - professional evidence;
 * - affected settlement-component scope;
 * - employer decision;
 * - employer counter-position;
 * - employer evidence;
 * - professional appeal;
 * - admin escalation; and
 * - final resolution status.
 *
 * CLAIM / DISPUTE COEXISTENCE
 *
 * activeClaim and activeDispute may coexist when their unresolved settlement
 * component scopes do not overlap.
 *
 * Professional claim submission therefore:
 *
 * - rejects overlap with an already-active employer dispute;
 * - sets activeClaim;
 * - does NOT clear a disjoint activeDispute;
 * - does NOT close the shared 24-hour window; and
 * - does NOT clear challengeableSettlementComponents.
 *
 * PROFESSIONAL CLAIM FINALITY
 *
 * Resolving one issue does not resolve the whole case.
 *
 * activeClaim remains until every issue is final.
 *
 * When every issue is resolved:
 *
 * - claim.status becomes resolved;
 * - claim.resolvedAt is recorded; and
 * - occurrence.activeClaim is cleared.
 *
 * The shared occurrence challenge window remains independently governed by
 * challengeDeadlineAt.
 *
 * OVERTIME
 *
 * There is no overtime claim type here.
 *
 * An attendance_correction may factually affect the overtime component where
 * the corrected checkout crosses or changes post-scheduled-end attendance.
 *
 * That does not create or adjudicate an overtime request.
 *
 * OT request, employer OT decision, OT appeal, admin OT decision and OT funding
 * all remain in the dedicated overtime services.
 *
 * MONEY AUTHORITY
 *
 * This service does not:
 *
 * - calculate final professional entitlement from disputed facts;
 * - earn or collect platform fees;
 * - execute or hold refunds directly;
 * - execute payouts; or
 * - reconcile the parent Shift.
 *
 * Final issue outcomes are handed to ShiftOccurrenceResolutionService.
 */
class ShiftOccurrenceClaimService {
  /* ─────────────────────────────── CORE HELPERS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftOccurrenceClaimServiceError";
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
        message: `${fieldName} must contain at least ` + `${minLength} characters.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_SHORT`,
      });
    }

    if (text.length > maxLength) {
      throw this.createError({
        message: `${fieldName} cannot exceed ` + `${maxLength} characters.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return text;
  }

  static normalizeOptionalText(value, fieldName, maxLength) {
    const text = String(value ?? "").trim();

    if (!text) {
      return null;
    }

    if (text.length > maxLength) {
      throw this.createError({
        message: `${fieldName} cannot exceed ` + `${maxLength} characters.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_LONG`,
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

  static normalizeOptionalMinorUnitAmount(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
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

  static normalizeBatchLimit(value) {
    const limit = Number.parseInt(value, 10);

    return Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, MAX_BATCH_SIZE)
      : MAX_BATCH_SIZE;
  }

  static addHours(value, hours) {
    const date = this.normalizeCurrentTime(value);

    const normalizedHours = this.normalizePositiveSetting(hours, "hours");

    return new Date(date.getTime() + normalizedHours * HOUR_MS);
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  static cloneStateValue(value) {
    if (value === null || value === undefined) {
      return value;
    }

    if (value instanceof Date) {
      return new Date(value.getTime());
    }

    if (value?._bsontype === "ObjectId") {
      return new mongoose.Types.ObjectId(String(value));
    }

    if (typeof value?.toObject === "function") {
      return value.toObject({
        depopulate: true,
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.cloneStateValue(item));
    }

    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.cloneStateValue(item)])
      );
    }

    return value;
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

  static async getOccurrenceContext({ shiftId, occurrenceId, session }) {
    const normalizedShiftId = this.normalizeObjectId(shiftId, "shift ID");

    const normalizedOccurrenceId = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const shiftQuery = Shift.findById(normalizedShiftId);

    const occurrenceQuery = ShiftOccurrence.findOne({
      _id: normalizedOccurrenceId,
      shift: normalizedShiftId,
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

  static async getClaim(claimId, session = null) {
    const normalizedClaimId = this.normalizeObjectId(claimId, "claim ID");

    const query = ShiftOccurrenceClaim.findById(normalizedClaimId);

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

  static getClaimIssue(claim, issueId) {
    const normalizedIssueId = this.normalizeObjectId(issueId, "claim issue ID");

    const issue = claim.issues?.id(normalizedIssueId);

    if (!issue) {
      throw this.createError({
        message: "The requested claim issue was not found.",
        code: "CLAIM_ISSUE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return issue;
  }

  static async assertUserOwnsProfessionalProfile({ professionalId, userId, session }) {
    const professional = this.normalizeObjectId(professionalId, "professional profile ID");

    const user = this.normalizeObjectId(userId, "professional user ID");

    const query = ProfessionalProfile.findById(professional).select("user");

    if (session) {
      query.session(session);
    }

    const professionalProfile = await query;

    if (!professionalProfile?.user) {
      throw this.createError({
        message: "Professional profile was not found.",
        code: "PROFESSIONAL_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (String(professionalProfile.user) !== String(user)) {
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

  static assertProfessionalOwnsOccurrence({ occurrence, professionalId }) {
    const professional = this.normalizeObjectId(professionalId, "professional profile ID");

    if (
      !occurrence.assignedProfessional ||
      String(occurrence.assignedProfessional) !== String(professional)
    ) {
      throw this.createError({
        message: "This occurrence is not assigned to the professional submitting the claim.",
        code: "PROFESSIONAL_NOT_ASSIGNED_TO_OCCURRENCE",
        statusCode: 403,
      });
    }

    return professional;
  }

  static assertEmployerCanReviewClaim({ claim, employerProfileId, employerContext = null }) {
    const employerProfile = this.normalizeObjectId(employerProfileId, "employer profile ID");

    if (String(claim.business) !== String(employerProfile)) {
      throw this.createError({
        message: "The employer cannot review this claim.",
        code: "EMPLOYER_CANNOT_REVIEW_CLAIM",
        statusCode: 403,
      });
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    if (!canManageAllBranches && !isBranchManager) {
      throw this.createError({
        message: "You do not have permission to review occurrence claims.",
        code: "CLAIM_REVIEW_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    if (!canManageAllBranches) {
      const assignedBranchIds = (employerContext?.assignedBranchIds || [])
        .filter((branchId) => mongoose.isValidObjectId(branchId))
        .map(String);

      if (!claim.branch || !assignedBranchIds.includes(String(claim.branch))) {
        throw this.createError({
          message: "You do not have permission to review claims for this branch.",
          code: "BRANCH_CLAIM_REVIEW_NOT_ALLOWED",
          statusCode: 403,
        });
      }
    }

    return true;
  }

  /* ─────────────────────────────── EVIDENCE ─────────────────────────────── */

  static normalizeEvidence(
    evidence = [],
    { submittedByRole, submittedByUser, recordedAt = new Date() } = {}
  ) {
    if (!Array.isArray(evidence)) {
      throw this.createError({
        message: "Evidence must be an array.",
        code: "INVALID_CLAIM_EVIDENCE",
      });
    }

    if (evidence.length > MAX_EVIDENCE_ITEMS) {
      throw this.createError({
        message:
          `A claim issue cannot contain more than ` +
          `${MAX_EVIDENCE_ITEMS} evidence items in one evidence set.`,
        code: "TOO_MANY_CLAIM_EVIDENCE_ITEMS",
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

    const normalizedUser = this.normalizeObjectId(submittedByUser, "evidence submitting user ID");

    const normalizedRecordedAt = this.normalizeDate(recordedAt, "evidence recorded time");

    return evidence.map((item, index) => {
      const type = String(item?.type || "")
        .trim()
        .toLowerCase();

      if (!OCCURRENCE_EVIDENCE_TYPES.includes(type)) {
        throw this.createError({
          message: `Evidence item ${index + 1} has an unsupported evidence type.`,
          code: "INVALID_CLAIM_EVIDENCE_TYPE",
          details: {
            evidenceIndex: index,
            evidenceType: type || null,
            supportedTypes: OCCURRENCE_EVIDENCE_TYPES,
          },
        });
      }

      const reference = this.normalizeOptionalText(
        item?.reference,
        `Evidence item ${index + 1} reference`,
        MAX_EVIDENCE_REFERENCE_LENGTH
      );

      const description = this.normalizeOptionalText(
        item?.description,
        `Evidence item ${index + 1} description`,
        MAX_EVIDENCE_DESCRIPTION_LENGTH
      );

      if (!reference) {
        throw this.createError({
          message: `Evidence item ${index + 1} requires a reference.`,
          code: "EMPTY_CLAIM_EVIDENCE_ITEM",
        });
      }

      return {
        type,
        reference,
        description,
        submittedByRole: normalizedRole,
        submittedByUser: normalizedUser,
        recordedAt: normalizedRecordedAt,
      };
    });
  }

  /* ─────────────────────────────── COMPONENT SCOPE ─────────────────────────────── */

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

  static getChallengeableSettlementComponents(occurrence) {
    return this.normalizeSettlementComponents(
      Array.isArray(occurrence?.challengeableSettlementComponents)
        ? occurrence.challengeableSettlementComponents
        : [],
      {
        allowEmpty: true,
      }
    );
  }

  static getAggregateAffectedSettlementComponents(issues) {
    const aggregate = new Set();

    for (const issue of issues) {
      for (const component of issue.affectedSettlementComponents || []) {
        aggregate.add(component);
      }
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => aggregate.has(component));
  }

  static getUnresolvedAffectedSettlementComponents(claim) {
    const aggregate = new Set();

    for (const issue of claim.issues || []) {
      if (issue.status === "resolved") {
        continue;
      }

      for (const component of issue.affectedSettlementComponents || []) {
        aggregate.add(String(component));
      }
    }

    return SETTLEMENT_BATCH_COMPONENTS.filter((component) => aggregate.has(component));
  }

  static async assertNoActiveDisputeScopeOverlap({
    occurrence,
    affectedSettlementComponents,
    session,
  }) {
    if (!occurrence.activeDispute) {
      return true;
    }

    const affected = this.normalizeSettlementComponents(affectedSettlementComponents);

    const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
      occurrence,
      session,
    });

    const disputeComponents = this.normalizeSettlementComponents(
      challengeContext?.dispute?.affectedSettlementComponents || [],
      {
        allowEmpty: true,
      }
    );

    const overlappingComponents = affected.filter((component) =>
      disputeComponents.includes(component)
    );

    if (overlappingComponents.length > 0) {
      throw this.createError({
        message:
          "A professional claim cannot overlap an unresolved employer dispute on the same settlement component.",
        code: "CLAIM_DISPUTE_SETTLEMENT_SCOPE_OVERLAP",
        statusCode: 409,
        details: {
          activeDisputeId: String(occurrence.activeDispute),
          claimComponents: affected,
          disputeComponents,
          overlappingComponents,
        },
      });
    }

    return true;
  }

  /* ─────────────────────────────── ISSUE NORMALIZATION ─────────────────────────────── */

  static normalizeIssueType(value) {
    const type = String(value || "")
      .trim()
      .toLowerCase();

    if (!FINANCIAL_OCCURRENCE_CLAIM_TYPES.includes(type)) {
      throw this.createError({
        message: "Unsupported professional claim issue type.",
        code: "INVALID_OCCURRENCE_CLAIM_ISSUE_TYPE",
        details: {
          issueType: type || null,
          supportedIssueTypes: FINANCIAL_OCCURRENCE_CLAIM_TYPES,
        },
      });
    }

    return type;
  }

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

  static normalizeAttendanceCorrectionIssue({ occurrence, input }) {
    const source = input?.attendanceCorrection ?? input?.details?.attendanceCorrection;

    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw this.createError({
        message: "Attendance correction details are required.",
        code: "ATTENDANCE_CORRECTION_DETAILS_REQUIRED",
      });
    }

    if (
      input?.expectedBaseProfessionalPay !== undefined ||
      input?.details?.expectedBaseProfessionalPay !== undefined
    ) {
      throw this.createError({
        message: "attendance_correction cannot also submit an expected BASE-pay amount.",
        code: "ATTENDANCE_CORRECTION_BASE_PAY_ESTIMATE_NOT_ALLOWED",
      });
    }

    const hasCorrectedCheckInAt =
      source.correctedCheckInAt !== undefined &&
      source.correctedCheckInAt !== null &&
      source.correctedCheckInAt !== "";

    const hasCorrectedCheckOutAt =
      source.correctedCheckOutAt !== undefined &&
      source.correctedCheckOutAt !== null &&
      source.correctedCheckOutAt !== "";

    if (!hasCorrectedCheckInAt && !hasCorrectedCheckOutAt) {
      throw this.createError({
        message:
          "Please provide the check-in time, checkout time, or both that you believe should be corrected.",
        code: "ATTENDANCE_CORRECTION_TIME_REQUIRED",
      });
    }

    const correctedCheckInAt = hasCorrectedCheckInAt
      ? this.normalizeDate(source.correctedCheckInAt, "corrected check-in time")
      : null;

    const correctedCheckOutAt = hasCorrectedCheckOutAt
      ? this.normalizeDate(source.correctedCheckOutAt, "corrected checkout time")
      : null;

    const currentCheckInAt = this.getEffectiveAttendanceStart(occurrence)
      ? this.normalizeDate(this.getEffectiveAttendanceStart(occurrence), "recorded check-in time", {
          statusCode: 500,
        })
      : null;

    const currentCheckOutAt = this.getEffectiveAttendanceEnd(occurrence)
      ? this.normalizeDate(this.getEffectiveAttendanceEnd(occurrence), "recorded checkout time", {
          statusCode: 500,
        })
      : null;

    if (occurrence.status === "no_show" && (!correctedCheckInAt || !correctedCheckOutAt)) {
      throw this.createError({
        message:
          "A no-show attendance correction requires both the actual start and end times worked.",
        code: "NO_SHOW_ATTENDANCE_RANGE_REQUIRED",
      });
    }

    const resultingCheckInAt = correctedCheckInAt || currentCheckInAt;

    const resultingCheckOutAt = correctedCheckOutAt || currentCheckOutAt;

    if (resultingCheckInAt && resultingCheckOutAt && resultingCheckOutAt <= resultingCheckInAt) {
      throw this.createError({
        message:
          "Corrected checkout time must be later than the corrected or recorded check-in time.",
        code: "INVALID_ATTENDANCE_CORRECTION_RANGE",
      });
    }

    const scheduledEndAt = this.normalizeDate(occurrence.endTime, "occurrence scheduled end time", {
      statusCode: 500,
    });

    if (correctedCheckInAt && correctedCheckInAt >= scheduledEndAt) {
      throw this.createError({
        message: "Corrected check-in time must be before the scheduled end of the occurrence.",
        code: "CORRECTED_CHECKIN_AFTER_OCCURRENCE_END",
      });
    }

    const checkInActuallyChanges = Boolean(
      correctedCheckInAt &&
      (!currentCheckInAt || correctedCheckInAt.getTime() !== currentCheckInAt.getTime())
    );

    const checkOutActuallyChanges = Boolean(
      correctedCheckOutAt &&
      (!currentCheckOutAt || correctedCheckOutAt.getTime() !== currentCheckOutAt.getTime())
    );

    if (!checkInActuallyChanges && !checkOutActuallyChanges) {
      throw this.createError({
        message: "The proposed attendance correction does not change the recorded attendance.",
        code: "ATTENDANCE_CORRECTION_HAS_NO_CHANGE",
        statusCode: 409,
      });
    }

    const affectedComponents = new Set();

    if (checkInActuallyChanges) {
      affectedComponents.add("base");
    }

    if (checkOutActuallyChanges) {
      /**
       * A checkout correction can affect:
       *
       * - BASE if either side of the factual difference falls inside
       *   scheduled time; and
       * - OT if either side extends beyond scheduled end.
       *
       * This is factual scope only.
       *
       * The generic claim does not create or decide overtime.
       */
      if (
        !currentCheckOutAt ||
        currentCheckOutAt < scheduledEndAt ||
        correctedCheckOutAt < scheduledEndAt
      ) {
        affectedComponents.add("base");
      }

      if (
        (currentCheckOutAt && currentCheckOutAt > scheduledEndAt) ||
        correctedCheckOutAt > scheduledEndAt
      ) {
        affectedComponents.add("overtime");
      }
    }

    const affectedSettlementComponents = this.normalizeSettlementComponents([
      ...affectedComponents,
    ]);

    return {
      details: {
        attendanceCorrection: {
          correctedCheckInAt,
          correctedCheckOutAt,
        },
        expectedBaseProfessionalPay: null,
      },

      affectedSettlementComponents,
    };
  }

  static normalizeBaseIssue({ input, issueType }) {
    if (
      input?.attendanceCorrection !== undefined ||
      input?.details?.attendanceCorrection !== undefined
    ) {
      throw this.createError({
        message: `${issueType} cannot contain attendance-correction timestamps.`,
        code: `${this.normalizeFieldCode(issueType)}_ATTENDANCE_DETAILS_NOT_ALLOWED`,
      });
    }

    const expectedBaseProfessionalPay = this.normalizeOptionalMinorUnitAmount(
      input?.expectedBaseProfessionalPay ?? input?.details?.expectedBaseProfessionalPay,
      "expected BASE professional pay"
    );

    return {
      details: {
        attendanceCorrection: null,
        expectedBaseProfessionalPay,
      },

      affectedSettlementComponents: ["base"],
    };
  }

  static normalizeClaimIssueSubmission({ occurrence, input, professionalUserId, currentTime }) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw this.createError({
        message: "Each professional claim issue must be an object.",
        code: "INVALID_PROFESSIONAL_CLAIM_ISSUE",
      });
    }

    if (input.affectedSettlementComponents !== undefined) {
      throw this.createError({
        message: "Settlement-component scope is derived by Loqum and cannot be submitted directly.",
        code: "CLIENT_SETTLEMENT_COMPONENT_SCOPE_NOT_ALLOWED",
      });
    }

    const type = this.normalizeIssueType(input.type);

    const statement = this.normalizeText(
      input.statement,
      `${type} statement`,
      MIN_STATEMENT_LENGTH,
      MAX_STATEMENT_LENGTH
    );

    const evidence = this.normalizeEvidence(input.evidence || [], {
      submittedByRole: "professional",
      submittedByUser: professionalUserId,
      recordedAt: currentTime,
    });

    let normalizedDetails;

    if (type === "attendance_correction") {
      normalizedDetails = this.normalizeAttendanceCorrectionIssue({
        occurrence,
        input,
      });
    } else {
      normalizedDetails = this.normalizeBaseIssue({
        input,
        issueType: type,
      });
    }

    return {
      type,

      affectedSettlementComponents: normalizedDetails.affectedSettlementComponents,

      details: normalizedDetails.details,

      statement,

      evidence,

      status: "awaiting_employer_review",

      employerDecision: null,
      employerDecisionReason: null,
      employerDecidedAt: null,
      employerDecidedBy: null,
      employerCounterPosition: null,
      employerEvidence: [],

      appealStatus: "not_available",
      appealDeadlineAt: null,
      appealedAt: null,
      appealedBy: null,
      appealStatement: null,
      appealEvidence: [],

      rebuttalStatus: "not_available",
      rebuttalDeadlineAt: null,
      rebuttedAt: null,
      rebuttedBy: null,
      rebuttalStatement: null,
      rebuttalEvidence: [],

      escalatedAt: null,
      escalationReason: null,
      escalatedBy: null,
      escalationNotes: null,

      adminDecision: null,
      adminDecisionReason: null,
      adminDecidedAt: null,
      adminDecidedBy: null,
      adminOutcome: null,
      adminEvidence: [],

      resolvedAt: null,
    };
  }

  static normalizeClaimIssues({ occurrence, issues, professionalUserId, currentTime }) {
    if (!Array.isArray(issues) || issues.length === 0) {
      throw this.createError({
        message: "At least one professional claim issue is required.",
        code: "PROFESSIONAL_CLAIM_ISSUES_REQUIRED",
      });
    }

    if (issues.length > FINANCIAL_OCCURRENCE_CLAIM_TYPES.length) {
      throw this.createError({
        message: "A professional claim cannot contain more than three ordinary issues.",
        code: "TOO_MANY_PROFESSIONAL_CLAIM_ISSUES",
      });
    }

    const normalizedIssues = issues.map((input) =>
      this.normalizeClaimIssueSubmission({
        occurrence,
        input,
        professionalUserId,
        currentTime,
      })
    );

    const issueTypes = normalizedIssues.map((issue) => issue.type);

    if (issueTypes.length !== new Set(issueTypes).size) {
      throw this.createError({
        message: "A professional claim cannot contain duplicate issue types.",
        code: "DUPLICATE_PROFESSIONAL_CLAIM_ISSUE",
      });
    }

    return FINANCIAL_OCCURRENCE_CLAIM_TYPES.filter((type) => issueTypes.includes(type)).map(
      (type) => normalizedIssues.find((issue) => issue.type === type)
    );
  }

  /* ─────────────────────────────── CLAIMABILITY ─────────────────────────────── */

  static hasReviewableProfessionalAmount(value) {
    try {
      money.normalizeMinorUnitAmount(value, "Reviewable professional amount");

      return true;
    } catch (error) {
      return false;
    }
  }

  static hasReviewableBaseCalculation(occurrence) {
    if (occurrence.activeWorkCancellation?.occurred === true) {
      return this.hasReviewableProfessionalAmount(
        occurrence.activeWorkCancellation.professionalPay
      );
    }

    if (occurrence.cancellationCompensation?.applicable === true) {
      return this.hasReviewableProfessionalAmount(
        occurrence.cancellationCompensation.professionalPay
      );
    }

    return Boolean(
      occurrence.baseBillableHours !== null &&
      occurrence.baseBillableHours !== undefined &&
      this.hasReviewableProfessionalAmount(occurrence.baseProfessionalPay)
    );
  }

  static assertAffectedSettlementComponentsChallengeable({
    occurrence,
    affectedSettlementComponents,
  }) {
    const affected = this.normalizeSettlementComponents(affectedSettlementComponents);

    const available = this.getChallengeableSettlementComponents(occurrence);

    for (const component of affected) {
      if (!available.includes(component)) {
        throw this.createError({
          message:
            component === "base"
              ? "Regular Shift pay is no longer available for ordinary challenge."
              : "Overtime is no longer available to this ordinary factual challenge.",
          code:
            component === "base"
              ? "BASE_COMPONENT_NOT_CHALLENGEABLE"
              : "OVERTIME_COMPONENT_NOT_CHALLENGEABLE",
          statusCode: 409,
          details: {
            requestedComponent: component,
            challengeableSettlementComponents: available,
          },
        });
      }

      const auditPath = component === "base" ? "baseSettlement" : "overtimeSettlement";

      const componentStatus = occurrence[auditPath]?.status || "not_due";

      if (PAYOUT_EXECUTION_STATUSES.includes(componentStatus)) {
        throw this.createError({
          message:
            component === "base"
              ? "Regular Shift pay has already become payout-final."
              : "Overtime pay has already become payout-final.",
          code:
            component === "base"
              ? "BASE_SETTLEMENT_RELEASE_ALREADY_STARTED"
              : "OVERTIME_SETTLEMENT_RELEASE_ALREADY_STARTED",
          statusCode: 409,
        });
      }

      if (component === "overtime" && occurrence.overtime?.status === "approved") {
        throw this.createError({
          message:
            "Final approved overtime cannot be reopened through the ordinary claim workflow.",
          code: "APPROVED_OVERTIME_ALREADY_FINAL",
          statusCode: 409,
        });
      }
    }

    return true;
  }

  static assertOccurrenceIsClaimable({ shift, occurrence, issues }) {
    if (!shift.publishedAt || shift.paymentStatus === "unpaid" || Number(shift.fundedAmount) <= 0) {
      throw this.createError({
        message: "An unfunded occurrence cannot receive a professional claim.",
        code: "UNFUNDED_OCCURRENCE_NOT_CLAIMABLE",
        statusCode: 409,
      });
    }

    if (
      occurrence.assignmentStatus === "expired_unfilled" ||
      occurrence.status === "expired_unfilled"
    ) {
      throw this.createError({
        message: "An expired-unfilled occurrence has no professional claim opportunity.",
        code: "EXPIRED_UNFILLED_OCCURRENCE_NOT_CLAIMABLE",
        statusCode: 409,
      });
    }

    if (
      !occurrence.assignment ||
      !occurrence.assignedProfessional ||
      !occurrence.assignedAt ||
      occurrence.assignmentStatus !== "assigned"
    ) {
      throw this.createError({
        message: "Only an assigned occurrence can receive a professional claim.",
        code: "UNASSIGNED_OCCURRENCE_NOT_CLAIMABLE",
        statusCode: 409,
      });
    }

    for (const issue of issues) {
      this.assertAffectedSettlementComponentsChallengeable({
        occurrence,
        affectedSettlementComponents: issue.affectedSettlementComponents,
      });

      if (issue.type === "attendance_correction") {
        const validAttendanceOutcome = ["checked_out", "no_show", "disputed"].includes(
          occurrence.attendanceStatus
        );

        if (!validAttendanceOutcome) {
          throw this.createError({
            message: "No contestable attendance outcome exists for this occurrence.",
            code: "ATTENDANCE_OUTCOME_NOT_AVAILABLE",
            statusCode: 409,
          });
        }
      }

      if (issue.type === "payment_calculation") {
        if (occurrence.status === "no_show") {
          throw this.createError({
            message:
              "A confirmed no-show has no professional BASE payment calculation to challenge.",
            code: "PAYMENT_CALCULATION_NOT_AVAILABLE",
            statusCode: 409,
          });
        }

        if (!this.hasReviewableBaseCalculation(occurrence)) {
          throw this.createError({
            message: "No reviewable regular Shift pay calculation exists for this occurrence.",
            code: "BASE_PAYMENT_CALCULATION_NOT_AVAILABLE",
            statusCode: 409,
          });
        }
      }
    }

    return true;
  }

  /* ─────────────────────────────── SHARED WINDOW VALIDATION ─────────────────────────────── */

  static getOpenOccurrenceClaimWindow({ occurrence, currentTime, affectedSettlementComponents }) {
    const now = this.normalizeCurrentTime(currentTime);

    const affected = this.normalizeSettlementComponents(affectedSettlementComponents);

    if (!occurrence.challengeWindowOpenedAt || !occurrence.challengeDeadlineAt) {
      throw this.createError({
        message:
          "This occurrence does not currently have an available ordinary challenge opportunity.",
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

    /**
     * activeDispute is not automatically prohibited here.
     *
     * Employer and professional original cases may coexist only when their
     * unresolved settlement-component scopes do not overlap. Submission
     * validates that component boundary separately.
     */
    if (occurrence.activeClaim) {
      throw this.createError({
        message: "A professional claim is already active for this occurrence.",
        code: "OCCURRENCE_ACTIVE_PROFESSIONAL_CLAIM_ALREADY_EXISTS",
        statusCode: 409,
        details: {
          activeClaimId: String(occurrence.activeClaim),
        },
      });
    }

    if (occurrence.challengeWindowClosedAt) {
      throw this.createError({
        message: "The occurrence's ordinary challenge window has already closed.",
        code: "OCCURRENCE_CHALLENGE_WINDOW_ALREADY_CLOSED",
        statusCode: 409,
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

    const challengeable = this.getChallengeableSettlementComponents(occurrence);

    const unavailable = affected.filter((component) => !challengeable.includes(component));

    if (unavailable.length > 0) {
      throw this.createError({
        message: "One or more issue components are no longer available for ordinary challenge.",
        code: "CLAIM_COMPONENT_NOT_CHALLENGEABLE",
        statusCode: 409,
        details: {
          requestedComponents: affected,
          challengeableSettlementComponents: challengeable,
          unavailableComponents: unavailable,
        },
      });
    }

    return {
      challengeWindowOpenedAt: openedAt,
      challengeDeadlineAt: deadlineAt,
      affectedSettlementComponents: affected,
    };
  }

  /* ─────────────────────────────── SNAPSHOT ─────────────────────────────── */

  static buildLifecycleSnapshot(occurrence) {
    return SNAPSHOT_FIELDS.reduce((snapshot, field) => {
      snapshot[field] = this.cloneStateValue(occurrence.get(field));

      return snapshot;
    }, {});
  }

  /* ─────────────────────────────── IDEMPOTENCY ─────────────────────────────── */

  static getComparableDate(value) {
    if (!value) {
      return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }

  static buildIssueSubmissionSignature(issue) {
    const details = issue?.details || {};

    const attendanceCorrection = details.attendanceCorrection || null;

    return {
      type: String(issue?.type || ""),

      affectedSettlementComponents: this.normalizeSettlementComponents(
        Array.from(issue?.affectedSettlementComponents || [])
      ),

      details: {
        attendanceCorrection: attendanceCorrection
          ? {
              correctedCheckInAt: this.getComparableDate(attendanceCorrection.correctedCheckInAt),

              correctedCheckOutAt: this.getComparableDate(attendanceCorrection.correctedCheckOutAt),
            }
          : null,

        expectedBaseProfessionalPay: details.expectedBaseProfessionalPay ?? null,
      },

      statement: String(issue?.statement || "").trim(),

      evidence: Array.from(issue?.evidence || []).map((item) => ({
        type: String(item?.type || ""),

        reference: String(item?.reference || "").trim(),

        description: item?.description ? String(item.description).trim() : null,
      })),
    };
  }

  static assertIdempotentClaimMatchesRequest({
    claim,
    shiftId,
    occurrenceId,
    professionalId,
    submittedByUserId,
    normalizedIssues,
  }) {
    const shift = this.normalizeObjectId(shiftId, "shift ID");

    const occurrence = this.normalizeObjectId(occurrenceId, "occurrence ID");

    const professional = this.normalizeObjectId(professionalId, "professional profile ID");

    const submittedByUser = this.normalizeObjectId(submittedByUserId, "submitting user ID");

    if (
      String(claim.shift) !== String(shift) ||
      String(claim.occurrence) !== String(occurrence) ||
      String(claim.professional) !== String(professional) ||
      String(claim.submittedByUser) !== String(submittedByUser)
    ) {
      throw this.createError({
        message:
          "This idempotency key has already been used for a different occurrence claim request.",
        code: "CLAIM_IDEMPOTENCY_KEY_CONFLICT",
        statusCode: 409,
        details: {
          existingClaimId: String(claim._id),
        },
      });
    }

    const existingSignatures = Array.from(claim.issues || [])
      .map((issue) => this.buildIssueSubmissionSignature(issue))
      .sort(
        (left, right) =>
          FINANCIAL_OCCURRENCE_CLAIM_TYPES.indexOf(left.type) -
          FINANCIAL_OCCURRENCE_CLAIM_TYPES.indexOf(right.type)
      );

    const requestedSignatures = normalizedIssues
      .map((issue) => this.buildIssueSubmissionSignature(issue))
      .sort(
        (left, right) =>
          FINANCIAL_OCCURRENCE_CLAIM_TYPES.indexOf(left.type) -
          FINANCIAL_OCCURRENCE_CLAIM_TYPES.indexOf(right.type)
      );

    if (JSON.stringify(existingSignatures) !== JSON.stringify(requestedSignatures)) {
      throw this.createError({
        message:
          "This idempotency key has already been used for a different professional claim issue set.",
        code: "CLAIM_IDEMPOTENCY_KEY_CONFLICT",
        statusCode: 409,
        details: {
          existingClaimId: String(claim._id),
        },
      });
    }

    return claim;
  }

  /* ─────────────────────────────── ACTIVE CLAIM POINTER ─────────────────────────────── */

  static async activateClaimCase({
    occurrence,
    claim,
    currentTime,
    affectedSettlementComponents,
    session,
  }) {
    const affected = this.normalizeSettlementComponents(affectedSettlementComponents);

    /**
     * Atomic professional-side original-case claim.
     *
     * activeDispute is intentionally absent from the filter.
     *
     * A professional claim and employer dispute may coexist after the
     * submission path has established that their settlement-component scopes
     * are disjoint.
     *
     * The shared ordinary window and its component list remain untouched.
     */
    const result = await ShiftOccurrence.updateOne(
      {
        _id: occurrence._id,
        shift: occurrence.shift,

        activeClaim: null,

        activeDispute: occurrence.activeDispute || null,

        challengeWindowClosedAt: null,

        challengeWindowOpenedAt: {
          $lte: currentTime,
        },

        challengeDeadlineAt: {
          $gt: currentTime,
        },

        challengeableSettlementComponents: {
          $all: affected,
        },
      },
      {
        $set: {
          activeClaim: claim._id,
          settlementStatus: "disputed",
        },
      },
      {
        session,
      }
    );

    if (result.modifiedCount !== 1) {
      throw this.createError({
        message: "The occurrence changed before the professional claim could be activated.",
        code: "PROFESSIONAL_CLAIM_ACTIVATION_CONFLICT",
        statusCode: 409,
      });
    }

    occurrence.activeClaim = claim._id;

    occurrence.settlementStatus = "disputed";

    return occurrence;
  }

  static assertClaimIsActiveOnOccurrence({ claim, occurrence }) {
    /**
     * activeDispute may coexist and is not an error.
     */
    if (!occurrence.activeClaim || !this.sameId(occurrence.activeClaim, claim._id)) {
      throw this.createError({
        message: "This professional claim is no longer active on the occurrence.",
        code: "CLAIM_NOT_ACTIVE_ON_OCCURRENCE",
        statusCode: 409,
      });
    }

    return true;
  }

  static clearActiveClaim({ claim, occurrence }) {
    this.assertClaimIsActiveOnOccurrence({
      claim,
      occurrence,
    });

    occurrence.activeClaim = null;

    /**
     * Do not:
     *
     * - clear activeDispute;
     * - close the shared window; or
     * - clear challengeableSettlementComponents.
     */
    return occurrence;
  }

  /* ─────────────────────────────── EMPLOYER COUNTER-POSITION ─────────────────────────────── */

  static normalizeEmployerCounterPosition({ issue, occurrence, counterPosition }) {
    if (counterPosition === null || counterPosition === undefined) {
      return null;
    }

    if (typeof counterPosition !== "object" || Array.isArray(counterPosition)) {
      throw this.createError({
        message: "Employer counter-position must be an object.",
        code: "INVALID_EMPLOYER_COUNTER_POSITION",
      });
    }

    const hasCheckIn =
      counterPosition.correctedCheckInAt !== undefined &&
      counterPosition.correctedCheckInAt !== null &&
      counterPosition.correctedCheckInAt !== "";

    const hasCheckOut =
      counterPosition.correctedCheckOutAt !== undefined &&
      counterPosition.correctedCheckOutAt !== null &&
      counterPosition.correctedCheckOutAt !== "";

    const hasProposedBasePay =
      counterPosition.proposedBaseProfessionalPay !== undefined &&
      counterPosition.proposedBaseProfessionalPay !== null &&
      counterPosition.proposedBaseProfessionalPay !== "";

    if (!hasCheckIn && !hasCheckOut && !hasProposedBasePay) {
      return null;
    }

    if (issue.type === "attendance_correction") {
      if (hasProposedBasePay) {
        throw this.createError({
          message:
            "An attendance-correction counter-position must state attendance facts, not a replacement BASE-pay amount.",
          code: "ATTENDANCE_COUNTER_POSITION_BASE_PAY_NOT_ALLOWED",
        });
      }

      const correctedCheckInAt = hasCheckIn
        ? this.normalizeDate(counterPosition.correctedCheckInAt, "employer corrected check-in time")
        : null;

      const correctedCheckOutAt = hasCheckOut
        ? this.normalizeDate(
            counterPosition.correctedCheckOutAt,
            "employer corrected checkout time"
          )
        : null;

      const currentStart = this.getEffectiveAttendanceStart(occurrence)
        ? this.normalizeDate(
            this.getEffectiveAttendanceStart(occurrence),
            "recorded check-in time",
            {
              statusCode: 500,
            }
          )
        : null;

      const currentEnd = this.getEffectiveAttendanceEnd(occurrence)
        ? this.normalizeDate(this.getEffectiveAttendanceEnd(occurrence), "recorded checkout time", {
            statusCode: 500,
          })
        : null;

      const resultingStart = correctedCheckInAt || currentStart;

      const resultingEnd = correctedCheckOutAt || currentEnd;

      if (resultingStart && resultingEnd && resultingEnd <= resultingStart) {
        throw this.createError({
          message: "Employer counter-position checkout must be later than check-in.",
          code: "INVALID_EMPLOYER_ATTENDANCE_COUNTER_POSITION",
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
        message:
          "Attendance timestamps may only be used when responding to an attendance_correction issue.",
        code: "EMPLOYER_ATTENDANCE_COUNTER_POSITION_NOT_ALLOWED",
      });
    }

    return {
      correctedCheckInAt: null,
      correctedCheckOutAt: null,

      proposedBaseProfessionalPay: this.normalizeOptionalMinorUnitAmount(
        counterPosition.proposedBaseProfessionalPay,
        "employer proposed BASE professional pay"
      ),
    };
  }

  /* ─────────────────────────────── CASE FINALITY ─────────────────────────────── */

  static synchronizeClaimCaseFinality({ claim, occurrence, currentTime }) {
    const unresolvedIssues = Array.from(claim.issues || []).filter(
      (issue) => issue.status !== "resolved"
    );

    if (unresolvedIssues.length > 0) {
      claim.status = "active";
      claim.resolvedAt = null;

      return {
        caseResolved: false,
        unresolvedIssueCount: unresolvedIssues.length,
        unresolvedAffectedSettlementComponents:
          this.getUnresolvedAffectedSettlementComponents(claim),
      };
    }

    const resolutionDates = Array.from(claim.issues || [])
      .map((issue) => issue.resolvedAt)
      .filter(Boolean)
      .map((date) => new Date(date))
      .filter((date) => !Number.isNaN(date.getTime()));

    const latestIssueResolution =
      resolutionDates.slice().sort((left, right) => right.getTime() - left.getTime())[0] ||
      currentTime;

    claim.status = "resolved";
    claim.resolvedAt = latestIssueResolution;

    this.clearActiveClaim({
      claim,
      occurrence,
    });

    return {
      caseResolved: true,
      unresolvedIssueCount: 0,
      unresolvedAffectedSettlementComponents: [],
    };
  }

  static async synchronizeOccurrenceSettlementSummary({ occurrence, currentTime, session }) {
    ShiftSettlementService.synchronizeExpiredChallengeWindow({
      occurrence,
      currentTime,
    });

    const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
      occurrence,
      session,
    });

    ShiftSettlementService.synchronizeOverallSettlementState({
      occurrence,
      currentTime,
      challengeContext,
    });

    return {
      occurrence,
      challengeContext,
    };
  }

  /* ─────────────────────────────── FINAL ISSUE OUTCOME HANDOFF ─────────────────────────────── */

  static async applyProfessionalClaimIssueOutcome({
    claim,
    issue,
    occurrence,
    decision,
    finalizationReason,
    resolvedByUser,
    currentTime,
    session,
  }) {
    /**
     * #12 CONTRACT
     *
     * ShiftOccurrenceResolutionService will implement this exact method.
     *
     * It owns:
     *
     * - applying final attendance facts;
     * - recalculating affected BASE entitlement;
     * - preserving OT-domain authority;
     * - resetting affected payout readiness where required; and
     * - preventing expansion beyond this issue's immutable component scope.
     *
     * This claim service owns only the case workflow around that outcome.
     */
    return ShiftOccurrenceResolutionService.applyProfessionalClaimIssueOutcome(
      {
        claim,
        issue,
        occurrence,

        decision,

        finalizationReason,

        resolvedByUser,

        currentTime,
      },
      {
        session,
      }
    );
  }

  /* ─────────────────────────────── SUBMISSION ─────────────────────────────── */

  static async submitClaim(
    {
      shiftId,
      occurrenceId,

      professionalId,
      submittedByUserId,

      issues,

      idempotencyKey,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    const cleanIdempotencyKey = String(idempotencyKey || "").trim();

    if (!cleanIdempotencyKey) {
      throw this.createError({
        message: "Idempotency key is required to submit an occurrence claim.",
        code: "CLAIM_IDEMPOTENCY_KEY_REQUIRED",
      });
    }

    return this.runWithOptionalTransaction(options, async (session) => {
      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId,
        occurrenceId,
        session,
      });

      const professionalObjectId = this.assertProfessionalOwnsOccurrence({
        occurrence,
        professionalId,
      });

      const { user: submittedByUser } = await this.assertUserOwnsProfessionalProfile({
        professionalId: professionalObjectId,
        userId: submittedByUserId,
        session,
      });

      const normalizedIssues = this.normalizeClaimIssues({
        occurrence,
        issues,
        professionalUserId: submittedByUser,
        currentTime: now,
      });

      const aggregateAffectedSettlementComponents =
        this.getAggregateAffectedSettlementComponents(normalizedIssues);

      const existingIdempotentClaim = await ShiftOccurrenceClaim.findOne({
        idempotencyKey: cleanIdempotencyKey,
      }).session(session);

      if (existingIdempotentClaim) {
        this.assertIdempotentClaimMatchesRequest({
          claim: existingIdempotentClaim,
          shiftId,
          occurrenceId,
          professionalId,
          submittedByUserId,
          normalizedIssues,
        });

        return {
          claim: existingIdempotentClaim,
          occurrence,
          created: false,
          idempotent: true,
        };
      }

      /**
       * One original professional claim case per occurrence.
       *
       * Withdrawal does not recreate another professional claim right.
       */
      const existingClaim = await ShiftOccurrenceClaim.findOne({
        occurrence: occurrence._id,
      }).session(session);

      if (existingClaim) {
        throw this.createError({
          message: "A professional claim case has already been submitted for this occurrence.",
          code: "ORIGINAL_OCCURRENCE_CLAIM_ALREADY_EXISTS",
          statusCode: 409,
          details: {
            claimId: String(existingClaim._id),
            status: existingClaim.status,
          },
        });
      }

      this.assertOccurrenceIsClaimable({
        shift,
        occurrence,
        issues: normalizedIssues,
      });

      const { challengeWindowOpenedAt, challengeDeadlineAt } = this.getOpenOccurrenceClaimWindow({
        occurrence,
        currentTime: now,
        affectedSettlementComponents: aggregateAffectedSettlementComponents,
      });

      await this.assertNoActiveDisputeScopeOverlap({
        occurrence,
        affectedSettlementComponents: aggregateAffectedSettlementComponents,
        session,
      });

      const settings = await this.getPlatformSettings(session);

      const employerResponseHours = this.normalizePositiveSetting(
        settings.employerClaimResponseHours,
        "employerClaimResponseHours"
      );

      const employerResponseDeadlineAt = this.addHours(now, employerResponseHours);

      const submittedIssueTypes = FINANCIAL_OCCURRENCE_CLAIM_TYPES.filter((type) =>
        normalizedIssues.some((issue) => issue.type === type)
      );

      const [claim] = await ShiftOccurrenceClaim.create(
        [
          {
            referenceCode: generateReference("LQ-CLM"),

            idempotencyKey: cleanIdempotencyKey,

            shift: shift._id,

            occurrence: occurrence._id,

            assignment: occurrence.assignment,

            business: occurrence.business,

            branch: occurrence.branch,

            professional: professionalObjectId,

            submittedByUser,

            submittedIssueTypes,

            issues: normalizedIssues,

            submittedAt: now,

            challengeWindowOpenedAt,

            challengeDeadlineAt,

            employerResponseDeadlineAt,

            lifecycleSnapshot: this.buildLifecycleSnapshot(occurrence),

            status: "active",

            employerRefund: aggregateAffectedSettlementComponents.includes("base")
              ? occurrence.employerRefund || null
              : null,

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

      await this.activateClaimCase({
        occurrence,
        claim,
        currentTime: now,
        affectedSettlementComponents: aggregateAffectedSettlementComponents,
        session,
      });

      await claim.save({
        session,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Professional occurrence claim ${claim.referenceCode} created with ${claim.issues.length} issue(s)`
      );

      return {
        claim,
        occurrence,
        shift,

        created: true,
        idempotent: false,

        submittedIssueTypes,

        affectedSettlementComponents: aggregateAffectedSettlementComponents,

        employerResponseDeadlineAt,
      };
    });
  }

  /* ─────────────────────────────── EMPLOYER ISSUE REVIEW ─────────────────────────────── */

  static normalizeEmployerDecision(value) {
    const decision = String(value || "")
      .trim()
      .toLowerCase();

    if (!EMPLOYER_FINANCIAL_CLAIM_DECISIONS.includes(decision)) {
      throw this.createError({
        message: "Claim issue decision must be approved or rejected.",
        code: "INVALID_EMPLOYER_CLAIM_ISSUE_DECISION",
      });
    }

    return decision;
  }

  static async reviewClaimByEmployer(
    {
      claimId,
      issueId,

      employerProfileId,
      employerUserId,
      employerContext,

      decision,
      reason,

      counterPosition = null,
      evidence = [],

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      if (claim.status !== "active") {
        throw this.createError({
          message: "This professional claim case is no longer active.",
          code: "CLAIM_CASE_NOT_ACTIVE",
          statusCode: 409,
        });
      }

      this.assertEmployerCanReviewClaim({
        claim,
        employerProfileId,
        employerContext,
      });

      const employerUser = this.normalizeObjectId(employerUserId, "employer user ID");

      if (!claim.employerResponseDeadlineAt) {
        throw this.createError({
          message: "The claim is missing its employer response deadline.",
          code: "CLAIM_EMPLOYER_RESPONSE_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      const employerDeadline = this.normalizeDate(
        claim.employerResponseDeadlineAt,
        "employer response deadline",
        {
          statusCode: 500,
        }
      );

      if (now >= employerDeadline) {
        throw this.createError({
          message:
            "The employer response period has ended. Any undecided issue now requires admin review.",
          code: "EMPLOYER_CLAIM_RESPONSE_WINDOW_CLOSED",
          statusCode: 409,
          details: {
            employerResponseDeadlineAt: employerDeadline,
          },
        });
      }

      const issue = this.getClaimIssue(claim, issueId);

      if (issue.status !== "awaiting_employer_review") {
        throw this.createError({
          message: "This claim issue is not awaiting employer review.",
          code: "CLAIM_ISSUE_NOT_AWAITING_EMPLOYER_REVIEW",
          statusCode: 409,
          details: {
            issueId: String(issue._id),
            issueStatus: issue.status,
          },
        });
      }

      const normalizedDecision = this.normalizeEmployerDecision(decision);

      const cleanReason = this.normalizeText(
        reason,
        "Employer decision reason",
        MIN_REASON_LENGTH,
        MAX_EMPLOYER_DECISION_REASON_LENGTH
      );

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      const normalizedCounterPosition =
        normalizedDecision === "rejected"
          ? this.normalizeEmployerCounterPosition({
              issue,
              occurrence,
              counterPosition,
            })
          : null;

      if (
        normalizedDecision === "approved" &&
        counterPosition !== null &&
        counterPosition !== undefined
      ) {
        const hasCounterValue =
          typeof counterPosition === "object" &&
          !Array.isArray(counterPosition) &&
          Object.values(counterPosition).some(
            (value) => value !== null && value !== undefined && value !== ""
          );

        if (hasCounterValue) {
          throw this.createError({
            message: "An approved issue cannot contain a different employer counter-position.",
            code: "APPROVED_CLAIM_ISSUE_COUNTER_POSITION_NOT_ALLOWED",
          });
        }
      }

      const normalizedEvidence = this.normalizeEvidence(evidence, {
        submittedByRole: "employer",
        submittedByUser: employerUser,
        recordedAt: now,
      });

      if (normalizedDecision === "rejected" && normalizedCounterPosition) {
        if (!Array.isArray(issue.evidence) || issue.evidence.length === 0) {
          throw this.createError({
            message:
              "An adverse employer counter-position requires the professional's original claim issue to contain supporting evidence.",
            code: "COUNTER_POSITION_REQUIRES_PROFESSIONAL_EVIDENCE",
            statusCode: 409,
          });
        }

        if (normalizedEvidence.length === 0) {
          throw this.createError({
            message: "An employer counter-position requires supporting employer evidence.",
            code: "EMPLOYER_COUNTER_POSITION_EVIDENCE_REQUIRED",
          });
        }
      }

      issue.employerDecision = normalizedDecision;

      issue.employerDecisionReason = cleanReason;

      issue.employerDecidedAt = now;

      issue.employerDecidedBy = employerUser;

      issue.employerCounterPosition = normalizedCounterPosition;

      issue.employerEvidence = normalizedEvidence;

      if (normalizedDecision === "rejected" && !normalizedCounterPosition) {
        const settings = await this.getPlatformSettings(session);

        const appealHours = this.normalizePositiveSetting(
          settings.professionalAppealWindowHours,
          "professionalAppealWindowHours"
        );

        issue.status = "awaiting_professional_appeal";

        issue.appealStatus = "available";

        issue.appealDeadlineAt = this.addHours(now, appealHours);

        issue.appealedAt = null;
        issue.appealedBy = null;
        issue.appealStatement = null;
        issue.appealEvidence = [];

        issue.escalatedAt = null;
        issue.escalationReason = null;
        issue.escalatedBy = null;
        issue.escalationNotes = null;

        issue.resolvedAt = null;

        await claim.save({
          session,
        });

        return {
          claim,
          issue,
          occurrence,
          shift,

          resolved: false,

          issueResolved: false,
          caseResolved: false,

          appealAvailable: true,

          appealDeadlineAt: issue.appealDeadlineAt,

          employerCounterPosition: normalizedCounterPosition,
        };
      }

      if (normalizedDecision === "rejected" && normalizedCounterPosition) {
        const settings = await this.getPlatformSettings(session);

        const rebuttalHours = this.normalizePositiveSetting(
          settings.professionalRebuttalWindowHours,
          "professionalRebuttalWindowHours"
        );

        issue.status = "awaiting_professional_rebuttal";

        issue.rebuttalStatus = "available";

        issue.rebuttalDeadlineAt = this.addHours(now, rebuttalHours);

        issue.rebuttedAt = null;
        issue.rebuttedBy = null;
        issue.rebuttalStatement = null;
        issue.rebuttalEvidence = [];

        issue.appealStatus = "not_available";
        issue.appealDeadlineAt = null;

        issue.appealedAt = null;
        issue.appealedBy = null;
        issue.appealStatement = null;
        issue.appealEvidence = [];

        issue.escalatedAt = null;
        issue.escalationReason = null;
        issue.escalatedBy = null;
        issue.escalationNotes = null;

        issue.resolvedAt = null;

        await claim.save({
          session,
        });

        return {
          claim,
          issue,
          occurrence,
          shift,

          resolved: false,

          issueResolved: false,
          caseResolved: false,

          rebuttalAvailable: true,

          rebuttalDeadlineAt: issue.rebuttalDeadlineAt,

          employerCounterPosition: normalizedCounterPosition,
        };
      }

      /**
       * Employer approval accepts the professional's submitted issue
       * position.
       *
       * The resolution service converts that accepted position into final
       * authoritative occurrence facts and BASE entitlement.
       */
      const resolutionResult = await this.applyProfessionalClaimIssueOutcome({
        claim,
        issue,
        occurrence,

        decision: "approved",

        finalizationReason: "employer_approval",

        resolvedByUser: employerUser,

        currentTime: now,

        session,
      });

      issue.status = "resolved";
      issue.appealStatus = "not_available";
      issue.appealDeadlineAt = null;
      issue.resolvedAt = now;

      const caseFinality = this.synchronizeClaimCaseFinality({
        claim,
        occurrence,
        currentTime: now,
      });

      /**
       * Persist issue/case finality before settlement derives live unresolved
       * claim scope from the database.
       */
      await claim.save({
        session,
      });

      const settlementSummary = await this.synchronizeOccurrenceSettlementSummary({
        occurrence,
        currentTime: now,
        session,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Employer approved ${issue.type} issue ${issue._id} on claim ${claim.referenceCode}`
      );

      return {
        claim,
        issue,
        occurrence,
        shift,

        resolved: true,

        issueResolved: true,
        caseResolved: caseFinality.caseResolved,

        appealAvailable: false,

        resolutionResult,

        settlementSummary,
      };
    });
  }
  /* ─────────────────────────────── PROFESSIONAL ISSUE APPEAL ─────────────────────────────── */

  static async submitAppeal(
    {
      claimId,
      issueId,

      professionalId,
      submittedByUserId,

      statement,
      evidence = [],

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      if (claim.status !== "active") {
        throw this.createError({
          message: "This professional claim case is no longer active.",
          code: "CLAIM_CASE_NOT_ACTIVE",
          statusCode: 409,
        });
      }

      const issue = this.getClaimIssue(claim, issueId);

      if (issue.status !== "awaiting_professional_appeal" || issue.appealStatus !== "available") {
        throw this.createError({
          message: "No professional appeal is available for this claim issue.",
          code: "CLAIM_ISSUE_APPEAL_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      const { professional, user: submittedByUser } = await this.assertUserOwnsProfessionalProfile({
        professionalId,
        userId: submittedByUserId,
        session,
      });

      if (String(claim.professional) !== String(professional)) {
        throw this.createError({
          message: "The professional cannot appeal this claim issue.",
          code: "PROFESSIONAL_CANNOT_APPEAL_CLAIM_ISSUE",
          statusCode: 403,
        });
      }

      if (!issue.appealDeadlineAt) {
        throw this.createError({
          message: "The claim issue is missing its appeal deadline.",
          code: "CLAIM_ISSUE_APPEAL_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      const appealDeadlineAt = this.normalizeDate(issue.appealDeadlineAt, "appeal deadline", {
        statusCode: 500,
      });

      if (now >= appealDeadlineAt) {
        throw this.createError({
          message: "The appeal window for this claim issue has closed.",
          code: "CLAIM_ISSUE_APPEAL_WINDOW_CLOSED",
          statusCode: 409,
          details: {
            appealDeadlineAt,
          },
        });
      }

      const { occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      issue.status = "awaiting_admin_review";

      issue.appealStatus = "submitted";

      issue.appealedAt = now;
      issue.appealedBy = submittedByUser;

      issue.appealStatement = this.normalizeText(
        statement,
        "Appeal statement",
        MIN_STATEMENT_LENGTH,
        MAX_STATEMENT_LENGTH
      );

      issue.appealEvidence = this.normalizeEvidence(evidence, {
        submittedByRole: "professional",
        submittedByUser,
        recordedAt: now,
      });

      issue.escalatedAt = now;
      issue.escalationReason = "professional_appeal";
      issue.escalatedBy = submittedByUser;
      issue.escalationNotes = null;

      await claim.save({
        session,
      });

      logger.info(
        `Professional appealed ${issue.type} issue ${issue._id} on claim ${claim.referenceCode}`
      );

      return {
        claim,
        issue,

        submitted: true,

        issueStatus: issue.status,

        finalAdminReviewRequired: true,
      };
    });
  }

  /* ─────────────────────────────── PROFESSIONAL ISSUE REBUTTAL ─────────────────────────────── */

  static async submitRebuttal(
    {
      claimId,
      issueId,

      professionalId,
      submittedByUserId,

      statement,
      evidence = [],

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      if (claim.status !== "active") {
        throw this.createError({
          message: "This professional claim case is no longer active.",
          code: "CLAIM_CASE_NOT_ACTIVE",
          statusCode: 409,
        });
      }

      const issue = this.getClaimIssue(claim, issueId);

      if (
        issue.status !== "awaiting_professional_rebuttal" ||
        issue.rebuttalStatus !== "available"
      ) {
        throw this.createError({
          message: "No professional rebuttal is available for this claim issue.",
          code: "CLAIM_ISSUE_REBUTTAL_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      if (issue.employerDecision !== "rejected" || !issue.employerCounterPosition) {
        throw this.createError({
          message:
            "A professional rebuttal requires a rejected claim issue with an employer counter-position.",
          code: "CLAIM_ISSUE_REBUTTAL_CONTEXT_INVALID",
          statusCode: 409,
        });
      }

      const { professional, user: submittedByUser } = await this.assertUserOwnsProfessionalProfile({
        professionalId,
        userId: submittedByUserId,
        session,
      });

      if (String(claim.professional) !== String(professional)) {
        throw this.createError({
          message: "The professional cannot rebut this claim issue.",
          code: "PROFESSIONAL_CANNOT_REBUT_CLAIM_ISSUE",
          statusCode: 403,
        });
      }

      if (!issue.rebuttalDeadlineAt) {
        throw this.createError({
          message: "The claim issue is missing its rebuttal deadline.",
          code: "CLAIM_ISSUE_REBUTTAL_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      const rebuttalDeadlineAt = this.normalizeDate(issue.rebuttalDeadlineAt, "rebuttal deadline", {
        statusCode: 500,
      });

      if (now >= rebuttalDeadlineAt) {
        throw this.createError({
          message: "The rebuttal window for this claim issue has closed.",
          code: "CLAIM_ISSUE_REBUTTAL_WINDOW_CLOSED",
          statusCode: 409,
          details: {
            rebuttalDeadlineAt,
          },
        });
      }

      const cleanStatement = this.normalizeText(
        statement,
        "Rebuttal statement",
        MIN_STATEMENT_LENGTH,
        MAX_STATEMENT_LENGTH
      );

      const normalizedEvidence = this.normalizeEvidence(evidence, {
        submittedByRole: "professional",
        submittedByUser,
        recordedAt: now,
      });

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      issue.status = "awaiting_admin_review";

      issue.rebuttalStatus = "submitted";

      issue.rebuttedAt = now;
      issue.rebuttedBy = submittedByUser;

      issue.rebuttalStatement = cleanStatement;
      issue.rebuttalEvidence = normalizedEvidence;

      issue.appealStatus = "not_available";
      issue.appealDeadlineAt = null;

      issue.appealedAt = null;
      issue.appealedBy = null;
      issue.appealStatement = null;
      issue.appealEvidence = [];

      issue.escalatedAt = now;
      issue.escalationReason = "employer_counter_position";
      issue.escalatedBy = submittedByUser;
      issue.escalationNotes = null;

      await claim.save({
        session,
      });

      logger.info(
        `Professional rebutted ${issue.type} issue ${issue._id} on claim ${claim.referenceCode}`
      );

      return {
        claim,
        issue,
        occurrence,
        shift,

        submitted: true,

        issueStatus: issue.status,

        rebuttalStatus: issue.rebuttalStatus,

        finalAdminReviewRequired: true,
      };
    });
  }
  /* ─────────────────────────────── EMPLOYER NON-RESPONSE ─────────────────────────────── */

  static async escalateEmployerNonResponseToAdmin(
    { claimId, currentTime = new Date() },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      if (claim.status !== "active") {
        return {
          claim,
          escalated: false,
          idempotent: true,
          reason: "claim_case_not_active",
          escalatedIssueIds: [],
        };
      }

      if (!claim.employerResponseDeadlineAt) {
        throw this.createError({
          message: "The claim is missing its employer response deadline.",
          code: "CLAIM_EMPLOYER_RESPONSE_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      const deadlineAt = this.normalizeDate(
        claim.employerResponseDeadlineAt,
        "employer response deadline",
        {
          statusCode: 500,
        }
      );

      if (now < deadlineAt) {
        throw this.createError({
          message: "The employer response deadline has not expired.",
          code: "EMPLOYER_RESPONSE_DEADLINE_NOT_EXPIRED",
          statusCode: 409,
          details: {
            employerResponseDeadlineAt: deadlineAt,
          },
        });
      }

      const { occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      const undecidedIssues = Array.from(claim.issues || []).filter(
        (issue) => issue.status === "awaiting_employer_review" && !issue.employerDecision
      );

      if (undecidedIssues.length === 0) {
        return {
          claim,
          occurrence,

          escalated: false,
          idempotent: true,
          reason: "no_undecided_employer_review_issues",
          escalatedIssueIds: [],
        };
      }

      const escalatedIssueIds = [];

      for (const issue of undecidedIssues) {
        issue.status = "awaiting_admin_review";

        issue.escalatedAt = now;
        issue.escalationReason = "employer_non_response";
        issue.escalatedBy = null;
        issue.escalationNotes = null;

        issue.appealStatus = "not_available";
        issue.appealDeadlineAt = null;

        escalatedIssueIds.push(String(issue._id));
      }

      await claim.save({
        session,
      });

      logger.info(
        `${escalatedIssueIds.length} employer-unanswered issue(s) escalated on claim ${claim.referenceCode}`
      );

      return {
        claim,
        occurrence,

        escalated: true,
        idempotent: false,

        escalatedIssueIds,
      };
    });
  }

  /* ─────────────────────────────── APPEAL EXPIRY ─────────────────────────────── */

  static async expireAppealWindow(
    { claimId, issueId = null, currentTime = new Date() },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      if (claim.status !== "active") {
        return {
          claim,

          resolved: claim.status === "resolved",

          caseResolved: claim.status === "resolved",

          idempotent: true,

          expiredIssueIds: [],
        };
      }

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      let targetIssues;

      if (issueId) {
        targetIssues = [this.getClaimIssue(claim, issueId)];
      } else {
        targetIssues = Array.from(claim.issues || []).filter(
          (issue) =>
            issue.status === "awaiting_professional_appeal" &&
            issue.appealStatus === "available" &&
            issue.appealDeadlineAt &&
            now >= new Date(issue.appealDeadlineAt)
        );
      }

      if (targetIssues.length === 0) {
        return {
          claim,
          occurrence,
          shift,

          resolved: false,
          caseResolved: false,

          idempotent: true,

          expiredIssueIds: [],
        };
      }

      const expiredIssueIds = [];
      const resolutionResults = [];

      for (const issue of targetIssues) {
        if (issue.status === "resolved" || issue.appealStatus === "expired") {
          continue;
        }

        if (issue.status !== "awaiting_professional_appeal" || issue.appealStatus !== "available") {
          throw this.createError({
            message: "This claim issue does not have an appeal window available for expiry.",
            code: "CLAIM_ISSUE_APPEAL_NOT_EXPIRABLE",
            statusCode: 409,
            details: {
              issueId: String(issue._id),
              issueStatus: issue.status,
              appealStatus: issue.appealStatus,
            },
          });
        }

        if (!issue.appealDeadlineAt) {
          throw this.createError({
            message: "The claim issue is missing its appeal deadline.",
            code: "CLAIM_ISSUE_APPEAL_DEADLINE_MISSING",
            statusCode: 500,
          });
        }

        const deadlineAt = this.normalizeDate(issue.appealDeadlineAt, "appeal deadline", {
          statusCode: 500,
        });

        if (now < deadlineAt) {
          throw this.createError({
            message: "The appeal window for this claim issue has not expired.",
            code: "CLAIM_ISSUE_APPEAL_WINDOW_NOT_EXPIRED",
            statusCode: 409,
            details: {
              issueId: String(issue._id),
              appealDeadlineAt: deadlineAt,
            },
          });
        }

        /**
         * This path applies only to a simple employer rejection with no
         * counter-position.
         *
         * Because the professional did not use the issue-specific appeal right,
         * the employer rejection becomes final for this ordinary claim issue and
         * the existing authoritative Loqum record remains unchanged.
         *
         * Employer counter-positions use the separate rebuttal lifecycle and always
         * proceed to admin adjudication.
         */
        const resolutionResult = await this.applyProfessionalClaimIssueOutcome({
          claim,
          issue,
          occurrence,

          decision: "rejected",

          finalizationReason: "professional_appeal_expired",

          resolvedByUser: issue.employerDecidedBy,

          currentTime: now,

          session,
        });

        issue.appealStatus = "expired";

        issue.status = "resolved";

        issue.resolvedAt = now;

        expiredIssueIds.push(String(issue._id));

        resolutionResults.push({
          issueId: String(issue._id),
          resolutionResult,
        });
      }

      if (expiredIssueIds.length === 0) {
        return {
          claim,
          occurrence,
          shift,

          resolved: false,
          caseResolved: false,

          idempotent: true,

          expiredIssueIds: [],
        };
      }

      const caseFinality = this.synchronizeClaimCaseFinality({
        claim,
        occurrence,
        currentTime: now,
      });

      await claim.save({
        session,
      });

      const settlementSummary = await this.synchronizeOccurrenceSettlementSummary({
        occurrence,
        currentTime: now,
        session,
      });

      await occurrence.save({
        session,
      });

      return {
        claim,
        occurrence,
        shift,

        resolved: caseFinality.caseResolved,

        caseResolved: caseFinality.caseResolved,

        idempotent: false,

        expiredIssueIds,

        resolutionResults,

        settlementSummary,
      };
    });
  }

  /* ─────────────────────────────── REBUTTAL EXPIRY ─────────────────────────────── */

  static async expireRebuttalWindow(
    { claimId, issueId = null, currentTime = new Date() },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      if (claim.status !== "active") {
        return {
          claim,

          escalated: false,
          idempotent: true,

          expiredIssueIds: [],
        };
      }

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      let targetIssues;

      if (issueId) {
        targetIssues = [this.getClaimIssue(claim, issueId)];
      } else {
        targetIssues = Array.from(claim.issues || []).filter(
          (issue) =>
            issue.status === "awaiting_professional_rebuttal" &&
            issue.rebuttalStatus === "available" &&
            issue.rebuttalDeadlineAt &&
            now >= new Date(issue.rebuttalDeadlineAt)
        );
      }

      if (targetIssues.length === 0) {
        return {
          claim,
          occurrence,
          shift,

          escalated: false,
          idempotent: true,

          expiredIssueIds: [],
        };
      }

      const expiredIssueIds = [];

      for (const issue of targetIssues) {
        if (
          issue.rebuttalStatus === "expired" ||
          issue.rebuttalStatus === "resolved" ||
          issue.status === "resolved"
        ) {
          continue;
        }

        if (
          issue.status !== "awaiting_professional_rebuttal" ||
          issue.rebuttalStatus !== "available"
        ) {
          throw this.createError({
            message: "This claim issue does not have a rebuttal window available for expiry.",
            code: "CLAIM_ISSUE_REBUTTAL_NOT_EXPIRABLE",
            statusCode: 409,
            details: {
              issueId: String(issue._id),
              issueStatus: issue.status,
              rebuttalStatus: issue.rebuttalStatus,
            },
          });
        }

        if (issue.employerDecision !== "rejected" || !issue.employerCounterPosition) {
          throw this.createError({
            message:
              "The claim issue does not contain the employer counter-position required for rebuttal expiry.",
            code: "CLAIM_ISSUE_REBUTTAL_CONTEXT_INVALID",
            statusCode: 500,
            details: {
              issueId: String(issue._id),
            },
          });
        }

        if (!issue.rebuttalDeadlineAt) {
          throw this.createError({
            message: "The claim issue is missing its rebuttal deadline.",
            code: "CLAIM_ISSUE_REBUTTAL_DEADLINE_MISSING",
            statusCode: 500,
          });
        }

        const deadlineAt = this.normalizeDate(issue.rebuttalDeadlineAt, "rebuttal deadline", {
          statusCode: 500,
        });

        if (now < deadlineAt) {
          throw this.createError({
            message: "The rebuttal window for this claim issue has not expired.",
            code: "CLAIM_ISSUE_REBUTTAL_WINDOW_NOT_EXPIRED",
            statusCode: 409,
            details: {
              issueId: String(issue._id),
              rebuttalDeadlineAt: deadlineAt,
            },
          });
        }

        /**
         * Professional silence does not accept or make the employer's
         * counter-position authoritative.
         *
         * Once the rebuttal opportunity expires unused, the issue moves to
         * admin adjudication with:
         *
         * - the professional's original position and evidence;
         * - the employer's counter-position and evidence; and
         * - authoritative Loqum/system records.
         *
         * No professional claim outcome is applied here.
         */
        issue.rebuttalStatus = "expired";

        issue.status = "awaiting_admin_review";

        issue.escalatedAt = now;
        issue.escalationReason = "employer_counter_position";
        issue.escalatedBy = null;
        issue.escalationNotes = null;

        expiredIssueIds.push(String(issue._id));
      }

      if (expiredIssueIds.length === 0) {
        return {
          claim,
          occurrence,
          shift,

          escalated: false,
          idempotent: true,

          expiredIssueIds: [],
        };
      }

      await claim.save({
        session,
      });

      logger.info(
        `${expiredIssueIds.length} professional rebuttal window(s) expired and escalated on claim ${claim.referenceCode}`
      );

      return {
        claim,
        occurrence,
        shift,

        escalated: true,
        idempotent: false,

        expiredIssueIds,

        finalAdminReviewRequired: true,
      };
    });
  }

  /* ─────────────────────────────── WITHDRAWAL ─────────────────────────────── */

  static assertClaimWithdrawable(claim) {
    if (claim.status !== "active") {
      throw this.createError({
        message: "Only an active professional claim case can be withdrawn.",
        code: "CLAIM_NOT_WITHDRAWABLE",
        statusCode: 409,
      });
    }

    const startedIssue = Array.from(claim.issues || []).find(
      (issue) =>
        issue.status !== "awaiting_employer_review" ||
        Boolean(issue.employerDecision) ||
        Boolean(issue.employerDecidedAt) ||
        issue.appealStatus !== "not_available" ||
        Boolean(issue.escalatedAt) ||
        Boolean(issue.adminDecision) ||
        Boolean(issue.resolvedAt)
    );

    if (startedIssue) {
      throw this.createError({
        message:
          "The professional claim can only be withdrawn before employer review or adjudication begins on any issue.",
        code: "CLAIM_ADJUDICATION_ALREADY_STARTED",
        statusCode: 409,
        details: {
          issueId: String(startedIssue._id),
          issueType: startedIssue.type,
          issueStatus: startedIssue.status,
        },
      });
    }

    return true;
  }

  static async withdrawClaim(
    {
      claimId,

      professionalId,
      withdrawnByUserId,

      reason,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const claim = await this.getClaim(claimId, session);

      this.assertClaimWithdrawable(claim);

      const { professional, user: withdrawnBy } = await this.assertUserOwnsProfessionalProfile({
        professionalId,
        userId: withdrawnByUserId,
        session,
      });

      if (String(claim.professional) !== String(professional)) {
        throw this.createError({
          message: "The professional cannot withdraw this claim.",
          code: "PROFESSIONAL_CANNOT_WITHDRAW_CLAIM",
          statusCode: 403,
        });
      }

      const cleanReason = this.normalizeText(
        reason,
        "Claim withdrawal reason",
        MIN_REASON_LENGTH,
        MAX_WITHDRAWAL_REASON_LENGTH
      );

      const { shift, occurrence } = await this.getOccurrenceContext({
        shiftId: claim.shift,
        occurrenceId: claim.occurrence,
        session,
      });

      this.assertClaimIsActiveOnOccurrence({
        claim,
        occurrence,
      });

      /**
       * Claim submission did not overwrite authoritative occurrence facts.
       *
       * Therefore withdrawal does not restore a settlement/refund/OT
       * snapshot.
       *
       * It only removes the active professional case.
       */
      this.clearActiveClaim({
        claim,
        occurrence,
      });

      claim.status = "withdrawn";

      claim.withdrawnAt = now;
      claim.withdrawnBy = withdrawnBy;
      claim.withdrawalReason = cleanReason;

      claim.resolvedAt = null;

      /**
       * Do not close the shared challenge window.
       *
       * The professional has consumed the one original claim case because
       * the case document now permanently exists, but the employer may still
       * use an unused dispute right before challengeDeadlineAt.
       */
      const settlementSummary = await this.synchronizeOccurrenceSettlementSummary({
        occurrence,
        currentTime: now,
        session,
      });

      await occurrence.save({
        session,
      });

      await claim.save({
        session,
      });

      logger.info(`Professional claim ${claim.referenceCode} withdrawn`);

      return {
        claim,
        occurrence,
        shift,

        withdrawn: true,

        settlementSummary,
      };
    });
  }

  /* ─────────────────────────────── BATCH: EMPLOYER NON-RESPONSE ─────────────────────────────── */

  static async processOverdueEmployerReviews({
    currentTime = new Date(),
    limit = MAX_BATCH_SIZE,
  } = {}) {
    const now = this.normalizeCurrentTime(currentTime);

    const normalizedLimit = this.normalizeBatchLimit(limit);

    const claims = await ShiftOccurrenceClaim.find({
      status: "active",

      employerResponseDeadlineAt: {
        $ne: null,
        $lte: now,
      },

      issues: {
        $elemMatch: {
          status: "awaiting_employer_review",

          employerDecision: null,
        },
      },
    })
      .select("_id")
      .sort({
        employerResponseDeadlineAt: 1,
      })
      .limit(normalizedLimit)
      .lean();

    const results = [];

    for (const claim of claims) {
      try {
        const result = await this.escalateEmployerNonResponseToAdmin({
          claimId: claim._id,
          currentTime: now,
        });

        results.push({
          claimId: String(claim._id),

          escalated: result.escalated,

          escalatedIssueIds: result.escalatedIssueIds || [],

          error: null,
        });
      } catch (error) {
        logger.error(
          `Unable to escalate overdue employer claim review ${claim._id}: ${error.message}`
        );

        results.push({
          claimId: String(claim._id),

          escalated: false,

          escalatedIssueIds: [],

          error: {
            message: error.message,

            code: error.code || "EMPLOYER_REVIEW_ESCALATION_FAILED",
          },
        });
      }
    }

    return {
      inspectedCount: claims.length,

      escalatedClaimCount: results.filter((item) => item.escalated).length,

      escalatedIssueCount: results.reduce(
        (total, item) => total + (item.escalatedIssueIds || []).length,
        0
      ),

      failedCount: results.filter((item) => item.error).length,

      results,
    };
  }

  /* ─────────────────────────────── BATCH: APPEAL EXPIRY ─────────────────────────────── */

  static async processExpiredAppealWindows({
    currentTime = new Date(),
    limit = MAX_BATCH_SIZE,
  } = {}) {
    const now = this.normalizeCurrentTime(currentTime);

    const normalizedLimit = this.normalizeBatchLimit(limit);

    const claims = await ShiftOccurrenceClaim.find({
      status: "active",

      issues: {
        $elemMatch: {
          status: "awaiting_professional_appeal",

          appealStatus: "available",

          appealDeadlineAt: {
            $ne: null,
            $lte: now,
          },
        },
      },
    })
      .select("_id")
      .sort({
        "issues.appealDeadlineAt": 1,
      })
      .limit(normalizedLimit)
      .lean();

    const results = [];

    for (const claim of claims) {
      try {
        const result = await this.expireAppealWindow({
          claimId: claim._id,
          currentTime: now,
        });

        results.push({
          claimId: String(claim._id),

          resolved: result.resolved,

          caseResolved: result.caseResolved,

          expiredIssueIds: result.expiredIssueIds || [],

          error: null,
        });
      } catch (error) {
        logger.error(
          `Unable to expire claim issue appeals for claim ${claim._id}: ${error.message}`
        );

        results.push({
          claimId: String(claim._id),

          resolved: false,
          caseResolved: false,

          expiredIssueIds: [],

          error: {
            message: error.message,

            code: error.code || "CLAIM_APPEAL_EXPIRY_FAILED",
          },
        });
      }
    }

    return {
      inspectedCount: claims.length,

      resolvedClaimCount: results.filter((item) => item.caseResolved).length,

      expiredIssueCount: results.reduce(
        (total, item) => total + (item.expiredIssueIds || []).length,
        0
      ),

      failedCount: results.filter((item) => item.error).length,

      results,
    };
  }

  /* ─────────────────────────────── BATCH: REBUTTAL EXPIRY ─────────────────────────────── */

  static async processExpiredRebuttalWindows({
    currentTime = new Date(),
    limit = MAX_BATCH_SIZE,
  } = {}) {
    const now = this.normalizeCurrentTime(currentTime);

    const normalizedLimit = this.normalizeBatchLimit(limit);

    const claims = await ShiftOccurrenceClaim.find({
      status: "active",

      issues: {
        $elemMatch: {
          status: "awaiting_professional_rebuttal",

          rebuttalStatus: "available",

          rebuttalDeadlineAt: {
            $ne: null,
            $lte: now,
          },
        },
      },
    })
      .select("_id")
      .sort({
        "issues.rebuttalDeadlineAt": 1,
      })
      .limit(normalizedLimit)
      .lean();

    const results = [];

    for (const claim of claims) {
      try {
        const result = await this.expireRebuttalWindow({
          claimId: claim._id,
          currentTime: now,
        });

        results.push({
          claimId: String(claim._id),

          escalated: result.escalated,

          expiredIssueIds: result.expiredIssueIds || [],

          error: null,
        });
      } catch (error) {
        logger.error(
          `Unable to expire claim issue rebuttals for claim ${claim._id}: ${error.message}`
        );

        results.push({
          claimId: String(claim._id),

          escalated: false,

          expiredIssueIds: [],

          error: {
            message: error.message,

            code: error.code || "CLAIM_REBUTTAL_EXPIRY_FAILED",
          },
        });
      }
    }

    return {
      inspectedCount: claims.length,

      escalatedClaimCount: results.filter((item) => item.escalated).length,

      expiredIssueCount: results.reduce(
        (total, item) => total + (item.expiredIssueIds || []).length,
        0
      ),

      failedCount: results.filter((item) => item.error).length,

      results,
    };
  }
}

module.exports = ShiftOccurrenceClaimService;
