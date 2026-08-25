// services/shifts/shiftCreationService.js

const crypto = require("crypto");
const mongoose = require("mongoose");

const Shift = require("../../models/Shift");
const ShiftOccurrence = require("../../models/ShiftOccurrence");
const Branch = require("../../models/Branch");
const EmployerProfile = require("../../models/EmployerProfile");

const PlatformSettingsService = require("../platformSettingsService");
const WalletService = require("../walletService");
const EmployerDelinquencyService = require("../employerDelinquencyService");

const ShiftScheduleService = require("./shiftScheduleService");
const ShiftPricingService = require("./shiftPricingService");

const {
  MILLISECONDS_PER_MINUTE,
  PROFESSIONAL_TYPE_OPTIONS,
  ACTIVE_SHIFT_PROFESSIONAL_TYPES,
} = require("../../constants/shiftPosting");

const { createServiceError } = require("../helpers/serviceErrorHelper");

const {
  normalizeFieldCode,
  normalizeObjectId,
  normalizeOptionalText,
} = require("../helpers/serviceValidationHelpers");

const { runWithOptionalTransaction } = require("../helpers/transactionHelper");

const { hasValidBranchLocation } = require("../helpers/branchValidationHelpers");

const money = require("../../utils/money");
const logger = require("../../utils/logger");

const SHIFT_SERVICE_ERROR_NAME = "ShiftServiceError";

const ATTENDANCE_PIN_MAX_EXCLUSIVE = 10000;
const ATTENDANCE_PIN_LENGTH = 4;

const MAX_ROLE_TITLE_LENGTH = 120;
const MAX_DEPARTMENT_LENGTH = 120;
const MAX_REQUIRED_SKILL_LENGTH = 100;
const MAX_REQUIRED_SKILLS = 20;
const MAX_DRESS_CODE_LENGTH = 300;
const MAX_SHIFT_DESCRIPTION_LENGTH = 500;

function createShiftError(options) {
  return createServiceError({
    ...options,
    name: SHIFT_SERVICE_ERROR_NAME,
  });
}

class ShiftCreationService {
  /* ─────────────────────────────── INPUT NORMALIZATION ─────────────────────────────── */

  static normalizeRequiredText(value, fieldName, maximumLength) {
    const normalizedValue = String(value ?? "").trim();

    const fieldCode = normalizeFieldCode(fieldName);

    if (!normalizedValue) {
      throw createShiftError({
        message: `${fieldName} is required.`,
        code: `MISSING_${fieldCode}`,
      });
    }

    if (normalizedValue.length > maximumLength) {
      throw createShiftError({
        message: `${fieldName} cannot exceed ` + `${maximumLength} characters.`,
        code: `${fieldCode}_TOO_LONG`,
      });
    }

    return normalizedValue;
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    const normalizedValue = normalizeOptionalText({
      value,
      fieldName,
      maximumLength,
      createError: createShiftError,
    });

    return normalizedValue === null ? undefined : normalizedValue;
  }

  static normalizeProfessionalType(value) {
    const professionalType = String(value || "")
      .trim()
      .toLowerCase();

    const professionalTypeExists = PROFESSIONAL_TYPE_OPTIONS.some(
      (option) => option.value === professionalType
    );

    if (!professionalTypeExists) {
      throw createShiftError({
        message: "A valid professional type is required.",
        code: "INVALID_PROFESSIONAL_TYPE",
      });
    }

    if (!ACTIVE_SHIFT_PROFESSIONAL_TYPES.includes(professionalType)) {
      throw createShiftError({
        message: "This professional type is not currently available for Shift posting.",
        code: "PROFESSIONAL_TYPE_NOT_CURRENTLY_SUPPORTED",
      });
    }

    return professionalType;
  }

  static normalizeRequiredSkills(value) {
    if (value === null || value === undefined || value === "") {
      return [];
    }

    const skillValues = Array.isArray(value) ? value : String(value).split(",");

    const seenSkills = new Set();
    const skills = [];

    for (const skillValue of skillValues) {
      const skill = String(skillValue || "").trim();

      if (!skill) {
        continue;
      }

      if (skill.length > MAX_REQUIRED_SKILL_LENGTH) {
        throw createShiftError({
          message:
            "Each required skill cannot exceed " + `${MAX_REQUIRED_SKILL_LENGTH} characters.`,
          code: "REQUIRED_SKILL_TOO_LONG",
        });
      }

      const comparisonValue = skill.toLowerCase();

      if (!seenSkills.has(comparisonValue)) {
        seenSkills.add(comparisonValue);

        skills.push(skill);
      }
    }

    if (skills.length > MAX_REQUIRED_SKILLS) {
      throw createShiftError({
        message: "A Shift cannot contain more than " + `${MAX_REQUIRED_SKILLS} required skills.`,
        code: "TOO_MANY_REQUIRED_SKILLS",
      });
    }

    return skills;
  }

  static assertPositiveInteger(value, fieldName) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
      throw createShiftError({
        message: `${fieldName} must be a positive whole number.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return normalizedValue;
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createShiftError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  /* ─────────────────────────────── EMPLOYER / BRANCH ACCESS ─────────────────────────────── */

  static async getEmployerProfileForUser(userId, employerProfile = null) {
    const normalizedUserId = normalizeObjectId({
      value: userId,
      fieldName: "user ID",
      createError: createShiftError,
    });

    if (employerProfile?._id) {
      return employerProfile;
    }

    const profile = await EmployerProfile.findOne({
      user: normalizedUserId,
    }).lean();

    if (!profile) {
      throw createShiftError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return profile;
  }

  static businessCanPostShifts(profile) {
    return Boolean(
      profile?._id &&
      profile.cacVerificationStatus === "verified" &&
      profile.regulatoryVerificationStatus === "verified" &&
      profile.employerApprovalStatus === "approved" &&
      profile.accountStatus === "active"
    );
  }

  static assertBusinessCanPostShifts(profile) {
    if (!profile?._id) {
      throw createShiftError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!ShiftCreationService.businessCanPostShifts(profile)) {
      throw createShiftError({
        message: "The business must be verified and approved before a Shift can be posted.",
        code: "BUSINESS_NOT_ELIGIBLE_TO_POST_SHIFT",
        statusCode: 403,
      });
    }

    return profile;
  }

  static roleCanPostShifts(employerContext = null) {
    if (typeof employerContext?.roleCanPostShifts === "boolean") {
      return employerContext.roleCanPostShifts;
    }

    /*
     * Compatibility fallback for callers that have not yet moved to the
     * separated roleCanPostShifts / canPostShifts context contract.
     */
    return employerContext?.canPostShifts === true;
  }

  static async assertEmployerNotRestrictedFromPosting({ businessId, currentTime, session }) {
    try {
      return await EmployerDelinquencyService.assertCanPostShifts(
        {
          businessId,
          currentTime,
        },
        {
          session,
        }
      );
    } catch (error) {
      if (error.code === "EMPLOYER_NEW_OBLIGATIONS_RESTRICTED") {
        throw createShiftError({
          message: "Please resolve the outstanding Shift payment before posting another Shift.",
          code: "EMPLOYER_NEW_OBLIGATIONS_RESTRICTED",
          statusCode: 403,
          details: error.details || null,
        });
      }

      throw error;
    }
  }

  static canManageAllBranches(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static async getActiveBranch({
    branchId,
    employerProfileId,
    canManageAllBranches = false,
    assignedBranchIds = [],
    session = null,
  }) {
    const normalizedBranchId = normalizeObjectId({
      value: branchId,
      fieldName: "branch ID",
      createError: createShiftError,
    });

    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,
      fieldName: "employer profile ID",
      createError: createShiftError,
    });

    if (!canManageAllBranches) {
      const isAssignedBranch = assignedBranchIds.some(
        (assignedBranchId) => String(assignedBranchId) === String(normalizedBranchId)
      );

      if (!isAssignedBranch) {
        throw createShiftError({
          message: "You do not have permission to post Shifts for the selected branch.",
          code: "BRANCH_SHIFT_POSTING_NOT_ALLOWED",
          statusCode: 403,
        });
      }
    }

    const query = Branch.findOne({
      _id: normalizedBranchId,
      business: normalizedEmployerProfileId,
      isActive: true,
    }).select(["name", "address", "state", "lga", "location", "geofenceRadiusMeters"].join(" "));

    if (session) {
      query.session(session);
    }

    const branch = await query.lean();

    if (!branch) {
      throw createShiftError({
        message: "The selected branch was not found or is not active.",
        code: "ACTIVE_BRANCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!hasValidBranchLocation(branch)) {
      throw createShiftError({
        message: "The selected branch must have a valid location before a Shift can be posted.",
        code: "BRANCH_LOCATION_REQUIRED",
      });
    }

    return branch;
  }

  /* ─────────────────────────────── IDENTITY / ATTENDANCE PINS ─────────────────────────────── */

  static generateAttendancePin() {
    return crypto
      .randomInt(0, ATTENDANCE_PIN_MAX_EXCLUSIVE)
      .toString()
      .padStart(ATTENDANCE_PIN_LENGTH, "0");
  }

  static generateAttendancePins() {
    const checkInPin = ShiftCreationService.generateAttendancePin();

    let checkOutPin = ShiftCreationService.generateAttendancePin();

    while (checkOutPin === checkInPin) {
      checkOutPin = ShiftCreationService.generateAttendancePin();
    }

    return {
      checkInPin,
      checkOutPin,
    };
  }

  static createShiftIdentity() {
    const shiftId = new mongoose.Types.ObjectId();

    return {
      shiftId,

      referenceCode: `LQM-${shiftId.toString().slice(-12).toUpperCase()}`,
    };
  }

  static createOccurrenceIdentity({ referenceCode, sequenceNumber }) {
    return {
      occurrenceId: new mongoose.Types.ObjectId(),

      occurrenceReferenceCode: `${referenceCode}-` + String(sequenceNumber).padStart(2, "0"),
    };
  }

  /* ─────────────────────────────── OCCURRENCE DOCUMENTS ─────────────────────────────── */

  static buildOccurrenceDocuments({
    schedule,
    shiftId,
    referenceCode,
    businessId,
    branchId,
    unfilledFinalizationGraceMinutes,
    createdAt,
  }) {
    const finalizationGraceMinutes = ShiftCreationService.assertPositiveInteger(
      unfilledFinalizationGraceMinutes,
      "unfilledFinalizationGraceMinutes"
    );

    return schedule.occurrenceBlueprints.map((blueprint) => {
      const { occurrenceId, occurrenceReferenceCode } =
        ShiftCreationService.createOccurrenceIdentity({
          referenceCode,

          sequenceNumber: blueprint.sequenceNumber,
        });

      const { checkInPin, checkOutPin } = ShiftCreationService.generateAttendancePins();

      const attendancePinsGeneratedAt = new Date(createdAt);

      const fillCutoffAt = new Date(blueprint.startTime);

      const unfilledFinalizationAt = new Date(
        fillCutoffAt.getTime() + finalizationGraceMinutes * MILLISECONDS_PER_MINUTE
      );

      return {
        _id: occurrenceId,

        shift: shiftId,

        business: businessId,

        branch: branchId,

        referenceCode: occurrenceReferenceCode,

        sequenceNumber: blueprint.sequenceNumber,

        assignmentStatus: "unassigned",

        assignedProfessional: null,

        assignment: null,

        assignedAt: null,

        replacementRequiredAt: null,

        replacementForAssignment: null,

        replacementCase: null,

        replacementReasonCode: null,

        replacementReasonDetails: null,

        occurrenceDate: blueprint.occurrenceDate,

        scheduleTimeZone: blueprint.scheduleTimeZone,

        startTime: blueprint.startTime,

        endTime: blueprint.endTime,

        scheduledMinutes: blueprint.scheduledMinutes,

        scheduledHours: blueprint.scheduledHours,

        breakDuration: blueprint.breakDuration,

        fillCutoffAt,

        unfilledFinalizationAt,

        expiredUnfilledAt: null,

        baseBillableHours: null,

        billableHours: null,

        /*
         * Occurrence-level pricing snapshots.
         *
         * These values are copied from the locked posting calculation and
         * must not later be re-derived from current PlatformSettings.
         */
        hourlyRate: blueprint.hourlyRate,

        platformFeeRate: blueprint.platformFeeRate,

        estimatedProfessionalPay: blueprint.estimatedProfessionalPay,

        estimatedPlatformFee: blueprint.estimatedPlatformFee,

        estimatedEmployerCharge: blueprint.estimatedEmployerCharge,

        topUpRequired: 0,

        refundableAmount: 0,

        refundedAmount: 0,

        refundStatus: "not_eligible",

        refundReason: null,

        refundEligibleAt: null,

        refundedAt: null,

        checkInPin,

        checkOutPin,

        attendancePinsGeneratedAt,

        checkInPinUsedAt: null,

        checkOutPinUsedAt: null,

        status: "scheduled",

        attendanceStatus: "not_started",

        settlementStatus: "not_due",
      };
    });
  }

  static buildInitialOccurrenceProgress(occurrenceCount, createdAt) {
    return {
      unassigned: occurrenceCount,

      assigned: 0,

      replacementRequired: 0,

      expiredUnfilled: 0,

      scheduled: occurrenceCount,

      inProgress: 0,

      pendingSettlement: 0,

      completed: 0,

      cancelled: 0,

      noShow: 0,

      disputed: 0,

      settlementNotDue: occurrenceCount,

      pendingReview: 0,

      awaitingOvertimeReview: 0,

      awaitingTopup: 0,

      approvedForRelease: 0,

      releasePending: 0,

      released: 0,

      failed: 0,

      settlementDisputed: 0,

      refundNotEligible: occurrenceCount,

      refundEligible: 0,

      refundProcessing: 0,

      refunded: 0,

      resolved: 0,

      lastReconciledAt: createdAt,
    };
  }

  static buildShiftPayload({
    shiftId,
    referenceCode,
    profile,
    branch,
    userId,
    pricing,
    platformCurrency,
    department,
    roleTitle,
    professionalType,
    schedule,
    breakDuration,
    hourlyRate,
    cancellationPolicy,
    pricingLockedAt,
    requiredSkills,
    dressCode,
    description,
    occurrenceDocuments,
  }) {
    const shiftPayload = {
      _id: shiftId,

      referenceCode,

      business: profile._id,

      branch: branch._id,

      postedBy: userId,

      countryCode: pricing.countryCode,

      currency: platformCurrency,

      department,

      roleTitle,

      professionalType,

      scheduleMode: schedule.scheduleMode,

      occurrenceCount: schedule.occurrenceCount,

      repeatDays: schedule.repeatDays,

      firstOccurrenceDate: schedule.firstOccurrenceDate,

      lastOccurrenceDate: schedule.lastOccurrenceDate,

      scheduleTimeZone: schedule.scheduleTimeZone,

      dailyStartTimeMinutes: schedule.dailyStartTimeMinutes,

      dailyEndTimeMinutes: schedule.dailyEndTimeMinutes,

      endsNextDay: schedule.endsNextDay,

      scheduledMinutesPerOccurrence: schedule.scheduledMinutesPerOccurrence,

      totalScheduledMinutes: schedule.totalScheduledMinutes,

      startTime: schedule.startTime,

      endTime: schedule.endTime,

      scheduledHours: schedule.scheduledHours,

      breakDuration,

      hourlyRate,

      platformFeeRate: pricing.platformFeeRate,

      /*
       * Parent pricing is locked once, at posting.
       *
       * Parent amounts are posting summaries. Occurrence-level pricing
       * snapshots remain authoritative for later occurrence settlement.
       */
      pricingLockedAt,

      pricingLockedBy: userId,

      cancellationPolicySnapshot: {
        ...cancellationPolicy,

        lockedAt: pricingLockedAt,
      },

      estimatedProfessionalPay: schedule.aggregatePricing.estimatedProfessionalPay,

      estimatedPlatformFee: schedule.aggregatePricing.estimatedPlatformFee,

      estimatedEmployerCharge: schedule.aggregatePricing.estimatedEmployerCharge,

      totalApplications: 0,

      currentRoundApplications: 0,

      applicationRound: 1,

      occurrenceProgress: ShiftCreationService.buildInitialOccurrenceProgress(
        schedule.occurrenceCount,
        pricingLockedAt
      ),

      status: "pending_funding",

      paymentStatus: "unpaid",

      /*
       * Funding is intentionally neutral at creation.
       *
       * The employer chooses exactly one funding source after the Shift has
       * been created. No client-supplied funding state is copied into the
       * Shift, so creation cannot produce mixed wallet/Checkout funding.
       */
      fundingMethod: null,

      fundedAmount: 0,

      fundingInitiatedAt: null,

      fundedAt: null,

      publishedAt: null,

      requiredSkills,

      dressCode,

      description,
    };

    if (schedule.scheduleMode === "single") {
      const singleOccurrence = occurrenceDocuments[0];

      shiftPayload.checkInPin = singleOccurrence.checkInPin;

      shiftPayload.checkOutPin = singleOccurrence.checkOutPin;

      shiftPayload.attendancePinsGeneratedAt = singleOccurrence.attendancePinsGeneratedAt;
    }

    return shiftPayload;
  }

  /* ─────────────────────────────── RESPONSE FORMATTING ─────────────────────────────── */

  static formatAmount(amount, currency) {
    return money.formatMoney(amount ?? 0, currency);
  }

  static formatLocalDate(localDate) {
    if (!localDate) {
      return "-";
    }

    const normalizedDate = ShiftScheduleService.normalizeLocalDate(localDate, "localDate");

    const parsedDate = new Date(`${normalizedDate}T00:00:00Z`);

    return new Intl.DateTimeFormat("en-NG", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(parsedDate);
  }

  static formatTime(date) {
    if (!date) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      timeStyle: "short",

      timeZone: ShiftScheduleService.getTimeZone(),
    }).format(new Date(date));
  }

  static formatScheduledMinutes(value) {
    const totalMinutes = Number(value);

    if (!Number.isSafeInteger(totalMinutes) || totalMinutes <= 0) {
      return "-";
    }

    const wholeHours = Math.floor(totalMinutes / 60);

    const remainingMinutes = totalMinutes % 60;

    if (wholeHours === 0) {
      return `${remainingMinutes} ` + `${remainingMinutes === 1 ? "minute" : "minutes"}`;
    }

    if (remainingMinutes === 0) {
      return `${wholeHours} ` + `${wholeHours === 1 ? "hour" : "hours"}`;
    }

    return (
      `${wholeHours} ` +
      `${wholeHours === 1 ? "hour" : "hours"} ` +
      `${remainingMinutes} ` +
      `${remainingMinutes === 1 ? "minute" : "minutes"}`
    );
  }

  static formatRepeatDays(repeatDays) {
    if (!Array.isArray(repeatDays) || repeatDays.length === 0) {
      return null;
    }

    const selectedDays = new Set(repeatDays.map(Number));

    const weekdayValues = [1, 2, 3, 4, 5];

    const weekendValues = [6, 0];

    const everyDayValues = [1, 2, 3, 4, 5, 6, 0];

    const matchesExactly = (expectedValues) =>
      selectedDays.size === expectedValues.length &&
      expectedValues.every((day) => selectedDays.has(day));

    if (matchesExactly(everyDayValues)) {
      return "Every day";
    }

    if (matchesExactly(weekdayValues)) {
      return "Monday–Friday";
    }

    if (matchesExactly(weekendValues)) {
      return "Saturday–Sunday";
    }

    return ShiftScheduleService.getRepeatDayOptions()
      .filter((option) => selectedDays.has(option.value))
      .map((option) => option.shortLabel)
      .join(", ");
  }

  static buildCreatedScheduleResponse({ schedule, occurrences = [] }) {
    return {
      scheduleMode: schedule.scheduleMode,

      scheduleModeLabel: schedule.scheduleMode === "multiple" ? "Multiple Shifts" : "Single Shift",

      occurrenceCount: schedule.occurrenceCount,

      occurrenceCountLabel:
        `${schedule.occurrenceCount} ` + `${schedule.occurrenceCount === 1 ? "shift" : "shifts"}`,

      repeatDays: schedule.repeatDays,

      repeatDaysLabel: ShiftCreationService.formatRepeatDays(schedule.repeatDays),

      firstOccurrenceDate: schedule.firstOccurrenceDate,

      firstOccurrenceDateDisplay: ShiftCreationService.formatLocalDate(
        schedule.firstOccurrenceDate
      ),

      lastOccurrenceDate: schedule.lastOccurrenceDate,

      lastOccurrenceDateDisplay: ShiftCreationService.formatLocalDate(schedule.lastOccurrenceDate),

      scheduleTimeZone: schedule.scheduleTimeZone,

      dailyStartTimeMinutes: schedule.dailyStartTimeMinutes,

      dailyEndTimeMinutes: schedule.dailyEndTimeMinutes,

      endsNextDay: schedule.endsNextDay,

      scheduledMinutesPerOccurrence: schedule.scheduledMinutesPerOccurrence,

      scheduledHoursPerOccurrence: Number((schedule.scheduledMinutesPerOccurrence / 60).toFixed(4)),

      scheduledHoursPerOccurrenceDisplay: ShiftCreationService.formatScheduledMinutes(
        schedule.scheduledMinutesPerOccurrence
      ),

      totalScheduledMinutes: schedule.totalScheduledMinutes,

      totalScheduledHours: schedule.scheduledHours,

      totalScheduledHoursDisplay: ShiftCreationService.formatScheduledMinutes(
        schedule.totalScheduledMinutes
      ),

      startTime: schedule.startTime,

      endTime: schedule.endTime,

      occurrences: occurrences.map((occurrence) => ({
        id: String(occurrence._id),

        referenceCode: occurrence.referenceCode,

        sequenceNumber: occurrence.sequenceNumber,

        occurrenceDate: occurrence.occurrenceDate,

        occurrenceDateDisplay: ShiftCreationService.formatLocalDate(occurrence.occurrenceDate),

        startTime: occurrence.startTime,

        endTime: occurrence.endTime,

        startTimeDisplay: ShiftCreationService.formatTime(occurrence.startTime),

        endTimeDisplay: ShiftCreationService.formatTime(occurrence.endTime),

        scheduledMinutes: occurrence.scheduledMinutes,

        scheduledHoursDisplay: ShiftCreationService.formatScheduledMinutes(
          occurrence.scheduledMinutes
        ),

        fillCutoffAt: occurrence.fillCutoffAt,

        unfilledFinalizationAt: occurrence.unfilledFinalizationAt,
      })),
    };
  }

  static buildPricingResponse({
    pricing,
    platformCurrency,
    schedule,
    hourlyRate,
    cancellationPolicy,
  }) {
    return {
      countryCode: pricing.countryCode,

      currency: platformCurrency,

      scheduleMode: schedule.scheduleMode,

      occurrenceCount: schedule.occurrenceCount,

      scheduledMinutes: schedule.totalScheduledMinutes,

      scheduledHours: schedule.scheduledHours,

      scheduledMinutesPerOccurrence: schedule.scheduledMinutesPerOccurrence,

      scheduledHoursPerOccurrence: Number((schedule.scheduledMinutesPerOccurrence / 60).toFixed(4)),

      hourlyRate,

      hourlyRateDisplay: ShiftCreationService.formatAmount(hourlyRate, platformCurrency),

      platformFeeRate: pricing.platformFeeRate,

      platformFeePercent: Number((pricing.platformFeeRate * 100).toFixed(2)),

      cancellationPolicy: {
        ...cancellationPolicy,

        lateCancellationProfessionalPayPercent: Number(
          (cancellationPolicy.lateCancellationProfessionalPayRate * 100).toFixed(2)
        ),

        activeWorkCancellationMinimumPayPercent: Number(
          (cancellationPolicy.activeWorkCancellationMinimumPayRate * 100).toFixed(2)
        ),
      },

      perOccurrence: {
        estimatedProfessionalPay: schedule.occurrencePricing.estimatedProfessionalPay,

        estimatedProfessionalPayDisplay: ShiftCreationService.formatAmount(
          schedule.occurrencePricing.estimatedProfessionalPay,
          platformCurrency
        ),

        estimatedPlatformFee: schedule.occurrencePricing.estimatedPlatformFee,

        estimatedPlatformFeeDisplay: ShiftCreationService.formatAmount(
          schedule.occurrencePricing.estimatedPlatformFee,
          platformCurrency
        ),

        estimatedEmployerCharge: schedule.occurrencePricing.estimatedEmployerCharge,

        estimatedEmployerChargeDisplay: ShiftCreationService.formatAmount(
          schedule.occurrencePricing.estimatedEmployerCharge,
          platformCurrency
        ),
      },

      estimatedProfessionalPay: schedule.aggregatePricing.estimatedProfessionalPay,

      estimatedProfessionalPayDisplay: ShiftCreationService.formatAmount(
        schedule.aggregatePricing.estimatedProfessionalPay,
        platformCurrency
      ),

      estimatedPlatformFee: schedule.aggregatePricing.estimatedPlatformFee,

      estimatedPlatformFeeDisplay: ShiftCreationService.formatAmount(
        schedule.aggregatePricing.estimatedPlatformFee,
        platformCurrency
      ),

      estimatedEmployerCharge: schedule.aggregatePricing.estimatedEmployerCharge,

      estimatedEmployerChargeDisplay: ShiftCreationService.formatAmount(
        schedule.aggregatePricing.estimatedEmployerCharge,
        platformCurrency
      ),
    };
  }

  /* ─────────────────────────────── CREATE SHIFT / ENGAGEMENT ─────────────────────────────── */

  static async createShift({
    userId,
    employerProfile = null,
    employerContext = null,
    shiftData,
    currentTime = new Date(),
    session = null,
  }) {
    if (!shiftData || typeof shiftData !== "object" || Array.isArray(shiftData)) {
      throw createShiftError({
        message: "Shift details are required.",
        code: "SHIFT_DATA_REQUIRED",
      });
    }

    const normalizedCurrentTime = ShiftCreationService.normalizeCurrentTime(currentTime);

    const normalizedUserId = normalizeObjectId({
      value: userId,
      fieldName: "user ID",
      createError: createShiftError,
    });

    const profile = await ShiftCreationService.getEmployerProfileForUser(
      normalizedUserId,
      employerProfile
    );

    /*
     * Check role authority separately from delinquency.
     *
     * employerContext.canPostShifts may be false because the business is
     * temporarily restricted. That is not the same as the user's employer
     * role lacking permission.
     */
    if (!ShiftCreationService.roleCanPostShifts(employerContext)) {
      throw createShiftError({
        message: "You do not have permission to post Shifts.",
        code: "SHIFT_POSTING_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    /*
     * Early business eligibility check for fast failure.
     *
     * This is repeated inside the transaction before persistence.
     */
    ShiftCreationService.assertBusinessCanPostShifts(profile);

    const assignedBranchIds = (employerContext?.assignedBranchIds || [])
      .filter((branchId) => mongoose.isValidObjectId(branchId))
      .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));

    const branch = await ShiftCreationService.getActiveBranch({
      branchId: shiftData.branchId,

      employerProfileId: profile._id,

      canManageAllBranches: ShiftCreationService.canManageAllBranches(employerContext),

      assignedBranchIds,

      session,
    });

    const shiftPostingSettings = await PlatformSettingsService.getShiftPostingSettings(
      profile.countryCode
    );

    const { pricing, attendance } = shiftPostingSettings;

    if (!pricing || typeof pricing !== "object") {
      throw createShiftError({
        message: "The active Shift pricing settings could not be resolved.",
        code: "SHIFT_PRICING_SETTINGS_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    const cancellationPolicy = ShiftPricingService.normalizeCancellationPolicy(
      shiftPostingSettings.cancellationPolicy ||
        shiftPostingSettings.shiftCancellationPolicy ||
        shiftPostingSettings.cancellation
    );

    const unfilledFinalizationGraceMinutes = ShiftCreationService.assertPositiveInteger(
      attendance?.unfilledFinalizationGraceMinutes,
      "unfilledFinalizationGraceMinutes"
    );

    const employerCurrency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    const platformCurrency = String(pricing.currency || "")
      .trim()
      .toUpperCase();

    if (!employerCurrency || !platformCurrency) {
      throw createShiftError({
        message: "A valid Shift currency could not be resolved.",
        code: "SHIFT_CURRENCY_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    if (employerCurrency !== platformCurrency) {
      throw createShiftError({
        message: "The employer currency does not match the active platform currency.",
        code: "EMPLOYER_CURRENCY_MISMATCH",
        statusCode: 500,
      });
    }

    const scheduleMode = ShiftScheduleService.normalizeScheduleMode(shiftData.scheduleMode);

    ShiftScheduleService.normalizeOccurrenceCount(shiftData.occurrenceCount, scheduleMode);

    ShiftScheduleService.normalizeRepeatDays(shiftData.repeatDays, scheduleMode);

    const breakDuration = ShiftScheduleService.parseBreakDuration(shiftData.breakDuration);

    const hourlyRate = ShiftPricingService.normalizeHourlyRateToMinorUnit(shiftData.hourlyRate);

    const roleTitle = ShiftCreationService.normalizeRequiredText(
      shiftData.roleTitle,
      "roleTitle",
      MAX_ROLE_TITLE_LENGTH
    );

    const professionalType = ShiftCreationService.normalizeProfessionalType(
      shiftData.professionalType
    );

    const department = ShiftCreationService.normalizeOptionalText(
      shiftData.department,
      "department",
      MAX_DEPARTMENT_LENGTH
    );

    const requiredSkills = ShiftCreationService.normalizeRequiredSkills(shiftData.requiredSkills);

    const dressCode = ShiftCreationService.normalizeOptionalText(
      shiftData.dressCode,
      "dressCode",
      MAX_DRESS_CODE_LENGTH
    );

    const description = ShiftCreationService.normalizeOptionalText(
      shiftData.description,
      "description",
      MAX_SHIFT_DESCRIPTION_LENGTH
    );

    const schedule = ShiftScheduleService.buildSchedule({
      scheduleMode,

      shiftData,

      hourlyRate,

      platformFeeRate: pricing.platformFeeRate,

      breakDuration,

      currentTime: normalizedCurrentTime,
    });

    const { shiftId, referenceCode } = ShiftCreationService.createShiftIdentity();

    /*
     * One timestamp locks all posting-time pricing/audit snapshots.
     */
    const pricingLockedAt = new Date(normalizedCurrentTime.getTime());

    const occurrenceDocuments = ShiftCreationService.buildOccurrenceDocuments({
      schedule,

      shiftId,

      referenceCode,

      businessId: profile._id,

      branchId: branch._id,

      unfilledFinalizationGraceMinutes,

      createdAt: pricingLockedAt,
    });

    const shiftPayload = ShiftCreationService.buildShiftPayload({
      shiftId,

      referenceCode,

      profile,

      branch,

      userId: normalizedUserId,

      pricing,

      platformCurrency,

      department,

      roleTitle,

      professionalType,

      schedule,

      breakDuration,

      hourlyRate,

      cancellationPolicy,

      pricingLockedAt,

      requiredSkills,

      dressCode,

      description,

      occurrenceDocuments,
    });

    const creationResult = await runWithOptionalTransaction(
      {
        session,
      },

      async (transactionSession) => {
        /*
         * FINAL CREATION GATE
         *
         * Middleware/context is useful for UI and early rejection, but it is
         * not authoritative enough to protect Shift creation.
         *
         * Re-read the business and re-evaluate delinquency inside the same
         * transaction immediately before creating the new obligation.
         */
        const currentProfile = await EmployerProfile.findById(profile._id).session(
          transactionSession
        );

        ShiftCreationService.assertBusinessCanPostShifts(currentProfile);

        await ShiftCreationService.assertEmployerNotRestrictedFromPosting({
          businessId: currentProfile._id,
          currentTime: normalizedCurrentTime,
          session: transactionSession,
        });

        /*
         * Wallet creation is infrastructure preparation only.
         *
         * It does not select the Shift funding source and does not move
         * money. The Shift remains pending_funding after this transaction.
         */
        const employerWallet = await WalletService.createEmployerWalletIfMissing(currentProfile, {
          session: transactionSession,
        });

        const shift = new Shift(shiftPayload);

        await shift.save({
          session: transactionSession,
        });

        const occurrences = await ShiftOccurrence.insertMany(occurrenceDocuments, {
          session: transactionSession,

          ordered: true,
        });

        return {
          employerWallet,
          shift,
          occurrences,
        };
      }
    );

    const scheduleResponse = ShiftCreationService.buildCreatedScheduleResponse({
      schedule,

      occurrences: creationResult.occurrences,
    });

    const pricingResponse = ShiftCreationService.buildPricingResponse({
      pricing,

      platformCurrency,

      schedule,

      hourlyRate,

      cancellationPolicy,
    });

    logger.info(
      `Pending-funding ${schedule.scheduleMode} Shift ` +
        `${referenceCode} with ` +
        `${schedule.occurrenceCount} occurrence(s) ` +
        `created by user ${normalizedUserId} ` +
        `for employer ${profile._id}`
    );

    return {
      shift: ShiftCreationService.sanitizeCreatedShift(creationResult.shift),

      occurrences: creationResult.occurrences.map((occurrence) =>
        ShiftCreationService.sanitizeCreatedOccurrence(occurrence)
      ),

      employerWallet: creationResult.employerWallet,

      nextStep: "payment",

      schedule: scheduleResponse,

      pricing: pricingResponse,
    };
  }

  /* ─────────────────────────────── SANITIZATION ─────────────────────────────── */

  static sanitizeCreatedShift(shift) {
    const shiftObject =
      typeof shift?.toObject === "function"
        ? shift.toObject()
        : {
            ...shift,
          };

    delete shiftObject.checkInPin;
    delete shiftObject.checkOutPin;

    return shiftObject;
  }

  static sanitizeCreatedOccurrence(occurrence) {
    const occurrenceObject =
      typeof occurrence?.toObject === "function"
        ? occurrence.toObject()
        : {
            ...occurrence,
          };

    delete occurrenceObject.checkInPin;
    delete occurrenceObject.checkOutPin;

    return occurrenceObject;
  }
}

module.exports = ShiftCreationService;
