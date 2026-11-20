// services/shifts/shiftPinAccessService.js

const ShiftScheduleService = require("./shiftScheduleService");

const { EMPLOYER_SHIFTS_URL } = require("../../constants/shiftPresentation");

const TERMINAL_OCCURRENCE_STATUSES = ["completed", "cancelled", "no_show", "expired_unfilled"];

const TERMINAL_ATTENDANCE_STATUSES = ["settled", "no_show"];

const PIN_ELIGIBLE_PARENT_STATUSES = [
  "open",
  "assigned",
  "confirmed",
  "in_progress",
  "disputed",
  "pending_settlement",
];

const PIN_ELIGIBLE_OCCURRENCE_STATUSES = ["scheduled", "in_progress"];

const PIN_ELIGIBLE_ATTENDANCE_STATUSES = ["not_started", "checked_in"];

const PAYMENT_STATUSES_WITHOUT_ACTIVE_PROTECTED_FUNDS = [
  "unpaid",
  "failed",
  "released",
  "refunded",
];

class ShiftPinAccessService {
  /* ─────────────────────────────── OCCURRENCE STATE ─────────────────────────────── */

  static getOccurrenceLocalDate(occurrence) {
    if (occurrence?.occurrenceDate) {
      return String(occurrence.occurrenceDate);
    }

    if (occurrence?.startTime) {
      return ShiftScheduleService.extractLocalDateTimeParts(occurrence.startTime).localDate;
    }

    return null;
  }

  static isOccurrenceActive(occurrence) {
    return Boolean(
      occurrence &&
      (occurrence.status === "in_progress" ||
        occurrence.attendanceStatus === "checked_in" ||
        (occurrence.checkedInAt && !occurrence.checkedOutAt))
    );
  }

  static isOccurrenceTerminal(occurrence) {
    return Boolean(
      occurrence &&
      (TERMINAL_OCCURRENCE_STATUSES.includes(occurrence.status) ||
        TERMINAL_ATTENDANCE_STATUSES.includes(occurrence.attendanceStatus))
    );
  }

  /* ─────────────────────────────── OCCURRENCE SELECTION ─────────────────────────────── */

  static selectRelevantOccurrence(
    occurrences,
    selectedOccurrenceId = null,
    currentTime = new Date()
  ) {
    const occurrenceList = Array.isArray(occurrences) ? [...occurrences] : [];

    if (occurrenceList.length === 0) {
      return null;
    }

    const normalizedCurrentTime = new Date(currentTime);

    occurrenceList.sort((left, right) => {
      const startTimeDifference =
        new Date(left.startTime).getTime() - new Date(right.startTime).getTime();

      if (startTimeDifference !== 0) {
        return startTimeDifference;
      }

      return Number(left.sequenceNumber || 0) - Number(right.sequenceNumber || 0);
    });

    if (selectedOccurrenceId) {
      return (
        occurrenceList.find(
          (occurrence) => String(occurrence._id) === String(selectedOccurrenceId)
        ) || null
      );
    }

    const slotNumbers = new Set();

    for (const occurrence of occurrenceList) {
      if (!Number.isSafeInteger(occurrence.slotNumber) || occurrence.slotNumber < 1) {
        return null;
      }

      slotNumbers.add(occurrence.slotNumber);
    }

    if (slotNumbers.size > 1) {
      return null;
    }

    const activeOccurrence = occurrenceList.find((occurrence) =>
      ShiftPinAccessService.isOccurrenceActive(occurrence)
    );

    if (activeOccurrence) {
      return activeOccurrence;
    }

    const currentLocalDate =
      ShiftScheduleService.extractLocalDateTimeParts(normalizedCurrentTime).localDate;

    const todaysAvailableOccurrence = occurrenceList.find(
      (occurrence) =>
        ShiftPinAccessService.getOccurrenceLocalDate(occurrence) === currentLocalDate &&
        !ShiftPinAccessService.isOccurrenceTerminal(occurrence)
    );

    if (todaysAvailableOccurrence) {
      return todaysAvailableOccurrence;
    }

    const nextOccurrence = occurrenceList.find(
      (occurrence) =>
        new Date(occurrence.startTime) > normalizedCurrentTime &&
        !ShiftPinAccessService.isOccurrenceTerminal(occurrence)
    );

    if (nextOccurrence) {
      return nextOccurrence;
    }

    const todaysFinalOccurrence = occurrenceList.find(
      (occurrence) => ShiftPinAccessService.getOccurrenceLocalDate(occurrence) === currentLocalDate
    );

    if (todaysFinalOccurrence) {
      return todaysFinalOccurrence;
    }

    return occurrenceList[occurrenceList.length - 1];
  }

  static selectAttendanceOccurrence(occurrences, currentTime = new Date()) {
    return ShiftPinAccessService.selectRelevantOccurrence(occurrences, null, currentTime);
  }

  /* ─────────────────────────────── FUNDING / ASSIGNMENT STATE ─────────────────────────────── */

  /*
   * These helpers describe operational readiness.
   *
   * They must not be used to restrict employer visibility
   * of PINs that were generated at occurrence creation.
   */

  static isShiftFundedForAttendance(shift) {
    if (!shift) {
      return false;
    }

    const paymentStatus = String(shift.paymentStatus || "")
      .trim()
      .toLowerCase();

    return Boolean(
      paymentStatus && !PAYMENT_STATUSES_WITHOUT_ACTIVE_PROTECTED_FUNDS.includes(paymentStatus)
    );
  }

  static parentStateAllowsPinAccess(shift) {
    return Boolean(shift && PIN_ELIGIBLE_PARENT_STATUSES.includes(shift.status));
  }

  static hasValidOccurrenceAssignment(occurrence) {
    return Boolean(
      occurrence?.assignmentStatus === "assigned" &&
      occurrence?.assignedProfessional &&
      occurrence?.assignment &&
      occurrence?.assignedAt
    );
  }

  static occurrenceStateAllowsPinAccess(occurrence) {
    return Boolean(
      occurrence &&
      !ShiftPinAccessService.isOccurrenceTerminal(occurrence) &&
      PIN_ELIGIBLE_OCCURRENCE_STATUSES.includes(occurrence.status) &&
      PIN_ELIGIBLE_ATTENDANCE_STATUSES.includes(occurrence.attendanceStatus) &&
      !occurrence.checkedOutAt &&
      !occurrence.earlyTermination?.occurred
    );
  }

  /* ─────────────────────────────── PIN VISIBILITY ─────────────────────────────── */

  /**
   * PIN VISIBILITY POLICY
   *
   * Every ShiftOccurrence must receive its check-in and
   * checkout PINs when the occurrence is created.
   *
   * Both PINs are visible to authorized employer users
   * throughout the occurrence lifecycle.
   *
   * Visibility is independent of:
   *
   * - professional assignment;
   * - protected funding status;
   * - the scheduled attendance window;
   * - check-in or checkout status;
   * - settlement;
   * - cancellation; and
   * - occurrence completion.
   *
   * This service determines UI visibility only.
   *
   * Employer identity, business ownership and branch
   * permissions are enforced by the PIN retrieval service.
   *
   * The professional's ability to use either PIN remains
   * subject to ShiftAttendanceService's attendance rules.
   */
  static buildOccurrencePinAuthorization({ shift, occurrence }) {
    const hasAssignment = ShiftPinAccessService.hasValidOccurrenceAssignment(occurrence);

    const shiftIsFunded = ShiftPinAccessService.isShiftFundedForAttendance(shift);

    /*
     * Retained as operational-state information.
     * Neither value controls PIN visibility.
     */
    const parentStateAllowsPinAccess = ShiftPinAccessService.parentStateAllowsPinAccess(shift);

    const occurrenceStateAllowsPinAccess =
      ShiftPinAccessService.occurrenceStateAllowsPinAccess(occurrence);

    /*
     * An occurrence and its parent Shift are required to
     * construct valid occurrence-specific retrieval actions.
     *
     * Employer permission is combined with these flags by
     * the caller. The backend independently authorizes access.
     */
    const occurrenceAvailable = Boolean(shift?._id && occurrence?._id);

    const canViewAttendancePins = occurrenceAvailable;

    const canRevealCheckInPin = occurrenceAvailable;

    const canRevealCheckOutPin = occurrenceAvailable;

    const hasAvailablePin = occurrenceAvailable;

    const unavailableMessage = occurrenceAvailable
      ? null
      : "Attendance PINs are unavailable because the Shift occurrence could not be identified.";

    return {
      hasAssignment,

      shiftIsFunded,

      parentStateAllowsPinAccess,

      occurrenceStateAllowsPinAccess,

      canViewAttendancePins,

      canRevealCheckInPin,

      canRevealCheckOutPin,

      hasAvailablePin,

      unavailableMessage,
    };
  }

  /* ─────────────────────────────── PIN ENDPOINTS ─────────────────────────────── */

  static buildOccurrencePinUrls({
    shiftId,
    occurrenceId,
    employerShiftsUrl = EMPLOYER_SHIFTS_URL,
  }) {
    const occurrenceUrl = `${employerShiftsUrl}/${shiftId}` + `/occurrences/${occurrenceId}`;

    return {
      checkInPinUrl: `${occurrenceUrl}/check-in-pin`,

      checkOutPinUrl: `${occurrenceUrl}/check-out-pin`,
    };
  }
}

module.exports = ShiftPinAccessService;
