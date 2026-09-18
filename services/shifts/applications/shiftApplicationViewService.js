// services/shifts/applications/shiftApplicationViewService.js

const money = require("../../../utils/money");
const { badgeClass, formatStatus } = require("../../../utils/statusHelper");

const {
  APPLICATION_TYPES,
  APPLICATION_STATUSES,
  ACTIVE_APPLICATION_STATUSES,
} = require("../../../constants/shiftApplication");

const EMPLOYER_APPLICATIONS_URL = "/employer/shifts/applications";
const EMPLOYER_SHIFTS_URL = "/employer/shifts";

const DEFAULT_BADGE_CLASS = "badge-light-secondary";
const DEFAULT_CURRENCY = "NGN";

const APPLICATION_STATUS_BADGES = Object.freeze({
  pending: "badge-light-warning",
  shortlisted: "badge-light-primary",
  accepted: "badge-light-success",
  rejected: "badge-light-danger",
  withdrawn: "badge-light-secondary",
  expired: "badge-light-secondary",
  cancelled: "badge-light-secondary",
});

const APPLICATION_TYPE_BADGES = Object.freeze({
  initial: "badge-light-primary",
  replacement: "badge-light-warning",
});

const SUMMARY_CARD_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "active",
    label: "Active",
    icon: "ki-briefcase",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-primary",
    iconClass: "text-primary",
    valueClass: "text-primary",
  }),

  Object.freeze({
    key: "pending",
    label: "Pending",
    icon: "ki-time",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-warning",
    iconClass: "text-warning",
    valueClass: "text-warning",
  }),

  Object.freeze({
    key: "shortlisted",
    label: "Shortlisted",
    icon: "ki-user-tick",
    iconPaths: Object.freeze([1, 2, 3]),
    symbolClass: "bg-light-info",
    iconClass: "text-info",
    valueClass: "text-info",
  }),

  Object.freeze({
    key: "accepted",
    label: "Accepted",
    icon: "ki-check-circle",
    iconPaths: Object.freeze([1, 2]),
    symbolClass: "bg-light-success",
    iconClass: "text-success",
    valueClass: "text-success",
  }),
]);

const PAGE_COPY = Object.freeze({
  defaultTitle: "Shift Applications",

  applicationsHeading: "Applications",

  viewShiftLabel: "View Shift",

  showAllApplicationsLabel: "Show all applications",

  clearFiltersLabel: "Clear filters",

  readOnlyTitle: "Read-only access",

  readOnlyMessage:
    "You can view applications for your assigned branches, but you do not have permission to shortlist, accept or reject applicants.",

  noApplicationsTitle: "No applications found",
});

const ACTION_PRESENTATION = Object.freeze({
  shortlist: Object.freeze({
    key: "shortlist",

    label: "Shortlist",

    method: "POST",

    buttonClass: "btn-light-primary",

    icon: "ki-check-square",

    allowedStatuses: Object.freeze(["pending"]),

    modalTitle: "Shortlist professional",

    modalDescription: "Add this professional to your shortlist for this Shift application.",

    confirmLabel: "Shortlist",

    confirmButtonClass: "btn-primary",

    fields: Object.freeze(["employerPrivateNote"]),

    notice: null,
  }),

  reject: Object.freeze({
    key: "reject",

    label: "Reject",

    method: "POST",

    buttonClass: "btn-light-danger",

    icon: "ki-cross-circle",

    allowedStatuses: Object.freeze(["pending", "shortlisted"]),

    modalTitle: "Reject application",

    modalDescription: "Reject this professional's application for the selected Shift opportunity.",

    confirmLabel: "Reject application",

    confirmButtonClass: "btn-danger",

    fields: Object.freeze(["rejectedReason", "employerPrivateNote"]),

    notice: null,
  }),

  accept: Object.freeze({
    key: "accept",

    label: "Accept",

    method: "POST",

    buttonClass: "btn-primary",

    icon: "ki-check-circle",

    allowedStatuses: Object.freeze(["pending", "shortlisted"]),

    modalTitle: "Accept professional",

    modalDescription:
      "Accept this professional for the Shift. The backend will determine the authoritative staffing position and occurrence coverage.",

    confirmLabel: "Accept professional",

    confirmButtonClass: "btn-primary",

    fields: Object.freeze(["employerPrivateNote"]),

    notice: Object.freeze({
      tone: "warning",

      message:
        "Accepting an application creates or updates authoritative assignment coverage. Staffing position and occurrence coverage are determined by the backend.",
    }),
  }),
});

const ACTION_FIELD_PRESENTATION = Object.freeze({
  rejectedReason: Object.freeze({
    key: "rejectedReason",

    name: "rejectedReason",

    label: "Rejection reason",

    placeholder: "Optional reason for rejecting this application",

    type: "textarea",

    rows: 3,

    required: false,
  }),

  employerPrivateNote: Object.freeze({
    key: "employerPrivateNote",

    name: "employerPrivateNote",

    label: "Private employer note",

    helpText: "This note is for the employer's internal application review record.",

    placeholder: "Optional internal note",

    type: "textarea",

    rows: 4,

    required: false,
  }),
});

/**
 * APPLICATION VIEW AUTHORITY
 *
 * ShiftApplicationViewService owns presentation only.
 *
 * ShiftApplicationQueryService supplies authorized raw records, counts,
 * selected filters, pagination facts and canManageApplications.
 *
 * This service prepares all labels, display strings, badge classes, summary
 * cards, filter tabs, empty-state copy, replacement/assignment presentation,
 * action availability, action modal configuration and pagination presentation.
 *
 * Templates and browser JavaScript should render/submit this model rather than
 * recreating application lifecycle rules.
 *
 * Domain authority still remains in the command/query/domain services.
 */

class ShiftApplicationViewService {
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

  static normalizeCurrency(value) {
    const currency = String(value || DEFAULT_CURRENCY)
      .trim()
      .toUpperCase();

    return /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY;
  }

  static formatAmount(amount, currency = DEFAULT_CURRENCY) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return null;
    }

    return money.formatMoney(amount, this.normalizeCurrency(currency));
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

  static formatMinutesFromMidnight(value) {
    const minutes = Number(value);

    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
      return null;
    }

    const date = new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));

    return new Intl.DateTimeFormat("en-NG", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "UTC",
    }).format(date);
  }

  static formatStatusLabel(value) {
    return value ? formatStatus(String(value)) : null;
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

  static getGenericBadgeClass(status) {
    return status ? badgeClass?.[status] || DEFAULT_BADGE_CLASS : DEFAULT_BADGE_CLASS;
  }

  static getApplicationStatusBadgeClass(status) {
    return APPLICATION_STATUS_BADGES[status] || this.getGenericBadgeClass(status);
  }

  static buildQueryUrl({
    status = "all",
    applicationType = "all",
    shiftId = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (applicationType && applicationType !== "all") {
      params.set("type", applicationType);
    }

    if (shiftId) {
      params.set("shift", String(shiftId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${EMPLOYER_APPLICATIONS_URL}?${query}` : EMPLOYER_APPLICATIONS_URL;
  }

  /* ------------------------------- SHIFT ------------------------------- */

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

  static buildScheduleView(shift) {
    if (!shift) {
      return null;
    }

    const scheduleMode = String(shift.scheduleMode || "single")
      .trim()
      .toLowerCase();

    const timeZone = shift.scheduleTimeZone || null;

    const occurrenceCount = this.toPositiveSafeInteger(shift.occurrenceCount, 1) || 1;

    const requiredProfessionals = this.toPositiveSafeInteger(shift.requiredProfessionals, 1) || 1;

    const totalOccurrenceCount = this.toPositiveSafeInteger(
      shift.totalOccurrenceCount,
      occurrenceCount * requiredProfessionals
    );

    const firstDateDisplay = this.formatLocalDate(shift.firstOccurrenceDate);

    const lastDateDisplay = this.formatLocalDate(shift.lastOccurrenceDate);

    const dateRangeDisplay =
      shift.firstOccurrenceDate && shift.lastOccurrenceDate && firstDateDisplay !== lastDateDisplay
        ? `${firstDateDisplay} - ${lastDateDisplay}`
        : firstDateDisplay;

    const recurringStartDisplay = this.formatMinutesFromMidnight(shift.dailyStartTimeMinutes);

    const recurringEndDisplay = this.formatMinutesFromMidnight(shift.dailyEndTimeMinutes);

    const isSingle = scheduleMode === "single";

    const startTimeDisplay = isSingle
      ? this.formatDateTime(shift.startTime, timeZone)
      : recurringStartDisplay || "-";

    const endTimeDisplay = isSingle
      ? this.formatDateTime(shift.endTime, timeZone)
      : recurringEndDisplay || "-";

    const timeRangeDisplay =
      startTimeDisplay !== "-" && endTimeDisplay !== "-"
        ? `${startTimeDisplay} - ${endTimeDisplay}${
            !isSingle && shift.endsNextDay === true ? " (+1 day)" : ""
          }`
        : null;

    return {
      scheduleMode,

      scheduleModeLabel: this.formatStatusLabel(scheduleMode),

      occurrenceCount,

      requiredProfessionals,

      totalOccurrenceCount,

      occurrenceCountDisplay: `${occurrenceCount} ${this.pluralize(occurrenceCount, "work date")}`,

      staffingDisplay: `${requiredProfessionals} ${this.pluralize(
        requiredProfessionals,
        "professional"
      )} required`,

      occurrenceStructureDisplay: `${occurrenceCount} ${this.pluralize(
        occurrenceCount,
        "work date"
      )} × ${requiredProfessionals} ${this.pluralize(requiredProfessionals, "position")}`,

      timeZone,

      endsNextDay: shift.endsNextDay === true,

      firstOccurrenceDate: shift.firstOccurrenceDate || null,

      firstOccurrenceDateDisplay: firstDateDisplay,

      lastOccurrenceDate: shift.lastOccurrenceDate || null,

      lastOccurrenceDateDisplay: lastDateDisplay,

      dateRangeDisplay,

      startTime: shift.startTime || null,

      startTimeDisplay,

      endTime: shift.endTime || null,

      endTimeDisplay,

      timeRangeDisplay,
    };
  }

  static buildShiftView(shift) {
    if (!shift) {
      return null;
    }

    const id = this.toId(shift);

    const branch = this.buildBranchView(shift.branch);

    const schedule = this.buildScheduleView(shift);

    const statusLabel = this.formatStatusLabel(shift.status);

    const paymentStatusLabel = this.formatStatusLabel(shift.paymentStatus);

    return {
      id,

      referenceCode: shift.referenceCode || null,

      heading: shift.roleTitle || "Shift",

      roleTitle: shift.roleTitle || null,

      professionalType: shift.professionalType || null,

      professionalTypeLabel: this.formatStatusLabel(shift.professionalType),

      branch,

      schedule,

      status: shift.status || null,

      statusLabel,

      statusBadgeClass: this.getGenericBadgeClass(shift.status),

      paymentStatus: shift.paymentStatus || null,

      paymentStatusLabel,

      paymentStatusBadgeClass: this.getGenericBadgeClass(shift.paymentStatus),

      badges: [
        statusLabel
          ? {
              key: "status",

              label: statusLabel,

              badgeClass: this.getGenericBadgeClass(shift.status),
            }
          : null,

        paymentStatusLabel
          ? {
              key: "payment-status",

              label: paymentStatusLabel,

              badgeClass: this.getGenericBadgeClass(shift.paymentStatus),
            }
          : null,
      ].filter(Boolean),

      metaItems: [
        branch?.name
          ? {
              key: "branch",

              label: "Branch",

              value: branch.name,

              icon: "ki-geolocation",
            }
          : null,

        schedule?.dateRangeDisplay && schedule.dateRangeDisplay !== "-"
          ? {
              key: "dates",

              label: "Dates",

              value: schedule.dateRangeDisplay,

              icon: "ki-calendar",
            }
          : null,

        schedule?.staffingDisplay
          ? {
              key: "staffing",

              label: "Staffing",

              value: schedule.staffingDisplay,

              icon: "ki-people",
            }
          : null,
      ].filter(Boolean),

      applicationRound: this.toPositiveSafeInteger(shift.applicationRound, 1) || 1,

      totalApplications: this.toNonNegativeSafeInteger(shift.totalApplications, 0),

      currentRoundApplications: this.toNonNegativeSafeInteger(shift.currentRoundApplications, 0),

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

      createdAt: shift.createdAt || null,

      createdAtDisplay: this.formatDateTime(shift.createdAt),

      detailsUrl: id ? `${EMPLOYER_SHIFTS_URL}/${id}` : null,

      applicationsUrl: id
        ? this.buildQueryUrl({
            shiftId: id,
          })
        : EMPLOYER_APPLICATIONS_URL,
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

    const statusBadges = [
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
    ].filter(Boolean);

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

          value: reliability === null ? "-" : String(reliability),
        },

        {
          key: "completed-shifts",

          label: "Completed Shifts",

          value: completed === null ? "-" : String(completed),
        },
      ],

      statusBadges,

      licenceExpiryDate: professional.licenceExpiryDate || null,

      licenceExpiryDateDisplay: this.formatDate(professional.licenceExpiryDate),

      availabilityStatus: professional.availabilityStatus || null,

      availabilityStatusLabel: this.formatStatusLabel(professional.availabilityStatus),

      accountStatus: professional.accountStatus || null,

      accountStatusLabel: this.formatStatusLabel(professional.accountStatus),

      marketplaceStatus: professional.marketplaceStatus || null,

      marketplaceStatusLabel: this.formatStatusLabel(professional.marketplaceStatus),
    };
  }

  /* ------------------------------- MATCH SNAPSHOT ------------------------------- */

  static buildMatchSnapshotView(matchSnapshot, currency) {
    const snapshot = matchSnapshot && typeof matchSnapshot === "object" ? matchSnapshot : {};

    const years = this.toFiniteNumber(snapshot.yearsOfExperience, null);

    const distance = this.toFiniteNumber(snapshot.distanceKm, null);

    const rating = this.toFiniteNumber(snapshot.rating, null);

    const completed = this.toFiniteNumber(snapshot.completedShifts, null);

    const preferredRate = Number.isSafeInteger(snapshot.preferredRate)
      ? snapshot.preferredRate
      : null;

    const fields = [
      snapshot.professionalType
        ? {
            key: "professional-type",

            label: "Professional type",

            value: this.formatStatusLabel(snapshot.professionalType),
          }
        : null,

      snapshot.specialty
        ? {
            key: "specialty",

            label: "Specialty",

            value: snapshot.specialty,
          }
        : null,

      years !== null
        ? {
            key: "experience",

            label: "Experience",

            value: `${years} ${this.pluralize(years, "year")}`,
          }
        : null,

      preferredRate !== null
        ? {
            key: "preferred-rate",

            label: "Preferred rate",

            value: this.formatAmount(preferredRate, currency),
          }
        : null,

      distance !== null
        ? {
            key: "distance",

            label: "Distance",

            value: `${distance} km`,
          }
        : null,

      rating !== null
        ? {
            key: "rating",

            label: "Rating",

            value: String(rating),
          }
        : null,

      completed !== null
        ? {
            key: "completed-shifts",

            label: "Completed Shifts",

            value: String(completed),
          }
        : null,
    ].filter((item) => item && item.value !== null);

    return {
      visible: fields.length > 0,

      captured: fields.length > 0,

      title: "Application-time match snapshot",

      description: "Historical values captured when this professional applied.",

      badge: {
        label: "Historical",

        badgeClass: "badge-light-secondary",
      },

      fields,
    };
  }

  /* ------------------------------- OCCURRENCE / ASSIGNMENT ------------------------------- */

  static buildOccurrenceView(occurrence) {
    if (!occurrence) {
      return null;
    }

    const slotNumber = this.toPositiveSafeInteger(occurrence.slotNumber, null);

    const sequenceNumber = this.toPositiveSafeInteger(occurrence.sequenceNumber, null);

    const identityLabel =
      slotNumber && sequenceNumber
        ? `Position ${slotNumber} / Work date ${sequenceNumber}`
        : occurrence.referenceCode || "Occurrence";

    const dateDisplay = this.formatLocalDate(occurrence.occurrenceDate);

    const startDisplay = this.formatDateTime(
      occurrence.startTime,
      occurrence.scheduleTimeZone || null
    );

    const endDisplay = this.formatDateTime(occurrence.endTime, occurrence.scheduleTimeZone || null);

    return {
      id: this.toId(occurrence),

      referenceCode: occurrence.referenceCode || null,

      slotNumber,

      sequenceNumber,

      identityLabel,

      occurrenceDate: occurrence.occurrenceDate || null,

      occurrenceDateDisplay: dateDisplay,

      startTime: occurrence.startTime || null,

      startTimeDisplay: startDisplay,

      endTime: occurrence.endTime || null,

      endTimeDisplay: endDisplay,

      status: occurrence.status || null,

      statusLabel: this.formatStatusLabel(occurrence.status),

      assignmentStatus: occurrence.assignmentStatus || null,

      assignmentStatusLabel: this.formatStatusLabel(occurrence.assignmentStatus),

      attendanceStatus: occurrence.attendanceStatus || null,

      attendanceStatusLabel: this.formatStatusLabel(occurrence.attendanceStatus),

      details: [
        {
          key: "occurrence",

          label: "Occurrence",

          value: identityLabel,
        },

        dateDisplay !== "-"
          ? {
              key: "date",

              label: "Work date",

              value: dateDisplay,
            }
          : null,

        startDisplay !== "-" && endDisplay !== "-"
          ? {
              key: "time",

              label: "Time",

              value: `${startDisplay} - ${endDisplay}`,
            }
          : null,
      ].filter(Boolean),
    };
  }

  static buildAssignmentView(assignment) {
    if (!assignment) {
      return null;
    }

    const slotNumber = this.toPositiveSafeInteger(assignment.slotNumber, null);

    const startSequence = this.toPositiveSafeInteger(assignment.startSequence, null);

    const plannedEndSequence = this.toPositiveSafeInteger(assignment.plannedEndSequence, null);

    const effectiveEndSequence = this.toPositiveSafeInteger(assignment.effectiveEndSequence, null);

    const plannedRangeLabel =
      startSequence && plannedEndSequence
        ? startSequence === plannedEndSequence
          ? `Work date ${startSequence}`
          : `Work dates ${startSequence}-${plannedEndSequence}`
        : null;

    const effectiveRangeLabel =
      startSequence && effectiveEndSequence
        ? startSequence === effectiveEndSequence
          ? `Work date ${startSequence}`
          : `Work dates ${startSequence}-${effectiveEndSequence}`
        : null;

    const assignmentTypeLabel = this.formatStatusLabel(assignment.assignmentType);

    const statusLabel = this.formatStatusLabel(assignment.status);

    return {
      id: this.toId(assignment),

      referenceCode: assignment.referenceCode || null,

      shiftId: this.toId(assignment.shift),

      professionalId: this.toId(assignment.professional),

      slotNumber,

      positionLabel: slotNumber ? `Position ${slotNumber}` : null,

      assignmentType: assignment.assignmentType || null,

      assignmentTypeLabel,

      source: assignment.source || null,

      sourceLabel: this.formatStatusLabel(assignment.source),

      applicationId: this.toId(assignment.application),

      occurrenceId: this.toId(assignment.occurrence),

      replacesAssignmentId: this.toId(assignment.replacesAssignment),

      replacementCaseId: this.toId(assignment.replacementCase),

      startSequence,

      plannedEndSequence,

      plannedOccurrenceCount: this.toPositiveSafeInteger(assignment.plannedOccurrenceCount, null),

      effectiveEndSequence,

      effectiveOccurrenceCount: this.toPositiveSafeInteger(
        assignment.effectiveOccurrenceCount,
        null
      ),

      plannedRangeLabel,

      effectiveRangeLabel,

      status: assignment.status || null,

      statusLabel,

      statusBadgeClass: this.getGenericBadgeClass(assignment.status),

      assignedAt: assignment.assignedAt || null,

      assignedAtDisplay: this.formatDateTime(assignment.assignedAt),

      activatedAt: assignment.activatedAt || null,

      activatedAtDisplay: this.formatDateTime(assignment.activatedAt),

      endedAt: assignment.endedAt || null,

      endedAtDisplay: this.formatDateTime(assignment.endedAt),

      cancelledAt: assignment.cancelledAt || null,

      cancelledAtDisplay: this.formatDateTime(assignment.cancelledAt),

      details: [
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

        assignmentTypeLabel
          ? {
              key: "type",

              label: "Type",

              value: assignmentTypeLabel,
            }
          : null,

        plannedRangeLabel
          ? {
              key: "coverage",

              label: "Coverage",

              value: plannedRangeLabel,
            }
          : null,

        statusLabel
          ? {
              key: "status",

              label: "Status",

              value: statusLabel,
            }
          : null,
      ].filter(Boolean),
    };
  }

  /* ------------------------------- REPLACEMENT / ACCEPTED ------------------------------- */

  static buildReplacementView(application, occurrence, priorAssignment) {
    const applicationType = String(application?.applicationType || "initial")
      .trim()
      .toLowerCase();

    if (applicationType !== "replacement") {
      return {
        visible: false,

        isReplacement: false,

        details: [],
      };
    }

    const slotNumber = this.toPositiveSafeInteger(application.slotNumber, null);

    const positionLabel = slotNumber ? `Position ${slotNumber}` : null;

    const exactOccurrence = Boolean(occurrence);

    const details = exactOccurrence
      ? [...occurrence.details]
      : [
          positionLabel
            ? {
                key: "position",

                label: "Position",

                value: positionLabel,
              }
            : null,

          priorAssignment?.plannedRangeLabel
            ? {
                key: "coverage",

                label: "Coverage",

                value: priorAssignment.plannedRangeLabel,
              }
            : null,

          priorAssignment?.referenceCode
            ? {
                key: "prior-assignment",

                label: "Prior assignment",

                value: priorAssignment.referenceCode,
              }
            : null,
        ].filter(Boolean);

    return {
      visible: true,

      isReplacement: true,

      scope: exactOccurrence ? "exact_occurrence" : "remaining_schedule",

      title: positionLabel
        ? `Replacement application · ${positionLabel}`
        : "Replacement application",

      subtitle: exactOccurrence ? "Exact occurrence replacement" : "Remaining schedule replacement",

      slotNumber,

      positionLabel,

      occurrenceId: occurrence?.id || null,

      exactOccurrence: occurrence || null,

      priorAssignment: priorAssignment || null,

      details,

      noticeClass: "bg-light-warning border-warning",

      icon: "ki-arrows-circle",

      iconClass: "text-warning",
    };
  }

  static buildAcceptedView(status, slotNumber, assignment) {
    if (status !== "accepted" || !assignment) {
      return {
        visible: false,

        assignment: assignment || null,

        details: [],
      };
    }

    const authoritativeSlot = assignment.slotNumber || slotNumber || null;

    return {
      visible: true,

      title: authoritativeSlot ? `Accepted · Position ${authoritativeSlot}` : "Accepted",

      subtitle: "Authoritative accepted assignment",

      assignment,

      details: [...assignment.details],

      noticeClass: "bg-light-success border-success",

      icon: "ki-check-circle",

      iconClass: "text-success",
    };
  }

  /* ------------------------------- ACTIONS ------------------------------- */

  static isActiveApplicationStatus(status) {
    return ACTIVE_APPLICATION_STATUSES.includes(
      String(status || "")
        .trim()
        .toLowerCase()
    );
  }

  static buildActionField(fieldKey, application) {
    const definition = ACTION_FIELD_PRESENTATION[fieldKey];

    if (!definition) {
      return null;
    }

    return {
      ...definition,

      value:
        fieldKey === "rejectedReason"
          ? application?.rejectedReason || ""
          : application?.employerPrivateNote || "",
    };
  }

  static buildActionView(definition, applicationId, application) {
    return {
      key: definition.key,

      label: definition.label,

      method: definition.method,

      buttonClass: definition.buttonClass,

      icon: definition.icon,

      url: `${EMPLOYER_APPLICATIONS_URL}/${applicationId}/${definition.key}`,

      modal: {
        title: definition.modalTitle,

        description: definition.modalDescription,

        confirmLabel: definition.confirmLabel,

        confirmButtonClass: definition.confirmButtonClass,

        notice: definition.notice
          ? {
              ...definition.notice,
            }
          : null,

        fields: definition.fields
          .map((fieldKey) => this.buildActionField(fieldKey, application))
          .filter(Boolean),
      },
    };
  }

  static buildApplicationActions(application, canManageApplications) {
    const id = this.toId(application);

    const status = String(application?.status || "")
      .trim()
      .toLowerCase();

    const reviewable = this.isActiveApplicationStatus(status);

    if (!id || canManageApplications !== true || !reviewable) {
      return {
        reviewable,

        canManage: false,

        readOnly: canManageApplications !== true,

        hasActions: false,

        items: [],
      };
    }

    const items = Object.values(ACTION_PRESENTATION)
      .filter((definition) => definition.allowedStatuses.includes(status))
      .map((definition) => this.buildActionView(definition, id, application));

    return {
      reviewable,

      canManage: true,

      readOnly: false,

      hasActions: items.length > 0,

      items,
    };
  }

  /* ------------------------------- APPLICATION ------------------------------- */

  static buildReviewDetails(application) {
    const reviewedAtDisplay = this.formatDateTime(application?.reviewedAt);

    const items = [
      application?.employerPrivateNote
        ? {
            key: "private-note",

            label: "Employer private note",

            value: application.employerPrivateNote,
          }
        : null,

      application?.rejectedReason
        ? {
            key: "rejection-reason",

            label: "Rejection reason",

            value: application.rejectedReason,
          }
        : null,

      application?.reviewedAt && reviewedAtDisplay !== "-"
        ? {
            key: "reviewed-at",

            label: "Last reviewed",

            value: reviewedAtDisplay,
          }
        : null,
    ].filter(Boolean);

    return {
      visible: items.length > 0,

      title: "Employer review",

      items,
    };
  }

  static buildApplicationView({ application, currency, canManageApplications }) {
    const id = this.toId(application);

    const status = String(application?.status || "pending")
      .trim()
      .toLowerCase();

    const applicationType = String(application?.applicationType || "initial")
      .trim()
      .toLowerCase();

    const shift = this.buildShiftView(application?.shift);

    const professional = this.buildProfessionalView(application?.professional);

    const matchSnapshot = this.buildMatchSnapshotView(application?.matchSnapshot, currency);

    const occurrence = this.buildOccurrenceView(application?.occurrence);

    const priorAssignment = this.buildAssignmentView(application?.replacementForAssignment);

    const acceptedAssignment = this.buildAssignmentView(application?.acceptedAssignment);

    const slotNumber = this.toPositiveSafeInteger(application?.slotNumber, null);

    const statusLabel = this.formatStatusLabel(status);

    const applicationTypeLabel = this.formatStatusLabel(applicationType);

    const createdAtDisplay = this.formatDateTime(application?.createdAt);

    return {
      id,

      data: {
        applicationId: id,

        status,
      },

      status,

      statusLabel,

      applicationType,

      applicationTypeLabel,

      applicationRound: this.toPositiveSafeInteger(application?.applicationRound, 1) || 1,

      badges: [
        {
          key: "status",

          label: statusLabel || status,

          badgeClass: this.getApplicationStatusBadgeClass(status),
        },

        {
          key: "application-type",

          label: applicationTypeLabel || applicationType,

          badgeClass: APPLICATION_TYPE_BADGES[applicationType] || DEFAULT_BADGE_CLASS,
        },

        {
          key: "round",

          label: `Round ${this.toPositiveSafeInteger(application?.applicationRound, 1) || 1}`,

          badgeClass: "badge-light",
        },
      ],

      shift,

      professional,

      professionalMeta: [
        professional?.professionalTypeLabel
          ? {
              key: "professional-type",

              value: professional.professionalTypeLabel,
            }
          : null,

        professional?.specialty
          ? {
              key: "specialty",

              value: professional.specialty,
            }
          : null,

        createdAtDisplay !== "-"
          ? {
              key: "applied-at",

              value: `Applied ${createdAtDisplay}`,
            }
          : null,
      ].filter(Boolean),

      matchSnapshot,

      slotNumber,

      positionLabel: slotNumber ? `Position ${slotNumber}` : null,

      occurrence,

      priorAssignment,

      acceptedAssignment,

      replacement: this.buildReplacementView(application, occurrence, priorAssignment),

      accepted: this.buildAcceptedView(status, slotNumber, acceptedAssignment),

      professionalNote: {
        visible: Boolean(application?.note),

        title: "Professional's note",

        value: application?.note || null,
      },

      reviewDetails: this.buildReviewDetails(application),

      createdAt: application?.createdAt || null,

      createdAtDisplay,

      updatedAt: application?.updatedAt || null,

      updatedAtDisplay: this.formatDateTime(application?.updatedAt),

      reviewedAt: application?.reviewedAt || null,

      reviewedAtDisplay: this.formatDateTime(application?.reviewedAt),

      shortlistedAt: application?.shortlistedAt || null,

      shortlistedAtDisplay: this.formatDateTime(application?.shortlistedAt),

      acceptedAt: application?.acceptedAt || null,

      acceptedAtDisplay: this.formatDateTime(application?.acceptedAt),

      rejectedAt: application?.rejectedAt || null,

      rejectedAtDisplay: this.formatDateTime(application?.rejectedAt),

      withdrawnAt: application?.withdrawnAt || null,

      withdrawnAtDisplay: this.formatDateTime(application?.withdrawnAt),

      expiredAt: application?.expiredAt || null,

      expiredAtDisplay: this.formatDateTime(application?.expiredAt),

      cancelledAt: application?.cancelledAt || null,

      cancelledAtDisplay: this.formatDateTime(application?.cancelledAt),

      footerReference: id ? `Application ID: ${id}` : null,

      actions: this.buildApplicationActions(application, canManageApplications),
    };
  }

  /* ------------------------------- SUMMARY / FILTERS ------------------------------- */

  static buildSummaryCards(statusCounts = {}) {
    const activeCount = ACTIVE_APPLICATION_STATUSES.reduce(
      (sum, status) => sum + Number(statusCounts?.[status] || 0),
      0
    );

    const values = {
      active: activeCount,

      pending: Number(statusCounts?.pending || 0),

      shortlisted: Number(statusCounts?.shortlisted || 0),

      accepted: Number(statusCounts?.accepted || 0),
    };

    return SUMMARY_CARD_DEFINITIONS.map((definition) => ({
      ...definition,

      value: Number(values[definition.key] || 0),
    }));
  }

  static buildFilterOptions({ selectedStatus, selectedApplicationType, shiftId }) {
    return [
      {
        key: "all",

        label: "All applications",

        active: selectedStatus === "all" && selectedApplicationType === "all",

        url: shiftId
          ? this.buildQueryUrl({
              shiftId,
            })
          : EMPLOYER_APPLICATIONS_URL,
      },

      ...APPLICATION_STATUSES.map((status) => ({
        key: `status:${status}`,

        label: `${this.formatStatusLabel(status)} applications`,

        active: selectedStatus === status && selectedApplicationType === "all",

        url: this.buildQueryUrl({
          status,

          applicationType: "all",

          shiftId,
        }),
      })),

      ...APPLICATION_TYPES.map((applicationType) => ({
        key: `type:${applicationType}`,

        label: `${this.formatStatusLabel(applicationType)} applications`,

        active: selectedStatus === "all" && selectedApplicationType === applicationType,

        url: this.buildQueryUrl({
          status: "all",

          applicationType,

          shiftId,
        }),
      })),
    ];
  }

  static buildFiltersView({ selectedStatus, selectedApplicationType, shiftId }) {
    const hasActiveFilters = selectedStatus !== "all" || selectedApplicationType !== "all";

    const clearUrl = shiftId
      ? this.buildQueryUrl({
          shiftId,
        })
      : EMPLOYER_APPLICATIONS_URL;

    let selectedLabel = "All applications";

    if (selectedStatus !== "all" && selectedApplicationType !== "all") {
      selectedLabel = `${this.formatStatusLabel(selectedStatus)} · ${this.formatStatusLabel(
        selectedApplicationType
      )} applications`;
    } else if (selectedStatus !== "all") {
      selectedLabel = `${this.formatStatusLabel(selectedStatus)} applications`;
    } else if (selectedApplicationType !== "all") {
      selectedLabel = `${this.formatStatusLabel(selectedApplicationType)} applications`;
    }

    return {
      selectedLabel,

      selectedStatus,

      selectedApplicationType,

      options: this.buildFilterOptions({
        selectedStatus,

        selectedApplicationType,

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

  /* ------------------------------- PAGINATION / EMPTY STATE ------------------------------- */

  static buildPaginationView({ pagination, selectedStatus, selectedApplicationType, shiftId }) {
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
          : "No applications match the current filters.",

      pageText: `Page ${currentPage} of ${totalPages}`,

      previous: {
        label: "Previous",

        enabled: previousPage !== null,

        url:
          previousPage === null
            ? null
            : this.buildQueryUrl({
                status: selectedStatus,

                applicationType: selectedApplicationType,

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

                applicationType: selectedApplicationType,

                shiftId,

                page: nextPage,
              }),
      },
    };
  }

  static buildEmptyState({ focusedShift, selectedStatus, selectedApplicationType, clearUrl }) {
    const hasFilters = selectedStatus !== "all" || selectedApplicationType !== "all";

    let message = "No Shift applications are available yet.";

    if (hasFilters) {
      message = "No applications match the filters you selected.";
    } else if (focusedShift) {
      message = "No professionals have applied for this Shift yet.";
    }

    return {
      icon: "ki-profile-user",

      title: PAGE_COPY.noApplicationsTitle,

      message,

      action: {
        visible: hasFilters,

        label: hasFilters ? PAGE_COPY.clearFiltersLabel : null,

        buttonClass: hasFilters ? "btn-light-primary" : null,

        url: hasFilters ? clearUrl : null,
      },
    };
  }

  /* ------------------------------- PAGE ------------------------------- */

  static buildFocusedShiftSection(shift) {
    if (!shift) {
      return {
        visible: false,
      };
    }

    return {
      visible: true,

      title: shift.heading,

      referenceCode: shift.referenceCode,

      badges: shift.badges,

      metaItems: shift.metaItems,

      viewShiftAction: {
        visible: Boolean(shift.detailsUrl),

        label: PAGE_COPY.viewShiftLabel,

        buttonClass: "btn-light-primary",

        url: shift.detailsUrl,
      },

      showAllAction: {
        visible: true,

        label: PAGE_COPY.showAllApplicationsLabel,

        buttonClass: "btn-light",

        url: EMPLOYER_APPLICATIONS_URL,
      },
    };
  }

  static buildActionModalView(canManageApplications) {
    return {
      enabled: canManageApplications === true,

      id: "shiftApplicationActionModal",

      formId: "shiftApplicationActionForm",

      alertId: "shiftApplicationActionAlert",

      titleId: "shiftApplicationActionModalLabel",

      contextId: "shiftApplicationActionContext",

      actionTypeInputId: "shiftApplicationActionType",

      actionUrlInputId: "shiftApplicationActionUrl",

      fieldsContainerId: "shiftApplicationActionFields",

      noticeId: "shiftApplicationActionNotice",

      submitButtonId: "shiftApplicationActionSubmit",

      cancelLabel: "Cancel",

      defaultTitle: "Review application",

      defaultSubmitLabel: "Continue",

      loadingLabel: "Please wait...",
    };
  }

  static buildEmployerApplicationsPageView({
    employer,

    applications = [],

    focusedShift = null,

    selectedStatus = "all",

    selectedApplicationType = "all",

    statusCounts = {},

    applicationTypeCounts = {},

    canManageApplications = false,

    currentTime = new Date(),

    pagination = {},
  }) {
    const currency = this.normalizeCurrency(employer?.currency);

    const focusedShiftView = this.buildShiftView(focusedShift);

    const focusedShiftId = focusedShiftView?.id || null;

    const applicationViews = (Array.isArray(applications) ? applications : []).map((application) =>
      this.buildApplicationView({
        application,

        currency,

        canManageApplications,
      })
    );

    const filters = this.buildFiltersView({
      statusCounts,

      applicationTypeCounts,

      selectedStatus,

      selectedApplicationType,

      shiftId: focusedShiftId,
    });

    const paginationView = this.buildPaginationView({
      pagination,

      selectedStatus,

      selectedApplicationType,

      shiftId: focusedShiftId,
    });

    const summaryCards = this.buildSummaryCards(statusCounts);

    const activeApplicationCount = ACTIVE_APPLICATION_STATUSES.reduce(
      (sum, status) => sum + Number(statusCounts?.[status] || 0),
      0
    );

    const pageTitle = focusedShiftView
      ? `${focusedShiftView.referenceCode || "Shift"} Applications`
      : PAGE_COPY.defaultTitle;

    return {
      pageTitle,

      employer: {
        id: employer?.id ? String(employer.id) : null,

        businessName: employer?.businessName || "Employer",

        countryCode: employer?.countryCode || null,

        currency,
      },

      currentTime: this.normalizeCurrentTime(currentTime),

      focusedShift: focusedShiftView,

      focusedShiftSection: this.buildFocusedShiftSection(focusedShiftView),

      isFocusedShiftView: Boolean(focusedShiftView),

      applications: applicationViews,

      hasApplications: applicationViews.length > 0,

      summary: {
        visibleApplicationCount: applicationViews.length,

        totalFilteredApplications: Number(pagination?.totalItems || 0),

        activeApplicationCount,

        pendingCount: Number(statusCounts?.pending || 0),

        shortlistedCount: Number(statusCounts?.shortlisted || 0),

        acceptedCount: Number(statusCounts?.accepted || 0),
      },

      summaryCards,

      filters,

      resultsHeader: {
        title: PAGE_COPY.applicationsHeading,

        subtitle: paginationView.resultsText,
      },

      permissions: {
        canManageApplications: canManageApplications === true,

        readOnly: canManageApplications !== true,
      },

      readOnlyNotice:
        canManageApplications === true
          ? {
              visible: false,
            }
          : {
              visible: true,

              title: PAGE_COPY.readOnlyTitle,

              message: PAGE_COPY.readOnlyMessage,

              noticeClass: "bg-light-info border-info",

              icon: "ki-information-5",

              iconClass: "text-info",
            },

      pagination: paginationView,

      emptyState: this.buildEmptyState({
        focusedShift: focusedShiftView,

        selectedStatus,

        selectedApplicationType,

        clearUrl: filters.clearAction.url,
      }),

      actionModal: this.buildActionModalView(canManageApplications),

      actions: {
        applicationsUrl: EMPLOYER_APPLICATIONS_URL,

        manageShiftsUrl: EMPLOYER_SHIFTS_URL,

        focusedShiftUrl: focusedShiftView?.detailsUrl || null,
      },
    };
  }
}

module.exports = ShiftApplicationViewService;
