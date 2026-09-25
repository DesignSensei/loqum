// services/jobs/appointments/jobAppointmentViewService.js

const { badgeClass, formatStatus } = require("../../../utils/statusHelper");

const appointmentConstants = require("../../../constants/jobAppointment");

const APPOINTMENT_STATUSES = Object.freeze(
  Array.isArray(appointmentConstants.JOB_APPOINTMENT_STATUSES)
    ? [...appointmentConstants.JOB_APPOINTMENT_STATUSES]
    : ["scheduled", "completed", "cancelled", "no_show"]
);

const APPOINTMENT_RESPONSE_STATUSES = Object.freeze(
  Array.isArray(appointmentConstants.JOB_APPOINTMENT_RESPONSE_STATUSES)
    ? [...appointmentConstants.JOB_APPOINTMENT_RESPONSE_STATUSES]
    : ["pending", "confirmed", "declined"]
);

const APPOINTMENT_FORMATS = Object.freeze(
  Array.isArray(appointmentConstants.JOB_APPOINTMENT_FORMATS)
    ? [...appointmentConstants.JOB_APPOINTMENT_FORMATS]
    : ["onsite", "video", "phone"]
);

const EMPLOYER_APPOINTMENTS_URL = "/employer/job-appointments";
const PROFESSIONAL_APPOINTMENTS_URL = "/professional/job-appointments";
const ADMIN_APPOINTMENTS_URL = "/admin/job-appointments";

const EMPLOYER_APPLICATIONS_URL = "/employer/job-applications";
const PROFESSIONAL_APPLICATIONS_URL = "/professional/job-applications";

const AWAITING_EMPLOYER_UPDATE_STATUS = "awaiting_employer_update";
const DEFAULT_BADGE_CLASS = "badge-light-secondary";

const APPOINTMENT_STATUS_BADGES = Object.freeze({
  scheduled: "badge-light-primary",
  awaiting_employer_update: "badge-light-warning",
  completed: "badge-light-success",
  cancelled: "badge-light-secondary",
  no_show: "badge-light-danger",
});

const RESPONSE_STATUS_BADGES = Object.freeze({
  pending: "badge-light-warning",
  confirmed: "badge-light-success",
  declined: "badge-light-danger",
});

const PAGE_COPY = Object.freeze({
  employerTitle: "Interviews",
  professionalTitle: "My Interviews",
  adminTitle: "Interview Oversight",

  noEmployerAppointmentsTitle: "No interviews found",
  noProfessionalAppointmentsTitle: "No interviews found",
  noAdminAppointmentsTitle: "No interviews found",

  clearFiltersLabel: "Clear filters",

  readOnlyTitle: "Read-only interview access",
  readOnlyMessage:
    "You can review interviews in your authorized scope, but interview-management actions are unavailable for your role.",

  adminReadOnlyTitle: "Read-only interview oversight",
  adminReadOnlyMessage:
    "Platform admins can review permanent Job interviews, but interview-management and candidate recruitment decisions remain with the employer.",
});

const EMPLOYER_ACTIONS = Object.freeze({
  reschedule: Object.freeze({
    key: "reschedule",
    label: "Reschedule",
    method: "POST",
    buttonClass: "btn-light-primary",
    icon: "ki-calendar-edit",
    routeSuffix: "reschedule",
  }),

  cancel: Object.freeze({
    key: "cancel",
    label: "Cancel interview",
    method: "POST",
    buttonClass: "btn-light-danger",
    icon: "ki-cross-circle",
    routeSuffix: "cancel",
  }),

  complete: Object.freeze({
    key: "complete",
    label: "Mark completed",
    method: "POST",
    buttonClass: "btn-light-success",
    icon: "ki-check-circle",
    routeSuffix: "complete",
  }),

  noShow: Object.freeze({
    key: "no-show",
    label: "Record no-show",
    method: "POST",
    buttonClass: "btn-light-danger",
    icon: "ki-information-5",
    routeSuffix: "no-show",
  }),
});

class JobAppointmentViewService {
  /* ─────────────────────────────── HELPERS ─────────────────────────────── */

  static toId(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      return value;
    }

    return String(value._id || value);
  }

  static toNonNegativeSafeInteger(value, fallback = 0) {
    const normalized = Number(value);

    return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
  }

  static toPositiveSafeInteger(value, fallback = null) {
    const normalized = Number(value);

    return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : fallback;
  }

  static toFiniteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === "") {
      return fallback;
    }

    const normalized = Number(value);

    return Number.isFinite(normalized) ? normalized : fallback;
  }

  static formatStatusLabel(value) {
    return value ? formatStatus(String(value)) : null;
  }

  static getStatusBadgeClass(status) {
    return APPOINTMENT_STATUS_BADGES[status] || badgeClass?.[status] || DEFAULT_BADGE_CLASS;
  }

  static getResponseStatusBadgeClass(status) {
    return RESPONSE_STATUS_BADGES[status] || badgeClass?.[status] || DEFAULT_BADGE_CLASS;
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

  static formatTime(value, timeZone = null) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    const options = {
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

  /* ─────────────────────────────── URL BUILDERS ─────────────────────────────── */

  static buildEmployerAppointmentsUrl({
    status = "all",
    responseStatus = "all",
    applicationId = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (responseStatus && responseStatus !== "all") {
      params.set("response", responseStatus);
    }

    if (applicationId) {
      params.set("application", String(applicationId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${EMPLOYER_APPOINTMENTS_URL}?${query}` : EMPLOYER_APPOINTMENTS_URL;
  }

  static buildAdminAppointmentsUrl({
    employerProfileId = null,
    status = "all",
    responseStatus = "all",
    applicationId = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (employerProfileId) {
      params.set("employer", String(employerProfileId));
    }

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (responseStatus && responseStatus !== "all") {
      params.set("response", responseStatus);
    }

    if (applicationId) {
      params.set("application", String(applicationId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${ADMIN_APPOINTMENTS_URL}?${query}` : ADMIN_APPOINTMENTS_URL;
  }

  static buildProfessionalAppointmentsUrl({
    status = "all",
    responseStatus = "all",
    applicationId = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (responseStatus && responseStatus !== "all") {
      params.set("response", responseStatus);
    }

    if (applicationId) {
      params.set("application", String(applicationId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${PROFESSIONAL_APPOINTMENTS_URL}?${query}` : PROFESSIONAL_APPOINTMENTS_URL;
  }

  static buildEmployerActionUrl(appointmentId, routeSuffix) {
    return appointmentId && routeSuffix
      ? `${EMPLOYER_APPOINTMENTS_URL}/${appointmentId}/${routeSuffix}`
      : null;
  }

  /* ─────────────────────────────── RELATED RECORDS ─────────────────────────────── */

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

  static buildCertificationView(certification) {
    if (!certification || typeof certification !== "object") {
      return null;
    }

    const name = String(certification.name || "").trim();

    if (!name) {
      return null;
    }

    return {
      name,
      issuingBody: String(certification.issuingBody || "").trim() || null,
      dateObtained: certification.dateObtained || null,
      dateObtainedDisplay: this.formatDate(certification.dateObtained),
      expiryDate: certification.expiryDate || null,
      expiryDateDisplay: this.formatDate(certification.expiryDate),
      verified: certification.verified === true,
    };
  }

  static buildCertificationList(certifications) {
    return (Array.isArray(certifications) ? certifications : [])
      .map((certification) => this.buildCertificationView(certification))
      .filter(Boolean);
  }

  static buildProfessionalView(professional) {
    if (!professional) {
      return null;
    }

    const user = professional.user || null;

    const name =
      String(user?.displayName || "").trim() ||
      [user?.firstName, user?.lastName]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ") ||
      "Professional";

    const state = professional.state || null;
    const lga = professional.lga || null;

    const locationLabel = [lga, state]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", ");

    return {
      id: this.toId(professional),
      userId: this.toId(user),
      name,
      photo: user?.photo || null,
      initials: this.buildInitials(name),
      professionalType: professional.type || null,
      professionalTypeLabel: this.formatStatusLabel(professional.type),
      specialty: professional.specialty || null,
      bio: professional.bio || null,
      yearsOfExperience: this.toFiniteNumber(professional.yearsOfExperience, null),
      state,
      lga,
      locationLabel: locationLabel || null,
      tier: professional.tier || null,
      tierLabel: this.formatStatusLabel(professional.tier),
      averageRating: this.toFiniteNumber(professional.averageRating, null),
      totalReviews: this.toNonNegativeSafeInteger(professional.totalReviews, 0),
      reliabilityScore: this.toFiniteNumber(professional.reliabilityScore, null),
      totalShiftsCompleted: this.toNonNegativeSafeInteger(professional.totalShiftsCompleted, 0),
      licenceVerificationStatus: professional.licenceVerificationStatus || null,
      licenceVerificationStatusLabel: this.formatStatusLabel(
        professional.licenceVerificationStatus
      ),
      licenceVerificationStatusBadgeClass:
        badgeClass?.[professional.licenceVerificationStatus] || DEFAULT_BADGE_CLASS,
      licenceExpiryDate: professional.licenceExpiryDate || null,
      licenceExpiryDateDisplay: this.formatDate(professional.licenceExpiryDate),
      identityVerificationStatus: professional.identityVerificationStatus || null,
      identityVerificationStatusLabel: this.formatStatusLabel(
        professional.identityVerificationStatus
      ),
      identityVerificationStatusBadgeClass:
        badgeClass?.[professional.identityVerificationStatus] || DEFAULT_BADGE_CLASS,
      certifications: this.buildCertificationList(professional.certifications),
    };
  }

  static buildEmployerSnapshotView(employerSnapshot) {
    if (!employerSnapshot || typeof employerSnapshot !== "object") {
      return null;
    }

    const branchLocationLabel = [
      employerSnapshot.branchAddress,
      employerSnapshot.branchLga,
      employerSnapshot.branchState,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", ");

    return {
      snapshotVersion: employerSnapshot.snapshotVersion || null,
      businessName: employerSnapshot.businessName || null,
      type: employerSnapshot.type || null,
      typeLabel: this.formatStatusLabel(employerSnapshot.type),
      logoUrl: employerSnapshot.logoUrl || null,
      publicDescription: employerSnapshot.publicDescription || null,
      websiteUrl: employerSnapshot.websiteUrl || null,

      verification: {
        cacVerified: employerSnapshot.cacVerified === true,
        regulatoryVerified: employerSnapshot.regulatoryVerified === true,
        fullyVerified:
          employerSnapshot.cacVerified === true && employerSnapshot.regulatoryVerified === true,
      },

      branch: {
        name: employerSnapshot.branchName || null,
        address: employerSnapshot.branchAddress || null,
        state: employerSnapshot.branchState || null,
        lga: employerSnapshot.branchLga || null,
        locationLabel: branchLocationLabel || null,
      },
    };
  }

  static buildScreeningQuestionView(question) {
    if (!question || typeof question !== "object") {
      return null;
    }

    return {
      questionId: this.toId(question.questionId),
      prompt: question.prompt || null,
      type: question.type || null,
      typeLabel: this.formatStatusLabel(question.type),
      isResponseRequired: question.isResponseRequired === true,
      options: Array.isArray(question.options) ? [...question.options] : [],
    };
  }

  static buildListingSnapshotView(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return {};
    }

    return {
      snapshotVersion: snapshot.snapshotVersion || null,
      roleTitle: snapshot.roleTitle || null,
      professionalType: snapshot.professionalType || null,
      specialty: snapshot.specialty || null,
      department: snapshot.department || null,
      employmentType: snapshot.employmentType || null,
      workplaceType: snapshot.workplaceType || null,
      minimumYearsOfExperience: this.toNonNegativeSafeInteger(snapshot.minimumYearsOfExperience, 0),
      educationRequirement: snapshot.educationRequirement || null,
      countryCode: snapshot.countryCode || null,
      state: snapshot.state || null,
      lga: snapshot.lga || null,
      address: snapshot.address || null,
      currency: snapshot.currency || null,

      compensation:
        snapshot.compensation && typeof snapshot.compensation === "object"
          ? {
              type: snapshot.compensation.type || null,
              minimumAmount: snapshot.compensation.minimumAmount ?? null,
              maximumAmount: snapshot.compensation.maximumAmount ?? null,
              period: snapshot.compensation.period || null,
              negotiable: snapshot.compensation.negotiable === true,
            }
          : null,

      summary: snapshot.summary || null,
      description: snapshot.description || null,

      responsibilities: Array.isArray(snapshot.responsibilities)
        ? [...snapshot.responsibilities]
        : [],

      requirements: Array.isArray(snapshot.requirements) ? [...snapshot.requirements] : [],

      preferredQualifications: Array.isArray(snapshot.preferredQualifications)
        ? [...snapshot.preferredQualifications]
        : [],

      skills: Array.isArray(snapshot.skills) ? [...snapshot.skills] : [],
      benefits: Array.isArray(snapshot.benefits) ? [...snapshot.benefits] : [],
      vacancyCount: this.toPositiveSafeInteger(snapshot.vacancyCount, null),
      employmentStartDate: snapshot.employmentStartDate || null,

      screeningQuestions: (Array.isArray(snapshot.screeningQuestions)
        ? snapshot.screeningQuestions
        : []
      )
        .map((question) => this.buildScreeningQuestionView(question))
        .filter(Boolean),

      capturedAt: snapshot.capturedAt || null,
    };
  }

  static buildPublicationView(publication) {
    if (!publication) {
      return null;
    }

    const snapshot = this.buildListingSnapshotView(publication.listingSnapshot);

    const employer = this.buildEmployerSnapshotView(publication.employerSnapshot);

    return {
      id: this.toId(publication),
      jobId: this.toId(publication.job),
      cycleNumber: this.toPositiveSafeInteger(publication.cycleNumber, null),
      status: publication.status || null,
      statusLabel: this.formatStatusLabel(publication.status),
      statusBadgeClass: this.getStatusBadgeClass(publication.status),
      employer,
      roleTitle: snapshot.roleTitle || null,
      professionalType: snapshot.professionalType || null,
      professionalTypeLabel: this.formatStatusLabel(snapshot.professionalType),
      specialty: snapshot.specialty || null,
      department: snapshot.department || null,
      employmentType: snapshot.employmentType || null,
      employmentTypeLabel: this.formatStatusLabel(snapshot.employmentType),
      workplaceType: snapshot.workplaceType || null,
      workplaceTypeLabel: this.formatStatusLabel(snapshot.workplaceType),
      state: snapshot.state || null,
      lga: snapshot.lga || null,
      applicationDeadline: publication.applicationDeadline || null,
      applicationDeadlineDisplay: this.formatDate(publication.applicationDeadline),
      publishedAt: publication.publishedAt || null,
      publishedAtDisplay: this.formatDateTime(publication.publishedAt),
      expiresAt: publication.expiresAt || null,
      expiresAtDisplay: this.formatDateTime(publication.expiresAt),
      endedAt: publication.endedAt || null,
      endedAtDisplay: this.formatDateTime(publication.endedAt),
      listingSnapshot: snapshot,
    };
  }

  static buildApplicationView(application, { employer = false, admin = false } = {}) {
    if (!application) {
      return null;
    }

    const id = this.toId(application);

    const submittedAt = application.submittedAt || application.createdAt || null;

    const result = {
      id,
      jobId: this.toId(application.job),
      professionalId: this.toId(application.professional),
      status: application.status || null,
      statusLabel: this.formatStatusLabel(application.status),
      publication: this.buildPublicationView(application.publication),
      submittedAt,
      submittedAtDisplay: this.formatDateTime(submittedAt),

      detailsUrl: id
        ? admin
          ? null
          : employer
            ? `${EMPLOYER_APPLICATIONS_URL}/${id}`
            : `${PROFESSIONAL_APPLICATIONS_URL}/${id}`
        : null,
    };

    if (employer && application.employerPrivateNote) {
      result.employerPrivateNote = application.employerPrivateNote;
    }

    return result;
  }

  /* ─────────────────────────────── SCHEDULE ─────────────────────────────── */

  static buildOnsiteLocationDisplay(location) {
    if (!location) {
      return null;
    }

    if (typeof location === "string") {
      return location.trim() || null;
    }

    if (typeof location !== "object") {
      return null;
    }

    const explicitLabel = String(location.label || "").trim();

    if (explicitLabel) {
      return explicitLabel;
    }

    const parts = [location.name, location.address, location.lga, location.state]
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    return parts.length ? parts.join(", ") : null;
  }

  static buildScheduleView(schedule = {}) {
    if (!schedule || typeof schedule !== "object") {
      return null;
    }

    const timeZone = schedule.timeZone || null;
    const startAt = schedule.startAt || null;
    const endAt = schedule.endAt || null;
    const format = schedule.format || null;

    const startDateDisplay = this.formatDate(startAt, timeZone);
    const startTimeDisplay = this.formatTime(startAt, timeZone);
    const endTimeDisplay = this.formatTime(endAt, timeZone);

    return {
      startAt,
      endAt,
      timeZone,
      format,
      formatLabel: this.formatStatusLabel(format),
      startAtDisplay: this.formatDateTime(startAt, timeZone),
      endAtDisplay: this.formatDateTime(endAt, timeZone),
      dateDisplay: startDateDisplay,

      timeRangeDisplay:
        startTimeDisplay !== "-" && endTimeDisplay !== "-"
          ? `${startTimeDisplay} - ${endTimeDisplay}`
          : null,

      onsiteLocation: schedule.onsiteLocation || null,
      onsiteLocationDisplay: this.buildOnsiteLocationDisplay(schedule.onsiteLocation),
      meetingLink: schedule.meetingLink || null,
      phoneNumber: schedule.phoneNumber || null,
    };
  }

  static buildCurrentScheduleView(appointment) {
    if (!appointment) {
      return null;
    }

    return this.buildScheduleView({
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      timeZone: appointment.timeZone,
      format: appointment.format,
      onsiteLocation: appointment.onsiteLocation,
      meetingLink: appointment.meetingLink,
      phoneNumber: appointment.phoneNumber,
    });
  }

  static buildInitialScheduleView(appointment) {
    return this.buildScheduleView(appointment?.initialSchedule || null);
  }

  /* ─────────────────────────────── HISTORY ─────────────────────────────── */

  static buildResponseHistoryView(responseHistory = []) {
    return (Array.isArray(responseHistory) ? responseHistory : []).map((entry, index) => {
      const responseStatus = entry?.responseStatus || entry?.status || null;

      const respondedAt = entry?.respondedAt || entry?.createdAt || null;

      return {
        ...entry,
        key: `${responseStatus || "response"}-${index}`,
        responseStatus,
        responseStatusLabel: this.formatStatusLabel(responseStatus),
        responseStatusBadgeClass: this.getResponseStatusBadgeClass(responseStatus),
        respondedAt,
        respondedAtDisplay: this.formatDateTime(respondedAt),
      };
    });
  }

  static buildRescheduleHistoryView(rescheduleHistory = []) {
    return (Array.isArray(rescheduleHistory) ? rescheduleHistory : []).map((entry, index) => {
      const rescheduledAt = entry?.rescheduledAt || entry?.createdAt || null;

      const previousSchedule =
        entry?.previousSchedule || entry?.fromSchedule || entry?.oldSchedule || null;

      const newSchedule = entry?.newSchedule || entry?.toSchedule || null;

      return {
        ...entry,
        key: `reschedule-${index + 1}`,
        rescheduledAt,
        rescheduledAtDisplay: this.formatDateTime(rescheduledAt),
        previousSchedule: this.buildScheduleView(previousSchedule),
        newSchedule: this.buildScheduleView(newSchedule),
      };
    });
  }

  /* ─────────────────────────────── ACTIONS ─────────────────────────────── */

  static buildEmployerActions(appointment, canManageAppointments = false) {
    const id = this.toId(appointment);

    const isScheduled = appointment?.status === "scheduled";

    const awaitingEmployerUpdate = appointment?.awaitingEmployerUpdate === true;

    if (!id || canManageAppointments !== true || !isScheduled) {
      return {
        canManage: canManageAppointments === true,

        hasActions: false,

        items: [],
      };
    }

    const definitions = awaitingEmployerUpdate
      ? [EMPLOYER_ACTIONS.complete, EMPLOYER_ACTIONS.noShow]
      : [EMPLOYER_ACTIONS.reschedule, EMPLOYER_ACTIONS.cancel];

    return {
      canManage: true,

      hasActions: definitions.length > 0,

      items: definitions.map((definition) => ({
        ...definition,

        url: this.buildEmployerActionUrl(id, definition.routeSuffix),
      })),
    };
  }

  static buildReadOnlyActions() {
    return {
      canManage: false,
      hasActions: false,
      items: [],
    };
  }

  static buildProfessionalActions(appointment) {
    const id = this.toId(appointment);

    const canRespond = Boolean(
      id &&
      appointment?.status === "scheduled" &&
      appointment?.responseStatus === "pending" &&
      appointment?.awaitingEmployerUpdate !== true
    );

    if (!canRespond) {
      return {
        canRespond: false,
        items: [],
      };
    }

    return {
      canRespond: true,

      items: [
        {
          key: "confirm",
          label: "Confirm interview",
          method: "POST",
          buttonClass: "btn-success",
          icon: "ki-check-circle",
          url: `${PROFESSIONAL_APPOINTMENTS_URL}/${id}/confirm`,
        },

        {
          key: "decline",
          label: "Decline interview",
          method: "POST",
          buttonClass: "btn-light-danger",
          icon: "ki-cross-circle",
          url: `${PROFESSIONAL_APPOINTMENTS_URL}/${id}/decline`,
        },
      ],
    };
  }

  /* ─────────────────────────────── APPOINTMENT ─────────────────────────────── */

  static buildAppointmentView(appointment, { audience, canManageAppointments = false } = {}) {
    if (!appointment) {
      return null;
    }

    const id = this.toId(appointment);

    const isEmployerView = audience === "employer";

    const isAdminView = audience === "admin";

    const derivedStatus =
      appointment.awaitingEmployerUpdate === true
        ? AWAITING_EMPLOYER_UPDATE_STATUS
        : appointment.status || null;

    const responseStatus = appointment.responseStatus || null;

    const roundNumber = this.toPositiveSafeInteger(appointment.roundNumber, 1) || 1;

    const view = {
      id,

      referenceCode: appointment.referenceCode || null,

      title: appointment.title || "Interview",

      roundNumber,

      roundLabel: `Interview round ${roundNumber}`,

      jobId: this.toId(appointment.job),

      applicationId: this.toId(appointment.jobApplication),

      professionalId: this.toId(appointment.professional),

      branch: this.buildBranchView(appointment.branch),

      professional:
        isEmployerView || isAdminView ? this.buildProfessionalView(appointment.professional) : null,

      application: this.buildApplicationView(appointment.jobApplication, {
        employer: isEmployerView,

        admin: isAdminView,
      }),

      status: appointment.status || null,

      statusLabel: this.formatStatusLabel(appointment.status),

      statusBadgeClass: this.getStatusBadgeClass(appointment.status),

      awaitingEmployerUpdate: appointment.awaitingEmployerUpdate === true,

      derivedStatus,

      derivedStatusLabel: this.formatStatusLabel(derivedStatus),

      derivedStatusBadgeClass: this.getStatusBadgeClass(derivedStatus),

      responseStatus,

      responseStatusLabel: this.formatStatusLabel(responseStatus),

      responseStatusBadgeClass: this.getResponseStatusBadgeClass(responseStatus),

      respondedAt: appointment.respondedAt || null,

      respondedAtDisplay: this.formatDateTime(appointment.respondedAt),

      responseNote: appointment.responseNote || null,

      currentSchedule: this.buildCurrentScheduleView(appointment),

      initialSchedule: this.buildInitialScheduleView(appointment),

      meetingInstructions: appointment.meetingInstructions || null,

      interviewers: Array.isArray(appointment.interviewers) ? appointment.interviewers : [],

      rescheduleCount: this.toNonNegativeSafeInteger(appointment.rescheduleCount, 0),

      rescheduleHistory: this.buildRescheduleHistoryView(appointment.rescheduleHistory),

      responseHistory: this.buildResponseHistoryView(appointment.responseHistory),

      completion: {
        completedAt: appointment.completedAt || null,

        completedAtDisplay: this.formatDateTime(appointment.completedAt),

        completedBy: this.toId(appointment.completedBy),

        completionNote: appointment.completionNote || null,
      },

      cancellation: {
        cancelledAt: appointment.cancelledAt || null,

        cancelledAtDisplay: this.formatDateTime(appointment.cancelledAt),

        cancelledBy: this.toId(appointment.cancelledBy),

        cancelledByRole: appointment.cancelledByRole || null,

        cancelledByRoleLabel: this.formatStatusLabel(appointment.cancelledByRole),

        cancellationReason: appointment.cancellationReason || null,

        cancellationReasonLabel: this.formatStatusLabel(appointment.cancellationReason),

        cancellationNote: appointment.cancellationNote || null,
      },

      noShow: {
        recordedAt: appointment.noShowAt || appointment.noShowRecordedAt || null,

        recordedAtDisplay: this.formatDateTime(
          appointment.noShowAt || appointment.noShowRecordedAt
        ),

        recordedBy: this.toId(appointment.noShowRecordedBy || appointment.noShowBy),

        party: appointment.noShowParty || null,

        partyLabel: this.formatStatusLabel(appointment.noShowParty),

        note: appointment.noShowNote || null,
      },

      createdAt: appointment.createdAt || null,

      createdAtDisplay: this.formatDateTime(appointment.createdAt),

      updatedAt: appointment.updatedAt || null,

      updatedAtDisplay: this.formatDateTime(appointment.updatedAt),

      detailsUrl: id
        ? isAdminView
          ? `${ADMIN_APPOINTMENTS_URL}/${id}`
          : isEmployerView
            ? `${EMPLOYER_APPOINTMENTS_URL}/${id}`
            : `${PROFESSIONAL_APPOINTMENTS_URL}/${id}`
        : null,
    };

    if (isEmployerView) {
      view.employerPrivateNote = appointment.employerPrivateNote || null;

      view.actions = this.buildEmployerActions(appointment, canManageAppointments);
    } else if (isAdminView) {
      view.actions = this.buildReadOnlyActions();
    } else {
      view.actions = this.buildProfessionalActions(appointment);
    }

    return view;
  }

  /* ─────────────────────────────── FILTERS ─────────────────────────────── */

  static buildStatusFilters({ counts = {}, selectedStatus = "all", buildUrl }) {
    const statuses = ["all", ...APPOINTMENT_STATUSES, AWAITING_EMPLOYER_UPDATE_STATUS];

    return [...new Set(statuses)].map((status) => ({
      key: status,

      label: status === "all" ? "All" : this.formatStatusLabel(status),

      count: this.toNonNegativeSafeInteger(counts?.[status], 0),

      isActive: status === selectedStatus,

      url: buildUrl(status),
    }));
  }

  static buildResponseStatusFilters({ counts = {}, selectedResponseStatus = "all", buildUrl }) {
    const statuses = ["all", ...APPOINTMENT_RESPONSE_STATUSES];

    return [...new Set(statuses)].map((status) => ({
      key: status,

      label: status === "all" ? "All responses" : this.formatStatusLabel(status),

      count: this.toNonNegativeSafeInteger(counts?.[status], 0),

      isActive: status === selectedResponseStatus,

      url: buildUrl(status),
    }));
  }

  /* ─────────────────────────────── PAGINATION ─────────────────────────────── */

  static buildPaginationView({ pagination, buildUrl, emptyText }) {
    const currentPage = this.toPositiveSafeInteger(pagination?.currentPage, 1) || 1;

    const totalPages = this.toPositiveSafeInteger(pagination?.totalPages, 1) || 1;

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

      resultsText: totalItems > 0 ? `Showing ${startItem}-${endItem} of ${totalItems}` : emptyText,

      pageText: `Page ${currentPage} of ${totalPages}`,

      previous: {
        label: "Previous",

        enabled: previousPage !== null,

        url: previousPage === null ? null : buildUrl(previousPage),
      },

      next: {
        label: "Next",

        enabled: nextPage !== null,

        url: nextPage === null ? null : buildUrl(nextPage),
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER PAGE ─────────────────────────────── */

  static buildEmployerAppointmentsPageView(pageData = {}) {
    const {
      employer = null,

      appointments = [],

      focusedApplication = null,

      focusedJob = null,

      selectedStatus = "all",

      selectedResponseStatus = "all",

      selectedApplicationId = null,

      statusCounts = {},

      responseStatusCounts = {},

      canViewAppointments = true,

      canManageAppointments = false,

      pagination = {},
    } = pageData;

    const appointmentViews = (Array.isArray(appointments) ? appointments : [])
      .map((appointment) =>
        this.buildAppointmentView(appointment, {
          audience: "employer",

          canManageAppointments,
        })
      )
      .filter(Boolean);

    const effectiveApplicationId = selectedApplicationId || this.toId(focusedApplication) || null;

    const buildUrl = (overrides = {}) =>
      this.buildEmployerAppointmentsUrl({
        status: overrides.status ?? selectedStatus,

        responseStatus: overrides.responseStatus ?? selectedResponseStatus,

        applicationId: effectiveApplicationId,

        page: overrides.page ?? null,
      });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No interviews match the current filters.",

      buildUrl: (page) =>
        buildUrl({
          page,
        }),
    });

    const hasFilters = selectedStatus !== "all" || selectedResponseStatus !== "all";

    return {
      pageTitle: PAGE_COPY.employerTitle,

      employer,

      focusedApplication: this.buildApplicationView(focusedApplication, {
        employer: true,
      }),

      focusedJob,

      appointments: appointmentViews,

      hasAppointments: appointmentViews.length > 0,

      summary: {
        visibleAppointmentCount: appointmentViews.length,

        totalFilteredAppointments: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        scheduledCount: this.toNonNegativeSafeInteger(statusCounts?.scheduled, 0),

        awaitingEmployerUpdateCount: this.toNonNegativeSafeInteger(
          statusCounts?.[AWAITING_EMPLOYER_UPDATE_STATUS],
          0
        ),

        completedCount: this.toNonNegativeSafeInteger(statusCounts?.completed, 0),

        cancelledCount: this.toNonNegativeSafeInteger(statusCounts?.cancelled, 0),

        noShowCount: this.toNonNegativeSafeInteger(statusCounts?.no_show, 0),
      },

      filters: {
        status: this.buildStatusFilters({
          counts: statusCounts,

          selectedStatus,

          buildUrl: (status) =>
            buildUrl({
              status,
              page: 1,
            }),
        }),

        responseStatus: this.buildResponseStatusFilters({
          counts: responseStatusCounts,

          selectedResponseStatus,

          buildUrl: (responseStatus) =>
            buildUrl({
              responseStatus,
              page: 1,
            }),
        }),

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: this.buildEmployerAppointmentsUrl({
            applicationId: effectiveApplicationId,
          }),
        },
      },

      permissions: {
        canViewAppointments: canViewAppointments === true,

        canManageAppointments: canManageAppointments === true,

        readOnly: canViewAppointments === true && canManageAppointments !== true,
      },

      readOnlyNotice:
        canViewAppointments === true && canManageAppointments !== true
          ? {
              visible: true,

              title: PAGE_COPY.readOnlyTitle,

              message: PAGE_COPY.readOnlyMessage,

              noticeClass: "bg-light-info border-info",

              icon: "ki-information-5",

              iconClass: "text-info",
            }
          : {
              visible: false,
            },

      resultsHeader: {
        title: "Interviews",

        subtitle: paginationView.resultsText,
      },

      pagination: paginationView,

      emptyState: {
        visible: appointmentViews.length === 0,

        icon: "ki-calendar",

        title: PAGE_COPY.noEmployerAppointmentsTitle,

        message: hasFilters
          ? "No interviews match the current filters."
          : effectiveApplicationId
            ? "No interviews have been scheduled for this application yet."
            : "No permanent Job interviews are available yet.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: this.buildEmployerAppointmentsUrl({
            applicationId: effectiveApplicationId,
          }),
        },
      },

      actions: {
        appointmentsUrl: EMPLOYER_APPOINTMENTS_URL,

        focusedApplicationUrl: effectiveApplicationId
          ? `${EMPLOYER_APPLICATIONS_URL}/${effectiveApplicationId}`
          : null,
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER DETAIL ─────────────────────────────── */

  static buildEmployerAppointmentDetailView(pageData = {}) {
    const {
      employer = null,

      appointment = null,

      application = null,

      job = null,

      canViewAppointments = true,

      canManageAppointments = false,
    } = pageData;

    const appointmentView = this.buildAppointmentView(appointment, {
      audience: "employer",

      canManageAppointments,
    });

    return {
      pageTitle: appointmentView?.title || "Interview Details",

      employer,

      appointment: appointmentView,

      application: this.buildApplicationView(application, {
        employer: true,
      }),

      job,

      permissions: {
        canViewAppointments: canViewAppointments === true,

        canManageAppointments: canManageAppointments === true,

        readOnly: canViewAppointments === true && canManageAppointments !== true,
      },

      readOnlyNotice:
        canViewAppointments === true && canManageAppointments !== true
          ? {
              visible: true,

              title: PAGE_COPY.readOnlyTitle,

              message: PAGE_COPY.readOnlyMessage,

              noticeClass: "bg-light-info border-info",

              icon: "ki-information-5",

              iconClass: "text-info",
            }
          : {
              visible: false,
            },

      actions: {
        appointmentsUrl: EMPLOYER_APPOINTMENTS_URL,

        applicationUrl: this.toId(application)
          ? `${EMPLOYER_APPLICATIONS_URL}/${this.toId(application)}`
          : null,
      },
    };
  }

  /* ─────────────────────────────── ADMIN PAGE ─────────────────────────────── */

  static buildAdminAppointmentsPageView(pageData = {}) {
    const {
      appointments = [],

      focusedApplication = null,

      focusedJob = null,

      selectedEmployerProfileId = null,

      selectedStatus = "all",

      selectedResponseStatus = "all",

      selectedApplicationId = null,

      statusCounts = {},

      responseStatusCounts = {},

      canViewAppointments = true,

      pagination = {},
    } = pageData;

    const appointmentViews = (Array.isArray(appointments) ? appointments : [])
      .map((appointment) =>
        this.buildAppointmentView(appointment, {
          audience: "admin",

          canManageAppointments: false,
        })
      )
      .filter(Boolean);

    const effectiveApplicationId = selectedApplicationId || this.toId(focusedApplication) || null;

    const buildUrl = (overrides = {}) =>
      this.buildAdminAppointmentsUrl({
        employerProfileId: Object.prototype.hasOwnProperty.call(overrides, "employerProfileId")
          ? overrides.employerProfileId
          : selectedEmployerProfileId,

        status: overrides.status ?? selectedStatus,

        responseStatus: overrides.responseStatus ?? selectedResponseStatus,

        applicationId: effectiveApplicationId,

        page: overrides.page ?? null,
      });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No interviews match the current filters.",

      buildUrl: (page) =>
        buildUrl({
          page,
        }),
    });

    const hasFilters = Boolean(
      selectedEmployerProfileId || selectedStatus !== "all" || selectedResponseStatus !== "all"
    );

    return {
      pageTitle: PAGE_COPY.adminTitle,

      focusedApplication: this.buildApplicationView(focusedApplication, {
        admin: true,
      }),

      focusedJob,

      appointments: appointmentViews,

      hasAppointments: appointmentViews.length > 0,

      summary: {
        visibleAppointmentCount: appointmentViews.length,

        totalFilteredAppointments: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        scheduledCount: this.toNonNegativeSafeInteger(statusCounts?.scheduled, 0),

        awaitingEmployerUpdateCount: this.toNonNegativeSafeInteger(
          statusCounts?.[AWAITING_EMPLOYER_UPDATE_STATUS],
          0
        ),

        completedCount: this.toNonNegativeSafeInteger(statusCounts?.completed, 0),

        cancelledCount: this.toNonNegativeSafeInteger(statusCounts?.cancelled, 0),

        noShowCount: this.toNonNegativeSafeInteger(statusCounts?.no_show, 0),
      },

      filters: {
        employer: {
          value: selectedEmployerProfileId || null,

          clearUrl: selectedEmployerProfileId
            ? buildUrl({
                employerProfileId: null,

                page: 1,
              })
            : null,
        },

        status: this.buildStatusFilters({
          counts: statusCounts,

          selectedStatus,

          buildUrl: (status) =>
            buildUrl({
              status,
              page: 1,
            }),
        }),

        responseStatus: this.buildResponseStatusFilters({
          counts: responseStatusCounts,

          selectedResponseStatus,

          buildUrl: (responseStatus) =>
            buildUrl({
              responseStatus,
              page: 1,
            }),
        }),

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: this.buildAdminAppointmentsUrl({
            applicationId: effectiveApplicationId,
          }),
        },
      },

      permissions: {
        canViewAppointments: canViewAppointments === true,

        canManageAppointments: false,

        readOnly: true,
      },

      readOnlyNotice: {
        visible: true,

        title: PAGE_COPY.adminReadOnlyTitle,

        message: PAGE_COPY.adminReadOnlyMessage,

        noticeClass: "bg-light-info border-info",

        icon: "ki-information-5",

        iconClass: "text-info",
      },

      resultsHeader: {
        title: "Interviews",

        subtitle: paginationView.resultsText,
      },

      pagination: paginationView,

      emptyState: {
        visible: appointmentViews.length === 0,

        icon: "ki-calendar",

        title: PAGE_COPY.noAdminAppointmentsTitle,

        message: hasFilters
          ? "No interviews match the current filters."
          : effectiveApplicationId
            ? "No interviews have been scheduled for this application yet."
            : "No permanent Job interviews are available yet.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: this.buildAdminAppointmentsUrl({
            applicationId: effectiveApplicationId,
          }),
        },
      },

      actions: {
        appointmentsUrl: ADMIN_APPOINTMENTS_URL,

        focusedApplicationUrl: null,
      },
    };
  }

  /* ─────────────────────────────── ADMIN DETAIL ─────────────────────────────── */

  static buildAdminAppointmentDetailView(pageData = {}) {
    const {
      employer = null,

      appointment = null,

      application = null,

      job = null,

      canViewAppointments = true,
    } = pageData;

    const appointmentView = this.buildAppointmentView(appointment, {
      audience: "admin",

      canManageAppointments: false,
    });

    return {
      pageTitle: appointmentView?.title || "Interview Details",

      employer,

      appointment: appointmentView,

      application: this.buildApplicationView(application, {
        admin: true,
      }),

      job,

      permissions: {
        canViewAppointments: canViewAppointments === true,

        canManageAppointments: false,

        readOnly: true,
      },

      readOnlyNotice: {
        visible: true,

        title: PAGE_COPY.adminReadOnlyTitle,

        message: PAGE_COPY.adminReadOnlyMessage,

        noticeClass: "bg-light-info border-info",

        icon: "ki-information-5",

        iconClass: "text-info",
      },

      actions: {
        appointmentsUrl: ADMIN_APPOINTMENTS_URL,

        applicationUrl: null,
      },
    };
  }

  /* ─────────────────────────────── PROFESSIONAL PAGE ─────────────────────────────── */

  static buildProfessionalAppointmentsPageView(pageData = {}) {
    const {
      professional = null,

      appointments = [],

      focusedApplication = null,

      selectedStatus = "all",

      selectedResponseStatus = "all",

      selectedApplicationId = null,

      statusCounts = {},

      responseStatusCounts = {},

      pagination = {},
    } = pageData;

    const appointmentViews = (Array.isArray(appointments) ? appointments : [])
      .map((appointment) =>
        this.buildAppointmentView(appointment, {
          audience: "professional",
        })
      )
      .filter(Boolean);

    const effectiveApplicationId = selectedApplicationId || this.toId(focusedApplication) || null;

    const buildUrl = (overrides = {}) =>
      this.buildProfessionalAppointmentsUrl({
        status: overrides.status ?? selectedStatus,

        responseStatus: overrides.responseStatus ?? selectedResponseStatus,

        applicationId: effectiveApplicationId,

        page: overrides.page ?? null,
      });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No interviews match the current filters.",

      buildUrl: (page) =>
        buildUrl({
          page,
        }),
    });

    const hasFilters = selectedStatus !== "all" || selectedResponseStatus !== "all";

    return {
      pageTitle: PAGE_COPY.professionalTitle,

      professional,

      focusedApplication: this.buildApplicationView(focusedApplication),

      appointments: appointmentViews,

      hasAppointments: appointmentViews.length > 0,

      summary: {
        visibleAppointmentCount: appointmentViews.length,

        totalFilteredAppointments: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        scheduledCount: this.toNonNegativeSafeInteger(statusCounts?.scheduled, 0),

        awaitingEmployerUpdateCount: this.toNonNegativeSafeInteger(
          statusCounts?.[AWAITING_EMPLOYER_UPDATE_STATUS],
          0
        ),

        completedCount: this.toNonNegativeSafeInteger(statusCounts?.completed, 0),

        cancelledCount: this.toNonNegativeSafeInteger(statusCounts?.cancelled, 0),

        noShowCount: this.toNonNegativeSafeInteger(statusCounts?.no_show, 0),
      },

      filters: {
        status: this.buildStatusFilters({
          counts: statusCounts,

          selectedStatus,

          buildUrl: (status) =>
            buildUrl({
              status,
              page: 1,
            }),
        }),

        responseStatus: this.buildResponseStatusFilters({
          counts: responseStatusCounts,

          selectedResponseStatus,

          buildUrl: (responseStatus) =>
            buildUrl({
              responseStatus,
              page: 1,
            }),
        }),

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: this.buildProfessionalAppointmentsUrl({
            applicationId: effectiveApplicationId,
          }),
        },
      },

      resultsHeader: {
        title: "Interviews",

        subtitle: paginationView.resultsText,
      },

      pagination: paginationView,

      emptyState: {
        visible: appointmentViews.length === 0,

        icon: "ki-calendar",

        title: PAGE_COPY.noProfessionalAppointmentsTitle,

        message: hasFilters
          ? "No interviews match the current filters."
          : effectiveApplicationId
            ? "No interviews have been scheduled for this application yet."
            : "Your scheduled permanent Job interviews will appear here.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: this.buildProfessionalAppointmentsUrl({
            applicationId: effectiveApplicationId,
          }),
        },
      },

      actions: {
        appointmentsUrl: PROFESSIONAL_APPOINTMENTS_URL,

        focusedApplicationUrl: effectiveApplicationId
          ? `${PROFESSIONAL_APPLICATIONS_URL}/${effectiveApplicationId}`
          : null,
      },
    };
  }

  /* ─────────────────────────────── PROFESSIONAL DETAIL ─────────────────────────────── */

  static buildProfessionalAppointmentDetailView(pageData = {}) {
    const {
      professional = null,

      appointment = null,

      application = null,
    } = pageData;

    const appointmentView = this.buildAppointmentView(appointment, {
      audience: "professional",
    });

    return {
      pageTitle: appointmentView?.title || "Interview Details",

      professional,

      appointment: appointmentView,

      application: this.buildApplicationView(application),

      actions: {
        appointmentsUrl: PROFESSIONAL_APPOINTMENTS_URL,

        applicationUrl: this.toId(application)
          ? `${PROFESSIONAL_APPLICATIONS_URL}/${this.toId(application)}`
          : null,
      },
    };
  }

  /* ─────────────────────────────── APPLICATION-SCOPED VIEW ─────────────────────────────── */

  static buildEmployerApplicationAppointmentsView(pageData = {}) {
    const {
      employer = null,

      application = null,

      job = null,

      appointments = [],

      canViewAppointments = true,

      canManageAppointments = false,
    } = pageData;

    const appointmentViews = (Array.isArray(appointments) ? appointments : [])
      .map((appointment) =>
        this.buildAppointmentView(appointment, {
          audience: "employer",

          canManageAppointments,
        })
      )
      .filter(Boolean);

    return {
      employer,

      application: this.buildApplicationView(application, {
        employer: true,
      }),

      job,

      appointments: appointmentViews,

      hasAppointments: appointmentViews.length > 0,

      permissions: {
        canViewAppointments: canViewAppointments === true,

        canManageAppointments: canManageAppointments === true,

        readOnly: canViewAppointments === true && canManageAppointments !== true,
      },

      readOnlyNotice:
        canViewAppointments === true && canManageAppointments !== true
          ? {
              visible: true,

              title: PAGE_COPY.readOnlyTitle,

              message: PAGE_COPY.readOnlyMessage,

              noticeClass: "bg-light-info border-info",

              icon: "ki-information-5",

              iconClass: "text-info",
            }
          : {
              visible: false,
            },
    };
  }

  static buildAdminApplicationAppointmentsView(pageData = {}) {
    const {
      employer = null,

      application = null,

      job = null,

      appointments = [],

      canViewAppointments = true,
    } = pageData;

    const appointmentViews = (Array.isArray(appointments) ? appointments : [])
      .map((appointment) =>
        this.buildAppointmentView(appointment, {
          audience: "admin",

          canManageAppointments: false,
        })
      )
      .filter(Boolean);

    return {
      employer,

      application: this.buildApplicationView(application, {
        admin: true,
      }),

      job,

      appointments: appointmentViews,

      hasAppointments: appointmentViews.length > 0,

      permissions: {
        canViewAppointments: canViewAppointments === true,

        canManageAppointments: false,

        readOnly: true,
      },

      readOnlyNotice: {
        visible: true,

        title: PAGE_COPY.adminReadOnlyTitle,

        message: PAGE_COPY.adminReadOnlyMessage,

        noticeClass: "bg-light-info border-info",

        icon: "ki-information-5",

        iconClass: "text-info",
      },
    };
  }

  static buildProfessionalApplicationAppointmentsView(pageData = {}) {
    const {
      professional = null,

      application = null,

      appointments = [],
    } = pageData;

    const appointmentViews = (Array.isArray(appointments) ? appointments : [])
      .map((appointment) =>
        this.buildAppointmentView(appointment, {
          audience: "professional",
        })
      )
      .filter(Boolean);

    return {
      professional,

      application: this.buildApplicationView(application),

      appointments: appointmentViews,

      hasAppointments: appointmentViews.length > 0,
    };
  }
}

module.exports = JobAppointmentViewService;
