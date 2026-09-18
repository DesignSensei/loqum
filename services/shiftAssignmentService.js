// services/shiftAssignmentService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftAssignment = require("../models/ShiftAssignment");
const ShiftAssignmentCase = require("../models/ShiftAssignmentCase");

const money = require("../utils/money");

const WalletService = require("./walletService");
const ShiftPlatformFeeService = require("./shiftPlatformFeeService");

const { MAX_SHIFT_OCCURRENCES } = require("../constants/shiftPosting");

const {
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_END_REASONS,
  ASSIGNMENT_ACTOR_ROLES,
  CURRENT_ASSIGNMENT_STATUSES,
  REPLACED_ASSIGNMENT_ALLOWED_STATUSES,
  MAX_ASSIGNMENT_END_NOTES_LENGTH,
} = require("../constants/shiftAssignment");

const {
  INITIAL_APPLICATION_PAYMENT_STATUS,
  REPLACEMENT_APPLICATION_PARENT_STATUSES,
  REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES,
  REPLACEMENT_HIRING_STATUSES,
} = require("../constants/shiftApplication");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const {
  normalizeFieldCode,
  normalizeObjectId,
  normalizeOptionalText,
} = require("./helpers/serviceValidationHelpers");

const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const logger = require("../utils/logger");

const SHIFT_ASSIGNMENT_SERVICE_ERROR_NAME = "ShiftAssignmentServiceError";
const MAX_ASSIGNMENT_REFERENCE_NUMBER = 99;
const ASSIGNABLE_OCCURRENCE_REFUND_STATUS = "not_eligible";

const REPLACEMENT_CASE_AUTHORIZING_STATUSES = ["replacement_requested", "resolved_exit"];

const PENDING_SETTLEMENT_STATUSES = [
  "pending_review",
  "awaiting_overtime_review",
  "awaiting_topup",
  "approved_for_release",
  "release_pending",
  "disputed",
];

const TERMINAL_PARENT_STATUSES = ["completed", "cancelled", "no_show"];

const COMPLETED_ASSIGNMENT_PAYMENT_STATUSES = ["released", "partially_refunded"];

const RESOLVED_OCCURRENCE_STATUSES = ["completed", "cancelled", "no_show", "expired_unfilled"];

class ShiftAssignmentService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: SHIFT_ASSIGNMENT_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static error(message, code, statusCode = 400, details = null) {
    return ShiftAssignmentService.createError({
      message,
      code,
      statusCode,
      details,
    });
  }

  static async transaction(options = {}, callback) {
    if (options.session && !options.session.inTransaction()) {
      throw this.error(
        "An active transaction is required for the supplied session.",
        "ASSIGNMENT_TRANSACTION_REQUIRED",
        500
      );
    }
    return runWithOptionalTransaction(options, callback);
  }

  static normalizeFieldCode(value) {
    return normalizeFieldCode(value);
  }

  static objectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,
      fieldName,
      required,
      createError: ShiftAssignmentService.createError,
    });
  }

  static source(value) {
    const normalizedSource = String(value || "application")
      .trim()
      .toLowerCase();

    if (!ASSIGNMENT_SOURCES.includes(normalizedSource)) {
      throw ShiftAssignmentService.createError({
        message: "Assignment source is invalid.",
        code: "INVALID_ASSIGNMENT_SOURCE",
      });
    }

    return normalizedSource;
  }

  static endReason(value) {
    const normalizedReason = String(value || "")
      .trim()
      .toLowerCase();

    if (!ASSIGNMENT_END_REASONS.includes(normalizedReason)) {
      throw ShiftAssignmentService.createError({
        message: "A valid assignment end reason is required.",
        code: "INVALID_ASSIGNMENT_END_REASON",
      });
    }

    return normalizedReason;
  }

  static notes(value) {
    return normalizeOptionalText({
      value,
      fieldName: "Assignment notes",
      maximumLength: MAX_ASSIGNMENT_END_NOTES_LENGTH,
      createError: ShiftAssignmentService.createError,
      emptyValue: null,
    });
  }

  static normalizeActorRole(value, fieldName = "actor role") {
    const role = String(value || "")
      .trim()
      .toLowerCase();

    if (!ASSIGNMENT_ACTOR_ROLES.includes(role)) {
      throw ShiftAssignmentService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return role;
  }

  static normalizeDate(value, fieldName, fallback = null) {
    const sourceValue = value === null || value === undefined || value === "" ? fallback : value;

    const normalizedDate = new Date(sourceValue);

    if (Number.isNaN(normalizedDate.getTime())) {
      throw ShiftAssignmentService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return normalizedDate;
  }

  static normalizeSequenceNumber(value, fieldName) {
    const normalizedValue = Number(value);

    if (
      !Number.isSafeInteger(normalizedValue) ||
      normalizedValue < 1 ||
      normalizedValue > MAX_SHIFT_OCCURRENCES
    ) {
      throw ShiftAssignmentService.createError({
        message: `${fieldName} must be a whole number between 1 and ${MAX_SHIFT_OCCURRENCES}.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return normalizedValue;
  }

  static normalizeAssignmentInput({
    professionalId,
    assignedByUserId,
    applicationId = null,
    source = "application",
  }) {
    const input = {
      professional: ShiftAssignmentService.objectId(professionalId, "professional ID"),

      assignedBy: ShiftAssignmentService.objectId(assignedByUserId, "assigned-by user ID"),

      application: ShiftAssignmentService.objectId(applicationId, "application ID", false),

      source: ShiftAssignmentService.source(source),
    };

    if (input.source === "application" && !input.application) {
      throw ShiftAssignmentService.createError({
        message: "Application ID is required for an application-based assignment.",
        code: "SHIFT_APPLICATION_ID_REQUIRED",
      });
    }

    if (input.source !== "application" && input.application) {
      throw ShiftAssignmentService.createError({
        message: "Only an application-based assignment may reference an application.",
        code: "SHIFT_APPLICATION_NOT_ALLOWED_FOR_SOURCE",
      });
    }

    return input;
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static getShiftFields() {
    return "";
  }

  static getOccurrenceFields() {
    return "";
  }

  static async getShift(shiftId, session = null) {
    const query = Shift.findById(ShiftAssignmentService.objectId(shiftId, "shift ID")).select(
      ShiftAssignmentService.getShiftFields()
    );

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftAssignmentService.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getAssignment({ assignmentId, shiftId = null, session = null, required = true }) {
    const filter = {
      _id: ShiftAssignmentService.objectId(assignmentId, "assignment ID"),
    };

    if (shiftId) {
      filter.shift = ShiftAssignmentService.objectId(shiftId, "shift ID");
    }

    const query = ShiftAssignment.findOne(filter);

    if (session) {
      query.session(session);
    }

    const assignment = await query;

    if (!assignment && required) {
      throw ShiftAssignmentService.createError({
        message: "Shift assignment was not found.",
        code: "SHIFT_ASSIGNMENT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return assignment;
  }

  static async getActiveAssignment({ shiftId, slotNumber, session = null, required = false }) {
    if (!Number.isSafeInteger(slotNumber) || slotNumber < 1) {
      throw this.error(
        "Select a valid slot for the current assignment.",
        "ASSIGNMENT_SLOT_REQUIRED"
      );
    }

    const assignment = await ShiftAssignment.findOne({
      shift: this.objectId(shiftId, "shift ID"),
      slotNumber,
      occurrence: null,
      isCurrentAssignment: true,
      status: { $in: CURRENT_ASSIGNMENT_STATUSES },
    }).session(session);

    if (!assignment && required)
      throw this.error(
        "No current assignment exists in this slot.",
        "CURRENT_SHIFT_ASSIGNMENT_NOT_FOUND",
        404
      );

    return assignment;
  }

  static async getOccurrences(shift, session = null) {
    const occurrences = await ShiftOccurrence.find({ shift: shift._id })
      .sort({ slotNumber: 1, sequenceNumber: 1 })
      .session(session);

    const dates = shift.occurrenceCount;

    const slots = shift.requiredProfessionals;

    if (
      !Number.isSafeInteger(dates) ||
      dates < 1 ||
      dates > MAX_SHIFT_OCCURRENCES ||
      !Number.isSafeInteger(slots) ||
      slots < 1 ||
      !Number.isSafeInteger(dates * slots) ||
      occurrences.length !== dates * slots
    ) {
      throw this.error(
        "The Shift slot/date records are incomplete.",
        "SHIFT_OCCURRENCE_COUNT_MISMATCH",
        409
      );
    }

    occurrences.forEach((occurrence, index) => {
      const expectedSlotNumber = Math.floor(index / dates) + 1;
      const expectedSequenceNumber = (index % dates) + 1;

      if (
        occurrence.slotNumber !== expectedSlotNumber ||
        occurrence.sequenceNumber !== expectedSequenceNumber ||
        String(occurrence.business) !== String(shift.business) ||
        String(occurrence.branch) !== String(shift.branch)
      ) {
        throw this.error(
          "Occurrence identity does not match the Shift slot/date structure.",
          "SHIFT_OCCURRENCE_CONTEXT_MISMATCH",
          409
        );
      }
    });

    return occurrences;
  }

  static async getReplacementCase({
    replacementCaseId,
    shift,
    previousAssignment,
    session = null,
  }) {
    const query = ShiftAssignmentCase.findOne({
      _id: ShiftAssignmentService.objectId(replacementCaseId, "replacement case ID"),

      shift: shift._id,

      assignment: previousAssignment._id,

      business: shift.business,

      branch: shift.branch,

      professional: previousAssignment.professional,

      status: {
        $in: REPLACEMENT_CASE_AUTHORIZING_STATUSES,
      },
    });

    if (session) {
      query.session(session);
    }

    const assignmentCase = await query;

    if (!assignmentCase) {
      throw ShiftAssignmentService.createError({
        message: "The assignment case does not authorize this replacement.",
        code: "REPLACEMENT_ASSIGNMENT_CASE_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    return assignmentCase;
  }

  /* ─────────────────────────────── OCCURRENCE RULES ─────────────────────────────── */

  static isOccurrenceUntouched(occurrence) {
    return Boolean(
      occurrence.status === "scheduled" &&
      occurrence.attendanceStatus === "not_started" &&
      occurrence.settlementStatus === "not_due" &&
      !occurrence.checkedInAt &&
      !occurrence.checkedOutAt &&
      !occurrence.checkInPinUsedAt &&
      !occurrence.checkOutPinUsedAt
    );
  }

  static refundWorkflowHasNotStarted(occurrence) {
    return Boolean(
      occurrence.refundStatus === ASSIGNABLE_OCCURRENCE_REFUND_STATUS &&
      Number(occurrence.refundableAmount || 0) === 0 &&
      Number(occurrence.refundedAmount || 0) === 0 &&
      !occurrence.refundEligibleAt &&
      !occurrence.refundedAt &&
      !occurrence.employerRefund &&
      !occurrence.refundBatch &&
      !occurrence.expiredUnfilledAt
    );
  }

  static isInitialOccurrenceEligible(occurrence, assignedAt) {
    return Boolean(
      ShiftAssignmentService.isOccurrenceUntouched(occurrence) &&
      ShiftAssignmentService.refundWorkflowHasNotStarted(occurrence) &&
      occurrence.assignmentStatus === "unassigned" &&
      !occurrence.assignedProfessional &&
      !occurrence.assignment &&
      !occurrence.assignedAt &&
      occurrence.fillCutoffAt &&
      new Date(occurrence.fillCutoffAt) > assignedAt &&
      new Date(occurrence.endTime) > assignedAt
    );
  }

  static isReplacementOccurrenceEligible({
    occurrence,
    previousAssignment,
    replacementCase = null,
    occurrenceTargetId = null,
    replacementRequiredAt = null,
    assignedAt,
  }) {
    const isOccurrenceTargeted = Boolean(occurrenceTargetId);

    if (
      !ShiftAssignmentService.isOccurrenceUntouched(occurrence) ||
      !ShiftAssignmentService.refundWorkflowHasNotStarted(occurrence) ||
      occurrence.assignmentStatus !== "replacement_required" ||
      occurrence.assignedProfessional ||
      occurrence.assignment ||
      occurrence.assignedAt ||
      occurrence.slotNumber !== previousAssignment.slotNumber ||
      !occurrence.fillCutoffAt ||
      !occurrence.replacementRequiredAt ||
      !occurrence.replacementForAssignment ||
      String(occurrence.replacementForAssignment) !== String(previousAssignment._id) ||
      new Date(occurrence.endTime) <= assignedAt
    ) {
      return false;
    }

    if (occurrence.fillCutoffAt && new Date(occurrence.fillCutoffAt) <= assignedAt) {
      return false;
    }

    if (
      occurrence.unfilledFinalizationAt &&
      new Date(occurrence.unfilledFinalizationAt) <= assignedAt
    ) {
      return false;
    }

    if (isOccurrenceTargeted) {
      if (String(occurrence._id) !== String(occurrenceTargetId)) {
        return false;
      }

      if (
        replacementRequiredAt &&
        String(new Date(occurrence.replacementRequiredAt).getTime()) !==
          String(new Date(replacementRequiredAt).getTime())
      ) {
        return false;
      }

      const occurrenceReplacementCase = occurrence.replacementCase
        ? String(occurrence.replacementCase)
        : null;

      const expectedReplacementCase = replacementCase ? String(replacementCase._id) : null;

      return occurrenceReplacementCase === expectedReplacementCase;
    }

    return Boolean(
      replacementCase &&
      occurrence.replacementCase &&
      String(occurrence.replacementCase) === String(replacementCase._id)
    );
  }

  static assertContiguous(occurrences, emptyCode) {
    if (!Array.isArray(occurrences) || occurrences.length === 0) {
      throw ShiftAssignmentService.createError({
        message: "No eligible occurrences were found.",
        code: emptyCode,
        statusCode: 409,
      });
    }

    for (let index = 1; index < occurrences.length; index += 1) {
      if (occurrences[index].sequenceNumber !== occurrences[index - 1].sequenceNumber + 1) {
        throw ShiftAssignmentService.createError({
          message: "Eligible occurrences do not form one continuous range.",
          code: "NON_CONTIGUOUS_ASSIGNMENT_RANGE",
          statusCode: 409,
        });
      }
    }
  }

  static assertExactSequenceRange({
    occurrences,
    startSequenceNumber,
    endSequenceNumber,
    expectedOccurrenceCount = null,
  }) {
    ShiftAssignmentService.assertContiguous(occurrences, "ASSIGNMENT_OCCURRENCES_REQUIRED");

    const expectedCount = endSequenceNumber - startSequenceNumber + 1;

    const actualStart = occurrences[0]?.sequenceNumber || null;

    const actualEnd = occurrences[occurrences.length - 1]?.sequenceNumber || null;

    if (
      actualStart !== startSequenceNumber ||
      actualEnd !== endSequenceNumber ||
      occurrences.length !== expectedCount
    ) {
      throw ShiftAssignmentService.createError({
        message: "The available occurrences no longer match the requested assignment range.",
        code: "ASSIGNMENT_RANGE_MISMATCH",
        statusCode: 409,
        details: {
          requestedStartSequenceNumber: startSequenceNumber,
          requestedEndSequenceNumber: endSequenceNumber,
          requestedOccurrenceCount: expectedCount,
          actualStartSequenceNumber: actualStart,
          actualEndSequenceNumber: actualEnd,
          actualOccurrenceCount: occurrences.length,
        },
      });
    }

    if (
      expectedOccurrenceCount !== null &&
      expectedOccurrenceCount !== undefined &&
      Number(expectedOccurrenceCount) !== expectedCount
    ) {
      throw ShiftAssignmentService.createError({
        message: "The parent replacement occurrence summary is stale.",
        code: "REPLACEMENT_OCCURRENCE_SUMMARY_STALE",
        statusCode: 409,
        details: {
          expectedOccurrenceCount: Number(expectedOccurrenceCount),
          requestedOccurrenceCount: expectedCount,
        },
      });
    }
  }

  static rangeFromOccurrences(occurrences) {
    ShiftAssignmentService.assertContiguous(occurrences, "ASSIGNMENT_OCCURRENCES_REQUIRED");

    return {
      startSequence: occurrences[0].sequenceNumber,

      plannedEndSequence: occurrences[occurrences.length - 1].sequenceNumber,

      plannedOccurrenceCount: occurrences.length,

      startsAt: occurrences[0].startTime,

      plannedEndsAt: occurrences[occurrences.length - 1].endTime,
    };
  }

  /* ─────────────────────────────── PROTECTED FUNDING ─────────────────────────────── */

  static normalizeMinorUnitAmount(value, fieldName) {
    const amount = Number(value || 0);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw ShiftAssignmentService.createError({
        message: `${fieldName} must be a non-negative whole-number minor-unit amount.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return amount;
  }

  static getOccurrenceBaseProfessionalEntitlement(occurrence) {
    if (occurrence.status === "no_show" || occurrence.status === "expired_unfilled") {
      return 0;
    }

    if (occurrence.activeWorkCancellation?.occurred === true) {
      return ShiftAssignmentService.normalizeMinorUnitAmount(
        occurrence.activeWorkCancellation.professionalPay,
        "active-work cancellation professional pay"
      );
    }

    if (occurrence.cancellationCompensation?.applicable === true) {
      return ShiftAssignmentService.normalizeMinorUnitAmount(
        occurrence.cancellationCompensation.professionalPay,
        "cancellation compensation professional pay"
      );
    }

    if (occurrence.status === "cancelled") {
      return 0;
    }

    const baseProfessionalPay = ShiftAssignmentService.normalizeMinorUnitAmount(
      occurrence.baseProfessionalPay,
      "occurrence base professional pay"
    );

    if (baseProfessionalPay > 0) {
      return baseProfessionalPay;
    }

    if (
      occurrence.status === "scheduled" &&
      ["unassigned", "assigned", "replacement_required"].includes(occurrence.assignmentStatus)
    ) {
      return ShiftAssignmentService.normalizeMinorUnitAmount(
        occurrence.estimatedProfessionalPay,
        "occurrence estimated professional pay"
      );
    }

    return 0;
  }

  static getOccurrenceOutstandingProtectedLiability(occurrence) {
    const baseSettlementStatus = occurrence.baseSettlement?.status || "not_due";

    const overtimeSettlementStatus = occurrence.overtimeSettlement?.status || "not_due";

    const baseProfessionalLiability =
      baseSettlementStatus === "released"
        ? 0
        : ShiftAssignmentService.getOccurrenceBaseProfessionalEntitlement(occurrence);

    const baseFeeAudit = occurrence.basePlatformFeeAudit || {};

    const estimatedPlatformFee = ShiftAssignmentService.normalizeMinorUnitAmount(
      occurrence.estimatedPlatformFee,
      "occurrence estimated platform fee"
    );

    let basePlatformFeeLiability = 0;

    if (!baseFeeAudit.earnedAt) {
      if (occurrence.status === "scheduled" && occurrence.assignmentStatus === "unassigned") {
        /*
         * Before first confirmation, the scheduled fee is still protected in
         * escrow and must be available for the assignment event.
         */
        basePlatformFeeLiability = estimatedPlatformFee;
      } else if (
        estimatedPlatformFee > 0 &&
        ["assigned", "replacement_required"].includes(occurrence.assignmentStatus)
      ) {
        throw ShiftAssignmentService.createError({
          message:
            "An occurrence with assignment history is missing its base platform-fee earning audit.",
          code: "ASSIGNED_OCCURRENCE_BASE_FEE_AUDIT_MISSING",
          statusCode: 500,
          details: {
            occurrenceId: String(occurrence._id),
            assignmentStatus: occurrence.assignmentStatus,
            occurrenceStatus: occurrence.status,
          },
        });
      }
    } else if (!baseFeeAudit.collectedAt) {
      basePlatformFeeLiability = ShiftAssignmentService.normalizeMinorUnitAmount(
        occurrence.basePlatformFee,
        "occurrence earned base platform fee"
      );
    }

    const refundableAmount = ShiftAssignmentService.normalizeMinorUnitAmount(
      occurrence.refundableAmount,
      "occurrence refundable amount"
    );

    const refundedAmount = ShiftAssignmentService.normalizeMinorUnitAmount(
      occurrence.refundedAmount,
      "occurrence refunded amount"
    );

    const refundLiability = Math.max(refundableAmount - refundedAmount, 0);

    const overtime = occurrence.overtime || {};

    const overtimeProfessionalLiability =
      overtime.requested === true &&
      overtime.status === "approved" &&
      overtime.topUpPaid === true &&
      overtimeSettlementStatus !== "released"
        ? ShiftAssignmentService.normalizeMinorUnitAmount(
            occurrence.overtimeProfessionalPay,
            "occurrence overtime professional pay"
          )
        : 0;

    const overtimeFeeAudit = occurrence.overtimePlatformFeeAudit || {};

    const overtimePlatformFeeLiability =
      overtime.requested === true &&
      overtime.status === "approved" &&
      overtime.topUpPaid === true &&
      overtimeFeeAudit.earnedAt &&
      !overtimeFeeAudit.collectedAt
        ? ShiftAssignmentService.normalizeMinorUnitAmount(
            occurrence.overtimePlatformFee,
            "occurrence earned overtime platform fee"
          )
        : 0;

    const protectedLiability =
      baseProfessionalLiability +
      basePlatformFeeLiability +
      refundLiability +
      overtimeProfessionalLiability +
      overtimePlatformFeeLiability;

    if (!Number.isSafeInteger(protectedLiability) || protectedLiability < 0) {
      throw ShiftAssignmentService.createError({
        message: "The occurrence protected liability is invalid.",
        code: "INVALID_OCCURRENCE_PROTECTED_LIABILITY",
        statusCode: 500,
        details: {
          occurrenceId: String(occurrence._id),
          baseProfessionalLiability,
          basePlatformFeeLiability,
          refundLiability,
          overtimeProfessionalLiability,
          overtimePlatformFeeLiability,
        },
      });
    }

    return protectedLiability;
  }

  static getParentProtectedBalance(shift) {
    const fundedAmount = ShiftAssignmentService.normalizeMinorUnitAmount(
      shift.fundedAmount,
      "funded amount"
    );

    const releasedProfessionalPay = ShiftAssignmentService.normalizeMinorUnitAmount(
      shift.settlementSummary?.releasedProfessionalPay,
      "released professional pay"
    );

    const collectedPlatformFee = ShiftAssignmentService.normalizeMinorUnitAmount(
      shift.settlementSummary?.collectedPlatformFee,
      "collected platform fee"
    );

    const refundedAmount = ShiftAssignmentService.normalizeMinorUnitAmount(
      shift.refundedAmount,
      "refunded amount"
    );

    const movedProtectedAmount = releasedProfessionalPay + collectedPlatformFee + refundedAmount;

    if (!Number.isSafeInteger(movedProtectedAmount)) {
      throw ShiftAssignmentService.createError({
        message: "The engagement completed protected-fund movement is too large.",
        code: "SHIFT_PROTECTED_MOVEMENT_TOO_LARGE",
        statusCode: 500,
        details: {
          releasedProfessionalPay,
          collectedPlatformFee,
          refundedAmount,
        },
      });
    }

    const protectedBalance = fundedAmount - movedProtectedAmount;

    if (protectedBalance < 0) {
      throw ShiftAssignmentService.createError({
        message: "The engagement protected-funding balance is inconsistent.",
        code: "INVALID_SHIFT_PROTECTED_BALANCE",
        statusCode: 500,
        details: {
          fundedAmount,
          releasedProfessionalPay,
          collectedPlatformFee,
          refundedAmount,
          movedProtectedAmount,
        },
      });
    }

    return protectedBalance;
  }

  static assertShiftProtectedLiabilityCovered({ shift, occurrences }) {
    const requiredProtectedAmount = occurrences.reduce(
      (total, occurrence) =>
        total + ShiftAssignmentService.getOccurrenceOutstandingProtectedLiability(occurrence),
      0
    );

    if (!Number.isSafeInteger(requiredProtectedAmount) || requiredProtectedAmount <= 0) {
      throw ShiftAssignmentService.createError({
        message: "The engagement does not contain a valid protected liability for assignment.",
        code: "INVALID_ASSIGNMENT_PROTECTED_LIABILITY",
        statusCode: 500,
      });
    }

    const parentProtectedBalance = ShiftAssignmentService.getParentProtectedBalance(shift);

    if (parentProtectedBalance < requiredProtectedAmount) {
      throw ShiftAssignmentService.createError({
        message:
          "The engagement does not have enough protected funding for its remaining occurrence liabilities.",
        code: "SHIFT_PROTECTED_FUNDING_INSUFFICIENT",
        statusCode: 409,
        details: {
          requiredProtectedAmount,
          parentProtectedBalance,
        },
      });
    }

    return {
      requiredProtectedAmount,
      parentProtectedBalance,
    };
  }

  static async assertEscrowWalletOperationalCoverage({ shift, requiredProtectedAmount, session }) {
    const escrowWallet = await WalletService.getEscrowWallet(
      {
        countryCode: shift.countryCode,
        currency: shift.currency,
      },
      {
        session,
      }
    );

    if (!escrowWallet) {
      throw ShiftAssignmentService.createError({
        message: "The protected-funds wallet was not found.",
        code: "ESCROW_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    if (escrowWallet.status !== "active") {
      throw ShiftAssignmentService.createError({
        message: "The protected-funds wallet is not active.",
        code: "ESCROW_WALLET_NOT_ACTIVE",
        statusCode: 409,
      });
    }

    const escrowAvailableBalance = ShiftAssignmentService.normalizeMinorUnitAmount(
      escrowWallet.availableBalance,
      "escrow available balance"
    );

    if (escrowAvailableBalance < requiredProtectedAmount) {
      throw ShiftAssignmentService.createError({
        message:
          "The protected-funds wallet cannot currently cover this engagement's remaining liabilities.",
        code: "ESCROW_BALANCE_INSUFFICIENT_FOR_ASSIGNMENT",
        statusCode: 409,
        details: {
          requiredProtectedAmount,
          escrowAvailableBalance,
        },
      });
    }

    return {
      escrowWallet,
      escrowAvailableBalance,
    };
  }

  /* ─────────────────────────────── ASSIGNMENT WRITES ─────────────────────────────── */

  static async nextIdentity(shift, session) {
    const id = new mongoose.Types.ObjectId();
    return { id, referenceCode: `${shift.referenceCode}-A${String(id).toUpperCase()}` };
  }

  static resolveNewAssignmentStatus({ range, assignedAt, outgoingRemainsCurrent = false }) {
    if (outgoingRemainsCurrent) {
      return "scheduled";
    }

    return new Date(range.startsAt) <= assignedAt ? "active" : "scheduled";
  }

  static async createRecord({
    shift,
    input,
    assignmentType,
    range,
    assignedAt,
    status,
    occurrence = null,
    replacesAssignment = null,
    replacementCase = null,
    session,
  }) {
    const identity = await ShiftAssignmentService.nextIdentity(shift, session);

    const assignment = new ShiftAssignment({
      _id: identity.id,

      referenceCode: identity.referenceCode,

      shift: shift._id,

      slotNumber: input.slotNumber,

      business: shift.business,

      branch: shift.branch,

      professional: input.professional,

      assignmentType,

      source: input.source,

      application: input.application,

      occurrence,

      replacesAssignment,

      replacedByAssignment: null,

      replacementCase,

      ...range,

      status,

      assignedAt,

      assignedBy: input.assignedBy,

      activatedAt: status === "active" ? assignedAt : null,

      activatedBy: status === "active" ? input.assignedBy : null,
    });

    await assignment.save({
      session,
    });

    return assignment;
  }

  static buildOccurrenceAssignmentFilter({
    shift,
    occurrences,
    expectedAssignmentStatus,
    assignedAt,
    previousAssignment = null,
    replacementCase = null,
    occurrenceTarget = null,
  }) {
    const filter = {
      _id: {
        $in: occurrences.map((occurrence) => occurrence._id),
      },

      shift: shift._id,
      slotNumber: occurrences[0].slotNumber,
      fillCutoffAt: { $gt: assignedAt },

      status: "scheduled",

      attendanceStatus: "not_started",

      settlementStatus: "not_due",

      refundStatus: ASSIGNABLE_OCCURRENCE_REFUND_STATUS,

      assignmentStatus: expectedAssignmentStatus,

      assignedProfessional: null,

      assignment: null,

      assignedAt: null,

      checkedInAt: null,

      checkedOutAt: null,

      checkInPinUsedAt: null,

      checkOutPinUsedAt: null,

      refundEligibleAt: null,

      refundedAt: null,

      employerRefund: null,
      refundBatch: null,

      expiredUnfilledAt: null,

      refundableAmount: 0,

      refundedAmount: 0,

      endTime: {
        $gt: assignedAt,
      },
    };

    if (previousAssignment) {
      filter.replacementForAssignment = previousAssignment._id;
    }

    if (occurrenceTarget) {
      /*
       * Isolated replacement:
       *
       * Protect against a stale acceptance from a previous release cycle.
       */
      filter.replacementRequiredAt = occurrenceTarget.replacementRequiredAt;

      filter.replacementCase = occurrenceTarget.replacementCase || null;

      if (occurrenceTarget.fillCutoffAt) {
        filter.fillCutoffAt = {
          $gt: assignedAt,
        };
      }
    } else if (replacementCase) {
      /*
       * Existing tail replacement.
       */
      filter.replacementCase = replacementCase._id;
    }

    return filter;
  }

  static async assignOccurrences({
    shift,
    occurrences,
    input,
    assignment,
    assignedAt,
    expectedAssignmentStatus,
    previousAssignment = null,
    replacementCase = null,
    occurrenceTarget = null,
    session,
  }) {
    const result = await ShiftOccurrence.updateMany(
      ShiftAssignmentService.buildOccurrenceAssignmentFilter({
        shift,

        occurrences,

        expectedAssignmentStatus,

        assignedAt,

        previousAssignment,

        replacementCase,

        occurrenceTarget,
      }),
      {
        $set: {
          assignmentStatus: "assigned",

          assignedProfessional: input.professional,

          assignment: assignment._id,

          assignedAt,

          unfilledFinalizationAt: null,
        },
      },
      {
        session,

        runValidators: true,
      }
    );

    if (result.modifiedCount !== occurrences.length) {
      throw ShiftAssignmentService.createError({
        message: "The occurrence assignment changed before completion.",

        code: "ASSIGNMENT_OCCURRENCE_UPDATE_CONFLICT",

        statusCode: 409,

        details: {
          expected: occurrences.length,

          modified: result.modifiedCount,
        },
      });
    }
  }

  static async earnBasePlatformFeesForOccurrences({ occurrences, assignedAt, session }) {
    if (!Array.isArray(occurrences) || occurrences.length === 0) {
      throw ShiftAssignmentService.createError({
        message: "At least one assigned occurrence is required for platform-fee earning.",
        code: "PLATFORM_FEE_OCCURRENCES_REQUIRED",
        statusCode: 500,
      });
    }

    const results = [];

    /*
     * Process sequentially because every occurrence fee moves money between the
     * same escrow and platform wallets inside one MongoDB transaction.
     *
     * Initial assignment:
     * → each newly confirmed occurrence earns its base fee now.
     *
     * Replacement:
     * → the same call is intentionally repeated.
     * → ShiftPlatformFeeService is idempotent when that occurrence already
     *   earned its fee under the first confirmed assignment.
     * → therefore a replacement never creates a second base fee.
     */
    for (const occurrence of occurrences) {
      const result = await ShiftPlatformFeeService.earnBasePlatformFee(
        {
          occurrenceId: occurrence._id,

          earnedAt: assignedAt,

          initiatedBy: {
            role: "system",
            userId: null,
          },
        },
        {
          session,
        }
      );

      results.push(result);
    }

    return {
      occurrenceCount: results.length,

      processedFeeAmount: results.reduce(
        (total, result) => total + Number(result?.feeAmount || 0),
        0
      ),

      newlyCollectedFeeAmount: results
        .filter((result) => result?.collected === true && result?.idempotent !== true)
        .reduce((total, result) => total + Number(result?.feeAmount || 0), 0),

      newlyCollectedOccurrenceCount: results.filter(
        (result) => result?.collected === true && result?.idempotent !== true
      ).length,

      idempotentOccurrenceCount: results.filter((result) => result?.idempotent === true).length,

      results,
    };
  }

  static async refreshAssignmentProgress({ shift, session, currentTime }) {
    const occurrences = await this.getOccurrences(shift, session);
    const assignments = await ShiftAssignment.find({ shift: shift._id }).session(session);
    const progress = {};
    const mappings = [
      [
        "assignmentStatus",
        {
          unassigned: "unassigned",
          assigned: "assigned",
          replacement_required: "replacementRequired",
          expired_unfilled: "expiredUnfilled",
        },
      ],
      [
        "status",
        {
          scheduled: "scheduled",
          in_progress: "inProgress",
          pending_settlement: "pendingSettlement",
          completed: "completed",
          cancelled: "cancelled",
          no_show: "noShow",
          disputed: "disputed",
          expired_unfilled: "expiredUnfilled",
        },
      ],
      [
        "settlementStatus",
        {
          not_due: "settlementNotDue",
          pending_review: "pendingReview",
          awaiting_overtime_review: "awaitingOvertimeReview",
          awaiting_topup: "awaitingTopup",
          approved_for_release: "approvedForRelease",
          release_pending: "releasePending",
          released: "released",
          disputed: "settlementDisputed",
        },
      ],
      [
        "refundStatus",
        {
          not_eligible: "refundNotEligible",
          held: "refundHeld",
          eligible: "refundEligible",
          batched: "refundBatched",
          processing: "refundProcessing",
          refunded: "refunded",
        },
      ],
    ];
    for (const [field, names] of mappings) {
      for (const [value, key] of Object.entries(names))
        progress[key] = occurrences.filter((o) => o[field] === value).length;
    }
    progress.failed = 0;
    progress.resolved = occurrences.filter((o) =>
      this.isOccurrenceFinalForIsolatedAssignmentClose(o)
    ).length;
    progress.lastReconciledAt = currentTime;
    shift.occurrenceProgress = progress;
    shift.assignmentSummary = Object.fromEntries(
      ["scheduled", "active", "ending", "ended", "cancelled"].map((status) => [
        status,
        assignments.filter((a) => a.status === status).length,
      ])
    );
    shift.assignmentSummary.lastReconciledAt = currentTime;
    // Count distinct opportunities, not dates or every historical case.
    const opportunities = new Set(
      occurrences
        .filter(
          (o) =>
            o.assignmentStatus === "replacement_required" &&
            o.status === "scheduled" &&
            o.fillCutoffAt > currentTime &&
            o.refundStatus === "not_eligible"
        )
        .map((o) =>
          o.replacementCase
            ? `case:${o.replacementCase}:assignment:${o.replacementForAssignment}`
            : `occurrence:${o._id}:assignment:${o.replacementForAssignment}`
        )
    );
    shift.hiringSummary = {
      initialAcceptedCount: assignments.filter(
        (a) => a.assignmentType === "initial" && a.application
      ).length,
      openReplacementCount: opportunities.size,
      lastReconciledAt: currentTime,
    };
    const sum = (values) => money.sumMinorUnitAmounts(values, "Shift assignment reconciliation");
    const components = occurrences
      .flatMap((o) => [o.baseSettlement, o.overtimeSettlement])
      .filter(Boolean);
    const audits = occurrences
      .flatMap((o) => [o.basePlatformFeeAudit, o.overtimePlatformFeeAudit])
      .filter(Boolean);
    const latest = (values) =>
      values.filter(Boolean).reduce((last, date) => (!last || date > last ? date : last), null);
    const approved = sum(components.map((c) => (c.status === "not_due" ? 0 : c.professionalPay)));
    const released = sum(components.map((c) => (c.status === "released" ? c.professionalPay : 0)));
    const earned = sum(
      occurrences.flatMap((o) => [o.basePlatformFee || 0, o.overtimePlatformFee || 0])
    );
    const collected = sum(
      occurrences.flatMap((o) => [
        o.basePlatformFeeAudit?.collectedAt ? o.basePlatformFee : 0,
        o.overtimePlatformFeeAudit?.collectedAt ? o.overtimePlatformFee : 0,
      ])
    );
    shift.settlementSummary = {
      approvedProfessionalPay: approved,
      releasedProfessionalPay: released,
      earnedPlatformFee: earned,
      collectedPlatformFee: collected,
      committedEmployerCharge: sum([approved, earned]),
      lastProfessionalApprovedAt: latest(components.map((c) => c.approvedForReleaseAt)),
      lastProfessionalReleasedAt: latest(components.map((c) => c.releasedAt)),
      lastPlatformFeeEarnedAt: latest(audits.map((a) => a.earnedAt)),
      lastPlatformFeeCollectedAt: latest(audits.map((a) => a.collectedAt)),
      lastReconciledAt: currentTime,
    };
    shift.refundedAmount = sum(occurrences.map((o) => o.refundedAmount || 0));
    shift.topUpRequired = sum(occurrences.map((o) => o.topUpRequired || 0));
    shift.status = this.determineParentOperationalStatus({ shift, occurrences, currentTime });
    return occurrences;
  }

  static determineParentOperationalStatus({ shift, occurrences, currentTime }) {
    if (["pending_funding", "cancelled", "completed"].includes(shift.status)) return shift.status;
    if (occurrences.some((o) => o.status === "in_progress")) return "in_progress";
    if (
      occurrences.some(
        (o) =>
          o.assignmentStatus === "unassigned" &&
          o.status === "scheduled" &&
          o.fillCutoffAt > currentTime
      )
    )
      return "open";
    if (
      occurrences.some((o) => o.activeClaim || o.activeDispute || o.settlementStatus === "disputed")
    )
      return "disputed";
    if (occurrences.some((o) => o.status === "scheduled" && o.endTime > currentTime)) {
      return shift.assignmentSummary.scheduled +
        shift.assignmentSummary.active +
        shift.assignmentSummary.ending >
        0 || shift.hiringSummary.openReplacementCount > 0
        ? "confirmed"
        : "pending_settlement";
    }
    // Financial completion belongs to final reconciliation, not assignment closure.
    return "pending_settlement";
  }

  static setParentAssignmentSummary() {
    throw this.error(
      "Use occurrence and assignment reconciliation for parent summaries.",
      "PARENT_SINGLE_ASSIGNMENT_SUMMARY_REMOVED",
      500
    );
  }

  static async finalizeEndingAssignmentIfDue({ assignment, currentTime, session }) {
    if (assignment.status !== "ending") {
      return false;
    }

    if (!assignment.effectiveEndsAt || new Date(assignment.effectiveEndsAt) > currentTime) {
      return false;
    }

    assignment.status = "ended";

    assignment.endedAt = currentTime;

    assignment.endedBy = assignment.endingConfirmedBy || null;

    assignment.endedByRole = assignment.endingConfirmedByRole || "system";

    await assignment.save({
      session,
    });

    return true;
  }

  static async finalizeReplacementCase({ assignmentCase, assignedAt, session }) {
    if (assignmentCase.status === "resolved_exit") {
      return false;
    }

    if (assignmentCase.status !== "replacement_requested") {
      throw ShiftAssignmentService.createError({
        message: "The assignment case cannot be resolved by replacement acceptance.",
        code: "REPLACEMENT_CASE_RESOLUTION_NOT_ALLOWED",
        statusCode: 409,
        details: {
          status: assignmentCase.status,
        },
      });
    }

    const exitRange = assignmentCase.exitProposal?.range;

    if (
      !exitRange?.replacementStartSequenceNumber ||
      !exitRange?.replacementEndSequenceNumber ||
      !exitRange?.replacementOccurrenceCount
    ) {
      throw ShiftAssignmentService.createError({
        message: "The assignment case does not contain a complete confirmed exit range.",
        code: "REPLACEMENT_CASE_EXIT_RANGE_INCOMPLETE",
        statusCode: 409,
      });
    }

    assignmentCase.status = "resolved_exit";

    assignmentCase.isOpen = false;

    assignmentCase.resolution.outcome = assignmentCase.resolution?.outcome || "exit_confirmed";

    assignmentCase.resolution.reason =
      assignmentCase.resolution?.reason ||
      "The confirmed exit was completed when a replacement assignment was accepted.";

    assignmentCase.resolution.effectiveExitRange = {
      lastWorkingSequenceNumber: exitRange.lastWorkingSequenceNumber ?? null,

      replacementStartSequenceNumber: exitRange.replacementStartSequenceNumber,

      replacementEndSequenceNumber: exitRange.replacementEndSequenceNumber,

      replacementOccurrenceCount: exitRange.replacementOccurrenceCount,
    };

    assignmentCase.resolution.resolvedAt = assignedAt;

    assignmentCase.resolution.resolvedBy = null;

    assignmentCase.resolution.resolvedByRole = "system";

    await assignmentCase.save({
      session,
    });

    return true;
  }

  /* ─────────────────────────────── INITIAL ASSIGNMENT ─────────────────────────────── */

  static async lockShiftAndProfessional({ shiftId, professionalId = null, session }) {
    const shift = await Shift.findOneAndUpdate(
      { _id: this.objectId(shiftId, "shift ID") },
      { $inc: { __v: 1 } },
      { new: true, session }
    );
    if (!shift) throw this.error("Shift was not found.", "SHIFT_NOT_FOUND", 404);
    if (professionalId) {
      const professional = await ProfessionalProfile.findOneAndUpdate(
        { _id: professionalId },
        { $inc: { __v: 1 } },
        { new: true, session }
      );
      if (!professional)
        throw this.error("Professional was not found.", "PROFESSIONAL_PROFILE_NOT_FOUND", 404);
    }
    return shift;
  }

  static async assertNoOverlap({ professionalId, occurrences, session }) {
    const conflict = await ShiftOccurrence.findOne({
      assignedProfessional: professionalId,
      assignmentStatus: "assigned",
      status: { $in: ["scheduled", "in_progress", "pending_settlement", "disputed"] },
      $or: occurrences.map((o) => ({
        startTime: { $lt: o.endTime },
        endTime: { $gt: o.startTime },
      })),
    }).session(session);
    if (conflict)
      throw this.error(
        "The professional already has overlapping assigned work.",
        "PROFESSIONAL_SHIFT_SCHEDULE_CONFLICT",
        409
      );
  }

  static async assertApplicationMatches({
    shift,
    input,
    assignmentType,
    previous = null,
    occurrence = null,
    session,
  }) {
    if (!input.application) return;
    const ShiftApplication = require("../models/ShiftApplication");
    const application = await ShiftApplication.findOne({
      _id: input.application,
      shift: shift._id,
      professional: input.professional,
      applicationType: assignmentType,
      status: { $in: ["pending", "shortlisted"] },
      occurrence: occurrence?._id || null,
      replacementForAssignment: previous?._id || null,
    }).session(session);
    if (
      !application ||
      (assignmentType === "replacement" && application.slotNumber !== input.slotNumber)
    ) {
      throw this.error(
        "Application does not match this assignment opportunity.",
        "ASSIGNMENT_APPLICATION_MISMATCH",
        409
      );
    }
  }

  static async finishAssignmentCreation({
    shift,
    input,
    occurrences,
    assignment,
    assignedAt,
    session,
  }) {
    await this.earnBasePlatformFeesForOccurrences({ occurrences, assignedAt, session });
    await this.refreshAssignmentProgress({ shift, session, currentTime: assignedAt });
    await shift.save({ session });
    return {
      assignment,
      shift,
      shiftId: String(shift._id),
      slotNumber: assignment.slotNumber,
      professionalId: String(input.professional),
      assignedOccurrenceCount: occurrences.length,
      assignmentStatus: assignment.status,
    };
  }

  static async assertAssignmentFunding({ shift, allOccurrences, session }) {
    if (
      !shift.publishedAt ||
      !shift.fundedAt ||
      !shift.fundingTransaction ||
      !shift.fundingMethod ||
      shift.fundedAmount < shift.estimatedEmployerCharge ||
      ["unpaid", "released", "refunded"].includes(shift.paymentStatus)
    ) {
      throw this.error(
        "Protected funding is not available for assignment.",
        "SHIFT_NOT_FUNDED_FOR_ASSIGNMENT",
        409
      );
    }
    // Reserve the complete remaining original allocation, including amounts
    // whose refund or attendance recalculation has not yet synchronized.
    const sum = (values) => money.sumMinorUnitAmounts(values, "Remaining occurrence funding");
    const liabilities = allOccurrences.map((o) => {
      const baseOutflows = sum([
        o.baseSettlement?.status === "released" ? o.baseSettlement.professionalPay : 0,
        o.basePlatformFeeAudit?.collectedAt ? o.basePlatformFee : 0,
        o.refundedAmount || 0,
      ]);
      if (baseOutflows > o.estimatedEmployerCharge)
        throw this.error("BASE outflows exceed allocation.", "OCCURRENCE_ALLOCATION_EXCEEDED", 409);
      const ot = o.overtime?.topUpPaid
        ? sum([
            o.overtimeSettlement?.status === "released" ? 0 : o.overtimeProfessionalPay,
            o.overtimePlatformFeeAudit?.collectedAt ? 0 : o.overtimePlatformFee,
          ])
        : 0;
      return sum([o.estimatedEmployerCharge - baseOutflows, ot]);
    });
    const requiredProtectedAmount = sum(liabilities);
    if (this.getParentProtectedBalance(shift) < requiredProtectedAmount) {
      throw this.error(
        "Shift protected funding is insufficient or requires reconciliation.",
        "SHIFT_PROTECTED_FUNDING_INSUFFICIENT",
        409
      );
    }
    await this.assertEscrowWalletOperationalCoverage({ shift, requiredProtectedAmount, session });
  }

  static async createInitialAssignment(payload, options = {}) {
    const input = this.normalizeAssignmentInput(payload);
    return this.transaction(options, async (session) => {
      const shift = await this.lockShiftAndProfessional({
        shiftId: payload.shiftId,
        professionalId: input.professional,
        session,
      });
      const assignedAt = this.normalizeDate(payload.assignedAt, "assigned-at time", new Date());
      if (shift.status !== "open" || shift.startTime <= assignedAt)
        throw this.error(
          "Initial hiring is not open.",
          "SHIFT_NOT_OPEN_FOR_INITIAL_ASSIGNMENT",
          409
        );
      const all = await this.getOccurrences(shift, session);
      const history = await ShiftAssignment.find({ shift: shift._id }).session(session);
      const occupied = new Set(history.map((a) => a.slotNumber));
      let slotNumber = payload.slotNumber;
      if (
        slotNumber != null &&
        (!Number.isSafeInteger(slotNumber) ||
          slotNumber < 1 ||
          slotNumber > shift.requiredProfessionals)
      ) {
        throw this.error("Invalid assignment slot.", "INVALID_ASSIGNMENT_SLOT");
      }
      const available = (slot) =>
        !occupied.has(slot) &&
        all
          .filter((o) => o.slotNumber === slot)
          .every((o) => this.isInitialOccurrenceEligible(o, assignedAt));
      if (slotNumber == null) {
        for (let slot = 1; slot <= shift.requiredProfessionals; slot++)
          if (available(slot)) {
            slotNumber = slot;
            break;
          }
      }
      if (!slotNumber || !available(slotNumber))
        throw this.error(
          "No complete initial position is available.",
          "INITIAL_ASSIGNMENT_CAPACITY_FILLED",
          409
        );
      input.slotNumber = slotNumber;
      const occurrences = all.filter((o) => o.slotNumber === slotNumber);
      await this.assertApplicationMatches({ shift, input, assignmentType: "initial", session });
      await this.assertNoOverlap({ professionalId: input.professional, occurrences, session });
      await this.assertAssignmentFunding({ shift, allOccurrences: all, session });
      const assignment = await this.createRecord({
        shift,
        input,
        assignmentType: "initial",
        range: this.rangeFromOccurrences(occurrences),
        assignedAt,
        status: "scheduled",
        session,
      });
      await this.assignOccurrences({
        shift,
        occurrences,
        input,
        assignment,
        assignedAt,
        expectedAssignmentStatus: "unassigned",
        session,
      });
      return this.finishAssignmentCreation({
        shift,
        input,
        occurrences,
        assignment,
        assignedAt,
        session,
      });
    });
  }

  static async endActiveAssignmentForReplacement() {
    throw this.error(
      "Use the assignment case workflow to authorize an exit.",
      "ASSIGNMENT_CASE_REQUIRED",
      409
    );
  }

  static async createReplacementAssignment(payload, options = {}) {
    const input = this.normalizeAssignmentInput(payload);
    return this.transaction(options, async (session) => {
      const shift = await this.lockShiftAndProfessional({
        shiftId: payload.shiftId,
        professionalId: input.professional,
        session,
      });
      const assignedAt = this.normalizeDate(payload.assignedAt, "assigned-at time", new Date());
      if (!REPLACEMENT_APPLICATION_PARENT_STATUSES.includes(shift.status))
        throw this.error(
          "Replacement hiring is not available.",
          "SHIFT_NOT_OPEN_FOR_REPLACEMENT",
          409
        );
      const previous = await this.getAssignment({
        assignmentId: payload.replacesAssignmentId,
        shiftId: shift._id,
        session,
      });
      if (
        String(previous.business) !== String(shift.business) ||
        String(previous.branch) !== String(shift.branch)
      ) {
        throw this.error(
          "The prior assignment does not match the Shift business and branch.",
          "REPLACEMENT_ASSIGNMENT_CONTEXT_MISMATCH",
          409
        );
      }
      input.slotNumber = previous.slotNumber;
      if (payload.slotNumber != null && payload.slotNumber !== input.slotNumber)
        throw this.error(
          "Replacement must retain its prior slot.",
          "REPLACEMENT_SLOT_MISMATCH",
          409
        );
      const all = await this.getOccurrences(shift, session);
      let target = null;
      let assignmentCase = null;
      let start, end;
      if (payload.occurrenceId) {
        target = all.find((o) => String(o._id) === String(payload.occurrenceId));
        if (
          !target ||
          target.slotNumber !== previous.slotNumber ||
          target.sequenceNumber < previous.startSequence ||
          target.sequenceNumber > previous.plannedEndSequence
        ) {
          throw this.error(
            "The occurrence does not belong to the previous assignment range.",
            "REPLACEMENT_OCCURRENCE_CONTEXT_MISMATCH",
            409
          );
        }
        start = end = target.sequenceNumber;
        if (target.replacementCase) {
          assignmentCase = await this.getReplacementCase({
            replacementCaseId: target.replacementCase,
            shift,
            previousAssignment: previous,
            session,
          });
        }
        if (
          payload.replacementCaseId &&
          String(payload.replacementCaseId) !== String(target.replacementCase || "")
        )
          throw this.error("Replacement case changed.", "REPLACEMENT_CASE_MISMATCH", 409);
      } else {
        if (
          !["ending", "ended", "cancelled"].includes(previous.status) ||
          previous.replacedByAssignment
        )
          throw this.error(
            "The prior assignment is not eligible for tail replacement.",
            "ASSIGNMENT_ALREADY_REPLACED_OR_NOT_ENDING",
            409
          );
        assignmentCase = await this.getReplacementCase({
          replacementCaseId: payload.replacementCaseId,
          shift,
          previousAssignment: previous,
          session,
        });
        const range =
          assignmentCase.status === "resolved_exit"
            ? assignmentCase.resolution?.effectiveExitRange
            : assignmentCase.exitProposal?.range;
        start = range?.replacementStartSequenceNumber;
        end = range?.replacementEndSequenceNumber;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < previous.startSequence ||
          end !== previous.plannedEndSequence ||
          start > end ||
          range.replacementOccurrenceCount !== end - start + 1
        ) {
          throw this.error(
            "The case does not authorize a complete future tail.",
            "REPLACEMENT_CASE_RANGE_INVALID",
            409
          );
        }
      }
      if (
        (payload.startSequenceNumber != null && payload.startSequenceNumber !== start) ||
        (payload.endSequenceNumber != null && payload.endSequenceNumber !== end)
      )
        throw this.error(
          "Requested range differs from authoritative replacement range.",
          "ASSIGNMENT_RANGE_MISMATCH",
          409
        );
      const occurrences = all.filter(
        (o) =>
          o.slotNumber === previous.slotNumber &&
          o.sequenceNumber >= start &&
          o.sequenceNumber <= end
      );
      this.assertExactSequenceRange({
        occurrences,
        startSequenceNumber: start,
        endSequenceNumber: end,
      });
      if (
        occurrences.some(
          (o) =>
            !this.isReplacementOccurrenceEligible({
              occurrence: o,
              previousAssignment: previous,
              replacementCase: assignmentCase,
              occurrenceTargetId: target?._id,
              replacementRequiredAt: target?.replacementRequiredAt,
              assignedAt,
            })
        )
      )
        throw this.error(
          "Replacement occurrences are no longer eligible.",
          "REPLACEMENT_OCCURRENCES_NOT_AVAILABLE",
          409
        );
      await this.assertApplicationMatches({
        shift,
        input,
        assignmentType: "replacement",
        previous,
        occurrence: target,
        session,
      });
      await this.assertNoOverlap({ professionalId: input.professional, occurrences, session });
      await this.assertAssignmentFunding({ shift, allOccurrences: all, session });
      if (!target) {
        if (
          ["ending", "ended"].includes(previous.status) &&
          previous.effectiveEndSequence !== start - 1
        )
          throw this.error(
            "The outgoing assignment endpoint differs from the case.",
            "REPLACEMENT_END_RANGE_MISMATCH",
            409
          );
        await this.finalizeEndingAssignmentIfDue({
          assignment: previous,
          currentTime: assignedAt,
          session,
        });
      }
      const assignment = await this.createRecord({
        shift,
        input,
        assignmentType: "replacement",
        range: this.rangeFromOccurrences(occurrences),
        assignedAt,
        status: "scheduled",
        occurrence: target?._id || null,
        replacesAssignment: previous._id,
        replacementCase: assignmentCase?._id || null,
        session,
      });
      await this.assignOccurrences({
        shift,
        occurrences,
        input,
        assignment,
        assignedAt,
        expectedAssignmentStatus: "replacement_required",
        previousAssignment: previous,
        replacementCase: assignmentCase,
        occurrenceTarget: target,
        session,
      });
      if (!target) {
        if (previous.status !== "cancelled") {
          previous.replacedByAssignment = assignment._id;
          previous.openCase = null;
          await previous.save({ session });
        }
        await this.finalizeReplacementCase({ assignmentCase, assignedAt, session });
      }
      return this.finishAssignmentCreation({
        shift,
        input,
        occurrences,
        assignment,
        assignedAt,
        session,
      });
    });
  }

  static async activateScheduledAssignment(
    { assignmentId, activatedByUserId = null, currentTime = new Date() },
    options = {}
  ) {
    return this.transaction(options, async (session) => {
      let assignment = await this.getAssignment({ assignmentId, session });
      const shift = await this.lockShiftAndProfessional({ shiftId: assignment.shift, session });
      assignment = await this.getAssignment({ assignmentId, session });
      if (assignment.status === "active") return { assignment, activated: false, idempotent: true };
      const activatedAt = this.normalizeDate(currentTime, "activation time");
      if (
        assignment.status !== "scheduled" ||
        activatedAt < assignment.startsAt ||
        activatedAt >= assignment.plannedEndsAt
      )
        throw this.error(
          "Assignment cannot be activated at this time.",
          "ASSIGNMENT_ACTIVATION_NOT_DUE",
          409
        );
      const activatedBy = this.objectId(activatedByUserId, "activation user ID");
      const owned = await ShiftOccurrence.find({
        shift: shift._id,
        slotNumber: assignment.slotNumber,
        assignment: assignment._id,
        assignedProfessional: assignment.professional,
        assignmentStatus: "assigned",
      }).session(session);
      if (
        !owned.some(
          (o) => ["scheduled", "in_progress"].includes(o.status) && o.endTime > activatedAt
        )
      )
        throw this.error(
          "No remaining owned work can be activated.",
          "ASSIGNMENT_ACTIVATION_NO_WORK",
          409
        );
      if (!assignment.occurrence) {
        const previous = await this.getActiveAssignment({
          shiftId: shift._id,
          slotNumber: assignment.slotNumber,
          session,
        });
        if (previous) {
          await this.finalizeEndingAssignmentIfDue({
            assignment: previous,
            currentTime: activatedAt,
            session,
          });
          if (previous.status !== "ended")
            throw this.error(
              "The prior slot assignment remains current.",
              "ASSIGNMENT_ACTIVATION_CONFLICT",
              409
            );
        }
      }
      assignment.status = "active";
      assignment.activatedAt = activatedAt;
      assignment.activatedBy = activatedBy;
      await assignment.save({ session });
      await this.refreshAssignmentProgress({ shift, session, currentTime: activatedAt });
      await shift.save({ session });
      return { assignment, shift, activated: true, idempotent: false };
    });
  }

  static isOccurrenceFinalForIsolatedAssignmentClose(o) {
    return (
      RESOLVED_OCCURRENCE_STATUSES.includes(o.status) &&
      !o.activeClaim &&
      !o.activeDispute &&
      !(o.challengeWindowOpenedAt && !o.challengeWindowClosedAt) &&
      !["pending", "disputed"].includes(o.overtime?.status) &&
      ["not_due", "released"].includes(o.settlementStatus) &&
      ["not_eligible", "refunded"].includes(o.refundStatus)
    );
  }

  static async closeCompletedOccurrenceAssignment(payload, options = {}) {
    return this.closeAssignmentResponsibility(payload, options, true);
  }

  static async closeCompletedAssignment(payload, options = {}) {
    return this.closeAssignmentResponsibility(payload, options, false);
  }

  static async closeAssignmentResponsibility(payload, options, isolated) {
    return this.transaction(options, async (session) => {
      const assignment = await this.getAssignment({
        assignmentId: payload.assignmentId,
        shiftId: payload.shiftId,
        session,
      });
      const shift = await this.lockShiftAndProfessional({ shiftId: assignment.shift, session });
      if (
        Boolean(assignment.occurrence) !== isolated ||
        (isolated && String(assignment.occurrence) !== String(payload.occurrenceId))
      )
        throw this.error(
          "Assignment scope does not match closure request.",
          "ASSIGNMENT_CLOSE_SCOPE_MISMATCH",
          409
        );
      if (assignment.status === "ended") return { assignment, shift, idempotent: true };
      if (assignment.status !== "active" || assignment.openCase)
        throw this.error(
          "Only active responsibility without an unresolved exit case can complete normally.",
          "ASSIGNMENT_CLOSE_NOT_ALLOWED",
          409
        );
      const endedAt = this.normalizeDate(
        payload.endedAt ?? payload.currentTime,
        "ended-at time",
        new Date()
      );
      const owned = await ShiftOccurrence.find({
        assignment: assignment._id,
        shift: shift._id,
        slotNumber: assignment.slotNumber,
      }).session(session);
      // Isolated dates transferred elsewhere no longer belong to this assignment.
      // A live replacement request for this assignment still blocks normal closure.
      const pending = await ShiftOccurrence.findOne({
        shift: shift._id,
        replacementForAssignment: assignment._id,
        assignmentStatus: "replacement_required",
      }).session(session);
      if (
        pending ||
        endedAt < assignment.plannedEndsAt ||
        owned.some((o) => !RESOLVED_OCCURRENCE_STATUSES.includes(o.status))
      )
        throw this.error(
          "Assignment still has operational responsibility.",
          "ASSIGNMENT_WORK_NOT_FINISHED",
          409
        );
      const role = this.normalizeActorRole(payload.endedByRole || (isolated ? "system" : "admin"));
      assignment.status = "ended";
      assignment.effectiveEndSequence = assignment.plannedEndSequence;
      assignment.effectiveOccurrenceCount = assignment.plannedOccurrenceCount;
      assignment.effectiveEndsAt = assignment.plannedEndsAt;
      assignment.endedAt = endedAt;
      assignment.endedByRole = role;
      assignment.endedBy =
        role === "system" ? null : this.objectId(payload.endedByUserId, "ended-by user ID");
      assignment.endReason = "engagement_completed";
      assignment.endNotes = this.notes(payload.endNotes);
      await assignment.save({ session });
      await this.refreshAssignmentProgress({ shift, session, currentTime: endedAt });
      await shift.save({ session });
      return { assignment, shift, shiftId: String(shift._id), idempotent: false };
    });
  }
}

module.exports = ShiftAssignmentService;
