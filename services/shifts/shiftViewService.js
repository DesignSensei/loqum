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
const EMPLOYER_CASES_URL = "/employer/cases";

const PAYMENT_REQUIRED_STATUSES = Object.freeze(["unpaid"]);

const CANCELLABLE_ENGAGEMENT_STATUSES = Object.freeze([
  "open",
  "assigned",
  "confirmed",
  "in_progress",
]);

const ACTIVE_WORK_CANCELLATION_PARENT_STATUSES = Object.freeze(["confirmed", "in_progress"]);

const ATTENDANCE_REVIEW_STATUSES = Object.freeze([
  "missed_checkin_review",
  "checkout_fallback_review",
]);

const PIN_SELECTION_UNAVAILABLE_MESSAGE = "Select an occurrence to view its attendance PIN state.";

const REFUND_HOLD_PRESENTATION = Object.freeze({
  professional_claim_pending: Object.freeze({
    label: "Professional claim pending",
    message: "This refund is held while a professional claim affecting BASE remains unresolved.",
  }),

  employer_dispute_pending: Object.freeze({
    label: "Employer dispute pending",
    message: "This refund is held while an employer dispute affecting BASE remains unresolved.",
  }),

  dispute_pending: Object.freeze({
    label: "Employer dispute pending",
    message: "This refund is held while an employer dispute affecting BASE remains unresolved.",
  }),

  challenge_window_open: Object.freeze({
    label: "Review window open",
    message: "This refund is held while BASE remains challengeable in the shared review window.",
  }),

  claim_window_open: Object.freeze({
    label: "Review window open",
    message: "This refund is held while the occurrence review window remains open.",
  }),

  attendance_review_pending: Object.freeze({
    label: "Attendance review pending",
    message: "This refund is held until the outstanding attendance review is resolved.",
  }),

  professional_settlement_pending: Object.freeze({
    label: "Professional settlement pending",
    message: "This refund is held until the required BASE professional payout has been released.",
  }),

  manual_review: Object.freeze({
    label: "Manual review",
    message: "This refund is being held for manual review.",
  }),

  other: Object.freeze({
    label: "Refund on hold",
    message: "This refund is temporarily on hold.",
  }),
});

const ATTENTION_PRIORITIES = Object.freeze({
  OVERTIME_RESTRICTION: 10,
  OVERTIME_OVERDUE: 20,
  OVERTIME_TOPUP: 30,
  OVERTIME_REVIEW: 40,
  PROFESSIONAL_CLAIM_REVIEW: 50,
  ATTENDANCE_REVIEW: 60,
  REPLACEMENT_REQUIRED: 70,
  PROFESSIONAL_CLAIM: 80,
  EMPLOYER_DISPUTE: 90,
  CHALLENGE_WINDOW: 100,
  REFUND_HELD: 110,
  REFUND_PROCESSING: 120,
  EXPIRED_UNFILLED: 130,
});

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

  /* ─────────────────────────────── EMPLOYER VIEW PERMISSIONS ─────────────────────────────── */

  static normalizeEmployerViewPermissions(permissions = null) {
    const source = permissions && typeof permissions === "object" ? permissions : {};

    return {
      canViewWallet: source.canViewWallet === true,

      canFundShifts: source.canFundShifts === true,

      canPostShifts: source.canPostShifts === true,

      canManageFinancialObligations: source.canManageFinancialObligations === true,

      canManageLifecycle: source.canManageLifecycle === true,

      canManagePostShiftWorkflows: source.canManagePostShiftWorkflows === true,

      canManageClaims: source.canManageClaims === true,

      canManageDisputes: source.canManageDisputes === true,

      canViewRefunds: source.canViewRefunds === true,

      canManageRefundActions: source.canManageRefundActions === true,
    };
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

    return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
  }

  static formatScheduledMinutes(value) {
    const totalMinutes = Number(value);

    if (!Number.isSafeInteger(totalMinutes) || totalMinutes <= 0) {
      return "-";
    }

    const wholeHours = Math.floor(totalMinutes / 60);

    const remainingMinutes = totalMinutes % 60;

    if (wholeHours === 0) {
      return `${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}`;
    }

    if (remainingMinutes === 0) {
      return `${wholeHours} ${wholeHours === 1 ? "hour" : "hours"}`;
    }

    return (
      `${wholeHours} ${wholeHours === 1 ? "hour" : "hours"} ` +
      `${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}`
    );
  }

  static formatScheduledHours(value) {
    const hours = Number(value);

    if (!Number.isFinite(hours)) {
      return "-";
    }

    const displayHours = Number(hours.toFixed(2));

    return `${displayHours} ${displayHours === 1 ? "hour" : "hours"}`;
  }

  static formatBreakDuration(value) {
    const minutes = Number(value || 0);

    if (!Number.isFinite(minutes) || minutes <= 0) {
      return "No declared break";
    }

    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
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

  static formatMinutes(value) {
    const minutes = Number(value);

    if (!Number.isSafeInteger(minutes) || minutes < 0) {
      return "-";
    }

    if (minutes === 0) {
      return "0 minutes";
    }

    return ShiftViewService.formatScheduledMinutes(minutes);
  }

  static toId(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "object" && value._id) {
      return String(value._id);
    }

    return String(value);
  }

  static normalizePositiveCount(value, fallback = 1) {
    const normalized = Number(value);

    if (Number.isSafeInteger(normalized) && normalized > 0) {
      return normalized;
    }

    return fallback;
  }

  static getRequiredProfessionals(shift) {
    return ShiftViewService.normalizePositiveCount(shift?.requiredProfessionals, 1);
  }

  static getScheduledDateCount(shift, occurrences = []) {
    const configuredCount = Number(shift?.occurrenceCount);

    if (Number.isSafeInteger(configuredCount) && configuredCount > 0) {
      return configuredCount;
    }

    const maximumSequence = (Array.isArray(occurrences) ? occurrences : []).reduce(
      (maximum, occurrence) => {
        const sequenceNumber = Number(occurrence?.sequenceNumber);

        return Number.isSafeInteger(sequenceNumber) && sequenceNumber > maximum
          ? sequenceNumber
          : maximum;
      },
      0
    );

    return maximumSequence > 0 ? maximumSequence : 1;
  }

  static getTotalOccurrenceCount(shift, occurrences = []) {
    const configuredCount = Number(shift?.totalOccurrenceCount);

    if (Number.isSafeInteger(configuredCount) && configuredCount > 0) {
      return configuredCount;
    }

    const scheduledDateCount = ShiftViewService.getScheduledDateCount(shift, occurrences);

    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const calculated = scheduledDateCount * requiredProfessionals;

    if (Number.isSafeInteger(calculated) && calculated > 0) {
      return calculated;
    }

    return Array.isArray(occurrences) && occurrences.length > 0 ? occurrences.length : 1;
  }

  static compareOccurrences(left, right) {
    const leftSlot = ShiftViewService.normalizePositiveCount(left?.slotNumber, 1);

    const rightSlot = ShiftViewService.normalizePositiveCount(right?.slotNumber, 1);

    if (leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }

    const leftSequence = ShiftViewService.normalizePositiveCount(left?.sequenceNumber, 1);

    const rightSequence = ShiftViewService.normalizePositiveCount(right?.sequenceNumber, 1);

    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }

    const leftStart = left?.startTime ? new Date(left.startTime).getTime() : 0;

    const rightStart = right?.startTime ? new Date(right.startTime).getTime() : 0;

    if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) {
      return leftStart - rightStart;
    }

    return String(left?._id || "").localeCompare(String(right?._id || ""));
  }

  static sortOccurrences(occurrences = []) {
    return (Array.isArray(occurrences) ? [...occurrences] : []).sort(
      ShiftViewService.compareOccurrences
    );
  }

  static buildOccurrenceIdentity({ shift, occurrence }) {
    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const scheduledDateCount = ShiftViewService.getScheduledDateCount(
      shift,
      occurrence ? [occurrence] : []
    );

    const slotNumber = ShiftViewService.normalizePositiveCount(occurrence?.slotNumber, 1);

    const sequenceNumber = ShiftViewService.normalizePositiveCount(occurrence?.sequenceNumber, 1);

    const positionLabel =
      requiredProfessionals > 1
        ? `Position ${slotNumber} of ${requiredProfessionals}`
        : "Position 1";

    const dateLabel =
      scheduledDateCount > 1
        ? `Work date ${sequenceNumber} of ${scheduledDateCount}`
        : "Work date 1";

    return {
      slotNumber,

      sequenceNumber,

      requiredProfessionals,

      scheduledDateCount,

      positionLabel,

      dateLabel,

      occurrenceLabel: requiredProfessionals > 1 ? `${positionLabel} • ${dateLabel}` : dateLabel,
    };
  }

  static buildPricingSnapshotView(source) {
    const standardBasePlatformFeeRate = Number(source?.standardBasePlatformFeeRate || 0);

    const basePlatformFeeRate = Number(source?.basePlatformFeeRate || 0);

    const overtimePlatformFeeRate = Number(source?.overtimePlatformFeeRate || 0);

    return {
      standardBasePlatformFeeRate,

      standardBasePlatformFeePercent: Number((standardBasePlatformFeeRate * 100).toFixed(2)),

      basePlatformFeeRate,

      basePlatformFeePercent: Number((basePlatformFeeRate * 100).toFixed(2)),

      overtimePlatformFeeRate,

      overtimePlatformFeePercent: Number((overtimePlatformFeeRate * 100).toFixed(2)),

      basePlatformFeeBenefitSource: source?.basePlatformFeeBenefitSource || "standard",

      basePlatformFeeSubscription: ShiftViewService.toId(source?.basePlatformFeeSubscription),
    };
  }

  static sumMoney(values, label) {
    return money.sumMinorUnitAmounts(
      (Array.isArray(values) ? values : []).map((value) => Number(value || 0)),
      label
    );
  }

  static exactPerOccurrenceAmount(totalAmount, totalOccurrenceCount) {
    const total = Number(totalAmount || 0);

    const count = Number(totalOccurrenceCount);

    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      total % count !== 0
    ) {
      return 0;
    }

    return total / count;
  }

  static buildStaffingSummary({ shift, occurrences = [] }) {
    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const scheduledDateCount = ShiftViewService.getScheduledDateCount(shift, occurrenceRows);

    const totalOccurrenceCount = ShiftViewService.getTotalOccurrenceCount(shift, occurrenceRows);

    const rawInitialAcceptedCount = Number(shift?.hiringSummary?.initialAcceptedCount || 0);

    const initialAcceptedCount = Math.min(
      Number.isSafeInteger(rawInitialAcceptedCount) && rawInitialAcceptedCount >= 0
        ? rawInitialAcceptedCount
        : 0,
      requiredProfessionals
    );

    const initialAvailablePositionCount = Math.max(requiredProfessionals - initialAcceptedCount, 0);

    const rawOpenReplacementCount = Number(shift?.hiringSummary?.openReplacementCount || 0);

    const openReplacementCount =
      Number.isSafeInteger(rawOpenReplacementCount) && rawOpenReplacementCount >= 0
        ? rawOpenReplacementCount
        : 0;

    const slotSummaries = [];

    for (let slotNumber = 1; slotNumber <= requiredProfessionals; slotNumber += 1) {
      const slotOccurrences = occurrenceRows.filter(
        (occurrence) =>
          ShiftViewService.normalizePositiveCount(occurrence?.slotNumber, 1) === slotNumber
      );

      const assignedOccurrenceCount = slotOccurrences.filter(
        (occurrence) =>
          occurrence?.assignmentStatus === "assigned" &&
          occurrence?.assignment &&
          occurrence?.assignedProfessional
      ).length;

      const unassignedOccurrenceCount = slotOccurrences.filter(
        (occurrence) => occurrence?.assignmentStatus === "unassigned"
      ).length;

      const replacementRequiredOccurrenceCount = slotOccurrences.filter(
        (occurrence) =>
          occurrence?.assignmentStatus === "replacement_required" ||
          Boolean(occurrence?.replacementRequiredAt)
      ).length;

      const expiredUnfilledOccurrenceCount = slotOccurrences.filter(
        (occurrence) =>
          occurrence?.assignmentStatus === "expired_unfilled" ||
          occurrence?.status === "expired_unfilled" ||
          Boolean(occurrence?.expiredUnfilledAt)
      ).length;

      const professionalIds = [
        ...new Set(
          slotOccurrences
            .map((occurrence) => ShiftViewService.toId(occurrence?.assignedProfessional))
            .filter(Boolean)
        ),
      ];

      slotSummaries.push({
        slotNumber,

        label: requiredProfessionals > 1 ? `Position ${slotNumber}` : "Position 1",

        scheduledDateCount,

        occurrenceCount: slotOccurrences.length,

        assignedOccurrenceCount,

        unassignedOccurrenceCount,

        replacementRequiredOccurrenceCount,

        expiredUnfilledOccurrenceCount,

        professionalIds,

        hasAssignedCoverage: assignedOccurrenceCount > 0,

        hasCoverageGap:
          unassignedOccurrenceCount > 0 ||
          replacementRequiredOccurrenceCount > 0 ||
          expiredUnfilledOccurrenceCount > 0,
      });
    }

    const positionsWithAssignedCoverage = slotSummaries.filter(
      (slot) => slot.hasAssignedCoverage
    ).length;

    const positionsWithCoverageGaps = slotSummaries.filter((slot) => slot.hasCoverageGap).length;

    return {
      requiredProfessionals,

      requiredProfessionalsLabel:
        `${requiredProfessionals} ` +
        `${requiredProfessionals === 1 ? "professional position" : "professional positions"}`,

      scheduledDateCount,

      scheduledDateCountLabel:
        `${scheduledDateCount} ` + `${scheduledDateCount === 1 ? "work date" : "work dates"}`,

      totalOccurrenceCount,

      totalOccurrenceCountLabel:
        `${totalOccurrenceCount} ` +
        `${totalOccurrenceCount === 1 ? "position/date record" : "position/date records"}`,

      initialAcceptedCount,

      initialAvailablePositionCount,

      initialHiringComplete: initialAvailablePositionCount === 0,

      openReplacementCount,

      positionsWithAssignedCoverage,

      positionsWithCoverageGaps,

      slotSummaries,
    };
  }

  static buildStatusView(value, fallback = null) {
    const normalizedValue = value || fallback;

    if (!normalizedValue) {
      return null;
    }

    return {
      value: normalizedValue,

      label: formatStatus(normalizedValue),

      badgeClass: badgeClass[normalizedValue] || DEFAULT_BADGE_CLASS,
    };
  }

  static buildAmountView(amount, currency = DEFAULT_CURRENCY) {
    const value = Number(amount || 0);

    return {
      value,

      display: ShiftViewService.formatAmount(value, currency),
    };
  }

  static buildCaseReference(value) {
    if (!value) {
      return {
        id: null,

        record: null,

        isLoaded: false,
      };
    }

    const isLoaded = Boolean(
      typeof value === "object" &&
      value._id &&
      (value.referenceCode || value.status || Array.isArray(value.issues))
    );

    return {
      id: ShiftViewService.toId(value),

      record: isLoaded ? value : null,

      isLoaded,
    };
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

  /* ─────────────────────────────── OCCURRENCE STATUS / HIGHLIGHT ─────────────────────────────── */

  static buildOccurrenceStatusView(occurrence) {
    const occurrenceStatus = ShiftViewService.buildStatusView(occurrence?.status);

    const assignmentStatus = ShiftViewService.buildStatusView(occurrence?.assignmentStatus);

    const attendanceStatus = ShiftViewService.buildStatusView(occurrence?.attendanceStatus);

    const settlementStatus = ShiftViewService.buildStatusView(occurrence?.settlementStatus);

    const refundStatus = ShiftViewService.buildStatusView(
      occurrence?.refundStatus,
      DEFAULT_REFUND_STATUS
    );

    return {
      occurrence: occurrenceStatus,

      assignment: assignmentStatus,

      attendance: attendanceStatus,

      settlement: settlementStatus,

      refund: refundStatus,

      isAttendanceReview: ATTENDANCE_REVIEW_STATUSES.includes(occurrence?.attendanceStatus),

      isExpiredUnfilled: Boolean(
        occurrence?.status === "expired_unfilled" ||
        occurrence?.assignmentStatus === "expired_unfilled" ||
        occurrence?.expiredUnfilledAt
      ),
    };
  }

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

    let badgeClassName = DEFAULT_BADGE_CLASS;

    if (isActive) {
      label = "Active";

      badgeClassName = "badge-light-success";
    } else if (isToday) {
      label = "Today";

      badgeClassName = "badge-light-warning";
    } else if (isNext) {
      label = "Next";

      badgeClassName = "badge-light-primary";
    }

    return {
      isSelected,

      isActive,

      isToday,

      isNext,

      label,

      badgeClass: badgeClassName,

      className: badgeClassName,
    };
  }

  /* ─────────────────────────────── SETTLEMENT / PLATFORM FEE ─────────────────────────────── */

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

      approvalSourceLabel: source.approvalSource ? formatStatus(source.approvalSource) : null,

      approvedForReleaseBy: ShiftViewService.toId(source.approvedForReleaseBy),

      scheduledPayoutAt: source.scheduledPayoutAt || null,

      scheduledPayoutAtDisplay: ShiftViewService.formatDateTime(source.scheduledPayoutAt),

      settlementBatch: ShiftViewService.toId(source.settlementBatch),

      releasePendingAt: source.releasePendingAt || null,

      releasePendingAtDisplay: ShiftViewService.formatDateTime(source.releasePendingAt),

      releasedAt: source.releasedAt || null,

      releasedAtDisplay: ShiftViewService.formatDateTime(source.releasedAt),

      payoutTransaction: ShiftViewService.toId(source.payoutTransaction),

      isReleased: status === "released",

      isAwaitingRelease: ["approved_for_release", "release_pending"].includes(status),
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

      earned: Boolean(source.earnedAt),

      outstanding: Boolean(source.outstandingAt && !source.collectedAt),

      collected: Boolean(source.collectedAt),
    };
  }

  /* ─────────────────────────────── CASE / CHALLENGE PRESENTATION ─────────────────────────────── */

  static buildProfessionalClaimView(activeClaim, permissions = null) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const reference = ShiftViewService.buildCaseReference(activeClaim);

    const claim = reference.record;

    const issues = Array.isArray(claim?.issues) ? claim.issues : [];

    const issueViews = issues.map((issue) => ({
      id: ShiftViewService.toId(issue?._id),

      type: issue?.type || null,

      typeLabel: issue?.type ? formatStatus(issue.type) : null,

      status: issue?.status || null,

      statusLabel: issue?.status ? formatStatus(issue.status) : null,

      statusBadgeClass: issue?.status
        ? badgeClass[issue.status] || DEFAULT_BADGE_CLASS
        : DEFAULT_BADGE_CLASS,

      affectedSettlementComponents: Array.isArray(issue?.affectedSettlementComponents)
        ? [...issue.affectedSettlementComponents]
        : [],

      employerDecision: issue?.employerDecision || null,

      employerDecisionLabel: issue?.employerDecision ? formatStatus(issue.employerDecision) : null,

      employerDecidedAt: issue?.employerDecidedAt || null,

      employerDecidedAtDisplay: ShiftViewService.formatDateTime(issue?.employerDecidedAt),

      escalationReason: issue?.escalationReason || null,

      escalationReasonLabel: issue?.escalationReason ? formatStatus(issue.escalationReason) : null,

      escalatedAt: issue?.escalatedAt || null,

      escalatedAtDisplay: ShiftViewService.formatDateTime(issue?.escalatedAt),

      adminDecision: issue?.adminDecision || null,

      adminDecisionLabel: issue?.adminDecision ? formatStatus(issue.adminDecision) : null,

      resolvedAt: issue?.resolvedAt || null,

      resolvedAtDisplay: ShiftViewService.formatDateTime(issue?.resolvedAt),

      requiresEmployerReview: Boolean(
        issue?.status === "awaiting_employer_review" && !issue?.employerDecision
      ),
    }));

    const employerReviewIssues = issueViews.filter((issue) => issue.requiresEmployerReview);

    const hasPendingEmployerReview = employerReviewIssues.length > 0;

    const canManageClaims = resolvedPermissions.canManageClaims;

    return {
      active: Boolean(reference.id),

      id: reference.id,

      recordLoaded: reference.isLoaded,

      referenceCode: claim?.referenceCode || null,

      status: claim?.status || null,

      statusLabel: claim?.status ? formatStatus(claim.status) : null,

      statusBadgeClass: claim?.status
        ? badgeClass[claim.status] || DEFAULT_BADGE_CLASS
        : DEFAULT_BADGE_CLASS,

      submittedAt: claim?.submittedAt || null,

      submittedAtDisplay: ShiftViewService.formatDateTime(claim?.submittedAt),

      employerResponseDeadlineAt: claim?.employerResponseDeadlineAt || null,

      employerResponseDeadlineAtDisplay: ShiftViewService.formatDateTime(
        claim?.employerResponseDeadlineAt
      ),

      issues: issueViews,

      issueCount: issueViews.length,

      employerReviewIssueCount: employerReviewIssues.length,

      hasPendingEmployerReview,

      canManageClaims,

      requiresEmployerAction: canManageClaims && hasPendingEmployerReview,

      casesUrl: EMPLOYER_CASES_URL,

      action: {
        available: Boolean(reference.id),

        label: canManageClaims && hasPendingEmployerReview ? "Review Claim" : "View Claim",

        url: reference.id ? EMPLOYER_CASES_URL : null,
      },
    };
  }

  static buildEmployerDisputeView(activeDispute, permissions = null) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const reference = ShiftViewService.buildCaseReference(activeDispute);

    const dispute = reference.record;

    const issues = Array.isArray(dispute?.issues) ? dispute.issues : [];

    return {
      active: Boolean(reference.id),

      id: reference.id,

      recordLoaded: reference.isLoaded,

      referenceCode: dispute?.referenceCode || null,

      status: dispute?.status || null,

      statusLabel: dispute?.status ? formatStatus(dispute.status) : null,

      statusBadgeClass: dispute?.status
        ? badgeClass[dispute.status] || DEFAULT_BADGE_CLASS
        : DEFAULT_BADGE_CLASS,

      submittedAt: dispute?.submittedAt || null,

      submittedAtDisplay: ShiftViewService.formatDateTime(dispute?.submittedAt),

      professionalResponseDeadlineAt: dispute?.professionalResponseDeadlineAt || null,

      professionalResponseDeadlineAtDisplay: ShiftViewService.formatDateTime(
        dispute?.professionalResponseDeadlineAt
      ),

      issues: issues.map((issue) => ({
        id: ShiftViewService.toId(issue?._id),

        type: issue?.type || null,

        typeLabel: issue?.type ? formatStatus(issue.type) : null,

        status: issue?.status || null,

        statusLabel: issue?.status ? formatStatus(issue.status) : null,

        statusBadgeClass: issue?.status
          ? badgeClass[issue.status] || DEFAULT_BADGE_CLASS
          : DEFAULT_BADGE_CLASS,

        affectedSettlementComponents: Array.isArray(issue?.affectedSettlementComponents)
          ? [...issue.affectedSettlementComponents]
          : [],

        resolvedAt: issue?.resolvedAt || null,

        resolvedAtDisplay: ShiftViewService.formatDateTime(issue?.resolvedAt),
      })),

      issueCount: issues.length,

      canManageDisputes: resolvedPermissions.canManageDisputes,

      requiresEmployerAction: false,

      casesUrl: EMPLOYER_CASES_URL,

      action: {
        available: Boolean(reference.id),

        label: "View Dispute",

        url: reference.id ? EMPLOYER_CASES_URL : null,
      },
    };
  }

  static buildChallengeView(occurrence, currentTime = new Date(), permissions = null) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const openedAt = occurrence?.challengeWindowOpenedAt || null;

    const deadlineAt = occurrence?.challengeDeadlineAt || null;

    const closedAt = occurrence?.challengeWindowClosedAt || null;

    const rawComponents = Array.isArray(occurrence?.challengeableSettlementComponents)
      ? [...occurrence.challengeableSettlementComponents]
      : [];

    const normalizedCurrentTime = new Date(currentTime);

    const deadline = deadlineAt ? new Date(deadlineAt) : null;

    const validCurrentTime = !Number.isNaN(normalizedCurrentTime.getTime());

    const validDeadline = deadline && !Number.isNaN(deadline.getTime());

    const isOpen = Boolean(
      openedAt &&
      deadlineAt &&
      !closedAt &&
      validCurrentTime &&
      validDeadline &&
      normalizedCurrentTime.getTime() < deadline.getTime()
    );

    const isExpired = Boolean(
      openedAt &&
      deadlineAt &&
      !closedAt &&
      validCurrentTime &&
      validDeadline &&
      normalizedCurrentTime.getTime() >= deadline.getTime()
    );

    let status = "not_available";

    let statusLabel = "Not available";

    let statusBadgeClass = DEFAULT_BADGE_CLASS;

    if (closedAt) {
      status = "closed";

      statusLabel = "Closed";
    } else if (isOpen) {
      status = "open";

      statusLabel = "Open";

      statusBadgeClass = "badge-light-warning";
    } else if (isExpired) {
      status = "expired";

      statusLabel = "Expired";
    }

    const professionalClaim = ShiftViewService.buildProfessionalClaimView(
      occurrence?.activeClaim,
      resolvedPermissions
    );

    const employerDispute = ShiftViewService.buildEmployerDisputeView(
      occurrence?.activeDispute,
      resolvedPermissions
    );

    const components = rawComponents.map((component) => ({
      value: component,

      label:
        component === "base"
          ? "BASE"
          : component === "overtime"
            ? "Overtime"
            : formatStatus(component),
    }));

    return {
      openedAt,

      openedAtDisplay: ShiftViewService.formatDateTime(openedAt),

      deadlineAt,

      deadlineAtDisplay: ShiftViewService.formatDateTime(deadlineAt),

      closedAt,

      closedAtDisplay: ShiftViewService.formatDateTime(closedAt),

      status,

      statusLabel,

      statusBadgeClass,

      isOpen,

      isExpired,

      challengeableSettlementComponents: rawComponents,

      components,

      hasChallengeableComponents: components.length > 0,

      canManageDisputes: resolvedPermissions.canManageDisputes,

      canSubmitEmployerDispute: Boolean(
        resolvedPermissions.canManageDisputes &&
        isOpen &&
        !professionalClaim.active &&
        !employerDispute.active &&
        components.length > 0
      ),

      activeClaim: professionalClaim.id,

      activeDispute: employerDispute.id,

      hasActiveClaim: professionalClaim.active,

      hasActiveDispute: employerDispute.active,

      hasActiveCase: professionalClaim.active || employerDispute.active,

      professionalClaim,

      employerDispute,

      casesAction: {
        available: professionalClaim.active || employerDispute.active,

        url: professionalClaim.active || employerDispute.active ? EMPLOYER_CASES_URL : null,

        label:
          professionalClaim.active && employerDispute.active
            ? "View Cases"
            : professionalClaim.active
              ? professionalClaim.action.label
              : employerDispute.active
                ? employerDispute.action.label
                : null,
      },
    };
  }

  /* ─────────────────────────────── REFUND PRESENTATION ─────────────────────────────── */

  static buildRefundView(occurrence, currency, permissions = null) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    if (!resolvedPermissions.canViewRefunds) {
      return {
        status: null,

        statusLabel: null,

        statusBadgeClass: DEFAULT_BADGE_CLASS,

        refundableAmount: null,

        refundableAmountDisplay: null,

        refundedAmount: null,

        refundedAmountDisplay: null,

        remainingAmount: null,

        remainingAmountDisplay: null,

        reason: null,

        reasonLabel: null,

        eligibleAt: null,

        eligibleAtDisplay: null,

        lastEvaluatedAt: null,

        lastEvaluatedAtDisplay: null,

        heldAt: null,

        heldAtDisplay: null,

        holdReason: null,

        holdReasonLabel: null,

        holdMessage: null,

        employerRefund: null,

        refundBatch: null,

        processingStartedAt: null,

        processingStartedAtDisplay: null,

        refundedAt: null,

        refundedAtDisplay: null,

        isHeld: false,

        isEligible: false,

        isProcessing: false,

        isRefunded: false,

        hasRefund: false,

        canViewRefunds: false,

        canManageRefundActions: false,

        restricted: true,
      };
    }

    const status = occurrence?.refundStatus || DEFAULT_REFUND_STATUS;

    const refundableAmount = Number(occurrence?.refundableAmount || 0);

    const refundedAmount = Number(occurrence?.refundedAmount || 0);

    const holdReason = occurrence?.refundHoldReason || null;

    const holdPresentation = holdReason
      ? REFUND_HOLD_PRESENTATION[holdReason] || {
          label: formatStatus(holdReason),

          message: "This refund is temporarily on hold.",
        }
      : null;

    const remainingAmount = Math.max(refundableAmount - refundedAmount, 0);

    return {
      status,

      statusLabel: formatStatus(status),

      statusBadgeClass: badgeClass[status] || DEFAULT_BADGE_CLASS,

      refundableAmount,

      refundableAmountDisplay: ShiftViewService.formatAmount(refundableAmount, currency),

      refundedAmount,

      refundedAmountDisplay: ShiftViewService.formatAmount(refundedAmount, currency),

      remainingAmount,

      remainingAmountDisplay: ShiftViewService.formatAmount(remainingAmount, currency),

      reason: occurrence?.refundReason || null,

      reasonLabel: occurrence?.refundReason ? formatStatus(occurrence.refundReason) : null,

      eligibleAt: occurrence?.refundEligibleAt || null,

      eligibleAtDisplay: ShiftViewService.formatDateTime(occurrence?.refundEligibleAt),

      lastEvaluatedAt: occurrence?.refundLastEvaluatedAt || null,

      lastEvaluatedAtDisplay: ShiftViewService.formatDateTime(occurrence?.refundLastEvaluatedAt),

      heldAt: occurrence?.refundHeldAt || null,

      heldAtDisplay: ShiftViewService.formatDateTime(occurrence?.refundHeldAt),

      holdReason,

      holdReasonLabel: holdPresentation?.label || null,

      holdMessage: holdPresentation?.message || null,

      employerRefund: ShiftViewService.toId(occurrence?.employerRefund),

      refundBatch: ShiftViewService.toId(occurrence?.refundBatch),

      processingStartedAt: occurrence?.refundProcessingStartedAt || null,

      processingStartedAtDisplay: ShiftViewService.formatDateTime(
        occurrence?.refundProcessingStartedAt
      ),

      refundedAt: occurrence?.refundedAt || null,

      refundedAtDisplay: ShiftViewService.formatDateTime(occurrence?.refundedAt),

      isHeld: status === "held",

      isEligible: status === "eligible",

      isProcessing: ["batched", "processing"].includes(status),

      isRefunded: status === "refunded",

      hasRefund: refundableAmount > 0 || refundedAmount > 0 || status !== DEFAULT_REFUND_STATUS,

      canViewRefunds: true,

      canManageRefundActions: resolvedPermissions.canManageRefundActions,

      restricted: false,
    };
  }

  /* ─────────────────────────────── OVERTIME REVIEW ─────────────────────────────── */

  static buildOvertimeReviewView({
    shift,
    occurrence,
    currentTime = new Date(),
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const overtime =
      occurrence?.overtime && typeof occurrence.overtime === "object" ? occurrence.overtime : {};

    const requested = overtime.requested === true;

    const status = requested ? overtime.status || "pending" : "not_requested";

    const normalizedCurrentTime = new Date(currentTime);

    const deadlineAt = overtime.employerResponseDeadlineAt
      ? new Date(overtime.employerResponseDeadlineAt)
      : null;

    const responseWindowOpen = Boolean(
      requested &&
      status === "pending" &&
      !overtime.employerRespondedAt &&
      !overtime.employerResponseOverdueAt &&
      deadlineAt &&
      !Number.isNaN(deadlineAt.getTime()) &&
      !Number.isNaN(normalizedCurrentTime.getTime()) &&
      normalizedCurrentTime < deadlineAt
    );

    const employerCanRespond = Boolean(
      resolvedPermissions.canManagePostShiftWorkflows && responseWindowOpen
    );

    const baseUrl =
      shift?._id && occurrence?._id
        ? `${EMPLOYER_SHIFTS_URL}/${shift._id}/occurrences/${occurrence._id}/overtime`
        : null;

    let statusLabel = formatStatus(status);

    if (status === "not_requested") {
      statusLabel = "Not requested";
    } else if (status === "pending" && overtime.employerResponseOverdueAt) {
      statusLabel = "Awaiting admin review";
    } else if (status === "pending") {
      statusLabel = "Awaiting employer review";
    } else if (status === "approved") {
      statusLabel = "Approved";
    } else if (status === "rejected") {
      statusLabel = "Rejected";
    } else if (status === "disputed") {
      statusLabel = "Awaiting admin review";
    }

    const requestEvidence = Array.isArray(overtime.requestEvidence)
      ? overtime.requestEvidence.map((item) => ({
          ...item,
        }))
      : [];

    const rejectionEvidence = Array.isArray(overtime.rejectionEvidence)
      ? overtime.rejectionEvidence.map((item) => ({
          ...item,
        }))
      : [];

    return {
      requested,

      requestedBy: ShiftViewService.toId(overtime.requestedBy),

      source: overtime.source || null,

      sourceLabel: overtime.source ? formatStatus(overtime.source) : null,

      requestStatement: overtime.requestStatement || null,

      requestEvidence,

      requestEvidenceCount: requestEvidence.length,

      requestedMinutes:
        overtime.requestedMinutes === null || overtime.requestedMinutes === undefined
          ? null
          : Number(overtime.requestedMinutes),

      requestedMinutesDisplay: requested
        ? ShiftViewService.formatMinutes(Number(overtime.requestedMinutes || 0))
        : "-",

      requestedAt: overtime.requestedAt || null,

      requestedAtDisplay: ShiftViewService.formatDateTime(overtime.requestedAt),

      approvedMinutes:
        overtime.approvedMinutes === null || overtime.approvedMinutes === undefined
          ? null
          : Number(overtime.approvedMinutes),

      approvedMinutesDisplay:
        overtime.approvedMinutes === null || overtime.approvedMinutes === undefined
          ? null
          : ShiftViewService.formatMinutes(Number(overtime.approvedMinutes)),

      status,

      statusLabel,

      statusBadgeClass: badgeClass[status] || DEFAULT_BADGE_CLASS,

      decisionSource: overtime.decisionSource || null,

      decisionSourceLabel: overtime.decisionSource ? formatStatus(overtime.decisionSource) : null,

      employerResponseDeadlineAt: overtime.employerResponseDeadlineAt || null,

      employerResponseDeadlineAtDisplay: ShiftViewService.formatDateTime(
        overtime.employerResponseDeadlineAt
      ),

      employerRespondedAt: overtime.employerRespondedAt || null,

      employerRespondedAtDisplay: ShiftViewService.formatDateTime(overtime.employerRespondedAt),

      employerResponseOverdueAt: overtime.employerResponseOverdueAt || null,

      employerResponseOverdueAtDisplay: ShiftViewService.formatDateTime(
        overtime.employerResponseOverdueAt
      ),

      responseWindowOpen,

      canManagePostShiftWorkflows: resolvedPermissions.canManagePostShiftWorkflows,

      employerCanRespond,

      approvedAt: overtime.approvedAt || null,

      approvedAtDisplay: ShiftViewService.formatDateTime(overtime.approvedAt),

      approvedBy: ShiftViewService.toId(overtime.approvedBy),

      rejectedAt: overtime.rejectedAt || null,

      rejectedAtDisplay: ShiftViewService.formatDateTime(overtime.rejectedAt),

      rejectedBy: ShiftViewService.toId(overtime.rejectedBy),

      rejectionBasis: overtime.rejectionBasis || null,

      rejectionBasisLabel: overtime.rejectionBasis ? formatStatus(overtime.rejectionBasis) : null,

      rejectionReason: overtime.rejectionReason || null,

      employerProposedMinutes:
        overtime.employerProposedMinutes === null || overtime.employerProposedMinutes === undefined
          ? null
          : Number(overtime.employerProposedMinutes),

      employerProposedMinutesDisplay:
        overtime.employerProposedMinutes === null || overtime.employerProposedMinutes === undefined
          ? null
          : ShiftViewService.formatMinutes(Number(overtime.employerProposedMinutes)),

      rejectionEvidence,

      rejectionEvidenceCount: rejectionEvidence.length,

      rejectionNoSupportingEvidence: overtime.rejectionNoSupportingEvidence === true,

      adminReviewReason: overtime.adminReviewReason || null,

      adminReviewReasonLabel: overtime.adminReviewReason
        ? formatStatus(overtime.adminReviewReason)
        : null,

      adminReviewStartedAt: overtime.adminReviewStartedAt || null,

      adminReviewStartedAtDisplay: ShiftViewService.formatDateTime(overtime.adminReviewStartedAt),

      adminDecision: overtime.adminDecision || null,

      adminDecisionLabel: overtime.adminDecision ? formatStatus(overtime.adminDecision) : null,

      adminDecidedAt: overtime.adminDecidedAt || null,

      adminDecidedAtDisplay: ShiftViewService.formatDateTime(overtime.adminDecidedAt),

      adminDecidedBy: ShiftViewService.toId(overtime.adminDecidedBy),

      adminDecisionReason: overtime.adminDecisionReason || null,

      actions: {
        approve: {
          available: employerCanRespond,

          url: employerCanRespond && baseUrl ? `${baseUrl}/approve` : null,

          label: "Approve Overtime",
        },

        reject: {
          available: employerCanRespond,

          url: employerCanRespond && baseUrl ? `${baseUrl}/reject` : null,

          label: "Reject Overtime",
        },
      },
    };
  }

  /* ─────────────────────────────── OVERTIME TOP-UP PAYMENT ─────────────────────────────── */

  static buildOvertimeTopUpPaymentView({
    shift,
    occurrence,
    currency,
    employerWallet = null,
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const canManageFinancialObligations = resolvedPermissions.canManageFinancialObligations;

    const canViewWallet = resolvedPermissions.canViewWallet;

    const overtime =
      occurrence?.overtime && typeof occurrence.overtime === "object" ? occurrence.overtime : {};

    const normalizedCurrency = String(currency || DEFAULT_CURRENCY)
      .trim()
      .toUpperCase();

    const walletCurrency = String(employerWallet?.currency || "")
      .trim()
      .toUpperCase();

    const topUpAmount = Number(overtime.topUpAmount || 0);

    const topUpRequired = Number(occurrence?.topUpRequired || 0);

    const topUpTransaction = ShiftViewService.toId(occurrence?.topUpTransaction);

    const topUpPaid = overtime.topUpPaid === true;

    const outstanding = Boolean(
      overtime.requested === true &&
      overtime.status === "approved" &&
      topUpRequired > 0 &&
      !topUpPaid &&
      !topUpTransaction
    );

    const rawWalletAvailableBalance = Number(employerWallet?.availableBalance || 0);

    const walletAvailableBalance = canViewWallet ? rawWalletAvailableBalance : null;

    const walletIsActive = employerWallet?.status === "active";

    const walletCurrencyMatches = Boolean(walletCurrency) && walletCurrency === normalizedCurrency;

    const walletHasSufficientBalance = rawWalletAvailableBalance >= topUpRequired;

    const walletShortfall = canViewWallet
      ? Math.max(topUpRequired - rawWalletAvailableBalance, 0)
      : null;

    let walletUnavailableMessage = null;

    if (!outstanding) {
      walletUnavailableMessage = "This occurrence does not currently require an overtime top-up.";
    } else if (!canManageFinancialObligations) {
      walletUnavailableMessage = "You do not have permission to pay overtime top-ups.";
    } else if (!walletIsActive) {
      walletUnavailableMessage = "Your employer wallet is not active.";
    } else if (!walletCurrencyMatches) {
      walletUnavailableMessage = "Your wallet currency does not match the Shift currency.";
    } else if (!walletHasSufficientBalance) {
      walletUnavailableMessage =
        "Your wallet balance is not sufficient to pay this overtime top-up.";
    }

    const baseUrl =
      shift?._id && occurrence?._id
        ? `${EMPLOYER_SHIFTS_URL}/${shift._id}/occurrences/${occurrence._id}/overtime/top-up`
        : null;

    return {
      fundingKind: "shift_overtime_topup",

      occurrenceId: occurrence?._id ? String(occurrence._id) : null,

      approved: overtime.status === "approved",

      topUpAmount,

      topUpAmountDisplay: ShiftViewService.formatAmount(topUpAmount, normalizedCurrency),

      topUpRequired,

      topUpRequiredDisplay: ShiftViewService.formatAmount(topUpRequired, normalizedCurrency),

      topUpDeadlineAt: overtime.topUpDeadlineAt || null,

      topUpDeadlineAtDisplay: ShiftViewService.formatDateTime(overtime.topUpDeadlineAt),

      topUpOverdueAt: overtime.topUpOverdueAt || null,

      topUpOverdueAtDisplay: ShiftViewService.formatDateTime(overtime.topUpOverdueAt),

      restrictionTriggeredAt: overtime.restrictionTriggeredAt || null,

      restrictionTriggeredAtDisplay: ShiftViewService.formatDateTime(
        overtime.restrictionTriggeredAt
      ),

      topUpPaid,

      topUpPaidAt: overtime.topUpPaidAt || null,

      topUpPaidAtDisplay: ShiftViewService.formatDateTime(overtime.topUpPaidAt),

      topUpTransaction,

      outstanding,

      overdue: Boolean(outstanding && overtime.topUpOverdueAt),

      restrictionTriggered: Boolean(outstanding && overtime.restrictionTriggeredAt),

      canManageFinancialObligations,

      canViewWallet,

      paymentOptions: {
        wallet: {
          method: "wallet",

          label: "Employer Wallet",

          available: Boolean(outstanding && canManageFinancialObligations),

          canUse: Boolean(
            outstanding &&
            canManageFinancialObligations &&
            walletIsActive &&
            walletCurrencyMatches &&
            walletHasSufficientBalance
          ),

          url: outstanding && canManageFinancialObligations && baseUrl ? `${baseUrl}/wallet` : null,

          walletStatus: canViewWallet ? employerWallet?.status || null : null,

          availableBalance: walletAvailableBalance,

          availableBalanceDisplay:
            walletAvailableBalance === null
              ? null
              : ShiftViewService.formatAmount(walletAvailableBalance, normalizedCurrency),

          shortfall: walletShortfall,

          shortfallDisplay:
            walletShortfall === null
              ? null
              : ShiftViewService.formatAmount(walletShortfall, normalizedCurrency),

          unavailableMessage: walletUnavailableMessage,
        },

        paystackCheckout: {
          method: "paystack_checkout",

          label: "Paystack Checkout",

          available: Boolean(outstanding && canManageFinancialObligations),

          canUse: Boolean(outstanding && canManageFinancialObligations),

          url:
            outstanding && canManageFinancialObligations && baseUrl ? `${baseUrl}/checkout` : null,

          description: "Pay the approved overtime top-up securely through Paystack.",
        },
      },

      action: {
        available: Boolean(outstanding && canManageFinancialObligations),

        label: "Pay Overtime Top-up",

        amount: topUpRequired,

        amountDisplay: ShiftViewService.formatAmount(topUpRequired, normalizedCurrency),
      },
    };
  }

  static buildOvertimeView({
    shift,
    occurrence,
    currency,
    employerWallet = null,
    currentTime = new Date(),
    permissions = null,
  }) {
    const review = ShiftViewService.buildOvertimeReviewView({
      shift,

      occurrence,

      currentTime,

      permissions,
    });

    const topUpPayment = ShiftViewService.buildOvertimeTopUpPaymentView({
      shift,

      occurrence,

      currency,

      employerWallet,

      permissions,
    });

    const professionalPay = Number(occurrence?.overtimeProfessionalPay || 0);

    const platformFee = Number(occurrence?.overtimePlatformFee || 0);

    const employerCharge = professionalPay + platformFee;

    return {
      requested: review.requested,

      status: review.status,

      statusLabel: review.statusLabel,

      statusBadgeClass: review.statusBadgeClass,

      employerCanRespond: review.employerCanRespond,

      review,

      professionalPay,

      professionalPayDisplay: ShiftViewService.formatAmount(professionalPay, currency),

      platformFee,

      platformFeeDisplay: ShiftViewService.formatAmount(platformFee, currency),

      employerCharge,

      employerChargeDisplay: ShiftViewService.formatAmount(employerCharge, currency),

      topUpPayment,

      topUpRequired: topUpPayment.topUpRequired,

      topUpRequiredDisplay: topUpPayment.topUpRequiredDisplay,

      topUpOutstanding: topUpPayment.outstanding,

      topUpOverdue: topUpPayment.overdue,

      restrictionTriggered: topUpPayment.restrictionTriggered,

      topUpTransaction: topUpPayment.topUpTransaction,

      actions: {
        approve: review.actions.approve,

        reject: review.actions.reject,

        topUp: topUpPayment.action,
      },
    };
  }

  /* ─────────────────────────────── OCCURRENCE FINANCIAL OUTCOME ─────────────────────────────── */

  static buildOccurrenceFinancialView(occurrence, currency) {
    const scheduledProfessionalPay = Number(occurrence?.estimatedProfessionalPay || 0);

    const scheduledPlatformFee = Number(occurrence?.estimatedPlatformFee || 0);

    const scheduledEmployerCharge = Number(
      occurrence?.estimatedEmployerCharge || scheduledProfessionalPay + scheduledPlatformFee
    );

    const baseProfessionalPay = Number(occurrence?.baseProfessionalPay || 0);

    const basePlatformFee = Number(occurrence?.basePlatformFee || 0);

    /*
     * Presentation total only.
     *
     * There is deliberately no occurrence.baseEmployerCharge authority.
     * The authoritative BASE components are baseProfessionalPay and
     * basePlatformFee.
     */
    const baseEmployerCharge = baseProfessionalPay + basePlatformFee;

    const overtimeProfessionalPay = Number(occurrence?.overtimeProfessionalPay || 0);

    const overtimePlatformFee = Number(occurrence?.overtimePlatformFee || 0);

    /*
     * Presentation total only.
     *
     * There is deliberately no occurrence.overtimeEmployerCharge authority.
     */
    const approvedOvertimeEmployerCharge = overtimeProfessionalPay + overtimePlatformFee;

    const currentProfessionalPay = baseProfessionalPay + overtimeProfessionalPay;

    const currentPlatformFee = basePlatformFee + overtimePlatformFee;

    const currentEmployerCharge = baseEmployerCharge + approvedOvertimeEmployerCharge;

    const baseSettlementStatus = occurrence?.baseSettlement?.status || "not_due";

    const hasBaseBillableHours =
      occurrence?.baseBillableHours !== null && occurrence?.baseBillableHours !== undefined;

    const baseEstablished = Boolean(
      baseProfessionalPay > 0 ||
      basePlatformFee > 0 ||
      hasBaseBillableHours ||
      baseSettlementStatus !== "not_due" ||
      occurrence?.basePlatformFeeAudit?.earnedAt ||
      occurrence?.cancellationCompensation?.applicable === true ||
      occurrence?.activeWorkCancellation?.occurred === true ||
      occurrence?.status === "no_show"
    );

    const overtimeEstablished = Boolean(
      occurrence?.overtime?.status === "approved" ||
      overtimeProfessionalPay > 0 ||
      overtimePlatformFee > 0
    );

    return {
      currency,

      scheduledEstimate: {
        label: "Scheduled estimate",

        professionalPay: scheduledProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(scheduledProfessionalPay, currency),

        platformFee: scheduledPlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(scheduledPlatformFee, currency),

        employerCharge: scheduledEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(scheduledEmployerCharge, currency),
      },

      baseOutcome: {
        label: "BASE employer charge",

        established: baseEstablished,

        billableHours: occurrence?.baseBillableHours ?? null,

        billableHoursDisplay:
          occurrence?.baseBillableHours === null || occurrence?.baseBillableHours === undefined
            ? "-"
            : ShiftViewService.formatScheduledHours(Number(occurrence.baseBillableHours)),

        professionalPay: baseProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(baseProfessionalPay, currency),

        platformFee: basePlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(basePlatformFee, currency),

        employerCharge: baseEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(baseEmployerCharge, currency),
      },

      approvedOvertimeOutcome: {
        label: "Approved overtime employer charge",

        established: overtimeEstablished,

        professionalPay: overtimeProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(overtimeProfessionalPay, currency),

        platformFee: overtimePlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(overtimePlatformFee, currency),

        employerCharge: approvedOvertimeEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(
          approvedOvertimeEmployerCharge,
          currency
        ),
      },

      currentOutcome: {
        label: "Current established employer charge",

        established: baseEstablished || overtimeEstablished,

        professionalPay: currentProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(currentProfessionalPay, currency),

        platformFee: currentPlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(currentPlatformFee, currency),

        employerCharge: currentEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(currentEmployerCharge, currency),
      },
    };
  }

  /* ─────────────────────────────── CANCELLATION / REPLACEMENT ─────────────────────────────── */

  static buildCancellationView(occurrence, currency) {
    const compensation =
      occurrence?.cancellationCompensation &&
      typeof occurrence.cancellationCompensation === "object"
        ? occurrence.cancellationCompensation
        : {};

    const activeWork =
      occurrence?.activeWorkCancellation && typeof occurrence.activeWorkCancellation === "object"
        ? occurrence.activeWorkCancellation
        : {};

    return {
      cancelled: Boolean(occurrence?.cancelledAt || occurrence?.status === "cancelled"),

      code: occurrence?.cancellationCode || null,

      codeLabel: occurrence?.cancellationCode ? formatStatus(occurrence.cancellationCode) : null,

      reason: occurrence?.cancellationReason || null,

      cancelledBy: occurrence?.cancelledBy || null,

      cancelledByLabel: occurrence?.cancelledBy ? formatStatus(occurrence.cancelledBy) : null,

      cancelledByUser: ShiftViewService.toId(occurrence?.cancelledByUser),

      cancelledAt: occurrence?.cancelledAt || null,

      cancelledAtDisplay: ShiftViewService.formatDateTime(occurrence?.cancelledAt),

      compensation: {
        applicable: compensation.applicable === true,

        rate: Number(compensation.rate || 0),

        percent: Number((Number(compensation.rate || 0) * 100).toFixed(2)),

        windowMinutes:
          compensation.windowMinutes === null || compensation.windowMinutes === undefined
            ? null
            : Number(compensation.windowMinutes),

        professionalPay: Number(compensation.professionalPay || 0),

        professionalPayDisplay: ShiftViewService.formatAmount(
          compensation.professionalPay || 0,
          currency
        ),

        calculatedAt: compensation.calculatedAt || null,

        calculatedAtDisplay: ShiftViewService.formatDateTime(compensation.calculatedAt),
      },

      activeWork: {
        occurred: activeWork.occurred === true,

        initiatedBy: activeWork.initiatedBy || null,

        initiatedByLabel: activeWork.initiatedBy ? formatStatus(activeWork.initiatedBy) : null,

        initiatedByUser: ShiftViewService.toId(activeWork.initiatedByUser),

        reason: activeWork.reason || null,

        requestedAt: activeWork.requestedAt || null,

        requestedAtDisplay: ShiftViewService.formatDateTime(activeWork.requestedAt),

        effectiveAt: activeWork.effectiveAt || null,

        effectiveAtDisplay: ShiftViewService.formatDateTime(activeWork.effectiveAt),

        actualWorkedMinutes: Number(activeWork.actualWorkedMinutes || 0),

        actualWorkedMinutesDisplay: ShiftViewService.formatMinutes(
          Number(activeWork.actualWorkedMinutes || 0)
        ),

        minimumProfessionalPayRate: Number(activeWork.minimumProfessionalPayRate || 0),

        minimumProfessionalPayPercent: Number(
          (Number(activeWork.minimumProfessionalPayRate || 0) * 100).toFixed(2)
        ),

        actualWorkedProfessionalPay: Number(activeWork.actualWorkedProfessionalPay || 0),

        actualWorkedProfessionalPayDisplay: ShiftViewService.formatAmount(
          activeWork.actualWorkedProfessionalPay || 0,
          currency
        ),

        minimumGuaranteedProfessionalPay: Number(activeWork.minimumGuaranteedProfessionalPay || 0),

        minimumGuaranteedProfessionalPayDisplay: ShiftViewService.formatAmount(
          activeWork.minimumGuaranteedProfessionalPay || 0,
          currency
        ),

        professionalPay: Number(activeWork.professionalPay || 0),

        professionalPayDisplay: ShiftViewService.formatAmount(
          activeWork.professionalPay || 0,
          currency
        ),

        calculatedAt: activeWork.calculatedAt || null,

        calculatedAtDisplay: ShiftViewService.formatDateTime(activeWork.calculatedAt),
      },
    };
  }

  static buildReplacementView(occurrence) {
    const expiredUnfilled = Boolean(
      occurrence?.status === "expired_unfilled" ||
      occurrence?.assignmentStatus === "expired_unfilled" ||
      occurrence?.expiredUnfilledAt
    );

    const required = Boolean(
      !expiredUnfilled &&
      (occurrence?.assignmentStatus === "replacement_required" || occurrence?.replacementRequiredAt)
    );

    return {
      required,

      requiredAt: occurrence?.replacementRequiredAt || null,

      requiredAtDisplay: ShiftViewService.formatDateTime(occurrence?.replacementRequiredAt),

      replacementForAssignment: ShiftViewService.toId(occurrence?.replacementForAssignment),

      replacementCase: ShiftViewService.toId(occurrence?.replacementCase),

      reasonCode: occurrence?.replacementReasonCode || null,

      reasonLabel: occurrence?.replacementReasonCode
        ? formatStatus(occurrence.replacementReasonCode)
        : null,

      reasonDetails: occurrence?.replacementReasonDetails || null,

      expiredUnfilled,

      expiredFromAssignmentStatus: occurrence?.expiredFromAssignmentStatus || null,

      expiredFromAssignmentStatusLabel: occurrence?.expiredFromAssignmentStatus
        ? formatStatus(occurrence.expiredFromAssignmentStatus)
        : null,

      expiredUnfilledAt: occurrence?.expiredUnfilledAt || null,

      expiredUnfilledAtDisplay: ShiftViewService.formatDateTime(occurrence?.expiredUnfilledAt),
    };
  }

  /* ─────────────────────────────── EMPLOYER ATTENTION ─────────────────────────────── */

  static buildOccurrenceAttention({
    shift,
    occurrence,
    currency,
    employerWallet = null,
    currentTime = new Date(),
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    if (!occurrence) {
      return {
        entries: [],

        primary: null,

        primaryRequiredAction: null,

        primaryContextAction: null,

        requiresEmployerAction: false,

        actionRequiredCount: 0,

        hasAttention: false,
      };
    }

    const overtimeReview = ShiftViewService.buildOvertimeReviewView({
      shift,

      occurrence,

      currentTime,

      permissions: resolvedPermissions,
    });

    const overtimeTopUp = ShiftViewService.buildOvertimeTopUpPaymentView({
      shift,

      occurrence,

      currency,

      employerWallet,

      permissions: resolvedPermissions,
    });

    const challenge = ShiftViewService.buildChallengeView(
      occurrence,
      currentTime,
      resolvedPermissions
    );

    const refund = ShiftViewService.buildRefundView(occurrence, currency, resolvedPermissions);

    const replacement = ShiftViewService.buildReplacementView(occurrence);

    const professionalClaim = challenge.professionalClaim;

    const employerDispute = challenge.employerDispute;

    const entries = [];

    const detailsUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}?occurrence=${occurrence._id}`;

    if (overtimeTopUp.outstanding) {
      if (overtimeTopUp.restrictionTriggered) {
        entries.push({
          key: "overtime_topup_restriction",

          label: "Overtime payment overdue",

          message:
            `The approved overtime top-up of ${overtimeTopUp.topUpRequiredDisplay} is overdue. ` +
            "The restriction threshold has been reached.",

          badgeClass: "badge-light-danger",

          priority: ATTENTION_PRIORITIES.OVERTIME_RESTRICTION,

          requiresEmployerAction: overtimeTopUp.action.available,

          outranksParentStatus: true,

          actionLabel: overtimeTopUp.action.available
            ? "Pay Overtime Top-up"
            : "View Overtime Payment",

          actionUrl: detailsUrl,

          occurrenceId: String(occurrence._id),
        });
      } else if (overtimeTopUp.overdue) {
        entries.push({
          key: "overtime_topup_overdue",

          label: "Overtime payment overdue",

          message:
            `The approved overtime top-up of ` +
            `${overtimeTopUp.topUpRequiredDisplay} is overdue.`,

          badgeClass: "badge-light-danger",

          priority: ATTENTION_PRIORITIES.OVERTIME_OVERDUE,

          requiresEmployerAction: overtimeTopUp.action.available,

          outranksParentStatus: true,

          actionLabel: overtimeTopUp.action.available
            ? "Pay Overtime Top-up"
            : "View Overtime Payment",

          actionUrl: detailsUrl,

          occurrenceId: String(occurrence._id),
        });
      } else {
        entries.push({
          key: "overtime_topup_required",

          label: "Overtime payment required",

          message: `An approved overtime top-up of ${overtimeTopUp.topUpRequiredDisplay} is required.`,

          badgeClass: "badge-light-warning",

          priority: ATTENTION_PRIORITIES.OVERTIME_TOPUP,

          requiresEmployerAction: overtimeTopUp.action.available,

          outranksParentStatus: true,

          actionLabel: overtimeTopUp.action.available
            ? "Pay Overtime Top-up"
            : "View Overtime Payment",

          actionUrl: detailsUrl,

          occurrenceId: String(occurrence._id),
        });
      }
    } else if (overtimeReview.responseWindowOpen) {
      entries.push({
        key: "overtime_review",

        label: "Overtime review required",

        message:
          `Review the professional's ` +
          `${overtimeReview.requestedMinutesDisplay} overtime request.`,

        badgeClass: "badge-light-warning",

        priority: ATTENTION_PRIORITIES.OVERTIME_REVIEW,

        requiresEmployerAction: overtimeReview.employerCanRespond,

        outranksParentStatus: true,

        actionLabel: overtimeReview.employerCanRespond
          ? "Review Overtime"
          : "View Overtime Request",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    }

    if (professionalClaim.hasPendingEmployerReview) {
      entries.push({
        key: "professional_claim_review",

        label: "Professional claim review required",

        message:
          professionalClaim.employerReviewIssueCount === 1
            ? "A professional claim issue is awaiting your review."
            : `${professionalClaim.employerReviewIssueCount} professional claim issues are awaiting your review.`,

        badgeClass: "badge-light-warning",

        priority: ATTENTION_PRIORITIES.PROFESSIONAL_CLAIM_REVIEW,

        requiresEmployerAction: professionalClaim.requiresEmployerAction,

        outranksParentStatus: true,

        actionLabel: professionalClaim.requiresEmployerAction ? "Review Claim" : "View Claim",

        actionUrl: EMPLOYER_CASES_URL,

        occurrenceId: String(occurrence._id),
      });
    }

    if (ATTENDANCE_REVIEW_STATUSES.includes(occurrence.attendanceStatus)) {
      entries.push({
        key: "attendance_review",

        label: "Attendance review pending",

        message: "This occurrence has an unresolved attendance review.",

        badgeClass: "badge-light-warning",

        priority: ATTENTION_PRIORITIES.ATTENDANCE_REVIEW,

        requiresEmployerAction: false,

        outranksParentStatus: true,

        actionLabel: "View Attendance Review",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    }

    if (replacement.required) {
      entries.push({
        key: "replacement_required",

        label: "Replacement required",

        message: "This occurrence needs a replacement professional.",

        badgeClass: "badge-light-warning",

        priority: ATTENTION_PRIORITIES.REPLACEMENT_REQUIRED,

        requiresEmployerAction: false,

        outranksParentStatus: true,

        actionLabel: "View Replacement",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    }

    if (professionalClaim.active && !professionalClaim.hasPendingEmployerReview) {
      entries.push({
        key: "professional_claim",

        label: "Professional claim active",

        message: "A professional claim is active for this occurrence.",

        badgeClass: "badge-light-warning",

        priority: ATTENTION_PRIORITIES.PROFESSIONAL_CLAIM,

        requiresEmployerAction: false,

        outranksParentStatus: true,

        actionLabel: "View Claim",

        actionUrl: EMPLOYER_CASES_URL,

        occurrenceId: String(occurrence._id),
      });
    }

    if (employerDispute.active) {
      entries.push({
        key: "employer_dispute",

        label: "Employer dispute active",

        message: "An employer dispute is active for this occurrence.",

        badgeClass: "badge-light-info",

        priority: ATTENTION_PRIORITIES.EMPLOYER_DISPUTE,

        requiresEmployerAction: false,

        outranksParentStatus: true,

        actionLabel: "View Dispute",

        actionUrl: EMPLOYER_CASES_URL,

        occurrenceId: String(occurrence._id),
      });
    }

    if (challenge.isOpen && !challenge.hasActiveCase && challenge.hasChallengeableComponents) {
      entries.push({
        key: "challenge_window_open",

        label: "Review window open",

        message: "This occurrence is still within the shared review window.",

        badgeClass: "badge-light-info",

        priority: ATTENTION_PRIORITIES.CHALLENGE_WINDOW,

        requiresEmployerAction: false,

        outranksParentStatus: true,

        actionLabel: "Review Occurrence",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    }

    if (refund.isHeld) {
      entries.push({
        key: "refund_held",

        label: refund.holdReasonLabel || "Refund on hold",

        message: refund.holdMessage || "This refund is currently on hold.",

        badgeClass: "badge-light-warning",

        priority: ATTENTION_PRIORITIES.REFUND_HELD,

        requiresEmployerAction: false,

        outranksParentStatus: false,

        actionLabel: "View Refund State",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    } else if (refund.isProcessing) {
      entries.push({
        key: "refund_processing",

        label: "Refund processing",

        message: `${refund.refundableAmountDisplay} is being processed for refund.`,

        badgeClass: "badge-light-info",

        priority: ATTENTION_PRIORITIES.REFUND_PROCESSING,

        requiresEmployerAction: false,

        outranksParentStatus: false,

        actionLabel: "View Refund State",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    }

    if (replacement.expiredUnfilled) {
      entries.push({
        key: "expired_unfilled",

        label: "Expired unfilled",

        message: "This occurrence expired without a professional filling the work date.",

        badgeClass: "badge-light-secondary",

        priority: ATTENTION_PRIORITIES.EXPIRED_UNFILLED,

        requiresEmployerAction: false,

        outranksParentStatus: false,

        actionLabel: "View Occurrence",

        actionUrl: detailsUrl,

        occurrenceId: String(occurrence._id),
      });
    }

    entries.sort((left, right) => left.priority - right.priority);

    const requiredActions = entries.filter((entry) => entry.requiresEmployerAction);

    const contextActions = entries.filter(
      (entry) => !entry.requiresEmployerAction && entry.outranksParentStatus
    );

    return {
      entries,

      primary: entries[0] || null,

      primaryRequiredAction: requiredActions[0] || null,

      primaryContextAction: contextActions[0] || null,

      requiresEmployerAction: requiredActions.length > 0,

      actionRequiredCount: requiredActions.length,

      hasAttention: entries.length > 0,
    };
  }

  static buildShiftAttention({
    shift,
    occurrences = [],
    currency,
    employerWallet = null,
    currentTime = new Date(),
    permissions = null,
  }) {
    const entries = [];

    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    for (const occurrence of occurrenceRows) {
      const attention = ShiftViewService.buildOccurrenceAttention({
        shift,

        occurrence,

        currency,

        employerWallet,

        currentTime,

        permissions,
      });

      const identity = ShiftViewService.buildOccurrenceIdentity({
        shift,

        occurrence,
      });

      entries.push(
        ...attention.entries.map((entry) => ({
          ...entry,

          slotNumber: identity.slotNumber,

          sequenceNumber: identity.sequenceNumber,

          positionLabel: identity.positionLabel,

          dateLabel: identity.dateLabel,

          occurrenceLabel: identity.occurrenceLabel,
        }))
      );
    }

    entries.sort(
      (left, right) =>
        Number(left.priority || 0) - Number(right.priority || 0) ||
        Number(left.slotNumber || 0) - Number(right.slotNumber || 0) ||
        Number(left.sequenceNumber || 0) - Number(right.sequenceNumber || 0)
    );

    const requiredActions = entries.filter((entry) => entry.requiresEmployerAction);

    const contextActions = entries.filter(
      (entry) => !entry.requiresEmployerAction && entry.outranksParentStatus
    );

    return {
      entries,

      primary: entries[0] || null,

      primaryAction: requiredActions[0] || null,

      primaryRequiredAction: requiredActions[0] || null,

      primaryContextAction: contextActions[0] || null,

      requiresEmployerAction: requiredActions.length > 0,

      actionRequiredCount: requiredActions.length,

      hasAttention: entries.length > 0,

      hasActiveCase: entries.some((entry) =>
        ["professional_claim_review", "professional_claim", "employer_dispute"].includes(entry.key)
      ),
    };
  }

  /* ─────────────────────────────── OCCURRENCE VIEW ─────────────────────────────── */

  static buildEmployerOccurrenceView({
    shift,
    occurrence,
    currency,
    currentTime = new Date(),
    selectedOccurrence = null,
    employerWallet = null,
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

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

    const statusView = ShiftViewService.buildOccurrenceStatusView(occurrence);

    const scheduledMinutes = Number(
      occurrence.scheduledMinutes || Math.round(Number(occurrence.scheduledHours || 0) * 60)
    );

    const hourlyRate = Number(occurrence.hourlyRate || 0);

    const financials = ShiftViewService.buildOccurrenceFinancialView(occurrence, currency);

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

    const challenge = ShiftViewService.buildChallengeView(
      occurrence,
      currentTime,
      resolvedPermissions
    );

    const refund = ShiftViewService.buildRefundView(occurrence, currency, resolvedPermissions);

    const overtimeReview = ShiftViewService.buildOvertimeReviewView({
      shift,

      occurrence,

      currentTime,

      permissions: resolvedPermissions,
    });

    const overtimeTopUpPayment = ShiftViewService.buildOvertimeTopUpPaymentView({
      shift,

      occurrence,

      currency,

      employerWallet,

      permissions: resolvedPermissions,
    });

    const overtimeView = ShiftViewService.buildOvertimeView({
      shift,

      occurrence,

      currency,

      employerWallet,

      currentTime,

      permissions: resolvedPermissions,
    });

    const cancellation = ShiftViewService.buildCancellationView(occurrence, currency);

    const replacement = ShiftViewService.buildReplacementView(occurrence);

    const attention = ShiftViewService.buildOccurrenceAttention({
      shift,

      occurrence,

      currency,

      employerWallet,

      currentTime,

      permissions: resolvedPermissions,
    });

    const startParts = ShiftScheduleService.extractLocalDateTimeParts(occurrence.startTime);

    const endParts = ShiftScheduleService.extractLocalDateTimeParts(occurrence.endTime);

    const occurrenceDetailsUrl =
      `${EMPLOYER_SHIFTS_URL}/${shift._id}` + `?occurrence=${occurrence._id}`;

    const identity = ShiftViewService.buildOccurrenceIdentity({
      shift,

      occurrence,
    });

    const pricingSnapshot = ShiftViewService.buildPricingSnapshotView(occurrence);

    const canManageAttendance = resolvedPermissions.canManagePostShiftWorkflows;

    const canViewAttendancePins = Boolean(
      canManageAttendance && pinAuthorization.canViewAttendancePins
    );

    const canRevealCheckInPin = Boolean(
      canManageAttendance && pinAuthorization.canRevealCheckInPin
    );

    const canRevealCheckOutPin = Boolean(
      canManageAttendance && pinAuthorization.canRevealCheckOutPin
    );

    const hasAvailablePin = Boolean(canManageAttendance && pinAuthorization.hasAvailablePin);

    const pinUnavailableMessage = canManageAttendance
      ? pinAuthorization.unavailableMessage
      : "You do not have permission to view attendance PINs.";

    return {
      id: String(occurrence._id),

      shiftId: String(shift._id),

      referenceCode: occurrence.referenceCode,

      slotNumber: identity.slotNumber,

      positionLabel: identity.positionLabel,

      sequenceNumber: identity.sequenceNumber,

      sequenceLabel: identity.dateLabel,

      dateLabel: identity.dateLabel,

      occurrenceLabel: identity.occurrenceLabel,

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

      standardBasePlatformFeeRate: pricingSnapshot.standardBasePlatformFeeRate,

      standardBasePlatformFeePercent: pricingSnapshot.standardBasePlatformFeePercent,

      basePlatformFeeRate: pricingSnapshot.basePlatformFeeRate,

      basePlatformFeePercent: pricingSnapshot.basePlatformFeePercent,

      overtimePlatformFeeRate: pricingSnapshot.overtimePlatformFeeRate,

      overtimePlatformFeePercent: pricingSnapshot.overtimePlatformFeePercent,

      basePlatformFeeBenefitSource: pricingSnapshot.basePlatformFeeBenefitSource,

      basePlatformFeeSubscription: pricingSnapshot.basePlatformFeeSubscription,

      pricingSnapshot,

      estimatedProfessionalPay: financials.scheduledEstimate.professionalPay,

      estimatedProfessionalPayDisplay: financials.scheduledEstimate.professionalPayDisplay,

      estimatedPlatformFee: financials.scheduledEstimate.platformFee,

      estimatedPlatformFeeDisplay: financials.scheduledEstimate.platformFeeDisplay,

      estimatedEmployerCharge: financials.scheduledEstimate.employerCharge,

      estimatedEmployerChargeDisplay: financials.scheduledEstimate.employerChargeDisplay,

      baseProfessionalPay: financials.baseOutcome.professionalPay,

      baseProfessionalPayDisplay: financials.baseOutcome.professionalPayDisplay,

      basePlatformFee: financials.baseOutcome.platformFee,

      basePlatformFeeDisplay: financials.baseOutcome.platformFeeDisplay,

      /*
       * Derived presentation amount.
       */
      baseEmployerCharge: financials.baseOutcome.employerCharge,

      baseEmployerChargeDisplay: financials.baseOutcome.employerChargeDisplay,

      overtimeProfessionalPay: financials.approvedOvertimeOutcome.professionalPay,

      overtimeProfessionalPayDisplay: financials.approvedOvertimeOutcome.professionalPayDisplay,

      overtimePlatformFee: financials.approvedOvertimeOutcome.platformFee,

      overtimePlatformFeeDisplay: financials.approvedOvertimeOutcome.platformFeeDisplay,

      /*
       * Derived presentation amount.
       */
      approvedOvertimeEmployerCharge: financials.approvedOvertimeOutcome.employerCharge,

      approvedOvertimeEmployerChargeDisplay:
        financials.approvedOvertimeOutcome.employerChargeDisplay,

      currentProfessionalPay: financials.currentOutcome.professionalPay,

      currentProfessionalPayDisplay: financials.currentOutcome.professionalPayDisplay,

      currentPlatformFee: financials.currentOutcome.platformFee,

      currentPlatformFeeDisplay: financials.currentOutcome.platformFeeDisplay,

      /*
       * Derived current presentation amount.
       *
       * This is not stored as occurrence.finalEmployerCharge or any equivalent
       * authority field.
       */
      currentEmployerCharge: financials.currentOutcome.employerCharge,

      currentEmployerChargeDisplay: financials.currentOutcome.employerChargeDisplay,

      financials,

      topUpRequired: overtimeTopUpPayment.topUpRequired,

      topUpRequiredDisplay: overtimeTopUpPayment.topUpRequiredDisplay,

      topUpTransaction: overtimeTopUpPayment.topUpTransaction,

      overtimeReview,

      overtimeTopUpPayment,

      overtimeView,

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

      professionalClaim: challenge.professionalClaim,

      employerDispute: challenge.employerDispute,

      challenge,

      refundableAmount: refund.refundableAmount,

      refundableAmountDisplay: refund.refundableAmountDisplay,

      refundedAmount: refund.refundedAmount,

      refundedAmountDisplay: refund.refundedAmountDisplay,

      refundStatus: refund.status,

      refundStatusLabel: refund.statusLabel,

      refundStatusBadgeClass: refund.statusBadgeClass,

      refundReason: refund.reason,

      refundEligibleAt: refund.eligibleAt,

      refundEligibleAtDisplay: refund.eligibleAtDisplay,

      refundLastEvaluatedAt: refund.lastEvaluatedAt,

      refundLastEvaluatedAtDisplay: refund.lastEvaluatedAtDisplay,

      refundHeldAt: refund.heldAt,

      refundHeldAtDisplay: refund.heldAtDisplay,

      refundHoldReason: refund.holdReason,

      employerRefund: refund.employerRefund,

      refundBatch: refund.refundBatch,

      refundProcessingStartedAt: refund.processingStartedAt,

      refundProcessingStartedAtDisplay: refund.processingStartedAtDisplay,

      refundedAt: refund.refundedAt,

      refundedAtDisplay: refund.refundedAtDisplay,

      refund,

      replacementRequiredAt: replacement.requiredAt,

      replacementRequiredAtDisplay: replacement.requiredAtDisplay,

      replacementForAssignment: replacement.replacementForAssignment,

      replacementCase: replacement.replacementCase,

      replacementReasonCode: replacement.reasonCode,

      replacementReasonDetails: replacement.reasonDetails,

      replacement,

      cancellationCode: cancellation.code,

      cancellationReason: cancellation.reason,

      cancelledBy: cancellation.cancelledBy,

      cancelledByUser: cancellation.cancelledByUser,

      cancelledAt: cancellation.cancelledAt,

      cancelledAtDisplay: cancellation.cancelledAtDisplay,

      cancellationCompensation: occurrence.cancellationCompensation || null,

      activeWorkCancellation: occurrence.activeWorkCancellation || null,

      cancellation,

      assignmentStatus: occurrence.assignmentStatus,

      assignmentStatusLabel:
        statusView.assignment?.label || formatStatus(occurrence.assignmentStatus),

      assignmentStatusBadgeClass: statusView.assignment?.badgeClass || DEFAULT_BADGE_CLASS,

      assignedProfessional: ShiftViewService.toId(occurrence.assignedProfessional),

      assignment: ShiftViewService.toId(occurrence.assignment),

      assignedAt: occurrence.assignedAt || null,

      assignedAtDisplay: ShiftViewService.formatDateTime(occurrence.assignedAt),

      hasAssignment: pinAuthorization.hasAssignment,

      status: occurrence.status,

      statusLabel: statusView.occurrence?.label || formatStatus(occurrence.status),

      statusBadgeClass: statusView.occurrence?.badgeClass || DEFAULT_BADGE_CLASS,

      attendanceStatus: occurrence.attendanceStatus,

      attendanceStatusLabel:
        statusView.attendance?.label || formatStatus(occurrence.attendanceStatus),

      attendanceStatusBadgeClass: statusView.attendance?.badgeClass || DEFAULT_BADGE_CLASS,

      settlementStatus: occurrence.settlementStatus,

      settlementStatusLabel:
        statusView.settlement?.label || formatStatus(occurrence.settlementStatus),

      settlementStatusBadgeClass: statusView.settlement?.badgeClass || DEFAULT_BADGE_CLASS,

      statusView,

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

      /*
       * Retained as raw audit data while the frontend is being reworked.
       * Lifecycle interpretation belongs in overtimeReview/overtimeTopUpPayment.
       */
      overtime: occurrence.overtime || null,

      attention,

      requiresEmployerAction: attention.requiresEmployerAction,

      highlight,

      isSelectedOccurrence: highlight.isSelected,

      rowClassName: highlight.isSelected ? "bg-light-primary" : "",

      action: {
        label: highlight.isSelected ? "Selected" : "View",

        className: highlight.isSelected ? "btn-primary" : "btn-light-primary",

        url: occurrenceDetailsUrl,
      },

      canViewAttendancePins,

      canRevealCheckInPin,

      canRevealCheckOutPin,

      hasAttendanceAction: hasAvailablePin,

      pinAccess: {
        brandColor: PIN_BRAND_COLOR,

        displayFormat: PIN_DISPLAY_FORMAT,

        canViewAttendancePins,

        canRevealCheckInPin,

        canRevealCheckOutPin,

        hasAvailablePin,

        unavailableMessage: pinUnavailableMessage,

        checkInPinUrl: highlight.isSelected && canRevealCheckInPin ? pinUrls.checkInPinUrl : null,

        checkOutPinUrl:
          highlight.isSelected && canRevealCheckOutPin ? pinUrls.checkOutPinUrl : null,
      },

      detailsUrl: occurrenceDetailsUrl,
    };
  }

  static buildRelevantOccurrenceSummary({
    shift,
    occurrence,
    currentTime = new Date(),
    currency = DEFAULT_CURRENCY,
    employerWallet = null,
    permissions = null,
  }) {
    if (!occurrence) {
      return null;
    }

    const highlight = ShiftViewService.buildOccurrenceHighlight({
      occurrence,

      selectedOccurrence: occurrence,

      currentTime,
    });

    const statusView = ShiftViewService.buildOccurrenceStatusView(occurrence);

    const attention = ShiftViewService.buildOccurrenceAttention({
      shift,

      occurrence,

      currency,

      employerWallet,

      currentTime,

      permissions,
    });

    const identity = ShiftViewService.buildOccurrenceIdentity({
      shift,

      occurrence,
    });

    return {
      id: String(occurrence._id),

      referenceCode: occurrence.referenceCode,

      slotNumber: identity.slotNumber,

      positionLabel: identity.positionLabel,

      sequenceNumber: identity.sequenceNumber,

      sequenceLabel: identity.dateLabel,

      dateLabel: identity.dateLabel,

      occurrenceLabel: identity.occurrenceLabel,

      occurrenceDate: ShiftPinAccessService.getOccurrenceLocalDate(occurrence),

      occurrenceDateDisplay: occurrence.occurrenceDate
        ? ShiftViewService.formatLocalDate(occurrence.occurrenceDate)
        : ShiftViewService.formatDate(occurrence.startTime),

      startTime: occurrence.startTime,

      endTime: occurrence.endTime,

      startTimeDisplay: ShiftViewService.formatTime(occurrence.startTime),

      endTimeDisplay: ShiftViewService.formatTime(occurrence.endTime),

      status: occurrence.status,

      statusLabel: statusView.occurrence?.label || formatStatus(occurrence.status),

      statusBadgeClass: statusView.occurrence?.badgeClass || DEFAULT_BADGE_CLASS,

      attendanceStatus: occurrence.attendanceStatus,

      attendanceStatusLabel:
        statusView.attendance?.label || formatStatus(occurrence.attendanceStatus),

      attendanceStatusBadgeClass: statusView.attendance?.badgeClass || DEFAULT_BADGE_CLASS,

      assignmentStatus: occurrence.assignmentStatus,

      assignmentStatusLabel:
        statusView.assignment?.label || formatStatus(occurrence.assignmentStatus),

      assignmentStatusBadgeClass: statusView.assignment?.badgeClass || DEFAULT_BADGE_CLASS,

      settlementStatus: occurrence.settlementStatus,

      settlementStatusLabel:
        statusView.settlement?.label || formatStatus(occurrence.settlementStatus),

      settlementStatusBadgeClass: statusView.settlement?.badgeClass || DEFAULT_BADGE_CLASS,

      refundStatus: occurrence.refundStatus || DEFAULT_REFUND_STATUS,

      refundStatusLabel: formatStatus(occurrence.refundStatus || DEFAULT_REFUND_STATUS),

      refundStatusBadgeClass:
        badgeClass[occurrence.refundStatus || DEFAULT_REFUND_STATUS] || DEFAULT_BADGE_CLASS,

      statusView,

      highlight,

      attention,

      requiresEmployerAction: attention.requiresEmployerAction,

      detailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}?occurrence=${occurrence._id}`,
    };
  }

  /* ─────────────────────────────── LIFECYCLE ACTIONS ─────────────────────────────── */

  static buildShiftLifecycleActions({
    shift,
    occurrences = [],
    currentTime = new Date(),
    canManageLifecycle = false,
  }) {
    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    const normalizedCurrentTime = new Date(currentTime);

    const activeOccurrences = occurrenceRows.filter((occurrence) =>
      ShiftPinAccessService.isOccurrenceActive(occurrence)
    );

    const activeOccurrence = activeOccurrences.length === 1 ? activeOccurrences[0] : null;

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
      activeOccurrences.length === 0 &&
      nextCancellableOccurrence
    );

    const canCancelActiveWork = Boolean(
      canManageLifecycle &&
      activeOccurrences.length > 0 &&
      ACTIVE_WORK_CANCELLATION_PARENT_STATUSES.includes(shift.status)
    );

    const cancellationPreviewUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}/cancellation-preview`;

    const cancelShiftUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}/cancel`;

    const detailsUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}`;

    const activeWorkCancellationRequiresOccurrenceSelection =
      canCancelActiveWork && activeOccurrences.length > 1;

    const activeWorkCancellationUrl = !canCancelActiveWork
      ? null
      : activeOccurrence
        ? `${EMPLOYER_SHIFTS_URL}/${shift._id}` +
          `/occurrences/${activeOccurrence._id}` +
          "/active-work-cancellation"
        : detailsUrl;

    const hasCancellationSummary = Boolean(
      shift.cancellationSummary?.firstAffectedOccurrence ||
      shift.cancellationSummary?.firstAffectedSequenceNumber ||
      Number(shift.cancellationSummary?.cancelledOccurrenceCount || 0) > 0 ||
      shift.cancellationSummary?.compensationApplicable === true
    );

    return {
      canCancelPendingFunding,

      canCancelEngagement,

      canCancelActiveWork,

      canCancel: canCancelPendingFunding || canCancelEngagement,

      cancellationPreviewUrl:
        canCancelPendingFunding || canCancelEngagement ? cancellationPreviewUrl : null,

      cancelShiftUrl: canCancelPendingFunding || canCancelEngagement ? cancelShiftUrl : null,

      activeWorkCancellationUrl,

      activeWorkCancellationRequiresOccurrenceSelection,

      activeOccurrenceId: activeOccurrence ? String(activeOccurrence._id) : null,

      activeOccurrenceIds: activeOccurrences.map((occurrence) => String(occurrence._id)),

      activeOccurrenceCount: activeOccurrences.length,

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

      activeWorkCancellationActionLabel: !canCancelActiveWork
        ? null
        : activeWorkCancellationRequiresOccurrenceSelection
          ? "Select Active Position"
          : "End Shift Early",
    };
  }

  /* ─────────────────────────────── PARENT ACTION ─────────────────────────────── */

  static buildParentShiftAction({
    shift,
    currency,
    employerWallet = null,
    occurrences = [],
    currentTime = new Date(),
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const detailsUrl = `${EMPLOYER_SHIFTS_URL}/${shift._id}`;

    const attention = ShiftViewService.buildShiftAttention({
      shift,

      occurrences,

      currency,

      employerWallet,

      currentTime,

      permissions: resolvedPermissions,
    });

    /*
     * An occurrence-level obligation requiring employer action outranks the
     * generic parent Shift status.
     */
    if (attention.primaryRequiredAction) {
      return {
        key: attention.primaryRequiredAction.key,

        label: attention.primaryRequiredAction.actionLabel || attention.primaryRequiredAction.label,

        type: "link",

        isPrimary: true,

        requiresEmployerAction: true,

        href: attention.primaryRequiredAction.actionUrl || detailsUrl,

        modalId: null,

        occurrenceId: attention.primaryRequiredAction.occurrenceId || null,

        paymentReview: null,
      };
    }

    /*
     * Initial publishing funding remains its own parent-level obligation.
     */
    if (
      resolvedPermissions.canFundShifts &&
      resolvedPermissions.canPostShifts &&
      ShiftViewService.shiftNeedsPayment(shift, currentTime)
    ) {
      const isRetry = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

      return {
        key: isRetry ? "retry_payment" : "complete_payment",

        label: isRetry ? "Retry Payment" : "Complete Payment",

        type: "funding_modal",

        isPrimary: true,

        requiresEmployerAction: true,

        href: detailsUrl,

        modalId: FUND_SHIFT_MODAL_ID,

        occurrenceId: null,

        paymentReview: ShiftViewService.buildShiftPaymentReview({
          shift,

          occurrences,

          employerWallet,

          currency,

          currentTime,

          permissions: resolvedPermissions,
        }),
      };
    }

    /*
     * Occurrence-specific context can still be more useful than a generic
     * parent-state action even when no employer decision/payment is required.
     */
    if (attention.primaryContextAction) {
      return {
        key: attention.primaryContextAction.key,

        label: attention.primaryContextAction.actionLabel || attention.primaryContextAction.label,

        type: "link",

        isPrimary: true,

        requiresEmployerAction: false,

        href: attention.primaryContextAction.actionUrl || detailsUrl,

        modalId: null,

        occurrenceId: attention.primaryContextAction.occurrenceId || null,

        paymentReview: null,
      };
    }

    const canManageShift = Boolean(
      resolvedPermissions.canManageLifecycle ||
      resolvedPermissions.canManagePostShiftWorkflows ||
      resolvedPermissions.canManageClaims ||
      resolvedPermissions.canManageDisputes ||
      resolvedPermissions.canFundShifts
    );

    if (!canManageShift) {
      return {
        key: "view_details",

        label: "View Details",

        type: "link",

        isPrimary: true,

        requiresEmployerAction: false,

        href: detailsUrl,

        modalId: null,

        occurrenceId: null,

        paymentReview: null,
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
        key: "review_details",

        label: "Review Details",
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

      requiresEmployerAction: false,

      href: detailsUrl,

      modalId: null,

      occurrenceId: null,

      paymentReview: null,
    };
  }

  /* ─────────────────────────────── SCHEDULE SUMMARY ─────────────────────────────── */

  static buildCompactScheduleSummary(shift, relevantOccurrence = null) {
    const scheduleMode = shift.scheduleMode || "single";

    const scheduledDateCount = ShiftViewService.getScheduledDateCount(
      shift,
      relevantOccurrence ? [relevantOccurrence] : []
    );

    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const positionLabel =
      `${requiredProfessionals} ` +
      `${requiredProfessionals === 1 ? "professional" : "professionals"}`;

    if (scheduleMode === "multiple") {
      const repeatDaysLabel = ShiftViewService.formatRepeatDays(shift.repeatDays || []);

      const dailyStartTimeDisplay = ShiftViewService.formatTimeMinutesForDisplay(
        shift.dailyStartTimeMinutes
      );

      const dailyEndTimeDisplay = ShiftViewService.formatTimeMinutesForDisplay(
        shift.dailyEndTimeMinutes
      );

      return (
        `${scheduledDateCount} ${scheduledDateCount === 1 ? "work date" : "work dates"}` +
        ` × ${positionLabel}` +
        (repeatDaysLabel ? ` • ${repeatDaysLabel}` : "") +
        ` • ${dailyStartTimeDisplay}–${dailyEndTimeDisplay}`
      );
    }

    const startTime = relevantOccurrence?.startTime || shift.startTime;

    const endTime = relevantOccurrence?.endTime || shift.endTime;

    return (
      `${positionLabel} • ` +
      `${ShiftViewService.formatDate(startTime)} • ` +
      `${ShiftViewService.formatTime(startTime)}–` +
      ShiftViewService.formatTime(endTime)
    );
  }

  /* ─────────────────────────────── ENGAGEMENT FINANCIAL SUMMARY ─────────────────────────────── */

  static buildEngagementFinancialSummary({
    shift,
    occurrences = [],
    currency,
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    const occurrenceFinancials = occurrenceRows.map((occurrence) =>
      ShiftViewService.buildOccurrenceFinancialView(occurrence, currency)
    );

    const sumView = (viewKey, amountKey, label) =>
      ShiftViewService.sumMoney(
        occurrenceFinancials.map((financial) => financial?.[viewKey]?.[amountKey] || 0),
        label
      );

    const scheduledProfessionalFromOccurrences = sumView(
      "scheduledEstimate",
      "professionalPay",
      "Scheduled professional pay"
    );

    const scheduledPlatformFeeFromOccurrences = sumView(
      "scheduledEstimate",
      "platformFee",
      "Scheduled platform fee"
    );

    const scheduledEmployerChargeFromOccurrences = sumView(
      "scheduledEstimate",
      "employerCharge",
      "Scheduled employer charge"
    );

    const scheduledProfessionalPay = Number.isSafeInteger(Number(shift?.estimatedProfessionalPay))
      ? Number(shift.estimatedProfessionalPay)
      : scheduledProfessionalFromOccurrences;

    const scheduledPlatformFee = Number.isSafeInteger(Number(shift?.estimatedPlatformFee))
      ? Number(shift.estimatedPlatformFee)
      : scheduledPlatformFeeFromOccurrences;

    const scheduledEmployerCharge = Number.isSafeInteger(Number(shift?.estimatedEmployerCharge))
      ? Number(shift.estimatedEmployerCharge)
      : scheduledEmployerChargeFromOccurrences;

    const baseProfessionalPay = sumView("baseOutcome", "professionalPay", "BASE professional pay");

    const basePlatformFee = sumView("baseOutcome", "platformFee", "BASE platform fee");

    const baseEmployerCharge = ShiftViewService.sumMoney(
      [baseProfessionalPay, basePlatformFee],
      "BASE employer charge"
    );

    const overtimeProfessionalPay = sumView(
      "approvedOvertimeOutcome",
      "professionalPay",
      "Overtime professional pay"
    );

    const overtimePlatformFee = sumView(
      "approvedOvertimeOutcome",
      "platformFee",
      "Overtime platform fee"
    );

    const approvedOvertimeEmployerCharge = ShiftViewService.sumMoney(
      [overtimeProfessionalPay, overtimePlatformFee],
      "Approved overtime employer charge"
    );

    const currentProfessionalPay = ShiftViewService.sumMoney(
      [baseProfessionalPay, overtimeProfessionalPay],
      "Current professional pay"
    );

    const currentPlatformFee = ShiftViewService.sumMoney(
      [basePlatformFee, overtimePlatformFee],
      "Current platform fee"
    );

    const currentEmployerCharge = ShiftViewService.sumMoney(
      [baseEmployerCharge, approvedOvertimeEmployerCharge],
      "Current employer charge"
    );

    const outstandingOvertimeTopUp = ShiftViewService.sumMoney(
      occurrenceRows.map((occurrence) => occurrence?.topUpRequired || 0),
      "Outstanding overtime top-up"
    );

    const refundableAmount = resolvedPermissions.canViewRefunds
      ? ShiftViewService.sumMoney(
          occurrenceRows.map((occurrence) => occurrence?.refundableAmount || 0),
          "Refundable amount"
        )
      : null;

    const refundedAmount = resolvedPermissions.canViewRefunds
      ? ShiftViewService.sumMoney(
          occurrenceRows.map((occurrence) => occurrence?.refundedAmount || 0),
          "Refunded amount"
        )
      : null;

    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const scheduledDateCount = ShiftViewService.getScheduledDateCount(shift, occurrenceRows);

    const totalOccurrenceCount = ShiftViewService.getTotalOccurrenceCount(shift, occurrenceRows);

    const firstOccurrenceFinancial = occurrenceFinancials[0] || null;

    const perOccurrenceProfessionalPay = firstOccurrenceFinancial
      ? Number(firstOccurrenceFinancial.scheduledEstimate.professionalPay || 0)
      : ShiftViewService.exactPerOccurrenceAmount(scheduledProfessionalPay, totalOccurrenceCount);

    const perOccurrencePlatformFee = firstOccurrenceFinancial
      ? Number(firstOccurrenceFinancial.scheduledEstimate.platformFee || 0)
      : ShiftViewService.exactPerOccurrenceAmount(scheduledPlatformFee, totalOccurrenceCount);

    const perOccurrenceEmployerCharge = firstOccurrenceFinancial
      ? Number(firstOccurrenceFinancial.scheduledEstimate.employerCharge || 0)
      : ShiftViewService.exactPerOccurrenceAmount(scheduledEmployerCharge, totalOccurrenceCount);

    return {
      currency,

      requiredProfessionals,

      scheduledDateCount,

      totalOccurrenceCount,

      perOccurrenceEstimate: {
        professionalPay: perOccurrenceProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(
          perOccurrenceProfessionalPay,
          currency
        ),

        platformFee: perOccurrencePlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(perOccurrencePlatformFee, currency),

        employerCharge: perOccurrenceEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(perOccurrenceEmployerCharge, currency),
      },

      scheduledEstimate: {
        professionalPay: scheduledProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(scheduledProfessionalPay, currency),

        platformFee: scheduledPlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(scheduledPlatformFee, currency),

        employerCharge: scheduledEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(scheduledEmployerCharge, currency),
      },

      baseOutcome: {
        professionalPay: baseProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(baseProfessionalPay, currency),

        platformFee: basePlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(basePlatformFee, currency),

        employerCharge: baseEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(baseEmployerCharge, currency),
      },

      approvedOvertimeOutcome: {
        professionalPay: overtimeProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(overtimeProfessionalPay, currency),

        platformFee: overtimePlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(overtimePlatformFee, currency),

        employerCharge: approvedOvertimeEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(
          approvedOvertimeEmployerCharge,
          currency
        ),
      },

      currentOutcome: {
        professionalPay: currentProfessionalPay,

        professionalPayDisplay: ShiftViewService.formatAmount(currentProfessionalPay, currency),

        platformFee: currentPlatformFee,

        platformFeeDisplay: ShiftViewService.formatAmount(currentPlatformFee, currency),

        employerCharge: currentEmployerCharge,

        employerChargeDisplay: ShiftViewService.formatAmount(currentEmployerCharge, currency),
      },

      outstandingOvertimeTopUp,

      outstandingOvertimeTopUpDisplay: ShiftViewService.formatAmount(
        outstandingOvertimeTopUp,
        currency
      ),

      refundableAmount,

      refundableAmountDisplay:
        refundableAmount === null
          ? null
          : ShiftViewService.formatAmount(refundableAmount, currency),

      refundedAmount,

      refundedAmountDisplay:
        refundedAmount === null ? null : ShiftViewService.formatAmount(refundedAmount, currency),
    };
  }

  /* ─────────────────────────────── EMPLOYER SHIFT CARD VIEW ─────────────────────────────── */

  static buildEmployerShiftView(
    shift,
    currency,
    currentTime = new Date(),
    occurrences = [],
    employerWallet = null,
    permissions = null
  ) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    const relevantOccurrence = ShiftPinAccessService.selectRelevantOccurrence(
      [...occurrenceRows],
      null,
      currentTime
    );

    const relevantOccurrenceView = ShiftViewService.buildRelevantOccurrenceSummary({
      shift,

      occurrence: relevantOccurrence,

      currentTime,

      currency,

      employerWallet,

      permissions: resolvedPermissions,
    });

    const staffingSummary = ShiftViewService.buildStaffingSummary({
      shift,

      occurrences: occurrenceRows,
    });

    const professionalTypeLabel =
      PROFESSIONAL_TYPE_OPTIONS.find((option) => option.value === shift.professionalType)?.label ||
      formatStatus(shift.professionalType);

    const attention = ShiftViewService.buildShiftAttention({
      shift,

      occurrences: occurrenceRows,

      currency,

      employerWallet,

      currentTime,

      permissions: resolvedPermissions,
    });

    const financialSummary = ShiftViewService.buildEngagementFinancialSummary({
      shift,

      occurrences: occurrenceRows,

      currency,

      permissions: resolvedPermissions,
    });

    const parentAction = ShiftViewService.buildParentShiftAction({
      shift,

      currency,

      employerWallet,

      occurrences: occurrenceRows,

      currentTime,

      permissions: resolvedPermissions,
    });

    const displayStatus = ShiftViewService.getShiftDisplayStatus(shift);

    const needsPayment = ShiftViewService.shiftNeedsPayment(shift, currentTime);

    const paymentIsRetry = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

    const pricingSnapshot = ShiftViewService.buildPricingSnapshotView(shift);

    const isAssigned = staffingSummary.positionsWithAssignedCoverage > 0;

    return {
      id: String(shift._id),

      referenceCode: shift.referenceCode,

      detailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}`,

      casesUrl: EMPLOYER_CASES_URL,

      branch: ShiftViewService.buildBranchView(shift.branch),

      roleTitle: shift.roleTitle,

      professionalType: shift.professionalType,

      professionalTypeLabel,

      scheduleMode: shift.scheduleMode || "single",

      scheduleModeLabel:
        shift.scheduleMode === "multiple" ? "Multiple work dates" : "Single work date",

      occurrenceCount: staffingSummary.scheduledDateCount,

      occurrenceCountLabel: staffingSummary.scheduledDateCountLabel,

      scheduledDateCount: staffingSummary.scheduledDateCount,

      scheduledDateCountLabel: staffingSummary.scheduledDateCountLabel,

      requiredProfessionals: staffingSummary.requiredProfessionals,

      requiredProfessionalsLabel: staffingSummary.requiredProfessionalsLabel,

      totalOccurrenceCount: staffingSummary.totalOccurrenceCount,

      totalOccurrenceCountLabel: staffingSummary.totalOccurrenceCountLabel,

      scheduleSummary: ShiftViewService.buildCompactScheduleSummary(shift, relevantOccurrence),

      relevantOccurrence: relevantOccurrenceView,

      staffingSummary,

      hiringSummary: shift.hiringSummary || null,

      assignmentSummary: shift.assignmentSummary || null,

      occurrenceProgress: shift.occurrenceProgress || null,

      settlementSummary: shift.settlementSummary || null,

      isAssigned,

      hourlyRate: Number(shift.hourlyRate || 0),

      hourlyRateDisplay: ShiftViewService.formatAmount(shift.hourlyRate || 0, currency),

      standardBasePlatformFeeRate: pricingSnapshot.standardBasePlatformFeeRate,

      standardBasePlatformFeePercent: pricingSnapshot.standardBasePlatformFeePercent,

      basePlatformFeeRate: pricingSnapshot.basePlatformFeeRate,

      basePlatformFeePercent: pricingSnapshot.basePlatformFeePercent,

      overtimePlatformFeeRate: pricingSnapshot.overtimePlatformFeeRate,

      overtimePlatformFeePercent: pricingSnapshot.overtimePlatformFeePercent,

      basePlatformFeeBenefitSource: pricingSnapshot.basePlatformFeeBenefitSource,

      basePlatformFeeSubscription: pricingSnapshot.basePlatformFeeSubscription,

      pricingSnapshot,

      estimatedEmployerCharge: Number(shift.estimatedEmployerCharge || 0),

      estimatedEmployerChargeDisplay: ShiftViewService.formatAmount(
        shift.estimatedEmployerCharge || 0,
        currency
      ),

      financialSummary,

      attention,

      actionRequired: attention.requiresEmployerAction,

      actionRequiredCount: attention.actionRequiredCount,

      overtimeTopUpRequired: financialSummary.outstandingOvertimeTopUp,

      overtimeTopUpRequiredDisplay: financialSummary.outstandingOvertimeTopUpDisplay,

      refundedAmount: financialSummary.refundedAmount,

      refundedAmountDisplay: financialSummary.refundedAmountDisplay,

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

      canCompletePayment:
        resolvedPermissions.canFundShifts &&
        resolvedPermissions.canPostShifts &&
        needsPayment &&
        !paymentIsRetry,

      canRetryPayment:
        resolvedPermissions.canFundShifts &&
        resolvedPermissions.canPostShifts &&
        needsPayment &&
        paymentIsRetry,

      paymentActionLabel:
        resolvedPermissions.canFundShifts && resolvedPermissions.canPostShifts && needsPayment
          ? paymentIsRetry
            ? "Retry Payment"
            : "Complete Payment"
          : null,

      parentAction,
    };
  }

  /* ─────────────────────────────── INITIAL PAYMENT REVIEW ─────────────────────────────── */

  static buildShiftPaymentReview({
    shift,
    occurrences = [],
    employerWallet,
    currency,
    currentTime = new Date(),
    permissions = null,
  }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const canFundShifts = resolvedPermissions.canFundShifts;

    const canPostShifts = resolvedPermissions.canPostShifts;

    const canFundInitialShift = canFundShifts && canPostShifts;

    const canViewWallet = resolvedPermissions.canViewWallet;

    const normalizedCurrency = String(currency || "")
      .trim()
      .toUpperCase();

    const walletCurrency = String(employerWallet?.currency || "")
      .trim()
      .toUpperCase();

    const rawAvailableBalance = Number(employerWallet?.availableBalance || 0);

    const availableBalance = canViewWallet ? rawAvailableBalance : null;

    const employerCharge = Number(shift.estimatedEmployerCharge || 0);

    const walletIsActive = employerWallet?.status === "active";

    const walletCurrencyMatches = Boolean(walletCurrency) && walletCurrency === normalizedCurrency;

    const walletHasSufficientBalance = rawAvailableBalance >= employerCharge;

    const needsPayment = ShiftViewService.shiftNeedsPayment(shift, currentTime);

    const canFundFromWallet = Boolean(
      canFundInitialShift &&
      needsPayment &&
      walletIsActive &&
      walletCurrencyMatches &&
      walletHasSufficientBalance
    );

    const walletShortfall = canViewWallet
      ? Math.max(employerCharge - rawAvailableBalance, 0)
      : null;

    const walletBalanceAfterPayment = canViewWallet
      ? Math.max(rawAvailableBalance - employerCharge, 0)
      : null;

    let walletUnavailableMessage = null;

    if (!needsPayment) {
      walletUnavailableMessage = "This Shift does not currently require initial funding.";
    } else if (!canFundShifts) {
      walletUnavailableMessage = "You do not have permission to fund this Shift.";
    } else if (!canPostShifts) {
      walletUnavailableMessage =
        "This business is currently restricted from activating new Shift obligations.";
    } else if (!walletIsActive) {
      walletUnavailableMessage = "Your employer wallet is not active.";
    } else if (!walletCurrencyMatches) {
      walletUnavailableMessage = "Your wallet currency does not match the Shift currency.";
    } else if (!walletHasSufficientBalance) {
      walletUnavailableMessage = "Your wallet balance is not sufficient to fund this Shift.";
    }

    const scheduleMode = shift.scheduleMode || "single";

    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const scheduledDateCount = ShiftViewService.getScheduledDateCount(shift, occurrenceRows);

    const totalOccurrenceCount = ShiftViewService.getTotalOccurrenceCount(shift, occurrenceRows);

    const scheduledMinutesPerOccurrence = Number(
      shift.scheduledMinutesPerOccurrence ||
        occurrenceRows[0]?.scheduledMinutes ||
        (scheduledDateCount === 1 ? shift.totalScheduledMinutes : 0) ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const totalScheduledMinutes = Number(
      shift.totalScheduledMinutes ||
        scheduledMinutesPerOccurrence * scheduledDateCount ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const calculatedStaffMinutes = totalScheduledMinutes * requiredProfessionals;

    const totalStaffScheduledMinutes =
      Number.isSafeInteger(calculatedStaffMinutes) && calculatedStaffMinutes > 0
        ? calculatedStaffMinutes
        : 0;

    const firstOccurrence = occurrenceRows[0] || null;

    const lastOccurrenceByDate =
      [...occurrenceRows].sort(
        (left, right) =>
          new Date(left?.startTime || 0).getTime() - new Date(right?.startTime || 0).getTime() ||
          ShiftViewService.compareOccurrences(left, right)
      )[occurrenceRows.length - 1] || null;

    const startTimeDisplay =
      scheduleMode === "multiple"
        ? ShiftViewService.formatTimeMinutesForDisplay(shift.dailyStartTimeMinutes)
        : ShiftViewService.formatTime(firstOccurrence?.startTime || shift.startTime);

    const endTimeDisplay =
      scheduleMode === "multiple"
        ? ShiftViewService.formatTimeMinutesForDisplay(shift.dailyEndTimeMinutes)
        : ShiftViewService.formatTime(firstOccurrence?.endTime || shift.endTime);

    const perOccurrenceProfessionalPay = firstOccurrence
      ? Number(firstOccurrence.estimatedProfessionalPay || 0)
      : ShiftViewService.exactPerOccurrenceAmount(
          shift.estimatedProfessionalPay,
          totalOccurrenceCount
        );

    const perOccurrencePlatformFee = firstOccurrence
      ? Number(firstOccurrence.estimatedPlatformFee || 0)
      : ShiftViewService.exactPerOccurrenceAmount(shift.estimatedPlatformFee, totalOccurrenceCount);

    const perOccurrenceEmployerCharge = firstOccurrence
      ? Number(firstOccurrence.estimatedEmployerCharge || 0)
      : ShiftViewService.exactPerOccurrenceAmount(
          shift.estimatedEmployerCharge,
          totalOccurrenceCount
        );

    const isRetryPayment = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

    return {
      fundingKind: "initial_shift_funding",

      title: "Fund Shift",

      description:
        "Protect the full scheduled employer charge for every professional position and work date before this Shift is published.",

      shiftId: String(shift._id),

      referenceCode: shift.referenceCode,

      status: shift.status,

      paymentStatus: shift.paymentStatus,

      needsPayment,

      isRetryPayment,

      actionLabel: isRetryPayment ? "Retry Payment" : "Complete Payment",

      currency: normalizedCurrency,

      requiredProfessionals,

      scheduledDateCount,

      totalOccurrenceCount,

      schedule: {
        scheduleMode,

        scheduleModeLabel: scheduleMode === "multiple" ? "Multiple work dates" : "Single work date",

        occurrenceCount: scheduledDateCount,

        occurrenceCountLabel:
          `${scheduledDateCount} ` + `${scheduledDateCount === 1 ? "work date" : "work dates"}`,

        scheduledDateCount,

        requiredProfessionals,

        requiredProfessionalsLabel:
          `${requiredProfessionals} ` +
          `${requiredProfessionals === 1 ? "professional" : "professionals"}`,

        totalOccurrenceCount,

        totalOccurrenceCountLabel:
          `${totalOccurrenceCount} ` +
          `${totalOccurrenceCount === 1 ? "position/date record" : "position/date records"}`,

        repeatDays: shift.repeatDays || [],

        repeatDaysLabel: ShiftViewService.formatRepeatDays(shift.repeatDays || []),

        firstOccurrenceDate: shift.firstOccurrenceDate || firstOccurrence?.occurrenceDate || null,

        lastOccurrenceDate:
          shift.lastOccurrenceDate || lastOccurrenceByDate?.occurrenceDate || null,

        firstOccurrenceDateDisplay: firstOccurrence
          ? ShiftViewService.formatDate(firstOccurrence.startTime)
          : shift.firstOccurrenceDate
            ? ShiftViewService.formatLocalDate(shift.firstOccurrenceDate)
            : ShiftViewService.formatDate(shift.startTime),

        lastOccurrenceDateDisplay: lastOccurrenceByDate
          ? ShiftViewService.formatDate(lastOccurrenceByDate.startTime)
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

        totalScheduledMinutesPerPosition: totalScheduledMinutes,

        totalScheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(totalScheduledMinutes),

        totalStaffScheduledMinutes,

        totalStaffScheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(
          totalStaffScheduledMinutes
        ),

        occurrences: occurrenceRows.map((occurrence) => {
          const identity = ShiftViewService.buildOccurrenceIdentity({
            shift,

            occurrence,
          });

          return {
            id: String(occurrence._id),

            referenceCode: occurrence.referenceCode,

            slotNumber: identity.slotNumber,

            positionLabel: identity.positionLabel,

            sequenceNumber: identity.sequenceNumber,

            sequenceLabel: identity.dateLabel,

            occurrenceLabel: identity.occurrenceLabel,

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
          };
        }),
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

      canFundShifts,

      canPostShifts,

      canFundInitialShift,

      canViewWallet,

      paymentOptions: {
        wallet: {
          method: "wallet",

          label: "Employer Wallet",

          walletStatus: canViewWallet ? employerWallet?.status || null : null,

          availableBalance,

          availableBalanceDisplay:
            availableBalance === null
              ? null
              : ShiftViewService.formatAmount(availableBalance, normalizedCurrency),

          canUse: canFundFromWallet,

          shortfall: walletShortfall,

          shortfallDisplay:
            walletShortfall === null
              ? null
              : ShiftViewService.formatAmount(walletShortfall, normalizedCurrency),

          balanceAfterPayment: walletBalanceAfterPayment,

          balanceAfterPaymentDisplay:
            walletBalanceAfterPayment === null
              ? null
              : ShiftViewService.formatAmount(walletBalanceAfterPayment, normalizedCurrency),

          unavailableMessage: walletUnavailableMessage,
        },

        paystackCheckout: {
          method: "paystack_checkout",

          label: "Paystack Checkout",

          canUse: Boolean(canFundInitialShift && needsPayment),

          description: "Pay securely with a Paystack-supported payment method.",
        },
      },

      actions: {
        fundFromWalletUrl: canFundInitialShift
          ? `${EMPLOYER_SHIFTS_URL}/${shift._id}/fund-from-wallet`
          : null,

        initializeCheckoutUrl: canFundInitialShift
          ? `${EMPLOYER_SHIFTS_URL}/${shift._id}/initialize-checkout`
          : null,

        shiftDetailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}`,
      },
    };
  }

  static buildFundingModalView({ employerWallet, currency, permissions = null }) {
    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const canFundShifts = resolvedPermissions.canFundShifts;

    const canPostShifts = resolvedPermissions.canPostShifts;

    const canFundInitialShift = canFundShifts && canPostShifts;

    const canViewWallet = resolvedPermissions.canViewWallet;

    const normalizedCurrency = String(currency || DEFAULT_CURRENCY)
      .trim()
      .toUpperCase();

    const availableBalance = canViewWallet ? Number(employerWallet?.availableBalance || 0) : null;

    return {
      modalId: canFundInitialShift ? FUND_SHIFT_MODAL_ID : null,

      available: canFundInitialShift,

      title: "Fund Shift",

      fundingKind: "initial_shift_funding",

      brandColor: PIN_BRAND_COLOR,

      currency: normalizedCurrency,

      wallet: {
        status: canViewWallet ? employerWallet?.status || null : null,

        currency: canViewWallet ? employerWallet?.currency || normalizedCurrency : null,

        availableBalance,

        availableBalanceDisplay:
          availableBalance === null
            ? null
            : ShiftViewService.formatAmount(availableBalance, normalizedCurrency),
      },

      methods: canFundInitialShift
        ? [
            {
              value: "wallet",

              label: "Employer Wallet",
            },
            {
              value: "paystack_checkout",

              label: "Paystack Checkout",
            },
          ]
        : [],
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
    permissions = null,
  }) {
    const hasExplicitPermissions = Boolean(permissions && typeof permissions === "object");

    const resolvedPermissions = ShiftViewService.normalizeEmployerViewPermissions(permissions);

    const effectiveCanManageLifecycle = hasExplicitPermissions
      ? resolvedPermissions.canManageLifecycle
      : canManageLifecycle === true;

    const scheduleMode = shift.scheduleMode || "single";

    const occurrenceRows = ShiftViewService.sortOccurrences(occurrences);

    const selectedOccurrence = ShiftPinAccessService.selectRelevantOccurrence(
      [...occurrenceRows],
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

        employerWallet,

        permissions: resolvedPermissions,
      })
    );

    const selectedOccurrenceView = selectedOccurrence
      ? occurrenceViews.find(
          (occurrenceView) => occurrenceView.id === String(selectedOccurrence._id)
        ) || null
      : null;

    const occurrenceCount = ShiftViewService.getScheduledDateCount(shift, occurrenceRows);

    const requiredProfessionals = ShiftViewService.getRequiredProfessionals(shift);

    const totalOccurrenceCount = ShiftViewService.getTotalOccurrenceCount(shift, occurrenceRows);

    const staffingSummary = ShiftViewService.buildStaffingSummary({
      shift,

      occurrences: occurrenceRows,
    });

    const pricingSnapshot = ShiftViewService.buildPricingSnapshotView(shift);

    const perOccurrenceMinutes = Number(
      shift.scheduledMinutesPerOccurrence ||
        occurrenceViews[0]?.scheduledMinutes ||
        shift.totalScheduledMinutes ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const totalScheduledMinutes = Number(
      shift.totalScheduledMinutes ||
        perOccurrenceMinutes * occurrenceCount ||
        Math.round(Number(shift.scheduledHours || 0) * 60)
    );

    const calculatedStaffScheduledMinutes = totalScheduledMinutes * requiredProfessionals;

    const totalStaffScheduledMinutes =
      Number.isSafeInteger(calculatedStaffScheduledMinutes) && calculatedStaffScheduledMinutes > 0
        ? calculatedStaffScheduledMinutes
        : 0;

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

    const attention = ShiftViewService.buildShiftAttention({
      shift,

      occurrences: occurrenceRows,

      currency,

      employerWallet,

      currentTime,

      permissions: resolvedPermissions,
    });

    const financialSummary = ShiftViewService.buildEngagementFinancialSummary({
      shift,

      occurrences: occurrenceRows,

      currency,

      permissions: resolvedPermissions,
    });

    const parentAction = ShiftViewService.buildParentShiftAction({
      shift,

      currency,

      employerWallet,

      occurrences: occurrenceRows,

      currentTime,

      permissions: resolvedPermissions,
    });

    const paymentReview = ShiftViewService.buildShiftPaymentReview({
      shift,

      occurrences: occurrenceRows,

      employerWallet,

      currency,

      currentTime,

      permissions: resolvedPermissions,
    });

    const lifecycleActions = ShiftViewService.buildShiftLifecycleActions({
      shift,

      occurrences: occurrenceRows,

      currentTime,

      canManageLifecycle: effectiveCanManageLifecycle,
    });

    const displayStatus = ShiftViewService.getShiftDisplayStatus(shift);

    const needsPayment = ShiftViewService.shiftNeedsPayment(shift, currentTime);

    const paymentIsRetry = ShiftViewService.shiftPaymentIsRetry(shift, currentTime);

    const fundingMethod = shift.fundingMethod || null;

    const fundingMethodLabel =
      fundingMethod === "paystack_checkout"
        ? "Paystack Checkout"
        : fundingMethod === "wallet"
          ? "Employer Wallet"
          : "Not selected";

    const fundedAmount = Number(shift.fundedAmount || 0);

    const fundingSummary = {
      initialFunding: {
        method: fundingMethod,

        methodLabel: fundingMethodLabel,

        fundedAmount,

        fundedAmountDisplay: ShiftViewService.formatAmount(fundedAmount, currency),

        fundingTransaction: ShiftViewService.toId(shift.fundingTransaction),

        initiatedAt: shift.fundingInitiatedAt || null,

        initiatedAtDisplay: ShiftViewService.formatDateTime(shift.fundingInitiatedAt),

        fundedAt: shift.fundedAt || null,

        fundedAtDisplay: ShiftViewService.formatDateTime(shift.fundedAt),

        publishedAt: shift.publishedAt || null,

        publishedAtDisplay: ShiftViewService.formatDateTime(shift.publishedAt),
      },

      overtimeTopUps: {
        outstandingAmount: financialSummary.outstandingOvertimeTopUp,

        outstandingAmountDisplay: financialSummary.outstandingOvertimeTopUpDisplay,

        occurrences: occurrenceViews
          .filter((occurrenceView) => occurrenceView.overtimeTopUpPayment.outstanding)
          .map((occurrenceView) => occurrenceView.overtimeTopUpPayment),
      },

      refunds: {
        refundableAmount: financialSummary.refundableAmount,

        refundableAmountDisplay: financialSummary.refundableAmountDisplay,

        refundedAmount: financialSummary.refundedAmount,

        refundedAmountDisplay: financialSummary.refundedAmountDisplay,
      },

      paymentStatus: shift.paymentStatus,

      paymentStatusLabel: formatStatus(shift.paymentStatus),

      paymentStatusBadgeClass: badgeClass[shift.paymentStatus] || DEFAULT_BADGE_CLASS,
    };

    const initialFundingNotice = needsPayment
      ? {
          visible: true,

          title: "Funding is required",

          message:
            "This Shift will not be published until the full scheduled employer charge has been protected.",

          actionLabel:
            resolvedPermissions.canFundShifts && resolvedPermissions.canPostShifts
              ? paymentIsRetry
                ? "Retry Payment"
                : "Complete Payment"
              : null,

          modalId:
            resolvedPermissions.canFundShifts && resolvedPermissions.canPostShifts
              ? FUND_SHIFT_MODAL_ID
              : null,
        }
      : {
          visible: false,

          title: null,

          message: null,

          actionLabel: null,

          modalId: null,
        };

    return {
      id: String(shift._id),

      referenceCode: shift.referenceCode,

      detailsUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}`,

      casesUrl: EMPLOYER_CASES_URL,

      branch: ShiftViewService.buildBranchView(shift.branch),

      department: shift.department || null,

      roleTitle: shift.roleTitle,

      professionalType: shift.professionalType,

      professionalTypeLabel,

      requiredSkills: Array.isArray(shift.requiredSkills) ? shift.requiredSkills : [],

      dressCode: shift.dressCode || null,

      description: shift.description || null,

      scheduleMode,

      scheduleModeLabel: scheduleMode === "multiple" ? "Multiple work dates" : "Single work date",

      isMultipleShift: scheduleMode === "multiple",

      occurrenceCount,

      occurrenceCountLabel: `${occurrenceCount} ${occurrenceCount === 1 ? "work date" : "work dates"}`,

      scheduledDateCount: occurrenceCount,

      scheduledDateCountLabel: `${occurrenceCount} ${occurrenceCount === 1 ? "work date" : "work dates"}`,

      requiredProfessionals,

      requiredProfessionalsLabel:
        `${requiredProfessionals} ` +
        `${requiredProfessionals === 1 ? "professional position" : "professional positions"}`,

      totalOccurrenceCount,

      totalOccurrenceCountLabel:
        `${totalOccurrenceCount} ` +
        `${totalOccurrenceCount === 1 ? "position/date record" : "position/date records"}`,

      occurrencesSectionTitle: requiredProfessionals > 1 ? "Positions / Work Dates" : "Work Dates",

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

      attendanceStatus: selectedOccurrenceView?.attendanceStatus || null,

      attendanceStatusLabel: selectedOccurrenceView?.attendanceStatus
        ? formatStatus(selectedOccurrenceView.attendanceStatus)
        : null,

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

      totalScheduledMinutesPerPosition: totalScheduledMinutes,

      totalScheduledHours:
        totalScheduledMinutes > 0 ? Number((totalScheduledMinutes / 60).toFixed(4)) : null,

      totalScheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(totalScheduledMinutes),

      totalStaffScheduledMinutes,

      totalStaffScheduledHours:
        totalStaffScheduledMinutes > 0
          ? Number((totalStaffScheduledMinutes / 60).toFixed(4))
          : null,

      totalStaffScheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(
        totalStaffScheduledMinutes
      ),

      scheduledHours: shift.scheduledHours,

      scheduledHoursDisplay: ShiftViewService.formatScheduledMinutes(totalScheduledMinutes),

      scheduleSummary,

      breakDuration: shift.breakDuration || 0,

      breakDurationDisplay: ShiftViewService.formatBreakDuration(shift.breakDuration),

      pricingSectionTitle: "Scheduled Pricing",

      pricingLockLabel: "Scheduled pricing locked",

      hourlyRate: shift.hourlyRate,

      hourlyRateDisplay: ShiftViewService.formatAmount(shift.hourlyRate, currency),

      standardBasePlatformFeeRate: pricingSnapshot.standardBasePlatformFeeRate,

      standardBasePlatformFeePercent: pricingSnapshot.standardBasePlatformFeePercent,

      basePlatformFeeRate: pricingSnapshot.basePlatformFeeRate,

      basePlatformFeePercent: pricingSnapshot.basePlatformFeePercent,

      overtimePlatformFeeRate: pricingSnapshot.overtimePlatformFeeRate,

      overtimePlatformFeePercent: pricingSnapshot.overtimePlatformFeePercent,

      basePlatformFeeBenefitSource: pricingSnapshot.basePlatformFeeBenefitSource,

      basePlatformFeeSubscription: pricingSnapshot.basePlatformFeeSubscription,

      pricingSnapshot,

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

      estimatedProfessionalPayPerOccurrence: financialSummary.perOccurrenceEstimate.professionalPay,

      estimatedProfessionalPayPerOccurrenceDisplay:
        financialSummary.perOccurrenceEstimate.professionalPayDisplay,

      estimatedPlatformFeePerOccurrence: financialSummary.perOccurrenceEstimate.platformFee,

      estimatedPlatformFeePerOccurrenceDisplay:
        financialSummary.perOccurrenceEstimate.platformFeeDisplay,

      estimatedEmployerChargePerOccurrence: financialSummary.perOccurrenceEstimate.employerCharge,

      estimatedEmployerChargePerOccurrenceDisplay:
        financialSummary.perOccurrenceEstimate.employerChargeDisplay,

      financialSummary,

      fundingMethod,

      fundingMethodLabel,

      fundedAmount,

      fundedAmountDisplay: ShiftViewService.formatAmount(fundedAmount, currency),

      overtimeTopUpRequired: financialSummary.outstandingOvertimeTopUp,

      overtimeTopUpRequiredDisplay: financialSummary.outstandingOvertimeTopUpDisplay,

      refundedAmount: financialSummary.refundedAmount,

      refundedAmountDisplay: financialSummary.refundedAmountDisplay,

      fundingTransaction: ShiftViewService.toId(shift.fundingTransaction),

      fundingInitiatedAt: shift.fundingInitiatedAt || null,

      fundingInitiatedAtDisplay: ShiftViewService.formatDateTime(shift.fundingInitiatedAt),

      fundedAt: shift.fundedAt || null,

      fundedAtDisplay: ShiftViewService.formatDateTime(shift.fundedAt),

      publishedAt: shift.publishedAt || null,

      publishedAtDisplay: ShiftViewService.formatDateTime(shift.publishedAt),

      fundingSummary,

      initialFundingNotice,

      totalApplications: Number(shift.totalApplications || 0),

      currentRoundApplications: Number(shift.currentRoundApplications || 0),

      applicationRound: Number(shift.applicationRound || 1),

      hiringSummary: shift.hiringSummary || null,

      assignmentSummary: shift.assignmentSummary || null,

      staffingSummary,

      occurrenceProgress: shift.occurrenceProgress || null,

      settlementSummary: shift.settlementSummary || null,

      isAssigned: staffingSummary.positionsWithAssignedCoverage > 0,

      attention,

      actionRequired: attention.requiresEmployerAction,

      actionRequiredCount: attention.actionRequiredCount,

      needsPayment,

      canCompletePayment:
        resolvedPermissions.canFundShifts &&
        resolvedPermissions.canPostShifts &&
        needsPayment &&
        !paymentIsRetry,

      canRetryPayment:
        resolvedPermissions.canFundShifts &&
        resolvedPermissions.canPostShifts &&
        needsPayment &&
        paymentIsRetry,

      paymentActionLabel:
        resolvedPermissions.canFundShifts && resolvedPermissions.canPostShifts && needsPayment
          ? paymentIsRetry
            ? "Retry Payment"
            : "Complete Payment"
          : null,

      parentAction,

      paymentReview,

      lifecycleActions,

      cancellationPolicySnapshot: shift.cancellationPolicySnapshot || null,

      cancellationCode: shift.cancellationCode || null,

      cancelledFromStatus: shift.cancelledFromStatus || null,

      cancelledBy: shift.cancelledBy || null,

      cancelledByUser: ShiftViewService.toId(shift.cancelledByUser),

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
