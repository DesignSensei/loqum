// services/shiftOccurrenceReleaseService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const PlatformSettings = require("../models/PlatformSettings");

const WalletService = require("./walletService");
const ShiftOccurrenceReconciliationService = require("./shiftOccurrenceReconciliationService");

const logger = require("../utils/logger");

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

const MIN_RELEASE_REASON_LENGTH = 20;
const MAX_RELEASE_REASON_LENGTH = 500;

const DEFAULT_SINGLE_OCCURRENCE_RELEASE_NOTICE_HOURS = 72;
const DEFAULT_UNFILLED_FINALIZATION_GRACE_MINUTES = 15;

const RELEASE_ALLOWED_PARENT_STATUSES = Object.freeze([
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "disputed",
  "no_show",
]);

/**
 * SHIFT OCCURRENCE RELEASE ARCHITECTURE
 *
 * This service owns only the professional action:
 *
 *   "I can't work this occurrence"
 *
 * It does not end the professional's overall ShiftAssignment and does not
 * implement:
 *
 *   "I can't continue this Shift"
 *
 * The latter remains the existing assignment-tail exit/replacement workflow.
 *
 * RELEASE RESULT
 *
 * A valid release changes only the selected untouched future occurrence:
 *
 *   assigned -> replacement_required
 *
 * The occurrence's current operational assignment fields are cleared, while
 * the previous assignment is retained in replacementForAssignment for audit.
 * replacementCase remains null because an isolated occurrence release does not
 * require an assignment-exit case.
 *
 * The professional remains assigned to later occurrences owned by the same
 * continuing ShiftAssignment.
 *
 * NOTICE
 *
 * PlatformSettings.singleOccurrenceReleaseNoticeHours defines normal notice.
 * The default is 72 hours.
 *
 * A release inside that threshold is late notice, but it is still accepted.
 * Late notice is derived from timestamps and is not stored as a boolean.
 *
 * Once startTime is reached, ordinary occurrence release is no longer allowed.
 * Attendance/no-show processing owns the occurrence from that point onward.
 *
 * MARKETPLACE / REFUND
 *
 * The release does not refund the employer. It marks the occurrence
 * replacement_required so later marketplace/application work can expose this
 * date as a standalone replacement opportunity.
 *
 * If nobody is assigned before the occurrence reaches its unfilled
 * finalization deadline, the existing occurrence reconciliation/refund flow may
 * later finalize it as expired_unfilled.
 */
class ShiftOccurrenceReleaseService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    const error = new Error(message);

    error.name = "ShiftOccurrenceReleaseServiceError";
    error.code = code;
    error.statusCode = statusCode;

    if (details && typeof details === "object") {
      error.details = details;
    }

    return error;
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    return WalletService.runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeFieldCode(value) {
    return String(value)
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  static normalizeObjectId(value, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw ShiftOccurrenceReleaseService.createError({
        message: `${fieldName} is required.`,
        code: `${ShiftOccurrenceReleaseService.normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw ShiftOccurrenceReleaseService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${ShiftOccurrenceReleaseService.normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value) {
    const currentTime = value ? new Date(value) : new Date();

    if (Number.isNaN(currentTime.getTime())) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeReleaseReason(value) {
    const reason = String(value || "").trim();

    if (reason.length < MIN_RELEASE_REASON_LENGTH) {
      throw ShiftOccurrenceReleaseService.createError({
        message:
          `Occurrence release reason must contain at least ` +
          `${MIN_RELEASE_REASON_LENGTH} characters.`,
        code: "OCCURRENCE_RELEASE_REASON_TOO_SHORT",
      });
    }

    if (reason.length > MAX_RELEASE_REASON_LENGTH) {
      throw ShiftOccurrenceReleaseService.createError({
        message:
          `Occurrence release reason cannot exceed ` + `${MAX_RELEASE_REASON_LENGTH} characters.`,
        code: "OCCURRENCE_RELEASE_REASON_TOO_LONG",
      });
    }

    return reason;
  }

  static sameId(left, right) {
    if (!left || !right) {
      return false;
    }

    return String(left) === String(right);
  }

  /* ─────────────────────────────── SETTINGS ─────────────────────────────── */

  static async getPlatformSettings(session = null) {
    const query = PlatformSettings.findOne({
      key: "global",
      isActive: true,
    });

    if (session) {
      query.session(session);
    }

    const settings = await query;

    if (!settings) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "Active platform settings were not found.",
        code: "PLATFORM_SETTINGS_NOT_FOUND",
        statusCode: 500,
      });
    }

    return settings;
  }

  static getReleaseSettings(settings) {
    const noticeHours = Number(
      settings.singleOccurrenceReleaseNoticeHours ?? DEFAULT_SINGLE_OCCURRENCE_RELEASE_NOTICE_HOURS
    );

    if (!Number.isSafeInteger(noticeHours) || noticeHours < 0) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "singleOccurrenceReleaseNoticeHours must be a non-negative whole number.",
        code: "INVALID_SINGLE_OCCURRENCE_RELEASE_NOTICE_HOURS",
        statusCode: 500,
      });
    }

    const finalizationGraceMinutes = Number(
      settings.unfilledFinalizationGraceMinutes ?? DEFAULT_UNFILLED_FINALIZATION_GRACE_MINUTES
    );

    if (!Number.isSafeInteger(finalizationGraceMinutes) || finalizationGraceMinutes <= 0) {
      throw ShiftOccurrenceReleaseService.createError({
        message:
          "unfilledFinalizationGraceMinutes must be a positive whole number for occurrence release.",
        code: "INVALID_UNFILLED_FINALIZATION_GRACE_MINUTES",
        statusCode: 500,
      });
    }

    return {
      noticeHours,
      finalizationGraceMinutes,
    };
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getShift(shiftId, session = null) {
    const normalizedShiftId = ShiftOccurrenceReleaseService.normalizeObjectId(shiftId, "shift ID");

    const query = Shift.findById(normalizedShiftId);

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "Shift was not found.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getOccurrence({ shiftId, occurrenceId, session = null }) {
    const normalizedShiftId = ShiftOccurrenceReleaseService.normalizeObjectId(shiftId, "shift ID");

    const normalizedOccurrenceId = ShiftOccurrenceReleaseService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = ShiftOccurrence.findOne({
      _id: normalizedOccurrenceId,
      shift: normalizedShiftId,
    });

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  /* ─────────────────────────────── RELEASE ELIGIBILITY ─────────────────────────────── */

  static assertOccurrenceBelongsToShift({ shift, occurrence }) {
    if (!ShiftOccurrenceReleaseService.sameId(occurrence.shift, shift._id)) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The occurrence does not belong to the supplied Shift.",
        code: "OCCURRENCE_SHIFT_MISMATCH",
        statusCode: 409,
      });
    }

    if (!ShiftOccurrenceReleaseService.sameId(occurrence.business, shift.business)) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The occurrence business does not match the parent Shift.",
        code: "OCCURRENCE_BUSINESS_MISMATCH",
        statusCode: 409,
      });
    }

    if (!ShiftOccurrenceReleaseService.sameId(occurrence.branch, shift.branch)) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The occurrence branch does not match the parent Shift.",
        code: "OCCURRENCE_BRANCH_MISMATCH",
        statusCode: 409,
      });
    }
  }

  static assertProfessionalOwnsOccurrence({ occurrence, professionalId }) {
    const professionalObjectId = ShiftOccurrenceReleaseService.normalizeObjectId(
      professionalId,
      "professional ID"
    );

    if (
      !occurrence.assignedProfessional ||
      !ShiftOccurrenceReleaseService.sameId(occurrence.assignedProfessional, professionalObjectId)
    ) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "You are not assigned to this occurrence.",
        code: "PROFESSIONAL_NOT_ASSIGNED_TO_OCCURRENCE",
        statusCode: 403,
      });
    }

    return professionalObjectId;
  }

  static assertOccurrenceCanBeReleased({ shift, occurrence, currentTime }) {
    if (!RELEASE_ALLOWED_PARENT_STATUSES.includes(shift.status)) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "This Shift is not available for occurrence release.",
        code: "SHIFT_NOT_AVAILABLE_FOR_OCCURRENCE_RELEASE",
        statusCode: 409,
        details: {
          shiftStatus: shift.status,
        },
      });
    }

    if (occurrence.assignmentStatus === "replacement_required") {
      throw ShiftOccurrenceReleaseService.createError({
        message: "This occurrence has already been released for replacement.",
        code: "OCCURRENCE_ALREADY_REQUIRES_REPLACEMENT",
        statusCode: 409,
      });
    }

    if (occurrence.assignmentStatus !== "assigned") {
      throw ShiftOccurrenceReleaseService.createError({
        message: "Only an assigned occurrence can be released by a professional.",
        code: "OCCURRENCE_NOT_ASSIGNED",
        statusCode: 409,
      });
    }

    if (!occurrence.assignedProfessional || !occurrence.assignment || !occurrence.assignedAt) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The occurrence assignment record is incomplete.",
        code: "OCCURRENCE_ASSIGNMENT_INCOMPLETE",
        statusCode: 409,
      });
    }

    if (occurrence.status !== "scheduled") {
      throw ShiftOccurrenceReleaseService.createError({
        message: "Only a scheduled occurrence can be released.",
        code: "OCCURRENCE_NOT_SCHEDULED",
        statusCode: 409,
        details: {
          occurrenceStatus: occurrence.status,
        },
      });
    }

    if (
      occurrence.attendanceStatus !== "not_started" ||
      occurrence.settlementStatus !== "not_due" ||
      occurrence.checkedInAt ||
      occurrence.checkedOutAt ||
      occurrence.checkInPinUsedAt ||
      occurrence.checkOutPinUsedAt
    ) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "An occurrence with attendance or settlement activity cannot be released.",
        code: "OCCURRENCE_RELEASE_ACTIVITY_ALREADY_STARTED",
        statusCode: 409,
      });
    }

    const startTime = new Date(occurrence.startTime);

    if (Number.isNaN(startTime.getTime())) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The occurrence start time is invalid.",
        code: "INVALID_OCCURRENCE_START_TIME",
        statusCode: 500,
      });
    }

    if (currentTime >= startTime) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "This occurrence has already started. Attendance and no-show rules now apply.",
        code: "OCCURRENCE_ALREADY_STARTED",
        statusCode: 409,
      });
    }

    if (!occurrence.fillCutoffAt) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The occurrence fill cutoff is missing.",
        code: "OCCURRENCE_FILL_CUTOFF_MISSING",
        statusCode: 500,
      });
    }

    if (occurrence.refundStatus !== "not_eligible") {
      throw ShiftOccurrenceReleaseService.createError({
        message: "An occurrence already in the refund workflow cannot be released.",
        code: "OCCURRENCE_REFUND_ALREADY_STARTED",
        statusCode: 409,
      });
    }
  }

  static async assertProfessionalContinuesAfterOccurrence({
    shift,
    occurrence,
    professionalId,
    session,
  }) {
    const laterOccurrence = await ShiftOccurrence.findOne({
      shift: shift._id,

      sequenceNumber: {
        $gt: occurrence.sequenceNumber,
      },

      assignmentStatus: "assigned",

      assignedProfessional: professionalId,

      assignment: occurrence.assignment,

      status: "scheduled",
    })
      .select("_id sequenceNumber startTime")
      .sort({
        sequenceNumber: 1,
      })
      .session(session);

    if (!laterOccurrence) {
      throw ShiftOccurrenceReleaseService.createError({
        message:
          "There is no later occurrence remaining under this assignment. Use the cannot-continue Shift flow instead.",
        code: "OCCURRENCE_RELEASE_REQUIRES_CONTINUING_ASSIGNMENT",
        statusCode: 409,
      });
    }

    return laterOccurrence;
  }

  /* ─────────────────────────────── NOTICE / DEADLINES ─────────────────────────────── */

  static buildNoticeSummary({ occurrence, currentTime, noticeHours }) {
    const startTime = new Date(occurrence.startTime);

    const normalNoticeCutoffAt = new Date(
      startTime.getTime() - noticeHours * MILLISECONDS_PER_HOUR
    );

    const millisecondsBeforeStart = startTime.getTime() - currentTime.getTime();

    const hoursBeforeStart = millisecondsBeforeStart / MILLISECONDS_PER_HOUR;

    const isLateNotice = currentTime > normalNoticeCutoffAt;

    return {
      noticeThresholdHours: noticeHours,
      normalNoticeCutoffAt,
      hoursBeforeStart,
      isLateNotice,
    };
  }

  static calculateUnfilledFinalizationAt({ occurrence, finalizationGraceMinutes }) {
    return ShiftOccurrenceReconciliationService.calculateUnfilledFinalizationAt({
      fillCutoffAt: occurrence.fillCutoffAt,
      graceMinutes: finalizationGraceMinutes,
    });
  }

  /* ─────────────────────────────── PARENT ASSIGNMENT PROGRESS ─────────────────────────────── */

  static async refreshParentAssignmentProgress({ shift, currentTime, session }) {
    const rows = await ShiftOccurrence.aggregate([
      {
        $match: {
          shift: shift._id,
        },
      },
      {
        $group: {
          _id: "$assignmentStatus",
          count: {
            $sum: 1,
          },
        },
      },
    ]).session(session);

    const counts = {
      unassigned: 0,
      assigned: 0,
      replacement_required: 0,
      expired_unfilled: 0,
    };

    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(counts, row._id)) {
        counts[row._id] = Number(row.count || 0);
      }
    }

    const totalCount = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);

    const expectedCount = Number(shift.occurrenceCount || 0);

    if (Number.isSafeInteger(expectedCount) && expectedCount > 0 && totalCount !== expectedCount) {
      throw ShiftOccurrenceReleaseService.createError({
        message: "The parent Shift occurrence assignment counts are inconsistent.",
        code: "SHIFT_OCCURRENCE_ASSIGNMENT_COUNT_MISMATCH",
        statusCode: 500,
        details: {
          expectedCount,
          actualCount: totalCount,
        },
      });
    }

    await Shift.updateOne(
      {
        _id: shift._id,
      },
      {
        $set: {
          "occurrenceProgress.unassigned": counts.unassigned,

          "occurrenceProgress.assigned": counts.assigned,

          "occurrenceProgress.replacementRequired": counts.replacement_required,

          "occurrenceProgress.expiredUnfilled": counts.expired_unfilled,

          "occurrenceProgress.lastReconciledAt": currentTime,
        },
      },
      {
        session,
      }
    );

    return {
      unassigned: counts.unassigned,
      assigned: counts.assigned,
      replacementRequired: counts.replacement_required,
      expiredUnfilled: counts.expired_unfilled,
      lastReconciledAt: currentTime,
    };
  }

  /* ─────────────────────────────── RELEASE ─────────────────────────────── */

  static async releaseOccurrence(
    { shiftId, occurrenceId, professionalId, reason, currentTime = new Date() },
    options = {}
  ) {
    const now = ShiftOccurrenceReleaseService.normalizeCurrentTime(currentTime);

    const normalizedReason = ShiftOccurrenceReleaseService.normalizeReleaseReason(reason);

    return ShiftOccurrenceReleaseService.runWithOptionalTransaction(
      options,

      async (session) => {
        const shift = await ShiftOccurrenceReleaseService.getShift(shiftId, session);

        const occurrence = await ShiftOccurrenceReleaseService.getOccurrence({
          shiftId: shift._id,
          occurrenceId,
          session,
        });

        ShiftOccurrenceReleaseService.assertOccurrenceBelongsToShift({
          shift,
          occurrence,
        });

        const professionalObjectId = ShiftOccurrenceReleaseService.assertProfessionalOwnsOccurrence(
          {
            occurrence,
            professionalId,
          }
        );

        ShiftOccurrenceReleaseService.assertOccurrenceCanBeReleased({
          shift,
          occurrence,
          currentTime: now,
        });

        const laterOccurrence =
          await ShiftOccurrenceReleaseService.assertProfessionalContinuesAfterOccurrence({
            shift,
            occurrence,
            professionalId: professionalObjectId,
            session,
          });

        const settings = await ShiftOccurrenceReleaseService.getPlatformSettings(session);

        const { noticeHours, finalizationGraceMinutes } =
          ShiftOccurrenceReleaseService.getReleaseSettings(settings);

        const notice = ShiftOccurrenceReleaseService.buildNoticeSummary({
          occurrence,
          currentTime: now,
          noticeHours,
        });

        const unfilledFinalizationAt =
          ShiftOccurrenceReleaseService.calculateUnfilledFinalizationAt({
            occurrence,
            finalizationGraceMinutes,
          });

        const previousAssignment = occurrence.assignment;

        occurrence.assignmentStatus = "replacement_required";

        occurrence.assignedProfessional = null;
        occurrence.assignment = null;
        occurrence.assignedAt = null;

        occurrence.replacementRequiredAt = now;

        occurrence.replacementForAssignment = previousAssignment;

        occurrence.replacementCase = null;

        occurrence.replacementReasonCode = "release_request";

        occurrence.replacementReasonDetails = normalizedReason;

        occurrence.unfilledFinalizationAt = unfilledFinalizationAt;

        await occurrence.save({
          session,
        });

        const occurrenceProgress =
          await ShiftOccurrenceReleaseService.refreshParentAssignmentProgress({
            shift,
            currentTime: now,
            session,
          });

        const refreshedShift = await Shift.findById(shift._id).session(session);

        const events = [
          {
            type: "shift_occurrence_released",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(professionalObjectId),

            sequenceNumber: occurrence.sequenceNumber,

            replacementForAssignmentId: String(previousAssignment),

            releasedAt: now,

            reasonCode: "release_request",

            isLateNotice: notice.isLateNotice,
          },

          {
            type: "shift_occurrence_replacement_required",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            sequenceNumber: occurrence.sequenceNumber,

            replacementForAssignmentId: String(previousAssignment),

            fillCutoffAt: occurrence.fillCutoffAt,

            unfilledFinalizationAt,
          },
        ];

        if (notice.isLateNotice) {
          events.push({
            type: "shift_occurrence_release_late_notice",

            shiftId: String(shift._id),

            occurrenceId: String(occurrence._id),

            professionalId: String(professionalObjectId),

            sequenceNumber: occurrence.sequenceNumber,

            noticeThresholdHours: notice.noticeThresholdHours,

            normalNoticeCutoffAt: notice.normalNoticeCutoffAt,

            releasedAt: now,
          });
        }

        logger.info(
          `Professional ${professionalObjectId} released occurrence ${occurrence.referenceCode} from shift ${shift.referenceCode}; replacement required`
        );

        const marketplaceRepopulationRequired = now < new Date(occurrence.fillCutoffAt);

        return {
          shift: refreshedShift,

          occurrence,

          released: true,

          notice,

          replacement: {
            replacementForAssignment: previousAssignment,

            replacementCase: null,

            replacementReasonCode: "release_request",

            unfilledFinalizationAt,
          },

          continuingAssignment: {
            assignment: previousAssignment,

            nextOccurrenceId: String(laterOccurrence._id),

            nextSequenceNumber: laterOccurrence.sequenceNumber,

            nextStartTime: laterOccurrence.startTime,
          },

          occurrenceProgress,

          marketplaceRepopulationRequired,

          events,
        };
      }
    );
  }
}

module.exports = ShiftOccurrenceReleaseService;
