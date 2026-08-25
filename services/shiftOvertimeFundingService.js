// services/shiftOvertimeFundingService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const Transaction = require("../models/Transaction");
const PlatformSettings = require("../models/PlatformSettings");

const WalletService = require("./walletService");
const ShiftPlatformFeeService = require("./shiftPlatformFeeService");
const ShiftSettlementService = require("./shiftSettlementService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const money = require("../utils/money");
const logger = require("../utils/logger");

const SHIFT_OVERTIME_FUNDING_SERVICE_ERROR_NAME = "ShiftOvertimeFundingServiceError";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

const DEFAULT_OVERTIME_TOPUP_DEADLINE_HOURS = 24;
const DEFAULT_OVERTIME_TOPUP_RESTRICTION_GRACE_HOURS = 72;

const DEFAULT_PROCESSING_BATCH_LIMIT = 100;
const MAX_PROCESSING_BATCH_LIMIT = 500;

const OVERTIME_TOPUP_TRANSACTION_TYPE = "shift_topup";
const OVERTIME_TOPUP_TRANSACTION_PURPOSE = "shift_overtime_topup";

const OVERTIME_TOPUP_ALLOWED_PAYMENT_RAILS = Object.freeze(["wallet_balance", "paystack_checkout"]);

/**
 * SHIFT OVERTIME FUNDING AUTHORITY
 *
 * ShiftOvertimeFundingService owns the employer funding obligation that exists
 * only AFTER overtime entitlement has become finally approved.
 *
 * It owns:
 *
 * - final OT top-up amount;
 * - top-up deadline;
 * - outstanding topUpRequired;
 * - overdue timing;
 * - the 72-hour restriction grace calculation;
 * - restrictionTriggeredAt;
 * - completed OT top-up transaction verification;
 * - topUpPaid / topUpPaidAt / topUpTransaction; and
 * - handoff of funded OT to professional settlement.
 *
 * It does NOT own:
 *
 * - OT request creation;
 * - employer OT approval/rejection;
 * - professional OT appeal;
 * - admin OT adjudication;
 * - OT professional-pay pricing;
 * - OT platform-fee earning/pricing;
 * - professional payout execution; or
 * - employer refund authority.
 *
 * FUNDING REQUIREMENT
 *
 * Final approved OT creates:
 *
 *   overtimeProfessionalPay
 *   + overtimePlatformFee
 *   = overtime.topUpAmount
 *
 * overtimeProfessionalPay is owned by ShiftOvertimeService.
 *
 * overtimePlatformFee is owned by ShiftPlatformFeeService.
 *
 * This service does not independently recalculate either amount. It verifies
 * those upstream authorities and combines their integer minor-unit amounts.
 *
 * Until funded:
 *
 *   topUpRequired = overtime.topUpAmount
 *
 * After funding:
 *
 *   topUpRequired = 0
 *
 * DELINQUENCY
 *
 * Final approval
 * -> topUpDeadlineAt
 * -> missed deadline => topUpOverdueAt
 * -> still unpaid after overtimeTopUpRestrictionGraceHours
 * -> restrictionTriggeredAt
 *
 * These dates are historical audit and are NOT cleared after payment.
 * Current restriction is derived elsewhere from an unresolved approved OT debt
 * plus restrictionTriggeredAt.
 *
 * APPROVAL ORCHESTRATION
 *
 * ShiftOvertimeService stages final OT professional pay.
 * ShiftPlatformFeeService stages the earned OT fee.
 * This service stages the top-up obligation on the SAME loaded occurrence.
 *
 * establishApprovedOvertimeFunding() therefore deliberately DOES NOT save.
 * The final-approval orchestrator saves the complete authority atomically.
 *
 * FUNDING CONFIRMATION
 *
 * The top-up transaction itself has already placed the full amount into escrow.
 * This service verifies that transaction, records the funding fact, then asks
 * ShiftPlatformFeeService to collect Loqum's already-earned OT fee.
 *
 * The professional portion remains protected in escrow for settlement.
 *
 * After the funding and fee-collection facts are complete,
 * ShiftSettlementService owns component-specific professional payout
 * readiness.
 */

class ShiftOvertimeFundingService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: SHIFT_OVERTIME_FUNDING_SERVICE_ERROR_NAME,
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

  static async transaction(options = {}, callback) {
    return runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeObjectId(value, fieldName) {
    const fieldCode = normalizeFieldCode(fieldName);

    if (!value || !mongoose.isValidObjectId(value)) {
      throw ShiftOvertimeFundingService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeDate(value, fieldName = "date") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(date.getTime())) {
      throw ShiftOvertimeFundingService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return date;
  }

  static normalizePositiveAmount(value, fieldName) {
    try {
      return money.normalizePositiveMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw ShiftOvertimeFundingService.createError({
        message: `${fieldName} must be a positive whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
        cause: error,
      });
    }
  }

  static normalizeNonNegativeAmount(value, fieldName) {
    try {
      return money.normalizeMinorUnitAmount(value ?? 0, fieldName);
    } catch (error) {
      throw ShiftOvertimeFundingService.createError({
        message: `${fieldName} must be a non-negative whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
        cause: error,
      });
    }
  }

  static normalizeBatchLimit(value) {
    const limit = Number(value || DEFAULT_PROCESSING_BATCH_LIMIT);

    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PROCESSING_BATCH_LIMIT) {
      throw ShiftOvertimeFundingService.createError({
        message: `Processing batch limit must be between 1 and ${MAX_PROCESSING_BATCH_LIMIT}.`,
        code: "INVALID_OVERTIME_FUNDING_BATCH_LIMIT",
      });
    }

    return limit;
  }

  static normalizeInitiatedBy(value) {
    const initiatedBy = value || {
      role: "system",
      userId: null,
    };

    const role = String(initiatedBy.role || "system")
      .trim()
      .toLowerCase();

    if (!["system", "employer", "admin"].includes(role)) {
      throw ShiftOvertimeFundingService.createError({
        message: "Overtime funding initiator role is invalid.",
        code: "INVALID_OVERTIME_FUNDING_INITIATOR_ROLE",
      });
    }

    let userId = null;

    if (initiatedBy.userId) {
      userId = ShiftOvertimeFundingService.normalizeObjectId(
        initiatedBy.userId,
        "overtime funding initiator user ID"
      );
    }

    if (role !== "system" && !userId) {
      throw ShiftOvertimeFundingService.createError({
        message: "A user ID is required when a user initiates overtime funding processing.",
        code: "OVERTIME_FUNDING_INITIATOR_USER_ID_REQUIRED",
      });
    }

    if (role === "system") {
      userId = null;
    }

    return {
      role,
      userId,
    };
  }

  /* ─────────────────────────────── SETTINGS / LOADERS ─────────────────────────────── */

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
      throw ShiftOvertimeFundingService.createError({
        message: "Active platform settings were not found.",
        code: "PLATFORM_SETTINGS_NOT_FOUND",
        statusCode: 500,
      });
    }

    return settings;
  }

  static getOvertimeTopUpDeadlineHours(settings) {
    const hours = Number(
      settings?.overtimeTopUpDeadlineHours ?? DEFAULT_OVERTIME_TOPUP_DEADLINE_HOURS
    );

    if (!Number.isSafeInteger(hours) || hours <= 0) {
      throw ShiftOvertimeFundingService.createError({
        message: "overtimeTopUpDeadlineHours must be a positive whole number.",
        code: "INVALID_OVERTIME_TOPUP_DEADLINE_HOURS",
        statusCode: 500,
      });
    }

    return hours;
  }

  static getOvertimeTopUpRestrictionGraceHours(settings) {
    const hours = Number(
      settings?.overtimeTopUpRestrictionGraceHours ?? DEFAULT_OVERTIME_TOPUP_RESTRICTION_GRACE_HOURS
    );

    if (!Number.isSafeInteger(hours) || hours <= 0) {
      throw ShiftOvertimeFundingService.createError({
        message: "overtimeTopUpRestrictionGraceHours must be a positive whole number.",
        code: "INVALID_OVERTIME_TOPUP_RESTRICTION_GRACE_HOURS",
        statusCode: 500,
      });
    }

    return hours;
  }

  static async getOccurrence(occurrenceId, session = null) {
    const normalizedOccurrenceId = ShiftOvertimeFundingService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = ShiftOccurrence.findById(normalizedOccurrenceId);

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftOvertimeFundingService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static async getShift(shiftId, session = null) {
    const normalizedShiftId = ShiftOvertimeFundingService.normalizeObjectId(shiftId, "shift ID");

    const query = Shift.findById(normalizedShiftId).select(
      "referenceCode business countryCode currency"
    );

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftOvertimeFundingService.createError({
        message: "The parent Shift was not found.",
        code: "PARENT_SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  /* ─────────────────────────────── AUTHORITY VALIDATION ─────────────────────────────── */

  static assertCompleteAssignment(occurrence) {
    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignedProfessional ||
      !occurrence.assignment ||
      !occurrence.assignedAt
    ) {
      throw ShiftOvertimeFundingService.createError({
        message: "Overtime funding requires a complete professional assignment.",
        code: "OCCURRENCE_ASSIGNMENT_INCOMPLETE",
        statusCode: 409,
      });
    }

    return occurrence;
  }

  static assertFinalApprovedOvertime(occurrence) {
    const overtime = occurrence?.overtime || {};

    if (
      overtime.requested !== true ||
      overtime.status !== "approved" ||
      !overtime.approvedAt ||
      !overtime.approvedBy ||
      !overtime.decisionSource
    ) {
      throw ShiftOvertimeFundingService.createError({
        message: "Overtime funding may only be established after final overtime approval.",
        code: "OVERTIME_ENTITLEMENT_NOT_FINAL",
        statusCode: 409,
      });
    }

    return overtime;
  }

  static getFundingRequirement(occurrence) {
    ShiftOvertimeFundingService.assertFinalApprovedOvertime(occurrence);

    /*
     * ShiftPlatformFeeService owns overtime platform-fee pricing.
     *
     * Funding must not independently recalculate:
     *
     *   professionalPay × platformFeeRate
     *
     * Ask the fee authority to verify its own amount instead.
     */
    let authoritativeFee;

    try {
      authoritativeFee = ShiftPlatformFeeService.assertOvertimeFeeAmountIsAuthoritative(occurrence);
    } catch (error) {
      if (error?.name === "ShiftPlatformFeeServiceError") {
        throw ShiftOvertimeFundingService.createError({
          message: error.message,
          code: error.code || "OVERTIME_PLATFORM_FEE_MISMATCH",
          statusCode: error.statusCode || 500,
          details: error.details && typeof error.details === "object" ? error.details : null,
          cause: error,
        });
      }

      throw error;
    }

    const professionalPay = ShiftOvertimeFundingService.normalizePositiveAmount(
      authoritativeFee.overtimeProfessionalPay,
      "overtime professional pay"
    );

    const platformFee = ShiftOvertimeFundingService.normalizeNonNegativeAmount(
      authoritativeFee.expectedFee,
      "overtime platform fee"
    );

    const feeAudit = occurrence.overtimePlatformFeeAudit || {};

    if (platformFee > 0) {
      if (!feeAudit.earnedAt) {
        throw ShiftOvertimeFundingService.createError({
          message:
            "The overtime platform fee must be earned before the employer top-up obligation is established.",
          code: "OVERTIME_PLATFORM_FEE_NOT_EARNED",
          statusCode: 500,
        });
      }

      const earnedAt = ShiftOvertimeFundingService.normalizeDate(
        feeAudit.earnedAt,
        "overtime platform fee earned time"
      );

      const approvedAt = ShiftOvertimeFundingService.normalizeDate(
        occurrence.overtime.approvedAt,
        "overtime approval time"
      );

      if (earnedAt.getTime() !== approvedAt.getTime()) {
        throw ShiftOvertimeFundingService.createError({
          message: "The overtime platform-fee earning time does not match final overtime approval.",
          code: "OVERTIME_PLATFORM_FEE_EARNING_TIME_MISMATCH",
          statusCode: 500,
        });
      }
    } else if (
      feeAudit.earnedAt ||
      feeAudit.outstandingAt ||
      feeAudit.collectedAt ||
      feeAudit.collectionTransaction
    ) {
      throw ShiftOvertimeFundingService.createError({
        message: "Zero overtime platform fee cannot contain platform-fee audit data.",
        code: "ZERO_OVERTIME_PLATFORM_FEE_AUDIT_INVALID",
        statusCode: 500,
      });
    }

    let fundingRequirement;

    try {
      fundingRequirement = money.sumMinorUnitAmounts(
        [professionalPay, platformFee],
        "Final overtime funding requirement"
      );
    } catch (error) {
      throw ShiftOvertimeFundingService.createError({
        message: "The final overtime funding requirement is invalid or too large.",
        code: "INVALID_OVERTIME_FUNDING_REQUIREMENT",
        statusCode: 500,
        cause: error,
      });
    }

    if (fundingRequirement <= 0) {
      throw ShiftOvertimeFundingService.createError({
        message: "The final overtime funding requirement must be greater than zero.",
        code: "INVALID_OVERTIME_FUNDING_REQUIREMENT",
        statusCode: 500,
      });
    }

    return {
      professionalPay,
      platformFee,
      fundingRequirement,
    };
  }

  static assertOutstandingFundingState(occurrence) {
    const { fundingRequirement } = ShiftOvertimeFundingService.getFundingRequirement(occurrence);

    const overtime = occurrence.overtime || {};

    if (overtime.topUpPaid === true || overtime.topUpPaidAt || occurrence.topUpTransaction) {
      throw ShiftOvertimeFundingService.createError({
        message: "This overtime top-up has already been funded.",
        code: "OVERTIME_TOPUP_ALREADY_FUNDED",
        statusCode: 409,
      });
    }

    let topUpAmount;
    let topUpRequired;

    try {
      topUpAmount = ShiftOvertimeFundingService.normalizePositiveAmount(
        overtime.topUpAmount,
        "overtime top-up amount"
      );

      topUpRequired = ShiftOvertimeFundingService.normalizePositiveAmount(
        occurrence.topUpRequired,
        "outstanding overtime top-up"
      );
    } catch (error) {
      if (error?.name === SHIFT_OVERTIME_FUNDING_SERVICE_ERROR_NAME) {
        throw ShiftOvertimeFundingService.createError({
          message: "The approved overtime top-up obligation is incomplete or inconsistent.",
          code: "OVERTIME_TOPUP_AUTHORITY_INCOMPLETE",
          statusCode: 500,
          details: {
            expectedAmount: fundingRequirement,

            topUpAmount: Number(overtime.topUpAmount || 0),

            topUpRequired: Number(occurrence.topUpRequired || 0),
          },
          cause: error,
        });
      }

      throw error;
    }

    if (
      topUpAmount !== fundingRequirement ||
      topUpRequired !== fundingRequirement ||
      !overtime.topUpDeadlineAt
    ) {
      throw ShiftOvertimeFundingService.createError({
        message: "The approved overtime top-up obligation is incomplete or inconsistent.",
        code: "OVERTIME_TOPUP_AUTHORITY_INCOMPLETE",
        statusCode: 500,
        details: {
          expectedAmount: fundingRequirement,
          topUpAmount,
          topUpRequired,
        },
      });
    }

    return {
      fundingRequirement,

      topUpDeadlineAt: ShiftOvertimeFundingService.normalizeDate(
        overtime.topUpDeadlineAt,
        "overtime top-up deadline"
      ),
    };
  }

  static synchronizeOutstandingSettlementStatus(occurrence) {
    if (occurrence.activeClaim || occurrence.activeDispute) {
      occurrence.settlementStatus = "disputed";
    } else {
      occurrence.settlementStatus = "awaiting_topup";
    }

    return occurrence.settlementStatus;
  }

  /* ─────────────────────────────── ESTABLISH TOP-UP ─────────────────────────────── */

  /**
   * Stage the funding obligation for newly approved OT.
   *
   * IMPORTANT: this method does not save the occurrence.
   *
   * ShiftOvertimeService owns final-approval orchestration and saves the
   * complete OT decision + professional pay + fee + funding obligation once.
   */
  static async establishApprovedOvertimeFunding({ occurrence, establishedAt, session = null }) {
    if (!occurrence || typeof occurrence.set !== "function") {
      throw ShiftOvertimeFundingService.createError({
        message: "establishApprovedOvertimeFunding requires a loaded ShiftOccurrence document.",
        code: "SHIFT_OCCURRENCE_DOCUMENT_REQUIRED",
        statusCode: 500,
      });
    }

    ShiftOvertimeFundingService.assertCompleteAssignment(occurrence);

    const overtime = ShiftOvertimeFundingService.assertFinalApprovedOvertime(occurrence);

    const approvedAt = ShiftOvertimeFundingService.normalizeDate(
      overtime.approvedAt,
      "overtime approval time"
    );

    const normalizedEstablishedAt = ShiftOvertimeFundingService.normalizeDate(
      establishedAt || approvedAt,
      "overtime funding obligation establishment time"
    );

    if (normalizedEstablishedAt.getTime() !== approvedAt.getTime()) {
      throw ShiftOvertimeFundingService.createError({
        message: "The overtime top-up obligation must be established at final overtime approval.",
        code: "OVERTIME_TOPUP_ESTABLISHMENT_TIME_MISMATCH",
        statusCode: 409,
      });
    }

    const { fundingRequirement } = ShiftOvertimeFundingService.getFundingRequirement(occurrence);

    const settings = await ShiftOvertimeFundingService.getPlatformSettings(session);

    const deadlineHours = ShiftOvertimeFundingService.getOvertimeTopUpDeadlineHours(settings);

    const expectedDeadline = new Date(approvedAt.getTime() + deadlineHours * MILLISECONDS_PER_HOUR);

    const existingHasFundingAuthority = Boolean(
      Number(overtime.topUpAmount || 0) > 0 ||
      overtime.topUpDeadlineAt ||
      overtime.topUpPaid === true ||
      overtime.topUpPaidAt ||
      Number(occurrence.topUpRequired || 0) > 0 ||
      occurrence.topUpTransaction ||
      overtime.topUpOverdueAt ||
      overtime.restrictionTriggeredAt
    );

    if (existingHasFundingAuthority) {
      const matchesUnfundedAuthority =
        overtime.topUpPaid !== true &&
        !overtime.topUpPaidAt &&
        !occurrence.topUpTransaction &&
        !overtime.topUpOverdueAt &&
        !overtime.restrictionTriggeredAt &&
        Number(overtime.topUpAmount || 0) === fundingRequirement &&
        Number(occurrence.topUpRequired || 0) === fundingRequirement &&
        overtime.topUpDeadlineAt &&
        new Date(overtime.topUpDeadlineAt).getTime() === expectedDeadline.getTime();

      if (!matchesUnfundedAuthority) {
        throw ShiftOvertimeFundingService.createError({
          message:
            "Existing overtime funding authority conflicts with the newly approved overtime obligation.",
          code: "OVERTIME_TOPUP_AUTHORITY_CONFLICT",
          statusCode: 409,
        });
      }

      ShiftOvertimeFundingService.synchronizeOutstandingSettlementStatus(occurrence);

      return {
        occurrence,
        fundingRequirement,
        topUpDeadlineAt: expectedDeadline,
        idempotent: true,
      };
    }

    occurrence.set("overtime.topUpAmount", fundingRequirement);

    occurrence.set("overtime.topUpDeadlineAt", expectedDeadline);

    occurrence.set("overtime.topUpOverdueAt", null);

    occurrence.set("overtime.restrictionTriggeredAt", null);

    occurrence.set("overtime.topUpPaid", false);

    occurrence.set("overtime.topUpPaidAt", null);

    occurrence.topUpRequired = fundingRequirement;

    occurrence.topUpTransaction = null;

    ShiftOvertimeFundingService.synchronizeOutstandingSettlementStatus(occurrence);

    return {
      occurrence,
      fundingRequirement,
      topUpDeadlineAt: expectedDeadline,
      idempotent: false,
    };
  }

  /* ─────────────────────────────── OVERDUE ─────────────────────────────── */

  static async markOvertimeTopUpOverdue({ occurrenceId, currentTime = new Date() }, options = {}) {
    const now = ShiftOvertimeFundingService.normalizeDate(
      currentTime,
      "overtime top-up overdue processing time"
    );

    return ShiftOvertimeFundingService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeFundingService.getOccurrence(occurrenceId, session);

      ShiftOvertimeFundingService.assertCompleteAssignment(occurrence);

      if (
        occurrence.overtime?.requested !== true ||
        occurrence.overtime?.status !== "approved" ||
        occurrence.overtime?.topUpPaid === true ||
        occurrence.topUpTransaction ||
        Number(occurrence.topUpRequired || 0) <= 0
      ) {
        return {
          occurrence,
          overdue: false,
          idempotent: true,
          reason: "overtime_topup_not_outstanding",
        };
      }

      const { fundingRequirement, topUpDeadlineAt } =
        ShiftOvertimeFundingService.assertOutstandingFundingState(occurrence);

      if (now < topUpDeadlineAt) {
        throw ShiftOvertimeFundingService.createError({
          message: "The overtime top-up deadline has not expired.",
          code: "OVERTIME_TOPUP_DEADLINE_NOT_REACHED",
          statusCode: 409,
          details: {
            topUpDeadlineAt,
          },
        });
      }

      const alreadyOverdue = Boolean(occurrence.overtime.topUpOverdueAt);

      if (!alreadyOverdue) {
        occurrence.set("overtime.topUpOverdueAt", topUpDeadlineAt);

        ShiftOvertimeFundingService.synchronizeOutstandingSettlementStatus(occurrence);

        await occurrence.save({
          session,
        });
      }

      const settings = await ShiftOvertimeFundingService.getPlatformSettings(session);

      const graceHours =
        ShiftOvertimeFundingService.getOvertimeTopUpRestrictionGraceHours(settings);

      const restrictionEligibleAt = new Date(
        new Date(occurrence.overtime.topUpOverdueAt).getTime() + graceHours * MILLISECONDS_PER_HOUR
      );

      return {
        occurrence,

        overdue: true,

        idempotent: alreadyOverdue,

        topUpRequired: fundingRequirement,

        topUpDeadlineAt,

        topUpOverdueAt: occurrence.overtime.topUpOverdueAt,

        restrictionEligibleAt,

        restrictionTriggeredAt: occurrence.overtime.restrictionTriggeredAt || null,

        events: alreadyOverdue
          ? []
          : [
              {
                type: "shift_occurrence_overtime_topup_overdue",

                shiftId: String(occurrence.shift),

                occurrenceId: String(occurrence._id),

                professionalId: String(occurrence.assignedProfessional),

                topUpRequired: fundingRequirement,

                topUpDeadlineAt,

                topUpOverdueAt: occurrence.overtime.topUpOverdueAt,

                restrictionEligibleAt,
              },
            ],
      };
    });
  }

  static async processOverdueOvertimeTopUps(
    { currentTime = new Date(), limit = DEFAULT_PROCESSING_BATCH_LIMIT } = {},
    options = {}
  ) {
    const now = ShiftOvertimeFundingService.normalizeDate(
      currentTime,
      "overtime top-up overdue processing time"
    );

    const normalizedLimit = ShiftOvertimeFundingService.normalizeBatchLimit(limit);

    const query = ShiftOccurrence.find({
      "overtime.requested": true,

      "overtime.status": "approved",

      "overtime.topUpPaid": false,

      "overtime.topUpDeadlineAt": {
        $ne: null,
        $lte: now,
      },

      "overtime.topUpOverdueAt": null,

      topUpRequired: {
        $gt: 0,
      },

      topUpTransaction: null,
    })
      .select("_id")
      .sort({
        "overtime.topUpDeadlineAt": 1,
      })
      .limit(normalizedLimit);

    if (options.session) {
      query.session(options.session);
    }

    const candidates = await query.lean();

    const results = [];

    for (const candidate of candidates) {
      try {
        const result = await ShiftOvertimeFundingService.markOvertimeTopUpOverdue(
          {
            occurrenceId: candidate._id,
            currentTime: now,
          },
          options
        );

        results.push({
          occurrenceId: String(candidate._id),

          overdue: result.overdue,

          error: null,
        });
      } catch (error) {
        logger.error(
          `Unable to mark overtime top-up overdue for occurrence ${candidate._id}: ${error.message}`
        );

        results.push({
          occurrenceId: String(candidate._id),

          overdue: false,

          error: {
            code: error.code || "OVERTIME_TOPUP_OVERDUE_PROCESSING_FAILED",

            message: error.message,
          },
        });
      }
    }

    return {
      inspectedCount: candidates.length,

      overdueCount: results.filter((item) => item.overdue).length,

      failedCount: results.filter((item) => item.error).length,

      results,
    };
  }

  /* ─────────────────────────────── RESTRICTION ─────────────────────────────── */

  static async markOvertimeTopUpRestrictionTriggered(
    { occurrenceId, currentTime = new Date() },
    options = {}
  ) {
    const now = ShiftOvertimeFundingService.normalizeDate(
      currentTime,
      "overtime restriction processing time"
    );

    return ShiftOvertimeFundingService.transaction(options, async (session) => {
      const occurrence = await ShiftOvertimeFundingService.getOccurrence(occurrenceId, session);

      ShiftOvertimeFundingService.assertCompleteAssignment(occurrence);

      if (
        occurrence.overtime?.requested !== true ||
        occurrence.overtime?.status !== "approved" ||
        occurrence.overtime?.topUpPaid === true ||
        occurrence.topUpTransaction ||
        Number(occurrence.topUpRequired || 0) <= 0
      ) {
        return {
          occurrence,

          triggered: false,

          idempotent: true,

          reason: "overtime_topup_not_outstanding",
        };
      }

      ShiftOvertimeFundingService.assertOutstandingFundingState(occurrence);

      if (!occurrence.overtime.topUpOverdueAt) {
        throw ShiftOvertimeFundingService.createError({
          message:
            "Overtime top-up must first become overdue before employer restriction can be triggered.",
          code: "OVERTIME_TOPUP_NOT_OVERDUE",
          statusCode: 409,
        });
      }

      if (occurrence.overtime.restrictionTriggeredAt) {
        return {
          occurrence,

          triggered: true,

          idempotent: true,

          restrictionTriggeredAt: occurrence.overtime.restrictionTriggeredAt,
        };
      }

      const settings = await ShiftOvertimeFundingService.getPlatformSettings(session);

      const graceHours =
        ShiftOvertimeFundingService.getOvertimeTopUpRestrictionGraceHours(settings);

      const restrictionEligibleAt = new Date(
        new Date(occurrence.overtime.topUpOverdueAt).getTime() + graceHours * MILLISECONDS_PER_HOUR
      );

      if (now < restrictionEligibleAt) {
        throw ShiftOvertimeFundingService.createError({
          message: "The overtime top-up restriction grace period has not expired.",
          code: "OVERTIME_TOPUP_RESTRICTION_GRACE_NOT_EXPIRED",
          statusCode: 409,
          details: {
            restrictionEligibleAt,
          },
        });
      }

      occurrence.set("overtime.restrictionTriggeredAt", restrictionEligibleAt);

      ShiftOvertimeFundingService.synchronizeOutstandingSettlementStatus(occurrence);

      await occurrence.save({
        session,
      });

      logger.info(
        `Overtime top-up restriction triggered for occurrence ${occurrence.referenceCode}.`
      );

      return {
        occurrence,

        triggered: true,

        idempotent: false,

        restrictionEligibleAt,

        restrictionTriggeredAt: occurrence.overtime.restrictionTriggeredAt,

        events: [
          {
            type: "shift_occurrence_overtime_topup_restriction_triggered",

            shiftId: String(occurrence.shift),

            occurrenceId: String(occurrence._id),

            businessId: String(occurrence.business),

            professionalId: String(occurrence.assignedProfessional),

            topUpRequired: Number(occurrence.topUpRequired),

            topUpOverdueAt: occurrence.overtime.topUpOverdueAt,

            restrictionTriggeredAt: occurrence.overtime.restrictionTriggeredAt,
          },
        ],
      };
    });
  }

  static async processOvertimeTopUpRestrictions(
    { currentTime = new Date(), limit = DEFAULT_PROCESSING_BATCH_LIMIT } = {},
    options = {}
  ) {
    const now = ShiftOvertimeFundingService.normalizeDate(
      currentTime,
      "overtime restriction processing time"
    );

    const normalizedLimit = ShiftOvertimeFundingService.normalizeBatchLimit(limit);

    const settings = await ShiftOvertimeFundingService.getPlatformSettings(options.session || null);

    const graceHours = ShiftOvertimeFundingService.getOvertimeTopUpRestrictionGraceHours(settings);

    const overdueThreshold = new Date(now.getTime() - graceHours * MILLISECONDS_PER_HOUR);

    const query = ShiftOccurrence.find({
      "overtime.requested": true,

      "overtime.status": "approved",

      "overtime.topUpPaid": false,

      "overtime.topUpOverdueAt": {
        $ne: null,
        $lte: overdueThreshold,
      },

      "overtime.restrictionTriggeredAt": null,

      topUpRequired: {
        $gt: 0,
      },

      topUpTransaction: null,
    })
      .select("_id")
      .sort({
        "overtime.topUpOverdueAt": 1,
      })
      .limit(normalizedLimit);

    if (options.session) {
      query.session(options.session);
    }

    const candidates = await query.lean();

    const results = [];

    for (const candidate of candidates) {
      try {
        const result = await ShiftOvertimeFundingService.markOvertimeTopUpRestrictionTriggered(
          {
            occurrenceId: candidate._id,

            currentTime: now,
          },
          options
        );

        results.push({
          occurrenceId: String(candidate._id),

          triggered: result.triggered,

          error: null,
        });
      } catch (error) {
        logger.error(
          `Unable to trigger overtime top-up restriction for occurrence ${candidate._id}: ${error.message}`
        );

        results.push({
          occurrenceId: String(candidate._id),

          triggered: false,

          error: {
            code: error.code || "OVERTIME_TOPUP_RESTRICTION_PROCESSING_FAILED",

            message: error.message,
          },
        });
      }
    }

    return {
      inspectedCount: candidates.length,

      triggeredCount: results.filter((item) => item.triggered).length,

      failedCount: results.filter((item) => item.error).length,

      results,
    };
  }

  /* ─────────────────────────────── TOP-UP TRANSACTION VERIFICATION ─────────────────────────────── */

  static async getVerifiedTopUpTransaction({ occurrence, transactionId, session }) {
    const normalizedTransactionId = ShiftOvertimeFundingService.normalizeObjectId(
      transactionId,
      "top-up transaction ID"
    );

    const { fundingRequirement } =
      ShiftOvertimeFundingService.assertOutstandingFundingState(occurrence);

    const transaction = await Transaction.findById(normalizedTransactionId)
      .select(
        [
          "type",
          "purpose",
          "direction",
          "status",
          "amount",
          "wallet",
          "paymentRail",
          "provider",
          "completedAt",
          "shift",
          "shiftOccurrence",
        ].join(" ")
      )
      .session(session);

    if (!transaction) {
      throw ShiftOvertimeFundingService.createError({
        message: "The overtime top-up transaction was not found.",
        code: "OVERTIME_TOPUP_TRANSACTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    const shift = await ShiftOvertimeFundingService.getShift(occurrence.shift, session);

    if (String(shift.business) !== String(occurrence.business)) {
      throw ShiftOvertimeFundingService.createError({
        message:
          "Occurrence business does not match the parent Shift during overtime funding verification.",
        code: "OVERTIME_TOPUP_BUSINESS_MISMATCH",
        statusCode: 500,
      });
    }

    const escrowWallet = await WalletService.getEscrowWallet(
      {
        countryCode: shift.countryCode,

        currency: shift.currency,
      },
      {
        session,
      }
    );

    if (!escrowWallet) {
      throw ShiftOvertimeFundingService.createError({
        message: "The escrow wallet required to verify overtime funding was not found.",
        code: "ESCROW_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    let transactionAmount;

    try {
      transactionAmount = ShiftOvertimeFundingService.normalizePositiveAmount(
        transaction.amount,
        "overtime top-up transaction amount"
      );
    } catch (error) {
      throw ShiftOvertimeFundingService.createError({
        message: "The overtime top-up transaction contains an invalid amount.",
        code: "INVALID_OCCURRENCE_OVERTIME_TOPUP_TRANSACTION",
        statusCode: 409,
        cause: error,
      });
    }

    const valid =
      transaction.type === OVERTIME_TOPUP_TRANSACTION_TYPE &&
      transaction.purpose === OVERTIME_TOPUP_TRANSACTION_PURPOSE &&
      transaction.direction === "credit" &&
      transaction.status === "completed" &&
      OVERTIME_TOPUP_ALLOWED_PAYMENT_RAILS.includes(transaction.paymentRail) &&
      transactionAmount === fundingRequirement &&
      String(transaction.wallet || "") === String(escrowWallet._id) &&
      String(transaction.shift || "") === String(occurrence.shift) &&
      String(transaction.shiftOccurrence || "") === String(occurrence._id);

    if (!valid) {
      throw ShiftOvertimeFundingService.createError({
        message:
          "The supplied transaction is not the completed overtime top-up for this occurrence.",
        code: "INVALID_OCCURRENCE_OVERTIME_TOPUP_TRANSACTION",
        statusCode: 409,
        details: {
          expectedTopUpAmount: fundingRequirement,

          transactionAmount,

          paymentRail: transaction.paymentRail || null,
        },
      });
    }

    if (!transaction.completedAt) {
      throw ShiftOvertimeFundingService.createError({
        message: "The completed overtime top-up transaction is missing completedAt.",
        code: "OVERTIME_TOPUP_TRANSACTION_COMPLETED_AT_MISSING",
        statusCode: 500,
      });
    }

    const fundedAt = ShiftOvertimeFundingService.normalizeDate(
      transaction.completedAt,
      "overtime top-up transaction completion time"
    );

    const approvedAt = ShiftOvertimeFundingService.normalizeDate(
      occurrence.overtime.approvedAt,
      "overtime approval time"
    );

    if (fundedAt < approvedAt) {
      throw ShiftOvertimeFundingService.createError({
        message: "The overtime top-up transaction cannot predate final overtime approval.",
        code: "OVERTIME_TOPUP_TRANSACTION_TOO_EARLY",
        statusCode: 409,
      });
    }

    return {
      transaction,
      fundedAt,
      fundingRequirement,
    };
  }

  /* ─────────────────────────────── SETTLEMENT HANDOFF ─────────────────────────────── */

  static async handoffFundedOvertimeToSettlement({ occurrence, readyAt, payoutPolicy, session }) {
    if (typeof ShiftSettlementService.markOccurrenceComponentReadyForRelease !== "function") {
      throw ShiftOvertimeFundingService.createError({
        message:
          "ShiftSettlementService.markOccurrenceComponentReadyForRelease is not implemented.",
        code: "OVERTIME_SETTLEMENT_HANDOFF_NOT_IMPLEMENTED",
        statusCode: 500,
      });
    }

    try {
      return await ShiftSettlementService.markOccurrenceComponentReadyForRelease(
        {
          occurrenceId: occurrence._id,

          component: "overtime",

          releaseSource: "automatic",

          releasedByUserId: null,

          readyAt,

          payoutPolicy,
        },
        {
          session,
        }
      );
    } catch (error) {
      if (error?.name !== "ShiftSettlementServiceError") {
        throw error;
      }

      throw ShiftOvertimeFundingService.createError({
        message: error.message,
        code: error.code || "OVERTIME_SETTLEMENT_HANDOFF_FAILED",
        statusCode: error.statusCode || 500,
        details: error.details && typeof error.details === "object" ? error.details : null,
        cause: error,
      });
    }
  }

  /* ─────────────────────────────── FUNDING CONFIRMATION ─────────────────────────────── */

  static async confirmTopUpFunding(
    {
      occurrenceId,

      topUpTransactionId,

      currentTime = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },

      payoutPolicy = {},
    },

    options = {}
  ) {
    const transactionId = ShiftOvertimeFundingService.normalizeObjectId(
      topUpTransactionId,
      "top-up transaction ID"
    );

    const now = ShiftOvertimeFundingService.normalizeDate(
      currentTime,
      "overtime top-up confirmation time"
    );

    const normalizedInitiatedBy = ShiftOvertimeFundingService.normalizeInitiatedBy(initiatedBy);

    return ShiftOvertimeFundingService.transaction(options, async (session) => {
      let occurrence = await ShiftOvertimeFundingService.getOccurrence(occurrenceId, session);

      ShiftOvertimeFundingService.assertCompleteAssignment(occurrence);

      if (occurrence.overtime?.topUpPaid === true && occurrence.topUpTransaction) {
        if (String(occurrence.topUpTransaction) !== String(transactionId)) {
          throw ShiftOvertimeFundingService.createError({
            message:
              "A different overtime top-up transaction is already attached to this occurrence.",
            code: "OVERTIME_TOPUP_TRANSACTION_CONFLICT",
            statusCode: 409,
          });
        }

        const platformFeeResult = await ShiftPlatformFeeService.collectOvertimePlatformFee(
          {
            occurrenceId: occurrence._id,

            collectedAt:
              now >= new Date(occurrence.overtime.topUpPaidAt)
                ? now
                : occurrence.overtime.topUpPaidAt,

            initiatedBy: normalizedInitiatedBy,
          },
          {
            session,
          }
        );

        occurrence = platformFeeResult.occurrence;

        const settlementResult =
          await ShiftOvertimeFundingService.handoffFundedOvertimeToSettlement({
            occurrence,

            readyAt: now,

            payoutPolicy,

            session,
          });

        return {
          occurrence: settlementResult.occurrence || occurrence,

          platformFeeResult,

          settlementResult,

          idempotent: true,
        };
      }

      const verified = await ShiftOvertimeFundingService.getVerifiedTopUpTransaction({
        occurrence,

        transactionId,

        session,
      });

      occurrence.set("overtime.topUpPaid", true);

      occurrence.set("overtime.topUpPaidAt", verified.fundedAt);

      occurrence.topUpTransaction = transactionId;

      occurrence.topUpRequired = 0;

      /**
       * Historical topUpOverdueAt / restrictionTriggeredAt deliberately
       * remain untouched if payment arrived late.
       */

      await occurrence.save({
        session,
      });

      const collectionTime = now >= verified.fundedAt ? now : verified.fundedAt;

      const platformFeeResult = await ShiftPlatformFeeService.collectOvertimePlatformFee(
        {
          occurrenceId: occurrence._id,

          collectedAt: collectionTime,

          initiatedBy: normalizedInitiatedBy,
        },
        {
          session,
        }
      );

      occurrence = platformFeeResult.occurrence;

      /**
       * ShiftSettlementService owns professional payout readiness.
       *
       * Funding merely hands the now-funded OT component to that authority.
       */
      const settlementResult = await ShiftOvertimeFundingService.handoffFundedOvertimeToSettlement({
        occurrence,

        readyAt: now,

        payoutPolicy,

        session,
      });

      const finalOccurrence = settlementResult.occurrence || occurrence;

      logger.info(
        `Confirmed overtime top-up funding for occurrence ${finalOccurrence.referenceCode}.`
      );

      return {
        occurrence: finalOccurrence,

        fundedAt: verified.fundedAt,

        topUpAmount: verified.fundingRequirement,

        platformFeeResult,

        settlementResult,

        idempotent: false,

        events: [
          {
            type: "shift_occurrence_overtime_topup_confirmed",

            shiftId: String(finalOccurrence.shift),

            occurrenceId: String(finalOccurrence._id),

            professionalId: String(finalOccurrence.assignedProfessional),

            topUpAmount: verified.fundingRequirement,

            topUpOutstanding: 0,

            fundedAt: verified.fundedAt,
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── READ STATE ─────────────────────────────── */

  static async getOvertimeFundingState({ occurrenceId }, options = {}) {
    const occurrence = await ShiftOvertimeFundingService.getOccurrence(
      occurrenceId,
      options.session || null
    );

    const overtime = occurrence.overtime || {};

    const approved = Boolean(overtime.requested === true && overtime.status === "approved");

    let fundingRequirement = 0;

    if (approved) {
      fundingRequirement =
        ShiftOvertimeFundingService.getFundingRequirement(occurrence).fundingRequirement;
    }

    let restrictionEligibleAt = null;

    if (overtime.topUpOverdueAt) {
      const settings = await ShiftOvertimeFundingService.getPlatformSettings(
        options.session || null
      );

      const graceHours =
        ShiftOvertimeFundingService.getOvertimeTopUpRestrictionGraceHours(settings);

      restrictionEligibleAt = new Date(
        new Date(overtime.topUpOverdueAt).getTime() + graceHours * MILLISECONDS_PER_HOUR
      );
    }

    return {
      occurrenceId: String(occurrence._id),

      occurrenceReferenceCode: occurrence.referenceCode,

      approved,

      professionalPay: Number(occurrence.overtimeProfessionalPay || 0),

      platformFee: Number(occurrence.overtimePlatformFee || 0),

      fundingRequirement,

      topUpAmount: Number(overtime.topUpAmount || 0),

      topUpRequired: Number(occurrence.topUpRequired || 0),

      topUpDeadlineAt: overtime.topUpDeadlineAt || null,

      topUpOverdueAt: overtime.topUpOverdueAt || null,

      restrictionEligibleAt,

      restrictionTriggeredAt: overtime.restrictionTriggeredAt || null,

      topUpPaid: overtime.topUpPaid === true,

      topUpPaidAt: overtime.topUpPaidAt || null,

      topUpTransaction: occurrence.topUpTransaction || null,

      activeRestriction: Boolean(
        approved &&
        overtime.topUpPaid !== true &&
        Number(occurrence.topUpRequired || 0) > 0 &&
        !occurrence.topUpTransaction &&
        overtime.restrictionTriggeredAt
      ),
    };
  }
}

module.exports = ShiftOvertimeFundingService;
