// services/shiftApplicationService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftApplication = require("../models/ShiftApplication");
const ShiftAssignment = require("../models/ShiftAssignment");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const ShiftAssignmentService = require("./shiftAssignmentService");
const EmployerDelinquencyService = require("./employerDelinquencyService");

const {
  MAX_APPLICATION_ROUNDS,
  APPLICATION_STATUSES,
  ACTIVE_APPLICATION_STATUSES,
  INITIAL_APPLICATION_PAYMENT_STATUS,
  REPLACEMENT_APPLICATION_PARENT_STATUSES,
  REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES,
  ACTIVE_SINGLE_SHIFT_STATUSES,
  ACTIVE_OCCURRENCE_STATUSES,
  PROFESSIONAL_UNAVAILABLE_STATUSES,
  REPLACEMENT_HIRING_STATUSES,
  MAX_APPLICATION_NOTE_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  OTHER_APPLICANT_SELECTED_REASON,
} = require("../constants/shiftApplication");

const { REPLACEABLE_ASSIGNMENT_STATUSES } = require("../constants/shiftAssignment");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const {
  normalizeFieldCode,
  normalizeObjectId,
  normalizeOptionalText,
} = require("./helpers/serviceValidationHelpers");

const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const logger = require("../utils/logger");

const SHIFT_APPLICATION_SERVICE_ERROR_NAME = "ShiftApplicationServiceError";

class ShiftApplicationService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: SHIFT_APPLICATION_SERVICE_ERROR_NAME,

      message,

      code,

      statusCode,

      details,
    });
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    return runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeFieldCode(value) {
    return normalizeFieldCode(value);
  }

  static normalizeObjectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,

      fieldName,

      required,

      createError: ShiftApplicationService.createError,
    });
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    return normalizeOptionalText({
      value,

      fieldName,

      maximumLength,

      createError: ShiftApplicationService.createError,

      emptyValue: null,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw ShiftApplicationService.createError({
        message: "Current time is invalid.",

        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeStatus(value) {
    const status = String(value || "")
      .trim()
      .toLowerCase();

    if (!APPLICATION_STATUSES.includes(status)) {
      throw ShiftApplicationService.createError({
        message: "Shift application status is invalid.",

        code: "INVALID_SHIFT_APPLICATION_STATUS",
      });
    }

    return status;
  }

  /* ─────────────────────────────── EMPLOYER AUTHORIZATION ─────────────────────────────── */

  static buildEmployerShiftFilter({ shiftId, employerProfileId, employerContext = null }) {
    const normalizedShiftId = ShiftApplicationService.normalizeObjectId(shiftId, "shift ID");

    const normalizedEmployerProfileId = ShiftApplicationService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const canManageAllBranches =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const isBranchManager = employerContext?.isBranchManager === true;

    if (!canManageAllBranches && !isBranchManager) {
      throw ShiftApplicationService.createError({
        message: "You do not have permission to manage shift applications.",

        code: "SHIFT_APPLICATION_MANAGEMENT_NOT_ALLOWED",

        statusCode: 403,
      });
    }

    const filter = {
      _id: normalizedShiftId,

      business: normalizedEmployerProfileId,
    };

    if (!canManageAllBranches) {
      const assignedBranchIds = (employerContext?.assignedBranchIds || [])
        .filter((branchId) => mongoose.isValidObjectId(branchId))
        .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));

      filter.branch = {
        $in: assignedBranchIds,
      };
    }

    return filter;
  }

  static async assertBusinessCanCreateAssignment({ businessId, currentTime, session = null }) {
    try {
      return await EmployerDelinquencyService.assertCanCreateNewObligation(
        {
          businessId,

          currentTime,
        },
        {
          session,
        }
      );
    } catch (error) {
      if (error?.name !== "EmployerDelinquencyServiceError") {
        throw error;
      }

      throw ShiftApplicationService.createError({
        message: error.message,

        code: error.code || "EMPLOYER_NEW_OBLIGATIONS_RESTRICTED",

        statusCode: error.statusCode || 403,

        details: error.details && typeof error.details === "object" ? error.details : null,
      });
    }
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static getShiftFields() {
    return [
      "referenceCode",
      "business",
      "branch",
      "professionalType",
      "scheduleMode",
      "occurrenceCount",
      "startTime",
      "endTime",
      "status",
      "paymentStatus",
      "activeAssignment",
      "assignedProfessional",
      "applicationRound",
      "replacementHiring",
      "occurrenceProgress",
      "totalApplications",
      "currentRoundApplications",
    ].join(" ");
  }

  static async getShift(shiftId, session = null) {
    const query = Shift.findById(
      ShiftApplicationService.normalizeObjectId(shiftId, "shift ID")
    ).select(ShiftApplicationService.getShiftFields());

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftApplicationService.createError({
        message: "Shift was not found.",

        code: "SHIFT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return shift;
  }

  static async getEmployerShift({
    shiftId,
    employerProfileId,
    employerContext = null,
    session = null,
  }) {
    const query = Shift.findOne(
      ShiftApplicationService.buildEmployerShiftFilter({
        shiftId,

        employerProfileId,

        employerContext,
      })
    ).select(ShiftApplicationService.getShiftFields());

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftApplicationService.createError({
        message: "Shift was not found or is not available to you.",

        code: "SHIFT_NOT_FOUND",

        statusCode: 404,
      });
    }

    return shift;
  }

  static async getProfessional(professionalProfileId, session = null) {
    const query = ProfessionalProfile.findById(
      ShiftApplicationService.normalizeObjectId(professionalProfileId, "professional profile ID")
    ).select(
      [
        "user",
        "type",
        "specialty",
        "preferredRate",
        "yearsOfExperience",
        "averageRating",
        "totalShiftsCompleted",
        "licenceVerificationStatus",
        "licenceExpiryDate",
        "identityVerificationStatus",
        "professionalApprovalStatus",
        "accountStatus",
        "marketplaceStatus",
        "availabilityStatus",
      ].join(" ")
    );

    if (session) {
      query.session(session);
    }

    const professional = await query;

    if (!professional) {
      throw ShiftApplicationService.createError({
        message: "Professional profile was not found.",

        code: "PROFESSIONAL_PROFILE_NOT_FOUND",

        statusCode: 404,
      });
    }

    return professional;
  }

  static async getApplication({ applicationId, professionalProfileId = null, session = null }) {
    const filter = {
      _id: ShiftApplicationService.normalizeObjectId(applicationId, "application ID"),
    };

    if (professionalProfileId) {
      filter.professional = ShiftApplicationService.normalizeObjectId(
        professionalProfileId,
        "professional profile ID"
      );
    }

    const query = ShiftApplication.findOne(filter);

    if (session) {
      query.session(session);
    }

    const application = await query;

    if (!application) {
      throw ShiftApplicationService.createError({
        message: "Shift application was not found.",

        code: "SHIFT_APPLICATION_NOT_FOUND",

        statusCode: 404,
      });
    }

    return application;
  }

  static async getEmployerApplication({
    applicationId,
    employerProfileId,
    employerContext = null,
    session,
  }) {
    const application = await ShiftApplicationService.getApplication({
      applicationId,

      session,
    });

    const shift = await ShiftApplicationService.getEmployerShift({
      shiftId: application.shift,

      employerProfileId,

      employerContext,

      session,
    });

    return {
      application,

      shift,
    };
  }

  /* ─────────────────────────────── PROFESSIONAL ELIGIBILITY ─────────────────────────────── */

  static assertProfessionalEligible({ professional, shift, now = new Date() }) {
    if (professional.type !== shift.professionalType) {
      throw ShiftApplicationService.createError({
        message: "Your professional type does not match this shift.",

        code: "SHIFT_PROFESSIONAL_TYPE_MISMATCH",

        statusCode: 403,
      });
    }

    if (professional.professionalApprovalStatus !== "approved") {
      throw ShiftApplicationService.createError({
        message: "Your professional profile must be approved before applying for shifts.",

        code: "PROFESSIONAL_NOT_APPROVED_FOR_SHIFTS",

        statusCode: 403,
      });
    }

    if (professional.accountStatus !== "active") {
      throw ShiftApplicationService.createError({
        message: "Your professional account is not active.",

        code: "PROFESSIONAL_ACCOUNT_NOT_ACTIVE",

        statusCode: 403,
      });
    }

    if (professional.marketplaceStatus !== "visible") {
      throw ShiftApplicationService.createError({
        message: "Your professional profile is not currently visible in the marketplace.",

        code: "PROFESSIONAL_MARKETPLACE_ACCESS_NOT_AVAILABLE",

        statusCode: 403,
      });
    }

    if (PROFESSIONAL_UNAVAILABLE_STATUSES.includes(professional.availabilityStatus)) {
      throw ShiftApplicationService.createError({
        message: "Update your availability before applying for this shift.",

        code: "PROFESSIONAL_NOT_AVAILABLE",

        statusCode: 403,
      });
    }

    if (professional.licenceVerificationStatus !== "verified") {
      throw ShiftApplicationService.createError({
        message: "Your professional licence must be verified before applying for shifts.",

        code: "PROFESSIONAL_LICENCE_NOT_VERIFIED",

        statusCode: 403,
      });
    }

    if (professional.licenceExpiryDate && new Date(professional.licenceExpiryDate) <= now) {
      throw ShiftApplicationService.createError({
        message: "Your professional licence has expired.",

        code: "PROFESSIONAL_LICENCE_EXPIRED",

        statusCode: 403,
      });
    }

    if (professional.identityVerificationStatus !== "verified") {
      throw ShiftApplicationService.createError({
        message: "Your identity must be verified before applying for shifts.",

        code: "PROFESSIONAL_IDENTITY_NOT_VERIFIED",

        statusCode: 403,
      });
    }

    return professional;
  }

  /* ─────────────────────────────── APPLICATION ROUND ─────────────────────────────── */

  static assertOccurrenceTargetAvailable({ occurrence, now = new Date() }) {
    if (occurrence.assignmentStatus !== "replacement_required") {
      throw ShiftApplicationService.createError({
        message: "This occurrence is no longer accepting replacement applications.",

        code: "OCCURRENCE_NOT_REQUIRING_REPLACEMENT",

        statusCode: 409,
      });
    }

    if (occurrence.assignedProfessional || occurrence.assignment || occurrence.assignedAt) {
      throw ShiftApplicationService.createError({
        message: "A professional has already been assigned to this occurrence.",

        code: "OCCURRENCE_ALREADY_ASSIGNED",

        statusCode: 409,
      });
    }

    if (
      occurrence.status !== "scheduled" ||
      occurrence.attendanceStatus !== "not_started" ||
      occurrence.settlementStatus !== "not_due" ||
      occurrence.checkedInAt ||
      occurrence.checkedOutAt ||
      occurrence.checkInPinUsedAt ||
      occurrence.checkOutPinUsedAt
    ) {
      throw ShiftApplicationService.createError({
        message: "This occurrence is no longer available for replacement hiring.",

        code: "OCCURRENCE_REPLACEMENT_APPLICATION_NOT_AVAILABLE",

        statusCode: 409,
      });
    }

    if (!occurrence.replacementRequiredAt || !occurrence.replacementForAssignment) {
      throw ShiftApplicationService.createError({
        message: "The occurrence replacement context is incomplete.",

        code: "INCOMPLETE_OCCURRENCE_REPLACEMENT_CONTEXT",

        statusCode: 409,
      });
    }

    if (!occurrence.fillCutoffAt) {
      throw ShiftApplicationService.createError({
        message: "The occurrence fill cutoff is missing.",

        code: "OCCURRENCE_FILL_CUTOFF_MISSING",

        statusCode: 500,
      });
    }

    if (new Date(occurrence.fillCutoffAt) <= now) {
      throw ShiftApplicationService.createError({
        message: "Applications for this occurrence are now closed.",

        code: "OCCURRENCE_APPLICATION_WINDOW_CLOSED",

        statusCode: 409,
      });
    }

    if (occurrence.unfilledFinalizationAt && new Date(occurrence.unfilledFinalizationAt) <= now) {
      throw ShiftApplicationService.createError({
        message: "This occurrence is being finalized as unfilled.",

        code: "OCCURRENCE_UNFILLED_FINALIZATION_STARTED",

        statusCode: 409,
      });
    }

    if (new Date(occurrence.endTime) <= now) {
      throw ShiftApplicationService.createError({
        message: "This occurrence no longer has a remaining work interval.",

        code: "OCCURRENCE_HAS_NO_AVAILABLE_WORK_INTERVAL",

        statusCode: 409,
      });
    }

    if (occurrence.refundStatus !== "not_eligible") {
      throw ShiftApplicationService.createError({
        message: "This occurrence has already entered the refund workflow.",

        code: "OCCURRENCE_REFUND_ALREADY_STARTED",

        statusCode: 409,
      });
    }

    return occurrence;
  }

  static async getOccurrenceReplacementRoundContext({
    shift,
    occurrenceId,
    requestedApplicationRound = null,
    session,
    now = new Date(),
  }) {
    const normalizedOccurrenceId = ShiftApplicationService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const occurrenceQuery = ShiftOccurrence.findOne({
      _id: normalizedOccurrenceId,

      shift: shift._id,
    }).select(
      [
        "referenceCode",
        "shift",
        "business",
        "branch",
        "sequenceNumber",
        "startTime",
        "endTime",
        "fillCutoffAt",
        "unfilledFinalizationAt",
        "assignmentStatus",
        "assignedProfessional",
        "assignment",
        "assignedAt",
        "status",
        "attendanceStatus",
        "settlementStatus",
        "checkedInAt",
        "checkedOutAt",
        "checkInPinUsedAt",
        "checkOutPinUsedAt",
        "refundStatus",
        "replacementRequiredAt",
        "replacementForAssignment",
        "replacementCase",
        "replacementReasonCode",
      ].join(" ")
    );

    if (session) {
      occurrenceQuery.session(session);
    }

    const occurrence = await occurrenceQuery;

    if (!occurrence) {
      throw ShiftApplicationService.createError({
        message: "The replacement occurrence was not found.",

        code: "REPLACEMENT_OCCURRENCE_NOT_FOUND",

        statusCode: 404,
      });
    }

    ShiftApplicationService.assertOccurrenceTargetAvailable({
      occurrence,

      now,
    });

    if (shift.scheduleMode !== "multiple") {
      throw ShiftApplicationService.createError({
        message:
          "Single-occurrence replacement hiring is only available within a multi-occurrence Shift.",

        code: "OCCURRENCE_REPLACEMENT_NOT_AVAILABLE",

        statusCode: 409,
      });
    }

    const replacementQuery = ShiftAssignment.findOne({
      _id: occurrence.replacementForAssignment,

      shift: shift._id,

      status: {
        $in: REPLACEABLE_ASSIGNMENT_STATUSES,
      },
    }).select(
      [
        "shift",
        "professional",
        "status",
        "occurrence",
        "startSequence",
        "plannedEndSequence",
        "effectiveEndSequence",
        "replacedByAssignment",
        "assignedAt",
      ].join(" ")
    );

    if (session) {
      replacementQuery.session(session);
    }

    const replacementForAssignment = await replacementQuery;

    if (!replacementForAssignment) {
      throw ShiftApplicationService.createError({
        message: "The assignment that previously owned this occurrence is not available.",

        code: "OCCURRENCE_REPLACED_ASSIGNMENT_NOT_AVAILABLE",

        statusCode: 409,
      });
    }

    /*
     * The current isolated-occurrence hiring round is tied to the current
     * replacementRequiredAt.
     *
     * All applications created after that timestamp belong to the same
     * occurrence hiring opportunity.
     *
     * If this occurrence is filled and later released again,
     * replacementRequiredAt changes and the next application round advances.
     */
    const currentCycleQuery = ShiftApplication.findOne({
      shift: shift._id,

      occurrence: occurrence._id,

      applicationType: "replacement",

      createdAt: {
        $gte: occurrence.replacementRequiredAt,
      },
    })
      .select("applicationRound createdAt")
      .sort({
        applicationRound: -1,

        createdAt: -1,
      });

    if (session) {
      currentCycleQuery.session(session);
    }

    const currentCycleApplication = await currentCycleQuery;

    let applicationRound;

    if (currentCycleApplication) {
      applicationRound = Number(currentCycleApplication.applicationRound);
    } else {
      const previousRoundQuery = ShiftApplication.findOne({
        shift: shift._id,

        occurrence: occurrence._id,

        applicationType: "replacement",
      })
        .select("applicationRound")
        .sort({
          applicationRound: -1,

          createdAt: -1,
        });

      if (session) {
        previousRoundQuery.session(session);
      }

      const previousRoundApplication = await previousRoundQuery;

      const previousRound = Number(previousRoundApplication?.applicationRound || 1);

      applicationRound = Math.max(2, previousRound + 1);
    }

    if (
      !Number.isSafeInteger(applicationRound) ||
      applicationRound < 2 ||
      applicationRound > MAX_APPLICATION_ROUNDS
    ) {
      throw ShiftApplicationService.createError({
        message: "No further application round is available for this occurrence.",

        code: "OCCURRENCE_APPLICATION_ROUND_LIMIT_REACHED",

        statusCode: 409,
      });
    }

    if (requestedApplicationRound !== null && requestedApplicationRound !== undefined) {
      const normalizedRequestedRound = Number(requestedApplicationRound);

      if (
        !Number.isSafeInteger(normalizedRequestedRound) ||
        normalizedRequestedRound !== applicationRound
      ) {
        throw ShiftApplicationService.createError({
          message: "This application belongs to an earlier occurrence replacement round.",

          code: "STALE_OCCURRENCE_APPLICATION_ROUND",

          statusCode: 409,

          details: {
            applicationRound: normalizedRequestedRound,

            currentApplicationRound: applicationRound,
          },
        });
      }
    }

    return {
      applicationType: "replacement",

      applicationRound,

      occurrence,

      isOccurrenceTargeted: true,

      replacementForAssignment,

      replacementCaseId: occurrence.replacementCase || null,

      startSequenceNumber: occurrence.sequenceNumber,

      endSequenceNumber: occurrence.sequenceNumber,

      expectedOccurrenceCount: 1,
    };
  }

  static async getApplicationRoundContext({
    shift,
    occurrenceId = null,
    requestedApplicationRound = null,
    session,
    now = new Date(),
  }) {
    /*
     * An explicit occurrence target means this is an isolated replacement
     * opportunity.
     *
     * It does not use Shift.replacementHiring.
     */
    if (occurrenceId) {
      return ShiftApplicationService.getOccurrenceReplacementRoundContext({
        shift,

        occurrenceId,

        requestedApplicationRound,

        session,

        now,
      });
    }

    const replacementHiringStatus = String(
      shift.replacementHiring?.status || REPLACEMENT_HIRING_STATUSES.CLOSED
    )
      .trim()
      .toLowerCase();

    if (replacementHiringStatus === REPLACEMENT_HIRING_STATUSES.OPEN) {
      const applicationRound = Number(shift.replacementHiring?.applicationRound);

      const replacementForAssignmentId = shift.replacementHiring?.replacementForAssignment;

      const replacementCaseId = shift.replacementHiring?.assignmentCase;

      if (
        !Number.isSafeInteger(applicationRound) ||
        applicationRound < 2 ||
        applicationRound !== Number(shift.applicationRound)
      ) {
        throw ShiftApplicationService.createError({
          message: "The replacement application round is not configured correctly.",

          code: "INVALID_REPLACEMENT_APPLICATION_ROUND",

          statusCode: 409,
        });
      }

      if (!replacementForAssignmentId || !replacementCaseId) {
        throw ShiftApplicationService.createError({
          message: "The replacement hiring context is incomplete.",

          code: "INCOMPLETE_REPLACEMENT_HIRING_CONTEXT",

          statusCode: 409,
        });
      }

      const replacementQuery = ShiftAssignment.findOne({
        _id: replacementForAssignmentId,

        shift: shift._id,

        status: {
          $in: REPLACEABLE_ASSIGNMENT_STATUSES,
        },
      }).select(
        [
          "shift",
          "professional",
          "status",
          "occurrence",
          "startSequence",
          "plannedEndSequence",
          "effectiveEndSequence",
          "replacedByAssignment",
          "assignedAt",
        ].join(" ")
      );

      if (session) {
        replacementQuery.session(session);
      }

      const replacementForAssignment = await replacementQuery;

      if (!replacementForAssignment) {
        throw ShiftApplicationService.createError({
          message: "The assignment being replaced is not available for this hiring round.",

          code: "REPLACED_ASSIGNMENT_NOT_AVAILABLE",

          statusCode: 409,
        });
      }

      if (replacementForAssignment.replacedByAssignment) {
        throw ShiftApplicationService.createError({
          message: "A replacement has already been recorded for this assignment.",

          code: "ASSIGNMENT_ALREADY_REPLACED",

          statusCode: 409,
        });
      }

      if (
        requestedApplicationRound !== null &&
        requestedApplicationRound !== undefined &&
        Number(requestedApplicationRound) !== applicationRound
      ) {
        throw ShiftApplicationService.createError({
          message: "This application belongs to an earlier replacement round.",

          code: "STALE_SHIFT_APPLICATION_ROUND",

          statusCode: 409,
        });
      }

      return {
        applicationType: "replacement",

        applicationRound,

        occurrence: null,

        isOccurrenceTargeted: false,

        replacementForAssignment,

        replacementCaseId,

        startSequenceNumber: shift.replacementHiring.startSequenceNumber,

        endSequenceNumber: shift.replacementHiring.endSequenceNumber,

        expectedOccurrenceCount: shift.replacementHiring.occurrenceCount,
      };
    }

    if (
      replacementHiringStatus === REPLACEMENT_HIRING_STATUSES.CLOSED &&
      Number(shift.applicationRound || 1) === 1
    ) {
      return {
        applicationType: "initial",

        applicationRound: 1,

        occurrence: null,

        isOccurrenceTargeted: false,

        replacementForAssignment: null,

        replacementCaseId: null,

        startSequenceNumber: 1,

        endSequenceNumber: Number(shift.occurrenceCount || 1),

        expectedOccurrenceCount: Number(shift.occurrenceCount || 1),
      };
    }

    throw ShiftApplicationService.createError({
      message: "This engagement is not accepting applications in its current hiring round.",

      code: "SHIFT_APPLICATION_ROUND_NOT_OPEN",

      statusCode: 409,

      details: {
        applicationRound: Number(shift.applicationRound || 1),

        replacementHiringStatus,
      },
    });
  }

  static assertShiftAcceptingApplications({ shift, roundContext, now = new Date() }) {
    const applicationType = roundContext.applicationType;

    const replacementHiringStatus = String(
      shift.replacementHiring?.status || REPLACEMENT_HIRING_STATUSES.CLOSED
    )
      .trim()
      .toLowerCase();

    if (applicationType === "initial") {
      if (
        shift.status !== "open" ||
        shift.assignedProfessional ||
        shift.activeAssignment ||
        replacementHiringStatus !== REPLACEMENT_HIRING_STATUSES.CLOSED ||
        Number(shift.applicationRound || 1) !== 1
      ) {
        throw ShiftApplicationService.createError({
          message: "This shift is not accepting initial applications.",

          code: "SHIFT_NOT_ACCEPTING_INITIAL_APPLICATIONS",

          statusCode: 409,
        });
      }

      if (shift.paymentStatus !== INITIAL_APPLICATION_PAYMENT_STATUS) {
        throw ShiftApplicationService.createError({
          message: "This shift is not fully funded and cannot accept applications.",

          code: "SHIFT_NOT_FUNDED_FOR_APPLICATIONS",

          statusCode: 409,
        });
      }

      if (new Date(shift.startTime) <= now) {
        throw ShiftApplicationService.createError({
          message: "Applications are closed because the shift has already started.",

          code: "SHIFT_APPLICATION_WINDOW_CLOSED",

          statusCode: 409,
        });
      }

      return shift;
    }

    if (applicationType !== "replacement") {
      throw ShiftApplicationService.createError({
        message: "The application type is invalid.",

        code: "INVALID_APPLICATION_TYPE",
      });
    }

    if (shift.scheduleMode !== "multiple") {
      throw ShiftApplicationService.createError({
        message: "A replacement application is not available for this shift.",

        code: "REPLACEMENT_APPLICATION_NOT_AVAILABLE",

        statusCode: 409,
      });
    }

    if (!REPLACEMENT_APPLICATION_PARENT_STATUSES.includes(shift.status)) {
      throw ShiftApplicationService.createError({
        message: "This engagement is not accepting replacement applications.",

        code: "SHIFT_NOT_ACCEPTING_REPLACEMENT_APPLICATIONS",

        statusCode: 409,
      });
    }

    if (REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES.includes(shift.paymentStatus)) {
      throw ShiftApplicationService.createError({
        message: "This engagement no longer has an active protected-funding state.",

        code: "SHIFT_NOT_FUNDED_FOR_REPLACEMENT_APPLICATIONS",

        statusCode: 409,
      });
    }

    /*
     * An isolated occurrence replacement is opened by the occurrence itself.
     * It must not require or mutate parent Shift.replacementHiring.
     */
    if (roundContext.isOccurrenceTargeted) {
      ShiftApplicationService.assertOccurrenceTargetAvailable({
        occurrence: roundContext.occurrence,

        now,
      });

      return shift;
    }

    if (replacementHiringStatus !== REPLACEMENT_HIRING_STATUSES.OPEN) {
      throw ShiftApplicationService.createError({
        message: "This engagement is not accepting replacement applications.",

        code: "SHIFT_NOT_ACCEPTING_REPLACEMENT_APPLICATIONS",

        statusCode: 409,
      });
    }

    return shift;
  }

  static buildReplacementOccurrenceFilter({ shift, now = new Date() }) {
    return {
      shift: shift._id,

      sequenceNumber: {
        $gte: Number(shift.replacementHiring.startSequenceNumber),

        $lte: Number(shift.replacementHiring.endSequenceNumber),
      },

      assignmentStatus: "replacement_required",

      assignedProfessional: null,

      assignment: null,

      assignedAt: null,

      status: "scheduled",

      attendanceStatus: "not_started",

      settlementStatus: "not_due",

      checkedInAt: null,

      checkedOutAt: null,

      checkInPinUsedAt: null,

      checkOutPinUsedAt: null,

      replacementForAssignment: shift.replacementHiring.replacementForAssignment,

      replacementCase: shift.replacementHiring.assignmentCase,

      refundStatus: "not_eligible",

      fillCutoffAt: {
        $gt: now,
      },

      endTime: {
        $gt: now,
      },
    };
  }

  static buildOccurrenceTargetFilter({ shift, occurrence, now = new Date() }) {
    return {
      _id: occurrence._id,

      shift: shift._id,

      assignmentStatus: "replacement_required",

      assignedProfessional: null,

      assignment: null,

      assignedAt: null,

      status: "scheduled",

      attendanceStatus: "not_started",

      settlementStatus: "not_due",

      checkedInAt: null,

      checkedOutAt: null,

      checkInPinUsedAt: null,

      checkOutPinUsedAt: null,

      replacementRequiredAt: occurrence.replacementRequiredAt,

      replacementForAssignment: occurrence.replacementForAssignment,

      replacementCase: occurrence.replacementCase || null,

      refundStatus: "not_eligible",

      fillCutoffAt: {
        $gt: now,
      },

      endTime: {
        $gt: now,
      },
    };
  }

  static async assertReplacementOccurrencesAvailable({
    shift,
    roundContext,
    session,
    now = new Date(),
  }) {
    if (roundContext.isOccurrenceTargeted) {
      const query = ShiftOccurrence.countDocuments(
        ShiftApplicationService.buildOccurrenceTargetFilter({
          shift,

          occurrence: roundContext.occurrence,

          now,
        })
      );

      if (session) {
        query.session(session);
      }

      const eligibleCount = await query;

      if (eligibleCount !== 1) {
        throw ShiftApplicationService.createError({
          message: "This occurrence is no longer available for replacement.",

          code: "OCCURRENCE_REPLACEMENT_NOT_AVAILABLE",

          statusCode: 409,
        });
      }

      return 1;
    }

    const query = ShiftOccurrence.countDocuments(
      ShiftApplicationService.buildReplacementOccurrenceFilter({
        shift,

        now,
      })
    );

    if (session) {
      query.session(session);
    }

    const eligibleCount = await query;

    if (eligibleCount <= 0) {
      throw ShiftApplicationService.createError({
        message: "No remaining occurrences are currently available for replacement.",

        code: "REPLACEMENT_OCCURRENCES_NOT_AVAILABLE",

        statusCode: 409,
      });
    }

    const expectedOccurrenceCount = Number(shift.replacementHiring?.occurrenceCount || 0);

    if (
      !Number.isSafeInteger(expectedOccurrenceCount) ||
      expectedOccurrenceCount <= 0 ||
      eligibleCount !== expectedOccurrenceCount
    ) {
      throw ShiftApplicationService.createError({
        message:
          "Replacement availability is being reconciled. Please retry after the occurrence range is updated.",

        code: "REPLACEMENT_OCCURRENCE_SUMMARY_STALE",

        statusCode: 409,

        details: {
          expectedOccurrenceCount,

          eligibleOccurrenceCount: eligibleCount,
        },
      });
    }

    return eligibleCount;
  }

  /* ─────────────────────────────── SCHEDULE CONFLICTS ─────────────────────────────── */

  static async getCandidateIntervals({ shift, roundContext, session, now = new Date() }) {
    if (roundContext.isOccurrenceTargeted) {
      const occurrence = roundContext.occurrence;

      ShiftApplicationService.assertOccurrenceTargetAvailable({
        occurrence,

        now,
      });

      return [
        {
          startTime: new Date(occurrence.startTime) < now ? now : occurrence.startTime,

          endTime: occurrence.endTime,
        },
      ];
    }

    const applicationType = roundContext.applicationType;

    if ((shift.scheduleMode || "single") === "single") {
      if (new Date(shift.endTime) <= now) {
        throw ShiftApplicationService.createError({
          message: "This shift no longer has a remaining work interval.",

          code: "SHIFT_HAS_NO_AVAILABLE_WORK_DATES",

          statusCode: 409,
        });
      }

      return [
        {
          startTime:
            applicationType === "replacement" && new Date(shift.startTime) < now
              ? now
              : shift.startTime,

          endTime: shift.endTime,
        },
      ];
    }

    const filter =
      applicationType === "replacement"
        ? ShiftApplicationService.buildReplacementOccurrenceFilter({
            shift,

            now,
          })
        : {
            shift: shift._id,

            assignmentStatus: "unassigned",

            assignedProfessional: null,

            assignment: null,

            assignedAt: null,

            status: "scheduled",

            attendanceStatus: "not_started",

            settlementStatus: "not_due",

            endTime: {
              $gt: now,
            },
          };

    const query = ShiftOccurrence.find(filter).select("sequenceNumber startTime endTime").sort({
      sequenceNumber: 1,
    });

    if (session) {
      query.session(session);
    }

    const occurrences = await query.lean();

    if (occurrences.length === 0) {
      throw ShiftApplicationService.createError({
        message: "No remaining work dates are available for this application.",

        code: "SHIFT_HAS_NO_AVAILABLE_WORK_DATES",

        statusCode: 409,
      });
    }

    return occurrences.map((occurrence) => ({
      startTime:
        applicationType === "replacement" && new Date(occurrence.startTime) < now
          ? now
          : occurrence.startTime,

      endTime: occurrence.endTime,
    }));
  }

  static buildOverlapFilter(intervals) {
    return intervals.map((interval) => ({
      startTime: {
        $lt: interval.endTime,
      },

      endTime: {
        $gt: interval.startTime,
      },
    }));
  }

  static async assertNoConfirmedScheduleConflict({
    shift,
    roundContext,
    professionalProfileId,
    session,
    now = new Date(),
  }) {
    const intervals = await ShiftApplicationService.getCandidateIntervals({
      shift,

      roundContext,

      session,

      now,
    });

    const overlapFilter = ShiftApplicationService.buildOverlapFilter(intervals);

    const occurrenceQuery = ShiftOccurrence.findOne({
      shift: {
        $ne: shift._id,
      },

      assignedProfessional: professionalProfileId,

      assignmentStatus: "assigned",

      status: {
        $in: ACTIVE_OCCURRENCE_STATUSES,
      },

      $or: overlapFilter,
    }).select(["shift", "referenceCode", "sequenceNumber", "startTime", "endTime"].join(" "));

    const singleShiftQuery = Shift.findOne({
      _id: {
        $ne: shift._id,
      },

      scheduleMode: {
        $ne: "multiple",
      },

      assignedProfessional: professionalProfileId,

      status: {
        $in: ACTIVE_SINGLE_SHIFT_STATUSES,
      },

      $or: overlapFilter,
    }).select(["referenceCode", "startTime", "endTime"].join(" "));

    if (session) {
      occurrenceQuery.session(session);

      singleShiftQuery.session(session);
    }

    const [conflictingOccurrence, conflictingSingleShift] = await Promise.all([
      occurrenceQuery.lean(),

      singleShiftQuery.lean(),
    ]);

    if (conflictingOccurrence || conflictingSingleShift) {
      const conflict = conflictingOccurrence || conflictingSingleShift;

      throw ShiftApplicationService.createError({
        message: "This shift overlaps with work already assigned to you.",

        code: "PROFESSIONAL_SHIFT_SCHEDULE_CONFLICT",

        statusCode: 409,

        details: {
          conflictingShiftId: conflictingOccurrence
            ? String(conflictingOccurrence.shift)
            : String(conflictingSingleShift._id),

          conflictingReferenceCode: conflict.referenceCode || null,

          conflictingStartTime: conflict.startTime,

          conflictingEndTime: conflict.endTime,
        },
      });
    }
  }

  /* ─────────────────────────────── APPLICATION CREATION ─────────────────────────────── */

  static buildMatchSnapshot(professional) {
    return {
      professionalType: professional.type,

      specialty: professional.specialty || null,

      yearsOfExperience: Number(professional.yearsOfExperience || 0),

      preferredRate:
        professional.preferredRate === null || professional.preferredRate === undefined
          ? null
          : Number(professional.preferredRate),

      distanceKm: null,

      rating: Number(professional.averageRating || 0),

      completedShifts: Number(professional.totalShiftsCompleted || 0),
    };
  }

  static async createApplication(
    { shiftId, professionalProfileId, occurrenceId = null, note = null },
    options = {}
  ) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const now = new Date();

        const [shift, professional] = await Promise.all([
          ShiftApplicationService.getShift(shiftId, session),

          ShiftApplicationService.getProfessional(professionalProfileId, session),
        ]);

        const roundContext = await ShiftApplicationService.getApplicationRoundContext({
          shift,

          occurrenceId,

          session,

          now,
        });

        ShiftApplicationService.assertShiftAcceptingApplications({
          shift,

          roundContext,

          now,
        });

        ShiftApplicationService.assertProfessionalEligible({
          professional,

          shift,

          now,
        });

        if (roundContext.applicationType === "replacement") {
          await ShiftApplicationService.assertReplacementOccurrencesAvailable({
            shift,

            roundContext,

            session,

            now,
          });
        }

        await ShiftApplicationService.assertNoConfirmedScheduleConflict({
          shift,

          roundContext,

          professionalProfileId: professional._id,

          session,

          now,
        });

        const existingFilter = {
          shift: shift._id,

          professional: professional._id,

          applicationRound: roundContext.applicationRound,

          occurrence: roundContext.occurrence?._id || null,
        };

        const existingQuery = ShiftApplication.findOne(existingFilter);

        if (session) {
          existingQuery.session(session);
        }

        const existingApplication = await existingQuery;

        if (existingApplication) {
          if (ACTIVE_APPLICATION_STATUSES.includes(existingApplication.status)) {
            return {
              application: existingApplication,

              shift,

              occurrence: roundContext.occurrence || null,

              applicationType: roundContext.applicationType,

              applicationRound: roundContext.applicationRound,

              isOccurrenceTargeted: roundContext.isOccurrenceTargeted,

              created: false,

              idempotent: true,
            };
          }

          throw ShiftApplicationService.createError({
            message: "You already submitted an application for this hiring opportunity.",

            code: "SHIFT_APPLICATION_ALREADY_EXISTS",

            statusCode: 409,

            details: {
              status: existingApplication.status,

              applicationId: String(existingApplication._id),

              occurrenceId: roundContext.occurrence?._id
                ? String(roundContext.occurrence._id)
                : null,
            },
          });
        }

        const application = new ShiftApplication({
          shift: shift._id,

          professional: professional._id,

          occurrence: roundContext.occurrence?._id || null,

          applicationType: roundContext.applicationType,

          applicationRound: roundContext.applicationRound,

          replacementForAssignment: roundContext.replacementForAssignment?._id || null,

          status: "pending",

          note: ShiftApplicationService.normalizeOptionalText(
            note,
            "Application note",
            MAX_APPLICATION_NOTE_LENGTH
          ),

          matchSnapshot: ShiftApplicationService.buildMatchSnapshot(professional),
        });

        await application.save({
          session,
        });

        const shiftCounterFilter = {
          _id: shift._id,
        };

        let counterIncrement;

        if (roundContext.applicationType === "initial") {
          Object.assign(shiftCounterFilter, {
            applicationRound: roundContext.applicationRound,

            status: "open",

            paymentStatus: INITIAL_APPLICATION_PAYMENT_STATUS,

            activeAssignment: null,

            assignedProfessional: null,

            "replacementHiring.status": REPLACEMENT_HIRING_STATUSES.CLOSED,
          });

          counterIncrement = {
            totalApplications: 1,

            currentRoundApplications: 1,
          };
        } else if (roundContext.isOccurrenceTargeted) {
          Object.assign(shiftCounterFilter, {
            status: {
              $in: REPLACEMENT_APPLICATION_PARENT_STATUSES,
            },

            paymentStatus: {
              $nin: REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES,
            },

            "occurrenceProgress.replacementRequired": {
              $gte: 1,
            },
          });

          /*
           * Do not increment currentRoundApplications here.
           *
           * Several occurrence-specific opportunities may be open under the
           * same parent Shift and each has its own occurrence-local round.
           */
          counterIncrement = {
            totalApplications: 1,
          };
        } else {
          Object.assign(shiftCounterFilter, {
            applicationRound: roundContext.applicationRound,

            status: {
              $in: REPLACEMENT_APPLICATION_PARENT_STATUSES,
            },

            paymentStatus: {
              $nin: REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES,
            },

            "replacementHiring.status": REPLACEMENT_HIRING_STATUSES.OPEN,

            "replacementHiring.applicationRound": roundContext.applicationRound,

            "replacementHiring.assignmentCase": roundContext.replacementCaseId,

            "replacementHiring.replacementForAssignment": roundContext.replacementForAssignment._id,
          });

          counterIncrement = {
            totalApplications: 1,

            currentRoundApplications: 1,
          };
        }

        const shiftUpdate = await Shift.updateOne(
          shiftCounterFilter,
          {
            $inc: counterIncrement,
          },
          {
            session,

            runValidators: true,
          }
        );

        if (shiftUpdate.modifiedCount !== 1) {
          throw ShiftApplicationService.createError({
            message: "The engagement stopped accepting applications before submission completed.",

            code: "SHIFT_APPLICATION_CREATION_CONFLICT",

            statusCode: 409,
          });
        }

        logger.info(
          `${roundContext.applicationType} application ${application._id} created for shift ${shift.referenceCode} by professional ${professional._id}${
            roundContext.occurrence
              ? ` for occurrence ${roundContext.occurrence.referenceCode}`
              : ""
          }`
        );

        return {
          application,

          shift,

          occurrence: roundContext.occurrence || null,

          applicationType: roundContext.applicationType,

          applicationRound: roundContext.applicationRound,

          isOccurrenceTargeted: roundContext.isOccurrenceTargeted,

          created: true,

          idempotent: false,

          events: [
            {
              type: "shift_application_created",

              shiftId: String(shift._id),

              occurrenceId: roundContext.occurrence?._id
                ? String(roundContext.occurrence._id)
                : null,

              applicationId: String(application._id),

              professionalId: String(professional._id),

              employerProfileId: String(shift.business),

              applicationType: roundContext.applicationType,

              applicationRound: roundContext.applicationRound,

              isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
            },
          ],
        };
      }
    );
  }

  /* ─────────────────────────────── PROFESSIONAL WITHDRAWAL ─────────────────────────────── */

  static async withdrawApplication(
    { applicationId, professionalProfileId, withdrawalReason = null },
    options = {}
  ) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const application = await ShiftApplicationService.getApplication({
          applicationId,

          professionalProfileId,

          session,
        });

        if (!ACTIVE_APPLICATION_STATUSES.includes(application.status)) {
          throw ShiftApplicationService.createError({
            message: "This application can no longer be withdrawn.",

            code: "SHIFT_APPLICATION_WITHDRAWAL_NOT_ALLOWED",

            statusCode: 409,

            details: {
              status: application.status,
            },
          });
        }

        const now = new Date();

        application.status = "withdrawn";

        application.withdrawnAt = now;

        application.withdrawalReason = ShiftApplicationService.normalizeOptionalText(
          withdrawalReason,
          "Withdrawal reason",
          MAX_REASON_LENGTH
        );

        await application.save({
          session,
        });

        logger.info(`Shift application ${application._id} withdrawn`);

        return {
          application,

          events: [
            {
              type: "shift_application_withdrawn",

              shiftId: String(application.shift),

              applicationId: String(application._id),

              professionalId: String(application.professional),
            },
          ],
        };
      }
    );
  }

  /* ─────────────────────────────── EMPLOYER REVIEW ─────────────────────────────── */

  static assertApplicationReviewable(application) {
    if (!ACTIVE_APPLICATION_STATUSES.includes(application.status)) {
      throw ShiftApplicationService.createError({
        message: "This application can no longer be reviewed.",

        code: "SHIFT_APPLICATION_REVIEW_NOT_ALLOWED",

        statusCode: 409,

        details: {
          status: application.status,
        },
      });
    }
  }

  static async shortlistApplication(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      reviewedByUserId,
      employerPrivateNote = null,
    },
    options = {}
  ) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const reviewedBy = ShiftApplicationService.normalizeObjectId(
          reviewedByUserId,
          "reviewed-by user ID"
        );

        const { application, shift } = await ShiftApplicationService.getEmployerApplication({
          applicationId,

          employerProfileId,

          employerContext,

          session,
        });

        ShiftApplicationService.assertApplicationReviewable(application);

        if (application.status === "shortlisted") {
          return {
            application,

            shift,

            idempotent: true,
          };
        }

        const now = new Date();

        application.status = "shortlisted";

        application.shortlistedAt = now;

        application.reviewedAt = now;

        application.reviewedBy = reviewedBy;

        application.employerPrivateNote = ShiftApplicationService.normalizeOptionalText(
          employerPrivateNote,
          "Employer private note",
          MAX_REVIEW_NOTE_LENGTH
        );

        await application.save({
          session,
        });

        return {
          application,

          shift,

          idempotent: false,

          events: [
            {
              type: "shift_application_shortlisted",

              shiftId: String(shift._id),

              applicationId: String(application._id),

              professionalId: String(application.professional),
            },
          ],
        };
      }
    );
  }

  static async rejectApplication(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      reviewedByUserId,
      rejectedReason = null,
      employerPrivateNote = null,
    },
    options = {}
  ) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const reviewedBy = ShiftApplicationService.normalizeObjectId(
          reviewedByUserId,
          "reviewed-by user ID"
        );

        const { application, shift } = await ShiftApplicationService.getEmployerApplication({
          applicationId,

          employerProfileId,

          employerContext,

          session,
        });

        ShiftApplicationService.assertApplicationReviewable(application);

        const now = new Date();

        application.status = "rejected";

        application.rejectedAt = now;

        application.reviewedAt = now;

        application.reviewedBy = reviewedBy;

        application.rejectedReason = ShiftApplicationService.normalizeOptionalText(
          rejectedReason,
          "Rejection reason",
          MAX_REASON_LENGTH
        );

        application.employerPrivateNote = ShiftApplicationService.normalizeOptionalText(
          employerPrivateNote,
          "Employer private note",
          MAX_REVIEW_NOTE_LENGTH
        );

        await application.save({
          session,
        });

        return {
          application,

          shift,

          events: [
            {
              type: "shift_application_rejected",

              shiftId: String(shift._id),

              applicationId: String(application._id),

              professionalId: String(application.professional),
            },
          ],
        };
      }
    );
  }

  /* ─────────────────────────────── ACCEPTANCE ─────────────────────────────── */

  static async acceptApplication(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      reviewedByUserId,
      employerPrivateNote = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const now = ShiftApplicationService.normalizeCurrentTime(currentTime);

        const reviewedBy = ShiftApplicationService.normalizeObjectId(
          reviewedByUserId,
          "reviewed-by user ID"
        );

        const { application, shift } = await ShiftApplicationService.getEmployerApplication({
          applicationId,

          employerProfileId,

          employerContext,

          session,
        });

        ShiftApplicationService.assertApplicationReviewable(application);

        const professional = await ShiftApplicationService.getProfessional(
          application.professional,
          session
        );

        const roundContext = await ShiftApplicationService.getApplicationRoundContext({
          shift,

          occurrenceId: application.occurrence || null,

          requestedApplicationRound: application.applicationRound,

          session,

          now,
        });

        ShiftApplicationService.assertProfessionalEligible({
          professional,

          shift,

          now,
        });

        ShiftApplicationService.assertShiftAcceptingApplications({
          shift,

          roundContext,

          now,
        });

        const applicationType = String(application.applicationType || roundContext.applicationType)
          .trim()
          .toLowerCase();

        const applicationRound = Number(
          application.applicationRound || roundContext.applicationRound
        );

        if (
          applicationType !== roundContext.applicationType ||
          applicationRound !== roundContext.applicationRound
        ) {
          throw ShiftApplicationService.createError({
            message: "This application belongs to an earlier application round.",

            code: "STALE_SHIFT_APPLICATION_ROUND",

            statusCode: 409,

            details: {
              applicationType,

              applicationRound,

              currentApplicationType: roundContext.applicationType,

              currentApplicationRound: roundContext.applicationRound,
            },
          });
        }

        const applicationOccurrenceId = application.occurrence
          ? String(application.occurrence)
          : null;

        const currentOccurrenceId = roundContext.occurrence?._id
          ? String(roundContext.occurrence._id)
          : null;

        if (applicationOccurrenceId !== currentOccurrenceId) {
          throw ShiftApplicationService.createError({
            message:
              "This application no longer belongs to the active occurrence replacement request.",

            code: "STALE_OCCURRENCE_REPLACEMENT_APPLICATION",

            statusCode: 409,
          });
        }

        if (applicationType === "replacement") {
          const applicationReplacementForAssignment = application.replacementForAssignment
            ? String(application.replacementForAssignment)
            : null;

          const currentReplacementForAssignment = roundContext.replacementForAssignment
            ? String(roundContext.replacementForAssignment._id)
            : null;

          if (applicationReplacementForAssignment !== currentReplacementForAssignment) {
            throw ShiftApplicationService.createError({
              message: "This application no longer belongs to the active replacement request.",

              code: "STALE_REPLACEMENT_APPLICATION",

              statusCode: 409,
            });
          }

          await ShiftApplicationService.assertReplacementOccurrencesAvailable({
            shift,

            roundContext,

            session,

            now,
          });
        }

        await ShiftApplicationService.assertNoConfirmedScheduleConflict({
          shift,

          roundContext,

          professionalProfileId: professional._id,

          session,

          now,
        });

        /*
         * Accepting an application creates a new professional assignment and
         * therefore a new employer obligation.
         *
         * Application-management authority was already established above.
         * This separate business-level check answers only whether the business
         * is currently allowed to create that new obligation.
         *
         * Keep this immediately before assignment creation so shortlist/reject
         * remain available during delinquency while acceptance is blocked.
         */
        await ShiftApplicationService.assertBusinessCanCreateAssignment({
          businessId: shift.business,

          currentTime: now,

          session,
        });

        const assignmentPayload = {
          shiftId: shift._id,

          professionalId: professional._id,

          assignedByUserId: reviewedBy,

          applicationId: application._id,

          source: "application",

          assignedAt: now,
        };

        const assignmentResult =
          applicationType === "initial"
            ? await ShiftAssignmentService.createInitialAssignment(assignmentPayload, {
                session,
              })
            : await ShiftAssignmentService.createReplacementAssignment(
                {
                  ...assignmentPayload,

                  occurrenceId: roundContext.occurrence?._id || null,

                  replacesAssignmentId: roundContext.replacementForAssignment._id,

                  replacementCaseId: roundContext.replacementCaseId || null,

                  startSequenceNumber: roundContext.startSequenceNumber,

                  endSequenceNumber: roundContext.endSequenceNumber,
                },
                {
                  session,
                }
              );

        application.status = "accepted";

        application.acceptedAt = now;

        application.reviewedAt = now;

        application.reviewedBy = reviewedBy;

        application.employerPrivateNote = ShiftApplicationService.normalizeOptionalText(
          employerPrivateNote,
          "Employer private note",
          MAX_REVIEW_NOTE_LENGTH
        );

        application.acceptedAssignment = assignmentResult.assignment._id;

        await application.save({
          session,
        });

        /*
         * Reject competing applications only for the same hiring opportunity.
         *
         * For an isolated replacement, another occurrence under the same Shift
         * must remain completely untouched.
         */
        const rejectedApplications = await ShiftApplication.updateMany(
          {
            _id: {
              $ne: application._id,
            },

            shift: shift._id,

            occurrence: roundContext.occurrence?._id || null,

            applicationRound,

            status: {
              $in: ACTIVE_APPLICATION_STATUSES,
            },
          },
          {
            $set: {
              status: "rejected",

              rejectedAt: now,

              reviewedAt: now,

              reviewedBy,

              rejectedReason: OTHER_APPLICANT_SELECTED_REASON,
            },
          },
          {
            session,

            runValidators: true,
          }
        );

        if (applicationType === "initial") {
          const confirmationUpdate = await Shift.updateOne(
            {
              _id: shift._id,

              activeAssignment: assignmentResult.assignment._id,

              assignedProfessional: professional._id,

              paymentStatus: INITIAL_APPLICATION_PAYMENT_STATUS,

              status: "assigned",

              applicationRound: 1,

              "replacementHiring.status": REPLACEMENT_HIRING_STATUSES.CLOSED,
            },
            {
              $set: {
                status: "confirmed",
              },
            },
            {
              session,

              runValidators: true,
            }
          );

          if (confirmationUpdate.modifiedCount !== 1) {
            throw ShiftApplicationService.createError({
              message: "The assignment was created but shift confirmation could not be finalized.",

              code: "SHIFT_APPLICATION_CONFIRMATION_CONFLICT",

              statusCode: 409,
            });
          }
        }

        const assignmentStatus = String(assignmentResult.assignment.status);

        let confirmationEventType;

        if (applicationType === "initial") {
          confirmationEventType = "shift_professional_confirmed";
        } else if (roundContext.isOccurrenceTargeted) {
          confirmationEventType =
            assignmentStatus === "active"
              ? "shift_occurrence_replacement_professional_activated"
              : "shift_occurrence_replacement_professional_scheduled";
        } else {
          confirmationEventType =
            assignmentStatus === "active"
              ? "shift_replacement_professional_activated"
              : "shift_replacement_professional_scheduled";
        }

        /*
         * ShiftAssignmentService and initial confirmation may both mutate the
         * parent Shift. Reload it inside the same transaction so callers receive
         * the authoritative post-acceptance parent summary rather than the
         * pre-assignment document loaded at the start of this method.
         */
        const acceptedShift = await ShiftApplicationService.getShift(shift._id, session);

        const replacementScope =
          applicationType === "replacement"
            ? roundContext.isOccurrenceTargeted
              ? "isolated"
              : "tail"
            : null;

        logger.info(
          `${applicationType} application ${application._id} accepted for shift ${shift.referenceCode}; assignment ${assignmentResult.assignment.referenceCode} created`
        );

        return {
          application,

          assignment: assignmentResult.assignment,

          assignmentResult,

          shift: acceptedShift,

          occurrence: roundContext.occurrence || null,

          applicationType,

          replacementScope,

          applicationRound,

          isOccurrenceTargeted: roundContext.isOccurrenceTargeted,

          rejectedOtherApplicationCount: rejectedApplications.modifiedCount,

          events: [
            {
              type: "shift_application_accepted",

              shiftId: String(shift._id),

              occurrenceId: roundContext.occurrence?._id
                ? String(roundContext.occurrence._id)
                : null,

              applicationId: String(application._id),

              professionalId: String(professional._id),

              assignmentId: String(assignmentResult.assignment._id),

              applicationType,

              applicationRound,

              isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
            },

            {
              type: confirmationEventType,

              shiftId: String(shift._id),

              occurrenceId: roundContext.occurrence?._id
                ? String(roundContext.occurrence._id)
                : null,

              professionalId: String(professional._id),

              assignmentId: String(assignmentResult.assignment._id),

              assignmentStatus,
            },
          ],
        };
      }
    );
  }

  /* ─────────────────────────────── SYSTEM CLEANUP ─────────────────────────────── */

  static async expireOpenApplicationsForShift(
    { shiftId, applicationRound = null, occurrenceId = undefined },
    options = {}
  ) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const normalizedShiftId = ShiftApplicationService.normalizeObjectId(shiftId, "shift ID");

        const filter = {
          shift: normalizedShiftId,

          status: {
            $in: ACTIVE_APPLICATION_STATUSES,
          },
        };

        if (applicationRound !== null && applicationRound !== undefined) {
          const normalizedRound = Number(applicationRound);

          if (
            !Number.isSafeInteger(normalizedRound) ||
            normalizedRound < 1 ||
            normalizedRound > MAX_APPLICATION_ROUNDS
          ) {
            throw ShiftApplicationService.createError({
              message: "Application round must be a positive whole number.",

              code: "INVALID_APPLICATION_ROUND",
            });
          }

          filter.applicationRound = normalizedRound;

          /*
           * Existing round-based cleanup belongs to parent hiring.
           *
           * Do not let it catch an independent occurrence-targeted round that
           * happens to use the same numeric round.
           */
          if (occurrenceId === undefined) {
            filter.occurrence = null;
          }
        }

        if (occurrenceId !== undefined) {
          filter.occurrence =
            occurrenceId === null
              ? null
              : ShiftApplicationService.normalizeObjectId(occurrenceId, "occurrence ID");
        }

        const result = await ShiftApplication.updateMany(
          filter,
          {
            $set: {
              status: "expired",

              expiredAt: new Date(),
            },
          },
          {
            session,

            runValidators: true,
          }
        );

        return {
          shiftId: String(normalizedShiftId),

          occurrenceId:
            filter.occurrence && occurrenceId !== undefined ? String(filter.occurrence) : null,

          expiredApplicationCount: result.modifiedCount,
        };
      }
    );
  }

  static async cancelOpenApplicationsForShift({ shiftId }, options = {}) {
    return ShiftApplicationService.runWithOptionalTransaction(
      options,

      async (session) => {
        const normalizedShiftId = ShiftApplicationService.normalizeObjectId(shiftId, "shift ID");

        const result = await ShiftApplication.updateMany(
          {
            shift: normalizedShiftId,

            status: {
              $in: ACTIVE_APPLICATION_STATUSES,
            },
          },
          {
            $set: {
              status: "cancelled",

              cancelledAt: new Date(),
            },
          },
          {
            session,

            runValidators: true,
          }
        );

        return {
          shiftId: String(normalizedShiftId),

          cancelledApplicationCount: result.modifiedCount,
        };
      }
    );
  }

  static async getApplicationsByStatus({ shiftId, status, occurrenceId = undefined }) {
    const normalizedShiftId = ShiftApplicationService.normalizeObjectId(shiftId, "shift ID");

    const normalizedStatus = ShiftApplicationService.normalizeStatus(status);

    const filter = {
      shift: normalizedShiftId,

      status: normalizedStatus,
    };

    if (occurrenceId !== undefined) {
      filter.occurrence =
        occurrenceId === null
          ? null
          : ShiftApplicationService.normalizeObjectId(occurrenceId, "occurrence ID");
    }

    return ShiftApplication.find(filter)
      .sort({
        createdAt: -1,
      })
      .lean();
  }
}

module.exports = ShiftApplicationService;
