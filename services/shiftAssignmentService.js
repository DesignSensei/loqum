// services/shiftAssignmentService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftAssignment = require("../models/ShiftAssignment");
const ShiftAssignmentCase = require("../models/ShiftAssignmentCase");

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
    return runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

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
    return [
      "referenceCode",
      "business",
      "branch",
      "countryCode",
      "currency",
      "scheduleMode",
      "occurrenceCount",
      "startTime",
      "endTime",
      "fundedAmount",
      "refundedAmount",
      "settlementSummary",
      "paymentStatus",
      "status",
      "publishedAt",
      "activeAssignment",
      "assignedProfessional",
      "assignedAt",
      "assignedBy",
      "applicationRound",
      "replacementHiring",
      "occurrenceProgress",
    ].join(" ");
  }

  static getOccurrenceFields() {
    return [
      "shift",
      "business",
      "branch",
      "referenceCode",
      "sequenceNumber",
      "startTime",
      "endTime",
      "fillCutoffAt",
      "unfilledFinalizationAt",

      "status",
      "attendanceStatus",
      "settlementStatus",
      "refundStatus",

      "assignmentStatus",
      "assignedProfessional",
      "assignment",
      "assignedAt",

      "replacementRequiredAt",
      "replacementForAssignment",
      "replacementCase",
      "replacementReasonCode",
      "replacementReasonDetails",

      "checkedInAt",
      "checkedOutAt",
      "checkInPinUsedAt",
      "checkOutPinUsedAt",

      "estimatedProfessionalPay",
      "estimatedPlatformFee",
      "estimatedEmployerCharge",

      "baseProfessionalPay",
      "basePlatformFee",
      "baseEmployerCharge",
      "basePlatformFeeAudit",
      "baseSettlement",

      "overtimeProfessionalPay",
      "overtimePlatformFee",
      "overtimeEmployerCharge",
      "overtimePlatformFeeAudit",
      "overtimeSettlement",
      "overtime",

      "topUpRequired",
      "topUpTransaction",

      "cancellationCompensation",
      "activeWorkCancellation",

      "refundableAmount",
      "refundedAmount",
      "refundEligibleAt",
      "refundedAt",
      "refundTransaction",

      "expiredUnfilledAt",
      "activeClaim",
      "activeDispute",
    ].join(" ");
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

  static async getActiveAssignment({ shiftId, session = null, required = false }) {
    const query = ShiftAssignment.findOne({
      shift: ShiftAssignmentService.objectId(shiftId, "shift ID"),

      occurrence: null,

      isCurrentAssignment: true,

      status: {
        $in: CURRENT_ASSIGNMENT_STATUSES,
      },
    }).sort({
      assignedAt: -1,
    });

    if (session) {
      query.session(session);
    }

    const assignment = await query;

    if (!assignment && required) {
      throw ShiftAssignmentService.createError({
        message: "No current professional assignment was found.",
        code: "CURRENT_SHIFT_ASSIGNMENT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return assignment;
  }

  static async getOccurrences(shift, session = null) {
    const query = ShiftOccurrence.find({
      shift: shift._id,
    })
      .select(ShiftAssignmentService.getOccurrenceFields())
      .sort({
        sequenceNumber: 1,
      });

    if (session) {
      query.session(session);
    }

    const occurrences = await query;

    const expected = Number(shift.occurrenceCount || 0);

    if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_SHIFT_OCCURRENCES) {
      throw ShiftAssignmentService.createError({
        message: "The engagement occurrence count is invalid.",
        code: "INVALID_SHIFT_OCCURRENCE_COUNT",
        statusCode: 500,
      });
    }

    if (shift.scheduleMode === "multiple" && expected < 2) {
      throw ShiftAssignmentService.createError({
        message: "A multiple engagement must contain at least two occurrences.",
        code: "INVALID_MULTIPLE_SHIFT_OCCURRENCE_COUNT",
        statusCode: 500,
      });
    }

    if (shift.scheduleMode !== "multiple" && expected !== 1) {
      throw ShiftAssignmentService.createError({
        message: "A single Shift must contain exactly one occurrence.",
        code: "INVALID_SINGLE_SHIFT_OCCURRENCE_COUNT",
        statusCode: 500,
      });
    }

    if (occurrences.length !== expected) {
      throw ShiftAssignmentService.createError({
        message: "The engagement occurrence records are incomplete.",
        code: "SHIFT_OCCURRENCE_COUNT_MISMATCH",
        statusCode: 409,
        details: {
          expected,
          actual: occurrences.length,
        },
      });
    }

    occurrences.forEach((occurrence, index) => {
      if (occurrence.sequenceNumber !== index + 1) {
        throw ShiftAssignmentService.createError({
          message: "The engagement occurrence sequence is incomplete.",
          code: "SHIFT_OCCURRENCE_SEQUENCE_MISMATCH",
          statusCode: 409,
          details: {
            expectedSequenceNumber: index + 1,
            actualSequenceNumber: occurrence.sequenceNumber,
            occurrenceId: String(occurrence._id),
          },
        });
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
      !occurrence.refundTransaction &&
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
    const countQuery = ShiftAssignment.countDocuments({
      shift: shift._id,
    });

    if (session) {
      countQuery.session(session);
    }

    const number = (await countQuery) + 1;

    if (number > MAX_ASSIGNMENT_REFERENCE_NUMBER) {
      throw ShiftAssignmentService.createError({
        message: "The assignment reference limit has been reached.",
        code: "SHIFT_ASSIGNMENT_REFERENCE_LIMIT_REACHED",
        statusCode: 409,
      });
    }

    return {
      id: new mongoose.Types.ObjectId(),

      referenceCode: `${shift.referenceCode}-A${String(number).padStart(2, "0")}`,
    };
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

      refundTransaction: null,

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
    const query = ShiftOccurrence.find({
      shift: shift._id,
    })
      .select(
        [
          "assignmentStatus",
          "status",
          "attendanceStatus",
          "settlementStatus",
          "refundStatus",
          "activeClaim",
          "activeDispute",
          "startTime",
          "endTime",
        ].join(" ")
      )
      .sort({
        sequenceNumber: 1,
      })
      .lean();

    if (session) {
      query.session(session);
    }

    const occurrences = await query;

    const count = (predicate) => occurrences.filter(predicate).length;

    shift.occurrenceProgress = shift.occurrenceProgress || {};

    shift.occurrenceProgress.unassigned = count(
      (occurrence) => occurrence.assignmentStatus === "unassigned"
    );

    shift.occurrenceProgress.assigned = count(
      (occurrence) => occurrence.assignmentStatus === "assigned"
    );

    shift.occurrenceProgress.replacementRequired = count(
      (occurrence) => occurrence.assignmentStatus === "replacement_required"
    );

    shift.occurrenceProgress.expiredUnfilled = count(
      (occurrence) => occurrence.assignmentStatus === "expired_unfilled"
    );

    shift.occurrenceProgress.lastReconciledAt = currentTime;

    return occurrences;
  }

  static determineParentOperationalStatus({ shift, occurrences, currentTime }) {
    if (TERMINAL_PARENT_STATUSES.includes(shift.status)) {
      return shift.status;
    }

    const hasDispute = occurrences.some(
      (occurrence) =>
        Boolean(occurrence.activeClaim) ||
        Boolean(occurrence.activeDispute) ||
        occurrence.status === "disputed" ||
        occurrence.attendanceStatus === "disputed" ||
        occurrence.settlementStatus === "disputed"
    );

    if (hasDispute) {
      return "disputed";
    }

    const hasInProgressOccurrence = occurrences.some(
      (occurrence) => occurrence.status === "in_progress"
    );

    if (hasInProgressOccurrence) {
      return "in_progress";
    }

    const hasRemainingScheduledWork = occurrences.some(
      (occurrence) =>
        occurrence.status === "scheduled" &&
        occurrence.assignmentStatus !== "expired_unfilled" &&
        new Date(occurrence.endTime) > currentTime
    );

    if (hasRemainingScheduledWork) {
      if (
        shift.activeAssignment ||
        shift.assignedProfessional ||
        ["open", "filled"].includes(shift.replacementHiring?.status)
      ) {
        return "confirmed";
      }

      return shift.status;
    }

    if (occurrences.length === 1 && occurrences[0].status === "no_show") {
      return "no_show";
    }

    const hasPendingSettlement = occurrences.some(
      (occurrence) =>
        occurrence.status === "pending_settlement" ||
        PENDING_SETTLEMENT_STATUSES.includes(occurrence.settlementStatus)
    );

    const hasPendingRefund = occurrences.some((occurrence) =>
      ["eligible", "held", "batched", "processing"].includes(occurrence.refundStatus)
    );

    if (hasPendingSettlement || hasPendingRefund) {
      return "pending_settlement";
    }

    const allOccurrencesResolved =
      occurrences.length > 0 &&
      occurrences.every((occurrence) => RESOLVED_OCCURRENCE_STATUSES.includes(occurrence.status));

    if (allOccurrencesResolved) {
      return "completed";
    }

    return shift.status;
  }

  static setParentAssignmentSummary({ shift, assignment }) {
    shift.activeAssignment = assignment._id;

    shift.assignedProfessional = assignment.professional;

    shift.assignedAt = assignment.assignedAt;

    shift.assignedBy = assignment.assignedBy;
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

  static async createInitialAssignment(payload, options = {}) {
    const input = ShiftAssignmentService.normalizeAssignmentInput(payload);

    return ShiftAssignmentService.transaction(
      options,

      async (session) => {
        const shift = await ShiftAssignmentService.getShift(payload.shiftId, session);

        const assignedAt = ShiftAssignmentService.normalizeDate(
          payload.assignedAt,
          "assigned-at time",
          new Date()
        );

        if (shift.paymentStatus !== INITIAL_APPLICATION_PAYMENT_STATUS) {
          throw ShiftAssignmentService.createError({
            message: "The engagement must be fully funded before initial assignment.",
            code: "SHIFT_NOT_FUNDED_FOR_INITIAL_ASSIGNMENT",
            statusCode: 409,
          });
        }

        if (
          shift.status !== "open" ||
          shift.assignedProfessional ||
          shift.activeAssignment ||
          new Date(shift.startTime) <= assignedAt
        ) {
          throw ShiftAssignmentService.createError({
            message: "This engagement is not open for an initial assignment.",
            code: "SHIFT_NOT_OPEN_FOR_INITIAL_ASSIGNMENT",
            statusCode: 409,
          });
        }

        if (
          String(shift.replacementHiring?.status || REPLACEMENT_HIRING_STATUSES.CLOSED) !==
          REPLACEMENT_HIRING_STATUSES.CLOSED
        ) {
          throw ShiftAssignmentService.createError({
            message: "Initial assignment is unavailable while replacement hiring is configured.",
            code: "INITIAL_ASSIGNMENT_REPLACEMENT_CONTEXT_CONFLICT",
            statusCode: 409,
          });
        }

        const previousQuery = ShiftAssignment.findOne({
          shift: shift._id,
        }).select("_id status assignmentType");

        if (session) {
          previousQuery.session(session);
        }

        const previous = await previousQuery;

        if (previous) {
          throw ShiftAssignmentService.createError({
            message:
              "This engagement already has assignment history. Use the replacement workflow.",
            code: "INITIAL_SHIFT_ASSIGNMENT_ALREADY_EXISTS",
            statusCode: 409,
            details: {
              assignmentId: String(previous._id),
              status: previous.status,
            },
          });
        }

        const occurrences = await ShiftAssignmentService.getOccurrences(shift, session);

        const invalidOccurrence = occurrences.find(
          (occurrence) =>
            !ShiftAssignmentService.isInitialOccurrenceEligible(occurrence, assignedAt)
        );

        if (invalidOccurrence) {
          throw ShiftAssignmentService.createError({
            message: "One or more occurrences cannot receive the initial assignment.",
            code: "INITIAL_ASSIGNMENT_OCCURRENCE_NOT_ELIGIBLE",
            statusCode: 409,
            details: {
              occurrenceId: String(invalidOccurrence._id),

              sequenceNumber: invalidOccurrence.sequenceNumber,

              assignmentStatus: invalidOccurrence.assignmentStatus,

              occurrenceStatus: invalidOccurrence.status,

              refundStatus: invalidOccurrence.refundStatus,
            },
          });
        }

        const { requiredProtectedAmount } =
          ShiftAssignmentService.assertShiftProtectedLiabilityCovered({
            shift,
            occurrences,
          });

        await ShiftAssignmentService.assertEscrowWalletOperationalCoverage({
          shift,
          requiredProtectedAmount,
          session,
        });

        const range = ShiftAssignmentService.rangeFromOccurrences(occurrences);

        const assignment = await ShiftAssignmentService.createRecord({
          shift,
          input,
          assignmentType: "initial",
          range,
          assignedAt,
          status: "scheduled",
          session,
        });

        await ShiftAssignmentService.assignOccurrences({
          shift,
          occurrences,
          input,
          assignment,
          assignedAt,
          expectedAssignmentStatus: "unassigned",
          session,
        });

        /*
         * Assignment confirmation is the BASE platform-fee earning event.
         *
         * For a multi-occurrence assignment this processes every occurrence
         * covered by the confirmed assignment immediately.
         */
        await ShiftAssignmentService.earnBasePlatformFeesForOccurrences({
          occurrences,
          assignedAt,
          session,
        });

        ShiftAssignmentService.setParentAssignmentSummary({
          shift,
          assignment,
        });

        shift.status = "assigned";

        await ShiftAssignmentService.refreshAssignmentProgress({
          shift,
          session,
          currentTime: assignedAt,
        });

        await shift.save({
          session,
        });

        logger.info(
          `Initial assignment ${assignment.referenceCode} created for shift ${shift.referenceCode}`
        );

        return {
          assignment,
          shift,

          shiftId: String(shift._id),

          professionalId: String(input.professional),

          assignedOccurrenceCount: occurrences.length,

          assignmentStatus: assignment.status,
        };
      }
    );
  }

  /* ─────────────────────────────── DIRECT ENDING GUARD ─────────────────────────────── */

  static async endActiveAssignmentForReplacement() {
    throw ShiftAssignmentService.createError({
      message:
        "Direct assignment removal is disabled. Confirm the exit through a ShiftAssignmentCase before opening replacement hiring.",
      code: "ASSIGNMENT_CASE_REQUIRED_FOR_REPLACEMENT",
      statusCode: 409,
    });
  }

  /* ─────────────────────────────── REPLACEMENT ASSIGNMENT ─────────────────────────────── */

  static async createReplacementAssignment(payload, options = {}) {
    const input = ShiftAssignmentService.normalizeAssignmentInput(payload);

    const requestedPreviousId = ShiftAssignmentService.objectId(
      payload.replacesAssignmentId,
      "replaced assignment ID"
    );

    const occurrenceId = ShiftAssignmentService.objectId(
      payload.occurrenceId,
      "occurrence ID",
      false
    );

    const isOccurrenceTargeted = Boolean(occurrenceId);

    const replacementCaseId = ShiftAssignmentService.objectId(
      payload.replacementCaseId,
      "replacement case ID",
      !isOccurrenceTargeted
    );

    const startSequenceNumber = ShiftAssignmentService.normalizeSequenceNumber(
      payload.startSequenceNumber,
      "replacement start sequence number"
    );

    const endSequenceNumber = ShiftAssignmentService.normalizeSequenceNumber(
      payload.endSequenceNumber,
      "replacement end sequence number"
    );

    if (endSequenceNumber < startSequenceNumber) {
      throw ShiftAssignmentService.createError({
        message:
          "Replacement end sequence number cannot be earlier than the start sequence number.",

        code: "INVALID_REPLACEMENT_SEQUENCE_RANGE",
      });
    }

    if (isOccurrenceTargeted && startSequenceNumber !== endSequenceNumber) {
      throw ShiftAssignmentService.createError({
        message: "A single-occurrence replacement must target exactly one sequence.",

        code: "INVALID_OCCURRENCE_REPLACEMENT_RANGE",
      });
    }

    return ShiftAssignmentService.transaction(
      options,

      async (session) => {
        const shift = await ShiftAssignmentService.getShift(payload.shiftId, session);

        const assignedAt = ShiftAssignmentService.normalizeDate(
          payload.assignedAt,
          "assigned-at time",
          new Date()
        );

        if (shift.scheduleMode !== "multiple") {
          throw ShiftAssignmentService.createError({
            message: "Replacement assignment is only available for a multiple engagement.",

            code: "REPLACEMENT_ASSIGNMENT_NOT_AVAILABLE",

            statusCode: 409,
          });
        }

        if (
          !REPLACEMENT_APPLICATION_PARENT_STATUSES.includes(shift.status) ||
          REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES.includes(shift.paymentStatus)
        ) {
          throw ShiftAssignmentService.createError({
            message: "The engagement is not ready for replacement assignment.",

            code: "SHIFT_NOT_READY_FOR_REPLACEMENT_ASSIGNMENT",

            statusCode: 409,

            details: {
              status: shift.status,

              paymentStatus: shift.paymentStatus,
            },
          });
        }

        const previousAssignment = await ShiftAssignmentService.getAssignment({
          assignmentId: requestedPreviousId,

          shiftId: shift._id,

          session,
        });

        const allOccurrences = await ShiftAssignmentService.getOccurrences(shift, session);

        /*
         * ───────────────────────────────
         * SINGLE-OCCURRENCE REPLACEMENT
         * ───────────────────────────────
         */
        if (isOccurrenceTargeted) {
          const allowedSourceStatuses = ["scheduled", ...CURRENT_ASSIGNMENT_STATUSES];

          if (!allowedSourceStatuses.includes(previousAssignment.status)) {
            throw ShiftAssignmentService.createError({
              message:
                "The assignment that previously owned this occurrence is no longer continuing.",

              code: "OCCURRENCE_REPLACEMENT_SOURCE_NOT_AVAILABLE",

              statusCode: 409,

              details: {
                status: previousAssignment.status,
              },
            });
          }

          if (previousAssignment.occurrence) {
            throw ShiftAssignmentService.createError({
              message:
                "An isolated replacement assignment cannot itself open another continuing-occurrence replacement.",

              code: "ISOLATED_ASSIGNMENT_CANNOT_CONTINUE_OCCURRENCE_REPLACEMENT",

              statusCode: 409,
            });
          }

          const occurrence = allOccurrences.find(
            (candidate) => String(candidate._id) === String(occurrenceId)
          );

          if (!occurrence) {
            throw ShiftAssignmentService.createError({
              message: "The replacement occurrence was not found.",

              code: "REPLACEMENT_OCCURRENCE_NOT_FOUND",

              statusCode: 404,
            });
          }

          if (
            occurrence.sequenceNumber !== startSequenceNumber ||
            occurrence.sequenceNumber !== endSequenceNumber
          ) {
            throw ShiftAssignmentService.createError({
              message:
                "The requested occurrence no longer matches the replacement assignment range.",

              code: "STALE_OCCURRENCE_REPLACEMENT_RANGE",

              statusCode: 409,

              details: {
                occurrenceSequenceNumber: occurrence.sequenceNumber,

                requestedStartSequenceNumber: startSequenceNumber,

                requestedEndSequenceNumber: endSequenceNumber,
              },
            });
          }

          /*
           * The occurrence must still fall inside the continuing assignment's
           * responsibility range.
           */
          const previousResponsibilityEnd =
            previousAssignment.status === "ending" &&
            Number.isSafeInteger(previousAssignment.effectiveEndSequence)
              ? previousAssignment.effectiveEndSequence
              : previousAssignment.plannedEndSequence;

          if (
            occurrence.sequenceNumber < previousAssignment.startSequence ||
            occurrence.sequenceNumber > previousResponsibilityEnd
          ) {
            throw ShiftAssignmentService.createError({
              message: "The original assignment is no longer responsible for this occurrence.",

              code: "OCCURRENCE_REPLACEMENT_SOURCE_RANGE_CHANGED",

              statusCode: 409,
            });
          }

          const occurrenceReplacementCaseId = occurrence.replacementCase
            ? String(occurrence.replacementCase)
            : null;

          const requestedReplacementCaseId = replacementCaseId ? String(replacementCaseId) : null;

          if (occurrenceReplacementCaseId !== requestedReplacementCaseId) {
            throw ShiftAssignmentService.createError({
              message: "The occurrence replacement context changed before assignment completed.",

              code: "STALE_OCCURRENCE_REPLACEMENT_CASE",

              statusCode: 409,
            });
          }

          let replacementCase = null;

          if (replacementCaseId) {
            replacementCase = await ShiftAssignmentService.getReplacementCase({
              replacementCaseId,

              shift,

              previousAssignment,

              session,
            });
          }

          const eligible = ShiftAssignmentService.isReplacementOccurrenceEligible({
            occurrence,

            previousAssignment,

            replacementCase,

            occurrenceTargetId: occurrenceId,

            replacementRequiredAt: occurrence.replacementRequiredAt,

            assignedAt,
          });

          if (!eligible) {
            throw ShiftAssignmentService.createError({
              message: "This occurrence changed before replacement assignment completed.",

              code: "OCCURRENCE_REPLACEMENT_ASSIGNMENT_NOT_AVAILABLE",

              statusCode: 409,

              details: {
                occurrenceId: String(occurrence._id),

                sequenceNumber: occurrence.sequenceNumber,

                assignmentStatus: occurrence.assignmentStatus,

                occurrenceStatus: occurrence.status,

                refundStatus: occurrence.refundStatus,
              },
            });
          }

          const { requiredProtectedAmount } =
            ShiftAssignmentService.assertShiftProtectedLiabilityCovered({
              shift,

              occurrences: allOccurrences,
            });

          await ShiftAssignmentService.assertEscrowWalletOperationalCoverage({
            shift,

            requiredProtectedAmount,

            session,
          });

          const occurrences = [occurrence];

          const range = ShiftAssignmentService.rangeFromOccurrences(occurrences);

          const assignmentStatus = ShiftAssignmentService.resolveNewAssignmentStatus({
            range,

            assignedAt,

            outgoingRemainsCurrent: false,
          });

          const assignment = await ShiftAssignmentService.createRecord({
            shift,

            input,

            assignmentType: "replacement",

            range,

            assignedAt,

            status: assignmentStatus,

            occurrence: occurrence._id,

            replacesAssignment: previousAssignment._id,

            replacementCase: replacementCase?._id || null,

            session,
          });

          await ShiftAssignmentService.assignOccurrences({
            shift,

            occurrences,

            input,

            assignment,

            assignedAt,

            expectedAssignmentStatus: "replacement_required",

            previousAssignment,

            replacementCase,

            occurrenceTarget: occurrence,

            session,
          });

          /*
           * The occurrence already earned its BASE platform fee when it first
           * became part of a confirmed assignment.
           *
           * Calling the fee authority again is intentional. It verifies the
           * stored earning/collection and returns idempotently instead of
           * charging a replacement fee.
           */
          await ShiftAssignmentService.earnBasePlatformFeesForOccurrences({
            occurrences,
            assignedAt,
            session,
          });

          /*
           * IMPORTANT:
           *
           * Do not:
           *
           * - set previousAssignment.replacedByAssignment
           * - end previousAssignment
           * - finalize its exit case
           * - overwrite Shift.activeAssignment
           * - overwrite Shift.assignedProfessional
           * - close Shift.replacementHiring
           *
           * The previous professional continues the engagement.
           */

          const refreshedOccurrences = await ShiftAssignmentService.refreshAssignmentProgress({
            shift,

            session,

            currentTime: assignedAt,
          });

          shift.status = ShiftAssignmentService.determineParentOperationalStatus({
            shift,

            occurrences: refreshedOccurrences,

            currentTime: assignedAt,
          });

          await shift.save({
            session,
          });

          logger.info(
            `Occurrence replacement assignment ${assignment.referenceCode} created for occurrence ${occurrence.referenceCode} on shift ${shift.referenceCode}`
          );

          return {
            assignment,

            shift,

            occurrence,

            replacedAssignment: previousAssignment,

            replacementCase,

            isOccurrenceTargeted: true,

            continuingAssignmentUnchanged: true,

            replacedAssignmentId: String(previousAssignment._id),

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(input.professional),

            assignedOccurrenceCount: 1,

            assignmentStatus: assignment.status,
          };
        }

        /*
         * ───────────────────────────────
         * EXISTING TAIL REPLACEMENT
         * ───────────────────────────────
         */

        const replacementHiringStatus = String(
          shift.replacementHiring?.status || REPLACEMENT_HIRING_STATUSES.CLOSED
        )
          .trim()
          .toLowerCase();

        if (replacementHiringStatus !== REPLACEMENT_HIRING_STATUSES.OPEN) {
          throw ShiftAssignmentService.createError({
            message: "Replacement hiring is no longer open for this engagement.",

            code: "REPLACEMENT_HIRING_NOT_OPEN",

            statusCode: 409,
          });
        }

        if (
          String(shift.replacementHiring?.replacementForAssignment || "") !==
            String(requestedPreviousId) ||
          String(shift.replacementHiring?.assignmentCase || "") !== String(replacementCaseId)
        ) {
          throw ShiftAssignmentService.createError({
            message: "The replacement request no longer matches the active hiring context.",

            code: "STALE_REPLACEMENT_HIRING_CONTEXT",

            statusCode: 409,
          });
        }

        if (
          Number(shift.replacementHiring?.startSequenceNumber) !== startSequenceNumber ||
          Number(shift.replacementHiring?.endSequenceNumber) !== endSequenceNumber
        ) {
          throw ShiftAssignmentService.createError({
            message:
              "The requested assignment range no longer matches the active replacement range.",

            code: "STALE_REPLACEMENT_ASSIGNMENT_RANGE",

            statusCode: 409,
          });
        }

        if (!REPLACED_ASSIGNMENT_ALLOWED_STATUSES.includes(previousAssignment.status)) {
          throw ShiftAssignmentService.createError({
            message: "The assignment being replaced must be ending or ended.",

            code: "REPLACED_ASSIGNMENT_STATUS_NOT_ALLOWED",

            statusCode: 409,

            details: {
              status: previousAssignment.status,
            },
          });
        }

        if (previousAssignment.replacedByAssignment) {
          throw ShiftAssignmentService.createError({
            message: "A replacement has already been linked to this assignment.",

            code: "ASSIGNMENT_ALREADY_REPLACED",

            statusCode: 409,
          });
        }

        if (
          !previousAssignment.endCase ||
          String(previousAssignment.endCase) !== String(replacementCaseId)
        ) {
          throw ShiftAssignmentService.createError({
            message: "The outgoing assignment is not linked to the active replacement case.",

            code: "ASSIGNMENT_END_CASE_MISMATCH",

            statusCode: 409,
          });
        }

        const replacementCase = await ShiftAssignmentService.getReplacementCase({
          replacementCaseId,

          shift,

          previousAssignment,

          session,
        });

        const occurrences = allOccurrences.filter(
          (occurrence) =>
            occurrence.sequenceNumber >= startSequenceNumber &&
            occurrence.sequenceNumber <= endSequenceNumber
        );

        ShiftAssignmentService.assertExactSequenceRange({
          occurrences,

          startSequenceNumber,

          endSequenceNumber,

          expectedOccurrenceCount: shift.replacementHiring?.occurrenceCount,
        });

        const invalidOccurrence = occurrences.find(
          (occurrence) =>
            !ShiftAssignmentService.isReplacementOccurrenceEligible({
              occurrence,

              previousAssignment,

              replacementCase,

              assignedAt,
            })
        );

        if (invalidOccurrence) {
          throw ShiftAssignmentService.createError({
            message: "One or more replacement occurrences changed before assignment completed.",

            code: "REPLACEMENT_ASSIGNMENT_OCCURRENCE_NOT_ELIGIBLE",

            statusCode: 409,

            details: {
              occurrenceId: String(invalidOccurrence._id),

              sequenceNumber: invalidOccurrence.sequenceNumber,

              assignmentStatus: invalidOccurrence.assignmentStatus,

              occurrenceStatus: invalidOccurrence.status,

              refundStatus: invalidOccurrence.refundStatus,

              occurrenceEndTime: invalidOccurrence.endTime,
            },
          });
        }

        const { requiredProtectedAmount } =
          ShiftAssignmentService.assertShiftProtectedLiabilityCovered({
            shift,

            occurrences: allOccurrences,
          });

        await ShiftAssignmentService.assertEscrowWalletOperationalCoverage({
          shift,

          requiredProtectedAmount,

          session,
        });

        let outgoingRemainsCurrent = previousAssignment.status === "ending";

        if (outgoingRemainsCurrent) {
          const finalized = await ShiftAssignmentService.finalizeEndingAssignmentIfDue({
            assignment: previousAssignment,

            currentTime: assignedAt,

            session,
          });

          outgoingRemainsCurrent = !finalized;
        }

        const range = ShiftAssignmentService.rangeFromOccurrences(occurrences);

        if (outgoingRemainsCurrent && new Date(range.startsAt) <= assignedAt) {
          throw ShiftAssignmentService.createError({
            message:
              "The outgoing assignment is still current, so an already-started replacement occurrence cannot be activated yet.",

            code: "REPLACEMENT_HANDOVER_NOT_REACHED",

            statusCode: 409,

            details: {
              outgoingEffectiveEndsAt: previousAssignment.effectiveEndsAt,

              replacementStartsAt: range.startsAt,

              assignedAt,
            },
          });
        }

        const assignmentStatus = ShiftAssignmentService.resolveNewAssignmentStatus({
          range,

          assignedAt,

          outgoingRemainsCurrent,
        });

        const assignment = await ShiftAssignmentService.createRecord({
          shift,

          input,

          assignmentType: "replacement",

          range,

          assignedAt,

          status: assignmentStatus,

          occurrence: null,

          replacesAssignment: previousAssignment._id,

          replacementCase: replacementCase._id,

          session,
        });

        await ShiftAssignmentService.assignOccurrences({
          shift,

          occurrences,

          input,

          assignment,

          assignedAt,

          expectedAssignmentStatus: "replacement_required",

          previousAssignment,

          replacementCase,

          session,
        });

        /*
         * Tail replacement uses the same idempotent occurrence-level earning
         * authority. Fees already earned by the outgoing assignment remain
         * earned and are not charged again.
         */
        await ShiftAssignmentService.earnBasePlatformFeesForOccurrences({
          occurrences,
          assignedAt,
          session,
        });

        previousAssignment.replacedByAssignment = assignment._id;

        await previousAssignment.save({
          session,
        });

        await ShiftAssignmentService.finalizeReplacementCase({
          assignmentCase: replacementCase,

          assignedAt,

          session,
        });

        ShiftAssignmentService.setParentAssignmentSummary({
          shift,

          assignment: outgoingRemainsCurrent ? previousAssignment : assignment,
        });

        shift.replacementHiring.status = "filled";

        shift.replacementHiring.filledAt = assignedAt;

        shift.replacementHiring.filledByAssignment = assignment._id;

        const refreshedOccurrences = await ShiftAssignmentService.refreshAssignmentProgress({
          shift,

          session,

          currentTime: assignedAt,
        });

        shift.status = ShiftAssignmentService.determineParentOperationalStatus({
          shift,

          occurrences: refreshedOccurrences,

          currentTime: assignedAt,
        });

        await shift.save({
          session,
        });

        logger.info(
          `Replacement assignment ${assignment.referenceCode} created for shift ${shift.referenceCode}`
        );

        return {
          assignment,

          shift,

          replacedAssignment: previousAssignment,

          replacementCase,

          isOccurrenceTargeted: false,

          outgoingAssignmentRemainsCurrent: outgoingRemainsCurrent,

          replacedAssignmentId: String(previousAssignment._id),

          shiftId: String(shift._id),

          professionalId: String(input.professional),

          assignedOccurrenceCount: occurrences.length,

          assignmentStatus: assignment.status,
        };
      }
    );
  }

  /* ─────────────────────────────── SCHEDULED ASSIGNMENT ACTIVATION ─────────────────────────────── */

  static async activateScheduledAssignment(
    { assignmentId, activatedByUserId = null, currentTime = new Date() },
    options = {}
  ) {
    return ShiftAssignmentService.transaction(
      options,

      async (session) => {
        const assignment = await ShiftAssignmentService.getAssignment({
          assignmentId,

          session,
        });

        if (assignment.status === "active") {
          return {
            assignment,

            activated: false,

            idempotent: true,
          };
        }

        if (assignment.status !== "scheduled") {
          throw ShiftAssignmentService.createError({
            message: "Only a scheduled assignment can be activated.",

            code: "ASSIGNMENT_ACTIVATION_NOT_ALLOWED",

            statusCode: 409,

            details: {
              status: assignment.status,
            },
          });
        }

        const activatedAt = ShiftAssignmentService.normalizeDate(currentTime, "activation time");

        if (activatedAt < new Date(assignment.startsAt)) {
          throw ShiftAssignmentService.createError({
            message: "The assignment cannot be activated before its work range begins.",
            code: "ASSIGNMENT_ACTIVATION_NOT_DUE",
            statusCode: 409,
            details: {
              startsAt: assignment.startsAt,
              activatedAt,
            },
          });
        }

        if (activatedAt >= new Date(assignment.plannedEndsAt)) {
          throw ShiftAssignmentService.createError({
            message: "The assignment can no longer be activated because its work range has ended.",

            code: "ASSIGNMENT_ACTIVATION_WINDOW_CLOSED",

            statusCode: 409,
          });
        }

        const activatedBy = activatedByUserId
          ? ShiftAssignmentService.objectId(activatedByUserId, "activated-by user ID")
          : assignment.assignedBy;

        const shift = await ShiftAssignmentService.getShift(assignment.shift, session);

        /*
         * ISOLATED OCCURRENCE ASSIGNMENT
         *
         * The continuing engagement assignment is expected to remain current.
         * Therefore it is not a conflict and must not be finalized.
         */
        if (assignment.occurrence) {
          const occurrence = await ShiftOccurrence.findOne({
            _id: assignment.occurrence,

            shift: shift._id,

            assignment: assignment._id,

            assignedProfessional: assignment.professional,

            assignmentStatus: "assigned",

            endTime: {
              $gt: activatedAt,
            },
          })
            .select(
              [
                "referenceCode",
                "status",
                "assignmentStatus",
                "assignedProfessional",
                "assignment",
                "endTime",
              ].join(" ")
            )
            .session(session);

          if (!occurrence) {
            throw ShiftAssignmentService.createError({
              message:
                "The occurrence assigned to this replacement is no longer available for activation.",

              code: "OCCURRENCE_ASSIGNMENT_ACTIVATION_CONFLICT",

              statusCode: 409,
            });
          }

          assignment.status = "active";

          assignment.activatedAt = activatedAt;

          assignment.activatedBy = activatedBy;

          await assignment.save({
            session,
          });

          /*
           * Do not call setParentAssignmentSummary().
           *
           * Shift.activeAssignment and Shift.assignedProfessional continue to
           * describe the engagement-level professional.
           */

          const occurrences = await ShiftAssignmentService.refreshAssignmentProgress({
            shift,

            session,

            currentTime: activatedAt,
          });

          shift.status = ShiftAssignmentService.determineParentOperationalStatus({
            shift,

            occurrences,

            currentTime: activatedAt,
          });

          await shift.save({
            session,
          });

          return {
            assignment,

            shift,

            occurrence,

            isOccurrenceTargeted: true,

            activated: true,

            idempotent: false,
          };
        }

        /*
         * ORDINARY / TAIL ASSIGNMENT ACTIVATION
         */

        if (assignment.replacesAssignment) {
          const previousAssignment = await ShiftAssignmentService.getAssignment({
            assignmentId: assignment.replacesAssignment,

            shiftId: shift._id,

            session,
          });

          if (previousAssignment.status === "ending") {
            const finalized = await ShiftAssignmentService.finalizeEndingAssignmentIfDue({
              assignment: previousAssignment,

              currentTime: activatedAt,

              session,
            });

            if (!finalized) {
              throw ShiftAssignmentService.createError({
                message: "The outgoing assignment is still responsible for the engagement.",

                code: "REPLACEMENT_HANDOVER_NOT_REACHED",

                statusCode: 409,
              });
            }
          }
        }

        const conflictingCurrentAssignment = await ShiftAssignment.findOne({
          shift: shift._id,

          _id: {
            $ne: assignment._id,
          },

          occurrence: null,

          isCurrentAssignment: true,

          status: {
            $in: CURRENT_ASSIGNMENT_STATUSES,
          },
        }).session(session);

        if (conflictingCurrentAssignment) {
          throw ShiftAssignmentService.createError({
            message: "Another assignment is still current for this engagement.",

            code: "CURRENT_ASSIGNMENT_CONFLICT",

            statusCode: 409,

            details: {
              assignmentId: String(conflictingCurrentAssignment._id),

              status: conflictingCurrentAssignment.status,
            },
          });
        }

        assignment.status = "active";

        assignment.activatedAt = activatedAt;

        assignment.activatedBy = activatedBy;

        await assignment.save({
          session,
        });

        ShiftAssignmentService.setParentAssignmentSummary({
          shift,

          assignment,
        });

        const occurrences = await ShiftAssignmentService.refreshAssignmentProgress({
          shift,

          session,

          currentTime: activatedAt,
        });

        shift.status = ShiftAssignmentService.determineParentOperationalStatus({
          shift,

          occurrences,

          currentTime: activatedAt,
        });

        await shift.save({
          session,
        });

        return {
          assignment,

          shift,

          isOccurrenceTargeted: false,

          activated: true,

          idempotent: false,
        };
      }
    );
  }

  /* ─────────────────────────────── CLOSE COMPLETED OCCURRENCE ASSIGNMENT ─────────────────────────────── */

  static isOccurrenceFinalForIsolatedAssignmentClose(occurrence) {
    if (!RESOLVED_OCCURRENCE_STATUSES.includes(occurrence.status)) {
      return false;
    }

    if (occurrence.activeClaim || occurrence.activeDispute) {
      return false;
    }

    if (PENDING_SETTLEMENT_STATUSES.includes(occurrence.settlementStatus)) {
      return false;
    }

    if (!["not_due", "released"].includes(occurrence.settlementStatus)) {
      return false;
    }

    if (["eligible", "held", "batched", "processing"].includes(occurrence.refundStatus)) {
      return false;
    }

    if (!["not_eligible", "refunded"].includes(occurrence.refundStatus)) {
      return false;
    }

    return true;
  }

  static async closeCompletedOccurrenceAssignment(payload, options = {}) {
    const assignmentId = ShiftAssignmentService.objectId(payload.assignmentId, "assignment ID");

    const shiftId = ShiftAssignmentService.objectId(payload.shiftId, "shift ID");

    const occurrenceId = ShiftAssignmentService.objectId(payload.occurrenceId, "occurrence ID");

    const endedAt = ShiftAssignmentService.normalizeDate(
      payload.endedAt ?? payload.currentTime,
      "ended-at time",
      new Date()
    );

    return ShiftAssignmentService.transaction(
      options,

      async (session) => {
        const assignment = await ShiftAssignmentService.getAssignment({
          assignmentId,

          shiftId,

          session,
        });

        if (!assignment.occurrence) {
          throw ShiftAssignmentService.createError({
            message:
              "Only an occurrence-targeted assignment can be closed through occurrence completion.",
            code: "ASSIGNMENT_NOT_OCCURRENCE_TARGETED",
            statusCode: 409,
          });
        }

        if (String(assignment.occurrence) !== String(occurrenceId)) {
          throw ShiftAssignmentService.createError({
            message: "The assignment does not belong to the supplied occurrence.",
            code: "ASSIGNMENT_OCCURRENCE_MISMATCH",
            statusCode: 409,
          });
        }

        const occurrenceQuery = ShiftOccurrence.findOne({
          _id: occurrenceId,

          shift: shiftId,
        }).select(ShiftAssignmentService.getOccurrenceFields());

        if (session) {
          occurrenceQuery.session(session);
        }

        const occurrence = await occurrenceQuery;

        if (!occurrence) {
          throw ShiftAssignmentService.createError({
            message: "Shift occurrence was not found.",
            code: "SHIFT_OCCURRENCE_NOT_FOUND",
            statusCode: 404,
          });
        }

        const identityMatches =
          String(occurrence.assignment || "") === String(assignment._id) &&
          String(occurrence.assignedProfessional || "") === String(assignment.professional) &&
          occurrence.assignmentStatus === "assigned";

        if (!identityMatches) {
          throw ShiftAssignmentService.createError({
            message:
              "The occurrence no longer matches the occurrence-targeted assignment being closed.",
            code: "OCCURRENCE_ASSIGNMENT_IDENTITY_MISMATCH",
            statusCode: 409,
            details: {
              assignmentId: String(assignment._id),

              occurrenceId: String(occurrence._id),

              occurrenceAssignmentId: occurrence.assignment ? String(occurrence.assignment) : null,

              assignmentProfessionalId: String(assignment.professional),

              occurrenceProfessionalId: occurrence.assignedProfessional
                ? String(occurrence.assignedProfessional)
                : null,

              assignmentStatus: occurrence.assignmentStatus,
            },
          });
        }

        if (assignment.status === "ended" && assignment.endReason === "engagement_completed") {
          return {
            assignment,

            occurrence,

            closed: true,

            idempotent: true,
          };
        }

        if (!["scheduled", "active"].includes(assignment.status)) {
          throw ShiftAssignmentService.createError({
            message:
              "Only a scheduled or active occurrence-targeted assignment can close through normal occurrence completion.",
            code: "OCCURRENCE_ASSIGNMENT_COMPLETION_NOT_ALLOWED",
            statusCode: 409,
            details: {
              status: assignment.status,
            },
          });
        }

        if (!ShiftAssignmentService.isOccurrenceFinalForIsolatedAssignmentClose(occurrence)) {
          throw ShiftAssignmentService.createError({
            message:
              "The occurrence must be operationally, financially and challenge-final before its isolated assignment can close.",
            code: "OCCURRENCE_NOT_FINAL_FOR_ASSIGNMENT_CLOSE",
            statusCode: 409,
            details: {
              occurrenceStatus: occurrence.status,

              settlementStatus: occurrence.settlementStatus,

              refundStatus: occurrence.refundStatus,

              activeClaim: occurrence.activeClaim ? String(occurrence.activeClaim) : null,

              activeDispute: occurrence.activeDispute ? String(occurrence.activeDispute) : null,
            },
          });
        }

        assignment.status = "ended";

        assignment.effectiveEndSequence = assignment.plannedEndSequence;

        assignment.effectiveOccurrenceCount = assignment.plannedOccurrenceCount;

        assignment.effectiveEndsAt = assignment.plannedEndsAt;

        assignment.endedAt = endedAt;

        assignment.endedBy = null;

        assignment.endedByRole = "system";

        assignment.endReason = "engagement_completed";

        assignment.endNotes = null;

        await assignment.save({
          session,
        });

        logger.info(
          `Occurrence assignment ${assignment.referenceCode} closed after occurrence ${occurrence.referenceCode} reached final resolution`
        );

        return {
          assignment,

          occurrence,

          closed: true,

          idempotent: false,
        };
      }
    );
  }

  /* ─────────────────────────────── CLOSE COMPLETED ASSIGNMENT ─────────────────────────────── */

  static async closeCompletedAssignment(payload, options = {}) {
    const endedBy = ShiftAssignmentService.objectId(payload.endedByUserId, "ended-by user ID");

    const endedByRole = ShiftAssignmentService.normalizeActorRole(
      payload.endedByRole || "admin",
      "ended-by role"
    );

    const notes = ShiftAssignmentService.notes(payload.endNotes);

    return ShiftAssignmentService.transaction(
      options,

      async (session) => {
        const shift = await ShiftAssignmentService.getShift(payload.shiftId, session);

        if (
          shift.status !== "completed" ||
          !COMPLETED_ASSIGNMENT_PAYMENT_STATUSES.includes(shift.paymentStatus)
        ) {
          throw ShiftAssignmentService.createError({
            message: "The engagement must be completed and fully released first.",

            code: "ENGAGEMENT_NOT_COMPLETED_FOR_ASSIGNMENT_CLOSE",

            statusCode: 409,
          });
        }

        const assignment = await ShiftAssignment.findOne({
          shift: shift._id,

          occurrence: null,

          isCurrentAssignment: true,

          status: "active",
        })
          .sort({
            assignedAt: -1,
          })
          .session(session);

        if (!assignment) {
          throw ShiftAssignmentService.createError({
            message: "No active engagement assignment is available to close.",

            code: "ACTIVE_SHIFT_ASSIGNMENT_NOT_FOUND",

            statusCode: 404,
          });
        }

        assignment.status = "ended";

        assignment.effectiveEndSequence = assignment.plannedEndSequence;

        assignment.effectiveOccurrenceCount = assignment.plannedOccurrenceCount;

        assignment.effectiveEndsAt = assignment.plannedEndsAt;

        assignment.endedAt = ShiftAssignmentService.normalizeDate(
          payload.endedAt,
          "ended-at time",
          new Date()
        );

        assignment.endedBy = endedBy;

        assignment.endedByRole = endedByRole;

        assignment.endReason = "engagement_completed";

        assignment.endNotes = notes;

        await assignment.save({
          session,
        });

        logger.info(
          `Completed assignment ${assignment.referenceCode} closed for shift ${shift.referenceCode}`
        );

        return {
          assignment,

          shiftId: String(shift._id),
        };
      }
    );
  }
}

module.exports = ShiftAssignmentService;
