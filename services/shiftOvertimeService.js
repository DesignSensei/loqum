// services/shiftOvertimeService.js

const mongoose = require("mongoose");

const ShiftOccurrence = require("../models/ShiftOccurrence");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const PlatformSettings = require("../models/PlatformSettings");

const ShiftPlatformFeeService = require("./shiftPlatformFeeService");
const ShiftOvertimeFundingService = require("./shiftOvertimeFundingService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const {
  OVERTIME_SOURCES,
  OVERTIME_REJECTION_BASES,
  OVERTIME_ADMIN_REVIEW_REASONS,
  OVERTIME_ADMIN_DECISIONS,
  OCCURRENCE_EVIDENCE_TYPES,
  OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,
} = require("../constants/shiftLifecycle");

const money = require("../utils/money");
const logger = require("../utils/logger");

const SHIFT_OVERTIME_SERVICE_ERROR_NAME = "ShiftOvertimeServiceError";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

const DEFAULT_EXPIRY_BATCH_LIMIT = 100;
const MAX_EXPIRY_BATCH_LIMIT = 500;

const MAX_OVERTIME_REQUEST_STATEMENT_LENGTH = 1000;
const MAX_OVERTIME_REJECTION_REASON_LENGTH = 1000;
const MAX_ADMIN_DECISION_REASON_LENGTH = 1000;

const MAX_OVERTIME_EVIDENCE_ITEMS = 10;
const MAX_OVERTIME_EVIDENCE_REFERENCE_LENGTH = 1000;
const MAX_OVERTIME_EVIDENCE_DESCRIPTION_LENGTH = 500;

const OVERTIME_REQUEST_ALLOWED_OCCURRENCE_STATUSES = Object.freeze([
  "pending_settlement",
  "disputed",
]);

const OVERTIME_EXECUTION_STARTED_STATUSES = Object.freeze(["release_pending", "released"]);

/**
 * SHIFT OVERTIME AUTHORITY
 *
 * ShiftOvertimeService owns the overtime DECISION lifecycle only.
 *
 * It owns:
 *
 * - creation of one OT request;
 * - late-checkout OT request creation;
 * - manual OT request creation within the original occurrence review window;
 * - professional OT request statements and optional supporting evidence;
 * - employer approval;
 * - structured employer rejection and optional supporting evidence;
 * - employer-response expiry;
 * - direct OT escalation to admin after employer rejection or non-response; and
 * - final admin approval/rejection.
 *
 * It does NOT own:
 *
 * - generic ShiftOccurrenceClaim issues;
 * - employer-originated generic disputes;
 * - BASE settlement;
 * - professional payout execution;
 * - OT top-up deadlines/delinquency/restriction;
 * - top-up payment verification;
 * - platform-fee collection; or
 * - employer refunds.
 *
 * OVERTIME IS NOT A GENERIC CLAIM
 *
 * The OT request lives directly on ShiftOccurrence.overtime.
 *
 * The professional's original OT request is already the professional's
 * contested position. Employer rejection therefore routes directly to admin
 * review without requiring another professional response step.
 *
 * Employer decision:
 *
 * employer approves
 * → OT becomes finally approved
 *
 * employer rejects
 * → OT becomes disputed
 * → admin review begins immediately
 *
 * employer does not respond by the deadline
 * → employer decision authority is lost
 * → OT becomes disputed
 * → admin review begins
 *
 * FINAL APPROVAL
 *
 * Employer approval accepts the professional's requestedMinutes exactly.
 *
 * Admin approval may establish a lower evidence-supported approvedMinutes, but
 * may never exceed:
 *
 * - the professional's requestedMinutes; or
 * - authoritative observed post-schedule attendance.
 *
 * Final approved professional OT pay is:
 *
 *   approvedMinutes × snapshotted hourlyRate
 *
 * using integer minor-unit money, BigInt arithmetic and deterministic half-up
 * rounding through utils/money.js.
 *
 * ShiftPlatformFeeService then earns the corresponding OT fee.
 *
 * ShiftOvertimeFundingService then establishes:
 *
 *   overtimeProfessionalPay
 *   + overtimePlatformFee
 *   = employer OT top-up requirement
 *
 * Those authorities are staged on the same ShiftOccurrence document and saved
 * once inside the same Mongo transaction.
 *
 * SHARED REVIEW WINDOW
 *
 * A manual OT request may still be created after the professional has
 * submitted an ordinary claim, provided:
 *
 * - no OT request already exists;
 * - "overtime" remains an available challengeable settlement component; and
 * - the original occurrence challengeDeadlineAt has not expired.
 *
 * Once OT is requested, the overtime review selection is consumed. BASE may
 * remain independently challengeable until the shared challenge deadline
 * expires.
 *
 * EVIDENCE
 *
 * File upload is optional. A factual position is not.
 *
 * Professional request:
 * - requestStatement is required;
 * - requestEvidence is optional.
 *
 * Employer rejection:
 * - rejectionBasis is required;
 * - rejectionReason is required;
 * - rejectionEvidence is optional;
 * - when no supporting documentary evidence exists, the employer must
 *   explicitly record rejectionNoSupportingEvidence = true.
 *
 * Admin may attach adminEvidence during final adjudication.
 */
class ShiftOvertimeService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: SHIFT_OVERTIME_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });

    if (cause) {
      error.cause = cause;
    }

    return error;
  }

  static async transaction(options = {}, callback) {
    return runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeObjectId(value, fieldName) {
    const fieldCode = normalizeFieldCode(fieldName);

    if (!value || !mongoose.isValidObjectId(value)) {
      throw ShiftOvertimeService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeDate(value, fieldName = "date") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(date.getTime())) {
      throw ShiftOvertimeService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return date;
  }

  static normalizeSource(value) {
    const source = String(value || "")
      .trim()
      .toLowerCase();

    if (!OVERTIME_SOURCES.includes(source)) {
      throw ShiftOvertimeService.createError({
        message: "Overtime source is invalid.",
        code: "INVALID_OVERTIME_SOURCE",
      });
    }

    return source;
  }

  static normalizePositiveMinutes(value, fieldName = "overtime minutes") {
    const minutes = Number(value);

    if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
      throw ShiftOvertimeService.createError({
        message: `${fieldName} must be a positive whole number of minutes no greater than 1440.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return minutes;
  }

  static normalizeRequiredText(value, fieldName, { minLength = 1, maxLength }) {
    const text = String(value || "").trim();

    if (text.length < minLength) {
      throw ShiftOvertimeService.createError({
        message: `${fieldName} is required.`,
        code: `${normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (text.length > maxLength) {
      throw ShiftOvertimeService.createError({
        message: `${fieldName} cannot exceed ${maxLength} characters.`,
        code: `${normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return text;
  }

  static normalizeOptionalText(value, fieldName, maxLength) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const text = String(value).trim();

    if (!text) {
      return null;
    }

    if (text.length > maxLength) {
      throw ShiftOvertimeService.createError({
        message: `${fieldName} cannot exceed ${maxLength} characters.`,
        code: `${normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return text;
  }

  static normalizeAdminDecision(value) {
    const decision = String(value || "")
      .trim()
      .toLowerCase();

    if (!OVERTIME_ADMIN_DECISIONS.includes(decision)) {
      throw ShiftOvertimeService.createError({
        message: "Admin overtime decision must be approved or rejected.",
        code: "INVALID_OVERTIME_ADMIN_DECISION",
      });
    }

    return decision;
  }

  static normalizeRejectionBasis(value) {
    const basis = String(value || "")
      .trim()
      .toLowerCase();

    if (!OVERTIME_REJECTION_BASES.includes(basis)) {
      throw ShiftOvertimeService.createError({
        message: "Overtime rejection basis is invalid.",
        code: "INVALID_OVERTIME_REJECTION_BASIS",
        details: {
          supportedRejectionBases: OVERTIME_REJECTION_BASES,
        },
      });
    }

    return basis;
  }

  static normalizeEvidence(
    evidence = [],
    { submittedByRole, submittedByUser, recordedAt = new Date() } = {}
  ) {
    if (!Array.isArray(evidence)) {
      throw ShiftOvertimeService.createError({
        message: "Overtime evidence must be an array.",
        code: "INVALID_OVERTIME_EVIDENCE",
      });
    }

    if (evidence.length > MAX_OVERTIME_EVIDENCE_ITEMS) {
      throw ShiftOvertimeService.createError({
        message: `Overtime evidence cannot contain more than ${MAX_OVERTIME_EVIDENCE_ITEMS} items.`,
        code: "TOO_MANY_OVERTIME_EVIDENCE_ITEMS",
      });
    }

    if (evidence.length === 0) {
      return [];
    }

    const normalizedRole = String(submittedByRole || "")
      .trim()
      .toLowerCase();

    if (!OCCURRENCE_EVIDENCE_SUBMITTER_ROLES.includes(normalizedRole)) {
      throw ShiftOvertimeService.createError({
        message: "A valid overtime evidence submitter role is required.",
        code: "INVALID_OVERTIME_EVIDENCE_SUBMITTER_ROLE",
      });
    }

    const normalizedSubmittedByUser = ShiftOvertimeService.normalizeObjectId(
      submittedByUser,
      "evidence submitting user ID"
    );

    const normalizedRecordedAt = ShiftOvertimeService.normalizeDate(
      recordedAt,
      "overtime evidence recorded time"
    );

    return evidence.map((item, index) => {
      const type = String(item?.type || "")
        .trim()
        .toLowerCase();

      if (!OCCURRENCE_EVIDENCE_TYPES.includes(type)) {
        throw ShiftOvertimeService.createError({
          message: `Overtime evidence item ${index + 1} has an unsupported evidence type.`,
          code: "INVALID_OVERTIME_EVIDENCE_TYPE",
          details: {
            evidenceIndex: index,
            evidenceType: type || null,
            supportedTypes: OCCURRENCE_EVIDENCE_TYPES,
          },
        });
      }

      const reference = ShiftOvertimeService.normalizeRequiredText(
        item?.reference,
        `Overtime evidence item ${index + 1} reference`,
        {
          maxLength: MAX_OVERTIME_EVIDENCE_REFERENCE_LENGTH,
        }
      );

      const description = ShiftOvertimeService.normalizeOptionalText(
        item?.description,
        `Overtime evidence item ${index + 1} description`,
        MAX_OVERTIME_EVIDENCE_DESCRIPTION_LENGTH
      );

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

  static getEvidenceSignature(evidence = []) {
    const items = Array.isArray(evidence) ? evidence : [];

    return JSON.stringify(
      items.map((item) => ({
        type: String(item?.type || "")
          .trim()
          .toLowerCase(),

        reference: String(item?.reference || "").trim(),

        description: item?.description ? String(item.description).trim() : null,
      }))
    );
  }

  static normalizeExpiryBatchLimit(value) {
    const limit = Number(value || DEFAULT_EXPIRY_BATCH_LIMIT);

    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_EXPIRY_BATCH_LIMIT) {
      throw ShiftOvertimeService.createError({
        message: `Expiry batch limit must be between 1 and ${MAX_EXPIRY_BATCH_LIMIT}.`,
        code: "INVALID_OVERTIME_EXPIRY_BATCH_LIMIT",
      });
    }

    return limit;
  }

  /* ─────────────────────────────── SETTINGS ─────────────────────────────── */

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
      throw ShiftOvertimeService.createError({
        message: "Active platform settings were not found.",
        code: "PLATFORM_SETTINGS_NOT_FOUND",
        statusCode: 500,
      });
    }

    return settings;
  }

  static getEmployerResponseHours(settings) {
    const hours = Number(settings?.overtimeResponseHours);

    if (!Number.isSafeInteger(hours) || hours <= 0) {
      throw ShiftOvertimeService.createError({
        message: "PlatformSettings.overtimeResponseHours must be a positive whole number.",
        code: "INVALID_OVERTIME_RESPONSE_HOURS",
        statusCode: 500,
      });
    }

    return hours;
  }

  /* ─────────────────────────────── LOADERS / ACTORS ─────────────────────────────── */

  static async getOccurrence(occurrenceId, session = null) {
    const normalizedOccurrenceId = ShiftOvertimeService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = ShiftOccurrence.findById(normalizedOccurrenceId);

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftOvertimeService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static async assertProfessionalOwnsOccurrence({ occurrence, professionalUserId, session }) {
    const userId = ShiftOvertimeService.normalizeObjectId(
      professionalUserId,
      "professional user ID"
    );

    if (occurrence.assignmentStatus !== "assigned" || !occurrence.assignedProfessional) {
      throw ShiftOvertimeService.createError({
        message: "Overtime action requires an assigned professional.",
        code: "OVERTIME_ASSIGNMENT_REQUIRED",
        statusCode: 409,
      });
    }

    const professional = await ProfessionalProfile.findById(occurrence.assignedProfessional)
      .select("user")
      .session(session);

    if (!professional?.user) {
      throw ShiftOvertimeService.createError({
        message: "Assigned professional profile was not found.",
        code: "PROFESSIONAL_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (String(professional.user) !== String(userId)) {
      throw ShiftOvertimeService.createError({
        message: "The user does not belong to the professional assigned to this occurrence.",
        code: "PROFESSIONAL_CANNOT_MANAGE_OVERTIME",
        statusCode: 403,
      });
    }

    return {
      userId,
      professional,
    };
  }

  static async assertEmployerCanDecide({
    occurrence,
    employerProfileId,
    employerUserId,
    employerContext = null,
    session,
  }) {
    const employerProfile = ShiftOvertimeService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const employerUser = ShiftOvertimeService.normalizeObjectId(employerUserId, "employer user ID");

    if (String(occurrence.business) !== String(employerProfile)) {
      throw ShiftOvertimeService.createError({
        message: "This employer cannot decide overtime for the occurrence.",
        code: "EMPLOYER_CANNOT_DECIDE_OVERTIME",
        statusCode: 403,
      });
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    if (employerContext) {
      if (!canManageAllBranches && !isBranchManager) {
        throw ShiftOvertimeService.createError({
          message: "You do not have permission to decide overtime.",
          code: "OVERTIME_DECISION_NOT_ALLOWED",
          statusCode: 403,
        });
      }

      if (!canManageAllBranches) {
        const assignedBranchIds = (employerContext.assignedBranchIds || [])
          .filter((branchId) => mongoose.isValidObjectId(branchId))
          .map(String);

        if (!assignedBranchIds.includes(String(occurrence.branch))) {
          throw ShiftOvertimeService.createError({
            message: "You do not have permission to decide overtime for this branch.",
            code: "OVERTIME_BRANCH_DECISION_NOT_ALLOWED",
            statusCode: 403,
          });
        }
      }

      return {
        employerProfile,
        employerUser,
      };
    }

    const profile = await EmployerProfile.findById(employerProfile).select("user").session(session);

    if (!profile?.user || String(profile.user) !== String(employerUser)) {
      throw ShiftOvertimeService.createError({
        message: "The employer user is not authorized for this business.",
        code: "EMPLOYER_OVERTIME_USER_MISMATCH",
        statusCode: 403,
      });
    }

    return {
      employerProfile,
      employerUser,
    };
  }

  static normalizeAdminUserId(adminUserId) {
    return ShiftOvertimeService.normalizeObjectId(adminUserId, "admin user ID");
  }

  /* ─────────────────────────────── OCCURRENCE HELPERS ─────────────────────────────── */

  static assertOccurrenceCanReceiveOvertimeRequest(occurrence) {
    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignedProfessional ||
      !occurrence.assignment ||
      !occurrence.assignedAt
    ) {
      throw ShiftOvertimeService.createError({
        message: "Overtime may only be reported for an assigned occurrence.",
        code: "OVERTIME_ASSIGNMENT_REQUIRED",
        statusCode: 409,
      });
    }

    if (!OVERTIME_REQUEST_ALLOWED_OCCURRENCE_STATUSES.includes(occurrence.status)) {
      throw ShiftOvertimeService.createError({
        message: "Overtime can no longer be reported for this occurrence.",
        code: "OVERTIME_REQUEST_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    if (occurrence.activeWorkCancellation?.occurred === true) {
      throw ShiftOvertimeService.createError({
        message: "An active-work cancellation cannot also create an overtime request.",
        code: "ACTIVE_WORK_CANCELLATION_BLOCKS_OVERTIME",
        statusCode: 409,
      });
    }

    if (OVERTIME_EXECUTION_STARTED_STATUSES.includes(occurrence.overtimeSettlement?.status)) {
      throw ShiftOvertimeService.createError({
        message: "Overtime cannot be changed after overtime payout execution has started.",
        code: "OVERTIME_PAYOUT_EXECUTION_STARTED",
        statusCode: 409,
      });
    }

    return true;
  }

  static assertNoExistingOvertimeRequest(occurrence) {
    if (occurrence.overtime?.requested === true) {
      throw ShiftOvertimeService.createError({
        message: "An overtime request already exists for this occurrence.",
        code: "OVERTIME_REQUEST_ALREADY_EXISTS",
        statusCode: 409,
        details: {
          status: occurrence.overtime?.status || null,

          requestedAt: occurrence.overtime?.requestedAt || null,
        },
      });
    }

    return true;
  }

  static assertManualRequestWindowOpen({ occurrence, requestedAt }) {
    if (!occurrence.challengeWindowOpenedAt || !occurrence.challengeDeadlineAt) {
      throw ShiftOvertimeService.createError({
        message: "The post-shift review window is not available for this occurrence.",
        code: "OVERTIME_REVIEW_WINDOW_NOT_ESTABLISHED",
        statusCode: 409,
      });
    }

    if (occurrence.challengeWindowClosedAt || requestedAt >= occurrence.challengeDeadlineAt) {
      throw ShiftOvertimeService.createError({
        message: "The time for reporting new overtime has expired.",
        code: "OVERTIME_REQUEST_WINDOW_EXPIRED",
        statusCode: 409,
        details: {
          challengeDeadlineAt: occurrence.challengeDeadlineAt,
        },
      });
    }

    if (requestedAt < occurrence.challengeWindowOpenedAt) {
      throw ShiftOvertimeService.createError({
        message: "Overtime cannot be reported before the post-shift review window opens.",
        code: "OVERTIME_REQUEST_TOO_EARLY",
        statusCode: 409,
      });
    }

    const challengeableComponents = Array.isArray(occurrence.challengeableSettlementComponents)
      ? occurrence.challengeableSettlementComponents.map(String)
      : [];

    if (!challengeableComponents.includes("overtime")) {
      throw ShiftOvertimeService.createError({
        message: "The overtime review selection is no longer available for this occurrence.",
        code: "OVERTIME_REVIEW_SELECTION_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    return true;
  }

  static getObservedPostScheduleAttendanceMinutes(occurrence) {
    let attendanceEnd = occurrence.checkedOutAt || null;

    if (
      occurrence.attendanceOverride?.used === true &&
      ["checkout", "both"].includes(occurrence.attendanceOverride.type) &&
      occurrence.attendanceOverride.approvedEndTime
    ) {
      attendanceEnd = occurrence.attendanceOverride.approvedEndTime;
    }

    if (
      occurrence.checkoutFallback?.required === true &&
      occurrence.checkoutFallback?.resolvedAt &&
      occurrence.checkoutFallback?.approvedEndTime
    ) {
      attendanceEnd = occurrence.checkoutFallback.approvedEndTime;
    }

    if (!attendanceEnd || !occurrence.endTime || attendanceEnd <= occurrence.endTime) {
      return 0;
    }

    return Math.floor((attendanceEnd.getTime() - occurrence.endTime.getTime()) / (60 * 1000));
  }

  static assertApprovedMinutesAreSupportedByAttendance({ occurrence, approvedMinutes }) {
    const finalApprovedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      approvedMinutes,
      "approved overtime minutes"
    );

    const requestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      occurrence.overtime?.requestedMinutes,
      "requested overtime minutes"
    );

    if (finalApprovedMinutes > requestedMinutes) {
      throw ShiftOvertimeService.createError({
        message: "Approved overtime cannot exceed the professional's requested overtime minutes.",
        code: "OVERTIME_APPROVAL_EXCEEDS_REQUEST",
        statusCode: 409,
        details: {
          requestedMinutes,
          approvedMinutes: finalApprovedMinutes,
        },
      });
    }

    const observedMinutes =
      ShiftOvertimeService.getObservedPostScheduleAttendanceMinutes(occurrence);

    if (finalApprovedMinutes > observedMinutes) {
      throw ShiftOvertimeService.createError({
        message: "Approved overtime exceeds the currently authoritative attendance record.",
        code: "OVERTIME_EXCEEDS_AUTHORITATIVE_ATTENDANCE",
        statusCode: 409,
        details: {
          requestedMinutes,
          approvedMinutes: finalApprovedMinutes,
          observedMinutes,
        },
      });
    }

    return {
      requestedMinutes,
      approvedMinutes: finalApprovedMinutes,
      observedMinutes,
    };
  }

  static consumeOvertimeReviewSelection(occurrence) {
    const components = Array.isArray(occurrence.challengeableSettlementComponents)
      ? occurrence.challengeableSettlementComponents.map(String)
      : [];

    occurrence.challengeableSettlementComponents = components.filter(
      (component) => component !== "overtime"
    );

    return occurrence;
  }

  static calculateApprovedProfessionalPay({ occurrence, approvedMinutes }) {
    let hourlyRate;

    try {
      hourlyRate = money.normalizePositiveMinorUnitAmount(
        occurrence.hourlyRate,
        "Occurrence hourly rate"
      );
    } catch (error) {
      throw ShiftOvertimeService.createError({
        message: "The occurrence hourly-rate snapshot is invalid.",
        code: "INVALID_OCCURRENCE_HOURLY_RATE",
        statusCode: 500,
        cause: error,
      });
    }

    const finalApprovedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      approvedMinutes,
      "approved overtime minutes"
    );

    let professionalPay;

    try {
      professionalPay = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: hourlyRate,
        minutes: finalApprovedMinutes,
        fieldName: "Overtime professional pay",
      });
    } catch (error) {
      throw ShiftOvertimeService.createError({
        message: "Calculated overtime professional pay is invalid or too large.",
        code: "OVERTIME_PAY_TOO_LARGE",
        statusCode: 500,
        cause: error,
      });
    }

    if (!Number.isSafeInteger(professionalPay) || professionalPay <= 0) {
      throw ShiftOvertimeService.createError({
        message: "Final overtime professional pay must be positive.",
        code: "INVALID_OVERTIME_PROFESSIONAL_PAY",
        statusCode: 500,
      });
    }

    return professionalPay;
  }

  static hasActiveOrdinaryChallenge(occurrence) {
    return Boolean(occurrence.activeClaim || occurrence.activeDispute);
  }

  static deriveNonFundingSettlementStatus(occurrence) {
    if (ShiftOvertimeService.hasActiveOrdinaryChallenge(occurrence)) {
      return "disputed";
    }

    const overtime = occurrence.overtime || {};

    if (overtime.status === "pending") {
      return "awaiting_overtime_review";
    }

    if (overtime.status === "disputed") {
      return "disputed";
    }

    const baseStatus = occurrence.baseSettlement?.status || "not_due";

    const overtimeStatus = occurrence.overtimeSettlement?.status || "not_due";

    if (baseStatus === "release_pending" || overtimeStatus === "release_pending") {
      return "release_pending";
    }

    if (baseStatus === "approved_for_release" || overtimeStatus === "approved_for_release") {
      return "approved_for_release";
    }

    const basePay = Number(occurrence.baseProfessionalPay || 0);

    const overtimePay = Number(occurrence.overtimeProfessionalPay || 0);

    const baseReleased = basePay <= 0 || baseStatus === "released";

    const overtimeReleased = overtimePay <= 0 || overtimeStatus === "released";

    if ((basePay > 0 || overtimePay > 0) && baseReleased && overtimeReleased) {
      return "released";
    }

    if (
      occurrence.challengeWindowOpenedAt &&
      occurrence.challengeDeadlineAt &&
      !occurrence.challengeWindowClosedAt
    ) {
      return "pending_review";
    }

    return "not_due";
  }

  static synchronizeNonFundingSettlementStatus(occurrence) {
    occurrence.settlementStatus = ShiftOvertimeService.deriveNonFundingSettlementStatus(occurrence);

    return occurrence.settlementStatus;
  }

  static assertNoFinalOvertimeFinancialState(occurrence) {
    const hasFinalFinancialState =
      Number(occurrence.overtimeProfessionalPay || 0) > 0 ||
      Number(occurrence.overtimePlatformFee || 0) > 0 ||
      Number(occurrence.overtime?.topUpAmount || 0) > 0 ||
      Number(occurrence.topUpRequired || 0) > 0 ||
      occurrence.overtime?.topUpDeadlineAt ||
      occurrence.overtime?.topUpOverdueAt ||
      occurrence.overtime?.restrictionTriggeredAt ||
      occurrence.overtime?.topUpPaid === true ||
      occurrence.overtime?.topUpPaidAt ||
      occurrence.topUpTransaction ||
      occurrence.overtimePlatformFeeAudit?.earnedAt ||
      occurrence.overtimePlatformFeeAudit?.outstandingAt ||
      occurrence.overtimePlatformFeeAudit?.collectedAt ||
      occurrence.overtimePlatformFeeAudit?.collectionTransaction;

    if (hasFinalFinancialState) {
      throw ShiftOvertimeService.createError({
        message: "Unapproved overtime unexpectedly contains final financial or funding state.",
        code: "UNAPPROVED_OVERTIME_HAS_FINANCIAL_STATE",
        statusCode: 500,
      });
    }

    return true;
  }

  static stageAdminReview({ occurrence, reason, startedAt }) {
    const normalizedReason = String(reason || "")
      .trim()
      .toLowerCase();

    if (!OVERTIME_ADMIN_REVIEW_REASONS.includes(normalizedReason)) {
      throw ShiftOvertimeService.createError({
        message: "Overtime admin review reason is invalid.",
        code: "INVALID_OVERTIME_ADMIN_REVIEW_REASON",
        statusCode: 500,
        details: {
          supportedReasons: OVERTIME_ADMIN_REVIEW_REASONS,
        },
      });
    }

    const normalizedStartedAt = ShiftOvertimeService.normalizeDate(
      startedAt,
      "overtime admin review start time"
    );

    occurrence.set("overtime.status", "disputed");

    occurrence.set("overtime.decisionSource", null);

    occurrence.set("overtime.adminReviewReason", normalizedReason);

    occurrence.set("overtime.adminReviewStartedAt", normalizedStartedAt);

    occurrence.set("overtime.adminEvidence", []);

    occurrence.set("overtime.adminDecision", null);

    occurrence.set("overtime.adminDecidedAt", null);

    occurrence.set("overtime.adminDecidedBy", null);

    occurrence.set("overtime.adminDecisionReason", null);

    occurrence.settlementStatus = "disputed";

    return occurrence;
  }

  /* ─────────────────────────────── REQUEST CREATION ─────────────────────────────── */

  static async stageOvertimeRequest({
    occurrence,
    professionalUserId,
    requestedMinutes,
    source,
    requestStatement,
    requestEvidence = [],
    requestedAt = new Date(),
    settings,
    session,
  }) {
    if (!occurrence || typeof occurrence.set !== "function") {
      throw ShiftOvertimeService.createError({
        message: "stageOvertimeRequest requires a loaded ShiftOccurrence document.",
        code: "SHIFT_OCCURRENCE_DOCUMENT_REQUIRED",
        statusCode: 500,
      });
    }

    const normalizedRequestedAt = ShiftOvertimeService.normalizeDate(
      requestedAt,
      "overtime request time"
    );

    const normalizedSource = ShiftOvertimeService.normalizeSource(source);

    const finalRequestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      requestedMinutes,
      "requested overtime minutes"
    );

    const finalRequestStatement = ShiftOvertimeService.normalizeRequiredText(
      requestStatement,
      "Overtime request statement",
      {
        maxLength: MAX_OVERTIME_REQUEST_STATEMENT_LENGTH,
      }
    );

    const { userId } = await ShiftOvertimeService.assertProfessionalOwnsOccurrence({
      occurrence,
      professionalUserId,
      session,
    });

    ShiftOvertimeService.assertOccurrenceCanReceiveOvertimeRequest(occurrence);

    ShiftOvertimeService.assertNoExistingOvertimeRequest(occurrence);

    const normalizedRequestEvidence = ShiftOvertimeService.normalizeEvidence(requestEvidence, {
      submittedByRole: "professional",
      submittedByUser: userId,
      recordedAt: normalizedRequestedAt,
    });

    if (normalizedSource === "late_checkout_prompt") {
      if (occurrence.lateCheckout?.occurred !== true) {
        throw ShiftOvertimeService.createError({
          message: "Late-checkout overtime requires an established late checkout.",
          code: "LATE_CHECKOUT_REQUIRED_FOR_OVERTIME",
          statusCode: 409,
        });
      }

      const observedLateMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        occurrence.lateCheckout.minutesLate,
        "late-checkout minutes"
      );

      if (finalRequestedMinutes > observedLateMinutes) {
        throw ShiftOvertimeService.createError({
          message:
            "Late-checkout overtime minutes cannot exceed the recorded post-schedule attendance minutes.",
          code: "LATE_CHECKOUT_OVERTIME_EXCEEDS_ATTENDANCE",
          statusCode: 409,
          details: {
            requestedMinutes: finalRequestedMinutes,
            observedLateMinutes,
          },
        });
      }

      occurrence.lateCheckout.selectedOption = "overtime_requested";

      occurrence.lateCheckout.reason = null;
    } else {
      ShiftOvertimeService.assertManualRequestWindowOpen({
        occurrence,
        requestedAt: normalizedRequestedAt,
      });
    }

    const employerResponseHours = ShiftOvertimeService.getEmployerResponseHours(settings);

    const employerResponseDeadlineAt = new Date(
      normalizedRequestedAt.getTime() + employerResponseHours * MILLISECONDS_PER_HOUR
    );

    occurrence.set("overtime.requested", true);

    occurrence.set("overtime.requestedBy", userId);

    occurrence.set("overtime.requestedAt", normalizedRequestedAt);

    occurrence.set("overtime.source", normalizedSource);

    occurrence.set("overtime.requestStatement", finalRequestStatement);

    occurrence.set("overtime.requestEvidence", normalizedRequestEvidence);

    occurrence.set("overtime.requestedMinutes", finalRequestedMinutes);

    occurrence.set("overtime.approvedMinutes", null);

    occurrence.set("overtime.status", "pending");

    occurrence.set("overtime.decisionSource", null);

    occurrence.set("overtime.employerResponseDeadlineAt", employerResponseDeadlineAt);

    occurrence.set("overtime.employerRespondedAt", null);

    occurrence.set("overtime.employerResponseOverdueAt", null);

    occurrence.set("overtime.approvedAt", null);

    occurrence.set("overtime.approvedBy", null);

    occurrence.set("overtime.rejectedAt", null);

    occurrence.set("overtime.rejectedBy", null);

    occurrence.set("overtime.rejectionBasis", null);

    occurrence.set("overtime.rejectionReason", null);

    occurrence.set("overtime.employerProposedMinutes", null);

    occurrence.set("overtime.rejectionEvidence", []);

    occurrence.set("overtime.rejectionNoSupportingEvidence", false);

    occurrence.set("overtime.adminReviewReason", null);

    occurrence.set("overtime.adminReviewStartedAt", null);

    occurrence.set("overtime.adminEvidence", []);

    occurrence.set("overtime.adminDecision", null);

    occurrence.set("overtime.adminDecidedAt", null);

    occurrence.set("overtime.adminDecidedBy", null);

    occurrence.set("overtime.adminDecisionReason", null);

    ShiftOvertimeService.consumeOvertimeReviewSelection(occurrence);

    ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

    ShiftOvertimeService.synchronizeNonFundingSettlementStatus(occurrence);

    return {
      occurrence,
      requestedMinutes: finalRequestedMinutes,
      requestStatement: finalRequestStatement,
      requestEvidence: normalizedRequestEvidence,
      requestedAt: normalizedRequestedAt,
      employerResponseDeadlineAt,
      source: normalizedSource,
    };
  }

  static async createOvertimeRequest(
    {
      occurrenceId,
      professionalUserId,
      requestedMinutes,
      source,
      requestStatement,
      requestEvidence = [],
      requestedAt = new Date(),
    },
    options = {}
  ) {
    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const normalizedRequestedAt = ShiftOvertimeService.normalizeDate(
        requestedAt,
        "overtime request time"
      );

      const normalizedSource = ShiftOvertimeService.normalizeSource(source);

      const normalizedUserId = ShiftOvertimeService.normalizeObjectId(
        professionalUserId,
        "professional user ID"
      );

      const normalizedRequestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        requestedMinutes,
        "requested overtime minutes"
      );

      const normalizedRequestStatement = ShiftOvertimeService.normalizeRequiredText(
        requestStatement,
        "Overtime request statement",
        {
          maxLength: MAX_OVERTIME_REQUEST_STATEMENT_LENGTH,
        }
      );

      const normalizedRequestEvidence = ShiftOvertimeService.normalizeEvidence(requestEvidence, {
        submittedByRole: "professional",
        submittedByUser: normalizedUserId,
        recordedAt: normalizedRequestedAt,
      });

      if (occurrence.overtime?.requested === true) {
        const matches =
          String(occurrence.overtime.requestedBy) === String(normalizedUserId) &&
          occurrence.overtime.source === normalizedSource &&
          Number(occurrence.overtime.requestedMinutes) === normalizedRequestedMinutes &&
          occurrence.overtime.requestStatement === normalizedRequestStatement &&
          ShiftOvertimeService.getEvidenceSignature(occurrence.overtime.requestEvidence) ===
            ShiftOvertimeService.getEvidenceSignature(normalizedRequestEvidence);

        if (!matches) {
          throw ShiftOvertimeService.createError({
            message: "An overtime request already exists with different request details.",
            code: "OVERTIME_REQUEST_ALREADY_EXISTS",
            statusCode: 409,
          });
        }

        return {
          occurrence,
          idempotent: true,
        };
      }

      const settings = await ShiftOvertimeService.getPlatformSettings(session);

      await ShiftOvertimeService.stageOvertimeRequest({
        occurrence,
        professionalUserId: normalizedUserId,
        requestedMinutes: normalizedRequestedMinutes,
        source: normalizedSource,
        requestStatement: normalizedRequestStatement,
        requestEvidence: normalizedRequestEvidence,
        requestedAt: normalizedRequestedAt,
        settings,
        session,
      });

      await occurrence.save({
        session,
      });

      logger.info(`Created overtime request for occurrence ${occurrence.referenceCode}.`);

      return {
        occurrence,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── EMPLOYER DECISION ─────────────────────────────── */

  static assertEmployerDecisionAvailable({ occurrence, decidedAt }) {
    const overtime = occurrence.overtime || {};

    if (overtime.requested !== true || overtime.status !== "pending") {
      throw ShiftOvertimeService.createError({
        message: "This overtime request is not awaiting employer review.",
        code: "OVERTIME_NOT_AWAITING_EMPLOYER",
        statusCode: 409,
      });
    }

    if (overtime.employerRespondedAt) {
      throw ShiftOvertimeService.createError({
        message: "The employer has already responded to this overtime request.",
        code: "OVERTIME_EMPLOYER_ALREADY_RESPONDED",
        statusCode: 409,
      });
    }

    if (
      overtime.employerResponseOverdueAt ||
      (overtime.employerResponseDeadlineAt && decidedAt >= overtime.employerResponseDeadlineAt)
    ) {
      throw ShiftOvertimeService.createError({
        message:
          "The employer overtime response window has expired. Admin now owns the final decision.",
        code: "OVERTIME_EMPLOYER_RESPONSE_EXPIRED",
        statusCode: 409,
      });
    }

    return true;
  }

  static stageEmployerRejection({
    occurrence,
    employerUserId,
    rejectedAt,
    rejectionBasis,
    rejectionReason,
    employerProposedMinutes = null,
    rejectionEvidence = [],
    rejectionNoSupportingEvidence = false,
  }) {
    const normalizedBasis = ShiftOvertimeService.normalizeRejectionBasis(rejectionBasis);

    const normalizedReason = ShiftOvertimeService.normalizeRequiredText(
      rejectionReason,
      "Overtime rejection reason",
      {
        maxLength: MAX_OVERTIME_REJECTION_REASON_LENGTH,
      }
    );

    let normalizedEmployerProposedMinutes = null;

    if (normalizedBasis === "minutes_incorrect") {
      normalizedEmployerProposedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        employerProposedMinutes,
        "employer proposed overtime minutes"
      );

      const requestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        occurrence.overtime?.requestedMinutes,
        "requested overtime minutes"
      );

      if (normalizedEmployerProposedMinutes >= requestedMinutes) {
        throw ShiftOvertimeService.createError({
          message:
            "Employer proposed overtime minutes must be lower than the professional's requested minutes when the rejection basis is minutes_incorrect.",
          code: "INVALID_EMPLOYER_PROPOSED_OVERTIME_MINUTES",
          statusCode: 409,
          details: {
            requestedMinutes,
            employerProposedMinutes: normalizedEmployerProposedMinutes,
          },
        });
      }
    } else if (
      employerProposedMinutes !== null &&
      employerProposedMinutes !== undefined &&
      employerProposedMinutes !== ""
    ) {
      throw ShiftOvertimeService.createError({
        message:
          "Employer proposed overtime minutes may only be supplied when the rejection basis is minutes_incorrect.",
        code: "EMPLOYER_PROPOSED_MINUTES_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    const normalizedEvidence = ShiftOvertimeService.normalizeEvidence(rejectionEvidence, {
      submittedByRole: "employer",
      submittedByUser: employerUserId,
      recordedAt: rejectedAt,
    });

    if (normalizedEvidence.length === 0 && rejectionNoSupportingEvidence !== true) {
      throw ShiftOvertimeService.createError({
        message:
          "Employer overtime rejection without documentary evidence requires an explicit no-supporting-evidence declaration.",
        code: "OVERTIME_REJECTION_EVIDENCE_DECLARATION_REQUIRED",
        statusCode: 409,
      });
    }

    if (normalizedEvidence.length > 0 && rejectionNoSupportingEvidence === true) {
      throw ShiftOvertimeService.createError({
        message:
          "The employer cannot declare no supporting evidence when rejection evidence is supplied.",
        code: "OVERTIME_REJECTION_EVIDENCE_DECLARATION_CONFLICT",
        statusCode: 409,
      });
    }

    occurrence.set("overtime.decisionSource", null);

    occurrence.set("overtime.employerRespondedAt", rejectedAt);

    occurrence.set("overtime.employerResponseOverdueAt", null);

    occurrence.set("overtime.rejectedAt", rejectedAt);

    occurrence.set("overtime.rejectedBy", employerUserId);

    occurrence.set("overtime.rejectionBasis", normalizedBasis);

    occurrence.set("overtime.rejectionReason", normalizedReason);

    occurrence.set("overtime.employerProposedMinutes", normalizedEmployerProposedMinutes);

    occurrence.set("overtime.rejectionEvidence", normalizedEvidence);

    occurrence.set("overtime.rejectionNoSupportingEvidence", normalizedEvidence.length === 0);

    occurrence.set("overtime.approvedMinutes", null);

    occurrence.set("overtime.approvedAt", null);

    occurrence.set("overtime.approvedBy", null);

    ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

    ShiftOvertimeService.stageAdminReview({
      occurrence,
      reason: "employer_rejection",
      startedAt: rejectedAt,
    });

    return occurrence;
  }

  static async stageFinalApproval({
    occurrence,
    approvedBy,
    approvedAt,
    approvedMinutes,
    decisionSource,
    session,
  }) {
    const normalizedApprovedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      approvedMinutes,
      "approved overtime minutes"
    );

    const { requestedMinutes } = ShiftOvertimeService.assertApprovedMinutesAreSupportedByAttendance(
      {
        occurrence,
        approvedMinutes: normalizedApprovedMinutes,
      }
    );

    if (decisionSource === "employer" && normalizedApprovedMinutes !== requestedMinutes) {
      throw ShiftOvertimeService.createError({
        message:
          "Employer approval must accept the professional's requested overtime minutes exactly.",
        code: "EMPLOYER_OVERTIME_PARTIAL_APPROVAL_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    if (!["employer", "admin"].includes(decisionSource)) {
      throw ShiftOvertimeService.createError({
        message: "Final overtime decision source is invalid.",
        code: "INVALID_OVERTIME_DECISION_SOURCE",
        statusCode: 500,
      });
    }

    const professionalPay = ShiftOvertimeService.calculateApprovedProfessionalPay({
      occurrence,
      approvedMinutes: normalizedApprovedMinutes,
    });

    occurrence.set("overtime.status", "approved");

    occurrence.set("overtime.decisionSource", decisionSource);

    occurrence.set("overtime.approvedMinutes", normalizedApprovedMinutes);

    occurrence.set("overtime.approvedAt", approvedAt);

    occurrence.set("overtime.approvedBy", approvedBy);

    occurrence.overtimeProfessionalPay = professionalPay;

    const feeResult = ShiftPlatformFeeService.earnOvertimePlatformFee({
      occurrence,
      earnedAt: approvedAt,
    });

    const fundingResult = await ShiftOvertimeFundingService.establishApprovedOvertimeFunding({
      occurrence,
      establishedAt: approvedAt,
      session,
    });

    return {
      occurrence,
      approvedMinutes: normalizedApprovedMinutes,
      professionalPay,
      platformFee: Number(occurrence.overtimePlatformFee || 0),
      feeResult,
      fundingResult,
    };
  }

  static async approveOvertimeByEmployer(
    {
      occurrenceId,
      employerProfileId,
      employerUserId,
      employerContext = null,
      decidedAt = new Date(),
    },
    options = {}
  ) {
    const normalizedDecidedAt = ShiftOvertimeService.normalizeDate(
      decidedAt,
      "employer overtime decision time"
    );

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const { employerUser } = await ShiftOvertimeService.assertEmployerCanDecide({
        occurrence,
        employerProfileId,
        employerUserId,
        employerContext,
        session,
      });

      if (
        occurrence.overtime?.status === "approved" &&
        occurrence.overtime?.decisionSource === "employer"
      ) {
        return {
          occurrence,
          idempotent: true,
        };
      }

      ShiftOvertimeService.assertEmployerDecisionAvailable({
        occurrence,
        decidedAt: normalizedDecidedAt,
      });

      const requestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        occurrence.overtime?.requestedMinutes,
        "requested overtime minutes"
      );

      occurrence.set("overtime.employerRespondedAt", normalizedDecidedAt);

      occurrence.set("overtime.employerResponseOverdueAt", null);

      occurrence.set("overtime.rejectedAt", null);

      occurrence.set("overtime.rejectedBy", null);

      occurrence.set("overtime.rejectionBasis", null);

      occurrence.set("overtime.rejectionReason", null);

      occurrence.set("overtime.employerProposedMinutes", null);

      occurrence.set("overtime.rejectionEvidence", []);

      occurrence.set("overtime.rejectionNoSupportingEvidence", false);

      occurrence.set("overtime.adminReviewReason", null);

      occurrence.set("overtime.adminReviewStartedAt", null);

      occurrence.set("overtime.adminEvidence", []);

      occurrence.set("overtime.adminDecision", null);

      occurrence.set("overtime.adminDecidedAt", null);

      occurrence.set("overtime.adminDecidedBy", null);

      occurrence.set("overtime.adminDecisionReason", null);

      await ShiftOvertimeService.stageFinalApproval({
        occurrence,
        approvedBy: employerUser,
        approvedAt: normalizedDecidedAt,
        approvedMinutes: requestedMinutes,
        decisionSource: "employer",
        session,
      });

      await occurrence.save({
        session,
      });

      logger.info(`Employer approved overtime for occurrence ${occurrence.referenceCode}.`);

      return {
        occurrence,
        idempotent: false,
      };
    });
  }

  static async rejectOvertimeByEmployer(
    {
      occurrenceId,
      employerProfileId,
      employerUserId,
      employerContext = null,
      rejectionBasis,
      rejectionReason,
      employerProposedMinutes = null,
      rejectionEvidence = [],
      rejectionNoSupportingEvidence = false,
      decidedAt = new Date(),
    },
    options = {}
  ) {
    const normalizedDecidedAt = ShiftOvertimeService.normalizeDate(
      decidedAt,
      "employer overtime rejection time"
    );

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const { employerUser } = await ShiftOvertimeService.assertEmployerCanDecide({
        occurrence,
        employerProfileId,
        employerUserId,
        employerContext,
        session,
      });

      const normalizedBasis = ShiftOvertimeService.normalizeRejectionBasis(rejectionBasis);

      const normalizedReason = ShiftOvertimeService.normalizeRequiredText(
        rejectionReason,
        "Overtime rejection reason",
        {
          maxLength: MAX_OVERTIME_REJECTION_REASON_LENGTH,
        }
      );

      let normalizedEmployerProposedMinutes = null;

      if (normalizedBasis === "minutes_incorrect") {
        normalizedEmployerProposedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
          employerProposedMinutes,
          "employer proposed overtime minutes"
        );

        const requested = ShiftOvertimeService.normalizePositiveMinutes(
          occurrence.overtime?.requestedMinutes,
          "requested overtime minutes"
        );

        if (normalizedEmployerProposedMinutes >= requested) {
          throw ShiftOvertimeService.createError({
            message:
              "Employer proposed overtime minutes must be lower than the professional's requested minutes.",
            code: "INVALID_EMPLOYER_PROPOSED_OVERTIME_MINUTES",
            statusCode: 409,
          });
        }
      } else if (
        employerProposedMinutes !== null &&
        employerProposedMinutes !== undefined &&
        employerProposedMinutes !== ""
      ) {
        throw ShiftOvertimeService.createError({
          message:
            "Employer proposed overtime minutes may only be supplied when the rejection basis is minutes_incorrect.",
          code: "EMPLOYER_PROPOSED_MINUTES_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      const normalizedEvidence = ShiftOvertimeService.normalizeEvidence(rejectionEvidence, {
        submittedByRole: "employer",
        submittedByUser: employerUser,
        recordedAt: normalizedDecidedAt,
      });

      if (normalizedEvidence.length === 0 && rejectionNoSupportingEvidence !== true) {
        throw ShiftOvertimeService.createError({
          message:
            "Employer overtime rejection without documentary evidence requires an explicit no-supporting-evidence declaration.",
          code: "OVERTIME_REJECTION_EVIDENCE_DECLARATION_REQUIRED",
          statusCode: 409,
        });
      }

      if (normalizedEvidence.length > 0 && rejectionNoSupportingEvidence === true) {
        throw ShiftOvertimeService.createError({
          message:
            "The employer cannot declare no supporting evidence when rejection evidence is supplied.",
          code: "OVERTIME_REJECTION_EVIDENCE_DECLARATION_CONFLICT",
          statusCode: 409,
        });
      }

      if (
        occurrence.overtime?.status === "disputed" &&
        occurrence.overtime?.adminReviewReason === "employer_rejection" &&
        occurrence.overtime?.rejectedAt &&
        occurrence.overtime?.rejectedBy &&
        String(occurrence.overtime.rejectedBy) === String(employerUser) &&
        occurrence.overtime?.rejectionBasis === normalizedBasis &&
        occurrence.overtime?.rejectionReason === normalizedReason &&
        Number(occurrence.overtime?.employerProposedMinutes || 0) ===
          Number(normalizedEmployerProposedMinutes || 0) &&
        occurrence.overtime?.rejectionNoSupportingEvidence === (normalizedEvidence.length === 0) &&
        ShiftOvertimeService.getEvidenceSignature(occurrence.overtime?.rejectionEvidence) ===
          ShiftOvertimeService.getEvidenceSignature(normalizedEvidence)
      ) {
        return {
          occurrence,
          idempotent: true,
        };
      }

      ShiftOvertimeService.assertEmployerDecisionAvailable({
        occurrence,
        decidedAt: normalizedDecidedAt,
      });

      ShiftOvertimeService.stageEmployerRejection({
        occurrence,
        employerUserId: employerUser,
        rejectedAt: normalizedDecidedAt,
        rejectionBasis: normalizedBasis,
        rejectionReason: normalizedReason,
        employerProposedMinutes: normalizedEmployerProposedMinutes,
        rejectionEvidence: normalizedEvidence,
        rejectionNoSupportingEvidence: normalizedEvidence.length === 0,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Employer rejected overtime for occurrence ${occurrence.referenceCode}; admin review opened.`
      );

      return {
        occurrence,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── EMPLOYER RESPONSE EXPIRY ─────────────────────────────── */

  static async expireEmployerResponse({ occurrenceId, currentTime = new Date() }, options = {}) {
    const now = ShiftOvertimeService.normalizeDate(currentTime, "current time");

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const overtime = occurrence.overtime || {};

      if (
        overtime.requested === true &&
        overtime.status === "disputed" &&
        overtime.adminReviewReason === "employer_non_response" &&
        overtime.employerResponseOverdueAt &&
        !overtime.employerRespondedAt
      ) {
        return {
          occurrence,
          expired: true,
          idempotent: true,
        };
      }

      if (overtime.requested !== true || overtime.status !== "pending") {
        return {
          occurrence,
          expired: false,
          idempotent: true,
        };
      }

      if (overtime.employerRespondedAt) {
        return {
          occurrence,
          expired: false,
          idempotent: true,
        };
      }

      if (!overtime.employerResponseDeadlineAt) {
        throw ShiftOvertimeService.createError({
          message: "Pending overtime is missing its employer response deadline.",
          code: "OVERTIME_RESPONSE_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      if (now < overtime.employerResponseDeadlineAt) {
        return {
          occurrence,
          expired: false,
          idempotent: true,
        };
      }

      ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

      occurrence.set("overtime.employerResponseOverdueAt", now);

      occurrence.set("overtime.decisionSource", null);

      ShiftOvertimeService.stageAdminReview({
        occurrence,
        reason: "employer_non_response",
        startedAt: now,
      });

      await occurrence.save({
        session,
      });

      logger.info(
        `Employer overtime response expired for occurrence ${occurrence.referenceCode}; admin review opened.`
      );

      return {
        occurrence,
        expired: true,
        idempotent: false,
      };
    });
  }

  static async processEmployerResponseExpiries(
    { currentTime = new Date(), limit = DEFAULT_EXPIRY_BATCH_LIMIT } = {},
    options = {}
  ) {
    const now = ShiftOvertimeService.normalizeDate(currentTime, "current time");

    const normalizedLimit = ShiftOvertimeService.normalizeExpiryBatchLimit(limit);

    const query = ShiftOccurrence.find({
      "overtime.requested": true,
      "overtime.status": "pending",
      "overtime.employerRespondedAt": null,
      "overtime.employerResponseOverdueAt": null,
      "overtime.employerResponseDeadlineAt": {
        $lte: now,
      },
    })
      .select("_id")
      .sort({
        "overtime.employerResponseDeadlineAt": 1,
      })
      .limit(normalizedLimit);

    if (options.session) {
      query.session(options.session);
    }

    const candidates = await query;

    const results = [];

    for (const candidate of candidates) {
      const result = await ShiftOvertimeService.expireEmployerResponse(
        {
          occurrenceId: candidate._id,
          currentTime: now,
        },
        options
      );

      results.push({
        occurrenceId: String(candidate._id),
        expired: result.expired,
        idempotent: result.idempotent,
      });
    }

    return {
      processed: results.length,
      results,
    };
  }

  /* ─────────────────────────────── ADMIN FINAL DECISION ─────────────────────────────── */

  static assertAdminDecisionAvailable(occurrence) {
    const overtime = occurrence.overtime || {};

    const adminReviewAvailable =
      overtime.requested === true &&
      overtime.status === "disputed" &&
      OVERTIME_ADMIN_REVIEW_REASONS.includes(String(overtime.adminReviewReason || "")) &&
      Boolean(overtime.adminReviewStartedAt) &&
      !overtime.adminDecision &&
      !overtime.adminDecidedAt &&
      !overtime.adminDecidedBy;

    if (!adminReviewAvailable) {
      throw ShiftOvertimeService.createError({
        message: "Admin cannot decide this overtime request in its current state.",
        code: "OVERTIME_ADMIN_DECISION_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    if (
      overtime.adminReviewReason === "employer_rejection" &&
      (!overtime.employerRespondedAt ||
        !overtime.rejectedAt ||
        !overtime.rejectedBy ||
        !overtime.rejectionBasis ||
        !overtime.rejectionReason)
    ) {
      throw ShiftOvertimeService.createError({
        message: "Employer-rejected overtime has an incomplete rejection audit.",
        code: "OVERTIME_REJECTION_AUDIT_INCOMPLETE",
        statusCode: 500,
      });
    }

    if (
      overtime.adminReviewReason === "employer_non_response" &&
      (!overtime.employerResponseOverdueAt || overtime.employerRespondedAt)
    ) {
      throw ShiftOvertimeService.createError({
        message: "Employer-non-response overtime has an incomplete expiry audit.",
        code: "OVERTIME_NON_RESPONSE_AUDIT_INCOMPLETE",
        statusCode: 500,
      });
    }

    return {
      adminReviewReason: overtime.adminReviewReason,
      adminReviewStartedAt: overtime.adminReviewStartedAt,
    };
  }

  static async decideOvertimeByAdmin(
    {
      occurrenceId,
      adminUserId,
      decision,
      decisionReason,
      approvedMinutes = null,
      adminEvidence = [],
      decidedAt = new Date(),
    },
    options = {}
  ) {
    const normalizedAdminUserId = ShiftOvertimeService.normalizeAdminUserId(adminUserId);

    const normalizedDecision = ShiftOvertimeService.normalizeAdminDecision(decision);

    const normalizedDecisionReason = ShiftOvertimeService.normalizeRequiredText(
      decisionReason,
      "Admin overtime decision reason",
      {
        maxLength: MAX_ADMIN_DECISION_REASON_LENGTH,
      }
    );

    const normalizedDecidedAt = ShiftOvertimeService.normalizeDate(
      decidedAt,
      "admin overtime decision time"
    );

    let normalizedApprovedMinutes = null;

    if (normalizedDecision === "approved") {
      normalizedApprovedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        approvedMinutes,
        "approved overtime minutes"
      );
    } else if (
      approvedMinutes !== null &&
      approvedMinutes !== undefined &&
      approvedMinutes !== ""
    ) {
      throw ShiftOvertimeService.createError({
        message: "approvedMinutes may only be supplied for an approved admin decision.",
        code: "OVERTIME_APPROVED_MINUTES_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    const normalizedAdminEvidence = ShiftOvertimeService.normalizeEvidence(adminEvidence, {
      submittedByRole: "admin",
      submittedByUser: normalizedAdminUserId,
      recordedAt: normalizedDecidedAt,
    });

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const overtime = occurrence.overtime || {};

      if (
        overtime.decisionSource === "admin" &&
        overtime.adminDecision === normalizedDecision &&
        String(overtime.adminDecidedBy || "") === String(normalizedAdminUserId) &&
        overtime.adminDecisionReason === normalizedDecisionReason &&
        Number(overtime.approvedMinutes || 0) === Number(normalizedApprovedMinutes || 0) &&
        ShiftOvertimeService.getEvidenceSignature(overtime.adminEvidence) ===
          ShiftOvertimeService.getEvidenceSignature(normalizedAdminEvidence)
      ) {
        return {
          occurrence,
          decisionPath: overtime.adminReviewReason || null,
          idempotent: true,
        };
      }

      const decisionPath = ShiftOvertimeService.assertAdminDecisionAvailable(occurrence);

      if (normalizedDecidedAt < decisionPath.adminReviewStartedAt) {
        throw ShiftOvertimeService.createError({
          message: "Admin overtime decision cannot predate admin review.",
          code: "OVERTIME_ADMIN_DECISION_TOO_EARLY",
          statusCode: 409,
          details: {
            adminReviewStartedAt: decisionPath.adminReviewStartedAt,
          },
        });
      }

      ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

      occurrence.set("overtime.adminEvidence", normalizedAdminEvidence);

      occurrence.set("overtime.adminDecision", normalizedDecision);

      occurrence.set("overtime.adminDecidedAt", normalizedDecidedAt);

      occurrence.set("overtime.adminDecidedBy", normalizedAdminUserId);

      occurrence.set("overtime.adminDecisionReason", normalizedDecisionReason);

      occurrence.set("overtime.decisionSource", "admin");

      if (normalizedDecision === "approved") {
        await ShiftOvertimeService.stageFinalApproval({
          occurrence,
          approvedBy: normalizedAdminUserId,
          approvedAt: normalizedDecidedAt,
          approvedMinutes: normalizedApprovedMinutes,
          decisionSource: "admin",
          session,
        });
      } else {
        occurrence.set("overtime.status", "rejected");

        occurrence.set("overtime.approvedMinutes", null);

        occurrence.set("overtime.approvedAt", null);

        occurrence.set("overtime.approvedBy", null);

        ShiftOvertimeService.synchronizeNonFundingSettlementStatus(occurrence);
      }

      await occurrence.save({
        session,
      });

      logger.info(
        `Admin ${normalizedDecision} overtime for occurrence ${occurrence.referenceCode}.`
      );

      return {
        occurrence,
        decisionPath: decisionPath.adminReviewReason,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── READ STATE ─────────────────────────────── */

  static async getOvertimeState({ occurrenceId, currentTime = new Date() }, options = {}) {
    const now = ShiftOvertimeService.normalizeDate(currentTime, "current time");

    const occurrence = await ShiftOvertimeService.getOccurrence(
      occurrenceId,
      options.session || null
    );

    const overtime = occurrence.overtime || {};

    const challengeableComponents = Array.isArray(occurrence.challengeableSettlementComponents)
      ? occurrence.challengeableSettlementComponents.map(String)
      : [];

    const requestWindowOpen = Boolean(
      !overtime.requested &&
      challengeableComponents.includes("overtime") &&
      occurrence.challengeWindowOpenedAt &&
      occurrence.challengeDeadlineAt &&
      !occurrence.challengeWindowClosedAt &&
      now < occurrence.challengeDeadlineAt
    );

    const employerCanRespond = Boolean(
      overtime.requested === true &&
      overtime.status === "pending" &&
      !overtime.employerRespondedAt &&
      !overtime.employerResponseOverdueAt &&
      overtime.employerResponseDeadlineAt &&
      now < overtime.employerResponseDeadlineAt
    );

    const adminCanDecide = Boolean(
      overtime.requested === true &&
      overtime.status === "disputed" &&
      OVERTIME_ADMIN_REVIEW_REASONS.includes(String(overtime.adminReviewReason || "")) &&
      overtime.adminReviewStartedAt &&
      !overtime.adminDecision &&
      !overtime.adminDecidedAt
    );

    return {
      occurrenceId: String(occurrence._id),

      occurrenceReferenceCode: occurrence.referenceCode,

      requested: overtime.requested === true,

      requestWindowOpen,

      source: overtime.source || null,

      requestedBy: overtime.requestedBy || null,

      requestedMinutes: overtime.requestedMinutes || null,

      requestStatement: overtime.requestStatement || null,

      requestEvidence: Array.isArray(overtime.requestEvidence) ? overtime.requestEvidence : [],

      requestedAt: overtime.requestedAt || null,

      status: overtime.status || null,

      decisionSource: overtime.decisionSource || null,

      employerResponseDeadlineAt: overtime.employerResponseDeadlineAt || null,

      employerRespondedAt: overtime.employerRespondedAt || null,

      employerResponseOverdueAt: overtime.employerResponseOverdueAt || null,

      employerCanRespond,

      rejectedAt: overtime.rejectedAt || null,

      rejectedBy: overtime.rejectedBy || null,

      rejectionBasis: overtime.rejectionBasis || null,

      rejectionReason: overtime.rejectionReason || null,

      employerProposedMinutes: overtime.employerProposedMinutes || null,

      rejectionEvidence: Array.isArray(overtime.rejectionEvidence)
        ? overtime.rejectionEvidence
        : [],

      rejectionNoSupportingEvidence: overtime.rejectionNoSupportingEvidence === true,

      adminReviewReason: overtime.adminReviewReason || null,

      adminReviewStartedAt: overtime.adminReviewStartedAt || null,

      adminEvidence: Array.isArray(overtime.adminEvidence) ? overtime.adminEvidence : [],

      adminDecision: overtime.adminDecision || null,

      adminDecidedAt: overtime.adminDecidedAt || null,

      adminDecidedBy: overtime.adminDecidedBy || null,

      adminDecisionReason: overtime.adminDecisionReason || null,

      adminCanDecide,

      approvedMinutes: overtime.approvedMinutes || null,

      approvedAt: overtime.approvedAt || null,

      approvedBy: overtime.approvedBy || null,

      professionalPay: Number(occurrence.overtimeProfessionalPay || 0),

      platformFee: Number(occurrence.overtimePlatformFee || 0),

      topUpRequired: Number(occurrence.topUpRequired || 0),

      topUpAmount: Number(overtime.topUpAmount || 0),

      topUpDeadlineAt: overtime.topUpDeadlineAt || null,

      topUpOverdueAt: overtime.topUpOverdueAt || null,

      restrictionTriggeredAt: overtime.restrictionTriggeredAt || null,

      topUpPaid: overtime.topUpPaid === true,

      topUpPaidAt: overtime.topUpPaidAt || null,
    };
  }
}

module.exports = ShiftOvertimeService;
