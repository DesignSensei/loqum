// models/ShiftSettlementBatch.js

const mongoose = require("mongoose");

const { minorUnitAmountField } = require("./helpers/schemaFields");

const {
  isNonNegativeSafeInteger,
  isValidLocalDateString,
  isValidTimeZone,
  hasDocumentValue,
  sumSafeIntegerValues,
  sameId,
} = require("./helpers/schemaValidators");

const { getWeekdayForLocalDate } = require("./helpers/dateTimeHelpers");

const { SHIFT_TIME_ZONE } = require("../constants/shiftPosting");

const {
  SETTLEMENT_BATCH_STATUSES,
  SETTLEMENT_BATCH_INITIATOR_ROLES,
  SETTLEMENT_BATCH_COMPONENTS,
  SETTLEMENT_LINE_EARNING_TYPES,
  DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY,
  MAX_SETTLEMENT_TIME_ZONE_LENGTH,
  MAX_SETTLEMENT_BATCH_FAILURE_REASON_LENGTH,
  MAX_SETTLEMENT_BATCH_CANCELLATION_REASON_LENGTH,
} = require("../constants/shiftSettlement");

const BASE_SETTLEMENT_EARNING_TYPES = Object.freeze([
  "worked_base",
  "cancellation_compensation",
  "active_work_cancellation",
]);

const OVERTIME_SETTLEMENT_EARNING_TYPES = Object.freeze(["overtime"]);

/**
 * SHIFT SETTLEMENT BATCH ARCHITECTURE
 *
 * ShiftSettlementBatch is PROFESSIONAL PAYOUT ONLY.
 *
 * One batch belongs to:
 *
 * - one professional;
 * - one country;
 * - one currency;
 * - one payout cycle; and
 * - one settlement component.
 *
 * settlementComponent is therefore a BATCH-level identity:
 *
 * - base
 * - overtime
 *
 * BASE and OVERTIME are intentionally separate batches even when they are due
 * for the same professional on the same weekly payout date.
 *
 * This preserves independent occurrence-component lifecycle state:
 *
 * - approval;
 * - challenge finality;
 * - payout cutoff;
 * - release_pending; and
 * - released.
 *
 * PROFESSIONAL-SPECIFIC AGGREGATION
 *
 * A component batch may contain professional earnings from several employers,
 * branches, assignments and parent Shifts, provided every included occurrence
 * belongs to the same professional, country, currency, payout cycle and
 * settlement component.
 *
 * SETTLEMENT LINES
 *
 * Because settlementComponent belongs to the batch, individual lines do not
 * repeat it.
 *
 * A line groups compatible earnings by:
 *
 * - Shift;
 * - assignment;
 * - employer;
 * - branch; and
 * - earningType.
 *
 * RELEASE RESERVATIONS
 *
 * releaseKeys reserve one occurrence-component professional payout obligation:
 *
 *   <occurrenceId>:base
 *   <occurrenceId>:overtime
 *
 * The same occurrence may therefore appear in one BASE batch and one OVERTIME
 * batch, but the same occurrence-component pair may never belong to two live
 * batches.
 *
 * Cancelled batches surrender their reservation keys.
 *
 * Failed batches retain them because the failed payout obligation is still
 * owned by that batch until an explicit later lifecycle action determines what
 * happens to it.
 *
 * Released batches retain them permanently so the same professional
 * occurrence-component payout can never be executed again.
 *
 * OCCURRENCE COUNT
 *
 * Because one batch contains one settlement component, each occurrence may
 * appear at most once in that batch.
 *
 * occurrenceCount is therefore the number of unique ShiftOccurrence records
 * represented by the batch and must equal releaseKeys.length while the batch
 * still owns its reservations.
 *
 * PAYOUT CYCLE SNAPSHOT
 *
 * The batch stores:
 *
 * - payoutDate;
 * - payoutWeekday;
 * - timeZone;
 * - cutoffAt; and
 * - scheduledFor.
 *
 * MONEY MOVEMENT
 *
 * The batch owns exactly one aggregated professional payout transfer pair:
 *
 * 1. Escrow debit for totalProfessionalPay.
 * 2. Professional wallet credit for totalProfessionalPay.
 *
 * Platform-fee earning and collection are NOT settlement-batch
 * responsibilities.
 *
 * This model therefore contains no:
 *
 * - platform wallet;
 * - platform-fee total;
 * - employer-charge total;
 * - refund amount;
 * - refund transaction; or
 * - platform-fee transaction reference.
 *
 * PROCESSING AUDIT
 *
 * processingToken is a transient processing lock and may exist only while
 * status === "processing".
 *
 * processingStartedAt is different:
 *
 * - it records the start of the latest/terminal processing attempt;
 * - it survives released / failed terminalization; and
 * - together with attemptCount and lastAttemptAt it preserves execution
 *   history.
 */

/* ─────────────────────────────── SETTLEMENT LINE ─────────────────────────────── */

const settlementLineSchema = new mongoose.Schema(
  {
    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      required: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    earningType: {
      type: String,
      enum: SETTLEMENT_LINE_EARNING_TYPES,
      required: true,
    },

    occurrences: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "ShiftOccurrence",
          required: true,
        },
      ],

      validate: {
        validator(values) {
          return Array.isArray(values) && values.length > 0;
        },

        message: "Each settlement line must contain at least one occurrence.",
      },
    },

    occurrenceCount: {
      type: Number,
      required: true,
      min: 1,

      validate: {
        validator: Number.isSafeInteger,

        message: "occurrenceCount must be a whole number.",
      },
    },

    professionalPay: minorUnitAmountField({
      required: true,
    }),
  },
  {
    _id: true,
  }
);

/* ─────────────────────────────── TRANSACTION REFERENCES ─────────────────────────────── */

const transactionPairSchema = new mongoose.Schema(
  {
    groupReference: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    debitTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    creditTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── BATCH SCHEMA ─────────────────────────────── */

const shiftSettlementBatchSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      unique: true,

      // Example: LQM-PAY-BASE-NG-NGN-20260727-ABC123.
    },

    cycleKey: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,

      // Example: NG-NGN-2026-07-27.
    },

    settlementComponent: {
      type: String,
      enum: SETTLEMENT_BATCH_COMPONENTS,
      required: true,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      required: true,
      unique: true,
      select: false,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    professionalWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
    },

    escrowWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
    },

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,

      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
    },

    currency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,

      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
    },

    // --- PAYOUT CYCLE SNAPSHOT ---

    payoutDate: {
      type: String,
      trim: true,
      required: true,

      validate: {
        validator: isValidLocalDateString,

        message: "payoutDate must be a valid date in YYYY-MM-DD format.",
      },
    },

    payoutWeekday: {
      type: Number,
      required: true,
      default: DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY,
      min: 0,
      max: 6,

      validate: {
        validator: Number.isSafeInteger,

        message: "payoutWeekday must be a whole number from 0 to 6.",
      },

      // JavaScript weekday numbering: Sunday 0, Monday 1.
    },

    timeZone: {
      type: String,
      trim: true,
      maxlength: MAX_SETTLEMENT_TIME_ZONE_LENGTH,
      required: true,
      default: SHIFT_TIME_ZONE,

      validate: {
        validator: isValidTimeZone,

        message: "timeZone must be a valid IANA timezone.",
      },
    },

    cutoffAt: {
      type: Date,
      required: true,
    },

    scheduledFor: {
      type: Date,
      required: true,
    },

    // --- INCLUDED PROFESSIONAL PAYOUTS ---

    lines: {
      type: [settlementLineSchema],

      validate: {
        validator(values) {
          return Array.isArray(values) && values.length > 0;
        },

        message: "A settlement batch must contain at least one settlement line.",
      },
    },

    occurrenceCount: {
      type: Number,
      required: true,
      min: 1,

      validate: {
        validator: Number.isSafeInteger,

        message: "occurrenceCount must be a whole number.",
      },
    },

    /**
     * One reservation key for every occurrence-component professional payout
     * obligation included in the batch.
     *
     * Cancelled batches surrender these keys so those occurrence components
     * may later be batched again.
     */
    releaseKeys: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
          maxlength: 80,
        },
      ],

      default: undefined,
    },

    totalProfessionalPay: minorUnitAmountField({
      required: true,
    }),

    // --- PROCESSING STATUS ---

    status: {
      type: String,
      enum: SETTLEMENT_BATCH_STATUSES,
      default: "scheduled",
      required: true,
    },

    /**
     * Number of processing attempts made against this batch.
     *
     * This is historical audit and is not reset merely because the current
     * processing lock is released.
     */
    attemptCount: {
      type: Number,
      default: 0,
      min: 0,

      validate: {
        validator: isNonNegativeSafeInteger,

        message: "attemptCount must be a non-negative whole number.",
      },
    },

    /**
     * Timestamp of the latest processing attempt.
     */
    lastAttemptAt: {
      type: Date,
      default: null,
    },

    /**
     * Start of the most recent/terminal processing attempt.
     *
     * Unlike processingToken, this survives released/failed state so payout
     * execution history is not destroyed.
     */
    processingStartedAt: {
      type: Date,
      default: null,
    },

    /**
     * Transient worker lock.
     *
     * Must be cleared whenever the batch leaves processing.
     */
    processingToken: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    releasedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: MAX_SETTLEMENT_BATCH_FAILURE_REASON_LENGTH,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: MAX_SETTLEMENT_BATCH_CANCELLATION_REASON_LENGTH,
      default: null,
    },

    // --- AUTHORITATIVE PROFESSIONAL PAYOUT TRANSACTIONS ---

    professionalPayout: {
      type: transactionPairSchema,
      default: () => ({}),
    },

    initiatedBy: {
      role: {
        type: String,
        enum: SETTLEMENT_BATCH_INITIATOR_ROLES,
        default: "system",
        required: true,
      },

      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── MODEL HELPERS ─────────────────────────────── */

function hasAnyTransactionPairValue(pair) {
  if (!pair) {
    return false;
  }

  return [pair.groupReference, pair.debitTransaction, pair.creditTransaction].some(
    hasDocumentValue
  );
}

function validateTransactionPair(document, pair, pathPrefix, { required = false } = {}) {
  const hasAnyValue = hasAnyTransactionPairValue(pair);

  if (!hasAnyValue) {
    if (required) {
      document.invalidate(
        `${pathPrefix}.groupReference`,

        `${pathPrefix} must contain a complete transaction pair.`
      );
    }

    return;
  }

  if (!pair.groupReference) {
    document.invalidate(
      `${pathPrefix}.groupReference`,

      `${pathPrefix}.groupReference is required when transaction references are recorded.`
    );
  }

  if (!pair.debitTransaction) {
    document.invalidate(
      `${pathPrefix}.debitTransaction`,

      `${pathPrefix}.debitTransaction is required when transaction references are recorded.`
    );
  }

  if (!pair.creditTransaction) {
    document.invalidate(
      `${pathPrefix}.creditTransaction`,

      `${pathPrefix}.creditTransaction is required when transaction references are recorded.`
    );
  }

  if (
    pair.debitTransaction &&
    pair.creditTransaction &&
    sameId(pair.debitTransaction, pair.creditTransaction)
  ) {
    document.invalidate(
      `${pathPrefix}.creditTransaction`,

      `${pathPrefix} debit and credit transactions must be different records.`
    );
  }
}

function buildSettlementReleaseKey(occurrenceId, settlementComponent) {
  return `${String(occurrenceId).toLowerCase()}:` + `${String(settlementComponent).toLowerCase()}`;
}

function lineEarningTypeMatchesComponent(settlementComponent, earningType) {
  if (settlementComponent === "base") {
    return BASE_SETTLEMENT_EARNING_TYPES.includes(earningType);
  }

  if (settlementComponent === "overtime") {
    return OVERTIME_SETTLEMENT_EARNING_TYPES.includes(earningType);
  }

  return false;
}

function buildSettlementLineIdentityKey(line) {
  return [
    String(line?.shift || ""),
    String(line?.assignment || ""),
    String(line?.business || ""),
    String(line?.branch || ""),
    String(line?.earningType || ""),
  ].join(":");
}

function validateAttemptAudit(document) {
  const attemptCount = Number(document.attemptCount || 0);

  const hasAttempts = Number.isSafeInteger(attemptCount) && attemptCount > 0;

  if (document.lastAttemptAt && !hasAttempts) {
    document.invalidate(
      "lastAttemptAt",

      "lastAttemptAt requires at least one recorded processing attempt."
    );
  }

  if (document.processingStartedAt && !hasAttempts) {
    document.invalidate(
      "processingStartedAt",

      "processingStartedAt requires at least one recorded processing attempt."
    );
  }

  if (hasAttempts && !document.lastAttemptAt) {
    document.invalidate(
      "lastAttemptAt",

      "A settlement batch with processing attempts requires lastAttemptAt."
    );
  }

  if (
    document.processingStartedAt &&
    document.lastAttemptAt &&
    document.lastAttemptAt < document.processingStartedAt
  ) {
    document.invalidate(
      "lastAttemptAt",

      "lastAttemptAt cannot be earlier than processingStartedAt."
    );
  }
}

/* ─────────────────────────────── MODEL VALIDATION ─────────────────────────────── */

shiftSettlementBatchSchema.pre(
  "validate",

  function validateShiftSettlementBatch() {
    /* ─────────────────────────────── WALLET IDENTITY ─────────────────────────────── */

    if (
      this.professionalWallet &&
      this.escrowWallet &&
      sameId(this.professionalWallet, this.escrowWallet)
    ) {
      this.invalidate(
        "professionalWallet",

        "professionalWallet and escrowWallet must be different wallets."
      );
    }

    /* ─────────────────────────────── PAYOUT CYCLE ─────────────────────────────── */

    if (this.payoutDate && Number.isSafeInteger(this.payoutWeekday)) {
      const actualWeekday = getWeekdayForLocalDate(this.payoutDate);

      if (actualWeekday !== this.payoutWeekday) {
        this.invalidate(
          "payoutWeekday",

          "payoutWeekday must match the local payoutDate."
        );
      }
    }

    if (this.cutoffAt && this.scheduledFor && this.scheduledFor <= this.cutoffAt) {
      this.invalidate(
        "scheduledFor",

        "scheduledFor must be later than cutoffAt."
      );
    }

    /* ─────────────────────────────── LINES / COMPONENT RESERVATIONS ─────────────────────────────── */

    const uniqueOccurrenceIds = new Set();

    const expectedReleaseKeys = [];

    const settlementLineIdentityKeys = new Set();

    const lineProfessionalPayValues = [];

    for (const line of this.lines || []) {
      const lineIdentityKey = buildSettlementLineIdentityKey(line);

      if (settlementLineIdentityKeys.has(lineIdentityKey)) {
        this.invalidate(
          "lines",

          "Settlement lines with the same Shift, assignment, business, branch and earningType must be combined into one line."
        );
      } else {
        settlementLineIdentityKeys.add(lineIdentityKey);
      }

      if (!lineEarningTypeMatchesComponent(this.settlementComponent, line.earningType)) {
        this.invalidate(
          "lines",

          `Line earningType ${line.earningType || "(missing)"} is not valid for ` +
            `${this.settlementComponent || "(missing)"} settlement.`
        );
      }

      const occurrenceIds = (line.occurrences || []).map((occurrenceId) => String(occurrenceId));

      const uniqueLineOccurrenceIds = new Set(occurrenceIds);

      if (uniqueLineOccurrenceIds.size !== occurrenceIds.length) {
        this.invalidate(
          "lines",

          "A settlement line cannot contain the same occurrence more than once."
        );
      }

      if (line.occurrenceCount !== occurrenceIds.length) {
        this.invalidate(
          "lines",

          "Each line occurrenceCount must match its occurrences array."
        );
      }

      for (const occurrenceId of occurrenceIds) {
        if (uniqueOccurrenceIds.has(occurrenceId)) {
          this.invalidate(
            "lines",

            "The same occurrence cannot appear more than once in one component payout batch."
          );
        } else {
          uniqueOccurrenceIds.add(occurrenceId);
        }

        expectedReleaseKeys.push(buildSettlementReleaseKey(occurrenceId, this.settlementComponent));
      }

      if (Number.isSafeInteger(line.professionalPay) && line.professionalPay <= 0) {
        this.invalidate(
          "lines",

          "Each settlement line must contain professional pay greater than zero."
        );
      }

      lineProfessionalPayValues.push(line.professionalPay);
    }

    if (this.occurrenceCount !== uniqueOccurrenceIds.size) {
      this.invalidate(
        "occurrenceCount",

        "occurrenceCount must match the number of unique occurrences represented by the component batch."
      );
    }

    const normalizedExpectedReleaseKeys = expectedReleaseKeys
      .map((value) => value.toLowerCase())
      .sort();

    const actualReleaseKeys = Array.isArray(this.releaseKeys)
      ? this.releaseKeys.map((value) => String(value).trim().toLowerCase()).sort()
      : [];

    if (new Set(actualReleaseKeys).size !== actualReleaseKeys.length) {
      this.invalidate(
        "releaseKeys",

        "releaseKeys cannot contain duplicate occurrence-component keys."
      );
    }

    /**
     * A component-specific batch has exactly one reservation key per
     * occurrence.
     */
    if (normalizedExpectedReleaseKeys.length !== uniqueOccurrenceIds.size) {
      this.invalidate(
        "releaseKeys",

        "A component payout batch must contain exactly one release key per occurrence."
      );
    }

    /**
     * Cancelled batches surrender their occurrence-component reservations.
     *
     * Every other state still owns those payout obligations.
     */
    if (this.status === "cancelled") {
      if (actualReleaseKeys.length > 0) {
        this.invalidate(
          "releaseKeys",

          "A cancelled settlement batch must release its occurrence-component reservation keys."
        );
      }
    } else {
      const releaseKeysMatch =
        actualReleaseKeys.length === normalizedExpectedReleaseKeys.length &&
        actualReleaseKeys.every(
          (releaseKey, index) => releaseKey === normalizedExpectedReleaseKeys[index]
        );

      if (!releaseKeysMatch) {
        this.invalidate(
          "releaseKeys",

          "releaseKeys must exactly match every occurrence-component professional payout obligation included in the batch."
        );
      }
    }

    /* ─────────────────────────────── BATCH TOTAL ─────────────────────────────── */

    const calculatedProfessionalPay = sumSafeIntegerValues(lineProfessionalPayValues);

    if (calculatedProfessionalPay === null) {
      this.invalidate(
        "totalProfessionalPay",

        "Settlement line professional pay contains an invalid amount."
      );
    } else if (this.totalProfessionalPay !== calculatedProfessionalPay) {
      this.invalidate(
        "totalProfessionalPay",

        "totalProfessionalPay must equal the sum of all settlement lines."
      );
    }

    if (Number.isSafeInteger(this.totalProfessionalPay) && this.totalProfessionalPay <= 0) {
      this.invalidate(
        "totalProfessionalPay",

        "A settlement batch must contain professional pay greater than zero."
      );
    }

    /* ─────────────────────────────── PROFESSIONAL PAYOUT TRANSACTION PAIR ─────────────────────────────── */

    validateTransactionPair(this, this.professionalPayout, "professionalPayout", {
      required: this.status === "released",
    });

    /* ─────────────────────────────── PROCESSING AUDIT ─────────────────────────────── */

    validateAttemptAudit(this);

    /**
     * processingToken is the live execution lock.
     *
     * It must never survive outside processing.
     */
    if (this.status !== "processing" && this.processingToken) {
      this.invalidate(
        "processingToken",

        "processingToken may exist only while a settlement batch is processing."
      );
    }

    /* ─────────────────────────────── STATUS: SCHEDULED ─────────────────────────────── */

    if (this.status === "scheduled") {
      if (
        this.processingToken ||
        this.releasedAt ||
        this.failedAt ||
        this.failureReason ||
        this.cancelledAt ||
        this.cancelledBy ||
        this.cancellationReason
      ) {
        this.invalidate(
          "status",

          "A scheduled batch cannot contain an active processing lock, release, failure or cancellation details."
        );
      }
    }

    /* ─────────────────────────────── STATUS: PROCESSING ─────────────────────────────── */

    if (this.status === "processing") {
      if (!this.processingStartedAt) {
        this.invalidate(
          "processingStartedAt",

          "processingStartedAt is required when a batch is processing."
        );
      }

      if (!this.processingToken) {
        this.invalidate(
          "processingToken",

          "processingToken is required when a batch is processing."
        );
      }

      if (!Number.isSafeInteger(this.attemptCount) || this.attemptCount <= 0) {
        this.invalidate(
          "attemptCount",

          "A processing settlement batch must have at least one processing attempt."
        );
      }

      if (!this.lastAttemptAt) {
        this.invalidate(
          "lastAttemptAt",

          "lastAttemptAt is required when a settlement batch is processing."
        );
      }

      if (
        this.releasedAt ||
        this.failedAt ||
        this.failureReason ||
        this.cancelledAt ||
        this.cancelledBy ||
        this.cancellationReason
      ) {
        this.invalidate(
          "status",

          "A processing batch cannot contain release, failure or cancellation details."
        );
      }
    }

    /* ─────────────────────────────── STATUS: RELEASED ─────────────────────────────── */

    if (this.status === "released") {
      if (!this.releasedAt) {
        this.invalidate(
          "releasedAt",

          "releasedAt is required when a batch is released."
        );
      }

      if (
        !this.processingStartedAt ||
        !Number.isSafeInteger(this.attemptCount) ||
        this.attemptCount <= 0 ||
        !this.lastAttemptAt
      ) {
        this.invalidate(
          "processingStartedAt",

          "A released settlement batch requires processing-start and attempt audit."
        );
      }

      if (
        this.failedAt ||
        this.failureReason ||
        this.cancelledAt ||
        this.cancelledBy ||
        this.cancellationReason
      ) {
        this.invalidate(
          "status",

          "A released batch cannot contain failure or cancellation details."
        );
      }

      if (
        this.processingStartedAt &&
        this.releasedAt &&
        this.releasedAt < this.processingStartedAt
      ) {
        this.invalidate(
          "releasedAt",

          "releasedAt cannot be earlier than processingStartedAt."
        );
      }

      if (this.lastAttemptAt && this.releasedAt && this.releasedAt < this.lastAttemptAt) {
        this.invalidate(
          "releasedAt",

          "releasedAt cannot be earlier than lastAttemptAt."
        );
      }
    }

    /* ─────────────────────────────── STATUS: FAILED ─────────────────────────────── */

    if (this.status === "failed") {
      if (!this.failedAt) {
        this.invalidate(
          "failedAt",

          "failedAt is required when a batch has failed."
        );
      }

      if (!this.failureReason) {
        this.invalidate(
          "failureReason",

          "failureReason is required when a batch has failed."
        );
      }

      if (
        !this.processingStartedAt ||
        !Number.isSafeInteger(this.attemptCount) ||
        this.attemptCount <= 0 ||
        !this.lastAttemptAt
      ) {
        this.invalidate(
          "processingStartedAt",

          "A failed settlement batch requires processing-start and attempt audit."
        );
      }

      if (this.releasedAt || this.cancelledAt || this.cancelledBy || this.cancellationReason) {
        this.invalidate(
          "status",

          "A failed batch cannot contain release or cancellation details."
        );
      }

      if (this.processingStartedAt && this.failedAt && this.failedAt < this.processingStartedAt) {
        this.invalidate(
          "failedAt",

          "failedAt cannot be earlier than processingStartedAt."
        );
      }

      if (this.lastAttemptAt && this.failedAt && this.failedAt < this.lastAttemptAt) {
        this.invalidate(
          "failedAt",

          "failedAt cannot be earlier than lastAttemptAt."
        );
      }
    }

    /* ─────────────────────────────── STATUS: CANCELLED ─────────────────────────────── */

    if (this.status === "cancelled") {
      if (!this.cancelledAt) {
        this.invalidate(
          "cancelledAt",

          "cancelledAt is required when a batch is cancelled."
        );
      }

      if (!this.cancelledBy) {
        this.invalidate(
          "cancelledBy",

          "cancelledBy is required when a batch is cancelled."
        );
      }

      if (!this.cancellationReason) {
        this.invalidate(
          "cancellationReason",

          "cancellationReason is required when a batch is cancelled."
        );
      }

      if (this.releasedAt || this.failedAt || this.failureReason) {
        this.invalidate(
          "status",

          "A cancelled batch cannot contain release or failure details."
        );
      }

      if (this.lastAttemptAt && this.cancelledAt && this.cancelledAt < this.lastAttemptAt) {
        this.invalidate(
          "cancelledAt",

          "cancelledAt cannot be earlier than lastAttemptAt."
        );
      }
    }

    /* ─────────────────────────────── TERMINAL AUDIT EXCLUSIVITY ─────────────────────────────── */

    const terminalTimestamps = {
      released: this.releasedAt,

      failed: this.failedAt,

      cancelled: this.cancelledAt,
    };

    for (const [terminalStatus, timestamp] of Object.entries(terminalTimestamps)) {
      if (this.status !== terminalStatus && timestamp) {
        this.invalidate(
          `${terminalStatus}At`,

          `${terminalStatus}At can only be recorded when status is ${terminalStatus}.`
        );
      }
    }

    if (this.status !== "failed" && this.failureReason) {
      this.invalidate(
        "failureReason",

        "failureReason can only be recorded when status is failed."
      );
    }

    if (this.status !== "cancelled" && (this.cancelledBy || this.cancellationReason)) {
      this.invalidate(
        "cancelledBy",

        "Cancellation details can only be recorded when status is cancelled."
      );
    }

    /* ─────────────────────────────── INITIATOR ─────────────────────────────── */

    if (this.initiatedBy?.role === "admin" && !this.initiatedBy?.userId) {
      this.invalidate(
        "initiatedBy.userId",

        "initiatedBy.userId is required when an admin initiates the batch."
      );
    }

    /* ─────────────────────────────── PAYOUT TRANSACTION FINALITY ─────────────────────────────── */

    const hasReleaseTransactions = hasAnyTransactionPairValue(this.professionalPayout);

    if (this.status !== "released" && hasReleaseTransactions) {
      this.invalidate(
        "status",

        "Professional payout transactions can only be recorded on a released batch."
      );
    }
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

/**
 * BASE and OVERTIME are separate professional payout batches.
 *
 * A professional may therefore have at most one batch per country, currency,
 * payout cycle and settlement component.
 */
shiftSettlementBatchSchema.index(
  {
    professional: 1,
    countryCode: 1,
    currency: 1,
    cycleKey: 1,
    settlementComponent: 1,
  },
  {
    unique: true,
  }
);

/**
 * One occurrence-component professional payout obligation may belong to only
 * one non-cancelled settlement batch.
 *
 * releaseKeys is removed/emptied when the batch is cancelled, surrendering
 * those reservations.
 */
shiftSettlementBatchSchema.index(
  {
    releaseKeys: 1,
  },
  {
    unique: true,
    sparse: true,
  }
);

shiftSettlementBatchSchema.index({
  status: 1,
  scheduledFor: 1,
});

shiftSettlementBatchSchema.index({
  professional: 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  professional: 1,
  settlementComponent: 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  settlementComponent: 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  "lines.occurrences": 1,
});

shiftSettlementBatchSchema.index({
  "lines.earningType": 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  "lines.shift": 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  "lines.assignment": 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  "lines.business": 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  professionalWallet: 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  escrowWallet: 1,
  payoutDate: -1,
});

shiftSettlementBatchSchema.index({
  "professionalPayout.groupReference": 1,
});

module.exports = mongoose.model("ShiftSettlementBatch", shiftSettlementBatchSchema);
