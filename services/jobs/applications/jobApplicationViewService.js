// services/jobs/applications/jobApplicationViewService.js

const { badgeClass, formatStatus } = require("../../../utils/statusHelper");

const jobApplicationConstants = require("../../../constants/jobApplication");

const JOB_APPLICATION_STATUSES = Object.freeze(
  Array.isArray(jobApplicationConstants.JOB_APPLICATION_STATUSES)
    ? [...jobApplicationConstants.JOB_APPLICATION_STATUSES]
    : Array.isArray(jobApplicationConstants.APPLICATION_STATUSES)
      ? [...jobApplicationConstants.APPLICATION_STATUSES]
      : [
          "submitted",
          "under_review",
          "shortlisted",
          "interview",
          "offered",
          "hired",
          "rejected",
          "withdrawn",
        ]
);

const JOB_APPLICATION_ALLOWED_TRANSITIONS =
  jobApplicationConstants.JOB_APPLICATION_ALLOWED_TRANSITIONS ||
  jobApplicationConstants.APPLICATION_ALLOWED_TRANSITIONS ||
  {};

const EMPLOYER_APPLICATIONS_URL = "/employer/job-applications";

const ADMIN_APPLICATIONS_URL = "/admin/job-applications";

const PROFESSIONAL_APPLICATIONS_URL = "/professional/job-applications";

const MARKETPLACE_JOBS_URL = "/jobs";

const EMPLOYER_JOBS_URL = "/employer/jobs";

const ADMIN_JOBS_URL = "/admin/jobs";

const DEFAULT_BADGE_CLASS = "badge-light-secondary";

const APPLICATION_STATUS_BADGES = Object.freeze({
  submitted: "badge-light-warning",
  under_review: "badge-light-info",
  shortlisted: "badge-light-primary",
  interview: "badge-light-info",
  offered: "badge-light-success",
  hired: "badge-light-success",
  rejected: "badge-light-danger",
  withdrawn: "badge-light-secondary",
});

const APPLICATION_STATUS_ORDER = Object.freeze([
  "submitted",
  "under_review",
  "shortlisted",
  "interview",
  "offered",
  "hired",
  "rejected",
  "withdrawn",
]);

const EMPLOYER_ACTION_PRESENTATION = Object.freeze({
  under_review: Object.freeze({
    key: "under_review",
    targetStatus: "under_review",
    label: "Mark under review",
    method: "POST",
    buttonClass: "btn-light-info",
    icon: "ki-eye",
    routeSuffix: "under-review",
    modalTitle: "Move application under review",
    confirmLabel: "Mark under review",
    confirmButtonClass: "btn-info",
    fields: Object.freeze(["statusNote", "employerPrivateNote"]),
  }),

  shortlisted: Object.freeze({
    key: "shortlisted",
    targetStatus: "shortlisted",
    label: "Shortlist",
    method: "POST",
    buttonClass: "btn-light-primary",
    icon: "ki-check-square",
    routeSuffix: "shortlist",
    modalTitle: "Shortlist applicant",
    confirmLabel: "Shortlist",
    confirmButtonClass: "btn-primary",
    fields: Object.freeze(["statusNote", "employerPrivateNote"]),
  }),

  interview: Object.freeze({
    key: "interview",
    targetStatus: "interview",
    label: "Move to interview",
    method: "POST",
    buttonClass: "btn-light-info",
    icon: "ki-calendar",
    routeSuffix: "interview",
    modalTitle: "Move applicant to interview",
    confirmLabel: "Move to interview",
    confirmButtonClass: "btn-info",
    fields: Object.freeze(["statusNote", "employerPrivateNote"]),
  }),

  offered: Object.freeze({
    key: "offered",
    targetStatus: "offered",
    label: "Make offer",
    method: "POST",
    buttonClass: "btn-light-success",
    icon: "ki-document",
    routeSuffix: "offer",
    modalTitle: "Move applicant to offer",
    confirmLabel: "Make offer",
    confirmButtonClass: "btn-success",
    fields: Object.freeze(["statusNote", "employerPrivateNote"]),
  }),

  rejected: Object.freeze({
    key: "rejected",
    targetStatus: "rejected",
    label: "Reject",
    method: "POST",
    buttonClass: "btn-light-danger",
    icon: "ki-cross-circle",
    routeSuffix: "reject",
    modalTitle: "Reject application",
    confirmLabel: "Reject application",
    confirmButtonClass: "btn-danger",
    fields: Object.freeze(["reason", "reasonDetails", "statusNote", "employerPrivateNote"]),
  }),

  hired: Object.freeze({
    key: "hired",
    targetStatus: "hired",
    label: "Hire",
    method: "POST",
    buttonClass: "btn-success",
    icon: "ki-user-tick",
    routeSuffix: "hire",
    modalTitle: "Hire applicant",
    confirmLabel: "Hire applicant",
    confirmButtonClass: "btn-success",
    fields: Object.freeze(["statusNote", "employerPrivateNote"]),

    notice: Object.freeze({
      noticeClass: "bg-light-warning border-warning",

      message:
        "Hiring uses the authoritative publication finalization flow. If this fills the last vacancy, recruitment may be closed and remaining applications rejected.",
    }),
  }),
});

const ACTION_FIELD_PRESENTATION = Object.freeze({
  reason: Object.freeze({
    key: "reason",
    name: "reason",
    label: "Reason",
    type: "text",
    required: true,
  }),

  reasonDetails: Object.freeze({
    key: "reasonDetails",
    name: "reasonDetails",
    label: "Reason details",
    type: "textarea",
    rows: 3,
    required: false,
  }),

  statusNote: Object.freeze({
    key: "statusNote",
    name: "statusNote",
    label: "Status note",
    type: "textarea",
    rows: 3,
    required: false,
  }),

  employerPrivateNote: Object.freeze({
    key: "employerPrivateNote",
    name: "employerPrivateNote",
    label: "Private employer note",

    helpText: "This note is visible only within the employer application review workflow.",

    type: "textarea",
    rows: 4,
    required: false,
  }),
});

const PAGE_COPY = Object.freeze({
  employerTitle: "Job Applications",

  adminTitle: "Job Application Oversight",

  professionalTitle: "My Job Applications",

  noEmployerApplicationsTitle: "No applications found",

  noAdminApplicationsTitle: "No applications found",

  noProfessionalApplicationsTitle: "No applications found",

  clearFiltersLabel: "Clear filters",

  readOnlyTitle: "Read-only access",

  readOnlyMessage:
    "You can view permanent Job applications in your authorized scope, but application-management actions are unavailable for your role.",

  adminReadOnlyTitle: "Read-only application oversight",

  adminReadOnlyMessage:
    "Platform admins can review permanent Job applications, but candidate recruitment decisions remain with the employer.",
});

class JobApplicationViewService {
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

  static getApplicationStatusBadgeClass(status) {
    return APPLICATION_STATUS_BADGES[status] || badgeClass?.[status] || DEFAULT_BADGE_CLASS;
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

  static getAllowedTransitions(status) {
    if (!status) {
      return [];
    }

    const transitions = JOB_APPLICATION_ALLOWED_TRANSITIONS[status];

    if (Array.isArray(transitions)) {
      return transitions;
    }

    if (transitions instanceof Set) {
      return [...transitions];
    }

    return [];
  }

  static canTransition(status, targetStatus) {
    return this.getAllowedTransitions(status).includes(targetStatus);
  }

  static formatFileSize(value) {
    const sizeBytes = this.toNonNegativeSafeInteger(value, 0);

    if (sizeBytes < 1) {
      return null;
    }

    const units = ["B", "KB", "MB", "GB"];

    let size = sizeBytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    const decimals = unitIndex === 0 || size >= 10 ? 0 : 1;

    return `${size.toFixed(decimals)} ${units[unitIndex]}`;
  }

  /* ─────────────────────────────── CERTIFICATIONS ─────────────────────────────── */

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

  /* ─────────────────────────────── RESUME ─────────────────────────────── */

  static buildResumeView(resumeSnapshot) {
    if (!resumeSnapshot || typeof resumeSnapshot !== "object") {
      return null;
    }

    const source = resumeSnapshot.source || null;

    const documentUrl = String(resumeSnapshot.documentUrl || "").trim() || null;

    const sizeBytes = this.toNonNegativeSafeInteger(resumeSnapshot.sizeBytes, 0) || null;

    return {
      source,

      sourceLabel:
        source === "profile_resume"
          ? "Saved CV"
          : source === "application_upload"
            ? "Application upload"
            : this.formatStatusLabel(source),

      fileName: resumeSnapshot.fileName || null,

      mimeType: resumeSnapshot.mimeType || null,

      sizeBytes,

      sizeDisplay: this.formatFileSize(sizeBytes),

      capturedAt: resumeSnapshot.capturedAt || null,

      capturedAtDisplay: this.formatDateTime(resumeSnapshot.capturedAt),

      documentUrl,

      canAccessDocument: Boolean(documentUrl),
    };
  }

  /* ─────────────────────────────── EMPLOYER SNAPSHOT ─────────────────────────────── */

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

  /* ─────────────────────────────── SCREENING PRESENTATION ─────────────────────────────── */

  static buildSafeScreeningQuestionView(question, { includeCriteria = false } = {}) {
    if (!question || typeof question !== "object") {
      return null;
    }

    const view = {
      questionId: this.toId(question.questionId),

      prompt: question.prompt || null,

      type: question.type || null,

      typeLabel: this.formatStatusLabel(question.type),

      isResponseRequired: question.isResponseRequired === true,

      options: Array.isArray(question.options) ? [...question.options] : [],
    };

    if (includeCriteria) {
      view.requirementLevel = question.requirementLevel || null;

      view.requirementLevelLabel = this.formatStatusLabel(question.requirementLevel);

      view.qualifyingBoolean =
        typeof question.qualifyingBoolean === "boolean" ? question.qualifyingBoolean : null;

      view.minimumNumber = question.minimumNumber ?? null;

      view.maximumNumber = question.maximumNumber ?? null;

      view.acceptableOptions = Array.isArray(question.acceptableOptions)
        ? [...question.acceptableOptions]
        : [];

      view.requireAllOptions = question.requireAllOptions === true;
    }

    return view;
  }

  static buildSafeListingSnapshot(snapshot, { includeScreeningCriteria = false } = {}) {
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

      vacancyCount: this.toNonNegativeSafeInteger(snapshot.vacancyCount, 0),

      employmentStartDate: snapshot.employmentStartDate || null,

      screeningQuestions: (Array.isArray(snapshot.screeningQuestions)
        ? snapshot.screeningQuestions
        : []
      )
        .map((question) =>
          this.buildSafeScreeningQuestionView(question, {
            includeCriteria: includeScreeningCriteria,
          })
        )
        .filter(Boolean),

      capturedAt: snapshot.capturedAt || null,
    };
  }

  static buildScreeningAnswersView(answers, { includeEvaluation = false } = {}) {
    return (Array.isArray(answers) ? answers : []).map((answer) => {
      const view = {
        questionId: this.toId(answer?.questionId),

        prompt: answer?.promptSnapshot || null,

        type: answer?.questionType || null,

        typeLabel: this.formatStatusLabel(answer?.questionType),

        responseRequired: answer?.responseRequired === true,

        booleanAnswer: typeof answer?.booleanAnswer === "boolean" ? answer.booleanAnswer : null,

        numberAnswer: answer?.numberAnswer ?? null,

        selectedOptions: Array.isArray(answer?.selectedOptions) ? [...answer.selectedOptions] : [],

        textAnswer: answer?.textAnswer || null,
      };

      if (includeEvaluation) {
        view.requirementLevel = answer?.requirementLevel || null;

        view.requirementLevelLabel = this.formatStatusLabel(answer?.requirementLevel);

        view.criterionMet = typeof answer?.criterionMet === "boolean" ? answer.criterionMet : null;
      }

      return view;
    });
  }

  /* ─────────────────────────────── CANDIDATE SNAPSHOT ─────────────────────────────── */

  static buildCandidateSnapshotView(candidateSnapshot) {
    if (!candidateSnapshot || typeof candidateSnapshot !== "object") {
      return null;
    }

    return {
      firstName: candidateSnapshot.firstName || null,

      lastName: candidateSnapshot.lastName || null,

      displayName: candidateSnapshot.displayName || null,

      photo: candidateSnapshot.photo || null,

      email: candidateSnapshot.email || null,

      professionalType: candidateSnapshot.professionalType || null,

      specialty: candidateSnapshot.specialty || null,

      bio: candidateSnapshot.bio || null,

      yearsOfExperience: this.toFiniteNumber(candidateSnapshot.yearsOfExperience, null),

      state: candidateSnapshot.state || null,

      lga: candidateSnapshot.lga || null,

      licenceIssuingBody: candidateSnapshot.licenceIssuingBody || null,

      licenceVerificationStatus: candidateSnapshot.licenceVerificationStatus || null,

      licenceExpiryDate: candidateSnapshot.licenceExpiryDate || null,

      identityVerificationStatus: candidateSnapshot.identityVerificationStatus || null,

      certifications: this.buildCertificationList(candidateSnapshot.certifications),

      capturedAt: candidateSnapshot.capturedAt || null,

      capturedAtDisplay: this.formatDateTime(candidateSnapshot.capturedAt),
    };
  }

  /* ─────────────────────────────── URL BUILDERS ─────────────────────────────── */

  static buildEmployerApplicationsUrl({ status = "all", jobId = null, page = null } = {}) {
    const baseUrl = jobId
      ? `${EMPLOYER_JOBS_URL}/${jobId}/applications`
      : EMPLOYER_APPLICATIONS_URL;

    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${baseUrl}?${query}` : baseUrl;
  }

  static buildAdminApplicationsUrl({
    employerProfileId = null,
    status = "all",
    jobId = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (employerProfileId) {
      params.set("employer", String(employerProfileId));
    }

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (jobId) {
      params.set("job", String(jobId));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${ADMIN_APPLICATIONS_URL}?${query}` : ADMIN_APPLICATIONS_URL;
  }

  static buildProfessionalApplicationsUrl({ status = "all", page = null } = {}) {
    const params = new URLSearchParams();

    if (status && status !== "all") {
      params.set("status", status);
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${PROFESSIONAL_APPLICATIONS_URL}?${query}` : PROFESSIONAL_APPLICATIONS_URL;
  }

  static buildEmployerActionUrl(applicationId, routeSuffix) {
    return applicationId && routeSuffix
      ? `${EMPLOYER_APPLICATIONS_URL}/${applicationId}/${routeSuffix}`
      : null;
  }

  /* ─────────────────────────────── JOB / PUBLICATION ─────────────────────────────── */

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

  static buildEmployerJobView(job) {
    if (!job) {
      return null;
    }

    const id = this.toId(job);

    const branch = this.buildBranchView(job.branch);

    return {
      id,

      referenceCode: job.referenceCode || null,

      roleTitle: job.roleTitle || null,

      professionalType: job.professionalType || null,

      professionalTypeLabel: this.formatStatusLabel(job.professionalType),

      specialty: job.specialty || null,

      department: job.department || null,

      employmentType: job.employmentType || null,

      employmentTypeLabel: this.formatStatusLabel(job.employmentType),

      workplaceType: job.workplaceType || null,

      workplaceTypeLabel: this.formatStatusLabel(job.workplaceType),

      recruitmentStatus: job.recruitmentStatus || null,

      recruitmentStatusLabel: this.formatStatusLabel(job.recruitmentStatus),

      recruitmentStatusBadgeClass: badgeClass?.[job.recruitmentStatus] || DEFAULT_BADGE_CLASS,

      publicationStatus: job.publicationStatus || null,

      publicationStatusLabel: this.formatStatusLabel(job.publicationStatus),

      publicationStatusBadgeClass: badgeClass?.[job.publicationStatus] || DEFAULT_BADGE_CLASS,

      branch,

      detailsUrl: id ? `${EMPLOYER_JOBS_URL}/${id}` : null,

      applicationsUrl: id ? `${EMPLOYER_JOBS_URL}/${id}/applications` : null,
    };
  }

  static buildAdminJobView(job) {
    if (!job) {
      return null;
    }

    const employerView = this.buildEmployerJobView(job);

    if (!employerView) {
      return null;
    }

    const id = employerView.id;

    return {
      ...employerView,

      detailsUrl: id ? `${ADMIN_JOBS_URL}/${id}` : null,

      applicationsUrl: id
        ? this.buildAdminApplicationsUrl({
            jobId: id,
          })
        : null,
    };
  }

  static buildPublicationListingView(publication, { includeScreeningCriteria = false } = {}) {
    if (!publication) {
      return null;
    }

    const publicationId = this.toId(publication);

    const jobId = this.toId(publication.job);

    const snapshot =
      publication.listingSnapshot && typeof publication.listingSnapshot === "object"
        ? publication.listingSnapshot
        : {};

    const safeSnapshot = this.buildSafeListingSnapshot(snapshot, {
      includeScreeningCriteria,
    });

    const employer = this.buildEmployerSnapshotView(publication.employerSnapshot);

    const locationLabel = [safeSnapshot.address, safeSnapshot.lga, safeSnapshot.state]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", ");

    return {
      publicationId,

      jobId,

      status: publication.status || null,

      statusLabel: this.formatStatusLabel(publication.status),

      statusBadgeClass: badgeClass?.[publication.status] || DEFAULT_BADGE_CLASS,

      employer,

      roleTitle: safeSnapshot.roleTitle || null,

      professionalType: safeSnapshot.professionalType || null,

      professionalTypeLabel: this.formatStatusLabel(safeSnapshot.professionalType),

      specialty: safeSnapshot.specialty || null,

      department: safeSnapshot.department || null,

      employmentType: safeSnapshot.employmentType || null,

      employmentTypeLabel: this.formatStatusLabel(safeSnapshot.employmentType),

      workplaceType: safeSnapshot.workplaceType || null,

      workplaceTypeLabel: this.formatStatusLabel(safeSnapshot.workplaceType),

      state: safeSnapshot.state || null,

      lga: safeSnapshot.lga || null,

      address: safeSnapshot.address || null,

      locationLabel: locationLabel || null,

      applicationDeadline: publication.applicationDeadline || null,

      applicationDeadlineDisplay: this.formatDate(publication.applicationDeadline),

      publishedAt: publication.publishedAt || null,

      publishedAtDisplay: this.formatDateTime(publication.publishedAt),

      expiresAt: publication.expiresAt || null,

      expiresAtDisplay: this.formatDateTime(publication.expiresAt),

      listingSnapshot: safeSnapshot,

      marketplaceUrl: publicationId ? `${MARKETPLACE_JOBS_URL}/${publicationId}` : null,
    };
  }

  /* ─────────────────────────────── CANDIDATE ─────────────────────────────── */

  static buildCandidateName(application) {
    const snapshot = application?.candidateSnapshot || {};

    const professional = application?.professional || null;

    const user = professional?.user || null;

    const snapshotDisplayName = String(snapshot.displayName || snapshot.name || "").trim();

    if (snapshotDisplayName) {
      return snapshotDisplayName;
    }

    const snapshotFullName = [snapshot.firstName, snapshot.lastName]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ");

    if (snapshotFullName) {
      return snapshotFullName;
    }

    const userDisplayName = String(user?.displayName || "").trim();

    if (userDisplayName) {
      return userDisplayName;
    }

    return (
      [user?.firstName, user?.lastName]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ") || "Professional"
    );
  }

  static buildCandidateView(application) {
    if (!application) {
      return null;
    }

    const snapshot = this.buildCandidateSnapshotView(application.candidateSnapshot) || {};

    const professional = application.professional || null;

    const user = professional?.user || null;

    const name = this.buildCandidateName(application);

    const currentCertifications = this.buildCertificationList(professional?.certifications);

    const snapshotCertifications = this.buildCertificationList(snapshot.certifications);

    const professionalType = snapshot.professionalType || professional?.type || null;

    const specialty = snapshot.specialty || professional?.specialty || null;

    const yearsOfExperience = this.toFiniteNumber(
      snapshot.yearsOfExperience ?? professional?.yearsOfExperience,
      null
    );

    const state = snapshot.state || professional?.state || null;

    const lga = snapshot.lga || professional?.lga || null;

    const locationLabel = [lga, state]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", ");

    return {
      professionalId: this.toId(professional || application.professional),

      userId: this.toId(user),

      name,

      avatar: {
        photo: snapshot.photo || user?.photo || null,

        initials: this.buildInitials(name),

        alt: name,
      },

      email: snapshot.email || null,

      professionalType,

      professionalTypeLabel: this.formatStatusLabel(professionalType),

      specialty,

      bio: snapshot.bio || professional?.bio || null,

      yearsOfExperience,

      state,

      lga,

      locationLabel: locationLabel || null,

      tier: professional?.tier || null,

      tierLabel: this.formatStatusLabel(professional?.tier),

      averageRating: this.toFiniteNumber(professional?.averageRating, null),

      totalReviews: this.toNonNegativeSafeInteger(professional?.totalReviews, 0),

      reliabilityScore: this.toFiniteNumber(professional?.reliabilityScore, null),

      totalShiftsCompleted: this.toNonNegativeSafeInteger(professional?.totalShiftsCompleted, 0),

      licenceVerificationStatus:
        professional?.licenceVerificationStatus || snapshot.licenceVerificationStatus || null,

      licenceVerificationStatusLabel: this.formatStatusLabel(
        professional?.licenceVerificationStatus || snapshot.licenceVerificationStatus
      ),

      licenceVerificationBadgeClass:
        badgeClass?.[
          professional?.licenceVerificationStatus || snapshot.licenceVerificationStatus
        ] || DEFAULT_BADGE_CLASS,

      licenceExpiryDate: professional?.licenceExpiryDate || snapshot.licenceExpiryDate || null,

      licenceExpiryDateDisplay: this.formatDate(
        professional?.licenceExpiryDate || snapshot.licenceExpiryDate
      ),

      identityVerificationStatus:
        professional?.identityVerificationStatus || snapshot.identityVerificationStatus || null,

      identityVerificationStatusLabel: this.formatStatusLabel(
        professional?.identityVerificationStatus || snapshot.identityVerificationStatus
      ),

      identityVerificationBadgeClass:
        badgeClass?.[
          professional?.identityVerificationStatus || snapshot.identityVerificationStatus
        ] || DEFAULT_BADGE_CLASS,

      certifications:
        currentCertifications.length > 0 ? currentCertifications : snapshotCertifications,

      candidateSnapshot: snapshot,

      currentProfile: professional
        ? {
            professionalType: professional.type || null,

            specialty: professional.specialty || null,

            bio: professional.bio || null,

            yearsOfExperience: this.toFiniteNumber(professional.yearsOfExperience, null),

            state: professional.state || null,

            lga: professional.lga || null,

            tier: professional.tier || null,

            averageRating: this.toFiniteNumber(professional.averageRating, null),

            totalReviews: this.toNonNegativeSafeInteger(professional.totalReviews, 0),

            reliabilityScore: this.toFiniteNumber(professional.reliabilityScore, null),

            totalShiftsCompleted: this.toNonNegativeSafeInteger(
              professional.totalShiftsCompleted,
              0
            ),

            licenceVerificationStatus: professional.licenceVerificationStatus || null,

            licenceExpiryDate: professional.licenceExpiryDate || null,

            identityVerificationStatus: professional.identityVerificationStatus || null,

            certifications: currentCertifications,
          }
        : null,
    };
  }

  /* ─────────────────────────────── TIMELINE / AUDIT ─────────────────────────────── */

  static buildStatusHistoryView(application, { includeInternal = false } = {}) {
    const history = Array.isArray(application?.statusHistory) ? application.statusHistory : [];

    return history.map((entry, index) => {
      const fromStatus = entry?.fromStatus || null;

      const toStatus = entry?.toStatus || entry?.status || null;

      const occurredAt = entry?.changedAt || entry?.at || entry?.createdAt || null;

      const item = {
        key: `${toStatus || "status"}-${index}`,

        fromStatus,

        fromStatusLabel: this.formatStatusLabel(fromStatus),

        status: toStatus,

        toStatus,

        statusLabel: this.formatStatusLabel(toStatus),

        toStatusLabel: this.formatStatusLabel(toStatus),

        statusBadgeClass: this.getApplicationStatusBadgeClass(toStatus),

        occurredAt,

        occurredAtDisplay: this.formatDateTime(occurredAt),
      };

      if (includeInternal) {
        item.actorRole = entry?.actorRole || null;

        item.actorRoleLabel = this.formatStatusLabel(entry?.actorRole);

        item.changedBy = this.toId(entry?.changedBy || entry?.user || entry?.actor);

        item.note = entry?.note || entry?.statusNote || null;
      }

      return item;
    });
  }

  static buildAuditView(application, { includeInternal = false } = {}) {
    if (!application) {
      return null;
    }

    const submittedAt = application.submittedAt || application.createdAt || null;

    const audit = {
      submittedAt,

      submittedAtDisplay: this.formatDateTime(submittedAt),

      statusUpdatedAt: application.statusUpdatedAt || null,

      statusUpdatedAtDisplay: this.formatDateTime(application.statusUpdatedAt),

      offeredAt: application.offeredAt || null,

      offeredAtDisplay: this.formatDateTime(application.offeredAt),

      hiredAt: application.hiredAt || null,

      hiredAtDisplay: this.formatDateTime(application.hiredAt),

      rejectedAt: application.rejectedAt || null,

      rejectedAtDisplay: this.formatDateTime(application.rejectedAt),

      withdrawnAt: application.withdrawnAt || null,

      withdrawnAtDisplay: this.formatDateTime(application.withdrawnAt),

      statusHistory: this.buildStatusHistoryView(application, {
        includeInternal,
      }),
    };

    if (includeInternal) {
      audit.offeredBy = this.toId(application.offeredBy);

      audit.hiredBy = this.toId(application.hiredBy);

      audit.rejectedBy = this.toId(application.rejectedBy);

      audit.withdrawnBy = this.toId(application.withdrawnBy);
    }

    return audit;
  }

  /* ─────────────────────────────── APPLICATION ─────────────────────────────── */

  static buildEmployerApplicationView(application, canManageApplications = false) {
    if (!application) {
      return null;
    }

    const id = this.toId(application);

    const status = application.status || null;

    const job = this.buildEmployerJobView(application.job);

    const publication = this.buildPublicationListingView(application.publication, {
      includeScreeningCriteria: true,
    });

    const candidate = this.buildCandidateView(application);

    const resume = this.buildResumeView(application.resumeSnapshot);

    const statusHistory = Array.isArray(application.statusHistory) ? application.statusHistory : [];

    const latestStatusEntry =
      statusHistory.length > 0 ? statusHistory[statusHistory.length - 1] : null;

    const screeningAnswers = this.buildScreeningAnswersView(application.screeningAnswers, {
      includeEvaluation: true,
    });

    return {
      id,

      status,

      statusLabel: this.formatStatusLabel(status),

      statusBadgeClass: this.getApplicationStatusBadgeClass(status),

      job,

      publication,

      candidate,

      coverNote: application.coverNote || null,

      resume,

      resumeSnapshot: resume,

      screeningOutcome: application.screeningOutcome || null,

      screeningOutcomeLabel: this.formatStatusLabel(application.screeningOutcome),

      screeningSummary:
        application.screeningSummary && typeof application.screeningSummary === "object"
          ? {
              requiredCriteriaCount: this.toNonNegativeSafeInteger(
                application.screeningSummary.requiredCriteriaCount,
                0
              ),

              requiredCriteriaMetCount: this.toNonNegativeSafeInteger(
                application.screeningSummary.requiredCriteriaMetCount,
                0
              ),

              preferredCriteriaCount: this.toNonNegativeSafeInteger(
                application.screeningSummary.preferredCriteriaCount,
                0
              ),

              preferredCriteriaMetCount: this.toNonNegativeSafeInteger(
                application.screeningSummary.preferredCriteriaMetCount,
                0
              ),

              evaluatedAt: application.screeningSummary.evaluatedAt || null,

              evaluatedAtDisplay: this.formatDateTime(application.screeningSummary.evaluatedAt),
            }
          : null,

      screeningAnswers,

      employerPrivateNote: application.employerPrivateNote || null,

      statusNote: latestStatusEntry?.note || null,

      rejection: {
        reason: application.rejectionReason || null,

        reasonLabel: this.formatStatusLabel(application.rejectionReason),

        details: application.rejectionReasonDetails || null,
      },

      withdrawal: {
        reason: application.withdrawalReason || null,

        reasonLabel: this.formatStatusLabel(application.withdrawalReason),

        details: application.withdrawalReasonDetails || null,
      },

      audit: this.buildAuditView(application, {
        includeInternal: true,
      }),

      actions: this.buildEmployerApplicationActions(application, canManageApplications),

      detailsUrl: id ? `${EMPLOYER_APPLICATIONS_URL}/${id}` : null,
    };
  }

  static buildAdminApplicationView(application) {
    if (!application) {
      return null;
    }

    const employerView = this.buildEmployerApplicationView(application, false);

    if (!employerView) {
      return null;
    }

    const id = employerView.id;

    const { employerPrivateNote, ...safeView } = employerView;

    return {
      ...safeView,

      job: this.buildAdminJobView(application.job),

      actions: {
        canManage: false,
        managementItems: [],
        hasManagementActions: false,
      },

      detailsUrl: id ? `${ADMIN_APPLICATIONS_URL}/${id}` : null,
    };
  }

  static buildProfessionalApplicationView(application) {
    if (!application) {
      return null;
    }

    const id = this.toId(application);

    const status = application.status || null;

    const publication = this.buildPublicationListingView(application.publication, {
      includeScreeningCriteria: false,
    });

    const resume = this.buildResumeView(application.resumeSnapshot);

    return {
      id,

      status,

      statusLabel: this.formatStatusLabel(status),

      statusBadgeClass: this.getApplicationStatusBadgeClass(status),

      publication,

      candidateSnapshot: this.buildCandidateSnapshotView(application.candidateSnapshot),

      resume,

      resumeSnapshot: resume,

      coverNote: application.coverNote || null,

      screeningAnswers: this.buildScreeningAnswersView(application.screeningAnswers, {
        includeEvaluation: false,
      }),

      rejection: {
        reason: application.rejectionReason || null,

        reasonLabel: this.formatStatusLabel(application.rejectionReason),

        details: application.rejectionReasonDetails || null,
      },

      withdrawal: {
        reason: application.withdrawalReason || null,

        reasonLabel: this.formatStatusLabel(application.withdrawalReason),

        details: application.withdrawalReasonDetails || null,
      },

      audit: this.buildAuditView(application),

      actions: this.buildProfessionalApplicationActions(application),

      detailsUrl: id ? `${PROFESSIONAL_APPLICATIONS_URL}/${id}` : null,
    };
  }

  /* ─────────────────────────────── ACTIONS ─────────────────────────────── */

  static buildActionFields(fieldNames = []) {
    return (Array.isArray(fieldNames) ? fieldNames : [])
      .map((fieldName) => ACTION_FIELD_PRESENTATION[fieldName] || null)
      .filter(Boolean)
      .map((field) => ({
        ...field,
      }));
  }

  static buildEmployerApplicationActions(application, canManageApplications = false) {
    const applicationId = this.toId(application);

    const status = application?.status || null;

    const managementItems = Object.values(EMPLOYER_ACTION_PRESENTATION)
      .filter((action) => this.canTransition(status, action.targetStatus))
      .map((action) => ({
        key: action.key,

        targetStatus: action.targetStatus,

        label: action.label,

        method: action.method,

        buttonClass: action.buttonClass,

        icon: action.icon,

        url: this.buildEmployerActionUrl(applicationId, action.routeSuffix),

        modalTitle: action.modalTitle,

        confirmLabel: action.confirmLabel,

        confirmButtonClass: action.confirmButtonClass,

        fields: this.buildActionFields(action.fields),

        notice: action.notice
          ? {
              ...action.notice,
            }
          : null,
      }));

    return {
      canManage: canManageApplications === true,

      managementItems: canManageApplications === true ? managementItems : [],

      hasManagementActions: canManageApplications === true && managementItems.length > 0,
    };
  }

  static buildProfessionalApplicationActions(application) {
    const applicationId = this.toId(application);

    const status = application?.status || null;

    const canWithdraw = this.canTransition(status, "withdrawn");

    return {
      canWithdraw,

      items: canWithdraw
        ? [
            {
              key: "withdraw",

              label: "Withdraw application",

              method: "POST",

              buttonClass: "btn-light-danger",

              icon: "ki-cross-circle",

              url: applicationId
                ? `${PROFESSIONAL_APPLICATIONS_URL}/${applicationId}/withdraw`
                : null,

              modalTitle: "Withdraw application",

              confirmLabel: "Withdraw application",

              confirmButtonClass: "btn-danger",
            },
          ]
        : [],
    };
  }

  /* ─────────────────────────────── FILTERS ─────────────────────────────── */

  static buildStatusFilters({ counts = {}, selectedStatus = "all", buildUrl }) {
    const orderedStatuses = [
      "all",

      ...APPLICATION_STATUS_ORDER.filter((status) => JOB_APPLICATION_STATUSES.includes(status)),

      ...JOB_APPLICATION_STATUSES.filter((status) => !APPLICATION_STATUS_ORDER.includes(status)),
    ];

    return [...new Set(orderedStatuses)].map((status) => ({
      key: status,

      label: status === "all" ? "All" : this.formatStatusLabel(status) || status,

      count: this.toNonNegativeSafeInteger(counts?.[status], 0),

      isActive: status === selectedStatus,

      url: buildUrl(status),
    }));
  }

  /* ─────────────────────────────── PAGINATION ─────────────────────────────── */

  static buildPaginationView({ pagination, buildUrl, emptyText }) {
    const currentPage = this.toNonNegativeSafeInteger(pagination?.currentPage, 1) || 1;

    const totalPages = this.toNonNegativeSafeInteger(pagination?.totalPages, 1) || 1;

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

  static buildEmployerApplicationsPageView(pageData = {}) {
    const {
      employer = null,

      applications = [],

      focusedJob = null,

      selectedStatus = "all",

      selectedJobId = null,

      statusCounts = {},

      canViewApplications = true,

      canManageApplications = false,

      pagination = {},
    } = pageData;

    const applicationViews = (Array.isArray(applications) ? applications : [])
      .map((application) => this.buildEmployerApplicationView(application, canManageApplications))
      .filter(Boolean);

    const focusedJobView = this.buildEmployerJobView(focusedJob);

    const effectiveJobId = selectedJobId || focusedJobView?.id || null;

    const statusFilters = this.buildStatusFilters({
      counts: statusCounts,

      selectedStatus,

      buildUrl: (status) =>
        this.buildEmployerApplicationsUrl({
          status,

          jobId: effectiveJobId,
        }),
    });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No applications match the current filters.",

      buildUrl: (page) =>
        this.buildEmployerApplicationsUrl({
          status: selectedStatus,

          jobId: effectiveJobId,

          page,
        }),
    });

    const hasFilters = selectedStatus !== "all";

    const activeApplicationCount = APPLICATION_STATUS_ORDER.filter(
      (status) => !["hired", "rejected", "withdrawn"].includes(status)
    ).reduce(
      (total, status) => total + this.toNonNegativeSafeInteger(statusCounts?.[status], 0),
      0
    );

    return {
      pageTitle: focusedJobView?.roleTitle
        ? `${focusedJobView.roleTitle} Applications`
        : PAGE_COPY.employerTitle,

      employer,

      focusedJob: focusedJobView,

      isFocusedJobView: Boolean(focusedJobView),

      applications: applicationViews,

      hasApplications: applicationViews.length > 0,

      summary: {
        visibleApplicationCount: applicationViews.length,

        totalFilteredApplications: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        activeApplicationCount,

        submittedCount: this.toNonNegativeSafeInteger(statusCounts?.submitted, 0),

        shortlistedCount: this.toNonNegativeSafeInteger(statusCounts?.shortlisted, 0),

        interviewCount: this.toNonNegativeSafeInteger(statusCounts?.interview, 0),

        offeredCount: this.toNonNegativeSafeInteger(statusCounts?.offered, 0),

        hiredCount: this.toNonNegativeSafeInteger(statusCounts?.hired, 0),
      },

      filters: {
        status: statusFilters,

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: this.buildEmployerApplicationsUrl({
            jobId: effectiveJobId,
          }),
        },
      },

      permissions: {
        canViewApplications: canViewApplications === true,

        canManageApplications: canManageApplications === true,

        readOnly: canViewApplications === true && canManageApplications !== true,
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

      resultsHeader: {
        title: "Applications",

        subtitle: paginationView.resultsText,
      },

      pagination: paginationView,

      emptyState: {
        visible: applicationViews.length === 0,

        icon: "ki-people",

        title: PAGE_COPY.noEmployerApplicationsTitle,

        message: hasFilters
          ? "No permanent Job applications match the current filters."
          : focusedJobView
            ? "No professionals have applied for this Job yet."
            : "No permanent Job applications are available yet.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: this.buildEmployerApplicationsUrl({
            jobId: effectiveJobId,
          }),
        },
      },

      actionModal: {
        id: "jobApplicationActionModal",

        formId: "jobApplicationActionForm",

        titleId: "jobApplicationActionModalLabel",

        fieldsContainerId: "jobApplicationActionFields",

        alertId: "jobApplicationActionAlert",

        noticeId: "jobApplicationActionNotice",

        actionTypeInputId: "jobApplicationActionType",

        actionUrlInputId: "jobApplicationActionUrl",

        submitButtonId: "jobApplicationActionSubmit",

        defaultTitle: "Manage application",

        defaultSubmitLabel: "Continue",

        loadingLabel: "Please wait...",

        cancelLabel: "Cancel",
      },

      actions: {
        applicationsUrl: this.buildEmployerApplicationsUrl(),

        jobsUrl: EMPLOYER_JOBS_URL,

        focusedJobUrl: focusedJobView?.detailsUrl || null,
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER DETAIL ─────────────────────────────── */

  static buildEmployerApplicationDetailView(pageData = {}) {
    const {
      employer = null,

      application = null,

      job = null,

      canViewApplications = true,

      canManageApplications = false,
    } = pageData;

    const applicationView = this.buildEmployerApplicationView(application, canManageApplications);

    const jobView = this.buildEmployerJobView(job || application?.job);

    return {
      pageTitle: applicationView?.candidate?.name
        ? `${applicationView.candidate.name} · Application`
        : "Application Details",

      employer,

      application: applicationView,

      job: jobView,

      permissions: {
        canViewApplications: canViewApplications === true,

        canManageApplications: canManageApplications === true,

        readOnly: canViewApplications === true && canManageApplications !== true,
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

      actions: {
        applicationsUrl: this.buildEmployerApplicationsUrl({
          jobId: jobView?.id || null,
        }),

        jobUrl: jobView?.detailsUrl || null,
      },
    };
  }

  /* ─────────────────────────────── ADMIN PAGE ─────────────────────────────── */

  static buildAdminApplicationsPageView(pageData = {}) {
    const {
      selectedEmployer = null,

      applications = [],

      focusedJob = null,

      selectedEmployerProfileId = null,

      selectedStatus = "all",

      selectedJobId = null,

      statusCounts = {},

      canViewApplications = true,

      pagination = {},
    } = pageData;

    const applicationViews = (Array.isArray(applications) ? applications : [])
      .map((application) => this.buildAdminApplicationView(application))
      .filter(Boolean);

    const focusedJobView = this.buildAdminJobView(focusedJob);

    const effectiveJobId = selectedJobId || focusedJobView?.id || null;

    const buildUrl = (overrides = {}) =>
      this.buildAdminApplicationsUrl({
        employerProfileId: Object.prototype.hasOwnProperty.call(overrides, "employerProfileId")
          ? overrides.employerProfileId
          : selectedEmployerProfileId,

        status: overrides.status ?? selectedStatus,

        jobId: Object.prototype.hasOwnProperty.call(overrides, "jobId")
          ? overrides.jobId
          : effectiveJobId,

        page: overrides.page ?? null,
      });

    const statusFilters = this.buildStatusFilters({
      counts: statusCounts,

      selectedStatus,

      buildUrl: (status) =>
        buildUrl({
          status,
          page: 1,
        }),
    });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No applications match the current filters.",

      buildUrl: (page) =>
        buildUrl({
          page,
        }),
    });

    const hasFilters = Boolean(
      selectedEmployerProfileId || selectedStatus !== "all" || effectiveJobId
    );

    const activeApplicationCount = APPLICATION_STATUS_ORDER.filter(
      (status) => !["hired", "rejected", "withdrawn"].includes(status)
    ).reduce(
      (total, status) => total + this.toNonNegativeSafeInteger(statusCounts?.[status], 0),
      0
    );

    return {
      pageTitle: focusedJobView?.roleTitle
        ? `${focusedJobView.roleTitle} Applications`
        : PAGE_COPY.adminTitle,

      selectedEmployer,

      focusedJob: focusedJobView,

      isFocusedJobView: Boolean(focusedJobView),

      applications: applicationViews,

      hasApplications: applicationViews.length > 0,

      summary: {
        visibleApplicationCount: applicationViews.length,

        totalFilteredApplications: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        activeApplicationCount,

        submittedCount: this.toNonNegativeSafeInteger(statusCounts?.submitted, 0),

        shortlistedCount: this.toNonNegativeSafeInteger(statusCounts?.shortlisted, 0),

        interviewCount: this.toNonNegativeSafeInteger(statusCounts?.interview, 0),

        offeredCount: this.toNonNegativeSafeInteger(statusCounts?.offered, 0),

        hiredCount: this.toNonNegativeSafeInteger(statusCounts?.hired, 0),
      },

      filters: {
        employer: {
          value: selectedEmployerProfileId || null,

          selectedEmployer,

          clearUrl: selectedEmployerProfileId
            ? buildUrl({
                employerProfileId: null,

                page: 1,
              })
            : null,
        },

        job: {
          value: effectiveJobId,

          focusedJob: focusedJobView,

          clearUrl: effectiveJobId
            ? buildUrl({
                jobId: null,

                page: 1,
              })
            : null,
        },

        status: statusFilters,

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: ADMIN_APPLICATIONS_URL,
        },
      },

      permissions: {
        canViewApplications: canViewApplications === true,

        canManageApplications: false,

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
        title: "Applications",

        subtitle: paginationView.resultsText,
      },

      pagination: paginationView,

      emptyState: {
        visible: applicationViews.length === 0,

        icon: "ki-people",

        title: PAGE_COPY.noAdminApplicationsTitle,

        message: hasFilters
          ? "No permanent Job applications match the current filters."
          : "No permanent Job applications are available yet.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: ADMIN_APPLICATIONS_URL,
        },
      },

      actions: {
        applicationsUrl: ADMIN_APPLICATIONS_URL,

        jobsUrl: ADMIN_JOBS_URL,

        focusedJobUrl: focusedJobView?.detailsUrl || null,
      },
    };
  }

  /* ─────────────────────────────── ADMIN DETAIL ─────────────────────────────── */

  static buildAdminApplicationDetailView(pageData = {}) {
    const {
      employer = null,

      application = null,

      job = null,

      canViewApplications = true,
    } = pageData;

    const applicationView = this.buildAdminApplicationView(application);

    const jobView = this.buildAdminJobView(job || application?.job);

    return {
      pageTitle: applicationView?.candidate?.name
        ? `${applicationView.candidate.name} · Application`
        : "Application Details",

      employer,

      application: applicationView,

      job: jobView,

      permissions: {
        canViewApplications: canViewApplications === true,

        canManageApplications: false,

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
        applicationsUrl: ADMIN_APPLICATIONS_URL,

        jobUrl: jobView?.detailsUrl || null,
      },
    };
  }

  /* ─────────────────────────────── PROFESSIONAL PAGE ─────────────────────────────── */

  static buildProfessionalApplicationsPageView(pageData = {}) {
    const {
      professional = null,

      applications = [],

      selectedStatus = "all",

      statusCounts = {},

      pagination = {},
    } = pageData;

    const applicationViews = (Array.isArray(applications) ? applications : [])
      .map((application) => this.buildProfessionalApplicationView(application))
      .filter(Boolean);

    const statusFilters = this.buildStatusFilters({
      counts: statusCounts,

      selectedStatus,

      buildUrl: (status) =>
        this.buildProfessionalApplicationsUrl({
          status,
        }),
    });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No applications match the current filters.",

      buildUrl: (page) =>
        this.buildProfessionalApplicationsUrl({
          status: selectedStatus,

          page,
        }),
    });

    const hasFilters = selectedStatus !== "all";

    return {
      pageTitle: PAGE_COPY.professionalTitle,

      professional,

      applications: applicationViews,

      hasApplications: applicationViews.length > 0,

      summary: {
        visibleApplicationCount: applicationViews.length,

        totalFilteredApplications: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        submittedCount: this.toNonNegativeSafeInteger(statusCounts?.submitted, 0),

        shortlistedCount: this.toNonNegativeSafeInteger(statusCounts?.shortlisted, 0),

        interviewCount: this.toNonNegativeSafeInteger(statusCounts?.interview, 0),

        offeredCount: this.toNonNegativeSafeInteger(statusCounts?.offered, 0),

        hiredCount: this.toNonNegativeSafeInteger(statusCounts?.hired, 0),
      },

      filters: {
        status: statusFilters,

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: PROFESSIONAL_APPLICATIONS_URL,
        },
      },

      resultsHeader: {
        title: "Applications",

        subtitle: paginationView.resultsText,
      },

      pagination: paginationView,

      emptyState: {
        visible: applicationViews.length === 0,

        icon: "ki-document",

        title: PAGE_COPY.noProfessionalApplicationsTitle,

        message: hasFilters
          ? "No applications match the current filters."
          : "Jobs you apply for will appear here.",

        action: {
          visible: !hasFilters,

          label: "Browse Jobs",

          buttonClass: "btn-light-primary",

          url: MARKETPLACE_JOBS_URL,
        },

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: PROFESSIONAL_APPLICATIONS_URL,
        },
      },

      actions: {
        applicationsUrl: PROFESSIONAL_APPLICATIONS_URL,

        marketplaceUrl: MARKETPLACE_JOBS_URL,
      },
    };
  }

  /* ─────────────────────────────── PROFESSIONAL DETAIL ─────────────────────────────── */

  static buildProfessionalApplicationDetailView(pageData = {}) {
    const {
      professional = null,

      application = null,
    } = pageData;

    const applicationView = this.buildProfessionalApplicationView(application);

    return {
      pageTitle: applicationView?.publication?.roleTitle || "Application Details",

      professional,

      application: applicationView,

      actions: {
        applicationsUrl: PROFESSIONAL_APPLICATIONS_URL,

        marketplaceUrl: MARKETPLACE_JOBS_URL,

        listingUrl: applicationView?.publication?.marketplaceUrl || null,
      },
    };
  }
}

module.exports = JobApplicationViewService;
