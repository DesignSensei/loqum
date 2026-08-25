// services/shiftOccurrenceReconciliationService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftAssignmentService = require("./shiftAssignmentService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const {
  TERMINAL_OCCURRENCE_STATUSES,
  SHIFT_FINAL_PAYMENT_STATUSES,
} = require("../constants/shiftLifecycle");

const { SETTLEMENT_COMPONENT_STATUSES } = require("../constants/shiftSettlement");

const COMPONENT_RELEASE_READY_STATUSES = Object.freeze([
  "approved_for_release",
  "release_pending",
  "released",
]);

const UNRESOLVED_OCCURRENCE_SETTLEMENT_STATUSES = Object.freeze([
  "pending_review",
  "awaiting_overtime_review",
  "awaiting_topup",
  "approved_for_release",
  "release_pending",
  "failed",
  "disputed",
]);

const UNRESOLVED_REFUND_STATUSES = Object.freeze(["held", "eligible", "batched", "processing"]);

const RESOLVED_REFUND_STATUSES = Object.freeze(["not_eligible", "refunded"]);

/**
 * SHIFT OCCURRENCE RECONCILIATION ARCHITECTURE
 *
 * This service is FINAL PARENT AGGREGATION ONLY.
 *
 * ShiftOccurrence and its dedicated domain services own occurrence truth.
 *
 * This service consumes that truth and rebuilds the parent Shift's summary /
 * compatibility state.
 *
 * It may summarize:
 *
 * - occurrence assignment state;
 * - occurrence operational state;
 * - professional BASE / OVERTIME payout-component audits;
 * - platform-fee earning / collection audits;
 * - outstanding overtime top-up obligations;
 * - refund execution summaries; and
 * - claim / dispute finality through occurrence active pointers.
 *
 * It does NOT:
 *
 * - expire an occurrence unfilled;
 * - calculate unfilled-finalization deadlines;
 * - expire applications;
 * - open, shrink, close or cancel replacement hiring;
 * - create professional settlement entitlement;
 * - approve professional payout components;
 * - execute professional payout;
 * - earn or collect platform fees;
 * - create, hold, release, void or execute employer refunds;
 * - adjudicate claims / disputes; or
 * - adjudicate / fund overtime.
 *
 * UPSTREAM ORDER
 *
 * A lifecycle service changes authoritative occurrence state first.
 *
 * Then this service may be called to rebuild the parent Shift summary.
 *
 * Examples:
 *
 * - settlement batch released -> reconcile Shift;
 * - refund batch completed -> reconcile Shift;
 * - claim/dispute issue resolution changed occurrence truth -> reconcile Shift;
 * - occurrence-expiration service finalized an unfilled occurrence -> reconcile
 *   Shift.
 *
 * PROFESSIONAL SETTLEMENT
 *
 * baseSettlement and overtimeSettlement are the parent professional-payout
 * source of truth.
 *
 * Parent release totals are built only from those component audits.
 *
 * OCCURRENCE EMPLOYER-CHARGE MIRRORS
 *
 * baseEmployerCharge and overtimeEmployerCharge are not occurrence
 * authorities and are not read here. Parent committedEmployerCharge is
 * derived only from approved professional payout plus earned platform fee.
 *
 * PLATFORM FEES
 *
 * basePlatformFeeAudit and overtimePlatformFeeAudit are independent from
 * professional settlement.
 *
 * Platform-fee earning or collection never creates parent professional payout
 * states such as:
 *
 * - release_pending;
 * - partially_released; or
 * - released.
 *
 * REFUNDS
 *
 * The occurrence refund mirror is consumed as-is.
 *
 * #15 owns refund eligibility / hold truth.
 * EmployerRefundBatch owns refund execution.
 *
 * CLAIM / DISPUTE FINALITY
 *
 * activeClaim and activeDispute may coexist.
 *
 * Parent reconciliation does not inspect case-level aggregate component scope.
 * That logic belongs to #7 / #15.
 *
 * For final parent completion, any active challenge pointer means the occurrence
 * is not fully resolved yet.
 *
 * PARENT AUTHORITY
 *
 * The parent Shift remains summary / compatibility state only.
 */
class ShiftOccurrenceReconciliationService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftOccurrenceReconciliationServiceError";
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

  static normalizeObjectId(value, fieldName) {
    if (value === null || value === undefined || value === "") {
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

  static amount(value, fieldName = "amount") {
    const amount = Number(value ?? 0);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw this.createError({
        message: `${fieldName} must be a non-negative whole-number minor-unit amount.`,
        code: `INVALID_${this.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return amount;
  }

  static addAmount(total, value, fieldName) {
    const left = this.amount(total, `${fieldName} total`);

    const right = this.amount(value, fieldName);

    const result = left + right;

    if (!Number.isSafeInteger(result)) {
      throw this.createError({
        message: `${fieldName} exceeds the supported minor-unit range.`,
        code: `${this.normalizeFieldCode(fieldName)}_TOO_LARGE`,
        statusCode: 500,
      });
    }

    return result;
  }

  static maxDate(values) {
    const dates = Array.from(values || [])
      .filter(Boolean)
      .map((value) => new Date(value))
      .filter((value) => !Number.isNaN(value.getTime()));

    if (dates.length === 0) {
      return null;
    }

    return new Date(Math.max(...dates.map((value) => value.getTime())));
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getShift(shiftId, session = null) {
    const normalizedShiftId = this.normalizeObjectId(shiftId, "shift ID");

    const query = Shift.findById(normalizedShiftId);

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw this.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

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

  static async getOccurrencesForParentReconciliation({ shiftId, session }) {
    const query = ShiftOccurrence.find({
      shift: shiftId,
    })
      .select(
        [
          "sequenceNumber",

          "assignmentStatus",
          "assignedProfessional",
          "assignment",
          "assignedAt",

          "status",
          "attendanceStatus",
          "settlementStatus",
          "refundStatus",

          "baseProfessionalPay",
          "basePlatformFee",
          "basePlatformFeeAudit",
          "baseSettlement",

          "overtimeProfessionalPay",
          "overtimePlatformFee",
          "overtimePlatformFeeAudit",
          "overtimeSettlement",
          "overtime",

          "topUpRequired",

          "cancellationCompensation",
          "activeWorkCancellation",

          "refundableAmount",
          "refundedAmount",
          "refundedAt",

          "activeClaim",
          "activeDispute",
        ].join(" ")
      )
      .sort({
        sequenceNumber: 1,
      });

    if (session) {
      query.session(session);
    }

    return query.lean();
  }

  /* ─────────────────────────────── COMPONENT / AUDIT HELPERS ─────────────────────────────── */

  static getComponentAudit(occurrence, component) {
    if (component === "base") {
      return occurrence.baseSettlement || {};
    }

    if (component === "overtime") {
      return occurrence.overtimeSettlement || {};
    }

    throw this.createError({
      message: "Settlement component is invalid.",
      code: "INVALID_SETTLEMENT_COMPONENT",
      statusCode: 500,
      details: {
        component,
      },
    });
  }

  static getComponentStatus(occurrence, component) {
    const audit = this.getComponentAudit(occurrence, component);

    const status = String(audit?.status || "not_due")
      .trim()
      .toLowerCase();

    if (!SETTLEMENT_COMPONENT_STATUSES.includes(status)) {
      throw this.createError({
        message: "An occurrence contains an unsupported settlement component status.",
        code: "INVALID_SETTLEMENT_COMPONENT_STATUS",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,

          component,
          status,
        },
      });
    }

    return status;
  }

  static componentHasSettlementActivity(audit) {
    if (!audit) {
      return false;
    }

    return Boolean(
      String(audit.status || "not_due") !== "not_due" ||
      audit.earningType ||
      Number(audit.professionalPay || 0) > 0 ||
      audit.approvedForReleaseAt ||
      audit.approvalSource ||
      audit.approvedForReleaseBy ||
      audit.scheduledPayoutAt ||
      audit.settlementBatch ||
      audit.releasePendingAt ||
      audit.releasedAt ||
      audit.payoutTransaction
    );
  }

  /* ─────────────────────────────── OCCURRENCE FINANCIAL CONSISTENCY ─────────────────────────────── */

  static getBaseProfessionalEntitlement(occurrence) {
    const baseProfessionalPay = this.amount(
      occurrence.baseProfessionalPay,
      "base professional pay"
    );

    const hasActiveWorkCancellation = occurrence.activeWorkCancellation?.occurred === true;

    const hasCancellationCompensation = occurrence.cancellationCompensation?.applicable === true;

    if (hasActiveWorkCancellation && hasCancellationCompensation) {
      throw this.createError({
        message:
          "An occurrence cannot contain active-work cancellation and cancellation compensation at the same time.",
        code: "OCCURRENCE_BASE_ENTITLEMENT_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
        },
      });
    }

    let specializedProfessionalPay = null;

    let specializedEarningType = null;

    if (hasActiveWorkCancellation) {
      specializedProfessionalPay = this.amount(
        occurrence.activeWorkCancellation.professionalPay,
        "active-work cancellation professional pay"
      );

      specializedEarningType = "active_work_cancellation";

      if (specializedProfessionalPay <= 0) {
        throw this.createError({
          message: "An active-work cancellation occurrence requires positive professional pay.",
          code: "ACTIVE_WORK_CANCELLATION_PROFESSIONAL_PAY_MISSING",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),
          },
        });
      }
    } else if (hasCancellationCompensation) {
      specializedProfessionalPay = this.amount(
        occurrence.cancellationCompensation.professionalPay,
        "cancellation compensation professional pay"
      );

      specializedEarningType = "cancellation_compensation";

      if (specializedProfessionalPay <= 0) {
        throw this.createError({
          message: "Applicable cancellation compensation requires positive professional pay.",
          code: "CANCELLATION_COMPENSATION_PROFESSIONAL_PAY_MISSING",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),
          },
        });
      }
    }

    /*
     * ShiftOccurrence allows the specialized cancellation outcome to exist
     * before #7 establishes baseProfessionalPay.
     *
     * Once baseProfessionalPay exists, however, it must mirror the specialized
     * entitlement exactly.
     */
    if (
      specializedProfessionalPay !== null &&
      baseProfessionalPay > 0 &&
      baseProfessionalPay !== specializedProfessionalPay
    ) {
      throw this.createError({
        message:
          "Established baseProfessionalPay does not match the occurrence's specialized BASE entitlement.",
        code: "SPECIALIZED_BASE_ENTITLEMENT_MISMATCH",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          specializedEarningType,

          specializedProfessionalPay,

          baseProfessionalPay,
        },
      });
    }

    if (
      ["no_show", "expired_unfilled"].includes(occurrence.status) &&
      (baseProfessionalPay > 0 || Number(specializedProfessionalPay || 0) > 0)
    ) {
      throw this.createError({
        message:
          "A no-show or expired-unfilled occurrence cannot contain positive BASE professional entitlement.",
        code: "NON_WORKED_OCCURRENCE_BASE_PAY_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          occurrenceStatus: occurrence.status,

          baseProfessionalPay,

          specializedProfessionalPay,
        },
      });
    }

    if (
      occurrence.status === "cancelled" &&
      baseProfessionalPay > 0 &&
      !hasCancellationCompensation &&
      !hasActiveWorkCancellation
    ) {
      throw this.createError({
        message:
          "A cancelled occurrence with positive BASE professional pay requires cancellation compensation.",
        code: "CANCELLED_OCCURRENCE_BASE_PAY_AUDIT_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          baseProfessionalPay,
        },
      });
    }

    return specializedProfessionalPay !== null ? specializedProfessionalPay : baseProfessionalPay;
  }

  static assertOccurrenceFinancialConsistency(occurrence) {
    const baseProfessionalPay = this.amount(
      occurrence.baseProfessionalPay,
      "base professional pay"
    );

    const effectiveBaseProfessionalEntitlement = this.getBaseProfessionalEntitlement(occurrence);

    const baseStatus = this.getComponentStatus(occurrence, "base");

    const baseSettlement = this.getComponentAudit(occurrence, "base");

    if (baseStatus !== "not_due") {
      const baseSettlementProfessionalPay = this.amount(
        baseSettlement.professionalPay,
        "BASE settlement professional pay"
      );

      if (baseProfessionalPay <= 0) {
        throw this.createError({
          message:
            "An established BASE settlement component requires positive baseProfessionalPay.",
          code: "BASE_PROFESSIONAL_PAY_NOT_ESTABLISHED",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            baseSettlementStatus: baseStatus,
          },
        });
      }

      if (baseSettlementProfessionalPay !== baseProfessionalPay) {
        throw this.createError({
          message: "The BASE settlement component does not match established baseProfessionalPay.",
          code: "BASE_SETTLEMENT_ENTITLEMENT_MISMATCH",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            baseProfessionalPay,

            effectiveBaseProfessionalEntitlement,

            baseSettlementProfessionalPay,

            baseSettlementStatus: baseStatus,
          },
        });
      }

      if (baseSettlementProfessionalPay !== effectiveBaseProfessionalEntitlement) {
        throw this.createError({
          message:
            "The BASE settlement component does not match the occurrence's authoritative BASE entitlement.",
          code: "BASE_SETTLEMENT_SPECIALIZED_ENTITLEMENT_MISMATCH",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            baseSettlementProfessionalPay,

            effectiveBaseProfessionalEntitlement,
          },
        });
      }
    }

    const overtimeProfessionalPay = this.amount(
      occurrence.overtimeProfessionalPay,
      "overtime professional pay"
    );

    const overtimeStatus = this.getComponentStatus(occurrence, "overtime");

    const overtimeSettlement = this.getComponentAudit(occurrence, "overtime");

    if (overtimeStatus !== "not_due") {
      const overtimeSettlementProfessionalPay = this.amount(
        overtimeSettlement.professionalPay,
        "overtime settlement professional pay"
      );

      if (
        overtimeProfessionalPay <= 0 ||
        overtimeSettlementProfessionalPay !== overtimeProfessionalPay
      ) {
        throw this.createError({
          message:
            "The overtime settlement component does not match authoritative overtime professional pay.",
          code: "OVERTIME_SETTLEMENT_ENTITLEMENT_MISMATCH",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            overtimeProfessionalPay,

            overtimeSettlementProfessionalPay,

            overtimeSettlementStatus: overtimeStatus,
          },
        });
      }
    }

    return true;
  }

  /* ─────────────────────────────── OCCURRENCE FINALITY ─────────────────────────────── */

  static isOccurrenceSettlementResolved(occurrence) {
    if (occurrence.activeClaim || occurrence.activeDispute) {
      return false;
    }

    const overallSettlementStatus = String(occurrence.settlementStatus || "not_due")
      .trim()
      .toLowerCase();

    if (UNRESOLVED_OCCURRENCE_SETTLEMENT_STATUSES.includes(overallSettlementStatus)) {
      return false;
    }

    this.assertOccurrenceFinancialConsistency(occurrence);

    const baseProfessionalEntitlement = this.getBaseProfessionalEntitlement(occurrence);

    const baseStatus = this.getComponentStatus(occurrence, "base");

    if (baseProfessionalEntitlement > 0 && baseStatus !== "released") {
      return false;
    }

    if (baseProfessionalEntitlement === 0 && baseStatus !== "not_due") {
      return false;
    }

    const overtime = occurrence.overtime || {};

    const overtimeRequested = overtime.requested === true;

    const overtimeStatusValue = String(overtime.status || "")
      .trim()
      .toLowerCase();

    if (overtimeRequested && ["pending", "disputed"].includes(overtimeStatusValue)) {
      return false;
    }

    const overtimeProfessionalPay = this.amount(
      occurrence.overtimeProfessionalPay,
      "overtime professional pay"
    );

    const overtimeSettlementStatus = this.getComponentStatus(occurrence, "overtime");

    if (overtimeRequested && overtimeStatusValue === "approved") {
      if (overtimeProfessionalPay <= 0) {
        return false;
      }

      if (this.amount(occurrence.topUpRequired, "outstanding overtime top-up") > 0) {
        return false;
      }

      if (overtimeSettlementStatus !== "released") {
        return false;
      }
    } else {
      if (overtimeProfessionalPay > 0) {
        return false;
      }

      if (overtimeSettlementStatus !== "not_due") {
        return false;
      }
    }

    if (!["not_due", "released"].includes(overallSettlementStatus)) {
      return false;
    }

    return true;
  }

  static isOccurrenceRefundResolved(occurrence) {
    const refundStatus = String(occurrence.refundStatus || "not_eligible")
      .trim()
      .toLowerCase();

    if (UNRESOLVED_REFUND_STATUSES.includes(refundStatus)) {
      return false;
    }

    if (!RESOLVED_REFUND_STATUSES.includes(refundStatus)) {
      throw this.createError({
        message: "An occurrence contains an unsupported refund status.",
        code: "INVALID_OCCURRENCE_REFUND_STATUS",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          refundStatus,
        },
      });
    }

    const refundableAmount = this.amount(occurrence.refundableAmount, "refundable amount");

    const refundedAmount = this.amount(occurrence.refundedAmount, "refunded amount");

    if (refundStatus === "not_eligible") {
      if (refundedAmount !== 0) {
        throw this.createError({
          message: "An occurrence marked not_eligible cannot contain refunded money.",
          code: "NOT_ELIGIBLE_REFUND_AMOUNT_CONFLICT",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            refundedAmount,
          },
        });
      }

      return true;
    }

    if (refundableAmount <= 0 || refundedAmount !== refundableAmount || !occurrence.refundedAt) {
      throw this.createError({
        message:
          "A refunded occurrence must contain a complete refund amount and completion audit.",
        code: "REFUNDED_OCCURRENCE_AUDIT_INCOMPLETE",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          refundableAmount,

          refundedAmount,

          refundedAt: occurrence.refundedAt || null,
        },
      });
    }

    return true;
  }

  static isOccurrenceResolved(occurrence) {
    return Boolean(
      TERMINAL_OCCURRENCE_STATUSES.includes(occurrence.status) &&
      !occurrence.activeClaim &&
      !occurrence.activeDispute &&
      this.isOccurrenceSettlementResolved(occurrence) &&
      this.isOccurrenceRefundResolved(occurrence)
    );
  }

  static async closeResolvedOccurrenceAssignments({ shift, occurrences, currentTime, session }) {
    const results = [];

    for (const occurrence of occurrences) {
      /*
       * Only a fully resolved occurrence can cause its isolated assignment
       * to close.
       */
      if (!occurrence.assignment || !this.isOccurrenceResolved(occurrence)) {
        continue;
      }

      const assignment = await ShiftAssignmentService.getAssignment({
        assignmentId: occurrence.assignment,

        shiftId: shift._id,

        session,

        required: false,
      });

      if (!assignment) {
        throw this.createError({
          message: "A resolved occurrence references an assignment record that does not exist.",
          code: "RESOLVED_OCCURRENCE_ASSIGNMENT_NOT_FOUND",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            assignmentId: String(occurrence.assignment),
          },
        });
      }

      /*
       * Engagement-level assignments have occurrence: null.
       *
       * Their completion remains owned by closeCompletedAssignment().
       *
       * Only isolated occurrence-targeted assignments are closed here.
       */
      if (!assignment.occurrence) {
        continue;
      }

      const result = await ShiftAssignmentService.closeCompletedOccurrenceAssignment(
        {
          shiftId: shift._id,

          occurrenceId: occurrence._id,

          assignmentId: assignment._id,

          currentTime,
        },
        {
          session,
        }
      );

      results.push({
        occurrenceId: String(occurrence._id),

        assignmentId: String(assignment._id),

        closed: result.closed === true,

        idempotent: result.idempotent === true,
      });
    }

    return results;
  }

  /* ─────────────────────────────── PARENT OCCURRENCE PROGRESS ─────────────────────────────── */

  static buildOccurrenceProgress({ occurrences, currentTime }) {
    const progress = {
      unassigned: 0,

      assigned: 0,

      replacementRequired: 0,

      expiredUnfilled: 0,

      scheduled: 0,

      inProgress: 0,

      pendingSettlement: 0,

      completed: 0,

      cancelled: 0,

      noShow: 0,

      disputed: 0,

      settlementNotDue: 0,

      pendingReview: 0,

      awaitingOvertimeReview: 0,

      awaitingTopup: 0,

      approvedForRelease: 0,

      releasePending: 0,

      released: 0,

      failed: 0,

      settlementDisputed: 0,

      refundNotEligible: 0,

      refundHeld: 0,

      refundEligible: 0,

      refundBatched: 0,

      refundProcessing: 0,

      refunded: 0,

      resolved: 0,

      lastReconciledAt: currentTime,
    };

    const assignmentFieldMap = {
      unassigned: "unassigned",

      assigned: "assigned",

      replacement_required: "replacementRequired",

      expired_unfilled: "expiredUnfilled",
    };

    const occurrenceStatusFieldMap = {
      scheduled: "scheduled",

      in_progress: "inProgress",

      pending_settlement: "pendingSettlement",

      completed: "completed",

      cancelled: "cancelled",

      no_show: "noShow",

      expired_unfilled: "expiredUnfilled",

      disputed: "disputed",
    };

    const settlementStatusFieldMap = {
      not_due: "settlementNotDue",

      pending_review: "pendingReview",

      awaiting_overtime_review: "awaitingOvertimeReview",

      awaiting_topup: "awaitingTopup",

      approved_for_release: "approvedForRelease",

      release_pending: "releasePending",

      released: "released",

      failed: "failed",

      disputed: "settlementDisputed",
    };

    const refundStatusFieldMap = {
      not_eligible: "refundNotEligible",

      held: "refundHeld",

      eligible: "refundEligible",

      batched: "refundBatched",

      processing: "refundProcessing",

      refunded: "refunded",
    };

    for (const occurrence of occurrences) {
      const assignmentField = assignmentFieldMap[occurrence.assignmentStatus];

      const occurrenceField = occurrenceStatusFieldMap[occurrence.status];

      const settlementField = settlementStatusFieldMap[occurrence.settlementStatus];

      const refundField = refundStatusFieldMap[occurrence.refundStatus];

      if (!assignmentField || !occurrenceField || !settlementField || !refundField) {
        throw this.createError({
          message: "An occurrence contains an unsupported lifecycle status.",
          code: "UNSUPPORTED_OCCURRENCE_LIFECYCLE_STATUS",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            assignmentStatus: occurrence.assignmentStatus,

            status: occurrence.status,

            settlementStatus: occurrence.settlementStatus,

            refundStatus: occurrence.refundStatus,
          },
        });
      }

      progress[assignmentField] += 1;

      /*
       * expiredUnfilled is intentionally shared by assignment and occurrence
       * status summaries on Shift. Increment it once.
       */
      if (occurrenceField !== assignmentField) {
        progress[occurrenceField] += 1;
      }

      progress[settlementField] += 1;

      progress[refundField] += 1;

      if (this.isOccurrenceResolved(occurrence)) {
        progress.resolved += 1;
      }
    }

    return progress;
  }

  /* ─────────────────────────────── PARENT SETTLEMENT / FEE SUMMARY ─────────────────────────────── */

  static validatePlatformFeeComponent({ occurrence, component, amount, audit }) {
    const feeAmount = this.amount(amount, `${component} platform fee`);

    const feeAudit = audit || {};

    const hasAuditData = Boolean(
      feeAudit.earnedAt ||
      feeAudit.outstandingAt ||
      feeAudit.collectedAt ||
      feeAudit.collectionTransaction
    );

    if (feeAmount === 0) {
      if (hasAuditData) {
        throw this.createError({
          message: "An occurrence contains platform-fee audit activity for a zero fee amount.",
          code: "ZERO_PLATFORM_FEE_AUDIT_CONFLICT",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            component,
          },
        });
      }

      return {
        feeAmount,

        earned: false,

        fullyCollected: false,
      };
    }

    if (!feeAudit.earnedAt) {
      throw this.createError({
        message: "A positive platform fee is missing its earning audit.",
        code: "PLATFORM_FEE_EARNING_AUDIT_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          component,

          feeAmount,
        },
      });
    }

    if (Boolean(feeAudit.collectedAt) !== Boolean(feeAudit.collectionTransaction)) {
      throw this.createError({
        message: "Platform-fee collectedAt and collectionTransaction must be recorded together.",
        code: "PLATFORM_FEE_COLLECTION_AUDIT_INCOMPLETE",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),

          component,
        },
      });
    }

    return {
      feeAmount,

      earned: true,

      /*
       * A previously collected OT fee may later have a new outstanding amount
       * after authoritative OT adjustment. The current fee component is fully
       * collected only when no outstandingAt remains.
       */
      fullyCollected: Boolean(
        feeAudit.collectedAt && feeAudit.collectionTransaction && !feeAudit.outstandingAt
      ),
    };
  }

  static buildSettlementSummary({ occurrences, currentTime }) {
    const summary = {
      approvedProfessionalPay: 0,

      releasedProfessionalPay: 0,

      earnedPlatformFee: 0,

      collectedPlatformFee: 0,

      committedEmployerCharge: 0,

      lastProfessionalApprovedAt: null,

      lastProfessionalReleasedAt: null,

      lastPlatformFeeEarnedAt: null,

      lastPlatformFeeCollectedAt: null,

      lastReconciledAt: currentTime,
    };

    const professionalApprovedDates = [];

    const professionalReleasedDates = [];

    const platformFeeEarnedDates = [];

    const platformFeeCollectedDates = [];

    for (const occurrence of occurrences) {
      this.assertOccurrenceFinancialConsistency(occurrence);

      for (const component of ["base", "overtime"]) {
        const audit = this.getComponentAudit(occurrence, component);

        const status = this.getComponentStatus(occurrence, component);

        const professionalPay = this.amount(
          audit?.professionalPay,
          `${component} settlement professional pay`
        );

        if (status === "not_due" && this.componentHasSettlementActivity(audit)) {
          throw this.createError({
            message: "A not_due professional settlement component contains payout activity.",
            code: "NOT_DUE_SETTLEMENT_COMPONENT_ACTIVITY_CONFLICT",
            statusCode: 500,
            details: {
              occurrenceId: String(occurrence._id),

              component,
            },
          });
        }

        if (COMPONENT_RELEASE_READY_STATUSES.includes(status)) {
          if (professionalPay <= 0) {
            throw this.createError({
              message:
                "A payout-ready professional settlement component requires positive professional pay.",
              code: "PAYOUT_READY_COMPONENT_PAY_MISSING",
              statusCode: 500,
              details: {
                occurrenceId: String(occurrence._id),

                component,

                status,
              },
            });
          }

          summary.approvedProfessionalPay = this.addAmount(
            summary.approvedProfessionalPay,

            professionalPay,

            "approved professional pay"
          );

          if (audit?.approvedForReleaseAt) {
            professionalApprovedDates.push(audit.approvedForReleaseAt);
          }
        }

        if (status === "released") {
          summary.releasedProfessionalPay = this.addAmount(
            summary.releasedProfessionalPay,

            professionalPay,

            "released professional pay"
          );

          if (audit?.releasedAt) {
            professionalReleasedDates.push(audit.releasedAt);
          }
        }
      }

      const feeComponents = [
        {
          component: "base",

          amount: occurrence.basePlatformFee,

          audit: occurrence.basePlatformFeeAudit,
        },

        {
          component: "overtime",

          amount: occurrence.overtimePlatformFee,

          audit: occurrence.overtimePlatformFeeAudit,
        },
      ];

      for (const fee of feeComponents) {
        const validation = this.validatePlatformFeeComponent({
          occurrence,

          component: fee.component,

          amount: fee.amount,

          audit: fee.audit,
        });

        if (!validation.earned) {
          continue;
        }

        summary.earnedPlatformFee = this.addAmount(
          summary.earnedPlatformFee,

          validation.feeAmount,

          "earned platform fee"
        );

        if (validation.feeAmount > 0 && fee.audit?.earnedAt) {
          platformFeeEarnedDates.push(fee.audit.earnedAt);
        }

        if (validation.fullyCollected) {
          summary.collectedPlatformFee = this.addAmount(
            summary.collectedPlatformFee,

            validation.feeAmount,

            "collected platform fee"
          );

          if (validation.feeAmount > 0 && fee.audit?.collectedAt) {
            platformFeeCollectedDates.push(fee.audit.collectedAt);
          }
        }
      }
    }

    summary.committedEmployerCharge = this.addAmount(
      summary.approvedProfessionalPay,

      summary.earnedPlatformFee,

      "committed employer charge"
    );

    summary.lastProfessionalApprovedAt = this.maxDate(professionalApprovedDates);

    summary.lastProfessionalReleasedAt = this.maxDate(professionalReleasedDates);

    summary.lastPlatformFeeEarnedAt = this.maxDate(platformFeeEarnedDates);

    summary.lastPlatformFeeCollectedAt = this.maxDate(platformFeeCollectedDates);

    return summary;
  }

  /* ─────────────────────────────── PARENT FINANCIAL SUMMARY ─────────────────────────────── */

  static buildParentFinancialSummary(occurrences) {
    let refundedAmount = 0;

    let topUpRequired = 0;

    for (const occurrence of occurrences) {
      const occurrenceRefundedAmount = this.amount(occurrence.refundedAmount, "refunded amount");

      const occurrenceRefundableAmount = this.amount(
        occurrence.refundableAmount,
        "refundable amount"
      );

      if (occurrenceRefundedAmount > occurrenceRefundableAmount) {
        throw this.createError({
          message: "An occurrence refunded amount exceeds its refundable amount.",
          code: "OCCURRENCE_REFUNDED_AMOUNT_EXCEEDS_REFUNDABLE_AMOUNT",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),

            refundableAmount: occurrenceRefundableAmount,

            refundedAmount: occurrenceRefundedAmount,
          },
        });
      }

      refundedAmount = this.addAmount(
        refundedAmount,

        occurrenceRefundedAmount,

        "refunded amount"
      );

      topUpRequired = this.addAmount(
        topUpRequired,

        occurrence.topUpRequired,

        "outstanding overtime top-up"
      );
    }

    return {
      refundedAmount,

      topUpRequired,
    };
  }

  /* ─────────────────────────────── PARENT PAYMENT STATUS ─────────────────────────────── */

  static determineParentPaymentStatus({
    shift,
    occurrences,
    occurrenceProgress,
    settlementSummary,
    refundedAmount,
    topUpRequired,
  }) {
    const fundedAmount = this.amount(shift.fundedAmount, "funded amount");

    if (fundedAmount <= 0) {
      return "unpaid";
    }

    if (refundedAmount > fundedAmount) {
      throw this.createError({
        message: "Parent refunded amount exceeds the original funded scheduled allocation.",
        code: "SHIFT_REFUNDED_AMOUNT_EXCEEDS_FUNDED_AMOUNT",
        statusCode: 500,
        details: {
          shiftId: String(shift._id),

          fundedAmount,

          refundedAmount,
        },
      });
    }

    const hasAwaitingTopUp = occurrences.some(
      (occurrence) =>
        Number(occurrence.topUpRequired || 0) > 0 ||
        occurrence.settlementStatus === "awaiting_topup"
    );

    if (topUpRequired > 0 || hasAwaitingTopUp) {
      return "awaiting_topup";
    }

    const hasOvertimeReview = occurrences.some(
      (occurrence) =>
        occurrence.settlementStatus === "awaiting_overtime_review" ||
        (occurrence.overtime?.requested === true &&
          ["pending", "disputed"].includes(
            String(occurrence.overtime?.status || "")
              .trim()
              .toLowerCase()
          ))
    );

    if (hasOvertimeReview) {
      return "awaiting_overtime_review";
    }

    if (occurrences.some((occurrence) => occurrence.settlementStatus === "failed")) {
      return "failed";
    }

    const hasProfessionalReleasePending = occurrences.some((occurrence) =>
      ["base", "overtime"].some((component) =>
        ["approved_for_release", "release_pending"].includes(
          this.getComponentStatus(occurrence, component)
        )
      )
    );

    if (hasProfessionalReleasePending) {
      return "release_pending";
    }

    const allOccurrencesResolved =
      occurrences.length > 0 && occurrenceProgress.resolved === occurrences.length;

    const approvedProfessionalPay = this.amount(
      settlementSummary.approvedProfessionalPay,
      "approved professional pay"
    );

    const releasedProfessionalPay = this.amount(
      settlementSummary.releasedProfessionalPay,
      "released professional pay"
    );

    if (releasedProfessionalPay > approvedProfessionalPay) {
      throw this.createError({
        message: "Parent released professional pay exceeds approved professional pay.",
        code: "SHIFT_RELEASED_PAY_EXCEEDS_APPROVED_PAY",
        statusCode: 500,
        details: {
          shiftId: String(shift._id),

          approvedProfessionalPay,

          releasedProfessionalPay,
        },
      });
    }

    if (allOccurrencesResolved) {
      if (
        refundedAmount === fundedAmount &&
        approvedProfessionalPay === 0 &&
        releasedProfessionalPay === 0
      ) {
        return "refunded";
      }

      /*
       * A final Shift may contain completed professional payout activity and
       * completed employer refund activity across different occurrences.
       */
      if (refundedAmount > 0) {
        return "partially_refunded";
      }

      if (approvedProfessionalPay > 0 && releasedProfessionalPay === approvedProfessionalPay) {
        return "released";
      }

      throw this.createError({
        message: "A fully resolved Shift does not have a valid final parent payment state.",
        code: "FINAL_PARENT_PAYMENT_STATUS_NOT_DERIVABLE",
        statusCode: 500,
        details: {
          shiftId: String(shift._id),

          fundedAmount,

          approvedProfessionalPay,

          releasedProfessionalPay,

          refundedAmount,

          earnedPlatformFee: settlementSummary.earnedPlatformFee,

          collectedPlatformFee: settlementSummary.collectedPlatformFee,

          committedEmployerCharge: settlementSummary.committedEmployerCharge,
        },
      });
    }

    /*
     * Only actual professional payout movement creates partially_released.
     *
     * Platform-fee movement is deliberately ignored here.
     */
    if (releasedProfessionalPay > 0) {
      return "partially_released";
    }

    if (refundedAmount > 0) {
      return "partially_refunded";
    }

    return "funded";
  }

  /* ─────────────────────────────── PARENT OPERATIONAL STATUS ─────────────────────────────── */

  static determineParentOperationalStatus({
    shift,
    occurrences,
    occurrenceProgress,
    paymentStatus,
  }) {
    if (shift.status === "cancelled") {
      return "cancelled";
    }

    const hasActiveChallenge = occurrences.some(
      (occurrence) => occurrence.activeClaim || occurrence.activeDispute
    );

    const hasDispute = occurrences.some(
      (occurrence) =>
        occurrence.status === "disputed" ||
        occurrence.attendanceStatus === "disputed" ||
        occurrence.settlementStatus === "disputed"
    );

    if (hasActiveChallenge || hasDispute) {
      return "disputed";
    }

    if (occurrenceProgress.inProgress > 0) {
      return "in_progress";
    }

    if (
      shift.scheduleMode === "single" &&
      occurrences.length === 1 &&
      occurrences[0].status === "no_show"
    ) {
      return "no_show";
    }

    /*
     * Future scheduled work outranks financial activity on earlier
     * occurrences.
     */
    const scheduledOccurrences = occurrences.filter(
      (occurrence) => occurrence.status === "scheduled"
    );

    if (scheduledOccurrences.length > 0) {
      const hasReplacementRequired = scheduledOccurrences.some(
        (occurrence) => occurrence.assignmentStatus === "replacement_required"
      );

      const hasAssigned = scheduledOccurrences.some(
        (occurrence) => occurrence.assignmentStatus === "assigned"
      );

      const hasOrdinaryUnassigned = scheduledOccurrences.some(
        (occurrence) => occurrence.assignmentStatus === "unassigned"
      );

      if (hasReplacementRequired) {
        return "confirmed";
      }

      if (hasAssigned) {
        return shift.status === "assigned" ? "assigned" : "confirmed";
      }

      if (hasOrdinaryUnassigned) {
        return "open";
      }
    }

    const allOccurrencesResolved =
      occurrences.length > 0 && occurrenceProgress.resolved === occurrences.length;

    if (allOccurrencesResolved && SHIFT_FINAL_PAYMENT_STATUSES.includes(paymentStatus)) {
      return "completed";
    }

    const hasUnresolvedProfessionalSettlement = occurrences.some(
      (occurrence) => !this.isOccurrenceSettlementResolved(occurrence)
    );

    const hasUnresolvedRefund = occurrences.some((occurrence) =>
      UNRESOLVED_REFUND_STATUSES.includes(occurrence.refundStatus)
    );

    if (
      occurrenceProgress.pendingSettlement > 0 ||
      hasUnresolvedProfessionalSettlement ||
      hasUnresolvedRefund
    ) {
      return "pending_settlement";
    }

    if (
      occurrenceProgress.noShow > 0 ||
      occurrenceProgress.cancelled > 0 ||
      occurrenceProgress.expiredUnfilled > 0
    ) {
      return "pending_settlement";
    }

    return shift.status;
  }

  /* ─────────────────────────────── PARENT ASSIGNMENT SUMMARY ─────────────────────────────── */

  static reconcileParentAssignmentSummary({ shift, occurrences, nextStatus }) {
    const assignedOccurrences = occurrences.filter(
      (occurrence) =>
        occurrence.assignmentStatus === "assigned" &&
        ["scheduled", "in_progress"].includes(occurrence.status) &&
        occurrence.assignment &&
        occurrence.assignedProfessional &&
        occurrence.assignedAt
    );

    if (
      ["pending_funding", "open", "completed", "cancelled", "no_show"].includes(nextStatus) ||
      assignedOccurrences.length === 0
    ) {
      shift.activeAssignment = null;

      shift.assignedProfessional = null;

      shift.assignedAt = null;

      shift.assignedBy = null;

      return shift;
    }

    const currentAssignmentStillExists = assignedOccurrences.some(
      (occurrence) => String(occurrence.assignment) === String(shift.activeAssignment || "")
    );

    if (!currentAssignmentStillExists) {
      if (["assigned", "confirmed", "in_progress"].includes(nextStatus)) {
        throw this.createError({
          message:
            "The parent assignment summary does not match any authoritative assigned occurrence.",
          code: "PARENT_ASSIGNMENT_SUMMARY_OUT_OF_SYNC",
          statusCode: 409,
          details: {
            shiftId: String(shift._id),

            activeAssignment: shift.activeAssignment ? String(shift.activeAssignment) : null,

            occurrenceAssignments: assignedOccurrences.map((occurrence) =>
              String(occurrence.assignment)
            ),
          },
        });
      }

      shift.activeAssignment = null;

      shift.assignedProfessional = null;

      shift.assignedAt = null;

      shift.assignedBy = null;

      return shift;
    }

    const currentOccurrence = assignedOccurrences.find(
      (occurrence) => String(occurrence.assignment) === String(shift.activeAssignment)
    );

    /*
     * assignedBy cannot be reconstructed from ShiftOccurrence.
     *
     * The assignment service owns that actor audit. Reconciliation only keeps
     * the occurrence-derived summary fields aligned.
     */
    shift.assignedProfessional = currentOccurrence.assignedProfessional;

    shift.assignedAt = currentOccurrence.assignedAt;

    return shift;
  }

  /* ─────────────────────────────── PARENT RECONCILIATION ─────────────────────────────── */

  static async reconcileParentShift({ shift, currentTime, session }) {
    const occurrences = await this.getOccurrencesForParentReconciliation({
      shiftId: shift._id,

      session,
    });

    const expectedOccurrenceCount = Number(shift.occurrenceCount || 0);

    if (
      !Number.isSafeInteger(expectedOccurrenceCount) ||
      expectedOccurrenceCount <= 0 ||
      occurrences.length !== expectedOccurrenceCount
    ) {
      throw this.createError({
        message: "The parent Shift occurrence count does not match its generated occurrences.",
        code: "SHIFT_OCCURRENCE_COUNT_MISMATCH",
        statusCode: 500,
        details: {
          shiftId: String(shift._id),

          expectedOccurrenceCount,

          actualOccurrenceCount: occurrences.length,
        },
      });
    }

    const isolatedAssignmentClosures = await this.closeResolvedOccurrenceAssignments({
      shift,

      occurrences,

      currentTime,

      session,
    });

    const occurrenceProgress = this.buildOccurrenceProgress({
      occurrences,

      currentTime,
    });

    const settlementSummary = this.buildSettlementSummary({
      occurrences,

      currentTime,
    });

    const { refundedAmount, topUpRequired } = this.buildParentFinancialSummary(occurrences);

    const paymentStatus = this.determineParentPaymentStatus({
      shift,

      occurrences,

      occurrenceProgress,

      settlementSummary,

      refundedAmount,

      topUpRequired,
    });

    const nextStatus = this.determineParentOperationalStatus({
      shift,

      occurrences,

      occurrenceProgress,

      paymentStatus,
    });

    shift.occurrenceProgress = occurrenceProgress;

    shift.settlementSummary = settlementSummary;

    shift.refundedAmount = refundedAmount;

    shift.topUpRequired = topUpRequired;

    shift.paymentStatus = paymentStatus;

    shift.status = nextStatus;

    this.reconcileParentAssignmentSummary({
      shift,

      occurrences,

      nextStatus,
    });

    await shift.save({
      session,
    });

    return {
      shift,

      occurrences,

      occurrenceProgress,

      settlementSummary,

      refundedAmount,

      topUpRequired,

      paymentStatus,

      status: nextStatus,

      isolatedAssignmentClosures,

      activeProfessionalClaimCount: occurrences.filter((occurrence) =>
        Boolean(occurrence.activeClaim)
      ).length,

      activeEmployerDisputeCount: occurrences.filter((occurrence) =>
        Boolean(occurrence.activeDispute)
      ).length,
    };
  }

  static async reconcileShift(
    {
      shiftId,

      currentTime = new Date(),
    },

    options = {}
  ) {
    const normalizedCurrentTime = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(
      options,

      async (session) => {
        const shift = await this.getShift(shiftId, session);

        return this.reconcileParentShift({
          shift,

          currentTime: normalizedCurrentTime,

          session,
        });
      }
    );
  }

  /**
   * Compatibility entry point for callers that know which occurrence changed.
   *
   * This method does NOT mutate or expire the occurrence.
   *
   * It verifies occurrence identity, then rebuilds the parent Shift summary.
   */
  static async reconcileOccurrence(
    {
      shiftId,

      occurrenceId,

      currentTime = new Date(),
    },

    options = {}
  ) {
    const normalizedCurrentTime = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(
      options,

      async (session) => {
        const [shift, occurrence] = await Promise.all([
          this.getShift(shiftId, session),

          this.getOccurrence({
            shiftId,

            occurrenceId,

            session,
          }),
        ]);

        const parentResult = await this.reconcileParentShift({
          shift,

          currentTime: normalizedCurrentTime,

          session,
        });

        return {
          ...parentResult,

          occurrence,

          reconciledOccurrenceId: String(occurrence._id),
        };
      }
    );
  }

  /**
   * Rebuild several parent Shift summaries after an upstream batch/service has
   * changed multiple occurrences.
   *
   * No occurrence truth is created here.
   */
  static async reconcileShifts(
    {
      shiftIds,

      currentTime = new Date(),
    },

    options = {}
  ) {
    if (!Array.isArray(shiftIds) || shiftIds.length === 0) {
      return {
        reconciledCount: 0,

        results: [],
      };
    }

    const normalizedCurrentTime = this.normalizeCurrentTime(currentTime);

    const normalizedShiftIds = [
      ...new Set(shiftIds.map((shiftId) => String(this.normalizeObjectId(shiftId, "shift ID")))),
    ];

    return this.runWithOptionalTransaction(
      options,

      async (session) => {
        const results = [];

        for (const shiftId of normalizedShiftIds) {
          const shift = await this.getShift(shiftId, session);

          const result = await this.reconcileParentShift({
            shift,

            currentTime: normalizedCurrentTime,

            session,
          });

          results.push({
            shiftId: String(result.shift._id),

            paymentStatus: result.paymentStatus,

            status: result.status,

            resolvedOccurrenceCount: result.occurrenceProgress.resolved,
          });
        }

        return {
          reconciledCount: results.length,

          results,
        };
      }
    );
  }
}

module.exports = ShiftOccurrenceReconciliationService;
