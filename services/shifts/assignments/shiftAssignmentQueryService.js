// services/shifts/assignments/shiftAssignmentQueryService.js

const mongoose = require("mongoose");

const Shift = require("../../../models/Shift");
const ShiftAssignment = require("../../../models/ShiftAssignment");
const ShiftOccurrence = require("../../../models/ShiftOccurrence");
const EmployerProfile = require("../../../models/EmployerProfile");
const EmployerMember = require("../../../models/EmployerMember");

const { ASSIGNMENT_TYPES, ASSIGNMENT_STATUSES } = require("../../../constants/shiftAssignment");

const { createServiceError } = require("../../helpers/serviceErrorHelper");

const { normalizeObjectId } = require("../../helpers/serviceValidationHelpers");

const SHIFT_ASSIGNMENT_QUERY_SERVICE_ERROR_NAME = "ShiftAssignmentQueryServiceError";

const ASSIGNMENTS_PER_PAGE = 20;

const ASSIGNMENT_SHIFT_FIELDS = [
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
  "hiringSummary",
  "assignmentSummary",
  "occurrenceProgress",
  "createdAt",
];

const ASSIGNMENT_FIELDS = [
  "referenceCode",
  "shift",
  "slotNumber",
  "business",
  "branch",
  "professional",

  "assignmentType",
  "source",
  "application",
  "occurrence",
  "replacesAssignment",
  "replacedByAssignment",
  "replacementCase",

  "openCase",
  "endCase",
  "endingRequestedAt",
  "endingConfirmedAt",
  "endingConfirmedBy",
  "endingConfirmedByRole",

  "startSequence",
  "plannedEndSequence",
  "plannedOccurrenceCount",
  "startsAt",
  "plannedEndsAt",

  "effectiveEndSequence",
  "effectiveOccurrenceCount",
  "effectiveEndsAt",

  "status",
  "isCurrentAssignment",
  "assignedAt",
  "assignedBy",
  "activatedAt",
  "activatedBy",

  "endedAt",
  "endedBy",
  "endedByRole",
  "endReason",
  "endNotes",

  "cancelledAt",
  "cancelledBy",
  "cancelledByRole",
  "cancellationReason",

  "createdAt",
  "updatedAt",
];

const ASSIGNMENT_LINK_FIELDS = [
  "referenceCode",
  "shift",
  "professional",
  "slotNumber",
  "assignmentType",
  "occurrence",
  "startSequence",
  "plannedEndSequence",
  "plannedOccurrenceCount",
  "effectiveEndSequence",
  "effectiveOccurrenceCount",
  "effectiveEndsAt",
  "status",
  "isCurrentAssignment",
  "assignedAt",
  "activatedAt",
  "endedAt",
  "cancelledAt",
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

const APPLICATION_FIELDS = [
  "shift",
  "professional",
  "applicationType",
  "applicationRound",
  "slotNumber",
  "occurrence",
  "replacementForAssignment",
  "status",
  "acceptedAt",
  "createdAt",
];

const CASE_FIELDS = [
  "referenceCode",
  "caseType",
  "status",
  "isOpen",
  "shift",
  "assignment",
  "business",
  "branch",
  "professional",
  "initiatedBy",
  "exitProposal",
  "employerIssue",
  "professionalResponse",
  "employerResponse",
  "replacementRequestedAt",
  "replacementRequestedBy",
  "escalatedAt",
  "escalatedBy",
  "escalationReason",
  "resolution",
  "withdrawnAt",
  "withdrawnBy",
  "withdrawalReason",
  "dismissedAt",
  "dismissedBy",
  "dismissalReason",
  "cancelledAt",
  "cancelledBy",
  "cancellationReason",
  "createdAt",
  "updatedAt",
];

const OCCURRENCE_FIELDS = [
  "referenceCode",
  "shift",
  "slotNumber",
  "sequenceNumber",
  "occurrenceDate",
  "scheduleTimeZone",
  "startTime",
  "endTime",
  "scheduledMinutes",
  "assignmentStatus",
  "assignedProfessional",
  "assignment",
  "assignedAt",
  "replacementRequiredAt",
  "replacementForAssignment",
  "replacementCase",
  "replacementReasonCode",
  "status",
  "attendanceStatus",
  "checkedInAt",
  "checkedOutAt",
  "settlementStatus",
  "refundStatus",
  "challengeWindowOpenedAt",
  "challengeDeadlineAt",
  "challengeWindowClosedAt",
  "challengeableSettlementComponents",
  "activeClaim",
  "activeDispute",
  "overtime.status",
];

/* ─────────────────────────────── ERROR CONTRACT ─────────────────────────────── */

function createAssignmentQueryError(options) {
  return createServiceError({
    ...options,

    name: SHIFT_ASSIGNMENT_QUERY_SERVICE_ERROR_NAME,
  });
}

/* ─────────────────────────────── QUERY SERVICE ─────────────────────────────── */

class ShiftAssignmentQueryService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createAssignmentQueryError({
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

    return status === "all" || ASSIGNMENT_STATUSES.includes(status) ? status : "all";
  }

  static normalizeAssignmentTypeFilter(value) {
    const assignmentType = String(value || "all")
      .trim()
      .toLowerCase();

    return assignmentType === "all" || ASSIGNMENT_TYPES.includes(assignmentType)
      ? assignmentType
      : "all";
  }

  static normalizeOptionalShiftId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,

      fieldName: "Shift ID",

      createError: createAssignmentQueryError,
    });
  }

  static getDocumentId(value) {
    if (!value) {
      return null;
    }

    return value._id || value;
  }

  /* ─────────────────────────────── EMPLOYER READ ACCESS ─────────────────────────────── */

  static assertCanViewAssignments(employerContext = null) {
    if (employerContext?.canViewShifts !== true) {
      throw createAssignmentQueryError({
        message: "You do not have permission to view Shift assignments.",

        code: "SHIFT_ASSIGNMENT_VIEW_NOT_ALLOWED",

        statusCode: 403,
      });
    }
  }

  static canManageAssignments(employerContext = null) {
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

  static async getEmployerProfileForRead({
    userId,
    employerProfile = null,
    employerContext = null,
  }) {
    ShiftAssignmentQueryService.assertCanViewAssignments(employerContext);

    const normalizedUserId = normalizeObjectId({
      value: userId,

      fieldName: "user ID",

      createError: createAssignmentQueryError,
    });

    if (!employerProfile?._id) {
      throw createAssignmentQueryError({
        message: "Employer profile context is unavailable.",

        code: "EMPLOYER_PROFILE_CONTEXT_REQUIRED",

        statusCode: 500,
      });
    }

    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfile._id,

      fieldName: "employer profile ID",

      createError: createAssignmentQueryError,
    });

    const profile = await EmployerProfile.findById(normalizedEmployerProfileId).lean();

    if (!profile) {
      throw createAssignmentQueryError({
        message: "Employer profile not found.",

        code: "EMPLOYER_PROFILE_NOT_FOUND",

        statusCode: 404,
      });
    }

    const isPrimaryEmployer = profile.user && String(profile.user) === String(normalizedUserId);

    if (isPrimaryEmployer) {
      if (employerContext?.isPrimaryEmployer !== true) {
        throw createAssignmentQueryError({
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
      throw createAssignmentQueryError({
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
      throw createAssignmentQueryError({
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
        throw createAssignmentQueryError({
          message: "Your employer branch access context is invalid.",

          code: "EMPLOYER_BRANCH_ACCESS_CONTEXT_INVALID",

          statusCode: 403,
        });
      }
    }

    return profile;
  }

  /* ─────────────────────────────── EMPLOYER / BRANCH SCOPE ─────────────────────────────── */

  static buildAccessibleShiftFilter({ employerProfileId, employerContext = null, shiftId = null }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,

      fieldName: "employer profile ID",

      createError: createAssignmentQueryError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
    };

    if (shiftId) {
      filter._id = normalizeObjectId({
        value: shiftId,

        fieldName: "Shift ID",

        createError: createAssignmentQueryError,
      });
    }

    if (!ShiftAssignmentQueryService.canManageAllBranches(employerContext)) {
      filter.branch = {
        $in: ShiftAssignmentQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return filter;
  }

  static buildAssignmentScopeFilter({ employerProfileId, employerContext = null, shiftId = null }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,

      fieldName: "employer profile ID",

      createError: createAssignmentQueryError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
    };

    if (shiftId) {
      filter.shift = normalizeObjectId({
        value: shiftId,

        fieldName: "Shift ID",

        createError: createAssignmentQueryError,
      });
    }

    if (!ShiftAssignmentQueryService.canManageAllBranches(employerContext)) {
      filter.branch = {
        $in: ShiftAssignmentQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return filter;
  }

  static async getFocusedShift({ employerProfileId, employerContext = null, shiftId = null }) {
    if (!shiftId) {
      return null;
    }

    const shift = await Shift.findOne(
      ShiftAssignmentQueryService.buildAccessibleShiftFilter({
        employerProfileId,

        employerContext,

        shiftId,
      })
    )
      .select(ASSIGNMENT_SHIFT_FIELDS.join(" "))
      .populate("branch", "name address state lga")
      .lean();

    if (!shift) {
      throw createAssignmentQueryError({
        message: "Shift was not found or is not available to you.",

        code: "SHIFT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return shift;
  }

  /* ─────────────────────────────── ASSIGNMENT FILTERS ─────────────────────────────── */

  static applyStatusFilter(filter, status) {
    const result = {
      ...filter,
    };

    if (status !== "all") {
      result.status = status;
    }

    return result;
  }

  static applyAssignmentTypeFilter(filter, assignmentType) {
    const result = {
      ...filter,
    };

    if (assignmentType !== "all") {
      result.assignmentType = assignmentType;
    }

    return result;
  }

  /* ─────────────────────────────── COUNTS ─────────────────────────────── */

  static buildStatusCounts(results = [], allCount = 0) {
    const counts = Object.fromEntries(ASSIGNMENT_STATUSES.map((status) => [status, 0]));

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

  static buildAssignmentTypeCounts(results = [], allCount = 0) {
    const counts = Object.fromEntries(
      ASSIGNMENT_TYPES.map((assignmentType) => [assignmentType, 0])
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

  /* ─────────────────────────────── ASSIGNMENT QUERY ─────────────────────────────── */

  static buildAssignmentLinkPopulate(path) {
    return {
      path,

      select: ASSIGNMENT_LINK_FIELDS.join(" "),

      populate: {
        path: "professional",

        select: PROFESSIONAL_FIELDS.join(" "),

        populate: {
          path: "user",

          select: USER_IDENTITY_FIELDS.join(" "),
        },
      },
    };
  }

  static buildCasePopulate(path) {
    return {
      path,

      select: CASE_FIELDS.join(" "),

      populate: {
        path: "employerIssue.occurrence",

        select: OCCURRENCE_FIELDS.join(" "),
      },
    };
  }

  static buildAssignmentQuery(filter) {
    return ShiftAssignment.find(filter)
      .select(ASSIGNMENT_FIELDS.join(" "))
      .populate({
        path: "shift",

        select: ASSIGNMENT_SHIFT_FIELDS.join(" "),

        populate: {
          path: "branch",

          select: "name address state lga",
        },
      })
      .populate("branch", "name address state lga")
      .populate({
        path: "professional",

        select: PROFESSIONAL_FIELDS.join(" "),

        populate: {
          path: "user",

          select: USER_IDENTITY_FIELDS.join(" "),
        },
      })
      .populate({
        path: "application",

        select: APPLICATION_FIELDS.join(" "),
      })
      .populate({
        path: "occurrence",

        select: OCCURRENCE_FIELDS.join(" "),
      })
      .populate(ShiftAssignmentQueryService.buildAssignmentLinkPopulate("replacesAssignment"))
      .populate(ShiftAssignmentQueryService.buildAssignmentLinkPopulate("replacedByAssignment"))
      .populate(ShiftAssignmentQueryService.buildCasePopulate("replacementCase"))
      .populate(ShiftAssignmentQueryService.buildCasePopulate("openCase"))
      .populate(ShiftAssignmentQueryService.buildCasePopulate("endCase"));
  }

  /* ─────────────────────────────── OCCURRENCE CONTEXT ─────────────────────────────── */

  static buildOccurrenceRangeClauses(assignments = []) {
    const clauses = [];
    const seen = new Set();

    for (const assignment of assignments) {
      const shiftId = ShiftAssignmentQueryService.getDocumentId(assignment?.shift);

      const slotNumber = Number(assignment?.slotNumber);

      const startSequence = Number(assignment?.startSequence);

      const endSequence = Number(assignment?.plannedEndSequence);

      if (
        !shiftId ||
        !mongoose.isValidObjectId(shiftId) ||
        !Number.isSafeInteger(slotNumber) ||
        slotNumber < 1 ||
        !Number.isSafeInteger(startSequence) ||
        startSequence < 1 ||
        !Number.isSafeInteger(endSequence) ||
        endSequence < startSequence
      ) {
        continue;
      }

      const key = `${String(shiftId)}:${slotNumber}:${startSequence}:${endSequence}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      clauses.push({
        shift: new mongoose.Types.ObjectId(String(shiftId)),

        slotNumber,

        sequenceNumber: {
          $gte: startSequence,

          $lte: endSequence,
        },
      });
    }

    return clauses;
  }

  static async getAssignmentOccurrenceContext(assignments = []) {
    const clauses = ShiftAssignmentQueryService.buildOccurrenceRangeClauses(assignments);

    if (clauses.length === 0) {
      return [];
    }

    return ShiftOccurrence.find({
      $or: clauses,
    })
      .select(OCCURRENCE_FIELDS.join(" "))
      .sort({
        shift: 1,

        slotNumber: 1,

        sequenceNumber: 1,

        _id: 1,
      })
      .lean();
  }

  /* ─────────────────────────────── EMPLOYER ASSIGNMENTS PAGE ─────────────────────────────── */

  static async getEmployerAssignmentsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    status = "all",
    assignmentType = "all",
    shiftId = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftAssignmentQueryService.normalizeCurrentTime(currentTime);

    const selectedStatus = ShiftAssignmentQueryService.normalizeStatusFilter(status);

    const selectedAssignmentType =
      ShiftAssignmentQueryService.normalizeAssignmentTypeFilter(assignmentType);

    const selectedShiftId = ShiftAssignmentQueryService.normalizeOptionalShiftId(shiftId);

    const requestedPage = ShiftAssignmentQueryService.normalizePageNumber(page);

    const profile = await ShiftAssignmentQueryService.getEmployerProfileForRead({
      userId,

      employerProfile,

      employerContext,
    });

    const currency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    if (!currency) {
      throw createAssignmentQueryError({
        message: "The employer currency could not be resolved.",

        code: "EMPLOYER_CURRENCY_NOT_RESOLVED",

        statusCode: 500,
      });
    }

    const focusedShift = await ShiftAssignmentQueryService.getFocusedShift({
      employerProfileId: profile._id,

      employerContext,

      shiftId: selectedShiftId,
    });

    const scopeFilter = ShiftAssignmentQueryService.buildAssignmentScopeFilter({
      employerProfileId: profile._id,

      employerContext,

      shiftId: selectedShiftId,
    });

    /*
     * Status counts respect the selected assignment type.
     *
     * Example:
     * when viewing replacement assignments, Scheduled / Active / Ending / Ended
     * counts describe replacement assignments only.
     */
    const statusCountMatch = ShiftAssignmentQueryService.applyAssignmentTypeFilter(
      scopeFilter,

      selectedAssignmentType
    );

    /*
     * Assignment-type counts respect the selected status.
     *
     * Example:
     * when viewing Active, Initial / Replacement counts describe active
     * assignments only.
     */
    const assignmentTypeCountMatch = ShiftAssignmentQueryService.applyStatusFilter(
      scopeFilter,

      selectedStatus
    );

    let filteredAssignmentFilter = ShiftAssignmentQueryService.applyStatusFilter(
      scopeFilter,

      selectedStatus
    );

    filteredAssignmentFilter = ShiftAssignmentQueryService.applyAssignmentTypeFilter(
      filteredAssignmentFilter,

      selectedAssignmentType
    );

    const [
      totalFilteredAssignments,
      totalForStatusTabs,
      statusCountResults,
      totalForAssignmentTypeTabs,
      assignmentTypeCountResults,
      totalAssignments,
      currentAssignmentCount,
      openCaseAssignmentCount,
      replacementAssignmentCount,
      isolatedReplacementAssignmentCount,
    ] = await Promise.all([
      ShiftAssignment.countDocuments(filteredAssignmentFilter),

      ShiftAssignment.countDocuments(statusCountMatch),

      ShiftAssignment.aggregate([
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

      ShiftAssignment.countDocuments(assignmentTypeCountMatch),

      ShiftAssignment.aggregate([
        {
          $match: assignmentTypeCountMatch,
        },
        {
          $group: {
            _id: "$assignmentType",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      ShiftAssignment.countDocuments(scopeFilter),

      ShiftAssignment.countDocuments({
        ...scopeFilter,

        isCurrentAssignment: true,
      }),

      ShiftAssignment.countDocuments({
        ...scopeFilter,

        openCase: {
          $ne: null,
        },
      }),

      ShiftAssignment.countDocuments({
        ...scopeFilter,

        assignmentType: "replacement",
      }),

      ShiftAssignment.countDocuments({
        ...scopeFilter,

        assignmentType: "replacement",

        occurrence: {
          $ne: null,
        },
      }),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredAssignments / ASSIGNMENTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * ASSIGNMENTS_PER_PAGE;

    const assignments =
      totalFilteredAssignments > 0
        ? await ShiftAssignmentQueryService.buildAssignmentQuery(filteredAssignmentFilter)
            .sort({
              assignedAt: -1,

              _id: -1,
            })
            .skip(skip)
            .limit(ASSIGNMENTS_PER_PAGE)
            .lean()
        : [];

    const occurrences =
      await ShiftAssignmentQueryService.getAssignmentOccurrenceContext(assignments);

    const statusCounts = ShiftAssignmentQueryService.buildStatusCounts(
      statusCountResults,

      totalForStatusTabs
    );

    const assignmentTypeCounts = ShiftAssignmentQueryService.buildAssignmentTypeCounts(
      assignmentTypeCountResults,

      totalForAssignmentTypeTabs
    );

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode,

        currency,
      },

      assignments,

      occurrences,

      focusedShift,

      selectedStatus,

      selectedAssignmentType,

      statusCounts,

      assignmentTypeCounts,

      scopeCounts: {
        totalAssignments: Number(totalAssignments || 0),

        currentAssignments: Number(currentAssignmentCount || 0),

        assignmentsWithOpenCase: Number(openCaseAssignmentCount || 0),

        replacementAssignments: Number(replacementAssignmentCount || 0),

        isolatedReplacementAssignments: Number(isolatedReplacementAssignmentCount || 0),
      },

      canManageAssignments: ShiftAssignmentQueryService.canManageAssignments(employerContext),

      currentTime: normalizedCurrentTime,

      pagination: {
        currentPage,

        totalPages,

        totalItems: totalFilteredAssignments,

        perPage: ASSIGNMENTS_PER_PAGE,

        startItem: totalFilteredAssignments > 0 ? skip + 1 : 0,

        endItem: totalFilteredAssignments > 0 ? skip + assignments.length : 0,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,

        hasPagination: totalPages > 1,
      },
    };
  }

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createAssignmentQueryError(options) {
    return createAssignmentQueryError(options);
  }
}

module.exports = ShiftAssignmentQueryService;
