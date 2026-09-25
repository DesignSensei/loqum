// services/jobs/applications/jobApplicationQueryService.js

const mongoose = require("mongoose");

const Job = require("../../../models/Job");
const JobApplication = require("../../../models/JobApplication");
const EmployerProfile = require("../../../models/EmployerProfile");
const EmployerMember = require("../../../models/EmployerMember");
const ProfessionalProfile = require("../../../models/ProfessionalProfile");

const { createServiceError } = require("../../helpers/serviceErrorHelper");
const { normalizeObjectId } = require("../../helpers/serviceValidationHelpers");

const JOB_APPLICATION_QUERY_SERVICE_ERROR_NAME = "JobApplicationQueryServiceError";

const APPLICATIONS_PER_PAGE = 20;

/**
 * Employer ATS reads may enrich the immutable application snapshot with a
 * deliberately limited view of the professional's current profile.
 *
 * Shift availability, marketplace visibility, approval state and account
 * state are intentionally excluded. Those operational fields must not hide or
 * invalidate an already-submitted permanent-Job application.
 */
const PROFESSIONAL_FIELDS = [
  "user",
  "type",
  "specialty",
  "bio",
  "yearsOfExperience",
  "state",
  "lga",
  "tier",
  "averageRating",
  "totalReviews",
  "reliabilityScore",
  "totalShiftsCompleted",
  "licenceVerificationStatus",
  "licenceExpiryDate",
  "identityVerificationStatus",
];

const PROFESSIONAL_CERTIFICATION_FIELDS = [
  "certifications.name",
  "certifications.issuingBody",
  "certifications.dateObtained",
  "certifications.expiryDate",
  "certifications.verified",
];

const USER_IDENTITY_FIELDS = ["firstName", "lastName", "displayName", "photo"];

/**
 * Professional-facing application history remains tied to the exact
 * publication cycle through which the professional applied.
 *
 * Commercial entitlement data and internal publication audit history are
 * intentionally excluded.
 */
const PUBLICATION_FIELDS = [
  "job",
  "cycleNumber",
  "employerSnapshot",
  "listingSnapshot",
  "status",
  "applicationDeadline",
  "publishedAt",
  "expiresAt",
  "endedAt",
  "createdAt",
  "updatedAt",
];

/**
 * Employer-side ATS reads must not expose sensitive candidate fields by
 * default. The immutable application snapshot still stores them internally.
 */
const EMPLOYER_HIDDEN_CANDIDATE_FIELDS = [
  "candidateSnapshot.phoneCode",
  "candidateSnapshot.phone",
  "candidateSnapshot.licenceNumber",
];

/* ─────────────────────────────── ERROR CONTRACT ─────────────────────────────── */

function createApplicationQueryError(options) {
  return createServiceError({
    ...options,
    name: JOB_APPLICATION_QUERY_SERVICE_ERROR_NAME,
  });
}

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getExistingFields(model, fieldNames = []) {
  return fieldNames.filter((fieldName) => Boolean(model?.schema?.path(fieldName)));
}

function getApplicationPublicationPath() {
  return ["publication", "jobPublication"].find((path) => JobApplication.schema.path(path)) || null;
}

function buildStatusCounts(results = [], total = 0) {
  const counts = {
    all: Number(total || 0),
  };

  for (const item of results) {
    if (!item?._id) {
      continue;
    }

    counts[String(item._id)] = Number(item.count || 0);
  }

  return counts;
}

function normalizeApplicationPublicationAlias(application) {
  if (!application || typeof application !== "object") {
    return application;
  }

  const publicationPath = getApplicationPublicationPath();

  if (publicationPath && publicationPath !== "publication") {
    application.publication = application[publicationPath] || null;
  }

  return application;
}

/* ─────────────────────────────── QUERY SERVICE ─────────────────────────────── */

class JobApplicationQueryService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createApplicationQueryError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
        statusCode: 500,
      });
    }

    return currentTime;
  }

  static normalizePageNumber(value) {
    const page = Number.parseInt(value, 10);

    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  }

  static normalizeStatusFilter(value) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    const allowedStatuses = JobApplication.schema.path("status")?.enumValues || [];

    return status === "all" || allowedStatuses.includes(status) ? status : "all";
  }

  static normalizeOptionalJobId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,
      fieldName: "Job ID",
      createError: createApplicationQueryError,
    });
  }

  static normalizeOptionalEmployerProfileId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,
      fieldName: "employer profile ID",
      createError: createApplicationQueryError,
    });
  }

  static normalizeApplicationId(value) {
    return normalizeObjectId({
      value,
      fieldName: "Job application ID",
      createError: createApplicationQueryError,
    });
  }

  /* ─────────────────────────────── EMPLOYER READ ACCESS ─────────────────────────────── */

  static canViewApplications(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true ||
      employerContext?.isBranchStaff === true
    );
  }

  static canManageApplications(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true
    );
  }

  static canViewAllBranches(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static getAssignedBranchObjectIds(employerContext = null) {
    return (employerContext?.assignedBranchIds || [])
      .filter((branchId) => mongoose.isValidObjectId(branchId))
      .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));
  }

  static async getEmployerProfileForRead({
    userId,
    employerProfile = null,
    employerContext = null,
  }) {
    if (!JobApplicationQueryService.canViewApplications(employerContext)) {
      throw createApplicationQueryError({
        message: "You do not have permission to view permanent Job applications.",
        code: "JOB_APPLICATION_VIEW_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    const normalizedUserId = normalizeObjectId({
      value: userId,
      fieldName: "user ID",
      createError: createApplicationQueryError,
    });

    if (!employerProfile?._id) {
      throw createApplicationQueryError({
        message: "Employer profile context is unavailable.",
        code: "EMPLOYER_PROFILE_CONTEXT_REQUIRED",
        statusCode: 500,
      });
    }

    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfile._id,
      fieldName: "employer profile ID",
      createError: createApplicationQueryError,
    });

    const profile = await EmployerProfile.findById(normalizedEmployerProfileId)
      .select("user businessName countryCode currency")
      .lean();

    if (!profile) {
      throw createApplicationQueryError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    const isPrimaryEmployer = profile.user && String(profile.user) === String(normalizedUserId);

    if (isPrimaryEmployer) {
      if (employerContext?.isPrimaryEmployer !== true) {
        throw createApplicationQueryError({
          message: "Your employer access context is invalid.",
          code: "EMPLOYER_ACCESS_CONTEXT_INVALID",
          statusCode: 403,
        });
      }

      return profile;
    }

    const member = await EmployerMember.findOne({
      business: normalizedEmployerProfileId,
      user: normalizedUserId,
      accountStatus: "active",
      isCurrent: {
        $ne: false,
      },
    })
      .select("role branches")
      .lean();

    if (!member) {
      throw createApplicationQueryError({
        message: "You are not authorized for this employer business.",
        code: "EMPLOYER_PROFILE_ACCESS_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    const roleMatchesContext = Boolean(
      (member.role === "admin" && employerContext?.isBusinessAdmin === true) ||
      (member.role === "branch_manager" && employerContext?.isBranchManager === true) ||
      (member.role === "branch_staff" && employerContext?.isBranchStaff === true)
    );

    if (!roleMatchesContext) {
      throw createApplicationQueryError({
        message: "Your employer access context is invalid.",
        code: "EMPLOYER_ACCESS_CONTEXT_INVALID",
        statusCode: 403,
      });
    }

    if (["branch_manager", "branch_staff"].includes(member.role)) {
      const memberBranchIds = new Set(
        (Array.isArray(member.branches) ? member.branches : [])
          .map((assignment) => assignment?.branch)
          .filter((branchId) => mongoose.isValidObjectId(branchId))
          .map(String)
      );

      const contextBranchIds = (employerContext?.assignedBranchIds || [])
        .filter((branchId) => mongoose.isValidObjectId(branchId))
        .map(String);

      const contextContainsUnassignedBranch = contextBranchIds.some(
        (branchId) => !memberBranchIds.has(branchId)
      );

      if (contextContainsUnassignedBranch) {
        throw createApplicationQueryError({
          message: "Your employer branch access context is invalid.",
          code: "EMPLOYER_BRANCH_ACCESS_CONTEXT_INVALID",
          statusCode: 403,
        });
      }
    }

    return profile;
  }

  static buildAccessibleJobFilter({ employerProfileId, employerContext = null, jobId = null }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,
      fieldName: "employer profile ID",
      createError: createApplicationQueryError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
    };

    if (jobId) {
      filter._id = normalizeObjectId({
        value: jobId,
        fieldName: "Job ID",
        createError: createApplicationQueryError,
      });
    }

    if (!JobApplicationQueryService.canViewAllBranches(employerContext)) {
      filter.branch = {
        $in: JobApplicationQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return filter;
  }

  static async resolveAccessibleJobScope({
    employerProfileId,
    employerContext = null,
    jobId = null,
  }) {
    const jobFilter = JobApplicationQueryService.buildAccessibleJobFilter({
      employerProfileId,
      employerContext,
      jobId,
    });

    if (jobId) {
      const focusedJob = await Job.findOne(jobFilter)
        .populate("branch", "name address state lga isActive")
        .lean();

      if (!focusedJob) {
        throw createApplicationQueryError({
          message: "Job was not found or is not available to you.",
          code: "JOB_NOT_FOUND",
          statusCode: 404,
        });
      }

      return {
        focusedJob,
        jobIds: [focusedJob._id],
      };
    }

    const jobIds = await Job.distinct("_id", jobFilter);

    return {
      focusedJob: null,
      jobIds,
    };
  }

  /* ─────────────────────────────── ADMIN READ ACCESS ─────────────────────────────── */

  static async getAdminEmployerForRead(employerProfileId) {
    if (!employerProfileId) {
      return null;
    }

    const normalizedEmployerProfileId =
      JobApplicationQueryService.normalizeOptionalEmployerProfileId(employerProfileId);

    const employer = await EmployerProfile.findById(normalizedEmployerProfileId)
      .select("businessName countryCode currency")
      .lean();

    if (!employer) {
      throw createApplicationQueryError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employer;
  }

  static async resolveAdminJobScope({ employerProfileId = null, jobId = null } = {}) {
    const selectedEmployer =
      await JobApplicationQueryService.getAdminEmployerForRead(employerProfileId);

    const normalizedJobId = jobId ? JobApplicationQueryService.normalizeOptionalJobId(jobId) : null;

    const jobFilter = {};

    if (selectedEmployer?._id) {
      jobFilter.business = selectedEmployer._id;
    }

    if (normalizedJobId) {
      jobFilter._id = normalizedJobId;
    }

    if (normalizedJobId) {
      const focusedJob = await Job.findOne(jobFilter)
        .populate("branch", "name address state lga isActive")
        .populate("business", "businessName countryCode currency")
        .lean();

      if (!focusedJob) {
        throw createApplicationQueryError({
          message: "Job not found.",
          code: "JOB_NOT_FOUND",
          statusCode: 404,
        });
      }

      return {
        selectedEmployer,
        focusedJob,

        scopeFilter: {
          job: focusedJob._id,
        },
      };
    }

    if (selectedEmployer?._id) {
      const jobIds = await Job.distinct("_id", {
        business: selectedEmployer._id,
      });

      return {
        selectedEmployer,
        focusedJob: null,

        scopeFilter: JobApplicationQueryService.buildApplicationScopeFilter(jobIds),
      };
    }

    return {
      selectedEmployer: null,
      focusedJob: null,
      scopeFilter: {},
    };
  }

  /* ─────────────────────────────── PROFESSIONAL READ ACCESS ─────────────────────────────── */

  static async getProfessionalProfileForRead({ userId, professionalProfile = null }) {
    const normalizedUserId = normalizeObjectId({
      value: userId,
      fieldName: "user ID",
      createError: createApplicationQueryError,
    });

    if (!professionalProfile?._id) {
      throw createApplicationQueryError({
        message: "Professional profile context is unavailable.",
        code: "PROFESSIONAL_PROFILE_CONTEXT_REQUIRED",
        statusCode: 500,
      });
    }

    const normalizedProfessionalProfileId = normalizeObjectId({
      value: professionalProfile._id,
      fieldName: "professional profile ID",
      createError: createApplicationQueryError,
    });

    const profile = await ProfessionalProfile.findById(normalizedProfessionalProfileId)
      .select("user type specialty")
      .lean();

    if (!profile) {
      throw createApplicationQueryError({
        message: "Professional profile not found.",
        code: "PROFESSIONAL_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!profile.user || String(profile.user) !== String(normalizedUserId)) {
      throw createApplicationQueryError({
        message: "You are not authorized for this professional profile.",
        code: "PROFESSIONAL_PROFILE_ACCESS_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return profile;
  }

  /* ─────────────────────────────── APPLICATION QUERY BUILDERS ─────────────────────────────── */

  static buildApplicationScopeFilter(jobIds = []) {
    return {
      job: {
        $in: Array.isArray(jobIds) ? jobIds : [],
      },
    };
  }

  static applyStatusFilter(filter, status) {
    const result = {
      ...filter,
    };

    if (status !== "all") {
      result.status = status;
    }

    return result;
  }

  static buildProfessionalPopulate() {
    const professionalFields = getExistingFields(ProfessionalProfile, PROFESSIONAL_FIELDS);

    if (ProfessionalProfile.schema.path("certifications")) {
      professionalFields.push(...PROFESSIONAL_CERTIFICATION_FIELDS);
    }

    const populate = {
      path: "professional",
    };

    if (professionalFields.length) {
      populate.select = [...new Set(professionalFields)].join(" ");
    }

    if (ProfessionalProfile.schema.path("user")) {
      populate.populate = {
        path: "user",

        select: USER_IDENTITY_FIELDS.join(" "),
      };
    }

    return populate;
  }

  static buildPublicationPopulate() {
    const publicationPath = getApplicationPublicationPath();

    if (!publicationPath) {
      return null;
    }

    return {
      path: publicationPath,

      select: PUBLICATION_FIELDS.join(" "),
    };
  }

  static applyEmployerApplicationProjection(query, { includeResumeDocument = false } = {}) {
    query = query.select("+employerPrivateNote");

    query = query.select(
      EMPLOYER_HIDDEN_CANDIDATE_FIELDS.map((fieldName) => `-${fieldName}`).join(" ")
    );

    if (includeResumeDocument) {
      query = query.select("+resumeSnapshot.documentUrl");
    }

    return query;
  }

  static applyAdminApplicationProjection(query) {
    query = query.select("-employerPrivateNote");

    query = query.select(
      EMPLOYER_HIDDEN_CANDIDATE_FIELDS.map((fieldName) => `-${fieldName}`).join(" ")
    );

    query = query.select("-resumeSnapshot.documentUrl");

    return query;
  }

  static applyProfessionalApplicationProjection(query, { includeResumeDocument = false } = {}) {
    if (includeResumeDocument) {
      query = query.select("+resumeSnapshot.documentUrl");
    }

    return query;
  }

  static buildEmployerApplicationQuery(filter, { includeResumeDocument = false } = {}) {
    let query = JobApplication.find(filter)
      .populate(JobApplicationQueryService.buildProfessionalPopulate())
      .populate({
        path: "job",

        populate: {
          path: "branch",

          select: "name address state lga isActive",
        },
      });

    query = JobApplicationQueryService.applyEmployerApplicationProjection(query, {
      includeResumeDocument,
    });

    const publicationPopulate = JobApplicationQueryService.buildPublicationPopulate();

    if (publicationPopulate) {
      query = query.populate(publicationPopulate);
    }

    return query;
  }

  static buildAdminApplicationQuery(filter) {
    let query = JobApplication.find(filter)
      .populate(JobApplicationQueryService.buildProfessionalPopulate())
      .populate({
        path: "job",

        populate: [
          {
            path: "branch",

            select: "name address state lga isActive",
          },

          {
            path: "business",

            select: "businessName countryCode currency",
          },
        ],
      });

    query = JobApplicationQueryService.applyAdminApplicationProjection(query);

    const publicationPopulate = JobApplicationQueryService.buildPublicationPopulate();

    if (publicationPopulate) {
      query = query.populate(publicationPopulate);
    }

    return query;
  }

  static buildProfessionalApplicationQuery(filter, { includeResumeDocument = false } = {}) {
    let query = JobApplication.find(filter);

    query = JobApplicationQueryService.applyProfessionalApplicationProjection(query, {
      includeResumeDocument,
    });

    const publicationPopulate = JobApplicationQueryService.buildPublicationPopulate();

    if (publicationPopulate) {
      query = query.populate(publicationPopulate);
    }

    return query;
  }

  static normalizeApplicationRecords(applications = []) {
    return (Array.isArray(applications) ? applications : []).map((application) =>
      normalizeApplicationPublicationAlias(application)
    );
  }

  /* ─────────────────────────────── EMPLOYER APPLICATIONS PAGE ─────────────────────────────── */

  static async getEmployerApplicationsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    status = "all",
    jobId = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobApplicationQueryService.normalizeCurrentTime(currentTime);

    const selectedStatus = JobApplicationQueryService.normalizeStatusFilter(status);

    const selectedJobId = JobApplicationQueryService.normalizeOptionalJobId(jobId);

    const requestedPage = JobApplicationQueryService.normalizePageNumber(page);

    const profile = await JobApplicationQueryService.getEmployerProfileForRead({
      userId,
      employerProfile,
      employerContext,
    });

    const { focusedJob, jobIds } = await JobApplicationQueryService.resolveAccessibleJobScope({
      employerProfileId: profile._id,

      employerContext,

      jobId: selectedJobId,
    });

    const scopeFilter = JobApplicationQueryService.buildApplicationScopeFilter(jobIds);

    const filteredApplicationFilter = JobApplicationQueryService.applyStatusFilter(
      scopeFilter,
      selectedStatus
    );

    const [totalFilteredApplications, totalForStatusTabs, statusCountResults] = await Promise.all([
      JobApplication.countDocuments(filteredApplicationFilter),

      JobApplication.countDocuments(scopeFilter),

      JobApplication.aggregate([
        {
          $match: scopeFilter,
        },

        {
          $group: {
            _id: "$status",

            count: {
              $sum: 1,
            },
          },
        },
      ]),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredApplications / APPLICATIONS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * APPLICATIONS_PER_PAGE;

    const rawApplications =
      totalFilteredApplications > 0
        ? await JobApplicationQueryService.buildEmployerApplicationQuery(filteredApplicationFilter)
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .skip(skip)
            .limit(APPLICATIONS_PER_PAGE)
            .lean()
        : [];

    const applications = JobApplicationQueryService.normalizeApplicationRecords(rawApplications);

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode || null,

        currency: profile.currency || null,
      },

      applications,

      focusedJob,

      selectedStatus,

      selectedJobId: selectedJobId ? String(selectedJobId) : null,

      statusCounts: buildStatusCounts(statusCountResults, totalForStatusTabs),

      canViewApplications: JobApplicationQueryService.canViewApplications(employerContext),

      canManageApplications: JobApplicationQueryService.canManageApplications(employerContext),

      currentTime: normalizedCurrentTime,

      pagination: {
        currentPage,
        totalPages,

        totalItems: totalFilteredApplications,

        perPage: APPLICATIONS_PER_PAGE,

        startItem: totalFilteredApplications > 0 ? skip + 1 : 0,

        endItem: totalFilteredApplications > 0 ? skip + applications.length : 0,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,

        hasPagination: totalPages > 1,
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER APPLICATION DETAIL ─────────────────────────────── */

  static async getEmployerApplicationDetailData({
    userId,
    employerProfile = null,
    employerContext = null,
    applicationId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobApplicationQueryService.normalizeCurrentTime(currentTime);

    const normalizedApplicationId =
      JobApplicationQueryService.normalizeApplicationId(applicationId);

    const profile = await JobApplicationQueryService.getEmployerProfileForRead({
      userId,
      employerProfile,
      employerContext,
    });

    const applicationIdentity = await JobApplication.findById(normalizedApplicationId)
      .select("job")
      .lean();

    if (!applicationIdentity) {
      throw createApplicationQueryError({
        message: "Job application not found.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    const { focusedJob } = await JobApplicationQueryService.resolveAccessibleJobScope({
      employerProfileId: profile._id,

      employerContext,

      jobId: applicationIdentity.job,
    });

    const application = normalizeApplicationPublicationAlias(
      await JobApplicationQueryService.buildEmployerApplicationQuery(
        {
          _id: normalizedApplicationId,

          job: focusedJob._id,
        },
        {
          includeResumeDocument: true,
        }
      ).lean()
    );

    if (!application) {
      throw createApplicationQueryError({
        message: "Job application not found.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode || null,

        currency: profile.currency || null,
      },

      application,

      job: focusedJob,

      canViewApplications: JobApplicationQueryService.canViewApplications(employerContext),

      canManageApplications: JobApplicationQueryService.canManageApplications(employerContext),

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── ADMIN APPLICATIONS PAGE ─────────────────────────────── */

  static async getAdminApplicationsPageData({
    employerProfileId = null,
    status = "all",
    jobId = null,
    page = 1,
    currentTime = new Date(),
  } = {}) {
    const normalizedCurrentTime = JobApplicationQueryService.normalizeCurrentTime(currentTime);

    const selectedEmployerProfileId =
      JobApplicationQueryService.normalizeOptionalEmployerProfileId(employerProfileId);

    const selectedStatus = JobApplicationQueryService.normalizeStatusFilter(status);

    const selectedJobId = JobApplicationQueryService.normalizeOptionalJobId(jobId);

    const requestedPage = JobApplicationQueryService.normalizePageNumber(page);

    const { selectedEmployer, focusedJob, scopeFilter } =
      await JobApplicationQueryService.resolveAdminJobScope({
        employerProfileId: selectedEmployerProfileId,

        jobId: selectedJobId,
      });

    const filteredApplicationFilter = JobApplicationQueryService.applyStatusFilter(
      scopeFilter,
      selectedStatus
    );

    const [totalFilteredApplications, totalForStatusTabs, statusCountResults] = await Promise.all([
      JobApplication.countDocuments(filteredApplicationFilter),

      JobApplication.countDocuments(scopeFilter),

      JobApplication.aggregate([
        {
          $match: scopeFilter,
        },

        {
          $group: {
            _id: "$status",

            count: {
              $sum: 1,
            },
          },
        },
      ]),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredApplications / APPLICATIONS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * APPLICATIONS_PER_PAGE;

    const rawApplications =
      totalFilteredApplications > 0
        ? await JobApplicationQueryService.buildAdminApplicationQuery(filteredApplicationFilter)
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .skip(skip)
            .limit(APPLICATIONS_PER_PAGE)
            .lean()
        : [];

    const applications = JobApplicationQueryService.normalizeApplicationRecords(rawApplications);

    return {
      selectedEmployer: selectedEmployer
        ? {
            id: String(selectedEmployer._id),

            businessName: selectedEmployer.businessName || "Employer",

            countryCode: selectedEmployer.countryCode || null,

            currency: selectedEmployer.currency || null,
          }
        : null,

      applications,

      focusedJob,

      selectedEmployerProfileId: selectedEmployerProfileId
        ? String(selectedEmployerProfileId)
        : null,

      selectedStatus,

      selectedJobId: selectedJobId ? String(selectedJobId) : null,

      statusCounts: buildStatusCounts(statusCountResults, totalForStatusTabs),

      canViewApplications: true,

      canManageApplications: false,

      currentTime: normalizedCurrentTime,

      pagination: {
        currentPage,
        totalPages,

        totalItems: totalFilteredApplications,

        perPage: APPLICATIONS_PER_PAGE,

        startItem: totalFilteredApplications > 0 ? skip + 1 : 0,

        endItem: totalFilteredApplications > 0 ? skip + applications.length : 0,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,

        hasPagination: totalPages > 1,
      },
    };
  }

  /* ─────────────────────────────── ADMIN APPLICATION DETAIL ─────────────────────────────── */

  static async getAdminApplicationDetailData({ applicationId, currentTime = new Date() }) {
    const normalizedCurrentTime = JobApplicationQueryService.normalizeCurrentTime(currentTime);

    const normalizedApplicationId =
      JobApplicationQueryService.normalizeApplicationId(applicationId);

    const application = normalizeApplicationPublicationAlias(
      await JobApplicationQueryService.buildAdminApplicationQuery({
        _id: normalizedApplicationId,
      }).lean()
    );

    if (!application) {
      throw createApplicationQueryError({
        message: "Job application not found.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    const job = application.job && typeof application.job === "object" ? application.job : null;

    const employer =
      job?.business && typeof job.business === "object"
        ? {
            id: String(job.business._id || job.business),

            businessName: job.business.businessName || "Employer",

            countryCode: job.business.countryCode || null,

            currency: job.business.currency || null,
          }
        : null;

    return {
      employer,

      application,

      job,

      canViewApplications: true,

      canManageApplications: false,

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── PROFESSIONAL APPLICATIONS PAGE ─────────────────────────────── */

  static async getProfessionalApplicationsPageData({
    userId,
    professionalProfile = null,
    status = "all",
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobApplicationQueryService.normalizeCurrentTime(currentTime);

    const selectedStatus = JobApplicationQueryService.normalizeStatusFilter(status);

    const requestedPage = JobApplicationQueryService.normalizePageNumber(page);

    const professional = await JobApplicationQueryService.getProfessionalProfileForRead({
      userId,
      professionalProfile,
    });

    const scopeFilter = {
      professional: professional._id,
    };

    const filteredApplicationFilter = JobApplicationQueryService.applyStatusFilter(
      scopeFilter,
      selectedStatus
    );

    const [totalFilteredApplications, totalForStatusTabs, statusCountResults] = await Promise.all([
      JobApplication.countDocuments(filteredApplicationFilter),

      JobApplication.countDocuments(scopeFilter),

      JobApplication.aggregate([
        {
          $match: scopeFilter,
        },

        {
          $group: {
            _id: "$status",

            count: {
              $sum: 1,
            },
          },
        },
      ]),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredApplications / APPLICATIONS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * APPLICATIONS_PER_PAGE;

    const rawApplications =
      totalFilteredApplications > 0
        ? await JobApplicationQueryService.buildProfessionalApplicationQuery(
            filteredApplicationFilter
          )
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .skip(skip)
            .limit(APPLICATIONS_PER_PAGE)
            .lean()
        : [];

    const applications = JobApplicationQueryService.normalizeApplicationRecords(rawApplications);

    return {
      professional: {
        id: String(professional._id),

        type: professional.type || null,

        specialty: professional.specialty || null,
      },

      applications,

      selectedStatus,

      statusCounts: buildStatusCounts(statusCountResults, totalForStatusTabs),

      currentTime: normalizedCurrentTime,

      pagination: {
        currentPage,
        totalPages,

        totalItems: totalFilteredApplications,

        perPage: APPLICATIONS_PER_PAGE,

        startItem: totalFilteredApplications > 0 ? skip + 1 : 0,

        endItem: totalFilteredApplications > 0 ? skip + applications.length : 0,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,

        hasPagination: totalPages > 1,
      },
    };
  }

  /* ─────────────────────────────── PROFESSIONAL APPLICATION DETAIL ─────────────────────────────── */

  static async getProfessionalApplicationDetailData({
    userId,
    professionalProfile = null,
    applicationId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobApplicationQueryService.normalizeCurrentTime(currentTime);

    const normalizedApplicationId =
      JobApplicationQueryService.normalizeApplicationId(applicationId);

    const professional = await JobApplicationQueryService.getProfessionalProfileForRead({
      userId,
      professionalProfile,
    });

    const application = normalizeApplicationPublicationAlias(
      await JobApplicationQueryService.buildProfessionalApplicationQuery(
        {
          _id: normalizedApplicationId,

          professional: professional._id,
        },
        {
          includeResumeDocument: true,
        }
      ).lean()
    );

    if (!application) {
      throw createApplicationQueryError({
        message: "Job application not found.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return {
      professional: {
        id: String(professional._id),

        type: professional.type || null,

        specialty: professional.specialty || null,
      },

      application,

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createApplicationQueryError(options) {
    return createApplicationQueryError(options);
  }
}

module.exports = JobApplicationQueryService;
