// services/employerDelinquencyService.js

const mongoose = require("mongoose");

const ShiftOccurrence = require("../models/ShiftOccurrence");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");

const EMPLOYER_DELINQUENCY_SERVICE_ERROR_NAME = "EmployerDelinquencyServiceError";

const RESTRICTION_REASON = "overdue_overtime_topup";

/**
 * EMPLOYER DELINQUENCY ARCHITECTURE
 *
 * EmployerDelinquencyService owns employer-level restriction READ AUTHORITY.
 *
 * It answers:
 *
 * - whether an employer currently has a delinquency restriction;
 * - which occurrence obligations are causing that restriction;
 * - the total outstanding restricted amount; and
 * - whether the employer may create new Shift obligations.
 *
 * It does NOT own:
 *
 * - overtime approval;
 * - overtime top-up deadlines;
 * - overtime restriction triggering;
 * - overtime payment execution;
 * - settlement;
 * - refunds;
 * - professional claims;
 * - employer disputes;
 * - case adjudication; or
 * - wallet freezing.
 *
 * ShiftOccurrence is the authoritative source for the underlying unpaid
 * overtime obligation.
 *
 * ACTIVE RESTRICTION
 *
 * An occurrence currently restricts the employer only when ALL of the
 * following remain true:
 *
 * - overtime was requested;
 * - overtime is finally approved;
 * - overtime top-up is still unpaid;
 * - topUpRequired remains positive;
 * - no completed top-up transaction is attached; and
 * - overtime.restrictionTriggeredAt has been reached.
 *
 * restrictionTriggeredAt is historical audit.
 *
 * Therefore the existence of restrictionTriggeredAt alone MUST NOT continue
 * restricting the employer after the outstanding overtime top-up is paid.
 *
 * CONSEQUENCE
 *
 * First-level delinquency prevents the employer from creating NEW financial
 * obligations.
 *
 * It therefore blocks:
 *
 * - posting a new Shift; and
 * - accepting an application where that acceptance creates a new assignment
 *   obligation.
 *
 * It does NOT:
 *
 * - freeze the employer wallet;
 * - prevent payment of the outstanding amount;
 * - cancel existing Shifts;
 * - terminate existing assignments; or
 * - determine claim/dispute outcomes.
 */
class EmployerDelinquencyService {
  /* ─────────────────────────────── ERRORS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: EMPLOYER_DELINQUENCY_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });

    if (cause) {
      error.cause = cause;
    }

    return error;
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeObjectId(value, fieldName) {
    if (!value || !mongoose.isValidObjectId(value)) {
      throw EmployerDelinquencyService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw EmployerDelinquencyService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeAmount(value, fieldName) {
    const amount = Number(value ?? 0);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw EmployerDelinquencyService.createError({
        message: `${fieldName} must be a non-negative whole-number minor-unit amount.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return amount;
  }

  static addSafeAmount(total, amount, fieldName) {
    const normalizedAmount = EmployerDelinquencyService.normalizeAmount(amount, fieldName);

    const nextTotal = total + normalizedAmount;

    if (!Number.isSafeInteger(nextTotal)) {
      throw EmployerDelinquencyService.createError({
        message: `${fieldName} total exceeds the supported minor-unit range.`,
        code: "EMPLOYER_DELINQUENCY_AMOUNT_TOO_LARGE",
        statusCode: 500,
      });
    }

    return nextTotal;
  }

  /* ─────────────────────────────── ACTIVE RESTRICTION QUERY ─────────────────────────────── */

  static buildActiveRestrictionFilter({ businessId, currentTime }) {
    return {
      business: EmployerDelinquencyService.normalizeObjectId(businessId, "business ID"),

      "overtime.requested": true,

      "overtime.status": "approved",

      /*
       * restrictionTriggeredAt is historical.
       *
       * Current restriction therefore MUST also require the overtime funding
       * obligation to remain unpaid.
       */
      "overtime.topUpPaid": {
        $ne: true,
      },

      "overtime.restrictionTriggeredAt": {
        $ne: null,
        $lte: EmployerDelinquencyService.normalizeCurrentTime(currentTime),
      },

      topUpRequired: {
        $gt: 0,
      },

      topUpTransaction: null,
    };
  }

  static async getBlockingOccurrences({ businessId, currentTime = new Date() }, options = {}) {
    const now = EmployerDelinquencyService.normalizeCurrentTime(currentTime);

    const query = ShiftOccurrence.find(
      EmployerDelinquencyService.buildActiveRestrictionFilter({
        businessId,
        currentTime: now,
      })
    )
      .select(
        [
          "shift",
          "business",
          "branch",

          "referenceCode",
          "sequenceNumber",

          "assignedProfessional",

          "startTime",
          "endTime",

          "topUpRequired",
          "topUpTransaction",

          "overtime",
        ].join(" ")
      )
      .populate({
        path: "shift",

        select: ["referenceCode", "roleTitle", "scheduleMode"].join(" "),
      })
      .sort({
        "overtime.restrictionTriggeredAt": 1,
        "overtime.topUpOverdueAt": 1,
        startTime: 1,
        _id: 1,
      })
      .lean();

    if (options.session) {
      query.session(options.session);
    }

    return query;
  }

  /* ─────────────────────────────── STATE BUILDING ─────────────────────────────── */

  static buildBlockingOccurrence(occurrence) {
    const topUpRequired = EmployerDelinquencyService.normalizeAmount(
      occurrence.topUpRequired,
      "Outstanding overtime top-up"
    );

    if (topUpRequired <= 0) {
      throw EmployerDelinquencyService.createError({
        message:
          "A delinquency-blocking occurrence must contain a positive outstanding overtime top-up.",
        code: "INVALID_DELINQUENCY_BLOCKING_AMOUNT",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    const restrictionTriggeredAt = occurrence.overtime?.restrictionTriggeredAt || null;

    if (!restrictionTriggeredAt) {
      throw EmployerDelinquencyService.createError({
        message: "A delinquency-blocking occurrence is missing restrictionTriggeredAt.",
        code: "DELINQUENCY_RESTRICTION_TRIGGER_MISSING",
        statusCode: 500,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    return {
      occurrenceId: String(occurrence._id),

      occurrenceReferenceCode: occurrence.referenceCode,

      sequenceNumber: occurrence.sequenceNumber,

      shiftId: occurrence.shift?._id
        ? String(occurrence.shift._id)
        : occurrence.shift
          ? String(occurrence.shift)
          : null,

      shiftReferenceCode: occurrence.shift?.referenceCode || null,

      roleTitle: occurrence.shift?.roleTitle || null,

      scheduleMode: occurrence.shift?.scheduleMode || null,

      businessId: occurrence.business ? String(occurrence.business) : null,

      branchId: occurrence.branch ? String(occurrence.branch) : null,

      professionalId: occurrence.assignedProfessional
        ? String(occurrence.assignedProfessional)
        : null,

      startTime: occurrence.startTime || null,

      endTime: occurrence.endTime || null,

      topUpRequired,

      topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,

      topUpOverdueAt: occurrence.overtime?.topUpOverdueAt || null,

      restrictionTriggeredAt,

      overtimeStatus: occurrence.overtime?.status || null,

      topUpPaid: occurrence.overtime?.topUpPaid === true,

      topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,
    };
  }

  static async getRestrictionState({ businessId, currentTime = new Date() }, options = {}) {
    const normalizedBusinessId = EmployerDelinquencyService.normalizeObjectId(
      businessId,
      "business ID"
    );

    const now = EmployerDelinquencyService.normalizeCurrentTime(currentTime);

    const occurrences = await EmployerDelinquencyService.getBlockingOccurrences(
      {
        businessId: normalizedBusinessId,
        currentTime: now,
      },
      options
    );

    const blockingOccurrences = occurrences.map((occurrence) =>
      EmployerDelinquencyService.buildBlockingOccurrence(occurrence)
    );

    let totalOutstandingTopUp = 0;

    for (const occurrence of blockingOccurrences) {
      totalOutstandingTopUp = EmployerDelinquencyService.addSafeAmount(
        totalOutstandingTopUp,
        occurrence.topUpRequired,
        "Outstanding restricted overtime top-up"
      );
    }

    const oldestRestrictionTriggeredAt =
      blockingOccurrences.length > 0
        ? blockingOccurrences.reduce((oldest, occurrence) => {
            const triggeredAt = new Date(occurrence.restrictionTriggeredAt);

            if (Number.isNaN(triggeredAt.getTime())) {
              throw EmployerDelinquencyService.createError({
                message: "A delinquency restriction timestamp is invalid.",
                code: "INVALID_DELINQUENCY_RESTRICTION_TIMESTAMP",
                statusCode: 500,
                details: {
                  occurrenceId: occurrence.occurrenceId,
                },
              });
            }

            if (!oldest || triggeredAt < oldest) {
              return triggeredAt;
            }

            return oldest;
          }, null)
        : null;

    const restricted = blockingOccurrences.length > 0;

    return {
      businessId: String(normalizedBusinessId),

      status: restricted ? "restricted" : "clear",

      restricted,

      restrictionReason: restricted ? RESTRICTION_REASON : null,

      /*
       * Delinquency blocks NEW obligations only.
       *
       * Existing obligations, wallet use and overdue-payment resolution remain
       * available.
       */
      canCreateNewObligations: !restricted,

      canPostShifts: !restricted,

      blockingOccurrenceCount: blockingOccurrences.length,

      totalOutstandingTopUp,

      oldestRestrictionTriggeredAt,

      evaluatedAt: now,

      blockingOccurrences,
    };
  }

  /* ─────────────────────────────── NEW-OBLIGATION GUARD ─────────────────────────────── */

  static async assertCanCreateNewObligation(
    { businessId, currentTime = new Date() },
    options = {}
  ) {
    const restrictionState = await EmployerDelinquencyService.getRestrictionState(
      {
        businessId,
        currentTime,
      },
      options
    );

    if (restrictionState.restricted) {
      throw EmployerDelinquencyService.createError({
        message:
          "Please resolve the overdue overtime payment before creating another Shift obligation.",

        code: "EMPLOYER_NEW_OBLIGATIONS_RESTRICTED",

        statusCode: 403,

        details: {
          businessId: restrictionState.businessId,

          restrictionReason: restrictionState.restrictionReason,

          blockingOccurrenceCount: restrictionState.blockingOccurrenceCount,

          totalOutstandingTopUp: restrictionState.totalOutstandingTopUp,

          oldestRestrictionTriggeredAt: restrictionState.oldestRestrictionTriggeredAt,

          blockingOccurrences: restrictionState.blockingOccurrences,
        },
      });
    }

    return restrictionState;
  }

  /* ─────────────────────────────── SHIFT-POSTING GUARD ─────────────────────────────── */

  static async assertCanPostShifts({ businessId, currentTime = new Date() }, options = {}) {
    /*
     * Shift posting is one form of creating a new employer obligation.
     *
     * Keep one delinquency authority instead of maintaining a second posting-
     * specific rule set that could drift from application/assignment behavior.
     */
    return EmployerDelinquencyService.assertCanCreateNewObligation(
      {
        businessId,
        currentTime,
      },
      options
    );
  }
}

module.exports = EmployerDelinquencyService;
