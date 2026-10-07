// services/jobs/jobViewService.js

const { badgeClass, formatStatus } = require("../../utils/statusHelper");

const Job = require("../../models/Job");

const {
  JOB_EMPLOYMENT_TYPES,
  JOB_WORKPLACE_TYPES,
  JOB_COMPENSATION_TYPES,
  JOB_SALARY_PERIODS,
  JOB_SCREENING_QUESTION_TYPES,
  JOB_SCREENING_REQUIREMENT_LEVELS,
  MAX_JOB_TITLE_LENGTH,
  MAX_JOB_SUMMARY_LENGTH,
  MAX_JOB_DESCRIPTION_LENGTH,
  MAX_JOB_SECTION_LENGTH,
  MAX_SCREENING_QUESTION_LENGTH,
  MAX_SCREENING_OPTION_LENGTH,
} = require("../../constants/jobPosting");

const EMPLOYER_JOBS_URL = "/employer/jobs";
const ADMIN_JOBS_URL = "/admin/jobs";
const MARKETPLACE_JOBS_URL = "/jobs";
const PROFESSIONAL_SAVED_JOBS_URL = "/professional/jobs/saved";
const PROFESSIONAL_JOB_PUBLICATIONS_URL = "/professional/job-publications";

const DEFAULT_BADGE_CLASS = "badge-light-secondary";

const PAGE_COPY = Object.freeze({
  employerJobsTitle: "Permanent Jobs",
  adminJobsTitle: "Permanent Jobs",
  marketplaceTitle: "Jobs",
  savedJobsTitle: "Saved Jobs",

  noEmployerJobsTitle: "No Jobs found",
  noAdminJobsTitle: "No Jobs found",
  noMarketplaceJobsTitle: "No Jobs found",
  noSavedJobsTitle: "No saved Jobs",

  clearFiltersLabel: "Clear filters",

  readOnlyTitle: "Read-only access",
  readOnlyMessage:
    "You can view permanent Jobs in your authorized branch scope, but Job-management actions are unavailable for your role.",

  adminReadOnlyTitle: "Platform oversight",
  adminReadOnlyMessage:
    "This workspace provides platform oversight. Employer recruitment decisions remain with the employer.",
});

class JobViewService {
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

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    return Number.isNaN(currentTime.getTime()) ? new Date() : currentTime;
  }

  static formatStatusLabel(value) {
    return value ? formatStatus(String(value)) : null;
  }

  static getStatusBadgeClass(status) {
    return status ? badgeClass?.[status] || DEFAULT_BADGE_CLASS : DEFAULT_BADGE_CLASS;
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

  static buildLocationLabel({ address = null, lga = null, state = null } = {}) {
    const parts = [address, lga, state].map((value) => String(value || "").trim()).filter(Boolean);

    return parts.length ? parts.join(", ") : null;
  }

  static buildDeadlineView(applicationDeadline, currentTime = new Date()) {
    if (!applicationDeadline) {
      return {
        value: null,
        display: "No application deadline",
        hasDeadline: false,
        hasPassed: false,
        daysRemaining: null,
        urgency: null,
      };
    }

    const deadline = new Date(applicationDeadline);
    const now = this.normalizeCurrentTime(currentTime);

    if (Number.isNaN(deadline.getTime())) {
      return {
        value: applicationDeadline,
        display: "-",
        hasDeadline: true,
        hasPassed: false,
        daysRemaining: null,
        urgency: null,
      };
    }

    const millisecondsRemaining = deadline.getTime() - now.getTime();

    const hasPassed = millisecondsRemaining < 0;

    const daysRemaining = hasPassed ? 0 : Math.ceil(millisecondsRemaining / (24 * 60 * 60 * 1000));

    let urgency = "normal";

    if (hasPassed) {
      urgency = "passed";
    } else if (daysRemaining <= 3) {
      urgency = "urgent";
    } else if (daysRemaining <= 7) {
      urgency = "soon";
    }

    return {
      value: deadline,
      display: this.formatDate(deadline),
      hasDeadline: true,
      hasPassed,
      daysRemaining,
      urgency,
    };
  }

  static buildPublicationTimingView(publication, currentTime = new Date()) {
    if (!publication) {
      return null;
    }

    const now = this.normalizeCurrentTime(currentTime);

    const expiresAt = publication.expiresAt ? new Date(publication.expiresAt) : null;

    const hasValidExpiry = expiresAt && !Number.isNaN(expiresAt.getTime());

    const hasExpiredByTime = hasValidExpiry ? expiresAt <= now : false;

    return {
      publishedAt: publication.publishedAt || null,
      publishedAtDisplay: this.formatDateTime(publication.publishedAt),

      expiresAt: publication.expiresAt || null,
      expiresAtDisplay: this.formatDateTime(publication.expiresAt),

      hasExpiredByTime,

      deadline: this.buildDeadlineView(publication.applicationDeadline, now),
    };
  }

  static buildPaginationView({ pagination, buildUrl, emptyText }) {
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

  /* ─────────────────────────────── URL BUILDERS ─────────────────────────────── */

  static buildEmployerJobsUrl({
    recruitmentStatus = "all",
    publicationStatus = "all",
    branchId = null,
    search = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (recruitmentStatus && recruitmentStatus !== "all") {
      params.set("recruitmentStatus", recruitmentStatus);
    }

    if (publicationStatus && publicationStatus !== "all") {
      params.set("publicationStatus", publicationStatus);
    }

    if (branchId) {
      params.set("branch", String(branchId));
    }

    if (search) {
      params.set("search", String(search));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${EMPLOYER_JOBS_URL}?${query}` : EMPLOYER_JOBS_URL;
  }

  static buildAdminJobsUrl({
    employerProfileId = null,
    recruitmentStatus = "all",
    publicationStatus = "all",
    branchId = null,
    search = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (employerProfileId) {
      params.set("employer", String(employerProfileId));
    }

    if (recruitmentStatus && recruitmentStatus !== "all") {
      params.set("recruitmentStatus", recruitmentStatus);
    }

    if (publicationStatus && publicationStatus !== "all") {
      params.set("publicationStatus", publicationStatus);
    }

    if (branchId) {
      params.set("branch", String(branchId));
    }

    if (search) {
      params.set("search", String(search));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${ADMIN_JOBS_URL}?${query}` : ADMIN_JOBS_URL;
  }

  static buildMarketplaceJobsUrl({
    search = null,
    professionalType = "all",
    employmentType = "all",
    workplaceType = "all",
    state = null,
    lga = null,
    page = null,
  } = {}) {
    const params = new URLSearchParams();

    if (search) {
      params.set("search", String(search));
    }

    if (professionalType && professionalType !== "all") {
      params.set("professionalType", professionalType);
    }

    if (employmentType && employmentType !== "all") {
      params.set("employmentType", employmentType);
    }

    if (workplaceType && workplaceType !== "all") {
      params.set("workplaceType", workplaceType);
    }

    if (state) {
      params.set("state", String(state));
    }

    if (lga) {
      params.set("lga", String(lga));
    }

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${MARKETPLACE_JOBS_URL}?${query}` : MARKETPLACE_JOBS_URL;
  }

  static buildSavedJobsUrl({ page = null } = {}) {
    const params = new URLSearchParams();

    if (Number.isSafeInteger(Number(page)) && Number(page) > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();

    return query ? `${PROFESSIONAL_SAVED_JOBS_URL}?${query}` : PROFESSIONAL_SAVED_JOBS_URL;
  }

  /* ─────────────────────────────── GENERIC PRESENTATION ─────────────────────────────── */

  static buildBranchView(branch) {
    if (!branch) {
      return null;
    }

    return {
      id: this.toId(branch),

      name: branch.name || null,

      address: branch.address || null,

      state: branch.state || null,

      lga: branch.lga || null,

      isActive: branch.isActive !== false,

      locationLabel: this.buildLocationLabel(branch),
    };
  }

  static buildStatusView(status) {
    return {
      value: status || null,

      label: this.formatStatusLabel(status),

      badgeClass: this.getStatusBadgeClass(status),
    };
  }

  static buildPublicationView(publication, currentTime = new Date()) {
    if (!publication) {
      return null;
    }

    const id = this.toId(publication);

    const status = publication.status || null;

    const pauseHistory = (
      Array.isArray(publication.pauseHistory) ? publication.pauseHistory : []
    ).map((pause) => ({
      pausedAt: pause?.pausedAt || null,

      pausedAtDisplay: this.formatDateTime(pause?.pausedAt),

      pausedBy: this.toId(pause?.pausedBy),

      resumedAt: pause?.resumedAt || null,

      resumedAtDisplay: this.formatDateTime(pause?.resumedAt),

      resumedBy: this.toId(pause?.resumedBy),

      isActive: Boolean(pause?.pausedAt && !pause?.resumedAt),
    }));

    const latestPause = pauseHistory.length > 0 ? pauseHistory[pauseHistory.length - 1] : null;

    return {
      id,

      jobId: this.toId(publication.job),

      cycleNumber: this.toPositiveSafeInteger(publication.cycleNumber, null),

      status,

      statusLabel: this.formatStatusLabel(status),

      statusBadgeClass: this.getStatusBadgeClass(status),

      timing: this.buildPublicationTimingView(publication, currentTime),

      pauseHistory,

      hasPauseHistory: pauseHistory.length > 0,

      pausedAt: latestPause?.pausedAt || null,

      pausedAtDisplay: latestPause?.pausedAtDisplay || "-",

      resumedAt: latestPause?.resumedAt || null,

      resumedAtDisplay: latestPause?.resumedAtDisplay || "-",

      isCurrentlyPaused: status === "paused" && latestPause?.isActive === true,

      endedAt: publication.endedAt || null,

      endedAtDisplay: this.formatDateTime(publication.endedAt),

      createdAt: publication.createdAt || null,

      createdAtDisplay: this.formatDateTime(publication.createdAt),

      updatedAt: publication.updatedAt || null,

      updatedAtDisplay: this.formatDateTime(publication.updatedAt),
    };
  }

  /* ─────────────────────────────── EMPLOYER JOB ─────────────────────────────── */

  static buildEmployerJobView(job, currentTime = new Date()) {
    if (!job) {
      return null;
    }

    const id = this.toId(job);

    const branch = this.buildBranchView(job.branch);

    const recruitmentStatus = job.recruitmentStatus || null;

    const publicationStatus = job.publicationStatus || null;

    const currentPublication = this.buildPublicationView(job.currentPublication, currentTime);

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

      state: job.state || branch?.state || null,

      lga: job.lga || branch?.lga || null,

      locationLabel:
        this.buildLocationLabel({
          lga: job.lga,
          state: job.state,
        }) ||
        branch?.locationLabel ||
        null,

      branch,

      recruitmentStatus,

      recruitmentStatusLabel: this.formatStatusLabel(recruitmentStatus),

      recruitmentStatusBadgeClass: this.getStatusBadgeClass(recruitmentStatus),

      publicationStatus,

      publicationStatusLabel: this.formatStatusLabel(publicationStatus),

      publicationStatusBadgeClass: this.getStatusBadgeClass(publicationStatus),

      currentPublication,

      createdAt: job.createdAt || null,

      createdAtDisplay: this.formatDateTime(job.createdAt),

      updatedAt: job.updatedAt || null,

      updatedAtDisplay: this.formatDateTime(job.updatedAt),

      detailsUrl: id ? `${EMPLOYER_JOBS_URL}/${id}` : null,

      applicationsUrl: id ? `${EMPLOYER_JOBS_URL}/${id}/applications` : null,
    };
  }

  static buildStatusFilterItems({ counts = {}, selected = "all", key, buildUrl }) {
    const statuses = new Set(["all"]);

    Object.keys(counts || {}).forEach((status) => statuses.add(status));

    if (selected) {
      statuses.add(selected);
    }

    return [...statuses]
      .filter(Boolean)
      .sort((left, right) => {
        if (left === "all") {
          return -1;
        }

        if (right === "all") {
          return 1;
        }

        return String(left).localeCompare(String(right));
      })
      .map((status) => ({
        key: status,

        label: status === "all" ? "All" : this.formatStatusLabel(status) || status,

        count: this.toNonNegativeSafeInteger(counts?.[status], 0),

        isActive: status === selected,

        url: buildUrl({
          [key]: status,
          page: 1,
        }),
      }));
  }

  static buildEmployerJobsPageView(pageData = {}) {
    const {
      employer = null,
      jobs = [],
      branches = [],
      selectedRecruitmentStatus = "all",
      selectedPublicationStatus = "all",
      selectedBranchId = null,
      selectedSearch = null,
      recruitmentStatusCounts = {},
      publicationStatusCounts = {},
      canViewJobs = true,
      canManageJobs = false,
      canViewAllBranches = false,
      canManageAllBranches = false,
      currentTime = new Date(),
      pagination = {},
    } = pageData;

    const jobViews = (Array.isArray(jobs) ? jobs : [])
      .map((job) => this.buildEmployerJobView(job, currentTime))
      .filter(Boolean);

    const buildUrl = (overrides = {}) =>
      this.buildEmployerJobsUrl({
        recruitmentStatus: overrides.recruitmentStatus ?? selectedRecruitmentStatus,

        publicationStatus: overrides.publicationStatus ?? selectedPublicationStatus,

        branchId: Object.prototype.hasOwnProperty.call(overrides, "branchId")
          ? overrides.branchId
          : selectedBranchId,

        search: overrides.search ?? selectedSearch,

        page: overrides.page ?? null,
      });

    const recruitmentFilters = this.buildStatusFilterItems({
      counts: recruitmentStatusCounts,

      selected: selectedRecruitmentStatus,

      key: "recruitmentStatus",

      buildUrl,
    });

    const publicationFilters = this.buildStatusFilterItems({
      counts: publicationStatusCounts,

      selected: selectedPublicationStatus,

      key: "publicationStatus",

      buildUrl,
    });

    const branchFilters = [
      {
        key: "all",

        label: "All branches",

        value: null,

        isActive: !selectedBranchId,

        url: buildUrl({
          branchId: null,
          page: 1,
        }),
      },

      ...(Array.isArray(branches) ? branches : []).map((branch) => ({
        key: this.toId(branch),

        label: branch.name || "Branch",

        value: this.toId(branch),

        isActive: this.toId(branch) === selectedBranchId,

        url: buildUrl({
          branchId: this.toId(branch),

          page: 1,
        }),
      })),
    ];

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No Jobs match the current filters.",

      buildUrl: (page) => buildUrl({ page }),
    });

    const hasFilters = Boolean(
      selectedRecruitmentStatus !== "all" ||
      selectedPublicationStatus !== "all" ||
      selectedBranchId ||
      selectedSearch
    );

    const readOnly = canViewJobs === true && canManageJobs !== true;

    return {
      pageTitle: PAGE_COPY.employerJobsTitle,

      employer,

      jobs: jobViews,

      hasJobs: jobViews.length > 0,

      summary: {
        visibleJobCount: jobViews.length,

        totalFilteredJobs: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),
      },

      filters: {
        recruitment: recruitmentFilters,

        publication: publicationFilters,

        branches: branchFilters,

        search: {
          value: selectedSearch || "",

          name: "search",

          placeholder: "Search Jobs",
        },

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: EMPLOYER_JOBS_URL,
        },
      },

      permissions: {
        canViewJobs: canViewJobs === true,

        canManageJobs: canManageJobs === true,

        canViewAllBranches: canViewAllBranches === true,

        canManageAllBranches: canManageAllBranches === true,

        readOnly,
      },

      readOnlyNotice: readOnly
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

      pagination: paginationView,

      resultsHeader: {
        title: "Jobs",

        subtitle: paginationView.resultsText,
      },

      emptyState: {
        visible: jobViews.length === 0,

        icon: "ki-briefcase",

        title: PAGE_COPY.noEmployerJobsTitle,

        message: hasFilters
          ? "No permanent Jobs match the current filters."
          : "No permanent Jobs have been created yet.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: EMPLOYER_JOBS_URL,
        },
      },

      actions: {
        jobsUrl: EMPLOYER_JOBS_URL,

        createJobUrl: canManageJobs === true ? EMPLOYER_JOBS_URL : null,
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER JOB CREATION ─────────────────────────────── */

  // Presentation only: the controller must first obtain authorized creation data.
  static buildEmployerJobCreatePageView(pageData = {}) {
    const canManageJobs = pageData.canManageJobs === true;

    const branchRequired = pageData.branchRequired === true;

    const branches = (Array.isArray(pageData.branches) ? pageData.branches : [])
      .filter((branch) => branch && branch.isActive === true)
      .map((branch) => this.buildBranchView(branch))
      .filter((branch) => branch?.id);

    const currencyCode = pageData.employer?.currency || null;

    let currency = null;

    if (typeof currencyCode === "string" && /^[A-Z]{3}$/.test(currencyCode)) {
      const formatter = new Intl.NumberFormat("en-NG", {
        style: "currency",
        currency: currencyCode,
      });

      const decimalPlaces = formatter.resolvedOptions().maximumFractionDigits;

      currency = {
        code: currencyCode,

        decimalPlaces,

        minorUnitFactor: 10 ** decimalPlaces,

        inputStep: decimalPlaces === 0 ? "1" : `0.${"0".repeat(decimalPlaces - 1)}1`,

        label: `Salary (${currencyCode})`,
      };
    }

    const options = (values) =>
      values
        .filter((value) => typeof value === "string" && value.length > 0)
        .map((value) => ({
          value,

          label: this.formatStatusLabel(value) || value,
        }));

    const professionalTypes = options(Job.schema.path("professionalType").enumValues);

    const canCreateDraft = Boolean(
      canManageJobs &&
      pageData.canCreateDraft === true &&
      currency &&
      (!branchRequired || branches.length > 0)
    );

    let unavailableMessage = null;

    if (!canManageJobs) {
      unavailableMessage = "You do not have permission to create jobs.";
    } else if (!currency) {
      unavailableMessage =
        "Your business currency is unavailable. Contact support before creating a job.";
    } else if (branchRequired && branches.length === 0) {
      unavailableMessage = "You need an active assigned branch before you can create a job.";
    } else if (!canCreateDraft) {
      unavailableMessage = "Job creation is currently unavailable.";
    }

    return {
      pageTitle: "Create Job",

      employer: {
        id: this.toId(pageData.employer?.id),

        businessName: pageData.employer?.businessName || null,

        countryCode: pageData.employer?.countryCode || null,
      },

      currency,

      branches,

      branchRequired,

      branchPlaceholder: branchRequired ? "Select a branch" : "Choose a branch later",

      branchHelp:
        "A branch is required before publication. The job location comes from that branch.",

      permissions: {
        canManageJobs,

        canCreateDraft,

        canManageAllBranches: pageData.canManageAllBranches === true,
      },

      unavailableMessage,

      options: {
        professionalTypes,

        employmentTypes: options(JOB_EMPLOYMENT_TYPES),

        workplaceTypes: options(JOB_WORKPLACE_TYPES),

        compensationTypes: options(JOB_COMPENSATION_TYPES),

        salaryPeriods: options(JOB_SALARY_PERIODS),

        screeningQuestionTypes: options(JOB_SCREENING_QUESTION_TYPES),

        screeningRequirementLevels: options(JOB_SCREENING_REQUIREMENT_LEVELS),
      },

      limits: {
        roleTitle: MAX_JOB_TITLE_LENGTH,
        specialty: Job.schema.path("specialty").options.maxlength,
        department: Job.schema.path("department").options.maxlength,
        educationRequirement: Job.schema.path("educationRequirement").options.maxlength,
        summary: MAX_JOB_SUMMARY_LENGTH,
        description: MAX_JOB_DESCRIPTION_LENGTH,
        sectionItem: MAX_JOB_SECTION_LENGTH,
        skillItem: 500,
        benefitItem: 1000,
        listItems: 50,
        screeningQuestions: 20,
        screeningPrompt: MAX_SCREENING_QUESTION_LENGTH,
        screeningOption: MAX_SCREENING_OPTION_LENGTH,
      },

      defaults: {
        minimumYearsOfExperience: 0,
        vacancyCount: 1,
        compensationType: "fixed",
        salaryPeriod: "month",
        negotiable: false,
        screeningRequirementLevel: "informational",
        screeningResponseRequired: true,
      },

      draftMessage:
        "Save your progress as a draft. Review publication and payment options separately when the job is ready.",

      screeningHelp:
        "Required criteria can flag an application for review; they do not automatically reject a candidate.",

      actions: {
        jobsUrl: EMPLOYER_JOBS_URL,

        submitUrl: canCreateDraft ? EMPLOYER_JOBS_URL : null,

        submitMethod: "POST",

        submitLabel: "Save draft",
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER JOB EDIT FORM ─────────────────────────────── */

  static buildEmployerJobEditPageView(pageData = {}) {
    const job = pageData.job;

    // Reuse creation options and limits, without treating a retained inactive
    // branch as a new selection. The edit client omits an unchanged branch.
    const form = this.buildEmployerJobCreatePageView({
      ...pageData,
      branchRequired: false,
      canCreateDraft: true,
    });

    const jobId = this.toId(job?._id);
    const currentBranchId = pageData.currentBranchId || null;
    const branchRequired = pageData.branchRequired === true;
    const branchAvailable = Boolean(currentBranchId || form.branches.length > 0 || !branchRequired);
    const currencyChanged = pageData.currencyChanged === true;
    const canSaveChanges = Boolean(
      jobId &&
      pageData.canManageJobs === true &&
      pageData.canSaveChanges === true &&
      form.currency &&
      !currencyChanged &&
      branchAvailable
    );

    let unavailableMessage = null;

    if (!jobId) {
      unavailableMessage = "The job is unavailable.";
    } else if (pageData.canManageJobs !== true) {
      unavailableMessage = "You do not have permission to edit this job.";
    } else if (currencyChanged) {
      unavailableMessage =
        "The business currency has changed since this salary was saved. Contact support to review the salary before editing this job.";
    } else if (!form.currency) {
      unavailableMessage =
        "Your business currency is unavailable. Contact support before editing this job.";
    } else if (!branchAvailable) {
      unavailableMessage = "An active assigned branch is required before you can save this job.";
    } else if (!canSaveChanges) {
      unavailableMessage = "This job is currently unavailable for editing.";
    }

    const text = (value) => (typeof value === "string" ? value : "");
    const list = (value) =>
      Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    const dateISO = (value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    const amountText = (value) => {
      if (!form.currency || currencyChanged || !Number.isSafeInteger(value) || value < 1) return "";
      const decimals = form.currency.decimalPlaces;
      const digits = BigInt(value)
        .toString()
        .padStart(decimals + 1, "0");
      return decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
    };

    const values = {
      branch: currentBranchId || "",
      roleTitle: text(job?.roleTitle),
      professionalType: text(job?.professionalType),
      specialty: text(job?.specialty),
      department: text(job?.department),
      employmentType: text(job?.employmentType),
      workplaceType: text(job?.workplaceType),
      minimumYearsOfExperience: job?.minimumYearsOfExperience ?? "",
      educationRequirement: text(job?.educationRequirement),
      vacancyCount: job?.vacancyCount ?? "",
      summary: text(job?.summary),
      description: text(job?.description),
      employmentStartDate: dateISO(job?.employmentStartDate)?.slice(0, 10) || "",
      // Client converts this instant to device-local datetime-local input. If
      // unchanged, retain this original ISO value to avoid precision loss.
      applicationDeadlineISO: dateISO(job?.applicationDeadline),
      includeCompensation: Boolean(job?.compensation),
      compensationType: job?.compensation?.type || form.defaults.compensationType,
      compensationPeriod: job?.compensation?.period || form.defaults.salaryPeriod,
      minimumAmountDisplay: amountText(job?.compensation?.minimumAmount),
      maximumAmountDisplay: amountText(job?.compensation?.maximumAmount),
      negotiable: job?.compensation?.negotiable === true,
      screeningQuestions: (Array.isArray(job?.screeningQuestions) ? job.screeningQuestions : [])
        .filter(Boolean)
        .map((question) => ({
          _id: this.toId(question._id),
          prompt: text(question.prompt),
          type: text(question.type),
          requirementLevel: text(question.requirementLevel),
          isResponseRequired: question.isResponseRequired === true,
          options: list(question.options),
          acceptableOptions: list(question.acceptableOptions),
          qualifyingBoolean:
            typeof question.qualifyingBoolean === "boolean" ? question.qualifyingBoolean : null,
          minimumNumber: Number.isFinite(question.minimumNumber) ? question.minimumNumber : null,
          maximumNumber: Number.isFinite(question.maximumNumber) ? question.maximumNumber : null,
          requireAllOptions: question.requireAllOptions === true,
        })),
    };

    for (const field of [
      "responsibilities",
      "requirements",
      "preferredQualifications",
      "skills",
      "benefits",
    ]) {
      // Keep arrays intact: stored items may contain embedded line breaks.
      values[field] = list(job?.[field]);
    }

    return {
      ...form,
      pageTitle: "Edit Job",
      mode: "edit",
      jobId,
      referenceCode: job?.referenceCode || null,
      recruitmentStatus: job?.recruitmentStatus || null,
      publicationStatus: job?.publicationStatus || null,
      branchRequired,
      branchPlaceholder: branchRequired ? "Select a branch" : "No branch selected",
      branchHelp:
        "Keep the current branch or choose an accessible active branch. An unchanged branch will be retained.",
      currentBranch: currentBranchId
        ? {
            id: currentBranchId,
            name: job?.branch?.name || "Current branch",
            selectable: pageData.currentBranchIsSelectable === true,
            retainOnly: pageData.currentBranchIsSelectable !== true,
          }
        : null,
      hasPublicationHistory: pageData.hasPublicationHistory === true,
      currencyChanged,
      permissions: {
        canManageJobs: pageData.canManageJobs === true,
        canManageAllBranches: pageData.canManageAllBranches === true,
        canSaveChanges,
      },
      unavailableMessage,
      values,
      draftMessage:
        "Save changes to the job. This does not publish or renew a listing or take payment.",
      actions: {
        jobsUrl: EMPLOYER_JOBS_URL,
        detailsUrl: jobId ? `${EMPLOYER_JOBS_URL}/${jobId}` : null,
        submitUrl: canSaveChanges ? `${EMPLOYER_JOBS_URL}/${jobId}/update` : null,
        submitMethod: "POST",
        submitLabel: "Save changes",
      },
    };
  }

  static buildEmployerJobCompensationView(compensation, currency) {
    if (!compensation) return null;

    const minimum = compensation.minimumAmount;
    const maximum = compensation.maximumAmount;
    const valid =
      typeof currency === "string" &&
      /^[A-Z]{3}$/.test(currency) &&
      Number.isSafeInteger(minimum) &&
      minimum > 0 &&
      Number.isSafeInteger(maximum) &&
      maximum >= minimum &&
      JOB_COMPENSATION_TYPES.includes(compensation.type) &&
      JOB_SALARY_PERIODS.includes(compensation.period) &&
      (compensation.type !== "fixed" || minimum === maximum);

    let minimumDisplay = null;
    let maximumDisplay = null;

    if (valid) {
      const formatter = new Intl.NumberFormat("en-NG", { style: "currency", currency });
      const decimals = formatter.resolvedOptions().maximumFractionDigits;
      const factor = 10n ** BigInt(decimals);

      // Format integer and fractional parts independently to avoid rounding
      // a safe-integer minor amount through floating-point division.
      const formatAmount = (amount) => {
        const units = BigInt(amount);
        const fraction = (units % factor).toString().padStart(decimals, "0");
        return formatter
          .formatToParts(units / factor)
          .map((part) => (part.type === "fraction" ? fraction : part.value))
          .join("");
      };

      minimumDisplay = formatAmount(minimum);
      maximumDisplay = formatAmount(maximum);
    }

    return {
      available: Boolean(valid),
      type: compensation.type || null,
      currency: currency || null,
      minimumAmount: Number.isSafeInteger(minimum) ? minimum : null,
      maximumAmount: Number.isSafeInteger(maximum) ? maximum : null,
      period: compensation.period || null,
      periodLabel: this.formatStatusLabel(compensation.period),
      negotiable: compensation.negotiable === true,
      display: !valid
        ? "Not available"
        : `${compensation.type === "fixed" ? minimumDisplay : `${minimumDisplay} – ${maximumDisplay}`} per ${compensation.period}`,
    };
  }

  static buildEmployerJobContentView(job) {
    if (!job) return null;

    const textList = (value) =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [];

    return {
      summary: job.summary || null,
      description: job.description || null,
      educationRequirement: job.educationRequirement || null,
      minimumYearsOfExperience:
        Number.isSafeInteger(job.minimumYearsOfExperience) && job.minimumYearsOfExperience >= 0
          ? job.minimumYearsOfExperience
          : null,
      vacancyCount: this.toPositiveSafeInteger(job.vacancyCount, null),
      responsibilities: textList(job.responsibilities),
      requirements: textList(job.requirements),
      preferredQualifications: textList(job.preferredQualifications),
      skills: textList(job.skills),
      benefits: textList(job.benefits),
      currency: job.currency || null,
      compensation: this.buildEmployerJobCompensationView(job.compensation, job.currency),
      employmentStartDate: job.employmentStartDate || null,
      employmentStartDateDisplay: this.formatDate(job.employmentStartDate, "UTC"),
      applicationDeadline: job.applicationDeadline || null,
      applicationDeadlineDisplay: this.formatDateTime(job.applicationDeadline, "UTC"),
      applicationDeadlineTimeZone: "UTC",
      screeningQuestions: (Array.isArray(job.screeningQuestions) ? job.screeningQuestions : [])
        .filter(Boolean)
        .map((question) => {
          const criterion = ["preferred", "required"].includes(question.requirementLevel);
          const select = ["single_select", "multi_select"].includes(question.type);
          return {
            id: this.toId(question._id),
            prompt: question.prompt || null,
            type: question.type || null,
            typeLabel: this.formatStatusLabel(question.type),
            requirementLevel: question.requirementLevel || null,
            requirementLevelLabel: this.formatStatusLabel(question.requirementLevel),
            isResponseRequired: question.isResponseRequired === true,
            options: select ? textList(question.options) : [],
            qualifyingBoolean:
              criterion &&
              question.type === "yes_no" &&
              typeof question.qualifyingBoolean === "boolean"
                ? question.qualifyingBoolean
                : null,
            minimumNumber:
              criterion && question.type === "number" && Number.isFinite(question.minimumNumber)
                ? question.minimumNumber
                : null,
            maximumNumber:
              criterion && question.type === "number" && Number.isFinite(question.maximumNumber)
                ? question.maximumNumber
                : null,
            acceptableOptions: criterion && select ? textList(question.acceptableOptions) : [],
            requireAllOptions:
              criterion && question.type === "multi_select" && question.requireAllOptions === true,
          };
        }),
    };
  }

  static buildEmployerJobDetailView(pageData = {}) {
    const {
      employer = null,
      job = null,
      publications = [],
      canViewJobs = true,
      canManageJobs = false,
      canViewAllBranches = false,
      canManageAllBranches = false,
      currentTime = new Date(),
    } = pageData;

    const jobView = this.buildEmployerJobView(job, currentTime);

    const publicationViews = (Array.isArray(publications) ? publications : [])
      .map((publication) => this.buildPublicationView(publication, currentTime))
      .filter(Boolean);

    const readOnly = canViewJobs === true && canManageJobs !== true;

    const editableState =
      (job?.recruitmentStatus === "draft" && job?.publicationStatus === "unpublished") ||
      (job?.recruitmentStatus === "active" &&
        ["expired", "ended"].includes(job?.publicationStatus));

    const canEditJob =
      canViewJobs === true && canManageJobs === true && Boolean(jobView?.id) && editableState;

    return {
      pageTitle: jobView?.roleTitle || "Job Details",

      employer,

      job: jobView ? { ...jobView, ...this.buildEmployerJobContentView(job) } : null,

      publications: publicationViews,

      hasPublicationHistory: publicationViews.length > 0,

      permissions: {
        canViewJobs: canViewJobs === true,

        canManageJobs: canManageJobs === true,

        canEditJob,

        canViewAllBranches: canViewAllBranches === true,

        canManageAllBranches: canManageAllBranches === true,

        readOnly,
      },

      readOnlyNotice: readOnly
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
        jobsUrl: EMPLOYER_JOBS_URL,

        editUrl: canEditJob ? `${EMPLOYER_JOBS_URL}/${jobView.id}/edit` : null,

        applicationsUrl: jobView?.applicationsUrl || null,
      },
    };
  }

  /* ─────────────────────────────── ADMIN JOB OVERSIGHT ─────────────────────────────── */

  static buildAdminEmployerView(employer) {
    if (!employer || typeof employer !== "object") {
      return null;
    }

    const id = this.toId(employer._id || employer.id);

    return {
      id,

      businessName: employer.businessName || "Employer",

      type: employer.type || null,

      typeLabel: this.formatStatusLabel(employer.type),

      countryCode: employer.countryCode || null,

      currency: employer.currency || null,

      logoUrl: employer.logoUrl || null,

      accountStatus: employer.accountStatus || null,

      accountStatusLabel: this.formatStatusLabel(employer.accountStatus),

      accountStatusBadgeClass: this.getStatusBadgeClass(employer.accountStatus),

      employerApprovalStatus: employer.employerApprovalStatus || null,

      employerApprovalStatusLabel: this.formatStatusLabel(employer.employerApprovalStatus),

      employerApprovalStatusBadgeClass: this.getStatusBadgeClass(employer.employerApprovalStatus),
    };
  }

  static buildAdminPublicationView(publication, currentTime = new Date()) {
    const base = this.buildPublicationView(publication, currentTime);

    if (!base) {
      return null;
    }

    const deadlineHistory = (
      Array.isArray(publication.deadlineHistory) ? publication.deadlineHistory : []
    ).map((entry) => ({
      fromDeadline: entry?.fromDeadline || null,

      fromDeadlineDisplay: this.formatDateTime(entry?.fromDeadline),

      toDeadline: entry?.toDeadline || null,

      toDeadlineDisplay: this.formatDateTime(entry?.toDeadline),

      changedAt: entry?.changedAt || null,

      changedAtDisplay: this.formatDateTime(entry?.changedAt),

      changedBy: this.toId(entry?.changedBy),

      reason: entry?.reason || null,
    }));

    return {
      ...base,

      referenceCode: publication.referenceCode || null,

      previousPublication: this.toId(publication.previousPublication),

      publicationPeriodDays: this.toPositiveSafeInteger(publication.publicationPeriodDays, null),

      initialApplicationDeadline: publication.initialApplicationDeadline || null,

      initialApplicationDeadlineDisplay: this.formatDateTime(
        publication.initialApplicationDeadline
      ),

      publishedBy: this.toId(publication.publishedBy),

      endedBy: this.toId(publication.endedBy),

      endReason: publication.endReason || null,

      entitlementSnapshot:
        publication.entitlementSnapshot && typeof publication.entitlementSnapshot === "object"
          ? {
              ...publication.entitlementSnapshot,
            }
          : null,

      deadlineHistory,

      hasDeadlineHistory: deadlineHistory.length > 0,

      applicationCount: this.toNonNegativeSafeInteger(publication.applicationCount, 0),

      applicationCountLastReconciledAt: publication.applicationCountLastReconciledAt || null,

      applicationCountLastReconciledAtDisplay: this.formatDateTime(
        publication.applicationCountLastReconciledAt
      ),
    };
  }

  static buildAdminJobView(job, currentTime = new Date()) {
    if (!job) {
      return null;
    }

    const employerJobView = this.buildEmployerJobView(job, currentTime);

    if (!employerJobView) {
      return null;
    }

    const id = employerJobView.id;

    return {
      ...employerJobView,

      employer: this.buildAdminEmployerView(job.business),

      vacancyCount: this.toPositiveSafeInteger(job.vacancyCount, null),

      applicationSummary:
        job.applicationSummary && typeof job.applicationSummary === "object"
          ? {
              ...job.applicationSummary,
            }
          : null,

      publicationCount: this.toNonNegativeSafeInteger(job.publicationCount, 0),

      applicationDeadline: job.applicationDeadline || null,

      applicationDeadlineDisplay: this.formatDateTime(job.applicationDeadline),

      lastPublishedAt: job.lastPublishedAt || null,

      lastPublishedAtDisplay: this.formatDateTime(job.lastPublishedAt),

      publicationExpiresAt: job.publicationExpiresAt || null,

      publicationExpiresAtDisplay: this.formatDateTime(job.publicationExpiresAt),

      closeReason: job.closeReason || null,

      closeReasonLabel: this.formatStatusLabel(job.closeReason),

      closeReasonDetails: job.closeReasonDetails || null,

      closedAt: job.closedAt || null,

      closedAtDisplay: this.formatDateTime(job.closedAt),

      closedBy: this.toId(job.closedBy),

      archivedAt: job.archivedAt || null,

      archivedAtDisplay: this.formatDateTime(job.archivedAt),

      archivedBy: this.toId(job.archivedBy),

      detailsUrl: id ? `${ADMIN_JOBS_URL}/${id}` : null,

      applicationsUrl: null,
    };
  }

  static buildAdminJobsPageView(pageData = {}) {
    const {
      jobs = [],
      selectedEmployer = null,
      branches = [],
      selectedEmployerProfileId = null,
      selectedRecruitmentStatus = "all",
      selectedPublicationStatus = "all",
      selectedBranchId = null,
      selectedSearch = null,
      recruitmentStatusCounts = {},
      publicationStatusCounts = {},
      currentTime = new Date(),
      pagination = {},
    } = pageData;

    const jobViews = (Array.isArray(jobs) ? jobs : [])
      .map((job) => this.buildAdminJobView(job, currentTime))
      .filter(Boolean);

    const employerView = this.buildAdminEmployerView(selectedEmployer);

    const buildUrl = (overrides = {}) =>
      this.buildAdminJobsUrl({
        employerProfileId: Object.prototype.hasOwnProperty.call(overrides, "employerProfileId")
          ? overrides.employerProfileId
          : selectedEmployerProfileId,

        recruitmentStatus: overrides.recruitmentStatus ?? selectedRecruitmentStatus,

        publicationStatus: overrides.publicationStatus ?? selectedPublicationStatus,

        branchId: Object.prototype.hasOwnProperty.call(overrides, "branchId")
          ? overrides.branchId
          : selectedBranchId,

        search: overrides.search ?? selectedSearch,

        page: overrides.page ?? null,
      });

    const recruitmentFilters = this.buildStatusFilterItems({
      counts: recruitmentStatusCounts,

      selected: selectedRecruitmentStatus,

      key: "recruitmentStatus",

      buildUrl,
    });

    const publicationFilters = this.buildStatusFilterItems({
      counts: publicationStatusCounts,

      selected: selectedPublicationStatus,

      key: "publicationStatus",

      buildUrl,
    });

    const branchFilters = [
      {
        key: "all",

        label: "All branches",

        value: null,

        isActive: !selectedBranchId,

        url: buildUrl({
          branchId: null,
          page: 1,
        }),
      },

      ...(Array.isArray(branches) ? branches : []).map((branch) => ({
        key: this.toId(branch),

        label: branch.name || "Branch",

        value: this.toId(branch),

        isActive: this.toId(branch) === selectedBranchId,

        url: buildUrl({
          branchId: this.toId(branch),

          page: 1,
        }),
      })),
    ];

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No Jobs match the current filters.",

      buildUrl: (page) => buildUrl({ page }),
    });

    const hasFilters = Boolean(
      selectedEmployerProfileId ||
      selectedRecruitmentStatus !== "all" ||
      selectedPublicationStatus !== "all" ||
      selectedBranchId ||
      selectedSearch
    );

    return {
      pageTitle: PAGE_COPY.adminJobsTitle,

      jobs: jobViews,

      hasJobs: jobViews.length > 0,

      selectedEmployer: employerView,

      summary: {
        visibleJobCount: jobViews.length,

        totalFilteredJobs: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),
      },

      filters: {
        employer: {
          value: selectedEmployerProfileId || null,

          selectedEmployer: employerView,

          clearUrl: selectedEmployerProfileId
            ? buildUrl({
                employerProfileId: null,
                branchId: null,
                page: 1,
              })
            : null,
        },

        recruitment: recruitmentFilters,

        publication: publicationFilters,

        branches: branchFilters,

        search: {
          value: selectedSearch || "",

          name: "search",

          placeholder: "Search Jobs",
        },

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: ADMIN_JOBS_URL,
        },
      },

      permissions: {
        canViewJobs: true,
        canManageJobs: false,
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

      pagination: paginationView,

      resultsHeader: {
        title: "Jobs",

        subtitle: paginationView.resultsText,
      },

      emptyState: {
        visible: jobViews.length === 0,

        icon: "ki-briefcase",

        title: PAGE_COPY.noAdminJobsTitle,

        message: hasFilters
          ? "No permanent Jobs match the current filters."
          : "No permanent Jobs have been created yet.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: ADMIN_JOBS_URL,
        },
      },

      actions: {
        jobsUrl: ADMIN_JOBS_URL,
      },
    };
  }

  static buildAdminJobDetailView(pageData = {}) {
    const { job = null, publications = [], currentTime = new Date() } = pageData;

    const jobView = this.buildAdminJobView(job, currentTime);

    const publicationViews = (Array.isArray(publications) ? publications : [])
      .map((publication) => this.buildAdminPublicationView(publication, currentTime))
      .filter(Boolean);

    return {
      pageTitle: jobView?.roleTitle || "Job Details",

      employer: jobView?.employer || null,

      job: jobView,

      publications: publicationViews,

      hasPublicationHistory: publicationViews.length > 0,

      permissions: {
        canViewJobs: true,
        canManageJobs: false,
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
        jobsUrl: ADMIN_JOBS_URL,

        applicationsUrl: null,
      },
    };
  }

  /* ─────────────────────────────── MARKETPLACE ─────────────────────────────── */

  static buildMarketplaceEmployerView(employerSnapshot) {
    if (!employerSnapshot || typeof employerSnapshot !== "object") {
      return null;
    }

    const branchLocationLabel = this.buildLocationLabel({
      address: employerSnapshot.branchAddress,

      lga: employerSnapshot.branchLga,

      state: employerSnapshot.branchState,
    });

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

        locationLabel: branchLocationLabel,
      },
    };
  }

  static buildMarketplaceScreeningQuestionView(question) {
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

  static buildMarketplaceListingSnapshotView(snapshot) {
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
        .map((question) => this.buildMarketplaceScreeningQuestionView(question))
        .filter(Boolean),

      capturedAt: snapshot.capturedAt || null,
    };
  }

  static buildMarketplacePublicationView(
    publication,
    { isSaved = false, hasApplied = false, isCurrentlyPublic = null, currentTime = new Date() } = {}
  ) {
    if (!publication) {
      return null;
    }

    const id = this.toId(publication);

    const jobId = this.toId(publication.job);

    const snapshot = this.buildMarketplaceListingSnapshotView(publication.listingSnapshot);

    const employer = this.buildMarketplaceEmployerView(publication.employerSnapshot);

    const locationLabel = this.buildLocationLabel({
      address: snapshot.address,

      lga: snapshot.lga,

      state: snapshot.state,
    });

    const deadline = this.buildDeadlineView(publication.applicationDeadline, currentTime);

    const publicationTiming = this.buildPublicationTimingView(publication, currentTime);

    const inferredCurrentlyPublic = Boolean(
      publication.status === "live" && publicationTiming?.hasExpiredByTime !== true
    );

    const currentlyPublic =
      typeof isCurrentlyPublic === "boolean" ? isCurrentlyPublic : inferredCurrentlyPublic;

    const acceptingApplications = Boolean(currentlyPublic && deadline.hasPassed !== true);

    const normalizedHasApplied = hasApplied === true;

    const canApply = Boolean(acceptingApplications && !normalizedHasApplied);

    return {
      publicationId: id,

      jobId,

      status: publication.status || null,

      statusLabel: this.formatStatusLabel(publication.status),

      statusBadgeClass: this.getStatusBadgeClass(publication.status),

      employer,

      businessName: employer?.businessName || null,

      businessLogoUrl: employer?.logoUrl || null,

      branchName: employer?.branch?.name || null,

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

      address: snapshot.address || null,

      locationLabel,

      listingSnapshot: snapshot,

      deadline,

      publicationTiming,

      acceptingApplications,

      hasApplied: normalizedHasApplied,

      canApply,

      isSaved: isSaved === true,

      detailsUrl: id ? `${MARKETPLACE_JOBS_URL}/${id}` : null,

      applyUrl: canApply && id ? `${PROFESSIONAL_JOB_PUBLICATIONS_URL}/${id}/apply` : null,

      saveUrl: jobId ? `/professional/jobs/${jobId}/save` : null,

      unsaveUrl: jobId ? `/professional/jobs/${jobId}/save` : null,
    };
  }

  static buildMarketplaceJobsPageView(pageData = {}) {
    const {
      items = [],
      selectedSearch = null,
      selectedProfessionalType = "all",
      selectedEmploymentType = "all",
      selectedWorkplaceType = "all",
      selectedState = null,
      selectedLga = null,
      professional = null,
      currentTime = new Date(),
      pagination = {},
    } = pageData;

    const jobViews = (Array.isArray(items) ? items : [])
      .map((item) =>
        this.buildMarketplacePublicationView(item?.publication, {
          isSaved: item?.isSaved === true,

          hasApplied: item?.hasApplied === true,

          currentTime,
        })
      )
      .filter(Boolean);

    const buildUrl = (overrides = {}) =>
      this.buildMarketplaceJobsUrl({
        search: overrides.search ?? selectedSearch,

        professionalType: overrides.professionalType ?? selectedProfessionalType,

        employmentType: overrides.employmentType ?? selectedEmploymentType,

        workplaceType: overrides.workplaceType ?? selectedWorkplaceType,

        state: overrides.state ?? selectedState,

        lga: overrides.lga ?? selectedLga,

        page: overrides.page ?? null,
      });

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No Jobs match the current filters.",

      buildUrl: (page) => buildUrl({ page }),
    });

    const hasFilters = Boolean(
      selectedSearch ||
      selectedProfessionalType !== "all" ||
      selectedEmploymentType !== "all" ||
      selectedWorkplaceType !== "all" ||
      selectedState ||
      selectedLga
    );

    return {
      pageTitle: PAGE_COPY.marketplaceTitle,

      professional,

      jobs: jobViews,

      hasJobs: jobViews.length > 0,

      summary: {
        visibleJobCount: jobViews.length,

        totalFilteredJobs: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        visibleAppliedCount: jobViews.filter((job) => job.hasApplied).length,
      },

      filters: {
        search: {
          name: "search",

          value: selectedSearch || "",

          placeholder: "Search Jobs",
        },

        professionalType: {
          name: "professionalType",

          value: selectedProfessionalType,
        },

        employmentType: {
          name: "employmentType",

          value: selectedEmploymentType,
        },

        workplaceType: {
          name: "workplaceType",

          value: selectedWorkplaceType,
        },

        state: {
          name: "state",

          value: selectedState || "",
        },

        lga: {
          name: "lga",

          value: selectedLga || "",
        },

        clearAction: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          url: MARKETPLACE_JOBS_URL,
        },
      },

      pagination: paginationView,

      resultsHeader: {
        title: "Available Jobs",

        subtitle: paginationView.resultsText,
      },

      emptyState: {
        visible: jobViews.length === 0,

        icon: "ki-briefcase",

        title: PAGE_COPY.noMarketplaceJobsTitle,

        message: hasFilters
          ? "No permanent Jobs match the current filters."
          : "There are no live permanent Job listings at the moment.",

        action: {
          visible: hasFilters,

          label: PAGE_COPY.clearFiltersLabel,

          buttonClass: "btn-light-primary",

          url: MARKETPLACE_JOBS_URL,
        },
      },

      actions: {
        marketplaceUrl: MARKETPLACE_JOBS_URL,

        savedJobsUrl: professional ? PROFESSIONAL_SAVED_JOBS_URL : null,
      },
    };
  }

  static buildMarketplaceJobDetailView(pageData = {}) {
    const {
      publication = null,
      isSaved = false,
      hasApplied = false,
      professional = null,
      currentTime = new Date(),
    } = pageData;

    const job = this.buildMarketplacePublicationView(publication, {
      isSaved,
      hasApplied,
      currentTime,
    });

    return {
      pageTitle: job?.roleTitle || "Job Details",

      professional,

      job,

      actions: {
        marketplaceUrl: MARKETPLACE_JOBS_URL,

        savedJobsUrl: professional ? PROFESSIONAL_SAVED_JOBS_URL : null,

        applyUrl: job?.canApply === true ? job.applyUrl : null,

        saveUrl: professional && !job?.isSaved ? job?.saveUrl || null : null,

        unsaveUrl: professional && job?.isSaved ? job?.unsaveUrl || null : null,
      },
    };
  }

  /* ─────────────────────────────── SAVED JOBS ─────────────────────────────── */

  static buildSavedJobView(item, currentTime = new Date()) {
    const savedJob = item?.savedJob || null;

    const publication = item?.publication || null;

    const jobId = this.toId(savedJob?.job || publication?.job);

    const isCurrentlyPublic = item?.isCurrentlyPublic === true;

    const hasApplied = item?.hasApplied === true;

    const marketplaceView = publication
      ? this.buildMarketplacePublicationView(publication, {
          isSaved: true,
          hasApplied,
          isCurrentlyPublic,
          currentTime,
        })
      : null;

    return {
      savedJobId: this.toId(savedJob),

      jobId,

      savedAt: savedJob?.savedAt || null,

      savedAtDisplay: this.formatDateTime(savedJob?.savedAt),

      isCurrentlyPublic,

      hasApplied,

      listing: marketplaceView,

      availability: isCurrentlyPublic ? "available" : "unavailable",

      availabilityLabel: isCurrentlyPublic ? "Available" : "Currently unavailable",

      availabilityBadgeClass: isCurrentlyPublic ? "badge-light-success" : "badge-light-secondary",

      detailsUrl: isCurrentlyPublic ? marketplaceView?.detailsUrl || null : null,

      applyUrl:
        isCurrentlyPublic && marketplaceView?.canApply === true ? marketplaceView.applyUrl : null,

      unsaveUrl: jobId ? `/professional/jobs/${jobId}/save` : null,
    };
  }

  static buildSavedJobsPageView(pageData = {}) {
    const { professional = null, items = [], currentTime = new Date(), pagination = {} } = pageData;

    const savedJobViews = (Array.isArray(items) ? items : [])
      .map((item) => this.buildSavedJobView(item, currentTime))
      .filter(Boolean);

    const paginationView = this.buildPaginationView({
      pagination,

      emptyText: "No saved Jobs.",

      buildUrl: (page) =>
        this.buildSavedJobsUrl({
          page,
        }),
    });

    const availableCount = savedJobViews.filter((item) => item.isCurrentlyPublic).length;

    return {
      pageTitle: PAGE_COPY.savedJobsTitle,

      professional,

      savedJobs: savedJobViews,

      hasSavedJobs: savedJobViews.length > 0,

      summary: {
        visibleSavedJobCount: savedJobViews.length,

        totalSavedJobs: this.toNonNegativeSafeInteger(pagination?.totalItems, 0),

        visibleAvailableCount: availableCount,

        visibleUnavailableCount: savedJobViews.length - availableCount,
      },

      pagination: paginationView,

      resultsHeader: {
        title: "Saved Jobs",

        subtitle: paginationView.resultsText,
      },

      emptyState: {
        visible: savedJobViews.length === 0,

        icon: "ki-heart",

        title: PAGE_COPY.noSavedJobsTitle,

        message: "Jobs you save from the marketplace will appear here.",

        action: {
          visible: true,

          label: "Browse Jobs",

          buttonClass: "btn-light-primary",

          url: MARKETPLACE_JOBS_URL,
        },
      },

      actions: {
        marketplaceUrl: MARKETPLACE_JOBS_URL,

        savedJobsUrl: PROFESSIONAL_SAVED_JOBS_URL,
      },
    };
  }
}

module.exports = JobViewService;
