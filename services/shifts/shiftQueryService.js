// services/shifts/shiftQueryService.js

const mongoose = require("mongoose");

const Shift = require("../../models/Shift");
const ShiftOccurrence = require("../../models/ShiftOccurrence");
const ShiftOccurrenceClaim = require("../../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../../models/ShiftOccurrenceDispute");
const Branch = require("../../models/Branch");
const EmployerProfile = require("../../models/EmployerProfile");
const EmployerMember = require("../../models/EmployerMember");

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

/*
 * Parent Shift fields needed by the manage-Shifts page.
 *
 * Parent financial fields remain engagement summaries.
 * Occurrence records below remain authoritative for occurrence-specific
 * settlement, overtime, challenge, refund and attendance state.
 */
const SHIFT_LIST_FIELDS = [
  "referenceCode",
  "branch",
  "roleTitle",
  "professionalType",

  "scheduleMode",
  "occurrenceCount",
  "requiredProfessionals",
  "totalOccurrenceCount",
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
  "standardBasePlatformFeeRate",
  "basePlatformFeeRate",
  "overtimePlatformFeeRate",
  "basePlatformFeeBenefitSource",
  "basePlatformFeeSubscription",
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
  "hiringSummary",
  "assignmentSummary",

  "totalApplications",
  "currentRoundApplications",

  "status",
  "paymentStatus",

  "cancellationCode",
  "cancelledAt",

  "createdAt",
];

/*
 * Occurrence fields needed by the manage-Shifts page.
 *
 * This projection deliberately includes more than the visible table currently
 * renders. ShiftViewService must be able to resolve the employer's real next
 * action from occurrence authority without another database query.
 *
 * This includes:
 *
 * - assignment / replacement;
 * - attendance;
 * - BASE financial outcome;
 * - OT request and approved OT;
 * - outstanding OT top-up;
 * - component settlement;
 * - challenge-window / case state;
 * - refund state and holds;
 * - cancellation outcome; and
 * - selected/relevant occurrence timing.
 */
const SHIFT_CARD_OCCURRENCE_FIELDS = [
  "shift",
  "business",
  "branch",

  "referenceCode",
  "slotNumber",
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
  "standardBasePlatformFeeRate",
  "basePlatformFeeRate",
  "overtimePlatformFeeRate",
  "basePlatformFeeBenefitSource",
  "basePlatformFeeSubscription",

  "estimatedProfessionalPay",
  "estimatedPlatformFee",
  "estimatedEmployerCharge",

  "baseProfessionalPay",
  "basePlatformFee",
  "overtimeProfessionalPay",
  "overtimePlatformFee",

  "baseBillableHours",
  "billableHours",

  "topUpRequired",
  "topUpTransaction",

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

  "cancellationCode",
  "cancelledBy",
  "cancelledByUser",
  "cancellationReason",
  "cancelledAt",
  "cancellationCompensation",
  "activeWorkCancellation",
];

/*
 * Parent fields needed by the full employer Shift-details page.
 *
 * The parent remains the engagement authority.
 * Occurrence-specific financial/lifecycle authority is loaded separately.
 */
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
  "requiredProfessionals",
  "totalOccurrenceCount",
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
  "standardBasePlatformFeeRate",
  "basePlatformFeeRate",
  "overtimePlatformFeeRate",
  "basePlatformFeeBenefitSource",
  "basePlatformFeeSubscription",
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
  "hiringSummary",
  "assignmentSummary",

  "occurrenceProgress",
  "settlementSummary",

  "status",
  "paymentStatus",

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

/*
 * Full occurrence authority needed by the Shift-details page.
 *
 * This is intentionally broader than the manage-page projection because the
 * details page must be able to render the complete selected-occurrence state.
 */
const SHIFT_DETAILS_OCCURRENCE_FIELDS = [
  "shift",
  "business",
  "branch",

  "referenceCode",
  "slotNumber",
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
  "standardBasePlatformFeeRate",
  "basePlatformFeeRate",
  "overtimePlatformFeeRate",
  "basePlatformFeeBenefitSource",
  "basePlatformFeeSubscription",

  "estimatedProfessionalPay",
  "estimatedPlatformFee",
  "estimatedEmployerCharge",

  "baseProfessionalPay",
  "basePlatformFee",

  "overtimeProfessionalPay",
  "overtimePlatformFee",

  "topUpRequired",
  "topUpTransaction",

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

/*
 * Active case projections needed by ShiftViewService.
 *
 * The occurrence remains authoritative for whether a case is active through
 * activeClaim / activeDispute. Population only supplies the case presentation
 * state needed to identify action ownership and show the current case state.
 */
const ACTIVE_CLAIM_FIELDS = [
  "referenceCode",
  "status",
  "submittedAt",
  "employerResponseDeadlineAt",
  "resolvedAt",
  "withdrawnAt",

  "issues._id",
  "issues.type",
  "issues.affectedSettlementComponents",
  "issues.status",

  "issues.employerDecision",
  "issues.employerDecidedAt",

  "issues.escalationReason",
  "issues.escalatedAt",

  "issues.adminDecision",
  "issues.resolvedAt",
];

const ACTIVE_DISPUTE_FIELDS = [
  "referenceCode",
  "status",
  "submittedAt",
  "professionalResponseDeadlineAt",
  "resolvedAt",
  "withdrawnAt",

  "issues._id",
  "issues.type",
  "issues.affectedSettlementComponents",
  "issues.status",
  "issues.professionalRespondedAt",
  "issues.professionalResponseExpiredAt",
  "issues.adminReviewStartedAt",
  "issues.adminDecision",
  "issues.resolvedAt",
];

const ACTIVE_CASE_POPULATES = Object.freeze([
  Object.freeze({
    path: "activeClaim",
    model: ShiftOccurrenceClaim,
    select: ACTIVE_CLAIM_FIELDS.join(" "),
  }),

  Object.freeze({
    path: "activeDispute",
    model: ShiftOccurrenceDispute,
    select: ACTIVE_DISPUTE_FIELDS.join(" "),
  }),
]);

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

  static async getEmployerProfileForUser(userId, employerProfile = null, employerContext = null) {
    const normalizedUserId = normalizeObjectId({
      value: userId,
      fieldName: "user ID",
      createError: createShiftError,
    });

    if (employerProfile?._id) {
      const normalizedEmployerProfileId = normalizeObjectId({
        value: employerProfile._id,
        fieldName: "employer profile ID",
        createError: createShiftError,
      });

      /*
       * A preloaded business profile is a lookup hint, not access authority.
       * Re-read it and verify the authenticated user against the business's
       * owner or active EmployerMember record.
       */
      const profile = await EmployerProfile.findById(normalizedEmployerProfileId).lean();

      if (!profile) {
        throw createShiftError({
          message: "Employer profile not found.",
          code: "EMPLOYER_PROFILE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (profile.user && String(profile.user) === String(normalizedUserId)) {
        return profile;
      }

      const isBusinessAdmin = employerContext?.isBusinessAdmin === true;
      const isBranchManager = employerContext?.isBranchManager === true;
      const isBranchStaff = employerContext?.isBranchStaff === true;

      if (!isBusinessAdmin && !isBranchManager && !isBranchStaff) {
        throw createShiftError({
          message: "You are not authorized for this employer business.",
          code: "EMPLOYER_PROFILE_ACCESS_NOT_ALLOWED",
          statusCode: 403,
        });
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

      const roleMatchesContext = Boolean(
        member &&
        ((isBusinessAdmin && member.role === "admin") ||
          (isBranchManager && member.role === "branch_manager") ||
          (isBranchStaff && member.role === "branch_staff"))
      );

      if (!roleMatchesContext) {
        throw createShiftError({
          message: "You are not authorized for this employer business.",
          code: "EMPLOYER_PROFILE_ACCESS_NOT_ALLOWED",
          statusCode: 403,
        });
      }

      if ((isBranchManager || isBranchStaff) && !isBusinessAdmin) {
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
          throw createShiftError({
            message: "Your employer branch access context is invalid.",
            code: "EMPLOYER_BRANCH_ACCESS_CONTEXT_INVALID",
            statusCode: 403,
          });
        }
      }

      return profile;
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
    return Boolean(
      employerContext?.isPrimaryEmployer === true ||
      employerContext?.isBusinessAdmin === true ||
      employerContext?.isBranchManager === true
    );
  }

  static buildEmployerShiftViewPermissions(employerContext = null) {
    return {
      canViewWallet: employerContext?.canViewWallet === true,

      canFundShifts: employerContext?.canFundShifts === true,

      canPostShifts: employerContext?.canPostShifts === true,

      canManageFinancialObligations: employerContext?.canManageFinancialObligations === true,

      canManageLifecycle: ShiftQueryService.roleCanManageShiftLifecycle(employerContext),

      canManagePostShiftWorkflows: employerContext?.canManagePostShiftWorkflows === true,

      canManageClaims: employerContext?.canManageClaims === true,

      canManageDisputes: employerContext?.canManageDisputes === true,

      canViewRefunds: employerContext?.canViewRefunds === true,

      canManageRefundActions: employerContext?.canManageRefundActions === true,
    };
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

  static applyActiveCasePopulates(query) {
    let populatedQuery = query;

    for (const options of ACTIVE_CASE_POPULATES) {
      populatedQuery = populatedQuery.populate(options);
    }

    return populatedQuery;
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

    ShiftQueryService.assertCanViewShifts(employerContext);

    const profile = await ShiftQueryService.getEmployerProfileForUser(
      userId,
      employerProfile,
      employerContext
    );

    /*
     * canPostShifts governs creation of new Shifts and activation of
     * pending-funding Shifts.
     *
     * It may include delinquency / new-obligation restrictions and therefore
     * must not be reused as general authority for managing an already-active
     * Shift or resolving existing financial obligations.
     */
    const canPostShifts = employerContext?.canPostShifts === true;

    const viewPermissions = ShiftQueryService.buildEmployerShiftViewPermissions(employerContext);

    const canManageAllBranches = ShiftQueryService.canManageAllBranches(employerContext);

    const assignedBranchObjectIds = ShiftQueryService.getAssignedBranchObjectIds(employerContext);

    /*
     * Keep pending-funding expiry synchronized before displaying the list.
     *
     * This is presentation-triggered reconciliation only for accessible
     * pending-funding Shifts. ShiftLifecycleService remains authoritative.
     */
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

    /* ─────────────────────────────── POST SHIFT FORM DATA ─────────────────────────────── */

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

    /* ─────────────────────────────── SHIFT FILTER ─────────────────────────────── */

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

    /*
     * Wallet state is loaded only for users whose resolved employer context
     * permits wallet visibility.
     *
     * Primary employers, business admins and branch managers may view the
     * wallet under the current permission contract. Branch staff remain
     * Shift-read-only and must not cause wallet creation or receive wallet
     * presentation state simply by opening the Shift pages.
     */
    const employerWalletPromise = viewPermissions.canViewWallet
      ? WalletService.createEmployerWalletIfMissing(profile)
      : Promise.resolve(null);

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

      employerWalletPromise,
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredShifts / SHIFTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * SHIFTS_PER_PAGE;

    /* ─────────────────────────────── PAGE SHIFTS ─────────────────────────────── */

    const shifts = await Shift.find(filter)
      .select(SHIFT_LIST_FIELDS.join(" "))
      .populate("branch", "name address state lga geofenceRadiusMeters")
      .sort({
        startTime: -1,
        createdAt: -1,
      })
      .skip(skip)
      .limit(SHIFTS_PER_PAGE)
      .lean();

    const shiftIds = shifts.map((shift) => shift._id);

    /*
     * Load occurrence authority for every Shift on this page in one query.
     *
     * The active case pointers are populated only with the case/issue workflow
     * fields ShiftViewService needs for employer-facing action ownership.
     */
    let occurrenceRows = [];

    if (shiftIds.length > 0) {
      let occurrenceQuery = ShiftOccurrence.find({
        shift: {
          $in: shiftIds,
        },
      }).select(SHIFT_CARD_OCCURRENCE_FIELDS.join(" "));

      occurrenceQuery = ShiftQueryService.applyActiveCasePopulates(occurrenceQuery);

      occurrenceRows = await occurrenceQuery
        .sort({
          shift: 1,
          slotNumber: 1,
          sequenceNumber: 1,
        })
        .lean();
    }

    const occurrencesByShiftId = new Map();

    for (const occurrence of occurrenceRows) {
      const shiftKey = String(occurrence.shift);

      if (!occurrencesByShiftId.has(shiftKey)) {
        occurrencesByShiftId.set(shiftKey, []);
      }

      occurrencesByShiftId.get(shiftKey).push(occurrence);
    }

    /* ─────────────────────────────── FILTER COUNTS ─────────────────────────────── */

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

    /* ─────────────────────────────── SHIFT VIEWS ─────────────────────────────── */

    const shiftViews = shifts.map((shift) => {
      const shiftOccurrences = occurrencesByShiftId.get(String(shift._id)) || [];

      return ShiftViewService.buildEmployerShiftView(
        shift,
        currency,
        normalizedCurrentTime,
        shiftOccurrences,
        employerWallet,
        viewPermissions
      );
    });

    /*
     * These remain parent-status summary cards.
     *
     * Employer-attention state is deliberately separate because occurrence
     * lifecycle authority must not be flattened back into parent Shift status.
     */
    const summaryCards = SHIFT_SUMMARY_CARD_DEFINITIONS.map((card) => {
      const filterTab = filterTabs.find((filterItem) => filterItem.value === card.status);

      return {
        status: card.status,

        label: card.label,

        description: card.description,

        count: filterTab?.count || 0,
      };
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

      fundingModal:
        viewPermissions.canFundShifts && viewPermissions.canPostShifts
          ? ShiftViewService.buildFundingModalView({
              employerWallet,
              currency,
              permissions: viewPermissions,
            })
          : null,

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

        fundShiftModalId:
          viewPermissions.canFundShifts && viewPermissions.canPostShifts ? fundShiftModalId : null,
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

    ShiftQueryService.assertCanViewShifts(employerContext);

    const profile = await ShiftQueryService.getEmployerProfileForUser(
      userId,
      employerProfile,
      employerContext
    );

    const shiftFilter = ShiftQueryService.buildEmployerShiftAccessFilter({
      employerProfileId: profile._id,

      employerContext,

      shiftId,
    });

    /*
     * Perform the lightweight pending-funding expiry check before loading the
     * complete details projection.
     */
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

    /* ─────────────────────────────── PARENT SHIFT ─────────────────────────────── */

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

    /* ─────────────────────────────── REQUESTED OCCURRENCE ─────────────────────────────── */

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

    /*
     * ShiftOccurrence is authoritative for:
     *
     * - assignment;
     * - attendance;
     * - BASE financial outcome;
     * - OT lifecycle and top-up;
     * - challenge/case pointers;
     * - component settlement;
     * - refund lifecycle;
     * - occurrence cancellation; and
     * - attendance PIN eligibility.
     *
     * The populated case records below do not replace occurrence authority.
     * They only supply the issue-level workflow state required for employer
     * presentation and parent-action priority.
     */
    let occurrenceQuery = ShiftOccurrence.find({
      shift: shift._id,

      business: profile._id,

      branch: shift.branch?._id || shift.branch,
    }).select(SHIFT_DETAILS_OCCURRENCE_FIELDS.join(" "));

    occurrenceQuery = ShiftQueryService.applyActiveCasePopulates(occurrenceQuery);

    const occurrences = await occurrenceQuery
      .sort({
        slotNumber: 1,
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

    /* ─────────────────────────────── EMPLOYER PAYMENT CONTEXT ─────────────────────────────── */

    const viewPermissions = ShiftQueryService.buildEmployerShiftViewPermissions(employerContext);

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

    /*
     * Wallet data is presentation context, not Shift-read authority.
     *
     * Branch staff may read assigned-branch Shifts but cannot view the wallet,
     * so their details page deliberately receives no employer wallet record.
     */
    const employerWallet = viewPermissions.canViewWallet
      ? await WalletService.createEmployerWalletIfMissing(profile)
      : null;

    const shiftView = ShiftViewService.buildEmployerShiftDetailsView({
      shift,

      occurrences,

      selectedOccurrenceId,

      employerWallet,

      currency,

      currentTime: normalizedCurrentTime,

      canManageLifecycle: viewPermissions.canManageLifecycle,

      permissions: viewPermissions,
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

      fundingModal:
        viewPermissions.canFundShifts && viewPermissions.canPostShifts
          ? ShiftViewService.buildFundingModalView({
              employerWallet,
              currency,
              permissions: viewPermissions,
            })
          : null,

      actions: {
        manageShiftsUrl: ShiftViewService.getEmployerShiftsUrl(),

        fundShiftModalId:
          viewPermissions.canFundShifts && viewPermissions.canPostShifts
            ? ShiftViewService.getFundShiftModalId()
            : null,
      },
    };
  }
}

module.exports = ShiftQueryService;
