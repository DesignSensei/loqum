// services/shiftSettlementBatchService.js

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftSettlementBatch = require("../models/ShiftSettlementBatch");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const WalletService = require("./walletService");
const ShiftSettlementService = require("./shiftSettlementService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { SHIFT_TIME_ZONE } = require("../constants/shiftPosting");

const {
  SETTLEMENT_BATCH_INITIATOR_ROLES,
  SETTLEMENT_BATCH_COMPONENTS,
  SETTLEMENT_LINE_EARNING_TYPES,
  DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY,
  MAX_SETTLEMENT_BATCH_FAILURE_REASON_LENGTH,
  MAX_SETTLEMENT_BATCH_CANCELLATION_REASON_LENGTH,
} = require("../constants/shiftSettlement");

const { SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE } = require("../constants/transaction");

const logger = require("../utils/logger");

const DEFAULT_MAX_PROCESSING_ATTEMPTS = 5;
const DEFAULT_BATCH_QUERY_LIMIT = 1000;
const DEFAULT_PROCESSING_LIMIT = 100;

const COMPONENT_PATHS = Object.freeze({
  base: "baseSettlement",
  overtime: "overtimeSettlement",
});

const COMPONENT_EARNING_TYPES = Object.freeze({
  base: Object.freeze(["worked_base", "cancellation_compensation", "active_work_cancellation"]),

  overtime: Object.freeze(["overtime"]),
});

/**
 * SHIFT SETTLEMENT BATCH ARCHITECTURE
 *
 * This service batches and releases PROFESSIONAL PAYOUT COMPONENTS only.
 *
 * One ShiftOccurrence may participate in two independent payout batches:
 *
 * - one BASE batch for baseSettlement; and
 * - one OVERTIME batch for overtimeSettlement.
 *
 * Each batch is professional-specific, country/currency-specific,
 * payout-cycle-specific and component-specific.
 *
 * AUTHORITATIVE BOUNDARIES
 *
 * ShiftSettlementService owns:
 *
 * - professional payout-component readiness;
 * - component-specific challenge finality; and
 * - occurrence settlement-summary state.
 *
 * This service owns only:
 *
 * - finding due approved_for_release components;
 * - grouping them into component-specific professional batches;
 * - attaching them as release_pending;
 * - executing escrow -> professional wallet payout;
 * - recording the released component audit;
 * - batch retries/failures/cancellation; and
 * - occurrence-component payout reservation safety.
 *
 * This service does NOT own:
 *
 * - professional entitlement calculation;
 * - claim/dispute scope derivation;
 * - claim/dispute adjudication;
 * - platform-fee earning or collection;
 * - overtime approval/funding/delinquency;
 * - employer refund eligibility or execution; or
 * - parent Shift reconciliation.
 *
 * CHALLENGE FINALITY
 *
 * This service does not maintain a private claim/dispute scope model.
 *
 * All finality checks are delegated to ShiftSettlementService so batching uses
 * the same unresolved-issue semantics as ordinary settlement readiness,
 * including legitimate activeClaim + activeDispute coexistence.
 *
 * ATTACHMENT
 *
 * Batch attachment changes only the selected component:
 *
 * approved_for_release -> release_pending
 *
 * and writes settlementBatch + releasePendingAt.
 *
 * RELEASE
 *
 * One batch release creates one paired wallet transfer:
 *
 * escrow -> professional wallet
 *
 * Final release changes only the selected component:
 *
 * release_pending -> released
 *
 * and records releasedAt + payoutTransaction.
 *
 * PROCESSING AUDIT
 *
 * processingToken is transient and is cleared when processing ends.
 *
 * processingStartedAt, attemptCount and lastAttemptAt are historical audit and
 * survive released / failed terminalization.
 */
class ShiftSettlementBatchService {
  /* ─────────────────────────────── ERRORS / NORMALIZATION ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: "ShiftSettlementBatchServiceError",
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

  static shortenFailureReason(value) {
    return String(value || "Settlement batch processing failed.")
      .trim()
      .slice(0, MAX_SETTLEMENT_BATCH_FAILURE_REASON_LENGTH);
  }

  static normalizeObjectId(value, fieldName) {
    const fieldCode = normalizeFieldCode(fieldName);

    if (!value) {
      throw this.createError({
        message: `${fieldName} is required.`,
        code: `${fieldCode}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw this.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeDate(value, fieldName) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw this.createError({
        message: `${fieldName} must be a valid date.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return date;
  }

  static normalizePositiveInteger(value, fieldName, maximum = null) {
    const number = Number(value);

    if (!Number.isSafeInteger(number) || number <= 0) {
      throw this.createError({
        message: `${fieldName} must be a positive whole number.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    if (maximum !== null && number > maximum) {
      throw this.createError({
        message: `${fieldName} cannot exceed ${maximum}.`,
        code: `${normalizeFieldCode(fieldName)}_TOO_LARGE`,
      });
    }

    return number;
  }

  static normalizeRequiredText(value, fieldName, maximumLength) {
    const text = String(value || "").trim();

    if (!text) {
      throw this.createError({
        message: `${fieldName} is required.`,
        code: `${normalizeFieldCode(fieldName)}_REQUIRED`,
      });
    }

    if (text.length > maximumLength) {
      throw this.createError({
        message: `${fieldName} cannot exceed ${maximumLength} characters.`,
        code: `${normalizeFieldCode(fieldName)}_TOO_LONG`,
      });
    }

    return text;
  }

  static normalizeCountryCode(value) {
    const countryCode = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw this.createError({
        message: "Settlement country code is invalid.",
        code: "INVALID_SETTLEMENT_COUNTRY_CODE",
        statusCode: 500,
      });
    }

    return countryCode;
  }

  static normalizeCurrency(value) {
    const currency = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw this.createError({
        message: "Settlement currency is invalid.",
        code: "INVALID_SETTLEMENT_CURRENCY",
        statusCode: 500,
      });
    }

    return currency;
  }

  static normalizeComponent(value) {
    const component = String(value || "")
      .trim()
      .toLowerCase();

    if (!SETTLEMENT_BATCH_COMPONENTS.includes(component)) {
      throw this.createError({
        message: "Settlement component is invalid.",
        code: "INVALID_SETTLEMENT_COMPONENT",
        statusCode: 500,
        details: {
          settlementComponent: component || null,

          supportedComponents: SETTLEMENT_BATCH_COMPONENTS,
        },
      });
    }

    return component;
  }

  static normalizeInitiatedBy(value) {
    const initiatedBy = value || {
      role: "system",
      userId: null,
    };

    const role = String(initiatedBy.role || "system")
      .trim()
      .toLowerCase();

    if (!SETTLEMENT_BATCH_INITIATOR_ROLES.includes(role)) {
      throw this.createError({
        message: "Settlement batch initiator role is invalid.",
        code: "INVALID_SETTLEMENT_BATCH_INITIATOR",
      });
    }

    const userId = initiatedBy.userId
      ? this.normalizeObjectId(initiatedBy.userId, "initiator user ID")
      : null;

    if (role === "admin" && !userId) {
      throw this.createError({
        message: "Admin settlement processing requires an initiator user ID.",
        code: "SETTLEMENT_BATCH_INITIATOR_USER_ID_REQUIRED",
      });
    }

    return {
      role,
      userId,
    };
  }

  static assertTimeZone(timeZone) {
    const normalizedTimeZone = String(timeZone || "").trim();

    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: normalizedTimeZone,
      }).format();
    } catch (error) {
      throw this.createError({
        message: "Settlement payout timezone is invalid.",
        code: "INVALID_SETTLEMENT_PAYOUT_TIME_ZONE",
        statusCode: 500,
        cause: error,
      });
    }

    return normalizedTimeZone;
  }

  /* ─────────────────────────────── COMPONENT HELPERS ─────────────────────────────── */

  static getComponentPath(component) {
    const normalizedComponent = this.normalizeComponent(component);

    return COMPONENT_PATHS[normalizedComponent];
  }

  static getComponentAudit(occurrence, component) {
    const path = this.getComponentPath(component);

    return occurrence?.[path] || null;
  }

  static buildReleaseKey(occurrenceId, component) {
    return `${String(occurrenceId).toLowerCase()}:` + `${this.normalizeComponent(component)}`;
  }

  static getExpectedReleaseKeys(entries, component) {
    const normalizedComponent = this.normalizeComponent(component);

    return entries
      .map((entry) => this.buildReleaseKey(entry.occurrence._id, normalizedComponent))
      .sort();
  }

  static assertComponentEarningType(component, earningType) {
    const normalizedComponent = this.normalizeComponent(component);

    if (
      !SETTLEMENT_LINE_EARNING_TYPES.includes(earningType) ||
      !COMPONENT_EARNING_TYPES[normalizedComponent].includes(earningType)
    ) {
      throw this.createError({
        message: "Settlement component earning type is invalid.",
        code: "INVALID_COMPONENT_SETTLEMENT_EARNING_TYPE",
        statusCode: 409,
        details: {
          settlementComponent: normalizedComponent,

          earningType: earningType || null,
        },
      });
    }

    return earningType;
  }

  static assertComponentPricing({ occurrence, component, audit = null }) {
    const normalizedComponent = this.normalizeComponent(component);

    const componentAudit = audit || this.getComponentAudit(occurrence, normalizedComponent);

    if (!componentAudit) {
      throw this.createError({
        message: "Professional payout component audit is missing.",
        code: "SETTLEMENT_COMPONENT_AUDIT_MISSING",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),

          settlementComponent: normalizedComponent,
        },
      });
    }

    const earningType = this.assertComponentEarningType(
      normalizedComponent,
      componentAudit.earningType
    );

    const professionalPay = Number(componentAudit.professionalPay);

    if (!Number.isSafeInteger(professionalPay) || professionalPay <= 0) {
      throw this.createError({
        message: "A professional payout component contains an invalid professional-pay amount.",
        code: "INVALID_COMPONENT_PROFESSIONAL_PAY",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),

          referenceCode: occurrence.referenceCode,

          settlementComponent: normalizedComponent,

          professionalPay,
        },
      });
    }

    return {
      earningType,
      professionalPay,
    };
  }

  static assertCompleteAssignment(occurrence, professionalId = null) {
    const assignedProfessional = occurrence?.assignedProfessional;

    if (
      occurrence?.assignmentStatus !== "assigned" ||
      !assignedProfessional ||
      !occurrence?.assignment ||
      !occurrence?.assignedAt
    ) {
      throw this.createError({
        message: "The occurrence does not have a complete professional assignment.",
        code: "SETTLEMENT_COMPONENT_ASSIGNMENT_INCOMPLETE",
        statusCode: 409,
        details: {
          occurrenceId: occurrence?._id ? String(occurrence._id) : null,
        },
      });
    }

    if (professionalId && String(assignedProfessional) !== String(professionalId)) {
      throw this.createError({
        message: "The occurrence is no longer assigned to the batch professional.",
        code: "SETTLEMENT_COMPONENT_PROFESSIONAL_MISMATCH",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),

          expectedProfessionalId: String(professionalId),

          actualProfessionalId: String(assignedProfessional),
        },
      });
    }

    return occurrence;
  }

  static assertComponentOperationalShape(occurrence, component) {
    const normalizedComponent = this.normalizeComponent(component);

    const earningType = this.getComponentAudit(occurrence, normalizedComponent)?.earningType;

    if (normalizedComponent === "overtime") {
      if (
        occurrence.status !== "pending_settlement" ||
        !["checked_out", "settled"].includes(occurrence.attendanceStatus) ||
        occurrence.overtime?.requested !== true ||
        occurrence.overtime?.status !== "approved" ||
        occurrence.overtime?.topUpPaid !== true ||
        Number(occurrence.topUpRequired || 0) !== 0
      ) {
        throw this.createError({
          message: "The occurrence does not contain a funded payable overtime outcome.",
          code: "OVERTIME_COMPONENT_OPERATIONAL_SHAPE_INVALID",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            status: occurrence.status,

            attendanceStatus: occurrence.attendanceStatus,

            overtimeStatus: occurrence.overtime?.status || null,
          },
        });
      }

      return occurrence;
    }

    if (earningType === "worked_base") {
      if (
        !["pending_settlement", "completed"].includes(occurrence.status) ||
        !["checked_out", "settled"].includes(occurrence.attendanceStatus)
      ) {
        throw this.createError({
          message: "The occurrence does not contain a payable worked base outcome.",
          code: "WORKED_BASE_COMPONENT_OPERATIONAL_SHAPE_INVALID",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            status: occurrence.status,

            attendanceStatus: occurrence.attendanceStatus,
          },
        });
      }

      return occurrence;
    }

    if (earningType === "cancellation_compensation") {
      if (
        occurrence.status !== "cancelled" ||
        occurrence.attendanceStatus !== "not_started" ||
        occurrence.cancellationCompensation?.applicable !== true
      ) {
        throw this.createError({
          message: "The occurrence does not contain a payable cancellation-compensation outcome.",
          code: "CANCELLATION_COMPONENT_OPERATIONAL_SHAPE_INVALID",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),
          },
        });
      }

      return occurrence;
    }

    if (earningType === "active_work_cancellation") {
      if (
        occurrence.activeWorkCancellation?.occurred !== true ||
        !["pending_settlement", "completed", "cancelled"].includes(occurrence.status)
      ) {
        throw this.createError({
          message: "The occurrence does not contain a payable active-work cancellation outcome.",
          code: "ACTIVE_WORK_CANCELLATION_COMPONENT_OPERATIONAL_SHAPE_INVALID",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),
          },
        });
      }

      return occurrence;
    }

    throw this.createError({
      message: "The BASE component has an unsupported earning type.",
      code: "UNSUPPORTED_BASE_COMPONENT_EARNING_TYPE",
      statusCode: 409,
      details: {
        occurrenceId: String(occurrence._id),

        earningType: earningType || null,
      },
    });
  }

  /* ─────────────────────────────── CHALLENGE FINALITY ─────────────────────────────── */

  static async synchronizeAndGetChallengeContext({ occurrence, currentTime, session = null }) {
    const synchronization = ShiftSettlementService.synchronizeExpiredChallengeWindow({
      occurrence,
      currentTime,
    });

    const challengeContext = await ShiftSettlementService.getActiveChallengeContext({
      occurrence,
      session,
    });

    return {
      synchronization,
      challengeContext,
    };
  }

  static async isComponentFinalForBatch({ occurrence, component, currentTime, session = null }) {
    const normalizedComponent = this.normalizeComponent(component);

    const { synchronization, challengeContext } = await this.synchronizeAndGetChallengeContext({
      occurrence,
      currentTime,
      session,
    });

    return {
      final: ShiftSettlementService.isComponentFinal({
        occurrence,
        component: normalizedComponent,
        challengeContext,
        currentTime,
      }),

      synchronization,
      challengeContext,
    };
  }

  static async synchronizeOccurrenceSettlementSummary({ occurrence, currentTime, session = null }) {
    const { challengeContext } = await this.synchronizeAndGetChallengeContext({
      occurrence,
      currentTime,
      session,
    });

    ShiftSettlementService.synchronizeOverallSettlementState({
      occurrence,
      currentTime,
      challengeContext,
    });

    return challengeContext;
  }

  /* ─────────────────────────────── DATE / CYCLE HELPERS ─────────────────────────────── */

  static getZonedDateTimeParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,

      year: "numeric",
      month: "2-digit",
      day: "2-digit",

      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",

      hourCycle: "h23",
    }).formatToParts(date);

    const partMap = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );

    return {
      year: Number(partMap.year),

      month: Number(partMap.month),

      day: Number(partMap.day),

      hour: Number(partMap.hour),

      minute: Number(partMap.minute),

      second: Number(partMap.second),
    };
  }

  static getTimeZoneOffsetMilliseconds(date, timeZone) {
    const sourceDate = new Date(date);

    const parts = this.getZonedDateTimeParts(sourceDate, timeZone);

    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );

    const sourceWithoutMilliseconds = Math.floor(sourceDate.getTime() / 1000) * 1000;

    return representedAsUtc - sourceWithoutMilliseconds;
  }

  static zonedDateTimeToUtc({
    year,
    month,
    day,
    hour,
    minute,
    second = 0,
    millisecond = 0,
    timeZone,
  }) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

    let candidate = new Date(utcGuess);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const offset = this.getTimeZoneOffsetMilliseconds(candidate, timeZone);

      candidate = new Date(utcGuess - offset);
    }

    return candidate;
  }

  static getPayoutCycleSnapshot({ scheduledFor, timeZone = SHIFT_TIME_ZONE }) {
    const normalizedScheduledFor = this.normalizeDate(scheduledFor, "Scheduled payout time");

    const normalizedTimeZone = this.assertTimeZone(timeZone);

    const payoutParts = this.getZonedDateTimeParts(normalizedScheduledFor, normalizedTimeZone);

    const localDateAsUtc = new Date(
      Date.UTC(payoutParts.year, payoutParts.month - 1, payoutParts.day)
    );

    const payoutDate = [
      payoutParts.year,
      String(payoutParts.month).padStart(2, "0"),
      String(payoutParts.day).padStart(2, "0"),
    ].join("-");

    const payoutWeekday = localDateAsUtc.getUTCDay();

    const previousLocalDate = new Date(localDateAsUtc.getTime() - 24 * 60 * 60 * 1000);

    const cutoffAt = this.zonedDateTimeToUtc({
      year: previousLocalDate.getUTCFullYear(),

      month: previousLocalDate.getUTCMonth() + 1,

      day: previousLocalDate.getUTCDate(),

      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,

      timeZone: normalizedTimeZone,
    });

    return {
      payoutDate,
      payoutWeekday,

      timeZone: normalizedTimeZone,

      cutoffAt,

      scheduledFor: normalizedScheduledFor,
    };
  }

  static calculateFollowingCycleAt({ scheduledFor, timeZone = SHIFT_TIME_ZONE }) {
    const normalizedScheduledFor = this.normalizeDate(scheduledFor, "Scheduled payout time");

    const normalizedTimeZone = this.assertTimeZone(timeZone);

    const parts = this.getZonedDateTimeParts(normalizedScheduledFor, normalizedTimeZone);

    const localDatePlusSevenDays = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 7));

    return this.zonedDateTimeToUtc({
      year: localDatePlusSevenDays.getUTCFullYear(),

      month: localDatePlusSevenDays.getUTCMonth() + 1,

      day: localDatePlusSevenDays.getUTCDate(),

      hour: parts.hour,

      minute: parts.minute,

      second: parts.second,

      millisecond: 0,

      timeZone: normalizedTimeZone,
    });
  }

  static buildCycleKey({ countryCode, currency, payoutDate }) {
    return `${countryCode}-` + `${currency}-` + `${payoutDate}`;
  }

  static buildBatchReferenceCode({
    countryCode,
    currency,
    payoutDate,
    professionalId,
    settlementComponent,
  }) {
    return [
      "LQM",
      "PAY",

      settlementComponent.toUpperCase(),

      countryCode,
      currency,

      payoutDate.replace(/-/g, ""),

      String(professionalId).slice(-8).toUpperCase(),
    ].join("-");
  }

  static buildBatchIdempotencyKey({
    countryCode,
    currency,
    payoutDate,
    professionalId,
    settlementComponent,
  }) {
    return [
      "shift-settlement-batch",
      settlementComponent,
      countryCode,
      currency,
      payoutDate,
      String(professionalId),
    ].join(":");
  }

  static buildReleaseIdempotencyKeys({ batchId, releaseType }) {
    const prefix = `shift-settlement-batch:` + `${batchId}:` + `${releaseType}`;

    return {
      debitIdempotencyKey: `${prefix}:escrow-debit`,

      creditIdempotencyKey: `${prefix}:destination-credit`,
    };
  }

  static buildReleaseGroupReference(batchId) {
    return "LQM-SETTLEMENT-" + String(batchId).toUpperCase();
  }

  /* ─────────────────────────────── AMOUNT HELPERS ─────────────────────────────── */

  static addSafeInteger(total, amount, fieldName) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw this.createError({
        message: `${fieldName} contains an invalid amount.`,
        code: "INVALID_SETTLEMENT_BATCH_AMOUNT",
        statusCode: 500,
      });
    }

    const nextTotal = total + amount;

    if (!Number.isSafeInteger(nextTotal)) {
      throw this.createError({
        message: `${fieldName} total is too large.`,
        code: "SETTLEMENT_BATCH_AMOUNT_TOO_LARGE",
        statusCode: 500,
      });
    }

    return nextTotal;
  }

  /* ─────────────────────────────── OCCURRENCE FIELD SELECTION ─────────────────────────────── */

  static getOccurrenceSettlementFields() {
    return [
      "shift",
      "business",
      "branch",

      "referenceCode",
      "sequenceNumber",

      "assignmentStatus",
      "assignedProfessional",
      "assignment",
      "assignedAt",

      "status",
      "attendanceStatus",
      "settlementStatus",
      "settledAt",

      "startTime",
      "endTime",

      "baseBillableHours",
      "billableHours",

      "baseProfessionalPay",
      "overtimeProfessionalPay",

      "cancellationCompensation",
      "activeWorkCancellation",

      "overtime",

      "topUpRequired",
      "topUpTransaction",

      "reviewStartedAt",
      "reviewDeadlineAt",

      "challengeWindowOpenedAt",
      "challengeDeadlineAt",
      "challengeWindowClosedAt",
      "challengeableSettlementComponents",

      "activeClaim",
      "activeDispute",

      "baseSettlement",
      "overtimeSettlement",
    ].join(" ");
  }

  /* ─────────────────────────────── DUE COMPONENTS ─────────────────────────────── */

  static buildDueComponentQuery(now) {
    const normalizedNow = this.normalizeDate(now, "Batch query time");

    return {
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

      $or: SETTLEMENT_BATCH_COMPONENTS.map((component) => {
        const path = this.getComponentPath(component);

        return {
          [`${path}.status`]: "approved_for_release",

          [`${path}.approvedForReleaseAt`]: {
            $ne: null,
          },

          [`${path}.scheduledPayoutAt`]: {
            $ne: null,
            $lte: normalizedNow,
          },

          [`${path}.settlementBatch`]: null,

          [`${path}.professionalPay`]: {
            $gt: 0,
          },
        };
      }),
    };
  }

  static buildComponentEntry({ occurrence, component }) {
    const normalizedComponent = this.normalizeComponent(component);

    const audit = this.getComponentAudit(occurrence, normalizedComponent);

    if (!audit || audit.status !== "approved_for_release") {
      return null;
    }

    const approvedForReleaseAt = audit.approvedForReleaseAt
      ? this.normalizeDate(audit.approvedForReleaseAt, "Component approval time")
      : null;

    const scheduledPayoutAt = audit.scheduledPayoutAt
      ? this.normalizeDate(audit.scheduledPayoutAt, "Component payout time")
      : null;

    if (!approvedForReleaseAt || !scheduledPayoutAt || audit.settlementBatch) {
      return null;
    }

    const pricing = this.assertComponentPricing({
      occurrence,
      component: normalizedComponent,
      audit,
    });

    this.assertCompleteAssignment(occurrence);

    this.assertComponentOperationalShape(occurrence, normalizedComponent);

    return {
      occurrence,

      component: normalizedComponent,

      audit,

      approvedForReleaseAt,
      scheduledPayoutAt,

      ...pricing,
    };
  }

  static async getDueComponentEntries({
    now = new Date(),
    limit = DEFAULT_BATCH_QUERY_LIMIT,
  } = {}) {
    const normalizedNow = this.normalizeDate(now, "Batch query time");

    const normalizedLimit = this.normalizePositiveInteger(limit, "Batch query limit", 5000);

    const candidates = await ShiftOccurrence.find(this.buildDueComponentQuery(normalizedNow))
      .select(this.getOccurrenceSettlementFields())
      .sort({
        assignedProfessional: 1,
        shift: 1,
        sequenceNumber: 1,
      })
      .limit(normalizedLimit)
      .lean();

    const entries = [];

    for (const occurrence of candidates) {
      for (const component of SETTLEMENT_BATCH_COMPONENTS) {
        const entry = this.buildComponentEntry({
          occurrence,
          component,
        });

        if (!entry || entry.scheduledPayoutAt > normalizedNow) {
          continue;
        }

        const finality = await this.isComponentFinalForBatch({
          occurrence,
          component,

          currentTime: normalizedNow,
        });

        if (!finality.final) {
          continue;
        }

        entries.push(entry);
      }
    }

    return entries;
  }

  static async loadShiftFinancialContexts(entries) {
    const shiftIds = [...new Set(entries.map((entry) => String(entry.occurrence.shift)))];

    const shifts = await Shift.find({
      _id: {
        $in: shiftIds,
      },
    })
      .select("referenceCode countryCode currency")
      .lean();

    const shiftMap = new Map(shifts.map((shift) => [String(shift._id), shift]));

    for (const entry of entries) {
      if (!shiftMap.has(String(entry.occurrence.shift))) {
        throw this.createError({
          message: "A parent Shift required for settlement was not found.",
          code: "SETTLEMENT_PARENT_SHIFT_NOT_FOUND",
          statusCode: 409,
          details: {
            occurrenceId: String(entry.occurrence._id),

            shiftId: String(entry.occurrence.shift),
          },
        });
      }
    }

    return shiftMap;
  }

  static groupDueComponentEntries({ entries, shiftMap }) {
    const groups = new Map();

    const cutoffDeferrals = [];

    for (const entry of entries) {
      const shift = shiftMap.get(String(entry.occurrence.shift));

      const countryCode = this.normalizeCountryCode(shift.countryCode);

      const currency = this.normalizeCurrency(shift.currency);

      const cycle = this.getPayoutCycleSnapshot({
        scheduledFor: entry.scheduledPayoutAt,

        timeZone: SHIFT_TIME_ZONE,
      });

      if (cycle.payoutWeekday !== DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY) {
        throw this.createError({
          message:
            "A settlement component is scheduled outside the configured Loqum payout weekday.",
          code: "COMPONENT_PAYOUT_WEEKDAY_MISMATCH",
          statusCode: 409,
          details: {
            occurrenceId: String(entry.occurrence._id),

            settlementComponent: entry.component,

            scheduledPayoutAt: entry.scheduledPayoutAt,
          },
        });
      }

      if (entry.approvedForReleaseAt > cycle.cutoffAt) {
        cutoffDeferrals.push({
          occurrenceId: entry.occurrence._id,

          professionalId: entry.occurrence.assignedProfessional,

          settlementComponent: entry.component,

          countryCode,
          currency,

          payoutDate: cycle.payoutDate,

          currentScheduledPayoutAt: cycle.scheduledFor,

          cutoffAt: cycle.cutoffAt,

          nextScheduledPayoutAt: this.calculateFollowingCycleAt({
            scheduledFor: cycle.scheduledFor,

            timeZone: cycle.timeZone,
          }),
        });

        continue;
      }

      const groupKey = [
        String(entry.occurrence.assignedProfessional),
        countryCode,
        currency,
        cycle.payoutDate,
        entry.component,
      ].join("|");

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          professionalId: entry.occurrence.assignedProfessional,

          countryCode,
          currency,

          settlementComponent: entry.component,

          cycle,

          entries: [],
        });
      }

      groups.get(groupKey).entries.push(entry);
    }

    return {
      groups: [...groups.values()],

      cutoffDeferrals,
    };
  }

  static async deferCutoffIneligibleComponents(deferrals) {
    if (!Array.isArray(deferrals) || deferrals.length === 0) {
      return [];
    }

    return runWithOptionalTransaction({}, async (session) => {
      const results = [];

      for (const deferral of deferrals) {
        const path = this.getComponentPath(deferral.settlementComponent);

        const updateResult = await ShiftOccurrence.updateOne(
          {
            _id: deferral.occurrenceId,

            [`${path}.status`]: "approved_for_release",

            [`${path}.settlementBatch`]: null,

            [`${path}.scheduledPayoutAt`]: deferral.currentScheduledPayoutAt,

            [`${path}.approvedForReleaseAt`]: {
              $gt: deferral.cutoffAt,
            },
          },

          {
            $set: {
              [`${path}.scheduledPayoutAt`]: deferral.nextScheduledPayoutAt,
            },
          },

          {
            session,
            runValidators: true,
          }
        );

        if (updateResult.modifiedCount === 1) {
          results.push({
            professionalId: String(deferral.professionalId),

            settlementComponent: deferral.settlementComponent,

            countryCode: deferral.countryCode,

            currency: deferral.currency,

            payoutDate: deferral.payoutDate,

            nextScheduledPayoutAt: deferral.nextScheduledPayoutAt,

            componentCount: 1,

            reason: "approved_after_cutoff",
          });
        }
      }

      return results;
    });
  }

  /* ─────────────────────────────── LINE BUILDING ─────────────────────────────── */

  static buildSettlementLines(entries, settlementComponent) {
    const normalizedComponent = this.normalizeComponent(settlementComponent);

    const lineMap = new Map();

    let totalProfessionalPay = 0;

    for (const entry of entries) {
      if (entry.component !== normalizedComponent) {
        throw this.createError({
          message:
            "A professional payout component batch cannot contain an earning from another settlement component.",
          code: "MIXED_SETTLEMENT_COMPONENT_BATCH_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      const pricing = this.assertComponentPricing({
        occurrence: entry.occurrence,

        component: normalizedComponent,

        audit: entry.audit,
      });

      const lineKey = [
        String(entry.occurrence.shift),

        String(entry.occurrence.assignment),

        String(entry.occurrence.business),

        String(entry.occurrence.branch),

        pricing.earningType,
      ].join("|");

      if (!lineMap.has(lineKey)) {
        lineMap.set(lineKey, {
          shift: entry.occurrence.shift,

          assignment: entry.occurrence.assignment,

          business: entry.occurrence.business,

          branch: entry.occurrence.branch,

          earningType: pricing.earningType,

          occurrences: [],

          occurrenceCount: 0,

          professionalPay: 0,
        });
      }

      const line = lineMap.get(lineKey);

      line.occurrences.push(entry.occurrence._id);

      line.occurrenceCount += 1;

      line.professionalPay = this.addSafeInteger(
        line.professionalPay,

        pricing.professionalPay,

        "Settlement line professional pay"
      );

      totalProfessionalPay = this.addSafeInteger(
        totalProfessionalPay,

        pricing.professionalPay,

        "Settlement batch professional pay"
      );
    }

    const lines = [...lineMap.values()].sort((left, right) => {
      const shiftComparison = String(left.shift).localeCompare(String(right.shift));

      if (shiftComparison !== 0) {
        return shiftComparison;
      }

      const assignmentComparison = String(left.assignment).localeCompare(String(right.assignment));

      if (assignmentComparison !== 0) {
        return assignmentComparison;
      }

      return String(left.earningType).localeCompare(String(right.earningType));
    });

    return {
      lines,

      occurrenceCount: entries.length,

      releaseKeys: this.getExpectedReleaseKeys(entries, normalizedComponent),

      totalProfessionalPay,
    };
  }

  /* ─────────────────────────────── WALLET RESOLUTION / RELEASE ─────────────────────────────── */

  static async resolveBatchWallets({ professionalId, countryCode, currency, session }) {
    const professional = await ProfessionalProfile.findById(professionalId)
      .select("countryCode currency")
      .session(session);

    if (!professional) {
      throw this.createError({
        message: "Professional profile required for payout was not found.",
        code: "SETTLEMENT_PROFESSIONAL_NOT_FOUND",
        statusCode: 404,
      });
    }

    const professionalCountryCode = this.normalizeCountryCode(professional.countryCode);

    const professionalCurrency = this.normalizeCurrency(professional.currency);

    if (professionalCountryCode !== countryCode || professionalCurrency !== currency) {
      throw this.createError({
        message: "Professional wallet country or currency does not match the payout batch.",
        code: "SETTLEMENT_PROFESSIONAL_CURRENCY_MISMATCH",
        statusCode: 409,
      });
    }

    const [professionalWallet, escrowWallet] = await Promise.all([
      WalletService.createProfessionalWalletIfMissing(professional, {
        session,
      }),

      WalletService.getEscrowWallet(
        {
          countryCode,
          currency,
        },

        {
          session,
        }
      ),
    ]);

    if (!escrowWallet) {
      throw this.createError({
        message: "The escrow wallet required for professional payout has not been configured.",
        code: "SETTLEMENT_ESCROW_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    WalletService.assertWalletIsActive(professionalWallet);

    WalletService.assertWalletIsActive(escrowWallet);

    WalletService.assertSameCountryAndCurrency(escrowWallet, professionalWallet);

    if (professionalWallet.ownerType !== "professional" || escrowWallet.ownerType !== "escrow") {
      throw this.createError({
        message: "Professional payout wallet ownership types are invalid.",
        code: "INVALID_SETTLEMENT_WALLET_TYPES",
        statusCode: 500,
      });
    }

    return {
      professional,
      professionalWallet,
      escrowWallet,
    };
  }

  static assertBatchWalletSnapshot({ batch, wallets }) {
    const matches =
      String(batch.professionalWallet) === String(wallets.professionalWallet._id) &&
      String(batch.escrowWallet) === String(wallets.escrowWallet._id);

    if (!matches) {
      throw this.createError({
        message: "Professional payout batch wallet references no longer match the active wallets.",
        code: "SETTLEMENT_BATCH_WALLET_MISMATCH",
        statusCode: 409,
      });
    }

    return true;
  }

  static assertBatchCycleSnapshot({ batch, cycle }) {
    const matches =
      batch.payoutDate === cycle.payoutDate &&
      batch.payoutWeekday === cycle.payoutWeekday &&
      batch.timeZone === cycle.timeZone &&
      new Date(batch.cutoffAt).getTime() === cycle.cutoffAt.getTime() &&
      new Date(batch.scheduledFor).getTime() === cycle.scheduledFor.getTime();

    if (!matches) {
      throw this.createError({
        message: "Existing settlement batch cycle no longer matches the payout schedule.",
        code: "SETTLEMENT_BATCH_CYCLE_MISMATCH",
        statusCode: 409,
      });
    }

    return true;
  }

  static assertEscrowOperationalCoverage({ batch, escrowWallet }) {
    const requiredAmount = Number(batch.totalProfessionalPay);

    const availableBalance = Number(escrowWallet.availableBalance || 0);

    if (!Number.isSafeInteger(requiredAmount) || requiredAmount <= 0) {
      throw this.createError({
        message: "Professional payout batch amount is invalid.",
        code: "INVALID_SETTLEMENT_BATCH_PROTECTED_AMOUNT",
        statusCode: 500,
      });
    }

    if (!Number.isSafeInteger(availableBalance) || availableBalance < 0) {
      throw this.createError({
        message: "Escrow wallet available balance is invalid.",
        code: "INVALID_ESCROW_AVAILABLE_BALANCE",
        statusCode: 500,
      });
    }

    if (availableBalance < requiredAmount) {
      throw this.createError({
        message:
          "Escrow does not contain enough operational liquidity for this professional payout batch.",
        code: "INSUFFICIENT_ESCROW_BALANCE_FOR_SETTLEMENT_BATCH",
        statusCode: 409,
        details: {
          availableBalance,
          requiredAmount,

          shortfall: requiredAmount - availableBalance,
        },
      });
    }

    return true;
  }

  static getBatchTransactionPurpose(type) {
    const purpose = SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE[type];

    if (!purpose) {
      throw this.createError({
        message: "Settlement-batch transaction purpose is not configured.",
        code: "SETTLEMENT_BATCH_TRANSACTION_PURPOSE_MISSING",
        statusCode: 500,
        details: {
          transactionType: type,
        },
      });
    }

    return purpose;
  }

  static assertTransferReferencesBatch({
    transferResult,
    batch,
    type,
    purpose,
    amount,
    groupReference,
    fromWallet,
    toWallet,
  }) {
    const debitTransaction = transferResult?.debit?.transaction;

    const creditTransaction = transferResult?.credit?.transaction;

    if (!debitTransaction || !creditTransaction) {
      throw this.createError({
        message: "A professional payout transfer is missing one side of its wallet ledger pair.",
        code: "SETTLEMENT_BATCH_TRANSFER_PAIR_INCOMPLETE",
        statusCode: 409,
      });
    }

    const commonMatches = (transaction) =>
      transaction.type === type &&
      transaction.purpose === purpose &&
      Number(transaction.amount) === Number(amount) &&
      String(transaction.settlementBatch || "") === String(batch._id) &&
      transaction.groupReference === groupReference &&
      transaction.paymentRail === "internal_transfer" &&
      transaction.provider === "internal" &&
      transaction.status === "completed" &&
      transaction.countryCode === batch.countryCode &&
      transaction.currency === batch.currency &&
      Number(transaction.providerFee || 0) === 0 &&
      Number(transaction.netAmount) === Number(amount) &&
      !transaction.shift &&
      !transaction.shiftOccurrence;

    const debitMatches =
      commonMatches(debitTransaction) &&
      debitTransaction.direction === "debit" &&
      String(debitTransaction.wallet) === String(fromWallet._id) &&
      String(debitTransaction.counterpartyWallet || "") === String(toWallet._id);

    const creditMatches =
      commonMatches(creditTransaction) &&
      creditTransaction.direction === "credit" &&
      String(creditTransaction.wallet) === String(toWallet._id) &&
      String(creditTransaction.counterpartyWallet || "") === String(fromWallet._id);

    const pairMatches =
      String(debitTransaction.relatedTransaction || "") === String(creditTransaction._id) &&
      String(creditTransaction.relatedTransaction || "") === String(debitTransaction._id);

    if (!debitMatches || !creditMatches || !pairMatches) {
      throw this.createError({
        message: "A professional payout transfer does not match the payout batch.",
        code: "SETTLEMENT_BATCH_TRANSFER_MISMATCH",
        statusCode: 409,
      });
    }

    return true;
  }

  static async releaseBatchWallets({ batch, occurrences, wallets, initiatedBy, session }) {
    this.assertBatchWalletSnapshot({
      batch,
      wallets,
    });

    this.assertEscrowOperationalCoverage({
      batch,
      escrowWallet: wallets.escrowWallet,
    });

    const releaseGroupReference = this.buildReleaseGroupReference(batch._id);

    const professionalPayoutPurpose = this.getBatchTransactionPurpose("professional_payout");

    const metadata = {
      settlementBatchId: String(batch._id),

      settlementBatchReferenceCode: batch.referenceCode,

      settlementComponent: batch.settlementComponent,

      professionalId: String(batch.professional),

      payoutDate: batch.payoutDate,

      occurrenceCount: occurrences.length,

      occurrenceIds: occurrences.map((occurrence) => String(occurrence._id)),

      releaseKeys: batch.releaseKeys || [],
    };

    const professionalPayout = await WalletService.transferBetweenWallets(
      {
        fromWalletId: wallets.escrowWallet._id,

        toWalletId: wallets.professionalWallet._id,

        amount: batch.totalProfessionalPay,

        type: "professional_payout",

        purpose: professionalPayoutPurpose,

        paymentRail: "internal_transfer",

        groupReference: releaseGroupReference,

        ...this.buildReleaseIdempotencyKeys({
          batchId: batch._id,

          releaseType: "professional-payout",
        }),

        settlementBatch: batch._id,

        initiatedBy,

        description:
          `${batch.settlementComponent.toUpperCase()} ` +
          `professional payout for settlement batch ` +
          `${batch.referenceCode}.`,

        metadata: {
          ...metadata,

          professionalPay: batch.totalProfessionalPay,
        },
      },

      {
        session,
      }
    );

    this.assertTransferReferencesBatch({
      transferResult: professionalPayout,

      batch,

      type: "professional_payout",

      purpose: professionalPayoutPurpose,

      amount: batch.totalProfessionalPay,

      groupReference: releaseGroupReference,

      fromWallet: wallets.escrowWallet,

      toWallet: wallets.professionalWallet,
    });

    return {
      releaseGroupReference,
      professionalPayout,

      idempotent: professionalPayout.idempotent === true,
    };
  }

  /* ─────────────────────────────── COMPONENT ATTACHMENT ─────────────────────────────── */

  static async loadFreshEligibleEntries({
    occurrenceIds,
    professionalId,
    settlementComponent,
    scheduledFor,
    cutoffAt,
    currentTime,
    session,
  }) {
    const normalizedComponent = this.normalizeComponent(settlementComponent);

    const path = this.getComponentPath(normalizedComponent);

    const occurrences = await ShiftOccurrence.find({
      _id: {
        $in: occurrenceIds,
      },

      assignedProfessional: professionalId,

      assignmentStatus: "assigned",

      assignment: {
        $ne: null,
      },

      assignedAt: {
        $ne: null,
      },

      [`${path}.status`]: "approved_for_release",

      [`${path}.approvedForReleaseAt`]: {
        $ne: null,
        $lte: cutoffAt,
      },

      [`${path}.scheduledPayoutAt`]: scheduledFor,

      [`${path}.settlementBatch`]: null,

      [`${path}.professionalPay`]: {
        $gt: 0,
      },
    })
      .select(this.getOccurrenceSettlementFields())
      .sort({
        shift: 1,
        sequenceNumber: 1,
      })
      .session(session);

    const entries = [];

    for (const occurrence of occurrences) {
      this.assertCompleteAssignment(occurrence, professionalId);

      this.assertComponentOperationalShape(occurrence, normalizedComponent);

      const finality = await this.isComponentFinalForBatch({
        occurrence,

        component: normalizedComponent,

        currentTime,

        session,
      });

      if (!finality.final) {
        continue;
      }

      if (finality.synchronization?.idempotent === false) {
        await occurrence.save({
          session,
        });
      }

      const entry = this.buildComponentEntry({
        occurrence,

        component: normalizedComponent,
      });

      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  static async attachEntriesToBatch({ batch, entries, releasePendingAt, session }) {
    const component = this.normalizeComponent(batch.settlementComponent);

    const path = this.getComponentPath(component);

    for (const entry of entries) {
      const occurrence = entry.occurrence;

      const audit = occurrence[path];

      if (
        audit.status !== "approved_for_release" ||
        audit.settlementBatch ||
        String(occurrence.assignedProfessional) !== String(batch.professional)
      ) {
        throw this.createError({
          message: "An approved professional payout component changed before batch attachment.",
          code: "SETTLEMENT_COMPONENT_ATTACHMENT_CONFLICT",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            settlementComponent: component,
          },
        });
      }

      audit.status = "release_pending";

      audit.settlementBatch = batch._id;

      audit.releasePendingAt = releasePendingAt;

      await this.synchronizeOccurrenceSettlementSummary({
        occurrence,

        currentTime: releasePendingAt,

        session,
      });

      await occurrence.save({
        session,
      });
    }

    return entries.length;
  }

  static async deferComponentsToFollowingCycle({
    occurrenceIds,
    settlementComponent,
    scheduledFor,
    timeZone,
    session,
  }) {
    const component = this.normalizeComponent(settlementComponent);

    const path = this.getComponentPath(component);

    const nextScheduledPayoutAt = this.calculateFollowingCycleAt({
      scheduledFor,
      timeZone,
    });

    const result = await ShiftOccurrence.updateMany(
      {
        _id: {
          $in: occurrenceIds,
        },

        [`${path}.status`]: "approved_for_release",

        [`${path}.settlementBatch`]: null,
      },

      {
        $set: {
          [`${path}.scheduledPayoutAt`]: nextScheduledPayoutAt,
        },
      },

      {
        session,
        runValidators: true,
      }
    );

    return {
      nextScheduledPayoutAt,

      deferredComponentCount: result.modifiedCount,
    };
  }

  /* ─────────────────────────────── BATCH CREATION ─────────────────────────────── */

  static async getEntriesForExistingBatch(batch, session) {
    const occurrenceIds = batch.lines.flatMap((line) => line.occurrences);

    if (occurrenceIds.length === 0) {
      return [];
    }

    const occurrences = await ShiftOccurrence.find({
      _id: {
        $in: occurrenceIds,
      },
    })
      .select(this.getOccurrenceSettlementFields())
      .sort({
        shift: 1,
        sequenceNumber: 1,
      })
      .session(session);

    if (occurrences.length !== occurrenceIds.length) {
      throw this.createError({
        message: "An occurrence already recorded in the payout batch was not found.",
        code: "SETTLEMENT_BATCH_REBUILD_OCCURRENCE_MISSING",
        statusCode: 409,
      });
    }

    return occurrences.map((occurrence) => {
      const audit = this.getComponentAudit(occurrence, batch.settlementComponent);

      if (
        !audit ||
        audit.status !== "release_pending" ||
        String(audit.settlementBatch || "") !== String(batch._id)
      ) {
        throw this.createError({
          message:
            "An existing scheduled batch occurrence no longer matches its attached payout component.",
          code: "SETTLEMENT_BATCH_EXISTING_COMPONENT_MISMATCH",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            settlementComponent: batch.settlementComponent,
          },
        });
      }

      this.assertCompleteAssignment(occurrence, batch.professional);

      this.assertComponentOperationalShape(occurrence, batch.settlementComponent);

      const pricing = this.assertComponentPricing({
        occurrence,

        component: batch.settlementComponent,

        audit,
      });

      return {
        occurrence,

        component: batch.settlementComponent,

        audit,

        approvedForReleaseAt: audit.approvedForReleaseAt,

        scheduledPayoutAt: audit.scheduledPayoutAt,

        ...pricing,
      };
    });
  }

  static async createBatchForGroup(group, options = {}) {
    return runWithOptionalTransaction(
      options,

      async (session) => {
        const component = this.normalizeComponent(group.settlementComponent);

        const occurrenceIds = group.entries.map((entry) => entry.occurrence._id);

        const releaseEligibilityTime = this.normalizeDate(
          group.releaseEligibilityCheckedAt || new Date(),

          "Settlement release eligibility time"
        );

        const lockedEntries = await this.loadFreshEligibleEntries({
          occurrenceIds,

          professionalId: group.professionalId,

          settlementComponent: component,

          scheduledFor: group.cycle.scheduledFor,

          cutoffAt: group.cycle.cutoffAt,

          currentTime: releaseEligibilityTime,

          session,
        });

        if (lockedEntries.length === 0) {
          return {
            created: false,
            idempotent: true,

            reason: "no_eligible_components",
          };
        }

        const cycleKey = this.buildCycleKey({
          countryCode: group.countryCode,

          currency: group.currency,

          payoutDate: group.cycle.payoutDate,
        });

        const existingBatch = await ShiftSettlementBatch.findOne({
          professional: group.professionalId,

          countryCode: group.countryCode,

          currency: group.currency,

          cycleKey,

          settlementComponent: component,
        })
          .select("+idempotencyKey +processingToken")
          .session(session);

        if (existingBatch) {
          this.assertBatchCycleSnapshot({
            batch: existingBatch,

            cycle: group.cycle,
          });

          if (existingBatch.status === "scheduled") {
            const alreadyIncludedIds = new Set(
              existingBatch.lines.flatMap((line) =>
                line.occurrences.map((occurrenceId) => String(occurrenceId))
              )
            );

            const newEntries = lockedEntries.filter(
              (entry) => !alreadyIncludedIds.has(String(entry.occurrence._id))
            );

            if (newEntries.length === 0) {
              return {
                batch: existingBatch,

                created: false,

                idempotent: true,

                appendedComponentCount: 0,
              };
            }

            const existingEntries = await this.getEntriesForExistingBatch(existingBatch, session);

            const allEntries = [...existingEntries, ...newEntries];

            const rebuilt = this.buildSettlementLines(allEntries, component);

            existingBatch.lines = rebuilt.lines;

            existingBatch.occurrenceCount = rebuilt.occurrenceCount;

            existingBatch.releaseKeys = rebuilt.releaseKeys;

            existingBatch.totalProfessionalPay = rebuilt.totalProfessionalPay;

            await existingBatch.save({
              session,
            });

            const attachedCount = await this.attachEntriesToBatch({
              batch: existingBatch,

              entries: newEntries,

              releasePendingAt: releaseEligibilityTime,

              session,
            });

            if (attachedCount !== newEntries.length) {
              throw this.createError({
                message:
                  "Approved professional payout components changed before they could be appended to the payout batch.",
                code: "SETTLEMENT_BATCH_APPEND_CONFLICT",
                statusCode: 409,
              });
            }

            return {
              batch: existingBatch,

              created: false,
              idempotent: false,

              appendedComponentCount: newEntries.length,
            };
          }

          const deferred = await this.deferComponentsToFollowingCycle({
            occurrenceIds: lockedEntries.map((entry) => entry.occurrence._id),

            settlementComponent: component,

            scheduledFor: group.cycle.scheduledFor,

            timeZone: group.cycle.timeZone,

            session,
          });

          return {
            batch: existingBatch,

            created: false,
            idempotent: false,

            deferred: true,

            ...deferred,
          };
        }

        const wallets = await this.resolveBatchWallets({
          professionalId: group.professionalId,

          countryCode: group.countryCode,

          currency: group.currency,

          session,
        });

        const settlement = this.buildSettlementLines(lockedEntries, component);

        const referenceCode = this.buildBatchReferenceCode({
          countryCode: group.countryCode,

          currency: group.currency,

          payoutDate: group.cycle.payoutDate,

          professionalId: group.professionalId,

          settlementComponent: component,
        });

        const idempotencyKey = this.buildBatchIdempotencyKey({
          countryCode: group.countryCode,

          currency: group.currency,

          payoutDate: group.cycle.payoutDate,

          professionalId: group.professionalId,

          settlementComponent: component,
        });

        const batch = new ShiftSettlementBatch({
          referenceCode,
          cycleKey,

          settlementComponent: component,

          idempotencyKey,

          professional: group.professionalId,

          professionalWallet: wallets.professionalWallet._id,

          escrowWallet: wallets.escrowWallet._id,

          countryCode: group.countryCode,

          currency: group.currency,

          payoutDate: group.cycle.payoutDate,

          payoutWeekday: group.cycle.payoutWeekday,

          timeZone: group.cycle.timeZone,

          cutoffAt: group.cycle.cutoffAt,

          scheduledFor: group.cycle.scheduledFor,

          lines: settlement.lines,

          occurrenceCount: settlement.occurrenceCount,

          releaseKeys: settlement.releaseKeys,

          totalProfessionalPay: settlement.totalProfessionalPay,

          status: "scheduled",

          attemptCount: 0,

          initiatedBy: {
            role: "system",
            userId: null,
          },
        });

        await batch.save({
          session,
        });

        const attachedCount = await this.attachEntriesToBatch({
          batch,

          entries: lockedEntries,

          releasePendingAt: releaseEligibilityTime,

          session,
        });

        if (attachedCount !== lockedEntries.length) {
          throw this.createError({
            message:
              "Approved professional payout components changed before the payout batch could be attached.",
            code: "SETTLEMENT_BATCH_ATTACHMENT_CONFLICT",
            statusCode: 409,
            details: {
              expected: lockedEntries.length,

              attached: attachedCount,
            },
          });
        }

        logger.info(
          `Professional payout batch ${batch.referenceCode} ` +
            `created for ${component} with ` +
            `${batch.occurrenceCount} occurrence components`
        );

        return {
          batch,

          created: true,
          idempotent: false,

          appendedComponentCount: 0,
        };
      }
    );
  }

  static async createDueSettlementBatches({
    now = new Date(),
    occurrenceLimit = DEFAULT_BATCH_QUERY_LIMIT,
  } = {}) {
    const dueEntries = await this.getDueComponentEntries({
      now,
      limit: occurrenceLimit,
    });

    if (dueEntries.length === 0) {
      return {
        inspectedComponentCount: 0,
        groupCount: 0,

        created: [],
        updated: [],
        deferred: [],
        failed: [],
      };
    }

    const shiftMap = await this.loadShiftFinancialContexts(dueEntries);

    const { groups, cutoffDeferrals } = this.groupDueComponentEntries({
      entries: dueEntries,

      shiftMap,
    });

    for (const group of groups) {
      group.releaseEligibilityCheckedAt = this.normalizeDate(now, "Settlement grouping time");
    }

    const cutoffDeferralResults = await this.deferCutoffIneligibleComponents(cutoffDeferrals);

    const results = {
      inspectedComponentCount: dueEntries.length,

      groupCount: groups.length,

      created: [],
      updated: [],

      deferred: [...cutoffDeferralResults],

      failed: [],
    };

    for (const group of groups) {
      try {
        const result = await this.createBatchForGroup(group);

        if (result.deferred) {
          results.deferred.push({
            professionalId: String(group.professionalId),

            settlementComponent: group.settlementComponent,

            countryCode: group.countryCode,

            currency: group.currency,

            payoutDate: group.cycle.payoutDate,

            nextScheduledPayoutAt: result.nextScheduledPayoutAt,

            componentCount: result.deferredComponentCount,

            reason: "component_batch_already_closed",
          });
        } else if (result.created) {
          results.created.push({
            batchId: String(result.batch._id),

            referenceCode: result.batch.referenceCode,

            settlementComponent: result.batch.settlementComponent,

            professionalId: String(result.batch.professional),

            occurrenceCount: result.batch.occurrenceCount,

            totalProfessionalPay: result.batch.totalProfessionalPay,
          });
        } else if (result.batch) {
          results.updated.push({
            batchId: String(result.batch._id),

            referenceCode: result.batch.referenceCode,

            settlementComponent: result.batch.settlementComponent,

            appendedComponentCount: result.appendedComponentCount || 0,

            idempotent: result.idempotent === true,
          });
        }
      } catch (error) {
        logger.error(
          `Professional payout batch creation failed for professional ` +
            `${group.professionalId} ` +
            `component ${group.settlementComponent}: ` +
            `${error.code || "UNKNOWN"} - ` +
            `${error.message}`
        );

        results.failed.push({
          professionalId: String(group.professionalId),

          settlementComponent: group.settlementComponent,

          countryCode: group.countryCode,

          currency: group.currency,

          payoutDate: group.cycle.payoutDate,

          componentCount: group.entries.length,

          code: error.code || "SETTLEMENT_BATCH_CREATION_FAILED",

          message: error.message,
        });
      }
    }

    return results;
  }

  /* ─────────────────────────────── RELEASE VALIDATION ─────────────────────────────── */

  static getBatchOccurrenceIds(batch) {
    return batch.lines.flatMap((line) => line.occurrences.map((occurrenceId) => occurrenceId));
  }

  static async getBatchOccurrences(batch, session, currentTime = new Date()) {
    const normalizedCurrentTime = this.normalizeDate(
      currentTime,
      "Settlement release validation time"
    );

    const component = this.normalizeComponent(batch.settlementComponent);

    const occurrenceIds = this.getBatchOccurrenceIds(batch);

    const occurrences = await ShiftOccurrence.find({
      _id: {
        $in: occurrenceIds,
      },
    })
      .select(this.getOccurrenceSettlementFields())
      .sort({
        shift: 1,
        sequenceNumber: 1,
      })
      .session(session);

    if (occurrences.length !== batch.occurrenceCount) {
      throw this.createError({
        message:
          "Settlement batch occurrence count does not match its professional payout component entries.",
        code: "SETTLEMENT_BATCH_OCCURRENCE_COUNT_MISMATCH",
        statusCode: 409,
        details: {
          expected: batch.occurrenceCount,

          actual: occurrences.length,
        },
      });
    }

    const expectedOccurrenceIds = new Set(occurrenceIds.map(String));

    const actualOccurrenceIds = new Set(occurrences.map((occurrence) => String(occurrence._id)));

    if (
      expectedOccurrenceIds.size !== actualOccurrenceIds.size ||
      [...expectedOccurrenceIds].some((occurrenceId) => !actualOccurrenceIds.has(occurrenceId))
    ) {
      throw this.createError({
        message: "Settlement batch occurrence references do not match its loaded occurrences.",
        code: "SETTLEMENT_BATCH_OCCURRENCE_SET_MISMATCH",
        statusCode: 409,
      });
    }

    const entries = [];

    for (const occurrence of occurrences) {
      this.assertCompleteAssignment(occurrence, batch.professional);

      this.assertComponentOperationalShape(occurrence, component);

      const finality = await this.isComponentFinalForBatch({
        occurrence,
        component,

        currentTime: normalizedCurrentTime,

        session,
      });

      if (!finality.final) {
        throw this.createError({
          message: "A batch component is no longer final and cannot be released.",
          code: "SETTLEMENT_BATCH_COMPONENT_FINALITY_CONFLICT",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            settlementComponent: component,
          },
        });
      }

      if (finality.synchronization?.idempotent === false) {
        await occurrence.save({
          session,
        });
      }

      const audit = this.getComponentAudit(occurrence, component);

      if (
        !audit ||
        audit.status !== "release_pending" ||
        String(audit.settlementBatch || "") !== String(batch._id) ||
        !audit.releasePendingAt
      ) {
        throw this.createError({
          message: "A professional payout component no longer matches its attached payout batch.",
          code: "SETTLEMENT_BATCH_COMPONENT_ATTACHMENT_MISMATCH",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            settlementComponent: component,

            componentStatus: audit?.status || null,

            settlementBatch: audit?.settlementBatch ? String(audit.settlementBatch) : null,
          },
        });
      }

      if (
        !audit.approvedForReleaseAt ||
        new Date(audit.approvedForReleaseAt) > new Date(batch.cutoffAt)
      ) {
        throw this.createError({
          message:
            "A professional payout component attached to the batch was approved after the batch cutoff.",
          code: "SETTLEMENT_BATCH_COMPONENT_AFTER_CUTOFF",
          statusCode: 409,
          details: {
            occurrenceId: String(occurrence._id),

            settlementComponent: component,

            approvedForReleaseAt: audit?.approvedForReleaseAt || null,

            cutoffAt: batch.cutoffAt,
          },
        });
      }

      const pricing = this.assertComponentPricing({
        occurrence,
        component,
        audit,
      });

      entries.push({
        occurrence,
        component,
        audit,

        approvedForReleaseAt: audit.approvedForReleaseAt,

        scheduledPayoutAt: audit.scheduledPayoutAt,

        ...pricing,
      });
    }

    const rebuilt = this.buildSettlementLines(entries, component);

    const expectedKeys = [...(batch.releaseKeys || [])].sort();

    const rebuiltKeys = [...rebuilt.releaseKeys].sort();

    const releaseKeysMatch =
      expectedKeys.length === rebuiltKeys.length &&
      expectedKeys.every((key, index) => key === rebuiltKeys[index]);

    if (
      rebuilt.occurrenceCount !== batch.occurrenceCount ||
      rebuilt.totalProfessionalPay !== batch.totalProfessionalPay ||
      !releaseKeysMatch
    ) {
      throw this.createError({
        message:
          "Professional payout batch totals or component reservations no longer match its occurrences.",
        code: "SETTLEMENT_BATCH_COMPONENT_TOTAL_MISMATCH",
        statusCode: 409,
      });
    }

    return {
      occurrences,
      entries,
    };
  }

  /* ─────────────────────────────── BATCH PROCESSING CLAIM ─────────────────────────────── */

  static async claimBatchForProcessing({
    batchId,
    now = new Date(),
    maximumAttempts = DEFAULT_MAX_PROCESSING_ATTEMPTS,
    session,
  }) {
    const normalizedBatchId = this.normalizeObjectId(batchId, "Settlement batch ID");

    const normalizedNow = this.normalizeDate(now, "Settlement processing time");

    const normalizedMaximumAttempts = this.normalizePositiveInteger(
      maximumAttempts,
      "Maximum settlement attempts",
      20
    );

    const processingToken = randomUUID();

    const batch = await ShiftSettlementBatch.findOneAndUpdate(
      {
        _id: normalizedBatchId,

        status: {
          $in: ["scheduled", "failed"],
        },

        scheduledFor: {
          $lte: normalizedNow,
        },

        attemptCount: {
          $lt: normalizedMaximumAttempts,
        },
      },

      {
        $set: {
          status: "processing",

          processingStartedAt: normalizedNow,

          processingToken,

          lastAttemptAt: normalizedNow,

          failedAt: null,

          failureReason: null,

          cancelledAt: null,
          cancelledBy: null,

          cancellationReason: null,
        },

        $inc: {
          attemptCount: 1,
        },
      },

      {
        new: true,
        session,
        runValidators: true,
      }
    ).select("+processingToken +idempotencyKey");

    if (batch) {
      return batch;
    }

    const existingBatch = await ShiftSettlementBatch.findById(normalizedBatchId)
      .select("+processingToken +idempotencyKey")
      .session(session);

    if (!existingBatch) {
      throw this.createError({
        message: "Settlement batch was not found.",
        code: "SETTLEMENT_BATCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (existingBatch.status === "released") {
      return existingBatch;
    }

    if (existingBatch.status === "processing") {
      throw this.createError({
        message: "Settlement batch is already being processed.",
        code: "SETTLEMENT_BATCH_ALREADY_PROCESSING",
        statusCode: 409,
      });
    }

    if (existingBatch.status === "cancelled") {
      throw this.createError({
        message: "A cancelled settlement batch cannot be processed.",
        code: "SETTLEMENT_BATCH_CANCELLED",
        statusCode: 409,
      });
    }

    if (existingBatch.scheduledFor > normalizedNow) {
      throw this.createError({
        message: "Settlement batch is not due yet.",
        code: "SETTLEMENT_BATCH_NOT_DUE",
        statusCode: 409,
        details: {
          scheduledFor: existingBatch.scheduledFor,
        },
      });
    }

    throw this.createError({
      message: "Settlement batch has reached its processing attempt limit.",
      code: "SETTLEMENT_BATCH_ATTEMPT_LIMIT_REACHED",
      statusCode: 409,
      details: {
        attemptCount: existingBatch.attemptCount,

        maximumAttempts: normalizedMaximumAttempts,
      },
    });
  }

  static async markBatchFailed({
    batchId,
    error,
    attemptedAt,
    maximumAttempts = DEFAULT_MAX_PROCESSING_ATTEMPTS,
  }) {
    const normalizedBatchId = this.normalizeObjectId(batchId, "Settlement batch ID");

    const attemptTime = this.normalizeDate(attemptedAt, "Settlement failed-attempt time");

    const normalizedMaximumAttempts = this.normalizePositiveInteger(
      maximumAttempts,
      "Maximum settlement attempts",
      20
    );

    const failureReason = this.shortenFailureReason(error?.message || error);

    const batch = await ShiftSettlementBatch.findById(normalizedBatchId).select(
      "+processingToken +idempotencyKey"
    );

    if (!batch || ["released", "cancelled"].includes(batch.status)) {
      return null;
    }

    /**
     * Never overwrite a currently committed processing lock.
     *
     * That could belong to another worker.
     */
    if (batch.status === "processing") {
      return batch;
    }

    if (Number(batch.attemptCount || 0) >= normalizedMaximumAttempts) {
      return batch;
    }

    /**
     * releaseBatch claims the batch inside the same transaction as the payout.
     *
     * If that transaction fails, the temporary processing claim rolls back.
     *
     * We therefore record this failed attempt explicitly here after rollback.
     */
    batch.status = "failed";

    batch.attemptCount = Number(batch.attemptCount || 0) + 1;

    batch.processingStartedAt = attemptTime;

    batch.lastAttemptAt = attemptTime;

    batch.processingToken = null;

    batch.failedAt = new Date(Math.max(Date.now(), attemptTime.getTime()));

    batch.failureReason = failureReason;

    batch.releasedAt = null;

    batch.cancelledAt = null;
    batch.cancelledBy = null;

    batch.cancellationReason = null;

    await batch.save();

    return batch;
  }

  /* ─────────────────────────────── COMPONENT RELEASE ─────────────────────────────── */

  static async applyReleasedComponentAudit({
    occurrence,
    batch,
    releasedAt,
    professionalPayoutTransaction,
    session,
  }) {
    const component = this.normalizeComponent(batch.settlementComponent);

    const path = this.getComponentPath(component);

    const audit = occurrence[path];

    if (
      !audit ||
      audit.status !== "release_pending" ||
      String(audit.settlementBatch || "") !== String(batch._id)
    ) {
      throw this.createError({
        message: "The professional payout component is no longer release-pending for this batch.",
        code: "SETTLEMENT_COMPONENT_RELEASE_STATE_CONFLICT",
        statusCode: 409,
        details: {
          occurrenceId: String(occurrence._id),

          settlementComponent: component,
        },
      });
    }

    audit.status = "released";

    audit.releasedAt = releasedAt;

    audit.payoutTransaction = professionalPayoutTransaction;

    /**
     * settlementBatch remains the permanent audit link to the professional
     * payout batch.
     *
     * Refunds and parent reconciliation are deliberately not invoked here.
     */
    await this.synchronizeOccurrenceSettlementSummary({
      occurrence,

      currentTime: releasedAt,

      session,
    });

    await occurrence.save({
      session,
    });

    return {
      occurrence,

      settlementComponent: component,

      /**
       * Signals for the external orchestration/reconciliation layer.
       *
       * #14 itself performs neither operation.
       */
      refundEvaluationRequired: component === "base",

      parentReconciliationRequired: true,
    };
  }

  static async releaseBatch(
    {
      batchId,

      now = new Date(),

      maximumAttempts = DEFAULT_MAX_PROCESSING_ATTEMPTS,

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },

    options = {}
  ) {
    const normalizedBatchId = this.normalizeObjectId(batchId, "Settlement batch ID");

    const normalizedNow = this.normalizeDate(now, "Settlement processing time");

    const normalizedInitiatedBy = this.normalizeInitiatedBy(initiatedBy);

    try {
      return await runWithOptionalTransaction(
        options,

        async (session) => {
          const batch = await this.claimBatchForProcessing({
            batchId: normalizedBatchId,

            now: normalizedNow,

            maximumAttempts,

            session,
          });

          if (batch.status === "released") {
            return {
              batch,
              idempotent: true,
            };
          }

          const { occurrences } = await this.getBatchOccurrences(batch, session, normalizedNow);

          const wallets = await this.resolveBatchWallets({
            professionalId: batch.professional,

            countryCode: batch.countryCode,

            currency: batch.currency,

            session,
          });

          const releaseResult = await this.releaseBatchWallets({
            batch,
            occurrences,
            wallets,

            initiatedBy: normalizedInitiatedBy,

            session,
          });

          const releasedAt = normalizedNow;

          batch.status = "released";

          batch.releasedAt = releasedAt;

          batch.failedAt = null;

          batch.failureReason = null;

          /**
           * Historical execution audit is retained.
           */
          batch.processingToken = null;

          batch.cancelledAt = null;

          batch.cancelledBy = null;

          batch.cancellationReason = null;

          batch.professionalPayout = {
            groupReference: releaseResult.releaseGroupReference,

            debitTransaction: releaseResult.professionalPayout.debit.transaction._id,

            creditTransaction: releaseResult.professionalPayout.credit.transaction._id,
          };

          await batch.save({
            session,
          });

          const professionalPayoutTransaction =
            releaseResult.professionalPayout.credit.transaction._id;

          const componentReleaseResults = [];

          for (const occurrence of occurrences) {
            const result = await this.applyReleasedComponentAudit({
              occurrence,
              batch,
              releasedAt,

              professionalPayoutTransaction,

              session,
            });

            componentReleaseResults.push({
              occurrenceId: String(occurrence._id),

              settlementComponent: result.settlementComponent,

              refundEvaluationRequired: result.refundEvaluationRequired,

              parentReconciliationRequired: result.parentReconciliationRequired,
            });
          }

          const affectedShiftIds = [
            ...new Set(occurrences.map((occurrence) => String(occurrence.shift))),
          ];

          logger.info(
            `Settlement batch ${batch.referenceCode} released ` +
              `${batch.settlementComponent} professional earnings to ` +
              `professional ${batch.professional}`
          );

          return {
            batch,
            occurrences,

            releaseResult,

            componentReleaseResults,

            idempotent: releaseResult.idempotent === true,

            affectedShiftIds,

            events: [
              {
                type: "shift_settlement_batch_released",

                batchId: String(batch._id),

                settlementComponent: batch.settlementComponent,

                professionalId: String(batch.professional),

                occurrenceCount: batch.occurrenceCount,

                totalProfessionalPay: batch.totalProfessionalPay,

                releasedAt,
              },
            ],
          };
        }
      );
    } catch (error) {
      if (
        !options.session &&
        ![
          "SETTLEMENT_BATCH_ALREADY_PROCESSING",
          "SETTLEMENT_BATCH_NOT_DUE",
          "SETTLEMENT_BATCH_CANCELLED",
          "SETTLEMENT_BATCH_ATTEMPT_LIMIT_REACHED",
          "SETTLEMENT_BATCH_NOT_FOUND",
        ].includes(error.code)
      ) {
        await this.markBatchFailed({
          batchId: normalizedBatchId,

          error,

          attemptedAt: normalizedNow,

          maximumAttempts,
        });
      }

      throw error;
    }
  }

  static async processDueBatches({
    now = new Date(),
    limit = DEFAULT_PROCESSING_LIMIT,
    maximumAttempts = DEFAULT_MAX_PROCESSING_ATTEMPTS,
  } = {}) {
    const normalizedNow = this.normalizeDate(now, "Settlement processing time");

    const normalizedLimit = this.normalizePositiveInteger(
      limit,
      "Settlement processing limit",
      1000
    );

    const normalizedMaximumAttempts = this.normalizePositiveInteger(
      maximumAttempts,
      "Maximum settlement attempts",
      20
    );

    const dueBatches = await ShiftSettlementBatch.find({
      status: {
        $in: ["scheduled", "failed"],
      },

      scheduledFor: {
        $lte: normalizedNow,
      },

      attemptCount: {
        $lt: normalizedMaximumAttempts,
      },
    })
      .select("referenceCode professional settlementComponent scheduledFor attemptCount")
      .sort({
        scheduledFor: 1,
        settlementComponent: 1,
        attemptCount: 1,
        _id: 1,
      })
      .limit(normalizedLimit)
      .lean();

    const results = {
      inspected: dueBatches.length,

      released: [],
      failed: [],
    };

    for (const batch of dueBatches) {
      try {
        const result = await this.releaseBatch({
          batchId: batch._id,

          now: normalizedNow,

          maximumAttempts: normalizedMaximumAttempts,
        });

        results.released.push({
          batchId: String(result.batch._id),

          referenceCode: result.batch.referenceCode,

          settlementComponent: result.batch.settlementComponent,

          professionalId: String(result.batch.professional),

          occurrenceCount: result.batch.occurrenceCount,

          totalProfessionalPay: result.batch.totalProfessionalPay,

          idempotent: result.idempotent === true,
        });
      } catch (error) {
        logger.error(
          `Settlement batch ${batch.referenceCode} ` +
            `(${batch.settlementComponent}) failed: ` +
            `${error.code || "UNKNOWN"} - ` +
            `${error.message}`
        );

        results.failed.push({
          batchId: String(batch._id),

          referenceCode: batch.referenceCode,

          settlementComponent: batch.settlementComponent,

          professionalId: String(batch.professional),

          code: error.code || "SETTLEMENT_BATCH_RELEASE_FAILED",

          message: error.message,
        });
      }
    }

    return results;
  }

  /* ─────────────────────────────── BATCH CANCELLATION ─────────────────────────────── */

  static async cancelScheduledBatch(
    {
      batchId,

      cancelledByUserId,

      cancellationReason,

      currentTime = new Date(),
    },

    options = {}
  ) {
    const normalizedBatchId = this.normalizeObjectId(batchId, "Settlement batch ID");

    const cancelledBy = this.normalizeObjectId(cancelledByUserId, "cancelled-by user ID");

    const reason = this.normalizeRequiredText(
      cancellationReason,

      "Settlement batch cancellation reason",

      MAX_SETTLEMENT_BATCH_CANCELLATION_REASON_LENGTH
    );

    const now = this.normalizeDate(currentTime, "Settlement batch cancellation time");

    return runWithOptionalTransaction(
      options,

      async (session) => {
        const batch = await ShiftSettlementBatch.findById(normalizedBatchId)
          .select("+processingToken +idempotencyKey")
          .session(session);

        if (!batch) {
          throw this.createError({
            message: "Settlement batch was not found.",
            code: "SETTLEMENT_BATCH_NOT_FOUND",
            statusCode: 404,
          });
        }

        if (batch.status === "cancelled") {
          return {
            batch,

            cancelled: true,
            idempotent: true,
          };
        }

        if (batch.status !== "scheduled") {
          throw this.createError({
            message: "Only a scheduled settlement batch can be cancelled safely.",
            code: "SETTLEMENT_BATCH_NOT_CANCELLABLE",
            statusCode: 409,
            details: {
              status: batch.status,
            },
          });
        }

        const component = this.normalizeComponent(batch.settlementComponent);

        const path = this.getComponentPath(component);

        const occurrenceIds = this.getBatchOccurrenceIds(batch);

        const occurrences = await ShiftOccurrence.find({
          _id: {
            $in: occurrenceIds,
          },
        })
          .select(this.getOccurrenceSettlementFields())
          .session(session);

        if (occurrences.length !== batch.occurrenceCount) {
          throw this.createError({
            message: "Settlement batch occurrences are incomplete and cannot be safely cancelled.",
            code: "SETTLEMENT_BATCH_CANCELLATION_OCCURRENCE_MISMATCH",
            statusCode: 409,
          });
        }

        const nextScheduledPayoutAt = this.calculateFollowingCycleAt({
          scheduledFor: batch.scheduledFor,

          timeZone: batch.timeZone,
        });

        for (const occurrence of occurrences) {
          const audit = occurrence[path];

          if (
            !audit ||
            audit.status !== "release_pending" ||
            String(audit.settlementBatch || "") !== String(batch._id)
          ) {
            throw this.createError({
              message:
                "A professional payout component no longer matches the scheduled batch being cancelled.",
              code: "SETTLEMENT_BATCH_CANCELLATION_COMPONENT_CONFLICT",
              statusCode: 409,
              details: {
                occurrenceId: String(occurrence._id),

                settlementComponent: component,
              },
            });
          }

          audit.status = "approved_for_release";

          audit.settlementBatch = null;

          audit.releasePendingAt = null;

          audit.scheduledPayoutAt = nextScheduledPayoutAt;

          await this.synchronizeOccurrenceSettlementSummary({
            occurrence,

            currentTime: now,

            session,
          });

          await occurrence.save({
            session,
          });
        }

        batch.status = "cancelled";

        batch.cancelledAt = now;

        batch.cancelledBy = cancelledBy;

        batch.cancellationReason = reason;

        /**
         * processingStartedAt is historical audit and is not erased here.
         *
         * A normally scheduled never-attempted batch simply has null.
         */
        batch.processingToken = null;

        batch.releasedAt = null;

        batch.failedAt = null;

        batch.failureReason = null;

        /**
         * Cancelled batches surrender their unique occurrence-component
         * reservations so the earnings may enter a future payout batch.
         */
        batch.releaseKeys = undefined;

        await batch.save({
          session,
        });

        return {
          batch,

          cancelled: true,
          idempotent: false,

          nextScheduledPayoutAt,

          /**
           * Reconciliation is intentionally left to #16.
           */
          affectedShiftIds: [...new Set(occurrences.map((occurrence) => String(occurrence.shift)))],

          events: [
            {
              type: "shift_settlement_batch_cancelled",

              batchId: String(batch._id),

              settlementComponent: component,

              professionalId: String(batch.professional),

              occurrenceCount: batch.occurrenceCount,

              nextScheduledPayoutAt,
            },
          ],
        };
      }
    );
  }

  /* ─────────────────────────────── STALE PROCESSING RECOVERY ─────────────────────────────── */

  static async recoverStaleProcessingBatches({ staleBefore, limit = DEFAULT_PROCESSING_LIMIT }) {
    const normalizedStaleBefore = this.normalizeDate(staleBefore, "Stale processing cutoff");

    const normalizedLimit = this.normalizePositiveInteger(
      limit,
      "Stale batch recovery limit",
      1000
    );

    const staleBatches = await ShiftSettlementBatch.find({
      status: "processing",

      processingStartedAt: {
        $lte: normalizedStaleBefore,
      },
    })
      .select("_id referenceCode settlementComponent processingStartedAt")
      .sort({
        processingStartedAt: 1,
      })
      .limit(normalizedLimit)
      .lean();

    if (staleBatches.length === 0) {
      return {
        inspected: 0,
        recovered: 0,
      };
    }

    const recoveredAt = new Date();

    const result = await ShiftSettlementBatch.updateMany(
      {
        _id: {
          $in: staleBatches.map((batch) => batch._id),
        },

        status: "processing",
      },

      {
        $set: {
          status: "failed",

          failedAt: recoveredAt,

          failureReason: "Settlement processing lock expired before completion.",

          /**
           * Preserve processingStartedAt, attemptCount and lastAttemptAt.
           */
          processingToken: null,

          releasedAt: null,

          cancelledAt: null,

          cancelledBy: null,

          cancellationReason: null,
        },
      },

      {
        runValidators: true,
      }
    );

    return {
      inspected: staleBatches.length,

      recovered: result.modifiedCount,

      batches: staleBatches.map((batch) => ({
        batchId: String(batch._id),

        referenceCode: batch.referenceCode,

        settlementComponent: batch.settlementComponent,
      })),
    };
  }
}

module.exports = ShiftSettlementBatchService;
