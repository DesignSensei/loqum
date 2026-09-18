// services/shifts/attendance/shiftAttendanceViewService.js

const { badgeClass, formatStatus } = require("../../../utils/statusHelper");

const ShiftViewService = require("../shiftViewService");
const ShiftPinAccessService = require("../shiftPinAccessService");

const { ATTENDANCE_STATUSES } = require("../../../constants/shiftLifecycle");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const EMPLOYER_ATTENDANCE_URL = "/employer/shifts/attendance";
const EMPLOYER_ASSIGNMENTS_URL = "/employer/shifts/assignments";

const DEFAULT_BADGE_CLASS = "badge-light-secondary";

const ATTENDANCE_STATUS_PRESENTATION = Object.freeze({
  all: Object.freeze({
    label: "All",
    badgeClass: "badge-light-primary",
  }),

  not_started: Object.freeze({
    label: "Not started",
    badgeClass: "badge-light-secondary",
  }),

  checked_in: Object.freeze({
    label: "Checked in",
    badgeClass: "badge-light-success",
  }),

  checked_out: Object.freeze({
    label: "Checked out",
    badgeClass: "badge-light-info",
  }),

  missed_checkin_review: Object.freeze({
    label: "Missed check-in review",
    badgeClass: "badge-light-warning",
  }),

  checkout_fallback_review: Object.freeze({
    label: "Checkout fallback review",
    badgeClass: "badge-light-warning",
  }),

  no_show: Object.freeze({
    label: "No-show",
    badgeClass: "badge-light-danger",
  }),

  disputed: Object.freeze({
    label: "Disputed",
    badgeClass: "badge-light-danger",
  }),

  settled: Object.freeze({
    label: "Settled",
    badgeClass: "badge-light-success",
  }),
});

const SUMMARY_CARD_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "currentlyCheckedIn",
    label: "Checked in now",
    icon: "ki-user-tick",
    iconPaths: 3,
    symbolClass: "bg-light-success",
    iconClass: "text-success",
    valueClass: "text-success",
  }),

  Object.freeze({
    key: "reviewRequired",
    label: "Attendance review",
    icon: "ki-information",
    iconPaths: 3,
    symbolClass: "bg-light-warning",
    iconClass: "text-warning",
    valueClass: "text-warning",
  }),

  Object.freeze({
    key: "noShow",
    label: "No-shows",
    icon: "ki-cross",
    iconPaths: 2,
    symbolClass: "bg-light-danger",
    iconClass: "text-danger",
    valueClass: "text-danger",
  }),

  Object.freeze({
    key: "settledAttendance",
    label: "Settled attendance",
    icon: "ki-check-circle",
    iconPaths: 2,
    symbolClass: "bg-light-primary",
    iconClass: "text-primary",
    valueClass: "text-primary",
  }),
]);

class ShiftAttendanceViewService {
  /* ─────────────────────────────── BASIC HELPERS ─────────────────────────────── */

  static toId(value) {
    if (!value) return null;

    return String(value._id || value);
  }

  static toFiniteNumber(value, fallback = null) {
    if (
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return fallback;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : fallback;
  }

  static toSafeInteger(value, fallback = null) {
    const number = ShiftAttendanceViewService.toFiniteNumber(value, fallback);

    return Number.isSafeInteger(number) ? number : fallback;
  }

  static statusPresentation(status) {
    const normalizedStatus = String(status || "")
      .trim()
      .toLowerCase();

    const presentation = ATTENDANCE_STATUS_PRESENTATION[normalizedStatus];

    return {
      status: normalizedStatus || null,

      label: presentation?.label || formatStatus(normalizedStatus) || "Unknown",

      badgeClass: presentation?.badgeClass || badgeClass[normalizedStatus] || DEFAULT_BADGE_CLASS,
    };
  }

  static buildUrl({ status = "all", shiftId = null, page = 1 } = {}) {
    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (shiftId) {
      params.set("shift", String(shiftId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${EMPLOYER_ATTENDANCE_URL}?${query}` : EMPLOYER_ATTENDANCE_URL;
  }

  static initials(firstName, lastName, displayName = null) {
    const parts = [firstName, lastName].map((value) => String(value || "").trim()).filter(Boolean);

    if (parts.length === 0 && displayName) {
      parts.push(...String(displayName).trim().split(/\s+/).filter(Boolean));
    }

    const value = parts
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("");

    return value || "P";
  }

  static formatOptionalDateTime(value) {
    return value ? ShiftViewService.formatDateTime(value) : null;
  }

  /* ─────────────────────────────── SHIFT / PROFESSIONAL ─────────────────────────────── */

  static buildBranchView(branch) {
    if (!branch) return null;

    const addressParts = [branch.address, branch.lga, branch.state]
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    return {
      id: ShiftAttendanceViewService.toId(branch),

      name: branch.name || "Branch",

      locationLabel: addressParts.join(", ") || null,
    };
  }

  static buildShiftView(shift) {
    if (!shift) return null;

    const shiftId = ShiftAttendanceViewService.toId(shift);

    return {
      id: shiftId,

      referenceCode: shift.referenceCode || null,

      roleTitle: shift.roleTitle || "Shift",

      professionalType: shift.professionalType || null,

      professionalTypeLabel: shift.professionalType ? formatStatus(shift.professionalType) : null,

      status: shift.status || null,

      statusLabel: shift.status ? formatStatus(shift.status) : null,

      statusBadgeClass: badgeClass[shift.status] || DEFAULT_BADGE_CLASS,

      branch: ShiftAttendanceViewService.buildBranchView(shift.branch),

      startAt: shift.startTime || null,

      endAt: shift.endTime || null,

      startDisplay: ShiftAttendanceViewService.formatOptionalDateTime(shift.startTime),

      endDisplay: ShiftAttendanceViewService.formatOptionalDateTime(shift.endTime),

      occurrenceCount: ShiftAttendanceViewService.toSafeInteger(shift.occurrenceCount, 0),

      requiredProfessionals: ShiftAttendanceViewService.toSafeInteger(
        shift.requiredProfessionals,
        0
      ),

      totalOccurrenceCount: ShiftAttendanceViewService.toSafeInteger(shift.totalOccurrenceCount, 0),

      detailsUrl: shiftId ? `${EMPLOYER_SHIFTS_URL}/${shiftId}` : null,
    };
  }

  static buildProfessionalView(professional) {
    if (!professional) {
      return {
        id: null,
        name: "Professional",
        firstName: null,
        lastName: null,
        initials: "P",
        photo: null,
        specialty: null,
        professionalType: null,
      };
    }

    const user = professional.user || {};

    const firstName = String(user.firstName || "").trim() || null;
    const lastName = String(user.lastName || "").trim() || null;

    const fallbackName = String(user.displayName || "").trim();

    const name = [firstName, lastName].filter(Boolean).join(" ") || fallbackName || "Professional";

    return {
      id: ShiftAttendanceViewService.toId(professional),

      name,

      firstName,

      lastName,

      initials: ShiftAttendanceViewService.initials(firstName, lastName, fallbackName),

      photo: user.photo || null,

      professionalType: professional.type || null,

      professionalTypeLabel: professional.type ? formatStatus(professional.type) : null,

      specialty: professional.specialty || null,

      yearsOfExperience: ShiftAttendanceViewService.toFiniteNumber(
        professional.yearsOfExperience,
        null
      ),

      averageRating: ShiftAttendanceViewService.toFiniteNumber(professional.averageRating, null),

      totalShiftsCompleted: ShiftAttendanceViewService.toSafeInteger(
        professional.totalShiftsCompleted,
        null
      ),
    };
  }

  /* ─────────────────────────────── ATTENDANCE AUDIT ─────────────────────────────── */

  static buildAttendanceTimeline(occurrence) {
    const items = [];

    if (occurrence.checkedInAt) {
      items.push({
        key: "checked_in",
        label: "Checked in",
        value: ShiftViewService.formatDateTime(occurrence.checkedInAt),
        at: occurrence.checkedInAt,
        badgeClass: "badge-light-success",
      });
    }

    if (occurrence.checkInPinUsedAt) {
      items.push({
        key: "check_in_pin_used",
        label: "Check-in PIN used",
        value: ShiftViewService.formatDateTime(occurrence.checkInPinUsedAt),
        at: occurrence.checkInPinUsedAt,
        badgeClass: "badge-light-primary",
      });
    }

    if (occurrence.checkedOutAt) {
      items.push({
        key: "checked_out",
        label: "Checked out",
        value: ShiftViewService.formatDateTime(occurrence.checkedOutAt),
        at: occurrence.checkedOutAt,
        badgeClass: "badge-light-info",
      });
    }

    if (occurrence.checkOutPinUsedAt) {
      items.push({
        key: "check_out_pin_used",
        label: "Check-out PIN used",
        value: ShiftViewService.formatDateTime(occurrence.checkOutPinUsedAt),
        at: occurrence.checkOutPinUsedAt,
        badgeClass: "badge-light-primary",
      });
    }

    items.sort((left, right) => {
      const leftTime = left.at ? new Date(left.at).getTime() : 0;
      const rightTime = right.at ? new Date(right.at).getTime() : 0;

      return leftTime - rightTime;
    });

    return items;
  }

  static buildAttendanceOverrideView(override) {
    if (!override || override.used !== true) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      type: override.type || null,

      typeLabel: override.type ? formatStatus(override.type) : "Attendance override",

      reason: override.reason || null,

      reasonLabel: override.reason ? formatStatus(override.reason) : null,

      approvedStartTime: override.approvedStartTime || null,

      approvedStartTimeDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        override.approvedStartTime
      ),

      approvedEndTime: override.approvedEndTime || null,

      approvedEndTimeDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        override.approvedEndTime
      ),

      reviewedAt: override.reviewedAt || null,

      reviewedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(override.reviewedAt),

      notes: override.notes || null,
    };
  }

  static buildLateCheckoutView(lateCheckout) {
    if (!lateCheckout || lateCheckout.occurred !== true) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      minutesLate: ShiftAttendanceViewService.toSafeInteger(lateCheckout.minutesLate, 0),

      selectedOption: lateCheckout.selectedOption || null,

      selectedOptionLabel: lateCheckout.selectedOption
        ? formatStatus(lateCheckout.selectedOption)
        : null,

      reason: lateCheckout.reason || null,

      reasonLabel: lateCheckout.reason ? formatStatus(lateCheckout.reason) : null,

      notes: lateCheckout.notes || null,

      recordedAt: lateCheckout.recordedAt || null,

      recordedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(lateCheckout.recordedAt),
    };
  }

  static buildCheckoutFallbackView(checkoutFallback) {
    if (!checkoutFallback || checkoutFallback.required !== true) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      reason: checkoutFallback.reason || null,

      reasonLabel: checkoutFallback.reason ? formatStatus(checkoutFallback.reason) : null,

      requestedAt: checkoutFallback.requestedAt || null,

      requestedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        checkoutFallback.requestedAt
      ),

      resolvedAt: checkoutFallback.resolvedAt || null,

      resolvedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        checkoutFallback.resolvedAt
      ),

      approvedEndTime: checkoutFallback.approvedEndTime || null,

      approvedEndTimeDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        checkoutFallback.approvedEndTime
      ),

      notes: checkoutFallback.notes || null,

      isResolved: Boolean(checkoutFallback.resolvedAt),
    };
  }

  static buildAbsenceView(occurrence) {
    if (!occurrence.absenceExplanation) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      explanation: occurrence.absenceExplanation,

      explainedAt: occurrence.absenceExplainedAt || null,

      explainedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        occurrence.absenceExplainedAt
      ),
    };
  }

  /* ─────────────────────────────── PIN PRESENTATION ─────────────────────────────── */

  static buildPinAccessView({ shift, occurrence, canRevealAttendancePins }) {
    if (!shift || !occurrence) {
      return {
        canViewAttendancePins: false,
        canRevealCheckInPin: false,
        canRevealCheckOutPin: false,
        hasAvailablePin: false,
        unavailableMessage: "Attendance PINs are unavailable for this occurrence.",
        actions: [],
      };
    }

    const authorization = ShiftPinAccessService.buildOccurrencePinAuthorization({
      shift,
      occurrence,
    });

    const urls = ShiftPinAccessService.buildOccurrencePinUrls({
      shiftId: shift._id,
      occurrenceId: occurrence._id,
      employerShiftsUrl: EMPLOYER_SHIFTS_URL,
    });

    const canViewAttendancePins = Boolean(
      canRevealAttendancePins && authorization.canViewAttendancePins
    );

    const canRevealCheckInPin = Boolean(
      canRevealAttendancePins && authorization.canRevealCheckInPin
    );

    const canRevealCheckOutPin = Boolean(
      canRevealAttendancePins && authorization.canRevealCheckOutPin
    );

    const actions = [];

    if (canRevealCheckInPin && urls.checkInPinUrl) {
      actions.push({
        key: "check_in",
        label: "View check-in PIN",
        buttonClass: "btn-light-primary",
        icon: "ki-key",
        url: urls.checkInPinUrl,
        method: "GET",
        modalTitle: "Check-in PIN",
      });
    }

    if (canRevealCheckOutPin && urls.checkOutPinUrl) {
      actions.push({
        key: "check_out",
        label: "View check-out PIN",
        buttonClass: "btn-light-info",
        icon: "ki-key",
        url: urls.checkOutPinUrl,
        method: "GET",
        modalTitle: "Check-out PIN",
      });
    }

    return {
      canViewAttendancePins,

      canRevealCheckInPin,

      canRevealCheckOutPin,

      hasAvailablePin: Boolean(canRevealAttendancePins && authorization.hasAvailablePin),

      unavailableMessage: canRevealAttendancePins
        ? authorization.unavailableMessage || null
        : "You do not have permission to view attendance PINs.",

      actions,
    };
  }

  /* ─────────────────────────────── OCCURRENCE VIEW ─────────────────────────────── */

  static buildOccurrenceView({ occurrence, canRevealAttendancePins, currentTime }) {
    const shift = occurrence.shift || null;

    const identity = ShiftViewService.buildOccurrenceIdentity({
      shift,
      occurrence,
    });

    const statusView = ShiftViewService.buildOccurrenceStatusView(occurrence);

    const attendancePresentation = ShiftAttendanceViewService.statusPresentation(
      occurrence.attendanceStatus
    );

    const pinAccess = ShiftAttendanceViewService.buildPinAccessView({
      shift,
      occurrence,
      canRevealAttendancePins,
    });

    const professional = ShiftAttendanceViewService.buildProfessionalView(
      occurrence.assignedProfessional
    );

    const shiftView = ShiftAttendanceViewService.buildShiftView(shift);

    const isActive = ShiftPinAccessService.isOccurrenceActive(occurrence);

    const normalizedCurrentTime = new Date(currentTime);

    const isUpcoming = Boolean(
      occurrence.startTime && new Date(occurrence.startTime) > normalizedCurrentTime
    );

    const isPast = Boolean(
      occurrence.endTime && new Date(occurrence.endTime) <= normalizedCurrentTime
    );

    const detailsUrl = shiftView?.id
      ? `${EMPLOYER_SHIFTS_URL}/${shiftView.id}?occurrence=${occurrence._id}`
      : null;

    const assignmentId = ShiftAttendanceViewService.toId(occurrence.assignment);

    return {
      id: String(occurrence._id),

      shiftId: ShiftAttendanceViewService.toId(shift),

      referenceCode: occurrence.referenceCode || null,

      slotNumber: identity.slotNumber,

      sequenceNumber: identity.sequenceNumber,

      positionLabel: identity.positionLabel,

      dateLabel: identity.dateLabel,

      occurrenceLabel: identity.occurrenceLabel,

      occurrenceDate: occurrence.occurrenceDate || null,

      occurrenceDateDisplay: occurrence.occurrenceDate
        ? ShiftViewService.formatLocalDate(occurrence.occurrenceDate)
        : ShiftViewService.formatDate(occurrence.startTime),

      startTime: occurrence.startTime || null,

      endTime: occurrence.endTime || null,

      startTimeDisplay: ShiftViewService.formatTime(occurrence.startTime),

      endTimeDisplay: ShiftViewService.formatTime(occurrence.endTime),

      dateTimeDisplay:
        `${ShiftViewService.formatDate(occurrence.startTime)} • ` +
        `${ShiftViewService.formatTime(occurrence.startTime)}–` +
        `${ShiftViewService.formatTime(occurrence.endTime)}`,

      scheduleTimeZone: occurrence.scheduleTimeZone || shift?.scheduleTimeZone || null,

      shift: shiftView,

      professional,

      assignment: occurrence.assignment
        ? {
            id: assignmentId,

            referenceCode: occurrence.assignment.referenceCode || null,

            assignmentType: occurrence.assignment.assignmentType || null,

            assignmentTypeLabel: occurrence.assignment.assignmentType
              ? formatStatus(occurrence.assignment.assignmentType)
              : null,

            status: occurrence.assignment.status || null,

            statusLabel: occurrence.assignment.status
              ? formatStatus(occurrence.assignment.status)
              : null,

            statusBadgeClass: badgeClass[occurrence.assignment.status] || DEFAULT_BADGE_CLASS,

            slotNumber: occurrence.assignment.slotNumber || null,

            detailsUrl: EMPLOYER_ASSIGNMENTS_URL,
          }
        : null,

      assignmentStatus: occurrence.assignmentStatus || null,

      assignmentStatusLabel:
        statusView.assignment?.label || formatStatus(occurrence.assignmentStatus),

      assignmentStatusBadgeClass:
        statusView.assignment?.badgeClass ||
        badgeClass[occurrence.assignmentStatus] ||
        DEFAULT_BADGE_CLASS,

      occurrenceStatus: occurrence.status || null,

      occurrenceStatusLabel: statusView.occurrence?.label || formatStatus(occurrence.status),

      occurrenceStatusBadgeClass:
        statusView.occurrence?.badgeClass || badgeClass[occurrence.status] || DEFAULT_BADGE_CLASS,

      attendanceStatus: occurrence.attendanceStatus || null,

      attendanceStatusLabel: attendancePresentation.label,

      attendanceStatusBadgeClass: attendancePresentation.badgeClass,

      settlementStatus: occurrence.settlementStatus || null,

      settlementStatusLabel:
        statusView.settlement?.label || formatStatus(occurrence.settlementStatus),

      settlementStatusBadgeClass:
        statusView.settlement?.badgeClass ||
        badgeClass[occurrence.settlementStatus] ||
        DEFAULT_BADGE_CLASS,

      checkedInAt: occurrence.checkedInAt || null,

      checkedInAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(occurrence.checkedInAt),

      checkedOutAt: occurrence.checkedOutAt || null,

      checkedOutAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        occurrence.checkedOutAt
      ),

      attendancePinsGeneratedAt: occurrence.attendancePinsGeneratedAt || null,

      attendancePinsGeneratedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        occurrence.attendancePinsGeneratedAt
      ),

      checkInPinUsedAt: occurrence.checkInPinUsedAt || null,

      checkInPinUsedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        occurrence.checkInPinUsedAt
      ),

      checkOutPinUsedAt: occurrence.checkOutPinUsedAt || null,

      checkOutPinUsedAtDisplay: ShiftAttendanceViewService.formatOptionalDateTime(
        occurrence.checkOutPinUsedAt
      ),

      timeline: ShiftAttendanceViewService.buildAttendanceTimeline(occurrence),

      attendanceOverride: ShiftAttendanceViewService.buildAttendanceOverrideView(
        occurrence.attendanceOverride
      ),

      lateCheckout: ShiftAttendanceViewService.buildLateCheckoutView(occurrence.lateCheckout),

      checkoutFallback: ShiftAttendanceViewService.buildCheckoutFallbackView(
        occurrence.checkoutFallback
      ),

      absence: ShiftAttendanceViewService.buildAbsenceView(occurrence),

      activeClaimId: ShiftAttendanceViewService.toId(occurrence.activeClaim),

      activeDisputeId: ShiftAttendanceViewService.toId(occurrence.activeDispute),

      hasActiveCase: Boolean(occurrence.activeClaim || occurrence.activeDispute),

      pinAccess,

      timing: {
        isActive,

        isUpcoming,

        isPast,

        label: isActive ? "In progress" : isUpcoming ? "Upcoming" : "Past",

        badgeClass: isActive
          ? "badge-light-success"
          : isUpcoming
            ? "badge-light-primary"
            : "badge-light-secondary",
      },

      detailsUrl,

      data: {
        occurrenceId: String(occurrence._id),

        shiftId: ShiftAttendanceViewService.toId(shift),

        slotNumber: identity.slotNumber,

        sequenceNumber: identity.sequenceNumber,

        attendanceStatus: occurrence.attendanceStatus || null,
      },
    };
  }

  /* ─────────────────────────────── FILTERS / SUMMARY ─────────────────────────────── */

  static buildSummaryCards(scopeCounts = {}) {
    return SUMMARY_CARD_DEFINITIONS.map((definition) => ({
      ...definition,

      value: ShiftAttendanceViewService.toSafeInteger(scopeCounts[definition.key], 0),
    }));
  }

  static buildStatusOptions({ selectedStatus = "all", shiftId = null }) {
    return ["all", ...ATTENDANCE_STATUSES].map((status) => {
      const presentation = ShiftAttendanceViewService.statusPresentation(status);

      return {
        value: status,

        label: status === "all" ? "All attendance" : presentation.label,

        active: status === selectedStatus,

        url: ShiftAttendanceViewService.buildUrl({
          status,
          shiftId,
        }),
      };
    });
  }

  static buildFocusedShiftSection(focusedShift) {
    if (!focusedShift) {
      return {
        visible: false,
      };
    }

    const shift = ShiftAttendanceViewService.buildShiftView(focusedShift);

    return {
      visible: true,

      title: shift.roleTitle,

      referenceCode: shift.referenceCode,

      branch: shift.branch,

      statusLabel: shift.statusLabel,

      statusBadgeClass: shift.statusBadgeClass,

      startDisplay: shift.startDisplay,

      endDisplay: shift.endDisplay,

      occurrenceCount: shift.occurrenceCount,

      requiredProfessionals: shift.requiredProfessionals,

      viewShiftAction: {
        visible: Boolean(shift.detailsUrl),

        label: "View Shift",

        buttonClass: "btn-light-primary",

        url: shift.detailsUrl,
      },

      showAllAction: {
        visible: true,

        label: "Show all attendance",

        buttonClass: "btn-light",

        url: EMPLOYER_ATTENDANCE_URL,
      },
    };
  }

  static buildPagination({ pagination, selectedStatus, shiftId }) {
    const currentPage = ShiftAttendanceViewService.toSafeInteger(pagination?.currentPage, 1);

    const totalPages = ShiftAttendanceViewService.toSafeInteger(pagination?.totalPages, 1);

    return {
      currentPage,

      totalPages,

      totalItems: ShiftAttendanceViewService.toSafeInteger(pagination?.totalItems, 0),

      startItem: ShiftAttendanceViewService.toSafeInteger(pagination?.startItem, 0),

      endItem: ShiftAttendanceViewService.toSafeInteger(pagination?.endItem, 0),

      hasPagination: pagination?.hasPagination === true,

      pageText:
        pagination?.totalItems > 0
          ? `Showing ${pagination.startItem}–${pagination.endItem} of ${pagination.totalItems}`
          : "No attendance records",

      previous: {
        enabled: pagination?.hasPreviousPage === true,

        label: "Previous",

        url:
          pagination?.hasPreviousPage === true
            ? ShiftAttendanceViewService.buildUrl({
                status: selectedStatus,
                shiftId,
                page: currentPage - 1,
              })
            : null,
      },

      next: {
        enabled: pagination?.hasNextPage === true,

        label: "Next",

        url:
          pagination?.hasNextPage === true
            ? ShiftAttendanceViewService.buildUrl({
                status: selectedStatus,
                shiftId,
                page: currentPage + 1,
              })
            : null,
      },
    };
  }

  /* ─────────────────────────────── PAGE VIEW ─────────────────────────────── */

  static buildEmployerAttendancePageView(pageData = {}) {
    const selectedAttendanceStatus = pageData.selectedAttendanceStatus || "all";

    const focusedShiftId = pageData.focusedShift
      ? ShiftAttendanceViewService.toId(pageData.focusedShift)
      : null;

    const occurrences = (pageData.occurrences || []).map((occurrence) =>
      ShiftAttendanceViewService.buildOccurrenceView({
        occurrence,

        canRevealAttendancePins: pageData.canRevealAttendancePins === true,

        currentTime: pageData.currentTime || new Date(),
      })
    );

    return {
      pageTitle: "Shift Attendance",

      employer: pageData.employer || null,

      canManageAttendance: pageData.canManageAttendance === true,

      canRevealAttendancePins: pageData.canRevealAttendancePins === true,

      readOnlyNotice: {
        visible: pageData.canManageAttendance !== true,

        title: "Attendance is read-only for your role",

        message:
          "You can review attendance for your assigned branches, but only authorized employer managers can reveal attendance PINs.",

        noticeClass: "bg-light-info border-info",

        iconClass: "text-info",

        icon: "ki-information",
      },

      summaryCards: ShiftAttendanceViewService.buildSummaryCards(pageData.scopeCounts),

      focusedShiftSection: ShiftAttendanceViewService.buildFocusedShiftSection(
        pageData.focusedShift
      ),

      filters: {
        selectedLabel:
          selectedAttendanceStatus === "all"
            ? "All attendance"
            : ShiftAttendanceViewService.statusPresentation(selectedAttendanceStatus).label,

        selectedStatus: selectedAttendanceStatus,

        options: ShiftAttendanceViewService.buildStatusOptions({
          selectedStatus: selectedAttendanceStatus,

          shiftId: focusedShiftId,
        }),

        hasActiveFilters: selectedAttendanceStatus !== "all",

        clearAction: {
          visible: selectedAttendanceStatus !== "all",

          label: "Clear filters",

          buttonClass: "btn-light-danger",

          url: ShiftAttendanceViewService.buildUrl({
            shiftId: focusedShiftId,
          }),
        },
      },

      resultsHeader: {
        title: focusedShiftId ? "Shift attendance records" : "Attendance records",

        subtitle:
          pageData.pagination?.totalItems === 1
            ? "1 occurrence matches the current filters."
            : `${Number(
                pageData.pagination?.totalItems || 0
              )} occurrences match the current filters.`,
      },

      occurrences,

      hasOccurrences: occurrences.length > 0,

      emptyState: {
        icon: "ki-calendar-remove",

        title: "No attendance records found",

        message:
          selectedAttendanceStatus !== "all" || focusedShiftId
            ? "No occurrences match the current attendance filters."
            : "Assigned Shift occurrences will appear here when attendance records are available.",

        action: {
          visible: Boolean(selectedAttendanceStatus !== "all" || focusedShiftId),

          label: "Clear filters",

          buttonClass: "btn-light-primary",

          url: EMPLOYER_ATTENDANCE_URL,
        },
      },

      pagination: ShiftAttendanceViewService.buildPagination({
        pagination: pageData.pagination,

        selectedStatus: selectedAttendanceStatus,

        shiftId: focusedShiftId,
      }),

      pinModal: {
        enabled: pageData.canRevealAttendancePins === true,

        id: "shiftAttendancePinModal",

        titleId: "shiftAttendancePinModalLabel",

        contextId: "shiftAttendancePinContext",

        alertId: "shiftAttendancePinAlert",

        pinValueId: "shiftAttendancePinValue",

        closeButtonLabel: "Close",

        defaultTitle: "Attendance PIN",

        loadingText: "Retrieving PIN...",
      },
    };
  }
}

module.exports = ShiftAttendanceViewService;
