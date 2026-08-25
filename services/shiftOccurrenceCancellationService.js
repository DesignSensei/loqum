// services/shiftOccurrenceCancellationService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftApplication = require("../models/ShiftApplication");

const ShiftRefundService = require("./shiftRefundService");
const ShiftSettlementService = require("./shiftSettlementService");
const ShiftOccurrenceReconciliationService = require("./shiftOccurrenceReconciliationService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const {
  OCCURRENCE_CANCELLABLE_FROM_STATUSES,
  OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES,
  INDIVIDUAL_OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES,
  INDIVIDUAL_OCCURRENCE_CANCELLATION_ACTORS,
  SHIFT_CANCELLATION_CODES,
  CANCELLATION_CODE_ACTORS,
  EMPLOYER_CANCELLATION_REASON_CODES,
  OCCURRENCE_EMPLOYER_CANCELLATION_REASON_CODES,
  OCCURRENCE_CANCELLATION_REASON_CODES_REQUIRING_DETAILS,
} = require("../constants/shiftLifecycle");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");

const INDIVIDUAL_PARENT_ALLOWED_STATUSES = Object.freeze([
  "open",
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "disputed",
  "no_show",
]);

const ACTIVE_REPLACEMENT_APPLICATION_STATUSES = Object.freeze(["pending", "shortlisted"]);

/**
 * SHIFT OCCURRENCE CANCELLATION ARCHITECTURE
 *
 * This service owns two related future-occurrence cancellation operations:
 *
 * 1. Individual occurrence cancellation
 *    - cancels one future untouched occurrence;
 *    - is available only for a multiple-schedule parent Shift;
 *    - does not cancel the parent engagement; and
 *    - leaves other occurrences active.
 *
 * 2. Parent cancellation propagation
 *    - receives an already-authorized parent cancellation;
 *    - records the date-specific outcome on one untouched future occurrence;
 *    - does not independently decide to cancel the parent Shift.
 *
 * ShiftOccurrence stores the actual date-specific cancellation outcome only.
 * The route by which that outcome was reached is service orchestration, not
 * occurrence truth.
 *
 * ACTIVE WORK
 *
 * An occurrence that has started attendance is never ordinarily cancelled.
 * Active work must use the active-work cancellation flow.
 *
 * BASE PLATFORM FEE
 *
 * This service does not earn, recalculate, refund or reverse Loqum's base fee.
 * If a confirmed assignment already earned the base fee, ordinary future
 * cancellation preserves that fee.
 *
 * CANCELLATION COMPENSATION
 *
 * Late employer cancellation may create a BASE professional entitlement.
 * This service records the compensation policy fact first. It then delegates
 * establishment of authoritative baseProfessionalPay, BASE settlement state
 * and the shared occurrence challenge window to ShiftSettlementService.
 *
 * There is no separate cancellation settlement timer.
 *
 * OVERTIME
 *
 * A future untouched occurrence cannot contain overtime activity. This
 * service asserts that boundary and never creates, clears or recalculates OT
 * money, OT fees, OT top-up state or OT settlement truth.
 *
 * CLAIMS / DISPUTES
 *
 * Uncompensated future cancellation creates no challenge opportunity because
 * no professional entitlement is created. Compensated cancellation enters
 * the same shared occurrence challenge window used by every BASE settlement
 * outcome.
 *
 * REFUNDS
 *
 * ShiftRefundService owns EmployerRefund obligation state. Refund amount is
 * derived from:
 *
 *   estimatedEmployerCharge - baseProfessionalPay - basePlatformFee
 *
 * Professional settlement state is established before refund reevaluation.
 * This service never executes a refund.
 *
 * PARENT SHIFT
 *
 * ShiftOccurrenceReconciliationService aggregates parent state only. It does
 * not create occurrence cancellation, settlement, refund or replacement truth.
 */
class ShiftOccurrenceCancellationService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftOccurrenceCancellationServiceError";
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

      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} is required.`,
        code: `${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeRequiredText(value, fieldName, maximumLength = 500) {
    const normalized = String(value || "").trim();

    if (!normalized) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} is required.`,
        code: `${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (normalized.length > maximumLength) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} cannot exceed ${maximumLength} characters.`,
        code: `${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return normalized;
  }

  static normalizeOptionalText(value, maximumLength = 500) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const normalized = String(value).trim();

    if (!normalized) {
      return null;
    }

    if (normalized.length > maximumLength) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `Text cannot exceed ${maximumLength} characters.`,
        code: "TEXT_TOO_LONG",
      });
    }

    return normalized;
  }

  static normalizeEnum(value, allowedValues, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} is required.`,
        code: `${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    const normalized = String(value).trim().toLowerCase();

    if (!allowedValues.includes(normalized)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}`,
        details: {
          allowedValues,
        },
      });
    }

    return normalized;
  }

  static amount(value, fieldName = "Amount") {
    try {
      return money.normalizeMinorUnitAmount(value ?? 0, fieldName);
    } catch (error) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} must be a non-negative whole number in minor units.`,
        code: `INVALID_${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }
  }

  static sumAmounts(values, fieldName) {
    if (!Array.isArray(values)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} values are invalid.`,
        code: `INVALID_${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    try {
      return money.sumMinorUnitAmounts(values, fieldName);
    } catch (error) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${fieldName} is invalid or too large.`,
        code: `INVALID_${ShiftOccurrenceCancellationService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }
  }

  static sameId(left, right) {
    if (!left || !right) {
      return false;
    }

    return String(left) === String(right);
  }

  static sameNullableId(left, right) {
    if (!left && !right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    return String(left) === String(right);
  }

  static buildCancellationAuditReason({ reasonCode = null, reason = null }) {
    const normalizedReasonCode = reasonCode ? String(reasonCode).trim().toLowerCase() : null;
    const normalizedReason = ShiftOccurrenceCancellationService.normalizeOptionalText(reason, 500);

    let auditReason = normalizedReason;

    if (normalizedReasonCode && normalizedReason) {
      auditReason = `${normalizedReasonCode}: ${normalizedReason}`;
    } else if (normalizedReasonCode) {
      auditReason = normalizedReasonCode;
    }

    if (!auditReason) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Cancellation reason is required.",
        code: "CANCELLATION_REASON_REQUIRED",
      });
    }

    if (auditReason.length > 500) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Cancellation audit reason cannot exceed 500 characters.",
        code: "CANCELLATION_AUDIT_REASON_TOO_LONG",
      });
    }

    return auditReason;
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getShift(shiftId, session = null) {
    const normalizedShiftId = ShiftOccurrenceCancellationService.normalizeObjectId(
      shiftId,
      "shift ID"
    );

    const query = Shift.findById(normalizedShiftId);

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getOccurrence({ shiftId, occurrenceId, session = null }) {
    const normalizedShiftId = ShiftOccurrenceCancellationService.normalizeObjectId(
      shiftId,
      "shift ID"
    );

    const normalizedOccurrenceId = ShiftOccurrenceCancellationService.normalizeObjectId(
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
      throw ShiftOccurrenceCancellationService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  /* ─────────────────────────────── BASIC ASSERTIONS ─────────────────────────────── */

  static assertOccurrenceBelongsToShift({ shift, occurrence }) {
    if (!ShiftOccurrenceCancellationService.sameId(occurrence.shift, shift._id)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence does not belong to the supplied Shift.",
        code: "OCCURRENCE_SHIFT_MISMATCH",
        statusCode: 409,
      });
    }

    if (!ShiftOccurrenceCancellationService.sameId(occurrence.business, shift.business)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence business does not match the parent Shift.",
        code: "OCCURRENCE_BUSINESS_MISMATCH",
        statusCode: 409,
      });
    }

    if (!ShiftOccurrenceCancellationService.sameId(occurrence.branch, shift.branch)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence branch does not match the parent Shift.",
        code: "OCCURRENCE_BRANCH_MISMATCH",
        statusCode: 409,
      });
    }
  }

  static assertEmployerOwnsShift({ shift, businessId }) {
    const normalizedBusinessId = ShiftOccurrenceCancellationService.normalizeObjectId(
      businessId,
      "business ID"
    );

    if (!ShiftOccurrenceCancellationService.sameId(shift.business, normalizedBusinessId)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The Shift does not belong to this employer.",
        code: "SHIFT_BUSINESS_MISMATCH",
        statusCode: 403,
      });
    }
  }

  static assertParentAllowsIndividualCancellation(shift) {
    if (shift.scheduleMode !== "multiple") {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "The only occurrence of a single Shift must be cancelled through the parent Shift cancellation flow.",
        code: "SINGLE_SHIFT_REQUIRES_PARENT_CANCELLATION",
        statusCode: 409,
      });
    }

    if (!INDIVIDUAL_PARENT_ALLOWED_STATUSES.includes(shift.status)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `An occurrence cannot be individually cancelled while the parent Shift is ${shift.status}.`,
        code: "PARENT_SHIFT_NOT_OPEN_FOR_OCCURRENCE_CANCELLATION",
        statusCode: 409,
        details: {
          parentStatus: shift.status,
        },
      });
    }

    if (!shift.publishedAt || shift.paymentStatus === "unpaid") {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Only a funded and published Shift may cancel one occurrence.",
        code: "SHIFT_NOT_FUNDED_OR_PUBLISHED",
        statusCode: 409,
      });
    }
  }

  static assertCancellationCodeActor({ cancellationCode, cancelledBy }) {
    const requiredActor = CANCELLATION_CODE_ACTORS?.[cancellationCode] || null;

    if (requiredActor && requiredActor !== cancelledBy) {
      throw ShiftOccurrenceCancellationService.createError({
        message: `${cancellationCode} must be recorded as a ${requiredActor} cancellation.`,
        code: "CANCELLATION_CODE_ACTOR_MISMATCH",
        statusCode: 409,
        details: {
          cancellationCode,
          cancelledBy,
          requiredActor,
        },
      });
    }
  }

  static settlementComponentHasActivity(component) {
    if (!component) {
      return false;
    }

    return Boolean(
      String(component.status || "not_due") !== "not_due" ||
      component.earningType ||
      Number(component.professionalPay || 0) > 0 ||
      component.approvedForReleaseAt ||
      component.approvalSource ||
      component.approvedForReleaseBy ||
      component.scheduledPayoutAt ||
      component.settlementBatch ||
      component.releasePendingAt ||
      component.releasedAt ||
      component.payoutTransaction
    );
  }

  static occurrenceHasAttendanceActivity(occurrence) {
    return Boolean(
      occurrence.attendanceStatus !== "not_started" ||
      occurrence.checkedInAt ||
      occurrence.checkedOutAt ||
      occurrence.checkInPinUsedAt ||
      occurrence.checkOutPinUsedAt ||
      occurrence.attendanceOverride?.used === true ||
      occurrence.lateCheckout?.occurred === true ||
      occurrence.checkoutFallback?.required === true
    );
  }

  static occurrenceHasSettlementActivity(occurrence) {
    return Boolean(
      occurrence.settlementStatus !== "not_due" ||
      occurrence.settledAt ||
      ShiftOccurrenceCancellationService.settlementComponentHasActivity(
        occurrence.baseSettlement
      ) ||
      ShiftOccurrenceCancellationService.settlementComponentHasActivity(
        occurrence.overtimeSettlement
      )
    );
  }

  static occurrenceHasOvertimeActivity(occurrence) {
    const overtime = occurrence.overtime || {};
    const overtimeFeeAudit = occurrence.overtimePlatformFeeAudit || {};

    return Boolean(
      overtime.requested === true ||
      overtime.status ||
      Number(overtime.requestedMinutes || 0) !== 0 ||
      overtime.requestedBy ||
      overtime.requestedAt ||
      overtime.source ||
      Number(occurrence.overtimeProfessionalPay || 0) !== 0 ||
      Number(occurrence.overtimePlatformFee || 0) !== 0 ||
      Number(occurrence.topUpRequired || 0) !== 0 ||
      occurrence.topUpTransaction ||
      Number(overtime.topUpAmount || 0) !== 0 ||
      overtime.topUpDeadlineAt ||
      overtime.topUpOverdueAt ||
      overtime.topUpPaid === true ||
      overtime.topUpPaidAt ||
      overtime.restrictionTriggeredAt ||
      overtimeFeeAudit.earnedAt ||
      overtimeFeeAudit.outstandingAt ||
      overtimeFeeAudit.collectedAt ||
      overtimeFeeAudit.collectionTransaction
    );
  }

  static occurrenceHasActiveWorkCancellationActivity(occurrence) {
    const cancellation = occurrence.activeWorkCancellation || {};

    return Boolean(
      cancellation.occurred === true ||
      cancellation.initiatedBy ||
      cancellation.initiatedByUser ||
      cancellation.reason ||
      cancellation.requestedAt ||
      cancellation.effectiveAt ||
      Number(cancellation.actualWorkedMinutes || 0) !== 0 ||
      Number(cancellation.minimumProfessionalPayRate || 0) !== 0 ||
      Number(cancellation.actualWorkedProfessionalPay || 0) !== 0 ||
      Number(cancellation.minimumGuaranteedProfessionalPay || 0) !== 0 ||
      Number(cancellation.professionalPay || 0) !== 0 ||
      cancellation.calculatedAt
    );
  }

  static occurrenceHasChallengeActivity(occurrence) {
    return Boolean(
      occurrence.activeClaim ||
      occurrence.activeDispute ||
      occurrence.challengeWindowOpenedAt ||
      occurrence.challengeDeadlineAt ||
      occurrence.challengeWindowClosedAt
    );
  }

  static occurrenceHasRefundAudit(occurrence) {
    return Boolean(
      occurrence.refundStatus !== "not_eligible" ||
      Number(occurrence.refundableAmount || 0) !== 0 ||
      Number(occurrence.refundedAmount || 0) !== 0 ||
      occurrence.refundReason ||
      occurrence.refundEligibleAt ||
      occurrence.refundLastEvaluatedAt ||
      occurrence.refundHeldAt ||
      occurrence.refundHoldReason ||
      occurrence.employerRefund ||
      occurrence.refundBatch ||
      occurrence.refundProcessingStartedAt ||
      occurrence.refundedAt
    );
  }

  static assertFutureUntouchedOccurrence({ occurrence, currentTime, allowedAssignmentStatuses }) {
    if (!OCCURRENCE_CANCELLABLE_FROM_STATUSES.includes(occurrence.status)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          `Only a scheduled occurrence may be cancelled. ` +
          `This occurrence is ${occurrence.status}.`,
        code: "OCCURRENCE_NOT_CANCELLABLE_FROM_STATUS",
        statusCode: 409,
        details: {
          occurrenceStatus: occurrence.status,
        },
      });
    }

    if (
      !Array.isArray(allowedAssignmentStatuses) ||
      !allowedAssignmentStatuses.includes(occurrence.assignmentStatus)
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          `The occurrence assignment state ` +
          `${occurrence.assignmentStatus} cannot be cancelled.`,
        code: "OCCURRENCE_ASSIGNMENT_STATUS_NOT_CANCELLABLE",
        statusCode: 409,
        details: {
          assignmentStatus: occurrence.assignmentStatus,
          allowedAssignmentStatuses,
        },
      });
    }

    const startTime = new Date(occurrence.startTime);

    if (Number.isNaN(startTime.getTime())) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence start time is invalid.",
        code: "INVALID_OCCURRENCE_START_TIME",
        statusCode: 500,
      });
    }

    if (currentTime >= startTime) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An occurrence must be cancelled before its scheduled start time.",
        code: "OCCURRENCE_ALREADY_STARTED",
        statusCode: 409,
        details: {
          startTime,
          currentTime,
        },
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasAttendanceActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An occurrence with attendance activity cannot be ordinarily cancelled.",
        code: "OCCURRENCE_HAS_ATTENDANCE_ACTIVITY",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasSettlementActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An occurrence with settlement activity cannot be ordinarily cancelled.",
        code: "OCCURRENCE_HAS_SETTLEMENT_ACTIVITY",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasOvertimeActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An occurrence with overtime or top-up activity cannot be ordinarily cancelled.",
        code: "OCCURRENCE_HAS_OVERTIME_ACTIVITY",
        statusCode: 409,
      });
    }

    if (
      ShiftOccurrenceCancellationService.occurrenceHasActiveWorkCancellationActivity(occurrence)
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An occurrence with active-work cancellation cannot also be ordinarily cancelled.",
        code: "ACTIVE_WORK_CANCELLATION_ALREADY_RECORDED",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasChallengeActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An occurrence with challenge activity cannot be ordinarily cancelled.",
        code: "OCCURRENCE_HAS_CHALLENGE_ACTIVITY",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasRefundAudit(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence has already entered the refund workflow.",
        code: "OCCURRENCE_REFUND_ALREADY_ESTABLISHED",
        statusCode: 409,
        details: {
          refundStatus: occurrence.refundStatus,
        },
      });
    }
  }

  static assertFundingDeadlineOccurrence(occurrence) {
    if (occurrence.status !== "scheduled" || occurrence.assignmentStatus !== "unassigned") {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "funding_deadline_passed may only propagate to an unassigned scheduled occurrence.",
        code: "INVALID_FUNDING_DEADLINE_OCCURRENCE",
        statusCode: 409,
        details: {
          occurrenceStatus: occurrence.status,
          assignmentStatus: occurrence.assignmentStatus,
        },
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasAttendanceActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An unfunded occurrence with attendance activity cannot be cancelled through the funding deadline flow.",
        code: "UNFUNDED_OCCURRENCE_HAS_ATTENDANCE_ACTIVITY",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasSettlementActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An unfunded occurrence with settlement activity cannot be cancelled through the funding deadline flow.",
        code: "UNFUNDED_OCCURRENCE_HAS_SETTLEMENT_ACTIVITY",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasOvertimeActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An unfunded occurrence with overtime or top-up activity cannot be cancelled through the funding deadline flow.",
        code: "UNFUNDED_OCCURRENCE_HAS_OVERTIME_ACTIVITY",
        statusCode: 409,
      });
    }

    if (
      ShiftOccurrenceCancellationService.occurrenceHasActiveWorkCancellationActivity(occurrence)
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An occurrence with active-work cancellation cannot be cancelled through the funding deadline flow.",
        code: "UNFUNDED_OCCURRENCE_HAS_ACTIVE_WORK_CANCELLATION",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasChallengeActivity(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An unfunded occurrence with challenge activity cannot be cancelled through the funding deadline flow.",
        code: "UNFUNDED_OCCURRENCE_HAS_CHALLENGE_ACTIVITY",
        statusCode: 409,
      });
    }

    if (ShiftOccurrenceCancellationService.occurrenceHasRefundAudit(occurrence)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An unfunded occurrence with refund activity cannot be cancelled through the funding deadline flow.",
        code: "UNFUNDED_OCCURRENCE_HAS_REFUND_ACTIVITY",
        statusCode: 409,
      });
    }

    const basePlatformFee = ShiftOccurrenceCancellationService.amount(
      occurrence.basePlatformFee,
      "Base platform fee"
    );

    const feeAudit = occurrence.basePlatformFeeAudit || {};

    if (
      basePlatformFee !== 0 ||
      feeAudit.earnedAt ||
      feeAudit.outstandingAt ||
      feeAudit.collectedAt ||
      feeAudit.collectionTransaction
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "An unfunded occurrence cannot contain an earned base platform fee.",
        code: "UNFUNDED_OCCURRENCE_HAS_BASE_PLATFORM_FEE",
        statusCode: 409,
      });
    }
  }

  /* ─────────────────────────────── BASE FEE AUTHORITY ─────────────────────────────── */

  static getRetainedBasePlatformFee(occurrence) {
    const estimatedPlatformFee = ShiftOccurrenceCancellationService.amount(
      occurrence.estimatedPlatformFee,
      "Estimated platform fee"
    );

    const basePlatformFee = ShiftOccurrenceCancellationService.amount(
      occurrence.basePlatformFee,
      "Base platform fee"
    );

    const audit = occurrence.basePlatformFeeAudit || {};

    const hasAnyFeeAudit = Boolean(
      audit.earnedAt || audit.outstandingAt || audit.collectedAt || audit.collectionTransaction
    );

    if (audit.earnedAt) {
      if (basePlatformFee !== estimatedPlatformFee) {
        throw ShiftOccurrenceCancellationService.createError({
          message: "The earned base platform fee does not match the occurrence pricing snapshot.",
          code: "BASE_PLATFORM_FEE_PRICING_MISMATCH",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),
            estimatedPlatformFee,
            basePlatformFee,
          },
        });
      }

      if (!audit.collectedAt || !audit.collectionTransaction || audit.outstandingAt) {
        throw ShiftOccurrenceCancellationService.createError({
          message:
            "The occurrence contains an earned base platform fee without a completed collection audit.",
          code: "BASE_PLATFORM_FEE_AUDIT_INCOMPLETE",
          statusCode: 500,
        });
      }

      return basePlatformFee;
    }

    if (basePlatformFee !== 0 || hasAnyFeeAudit) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence contains base platform-fee state without an earning event.",
        code: "UNEARNED_BASE_PLATFORM_FEE_STATE_CONFLICT",
        statusCode: 500,
      });
    }

    if (["assigned", "replacement_required"].includes(occurrence.assignmentStatus)) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "An occurrence with confirmed assignment history is missing its base platform-fee earning audit.",
        code: "CONFIRMED_OCCURRENCE_BASE_FEE_AUDIT_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          assignmentStatus: occurrence.assignmentStatus,
        },
      });
    }

    return 0;
  }

  /* ─────────────────────────────── CANCELLATION INPUT ─────────────────────────────── */

  static normalizeIndividualCancellationInput(payload) {
    const cancelledBy = ShiftOccurrenceCancellationService.normalizeEnum(
      payload.cancelledBy || "employer",
      INDIVIDUAL_OCCURRENCE_CANCELLATION_ACTORS,
      "cancelledBy"
    );

    const cancelledByUserId = ShiftOccurrenceCancellationService.normalizeObjectId(
      payload.cancelledByUserId,
      "cancelled-by user ID"
    );

    let cancellationReasonCode = null;
    let cancellationReason = ShiftOccurrenceCancellationService.normalizeOptionalText(
      payload.cancellationReason,
      500
    );

    if (cancelledBy === "employer") {
      cancellationReasonCode = ShiftOccurrenceCancellationService.normalizeEnum(
        payload.cancellationReasonCode,
        OCCURRENCE_EMPLOYER_CANCELLATION_REASON_CODES,
        "cancellation reason code"
      );

      if (
        OCCURRENCE_CANCELLATION_REASON_CODES_REQUIRING_DETAILS.includes(cancellationReasonCode) &&
        !cancellationReason
      ) {
        throw ShiftOccurrenceCancellationService.createError({
          message: `${cancellationReasonCode} requires cancellation details.`,
          code: "CANCELLATION_DETAILS_REQUIRED",
        });
      }
    } else {
      if (payload.cancellationReasonCode) {
        throw ShiftOccurrenceCancellationService.createError({
          message:
            "Admin occurrence cancellation must use an audit reason instead of an employer reason code.",
          code: "ADMIN_CANCELLATION_REASON_CODE_NOT_ALLOWED",
        });
      }

      cancellationReason = ShiftOccurrenceCancellationService.normalizeRequiredText(
        payload.cancellationReason,
        "Cancellation reason",
        500
      );
    }

    if (cancellationReason && cancellationReason.length < 10) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Cancellation details must contain at least 10 characters when provided.",
        code: "CANCELLATION_DETAILS_TOO_SHORT",
      });
    }

    const cancellationAuditReason = ShiftOccurrenceCancellationService.buildCancellationAuditReason(
      {
        reasonCode: cancellationReasonCode,
        reason: cancellationReason,
      }
    );

    return {
      cancelledBy,
      cancelledByUserId,
      cancellationReasonCode,
      cancellationReason,
      cancellationAuditReason,
    };
  }

  static normalizeParentPropagationInput(payload) {
    const cancelledBy = ShiftOccurrenceCancellationService.normalizeEnum(
      payload.cancelledBy,
      ["employer", "system", "admin"],
      "cancelledBy"
    );

    const cancelledByUserId =
      cancelledBy === "system"
        ? null
        : ShiftOccurrenceCancellationService.normalizeObjectId(
            payload.cancelledByUserId,
            "cancelled-by user ID"
          );

    if (cancelledBy === "system" && payload.cancelledByUserId) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "A system cancellation cannot contain a user ID.",
        code: "SYSTEM_CANCELLATION_USER_NOT_ALLOWED",
      });
    }

    const parentCancellationCode = ShiftOccurrenceCancellationService.normalizeEnum(
      payload.parentCancellationCode,
      SHIFT_CANCELLATION_CODES,
      "parent cancellation code"
    );

    ShiftOccurrenceCancellationService.assertCancellationCodeActor({
      cancellationCode: parentCancellationCode,
      cancelledBy,
    });

    let cancellationReasonCode = null;
    let cancellationReason = ShiftOccurrenceCancellationService.normalizeOptionalText(
      payload.cancellationReason,
      500
    );

    if (cancelledBy === "employer") {
      cancellationReasonCode = ShiftOccurrenceCancellationService.normalizeEnum(
        payload.cancellationReasonCode,
        EMPLOYER_CANCELLATION_REASON_CODES,
        "cancellation reason code"
      );

      if (
        OCCURRENCE_CANCELLATION_REASON_CODES_REQUIRING_DETAILS.includes(cancellationReasonCode) &&
        !cancellationReason
      ) {
        throw ShiftOccurrenceCancellationService.createError({
          message: `${cancellationReasonCode} requires cancellation details.`,
          code: "CANCELLATION_DETAILS_REQUIRED",
        });
      }
    } else {
      if (payload.cancellationReasonCode) {
        throw ShiftOccurrenceCancellationService.createError({
          message: "System and admin cancellation cannot retain an employer reason code.",
          code: "NON_EMPLOYER_CANCELLATION_REASON_CODE_NOT_ALLOWED",
        });
      }

      cancellationReason = ShiftOccurrenceCancellationService.normalizeRequiredText(
        payload.cancellationReason,
        "Cancellation reason",
        500
      );
    }

    if (cancellationReason && cancellationReason.length < 10) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Cancellation details must contain at least 10 characters when provided.",
        code: "CANCELLATION_DETAILS_TOO_SHORT",
      });
    }

    const cancellationAuditReason = ShiftOccurrenceCancellationService.buildCancellationAuditReason(
      {
        reasonCode: cancellationReasonCode,
        reason: cancellationReason,
      }
    );

    return {
      cancelledBy,
      cancelledByUserId,
      parentCancellationCode,
      cancellationReasonCode,
      cancellationReason,
      cancellationAuditReason,
    };
  }

  /* ─────────────────────────────── POLICY ─────────────────────────────── */

  static getLateCancellationPolicy(shift) {
    const snapshot = shift.cancellationPolicySnapshot;

    if (!snapshot) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The Shift does not contain a cancellation policy snapshot.",
        code: "CANCELLATION_POLICY_SNAPSHOT_MISSING",
        statusCode: 500,
      });
    }

    const windowMinutes = snapshot.lateCancellationWindowMinutes;
    const professionalPayRate = snapshot.lateCancellationProfessionalPayRate;

    if (!Number.isSafeInteger(windowMinutes) || windowMinutes < 0) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The snapshotted late-cancellation window is invalid.",
        code: "INVALID_LATE_CANCELLATION_WINDOW",
        statusCode: 500,
      });
    }

    if (
      typeof professionalPayRate !== "number" ||
      !Number.isFinite(professionalPayRate) ||
      professionalPayRate < 0 ||
      professionalPayRate > 1
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The snapshotted late-cancellation pay rate is invalid.",
        code: "INVALID_LATE_CANCELLATION_PAY_RATE",
        statusCode: 500,
      });
    }

    try {
      money.scaleRate({
        rate: professionalPayRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "Late cancellation professional pay rate",
      });
    } catch (error) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "The snapshotted late-cancellation pay rate exceeds the supported financial precision.",
        code: "INVALID_LATE_CANCELLATION_PAY_RATE",
        statusCode: 500,
      });
    }

    return {
      windowMinutes,
      professionalPayRate,
    };
  }

  static determineOccurrenceCancellationOutcome({
    shift,
    occurrence,
    fromParentCancellation,
    cancelledBy,
    parentCancellationCode = null,
    currentTime,
  }) {
    if (fromParentCancellation && parentCancellationCode === "funding_deadline_passed") {
      return {
        cancellationCode: "funding_deadline_passed",
        compensationApplicable: false,
        compensationRate: 0,
        compensationWindowMinutes: null,
        professionalPay: 0,
        retainedBasePlatformFee: 0,
        scheduledConsumedAmount: 0,
        refundableAmount: 0,
        unfundedCancellation: true,
      };
    }

    const estimatedProfessionalPay = ShiftOccurrenceCancellationService.amount(
      occurrence.estimatedProfessionalPay,
      "Estimated professional pay"
    );

    const estimatedEmployerCharge = ShiftOccurrenceCancellationService.amount(
      occurrence.estimatedEmployerCharge,
      "Estimated employer charge"
    );

    if (estimatedEmployerCharge <= 0) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence does not contain a positive estimated employer charge.",
        code: "INVALID_OCCURRENCE_ESTIMATED_CHARGE",
        statusCode: 500,
      });
    }

    const retainedBasePlatformFee =
      ShiftOccurrenceCancellationService.getRetainedBasePlatformFee(occurrence);

    let compensationApplicable = false;
    let compensationRate = 0;
    let compensationWindowMinutes = null;
    let professionalPay = 0;

    if (cancelledBy === "employer" && occurrence.assignmentStatus === "assigned") {
      const policy = ShiftOccurrenceCancellationService.getLateCancellationPolicy(shift);

      const startTime = new Date(occurrence.startTime);

      if (Number.isNaN(startTime.getTime())) {
        throw ShiftOccurrenceCancellationService.createError({
          message: "The occurrence start time is invalid.",
          code: "INVALID_OCCURRENCE_START_TIME",
          statusCode: 500,
        });
      }

      const millisecondsUntilStart = startTime.getTime() - currentTime.getTime();
      const insideProtectedWindow = millisecondsUntilStart <= policy.windowMinutes * 60 * 1000;

      compensationApplicable = insideProtectedWindow && policy.professionalPayRate > 0;

      if (compensationApplicable) {
        compensationRate = policy.professionalPayRate;
        compensationWindowMinutes = policy.windowMinutes;

        try {
          professionalPay = money.calculateMinorAmountFromRate({
            amountMinor: estimatedProfessionalPay,
            rate: compensationRate,
            rateScale: FINANCIAL_RATE_SCALE,
            fieldName: "Cancellation compensation professional pay",
            rateFieldName: "Late cancellation professional pay rate",
          });
        } catch (error) {
          throw ShiftOccurrenceCancellationService.createError({
            message: "The occurrence cancellation compensation calculation is invalid.",
            code: "INVALID_CANCELLATION_COMPENSATION_CALCULATION",
            statusCode: 500,
          });
        }

        if (professionalPay <= 0) {
          throw ShiftOccurrenceCancellationService.createError({
            message: "The occurrence cancellation compensation calculation is invalid.",
            code: "INVALID_CANCELLATION_COMPENSATION_CALCULATION",
            statusCode: 500,
          });
        }
      }
    }

    const scheduledConsumedAmount = ShiftOccurrenceCancellationService.sumAmounts(
      [professionalPay, retainedBasePlatformFee],
      "Scheduled consumed amount"
    );

    const refundableAmount = estimatedEmployerCharge - scheduledConsumedAmount;

    if (
      !Number.isSafeInteger(scheduledConsumedAmount) ||
      scheduledConsumedAmount < 0 ||
      !Number.isSafeInteger(refundableAmount) ||
      refundableAmount < 0
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence cancellation financial outcome is invalid.",
        code: "INVALID_CANCELLATION_FINANCIAL_OUTCOME",
        statusCode: 500,
        details: {
          estimatedEmployerCharge,
          professionalPay,
          retainedBasePlatformFee,
          scheduledConsumedAmount,
          refundableAmount,
        },
      });
    }

    let cancellationCode;

    if (compensationApplicable) {
      cancellationCode = "late_employer_cancellation";
    } else if (parentCancellationCode) {
      cancellationCode = parentCancellationCode;
    } else if (cancelledBy === "employer") {
      cancellationCode = "employer_cancelled";
    } else if (cancelledBy === "admin") {
      cancellationCode = "admin_cancelled";
    } else {
      cancellationCode = "system_cancelled";
    }

    ShiftOccurrenceCancellationService.assertCancellationCodeActor({
      cancellationCode,
      cancelledBy,
    });

    return {
      cancellationCode,
      compensationApplicable,
      compensationRate,
      compensationWindowMinutes,
      professionalPay,
      retainedBasePlatformFee,
      scheduledConsumedAmount,
      refundableAmount,
      unfundedCancellation: false,
    };
  }

  /* ─────────────────────────────── STATE APPLICATION ─────────────────────────────── */

  static clearRefundSummary(occurrence) {
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
  }

  static applyCancellationState({
    occurrence,
    cancelledBy,
    cancelledByUserId,
    cancellationAuditReason,
    outcome,
    currentTime,
  }) {
    occurrence.status = "cancelled";
    occurrence.attendanceStatus = "not_started";

    occurrence.cancellationCode = outcome.cancellationCode;
    occurrence.cancelledBy = cancelledBy;
    occurrence.cancelledByUser = cancelledByUserId;
    occurrence.cancellationReason = cancellationAuditReason;
    occurrence.cancelledAt = currentTime;

    occurrence.baseBillableHours = 0;
    occurrence.billableHours = 0;

    /*
     * The cancellation fact is saved before the settlement authority runs.
     * Current ShiftOccurrence validation deliberately permits this temporary
     * zero value for compensated cancellation.
     */
    occurrence.baseProfessionalPay = 0;

    if (
      ShiftOccurrenceCancellationService.amount(occurrence.basePlatformFee, "Base platform fee") !==
      outcome.retainedBasePlatformFee
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence base platform fee changed while applying cancellation.",
        code: "BASE_PLATFORM_FEE_CANCELLATION_CONFLICT",
        statusCode: 500,
      });
    }

    occurrence.settlementStatus = "not_due";
    occurrence.settledAt = null;

    if (outcome.compensationApplicable) {
      occurrence.cancellationCompensation = {
        applicable: true,
        rate: outcome.compensationRate,
        windowMinutes: outcome.compensationWindowMinutes,
        professionalPay: outcome.professionalPay,
        calculatedAt: currentTime,
      };
    } else {
      occurrence.cancellationCompensation = {
        applicable: false,
        rate: 0,
        windowMinutes: null,
        professionalPay: 0,
        calculatedAt: null,
      };
    }

    return occurrence;
  }

  static async establishCompensationSettlement({
    shift,
    occurrence,
    outcome,
    currentTime,
    session,
  }) {
    if (!outcome.compensationApplicable) {
      return {
        occurrence,
        settlementResult: null,
      };
    }

    const settlementResult = await ShiftSettlementService.establishBaseSettlementOutcome(
      {
        shiftId: shift._id,
        occurrenceId: occurrence._id,
        earningType: "cancellation_compensation",
        professionalPay: outcome.professionalPay,
        currentTime,
      },
      {
        session,
      }
    );

    const resolvedOccurrence =
      settlementResult?.occurrence ||
      (await ShiftOccurrenceCancellationService.getOccurrence({
        shiftId: shift._id,
        occurrenceId: occurrence._id,
        session,
      }));

    if (
      ShiftOccurrenceCancellationService.amount(
        resolvedOccurrence.baseProfessionalPay,
        "Base professional pay"
      ) !== outcome.professionalPay
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "Cancellation compensation was not established as authoritative BASE professional pay.",
        code: "CANCELLATION_COMPENSATION_SETTLEMENT_MISMATCH",
        statusCode: 500,
        details: {
          occurrenceId: String(resolvedOccurrence._id),
          expectedProfessionalPay: outcome.professionalPay,
          establishedProfessionalPay: ShiftOccurrenceCancellationService.amount(
            resolvedOccurrence.baseProfessionalPay,
            "Base professional pay"
          ),
        },
      });
    }

    return {
      occurrence: resolvedOccurrence,
      settlementResult,
    };
  }

  static async reevaluateCancellationRefund({
    shift,
    occurrence,
    cancelledBy,
    cancelledByUserId,
    currentTime,
    session,
  }) {
    return ShiftRefundService.reevaluateOccurrenceRefund(
      {
        shift,
        occurrence,
        reason: "occurrence_cancelled",
        currentTime,
        initiatedBy: {
          role: cancelledBy,
          userId: cancelledBy === "system" ? null : cancelledByUserId,
        },
      },
      {
        session,
      }
    );
  }

  /* ─────────────────────────────── REPLACEMENT APPLICATION CLEANUP ─────────────────────────────── */

  static async expireOccurrenceReplacementApplications({
    shift,
    occurrence,
    currentTime,
    session,
  }) {
    const result = await ShiftApplication.updateMany(
      {
        shift: shift._id,
        occurrence: occurrence._id,
        applicationType: "replacement",
        status: {
          $in: ACTIVE_REPLACEMENT_APPLICATION_STATUSES,
        },
      },
      {
        $set: {
          status: "expired",
          expiredAt: currentTime,
        },
      },
      {
        session,
        runValidators: true,
      }
    );

    return {
      expiredApplicationCount: result.modifiedCount,
    };
  }

  /* ─────────────────────────────── IDEMPOTENCY ─────────────────────────────── */

  static isSameCompletedCancellation({
    occurrence,
    cancelledBy,
    cancelledByUserId,
    cancellationAuditReason,
  }) {
    if (occurrence.status !== "cancelled") {
      return false;
    }

    return Boolean(
      occurrence.cancelledBy === cancelledBy &&
      ShiftOccurrenceCancellationService.sameNullableId(
        occurrence.cancelledByUser,
        cancelledByUserId
      ) &&
      (occurrence.cancellationReason || null) === (cancellationAuditReason || null)
    );
  }

  static async buildIdempotentResult({
    shift,
    occurrence,
    cancellationReasonCode,
    currentTime,
    session,
    reconcileParent,
  }) {
    const unfundedCancellation = occurrence.cancellationCode === "funding_deadline_passed";

    let resolvedOccurrence = occurrence;
    let settlementResult = null;
    let refundResult = null;
    let employerRefund = null;

    if (!unfundedCancellation) {
      const compensationApplicable =
        resolvedOccurrence.cancellationCompensation?.applicable === true;

      if (compensationApplicable) {
        const professionalPay = ShiftOccurrenceCancellationService.amount(
          resolvedOccurrence.cancellationCompensation?.professionalPay,
          "Cancellation compensation professional pay"
        );

        if (professionalPay <= 0) {
          throw ShiftOccurrenceCancellationService.createError({
            message: "The existing compensated cancellation has invalid professional pay.",
            code: "INVALID_EXISTING_CANCELLATION_COMPENSATION",
            statusCode: 500,
          });
        }

        const establishedBasePay = ShiftOccurrenceCancellationService.amount(
          resolvedOccurrence.baseProfessionalPay,
          "Base professional pay"
        );

        const sharedBaseReviewMissing = Boolean(
          !resolvedOccurrence.challengeWindowOpenedAt || !resolvedOccurrence.challengeDeadlineAt
        );

        if (establishedBasePay === 0 || sharedBaseReviewMissing) {
          settlementResult = await ShiftSettlementService.establishBaseSettlementOutcome(
            {
              shiftId: shift._id,
              occurrenceId: resolvedOccurrence._id,
              earningType: "cancellation_compensation",
              professionalPay,
              currentTime,
            },
            {
              session,
            }
          );

          resolvedOccurrence =
            settlementResult?.occurrence ||
            (await ShiftOccurrenceCancellationService.getOccurrence({
              shiftId: shift._id,
              occurrenceId: resolvedOccurrence._id,
              session,
            }));
        } else if (establishedBasePay !== professionalPay) {
          throw ShiftOccurrenceCancellationService.createError({
            message:
              "The existing cancellation compensation does not match authoritative baseProfessionalPay.",
            code: "EXISTING_CANCELLATION_COMPENSATION_MISMATCH",
            statusCode: 500,
          });
        }
      }

      refundResult = await ShiftOccurrenceCancellationService.reevaluateCancellationRefund({
        shift,
        occurrence: resolvedOccurrence,
        cancelledBy: resolvedOccurrence.cancelledBy,
        cancelledByUserId: resolvedOccurrence.cancelledByUser,
        currentTime,
        session,
      });

      resolvedOccurrence = refundResult?.occurrence || resolvedOccurrence;
      employerRefund = refundResult?.employerRefund || null;
    }

    const applicationResult =
      await ShiftOccurrenceCancellationService.expireOccurrenceReplacementApplications({
        shift,
        occurrence: resolvedOccurrence,
        currentTime,
        session,
      });

    let parentResult = null;

    if (reconcileParent) {
      parentResult = await ShiftOccurrenceReconciliationService.reconcileParentShift({
        shift,
        currentTime,
        session,
      });
    }

    return {
      shift: parentResult?.shift || shift,
      occurrence: resolvedOccurrence,
      employerRefund,
      settlementResult,
      refundResult,
      parentResult,
      cancelled: false,
      idempotent: true,
      cancellationCode: resolvedOccurrence.cancellationCode,
      cancellationReasonCode: cancellationReasonCode || null,
      compensationApplicable: resolvedOccurrence.cancellationCompensation?.applicable === true,
      professionalCompensation: ShiftOccurrenceCancellationService.amount(
        resolvedOccurrence.cancellationCompensation?.professionalPay,
        "Cancellation compensation professional pay"
      ),
      retainedBasePlatformFee: ShiftOccurrenceCancellationService.amount(
        resolvedOccurrence.basePlatformFee,
        "Base platform fee"
      ),
      scheduledConsumedAmount: ShiftOccurrenceCancellationService.sumAmounts(
        [
          ShiftOccurrenceCancellationService.amount(
            resolvedOccurrence.baseProfessionalPay,
            "Base professional pay"
          ),
          ShiftOccurrenceCancellationService.amount(
            resolvedOccurrence.basePlatformFee,
            "Base platform fee"
          ),
        ],
        "Scheduled consumed amount"
      ),
      refundableAmount: ShiftOccurrenceCancellationService.amount(
        resolvedOccurrence.refundableAmount,
        "Refundable amount"
      ),
      refundStatus: resolvedOccurrence.refundStatus,
      refundHoldReason: resolvedOccurrence.refundHoldReason,
      expiredReplacementApplicationCount: applicationResult.expiredApplicationCount,
    };
  }

  /* ─────────────────────────────── CORE CANCELLATION ─────────────────────────────── */

  static async applyFutureOccurrenceCancellation(
    {
      shift,
      occurrence,
      fromParentCancellation,
      cancelledBy,
      cancelledByUserId,
      cancellationReasonCode,
      cancellationAuditReason,
      parentCancellationCode = null,
      allowedAssignmentStatuses,
      currentTime,
      reconcileParent = true,
    },
    { session }
  ) {
    if (!Array.isArray(allowedAssignmentStatuses) || allowedAssignmentStatuses.length === 0) {
      throw ShiftOccurrenceCancellationService.createError({
        message: "Allowed occurrence assignment statuses were not configured for cancellation.",
        code: "CANCELLATION_ASSIGNMENT_STATUSES_NOT_CONFIGURED",
        statusCode: 500,
      });
    }

    ShiftOccurrenceCancellationService.assertOccurrenceBelongsToShift({
      shift,
      occurrence,
    });

    /*
     * Idempotency must run before current-state eligibility because a
     * successfully cancelled occurrence is no longer scheduled.
     */
    if (
      ShiftOccurrenceCancellationService.isSameCompletedCancellation({
        occurrence,
        cancelledBy,
        cancelledByUserId,
        cancellationAuditReason,
      })
    ) {
      return ShiftOccurrenceCancellationService.buildIdempotentResult({
        shift,
        occurrence,
        cancellationReasonCode,
        currentTime,
        session,
        reconcileParent,
      });
    }

    if (occurrence.status === "cancelled") {
      throw ShiftOccurrenceCancellationService.createError({
        message: "The occurrence was already cancelled through a different cancellation action.",
        code: "OCCURRENCE_ALREADY_CANCELLED_DIFFERENTLY",
        statusCode: 409,
        details: {
          cancellationCode: occurrence.cancellationCode,
          cancelledBy: occurrence.cancelledBy,
          cancelledAt: occurrence.cancelledAt,
        },
      });
    }

    const isFundingDeadlinePropagation =
      fromParentCancellation === true && parentCancellationCode === "funding_deadline_passed";

    if (isFundingDeadlinePropagation) {
      ShiftOccurrenceCancellationService.assertFundingDeadlineOccurrence(occurrence);
    } else {
      ShiftOccurrenceCancellationService.assertFutureUntouchedOccurrence({
        occurrence,
        currentTime,
        allowedAssignmentStatuses,
      });
    }

    if (
      cancellationReasonCode === "professional_unavailability" &&
      (fromParentCancellation === true ||
        cancelledBy !== "employer" ||
        occurrence.assignmentStatus !== "assigned")
    ) {
      throw ShiftOccurrenceCancellationService.createError({
        message:
          "professional_unavailability is valid only when the employer individually cancels an assigned occurrence because replacement coverage is no longer required.",
        code: "INVALID_PROFESSIONAL_UNAVAILABILITY_CANCELLATION",
        statusCode: 409,
      });
    }

    const outcome = ShiftOccurrenceCancellationService.determineOccurrenceCancellationOutcome({
      shift,
      occurrence,
      fromParentCancellation,
      cancelledBy,
      parentCancellationCode,
      currentTime,
    });

    ShiftOccurrenceCancellationService.applyCancellationState({
      occurrence,
      cancelledBy,
      cancelledByUserId,
      cancellationAuditReason,
      outcome,
      currentTime,
    });

    let resolvedOccurrence = occurrence;
    let settlementResult = null;
    let refundResult = null;
    let employerRefund = null;

    if (outcome.unfundedCancellation) {
      ShiftOccurrenceCancellationService.clearRefundSummary(resolvedOccurrence);

      await resolvedOccurrence.save({
        session,
      });
    } else {
      /*
       * Persist the date-specific cancellation fact first. For compensated
       * cancellation the model allows baseProfessionalPay to remain zero until
       * the settlement authority establishes the BASE entitlement below.
       */
      await resolvedOccurrence.save({
        session,
      });

      const compensationSettlement =
        await ShiftOccurrenceCancellationService.establishCompensationSettlement({
          shift,
          occurrence: resolvedOccurrence,
          outcome,
          currentTime,
          session,
        });

      resolvedOccurrence = compensationSettlement.occurrence;
      settlementResult = compensationSettlement.settlementResult;

      /*
       * Refund obligation is evaluated only after BASE professional settlement
       * truth and the shared challenge window have been established.
       */
      refundResult = await ShiftOccurrenceCancellationService.reevaluateCancellationRefund({
        shift,
        occurrence: resolvedOccurrence,
        cancelledBy,
        cancelledByUserId,
        currentTime,
        session,
      });

      resolvedOccurrence = refundResult?.occurrence || resolvedOccurrence;
      employerRefund = refundResult?.employerRefund || null;
    }

    const applicationResult =
      await ShiftOccurrenceCancellationService.expireOccurrenceReplacementApplications({
        shift,
        occurrence: resolvedOccurrence,
        currentTime,
        session,
      });

    let parentResult = null;

    if (reconcileParent) {
      parentResult = await ShiftOccurrenceReconciliationService.reconcileParentShift({
        shift,
        currentTime,
        session,
      });
    }

    return {
      shift: parentResult?.shift || shift,
      occurrence: resolvedOccurrence,
      employerRefund,
      settlementResult,
      refundResult,
      parentResult,
      cancelled: true,
      idempotent: false,
      cancellationCode: outcome.cancellationCode,
      cancellationReasonCode: cancellationReasonCode || null,
      compensationApplicable: outcome.compensationApplicable,
      professionalCompensation: outcome.professionalPay,
      retainedBasePlatformFee: outcome.retainedBasePlatformFee,
      scheduledConsumedAmount: outcome.scheduledConsumedAmount,
      refundableAmount: ShiftOccurrenceCancellationService.amount(
        resolvedOccurrence.refundableAmount ?? outcome.refundableAmount,
        "Refundable amount"
      ),
      refundStatus: resolvedOccurrence.refundStatus,
      refundHoldReason: resolvedOccurrence.refundHoldReason,
      expiredReplacementApplicationCount: applicationResult.expiredApplicationCount,
    };
  }

  /* ─────────────────────────────── INDIVIDUAL OCCURRENCE CANCELLATION ─────────────────────────────── */

  static async cancelOccurrence(
    {
      shiftId,
      occurrenceId,
      businessId,
      cancelledBy = "employer",
      cancelledByUserId,
      cancellationReasonCode = null,
      cancellationReason = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime =
      ShiftOccurrenceCancellationService.normalizeCurrentTime(currentTime);

    const cancellationInput =
      ShiftOccurrenceCancellationService.normalizeIndividualCancellationInput({
        cancelledBy,
        cancelledByUserId,
        cancellationReasonCode,
        cancellationReason,
      });

    return ShiftOccurrenceCancellationService.runWithOptionalTransaction(
      options,
      async (session) => {
        const shift = await ShiftOccurrenceCancellationService.getShift(shiftId, session);

        ShiftOccurrenceCancellationService.assertParentAllowsIndividualCancellation(shift);

        if (cancellationInput.cancelledBy === "employer") {
          ShiftOccurrenceCancellationService.assertEmployerOwnsShift({
            shift,
            businessId,
          });
        }

        const occurrence = await ShiftOccurrenceCancellationService.getOccurrence({
          shiftId: shift._id,
          occurrenceId,
          session,
        });

        return ShiftOccurrenceCancellationService.applyFutureOccurrenceCancellation(
          {
            shift,
            occurrence,
            fromParentCancellation: false,
            cancelledBy: cancellationInput.cancelledBy,
            cancelledByUserId: cancellationInput.cancelledByUserId,
            cancellationReasonCode: cancellationInput.cancellationReasonCode,
            cancellationAuditReason: cancellationInput.cancellationAuditReason,
            parentCancellationCode: null,
            allowedAssignmentStatuses: INDIVIDUAL_OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES,
            currentTime: normalizedCurrentTime,
            reconcileParent: true,
          },
          {
            session,
          }
        );
      }
    );
  }

  /* ─────────────────────────────── PARENT CANCELLATION PROPAGATION ─────────────────────────────── */

  static async propagateParentCancellationToOccurrence(
    {
      shiftId,
      occurrenceId,
      parentCancellationCode,
      cancelledBy,
      cancelledByUserId = null,
      cancellationReasonCode = null,
      cancellationReason = null,
      cancelledAt = new Date(),
      reconcileParent = false,
    },
    options = {}
  ) {
    const normalizedCancelledAt =
      ShiftOccurrenceCancellationService.normalizeCurrentTime(cancelledAt);

    const cancellationInput = ShiftOccurrenceCancellationService.normalizeParentPropagationInput({
      parentCancellationCode,
      cancelledBy,
      cancelledByUserId,
      cancellationReasonCode,
      cancellationReason,
    });

    return ShiftOccurrenceCancellationService.runWithOptionalTransaction(
      options,
      async (session) => {
        const shift = await ShiftOccurrenceCancellationService.getShift(shiftId, session);

        const occurrence = await ShiftOccurrenceCancellationService.getOccurrence({
          shiftId: shift._id,
          occurrenceId,
          session,
        });

        return ShiftOccurrenceCancellationService.applyFutureOccurrenceCancellation(
          {
            shift,
            occurrence,
            fromParentCancellation: true,
            cancelledBy: cancellationInput.cancelledBy,
            cancelledByUserId: cancellationInput.cancelledByUserId,
            cancellationReasonCode: cancellationInput.cancellationReasonCode,
            cancellationAuditReason: cancellationInput.cancellationAuditReason,
            parentCancellationCode: cancellationInput.parentCancellationCode,
            allowedAssignmentStatuses: OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES,
            currentTime: normalizedCancelledAt,
            reconcileParent: Boolean(reconcileParent),
          },
          {
            session,
          }
        );
      }
    );
  }
}

module.exports = ShiftOccurrenceCancellationService;
