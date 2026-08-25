// models/helpers/shiftSchemaHelpers.js

const { MINUTES_PER_DAY } = require("../../constants/shiftLifecycle");

const { hasDocumentValue } = require("./schemaValidators");

/* ─────────────────────────────── INTERNAL HELPERS ─────────────────────────────── */

function amount(value) {
  return Number(value || 0);
}

function hasAnyDocumentValue(values) {
  return values.some(hasDocumentValue);
}

function hasAttendanceLocationData(location) {
  if (!location) {
    return false;
  }

  return hasAnyDocumentValue([
    location.latitude,
    location.longitude,
    location.accuracyMeters,
    location.capturedAt,
    location.branchLatitude,
    location.branchLongitude,
    location.geofenceRadiusMeters,
    location.distanceFromBranchMeters,
    location.withinGeofence,
    location.locationSource,
    location.failureReason,
  ]);
}

function hasAttendanceOverrideData(override = {}) {
  return (
    override.used === true ||
    hasAnyDocumentValue([
      override.type,
      override.reason,
      override.approvedStartTime,
      override.approvedEndTime,
      override.reviewedAt,
      override.reviewedBy,
      override.notes,
    ])
  );
}

function hasLateCheckoutData(lateCheckout = {}) {
  return (
    lateCheckout.occurred === true ||
    amount(lateCheckout.minutesLate) > 0 ||
    hasAnyDocumentValue([
      lateCheckout.selectedOption,
      lateCheckout.reason,
      lateCheckout.notes,
      lateCheckout.recordedAt,
    ])
  );
}

function hasCheckoutFallbackData(checkoutFallback = {}) {
  return (
    checkoutFallback.required === true ||
    hasAnyDocumentValue([
      checkoutFallback.reason,
      checkoutFallback.requestedAt,
      checkoutFallback.resolvedAt,
      checkoutFallback.resolvedBy,
      checkoutFallback.approvedEndTime,
      checkoutFallback.notes,
    ])
  );
}

function hasMissedCheckInRequestData(request = {}) {
  return (
    hasAnyDocumentValue([
      request.claimedStartTime,
      request.submittedAt,
      request.reason,
      request.reviewedAt,
      request.reviewedBy,
      request.outcome,
      request.approvedStartTime,
      request.rejectionReason,
    ]) || hasAttendanceLocationData(request.locationAtSubmission)
  );
}

function hasOvertimeData(overtime = {}) {
  return (
    overtime.requested === true ||
    overtime.topUpPaid === true ||
    amount(overtime.topUpAmount) > 0 ||
    hasAnyDocumentValue([
      overtime.requestedBy,
      overtime.requestedAt,
      overtime.source,
      overtime.reason,
      overtime.extraHours,
      overtime.status,
      overtime.employerResponseDeadlineAt,
      overtime.employerRespondedAt,
      overtime.employerResponseOverdueAt,
      overtime.restrictionTriggeredAt,
      overtime.approvedAt,
      overtime.approvedBy,
      overtime.rejectedAt,
      overtime.rejectedBy,
      overtime.rejectionReason,
      overtime.disputedAt,
      overtime.disputedBy,
      overtime.topUpPaidAt,
    ])
  );
}

/* ─────────────────────────────── SCHEDULE HELPERS ─────────────────────────────── */

exports.calculatePatternScheduledMinutes = function calculatePatternScheduledMinutes({
  dailyStartTimeMinutes,
  dailyEndTimeMinutes,
  endsNextDay,
}) {
  if (!Number.isSafeInteger(dailyStartTimeMinutes) || !Number.isSafeInteger(dailyEndTimeMinutes)) {
    return null;
  }

  if (endsNextDay) {
    return MINUTES_PER_DAY - dailyStartTimeMinutes + dailyEndTimeMinutes;
  }

  return dailyEndTimeMinutes - dailyStartTimeMinutes;
};

exports.requiresParentAttendancePins = function requiresParentAttendancePins() {
  return this.scheduleMode === "single";
};

/* ─────────────────────────────── ATTENDANCE HELPERS ─────────────────────────────── */

exports.hasParentAttendanceCompatibilityData = function hasParentAttendanceCompatibilityData(
  shift
) {
  if (!shift) {
    return false;
  }

  return (
    shift.attendanceStatus !== "not_started" ||
    hasAnyDocumentValue([
      shift.checkedInAt,
      shift.checkedOutAt,
      shift.checkInPinUsedAt,
      shift.checkOutPinUsedAt,
    ]) ||
    hasAttendanceLocationData(shift.checkInLocation) ||
    hasAttendanceLocationData(shift.checkOutLocation) ||
    hasAttendanceOverrideData(shift.attendanceOverride) ||
    hasLateCheckoutData(shift.lateCheckout) ||
    hasCheckoutFallbackData(shift.checkoutFallback) ||
    hasMissedCheckInRequestData(shift.missedCheckInRequest) ||
    hasOvertimeData(shift.overtime)
  );
};

/* ─────────────────────────────── FINANCIAL HELPERS ─────────────────────────────── */

exports.isZeroAmountTriple = function isZeroAmountTriple(
  professionalPay,
  platformFee,
  employerCharge
) {
  return amount(professionalPay) === 0 && amount(platformFee) === 0 && amount(employerCharge) === 0;
};

/* ─────────────────────────────── VALIDATION HELPERS ─────────────────────────────── */

exports.validateMinimumDetails = function validateMinimumDetails(document, path, value, label) {
  if (value && value.length < 10) {
    document.invalidate(path, `${label} must contain at least 10 characters when provided.`);
  }
};
