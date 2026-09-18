// services/shiftApplicationService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftApplication = require("../models/ShiftApplication");
const ShiftAssignment = require("../models/ShiftAssignment");
const ShiftAssignmentCase = require("../models/ShiftAssignmentCase");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const ShiftAssignmentService = require("./shiftAssignmentService");
const EmployerDelinquencyService = require("./employerDelinquencyService");

const {
  MAX_APPLICATION_ROUNDS,
  APPLICATION_STATUSES,
  ACTIVE_APPLICATION_STATUSES,
  REPLACEMENT_APPLICATION_PARENT_STATUSES,
  REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES,
  ACTIVE_OCCURRENCE_STATUSES,
  PROFESSIONAL_UNAVAILABLE_STATUSES,
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
    if (options.session && !options.session.inTransaction()) {
      throw this.createError({
        message: "An active transaction is required for the supplied session.",
        code: "APPLICATION_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

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
      "requiredProfessionals",
      "totalOccurrenceCount",
      "startTime",
      "endTime",
      "status",
      "paymentStatus",
      "fundedAmount",
      "estimatedEmployerCharge",
      "fundedAt",
      "fundingMethod",
      "fundingTransaction",
      "publishedAt",
      "applicationRound",
      "hiringSummary",
      "assignmentSummary",
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
    replacementForAssignmentId = null,
    session,
    now = new Date(),
  }) {
    const occurrence = await ShiftOccurrence.findOne({
      _id: this.normalizeObjectId(occurrenceId, "occurrence ID"),
      shift: shift._id,
    }).session(session);

    if (!occurrence)
      throw this.createError({
        message: "Replacement occurrence was not found.",
        code: "REPLACEMENT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });

    this.assertOccurrenceTargetAvailable({ occurrence, now });

    if (
      replacementForAssignmentId &&
      String(occurrence.replacementForAssignment) !== String(replacementForAssignmentId)
    ) {
      throw this.createError({
        message: "This occurrence now belongs to a different replacement opportunity.",
        code: "STALE_REPLACEMENT_APPLICATION",
        statusCode: 409,
      });
    }

    const previous = await ShiftAssignment.findOne({
      _id: occurrence.replacementForAssignment,
      shift: shift._id,
    }).session(session);

    this.assertReplacementIdentity({ shift, previous, occurrences: [occurrence] });

    let assignmentCase = null;

    if (occurrence.replacementCase) {
      assignmentCase = await this.loadReplacementCase({
        shift,
        previous,
        caseId: occurrence.replacementCase,
        session,
      });
    }

    const applicationRound = await this.resolveReplacementRound({
      shift,
      previous,
      occurrence,
      openedAt: occurrence.replacementRequiredAt,
      requestedApplicationRound,
      session,
    });

    return {
      applicationType: "replacement",
      applicationRound,
      occurrence,
      isOccurrenceTargeted: true,
      replacementForAssignment: previous,
      replacementCaseId: assignmentCase?._id || null,
      slotNumber: previous.slotNumber,
      startSequenceNumber: occurrence.sequenceNumber,
      endSequenceNumber: occurrence.sequenceNumber,
      expectedOccurrenceCount: 1,
      replacementOpenedAt: occurrence.replacementRequiredAt,
    };
  }

  static assertReplacementIdentity({ shift, previous, occurrences }) {
    if (
      !previous ||
      !Number.isSafeInteger(previous.slotNumber) ||
      previous.slotNumber < 1 ||
      previous.slotNumber > shift.requiredProfessionals ||
      String(previous.business) !== String(shift.business) ||
      String(previous.branch) !== String(shift.branch)
    ) {
      throw this.createError({
        message: "The previous assignment context is invalid.",
        code: "REPLACEMENT_ASSIGNMENT_CONTEXT_MISMATCH",
        statusCode: 409,
      });
    }

    for (const occurrence of occurrences) {
      if (
        occurrence.slotNumber !== previous.slotNumber ||
        String(occurrence.business) !== String(shift.business) ||
        String(occurrence.branch) !== String(shift.branch) ||
        String(occurrence.replacementForAssignment) !== String(previous._id) ||
        occurrence.sequenceNumber < previous.startSequence ||
        occurrence.sequenceNumber > previous.plannedEndSequence
      ) {
        throw this.createError({
          message: "Replacement occurrence does not match the prior assignment and slot.",
          code: "REPLACEMENT_OCCURRENCE_CONTEXT_MISMATCH",
          statusCode: 409,
        });
      }
    }
  }

  static async loadReplacementCase({ shift, previous, caseId, session }) {
    const assignmentCase = await ShiftAssignmentCase.findOne({
      _id: caseId,
      assignment: previous._id,
      shift: shift._id,
      business: shift.business,
      branch: shift.branch,
      professional: previous.professional,
      status: { $in: ["replacement_requested", "resolved_exit"] },
    }).session(session);

    if (!assignmentCase)
      throw this.createError({
        message: "The case does not authorize replacement.",
        code: "REPLACEMENT_CASE_NOT_AVAILABLE",
        statusCode: 409,
      });

    return assignmentCase;
  }

  static async resolveReplacementRound({
    shift,
    previous,
    occurrence = null,
    openedAt,
    requestedApplicationRound,
    session,
  }) {
    if (!openedAt || !Number.isFinite(new Date(openedAt).getTime()))
      throw this.createError({
        message: "Replacement opening time is missing.",
        code: "REPLACEMENT_OPENING_MISSING",
        statusCode: 409,
      });

    const scope = {
      shift: shift._id,
      replacementForAssignment: previous._id,
      occurrence: occurrence?._id || null,
      applicationType: "replacement",
    };

    const current = await ShiftApplication.findOne({
      ...scope,
      createdAt: { $gte: openedAt },
    })
      .sort({ applicationRound: -1, createdAt: -1 })
      .session(session);

    let round = current?.applicationRound;

    if (round == null) {
      const previousApplication = await ShiftApplication.findOne(scope)
        .sort({ applicationRound: -1, createdAt: -1 })
        .session(session);

      round = (previousApplication?.applicationRound || 1) + 1;
    }

    if (!Number.isSafeInteger(round) || round < 2 || round > MAX_APPLICATION_ROUNDS)
      throw this.createError({
        message: "No further application round is available for this opportunity.",
        code: "REPLACEMENT_APPLICATION_ROUND_LIMIT_REACHED",
        statusCode: 409,
      });

    if (requestedApplicationRound != null && Number(requestedApplicationRound) !== round)
      throw this.createError({
        message: "The application belongs to an earlier replacement round.",
        code: "STALE_SHIFT_APPLICATION_ROUND",
        statusCode: 409,
      });

    return round;
  }

  static async getApplicationRoundContext({
    shift,
    occurrenceId = null,
    replacementForAssignmentId = null,
    requestedApplicationRound = null,
    session,
    now = new Date(),
  }) {
    if (occurrenceId)
      return this.getOccurrenceReplacementRoundContext({
        shift,
        occurrenceId,
        replacementForAssignmentId,
        requestedApplicationRound,
        session,
        now,
      });

    if (!replacementForAssignmentId) {
      if (requestedApplicationRound != null && Number(requestedApplicationRound) !== 1)
        throw this.createError({
          message: "Tail replacement requires its prior assignment ID.",
          code: "REPLACEMENT_ASSIGNMENT_ID_REQUIRED",
        });

      return {
        applicationType: "initial",
        applicationRound: 1,
        occurrence: null,
        isOccurrenceTargeted: false,
        replacementForAssignment: null,
        replacementCaseId: null,
        slotNumber: null,
        startSequenceNumber: 1,
        endSequenceNumber: shift.occurrenceCount,
        expectedOccurrenceCount: shift.occurrenceCount,
      };
    }

    const previous = await ShiftAssignment.findOne({
      _id: this.normalizeObjectId(replacementForAssignmentId, "replaced assignment ID"),
      shift: shift._id,
    }).session(session);

    this.assertReplacementIdentity({ shift, previous, occurrences: [] });

    if (!REPLACEABLE_ASSIGNMENT_STATUSES.includes(previous.status) || previous.replacedByAssignment)
      throw this.createError({
        message: "This assignment is not available for tail replacement.",
        code: "REPLACED_ASSIGNMENT_NOT_AVAILABLE",
        statusCode: 409,
      });

    const candidates = await ShiftOccurrence.find({
      shift: shift._id,
      slotNumber: previous.slotNumber,
      replacementForAssignment: previous._id,
      assignmentStatus: "replacement_required",
      replacementCase: { $ne: null },
      status: "scheduled",
    })
      .sort({ sequenceNumber: 1 })
      .session(session);

    const caseIds = [...new Set(candidates.map((o) => String(o.replacementCase)))];

    if (caseIds.length !== 1)
      throw this.createError({
        message: "A unique case-authorized tail could not be resolved.",
        code: "REPLACEMENT_OPPORTUNITY_NOT_AVAILABLE",
        statusCode: 409,
      });

    const assignmentCase = await this.loadReplacementCase({
      shift,
      previous,
      caseId: candidates[0].replacementCase,
      session,
    });

    const range =
      assignmentCase.status === "resolved_exit"
        ? assignmentCase.resolution?.effectiveExitRange
        : assignmentCase.exitProposal?.range;

    const start = range?.replacementStartSequenceNumber;
    const end = range?.replacementEndSequenceNumber;

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < previous.startSequence ||
      end !== previous.plannedEndSequence ||
      start > end ||
      range.replacementOccurrenceCount !== end - start + 1
    )
      throw this.createError({
        message: "The case replacement range is invalid.",
        code: "REPLACEMENT_CASE_RANGE_INVALID",
        statusCode: 409,
      });

    const authorizationAnchor = await ShiftOccurrence.findOne({
      shift: shift._id,
      slotNumber: previous.slotNumber,
      sequenceNumber: {
        $gte: start,
        $lte: end,
      },
      replacementForAssignment: previous._id,
      replacementCase: assignmentCase._id,
      replacementRequiredAt: {
        $ne: null,
      },
    })
      .sort({
        sequenceNumber: 1,
      })
      .session(session);

    if (!authorizationAnchor?.replacementRequiredAt)
      throw this.createError({
        message: "The replacement opportunity opening could not be resolved.",
        code: "REPLACEMENT_OPENING_MISSING",
        statusCode: 409,
      });

    const authorizedRoundContext = {
      slotNumber: previous.slotNumber,
      startSequenceNumber: start,
      endSequenceNumber: end,
      replacementForAssignment: previous,
      replacementCaseId: assignmentCase._id,
    };

    const availableOccurrences = await ShiftOccurrence.find(
      this.buildReplacementOccurrenceFilter({
        shift,
        roundContext: authorizedRoundContext,
        now,
      })
    )
      .sort({
        sequenceNumber: 1,
      })
      .session(session);

    this.assertReplacementIdentity({
      shift,
      previous,
      occurrences: availableOccurrences,
    });

    if (!availableOccurrences.length)
      throw this.createError({
        message: "No case-authorized replacement work remains available.",
        code: "REPLACEMENT_OPPORTUNITY_NOT_AVAILABLE",
        statusCode: 409,
      });

    for (const occurrence of availableOccurrences) {
      this.assertOccurrenceTargetAvailable({
        occurrence,
        now,
      });
    }

    const availableSequences = new Set(
      availableOccurrences.map((occurrence) => Number(occurrence.sequenceNumber))
    );

    if (!availableSequences.has(end))
      throw this.createError({
        message: "The remaining replacement work no longer forms an assignable tail.",
        code: "REPLACEMENT_OPPORTUNITY_NOT_CONTIGUOUS",
        statusCode: 409,
      });

    let executableStart = end;

    while (executableStart > start && availableSequences.has(executableStart - 1)) {
      executableStart -= 1;
    }

    if (availableOccurrences.some((occurrence) => occurrence.sequenceNumber < executableStart))
      throw this.createError({
        message: "The remaining replacement work is fragmented and cannot be assigned as one tail.",
        code: "REPLACEMENT_OPPORTUNITY_NOT_CONTIGUOUS",
        statusCode: 409,
      });

    const executableOccurrences = availableOccurrences.filter(
      (occurrence) => occurrence.sequenceNumber >= executableStart
    );

    const expectedOccurrenceCount = end - executableStart + 1;

    if (
      executableOccurrences.length !== expectedOccurrenceCount ||
      executableOccurrences.some(
        (occurrence, index) => occurrence.sequenceNumber !== executableStart + index
      )
    )
      throw this.createError({
        message: "The remaining replacement work is not a complete contiguous tail.",
        code: "REPLACEMENT_OPPORTUNITY_NOT_CONTIGUOUS",
        statusCode: 409,
      });

    const openedAt = authorizationAnchor.replacementRequiredAt;

    const applicationRound = await this.resolveReplacementRound({
      shift,
      previous,
      openedAt,
      requestedApplicationRound,
      session,
    });

    return {
      applicationType: "replacement",
      applicationRound,
      occurrence: null,
      isOccurrenceTargeted: false,
      replacementForAssignment: previous,
      replacementCaseId: assignmentCase._id,
      slotNumber: previous.slotNumber,
      startSequenceNumber: executableStart,
      endSequenceNumber: end,
      expectedOccurrenceCount,
      replacementOpenedAt: openedAt,
    };
  }

  static assertShiftAcceptingApplications({ shift, roundContext, now = new Date() }) {
    if (
      !shift.publishedAt ||
      !shift.fundedAt ||
      !shift.fundingMethod ||
      !shift.fundingTransaction ||
      !Number.isSafeInteger(shift.fundedAmount) ||
      shift.fundedAmount < shift.estimatedEmployerCharge ||
      REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES.includes(shift.paymentStatus)
    ) {
      throw this.createError({
        message: "Protected funding is not available for applications.",
        code: "SHIFT_NOT_FUNDED_FOR_APPLICATIONS",
        statusCode: 409,
      });
    }

    if (roundContext.applicationType === "initial") {
      if (
        shift.status !== "open" ||
        new Date(shift.startTime) <= now ||
        shift.applicationRound !== 1 ||
        Number(shift.hiringSummary?.initialAcceptedCount || 0) >= shift.requiredProfessionals
      ) {
        throw this.createError({
          message: "Initial hiring is not open.",
          code: "SHIFT_NOT_ACCEPTING_INITIAL_APPLICATIONS",
          statusCode: 409,
        });
      }
    } else {
      if (!REPLACEMENT_APPLICATION_PARENT_STATUSES.includes(shift.status))
        throw this.createError({
          message: "Replacement hiring is not available in this Shift state.",
          code: "SHIFT_NOT_ACCEPTING_REPLACEMENT_APPLICATIONS",
          statusCode: 409,
        });

      if (roundContext.occurrence)
        this.assertOccurrenceTargetAvailable({
          occurrence: roundContext.occurrence,
          now,
        });
    }

    return shift;
  }

  static buildReplacementOccurrenceFilter({ shift, roundContext, now = new Date() }) {
    return {
      shift: shift._id,
      slotNumber: roundContext.slotNumber,
      sequenceNumber: {
        $gte: roundContext.startSequenceNumber,
        $lte: roundContext.endSequenceNumber,
      },
      replacementForAssignment: roundContext.replacementForAssignment._id,
      replacementCase: roundContext.replacementCaseId,
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
      refundStatus: "not_eligible",
      fillCutoffAt: {
        $gt: now,
      },
      endTime: {
        $gt: now,
      },
      $or: [
        {
          unfilledFinalizationAt: null,
        },
        {
          unfilledFinalizationAt: {
            $gt: now,
          },
        },
      ],
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
    const filter = roundContext.isOccurrenceTargeted
      ? this.buildOccurrenceTargetFilter({
          shift,
          occurrence: roundContext.occurrence,
          now,
        })
      : this.buildReplacementOccurrenceFilter({
          shift,
          roundContext,
          now,
        });

    const occurrences = await ShiftOccurrence.find(filter)
      .sort({
        sequenceNumber: 1,
      })
      .session(session);

    if (
      occurrences.length !== roundContext.expectedOccurrenceCount ||
      occurrences.some(
        (occurrence, index) =>
          occurrence.sequenceNumber !== roundContext.startSequenceNumber + index
      )
    ) {
      throw this.createError({
        message: "The complete replacement range is no longer available.",
        code: "REPLACEMENT_OCCURRENCES_NOT_AVAILABLE",
        statusCode: 409,
      });
    }

    this.assertReplacementIdentity({
      shift,
      previous: roundContext.replacementForAssignment,
      occurrences,
    });

    for (const occurrence of occurrences) {
      this.assertOccurrenceTargetAvailable({
        occurrence,
        now,
      });
    }

    return occurrences.length;
  }

  static async getCandidateIntervals({ shift, roundContext, session, now = new Date() }) {
    if (roundContext.isOccurrenceTargeted)
      return [
        {
          startTime: roundContext.occurrence.startTime,
          endTime: roundContext.occurrence.endTime,
        },
      ];

    const filter =
      roundContext.applicationType === "replacement"
        ? this.buildReplacementOccurrenceFilter({
            shift,
            roundContext,
            now,
          })
        : {
            shift: shift._id,
            assignmentStatus: "unassigned",
            assignedProfessional: null,
            assignment: null,
            status: "scheduled",
            attendanceStatus: "not_started",
            settlementStatus: "not_due",
            refundStatus: "not_eligible",
            fillCutoffAt: {
              $gt: now,
            },
          };

    const occurrences = await ShiftOccurrence.find(filter)
      .sort({
        slotNumber: 1,
        sequenceNumber: 1,
      })
      .session(session);

    if (!occurrences.length)
      throw this.createError({
        message: "No work dates are available for this application.",
        code: "SHIFT_HAS_NO_AVAILABLE_WORK_DATES",
        statusCode: 409,
      });

    if (roundContext.applicationType === "initial") {
      const groups = new Map();

      for (const occurrence of occurrences) {
        if (!groups.has(occurrence.slotNumber)) {
          groups.set(occurrence.slotNumber, []);
        }

        groups.get(occurrence.slotNumber).push(occurrence);
      }

      const complete = [...groups.values()].find(
        (group) =>
          group.length === shift.occurrenceCount &&
          group.every((occurrence, index) => occurrence.sequenceNumber === index + 1)
      );

      if (!complete)
        throw this.createError({
          message: "No complete initial position remains.",
          code: "INITIAL_ASSIGNMENT_CAPACITY_FILLED",
          statusCode: 409,
        });

      return complete.map((occurrence) => ({
        startTime: occurrence.startTime,
        endTime: occurrence.endTime,
      }));
    }

    return occurrences.map((occurrence) => ({
      startTime: occurrence.startTime,
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
    const intervals = await this.getCandidateIntervals({
      shift,
      roundContext,
      session,
      now,
    });

    const conflict = await ShiftOccurrence.findOne({
      assignedProfessional: professionalProfileId,
      assignmentStatus: "assigned",
      status: {
        $in: ACTIVE_OCCURRENCE_STATUSES,
      },
      $or: this.buildOverlapFilter(intervals),
    }).session(session);

    if (conflict)
      throw this.createError({
        message: "This application overlaps with work already assigned to you.",
        code: "PROFESSIONAL_SHIFT_SCHEDULE_CONFLICT",
        statusCode: 409,
        details: {
          conflictingShiftId: String(conflict.shift),
          conflictingOccurrenceId: String(conflict._id),
          conflictingSlotNumber: conflict.slotNumber,
        },
      });
  }

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
    {
      shiftId,
      professionalProfileId,
      occurrenceId = null,
      replacementForAssignmentId = null,
      note = null,
    },
    options = {}
  ) {
    return this.runWithOptionalTransaction(options, async (session) => {
      const now = new Date();

      const normalizedShiftId = this.normalizeObjectId(shiftId, "shift ID");

      // Serialize hiring-opportunity reads and counters with assignment writes.
      const shift = await Shift.findOneAndUpdate(
        {
          _id: normalizedShiftId,
        },
        {
          $inc: {
            __v: 1,
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!shift)
        throw this.createError({
          message: "Shift was not found.",
          code: "SHIFT_NOT_FOUND",
          statusCode: 404,
        });

      const professional = await this.getProfessional(professionalProfileId, session);

      const roundContext = await this.getApplicationRoundContext({
        shift,
        occurrenceId,
        replacementForAssignmentId,
        session,
        now,
      });

      this.assertShiftAcceptingApplications({
        shift,
        roundContext,
        now,
      });

      this.assertProfessionalEligible({
        professional,
        shift,
        now,
      });

      if (roundContext.applicationType === "replacement")
        await this.assertReplacementOccurrencesAvailable({
          shift,
          roundContext,
          session,
          now,
        });

      await this.assertNoConfirmedScheduleConflict({
        shift,
        roundContext,
        professionalProfileId: professional._id,
        session,
        now,
      });

      const scope = {
        shift: shift._id,
        professional: professional._id,
        applicationType: roundContext.applicationType,
        applicationRound: roundContext.applicationRound,
        occurrence: roundContext.occurrence?._id || null,
        replacementForAssignment: roundContext.replacementForAssignment?._id || null,
      };

      const existing = await ShiftApplication.findOne(scope).session(session);

      if (existing) {
        if (!ACTIVE_APPLICATION_STATUSES.includes(existing.status))
          throw this.createError({
            message: "You already applied for this opportunity.",
            code: "SHIFT_APPLICATION_ALREADY_EXISTS",
            statusCode: 409,
          });

        return {
          application: existing,
          shift,
          occurrence: roundContext.occurrence,
          applicationType: roundContext.applicationType,
          applicationRound: roundContext.applicationRound,
          isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
          created: false,
          idempotent: true,
        };
      }

      const application = new ShiftApplication({
        ...scope,
        slotNumber: roundContext.slotNumber,
        status: "pending",
        note: this.normalizeOptionalText(note, "Application note", MAX_APPLICATION_NOTE_LENGTH),
        matchSnapshot: this.buildMatchSnapshot(professional),
      });

      await application.save({
        session,
      });

      const increment = {
        totalApplications: 1,
      };

      if (roundContext.applicationType === "initial") {
        increment.currentRoundApplications = 1;
      }

      await Shift.updateOne(
        {
          _id: shift._id,
        },
        {
          $inc: increment,
        },
        {
          session,
          runValidators: true,
        }
      );

      const updatedShift = await this.getShift(shift._id, session);

      return {
        application,
        shift: updatedShift,
        occurrence: roundContext.occurrence,
        applicationType: roundContext.applicationType,
        applicationRound: roundContext.applicationRound,
        isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
        created: true,
        idempotent: false,
        events: [
          {
            type: "shift_application_created",
            shiftId: String(shift._id),
            occurrenceId: roundContext.occurrence?._id ? String(roundContext.occurrence._id) : null,
            applicationId: String(application._id),
            professionalId: String(professional._id),
            employerProfileId: String(shift.business),
            applicationType: roundContext.applicationType,
            applicationRound: roundContext.applicationRound,
            slotNumber: roundContext.slotNumber,
            isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
          },
        ],
      };
    });
  }

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
    return this.runWithOptionalTransaction(options, async (session) => {
      const now = this.normalizeCurrentTime(currentTime);

      const reviewedBy = this.normalizeObjectId(reviewedByUserId, "reviewed-by user ID");

      const loaded = await this.getEmployerApplication({
        applicationId,
        employerProfileId,
        employerContext,
        session,
      });

      // Assignment service uses the same parent/professional lock order.
      const shift = await ShiftAssignmentService.lockShiftAndProfessional({
        shiftId: loaded.shift._id,
        professionalId: loaded.application.professional,
        session,
      });

      const application = await this.getApplication({
        applicationId,
        session,
      });

      this.assertApplicationReviewable(application);

      const professional = await this.getProfessional(application.professional, session);

      const roundContext = await this.getApplicationRoundContext({
        shift,
        occurrenceId: application.occurrence || null,
        replacementForAssignmentId: application.replacementForAssignment || null,
        requestedApplicationRound: application.applicationRound,
        session,
        now,
      });

      if (
        application.applicationType !== roundContext.applicationType ||
        (application.applicationType === "replacement" &&
          application.slotNumber !== roundContext.slotNumber)
      ) {
        throw this.createError({
          message: "Application does not match this opportunity.",
          code: "STALE_REPLACEMENT_APPLICATION",
          statusCode: 409,
        });
      }

      this.assertProfessionalEligible({
        professional,
        shift,
        now,
      });

      this.assertShiftAcceptingApplications({
        shift,
        roundContext,
        now,
      });

      if (roundContext.applicationType === "replacement")
        await this.assertReplacementOccurrencesAvailable({
          shift,
          roundContext,
          session,
          now,
        });

      await this.assertNoConfirmedScheduleConflict({
        shift,
        roundContext,
        professionalProfileId: professional._id,
        session,
        now,
      });

      await this.assertBusinessCanCreateAssignment({
        businessId: shift.business,
        currentTime: now,
        session,
      });

      const payload = {
        shiftId: shift._id,
        professionalId: professional._id,
        assignedByUserId: reviewedBy,
        applicationId: application._id,
        source: "application",
        assignedAt: now,
      };

      const assignmentResult =
        roundContext.applicationType === "initial"
          ? await ShiftAssignmentService.createInitialAssignment(payload, {
              session,
            })
          : await ShiftAssignmentService.createReplacementAssignment(
              {
                ...payload,
                slotNumber: roundContext.slotNumber,
                occurrenceId: roundContext.occurrence?._id || null,
                replacesAssignmentId: roundContext.replacementForAssignment._id,
                replacementCaseId: roundContext.replacementCaseId,
                startSequenceNumber: roundContext.startSequenceNumber,
                endSequenceNumber: roundContext.endSequenceNumber,
              },
              {
                session,
              }
            );

      application.status = "accepted";
      application.slotNumber = assignmentResult.assignment.slotNumber;
      application.acceptedAssignment = assignmentResult.assignment._id;
      application.acceptedAt = now;
      application.reviewedAt = now;
      application.reviewedBy = reviewedBy;

      application.employerPrivateNote = this.normalizeOptionalText(
        employerPrivateNote,
        "Employer private note",
        MAX_REVIEW_NOTE_LENGTH
      );

      await application.save({
        session,
      });

      let shouldCloseOpportunity = roundContext.applicationType === "replacement";

      if (!shouldCloseOpportunity) {
        const assignedSlots = await ShiftAssignment.find({
          shift: shift._id,
          occurrence: null,
          assignmentType: "initial",
        }).session(session);

        shouldCloseOpportunity =
          new Set(assignedSlots.map((assignment) => assignment.slotNumber)).size >=
          shift.requiredProfessionals;
      }

      let rejectedOtherApplicationCount = 0;

      if (shouldCloseOpportunity) {
        const result = await ShiftApplication.updateMany(
          {
            _id: {
              $ne: application._id,
            },
            shift: shift._id,
            applicationType: application.applicationType,
            applicationRound: application.applicationRound,
            occurrence: application.occurrence || null,
            replacementForAssignment: application.replacementForAssignment || null,
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

        rejectedOtherApplicationCount = result.modifiedCount;
      }

      const acceptedShift = await this.getShift(shift._id, session);

      const applicationType = application.applicationType;
      const assignmentStatus = assignmentResult.assignment.status;

      const confirmationEventType =
        applicationType === "initial"
          ? "shift_professional_confirmed"
          : roundContext.isOccurrenceTargeted
            ? assignmentStatus === "active"
              ? "shift_occurrence_replacement_professional_activated"
              : "shift_occurrence_replacement_professional_scheduled"
            : assignmentStatus === "active"
              ? "shift_replacement_professional_activated"
              : "shift_replacement_professional_scheduled";

      const eventContext = {
        shiftId: String(shift._id),
        applicationId: String(application._id),
        professionalId: String(professional._id),
        assignmentId: String(assignmentResult.assignment._id),
        slotNumber: application.slotNumber,
        occurrenceId: application.occurrence ? String(application.occurrence) : null,
        applicationType,
        applicationRound: application.applicationRound,
        isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
      };

      logger.info(
        `Application ${application._id} accepted for Shift ${shift.referenceCode}, slot ${application.slotNumber}.`
      );

      return {
        application,
        assignment: assignmentResult.assignment,
        assignmentResult,
        shift: acceptedShift,
        occurrence: roundContext.occurrence,
        applicationType,
        replacementScope:
          applicationType === "replacement"
            ? roundContext.isOccurrenceTargeted
              ? "isolated"
              : "tail"
            : null,
        applicationRound: application.applicationRound,
        isOccurrenceTargeted: roundContext.isOccurrenceTargeted,
        rejectedOtherApplicationCount,
        events: [
          {
            type: "shift_application_accepted",
            ...eventContext,
          },
          {
            type: confirmationEventType,
            ...eventContext,
            assignmentStatus,
          },
        ],
      };
    });
  }

  static async expireOpenApplicationsForShift(
    {
      shiftId,
      applicationRound = null,
      occurrenceId = undefined,
      replacementForAssignmentId = null,
      applicationType = null,
    },
    options = {}
  ) {
    return this.runWithOptionalTransaction(options, async (session) => {
      const filter = {
        shift: this.normalizeObjectId(shiftId, "shift ID"),
        status: {
          $in: ACTIVE_APPLICATION_STATUSES,
        },
      };

      if (applicationRound != null) {
        const round = Number(applicationRound);

        if (!Number.isSafeInteger(round) || round < 1 || round > MAX_APPLICATION_ROUNDS)
          throw this.createError({
            message: "Invalid application round.",
            code: "INVALID_APPLICATION_ROUND",
          });

        filter.applicationRound = round;
      }

      if (applicationType != null) {
        if (!["initial", "replacement"].includes(applicationType))
          throw this.createError({
            message: "Invalid application type.",
            code: "INVALID_APPLICATION_TYPE",
          });

        filter.applicationType = applicationType;
      }

      if (replacementForAssignmentId) {
        if (applicationType === "initial")
          throw this.createError({
            message: "Initial cleanup cannot target a replacement.",
            code: "INVALID_APPLICATION_CLEANUP_SCOPE",
          });

        filter.applicationType = "replacement";

        filter.replacementForAssignment = this.normalizeObjectId(
          replacementForAssignmentId,
          "replaced assignment ID"
        );

        filter.occurrence = occurrenceId
          ? this.normalizeObjectId(occurrenceId, "occurrence ID")
          : null;
      } else if (
        occurrenceId ||
        applicationType === "replacement" ||
        Number(applicationRound) > 1
      ) {
        throw this.createError({
          message: "Replacement cleanup requires the prior assignment ID.",
          code: "REPLACEMENT_ASSIGNMENT_ID_REQUIRED",
        });
      } else if (
        applicationRound != null ||
        applicationType === "initial" ||
        occurrenceId === null
      ) {
        filter.applicationType = "initial";
        filter.occurrence = null;
        filter.replacementForAssignment = null;
      }

      // With no opportunity selectors, this remains explicit whole-Shift expiry.
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
        shiftId: String(filter.shift),
        occurrenceId: filter.occurrence ? String(filter.occurrence) : null,
        replacementForAssignmentId: filter.replacementForAssignment
          ? String(filter.replacementForAssignment)
          : null,
        expiredApplicationCount: result.modifiedCount,
      };
    });
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
