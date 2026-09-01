// services/employerRefundBatchService.js
const crypto = require("crypto");
const mongoose = require("mongoose");

const EmployerProfile = require("../models/EmployerProfile");
const BankAccount = require("../models/BankAccount");
const EmployerRefund = require("../models/EmployerRefund");
const EmployerRefundBatch = require("../models/EmployerRefundBatch");
const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");

const ShiftRefundService = require("./shiftRefundService");
const WalletService = require("./walletService");
const PaystackService = require("./paystackService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");

const {
  REFUND_HOLD_REASONS,
  EMPLOYER_REFUND_FUNDING_METHODS,
  PAYSTACK_REFUND_STATUSES,
} = require("../constants/shiftLifecycle");

/* ─────────────────────────────── CONSTANTS ─────────────────────────────── */

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

const DEFAULT_WEEKLY_BATCH_CREATION_LIMIT = 100;
const MAX_WEEKLY_BATCH_CREATION_LIMIT = 1000;

const DEFAULT_PAYSTACK_RECONCILIATION_LIMIT = 100;
const MAX_PAYSTACK_RECONCILIATION_LIMIT = 500;
const DEFAULT_PAYSTACK_RECONCILIATION_MIN_AGE_MS = 5 * 60 * 1000;

const PROCESSABLE_BATCH_STATUSES = Object.freeze(["scheduled", "processing"]);

const PAYSTACK_RECONCILIATION_BATCH_STATUSES = Object.freeze([
  "processing",
  "awaiting_provider",
  "awaiting_action",
]);

const TERMINAL_LINE_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

const PAUSED_ASYNC_LINE_STATUSES = Object.freeze(["pending_provider", "awaiting_action"]);

const SAFE_PAYSTACK_RAW_SUCCESS_STATUSES = Object.freeze([
  "processed",
  "success",
  "successful",
  "completed",
]);

const SAFE_PAYSTACK_RAW_PROCESSING_STATUSES = Object.freeze(["processing"]);

const SAFE_PAYSTACK_RAW_PENDING_STATUSES = Object.freeze(["pending", "queued", "submitted"]);

const SAFE_PAYSTACK_RAW_NEEDS_ATTENTION_STATUSES = Object.freeze([
  "needs_attention",
  "needs-attention",
]);

const SAFE_PAYSTACK_RAW_FAILURE_STATUSES = Object.freeze([
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "rejected",
]);

/*
 * ShiftRefundService owns occurrence-level BASE refund entitlement.
 *
 * EmployerRefundBatchService owns everything after batching begins:
 *
 * - final pre-execution entitlement revalidation;
 * - wallet and Paystack refund execution;
 * - provider-state synchronization from webhooks;
 * - polling/reconciliation of unresolved Paystack refunds;
 * - Retry Refund execution/reconciliation; and
 * - automatic Loqum-wallet fallback after conclusive provider failure.
 *
 * ShiftRefundService.reconciliationRequired is an authoritative entitlement
 * conflict signal after execution has already been locked. It is not the
 * routine Paystack polling mechanism. Routine provider reconciliation remains
 * here and is exposed through reconcilePendingPaystackRefunds() for the
 * scheduled reconciliation job.
 *
 * Paystack-funded refunds use the provider Refund route first. needs_attention
 * permits the employer to confirm the single active Paystack-verified withdrawal
 * account for Retry Refund. A conclusive provider failure automatically falls
 * back to the employer Loqum wallet.
 */
class EmployerRefundBatchService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: "EmployerRefundBatchServiceError",
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

  static normalizeObjectId(value, fieldName, required = true) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw EmployerRefundBatchService.createError({
        message: `${fieldName} is required.`,
        code: `${String(fieldName)
          .replace(/[^a-z0-9]+/gi, "_")
          .toUpperCase()}_REQUIRED`,
      });
    }

    if (!mongoose.isValidObjectId(value)) {
      throw EmployerRefundBatchService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${String(fieldName)
          .replace(/[^a-z0-9]+/gi, "_")
          .toUpperCase()}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value) {
    const currentTime =
      value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(currentTime.getTime())) {
      throw EmployerRefundBatchService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeDate(value, fieldName) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw EmployerRefundBatchService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${String(fieldName)
          .replace(/[^a-z0-9]+/gi, "_")
          .toUpperCase()}`,
      });
    }

    return date;
  }

  static normalizeCountryCode(value) {
    const countryCode = String(value || "NG")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw EmployerRefundBatchService.createError({
        message: "Country code is invalid.",
        code: "INVALID_COUNTRY_CODE",
      });
    }

    return countryCode;
  }

  static normalizeCurrency(value) {
    const currency = String(value || "NGN")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw EmployerRefundBatchService.createError({
        message: "Currency is invalid.",
        code: "INVALID_CURRENCY",
      });
    }

    return currency;
  }

  static normalizeActor(initiatedBy = null) {
    const actor = initiatedBy || {
      role: "system",
      userId: null,
    };

    const role = String(actor.role || "system")
      .trim()
      .toLowerCase();

    if (!["system", "admin"].includes(role)) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batches may only be initiated by system or admin.",
        code: "INVALID_EMPLOYER_REFUND_BATCH_ACTOR",
      });
    }

    const userId = EmployerRefundBatchService.normalizeObjectId(
      actor.userId,
      "initiator user ID",
      role === "admin"
    );

    if (role === "system" && userId) {
      throw EmployerRefundBatchService.createError({
        message: "A system batch action cannot contain an initiator user ID.",
        code: "SYSTEM_BATCH_USER_NOT_ALLOWED",
      });
    }

    return {
      role,
      userId,
    };
  }

  static normalizeWeeklyBatchCreationLimit(value) {
    const limit = Number(value || DEFAULT_WEEKLY_BATCH_CREATION_LIMIT);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WEEKLY_BATCH_CREATION_LIMIT) {
      throw EmployerRefundBatchService.createError({
        message: `Weekly refund batch creation limit must be between 1 and ${MAX_WEEKLY_BATCH_CREATION_LIMIT}.`,
        code: "INVALID_WEEKLY_REFUND_BATCH_CREATION_LIMIT",
      });
    }

    return limit;
  }

  static normalizePaystackReconciliationLimit(value) {
    const limit = Number(value || DEFAULT_PAYSTACK_RECONCILIATION_LIMIT);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAYSTACK_RECONCILIATION_LIMIT) {
      throw EmployerRefundBatchService.createError({
        message: `Paystack refund reconciliation limit must be between 1 and ${MAX_PAYSTACK_RECONCILIATION_LIMIT}.`,
        code: "INVALID_PAYSTACK_REFUND_RECONCILIATION_LIMIT",
      });
    }

    return limit;
  }

  static normalizePaystackReconciliationMinAgeMs(value) {
    const minAgeMs = Number(
      value === null || value === undefined ? DEFAULT_PAYSTACK_RECONCILIATION_MIN_AGE_MS : value
    );

    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
      throw EmployerRefundBatchService.createError({
        message: "Paystack refund reconciliation minimum age is invalid.",
        code: "INVALID_PAYSTACK_REFUND_RECONCILIATION_MIN_AGE",
      });
    }

    return minAgeMs;
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  static uniqueIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
  }

  static sumAmounts(values) {
    return (Array.isArray(values) ? values : []).reduce((total, value) => {
      const amount = Number(value || 0);

      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw EmployerRefundBatchService.createError({
          message: "A refund amount is invalid.",
          code: "INVALID_REFUND_AMOUNT",
          statusCode: 500,
        });
      }

      const nextTotal = total + amount;

      if (!Number.isSafeInteger(nextTotal)) {
        throw EmployerRefundBatchService.createError({
          message: "Refund total exceeds safe integer limits.",
          code: "REFUND_TOTAL_OVERFLOW",
          statusCode: 500,
        });
      }

      return nextTotal;
    }, 0);
  }

  static shortReason(value, maxLength = 1000) {
    return String(value || "Unknown refund-processing error.")
      .trim()
      .slice(0, maxLength);
  }

  static createProcessingToken() {
    return `erb-lock:${crypto.randomUUID()}`;
  }

  static buildCycleKey({ businessId, refundDate, countryCode, currency }) {
    return `employer-refund:${String(businessId)}:${refundDate}:${countryCode}:${currency}`;
  }

  static buildBatchIdempotencyKey(cycleKey) {
    return `erb:${cycleKey}`.slice(0, 200);
  }

  static buildLineIdempotencyKey({ cycleKey, fundingMethod, groupingKey }) {
    return `erb-line:${cycleKey}:${fundingMethod}:${groupingKey}`.slice(0, 200);
  }

  static buildWalletDebitIdempotencyKey(line) {
    return `${line.idempotencyKey}:escrow-debit`.slice(0, 200);
  }

  static buildWalletCreditIdempotencyKey(line) {
    return `${line.idempotencyKey}:employer-credit`.slice(0, 200);
  }

  static buildPaystackRefundIdempotencyKey(line) {
    return `${line.idempotencyKey}:paystack-refund`.slice(0, 200);
  }

  static buildPaystackRetryRefundIdempotencyKey(line) {
    return `${line.idempotencyKey}:paystack-retry-refund`.slice(0, 200);
  }

  static buildPaystackWalletFallbackDebitIdempotencyKey(line) {
    return `${line.idempotencyKey}:paystack-wallet-fallback-debit`.slice(0, 200);
  }

  static buildPaystackWalletFallbackCreditIdempotencyKey(line) {
    return `${line.idempotencyKey}:paystack-wallet-fallback-credit`.slice(0, 200);
  }

  static buildPaystackLedgerIdempotencyKey(line) {
    return `${line.idempotencyKey}:paystack-ledger`.slice(0, 200);
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getBatch(batchId, session = null, { includeProcessingToken = false } = {}) {
    const normalizedBatchId = EmployerRefundBatchService.normalizeObjectId(batchId, "batch ID");

    let query = EmployerRefundBatch.findById(normalizedBatchId);

    if (includeProcessingToken) {
      query = query.select("+processingToken");
    }

    if (session) {
      query.session(session);
    }

    const batch = await query;

    if (!batch) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch was not found.",
        code: "EMPLOYER_REFUND_BATCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    return batch;
  }

  static async getEmployerProfile(businessId, session = null) {
    const normalizedBusinessId = EmployerRefundBatchService.normalizeObjectId(
      businessId,
      "business ID"
    );

    const query = EmployerProfile.findById(normalizedBusinessId);

    if (session) {
      query.session(session);
    }

    const employerProfile = await query;

    if (!employerProfile) {
      throw EmployerRefundBatchService.createError({
        message: "Employer profile was not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employerProfile;
  }

  static async getEligibleRefunds({
    businessId,
    countryCode,
    currency,
    cutoffAt,
    scheduledFor,
    session,
  }) {
    return EmployerRefund.find({
      business: businessId,
      countryCode,
      currency,
      status: "eligible",
      reservationStatus: "reserved",
      eligibleAt: {
        $lte: cutoffAt,
      },
      scheduledProcessingAt: {
        $lte: scheduledFor,
      },
      batch: null,
      batchLineId: null,
    })
      .sort({ eligibleAt: 1, createdAt: 1, _id: 1 })
      .session(session);
  }

  static async getEligibleRefundBatchGroups({ cutoffAt, scheduledFor, limit }) {
    const normalizedCutoffAt = EmployerRefundBatchService.normalizeDate(cutoffAt, "cutoff time");

    const normalizedScheduledFor = EmployerRefundBatchService.normalizeDate(
      scheduledFor,
      "scheduled processing time"
    );

    const normalizedLimit = EmployerRefundBatchService.normalizeWeeklyBatchCreationLimit(limit);

    return EmployerRefund.aggregate([
      {
        $match: {
          status: "eligible",
          reservationStatus: "reserved",

          eligibleAt: {
            $lte: normalizedCutoffAt,
          },

          scheduledProcessingAt: {
            $lte: normalizedScheduledFor,
          },

          batch: null,
          batchLineId: null,
        },
      },

      {
        $group: {
          _id: {
            business: "$business",
            countryCode: "$countryCode",
            currency: "$currency",
          },

          earliestEligibleAt: {
            $min: "$eligibleAt",
          },
        },
      },

      {
        $sort: {
          earliestEligibleAt: 1,
          "_id.business": 1,
        },
      },

      {
        $limit: normalizedLimit,
      },

      {
        $project: {
          _id: 0,

          businessId: "$_id.business",
          countryCode: "$_id.countryCode",
          currency: "$_id.currency",
          earliestEligibleAt: 1,
        },
      },
    ]);
  }

  /* ─────────────────────────────── BATCH CREATION ─────────────────────────────── */

  static buildExecutionLines({ refunds, cycleKey, currentTime }) {
    const walletRefunds = [];
    const paystackGroups = new Map();

    for (const refund of refunds) {
      if (!EMPLOYER_REFUND_FUNDING_METHODS.includes(refund.fundingMethod)) {
        throw EmployerRefundBatchService.createError({
          message: "An eligible employer refund has an unsupported funding method.",
          code: "UNSUPPORTED_EMPLOYER_REFUND_FUNDING_METHOD",
          statusCode: 500,
          details: {
            employerRefundId: String(refund._id),
            fundingMethod: refund.fundingMethod,
          },
        });
      }

      if (refund.fundingMethod === "wallet_balance") {
        walletRefunds.push(refund);
        continue;
      }

      const groupingKey = `${String(refund.shift)}:${String(refund.originalFundingTransaction)}`;

      if (!paystackGroups.has(groupingKey)) {
        paystackGroups.set(groupingKey, []);
      }

      paystackGroups.get(groupingKey).push(refund);
    }

    const lines = [];

    if (walletRefunds.length > 0) {
      lines.push(
        EmployerRefundBatchService.buildExecutionLine({
          refunds: walletRefunds,
          cycleKey,
          groupingKey: "wallet",
          fundingMethod: "wallet_balance",
          currentTime,
        })
      );
    }

    const sortedPaystackGroups = [...paystackGroups.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );

    for (const [groupingKey, groupedRefunds] of sortedPaystackGroups) {
      lines.push(
        EmployerRefundBatchService.buildExecutionLine({
          refunds: groupedRefunds,
          cycleKey,
          groupingKey,
          fundingMethod: "paystack_checkout",
          currentTime,
        })
      );
    }

    return lines;
  }

  static buildExecutionLine({ refunds, cycleKey, groupingKey, fundingMethod, currentTime }) {
    if (!Array.isArray(refunds) || refunds.length < 1) {
      throw EmployerRefundBatchService.createError({
        message: "A refund execution line requires at least one obligation.",
        code: "EMPTY_EMPLOYER_REFUND_EXECUTION_LINE",
        statusCode: 500,
      });
    }

    const shiftIds = EmployerRefundBatchService.uniqueIds(refunds.map((refund) => refund.shift));

    const originalPaystackReferences = EmployerRefundBatchService.uniqueIds(
      refunds.map((refund) => refund.originalPaystackReference)
    );

    if (fundingMethod === "paystack_checkout") {
      if (shiftIds.length !== 1 || originalPaystackReferences.length !== 1) {
        throw EmployerRefundBatchService.createError({
          message: "A Paystack refund line must belong to exactly one original Shift payment.",
          code: "INVALID_PAYSTACK_REFUND_GROUP",
          statusCode: 500,
        });
      }
    }

    const allocations = refunds.map((refund) => ({
      employerRefund: refund._id,
      shift: refund.shift,
      occurrence: refund.occurrence,
      originalFundingTransaction: refund.originalFundingTransaction,
      amount: refund.amount,
    }));

    return {
      lineReference: generateReference("LQ-ERL"),
      idempotencyKey: EmployerRefundBatchService.buildLineIdempotencyKey({
        cycleKey,
        fundingMethod,
        groupingKey,
      }),
      fundingMethod,
      initialExecutionMethod:
        fundingMethod === "wallet_balance" ? "wallet_balance" : "paystack_refund",
      finalExecutionMethod: null,
      originalPaystackReference:
        fundingMethod === "paystack_checkout" ? originalPaystackReferences[0] : null,
      allocations,
      allocationCount: allocations.length,
      shiftCount: shiftIds.length,
      totalAmount: EmployerRefundBatchService.sumAmounts(allocations.map((item) => item.amount)),
      eligibilityCheckedAt: currentTime,
      status: "queued",
      attemptCount: 0,
    };
  }

  static async createWeeklyBatchesForCycle({
    refundDate,
    timeZone,
    cutoffAt,
    scheduledFor,
    currentTime = new Date(),
    limit = DEFAULT_WEEKLY_BATCH_CREATION_LIMIT,
    initiatedBy = {
      role: "system",
      userId: null,
    },
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedCutoffAt = EmployerRefundBatchService.normalizeDate(cutoffAt, "cutoff time");

    const normalizedScheduledFor = EmployerRefundBatchService.normalizeDate(
      scheduledFor,
      "scheduled processing time"
    );

    const actor = EmployerRefundBatchService.normalizeActor(initiatedBy);

    if (!refundDate || !timeZone) {
      throw EmployerRefundBatchService.createError({
        message: "refundDate and timeZone are required to create the weekly employer refund cycle.",
        code: "EMPLOYER_REFUND_BATCH_CYCLE_DETAILS_REQUIRED",
      });
    }

    if (normalizedScheduledFor <= normalizedCutoffAt) {
      throw EmployerRefundBatchService.createError({
        message: "Scheduled refund processing time must be later than the refund-cycle cutoff.",
        code: "INVALID_EMPLOYER_REFUND_BATCH_SCHEDULE",
      });
    }

    if (normalizedCurrentTime < normalizedCutoffAt) {
      return {
        inspected: 0,
        created: [],
        idempotent: [],
        skipped: [],
        failed: [],
        cutoffReached: false,
      };
    }

    const groups = await EmployerRefundBatchService.getEligibleRefundBatchGroups({
      cutoffAt: normalizedCutoffAt,
      scheduledFor: normalizedScheduledFor,
      limit,
    });

    const result = {
      inspected: groups.length,
      created: [],
      idempotent: [],
      skipped: [],
      failed: [],
      cutoffReached: true,
    };

    for (const group of groups) {
      try {
        const batchResult = await EmployerRefundBatchService.createWeeklyBatch({
          businessId: group.businessId,
          refundDate,
          timeZone,
          cutoffAt: normalizedCutoffAt,
          scheduledFor: normalizedScheduledFor,
          countryCode: group.countryCode,
          currency: group.currency,
          currentTime: normalizedCurrentTime,
          initiatedBy: actor,
        });

        const entry = {
          businessId: String(group.businessId),
          countryCode: group.countryCode,
          currency: group.currency,
          batchId: batchResult.batch?._id ? String(batchResult.batch._id) : null,
        };

        if (batchResult.created) {
          result.created.push(entry);
        } else if (batchResult.idempotent) {
          result.idempotent.push(entry);
        } else {
          result.skipped.push({
            ...entry,
            reason: batchResult.reason || "batch_not_created",
          });
        }
      } catch (error) {
        result.failed.push({
          businessId: String(group.businessId),
          countryCode: group.countryCode,
          currency: group.currency,
          code: error.code || "EMPLOYER_REFUND_BATCH_CREATION_FAILED",
          message: error.message || "Employer refund batch creation failed.",
        });
      }
    }

    return result;
  }

  static async createWeeklyBatch(
    {
      businessId,
      refundDate,
      timeZone,
      cutoffAt,
      scheduledFor,
      countryCode = null,
      currency = null,
      cycleKey = null,
      currentTime = new Date(),
      initiatedBy = {
        role: "system",
        userId: null,
      },
    },
    options = {}
  ) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedCutoffAt = EmployerRefundBatchService.normalizeDate(cutoffAt, "cutoff time");

    const normalizedScheduledFor = EmployerRefundBatchService.normalizeDate(
      scheduledFor,
      "scheduled processing time"
    );

    if (normalizedScheduledFor <= normalizedCutoffAt) {
      throw EmployerRefundBatchService.createError({
        message: "Scheduled refund processing time must be later than the refund-cycle cutoff.",
        code: "INVALID_EMPLOYER_REFUND_BATCH_SCHEDULE",
      });
    }

    if (normalizedCurrentTime < normalizedCutoffAt) {
      throw EmployerRefundBatchService.createError({
        message: "The employer refund batch cannot be created before its cycle cutoff.",
        code: "EMPLOYER_REFUND_BATCH_CUTOFF_NOT_REACHED",
        statusCode: 409,
        details: {
          cutoffAt: normalizedCutoffAt,
          currentTime: normalizedCurrentTime,
        },
      });
    }

    const actor = EmployerRefundBatchService.normalizeActor(initiatedBy);

    if (!refundDate || !timeZone) {
      throw EmployerRefundBatchService.createError({
        message: "refundDate and timeZone are required to create a refund batch.",
        code: "EMPLOYER_REFUND_BATCH_CYCLE_DETAILS_REQUIRED",
      });
    }

    return EmployerRefundBatchService.runWithOptionalTransaction(options, async (session) => {
      const employerProfile = await EmployerRefundBatchService.getEmployerProfile(
        businessId,
        session
      );

      const resolvedCountryCode = EmployerRefundBatchService.normalizeCountryCode(
        countryCode || employerProfile.countryCode || "NG"
      );

      const resolvedCurrency = EmployerRefundBatchService.normalizeCurrency(
        currency || employerProfile.currency || "NGN"
      );

      const resolvedCycleKey =
        cycleKey ||
        EmployerRefundBatchService.buildCycleKey({
          businessId: employerProfile._id,
          refundDate,
          countryCode: resolvedCountryCode,
          currency: resolvedCurrency,
        });

      const existingBatch = await EmployerRefundBatch.findOne({
        cycleKey: resolvedCycleKey,
      })
        .select("+processingToken")
        .session(session);

      if (existingBatch) {
        return {
          batch: existingBatch,
          created: false,
          idempotent: true,
        };
      }

      const employerWallet = await WalletService.createEmployerWalletIfMissing(employerProfile, {
        session,
      });

      let escrowWallet = await WalletService.getEscrowWallet(
        {
          countryCode: resolvedCountryCode,
          currency: resolvedCurrency,
        },
        {
          session,
        }
      );

      if (!escrowWallet && typeof WalletService.createEscrowWallet === "function") {
        escrowWallet = await WalletService.createEscrowWallet(
          {
            countryCode: resolvedCountryCode,
            currency: resolvedCurrency,
          },
          {
            session,
          }
        );
      }

      if (!escrowWallet) {
        throw EmployerRefundBatchService.createError({
          message: "Escrow wallet was not found.",
          code: "ESCROW_WALLET_NOT_FOUND",
          statusCode: 500,
        });
      }

      const refunds = await EmployerRefundBatchService.getEligibleRefunds({
        businessId: employerProfile._id,
        countryCode: resolvedCountryCode,
        currency: resolvedCurrency,
        cutoffAt: normalizedCutoffAt,
        scheduledFor: normalizedScheduledFor,
        session,
      });

      if (refunds.length === 0) {
        return {
          batch: null,
          created: false,
          idempotent: false,
          reason: "no_eligible_refunds",
        };
      }

      const lines = EmployerRefundBatchService.buildExecutionLines({
        refunds,
        cycleKey: resolvedCycleKey,
        currentTime: normalizedCurrentTime,
      });

      const batch = new EmployerRefundBatch({
        referenceCode: generateReference("LQ-ERB"),
        cycleKey: resolvedCycleKey,
        idempotencyKey: EmployerRefundBatchService.buildBatchIdempotencyKey(resolvedCycleKey),

        business: employerProfile._id,
        employerWallet: employerWallet._id,
        escrowWallet: escrowWallet._id,

        countryCode: resolvedCountryCode,
        currency: resolvedCurrency,

        refundDate,
        timeZone,
        cutoffAt: normalizedCutoffAt,
        scheduledFor: normalizedScheduledFor,

        lines,
        lineCount: lines.length,

        shiftCount: EmployerRefundBatchService.uniqueIds(refunds.map((refund) => refund.shift))
          .length,

        occurrenceCount: EmployerRefundBatchService.uniqueIds(
          refunds.map((refund) => refund.occurrence)
        ).length,

        refundCount: refunds.length,

        totalAmount: EmployerRefundBatchService.sumAmounts(refunds.map((refund) => refund.amount)),

        completedAmount: 0,
        failedAmount: 0,

        status: "scheduled",

        initiatedBy: actor.role,
        initiatedByUser: actor.userId,
      });

      const refundById = new Map(refunds.map((refund) => [String(refund._id), refund]));

      for (const line of batch.lines) {
        for (const allocation of line.allocations) {
          const refund = refundById.get(String(allocation.employerRefund));

          if (!refund || refund.status !== "eligible" || refund.batch || refund.batchLineId) {
            throw EmployerRefundBatchService.createError({
              message: "A refund became unavailable while the batch was being created.",
              code: "EMPLOYER_REFUND_BATCH_CREATION_CONFLICT",
              statusCode: 409,
              details: {
                employerRefundId: String(allocation.employerRefund),
              },
            });
          }

          refund.status = "batched";
          refund.batch = batch._id;
          refund.batchLineId = line._id;
          refund.batchedAt = normalizedCurrentTime;
          refund.lastEvaluatedAt = normalizedCurrentTime;

          const occurrence = await ShiftOccurrence.findById(refund.occurrence).session(session);

          if (!occurrence) {
            throw EmployerRefundBatchService.createError({
              message: "A refund occurrence disappeared while the batch was being created.",
              code: "EMPLOYER_REFUND_OCCURRENCE_NOT_FOUND",
              statusCode: 409,
              details: {
                employerRefundId: String(refund._id),
              },
            });
          }

          occurrence.refundStatus = "batched";
          occurrence.refundBatch = batch._id;
          occurrence.refundProcessingStartedAt = null;
          occurrence.refundLastEvaluatedAt = normalizedCurrentTime;

          await refund.save({ session });
          await occurrence.save({ session });
        }
      }

      await batch.save({ session });

      return {
        batch,
        created: true,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── PROCESSING LOCK ─────────────────────────────── */

  static async acquireProcessingLock({
    batchId,
    currentTime = new Date(),
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
  }) {
    const normalizedBatchId = EmployerRefundBatchService.normalizeObjectId(batchId, "batch ID");

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedLockTtlMs = Number(lockTtlMs);

    if (!Number.isSafeInteger(normalizedLockTtlMs) || normalizedLockTtlMs <= 0) {
      throw EmployerRefundBatchService.createError({
        message: "Processing lock duration is invalid.",
        code: "INVALID_EMPLOYER_REFUND_BATCH_LOCK_TTL",
      });
    }

    const processingToken = EmployerRefundBatchService.createProcessingToken();

    const lockExpiresAt = new Date(normalizedCurrentTime.getTime() + normalizedLockTtlMs);

    let batch = await EmployerRefundBatch.findOneAndUpdate(
      {
        _id: normalizedBatchId,
        status: "scheduled",
        scheduledFor: {
          $lte: normalizedCurrentTime,
        },
        $or: [
          {
            processingToken: null,
          },
          {
            processingToken: {
              $exists: false,
            },
          },
        ],
      },
      {
        $set: {
          status: "processing",
          processingToken,
          lockedAt: normalizedCurrentTime,
          lockExpiresAt,
          processingStartedAt: normalizedCurrentTime,
          lastAttemptAt: normalizedCurrentTime,
        },
        $inc: {
          attemptCount: 1,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
        context: "query",
      }
    ).select("+processingToken");

    if (!batch) {
      batch = await EmployerRefundBatch.findOneAndUpdate(
        {
          _id: normalizedBatchId,
          status: "processing",
          $or: [
            {
              lockExpiresAt: {
                $lte: normalizedCurrentTime,
              },
            },
            {
              processingToken: null,
            },
            {
              lockExpiresAt: null,
            },
          ],
        },
        {
          $set: {
            processingToken,
            lockedAt: normalizedCurrentTime,
            lockExpiresAt,
            lastAttemptAt: normalizedCurrentTime,
          },
          $inc: {
            attemptCount: 1,
          },
        },
        {
          returnDocument: "after",
          runValidators: true,
          context: "query",
        }
      ).select("+processingToken");
    }

    if (batch) {
      return {
        batch,
        processingToken,
        acquired: true,
      };
    }

    const existingBatch = await EmployerRefundBatch.findById(normalizedBatchId)
      .select("+processingToken")
      .lean();

    if (!existingBatch) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch was not found.",
        code: "EMPLOYER_REFUND_BATCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!PROCESSABLE_BATCH_STATUSES.includes(existingBatch.status)) {
      return {
        batch: existingBatch,
        processingToken: null,
        acquired: false,
        reason: "batch_not_processable",
      };
    }

    if (
      existingBatch.status === "scheduled" &&
      new Date(existingBatch.scheduledFor).getTime() > normalizedCurrentTime.getTime()
    ) {
      return {
        batch: existingBatch,
        processingToken: null,
        acquired: false,
        reason: "batch_not_due",
      };
    }

    return {
      batch: existingBatch,
      processingToken: null,
      acquired: false,
      reason: "batch_locked",
    };
  }

  static assertProcessingLock(batch, processingToken) {
    if (
      batch.status !== "processing" ||
      !batch.processingToken ||
      !processingToken ||
      batch.processingToken !== processingToken
    ) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch processing lock is no longer owned by this worker.",
        code: "EMPLOYER_REFUND_BATCH_LOCK_LOST",
        statusCode: 409,
      });
    }
  }

  static async expireProcessingLock({
    batchId,
    processingToken,
    currentTime = new Date(),
    reason = null,
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const update = {
      $set: {
        lockExpiresAt: normalizedCurrentTime,
      },
    };

    if (reason) {
      update.$set.lastFailedAt = normalizedCurrentTime;
      update.$set.lastFailureReason = EmployerRefundBatchService.shortReason(reason);
    }

    return EmployerRefundBatch.findOneAndUpdate(
      {
        _id: batchId,
        status: "processing",
        processingToken,
      },
      update,
      {
        returnDocument: "after",
        runValidators: true,
        context: "query",
      }
    ).select("+processingToken");
  }

  /* ─────────────────────────────── REVALIDATION HELPERS ─────────────────────────────── */

  static clearBatchAudit(employerRefund) {
    employerRefund.batch = null;
    employerRefund.batchLineId = null;
    employerRefund.batchedAt = null;

    employerRefund.executionMethod = null;
    employerRefund.executionStartedAt = null;
    employerRefund.executionTransactions = [];
    employerRefund.completedTransaction = null;
    employerRefund.refundedAmount = 0;
    employerRefund.refundedAt = null;
  }

  static clearOccurrenceLegacyTransaction(occurrence) {
    if (occurrence?.schema?.path("refundTransaction")) {
      occurrence.refundTransaction = null;
    }
  }

  static applyOccurrenceHeldMirror({
    occurrence,
    employerRefund,
    amount,
    holdReason,
    currentTime,
  }) {
    if (!occurrence) {
      return;
    }

    occurrence.refundableAmount = amount;
    occurrence.refundedAmount = 0;
    occurrence.refundReason = employerRefund.reason;
    occurrence.refundLastEvaluatedAt = currentTime;
    occurrence.refundStatus = "held";
    occurrence.refundHeldAt = currentTime;
    occurrence.refundHoldReason = holdReason;
    occurrence.refundEligibleAt = employerRefund.eligibleAt || null;
    occurrence.employerRefund = employerRefund._id;
    occurrence.refundBatch = null;
    occurrence.refundProcessingStartedAt = null;
    occurrence.refundedAt = null;

    EmployerRefundBatchService.clearOccurrenceLegacyTransaction(occurrence);
  }

  static applyOccurrenceEligibleMirror({ occurrence, employerRefund, amount, currentTime }) {
    if (!occurrence) {
      return;
    }

    occurrence.refundableAmount = amount;
    occurrence.refundedAmount = 0;
    occurrence.refundReason = employerRefund.reason;
    occurrence.refundLastEvaluatedAt = currentTime;
    occurrence.refundStatus = "eligible";
    occurrence.refundHeldAt = null;
    occurrence.refundHoldReason = null;
    occurrence.refundEligibleAt = employerRefund.eligibleAt;
    occurrence.employerRefund = employerRefund._id;
    occurrence.refundBatch = null;
    occurrence.refundProcessingStartedAt = null;
    occurrence.refundedAt = null;

    EmployerRefundBatchService.clearOccurrenceLegacyTransaction(occurrence);
  }

  static applyOccurrenceVoidMirror(occurrence) {
    if (!occurrence) {
      return;
    }

    if (typeof ShiftRefundService.clearOccurrenceMirror === "function") {
      ShiftRefundService.clearOccurrenceMirror(occurrence);
      return;
    }

    occurrence.refundableAmount = 0;
    occurrence.refundedAmount = 0;
    occurrence.refundReason = null;
    occurrence.refundStatus = "not_eligible";
    occurrence.refundEligibleAt = null;
    occurrence.refundLastEvaluatedAt = null;
    occurrence.refundHeldAt = null;
    occurrence.refundHoldReason = null;
    occurrence.employerRefund = null;
    occurrence.refundBatch = null;
    occurrence.refundProcessingStartedAt = null;
    occurrence.refundedAt = null;

    EmployerRefundBatchService.clearOccurrenceLegacyTransaction(occurrence);
  }

  static async resolveActualBlockingDependency({ occurrence, currentTime, session }) {
    if (!occurrence) {
      return {
        holdReason: "manual_review",
        claimId: null,
        disputeId: null,
        reason: "The occurrence could not be loaded for final refund validation.",
      };
    }

    const automaticHold = await ShiftRefundService.resolveAutomaticHold({
      occurrence,
      currentTime,
      session,
    });

    if (!automaticHold?.holdReason) {
      return null;
    }

    const reasons = {
      professional_claim_pending:
        "An unresolved professional-claim issue affecting BASE now blocks this refund.",

      employer_dispute_pending:
        "An unresolved employer-dispute issue affecting BASE now blocks this refund.",

      challenge_window_open:
        "BASE remains ordinarily challengeable inside the shared occurrence review window.",

      professional_settlement_pending:
        "A positive BASE professional settlement still has to be released before this refund may execute.",
    };

    return {
      holdReason: automaticHold.holdReason,
      claimId: automaticHold.claimId || null,
      disputeId: automaticHold.disputeId || null,

      reason:
        reasons[automaticHold.holdReason] ||
        "The occurrence has a current BASE-scoped refund dependency.",
    };
  }

  static async loadAllocationContext({ allocation, session }) {
    const [employerRefund, shift, occurrence] = await Promise.all([
      EmployerRefund.findById(allocation.employerRefund).session(session),
      Shift.findById(allocation.shift).session(session),
      ShiftOccurrence.findById(allocation.occurrence).session(session),
    ]);

    return {
      employerRefund,
      shift,
      occurrence,
    };
  }

  static validateAllocationIntegrity({
    batch,
    line,
    allocation,
    employerRefund,
    shift,
    occurrence,
  }) {
    if (!employerRefund) {
      return {
        valid: false,
        manageable: false,
        reason: "The EmployerRefund record no longer exists.",
      };
    }

    if (!shift || !occurrence) {
      return {
        valid: false,
        manageable: true,
        holdReason: "manual_review",
        reason: "The Shift or occurrence could not be loaded during final refund validation.",
      };
    }

    const exactBatchOwnership =
      employerRefund.status === "batched" &&
      EmployerRefundBatchService.sameId(employerRefund.batch, batch._id) &&
      EmployerRefundBatchService.sameId(employerRefund.batchLineId, line._id);

    if (!exactBatchOwnership) {
      return {
        valid: false,
        manageable: false,
        reason: "The refund no longer belongs to this exact batch line.",
      };
    }

    const ownershipMatches =
      EmployerRefundBatchService.sameId(employerRefund.shift, shift._id) &&
      EmployerRefundBatchService.sameId(employerRefund.occurrence, occurrence._id) &&
      EmployerRefundBatchService.sameId(employerRefund.business, batch.business) &&
      EmployerRefundBatchService.sameId(occurrence.shift, shift._id) &&
      EmployerRefundBatchService.sameId(occurrence.business, batch.business);

    if (!ownershipMatches) {
      return {
        valid: false,
        manageable: true,
        holdReason: "manual_review",
        reason: "Refund ownership no longer matches the batch, Shift and occurrence.",
      };
    }

    const fundingMatches =
      employerRefund.fundingMethod === line.fundingMethod &&
      EmployerRefundBatchService.sameId(
        employerRefund.originalFundingTransaction,
        allocation.originalFundingTransaction
      ) &&
      EmployerRefundBatchService.sameId(
        shift.fundingTransaction,
        allocation.originalFundingTransaction
      ) &&
      employerRefund.countryCode === batch.countryCode &&
      employerRefund.currency === batch.currency;

    if (!fundingMatches) {
      return {
        valid: false,
        manageable: true,
        holdReason: "manual_review",
        reason: "The refund funding source no longer matches the batched allocation.",
      };
    }

    if (line.fundingMethod === "paystack_checkout") {
      const paystackReference = String(employerRefund.originalPaystackReference || "").trim();

      if (
        !paystackReference ||
        paystackReference !== String(line.originalPaystackReference || "")
      ) {
        return {
          valid: false,
          manageable: true,
          holdReason: "manual_review",
          reason: "The original Paystack reference no longer matches the refund line.",
        };
      }
    }

    return {
      valid: true,
    };
  }

  static async moveStaleRefundToHold({
    employerRefund,
    occurrence,
    amount,
    holdReason,
    claimId = null,
    disputeId = null,
    currentTime,
    session,
  }) {
    const resolvedHoldReason = REFUND_HOLD_REASONS.includes(holdReason)
      ? holdReason
      : "manual_review";

    EmployerRefundBatchService.clearBatchAudit(employerRefund);

    employerRefund.amount = amount;
    employerRefund.status = "held";
    employerRefund.holdReason = resolvedHoldReason;

    employerRefund.claim =
      resolvedHoldReason === "professional_claim_pending" ? claimId || null : null;

    employerRefund.dispute =
      resolvedHoldReason === "employer_dispute_pending" ? disputeId || null : null;

    employerRefund.lastEvaluatedAt = currentTime;
    employerRefund.heldAt = currentTime;
    employerRefund.scheduledProcessingAt = null;
    employerRefund.reservationStatus = "reserved";
    employerRefund.reservationReleasedAt = null;

    EmployerRefundBatchService.applyOccurrenceHeldMirror({
      occurrence,
      employerRefund,
      amount,
      holdReason: resolvedHoldReason,
      currentTime,
    });

    await employerRefund.save({ session });

    if (occurrence) {
      await occurrence.save({ session });
    }

    return {
      action: "held",
      status: "held",
      holdReason: resolvedHoldReason,
    };
  }

  static async moveStaleRefundToEligible({
    employerRefund,
    occurrence,
    amount,
    currentTime,
    session,
  }) {
    EmployerRefundBatchService.clearBatchAudit(employerRefund);

    employerRefund.amount = amount;
    employerRefund.status = "eligible";
    employerRefund.holdReason = null;
    employerRefund.claim = null;
    employerRefund.dispute = null;
    employerRefund.lastEvaluatedAt = currentTime;
    employerRefund.heldAt = null;
    employerRefund.eligibleAt = employerRefund.eligibleAt || currentTime;
    employerRefund.scheduledProcessingAt = employerRefund.scheduledProcessingAt || currentTime;
    employerRefund.reservationStatus = "reserved";
    employerRefund.reservationReleasedAt = null;

    EmployerRefundBatchService.applyOccurrenceEligibleMirror({
      occurrence,
      employerRefund,
      amount,
      currentTime,
    });

    await employerRefund.save({ session });

    if (occurrence) {
      await occurrence.save({ session });
    }

    return {
      action: "removed_and_reeligible",
      status: "eligible",
    };
  }

  static async voidStaleRefund({ employerRefund, occurrence, currentTime, session }) {
    EmployerRefundBatchService.clearBatchAudit(employerRefund);

    employerRefund.status = "voided";
    employerRefund.holdReason = null;
    employerRefund.claim = null;
    employerRefund.dispute = null;
    employerRefund.lastEvaluatedAt = currentTime;
    employerRefund.heldAt = null;
    employerRefund.eligibleAt = null;
    employerRefund.scheduledProcessingAt = null;
    employerRefund.reservationStatus = "released";
    employerRefund.reservationReleasedAt = currentTime;
    employerRefund.voidedAt = currentTime;
    employerRefund.voidedBy = null;
    employerRefund.voidReason =
      "The refund became stale before execution because no refundable balance remained.";

    EmployerRefundBatchService.applyOccurrenceVoidMirror(occurrence);

    await employerRefund.save({ session });

    if (occurrence) {
      await occurrence.save({ session });
    }

    return {
      action: "voided",
      status: "voided",
    };
  }

  static async revalidateAllocation({ batch, line, allocation, currentTime, session }) {
    const { employerRefund, shift, occurrence } =
      await EmployerRefundBatchService.loadAllocationContext({
        allocation,
        session,
      });

    const integrity = EmployerRefundBatchService.validateAllocationIntegrity({
      batch,
      line,
      allocation,
      employerRefund,
      shift,
      occurrence,
    });

    if (!integrity.valid) {
      if (!integrity.manageable || !employerRefund) {
        return {
          valid: false,
          allocation,
          employerRefund,
          shift,
          occurrence,
          action: "removed_without_mutation",
          reason: integrity.reason,
        };
      }

      const safeAmount =
        Number.isSafeInteger(Number(employerRefund.amount)) && Number(employerRefund.amount) > 0
          ? Number(employerRefund.amount)
          : Number(allocation.amount);

      const result = await EmployerRefundBatchService.moveStaleRefundToHold({
        employerRefund,
        occurrence,
        amount: safeAmount,
        holdReason: integrity.holdReason || "manual_review",
        claimId: null,
        disputeId: null,
        currentTime,
        session,
      });

      return {
        valid: false,
        allocation,
        employerRefund,
        shift,
        occurrence,
        ...result,
        reason: integrity.reason,
      };
    }

    let expectedAmount;

    try {
      expectedAmount = ShiftRefundService.calculateExpectedRefundAmount(occurrence);
    } catch (error) {
      const result = await EmployerRefundBatchService.moveStaleRefundToHold({
        employerRefund,
        occurrence,
        amount: Number(employerRefund.amount),
        holdReason: "manual_review",
        claimId: null,
        disputeId: null,
        currentTime,
        session,
      });

      return {
        valid: false,
        allocation,
        employerRefund,
        shift,
        occurrence,
        ...result,
        reason: `Refund amount could not be revalidated: ${error.message}`,
      };
    }

    if (expectedAmount === 0) {
      const result = await EmployerRefundBatchService.voidStaleRefund({
        employerRefund,
        occurrence,
        currentTime,
        session,
      });

      return {
        valid: false,
        allocation,
        employerRefund,
        shift,
        occurrence,
        ...result,
        reason: "No refundable balance remains immediately before execution.",
      };
    }

    const blocker = await EmployerRefundBatchService.resolveActualBlockingDependency({
      occurrence,
      currentTime,
      session,
    });

    if (blocker) {
      const result = await EmployerRefundBatchService.moveStaleRefundToHold({
        employerRefund,
        occurrence,
        amount: expectedAmount,
        holdReason: blocker.holdReason,
        claimId: blocker.claimId,
        disputeId: blocker.disputeId,
        currentTime,
        session,
      });

      return {
        valid: false,
        allocation,
        employerRefund,
        shift,
        occurrence,
        ...result,
        reason: blocker.reason,
      };
    }

    const amountStillMatches =
      Number(employerRefund.amount) === expectedAmount &&
      Number(allocation.amount) === expectedAmount &&
      Number(occurrence.refundableAmount) === expectedAmount;

    if (!amountStillMatches) {
      const result = await EmployerRefundBatchService.moveStaleRefundToEligible({
        employerRefund,
        occurrence,
        amount: expectedAmount,
        currentTime,
        session,
      });

      return {
        valid: false,
        allocation,
        employerRefund,
        shift,
        occurrence,
        ...result,
        reason: "The refundable amount changed after batching and must be rebatched.",
      };
    }

    const occurrenceMirrorMatches =
      occurrence.refundStatus === "batched" &&
      EmployerRefundBatchService.sameId(occurrence.refundBatch, batch._id) &&
      EmployerRefundBatchService.sameId(occurrence.employerRefund, employerRefund._id) &&
      Number(occurrence.refundedAmount || 0) === 0 &&
      !occurrence.refundProcessingStartedAt &&
      !occurrence.refundedAt;

    if (!occurrenceMirrorMatches) {
      const result = await EmployerRefundBatchService.moveStaleRefundToHold({
        employerRefund,
        occurrence,
        amount: expectedAmount,
        holdReason: "manual_review",
        claimId: null,
        disputeId: null,
        currentTime,
        session,
      });

      return {
        valid: false,
        allocation,
        employerRefund,
        shift,
        occurrence,
        ...result,
        reason: "The occurrence refund mirror no longer matches the batched obligation.",
      };
    }

    employerRefund.lastEvaluatedAt = currentTime;
    occurrence.refundLastEvaluatedAt = currentTime;

    await employerRefund.save({ session });
    await occurrence.save({ session });

    return {
      valid: true,
      allocation,
      employerRefund,
      shift,
      occurrence,
      amount: expectedAmount,
    };
  }

  static recalculateLine(line) {
    const allocations = Array.isArray(line.allocations) ? line.allocations : [];

    line.allocationCount = allocations.length;

    line.shiftCount = EmployerRefundBatchService.uniqueIds(
      allocations.map((allocation) => allocation.shift)
    ).length;

    line.totalAmount = EmployerRefundBatchService.sumAmounts(
      allocations.map((allocation) => allocation.amount)
    );
  }

  static recalculateBatch(batch) {
    const lines = Array.isArray(batch.lines) ? batch.lines : [];

    const allocations = lines.flatMap((line) =>
      Array.isArray(line.allocations) ? line.allocations : []
    );

    batch.lineCount = lines.length;

    batch.shiftCount = EmployerRefundBatchService.uniqueIds(
      allocations.map((allocation) => allocation.shift)
    ).length;

    batch.occurrenceCount = EmployerRefundBatchService.uniqueIds(
      allocations.map((allocation) => allocation.occurrence)
    ).length;

    batch.refundCount = EmployerRefundBatchService.uniqueIds(
      allocations.map((allocation) => allocation.employerRefund)
    ).length;

    batch.totalAmount = EmployerRefundBatchService.sumAmounts(
      lines.map((line) => Number(line.totalAmount || 0))
    );

    batch.completedAmount = EmployerRefundBatchService.sumAmounts(
      lines.filter((line) => line.status === "completed").map((line) => line.totalAmount)
    );

    batch.failedAmount = EmployerRefundBatchService.sumAmounts(
      lines.filter((line) => line.status === "failed").map((line) => line.totalAmount)
    );
  }

  static async prepareQueuedLineForExecution({ batch, line, currentTime, session }) {
    if (line.status !== "queued") {
      throw EmployerRefundBatchService.createError({
        message: "Only a queued refund line may undergo final entitlement revalidation.",
        code: "REFUND_LINE_NOT_QUEUED_FOR_REVALIDATION",
        statusCode: 409,
      });
    }

    const originalAllocations = [...line.allocations];

    const survivingAllocations = [];
    const survivingContexts = [];
    const staleAllocations = [];

    for (const allocation of originalAllocations) {
      const result = await EmployerRefundBatchService.revalidateAllocation({
        batch,
        line,
        allocation,
        currentTime,
        session,
      });

      if (result.valid) {
        survivingAllocations.push({
          employerRefund: allocation.employerRefund,
          shift: allocation.shift,
          occurrence: allocation.occurrence,
          originalFundingTransaction: allocation.originalFundingTransaction,
          amount: result.amount,
        });

        survivingContexts.push(result);
      } else {
        staleAllocations.push({
          employerRefundId: String(allocation.employerRefund),
          occurrenceId: String(allocation.occurrence),
          action: result.action,
          reason: result.reason,
        });
      }
    }

    line.executionEligibilityCheckedAt = currentTime;

    if (survivingAllocations.length === 0) {
      /*
       * Keep the original allocations on a fully stale cancelled line as
       * immutable execution-history context. The EmployerRefund obligations
       * themselves have already had their batch ownership cleared and may be
       * batched again later if they become eligible.
       */
      line.status = "cancelled";
      line.cancelledAt = currentTime;

      line.cancellationReason = EmployerRefundBatchService.shortReason(
        "All allocations became stale during immediate pre-execution revalidation.",
        500
      );

      return {
        executable: false,
        cancelled: true,
        survivingContexts: [],
        staleAllocations,
      };
    }

    if (survivingAllocations.length !== originalAllocations.length) {
      line.allocations = survivingAllocations;
      EmployerRefundBatchService.recalculateLine(line);
    }

    return {
      executable: true,
      cancelled: false,
      survivingContexts,
      staleAllocations,
    };
  }

  static markLineAndRefundsProcessing({ batch, line, contexts, currentTime }) {
    if (!line.executionEligibilityCheckedAt) {
      throw EmployerRefundBatchService.createError({
        message:
          "A refund line cannot enter processing before immediate execution eligibility is recorded.",
        code: "REFUND_EXECUTION_ELIGIBILITY_CHECK_REQUIRED",
        statusCode: 500,
      });
    }

    const executionMethod =
      line.fundingMethod === "wallet_balance" ? "wallet_balance" : "paystack_refund";

    line.status = "processing";
    line.attemptCount = Number(line.attemptCount || 0) + 1;
    line.lastAttemptAt = currentTime;
    line.processingStartedAt = line.processingStartedAt || currentTime;
    line.failedAt = null;
    line.failureReason = null;

    for (const context of contexts) {
      const { employerRefund, occurrence } = context;

      employerRefund.status = "processing";
      employerRefund.executionMethod = executionMethod;
      employerRefund.executionStartedAt = employerRefund.executionStartedAt || currentTime;
      employerRefund.lastEvaluatedAt = currentTime;

      occurrence.refundStatus = "processing";
      occurrence.refundBatch = batch._id;
      occurrence.refundProcessingStartedAt = occurrence.refundProcessingStartedAt || currentTime;
      occurrence.refundLastEvaluatedAt = currentTime;
    }
  }

  /* ─────────────────────────────── BATCH STATUS DERIVATION ─────────────────────────────── */

  static clearProcessingLock(batch) {
    batch.processingToken = null;
    batch.lockedAt = null;
    batch.lockExpiresAt = null;
  }

  static applyDerivedBatchState(batch, currentTime) {
    EmployerRefundBatchService.recalculateBatch(batch);

    const lines = Array.isArray(batch.lines) ? batch.lines : [];

    const queuedCount = lines.filter((line) => line.status === "queued").length;
    const processingCount = lines.filter((line) => line.status === "processing").length;
    const pendingProviderCount = lines.filter((line) => line.status === "pending_provider").length;
    const awaitingActionCount = lines.filter((line) => line.status === "awaiting_action").length;
    const completedCount = lines.filter((line) => line.status === "completed").length;
    const failedCount = lines.filter((line) => line.status === "failed").length;
    const cancelledCount = lines.filter((line) => line.status === "cancelled").length;

    const allTerminal = lines.every((line) => TERMINAL_LINE_STATUSES.includes(line.status));

    if (queuedCount + processingCount > 0) {
      batch.status = "processing";
      return batch.status;
    }

    if (awaitingActionCount > 0) {
      batch.status = "awaiting_action";
      batch.awaitingActionAt = batch.awaitingActionAt || currentTime;
      EmployerRefundBatchService.clearProcessingLock(batch);
      return batch.status;
    }

    if (pendingProviderCount > 0) {
      batch.status = "awaiting_provider";
      batch.awaitingProviderAt = batch.awaitingProviderAt || currentTime;
      EmployerRefundBatchService.clearProcessingLock(batch);
      return batch.status;
    }

    if (allTerminal && completedCount === lines.length) {
      batch.status = "completed";
      batch.completedAt = batch.completedAt || currentTime;
      EmployerRefundBatchService.clearProcessingLock(batch);
      return batch.status;
    }

    if (allTerminal && completedCount > 0 && failedCount + cancelledCount > 0) {
      batch.status = "partially_completed";
      batch.partiallyCompletedAt = batch.partiallyCompletedAt || currentTime;
      EmployerRefundBatchService.clearProcessingLock(batch);
      return batch.status;
    }

    if (allTerminal && failedCount > 0 && completedCount === 0) {
      batch.status = "failed";
      batch.lastFailedAt = batch.lastFailedAt || currentTime;
      batch.lastFailureReason =
        batch.lastFailureReason || "All executable employer refund lines failed.";
      EmployerRefundBatchService.clearProcessingLock(batch);
      return batch.status;
    }

    if (allTerminal && cancelledCount === lines.length) {
      batch.status = "cancelled";
      batch.cancelledAt = batch.cancelledAt || currentTime;
      batch.cancelledBy = batch.cancelledBy || "system";
      batch.cancelledByUser = null;
      batch.cancellationReason =
        batch.cancellationReason ||
        "All batch allocations became stale before financial execution.";
      EmployerRefundBatchService.clearProcessingLock(batch);
      return batch.status;
    }

    throw EmployerRefundBatchService.createError({
      message: "Employer refund batch lines reached an unsupported mixed execution state.",
      code: "UNSUPPORTED_EMPLOYER_REFUND_BATCH_STATE",
      statusCode: 500,
      details: {
        queuedCount,
        processingCount,
        pendingProviderCount,
        awaitingActionCount,
        completedCount,
        failedCount,
        cancelledCount,
      },
    });
  }

  /* ─────────────────────────────── WALLET EXECUTION ─────────────────────────────── */

  static appendUniqueIds(existingValues, newValues) {
    const merged = EmployerRefundBatchService.uniqueIds([
      ...(Array.isArray(existingValues) ? existingValues : []),
      ...(Array.isArray(newValues) ? newValues : []),
    ]);

    return merged.map((value) => new mongoose.Types.ObjectId(value));
  }

  static async setProcessingRefundExecutionMethod({
    batch,
    line,
    executionMethod,
    currentTime,
    session,
  }) {
    for (const allocation of line.allocations) {
      const employerRefund = await EmployerRefund.findById(allocation.employerRefund).session(
        session
      );

      if (!employerRefund) {
        throw EmployerRefundBatchService.createError({
          message: "A processing EmployerRefund disappeared before fallback execution.",
          code: "PROCESSING_EMPLOYER_REFUND_NOT_FOUND",
          statusCode: 500,
          details: {
            employerRefundId: String(allocation.employerRefund),
          },
        });
      }

      const exactOwnership =
        employerRefund.status === "processing" &&
        EmployerRefundBatchService.sameId(employerRefund.batch, batch._id) &&
        EmployerRefundBatchService.sameId(employerRefund.batchLineId, line._id);

      if (!exactOwnership) {
        throw EmployerRefundBatchService.createError({
          message:
            "Employer refund is no longer in the authorized processing state for fallback execution.",
          code: "EMPLOYER_REFUND_PROCESSING_STATE_CONFLICT",
          statusCode: 409,
          details: {
            employerRefundId: String(employerRefund._id),
            status: employerRefund.status,
          },
        });
      }

      employerRefund.executionMethod = executionMethod;
      employerRefund.lastEvaluatedAt = currentTime;

      await employerRefund.save({ session });

      const occurrence = await ShiftOccurrence.findById(employerRefund.occurrence).session(session);

      if (!occurrence) {
        throw EmployerRefundBatchService.createError({
          message: "The refund occurrence disappeared before fallback execution.",
          code: "REFUND_COMPLETION_OCCURRENCE_NOT_FOUND",
          statusCode: 500,
        });
      }

      occurrence.refundStatus = "processing";
      occurrence.refundBatch = batch._id;
      occurrence.refundProcessingStartedAt =
        occurrence.refundProcessingStartedAt || employerRefund.executionStartedAt || currentTime;
      occurrence.refundLastEvaluatedAt = currentTime;

      await occurrence.save({ session });
    }
  }

  static async completeRefundObligations({
    batch,
    line,
    executionMethod,
    executionTransactionIds,
    completedTransactionId,
    currentTime,
    session,
  }) {
    for (const allocation of line.allocations) {
      const employerRefund = await EmployerRefund.findById(allocation.employerRefund).session(
        session
      );

      if (!employerRefund) {
        throw EmployerRefundBatchService.createError({
          message: "A processing EmployerRefund disappeared before completion.",
          code: "PROCESSING_EMPLOYER_REFUND_NOT_FOUND",
          statusCode: 500,
        });
      }

      if (employerRefund.status === "refunded") {
        if (
          EmployerRefundBatchService.sameId(
            employerRefund.completedTransaction,
            completedTransactionId
          )
        ) {
          continue;
        }

        throw EmployerRefundBatchService.createError({
          message: "Employer refund was completed through a different transaction.",
          code: "EMPLOYER_REFUND_COMPLETION_CONFLICT",
          statusCode: 409,
        });
      }

      const exactProcessingOwnership =
        employerRefund.status === "processing" &&
        EmployerRefundBatchService.sameId(employerRefund.batch, batch._id) &&
        EmployerRefundBatchService.sameId(employerRefund.batchLineId, line._id) &&
        employerRefund.executionMethod === executionMethod;

      if (!exactProcessingOwnership) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund is no longer in the authorized processing state.",
          code: "EMPLOYER_REFUND_PROCESSING_STATE_CONFLICT",
          statusCode: 409,
          details: {
            employerRefundId: String(employerRefund._id),
            status: employerRefund.status,
          },
        });
      }

      employerRefund.executionTransactions = EmployerRefundBatchService.appendUniqueIds(
        employerRefund.executionTransactions,
        executionTransactionIds
      );

      employerRefund.completedTransaction = completedTransactionId;
      employerRefund.refundedAmount = employerRefund.amount;
      employerRefund.refundedAt = currentTime;
      employerRefund.status = "refunded";
      employerRefund.reservationStatus = "released";
      employerRefund.reservationReleasedAt = currentTime;

      const occurrence = await ShiftOccurrence.findById(employerRefund.occurrence).session(session);

      if (!occurrence) {
        throw EmployerRefundBatchService.createError({
          message: "The refund occurrence disappeared before refund completion.",
          code: "REFUND_COMPLETION_OCCURRENCE_NOT_FOUND",
          statusCode: 500,
        });
      }

      occurrence.refundStatus = "refunded";
      occurrence.refundableAmount = employerRefund.amount;
      occurrence.refundedAmount = employerRefund.amount;
      occurrence.refundBatch = batch._id;
      occurrence.refundProcessingStartedAt = employerRefund.executionStartedAt;
      occurrence.refundLastEvaluatedAt = currentTime;
      occurrence.refundedAt = currentTime;
      occurrence.refundHeldAt = null;
      occurrence.refundHoldReason = null;
      occurrence.employerRefund = employerRefund._id;

      EmployerRefundBatchService.clearOccurrenceLegacyTransaction(occurrence);

      await employerRefund.save({ session });
      await occurrence.save({ session });
    }
  }

  static async executeWalletLine({ batchId, lineId, processingToken, currentTime = new Date() }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    return EmployerRefundBatchService.runWithOptionalTransaction({}, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      EmployerRefundBatchService.assertProcessingLock(batch, processingToken);

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.fundingMethod !== "wallet_balance") {
        throw EmployerRefundBatchService.createError({
          message: "The refund line is not wallet-funded.",
          code: "REFUND_LINE_NOT_WALLET_FUNDED",
          statusCode: 409,
        });
      }

      if (line.status === "completed") {
        return {
          batch,
          line,
          completed: true,
          idempotent: true,
          staleAllocations: [],
        };
      }

      let contexts = [];
      let staleAllocations = [];

      if (line.status === "queued") {
        const revalidation = await EmployerRefundBatchService.prepareQueuedLineForExecution({
          batch,
          line,
          currentTime: normalizedCurrentTime,
          session,
        });

        staleAllocations = revalidation.staleAllocations;

        if (!revalidation.executable) {
          EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

          await batch.save({ session });

          return {
            batch,
            line,
            completed: false,
            cancelled: true,
            staleAllocations,
          };
        }

        contexts = revalidation.survivingContexts;

        EmployerRefundBatchService.markLineAndRefundsProcessing({
          batch,
          line,
          contexts,
          currentTime: normalizedCurrentTime,
        });
      } else if (line.status !== "processing") {
        throw EmployerRefundBatchService.createError({
          message: `Wallet refund line cannot execute while ${line.status}.`,
          code: "WALLET_REFUND_LINE_NOT_EXECUTABLE",
          statusCode: 409,
        });
      }

      for (const context of contexts) {
        await context.employerRefund.save({ session });
        await context.occurrence.save({ session });
      }

      const transfer = await WalletService.transferBetweenWallets(
        {
          fromWalletId: batch.escrowWallet,
          toWalletId: batch.employerWallet,
          amount: line.totalAmount,

          type: "shift_refund",
          purpose: "weekly_employer_refund",
          paymentRail: "internal_transfer",

          groupReference: line.lineReference,

          debitIdempotencyKey: EmployerRefundBatchService.buildWalletDebitIdempotencyKey(line),
          creditIdempotencyKey: EmployerRefundBatchService.buildWalletCreditIdempotencyKey(line),

          employerRefundBatch: batch._id,
          employerRefundBatchLineId: line._id,

          initiatedBy: {
            role: "system",
            userId: null,
          },

          description: `Weekly employer refund ${line.lineReference}`,

          metadata: {
            employerRefundBatchReference: batch.referenceCode,
            employerRefundLineReference: line.lineReference,
            allocationCount: line.allocationCount,
          },
        },
        {
          session,
        }
      );

      const debitTransaction = transfer.debit.transaction;
      const creditTransaction = transfer.credit.transaction;

      const executionTransactionIds = [debitTransaction._id, creditTransaction._id];

      line.executionTransactions = EmployerRefundBatchService.appendUniqueIds(
        line.executionTransactions,
        executionTransactionIds
      );

      line.completedTransaction = creditTransaction._id;
      line.finalExecutionMethod = "wallet_balance";
      line.status = "completed";
      line.completedAt = normalizedCurrentTime;

      line.walletMovement.groupReference = transfer.groupReference;
      line.walletMovement.escrowDebitTransaction = debitTransaction._id;
      line.walletMovement.employerCreditTransaction = creditTransaction._id;
      line.walletMovement.completedAt = normalizedCurrentTime;

      await EmployerRefundBatchService.completeRefundObligations({
        batch,
        line,
        executionMethod: "wallet_balance",
        executionTransactionIds,
        completedTransactionId: creditTransaction._id,
        currentTime: normalizedCurrentTime,
        session,
      });

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        completed: true,
        idempotent: Boolean(transfer.idempotent),
        staleAllocations,
      };
    });
  }

  /* ─────────────────────────────── PAYSTACK EXECUTION ─────────────────────────────── */

  static async completePaystackWalletFallbackInSession({ batch, line, currentTime, session }) {
    if (line.fundingMethod !== "paystack_checkout") {
      throw EmployerRefundBatchService.createError({
        message: "Automatic wallet fallback applies only to a Paystack-funded refund line.",
        code: "REFUND_LINE_NOT_PAYSTACK_FUNDED",
        statusCode: 409,
      });
    }

    if (line.status === "completed") {
      if (
        line.finalExecutionMethod === "wallet_balance" &&
        line.paystackRefund.status === "failed" &&
        line.walletMovement?.completedAt
      ) {
        return {
          batch,
          line,
          completed: true,
          idempotent: true,
        };
      }

      throw EmployerRefundBatchService.createError({
        message: "This Paystack refund line already completed through another execution route.",
        code: "PAYSTACK_REFUND_ALREADY_COMPLETED",
        statusCode: 409,
      });
    }

    if (line.paystackRefund.status !== "failed") {
      throw EmployerRefundBatchService.createError({
        message: "Automatic wallet fallback requires a conclusively failed Paystack refund.",
        code: "PAYSTACK_WALLET_FALLBACK_PROVIDER_REFUND_NOT_FAILED",
        statusCode: 409,
      });
    }

    if (
      line.walletMovement?.groupReference ||
      line.walletMovement?.escrowDebitTransaction ||
      line.walletMovement?.employerCreditTransaction ||
      line.walletMovement?.completedAt
    ) {
      throw EmployerRefundBatchService.createError({
        message:
          "The Paystack wallet fallback contains incomplete or conflicting wallet-movement audit.",
        code: "PAYSTACK_WALLET_FALLBACK_AUDIT_CONFLICT",
        statusCode: 409,
      });
    }

    await EmployerRefundBatchService.setProcessingRefundExecutionMethod({
      batch,
      line,
      executionMethod: "wallet_balance",
      currentTime,
      session,
    });

    line.status = "processing";
    line.attemptCount = Number(line.attemptCount || 0) + 1;
    line.lastAttemptAt = currentTime;
    line.failedAt = null;
    line.failureReason = null;

    const transfer = await WalletService.transferBetweenWallets(
      {
        fromWalletId: batch.escrowWallet,
        toWalletId: batch.employerWallet,
        amount: line.totalAmount,

        type: "shift_refund",
        purpose: "weekly_employer_refund",
        paymentRail: "internal_transfer",

        groupReference: line.lineReference,

        debitIdempotencyKey:
          EmployerRefundBatchService.buildPaystackWalletFallbackDebitIdempotencyKey(line),

        creditIdempotencyKey:
          EmployerRefundBatchService.buildPaystackWalletFallbackCreditIdempotencyKey(line),

        employerRefundBatch: batch._id,
        employerRefundBatchLineId: line._id,

        initiatedBy: {
          role: "system",
          userId: null,
        },

        description: `Automatic Paystack refund fallback ${line.lineReference}`,

        metadata: {
          employerRefundBatchReference: batch.referenceCode,
          employerRefundLineReference: line.lineReference,
          originalPaystackReference: line.originalPaystackReference,
          paystackRefundId: line.paystackRefund.refundId || null,
          allocationCount: line.allocationCount,
          fallbackReason: "paystack_refund_failed",
        },
      },
      {
        session,
      }
    );

    const debitTransaction = transfer.debit.transaction;
    const creditTransaction = transfer.credit.transaction;

    const executionTransactionIds = [debitTransaction._id, creditTransaction._id];

    line.executionTransactions = EmployerRefundBatchService.appendUniqueIds(
      line.executionTransactions,
      executionTransactionIds
    );

    line.completedTransaction = creditTransaction._id;
    line.finalExecutionMethod = "wallet_balance";
    line.status = "completed";
    line.completedAt = currentTime;

    line.walletMovement.groupReference = transfer.groupReference;
    line.walletMovement.escrowDebitTransaction = debitTransaction._id;
    line.walletMovement.employerCreditTransaction = creditTransaction._id;
    line.walletMovement.completedAt = currentTime;

    await EmployerRefundBatchService.completeRefundObligations({
      batch,
      line,
      executionMethod: "wallet_balance",
      executionTransactionIds,
      completedTransactionId: creditTransaction._id,
      currentTime,
      session,
    });

    EmployerRefundBatchService.applyDerivedBatchState(batch, currentTime);

    await batch.save({ session });

    return {
      batch,
      line,
      completed: true,
      idempotent: Boolean(transfer.idempotent),
    };
  }

  static async executeAutomaticPaystackWalletFallback(
    { batchId, lineId, currentTime = new Date() },
    options = {}
  ) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    return EmployerRefundBatchService.runWithOptionalTransaction(options, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      return EmployerRefundBatchService.completePaystackWalletFallbackInSession({
        batch,
        line,
        currentTime: normalizedCurrentTime,
        session,
      });
    });
  }

  static assertPaystackRefundAdapterAvailable() {
    const requiredMethods = ["createRefund", "fetchRefund", "findRefundByTraceKey"];

    const missingMethod = requiredMethods.find(
      (methodName) => typeof PaystackService[methodName] !== "function"
    );

    if (missingMethod) {
      throw EmployerRefundBatchService.createError({
        message: `Paystack refund execution requires paystackService.${missingMethod}().`,
        code: "PAYSTACK_REFUND_ADAPTER_UNAVAILABLE",
        statusCode: 503,
        details: {
          missingMethod,
        },
      });
    }
  }

  static assertPaystackRefundReconciliationAdapterAvailable({ requireTraceLookup = false } = {}) {
    const requiredMethods = [
      "fetchRefund",
      ...(requireTraceLookup ? ["findRefundByTraceKey"] : []),
    ];

    const missingMethod = requiredMethods.find(
      (methodName) => typeof PaystackService[methodName] !== "function"
    );

    if (missingMethod) {
      throw EmployerRefundBatchService.createError({
        message: `Paystack refund reconciliation requires paystackService.${missingMethod}().`,
        code: "PAYSTACK_REFUND_RECONCILIATION_ADAPTER_UNAVAILABLE",
        statusCode: 503,
        details: {
          missingMethod,
        },
      });
    }
  }

  static assertPaystackRetryRefundAdapterAvailable() {
    const requiredMethods = ["fetchRefund", "resolveBankId", "retryRefundWithCustomerDetails"];

    const missingMethod = requiredMethods.find(
      (methodName) => typeof PaystackService[methodName] !== "function"
    );

    if (missingMethod) {
      throw EmployerRefundBatchService.createError({
        message: `Paystack Retry Refund execution requires paystackService.${missingMethod}().`,
        code: "PAYSTACK_RETRY_REFUND_ADAPTER_UNAVAILABLE",
        statusCode: 503,
        details: {
          missingMethod,
        },
      });
    }
  }

  static extractPaystackRefundPayload(response) {
    return response?.data?.data || response?.data || response || {};
  }

  static normalizePaystackRefundOutcome(response) {
    const payload = EmployerRefundBatchService.extractPaystackRefundPayload(response);

    const rawStatus = String(payload.status || response?.status || "pending")
      .trim()
      .toLowerCase();

    const refundId = payload.id === null || payload.id === undefined ? null : String(payload.id);

    const reference = String(payload.reference || payload.refund_reference || "").trim() || null;

    let status = null;

    if (SAFE_PAYSTACK_RAW_SUCCESS_STATUSES.includes(rawStatus)) {
      status = "processed";
    } else if (SAFE_PAYSTACK_RAW_PROCESSING_STATUSES.includes(rawStatus)) {
      status = "processing";
    } else if (SAFE_PAYSTACK_RAW_PENDING_STATUSES.includes(rawStatus)) {
      status = "pending";
    } else if (SAFE_PAYSTACK_RAW_NEEDS_ATTENTION_STATUSES.includes(rawStatus)) {
      status = "needs_attention";
    } else if (SAFE_PAYSTACK_RAW_FAILURE_STATUSES.includes(rawStatus)) {
      status = "failed";
    }

    if (!status) {
      return {
        status: "ambiguous",
        rawStatus,
        refundId,
        reference,
        payload,
      };
    }

    if (status !== "failed" && !refundId && !reference) {
      return {
        status: "ambiguous",
        rawStatus,
        refundId: null,
        reference: null,
        payload,
      };
    }

    return {
      status,
      rawStatus,
      refundId,
      reference,
      payload,
    };
  }

  static async getActiveEmployerRefundBankAccount({
    businessId,
    bankAccountId = null,
    session = null,
  }) {
    const filter = {
      ownerType: "employer",
      employer: businessId,
    };

    if (bankAccountId) {
      filter._id = EmployerRefundBatchService.normalizeObjectId(bankAccountId, "bank account ID");
    } else {
      filter.isActive = true;
    }

    let query = BankAccount.findOne(filter).select("+accountNumber +paystackBankCode");

    if (session) {
      query = query.session(session);
    }

    return query;
  }

  static assertUsableRefundBankAccount(bankAccount, businessId) {
    if (!bankAccount) {
      throw EmployerRefundBatchService.createError({
        message: "Add an active withdrawal bank account before continuing this refund.",
        code: "EMPLOYER_REFUND_BANK_ACCOUNT_REQUIRED",
        statusCode: 409,
      });
    }

    if (
      bankAccount.ownerType !== "employer" ||
      !EmployerRefundBatchService.sameId(bankAccount.employer, businessId) ||
      bankAccount.isActive !== true
    ) {
      throw EmployerRefundBatchService.createError({
        message: "The employer withdrawal bank account is no longer active or usable.",
        code: "EMPLOYER_REFUND_BANK_ACCOUNT_NOT_ACTIVE",
        statusCode: 409,
      });
    }

    if (bankAccount.verificationStatus !== "verified") {
      throw EmployerRefundBatchService.createError({
        message:
          "The saved withdrawal bank account is not Paystack-ready. Update the bank account before continuing this refund.",
        code: "EMPLOYER_REFUND_BANK_ACCOUNT_NOT_READY",
        statusCode: 409,
        details: {
          verificationStatus: bankAccount.verificationStatus || null,
        },
      });
    }

    const accountNumber = String(bankAccount.accountNumber || "")
      .replace(/\s+/g, "")
      .trim();

    const bankCode = String(bankAccount.paystackBankCode || "").trim();

    if (!accountNumber || !bankCode) {
      throw EmployerRefundBatchService.createError({
        message:
          "The verified withdrawal bank account is missing the Paystack details required for Retry Refund.",
        code: "EMPLOYER_REFUND_BANK_DETAILS_INCOMPLETE",
        statusCode: 409,
      });
    }

    return {
      accountNumber,
      bankCode,
    };
  }

  static async assertEmployerUserOwnsBatch({ batch, userId, session = null }) {
    const normalizedUserId = EmployerRefundBatchService.normalizeObjectId(
      userId,
      "employer user ID"
    );

    const employerProfile = await EmployerRefundBatchService.getEmployerProfile(
      batch.business,
      session
    );

    if (
      !employerProfile.user ||
      !EmployerRefundBatchService.sameId(employerProfile.user, normalizedUserId)
    ) {
      throw EmployerRefundBatchService.createError({
        message: "You do not have permission to manage this employer refund action.",
        code: "EMPLOYER_REFUND_ACTION_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return {
      employerProfile,
      userId: normalizedUserId,
    };
  }

  static async resolvePaystackRefundBankId({ bankCode, countryCode, currency }) {
    if (typeof PaystackService.resolveBankId !== "function") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack bank-ID resolution is not available yet. paystackService.resolveBankId() is required before Retry Refund can be submitted.",
        code: "PAYSTACK_BANK_ID_ADAPTER_UNAVAILABLE",
        statusCode: 503,
      });
    }

    const resolved = await PaystackService.resolveBankId({
      bankCode,
      countryCode,
      currency,
    });

    const bankId = String(resolved?.bankId ?? resolved?.id ?? resolved ?? "").trim();

    if (!bankId) {
      throw EmployerRefundBatchService.createError({
        message: "Paystack bank ID could not be resolved for the approved employer bank account.",
        code: "PAYSTACK_BANK_ID_NOT_FOUND",
        statusCode: 409,
      });
    }

    return bankId;
  }

  static async authorizePaystackLine({
    batchId,
    lineId,
    processingToken,
    currentTime = new Date(),
  }) {
    EmployerRefundBatchService.assertPaystackRefundAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    return EmployerRefundBatchService.runWithOptionalTransaction({}, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      EmployerRefundBatchService.assertProcessingLock(batch, processingToken);

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.fundingMethod !== "paystack_checkout") {
        throw EmployerRefundBatchService.createError({
          message: "The refund line is not Paystack-funded.",
          code: "REFUND_LINE_NOT_PAYSTACK_FUNDED",
          statusCode: 409,
        });
      }

      if (line.status === "completed") {
        return {
          batch,
          line,
          authorized: false,
          completed: true,
          idempotent: true,
          resumed: false,
          requiresReconciliation: false,
          staleAllocations: [],
        };
      }

      if (
        line.status === "processing" &&
        ["submitting", "submitted"].includes(line.retry?.status)
      ) {
        throw EmployerRefundBatchService.createError({
          message:
            "This processing line belongs to an in-flight Retry Refund and must be reconciled through the Retry Refund path.",
          code: "PAYSTACK_RETRY_REFUND_RECONCILIATION_REQUIRED",
          statusCode: 409,
        });
      }

      // A resumed processing line reconciles the existing provider attempt; it never blind-resubmits.
      if (line.status === "processing") {
        line.attemptCount = Number(line.attemptCount || 0) + 1;
        line.lastAttemptAt = normalizedCurrentTime;

        await batch.save({ session });

        return {
          batch,
          line,
          authorized: true,
          resumed: true,
          requiresReconciliation: true,
          staleAllocations: [],
        };
      }

      if (line.status !== "queued") {
        throw EmployerRefundBatchService.createError({
          message: `Paystack refund line cannot be authorized while ${line.status}.`,
          code: "PAYSTACK_REFUND_LINE_NOT_EXECUTABLE",
          statusCode: 409,
        });
      }

      const revalidation = await EmployerRefundBatchService.prepareQueuedLineForExecution({
        batch,
        line,
        currentTime: normalizedCurrentTime,
        session,
      });

      if (!revalidation.executable) {
        EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

        await batch.save({ session });

        return {
          batch,
          line,
          authorized: false,
          cancelled: true,
          resumed: false,
          requiresReconciliation: false,
          staleAllocations: revalidation.staleAllocations,
        };
      }

      EmployerRefundBatchService.markLineAndRefundsProcessing({
        batch,
        line,
        contexts: revalidation.survivingContexts,
        currentTime: normalizedCurrentTime,
      });

      for (const context of revalidation.survivingContexts) {
        await context.employerRefund.save({ session });
        await context.occurrence.save({ session });
      }

      await batch.save({ session });

      return {
        batch,
        line,
        authorized: true,
        resumed: false,
        requiresReconciliation: false,
        staleAllocations: revalidation.staleAllocations,
      };
    });
  }

  static isDefinitivePaystackRefundSubmissionFailure(error) {
    if (!error || error.code === "PAYSTACK_REQUEST_TIMEOUT") {
      return false;
    }

    const providerStatusCode = Number(error.providerStatusCode);

    if (
      Number.isInteger(providerStatusCode) &&
      providerStatusCode >= 400 &&
      providerStatusCode < 500
    ) {
      return true;
    }

    return Boolean(error.code === "PAYSTACK_PROVIDER_REJECTED_REQUEST" && error.providerResponse);
  }

  static async submitPaystackRefund({ batch, line }) {
    EmployerRefundBatchService.assertPaystackRefundAdapterAvailable();

    return PaystackService.createRefund({
      transaction: line.originalPaystackReference,
      amount: line.totalAmount,
      currency: batch.currency,

      // This is a Loqum reconciliation trace key, not provider-side idempotency.
      idempotencyKey: EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line),

      metadata: {
        employerRefundBatchId: String(batch._id),
        employerRefundBatchReference: batch.referenceCode,
        employerRefundBatchLineId: String(line._id),
        employerRefundLineReference: line.lineReference,
        allocationCount: line.allocationCount,
      },
    });
  }

  static async reconcileAuthorizedPaystackLine({ batch, line }) {
    EmployerRefundBatchService.assertPaystackRefundReconciliationAdapterAvailable({
      requireTraceLookup: !line.paystackRefund?.refundId,
    });

    const traceKey = EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line);

    if (line.paystackRefund?.refundId) {
      const refund = await PaystackService.fetchRefund(line.paystackRefund.refundId);

      return {
        found: true,
        source: "refund_id",
        traceKey,
        refund,
        outcome: EmployerRefundBatchService.normalizePaystackRefundOutcome(refund),
      };
    }

    const reconciliation = await PaystackService.findRefundByTraceKey({
      transaction: line.originalPaystackReference,
      idempotencyKey: traceKey,
      currency: batch.currency,
    });

    if (!reconciliation?.found || !reconciliation.refund) {
      return {
        found: false,
        source: "trace_key",
        traceKey,
        refund: null,
        outcome: null,
      };
    }

    return {
      found: true,
      source: "trace_key",
      traceKey,
      refund: reconciliation.refund,
      outcome: EmployerRefundBatchService.normalizePaystackRefundOutcome(reconciliation.refund),
    };
  }

  static applyPaystackPendingState({ line, outcome, currentTime }) {
    if (line.paystackRefund.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack moved a conclusively failed refund back to a pending state. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_REGRESSED_AFTER_FAILURE",
        statusCode: 409,
      });
    }

    if (line.retry?.status === "queued" && line.paystackRefund.needsAttentionAt) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack moved the refund to a pending state before the queued Retry Refund crossed the provider boundary. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_RECOVERED_BEFORE_RETRY_SUBMISSION",
        statusCode: 409,
      });
    }

    if (line.retry?.status === "submitting") {
      line.retry.status = "submitted";
      line.retry.submittedAt = line.retry.submittedAt || currentTime;
      line.retry.failedAt = null;
      line.retry.lastError = null;
    } else if (line.retry?.status === "completed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack moved a refund back to pending after Retry Refund was completed. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_REGRESSED_AFTER_RETRY_COMPLETION",
        statusCode: 409,
      });
    } else if (line.retry?.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack moved a refund back to pending after Retry Refund failed. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_RECOVERED_AFTER_RETRY_FAILURE",
        statusCode: 409,
      });
    }

    const idempotencyKey = EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line);

    line.paystackRefund.idempotencyKey = idempotencyKey;
    line.paystackRefund.refundId = outcome.refundId || line.paystackRefund.refundId || null;
    line.paystackRefund.reference = outcome.reference || line.paystackRefund.reference || null;
    line.paystackRefund.status = outcome.status;
    line.paystackRefund.submittedAt =
      line.paystackRefund.submittedAt || line.processingStartedAt || currentTime;

    if (outcome.status === "processing") {
      line.paystackRefund.processingAt = line.paystackRefund.processingAt || currentTime;
    }

    line.paystackRefund.lastSyncedAt = currentTime;
    line.paystackRefund.rawStatus = outcome.rawStatus;

    line.status = "pending_provider";
    line.pendingProviderAt = line.pendingProviderAt || currentTime;
  }

  static applyRetryFailureState({ line, currentTime, failureReason }) {
    const resolvedFailureReason = EmployerRefundBatchService.shortReason(
      failureReason || "Paystack Retry Refund failed."
    );

    if (!["submitting", "submitted"].includes(line.retry.status)) {
      throw EmployerRefundBatchService.createError({
        message: "Only an in-flight Retry Refund may be marked failed.",
        code: "PAYSTACK_RETRY_REFUND_FAILURE_STATE_CONFLICT",
        statusCode: 409,
      });
    }

    if (line.paystackRefund.status !== "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Retry Refund cannot become terminally failed before the underlying Paystack refund is conclusively failed.",
        code: "PAYSTACK_RETRY_REFUND_PROVIDER_FAILURE_REQUIRED",
        statusCode: 409,
      });
    }

    line.retry.status = "failed";
    line.retry.failedAt = currentTime;
    line.retry.lastError = resolvedFailureReason;
  }

  static queuePaystackRetryRefund(line, currentTime) {
    if (line.retry.status !== "not_required") {
      return false;
    }

    line.retry.status = "queued";
    line.retry.idempotencyKey =
      EmployerRefundBatchService.buildPaystackRetryRefundIdempotencyKey(line);
    line.retry.attemptCount = 0;
    line.retry.queuedAt = currentTime;
    line.retry.submittingAt = null;
    line.retry.submittedAt = null;
    line.retry.completedAt = null;
    line.retry.failedAt = null;
    line.retry.lastError = null;

    return true;
  }

  static applyPaystackNeedsAttentionState({ line, outcome, currentTime }) {
    const providerIdentifier = outcome.reference || outcome.refundId;

    if (!providerIdentifier) {
      throw EmployerRefundBatchService.createError({
        message: "A Paystack refund needing attention requires a provider identifier.",
        code: "PAYSTACK_REFUND_PROVIDER_IDENTIFIER_MISSING",
        statusCode: 409,
      });
    }

    if (line.paystackRefund.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reported needs_attention after the refund was conclusively failed. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_REGRESSED_AFTER_FAILURE",
        statusCode: 409,
      });
    }

    if (line.retry.status === "completed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reported needs_attention after Retry Refund completed. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_REGRESSED_AFTER_RETRY_COMPLETION",
        statusCode: 409,
      });
    }

    if (line.retry.status === "submitted") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack returned needs_attention after an accepted Retry Refund. Manual reconciliation is required.",
        code: "PAYSTACK_RETRY_REFUND_REGRESSED_TO_NEEDS_ATTENTION",
        statusCode: 409,
      });
    }

    if (line.retry.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack returned needs_attention after Retry Refund was already terminally failed. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_RECOVERED_AFTER_RETRY_FAILURE",
        statusCode: 409,
      });
    }

    const idempotencyKey = EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line);

    line.paystackRefund.idempotencyKey = idempotencyKey;
    line.paystackRefund.refundId = outcome.refundId || line.paystackRefund.refundId || null;
    line.paystackRefund.reference = outcome.reference || line.paystackRefund.reference || null;
    line.paystackRefund.status = "needs_attention";
    line.paystackRefund.submittedAt =
      line.paystackRefund.submittedAt || line.processingStartedAt || currentTime;
    line.paystackRefund.needsAttentionAt = line.paystackRefund.needsAttentionAt || currentTime;
    line.paystackRefund.lastSyncedAt = currentTime;
    line.paystackRefund.rawStatus = outcome.rawStatus || "needs_attention";

    if (line.retry.status === "submitting") {
      line.status = "processing";
      return;
    }

    line.status = "awaiting_action";
    line.awaitingActionAt = line.awaitingActionAt || currentTime;
  }

  static applyPaystackFailureState({ line, outcome, currentTime, failureReason = null }) {
    if (line.paystackRefund.status === "processed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reports failure after this refund was already processed. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_FAILURE_AFTER_PROCESSING",
        statusCode: 409,
      });
    }

    if (line.walletMovement?.completedAt) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack refund failure was received after wallet fallback already completed. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_FAILURE_AFTER_WALLET_COMPLETION",
        statusCode: 409,
      });
    }

    const idempotencyKey = EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line);

    const resolvedFailureReason = EmployerRefundBatchService.shortReason(
      failureReason || `Paystack refund ended with status ${outcome.rawStatus || "failed"}.`
    );

    line.paystackRefund.idempotencyKey = idempotencyKey;
    line.paystackRefund.refundId = outcome.refundId || line.paystackRefund.refundId || null;
    line.paystackRefund.reference = outcome.reference || line.paystackRefund.reference || null;
    line.paystackRefund.status = "failed";
    line.paystackRefund.submittedAt =
      line.paystackRefund.submittedAt || line.processingStartedAt || currentTime;
    line.paystackRefund.failedAt = currentTime;
    line.paystackRefund.failureReason = resolvedFailureReason;
    line.paystackRefund.lastSyncedAt = currentTime;
    line.paystackRefund.rawStatus = outcome.rawStatus || "failed";

    if (line.retry.status === "queued") {
      EmployerRefundBatchService.clearUnsubmittedRetryAudit(line);

      if (line.bankConsent.status === "awaiting_consent") {
        line.bankConsent.status = "not_required";
        line.bankConsent.bankAccount = null;
        line.bankConsent.requestedAt = null;
        line.bankConsent.confirmedAt = null;
        line.bankConsent.confirmedBy = null;
      }
    } else if (["submitting", "submitted"].includes(line.retry.status)) {
      EmployerRefundBatchService.applyRetryFailureState({
        line,
        currentTime,
        failureReason: resolvedFailureReason,
      });
    } else if (line.retry.status === "completed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reports failure after Retry Refund was recorded as completed. Manual financial reconciliation is required.",
        code: "PAYSTACK_REFUND_FAILURE_AFTER_RETRY_COMPLETION",
        statusCode: 409,
      });
    }

    line.status = "processing";
  }

  static clearUnsubmittedRetryAudit(line) {
    if (!line?.retry || line.retry.status !== "queued") {
      return false;
    }

    line.retry.status = "not_required";
    line.retry.idempotencyKey = null;
    line.retry.attemptCount = 0;
    line.retry.queuedAt = null;
    line.retry.submittingAt = null;
    line.retry.submittedAt = null;
    line.retry.completedAt = null;
    line.retry.failedAt = null;
    line.retry.lastError = null;

    return true;
  }

  static finalizeRetryAuditAfterProviderSuccess(line, currentTime) {
    if (!line?.retry) {
      return;
    }

    if (line.retry.status === "not_required") {
      if (line.paystackRefund.needsAttentionAt) {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports success after needs_attention without a completed Retry Refund. Manual reconciliation is required.",
          code: "PAYSTACK_REFUND_SUCCESS_WITHOUT_RETRY_COMPLETION",
          statusCode: 409,
        });
      }

      return;
    }

    if (line.retry.status === "queued") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reports success while Retry Refund is still only queued. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_SUCCESS_BEFORE_RETRY_SUBMISSION",
        statusCode: 409,
      });
    }

    if (line.retry.status === "submitting") {
      line.retry.status = "completed";
      line.retry.submittedAt = line.retry.submittedAt || currentTime;
      line.retry.completedAt = currentTime;
      line.retry.failedAt = null;
      line.retry.lastError = null;
      return;
    }

    if (line.retry.status === "submitted") {
      line.retry.status = "completed";
      line.retry.completedAt = currentTime;
      line.retry.failedAt = null;
      line.retry.lastError = null;
      return;
    }

    if (line.retry.status === "completed") {
      line.retry.completedAt = line.retry.completedAt || currentTime;
      return;
    }

    if (line.retry.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reports success after Retry Refund was recorded as failed. Manual double-refund reconciliation is required.",
        code: "PAYSTACK_REFUND_SUCCESS_AFTER_RETRY_FAILURE",
        statusCode: 409,
      });
    }
  }

  /* ─────────────────────────────── REFUND BANK CONSENT ─────────────────────────────── */

  static async getConfirmedConsentBankAccount({ batch, line, session = null }) {
    if (line.bankConsent?.status !== "confirmed" || !line.bankConsent?.bankAccount) {
      throw EmployerRefundBatchService.createError({
        message: "Confirmed employer bank consent is required for Retry Refund.",
        code: "EMPLOYER_REFUND_BANK_CONSENT_REQUIRED",
        statusCode: 409,
      });
    }

    const bankAccount = await EmployerRefundBatchService.getActiveEmployerRefundBankAccount({
      businessId: batch.business,
      bankAccountId: line.bankConsent.bankAccount,
      session,
    });

    EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

    return bankAccount;
  }

  static async confirmRefundBankConsent(
    { batchId, lineId, userId, currentTime = new Date() },
    options = {}
  ) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    return EmployerRefundBatchService.runWithOptionalTransaction(options, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      const { userId: normalizedUserId } =
        await EmployerRefundBatchService.assertEmployerUserOwnsBatch({
          batch,
          userId,
          session,
        });

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.fundingMethod !== "paystack_checkout") {
        throw EmployerRefundBatchService.createError({
          message: "Bank consent applies only to Paystack-funded employer refunds.",
          code: "REFUND_BANK_CONSENT_NOT_APPLICABLE",
          statusCode: 409,
        });
      }

      if (line.status !== "awaiting_action" || line.paystackRefund.status !== "needs_attention") {
        throw EmployerRefundBatchService.createError({
          message: "This refund line is not awaiting employer bank confirmation.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_NOT_PENDING",
          statusCode: 409,
        });
      }

      if (["submitting", "submitted", "completed", "failed"].includes(line.retry.status)) {
        throw EmployerRefundBatchService.createError({
          message: "The Retry Refund workflow has already crossed its bank-confirmation boundary.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_ALREADY_FINAL",
          statusCode: 409,
        });
      }

      const bankAccount = await EmployerRefundBatchService.getActiveEmployerRefundBankAccount({
        businessId: batch.business,
        session,
      });

      EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

      const alreadyConfirmed =
        line.bankConsent.status === "confirmed" &&
        EmployerRefundBatchService.sameId(line.bankConsent.bankAccount, bankAccount._id) &&
        line.retry.status === "queued";

      if (alreadyConfirmed) {
        return {
          batch,
          line,
          confirmed: true,
          idempotent: true,
        };
      }

      line.bankConsent.status = "confirmed";
      line.bankConsent.bankAccount = bankAccount._id;
      line.bankConsent.requestedAt = normalizedCurrentTime;
      line.bankConsent.confirmedAt = normalizedCurrentTime;
      line.bankConsent.confirmedBy = normalizedUserId;

      if (line.retry.status === "not_required") {
        EmployerRefundBatchService.queuePaystackRetryRefund(line, normalizedCurrentTime);
      }

      line.status = "awaiting_action";
      line.awaitingActionAt = line.awaitingActionAt || normalizedCurrentTime;

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        confirmed: true,
        idempotent: false,
      };
    });
  }

  static async getPaystackRetryPreparation({ batchId, lineId }) {
    EmployerRefundBatchService.assertPaystackRetryRefundAdapterAvailable();

    const batch = await EmployerRefundBatchService.getBatch(batchId, null, {
      includeProcessingToken: true,
    });

    const line = batch.lines.id(lineId);

    if (!line) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch line was not found.",
        code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (line.fundingMethod !== "paystack_checkout") {
      throw EmployerRefundBatchService.createError({
        message: "Retry Refund applies only to a Paystack-funded refund line.",
        code: "PAYSTACK_RETRY_REFUND_NOT_APPLICABLE",
        statusCode: 409,
      });
    }

    if (line.retry.status === "completed") {
      return {
        batch,
        line,
        completed: true,
        requiresReconciliation: false,
        bankAccount: null,
        bankId: null,
      };
    }

    if (["submitting", "submitted"].includes(line.retry.status)) {
      return {
        batch,
        line,
        completed: false,
        requiresReconciliation: true,
        bankAccount: null,
        bankId: null,
      };
    }

    if (
      line.status !== "awaiting_action" ||
      line.paystackRefund.status !== "needs_attention" ||
      line.retry.status !== "queued" ||
      line.bankConsent.status !== "confirmed" ||
      !line.bankConsent.bankAccount
    ) {
      throw EmployerRefundBatchService.createError({
        message:
          "Retry Refund requires needs_attention, a queued retry and confirmed employer bank consent.",
        code: "PAYSTACK_RETRY_REFUND_NOT_READY",
        statusCode: 409,
      });
    }

    if (!line.paystackRefund.refundId) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund requires the provider refund ID. Reconcile the original refund before retrying.",
        code: "PAYSTACK_RETRY_REFUND_ID_REQUIRED",
        statusCode: 409,
      });
    }

    const bankAccount = await EmployerRefundBatchService.getConfirmedConsentBankAccount({
      batch,
      line,
    });

    const bankDetails = EmployerRefundBatchService.assertUsableRefundBankAccount(
      bankAccount,
      batch.business
    );

    const bankId = await EmployerRefundBatchService.resolvePaystackRefundBankId({
      bankCode: bankDetails.bankCode,
      countryCode: batch.countryCode,
      currency: batch.currency,
    });

    return {
      batch,
      line,
      completed: false,
      requiresReconciliation: false,
      bankAccount,
      bankId,
      accountNumber: bankDetails.accountNumber,
    };
  }

  static async authorizePaystackRetryRefund({
    batchId,
    lineId,
    currentTime = new Date(),
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedLockTtlMs = Number(lockTtlMs);

    if (!Number.isSafeInteger(normalizedLockTtlMs) || normalizedLockTtlMs <= 0) {
      throw EmployerRefundBatchService.createError({
        message: "Processing lock duration is invalid.",
        code: "INVALID_EMPLOYER_REFUND_BATCH_LOCK_TTL",
      });
    }

    return EmployerRefundBatchService.runWithOptionalTransaction({}, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.retry.status === "completed") {
        return {
          batch,
          line,
          authorized: false,
          completed: true,
          requiresReconciliation: false,
          processingToken: null,
        };
      }

      if (["submitting", "submitted"].includes(line.retry.status)) {
        return {
          batch,
          line,
          authorized: true,
          completed: false,
          requiresReconciliation: true,
          processingToken: null,
        };
      }

      if (
        batch.status !== "awaiting_action" ||
        batch.processingToken ||
        line.fundingMethod !== "paystack_checkout" ||
        line.status !== "awaiting_action" ||
        line.paystackRefund.status !== "needs_attention" ||
        line.retry.status !== "queued" ||
        line.bankConsent.status !== "confirmed" ||
        !line.bankConsent.bankAccount
      ) {
        throw EmployerRefundBatchService.createError({
          message: "Retry Refund is no longer in an executable state.",
          code: "PAYSTACK_RETRY_REFUND_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      const bankAccount = await EmployerRefundBatchService.getActiveEmployerRefundBankAccount({
        businessId: batch.business,
        bankAccountId: line.bankConsent.bankAccount,
        session,
      });

      EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

      const processingToken = EmployerRefundBatchService.createProcessingToken();

      batch.status = "processing";
      batch.processingToken = processingToken;
      batch.lockedAt = normalizedCurrentTime;
      batch.lockExpiresAt = new Date(normalizedCurrentTime.getTime() + normalizedLockTtlMs);
      batch.attemptCount = Number(batch.attemptCount || 0) + 1;
      batch.lastAttemptAt = normalizedCurrentTime;
      batch.processingStartedAt = batch.processingStartedAt || normalizedCurrentTime;

      line.status = "processing";
      line.attemptCount = Number(line.attemptCount || 0) + 1;
      line.lastAttemptAt = normalizedCurrentTime;
      line.processingStartedAt = line.processingStartedAt || normalizedCurrentTime;

      line.retry.status = "submitting";
      line.retry.attemptCount = Number(line.retry.attemptCount || 0) + 1;
      line.retry.submittingAt = normalizedCurrentTime;
      line.retry.submittedAt = null;
      line.retry.completedAt = null;
      line.retry.failedAt = null;
      line.retry.lastError = null;

      await batch.save({ session });

      return {
        batch,
        line,
        authorized: true,
        completed: false,
        requiresReconciliation: false,
        processingToken,
      };
    });
  }

  static async persistPaystackRetryOutcome({
    batchId,
    lineId,
    outcome,
    processingToken = null,
    providerEventId = null,
    failureReason = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    if (outcome.status === "processed") {
      return EmployerRefundBatchService.finalizeProcessedPaystackLine({
        batchId,
        lineId,
        processingToken,
        outcome,
        providerEventId,
        currentTime: normalizedCurrentTime,
      });
    }

    return EmployerRefundBatchService.runWithOptionalTransaction({}, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      if (batch.status === "processing" && processingToken) {
        EmployerRefundBatchService.assertProcessingLock(batch, processingToken);
      }

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (["pending", "processing"].includes(outcome.status)) {
        EmployerRefundBatchService.applyPaystackPendingState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });

        if (providerEventId) {
          line.paystackRefund.lastProviderEventId = providerEventId;
        }

        EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

        await batch.save({ session });

        return {
          batch,
          line,
          completed: false,
          providerStatus: line.paystackRefund.status,
        };
      }

      if (outcome.status === "failed") {
        EmployerRefundBatchService.applyPaystackFailureState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
          failureReason: failureReason || "Paystack refund failed after Retry Refund submission.",
        });

        if (providerEventId) {
          line.paystackRefund.lastProviderEventId = providerEventId;
        }

        return EmployerRefundBatchService.completePaystackWalletFallbackInSession({
          batch,
          line,
          currentTime: normalizedCurrentTime,
          session,
        });
      }

      throw EmployerRefundBatchService.createError({
        message: "Retry Refund returned an unsupported provider state.",
        code: "UNSUPPORTED_PAYSTACK_RETRY_REFUND_OUTCOME",
        statusCode: 502,
        details: {
          rawStatus: outcome.rawStatus || null,
        },
      });
    });
  }

  static async reconcilePaystackRetryRefund({
    batchId,
    lineId,
    processingToken = null,
    currentTime = new Date(),
  }) {
    EmployerRefundBatchService.assertPaystackRefundReconciliationAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const batch = await EmployerRefundBatchService.getBatch(batchId, null, {
      includeProcessingToken: true,
    });

    const line = batch.lines.id(lineId);

    if (!line) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch line was not found.",
        code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!["submitting", "submitted"].includes(line.retry.status)) {
      return {
        batch,
        line,
        reconciled: false,
        reason: "retry_not_in_flight",
      };
    }

    if (!line.paystackRefund.refundId) {
      throw EmployerRefundBatchService.createError({
        message: "Retry Refund reconciliation requires the Paystack refund ID.",
        code: "PAYSTACK_RETRY_REFUND_ID_REQUIRED",
        statusCode: 409,
      });
    }

    let providerResponse;

    try {
      providerResponse = await PaystackService.fetchRefund(line.paystackRefund.refundId);
    } catch (error) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund could not be reconciled. No new Retry Refund request was submitted.",
        code: "PAYSTACK_RETRY_REFUND_RECONCILIATION_FAILED",
        statusCode: 502,
        details: {
          cause: error.message,
          batchId: String(batchId),
          lineId: String(lineId),
        },
      });
    }

    const outcome = EmployerRefundBatchService.normalizePaystackRefundOutcome(providerResponse);

    if (!outcome || outcome.status === "ambiguous") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund remains ambiguous. No second Retry Refund may be submitted.",
        code: "PAYSTACK_RETRY_REFUND_RECONCILIATION_AMBIGUOUS",
        statusCode: 409,
        details: {
          rawStatus: outcome?.rawStatus || null,
        },
      });
    }

    if (outcome.status === "needs_attention") {
      if (line.retry.status === "submitted") {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack returned needs_attention after Retry Refund was accepted. Manual provider reconciliation is required.",
          code: "PAYSTACK_RETRY_REFUND_REGRESSED_TO_NEEDS_ATTENTION",
          statusCode: 409,
        });
      }

      if (processingToken && batch.status === "processing") {
        await EmployerRefundBatchService.expireProcessingLock({
          batchId,
          processingToken,
          currentTime: normalizedCurrentTime,
          reason: "Retry Refund remains unresolved while Paystack still reports needs_attention.",
        });
      }

      return {
        batch,
        line,
        reconciled: false,
        reason: "provider_still_needs_attention",
      };
    }

    const persisted = await EmployerRefundBatchService.persistPaystackRetryOutcome({
      batchId,
      lineId,
      processingToken,
      outcome,
      currentTime: normalizedCurrentTime,
    });

    return {
      ...persisted,
      reconciled: true,
    };
  }

  static async executePaystackRetryRefund({
    batchId,
    lineId,
    currentTime = new Date(),
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
  }) {
    EmployerRefundBatchService.assertPaystackRetryRefundAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const preparation = await EmployerRefundBatchService.getPaystackRetryPreparation({
      batchId,
      lineId,
    });

    if (preparation.completed) {
      return {
        batch: preparation.batch,
        line: preparation.line,
        completed: true,
        idempotent: true,
      };
    }

    if (preparation.requiresReconciliation) {
      return EmployerRefundBatchService.reconcilePaystackRetryRefund({
        batchId,
        lineId,
        currentTime: normalizedCurrentTime,
      });
    }

    const authorization = await EmployerRefundBatchService.authorizePaystackRetryRefund({
      batchId,
      lineId,
      currentTime: normalizedCurrentTime,
      lockTtlMs,
    });

    if (authorization.requiresReconciliation) {
      return EmployerRefundBatchService.reconcilePaystackRetryRefund({
        batchId,
        lineId,
        currentTime: normalizedCurrentTime,
      });
    }

    let providerResponse;

    try {
      providerResponse = await PaystackService.retryRefundWithCustomerDetails({
        refundId: authorization.line.paystackRefund.refundId,
        currency: authorization.batch.currency,
        accountNumber: preparation.accountNumber,
        bankId: preparation.bankId,
        idempotencyKey: authorization.line.retry.idempotencyKey,
      });
    } catch (error) {
      await EmployerRefundBatchService.expireProcessingLock({
        batchId,
        processingToken: authorization.processingToken,
        currentTime: normalizedCurrentTime,
        reason: `Paystack Retry Refund submission is unresolved: ${error.message}`,
      });

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund submission could not be conclusively confirmed. No second Retry Refund will be submitted until the existing refund is reconciled.",
        code: "PAYSTACK_RETRY_REFUND_SUBMISSION_UNRESOLVED",
        statusCode: 502,
        details: {
          cause: error.message,
          batchId: String(batchId),
          lineId: String(lineId),
          refundId: authorization.line.paystackRefund.refundId,
        },
      });
    }

    const outcome = EmployerRefundBatchService.normalizePaystackRefundOutcome(providerResponse);

    if (!outcome || outcome.status === "ambiguous") {
      await EmployerRefundBatchService.expireProcessingLock({
        batchId,
        processingToken: authorization.processingToken,
        currentTime: normalizedCurrentTime,
        reason: "Paystack Retry Refund returned an ambiguous response.",
      });

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund returned an ambiguous response. No second Retry Refund will be submitted until reconciliation succeeds.",
        code: "AMBIGUOUS_PAYSTACK_RETRY_REFUND_RESPONSE",
        statusCode: 502,
        details: {
          rawStatus: outcome?.rawStatus || null,
        },
      });
    }

    if (outcome.status === "needs_attention") {
      await EmployerRefundBatchService.expireProcessingLock({
        batchId,
        processingToken: authorization.processingToken,
        currentTime: normalizedCurrentTime,
        reason:
          "Paystack still reports needs_attention after Retry Refund submission. Reconciliation is required.",
      });

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack still reports needs_attention after the Retry Refund request. Loqum will reconcile the same refund and will not request another bank confirmation or submit a second retry.",
        code: "PAYSTACK_RETRY_REFUND_STILL_NEEDS_ATTENTION",
        statusCode: 409,
      });
    }

    return EmployerRefundBatchService.persistPaystackRetryOutcome({
      batchId,
      lineId,
      processingToken: authorization.processingToken,
      outcome,
      currentTime: normalizedCurrentTime,
    });
  }

  static async finalizeProcessedPaystackLine({
    batchId,
    lineId,
    processingToken = null,
    outcome,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    return EmployerRefundBatchService.runWithOptionalTransaction({}, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      if (batch.status === "processing" && processingToken) {
        EmployerRefundBatchService.assertProcessingLock(batch, processingToken);
      }

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.status === "completed") {
        if (line.finalExecutionMethod === "paystack_refund") {
          return {
            batch,
            line,
            completed: true,
            idempotent: true,
          };
        }

        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports the refund as processed after this line already completed through wallet fallback. Manual double-refund reconciliation is required.",
          code: "PAYSTACK_REFUND_PROCESSED_AFTER_WALLET_FALLBACK",
          statusCode: 409,
          details: {
            finalExecutionMethod: line.finalExecutionMethod,
          },
        });
      }

      if (line.fundingMethod !== "paystack_checkout") {
        throw EmployerRefundBatchService.createError({
          message: "The refund line is not Paystack-funded.",
          code: "REFUND_LINE_NOT_PAYSTACK_FUNDED",
          statusCode: 409,
        });
      }

      if (!["processing", "pending_provider", "awaiting_action"].includes(line.status)) {
        throw EmployerRefundBatchService.createError({
          message: `A processed Paystack refund cannot complete from ${line.status}.`,
          code: "PAYSTACK_REFUND_COMPLETION_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      if (line.paystackRefund.status === "failed") {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports success after the refund was conclusively failed. Manual financial reconciliation is required before completion.",
          code: "PAYSTACK_REFUND_SUCCESS_AFTER_FAILURE",
          statusCode: 409,
        });
      }

      if (line.walletMovement?.completedAt) {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports success after wallet fallback already completed. Manual double-refund reconciliation is required.",
          code: "PAYSTACK_REFUND_SUCCESS_AFTER_WALLET_FALLBACK",
          statusCode: 409,
        });
      }

      const resolvedRefundId = outcome.refundId || line.paystackRefund.refundId || null;
      const resolvedRefundReference = outcome.reference || line.paystackRefund.reference || null;

      const providerIdentifier = resolvedRefundReference || resolvedRefundId;

      if (!providerIdentifier) {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports the refund as processed, but Loqum has not yet resolved the provider refund identifier. Reconciliation must resolve the same refund before completion.",
          code: "PAYSTACK_REFUND_PROCESSED_IDENTIFIER_PENDING",
          statusCode: 503,
        });
      }

      EmployerRefundBatchService.finalizeRetryAuditAfterProviderSuccess(
        line,
        normalizedCurrentTime
      );

      line.paystackRefund.idempotencyKey =
        line.paystackRefund.idempotencyKey ||
        EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line);

      line.paystackRefund.refundId = resolvedRefundId;
      line.paystackRefund.reference = resolvedRefundReference;
      line.paystackRefund.status = "processed";
      line.paystackRefund.submittedAt =
        line.paystackRefund.submittedAt || line.processingStartedAt || normalizedCurrentTime;
      line.paystackRefund.processedAt = normalizedCurrentTime;
      line.paystackRefund.failedAt = null;
      line.paystackRefund.failureReason = null;
      line.paystackRefund.lastSyncedAt = normalizedCurrentTime;
      line.paystackRefund.lastProviderEventId =
        providerEventId || line.paystackRefund.lastProviderEventId;
      line.paystackRefund.rawStatus = outcome.rawStatus || "processed";

      const originalFundingTransaction = line.allocations[0]?.originalFundingTransaction || null;

      const ledgerResult = await WalletService.debitWallet(
        {
          walletId: batch.escrowWallet,
          amount: line.totalAmount,

          type: "shift_refund",
          purpose: "weekly_employer_refund",
          paymentRail: "paystack_refund",
          provider: "paystack",
          status: "completed",
          paystackStatus: "success",

          idempotencyKey: EmployerRefundBatchService.buildPaystackLedgerIdempotencyKey(line),
          paystackReference: String(providerIdentifier),
          providerEventId,
          relatedTransaction: originalFundingTransaction,

          employerRefundBatch: batch._id,
          employerRefundBatchLineId: line._id,

          initiatedBy: {
            role: "system",
            userId: null,
          },

          description: `Weekly employer Paystack refund ${line.lineReference}`,

          metadata: {
            employerRefundBatchReference: batch.referenceCode,
            employerRefundLineReference: line.lineReference,
            originalPaystackReference: line.originalPaystackReference,
            paystackRefundId: resolvedRefundId,
            paystackRefundReference: resolvedRefundReference,
            allocationCount: line.allocationCount,
          },
        },
        {
          session,
        }
      );

      const executionTransaction = ledgerResult.transaction;

      line.executionTransactions = EmployerRefundBatchService.appendUniqueIds(
        line.executionTransactions,
        [executionTransaction._id]
      );

      line.completedTransaction = executionTransaction._id;
      line.finalExecutionMethod = "paystack_refund";
      line.status = "completed";
      line.completedAt = normalizedCurrentTime;

      await EmployerRefundBatchService.completeRefundObligations({
        batch,
        line,
        executionMethod: "paystack_refund",
        executionTransactionIds: [executionTransaction._id],
        completedTransactionId: executionTransaction._id,
        currentTime: normalizedCurrentTime,
        session,
      });

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        completed: true,
        idempotent: Boolean(ledgerResult.idempotent),
      };
    });
  }

  static async persistPaystackSubmissionOutcome({
    batchId,
    lineId,
    processingToken,
    outcome,
    providerEventId = null,
    failureReason = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    if (outcome.status === "processed") {
      return EmployerRefundBatchService.finalizeProcessedPaystackLine({
        batchId,
        lineId,
        processingToken,
        outcome,
        providerEventId,
        currentTime: normalizedCurrentTime,
      });
    }

    return EmployerRefundBatchService.runWithOptionalTransaction({}, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      EmployerRefundBatchService.assertProcessingLock(batch, processingToken);

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.status === "completed") {
        return {
          batch,
          line,
          completed: true,
          idempotent: true,
        };
      }

      if (["pending", "processing"].includes(outcome.status)) {
        EmployerRefundBatchService.applyPaystackPendingState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else if (outcome.status === "needs_attention") {
        EmployerRefundBatchService.applyPaystackNeedsAttentionState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else if (outcome.status === "failed") {
        EmployerRefundBatchService.applyPaystackFailureState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
          failureReason,
        });

        if (providerEventId) {
          line.paystackRefund.lastProviderEventId = providerEventId;
        }

        return EmployerRefundBatchService.completePaystackWalletFallbackInSession({
          batch,
          line,
          currentTime: normalizedCurrentTime,
          session,
        });
      } else {
        throw EmployerRefundBatchService.createError({
          message: "Paystack returned an ambiguous refund response after submission.",
          code: "AMBIGUOUS_PAYSTACK_REFUND_RESPONSE",
          statusCode: 502,
          details: {
            rawStatus: outcome.rawStatus,
          },
        });
      }

      if (providerEventId) {
        line.paystackRefund.lastProviderEventId = providerEventId;
      }

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        completed: false,
        providerStatus: line.paystackRefund.status,
      };
    });
  }

  static async executePaystackLine({ batchId, lineId, processingToken, currentTime = new Date() }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const authorization = await EmployerRefundBatchService.authorizePaystackLine({
      batchId,
      lineId,
      processingToken,
      currentTime: normalizedCurrentTime,
    });

    if (!authorization.authorized) {
      return authorization;
    }

    let outcome;
    let reconciled = false;

    if (authorization.requiresReconciliation) {
      let reconciliation;

      try {
        reconciliation = await EmployerRefundBatchService.reconcileAuthorizedPaystackLine({
          batch: authorization.batch,
          line: authorization.line,
        });
      } catch (error) {
        await EmployerRefundBatchService.expireProcessingLock({
          batchId,
          processingToken,
          currentTime: normalizedCurrentTime,
          reason: `Paystack refund reconciliation failed: ${error.message}`,
        });

        throw EmployerRefundBatchService.createError({
          message:
            "The Paystack refund could not be reconciled. No new refund request was submitted.",
          code: "PAYSTACK_REFUND_RECONCILIATION_FAILED",
          statusCode: 502,
          details: {
            cause: error.message,
            batchId: String(batchId),
            lineId: String(lineId),
          },
        });
      }

      if (!reconciliation.found) {
        await EmployerRefundBatchService.expireProcessingLock({
          batchId,
          processingToken,
          currentTime: normalizedCurrentTime,
          reason:
            "No Paystack refund could yet be matched to the authorized Loqum refund. Automatic resubmission is blocked to prevent a duplicate refund.",
        });

        throw EmployerRefundBatchService.createError({
          message:
            "The prior Paystack refund attempt is still unresolved. Loqum will not submit another refund until the first attempt is conclusively reconciled.",
          code: "PAYSTACK_REFUND_RECONCILIATION_UNRESOLVED",
          statusCode: 409,
          details: {
            batchId: String(batchId),
            lineId: String(lineId),
            traceKey: reconciliation.traceKey,
          },
        });
      }

      outcome = reconciliation.outcome;
      reconciled = true;
    } else {
      let providerResponse;

      try {
        providerResponse = await EmployerRefundBatchService.submitPaystackRefund({
          batch: authorization.batch,
          line: authorization.line,
        });
      } catch (error) {
        if (EmployerRefundBatchService.isDefinitivePaystackRefundSubmissionFailure(error)) {
          const failedOutcome = {
            status: "failed",
            rawStatus: "provider_rejected",
            refundId: null,
            reference: null,
            payload: error.providerResponse || null,
          };

          const persistedFailure =
            await EmployerRefundBatchService.persistPaystackSubmissionOutcome({
              batchId,
              lineId,
              processingToken,
              outcome: failedOutcome,
              failureReason: error.message,
              currentTime: normalizedCurrentTime,
            });

          return {
            ...persistedFailure,
            reconciled: false,
            definitiveProviderFailure: true,
            staleAllocations: authorization.staleAllocations,
          };
        }

        await EmployerRefundBatchService.expireProcessingLock({
          batchId,
          processingToken,
          currentTime: normalizedCurrentTime,
          reason: `Paystack refund submission is unresolved. Reconciliation is required before any new submission. ${error.message}`,
        });

        throw EmployerRefundBatchService.createError({
          message:
            "Paystack refund submission could not be conclusively confirmed. The refund remains authorized but unresolved; the next attempt must reconcile the provider before any new submission.",
          code: "PAYSTACK_REFUND_SUBMISSION_UNRESOLVED",
          statusCode: 502,
          details: {
            cause: error.message,
            batchId: String(batchId),
            lineId: String(lineId),
            traceKey: EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(
              authorization.line
            ),
          },
        });
      }

      outcome = EmployerRefundBatchService.normalizePaystackRefundOutcome(providerResponse);
    }

    if (!outcome || outcome.status === "ambiguous") {
      await EmployerRefundBatchService.expireProcessingLock({
        batchId,
        processingToken,
        currentTime: normalizedCurrentTime,
        reason:
          "Paystack refund state is ambiguous. No new provider submission or fallback movement is allowed until reconciliation succeeds.",
      });

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack refund state is ambiguous. No duplicate refund or fallback movement will be attempted until the provider state is reconciled.",
        code: "AMBIGUOUS_PAYSTACK_REFUND_RESPONSE",
        statusCode: 502,
        details: {
          rawStatus: outcome?.rawStatus || null,
          traceKey: EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(
            authorization.line
          ),
        },
      });
    }

    const persisted = await EmployerRefundBatchService.persistPaystackSubmissionOutcome({
      batchId,
      lineId,
      processingToken,
      outcome,
      currentTime: normalizedCurrentTime,
    });

    return {
      ...persisted,
      reconciled,
      staleAllocations: authorization.staleAllocations,
    };
  }

  /* ─────────────────────────────── PROVIDER RECONCILIATION ─────────────────────────────── */

  static normalizeExternalPaystackStatus(status) {
    const rawStatus = String(status || "")
      .trim()
      .toLowerCase();

    if (SAFE_PAYSTACK_RAW_SUCCESS_STATUSES.includes(rawStatus)) {
      return "processed";
    }

    if (SAFE_PAYSTACK_RAW_PROCESSING_STATUSES.includes(rawStatus)) {
      return "processing";
    }

    if (SAFE_PAYSTACK_RAW_PENDING_STATUSES.includes(rawStatus)) {
      return "pending";
    }

    if (SAFE_PAYSTACK_RAW_NEEDS_ATTENTION_STATUSES.includes(rawStatus)) {
      return "needs_attention";
    }

    if (SAFE_PAYSTACK_RAW_FAILURE_STATUSES.includes(rawStatus)) {
      return "failed";
    }

    throw EmployerRefundBatchService.createError({
      message: "Unsupported Paystack refund status.",
      code: "UNSUPPORTED_PAYSTACK_REFUND_STATUS",
      details: {
        rawStatus,
        supportedStatuses: PAYSTACK_REFUND_STATUSES,
      },
    });
  }

  static async syncPaystackRefundStatus(
    {
      batchId,
      lineId,
      status,
      refundId = null,
      reference = null,
      providerEventId = null,
      failureReason = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedStatus = EmployerRefundBatchService.normalizeExternalPaystackStatus(status);

    const incomingRefundId = refundId ? String(refundId) : null;
    const incomingReference = reference ? String(reference) : null;

    if (normalizedStatus === "processed") {
      return EmployerRefundBatchService.finalizeProcessedPaystackLine({
        batchId,
        lineId,
        outcome: {
          status: normalizedStatus,
          rawStatus: String(status || "")
            .trim()
            .toLowerCase(),
          refundId: incomingRefundId,
          reference: incomingReference,
        },
        providerEventId,
        currentTime: normalizedCurrentTime,
      });
    }

    return EmployerRefundBatchService.runWithOptionalTransaction(options, async (session) => {
      const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
        includeProcessingToken: true,
      });

      const line = batch.lines.id(lineId);

      if (!line) {
        throw EmployerRefundBatchService.createError({
          message: "Employer refund batch line was not found.",
          code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
          statusCode: 404,
        });
      }

      if (line.fundingMethod !== "paystack_checkout") {
        throw EmployerRefundBatchService.createError({
          message: "Only a Paystack-funded line may receive Paystack refund status updates.",
          code: "REFUND_LINE_NOT_PAYSTACK_FUNDED",
          statusCode: 409,
        });
      }

      if (providerEventId && line.paystackRefund.lastProviderEventId === providerEventId) {
        return {
          batch,
          line,
          idempotent: true,
        };
      }

      if (line.status === "completed") {
        const sameWalletFallbackFailure =
          line.finalExecutionMethod === "wallet_balance" &&
          line.paystackRefund.status === "failed" &&
          normalizedStatus === "failed";

        if (sameWalletFallbackFailure) {
          return {
            batch,
            line,
            idempotent: true,
          };
        }

        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reported a provider state after this refund line already completed. Manual financial reconciliation is required.",
          code: "PAYSTACK_REFUND_UPDATE_AFTER_COMPLETION_CONFLICT",
          statusCode: 409,
          details: {
            finalExecutionMethod: line.finalExecutionMethod,
            providerStatus: normalizedStatus,
          },
        });
      }

      const outcome = {
        status: normalizedStatus,
        rawStatus: String(status || "")
          .trim()
          .toLowerCase(),
        refundId: incomingRefundId || line.paystackRefund.refundId || null,
        reference: incomingReference || line.paystackRefund.reference || null,
      };

      const hasProviderIdentifier = Boolean(outcome.refundId || outcome.reference);

      /*
       * Paystack webhook notifications may reach Loqum before the provider
       * refund resource ID/reference has been persisted locally. The webhook
       * can still be tied safely to the exact batch line through the original
       * Checkout reference or ProviderEvent link.
       *
       * Do not invent a refund identifier and do not resubmit. If the current
       * line still has no provider refund identifier, leave its execution state
       * unchanged and let routine reconciliation resolve the same refund by the
       * Loqum trace key.
       */
      if (
        !hasProviderIdentifier &&
        ["pending", "processing", "needs_attention"].includes(normalizedStatus)
      ) {
        return {
          batch,
          line,
          idempotent: false,
          deferred: true,
          reconciliationRequired: true,
          reason: "provider_refund_identifier_pending",
        };
      }

      if (["pending", "processing"].includes(normalizedStatus)) {
        EmployerRefundBatchService.applyPaystackPendingState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else if (normalizedStatus === "needs_attention") {
        EmployerRefundBatchService.applyPaystackNeedsAttentionState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else {
        EmployerRefundBatchService.applyPaystackFailureState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
          failureReason,
        });
      }

      line.paystackRefund.lastProviderEventId =
        providerEventId || line.paystackRefund.lastProviderEventId || null;

      if (normalizedStatus === "failed") {
        return EmployerRefundBatchService.completePaystackWalletFallbackInSession({
          batch,
          line,
          currentTime: normalizedCurrentTime,
          session,
        });
      }

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      if (batch.status === "processing" && PAUSED_ASYNC_LINE_STATUSES.includes(line.status)) {
        batch.lockExpiresAt = normalizedCurrentTime;
      }

      await batch.save({ session });

      return {
        batch,
        line,
        idempotent: false,
      };
    });
  }

  static getPaystackReconciliationAnchor(line) {
    if (!line) {
      return null;
    }

    const candidates = [];

    if (["submitting", "submitted"].includes(line.retry?.status)) {
      candidates.push(
        line.retry.submittedAt,
        line.retry.submittingAt,
        line.lastAttemptAt,
        line.processingStartedAt
      );
    } else if (line.status === "pending_provider") {
      candidates.push(
        line.paystackRefund?.lastSyncedAt,
        line.pendingProviderAt,
        line.lastAttemptAt,
        line.processingStartedAt
      );
    } else if (line.status === "awaiting_action") {
      candidates.push(
        line.paystackRefund?.lastSyncedAt,
        line.paystackRefund?.needsAttentionAt,
        line.awaitingActionAt,
        line.lastAttemptAt,
        line.processingStartedAt
      );
    } else if (line.status === "processing") {
      candidates.push(
        line.paystackRefund?.lastSyncedAt,
        line.lastAttemptAt,
        line.processingStartedAt
      );
    }

    const validDates = candidates
      .filter(Boolean)
      .map((value) => new Date(value))
      .filter((value) => !Number.isNaN(value.getTime()));

    if (validDates.length === 0) {
      return null;
    }

    return validDates.reduce((latest, value) =>
      value.getTime() > latest.getTime() ? value : latest
    );
  }

  static lineRequiresPaystackReconciliation(line) {
    if (!line || line.fundingMethod !== "paystack_checkout") {
      return false;
    }

    if (TERMINAL_LINE_STATUSES.includes(line.status)) {
      return false;
    }

    if (["submitting", "submitted"].includes(line.retry?.status)) {
      return true;
    }

    if (
      line.status === "awaiting_action" &&
      line.paystackRefund?.status === "needs_attention" &&
      !line.paystackRefund?.refundId
    ) {
      return true;
    }

    return ["processing", "pending_provider"].includes(line.status);
  }

  static paystackReconciliationIsDue({ line, currentTime, minAgeMs }) {
    if (!EmployerRefundBatchService.lineRequiresPaystackReconciliation(line)) {
      return false;
    }

    const anchor = EmployerRefundBatchService.getPaystackReconciliationAnchor(line);

    if (!anchor) {
      return true;
    }

    return currentTime.getTime() - anchor.getTime() >= minAgeMs;
  }

  static async getPendingPaystackRefundReconciliationTargets({
    currentTime = new Date(),
    limit = DEFAULT_PAYSTACK_RECONCILIATION_LIMIT,
    minAgeMs = DEFAULT_PAYSTACK_RECONCILIATION_MIN_AGE_MS,
  } = {}) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedLimit = EmployerRefundBatchService.normalizePaystackReconciliationLimit(limit);

    const normalizedMinAgeMs =
      EmployerRefundBatchService.normalizePaystackReconciliationMinAgeMs(minAgeMs);

    const batches = await EmployerRefundBatch.find({
      status: {
        $in: PAYSTACK_RECONCILIATION_BATCH_STATUSES,
      },
      lines: {
        $elemMatch: {
          fundingMethod: "paystack_checkout",
          status: {
            $in: ["processing", "pending_provider", "awaiting_action"],
          },
        },
      },
    })
      .select("+processingToken")
      .sort({ updatedAt: 1, _id: 1 })
      .limit(normalizedLimit);

    const targets = [];

    for (const batch of batches) {
      const activelyLocked = Boolean(
        batch.status === "processing" &&
        batch.processingToken &&
        batch.lockExpiresAt &&
        new Date(batch.lockExpiresAt).getTime() > normalizedCurrentTime.getTime()
      );

      if (activelyLocked) {
        continue;
      }

      for (const line of batch.lines || []) {
        if (
          !EmployerRefundBatchService.paystackReconciliationIsDue({
            line,
            currentTime: normalizedCurrentTime,
            minAgeMs: normalizedMinAgeMs,
          })
        ) {
          continue;
        }

        targets.push({
          batchId: batch._id,
          lineId: line._id,
          batchStatus: batch.status,
          lineStatus: line.status,
          retryStatus: line.retry?.status || "not_required",
          paystackRefundStatus: line.paystackRefund?.status || "not_started",
        });

        if (targets.length >= normalizedLimit) {
          return targets;
        }
      }
    }

    return targets;
  }

  static async reconcilePendingPaystackRefundLine({ batchId, lineId, currentTime = new Date() }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const batch = await EmployerRefundBatchService.getBatch(batchId, null, {
      includeProcessingToken: true,
    });

    const line = batch.lines.id(lineId);

    if (!line) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch line was not found.",
        code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!EmployerRefundBatchService.lineRequiresPaystackReconciliation(line)) {
      return {
        batch,
        line,
        reconciled: false,
        skipped: true,
        reason: "line_no_longer_requires_reconciliation",
      };
    }

    const activelyLocked = Boolean(
      batch.status === "processing" &&
      batch.processingToken &&
      batch.lockExpiresAt &&
      new Date(batch.lockExpiresAt).getTime() > normalizedCurrentTime.getTime()
    );

    if (activelyLocked) {
      return {
        batch,
        line,
        reconciled: false,
        skipped: true,
        reason: "batch_actively_locked",
      };
    }

    if (["submitting", "submitted"].includes(line.retry?.status)) {
      return EmployerRefundBatchService.reconcilePaystackRetryRefund({
        batchId,
        lineId,
        currentTime: normalizedCurrentTime,
      });
    }

    const reconciliation = await EmployerRefundBatchService.reconcileAuthorizedPaystackLine({
      batch,
      line,
    });

    if (!reconciliation.found) {
      return {
        batch,
        line,
        reconciled: false,
        unresolved: true,
        reason: "provider_refund_not_found_yet",
        traceKey: reconciliation.traceKey,
      };
    }

    if (!reconciliation.outcome || reconciliation.outcome.status === "ambiguous") {
      return {
        batch,
        line,
        reconciled: false,
        unresolved: true,
        reason: "provider_refund_state_ambiguous",
        traceKey: reconciliation.traceKey,
        rawStatus: reconciliation.outcome?.rawStatus || null,
      };
    }

    const outcome = reconciliation.outcome;

    const failureReason =
      outcome.status === "failed"
        ? EmployerRefundBatchService.shortReason(
            outcome.payload?.reason ||
              outcome.payload?.failure_reason ||
              outcome.payload?.message ||
              `Paystack refund ended with status ${outcome.rawStatus || "failed"}.`
          )
        : null;

    const synchronized = await EmployerRefundBatchService.syncPaystackRefundStatus({
      batchId,
      lineId,
      status: outcome.status,
      refundId: outcome.refundId,
      reference: outcome.reference,
      failureReason,
      currentTime: normalizedCurrentTime,
    });

    return {
      ...synchronized,
      reconciled: true,
      reconciliationSource: reconciliation.source,
      traceKey: reconciliation.traceKey,
    };
  }

  static async reconcilePendingPaystackRefunds({
    currentTime = new Date(),
    limit = DEFAULT_PAYSTACK_RECONCILIATION_LIMIT,
    minAgeMs = DEFAULT_PAYSTACK_RECONCILIATION_MIN_AGE_MS,
  } = {}) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const targets = await EmployerRefundBatchService.getPendingPaystackRefundReconciliationTargets({
      currentTime: normalizedCurrentTime,
      limit,
      minAgeMs,
    });

    const result = {
      inspected: targets.length,
      reconciled: [],
      unresolved: [],
      skipped: [],
      failed: [],
    };

    for (const target of targets) {
      const identity = {
        batchId: String(target.batchId),
        lineId: String(target.lineId),
      };

      try {
        const reconciliation = await EmployerRefundBatchService.reconcilePendingPaystackRefundLine({
          batchId: target.batchId,
          lineId: target.lineId,
          currentTime: normalizedCurrentTime,
        });

        const entry = {
          ...identity,
          lineStatus: reconciliation.line?.status || target.lineStatus || null,
          paystackRefundStatus:
            reconciliation.line?.paystackRefund?.status || target.paystackRefundStatus || null,
          retryStatus: reconciliation.line?.retry?.status || target.retryStatus || null,
          reason: reconciliation.reason || null,
        };

        if (reconciliation.skipped) {
          result.skipped.push(entry);
        } else if (reconciliation.unresolved || reconciliation.reconciled === false) {
          result.unresolved.push(entry);
        } else {
          result.reconciled.push(entry);
        }
      } catch (error) {
        result.failed.push({
          ...identity,
          code: error.code || "PAYSTACK_REFUND_RECONCILIATION_FAILED",
          message: error.message || "Paystack refund reconciliation failed.",
        });
      }
    }

    return result;
  }

  /* ─────────────────────────────── BATCH PROCESSOR ─────────────────────────────── */

  static async processBatch({
    batchId,
    currentTime = new Date(),
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const lock = await EmployerRefundBatchService.acquireProcessingLock({
      batchId,
      currentTime: normalizedCurrentTime,
      lockTtlMs,
    });

    if (!lock.acquired) {
      return {
        batch: lock.batch,
        processed: false,
        reason: lock.reason,
      };
    }

    const processingToken = lock.processingToken;
    const results = [];

    try {
      let currentBatch = await EmployerRefundBatchService.getBatch(batchId, null, {
        includeProcessingToken: true,
      });

      EmployerRefundBatchService.assertProcessingLock(currentBatch, processingToken);

      const candidateLineIds = currentBatch.lines
        .filter((line) => ["queued", "processing"].includes(line.status))
        .map((line) => String(line._id));

      for (const lineId of candidateLineIds) {
        currentBatch = await EmployerRefundBatchService.getBatch(batchId, null, {
          includeProcessingToken: true,
        });

        if (currentBatch.status !== "processing") {
          break;
        }

        EmployerRefundBatchService.assertProcessingLock(currentBatch, processingToken);

        const currentLine = currentBatch.lines.id(lineId);

        if (!currentLine || !["queued", "processing"].includes(currentLine.status)) {
          continue;
        }

        let result;

        if (currentLine.fundingMethod === "wallet_balance") {
          result = await EmployerRefundBatchService.executeWalletLine({
            batchId,
            lineId,
            processingToken,
            currentTime: normalizedCurrentTime,
          });
        } else if (["submitting", "submitted"].includes(currentLine.retry?.status)) {
          result = await EmployerRefundBatchService.reconcilePaystackRetryRefund({
            batchId,
            lineId,
            processingToken,
            currentTime: normalizedCurrentTime,
          });
        } else {
          result = await EmployerRefundBatchService.executePaystackLine({
            batchId,
            lineId,
            processingToken,
            currentTime: normalizedCurrentTime,
          });
        }

        results.push({
          lineId,
          fundingMethod: currentLine.fundingMethod,
          status: result.line?.status || null,
          staleAllocations: result.staleAllocations || [],
        });

        if (result.reason === "provider_still_needs_attention") {
          break;
        }
      }

      let finalBatch = await EmployerRefundBatchService.getBatch(batchId, null, {
        includeProcessingToken: true,
      });

      if (
        finalBatch.status === "processing" &&
        !finalBatch.lines.some((line) => ["queued", "processing"].includes(line.status))
      ) {
        finalBatch = await EmployerRefundBatchService.runWithOptionalTransaction(
          {},
          async (session) => {
            const batch = await EmployerRefundBatchService.getBatch(batchId, session, {
              includeProcessingToken: true,
            });

            EmployerRefundBatchService.assertProcessingLock(batch, processingToken);

            EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

            await batch.save({ session });

            return batch;
          }
        );
      }

      return {
        batch: finalBatch,
        processed: true,
        results,
      };
    } catch (error) {
      try {
        await EmployerRefundBatchService.expireProcessingLock({
          batchId,
          processingToken,
          currentTime: normalizedCurrentTime,
          reason: error.message,
        });
      } catch (_lockError) {
        // Preserve the original processing error.
      }

      throw error;
    }
  }
}

module.exports = EmployerRefundBatchService;
