// models/Shift.js

const mongoose = require("mongoose");

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
  validateMinimumDetails,
} = require("./helpers/shiftSchemaHelpers");

const {
  MAX_SHIFT_OCCURRENCES,
  MINUTES_PER_DAY,
  FINANCIAL_RATE_SCALE,
  PROFESSIONAL_TYPE_OPTIONS,
} = require("../constants/shiftPosting");

const { MAX_APPLICATION_ROUNDS } = require("../constants/shiftApplication");

const {
  SHIFT_STATUSES,
  SHIFT_PAYMENT_STATUSES,
  SHIFT_PUBLISHED_PAYMENT_STATUSES,
  SHIFT_FINAL_PAYMENT_STATUSES,
  SHIFT_CANCELLABLE_FROM_STATUSES,
  CANCELLATION_ACTORS,
  USER_CANCELLATION_ACTORS,
  SHIFT_CANCELLATION_CODES,
  CANCELLATION_CODE_ACTORS,
  EMPLOYER_CANCELLATION_REASON_CODES,
  CANCELLATION_REASON_CODES_REQUIRING_DETAILS,
  BASE_PLATFORM_FEE_BENEFIT_SOURCES,
} = require("../constants/shiftLifecycle");

const money = require("../utils/money");

/**
 * Shift is the shared marketplace post, schedule and protected-funding unit.
 *
 * occurrenceCount counts scheduled dates for one position (maximum 30).
 * requiredProfessionals counts positions with that same schedule and rate.
 * totalOccurrenceCount counts all position/date records, including unfilled ones.
 *
 * Positions are numbered 1 through requiredProfessionals. Assignment and
 * occurrence services must use the same stable slotNumber within this Shift.
 * Replacements retain the position identity and cover their own sequence range.
 * They do not increase requiredProfessionals or create additional funded capacity.
 *
 * ShiftAssignment owns each professional's assignment. ShiftOccurrence owns
 * attendance, PINs, overtime, claims/disputes, payout and refund authority.
 * No individual professional's attendance or assignment is mirrored here.
 *
 * Parent summaries are derived by domain services and reconciliation. They do
 * not authorize acceptance, replacement, adjudication or movement of money.
 * Acceptance must enforce capacity transactionally against the actual records.
 *
 * Employer funding covers all positions before publication. Professional payout
 * and platform-fee accounting remain separate. No professional commission is
 * deducted. Refund execution follows the original funding source.
 */

const ASSIGNMENT_PROGRESS_FIELDS = [
  "unassigned",
  "assigned",
  "replacementRequired",
  "expiredUnfilled",
];

const STATUS_PROGRESS_FIELDS = [
  "scheduled",
  "inProgress",
  "pendingSettlement",
  "completed",
  "cancelled",
  "noShow",
  "disputed",
  "expiredUnfilled",
];

const SETTLEMENT_PROGRESS_FIELDS = [
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

const REFUND_PROGRESS_FIELDS = [
  "refundNotEligible",
  "refundHeld",
  "refundEligible",
  "refundBatched",
  "refundProcessing",
  "refunded",
];

const PROGRESS_FIELDS = [
  ...new Set([
    ...ASSIGNMENT_PROGRESS_FIELDS,
    ...STATUS_PROGRESS_FIELDS,
    ...SETTLEMENT_PROGRESS_FIELDS,
    ...REFUND_PROGRESS_FIELDS,
    "resolved",
  ]),
];

/* ─────────────────────────────── FIELD HELPERS ─────────────────────────────── */

function nullableDateField() {
  return {
    type: Date,
    default: null,
  };
}

function referenceField(ref, required = false) {
  return required
    ? {
        type: mongoose.Schema.Types.ObjectId,
        ref,
        required: true,
      }
    : {
        type: mongoose.Schema.Types.ObjectId,
        ref,
        default: null,
      };
}

function integerField(options = {}) {
  const { min = 0, max, required = true } = options;

  const defaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue")
    ? options.defaultValue
    : 0;

  const field = {
    type: Number,
    min,
    default: defaultValue,
    required,
    validate: {
      validator: Number.isSafeInteger,
      message: "{PATH} must be a safe whole number.",
    },
  };

  if (max !== undefined) {
    field.max = max;
  }

  return field;
}

function nullableSequenceField() {
  return {
    type: Number,
    default: null,
    min: 1,
    max: MAX_SHIFT_OCCURRENCES,
    validate: {
      validator: isNullableSafeInteger,
      message: "{PATH} must be a whole-number date sequence when supplied.",
    },
  };
}

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

function rateField() {
  return {
    type: Number,
    required: true,
    min: 0,
    max: 1,
    validate: {
      validator: isSupportedFinancialRate,
      message: "{PATH} must use the supported financial rate precision.",
    },
  };
}

function safeProduct(left, right, label) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new Error(`${label} requires non-negative safe integers.`);
  }

  const result = BigInt(left) * BigInt(right);

  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the supported safe-integer range.`);
  }

  return Number(result);
}

function count(summary, field) {
  return summary?.[field] ?? 0;
}

function sumCounts(summary, fields) {
  return fields.reduce((total, field) => total + count(summary, field), 0);
}

/* ─────────────────────────────── PARENT SUMMARIES ─────────────────────────────── */

const occurrenceProgressSchema = new mongoose.Schema(
  {
    ...Object.fromEntries(PROGRESS_FIELDS.map((field) => [field, nonNegativeIntegerField()])),

    lastReconciledAt: nullableDateField(),
  },
  {
    _id: false,
  }
);

// Assignment counts include replacement history; they are not position counts.
const assignmentSummarySchema = new mongoose.Schema(
  {
    scheduled: nonNegativeIntegerField(),

    active: nonNegativeIntegerField(),

    ending: nonNegativeIntegerField(),

    ended: nonNegativeIntegerField(),

    cancelled: nonNegativeIntegerField(),

    lastReconciledAt: nullableDateField(),
  },
  {
    _id: false,
  }
);

const hiringSummarySchema = new mongoose.Schema(
  {
    // Historical initial acceptances; ending an assignment does not decrement it.
    initialAcceptedCount: nonNegativeIntegerField(),

    // Open replacement opportunities, including isolated occurrence replacement.
    openReplacementCount: nonNegativeIntegerField(),

    lastReconciledAt: nullableDateField(),
  },
  {
    _id: false,
  }
);

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

    lastProfessionalApprovedAt: nullableDateField(),

    lastProfessionalReleasedAt: nullableDateField(),

    lastPlatformFeeEarnedAt: nullableDateField(),

    lastPlatformFeeCollectedAt: nullableDateField(),

    lastReconciledAt: nullableDateField(),
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── CANCELLATION SCHEMAS ─────────────────────────────── */

const cancellationPolicySnapshotSchema = new mongoose.Schema(
  {
    lateCancellationWindowMinutes: integerField({
      defaultValue: undefined,
    }),

    lateCancellationProfessionalPayRate: rateField(),

    activeWorkCancellationMinimumPayRate: rateField(),

    lockedAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

const cancellationSummarySchema = new mongoose.Schema(
  {
    // Locator only. Individual outcomes and compensation remain on occurrences.
    firstAffectedOccurrence: referenceField("ShiftOccurrence"),

    firstAffectedSequenceNumber: nullableSequenceField(),

    cancelledOccurrenceCount: nonNegativeIntegerField(),

    compensationApplicable: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

const activeCancellationOccurrenceSchema = new mongoose.Schema(
  {
    occurrence: referenceField("ShiftOccurrence", true),

    sequenceNumber: integerField({
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      defaultValue: undefined,
    }),
  },
  {
    _id: false,
  }
);

const activeWorkCancellationSummarySchema = new mongoose.Schema(
  {
    occurred: {
      type: Boolean,
      default: false,
    },

    affectedOccurrences: {
      type: [activeCancellationOccurrenceSchema],
      default: [],
    },

    effectiveAt: nullableDateField(),
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── SHIFT SCHEMA ─────────────────────────────── */

const shiftSchema = new mongoose.Schema(
  {
    // --- IDENTITY AND STAFFING REQUIREMENT ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    business: referenceField("EmployerProfile", true),

    branch: referenceField("Branch", true),

    postedBy: referenceField("User", true),

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
      enum: PROFESSIONAL_TYPE_OPTIONS.map((option) => option.value),
      required: true,
    },

    requiredProfessionals: integerField({
      min: 1,
      defaultValue: 1,
    }),

    // --- SHARED SCHEDULE ---
    // Schedule quantities describe one position, independently of headcount.

    scheduleMode: {
      type: String,
      enum: ["single", "multiple"],
      default: "single",
      required: true,
    },

    occurrenceCount: integerField({
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      defaultValue: 1,
    }),

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
        message: "Start minutes must be a whole number.",
      },
    },

    dailyEndTimeMinutes: {
      type: Number,
      default: null,
      min: 0,
      max: MINUTES_PER_DAY - 1,
      validate: {
        validator: isNullableSafeInteger,
        message: "End minutes must be a whole number.",
      },
    },

    endsNextDay: {
      type: Boolean,
      default: false,
    },

    scheduledMinutesPerOccurrence: integerField({
      min: 1,
      max: MINUTES_PER_DAY,
      defaultValue: undefined,
    }),

    totalScheduledMinutes: integerField({
      min: 1,
      max: MAX_SHIFT_OCCURRENCES * MINUTES_PER_DAY,
      defaultValue: undefined,
    }),

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

    breakDuration: integerField({
      max: MINUTES_PER_DAY,
    }),

    // Derived during document validation; these include every required position.
    totalOccurrenceCount: integerField({
      min: 1,
      defaultValue: undefined,
    }),

    totalStaffScheduledMinutes: integerField({
      min: 1,
      defaultValue: undefined,
    }),

    // --- FINANCIAL SNAPSHOTS AND SUMMARIES ---

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

    // Standard scheduled/base platform-fee rate in force for this Shift.
    // Preserved even when a subscription benefit reduces the applied BASE rate.
    standardBasePlatformFeeRate: rateField(),

    // Actual scheduled/base rate granted to this Shift. Estimated platform fees
    // are calculated from this rate. Once funded, downstream occurrence records
    // copy this snapshot and later subscription changes must not reprice it.
    basePlatformFeeRate: rateField(),

    // Overtime does not inherit the subscriber BASE discount at launch.
    // This is the separately disclosed OT platform-fee rate to copy to each
    // occurrence for any later approved overtime calculation.
    overtimePlatformFeeRate: rateField(),

    basePlatformFeeBenefitSource: {
      type: String,
      enum: BASE_PLATFORM_FEE_BENEFIT_SOURCES,
      default: "standard",
      required: true,
    },

    // Audit provenance only. The explicit rate snapshots above remain the
    // financial authority even if the subscription or plan later changes.
    basePlatformFeeSubscription: referenceField("Subscription"),

    pricingLockedAt: {
      type: Date,
      required: true,
    },

    pricingLockedBy: referenceField("User", true),

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

    // --- FUNDING AND PAYMENT STATE ---

    paymentStatus: {
      type: String,
      enum: SHIFT_PAYMENT_STATUSES,
      default: "unpaid",
      required: true,
    },

    // Preserve the existing Shift funding enum; refund records use their own enum.
    fundingMethod: {
      type: String,
      enum: ["wallet", "paystack_checkout", null],
      default: null,
    },

    fundingInitiatedAt: nullableDateField(),

    fundedAt: nullableDateField(),

    publishedAt: nullableDateField(),

    fundingTransaction: referenceField("Transaction"),

    // --- HIRING AND ASSIGNMENT SUMMARIES ---

    // Parent round refers to initial hiring only. Replacement rounds are scoped
    // to their own assignment/occurrence opportunity, not a global Shift round.
    applicationRound: integerField({
      min: 1,
      max: MAX_APPLICATION_ROUNDS,
      defaultValue: 1,
    }),

    totalApplications: nonNegativeIntegerField(),

    currentRoundApplications: nonNegativeIntegerField(),

    hiringSummary: {
      type: hiringSummarySchema,
      default: () => ({}),
    },

    assignmentSummary: {
      type: assignmentSummarySchema,
      default: () => ({}),
    },

    occurrenceProgress: {
      type: occurrenceProgressSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: SHIFT_STATUSES,
      default: "pending_funding",
      required: true,
    },

    // --- REQUIREMENTS ---

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

    // --- WHOLE-ENGAGEMENT CANCELLATION ---
    // Selective cancellation stays on occurrences.

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

    cancelledByUser: referenceField("User"),

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

    cancelledAt: nullableDateField(),

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

/* ─────────────────────────────── SCHEDULE VALIDATION ─────────────────────────────── */

function validateSchedule(document) {
  const dates = document.occurrenceCount;

  const positions = document.requiredProfessionals;

  const repeatDays = Array.isArray(document.repeatDays) ? document.repeatDays : [];

  if (document.startTime && document.endTime && document.endTime <= document.startTime) {
    document.invalidate("endTime", "endTime must be later than startTime.");
  }

  if (new Set(repeatDays).size !== repeatDays.length) {
    document.invalidate("repeatDays", "repeatDays cannot contain duplicate weekdays.");
  }

  let minutes = null;

  if (document.scheduleMode === "single") {
    if (dates !== 1) {
      document.invalidate(
        "occurrenceCount",
        "A single schedule must contain exactly one work date."
      );
    }

    if (repeatDays.length) {
      document.invalidate("repeatDays", "A single schedule cannot contain repeat days.");
    }

    if (document.startTime && document.endTime) {
      minutes = (document.endTime.getTime() - document.startTime.getTime()) / 60000;
    }

    if (
      document.firstOccurrenceDate &&
      document.lastOccurrenceDate &&
      document.firstOccurrenceDate !== document.lastOccurrenceDate
    ) {
      document.invalidate("lastOccurrenceDate", "A single schedule must use one occurrence date.");
    }
  } else if (document.scheduleMode === "multiple") {
    if (!Number.isSafeInteger(dates) || dates < 2 || dates > MAX_SHIFT_OCCURRENCES) {
      document.invalidate(
        "occurrenceCount",
        `A repeated schedule requires 2 to ${MAX_SHIFT_OCCURRENCES} work dates.`
      );
    }

    if (!repeatDays.length) {
      document.invalidate("repeatDays", "A repeated schedule requires at least one repeat day.");
    }

    for (const field of ["firstOccurrenceDate", "lastOccurrenceDate"]) {
      if (!document[field]) {
        document.invalidate(field, `${field} is required for a repeated schedule.`);
      }
    }

    minutes = calculatePatternScheduledMinutes({
      dailyStartTimeMinutes: document.dailyStartTimeMinutes,
      dailyEndTimeMinutes: document.dailyEndTimeMinutes,
      endsNextDay: document.endsNextDay,
    });
  }

  if (
    document.firstOccurrenceDate &&
    document.lastOccurrenceDate &&
    document.lastOccurrenceDate < document.firstOccurrenceDate
  ) {
    document.invalidate(
      "lastOccurrenceDate",
      "lastOccurrenceDate cannot precede firstOccurrenceDate."
    );
  }

  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > MINUTES_PER_DAY) {
    document.invalidate(
      "scheduledMinutesPerOccurrence",
      "Each work date must last 1 to 1,440 whole minutes."
    );
  } else {
    if (document.scheduledMinutesPerOccurrence !== minutes) {
      document.invalidate(
        "scheduledMinutesPerOccurrence",
        "Scheduled minutes must match the daily duration."
      );
    }

    if (Number.isSafeInteger(dates) && dates >= 1 && dates <= MAX_SHIFT_OCCURRENCES) {
      const expectedMinutes = minutes * dates;

      if (document.totalScheduledMinutes !== expectedMinutes) {
        document.invalidate(
          "totalScheduledMinutes",
          "totalScheduledMinutes must equal date count times daily minutes for one position."
        );
      }

      if (
        !Number.isFinite(document.scheduledHours) ||
        !approximatelyEqual(document.scheduledHours, expectedMinutes / 60)
      ) {
        document.invalidate(
          "scheduledHours",
          "scheduledHours must describe the full schedule for one position."
        );
      }
    }

    if (Number.isSafeInteger(document.breakDuration) && document.breakDuration >= minutes) {
      document.invalidate("breakDuration", "Break duration must be shorter than each work date.");
    }
  }

  if (
    !Number.isSafeInteger(dates) ||
    dates < 1 ||
    dates > MAX_SHIFT_OCCURRENCES ||
    !Number.isSafeInteger(positions) ||
    positions < 1
  ) {
    return null;
  }

  try {
    const total = safeProduct(dates, positions, "Total occurrence count");

    document.totalOccurrenceCount = total;

    if (
      Number.isSafeInteger(document.totalScheduledMinutes) &&
      document.totalScheduledMinutes > 0
    ) {
      document.totalStaffScheduledMinutes = safeProduct(
        document.totalScheduledMinutes,
        positions,
        "Total staff scheduled minutes"
      );
    }

    return total;
  } catch (error) {
    document.invalidate("requiredProfessionals", error.message);

    return null;
  }
}

/* ─────────────────────────────── POSTING PRICE VALIDATION ─────────────────────────────── */

function validatePricing(document, total) {
  if (
    document.pricingLockedAt &&
    document.cancellationPolicySnapshot?.lockedAt &&
    document.pricingLockedAt.getTime() !== document.cancellationPolicySnapshot.lockedAt.getTime()
  ) {
    document.invalidate(
      "cancellationPolicySnapshot.lockedAt",
      "Cancellation policy and pricing must be locked at the same time."
    );
  }

  const standardBaseRate = Number(document.standardBasePlatformFeeRate);

  const appliedBaseRate = Number(document.basePlatformFeeRate);

  const overtimeRate = Number(document.overtimePlatformFeeRate);

  const benefitSource = String(document.basePlatformFeeBenefitSource || "standard");

  if (benefitSource === "standard") {
    if (document.basePlatformFeeSubscription) {
      document.invalidate(
        "basePlatformFeeSubscription",
        "A standard BASE platform-fee rate cannot reference a subscription benefit."
      );
    }

    if (
      isSupportedFinancialRate(standardBaseRate) &&
      isSupportedFinancialRate(appliedBaseRate) &&
      appliedBaseRate !== standardBaseRate
    ) {
      document.invalidate(
        "basePlatformFeeRate",
        "Without a subscription benefit, the applied BASE platform-fee rate must equal the standard BASE rate."
      );
    }
  }

  if (benefitSource === "subscription") {
    if (!document.basePlatformFeeSubscription) {
      document.invalidate(
        "basePlatformFeeSubscription",
        "A subscription-discounted BASE platform-fee rate requires the granting subscription."
      );
    }

    if (
      isSupportedFinancialRate(standardBaseRate) &&
      isSupportedFinancialRate(appliedBaseRate) &&
      appliedBaseRate >= standardBaseRate
    ) {
      document.invalidate(
        "basePlatformFeeRate",
        "A subscription BASE platform-fee rate must be lower than the standard BASE rate."
      );
    }
  }

  // Overtime has its own disclosed snapshot and is intentionally not derived
  // from the subscriber BASE rate. Future policy may configure this rate
  // independently without rewriting already funded Shifts.
  if (!isSupportedFinancialRate(overtimeRate)) {
    document.invalidate(
      "overtimePlatformFeeRate",
      "overtimePlatformFeeRate must use the supported financial rate precision."
    );
  }

  validateAmountTriple(document, {
    professionalPath: "estimatedProfessionalPay",
    platformPath: "estimatedPlatformFee",
    employerPath: "estimatedEmployerCharge",
    label: "Estimated",
  });

  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    !Number.isSafeInteger(document.hourlyRate) ||
    document.hourlyRate <= 0 ||
    !Number.isSafeInteger(document.scheduledMinutesPerOccurrence) ||
    document.scheduledMinutesPerOccurrence <= 0 ||
    !isSupportedFinancialRate(appliedBaseRate)
  ) {
    return;
  }

  try {
    // Round one position/date first, then sum identical snapshots across capacity.
    const pay = money.calculateMinorPayFromMinutes({
      hourlyRateMinor: document.hourlyRate,
      minutes: document.scheduledMinutesPerOccurrence,
      fieldName: "Estimated professional pay per occurrence",
    });

    const fee = money.calculateMinorAmountFromRate({
      amountMinor: pay,
      rate: appliedBaseRate,
      rateScale: FINANCIAL_RATE_SCALE,
      fieldName: "Estimated BASE platform fee per occurrence",
      rateFieldName: "BASE platform fee rate",
    });

    const expectedPay = safeProduct(pay, total, "Estimated professional pay");

    const expectedFee = safeProduct(fee, total, "Estimated platform fee");

    const expectedCharge = money.sumMinorUnitAmounts(
      [expectedPay, expectedFee],
      "Estimated employer charge"
    );

    for (const [field, expected] of [
      ["estimatedProfessionalPay", expectedPay],
      ["estimatedPlatformFee", expectedFee],
      ["estimatedEmployerCharge", expectedCharge],
    ]) {
      if (document[field] !== expected) {
        document.invalidate(
          field,
          `${field} must include every required position on every scheduled date.`
        );
      }
    }
  } catch (error) {
    document.invalidate(
      "estimatedEmployerCharge",
      "Posting totals are invalid or exceed the supported safe-integer range."
    );
  }
}

/* ─────────────────────────────── FINANCIAL SUMMARY VALIDATION ─────────────────────────────── */

function validateFinancialSummary(document) {
  const summary = document.settlementSummary || {};

  const approved = count(summary, "approvedProfessionalPay");

  const released = count(summary, "releasedProfessionalPay");

  const earned = count(summary, "earnedPlatformFee");

  const collected = count(summary, "collectedPlatformFee");

  const committed = count(summary, "committedEmployerCharge");

  const funded = document.fundedAmount;

  const refunded = document.refundedAmount;

  const topUp = document.topUpRequired;

  if (
    ![approved, released, earned, collected, committed, funded, refunded, topUp].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  ) {
    document.invalidate(
      "settlementSummary",
      "Financial summaries require non-negative safe-integer minor-unit amounts."
    );

    return;
  }

  if (released > approved) {
    document.invalidate(
      "settlementSummary.releasedProfessionalPay",
      "Released pay cannot exceed approved pay."
    );
  }

  if (collected > earned) {
    document.invalidate(
      "settlementSummary.collectedPlatformFee",
      "Collected fees cannot exceed earned fees."
    );
  }

  try {
    if (committed !== money.sumMinorUnitAmounts([approved, earned], "Committed employer charge")) {
      document.invalidate(
        "settlementSummary.committedEmployerCharge",
        "Committed charge must equal approved professional pay plus earned platform fees."
      );
    }

    if (
      money.sumMinorUnitAmounts([committed, refunded], "Committed charges plus refunds") >
      money.sumMinorUnitAmounts([funded, topUp], "Funding plus outstanding top-up")
    ) {
      document.invalidate(
        "settlementSummary.committedEmployerCharge",
        "Committed charges and refunds cannot exceed funding plus outstanding top-up."
      );
    }

    if (money.sumMinorUnitAmounts([released, collected, refunded], "Completed outflows") > funded) {
      document.invalidate(
        "settlementSummary",
        "Completed payouts, fee collections and refunds cannot exceed funding."
      );
    }
  } catch (error) {
    document.invalidate(
      "settlementSummary",
      "Financial reconciliation exceeds the supported safe-integer range."
    );
  }

  for (const [field, value] of [
    ["lastProfessionalApprovedAt", approved],
    ["lastProfessionalReleasedAt", released],
    ["lastPlatformFeeEarnedAt", earned],
    ["lastPlatformFeeCollectedAt", collected],
  ]) {
    if (summary[field] && value <= 0) {
      document.invalidate(
        `settlementSummary.${field}`,
        `${field} requires a positive corresponding amount.`
      );
    }
  }
}

/* ─────────────────────────────── HIRING SUMMARY VALIDATION ─────────────────────────────── */

function validateHiring(document) {
  const initialAccepted = count(document.hiringSummary, "initialAcceptedCount");

  const openReplacements = count(document.hiringSummary, "openReplacementCount");

  const operationalAssignments = sumCounts(document.assignmentSummary, [
    "scheduled",
    "active",
    "ending",
  ]);

  if (document.applicationRound !== 1) {
    document.invalidate(
      "applicationRound",
      "Parent initial hiring remains round 1; replacement rounds belong to their own opportunities."
    );
  }

  if (initialAccepted > document.requiredProfessionals) {
    document.invalidate(
      "hiringSummary.initialAcceptedCount",
      "Initial acceptances cannot exceed requiredProfessionals."
    );
  }

  if (document.currentRoundApplications > document.totalApplications) {
    document.invalidate(
      "currentRoundApplications",
      "currentRoundApplications cannot exceed totalApplications."
    );
  }

  if (initialAccepted > document.totalApplications) {
    document.invalidate(
      "hiringSummary.initialAcceptedCount",
      "Initial accepted applications cannot exceed totalApplications."
    );
  }

  if (
    ["assigned", "confirmed"].includes(document.status) &&
    operationalAssignments === 0 &&
    openReplacements === 0
  ) {
    document.invalidate(
      "assignmentSummary",
      "Assigned or confirmed engagements require operational assignments or open replacement hiring."
    );
  }

  if (["pending_funding", "completed", "cancelled"].includes(document.status)) {
    if (operationalAssignments !== 0) {
      document.invalidate(
        "assignmentSummary",
        `${document.status} cannot retain operational assignments requiring future coverage.`
      );
    }

    if (openReplacements !== 0) {
      document.invalidate(
        "hiringSummary.openReplacementCount",
        `${document.status} cannot retain open replacement hiring.`
      );
    }
  }

  if (document.status === "pending_funding" && initialAccepted !== 0) {
    document.invalidate(
      "hiringSummary.initialAcceptedCount",
      "An unfunded engagement cannot contain accepted applications."
    );
  }

  if (openReplacements > 0 && ["unpaid", "released", "refunded"].includes(document.paymentStatus)) {
    document.invalidate(
      "paymentStatus",
      "Open replacement hiring requires protected funds available for remaining coverage."
    );
  }

  // Ordinary vacancies and replacement hiring may coexist with active assignments.
  // Actual fillability and assignment ranges must be checked against occurrences.
}

/* ─────────────────────────────── OCCURRENCE PROGRESS VALIDATION ─────────────────────────────── */

function validateOccurrenceProgress(document, total) {
  if (!Number.isSafeInteger(total) || total < 1) {
    return;
  }

  const progress = document.occurrenceProgress;

  if (!progress) {
    document.invalidate("occurrenceProgress", "Occurrence progress is required.");

    return;
  }

  const dimensions = [
    [ASSIGNMENT_PROGRESS_FIELDS, "unassigned"],
    [STATUS_PROGRESS_FIELDS, "scheduled"],
    [SETTLEMENT_PROGRESS_FIELDS, "settlementNotDue"],
    [REFUND_PROGRESS_FIELDS, "refundNotEligible"],
  ];

  if (document.isNew) {
    for (const [fields, initial] of dimensions) {
      if (fields.every((field) => count(progress, field) === 0)) {
        progress[initial] = total;
      }
    }
  }

  for (const field of PROGRESS_FIELDS) {
    const value = count(progress, field);

    if (!Number.isSafeInteger(value) || value < 0 || value > total) {
      document.invalidate(
        `occurrenceProgress.${field}`,
        `${field} must be between 0 and totalOccurrenceCount.`
      );
    }
  }

  for (const [fields, initial] of dimensions) {
    if (sumCounts(progress, fields) !== total) {
      document.invalidate(
        `occurrenceProgress.${initial}`,
        "Each progress dimension must cover every position/date occurrence exactly once."
      );
    }
  }

  const terminal = sumCounts(progress, ["completed", "cancelled", "noShow", "expiredUnfilled"]);

  if (count(progress, "resolved") > terminal) {
    document.invalidate(
      "occurrenceProgress.resolved",
      "Resolved count cannot exceed terminal occurrence count."
    );
  }

  if (document.status === "completed" && count(progress, "resolved") !== total) {
    document.invalidate(
      "occurrenceProgress.resolved",
      "A completed engagement must resolve every position/date occurrence."
    );
  }
}

/* ─────────────────────────────── PUBLICATION AND PAYMENT VALIDATION ─────────────────────────────── */

function validatePublicationAndPayment(document, total) {
  const progress = document.occurrenceProgress || {};

  const summary = document.settlementSummary || {};

  const approved = count(summary, "approvedProfessionalPay");

  const released = count(summary, "releasedProfessionalPay");

  const committed = count(summary, "committedEmployerCharge");

  const refunded = document.refundedAmount;

  const topUp = document.topUpRequired;

  const requiresPublication = [
    "open",
    "assigned",
    "confirmed",
    "in_progress",
    "pending_settlement",
    "completed",
    "disputed",
    "no_show",
  ].includes(document.status);

  if (requiresPublication && !document.publishedAt) {
    document.invalidate("publishedAt", `${document.status} requires publication.`);
  }

  if (document.publishedAt) {
    if (!SHIFT_PUBLISHED_PAYMENT_STATUSES.includes(document.paymentStatus)) {
      document.invalidate(
        "paymentStatus",
        "A published engagement requires protected funding or a later financial state."
      );
    }

    if (
      !Number.isSafeInteger(document.fundedAmount) ||
      !Number.isSafeInteger(document.estimatedEmployerCharge) ||
      document.fundedAmount < document.estimatedEmployerCharge
    ) {
      document.invalidate(
        "fundedAmount",
        "Publication requires funding for every required position's full schedule."
      );
    }

    for (const field of ["fundingMethod", "fundedAt", "fundingTransaction"]) {
      if (!document[field]) {
        document.invalidate(field, `${field} is required for a published engagement.`);
      }
    }

    if (
      document.fundingInitiatedAt &&
      document.fundedAt &&
      document.fundedAt < document.fundingInitiatedAt
    ) {
      document.invalidate("fundedAt", "fundedAt cannot precede fundingInitiatedAt.");
    }

    if (document.fundedAt && document.publishedAt < document.fundedAt) {
      document.invalidate("publishedAt", "publishedAt cannot precede fundedAt.");
    }
  }

  if (document.status === "pending_funding") {
    if (document.publishedAt) {
      document.invalidate("publishedAt", "A pending-funding engagement cannot be published.");
    }

    if (document.paymentStatus !== "unpaid") {
      document.invalidate("paymentStatus", "A pending-funding engagement must remain unpaid.");
    }

    if (document.fundedAmount !== 0) {
      document.invalidate(
        "fundedAmount",
        "A pending-funding engagement cannot contain protected funding."
      );
    }
  }

  if (document.status === "open") {
    if (
      !SHIFT_PUBLISHED_PAYMENT_STATUSES.includes(document.paymentStatus) ||
      ["released", "refunded"].includes(document.paymentStatus)
    ) {
      document.invalidate(
        "paymentStatus",
        "An open engagement must retain a non-final published payment state."
      );
    }

    if (count(progress, "unassigned") <= 0 || count(progress, "scheduled") <= 0) {
      document.invalidate(
        "occurrenceProgress.unassigned",
        "An open engagement requires unassigned scheduled capacity."
      );
    }
  }

  if (document.paymentStatus === "funded" && (released !== 0 || refunded !== 0 || topUp !== 0)) {
    document.invalidate(
      "paymentStatus",
      "funded cannot retain professional payouts, refunds or outstanding top-up."
    );
  }

  if (
    document.paymentStatus === "awaiting_overtime_review" &&
    count(progress, "awaitingOvertimeReview") <= 0
  ) {
    document.invalidate(
      "occurrenceProgress.awaitingOvertimeReview",
      "This payment state requires an occurrence awaiting OT review."
    );
  }

  if (document.paymentStatus === "awaiting_topup") {
    if (topUp <= 0) {
      document.invalidate("topUpRequired", "awaiting_topup requires a positive top-up amount.");
    }

    if (count(progress, "awaitingTopup") <= 0) {
      document.invalidate(
        "occurrenceProgress.awaitingTopup",
        "awaiting_topup requires an occurrence awaiting top-up."
      );
    }
  } else if (topUp > 0) {
    document.invalidate(
      "paymentStatus",
      "A positive top-up requires paymentStatus awaiting_topup."
    );
  }

  if (
    document.paymentStatus === "release_pending" &&
    count(progress, "releasePending") <= 0 &&
    count(progress, "approvedForRelease") <= 0
  ) {
    document.invalidate(
      "occurrenceProgress.releasePending",
      "release_pending requires approved or processing professional payout."
    );
  }

  if (
    document.paymentStatus === "partially_released" &&
    (released <= 0 || (Number.isSafeInteger(total) && count(progress, "resolved") >= total))
  ) {
    document.invalidate(
      "settlementSummary.releasedProfessionalPay",
      "partially_released requires paid professional earnings and unresolved occurrence workflows."
    );
  }

  if (document.paymentStatus === "released") {
    if (approved <= 0 || released !== approved || refunded !== 0) {
      document.invalidate(
        "settlementSummary.releasedProfessionalPay",
        "released requires all approved pay to be paid and no employer refund."
      );
    }

    if (Number.isSafeInteger(total) && count(progress, "resolved") !== total) {
      document.invalidate(
        "occurrenceProgress.resolved",
        "released requires all occurrence workflows to be resolved."
      );
    }
  }

  if (["refunded", "partially_refunded"].includes(document.paymentStatus) && refunded <= 0) {
    document.invalidate(
      "refundedAmount",
      "Refunded payment states require a positive completed refund."
    );
  }

  if (
    document.paymentStatus === "refunded" &&
    (released !== 0 || refunded !== document.fundedAmount)
  ) {
    document.invalidate(
      "paymentStatus",
      "refunded requires zero professional payout and a full refund of protected funding."
    );
  }

  if (document.paymentStatus === "partially_refunded" && refunded >= document.fundedAmount) {
    document.invalidate("refundedAmount", "A partial refund must remain below fundedAmount.");
  }

  if (document.status !== "completed") {
    return;
  }

  if (!SHIFT_FINAL_PAYMENT_STATUSES.includes(document.paymentStatus)) {
    document.invalidate(
      "paymentStatus",
      "A completed engagement requires a final released or refunded payment state."
    );
  }

  if (topUp !== 0) {
    document.invalidate(
      "topUpRequired",
      "A completed engagement cannot retain outstanding top-up."
    );
  }

  if (released !== approved) {
    document.invalidate(
      "settlementSummary.releasedProfessionalPay",
      "A completed engagement must have paid all approved professional earnings."
    );
  }

  try {
    if (
      money.sumMinorUnitAmounts([committed, refunded], "Completed funding reconciliation") !==
      document.fundedAmount
    ) {
      document.invalidate(
        "settlementSummary.committedEmployerCharge",
        "Completion must reconcile all funding into committed charges and completed refunds."
      );
    }
  } catch (error) {
    document.invalidate(
      "settlementSummary.committedEmployerCharge",
      "Completed funding reconciliation is invalid or too large."
    );
  }

  for (const [fields, path] of [
    [["scheduled", "inProgress", "pendingSettlement", "disputed"], "resolved"],
    [
      [
        "pendingReview",
        "awaitingOvertimeReview",
        "awaitingTopup",
        "approvedForRelease",
        "releasePending",
        "failed",
        "settlementDisputed",
      ],
      "settlementNotDue",
    ],
    [["refundHeld", "refundEligible", "refundBatched", "refundProcessing"], "refundEligible"],
  ]) {
    if (sumCounts(progress, fields) !== 0) {
      document.invalidate(
        `occurrenceProgress.${path}`,
        "A completed engagement cannot retain unresolved operational, payout or refund workflows."
      );
    }
  }

  if (count(progress, "expiredUnfilled") > count(progress, "refunded")) {
    document.invalidate(
      "occurrenceProgress.refunded",
      "Expired-unfilled occurrences must complete their refunds before engagement completion."
    );
  }
}

/* ─────────────────────────────── CANCELLATION VALIDATION ─────────────────────────────── */

function validateCancellation(document, total) {
  const summary = document.cancellationSummary || {};

  const active = document.activeWorkCancellation || {};

  const affected = active.affectedOccurrences || [];

  const summaryHasData =
    hasDocumentValue(summary.firstAffectedOccurrence) ||
    hasDocumentValue(summary.firstAffectedSequenceNumber) ||
    count(summary, "cancelledOccurrenceCount") > 0 ||
    summary.compensationApplicable === true;

  const activeHasData =
    active.occurred === true || affected.length > 0 || hasDocumentValue(active.effectiveAt);

  const auditFields = [
    "cancelledFromStatus",
    "cancellationCode",
    "cancelledBy",
    "cancelledByUser",
    "cancellationReasonCode",
    "cancellationReason",
    "cancelledAt",
  ];

  if (document.status !== "cancelled") {
    if (auditFields.some((field) => hasDocumentValue(document[field]))) {
      document.invalidate("cancelledAt", "Parent cancellation audit requires cancelled status.");
    }

    if (summaryHasData) {
      document.invalidate(
        "cancellationSummary",
        "Parent cancellation summary requires cancelled status."
      );
    }

    if (activeHasData) {
      document.invalidate(
        "activeWorkCancellation",
        "Parent active-work cancellation requires cancelled status."
      );
    }

    return;
  }

  for (const field of ["cancelledFromStatus", "cancellationCode", "cancelledAt", "cancelledBy"]) {
    if (!document[field]) {
      document.invalidate(field, `${field} is required for a cancelled engagement.`);
    }
  }

  if (document.cancelledBy === "employer") {
    if (!document.cancellationReasonCode) {
      document.invalidate(
        "cancellationReasonCode",
        "Employer cancellation requires a structured reason."
      );
    }

    if (
      CANCELLATION_REASON_CODES_REQUIRING_DETAILS.includes(document.cancellationReasonCode) &&
      !document.cancellationReason
    ) {
      document.invalidate(
        "cancellationReason",
        "The selected reason requires additional cancellation details."
      );
    }
  } else {
    if (document.cancellationReasonCode) {
      document.invalidate(
        "cancellationReasonCode",
        "Only employer cancellation may use an employer reason code."
      );
    }

    if (!document.cancellationReason) {
      document.invalidate(
        "cancellationReason",
        "System and admin cancellations require an audit reason."
      );
    }
  }

  validateMinimumDetails(
    document,
    "cancellationReason",
    document.cancellationReason,
    "Cancellation details"
  );

  if (USER_CANCELLATION_ACTORS.includes(document.cancelledBy) && !document.cancelledByUser) {
    document.invalidate("cancelledByUser", "User-initiated cancellation requires cancelledByUser.");
  }

  if (document.cancelledBy === "system" && document.cancelledByUser) {
    document.invalidate("cancelledByUser", "System cancellation cannot contain cancelledByUser.");
  }

  const expectedActor = CANCELLATION_CODE_ACTORS[document.cancellationCode];

  if (expectedActor && document.cancelledBy !== expectedActor) {
    document.invalidate(
      "cancelledBy",
      `${document.cancellationCode} requires actor ${expectedActor}.`
    );
  }

  if (document.cancelledFromStatus === "pending_funding") {
    if (document.paymentStatus !== "unpaid") {
      document.invalidate("paymentStatus", "Unfunded cancellation must remain unpaid.");
    }

    if (document.publishedAt) {
      document.invalidate("publishedAt", "Unfunded cancellation cannot have publication audit.");
    }

    if (document.fundedAmount !== 0) {
      document.invalidate(
        "fundedAmount",
        "Unfunded cancellation cannot contain protected funding."
      );
    }

    if (summary.compensationApplicable) {
      document.invalidate(
        "cancellationSummary.compensationApplicable",
        "Unfunded cancellation cannot create professional compensation."
      );
    }
  } else if (
    ["open", "assigned", "confirmed", "in_progress"].includes(document.cancelledFromStatus) &&
    !document.publishedAt
  ) {
    document.invalidate(
      "publishedAt",
      "Cancellation of a published engagement must retain publication audit."
    );
  }

  if (document.cancellationCode === "funding_deadline_passed") {
    if (document.cancelledFromStatus !== "pending_funding") {
      document.invalidate(
        "cancelledFromStatus",
        "Funding expiration requires cancellation from pending_funding."
      );
    }

    if (document.startTime && document.cancelledAt && document.cancelledAt < document.startTime) {
      document.invalidate("cancelledAt", "Funding expiration cannot precede the Shift start time.");
    }
  }

  const cancelledCount = count(summary, "cancelledOccurrenceCount");

  if (Number.isSafeInteger(total) && cancelledCount > total) {
    document.invalidate(
      "cancellationSummary.cancelledOccurrenceCount",
      "Cancelled count cannot exceed totalOccurrenceCount."
    );
  }

  if (summaryHasData) {
    if (!summary.firstAffectedOccurrence) {
      document.invalidate(
        "cancellationSummary.firstAffectedOccurrence",
        "Cancellation summary requires a first affected occurrence."
      );
    }

    if (
      !Number.isSafeInteger(summary.firstAffectedSequenceNumber) ||
      summary.firstAffectedSequenceNumber < 1 ||
      summary.firstAffectedSequenceNumber > document.occurrenceCount
    ) {
      document.invalidate(
        "cancellationSummary.firstAffectedSequenceNumber",
        "First affected sequence must be within the shared schedule."
      );
    }
  }

  if (summary.compensationApplicable) {
    if (
      document.cancellationCode !== "late_employer_cancellation" ||
      document.cancelledBy !== "employer"
    ) {
      document.invalidate(
        "cancellationCode",
        "Late-cancellation compensation requires late_employer_cancellation by the employer."
      );
    }

    if (!["open", "assigned", "confirmed", "in_progress"].includes(document.cancelledFromStatus)) {
      document.invalidate(
        "cancelledFromStatus",
        "Compensation requires a published engagement with assigned occurrence coverage."
      );
    }

    if (cancelledCount <= 0) {
      document.invalidate(
        "cancellationSummary.cancelledOccurrenceCount",
        "Late-cancellation compensation requires an affected cancelled occurrence."
      );
    }
  } else if (document.cancellationCode === "late_employer_cancellation") {
    document.invalidate(
      "cancellationSummary.compensationApplicable",
      "late_employer_cancellation requires occurrence-level compensation."
    );
  }

  if (
    document.cancelledFromStatus !== "in_progress" &&
    document.cancellationCode !== "funding_deadline_passed" &&
    document.cancelledAt &&
    document.startTime &&
    document.cancelledAt >= document.startTime
  ) {
    document.invalidate(
      "cancelledAt",
      "Cancellation of an engagement that has not yet started must happen before the scheduled start time."
    );
  }

  if (!active.occurred) {
    if (activeHasData) {
      document.invalidate(
        "activeWorkCancellation.occurred",
        "Active-work details require occurred to be true."
      );
    }

    return;
  }

  if (document.cancelledFromStatus !== "in_progress") {
    document.invalidate(
      "cancelledFromStatus",
      "Active-work cancellation requires cancellation from in_progress."
    );
  }

  if (!affected.length || !active.effectiveAt) {
    document.invalidate(
      "activeWorkCancellation.affectedOccurrences",
      "Active-work cancellation requires affected occurrences and an effective time."
    );
  }

  if (affected.length > document.requiredProfessionals) {
    document.invalidate(
      "activeWorkCancellation.affectedOccurrences",
      "Active occurrence count cannot exceed required positions."
    );
  }

  const seen = new Set();

  affected.forEach((entry, index) => {
    const path = `activeWorkCancellation.affectedOccurrences.${index}`;

    if (entry.occurrence) {
      const id = String(entry.occurrence._id || entry.occurrence);

      if (seen.has(id)) {
        document.invalidate(`${path}.occurrence`, "An affected occurrence cannot be listed twice.");
      }

      seen.add(id);
    }

    if (
      !Number.isSafeInteger(entry.sequenceNumber) ||
      entry.sequenceNumber < 1 ||
      entry.sequenceNumber > document.occurrenceCount
    ) {
      document.invalidate(
        `${path}.sequenceNumber`,
        "Affected sequence must be within the shared schedule."
      );
    }
  });

  if (Number.isSafeInteger(total) && cancelledCount > total - affected.length) {
    document.invalidate(
      "cancellationSummary.cancelledOccurrenceCount",
      "Occurrences ended during active work must not also count as cancelled occurrences."
    );
  }

  if (active.effectiveAt && document.cancelledAt && active.effectiveAt < document.cancelledAt) {
    document.invalidate(
      "activeWorkCancellation.effectiveAt",
      "Effective time cannot precede parent cancellation."
    );
  }

  // Different positions can have different cancellation outcomes. One may have
  // started work while another qualifies for late-cancellation compensation.
  // The service validates each occurrence and prevents double compensation.
}

/* ─────────────────────────────── VALIDATION HOOK ─────────────────────────────── */

shiftSchema.pre("validate", function validateShift() {
  const total = validateSchedule(this);

  validatePricing(this, total);

  validateFinancialSummary(this);

  validateHiring(this);

  validateOccurrenceProgress(this, total);

  validatePublicationAndPayment(this, total);

  validateCancellation(this, total);
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
  applicationRound: 1,
  status: 1,
});

shiftSchema.index({
  "hiringSummary.openReplacementCount": 1,
  professionalType: 1,
  startTime: 1,
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
  fundingTransaction: 1,
});

shiftSchema.index({
  basePlatformFeeBenefitSource: 1,
  basePlatformFeeSubscription: 1,
  fundedAt: -1,
});

shiftSchema.index({
  cancellationReasonCode: 1,
  cancelledAt: -1,
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
