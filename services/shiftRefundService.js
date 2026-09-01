// services/shiftRefundService.js

const mongoose = require("mongoose");
const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const EmployerRefund = require("../models/EmployerRefund");
const Transaction = require("../models/Transaction");
const ShiftSettlementService = require("./shiftSettlementService");
const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");
const { generateReference } = require("../utils/reference");
const {
  REFUND_REASONS,
  REFUND_HOLD_REASONS,
  REFUND_EXECUTION_STATUSES,
} = require("../constants/shiftLifecycle");
const { SETTLEMENT_COMPONENT_STATUSES } = require("../constants/shiftSettlement");

const MUTABLE_REFUND_STATUSES = Object.freeze(["held", "eligible"]);
const EXECUTION_REFUND_STATUSES = Object.freeze([...REFUND_EXECUTION_STATUSES]);

const PROFESSIONAL_CLAIM_HOLD_REASON = "professional_claim_pending";
const EMPLOYER_DISPUTE_HOLD_REASON = "employer_dispute_pending";
const PROFESSIONAL_SETTLEMENT_HOLD_REASON = "professional_settlement_pending";
const CHALLENGE_WINDOW_HOLD_REASON = "challenge_window_open";

/**
 * SHIFT REFUND SERVICE ARCHITECTURE
 *
 * ShiftRefundService owns the occurrence-level EmployerRefund obligation.
 *
 * SCHEDULED / BASE REFUND
 *
 * EmployerRefund represents unused money from the ORIGINAL scheduled/base
 * allocation only.
 *
 * The authoritative calculation is:
 *
 *   estimatedEmployerCharge
 *   - (
 *       established baseProfessionalPay
 *       + already-earned BASE platform fee
 *     )
 *
 * Specialized BASE outcomes still own their own audit values:
 *
 * - cancellationCompensation.professionalPay; and
 * - activeWorkCancellation.professionalPay.
 *
 * Before the refund workflow may use either specialized outcome, #7 must have
 * established the same amount in baseProfessionalPay. This keeps the refund
 * service aligned with ShiftOccurrence's authoritative refund mirror.
 *
 * Overtime is separately funded and MUST NOT reduce the original scheduled
 * refund.
 *
 * Therefore this service never subtracts:
 *
 * - overtimeProfessionalPay;
 * - overtimePlatformFee; or
 * - topUpRequired
 *
 * from estimatedEmployerCharge.
 *
 * PLATFORM FEES
 *
 * This service does not earn, recalculate, reverse or refund platform fees.
 *
 * If the occurrence had already earned its BASE platform fee, that fee remains
 * consumed from the original scheduled allocation even if the professional's
 * final BASE entitlement later changes.
 *
 * BASE-SCOPED FINALITY
 *
 * Refund eligibility must use the SAME live challenge authority as professional
 * settlement.
 *
 * This service therefore does not inspect ShiftOccurrenceClaim or
 * ShiftOccurrenceDispute directly.
 *
 * It consumes ShiftSettlementService.getActiveChallengeContext(), whose live
 * scope is derived from unresolved issues only.
 *
 * activeClaim and activeDispute may coexist.
 *
 * A scheduled/base refund remains held while ANY of the following is true:
 *
 * 1. an unresolved professional-claim issue affects BASE;
 * 2. an unresolved employer-dispute issue affects BASE;
 * 3. BASE remains ordinarily challengeable inside the shared 24-hour window;
 * 4. a positive BASE professional payout still has to be released.
 *
 * OT-only activity does not hold this refund.
 *
 * HOLD PRIORITY
 *
 * Where several BASE blockers coexist, the stored hold reason is selected in
 * this order:
 *
 * 1. professional_claim_pending;
 * 2. employer_dispute_pending;
 * 3. challenge_window_open;
 * 4. professional_settlement_pending.
 *
 * This is only the displayed/audited primary blocker. Eligibility still
 * requires ALL BASE blockers to be gone.
 *
 * EXECUTION SAFETY
 *
 * Once an EmployerRefund has entered batched, processing or refunded state,
 * this service does not rewrite its amount or execution state.
 *
 * If later authoritative refund truth conflicts with an execution-locked
 * obligation, this service does not perform financial/provider reconciliation.
 * It returns executionLocked / revalidationRequired / reconciliationRequired
 * signals to EmployerRefundBatchService.
 *
 * revalidationRequired means the refund is only batched and can still be
 * detached/revalidated before crossing a financial boundary.
 *
 * reconciliationRequired means the refund is already processing/refunded and
 * current authoritative entitlement conflicts with that execution history. It
 * is a financial-conflict signal, not routine Paystack provider polling.
 *
 * FUNDING DESTINATION
 *
 * Refund destination remains locked to the parent Shift's original funding
 * source:
 *
 * - wallet-funded Shift -> employer wallet;
 * - Paystack Checkout-funded Shift -> original Paystack payment reversal.
 *
 * Mixed funding is not supported.
 *
 * This service establishes and maintains the obligation only. It does not
 * submit, retry or poll provider refunds. EmployerRefundBatchService owns final
 * pre-execution revalidation, financial execution and provider reconciliation.
 */
class ShiftRefundService {
  /* ─────────────────────────────── CORE ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: "ShiftRefundServiceError",
      message,
      code,
      statusCode,
      details,
    });
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    return runServiceTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeObjectId(value, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw ShiftRefundService.createError({
        message: `${fieldName} is required.`,
        code: `${normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw ShiftRefundService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw ShiftRefundService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeAmount(value, fieldName, { positive = false } = {}) {
    const amount = Number(value ?? 0);

    const valid = Number.isSafeInteger(amount) && (positive ? amount > 0 : amount >= 0);

    if (!valid) {
      throw ShiftRefundService.createError({
        message:
          `${fieldName} must be ` +
          `${positive ? "a positive" : "a non-negative"} whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return amount;
  }

  static normalizeEnum(value, allowedValues, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw ShiftRefundService.createError({
        message: `${fieldName} is required.`,
        code: `${normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    const normalizedValue = String(value).trim().toLowerCase();

    if (!allowedValues.includes(normalizedValue)) {
      throw ShiftRefundService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        details: {
          allowedValues,
        },
      });
    }

    return normalizedValue;
  }

  static normalizeRefundReason(value) {
    return ShiftRefundService.normalizeEnum(value, REFUND_REASONS, "refund reason");
  }

  static normalizeHoldReason(value, required = false) {
    return ShiftRefundService.normalizeEnum(
      value,
      REFUND_HOLD_REASONS,
      "refund hold reason",
      required
    );
  }

  static normalizeInitiatedBy(value = null) {
    const initiatedBy = value || {
      role: "system",
      userId: null,
    };

    const role = ShiftRefundService.normalizeEnum(
      initiatedBy.role || "system",
      ["system", "employer", "professional", "admin"],
      "refund initiator role"
    );

    const userId = ShiftRefundService.normalizeObjectId(
      initiatedBy.userId,
      "initiator user ID",
      role !== "system"
    );

    if (role === "system" && userId) {
      throw ShiftRefundService.createError({
        message: "A system refund action cannot contain an initiator user ID.",
        code: "SYSTEM_REFUND_INITIATOR_USER_NOT_ALLOWED",
      });
    }

    return {
      role,
      userId,
    };
  }

  static normalizeVoidReason(value) {
    const voidReason = String(value || "").trim();

    if (!voidReason) {
      throw ShiftRefundService.createError({
        message: "Refund void reason is required.",
        code: "REFUND_VOID_REASON_REQUIRED",
      });
    }

    if (voidReason.length > 1000) {
      throw ShiftRefundService.createError({
        message: "Refund void reason cannot exceed 1000 characters.",
        code: "REFUND_VOID_REASON_TOO_LONG",
      });
    }

    return voidReason;
  }

  static normalizeScheduledProcessingAt(value, eligibleAt) {
    const scheduledProcessingAt = value ? new Date(value) : new Date(eligibleAt);

    if (Number.isNaN(scheduledProcessingAt.getTime())) {
      throw ShiftRefundService.createError({
        message: "Scheduled refund processing time is invalid.",
        code: "INVALID_REFUND_SCHEDULED_PROCESSING_AT",
      });
    }

    if (scheduledProcessingAt < eligibleAt) {
      throw ShiftRefundService.createError({
        message: "Scheduled refund processing time cannot be earlier than eligibility.",
        code: "REFUND_PROCESSING_BEFORE_ELIGIBILITY",
      });
    }

    return scheduledProcessingAt;
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  static sameNullableId(left, right) {
    if (!left && !right) {
      return true;
    }

    return ShiftRefundService.sameId(left, right);
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getShift(shiftId, session = null) {
    const normalizedShiftId = ShiftRefundService.normalizeObjectId(shiftId, "shift ID");

    const query = Shift.findById(normalizedShiftId).select(
      [
        "referenceCode",
        "business",
        "branch",
        "countryCode",
        "currency",
        "status",
        "paymentStatus",
        "fundingMethod",
        "fundingTransaction",
        "fundedAmount",
        "fundedAt",
        "publishedAt",
      ].join(" ")
    );

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftRefundService.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getOccurrence({ shiftId, occurrenceId, session = null }) {
    const normalizedShiftId = ShiftRefundService.normalizeObjectId(shiftId, "shift ID");

    const normalizedOccurrenceId = ShiftRefundService.normalizeObjectId(
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
      throw ShiftRefundService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static async getEmployerRefundByOccurrence(occurrenceId, session = null) {
    const normalizedOccurrenceId = ShiftRefundService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = EmployerRefund.findOne({
      occurrence: normalizedOccurrenceId,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  static async resolveContext({
    shift = null,
    occurrence = null,
    shiftId = null,
    occurrenceId = null,
    session = null,
  }) {
    const resolvedShift = shift || (await ShiftRefundService.getShift(shiftId, session));

    const resolvedOccurrence =
      occurrence ||
      (await ShiftRefundService.getOccurrence({
        shiftId: resolvedShift._id,

        occurrenceId,

        session,
      }));

    ShiftRefundService.assertOwnership({
      shift: resolvedShift,

      occurrence: resolvedOccurrence,
    });

    return {
      shift: resolvedShift,

      occurrence: resolvedOccurrence,
    };
  }

  static async getOriginalFundingTransaction(shift, session = null) {
    if (!shift.fundingTransaction) {
      throw ShiftRefundService.createError({
        message: "The Shift does not reference its original funding transaction.",
        code: "SHIFT_FUNDING_TRANSACTION_MISSING",
        statusCode: 500,
      });
    }

    const query = Transaction.findById(shift.fundingTransaction).select(
      [
        "shift",
        "type",
        "purpose",
        "direction",
        "amount",
        "countryCode",
        "currency",
        "paymentRail",
        "provider",
        "status",
        "paystackReference",
        "metadata",
      ].join(" ")
    );

    if (session) {
      query.session(session);
    }

    const transaction = await query;

    if (!transaction) {
      throw ShiftRefundService.createError({
        message: "The original Shift funding transaction was not found.",
        code: "SHIFT_FUNDING_TRANSACTION_NOT_FOUND",
        statusCode: 500,
      });
    }

    if (
      transaction.type !== "shift_funding" ||
      transaction.purpose !== "shift_base_funding" ||
      transaction.status !== "completed" ||
      transaction.direction !== "credit" ||
      !ShiftRefundService.sameId(transaction.shift, shift._id)
    ) {
      throw ShiftRefundService.createError({
        message: "The Shift funding transaction is not a completed authoritative escrow credit.",
        code: "INVALID_SHIFT_FUNDING_TRANSACTION",
        statusCode: 500,
        details: {
          transactionId: String(transaction._id),

          type: transaction.type,

          purpose: transaction.purpose,

          status: transaction.status,

          direction: transaction.direction,
        },
      });
    }

    const fundedAmount = ShiftRefundService.normalizeAmount(
      shift.fundedAmount,
      "Shift funded amount",
      {
        positive: true,
      }
    );

    const transactionAmount = ShiftRefundService.normalizeAmount(
      transaction.amount,
      "Shift funding transaction amount",
      {
        positive: true,
      }
    );

    if (transactionAmount !== fundedAmount) {
      throw ShiftRefundService.createError({
        message:
          "The original Shift funding transaction amount does not match the parent funded amount.",
        code: "SHIFT_FUNDING_AMOUNT_MISMATCH",
        statusCode: 500,
        details: {
          fundedAmount,
          transactionAmount,
        },
      });
    }

    if (
      String(transaction.countryCode || "").toUpperCase() !==
        String(shift.countryCode || "").toUpperCase() ||
      String(transaction.currency || "").toUpperCase() !==
        String(shift.currency || "").toUpperCase()
    ) {
      throw ShiftRefundService.createError({
        message:
          "The original Shift funding transaction country or currency does not match the Shift.",
        code: "SHIFT_FUNDING_CURRENCY_MISMATCH",
        statusCode: 500,
      });
    }

    return transaction;
  }

  /* ─────────────────────────────── CONTEXT VALIDATION ─────────────────────────────── */

  static assertOwnership({ shift, occurrence }) {
    if (!shift?._id || !occurrence?._id) {
      throw ShiftRefundService.createError({
        message: "Shift and occurrence documents are required.",
        code: "REFUND_CONTEXT_REQUIRED",
        statusCode: 500,
      });
    }

    if (
      !ShiftRefundService.sameId(occurrence.shift, shift._id) ||
      !ShiftRefundService.sameId(occurrence.business, shift.business)
    ) {
      throw ShiftRefundService.createError({
        message: "The occurrence does not belong to the supplied Shift and employer.",
        code: "SHIFT_OCCURRENCE_OWNERSHIP_MISMATCH",
        statusCode: 409,
      });
    }

    if (shift.branch && !ShiftRefundService.sameId(occurrence.branch, shift.branch)) {
      throw ShiftRefundService.createError({
        message: "The occurrence branch does not match the parent Shift.",
        code: "SHIFT_OCCURRENCE_BRANCH_MISMATCH",
        statusCode: 409,
      });
    }
  }

  static assertFundedShift(shift) {
    const fundedAmount = ShiftRefundService.normalizeAmount(
      shift.fundedAmount,
      "Shift funded amount"
    );

    if (
      shift.paymentStatus === "unpaid" ||
      fundedAmount <= 0 ||
      !shift.fundedAt ||
      !shift.fundingMethod ||
      !shift.fundingTransaction
    ) {
      throw ShiftRefundService.createError({
        message: "Only a funded Shift may establish an employer refund obligation.",
        code: "UNFUNDED_SHIFT_CANNOT_ESTABLISH_REFUND",
        statusCode: 409,
      });
    }
  }

  static assertReasonMatchesOccurrence({ shift, occurrence, reason }) {
    let invalid = false;

    if (reason === "expired_unfilled") {
      invalid =
        occurrence.assignmentStatus !== "expired_unfilled" ||
        occurrence.status !== "expired_unfilled";
    }

    if (reason === "occurrence_cancelled") {
      invalid = occurrence.status !== "cancelled";
    }

    if (reason === "confirmed_no_show") {
      invalid = occurrence.status !== "no_show" || occurrence.attendanceStatus !== "no_show";
    }

    if (reason === "unused_scheduled_time") {
      invalid = !["pending_settlement", "completed"].includes(occurrence.status);
    }

    if (reason === "engagement_closed") {
      invalid = !["completed", "cancelled", "no_show"].includes(shift.status);
    }

    if (invalid) {
      throw ShiftRefundService.createError({
        message: "The refund reason does not match the current Shift occurrence outcome.",
        code: "REFUND_REASON_OUTCOME_MISMATCH",
        statusCode: 409,
        details: {
          refundReason: reason,

          shiftStatus: shift.status,

          occurrenceStatus: occurrence.status,

          assignmentStatus: occurrence.assignmentStatus,

          attendanceStatus: occurrence.attendanceStatus,
        },
      });
    }
  }

  static deriveRefundReason({ shift, occurrence }) {
    if (
      occurrence.status === "expired_unfilled" &&
      occurrence.assignmentStatus === "expired_unfilled"
    ) {
      return "expired_unfilled";
    }

    if (occurrence.status === "cancelled") {
      return "occurrence_cancelled";
    }

    if (occurrence.status === "no_show" && occurrence.attendanceStatus === "no_show") {
      return "confirmed_no_show";
    }

    if (["pending_settlement", "completed"].includes(occurrence.status)) {
      return "unused_scheduled_time";
    }

    if (["completed", "cancelled", "no_show"].includes(shift.status)) {
      return "engagement_closed";
    }

    throw ShiftRefundService.createError({
      message: "A refund reason could not be derived from the occurrence outcome.",
      code: "REFUND_REASON_NOT_DERIVABLE",
      statusCode: 409,
      details: {
        shiftStatus: shift.status,

        occurrenceStatus: occurrence.status,

        assignmentStatus: occurrence.assignmentStatus,

        attendanceStatus: occurrence.attendanceStatus,
      },
    });
  }

  /* ─────────────────────────────── BASE PRICING ─────────────────────────────── */

  static getBaseProfessionalEntitlement(occurrence) {
    const baseProfessionalPay = ShiftRefundService.normalizeAmount(
      occurrence.baseProfessionalPay,
      "Base professional pay"
    );

    const hasActiveWorkCancellation = occurrence.activeWorkCancellation?.occurred === true;

    const hasCancellationCompensation = occurrence.cancellationCompensation?.applicable === true;

    if (hasActiveWorkCancellation && hasCancellationCompensation) {
      throw ShiftRefundService.createError({
        message:
          "An occurrence cannot contain active-work cancellation and cancellation compensation at the same time.",
        code: "OCCURRENCE_BASE_ENTITLEMENT_CONFLICT",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    let specializedProfessionalPay = null;

    let specializedField = null;

    if (hasActiveWorkCancellation) {
      specializedProfessionalPay = ShiftRefundService.normalizeAmount(
        occurrence.activeWorkCancellation.professionalPay,
        "Active-work cancellation professional pay"
      );

      specializedField = "activeWorkCancellation.professionalPay";
    } else if (hasCancellationCompensation) {
      specializedProfessionalPay = ShiftRefundService.normalizeAmount(
        occurrence.cancellationCompensation.professionalPay,
        "Cancellation compensation professional pay"
      );

      specializedField = "cancellationCompensation.professionalPay";
    }

    if (specializedProfessionalPay !== null) {
      if (specializedProfessionalPay <= 0) {
        throw ShiftRefundService.createError({
          message:
            "A specialized BASE entitlement must contain positive professional pay before refund calculation.",
          code: "SPECIALIZED_BASE_ENTITLEMENT_NOT_POSITIVE",
          statusCode: 500,
          details: {
            occurrenceId: occurrence?._id ? String(occurrence._id) : null,

            specializedField,

            specializedProfessionalPay,
          },
        });
      }

      /*
       * ShiftOccurrence's refund mirror is intentionally based on
       * baseProfessionalPay.
       *
       * The cancellation subdocument establishes the specialized entitlement
       * fact first. #7 then establishes the same amount as the authoritative
       * BASE professional-pay mirror before refund evaluation may progress.
       */
      if (baseProfessionalPay <= 0) {
        throw ShiftRefundService.createError({
          message:
            "The occurrence's specialized BASE entitlement has not yet been established in baseProfessionalPay.",
          code: "BASE_PROFESSIONAL_PAY_NOT_ESTABLISHED_FOR_REFUND",
          statusCode: 409,
          details: {
            occurrenceId: occurrence?._id ? String(occurrence._id) : null,

            specializedField,

            specializedProfessionalPay,

            baseProfessionalPay,
          },
        });
      }

      if (baseProfessionalPay !== specializedProfessionalPay) {
        throw ShiftRefundService.createError({
          message:
            "The occurrence baseProfessionalPay does not match its specialized BASE entitlement.",
          code: "SPECIALIZED_BASE_ENTITLEMENT_MISMATCH",
          statusCode: 500,
          details: {
            occurrenceId: occurrence?._id ? String(occurrence._id) : null,

            specializedField,

            specializedProfessionalPay,

            baseProfessionalPay,
          },
        });
      }
    }

    const baseSettlementPay = ShiftRefundService.normalizeAmount(
      occurrence.baseSettlement?.professionalPay,
      "BASE settlement professional pay"
    );

    /*
     * Once #7 has created a positive BASE payout component, its amount must
     * mirror the established baseProfessionalPay authority used by the refund
     * workflow.
     */
    if (baseSettlementPay > 0 && baseSettlementPay !== baseProfessionalPay) {
      throw ShiftRefundService.createError({
        message: "The BASE payout component does not match established baseProfessionalPay.",
        code: "BASE_SETTLEMENT_PROFESSIONAL_PAY_MISMATCH",
        statusCode: 500,
        details: {
          baseProfessionalPay,

          specializedField,

          specializedProfessionalPay,

          baseSettlementProfessionalPay: baseSettlementPay,
        },
      });
    }

    return baseProfessionalPay;
  }

  static assertBasePlatformFeeState(occurrence) {
    const estimatedPlatformFee = ShiftRefundService.normalizeAmount(
      occurrence.estimatedPlatformFee,
      "Estimated platform fee"
    );

    const basePlatformFee = ShiftRefundService.normalizeAmount(
      occurrence.basePlatformFee,
      "Base platform fee"
    );

    const feeAudit = occurrence.basePlatformFeeAudit || {};

    if (!feeAudit.earnedAt) {
      if (basePlatformFee !== 0) {
        throw ShiftRefundService.createError({
          message: "The occurrence contains a base platform fee without a fee-earning audit.",
          code: "BASE_PLATFORM_FEE_WITHOUT_EARNING_AUDIT",
          statusCode: 500,
        });
      }

      const hasConfirmedAssignmentHistory = Boolean(
        ["assigned", "replacement_required"].includes(occurrence.assignmentStatus) ||
        (occurrence.assignmentStatus === "expired_unfilled" &&
          occurrence.expiredFromAssignmentStatus === "replacement_required")
      );

      if (estimatedPlatformFee > 0 && hasConfirmedAssignmentHistory) {
        throw ShiftRefundService.createError({
          message:
            "An occurrence with confirmed assignment history is missing its base platform-fee earning audit.",
          code: "CONFIRMED_OCCURRENCE_BASE_FEE_AUDIT_MISSING",
          statusCode: 500,
        });
      }

      return 0;
    }

    if (basePlatformFee !== estimatedPlatformFee) {
      throw ShiftRefundService.createError({
        message: "The earned base platform fee does not match the occurrence pricing snapshot.",
        code: "BASE_PLATFORM_FEE_PRICING_MISMATCH",
        statusCode: 500,
        details: {
          basePlatformFee,
          estimatedPlatformFee,
        },
      });
    }

    return basePlatformFee;
  }

  static calculateExpectedRefundAmount(occurrence) {
    const estimatedEmployerCharge = ShiftRefundService.normalizeAmount(
      occurrence.estimatedEmployerCharge,
      "Occurrence estimated employer charge",
      {
        positive: true,
      }
    );

    const professionalEntitlement = ShiftRefundService.getBaseProfessionalEntitlement(occurrence);

    const earnedBasePlatformFee = ShiftRefundService.assertBasePlatformFeeState(occurrence);

    const authoritativeBaseConsumedAmount = professionalEntitlement + earnedBasePlatformFee;

    if (!Number.isSafeInteger(authoritativeBaseConsumedAmount)) {
      throw ShiftRefundService.createError({
        message:
          "The occurrence authoritative BASE consumed amount exceeds the supported minor-unit range.",
        code: "BASE_CONSUMED_AMOUNT_TOO_LARGE",
        statusCode: 500,
      });
    }

    const expectedRefundAmount = estimatedEmployerCharge - authoritativeBaseConsumedAmount;

    if (!Number.isSafeInteger(expectedRefundAmount) || expectedRefundAmount < 0) {
      throw ShiftRefundService.createError({
        message:
          "The authoritative BASE consumed amount exceeds the original scheduled allocation.",
        code: "BASE_CHARGE_EXCEEDS_SCHEDULED_ALLOCATION",
        statusCode: 409,
        details: {
          estimatedEmployerCharge,

          authoritativeBaseConsumedAmount,
        },
      });
    }

    return expectedRefundAmount;
  }

  static resolvePositiveRefundAmount({ occurrence, refundableAmount = null }) {
    const expectedAmount = ShiftRefundService.calculateExpectedRefundAmount(occurrence);

    if (expectedAmount <= 0) {
      throw ShiftRefundService.createError({
        message: "The occurrence does not contain a positive refundable scheduled balance.",
        code: "OCCURRENCE_REFUND_AMOUNT_NOT_POSITIVE",
        statusCode: 409,
      });
    }

    const occurrenceAmount = ShiftRefundService.normalizeAmount(
      occurrence.refundableAmount,
      "Occurrence refundable amount"
    );

    const suppliedAmount =
      refundableAmount === null || refundableAmount === undefined
        ? expectedAmount
        : ShiftRefundService.normalizeAmount(refundableAmount, "Employer refund amount", {
            positive: true,
          });

    if (
      suppliedAmount !== expectedAmount ||
      (occurrenceAmount > 0 && occurrenceAmount !== expectedAmount)
    ) {
      throw ShiftRefundService.createError({
        message:
          "The refund amount does not match the occurrence's unused scheduled/base allocation.",
        code: "OCCURRENCE_REFUND_AMOUNT_MISMATCH",
        statusCode: 409,
        details: {
          suppliedAmount,

          occurrenceAmount,

          expectedAmount,
        },
      });
    }

    return expectedAmount;
  }

  /* ─────────────────────────────── BASE-SCOPED DEPENDENCIES ─────────────────────────────── */

  static getBaseSettlementStatus(occurrence) {
    const status = String(occurrence.baseSettlement?.status || "not_due")
      .trim()
      .toLowerCase();

    if (!SETTLEMENT_COMPONENT_STATUSES.includes(status)) {
      throw ShiftRefundService.createError({
        message: "The occurrence contains an unsupported base settlement component status.",
        code: "INVALID_BASE_SETTLEMENT_STATUS",
        statusCode: 500,
        details: {
          baseSettlementStatus: status,
        },
      });
    }

    return status;
  }

  static baseProfessionalSettlementIsPending(occurrence) {
    const professionalEntitlement = ShiftRefundService.getBaseProfessionalEntitlement(occurrence);

    if (professionalEntitlement <= 0) {
      return false;
    }

    return ShiftRefundService.getBaseSettlementStatus(occurrence) !== "released";
  }

  static challengeContextAffectsBase(caseContext) {
    return Boolean(caseContext?.affectedSettlementComponents?.includes("base"));
  }

  static async getLiveBaseChallengeState({ occurrence, currentTime, session }) {
    const now = ShiftRefundService.normalizeCurrentTime(currentTime);

    /*
     * Keep the occurrence-owned window audit synchronized before evaluating
     * ordinary BASE challengeability.
     *
     * Submission of a claim/dispute never closes this window early.
     */
    const challengeWindowSynchronization = ShiftSettlementService.synchronizeExpiredChallengeWindow(
      {
        occurrence,
        currentTime: now,
      }
    );

    const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
      occurrence,
      session,
    });

    const claimAffectsBase = ShiftRefundService.challengeContextAffectsBase(challengeContext.claim);

    const disputeAffectsBase = ShiftRefundService.challengeContextAffectsBase(
      challengeContext.dispute
    );

    const baseOrdinarilyChallengeable = ShiftSettlementService.isComponentOrdinarilyChallengeable({
      occurrence,
      component: "base",
      currentTime: now,
    });

    return {
      challengeWindowSynchronization,

      challengeContext,

      claimAffectsBase,

      disputeAffectsBase,

      baseOrdinarilyChallengeable,

      claimId: claimAffectsBase
        ? challengeContext.claim?.caseDocument?._id || occurrence.activeClaim || null
        : null,

      disputeId: disputeAffectsBase
        ? challengeContext.dispute?.caseDocument?._id || occurrence.activeDispute || null
        : null,
    };
  }

  static async resolveAutomaticHold({ occurrence, currentTime, session }) {
    const liveChallenge = await ShiftRefundService.getLiveBaseChallengeState({
      occurrence,
      currentTime,
      session,
    });

    const baseSettlementPending =
      ShiftRefundService.baseProfessionalSettlementIsPending(occurrence);

    const blockers = [];

    if (liveChallenge.claimAffectsBase) {
      blockers.push({
        holdReason: PROFESSIONAL_CLAIM_HOLD_REASON,

        claimId: liveChallenge.claimId,

        disputeId: null,
      });
    }

    if (liveChallenge.disputeAffectsBase) {
      blockers.push({
        holdReason: EMPLOYER_DISPUTE_HOLD_REASON,

        claimId: null,

        disputeId: liveChallenge.disputeId,
      });
    }

    if (liveChallenge.baseOrdinarilyChallengeable) {
      blockers.push({
        holdReason: CHALLENGE_WINDOW_HOLD_REASON,

        claimId: null,

        disputeId: null,
      });
    }

    if (baseSettlementPending) {
      blockers.push({
        holdReason: PROFESSIONAL_SETTLEMENT_HOLD_REASON,

        claimId: null,

        disputeId: null,
      });
    }

    const primaryBlocker = blockers[0] || {
      holdReason: null,
      claimId: null,
      disputeId: null,
    };

    return {
      ...primaryBlocker,

      blockers,

      challengeContext: liveChallenge.challengeContext,

      challengeWindowSynchronization: liveChallenge.challengeWindowSynchronization,

      baseOrdinarilyChallengeable: liveChallenge.baseOrdinarilyChallengeable,

      baseProfessionalSettlementPending: baseSettlementPending,
    };
  }

  static async assertRequestedProfessionalClaimHold({ occurrence, claimId, currentTime, session }) {
    const liveChallenge = await ShiftRefundService.getLiveBaseChallengeState({
      occurrence,
      currentTime,
      session,
    });

    if (!liveChallenge.claimAffectsBase || !liveChallenge.claimId) {
      throw ShiftRefundService.createError({
        message:
          "professional_claim_pending requires an unresolved professional-claim issue that affects BASE.",
        code: "REFUND_HOLD_BASE_CLAIM_REQUIRED",
        statusCode: 409,
      });
    }

    if (claimId && !ShiftRefundService.sameId(claimId, liveChallenge.claimId)) {
      throw ShiftRefundService.createError({
        message:
          "The supplied claim does not match the occurrence's active BASE-affecting professional claim.",
        code: "REFUND_HOLD_ACTIVE_CLAIM_MISMATCH",
        statusCode: 409,
      });
    }

    return liveChallenge.claimId;
  }

  static async assertRequestedEmployerDisputeHold({ occurrence, disputeId, currentTime, session }) {
    const liveChallenge = await ShiftRefundService.getLiveBaseChallengeState({
      occurrence,
      currentTime,
      session,
    });

    if (!liveChallenge.disputeAffectsBase || !liveChallenge.disputeId) {
      throw ShiftRefundService.createError({
        message:
          "employer_dispute_pending requires an unresolved employer-dispute issue that affects BASE.",
        code: "REFUND_HOLD_BASE_DISPUTE_REQUIRED",
        statusCode: 409,
      });
    }

    if (disputeId && !ShiftRefundService.sameId(disputeId, liveChallenge.disputeId)) {
      throw ShiftRefundService.createError({
        message:
          "The supplied dispute does not match the occurrence's active BASE-affecting employer dispute.",
        code: "REFUND_HOLD_ACTIVE_DISPUTE_MISMATCH",
        statusCode: 409,
      });
    }

    return liveChallenge.disputeId;
  }

  static async assertRequestedChallengeWindowHold({ occurrence, currentTime, session }) {
    const liveChallenge = await ShiftRefundService.getLiveBaseChallengeState({
      occurrence,
      currentTime,
      session,
    });

    if (!liveChallenge.baseOrdinarilyChallengeable) {
      throw ShiftRefundService.createError({
        message:
          "challenge_window_open requires BASE to remain ordinarily challengeable inside the shared occurrence review window.",
        code: "BASE_CHALLENGE_WINDOW_NOT_OPEN",
        statusCode: 409,
      });
    }

    return true;
  }

  static assertRequestedProfessionalSettlementHold(occurrence) {
    if (!ShiftRefundService.baseProfessionalSettlementIsPending(occurrence)) {
      throw ShiftRefundService.createError({
        message:
          "professional_settlement_pending requires a positive BASE professional payout that has not been released.",
        code: "REFUND_BASE_SETTLEMENT_NOT_PENDING",
        statusCode: 409,
      });
    }

    return true;
  }

  static async resolveRequestedHold({
    occurrence,
    holdReason,
    claimId,
    disputeId,
    currentTime,
    session,
  }) {
    const now = ShiftRefundService.normalizeCurrentTime(currentTime);

    const automaticHold = await ShiftRefundService.resolveAutomaticHold({
      occurrence,
      currentTime: now,
      session,
    });

    const requestedHoldReason = ShiftRefundService.normalizeHoldReason(holdReason, false);

    const requestedClaimId = ShiftRefundService.normalizeObjectId(claimId, "claim ID", false);

    const requestedDisputeId = ShiftRefundService.normalizeObjectId(disputeId, "dispute ID", false);

    if (requestedClaimId && requestedDisputeId) {
      throw ShiftRefundService.createError({
        message:
          "A refund hold cannot link a professional claim and employer dispute at the same time.",
        code: "REFUND_HOLD_CASE_LINK_CONFLICT",
        statusCode: 409,
      });
    }

    /*
     * A real BASE dependency is authoritative.
     *
     * A caller cannot weaken or bypass it with a manual hold reason.
     */
    if (automaticHold.holdReason) {
      if (
        automaticHold.claimId &&
        requestedClaimId &&
        !ShiftRefundService.sameId(automaticHold.claimId, requestedClaimId)
      ) {
        throw ShiftRefundService.createError({
          message:
            "The supplied claim does not match the occurrence's active BASE-affecting professional claim.",
          code: "REFUND_HOLD_ACTIVE_CLAIM_MISMATCH",
          statusCode: 409,
        });
      }

      if (
        automaticHold.disputeId &&
        requestedDisputeId &&
        !ShiftRefundService.sameId(automaticHold.disputeId, requestedDisputeId)
      ) {
        throw ShiftRefundService.createError({
          message:
            "The supplied dispute does not match the occurrence's active BASE-affecting employer dispute.",
          code: "REFUND_HOLD_ACTIVE_DISPUTE_MISMATCH",
          statusCode: 409,
        });
      }

      return automaticHold;
    }

    if (!requestedHoldReason) {
      if (requestedClaimId || requestedDisputeId) {
        throw ShiftRefundService.createError({
          message: "A refund case link requires a case-based hold reason.",
          code: "REFUND_HOLD_REASON_REQUIRED_FOR_CASE_LINK",
          statusCode: 409,
        });
      }

      return automaticHold;
    }

    if (requestedHoldReason === PROFESSIONAL_CLAIM_HOLD_REASON) {
      const resolvedClaimId = await ShiftRefundService.assertRequestedProfessionalClaimHold({
        occurrence,
        claimId: requestedClaimId,
        currentTime: now,
        session,
      });

      return {
        holdReason: requestedHoldReason,

        claimId: resolvedClaimId,

        disputeId: null,

        blockers: [
          {
            holdReason: requestedHoldReason,

            claimId: resolvedClaimId,

            disputeId: null,
          },
        ],
      };
    }

    if (requestedHoldReason === EMPLOYER_DISPUTE_HOLD_REASON) {
      const resolvedDisputeId = await ShiftRefundService.assertRequestedEmployerDisputeHold({
        occurrence,
        disputeId: requestedDisputeId,
        currentTime: now,
        session,
      });

      return {
        holdReason: requestedHoldReason,

        claimId: null,

        disputeId: resolvedDisputeId,

        blockers: [
          {
            holdReason: requestedHoldReason,

            claimId: null,

            disputeId: resolvedDisputeId,
          },
        ],
      };
    }

    if (requestedHoldReason === CHALLENGE_WINDOW_HOLD_REASON) {
      await ShiftRefundService.assertRequestedChallengeWindowHold({
        occurrence,
        currentTime: now,
        session,
      });

      return {
        holdReason: requestedHoldReason,

        claimId: null,

        disputeId: null,

        blockers: [
          {
            holdReason: requestedHoldReason,

            claimId: null,

            disputeId: null,
          },
        ],
      };
    }

    if (requestedHoldReason === PROFESSIONAL_SETTLEMENT_HOLD_REASON) {
      ShiftRefundService.assertRequestedProfessionalSettlementHold(occurrence);

      return {
        holdReason: requestedHoldReason,

        claimId: null,

        disputeId: null,

        blockers: [
          {
            holdReason: requestedHoldReason,

            claimId: null,

            disputeId: null,
          },
        ],
      };
    }

    if (requestedClaimId || requestedDisputeId) {
      throw ShiftRefundService.createError({
        message:
          "Only professional_claim_pending or employer_dispute_pending may link a challenge case to an EmployerRefund hold.",
        code: "REFUND_HOLD_UNEXPECTED_CASE_LINK",
        statusCode: 409,
      });
    }

    /*
     * attendance_review_pending, manual_review and other remain available as
     * explicit operational holds when no stronger automatic BASE dependency
     * currently exists.
     */
    return {
      holdReason: requestedHoldReason,

      claimId: null,

      disputeId: null,

      blockers: [
        {
          holdReason: requestedHoldReason,

          claimId: null,

          disputeId: null,
        },
      ],
    };
  }

  /* ─────────────────────────────── FUNDING SOURCE ─────────────────────────────── */

  static resolveFundingSource({ shift, fundingTransaction }) {
    if (["wallet", "wallet_balance"].includes(shift.fundingMethod)) {
      if (fundingTransaction.paymentRail !== "wallet_balance") {
        throw ShiftRefundService.createError({
          message:
            "The wallet-funded Shift does not reference a wallet-balance funding transaction.",
          code: "SHIFT_WALLET_FUNDING_TRANSACTION_MISMATCH",
          statusCode: 500,
        });
      }

      return {
        fundingMethod: "wallet_balance",

        originalPaystackReference: null,
      };
    }

    if (shift.fundingMethod === "paystack_checkout") {
      if (
        fundingTransaction.paymentRail !== "paystack_checkout" ||
        fundingTransaction.provider !== "paystack"
      ) {
        throw ShiftRefundService.createError({
          message:
            "The Paystack-funded Shift does not reference a Paystack Checkout funding transaction.",
          code: "SHIFT_PAYSTACK_FUNDING_TRANSACTION_MISMATCH",
          statusCode: 500,
        });
      }

      const originalPaystackReference = String(
        fundingTransaction.paystackReference || fundingTransaction.metadata?.paystackReference || ""
      ).trim();

      if (!originalPaystackReference) {
        throw ShiftRefundService.createError({
          message: "The original Paystack payment reference is missing.",
          code: "ORIGINAL_PAYSTACK_REFERENCE_MISSING",
          statusCode: 500,
        });
      }

      return {
        fundingMethod: "paystack_checkout",

        originalPaystackReference,
      };
    }

    throw ShiftRefundService.createError({
      message: "The Shift funding method is not supported for employer refunds.",
      code: "UNSUPPORTED_SHIFT_REFUND_FUNDING_METHOD",
      statusCode: 500,
      details: {
        fundingMethod: shift.fundingMethod,
      },
    });
  }

  static assertExistingOwnership({ employerRefund, shift, occurrence }) {
    const valid =
      ShiftRefundService.sameId(employerRefund.shift, shift._id) &&
      ShiftRefundService.sameId(employerRefund.occurrence, occurrence._id) &&
      ShiftRefundService.sameId(employerRefund.business, occurrence.business) &&
      ShiftRefundService.sameId(employerRefund.branch, occurrence.branch) &&
      employerRefund.countryCode === shift.countryCode &&
      employerRefund.currency === shift.currency;

    if (!valid) {
      throw ShiftRefundService.createError({
        message: "The existing employer refund does not belong to this occurrence context.",
        code: "EMPLOYER_REFUND_OWNERSHIP_CONFLICT",
        statusCode: 409,
        details: {
          employerRefundId: String(employerRefund._id),
        },
      });
    }
  }

  static assertExistingFundingSource({ employerRefund, fundingTransaction, fundingSource }) {
    const valid =
      ShiftRefundService.sameId(
        employerRefund.originalFundingTransaction,
        fundingTransaction._id
      ) &&
      employerRefund.fundingMethod === fundingSource.fundingMethod &&
      (employerRefund.originalPaystackReference || null) ===
        (fundingSource.originalPaystackReference || null);

    if (!valid) {
      throw ShiftRefundService.createError({
        message: "The existing employer refund does not match the original Shift funding source.",
        code: "EMPLOYER_REFUND_FUNDING_SOURCE_CONFLICT",
        statusCode: 409,
        details: {
          employerRefundId: String(employerRefund._id),
        },
      });
    }
  }

  static assertMutable(employerRefund) {
    if (!MUTABLE_REFUND_STATUSES.includes(employerRefund.status)) {
      throw ShiftRefundService.createError({
        message:
          `The employer refund can no longer be changed because it is ` +
          `${employerRefund.status}.`,
        code: "EMPLOYER_REFUND_NOT_MUTABLE",
        statusCode: 409,
        details: {
          employerRefundId: String(employerRefund._id),

          employerRefundStatus: employerRefund.status,
        },
      });
    }
  }

  static isExecutionLocked(employerRefund) {
    return EXECUTION_REFUND_STATUSES.includes(employerRefund?.status);
  }

  static getExecutionBoundaryFlags({ employerRefund, authoritativeConflict = false }) {
    const status = String(employerRefund?.status || "")
      .trim()
      .toLowerCase();

    const executionLocked = ShiftRefundService.isExecutionLocked(employerRefund);

    return {
      executionLocked,

      revalidationRequired: Boolean(
        executionLocked && authoritativeConflict && status === "batched"
      ),

      reconciliationRequired: Boolean(
        executionLocked && authoritativeConflict && ["processing", "refunded"].includes(status)
      ),
    };
  }

  /* ─────────────────────────────── STATE HELPERS ─────────────────────────────── */

  static applyCommonMirror({ occurrence, employerRefund, reason, amount, currentTime }) {
    occurrence.refundableAmount = amount;

    occurrence.refundedAmount = 0;

    occurrence.refundReason = reason;

    occurrence.refundLastEvaluatedAt = currentTime;

    occurrence.employerRefund = employerRefund._id;

    occurrence.refundBatch = null;

    occurrence.refundProcessingStartedAt = null;

    occurrence.refundedAt = null;
  }

  static applyHeld({
    employerRefund,
    occurrence,
    holdReason,
    claimId = null,
    disputeId = null,
    currentTime,
  }) {
    const previousEligibleAt = employerRefund.eligibleAt || occurrence.refundEligibleAt || null;

    employerRefund.status = "held";

    employerRefund.claim = holdReason === PROFESSIONAL_CLAIM_HOLD_REASON ? claimId : null;

    employerRefund.dispute = holdReason === EMPLOYER_DISPUTE_HOLD_REASON ? disputeId : null;

    employerRefund.holdReason = holdReason;

    employerRefund.lastEvaluatedAt = currentTime;

    employerRefund.heldAt = currentTime;

    employerRefund.eligibleAt = previousEligibleAt;

    employerRefund.scheduledProcessingAt = null;

    occurrence.refundStatus = "held";

    occurrence.refundHeldAt = currentTime;

    occurrence.refundHoldReason = holdReason;

    occurrence.refundEligibleAt = previousEligibleAt;
  }

  static applyEligible({ employerRefund, occurrence, currentTime, scheduledProcessingAt }) {
    const eligibleAt = employerRefund.eligibleAt
      ? new Date(employerRefund.eligibleAt)
      : occurrence.refundEligibleAt
        ? new Date(occurrence.refundEligibleAt)
        : currentTime;

    if (Number.isNaN(eligibleAt.getTime())) {
      throw ShiftRefundService.createError({
        message: "The employer refund eligibility timestamp is invalid.",
        code: "INVALID_REFUND_ELIGIBLE_AT",
        statusCode: 500,
      });
    }

    employerRefund.status = "eligible";

    employerRefund.claim = null;

    employerRefund.dispute = null;

    employerRefund.holdReason = null;

    employerRefund.lastEvaluatedAt = currentTime;

    employerRefund.heldAt = null;

    employerRefund.eligibleAt = eligibleAt;

    employerRefund.scheduledProcessingAt = ShiftRefundService.normalizeScheduledProcessingAt(
      scheduledProcessingAt || employerRefund.scheduledProcessingAt,
      eligibleAt
    );

    occurrence.refundStatus = "eligible";

    occurrence.refundHeldAt = null;

    occurrence.refundHoldReason = null;

    occurrence.refundEligibleAt = eligibleAt;
  }

  static clearOccurrenceMirror(occurrence) {
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

  static reactivateVoidedRefund({ employerRefund, currentTime }) {
    if (employerRefund.status !== "voided") {
      return employerRefund;
    }

    const hasExecutionHistory = Boolean(
      employerRefund.batch ||
      employerRefund.batchLineId ||
      employerRefund.batchedAt ||
      employerRefund.executionMethod ||
      employerRefund.executionStartedAt ||
      employerRefund.completedTransaction ||
      employerRefund.refundedAt ||
      (Array.isArray(employerRefund.executionTransactions) &&
        employerRefund.executionTransactions.length > 0)
    );

    if (hasExecutionHistory) {
      throw ShiftRefundService.createError({
        message: "A voided employer refund with execution history cannot be reactivated.",
        code: "VOIDED_EMPLOYER_REFUND_EXECUTION_CONFLICT",
        statusCode: 409,
      });
    }

    employerRefund.status = "eligible";

    employerRefund.claim = null;

    employerRefund.dispute = null;

    employerRefund.holdReason = null;

    employerRefund.heldAt = null;

    employerRefund.eligibleAt = null;

    employerRefund.scheduledProcessingAt = null;

    employerRefund.reservationStatus = "reserved";

    employerRefund.reservedAt = currentTime;

    employerRefund.reservationReleasedAt = null;

    employerRefund.voidedAt = null;

    employerRefund.voidedBy = null;

    employerRefund.voidReason = null;

    employerRefund.refundedAmount = 0;

    return employerRefund;
  }

  static buildExecutionLockedResult({
    shift,
    occurrence,
    employerRefund,
    actor,
    expectedRefundAmount,
    expectedReason = null,
    requestedHold = null,
  }) {
    const amountMatches = Number(employerRefund.amount || 0) === Number(expectedRefundAmount || 0);

    const reasonMatches = expectedReason ? employerRefund.reason === expectedReason : true;

    const authoritativeConflict = Boolean(
      requestedHold?.holdReason || !amountMatches || !reasonMatches
    );

    const boundaryFlags = ShiftRefundService.getExecutionBoundaryFlags({
      employerRefund,
      authoritativeConflict,
    });

    return {
      shift,

      occurrence,

      employerRefund,

      created: false,

      idempotent: amountMatches && reasonMatches,

      mutable: false,

      executionLocked: boundaryFlags.executionLocked,

      revalidationRequired: boundaryFlags.revalidationRequired,

      reconciliationRequired: boundaryFlags.reconciliationRequired,

      expectedRefundAmount,

      lockedRefundAmount: Number(employerRefund.amount || 0),

      expectedReason,

      lockedReason: employerRefund.reason || null,

      requestedHoldReason: requestedHold?.holdReason || null,

      actor,
    };
  }

  /* ─────────────────────────────── ENSURE OBLIGATION ─────────────────────────────── */

  static async ensureOccurrenceRefund(
    {
      shift = null,
      occurrence = null,
      shiftId = null,
      occurrenceId = null,

      reason,

      refundableAmount = null,

      holdReason = null,
      claimId = null,
      disputeId = null,

      scheduledProcessingAt = null,

      currentTime = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },

    options = {}
  ) {
    const normalizedCurrentTime = ShiftRefundService.normalizeCurrentTime(currentTime);

    const actor = ShiftRefundService.normalizeInitiatedBy(initiatedBy);

    const normalizedReason = ShiftRefundService.normalizeRefundReason(reason);

    return ShiftRefundService.runWithOptionalTransaction(
      options,

      async (session) => {
        const {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,
        } = await ShiftRefundService.resolveContext({
          shift,
          occurrence,
          shiftId,
          occurrenceId,
          session,
        });

        ShiftRefundService.assertFundedShift(resolvedShift);

        ShiftRefundService.assertReasonMatchesOccurrence({
          shift: resolvedShift,

          occurrence: resolvedOccurrence,

          reason: normalizedReason,
        });

        const amount = ShiftRefundService.resolvePositiveRefundAmount({
          occurrence: resolvedOccurrence,

          refundableAmount,
        });

        if (
          resolvedOccurrence.refundReason &&
          resolvedOccurrence.refundReason !== normalizedReason
        ) {
          throw ShiftRefundService.createError({
            message: "The requested refund reason does not match the occurrence refund reason.",
            code: "OCCURRENCE_REFUND_REASON_MISMATCH",
            statusCode: 409,
            details: {
              occurrenceRefundReason: resolvedOccurrence.refundReason,

              requestedRefundReason: normalizedReason,
            },
          });
        }

        const requestedHold = await ShiftRefundService.resolveRequestedHold({
          occurrence: resolvedOccurrence,

          holdReason,

          claimId,

          disputeId,

          currentTime: normalizedCurrentTime,

          session,
        });

        const fundingTransaction = await ShiftRefundService.getOriginalFundingTransaction(
          resolvedShift,
          session
        );

        const fundingSource = ShiftRefundService.resolveFundingSource({
          shift: resolvedShift,

          fundingTransaction,
        });

        let employerRefund = await ShiftRefundService.getEmployerRefundByOccurrence(
          resolvedOccurrence._id,
          session
        );

        let created = false;

        let idempotent = false;

        let reactivated = false;

        if (employerRefund) {
          ShiftRefundService.assertExistingOwnership({
            employerRefund,

            shift: resolvedShift,

            occurrence: resolvedOccurrence,
          });

          ShiftRefundService.assertExistingFundingSource({
            employerRefund,

            fundingTransaction,

            fundingSource,
          });

          if (ShiftRefundService.isExecutionLocked(employerRefund)) {
            return ShiftRefundService.buildExecutionLockedResult({
              shift: resolvedShift,

              occurrence: resolvedOccurrence,

              employerRefund,

              actor,

              expectedRefundAmount: amount,

              expectedReason: normalizedReason,

              requestedHold,
            });
          }

          if (employerRefund.status === "voided") {
            ShiftRefundService.reactivateVoidedRefund({
              employerRefund,

              currentTime: normalizedCurrentTime,
            });

            reactivated = true;
          } else {
            ShiftRefundService.assertMutable(employerRefund);
          }

          idempotent =
            !reactivated &&
            Number(employerRefund.amount) === amount &&
            employerRefund.reason === normalizedReason &&
            (requestedHold.holdReason
              ? employerRefund.status === "held" &&
                employerRefund.holdReason === requestedHold.holdReason &&
                ShiftRefundService.sameNullableId(employerRefund.claim, requestedHold.claimId) &&
                ShiftRefundService.sameNullableId(employerRefund.dispute, requestedHold.disputeId)
              : employerRefund.status === "eligible");

          employerRefund.amount = amount;

          employerRefund.reason = normalizedReason;

          employerRefund.refundedAmount = 0;

          employerRefund.reservationStatus = "reserved";

          employerRefund.reservationReleasedAt = null;
        } else {
          employerRefund = new EmployerRefund({
            referenceCode: generateReference("LQ-ERF"),

            idempotencyKey: `employer-refund:occurrence:` + `${resolvedOccurrence._id}`,

            shift: resolvedShift._id,

            occurrence: resolvedOccurrence._id,

            business: resolvedOccurrence.business,

            branch: resolvedOccurrence.branch,

            claim: null,

            dispute: null,

            amount,

            refundedAmount: 0,

            countryCode: resolvedShift.countryCode,

            currency: resolvedShift.currency,

            fundingMethod: fundingSource.fundingMethod,

            originalFundingTransaction: fundingTransaction._id,

            originalPaystackReference: fundingSource.originalPaystackReference,

            status: requestedHold.holdReason ? "held" : "eligible",

            reason: normalizedReason,

            holdReason: null,

            lastEvaluatedAt: normalizedCurrentTime,

            heldAt: null,

            eligibleAt: null,

            scheduledProcessingAt: null,

            reservationStatus: "reserved",

            reservedAt: normalizedCurrentTime,

            reservationReleasedAt: null,

            batch: null,

            batchLineId: null,

            batchedAt: null,

            executionMethod: null,

            executionStartedAt: null,

            executionTransactions: [],

            completedTransaction: null,

            refundedAt: null,

            voidedAt: null,

            voidedBy: null,

            voidReason: null,
          });

          created = true;
        }

        ShiftRefundService.applyCommonMirror({
          occurrence: resolvedOccurrence,

          employerRefund,

          reason: normalizedReason,

          amount,

          currentTime: normalizedCurrentTime,
        });

        if (requestedHold.holdReason) {
          ShiftRefundService.applyHeld({
            employerRefund,

            occurrence: resolvedOccurrence,

            holdReason: requestedHold.holdReason,

            claimId: requestedHold.claimId,

            disputeId: requestedHold.disputeId,

            currentTime: normalizedCurrentTime,
          });
        } else {
          ShiftRefundService.applyEligible({
            employerRefund,

            occurrence: resolvedOccurrence,

            currentTime: normalizedCurrentTime,

            scheduledProcessingAt,
          });
        }

        await employerRefund.save({
          session,
        });

        resolvedOccurrence.employerRefund = employerRefund._id;

        await resolvedOccurrence.save({
          session,
        });

        return {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,

          employerRefund,

          created,

          reactivated,

          idempotent: created ? false : idempotent,

          mutable: true,

          executionLocked: false,

          reconciliationRequired: false,

          expectedRefundAmount: amount,

          actor,
        };
      }
    );
  }

  /* ─────────────────────────────── HOLD OBLIGATION ─────────────────────────────── */

  static async holdOccurrenceRefund(
    {
      shift = null,
      occurrence = null,
      shiftId = null,
      occurrenceId = null,

      holdReason,

      claimId = null,
      disputeId = null,

      currentTime = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },

    options = {}
  ) {
    const normalizedCurrentTime = ShiftRefundService.normalizeCurrentTime(currentTime);

    const actor = ShiftRefundService.normalizeInitiatedBy(initiatedBy);

    const normalizedHoldReason = ShiftRefundService.normalizeHoldReason(holdReason, true);

    return ShiftRefundService.runWithOptionalTransaction(
      options,

      async (session) => {
        const {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,
        } = await ShiftRefundService.resolveContext({
          shift,
          occurrence,
          shiftId,
          occurrenceId,
          session,
        });

        const employerRefund = await ShiftRefundService.getEmployerRefundByOccurrence(
          resolvedOccurrence._id,
          session
        );

        if (!employerRefund) {
          throw ShiftRefundService.createError({
            message: "The occurrence does not have an employer refund obligation.",
            code: "EMPLOYER_REFUND_NOT_FOUND",
            statusCode: 404,
          });
        }

        ShiftRefundService.assertExistingOwnership({
          employerRefund,

          shift: resolvedShift,

          occurrence: resolvedOccurrence,
        });

        const requestedHold = await ShiftRefundService.resolveRequestedHold({
          occurrence: resolvedOccurrence,

          holdReason: normalizedHoldReason,

          claimId,

          disputeId,

          currentTime: normalizedCurrentTime,

          session,
        });

        /*
         * A timely challenge must not fail just because refund execution
         * started too early.
         *
         * Do not rewrite the existing execution record here.
         */
        if (ShiftRefundService.isExecutionLocked(employerRefund)) {
          const boundaryFlags = ShiftRefundService.getExecutionBoundaryFlags({
            employerRefund,
            authoritativeConflict: true,
          });

          return {
            shift: resolvedShift,

            occurrence: resolvedOccurrence,

            employerRefund,

            held: false,

            idempotent: false,

            ...boundaryFlags,

            requiredHoldReason: requestedHold.holdReason,

            actor,
          };
        }

        if (employerRefund.status === "voided") {
          throw ShiftRefundService.createError({
            message: "A voided employer refund has no active obligation to hold.",
            code: "VOIDED_EMPLOYER_REFUND_CANNOT_BE_HELD",
            statusCode: 409,
          });
        }

        ShiftRefundService.assertMutable(employerRefund);

        const idempotent =
          employerRefund.status === "held" &&
          employerRefund.holdReason === requestedHold.holdReason &&
          ShiftRefundService.sameNullableId(employerRefund.claim, requestedHold.claimId) &&
          ShiftRefundService.sameNullableId(employerRefund.dispute, requestedHold.disputeId);

        ShiftRefundService.applyCommonMirror({
          occurrence: resolvedOccurrence,

          employerRefund,

          reason: employerRefund.reason,

          amount: employerRefund.amount,

          currentTime: normalizedCurrentTime,
        });

        ShiftRefundService.applyHeld({
          employerRefund,

          occurrence: resolvedOccurrence,

          holdReason: requestedHold.holdReason,

          claimId: requestedHold.claimId,

          disputeId: requestedHold.disputeId,

          currentTime: normalizedCurrentTime,
        });

        await employerRefund.save({
          session,
        });

        await resolvedOccurrence.save({
          session,
        });

        return {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,

          employerRefund,

          held: true,

          idempotent,

          executionLocked: false,

          revalidationRequired: false,

          reconciliationRequired: false,

          actor,
        };
      }
    );
  }

  /* ─────────────────────────────── MAKE ELIGIBLE ─────────────────────────────── */

  static async makeOccurrenceRefundEligible(
    {
      shiftId,
      occurrenceId,

      scheduledProcessingAt = null,

      currentTime = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },

    options = {}
  ) {
    const normalizedCurrentTime = ShiftRefundService.normalizeCurrentTime(currentTime);

    const actor = ShiftRefundService.normalizeInitiatedBy(initiatedBy);

    return ShiftRefundService.runWithOptionalTransaction(
      options,

      async (session) => {
        const { shift, occurrence } = await ShiftRefundService.resolveContext({
          shiftId,

          occurrenceId,

          session,
        });

        const employerRefund = await ShiftRefundService.getEmployerRefundByOccurrence(
          occurrence._id,
          session
        );

        if (!employerRefund) {
          throw ShiftRefundService.createError({
            message: "The occurrence does not have an employer refund obligation.",
            code: "EMPLOYER_REFUND_NOT_FOUND",
            statusCode: 404,
          });
        }

        ShiftRefundService.assertExistingOwnership({
          employerRefund,

          shift,

          occurrence,
        });

        if (ShiftRefundService.isExecutionLocked(employerRefund)) {
          const boundaryFlags = ShiftRefundService.getExecutionBoundaryFlags({
            employerRefund,
            authoritativeConflict: false,
          });

          return {
            shift,

            occurrence,

            employerRefund,

            eligible: false,

            idempotent: false,

            ...boundaryFlags,

            actor,
          };
        }

        if (employerRefund.status === "voided") {
          throw ShiftRefundService.createError({
            message: "A voided employer refund has no positive obligation to make eligible.",
            code: "VOIDED_EMPLOYER_REFUND_NOT_ELIGIBLE",
            statusCode: 409,
          });
        }

        ShiftRefundService.assertMutable(employerRefund);

        /*
         * Never make a stale amount eligible.
         */
        const expectedRefundAmount = ShiftRefundService.calculateExpectedRefundAmount(occurrence);

        if (expectedRefundAmount <= 0) {
          throw ShiftRefundService.createError({
            message: "The occurrence no longer has a positive scheduled/base refund obligation.",
            code: "EMPLOYER_REFUND_NO_LONGER_POSITIVE",
            statusCode: 409,
            details: {
              expectedRefundAmount,
            },
          });
        }

        if (Number(employerRefund.amount || 0) !== expectedRefundAmount) {
          throw ShiftRefundService.createError({
            message:
              "The employer refund amount changed and must be reevaluated before it can become eligible.",
            code: "EMPLOYER_REFUND_REEVALUATION_REQUIRED",
            statusCode: 409,
            details: {
              storedRefundAmount: Number(employerRefund.amount || 0),

              expectedRefundAmount,
            },
          });
        }

        const blockingDependency = await ShiftRefundService.resolveAutomaticHold({
          occurrence,

          currentTime: normalizedCurrentTime,

          session,
        });

        if (blockingDependency.holdReason) {
          throw ShiftRefundService.createError({
            message: "The employer refund still has an unresolved BASE dependency.",
            code: "EMPLOYER_REFUND_DEPENDENCY_UNRESOLVED",
            statusCode: 409,
            details: {
              requiredHoldReason: blockingDependency.holdReason,

              claimId: blockingDependency.claimId ? String(blockingDependency.claimId) : null,

              disputeId: blockingDependency.disputeId ? String(blockingDependency.disputeId) : null,
            },
          });
        }

        const idempotent = employerRefund.status === "eligible";

        ShiftRefundService.applyCommonMirror({
          occurrence,

          employerRefund,

          reason: employerRefund.reason,

          amount: employerRefund.amount,

          currentTime: normalizedCurrentTime,
        });

        ShiftRefundService.applyEligible({
          employerRefund,

          occurrence,

          currentTime: normalizedCurrentTime,

          scheduledProcessingAt,
        });

        await employerRefund.save({
          session,
        });

        await occurrence.save({
          session,
        });

        return {
          shift,

          occurrence,

          employerRefund,

          eligible: true,

          idempotent,

          executionLocked: false,

          reconciliationRequired: false,

          actor,
        };
      }
    );
  }

  /* ─────────────────────────────── REEVALUATE OBLIGATION ─────────────────────────────── */

  static async reevaluateOccurrenceRefund(
    {
      shift = null,
      occurrence = null,
      shiftId = null,
      occurrenceId = null,

      reason = null,

      holdReason = null,
      claimId = null,
      disputeId = null,

      scheduledProcessingAt = null,

      zeroAmountVoidReason = "The occurrence no longer has a refundable scheduled balance.",

      currentTime = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },

    options = {}
  ) {
    const normalizedCurrentTime = ShiftRefundService.normalizeCurrentTime(currentTime);

    const actor = ShiftRefundService.normalizeInitiatedBy(initiatedBy);

    return ShiftRefundService.runWithOptionalTransaction(
      options,

      async (session) => {
        const {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,
        } = await ShiftRefundService.resolveContext({
          shift,
          occurrence,
          shiftId,
          occurrenceId,
          session,
        });

        ShiftRefundService.assertFundedShift(resolvedShift);

        /*
         * THE core calculation:
         *
         * estimatedEmployerCharge
         * - authoritative BASE consumed amount.
         *
         * No overtime field participates here.
         */
        const expectedRefundAmount =
          ShiftRefundService.calculateExpectedRefundAmount(resolvedOccurrence);

        const existingRefund = await ShiftRefundService.getEmployerRefundByOccurrence(
          resolvedOccurrence._id,
          session
        );

        if (expectedRefundAmount === 0) {
          if (!existingRefund) {
            ShiftRefundService.clearOccurrenceMirror(resolvedOccurrence);

            await resolvedOccurrence.save({
              session,
            });

            return {
              shift: resolvedShift,

              occurrence: resolvedOccurrence,

              employerRefund: null,

              voided: false,

              idempotent: true,

              executionLocked: false,

              reconciliationRequired: false,

              expectedRefundAmount: 0,

              actor,
            };
          }

          return ShiftRefundService.voidOccurrenceRefund(
            {
              shift: resolvedShift,

              occurrence: resolvedOccurrence,

              voidReason: zeroAmountVoidReason,

              currentTime: normalizedCurrentTime,

              initiatedBy: actor,
            },

            {
              session,
            }
          );
        }

        const resolvedReason = ShiftRefundService.normalizeRefundReason(
          reason ||
            resolvedOccurrence.refundReason ||
            existingRefund?.reason ||
            ShiftRefundService.deriveRefundReason({
              shift: resolvedShift,

              occurrence: resolvedOccurrence,
            })
        );

        ShiftRefundService.assertReasonMatchesOccurrence({
          shift: resolvedShift,

          occurrence: resolvedOccurrence,

          reason: resolvedReason,
        });

        return ShiftRefundService.ensureOccurrenceRefund(
          {
            shift: resolvedShift,

            occurrence: resolvedOccurrence,

            reason: resolvedReason,

            refundableAmount: expectedRefundAmount,

            holdReason,

            claimId,

            disputeId,

            scheduledProcessingAt,

            currentTime: normalizedCurrentTime,

            initiatedBy: actor,
          },

          {
            session,
          }
        );
      }
    );
  }

  /* ─────────────────────────────── VOID OBLIGATION ─────────────────────────────── */

  static async voidOccurrenceRefund(
    {
      shift = null,
      occurrence = null,
      shiftId = null,
      occurrenceId = null,

      voidReason,

      currentTime = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },

    options = {}
  ) {
    const normalizedCurrentTime = ShiftRefundService.normalizeCurrentTime(currentTime);

    const actor = ShiftRefundService.normalizeInitiatedBy(initiatedBy);

    const normalizedVoidReason = ShiftRefundService.normalizeVoidReason(voidReason);

    return ShiftRefundService.runWithOptionalTransaction(
      options,

      async (session) => {
        const {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,
        } = await ShiftRefundService.resolveContext({
          shift,
          occurrence,
          shiftId,
          occurrenceId,
          session,
        });

        const employerRefund = await ShiftRefundService.getEmployerRefundByOccurrence(
          resolvedOccurrence._id,
          session
        );

        const expectedRefundAmount =
          ShiftRefundService.calculateExpectedRefundAmount(resolvedOccurrence);

        if (expectedRefundAmount !== 0) {
          throw ShiftRefundService.createError({
            message:
              "An employer refund may only be voided after the scheduled/base refundable amount becomes zero.",
            code: "EMPLOYER_REFUND_VOID_AMOUNT_NOT_ZERO",
            statusCode: 409,
            details: {
              expectedRefundAmount,
            },
          });
        }

        if (!employerRefund) {
          ShiftRefundService.clearOccurrenceMirror(resolvedOccurrence);

          await resolvedOccurrence.save({
            session,
          });

          return {
            shift: resolvedShift,

            occurrence: resolvedOccurrence,

            employerRefund: null,

            voided: false,

            idempotent: true,

            executionLocked: false,

            reconciliationRequired: false,

            expectedRefundAmount: 0,

            actor,
          };
        }

        ShiftRefundService.assertExistingOwnership({
          employerRefund,

          shift: resolvedShift,

          occurrence: resolvedOccurrence,
        });

        if (employerRefund.status === "voided") {
          ShiftRefundService.clearOccurrenceMirror(resolvedOccurrence);

          await resolvedOccurrence.save({
            session,
          });

          return {
            shift: resolvedShift,

            occurrence: resolvedOccurrence,

            employerRefund,

            voided: true,

            idempotent: true,

            executionLocked: false,

            reconciliationRequired: false,

            expectedRefundAmount: 0,

            actor,
          };
        }

        /*
         * Do not rewrite money already attached to a batch or execution.
         *
         * The authoritative occurrence outcome still stands. The execution
         * layer must now reconcile what happened financially.
         */
        if (ShiftRefundService.isExecutionLocked(employerRefund)) {
          const boundaryFlags = ShiftRefundService.getExecutionBoundaryFlags({
            employerRefund,
            authoritativeConflict: true,
          });

          return {
            shift: resolvedShift,

            occurrence: resolvedOccurrence,

            employerRefund,

            voided: false,

            idempotent: false,

            ...boundaryFlags,

            expectedRefundAmount: 0,

            lockedRefundAmount: Number(employerRefund.amount || 0),

            actor,
          };
        }

        ShiftRefundService.assertMutable(employerRefund);

        employerRefund.status = "voided";

        employerRefund.claim = null;

        employerRefund.dispute = null;

        employerRefund.holdReason = null;

        employerRefund.lastEvaluatedAt = normalizedCurrentTime;

        employerRefund.heldAt = null;

        employerRefund.eligibleAt = null;

        employerRefund.scheduledProcessingAt = null;

        employerRefund.reservationStatus = "released";

        employerRefund.reservationReleasedAt = normalizedCurrentTime;

        employerRefund.voidedAt = normalizedCurrentTime;

        employerRefund.voidedBy = actor.userId;

        employerRefund.voidReason = normalizedVoidReason;

        await employerRefund.save({
          session,
        });

        ShiftRefundService.clearOccurrenceMirror(resolvedOccurrence);

        await resolvedOccurrence.save({
          session,
        });

        return {
          shift: resolvedShift,

          occurrence: resolvedOccurrence,

          employerRefund,

          voided: true,

          idempotent: false,

          executionLocked: false,

          reconciliationRequired: false,

          expectedRefundAmount: 0,

          actor,
        };
      }
    );
  }

  /* ─────────────────────────────── READ ─────────────────────────────── */

  static async getOccurrenceRefund(
    { shiftId, occurrenceId },

    options = {}
  ) {
    return ShiftRefundService.runWithOptionalTransaction(
      options,

      async (session) => {
        const { shift, occurrence } = await ShiftRefundService.resolveContext({
          shiftId,

          occurrenceId,

          session,
        });

        const employerRefund = await ShiftRefundService.getEmployerRefundByOccurrence(
          occurrence._id,
          session
        );

        return {
          shift,
          occurrence,
          employerRefund,
        };
      }
    );
  }

  /* ─────────────────────────────── REASON-SPECIFIC WRAPPERS ─────────────────────────────── */

  static async ensureExpiredUnfilledOccurrenceRefund(payload, options = {}) {
    return ShiftRefundService.ensureOccurrenceRefund(
      {
        ...payload,

        reason: "expired_unfilled",
      },

      options
    );
  }

  static async ensureUnusedOccurrenceBalanceRefund(payload, options = {}) {
    return ShiftRefundService.ensureOccurrenceRefund(
      {
        ...payload,

        reason: "unused_scheduled_time",
      },

      options
    );
  }

  static async ensureCancelledOccurrenceRefund(payload, options = {}) {
    return ShiftRefundService.ensureOccurrenceRefund(
      {
        ...payload,

        reason: "occurrence_cancelled",
      },

      options
    );
  }

  static async ensureConfirmedNoShowRefund(payload, options = {}) {
    return ShiftRefundService.ensureOccurrenceRefund(
      {
        ...payload,

        reason: "confirmed_no_show",
      },

      options
    );
  }

  static async ensureClosedOccurrenceRefund(payload, options = {}) {
    return ShiftRefundService.ensureOccurrenceRefund(
      {
        ...payload,

        reason: "engagement_closed",
      },

      options
    );
  }
}

module.exports = ShiftRefundService;
