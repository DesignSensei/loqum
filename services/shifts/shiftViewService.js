// services/shifts/shiftViewService.js

const money = require("../../utils/money");
const { badgeClass, formatStatus } = require("../../utils/statusHelper");

const ShiftScheduleService = require("./shiftScheduleService");
const ShiftPinAccessService = require("./shiftPinAccessService");

const {
  MINUTES_PER_DAY,
  PROFESSIONAL_TYPE_OPTIONS,
  ACTIVE_SHIFT_PROFESSIONAL_TYPES,
} = require("../../constants/shiftPosting");

const {
  EMPLOYER_SHIFTS_URL,
  POST_SHIFT_MODAL_ID,
  FUND_SHIFT_MODAL_ID,
  PIN_BRAND_COLOR,
  PIN_DISPLAY_FORMAT,
} = require("../../constants/shiftPresentation");

const { hasValidBranchLocation } = require("../helpers/branchValidationHelpers");

const DEFAULT_CURRENCY = "NGN";
const DEFAULT_BADGE_CLASS = "badge-light-secondary";
const DEFAULT_REFUND_STATUS = "not_eligible";

const PAYMENT_REQUIRED_STATUSES = ["unpaid"];

const CANCELLABLE_ENGAGEMENT_STATUSES = ["open", "assigned", "confirmed", "in_progress"];

const ACTIVE_WORK_CANCELLATION_PARENT_STATUSES = ["confirmed", "in_progress"];

const PIN_SELECTION_UNAVAILABLE_MESSAGE = "Select an occurrence to view its attendance PIN state.";

class ShiftViewService {
  /* ─────────────────────────────── PUBLIC CONFIGURATION ─────────────────────────────── */

  static getEmployerShiftsUrl() {
    return EMPLOYER_SHIFTS_URL;
  }

  static getPostShiftModalId() {
    return POST_SHIFT_MODAL_ID;
  }

  static getFundShiftModalId() {
    return FUND_SHIFT_MODAL_ID;
  }

  static getProfessionalTypeOptions() {
    return PROFESSIONAL_TYPE_OPTIONS.map((option) => ({
      ...option,
    }));
  }

  static getActiveProfessionalTypes() {
    return [...ACTIVE_SHIFT_PROFESSIONAL_TYPES];
  }

  static getPostableProfessionalTypeOptions() {
    return PROFESSIONAL_TYPE_OPTIONS.map((option) => {
      const isPostable = ACTIVE_SHIFT_PROFESSIONAL_TYPES.includes(option.value);

      return {
        ...option,

        isPostable,

        disabled: !isPostable,
      };
    });
  }

  /* ─────────────────────────────── BASIC FORMATTING ─────────────────────────────── */

  static formatAmount(amount, currency = DEFAULT_CURRENCY) {
    return money.formatMoney(amount ?? 0, currency);
  }

  static formatDate(date) {
    if (!date) {
      return "-";
    }

    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      dateStyle: "medium",

      timeZone: ShiftScheduleService.getTimeZone(),
    }).format(parsedDate);
  }

  static formatDateTime(date) {
    if (!date) {
      return "-";
    }

    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      dateStyle: "medium",

      timeStyle: "short",

      timeZone: ShiftScheduleService.getTimeZone(),
    }).format(parsedDate);
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

    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      timeStyle: "short",

      timeZone: ShiftScheduleService.getTimeZone(),
    }).format(parsedDate);
  }

  static formatTimeMinutesForDisplay(value) {
    const totalMinutes = Number(value);

    if (
      !Number.isSafeInteger(totalMinutes) ||
      totalMinutes < 0 ||
      totalMinutes >= MINUTES_PER_DAY
    ) {
      return "-";
    }

    const hour24 = Math.floor(totalMinutes / 60);

    const minute = totalMinutes % 60;

    const period = hour24 >= 12 ? "PM" : "AM";

    const hour12 = hour24 % 12 || 12;

    return `${hour12}:` + `${String(minute).padStart(2, "0")} ` + period;
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

  static formatScheduledHours(value) {
    const hours = Number(value);

    if (!Number.isFinite(hours)) {
      return "-";
    }

    const displayHours = Number(hours.toFixed(2));

    return `${displayHours} ` + `${displayHours === 1 ? "hour" : "hours"}`;
  }

  static formatBreakDuration(value) {
    const minutes = Number(value || 0);

    if (!Number.isFinite(minutes) || minutes <= 0) {
      return "No declared break";
    }

    return `${minutes} ` + `${minutes === 1 ? "minute" : "minutes"}`;
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

  static toId(value) {
    return value ? String(value) : null;
  }

  /* ─────────────────────────────── BRANCH VIEW ─────────────────────────────── */

  static buildBranchOption(branch) {
    const branchHasValidLocation = hasValidBranchLocation(branch);

    return {
      value: String(branch._id),

      name: branch.name,

      locationLabel: [branch.address, branch.lga, branch.state].filter(Boolean).join(", "),

      hasValidLocation: branchHasValidLocation,

      isSelectable: branchHasValidLocation,

      disabledReason: branchHasValidLocation
        ? null
        : "Add a valid branch location before posting a Shift here.",
    };
  }

  static buildBranchView(branch) {
    if (!branch) {
      return null;
    }

    return {
      id: String(branch._id),

      name: branch.name,

      address: branch.address || null,

      state: branch.state || null,

      lga: branch.lga || null,

      locationLabel: [branch.address, branch.lga, branch.state].filter(Boolean).join(", "),

      geofenceRadiusMeters: branch.geofenceRadiusMeters || null,
    };
  }

  /* ─────────────────────────────── SHIFT DISPLAY STATUS ─────────────────────────────── */

  static isExpiredUnfundedShift(shift) {
    return Boolean(
      shift && shift.status === "cancelled" && shift.cancellationCode === "funding_deadline_passed"
    );
  }

  static getShiftDisplayStatus(shift) {
    if (ShiftViewService.isExpiredUnfundedShift(shift)) {
      return {
        value: "expired",

        label: "Expired",

        badgeClass: badgeClass.expired || DEFAULT_BADGE_CLASS,
      };
    }

    const status = shift?.status || null;

    return {
      value: status,

      label: formatStatus(status),

      badgeClass: badgeClass[status] || DEFAULT_BADGE_CLASS,
    };
  }

  static shiftNeedsPayment(shift, currentTime = new Date()) {
    const startTime = shift?.startTime ? new Date(shift.startTime) : null;

    const normalizedCurrentTime = new Date(currentTime);

    const paymentStatus = String(shift?.paymentStatus || "")
      .trim()
      .toLowerCase();

    return Boolean(
      shift &&
      shift.status === "pending_funding" &&
      PAYMENT_REQUIRED_STATUSES.includes(paymentStatus) &&
      startTime &&
      !Number.isNaN(startTime.getTime()) &&
      !Number.isNaN(normalizedCurrentTime.getTime()) &&
      startTime > normalizedCurrentTime
    );
  }

  static shiftPaymentIsRetry(shift, currentTime = new Date()) {
    return Boolean(
      ShiftViewService.shiftNeedsPayment(shift, currentTime) &&
      (shift.fundingMethod || shift.fundingInitiatedAt)
    );
  }

  /* ─────────────────────────────── OCCURRENCE HELPERS ─────────────────────────────── */

  static buildOccurrenceHighlight({ occurrence, selectedOccurrence, currentTime = new Date() }) {
    const normalizedCurrentTime = new Date(currentTime);

    const currentLocalDate =
      ShiftScheduleService.extractLocalDateTimeParts(normalizedCurrentTime).localDate;

    const isSelected = Boolean(
      selectedOccurrence && String(selectedOccurrence._id) === String(occurrence._id)
    );

    const isActive = ShiftPinAccessService.isOccurrenceActive(occurrence);

    const isToday = ShiftPinAccessService.getOccurrenceLocalDate(occurrence) === currentLocalDate;

    const isNext = Boolean(
      isSelected && !isActive && !isToday && new Date(occurrence.startTime) > normalizedCurrentTime
    );

    let label = null;

    if (isActive) {
      label = "Active";
    } else if (isToday) {
      label = "Today";
    } else if (isNext) {
      label = "Next";
    }

    return {
      isSelected,

      isActive,

      isToday,

      isNext,

      label,
    };
  }

  static buildSettlementComponentView(component, currency) {
    const source = component && typeof component === "object" ? component : {};

    const status = source.status || "not_due";

    const professionalPay = Number(source.professionalPay || 0);

    return {
      status,

      statusLabel: formatStatus(status),

      statusBadgeClass: badgeClass[status] || DEFAULT_BADGE_CLASS,

      earningType: source.earningType || null,

      earningTypeLabel: source.earningType ? formatStatus(source.earningType) : null,

      professionalPay,

      professionalPayDisplay: ShiftViewService.formatAmount(professionalPay, currency),

      approvedForReleaseAt: source.approvedForReleaseAt || null,

      approvedForReleaseAtDisplay: ShiftViewService.formatDateTime(source.approvedForReleaseAt),

      approvalSource: source.approvalSource || null,

      approvedForReleaseBy: ShiftViewService.toId(source.approvedForReleaseBy),

      scheduledPayoutAt: source.scheduledPayoutAt || null,

      scheduledPayoutAtDisplay: ShiftViewService.formatDateTime(source.scheduledPayoutAt),

      settlementBatch: ShiftViewService.toId(source.settlementBatch),

      releasePendingAt: source.releasePendingAt || null,

      releasePendingAtDisplay: ShiftViewService.formatDateTime(source.releasePendingAt),

      releasedAt: source.releasedAt || null,

      releasedAtDisplay: ShiftViewService.formatDateTime(source.releasedAt),

      payoutTransaction: ShiftViewService.toId(source.payoutTransaction),
    };
  }

  static buildPlatformFeeAuditView(audit) {
    const source = audit && typeof audit === "object" ? audit : {};

    return {
      earnedAt: source.earnedAt || null,

      earnedAtDisplay: ShiftViewService.formatDateTime(source.earnedAt),

      outstandingAt: source.outstandingAt || null,

      outstandingAtDisplay: ShiftViewService.formatDateTime(source.outstandingAt),

      collectedAt: source.collectedAt || null,

      collectedAtDisplay: ShiftViewService.formatDateTime(source.collectedAt),

      collectionTransaction: ShiftViewService.toId(source.collectionTransaction),
    };
  }

  static buildChallengeView(occurrence, currentTime = new Date()) {
    const openedAt = occurrence?.challengeWindowOpenedAt || null;

    const deadlineAt = occurrence?.challengeDeadlineAt || null;

    const closedAt = occurrence?.challengeWindowClosedAt || null;

    const components = Array.isArray(occurrence?.challengeableSettlementComponents)
      ? [...occurrence.challengeableSettlementComponents]
      : [];

    const normalizedCurrentTime = new Date(currentTime);

    const deadline = deadlineAt ? new Date(deadlineAt) : null;

    const isOpen = Boolean(
      openedAt &&
      deadlineAt &&
      !closedAt &&
      !Number.isNaN(normalizedCurrentTime.getTime()) &&
      deadline &&
      !Number.isNaN(deadline.getTime()) &&
      normalizedCurrentTime.getTime() <= deadline.getTime()
    );

    return {
      openedAt,

      openedAtDisplay: ShiftViewService.formatDateTime(openedAt),

      deadlineAt,

      deadlineAtDisplay: ShiftViewService.formatDateTime(deadlineAt),

      closedAt,

      closedAtDisplay: ShiftViewService.formatDateTime(closedAt),

      isOpen,

      challengeableSettlementComponents: components,

      activeClaim: ShiftViewService.toId(occurrence?.activeClaim),

      activeDispute: ShiftViewService.toId(occurrence?.activeDispute),
    };
  }

  /* ─────────────────────────────── OCCURRENCE VIEW ─────────────────────────────── */

  static buildEmployerOccurrenceView({
    shift,
    occurrence,
    currency,
    currentTime = new Date(),
    selectedOccurrence = null,
  }) {
    const pinAuthorization = ShiftPinAccessService.buildOccurrencePinAuthorization({
      shift,
      occurrence,
    });

    const pinUrls = ShiftPinAccessService.buildOccurrencePinUrls({
      shiftId: shift._id,

      occurrenceId: occurrence._id,

      employerShiftsUrl: EMPLOYER_SHIFTS_URL,
    });

    const highlight = ShiftViewService.buildOccurrenceHighlight({
      occurrence,

      selectedOccurrence,

      currentTime,
    });

    const scheduledMinutes = Number(
      occurrence.scheduledMinutes || Math.round(Number(occurrence.scheduledHours || 0) * 60)
    );

    const hourlyRate = Number(occurrence.hourlyRate || 0);

    const estimatedProfessionalPay = Number(occurrence.estimatedProfessionalPay || 0);

    const estimatedPlatformFee = Number(occurrence.estimatedPlatformFee || 0);

    const estimatedEmployerCharge = Number(occurrence.estimatedEmployerCharge || 0);

    const baseProfessionalPay = Number(occurrence.baseProfessionalPay || 0);

    const basePlatformFee = Number(occurrence.basePlatformFee || 0);

    const overtimeProfessionalPay = Number(occurrence.overtimeProfessionalPay || 0);

    const overtimePlatformFee = Number(occurrence.overtimePlatformFee || 0);

    /*
     * Presentation-only totals.
     *
     * These are derived from the current
     * occurrence authorities. They are not
     * persisted financial authorities.
     */
    const scheduledCommittedEmployerCharge = baseProfessionalPay + basePlatformFee;

    const overtimeApprovedEmployerCharge = overtimeProfessionalPay + overtimePlatformFee;

    const totalProfessionalEntitlement = baseProfessionalPay + overtimeProfessionalPay;

    const totalEarnedPlatformFee = basePlatformFee + overtimePlatformFee;

    const totalCommittedEmployerCharge = totalProfessionalEntitlement + totalEarnedPlatformFee;

    const topUpRequired = Number(occurrence.topUpRequired || 0);

    const refundableAmount = Number(occurrence.refundableAmount || 0);

    const refundedAmount = Number(occurrence.refundedAmount || 0);

    const startParts = ShiftScheduleService.extractLocalDateTimeParts(occurrence.startTime);

    const endParts = ShiftScheduleService.extractLocalDateTimeParts(occurrence.endTime);

    const baseSettlement = ShiftViewService.buildSettlementComponentView(
      occurrence.baseSettlement,
      currency
    );

    const overtimeSettlement = ShiftViewService.buildSettlementComponentView(
      occurrence.overtimeSettlement,
      currency
    );

    const basePlatformFeeAudit = ShiftViewService.buildPlatformFeeAuditView(
      occurrence.basePlatformFeeAudit
    );

    const overtimePlatformFeeAudit = ShiftViewService.buildPlatformFeeAuditView(
      occurrence.overtimePlatformFeeAudit
    );

    const challenge = ShiftViewService.buildChallengeView(occurrence, currentTime);

    const occurrenceDetailsUrl =
      `${EMPLOYER_SHIFTS_URL}/${shift._id}` + `?occurrence=${occurrence._id}`;

    return {
      id: String(occurrence._id),

      shiftId: String(shift._id),

      referenceCode: occurrence.referenceCode,

      sequenceNumber: Number(occurrence.sequenceNumber || 0),

      sequenceLabel: `Shift ${Number(occurrence.sequenceNumber || 0)}`,

      occurrenceDate: occurrence.occurrenceDate || null,

      occurrenceDateDisplay: occurrence.occurrenceDate
        ? ShiftViewService.formatLocalDate(occurrence.occurrenceDate)
        : ShiftViewService.formatDate(occurrence.startTime),

      scheduleTimeZone: occurrence.scheduleTimeZone || ShiftScheduleService.getTimeZone(),

      startTime: occurrence.startTime,

      endTime: occurrence.endTime,

      startDateDisplay: ShiftViewService.formatDate(occurrence.startTime),

      endDateDisplay: ShiftViewService.formatDate(occurrence.endTime),

      startTimeDisplay: ShiftViewService.formatTime(occurrence.startTime),

      endTimeDisplay: ShiftViewService.formatTime(occurrence.endTime),

      dateTimeDisplay:
        `${ShiftViewService.formatDate(occurrence.startTime)} • ` +
        `${ShiftViewService.formatTime(occurrence.startTime)}–` +
        `${ShiftViewService.formatTime(occurrence.endTime)}`,

      crossesMidnight: startParts.localDate !== endParts.localDate,

      scheduledMinutes,

      scheduledHours: scheduledMinutes > 0 ? Number((scheduledMinutes / 60).toFixed(4)) : null,

      scheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(scheduledMinutes),

      breakDuration: Number(occurrence.breakDuration || 0),

      breakDurationDisplay: ShiftViewService.formatBreakDuration(occurrence.breakDuration),

      fillCutoffAt: occurrence.fillCutoffAt || null,

      fillCutoffAtDisplay: ShiftViewService.formatDateTime(occurrence.fillCutoffAt),

      unfilledFinalizationAt: occurrence.unfilledFinalizationAt || null,

      unfilledFinalizationAtDisplay: ShiftViewService.formatDateTime(
        occurrence.unfilledFinalizationAt
      ),

      expiredFromAssignmentStatus: occurrence.expiredFromAssignmentStatus || null,

      expiredUnfilledAt: occurrence.expiredUnfilledAt || null,

      expiredUnfilledAtDisplay: ShiftViewService.formatDateTime(occurrence.expiredUnfilledAt),

      baseBillableHours: occurrence.baseBillableHours ?? null,

      billableHours: occurrence.billableHours ?? null,

      hourlyRate,

      hourlyRateDisplay: ShiftViewService.formatAmount(hourlyRate, currency),

      platformFeeRate: Number(occurrence.platformFeeRate || 0),

      estimatedProfessionalPay,

      estimatedProfessionalPayDisplay: ShiftViewService.formatAmount(
        estimatedProfessionalPay,
        currency
      ),

      estimatedPlatformFee,

      estimatedPlatformFeeDisplay: ShiftViewService.formatAmount(estimatedPlatformFee, currency),

      estimatedEmployerCharge,

      estimatedEmployerChargeDisplay: ShiftViewService.formatAmount(
        estimatedEmployerCharge,
        currency
      ),

      baseProfessionalPay,

      baseProfessionalPayDisplay: ShiftViewService.formatAmount(baseProfessionalPay, currency),

      basePlatformFee,

      basePlatformFeeDisplay: ShiftViewService.formatAmount(basePlatformFee, currency),

      overtimeProfessionalPay,

      overtimeProfessionalPayDisplay: ShiftViewService.formatAmount(
        overtimeProfessionalPay,
        currency
      ),

      overtimePlatformFee,

      overtimePlatformFeeDisplay: ShiftViewService.formatAmount(overtimePlatformFee, currency),

      scheduledCommittedEmployerCharge,

      scheduledCommittedEmployerChargeDisplay: ShiftViewService.formatAmount(
        scheduledCommittedEmployerCharge,
        currency
      ),

      overtimeApprovedEmployerCharge,

      overtimeApprovedEmployerChargeDisplay: ShiftViewService.formatAmount(
        overtimeApprovedEmployerCharge,
        currency
      ),

      totalProfessionalEntitlement,

      totalProfessionalEntitlementDisplay: ShiftViewService.formatAmount(
        totalProfessionalEntitlement,
        currency
      ),

      totalEarnedPlatformFee,

      totalEarnedPlatformFeeDisplay: ShiftViewService.formatAmount(
        totalEarnedPlatformFee,
        currency
      ),

      totalCommittedEmployerCharge,

      totalCommittedEmployerChargeDisplay: ShiftViewService.formatAmount(
        totalCommittedEmployerCharge,
        currency
      ),

      topUpRequired,

      topUpRequiredDisplay: ShiftViewService.formatAmount(topUpRequired, currency),

      topUpTransaction: ShiftViewService.toId(occurrence.topUpTransaction),

      basePlatformFeeAudit,

      overtimePlatformFeeAudit,

      baseSettlement,

      overtimeSettlement,

      settledAt: occurrence.settledAt || null,

      settledAtDisplay: ShiftViewService.formatDateTime(occurrence.settledAt),

      challengeWindowOpenedAt: challenge.openedAt,

      challengeWindowOpenedAtDisplay: challenge.openedAtDisplay,

      challengeDeadlineAt: challenge.deadlineAt,

      challengeDeadlineAtDisplay: challenge.deadlineAtDisplay,

      challengeWindowClosedAt: challenge.closedAt,

      challengeWindowClosedAtDisplay: challenge.closedAtDisplay,

      challengeWindowOpen: challenge.isOpen,

      challengeableSettlementComponents: challenge.challengeableSettlementComponents,

      activeClaim: challenge.activeClaim,

      activeDispute: challenge.activeDispute,

      challenge,

      refundableAmount,

      refundableAmountDisplay: ShiftViewService.formatAmount(refundableAmount, currency),

      refundedAmount,

      refundedAmountDisplay: ShiftViewService.formatAmount(refundedAmount, currency),

      refundStatus: occurrence.refundStatus || DEFAULT_REFUND_STATUS,

      refundStatusLabel: formatStatus(occurrence.refundStatus || DEFAULT_REFUND_STATUS),

      refundStatusBadgeClass:
        badgeClass[occurrence.refundStatus || DEFAULT_REFUND_STATUS] || DEFAULT_BADGE_CLASS,

      refundReason: occurrence.refundReason || null,

      refundEligibleAt: occurrence.refundEligibleAt || null,

      refundEligibleAtDisplay: ShiftViewService.formatDateTime(occurrence.refundEligibleAt),

      refundLastEvaluatedAt: occurrence.refundLastEvaluatedAt || null,

      refundLastEvaluatedAtDisplay: ShiftViewService.formatDateTime(
        occurrence.refundLastEvaluatedAt
      ),

      refundHeldAt: occurrence.refundHeldAt || null,

      refundHeldAtDisplay: ShiftViewService.formatDateTime(occurrence.refundHeldAt),

      refundHoldReason: occurrence.refundHoldReason || null,

      employerRefund: ShiftViewService.toId(occurrence.employerRefund),

      refundBatch: ShiftViewService.toId(occurrence.refundBatch),

      refundProcessingStartedAt: occurrence.refundProcessingStartedAt || null,

      refundProcessingStartedAtDisplay: ShiftViewService.formatDateTime(
        occurrence.refundProcessingStartedAt
      ),

      refundedAt: occurrence.refundedAt || null,

      refundedAtDisplay: ShiftViewService.formatDateTime(occurrence.refundedAt),

      replacementRequiredAt: occurrence.replacementRequiredAt || null,

      replacementRequiredAtDisplay: ShiftViewService.formatDateTime(
        occurrence.replacementRequiredAt
      ),

      replacementForAssignment: ShiftViewService.toId(occurrence.replacementForAssignment),

      replacementCase: ShiftViewService.toId(occurrence.replacementCase),

      replacementReasonCode: occurrence.replacementReasonCode || null,

      replacementReasonDetails: occurrence.replacementReasonDetails || null,

      cancellationCode: occurrence.cancellationCode || null,

      cancellationReason: occurrence.cancellationReason || null,

      cancelledBy: occurrence.cancelledBy || null,

      cancelledByUser: ShiftViewService.toId(occurrence.cancelledByUser),

      cancelledAt: occurrence.cancelledAt || null,

      cancelledAtDisplay: ShiftViewService.formatDateTime(occurrence.cancelledAt),

      cancellationCompensation: occurrence.cancellationCompensation || null,

      activeWorkCancellation: occurrence.activeWorkCancellation || null,

      assignmentStatus: occurrence.assignmentStatus,

      assignmentStatusLabel: formatStatus(occurrence.assignmentStatus),

      assignmentStatusBadgeClass: badgeClass[occurrence.assignmentStatus] || DEFAULT_BADGE_CLASS,

      assignedProfessional: ShiftViewService.toId(occurrence.assignedProfessional),

      assignment: ShiftViewService.toId(occurrence.assignment),

      assignedAt: occurrence.assignedAt || null,

      assignedAtDisplay: ShiftViewService.formatDateTime(occurrence.assignedAt),

      hasAssignment: pinAuthorization.hasAssignment,

      status: occurrence.status,

      statusLabel: formatStatus(occurrence.status),

      statusBadgeClass: badgeClass[occurrence.status] || DEFAULT_BADGE_CLASS,

      attendanceStatus: occurrence.attendanceStatus,

      attendanceStatusLabel: formatStatus(occurrence.attendanceStatus),

      attendanceStatusBadgeClass: badgeClass[occurrence.attendanceStatus] || DEFAULT_BADGE_CLASS,

      settlementStatus: occurrence.settlementStatus,

      settlementStatusLabel: formatStatus(occurrence.settlementStatus),

      settlementStatusBadgeClass: badgeClass[occurrence.settlementStatus] || DEFAULT_BADGE_CLASS,

      checkedInAt: occurrence.checkedInAt || null,

      checkedOutAt: occurrence.checkedOutAt || null,

      checkedInAtDisplay: ShiftViewService.formatDateTime(occurrence.checkedInAt),

      checkedOutAtDisplay: ShiftViewService.formatDateTime(occurrence.checkedOutAt),

      checkInPinUsedAt: occurrence.checkInPinUsedAt || null,

      checkOutPinUsedAt: occurrence.checkOutPinUsedAt || null,

      absenceExplanation: occurrence.absenceExplanation || null,

      absenceExplainedAt: occurrence.absenceExplainedAt || null,

      absenceExplainedAtDisplay: ShiftViewService.formatDateTime(occurrence.absenceExplainedAt),

      attendanceOverride: occurrence.attendanceOverride || null,

      lateCheckout: occurrence.lateCheckout || null,

      checkoutFallback: occurrence.checkoutFallback || null,

      overtime: occurrence.overtime || null,

      highlight,

      isSelectedOccurrence: highlight.isSelected,

      canViewAttendancePins: pinAuthorization.canViewAttendancePins,

      canRevealCheckInPin: pinAuthorization.canRevealCheckInPin,

      canRevealCheckOutPin: pinAuthorization.canRevealCheckOutPin,

      hasAttendanceAction: pinAuthorization.hasAvailablePin,

      pinAccess: {
        brandColor: PIN_BRAND_COLOR,

        displayFormat: PIN_DISPLAY_FORMAT,

        canViewAttendancePins: pinAuthorization.canViewAttendancePins,

        canRevealCheckInPin: pinAuthorization.canRevealCheckInPin,

        canRevealCheckOutPin: pinAuthorization.canRevealCheckOutPin,

        hasAvailablePin: pinAuthorization.hasAvailablePin,

        unavailableMessage: pinAuthorization.unavailableMessage,

        checkInPinUrl:
          highlight.isSelected && pinAuthorization.canRevealCheckInPin
            ? pinUrls.checkInPinUrl
            : null,

        checkOutPinUrl:
          highlight.isSelected && pinAuthorization.canRevealCheckOutPin
            ? pinUrls.checkOutPinUrl
            : null,
      },

      detailsUrl: occurrenceDetailsUrl,
    };
  }

  static buildRelevantOccurrenceSummary({ shift, occurrence, currentTime = new Date() }) {
    if (!occurrence) {
      return null;
    }

    const highlight = ShiftViewService.buildOccurrenceHighlight({
      occurrence,

      selectedOccurrence: occurrence,

      currentTime,
    });

    return {
      id: String(occurrence._id),

      referenceCode: occurrence.referenceCode,

      sequenceNumber: Number(occurrence.sequenceNumber || 0),

      sequenceLabel: `Shift ${Number(occurrence.sequenceNumber || 0)}`,

      occurrenceDate: ShiftPinAccessService.getOccurrenceLocalDate(occurrence),

      occurrenceDateDisplay: occurrence.occurrenceDate
        ? ShiftViewService.formatLocalDate(occurrence.occurrenceDate)
        : ShiftViewService.formatDate(occurrence.startTime),

      startTime: occurrence.startTime,

      endTime: occurrence.endTime,

      startTimeDisplay: ShiftViewService.formatTime(occurrence.startTime),

      endTimeDisplay: ShiftViewService.formatTime(occurrence.endTime),

      status: occurrence.status,

      statusLabel: formatStatus(occurrence.status),

      attendanceStatus: occurrence.attendanceStatus,

      attendanceStatusLabel: formatStatus(occurrence.attendanceStatus),

      assignmentStatus: occurrence.assignmentStatus,

      assignmentStatusLabel: formatStatus(occurrence.assignmentStatus),

      settlementStatus: occurrence.settlementStatus,

      settlementStatusLabel: formatStatus(occurrence.settlementStatus),

      refundStatus: occurrence.refundStatus || DEFAULT_REFUND_STATUS,

      refundStatusLabel: formatStatus(occurrence.refundStatus || DEFAULT_REFUND_STATUS),

      highlight,

      detailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}` + `?occurrence=${occurrence._id}`,
    };
  }

  /* ─────────────────────────────── LIFECYCLE ACTIONS ─────────────────────────────── */

  static buildShiftLifecycleActions({
    shift,
    occurrences = [],
    currentTime = new Date(),
    canManageLifecycle = false,
  }) {
    const occurrenceRows = Array.isArray(occurrences) ? occurrences : [];

    const normalizedCurrentTime = new Date(currentTime);

    const activeOccurrence =
      occurrenceRows.find((occurrence) => ShiftPinAccessService.isOccurrenceActive(occurrence)) ||
      null;

    const nextCancellableOccurrence =
      occurrenceRows.find(
        (occurrence) =>
          occurrence.status === "scheduled" &&
          occurrence.attendanceStatus === "not_started" &&
          !occurrence.cancelledAt &&
          new Date(occurrence.startTime) >= normalizedCurrentTime
      ) || null;

    const paymentStatus = String(shift.paymentStatus || "")
      .trim()
      .toLowerCase();

    const canCancelPendingFunding = Boolean(
      canManageLifecycle &&
      shift.status === "pending_funding" &&
      PAYMENT_REQUIRED_STATUSES.includes(paymentStatus) &&
      new Date(shift.startTime) > normalizedCurrentTime
    );

    const canCancelEngagement = Boolean(
      canManageLifecycle &&
      CANCELLABLE_ENGAGEMENT_STATUSES.includes(shift.status) &&
      !activeOccurrence &&
      nextCancellableOccurrence
    );

    const canEndShiftEarly = Boolean(
      canManageLifecycle &&
      activeOccurrence &&
      ACTIVE_WORK_CANCELLATION_PARENT_STATUSES.includes(shift.status)
    );

    const cancellationPreviewUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}` + "/cancellation-preview";

    const cancelShiftUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}` + "/cancel";

    const endShiftEarlyUrl = activeOccurrence
      ? `${EMPLOYER_SHIFTS_URL}/${shift._id}` +
        `/occurrences/${activeOccurrence._id}` +
        "/end-early"
      : null;

    const hasCancellationSummary = Boolean(
      shift.cancellationSummary?.firstAffectedOccurrence ||
      shift.cancellationSummary?.firstAffectedSequenceNumber ||
      Number(shift.cancellationSummary?.cancelledOccurrenceCount || 0) > 0 ||
      shift.cancellationSummary?.compensationApplicable === true
    );

    const activeWorkCancellationActionLabel = canEndShiftEarly ? "End Shift Early" : null;

    return {
      canCancelPendingFunding,

      canCancelEngagement,

      canEndShiftEarly,

      canCancel: canCancelPendingFunding || canCancelEngagement,

      cancellationPreviewUrl:
        canCancelPendingFunding || canCancelEngagement ? cancellationPreviewUrl : null,

      cancelShiftUrl: canCancelPendingFunding || canCancelEngagement ? cancelShiftUrl : null,

      endShiftEarlyUrl: canEndShiftEarly ? endShiftEarlyUrl : null,

      activeWorkCancellationUrl: canEndShiftEarly ? endShiftEarlyUrl : null,

      activeOccurrenceId: activeOccurrence ? String(activeOccurrence._id) : null,

      nextCancellableOccurrenceId: nextCancellableOccurrence
        ? String(nextCancellableOccurrence._id)
        : null,

      canViewCancellationBreakdown: Boolean(
        shift.status === "cancelled" ||
        hasCancellationSummary ||
        shift.activeWorkCancellation?.occurred === true
      ),

      cancellationActionLabel: canCancelPendingFunding
        ? "Cancel Shift"
        : canCancelEngagement
          ? "Cancel Engagement"
          : null,

      activeWorkCancellationActionLabel,

      earlyTerminationActionLabel: activeWorkCancellationActionLabel,
    };
  }

  /* ─────────────────────────────── PARENT ACTION ─────────────────────────────── */

  static buildParentShiftAction({
    shift,
    currency,
    employerWallet = null,
    occurrences = [],
    currentTime = new Date(),
  }) {
    const detailsUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}`;

    if (ShiftViewService.shiftNeedsPayment(shift, currentTime)) {
      const isRetry = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

      return {
        key: isRetry ? "retry_payment" : "complete_payment",

        label: isRetry ? "Retry Payment" : "Complete Payment",

        type: "funding_modal",

        isPrimary: true,

        href: detailsUrl,

        modalId: FUND_SHIFT_MODAL_ID,

        paymentReview: ShiftViewService.buildShiftPaymentReview({
          shift,

          occurrences,

          employerWallet,

          currency,

          currentTime,
        }),
      };
    }

    const actionByStatus = {
      open: {
        key: "manage_applications",

        label: "Manage Applications",
      },

      assigned: {
        key: "review_assignment",

        label: "Review Assignment",
      },

      confirmed: {
        key: "manage_shift",

        label: "Manage Shift",
      },

      in_progress: {
        key: "manage_attendance",

        label: "Manage Attendance",
      },

      pending_settlement: {
        key: "review_settlement",

        label: "Review Settlement",
      },

      disputed: {
        key: "review_dispute",

        label: "Review Dispute",
      },

      no_show: {
        key: "review_no_show",

        label: "Review No-show",
      },

      completed: {
        key: "view_details",

        label: "View Details",
      },

      cancelled: {
        key: "view_details",

        label: "View Details",
      },
    };

    const resolvedAction = actionByStatus[shift.status] || {
      key: "view_details",

      label: "View Details",
    };

    return {
      ...resolvedAction,

      type: "link",

      isPrimary: true,

      href: detailsUrl,

      modalId: null,

      paymentReview: null,
    };
  }

  /* ─────────────────────────────── SCHEDULE SUMMARY ─────────────────────────────── */

  static buildCompactScheduleSummary(shift, relevantOccurrence = null) {
    const scheduleMode = shift.scheduleMode || "single";

    if (scheduleMode === "multiple") {
      const occurrenceCount = Number(shift.occurrenceCount || 1);

      const repeatDaysLabel = ShiftViewService.formatRepeatDays(shift.repeatDays || []);

      const dailyStartTimeDisplay = ShiftViewService.formatTimeMinutesForDisplay(
        shift.dailyStartTimeMinutes
      );

      const dailyEndTimeDisplay = ShiftViewService.formatTimeMinutesForDisplay(
        shift.dailyEndTimeMinutes
      );

      return (
        `${occurrenceCount} shifts` +
        (repeatDaysLabel ? ` • ${repeatDaysLabel}` : "") +
        ` • ${dailyStartTimeDisplay}` +
        `–${dailyEndTimeDisplay}`
      );
    }

    const startTime = relevantOccurrence?.startTime || shift.startTime;

    const endTime = relevantOccurrence?.endTime || shift.endTime;

    return (
      `${ShiftViewService.formatDate(startTime)} • ` +
      `${ShiftViewService.formatTime(startTime)}–` +
      ShiftViewService.formatTime(endTime)
    );
  }

  /* ─────────────────────────────── EMPLOYER SHIFT CARD VIEW ─────────────────────────────── */

  static buildEmployerShiftView(
    shift,
    currency,
    currentTime = new Date(),
    occurrences = [],
    employerWallet = null
  ) {
    const occurrenceRows = Array.isArray(occurrences) ? [...occurrences] : [];

    const relevantOccurrence = ShiftPinAccessService.selectRelevantOccurrence(
      occurrenceRows,
      null,
      currentTime
    );

    const relevantOccurrenceView = ShiftViewService.buildRelevantOccurrenceSummary({
      shift,

      occurrence: relevantOccurrence,

      currentTime,
    });

    const occurrenceCount = Number(shift.occurrenceCount || occurrenceRows.length || 1);

    const professionalTypeLabel =
      PROFESSIONAL_TYPE_OPTIONS.find((option) => option.value === shift.professionalType)?.label ||
      formatStatus(shift.professionalType);

    const parentAction = ShiftViewService.buildParentShiftAction({
      shift,

      currency,

      employerWallet,

      occurrences: occurrenceRows,

      currentTime,
    });

    const displayStatus = ShiftViewService.getShiftDisplayStatus(shift);

    const needsPayment = ShiftViewService.shiftNeedsPayment(shift, currentTime);

    const paymentIsRetry = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

    return {
      id: String(shift._id),

      referenceCode: shift.referenceCode,

      detailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}`,

      branch: ShiftViewService.buildBranchView(shift.branch),

      roleTitle: shift.roleTitle,

      professionalType: shift.professionalType,

      professionalTypeLabel,

      scheduleMode: shift.scheduleMode || "single",

      scheduleModeLabel: shift.scheduleMode === "multiple" ? "Multiple Shifts" : "Single Shift",

      occurrenceCount,

      occurrenceCountLabel: `${occurrenceCount} ` + `${occurrenceCount === 1 ? "shift" : "shifts"}`,

      scheduleSummary: ShiftViewService.buildCompactScheduleSummary(shift, relevantOccurrence),

      relevantOccurrence: relevantOccurrenceView,

      hourlyRate: Number(shift.hourlyRate || 0),

      hourlyRateDisplay: ShiftViewService.formatAmount(shift.hourlyRate || 0, currency),

      estimatedEmployerCharge: Number(shift.estimatedEmployerCharge || 0),

      estimatedEmployerChargeDisplay: ShiftViewService.formatAmount(
        shift.estimatedEmployerCharge || 0,
        currency
      ),

      topUpRequired: Number(shift.topUpRequired || 0),

      topUpRequiredDisplay: ShiftViewService.formatAmount(shift.topUpRequired || 0, currency),

      refundedAmount: Number(shift.refundedAmount || 0),

      refundedAmountDisplay: ShiftViewService.formatAmount(shift.refundedAmount || 0, currency),

      totalApplications: Number(shift.totalApplications || 0),

      currentRoundApplications: Number(shift.currentRoundApplications || 0),

      status: shift.status,

      displayStatus: displayStatus.value,

      statusLabel: displayStatus.label,

      statusBadgeClass: displayStatus.badgeClass,

      isExpired: ShiftViewService.isExpiredUnfundedShift(shift),

      cancellationCode: shift.cancellationCode || null,

      cancelledAt: shift.cancelledAt || null,

      paymentStatus: shift.paymentStatus,

      paymentStatusLabel: formatStatus(shift.paymentStatus),

      paymentStatusBadgeClass: badgeClass[shift.paymentStatus] || DEFAULT_BADGE_CLASS,

      needsPayment,

      canCompletePayment: needsPayment && !paymentIsRetry,

      canRetryPayment: needsPayment && paymentIsRetry,

      parentAction,
    };
  }

  /* ─────────────────────────────── PAYMENT REVIEW ─────────────────────────────── */

  static buildShiftPaymentReview({
    shift,
    occurrences = [],
    employerWallet,
    currency,
    currentTime = new Date(),
  }) {
    const normalizedCurrency = String(currency || "")
      .trim()
      .toUpperCase();

    const walletCurrency = String(employerWallet?.currency || "")
      .trim()
      .toUpperCase();

    const availableBalance = Number(employerWallet?.availableBalance || 0);

    const employerCharge = Number(shift.estimatedEmployerCharge || 0);

    const walletIsActive = employerWallet?.status === "active";

    const walletCurrencyMatches = Boolean(walletCurrency) && walletCurrency === normalizedCurrency;

    const walletHasSufficientBalance = availableBalance >= employerCharge;

    const needsPayment = ShiftViewService.shiftNeedsPayment(shift, currentTime);

    const canFundFromWallet = Boolean(
      needsPayment && walletIsActive && walletCurrencyMatches && walletHasSufficientBalance
    );

    const walletShortfall = Math.max(employerCharge - availableBalance, 0);

    const walletBalanceAfterPayment = Math.max(availableBalance - employerCharge, 0);

    let walletUnavailableMessage = null;

    if (!needsPayment) {
      walletUnavailableMessage = "This Shift does not currently require funding.";
    } else if (!walletIsActive) {
      walletUnavailableMessage = "Your employer wallet is not active.";
    } else if (!walletCurrencyMatches) {
      walletUnavailableMessage = "Your wallet currency does not match the Shift currency.";
    } else if (!walletHasSufficientBalance) {
      walletUnavailableMessage = "Your wallet balance is not sufficient to fund this Shift.";
    }

    const scheduleMode = shift.scheduleMode || "single";

    const occurrenceRows = Array.isArray(occurrences) ? [...occurrences] : [];

    occurrenceRows.sort(
      (left, right) => Number(left.sequenceNumber || 0) - Number(right.sequenceNumber || 0)
    );

    const occurrenceCount = Number(shift.occurrenceCount || occurrenceRows.length || 1);

    const scheduledMinutesPerOccurrence = Number(
      shift.scheduledMinutesPerOccurrence ||
        occurrenceRows[0]?.scheduledMinutes ||
        shift.totalScheduledMinutes ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const totalScheduledMinutes = Number(
      shift.totalScheduledMinutes ||
        occurrenceRows.reduce(
          (sum, occurrence) => sum + Number(occurrence.scheduledMinutes || 0),
          0
        ) ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const firstOccurrence = occurrenceRows[0] || null;

    const lastOccurrence = occurrenceRows[occurrenceRows.length - 1] || null;

    const startTimeDisplay =
      scheduleMode === "multiple"
        ? ShiftViewService.formatTimeMinutesForDisplay(shift.dailyStartTimeMinutes)
        : ShiftViewService.formatTime(firstOccurrence?.startTime || shift.startTime);

    const endTimeDisplay =
      scheduleMode === "multiple"
        ? ShiftViewService.formatTimeMinutesForDisplay(shift.dailyEndTimeMinutes)
        : ShiftViewService.formatTime(firstOccurrence?.endTime || shift.endTime);

    const perOccurrenceProfessionalPay = Number(
      firstOccurrence?.estimatedProfessionalPay ||
        (occurrenceCount > 0
          ? Math.round(Number(shift.estimatedProfessionalPay || 0) / occurrenceCount)
          : 0)
    );

    const perOccurrencePlatformFee = Number(
      firstOccurrence?.estimatedPlatformFee ||
        (occurrenceCount > 0
          ? Math.round(Number(shift.estimatedPlatformFee || 0) / occurrenceCount)
          : 0)
    );

    const perOccurrenceEmployerCharge = Number(
      firstOccurrence?.estimatedEmployerCharge ||
        perOccurrenceProfessionalPay + perOccurrencePlatformFee
    );

    const isRetryPayment = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

    return {
      shiftId: String(shift._id),

      referenceCode: shift.referenceCode,

      status: shift.status,

      paymentStatus: shift.paymentStatus,

      needsPayment,

      isRetryPayment,

      actionLabel: isRetryPayment ? "Retry Payment" : "Complete Payment",

      currency: normalizedCurrency,

      schedule: {
        scheduleMode,

        scheduleModeLabel: scheduleMode === "multiple" ? "Multiple Shifts" : "Single Shift",

        occurrenceCount,

        occurrenceCountLabel:
          `${occurrenceCount} ` + `${occurrenceCount === 1 ? "shift" : "shifts"}`,

        repeatDays: shift.repeatDays || [],

        repeatDaysLabel: ShiftViewService.formatRepeatDays(shift.repeatDays || []),

        firstOccurrenceDate: shift.firstOccurrenceDate || firstOccurrence?.occurrenceDate || null,

        lastOccurrenceDate: shift.lastOccurrenceDate || lastOccurrence?.occurrenceDate || null,

        firstOccurrenceDateDisplay: firstOccurrence
          ? ShiftViewService.formatDate(firstOccurrence.startTime)
          : shift.firstOccurrenceDate
            ? ShiftViewService.formatLocalDate(shift.firstOccurrenceDate)
            : ShiftViewService.formatDate(shift.startTime),

        lastOccurrenceDateDisplay: lastOccurrence
          ? ShiftViewService.formatDate(lastOccurrence.startTime)
          : shift.lastOccurrenceDate
            ? ShiftViewService.formatLocalDate(shift.lastOccurrenceDate)
            : ShiftViewService.formatDate(shift.endTime),

        startTimeDisplay,

        endTimeDisplay,

        endsNextDay: shift.endsNextDay === true,

        scheduledMinutesPerOccurrence,

        scheduledHoursPerOccurrenceDisplay: ShiftViewService.formatScheduledMinutes(
          scheduledMinutesPerOccurrence
        ),

        totalScheduledMinutes,

        totalScheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(totalScheduledMinutes),

        occurrences: occurrenceRows.map((occurrence) => ({
          id: String(occurrence._id),

          referenceCode: occurrence.referenceCode,

          sequenceNumber: occurrence.sequenceNumber,

          occurrenceDate: occurrence.occurrenceDate,

          occurrenceDateDisplay: occurrence.occurrenceDate
            ? ShiftViewService.formatLocalDate(occurrence.occurrenceDate)
            : ShiftViewService.formatDate(occurrence.startTime),

          startTime: occurrence.startTime,

          endTime: occurrence.endTime,

          startTimeDisplay: ShiftViewService.formatTime(occurrence.startTime),

          endTimeDisplay: ShiftViewService.formatTime(occurrence.endTime),

          scheduledMinutes: occurrence.scheduledMinutes,

          scheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(
            occurrence.scheduledMinutes
          ),

          fillCutoffAt: occurrence.fillCutoffAt || null,
        })),
      },

      perOccurrence: {
        professionalPay: perOccurrenceProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(
          perOccurrenceProfessionalPay,
          normalizedCurrency
        ),

        platformFee: perOccurrencePlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(
          perOccurrencePlatformFee,
          normalizedCurrency
        ),

        employerCharge: perOccurrenceEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(
          perOccurrenceEmployerCharge,
          normalizedCurrency
        ),
      },

      professionalPay: shift.estimatedProfessionalPay,

      professionalPayDisplay: ShiftViewService.formatAmount(
        shift.estimatedProfessionalPay,
        normalizedCurrency
      ),

      platformFee: shift.estimatedPlatformFee,

      platformFeeDisplay: ShiftViewService.formatAmount(
        shift.estimatedPlatformFee,
        normalizedCurrency
      ),

      employerCharge,

      employerChargeDisplay: ShiftViewService.formatAmount(employerCharge, normalizedCurrency),

      paymentOptions: {
        wallet: {
          method: "wallet",

          label: "Employer Wallet",

          walletStatus: employerWallet?.status || null,

          availableBalance,

          availableBalanceDisplay: ShiftViewService.formatAmount(
            availableBalance,
            normalizedCurrency
          ),

          canUse: canFundFromWallet,

          shortfall: walletShortfall,

          shortfallDisplay: ShiftViewService.formatAmount(walletShortfall, normalizedCurrency),

          balanceAfterPayment: walletBalanceAfterPayment,

          balanceAfterPaymentDisplay: ShiftViewService.formatAmount(
            walletBalanceAfterPayment,
            normalizedCurrency
          ),

          unavailableMessage: walletUnavailableMessage,
        },

        paystackCheckout: {
          method: "paystack_checkout",

          label: "Paystack Checkout",

          canUse: needsPayment,

          description: "Pay securely with a Paystack-supported payment method.",
        },
      },

      actions: {
        fundFromWalletUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}` + "/fund-from-wallet",

        initializeCheckoutUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}` + "/initialize-checkout",

        shiftDetailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}`,
      },
    };
  }

  static buildFundingModalView({ employerWallet, currency }) {
    const normalizedCurrency = String(currency || DEFAULT_CURRENCY)
      .trim()
      .toUpperCase();

    const availableBalance = Number(employerWallet?.availableBalance || 0);

    return {
      modalId: FUND_SHIFT_MODAL_ID,

      title: "Fund Shift",

      brandColor: PIN_BRAND_COLOR,

      currency: normalizedCurrency,

      wallet: {
        status: employerWallet?.status || null,

        currency: employerWallet?.currency || normalizedCurrency,

        availableBalance,

        availableBalanceDisplay: ShiftViewService.formatAmount(
          availableBalance,
          normalizedCurrency
        ),
      },

      methods: [
        {
          value: "wallet",

          label: "Employer Wallet",
        },
        {
          value: "paystack_checkout",

          label: "Paystack Checkout",
        },
      ],
    };
  }

  /* ─────────────────────────────── EMPLOYER SHIFT DETAILS VIEW ─────────────────────────────── */

  static buildEmployerShiftDetailsView({
    shift,
    occurrences = [],
    selectedOccurrenceId = null,
    employerWallet,
    currency,
    currentTime = new Date(),
    canManageLifecycle = false,
  }) {
    const scheduleMode = shift.scheduleMode || "single";

    const occurrenceRows = Array.isArray(occurrences) ? [...occurrences] : [];

    occurrenceRows.sort(
      (left, right) => Number(left.sequenceNumber || 0) - Number(right.sequenceNumber || 0)
    );

    const selectedOccurrence = ShiftPinAccessService.selectRelevantOccurrence(
      occurrenceRows,
      selectedOccurrenceId,
      currentTime
    );

    const occurrenceViews = occurrenceRows.map((occurrence) =>
      ShiftViewService.buildEmployerOccurrenceView({
        shift,

        occurrence,

        currency,

        currentTime,

        selectedOccurrence,
      })
    );

    const selectedOccurrenceView = selectedOccurrence
      ? occurrenceViews.find(
          (occurrenceView) => occurrenceView.id === String(selectedOccurrence._id)
        ) || null
      : null;

    const occurrenceCount = Number(shift.occurrenceCount || occurrenceViews.length || 1);

    const perOccurrenceMinutes = Number(
      shift.scheduledMinutesPerOccurrence ||
        occurrenceViews[0]?.scheduledMinutes ||
        shift.totalScheduledMinutes ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const totalScheduledMinutes = Number(
      shift.totalScheduledMinutes ||
        occurrenceViews.reduce(
          (sum, occurrenceView) => sum + Number(occurrenceView.scheduledMinutes || 0),
          0
        ) ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const repeatDaysLabel = ShiftViewService.formatRepeatDays(shift.repeatDays || []);

    const dailyStartTimeDisplay = ShiftViewService.formatTimeMinutesForDisplay(
      shift.dailyStartTimeMinutes
    );

    const dailyEndTimeDisplay = ShiftViewService.formatTimeMinutesForDisplay(
      shift.dailyEndTimeMinutes
    );

    const professionalTypeLabel =
      PROFESSIONAL_TYPE_OPTIONS.find((option) => option.value === shift.professionalType)?.label ||
      formatStatus(shift.professionalType);

    const firstOccurrenceView = occurrenceViews[0] || null;

    const lastOccurrenceView = occurrenceViews[occurrenceViews.length - 1] || null;

    const firstOccurrenceDateDisplay =
      firstOccurrenceView?.occurrenceDateDisplay ||
      (shift.firstOccurrenceDate
        ? ShiftViewService.formatLocalDate(shift.firstOccurrenceDate)
        : ShiftViewService.formatDate(shift.startTime));

    const lastOccurrenceDateDisplay =
      lastOccurrenceView?.occurrenceDateDisplay ||
      (shift.lastOccurrenceDate
        ? ShiftViewService.formatLocalDate(shift.lastOccurrenceDate)
        : ShiftViewService.formatDate(shift.endTime));

    const scheduleSummary = ShiftViewService.buildCompactScheduleSummary(shift, selectedOccurrence);

    const parentAction = ShiftViewService.buildParentShiftAction({
      shift,

      currency,

      employerWallet,

      occurrences: occurrenceRows,

      currentTime,
    });

    const paymentReview = ShiftViewService.buildShiftPaymentReview({
      shift,

      occurrences: occurrenceRows,

      employerWallet,

      currency,

      currentTime,
    });

    const lifecycleActions = ShiftViewService.buildShiftLifecycleActions({
      shift,

      occurrences: occurrenceRows,

      currentTime,

      canManageLifecycle,
    });

    const displayStatus = ShiftViewService.getShiftDisplayStatus(shift);

    const needsPayment = ShiftViewService.shiftNeedsPayment(shift, currentTime);

    const paymentIsRetry = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

    return {
      id: String(shift._id),

      referenceCode: shift.referenceCode,

      detailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}`,

      branch: ShiftViewService.buildBranchView(shift.branch),

      department: shift.department || null,

      roleTitle: shift.roleTitle,

      professionalType: shift.professionalType,

      professionalTypeLabel,

      requiredSkills: Array.isArray(shift.requiredSkills) ? shift.requiredSkills : [],

      dressCode: shift.dressCode || null,

      description: shift.description || null,

      scheduleMode,

      scheduleModeLabel: scheduleMode === "multiple" ? "Multiple Shifts" : "Single Shift",

      isMultipleShift: scheduleMode === "multiple",

      occurrenceCount,

      occurrenceCountLabel: `${occurrenceCount} ` + `${occurrenceCount === 1 ? "shift" : "shifts"}`,

      occurrences: occurrenceViews,

      hasOccurrences: occurrenceViews.length > 0,

      selectedOccurrence: selectedOccurrenceView,

      selectedOccurrenceId: selectedOccurrenceView?.id || null,

      repeatDays: shift.repeatDays || [],

      repeatDaysLabel,

      firstOccurrenceDate: shift.firstOccurrenceDate || null,

      lastOccurrenceDate: shift.lastOccurrenceDate || null,

      firstOccurrenceDateDisplay,

      lastOccurrenceDateDisplay,

      scheduleTimeZone: shift.scheduleTimeZone || ShiftScheduleService.getTimeZone(),

      dailyStartTimeMinutes: shift.dailyStartTimeMinutes,

      dailyEndTimeMinutes: shift.dailyEndTimeMinutes,

      dailyStartTimeDisplay,

      dailyEndTimeDisplay,

      endsNextDay: shift.endsNextDay === true,

      status: shift.status,

      displayStatus: displayStatus.value,

      statusLabel: displayStatus.label,

      statusBadgeClass: displayStatus.badgeClass,

      isExpired: ShiftViewService.isExpiredUnfundedShift(shift),

      paymentStatus: shift.paymentStatus,

      paymentStatusLabel: formatStatus(shift.paymentStatus),

      paymentStatusBadgeClass: badgeClass[shift.paymentStatus] || DEFAULT_BADGE_CLASS,

      attendanceStatus: selectedOccurrenceView?.attendanceStatus || shift.attendanceStatus,

      attendanceStatusLabel: formatStatus(
        selectedOccurrenceView?.attendanceStatus || shift.attendanceStatus
      ),

      startTime: shift.startTime,

      endTime: shift.endTime,

      startDateDisplay: firstOccurrenceDateDisplay,

      endDateDisplay: lastOccurrenceDateDisplay,

      startTimeDisplay:
        firstOccurrenceView?.startTimeDisplay || ShiftViewService.formatTime(shift.startTime),

      endTimeDisplay:
        scheduleMode === "multiple"
          ? dailyEndTimeDisplay
          : firstOccurrenceView?.endTimeDisplay || ShiftViewService.formatTime(shift.endTime),

      scheduledMinutesPerOccurrence: perOccurrenceMinutes,

      scheduledHoursPerOccurrence:
        perOccurrenceMinutes > 0 ? Number((perOccurrenceMinutes / 60).toFixed(4)) : null,

      scheduledHoursPerOccurrenceDisplay:
        ShiftViewService.formatScheduledMinutes(perOccurrenceMinutes),

      totalScheduledMinutes,

      totalScheduledHours:
        totalScheduledMinutes > 0 ? Number((totalScheduledMinutes / 60).toFixed(4)) : null,

      totalScheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(totalScheduledMinutes),

      scheduledHours: shift.scheduledHours,

      scheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(totalScheduledMinutes),

      scheduleSummary,

      breakDuration: shift.breakDuration || 0,

      breakDurationDisplay: ShiftViewService.formatBreakDuration(shift.breakDuration),

      hourlyRate: shift.hourlyRate,

      hourlyRateDisplay: ShiftViewService.formatAmount(shift.hourlyRate, currency),

      platformFeeRate: shift.platformFeeRate,

      platformFeePercent: Number((Number(shift.platformFeeRate || 0) * 100).toFixed(2)),

      pricingLockedAt: shift.pricingLockedAt || null,

      pricingLockedAtDisplay: ShiftViewService.formatDateTime(shift.pricingLockedAt),

      pricingLockedBy: ShiftViewService.toId(shift.pricingLockedBy),

      estimatedProfessionalPay: shift.estimatedProfessionalPay,

      estimatedProfessionalPayDisplay: ShiftViewService.formatAmount(
        shift.estimatedProfessionalPay,
        currency
      ),

      estimatedPlatformFee: shift.estimatedPlatformFee,

      estimatedPlatformFeeDisplay: ShiftViewService.formatAmount(
        shift.estimatedPlatformFee,
        currency
      ),

      estimatedEmployerCharge: shift.estimatedEmployerCharge,

      estimatedEmployerChargeDisplay: ShiftViewService.formatAmount(
        shift.estimatedEmployerCharge,
        currency
      ),

      estimatedProfessionalPayPerOccurrence: firstOccurrenceView?.estimatedProfessionalPay || 0,

      estimatedProfessionalPayPerOccurrenceDisplay:
        firstOccurrenceView?.estimatedProfessionalPayDisplay ||
        ShiftViewService.formatAmount(0, currency),

      estimatedPlatformFeePerOccurrence: firstOccurrenceView?.estimatedPlatformFee || 0,

      estimatedPlatformFeePerOccurrenceDisplay:
        firstOccurrenceView?.estimatedPlatformFeeDisplay ||
        ShiftViewService.formatAmount(0, currency),

      estimatedEmployerChargePerOccurrence: firstOccurrenceView?.estimatedEmployerCharge || 0,

      estimatedEmployerChargePerOccurrenceDisplay:
        firstOccurrenceView?.estimatedEmployerChargeDisplay ||
        ShiftViewService.formatAmount(0, currency),

      fundingMethod: shift.fundingMethod || null,

      fundingMethodLabel:
        shift.fundingMethod === "paystack_checkout"
          ? "Paystack Checkout"
          : shift.fundingMethod === "wallet"
            ? "Employer Wallet"
            : "Not selected",

      fundedAmount: Number(shift.fundedAmount || 0),

      fundedAmountDisplay: ShiftViewService.formatAmount(shift.fundedAmount || 0, currency),

      topUpRequired: Number(shift.topUpRequired || 0),

      topUpRequiredDisplay: ShiftViewService.formatAmount(shift.topUpRequired || 0, currency),

      refundedAmount: Number(shift.refundedAmount || 0),

      refundedAmountDisplay: ShiftViewService.formatAmount(shift.refundedAmount || 0, currency),

      fundingTransaction: ShiftViewService.toId(shift.fundingTransaction),

      fundingInitiatedAt: shift.fundingInitiatedAt || null,

      fundingInitiatedAtDisplay: ShiftViewService.formatDateTime(shift.fundingInitiatedAt),

      fundedAt: shift.fundedAt || null,

      fundedAtDisplay: ShiftViewService.formatDateTime(shift.fundedAt),

      publishedAt: shift.publishedAt || null,

      publishedAtDisplay: ShiftViewService.formatDateTime(shift.publishedAt),

      totalApplications: Number(shift.totalApplications || 0),

      currentRoundApplications: Number(shift.currentRoundApplications || 0),

      applicationRound: Number(shift.applicationRound || 1),

      occurrenceProgress: shift.occurrenceProgress || null,

      settlementSummary: shift.settlementSummary || null,

      replacementHiring: shift.replacementHiring || null,

      activeAssignment: ShiftViewService.toId(shift.activeAssignment),

      assignedProfessional: ShiftViewService.toId(shift.assignedProfessional),

      isAssigned: Boolean(
        shift.assignedProfessional ||
        occurrenceViews.some((occurrenceView) => occurrenceView.hasAssignment)
      ),

      needsPayment,

      canCompletePayment: needsPayment && !paymentIsRetry,

      canRetryPayment: needsPayment && paymentIsRetry,

      parentAction,

      paymentReview,

      lifecycleActions,

      cancellationPolicySnapshot: shift.cancellationPolicySnapshot || null,

      cancellationCode: shift.cancellationCode || null,

      cancelledFromStatus: shift.cancelledFromStatus || null,

      cancelledBy: shift.cancelledBy || null,

      cancelledByUser: ShiftViewService.toId(shift.cancelledByUser),

      /*
       * Parent-only structured cancellation
       * reason. Occurrence cancellation does
       * not carry this field.
       */
      cancellationReasonCode: shift.cancellationReasonCode || null,

      cancellationReason: shift.cancellationReason || null,

      cancelledAt: shift.cancelledAt || null,

      cancelledAtDisplay: ShiftViewService.formatDateTime(shift.cancelledAt),

      cancellationSummary: shift.cancellationSummary || null,

      activeWorkCancellation: shift.activeWorkCancellation || null,

      pinPanel: {
        brandColor: PIN_BRAND_COLOR,

        displayFormat: PIN_DISPLAY_FORMAT,

        selectedOccurrenceId: selectedOccurrenceView?.id || null,

        hasAvailablePin: Boolean(selectedOccurrenceView?.pinAccess?.hasAvailablePin),

        canViewAttendancePins: Boolean(selectedOccurrenceView?.pinAccess?.canViewAttendancePins),

        canRevealCheckInPin: Boolean(selectedOccurrenceView?.pinAccess?.canRevealCheckInPin),

        canRevealCheckOutPin: Boolean(selectedOccurrenceView?.pinAccess?.canRevealCheckOutPin),

        checkInPinUrl: selectedOccurrenceView?.pinAccess?.checkInPinUrl || null,

        checkOutPinUrl: selectedOccurrenceView?.pinAccess?.checkOutPinUrl || null,

        unavailableMessage:
          selectedOccurrenceView?.pinAccess?.unavailableMessage ||
          PIN_SELECTION_UNAVAILABLE_MESSAGE,
      },
    };
  }
}

module.exports = ShiftViewService;
