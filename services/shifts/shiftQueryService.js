// services/shifts/shiftQueryService.js

const mongoose = require("mongoose");

const Shift = require("../../models/Shift");
const ShiftOccurrence = require("../../models/ShiftOccurrence");
const Branch = require("../../models/Branch");
const EmployerProfile = require("../../models/EmployerProfile");

const PlatformSettingsService = require("../platformSettingsService");
const WalletService = require("../walletService");
const ShiftLifecycleService = require("../shiftLifecycleService");

const ShiftScheduleService = require("./shiftScheduleService");
const ShiftPricingService = require("./shiftPricingService");
const ShiftViewService = require("./shiftViewService");

const { SHIFTS_PER_PAGE, SHIFT_STATUS_FILTERS } = require("../../constants/shiftPresentation");

const { createServiceError } = require("../helpers/serviceErrorHelper");

const { normalizeObjectId } = require("../helpers/serviceValidationHelpers");

const SHIFT_SERVICE_ERROR_NAME = "ShiftServiceError";

const MAX_VISIBLE_PAGINATION_PAGES = 5;
const UNFUNDED_SHIFT_EXPIRY_BATCH_LIMIT = 500;
const MIN_MULTIPLE_OCCURRENCE_COUNT = 2;

const ACTIVE_BRANCH_FIELDS = [
  "name",
  "address",
  "state",
  "lga",
  "location",
  "geofenceRadiusMeters",
];

const SHIFT_SUMMARY_CARD_DEFINITIONS = [
  {
    status: "all",
    label: "All Shifts",
    description: "Total engagements created",
  },
  {
    status: "open",
    label: "Open",
    description: "Available for applications",
  },
  {
    status: "confirmed",
    label: "Confirmed",
    description: "Professionals confirmed",
  },
  {
    status: "in_progress",
    label: "In Progress",
    description: "Currently underway",
  },
  {
    status: "pending_settlement",
    label: "Pending Settlement",
    description: "Awaiting settlement",
  },
  {
    status: "completed",
    label: "Completed",
    description: "Successfully completed",
  },
];

function createShiftError(options) {
  return createServiceError({
    ...options,
    name: SHIFT_SERVICE_ERROR_NAME,
  });
}

const SHIFT_LIST_FIELDS = [
  "referenceCode",
  "branch",
  "roleTitle",
  "professionalType",
  "scheduleMode",
  "occurrenceCount",
  "repeatDays",
  "firstOccurrenceDate",
  "lastOccurrenceDate",
  "scheduleTimeZone",
  "dailyStartTimeMinutes",
  "dailyEndTimeMinutes",
  "endsNextDay",
  "scheduledMinutesPerOccurrence",
  "totalScheduledMinutes",
  "startTime",
  "endTime",
  "scheduledHours",
  "breakDuration",
  "hourlyRate",
  "estimatedProfessionalPay",
  "estimatedPlatformFee",
  "estimatedEmployerCharge",
  "fundingMethod",
  "fundedAmount",
  "topUpRequired",
  "refundedAmount",
  "fundingInitiatedAt",
  "fundedAt",
  "publishedAt",
  "settlementSummary",
  "occurrenceProgress",
  "totalApplications",
  "currentRoundApplications",
  "status",
  "paymentStatus",
  "cancellationCode",
  "cancelledAt",
  "createdAt",
];

const SHIFT_CARD_OCCURRENCE_FIELDS = [
  "shift",
  "referenceCode",
  "sequenceNumber",
  "occurrenceDate",
  "assignmentStatus",
  "assignedProfessional",
  "assignment",
  "assignedAt",
  "status",
  "attendanceStatus",
  "settlementStatus",
  "refundStatus",
  "startTime",
  "endTime",
  "scheduledMinutes",
  "estimatedProfessionalPay",
  "estimatedPlatformFee",
  "estimatedEmployerCharge",
  "fillCutoffAt",
  "checkedInAt",
  "checkedOutAt",
  "cancellationCode",
  "cancelledAt",
];

const SHIFT_DETAILS_FIELDS = [
  "referenceCode",
  "business",
  "branch",
  "postedBy",
  "countryCode",
  "currency",
  "department",
  "roleTitle",
  "professionalType",
  "scheduleMode",
  "occurrenceCount",
  "repeatDays",
  "firstOccurrenceDate",
  "lastOccurrenceDate",
  "scheduleTimeZone",
  "dailyStartTimeMinutes",
  "dailyEndTimeMinutes",
  "endsNextDay",
  "scheduledMinutesPerOccurrence",
  "totalScheduledMinutes",
  "startTime",
  "endTime",
  "scheduledHours",
  "breakDuration",
  "hourlyRate",
  "platformFeeRate",
  "pricingLockedAt",
  "pricingLockedBy",
  "cancellationPolicySnapshot",
  "estimatedProfessionalPay",
  "estimatedPlatformFee",
  "estimatedEmployerCharge",
  "fundingMethod",
  "fundedAmount",
  "topUpRequired",
  "refundedAmount",
  "fundingInitiatedAt",
  "fundedAt",
  "publishedAt",
  "fundingTransaction",
  "totalApplications",
  "currentRoundApplications",
  "applicationRound",
  "activeAssignment",
  "replacementHiring",
  "occurrenceProgress",
  "settlementSummary",
  "status",
  "paymentStatus",
  "attendanceStatus",
  "assignedProfessional",
  "cancelledFromStatus",
  "cancellationCode",
  "cancelledBy",
  "cancelledByUser",
  "cancellationReasonCode",
  "cancellationReason",
  "cancelledAt",
  "cancellationSummary",
  "activeWorkCancellation",
  "requiredSkills",
  "dressCode",
  "description",
  "createdAt",
  "updatedAt",
];

const SHIFT_DETAILS_OCCURRENCE_FIELDS = [
  "shift",
  "business",
  "branch",
  "referenceCode",
  "sequenceNumber",
  "occurrenceDate",
  "scheduleTimeZone",

  "assignmentStatus",
  "assignedProfessional",
  "assignment",
  "assignedAt",

  "replacementRequiredAt",
  "replacementForAssignment",
  "replacementCase",
  "replacementReasonCode",
  "replacementReasonDetails",

  "status",
  "attendanceStatus",
  "settlementStatus",

  "startTime",
  "endTime",
  "scheduledMinutes",
  "scheduledHours",
  "breakDuration",
  "fillCutoffAt",
  "unfilledFinalizationAt",
  "expiredFromAssignmentStatus",
  "expiredUnfilledAt",

  "hourlyRate",
  "platformFeeRate",
  "estimatedProfessionalPay",
  "estimatedPlatformFee",
  "estimatedEmployerCharge",

  "baseProfessionalPay",
  "basePlatformFee",
  "overtimeProfessionalPay",
  "overtimePlatformFee",
  "topUpRequired",

  "baseBillableHours",
  "billableHours",

  "basePlatformFeeAudit",
  "overtimePlatformFeeAudit",

  "challengeWindowOpenedAt",
  "challengeDeadlineAt",
  "challengeWindowClosedAt",
  "challengeableSettlementComponents",
  "activeClaim",
  "activeDispute",

  "baseSettlement",
  "overtimeSettlement",
  "settledAt",

  "refundableAmount",
  "refundedAmount",
  "refundStatus",
  "refundReason",
  "refundEligibleAt",
  "refundLastEvaluatedAt",
  "refundHeldAt",
  "refundHoldReason",
  "employerRefund",
  "refundBatch",
  "refundProcessingStartedAt",
  "refundedAt",

  "checkedInAt",
  "checkedOutAt",
  "checkInPinUsedAt",
  "checkOutPinUsedAt",
  "absenceExplanation",
  "absenceExplainedAt",
  "attendanceOverride",
  "lateCheckout",
  "checkoutFallback",

  "overtime",
  "topUpTransaction",

  "cancellationCode",
  "cancelledBy",
  "cancelledByUser",
  "cancellationReason",
  "cancelledAt",
  "cancellationCompensation",
  "activeWorkCancellation",

  "createdAt",
  "updatedAt",
];

class ShiftQueryService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeCurrentTime(value) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw createShiftError({
        message: "The current time is invalid.",
        code: "INVALID_CURRENT_TIME",
        statusCode: 500,
      });
    }

    return currentTime;
  }

  /* ─────────────────────────────── EMPLOYER ACCESS ─────────────────────────────── */

  static async getEmployerProfileForUser(userId, employerProfile = null) {
    const normalizedUserId = normalizeObjectId({
      value: userId,
      fieldName: "user ID",
      createError: createShiftError,
    });

    if (employerProfile?._id) {
      return employerProfile;
    }

    const profile = await EmployerProfile.findOne({
      user: normalizedUserId,
    }).lean();

    if (!profile) {
      throw createShiftError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return profile;
  }

  static businessCanPostShifts(profile) {
    return Boolean(
      profile?._id &&
      profile.cacVerificationStatus === "verified" &&
      profile.regulatoryVerificationStatus === "verified" &&
      profile.employerApprovalStatus === "approved" &&
      profile.accountStatus === "active"
    );
  }

  static roleCanManageShiftLifecycle(employerContext = null) {
    if (typeof employerContext?.roleCanPostShifts === "boolean") {
      return employerContext.roleCanPostShifts;
    }

    /*
     * Compatibility fallback for callers that have not yet separated raw
     * employer-role authority from delinquency-aware canPostShifts.
     *
     * Existing Shift lifecycle management must not be disabled merely because
     * the employer is temporarily restricted from creating new obligations.
     */
    return employerContext?.canPostShifts === true;
  }

  static assertCanViewShifts(employerContext = null) {
    if (employerContext?.canViewShifts !== true) {
      throw createShiftError({
        message: "You do not have permission to view Shifts.",
        code: "SHIFT_VIEW_NOT_ALLOWED",
        statusCode: 403,
      });
    }
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

  /* ─────────────────────────────── BRANCH QUERIES ─────────────────────────────── */

  static async getActiveBranches({
    employerProfileId,
    canManageAllBranches = false,
    assignedBranchIds = [],
  }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,
      fieldName: "employer profile ID",
      createError: createShiftError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
      isActive: true,
    };

    if (!canManageAllBranches) {
      filter._id = {
        $in: assignedBranchIds,
      };
    }

    return Branch.find(filter)
      .select(ACTIVE_BRANCH_FIELDS.join(" "))
      .sort({
        name: 1,
      })
      .lean();
  }

  /* ─────────────────────────────── FILTERS / PAGINATION ─────────────────────────────── */

  static normalizeShiftStatusFilter(value) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    const isAllowed = SHIFT_STATUS_FILTERS.some((filter) => filter.value === status);

    return isAllowed ? status : "all";
  }

  static normalizePageNumber(value) {
    const page = Number.parseInt(value, 10);

    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  }

  static buildEmployerShiftsUrl({ status = "all", page = 1 } = {}) {
    const params = new URLSearchParams();

    if (status !== "all") {
      params.set("status", status);
    }

    if (page > 1) {
      params.set("page", String(page));
    }

    const queryString = params.toString();

    const baseUrl = ShiftViewService.getEmployerShiftsUrl();

    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }

  static buildPaginationPages({ currentPage, totalPages, status }) {
    if (totalPages <= 1) {
      return [];
    }

    let startPage = Math.max(currentPage - 2, 1);

    let endPage = Math.min(startPage + MAX_VISIBLE_PAGINATION_PAGES - 1, totalPages);

    startPage = Math.max(endPage - MAX_VISIBLE_PAGINATION_PAGES + 1, 1);

    const pages = [];

    for (let page = startPage; page <= endPage; page += 1) {
      pages.push({
        page,

        isActive: page === currentPage,

        url: ShiftQueryService.buildEmployerShiftsUrl({
          status,
          page,
        }),
      });
    }

    return pages;
  }

  /* ─────────────────────────────── ACCESS FILTERS / EXPIRY ─────────────────────────────── */

  static buildEmployerShiftAccessFilter({
    employerProfileId,
    employerContext = null,
    shiftId = null,
  }) {
    const normalizedEmployerProfileId = normalizeObjectId({
      value: employerProfileId,
      fieldName: "employer profile ID",
      createError: createShiftError,
    });

    const filter = {
      business: normalizedEmployerProfileId,
    };

    if (shiftId) {
      filter._id = normalizeObjectId({
        value: shiftId,
        fieldName: "Shift ID",
        createError: createShiftError,
      });
    }

    if (!ShiftQueryService.canManageAllBranches(employerContext)) {
      filter.branch = {
        $in: ShiftQueryService.getAssignedBranchObjectIds(employerContext),
      };
    }

    return filter;
  }

  static async expireAccessibleUnfundedShifts({
    employerProfileId,
    employerContext = null,
    currentTime = new Date(),
    limit = UNFUNDED_SHIFT_EXPIRY_BATCH_LIMIT,
  }) {
    const normalizedCurrentTime = ShiftQueryService.normalizeCurrentTime(currentTime);

    const normalizedLimit = Number(limit);

    if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1) {
      throw createShiftError({
        message: "The unfunded Shift expiry limit is invalid.",
        code: "INVALID_UNFUNDED_SHIFT_EXPIRY_LIMIT",
        statusCode: 500,
      });
    }

    const filter = ShiftQueryService.buildEmployerShiftAccessFilter({
      employerProfileId,
      employerContext,
    });

    filter.status = "pending_funding";

    filter.paymentStatus = "unpaid";

    filter.$or = [
      {
        fundedAmount: 0,
      },
      {
        fundedAmount: null,
      },
      {
        fundedAmount: {
          $exists: false,
        },
      },
    ];

    filter.startTime = {
      $lte: normalizedCurrentTime,
    };

    const staleShifts = await Shift.find(filter)
      .select("_id")
      .sort({
        startTime: 1,
        _id: 1,
      })
      .limit(normalizedLimit)
      .lean();

    for (const staleShift of staleShifts) {
      await ShiftLifecycleService.expireUnfundedShift({
        shiftId: staleShift._id,
        now: normalizedCurrentTime,
      });
    }

    return staleShifts.length;
  }

  /* ─────────────────────────────── MANAGE SHIFTS PAGE ─────────────────────────────── */

  static async getEmployerShiftsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    status = "all",
    page = 1,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftQueryService.normalizeCurrentTime(currentTime);

    const profile = await ShiftQueryService.getEmployerProfileForUser(userId, employerProfile);

    ShiftQueryService.assertCanViewShifts(employerContext);

    const canPostShifts = employerContext?.canPostShifts === true;

    const canManageAllBranches = ShiftQueryService.canManageAllBranches(employerContext);

    const assignedBranchObjectIds = ShiftQueryService.getAssignedBranchObjectIds(employerContext);

    await ShiftQueryService.expireAccessibleUnfundedShifts({
      employerProfileId: profile._id,

      employerContext,

      currentTime: normalizedCurrentTime,

      limit: UNFUNDED_SHIFT_EXPIRY_BATCH_LIMIT,
    });

    const selectedStatus = ShiftQueryService.normalizeShiftStatusFilter(status);

    const requestedPage = ShiftQueryService.normalizePageNumber(page);

    const currency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    if (!currency) {
      throw createShiftError({
        message: "The employer currency could not be resolved.",
        code: "EMPLOYER_CURRENCY_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    const businessCanPostShifts = ShiftQueryService.businessCanPostShifts(profile);

    const canOpenPostShiftModal = Boolean(canPostShifts && businessCanPostShifts);

    let branchOptions = [];
    let pricingView = null;

    if (canOpenPostShiftModal) {
      const [branches, shiftPostingSettings] = await Promise.all([
        ShiftQueryService.getActiveBranches({
          employerProfileId: profile._id,

          canManageAllBranches,

          assignedBranchIds: assignedBranchObjectIds,
        }),

        PlatformSettingsService.getShiftPostingSettings(profile.countryCode),
      ]);

      const { pricing } = shiftPostingSettings;

      if (!pricing || typeof pricing !== "object") {
        throw createShiftError({
          message: "The active Shift pricing settings could not be resolved.",
          code: "SHIFT_PRICING_SETTINGS_NOT_RESOLVED",
          statusCode: 500,
        });
      }

      const cancellationPolicy = ShiftPricingService.normalizeCancellationPolicy(
        shiftPostingSettings.cancellationPolicy ||
          shiftPostingSettings.shiftCancellationPolicy ||
          shiftPostingSettings.cancellation
      );

      const platformCurrency = String(pricing.currency || "")
        .trim()
        .toUpperCase();

      if (!platformCurrency) {
        throw createShiftError({
          message: "The active platform currency could not be resolved.",
          code: "PLATFORM_CURRENCY_NOT_RESOLVED",
          statusCode: 500,
        });
      }

      if (currency !== platformCurrency) {
        throw createShiftError({
          message: "The employer currency does not match the active platform currency.",
          code: "EMPLOYER_CURRENCY_MISMATCH",
          statusCode: 500,
        });
      }

      branchOptions = branches.map((branch) => ShiftViewService.buildBranchOption(branch));

      pricingView = {
        countryCode: pricing.countryCode,

        currency: platformCurrency,

        platformFeeRate: pricing.platformFeeRate,

        platformFeePercent: Number((pricing.platformFeeRate * 100).toFixed(2)),

        platformFeeLabel: `${(pricing.platformFeeRate * 100).toFixed(2)}%`,

        cancellationPolicy: {
          ...cancellationPolicy,

          lateCancellationProfessionalPayPercent: Number(
            (cancellationPolicy.lateCancellationProfessionalPayRate * 100).toFixed(2)
          ),

          activeWorkCancellationMinimumPayPercent: Number(
            (cancellationPolicy.activeWorkCancellationMinimumPayRate * 100).toFixed(2)
          ),
        },
      };
    }

    const filter = {
      business: profile._id,
    };

    if (!canManageAllBranches) {
      filter.branch = {
        $in: assignedBranchObjectIds,
      };
    }

    if (selectedStatus !== "all") {
      filter.status = selectedStatus;
    }

    const statusCountMatch = {
      business: new mongoose.Types.ObjectId(String(profile._id)),
    };

    if (!canManageAllBranches) {
      statusCountMatch.branch = {
        $in: assignedBranchObjectIds,
      };
    }

    const [totalFilteredShifts, statusCountResults, employerWallet] = await Promise.all([
      Shift.countDocuments(filter),

      Shift.aggregate([
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

      WalletService.createEmployerWalletIfMissing(profile),
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredShifts / SHIFTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * SHIFTS_PER_PAGE;

    const shifts = await Shift.find(filter)
      .select(SHIFT_LIST_FIELDS.join(" "))
      .populate("branch", "name address state lga")
      .sort({
        startTime: -1,
        createdAt: -1,
      })
      .skip(skip)
      .limit(SHIFTS_PER_PAGE)
      .lean();

    const shiftIds = shifts.map((shift) => shift._id);

    const occurrenceRows =
      shiftIds.length > 0
        ? await ShiftOccurrence.find({
            shift: {
              $in: shiftIds,
            },
          })
            .select(SHIFT_CARD_OCCURRENCE_FIELDS.join(" "))
            .sort({
              shift: 1,
              sequenceNumber: 1,
            })
            .lean()
        : [];

    const occurrencesByShiftId = new Map();

    for (const occurrence of occurrenceRows) {
      const shiftKey = String(occurrence.shift);

      if (!occurrencesByShiftId.has(shiftKey)) {
        occurrencesByShiftId.set(shiftKey, []);
      }

      occurrencesByShiftId.get(shiftKey).push(occurrence);
    }

    const statusCounts = Object.fromEntries(
      SHIFT_STATUS_FILTERS.filter((item) => item.value !== "all").map((item) => [item.value, 0])
    );

    for (const result of statusCountResults) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, result._id)) {
        statusCounts[result._id] = result.count;
      }
    }

    const totalAllShifts = statusCountResults.reduce(
      (sum, result) => sum + Number(result.count || 0),
      0
    );

    const selectedFilter = SHIFT_STATUS_FILTERS.find((item) => item.value === selectedStatus);

    const filterTabs = SHIFT_STATUS_FILTERS.map((item) => ({
      value: item.value,

      label: item.label,

      count: item.value === "all" ? totalAllShifts : statusCounts[item.value] || 0,

      url: ShiftQueryService.buildEmployerShiftsUrl({
        status: item.value,
      }),

      isActive: item.value === selectedStatus,
    }));

    const summaryCards = SHIFT_SUMMARY_CARD_DEFINITIONS.map((card) => {
      const filterTab = filterTabs.find((filterItem) => filterItem.value === card.status);

      return {
        status: card.status,
        label: card.label,
        description: card.description,
        count: filterTab?.count || 0,
      };
    });

    const shiftViews = shifts.map((shift) => {
      const shiftOccurrences = occurrencesByShiftId.get(String(shift._id)) || [];

      return ShiftViewService.buildEmployerShiftView(
        shift,
        currency,
        normalizedCurrentTime,
        shiftOccurrences,
        employerWallet
      );
    });

    const postShiftModalId = ShiftViewService.getPostShiftModalId();

    const fundShiftModalId = ShiftViewService.getFundShiftModalId();

    const employerShiftsUrl = ShiftViewService.getEmployerShiftsUrl();

    return {
      pageTitle: "Manage Shifts",

      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode,

        currency,
      },

      selectedStatus,

      selectedStatusLabel: selectedFilter?.label || "All Shifts",

      filterTabs,

      summaryCards,

      shifts: shiftViews,

      hasShifts: shiftViews.length > 0,

      postShiftForm: {
        canPostShifts,

        businessCanPostShifts,

        canOpenModal: canOpenPostShiftModal,

        unavailableMessage: !canPostShifts
          ? "You do not have permission to post Shifts."
          : !businessCanPostShifts
            ? "The business must be verified and approved before Shifts can be posted."
            : null,

        branchOptions,

        hasBranches: branchOptions.length > 0,

        hasSelectableBranches: branchOptions.some((branch) => branch.isSelectable),

        professionalTypeOptions: ShiftViewService.getPostableProfessionalTypeOptions(),

        activeProfessionalTypes: ShiftViewService.getActiveProfessionalTypes(),

        scheduleModeOptions: ShiftScheduleService.getScheduleModeOptions(),

        repeatDayOptions: ShiftScheduleService.getRepeatDayOptions(),

        maximumOccurrenceCount: ShiftScheduleService.getMaximumOccurrenceCount(),

        minimumMultipleOccurrenceCount: MIN_MULTIPLE_OCCURRENCE_COUNT,

        timeZone: ShiftScheduleService.getTimeZone(),

        pricing: pricingView,

        modalId: postShiftModalId,

        createShiftUrl: employerShiftsUrl,
      },

      fundingModal: ShiftViewService.buildFundingModalView({
        employerWallet,
        currency,
      }),

      emptyState: {
        message:
          selectedStatus === "all"
            ? "No Shifts have been created yet."
            : `There are no ${(selectedFilter?.label || selectedStatus).toLowerCase()} Shifts.`,

        canPostShift: canOpenPostShiftModal,

        postShiftModalId,
      },

      pagination: {
        currentPage,

        totalPages,

        totalItems: totalFilteredShifts,

        perPage: SHIFTS_PER_PAGE,

        startItem: totalFilteredShifts > 0 ? skip + 1 : 0,

        endItem: totalFilteredShifts > 0 ? skip + shiftViews.length : 0,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,

        previousPageUrl:
          currentPage > 1
            ? ShiftQueryService.buildEmployerShiftsUrl({
                status: selectedStatus,

                page: currentPage - 1,
              })
            : null,

        nextPageUrl:
          currentPage < totalPages
            ? ShiftQueryService.buildEmployerShiftsUrl({
                status: selectedStatus,

                page: currentPage + 1,
              })
            : null,

        pages: ShiftQueryService.buildPaginationPages({
          currentPage,
          totalPages,
          status: selectedStatus,
        }),

        hasPagination: totalPages > 1,
      },

      actions: {
        manageShiftsUrl: employerShiftsUrl,

        createShiftUrl: employerShiftsUrl,

        postShiftModalId,

        fundShiftModalId,
      },
    };
  }

  /* ─────────────────────────────── SHIFT DETAILS PAGE ─────────────────────────────── */

  static async getEmployerShiftDetailsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    shiftId,
    occurrenceId = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftQueryService.normalizeCurrentTime(currentTime);

    const profile = await ShiftQueryService.getEmployerProfileForUser(userId, employerProfile);

    ShiftQueryService.assertCanViewShifts(employerContext);

    const shiftFilter = ShiftQueryService.buildEmployerShiftAccessFilter({
      employerProfileId: profile._id,

      employerContext,

      shiftId,
    });

    const existingShift = await Shift.findOne(shiftFilter)
      .select("_id status paymentStatus fundedAmount startTime")
      .lean();

    if (!existingShift) {
      throw createShiftError({
        message: "Shift not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (
      existingShift.status === "pending_funding" &&
      existingShift.paymentStatus === "unpaid" &&
      Number(existingShift.fundedAmount || 0) === 0 &&
      new Date(existingShift.startTime) <= normalizedCurrentTime
    ) {
      await ShiftLifecycleService.expireUnfundedShift({
        shiftId: existingShift._id,

        now: normalizedCurrentTime,
      });
    }

    const shift = await Shift.findOne(shiftFilter)
      .select(SHIFT_DETAILS_FIELDS.join(" "))
      .populate("branch", "name address state lga geofenceRadiusMeters")
      .lean();

    if (!shift) {
      throw createShiftError({
        message: "Shift not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    let selectedOccurrenceId = null;

    if (occurrenceId) {
      selectedOccurrenceId = String(
        normalizeObjectId({
          value: occurrenceId,
          fieldName: "occurrence ID",
          createError: createShiftError,
        })
      );
    }

    const occurrences = await ShiftOccurrence.find({
      shift: shift._id,

      business: profile._id,

      branch: shift.branch?._id || shift.branch,
    })
      .select(SHIFT_DETAILS_OCCURRENCE_FIELDS.join(" "))
      .sort({
        sequenceNumber: 1,
      })
      .lean();

    if (
      selectedOccurrenceId &&
      !occurrences.some((occurrence) => String(occurrence._id) === selectedOccurrenceId)
    ) {
      throw createShiftError({
        message: "The selected occurrence does not belong to this Shift.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    const employerWallet = await WalletService.createEmployerWalletIfMissing(profile);

    const currency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    if (!currency) {
      throw createShiftError({
        message: "The employer currency could not be resolved.",
        code: "EMPLOYER_CURRENCY_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    const shiftView = ShiftViewService.buildEmployerShiftDetailsView({
      shift,
      occurrences,
      selectedOccurrenceId,
      employerWallet,
      currency,

      currentTime: normalizedCurrentTime,

      canManageLifecycle: ShiftQueryService.roleCanManageShiftLifecycle(employerContext),
    });

    return {
      pageTitle: `${shift.referenceCode} · Shift Details`,

      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        countryCode: profile.countryCode,

        currency,
      },

      shift: shiftView,

      fundingModal: ShiftViewService.buildFundingModalView({
        employerWallet,
        currency,
      }),

      actions: {
        manageShiftsUrl: ShiftViewService.getEmployerShiftsUrl(),

        fundShiftModalId: ShiftViewService.getFundShiftModalId(),
      },
    };
  }
}

module.exports = ShiftQueryService;
