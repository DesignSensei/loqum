// services/jobs/appointments/jobAppointmentQueryService.js

const Appointment = require("../../../models/Appointment");

const Job = require("../../../models/Job");

const JobApplication = require("../../../models/JobApplication");

const ProfessionalProfile = require("../../../models/ProfessionalProfile");

const JobApplicationQueryService = require("../applications/jobApplicationQueryService");

const { createServiceError } = require("../../helpers/serviceErrorHelper");

const { normalizeObjectId } = require("../../helpers/serviceValidationHelpers");

const JOB_APPOINTMENT_QUERY_SERVICE_ERROR_NAME = "JobAppointmentQueryServiceError";

const APPOINTMENTS_PER_PAGE = 20;

const AWAITING_EMPLOYER_UPDATE_STATUS = "awaiting_employer_update";

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

const JOB_FIELDS = [
  "referenceCode",
  "business",
  "branch",
  "roleTitle",
  "professionalType",
  "specialty",
  "department",
  "employmentType",
  "workplaceType",
  "state",
  "lga",
  "recruitmentStatus",
  "publicationStatus",
  "currentPublication",
  "createdAt",
  "updatedAt",
];

const APPLICATION_FIELDS = [
  "job",
  "publication",
  "professional",
  "status",
  "candidateSnapshot",
  "resumeSnapshot",
  "coverNote",
  "screeningAnswers",
  "submittedAt",
  "statusUpdatedAt",
  "offeredAt",
  "hiredAt",
  "rejectedAt",
  "withdrawnAt",
  "createdAt",
  "updatedAt",
];

const PUBLICATION_FIELDS = [
  "job",
  "cycleNumber",
  "status",
  "employerSnapshot",
  "listingSnapshot",
  "applicationDeadline",
  "publishedAt",
  "expiresAt",
  "pauseHistory",
  "endedAt",
  "createdAt",
  "updatedAt",
];

/* ─────────────────────────────── ERROR CONTRACT ─────────────────────────────── */

function createAppointmentQueryError(options) {
  return createServiceError({
    ...options,
    name: JOB_APPOINTMENT_QUERY_SERVICE_ERROR_NAME,
  });
}

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getExistingFields(model, fieldNames = []) {
  return fieldNames.filter((fieldName) => Boolean(model?.schema?.path(fieldName)));
}

function getEnumValues(model, path) {
  const enumValues = model?.schema?.path(path)?.enumValues;

  return Array.isArray(enumValues) ? enumValues : [];
}

function getApplicationPublicationPath() {
  return JobApplication.schema.path("publication") ? "publication" : null;
}

function normalizeApplicationPublicationAlias(application) {
  return application;
}

function deriveAppointmentState(appointment, currentTime) {
  if (!appointment || typeof appointment !== "object") {
    return appointment;
  }

  if (appointment.jobApplication && typeof appointment.jobApplication === "object") {
    normalizeApplicationPublicationAlias(appointment.jobApplication);
  }

  const endAt = appointment.endAt ? new Date(appointment.endAt) : null;

  const awaitingEmployerUpdate = Boolean(
    appointment.status === "scheduled" &&
    endAt &&
    !Number.isNaN(endAt.getTime()) &&
    endAt < currentTime
  );

  return {
    ...appointment,
    awaitingEmployerUpdate,
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

/* ─────────────────────────────── QUERY SERVICE ─────────────────────────────── */

class JobAppointmentQueryService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createAppointmentQueryError({
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

    const allowedStatuses = getEnumValues(Appointment, "status");

    return status === "all" ||
      status === AWAITING_EMPLOYER_UPDATE_STATUS ||
      allowedStatuses.includes(status)
      ? status
      : "all";
  }

  static normalizeResponseStatusFilter(value) {
    const responseStatus = String(value || "all")
      .trim()
      .toLowerCase();

    const allowedStatuses = getEnumValues(Appointment, "responseStatus");

    return responseStatus === "all" || allowedStatuses.includes(responseStatus)
      ? responseStatus
      : "all";
  }

  static normalizeOptionalApplicationId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,
      fieldName: "Job application ID",
      createError: createAppointmentQueryError,
    });
  }

  static normalizeOptionalEmployerProfileId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,
      fieldName: "employer profile ID",
      createError: createAppointmentQueryError,
    });
  }

  static normalizeAppointmentId(value) {
    return normalizeObjectId({
      value,
      fieldName: "appointment ID",
      createError: createAppointmentQueryError,
    });
  }

  /* ─────────────────────────────── CAPABILITIES ─────────────────────────────── */

  static canViewAppointments(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true ||
      employerContext?.isBranchStaff === true
    );
  }

  static canManageAppointments(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true
    );
  }

  /* ─────────────────────────────── POPULATION ─────────────────────────────── */

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

  static buildApplicationPopulate() {
    const applicationFields = getExistingFields(JobApplication, APPLICATION_FIELDS);

    const publicationPath = getApplicationPublicationPath();

    const populate = {
      path: "jobApplication",
    };

    if (applicationFields.length) {
      populate.select = applicationFields.join(" ");
    }

    if (publicationPath) {
      populate.populate = {
        path: publicationPath,

        select: PUBLICATION_FIELDS.join(" "),
      };
    }

    return populate;
  }

  static buildAdminJobPopulate() {
    const jobFields = getExistingFields(Job, JOB_FIELDS);

    const nestedPopulate = [];

    if (Job.schema.path("branch")) {
      nestedPopulate.push({
        path: "branch",

        select: "name address state lga isActive",
      });
    }

    if (Job.schema.path("business")) {
      nestedPopulate.push({
        path: "business",

        select:
          "businessName type countryCode currency logoUrl accountStatus employerApprovalStatus",
      });
    }

    return {
      path: "job",

      select: jobFields.length ? jobFields.join(" ") : undefined,

      populate: nestedPopulate.length ? nestedPopulate : undefined,
    };
  }

  static buildEmployerAppointmentQuery(filter) {
    const jobFields = getExistingFields(Job, JOB_FIELDS);

    let query = Appointment.find(filter);

    if (Appointment.schema.path("employerPrivateNote")) {
      query = query.select("+employerPrivateNote");
    }

    query = query
      .populate(JobAppointmentQueryService.buildProfessionalPopulate())
      .populate(JobAppointmentQueryService.buildApplicationPopulate())
      .populate("branch", "name address state lga isActive");

    if (Appointment.schema.path("job")) {
      query = query.populate({
        path: "job",

        select: jobFields.length ? jobFields.join(" ") : undefined,

        populate: Job.schema.path("branch")
          ? {
              path: "branch",

              select: "name address state lga isActive",
            }
          : undefined,
      });
    }

    return query;
  }

  static buildAdminAppointmentQuery(filter) {
    let query = Appointment.find(filter)
      .populate(JobAppointmentQueryService.buildProfessionalPopulate())
      .populate(JobAppointmentQueryService.buildApplicationPopulate())
      .populate("branch", "name address state lga isActive");

    if (Appointment.schema.path("business")) {
      query = query.populate(
        "business",

        "businessName type countryCode currency logoUrl accountStatus employerApprovalStatus"
      );
    }

    if (Appointment.schema.path("job")) {
      query = query.populate(JobAppointmentQueryService.buildAdminJobPopulate());
    }

    return query;
  }

  static buildProfessionalAppointmentQuery(filter) {
    return Appointment.find(filter)
      .populate(JobAppointmentQueryService.buildApplicationPopulate())
      .populate("branch", "name address state lga isActive");
  }

  /* ─────────────────────────────── FILTERS ─────────────────────────────── */

  static applyStatusFilter(filter, status, currentTime) {
    const result = {
      ...filter,
    };

    if (status === "all") {
      return result;
    }

    if (status === AWAITING_EMPLOYER_UPDATE_STATUS) {
      result.status = "scheduled";

      result.endAt = {
        $lt: currentTime,
      };

      return result;
    }

    result.status = status;

    return result;
  }

  static applyResponseStatusFilter(filter, responseStatus) {
    const result = {
      ...filter,
    };

    if (responseStatus !== "all") {
      result.responseStatus = responseStatus;
    }

    return result;
  }

  static async buildCounts({ scopeFilter, selectedStatus, selectedResponseStatus, currentTime }) {
    const statusCountMatch = JobAppointmentQueryService.applyResponseStatusFilter(
      scopeFilter,

      selectedResponseStatus
    );

    const responseCountMatch = JobAppointmentQueryService.applyStatusFilter(
      scopeFilter,

      selectedStatus,

      currentTime
    );

    const [
      totalForStatusTabs,
      statusCountResults,
      awaitingEmployerUpdateCount,
      totalForResponseTabs,
      responseCountResults,
    ] = await Promise.all([
      Appointment.countDocuments(statusCountMatch),

      Appointment.aggregate([
        {
          $match: statusCountMatch,
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

      Appointment.countDocuments({
        ...statusCountMatch,

        status: "scheduled",

        endAt: {
          $lt: currentTime,
        },
      }),

      Appointment.countDocuments(responseCountMatch),

      Appointment.aggregate([
        {
          $match: responseCountMatch,
        },

        {
          $group: {
            _id: "$responseStatus",

            count: {
              $sum: 1,
            },
          },
        },
      ]),
    ]);

    const statusCounts = buildGroupedCountMap(statusCountResults, totalForStatusTabs);

    statusCounts[AWAITING_EMPLOYER_UPDATE_STATUS] = Number(awaitingEmployerUpdateCount || 0);

    return {
      statusCounts,

      responseStatusCounts: buildGroupedCountMap(responseCountResults, totalForResponseTabs),
    };
  }

  /* ─────────────────────────────── EMPLOYER SCOPE ─────────────────────────────── */

  static async resolveEmployerScope({
    userId,
    employerProfile = null,
    employerContext = null,
    applicationId = null,
    currentTime,
  }) {
    if (!JobAppointmentQueryService.canViewAppointments(employerContext)) {
      throw createAppointmentQueryError({
        message: "You do not have permission to view permanent Job appointments.",

        code: "JOB_APPOINTMENT_VIEW_NOT_ALLOWED",

        statusCode: 403,
      });
    }

    if (applicationId) {
      const applicationData = await JobApplicationQueryService.getEmployerApplicationDetailData({
        userId,

        employerProfile,

        employerContext,

        applicationId,

        currentTime,
      });

      return {
        employer: applicationData.employer,

        focusedApplication: applicationData.application,

        focusedJob: applicationData.job,

        scopeFilter: {
          jobApplication: applicationData.application._id,
        },

        canViewAppointments: JobAppointmentQueryService.canViewAppointments(employerContext),

        canManageAppointments: JobAppointmentQueryService.canManageAppointments(employerContext),
      };
    }

    const profile = await JobApplicationQueryService.getEmployerProfileForRead({
      userId,

      employerProfile,

      employerContext,
    });

    const { jobIds } = await JobApplicationQueryService.resolveAccessibleJobScope({
      employerProfileId: profile._id,

      employerContext,
    });

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode || null,

        currency: profile.currency || null,
      },

      focusedApplication: null,

      focusedJob: null,

      scopeFilter: {
        job: {
          $in: jobIds,
        },
      },

      canViewAppointments: JobAppointmentQueryService.canViewAppointments(employerContext),

      canManageAppointments: JobAppointmentQueryService.canManageAppointments(employerContext),
    };
  }

  /* ─────────────────────────────── PROFESSIONAL SCOPE ─────────────────────────────── */

  static async resolveProfessionalScope({
    userId,
    professionalProfile = null,
    applicationId = null,
    currentTime,
  }) {
    if (applicationId) {
      const applicationData = await JobApplicationQueryService.getProfessionalApplicationDetailData(
        {
          userId,

          professionalProfile,

          applicationId,

          currentTime,
        }
      );

      return {
        professional: applicationData.professional,

        focusedApplication: applicationData.application,

        scopeFilter: {
          jobApplication: applicationData.application._id,
        },
      };
    }

    const profile = await JobApplicationQueryService.getProfessionalProfileForRead({
      userId,

      professionalProfile,
    });

    return {
      professional: {
        id: String(profile._id),

        type: profile.type || null,

        specialty: profile.specialty || null,
      },

      focusedApplication: null,

      scopeFilter: {
        professional: profile._id,
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER APPOINTMENTS PAGE ─────────────────────────────── */

  static async getEmployerAppointmentsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    status = "all",
    responseStatus = "all",
    applicationId = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const selectedStatus = JobAppointmentQueryService.normalizeStatusFilter(status);

    const selectedResponseStatus =
      JobAppointmentQueryService.normalizeResponseStatusFilter(responseStatus);

    const selectedApplicationId =
      JobAppointmentQueryService.normalizeOptionalApplicationId(applicationId);

    const requestedPage = JobAppointmentQueryService.normalizePageNumber(page);

    const scope = await JobAppointmentQueryService.resolveEmployerScope({
      userId,

      employerProfile,

      employerContext,

      applicationId: selectedApplicationId,

      currentTime: normalizedCurrentTime,
    });

    let filteredAppointmentFilter = JobAppointmentQueryService.applyStatusFilter(
      scope.scopeFilter,

      selectedStatus,

      normalizedCurrentTime
    );

    filteredAppointmentFilter = JobAppointmentQueryService.applyResponseStatusFilter(
      filteredAppointmentFilter,

      selectedResponseStatus
    );

    const [{ statusCounts, responseStatusCounts }, totalFilteredAppointments] = await Promise.all([
      JobAppointmentQueryService.buildCounts({
        scopeFilter: scope.scopeFilter,

        selectedStatus,

        selectedResponseStatus,

        currentTime: normalizedCurrentTime,
      }),

      Appointment.countDocuments(filteredAppointmentFilter),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredAppointments / APPOINTMENTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * APPOINTMENTS_PER_PAGE;

    const rawAppointments =
      totalFilteredAppointments > 0
        ? await JobAppointmentQueryService.buildEmployerAppointmentQuery(filteredAppointmentFilter)
            .sort({
              startAt: 1,

              roundNumber: 1,

              _id: 1,
            })
            .skip(skip)
            .limit(APPOINTMENTS_PER_PAGE)
            .lean()
        : [];

    const appointments = rawAppointments.map((appointment) =>
      deriveAppointmentState(appointment, normalizedCurrentTime)
    );

    return {
      employer: scope.employer,

      appointments,

      focusedApplication: scope.focusedApplication,

      focusedJob: scope.focusedJob,

      selectedStatus,

      selectedResponseStatus,

      selectedApplicationId: selectedApplicationId ? String(selectedApplicationId) : null,

      statusCounts,

      responseStatusCounts,

      canViewAppointments: scope.canViewAppointments,

      canManageAppointments: scope.canManageAppointments,

      currentTime: normalizedCurrentTime,

      pagination: buildPagination({
        page: currentPage,

        totalItems: totalFilteredAppointments,

        perPage: APPOINTMENTS_PER_PAGE,

        itemCount: appointments.length,
      }),
    };
  }

  /* ─────────────────────────────── EMPLOYER APPOINTMENT DETAIL ─────────────────────────────── */

  static async getEmployerAppointmentDetailData({
    userId,
    employerProfile = null,
    employerContext = null,
    appointmentId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const normalizedAppointmentId =
      JobAppointmentQueryService.normalizeAppointmentId(appointmentId);

    const identity = await Appointment.findById(normalizedAppointmentId)
      .select("jobApplication")
      .lean();

    if (!identity) {
      throw createAppointmentQueryError({
        message: "Appointment not found.",

        code: "APPOINTMENT_NOT_FOUND",

        statusCode: 404,
      });
    }

    const applicationData = await JobApplicationQueryService.getEmployerApplicationDetailData({
      userId,

      employerProfile,

      employerContext,

      applicationId: identity.jobApplication,

      currentTime: normalizedCurrentTime,
    });

    const rawAppointment = await JobAppointmentQueryService.buildEmployerAppointmentQuery({
      _id: normalizedAppointmentId,

      jobApplication: applicationData.application._id,
    }).lean();

    if (!rawAppointment) {
      throw createAppointmentQueryError({
        message: "Appointment not found.",

        code: "APPOINTMENT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return {
      employer: applicationData.employer,

      appointment: deriveAppointmentState(rawAppointment, normalizedCurrentTime),

      application: applicationData.application,

      job: applicationData.job,

      canViewAppointments: JobAppointmentQueryService.canViewAppointments(employerContext),

      canManageAppointments: JobAppointmentQueryService.canManageAppointments(employerContext),

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── ADMIN APPOINTMENTS PAGE ─────────────────────────────── */

  static async getAdminAppointmentsPageData({
    employerProfileId = null,
    status = "all",
    responseStatus = "all",
    applicationId = null,
    page = 1,
    currentTime = new Date(),
  } = {}) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const selectedEmployerProfileId =
      JobAppointmentQueryService.normalizeOptionalEmployerProfileId(employerProfileId);

    const selectedStatus = JobAppointmentQueryService.normalizeStatusFilter(status);

    const selectedResponseStatus =
      JobAppointmentQueryService.normalizeResponseStatusFilter(responseStatus);

    const selectedApplicationId =
      JobAppointmentQueryService.normalizeOptionalApplicationId(applicationId);

    const requestedPage = JobAppointmentQueryService.normalizePageNumber(page);

    const applicationContext = selectedApplicationId
      ? await JobApplicationQueryService.getAdminApplicationDetailData({
          applicationId: selectedApplicationId,
          currentTime: normalizedCurrentTime,
        })
      : {
          application: null,
          job: null,
        };

    const scopeFilter = {};

    if (selectedEmployerProfileId) {
      scopeFilter.business = selectedEmployerProfileId;
    }

    if (selectedApplicationId) {
      scopeFilter.jobApplication = selectedApplicationId;
    }

    let filteredAppointmentFilter = JobAppointmentQueryService.applyStatusFilter(
      scopeFilter,
      selectedStatus,
      normalizedCurrentTime
    );

    filteredAppointmentFilter = JobAppointmentQueryService.applyResponseStatusFilter(
      filteredAppointmentFilter,
      selectedResponseStatus
    );

    const [{ statusCounts, responseStatusCounts }, totalFilteredAppointments] = await Promise.all([
      JobAppointmentQueryService.buildCounts({
        scopeFilter,

        selectedStatus,

        selectedResponseStatus,

        currentTime: normalizedCurrentTime,
      }),

      Appointment.countDocuments(filteredAppointmentFilter),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredAppointments / APPOINTMENTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * APPOINTMENTS_PER_PAGE;

    const rawAppointments =
      totalFilteredAppointments > 0
        ? await JobAppointmentQueryService.buildAdminAppointmentQuery(filteredAppointmentFilter)
            .sort({
              startAt: 1,

              roundNumber: 1,

              _id: 1,
            })
            .skip(skip)
            .limit(APPOINTMENTS_PER_PAGE)
            .lean()
        : [];

    const appointments = rawAppointments.map((appointment) =>
      deriveAppointmentState(appointment, normalizedCurrentTime)
    );

    return {
      appointments,

      focusedApplication: applicationContext.application,

      focusedJob: applicationContext.job,

      selectedEmployerProfileId: selectedEmployerProfileId
        ? String(selectedEmployerProfileId)
        : null,

      selectedStatus,

      selectedResponseStatus,

      selectedApplicationId: selectedApplicationId ? String(selectedApplicationId) : null,

      statusCounts,

      responseStatusCounts,

      canViewAppointments: true,

      canManageAppointments: false,

      currentTime: normalizedCurrentTime,

      pagination: buildPagination({
        page: currentPage,

        totalItems: totalFilteredAppointments,

        perPage: APPOINTMENTS_PER_PAGE,

        itemCount: appointments.length,
      }),
    };
  }

  /* ─────────────────────────────── ADMIN APPOINTMENT DETAIL ─────────────────────────────── */

  static async getAdminAppointmentDetailData({ appointmentId, currentTime = new Date() }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const normalizedAppointmentId =
      JobAppointmentQueryService.normalizeAppointmentId(appointmentId);

    const rawAppointment = await JobAppointmentQueryService.buildAdminAppointmentQuery({
      _id: normalizedAppointmentId,
    }).lean();

    if (!rawAppointment) {
      throw createAppointmentQueryError({
        message: "Appointment not found.",

        code: "APPOINTMENT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return {
      employer:
        rawAppointment.business && typeof rawAppointment.business === "object"
          ? rawAppointment.business
          : null,

      appointment: deriveAppointmentState(rawAppointment, normalizedCurrentTime),

      application:
        rawAppointment.jobApplication && typeof rawAppointment.jobApplication === "object"
          ? rawAppointment.jobApplication
          : null,

      job: rawAppointment.job && typeof rawAppointment.job === "object" ? rawAppointment.job : null,

      canViewAppointments: true,

      canManageAppointments: false,

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── PROFESSIONAL APPOINTMENTS PAGE ─────────────────────────────── */

  static async getProfessionalAppointmentsPageData({
    userId,
    professionalProfile = null,
    status = "all",
    responseStatus = "all",
    applicationId = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const selectedStatus = JobAppointmentQueryService.normalizeStatusFilter(status);

    const selectedResponseStatus =
      JobAppointmentQueryService.normalizeResponseStatusFilter(responseStatus);

    const selectedApplicationId =
      JobAppointmentQueryService.normalizeOptionalApplicationId(applicationId);

    const requestedPage = JobAppointmentQueryService.normalizePageNumber(page);

    const scope = await JobAppointmentQueryService.resolveProfessionalScope({
      userId,

      professionalProfile,

      applicationId: selectedApplicationId,

      currentTime: normalizedCurrentTime,
    });

    let filteredAppointmentFilter = JobAppointmentQueryService.applyStatusFilter(
      scope.scopeFilter,
      selectedStatus,
      normalizedCurrentTime
    );

    filteredAppointmentFilter = JobAppointmentQueryService.applyResponseStatusFilter(
      filteredAppointmentFilter,
      selectedResponseStatus
    );

    const [{ statusCounts, responseStatusCounts }, totalFilteredAppointments] = await Promise.all([
      JobAppointmentQueryService.buildCounts({
        scopeFilter: scope.scopeFilter,

        selectedStatus,

        selectedResponseStatus,

        currentTime: normalizedCurrentTime,
      }),

      Appointment.countDocuments(filteredAppointmentFilter),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredAppointments / APPOINTMENTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * APPOINTMENTS_PER_PAGE;

    const rawAppointments =
      totalFilteredAppointments > 0
        ? await JobAppointmentQueryService.buildProfessionalAppointmentQuery(
            filteredAppointmentFilter
          )
            .sort({
              startAt: 1,

              roundNumber: 1,

              _id: 1,
            })
            .skip(skip)
            .limit(APPOINTMENTS_PER_PAGE)
            .lean()
        : [];

    const appointments = rawAppointments.map((appointment) =>
      deriveAppointmentState(appointment, normalizedCurrentTime)
    );

    return {
      professional: scope.professional,

      appointments,

      focusedApplication: scope.focusedApplication,

      selectedStatus,

      selectedResponseStatus,

      selectedApplicationId: selectedApplicationId ? String(selectedApplicationId) : null,

      statusCounts,

      responseStatusCounts,

      currentTime: normalizedCurrentTime,

      pagination: buildPagination({
        page: currentPage,

        totalItems: totalFilteredAppointments,

        perPage: APPOINTMENTS_PER_PAGE,

        itemCount: appointments.length,
      }),
    };
  }

  /* ─────────────────────────────── PROFESSIONAL APPOINTMENT DETAIL ─────────────────────────────── */

  static async getProfessionalAppointmentDetailData({
    userId,
    professionalProfile = null,
    appointmentId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const normalizedAppointmentId =
      JobAppointmentQueryService.normalizeAppointmentId(appointmentId);

    const identity = await Appointment.findById(normalizedAppointmentId)
      .select("jobApplication professional")
      .lean();

    if (!identity) {
      throw createAppointmentQueryError({
        message: "Appointment not found.",

        code: "APPOINTMENT_NOT_FOUND",

        statusCode: 404,
      });
    }

    const applicationData = await JobApplicationQueryService.getProfessionalApplicationDetailData({
      userId,

      professionalProfile,

      applicationId: identity.jobApplication,

      currentTime: normalizedCurrentTime,
    });

    if (
      !identity.professional ||
      String(identity.professional) !== String(applicationData.professional.id)
    ) {
      throw createAppointmentQueryError({
        message: "Appointment not found.",

        code: "APPOINTMENT_NOT_FOUND",

        statusCode: 404,
      });
    }

    const rawAppointment = await JobAppointmentQueryService.buildProfessionalAppointmentQuery({
      _id: normalizedAppointmentId,

      jobApplication: applicationData.application._id,

      professional: applicationData.professional.id,
    }).lean();

    if (!rawAppointment) {
      throw createAppointmentQueryError({
        message: "Appointment not found.",

        code: "APPOINTMENT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return {
      professional: applicationData.professional,

      appointment: deriveAppointmentState(rawAppointment, normalizedCurrentTime),

      application: applicationData.application,

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── APPLICATION-SCOPED READS ─────────────────────────────── */

  static async getEmployerApplicationAppointments({
    userId,
    employerProfile = null,
    employerContext = null,
    applicationId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const applicationData = await JobApplicationQueryService.getEmployerApplicationDetailData({
      userId,

      employerProfile,

      employerContext,

      applicationId,

      currentTime: normalizedCurrentTime,
    });

    const rawAppointments = await JobAppointmentQueryService.buildEmployerAppointmentQuery({
      jobApplication: applicationData.application._id,
    })
      .sort({
        roundNumber: 1,

        startAt: 1,

        _id: 1,
      })
      .lean();

    return {
      employer: applicationData.employer,

      application: applicationData.application,

      job: applicationData.job,

      appointments: rawAppointments.map((appointment) =>
        deriveAppointmentState(appointment, normalizedCurrentTime)
      ),

      canViewAppointments: JobAppointmentQueryService.canViewAppointments(employerContext),

      canManageAppointments: JobAppointmentQueryService.canManageAppointments(employerContext),

      currentTime: normalizedCurrentTime,
    };
  }

  static async getAdminApplicationAppointments({ applicationId, currentTime = new Date() }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const applicationData = await JobApplicationQueryService.getAdminApplicationDetailData({
      applicationId,

      currentTime: normalizedCurrentTime,
    });

    const rawAppointments = await JobAppointmentQueryService.buildAdminAppointmentQuery({
      jobApplication: applicationData.application._id,
    })
      .sort({
        roundNumber: 1,

        startAt: 1,

        _id: 1,
      })
      .lean();

    return {
      employer: applicationData.employer,

      application: applicationData.application,

      job: applicationData.job,

      appointments: rawAppointments.map((appointment) =>
        deriveAppointmentState(appointment, normalizedCurrentTime)
      ),

      canViewAppointments: true,

      canManageAppointments: false,

      currentTime: normalizedCurrentTime,
    };
  }

  static async getProfessionalApplicationAppointments({
    userId,
    professionalProfile = null,
    applicationId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = JobAppointmentQueryService.normalizeCurrentTime(currentTime);

    const applicationData = await JobApplicationQueryService.getProfessionalApplicationDetailData({
      userId,

      professionalProfile,

      applicationId,

      currentTime: normalizedCurrentTime,
    });

    const rawAppointments = await JobAppointmentQueryService.buildProfessionalAppointmentQuery({
      jobApplication: applicationData.application._id,

      professional: applicationData.professional.id,
    })
      .sort({
        roundNumber: 1,

        startAt: 1,

        _id: 1,
      })
      .lean();

    return {
      professional: applicationData.professional,

      application: applicationData.application,

      appointments: rawAppointments.map((appointment) =>
        deriveAppointmentState(appointment, normalizedCurrentTime)
      ),

      currentTime: normalizedCurrentTime,
    };
  }

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createAppointmentQueryError(options) {
    return createAppointmentQueryError(options);
  }
}

module.exports = JobAppointmentQueryService;
