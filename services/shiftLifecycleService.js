// services/shiftLifecycleService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftAssignment = require("../models/ShiftAssignment");

const PlatformSettingsService = require("./platformSettingsService");
const ShiftSettlementService = require("./shiftSettlementService");
const ShiftRefundService = require("./shiftRefundService");
const ShiftApplicationService = require("./shiftApplicationService");
const ShiftOccurrenceReconciliationService = require("./shiftOccurrenceReconciliationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const {
  SHIFT_CANCELLABLE_FROM_STATUSES,
  REFUND_EXECUTION_STATUSES,
  EXPIRED_FROM_ASSIGNMENT_STATUSES,
} = require("../constants/shiftLifecycle");

const money = require("../utils/money");
const logger = require("../utils/logger");

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MAX_BATCH_SIZE = 500;

const EMPLOYER_CANCELLABLE_PARENT_STATUSES = Object.freeze(
  SHIFT_CANCELLABLE_FROM_STATUSES.filter((status) => status !== "pending_funding")
);

const TERMINAL_PARENT_STATUSES = Object.freeze(["completed", "cancelled", "disputed", "no_show"]);

const MANAGED_ASSIGNMENT_STATUSES = Object.freeze(["scheduled", "active", "ending"]);

const REFUND_EXECUTION_STARTED_STATUSES = Object.freeze([...REFUND_EXECUTION_STATUSES]);

const EXPIRABLE_ASSIGNMENT_STATUSES = Object.freeze([...EXPIRED_FROM_ASSIGNMENT_STATUSES]);

/**
 * SHIFT LIFECYCLE SERVICE ARCHITECTURE
 *
 * This service owns Shift / ShiftOccurrence lifecycle transitions.
 *
 * It may:
 *
 * - authorize an employer user to manage an existing Shift;
 * - determine the cancellation mode;
 * - calculate professional cancellation compensation;
 * - record cancellation / active-work-cancellation facts;
 * - expire unfunded parent Shifts when their funding deadline is reached;
 * - finalize funded unassigned / replacement-required occurrences when their
 *   persisted unfilledFinalizationAt deadline is reached;
 * - close or shrink the parent replacement-hiring tail after occurrence
 *   finalization;
 * - close affected assignments; and
 * - orchestrate downstream application cleanup, settlement, refund-obligation
 *   and parent reconciliation services.
 *
 * It does not:
 *
 * - decide whether the business may create a new obligation;
 * - use employerContext.canPostShifts as lifecycle authorization;
 * - calculate or backfill unfilledFinalizationAt;
 * - earn, recalculate, collect or reverse platform fees;
 * - own professional settlement component state;
 * - execute employer refunds;
 * - move protected funds; or
 * - rebuild parent Shift financial/occurrence summaries itself.
 *
 * UNFILLED-OCCURRENCE POLICY
 *
 * unfilledFinalizationAt is persisted upstream. This service consumes that
 * deadline; it does not derive one from startTime, endTime or fillCutoffAt.
 *
 * Ordinary unassigned occurrence:
 * - no professional was confirmed;
 * - base platform fee must therefore remain unearned; and
 * - the unused scheduled allocation becomes refundable.
 *
 * Replacement-required occurrence:
 * - the original assignment may already have earned the BASE platform fee;
 * - replacement failure does not un-earn that fee; and
 * - only the remaining scheduled allocation becomes refundable.
 *
 * PLATFORM-FEE POLICY
 *
 * Base platform fee is earned by the assignment/confirmation flow. Once
 * earned, cancellation or replacement failure does not recalculate or reverse
 * it. This service never edits basePlatformFeeAudit.
 *
 * REFUND POLICY
 *
 * For preview purposes, this service may forecast one scheduled occurrence as:
 *
 * refundable scheduled allocation
 *   = estimatedEmployerCharge
 *   - already-earned base platform fee
 *   - professional cancellation entitlement
 *
 * ShiftRefundService remains authoritative for the actual EmployerRefund
 * obligation, automatic holds and downstream execution eligibility. Weekly
 * EmployerRefundBatch remains the external refund execution owner.
 *
 * PARENT RECONCILIATION
 *
 * ShiftOccurrenceReconciliationService is aggregation only. Lifecycle truth is
 * changed here first, then reconciliation rebuilds the parent Shift summary.
 */

class ShiftLifecycleService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: "ShiftLifecycleServiceError",
      message,
      code,
      statusCode,
      details,
    });
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    return runWithOptionalTransaction(options, callback);
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

      throw ShiftLifecycleService.createError({
        message: `${fieldName} is required.`,
        code: `${ShiftLifecycleService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw ShiftLifecycleService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${ShiftLifecycleService.normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeReason(value, fieldName = "reason") {
    const reason = String(value || "").trim();

    if (!reason) {
      throw ShiftLifecycleService.createError({
        message: "A reason is required.",
        code: `${ShiftLifecycleService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (reason.length > 500) {
      throw ShiftLifecycleService.createError({
        message: "The reason cannot exceed 500 characters.",
        code: `${ShiftLifecycleService.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return reason;
  }

  static normalizeDate(value, fieldName = "date") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(date.getTime())) {
      throw ShiftLifecycleService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${ShiftLifecycleService.normalizeFieldCode(fieldName)}`,
      });
    }

    return date;
  }

  static normalizeBatchLimit(value) {
    const limit = Number(value || 100);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw ShiftLifecycleService.createError({
        message: `Batch limit must be a whole number between 1 and ${MAX_BATCH_SIZE}.`,
        code: "INVALID_BATCH_LIMIT",
      });
    }

    return limit;
  }

  /* ─────────────────────────────── EMPLOYER ACCESS ─────────────────────────────── */

  static assertEmployerCanManageExistingShifts(employerContext) {
    const canManageExistingShift = Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true
    );

    if (!canManageExistingShift) {
      throw ShiftLifecycleService.createError({
        message: "You do not have permission to cancel or end Shifts.",
        code: "SHIFT_LIFECYCLE_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
  }

  static canManageAllBranches(employerContext) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static getAssignedBranchIds(employerContext) {
    return (employerContext?.assignedBranchIds || [])
      .filter((branchId) => mongoose.isValidObjectId(branchId))
      .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));
  }

  static buildEmployerShiftFilter({ shiftId, employerProfileId, employerContext }) {
    ShiftLifecycleService.assertEmployerCanManageExistingShifts(employerContext);

    const filter = {
      _id: ShiftLifecycleService.normalizeObjectId(shiftId, "shift ID"),

      business: ShiftLifecycleService.normalizeObjectId(employerProfileId, "employer profile ID"),
    };

    if (!ShiftLifecycleService.canManageAllBranches(employerContext)) {
      const assignedBranchIds = ShiftLifecycleService.getAssignedBranchIds(employerContext);

      if (assignedBranchIds.length === 0) {
        throw ShiftLifecycleService.createError({
          message: "You are not assigned to a branch that can manage this Shift.",
          code: "SHIFT_BRANCH_ACCESS_NOT_AVAILABLE",
          statusCode: 403,
        });
      }

      filter.branch = {
        $in: assignedBranchIds,
      };
    }

    return filter;
  }

  static async getEmployerShift({ shiftId, employerProfileId, employerContext, session = null }) {
    const query = Shift.findOne(
      ShiftLifecycleService.buildEmployerShiftFilter({
        shiftId,
        employerProfileId,
        employerContext,
      })
    );

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftLifecycleService.createError({
        message: "Shift was not found or is not available to you.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getSystemShift({ shiftId, session = null }) {
    const normalizedShiftId = ShiftLifecycleService.normalizeObjectId(shiftId, "shift ID");

    const query = Shift.findById(normalizedShiftId);

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftLifecycleService.createError({
        message: "Shift not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getSystemOccurrence({ shiftId, occurrenceId, session = null }) {
    const normalizedShiftId = ShiftLifecycleService.normalizeObjectId(shiftId, "shift ID");

    const normalizedOccurrenceId = ShiftLifecycleService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = ShiftOccurrence.findOne({
      _id: normalizedOccurrenceId,
      shift: normalizedShiftId,
    });

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftLifecycleService.createError({
        message: "Shift occurrence not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static async getOccurrences({ shiftId, session = null }) {
    const query = ShiftOccurrence.find({
      shift: shiftId,
    }).sort({
      sequenceNumber: 1,
      startTime: 1,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  /* ─────────────────────────────── MONEY HELPERS ─────────────────────────────── */

  static assertSafeNonNegativeAmount(value, fieldName) {
    try {
      return money.normalizeMinorUnitAmount(value ?? 0, fieldName);
    } catch (error) {
      throw ShiftLifecycleService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${ShiftLifecycleService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }
  }

  static normalizeFinancialRate(
    rate,
    fieldName,
    {
      invalidMessage = `${fieldName} rate is invalid.`,
      precisionMessage = `${fieldName} rate exceeds the supported financial precision.`,
      code = `INVALID_${ShiftLifecycleService.normalizeFieldCode(fieldName)}_RATE`,
    } = {}
  ) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw ShiftLifecycleService.createError({
        message: invalidMessage,
        code,
        statusCode: 500,
      });
    }

    try {
      money.scaleRate({
        rate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: `${fieldName} rate`,
      });
    } catch (error) {
      throw ShiftLifecycleService.createError({
        message: precisionMessage,
        code,
        statusCode: 500,
      });
    }

    return rate;
  }

  static calculateRateAmount(amount, rate, fieldName) {
    const normalizedAmount = ShiftLifecycleService.assertSafeNonNegativeAmount(
      amount,
      `${fieldName} source amount`
    );

    const normalizedRate = ShiftLifecycleService.normalizeFinancialRate(rate, fieldName);

    try {
      return money.calculateMinorAmountFromRate({
        amountMinor: normalizedAmount,
        rate: normalizedRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName,
        rateFieldName: `${fieldName} rate`,
      });
    } catch (error) {
      throw ShiftLifecycleService.createError({
        message: `${fieldName} is invalid or too large.`,
        code: `INVALID_${ShiftLifecycleService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }
  }

  static calculateProfessionalPayForMinutes({ hourlyRate, workedMinutes }) {
    const normalizedHourlyRate = ShiftLifecycleService.assertSafeNonNegativeAmount(
      hourlyRate,
      "occurrence hourly rate"
    );

    if (normalizedHourlyRate <= 0) {
      throw ShiftLifecycleService.createError({
        message: "Occurrence hourly rate must be greater than zero.",
        code: "INVALID_OCCURRENCE_HOURLY_RATE",
        statusCode: 500,
      });
    }

    if (!Number.isSafeInteger(workedMinutes) || workedMinutes < 0) {
      throw ShiftLifecycleService.createError({
        message: "Worked minutes are invalid.",
        code: "INVALID_WORKED_MINUTES",
        statusCode: 500,
      });
    }

    try {
      return money.calculateMinorPayFromMinutes({
        hourlyRateMinor: normalizedHourlyRate,
        minutes: workedMinutes,
        fieldName: "Professional pay",
      });
    } catch (error) {
      throw ShiftLifecycleService.createError({
        message: "The calculated professional pay is invalid or too large.",
        code: "INVALID_CALCULATED_AMOUNT",
        statusCode: 500,
      });
    }
  }

  static addSafeAmounts(values, fieldName) {
    if (!Array.isArray(values)) {
      throw ShiftLifecycleService.createError({
        message: `${fieldName} values are invalid.`,
        code: `INVALID_${ShiftLifecycleService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    for (const value of values) {
      ShiftLifecycleService.assertSafeNonNegativeAmount(value, fieldName);
    }

    try {
      return money.sumMinorUnitAmounts(values, fieldName);
    } catch (error) {
      throw ShiftLifecycleService.createError({
        message: `${fieldName} is too large.`,
        code: `${ShiftLifecycleService.normalizeFieldCode(fieldName)}_TOO_LARGE`,
        statusCode: 500,
      });
    }
  }

  static buildMoneyView(amount, currency) {
    return {
      amount,
      display: money.formatMoney(amount || 0, currency || "NGN"),
    };
  }

  /* ─────────────────────────────── PLATFORM-FEE READS ─────────────────────────────── */

  static getRetainedBasePlatformFee(occurrence) {
    const basePlatformFee = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.basePlatformFee,
      "occurrence base platform fee"
    );

    const earnedAt = occurrence?.basePlatformFeeAudit?.earnedAt || null;

    if (!earnedAt) {
      if (basePlatformFee > 0) {
        throw ShiftLifecycleService.createError({
          message: "The occurrence contains a base platform fee without its earning audit.",
          code: "BASE_PLATFORM_FEE_EARNING_AUDIT_REQUIRED",
          statusCode: 500,
          details: {
            occurrenceId: occurrence?._id ? String(occurrence._id) : null,
            basePlatformFee,
          },
        });
      }

      return 0;
    }

    const normalizedEarnedAt = new Date(earnedAt);

    if (Number.isNaN(normalizedEarnedAt.getTime())) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence base platform-fee earning audit is invalid.",
        code: "INVALID_BASE_PLATFORM_FEE_EARNING_AUDIT",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    return basePlatformFee;
  }

  static calculateRefundableScheduledAllocation({ occurrence, professionalEntitlement = 0 }) {
    const estimatedEmployerCharge = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.estimatedEmployerCharge,
      "occurrence estimated employer charge"
    );

    const retainedBasePlatformFee = ShiftLifecycleService.getRetainedBasePlatformFee(occurrence);

    const normalizedProfessionalEntitlement = ShiftLifecycleService.assertSafeNonNegativeAmount(
      professionalEntitlement,
      "professional cancellation entitlement"
    );

    const retainedAmount = ShiftLifecycleService.addSafeAmounts(
      [retainedBasePlatformFee, normalizedProfessionalEntitlement],
      "retained occurrence allocation"
    );

    const refundableAmount = estimatedEmployerCharge - retainedAmount;

    if (!Number.isSafeInteger(refundableAmount) || refundableAmount < 0) {
      throw ShiftLifecycleService.createError({
        message:
          "The cancellation outcome exceeds the occurrence's protected scheduled allocation.",
        code: "CANCELLATION_OUTCOME_EXCEEDS_PROTECTED_ALLOCATION",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
          estimatedEmployerCharge,
          retainedBasePlatformFee,
          professionalEntitlement: normalizedProfessionalEntitlement,
        },
      });
    }

    return {
      estimatedEmployerCharge,
      retainedBasePlatformFee,
      professionalEntitlement: normalizedProfessionalEntitlement,
      retainedAmount,
      refundableAmount,
    };
  }

  /* ─────────────────────────────── OCCURRENCE RESOLUTION ─────────────────────────────── */

  static isOccurrenceCheckedIn(occurrence) {
    if (
      !occurrence ||
      occurrence.checkedOutAt ||
      occurrence.activeWorkCancellation?.occurred ||
      ["checked_out", "settled", "disputed", "no_show"].includes(occurrence.attendanceStatus)
    ) {
      return false;
    }

    return Boolean(
      occurrence.checkedInAt ||
      occurrence.attendanceStatus === "checked_in" ||
      occurrence.status === "in_progress"
    );
  }

  static getActiveOccurrence(occurrences) {
    const activeOccurrences = occurrences.filter(
      (occurrence) =>
        ShiftLifecycleService.isOccurrenceCheckedIn(occurrence) &&
        !["completed", "cancelled", "expired_unfilled", "no_show"].includes(occurrence.status)
    );

    if (activeOccurrences.length > 1) {
      throw ShiftLifecycleService.createError({
        message: "More than one active occurrence was found for this engagement.",
        code: "MULTIPLE_ACTIVE_OCCURRENCES_FOUND",
        statusCode: 409,
      });
    }

    return activeOccurrences[0] || null;
  }

  static getNextCancellableOccurrence(occurrences) {
    return (
      occurrences.find(
        (occurrence) =>
          occurrence.status === "scheduled" &&
          occurrence.attendanceStatus === "not_started" &&
          !occurrence.cancelledAt
      ) || null
    );
  }

  static getAffectedScheduledOccurrences(occurrences, firstAffectedSequenceNumber) {
    return occurrences.filter(
      (occurrence) =>
        Number(occurrence.sequenceNumber) >= Number(firstAffectedSequenceNumber) &&
        occurrence.status === "scheduled" &&
        occurrence.attendanceStatus === "not_started" &&
        !occurrence.cancelledAt
    );
  }

  static hasCompleteAssignment(occurrence) {
    return Boolean(
      occurrence?.assignmentStatus === "assigned" &&
      occurrence?.assignedProfessional &&
      occurrence?.assignment &&
      occurrence?.assignedAt
    );
  }

  static assertUntouchedScheduledCancellationState(occurrence) {
    if (
      occurrence.status !== "scheduled" ||
      occurrence.attendanceStatus !== "not_started" ||
      occurrence.checkedInAt ||
      occurrence.checkedOutAt ||
      occurrence.checkInPinUsedAt ||
      occurrence.checkOutPinUsedAt
    ) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence has attendance activity and cannot use scheduled cancellation.",
        code: "OCCURRENCE_NOT_AVAILABLE_FOR_SCHEDULED_CANCELLATION",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
          status: occurrence.status,
          attendanceStatus: occurrence.attendanceStatus,
        },
      });
    }

    const baseSettlementStatus = String(occurrence.baseSettlement?.status || "not_due")
      .trim()
      .toLowerCase();

    const overtimeSettlementStatus = String(occurrence.overtimeSettlement?.status || "not_due")
      .trim()
      .toLowerCase();

    if (baseSettlementStatus !== "not_due" || overtimeSettlementStatus !== "not_due") {
      throw ShiftLifecycleService.createError({
        message:
          "The occurrence has already entered professional settlement and cannot use scheduled cancellation.",
        code: "OCCURRENCE_SETTLEMENT_ALREADY_STARTED",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
          baseSettlementStatus,
          overtimeSettlementStatus,
        },
      });
    }

    if (
      occurrence.overtime?.requested === true ||
      Number(occurrence.overtimeProfessionalPay || 0) > 0 ||
      Number(occurrence.overtimePlatformFee || 0) > 0 ||
      Number(occurrence.topUpRequired || 0) > 0
    ) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence contains overtime activity and cannot use scheduled cancellation.",
        code: "OCCURRENCE_OVERTIME_ALREADY_STARTED",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
        },
      });
    }

    if (occurrence.activeClaim || occurrence.activeDispute) {
      throw ShiftLifecycleService.createError({
        message:
          "The occurrence has an active financial challenge and cannot be cancelled through this action.",
        code: "OCCURRENCE_ACTIVE_CHALLENGE_BLOCKS_CANCELLATION",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
          activeClaimId: occurrence.activeClaim ? String(occurrence.activeClaim) : null,
          activeDisputeId: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
        },
      });
    }

    const refundStatus = String(occurrence.refundStatus || "not_eligible")
      .trim()
      .toLowerCase();

    if (refundStatus !== "not_eligible") {
      throw ShiftLifecycleService.createError({
        message:
          "The occurrence has already entered the employer refund workflow and cannot use scheduled cancellation.",
        code: REFUND_EXECUTION_STARTED_STATUSES.includes(refundStatus)
          ? "OCCURRENCE_REFUND_EXECUTION_ALREADY_STARTED"
          : "OCCURRENCE_REFUND_WORKFLOW_ALREADY_STARTED",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
          refundStatus,
        },
      });
    }

    return occurrence;
  }

  static assertCancellationPolicySnapshot(shift) {
    const lateCancellationWindowMinutes =
      shift?.cancellationPolicySnapshot?.lateCancellationWindowMinutes;

    const lateCancellationProfessionalPayRate =
      shift?.cancellationPolicySnapshot?.lateCancellationProfessionalPayRate;

    const activeWorkCancellationMinimumPayRate =
      shift?.cancellationPolicySnapshot?.activeWorkCancellationMinimumPayRate;

    if (!Number.isSafeInteger(lateCancellationWindowMinutes) || lateCancellationWindowMinutes < 0) {
      throw ShiftLifecycleService.createError({
        message: "The Shift cancellation window snapshot is invalid.",
        code: "INVALID_SHIFT_CANCELLATION_WINDOW_SNAPSHOT",
        statusCode: 500,
      });
    }

    const normalizedLateCancellationProfessionalPayRate =
      ShiftLifecycleService.normalizeFinancialRate(
        lateCancellationProfessionalPayRate,
        "late cancellation compensation",
        {
          invalidMessage: "The Shift late cancellation compensation snapshot is invalid.",

          precisionMessage:
            "The Shift late cancellation compensation snapshot exceeds the supported financial precision.",

          code: "INVALID_LATE_CANCELLATION_COMPENSATION_SNAPSHOT",
        }
      );

    const normalizedActiveWorkCancellationMinimumPayRate =
      ShiftLifecycleService.normalizeFinancialRate(
        activeWorkCancellationMinimumPayRate,
        "active-work cancellation minimum",
        {
          invalidMessage: "The Shift active-work cancellation minimum snapshot is invalid.",

          precisionMessage:
            "The Shift active-work cancellation minimum snapshot exceeds the supported financial precision.",

          code: "INVALID_ACTIVE_WORK_CANCELLATION_MINIMUM_SNAPSHOT",
        }
      );

    return {
      lateCancellationWindowMinutes,

      lateCancellationProfessionalPayRate: normalizedLateCancellationProfessionalPayRate,

      activeWorkCancellationMinimumPayRate: normalizedActiveWorkCancellationMinimumPayRate,
    };
  }

  static async getNoShowGraceMinutes() {
    const attendanceSettings = await PlatformSettingsService.getAttendanceSettings();

    const noShowGraceMinutes = Number(attendanceSettings?.noShowGraceMinutes);

    if (!Number.isSafeInteger(noShowGraceMinutes) || noShowGraceMinutes < 0) {
      throw ShiftLifecycleService.createError({
        message: "The active no-show grace period is invalid.",
        code: "INVALID_NO_SHOW_GRACE_MINUTES",
        statusCode: 500,
      });
    }

    return noShowGraceMinutes;
  }

  static calculateNoShowDeadline({ occurrence, noShowGraceMinutes }) {
    if (!ShiftLifecycleService.hasCompleteAssignment(occurrence)) {
      return null;
    }

    const startTime = new Date(occurrence.startTime);
    const assignedAt = new Date(occurrence.assignedAt);
    const endTime = new Date(occurrence.endTime);

    if (
      Number.isNaN(startTime.getTime()) ||
      Number.isNaN(assignedAt.getTime()) ||
      Number.isNaN(endTime.getTime())
    ) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence no-show timing context is invalid.",
        code: "INVALID_OCCURRENCE_NO_SHOW_TIMING",
        statusCode: 500,
      });
    }

    const anchorTime = new Date(Math.max(startTime.getTime(), assignedAt.getTime()));

    const calculatedDeadline = new Date(
      anchorTime.getTime() + noShowGraceMinutes * MILLISECONDS_PER_MINUTE
    );

    return new Date(Math.min(calculatedDeadline.getTime(), endTime.getTime()));
  }

  static buildLateCancellationCompensation({ shift, occurrence }) {
    const policy = ShiftLifecycleService.assertCancellationPolicySnapshot(shift);

    const professionalPay = ShiftLifecycleService.calculateRateAmount(
      occurrence.estimatedProfessionalPay ?? 0,

      policy.lateCancellationProfessionalPayRate,

      "late cancellation professional pay"
    );

    return {
      applicable: professionalPay > 0,

      rate: policy.lateCancellationProfessionalPayRate,

      windowMinutes: policy.lateCancellationWindowMinutes,

      professionalPay,
    };
  }

  static buildActiveWorkCancellationBreakdown({ shift, occurrence, effectiveAt }) {
    const policy = ShiftLifecycleService.assertCancellationPolicySnapshot(shift);

    if (!occurrence.checkedInAt) {
      throw ShiftLifecycleService.createError({
        message: "The professional has not checked in for this occurrence.",
        code: "OCCURRENCE_NOT_CHECKED_IN",
        statusCode: 409,
      });
    }

    if (!ShiftLifecycleService.hasCompleteAssignment(occurrence)) {
      throw ShiftLifecycleService.createError({
        message: "The active occurrence does not contain a complete professional assignment.",
        code: "ACTIVE_OCCURRENCE_ASSIGNMENT_REQUIRED",
        statusCode: 409,
      });
    }

    if (occurrence.activeClaim || occurrence.activeDispute) {
      throw ShiftLifecycleService.createError({
        message:
          "The active occurrence has an unresolved financial challenge and cannot be ended through this action.",
        code: "ACTIVE_OCCURRENCE_CHALLENGE_UNRESOLVED",
        statusCode: 409,
      });
    }

    const checkedInAt = new Date(occurrence.checkedInAt);
    const scheduledEndTime = new Date(occurrence.endTime);

    if (Number.isNaN(checkedInAt.getTime()) || Number.isNaN(scheduledEndTime.getTime())) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence attendance or scheduled end time is invalid.",
        code: "INVALID_ACTIVE_WORK_CANCELLATION_TIME",
        statusCode: 500,
      });
    }

    if (effectiveAt < checkedInAt) {
      throw ShiftLifecycleService.createError({
        message: "The Shift cannot end before the professional checked in.",
        code: "ACTIVE_WORK_CANCELLATION_BEFORE_CHECK_IN",
        statusCode: 409,
      });
    }

    if (effectiveAt >= scheduledEndTime) {
      throw ShiftLifecycleService.createError({
        message:
          "This occurrence has reached its scheduled end time and cannot use active-work cancellation.",
        code: "OCCURRENCE_ALREADY_REACHED_END_TIME",
        statusCode: 409,
      });
    }

    if (
      occurrence.overtime?.requested === true ||
      Number(occurrence.overtimeProfessionalPay || 0) > 0 ||
      Number(occurrence.overtimePlatformFee || 0) > 0 ||
      Number(occurrence.topUpRequired || 0) > 0
    ) {
      throw ShiftLifecycleService.createError({
        message:
          "The occurrence already contains overtime activity and cannot use active-work cancellation.",
        code: "ACTIVE_WORK_CANCELLATION_OVERTIME_ALREADY_STARTED",
        statusCode: 409,
      });
    }

    const baseSettlementStatus = String(occurrence.baseSettlement?.status || "not_due")
      .trim()
      .toLowerCase();

    const overtimeSettlementStatus = String(occurrence.overtimeSettlement?.status || "not_due")
      .trim()
      .toLowerCase();

    if (baseSettlementStatus !== "not_due" || overtimeSettlementStatus !== "not_due") {
      throw ShiftLifecycleService.createError({
        message: "Professional settlement has already started for this occurrence.",
        code: "ACTIVE_WORK_CANCELLATION_SETTLEMENT_ALREADY_STARTED",
        statusCode: 409,
      });
    }

    const refundStatus = String(occurrence.refundStatus || "not_eligible")
      .trim()
      .toLowerCase();

    if (refundStatus !== "not_eligible") {
      throw ShiftLifecycleService.createError({
        message: "The active occurrence has already entered the employer refund workflow.",
        code: REFUND_EXECUTION_STARTED_STATUSES.includes(refundStatus)
          ? "OCCURRENCE_REFUND_EXECUTION_ALREADY_STARTED"
          : "ACTIVE_WORK_CANCELLATION_REFUND_WORKFLOW_ALREADY_STARTED",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
          refundStatus,
        },
      });
    }

    const scheduledMinutes = Number(occurrence.scheduledMinutes || 0);

    if (!Number.isSafeInteger(scheduledMinutes) || scheduledMinutes <= 0) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence scheduled minutes are invalid.",
        code: "INVALID_OCCURRENCE_SCHEDULED_MINUTES",
        statusCode: 500,
      });
    }

    const rawWorkedMinutes = Math.round(
      (effectiveAt.getTime() - checkedInAt.getTime()) / MILLISECONDS_PER_MINUTE
    );

    const actualWorkedMinutes = Math.max(0, Math.min(scheduledMinutes, rawWorkedMinutes));

    const hourlyRate = occurrence.hourlyRate ?? 0;

    const actualWorkedProfessionalPay = ShiftLifecycleService.calculateProfessionalPayForMinutes({
      hourlyRate,
      workedMinutes: actualWorkedMinutes,
    });

    const scheduledProfessionalPay = ShiftLifecycleService.calculateProfessionalPayForMinutes({
      hourlyRate,
      workedMinutes: scheduledMinutes,
    });

    const minimumGuaranteedProfessionalPay = ShiftLifecycleService.calculateRateAmount(
      scheduledProfessionalPay,
      policy.activeWorkCancellationMinimumPayRate,
      "active-work cancellation minimum professional pay"
    );

    const professionalPay = Math.max(actualWorkedProfessionalPay, minimumGuaranteedProfessionalPay);

    const allocation = ShiftLifecycleService.calculateRefundableScheduledAllocation({
      occurrence,
      professionalEntitlement: professionalPay,
    });

    return {
      actualWorkedMinutes,
      minimumProfessionalPayRate: policy.activeWorkCancellationMinimumPayRate,
      actualWorkedProfessionalPay,
      minimumGuaranteedProfessionalPay,
      professionalPay,
      retainedBasePlatformFee: allocation.retainedBasePlatformFee,
      retainedAmount: allocation.retainedAmount,
      refundableAmount: allocation.refundableAmount,
    };
  }

  static buildScheduledCancellationOutcome({ occurrence, professionalCompensation = null }) {
    ShiftLifecycleService.assertUntouchedScheduledCancellationState(occurrence);

    const compensation = professionalCompensation || {
      applicable: false,
      rate: 0,
      windowMinutes: null,
      professionalPay: 0,
    };

    const professionalPay = ShiftLifecycleService.assertSafeNonNegativeAmount(
      compensation.professionalPay,
      "cancellation professional pay"
    );

    const allocation = ShiftLifecycleService.calculateRefundableScheduledAllocation({
      occurrence,
      professionalEntitlement: professionalPay,
    });

    return {
      occurrence,
      compensation: {
        applicable: compensation.applicable === true && professionalPay > 0,
        rate:
          compensation.applicable === true && professionalPay > 0
            ? Number(compensation.rate || 0)
            : 0,
        windowMinutes:
          compensation.applicable === true && professionalPay > 0
            ? Number(compensation.windowMinutes)
            : null,
        professionalPay,
      },
      retainedBasePlatformFee: allocation.retainedBasePlatformFee,
      retainedAmount: allocation.retainedAmount,
      refundableAmount: allocation.refundableAmount,
    };
  }

  /* ─────────────────────────────── PREVIEW ─────────────────────────────── */

  static buildExistingCancellationView(shift) {
    return {
      mode: "already_cancelled",
      alreadyFinalized: true,
      shiftId: String(shift._id),
      referenceCode: shift.referenceCode,
      status: shift.status,
      cancellationCode: shift.cancellationCode,
      cancelledAt: shift.cancelledAt,
      cancellationSummary: shift.cancellationSummary || null,
    };
  }

  static async buildCancellationPreview({ shift, occurrences, now }) {
    if (shift.status === "cancelled") {
      return ShiftLifecycleService.buildExistingCancellationView(shift);
    }

    if (shift.status === "completed") {
      throw ShiftLifecycleService.createError({
        message: "A completed engagement cannot be cancelled.",
        code: "COMPLETED_SHIFT_CANNOT_BE_CANCELLED",
        statusCode: 409,
      });
    }

    if (shift.status === "disputed") {
      throw ShiftLifecycleService.createError({
        message: "This engagement is disputed and must be resolved through the dispute workflow.",
        code: "DISPUTED_SHIFT_REQUIRES_REVIEW",
        statusCode: 409,
      });
    }

    if (shift.status === "no_show") {
      throw ShiftLifecycleService.createError({
        message: "This engagement is already in the no-show workflow.",
        code: "NO_SHOW_SHIFT_REQUIRES_REVIEW",
        statusCode: 409,
      });
    }

    if (shift.status === "pending_funding") {
      const affectedOccurrences = occurrences.filter(
        (occurrence) => occurrence.status === "scheduled" && !occurrence.cancelledAt
      );

      const firstAffectedOccurrence = affectedOccurrences[0] || null;

      return {
        mode: "pending_funding_cancellation",
        alreadyFinalized: false,
        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        scheduleMode: shift.scheduleMode,
        firstAffectedOccurrence,
        affectedOccurrences,
        affectedOccurrenceCount: affectedOccurrences.length,
        futureCancelledOccurrenceCount: Math.max(affectedOccurrences.length - 1, 0),
        professionalCompensation: ShiftLifecycleService.buildMoneyView(0, shift.currency),
        retainedPlatformFee: ShiftLifecycleService.buildMoneyView(0, shift.currency),
        refund: ShiftLifecycleService.buildMoneyView(0, shift.currency),
        message:
          "This unpaid Shift will be cancelled. No refund is due because no protected funding was received.",
      };
    }

    if (!EMPLOYER_CANCELLABLE_PARENT_STATUSES.includes(shift.status)) {
      throw ShiftLifecycleService.createError({
        message: "This Shift is not in a state that can be cancelled.",
        code: "SHIFT_NOT_CANCELLABLE",
        statusCode: 409,
        details: {
          status: shift.status,
        },
      });
    }

    const activeOccurrence = ShiftLifecycleService.getActiveOccurrence(occurrences);

    if (activeOccurrence) {
      const breakdown = ShiftLifecycleService.buildActiveWorkCancellationBreakdown({
        shift,
        occurrence: activeOccurrence,
        effectiveAt: now,
      });

      const futureOccurrences = ShiftLifecycleService.getAffectedScheduledOccurrences(
        occurrences,
        Number(activeOccurrence.sequenceNumber) + 1
      );

      const futureOutcomes = futureOccurrences.map((occurrence) =>
        ShiftLifecycleService.buildScheduledCancellationOutcome({
          occurrence,
        })
      );

      const futureRefundAmount = ShiftLifecycleService.addSafeAmounts(
        futureOutcomes.map((outcome) => outcome.refundableAmount),
        "future occurrence refund"
      );

      const futureRetainedPlatformFee = ShiftLifecycleService.addSafeAmounts(
        futureOutcomes.map((outcome) => outcome.retainedBasePlatformFee),
        "future retained platform fee"
      );

      const totalRefundAmount = ShiftLifecycleService.addSafeAmounts(
        [breakdown.refundableAmount, futureRefundAmount],
        "active-work cancellation total refund"
      );

      const totalRetainedPlatformFee = ShiftLifecycleService.addSafeAmounts(
        [breakdown.retainedBasePlatformFee, futureRetainedPlatformFee],
        "active-work cancellation retained platform fee"
      );

      return {
        mode: "active_work_cancellation",
        alreadyFinalized: false,
        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        scheduleMode: shift.scheduleMode,
        firstAffectedOccurrence: activeOccurrence,
        affectedOccurrences: [activeOccurrence, ...futureOccurrences],
        affectedOccurrenceCount: futureOccurrences.length + 1,
        futureCancelledOccurrenceCount: futureOccurrences.length,
        actualWorkedMinutes: breakdown.actualWorkedMinutes,
        actualWorkedProfessionalPay: ShiftLifecycleService.buildMoneyView(
          breakdown.actualWorkedProfessionalPay,
          shift.currency
        ),
        minimumGuaranteedProfessionalPay: ShiftLifecycleService.buildMoneyView(
          breakdown.minimumGuaranteedProfessionalPay,
          shift.currency
        ),
        professionalCompensation: ShiftLifecycleService.buildMoneyView(
          breakdown.professionalPay,
          shift.currency
        ),
        retainedPlatformFee: ShiftLifecycleService.buildMoneyView(
          totalRetainedPlatformFee,
          shift.currency
        ),
        refund: ShiftLifecycleService.buildMoneyView(totalRefundAmount, shift.currency),
        breakdown,
        message:
          "The professional has checked in. Use active-work cancellation for this occurrence.",
      };
    }

    const firstAffectedOccurrence = ShiftLifecycleService.getNextCancellableOccurrence(occurrences);

    if (!firstAffectedOccurrence) {
      throw ShiftLifecycleService.createError({
        message: "No unresolved occurrence is available to cancel.",
        code: "NO_CANCELLABLE_OCCURRENCE_FOUND",
        statusCode: 409,
      });
    }

    const occurrenceStartTime = new Date(firstAffectedOccurrence.startTime);

    if (Number.isNaN(occurrenceStartTime.getTime())) {
      throw ShiftLifecycleService.createError({
        message: "The first affected occurrence start time is invalid.",
        code: "INVALID_OCCURRENCE_START_TIME",
        statusCode: 500,
      });
    }

    const millisecondsUntilStart = occurrenceStartTime.getTime() - now.getTime();

    const policy = ShiftLifecycleService.assertCancellationPolicySnapshot(shift);

    const protectedWindowMilliseconds =
      policy.lateCancellationWindowMinutes * MILLISECONDS_PER_MINUTE;

    const hasCompleteAssignment =
      ShiftLifecycleService.hasCompleteAssignment(firstAffectedOccurrence);

    let noShowDeadline = null;
    let isPostStartGraceCancellation = false;

    if (millisecondsUntilStart < 0) {
      if (!hasCompleteAssignment) {
        throw ShiftLifecycleService.createError({
          message:
            "This occurrence has started without a complete assignment. It must enter the unfilled-occurrence workflow.",
          code: "SHIFT_CANCELLATION_REQUIRES_UNFILLED_REVIEW",
          statusCode: 409,
          details: {
            occurrenceId: String(firstAffectedOccurrence._id),
            sequenceNumber: firstAffectedOccurrence.sequenceNumber,
            startTime: firstAffectedOccurrence.startTime,
          },
        });
      }

      const noShowGraceMinutes = await ShiftLifecycleService.getNoShowGraceMinutes();

      noShowDeadline = ShiftLifecycleService.calculateNoShowDeadline({
        occurrence: firstAffectedOccurrence,
        noShowGraceMinutes,
      });

      if (!noShowDeadline || now >= noShowDeadline) {
        throw ShiftLifecycleService.createError({
          message:
            "This occurrence has started without a recorded check-in and its grace period has passed. It must enter attendance or no-show review.",
          code: "SHIFT_CANCELLATION_REQUIRES_ATTENDANCE_REVIEW",
          statusCode: 409,
          details: {
            occurrenceId: String(firstAffectedOccurrence._id),
            sequenceNumber: firstAffectedOccurrence.sequenceNumber,
            startTime: firstAffectedOccurrence.startTime,
            noShowDeadline,
          },
        });
      }

      isPostStartGraceCancellation = true;
    }

    const compensationApplies = Boolean(
      hasCompleteAssignment &&
      policy.lateCancellationProfessionalPayRate > 0 &&
      (isPostStartGraceCancellation ||
        (millisecondsUntilStart >= 0 && millisecondsUntilStart <= protectedWindowMilliseconds))
    );

    const professionalCompensation = compensationApplies
      ? ShiftLifecycleService.buildLateCancellationCompensation({
          shift,
          occurrence: firstAffectedOccurrence,
        })
      : {
          applicable: false,
          rate: 0,
          windowMinutes: null,
          professionalPay: 0,
        };

    const affectedOccurrences = ShiftLifecycleService.getAffectedScheduledOccurrences(
      occurrences,
      firstAffectedOccurrence.sequenceNumber
    );

    const outcomes = affectedOccurrences.map((occurrence, index) =>
      ShiftLifecycleService.buildScheduledCancellationOutcome({
        occurrence,
        professionalCompensation: index === 0 ? professionalCompensation : null,
      })
    );

    const totalRefundAmount = ShiftLifecycleService.addSafeAmounts(
      outcomes.map((outcome) => outcome.refundableAmount),
      "cancellation total refund"
    );

    const totalRetainedPlatformFee = ShiftLifecycleService.addSafeAmounts(
      outcomes.map((outcome) => outcome.retainedBasePlatformFee),
      "cancellation retained platform fee"
    );

    const firstOutcome = outcomes[0];

    return {
      mode: "cancellation",
      alreadyFinalized: false,
      shiftId: String(shift._id),
      referenceCode: shift.referenceCode,
      scheduleMode: shift.scheduleMode,
      firstAffectedOccurrence,
      affectedOccurrences,
      affectedOccurrenceCount: affectedOccurrences.length,
      futureCancelledOccurrenceCount: Math.max(affectedOccurrences.length - 1, 0),
      millisecondsUntilStart,
      minutesUntilStart: Math.ceil(millisecondsUntilStart / MILLISECONDS_PER_MINUTE),
      noShowDeadline,
      isPostStartGraceCancellation,
      compensationApplicable: firstOutcome?.compensation?.applicable === true,
      compensationRate: firstOutcome?.compensation?.rate || 0,
      compensationWindowMinutes: firstOutcome?.compensation?.windowMinutes || null,
      professionalCompensation: ShiftLifecycleService.buildMoneyView(
        firstOutcome?.compensation?.professionalPay || 0,
        shift.currency
      ),
      retainedPlatformFee: ShiftLifecycleService.buildMoneyView(
        totalRetainedPlatformFee,
        shift.currency
      ),
      refund: ShiftLifecycleService.buildMoneyView(totalRefundAmount, shift.currency),
      outcomes,
      message:
        firstOutcome?.compensation?.applicable === true
          ? "The first affected occurrence qualifies for late-cancellation compensation. Later untouched occurrences do not receive additional compensation."
          : "No professional cancellation compensation applies. Any unused protected occurrence allocation will enter the employer refund workflow.",
    };
  }

  static async getCancellationPreview({
    shiftId,
    employerProfileId,
    employerContext,
    now = new Date(),
  }) {
    const normalizedNow = ShiftLifecycleService.normalizeDate(now, "preview date");

    const shift = await ShiftLifecycleService.getEmployerShift({
      shiftId,
      employerProfileId,
      employerContext,
    });

    const occurrences = await ShiftLifecycleService.getOccurrences({
      shiftId: shift._id,
    });

    return ShiftLifecycleService.buildCancellationPreview({
      shift,
      occurrences,
      now: normalizedNow,
    });
  }

  /* ─────────────────────────────── DOWNSTREAM AUTHORITY HANDOFFS ─────────────────────────────── */

  static async establishBaseSettlementOutcome({
    shift,
    occurrence,
    earningType,
    professionalPay,
    currentTime,
    session,
  }) {
    if (typeof ShiftSettlementService.establishBaseSettlementOutcome !== "function") {
      throw ShiftLifecycleService.createError({
        message: "ShiftSettlementService.establishBaseSettlementOutcome is not implemented.",
        code: "BASE_SETTLEMENT_OUTCOME_SERVICE_NOT_IMPLEMENTED",
        statusCode: 500,
      });
    }

    try {
      return await ShiftSettlementService.establishBaseSettlementOutcome(
        {
          shiftId: shift._id,
          occurrenceId: occurrence._id,
          earningType,
          professionalPay,
          currentTime,
        },
        {
          session,
        }
      );
    } catch (error) {
      if (error?.name !== "ShiftSettlementServiceError") {
        throw error;
      }

      throw ShiftLifecycleService.createError({
        message: error.message,
        code: error.code || "BASE_SETTLEMENT_OUTCOME_FAILED",
        statusCode: error.statusCode || 500,
        details: error.details && typeof error.details === "object" ? error.details : null,
      });
    }
  }

  static async reevaluateRefundObligation({
    shift,
    occurrence,
    reason,
    initiatedBy,
    currentTime,
    session,
  }) {
    try {
      const result = await ShiftRefundService.reevaluateOccurrenceRefund(
        {
          shift,
          occurrence,
          shiftId: shift._id,
          occurrenceId: occurrence._id,
          reason,
          holdReason: null,
          claimId: null,
          disputeId: null,
          scheduledProcessingAt: null,
          currentTime,
          initiatedBy,
        },
        {
          session,
        }
      );

      const resolvedOccurrence = result?.occurrence || occurrence;

      const amount = ShiftLifecycleService.assertSafeNonNegativeAmount(
        ShiftRefundService.calculateExpectedRefundAmount(resolvedOccurrence),
        "occurrence refundable amount"
      );

      return {
        ...result,
        amount,
      };
    } catch (error) {
      if (error?.name !== "ShiftRefundServiceError") {
        throw error;
      }

      throw ShiftLifecycleService.createError({
        message: error.message,
        code: error.code || "EMPLOYER_REFUND_OBLIGATION_FAILED",
        statusCode: error.statusCode || 500,
        details: error.details && typeof error.details === "object" ? error.details : null,
      });
    }
  }

  static async expireOpenApplications({
    shiftId,
    applicationRound = null,
    occurrenceId = undefined,
    session,
  }) {
    if (typeof ShiftApplicationService.expireOpenApplicationsForShift !== "function") {
      throw ShiftLifecycleService.createError({
        message: "ShiftApplicationService.expireOpenApplicationsForShift is not implemented.",
        code: "SHIFT_APPLICATION_EXPIRATION_SERVICE_NOT_IMPLEMENTED",
        statusCode: 500,
      });
    }

    try {
      return await ShiftApplicationService.expireOpenApplicationsForShift(
        {
          shiftId,
          applicationRound,
          occurrenceId,
        },
        {
          session,
        }
      );
    } catch (error) {
      if (error?.name !== "ShiftApplicationServiceError") {
        throw error;
      }

      throw ShiftLifecycleService.createError({
        message: error.message,
        code: error.code || "SHIFT_APPLICATION_EXPIRATION_FAILED",
        statusCode: error.statusCode || 500,
        details: error.details && typeof error.details === "object" ? error.details : null,
      });
    }
  }

  static async reconcileParentShift({ shiftId, currentTime, session }) {
    try {
      return await ShiftOccurrenceReconciliationService.reconcileShift(
        {
          shiftId,
          currentTime,
        },
        {
          session,
        }
      );
    } catch (error) {
      if (error?.name !== "ShiftOccurrenceReconciliationServiceError") {
        throw error;
      }

      throw ShiftLifecycleService.createError({
        message: error.message,
        code: error.code || "SHIFT_LIFECYCLE_RECONCILIATION_FAILED",
        statusCode: error.statusCode || 500,
        details: error.details && typeof error.details === "object" ? error.details : null,
      });
    }
  }

  /* ─────────────────────────────── OCCURRENCE MUTATION HELPERS ─────────────────────────────── */

  static setNoCancellationCompensation(occurrence) {
    occurrence.cancellationCompensation = {
      applicable: false,
      rate: 0,
      windowMinutes: null,
      professionalPay: 0,
      calculatedAt: null,
    };
  }

  static setOccurrenceCancellationFacts({
    occurrence,
    code,
    actor,
    actorUserId,
    reason,
    now,
    compensation = null,
  }) {
    occurrence.status = "cancelled";
    occurrence.attendanceStatus = "not_started";

    occurrence.cancellationCode = code;
    occurrence.cancelledBy = actor;
    occurrence.cancelledByUser = actor === "system" ? null : actorUserId;
    occurrence.cancellationReason = reason;
    occurrence.cancelledAt = now;

    occurrence.checkedInAt = null;
    occurrence.checkedOutAt = null;
    occurrence.checkInPinUsedAt = null;
    occurrence.checkOutPinUsedAt = null;

    occurrence.activeWorkCancellation = {
      occurred: false,
      initiatedBy: null,
      initiatedByUser: null,
      reason: null,
      requestedAt: null,
      effectiveAt: null,
      actualWorkedMinutes: 0,
      minimumProfessionalPayRate: 0,
      actualWorkedProfessionalPay: 0,
      minimumGuaranteedProfessionalPay: 0,
      professionalPay: 0,
      calculatedAt: null,
    };

    const professionalPay = ShiftLifecycleService.assertSafeNonNegativeAmount(
      compensation?.professionalPay || 0,
      "cancellation professional pay"
    );

    if (compensation?.applicable === true && professionalPay > 0) {
      occurrence.cancellationCompensation = {
        applicable: true,
        rate: Number(compensation.rate),
        windowMinutes: Number(compensation.windowMinutes),
        professionalPay,
        calculatedAt: now,
      };
    } else {
      ShiftLifecycleService.setNoCancellationCompensation(occurrence);
    }

    return occurrence;
  }

  static setOccurrenceActiveWorkCancellationFacts({
    occurrence,
    actor,
    actorUserId,
    reason,
    requestedAt,
    effectiveAt,
    breakdown,
  }) {
    occurrence.status = "pending_settlement";
    occurrence.attendanceStatus = "checked_out";
    occurrence.checkedOutAt = effectiveAt;

    occurrence.cancellationCode = null;
    occurrence.cancelledBy = null;
    occurrence.cancelledByUser = null;
    occurrence.cancellationReason = null;
    occurrence.cancelledAt = null;

    ShiftLifecycleService.setNoCancellationCompensation(occurrence);

    occurrence.activeWorkCancellation = {
      occurred: true,
      initiatedBy: actor,
      initiatedByUser: actorUserId,
      reason,
      requestedAt,
      effectiveAt,
      actualWorkedMinutes: breakdown.actualWorkedMinutes,
      minimumProfessionalPayRate: breakdown.minimumProfessionalPayRate,
      actualWorkedProfessionalPay: breakdown.actualWorkedProfessionalPay,
      minimumGuaranteedProfessionalPay: breakdown.minimumGuaranteedProfessionalPay,
      professionalPay: breakdown.professionalPay,
      calculatedAt: effectiveAt,
    };

    occurrence.baseBillableHours = Number((breakdown.actualWorkedMinutes / 60).toFixed(4));

    occurrence.billableHours = occurrence.baseBillableHours;

    return occurrence;
  }

  /* ─────────────────────────────── ASSIGNMENT CLOSURE ─────────────────────────────── */

  static async closeAssignments({
    shift,
    occurrences,
    firstAffectedSequenceNumber,
    finalResponsibleSequenceNumber,
    effectiveEndAtOverride = null,
    actor,
    actorUserId,
    reason,
    now,
    session,
  }) {
    const assignmentQuery = ShiftAssignment.find({
      shift: shift._id,
      status: {
        $in: MANAGED_ASSIGNMENT_STATUSES,
      },
    }).sort({
      startSequence: 1,
      assignedAt: 1,
    });

    if (session) {
      assignmentQuery.session(session);
    }

    const assignments = await assignmentQuery;

    const occurrenceBySequence = new Map(
      occurrences.map((occurrence) => [Number(occurrence.sequenceNumber), occurrence])
    );

    for (const assignment of assignments) {
      const startsAtOrAfterAffectedRange =
        Number(assignment.startSequence) >= Number(firstAffectedSequenceNumber);

      if (assignment.status === "scheduled") {
        assignment.status = "cancelled";
        assignment.cancelledAt = now;
        assignment.cancelledBy = actor === "system" ? null : actorUserId;
        assignment.cancelledByRole = actor;
        assignment.cancellationReason = reason;

        assignment.effectiveEndSequence = null;
        assignment.effectiveOccurrenceCount = null;
        assignment.effectiveEndsAt = null;

        assignment.endedAt = null;
        assignment.endedBy = null;
        assignment.endedByRole = null;
        assignment.endReason = null;
        assignment.endNotes = null;
        assignment.openCase = null;

        await assignment.save({
          session,
        });

        continue;
      }

      if (startsAtOrAfterAffectedRange) {
        throw ShiftLifecycleService.createError({
          message:
            "An activated assignment begins inside the cancelled occurrence range and requires administrative review.",
          code: "ACTIVE_ASSIGNMENT_RANGE_CONFLICT",
          statusCode: 409,
          details: {
            assignmentId: String(assignment._id),
            startSequence: assignment.startSequence,
            firstAffectedSequenceNumber,
          },
        });
      }

      const existingEffectiveEndSequence = Number.isSafeInteger(assignment.effectiveEndSequence)
        ? Number(assignment.effectiveEndSequence)
        : Number(assignment.plannedEndSequence);

      const effectiveEndSequence = Math.min(
        existingEffectiveEndSequence,
        Number(finalResponsibleSequenceNumber)
      );

      if (effectiveEndSequence < Number(assignment.startSequence)) {
        throw ShiftLifecycleService.createError({
          message:
            "The activated assignment has no valid completed responsibility range before cancellation.",
          code: "INVALID_ACTIVE_ASSIGNMENT_END_RANGE",
          statusCode: 409,
          details: {
            assignmentId: String(assignment._id),
            startSequence: assignment.startSequence,
            effectiveEndSequence,
          },
        });
      }

      const finalOccurrence = occurrenceBySequence.get(effectiveEndSequence);

      if (!finalOccurrence) {
        throw ShiftLifecycleService.createError({
          message: "The final responsible occurrence for the assignment could not be resolved.",
          code: "ASSIGNMENT_FINAL_OCCURRENCE_NOT_FOUND",
          statusCode: 500,
          details: {
            assignmentId: String(assignment._id),
            effectiveEndSequence,
          },
        });
      }

      const effectiveEndsAt =
        effectiveEndSequence === Number(finalResponsibleSequenceNumber) && effectiveEndAtOverride
          ? effectiveEndAtOverride
          : finalOccurrence.endTime;

      assignment.status = "ended";
      assignment.effectiveEndSequence = effectiveEndSequence;
      assignment.effectiveOccurrenceCount =
        effectiveEndSequence - Number(assignment.startSequence) + 1;
      assignment.effectiveEndsAt = effectiveEndsAt;
      assignment.endedAt = now;
      assignment.endedBy = actor === "system" ? null : actorUserId;
      assignment.endedByRole = actor;
      assignment.endReason = "engagement_cancelled";
      assignment.endNotes = reason;
      assignment.openCase = null;

      assignment.cancelledAt = null;
      assignment.cancelledBy = null;
      assignment.cancelledByRole = null;
      assignment.cancellationReason = null;

      await assignment.save({
        session,
      });
    }
  }

  /* ─────────────────────────────── PARENT LIFECYCLE HELPERS ─────────────────────────────── */

  static cancelReplacementHiring({ shift, actorUserId, reason, now }) {
    if (!["open", "filled"].includes(shift.replacementHiring?.status)) {
      return;
    }

    shift.replacementHiring.status = "cancelled";
    shift.replacementHiring.cancelledAt = now;
    shift.replacementHiring.cancelledBy = actorUserId || null;
    shift.replacementHiring.cancellationReason = reason;
    shift.replacementHiring.filledAt = null;
    shift.replacementHiring.filledByAssignment = null;
  }

  static clearParentAssignmentSummary(shift) {
    shift.activeAssignment = null;
    shift.assignedProfessional = null;
    shift.assignedAt = null;
    shift.assignedBy = null;
  }

  static setParentCancellationFacts({
    shift,
    cancelledFromStatus,
    code,
    actor,
    actorUserId,
    reason,
    cancelledAt,
    firstAffectedOccurrence = null,
    cancelledOccurrenceCount = 0,
    compensation = null,
  }) {
    shift.status = "cancelled";
    shift.cancelledFromStatus = cancelledFromStatus;
    shift.cancellationCode = code;
    shift.cancelledBy = actor;
    shift.cancelledByUser = actor === "system" ? null : actorUserId;
    shift.cancellationReason = reason;
    shift.cancelledAt = cancelledAt;

    shift.cancellationSummary = {
      firstAffectedOccurrence:
        shift.scheduleMode === "multiple" ? firstAffectedOccurrence?._id || null : null,
      firstAffectedSequenceNumber: firstAffectedOccurrence?.sequenceNumber || 1,
      cancelledOccurrenceCount: Number(cancelledOccurrenceCount || 0),
      compensationApplicable: compensation?.applicable === true,
      compensationRate: compensation?.applicable === true ? Number(compensation.rate || 0) : 0,
      compensationWindowMinutes:
        compensation?.applicable === true ? Number(compensation.windowMinutes) : null,
      professional:
        compensation?.applicable === true
          ? firstAffectedOccurrence?.assignedProfessional || null
          : null,
      assignment:
        compensation?.applicable === true ? firstAffectedOccurrence?.assignment || null : null,
      professionalPay:
        compensation?.applicable === true ? Number(compensation.professionalPay || 0) : 0,
      calculatedAt: cancelledAt,
    };

    ShiftLifecycleService.clearParentAssignmentSummary(shift);

    ShiftLifecycleService.cancelReplacementHiring({
      shift,
      actorUserId: actor === "system" ? null : actorUserId,
      reason,
      now: cancelledAt,
    });

    return shift;
  }

  static setParentActiveWorkCancellationFacts({
    shift,
    cancelledFromStatus,
    actorUserId,
    reason,
    effectiveAt,
    activeOccurrence,
    futureCancelledOccurrenceCount,
  }) {
    shift.status = "cancelled";
    shift.cancelledFromStatus = cancelledFromStatus;
    shift.cancellationCode = "employer_cancelled";
    shift.cancelledBy = "employer";
    shift.cancelledByUser = actorUserId;
    shift.cancellationReason = reason;
    shift.cancelledAt = effectiveAt;

    shift.cancellationSummary = {
      firstAffectedOccurrence: shift.scheduleMode === "multiple" ? activeOccurrence._id : null,
      firstAffectedSequenceNumber: activeOccurrence.sequenceNumber,
      cancelledOccurrenceCount: Number(futureCancelledOccurrenceCount || 0),
      compensationApplicable: false,
      compensationRate: 0,
      compensationWindowMinutes: null,
      professional: null,
      assignment: null,
      professionalPay: 0,
      calculatedAt: effectiveAt,
    };

    shift.activeWorkCancellation = {
      occurred: true,
      affectedOccurrence: activeOccurrence._id,
      affectedSequenceNumber: activeOccurrence.sequenceNumber,
      initiatedBy: "employer",
      initiatedByUser: actorUserId,
      reason,
      requestedAt: effectiveAt,
      effectiveAt,
      futureCancelledOccurrenceCount: Number(futureCancelledOccurrenceCount || 0),
      calculatedAt: effectiveAt,
    };

    ShiftLifecycleService.clearParentAssignmentSummary(shift);

    ShiftLifecycleService.cancelReplacementHiring({
      shift,
      actorUserId,
      reason,
      now: effectiveAt,
    });

    return shift;
  }

  /* ─────────────────────────────── PENDING-FUNDING CANCELLATION ─────────────────────────────── */

  static async cancelPendingFundingShift(
    { shiftId, userId, employerProfileId, employerContext, reason, now = new Date() },
    options = {}
  ) {
    const actorUserId = ShiftLifecycleService.normalizeObjectId(userId, "user ID");

    const cancellationReason = ShiftLifecycleService.normalizeReason(reason);

    const cancellationDate = ShiftLifecycleService.normalizeDate(now, "cancellation date");

    return ShiftLifecycleService.runWithOptionalTransaction(options, async (session) => {
      const shift = await ShiftLifecycleService.getEmployerShift({
        shiftId,
        employerProfileId,
        employerContext,
        session,
      });

      if (shift.status === "cancelled") {
        return ShiftLifecycleService.buildExistingCancellationView(shift);
      }

      if (shift.status !== "pending_funding" || shift.paymentStatus !== "unpaid") {
        throw ShiftLifecycleService.createError({
          message: "Only an unpaid pending-funding Shift can use this cancellation action.",
          code: "SHIFT_NOT_PENDING_FUNDING",
          statusCode: 409,
        });
      }

      if (Number(shift.fundedAmount || 0) !== 0) {
        throw ShiftLifecycleService.createError({
          message: "A funded Shift cannot use the pending-funding cancellation action.",
          code: "PENDING_SHIFT_CONTAINS_FUNDS",
          statusCode: 409,
        });
      }

      const shiftStartTime = new Date(shift.startTime);

      if (Number.isNaN(shiftStartTime.getTime())) {
        throw ShiftLifecycleService.createError({
          message: "The pending-funding Shift start time is invalid.",
          code: "INVALID_SHIFT_START_TIME",
          statusCode: 500,
        });
      }

      if (shiftStartTime <= cancellationDate) {
        return ShiftLifecycleService.expireUnfundedShift(
          {
            shiftId: shift._id,
            now: cancellationDate,
          },
          {
            session,
          }
        );
      }

      const occurrences = await ShiftLifecycleService.getOccurrences({
        shiftId: shift._id,
        session,
      });

      const affectedOccurrences = occurrences.filter(
        (occurrence) => occurrence.status === "scheduled" && !occurrence.cancelledAt
      );

      for (const occurrence of affectedOccurrences) {
        ShiftLifecycleService.setOccurrenceCancellationFacts({
          occurrence,
          code: "employer_cancelled",
          actor: "employer",
          actorUserId,
          reason: cancellationReason,
          now: cancellationDate,
          compensation: null,
        });

        await occurrence.save({
          session,
        });
      }

      const firstAffectedOccurrence = affectedOccurrences[0] || null;

      ShiftLifecycleService.setParentCancellationFacts({
        shift,
        cancelledFromStatus: "pending_funding",
        code: "employer_cancelled",
        actor: "employer",
        actorUserId,
        reason: cancellationReason,
        cancelledAt: cancellationDate,
        firstAffectedOccurrence,
        cancelledOccurrenceCount: affectedOccurrences.length,
        compensation: null,
      });

      await shift.save({
        session,
      });

      await ShiftLifecycleService.reconcileParentShift({
        shiftId: shift._id,
        currentTime: cancellationDate,
        session,
      });

      logger.info(
        `Pending-funding Shift ${shift.referenceCode} cancelled by employer user ${actorUserId}`
      );

      return {
        mode: "pending_funding_cancellation",
        alreadyFinalized: false,
        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        status: "cancelled",
        cancelledAt: cancellationDate,
        cancelledOccurrenceCount: affectedOccurrences.length,
        professionalPay: 0,
        refundableAmount: 0,
      };
    });
  }

  /* ─────────────────────────────── UNFUNDED EXPIRATION ─────────────────────────────── */

  static async expireUnfundedShift({ shiftId, now = new Date() }, options = {}) {
    const expirationDate = ShiftLifecycleService.normalizeDate(now, "expiration date");

    return ShiftLifecycleService.runWithOptionalTransaction(options, async (session) => {
      const shift = await ShiftLifecycleService.getSystemShift({
        shiftId,
        session,
      });

      if (shift.status === "cancelled" && shift.cancellationCode === "funding_deadline_passed") {
        return {
          expired: true,
          alreadyFinalized: true,
          shiftId: String(shift._id),
          referenceCode: shift.referenceCode,
          cancelledAt: shift.cancelledAt,
        };
      }

      if (shift.status !== "pending_funding" || shift.paymentStatus !== "unpaid") {
        return {
          expired: false,
          alreadyFinalized: true,
          shiftId: String(shift._id),
          referenceCode: shift.referenceCode,
          status: shift.status,
          paymentStatus: shift.paymentStatus,
        };
      }

      if (Number(shift.fundedAmount || 0) !== 0) {
        throw ShiftLifecycleService.createError({
          message: "The pending-funding Shift unexpectedly contains protected funding.",
          code: "PENDING_SHIFT_CONTAINS_FUNDS",
          statusCode: 409,
        });
      }

      const shiftStartTime = new Date(shift.startTime);

      if (Number.isNaN(shiftStartTime.getTime())) {
        throw ShiftLifecycleService.createError({
          message: "The pending-funding Shift start time is invalid.",
          code: "INVALID_SHIFT_START_TIME",
          statusCode: 500,
        });
      }

      if (shiftStartTime > expirationDate) {
        return {
          expired: false,
          alreadyFinalized: false,
          shiftId: String(shift._id),
          referenceCode: shift.referenceCode,
          startTime: shift.startTime,
        };
      }

      const occurrences = await ShiftLifecycleService.getOccurrences({
        shiftId: shift._id,
        session,
      });

      const affectedOccurrences = occurrences.filter(
        (occurrence) => occurrence.status === "scheduled" && !occurrence.cancelledAt
      );

      const reason = "The Shift expired because it was not funded before its scheduled start time.";

      for (const occurrence of affectedOccurrences) {
        ShiftLifecycleService.setOccurrenceCancellationFacts({
          occurrence,
          code: "funding_deadline_passed",
          actor: "system",
          actorUserId: null,
          reason,
          now: expirationDate,
          compensation: null,
        });

        await occurrence.save({
          session,
        });
      }

      const firstAffectedOccurrence = affectedOccurrences[0] || null;

      ShiftLifecycleService.setParentCancellationFacts({
        shift,
        cancelledFromStatus: "pending_funding",
        code: "funding_deadline_passed",
        actor: "system",
        actorUserId: null,
        reason,
        cancelledAt: expirationDate,
        firstAffectedOccurrence,
        cancelledOccurrenceCount: affectedOccurrences.length,
        compensation: null,
      });

      await shift.save({
        session,
      });

      await ShiftLifecycleService.reconcileParentShift({
        shiftId: shift._id,
        currentTime: expirationDate,
        session,
      });

      logger.info(`Pending-funding Shift ${shift.referenceCode} expired automatically`);

      return {
        expired: true,
        alreadyFinalized: false,
        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        cancelledAt: expirationDate,
        cancelledOccurrenceCount: affectedOccurrences.length,
      };
    });
  }

  static async expireUnfundedShifts({ now = new Date(), limit = 100 } = {}) {
    const expirationDate = ShiftLifecycleService.normalizeDate(now, "expiration date");

    const batchLimit = ShiftLifecycleService.normalizeBatchLimit(limit);

    const shiftIds = await Shift.find({
      status: "pending_funding",
      paymentStatus: "unpaid",
      startTime: {
        $lte: expirationDate,
      },
      $or: [
        {
          fundedAmount: 0,
        },
        {
          fundedAmount: null,
        },
        {
          fundedAmount: {
            $exists: false,
          },
        },
      ],
    })
      .select("_id")
      .sort({
        startTime: 1,
        _id: 1,
      })
      .limit(batchLimit)
      .lean();

    const results = [];

    for (const item of shiftIds) {
      try {
        const result = await ShiftLifecycleService.expireUnfundedShift({
          shiftId: item._id,
          now: expirationDate,
        });

        results.push({
          shiftId: String(item._id),
          success: true,
          result,
        });
      } catch (error) {
        logger.error(`Failed to expire pending-funding Shift ${item._id}: ${error.message}`);

        results.push({
          shiftId: String(item._id),
          success: false,
          code: error.code || "UNFUNDED_SHIFT_EXPIRATION_FAILED",
          message: error.message,
        });
      }
    }

    return {
      checked: shiftIds.length,
      expired: results.filter((item) => item.success && item.result?.expired).length,
      failed: results.filter((item) => !item.success).length,
      results,
    };
  }

  /* ─────────────────────────────── FUNDED UNFILLED OCCURRENCE EXPIRATION ─────────────────────────────── */

  static componentHasSettlementActivity(component) {
    if (!component) {
      return false;
    }

    const status = String(component.status || "not_due")
      .trim()
      .toLowerCase();

    return status !== "not_due";
  }

  static occurrenceHasAttendanceActivity(occurrence) {
    return Boolean(
      occurrence?.checkedInAt ||
      occurrence?.checkedOutAt ||
      occurrence?.checkInPinUsedAt ||
      occurrence?.checkOutPinUsedAt ||
      String(occurrence?.attendanceStatus || "not_started") !== "not_started"
    );
  }

  static occurrenceHasSettlementActivity(occurrence) {
    return Boolean(
      String(occurrence?.settlementStatus || "not_due") !== "not_due" ||
      occurrence?.reviewStartedAt ||
      occurrence?.reviewDeadlineAt ||
      occurrence?.settledAt ||
      ShiftLifecycleService.componentHasSettlementActivity(occurrence?.baseSettlement) ||
      ShiftLifecycleService.componentHasSettlementActivity(occurrence?.overtimeSettlement) ||
      occurrence?.topUpTransaction ||
      Number(occurrence?.topUpRequired || 0) > 0 ||
      occurrence?.overtime?.requested === true
    );
  }

  static occurrenceHasChallengeActivity(occurrence) {
    return Boolean(
      occurrence?.activeClaim ||
      occurrence?.activeDispute ||
      occurrence?.challengeWindowOpenedAt ||
      occurrence?.challengeDeadlineAt ||
      occurrence?.challengeWindowClosedAt
    );
  }

  static occurrenceHasRefundActivity(occurrence) {
    const refundStatus = String(occurrence?.refundStatus || "not_eligible")
      .trim()
      .toLowerCase();

    return Boolean(
      refundStatus !== "not_eligible" ||
      Number(occurrence?.refundableAmount || 0) !== 0 ||
      Number(occurrence?.refundedAmount || 0) !== 0 ||
      occurrence?.refundReason ||
      occurrence?.refundEligibleAt ||
      occurrence?.refundLastEvaluatedAt ||
      occurrence?.refundHeldAt ||
      occurrence?.refundHoldReason ||
      occurrence?.employerRefund ||
      occurrence?.refundBatch ||
      occurrence?.refundProcessingStartedAt ||
      occurrence?.refundedAt
    );
  }

  static hasAnyReplacementAudit(occurrence) {
    return Boolean(
      occurrence?.replacementRequiredAt ||
      occurrence?.replacementForAssignment ||
      occurrence?.replacementCase ||
      occurrence?.replacementReasonCode ||
      occurrence?.replacementReasonDetails
    );
  }

  static hasCompleteReplacementAudit(occurrence) {
    return Boolean(
      occurrence?.replacementRequiredAt &&
      occurrence?.replacementForAssignment &&
      occurrence?.replacementReasonCode
    );
  }

  static getPersistedUnfilledFinalizationDeadline(occurrence) {
    if (!occurrence?.fillCutoffAt) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence fill cutoff is missing.",
        code: "OCCURRENCE_FILL_CUTOFF_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    if (!occurrence?.unfilledFinalizationAt) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence unfilled-finalization deadline is missing.",
        code: "OCCURRENCE_UNFILLED_FINALIZATION_DEADLINE_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    const fillCutoffAt = new Date(occurrence.fillCutoffAt);
    const unfilledFinalizationAt = new Date(occurrence.unfilledFinalizationAt);

    if (Number.isNaN(fillCutoffAt.getTime())) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence fill cutoff is invalid.",
        code: "INVALID_OCCURRENCE_FILL_CUTOFF",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    if (Number.isNaN(unfilledFinalizationAt.getTime())) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence unfilled-finalization deadline is invalid.",
        code: "INVALID_OCCURRENCE_UNFILLED_FINALIZATION_DEADLINE",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    if (unfilledFinalizationAt <= fillCutoffAt) {
      throw ShiftLifecycleService.createError({
        message:
          "The occurrence unfilled-finalization deadline must be later than its fill cutoff.",
        code: "INVALID_OCCURRENCE_UNFILLED_FINALIZATION_ORDER",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
          fillCutoffAt,
          unfilledFinalizationAt,
        },
      });
    }

    return unfilledFinalizationAt;
  }

  static assertUnfilledExpirationAuditState(occurrence) {
    if (occurrence.assignmentStatus === "replacement_required") {
      if (!ShiftLifecycleService.hasCompleteReplacementAudit(occurrence)) {
        throw ShiftLifecycleService.createError({
          message:
            "The replacement-required occurrence does not contain a complete replacement audit.",
          code: "INCOMPLETE_REPLACEMENT_REQUIRED_AUDIT",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),
          },
        });
      }

      return true;
    }

    if (
      occurrence.assignmentStatus === "unassigned" &&
      ShiftLifecycleService.hasAnyReplacementAudit(occurrence)
    ) {
      throw ShiftLifecycleService.createError({
        message: "An ordinary unassigned occurrence cannot contain replacement audit data.",
        code: "UNASSIGNED_OCCURRENCE_REPLACEMENT_AUDIT_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
        },
      });
    }

    return true;
  }

  static getUnfilledExpirationIneligibilityReason({ shift, occurrence, currentTime }) {
    const fundedAmount = ShiftLifecycleService.assertSafeNonNegativeAmount(
      shift?.fundedAmount,
      "Shift funded amount"
    );

    if (!shift?.publishedAt || shift?.paymentStatus === "unpaid" || fundedAmount <= 0) {
      return "engagement_not_funded";
    }

    if (["completed", "cancelled", "no_show"].includes(shift.status)) {
      return "parent_status_changed";
    }

    if (
      occurrence.assignmentStatus === "expired_unfilled" ||
      occurrence.status === "expired_unfilled"
    ) {
      return "already_expired_unfilled";
    }

    if (!EXPIRABLE_ASSIGNMENT_STATUSES.includes(occurrence.assignmentStatus)) {
      return "assignment_status_changed";
    }

    ShiftLifecycleService.assertUnfilledExpirationAuditState(occurrence);

    if (occurrence.assignedProfessional || occurrence.assignment || occurrence.assignedAt) {
      return "occurrence_assigned";
    }

    if (occurrence.status !== "scheduled") {
      return "occurrence_status_changed";
    }

    if (ShiftLifecycleService.occurrenceHasAttendanceActivity(occurrence)) {
      return "attendance_activity_recorded";
    }

    if (ShiftLifecycleService.occurrenceHasSettlementActivity(occurrence)) {
      return "settlement_activity_recorded";
    }

    if (ShiftLifecycleService.occurrenceHasChallengeActivity(occurrence)) {
      return "challenge_activity_recorded";
    }

    if (ShiftLifecycleService.occurrenceHasRefundActivity(occurrence)) {
      return "refund_workflow_already_started";
    }

    const deadline = ShiftLifecycleService.getPersistedUnfilledFinalizationDeadline(occurrence);

    if (deadline > currentTime) {
      return "unfilled_finalization_deadline_not_reached";
    }

    return null;
  }

  static getUnfilledExpirationFinancialOutcome(occurrence) {
    const estimatedEmployerCharge = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.estimatedEmployerCharge,
      "occurrence estimated employer charge"
    );

    if (estimatedEmployerCharge <= 0) {
      throw ShiftLifecycleService.createError({
        message: "The funded occurrence does not contain a positive scheduled employer allocation.",
        code: "INVALID_UNFILLED_OCCURRENCE_ESTIMATED_EMPLOYER_CHARGE",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
          estimatedEmployerCharge,
        },
      });
    }

    const baseProfessionalPay = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.baseProfessionalPay,
      "occurrence base professional pay"
    );

    const overtimeProfessionalPay = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.overtimeProfessionalPay,
      "occurrence overtime professional pay"
    );

    const overtimePlatformFee = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.overtimePlatformFee,
      "occurrence overtime platform fee"
    );

    const overtimeEmployerCharge = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.overtimeEmployerCharge,
      "occurrence overtime employer charge"
    );

    const topUpRequired = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.topUpRequired,
      "occurrence top-up required"
    );

    if (baseProfessionalPay > 0 || overtimeProfessionalPay > 0) {
      throw ShiftLifecycleService.createError({
        message: "An unfilled occurrence cannot contain professional earnings.",
        code: "UNFILLED_OCCURRENCE_PROFESSIONAL_EARNINGS_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          baseProfessionalPay,
          overtimeProfessionalPay,
        },
      });
    }

    const overtimeFeeAudit = occurrence?.overtimePlatformFeeAudit || {};

    if (
      overtimePlatformFee > 0 ||
      overtimeEmployerCharge > 0 ||
      topUpRequired > 0 ||
      occurrence?.topUpTransaction ||
      occurrence?.overtime?.requested === true ||
      overtimeFeeAudit.earnedAt ||
      overtimeFeeAudit.outstandingAt ||
      overtimeFeeAudit.collectedAt ||
      overtimeFeeAudit.collectionTransaction
    ) {
      throw ShiftLifecycleService.createError({
        message: "An unfilled occurrence cannot contain overtime or top-up activity.",
        code: "UNFILLED_OCCURRENCE_OVERTIME_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
        },
      });
    }

    const retainedBasePlatformFee = ShiftLifecycleService.getRetainedBasePlatformFee(occurrence);

    const estimatedPlatformFee = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.estimatedPlatformFee,
      "occurrence estimated platform fee"
    );

    if (retainedBasePlatformFee > 0 && retainedBasePlatformFee !== estimatedPlatformFee) {
      throw ShiftLifecycleService.createError({
        message:
          "The retained earned BASE platform fee does not match the occurrence pricing snapshot.",
        code: "UNFILLED_OCCURRENCE_BASE_PLATFORM_FEE_PRICING_MISMATCH",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          retainedBasePlatformFee,
          estimatedPlatformFee,
        },
      });
    }

    if (
      occurrence.assignmentStatus === "replacement_required" &&
      estimatedPlatformFee > 0 &&
      retainedBasePlatformFee === 0
    ) {
      throw ShiftLifecycleService.createError({
        message:
          "A replacement-required occurrence is missing its previously earned BASE platform fee.",
        code: "REPLACEMENT_REQUIRED_BASE_PLATFORM_FEE_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          estimatedPlatformFee,
        },
      });
    }

    const baseFeeAudit = occurrence?.basePlatformFeeAudit || {};

    if (occurrence.assignmentStatus === "unassigned") {
      if (
        retainedBasePlatformFee !== 0 ||
        baseFeeAudit.earnedAt ||
        baseFeeAudit.outstandingAt ||
        baseFeeAudit.collectedAt ||
        baseFeeAudit.collectionTransaction
      ) {
        throw ShiftLifecycleService.createError({
          message: "An ordinary unassigned occurrence cannot retain BASE platform-fee activity.",
          code: "UNASSIGNED_OCCURRENCE_BASE_PLATFORM_FEE_CONFLICT",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),
            retainedBasePlatformFee,
          },
        });
      }
    }

    if (
      occurrence.assignmentStatus === "replacement_required" &&
      retainedBasePlatformFee > 0 &&
      (!baseFeeAudit.earnedAt ||
        !baseFeeAudit.collectedAt ||
        !baseFeeAudit.collectionTransaction ||
        baseFeeAudit.outstandingAt)
    ) {
      throw ShiftLifecycleService.createError({
        message:
          "A replacement-required occurrence must retain its completed BASE platform-fee audit.",
        code: "REPLACEMENT_REQUIRED_BASE_PLATFORM_FEE_AUDIT_INCOMPLETE",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          retainedBasePlatformFee,
        },
      });
    }

    const existingBaseEmployerCharge = ShiftLifecycleService.assertSafeNonNegativeAmount(
      occurrence?.baseEmployerCharge,
      "occurrence base employer charge"
    );

    if (existingBaseEmployerCharge !== retainedBasePlatformFee) {
      throw ShiftLifecycleService.createError({
        message:
          "The unfilled occurrence BASE employer charge does not match its retained earned BASE platform fee.",
        code: "UNFILLED_OCCURRENCE_BASE_CHARGE_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          existingBaseEmployerCharge,
          retainedBasePlatformFee,
        },
      });
    }

    const refundableAmount = estimatedEmployerCharge - retainedBasePlatformFee;

    if (!Number.isSafeInteger(refundableAmount) || refundableAmount < 0) {
      throw ShiftLifecycleService.createError({
        message: "The unfilled occurrence contains an invalid refundable scheduled balance.",
        code: "INVALID_UNFILLED_OCCURRENCE_REFUND_AMOUNT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          estimatedEmployerCharge,
          retainedBasePlatformFee,
          refundableAmount,
        },
      });
    }

    return {
      estimatedEmployerCharge,
      retainedBasePlatformFee,
      refundableAmount,
    };
  }

  static resetUnfilledExpirationRefundMirror(occurrence) {
    occurrence.refundableAmount = 0;
    occurrence.refundedAmount = 0;
    occurrence.refundStatus = "not_eligible";
    occurrence.refundReason = null;
    occurrence.refundEligibleAt = null;
    occurrence.refundLastEvaluatedAt = null;
    occurrence.refundHeldAt = null;
    occurrence.refundHoldReason = null;
    occurrence.employerRefund = null;
    occurrence.refundBatch = null;
    occurrence.refundProcessingStartedAt = null;
    occurrence.refundedAt = null;

    if (occurrence.schema?.path("refundTransaction")) {
      occurrence.refundTransaction = null;
    }

    return occurrence;
  }

  static setOccurrenceExpiredUnfilledFacts({ occurrence, currentTime }) {
    const expiredFromAssignmentStatus = String(occurrence.assignmentStatus || "")
      .trim()
      .toLowerCase();

    if (!EXPIRABLE_ASSIGNMENT_STATUSES.includes(expiredFromAssignmentStatus)) {
      throw ShiftLifecycleService.createError({
        message: "The occurrence is not in an assignment state that may expire unfilled.",
        code: "OCCURRENCE_NOT_EXPIRABLE_UNFILLED",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),
          assignmentStatus: occurrence.assignmentStatus,
        },
      });
    }

    const financialOutcome =
      ShiftLifecycleService.getUnfilledExpirationFinancialOutcome(occurrence);

    occurrence.assignmentStatus = "expired_unfilled";
    occurrence.expiredFromAssignmentStatus = expiredFromAssignmentStatus;

    occurrence.assignedProfessional = null;
    occurrence.assignment = null;
    occurrence.assignedAt = null;

    occurrence.status = "expired_unfilled";
    occurrence.attendanceStatus = "not_started";
    occurrence.settlementStatus = "not_due";
    occurrence.expiredUnfilledAt = currentTime;

    occurrence.checkedInAt = null;
    occurrence.checkedOutAt = null;
    occurrence.checkInPinUsedAt = null;
    occurrence.checkOutPinUsedAt = null;

    occurrence.baseBillableHours = 0;
    occurrence.billableHours = 0;

    occurrence.baseProfessionalPay = 0;
    occurrence.basePlatformFee = financialOutcome.retainedBasePlatformFee;
    occurrence.baseEmployerCharge = financialOutcome.retainedBasePlatformFee;

    occurrence.overtimeProfessionalPay = 0;
    occurrence.overtimePlatformFee = 0;
    occurrence.overtimeEmployerCharge = 0;

    occurrence.topUpRequired = 0;
    occurrence.topUpTransaction = null;

    occurrence.set("baseSettlement", {
      status: "not_due",
    });

    occurrence.set("overtimeSettlement", {
      status: "not_due",
    });

    occurrence.reviewStartedAt = null;
    occurrence.reviewDeadlineAt = null;
    occurrence.settledAt = null;

    ShiftLifecycleService.resetUnfilledExpirationRefundMirror(occurrence);

    return financialOutcome;
  }

  static isOccurrenceInParentReplacementTail({ shift, occurrence }) {
    const replacementHiring = shift?.replacementHiring || {};

    if (String(replacementHiring.status || "closed") !== "open") {
      return false;
    }

    if (!replacementHiring.replacementForAssignment || !occurrence?.replacementForAssignment) {
      return false;
    }

    if (
      String(replacementHiring.replacementForAssignment) !==
      String(occurrence.replacementForAssignment)
    ) {
      return false;
    }

    if (!replacementHiring.assignmentCase || !occurrence.replacementCase) {
      return false;
    }

    if (String(replacementHiring.assignmentCase) !== String(occurrence.replacementCase)) {
      return false;
    }

    const sequenceNumber = Number(occurrence.sequenceNumber);
    const startSequenceNumber = Number(replacementHiring.startSequenceNumber);
    const endSequenceNumber = Number(replacementHiring.endSequenceNumber);

    if (
      !Number.isSafeInteger(sequenceNumber) ||
      !Number.isSafeInteger(startSequenceNumber) ||
      !Number.isSafeInteger(endSequenceNumber)
    ) {
      return false;
    }

    return sequenceNumber >= startSequenceNumber && sequenceNumber <= endSequenceNumber;
  }

  static getParentReplacementTailOccurrences({ shift, occurrences }) {
    return occurrences.filter(
      (occurrence) =>
        occurrence.assignmentStatus === "replacement_required" &&
        occurrence.status === "scheduled" &&
        ShiftLifecycleService.isOccurrenceInParentReplacementTail({
          shift,
          occurrence,
        })
    );
  }

  static assertContiguousReplacementRange(occurrences) {
    if (!Array.isArray(occurrences) || occurrences.length <= 1) {
      return true;
    }

    const sortedOccurrences = [...occurrences].sort(
      (left, right) => Number(left.sequenceNumber) - Number(right.sequenceNumber)
    );

    for (let index = 1; index < sortedOccurrences.length; index += 1) {
      const previousSequence = Number(sortedOccurrences[index - 1].sequenceNumber);
      const currentSequence = Number(sortedOccurrences[index].sequenceNumber);

      if (currentSequence !== previousSequence + 1) {
        throw ShiftLifecycleService.createError({
          message: "The parent replacement occurrence range is not contiguous.",
          code: "NON_CONTIGUOUS_REPLACEMENT_RANGE",
          statusCode: 500,
          details: {
            previousSequence,
            currentSequence,
          },
        });
      }
    }

    return true;
  }

  static updateParentReplacementHiringRange({ shift, remainingOccurrences }) {
    ShiftLifecycleService.assertContiguousReplacementRange(remainingOccurrences);

    if (!Array.isArray(remainingOccurrences) || remainingOccurrences.length === 0) {
      throw ShiftLifecycleService.createError({
        message: "At least one replacement occurrence is required to keep replacement hiring open.",
        code: "EMPTY_REPLACEMENT_RANGE",
        statusCode: 500,
      });
    }

    const sortedOccurrences = [...remainingOccurrences].sort(
      (left, right) => Number(left.sequenceNumber) - Number(right.sequenceNumber)
    );

    shift.replacementHiring.startSequenceNumber = Number(sortedOccurrences[0].sequenceNumber);
    shift.replacementHiring.endSequenceNumber = Number(
      sortedOccurrences[sortedOccurrences.length - 1].sequenceNumber
    );
    shift.replacementHiring.occurrenceCount = sortedOccurrences.length;

    return shift;
  }

  static closeParentReplacementHiring(shift) {
    shift.replacementHiring = {
      status: "closed",
      assignmentCase: null,
      applicationRound: null,
      replacementForAssignment: null,
      startSequenceNumber: null,
      endSequenceNumber: null,
      occurrenceCount: 0,
      reasonCode: null,
      reasonDetails: null,
      openedAt: null,
      openedBy: null,
      filledAt: null,
      filledByAssignment: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    };

    return shift;
  }

  static async reconcileReplacementHiringAfterUnfilledExpiration({
    shift,
    occurrences,
    expiredOccurrence,
    currentTime,
    session,
  }) {
    if (expiredOccurrence.expiredFromAssignmentStatus !== "replacement_required") {
      return {
        parentReplacementTailAffected: false,
        remainingReplacementOccurrenceCount: 0,
        expiredOccurrenceApplicationCount: 0,
        expiredParentApplicationCount: 0,
      };
    }

    const isolatedApplicationResult = await ShiftLifecycleService.expireOpenApplications({
      shiftId: shift._id,
      occurrenceId: expiredOccurrence._id,
      session,
    });

    const wasInParentReplacementTail = ShiftLifecycleService.isOccurrenceInParentReplacementTail({
      shift,
      occurrence: expiredOccurrence,
    });

    if (!wasInParentReplacementTail) {
      return {
        parentReplacementTailAffected: false,
        remainingReplacementOccurrenceCount: 0,
        expiredOccurrenceApplicationCount: Number(
          isolatedApplicationResult?.expiredApplicationCount || 0
        ),
        expiredParentApplicationCount: 0,
      };
    }

    const remainingTailOccurrences = ShiftLifecycleService.getParentReplacementTailOccurrences({
      shift,
      occurrences,
    }).filter((occurrence) => String(occurrence._id) !== String(expiredOccurrence._id));

    let expiredParentApplicationCount = 0;

    if (remainingTailOccurrences.length > 0) {
      ShiftLifecycleService.updateParentReplacementHiringRange({
        shift,
        remainingOccurrences: remainingTailOccurrences,
      });
    } else {
      const applicationRound = shift.replacementHiring?.applicationRound ?? null;

      if (applicationRound !== null && applicationRound !== undefined) {
        const parentApplicationResult = await ShiftLifecycleService.expireOpenApplications({
          shiftId: shift._id,
          applicationRound,
          occurrenceId: undefined,
          session,
        });

        expiredParentApplicationCount = Number(
          parentApplicationResult?.expiredApplicationCount || 0
        );
      }

      ShiftLifecycleService.closeParentReplacementHiring(shift);
    }

    await shift.save({
      session,
    });

    return {
      parentReplacementTailAffected: true,
      remainingReplacementOccurrenceCount: remainingTailOccurrences.length,
      expiredOccurrenceApplicationCount: Number(
        isolatedApplicationResult?.expiredApplicationCount || 0
      ),
      expiredParentApplicationCount,
      currentTime,
    };
  }

  static async expireUnfilledOccurrence({ shiftId, occurrenceId, now = new Date() }, options = {}) {
    const expirationDate = ShiftLifecycleService.normalizeDate(now, "expiration date");

    return ShiftLifecycleService.runWithOptionalTransaction(options, async (session) => {
      const shift = await ShiftLifecycleService.getSystemShift({
        shiftId,
        session,
      });

      const occurrence = await ShiftLifecycleService.getSystemOccurrence({
        shiftId,
        occurrenceId,
        session,
      });

      if (
        occurrence.assignmentStatus === "expired_unfilled" &&
        occurrence.status === "expired_unfilled"
      ) {
        return {
          expired: true,
          alreadyFinalized: true,
          shiftId: String(shift._id),
          occurrenceId: String(occurrence._id),
          referenceCode: occurrence.referenceCode,
          expiredFromAssignmentStatus: occurrence.expiredFromAssignmentStatus || null,
          expiredUnfilledAt: occurrence.expiredUnfilledAt || null,
        };
      }

      const ineligibilityReason = ShiftLifecycleService.getUnfilledExpirationIneligibilityReason({
        shift,
        occurrence,
        currentTime: expirationDate,
      });

      if (ineligibilityReason) {
        return {
          expired: false,
          alreadyFinalized: false,
          shiftId: String(shift._id),
          occurrenceId: String(occurrence._id),
          referenceCode: occurrence.referenceCode,
          assignmentStatus: occurrence.assignmentStatus,
          status: occurrence.status,
          reason: ineligibilityReason,
          unfilledFinalizationAt: occurrence.unfilledFinalizationAt || null,
        };
      }

      const occurrences = await ShiftLifecycleService.getOccurrences({
        shiftId: shift._id,
        session,
      });

      const targetOccurrence = occurrences.find(
        (item) => String(item._id) === String(occurrence._id)
      );

      if (!targetOccurrence) {
        throw ShiftLifecycleService.createError({
          message: "The occurrence could not be resolved inside its parent occurrence set.",
          code: "SHIFT_OCCURRENCE_CONTEXT_NOT_FOUND",
          statusCode: 500,
        });
      }

      if (
        targetOccurrence.assignmentStatus === "replacement_required" &&
        ShiftLifecycleService.isOccurrenceInParentReplacementTail({
          shift,
          occurrence: targetOccurrence,
        })
      ) {
        const tailOccurrences = ShiftLifecycleService.getParentReplacementTailOccurrences({
          shift,
          occurrences,
        });

        ShiftLifecycleService.assertContiguousReplacementRange(tailOccurrences);

        const firstTailOccurrence = [...tailOccurrences].sort(
          (left, right) => Number(left.sequenceNumber) - Number(right.sequenceNumber)
        )[0];

        if (
          firstTailOccurrence &&
          String(firstTailOccurrence._id) !== String(targetOccurrence._id)
        ) {
          return {
            expired: false,
            alreadyFinalized: false,
            shiftId: String(shift._id),
            occurrenceId: String(targetOccurrence._id),
            referenceCode: targetOccurrence.referenceCode,
            assignmentStatus: targetOccurrence.assignmentStatus,
            status: targetOccurrence.status,
            reason: "earlier_replacement_occurrence_pending",
            blockingOccurrenceId: String(firstTailOccurrence._id),
            blockingSequenceNumber: firstTailOccurrence.sequenceNumber,
          };
        }
      }

      const financialOutcome = ShiftLifecycleService.setOccurrenceExpiredUnfilledFacts({
        occurrence: targetOccurrence,
        currentTime: expirationDate,
      });

      const refundResult = await ShiftLifecycleService.reevaluateRefundObligation({
        shift,
        occurrence: targetOccurrence,
        reason: "expired_unfilled",
        initiatedBy: {
          role: "system",
          userId: null,
        },
        currentTime: expirationDate,
        session,
      });

      const resolvedOccurrence = refundResult?.occurrence || targetOccurrence;

      const replacementResult =
        await ShiftLifecycleService.reconcileReplacementHiringAfterUnfilledExpiration({
          shift,
          occurrences,
          expiredOccurrence: resolvedOccurrence,
          currentTime: expirationDate,
          session,
        });

      const reconciliation = await ShiftLifecycleService.reconcileParentShift({
        shiftId: shift._id,
        currentTime: expirationDate,
        session,
      });

      logger.info(
        `Occurrence ${resolvedOccurrence.referenceCode} expired unfilled from ${resolvedOccurrence.expiredFromAssignmentStatus}`
      );

      return {
        expired: true,
        alreadyFinalized: false,
        shiftId: String(shift._id),
        occurrenceId: String(resolvedOccurrence._id),
        referenceCode: resolvedOccurrence.referenceCode,
        sequenceNumber: resolvedOccurrence.sequenceNumber,
        expiredFromAssignmentStatus: resolvedOccurrence.expiredFromAssignmentStatus,
        expiredUnfilledAt: expirationDate,
        retainedBasePlatformFee: financialOutcome.retainedBasePlatformFee,
        refundableAmount: Number(refundResult?.amount ?? financialOutcome.refundableAmount),
        employerRefundId: refundResult?.employerRefund?._id
          ? String(refundResult.employerRefund._id)
          : null,
        replacementResult,
        parentStatus: reconciliation?.shift?.status || reconciliation?.status || shift.status,
      };
    });
  }

  static async expireUnfilledOccurrences({ now = new Date(), limit = 100 } = {}) {
    const expirationDate = ShiftLifecycleService.normalizeDate(now, "expiration date");
    const batchLimit = ShiftLifecycleService.normalizeBatchLimit(limit);

    const candidates = await ShiftOccurrence.find({
      assignmentStatus: {
        $in: EXPIRABLE_ASSIGNMENT_STATUSES,
      },
      status: "scheduled",
      attendanceStatus: "not_started",
      settlementStatus: "not_due",
      assignedProfessional: null,
      assignment: null,
      assignedAt: null,
      unfilledFinalizationAt: {
        $ne: null,
        $lte: expirationDate,
      },
      refundStatus: "not_eligible",
    })
      .select("_id shift referenceCode sequenceNumber assignmentStatus unfilledFinalizationAt")
      .sort({
        unfilledFinalizationAt: 1,
        shift: 1,
        sequenceNumber: 1,
        _id: 1,
      })
      .limit(batchLimit)
      .lean();

    const results = [];

    for (const candidate of candidates) {
      try {
        const result = await ShiftLifecycleService.expireUnfilledOccurrence({
          shiftId: candidate.shift,
          occurrenceId: candidate._id,
          now: expirationDate,
        });

        results.push({
          shiftId: String(candidate.shift),
          occurrenceId: String(candidate._id),
          success: true,
          result,
        });
      } catch (error) {
        logger.error(`Failed to expire unfilled occurrence ${candidate._id}: ${error.message}`);

        results.push({
          shiftId: String(candidate.shift),
          occurrenceId: String(candidate._id),
          success: false,
          code: error.code || "UNFILLED_OCCURRENCE_EXPIRATION_FAILED",
          message: error.message,
        });
      }
    }

    return {
      checked: candidates.length,
      expired: results.filter((item) => item.success && item.result?.expired).length,
      skipped: results.filter(
        (item) => item.success && item.result && item.result.expired === false
      ).length,
      failed: results.filter((item) => !item.success).length,
      results,
    };
  }

  static async runLifecycleDeadlineCycle({ now = new Date(), limit = 100 } = {}) {
    const currentTime = ShiftLifecycleService.normalizeDate(now, "lifecycle cycle date");
    const batchLimit = ShiftLifecycleService.normalizeBatchLimit(limit);

    const unfundedExpiration = await ShiftLifecycleService.expireUnfundedShifts({
      now: currentTime,
      limit: batchLimit,
    });

    const unfilledOccurrenceExpiration = await ShiftLifecycleService.expireUnfilledOccurrences({
      now: currentTime,
      limit: batchLimit,
    });

    return {
      currentTime,
      unfundedExpiration,
      unfilledOccurrenceExpiration,
      checked:
        Number(unfundedExpiration?.checked || 0) +
        Number(unfilledOccurrenceExpiration?.checked || 0),
      expired:
        Number(unfundedExpiration?.expired || 0) +
        Number(unfilledOccurrenceExpiration?.expired || 0),
      failed:
        Number(unfundedExpiration?.failed || 0) + Number(unfilledOccurrenceExpiration?.failed || 0),
    };
  }

  /* ─────────────────────────────── FUNDED ENGAGEMENT CANCELLATION ─────────────────────────────── */

  static async cancelEngagement(
    { shiftId, userId, employerProfileId, employerContext, reason, now = new Date() },
    options = {}
  ) {
    const actorUserId = ShiftLifecycleService.normalizeObjectId(userId, "user ID");

    const cancellationReason = ShiftLifecycleService.normalizeReason(reason);

    const cancellationDate = ShiftLifecycleService.normalizeDate(now, "cancellation date");

    return ShiftLifecycleService.runWithOptionalTransaction(options, async (session) => {
      let shift = await ShiftLifecycleService.getEmployerShift({
        shiftId,
        employerProfileId,
        employerContext,
        session,
      });

      if (shift.status === "pending_funding") {
        throw ShiftLifecycleService.createError({
          message: "Use the pending-funding cancellation action for this unpaid Shift.",
          code: "USE_PENDING_FUNDING_CANCELLATION",
          statusCode: 409,
        });
      }

      if (shift.status === "cancelled") {
        return ShiftLifecycleService.buildExistingCancellationView(shift);
      }

      const occurrences = await ShiftLifecycleService.getOccurrences({
        shiftId: shift._id,
        session,
      });

      const preview = await ShiftLifecycleService.buildCancellationPreview({
        shift,
        occurrences,
        now: cancellationDate,
      });

      if (preview.mode === "active_work_cancellation") {
        throw ShiftLifecycleService.createError({
          message:
            "The professional has checked in. Use active-work cancellation for the active occurrence.",
          code: "SHIFT_ALREADY_CHECKED_IN_USE_ACTIVE_WORK_CANCELLATION",
          statusCode: 409,
          details: {
            occurrenceId: String(preview.firstAffectedOccurrence._id),
            sequenceNumber: preview.firstAffectedOccurrence.sequenceNumber,
          },
        });
      }

      if (preview.mode !== "cancellation") {
        throw ShiftLifecycleService.createError({
          message: "This Shift cannot use the funded engagement cancellation action.",
          code: "INVALID_SHIFT_CANCELLATION_MODE",
          statusCode: 409,
        });
      }

      const outcomes = preview.outcomes || [];
      const firstOutcome = outcomes[0] || null;
      const firstAffectedOccurrence = firstOutcome?.occurrence || null;

      if (!firstAffectedOccurrence) {
        throw ShiftLifecycleService.createError({
          message: "No affected occurrence was found for cancellation.",
          code: "CANCELLATION_OCCURRENCE_NOT_FOUND",
          statusCode: 409,
        });
      }

      const refundResults = [];

      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index];
        const occurrence = outcome.occurrence;
        const isFirstAffectedOccurrence = index === 0;

        ShiftLifecycleService.setOccurrenceCancellationFacts({
          occurrence,
          code:
            isFirstAffectedOccurrence && outcome.compensation.applicable
              ? "late_employer_cancellation"
              : "employer_cancelled",
          actor: "employer",
          actorUserId,
          reason: cancellationReason,
          now: cancellationDate,
          compensation: outcome.compensation,
        });

        await occurrence.save({
          session,
        });

        if (outcome.compensation.professionalPay > 0) {
          await ShiftLifecycleService.establishBaseSettlementOutcome({
            shift,
            occurrence,
            earningType: "cancellation_compensation",
            professionalPay: outcome.compensation.professionalPay,
            currentTime: cancellationDate,
            session,
          });
        }

        const refundResult = await ShiftLifecycleService.reevaluateRefundObligation({
          shift,
          occurrence,
          reason: "occurrence_cancelled",
          initiatedBy: {
            role: "employer",
            userId: actorUserId,
          },
          currentTime: cancellationDate,
          session,
        });

        refundResults.push({
          occurrenceId: String(occurrence._id),
          amount: Number(refundResult.amount || 0),
          employerRefundId: refundResult.employerRefund?._id
            ? String(refundResult.employerRefund._id)
            : null,
          created: refundResult.created === true,
          idempotent: refundResult.idempotent === true,
        });
      }

      await ShiftLifecycleService.closeAssignments({
        shift,
        occurrences,
        firstAffectedSequenceNumber: firstAffectedOccurrence.sequenceNumber,
        finalResponsibleSequenceNumber: Number(firstAffectedOccurrence.sequenceNumber) - 1,
        actor: "employer",
        actorUserId,
        reason: cancellationReason,
        now: cancellationDate,
        session,
      });

      const cancelledFromStatus = shift.status;

      ShiftLifecycleService.setParentCancellationFacts({
        shift,
        cancelledFromStatus,
        code: firstOutcome.compensation.applicable
          ? "late_employer_cancellation"
          : "employer_cancelled",
        actor: "employer",
        actorUserId,
        reason: cancellationReason,
        cancelledAt: cancellationDate,
        firstAffectedOccurrence,
        cancelledOccurrenceCount: outcomes.length,
        compensation: firstOutcome.compensation,
      });

      await shift.save({
        session,
      });

      const reconciliation = await ShiftLifecycleService.reconcileParentShift({
        shiftId: shift._id,
        currentTime: cancellationDate,
        session,
      });

      const totalRefundAmount = ShiftLifecycleService.addSafeAmounts(
        refundResults.map((result) => result.amount),
        "engagement cancellation refund"
      );

      const retainedPlatformFee = ShiftLifecycleService.addSafeAmounts(
        outcomes.map((outcome) => outcome.retainedBasePlatformFee),
        "engagement cancellation retained platform fee"
      );

      logger.info(
        `Shift ${shift.referenceCode} cancelled by employer user ${actorUserId}; ${outcomes.length} occurrence(s) affected`
      );

      return {
        mode: "cancellation",
        alreadyFinalized: false,
        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        status: reconciliation?.shift?.status || "cancelled",
        cancelledAt: cancellationDate,
        firstAffectedOccurrenceId: String(firstAffectedOccurrence._id),
        firstAffectedSequenceNumber: firstAffectedOccurrence.sequenceNumber,
        cancelledOccurrenceCount: outcomes.length,
        compensationApplicable: firstOutcome.compensation.applicable,
        professionalPay: firstOutcome.compensation.professionalPay,
        retainedPlatformFee,
        refundableAmount: totalRefundAmount,
        refundResults,
        currency: shift.currency,
      };
    });
  }

  /* ─────────────────────────────── ACTIVE-WORK CANCELLATION ─────────────────────────────── */

  static async cancelActiveOccurrenceWork(
    {
      shiftId,
      occurrenceId = null,
      userId,
      employerProfileId,
      employerContext,
      reason,
      now = new Date(),
    },
    options = {}
  ) {
    const actorUserId = ShiftLifecycleService.normalizeObjectId(userId, "user ID");

    const normalizedOccurrenceId = ShiftLifecycleService.normalizeObjectId(
      occurrenceId,
      "occurrence ID",
      false
    );

    const cancellationReason = ShiftLifecycleService.normalizeReason(
      reason,
      "active-work cancellation reason"
    );

    if (cancellationReason.length < 10) {
      throw ShiftLifecycleService.createError({
        message: "The active-work cancellation reason must contain at least 10 characters.",
        code: "ACTIVE_WORK_CANCELLATION_REASON_TOO_SHORT",
      });
    }

    const requestedAt = ShiftLifecycleService.normalizeDate(now, "active-work cancellation date");

    return ShiftLifecycleService.runWithOptionalTransaction(options, async (session) => {
      let shift = await ShiftLifecycleService.getEmployerShift({
        shiftId,
        employerProfileId,
        employerContext,
        session,
      });

      let occurrences = await ShiftLifecycleService.getOccurrences({
        shiftId: shift._id,
        session,
      });

      const previouslyFinalizedOccurrence = occurrences.find(
        (occurrence) => occurrence.activeWorkCancellation?.occurred === true
      );

      if (shift.status === "cancelled" && previouslyFinalizedOccurrence) {
        return {
          mode: "active_work_cancellation",
          alreadyFinalized: true,
          shiftId: String(shift._id),
          referenceCode: shift.referenceCode,
          status: shift.status,
          occurrenceId: String(previouslyFinalizedOccurrence._id),
          occurrenceReferenceCode: previouslyFinalizedOccurrence.referenceCode,
          sequenceNumber: previouslyFinalizedOccurrence.sequenceNumber,
          activeWorkCancellation: previouslyFinalizedOccurrence.activeWorkCancellation,
        };
      }

      if (TERMINAL_PARENT_STATUSES.includes(shift.status)) {
        throw ShiftLifecycleService.createError({
          message: "This Shift is already in a terminal state.",
          code: "SHIFT_ALREADY_TERMINAL",
          statusCode: 409,
        });
      }

      const activeOccurrence = ShiftLifecycleService.getActiveOccurrence(occurrences);

      if (!activeOccurrence) {
        throw ShiftLifecycleService.createError({
          message: "No checked-in occurrence is available for active-work cancellation.",
          code: "NO_ACTIVE_OCCURRENCE_FOUND",
          statusCode: 409,
        });
      }

      if (
        normalizedOccurrenceId &&
        String(activeOccurrence._id) !== String(normalizedOccurrenceId)
      ) {
        throw ShiftLifecycleService.createError({
          message: "The selected occurrence is not the active checked-in occurrence.",
          code: "OCCURRENCE_IS_NOT_ACTIVE",
          statusCode: 409,
        });
      }

      const breakdown = ShiftLifecycleService.buildActiveWorkCancellationBreakdown({
        shift,
        occurrence: activeOccurrence,
        effectiveAt: requestedAt,
      });

      const futureOccurrences = ShiftLifecycleService.getAffectedScheduledOccurrences(
        occurrences,
        Number(activeOccurrence.sequenceNumber) + 1
      );

      const futureOutcomes = futureOccurrences.map((occurrence) =>
        ShiftLifecycleService.buildScheduledCancellationOutcome({
          occurrence,
        })
      );

      ShiftLifecycleService.setOccurrenceActiveWorkCancellationFacts({
        occurrence: activeOccurrence,
        actor: "employer",
        actorUserId,
        reason: cancellationReason,
        requestedAt,
        effectiveAt: requestedAt,
        breakdown,
      });

      await activeOccurrence.save({
        session,
      });

      await ShiftLifecycleService.establishBaseSettlementOutcome({
        shift,
        occurrence: activeOccurrence,
        earningType: "active_work_cancellation",
        professionalPay: breakdown.professionalPay,
        currentTime: requestedAt,
        session,
      });

      const refundResults = [];

      const activeRefundResult = await ShiftLifecycleService.reevaluateRefundObligation({
        shift,
        occurrence: activeOccurrence,
        reason: "unused_scheduled_time",
        initiatedBy: {
          role: "employer",
          userId: actorUserId,
        },
        currentTime: requestedAt,
        session,
      });

      refundResults.push({
        occurrenceId: String(activeOccurrence._id),
        amount: Number(activeRefundResult.amount || 0),
        employerRefundId: activeRefundResult.employerRefund?._id
          ? String(activeRefundResult.employerRefund._id)
          : null,
        created: activeRefundResult.created === true,
        idempotent: activeRefundResult.idempotent === true,
      });

      for (const outcome of futureOutcomes) {
        const occurrence = outcome.occurrence;

        ShiftLifecycleService.setOccurrenceCancellationFacts({
          occurrence,
          code: "employer_cancelled",
          actor: "employer",
          actorUserId,
          reason: cancellationReason,
          now: requestedAt,
          compensation: null,
        });

        await occurrence.save({
          session,
        });

        const refundResult = await ShiftLifecycleService.reevaluateRefundObligation({
          shift,
          occurrence,
          reason: "occurrence_cancelled",
          initiatedBy: {
            role: "employer",
            userId: actorUserId,
          },
          currentTime: requestedAt,
          session,
        });

        refundResults.push({
          occurrenceId: String(occurrence._id),
          amount: Number(refundResult.amount || 0),
          employerRefundId: refundResult.employerRefund?._id
            ? String(refundResult.employerRefund._id)
            : null,
          created: refundResult.created === true,
          idempotent: refundResult.idempotent === true,
        });
      }

      await ShiftLifecycleService.closeAssignments({
        shift,
        occurrences,
        firstAffectedSequenceNumber: Number(activeOccurrence.sequenceNumber) + 1,
        finalResponsibleSequenceNumber: activeOccurrence.sequenceNumber,
        effectiveEndAtOverride: requestedAt,
        actor: "employer",
        actorUserId,
        reason: cancellationReason,
        now: requestedAt,
        session,
      });

      const cancelledFromStatus = shift.status;

      ShiftLifecycleService.setParentActiveWorkCancellationFacts({
        shift,
        cancelledFromStatus,
        actorUserId,
        reason: cancellationReason,
        effectiveAt: requestedAt,
        activeOccurrence,
        futureCancelledOccurrenceCount: futureOccurrences.length,
      });

      await shift.save({
        session,
      });

      const reconciliation = await ShiftLifecycleService.reconcileParentShift({
        shiftId: shift._id,
        currentTime: requestedAt,
        session,
      });

      const totalRefundAmount = ShiftLifecycleService.addSafeAmounts(
        refundResults.map((result) => result.amount),
        "active-work cancellation total refund"
      );

      const futureRetainedPlatformFee = ShiftLifecycleService.addSafeAmounts(
        futureOutcomes.map((outcome) => outcome.retainedBasePlatformFee),
        "future retained platform fee"
      );

      const retainedPlatformFee = ShiftLifecycleService.addSafeAmounts(
        [breakdown.retainedBasePlatformFee, futureRetainedPlatformFee],
        "active-work cancellation retained platform fee"
      );

      logger.info(
        `Occurrence ${activeOccurrence.referenceCode} ended through active-work cancellation by employer user ${actorUserId}`
      );

      return {
        mode: "active_work_cancellation",
        alreadyFinalized: false,
        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        occurrenceId: String(activeOccurrence._id),
        occurrenceReferenceCode: activeOccurrence.referenceCode,
        sequenceNumber: activeOccurrence.sequenceNumber,
        status: reconciliation?.shift?.status || "cancelled",
        occurrenceStatus: "pending_settlement",
        effectiveAt: requestedAt,
        actualWorkedMinutes: breakdown.actualWorkedMinutes,
        minimumProfessionalPayRate: breakdown.minimumProfessionalPayRate,
        actualWorkedProfessionalPay: breakdown.actualWorkedProfessionalPay,
        minimumGuaranteedProfessionalPay: breakdown.minimumGuaranteedProfessionalPay,
        professionalPay: breakdown.professionalPay,
        retainedPlatformFee,
        activeOccurrenceRefundableAmount: breakdown.refundableAmount,
        refundableAmount: totalRefundAmount,
        refundResults,
        futureCancelledOccurrenceCount: futureOccurrences.length,
        currency: shift.currency,
      };
    });
  }
}

module.exports = ShiftLifecycleService;
