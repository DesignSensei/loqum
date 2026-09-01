// models/ShiftOccurrence.js

const mongoose = require("mongoose");

const attendanceLocationSchema = require("./helpers/attendanceLocationSchema");

const {
  minorUnitAmountField,
  nonNegativeIntegerField,
  requiredPositiveMinorUnitAmountField,
} = require("./helpers/schemaFields");

const {
  isValidLocalDateString,
  isValidTimeZone,
  approximatelyEqual,
  hasDocumentValue,
  validateAmountTriple,
} = require("./helpers/schemaValidators");

const {
  amount,
  hasAll,
  hasAny,
  validateDetailsLength,
} = require("./helpers/shiftOccurrenceHelpers");

const {
  MAX_SHIFT_OCCURRENCES,
  MINUTES_PER_DAY,

  OCCURRENCE_ASSIGNMENT_STATUSES,
  EXPIRED_FROM_ASSIGNMENT_STATUSES,

  OCCURRENCE_STATUSES,
  OCCURRENCE_STATUSES_REQUIRING_ASSIGNMENT,

  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUSES_REQUIRING_ASSIGNMENT,
  ATTENDANCE_OVERRIDE_TYPES,
  ATTENDANCE_OVERRIDE_REASONS,

  LATE_CHECKOUT_OPTIONS,
  LATE_CHECKOUT_REASONS,
  CHECKOUT_FALLBACK_REASONS,

  SETTLEMENT_STATUSES,
  SETTLEMENT_STATUSES_REQUIRING_ASSIGNMENT,
  SETTLEMENT_APPROVAL_SOURCES,

  REFUND_STATUSES,
  REFUND_STATUSES_REQUIRING_AMOUNT,
  REFUND_EXECUTION_STATUSES,
  REFUND_HOLD_REASONS,
  REFUND_REASONS,

  REPLACEMENT_REASON_CODES,
  REPLACEMENT_REASON_CODES_REQUIRING_DETAILS,

  OVERTIME_SOURCES,
  OVERTIME_STATUSES,
  OVERTIME_DECISION_SOURCES,
  OVERTIME_REJECTION_BASES,
  OVERTIME_ADMIN_REVIEW_REASONS,
  OVERTIME_ADMIN_DECISIONS,

  OCCURRENCE_EVIDENCE_TYPES,
  OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,

  CANCELLATION_ACTORS,
  USER_CANCELLATION_ACTORS,
  ACTIVE_WORK_CANCELLATION_INITIATORS,

  OCCURRENCE_CANCELLATION_CODES,
  CANCELLATION_CODE_ACTORS,
} = require("../constants/shiftLifecycle");

const {
  SETTLEMENT_COMPONENT_STATUSES,
  SETTLEMENT_LINE_EARNING_TYPES,
} = require("../constants/shiftSettlement");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");

function isSupportedFinancialRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return false;
  }

  try {
    money.scaleRate({
      rate: value,
      rateScale: FINANCIAL_RATE_SCALE,
      fieldName: "Financial rate",
    });

    return true;
  } catch (error) {
    return false;
  }
}

const CHALLENGE_WINDOW_ALLOWED_OCCURRENCE_STATUSES = Object.freeze([
  "pending_settlement",
  "completed",
  "cancelled",
  "no_show",
  "disputed",
]);

const BASE_SETTLEMENT_EARNING_TYPES = Object.freeze([
  "worked_base",
  "cancellation_compensation",
  "active_work_cancellation",
]);

const OVERTIME_SETTLEMENT_EARNING_TYPES = Object.freeze(["overtime"]);

const CHALLENGEABLE_SETTLEMENT_COMPONENTS = Object.freeze(["base", "overtime"]);

/* ─────────────────────────────── CANCELLATION COMPENSATION ─────────────────────────────── */

const cancellationCompensationSchema = new mongoose.Schema(
  {
    applicable: {
      type: Boolean,
      default: false,
    },

    rate: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,

      validate: {
        validator: isSupportedFinancialRate,

        message: "cancellationCompensation.rate must use the supported financial rate precision.",
      },
    },

    windowMinutes: {
      type: Number,
      default: null,
      min: 0,

      validate: {
        validator: (value) => value === null || Number.isSafeInteger(value),

        message: "cancellationCompensation.windowMinutes must be a whole number.",
      },
    },

    professionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    calculatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── ACTIVE-WORK CANCELLATION ─────────────────────────────── */

const activeWorkCancellationSchema = new mongoose.Schema(
  {
    occurred: {
      type: Boolean,
      default: false,
    },

    initiatedBy: {
      type: String,
      enum: [...ACTIVE_WORK_CANCELLATION_INITIATORS, null],
      default: null,
    },

    initiatedByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    reason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    requestedAt: {
      type: Date,
      default: null,
    },

    effectiveAt: {
      type: Date,
      default: null,
    },

    actualWorkedMinutes: {
      type: Number,
      default: 0,
      min: 0,
      max: MINUTES_PER_DAY,

      validate: {
        validator: Number.isSafeInteger,

        message: "activeWorkCancellation.actualWorkedMinutes must be a whole number.",
      },
    },

    minimumProfessionalPayRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,

      validate: {
        validator: isSupportedFinancialRate,

        message:
          "activeWorkCancellation.minimumProfessionalPayRate must use the supported financial rate precision.",
      },
    },

    actualWorkedProfessionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    minimumGuaranteedProfessionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    professionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    calculatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── PROFESSIONAL SETTLEMENT COMPONENT ─────────────────────────────── */

const settlementComponentAuditSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: SETTLEMENT_COMPONENT_STATUSES,
      default: "not_due",
      required: true,
    },

    earningType: {
      type: String,
      enum: [...SETTLEMENT_LINE_EARNING_TYPES, null],
      default: null,
    },

    professionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    approvedForReleaseAt: {
      type: Date,
      default: null,
    },

    approvalSource: {
      type: String,
      enum: [...SETTLEMENT_APPROVAL_SOURCES, null],
      default: null,
    },

    approvedForReleaseBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    scheduledPayoutAt: {
      type: Date,
      default: null,
    },

    settlementBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftSettlementBatch",
      default: null,
    },

    releasePendingAt: {
      type: Date,
      default: null,
    },

    releasedAt: {
      type: Date,
      default: null,
    },

    payoutTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── PLATFORM FEE AUDIT ─────────────────────────────── */

const platformFeeAuditSchema = new mongoose.Schema(
  {
    earnedAt: {
      type: Date,
      default: null,
    },

    outstandingAt: {
      type: Date,
      default: null,
    },

    collectedAt: {
      type: Date,
      default: null,
    },

    collectionTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── OCCURRENCE EVIDENCE ─────────────────────────────── */

const occurrenceEvidenceItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: OCCURRENCE_EVIDENCE_TYPES,
      required: true,
    },

    reference: {
      type: String,
      trim: true,
      maxlength: 1000,
      required: true,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    submittedByRole: {
      type: String,
      enum: OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,
      required: true,
    },

    submittedByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    recordedAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── SHIFT OCCURRENCE ─────────────────────────────── */

const shiftOccurrenceSchema = new mongoose.Schema(
  {
    // --- CORE IDENTITY ---

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    sequenceNumber: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,

      validate: {
        validator: Number.isSafeInteger,

        message: "sequenceNumber must be a whole number.",
      },
    },

    // --- ASSIGNMENT ---

    assignmentStatus: {
      type: String,
      enum: OCCURRENCE_ASSIGNMENT_STATUSES,
      default: "unassigned",
      required: true,
    },

    assignedProfessional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    // --- REPLACEMENT ---

    replacementRequiredAt: {
      type: Date,
      default: null,
    },

    replacementForAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    replacementCase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignmentCase",
      default: null,
    },

    replacementReasonCode: {
      type: String,
      enum: [...REPLACEMENT_REASON_CODES, null],
      default: null,
    },

    replacementReasonDetails: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // --- SCHEDULE ---

    occurrenceDate: {
      type: String,
      trim: true,
      required: true,

      validate: {
        validator: isValidLocalDateString,

        message: "occurrenceDate must be a valid date in YYYY-MM-DD format.",
      },
    },

    scheduleTimeZone: {
      type: String,
      trim: true,
      maxlength: 100,
      required: true,

      validate: {
        validator: isValidTimeZone,

        message: "scheduleTimeZone must be a valid IANA timezone.",
      },
    },

    startTime: {
      type: Date,
      required: true,
      index: true,
    },

    endTime: {
      type: Date,
      required: true,
    },

    scheduledMinutes: {
      type: Number,
      required: true,
      min: 1,
      max: MINUTES_PER_DAY,

      validate: {
        validator: Number.isSafeInteger,

        message: "scheduledMinutes must be a whole number.",
      },
    },

    scheduledHours: {
      type: Number,
      required: true,
      min: 1 / 60,
    },

    breakDuration: {
      type: Number,
      default: 0,
      min: 0,
      max: MINUTES_PER_DAY,

      validate: {
        validator: Number.isSafeInteger,

        message: "breakDuration must be a whole number of minutes.",
      },
    },

    fillCutoffAt: {
      type: Date,
      required: true,
      index: true,
    },

    unfilledFinalizationAt: {
      type: Date,
      default: null,
    },

    // --- OCCURRENCE CHALLENGE WINDOW ---

    challengeWindowOpenedAt: {
      type: Date,
      default: null,
    },

    challengeDeadlineAt: {
      type: Date,
      default: null,
    },

    challengeWindowClosedAt: {
      type: Date,
      default: null,
    },

    challengeableSettlementComponents: {
      type: [
        {
          type: String,
          enum: CHALLENGEABLE_SETTLEMENT_COMPONENTS,
        },
      ],
      default: [],
    },

    /**
     * activeClaim and activeDispute may coexist when they concern genuinely
     * different ordinary issues.
     */
    activeClaim: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrenceClaim",
      default: null,
    },

    activeDispute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrenceDispute",
      default: null,
    },

    // --- PRICING SNAPSHOT ---

    hourlyRate: requiredPositiveMinorUnitAmountField(),

    platformFeeRate: {
      type: Number,
      required: true,
      min: 0,
      max: 1,

      validate: {
        validator: isSupportedFinancialRate,

        message: "platformFeeRate must use the supported financial rate precision.",
      },
    },

    estimatedProfessionalPay: requiredPositiveMinorUnitAmountField(),

    estimatedPlatformFee: minorUnitAmountField({
      required: true,
    }),

    estimatedEmployerCharge: requiredPositiveMinorUnitAmountField(),

    // --- BASE / SCHEDULED FINANCIAL OUTCOME ---

    baseProfessionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    basePlatformFee: minorUnitAmountField({
      defaultValue: 0,
    }),

    // --- OVERTIME FINANCIAL OUTCOME ---

    overtimeProfessionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    overtimePlatformFee: minorUnitAmountField({
      defaultValue: 0,
    }),

    topUpRequired: minorUnitAmountField({
      defaultValue: 0,
    }),

    // --- BILLABLE TIME ---

    baseBillableHours: {
      type: Number,
      default: null,
      min: 0,
    },

    billableHours: {
      type: Number,
      default: null,
      min: 0,
    },

    // --- PLATFORM FEE LIFECYCLE ---

    basePlatformFeeAudit: {
      type: platformFeeAuditSchema,
      default: () => ({}),
    },

    overtimePlatformFeeAudit: {
      type: platformFeeAuditSchema,
      default: () => ({}),
    },

    // --- EMPLOYER REFUND SUMMARY ---

    refundableAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

    refundedAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

    refundStatus: {
      type: String,
      enum: REFUND_STATUSES,
      default: "not_eligible",
      required: true,
    },

    refundReason: {
      type: String,
      enum: [...REFUND_REASONS, null],
      default: null,
    },

    refundEligibleAt: {
      type: Date,
      default: null,
    },

    refundLastEvaluatedAt: {
      type: Date,
      default: null,
    },

    refundHeldAt: {
      type: Date,
      default: null,
    },

    refundHoldReason: {
      type: String,
      enum: [...REFUND_HOLD_REASONS, null],
      default: null,
    },

    employerRefund: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefund",
      default: null,
    },

    refundBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefundBatch",
      default: null,
    },

    refundProcessingStartedAt: {
      type: Date,
      default: null,
    },

    refundedAt: {
      type: Date,
      default: null,
    },

    // --- OCCURRENCE STATE ---

    status: {
      type: String,
      enum: OCCURRENCE_STATUSES,
      default: "scheduled",
      required: true,
    },

    attendanceStatus: {
      type: String,
      enum: ATTENDANCE_STATUSES,
      default: "not_started",
      required: true,
    },

    settlementStatus: {
      type: String,
      enum: SETTLEMENT_STATUSES,
      default: "not_due",
      required: true,
    },

    // --- PROFESSIONAL SETTLEMENT COMPONENTS ---

    baseSettlement: {
      type: settlementComponentAuditSchema,
      default: () => ({}),
    },

    overtimeSettlement: {
      type: settlementComponentAuditSchema,
      default: () => ({}),
    },

    // --- PROFESSIONAL SETTLEMENT COMPLETION ---

    settledAt: {
      type: Date,
      default: null,
    },

    // --- EXPIRED UNFILLED ---

    expiredFromAssignmentStatus: {
      type: String,
      enum: [...EXPIRED_FROM_ASSIGNMENT_STATUSES, null],
      default: null,
    },

    expiredUnfilledAt: {
      type: Date,
      default: null,
    },

    // --- ATTENDANCE ---

    checkedInAt: {
      type: Date,
      default: null,
    },

    /**
     * Raw checkout audit.
     *
     * A late checkout is never rewritten back to scheduled endTime merely
     * because the professional says the extra time was not worked overtime.
     */
    checkedOutAt: {
      type: Date,
      default: null,
    },

    // --- ABSENCE EXPLANATION ---

    absenceExplanation: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    absenceExplainedAt: {
      type: Date,
      default: null,
    },

    checkInLocation: {
      type: attendanceLocationSchema,
      default: () => ({}),
    },

    checkOutLocation: {
      type: attendanceLocationSchema,
      default: () => ({}),
    },

    // --- ATTENDANCE PINS ---

    checkInPin: {
      type: String,
      required: true,
      select: false,

      match: [/^\d{4}$/, "checkInPin must contain exactly four digits."],
    },

    checkOutPin: {
      type: String,
      required: true,
      select: false,

      match: [/^\d{4}$/, "checkOutPin must contain exactly four digits."],
    },

    attendancePinsGeneratedAt: {
      type: Date,
      required: true,
    },

    checkInPinUsedAt: {
      type: Date,
      default: null,
    },

    checkOutPinUsedAt: {
      type: Date,
      default: null,
    },

    // --- ATTENDANCE OVERRIDE ---

    attendanceOverride: {
      used: {
        type: Boolean,
        default: false,
      },

      type: {
        type: String,
        enum: [...ATTENDANCE_OVERRIDE_TYPES, null],
        default: null,
      },

      reason: {
        type: String,
        enum: [...ATTENDANCE_OVERRIDE_REASONS, null],
        default: null,
      },

      approvedStartTime: {
        type: Date,
        default: null,
      },

      approvedEndTime: {
        type: Date,
        default: null,
      },

      reviewedAt: {
        type: Date,
        default: null,
      },

      reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      notes: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },
    },

    // --- LATE CHECKOUT ---

    lateCheckout: {
      occurred: {
        type: Boolean,
        default: false,
      },

      minutesLate: nonNegativeIntegerField(),

      selectedOption: {
        type: String,
        enum: [...LATE_CHECKOUT_OPTIONS, null],
        default: null,
      },

      /**
       * Populated only for normal_late_checkout.
       *
       * overtime_requested uses the dedicated overtime record instead.
       */
      reason: {
        type: String,
        enum: [...LATE_CHECKOUT_REASONS, null],
        default: null,
      },

      notes: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },

      recordedAt: {
        type: Date,
        default: null,
      },
    },

    // --- CHECKOUT FALLBACK ---

    checkoutFallback: {
      required: {
        type: Boolean,
        default: false,
      },

      reason: {
        type: String,
        enum: [...CHECKOUT_FALLBACK_REASONS, null],
        default: null,
      },

      requestedAt: {
        type: Date,
        default: null,
      },

      resolvedAt: {
        type: Date,
        default: null,
      },

      resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      approvedEndTime: {
        type: Date,
        default: null,
      },

      notes: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },
    },

    // --- OVERTIME ---

    overtime: {
      requested: {
        type: Boolean,
        default: false,
      },

      requestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      requestedAt: {
        type: Date,
        default: null,
      },

      source: {
        type: String,
        enum: [...OVERTIME_SOURCES, null],
        default: null,
      },

      /**
       * Professional's factual account of the work said to have continued
       * beyond the scheduled end time.
       *
       * This is required for both late_checkout_prompt and manual_request.
       * Supporting documentary evidence remains optional.
       */
      requestStatement: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: null,
      },

      requestEvidence: {
        type: [occurrenceEvidenceItemSchema],
        default: [],
      },

      /**
       * Immutable OT duration originally requested by the professional.
       */
      requestedMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: MINUTES_PER_DAY,

        validate: {
          validator: (value) => value === null || Number.isSafeInteger(value),

          message: "overtime.requestedMinutes must be a whole number.",
        },
      },

      /**
       * Final payable OT duration.
       *
       * Employer approval accepts requestedMinutes exactly.
       * Admin may establish a different evidence-supported duration when
       * resolving an employer rejection or employer non-response.
       */
      approvedMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: MINUTES_PER_DAY,

        validate: {
          validator: (value) => value === null || Number.isSafeInteger(value),

          message: "overtime.approvedMinutes must be a whole number.",
        },
      },

      status: {
        type: String,
        enum: [...OVERTIME_STATUSES, null],
        default: null,
      },

      /**
       * Final OT decision authority.
       *
       * employer:
       * Employer approved the professional's request.
       *
       * admin:
       * Admin made the final decision after employer rejection or employer
       * non-response.
       *
       * Employer rejection itself is not a final decision, so decisionSource
       * remains null while status is disputed.
       */
      decisionSource: {
        type: String,
        enum: [...OVERTIME_DECISION_SOURCES, null],
        default: null,
      },

      employerResponseDeadlineAt: {
        type: Date,
        default: null,
      },

      employerRespondedAt: {
        type: Date,
        default: null,
      },

      /**
       * Historical employer response delinquency audit.
       */
      employerResponseOverdueAt: {
        type: Date,
        default: null,
      },

      /**
       * Final positive OT approval audit.
       */
      approvedAt: {
        type: Date,
        default: null,
      },

      approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      // --- EMPLOYER OT REJECTION ---

      /**
       * Employer rejection is an adverse factual position, not a final OT
       * decision. A rejection moves the OT request directly to admin review.
       */
      rejectedAt: {
        type: Date,
        default: null,
      },

      rejectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      rejectionBasis: {
        type: String,
        enum: [...OVERTIME_REJECTION_BASES, null],
        default: null,
      },

      rejectionReason: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: null,
      },

      /**
       * Structured employer counter-position used only when the employer
       * accepts that some OT was worked but disputes the requested duration.
       */
      employerProposedMinutes: {
        type: Number,
        default: null,
        min: 1,
        max: MINUTES_PER_DAY,

        validate: {
          validator: (value) => value === null || Number.isSafeInteger(value),

          message: "overtime.employerProposedMinutes must be a whole number.",
        },
      },

      rejectionEvidence: {
        type: [occurrenceEvidenceItemSchema],
        default: [],
      },

      /**
       * Explicit employer declaration used when no supporting documentary
       * evidence exists.
       *
       * It must be true only when rejectionEvidence is empty.
       */
      rejectionNoSupportingEvidence: {
        type: Boolean,
        default: false,
      },

      // --- ADMIN OT REVIEW / FINAL DECISION ---

      adminReviewReason: {
        type: String,
        enum: [...OVERTIME_ADMIN_REVIEW_REASONS, null],
        default: null,
      },

      adminReviewStartedAt: {
        type: Date,
        default: null,
      },

      /**
       * Supporting evidence added by an administrator while OT is under
       * adjudication. System-owned occurrence facts remain authoritative in
       * their own fields and do not need to be duplicated here.
       */
      adminEvidence: {
        type: [occurrenceEvidenceItemSchema],
        default: [],
      },

      adminDecision: {
        type: String,
        enum: [...OVERTIME_ADMIN_DECISIONS, null],
        default: null,
      },

      adminDecidedAt: {
        type: Date,
        default: null,
      },

      adminDecidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      adminDecisionReason: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: null,
      },

      // --- OT FUNDING / DELINQUENCY ---

      topUpAmount: minorUnitAmountField({
        defaultValue: 0,
      }),

      topUpDeadlineAt: {
        type: Date,
        default: null,
      },

      /**
       * Historical and retained after payment.
       */
      topUpOverdueAt: {
        type: Date,
        default: null,
      },

      /**
       * Historical and retained after payment.
       */
      restrictionTriggeredAt: {
        type: Date,
        default: null,
      },

      topUpPaid: {
        type: Boolean,
        default: false,
      },

      topUpPaidAt: {
        type: Date,
        default: null,
      },
    },

    // --- TRANSACTION REFERENCES ---

    topUpTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    // --- CANCELLATION ---

    cancellationCode: {
      type: String,
      enum: [...OCCURRENCE_CANCELLATION_CODES, null],
      default: null,
    },

    cancelledBy: {
      type: String,
      enum: [...CANCELLATION_ACTORS, null],
      default: null,
    },

    cancelledByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancellationCompensation: {
      type: cancellationCompensationSchema,
      default: () => ({}),
    },

    activeWorkCancellation: {
      type: activeWorkCancellationSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── VALIDATION HELPERS ─────────────────────────────── */

function hasPlatformFeeAuditData(audit) {
  return Boolean(
    audit?.earnedAt || audit?.outstandingAt || audit?.collectedAt || audit?.collectionTransaction
  );
}

function hasSettlementComponentData(component) {
  return Boolean(
    component?.earningType ||
    amount(component?.professionalPay) > 0 ||
    component?.approvedForReleaseAt ||
    component?.approvalSource ||
    component?.approvedForReleaseBy ||
    component?.scheduledPayoutAt ||
    component?.settlementBatch ||
    component?.releasePendingAt ||
    component?.releasedAt ||
    component?.payoutTransaction
  );
}

function hasOvertimeFinancialData(document) {
  return Boolean(
    amount(document.overtimeProfessionalPay) > 0 ||
    amount(document.overtimePlatformFee) > 0 ||
    amount(document.overtime?.topUpAmount) > 0 ||
    amount(document.topUpRequired) > 0 ||
    document.overtime?.topUpDeadlineAt ||
    document.overtime?.topUpOverdueAt ||
    document.overtime?.restrictionTriggeredAt ||
    document.overtime?.topUpPaid === true ||
    document.overtime?.topUpPaidAt ||
    document.topUpTransaction ||
    hasPlatformFeeAuditData(document.overtimePlatformFeeAudit || {})
  );
}

function validatePlatformFeeAudit(document, audit, pathPrefix, feeAmount) {
  const normalizedFeeAmount = amount(feeAmount);

  const hasAudit = hasPlatformFeeAuditData(audit);

  if (normalizedFeeAmount <= 0) {
    if (hasAudit) {
      document.invalidate(
        pathPrefix,
        `${pathPrefix} must be empty when the corresponding platform fee amount is zero.`
      );
    }

    return;
  }

  if (!audit?.earnedAt) {
    document.invalidate(
      `${pathPrefix}.earnedAt`,
      `${pathPrefix}.earnedAt is required when the platform fee is positive.`
    );
  }

  if (audit?.outstandingAt && audit?.earnedAt && audit.outstandingAt < audit.earnedAt) {
    document.invalidate(
      `${pathPrefix}.outstandingAt`,
      `${pathPrefix}.outstandingAt cannot be earlier than earnedAt.`
    );
  }

  if (audit?.collectedAt && audit?.earnedAt && audit.collectedAt < audit.earnedAt) {
    document.invalidate(
      `${pathPrefix}.collectedAt`,
      `${pathPrefix}.collectedAt cannot be earlier than earnedAt.`
    );
  }

  if (Boolean(audit?.collectedAt) !== Boolean(audit?.collectionTransaction)) {
    document.invalidate(
      audit?.collectedAt ? `${pathPrefix}.collectionTransaction` : `${pathPrefix}.collectedAt`,
      `${pathPrefix}.collectedAt and collectionTransaction must be recorded together.`
    );
  }

  if (audit?.collectedAt && audit?.outstandingAt) {
    document.invalidate(
      `${pathPrefix}.outstandingAt`,
      `${pathPrefix}.outstandingAt must be cleared once the fee is collected.`
    );
  }
}

function validateSettlementComponentAudit(document, component, pathPrefix) {
  const status = component?.status || "not_due";

  const professionalPay = amount(component?.professionalPay);

  if (status === "not_due") {
    if (hasSettlementComponentData(component)) {
      document.invalidate(
        pathPrefix,
        `${pathPrefix} must contain no professional payout audit while status is not_due.`
      );
    }

    return;
  }

  if (!component?.earningType) {
    document.invalidate(
      `${pathPrefix}.earningType`,
      `${pathPrefix}.earningType is required once the component is payout-ready.`
    );
  }

  if (professionalPay <= 0) {
    document.invalidate(
      `${pathPrefix}.professionalPay`,
      `${pathPrefix}.professionalPay must be greater than zero once payout-ready.`
    );
  }

  if (
    !component?.approvedForReleaseAt ||
    !component?.approvalSource ||
    !component?.scheduledPayoutAt
  ) {
    document.invalidate(
      pathPrefix,
      `${pathPrefix} requires approvedForReleaseAt, approvalSource and scheduledPayoutAt once payout-ready.`
    );
  }

  if (component?.approvalSource === "automatic" && component?.approvedForReleaseBy) {
    document.invalidate(
      `${pathPrefix}.approvedForReleaseBy`,
      `Automatic ${pathPrefix} approval cannot contain approvedForReleaseBy.`
    );
  }

  if (
    ["admin", "dispute_resolution"].includes(component?.approvalSource) &&
    !component?.approvedForReleaseBy
  ) {
    document.invalidate(
      `${pathPrefix}.approvedForReleaseBy`,
      `${component.approvalSource} ${pathPrefix} approval requires approvedForReleaseBy.`
    );
  }

  if (
    component?.scheduledPayoutAt &&
    component?.approvedForReleaseAt &&
    component.scheduledPayoutAt < component.approvedForReleaseAt
  ) {
    document.invalidate(
      `${pathPrefix}.scheduledPayoutAt`,
      `${pathPrefix}.scheduledPayoutAt cannot be earlier than approvedForReleaseAt.`
    );
  }

  if (status === "approved_for_release") {
    if (
      component?.settlementBatch ||
      component?.releasePendingAt ||
      component?.releasedAt ||
      component?.payoutTransaction
    ) {
      document.invalidate(
        pathPrefix,
        `${pathPrefix} approved_for_release cannot contain payout-execution details.`
      );
    }

    return;
  }

  if (status === "release_pending") {
    if (!component?.settlementBatch || !component?.releasePendingAt) {
      document.invalidate(
        pathPrefix,
        `${pathPrefix} release_pending requires settlementBatch and releasePendingAt.`
      );
    }

    if (component?.releasedAt || component?.payoutTransaction) {
      document.invalidate(
        pathPrefix,
        `${pathPrefix} release_pending cannot contain completed payout details.`
      );
    }

    if (
      component?.releasePendingAt &&
      component?.approvedForReleaseAt &&
      component.releasePendingAt < component.approvedForReleaseAt
    ) {
      document.invalidate(
        `${pathPrefix}.releasePendingAt`,
        `${pathPrefix}.releasePendingAt cannot be earlier than approvedForReleaseAt.`
      );
    }

    return;
  }

  if (status === "released") {
    if (
      !component?.settlementBatch ||
      !component?.releasePendingAt ||
      !component?.releasedAt ||
      !component?.payoutTransaction
    ) {
      document.invalidate(
        pathPrefix,
        `${pathPrefix} released requires batch, release timing and professional payout transaction details.`
      );
    }

    if (
      component?.releasedAt &&
      component?.releasePendingAt &&
      component.releasedAt < component.releasePendingAt
    ) {
      document.invalidate(
        `${pathPrefix}.releasedAt`,
        `${pathPrefix}.releasedAt cannot be earlier than releasePendingAt.`
      );
    }

    if (
      component?.releasedAt &&
      component?.scheduledPayoutAt &&
      component.releasedAt < component.scheduledPayoutAt
    ) {
      document.invalidate(
        `${pathPrefix}.releasedAt`,
        `${pathPrefix}.releasedAt cannot be earlier than scheduledPayoutAt.`
      );
    }
  }
}

function getChallengeComponents(document) {
  const values = Array.isArray(document.challengeableSettlementComponents)
    ? document.challengeableSettlementComponents.map((value) =>
        String(value || "")
          .trim()
          .toLowerCase()
      )
    : [];

  const uniqueValues = [...new Set(values)];

  if (
    uniqueValues.length !== values.length ||
    uniqueValues.some((value) => !CHALLENGEABLE_SETTLEMENT_COMPONENTS.includes(value))
  ) {
    document.invalidate(
      "challengeableSettlementComponents",
      "challengeableSettlementComponents must contain unique base/overtime component values."
    );
  }

  return uniqueValues;
}

function isOrdinaryChallengeWindowOpen(document) {
  return Boolean(
    document.challengeWindowOpenedAt &&
    document.challengeDeadlineAt &&
    !document.challengeWindowClosedAt
  );
}

function validateChallengeWindow(document) {
  const challengeComponents = getChallengeComponents(document);

  const hasActiveClaim = hasDocumentValue(document.activeClaim);

  const hasActiveDispute = hasDocumentValue(document.activeDispute);

  const hasWindowOpening = hasAll([document.challengeWindowOpenedAt, document.challengeDeadlineAt]);

  const hasAnyWindowAudit = Boolean(
    document.challengeWindowOpenedAt ||
    document.challengeDeadlineAt ||
    document.challengeWindowClosedAt ||
    challengeComponents.length > 0 ||
    hasActiveClaim ||
    hasActiveDispute
  );

  const ordinaryWindowOpen = isOrdinaryChallengeWindowOpen(document);

  if (hasAnyWindowAudit && (!document.challengeWindowOpenedAt || !document.challengeDeadlineAt)) {
    document.invalidate(
      "challengeDeadlineAt",
      "Occurrence challenge audit requires challengeWindowOpenedAt and challengeDeadlineAt together."
    );
  }

  if (
    document.challengeWindowOpenedAt &&
    document.challengeDeadlineAt &&
    document.challengeDeadlineAt <= document.challengeWindowOpenedAt
  ) {
    document.invalidate(
      "challengeDeadlineAt",
      "challengeDeadlineAt must be later than challengeWindowOpenedAt."
    );
  }

  /**
   * Claim/dispute submission does not close the shared clock.
   *
   * A submitted case becomes immutable in its own model. The shared
   * challenge window closes only at or after challengeDeadlineAt.
   */
  if (
    document.challengeWindowClosedAt &&
    document.challengeDeadlineAt &&
    document.challengeWindowClosedAt < document.challengeDeadlineAt
  ) {
    document.invalidate(
      "challengeWindowClosedAt",
      "challengeWindowClosedAt cannot be earlier than challengeDeadlineAt."
    );
  }

  if (hasAnyWindowAudit && document.assignmentStatus !== "assigned") {
    document.invalidate(
      "challengeWindowOpenedAt",
      "Only an assigned occurrence may contain a challenge window or ordinary challenge case."
    );
  }

  if (
    hasAnyWindowAudit &&
    !CHALLENGE_WINDOW_ALLOWED_OCCURRENCE_STATUSES.includes(document.status)
  ) {
    document.invalidate(
      "challengeWindowOpenedAt",
      "Occurrence challenge audit requires a challengeable financial or attendance outcome."
    );
  }

  /**
   * activeClaim and activeDispute may coexist.
   *
   * Whether the two cases concern genuinely different issues is enforced by
   * the claim/dispute services, which can inspect both case documents.
   */

  if (document.challengeWindowClosedAt && challengeComponents.length > 0) {
    document.invalidate(
      "challengeableSettlementComponents",
      "A closed ordinary challenge window cannot retain ordinarily challengeable settlement components."
    );
  }

  if (!hasWindowOpening && challengeComponents.length > 0) {
    document.invalidate(
      "challengeableSettlementComponents",
      "challengeableSettlementComponents requires an established challenge window."
    );
  }

  /**
   * An open time envelope may contain zero challengeable components.
   *
   * Example:
   * both sides have already consumed their one original ordinary challenge
   * rights, but challengeDeadlineAt has not yet arrived.
   */

  const overtimeSelectionConsumed = document.overtime?.requested === true;

  if (overtimeSelectionConsumed && challengeComponents.includes("overtime")) {
    document.invalidate(
      "challengeableSettlementComponents",
      "Overtime cannot remain ordinarily challengeable after the professional has submitted an overtime request."
    );
  }

  if (challengeComponents.includes("base") && document.baseSettlement?.status !== "not_due") {
    document.invalidate(
      "baseSettlement.status",
      "BASE cannot become payout-ready while it remains ordinarily challengeable."
    );
  }

  if (
    challengeComponents.includes("overtime") &&
    document.overtimeSettlement?.status !== "not_due"
  ) {
    document.invalidate(
      "overtimeSettlement.status",
      "Overtime cannot become payout-ready while it remains ordinarily challengeable."
    );
  }

  if (document.status === "completed" && ordinaryWindowOpen) {
    document.invalidate(
      "challengeWindowClosedAt",
      "A completed occurrence cannot retain an open ordinary challenge window."
    );
  }

  if (document.status === "completed" && (hasActiveClaim || hasActiveDispute)) {
    document.invalidate(
      hasActiveClaim ? "activeClaim" : "activeDispute",
      "A completed occurrence cannot retain an unresolved ordinary challenge case."
    );
  }
}

function validateSchedule(document) {
  if (document.startTime && document.endTime) {
    if (document.endTime <= document.startTime) {
      document.invalidate("endTime", "endTime must be later than startTime.");
    } else {
      const actualMinutes =
        (document.endTime.getTime() - document.startTime.getTime()) / (60 * 1000);

      if (
        !Number.isSafeInteger(actualMinutes) ||
        actualMinutes < 1 ||
        actualMinutes > MINUTES_PER_DAY
      ) {
        document.invalidate(
          "endTime",
          "Occurrence duration must be a whole number of minutes between 1 and 1440."
        );
      } else {
        if (document.scheduledMinutes !== actualMinutes) {
          document.invalidate(
            "scheduledMinutes",
            "scheduledMinutes must match startTime and endTime."
          );
        }

        if (!approximatelyEqual(Number(document.scheduledHours), actualMinutes / 60)) {
          document.invalidate("scheduledHours", "scheduledHours must match scheduledMinutes.");
        }

        if (document.breakDuration >= actualMinutes) {
          document.invalidate(
            "breakDuration",
            "breakDuration must be shorter than the occurrence duration."
          );
        }
      }
    }
  }

  if (document.assignedAt && document.endTime && document.assignedAt >= document.endTime) {
    document.invalidate("assignedAt", "assignedAt must be earlier than endTime.");
  }

  if (document.assignedAt && document.fillCutoffAt && document.assignedAt > document.fillCutoffAt) {
    document.invalidate("assignedAt", "assignedAt cannot be later than fillCutoffAt.");
  }

  if (document.fillCutoffAt && document.endTime && document.fillCutoffAt > document.endTime) {
    document.invalidate("fillCutoffAt", "fillCutoffAt cannot be later than endTime.");
  }

  if (
    document.fillCutoffAt &&
    document.unfilledFinalizationAt &&
    document.unfilledFinalizationAt <= document.fillCutoffAt
  ) {
    document.invalidate(
      "unfilledFinalizationAt",
      "unfilledFinalizationAt must be later than fillCutoffAt."
    );
  }
}

function validateReplacementAndAssignment(document) {
  const assignmentStatus = document.assignmentStatus || "unassigned";

  const assignedValues = [document.assignedProfessional, document.assignment, document.assignedAt];

  const hasCompleteAssignment = hasAll(assignedValues);

  const hasAnyAssignment = hasAny(assignedValues);

  const replacementCoreValues = [
    document.replacementRequiredAt,
    document.replacementForAssignment,
    document.replacementReasonCode,
  ];

  const hasCompleteReplacementAudit = hasAll(replacementCoreValues);

  const hasReplacementAudit =
    hasAny([...replacementCoreValues, document.replacementCase]) ||
    hasDocumentValue(document.replacementReasonDetails);

  if (hasReplacementAudit && !hasCompleteReplacementAudit) {
    document.invalidate(
      "replacementReasonCode",
      "Replacement audit requires replacementRequiredAt, replacementForAssignment and replacementReasonCode together."
    );
  }

  if (
    hasCompleteReplacementAudit &&
    REPLACEMENT_REASON_CODES_REQUIRING_DETAILS.includes(document.replacementReasonCode) &&
    !document.replacementReasonDetails
  ) {
    document.invalidate(
      "replacementReasonDetails",
      `${document.replacementReasonCode} requires replacement details.`
    );
  }

  validateDetailsLength(
    document,
    "replacementReasonDetails",
    document.replacementReasonDetails,
    "Replacement details"
  );

  if (assignmentStatus === "assigned") {
    if (!hasCompleteAssignment) {
      document.invalidate(
        "assignmentStatus",
        "An assigned occurrence requires assignedProfessional, assignment and assignedAt."
      );
    }

    if (document.unfilledFinalizationAt) {
      document.invalidate(
        "unfilledFinalizationAt",
        "An assigned occurrence cannot retain an unfilled finalization deadline."
      );
    }
  } else if (hasAnyAssignment) {
    document.invalidate(
      "assignmentStatus",
      "A non-assigned occurrence cannot retain assignedProfessional, assignment or assignedAt."
    );
  }

  if (assignmentStatus === "unassigned") {
    if (!["scheduled", "cancelled"].includes(document.status)) {
      document.invalidate(
        "status",
        "An unassigned occurrence may only remain scheduled or be cancelled."
      );
    }

    if (!document.unfilledFinalizationAt) {
      document.invalidate(
        "unfilledFinalizationAt",
        "An unassigned occurrence requires unfilledFinalizationAt."
      );
    }

    if (hasReplacementAudit) {
      document.invalidate(
        "replacementReasonCode",
        "An ordinary unassigned occurrence cannot retain replacement audit data."
      );
    }

    if (document.status === "scheduled" && document.refundStatus !== "not_eligible") {
      document.invalidate(
        "refundStatus",
        "A scheduled unassigned occurrence cannot enter the refund workflow."
      );
    }
  }

  if (assignmentStatus === "replacement_required") {
    if (!hasCompleteReplacementAudit) {
      document.invalidate(
        "replacementReasonCode",
        "replacement_required requires complete replacement audit data."
      );
    }

    if (!document.unfilledFinalizationAt) {
      document.invalidate(
        "unfilledFinalizationAt",
        "replacement_required requires unfilledFinalizationAt."
      );
    }

    if (!["scheduled", "cancelled"].includes(document.status)) {
      document.invalidate(
        "status",
        "A replacement-required occurrence may only be scheduled or cancelled."
      );
    }

    if (document.attendanceStatus !== "not_started" || document.settlementStatus !== "not_due") {
      document.invalidate(
        "assignmentStatus",
        "A replacement-required occurrence cannot have attendance or professional-settlement activity."
      );
    }

    if (
      document.checkedInAt ||
      document.checkedOutAt ||
      document.checkInPinUsedAt ||
      document.checkOutPinUsedAt
    ) {
      document.invalidate(
        "assignmentStatus",
        "An occurrence with attendance activity cannot require replacement."
      );
    }

    if (document.status === "scheduled" && document.refundStatus !== "not_eligible") {
      document.invalidate(
        "refundStatus",
        "A scheduled replacement-required occurrence cannot enter the refund workflow."
      );
    }
  }

  if (assignmentStatus === "expired_unfilled") {
    if (document.status !== "expired_unfilled") {
      document.invalidate(
        "status",
        "expired_unfilled assignmentStatus requires expired_unfilled status."
      );
    }

    if (!document.expiredFromAssignmentStatus) {
      document.invalidate(
        "expiredFromAssignmentStatus",
        "expiredFromAssignmentStatus is required when an occurrence expires unfilled."
      );
    }

    if (!document.unfilledFinalizationAt) {
      document.invalidate(
        "unfilledFinalizationAt",
        "An expired-unfilled occurrence must retain unfilledFinalizationAt."
      );
    }

    if (
      document.expiredFromAssignmentStatus === "replacement_required" &&
      !hasCompleteReplacementAudit
    ) {
      document.invalidate(
        "replacementReasonCode",
        "An occurrence that expired from replacement_required must retain complete replacement audit data."
      );
    }

    if (document.expiredFromAssignmentStatus === "unassigned" && hasReplacementAudit) {
      document.invalidate(
        "replacementReasonCode",
        "An occurrence that expired from unassigned cannot retain replacement audit data."
      );
    }
  } else if (document.expiredFromAssignmentStatus) {
    document.invalidate(
      "expiredFromAssignmentStatus",
      "expiredFromAssignmentStatus may only be set when assignmentStatus is expired_unfilled."
    );
  }

  if (document.status === "expired_unfilled" && assignmentStatus !== "expired_unfilled") {
    document.invalidate(
      "assignmentStatus",
      "expired_unfilled status requires expired_unfilled assignmentStatus."
    );
  }

  const assignmentRequired =
    OCCURRENCE_STATUSES_REQUIRING_ASSIGNMENT.includes(document.status) ||
    ATTENDANCE_STATUSES_REQUIRING_ASSIGNMENT.includes(document.attendanceStatus) ||
    SETTLEMENT_STATUSES_REQUIRING_ASSIGNMENT.includes(document.settlementStatus);

  if (assignmentRequired && (assignmentStatus !== "assigned" || !hasCompleteAssignment)) {
    document.invalidate(
      "assignmentStatus",
      "Attendance and professional-settlement activity require a complete professional assignment."
    );
  }

  return {
    assignmentStatus,
    hasCompleteAssignment,
    hasReplacementAudit,
  };
}

function validatePricing(document) {
  validateAmountTriple(document, {
    professionalPath: "estimatedProfessionalPay",
    platformPath: "estimatedPlatformFee",
    employerPath: "estimatedEmployerCharge",
    label: "Estimated",
  });

  const hourlyRate = amount(document.hourlyRate);

  const scheduledMinutes = Number(document.scheduledMinutes);

  const platformFeeRate = Number(document.platformFeeRate);

  const estimatedProfessionalPay = amount(document.estimatedProfessionalPay);

  const estimatedPlatformFee = amount(document.estimatedPlatformFee);

  const baseProfessionalPay = amount(document.baseProfessionalPay);

  let expectedProfessionalPay = null;

  if (
    Number.isSafeInteger(hourlyRate) &&
    hourlyRate > 0 &&
    Number.isSafeInteger(scheduledMinutes) &&
    scheduledMinutes > 0
  ) {
    try {
      expectedProfessionalPay = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: hourlyRate,
        minutes: scheduledMinutes,
        fieldName: "Estimated occurrence professional pay",
      });
    } catch (error) {
      document.invalidate(
        "estimatedProfessionalPay",
        "The estimated professional-pay calculation is invalid or too large."
      );
    }
  }

  if (
    Number.isSafeInteger(expectedProfessionalPay) &&
    estimatedProfessionalPay !== expectedProfessionalPay
  ) {
    document.invalidate(
      "estimatedProfessionalPay",
      "estimatedProfessionalPay must be calculated from hourlyRate and scheduledMinutes."
    );
  }

  if (Number.isSafeInteger(expectedProfessionalPay) && isSupportedFinancialRate(platformFeeRate)) {
    let expectedPlatformFee = null;

    try {
      expectedPlatformFee = money.calculateMinorAmountFromRate({
        amountMinor: expectedProfessionalPay,
        rate: platformFeeRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "Estimated occurrence platform fee",
        rateFieldName: "Platform fee rate",
      });
    } catch (error) {
      document.invalidate(
        "estimatedPlatformFee",
        "The estimated platform-fee calculation is invalid or too large."
      );
    }

    if (Number.isSafeInteger(expectedPlatformFee) && estimatedPlatformFee !== expectedPlatformFee) {
      document.invalidate(
        "estimatedPlatformFee",
        "estimatedPlatformFee must be calculated from estimatedProfessionalPay and platformFeeRate."
      );
    }
  }

  if (
    baseProfessionalPay > estimatedProfessionalPay &&
    document.activeWorkCancellation?.occurred !== true
  ) {
    document.invalidate(
      "baseProfessionalPay",
      "baseProfessionalPay cannot exceed the scheduled professional-pay snapshot."
    );
  }

  if (hasDocumentValue(document.baseBillableHours)) {
    if (Number(document.baseBillableHours) > Number(document.scheduledHours)) {
      document.invalidate("baseBillableHours", "baseBillableHours cannot exceed scheduledHours.");
    }
  }

  if (hasDocumentValue(document.billableHours) && hasDocumentValue(document.baseBillableHours)) {
    const approvedOvertimeHours =
      document.overtime?.status === "approved"
        ? Number(document.overtime.approvedMinutes || 0) / 60
        : 0;

    if (
      !approximatelyEqual(
        Number(document.billableHours),
        Number(document.baseBillableHours) + approvedOvertimeHours
      )
    ) {
      document.invalidate(
        "billableHours",
        "billableHours must equal baseBillableHours plus approved overtime hours."
      );
    }
  }
}

function validatePlatformFees(document, assignmentContext) {
  const baseFee = amount(document.basePlatformFee);

  const overtimeFee = amount(document.overtimePlatformFee);

  const baseAudit = document.basePlatformFeeAudit || {};

  const overtimeAudit = document.overtimePlatformFeeAudit || {};

  validatePlatformFeeAudit(document, baseAudit, "basePlatformFeeAudit", baseFee);

  validatePlatformFeeAudit(document, overtimeAudit, "overtimePlatformFeeAudit", overtimeFee);

  if (baseFee > 0 && baseFee !== amount(document.estimatedPlatformFee)) {
    document.invalidate(
      "basePlatformFee",
      "Once earned, basePlatformFee must equal the occurrence estimatedPlatformFee snapshot."
    );
  }

  /**
   * BASE fee is protected by the original Shift funding.
   *
   * It cannot become an employer-outstanding debt. Its collection audit is
   * nevertheless separate from professional payout authority.
   */
  if (baseAudit.outstandingAt) {
    document.invalidate(
      "basePlatformFeeAudit.outstandingAt",
      "Scheduled/base platform fee cannot be employer-outstanding because the original Shift allocation was prefunded."
    );
  }

  if (
    assignmentContext.assignmentStatus === "unassigned" &&
    !document.replacementForAssignment &&
    (baseFee > 0 || hasPlatformFeeAuditData(baseAudit))
  ) {
    document.invalidate(
      "basePlatformFee",
      "An occurrence that has never had a professional engagement cannot have an earned base platform fee."
    );
  }

  const overtime = document.overtime || {};

  if (overtime.status === "approved") {
    const overtimeProfessionalPay = amount(document.overtimeProfessionalPay);

    const platformFeeRate = Number(document.platformFeeRate);

    let expectedFee = null;

    if (
      Number.isSafeInteger(overtimeProfessionalPay) &&
      overtimeProfessionalPay > 0 &&
      isSupportedFinancialRate(platformFeeRate)
    ) {
      try {
        expectedFee = money.calculateMinorAmountFromRate({
          amountMinor: overtimeProfessionalPay,
          rate: platformFeeRate,
          rateScale: FINANCIAL_RATE_SCALE,
          fieldName: "Overtime platform fee",
          rateFieldName: "Platform fee rate",
        });
      } catch (error) {
        document.invalidate(
          "overtimePlatformFee",
          "The approved overtime platform-fee calculation is invalid or too large."
        );
      }
    }

    if (Number.isSafeInteger(expectedFee) && overtimeFee !== expectedFee) {
      document.invalidate(
        "overtimePlatformFee",
        "Approved overtimePlatformFee must be calculated from overtimeProfessionalPay and platformFeeRate."
      );
    }

    if (overtimeFee > 0) {
      if (!overtimeAudit.earnedAt) {
        document.invalidate(
          "overtimePlatformFeeAudit.earnedAt",
          "Approved overtime with a positive platform fee must record when the fee was earned."
        );
      }

      if (
        overtime.approvedAt &&
        overtimeAudit.earnedAt &&
        overtimeAudit.earnedAt.getTime() !== overtime.approvedAt.getTime()
      ) {
        document.invalidate(
          "overtimePlatformFeeAudit.earnedAt",
          "Overtime platform fee earnedAt must match the final overtime approval time."
        );
      }

      if (!overtime.topUpPaid && !overtimeAudit.outstandingAt) {
        document.invalidate(
          "overtimePlatformFeeAudit.outstandingAt",
          "An earned overtime platform fee must remain outstanding until the employer top-up is funded."
        );
      }

      /**
       * Collection problems must not become professional payout authority.
       *
       * Once the employer top-up is funded, fee collection is handled by the
       * separate platform-fee service. Professional payout remains governed
       * by the funded OT settlement component.
       */
      if (overtimeAudit.collectedAt && overtime.topUpPaid !== true) {
        document.invalidate(
          "overtimePlatformFeeAudit.collectedAt",
          "Overtime platform fee cannot be collected before the employer top-up is funded."
        );
      }
    }
  } else if (overtimeFee > 0 || hasPlatformFeeAuditData(overtimeAudit)) {
    document.invalidate(
      "overtimePlatformFee",
      "Overtime platform fee may only exist after overtime entitlement is finally approved."
    );
  }
}

function validateSettlementComponents(document) {
  const baseSettlement = document.baseSettlement || {};

  const overtimeSettlement = document.overtimeSettlement || {};

  validateSettlementComponentAudit(document, baseSettlement, "baseSettlement");

  validateSettlementComponentAudit(document, overtimeSettlement, "overtimeSettlement");

  const baseStatus = baseSettlement.status || "not_due";

  const overtimeStatus = overtimeSettlement.status || "not_due";

  const baseProfessionalPay = amount(document.baseProfessionalPay);

  const overtimeProfessionalPay = amount(document.overtimeProfessionalPay);

  if (baseStatus !== "not_due") {
    if (!BASE_SETTLEMENT_EARNING_TYPES.includes(baseSettlement.earningType)) {
      document.invalidate(
        "baseSettlement.earningType",
        "Base settlement must use worked_base, cancellation_compensation or active_work_cancellation."
      );
    }

    if (amount(baseSettlement.professionalPay) !== baseProfessionalPay) {
      document.invalidate(
        "baseSettlement.professionalPay",
        "Base settlement professionalPay must match baseProfessionalPay."
      );
    }

    if (baseProfessionalPay <= 0) {
      document.invalidate(
        "baseProfessionalPay",
        "A payout-ready base settlement requires positive baseProfessionalPay."
      );
    }

    if (
      baseSettlement.earningType === "worked_base" &&
      ["cancelled", "no_show", "expired_unfilled"].includes(document.status)
    ) {
      document.invalidate(
        "baseSettlement.earningType",
        "worked_base is not valid for cancelled, no-show or expired-unfilled occurrences."
      );
    }

    if (
      baseSettlement.earningType === "cancellation_compensation" &&
      (document.status !== "cancelled" || document.cancellationCompensation?.applicable !== true)
    ) {
      document.invalidate(
        "baseSettlement.earningType",
        "cancellation_compensation requires a compensated cancelled occurrence."
      );
    }

    if (
      baseSettlement.earningType === "active_work_cancellation" &&
      document.activeWorkCancellation?.occurred !== true
    ) {
      document.invalidate(
        "baseSettlement.earningType",
        "active_work_cancellation requires an active-work cancellation outcome."
      );
    }
  }

  if (overtimeStatus !== "not_due") {
    if (!OVERTIME_SETTLEMENT_EARNING_TYPES.includes(overtimeSettlement.earningType)) {
      document.invalidate(
        "overtimeSettlement.earningType",
        "Overtime settlement must use overtime earningType."
      );
    }

    if (document.overtime?.requested !== true || document.overtime?.status !== "approved") {
      document.invalidate(
        "overtimeSettlement",
        "A payout-ready overtime settlement requires approved overtime."
      );
    }

    if (
      document.overtime?.topUpPaid !== true ||
      !document.overtime?.topUpPaidAt ||
      !document.topUpTransaction ||
      amount(document.topUpRequired) !== 0
    ) {
      document.invalidate(
        "overtimeSettlement",
        "Overtime cannot become payout-ready until its full employer top-up has been funded."
      );
    }

    if (amount(overtimeSettlement.professionalPay) !== overtimeProfessionalPay) {
      document.invalidate(
        "overtimeSettlement.professionalPay",
        "Overtime settlement professionalPay must match overtimeProfessionalPay."
      );
    }
  }

  if (
    (baseStatus !== "not_due" || overtimeStatus !== "not_due") &&
    document.assignmentStatus !== "assigned"
  ) {
    document.invalidate(
      baseStatus !== "not_due" ? "baseSettlement.status" : "overtimeSettlement.status",
      "Professional payout components require an assigned occurrence."
    );
  }
}

function validateAttendance(document) {
  if (document.status === "scheduled") {
    if (document.attendanceStatus !== "not_started" || document.settlementStatus !== "not_due") {
      document.invalidate(
        "status",
        "A scheduled occurrence cannot have attendance or professional-settlement activity."
      );
    }
  }

  if (document.status === "in_progress") {
    if (document.attendanceStatus !== "checked_in" || !document.checkedInAt) {
      document.invalidate(
        "attendanceStatus",
        "An in-progress occurrence requires checked-in attendance."
      );
    }

    if (document.settlementStatus !== "not_due") {
      document.invalidate(
        "settlementStatus",
        "An in-progress occurrence cannot enter professional settlement."
      );
    }
  }

  if (document.attendanceStatus === "checked_in" && document.status !== "in_progress") {
    document.invalidate("status", "checked_in attendance requires in_progress status.");
  }

  if (["checked_out", "settled"].includes(document.attendanceStatus)) {
    if (!document.checkedInAt || !document.checkedOutAt) {
      document.invalidate(
        "checkedOutAt",
        `${document.attendanceStatus} attendance requires checkedInAt and checkedOutAt.`
      );
    }
  }

  if (document.checkedOutAt && !document.checkedInAt) {
    document.invalidate("checkedInAt", "checkedInAt is required before checkedOutAt.");
  }

  if (
    document.checkedInAt &&
    document.checkedOutAt &&
    document.checkedOutAt <= document.checkedInAt
  ) {
    document.invalidate("checkedOutAt", "checkedOutAt must be later than checkedInAt.");
  }

  if (document.checkedInAt && document.assignedAt && document.checkedInAt < document.assignedAt) {
    document.invalidate("checkedInAt", "checkedInAt cannot be earlier than assignedAt.");
  }

  if (document.checkedInAt && document.endTime && document.checkedInAt >= document.endTime) {
    document.invalidate("checkedInAt", "checkedInAt must be earlier than endTime.");
  }

  if (document.checkInPinUsedAt && !document.checkedInAt) {
    document.invalidate("checkInPinUsedAt", "checkInPinUsedAt requires checkedInAt.");
  }

  if (document.checkOutPinUsedAt && !document.checkedOutAt) {
    document.invalidate("checkOutPinUsedAt", "checkOutPinUsedAt requires checkedOutAt.");
  }

  if (
    document.attendancePinsGeneratedAt &&
    document.checkInPinUsedAt &&
    document.checkInPinUsedAt < document.attendancePinsGeneratedAt
  ) {
    document.invalidate(
      "checkInPinUsedAt",
      "checkInPinUsedAt cannot be earlier than attendancePinsGeneratedAt."
    );
  }

  if (
    document.attendancePinsGeneratedAt &&
    document.checkOutPinUsedAt &&
    document.checkOutPinUsedAt < document.attendancePinsGeneratedAt
  ) {
    document.invalidate(
      "checkOutPinUsedAt",
      "checkOutPinUsedAt cannot be earlier than attendancePinsGeneratedAt."
    );
  }

  if (
    document.checkInPinUsedAt &&
    document.checkOutPinUsedAt &&
    document.checkOutPinUsedAt <= document.checkInPinUsedAt
  ) {
    document.invalidate(
      "checkOutPinUsedAt",
      "checkOutPinUsedAt must be later than checkInPinUsedAt."
    );
  }

  if (document.status === "pending_settlement") {
    if (
      !["checked_out", "missed_checkin_review", "checkout_fallback_review", "disputed"].includes(
        document.attendanceStatus
      )
    ) {
      document.invalidate(
        "attendanceStatus",
        "pending_settlement requires checked-out, review or disputed attendance."
      );
    }

    if (
      ["missed_checkin_review", "checkout_fallback_review"].includes(document.attendanceStatus) &&
      document.settlementStatus !== "not_due"
    ) {
      document.invalidate(
        "settlementStatus",
        "Unresolved attendance review must finish before professional settlement begins."
      );
    }
  }

  if (
    document.attendanceStatus === "checked_out" &&
    !["pending_settlement", "disputed"].includes(document.status)
  ) {
    document.invalidate(
      "status",
      "checked_out attendance requires pending_settlement or disputed status."
    );
  }

  if (document.attendanceStatus === "settled" && document.status !== "completed") {
    document.invalidate("status", "settled attendance requires completed status.");
  }

  if (document.status === "no_show" || document.attendanceStatus === "no_show") {
    if (document.status !== "no_show" || document.attendanceStatus !== "no_show") {
      document.invalidate(
        "attendanceStatus",
        "No-show occurrence and attendance statuses must be set together."
      );
    }

    if (
      document.checkedInAt ||
      document.checkedOutAt ||
      document.checkInPinUsedAt ||
      document.checkOutPinUsedAt
    ) {
      document.invalidate(
        "status",
        "A no-show occurrence cannot contain attendance timestamps or used PINs."
      );
    }
  }
}

function validateAbsenceAndAttendanceReviewDetails(document) {
  const hasAbsenceExplanation = hasDocumentValue(document.absenceExplanation);

  const hasAbsenceExplainedAt = hasDocumentValue(document.absenceExplainedAt);

  if (hasAbsenceExplanation !== hasAbsenceExplainedAt) {
    document.invalidate(
      hasAbsenceExplanation ? "absenceExplainedAt" : "absenceExplanation",
      "absenceExplanation and absenceExplainedAt must be recorded together."
    );
  }

  if (hasAbsenceExplanation) {
    if (document.status !== "no_show" || document.attendanceStatus !== "no_show") {
      document.invalidate(
        "absenceExplanation",
        "An absence explanation may only be recorded for a confirmed no-show occurrence."
      );
    }

    if (typeof document.absenceExplanation !== "string" || !document.absenceExplanation.trim()) {
      document.invalidate("absenceExplanation", "An absence explanation cannot be empty.");
    }

    if (
      document.absenceExplainedAt &&
      document.endTime &&
      document.absenceExplainedAt < document.endTime
    ) {
      document.invalidate(
        "absenceExplainedAt",
        "An absence explanation cannot be submitted before the occurrence has ended."
      );
    }
  }

  const attendanceOverride = document.attendanceOverride || {};

  const attendanceOverrideHasData =
    attendanceOverride.used === true ||
    hasAny([
      attendanceOverride.type,
      attendanceOverride.reason,
      attendanceOverride.approvedStartTime,
      attendanceOverride.approvedEndTime,
      attendanceOverride.reviewedAt,
      attendanceOverride.reviewedBy,
      attendanceOverride.notes,
    ]);

  if (attendanceOverride.used) {
    if (
      !attendanceOverride.type ||
      !attendanceOverride.reason ||
      !attendanceOverride.reviewedAt ||
      !attendanceOverride.reviewedBy
    ) {
      document.invalidate(
        "attendanceOverride",
        "Attendance override requires type, reason, reviewedAt and reviewedBy."
      );
    }

    if (
      ["checkin", "both"].includes(attendanceOverride.type) &&
      !attendanceOverride.approvedStartTime
    ) {
      document.invalidate(
        "attendanceOverride.approvedStartTime",
        "A check-in override requires approvedStartTime."
      );
    }

    if (
      ["checkout", "both"].includes(attendanceOverride.type) &&
      !attendanceOverride.approvedEndTime
    ) {
      document.invalidate(
        "attendanceOverride.approvedEndTime",
        "A checkout override requires approvedEndTime."
      );
    }

    if (
      attendanceOverride.approvedStartTime &&
      attendanceOverride.approvedEndTime &&
      attendanceOverride.approvedEndTime <= attendanceOverride.approvedStartTime
    ) {
      document.invalidate(
        "attendanceOverride.approvedEndTime",
        "approvedEndTime must be later than approvedStartTime."
      );
    }

    validateDetailsLength(
      document,
      "attendanceOverride.notes",
      attendanceOverride.notes,
      "Attendance override notes"
    );
  } else if (attendanceOverrideHasData) {
    document.invalidate(
      "attendanceOverride.used",
      "Attendance override details require used to be true."
    );
  }

  const lateCheckout = document.lateCheckout || {};

  const lateCheckoutHasData =
    lateCheckout.occurred === true ||
    amount(lateCheckout.minutesLate) > 0 ||
    hasAny([
      lateCheckout.selectedOption,
      lateCheckout.reason,
      lateCheckout.notes,
      lateCheckout.recordedAt,
    ]);

  if (lateCheckout.occurred) {
    if (
      amount(lateCheckout.minutesLate) <= 0 ||
      !lateCheckout.selectedOption ||
      !lateCheckout.recordedAt
    ) {
      document.invalidate(
        "lateCheckout",
        "Late checkout requires positive minutesLate, selectedOption and recordedAt."
      );
    }

    if (!document.checkedOutAt || !document.endTime || document.checkedOutAt <= document.endTime) {
      document.invalidate(
        "lateCheckout.occurred",
        "Late checkout requires a raw checkedOutAt later than the scheduled endTime."
      );
    }

    if (
      lateCheckout.recordedAt &&
      document.checkedOutAt &&
      lateCheckout.recordedAt < document.checkedOutAt
    ) {
      document.invalidate(
        "lateCheckout.recordedAt",
        "lateCheckout.recordedAt cannot be earlier than the raw checkout time."
      );
    }

    if (lateCheckout.selectedOption === "normal_late_checkout") {
      if (!lateCheckout.reason) {
        document.invalidate(
          "lateCheckout.reason",
          "A non-overtime late checkout requires a reason."
        );
      }

      if (lateCheckout.reason === "other" && !lateCheckout.notes) {
        document.invalidate(
          "lateCheckout.notes",
          "The other late-checkout reason requires an explanation."
        );
      }
    }

    if (lateCheckout.selectedOption === "overtime_requested" && lateCheckout.reason) {
      document.invalidate(
        "lateCheckout.reason",
        "Worked overtime is represented by the overtime request; the non-overtime late-checkout reason must be empty."
      );
    }

    validateDetailsLength(
      document,
      "lateCheckout.notes",
      lateCheckout.notes,
      "Late-checkout notes"
    );
  } else if (lateCheckoutHasData) {
    document.invalidate(
      "lateCheckout.occurred",
      "Late-checkout details require occurred to be true."
    );
  }

  const checkoutFallback = document.checkoutFallback || {};

  const checkoutFallbackHasData =
    checkoutFallback.required === true ||
    hasAny([
      checkoutFallback.reason,
      checkoutFallback.requestedAt,
      checkoutFallback.resolvedAt,
      checkoutFallback.resolvedBy,
      checkoutFallback.approvedEndTime,
      checkoutFallback.notes,
    ]);

  if (checkoutFallback.required) {
    if (!checkoutFallback.reason || !checkoutFallback.requestedAt) {
      document.invalidate("checkoutFallback", "Checkout fallback requires reason and requestedAt.");
    }

    if (checkoutFallback.resolvedAt) {
      if (!checkoutFallback.resolvedBy || !checkoutFallback.approvedEndTime) {
        document.invalidate(
          "checkoutFallback.resolvedAt",
          "Resolved checkout fallback requires resolvedBy and approvedEndTime."
        );
      }

      if (
        checkoutFallback.requestedAt &&
        checkoutFallback.resolvedAt < checkoutFallback.requestedAt
      ) {
        document.invalidate(
          "checkoutFallback.resolvedAt",
          "Checkout fallback cannot be resolved before it is requested."
        );
      }
    } else if (checkoutFallback.resolvedBy || checkoutFallback.approvedEndTime) {
      document.invalidate(
        "checkoutFallback.resolvedAt",
        "Checkout fallback resolution details require resolvedAt."
      );
    }

    if (
      checkoutFallback.approvedEndTime &&
      document.checkedInAt &&
      checkoutFallback.approvedEndTime <= document.checkedInAt
    ) {
      document.invalidate(
        "checkoutFallback.approvedEndTime",
        "approvedEndTime must be later than checkedInAt."
      );
    }

    validateDetailsLength(
      document,
      "checkoutFallback.notes",
      checkoutFallback.notes,
      "Checkout fallback notes"
    );
  } else if (checkoutFallbackHasData) {
    document.invalidate(
      "checkoutFallback.required",
      "Checkout fallback details require required to be true."
    );
  }

  if (
    document.attendanceStatus === "checkout_fallback_review" &&
    (!checkoutFallback.required || checkoutFallback.resolvedAt)
  ) {
    document.invalidate(
      "checkoutFallback.required",
      "checkout_fallback_review requires an unresolved checkout fallback."
    );
  }

  /**
   * missed_checkin_review deliberately does not require activeClaim.
   *
   * "I did not work" → absence explanation workflow.
   *
   * "I worked" → attendance_correction claim.
   */
}

function validateExpiredUnfilled(document) {
  if (document.status !== "expired_unfilled") {
    if (document.expiredUnfilledAt) {
      document.invalidate(
        "expiredUnfilledAt",
        "expiredUnfilledAt may only be set for expired_unfilled status."
      );
    }

    return;
  }

  if (!document.expiredUnfilledAt || !document.unfilledFinalizationAt) {
    document.invalidate(
      "expiredUnfilledAt",
      "expired_unfilled requires expiredUnfilledAt and unfilledFinalizationAt."
    );
  }

  if (
    document.expiredUnfilledAt &&
    document.unfilledFinalizationAt &&
    document.expiredUnfilledAt < document.unfilledFinalizationAt
  ) {
    document.invalidate(
      "expiredUnfilledAt",
      "expiredUnfilledAt cannot be earlier than unfilledFinalizationAt."
    );
  }

  if (document.attendanceStatus !== "not_started" || document.settlementStatus !== "not_due") {
    document.invalidate(
      "status",
      "expired_unfilled cannot have attendance or professional settlement."
    );
  }

  if (
    document.checkedInAt ||
    document.checkedOutAt ||
    document.checkInPinUsedAt ||
    document.checkOutPinUsedAt
  ) {
    document.invalidate("status", "expired_unfilled cannot contain attendance activity.");
  }

  if (amount(document.baseBillableHours) !== 0 || amount(document.billableHours) !== 0) {
    document.invalidate("billableHours", "expired_unfilled must have zero billable hours.");
  }

  if (
    amount(document.baseProfessionalPay) !== 0 ||
    amount(document.overtimeProfessionalPay) !== 0
  ) {
    document.invalidate(
      amount(document.baseProfessionalPay) !== 0
        ? "baseProfessionalPay"
        : "overtimeProfessionalPay",
      "expired_unfilled cannot contain professional earnings."
    );
  }

  if (
    hasOvertimeFinancialData(document) ||
    document.overtime?.requested ||
    document.overtime?.status
  ) {
    document.invalidate(
      "overtime.status",
      "expired_unfilled cannot contain overtime or top-up activity."
    );
  }

  if (document.settledAt || document.topUpTransaction) {
    document.invalidate(
      "settlementStatus",
      "expired_unfilled cannot retain professional-settlement completion or top-up details."
    );
  }
}

function getAuthoritativeAttendanceEnd(document) {
  const attendanceOverride = document.attendanceOverride || {};

  if (
    attendanceOverride.used === true &&
    ["checkout", "both"].includes(attendanceOverride.type) &&
    attendanceOverride.approvedEndTime
  ) {
    return attendanceOverride.approvedEndTime;
  }

  const checkoutFallback = document.checkoutFallback || {};

  if (
    checkoutFallback.required === true &&
    checkoutFallback.resolvedAt &&
    checkoutFallback.approvedEndTime
  ) {
    return checkoutFallback.approvedEndTime;
  }

  return document.checkedOutAt || null;
}

function validateOvertimeEvidenceItems(
  document,
  evidenceItems,
  pathPrefix,
  expectedRole,
  expectedUserId,
  earliestRecordedAt
) {
  const items = Array.isArray(evidenceItems) ? evidenceItems : [];

  items.forEach((item, index) => {
    const itemPath = `${pathPrefix}.${index}`;

    if (item?.submittedByRole !== expectedRole) {
      document.invalidate(
        `${itemPath}.submittedByRole`,
        `${pathPrefix} may only contain ${expectedRole}-submitted evidence.`
      );
    }

    if (
      expectedUserId &&
      item?.submittedByUser &&
      String(item.submittedByUser) !== String(expectedUserId)
    ) {
      document.invalidate(
        `${itemPath}.submittedByUser`,
        `${pathPrefix} submittedByUser must match the user who submitted that OT position.`
      );
    }

    if (item?.recordedAt && earliestRecordedAt && item.recordedAt < earliestRecordedAt) {
      document.invalidate(
        `${itemPath}.recordedAt`,
        `${pathPrefix} evidence cannot be recorded before the related OT position was submitted.`
      );
    }
  });

  return items;
}

function validateOvertime(document) {
  const overtime = document.overtime || {};

  const overtimeProfessionalPay = amount(document.overtimeProfessionalPay);

  const overtimePlatformFee = amount(document.overtimePlatformFee);

  const topUpRequired = amount(document.topUpRequired);

  const topUpAmount = amount(overtime.topUpAmount);

  const requestedMinutes = Number(overtime.requestedMinutes || 0);

  const approvedMinutes = Number(overtime.approvedMinutes || 0);

  const requestEvidence = Array.isArray(overtime.requestEvidence) ? overtime.requestEvidence : [];

  const rejectionEvidence = Array.isArray(overtime.rejectionEvidence)
    ? overtime.rejectionEvidence
    : [];

  const adminEvidence = Array.isArray(overtime.adminEvidence) ? overtime.adminEvidence : [];

  const hasEmployerRejectionAudit = Boolean(
    overtime.rejectedAt ||
    overtime.rejectedBy ||
    overtime.rejectionBasis ||
    overtime.rejectionReason ||
    hasDocumentValue(overtime.employerProposedMinutes) ||
    rejectionEvidence.length > 0 ||
    overtime.rejectionNoSupportingEvidence === true
  );

  const hasAdminReviewAudit = Boolean(overtime.adminReviewReason || overtime.adminReviewStartedAt);

  const hasAdminDecisionAudit = hasAny([
    overtime.adminDecision,
    overtime.adminDecidedAt,
    overtime.adminDecidedBy,
    overtime.adminDecisionReason,
  ]);

  const overtimeHasData =
    overtime.requested === true ||
    hasAny([
      overtime.requestedBy,
      overtime.requestedAt,
      overtime.source,
      overtime.requestStatement,
      overtime.requestedMinutes,
      overtime.approvedMinutes,
      overtime.status,
      overtime.decisionSource,
      overtime.employerResponseDeadlineAt,
      overtime.employerRespondedAt,
      overtime.employerResponseOverdueAt,
      overtime.approvedAt,
      overtime.approvedBy,
      overtime.rejectedAt,
      overtime.rejectedBy,
      overtime.rejectionBasis,
      overtime.rejectionReason,
      overtime.employerProposedMinutes,
      overtime.adminReviewReason,
      overtime.adminReviewStartedAt,
      overtime.adminDecision,
      overtime.adminDecidedAt,
      overtime.adminDecidedBy,
      overtime.adminDecisionReason,
      overtime.topUpAmount,
      overtime.topUpDeadlineAt,
      overtime.topUpOverdueAt,
      overtime.restrictionTriggeredAt,
      overtime.topUpPaidAt,
      document.topUpTransaction,
    ]) ||
    requestEvidence.length > 0 ||
    rejectionEvidence.length > 0 ||
    adminEvidence.length > 0 ||
    overtime.rejectionNoSupportingEvidence === true ||
    overtime.topUpPaid === true ||
    overtimeProfessionalPay > 0 ||
    overtimePlatformFee > 0 ||
    topUpRequired > 0 ||
    hasPlatformFeeAuditData(document.overtimePlatformFeeAudit || {});

  if (!overtime.requested) {
    if (overtimeHasData) {
      document.invalidate("overtime.requested", "Overtime details require requested to be true.");
    }

    if (document.lateCheckout?.selectedOption === "overtime_requested") {
      document.invalidate(
        "overtime.requested",
        "The overtime_requested checkout option requires an overtime request."
      );
    }

    return;
  }

  if (
    !overtime.requestedBy ||
    !overtime.requestedAt ||
    !overtime.source ||
    !overtime.requestStatement ||
    !overtime.status ||
    !Number.isSafeInteger(requestedMinutes) ||
    requestedMinutes <= 0
  ) {
    document.invalidate(
      "overtime.requestedAt",
      "Requested overtime requires requester, request time, source, factual statement, status and positive whole requestedMinutes."
    );
  }

  validateDetailsLength(
    document,
    "overtime.requestStatement",
    overtime.requestStatement,
    "Overtime request statement"
  );

  validateOvertimeEvidenceItems(
    document,
    requestEvidence,
    "overtime.requestEvidence",
    "professional",
    overtime.requestedBy,
    overtime.requestedAt
  );

  if (overtime.requestedAt && document.endTime && overtime.requestedAt < document.endTime) {
    document.invalidate(
      "overtime.requestedAt",
      "Overtime cannot be requested before the scheduled occurrence has ended."
    );
  }

  if (!overtime.employerResponseDeadlineAt) {
    document.invalidate(
      "overtime.employerResponseDeadlineAt",
      "Requested overtime requires an employer response deadline."
    );
  }

  if (
    overtime.requestedAt &&
    overtime.employerResponseDeadlineAt &&
    overtime.employerResponseDeadlineAt <= overtime.requestedAt
  ) {
    document.invalidate(
      "overtime.employerResponseDeadlineAt",
      "The overtime response deadline must be later than requestedAt."
    );
  }

  if (overtime.source === "manual_request") {
    if (!document.challengeWindowOpenedAt || !document.challengeDeadlineAt) {
      document.invalidate(
        "overtime.requestedAt",
        "A manual overtime request requires the shared occurrence review window."
      );
    } else {
      if (overtime.requestedAt < document.challengeWindowOpenedAt) {
        document.invalidate(
          "overtime.requestedAt",
          "A manual overtime request cannot predate the shared occurrence review window."
        );
      }

      if (overtime.requestedAt >= document.challengeDeadlineAt) {
        document.invalidate(
          "overtime.requestedAt",
          "A manual overtime request must be submitted before the shared occurrence review deadline."
        );
      }
    }
  }

  if (overtime.source === "late_checkout_prompt") {
    if (
      document.lateCheckout?.occurred !== true ||
      document.lateCheckout?.selectedOption !== "overtime_requested"
    ) {
      document.invalidate(
        "overtime.source",
        "late_checkout_prompt overtime must be linked to the overtime_requested checkout option."
      );
    }

    if (
      amount(document.lateCheckout?.minutesLate) > 0 &&
      requestedMinutes > amount(document.lateCheckout.minutesLate)
    ) {
      document.invalidate(
        "overtime.requestedMinutes",
        "Late-checkout overtime requestedMinutes cannot exceed the observed post-schedule attendance minutes."
      );
    }
  }

  if (
    document.lateCheckout?.selectedOption === "overtime_requested" &&
    overtime.source !== "late_checkout_prompt"
  ) {
    document.invalidate(
      "overtime.source",
      "The overtime_requested checkout option requires late_checkout_prompt as the overtime source."
    );
  }

  if (
    overtime.employerRespondedAt &&
    overtime.requestedAt &&
    overtime.employerRespondedAt < overtime.requestedAt
  ) {
    document.invalidate(
      "overtime.employerRespondedAt",
      "Employer response cannot be earlier than requestedAt."
    );
  }

  if (
    overtime.employerRespondedAt &&
    overtime.employerResponseDeadlineAt &&
    overtime.employerRespondedAt >= overtime.employerResponseDeadlineAt
  ) {
    document.invalidate(
      "overtime.employerRespondedAt",
      "Employer response must be recorded before the employer response deadline."
    );
  }

  if (overtime.employerResponseOverdueAt) {
    if (!overtime.employerResponseDeadlineAt) {
      document.invalidate(
        "overtime.employerResponseOverdueAt",
        "employerResponseOverdueAt requires an employer response deadline."
      );
    }

    if (
      overtime.employerResponseDeadlineAt &&
      overtime.employerResponseOverdueAt < overtime.employerResponseDeadlineAt
    ) {
      document.invalidate(
        "overtime.employerResponseOverdueAt",
        "employerResponseOverdueAt cannot be earlier than employerResponseDeadlineAt."
      );
    }

    if (overtime.employerRespondedAt) {
      document.invalidate(
        "overtime.employerResponseOverdueAt",
        "An overdue employer response cannot coexist with an employer response."
      );
    }
  }

  if (hasEmployerRejectionAudit) {
    if (
      !overtime.rejectedAt ||
      !overtime.rejectedBy ||
      !overtime.rejectionBasis ||
      !overtime.rejectionReason ||
      !overtime.employerRespondedAt
    ) {
      document.invalidate(
        "overtime.rejectedAt",
        "Employer overtime rejection requires rejectedAt, rejectedBy, rejectionBasis, rejectionReason and employerRespondedAt."
      );
    }

    validateDetailsLength(
      document,
      "overtime.rejectionReason",
      overtime.rejectionReason,
      "Overtime rejection reason"
    );

    validateOvertimeEvidenceItems(
      document,
      rejectionEvidence,
      "overtime.rejectionEvidence",
      "employer",
      overtime.rejectedBy,
      overtime.rejectedAt
    );

    if (rejectionEvidence.length === 0 && overtime.rejectionNoSupportingEvidence !== true) {
      document.invalidate(
        "overtime.rejectionNoSupportingEvidence",
        "Employer overtime rejection without supporting documentary evidence requires an explicit no-supporting-evidence declaration."
      );
    }

    if (rejectionEvidence.length > 0 && overtime.rejectionNoSupportingEvidence === true) {
      document.invalidate(
        "overtime.rejectionNoSupportingEvidence",
        "rejectionNoSupportingEvidence must be false when employer rejection evidence is supplied."
      );
    }

    if (
      overtime.rejectedAt &&
      overtime.employerRespondedAt &&
      overtime.rejectedAt.getTime() !== overtime.employerRespondedAt.getTime()
    ) {
      document.invalidate(
        "overtime.rejectedAt",
        "Employer rejectedAt must match employerRespondedAt."
      );
    }

    if (overtime.rejectionBasis === "minutes_incorrect") {
      const employerProposedMinutes = Number(overtime.employerProposedMinutes || 0);

      if (
        !Number.isSafeInteger(employerProposedMinutes) ||
        employerProposedMinutes <= 0 ||
        employerProposedMinutes >= requestedMinutes
      ) {
        document.invalidate(
          "overtime.employerProposedMinutes",
          "minutes_incorrect requires positive whole employerProposedMinutes lower than the professional's requestedMinutes."
        );
      }
    } else if (hasDocumentValue(overtime.employerProposedMinutes)) {
      document.invalidate(
        "overtime.employerProposedMinutes",
        "employerProposedMinutes may only be set when rejectionBasis is minutes_incorrect."
      );
    }
  } else if (
    overtime.rejectionNoSupportingEvidence === true ||
    rejectionEvidence.length > 0 ||
    hasDocumentValue(overtime.employerProposedMinutes)
  ) {
    document.invalidate(
      "overtime.rejectedAt",
      "Employer rejection evidence and counter-position fields require a complete employer rejection."
    );
  }

  if (hasAdminReviewAudit) {
    if (!overtime.adminReviewReason || !overtime.adminReviewStartedAt) {
      document.invalidate(
        "overtime.adminReviewReason",
        "OT admin review requires adminReviewReason and adminReviewStartedAt together."
      );
    }

    if (overtime.adminReviewReason === "employer_rejection") {
      if (!hasEmployerRejectionAudit || !overtime.employerRespondedAt) {
        document.invalidate(
          "overtime.adminReviewReason",
          "employer_rejection admin review requires a complete employer rejection audit."
        );
      }

      if (
        overtime.adminReviewStartedAt &&
        overtime.rejectedAt &&
        overtime.adminReviewStartedAt < overtime.rejectedAt
      ) {
        document.invalidate(
          "overtime.adminReviewStartedAt",
          "Employer-rejection admin review cannot start before rejectedAt."
        );
      }
    }

    if (overtime.adminReviewReason === "employer_non_response") {
      if (
        !overtime.employerResponseOverdueAt ||
        overtime.employerRespondedAt ||
        hasEmployerRejectionAudit
      ) {
        document.invalidate(
          "overtime.adminReviewReason",
          "employer_non_response admin review requires an overdue unanswered employer response and no employer rejection."
        );
      }

      if (
        overtime.adminReviewStartedAt &&
        overtime.employerResponseOverdueAt &&
        overtime.adminReviewStartedAt < overtime.employerResponseOverdueAt
      ) {
        document.invalidate(
          "overtime.adminReviewStartedAt",
          "Employer-non-response admin review cannot start before employerResponseOverdueAt."
        );
      }
    }
  }

  if (adminEvidence.length > 0) {
    if (!hasAdminReviewAudit) {
      document.invalidate(
        "overtime.adminEvidence",
        "Admin overtime evidence requires an established admin review."
      );
    }

    validateOvertimeEvidenceItems(
      document,
      adminEvidence,
      "overtime.adminEvidence",
      "admin",
      null,
      overtime.adminReviewStartedAt
    );
  }

  if (hasAdminDecisionAudit) {
    if (
      !overtime.adminDecision ||
      !overtime.adminDecidedAt ||
      !overtime.adminDecidedBy ||
      !overtime.adminDecisionReason
    ) {
      document.invalidate(
        "overtime.adminDecision",
        "Admin overtime decision requires decision, time, administrator and decision reason."
      );
    }

    validateDetailsLength(
      document,
      "overtime.adminDecisionReason",
      overtime.adminDecisionReason,
      "Admin overtime decision reason"
    );

    if (!hasAdminReviewAudit) {
      document.invalidate(
        "overtime.adminReviewReason",
        "A final admin overtime decision requires an established admin review."
      );
    }

    if (overtime.decisionSource !== "admin") {
      document.invalidate(
        "overtime.decisionSource",
        "An admin overtime decision requires decisionSource admin."
      );
    }

    if (
      overtime.adminDecidedAt &&
      overtime.adminReviewStartedAt &&
      overtime.adminDecidedAt < overtime.adminReviewStartedAt
    ) {
      document.invalidate(
        "overtime.adminDecidedAt",
        "Admin overtime decision cannot predate adminReviewStartedAt."
      );
    }

    if (overtime.adminDecision === "approved" && overtime.status !== "approved") {
      document.invalidate(
        "overtime.status",
        "Admin-approved overtime requires approved overtime status."
      );
    }

    if (overtime.adminDecision === "rejected" && overtime.status !== "rejected") {
      document.invalidate(
        "overtime.status",
        "Admin-rejected overtime requires rejected overtime status."
      );
    }
  } else if (overtime.decisionSource === "admin") {
    document.invalidate(
      "overtime.adminDecision",
      "decisionSource admin requires a complete admin overtime decision audit."
    );
  }

  if (overtime.status === "pending") {
    if (
      overtime.decisionSource ||
      overtime.employerRespondedAt ||
      overtime.employerResponseOverdueAt ||
      hasEmployerRejectionAudit ||
      hasAdminReviewAudit ||
      hasAdminDecisionAudit ||
      overtime.approvedAt ||
      overtime.approvedBy ||
      hasDocumentValue(overtime.approvedMinutes)
    ) {
      document.invalidate(
        "overtime.status",
        "Pending overtime cannot contain employer decision, delinquency, admin-review, approval or final-decision audit."
      );
    }

    if (hasOvertimeFinancialData(document)) {
      document.invalidate(
        "overtime.status",
        "Pending overtime cannot contain approved professional pay, earned fee or top-up state."
      );
    }

    if (!["awaiting_overtime_review", "disputed"].includes(document.settlementStatus)) {
      document.invalidate(
        "settlementStatus",
        "Pending overtime requires awaiting_overtime_review unless an active ordinary challenge makes the occurrence disputed."
      );
    }
  }

  if (overtime.status === "disputed") {
    if (
      !hasAdminReviewAudit ||
      overtime.decisionSource ||
      hasAdminDecisionAudit ||
      overtime.approvedAt ||
      overtime.approvedBy ||
      hasDocumentValue(overtime.approvedMinutes) ||
      document.settlementStatus !== "disputed"
    ) {
      document.invalidate(
        "overtime.status",
        "Disputed overtime requires active admin review, no final decision and disputed settlementStatus."
      );
    }

    if (overtime.adminReviewReason === "employer_rejection" && !hasEmployerRejectionAudit) {
      document.invalidate(
        "overtime.adminReviewReason",
        "Employer-rejection disputed OT requires the employer rejection audit."
      );
    }

    if (
      overtime.adminReviewReason === "employer_non_response" &&
      !overtime.employerResponseOverdueAt
    ) {
      document.invalidate(
        "overtime.adminReviewReason",
        "Employer-non-response disputed OT requires employerResponseOverdueAt."
      );
    }

    if (hasOvertimeFinancialData(document)) {
      document.invalidate(
        "overtime.status",
        "Disputed overtime cannot contain final professional pay, earned platform fee or top-up state."
      );
    }
  }

  if (overtime.status === "approved") {
    if (
      !overtime.approvedAt ||
      !overtime.approvedBy ||
      !overtime.decisionSource ||
      !Number.isSafeInteger(approvedMinutes) ||
      approvedMinutes <= 0
    ) {
      document.invalidate(
        "overtime.approvedAt",
        "Approved overtime requires approvedAt, approvedBy, final decisionSource and positive whole approvedMinutes."
      );
    }

    if (overtime.approvedAt && overtime.requestedAt && overtime.approvedAt < overtime.requestedAt) {
      document.invalidate(
        "overtime.approvedAt",
        "Overtime cannot be approved before it is requested."
      );
    }

    if (approvedMinutes > requestedMinutes) {
      document.invalidate(
        "overtime.approvedMinutes",
        "Approved overtime cannot exceed the professional's requested overtime minutes."
      );
    }

    if (overtime.decisionSource === "employer") {
      if (
        !overtime.employerRespondedAt ||
        hasEmployerRejectionAudit ||
        overtime.employerResponseOverdueAt ||
        hasAdminReviewAudit ||
        hasAdminDecisionAudit ||
        approvedMinutes !== requestedMinutes
      ) {
        document.invalidate(
          "overtime.decisionSource",
          "Employer-approved overtime requires a timely employer response, exact requestedMinutes approval and no rejection or admin-review state."
        );
      }

      if (
        overtime.approvedAt &&
        overtime.employerRespondedAt &&
        overtime.approvedAt.getTime() !== overtime.employerRespondedAt.getTime()
      ) {
        document.invalidate(
          "overtime.approvedAt",
          "Employer overtime approvedAt must match employerRespondedAt."
        );
      }
    }

    if (overtime.decisionSource === "admin") {
      if (
        overtime.adminDecision !== "approved" ||
        !overtime.adminDecidedAt ||
        !overtime.adminDecidedBy ||
        !hasAdminReviewAudit
      ) {
        document.invalidate(
          "overtime.adminDecision",
          "Admin-approved overtime requires a complete approved admin decision and admin-review audit."
        );
      }

      if (
        overtime.approvedAt &&
        overtime.adminDecidedAt &&
        overtime.approvedAt.getTime() !== overtime.adminDecidedAt.getTime()
      ) {
        document.invalidate(
          "overtime.approvedAt",
          "Admin overtime approvedAt must match adminDecidedAt."
        );
      }

      if (
        overtime.approvedBy &&
        overtime.adminDecidedBy &&
        String(overtime.approvedBy) !== String(overtime.adminDecidedBy)
      ) {
        document.invalidate(
          "overtime.approvedBy",
          "Admin overtime approvedBy must match adminDecidedBy."
        );
      }
    }

    /**
     * Attendance timing is an upper boundary, not proof that every minute was
     * worked. Approval authority still comes from employer acceptance or admin
     * adjudication of the parties' positions and evidence.
     */
    const authoritativeAttendanceEnd = getAuthoritativeAttendanceEnd(document);

    if (
      !authoritativeAttendanceEnd ||
      !document.endTime ||
      authoritativeAttendanceEnd <= document.endTime
    ) {
      document.invalidate(
        "overtime.approvedMinutes",
        "Approved overtime requires authoritative attendance beyond the scheduled endTime."
      );
    } else {
      const observableOvertimeMinutes = Math.floor(
        (authoritativeAttendanceEnd.getTime() - document.endTime.getTime()) / (60 * 1000)
      );

      if (approvedMinutes > observableOvertimeMinutes) {
        document.invalidate(
          "overtime.approvedMinutes",
          "Approved overtime cannot exceed authoritative observed attendance."
        );
      }
    }

    let expectedProfessionalPay = null;

    try {
      expectedProfessionalPay = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: amount(document.hourlyRate),
        minutes: approvedMinutes,
        fieldName: "Approved overtime professional pay",
      });
    } catch (error) {
      document.invalidate(
        "overtimeProfessionalPay",
        "The approved overtime professional-pay calculation is invalid or too large."
      );
    }

    if (
      !Number.isSafeInteger(expectedProfessionalPay) ||
      expectedProfessionalPay <= 0 ||
      overtimeProfessionalPay !== expectedProfessionalPay
    ) {
      document.invalidate(
        "overtimeProfessionalPay",
        "Approved overtimeProfessionalPay must equal approvedMinutes multiplied by the snapshotted hourlyRate."
      );
    }

    const platformFeeRate = Number(document.platformFeeRate);

    let expectedPlatformFee = null;

    if (
      Number.isSafeInteger(expectedProfessionalPay) &&
      expectedProfessionalPay > 0 &&
      isSupportedFinancialRate(platformFeeRate)
    ) {
      try {
        expectedPlatformFee = money.calculateMinorAmountFromRate({
          amountMinor: expectedProfessionalPay,
          rate: platformFeeRate,
          rateScale: FINANCIAL_RATE_SCALE,
          fieldName: "Approved overtime platform fee",
          rateFieldName: "Platform fee rate",
        });
      } catch (error) {
        document.invalidate(
          "overtimePlatformFee",
          "The approved overtime platform-fee calculation is invalid or too large."
        );
      }
    }

    if (Number.isSafeInteger(expectedPlatformFee) && overtimePlatformFee !== expectedPlatformFee) {
      document.invalidate(
        "overtimePlatformFee",
        "Approved overtimePlatformFee must match overtimeProfessionalPay and platformFeeRate."
      );
    }

    let fundingRequirement = null;

    if (
      Number.isSafeInteger(expectedProfessionalPay) &&
      expectedProfessionalPay > 0 &&
      Number.isSafeInteger(expectedPlatformFee) &&
      expectedPlatformFee >= 0
    ) {
      try {
        fundingRequirement = money.sumMinorUnitAmounts(
          [expectedProfessionalPay, expectedPlatformFee],
          "Approved overtime funding requirement"
        );
      } catch (error) {
        document.invalidate(
          "overtime.topUpAmount",
          "Approved overtime funding requirement is invalid or too large."
        );
      }
    }

    if (!Number.isSafeInteger(fundingRequirement) || fundingRequirement <= 0) {
      document.invalidate(
        "overtime.topUpAmount",
        "Approved overtime funding requirement is invalid."
      );
    } else if (topUpAmount !== fundingRequirement) {
      document.invalidate(
        "overtime.topUpAmount",
        "overtime.topUpAmount must equal overtimeProfessionalPay plus overtimePlatformFee."
      );
    }

    if (!overtime.topUpDeadlineAt) {
      document.invalidate(
        "overtime.topUpDeadlineAt",
        "Approved overtime requires a top-up deadline."
      );
    }

    if (
      overtime.topUpDeadlineAt &&
      overtime.approvedAt &&
      overtime.topUpDeadlineAt <= overtime.approvedAt
    ) {
      document.invalidate(
        "overtime.topUpDeadlineAt",
        "Overtime top-up deadline must be later than final approval."
      );
    }

    if (overtime.topUpPaid) {
      if (!overtime.topUpPaidAt || !document.topUpTransaction || topUpRequired !== 0) {
        document.invalidate(
          "overtime.topUpPaid",
          "Paid overtime requires topUpPaidAt, topUpTransaction and zero topUpRequired."
        );
      }

      if (
        overtime.topUpPaidAt &&
        overtime.approvedAt &&
        overtime.topUpPaidAt < overtime.approvedAt
      ) {
        document.invalidate(
          "overtime.topUpPaidAt",
          "Overtime top-up cannot be paid before final overtime approval."
        );
      }
    } else {
      if (topUpRequired !== fundingRequirement) {
        document.invalidate(
          "topUpRequired",
          "Unpaid approved overtime requires the full top-up funding requirement to remain outstanding."
        );
      }

      if (overtime.topUpPaidAt || document.topUpTransaction) {
        document.invalidate(
          "overtime.topUpPaid",
          "Unpaid overtime cannot contain completed top-up details."
        );
      }

      if (!["awaiting_topup", "disputed"].includes(document.settlementStatus)) {
        document.invalidate(
          "settlementStatus",
          "Approved unpaid overtime requires awaiting_topup unless an active ordinary challenge makes the occurrence disputed."
        );
      }
    }

    /**
     * Historical delinquency timestamps are intentionally retained after
     * payment. Current restriction derives from unpaid outstanding state.
     */
    if (overtime.topUpOverdueAt) {
      if (!overtime.topUpDeadlineAt || overtime.topUpOverdueAt < overtime.topUpDeadlineAt) {
        document.invalidate(
          "overtime.topUpOverdueAt",
          "topUpOverdueAt requires an established top-up deadline and cannot predate it."
        );
      }

      if (overtime.topUpPaidAt && overtime.topUpPaidAt < overtime.topUpOverdueAt) {
        document.invalidate(
          "overtime.topUpPaidAt",
          "Paid overtime cannot have topUpPaidAt earlier than its historical overdue time."
        );
      }
    }

    if (overtime.restrictionTriggeredAt) {
      if (!overtime.topUpOverdueAt) {
        document.invalidate(
          "overtime.restrictionTriggeredAt",
          "restrictionTriggeredAt requires an established overdue overtime top-up."
        );
      }

      if (overtime.topUpOverdueAt && overtime.restrictionTriggeredAt < overtime.topUpOverdueAt) {
        document.invalidate(
          "overtime.restrictionTriggeredAt",
          "restrictionTriggeredAt cannot be earlier than topUpOverdueAt."
        );
      }

      if (overtime.topUpPaidAt && overtime.topUpPaidAt < overtime.restrictionTriggeredAt) {
        document.invalidate(
          "overtime.topUpPaidAt",
          "Paid overtime cannot have topUpPaidAt earlier than historical restrictionTriggeredAt."
        );
      }
    }
  }

  if (overtime.status === "rejected") {
    if (
      overtime.decisionSource !== "admin" ||
      overtime.adminDecision !== "rejected" ||
      !hasAdminReviewAudit ||
      !hasAdminDecisionAudit
    ) {
      document.invalidate(
        "overtime.status",
        "Rejected overtime is final and requires a complete admin rejection after employer rejection or employer non-response."
      );
    }

    if (overtime.approvedAt || overtime.approvedBy || hasDocumentValue(overtime.approvedMinutes)) {
      document.invalidate(
        "overtime.approvedMinutes",
        "Final rejected overtime cannot retain positive approval fields."
      );
    }

    if (hasOvertimeFinancialData(document)) {
      document.invalidate(
        "overtime.status",
        "Rejected overtime cannot retain professional pay, earned platform fee or top-up state."
      );
    }
  }

  if (overtime.status === "cancelled") {
    if (
      overtime.decisionSource ||
      overtime.employerRespondedAt ||
      overtime.employerResponseOverdueAt ||
      hasEmployerRejectionAudit ||
      hasAdminReviewAudit ||
      hasAdminDecisionAudit ||
      overtime.approvedAt ||
      overtime.approvedBy ||
      hasDocumentValue(overtime.approvedMinutes) ||
      hasOvertimeFinancialData(document)
    ) {
      document.invalidate(
        "overtime.status",
        "Cancelled overtime cannot retain employer decision, admin-review, delinquency or financial outcome state."
      );
    }
  }

  if (
    overtime.status !== "approved" &&
    (overtimeProfessionalPay > 0 ||
      overtimePlatformFee > 0 ||
      topUpAmount > 0 ||
      topUpRequired > 0 ||
      overtime.topUpDeadlineAt ||
      overtime.topUpOverdueAt ||
      overtime.restrictionTriggeredAt ||
      overtime.topUpPaid ||
      overtime.topUpPaidAt ||
      document.topUpTransaction ||
      hasPlatformFeeAuditData(document.overtimePlatformFeeAudit || {}))
  ) {
    document.invalidate(
      "overtime.status",
      "Final overtime financial and delinquency state may only exist for approved overtime."
    );
  }
}

function validateSettlementState(document) {
  const baseSettlementStatus = document.baseSettlement?.status || "not_due";

  const overtimeSettlementStatus = document.overtimeSettlement?.status || "not_due";

  const baseProfessionalPay = amount(document.baseProfessionalPay);

  const overtimeProfessionalPay = amount(document.overtimeProfessionalPay);

  const hasActiveOrdinaryChallenge = Boolean(document.activeClaim || document.activeDispute);

  if (hasActiveOrdinaryChallenge && document.settlementStatus !== "disputed") {
    document.invalidate(
      "settlementStatus",
      "An occurrence with an active ordinary financial challenge must use disputed settlementStatus."
    );
  }

  if (document.settlementStatus === "pending_review") {
    if (!isOrdinaryChallengeWindowOpen(document)) {
      document.invalidate(
        "settlementStatus",
        "pending_review requires an open shared occurrence challenge window."
      );
    }

    if (hasActiveOrdinaryChallenge) {
      document.invalidate(
        "settlementStatus",
        "pending_review cannot be used while an ordinary claim or employer dispute is active."
      );
    }
  }

  const overtimeAwaitingDecision = Boolean(
    document.overtime?.requested === true && document.overtime?.status === "pending"
  );

  if (document.settlementStatus === "awaiting_overtime_review" && !overtimeAwaitingDecision) {
    document.invalidate(
      "overtime.status",
      "awaiting_overtime_review requires a pending employer OT review."
    );
  }

  if (
    document.settlementStatus === "awaiting_topup" &&
    (document.overtime?.requested !== true ||
      document.overtime?.status !== "approved" ||
      document.overtime?.topUpPaid === true)
  ) {
    document.invalidate("overtime.status", "awaiting_topup requires approved unpaid overtime.");
  }

  if (document.settlementStatus === "approved_for_release") {
    if (
      baseSettlementStatus !== "approved_for_release" &&
      overtimeSettlementStatus !== "approved_for_release"
    ) {
      document.invalidate(
        "settlementStatus",
        "approved_for_release requires at least one approved professional payout component."
      );
    }
  }

  if (document.settlementStatus === "release_pending") {
    if (
      baseSettlementStatus !== "release_pending" &&
      overtimeSettlementStatus !== "release_pending"
    ) {
      document.invalidate(
        "settlementStatus",
        "release_pending requires at least one release-pending professional payout component."
      );
    }
  }

  const overtimeUnresolvedForCompletion = Boolean(
    document.overtime?.requested === true &&
    ["pending", "disputed"].includes(document.overtime?.status)
  );

  if (document.settlementStatus === "released" && overtimeUnresolvedForCompletion) {
    document.invalidate(
      "settlementStatus",
      "Overall professional settlement cannot be released while overtime employer review or admin adjudication remains unresolved."
    );
  }

  if (document.settlementStatus === "released") {
    const baseNeedsRelease = baseProfessionalPay > 0;

    const overtimeNeedsRelease = overtimeProfessionalPay > 0;

    if (!baseNeedsRelease && !overtimeNeedsRelease) {
      document.invalidate(
        "settlementStatus",
        "released professional settlement requires at least one positive professional payout component."
      );
    }

    if (baseNeedsRelease && baseSettlementStatus !== "released") {
      document.invalidate(
        "baseSettlement.status",
        "Overall released settlement requires released baseSettlement when base professional pay exists."
      );
    }

    if (overtimeNeedsRelease && overtimeSettlementStatus !== "released") {
      document.invalidate(
        "overtimeSettlement.status",
        "Overall released settlement requires released overtimeSettlement when overtime professional pay exists."
      );
    }

    if (!document.settledAt) {
      document.invalidate("settledAt", "released professional settlement requires settledAt.");
    }
  }

  if (document.settledAt && document.settlementStatus !== "released") {
    document.invalidate(
      "settlementStatus",
      "settledAt may only be set when every payable professional component has been released."
    );
  }

  if (document.status === "completed") {
    if (document.settlementStatus !== "released" || document.attendanceStatus !== "settled") {
      document.invalidate(
        "status",
        "completed requires released professional settlement and settled attendance."
      );
    }
  }

  if (document.attendanceStatus === "settled" && document.settlementStatus !== "released") {
    document.invalidate(
      "settlementStatus",
      "settled attendance requires released professional settlement."
    );
  }

  if (
    document.status === "no_show" ||
    document.status === "expired_unfilled" ||
    (document.status === "cancelled" && document.cancellationCompensation?.applicable !== true)
  ) {
    if (baseProfessionalPay !== 0 || overtimeProfessionalPay !== 0) {
      document.invalidate(
        baseProfessionalPay !== 0 ? "baseProfessionalPay" : "overtimeProfessionalPay",
        "An occurrence with no professional payment must have zero professional pay."
      );
    }

    if (baseSettlementStatus !== "not_due" || overtimeSettlementStatus !== "not_due") {
      document.invalidate(
        baseSettlementStatus !== "not_due" ? "baseSettlement.status" : "overtimeSettlement.status",
        "An occurrence with no professional payment cannot contain payout-ready settlement components."
      );
    }
  }

  if (
    document.cancellationCompensation?.applicable === true &&
    overtimeSettlementStatus !== "not_due"
  ) {
    document.invalidate(
      "overtimeSettlement.status",
      "A compensated pre-start cancellation cannot contain an overtime settlement component."
    );
  }

  if (
    document.activeWorkCancellation?.occurred === true &&
    overtimeSettlementStatus !== "not_due"
  ) {
    document.invalidate(
      "overtimeSettlement.status",
      "An active-work cancellation cannot contain an overtime settlement component."
    );
  }
}

function validateCancellationCompensation(document, assignmentContext) {
  const compensation = document.cancellationCompensation || {};

  const professionalPay = amount(compensation.professionalPay);

  const hasCompensationData =
    compensation.applicable === true ||
    Number(compensation.rate || 0) > 0 ||
    hasDocumentValue(compensation.windowMinutes) ||
    professionalPay > 0 ||
    hasDocumentValue(compensation.calculatedAt);

  if (compensation.applicable !== true) {
    if (hasCompensationData) {
      document.invalidate(
        "cancellationCompensation.applicable",
        "Cancellation compensation details require applicable to be true."
      );
    }

    return;
  }

  if (
    document.status !== "cancelled" ||
    document.cancellationCode !== "late_employer_cancellation" ||
    document.cancelledBy !== "employer" ||
    assignmentContext.assignmentStatus !== "assigned" ||
    !assignmentContext.hasCompleteAssignment
  ) {
    document.invalidate(
      "cancellationCompensation.applicable",
      "Cancellation compensation requires an assigned late employer cancellation."
    );
  }

  const compensationRate = Number(compensation.rate);

  if (
    !isSupportedFinancialRate(compensationRate) ||
    compensationRate <= 0 ||
    !Number.isSafeInteger(compensation.windowMinutes) ||
    compensation.windowMinutes < 0 ||
    !compensation.calculatedAt
  ) {
    document.invalidate(
      "cancellationCompensation.rate",
      "Applicable cancellation compensation requires a supported positive rate, windowMinutes and calculatedAt."
    );
  }

  if (
    compensation.calculatedAt &&
    document.cancelledAt &&
    compensation.calculatedAt < document.cancelledAt
  ) {
    document.invalidate(
      "cancellationCompensation.calculatedAt",
      "Cancellation compensation cannot be calculated before the occurrence is cancelled."
    );
  }

  let expectedProfessionalPay = null;

  if (isSupportedFinancialRate(compensationRate) && compensationRate > 0) {
    try {
      expectedProfessionalPay = money.calculateMinorAmountFromRate({
        amountMinor: amount(document.estimatedProfessionalPay),
        rate: compensationRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "Cancellation compensation professional pay",
        rateFieldName: "Cancellation compensation rate",
      });
    } catch (error) {
      document.invalidate(
        "cancellationCompensation.professionalPay",
        "The cancellation-compensation calculation is invalid or too large."
      );
    }
  }

  if (
    !Number.isSafeInteger(expectedProfessionalPay) ||
    professionalPay !== expectedProfessionalPay ||
    professionalPay <= 0
  ) {
    document.invalidate(
      "cancellationCompensation.professionalPay",
      "Cancellation compensation professional pay must match the snapshotted compensation rate."
    );
  }

  if (
    amount(document.baseProfessionalPay) > 0 &&
    amount(document.baseProfessionalPay) !== professionalPay
  ) {
    document.invalidate(
      "baseProfessionalPay",
      "Established cancellation-compensation baseProfessionalPay must match cancellationCompensation.professionalPay."
    );
  }
}

function validateActiveWorkCancellation(document, assignmentContext) {
  const cancellation = document.activeWorkCancellation || {};

  const actualWorkedProfessionalPay = amount(cancellation.actualWorkedProfessionalPay);

  const minimumGuaranteedProfessionalPay = amount(cancellation.minimumGuaranteedProfessionalPay);

  const professionalPay = amount(cancellation.professionalPay);

  const hasCancellationData =
    cancellation.occurred === true ||
    hasAny([
      cancellation.initiatedBy,
      cancellation.initiatedByUser,
      cancellation.reason,
      cancellation.requestedAt,
      cancellation.effectiveAt,
      cancellation.calculatedAt,
    ]) ||
    amount(cancellation.actualWorkedMinutes) > 0 ||
    Number(cancellation.minimumProfessionalPayRate || 0) > 0 ||
    actualWorkedProfessionalPay > 0 ||
    minimumGuaranteedProfessionalPay > 0 ||
    professionalPay > 0;

  if (cancellation.occurred !== true) {
    if (hasCancellationData) {
      document.invalidate(
        "activeWorkCancellation.occurred",
        "Active-work cancellation details require occurred to be true."
      );
    }

    return;
  }

  if (
    !["pending_settlement", "completed", "disputed"].includes(document.status) ||
    assignmentContext.assignmentStatus !== "assigned" ||
    !assignmentContext.hasCompleteAssignment
  ) {
    document.invalidate(
      "activeWorkCancellation.occurred",
      "Active-work cancellation requires an assigned worked occurrence."
    );
  }

  if (
    !cancellation.initiatedBy ||
    !cancellation.initiatedByUser ||
    !cancellation.reason ||
    !cancellation.requestedAt ||
    !cancellation.effectiveAt ||
    !cancellation.calculatedAt ||
    !document.checkedInAt ||
    !document.checkedOutAt
  ) {
    document.invalidate(
      "activeWorkCancellation",
      "Active-work cancellation requires full initiator, timing, reason and attendance audit."
    );
  }

  validateDetailsLength(
    document,
    "activeWorkCancellation.reason",
    cancellation.reason,
    "Active-work cancellation reason"
  );

  if (
    cancellation.effectiveAt &&
    document.checkedOutAt &&
    cancellation.effectiveAt.getTime() !== document.checkedOutAt.getTime()
  ) {
    document.invalidate(
      "activeWorkCancellation.effectiveAt",
      "effectiveAt must match checkedOutAt."
    );
  }

  if (
    cancellation.requestedAt &&
    cancellation.effectiveAt &&
    cancellation.effectiveAt < cancellation.requestedAt
  ) {
    document.invalidate(
      "activeWorkCancellation.effectiveAt",
      "effectiveAt cannot be earlier than requestedAt."
    );
  }

  if (
    cancellation.effectiveAt &&
    document.endTime &&
    cancellation.effectiveAt >= document.endTime
  ) {
    document.invalidate(
      "activeWorkCancellation.effectiveAt",
      "Active-work cancellation must take effect before endTime."
    );
  }

  if (!["checked_out", "settled", "disputed"].includes(document.attendanceStatus)) {
    document.invalidate(
      "attendanceStatus",
      "Active-work cancellation requires checked-out, settled or disputed attendance."
    );
  }

  const actualWorkedMinutes = amount(cancellation.actualWorkedMinutes);

  if (
    !Number.isSafeInteger(actualWorkedMinutes) ||
    actualWorkedMinutes < 0 ||
    actualWorkedMinutes > amount(document.scheduledMinutes)
  ) {
    document.invalidate(
      "activeWorkCancellation.actualWorkedMinutes",
      "actualWorkedMinutes must be a non-negative whole number no greater than scheduledMinutes."
    );
  }

  const minimumProfessionalPayRate = Number(cancellation.minimumProfessionalPayRate);

  let expectedActualWorkedPay = null;

  if (Number.isSafeInteger(actualWorkedMinutes) && actualWorkedMinutes >= 0) {
    try {
      expectedActualWorkedPay = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: amount(document.hourlyRate),
        minutes: actualWorkedMinutes,
        fieldName: "Active-work actual professional pay",
      });
    } catch (error) {
      document.invalidate(
        "activeWorkCancellation.actualWorkedProfessionalPay",
        "The active-work actual-pay calculation is invalid or too large."
      );
    }
  }

  let expectedMinimumPay = null;

  if (isSupportedFinancialRate(minimumProfessionalPayRate) && minimumProfessionalPayRate > 0) {
    try {
      expectedMinimumPay = money.calculateMinorAmountFromRate({
        amountMinor: amount(document.estimatedProfessionalPay),
        rate: minimumProfessionalPayRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "Active-work minimum guaranteed professional pay",
        rateFieldName: "Active-work cancellation minimum professional pay rate",
      });
    } catch (error) {
      document.invalidate(
        "activeWorkCancellation.minimumGuaranteedProfessionalPay",
        "The active-work minimum-guarantee calculation is invalid or too large."
      );
    }
  }

  const expectedProfessionalPay =
    Number.isSafeInteger(expectedActualWorkedPay) && Number.isSafeInteger(expectedMinimumPay)
      ? expectedActualWorkedPay >= expectedMinimumPay
        ? expectedActualWorkedPay
        : expectedMinimumPay
      : null;

  if (
    !isSupportedFinancialRate(minimumProfessionalPayRate) ||
    minimumProfessionalPayRate <= 0 ||
    !Number.isSafeInteger(expectedActualWorkedPay) ||
    !Number.isSafeInteger(expectedMinimumPay) ||
    !Number.isSafeInteger(expectedProfessionalPay) ||
    actualWorkedProfessionalPay !== expectedActualWorkedPay ||
    minimumGuaranteedProfessionalPay !== expectedMinimumPay ||
    professionalPay !== expectedProfessionalPay
  ) {
    document.invalidate(
      "activeWorkCancellation.professionalPay",
      "Active-work cancellation professional pay is inconsistent with worked time or the minimum guarantee."
    );
  }

  if (
    amount(document.baseProfessionalPay) > 0 &&
    amount(document.baseProfessionalPay) !== professionalPay
  ) {
    document.invalidate(
      "baseProfessionalPay",
      "Established active-work cancellation baseProfessionalPay must match activeWorkCancellation.professionalPay."
    );
  }

  if (hasDocumentValue(document.baseBillableHours)) {
    const expectedHours = actualWorkedMinutes / 60;

    if (!approximatelyEqual(Number(document.baseBillableHours), expectedHours)) {
      document.invalidate(
        "baseBillableHours",
        "Active-work cancellation baseBillableHours must match actualWorkedMinutes."
      );
    }
  }

  if (
    document.overtime?.requested ||
    document.overtime?.status ||
    hasOvertimeFinancialData(document)
  ) {
    document.invalidate(
      "overtime.status",
      "Active-work cancellation cannot contain overtime or top-up activity."
    );
  }
}

function validateCancellation(document) {
  const cancellationAuditValues = [
    document.cancellationCode,
    document.cancelledBy,
    document.cancelledByUser,
    document.cancellationReason,
    document.cancelledAt,
  ];

  const hasCancellationAudit = hasAny(cancellationAuditValues);

  if (document.status !== "cancelled") {
    if (hasCancellationAudit) {
      document.invalidate(
        "status",
        "Cancellation audit fields may only be set when status is cancelled."
      );
    }

    if (document.cancellationCompensation?.applicable === true) {
      document.invalidate(
        "cancellationCompensation.applicable",
        "Cancellation compensation may only exist on a cancelled occurrence."
      );
    }

    return;
  }

  if (
    !document.cancellationCode ||
    !document.cancelledBy ||
    !document.cancellationReason ||
    !document.cancelledAt
  ) {
    document.invalidate(
      "cancellationCode",
      "A cancelled occurrence requires cancellation code, actor, reason and cancellation time."
    );
  }

  validateDetailsLength(
    document,
    "cancellationReason",
    document.cancellationReason,
    "Cancellation reason"
  );

  if (USER_CANCELLATION_ACTORS.includes(document.cancelledBy) && !document.cancelledByUser) {
    document.invalidate(
      "cancelledByUser",
      `${document.cancelledBy} cancellation requires cancelledByUser.`
    );
  }

  if (document.cancelledBy === "system" && document.cancelledByUser) {
    document.invalidate("cancelledByUser", "System cancellation cannot contain cancelledByUser.");
  }

  const requiredActor = CANCELLATION_CODE_ACTORS[document.cancellationCode];

  if (requiredActor && document.cancelledBy !== requiredActor) {
    document.invalidate(
      "cancelledBy",
      `${document.cancellationCode} requires cancelledBy to be ${requiredActor}.`
    );
  }

  if (
    document.cancellationCode !== "funding_deadline_passed" &&
    document.cancelledAt &&
    document.startTime &&
    document.cancelledAt >= document.startTime
  ) {
    document.invalidate(
      "cancelledAt",
      "An ordinary occurrence cancellation must happen before scheduled start time."
    );
  }

  if (
    document.attendanceStatus !== "not_started" ||
    document.checkedInAt ||
    document.checkedOutAt ||
    document.checkInPinUsedAt ||
    document.checkOutPinUsedAt
  ) {
    document.invalidate("status", "Cancelled occurrence cannot contain attendance activity.");
  }

  if (document.activeWorkCancellation?.occurred === true) {
    document.invalidate(
      "activeWorkCancellation.occurred",
      "A pre-start cancelled occurrence cannot also use active-work cancellation."
    );
  }

  if (
    document.overtime?.requested ||
    document.overtime?.status ||
    hasOvertimeFinancialData(document)
  ) {
    document.invalidate(
      "overtime.status",
      "Cancelled occurrence cannot contain overtime or top-up activity."
    );
  }

  if (
    document.cancellationCode === "late_employer_cancellation" &&
    document.cancellationCompensation?.applicable !== true
  ) {
    document.invalidate(
      "cancellationCompensation.applicable",
      "late_employer_cancellation requires professional cancellation compensation."
    );
  }

  if (document.cancellationCompensation?.applicable !== true) {
    if (amount(document.baseProfessionalPay) !== 0) {
      document.invalidate(
        "baseProfessionalPay",
        "Cancellation without compensation cannot create professional base pay."
      );
    }

    if (
      document.baseSettlement?.status !== "not_due" ||
      document.overtimeSettlement?.status !== "not_due"
    ) {
      document.invalidate(
        "baseSettlement.status",
        "Cancellation without compensation cannot contain payable professional settlement components."
      );
    }
  }

  if (document.cancellationCode === "funding_deadline_passed") {
    if (document.assignmentStatus !== "unassigned") {
      document.invalidate(
        "assignmentStatus",
        "funding_deadline_passed requires an unassigned occurrence."
      );
    }

    if (
      document.refundStatus !== "not_eligible" ||
      amount(document.refundableAmount) !== 0 ||
      amount(document.refundedAmount) !== 0 ||
      amount(document.basePlatformFee) !== 0 ||
      hasPlatformFeeAuditData(document.basePlatformFeeAudit || {})
    ) {
      document.invalidate(
        "refundStatus",
        "Unfunded deadline cancellation cannot contain refund or platform-fee activity."
      );
    }
  }
}

function validateRefundWorkflow(document) {
  const refundStatus = document.refundStatus || "not_eligible";

  const refundableAmount = amount(document.refundableAmount);

  const refundedAmount = amount(document.refundedAmount);

  const challengeComponents = getChallengeComponents(document);

  const baseStillChallengeable = Boolean(
    isOrdinaryChallengeWindowOpen(document) && challengeComponents.includes("base")
  );

  /**
   * Scheduled/base refund authority.
   *
   * BASE platform fee remains consumed once earned.
   * OT is separately funded and is excluded completely.
   */
  let expectedRefundableAmount = null;

  try {
    const estimatedEmployerCharge = money.normalizeMinorUnitAmount(
      document.estimatedEmployerCharge,
      "Estimated employer charge"
    );

    const committedBaseAllocation = money.sumMinorUnitAmounts(
      [amount(document.baseProfessionalPay), amount(document.basePlatformFee)],
      "Committed BASE allocation"
    );

    expectedRefundableAmount =
      committedBaseAllocation >= estimatedEmployerCharge
        ? 0
        : estimatedEmployerCharge - committedBaseAllocation;
  } catch (error) {
    document.invalidate(
      "refundableAmount",
      "The scheduled/base refundable-allocation calculation is invalid or too large."
    );
  }

  if (refundedAmount > refundableAmount) {
    document.invalidate("refundedAmount", "refundedAmount cannot exceed refundableAmount.");
  }

  /**
   * Lifecycle facts may be saved before ShiftRefundService synchronizes the
   * actual EmployerRefund obligation.
   */
  if (refundStatus === "not_eligible") {
    if (
      refundableAmount !== 0 ||
      refundedAmount !== 0 ||
      document.refundReason ||
      document.refundEligibleAt ||
      document.refundLastEvaluatedAt ||
      document.refundHeldAt ||
      document.refundHoldReason ||
      document.employerRefund ||
      document.refundBatch ||
      document.refundProcessingStartedAt ||
      document.refundedAt
    ) {
      document.invalidate(
        "refundStatus",
        "not_eligible cannot contain refund amounts, workflow records, timestamps or execution links."
      );
    }

    return;
  }

  if (
    Number.isSafeInteger(expectedRefundableAmount) &&
    refundableAmount !== expectedRefundableAmount
  ) {
    document.invalidate(
      "refundableAmount",
      "Refundable scheduled allocation must equal estimatedEmployerCharge minus baseProfessionalPay and earned basePlatformFee."
    );
  }

  if (REFUND_STATUSES_REQUIRING_AMOUNT.includes(refundStatus)) {
    if (
      refundableAmount <= 0 ||
      !document.refundReason ||
      !document.refundLastEvaluatedAt ||
      !document.employerRefund
    ) {
      document.invalidate(
        "refundStatus",
        `${refundStatus} requires positive refundableAmount, refundReason, refundLastEvaluatedAt and employerRefund.`
      );
    }
  }

  if (
    document.refundEligibleAt &&
    document.refundLastEvaluatedAt &&
    document.refundEligibleAt > document.refundLastEvaluatedAt
  ) {
    document.invalidate(
      "refundEligibleAt",
      "refundEligibleAt cannot be later than refundLastEvaluatedAt."
    );
  }

  if (refundStatus === "held") {
    if (!document.refundHeldAt || !document.refundHoldReason) {
      document.invalidate("refundStatus", "held requires refundHeldAt and refundHoldReason.");
    }

    if (
      document.refundBatch ||
      document.refundProcessingStartedAt ||
      refundedAmount !== 0 ||
      document.refundedAt
    ) {
      document.invalidate(
        "refundStatus",
        "held cannot contain batch, processing or completed refund details."
      );
    }

    if (
      document.refundHeldAt &&
      document.refundEligibleAt &&
      document.refundHeldAt < document.refundEligibleAt
    ) {
      document.invalidate(
        "refundHeldAt",
        "refundHeldAt cannot be earlier than an already-established refundEligibleAt."
      );
    }

    if (
      document.refundHeldAt &&
      document.refundLastEvaluatedAt &&
      document.refundHeldAt > document.refundLastEvaluatedAt
    ) {
      document.invalidate(
        "refundHeldAt",
        "refundHeldAt cannot be later than refundLastEvaluatedAt."
      );
    }
  } else if (document.refundHeldAt || document.refundHoldReason) {
    document.invalidate("refundStatus", "Refund hold details require refundStatus held.");
  }

  if (document.refundHoldReason === "challenge_window_open") {
    if (!baseStillChallengeable) {
      document.invalidate(
        "refundHoldReason",
        "challenge_window_open requires BASE to remain ordinarily challengeable in the open shared window."
      );
    }
  }

  if (
    document.refundHoldReason === "attendance_review_pending" &&
    !["missed_checkin_review", "checkout_fallback_review"].includes(document.attendanceStatus)
  ) {
    document.invalidate(
      "refundHoldReason",
      "attendance_review_pending requires unresolved attendance review."
    );
  }

  if (document.refundHoldReason === "professional_claim_pending" && !document.activeClaim) {
    document.invalidate(
      "activeClaim",
      "professional_claim_pending requires an active ShiftOccurrenceClaim."
    );
  }

  if (document.refundHoldReason === "employer_dispute_pending" && !document.activeDispute) {
    document.invalidate(
      "activeDispute",
      "employer_dispute_pending requires an active ShiftOccurrenceDispute."
    );
  }

  if (document.refundHoldReason === "professional_settlement_pending") {
    if (
      amount(document.baseProfessionalPay) <= 0 ||
      document.baseSettlement?.status === "released"
    ) {
      document.invalidate(
        "refundHoldReason",
        "professional_settlement_pending requires positive unreleased BASE professional pay."
      );
    }
  }

  const refundReadyOrExecuting = ["eligible", ...REFUND_EXECUTION_STATUSES].includes(refundStatus);

  if (refundReadyOrExecuting && baseStillChallengeable) {
    document.invalidate(
      "refundStatus",
      `${refundStatus} cannot proceed while BASE remains ordinarily challengeable.`
    );
  }

  if (
    refundReadyOrExecuting &&
    amount(document.baseProfessionalPay) > 0 &&
    document.baseSettlement?.status !== "released"
  ) {
    document.invalidate(
      "baseSettlement.status",
      "Positive BASE professional pay must be released before the scheduled/base refund becomes executable."
    );
  }

  if (refundStatus === "eligible") {
    if (!document.refundEligibleAt) {
      document.invalidate("refundEligibleAt", "eligible requires refundEligibleAt.");
    }

    if (
      document.refundBatch ||
      document.refundProcessingStartedAt ||
      refundedAmount !== 0 ||
      document.refundedAt
    ) {
      document.invalidate(
        "refundStatus",
        "eligible cannot contain batch, processing or completed refund details."
      );
    }
  }

  if (REFUND_EXECUTION_STATUSES.includes(refundStatus)) {
    if (!document.refundEligibleAt || !document.employerRefund || !document.refundBatch) {
      document.invalidate(
        "refundStatus",
        `${refundStatus} requires refundEligibleAt, employerRefund and refundBatch.`
      );
    }
  } else if (document.refundBatch) {
    document.invalidate(
      "refundBatch",
      "refundBatch may only be set for batched, processing or refunded refunds."
    );
  }

  if (refundStatus === "batched") {
    if (document.refundProcessingStartedAt || refundedAmount !== 0 || document.refundedAt) {
      document.invalidate(
        "refundStatus",
        "batched cannot contain processing or completed refund details."
      );
    }
  }

  if (["processing", "refunded"].includes(refundStatus)) {
    if (!document.refundProcessingStartedAt) {
      document.invalidate(
        "refundProcessingStartedAt",
        `${refundStatus} requires refundProcessingStartedAt.`
      );
    }

    if (
      document.refundProcessingStartedAt &&
      document.refundEligibleAt &&
      document.refundProcessingStartedAt < document.refundEligibleAt
    ) {
      document.invalidate(
        "refundProcessingStartedAt",
        "refundProcessingStartedAt cannot be earlier than refundEligibleAt."
      );
    }
  } else if (document.refundProcessingStartedAt) {
    document.invalidate(
      "refundProcessingStartedAt",
      "refundProcessingStartedAt may only be set for processing or refunded refunds."
    );
  }

  if (refundStatus === "processing") {
    if (refundedAmount !== 0 || document.refundedAt) {
      document.invalidate("refundStatus", "processing cannot contain completed refund details.");
    }
  }

  if (refundStatus === "refunded") {
    if (refundedAmount !== refundableAmount || !document.refundedAt) {
      document.invalidate("refundStatus", "refunded requires full refundedAmount and refundedAt.");
    }

    if (
      document.refundedAt &&
      document.refundEligibleAt &&
      document.refundedAt < document.refundEligibleAt
    ) {
      document.invalidate("refundedAt", "refundedAt cannot be earlier than refundEligibleAt.");
    }

    if (
      document.refundedAt &&
      document.refundProcessingStartedAt &&
      document.refundedAt < document.refundProcessingStartedAt
    ) {
      document.invalidate(
        "refundedAt",
        "refundedAt cannot be earlier than refundProcessingStartedAt."
      );
    }
  }

  if (refundStatus !== "refunded" && (refundedAmount > 0 || document.refundedAt)) {
    document.invalidate("refundStatus", "Completed refund details require refundStatus refunded.");
  }
}

/* ─────────────────────────────── OCCURRENCE VALIDATION ─────────────────────────────── */

shiftOccurrenceSchema.pre("validate", function validateShiftOccurrence() {
  const assignmentContext = validateReplacementAndAssignment(this);

  validateSchedule(this);

  validateChallengeWindow(this);

  validatePricing(this);

  validatePlatformFees(this, assignmentContext);

  validateSettlementComponents(this);

  validateAttendance(this);

  validateAbsenceAndAttendanceReviewDetails(this);

  validateExpiredUnfilled(this);

  validateOvertime(this);

  validateCancellationCompensation(this, assignmentContext);

  validateActiveWorkCancellation(this, assignmentContext);

  validateCancellation(this);

  validateSettlementState(this);

  validateRefundWorkflow(this);
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

shiftOccurrenceSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceSchema.index(
  {
    shift: 1,
    sequenceNumber: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceSchema.index(
  {
    shift: 1,
    occurrenceDate: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceSchema.index({
  shift: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  shift: 1,
  assignmentStatus: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  shift: 1,
  assignedProfessional: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  assignmentStatus: 1,
  status: 1,
  fillCutoffAt: 1,
});

shiftOccurrenceSchema.index({
  assignmentStatus: 1,
  status: 1,
  unfilledFinalizationAt: 1,
});

shiftOccurrenceSchema.index({
  challengeDeadlineAt: 1,
  challengeWindowClosedAt: 1,
  challengeableSettlementComponents: 1,
});

shiftOccurrenceSchema.index({
  business: 1,
  challengeDeadlineAt: 1,
  challengeWindowClosedAt: 1,
});

shiftOccurrenceSchema.index({
  activeClaim: 1,
});

shiftOccurrenceSchema.index({
  activeDispute: 1,
});

shiftOccurrenceSchema.index({
  refundStatus: 1,
  refundEligibleAt: 1,
  refundLastEvaluatedAt: 1,
});

shiftOccurrenceSchema.index({
  business: 1,
  refundStatus: 1,
  refundEligibleAt: 1,
});

shiftOccurrenceSchema.index({
  refundBatch: 1,
  sequenceNumber: 1,
});

shiftOccurrenceSchema.index({
  employerRefund: 1,
});

shiftOccurrenceSchema.index({
  replacementCase: 1,
  sequenceNumber: 1,
});

shiftOccurrenceSchema.index({
  replacementForAssignment: 1,
  sequenceNumber: 1,
});

shiftOccurrenceSchema.index({
  assignment: 1,
  sequenceNumber: 1,
});

shiftOccurrenceSchema.index({
  assignedProfessional: 1,
  status: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  business: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  business: 1,
  assignmentStatus: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  branch: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  status: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  attendanceStatus: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  settlementStatus: 1,
  challengeDeadlineAt: 1,
  challengeWindowClosedAt: 1,
});

shiftOccurrenceSchema.index({
  "checkInLocation.withinGeofence": 1,
});

shiftOccurrenceSchema.index({
  "checkOutLocation.withinGeofence": 1,
});

shiftOccurrenceSchema.index({
  "lateCheckout.occurred": 1,
});

shiftOccurrenceSchema.index({
  "checkoutFallback.required": 1,
});

shiftOccurrenceSchema.index({
  "attendanceOverride.used": 1,
});

shiftOccurrenceSchema.index({
  "overtime.status": 1,
});

shiftOccurrenceSchema.index({
  "overtime.employerResponseDeadlineAt": 1,
  "overtime.employerResponseOverdueAt": 1,
});

shiftOccurrenceSchema.index({
  "overtime.status": 1,
  "overtime.adminReviewReason": 1,
  "overtime.adminReviewStartedAt": 1,
});

shiftOccurrenceSchema.index({
  "overtime.topUpOverdueAt": 1,
  "overtime.restrictionTriggeredAt": 1,
});

shiftOccurrenceSchema.index({
  topUpTransaction: 1,
});

shiftOccurrenceSchema.index({
  replacementReasonCode: 1,
  assignmentStatus: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  "cancellationCompensation.applicable": 1,
  settlementStatus: 1,
});

shiftOccurrenceSchema.index({
  "activeWorkCancellation.occurred": 1,
  status: 1,
  startTime: 1,
});

shiftOccurrenceSchema.index({
  shift: 1,
  status: 1,
  cancellationCode: 1,
});

shiftOccurrenceSchema.index({
  business: 1,
  status: 1,
  cancelledAt: -1,
});

shiftOccurrenceSchema.index({
  cancellationCode: 1,
  cancelledAt: -1,
});

shiftOccurrenceSchema.index({
  cancelledByUser: 1,
  cancelledAt: -1,
});

shiftOccurrenceSchema.index({
  "overtime.status": 1,
  "overtime.topUpPaid": 1,
  "overtime.topUpDeadlineAt": 1,
});

/**
 * Employer delinquency authority query support.
 *
 * Historical restrictionTriggeredAt remains on the occurrence after payment.
 * Current restriction queries must also require unpaid/outstanding OT.
 */
shiftOccurrenceSchema.index({
  business: 1,
  "overtime.requested": 1,
  "overtime.status": 1,
  "overtime.topUpPaid": 1,
  "overtime.restrictionTriggeredAt": 1,
  topUpRequired: 1,
});

/* ─────────────────────────────── PROFESSIONAL PAYOUT INDEXES ─────────────────────────────── */

shiftOccurrenceSchema.index({
  assignedProfessional: 1,
  "baseSettlement.status": 1,
  "baseSettlement.scheduledPayoutAt": 1,
});

shiftOccurrenceSchema.index({
  assignedProfessional: 1,
  "overtimeSettlement.status": 1,
  "overtimeSettlement.scheduledPayoutAt": 1,
});

shiftOccurrenceSchema.index({
  "baseSettlement.settlementBatch": 1,
});

shiftOccurrenceSchema.index({
  "overtimeSettlement.settlementBatch": 1,
});

shiftOccurrenceSchema.index({
  "baseSettlement.payoutTransaction": 1,
});

shiftOccurrenceSchema.index({
  "overtimeSettlement.payoutTransaction": 1,
});

/* ─────────────────────────────── PLATFORM FEE INDEXES ─────────────────────────────── */

shiftOccurrenceSchema.index({
  business: 1,
  "basePlatformFeeAudit.earnedAt": 1,
  "basePlatformFeeAudit.collectedAt": 1,
});

shiftOccurrenceSchema.index({
  business: 1,
  "overtimePlatformFeeAudit.earnedAt": 1,
  "overtimePlatformFeeAudit.collectedAt": 1,
});

shiftOccurrenceSchema.index({
  "overtimePlatformFeeAudit.outstandingAt": 1,
  "overtimePlatformFeeAudit.collectedAt": 1,
});

shiftOccurrenceSchema.index({
  "basePlatformFeeAudit.collectionTransaction": 1,
});

shiftOccurrenceSchema.index({
  "overtimePlatformFeeAudit.collectionTransaction": 1,
});

module.exports = mongoose.model("ShiftOccurrence", shiftOccurrenceSchema);
