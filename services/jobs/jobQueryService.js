// services/jobs/jobQueryService.js

const mongoose = require("mongoose");

const Job = require("../../models/Job");
const JobPublication = require("../../models/JobPublication");
const JobApplication = require("../../models/JobApplication");
const SavedJob = require("../../models/SavedJob");
const Branch = require("../../models/Branch");
const EmployerProfile = require("../../models/EmployerProfile");
const EmployerMember = require("../../models/EmployerMember");
const ProfessionalProfile = require("../../models/ProfessionalProfile");

const { createServiceError } = require("../helpers/serviceErrorHelper");
const { normalizeObjectId } = require("../helpers/serviceValidationHelpers");

const JOB_QUERY_SERVICE_ERROR_NAME = "JobQueryServiceError";

const JOBS_PER_PAGE = 20;

/* ─────────────────────────────── ERROR CONTRACT ─────────────────────────────── */

function createJobQueryError(options) {
  return createServiceError({
    ...options,
    name: JOB_QUERY_SERVICE_ERROR_NAME,
  });
}

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getEnumValues(model, path) {
  const enumValues = model?.schema?.path(path)?.enumValues;

  return Array.isArray(enumValues) ? enumValues : [];
}

function normalizeStringFilter(value, fallback = "all") {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase();

  return normalized || fallback;
}

function normalizeOptionalText(value) {
  const normalized = String(value || "").trim();

  return normalized || null;
}

function buildPagination({ page, totalItems, perPage, itemCount }) {
  const totalPages = Math.max(Math.ceil(totalItems / perPage), 1);

  const currentPage = Math.min(page, totalPages);

  const skip = (currentPage - 1) * perPage;

  return {
    currentPage,
    totalPages,
    totalItems,
    perPage,
    startItem: totalItems > 0 ? skip + 1 : 0,
    endItem: totalItems > 0 ? skip + itemCount : 0,
    hasPreviousPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
    hasPagination: totalPages > 1,
  };
}

function buildGroupedCountMap(results = [], total = 0) {
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

/* ─────────────────────────────── PUBLIC SNAPSHOT HELPERS ─────────────────────────────── */

function sanitizePublicScreeningQuestion(question) {
  if (!question || typeof question !== "object") {
    return null;
  }

  return {
    questionId: question.questionId || null,
    prompt: question.prompt || null,
    type: question.type || null,
    isResponseRequired: question.isResponseRequired === true,
    options: Array.isArray(question.options) ? [...question.options] : [],
  };
}

function sanitizePublicListingSnapshot(snapshot) {
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

    minimumYearsOfExperience: snapshot.minimumYearsOfExperience ?? 0,

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

    vacancyCount: snapshot.vacancyCount ?? null,

    employmentStartDate: snapshot.employmentStartDate || null,

    screeningQuestions: (Array.isArray(snapshot.screeningQuestions)
      ? snapshot.screeningQuestions
      : []
    )
      .map((question) => sanitizePublicScreeningQuestion(question))
      .filter(Boolean),

    capturedAt: snapshot.capturedAt || null,
  };
}

function sanitizePublicEmployerSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  return {
    snapshotVersion: snapshot.snapshotVersion || null,

    businessName: snapshot.businessName || null,

    type: snapshot.type || null,

    logoUrl: snapshot.logoUrl || null,

    publicDescription: snapshot.publicDescription || null,

    websiteUrl: snapshot.websiteUrl || null,

    cacVerified: snapshot.cacVerified === true,

    regulatoryVerified: snapshot.regulatoryVerified === true,

    branchName: snapshot.branchName || null,

    branchAddress: snapshot.branchAddress || null,

    branchState: snapshot.branchState || null,

    branchLga: snapshot.branchLga || null,
  };
}

function sanitizePublicPublication(publication) {
  if (!publication || typeof publication !== "object") {
    return null;
  }

  return {
    _id: publication._id,

    job: publication.job,

    status: publication.status,

    employerSnapshot: sanitizePublicEmployerSnapshot(publication.employerSnapshot),

    listingSnapshot: sanitizePublicListingSnapshot(publication.listingSnapshot),

    applicationDeadline: publication.applicationDeadline || null,

    publishedAt: publication.publishedAt || null,

    expiresAt: publication.expiresAt || null,

    createdAt: publication.createdAt || null,

    updatedAt: publication.updatedAt || null,
  };
}

/* ─────────────────────────────── QUERY SERVICE ─────────────────────────────── */

class JobQueryService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createJobQueryError({
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

  static normalizeOptionalObjectId(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,

      fieldName,

      createError: createJobQueryError,
    });
  }

  static normalizeRecruitmentStatusFilter(value) {
    const status = normalizeStringFilter(value);

    const allowedStatuses = getEnumValues(Job, "recruitmentStatus");

    return status === "all" || allowedStatuses.includes(status) ? status : "all";
  }

  static normalizePublicationStatusFilter(value) {
    const status = normalizeStringFilter(value);

    const allowedStatuses = getEnumValues(Job, "publicationStatus");

    return status === "all" || allowedStatuses.includes(status) ? status : "all";
  }

  static normalizeMarketplaceEnumFilter(value, snapshotField) {
    const normalized = normalizeStringFilter(value);

    if (normalized === "all") {
      return "all";
    }

    const jobField = snapshotField.replace(/^listingSnapshot\./, "");

    const allowedValues = getEnumValues(Job, jobField);

    return !allowedValues.length || allowedValues.includes(normalized) ? normalized : "all";
  }

  /* ─────────────────────────────── EMPLOYER READ ACCESS ─────────────────────────────── */

  static canViewAllBranches(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static canManageAllBranches(employerContext = null) {
    return JobQueryService.canViewAllBranches(employerContext);
  }

  static canViewJobs(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true ||
      employerContext?.isBranchStaff === true
    );
  }

  static canManageJobs(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true
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
    if (!JobQueryService.canViewJobs(employerContext)) {
      throw createJobQueryError({
        message: "You do not have permission to view permanent Jobs.",

        code: "JOB_VIEW_NOT_ALLOWED",

        statusCode: 403,
      });
    }

    const normalizedUserId = normalizeObjectId({
      value: userId,

      fieldName: "user ID",

      createError: createJobQueryError,
    });

    if (!employerProfile?._id) {
      throw createJobQueryError({
        message: "Employer profile context is unavailable.",

        code: "EMPLOYER_PROFILE_CONTEXT_REQUIRED",

        statusCode: 500,
      });
    }

    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfile._id,

      fieldName: "employer profile ID",

      createError: createJobQueryError,
    });

    const profile = await EmployerProfile.findById(normalizedEmployerProfileId)
      .select("user businessName countryCode currency")
      .lean();

    if (!profile) {
      throw createJobQueryError({
        message: "Employer profile not found.",

        code: "EMPLOYER_PROFILE_NOT_FOUND",

        statusCode: 404,
      });
    }

    const isPrimaryEmployer = profile.user && String(profile.user) === String(normalizedUserId);

    if (isPrimaryEmployer) {
      if (employerContext?.isPrimaryEmployer !== true) {
        throw createJobQueryError({
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
      throw createJobQueryError({
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
      throw createJobQueryError({
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
        throw createJobQueryError({
          message: "Your employer branch access context is invalid.",

          code: "EMPLOYER_BRANCH_ACCESS_CONTEXT_INVALID",

          statusCode: 403,
        });
      }
    }

    return profile;
  }

  static buildAccessibleJobFilter({
    employerProfileId,
    employerContext = null,
    jobId = null,
    branchId = null,
  }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,

      fieldName: "employer profile ID",

      createError: createJobQueryError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
    };

    if (jobId) {
      filter._id = normalizeObjectId({
        value: jobId,

        fieldName: "Job ID",

        createError: createJobQueryError,
      });
    }

    const normalizedBranchId = JobQueryService.normalizeOptionalObjectId(branchId, "branch ID");

    if (JobQueryService.canViewAllBranches(employerContext)) {
      if (normalizedBranchId) {
        filter.branch = normalizedBranchId;
      }

      return filter;
    }

    const assignedBranchIds = JobQueryService.getAssignedBranchObjectIds(employerContext);

    if (normalizedBranchId) {
      const hasBranchAccess = assignedBranchIds.some(
        (assignedBranchId) => String(assignedBranchId) === String(normalizedBranchId)
      );

      if (!hasBranchAccess) {
        throw createJobQueryError({
          message: "You do not have access to this branch.",

          code: "JOB_BRANCH_ACCESS_NOT_ALLOWED",

          statusCode: 403,
        });
      }

      filter.branch = normalizedBranchId;

      return filter;
    }

    filter.branch = {
      $in: assignedBranchIds,
    };

    return filter;
  }

  static async getAccessibleBranches({ employerProfileId, employerContext = null }) {
    const filter = {
      business: normalizeObjectId({
        value: employerProfileId,

        fieldName: "employer profile ID",

        createError: createJobQueryError,
      }),

      isActive: true,
    };

    if (!JobQueryService.canViewAllBranches(employerContext)) {
      filter._id = {
        $in: JobQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return Branch.find(filter)
      .select("name address state lga isActive")
      .sort({
        name: 1,

        _id: 1,
      })
      .lean();
  }

  /* ─────────────────────────────── PROFESSIONAL READ ACCESS ─────────────────────────────── */

  static async getProfessionalProfileForRead({ userId, professionalProfile = null }) {
    const normalizedUserId = normalizeObjectId({
      value: userId,

      fieldName: "user ID",

      createError: createJobQueryError,
    });

    if (!professionalProfile?._id) {
      throw createJobQueryError({
        message: "Professional profile context is unavailable.",

        code: "PROFESSIONAL_PROFILE_CONTEXT_REQUIRED",

        statusCode: 500,
      });
    }

    const normalizedProfessionalProfileId = normalizeObjectId({
      value: professionalProfile._id,

      fieldName: "professional profile ID",

      createError: createJobQueryError,
    });

    const profile = await ProfessionalProfile.findById(normalizedProfessionalProfileId)
      .select("user type specialty")
      .lean();

    if (!profile) {
      throw createJobQueryError({
        message: "Professional profile not found.",

        code: "PROFESSIONAL_PROFILE_NOT_FOUND",

        statusCode: 404,
      });
    }

    if (!profile.user || String(profile.user) !== String(normalizedUserId)) {
      throw createJobQueryError({
        message: "You are not authorized for this professional profile.",

        code: "PROFESSIONAL_PROFILE_ACCESS_NOT_ALLOWED",

        statusCode: 403,
      });
    }

    return profile;
  }

  static async getOptionalProfessionalProfileForRead({
    userId = null,
    professionalProfile = null,
  } = {}) {
    if (!userId && !professionalProfile) {
      return null;
    }

    if (!userId || !professionalProfile) {
      throw createJobQueryError({
        message: "Professional authentication context is incomplete.",

        code: "PROFESSIONAL_CONTEXT_INCOMPLETE",

        statusCode: 500,
      });
    }

    return JobQueryService.getProfessionalProfileForRead({
      userId,

      professionalProfile,
    });
  }

  /* ─────────────────────────────── EMPLOYER JOBS ─────────────────────────────── */

  static applyJobFilters(
    baseFilter,
    { recruitmentStatus = "all", publicationStatus = "all", search = null } = {}
  ) {
    const filter = {
      ...baseFilter,
    };

    if (recruitmentStatus !== "all") {
      filter.recruitmentStatus = recruitmentStatus;
    }

    if (publicationStatus !== "all") {
      filter.publicationStatus = publicationStatus;
    }

    const normalizedSearch = normalizeOptionalText(search);

    if (normalizedSearch) {
      const searchRegex = new RegExp(escapeRegex(normalizedSearch), "i");

      filter.$or = [
        {
          roleTitle: searchRegex,
        },

        {
          professionalType: searchRegex,
        },

        {
          specialty: searchRegex,
        },

        {
          department: searchRegex,
        },

        {
          state: searchRegex,
        },

        {
          lga: searchRegex,
        },
      ];
    }

    return filter;
  }

  static buildEmployerJobQuery(filter) {
    return Job.find(filter)
      .populate("branch", "name address state lga isActive")
      .populate(
        "currentPublication",
        "job cycleNumber status applicationDeadline publishedAt expiresAt pauseHistory endedAt createdAt updatedAt"
      );
  }

  static async getEmployerJobsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    recruitmentStatus = "all",
    publicationStatus = "all",
    branchId = null,
    search = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const selectedRecruitmentStatus =
      JobQueryService.normalizeRecruitmentStatusFilter(recruitmentStatus);

    const selectedPublicationStatus =
      JobQueryService.normalizePublicationStatusFilter(publicationStatus);

    const selectedBranchId = JobQueryService.normalizeOptionalObjectId(branchId, "branch ID");

    const selectedSearch = normalizeOptionalText(search);

    const requestedPage = JobQueryService.normalizePageNumber(page);

    const profile = await JobQueryService.getEmployerProfileForRead({
      userId,

      employerProfile,

      employerContext,
    });

    const scopeFilter = JobQueryService.buildAccessibleJobFilter({
      employerProfileId: profile._id,

      employerContext,

      branchId: selectedBranchId,
    });

    const recruitmentCountMatch = JobQueryService.applyJobFilters(scopeFilter, {
      publicationStatus: selectedPublicationStatus,

      search: selectedSearch,
    });

    const publicationCountMatch = JobQueryService.applyJobFilters(scopeFilter, {
      recruitmentStatus: selectedRecruitmentStatus,

      search: selectedSearch,
    });

    const filteredJobFilter = JobQueryService.applyJobFilters(scopeFilter, {
      recruitmentStatus: selectedRecruitmentStatus,

      publicationStatus: selectedPublicationStatus,

      search: selectedSearch,
    });

    const [
      totalFilteredJobs,

      totalForRecruitmentTabs,

      recruitmentCountResults,

      totalForPublicationTabs,

      publicationCountResults,

      branches,
    ] = await Promise.all([
      Job.countDocuments(filteredJobFilter),

      Job.countDocuments(recruitmentCountMatch),

      Job.aggregate([
        {
          $match: recruitmentCountMatch,
        },

        {
          $group: {
            _id: "$recruitmentStatus",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      Job.countDocuments(publicationCountMatch),

      Job.aggregate([
        {
          $match: publicationCountMatch,
        },

        {
          $group: {
            _id: "$publicationStatus",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      JobQueryService.getAccessibleBranches({
        employerProfileId: profile._id,

        employerContext,
      }),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredJobs / JOBS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * JOBS_PER_PAGE;

    const jobs =
      totalFilteredJobs > 0
        ? await JobQueryService.buildEmployerJobQuery(filteredJobFilter)
            .sort({
              updatedAt: -1,

              createdAt: -1,

              _id: -1,
            })
            .skip(skip)
            .limit(JOBS_PER_PAGE)
            .lean()
        : [];

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode || null,

        currency: profile.currency || null,
      },

      jobs,

      branches,

      selectedRecruitmentStatus,

      selectedPublicationStatus,

      selectedBranchId: selectedBranchId ? String(selectedBranchId) : null,

      selectedSearch,

      recruitmentStatusCounts: buildGroupedCountMap(
        recruitmentCountResults,
        totalForRecruitmentTabs
      ),

      publicationStatusCounts: buildGroupedCountMap(
        publicationCountResults,
        totalForPublicationTabs
      ),

      canViewJobs: JobQueryService.canViewJobs(employerContext),

      canManageJobs: JobQueryService.canManageJobs(employerContext),

      canViewAllBranches: JobQueryService.canViewAllBranches(employerContext),

      canManageAllBranches: JobQueryService.canManageAllBranches(employerContext),

      currentTime: normalizedCurrentTime,

      pagination: buildPagination({
        page: currentPage,

        totalItems: totalFilteredJobs,

        perPage: JOBS_PER_PAGE,

        itemCount: jobs.length,
      }),
    };
  }

  static async getEmployerJobDetailData({
    userId,
    employerProfile = null,
    employerContext = null,
    jobId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const profile = await JobQueryService.getEmployerProfileForRead({
      userId,

      employerProfile,

      employerContext,
    });

    const filter = JobQueryService.buildAccessibleJobFilter({
      employerProfileId: profile._id,

      employerContext,

      jobId,
    });

    const job = await JobQueryService.buildEmployerJobQuery(filter).lean();

    if (!job) {
      throw createJobQueryError({
        message: "Job was not found or is not available to you.",

        code: "JOB_NOT_FOUND",

        statusCode: 404,
      });
    }

    const publications = await JobPublication.find({
      job: job._id,
    })
      .select(
        "job cycleNumber status applicationDeadline publishedAt expiresAt pauseHistory endedAt createdAt updatedAt"
      )
      .sort({
        publishedAt: -1,

        createdAt: -1,

        _id: -1,
      })
      .lean();

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode || null,

        currency: profile.currency || null,
      },

      job,

      publications,

      canViewJobs: JobQueryService.canViewJobs(employerContext),

      canManageJobs: JobQueryService.canManageJobs(employerContext),

      canViewAllBranches: JobQueryService.canViewAllBranches(employerContext),

      canManageAllBranches: JobQueryService.canManageAllBranches(employerContext),

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── ADMIN JOB OVERSIGHT ─────────────────────────────── */

  /**
   * These methods expose platform-admin read access only.
   *
   * Authentication / platform-admin authorization belongs to the admin route
   * middleware and controller layer. These queries do not manufacture employer
   * context and do not grant employer mutation authority.
   */
  static buildAdminJobScopeFilter({ employerProfileId = null, branchId = null } = {}) {
    const filter = {};

    const normalizedEmployerProfileId = JobQueryService.normalizeOptionalObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedBranchId = JobQueryService.normalizeOptionalObjectId(branchId, "branch ID");

    if (normalizedEmployerProfileId) {
      filter.business = normalizedEmployerProfileId;
    }

    if (normalizedBranchId) {
      filter.branch = normalizedBranchId;
    }

    return {
      filter,

      employerProfileId: normalizedEmployerProfileId,

      branchId: normalizedBranchId,
    };
  }

  static buildAdminJobQuery(filter) {
    return Job.find(filter)
      .populate(
        "business",
        "businessName type countryCode currency accountStatus employerApprovalStatus logoUrl"
      )
      .populate("branch", "name address state lga isActive")
      .populate(
        "currentPublication",
        "job cycleNumber status applicationDeadline publishedAt expiresAt pauseHistory endedAt endReason createdAt updatedAt"
      );
  }

  static async getAdminJobsPageData({
    employerProfileId = null,
    recruitmentStatus = "all",
    publicationStatus = "all",
    branchId = null,
    search = null,
    page = 1,
    currentTime = new Date(),
  } = {}) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const selectedRecruitmentStatus =
      JobQueryService.normalizeRecruitmentStatusFilter(recruitmentStatus);

    const selectedPublicationStatus =
      JobQueryService.normalizePublicationStatusFilter(publicationStatus);

    const selectedSearch = normalizeOptionalText(search);

    const requestedPage = JobQueryService.normalizePageNumber(page);

    const adminScope = JobQueryService.buildAdminJobScopeFilter({
      employerProfileId,

      branchId,
    });

    const recruitmentCountMatch = JobQueryService.applyJobFilters(adminScope.filter, {
      publicationStatus: selectedPublicationStatus,

      search: selectedSearch,
    });

    const publicationCountMatch = JobQueryService.applyJobFilters(adminScope.filter, {
      recruitmentStatus: selectedRecruitmentStatus,

      search: selectedSearch,
    });

    const filteredJobFilter = JobQueryService.applyJobFilters(adminScope.filter, {
      recruitmentStatus: selectedRecruitmentStatus,

      publicationStatus: selectedPublicationStatus,

      search: selectedSearch,
    });

    const selectedEmployerQuery = adminScope.employerProfileId
      ? EmployerProfile.findById(adminScope.employerProfileId)
          .select(
            "businessName type countryCode currency accountStatus employerApprovalStatus logoUrl"
          )
          .lean()
      : Promise.resolve(null);

    const branchesQuery = adminScope.employerProfileId
      ? Branch.find({
          business: adminScope.employerProfileId,
        })
          .select("name address state lga isActive")
          .sort({
            name: 1,

            _id: 1,
          })
          .lean()
      : Promise.resolve([]);

    const [
      totalFilteredJobs,

      totalForRecruitmentTabs,

      recruitmentCountResults,

      totalForPublicationTabs,

      publicationCountResults,

      selectedEmployer,

      branches,
    ] = await Promise.all([
      Job.countDocuments(filteredJobFilter),

      Job.countDocuments(recruitmentCountMatch),

      Job.aggregate([
        {
          $match: recruitmentCountMatch,
        },

        {
          $group: {
            _id: "$recruitmentStatus",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      Job.countDocuments(publicationCountMatch),

      Job.aggregate([
        {
          $match: publicationCountMatch,
        },

        {
          $group: {
            _id: "$publicationStatus",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      selectedEmployerQuery,

      branchesQuery,
    ]);

    if (adminScope.employerProfileId && !selectedEmployer) {
      throw createJobQueryError({
        message: "Employer profile not found.",

        code: "EMPLOYER_PROFILE_NOT_FOUND",

        statusCode: 404,
      });
    }

    const totalPages = Math.max(Math.ceil(totalFilteredJobs / JOBS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * JOBS_PER_PAGE;

    const jobs =
      totalFilteredJobs > 0
        ? await JobQueryService.buildAdminJobQuery(filteredJobFilter)
            .sort({
              updatedAt: -1,

              createdAt: -1,

              _id: -1,
            })
            .skip(skip)
            .limit(JOBS_PER_PAGE)
            .lean()
        : [];

    return {
      jobs,

      selectedEmployer: selectedEmployer
        ? {
            id: String(selectedEmployer._id),

            businessName: selectedEmployer.businessName || "Employer",

            type: selectedEmployer.type || null,

            countryCode: selectedEmployer.countryCode || null,

            currency: selectedEmployer.currency || null,

            accountStatus: selectedEmployer.accountStatus || null,

            employerApprovalStatus: selectedEmployer.employerApprovalStatus || null,

            logoUrl: selectedEmployer.logoUrl || null,
          }
        : null,

      branches,

      selectedEmployerProfileId: adminScope.employerProfileId
        ? String(adminScope.employerProfileId)
        : null,

      selectedRecruitmentStatus,

      selectedPublicationStatus,

      selectedBranchId: adminScope.branchId ? String(adminScope.branchId) : null,

      selectedSearch,

      recruitmentStatusCounts: buildGroupedCountMap(
        recruitmentCountResults,
        totalForRecruitmentTabs
      ),

      publicationStatusCounts: buildGroupedCountMap(
        publicationCountResults,
        totalForPublicationTabs
      ),

      currentTime: normalizedCurrentTime,

      pagination: buildPagination({
        page: currentPage,

        totalItems: totalFilteredJobs,

        perPage: JOBS_PER_PAGE,

        itemCount: jobs.length,
      }),
    };
  }

  static async getAdminJobDetailData({ jobId, currentTime = new Date() }) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const normalizedJobId = normalizeObjectId({
      value: jobId,

      fieldName: "Job ID",

      createError: createJobQueryError,
    });

    const job = await JobQueryService.buildAdminJobQuery({
      _id: normalizedJobId,
    }).lean();

    if (!job) {
      throw createJobQueryError({
        message: "Job not found.",

        code: "JOB_NOT_FOUND",

        statusCode: 404,
      });
    }

    const publications = await JobPublication.find({
      job: normalizedJobId,
    })
      .sort({
        cycleNumber: -1,

        publishedAt: -1,

        _id: -1,
      })
      .lean();

    return {
      job,

      publications,

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── MARKETPLACE ─────────────────────────────── */

  static buildMarketplaceBaseFilter(currentTime) {
    return {
      status: "live",

      expiresAt: {
        $gt: currentTime,
      },
    };
  }

  static applyMarketplaceFilters(
    baseFilter,
    {
      search = null,
      professionalType = "all",
      employmentType = "all",
      workplaceType = "all",
      state = null,
      lga = null,
    } = {}
  ) {
    const filter = {
      ...baseFilter,
    };

    if (professionalType !== "all") {
      filter["listingSnapshot.professionalType"] = professionalType;
    }

    if (employmentType !== "all") {
      filter["listingSnapshot.employmentType"] = employmentType;
    }

    if (workplaceType !== "all") {
      filter["listingSnapshot.workplaceType"] = workplaceType;
    }

    const normalizedState = normalizeOptionalText(state);

    const normalizedLga = normalizeOptionalText(lga);

    if (normalizedState) {
      filter["listingSnapshot.state"] = new RegExp(`^${escapeRegex(normalizedState)}$`, "i");
    }

    if (normalizedLga) {
      filter["listingSnapshot.lga"] = new RegExp(`^${escapeRegex(normalizedLga)}$`, "i");
    }

    const normalizedSearch = normalizeOptionalText(search);

    if (normalizedSearch) {
      const searchRegex = new RegExp(escapeRegex(normalizedSearch), "i");

      filter.$or = [
        {
          "listingSnapshot.roleTitle": searchRegex,
        },

        {
          "listingSnapshot.professionalType": searchRegex,
        },

        {
          "listingSnapshot.specialty": searchRegex,
        },

        {
          "listingSnapshot.department": searchRegex,
        },

        {
          "listingSnapshot.state": searchRegex,
        },

        {
          "listingSnapshot.lga": searchRegex,
        },

        {
          "employerSnapshot.businessName": searchRegex,
        },

        {
          "employerSnapshot.branchName": searchRegex,
        },
      ];
    }

    return filter;
  }

  static selectPublicPublicationFields(query) {
    return query.select(
      "job status employerSnapshot listingSnapshot applicationDeadline publishedAt expiresAt createdAt updatedAt"
    );
  }

  static async getSavedJobIdSet({ professionalProfileId, jobIds = [] }) {
    if (!professionalProfileId || !Array.isArray(jobIds) || !jobIds.length) {
      return new Set();
    }

    const savedJobs = await SavedJob.find({
      professional: professionalProfileId,

      job: {
        $in: jobIds,
      },
    })
      .select("job")
      .lean();

    return new Set(savedJobs.map((savedJob) => String(savedJob.job)));
  }

  static async getAppliedJobIdSet({ professionalProfileId, jobIds = [] }) {
    if (!professionalProfileId || !Array.isArray(jobIds) || !jobIds.length) {
      return new Set();
    }

    const applications = await JobApplication.find({
      professional: professionalProfileId,

      job: {
        $in: jobIds,
      },
    })
      .select("job")
      .lean();

    return new Set(applications.map((application) => String(application.job)));
  }

  static async getMarketplacePublicationPage({ filter, page }) {
    const requestedPage = JobQueryService.normalizePageNumber(page);

    const preliminaryTotal = await JobPublication.countDocuments(filter);

    const preliminaryTotalPages = Math.max(Math.ceil(preliminaryTotal / JOBS_PER_PAGE), 1);

    const preliminaryPage = Math.min(requestedPage, preliminaryTotalPages);

    const preliminarySkip = (preliminaryPage - 1) * JOBS_PER_PAGE;

    const [result] = await JobPublication.aggregate([
      {
        $match: filter,
      },

      {
        $lookup: {
          from: Job.collection.name,

          localField: "job",

          foreignField: "_id",

          as: "jobRecord",
        },
      },

      {
        $unwind: "$jobRecord",
      },

      {
        $match: {
          "jobRecord.recruitmentStatus": "active",

          "jobRecord.publicationStatus": "live",

          $expr: {
            $eq: ["$jobRecord.currentPublication", "$_id"],
          },
        },
      },

      {
        $sort: {
          publishedAt: -1,

          _id: -1,
        },
      },

      {
        $facet: {
          items: [
            {
              $skip: preliminarySkip,
            },

            {
              $limit: JOBS_PER_PAGE,
            },

            {
              $project: {
                jobRecord: 0,

                entitlementSnapshot: 0,

                deadlineHistory: 0,

                pauseHistory: 0,

                publishedBy: 0,

                endedBy: 0,

                endReason: 0,

                applicationCount: 0,

                applicationCountLastReconciledAt: 0,
              },
            },
          ],

          meta: [
            {
              $count: "total",
            },
          ],
        },
      },
    ]);

    const totalItems = Number(result?.meta?.[0]?.total || 0);

    const totalPages = Math.max(Math.ceil(totalItems / JOBS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    if (currentPage !== preliminaryPage && totalItems > 0) {
      return JobQueryService.getMarketplacePublicationPage({
        filter,

        page: currentPage,
      });
    }

    const publications = (result?.items || [])
      .map((publication) => sanitizePublicPublication(publication))
      .filter(Boolean);

    return {
      publications,

      pagination: buildPagination({
        page: currentPage,

        totalItems,

        perPage: JOBS_PER_PAGE,

        itemCount: publications.length,
      }),
    };
  }

  static async getMarketplaceJobsPageData({
    userId = null,
    professionalProfile = null,
    search = null,
    professionalType = "all",
    employmentType = "all",
    workplaceType = "all",
    state = null,
    lga = null,
    page = 1,
    currentTime = new Date(),
  } = {}) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const selectedSearch = normalizeOptionalText(search);

    const selectedProfessionalType = JobQueryService.normalizeMarketplaceEnumFilter(
      professionalType,
      "listingSnapshot.professionalType"
    );

    const selectedEmploymentType = JobQueryService.normalizeMarketplaceEnumFilter(
      employmentType,
      "listingSnapshot.employmentType"
    );

    const selectedWorkplaceType = JobQueryService.normalizeMarketplaceEnumFilter(
      workplaceType,
      "listingSnapshot.workplaceType"
    );

    const selectedState = normalizeOptionalText(state);

    const selectedLga = normalizeOptionalText(lga);

    const professional = await JobQueryService.getOptionalProfessionalProfileForRead({
      userId,

      professionalProfile,
    });

    const filter = JobQueryService.applyMarketplaceFilters(
      JobQueryService.buildMarketplaceBaseFilter(normalizedCurrentTime),
      {
        search: selectedSearch,

        professionalType: selectedProfessionalType,

        employmentType: selectedEmploymentType,

        workplaceType: selectedWorkplaceType,

        state: selectedState,

        lga: selectedLga,
      }
    );

    const { publications, pagination } = await JobQueryService.getMarketplacePublicationPage({
      filter,

      page,
    });

    const jobIds = publications.map((publication) => publication.job).filter(Boolean);

    const [savedJobIds, appliedJobIds] = professional
      ? await Promise.all([
          JobQueryService.getSavedJobIdSet({
            professionalProfileId: professional._id,

            jobIds,
          }),

          JobQueryService.getAppliedJobIdSet({
            professionalProfileId: professional._id,

            jobIds,
          }),
        ])
      : [new Set(), new Set()];

    const items = publications.map((publication) => {
      const jobId = publication.job ? String(publication.job) : null;

      return {
        publication,

        isSaved: jobId ? savedJobIds.has(jobId) : false,

        hasApplied: jobId ? appliedJobIds.has(jobId) : false,
      };
    });

    return {
      items,

      selectedSearch,

      selectedProfessionalType,

      selectedEmploymentType,

      selectedWorkplaceType,

      selectedState,

      selectedLga,

      professional: professional
        ? {
            id: String(professional._id),

            type: professional.type || null,

            specialty: professional.specialty || null,
          }
        : null,

      currentTime: normalizedCurrentTime,

      pagination: {
        ...pagination,

        itemCount: items.length,
      },
    };
  }

  static async getMarketplaceJobDetailData({
    publicationId,
    userId = null,
    professionalProfile = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const normalizedPublicationId = normalizeObjectId({
      value: publicationId,

      fieldName: "Job publication ID",

      createError: createJobQueryError,
    });

    const professional = await JobQueryService.getOptionalProfessionalProfileForRead({
      userId,

      professionalProfile,
    });

    const rawPublication = await JobQueryService.selectPublicPublicationFields(
      JobPublication.findOne({
        _id: normalizedPublicationId,

        ...JobQueryService.buildMarketplaceBaseFilter(normalizedCurrentTime),
      })
    ).lean();

    if (!rawPublication) {
      throw createJobQueryError({
        message: "Job listing not found.",

        code: "JOB_PUBLICATION_NOT_FOUND",

        statusCode: 404,
      });
    }

    const currentJob = await Job.findOne({
      _id: rawPublication.job,

      recruitmentStatus: "active",

      publicationStatus: "live",

      currentPublication: rawPublication._id,
    })
      .select("_id")
      .lean();

    if (!currentJob) {
      throw createJobQueryError({
        message: "Job listing not found.",

        code: "JOB_PUBLICATION_NOT_FOUND",

        statusCode: 404,
      });
    }

    const publication = sanitizePublicPublication(rawPublication);

    let isSaved = false;

    let hasApplied = false;

    if (professional && publication?.job) {
      const [saved, applied] = await Promise.all([
        SavedJob.exists({
          professional: professional._id,

          job: publication.job,
        }),

        JobApplication.exists({
          professional: professional._id,

          job: publication.job,
        }),
      ]);

      isSaved = Boolean(saved);

      hasApplied = Boolean(applied);
    }

    return {
      publication,

      isSaved,

      hasApplied,

      professional: professional
        ? {
            id: String(professional._id),

            type: professional.type || null,

            specialty: professional.specialty || null,
          }
        : null,

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── SAVED JOBS ─────────────────────────────── */

  static async getProfessionalSavedJobsPageData({
    userId,
    professionalProfile = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobQueryService.normalizeCurrentTime(currentTime);

    const requestedPage = JobQueryService.normalizePageNumber(page);

    const professional = await JobQueryService.getProfessionalProfileForRead({
      userId,

      professionalProfile,
    });

    const savedFilter = {
      professional: professional._id,
    };

    const totalSavedJobs = await SavedJob.countDocuments(savedFilter);

    const totalPages = Math.max(Math.ceil(totalSavedJobs / JOBS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * JOBS_PER_PAGE;

    const savedJobs =
      totalSavedJobs > 0
        ? await SavedJob.find(savedFilter)
            .sort({
              savedAt: -1,

              _id: -1,
            })
            .skip(skip)
            .limit(JOBS_PER_PAGE)
            .lean()
        : [];

    const jobIds = savedJobs.map((savedJob) => savedJob.job).filter(Boolean);

    const [rawPublications, currentJobs, appliedJobIds] = jobIds.length
      ? await Promise.all([
          JobQueryService.selectPublicPublicationFields(
            JobPublication.find({
              job: {
                $in: jobIds,
              },
            })
          )
            .sort({
              publishedAt: -1,

              createdAt: -1,

              _id: -1,
            })
            .lean(),

          Job.find({
            _id: {
              $in: jobIds,
            },
          })
            .select("_id recruitmentStatus publicationStatus currentPublication")
            .lean(),

          JobQueryService.getAppliedJobIdSet({
            professionalProfileId: professional._id,

            jobIds,
          }),
        ])
      : [[], [], new Set()];

    const latestPublicationByJobId = new Map();

    for (const rawPublication of rawPublications) {
      if (!rawPublication.job) {
        continue;
      }

      const jobId = String(rawPublication.job);

      if (!latestPublicationByJobId.has(jobId)) {
        latestPublicationByJobId.set(
          jobId,

          sanitizePublicPublication(rawPublication)
        );
      }
    }

    const currentJobById = new Map(currentJobs.map((job) => [String(job._id), job]));

    const items = savedJobs.map((savedJob) => {
      const jobId = String(savedJob.job);

      const publication = latestPublicationByJobId.get(jobId) || null;

      const currentJob = currentJobById.get(jobId) || null;

      const isCurrentlyPublic = Boolean(
        publication &&
        currentJob &&
        publication.status === "live" &&
        publication.expiresAt &&
        new Date(publication.expiresAt) > normalizedCurrentTime &&
        currentJob.recruitmentStatus === "active" &&
        currentJob.publicationStatus === "live" &&
        currentJob.currentPublication &&
        String(currentJob.currentPublication) === String(publication._id)
      );

      return {
        savedJob,

        publication,

        isCurrentlyPublic,

        hasApplied: appliedJobIds.has(jobId),
      };
    });

    return {
      professional: {
        id: String(professional._id),

        type: professional.type || null,

        specialty: professional.specialty || null,
      },

      items,

      currentTime: normalizedCurrentTime,

      pagination: buildPagination({
        page: currentPage,

        totalItems: totalSavedJobs,

        perPage: JOBS_PER_PAGE,

        itemCount: items.length,
      }),
    };
  }

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createJobQueryError(options) {
    return createJobQueryError(options);
  }
}

module.exports = JobQueryService;
