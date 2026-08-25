// models/Shift.js

const mongoose = require("mongoose");

const attendanceLocationSchema = require("./helpers/attendanceLocationSchema");

const {
  minorUnitAmountField,
  nonNegativeIntegerField,
  requiredPositiveMinorUnitAmountField,
} = require("./helpers/schemaFields");

const {
  isNullableSafeInteger,
  isNullableLocalDateString,
  isValidTimeZone,
  approximatelyEqual,
  hasDocumentValue,
  validateAmountTriple,
} = require("./helpers/schemaValidators");

const {
  calculatePatternScheduledMinutes,
  requiresParentAttendancePins,
  hasParentAttendanceCompatibilityData,
  validateMinimumDetails,
} = require("./helpers/shiftSchemaHelpers");

const {
  MAX_SHIFT_OCCURRENCES,
  MAX_APPLICATION_ROUNDS,
  MINUTES_PER_DAY,
  SHIFT_STATUSES,
  SHIFT_PAYMENT_STATUSES,
  SHIFT_ASSIGNMENT_SUMMARY_REQUIRED_STATUSES,
  SHIFT_PUBLISHED_PAYMENT_STATUSES,
  SHIFT_FINAL_PAYMENT_STATUSES,
  SHIFT_CANCELLABLE_FROM_STATUSES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_OVERRIDE_TYPES,
  ATTENDANCE_OVERRIDE_REASONS,
  LATE_CHECKOUT_OPTIONS,
  LATE_CHECKOUT_REASONS,
  CHECKOUT_FALLBACK_REASONS,
  MISSED_CHECKIN_REASONS,
  MISSED_CHECKIN_OUTCOMES,
  REPLACEMENT_HIRING_STATUSES,
  ACTIVE_REPLACEMENT_HIRING_STATUSES,
  REPLACEMENT_HIRING_CONTEXT_STATUSES,
  REPLACEMENT_REASON_CODES,
  REPLACEMENT_REASON_CODES_REQUIRING_DETAILS,
  CANCELLATION_ACTORS,
  USER_CANCELLATION_ACTORS,
  SHIFT_CANCELLATION_CODES,
  CANCELLATION_CODE_ACTORS,
  EMPLOYER_CANCELLATION_REASON_CODES,
  CANCELLATION_REASON_CODES_REQUIRING_DETAILS,
} = require("../constants/shiftLifecycle");

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

/**
 * ENGAGEMENT ARCHITECTURE:
 *
 * Shift is the public marketplace post and hiring unit.
 *
 * scheduleMode "single":
 * - one Shift
 * - one work occurrence
 * - one application process for each active hiring need
 *
 * scheduleMode "multiple":
 * - one Shift
 * - one application process for each active hiring need
 * - between 2 and 30 generated ShiftOccurrence records
 *
 * One current assignment may coexist with one scheduled replacement:
 *
 * - the outgoing professional may remain responsible through a confirmed
 *   final occurrence
 * - replacement recruitment may open for the untouched future tail
 * - an accepted replacement may remain scheduled until their range begins
 *
 * Replacement recruitment is represented by replacementHiring and does not
 * require the whole parent Shift to return to status "open".
 *
 * ShiftOccurrence records hold the authoritative date-specific assignee,
 * attendance, overtime, cancellation, refund and settlement state.
 *
 * They are not separately claimable jobs and parent assignedProfessional
 * must never be used as the sole payout authority.
 *
 * PAYMENT ARCHITECTURE:
 *
 * Loqum uses a Protected Shift payment flow.
 *
 * Employer pays:
 * professional approved pay + Loqum platform fee.
 *
 * The active platform fee is read from PlatformSettings when the
 * engagement is posted.
 *
 * The selected rate is snapshotted into the Shift as platformFeeRate.
 *
 * The professional receives the agreed or approved professional pay.
 * No professional-side commission deduction applies at launch.
 *
 * PROFESSIONAL PAYOUT VS PLATFORM FEE:
 *
 * Professional payout and Loqum platform-fee collection are separate
 * authorities.
 *
 * ShiftSettlementBatch is professional payout only.
 *
 * Loqum platform fees are earned/collected independently at occurrence level.
 * A fee movement must never cause parent paymentStatus to become
 * release_pending, partially_released or released.
 *
 * The parent Shift stores summary totals only. It is not payout or fee-release
 * authority.
 *
 * Each occurrence independently establishes earnings entitlement. Approved
 * occurrence earnings are grouped into the professional's general weekly
 * ShiftSettlementBatch. A batch may contain work from several employers and
 * parent Shift engagements.
 *
 * Funds belonging to untouched future occurrences remain protected in escrow.
 * If an occurrence expires unfilled, is cancelled or has unused scheduled
 * time after final pricing, an occurrence-level EmployerRefund obligation
 * may be established.
 *
 * Wallet-funded protected money returns to the employer wallet.
 * Paystack Checkout-funded protected money returns through Paystack against
 * the original payment. An approved Paystack Transfer may be used only as
 * the fallback when the provider refund cannot be completed.
 *
 * Publication rule:
 *
 * A Shift is not published or opened for applications until the
 * employer funds the full estimated employer charge.
 *
 * A newly created Shift begins as:
 *
 * status: pending_funding
 * paymentStatus: unpaid
 *
 * Once wallet funding succeeds or Paystack confirms payment:
 *
 * - Protected Shift balance is credited
 * - paymentStatus becomes funded
 * - status becomes open
 * - publishedAt is recorded
 *
 * MARKETPLACE AND FILL CUTOFF:
 *
 * The parent Shift does not own one authoritative fill cutoff because every
 * occurrence may have a different fillCutoffAt and unfilledFinalizationAt.
 * Marketplace and finalisation services must query ShiftOccurrence records.
 *
 * A parent may remain open while at least one ordinary unassigned occurrence
 * remains scheduled and fillable. Earlier occurrences may already be
 * expired_unfilled and refunded, so an open parent may legitimately have
 * paymentStatus partially_refunded.
 *
 * FUNDING OPTIONS:
 *
 * 1. Employer Wallet
 *    Employer wallet availableBalance is debited.
 *    Protected Shift balance is credited.
 *
 * 2. Paystack Checkout
 *    Employer pays through Paystack Checkout.
 *    Loqum verifies the payment before crediting Protected Shift funds.
 *
 * DVA:
 *
 * DVA only tops up the employer wallet.
 * It does not directly fund a Shift.
 *
 * ATTENDANCE:
 *
 * Attendance is validated using geofencing.
 *
 * Every ShiftOccurrence owns authoritative attendance, overtime and settlement
 * state. Parent attendance fields exist only as single-Shift display compatibility.
 *
 * Every Shift, including scheduleMode "single", has at least one
 * authoritative ShiftOccurrence. Parent attendance fields remain only as
 * temporary compatibility summaries for single engagements and must remain
 * empty for multiple engagements.
 *
 * CANCELLATION, ACTIVE WORK AND REPLACEMENT:
 *
 * The employer, the system or an administrator may cancel the entire
 * engagement through the parent Shift cancellation workflow.
 *
 * For a multiple engagement, the employer or an administrator may also
 * selectively cancel one untouched future ShiftOccurrence without cancelling
 * the parent engagement. Other scheduled occurrences remain active.
 *
 * A professional does not cancel the employer-owned Shift or occurrence.
 * Professional unavailability is handled through assignment release and
 * replacement hiring unless the employer independently decides that coverage
 * is no longer required for that occurrence.
 *
 * Parent Shift cancellation fields record only cancellation of the entire
 * engagement. Selective occurrence cancellation audit belongs exclusively to
 * the affected ShiftOccurrence.
 *
 * Parent cancellation summaries are operational locators only. Professional
 * cancellation entitlement, platform-fee outcome and employer refund amounts
 * remain occurrence-level authorities and must not be recalculated here.
 */

/* ─────────────────────────────── PARENT OCCURRENCE PROGRESS ─────────────────────────────── */

const occurrenceProgressSchema = new mongoose.Schema(
  {
    unassigned: nonNegativeIntegerField(),

    assigned: nonNegativeIntegerField(),

    replacementRequired: nonNegativeIntegerField(),

    expiredUnfilled: nonNegativeIntegerField(),

    scheduled: nonNegativeIntegerField(),

    inProgress: nonNegativeIntegerField(),

    pendingSettlement: nonNegativeIntegerField(),

    completed: nonNegativeIntegerField(),

    cancelled: nonNegativeIntegerField(),

    noShow: nonNegativeIntegerField(),

    disputed: nonNegativeIntegerField(),

    settlementNotDue: nonNegativeIntegerField(),

    pendingReview: nonNegativeIntegerField(),

    awaitingOvertimeReview: nonNegativeIntegerField(),

    awaitingTopup: nonNegativeIntegerField(),

    approvedForRelease: nonNegativeIntegerField(),

    releasePending: nonNegativeIntegerField(),

    released: nonNegativeIntegerField(),

    failed: nonNegativeIntegerField(),

    settlementDisputed: nonNegativeIntegerField(),

    refundNotEligible: nonNegativeIntegerField(),

    refundHeld: nonNegativeIntegerField(),

    refundEligible: nonNegativeIntegerField(),

    refundBatched: nonNegativeIntegerField(),

    refundProcessing: nonNegativeIntegerField(),

    refunded: nonNegativeIntegerField(),

    resolved: nonNegativeIntegerField(),

    lastReconciledAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── PARENT SETTLEMENT SUMMARY ─────────────────────────────── */

/**
 * Parent financial summary only.
 *
 * Professional payout and Loqum platform-fee collection are independent
 * authorities:
 *
 * - approvedProfessionalPay / releasedProfessionalPay summarize the
 *   professional settlement lifecycle.
 *
 * - earnedPlatformFee / collectedPlatformFee summarize Loqum fee state.
 *
 * Platform-fee movement MUST NOT advance the parent professional payout state.
 *
 * committedEmployerCharge is a summary of money that is no longer refundable
 * because it belongs to either an approved professional entitlement or an
 * earned Loqum fee. It is not a settlement instruction.
 */
const settlementSummarySchema = new mongoose.Schema(
  {
    approvedProfessionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    releasedProfessionalPay: minorUnitAmountField({
      defaultValue: 0,
    }),

    earnedPlatformFee: minorUnitAmountField({
      defaultValue: 0,
    }),

    collectedPlatformFee: minorUnitAmountField({
      defaultValue: 0,
    }),

    committedEmployerCharge: minorUnitAmountField({
      defaultValue: 0,
    }),

    lastProfessionalApprovedAt: {
      type: Date,
      default: null,
    },

    lastProfessionalReleasedAt: {
      type: Date,
      default: null,
    },

    lastPlatformFeeEarnedAt: {
      type: Date,
      default: null,
    },

    lastPlatformFeeCollectedAt: {
      type: Date,
      default: null,
    },

    lastReconciledAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── CANCELLATION POLICY SNAPSHOT ─────────────────────────────── */

const cancellationPolicySnapshotSchema = new mongoose.Schema(
  {
    lateCancellationWindowMinutes: {
      type: Number,
      min: 0,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "cancellationPolicySnapshot.lateCancellationWindowMinutes must be a whole number.",
      },
    },

    lateCancellationProfessionalPayRate: {
      type: Number,
      min: 0,
      max: 1,
      required: true,
      validate: {
        validator: isSupportedFinancialRate,
        message:
          "cancellationPolicySnapshot.lateCancellationProfessionalPayRate must use the supported financial rate precision.",
      },
    },

    activeWorkCancellationMinimumPayRate: {
      type: Number,
      min: 0,
      max: 1,
      required: true,
      validate: {
        validator: isSupportedFinancialRate,
        message:
          "cancellationPolicySnapshot.activeWorkCancellationMinimumPayRate must use the supported financial rate precision.",
      },
    },

    lockedAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── CANCELLATION SUMMARY ─────────────────────────────── */

const cancellationSummarySchema = new mongoose.Schema(
  {
    /**
     * Parent cancellation-range summary only.
     *
     * Financial cancellation entitlement, platform-fee earning and employer
     * refund amounts belong to ShiftOccurrence and their dedicated services.
     *
     * The parent stores only enough information to identify the affected
     * occurrence range and whether occurrence-level compensation exists.
     */
    firstAffectedOccurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    firstAffectedSequenceNumber: {
      type: Number,
      default: null,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: isNullableSafeInteger,
        message: "cancellationSummary.firstAffectedSequenceNumber must be a whole number.",
      },
    },

    cancelledOccurrenceCount: {
      type: Number,
      default: 0,
      min: 0,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: Number.isSafeInteger,
        message: "cancellationSummary.cancelledOccurrenceCount must be a whole number.",
      },
    },

    /**
     * Derived parent indicator only.
     *
     * When true, the authoritative compensation amount remains on the
     * affected ShiftOccurrence.
     */
    compensationApplicable: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── ACTIVE-WORK CANCELLATION SUMMARY ─────────────────────────────── */

const activeWorkCancellationSummarySchema = new mongoose.Schema(
  {
    /**
     * Parent active-work cancellation locator only.
     *
     * The authoritative early-work calculation remains on the affected
     * ShiftOccurrence.activeWorkCancellation record.
     *
     * Parent cancellation actor/reason/time already live on the top-level
     * Shift cancellation audit, so they are not duplicated here.
     */
    occurred: {
      type: Boolean,
      default: false,
    },

    affectedOccurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    affectedSequenceNumber: {
      type: Number,
      default: null,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: isNullableSafeInteger,
        message: "activeWorkCancellation.affectedSequenceNumber must be a whole number.",
      },
    },

    effectiveAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── REPLACEMENT HIRING SUMMARY ─────────────────────────────── */

const replacementHiringSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: REPLACEMENT_HIRING_STATUSES,
      default: "closed",
      required: true,
    },

    assignmentCase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignmentCase",
      default: null,
    },

    applicationRound: {
      type: Number,
      default: null,
      min: 2,
      max: MAX_APPLICATION_ROUNDS,
      validate: {
        validator: isNullableSafeInteger,
        message: "replacementHiring.applicationRound must be a whole number.",
      },
    },

    replacementForAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    startSequenceNumber: {
      type: Number,
      default: null,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: isNullableSafeInteger,
        message: "replacementHiring.startSequenceNumber must be a whole number.",
      },
    },

    endSequenceNumber: {
      type: Number,
      default: null,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: isNullableSafeInteger,
        message: "replacementHiring.endSequenceNumber must be a whole number.",
      },
    },

    occurrenceCount: {
      type: Number,
      default: 0,
      min: 0,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: Number.isSafeInteger,
        message: "replacementHiring.occurrenceCount must be a whole number.",
      },
    },

    reasonCode: {
      type: String,
      enum: [...REPLACEMENT_REASON_CODES, null],
      default: null,
    },

    reasonDetails: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    openedAt: {
      type: Date,
      default: null,
    },

    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    filledAt: {
      type: Date,
      default: null,
    },

    filledByAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
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
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── SHIFT SCHEMA ─────────────────────────────── */

const shiftSchema = new mongoose.Schema(
  {
    // --- CORE IDENTITY ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
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

    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    department: {
      type: String,
      trim: true,
      maxlength: 120,
    },

    roleTitle: {
      type: String,
      trim: true,
      required: true,
      maxlength: 120,
    },

    professionalType: {
      type: String,
      enum: [
        "pharmacist",
        "pharmacy_technician",
        "nurse",
        "doctor",
        "lab_scientist",
        "radiographer",
        "physiotherapist",
      ],
      required: true,
    },

    // --- SCHEDULE ---

    scheduleMode: {
      type: String,
      enum: ["single", "multiple"],
      default: "single",
      required: true,
    },

    occurrenceCount: {
      type: Number,
      default: 1,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "occurrenceCount must be a whole number.",
      },
    },

    repeatDays: [
      {
        type: Number,
        min: 0,
        max: 6,
        validate: {
          validator: Number.isSafeInteger,
          message: "Each repeat day must be a whole number from 0 to 6.",
        },
      },
    ],

    firstOccurrenceDate: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator: isNullableLocalDateString,
        message: "firstOccurrenceDate must be a valid date in YYYY-MM-DD format.",
      },
    },

    lastOccurrenceDate: {
      type: String,
      trim: true,
      default: null,
      validate: {
        validator: isNullableLocalDateString,
        message: "lastOccurrenceDate must be a valid date in YYYY-MM-DD format.",
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

    dailyStartTimeMinutes: {
      type: Number,
      default: null,
      min: 0,
      max: MINUTES_PER_DAY - 1,
      validate: {
        validator: isNullableSafeInteger,
        message: "dailyStartTimeMinutes must be a whole number.",
      },
    },

    dailyEndTimeMinutes: {
      type: Number,
      default: null,
      min: 0,
      max: MINUTES_PER_DAY - 1,
      validate: {
        validator: isNullableSafeInteger,
        message: "dailyEndTimeMinutes must be a whole number.",
      },
    },

    endsNextDay: {
      type: Boolean,
      default: false,
    },

    scheduledMinutesPerOccurrence: {
      type: Number,
      required: true,
      min: 1,
      max: MINUTES_PER_DAY,
      validate: {
        validator: Number.isSafeInteger,
        message: "scheduledMinutesPerOccurrence must be a whole number.",
      },
    },

    totalScheduledMinutes: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES * MINUTES_PER_DAY,
      validate: {
        validator: Number.isSafeInteger,
        message: "totalScheduledMinutes must be a whole number.",
      },
    },

    startTime: {
      type: Date,
      required: true,
    },

    endTime: {
      type: Date,
      required: true,
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

    // Single-shift compatibility summaries only.
    // Multiple engagements use occurrence pricing and settlementSummary.

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

    // --- FINANCIALS ---

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      required: true,
      match: [/^[A-Z]{2}$/, "countryCode must contain exactly 2 uppercase letters."],
    },

    currency: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      required: true,
      match: [/^[A-Z]{3}$/, "currency must contain exactly 3 uppercase letters."],
    },

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

    pricingLockedAt: {
      type: Date,
      required: true,
    },

    pricingLockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    cancellationPolicySnapshot: {
      type: cancellationPolicySnapshotSchema,
      default: undefined,
      required: true,
    },

    estimatedProfessionalPay: requiredPositiveMinorUnitAmountField(),

    estimatedPlatformFee: minorUnitAmountField({
      required: true,
    }),

    estimatedEmployerCharge: requiredPositiveMinorUnitAmountField(),

    fundedAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

    topUpRequired: minorUnitAmountField({
      defaultValue: 0,
    }),

    refundedAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

    settlementSummary: {
      type: settlementSummarySchema,
      default: () => ({}),
    },

    // --- PAYMENT STATE ---

    paymentStatus: {
      type: String,
      enum: SHIFT_PAYMENT_STATUSES,
      default: "unpaid",
      required: true,
    },

    fundingMethod: {
      type: String,
      enum: ["wallet", "paystack_checkout", null],
      default: null,
    },

    fundingInitiatedAt: {
      type: Date,
      default: null,
    },

    fundedAt: {
      type: Date,
      default: null,
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    /**
     * Original protected-funding identity only.
     */
    fundingTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    // --- PROFESSIONAL ASSIGNMENT ---

    activeAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    assignedProfessional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    applicationRound: {
      type: Number,
      default: 1,
      min: 1,
      max: MAX_APPLICATION_ROUNDS,
      validate: {
        validator: Number.isSafeInteger,
        message: "applicationRound must be a whole number.",
      },
    },

    replacementHiring: {
      type: replacementHiringSchema,
      default: () => ({}),
    },

    totalApplications: nonNegativeIntegerField(),

    currentRoundApplications: nonNegativeIntegerField(),

    // --- ENGAGEMENT STATUS ---

    status: {
      type: String,
      enum: SHIFT_STATUSES,
      default: "pending_funding",
      required: true,
    },

    occurrenceProgress: {
      type: occurrenceProgressSchema,
      default: () => ({}),
    },

    // --- ATTENDANCE ---

    attendanceStatus: {
      type: String,
      enum: ATTENDANCE_STATUSES,
      default: "not_started",
      required: true,
    },

    checkedInAt: {
      type: Date,
      default: null,
    },

    checkedOutAt: {
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
      required: requiresParentAttendancePins,
      select: false,
      match: [/^\d{4}$/, "checkInPin must contain exactly 4 digits."],
    },

    checkOutPin: {
      type: String,
      required: requiresParentAttendancePins,
      select: false,
      match: [/^\d{4}$/, "checkOutPin must contain exactly 4 digits."],
    },

    attendancePinsGeneratedAt: {
      type: Date,
      required: requiresParentAttendancePins,
    },

    checkInPinUsedAt: {
      type: Date,
      default: null,
    },

    checkOutPinUsedAt: {
      type: Date,
      default: null,
    },

    // --- ATTENDANCE REVIEW AND OVERRIDE ---

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

    // --- MISSED CHECK-IN REQUEST ---

    missedCheckInRequest: {
      claimedStartTime: {
        type: Date,
        default: null,
      },

      submittedAt: {
        type: Date,
        default: null,
      },

      reason: {
        type: String,
        enum: [...MISSED_CHECKIN_REASONS, null],
        default: null,
      },

      locationAtSubmission: {
        type: attendanceLocationSchema,
        default: () => ({}),
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

      outcome: {
        type: String,
        enum: [...MISSED_CHECKIN_OUTCOMES, null],
        default: null,
      },

      approvedStartTime: {
        type: Date,
        default: null,
      },

      rejectionReason: {
        type: String,
        trim: true,
        maxlength: 300,
        default: null,
      },
    },

    // --- REQUIREMENTS AND SCOPE ---

    requiredSkills: [
      {
        type: String,
        trim: true,
        maxlength: 100,
      },
    ],

    dressCode: {
      type: String,
      trim: true,
      maxlength: 300,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // --- CANCELLATION ---

    cancelledFromStatus: {
      type: String,
      enum: [...SHIFT_CANCELLABLE_FROM_STATUSES, null],
      default: null,
    },

    cancellationCode: {
      type: String,
      enum: [...SHIFT_CANCELLATION_CODES, null],
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

    cancellationReasonCode: {
      type: String,
      enum: [...EMPLOYER_CANCELLATION_REASON_CODES, null],
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

    cancellationSummary: {
      type: cancellationSummarySchema,
      default: () => ({}),
    },

    activeWorkCancellation: {
      type: activeWorkCancellationSummarySchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── MODEL VALIDATION ─────────────────────────────── */

shiftSchema.pre("validate", function validateShift() {
  const scheduleMode = this.scheduleMode || "single";

  const occurrenceCount = Number(this.occurrenceCount);

  const repeatDays = Array.isArray(this.repeatDays) ? this.repeatDays : [];

  const occurrenceProgress = this.occurrenceProgress || {};

  if (this.startTime && this.endTime && this.endTime <= this.startTime) {
    this.invalidate("endTime", "endTime must be later than startTime.");
  }

  const uniqueRepeatDays = new Set(repeatDays.map(Number));

  if (uniqueRepeatDays.size !== repeatDays.length) {
    this.invalidate("repeatDays", "repeatDays cannot contain duplicate weekdays.");
  }

  /* ─────────────────────────────── SINGLE SHIFT ─────────────────────────────── */

  if (scheduleMode === "single") {
    if (occurrenceCount !== 1) {
      this.invalidate("occurrenceCount", "A single shift must contain exactly one occurrence.");
    }

    if (repeatDays.length > 0) {
      this.invalidate("repeatDays", "A single shift cannot contain repeat days.");
    }

    if (this.startTime && this.endTime) {
      const actualScheduledMinutes =
        (this.endTime.getTime() - this.startTime.getTime()) / (60 * 1000);

      if (
        !Number.isSafeInteger(actualScheduledMinutes) ||
        actualScheduledMinutes <= 0 ||
        actualScheduledMinutes > MINUTES_PER_DAY
      ) {
        this.invalidate(
          "endTime",
          "A single shift must have a whole-minute duration between 1 minute and 24 hours."
        );
      } else {
        if (this.scheduledMinutesPerOccurrence !== actualScheduledMinutes) {
          this.invalidate(
            "scheduledMinutesPerOccurrence",
            "scheduledMinutesPerOccurrence must match the single shift duration."
          );
        }

        if (this.totalScheduledMinutes !== actualScheduledMinutes) {
          this.invalidate(
            "totalScheduledMinutes",
            "totalScheduledMinutes must match the single shift duration."
          );
        }

        if (
          Number.isFinite(this.scheduledHours) &&
          !approximatelyEqual(this.scheduledHours, actualScheduledMinutes / 60)
        ) {
          this.invalidate("scheduledHours", "scheduledHours must match the single shift duration.");
        }

        if (
          Number.isSafeInteger(this.breakDuration) &&
          this.breakDuration >= actualScheduledMinutes
        ) {
          this.invalidate(
            "breakDuration",
            "breakDuration must be shorter than the single shift duration."
          );
        }
      }
    }
  }

  /* ─────────────────────────────── MULTIPLE SHIFTS ─────────────────────────────── */

  if (scheduleMode === "multiple") {
    if (
      !Number.isSafeInteger(occurrenceCount) ||
      occurrenceCount < 2 ||
      occurrenceCount > MAX_SHIFT_OCCURRENCES
    ) {
      this.invalidate(
        "occurrenceCount",
        `A multiple-shift engagement must contain between 2 and ${MAX_SHIFT_OCCURRENCES} occurrences.`
      );
    }

    if (repeatDays.length === 0) {
      this.invalidate(
        "repeatDays",
        "A multiple-shift engagement must include at least one repeat day."
      );
    }

    if (!this.firstOccurrenceDate) {
      this.invalidate(
        "firstOccurrenceDate",
        "firstOccurrenceDate is required for a multiple-shift engagement."
      );
    }

    if (!this.lastOccurrenceDate) {
      this.invalidate(
        "lastOccurrenceDate",
        "lastOccurrenceDate is required for a multiple-shift engagement."
      );
    }

    if (
      this.firstOccurrenceDate &&
      this.lastOccurrenceDate &&
      this.lastOccurrenceDate < this.firstOccurrenceDate
    ) {
      this.invalidate(
        "lastOccurrenceDate",
        "lastOccurrenceDate cannot be earlier than firstOccurrenceDate."
      );
    }

    if (!this.scheduleTimeZone) {
      this.invalidate(
        "scheduleTimeZone",
        "scheduleTimeZone is required for a multiple-shift engagement."
      );
    }

    if (this.checkInPin || this.checkOutPin || this.attendancePinsGeneratedAt) {
      this.invalidate(
        "checkInPin",
        "Multiple-shift engagements must store attendance PINs on ShiftOccurrence records."
      );
    }

    const patternScheduledMinutes = calculatePatternScheduledMinutes({
      dailyStartTimeMinutes: this.dailyStartTimeMinutes,
      dailyEndTimeMinutes: this.dailyEndTimeMinutes,
      endsNextDay: this.endsNextDay,
    });

    if (
      !Number.isSafeInteger(patternScheduledMinutes) ||
      patternScheduledMinutes <= 0 ||
      patternScheduledMinutes > MINUTES_PER_DAY
    ) {
      this.invalidate(
        "dailyEndTimeMinutes",
        "Each repeated occurrence must last between 1 minute and 24 hours."
      );
    } else {
      if (this.scheduledMinutesPerOccurrence !== patternScheduledMinutes) {
        this.invalidate(
          "scheduledMinutesPerOccurrence",
          "scheduledMinutesPerOccurrence must match the repeated daily schedule."
        );
      }

      const expectedTotalScheduledMinutes = patternScheduledMinutes * occurrenceCount;

      if (this.totalScheduledMinutes !== expectedTotalScheduledMinutes) {
        this.invalidate(
          "totalScheduledMinutes",
          "totalScheduledMinutes must equal occurrenceCount multiplied by scheduledMinutesPerOccurrence."
        );
      }

      if (
        Number.isFinite(this.scheduledHours) &&
        !approximatelyEqual(this.scheduledHours, expectedTotalScheduledMinutes / 60)
      ) {
        this.invalidate(
          "scheduledHours",
          "scheduledHours must equal the total hours across all occurrences."
        );
      }

      if (
        Number.isSafeInteger(this.breakDuration) &&
        this.breakDuration >= patternScheduledMinutes
      ) {
        this.invalidate("breakDuration", "breakDuration must be shorter than each occurrence.");
      }
    }

    if (hasParentAttendanceCompatibilityData(this)) {
      this.invalidate(
        "attendanceStatus",
        "Multiple-shift engagements must keep attendance and attendance-review state on ShiftOccurrence records only."
      );
    }

    if (hasDocumentValue(this.baseBillableHours) || hasDocumentValue(this.billableHours)) {
      this.invalidate(
        "baseBillableHours",
        "Multiple-shift engagements must keep billable-time state on ShiftOccurrence records."
      );
    }
  }

  /* ─────────────────────────────── PRICING LOCK CONSISTENCY ─────────────────────────────── */

  if (
    this.pricingLockedAt &&
    this.cancellationPolicySnapshot?.lockedAt &&
    this.pricingLockedAt.getTime() !== this.cancellationPolicySnapshot.lockedAt.getTime()
  ) {
    this.invalidate(
      "cancellationPolicySnapshot.lockedAt",
      "The cancellation policy snapshot must be locked at the same time as Shift pricing."
    );
  }

  /* ─────────────────────────────── PRICING ─────────────────────────────── */

  validateAmountTriple(this, {
    professionalPath: "estimatedProfessionalPay",
    platformPath: "estimatedPlatformFee",
    employerPath: "estimatedEmployerCharge",
    label: "Estimated",
  });

  const pricingHourlyRate = Number(this.hourlyRate);

  const pricingScheduledMinutesPerOccurrence = Number(this.scheduledMinutesPerOccurrence);

  const pricingOccurrenceCount = Number(this.occurrenceCount);

  const pricingEstimatedProfessionalPay = Number(this.estimatedProfessionalPay);

  const pricingEstimatedPlatformFee = Number(this.estimatedPlatformFee);

  const pricingPlatformFeeRate = Number(this.platformFeeRate);

  let expectedProfessionalPayPerOccurrence = null;

  if (
    Number.isSafeInteger(pricingHourlyRate) &&
    pricingHourlyRate > 0 &&
    Number.isSafeInteger(pricingScheduledMinutesPerOccurrence) &&
    pricingScheduledMinutesPerOccurrence > 0
  ) {
    try {
      expectedProfessionalPayPerOccurrence = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: pricingHourlyRate,
        minutes: pricingScheduledMinutesPerOccurrence,
        fieldName: "Estimated professional pay per occurrence",
      });
    } catch (error) {
      this.invalidate(
        "estimatedProfessionalPay",
        "Estimated professional pay exceeds the supported safe-integer range."
      );
    }
  }

  if (
    Number.isSafeInteger(expectedProfessionalPayPerOccurrence) &&
    Number.isSafeInteger(pricingOccurrenceCount) &&
    pricingOccurrenceCount > 0 &&
    pricingOccurrenceCount <= MAX_SHIFT_OCCURRENCES
  ) {
    let expectedEstimatedProfessionalPay = null;

    try {
      expectedEstimatedProfessionalPay = money.sumMinorUnitAmounts(
        Array.from(
          {
            length: pricingOccurrenceCount,
          },
          () => expectedProfessionalPayPerOccurrence
        ),
        "Estimated professional pay"
      );
    } catch (error) {
      this.invalidate(
        "estimatedProfessionalPay",
        "Estimated professional pay exceeds the supported safe-integer range."
      );
    }

    if (
      Number.isSafeInteger(expectedEstimatedProfessionalPay) &&
      pricingEstimatedProfessionalPay !== expectedEstimatedProfessionalPay
    ) {
      this.invalidate(
        "estimatedProfessionalPay",
        "Estimated professional pay must equal the per-occurrence professional pay multiplied by occurrenceCount."
      );
    }
  }

  if (
    Number.isSafeInteger(expectedProfessionalPayPerOccurrence) &&
    Number.isSafeInteger(pricingOccurrenceCount) &&
    pricingOccurrenceCount > 0 &&
    pricingOccurrenceCount <= MAX_SHIFT_OCCURRENCES &&
    isSupportedFinancialRate(pricingPlatformFeeRate)
  ) {
    let expectedPlatformFeePerOccurrence = null;

    let expectedEstimatedPlatformFee = null;

    try {
      expectedPlatformFeePerOccurrence = money.calculateMinorAmountFromRate({
        amountMinor: expectedProfessionalPayPerOccurrence,
        rate: pricingPlatformFeeRate,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "Estimated platform fee per occurrence",
        rateFieldName: "Platform fee rate",
      });

      expectedEstimatedPlatformFee = money.sumMinorUnitAmounts(
        Array.from(
          {
            length: pricingOccurrenceCount,
          },
          () => expectedPlatformFeePerOccurrence
        ),
        "Estimated platform fee"
      );
    } catch (error) {
      this.invalidate(
        "estimatedPlatformFee",
        "Estimated platform fee exceeds the supported safe-integer range."
      );
    }

    if (
      Number.isSafeInteger(expectedEstimatedPlatformFee) &&
      pricingEstimatedPlatformFee !== expectedEstimatedPlatformFee
    ) {
      this.invalidate(
        "estimatedPlatformFee",
        "Estimated platform fee must equal the per-occurrence platform fee multiplied by occurrenceCount."
      );
    }
  }

  /* ─────────────────────────────── PARENT FINANCIAL SUMMARY ─────────────────────────────── */

  const approvedProfessionalPay = Number(this.settlementSummary?.approvedProfessionalPay || 0);

  const releasedProfessionalPay = Number(this.settlementSummary?.releasedProfessionalPay || 0);

  const earnedPlatformFee = Number(this.settlementSummary?.earnedPlatformFee || 0);

  const collectedPlatformFee = Number(this.settlementSummary?.collectedPlatformFee || 0);

  const committedEmployerCharge = Number(this.settlementSummary?.committedEmployerCharge || 0);

  if (
    !Number.isSafeInteger(approvedProfessionalPay) ||
    !Number.isSafeInteger(releasedProfessionalPay) ||
    !Number.isSafeInteger(earnedPlatformFee) ||
    !Number.isSafeInteger(collectedPlatformFee) ||
    !Number.isSafeInteger(committedEmployerCharge)
  ) {
    this.invalidate(
      "settlementSummary",
      "Parent settlement summary amounts must be safe whole-number minor-unit amounts."
    );
  }

  if (releasedProfessionalPay > approvedProfessionalPay) {
    this.invalidate(
      "settlementSummary.releasedProfessionalPay",
      "Released professional pay cannot exceed approved professional pay."
    );
  }

  if (collectedPlatformFee > earnedPlatformFee) {
    this.invalidate(
      "settlementSummary.collectedPlatformFee",
      "Collected platform fee cannot exceed the currently earned platform fee."
    );
  }

  if (
    Number.isSafeInteger(approvedProfessionalPay) &&
    Number.isSafeInteger(earnedPlatformFee) &&
    Number.isSafeInteger(committedEmployerCharge)
  ) {
    try {
      const expectedCommittedEmployerCharge = money.sumMinorUnitAmounts(
        [approvedProfessionalPay, earnedPlatformFee],
        "Committed employer charge"
      );

      if (committedEmployerCharge !== expectedCommittedEmployerCharge) {
        this.invalidate(
          "settlementSummary.committedEmployerCharge",
          "committedEmployerCharge must equal approvedProfessionalPay plus earnedPlatformFee."
        );
      }
    } catch (error) {
      this.invalidate(
        "settlementSummary.committedEmployerCharge",
        "committedEmployerCharge exceeds the supported safe-integer range."
      );
    }
  }

  if (this.settlementSummary?.lastProfessionalApprovedAt && approvedProfessionalPay <= 0) {
    this.invalidate(
      "settlementSummary.lastProfessionalApprovedAt",
      "lastProfessionalApprovedAt requires positive approved professional pay."
    );
  }

  if (this.settlementSummary?.lastProfessionalReleasedAt && releasedProfessionalPay <= 0) {
    this.invalidate(
      "settlementSummary.lastProfessionalReleasedAt",
      "lastProfessionalReleasedAt requires positive released professional pay."
    );
  }

  if (this.settlementSummary?.lastPlatformFeeEarnedAt && earnedPlatformFee <= 0) {
    this.invalidate(
      "settlementSummary.lastPlatformFeeEarnedAt",
      "lastPlatformFeeEarnedAt requires a positive earned platform fee."
    );
  }

  if (this.settlementSummary?.lastPlatformFeeCollectedAt && collectedPlatformFee <= 0) {
    this.invalidate(
      "settlementSummary.lastPlatformFeeCollectedAt",
      "lastPlatformFeeCollectedAt requires a positive collected platform fee."
    );
  }

  const currentTopUpRequired = Number(this.topUpRequired || 0);

  if (
    Number.isSafeInteger(this.fundedAmount) &&
    Number.isSafeInteger(this.refundedAmount) &&
    Number.isSafeInteger(currentTopUpRequired) &&
    Number.isSafeInteger(committedEmployerCharge)
  ) {
    try {
      const committedAndRefunded = money.sumMinorUnitAmounts(
        [committedEmployerCharge, this.refundedAmount],
        "Committed employer charges plus refunds"
      );

      const protectedAndOutstanding = money.sumMinorUnitAmounts(
        [this.fundedAmount, currentTopUpRequired],
        "Protected funding plus outstanding top-up"
      );

      if (committedAndRefunded > protectedAndOutstanding) {
        this.invalidate(
          "settlementSummary.committedEmployerCharge",
          "Committed employer charges and completed refunds cannot exceed funded protection plus the current outstanding top-up obligation."
        );
      }
    } catch (error) {
      this.invalidate(
        "settlementSummary.committedEmployerCharge",
        "Parent committed funding reconciliation exceeds the supported safe-integer range."
      );
    }
  }

  if (
    Number.isSafeInteger(this.fundedAmount) &&
    Number.isSafeInteger(this.refundedAmount) &&
    Number.isSafeInteger(releasedProfessionalPay) &&
    Number.isSafeInteger(collectedPlatformFee)
  ) {
    try {
      const completedOutflows = money.sumMinorUnitAmounts(
        [releasedProfessionalPay, collectedPlatformFee, this.refundedAmount],
        "Completed parent financial outflows"
      );

      if (completedOutflows > this.fundedAmount) {
        this.invalidate(
          "settlementSummary",
          "Completed professional payouts, collected platform fees and completed refunds cannot exceed cumulative protected funding."
        );
      }
    } catch (error) {
      this.invalidate(
        "settlementSummary",
        "Completed parent financial outflows exceed the supported safe-integer range."
      );
    }
  }

  /* ─────────────────────────────── ASSIGNMENT SUMMARY ─────────────────────────────── */

  const hasAssignedProfessional = hasDocumentValue(this.assignedProfessional);

  const hasActiveAssignment = hasDocumentValue(this.activeAssignment);

  const hasAssignedAt = hasDocumentValue(this.assignedAt);

  const hasAssignedBy = hasDocumentValue(this.assignedBy);

  const completeAssignmentSummary =
    hasAssignedProfessional && hasActiveAssignment && hasAssignedAt && hasAssignedBy;

  const assignmentValueCount = [
    hasAssignedProfessional,
    hasActiveAssignment,
    hasAssignedAt,
    hasAssignedBy,
  ].filter(Boolean).length;

  if (assignmentValueCount > 0 && !completeAssignmentSummary) {
    this.invalidate(
      "activeAssignment",
      "Parent assignment summary must include activeAssignment, assignedProfessional, assignedAt and assignedBy together."
    );
  }

  const replacementHiringStatus = this.replacementHiring?.status || "closed";

  const replacementGapIsOpen = replacementHiringStatus === "open" && !completeAssignmentSummary;

  if (
    SHIFT_ASSIGNMENT_SUMMARY_REQUIRED_STATUSES.includes(this.status) &&
    !completeAssignmentSummary &&
    !(this.status === "confirmed" && replacementGapIsOpen)
  ) {
    this.invalidate(
      "activeAssignment",
      `${this.status} requires a complete assignment summary unless confirmed replacement hiring is open between assignments.`
    );
  }

  if (
    ["pending_funding", "open", "completed", "cancelled"].includes(this.status) &&
    assignmentValueCount > 0
  ) {
    this.invalidate(
      "activeAssignment",
      `${this.status} cannot retain a current assignment summary.`
    );
  }

  if (this.status === "open" && replacementHiringStatus !== "closed") {
    this.invalidate(
      "replacementHiring.status",
      "Initial marketplace status open cannot be combined with replacement hiring."
    );
  }

  /* ─────────────────────────────── REPLACEMENT HIRING ─────────────────────────────── */

  const replacementHiringValues = [
    this.replacementHiring?.assignmentCase,
    this.replacementHiring?.applicationRound,
    this.replacementHiring?.replacementForAssignment,
    this.replacementHiring?.startSequenceNumber,
    this.replacementHiring?.endSequenceNumber,
    this.replacementHiring?.reasonCode,
    this.replacementHiring?.openedAt,
    this.replacementHiring?.openedBy,
  ];

  const replacementHiringHasCoreMetadata = replacementHiringValues.every(hasDocumentValue);

  if (replacementHiringStatus === "closed") {
    const closedOnlyValues = [
      ...replacementHiringValues,
      this.replacementHiring?.reasonDetails,
      this.replacementHiring?.filledAt,
      this.replacementHiring?.filledByAssignment,
      this.replacementHiring?.cancelledAt,
      this.replacementHiring?.cancelledBy,
      this.replacementHiring?.cancellationReason,
    ];

    if (
      closedOnlyValues.some(hasDocumentValue) ||
      Number(this.replacementHiring?.occurrenceCount || 0) !== 0
    ) {
      this.invalidate(
        "replacementHiring.status",
        "Closed replacement hiring cannot retain replacement recruitment metadata."
      );
    }
  }

  if (REPLACEMENT_HIRING_CONTEXT_STATUSES.includes(replacementHiringStatus)) {
    if (!replacementHiringHasCoreMetadata) {
      this.invalidate(
        "replacementHiring.assignmentCase",
        `${replacementHiringStatus} replacement hiring requires assignmentCase, applicationRound, replacementForAssignment, range, reasonCode, openedAt and openedBy.`
      );
    }

    if (
      !Number.isSafeInteger(this.replacementHiring?.applicationRound) ||
      this.replacementHiring.applicationRound < 2
    ) {
      this.invalidate(
        "replacementHiring.applicationRound",
        "Replacement hiring must retain application round 2 or greater."
      );
    }

    if (
      Number.isSafeInteger(this.replacementHiring?.applicationRound) &&
      this.replacementHiring.applicationRound !== this.applicationRound
    ) {
      this.invalidate(
        "applicationRound",
        "Parent applicationRound must match replacementHiring.applicationRound."
      );
    }

    const replacementStart = this.replacementHiring?.startSequenceNumber;

    const replacementEnd = this.replacementHiring?.endSequenceNumber;

    const replacementCount = this.replacementHiring?.occurrenceCount;

    if (
      !Number.isSafeInteger(replacementStart) ||
      !Number.isSafeInteger(replacementEnd) ||
      !Number.isSafeInteger(replacementCount) ||
      replacementCount <= 0
    ) {
      this.invalidate(
        "replacementHiring.occurrenceCount",
        "Replacement hiring must retain a complete positive occurrence range."
      );
    } else {
      if (replacementEnd < replacementStart) {
        this.invalidate(
          "replacementHiring.endSequenceNumber",
          "replacementHiring.endSequenceNumber cannot be earlier than startSequenceNumber."
        );
      }

      if (replacementCount !== replacementEnd - replacementStart + 1) {
        this.invalidate(
          "replacementHiring.occurrenceCount",
          "replacementHiring.occurrenceCount must match the replacement sequence range."
        );
      }

      if (replacementEnd > occurrenceCount) {
        this.invalidate(
          "replacementHiring.endSequenceNumber",
          "Replacement hiring cannot extend beyond occurrenceCount."
        );
      }
    }

    const replacementReasonCode = this.replacementHiring?.reasonCode;

    const replacementReasonDetails = this.replacementHiring?.reasonDetails;

    if (
      REPLACEMENT_REASON_CODES_REQUIRING_DETAILS.includes(replacementReasonCode) &&
      !replacementReasonDetails
    ) {
      this.invalidate(
        "replacementHiring.reasonDetails",
        `${replacementReasonCode} requires additional replacement details.`
      );
    }

    validateMinimumDetails(
      this,
      "replacementHiring.reasonDetails",
      replacementReasonDetails,
      "Replacement details"
    );
  }

  if (replacementHiringStatus === "open") {
    if (["pending_funding", "open", "completed", "cancelled"].includes(this.status)) {
      this.invalidate(
        "replacementHiring.status",
        `Open replacement hiring is incompatible with Shift status ${this.status}.`
      );
    }

    if (this.replacementHiring?.filledAt || this.replacementHiring?.filledByAssignment) {
      this.invalidate(
        "replacementHiring.filledAt",
        "Open replacement hiring cannot contain filled assignment details."
      );
    }

    if (
      this.replacementHiring?.cancelledAt ||
      this.replacementHiring?.cancelledBy ||
      this.replacementHiring?.cancellationReason
    ) {
      this.invalidate(
        "replacementHiring.cancelledAt",
        "Open replacement hiring cannot contain cancellation details."
      );
    }
  }

  if (replacementHiringStatus === "filled") {
    if (!this.replacementHiring?.filledAt || !this.replacementHiring?.filledByAssignment) {
      this.invalidate(
        "replacementHiring.filledAt",
        "Filled replacement hiring requires filledAt and filledByAssignment."
      );
    }

    if (
      this.replacementHiring?.openedAt &&
      this.replacementHiring?.filledAt &&
      this.replacementHiring.filledAt < this.replacementHiring.openedAt
    ) {
      this.invalidate("replacementHiring.filledAt", "filledAt cannot be earlier than openedAt.");
    }

    if (
      this.replacementHiring?.cancelledAt ||
      this.replacementHiring?.cancelledBy ||
      this.replacementHiring?.cancellationReason
    ) {
      this.invalidate(
        "replacementHiring.cancelledAt",
        "Filled replacement hiring cannot contain cancellation details."
      );
    }

    if (
      this.replacementHiring?.filledByAssignment &&
      this.replacementHiring?.replacementForAssignment &&
      String(this.replacementHiring.filledByAssignment) ===
        String(this.replacementHiring.replacementForAssignment)
    ) {
      this.invalidate(
        "replacementHiring.filledByAssignment",
        "The replacement assignment cannot be the assignment being replaced."
      );
    }
  }

  if (replacementHiringStatus === "cancelled") {
    if (
      !this.replacementHiring?.cancelledAt ||
      !this.replacementHiring?.cancelledBy ||
      !this.replacementHiring?.cancellationReason
    ) {
      this.invalidate(
        "replacementHiring.cancelledAt",
        "Cancelled replacement hiring requires cancelledAt, cancelledBy and cancellationReason."
      );
    }

    if (
      this.replacementHiring?.openedAt &&
      this.replacementHiring?.cancelledAt &&
      this.replacementHiring.cancelledAt < this.replacementHiring.openedAt
    ) {
      this.invalidate(
        "replacementHiring.cancelledAt",
        "cancelledAt cannot be earlier than openedAt."
      );
    }

    validateMinimumDetails(
      this,
      "replacementHiring.cancellationReason",
      this.replacementHiring?.cancellationReason,
      "Replacement cancellation reason"
    );

    if (this.replacementHiring?.filledAt || this.replacementHiring?.filledByAssignment) {
      this.invalidate(
        "replacementHiring.filledAt",
        "Cancelled replacement hiring cannot contain filled assignment details."
      );
    }
  }

  if (this.applicationRound === 1 && replacementHiringStatus !== "closed") {
    this.invalidate(
      "applicationRound",
      "Initial application round 1 cannot contain replacement hiring."
    );
  }

  if (this.currentRoundApplications > this.totalApplications) {
    this.invalidate(
      "currentRoundApplications",
      "currentRoundApplications cannot exceed totalApplications."
    );
  }

  /* ─────────────────────────────── OCCURRENCE PROGRESS ─────────────────────────────── */

  if (this.occurrenceProgress && Number.isSafeInteger(occurrenceCount)) {
    const assignmentProgressFields = [
      "unassigned",
      "assigned",
      "replacementRequired",
      "expiredUnfilled",
    ];

    const occurrenceStatusProgressFields = [
      "scheduled",
      "inProgress",
      "pendingSettlement",
      "completed",
      "cancelled",
      "noShow",
      "disputed",
      "expiredUnfilled",
    ];

    const settlementProgressFields = [
      "settlementNotDue",
      "pendingReview",
      "awaitingOvertimeReview",
      "awaitingTopup",
      "approvedForRelease",
      "releasePending",
      "released",
      "failed",
      "settlementDisputed",
    ];

    const refundProgressFields = [
      "refundNotEligible",
      "refundHeld",
      "refundEligible",
      "refundBatched",
      "refundProcessing",
      "refunded",
    ];

    const progressFields = [
      ...new Set([
        ...assignmentProgressFields,
        ...occurrenceStatusProgressFields,
        ...settlementProgressFields,
        ...refundProgressFields,
        "resolved",
      ]),
    ];

    const dimensionIsZero = (fieldNames) =>
      fieldNames.every((fieldName) => Number(this.occurrenceProgress[fieldName] || 0) === 0);

    if (this.isNew) {
      if (dimensionIsZero(assignmentProgressFields)) {
        this.occurrenceProgress.unassigned = occurrenceCount;
      }

      if (dimensionIsZero(occurrenceStatusProgressFields)) {
        this.occurrenceProgress.scheduled = occurrenceCount;
      }

      if (dimensionIsZero(settlementProgressFields)) {
        this.occurrenceProgress.settlementNotDue = occurrenceCount;
      }

      if (dimensionIsZero(refundProgressFields)) {
        this.occurrenceProgress.refundNotEligible = occurrenceCount;
      }
    }

    for (const fieldName of progressFields) {
      const value = Number(this.occurrenceProgress[fieldName] || 0);

      if (!Number.isSafeInteger(value) || value < 0 || value > occurrenceCount) {
        this.invalidate(
          `occurrenceProgress.${fieldName}`,
          `${fieldName} occurrence count must be between 0 and occurrenceCount.`
        );
      }
    }

    const sumProgress = (fieldNames) =>
      fieldNames.reduce(
        (total, fieldName) => total + Number(this.occurrenceProgress[fieldName] || 0),
        0
      );

    if (sumProgress(assignmentProgressFields) !== occurrenceCount) {
      this.invalidate(
        "occurrenceProgress.assigned",
        "The assignment progress dimension must cover every occurrence exactly once."
      );
    }

    if (sumProgress(occurrenceStatusProgressFields) !== occurrenceCount) {
      this.invalidate(
        "occurrenceProgress.scheduled",
        "The occurrence-status progress dimension must cover every occurrence exactly once."
      );
    }

    if (sumProgress(settlementProgressFields) !== occurrenceCount) {
      this.invalidate(
        "occurrenceProgress.settlementNotDue",
        "The settlement progress dimension must cover every occurrence exactly once."
      );
    }

    if (sumProgress(refundProgressFields) !== occurrenceCount) {
      this.invalidate(
        "occurrenceProgress.refundNotEligible",
        "The refund progress dimension must cover every occurrence exactly once."
      );
    }

    const replacementRequiredCount = Number(this.occurrenceProgress.replacementRequired || 0);

    const replacementHiringOccurrenceCount = Number(this.replacementHiring?.occurrenceCount || 0);

    if (
      replacementHiringStatus === "open" &&
      replacementRequiredCount !== replacementHiringOccurrenceCount
    ) {
      this.invalidate(
        "occurrenceProgress.replacementRequired",
        "Open replacement hiring must match the number of occurrences marked replacement_required."
      );
    }

    if (replacementHiringStatus === "filled" && replacementRequiredCount !== 0) {
      this.invalidate(
        "occurrenceProgress.replacementRequired",
        "Filled replacement hiring requires every advertised occurrence to be assigned."
      );
    }

    if (
      replacementRequiredCount > 0 &&
      this.status !== "cancelled" &&
      replacementHiringStatus !== "open"
    ) {
      this.invalidate(
        "replacementHiring.status",
        "Active replacement-required occurrences require replacementHiring.status to be open."
      );
    }

    if (this.status === "cancelled" && replacementRequiredCount > 0) {
      if (replacementHiringStatus !== "cancelled") {
        this.invalidate(
          "replacementHiring.status",
          "A cancelled engagement with preserved replacement-required occurrences must retain cancelled replacement hiring context."
        );
      }

      if (replacementRequiredCount !== replacementHiringOccurrenceCount) {
        this.invalidate(
          "occurrenceProgress.replacementRequired",
          "Preserved replacement-required occurrences must match the cancelled replacement hiring range."
        );
      }
    }

    const terminalOccurrenceCount =
      Number(this.occurrenceProgress.completed || 0) +
      Number(this.occurrenceProgress.cancelled || 0) +
      Number(this.occurrenceProgress.noShow || 0) +
      Number(this.occurrenceProgress.expiredUnfilled || 0);

    if (Number(this.occurrenceProgress.resolved || 0) > terminalOccurrenceCount) {
      this.invalidate(
        "occurrenceProgress.resolved",
        "resolved cannot exceed the number of terminal occurrence outcomes."
      );
    }

    if (
      this.status === "completed" &&
      Number(this.occurrenceProgress.resolved || 0) !== occurrenceCount
    ) {
      this.invalidate(
        "occurrenceProgress.resolved",
        "A completed engagement must have every occurrence operationally and financially resolved."
      );
    }
  }

  /* ─────────────────────────────── PUBLICATION AND PAYMENT ─────────────────────────────── */

  const statusRequiresPublication = [
    "open",
    "assigned",
    "confirmed",
    "in_progress",
    "pending_settlement",
    "completed",
    "disputed",
    "no_show",
  ].includes(this.status);

  const hasPublicationAudit = hasDocumentValue(this.publishedAt);

  if (statusRequiresPublication && !hasPublicationAudit) {
    this.invalidate(
      "publishedAt",
      `${this.status} requires the engagement to have been published.`
    );
  }

  if (hasPublicationAudit) {
    if (!SHIFT_PUBLISHED_PAYMENT_STATUSES.includes(this.paymentStatus)) {
      this.invalidate(
        "paymentStatus",
        "A published engagement must have protected funding or a later settlement state."
      );
    }

    if (
      !Number.isSafeInteger(this.fundedAmount) ||
      !Number.isSafeInteger(this.estimatedEmployerCharge) ||
      this.fundedAmount < this.estimatedEmployerCharge
    ) {
      this.invalidate(
        "fundedAmount",
        "A published engagement must have cumulative protected funding of at least the estimated employer charge."
      );
    }

    if (!this.fundingMethod) {
      this.invalidate("fundingMethod", "fundingMethod is required for a published engagement.");
    }

    if (!this.fundedAt) {
      this.invalidate("fundedAt", "fundedAt is required for a published engagement.");
    }

    if (!this.fundingTransaction) {
      this.invalidate(
        "fundingTransaction",
        "A published engagement must reference its completed protected-funding transaction."
      );
    }

    if (this.fundingInitiatedAt && this.fundedAt && this.fundedAt < this.fundingInitiatedAt) {
      this.invalidate("fundedAt", "fundedAt cannot be earlier than fundingInitiatedAt.");
    }

    if (this.fundedAt && this.publishedAt && this.publishedAt < this.fundedAt) {
      this.invalidate("publishedAt", "publishedAt cannot be earlier than fundedAt.");
    }
  }

  if (this.status === "pending_funding") {
    if (this.publishedAt) {
      this.invalidate("publishedAt", "A pending-funding engagement cannot already be published.");
    }

    if (this.paymentStatus !== "unpaid") {
      this.invalidate(
        "paymentStatus",
        "A pending-funding engagement must have unpaid payment status."
      );
    }

    if (Number(this.fundedAmount || 0) !== 0) {
      this.invalidate(
        "fundedAmount",
        "A pending-funding engagement cannot contain protected funding."
      );
    }
  }

  if (this.status === "open") {
    if (
      !SHIFT_PUBLISHED_PAYMENT_STATUSES.includes(this.paymentStatus) ||
      ["released", "refunded"].includes(this.paymentStatus)
    ) {
      this.invalidate(
        "paymentStatus",
        "An open engagement must retain a non-final published payment state while future occurrences remain available."
      );
    }

    if (assignmentValueCount > 0) {
      this.invalidate(
        "activeAssignment",
        "An ordinary open engagement cannot retain an assignment summary."
      );
    }

    if (
      Number(occurrenceProgress.unassigned || 0) <= 0 ||
      Number(occurrenceProgress.scheduled || 0) <= 0
    ) {
      this.invalidate(
        "occurrenceProgress.unassigned",
        "An open engagement requires at least one unassigned scheduled occurrence."
      );
    }

    if (Number(occurrenceProgress.replacementRequired || 0) > 0) {
      this.invalidate(
        "occurrenceProgress.replacementRequired",
        "Initial marketplace status open cannot contain replacement-required occurrences."
      );
    }
  }

  if (
    ACTIVE_REPLACEMENT_HIRING_STATUSES.includes(replacementHiringStatus) &&
    ["released", "refunded"].includes(this.paymentStatus)
  ) {
    this.invalidate(
      "paymentStatus",
      "Open replacement hiring cannot remain on a fully released or fully refunded engagement."
    );
  }

  if (this.paymentStatus === "funded") {
    if (
      releasedProfessionalPay !== 0 ||
      Number(this.refundedAmount || 0) !== 0 ||
      Number(this.topUpRequired || 0) !== 0
    ) {
      this.invalidate(
        "paymentStatus",
        "funded cannot retain professional payouts, refunds or an outstanding top-up."
      );
    }
  }

  if (this.paymentStatus === "awaiting_overtime_review") {
    if (Number(occurrenceProgress.awaitingOvertimeReview || 0) <= 0) {
      this.invalidate(
        "occurrenceProgress.awaitingOvertimeReview",
        "awaiting_overtime_review requires at least one occurrence awaiting overtime review."
      );
    }
  }

  if (this.paymentStatus === "awaiting_topup") {
    if (Number(this.topUpRequired || 0) <= 0) {
      this.invalidate(
        "topUpRequired",
        "awaiting_topup requires a positive outstanding top-up amount."
      );
    }

    if (Number(occurrenceProgress.awaitingTopup || 0) <= 0) {
      this.invalidate(
        "occurrenceProgress.awaitingTopup",
        "awaiting_topup requires at least one occurrence awaiting top-up."
      );
    }
  } else if (Number(this.topUpRequired || 0) > 0) {
    this.invalidate(
      "paymentStatus",
      "A positive topUpRequired requires paymentStatus awaiting_topup."
    );
  }

  if (this.paymentStatus === "release_pending") {
    if (
      Number(occurrenceProgress.releasePending || 0) <= 0 &&
      Number(occurrenceProgress.approvedForRelease || 0) <= 0
    ) {
      this.invalidate(
        "occurrenceProgress.releasePending",
        "release_pending requires at least one occurrence approved for professional release or already in payout processing."
      );
    }
  }

  if (this.paymentStatus === "partially_released") {
    if (
      releasedProfessionalPay <= 0 ||
      Number(occurrenceProgress.resolved || 0) >= occurrenceCount
    ) {
      this.invalidate(
        "settlementSummary.releasedProfessionalPay",
        "partially_released requires completed professional payout value and at least one unresolved occurrence workflow."
      );
    }
  }

  if (this.paymentStatus === "released") {
    if (
      approvedProfessionalPay <= 0 ||
      releasedProfessionalPay !== approvedProfessionalPay ||
      Number(this.refundedAmount || 0) !== 0
    ) {
      this.invalidate(
        "settlementSummary.releasedProfessionalPay",
        "released requires all approved professional pay to be paid and no employer refund."
      );
    }

    if (Number(occurrenceProgress.resolved || 0) !== occurrenceCount) {
      this.invalidate(
        "occurrenceProgress.resolved",
        "released requires every occurrence workflow to be resolved."
      );
    }
  }

  if (["refunded", "partially_refunded"].includes(this.paymentStatus)) {
    if (Number(this.refundedAmount || 0) <= 0) {
      this.invalidate(
        "refundedAmount",
        `${this.paymentStatus} requires a positive refunded amount.`
      );
    }
  }

  if (this.paymentStatus === "refunded") {
    if (
      releasedProfessionalPay !== 0 ||
      Number(this.refundedAmount || 0) !== Number(this.fundedAmount || 0)
    ) {
      this.invalidate(
        "paymentStatus",
        "refunded requires zero professional payout and a full refund of cumulative protected funding."
      );
    }
  }

  if (this.paymentStatus === "partially_refunded") {
    if (Number(this.refundedAmount || 0) >= Number(this.fundedAmount || 0)) {
      this.invalidate(
        "refundedAmount",
        "partially_refunded requires refundedAmount to remain below fundedAmount."
      );
    }
  }

  if (this.status === "completed") {
    if (!SHIFT_FINAL_PAYMENT_STATUSES.includes(this.paymentStatus)) {
      this.invalidate(
        "paymentStatus",
        "A completed engagement must have a final released or refunded payment status."
      );
    }

    if (replacementHiringStatus === "open") {
      this.invalidate(
        "replacementHiring.status",
        "A completed engagement cannot retain open replacement hiring."
      );
    }

    if (Number(this.topUpRequired || 0) !== 0) {
      this.invalidate(
        "topUpRequired",
        "A completed engagement cannot retain an outstanding top-up."
      );
    }

    if (releasedProfessionalPay !== approvedProfessionalPay) {
      this.invalidate(
        "settlementSummary.releasedProfessionalPay",
        "A completed engagement must have paid all approved professional pay."
      );
    }

    if (
      Number.isSafeInteger(this.fundedAmount) &&
      Number.isSafeInteger(this.refundedAmount) &&
      Number.isSafeInteger(committedEmployerCharge)
    ) {
      try {
        const reconciledFunding = money.sumMinorUnitAmounts(
          [committedEmployerCharge, this.refundedAmount],
          "Completed engagement funding reconciliation"
        );

        if (reconciledFunding !== this.fundedAmount) {
          this.invalidate(
            "settlementSummary.committedEmployerCharge",
            "A completed engagement must reconcile all funded protection into committed employer charges and completed refunds."
          );
        }
      } catch (error) {
        this.invalidate(
          "settlementSummary.committedEmployerCharge",
          "Completed engagement funding reconciliation exceeds the supported safe-integer range."
        );
      }
    }

    const unresolvedOccurrenceCount =
      Number(occurrenceProgress.scheduled || 0) +
      Number(occurrenceProgress.inProgress || 0) +
      Number(occurrenceProgress.pendingSettlement || 0) +
      Number(occurrenceProgress.disputed || 0);

    if (unresolvedOccurrenceCount !== 0) {
      this.invalidate(
        "occurrenceProgress.resolved",
        "A completed engagement cannot retain scheduled, in-progress, pending-settlement or disputed occurrences."
      );
    }

    const unresolvedSettlementCount =
      Number(occurrenceProgress.pendingReview || 0) +
      Number(occurrenceProgress.awaitingOvertimeReview || 0) +
      Number(occurrenceProgress.awaitingTopup || 0) +
      Number(occurrenceProgress.approvedForRelease || 0) +
      Number(occurrenceProgress.releasePending || 0) +
      Number(occurrenceProgress.failed || 0) +
      Number(occurrenceProgress.settlementDisputed || 0);

    if (unresolvedSettlementCount !== 0) {
      this.invalidate(
        "occurrenceProgress.settlementNotDue",
        "A completed engagement cannot retain unresolved settlement states."
      );
    }

    const unresolvedRefundCount =
      Number(occurrenceProgress.refundHeld || 0) +
      Number(occurrenceProgress.refundEligible || 0) +
      Number(occurrenceProgress.refundBatched || 0) +
      Number(occurrenceProgress.refundProcessing || 0);

    if (unresolvedRefundCount !== 0) {
      this.invalidate(
        "occurrenceProgress.refundEligible",
        "A completed engagement cannot retain held, eligible, batched or processing occurrence refunds."
      );
    }

    if (
      Number(occurrenceProgress.expiredUnfilled || 0) > Number(occurrenceProgress.refunded || 0)
    ) {
      this.invalidate(
        "occurrenceProgress.refunded",
        "Every expired-unfilled occurrence must complete its refund before the engagement can be completed."
      );
    }

    if (scheduleMode === "single") {
      const singleCompletedWork = Number(occurrenceProgress.completed || 0) === 1;

      const singleExpiredUnfilled = Number(occurrenceProgress.expiredUnfilled || 0) === 1;

      if (singleCompletedWork && this.attendanceStatus !== "settled") {
        this.invalidate(
          "attendanceStatus",
          "A completed worked single Shift must have settled parent attendance compatibility status."
        );
      }

      if (singleExpiredUnfilled && this.attendanceStatus !== "not_started") {
        this.invalidate(
          "attendanceStatus",
          "A completed expired-unfilled single Shift must retain not_started parent attendance compatibility status."
        );
      }

      if (!singleCompletedWork && !singleExpiredUnfilled) {
        this.invalidate(
          "occurrenceProgress.completed",
          "A completed single Shift must resolve through completed work or expired-unfilled finalisation."
        );
      }
    }
  }

  /* ─────────────────────────────── CANCELLATION CONSISTENCY ─────────────────────────────── */

  /**
   * Parent cancellation validation is intentionally operational only.
   *
   * ShiftOccurrence owns:
   *
   * - cancellation compensation professional pay;
   * - active-work cancellation professional pay;
   * - BASE platform-fee outcome;
   * - employer refund obligation and execution.
   *
   * The parent Shift must not recalculate or store those amounts.
   */
  const cancellationAuditValues = [
    this.cancelledFromStatus,
    this.cancellationCode,
    this.cancelledBy,
    this.cancelledByUser,
    this.cancellationReasonCode,
    this.cancellationReason,
    this.cancelledAt,
  ];

  const hasCancellationAudit = cancellationAuditValues.some(hasDocumentValue);

  const cancellationSummary = this.cancellationSummary || {};

  const cancellationSummaryHasData =
    hasDocumentValue(cancellationSummary.firstAffectedOccurrence) ||
    hasDocumentValue(cancellationSummary.firstAffectedSequenceNumber) ||
    Number(cancellationSummary.cancelledOccurrenceCount || 0) > 0 ||
    cancellationSummary.compensationApplicable === true;

  if (this.status === "cancelled") {
    if (!this.cancelledFromStatus) {
      this.invalidate(
        "cancelledFromStatus",
        "A cancelled engagement must record the status it was cancelled from."
      );
    }

    if (!this.cancellationCode) {
      this.invalidate(
        "cancellationCode",
        "A cancelled engagement requires a machine-readable cancellationCode."
      );
    }

    if (!this.cancelledAt || !this.cancelledBy) {
      this.invalidate(
        "cancelledAt",
        "A cancelled engagement requires cancelledAt and cancelledBy."
      );
    }

    if (this.cancelledBy === "employer") {
      if (!this.cancellationReasonCode) {
        this.invalidate(
          "cancellationReasonCode",
          "Employer cancellation requires a structured cancellation reason."
        );
      }

      if (
        CANCELLATION_REASON_CODES_REQUIRING_DETAILS.includes(this.cancellationReasonCode) &&
        !this.cancellationReason
      ) {
        this.invalidate(
          "cancellationReason",
          `${this.cancellationReasonCode} requires additional cancellation details.`
        );
      }
    } else {
      if (this.cancellationReasonCode) {
        this.invalidate(
          "cancellationReasonCode",
          "Only an employer cancellation may contain an employer cancellation reason code."
        );
      }

      if (!this.cancellationReason) {
        this.invalidate(
          "cancellationReason",
          "System and admin cancellations require an audit reason."
        );
      }
    }

    if (this.cancellationReason && this.cancellationReason.length < 10) {
      this.invalidate(
        "cancellationReason",
        "Cancellation details must contain at least 10 characters when provided."
      );
    }

    if (USER_CANCELLATION_ACTORS.includes(this.cancelledBy) && !this.cancelledByUser) {
      this.invalidate(
        "cancelledByUser",
        `${this.cancelledBy} cancellation requires cancelledByUser.`
      );
    }

    if (this.cancelledBy === "system" && this.cancelledByUser) {
      this.invalidate("cancelledByUser", "A system cancellation cannot contain cancelledByUser.");
    }

    const requiredCancellationActor = CANCELLATION_CODE_ACTORS[this.cancellationCode];

    if (requiredCancellationActor && this.cancelledBy !== requiredCancellationActor) {
      this.invalidate(
        "cancelledBy",
        `${this.cancellationCode} requires cancelledBy to be ${requiredCancellationActor}.`
      );
    }

    if (this.cancelledFromStatus === "pending_funding") {
      if (this.paymentStatus !== "unpaid") {
        this.invalidate(
          "paymentStatus",
          "An engagement cancelled from pending_funding must remain unpaid."
        );
      }

      if (this.publishedAt) {
        this.invalidate(
          "publishedAt",
          "An engagement cancelled from pending_funding cannot have been published."
        );
      }

      if (Number(this.fundedAmount || 0) !== 0) {
        this.invalidate(
          "fundedAmount",
          "An engagement cancelled from pending_funding cannot contain protected funding."
        );
      }
    }

    if (["open", "assigned", "confirmed", "in_progress"].includes(this.cancelledFromStatus)) {
      if (!this.publishedAt) {
        this.invalidate(
          "publishedAt",
          `An engagement cancelled from ${this.cancelledFromStatus} must retain its publication audit.`
        );
      }
    }

    if (this.cancellationCode === "funding_deadline_passed") {
      if (this.cancelledFromStatus !== "pending_funding") {
        this.invalidate(
          "cancelledFromStatus",
          "funding_deadline_passed can only cancel an engagement from pending_funding."
        );
      }

      if (this.startTime && this.cancelledAt && this.cancelledAt < this.startTime) {
        this.invalidate(
          "cancelledAt",
          "A funding-deadline expiration cannot be recorded before the Shift start time."
        );
      }

      if (cancellationSummary.compensationApplicable) {
        this.invalidate(
          "cancellationSummary.compensationApplicable",
          "An unfunded expiration cannot create professional cancellation compensation."
        );
      }
    }

    if (replacementHiringStatus === "open") {
      this.invalidate(
        "replacementHiring.status",
        "A cancelled engagement cannot retain open replacement hiring."
      );
    }

    if (this.cancelledFromStatus === "in_progress" && !this.activeWorkCancellation?.occurred) {
      this.invalidate(
        "activeWorkCancellation.occurred",
        "Cancelling an in-progress engagement requires the active occurrence to be ended early and identified."
      );
    }

    if (this.activeWorkCancellation?.occurred && this.cancelledFromStatus !== "in_progress") {
      this.invalidate(
        "cancelledFromStatus",
        "Parent active-work cancellation requires cancellation from in_progress status."
      );
    }

    if (Number(cancellationSummary.cancelledOccurrenceCount || 0) > occurrenceCount) {
      this.invalidate(
        "cancellationSummary.cancelledOccurrenceCount",
        "cancelledOccurrenceCount cannot exceed occurrenceCount."
      );
    }

    if (this.activeWorkCancellation?.occurred) {
      const cancelledOccurrenceCount = Number(cancellationSummary.cancelledOccurrenceCount || 0);

      if (scheduleMode === "single" && cancelledOccurrenceCount !== 0) {
        this.invalidate(
          "cancellationSummary.cancelledOccurrenceCount",
          "An in-progress single Shift is ended early, not counted as a cancelled occurrence."
        );
      }

      if (
        scheduleMode === "multiple" &&
        cancelledOccurrenceCount > Math.max(occurrenceCount - 1, 0)
      ) {
        this.invalidate(
          "cancellationSummary.cancelledOccurrenceCount",
          "The active occurrence ended during work cannot be included in cancelledOccurrenceCount."
        );
      }
    }

    if (cancellationSummaryHasData) {
      if (!cancellationSummary.firstAffectedOccurrence) {
        this.invalidate(
          "cancellationSummary.firstAffectedOccurrence",
          "A cancellation summary must identify the first affected ShiftOccurrence."
        );
      }

      if (!Number.isSafeInteger(cancellationSummary.firstAffectedSequenceNumber)) {
        this.invalidate(
          "cancellationSummary.firstAffectedSequenceNumber",
          "A cancellation summary must identify the first affected sequence number."
        );
      } else {
        if (cancellationSummary.firstAffectedSequenceNumber > occurrenceCount) {
          this.invalidate(
            "cancellationSummary.firstAffectedSequenceNumber",
            "The first affected sequence number cannot exceed occurrenceCount."
          );
        }

        if (scheduleMode === "single" && cancellationSummary.firstAffectedSequenceNumber !== 1) {
          this.invalidate(
            "cancellationSummary.firstAffectedSequenceNumber",
            "A single Shift must use first affected sequence number 1."
          );
        }
      }
    }

    if (cancellationSummary.compensationApplicable) {
      if (this.activeWorkCancellation?.occurred) {
        this.invalidate(
          "cancellationSummary.compensationApplicable",
          "An active occurrence ended early cannot also receive late-cancellation compensation for the same parent cancellation."
        );
      }

      if (this.cancellationCode !== "late_employer_cancellation") {
        this.invalidate(
          "cancellationCode",
          "Occurrence-level professional cancellation compensation requires late_employer_cancellation."
        );
      }

      if (this.cancelledBy !== "employer") {
        this.invalidate(
          "cancelledBy",
          "Late-cancellation professional compensation requires employer cancellation."
        );
      }

      if (!["assigned", "confirmed"].includes(this.cancelledFromStatus)) {
        this.invalidate(
          "cancelledFromStatus",
          "Late-cancellation compensation requires cancellation from assigned or confirmed status."
        );
      }
    } else if (this.cancellationCode === "late_employer_cancellation") {
      this.invalidate(
        "cancellationSummary.compensationApplicable",
        "late_employer_cancellation requires occurrence-level professional compensation."
      );
    }
  } else {
    if (hasCancellationAudit) {
      this.invalidate(
        "cancelledAt",
        "Cancellation audit details may only be recorded when status is cancelled."
      );
    }

    if (cancellationSummaryHasData) {
      this.invalidate(
        "cancellationSummary",
        "Cancellation summary details may only be recorded when status is cancelled."
      );
    }
  }

  /* ─────────────────────────────── ACTIVE-WORK CANCELLATION CONSISTENCY ─────────────────────────────── */

  const activeWorkCancellation = this.activeWorkCancellation || {};

  const activeWorkCancellationHasData =
    activeWorkCancellation.occurred === true ||
    hasDocumentValue(activeWorkCancellation.affectedOccurrence) ||
    hasDocumentValue(activeWorkCancellation.affectedSequenceNumber) ||
    hasDocumentValue(activeWorkCancellation.effectiveAt);

  if (activeWorkCancellation.occurred) {
    if (this.status !== "cancelled") {
      this.invalidate(
        "status",
        "Parent active-work cancellation is only recorded when an in-progress engagement is cancelled."
      );
    }

    if (this.cancelledFromStatus !== "in_progress") {
      this.invalidate(
        "cancelledFromStatus",
        "Parent active-work cancellation requires cancellation from in_progress status."
      );
    }

    if (cancellationSummary.compensationApplicable) {
      this.invalidate(
        "cancellationSummary.compensationApplicable",
        "Parent active-work cancellation and late-cancellation compensation cannot apply to the same cancellation action."
      );
    }

    if (
      !activeWorkCancellation.affectedOccurrence ||
      !Number.isSafeInteger(activeWorkCancellation.affectedSequenceNumber) ||
      !activeWorkCancellation.effectiveAt
    ) {
      this.invalidate(
        "activeWorkCancellation.affectedOccurrence",
        "Active-work cancellation must identify the authoritative affected ShiftOccurrence, sequence number and effective time."
      );
    } else {
      if (activeWorkCancellation.affectedSequenceNumber > occurrenceCount) {
        this.invalidate(
          "activeWorkCancellation.affectedSequenceNumber",
          "The affected sequence number cannot exceed occurrenceCount."
        );
      }

      if (scheduleMode === "single" && activeWorkCancellation.affectedSequenceNumber !== 1) {
        this.invalidate(
          "activeWorkCancellation.affectedSequenceNumber",
          "A single Shift must use affected sequence number 1."
        );
      }
    }

    if (
      activeWorkCancellation.effectiveAt &&
      this.cancelledAt &&
      activeWorkCancellation.effectiveAt < this.cancelledAt
    ) {
      this.invalidate(
        "activeWorkCancellation.effectiveAt",
        "Active-work cancellation effectiveAt cannot be earlier than the parent cancellation time."
      );
    }

    if (
      cancellationSummary.firstAffectedOccurrence &&
      activeWorkCancellation.affectedOccurrence &&
      String(cancellationSummary.firstAffectedOccurrence) !==
        String(activeWorkCancellation.affectedOccurrence)
    ) {
      this.invalidate(
        "cancellationSummary.firstAffectedOccurrence",
        "The parent cancellation and active-work cancellation summaries must identify the same active occurrence."
      );
    }

    if (
      Number.isSafeInteger(cancellationSummary.firstAffectedSequenceNumber) &&
      Number.isSafeInteger(activeWorkCancellation.affectedSequenceNumber) &&
      Number(cancellationSummary.firstAffectedSequenceNumber) !==
        Number(activeWorkCancellation.affectedSequenceNumber)
    ) {
      this.invalidate(
        "cancellationSummary.firstAffectedSequenceNumber",
        "The parent cancellation and active-work cancellation summaries must identify the same active sequence number."
      );
    }

    if (scheduleMode === "single") {
      if (!this.checkedInAt || !this.checkedOutAt) {
        this.invalidate(
          "checkedOutAt",
          "A single Shift ended during active work requires checkedInAt and checkedOutAt compatibility summaries."
        );
      }

      if (
        this.checkedOutAt &&
        activeWorkCancellation.effectiveAt &&
        this.checkedOutAt.getTime() === activeWorkCancellation.effectiveAt.getTime()
      ) {
        // Matching compatibility summary.
      } else if (this.checkedOutAt && activeWorkCancellation.effectiveAt) {
        this.invalidate(
          "checkedOutAt",
          "Single-Shift checkedOutAt must match activeWorkCancellation.effectiveAt."
        );
      }

      if (!["checked_out", "settled", "disputed"].includes(this.attendanceStatus)) {
        this.invalidate(
          "attendanceStatus",
          "A single Shift ended during active work must have checked-out, settled or disputed attendance compatibility status."
        );
      }
    }
  } else if (activeWorkCancellationHasData) {
    this.invalidate(
      "activeWorkCancellation.occurred",
      "Active-work cancellation details require activeWorkCancellation.occurred to be true."
    );
  }

  /* ─────────────────────────────── SINGLE-SHIFT ATTENDANCE COMPATIBILITY ─────────────────────────────── */

  if (scheduleMode === "single") {
    if (this.status === "in_progress") {
      if (this.attendanceStatus !== "checked_in" || !this.checkedInAt) {
        this.invalidate(
          "attendanceStatus",
          "A single in-progress Shift requires checked-in parent attendance compatibility fields."
        );
      }
    }

    if (this.attendanceStatus === "checked_in" && this.status !== "in_progress") {
      this.invalidate(
        "status",
        "Single-Shift checked_in compatibility status requires in_progress Shift status."
      );
    }

    if (["checked_out", "settled"].includes(this.attendanceStatus)) {
      if (!this.checkedInAt || !this.checkedOutAt) {
        this.invalidate(
          "checkedOutAt",
          `${this.attendanceStatus} parent attendance compatibility requires checkedInAt and checkedOutAt.`
        );
      }
    }

    if (this.checkedOutAt && !this.checkedInAt) {
      this.invalidate(
        "checkedInAt",
        "checkedInAt is required before parent checkedOutAt can be recorded."
      );
    }

    if (this.checkedInAt && this.checkedOutAt && this.checkedOutAt <= this.checkedInAt) {
      this.invalidate("checkedOutAt", "Parent checkedOutAt must be later than checkedInAt.");
    }

    if (this.checkInPinUsedAt && !this.checkedInAt) {
      this.invalidate("checkInPinUsedAt", "checkInPinUsedAt requires checkedInAt.");
    }

    if (this.checkOutPinUsedAt && !this.checkedOutAt) {
      this.invalidate("checkOutPinUsedAt", "checkOutPinUsedAt requires checkedOutAt.");
    }

    if (
      this.attendancePinsGeneratedAt &&
      this.checkInPinUsedAt &&
      this.checkInPinUsedAt < this.attendancePinsGeneratedAt
    ) {
      this.invalidate(
        "checkInPinUsedAt",
        "checkInPinUsedAt cannot be earlier than attendancePinsGeneratedAt."
      );
    }

    if (
      this.attendancePinsGeneratedAt &&
      this.checkOutPinUsedAt &&
      this.checkOutPinUsedAt < this.attendancePinsGeneratedAt
    ) {
      this.invalidate(
        "checkOutPinUsedAt",
        "checkOutPinUsedAt cannot be earlier than attendancePinsGeneratedAt."
      );
    }

    if (this.status === "cancelled" && !activeWorkCancellation.occurred) {
      if (
        this.attendanceStatus !== "not_started" ||
        this.checkedInAt ||
        this.checkedOutAt ||
        this.checkInPinUsedAt ||
        this.checkOutPinUsedAt
      ) {
        this.invalidate(
          "attendanceStatus",
          "A single Shift cancelled before work starts must retain not_started attendance compatibility fields."
        );
      }
    }

    if (this.status === "no_show" && this.attendanceStatus !== "no_show") {
      this.invalidate(
        "attendanceStatus",
        "A single no-show Shift must have no_show attendance status."
      );
    }

    if (this.attendanceStatus === "no_show" && this.status !== "no_show") {
      this.invalidate("status", "A single Shift with no_show attendance must have no_show status.");
    }

    if (
      this.status === "no_show" &&
      (this.checkedInAt || this.checkedOutAt || this.checkInPinUsedAt || this.checkOutPinUsedAt)
    ) {
      this.invalidate(
        "attendanceStatus",
        "A single no-show Shift cannot contain attendance timestamps or used PINs."
      );
    }
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

shiftSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

shiftSchema.index({
  status: 1,
});

shiftSchema.index({
  scheduleMode: 1,
  status: 1,
});

shiftSchema.index({
  firstOccurrenceDate: 1,
});

shiftSchema.index({
  lastOccurrenceDate: 1,
});

shiftSchema.index({
  attendanceStatus: 1,
});

shiftSchema.index({
  paymentStatus: 1,
  status: 1,
});

shiftSchema.index({
  countryCode: 1,
  currency: 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.replacementRequired": 1,
  status: 1,
});

shiftSchema.index({
  "occurrenceProgress.expiredUnfilled": 1,
  status: 1,
});

shiftSchema.index({
  "occurrenceProgress.approvedForRelease": 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.awaitingTopup": 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.refundHeld": 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.refundEligible": 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.refundBatched": 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.refundProcessing": 1,
  paymentStatus: 1,
});

shiftSchema.index({
  "occurrenceProgress.settlementDisputed": 1,
  status: 1,
});

shiftSchema.index({
  business: 1,
});

shiftSchema.index({
  business: 1,
  status: 1,
  startTime: -1,
});

shiftSchema.index({
  business: 1,
  scheduleMode: 1,
  status: 1,
  startTime: -1,
});

shiftSchema.index({
  business: 1,
  startTime: -1,
});

shiftSchema.index({
  branch: 1,
});

shiftSchema.index({
  postedBy: 1,
});

shiftSchema.index({
  activeAssignment: 1,
});

shiftSchema.index({
  assignedProfessional: 1,
});

shiftSchema.index({
  applicationRound: 1,
  status: 1,
});

shiftSchema.index({
  "replacementHiring.status": 1,
  professionalType: 1,
  startTime: 1,
});

shiftSchema.index({
  "replacementHiring.assignmentCase": 1,
});

shiftSchema.index({
  "replacementHiring.replacementForAssignment": 1,
});

shiftSchema.index({
  "replacementHiring.filledByAssignment": 1,
});

shiftSchema.index({
  "replacementHiring.applicationRound": 1,
  "replacementHiring.status": 1,
});

shiftSchema.index({
  professionalType: 1,
});

shiftSchema.index({
  startTime: 1,
});

shiftSchema.index({
  endTime: 1,
});

shiftSchema.index({
  assignedProfessional: 1,
  startTime: 1,
  endTime: 1,
});

shiftSchema.index({
  "checkInLocation.withinGeofence": 1,
});

shiftSchema.index({
  "checkOutLocation.withinGeofence": 1,
});

shiftSchema.index({
  "lateCheckout.occurred": 1,
});

shiftSchema.index({
  "checkoutFallback.required": 1,
});

shiftSchema.index({
  "missedCheckInRequest.outcome": 1,
});

shiftSchema.index({
  "attendanceOverride.used": 1,
});

shiftSchema.index({
  fundingTransaction: 1,
});

shiftSchema.index({
  cancellationReasonCode: 1,
  cancelledAt: -1,
});

shiftSchema.index({
  "replacementHiring.reasonCode": 1,
  "replacementHiring.status": 1,
});

shiftSchema.index({
  "cancellationSummary.compensationApplicable": 1,
  status: 1,
  cancelledAt: -1,
});

shiftSchema.index({
  "activeWorkCancellation.occurred": 1,
  status: 1,
  startTime: 1,
});

shiftSchema.index({
  status: 1,
  paymentStatus: 1,
  startTime: 1,
});

shiftSchema.index({
  business: 1,
  status: 1,
  cancelledAt: -1,
});

shiftSchema.index({
  cancellationCode: 1,
  cancelledAt: -1,
});

shiftSchema.index({
  cancelledByUser: 1,
  cancelledAt: -1,
});

module.exports = mongoose.model("Shift", shiftSchema);
