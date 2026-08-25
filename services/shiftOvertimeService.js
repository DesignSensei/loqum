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
  OVERTIME_STATUSES,
  OVERTIME_ADMIN_DECISIONS,
} = require("../constants/shiftLifecycle");

const money = require("../utils/money");
const logger = require("../utils/logger");

const SHIFT_OVERTIME_SERVICE_ERROR_NAME = "ShiftOvertimeServiceError";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

const DEFAULT_OVERTIME_APPEAL_HOURS = 24;

const DEFAULT_EXPIRY_BATCH_LIMIT = 100;
const MAX_EXPIRY_BATCH_LIMIT = 500;

const MAX_MANUAL_REQUEST_REASON_LENGTH = 300;
const MAX_REJECTION_REASON_LENGTH = 500;
const MAX_APPEAL_REASON_LENGTH = 1000;
const MAX_ADMIN_DECISION_REASON_LENGTH = 1000;

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
 * - manual OT request creation within the original 24-hour review window;
 * - employer approval;
 * - employer rejection;
 * - employer-response expiry;
 * - professional appeal of employer rejection;
 * - professional appeal expiry; and
 * - final admin approval/rejection after:
 *     - employer non-response; or
 *     - professional appeal.
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
 * Employer rejection does not create ShiftOccurrenceClaim.
 *
 * Instead:
 *
 * employer rejects
 * → professional receives one OT appeal opportunity
 * → appeal submitted
 * → admin decides finally
 *
 * Employer non-response:
 *
 * employer response deadline expires
 * → employer decision authority is lost
 * → admin decides OT directly
 *
 * FINAL APPROVAL
 *
 * Approval always approves the submitted requestedMinutes.
 *
 * There is no employer "partial approval" or later employer revision.
 *
 * Final approved professional OT pay is:
 *
 *   requestedMinutes × snapshotted hourlyRate
 *
 * using integer minor-unit money, BigInt arithmetic and deterministic
 * half-up rounding through utils/money.js.
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
 * SHARED 24-HOUR WINDOW
 *
 * A manual OT request may still be created after the professional has submitted
 * an ordinary claim, provided:
 *
 * - no OT request already exists; and
 * - the original occurrence challengeDeadlineAt has not expired.
 *
 * Ordinary claim submission therefore does not destroy the remaining manual OT
 * request opportunity.
 *
 * Once OT is requested, the overtime review selection is consumed. The
 * occurrence may continue to retain a BASE ordinary challenge opportunity
 * until the shared challenge deadline expires.
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

  static getProfessionalAppealHours() {
    return DEFAULT_OVERTIME_APPEAL_HOURS;
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

    return true;
  }

  static getObservedOvertimeMinutes(occurrence) {
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

  static assertApprovedRequestIsSupportedByAttendance(occurrence) {
    const requestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      occurrence.overtime?.requestedMinutes,
      "requested overtime minutes"
    );

    const observedMinutes = ShiftOvertimeService.getObservedOvertimeMinutes(occurrence);

    if (requestedMinutes > observedMinutes) {
      throw ShiftOvertimeService.createError({
        message: "The requested overtime exceeds the currently authoritative attendance record.",
        code: "OVERTIME_EXCEEDS_AUTHORITATIVE_ATTENDANCE",
        statusCode: 409,
        details: {
          requestedMinutes,
          observedMinutes,
        },
      });
    }

    return {
      requestedMinutes,
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

  static calculateApprovedProfessionalPay(occurrence) {
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

    const requestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
      occurrence.overtime?.requestedMinutes,
      "requested overtime minutes"
    );

    let professionalPay;

    try {
      professionalPay = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: hourlyRate,

        minutes: requestedMinutes,

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

    if (
      overtime.status === "pending" ||
      (overtime.status === "rejected" && overtime.appealStatus === "available")
    ) {
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

  /* ─────────────────────────────── REQUEST CREATION ─────────────────────────────── */

  static async stageOvertimeRequest({
    occurrence,
    professionalUserId,
    requestedMinutes = null,
    source,
    reason = null,
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

    await ShiftOvertimeService.assertProfessionalOwnsOccurrence({
      occurrence,
      professionalUserId,
      session,
    });

    ShiftOvertimeService.assertOccurrenceCanReceiveOvertimeRequest(occurrence);

    ShiftOvertimeService.assertNoExistingOvertimeRequest(occurrence);

    let finalRequestedMinutes;
    let finalReason = null;

    if (normalizedSource === "late_checkout_prompt") {
      if (occurrence.lateCheckout?.occurred !== true) {
        throw ShiftOvertimeService.createError({
          message: "Late-checkout overtime requires an established late checkout.",
          code: "LATE_CHECKOUT_REQUIRED_FOR_OVERTIME",
          statusCode: 409,
        });
      }

      finalRequestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        occurrence.lateCheckout.minutesLate,
        "late-checkout overtime minutes"
      );

      if (
        requestedMinutes !== null &&
        requestedMinutes !== undefined &&
        Number(requestedMinutes) !== finalRequestedMinutes
      ) {
        throw ShiftOvertimeService.createError({
          message: "Late-checkout overtime minutes must match the recorded late-checkout minutes.",
          code: "LATE_CHECKOUT_OVERTIME_MINUTES_MISMATCH",
          statusCode: 409,
        });
      }

      occurrence.lateCheckout.selectedOption = "overtime_requested";

      occurrence.lateCheckout.reason = null;

      finalReason = null;
    } else {
      ShiftOvertimeService.assertManualRequestWindowOpen({
        occurrence,
        requestedAt: normalizedRequestedAt,
      });

      finalRequestedMinutes = ShiftOvertimeService.normalizePositiveMinutes(
        requestedMinutes,
        "requested overtime minutes"
      );

      finalReason = ShiftOvertimeService.normalizeRequiredText(reason, "Overtime request reason", {
        maxLength: MAX_MANUAL_REQUEST_REASON_LENGTH,
      });
    }

    const employerResponseHours = ShiftOvertimeService.getEmployerResponseHours(settings);

    const employerResponseDeadlineAt = new Date(
      normalizedRequestedAt.getTime() + employerResponseHours * MILLISECONDS_PER_HOUR
    );

    occurrence.set("overtime.requested", true);

    occurrence.set(
      "overtime.requestedBy",
      ShiftOvertimeService.normalizeObjectId(professionalUserId, "professional user ID")
    );

    occurrence.set("overtime.requestedAt", normalizedRequestedAt);

    occurrence.set("overtime.source", normalizedSource);

    occurrence.set("overtime.reason", finalReason);

    occurrence.set("overtime.requestedMinutes", finalRequestedMinutes);

    occurrence.set("overtime.status", "pending");

    occurrence.set("overtime.decisionSource", null);

    occurrence.set("overtime.employerResponseDeadlineAt", employerResponseDeadlineAt);

    occurrence.set("overtime.employerRespondedAt", null);

    occurrence.set("overtime.employerResponseOverdueAt", null);

    occurrence.set("overtime.approvedAt", null);

    occurrence.set("overtime.approvedBy", null);

    occurrence.set("overtime.rejectedAt", null);

    occurrence.set("overtime.rejectedBy", null);

    occurrence.set("overtime.rejectionReason", null);

    occurrence.set("overtime.appealStatus", "not_available");

    occurrence.set("overtime.appealDeadlineAt", null);

    occurrence.set("overtime.appealedAt", null);

    occurrence.set("overtime.appealedBy", null);

    occurrence.set("overtime.appealReason", null);

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
      requestedAt: normalizedRequestedAt,
      employerResponseDeadlineAt,
      source: normalizedSource,
    };
  }

  static async createOvertimeRequest(
    {
      occurrenceId,
      professionalUserId,
      requestedMinutes = null,
      source,
      reason = null,
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

      if (occurrence.overtime?.requested === true) {
        const normalizedUserId = ShiftOvertimeService.normalizeObjectId(
          professionalUserId,
          "professional user ID"
        );

        const requestedMinutesMatch =
          requestedMinutes === null ||
          requestedMinutes === undefined ||
          Number(requestedMinutes) === Number(occurrence.overtime.requestedMinutes);

        const matches =
          String(occurrence.overtime.requestedBy) === String(normalizedUserId) &&
          occurrence.overtime.source === normalizedSource &&
          requestedMinutesMatch;

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
        professionalUserId,
        requestedMinutes,
        source: normalizedSource,
        reason,
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

  static stageEmployerRejection({ occurrence, employerUserId, rejectedAt, rejectionReason }) {
    const reason = ShiftOvertimeService.normalizeRequiredText(
      rejectionReason,
      "Overtime rejection reason",
      {
        maxLength: MAX_REJECTION_REASON_LENGTH,
      }
    );

    const appealHours = ShiftOvertimeService.getProfessionalAppealHours();

    occurrence.set("overtime.status", "rejected");

    occurrence.set("overtime.decisionSource", null);

    occurrence.set("overtime.employerRespondedAt", rejectedAt);

    occurrence.set("overtime.rejectedAt", rejectedAt);

    occurrence.set("overtime.rejectedBy", employerUserId);

    occurrence.set("overtime.rejectionReason", reason);

    occurrence.set("overtime.appealStatus", "available");

    occurrence.set(
      "overtime.appealDeadlineAt",
      new Date(rejectedAt.getTime() + appealHours * MILLISECONDS_PER_HOUR)
    );

    occurrence.set("overtime.appealedAt", null);

    occurrence.set("overtime.appealedBy", null);

    occurrence.set("overtime.appealReason", null);

    occurrence.set("overtime.adminDecision", null);

    occurrence.set("overtime.adminDecidedAt", null);

    occurrence.set("overtime.adminDecidedBy", null);

    occurrence.set("overtime.adminDecisionReason", null);

    ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

    ShiftOvertimeService.synchronizeNonFundingSettlementStatus(occurrence);

    return occurrence;
  }

  static async stageFinalApproval({ occurrence, approvedBy, approvedAt, decisionSource, session }) {
    ShiftOvertimeService.assertApprovedRequestIsSupportedByAttendance(occurrence);

    const professionalPay = ShiftOvertimeService.calculateApprovedProfessionalPay(occurrence);

    occurrence.set("overtime.status", "approved");

    occurrence.set("overtime.decisionSource", decisionSource);

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

      occurrence.set("overtime.employerRespondedAt", normalizedDecidedAt);

      occurrence.set("overtime.employerResponseOverdueAt", null);

      occurrence.set("overtime.rejectedAt", null);

      occurrence.set("overtime.rejectedBy", null);

      occurrence.set("overtime.rejectionReason", null);

      occurrence.set("overtime.appealStatus", "not_available");

      occurrence.set("overtime.appealDeadlineAt", null);

      await ShiftOvertimeService.stageFinalApproval({
        occurrence,
        approvedBy: employerUser,
        approvedAt: normalizedDecidedAt,
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
      rejectionReason,
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

      const normalizedReason = ShiftOvertimeService.normalizeRequiredText(
        rejectionReason,
        "Overtime rejection reason",
        {
          maxLength: MAX_REJECTION_REASON_LENGTH,
        }
      );

      if (
        occurrence.overtime?.status === "rejected" &&
        occurrence.overtime?.rejectedAt &&
        occurrence.overtime?.rejectedBy &&
        String(occurrence.overtime.rejectedBy) === String(employerUser) &&
        occurrence.overtime?.rejectionReason === normalizedReason
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
        rejectionReason: normalizedReason,
      });

      await occurrence.save({
        session,
      });

      logger.info(`Employer rejected overtime for occurrence ${occurrence.referenceCode}.`);

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

      if (overtime.employerResponseOverdueAt) {
        return {
          occurrence,
          expired: true,
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

      occurrence.set("overtime.employerResponseOverdueAt", now);

      occurrence.set("overtime.decisionSource", null);

      ShiftOvertimeService.synchronizeNonFundingSettlementStatus(occurrence);

      await occurrence.save({
        session,
      });

      logger.info(`Employer overtime response expired for occurrence ${occurrence.referenceCode}.`);

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

  /* ─────────────────────────────── PROFESSIONAL APPEAL ─────────────────────────────── */

  static async appealEmployerRejection(
    { occurrenceId, professionalUserId, appealReason, appealedAt = new Date() },
    options = {}
  ) {
    const normalizedAppealedAt = ShiftOvertimeService.normalizeDate(
      appealedAt,
      "overtime appeal time"
    );

    const normalizedAppealReason = ShiftOvertimeService.normalizeRequiredText(
      appealReason,
      "Overtime appeal reason",
      {
        maxLength: MAX_APPEAL_REASON_LENGTH,
      }
    );

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const { userId } = await ShiftOvertimeService.assertProfessionalOwnsOccurrence({
        occurrence,
        professionalUserId,
        session,
      });

      const overtime = occurrence.overtime || {};

      if (
        overtime.status === "disputed" &&
        overtime.appealStatus === "submitted" &&
        String(overtime.appealedBy) === String(userId) &&
        overtime.appealReason === normalizedAppealReason
      ) {
        return {
          occurrence,
          idempotent: true,
        };
      }

      if (
        overtime.requested !== true ||
        overtime.status !== "rejected" ||
        overtime.appealStatus !== "available"
      ) {
        throw ShiftOvertimeService.createError({
          message: "This overtime request is not available for appeal.",
          code: "OVERTIME_APPEAL_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      if (
        !overtime.rejectedAt ||
        !overtime.rejectedBy ||
        !overtime.rejectionReason ||
        !overtime.appealDeadlineAt
      ) {
        throw ShiftOvertimeService.createError({
          message: "Employer-rejected overtime has an incomplete appeal audit.",
          code: "OVERTIME_REJECTION_AUDIT_INCOMPLETE",
          statusCode: 500,
        });
      }

      if (normalizedAppealedAt >= overtime.appealDeadlineAt) {
        throw ShiftOvertimeService.createError({
          message: "The overtime appeal window has expired.",
          code: "OVERTIME_APPEAL_WINDOW_EXPIRED",
          statusCode: 409,
          details: {
            appealDeadlineAt: overtime.appealDeadlineAt,
          },
        });
      }

      ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

      occurrence.set("overtime.status", "disputed");

      occurrence.set("overtime.appealStatus", "submitted");

      occurrence.set("overtime.appealedAt", normalizedAppealedAt);

      occurrence.set("overtime.appealedBy", userId);

      occurrence.set("overtime.appealReason", normalizedAppealReason);

      occurrence.set("overtime.decisionSource", null);

      occurrence.settlementStatus = "disputed";

      await occurrence.save({
        session,
      });

      logger.info(
        `Professional appealed overtime rejection for occurrence ${occurrence.referenceCode}.`
      );

      return {
        occurrence,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── APPEAL EXPIRY ─────────────────────────────── */

  static async expireProfessionalAppeal({ occurrenceId, currentTime = new Date() }, options = {}) {
    const now = ShiftOvertimeService.normalizeDate(currentTime, "current time");

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const overtime = occurrence.overtime || {};

      if (overtime.status !== "rejected" || overtime.appealStatus !== "available") {
        return {
          occurrence,
          expired: false,
          idempotent: true,
        };
      }

      if (!overtime.appealDeadlineAt) {
        throw ShiftOvertimeService.createError({
          message: "Employer-rejected overtime is missing appealDeadlineAt.",
          code: "OVERTIME_APPEAL_DEADLINE_MISSING",
          statusCode: 500,
        });
      }

      if (now < overtime.appealDeadlineAt) {
        return {
          occurrence,
          expired: false,
          idempotent: true,
        };
      }

      ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

      occurrence.set("overtime.appealStatus", "expired");

      occurrence.set("overtime.decisionSource", "employer");

      ShiftOvertimeService.synchronizeNonFundingSettlementStatus(occurrence);

      await occurrence.save({
        session,
      });

      logger.info(`Overtime appeal expired for occurrence ${occurrence.referenceCode}.`);

      return {
        occurrence,
        expired: true,
        idempotent: false,
      };
    });
  }

  static async processProfessionalAppealExpiries(
    { currentTime = new Date(), limit = DEFAULT_EXPIRY_BATCH_LIMIT } = {},
    options = {}
  ) {
    const now = ShiftOvertimeService.normalizeDate(currentTime, "current time");

    const normalizedLimit = ShiftOvertimeService.normalizeExpiryBatchLimit(limit);

    const query = ShiftOccurrence.find({
      "overtime.requested": true,
      "overtime.status": "rejected",
      "overtime.appealStatus": "available",
      "overtime.appealDeadlineAt": {
        $lte: now,
      },
    })
      .select("_id")
      .sort({
        "overtime.appealDeadlineAt": 1,
      })
      .limit(normalizedLimit);

    if (options.session) {
      query.session(options.session);
    }

    const candidates = await query;

    const results = [];

    for (const candidate of candidates) {
      const result = await ShiftOvertimeService.expireProfessionalAppeal(
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

    const afterEmployerNonResponse =
      overtime.requested === true &&
      overtime.status === "pending" &&
      Boolean(overtime.employerResponseOverdueAt) &&
      !overtime.employerRespondedAt;

    const afterProfessionalAppeal =
      overtime.requested === true &&
      overtime.status === "disputed" &&
      overtime.appealStatus === "submitted" &&
      Boolean(overtime.appealedAt) &&
      Boolean(overtime.appealedBy);

    if (!afterEmployerNonResponse && !afterProfessionalAppeal) {
      throw ShiftOvertimeService.createError({
        message: "Admin cannot decide this overtime request in its current state.",
        code: "OVERTIME_ADMIN_DECISION_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    return {
      afterEmployerNonResponse,
      afterProfessionalAppeal,
    };
  }

  static async decideOvertimeByAdmin(
    { occurrenceId, adminUserId, decision, decisionReason, decidedAt = new Date() },
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

    return ShiftOvertimeService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeService.getOccurrence(occurrenceId, session);

      const overtime = occurrence.overtime || {};

      if (
        overtime.decisionSource === "admin" &&
        overtime.adminDecision === normalizedDecision &&
        String(overtime.adminDecidedBy || "") === String(normalizedAdminUserId) &&
        overtime.adminDecisionReason === normalizedDecisionReason
      ) {
        return {
          occurrence,
          idempotent: true,
        };
      }

      const decisionPath = ShiftOvertimeService.assertAdminDecisionAvailable(occurrence);

      ShiftOvertimeService.assertNoFinalOvertimeFinancialState(occurrence);

      occurrence.set("overtime.adminDecision", normalizedDecision);

      occurrence.set("overtime.adminDecidedAt", normalizedDecidedAt);

      occurrence.set("overtime.adminDecidedBy", normalizedAdminUserId);

      occurrence.set("overtime.adminDecisionReason", normalizedDecisionReason);

      occurrence.set("overtime.decisionSource", "admin");

      if (decisionPath.afterProfessionalAppeal) {
        occurrence.set("overtime.appealStatus", "resolved");
      } else {
        occurrence.set("overtime.appealStatus", "not_available");

        occurrence.set("overtime.appealDeadlineAt", null);
      }

      if (normalizedDecision === "approved") {
        await ShiftOvertimeService.stageFinalApproval({
          occurrence,
          approvedBy: normalizedAdminUserId,
          approvedAt: normalizedDecidedAt,
          decisionSource: "admin",
          session,
        });
      } else {
        occurrence.set("overtime.status", "rejected");

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

        decisionPath: decisionPath.afterProfessionalAppeal
          ? "professional_appeal"
          : "employer_non_response",

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

    const requestWindowOpen = Boolean(
      !overtime.requested &&
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

    const professionalCanAppeal = Boolean(
      overtime.status === "rejected" &&
      overtime.appealStatus === "available" &&
      overtime.appealDeadlineAt &&
      now < overtime.appealDeadlineAt
    );

    const adminCanDecide = Boolean(
      (overtime.status === "pending" &&
        overtime.employerResponseOverdueAt &&
        !overtime.employerRespondedAt) ||
      (overtime.status === "disputed" && overtime.appealStatus === "submitted")
    );

    return {
      occurrenceId: String(occurrence._id),

      occurrenceReferenceCode: occurrence.referenceCode,

      requested: overtime.requested === true,

      requestWindowOpen,

      source: overtime.source || null,

      requestedMinutes: overtime.requestedMinutes || null,

      requestedAt: overtime.requestedAt || null,

      status: overtime.status || null,

      decisionSource: overtime.decisionSource || null,

      employerResponseDeadlineAt: overtime.employerResponseDeadlineAt || null,

      employerRespondedAt: overtime.employerRespondedAt || null,

      employerResponseOverdueAt: overtime.employerResponseOverdueAt || null,

      employerCanRespond,

      rejectionReason: overtime.rejectionReason || null,

      appealStatus: overtime.appealStatus || "not_available",

      appealDeadlineAt: overtime.appealDeadlineAt || null,

      appealedAt: overtime.appealedAt || null,

      professionalCanAppeal,

      adminDecision: overtime.adminDecision || null,

      adminDecidedAt: overtime.adminDecidedAt || null,

      adminCanDecide,

      approvedAt: overtime.approvedAt || null,

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
