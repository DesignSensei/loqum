// services/shiftAttendanceService.js

const crypto = require("crypto");
const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const Branch = require("../models/Branch");

const PlatformSettingsService = require("./platformSettingsService");
const ShiftOccurrenceClaimService = require("./shiftOccurrenceClaimService");
const ShiftOccurrenceReconciliationService = require("./shiftOccurrenceReconciliationService");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const logger = require("../utils/logger");

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const EARTH_RADIUS_METERS = 6371000;
const MAX_LOCATION_AGE_MINUTES = 5;
const MAX_PROCESSING_BATCH_SIZE = 100;

const MAX_ABSENCE_EXPLANATION_LENGTH = 1000;
const MAX_OVERTIME_REQUEST_MINUTES = 24 * 60;

const ATTENDANCE_LOCATION_SOURCES = ["browser", "mobile_app"];

const LATE_CHECKOUT_OPTIONS = ["normal_late_checkout", "overtime_requested"];

const LATE_CHECKOUT_REASONS = ["forgot_to_checkout", "handover_delay", "system_issue", "other"];

const CHECKOUT_FALLBACK_REASONS = [
  "professional_forgot",
  "system_timeout",
  "outside_geofence",
  "gps_accuracy_too_low",
  "location_permission_denied",
  "employer_confirmed",
  "admin_override",
  "other",
];

const PAYMENT_STATUSES_WITHOUT_ACTIVE_PROTECTED_FUNDS = [
  "unpaid",
  "failed",
  "released",
  "refunded",
];

const PARENT_ATTENDANCE_STATUSES = [
  "confirmed",
  "in_progress",

  /*
   * An earlier occurrence may place the parent in one of these aggregate
   * states while a later occurrence is still legitimately scheduled.
   */
  "disputed",
  "pending_settlement",
];

const EMPLOYER_PIN_PARENT_STATUSES = [
  "assigned",
  "confirmed",
  "in_progress",
  "disputed",
  "pending_settlement",
];

const EMPLOYER_PIN_OCCURRENCE_STATUSES = ["scheduled", "in_progress"];

const EMPLOYER_PIN_ATTENDANCE_STATUSES = ["not_started", "checked_in"];

const TERMINAL_PARENT_ATTENDANCE_STATUSES = ["completed", "cancelled", "no_show"];

/**
 * SHIFT ATTENDANCE ARCHITECTURE
 *
 * ShiftOccurrence is authoritative for every actual work date.
 *
 * This includes a Single Shift. A Single Shift has one occurrence with
 * sequenceNumber 1.
 *
 * This service owns attendance facts:
 *
 * - employer PIN access;
 * - professional check-in;
 * - professional checkout;
 * - attendance geofence evidence;
 * - late-checkout choice;
 * - provisional overtime request creation;
 * - checkout fallback request;
 * - no-show recording; and
 * - absence explanation.
 *
 * It does NOT own:
 *
 * - base professional-pay calculation;
 * - final overtime entitlement;
 * - platform-fee earning;
 * - overtime top-up obligation;
 * - professional payout release;
 * - employer refund execution; or
 * - parent occurrence-truth creation.
 *
 * BASE PLATFORM FEE
 *
 * A completely assigned occurrence has already passed through
 * ShiftAssignmentService → ShiftPlatformFeeService.
 *
 * Attendance therefore never clears, recalculates or reverses:
 *
 * - basePlatformFee; or
 * - basePlatformFeeAudit.
 *
 * A later no-show sets professional base entitlement to zero while preserving
 * the already-earned base platform fee.
 *
 * OVERTIME
 *
 * Late checkout with "Yes, worked overtime" creates only a provisional
 * overtime request.
 *
 * While overtime.status is pending:
 *
 * - overtimeProfessionalPay = 0;
 * - overtimePlatformFee = 0;
 * - topUpRequired = 0;
 * - no top-up deadline exists; and
 * - no overtime platform fee is earned.
 *
 * The service may derive a provisional preview for the response/UI from the
 * requested hours, snapshotted hourlyRate and snapshotted platformFeeRate.
 * That preview is not written into authoritative occurrence money fields.
 *
 * Employer acceptance or final admin adjudication later establishes the final
 * OT professional entitlement. The fee authority then earns Loqum's fee from
 * that final amount and only then does an employer top-up become due.
 *
 * CLAIM / DISPUTE ELIGIBILITY
 *
 * Attendance transitions do not themselves create a Claim or Dispute.
 *
 * A recorded no-show is a contestable factual outcome, so this service asks
 * ShiftOccurrenceClaimService to establish the occurrence's one shared
 * challenge opportunity. The Claim service owns challenge-window timing.
 *
 * PARENT SHIFT
 *
 * Parent aggregate-state reconciliation is delegated to
 * ShiftOccurrenceReconciliationService. It does not create occurrence
 * attendance or financial truth.
 *
 * This service retains only the Single-Shift attendance compatibility mirror
 * until the later parent Shift compatibility pass removes or confirms it.
 */

class ShiftAttendanceService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftAttendanceServiceError";
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

      throw ShiftAttendanceService.createError({
        message: `${fieldName} is required.`,
        code: `${ShiftAttendanceService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw ShiftAttendanceService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${ShiftAttendanceService.normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw ShiftAttendanceService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizePin(value, fieldName) {
    const pin = String(value ?? "").trim();

    if (!/^\d{4}$/.test(pin)) {
      throw ShiftAttendanceService.createError({
        message: `${fieldName} must contain exactly 4 digits.`,
        code: `INVALID_${ShiftAttendanceService.normalizeFieldCode(fieldName)}`,
      });
    }

    return pin;
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    const normalizedValue = String(value ?? "").trim();

    if (!normalizedValue) {
      return null;
    }

    if (normalizedValue.length > maximumLength) {
      throw ShiftAttendanceService.createError({
        message: `${fieldName} cannot exceed ${maximumLength} characters.`,
        code: `${ShiftAttendanceService.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return normalizedValue;
  }

  static normalizeAbsenceExplanation(value) {
    const explanation = String(value || "").trim();

    if (!explanation) {
      throw ShiftAttendanceService.createError({
        message: "Absence explanation is required.",
        code: "ABSENCE_EXPLANATION_REQUIRED",
      });
    }

    if (explanation.length > MAX_ABSENCE_EXPLANATION_LENGTH) {
      throw ShiftAttendanceService.createError({
        message:
          `Absence explanation cannot exceed ` + `${MAX_ABSENCE_EXPLANATION_LENGTH} characters.`,

        code: "ABSENCE_EXPLANATION_TOO_LONG",
      });
    }

    return explanation;
  }

  static normalizeLocationSource(value) {
    const source = String(value || "browser")
      .trim()
      .toLowerCase();

    if (!ATTENDANCE_LOCATION_SOURCES.includes(source)) {
      throw ShiftAttendanceService.createError({
        message: "Attendance location source is invalid.",
        code: "INVALID_ATTENDANCE_LOCATION_SOURCE",
      });
    }

    return source;
  }

  static normalizeCoordinate(value, fieldName, minimum, maximum) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw ShiftAttendanceService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${ShiftAttendanceService.normalizeFieldCode(fieldName)}`,
      });
    }

    return number;
  }

  static normalizeAccuracy(value) {
    const accuracyMeters = Number(value);

    if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
      throw ShiftAttendanceService.createError({
        message: "Location accuracy is invalid.",
        code: "INVALID_LOCATION_ACCURACY",
      });
    }

    return accuracyMeters;
  }

  static normalizeCapturedAt(value, currentTime) {
    if (!value) {
      return currentTime;
    }

    const capturedAt = new Date(value);

    if (Number.isNaN(capturedAt.getTime())) {
      throw ShiftAttendanceService.createError({
        message: "Location capture time is invalid.",
        code: "INVALID_LOCATION_CAPTURE_TIME",
      });
    }

    const ageMilliseconds = currentTime.getTime() - capturedAt.getTime();

    if (ageMilliseconds < -MILLISECONDS_PER_MINUTE) {
      throw ShiftAttendanceService.createError({
        message: "Location capture time cannot be in the future.",
        code: "LOCATION_CAPTURE_TIME_IN_FUTURE",
      });
    }

    if (ageMilliseconds > MAX_LOCATION_AGE_MINUTES * MILLISECONDS_PER_MINUTE) {
      throw ShiftAttendanceService.createError({
        message: "Your location is stale. Refresh your location and try again.",
        code: "ATTENDANCE_LOCATION_STALE",
        statusCode: 409,
      });
    }

    return capturedAt;
  }

  static normalizeAttendanceLocationInput(location, currentTime = new Date()) {
    if (!location || typeof location !== "object") {
      throw ShiftAttendanceService.createError({
        message: "Your current location is required.",
        code: "ATTENDANCE_LOCATION_REQUIRED",
      });
    }

    return {
      latitude: ShiftAttendanceService.normalizeCoordinate(location.latitude, "latitude", -90, 90),

      longitude: ShiftAttendanceService.normalizeCoordinate(
        location.longitude,
        "longitude",
        -180,
        180
      ),

      accuracyMeters: ShiftAttendanceService.normalizeAccuracy(location.accuracyMeters),

      capturedAt: ShiftAttendanceService.normalizeCapturedAt(location.capturedAt, currentTime),

      locationSource: ShiftAttendanceService.normalizeLocationSource(location.locationSource),
    };
  }

  /* ─────────────────────────────── SETTINGS ─────────────────────────────── */

  static async getAttendanceSettings() {
    const attendance = await PlatformSettingsService.getAttendanceSettings();

    const settings = {
      checkInWindowBeforeMinutes: Number(attendance.checkInWindowBeforeMinutes ?? 30),

      noShowGraceMinutes: Number(attendance.noShowGraceMinutes ?? 30),

      unfilledFinalizationGraceMinutes: Number(attendance.unfilledFinalizationGraceMinutes ?? 15),

      defaultGeofenceRadiusMeters: Number(
        attendance.defaultGeofenceRadiusMeters ?? attendance.defaultGeofenceMeters ?? 100
      ),

      minimumGeofenceRadiusMeters: Number(
        attendance.minimumGeofenceRadiusMeters ?? attendance.minGeofenceMeters ?? 20
      ),

      maximumGeofenceRadiusMeters: Number(
        attendance.maximumGeofenceRadiusMeters ?? attendance.maxGeofenceMeters ?? 1000
      ),

      maximumLocationAccuracyMeters: Number(attendance.maximumLocationAccuracyMeters ?? 100),

      overtimeResponseHours: Number(attendance.overtimeResponseHours ?? 24),
    };

    const nonNegativeIntegerFields = [
      "checkInWindowBeforeMinutes",
      "noShowGraceMinutes",
      "unfilledFinalizationGraceMinutes",
      "defaultGeofenceRadiusMeters",
      "minimumGeofenceRadiusMeters",
      "maximumGeofenceRadiusMeters",
      "maximumLocationAccuracyMeters",
    ];

    for (const fieldName of nonNegativeIntegerFields) {
      if (!Number.isSafeInteger(settings[fieldName]) || settings[fieldName] < 0) {
        throw ShiftAttendanceService.createError({
          message: `Attendance setting ${fieldName} is invalid.`,

          code: "INVALID_ATTENDANCE_SETTINGS",

          statusCode: 500,
        });
      }
    }

    if (
      !Number.isSafeInteger(settings.overtimeResponseHours) ||
      settings.overtimeResponseHours <= 0
    ) {
      throw ShiftAttendanceService.createError({
        message: "Attendance setting overtimeResponseHours must be a positive whole number.",

        code: "INVALID_ATTENDANCE_SETTINGS",

        statusCode: 500,
      });
    }

    if (settings.minimumGeofenceRadiusMeters > settings.maximumGeofenceRadiusMeters) {
      throw ShiftAttendanceService.createError({
        message: "Attendance geofence settings are inconsistent.",

        code: "INVALID_ATTENDANCE_SETTINGS",

        statusCode: 500,
      });
    }

    if (
      settings.defaultGeofenceRadiusMeters < settings.minimumGeofenceRadiusMeters ||
      settings.defaultGeofenceRadiusMeters > settings.maximumGeofenceRadiusMeters
    ) {
      throw ShiftAttendanceService.createError({
        message: "The default attendance geofence radius is outside the configured range.",

        code: "INVALID_ATTENDANCE_SETTINGS",

        statusCode: 500,
      });
    }

    return settings;
  }

  /* ─────────────────────────────── LOADERS / AUTHORIZATION ─────────────────────────────── */

  static getShiftFields() {
    return [
      "referenceCode",
      "business",
      "branch",
      "countryCode",
      "currency",
      "scheduleMode",
      "occurrenceCount",
      "status",
      "paymentStatus",
      "fundedAmount",
      "estimatedEmployerCharge",
      "fundedAt",
      "publishedAt",
      "fundingTransaction",
      "cancellationCode",
      "activeAssignment",
      "assignedProfessional",
      "replacementHiring",
      "occurrenceProgress",
      "attendanceStatus",
      "checkedInAt",
      "checkedOutAt",
      "checkInPinUsedAt",
      "checkOutPinUsedAt",
    ].join(" ");
  }

  static getOccurrenceFields(pinField = null) {
    const fields = [
      "shift",
      "business",
      "branch",
      "referenceCode",
      "sequenceNumber",
      "occurrenceDate",
      "scheduleTimeZone",

      "assignmentStatus",
      "assignedProfessional",
      "assignment",
      "assignedAt",

      "startTime",
      "endTime",
      "scheduledMinutes",
      "scheduledHours",
      "breakDuration",

      "hourlyRate",
      "platformFeeRate",

      "estimatedProfessionalPay",
      "estimatedPlatformFee",
      "estimatedEmployerCharge",

      "baseBillableHours",
      "billableHours",
      "baseProfessionalPay",
      "basePlatformFee",
      "basePlatformFeeAudit",
      "baseSettlement",

      "overtimeProfessionalPay",
      "overtimePlatformFee",
      "overtimePlatformFeeAudit",
      "overtimeSettlement",

      "topUpRequired",
      "topUpTransaction",

      "status",
      "attendanceStatus",
      "settlementStatus",

      "reviewStartedAt",
      "reviewDeadlineAt",

      "checkedInAt",
      "checkedOutAt",

      "checkInLocation",
      "checkOutLocation",

      "attendancePinsGeneratedAt",
      "checkInPinUsedAt",
      "checkOutPinUsedAt",

      "lateCheckout",
      "checkoutFallback",
      "earlyTermination",
      "overtime",

      "challengeWindowOpenedAt",
      "challengeDeadlineAt",
      "challengeWindowClosedAt",

      "activeClaim",
      "activeDispute",

      "absenceExplanation",
      "absenceExplainedAt",
    ];

    if (pinField) {
      fields.push(`+${pinField}`);
    }

    return fields.join(" ");
  }

  static async getShift(shiftId, session = null) {
    const normalizedShiftId = ShiftAttendanceService.normalizeObjectId(shiftId, "shift ID");

    const query = Shift.findById(normalizedShiftId).select(ShiftAttendanceService.getShiftFields());

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftAttendanceService.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async resolveOccurrence({ shift, occurrenceId = null, pinField = null, session = null }) {
    const filter = {
      shift: shift._id,
    };

    if (occurrenceId) {
      filter._id = ShiftAttendanceService.normalizeObjectId(occurrenceId, "occurrence ID");
    } else {
      if (shift.scheduleMode !== "single" && Number(shift.occurrenceCount || 0) !== 1) {
        throw ShiftAttendanceService.createError({
          message: "Select the work occurrence you want to access.",
          code: "SHIFT_OCCURRENCE_REQUIRED",
          statusCode: 409,
        });
      }

      filter.sequenceNumber = 1;
    }

    const query = ShiftOccurrence.findOne(filter).select(
      ShiftAttendanceService.getOccurrenceFields(pinField)
    );

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftAttendanceService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static assertEmployerCanManageOccurrence({
    shift,
    occurrence,
    employerProfileId,
    employerContext = null,
  }) {
    const normalizedEmployerProfileId = ShiftAttendanceService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    if (
      String(shift.business) !== String(normalizedEmployerProfileId) ||
      String(occurrence.business) !== String(normalizedEmployerProfileId)
    ) {
      throw ShiftAttendanceService.createError({
        message: "This occurrence is not available to your business.",
        code: "SHIFT_OCCURRENCE_NOT_AVAILABLE",
        statusCode: 404,
      });
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    if (!canManageAllBranches && !isBranchManager) {
      throw ShiftAttendanceService.createError({
        message: "You do not have permission to access attendance for this occurrence.",
        code: "ATTENDANCE_ACCESS_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    if (!canManageAllBranches) {
      const assignedBranchIds = (employerContext?.assignedBranchIds || []).map(String);

      if (!assignedBranchIds.includes(String(occurrence.branch))) {
        throw ShiftAttendanceService.createError({
          message: "You do not have permission to access attendance for this branch.",
          code: "BRANCH_ATTENDANCE_ACCESS_NOT_ALLOWED",
          statusCode: 403,
        });
      }
    }

    return true;
  }

  static async getEmployerOccurrenceContext({
    shiftId,
    occurrenceId = null,
    employerProfileId,
    employerContext = null,
    pinField = null,
    session = null,
  }) {
    const shift = await ShiftAttendanceService.getShift(shiftId, session);

    const occurrence = await ShiftAttendanceService.resolveOccurrence({
      shift,
      occurrenceId,
      pinField,
      session,
    });

    ShiftAttendanceService.assertEmployerCanManageOccurrence({
      shift,
      occurrence,
      employerProfileId,
      employerContext,
    });

    return {
      shift,
      occurrence,
    };
  }

  static async getProfessionalOccurrenceContext({
    shiftId,
    occurrenceId = null,
    professionalProfileId,
    pinField = null,
    session = null,
  }) {
    const normalizedProfessionalProfileId = ShiftAttendanceService.normalizeObjectId(
      professionalProfileId,
      "professional profile ID"
    );

    const shift = await ShiftAttendanceService.getShift(shiftId, session);

    const occurrence = await ShiftAttendanceService.resolveOccurrence({
      shift,
      occurrenceId,
      pinField,
      session,
    });

    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignedProfessional ||
      String(occurrence.assignedProfessional) !== String(normalizedProfessionalProfileId)
    ) {
      throw ShiftAttendanceService.createError({
        message: "You are not assigned to this occurrence.",
        code: "PROFESSIONAL_NOT_ASSIGNED_TO_OCCURRENCE",
        statusCode: 403,
      });
    }

    return {
      shift,
      occurrence,
      professionalProfileId: normalizedProfessionalProfileId,
    };
  }

  static async getBranch(branchId, session = null) {
    const query = Branch.findById(branchId).select(
      "business name location geofenceRadiusMeters isActive"
    );

    if (session) {
      query.session(session);
    }

    const branch = await query;

    if (!branch) {
      throw ShiftAttendanceService.createError({
        message: "The assigned branch was not found.",
        code: "ATTENDANCE_BRANCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    return branch;
  }

  /* ─────────────────────────────── STATE ASSERTIONS ─────────────────────────────── */

  static assertProtectedFundingActive(shift) {
    if (
      !shift ||
      shift.status === "pending_funding" ||
      TERMINAL_PARENT_ATTENDANCE_STATUSES.includes(shift.status) ||
      PAYMENT_STATUSES_WITHOUT_ACTIVE_PROTECTED_FUNDS.includes(shift.paymentStatus)
    ) {
      throw ShiftAttendanceService.createError({
        message: "Protected funding is not active for this occurrence.",
        code: "PROTECTED_SHIFT_FUNDS_NOT_ACTIVE",
        statusCode: 409,
      });
    }

    return shift;
  }

  static assertParentAttendanceState(shift) {
    if (!PARENT_ATTENDANCE_STATUSES.includes(shift.status)) {
      throw ShiftAttendanceService.createError({
        message: "Attendance is not available in the current Shift state.",
        code: "SHIFT_ATTENDANCE_NOT_AVAILABLE",
        statusCode: 409,
        details: {
          shiftStatus: shift.status,
        },
      });
    }

    return shift;
  }

  static assertCompleteAssignment(occurrence) {
    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignedProfessional ||
      !occurrence.assignment ||
      !occurrence.assignedAt
    ) {
      throw ShiftAttendanceService.createError({
        message: "This occurrence does not have a complete professional assignment.",
        code: "OCCURRENCE_ASSIGNMENT_INCOMPLETE",
        statusCode: 409,
      });
    }

    return occurrence;
  }

  static assertEmployerPinAccess({ shift, occurrence }) {
    ShiftAttendanceService.assertProtectedFundingActive(shift);

    ShiftAttendanceService.assertCompleteAssignment(occurrence);

    if (!EMPLOYER_PIN_PARENT_STATUSES.includes(shift.status)) {
      throw ShiftAttendanceService.createError({
        message: "Attendance PINs are not available in the current Shift state.",
        code: "ATTENDANCE_PINS_NOT_AVAILABLE",
        statusCode: 403,
        details: {
          shiftStatus: shift.status,
        },
      });
    }

    if (
      !EMPLOYER_PIN_OCCURRENCE_STATUSES.includes(occurrence.status) ||
      !EMPLOYER_PIN_ATTENDANCE_STATUSES.includes(occurrence.attendanceStatus) ||
      occurrence.checkedOutAt ||
      occurrence.earlyTermination?.occurred
    ) {
      throw ShiftAttendanceService.createError({
        message: "Attendance PINs are not available in the current occurrence state.",
        code: "ATTENDANCE_PINS_NOT_AVAILABLE",
        statusCode: 403,
        details: {
          occurrenceStatus: occurrence.status,
          attendanceStatus: occurrence.attendanceStatus,
        },
      });
    }

    return occurrence;
  }

  static assertCanRevealCheckInPin({ shift, occurrence }) {
    return ShiftAttendanceService.assertEmployerPinAccess({
      shift,
      occurrence,
    });
  }

  static assertCanRevealCheckOutPin({ shift, occurrence }) {
    return ShiftAttendanceService.assertEmployerPinAccess({
      shift,
      occurrence,
    });
  }

  static assertCanCheckIn({ occurrence, settings, currentTime }) {
    ShiftAttendanceService.assertCompleteAssignment(occurrence);

    if (
      occurrence.status !== "scheduled" ||
      occurrence.attendanceStatus !== "not_started" ||
      occurrence.checkedInAt ||
      occurrence.checkInPinUsedAt
    ) {
      throw ShiftAttendanceService.createError({
        message: "This occurrence is not available for check-in.",
        code: "OCCURRENCE_CHECK_IN_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    const checkInOpensAt = new Date(
      new Date(occurrence.startTime).getTime() -
        settings.checkInWindowBeforeMinutes * MILLISECONDS_PER_MINUTE
    );

    if (currentTime < checkInOpensAt) {
      throw ShiftAttendanceService.createError({
        message: "The check-in window is not open yet.",
        code: "CHECK_IN_WINDOW_NOT_OPEN",
        statusCode: 409,
        details: {
          checkInOpensAt,
        },
      });
    }

    if (currentTime >= new Date(occurrence.endTime)) {
      throw ShiftAttendanceService.createError({
        message: "The occurrence has ended and can no longer be checked into.",
        code: "OCCURRENCE_CHECK_IN_WINDOW_CLOSED",
        statusCode: 409,
      });
    }

    return {
      checkInOpensAt,
    };
  }

  static assertCanCheckOut(occurrence) {
    ShiftAttendanceService.assertCompleteAssignment(occurrence);

    if (
      occurrence.status !== "in_progress" ||
      occurrence.attendanceStatus !== "checked_in" ||
      !occurrence.checkedInAt ||
      occurrence.checkedOutAt ||
      occurrence.checkOutPinUsedAt ||
      occurrence.earlyTermination?.occurred
    ) {
      throw ShiftAttendanceService.createError({
        message: "This occurrence is not available for checkout.",
        code: "OCCURRENCE_CHECK_OUT_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    return occurrence;
  }

  /* ─────────────────────────────── FINANCIAL BOUNDARY ASSERTIONS ─────────────────────────────── */

  static normalizeMoneyAmount(value, fieldName) {
    const amount = Number(value || 0);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw ShiftAttendanceService.createError({
        message: `${fieldName} must be a non-negative whole-number minor-unit amount.`,
        code: `INVALID_${ShiftAttendanceService.normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return amount;
  }

  static assertBasePlatformFeeEstablished(occurrence) {
    const estimatedPlatformFee = ShiftAttendanceService.normalizeMoneyAmount(
      occurrence.estimatedPlatformFee,
      "estimated platform fee"
    );

    const basePlatformFee = ShiftAttendanceService.normalizeMoneyAmount(
      occurrence.basePlatformFee,
      "base platform fee"
    );

    const audit = occurrence.basePlatformFeeAudit || {};

    if (estimatedPlatformFee === 0) {
      if (basePlatformFee !== 0) {
        throw ShiftAttendanceService.createError({
          message:
            "The occurrence contains a base platform fee even though its pricing snapshot has no fee.",
          code: "BASE_PLATFORM_FEE_PRICING_MISMATCH",
          statusCode: 500,
        });
      }

      return true;
    }

    if (basePlatformFee !== estimatedPlatformFee) {
      throw ShiftAttendanceService.createError({
        message: "The occurrence base platform fee does not match its confirmed pricing snapshot.",
        code: "BASE_PLATFORM_FEE_PRICING_MISMATCH",
        statusCode: 500,
      });
    }

    if (
      !audit.earnedAt ||
      !audit.collectedAt ||
      !audit.collectionTransaction ||
      audit.outstandingAt
    ) {
      throw ShiftAttendanceService.createError({
        message:
          "The assigned occurrence does not contain a complete earned base platform-fee audit.",
        code: "BASE_PLATFORM_FEE_AUDIT_INCOMPLETE",
        statusCode: 500,
      });
    }

    return true;
  }

  static assertNoPriorOvertimeFinancialState(occurrence) {
    const overtime = occurrence.overtime || {};
    const audit = occurrence.overtimePlatformFeeAudit || {};

    const hasAuthoritativeOvertimeMoney =
      ShiftAttendanceService.normalizeMoneyAmount(
        occurrence.overtimeProfessionalPay,
        "overtime professional pay"
      ) > 0 ||
      ShiftAttendanceService.normalizeMoneyAmount(
        occurrence.overtimePlatformFee,
        "overtime platform fee"
      ) > 0 ||
      ShiftAttendanceService.normalizeMoneyAmount(
        occurrence.topUpRequired,
        "overtime top-up required"
      ) > 0;

    const hasFundingOrFeeAudit = Boolean(
      occurrence.topUpTransaction ||
      overtime.topUpPaid ||
      overtime.topUpPaidAt ||
      Number(overtime.topUpAmount || 0) > 0 ||
      overtime.topUpDeadlineAt ||
      audit.earnedAt ||
      audit.outstandingAt ||
      audit.collectedAt ||
      audit.collectionTransaction
    );

    if (hasAuthoritativeOvertimeMoney || hasFundingOrFeeAudit) {
      throw ShiftAttendanceService.createError({
        message:
          "The occurrence contains overtime financial state before attendance checkout has established a new overtime request.",
        code: "PREEXISTING_OVERTIME_FINANCIAL_STATE",
        statusCode: 409,
      });
    }

    return true;
  }

  static buildProvisionalOvertimePreview({ occurrence, requestedMinutes }) {
    const hourlyRate = Number(occurrence.hourlyRate);
    const platformFeeRate = Number(occurrence.platformFeeRate);

    if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) {
      throw ShiftAttendanceService.createError({
        message: "The occurrence hourly rate is invalid.",
        code: "INVALID_OCCURRENCE_HOURLY_RATE",
        statusCode: 500,
      });
    }

    if (!Number.isFinite(platformFeeRate) || platformFeeRate < 0 || platformFeeRate > 1) {
      throw ShiftAttendanceService.createError({
        message: "The occurrence platform fee rate is invalid.",
        code: "INVALID_OCCURRENCE_PLATFORM_FEE_RATE",
        statusCode: 500,
      });
    }

    if (
      !Number.isSafeInteger(requestedMinutes) ||
      requestedMinutes <= 0 ||
      requestedMinutes > MAX_OVERTIME_REQUEST_MINUTES
    ) {
      throw ShiftAttendanceService.createError({
        message: "Requested overtime minutes are invalid.",
        code: "INVALID_REQUESTED_OVERTIME_MINUTES",
        statusCode: 500,
      });
    }

    const requestedHours = requestedMinutes / 60;

    const provisionalProfessionalPay = Math.round(hourlyRate * requestedHours);

    const provisionalPlatformFee = Math.round(provisionalProfessionalPay * platformFeeRate);

    const provisionalEmployerCharge = provisionalProfessionalPay + provisionalPlatformFee;

    if (
      !Number.isSafeInteger(provisionalProfessionalPay) ||
      provisionalProfessionalPay <= 0 ||
      !Number.isSafeInteger(provisionalPlatformFee) ||
      provisionalPlatformFee < 0 ||
      !Number.isSafeInteger(provisionalEmployerCharge) ||
      provisionalEmployerCharge <= 0
    ) {
      throw ShiftAttendanceService.createError({
        message: "The provisional overtime pricing could not be calculated safely.",
        code: "INVALID_PROVISIONAL_OVERTIME_PRICING",
        statusCode: 500,
      });
    }

    return {
      provisional: true,

      requestedMinutes,

      requestedHours: Number(requestedHours.toFixed(4)),

      professionalPay: provisionalProfessionalPay,

      platformFee: provisionalPlatformFee,

      employerCharge: provisionalEmployerCharge,

      platformFeeRate,
    };
  }

  /* ─────────────────────────────── PIN COMPARISON ─────────────────────────────── */

  static pinsMatch(providedPin, storedPin) {
    const left = Buffer.from(String(providedPin));

    const right = Buffer.from(String(storedPin || ""));

    if (left.length !== right.length) {
      return false;
    }

    return crypto.timingSafeEqual(left, right);
  }

  static assertPinMatches({ providedPin, storedPin, type }) {
    if (!ShiftAttendanceService.pinsMatch(providedPin, storedPin)) {
      throw ShiftAttendanceService.createError({
        message: `The ${type} PIN is incorrect.`,
        code: `INVALID_${ShiftAttendanceService.normalizeFieldCode(type)}_PIN`,
        statusCode: 403,
      });
    }
  }

  /* ─────────────────────────────── GEOFENCE ─────────────────────────────── */

  static toRadians(value) {
    return (Number(value) * Math.PI) / 180;
  }

  static calculateDistanceMeters({ latitudeA, longitudeA, latitudeB, longitudeB }) {
    const latitudeDifference = ShiftAttendanceService.toRadians(latitudeB - latitudeA);

    const longitudeDifference = ShiftAttendanceService.toRadians(longitudeB - longitudeA);

    const firstLatitude = ShiftAttendanceService.toRadians(latitudeA);

    const secondLatitude = ShiftAttendanceService.toRadians(latitudeB);

    const haversine =
      Math.sin(latitudeDifference / 2) ** 2 +
      Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDifference / 2) ** 2;

    const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

    return EARTH_RADIUS_METERS * angularDistance;
  }

  static getBranchCoordinates(branch) {
    const coordinates = branch?.location?.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length !== 2) {
      throw ShiftAttendanceService.createError({
        message: "The branch does not have a valid attendance location.",
        code: "BRANCH_LOCATION_MISSING",
        statusCode: 409,
      });
    }

    const longitude = ShiftAttendanceService.normalizeCoordinate(
      coordinates[0],
      "branch longitude",
      -180,
      180
    );

    const latitude = ShiftAttendanceService.normalizeCoordinate(
      coordinates[1],
      "branch latitude",
      -90,
      90
    );

    return {
      latitude,
      longitude,
    };
  }

  static resolveGeofenceRadius(branch, settings) {
    const configuredRadius = Number(
      branch.geofenceRadiusMeters ?? settings.defaultGeofenceRadiusMeters
    );

    if (!Number.isSafeInteger(configuredRadius) || configuredRadius <= 0) {
      throw ShiftAttendanceService.createError({
        message: "The branch geofence radius is invalid.",
        code: "INVALID_BRANCH_GEOFENCE_RADIUS",
        statusCode: 500,
      });
    }

    return Math.min(
      Math.max(configuredRadius, settings.minimumGeofenceRadiusMeters),
      settings.maximumGeofenceRadiusMeters
    );
  }

  static buildAttendanceLocationSnapshot({ location, branch, settings }) {
    const branchCoordinates = ShiftAttendanceService.getBranchCoordinates(branch);

    const geofenceRadiusMeters = ShiftAttendanceService.resolveGeofenceRadius(branch, settings);

    const distanceFromBranchMeters = ShiftAttendanceService.calculateDistanceMeters({
      latitudeA: location.latitude,
      longitudeA: location.longitude,
      latitudeB: branchCoordinates.latitude,
      longitudeB: branchCoordinates.longitude,
    });

    const roundedDistance = Number(distanceFromBranchMeters.toFixed(2));

    const accuracyIsAcceptable = location.accuracyMeters <= settings.maximumLocationAccuracyMeters;

    const withinGeofence = accuracyIsAcceptable && roundedDistance <= geofenceRadiusMeters;

    let failureReason = null;

    if (!accuracyIsAcceptable) {
      failureReason = "gps_accuracy_too_low";
    } else if (!withinGeofence) {
      failureReason = "outside_geofence";
    }

    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracyMeters: location.accuracyMeters,
      capturedAt: location.capturedAt,
      branchLatitude: branchCoordinates.latitude,
      branchLongitude: branchCoordinates.longitude,
      geofenceRadiusMeters,
      distanceFromBranchMeters: roundedDistance,
      withinGeofence,
      locationSource: location.locationSource,
      failureReason,
    };
  }

  static assertAttendanceLocationAccepted(snapshot) {
    if (snapshot.failureReason === "gps_accuracy_too_low") {
      throw ShiftAttendanceService.createError({
        message: "Your location accuracy is too low. Move to an open area and try again.",
        code: "GPS_ACCURACY_TOO_LOW",
        statusCode: 409,
        details: {
          attendanceLocation: snapshot,
        },
      });
    }

    if (!snapshot.withinGeofence) {
      throw ShiftAttendanceService.createError({
        message: "You must be within the branch attendance area to continue.",
        code: "OUTSIDE_BRANCH_GEOFENCE",
        statusCode: 409,
        details: {
          attendanceLocation: snapshot,
        },
      });
    }

    return snapshot;
  }

  /* ─────────────────────────────── NO-SHOW TIMING ─────────────────────────────── */

  static calculateNoShowDeadline({ occurrence, noShowGraceMinutes }) {
    ShiftAttendanceService.assertCompleteAssignment(occurrence);

    const startTime = new Date(occurrence.startTime);

    const assignedAt = new Date(occurrence.assignedAt);

    const endTime = new Date(occurrence.endTime);

    const anchorTime = new Date(Math.max(startTime.getTime(), assignedAt.getTime()));

    const calculatedDeadline = new Date(
      anchorTime.getTime() + noShowGraceMinutes * MILLISECONDS_PER_MINUTE
    );

    return {
      anchorTime,

      noShowDeadline: new Date(Math.min(calculatedDeadline.getTime(), endTime.getTime())),
    };
  }

  /* ─────────────────────────────── EMPLOYER PIN ACCESS ─────────────────────────────── */

  static async getEmployerCheckInPin({
    shiftId,
    occurrenceId = null,
    employerProfileId,
    employerContext = null,
  }) {
    const { shift, occurrence } = await ShiftAttendanceService.getEmployerOccurrenceContext({
      shiftId,
      occurrenceId,
      employerProfileId,
      employerContext,
      pinField: "checkInPin",
    });

    ShiftAttendanceService.assertCanRevealCheckInPin({
      shift,
      occurrence,
    });

    logger.info(
      `Check-in PIN accessed for occurrence ${occurrence._id} by employer ${employerProfileId}`
    );

    return {
      shiftId: String(shift._id),

      occurrenceId: String(occurrence._id),

      occurrenceReferenceCode: occurrence.referenceCode,

      sequenceNumber: occurrence.sequenceNumber,

      type: "check_in",

      timeRestricted: false,

      pin: occurrence.checkInPin,

      occurrenceStartTime: occurrence.startTime,

      occurrenceEndTime: occurrence.endTime,

      assignedAt: occurrence.assignedAt,
    };
  }

  static async getEmployerCheckOutPin({
    shiftId,
    occurrenceId = null,
    employerProfileId,
    employerContext = null,
  }) {
    const { shift, occurrence } = await ShiftAttendanceService.getEmployerOccurrenceContext({
      shiftId,
      occurrenceId,
      employerProfileId,
      employerContext,
      pinField: "checkOutPin",
    });

    ShiftAttendanceService.assertCanRevealCheckOutPin({
      shift,
      occurrence,
    });

    logger.info(
      `Check-out PIN accessed for occurrence ${occurrence._id} by employer ${employerProfileId}`
    );

    return {
      shiftId: String(shift._id),

      occurrenceId: String(occurrence._id),

      occurrenceReferenceCode: occurrence.referenceCode,

      sequenceNumber: occurrence.sequenceNumber,

      type: "check_out",

      timeRestricted: false,

      pin: occurrence.checkOutPin,

      checkedInAt: occurrence.checkedInAt,

      occurrenceStartTime: occurrence.startTime,

      occurrenceEndTime: occurrence.endTime,

      assignedAt: occurrence.assignedAt,
    };
  }

  static async getCheckInPin(args) {
    return ShiftAttendanceService.getEmployerCheckInPin(args);
  }

  static async getCheckOutPin(args) {
    return ShiftAttendanceService.getEmployerCheckOutPin(args);
  }

  /* ─────────────────────────────── PARENT SUMMARY RECONCILIATION ─────────────────────────────── */

  static async reconcileParentShift({ shift, occurrence, currentTime, session }) {
    const parentResult = await ShiftOccurrenceReconciliationService.reconcileParentShift({
      shift,

      currentTime,

      session,
    });

    /*
     * Single-Shift attendance compatibility mirror.
     *
     * The occurrence remains authoritative. These parent fields exist only for
     * callers/views that still read attendance directly from Shift.
     *
     * Parent aggregate-state reconciliation has already happened above.
     */
    if (shift.scheduleMode === "single" || Number(shift.occurrenceCount || 0) === 1) {
      const compatibilityUpdate = {
        attendanceStatus: occurrence.attendanceStatus,

        checkedInAt: occurrence.checkedInAt || null,

        checkedOutAt: occurrence.checkedOutAt || null,

        checkInLocation: occurrence.checkInLocation || {},

        checkOutLocation: occurrence.checkOutLocation || {},

        checkInPinUsedAt: occurrence.checkInPinUsedAt || null,

        checkOutPinUsedAt: occurrence.checkOutPinUsedAt || null,
      };

      await Shift.updateOne(
        {
          _id: shift._id,
        },
        {
          $set: compatibilityUpdate,
        },
        {
          session,
          runValidators: true,
        }
      );

      if (parentResult?.shift) {
        Object.assign(parentResult.shift, compatibilityUpdate);
      }
    }

    return parentResult;
  }

  /* ─────────────────────────────── PROFESSIONAL CHECK-IN ─────────────────────────────── */

  static async checkIn(
    {
      shiftId,
      occurrenceId = null,
      professionalProfileId,
      pin,
      location,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = ShiftAttendanceService.normalizeCurrentTime(currentTime);

    return ShiftAttendanceService.runWithOptionalTransaction(options, async (session) => {
      const normalizedPin = ShiftAttendanceService.normalizePin(pin, "check-in PIN");

      const {
        shift,
        occurrence,
        professionalProfileId: normalizedProfessionalProfileId,
      } = await ShiftAttendanceService.getProfessionalOccurrenceContext({
        shiftId,
        occurrenceId,
        professionalProfileId,
        pinField: "checkInPin",
        session,
      });

      ShiftAttendanceService.assertProtectedFundingActive(shift);

      ShiftAttendanceService.assertParentAttendanceState(shift);

      ShiftAttendanceService.assertBasePlatformFeeEstablished(occurrence);

      const settings = await ShiftAttendanceService.getAttendanceSettings();

      ShiftAttendanceService.assertCanCheckIn({
        occurrence,
        settings,
        currentTime: normalizedCurrentTime,
      });

      ShiftAttendanceService.assertPinMatches({
        providedPin: normalizedPin,
        storedPin: occurrence.checkInPin,
        type: "check-in",
      });

      const normalizedLocation = ShiftAttendanceService.normalizeAttendanceLocationInput(
        location,
        normalizedCurrentTime
      );

      const branch = await ShiftAttendanceService.getBranch(occurrence.branch, session);

      const locationSnapshot = ShiftAttendanceService.buildAttendanceLocationSnapshot({
        location: normalizedLocation,
        branch,
        settings,
      });

      ShiftAttendanceService.assertAttendanceLocationAccepted(locationSnapshot);

      occurrence.status = "in_progress";
      occurrence.attendanceStatus = "checked_in";
      occurrence.checkedInAt = normalizedCurrentTime;
      occurrence.checkInPinUsedAt = normalizedCurrentTime;
      occurrence.checkInLocation = locationSnapshot;

      await occurrence.save({
        session,
      });

      const parentSummary = await ShiftAttendanceService.reconcileParentShift({
        shift,
        occurrence,
        currentTime: normalizedCurrentTime,
        session,
      });

      logger.info(
        `Professional ${normalizedProfessionalProfileId} checked in to occurrence ${occurrence._id}`
      );

      return {
        shiftId: String(shift._id),

        occurrenceId: String(occurrence._id),

        occurrenceReferenceCode: occurrence.referenceCode,

        professionalProfileId: String(normalizedProfessionalProfileId),

        checkedInAt: occurrence.checkedInAt,

        attendanceStatus: occurrence.attendanceStatus,

        occurrenceStatus: occurrence.status,

        checkInLocation: occurrence.checkInLocation,

        noShowTiming: ShiftAttendanceService.calculateNoShowDeadline({
          occurrence,

          noShowGraceMinutes: settings.noShowGraceMinutes,
        }),

        parentSummary,

        events: [
          {
            type: "shift_occurrence_checked_in",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(normalizedProfessionalProfileId),

            checkedInAt: occurrence.checkedInAt,
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── PROFESSIONAL CHECKOUT ─────────────────────────────── */

  static normalizeLateCheckoutOption(value) {
    if (value === null || value === undefined || value === "") {
      return "normal_late_checkout";
    }

    const normalized = String(value).trim().toLowerCase();

    if (!LATE_CHECKOUT_OPTIONS.includes(normalized)) {
      throw ShiftAttendanceService.createError({
        message: "Late checkout option is invalid.",
        code: "INVALID_LATE_CHECKOUT_OPTION",
      });
    }

    return normalized;
  }

  static normalizeLateCheckoutReason(value, required) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();

    if (!normalized) {
      if (required) {
        throw ShiftAttendanceService.createError({
          message: "Late checkout reason is required.",
          code: "LATE_CHECKOUT_REASON_REQUIRED",
        });
      }

      return null;
    }

    if (!LATE_CHECKOUT_REASONS.includes(normalized)) {
      throw ShiftAttendanceService.createError({
        message: "Late checkout reason is invalid.",
        code: "INVALID_LATE_CHECKOUT_REASON",
      });
    }

    return normalized;
  }

  static normalizeRequestedOvertimeHours(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const hours = Number(value);

    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      throw ShiftAttendanceService.createError({
        message: "Requested overtime hours must be greater than zero and no more than 24 hours.",
        code: "INVALID_REQUESTED_OVERTIME_HOURS",
      });
    }

    return Number(hours.toFixed(4));
  }

  static assertRequestedOvertimeHoursMatchesObservedMinutes(value, observedMinutes) {
    const legacyRequestedHours = ShiftAttendanceService.normalizeRequestedOvertimeHours(value);

    if (legacyRequestedHours === null) {
      return null;
    }

    const rawLegacyMinutes = legacyRequestedHours * 60;

    /*
     * requestedOvertimeHours is retained only as a compatibility input.
     *
     * Because callers may serialize hours to four decimal places, allow only
     * the tiny representation drift created by that conversion. The
     * authoritative persisted request remains the exact observed whole-minute
     * late-checkout duration.
     */
    const representationToleranceMinutes = 0.01;

    if (Math.abs(rawLegacyMinutes - observedMinutes) > representationToleranceMinutes) {
      throw ShiftAttendanceService.createError({
        message:
          "Late-checkout overtime uses the full recorded time after the scheduled end. Requested overtime hours must match the recorded late-checkout duration.",
        code: "REQUESTED_OVERTIME_MUST_MATCH_OBSERVED_TIME",
        statusCode: 409,
        details: {
          requestedOvertimeHours: legacyRequestedHours,
          requestedOvertimeMinutes: Number(rawLegacyMinutes.toFixed(4)),
          observedOvertimeMinutes: observedMinutes,
        },
      });
    }

    return legacyRequestedHours;
  }

  static async checkOut(
    {
      shiftId,
      occurrenceId = null,
      professionalProfileId,
      professionalUserId = null,
      pin,
      location,
      lateCheckoutOption = null,
      lateCheckoutReason = null,
      lateCheckoutNotes = null,
      requestedOvertimeHours = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = ShiftAttendanceService.normalizeCurrentTime(currentTime);

    return ShiftAttendanceService.runWithOptionalTransaction(options, async (session) => {
      const normalizedPin = ShiftAttendanceService.normalizePin(pin, "check-out PIN");

      const {
        shift,
        occurrence,
        professionalProfileId: normalizedProfessionalProfileId,
      } = await ShiftAttendanceService.getProfessionalOccurrenceContext({
        shiftId,

        occurrenceId,

        professionalProfileId,

        pinField: "checkOutPin",

        session,
      });

      ShiftAttendanceService.assertProtectedFundingActive(shift);

      ShiftAttendanceService.assertParentAttendanceState(shift);

      ShiftAttendanceService.assertBasePlatformFeeEstablished(occurrence);

      ShiftAttendanceService.assertCanCheckOut(occurrence);

      ShiftAttendanceService.assertNoPriorOvertimeFinancialState(occurrence);

      ShiftAttendanceService.assertPinMatches({
        providedPin: normalizedPin,

        storedPin: occurrence.checkOutPin,

        type: "check-out",
      });

      const settings = await ShiftAttendanceService.getAttendanceSettings();

      const normalizedLocation = ShiftAttendanceService.normalizeAttendanceLocationInput(
        location,

        normalizedCurrentTime
      );

      const branch = await ShiftAttendanceService.getBranch(occurrence.branch, session);

      const locationSnapshot = ShiftAttendanceService.buildAttendanceLocationSnapshot({
        location: normalizedLocation,

        branch,

        settings,
      });

      ShiftAttendanceService.assertAttendanceLocationAccepted(locationSnapshot);

      const checkedInAt = new Date(occurrence.checkedInAt);

      const workedMilliseconds = normalizedCurrentTime.getTime() - checkedInAt.getTime();

      if (workedMilliseconds < 0) {
        throw ShiftAttendanceService.createError({
          message: "Checkout time cannot be earlier than check-in time.",

          code: "INVALID_CHECKOUT_TIME",

          statusCode: 409,
        });
      }

      /*
       * Raw observed attendance duration.
       *
       * This is audit/UI information only. ShiftSettlementService later
       * determines authoritative payable base time.
       */
      const workedMinutes = Math.max(
        0,

        Math.round(workedMilliseconds / MILLISECONDS_PER_MINUTE)
      );

      const workedHours = Number((workedMinutes / 60).toFixed(4));

      const occurrenceEndTime = new Date(occurrence.endTime);

      if (Number.isNaN(occurrenceEndTime.getTime())) {
        throw ShiftAttendanceService.createError({
          message: "The occurrence end time is invalid.",

          code: "INVALID_OCCURRENCE_END_TIME",

          statusCode: 500,
        });
      }

      const overtimeMilliseconds = normalizedCurrentTime.getTime() - occurrenceEndTime.getTime();

      const isLateCheckout = overtimeMilliseconds > 0;

      const minutesLate = isLateCheckout
        ? Math.max(1, Math.ceil(overtimeMilliseconds / MILLISECONDS_PER_MINUTE))
        : 0;

      let selectedOption = null;
      let selectedReason = null;
      let lateCheckoutNotesValue = null;
      let overtimeRequested = false;

      if (isLateCheckout) {
        selectedOption = ShiftAttendanceService.normalizeLateCheckoutOption(lateCheckoutOption);

        overtimeRequested = selectedOption === "overtime_requested";

        /*
         * The non-overtime late-checkout reason belongs only to
         * normal_late_checkout. Worked overtime is represented by the
         * dedicated overtime request below.
         */
        selectedReason = overtimeRequested
          ? null
          : ShiftAttendanceService.normalizeLateCheckoutReason(lateCheckoutReason, true);

        lateCheckoutNotesValue = ShiftAttendanceService.normalizeOptionalText(
          lateCheckoutNotes,
          "Late checkout notes",
          300
        );

        if (selectedReason === "other" && !lateCheckoutNotesValue) {
          throw ShiftAttendanceService.createError({
            message: "Explain the late checkout when the reason is other.",
            code: "LATE_CHECKOUT_OTHER_REASON_NOTES_REQUIRED",
          });
        }
      }

      if (
        !overtimeRequested &&
        requestedOvertimeHours !== null &&
        requestedOvertimeHours !== undefined &&
        requestedOvertimeHours !== ""
      ) {
        throw ShiftAttendanceService.createError({
          message: "Requested overtime hours may only be supplied when overtime is selected.",

          code: "OVERTIME_HOURS_WITHOUT_OVERTIME_REQUEST",
        });
      }

      if (overtimeRequested) {
        if (!professionalUserId) {
          throw ShiftAttendanceService.createError({
            message: "Professional user ID is required when requesting overtime.",

            code: "PROFESSIONAL_USER_ID_REQUIRED",
          });
        }

        if (minutesLate > MAX_OVERTIME_REQUEST_MINUTES) {
          throw ShiftAttendanceService.createError({
            message: "Late-checkout overtime cannot exceed 24 hours.",
            code: "REQUESTED_OVERTIME_EXCEEDS_MAXIMUM",
            statusCode: 409,
            details: {
              observedOvertimeMinutes: minutesLate,
              maximumOvertimeMinutes: MAX_OVERTIME_REQUEST_MINUTES,
            },
          });
        }

        /*
         * Compatibility input only.
         *
         * The current occurrence authority stores immutable requestedMinutes,
         * and a late-checkout request must use the complete observed
         * late-checkout duration. Older callers may still send
         * requestedOvertimeHours; accept it only when it describes the same
         * observed duration.
         */
        ShiftAttendanceService.assertRequestedOvertimeHoursMatchesObservedMinutes(
          requestedOvertimeHours,
          minutesLate
        );
      }

      occurrence.status = "pending_settlement";

      occurrence.attendanceStatus = "checked_out";

      /*
       * Attendance only records whether an OT determination is now pending.
       *
       * It does not prepare settlement components or establish a top-up.
       */
      occurrence.settlementStatus = overtimeRequested ? "awaiting_overtime_review" : "not_due";

      occurrence.checkedOutAt = normalizedCurrentTime;

      occurrence.checkOutPinUsedAt = normalizedCurrentTime;

      occurrence.checkOutLocation = locationSnapshot;

      occurrence.reviewStartedAt = null;
      occurrence.reviewDeadlineAt = null;

      occurrence.lateCheckout = {
        occurred: isLateCheckout,

        minutesLate,

        selectedOption,

        reason: selectedReason,

        notes: lateCheckoutNotesValue,

        recordedAt: isLateCheckout ? normalizedCurrentTime : null,
      };

      let overtimePreview = null;

      if (overtimeRequested) {
        const normalizedProfessionalUserId = ShiftAttendanceService.normalizeObjectId(
          professionalUserId,

          "professional user ID"
        );

        const requestedMinutes = minutesLate;

        overtimePreview = ShiftAttendanceService.buildProvisionalOvertimePreview({
          occurrence,

          requestedMinutes,
        });

        occurrence.overtime = {
          requested: true,

          requestedBy: normalizedProfessionalUserId,

          requestedAt: normalizedCurrentTime,

          source: "late_checkout_prompt",

          reason: lateCheckoutNotesValue || "Professional requested overtime after late checkout.",

          requestedMinutes,

          status: "pending",

          decisionSource: null,

          employerResponseDeadlineAt: new Date(
            normalizedCurrentTime.getTime() +
              settings.overtimeResponseHours * 60 * MILLISECONDS_PER_MINUTE
          ),

          employerRespondedAt: null,

          employerResponseOverdueAt: null,

          approvedAt: null,

          approvedBy: null,

          rejectedAt: null,

          rejectedBy: null,

          rejectionReason: null,

          appealStatus: "not_available",

          appealDeadlineAt: null,

          appealedAt: null,

          appealedBy: null,

          appealReason: null,

          adminDecision: null,

          adminDecidedAt: null,

          adminDecidedBy: null,

          adminDecisionReason: null,
        };

        /*
         * Do not write authoritative OT money, fee audit or top-up state here.
         *
         * assertNoPriorOvertimeFinancialState() already guarantees that those
         * authorities are clean before checkout. Their later creation belongs
         * to final OT approval/funding services, not attendance.
         */
      }

      /*
       * IMPORTANT:
       *
       * Do not modify baseProfessionalPay/basePlatformFee here. The base fee
       * was already earned at assignment and attendance
       * does not own final payable base pricing.
       *
       * Do not create final OT money here either. The request above is
       * provisional only.
       */
      await occurrence.save({
        session,
      });

      const parentSummary = await ShiftAttendanceService.reconcileParentShift({
        shift,

        occurrence,

        currentTime: normalizedCurrentTime,

        session,
      });

      logger.info(
        `Professional ${normalizedProfessionalProfileId} checked out of occurrence ${occurrence._id}`
      );

      return {
        shiftId: String(shift._id),

        occurrenceId: String(occurrence._id),

        occurrenceReferenceCode: occurrence.referenceCode,

        professionalProfileId: String(normalizedProfessionalProfileId),

        checkedInAt: occurrence.checkedInAt,

        checkedOutAt: occurrence.checkedOutAt,

        /*
         * Observed attendance duration, not final payable hours.
         */
        workedMinutes,

        workedHours,

        attendanceStatus: occurrence.attendanceStatus,

        occurrenceStatus: occurrence.status,

        settlementStatus: occurrence.settlementStatus,

        checkOutLocation: occurrence.checkOutLocation,

        lateCheckout: occurrence.lateCheckout,

        overtime: occurrence.overtime,

        /*
         * Display-only preview.
         *
         * None of these values are authoritative money on the occurrence.
         */
        overtimePreview,

        parentSummary,

        events: [
          {
            type: "shift_occurrence_checked_out",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(normalizedProfessionalProfileId),

            checkedOutAt: occurrence.checkedOutAt,

            workedMinutes,
          },

          ...(overtimeRequested
            ? [
                {
                  type: "shift_occurrence_overtime_requested",

                  shiftId: String(shift._id),

                  occurrenceId: String(occurrence._id),

                  professionalId: String(normalizedProfessionalProfileId),

                  requestedMinutes: occurrence.overtime.requestedMinutes,

                  requestedHours: overtimePreview.requestedHours,

                  employerResponseDeadlineAt: occurrence.overtime.employerResponseDeadlineAt,

                  provisionalProfessionalPay: overtimePreview.professionalPay,

                  provisionalPlatformFee: overtimePreview.platformFee,

                  provisionalEmployerCharge: overtimePreview.employerCharge,
                },
              ]
            : []),
        ],
      };
    });
  }

  /* ─────────────────────────────── CHECKOUT FALLBACK ─────────────────────────────── */

  static normalizeCheckoutFallbackReason(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();

    if (!CHECKOUT_FALLBACK_REASONS.includes(normalized)) {
      throw ShiftAttendanceService.createError({
        message: "Checkout fallback reason is invalid.",
        code: "INVALID_CHECKOUT_FALLBACK_REASON",
      });
    }

    return normalized;
  }

  static async requestCheckoutFallback(
    {
      shiftId,
      occurrenceId = null,
      professionalProfileId,
      reason,
      notes = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = ShiftAttendanceService.normalizeCurrentTime(currentTime);

    return ShiftAttendanceService.runWithOptionalTransaction(options, async (session) => {
      const { shift, occurrence } = await ShiftAttendanceService.getProfessionalOccurrenceContext({
        shiftId,

        occurrenceId,

        professionalProfileId,

        session,
      });

      ShiftAttendanceService.assertProtectedFundingActive(shift);

      ShiftAttendanceService.assertParentAttendanceState(shift);

      ShiftAttendanceService.assertBasePlatformFeeEstablished(occurrence);

      ShiftAttendanceService.assertCanCheckOut(occurrence);

      ShiftAttendanceService.assertNoPriorOvertimeFinancialState(occurrence);

      occurrence.status = "pending_settlement";

      occurrence.attendanceStatus = "checkout_fallback_review";

      /*
       * Attendance facts have not yet been resolved, so professional
       * settlement review must not start.
       */
      occurrence.settlementStatus = "not_due";

      occurrence.reviewStartedAt = null;

      occurrence.reviewDeadlineAt = null;

      occurrence.checkoutFallback = {
        required: true,

        reason: ShiftAttendanceService.normalizeCheckoutFallbackReason(reason),

        requestedAt: normalizedCurrentTime,

        resolvedAt: null,

        resolvedBy: null,

        approvedEndTime: null,

        notes: ShiftAttendanceService.normalizeOptionalText(notes, "Checkout fallback notes", 300),
      };

      await occurrence.save({
        session,
      });

      const parentSummary = await ShiftAttendanceService.reconcileParentShift({
        shift,

        occurrence,

        currentTime: normalizedCurrentTime,

        session,
      });

      return {
        shiftId: String(shift._id),

        occurrenceId: String(occurrence._id),

        attendanceStatus: occurrence.attendanceStatus,

        settlementStatus: occurrence.settlementStatus,

        checkoutFallback: occurrence.checkoutFallback,

        parentSummary,

        events: [
          {
            type: "shift_occurrence_checkout_fallback_requested",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(professionalProfileId),
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── NO-SHOW REVIEW ─────────────────────────────── */

  static async markNoShow({ shiftId, occurrenceId, currentTime = new Date() }, options = {}) {
    const normalizedCurrentTime = ShiftAttendanceService.normalizeCurrentTime(currentTime);

    return ShiftAttendanceService.runWithOptionalTransaction(options, async (session) => {
      const shift = await ShiftAttendanceService.getShift(shiftId, session);

      const occurrence = await ShiftAttendanceService.resolveOccurrence({
        shift,

        occurrenceId,

        session,
      });

      ShiftAttendanceService.assertProtectedFundingActive(shift);

      ShiftAttendanceService.assertParentAttendanceState(shift);

      ShiftAttendanceService.assertCompleteAssignment(occurrence);

      if (
        occurrence.status !== "scheduled" ||
        occurrence.attendanceStatus !== "not_started" ||
        occurrence.checkedInAt ||
        occurrence.checkInPinUsedAt
      ) {
        return {
          shift,

          occurrence,

          marked: false,

          idempotent: true,
        };
      }

      /*
       * Assignment confirmation already earned the base fee for this
       * occurrence. A no-show may remove professional entitlement but may
       * not silently un-earn Loqum's confirmed-engagement fee.
       */
      ShiftAttendanceService.assertBasePlatformFeeEstablished(occurrence);

      /*
       * A genuine no-show cannot have overtime or top-up activity because
       * the professional never checked in.
       */
      ShiftAttendanceService.assertNoPriorOvertimeFinancialState(occurrence);

      if (occurrence.overtime?.requested === true || occurrence.overtime?.status) {
        throw ShiftAttendanceService.createError({
          message: "A no-show occurrence cannot contain overtime activity.",

          code: "NO_SHOW_OVERTIME_CONFLICT",

          statusCode: 409,
        });
      }

      const baseSettlementStatus = occurrence.baseSettlement?.status || "not_due";

      const overtimeSettlementStatus = occurrence.overtimeSettlement?.status || "not_due";

      if (baseSettlementStatus !== "not_due" || overtimeSettlementStatus !== "not_due") {
        throw ShiftAttendanceService.createError({
          message:
            "A scheduled no-show candidate cannot already contain payable professional settlement state.",

          code: "NO_SHOW_SETTLEMENT_STATE_CONFLICT",

          statusCode: 409,

          details: {
            baseSettlementStatus,

            overtimeSettlementStatus,
          },
        });
      }

      const settings = await ShiftAttendanceService.getAttendanceSettings();

      const noShowTiming = ShiftAttendanceService.calculateNoShowDeadline({
        occurrence,

        noShowGraceMinutes: settings.noShowGraceMinutes,
      });

      if (normalizedCurrentTime < noShowTiming.noShowDeadline) {
        throw ShiftAttendanceService.createError({
          message: "The no-show review deadline has not passed.",

          code: "NO_SHOW_DEADLINE_NOT_REACHED",

          statusCode: 409,

          details: noShowTiming,
        });
      }

      occurrence.status = "no_show";

      occurrence.attendanceStatus = "no_show";

      occurrence.settlementStatus = "not_due";

      occurrence.reviewStartedAt = null;
      occurrence.reviewDeadlineAt = null;

      occurrence.baseBillableHours = 0;
      occurrence.billableHours = 0;

      /*
       * No professional base pay is earned.
       *
       * Preserve basePlatformFee and basePlatformFeeAudit exactly as they
       * were established at assignment.
       */
      occurrence.baseProfessionalPay = 0;

      /*
       * Do not write OT financial or top-up state for a no-show.
       *
       * assertNoPriorOvertimeFinancialState() already proved that no such
       * authority exists, and attendance does not own those fields.
       */

      /*
       * No explanation exists unless the professional later chooses to
       * provide one.
       */
      occurrence.absenceExplanation = null;
      occurrence.absenceExplainedAt = null;

      /*
       * The recorded no-show is a contestable factual outcome.
       *
       * This opens the occurrence's one shared challenge opportunity. It
       * does not create a Claim and it does not require an explanation.
       */
      const challengeEligibility =
        await ShiftOccurrenceClaimService.establishOccurrenceClaimEligibility({
          occurrence,

          openedAt: normalizedCurrentTime,

          components: ["base"],

          session,
        });

      await occurrence.save({
        session,
      });

      const parentSummary = await ShiftAttendanceService.reconcileParentShift({
        shift,

        occurrence,

        currentTime: normalizedCurrentTime,

        session,
      });

      logger.info(`Occurrence ${occurrence._id} recorded as no-show`);

      return {
        shift,

        occurrence,

        marked: true,

        idempotent: false,

        noShowTiming,

        challengeEligibility,

        parentSummary,

        events: [
          {
            type: "shift_occurrence_no_show_recorded",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(occurrence.assignedProfessional),

            challengeDeadlineAt: occurrence.challengeDeadlineAt,
          },
        ],
      };
    });
  }

  static async submitAbsenceExplanation(
    {
      shiftId,
      occurrenceId = null,
      professionalProfileId,

      explanation,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = ShiftAttendanceService.normalizeCurrentTime(currentTime);

    const normalizedExplanation = ShiftAttendanceService.normalizeAbsenceExplanation(explanation);

    return ShiftAttendanceService.runWithOptionalTransaction(options, async (session) => {
      const {
        shift,
        occurrence,
        professionalProfileId: normalizedProfessionalProfileId,
      } = await ShiftAttendanceService.getProfessionalOccurrenceContext({
        shiftId,

        occurrenceId,

        professionalProfileId,

        session,
      });

      if (occurrence.status !== "no_show" || occurrence.attendanceStatus !== "no_show") {
        throw ShiftAttendanceService.createError({
          message: "An absence explanation can only be submitted for a recorded no-show.",

          code: "ABSENCE_EXPLANATION_NOT_AVAILABLE",

          statusCode: 409,
        });
      }

      const occurrenceEndTime = new Date(occurrence.endTime);

      if (Number.isNaN(occurrenceEndTime.getTime())) {
        throw ShiftAttendanceService.createError({
          message: "The occurrence end time is invalid.",

          code: "INVALID_OCCURRENCE_END_TIME",

          statusCode: 500,
        });
      }

      /*
       * The explanation confirms that the professional did not work the
       * occurrence. It therefore cannot be finalized before the occurrence has
       * actually ended.
       */
      if (normalizedCurrentTime < occurrenceEndTime) {
        throw ShiftAttendanceService.createError({
          message: "An absence explanation can be submitted after the occurrence has ended.",

          code: "ABSENCE_EXPLANATION_TOO_EARLY",

          statusCode: 409,

          details: {
            occurrenceEndTime,
          },
        });
      }

      if (occurrence.absenceExplanation || occurrence.absenceExplainedAt) {
        if (
          occurrence.absenceExplanation === normalizedExplanation &&
          occurrence.absenceExplainedAt
        ) {
          return {
            shift,

            occurrence,

            professionalProfileId: String(normalizedProfessionalProfileId),

            submitted: false,

            idempotent: true,

            absenceExplanation: occurrence.absenceExplanation,

            absenceExplainedAt: occurrence.absenceExplainedAt,
          };
        }

        /*
         * Keep this as one immutable occurrence audit rather than an editable
         * quasi-case history.
         */
        throw ShiftAttendanceService.createError({
          message: "An absence explanation has already been submitted for this occurrence.",

          code: "ABSENCE_EXPLANATION_ALREADY_SUBMITTED",

          statusCode: 409,
        });
      }

      occurrence.absenceExplanation = normalizedExplanation;

      occurrence.absenceExplainedAt = normalizedCurrentTime;

      /*
       * Deliberately do NOT modify:
       *
       * status
       * attendanceStatus
       * settlementStatus
       * activeClaim
       * activeDispute
       * shared challenge window
       * refund state
       * professional pay
       */
      await occurrence.save({
        session,
      });

      logger.info(
        `Professional ${normalizedProfessionalProfileId} submitted an absence explanation for occurrence ${occurrence._id}`
      );

      return {
        shift,

        occurrence,

        professionalProfileId: String(normalizedProfessionalProfileId),

        submitted: true,

        idempotent: false,

        absenceExplanation: occurrence.absenceExplanation,

        absenceExplainedAt: occurrence.absenceExplainedAt,

        events: [
          {
            type: "shift_occurrence_absence_explained",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(normalizedProfessionalProfileId),

            absenceExplainedAt: occurrence.absenceExplainedAt,
          },
        ],
      };
    });
  }

  static async processNoShowCandidates({
    currentTime = new Date(),
    limit = MAX_PROCESSING_BATCH_SIZE,
  } = {}) {
    const normalizedCurrentTime = ShiftAttendanceService.normalizeCurrentTime(currentTime);

    const normalizedLimit = Math.min(
      Math.max(Number.parseInt(limit, 10) || 1, 1),
      MAX_PROCESSING_BATCH_SIZE
    );

    const candidates = await ShiftOccurrence.find({
      assignmentStatus: "assigned",

      assignedProfessional: {
        $ne: null,
      },

      assignment: {
        $ne: null,
      },

      assignedAt: {
        $ne: null,
        $lte: normalizedCurrentTime,
      },

      status: "scheduled",

      attendanceStatus: "not_started",

      checkedInAt: null,

      checkInPinUsedAt: null,

      startTime: {
        $lte: normalizedCurrentTime,
      },
    })
      .select("shift assignedAt startTime endTime")
      .sort({
        startTime: 1,
      })
      .limit(normalizedLimit)
      .lean();

    const results = [];

    for (const candidate of candidates) {
      try {
        const result = await ShiftAttendanceService.markNoShow({
          shiftId: candidate.shift,
          occurrenceId: candidate._id,
          currentTime: normalizedCurrentTime,
        });

        if (result.marked) {
          results.push({
            occurrenceId: String(candidate._id),

            shiftId: String(candidate.shift),

            marked: true,
          });
        }
      } catch (error) {
        if (error.code !== "NO_SHOW_DEADLINE_NOT_REACHED") {
          logger.error(`Unable to process no-show candidate ${candidate._id}: ${error.message}`);

          results.push({
            occurrenceId: String(candidate._id),

            shiftId: String(candidate.shift),

            marked: false,

            error: error.message,
          });
        }
      }
    }

    return {
      inspectedCount: candidates.length,

      markedCount: results.filter((result) => result.marked).length,

      results,
    };
  }
}

module.exports = ShiftAttendanceService;
