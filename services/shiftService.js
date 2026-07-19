// services/shiftService.js

const crypto = require("crypto");
const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const Branch = require("../models/Branch");
const EmployerProfile = require("../models/EmployerProfile");

const PlatformSettingsService = require("./platformSettingsService");

const money = require("../utils/money");
const { badgeClass, formatStatus } = require("../utils/statusHelper");
const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const POST_SHIFT_MODAL_ID = "postShiftModal";
const SHIFTS_PER_PAGE = 10;
const SHIFT_TIME_ZONE = "Africa/Lagos";
const SHIFT_TIME_ZONE_OFFSET = "+01:00";
const PLATFORM_FEE_RATE_SCALE = 1000000;

const PROFESSIONAL_TYPE_OPTIONS = [
  {
    value: "pharmacist",
    label: "Pharmacist",
  },
  {
    value: "pharmacy_technician",
    label: "Pharmacy Technician",
  },
  {
    value: "nurse",
    label: "Nurse",
  },
  {
    value: "doctor",
    label: "Doctor",
  },
  {
    value: "lab_scientist",
    label: "Laboratory Scientist",
  },
  {
    value: "radiographer",
    label: "Radiographer",
  },
  {
    value: "physiotherapist",
    label: "Physiotherapist",
  },
];

const SHIFT_STATUS_FILTERS = [
  {
    value: "all",
    label: "All Shifts",
  },
  {
    value: "open",
    label: "Open",
  },
  {
    value: "assigned",
    label: "Assigned",
  },
  {
    value: "confirmed",
    label: "Confirmed",
  },
  {
    value: "in_progress",
    label: "In Progress",
  },
  {
    value: "pending_settlement",
    label: "Pending Settlement",
  },
  {
    value: "completed",
    label: "Completed",
  },
  {
    value: "cancelled",
    label: "Cancelled",
  },
  {
    value: "disputed",
    label: "Disputed",
  },
  {
    value: "no_show",
    label: "No-show",
  },
];

class ShiftService {
  /* ─────────────────────────────── ERRORS / BASIC VALIDATION ─────────────────────────────── */

  static createShiftError({ message, code, statusCode = 400 }) {
    const error = new Error(message);

    error.name = "ShiftServiceError";
    error.code = code;
    error.statusCode = statusCode;

    return error;
  }

  static normalizeFieldCode(fieldName) {
    return String(fieldName)
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  static validateObjectId(value, fieldName) {
    if (!mongoose.isValidObjectId(value)) {
      throw ShiftService.createShiftError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${ShiftService.normalizeFieldCode(fieldName)}`,
      });
    }

    return value;
  }

  static async getEmployerProfileForUser(userId, employerProfile = null) {
    if (!userId) {
      throw ShiftService.createShiftError({
        message: "User ID is required.",
        code: "USER_ID_REQUIRED",
      });
    }

    if (employerProfile?._id) {
      return employerProfile;
    }

    const profile = await EmployerProfile.findOne({
      user: userId,
    }).lean();

    if (!profile) {
      throw ShiftService.createShiftError({
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

  static assertBusinessCanPostShifts(profile) {
    if (!profile?._id) {
      throw ShiftService.createShiftError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!ShiftService.businessCanPostShifts(profile)) {
      throw ShiftService.createShiftError({
        message: "The business must be verified and approved before a shift can be posted.",
        code: "BUSINESS_NOT_ELIGIBLE_TO_POST_SHIFT",
        statusCode: 403,
      });
    }

    return profile;
  }

  /* ─────────────────────────────── INPUT NORMALIZATION ─────────────────────────────── */

  static normalizeRequiredText(value, fieldName, maximumLength) {
    const normalizedValue = String(value ?? "").trim();
    const fieldCode = ShiftService.normalizeFieldCode(fieldName);

    if (!normalizedValue) {
      throw ShiftService.createShiftError({
        message: `${fieldName} is required.`,
        code: `MISSING_${fieldCode}`,
      });
    }

    if (normalizedValue.length > maximumLength) {
      throw ShiftService.createShiftError({
        message: `${fieldName} cannot exceed ${maximumLength} characters.`,
        code: `${fieldCode}_TOO_LONG`,
      });
    }

    return normalizedValue;
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    const normalizedValue = String(value ?? "").trim();

    if (!normalizedValue) {
      return undefined;
    }

    if (normalizedValue.length > maximumLength) {
      throw ShiftService.createShiftError({
        message: `${fieldName} cannot exceed ${maximumLength} characters.`,
        code: `${ShiftService.normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return normalizedValue;
  }

  static normalizeProfessionalType(value) {
    const professionalType = String(value || "")
      .trim()
      .toLowerCase();

    const isAllowed = PROFESSIONAL_TYPE_OPTIONS.some((option) => option.value === professionalType);

    if (!isAllowed) {
      throw ShiftService.createShiftError({
        message: "A valid professional type is required.",
        code: "INVALID_PROFESSIONAL_TYPE",
      });
    }

    return professionalType;
  }

  static normalizeRequiredSkills(value) {
    if (value === null || value === undefined || value === "") {
      return [];
    }

    const skillValues = Array.isArray(value) ? value : String(value).split(",");

    const seenSkills = new Set();
    const skills = [];

    for (const skillValue of skillValues) {
      const skill = String(skillValue || "").trim();

      if (!skill) {
        continue;
      }

      if (skill.length > 100) {
        throw ShiftService.createShiftError({
          message: "Each required skill cannot exceed 100 characters.",
          code: "REQUIRED_SKILL_TOO_LONG",
        });
      }

      const comparisonValue = skill.toLowerCase();

      if (!seenSkills.has(comparisonValue)) {
        seenSkills.add(comparisonValue);
        skills.push(skill);
      }
    }

    if (skills.length > 20) {
      throw ShiftService.createShiftError({
        message: "A shift cannot contain more than 20 required skills.",
        code: "TOO_MANY_REQUIRED_SKILLS",
      });
    }

    return skills;
  }

  static parseDate(value, fieldName) {
    const cleanValue = String(value ?? "").trim();
    const fieldCode = ShiftService.normalizeFieldCode(fieldName);

    if (!cleanValue) {
      throw ShiftService.createShiftError({
        message: `${fieldName} is required.`,
        code: `REQUIRED_${fieldCode}`,
      });
    }

    /*
     * HTML datetime-local values do not include a time-zone offset.
     * Offset-less values are interpreted as West Africa Time.
     */
    const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

    const normalizedDateTime = localDateTimePattern.test(cleanValue)
      ? `${cleanValue}${SHIFT_TIME_ZONE_OFFSET}`
      : cleanValue;

    const parsedDate = new Date(normalizedDateTime);

    if (Number.isNaN(parsedDate.getTime())) {
      throw ShiftService.createShiftError({
        message: `${fieldName} must be a valid date and time.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return parsedDate;
  }

  static parseBreakDuration(value) {
    if (value === null || value === undefined || value === "") {
      return 0;
    }

    const breakDuration = Number(value);

    if (!Number.isSafeInteger(breakDuration) || breakDuration < 0) {
      throw ShiftService.createShiftError({
        message: "Break duration must be a non-negative whole number of minutes.",
        code: "INVALID_BREAK_DURATION",
      });
    }

    return breakDuration;
  }

  static normalizeHourlyRateToMinorUnit(value) {
    const cleanValue = String(value ?? "")
      .trim()
      .replace(/,/g, "");

    if (!/^\d+(\.\d{1,2})?$/.test(cleanValue)) {
      throw ShiftService.createShiftError({
        message: "Enter a valid hourly rate.",
        code: "INVALID_HOURLY_RATE",
      });
    }

    const majorUnitAmount = Number(cleanValue);
    const hourlyRate = money.toMinorUnit(majorUnitAmount);

    if (
      !Number.isFinite(majorUnitAmount) ||
      majorUnitAmount <= 0 ||
      !Number.isSafeInteger(hourlyRate) ||
      hourlyRate <= 0
    ) {
      throw ShiftService.createShiftError({
        message: "Hourly rate must be greater than zero.",
        code: "INVALID_HOURLY_RATE",
      });
    }

    return hourlyRate;
  }

  /* ─────────────────────────────── TIME / PRICING ─────────────────────────────── */

  static calculateScheduledTime(startTime, endTime) {
    const durationMilliseconds = endTime.getTime() - startTime.getTime();
    const minuteInMilliseconds = 60 * 1000;

    if (durationMilliseconds <= 0) {
      throw ShiftService.createShiftError({
        message: "Shift end time must be later than start time.",
        code: "INVALID_SHIFT_TIME_RANGE",
      });
    }

    if (durationMilliseconds % minuteInMilliseconds !== 0) {
      throw ShiftService.createShiftError({
        message: "Shift duration must be specified in whole minutes.",
        code: "INVALID_SHIFT_DURATION",
      });
    }

    const scheduledMinutes = durationMilliseconds / minuteInMilliseconds;

    if (!Number.isSafeInteger(scheduledMinutes) || scheduledMinutes <= 0) {
      throw ShiftService.createShiftError({
        message: "The calculated shift duration is invalid.",
        code: "INVALID_SHIFT_DURATION",
      });
    }

    return {
      scheduledMinutes,
      scheduledHours: Number((scheduledMinutes / 60).toFixed(4)),
    };
  }

  static divideAndRound(numerator, denominator) {
    const bigNumerator = BigInt(numerator);
    const bigDenominator = BigInt(denominator);

    if (bigDenominator <= 0n) {
      throw ShiftService.createShiftError({
        message: "The pricing denominator is invalid.",
        code: "INVALID_PRICING_DENOMINATOR",
        statusCode: 500,
      });
    }

    const result = Number((bigNumerator + bigDenominator / 2n) / bigDenominator);

    if (!Number.isSafeInteger(result)) {
      throw ShiftService.createShiftError({
        message: "The calculated monetary amount is too large.",
        code: "CALCULATED_AMOUNT_TOO_LARGE",
        statusCode: 500,
      });
    }

    return result;
  }

  static calculateShiftPricing({ hourlyRate, scheduledMinutes, platformFeeRate }) {
    if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) {
      throw ShiftService.createShiftError({
        message: "Hourly rate must be a positive whole number in minor units.",
        code: "INVALID_HOURLY_RATE",
      });
    }

    if (!Number.isSafeInteger(scheduledMinutes) || scheduledMinutes <= 0) {
      throw ShiftService.createShiftError({
        message: "Scheduled minutes must be greater than zero.",
        code: "INVALID_SCHEDULED_MINUTES",
      });
    }

    if (
      typeof platformFeeRate !== "number" ||
      !Number.isFinite(platformFeeRate) ||
      platformFeeRate < 0 ||
      platformFeeRate > 1
    ) {
      throw ShiftService.createShiftError({
        message: "The platform fee rate is invalid.",
        code: "INVALID_PLATFORM_FEE_RATE",
        statusCode: 500,
      });
    }

    /*
     * Monetary calculations use scheduled minutes rather than the
     * decimal scheduledHours display value.
     */
    const estimatedProfessionalPay = ShiftService.divideAndRound(
      BigInt(hourlyRate) * BigInt(scheduledMinutes),
      60
    );

    const scaledFeeRate = Math.round(platformFeeRate * PLATFORM_FEE_RATE_SCALE);

    const estimatedPlatformFee = ShiftService.divideAndRound(
      BigInt(estimatedProfessionalPay) * BigInt(scaledFeeRate),
      PLATFORM_FEE_RATE_SCALE
    );

    const estimatedEmployerCharge = estimatedProfessionalPay + estimatedPlatformFee;

    if (!Number.isSafeInteger(estimatedEmployerCharge)) {
      throw ShiftService.createShiftError({
        message: "The calculated employer charge is too large.",
        code: "CALCULATED_AMOUNT_TOO_LARGE",
        statusCode: 500,
      });
    }

    return {
      estimatedProfessionalPay,
      estimatedPlatformFee,
      estimatedEmployerCharge,
    };
  }

  /* ─────────────────────────────── IDENTITY / ATTENDANCE PINS ─────────────────────────────── */

  static generateAttendancePin() {
    return crypto.randomInt(0, 1000000).toString().padStart(6, "0");
  }

  static generateAttendancePins() {
    const checkInPin = ShiftService.generateAttendancePin();

    let checkOutPin = ShiftService.generateAttendancePin();

    while (checkOutPin === checkInPin) {
      checkOutPin = ShiftService.generateAttendancePin();
    }

    return {
      checkInPin,
      checkOutPin,
    };
  }

  static createShiftIdentity() {
    const shiftId = new mongoose.Types.ObjectId();

    return {
      shiftId,
      referenceCode: `LQM-${shiftId.toString().slice(-12).toUpperCase()}`,
    };
  }

  /* ─────────────────────────────── BRANCHES ─────────────────────────────── */

  static hasValidBranchLocation(branch) {
    const coordinates = branch?.location?.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length !== 2) {
      return false;
    }

    const [longitude, latitude] = coordinates;

    return (
      Number.isFinite(longitude) &&
      Number.isFinite(latitude) &&
      longitude >= -180 &&
      longitude <= 180 &&
      latitude >= -90 &&
      latitude <= 90
    );
  }

  static async getActiveBranches({
    employerProfileId,
    canManageAllBranches = false,
    assignedBranchIds = [],
  }) {
    ShiftService.validateObjectId(employerProfileId, "employer profile ID");

    const filter = {
      business: employerProfileId,
      isActive: true,
    };

    if (!canManageAllBranches) {
      filter._id = {
        $in: assignedBranchIds,
      };
    }

    return Branch.find(filter)
      .select(["name", "address", "state", "lga", "location", "geofenceRadiusMeters"].join(" "))
      .sort({
        name: 1,
      })
      .lean();
  }

  static async getActiveBranch({
    branchId,
    employerProfileId,
    canManageAllBranches = false,
    assignedBranchIds = [],
  }) {
    ShiftService.validateObjectId(branchId, "branch ID");

    ShiftService.validateObjectId(employerProfileId, "employer profile ID");

    if (!canManageAllBranches) {
      const isAssignedBranch = assignedBranchIds.some(
        (assignedBranchId) => String(assignedBranchId) === String(branchId)
      );

      if (!isAssignedBranch) {
        throw ShiftService.createShiftError({
          message: "You do not have permission to post shifts for the selected branch.",
          code: "BRANCH_SHIFT_POSTING_NOT_ALLOWED",
          statusCode: 403,
        });
      }
    }

    const branch = await Branch.findOne({
      _id: branchId,
      business: employerProfileId,
      isActive: true,
    })
      .select(["name", "address", "state", "lga", "location", "geofenceRadiusMeters"].join(" "))
      .lean();

    if (!branch) {
      throw ShiftService.createShiftError({
        message: "The selected branch was not found or is not active.",
        code: "ACTIVE_BRANCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!ShiftService.hasValidBranchLocation(branch)) {
      throw ShiftService.createShiftError({
        message: "The selected branch must have a valid location before a shift can be posted.",
        code: "BRANCH_LOCATION_REQUIRED",
      });
    }

    return branch;
  }

  /* ─────────────────────────────── DISPLAY HELPERS ─────────────────────────────── */

  static formatAmount(amount, currency = "NGN") {
    return money.formatMoney(amount ?? 0, currency);
  }

  static formatDate(date) {
    if (!date) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      dateStyle: "medium",
      timeZone: SHIFT_TIME_ZONE,
    }).format(new Date(date));
  }

  static formatTime(date) {
    if (!date) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      timeStyle: "short",
      timeZone: SHIFT_TIME_ZONE,
    }).format(new Date(date));
  }

  static formatScheduledHours(value) {
    const hours = Number(value);

    if (!Number.isFinite(hours)) {
      return "-";
    }

    const displayHours = Number(hours.toFixed(2));

    return `${displayHours} ${displayHours === 1 ? "hour" : "hours"}`;
  }

  static formatBreakDuration(value) {
    const minutes = Number(value || 0);

    if (!Number.isFinite(minutes) || minutes <= 0) {
      return "No declared break";
    }

    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  static buildBranchOption(branch) {
    const hasValidLocation = ShiftService.hasValidBranchLocation(branch);

    return {
      value: String(branch._id),
      name: branch.name,

      locationLabel: [branch.address, branch.lga, branch.state].filter(Boolean).join(", "),

      hasValidLocation,
      isSelectable: hasValidLocation,

      disabledReason: hasValidLocation
        ? null
        : "Add a valid branch location before posting a shift here.",
    };
  }

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

    return queryString ? `${EMPLOYER_SHIFTS_URL}?${queryString}` : EMPLOYER_SHIFTS_URL;
  }

  static buildPaginationPages({ currentPage, totalPages, status }) {
    if (totalPages <= 1) {
      return [];
    }

    const maxVisiblePages = 5;

    let startPage = Math.max(currentPage - 2, 1);
    let endPage = Math.min(startPage + maxVisiblePages - 1, totalPages);

    startPage = Math.max(endPage - maxVisiblePages + 1, 1);

    const pages = [];

    for (let page = startPage; page <= endPage; page += 1) {
      pages.push({
        page,
        isActive: page === currentPage,

        url: ShiftService.buildEmployerShiftsUrl({
          status,
          page,
        }),
      });
    }

    return pages;
  }

  static buildEmployerShiftView(shift, currency, currentTime = new Date()) {
    /*
     * These flags are display hints only.
     * PIN retrieval methods still perform authoritative checks.
     */
    const canRevealCheckInPin =
      Boolean(shift.assignedProfessional) &&
      shift.status === "confirmed" &&
      shift.paymentStatus === "funded" &&
      Boolean(shift.checkInPinVisibleFrom) &&
      currentTime >= new Date(shift.checkInPinVisibleFrom) &&
      !shift.checkInPinUsedAt;

    const canRevealCheckOutPin =
      Boolean(shift.assignedProfessional) &&
      shift.status === "in_progress" &&
      shift.attendanceStatus === "checked_in" &&
      Boolean(shift.checkedInAt) &&
      !shift.checkOutPinUsedAt;

    const professionalTypeLabel =
      PROFESSIONAL_TYPE_OPTIONS.find((option) => option.value === shift.professionalType)?.label ||
      formatStatus(shift.professionalType);

    return {
      id: String(shift._id),
      referenceCode: shift.referenceCode,

      branch: shift.branch
        ? {
            id: String(shift.branch._id),
            name: shift.branch.name,
            address: shift.branch.address || null,
            state: shift.branch.state || null,
            lga: shift.branch.lga || null,
          }
        : null,

      roleTitle: shift.roleTitle,

      professionalType: shift.professionalType,
      professionalTypeLabel,

      status: shift.status,
      statusLabel: formatStatus(shift.status),
      statusBadgeClass: badgeClass[shift.status] || "badge-light-secondary",

      paymentStatus: shift.paymentStatus,
      paymentStatusLabel: formatStatus(shift.paymentStatus),
      paymentStatusBadgeClass: badgeClass[shift.paymentStatus] || "badge-light-secondary",

      attendanceStatus: shift.attendanceStatus,
      attendanceStatusLabel: formatStatus(shift.attendanceStatus),

      startTime: shift.startTime,
      endTime: shift.endTime,

      startDateDisplay: ShiftService.formatDate(shift.startTime),
      startTimeDisplay: ShiftService.formatTime(shift.startTime),
      endTimeDisplay: ShiftService.formatTime(shift.endTime),

      scheduledHours: shift.scheduledHours,
      scheduledHoursDisplay: ShiftService.formatScheduledHours(shift.scheduledHours),

      breakDuration: shift.breakDuration || 0,
      breakDurationDisplay: ShiftService.formatBreakDuration(shift.breakDuration),

      hourlyRate: shift.hourlyRate,
      hourlyRateDisplay: ShiftService.formatAmount(shift.hourlyRate, currency),

      estimatedProfessionalPay: shift.estimatedProfessionalPay,
      estimatedProfessionalPayDisplay: ShiftService.formatAmount(
        shift.estimatedProfessionalPay,
        currency
      ),

      estimatedPlatformFee: shift.estimatedPlatformFee,
      estimatedPlatformFeeDisplay: ShiftService.formatAmount(shift.estimatedPlatformFee, currency),

      estimatedEmployerCharge: shift.estimatedEmployerCharge,
      estimatedEmployerChargeDisplay: ShiftService.formatAmount(
        shift.estimatedEmployerCharge,
        currency
      ),

      totalApplications: shift.totalApplications || 0,
      isAssigned: Boolean(shift.assignedProfessional),

      canRevealCheckInPin,
      canRevealCheckOutPin,

      checkInPinUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}/check-in-pin`,

      checkOutPinUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}/check-out-pin`,
    };
  }

  /* ─────────────────────────────── MANAGE SHIFTS PAGE DATA ─────────────────────────────── */

  static async getEmployerShiftsPageData({
    userId,
    employerProfile = null,
    employerContext = null,
    status = "all",
    page = 1,
  }) {
    const profile = await ShiftService.getEmployerProfileForUser(userId, employerProfile);

    const canViewShifts = employerContext?.canViewShifts === true;

    const canPostShifts = employerContext?.canPostShifts === true;

    if (!canViewShifts) {
      throw ShiftService.createShiftError({
        message: "You do not have permission to view shifts.",
        code: "SHIFT_VIEW_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const assignedBranchIds = (employerContext?.assignedBranchIds || []).filter((branchId) =>
      mongoose.isValidObjectId(branchId)
    );

    const assignedBranchObjectIds = assignedBranchIds.map(
      (branchId) => new mongoose.Types.ObjectId(String(branchId))
    );

    const selectedStatus = ShiftService.normalizeShiftStatusFilter(status);

    const requestedPage = ShiftService.normalizePageNumber(page);

    const currency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    if (!currency) {
      throw ShiftService.createShiftError({
        message: "The employer currency could not be resolved.",
        code: "EMPLOYER_CURRENCY_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    const businessCanPostShifts = ShiftService.businessCanPostShifts(profile);

    const canOpenPostShiftModal = Boolean(canPostShifts && businessCanPostShifts);

    let branchOptions = [];
    let pricingView = null;

    if (canOpenPostShiftModal) {
      const [branches, shiftPostingSettings] = await Promise.all([
        ShiftService.getActiveBranches({
          employerProfileId: profile._id,
          canManageAllBranches,
          assignedBranchIds,
        }),

        PlatformSettingsService.getShiftPostingSettings(profile.countryCode),
      ]);

      const { pricing } = shiftPostingSettings;

      const platformCurrency = String(pricing.currency || "")
        .trim()
        .toUpperCase();

      if (!platformCurrency) {
        throw ShiftService.createShiftError({
          message: "The active platform currency could not be resolved.",
          code: "PLATFORM_CURRENCY_NOT_RESOLVED",
          statusCode: 500,
        });
      }

      if (currency !== platformCurrency) {
        throw ShiftService.createShiftError({
          message: "The employer currency does not match the active platform currency.",
          code: "EMPLOYER_CURRENCY_MISMATCH",
          statusCode: 500,
        });
      }

      branchOptions = branches.map((branch) => ShiftService.buildBranchOption(branch));

      pricingView = {
        countryCode: pricing.countryCode,
        currency: platformCurrency,
        platformFeeRate: pricing.platformFeeRate,

        platformFeePercent: Number((pricing.platformFeeRate * 100).toFixed(2)),

        platformFeeLabel: `${(pricing.platformFeeRate * 100).toFixed(2)}%`,
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

    const [totalFilteredShifts, statusCountResults] = await Promise.all([
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
    ]);

    const totalPages = Math.max(Math.ceil(totalFilteredShifts / SHIFTS_PER_PAGE), 1);

    const currentPage = Math.min(requestedPage, totalPages);

    const skip = (currentPage - 1) * SHIFTS_PER_PAGE;

    const shifts = await Shift.find(filter)
      .select(
        [
          "referenceCode",
          "branch",
          "roleTitle",
          "professionalType",
          "startTime",
          "endTime",
          "scheduledHours",
          "breakDuration",
          "hourlyRate",
          "estimatedProfessionalPay",
          "estimatedPlatformFee",
          "estimatedEmployerCharge",
          "totalApplications",
          "status",
          "paymentStatus",
          "attendanceStatus",
          "assignedProfessional",
          "checkInPinVisibleFrom",
          "checkInPinUsedAt",
          "checkOutPinUsedAt",
          "checkedInAt",
          "createdAt",
        ].join(" ")
      )
      .populate("branch", "name address state lga")
      .sort({
        startTime: -1,
        createdAt: -1,
      })
      .skip(skip)
      .limit(SHIFTS_PER_PAGE)
      .lean();

    const statusCounts = Object.fromEntries(
      SHIFT_STATUS_FILTERS.filter((item) => item.value !== "all").map((item) => [item.value, 0])
    );

    for (const result of statusCountResults) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, result._id)) {
        statusCounts[result._id] = result.count;
      }
    }

    const totalAllShifts = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);

    const selectedFilter = SHIFT_STATUS_FILTERS.find((item) => item.value === selectedStatus);

    const filterTabs = SHIFT_STATUS_FILTERS.map((item) => ({
      value: item.value,
      label: item.label,

      count: item.value === "all" ? totalAllShifts : statusCounts[item.value] || 0,

      url: ShiftService.buildEmployerShiftsUrl({
        status: item.value,
      }),

      isActive: item.value === selectedStatus,
    }));

    const summaryCardDefinitions = [
      {
        status: "all",
        label: "All Shifts",
        description: "Total shifts posted",
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

    const summaryCards = summaryCardDefinitions.map((card) => {
      const filterTab = filterTabs.find((filter) => filter.value === card.status);

      return {
        status: card.status,
        label: card.label,
        description: card.description,
        borderClass: card.borderClass,
        textClass: card.textClass,

        count: filterTab?.count || 0,
        url: filterTab?.url || EMPLOYER_SHIFTS_URL,
        isActive: filterTab?.isActive || false,
      };
    });

    const currentTime = new Date();

    const shiftViews = shifts.map((shift) =>
      ShiftService.buildEmployerShiftView(shift, currency, currentTime)
    );

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
          ? "You do not have permission to post shifts."
          : !businessCanPostShifts
            ? "The business must be verified and approved before shifts can be posted."
            : null,

        branchOptions,

        hasBranches: branchOptions.length > 0,

        hasSelectableBranches: branchOptions.some((branch) => branch.isSelectable),

        professionalTypeOptions: PROFESSIONAL_TYPE_OPTIONS,

        timeZone: SHIFT_TIME_ZONE,

        pricing: pricingView,

        modalId: POST_SHIFT_MODAL_ID,
        createShiftUrl: EMPLOYER_SHIFTS_URL,
      },

      emptyState: {
        message:
          selectedStatus === "all"
            ? "No shifts have been posted yet."
            : `There are no ${(selectedFilter?.label || selectedStatus).toLowerCase()} shifts.`,

        canPostShift: canOpenPostShiftModal,
        postShiftModalId: POST_SHIFT_MODAL_ID,
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
            ? ShiftService.buildEmployerShiftsUrl({
                status: selectedStatus,
                page: currentPage - 1,
              })
            : null,

        nextPageUrl:
          currentPage < totalPages
            ? ShiftService.buildEmployerShiftsUrl({
                status: selectedStatus,
                page: currentPage + 1,
              })
            : null,

        pages: ShiftService.buildPaginationPages({
          currentPage,
          totalPages,
          status: selectedStatus,
        }),

        hasPagination: totalPages > 1,
      },

      actions: {
        manageShiftsUrl: EMPLOYER_SHIFTS_URL,
        createShiftUrl: EMPLOYER_SHIFTS_URL,
        postShiftModalId: POST_SHIFT_MODAL_ID,
      },
    };
  }

  /* ─────────────────────────────── PIN ACCESS ─────────────────────────────── */

  static sanitizeCreatedShift(shift) {
    const shiftObject = shift.toObject();

    delete shiftObject.checkInPin;
    delete shiftObject.checkOutPin;

    return shiftObject;
  }

  static async getEmployerShiftForPinAccess({
    shiftId,
    employerProfileId,
    employerContext = null,
    selectedFields,
  }) {
    ShiftService.validateObjectId(shiftId, "shift ID");

    ShiftService.validateObjectId(employerProfileId, "employer profile ID");

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    if (!canManageAllBranches && !isBranchManager) {
      throw ShiftService.createShiftError({
        message: "You do not have permission to access attendance PINs.",
        code: "ATTENDANCE_PIN_ACCESS_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    const assignedBranchIds = (employerContext?.assignedBranchIds || []).filter((branchId) =>
      mongoose.isValidObjectId(branchId)
    );

    const filter = {
      _id: shiftId,
      business: employerProfileId,
    };

    if (!canManageAllBranches) {
      filter.branch = {
        $in: assignedBranchIds,
      };
    }

    const shift = await Shift.findOne(filter).select(selectedFields);

    if (!shift) {
      throw ShiftService.createShiftError({
        message: "Shift was not found or is not available to you.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getEmployerCheckInPin({ shiftId, employerProfileId, employerContext = null }) {
    const shift = await ShiftService.getEmployerShiftForPinAccess({
      shiftId,
      employerProfileId,
      employerContext,

      selectedFields: [
        "+checkInPin",
        "checkInPinVisibleFrom",
        "checkInPinUsedAt",
        "assignedProfessional",
        "paymentStatus",
        "status",
        "startTime",
      ].join(" "),
    });

    if (!shift.assignedProfessional) {
      throw ShiftService.createShiftError({
        message: "The check-in PIN is not available until a professional has been assigned.",
        code: "CHECK_IN_PIN_PROFESSIONAL_NOT_ASSIGNED",
        statusCode: 403,
      });
    }

    if (shift.status !== "confirmed" || shift.paymentStatus !== "funded") {
      throw ShiftService.createShiftError({
        message: "The check-in PIN is available only for a funded and confirmed shift.",
        code: "CHECK_IN_PIN_SHIFT_NOT_CONFIRMED",
        statusCode: 403,
      });
    }

    if (shift.checkInPinUsedAt) {
      throw ShiftService.createShiftError({
        message: "The check-in PIN has already been used.",
        code: "CHECK_IN_PIN_ALREADY_USED",
        statusCode: 403,
      });
    }

    if (!shift.checkInPinVisibleFrom || new Date() < shift.checkInPinVisibleFrom) {
      throw ShiftService.createShiftError({
        message: "The check-in PIN is not available yet.",
        code: "CHECK_IN_PIN_NOT_AVAILABLE",
        statusCode: 403,
      });
    }

    logger.info(`Check-in PIN revealed for shift ${shift._id} to employer ${employerProfileId}`);

    return {
      shiftId: String(shift._id),
      type: "check_in",
      pin: shift.checkInPin,
      visibleFrom: shift.checkInPinVisibleFrom,
      shiftStartTime: shift.startTime,
    };
  }

  static async getEmployerCheckOutPin({ shiftId, employerProfileId, employerContext = null }) {
    const shift = await ShiftService.getEmployerShiftForPinAccess({
      shiftId,
      employerProfileId,
      employerContext,

      selectedFields: [
        "+checkOutPin",
        "checkOutPinUsedAt",
        "assignedProfessional",
        "attendanceStatus",
        "checkedInAt",
        "status",
        "endTime",
      ].join(" "),
    });

    if (!shift.assignedProfessional) {
      throw ShiftService.createShiftError({
        message: "The check-out PIN is not available because no professional is assigned.",
        code: "CHECK_OUT_PIN_PROFESSIONAL_NOT_ASSIGNED",
        statusCode: 403,
      });
    }

    if (
      shift.status !== "in_progress" ||
      shift.attendanceStatus !== "checked_in" ||
      !shift.checkedInAt
    ) {
      throw ShiftService.createShiftError({
        message: "The check-out PIN becomes available after successful check-in.",
        code: "CHECK_OUT_PIN_NOT_AVAILABLE",
        statusCode: 403,
      });
    }

    if (shift.checkOutPinUsedAt) {
      throw ShiftService.createShiftError({
        message: "The check-out PIN has already been used.",
        code: "CHECK_OUT_PIN_ALREADY_USED",
        statusCode: 403,
      });
    }

    logger.info(`Check-out PIN revealed for shift ${shift._id} to employer ${employerProfileId}`);

    return {
      shiftId: String(shift._id),
      type: "check_out",
      pin: shift.checkOutPin,
      checkedInAt: shift.checkedInAt,
      shiftEndTime: shift.endTime,
    };
  }

  /* ─────────────────────────────── CREATE SHIFT ─────────────────────────────── */

  static async createShift({ userId, employerProfile = null, employerContext = null, shiftData }) {
    if (!shiftData || typeof shiftData !== "object") {
      throw ShiftService.createShiftError({
        message: "Shift details are required.",
        code: "SHIFT_DATA_REQUIRED",
      });
    }

    ShiftService.validateObjectId(userId, "user ID");

    const profile = await ShiftService.getEmployerProfileForUser(userId, employerProfile);

    const canPostShifts = employerContext?.canPostShifts === true;

    if (!canPostShifts) {
      throw ShiftService.createShiftError({
        message: "You do not have permission to post shifts.",
        code: "SHIFT_POSTING_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const assignedBranchIds = (employerContext?.assignedBranchIds || []).filter((branchId) =>
      mongoose.isValidObjectId(branchId)
    );

    ShiftService.assertBusinessCanPostShifts(profile);

    const branch = await ShiftService.getActiveBranch({
      branchId: shiftData.branchId,
      employerProfileId: profile._id,
      canManageAllBranches,
      assignedBranchIds,
    });

    const { pricing, attendance } = await PlatformSettingsService.getShiftPostingSettings(
      profile.countryCode
    );

    const employerCurrency = String(profile.currency || "")
      .trim()
      .toUpperCase();

    const platformCurrency = String(pricing.currency || "")
      .trim()
      .toUpperCase();

    if (!employerCurrency || !platformCurrency) {
      throw ShiftService.createShiftError({
        message: "A valid shift currency could not be resolved.",
        code: "SHIFT_CURRENCY_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    if (employerCurrency !== platformCurrency) {
      throw ShiftService.createShiftError({
        message: "The employer currency does not match the active platform currency.",
        code: "EMPLOYER_CURRENCY_MISMATCH",
        statusCode: 500,
      });
    }

    const startTime = ShiftService.parseDate(shiftData.startTime, "startTime");

    const endTime = ShiftService.parseDate(shiftData.endTime, "endTime");

    if (startTime <= new Date()) {
      throw ShiftService.createShiftError({
        message: "Shift start time must be in the future.",
        code: "SHIFT_START_TIME_NOT_IN_FUTURE",
      });
    }

    const { scheduledMinutes, scheduledHours } = ShiftService.calculateScheduledTime(
      startTime,
      endTime
    );

    const breakDuration = ShiftService.parseBreakDuration(shiftData.breakDuration);

    if (breakDuration >= scheduledMinutes && scheduledMinutes > 0) {
      throw ShiftService.createShiftError({
        message: "Break duration must be shorter than the shift duration.",
        code: "BREAK_DURATION_EXCEEDS_SHIFT",
      });
    }

    const hourlyRate = ShiftService.normalizeHourlyRateToMinorUnit(shiftData.hourlyRate);

    const { estimatedProfessionalPay, estimatedPlatformFee, estimatedEmployerCharge } =
      ShiftService.calculateShiftPricing({
        hourlyRate,
        scheduledMinutes,
        platformFeeRate: pricing.platformFeeRate,
      });

    const roleTitle = ShiftService.normalizeRequiredText(shiftData.roleTitle, "roleTitle", 120);

    const professionalType = ShiftService.normalizeProfessionalType(shiftData.professionalType);

    const department = ShiftService.normalizeOptionalText(shiftData.department, "department", 120);

    const requiredSkills = ShiftService.normalizeRequiredSkills(shiftData.requiredSkills);

    const dressCode = ShiftService.normalizeOptionalText(shiftData.dressCode, "dressCode", 300);

    const description = ShiftService.normalizeOptionalText(
      shiftData.description,
      "description",
      500
    );

    const { checkInPin, checkOutPin } = ShiftService.generateAttendancePins();

    const { shiftId, referenceCode } = ShiftService.createShiftIdentity();

    const pricingLockedAt = new Date();

    const checkInPinVisibleFrom = new Date(
      startTime.getTime() - attendance.checkInPinRevealBeforeMinutes * 60 * 1000
    );

    const shift = new Shift({
      _id: shiftId,
      referenceCode,

      business: profile._id,
      branch: branch._id,
      postedBy: userId,

      department,
      roleTitle,
      professionalType,

      startTime,
      endTime,
      scheduledHours,
      breakDuration,

      hourlyRate,
      platformFeeRate: pricing.platformFeeRate,

      pricingLockedAt,
      pricingLockedBy: userId,

      estimatedProfessionalPay,
      estimatedPlatformFee,
      estimatedEmployerCharge,

      checkInPin,
      checkOutPin,
      checkInPinVisibleFrom,
      attendancePinsGeneratedAt: pricingLockedAt,

      status: "open",
      paymentStatus: "unpaid",

      requiredSkills,
      dressCode,
      description,
    });

    await shift.save();

    /*
     * These are denormalized summary fields.
     * Failure to update them must not make a successful shift creation fail.
     */
    try {
      await EmployerProfile.updateOne(
        {
          _id: profile._id,
        },
        {
          $inc: {
            totalShiftsPosted: 1,
          },
          $set: {
            lastShiftPostedAt: pricingLockedAt,
          },
        }
      );
    } catch (counterError) {
      logger.error(
        `Shift ${referenceCode} was created but employer shift counters could not be updated:`,
        counterError
      );
    }

    logger.info(`Shift ${referenceCode} created by user ${userId} for employer ${profile._id}`);

    return {
      shift: ShiftService.sanitizeCreatedShift(shift),

      pricing: {
        countryCode: pricing.countryCode,
        currency: platformCurrency,

        scheduledMinutes,
        scheduledHours,

        hourlyRate,

        hourlyRateDisplay: ShiftService.formatAmount(hourlyRate, platformCurrency),

        platformFeeRate: pricing.platformFeeRate,

        platformFeePercent: Number((pricing.platformFeeRate * 100).toFixed(2)),

        estimatedProfessionalPay,

        estimatedProfessionalPayDisplay: ShiftService.formatAmount(
          estimatedProfessionalPay,
          platformCurrency
        ),

        estimatedPlatformFee,

        estimatedPlatformFeeDisplay: ShiftService.formatAmount(
          estimatedPlatformFee,
          platformCurrency
        ),

        estimatedEmployerCharge,

        estimatedEmployerChargeDisplay: ShiftService.formatAmount(
          estimatedEmployerCharge,
          platformCurrency
        ),
      },
    };
  }
}

module.exports = ShiftService;
