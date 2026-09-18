// services/shifts/assignments/shiftAssignmentViewService.js

const { badgeClass, formatStatus } = require("../../../utils/statusHelper");

const { ASSIGNMENT_TYPES, ASSIGNMENT_STATUSES } = require("../../../constants/shiftAssignment");

const {
  EMPLOYER_ASSIGNMENT_ISSUE_TYPES,
  EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS,
  MAX_EMPLOYER_ISSUE_DETAILS_LENGTH,
  MAX_EMPLOYER_RESPONSE_DETAILS_LENGTH,
  MAX_ASSIGNMENT_CASE_ESCALATION_REASON_LENGTH,
} = require("../../../constants/shiftAssignmentCase");

const EMPLOYER_ASSIGNMENTS_URL = "/employer/shifts/assignments";
const EMPLOYER_APPLICATIONS_URL = "/employer/shifts/applications";
const EMPLOYER_ATTENDANCE_URL = "/employer/shifts/attendance";
const EMPLOYER_SHIFTS_URL = "/employer/shifts";

const DEFAULT_BADGE_CLASS = "badge-light-secondary";

const ASSIGNMENT_STATUS_BADGES = Object.freeze({
  scheduled: "badge-light-primary",
  active: "badge-light-success",
  ending: "badge-light-warning",
  ended: "badge-light-secondary",
  cancelled: "badge-light-danger",
});

const ASSIGNMENT_TYPE_BADGES = Object.freeze({
  initial: "badge-light-primary",
  replacement: "badge-light-warning",
});

const CASE_STATUS_BADGES = Object.freeze({
  awaiting_employer_acknowledgment: "badge-light-warning",
  awaiting_professional_response: "badge-light-info",
  awaiting_employer_response: "badge-light-warning",
  replacement_requested: "badge-light-primary",
  under_admin_review: "badge-light-danger",
  resolved_continue: "badge-light-success",
  resolved_exit: "badge-light-success",
  withdrawn: "badge-light-secondary",
  dismissed: "badge-light-secondary",
  cancelled: "badge-light-secondary",
});

const OCCURRENCE_ASSIGNMENT_BADGES = Object.freeze({
  unassigned: "badge-light-secondary",
  assigned: "badge-light-success",
  replacement_required: "badge-light-warning",
});

const SUMMARY_CARD_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "currentAssignments",
    label: "Current assignments",
    icon: "ki-user-tick",
    iconPaths: Object.freeze([1, 2, 3]),
    symbolClass: "bg-light-success",
    iconClass: "text-success",
    valueClass: "text-success",
  }),

  Object.freeze({
    key: "assignmentsWithOpenCase",
    label: "Open cases",
    icon: "ki-information",
    iconPaths: Object.freeze([1, 2, 3]),
    symbolClass: "bg-light-warning",
    iconClass: "text-warning",
    valueClass: "text-warning",
  }),

  Object.freeze({
    key: "replacementAssignments",
    label: "Replacements",
    icon: "ki-briefcase",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-primary",
    iconClass: "text-primary",
    valueClass: "text-primary",
  }),

  Object.freeze({
    key: "totalAssignments",
    label: "All assignments",
    icon: "ki-abstract-26",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-dark",
    iconClass: "text-dark",
    valueClass: "text-gray-900",
  }),
]);

const PAGE_COPY = Object.freeze({
  title: "Shift Assignments",
  clearFiltersLabel: "Clear filters",
  emptyTitle: "No assignments found",
  readOnlyTitle: "Read-only assignment access",
  readOnlyMessage:
    "You can review assignments for your assigned branches, but assignment-management actions are unavailable for your role.",
});

const EMPLOYER_RESPONSE_PRESENTATION = Object.freeze({
  acknowledge_and_request_replacement: Object.freeze({
    label: "Acknowledge exit and request replacement",
    description:
      "Confirm the professional's exit and release the untouched future assignment tail for replacement handling.",
  }),

  accept_continuation: Object.freeze({
    label: "Accept continuation",
    description: "Accept the professional's response that they will continue the assignment.",
  }),

  dismiss_issue: Object.freeze({
    label: "Close issue — assignment continues",
    description: "Close the employer-reported issue without ending the assignment.",
  }),
});

const EMPLOYER_RESPONDABLE_CASE_STATUSES = Object.freeze([
  "awaiting_employer_acknowledgment",
  "awaiting_employer_response",
]);

const EMPLOYER_ESCALATABLE_CASE_STATUSES = Object.freeze([
  "awaiting_employer_acknowledgment",
  "awaiting_professional_response",
  "awaiting_employer_response",
]);

const EMPLOYER_ISSUE_OPEN_ASSIGNMENT_STATUSES = Object.freeze(["scheduled", "active"]);

const EMPLOYER_ISSUE_BLOCKED_SHIFT_STATUSES = Object.freeze([
  "pending_funding",
  "cancelled",
  "completed",
]);

const ACTION_MODAL = Object.freeze({
  id: "shiftAssignmentActionModal",
  formId: "shiftAssignmentActionForm",
  titleId: "shiftAssignmentActionModalLabel",
  contextId: "shiftAssignmentActionContext",
  alertId: "shiftAssignmentActionAlert",
  noticeId: "shiftAssignmentActionNotice",
  fieldsContainerId: "shiftAssignmentActionFields",
  actionTypeInputId: "shiftAssignmentActionType",
  actionUrlInputId: "shiftAssignmentActionUrl",
  submitButtonId: "shiftAssignmentActionSubmit",
  defaultTitle: "Manage assignment",
  defaultSubmitLabel: "Continue",
  loadingLabel: "Please wait...",
  cancelLabel: "Cancel",
});

class ShiftAssignmentViewService {
  /* ------------------------------- HELPERS ------------------------------- */

  static toId(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      return value;
    }

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

  static toNonNegativeSafeInteger(value, fallback = 0) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  static toPositiveSafeInteger(value, fallback = null) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    return Number.isNaN(currentTime.getTime()) ? new Date() : currentTime;
  }

  static formatStatusLabel(value) {
    return value ? formatStatus(String(value)) : null;
  }

  static getGenericBadgeClass(status) {
    return status ? badgeClass?.[status] || DEFAULT_BADGE_CLASS : DEFAULT_BADGE_CLASS;
  }

  static getAssignmentStatusBadgeClass(status) {
    return ASSIGNMENT_STATUS_BADGES[status] || this.getGenericBadgeClass(status);
  }

  static getAssignmentTypeBadgeClass(assignmentType) {
    return ASSIGNMENT_TYPE_BADGES[assignmentType] || DEFAULT_BADGE_CLASS;
  }

  static getCaseStatusBadgeClass(status) {
    return CASE_STATUS_BADGES[status] || this.getGenericBadgeClass(status);
  }

  static getOccurrenceAssignmentBadgeClass(status) {
    return OCCURRENCE_ASSIGNMENT_BADGES[status] || this.getGenericBadgeClass(status);
  }

  static formatDate(value, timeZone = null) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    const options = {
      dateStyle: "medium",
    };

    if (timeZone) {
      options.timeZone = timeZone;
    }

    try {
      return new Intl.DateTimeFormat("en-NG", options).format(date);
    } catch (error) {
      delete options.timeZone;

      return new Intl.DateTimeFormat("en-NG", options).format(date);
    }
  }

  static formatDateTime(value, timeZone = null) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    const options = {
      dateStyle: "medium",
      timeStyle: "short",
    };

    if (timeZone) {
      options.timeZone = timeZone;
    }

    try {
      return new Intl.DateTimeFormat("en-NG", options).format(date);
    } catch (error) {
      delete options.timeZone;

      return new Intl.DateTimeFormat("en-NG", options).format(date);
    }
  }

  static formatLocalDate(value) {
    if (!value) {
      return "-";
    }

    const normalized = String(value).trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return this.formatDate(value, "UTC");
    }

    const date = new Date(`${normalized}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(date);
  }

  static buildInitials(name) {
    const parts = String(name || "Professional")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!parts.length) {
      return "P";
    }

    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    return `${parts[0][0] || ""}${parts[parts.length - 1][0] || ""}`.toUpperCase();
  }

  static pluralize(value, singular, plural = `${singular}s`) {
    return Number(value) === 1 ? singular : plural;
  }

  static buildQueryUrl({
    status = "all",
    assignmentType = "all",
    shiftId = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (assignmentType && assignmentType !== "all") {
      params.set("type", assignmentType);
    }

    if (shiftId) {
      params.set("shift", String(shiftId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${EMPLOYER_ASSIGNMENTS_URL}?${query}` : EMPLOYER_ASSIGNMENTS_URL;
  }

  static buildShiftScopedUrl(baseUrl, shiftId) {
    if (!shiftId) {
      return baseUrl;
    }

    const params = new URLSearchParams();

    params.set("shift", String(shiftId));

    return `${baseUrl}?${params.toString()}`;
  }

  static buildReportIssueUrl(assignmentId) {
    return assignmentId ? `${EMPLOYER_ASSIGNMENTS_URL}/${assignmentId}/issues` : null;
  }

  static buildRespondToCaseUrl(assignmentId, caseId) {
    return assignmentId && caseId
      ? `${EMPLOYER_ASSIGNMENTS_URL}/${assignmentId}/cases/${caseId}/respond`
      : null;
  }

  static buildEscalateCaseUrl(assignmentId, caseId) {
    return assignmentId && caseId
      ? `${EMPLOYER_ASSIGNMENTS_URL}/${assignmentId}/cases/${caseId}/escalate`
      : null;
  }

  /* ------------------------------- BRANCH / SHIFT ------------------------------- */

  static buildBranchView(branch) {
    if (!branch) {
      return null;
    }

    const locationLabel = [branch.address, branch.lga, branch.state]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", ");

    return {
      id: this.toId(branch),

      name: branch.name || null,

      address: branch.address || null,

      state: branch.state || null,

      lga: branch.lga || null,

      locationLabel: locationLabel || null,
    };
  }

  static buildShiftView(shift) {
    if (!shift) {
      return null;
    }

    const id = this.toId(shift);

    const branch = this.buildBranchView(shift.branch);

    const occurrenceCount = this.toPositiveSafeInteger(shift.occurrenceCount, null);

    const requiredProfessionals = this.toPositiveSafeInteger(shift.requiredProfessionals, null);

    const totalOccurrenceCount = this.toPositiveSafeInteger(shift.totalOccurrenceCount, null);

    const firstOccurrenceDateDisplay = this.formatLocalDate(shift.firstOccurrenceDate);

    const lastOccurrenceDateDisplay = this.formatLocalDate(shift.lastOccurrenceDate);

    const dateRangeDisplay =
      shift.firstOccurrenceDate &&
      shift.lastOccurrenceDate &&
      firstOccurrenceDateDisplay !== lastOccurrenceDateDisplay
        ? `${firstOccurrenceDateDisplay} - ${lastOccurrenceDateDisplay}`
        : firstOccurrenceDateDisplay;

    return {
      id,

      referenceCode: shift.referenceCode || null,

      roleTitle: shift.roleTitle || null,

      heading: shift.roleTitle || shift.referenceCode || "Shift",

      professionalType: shift.professionalType || null,

      professionalTypeLabel: this.formatStatusLabel(shift.professionalType),

      scheduleMode: shift.scheduleMode || null,

      scheduleModeLabel: this.formatStatusLabel(shift.scheduleMode),

      scheduleTimeZone: shift.scheduleTimeZone || null,

      occurrenceCount,

      requiredProfessionals,

      totalOccurrenceCount,

      staffingDisplay:
        requiredProfessionals === null
          ? null
          : `${requiredProfessionals} ${this.pluralize(requiredProfessionals, "position")}`,

      dateRangeDisplay,

      startTime: shift.startTime || null,

      endTime: shift.endTime || null,

      startTimeDisplay: this.formatDateTime(shift.startTime, shift.scheduleTimeZone || null),

      endTimeDisplay: this.formatDateTime(shift.endTime, shift.scheduleTimeZone || null),

      status: shift.status || null,

      statusLabel: this.formatStatusLabel(shift.status),

      statusBadgeClass: this.getGenericBadgeClass(shift.status),

      paymentStatus: shift.paymentStatus || null,

      paymentStatusLabel: this.formatStatusLabel(shift.paymentStatus),

      paymentStatusBadgeClass: this.getGenericBadgeClass(shift.paymentStatus),

      branch,

      hiringSummary:
        shift.hiringSummary && typeof shift.hiringSummary === "object"
          ? {
              ...shift.hiringSummary,
            }
          : null,

      assignmentSummary:
        shift.assignmentSummary && typeof shift.assignmentSummary === "object"
          ? {
              ...shift.assignmentSummary,
            }
          : null,

      occurrenceProgress:
        shift.occurrenceProgress && typeof shift.occurrenceProgress === "object"
          ? {
              ...shift.occurrenceProgress,
            }
          : null,

      createdAt: shift.createdAt || null,

      createdAtDisplay: this.formatDateTime(shift.createdAt),

      detailsUrl: id ? `${EMPLOYER_SHIFTS_URL}/${id}` : null,

      applicationsUrl: id
        ? this.buildShiftScopedUrl(EMPLOYER_APPLICATIONS_URL, id)
        : EMPLOYER_APPLICATIONS_URL,

      attendanceUrl: id
        ? this.buildShiftScopedUrl(EMPLOYER_ATTENDANCE_URL, id)
        : EMPLOYER_ATTENDANCE_URL,

      assignmentsUrl: id
        ? this.buildQueryUrl({
            shiftId: id,
          })
        : EMPLOYER_ASSIGNMENTS_URL,
    };
  }

  /* ------------------------------- PROFESSIONAL ------------------------------- */

  static buildProfessionalName(professional) {
    const user = professional?.user || null;

    const displayName = String(user?.displayName || "").trim();

    if (displayName) {
      return displayName;
    }

    return (
      [user?.firstName, user?.lastName]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ") || "Professional"
    );
  }

  static buildProfessionalView(professional) {
    if (!professional) {
      return null;
    }

    const user = professional.user || null;

    const name = this.buildProfessionalName(professional);

    const years = this.toFiniteNumber(professional.yearsOfExperience, null);

    const rating = this.toFiniteNumber(professional.averageRating, null);

    const reliability = this.toFiniteNumber(professional.reliabilityScore, null);

    const completed = this.toFiniteNumber(professional.totalShiftsCompleted, null);

    return {
      id: this.toId(professional),

      userId: this.toId(user),

      name,

      avatar: {
        photo: user?.photo || null,

        initials: this.buildInitials(name),

        alt: name,
      },

      professionalType: professional.type || null,

      professionalTypeLabel: this.formatStatusLabel(professional.type),

      specialty: professional.specialty || null,

      yearsOfExperience: years,

      averageRating: rating,

      reliabilityScore: reliability,

      totalShiftsCompleted: completed,

      metrics: [
        {
          key: "experience",

          label: "Experience",

          value: years === null ? "-" : `${years} ${this.pluralize(years, "year")}`,
        },

        {
          key: "rating",

          label: "Rating",

          value: rating === null ? "-" : String(rating),

          icon: rating === null ? null : "ki-star",
        },

        {
          key: "reliability",

          label: "Reliability",

          value: reliability === null ? "-" : `${reliability}%`,
        },

        {
          key: "completed",

          label: "Completed Shifts",

          value: completed === null ? "-" : String(completed),
        },
      ],

      statusBadges: [
        professional.licenceVerificationStatus
          ? {
              key: "licence",

              label: `Licence: ${this.formatStatusLabel(professional.licenceVerificationStatus)}`,

              badgeClass: this.getGenericBadgeClass(professional.licenceVerificationStatus),
            }
          : null,

        professional.identityVerificationStatus
          ? {
              key: "identity",

              label: `Identity: ${this.formatStatusLabel(professional.identityVerificationStatus)}`,

              badgeClass: this.getGenericBadgeClass(professional.identityVerificationStatus),
            }
          : null,

        professional.professionalApprovalStatus
          ? {
              key: "approval",

              label: `Approval: ${this.formatStatusLabel(professional.professionalApprovalStatus)}`,

              badgeClass: this.getGenericBadgeClass(professional.professionalApprovalStatus),
            }
          : null,

        professional.tier
          ? {
              key: "tier",

              label: this.formatStatusLabel(professional.tier),

              badgeClass: "badge-light-primary",
            }
          : null,
      ].filter(Boolean),

      availabilityStatus: professional.availabilityStatus || null,

      availabilityStatusLabel: this.formatStatusLabel(professional.availabilityStatus),

      accountStatus: professional.accountStatus || null,

      marketplaceStatus: professional.marketplaceStatus || null,
    };
  }

  /* ------------------------------- RANGE / OCCURRENCE ------------------------------- */

  static buildSequenceRangeView({
    startSequence,
    endSequence,
    occurrenceCount = null,
    startsAt = null,
    endsAt = null,
    effective = false,
  }) {
    const start = this.toPositiveSafeInteger(startSequence, null);

    const end = this.toPositiveSafeInteger(endSequence, null);

    const count = this.toPositiveSafeInteger(occurrenceCount, null);

    const rangeLabel =
      start && end ? (start === end ? `Work date ${start}` : `Work dates ${start}-${end}`) : null;

    return {
      startSequence: start,

      endSequence: end,

      occurrenceCount: count,

      rangeLabel,

      countLabel: count === null ? null : `${count} ${this.pluralize(count, "work date")}`,

      startsAt: startsAt || null,

      startsAtDisplay: this.formatDateTime(startsAt),

      endsAt: endsAt || null,

      endsAtDisplay: this.formatDateTime(endsAt),

      effective,
    };
  }

  static getOccurrenceContextForAssignment(assignment, occurrences = []) {
    const shiftId = this.toId(assignment?.shift);

    const slotNumber = this.toPositiveSafeInteger(assignment?.slotNumber, null);

    const startSequence = this.toPositiveSafeInteger(assignment?.startSequence, null);

    const plannedEndSequence = this.toPositiveSafeInteger(assignment?.plannedEndSequence, null);

    if (!shiftId || !slotNumber || !startSequence || !plannedEndSequence) {
      return [];
    }

    return (Array.isArray(occurrences) ? occurrences : [])
      .filter((occurrence) => {
        const occurrenceShiftId = this.toId(occurrence?.shift);

        const occurrenceSlotNumber = this.toPositiveSafeInteger(occurrence?.slotNumber, null);

        const sequenceNumber = this.toPositiveSafeInteger(occurrence?.sequenceNumber, null);

        return (
          occurrenceShiftId === shiftId &&
          occurrenceSlotNumber === slotNumber &&
          sequenceNumber !== null &&
          sequenceNumber >= startSequence &&
          sequenceNumber <= plannedEndSequence
        );
      })
      .sort((left, right) => {
        const leftSequence = this.toPositiveSafeInteger(left?.sequenceNumber, 0) || 0;

        const rightSequence = this.toPositiveSafeInteger(right?.sequenceNumber, 0) || 0;

        return leftSequence - rightSequence;
      });
  }

  static buildOccurrenceView(occurrence, assignmentId) {
    if (!occurrence) {
      return null;
    }

    const id = this.toId(occurrence);

    const slotNumber = this.toPositiveSafeInteger(occurrence.slotNumber, null);

    const sequenceNumber = this.toPositiveSafeInteger(occurrence.sequenceNumber, null);

    const currentAssignmentId = this.toId(occurrence.assignment);

    const ownedByAssignment = Boolean(
      assignmentId && currentAssignmentId && assignmentId === currentAssignmentId
    );

    const identityLabel =
      slotNumber && sequenceNumber
        ? `Position ${slotNumber} / Work date ${sequenceNumber}`
        : occurrence.referenceCode || "Occurrence";

    const startDisplay = this.formatDateTime(
      occurrence.startTime,
      occurrence.scheduleTimeZone || null
    );

    const endDisplay = this.formatDateTime(occurrence.endTime, occurrence.scheduleTimeZone || null);

    return {
      id,

      referenceCode: occurrence.referenceCode || null,

      shiftId: this.toId(occurrence.shift),

      slotNumber,

      sequenceNumber,

      identityLabel,

      occurrenceDate: occurrence.occurrenceDate || null,

      occurrenceDateDisplay: this.formatLocalDate(occurrence.occurrenceDate),

      scheduleTimeZone: occurrence.scheduleTimeZone || null,

      startTime: occurrence.startTime || null,

      endTime: occurrence.endTime || null,

      startTimeDisplay: startDisplay,

      endTimeDisplay: endDisplay,

      timeRangeDisplay:
        startDisplay !== "-" && endDisplay !== "-" ? `${startDisplay} - ${endDisplay}` : null,

      scheduledMinutes: this.toPositiveSafeInteger(occurrence.scheduledMinutes, null),

      assignmentStatus: occurrence.assignmentStatus || null,

      assignmentStatusLabel: this.formatStatusLabel(occurrence.assignmentStatus),

      assignmentStatusBadgeClass: this.getOccurrenceAssignmentBadgeClass(
        occurrence.assignmentStatus
      ),

      currentAssignmentId,

      assignedProfessionalId: this.toId(occurrence.assignedProfessional),

      ownedByAssignment,

      ownershipLabel: ownedByAssignment
        ? "Assigned to this professional"
        : occurrence.assignmentStatus === "replacement_required"
          ? "Replacement required"
          : currentAssignmentId
            ? "Reassigned to another assignment"
            : "Not currently assigned",

      ownershipBadgeClass: ownedByAssignment
        ? "badge-light-success"
        : occurrence.assignmentStatus === "replacement_required"
          ? "badge-light-warning"
          : "badge-light-secondary",

      replacementRequiredAt: occurrence.replacementRequiredAt || null,

      replacementRequiredAtDisplay: this.formatDateTime(occurrence.replacementRequiredAt),

      replacementForAssignmentId: this.toId(occurrence.replacementForAssignment),

      replacementCaseId: this.toId(occurrence.replacementCase),

      replacementReasonCode: occurrence.replacementReasonCode || null,

      replacementReasonLabel: this.formatStatusLabel(occurrence.replacementReasonCode),

      status: occurrence.status || null,

      statusLabel: this.formatStatusLabel(occurrence.status),

      statusBadgeClass: this.getGenericBadgeClass(occurrence.status),

      attendanceStatus: occurrence.attendanceStatus || null,

      attendanceStatusLabel: this.formatStatusLabel(occurrence.attendanceStatus),

      attendanceStatusBadgeClass: this.getGenericBadgeClass(occurrence.attendanceStatus),

      checkedInAt: occurrence.checkedInAt || null,

      checkedInAtDisplay: this.formatDateTime(
        occurrence.checkedInAt,
        occurrence.scheduleTimeZone || null
      ),

      checkedOutAt: occurrence.checkedOutAt || null,

      checkedOutAtDisplay: this.formatDateTime(
        occurrence.checkedOutAt,
        occurrence.scheduleTimeZone || null
      ),

      settlementStatus: occurrence.settlementStatus || null,

      settlementStatusLabel: this.formatStatusLabel(occurrence.settlementStatus),

      refundStatus: occurrence.refundStatus || null,

      refundStatusLabel: this.formatStatusLabel(occurrence.refundStatus),

      overtimeStatus: occurrence.overtime?.status || null,

      overtimeStatusLabel: this.formatStatusLabel(occurrence.overtime?.status),

      hasActiveClaim: Boolean(occurrence.activeClaim),

      hasActiveDispute: Boolean(occurrence.activeDispute),
    };
  }

  static buildOccurrenceContextView(assignment, occurrences = []) {
    const assignmentId = this.toId(assignment);

    const rawOccurrences = this.getOccurrenceContextForAssignment(assignment, occurrences);

    const items = rawOccurrences
      .map((occurrence) => this.buildOccurrenceView(occurrence, assignmentId))
      .filter(Boolean);

    const ownedCount = items.filter((item) => item.ownedByAssignment).length;

    const reassignedCount = items.filter(
      (item) => !item.ownedByAssignment && item.currentAssignmentId
    ).length;

    const replacementRequiredCount = items.filter(
      (item) => item.assignmentStatus === "replacement_required"
    ).length;

    return {
      visible: items.length > 0,

      items,

      totalCount: items.length,

      ownedCount,

      reassignedCount,

      replacementRequiredCount,

      summaryText:
        items.length > 0
          ? `${ownedCount} of ${items.length} planned ${this.pluralize(
              items.length,
              "occurrence"
            )} currently belong to this assignment.`
          : "No occurrence context is available for this assignment range.",
    };
  }

  /* ------------------------------- LINKED ASSIGNMENT ------------------------------- */

  static buildLinkedAssignmentView(assignment, relationshipLabel = null) {
    if (!assignment) {
      return null;
    }

    const slotNumber = this.toPositiveSafeInteger(assignment.slotNumber, null);

    const startSequence = this.toPositiveSafeInteger(assignment.startSequence, null);

    const plannedEndSequence = this.toPositiveSafeInteger(assignment.plannedEndSequence, null);

    return {
      id: this.toId(assignment),

      referenceCode: assignment.referenceCode || null,

      relationshipLabel,

      professional: this.buildProfessionalView(assignment.professional),

      slotNumber,

      positionLabel: slotNumber ? `Position ${slotNumber}` : null,

      assignmentType: assignment.assignmentType || null,

      assignmentTypeLabel: this.formatStatusLabel(assignment.assignmentType),

      status: assignment.status || null,

      statusLabel: this.formatStatusLabel(assignment.status),

      statusBadgeClass: this.getAssignmentStatusBadgeClass(assignment.status),

      rangeLabel:
        startSequence && plannedEndSequence
          ? startSequence === plannedEndSequence
            ? `Work date ${startSequence}`
            : `Work dates ${startSequence}-${plannedEndSequence}`
          : null,

      assignedAt: assignment.assignedAt || null,

      assignedAtDisplay: this.formatDateTime(assignment.assignedAt),

      activatedAt: assignment.activatedAt || null,

      activatedAtDisplay: this.formatDateTime(assignment.activatedAt),

      endedAt: assignment.endedAt || null,

      endedAtDisplay: this.formatDateTime(assignment.endedAt),

      cancelledAt: assignment.cancelledAt || null,

      cancelledAtDisplay: this.formatDateTime(assignment.cancelledAt),
    };
  }

  /* ------------------------------- ASSIGNMENT CASE ------------------------------- */

  static buildCaseRangeView(range) {
    if (!range || typeof range !== "object") {
      return null;
    }

    const lastWorkingSequenceNumber = this.toPositiveSafeInteger(
      range.lastWorkingSequenceNumber,
      null
    );

    const replacementStartSequenceNumber = this.toPositiveSafeInteger(
      range.replacementStartSequenceNumber,
      null
    );

    const replacementEndSequenceNumber = this.toPositiveSafeInteger(
      range.replacementEndSequenceNumber,
      null
    );

    const replacementOccurrenceCount = this.toPositiveSafeInteger(
      range.replacementOccurrenceCount,
      null
    );

    const hasRange = Boolean(
      lastWorkingSequenceNumber ||
      replacementStartSequenceNumber ||
      replacementEndSequenceNumber ||
      replacementOccurrenceCount
    );

    if (!hasRange) {
      return null;
    }

    return {
      lastWorkingSequenceNumber,

      lastWorkingLabel: lastWorkingSequenceNumber ? `Work date ${lastWorkingSequenceNumber}` : null,

      replacementStartSequenceNumber,

      replacementEndSequenceNumber,

      replacementOccurrenceCount,

      replacementRangeLabel:
        replacementStartSequenceNumber && replacementEndSequenceNumber
          ? replacementStartSequenceNumber === replacementEndSequenceNumber
            ? `Work date ${replacementStartSequenceNumber}`
            : `Work dates ${replacementStartSequenceNumber}-${replacementEndSequenceNumber}`
          : null,

      replacementCountLabel:
        replacementOccurrenceCount === null
          ? null
          : `${replacementOccurrenceCount} ${this.pluralize(
              replacementOccurrenceCount,
              "work date"
            )}`,
    };
  }

  static buildCaseView(caseRecord, relationship = null) {
    if (!caseRecord) {
      return {
        visible: false,

        details: [],
      };
    }

    const status = caseRecord.status || null;

    const caseType = caseRecord.caseType || null;

    const exitProposalRange = this.buildCaseRangeView(caseRecord.exitProposal?.range);

    const effectiveExitRange = this.buildCaseRangeView(caseRecord.resolution?.effectiveExitRange);

    const issueOccurrence = caseRecord.employerIssue?.occurrence || null;

    const requiresEmployerAttention = [
      "awaiting_employer_acknowledgment",
      "awaiting_employer_response",
    ].includes(status);

    const details = [
      caseRecord.referenceCode
        ? {
            key: "reference",

            label: "Case",

            value: caseRecord.referenceCode,
          }
        : null,

      caseType
        ? {
            key: "type",

            label: "Case type",

            value: this.formatStatusLabel(caseType),
          }
        : null,

      status
        ? {
            key: "status",

            label: "Case status",

            value: this.formatStatusLabel(status),
          }
        : null,

      caseRecord.exitProposal?.reason
        ? {
            key: "exitReason",

            label: "Exit reason",

            value: this.formatStatusLabel(caseRecord.exitProposal.reason),
          }
        : null,

      caseRecord.employerIssue?.issueType
        ? {
            key: "issueType",

            label: "Issue",

            value: this.formatStatusLabel(caseRecord.employerIssue.issueType),
          }
        : null,

      exitProposalRange?.replacementRangeLabel
        ? {
            key: "proposedReplacementRange",

            label: "Proposed replacement range",

            value: exitProposalRange.replacementRangeLabel,
          }
        : null,

      effectiveExitRange?.replacementRangeLabel
        ? {
            key: "effectiveReplacementRange",

            label: "Confirmed replacement range",

            value: effectiveExitRange.replacementRangeLabel,
          }
        : null,

      caseRecord.resolution?.outcome
        ? {
            key: "outcome",

            label: "Outcome",

            value: this.formatStatusLabel(caseRecord.resolution.outcome),
          }
        : null,
    ].filter(Boolean);

    return {
      visible: true,

      id: this.toId(caseRecord),

      referenceCode: caseRecord.referenceCode || null,

      relationship,

      relationshipLabel:
        relationship === "open"
          ? "Open case"
          : relationship === "end"
            ? "End case"
            : relationship === "replacement"
              ? "Replacement case"
              : "Assignment case",

      caseType,

      caseTypeLabel: this.formatStatusLabel(caseType),

      status,

      statusLabel: this.formatStatusLabel(status),

      statusBadgeClass: this.getCaseStatusBadgeClass(status),

      isOpen: caseRecord.isOpen === true,

      requiresEmployerAttention,

      attentionBadge: requiresEmployerAttention
        ? {
            label: "Employer action required",

            badgeClass: "badge-light-warning",
          }
        : null,

      initiatedByRole: caseRecord.initiatedBy?.role || null,

      initiatedByRoleLabel: this.formatStatusLabel(caseRecord.initiatedBy?.role),

      exitProposal: {
        visible: Boolean(
          caseRecord.exitProposal?.source ||
          caseRecord.exitProposal?.reason ||
          caseRecord.exitProposal?.details ||
          exitProposalRange
        ),

        source: caseRecord.exitProposal?.source || null,

        sourceLabel: this.formatStatusLabel(caseRecord.exitProposal?.source),

        reason: caseRecord.exitProposal?.reason || null,

        reasonLabel: this.formatStatusLabel(caseRecord.exitProposal?.reason),

        details: caseRecord.exitProposal?.details || null,

        range: exitProposalRange,

        proposedAt: caseRecord.exitProposal?.proposedAt || null,

        proposedAtDisplay: this.formatDateTime(caseRecord.exitProposal?.proposedAt),
      },

      employerIssue: {
        visible: Boolean(
          caseRecord.employerIssue?.issueType ||
          caseRecord.employerIssue?.details ||
          issueOccurrence
        ),

        issueType: caseRecord.employerIssue?.issueType || null,

        issueTypeLabel: this.formatStatusLabel(caseRecord.employerIssue?.issueType),

        details: caseRecord.employerIssue?.details || null,

        occurrenceId: this.toId(issueOccurrence),

        occurrenceReferenceCode: issueOccurrence?.referenceCode || null,

        occurrenceSequenceNumber:
          this.toPositiveSafeInteger(caseRecord.employerIssue?.occurrenceSequenceNumber, null) ||
          this.toPositiveSafeInteger(issueOccurrence?.sequenceNumber, null),

        occurrenceIdentityLabel:
          issueOccurrence?.slotNumber && issueOccurrence?.sequenceNumber
            ? `Position ${issueOccurrence.slotNumber} / Work date ${issueOccurrence.sequenceNumber}`
            : issueOccurrence?.referenceCode || null,

        occurredAt: caseRecord.employerIssue?.occurredAt || null,

        occurredAtDisplay: this.formatDateTime(caseRecord.employerIssue?.occurredAt),

        reportedAt: caseRecord.employerIssue?.reportedAt || null,

        reportedAtDisplay: this.formatDateTime(caseRecord.employerIssue?.reportedAt),
      },

      professionalResponse: {
        visible: Boolean(caseRecord.professionalResponse?.decision),

        decision: caseRecord.professionalResponse?.decision || null,

        decisionLabel: this.formatStatusLabel(caseRecord.professionalResponse?.decision),

        details: caseRecord.professionalResponse?.details || null,

        respondedAt: caseRecord.professionalResponse?.respondedAt || null,

        respondedAtDisplay: this.formatDateTime(caseRecord.professionalResponse?.respondedAt),
      },

      employerResponse: {
        visible: Boolean(caseRecord.employerResponse?.decision),

        decision: caseRecord.employerResponse?.decision || null,

        decisionLabel: this.formatStatusLabel(caseRecord.employerResponse?.decision),

        details: caseRecord.employerResponse?.details || null,

        respondedAt: caseRecord.employerResponse?.respondedAt || null,

        respondedAtDisplay: this.formatDateTime(caseRecord.employerResponse?.respondedAt),
      },

      replacement: {
        requested: Boolean(caseRecord.replacementRequestedAt),

        requestedAt: caseRecord.replacementRequestedAt || null,

        requestedAtDisplay: this.formatDateTime(caseRecord.replacementRequestedAt),
      },

      escalation: {
        escalated: Boolean(caseRecord.escalatedAt),

        escalatedAt: caseRecord.escalatedAt || null,

        escalatedAtDisplay: this.formatDateTime(caseRecord.escalatedAt),

        reason: caseRecord.escalationReason || null,
      },

      resolution: {
        visible: Boolean(caseRecord.resolution?.outcome),

        outcome: caseRecord.resolution?.outcome || null,

        outcomeLabel: this.formatStatusLabel(caseRecord.resolution?.outcome),

        reason: caseRecord.resolution?.reason || null,

        effectiveExitRange,

        resolvedAt: caseRecord.resolution?.resolvedAt || null,

        resolvedAtDisplay: this.formatDateTime(caseRecord.resolution?.resolvedAt),

        resolvedByRole: caseRecord.resolution?.resolvedByRole || null,

        resolvedByRoleLabel: this.formatStatusLabel(caseRecord.resolution?.resolvedByRole),
      },

      terminalAudit: {
        withdrawnAt: caseRecord.withdrawnAt || null,

        withdrawnAtDisplay: this.formatDateTime(caseRecord.withdrawnAt),

        withdrawalReason: caseRecord.withdrawalReason || null,

        dismissedAt: caseRecord.dismissedAt || null,

        dismissedAtDisplay: this.formatDateTime(caseRecord.dismissedAt),

        dismissalReason: caseRecord.dismissalReason || null,

        cancelledAt: caseRecord.cancelledAt || null,

        cancelledAtDisplay: this.formatDateTime(caseRecord.cancelledAt),

        cancellationReason: caseRecord.cancellationReason || null,
      },

      details,
    };
  }

  /* ------------------------------- APPLICATION ORIGIN ------------------------------- */

  static buildApplicationOriginView(application) {
    if (!application) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      id: this.toId(application),

      applicationType: application.applicationType || null,

      applicationTypeLabel: this.formatStatusLabel(application.applicationType),

      applicationRound: this.toPositiveSafeInteger(application.applicationRound, null),

      slotNumber: this.toPositiveSafeInteger(application.slotNumber, null),

      occurrenceId: this.toId(application.occurrence),

      replacementForAssignmentId: this.toId(application.replacementForAssignment),

      status: application.status || null,

      statusLabel: this.formatStatusLabel(application.status),

      statusBadgeClass: this.getGenericBadgeClass(application.status),

      acceptedAt: application.acceptedAt || null,

      acceptedAtDisplay: this.formatDateTime(application.acceptedAt),

      createdAt: application.createdAt || null,

      createdAtDisplay: this.formatDateTime(application.createdAt),
    };
  }

  /* ------------------------------- CASE ACTION FIELDS ------------------------------- */

  static buildEmployerIssueTypeOptions() {
    return (
      Array.isArray(EMPLOYER_ASSIGNMENT_ISSUE_TYPES) ? EMPLOYER_ASSIGNMENT_ISSUE_TYPES : []
    ).map((value) => ({
      value,

      label: this.formatStatusLabel(value),
    }));
  }

  static buildOccurrenceOptions(occurrenceContext) {
    return (Array.isArray(occurrenceContext?.items) ? occurrenceContext.items : [])
      .filter((occurrence) => occurrence.ownedByAssignment === true && occurrence.id)
      .map((occurrence) => ({
        value: occurrence.id,

        label:
          occurrence.occurrenceDateDisplay && occurrence.occurrenceDateDisplay !== "-"
            ? `${occurrence.identityLabel} · ${occurrence.occurrenceDateDisplay}`
            : occurrence.identityLabel,
      }));
  }

  static buildEmployerResponseDecisionOptions(openCase) {
    if (!openCase?.visible || !openCase.caseType) {
      return [];
    }

    const supportedDecisions = new Set(
      Array.isArray(EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS)
        ? EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS
        : []
    );

    const decisionValues = [];

    if (openCase.caseType === "professional_exit") {
      decisionValues.push("acknowledge_and_request_replacement");
    }

    if (openCase.caseType === "employer_issue") {
      if (openCase.professionalResponse?.decision === "continue_assignment") {
        decisionValues.push("accept_continuation");
      }

      if (openCase.professionalResponse?.decision === "confirm_exit") {
        decisionValues.push("acknowledge_and_request_replacement");
      }

      decisionValues.push("dismiss_issue");
    }

    return [...new Set(decisionValues)]
      .filter((value) => supportedDecisions.has(value))
      .map((value) => ({
        value,

        label: EMPLOYER_RESPONSE_PRESENTATION[value]?.label || this.formatStatusLabel(value),

        description: EMPLOYER_RESPONSE_PRESENTATION[value]?.description || null,
      }));
  }

  static buildReportIssueFields(occurrenceContext) {
    return [
      {
        key: "issueType",

        name: "issueType",

        label: "Issue type",

        type: "select",

        required: true,

        placeholder: "Select an issue type",

        options: this.buildEmployerIssueTypeOptions(),
      },

      {
        key: "occurrenceId",

        name: "occurrenceId",

        label: "Related work date",

        type: "select",

        required: false,

        placeholder: "Select a work date if applicable",

        helpText:
          "A work date is required when reporting a missed occurrence. Only occurrences currently owned by this assignment are listed.",

        options: this.buildOccurrenceOptions(occurrenceContext),
      },

      {
        key: "occurredAt",

        name: "occurredAt",

        label: "When did it happen?",

        type: "datetime-local",

        required: false,

        valueFormat: "iso_datetime",

        helpText: "Optional. Leave blank if the exact time is not known.",
      },

      {
        key: "details",

        name: "details",

        label: "Issue details",

        type: "textarea",

        rows: 4,

        required: true,

        maxLength: MAX_EMPLOYER_ISSUE_DETAILS_LENGTH,

        placeholder: "Describe the assignment issue",
      },
    ];
  }

  static buildRespondToCaseFields(openCase) {
    return [
      {
        key: "decision",

        name: "decision",

        label: "Employer decision",

        type: "select",

        required: true,

        placeholder: "Select your decision",

        options: this.buildEmployerResponseDecisionOptions(openCase),
      },

      {
        key: "details",

        name: "details",

        label: "Response details",

        type: "textarea",

        rows: 4,

        required: true,

        maxLength: MAX_EMPLOYER_RESPONSE_DETAILS_LENGTH,

        placeholder: "Explain your decision",
      },
    ];
  }

  static buildEscalateCaseFields() {
    return [
      {
        key: "reason",

        name: "reason",

        label: "Reason for escalation",

        type: "textarea",

        rows: 4,

        required: true,

        maxLength: MAX_ASSIGNMENT_CASE_ESCALATION_REASON_LENGTH,

        placeholder: "Explain why this case needs admin review",
      },
    ];
  }

  /* ------------------------------- CASE ACTION AVAILABILITY ------------------------------- */

  static canOpenEmployerIssue({ assignment, shift, canManageAssignments, currentTime }) {
    if (canManageAssignments !== true || !assignment || !shift) {
      return false;
    }

    if (!EMPLOYER_ISSUE_OPEN_ASSIGNMENT_STATUSES.includes(assignment.status)) {
      return false;
    }

    if (assignment.openCase || assignment.endCase) {
      return false;
    }

    if (EMPLOYER_ISSUE_BLOCKED_SHIFT_STATUSES.includes(shift.status)) {
      return false;
    }

    if (!assignment.assignedAt) {
      return false;
    }

    const assignedAt = new Date(assignment.assignedAt);

    if (Number.isNaN(assignedAt.getTime())) {
      return false;
    }

    return currentTime >= assignedAt;
  }

  static canRespondToOpenCase({ openCase, canManageAssignments }) {
    if (canManageAssignments !== true || !openCase?.visible || !openCase.id) {
      return false;
    }

    if (!EMPLOYER_RESPONDABLE_CASE_STATUSES.includes(openCase.status)) {
      return false;
    }

    return this.buildEmployerResponseDecisionOptions(openCase).length > 0;
  }

  static canEscalateOpenCase({ openCase, canManageAssignments }) {
    return Boolean(
      canManageAssignments === true &&
      openCase?.visible &&
      openCase.id &&
      EMPLOYER_ESCALATABLE_CASE_STATUSES.includes(openCase.status)
    );
  }

  /* ------------------------------- ASSIGNMENT ACTIONS ------------------------------- */

  static buildNavigationActions(assignment) {
    const shiftId = this.toId(assignment?.shift);

    return [
      shiftId
        ? {
            kind: "link",

            key: "viewShift",

            label: "View Shift",

            buttonClass: "btn-light-primary",

            icon: "ki-eye",

            url: `${EMPLOYER_SHIFTS_URL}/${shiftId}`,
          }
        : null,

      shiftId
        ? {
            kind: "link",

            key: "viewApplications",

            label: "Applications",

            buttonClass: "btn-light",

            icon: "ki-people",

            url: this.buildShiftScopedUrl(EMPLOYER_APPLICATIONS_URL, shiftId),
          }
        : null,

      shiftId
        ? {
            kind: "link",

            key: "viewAttendance",

            label: "Attendance",

            buttonClass: "btn-light",

            icon: "ki-calendar-tick",

            url: this.buildShiftScopedUrl(EMPLOYER_ATTENDANCE_URL, shiftId),
          }
        : null,
    ].filter(Boolean);
  }

  static buildManagementActions({
    assignment,
    shift,
    openCase,
    occurrenceContext,
    canManageAssignments,
    currentTime,
  }) {
    const assignmentId = this.toId(assignment);

    const caseId = openCase?.id || null;

    const professionalName = this.buildProfessionalName(assignment?.professional);

    const actions = [];

    if (
      assignmentId &&
      this.canOpenEmployerIssue({
        assignment,
        shift,
        canManageAssignments,
        currentTime,
      })
    ) {
      actions.push({
        kind: "modal",

        key: "reportIssue",

        label: "Report assignment issue",

        method: "POST",

        buttonClass: "btn-light-warning",

        icon: "ki-information",

        url: this.buildReportIssueUrl(assignmentId),

        modal: {
          title: "Report assignment issue",

          description: `Report a serious assignment problem involving ${professionalName}.`,

          confirmLabel: "Report issue",

          confirmButtonClass: "btn-warning",

          fields: this.buildReportIssueFields(occurrenceContext),

          notice: {
            noticeClass: "bg-light-info border-info",

            message:
              "Reporting an issue does not remove the professional from the assignment. The professional can respond before the case is resolved or escalated.",
          },
        },
      });
    }

    if (
      assignmentId &&
      caseId &&
      this.canRespondToOpenCase({
        openCase,
        canManageAssignments,
      })
    ) {
      const professionalExit = openCase.caseType === "professional_exit";

      const confirmedExit =
        openCase.caseType === "employer_issue" &&
        openCase.professionalResponse?.decision === "confirm_exit";

      actions.push({
        kind: "modal",

        key: "respondToCase",

        label: "Respond to case",

        method: "POST",

        buttonClass: "btn-primary",

        icon: "ki-message-text-2",

        url: this.buildRespondToCaseUrl(assignmentId, caseId),

        modal: {
          title: "Respond to assignment case",

          description: openCase.referenceCode
            ? `${openCase.referenceCode} · ${professionalName}`
            : professionalName,

          confirmLabel: "Submit response",

          confirmButtonClass: "btn-primary",

          fields: this.buildRespondToCaseFields(openCase),

          notice:
            professionalExit || confirmedExit
              ? {
                  noticeClass: "bg-light-warning border-warning",

                  message:
                    "Confirming an exit can release only the untouched future assignment tail for replacement handling. Worked attendance, settlement and payout records are not changed by this assignment-case action.",
                }
              : null,
        },
      });
    }

    if (
      assignmentId &&
      caseId &&
      this.canEscalateOpenCase({
        openCase,
        canManageAssignments,
      })
    ) {
      actions.push({
        kind: "modal",

        key: "escalateCase",

        label: "Escalate to admin",

        method: "POST",

        buttonClass: "btn-light-danger",

        icon: "ki-shield-tick",

        url: this.buildEscalateCaseUrl(assignmentId, caseId),

        modal: {
          title: "Escalate assignment case",

          description: openCase.referenceCode
            ? `${openCase.referenceCode} · ${professionalName}`
            : professionalName,

          confirmLabel: "Escalate to admin",

          confirmButtonClass: "btn-danger",

          fields: this.buildEscalateCaseFields(),

          notice: {
            noticeClass: "bg-light-warning border-warning",

            message:
              "Escalation sends the unresolved case to admin review. It does not itself end the assignment or open replacement hiring.",
          },
        },
      });
    }

    return actions;
  }

  static buildAssignmentActions({
    assignment,
    shift,
    openCase,
    occurrenceContext,
    canManageAssignments,
    currentTime,
  }) {
    const navigationItems = this.buildNavigationActions(assignment);

    const managementItems = this.buildManagementActions({
      assignment,
      shift,
      openCase,
      occurrenceContext,
      canManageAssignments,
      currentTime,
    });

    return {
      canManage: canManageAssignments === true,

      hasManagementActions: managementItems.length > 0,

      hasNavigationActions: navigationItems.length > 0,

      managementItems,

      navigationItems,

      items: [...managementItems, ...navigationItems],
    };
  }

  /* ------------------------------- ASSIGNMENT ------------------------------- */

  static buildAssignmentView(
    assignment,
    occurrences = [],
    canManageAssignments = false,
    currentTime = new Date()
  ) {
    if (!assignment) {
      return null;
    }

    const id = this.toId(assignment);

    const shift = this.buildShiftView(assignment.shift);

    const professional = this.buildProfessionalView(assignment.professional);

    const branch = this.buildBranchView(assignment.branch || assignment.shift?.branch);

    const slotNumber = this.toPositiveSafeInteger(assignment.slotNumber, null);

    const assignmentType = assignment.assignmentType || null;

    const status = assignment.status || null;

    const plannedRange = this.buildSequenceRangeView({
      startSequence: assignment.startSequence,

      endSequence: assignment.plannedEndSequence,

      occurrenceCount: assignment.plannedOccurrenceCount,

      startsAt: assignment.startsAt,

      endsAt: assignment.plannedEndsAt,
    });

    const effectiveRange =
      assignment.effectiveEndSequence ||
      assignment.effectiveOccurrenceCount ||
      assignment.effectiveEndsAt
        ? this.buildSequenceRangeView({
            startSequence: assignment.startSequence,

            endSequence: assignment.effectiveEndSequence,

            occurrenceCount: assignment.effectiveOccurrenceCount,

            startsAt: assignment.startsAt,

            endsAt: assignment.effectiveEndsAt,

            effective: true,
          })
        : null;

    const occurrenceContext = this.buildOccurrenceContextView(assignment, occurrences);

    const exactOccurrence = assignment.occurrence
      ? this.buildOccurrenceView(assignment.occurrence, id)
      : null;

    const openCase = this.buildCaseView(assignment.openCase, "open");

    const endCase = this.buildCaseView(assignment.endCase, "end");

    const replacementCase = this.buildCaseView(assignment.replacementCase, "replacement");

    const isOccurrenceSpecific = Boolean(assignment.occurrence);

    const isReplacement = assignmentType === "replacement";

    const isCurrent = assignment.isCurrentAssignment === true;

    const scopeTitle = isOccurrenceSpecific
      ? exactOccurrence?.identityLabel ||
        (slotNumber && plannedRange.startSequence
          ? `Position ${slotNumber} / Work date ${plannedRange.startSequence}`
          : "Single work-date replacement")
      : slotNumber
        ? `Position ${slotNumber}`
        : "Assignment";

    const scopeSubtitle = isOccurrenceSpecific
      ? "This replacement assignment applies to one exact professional-position/work-date occurrence."
      : plannedRange.rangeLabel
        ? `${scopeTitle} · ${plannedRange.rangeLabel}`
        : scopeTitle;

    const normalizedCurrentTime = this.normalizeCurrentTime(currentTime);

    const actions = this.buildAssignmentActions({
      assignment,

      shift: assignment.shift,

      openCase,

      occurrenceContext,

      canManageAssignments,

      currentTime: normalizedCurrentTime,
    });

    return {
      id,

      referenceCode: assignment.referenceCode || null,

      data: {
        assignmentId: id,

        shiftId: shift?.id || this.toId(assignment.shift),

        professionalId: professional?.id || this.toId(assignment.professional),

        slotNumber,

        status,

        assignmentType,

        occurrenceId: this.toId(assignment.occurrence),
      },

      shift,

      branch,

      professional,

      slotNumber,

      positionLabel: slotNumber ? `Position ${slotNumber}` : null,

      assignmentType,

      assignmentTypeLabel: this.formatStatusLabel(assignmentType),

      assignmentTypeBadgeClass: this.getAssignmentTypeBadgeClass(assignmentType),

      source: assignment.source || null,

      sourceLabel: this.formatStatusLabel(assignment.source),

      status,

      statusLabel: this.formatStatusLabel(status),

      statusBadgeClass: this.getAssignmentStatusBadgeClass(status),

      isCurrentAssignment: isCurrent,

      currentBadge: isCurrent
        ? {
            label: "Current assignment",

            badgeClass: "badge-light-success",
          }
        : null,

      isReplacement,

      isOccurrenceSpecific,

      replacementScope: isReplacement ? (isOccurrenceSpecific ? "isolated" : "tail") : null,

      replacementScopeLabel: isReplacement
        ? isOccurrenceSpecific
          ? "Single work-date replacement"
          : "Remaining-engagement replacement"
        : null,

      scopeTitle,

      scopeSubtitle,

      plannedRange,

      effectiveRange,

      occurrenceContext,

      exactOccurrence,

      applicationOrigin: this.buildApplicationOriginView(assignment.application),

      replacesAssignment: this.buildLinkedAssignmentView(assignment.replacesAssignment, "Replaces"),

      replacedByAssignment: this.buildLinkedAssignmentView(
        assignment.replacedByAssignment,
        "Replaced by"
      ),

      openCase,

      endCase,

      replacementCase,

      caseSummary: {
        hasOpenCase: openCase.visible,

        hasEndCase: endCase.visible,

        hasReplacementCase: replacementCase.visible,

        requiresEmployerAttention:
          openCase.requiresEmployerAttention === true ||
          endCase.requiresEmployerAttention === true ||
          replacementCase.requiresEmployerAttention === true,
      },

      endingAudit: {
        requestedAt: assignment.endingRequestedAt || null,

        requestedAtDisplay: this.formatDateTime(assignment.endingRequestedAt),

        confirmedAt: assignment.endingConfirmedAt || null,

        confirmedAtDisplay: this.formatDateTime(assignment.endingConfirmedAt),

        confirmedByRole: assignment.endingConfirmedByRole || null,

        confirmedByRoleLabel: this.formatStatusLabel(assignment.endingConfirmedByRole),
      },

      lifecycleAudit: {
        assignedAt: assignment.assignedAt || null,

        assignedAtDisplay: this.formatDateTime(assignment.assignedAt),

        activatedAt: assignment.activatedAt || null,

        activatedAtDisplay: this.formatDateTime(assignment.activatedAt),

        endedAt: assignment.endedAt || null,

        endedAtDisplay: this.formatDateTime(assignment.endedAt),

        endedByRole: assignment.endedByRole || null,

        endedByRoleLabel: this.formatStatusLabel(assignment.endedByRole),

        endReason: assignment.endReason || null,

        endReasonLabel: this.formatStatusLabel(assignment.endReason),

        endNotes: assignment.endNotes || null,

        cancelledAt: assignment.cancelledAt || null,

        cancelledAtDisplay: this.formatDateTime(assignment.cancelledAt),

        cancelledByRole: assignment.cancelledByRole || null,

        cancelledByRoleLabel: this.formatStatusLabel(assignment.cancelledByRole),

        cancellationReason: assignment.cancellationReason || null,
      },

      badges: [
        status
          ? {
              key: "status",

              label: this.formatStatusLabel(status),

              badgeClass: this.getAssignmentStatusBadgeClass(status),
            }
          : null,

        assignmentType
          ? {
              key: "type",

              label: this.formatStatusLabel(assignmentType),

              badgeClass: this.getAssignmentTypeBadgeClass(assignmentType),
            }
          : null,

        isCurrent
          ? {
              key: "current",

              label: "Current",

              badgeClass: "badge-light-success",
            }
          : null,

        isReplacement
          ? {
              key: "replacementScope",

              label: isOccurrenceSpecific ? "Exact work date" : "Remaining schedule",

              badgeClass: "badge-light-warning",
            }
          : null,

        openCase.visible
          ? {
              key: "openCase",

              label: openCase.requiresEmployerAttention ? "Case needs attention" : "Open case",

              badgeClass: openCase.requiresEmployerAttention
                ? "badge-light-warning"
                : "badge-light-info",
            }
          : null,
      ].filter(Boolean),

      overviewItems: [
        assignment.referenceCode
          ? {
              key: "reference",

              label: "Assignment",

              value: assignment.referenceCode,
            }
          : null,

        slotNumber
          ? {
              key: "position",

              label: "Position",

              value: `Position ${slotNumber}`,
            }
          : null,

        plannedRange.rangeLabel
          ? {
              key: "plannedCoverage",

              label: "Planned coverage",

              value: plannedRange.rangeLabel,
            }
          : null,

        effectiveRange?.rangeLabel
          ? {
              key: "effectiveCoverage",

              label: "Effective coverage",

              value: effectiveRange.rangeLabel,
            }
          : null,

        assignment.assignedAt
          ? {
              key: "assignedAt",

              label: "Assigned",

              value: this.formatDateTime(assignment.assignedAt),
            }
          : null,
      ].filter(Boolean),

      canManage: canManageAssignments === true,

      footerReference: id ? `Assignment ID: ${id}` : null,

      actions,
    };
  }

  /* ------------------------------- SUMMARY / FILTERS ------------------------------- */

  static buildSummaryCards(scopeCounts = {}) {
    return SUMMARY_CARD_DEFINITIONS.map((definition) => ({
      ...definition,

      value: this.toNonNegativeSafeInteger(scopeCounts?.[definition.key], 0),
    }));
  }

  static buildFilterOptions({ selectedStatus, selectedAssignmentType, shiftId }) {
    return [
      {
        key: "all",

        label: "All assignments",

        active: selectedStatus === "all" && selectedAssignmentType === "all",

        url: shiftId
          ? this.buildQueryUrl({
              shiftId,
            })
          : EMPLOYER_ASSIGNMENTS_URL,
      },

      ...ASSIGNMENT_STATUSES.map((status) => ({
        key: `status:${status}`,

        label: `${this.formatStatusLabel(status)} assignments`,

        active: selectedStatus === status && selectedAssignmentType === "all",

        url: this.buildQueryUrl({
          status,

          assignmentType: "all",

          shiftId,
        }),
      })),

      ...ASSIGNMENT_TYPES.map((assignmentType) => ({
        key: `type:${assignmentType}`,

        label: `${this.formatStatusLabel(assignmentType)} assignments`,

        active: selectedStatus === "all" && selectedAssignmentType === assignmentType,

        url: this.buildQueryUrl({
          status: "all",

          assignmentType,

          shiftId,
        }),
      })),
    ];
  }

  static buildFiltersView({ selectedStatus, selectedAssignmentType, shiftId }) {
    const hasActiveFilters = selectedStatus !== "all" || selectedAssignmentType !== "all";

    const clearUrl = shiftId
      ? this.buildQueryUrl({
          shiftId,
        })
      : EMPLOYER_ASSIGNMENTS_URL;

    let selectedLabel = "All assignments";

    if (selectedStatus !== "all" && selectedAssignmentType !== "all") {
      selectedLabel = `${this.formatStatusLabel(selectedStatus)} · ${this.formatStatusLabel(
        selectedAssignmentType
      )} assignments`;
    } else if (selectedStatus !== "all") {
      selectedLabel = `${this.formatStatusLabel(selectedStatus)} assignments`;
    } else if (selectedAssignmentType !== "all") {
      selectedLabel = `${this.formatStatusLabel(selectedAssignmentType)} assignments`;
    }

    return {
      selectedLabel,

      selectedStatus,

      selectedAssignmentType,

      options: this.buildFilterOptions({
        selectedStatus,

        selectedAssignmentType,

        shiftId,
      }),

      hasActiveFilters,

      clearAction: {
        visible: hasActiveFilters,

        label: PAGE_COPY.clearFiltersLabel,

        buttonClass: "btn-light-danger",

        url: clearUrl,
      },
    };
  }

  /* ------------------------------- PAGE SECTIONS ------------------------------- */

  static buildFocusedShiftSection(focusedShift) {
    const shift = this.buildShiftView(focusedShift);

    if (!shift) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      title: shift.heading,

      referenceCode: shift.referenceCode,

      badges: [
        shift.status
          ? {
              label: shift.statusLabel,

              badgeClass: shift.statusBadgeClass,
            }
          : null,

        shift.paymentStatus
          ? {
              label: shift.paymentStatusLabel,

              badgeClass: shift.paymentStatusBadgeClass,
            }
          : null,
      ].filter(Boolean),

      metaItems: [
        shift.branch?.name
          ? {
              key: "branch",

              label: "Branch",

              value: shift.branch.name,

              icon: "ki-geolocation",
            }
          : null,

        shift.dateRangeDisplay && shift.dateRangeDisplay !== "-"
          ? {
              key: "dates",

              label: "Dates",

              value: shift.dateRangeDisplay,

              icon: "ki-calendar",
            }
          : null,

        shift.staffingDisplay
          ? {
              key: "staffing",

              label: "Staffing",

              value: shift.staffingDisplay,

              icon: "ki-people",
            }
          : null,
      ].filter(Boolean),

      viewShiftAction: {
        visible: Boolean(shift.detailsUrl),

        label: "View Shift",

        buttonClass: "btn-light-primary",

        url: shift.detailsUrl,
      },

      showAllAction: {
        visible: true,

        label: "Show all assignments",

        buttonClass: "btn-light",

        url: EMPLOYER_ASSIGNMENTS_URL,
      },
    };
  }

  static buildReadOnlyNotice(canManageAssignments) {
    return {
      visible: canManageAssignments !== true,

      title: PAGE_COPY.readOnlyTitle,

      message: PAGE_COPY.readOnlyMessage,

      icon: "ki-lock",

      iconClass: "text-warning",

      noticeClass: "bg-light-warning border-warning",
    };
  }

  static buildPaginationView({ pagination, selectedStatus, selectedAssignmentType, shiftId }) {
    const currentPage = this.toPositiveSafeInteger(pagination?.currentPage, 1);

    const totalPages = this.toPositiveSafeInteger(pagination?.totalPages, 1);

    const totalItems = this.toNonNegativeSafeInteger(pagination?.totalItems, 0);

    const startItem = this.toNonNegativeSafeInteger(pagination?.startItem, 0);

    const endItem = this.toNonNegativeSafeInteger(pagination?.endItem, 0);

    const previousPage = currentPage > 1 ? currentPage - 1 : null;

    const nextPage = currentPage < totalPages ? currentPage + 1 : null;

    return {
      currentPage,

      totalPages,

      totalItems,

      perPage: this.toNonNegativeSafeInteger(pagination?.perPage, 0),

      startItem,

      endItem,

      hasPagination: totalPages > 1,

      resultsText:
        totalItems > 0
          ? `Showing ${startItem}-${endItem} of ${totalItems}`
          : "No assignments match the current filters.",

      pageText: `Page ${currentPage} of ${totalPages}`,

      previous: {
        label: "Previous",

        enabled: previousPage !== null,

        url:
          previousPage === null
            ? null
            : this.buildQueryUrl({
                status: selectedStatus,

                assignmentType: selectedAssignmentType,

                shiftId,

                page: previousPage,
              }),
      },

      next: {
        label: "Next",

        enabled: nextPage !== null,

        url:
          nextPage === null
            ? null
            : this.buildQueryUrl({
                status: selectedStatus,

                assignmentType: selectedAssignmentType,

                shiftId,

                page: nextPage,
              }),
      },
    };
  }

  static buildEmptyState({ focusedShift, selectedStatus, selectedAssignmentType, clearUrl }) {
    const hasFilters = selectedStatus !== "all" || selectedAssignmentType !== "all";

    let message = focusedShift
      ? "No assignments are available for this Shift yet."
      : "No Shift assignments are available yet.";

    if (hasFilters) {
      message = focusedShift
        ? "No assignments for this Shift match the current filters."
        : "No assignments match the current filters.";
    }

    return {
      visible: true,

      icon: "ki-people",

      title: PAGE_COPY.emptyTitle,

      message,

      action: {
        visible: hasFilters,

        label: PAGE_COPY.clearFiltersLabel,

        buttonClass: "btn-light-primary",

        url: clearUrl,
      },
    };
  }

  static buildResultsHeader(paginationView) {
    return {
      title: "Assignments",

      subtitle: paginationView.resultsText,
    };
  }

  static buildActionModal(assignmentViews, canManageAssignments) {
    const hasManagementActions = assignmentViews.some(
      (assignment) => assignment.actions?.hasManagementActions === true
    );

    return {
      ...ACTION_MODAL,

      enabled: canManageAssignments === true && hasManagementActions,
    };
  }

  /* ------------------------------- PAGE VIEW ------------------------------- */

  static buildEmployerAssignmentsPageView({
    employer,
    assignments = [],
    occurrences = [],
    focusedShift = null,
    selectedStatus = "all",
    selectedAssignmentType = "all",
    statusCounts = {},
    assignmentTypeCounts = {},
    scopeCounts = {},
    canManageAssignments = false,
    currentTime = new Date(),
    pagination = {},
  }) {
    const normalizedCurrentTime = this.normalizeCurrentTime(currentTime);

    const focusedShiftId = this.toId(focusedShift);

    const assignmentViews = (Array.isArray(assignments) ? assignments : [])
      .map((assignment) =>
        this.buildAssignmentView(
          assignment,
          occurrences,
          canManageAssignments,
          normalizedCurrentTime
        )
      )
      .filter(Boolean);

    const filters = this.buildFiltersView({
      statusCounts,

      assignmentTypeCounts,

      selectedStatus,

      selectedAssignmentType,

      shiftId: focusedShiftId,
    });

    const paginationView = this.buildPaginationView({
      pagination,

      selectedStatus,

      selectedAssignmentType,

      shiftId: focusedShiftId,
    });

    return {
      pageTitle: PAGE_COPY.title,

      employer: {
        id: employer?.id || null,

        businessName: employer?.businessName || "Employer",

        countryCode: employer?.countryCode || null,

        currency: employer?.currency || null,
      },

      permissions: {
        canManageAssignments: canManageAssignments === true,

        readOnly: canManageAssignments !== true,
      },

      currentTime: normalizedCurrentTime,

      currentTimeDisplay: this.formatDateTime(normalizedCurrentTime),

      summaryCards: this.buildSummaryCards(scopeCounts),

      filters,

      focusedShiftSection: this.buildFocusedShiftSection(focusedShift),

      readOnlyNotice: this.buildReadOnlyNotice(canManageAssignments),

      resultsHeader: this.buildResultsHeader(paginationView),

      assignments: assignmentViews,

      hasAssignments: assignmentViews.length > 0,

      pagination: paginationView,

      emptyState: this.buildEmptyState({
        focusedShift,

        selectedStatus,

        selectedAssignmentType,

        clearUrl: filters.clearAction.url,
      }),

      actionModal: this.buildActionModal(assignmentViews, canManageAssignments),
    };
  }
}

module.exports = ShiftAssignmentViewService;
