// services/shifts/attendance/shiftAttendanceQueryService.js

const mongoose = require("mongoose");

const Shift = require("../../../models/Shift");
const ShiftOccurrence = require("../../../models/ShiftOccurrence");

const ShiftQueryService = require("../shiftQueryService");

const { ATTENDANCE_STATUSES } = require("../../../constants/shiftLifecycle");

const { createServiceError } = require("../../helpers/serviceErrorHelper");

const { normalizeObjectId } = require("../../helpers/serviceValidationHelpers");

const SHIFT_ATTENDANCE_QUERY_SERVICE_ERROR_NAME = "ShiftAttendanceQueryServiceError";

const ATTENDANCE_OCCURRENCES_PER_PAGE = 25;

const ATTENDANCE_REVIEW_STATUSES = Object.freeze([
  "missed_checkin_review",
  "checkout_fallback_review",
]);

const SHIFT_FIELDS = Object.freeze([
  "referenceCode",
  "branch",
  "roleTitle",
  "professionalType",
  "scheduleMode",
  "occurrenceCount",
  "requiredProfessionals",
  "totalOccurrenceCount",
  "scheduleTimeZone",
  "status",
  "paymentStatus",
  "startTime",
  "endTime",
  "occurrenceProgress",
  "createdAt",
]);

const OCCURRENCE_FIELDS = Object.freeze([
  "referenceCode",
  "shift",
  "business",
  "branch",

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

  "status",
  "attendanceStatus",

  "checkedInAt",
  "checkedOutAt",

  "attendancePinsGeneratedAt",
  "checkInPinUsedAt",
  "checkOutPinUsedAt",

  "absenceExplanation",
  "absenceExplainedAt",

  "attendanceOverride",
  "lateCheckout",
  "checkoutFallback",
  "earlyTermination",

  "settlementStatus",
  "activeClaim",
  "activeDispute",

  "createdAt",
  "updatedAt",
]);

const PROFESSIONAL_FIELDS = Object.freeze([
  "user",
  "type",
  "specialty",
  "yearsOfExperience",
  "averageRating",
  "totalShiftsCompleted",
  "availabilityStatus",
  "licenceVerificationStatus",
  "identityVerificationStatus",
  "professionalApprovalStatus",
  "accountStatus",
  "marketplaceStatus",
]);

const USER_IDENTITY_FIELDS = Object.freeze(["firstName", "lastName", "displayName", "photo"]);

const ASSIGNMENT_FIELDS = Object.freeze([
  "referenceCode",
  "shift",
  "professional",
  "slotNumber",
  "assignmentType",
  "startSequence",
  "plannedEndSequence",
  "effectiveEndSequence",
  "status",
  "isCurrentAssignment",
]);

function createAttendanceQueryError(options) {
  return createServiceError({
    ...options,

    name: SHIFT_ATTENDANCE_QUERY_SERVICE_ERROR_NAME,
  });
}

class ShiftAttendanceQueryService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createAttendanceQueryError({
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

  static normalizeAttendanceStatus(value) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    return status === "all" || ATTENDANCE_STATUSES.includes(status) ? status : "all";
  }

  static normalizeOptionalShiftId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return normalizeObjectId({
      value,

      fieldName: "Shift ID",

      createError: createAttendanceQueryError,
    });
  }

  /* ─────────────────────────────── PERMISSIONS ─────────────────────────────── */

  static canManageAttendance(employerContext = null) {
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

  /* ─────────────────────────────── SHIFT SCOPE ─────────────────────────────── */

  static async getFocusedShift({ employerProfileId, employerContext = null, shiftId = null }) {
    if (!shiftId) {
      return null;
    }

    const shiftFilter = ShiftQueryService.buildEmployerShiftAccessFilter({
      employerProfileId,

      employerContext,

      shiftId,
    });

    const shift = await Shift.findOne(shiftFilter)
      .select(SHIFT_FIELDS.join(" "))
      .populate("branch", "name address state lga geofenceRadiusMeters")
      .lean();

    if (!shift) {
      throw createAttendanceQueryError({
        message: "Shift was not found or is not available to you.",

        code: "SHIFT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return shift;
  }

  static buildAttendanceScopeFilter({ employerProfileId, employerContext = null, shiftId = null }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,

      fieldName: "employer profile ID",

      createError: createAttendanceQueryError,
    });

    const filter = {
      business: normalizedEmployerProfileId,

      assignmentStatus: "assigned",

      assignedProfessional: {
        $ne: null,
      },

      assignment: {
        $ne: null,
      },

      assignedAt: {
        $ne: null,
      },
    };

    if (shiftId) {
      filter.shift = normalizeObjectId({
        value: shiftId,

        fieldName: "Shift ID",

        createError: createAttendanceQueryError,
      });
    }

    if (!ShiftAttendanceQueryService.canManageAllBranches(employerContext)) {
      filter.branch = {
        $in: ShiftAttendanceQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return filter;
  }

  static applyAttendanceStatusFilter(filter, status) {
    if (status === "all") {
      return {
        ...filter,
      };
    }

    return {
      ...filter,

      attendanceStatus: status,
    };
  }

  /* ─────────────────────────────── POPULATED QUERY ─────────────────────────────── */

  static buildOccurrenceQuery(filter) {
    return ShiftOccurrence.find(filter)
      .select(OCCURRENCE_FIELDS.join(" "))
      .populate({
        path: "shift",

        select: SHIFT_FIELDS.join(" "),

        populate: {
          path: "branch",

          select: "name address state lga geofenceRadiusMeters",
        },
      })
      .populate("branch", "name address state lga geofenceRadiusMeters")
      .populate({
        path: "assignedProfessional",

        select: PROFESSIONAL_FIELDS.join(" "),

        populate: {
          path: "user",

          select: USER_IDENTITY_FIELDS.join(" "),
        },
      })
      .populate({
        path: "assignment",

        select: ASSIGNMENT_FIELDS.join(" "),
      });
  }

  /* ─────────────────────────────── COUNTS ─────────────────────────────── */

  static buildAttendanceStatusCounts(results = [], allCount = 0) {
    const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));

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

  /* ─────────────────────────────── PAGE DATA ─────────────────────────────── */

  static async getEmployerAttendancePageData({
    userId,
    employerProfile = null,
    employerContext = null,
    attendanceStatus = "all",
    shiftId = null,
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftAttendanceQueryService.normalizeCurrentTime(currentTime);

    ShiftQueryService.assertCanViewShifts(employerContext);

    const profile = await ShiftQueryService.getEmployerProfileForUser(
      userId,
      employerProfile,
      employerContext
    );

    const selectedAttendanceStatus =
      ShiftAttendanceQueryService.normalizeAttendanceStatus(attendanceStatus);

    const selectedShiftId = ShiftAttendanceQueryService.normalizeOptionalShiftId(shiftId);

    const requestedPage = ShiftAttendanceQueryService.normalizePageNumber(page);

    const focusedShift = await ShiftAttendanceQueryService.getFocusedShift({
      employerProfileId: profile._id,

      employerContext,

      shiftId: selectedShiftId,
    });

    const scopeFilter = ShiftAttendanceQueryService.buildAttendanceScopeFilter({
      employerProfileId: profile._id,

      employerContext,

      shiftId: selectedShiftId,
    });

    const filteredOccurrenceFilter = ShiftAttendanceQueryService.applyAttendanceStatusFilter(
      scopeFilter,
      selectedAttendanceStatus
    );

    const [
      totalFilteredOccurrences,
      totalOccurrences,
      attendanceStatusResults,
      currentlyCheckedInCount,
      reviewRequiredCount,
      noShowCount,
      settledAttendanceCount,
    ] = await Promise.all([
      ShiftOccurrence.countDocuments(filteredOccurrenceFilter),

      ShiftOccurrence.countDocuments(scopeFilter),

      ShiftOccurrence.aggregate([
        {
          $match: scopeFilter,
        },
        {
          $group: {
            _id: "$attendanceStatus",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      ShiftOccurrence.countDocuments({
        ...scopeFilter,

        attendanceStatus: "checked_in",
      }),

      ShiftOccurrence.countDocuments({
        ...scopeFilter,

        attendanceStatus: {
          $in: ATTENDANCE_REVIEW_STATUSES,
        },
      }),

      ShiftOccurrence.countDocuments({
        ...scopeFilter,

        attendanceStatus: "no_show",
      }),

      ShiftOccurrence.countDocuments({
        ...scopeFilter,

        attendanceStatus: "settled",
      }),
    ]);

    const totalPages = Math.max(
      Math.ceil(totalFilteredOccurrences / ATTENDANCE_OCCURRENCES_PER_PAGE),
      1
    );

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * ATTENDANCE_OCCURRENCES_PER_PAGE;

    const occurrences =
      totalFilteredOccurrences > 0
        ? await ShiftAttendanceQueryService.buildOccurrenceQuery(filteredOccurrenceFilter)
            .sort({
              startTime: -1,

              slotNumber: 1,

              sequenceNumber: 1,

              _id: 1,
            })
            .skip(skip)
            .limit(ATTENDANCE_OCCURRENCES_PER_PAGE)
            .lean()
        : [];

    return {
      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode || null,

        currency: profile.currency || null,
      },

      occurrences,

      focusedShift,

      selectedAttendanceStatus,

      attendanceStatusCounts: ShiftAttendanceQueryService.buildAttendanceStatusCounts(
        attendanceStatusResults,
        totalOccurrences
      ),

      scopeCounts: {
        totalOccurrences: Number(totalOccurrences || 0),

        currentlyCheckedIn: Number(currentlyCheckedInCount || 0),

        reviewRequired: Number(reviewRequiredCount || 0),

        noShow: Number(noShowCount || 0),

        settledAttendance: Number(settledAttendanceCount || 0),
      },

      canManageAttendance: ShiftAttendanceQueryService.canManageAttendance(employerContext),

      canRevealAttendancePins: ShiftAttendanceQueryService.canManageAttendance(employerContext),

      currentTime: normalizedCurrentTime,

      pagination: {
        currentPage,

        totalPages,

        totalItems: totalFilteredOccurrences,

        perPage: ATTENDANCE_OCCURRENCES_PER_PAGE,

        startItem: totalFilteredOccurrences > 0 ? skip + 1 : 0,

        endItem: totalFilteredOccurrences > 0 ? skip + occurrences.length : 0,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,

        hasPagination: totalPages > 1,
      },
    };
  }

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createAttendanceQueryError(options) {
    return createAttendanceQueryError(options);
  }
}

module.exports = ShiftAttendanceQueryService;
