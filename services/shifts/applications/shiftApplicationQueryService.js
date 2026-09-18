// services/shifts/applications/shiftApplicationQueryService.js

const mongoose = require("mongoose");

const Shift = require("../../../models/Shift");
const ShiftApplication = require("../../../models/ShiftApplication");
const EmployerProfile = require("../../../models/EmployerProfile");
const EmployerMember = require("../../../models/EmployerMember");

const { APPLICATION_TYPES, APPLICATION_STATUSES } = require("../../../constants/shiftApplication");

const { createServiceError } = require("../../helpers/serviceErrorHelper");

const { normalizeObjectId } = require("../../helpers/serviceValidationHelpers");

const SHIFT_APPLICATION_QUERY_SERVICE_ERROR_NAME = "ShiftApplicationQueryServiceError";

const APPLICATIONS_PER_PAGE = 20;

/*
 * Application records deliberately remain scoped through their parent Shift.
 *
 * ShiftApplication does not duplicate business / branch ownership.
 * Employer access must therefore be resolved against accessible Shifts before
 * applications are queried.
 */
const APPLICATION_SHIFT_FIELDS = [
  "referenceCode",
  "branch",
  "roleTitle",
  "professionalType",
  "scheduleMode",
  "occurrenceCount",
  "requiredProfessionals",
  "totalOccurrenceCount",
  "firstOccurrenceDate",
  "lastOccurrenceDate",
  "scheduleTimeZone",
  "dailyStartTimeMinutes",
  "dailyEndTimeMinutes",
  "endsNextDay",
  "startTime",
  "endTime",
  "status",
  "paymentStatus",
  "applicationRound",
  "hiringSummary",
  "assignmentSummary",
  "totalApplications",
  "currentRoundApplications",
  "createdAt",
];

const APPLICATION_FIELDS = [
  "shift",
  "professional",
  "occurrence",
  "slotNumber",
  "applicationType",
  "applicationRound",
  "replacementForAssignment",
  "acceptedAssignment",
  "status",

  "note",

  "reviewedAt",
  "reviewedBy",
  "employerPrivateNote",

  "shortlistedAt",
  "acceptedAt",
  "rejectedAt",
  "rejectedReason",
  "withdrawnAt",
  "withdrawalReason",
  "expiredAt",
  "cancelledAt",

  "matchSnapshot",

  "createdAt",
  "updatedAt",
];

const PROFESSIONAL_FIELDS = [
  "user",
  "type",
  "specialty",
  "yearsOfExperience",
  "averageRating",
  "reliabilityScore",
  "totalShiftsCompleted",
  "availabilityStatus",
  "licenceVerificationStatus",
  "licenceExpiryDate",
  "identityVerificationStatus",
  "professionalApprovalStatus",
  "accountStatus",
  "marketplaceStatus",
  "tier",
];

const USER_IDENTITY_FIELDS = ["firstName", "lastName", "displayName", "photo"];

const OCCURRENCE_FIELDS = [
  "referenceCode",
  "slotNumber",
  "sequenceNumber",
  "occurrenceDate",
  "scheduleTimeZone",
  "startTime",
  "endTime",
  "status",
  "assignmentStatus",
  "attendanceStatus",
];

const ASSIGNMENT_FIELDS = [
  "referenceCode",
  "shift",
  "professional",
  "slotNumber",
  "assignmentType",
  "source",
  "application",
  "occurrence",
  "replacesAssignment",
  "replacementCase",
  "startSequence",
  "plannedEndSequence",
  "plannedOccurrenceCount",
  "effectiveEndSequence",
  "effectiveOccurrenceCount",
  "status",
  "assignedAt",
  "activatedAt",
  "endedAt",
  "cancelledAt",
  "createdAt",
];

/* ─────────────────────────────── ERROR CONTRACT ─────────────────────────────── */

function createApplicationQueryError(options) {
  return createServiceError({
    ...options,

    name: SHIFT_APPLICATION_QUERY_SERVICE_ERROR_NAME,
  });
}

/* ─────────────────────────────── QUERY SERVICE ─────────────────────────────── */

class ShiftApplicationQueryService {
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

    return status === "all" || APPLICATION_STATUSES.includes(status) ? status : "all";
  }

  static normalizeApplicationTypeFilter(value) {
    const applicationType = String(value || "all")
      .trim()
      .toLowerCase();

    return applicationType === "all" || APPLICATION_TYPES.includes(applicationType)
      ? applicationType
      : "all";
  }

  static normalizeOptionalShiftId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,

      fieldName: "Shift ID",

      createError: createApplicationQueryError,
    });
  }

  /* ─────────────────────────────── EMPLOYER READ ACCESS ─────────────────────────────── */

  static assertCanViewApplications(employerContext = null) {
    if (employerContext?.canViewShifts !== true) {
      throw createApplicationQueryError({
        message: "You do not have permission to view Shift applications.",

        code: "SHIFT_APPLICATION_VIEW_NOT_ALLOWED",

        statusCode: 403,
      });
    }
  }

  static canManageApplications(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true
    );
  }

  static canManageAllBranches(employerContext = null) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static getAssignedBranchObjectIds(employerContext = null) {
    return (employerContext?.assignedBranchIds || [])
      .filter((branchId) => mongoose.isValidObjectId(branchId))
      .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));
  }

  /**
   * Revalidates the authenticated employer against the supplied business.
   *
   * The attached employer profile/context remain request-level lookup hints.
   * The database relationship is re-read before returning employer application
   * data.
   *
   * Unlike the current generic ShiftQueryService helper, this read boundary
   * deliberately supports branch_staff because employerMiddleware currently
   * grants branch staff canViewShifts permission.
   */
  static async getEmployerProfileForRead({
    userId,
    employerProfile = null,
    employerContext = null,
  }) {
    ShiftApplicationQueryService.assertCanViewApplications(employerContext);

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

    const profile = await EmployerProfile.findById(normalizedEmployerProfileId).lean();

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

  /* ─────────────────────────────── SHIFT ACCESS SCOPE ─────────────────────────────── */

  static buildAccessibleShiftFilter({ employerProfileId, employerContext = null, shiftId = null }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,

      fieldName: "employer profile ID",

      createError: createApplicationQueryError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
    };

    if (shiftId) {
      filter._id = normalizeObjectId({
        value: shiftId,

        fieldName: "Shift ID",

        createError: createApplicationQueryError,
      });
    }

    if (!ShiftApplicationQueryService.canManageAllBranches(employerContext)) {
      filter.branch = {
        $in: ShiftApplicationQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return filter;
  }

  static async resolveAccessibleShiftScope({
    employerProfileId,
    employerContext = null,
    shiftId = null,
  }) {
    const shiftFilter = ShiftApplicationQueryService.buildAccessibleShiftFilter({
      employerProfileId,

      employerContext,

      shiftId,
    });

    if (shiftId) {
      const focusedShift = await Shift.findOne(shiftFilter)
        .select(APPLICATION_SHIFT_FIELDS.join(" "))
        .populate("branch", "name address state lga")
        .lean();

      if (!focusedShift) {
        throw createApplicationQueryError({
          message: "Shift was not found or is not available to you.",

          code: "SHIFT_NOT_FOUND",

          statusCode: 404,
        });
      }

      return {
        focusedShift,

        shiftIds: [focusedShift._id],
      };
    }

    const shiftIds = await Shift.distinct("_id", shiftFilter);

    return {
      focusedShift: null,

      shiftIds,
    };
  }

  /* ─────────────────────────────── APPLICATION FILTERS ─────────────────────────────── */

  static buildApplicationScopeFilter(shiftIds = []) {
    return {
      shift: {
        $in: Array.isArray(shiftIds) ? shiftIds : [],
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

  static applyApplicationTypeFilter(filter, applicationType) {
    const result = {
      ...filter,
    };

    if (applicationType !== "all") {
      result.applicationType = applicationType;
    }

    return result;
  }

  /* ─────────────────────────────── COUNTS ─────────────────────────────── */

  static buildStatusCounts(results = [], allCount = 0) {
    const counts = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0]));

    for (const result of results) {
      if (Object.prototype.hasOwnProperty.call(counts, result._id)) {
        counts[result._id] = Number(result.count || 0);
      }
    }

    return {
      all: Number(allCount || 0),

      ...counts,
    };
  }

  static buildApplicationTypeCounts(results = [], allCount = 0) {
    const counts = Object.fromEntries(
      APPLICATION_TYPES.map((applicationType) => [applicationType, 0])
    );

    for (const result of results) {
      if (Object.prototype.hasOwnProperty.call(counts, result._id)) {
        counts[result._id] = Number(result.count || 0);
      }
    }

    return {
      all: Number(allCount || 0),

      ...counts,
    };
  }

  /* ─────────────────────────────── APPLICATION QUERY ─────────────────────────────── */

  static buildApplicationQuery(filter) {
    return ShiftApplication.find(filter)
      .select(APPLICATION_FIELDS.join(" "))
      .populate({
        path: "shift",

        select: APPLICATION_SHIFT_FIELDS.join(" "),

        populate: {
          path: "branch",

          select: "name address state lga",
        },
      })
      .populate({
        path: "professional",

        select: PROFESSIONAL_FIELDS.join(" "),

        populate: {
          path: "user",

          select: USER_IDENTITY_FIELDS.join(" "),
        },
      })
      .populate({
        path: "occurrence",

        select: OCCURRENCE_FIELDS.join(" "),
      })
      .populate({
        path: "replacementForAssignment",

        select: ASSIGNMENT_FIELDS.join(" "),
      })
      .populate({
        path: "acceptedAssignment",

        select: ASSIGNMENT_FIELDS.join(" "),
      });
  }

  /* ─────────────────────────────── EMPLOYER APPLICATIONS PAGE ─────────────────────────────── */

  static async getEmployerApplicationsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    status = "all",
    applicationType = "all",
    shiftId = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftApplicationQueryService.normalizeCurrentTime(currentTime);

    const selectedStatus = ShiftApplicationQueryService.normalizeStatusFilter(status);

    const selectedApplicationType =
      ShiftApplicationQueryService.normalizeApplicationTypeFilter(applicationType);

    const selectedShiftId = ShiftApplicationQueryService.normalizeOptionalShiftId(shiftId);

    const requestedPage = ShiftApplicationQueryService.normalizePageNumber(page);

    const profile = await ShiftApplicationQueryService.getEmployerProfileForRead({
      userId,

      employerProfile,

      employerContext,
    });

    const currency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    if (!currency) {
      throw createApplicationQueryError({
        message: "The employer currency could not be resolved.",

        code: "EMPLOYER_CURRENCY_NOT_RESOLVED",

        statusCode: 500,
      });
    }

    const { focusedShift, shiftIds } =
      await ShiftApplicationQueryService.resolveAccessibleShiftScope({
        employerProfileId: profile._id,

        employerContext,

        shiftId: selectedShiftId,
      });

    const scopeFilter = ShiftApplicationQueryService.buildApplicationScopeFilter(shiftIds);

    /*
     * Status counts respect the currently selected application type.
     *
     * Example:
     * when viewing replacement applications, the Pending / Shortlisted /
     * Accepted counts describe replacement applications only.
     */
    const statusCountMatch = ShiftApplicationQueryService.applyApplicationTypeFilter(
      scopeFilter,
      selectedApplicationType
    );

    /*
     * Application-type counts likewise respect the selected status.
     *
     * Example:
     * when viewing Shortlisted, the Initial / Replacement counts describe
     * shortlisted applications only.
     */
    const applicationTypeCountMatch = ShiftApplicationQueryService.applyStatusFilter(
      scopeFilter,
      selectedStatus
    );

    let filteredApplicationFilter = ShiftApplicationQueryService.applyStatusFilter(
      scopeFilter,
      selectedStatus
    );

    filteredApplicationFilter = ShiftApplicationQueryService.applyApplicationTypeFilter(
      filteredApplicationFilter,
      selectedApplicationType
    );

    const [
      totalFilteredApplications,
      totalForStatusTabs,
      statusCountResults,
      totalForApplicationTypeTabs,
      applicationTypeCountResults,
    ] = await Promise.all([
      ShiftApplication.countDocuments(filteredApplicationFilter),

      ShiftApplication.countDocuments(statusCountMatch),

      ShiftApplication.aggregate([
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

      ShiftApplication.countDocuments(applicationTypeCountMatch),

      ShiftApplication.aggregate([
        {
          $match: applicationTypeCountMatch,
        },
        {
          $group: {
            _id: "$applicationType",

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

    const applications =
      totalFilteredApplications > 0
        ? await ShiftApplicationQueryService.buildApplicationQuery(filteredApplicationFilter)
            .sort({
              createdAt: -1,

              _id: -1,
            })
            .skip(skip)
            .limit(APPLICATIONS_PER_PAGE)
            .lean()
        : [];

    const statusCounts = ShiftApplicationQueryService.buildStatusCounts(
      statusCountResults,
      totalForStatusTabs
    );

    const applicationTypeCounts = ShiftApplicationQueryService.buildApplicationTypeCounts(
      applicationTypeCountResults,
      totalForApplicationTypeTabs
    );

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode,

        currency,
      },

      applications,

      focusedShift,

      selectedStatus,

      selectedApplicationType,

      statusCounts,

      applicationTypeCounts,

      canManageApplications: ShiftApplicationQueryService.canManageApplications(employerContext),

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

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createApplicationQueryError(options) {
    return createApplicationQueryError(options);
  }
}

module.exports = ShiftApplicationQueryService;
