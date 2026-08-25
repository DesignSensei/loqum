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

const PROCESSABLE_BATCH_STATUSES = Object.freeze(["scheduled", "processing"]);

const TERMINAL_LINE_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

const ACTIVE_PROVIDER_LINE_STATUSES = Object.freeze(["pending_provider", "awaiting_action"]);

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

const SAFE_PAYSTACK_TRANSFER_SUCCESS_STATUSES = Object.freeze([
  "success",
  "successful",
  "completed",
]);

const SAFE_PAYSTACK_TRANSFER_PENDING_STATUSES = Object.freeze(["pending", "queued", "processing"]);

const SAFE_PAYSTACK_TRANSFER_OTP_STATUSES = Object.freeze(["otp"]);

const SAFE_PAYSTACK_TRANSFER_FAILURE_STATUSES = Object.freeze([
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "rejected",
]);

const SAFE_PAYSTACK_TRANSFER_REVERSED_STATUSES = Object.freeze(["reversed", "reverse"]);

/**
 * EMPLOYER REFUND BATCH SERVICE ARCHITECTURE
 *
 * ShiftRefundService owns the occurrence-level refund obligation.
 *
 * EmployerRefundBatchService owns:
 *
 * - weekly aggregation of eligible EmployerRefund obligations;
 * - the execution lock;
 * - immediate pre-execution revalidation;
 * - controlled removal / holding / voiding of stale allocations;
 * - wallet refund execution;
 * - Paystack refund submission and provider-state reconciliation;
 * - employer bank-consent handling for refund recovery;
 * - Paystack Retry Refund authorization, submission and reconciliation;
 * - admin approval of the exceptional fallback Transfer route; and
 * - completion of the occurrence-level obligation after money actually moves.
 *
 * CRITICAL EXECUTION RULE
 *
 * "batched" is not final financial authorization.
 *
 * Every queued allocation is revalidated immediately before execution. A stale
 * allocation is removed from the executable line before any wallet movement or
 * Paystack request begins.
 *
 * BASE-scoped blocker truth is delegated to ShiftRefundService. This service
 * does not infer refund eligibility from the occurrence's whole settlementStatus.
 * In particular, OT-only activity must never block the original scheduled/base
 * employer refund.
 *
 * "processing" is the point of no return for entitlement revalidation. Once an
 * allocation survives the final check and becomes processing, this service does
 * not reopen whether the employer is entitled to that refund. From that point it
 * only finishes or reconciles the already-authorized execution instruction.
 *
 * PAYSTACK NEEDS-ATTENTION
 *
 * A Paystack refund with needs_attention remains on the original refund route.
 * Paystack's Retry Refund requires the customer's bank details, so Loqum records
 * explicit employer consent to use a verified employer bank account before the
 * retry may be submitted. A separate fallback Paystack Transfer remains an
 * exceptional route after the refund route itself has failed.
 *
 * FALLBACK TRANSFER
 *
 * After the original Paystack Refund route and any Retry Refund are
 * conclusively failed, an admin-approved and employer-consented fallback
 * Transfer may return the protected refund to the employer's verified bank
 * account.
 *
 * The fallback route first creates a durable pending external-debit Transaction
 * and reserves the protected amount from escrow:
 *
 *   escrow.availableBalance -= amount
 *   escrow.pendingBalance   += amount
 *
 * Total escrow value is unchanged at that stage.
 *
 * The Transaction retains a deterministic Paystack Transfer reference before
 * the provider call. A timeout or lost response therefore enters
 * reconciliation-only mode rather than causing a second Transfer submission.
 *
 * Escrow value is consumed only after Paystack conclusively confirms success.
 * A definitive failure releases the pending escrow reservation back to
 * available balance.
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

  static buildFallbackTransferIdempotencyKey(line) {
    return `${line.idempotencyKey}:paystack-fallback-transfer`.slice(0, 200);
  }

  static buildFallbackTransferReference(line) {
    const hash = crypto
      .createHash("sha256")
      .update(String(line.idempotencyKey || line._id))
      .digest("hex");

    /*
     * Paystack Transfer references must be 16–50 characters and may contain
     * only lowercase letters, digits, hyphen and underscore.
     */
    return `erf_${hash.slice(0, 32)}`;
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

  static async createWeeklyBatch(
    {
      businessId,
      refundDate,
      timeZone,
      cutoffAt,
      scheduledFor,
      professionalSettlementCycleKey,
      professionalSettlementConfirmedAt,
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

    const normalizedProfessionalSettlementConfirmedAt = EmployerRefundBatchService.normalizeDate(
      professionalSettlementConfirmedAt,
      "professional settlement confirmation time"
    );

    const actor = EmployerRefundBatchService.normalizeActor(initiatedBy);

    if (!refundDate || !timeZone || !professionalSettlementCycleKey) {
      throw EmployerRefundBatchService.createError({
        message:
          "refundDate, timeZone and professionalSettlementCycleKey are required to create a refund batch.",
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

        professionalSettlementCycleKey,
        professionalSettlementConfirmedAt: normalizedProfessionalSettlementConfirmedAt,

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
       *
       * Therefore EmployerRefundBatch must NOT enforce database-global unique
       * indexes over embedded allocation employerRefund / occurrence values.
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

  static assertFallbackWalletAdapterAvailable() {
    const requiredMethods = [
      "createPendingExternalDebit",
      "markPendingExternalDebitProcessing",
      "completePendingExternalDebit",
      "markPendingExternalDebitFailed",
    ];

    const missingMethod = requiredMethods.find(
      (methodName) => typeof WalletService[methodName] !== "function"
    );

    if (missingMethod) {
      throw EmployerRefundBatchService.createError({
        message: `Fallback Transfer execution requires walletService.${missingMethod}().`,
        code: "FALLBACK_EXTERNAL_DEBIT_ADAPTER_UNAVAILABLE",
        statusCode: 503,
        details: {
          missingMethod,
        },
      });
    }
  }

  static assertPaystackTransferAdapterAvailable() {
    const requiredMethods = ["createTransferRecipient", "initiateTransfer", "verifyTransfer"];

    const missingMethod = requiredMethods.find(
      (methodName) => typeof PaystackService[methodName] !== "function"
    );

    if (missingMethod) {
      throw EmployerRefundBatchService.createError({
        message: `Paystack fallback Transfer execution requires paystackService.${missingMethod}().`,
        code: "PAYSTACK_TRANSFER_ADAPTER_UNAVAILABLE",
        statusCode: 503,
        details: {
          missingMethod,
        },
      });
    }
  }

  static assertPaystackTransferOtpAdapterAvailable() {
    if (typeof PaystackService.finalizeTransfer !== "function") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack OTP-protected Transfer completion requires paystackService.finalizeTransfer().",
        code: "PAYSTACK_TRANSFER_OTP_ADAPTER_UNAVAILABLE",
        statusCode: 503,
        details: {
          missingMethod: "finalizeTransfer",
        },
      });
    }
  }

  static extractPaystackTransferPayload(response) {
    return response?.data?.data || response?.data || response || {};
  }

  static normalizePaystackTransferOutcome(response) {
    const payload = EmployerRefundBatchService.extractPaystackTransferPayload(response);

    const rawStatus = String(payload.status || response?.status || "")
      .trim()
      .toLowerCase();

    const reference =
      String(payload.reference || payload.transfer_reference || response?.reference || "").trim() ||
      null;

    const transferCode =
      String(
        payload.transferCode ||
          payload.transfer_code ||
          response?.transferCode ||
          response?.transfer_code ||
          ""
      ).trim() || null;

    const recipientCode =
      String(
        payload.recipientCode ||
          payload.recipient_code ||
          payload.recipient?.recipient_code ||
          payload.recipient?.recipientCode ||
          response?.recipientCode ||
          ""
      ).trim() || null;

    const amountValue =
      payload.amount === null || payload.amount === undefined ? null : Number(payload.amount);

    const amount =
      amountValue !== null && Number.isSafeInteger(amountValue) && amountValue >= 0
        ? amountValue
        : null;

    const currency =
      String(payload.currency || response?.currency || "")
        .trim()
        .toUpperCase() || null;

    let status = null;

    if (SAFE_PAYSTACK_TRANSFER_SUCCESS_STATUSES.includes(rawStatus)) {
      status = "success";
    } else if (SAFE_PAYSTACK_TRANSFER_PENDING_STATUSES.includes(rawStatus)) {
      status = "pending";
    } else if (SAFE_PAYSTACK_TRANSFER_OTP_STATUSES.includes(rawStatus)) {
      status = "otp";
    } else if (SAFE_PAYSTACK_TRANSFER_FAILURE_STATUSES.includes(rawStatus)) {
      status = "failed";
    } else if (SAFE_PAYSTACK_TRANSFER_REVERSED_STATUSES.includes(rawStatus)) {
      status = "reversed";
    }

    if (!status) {
      return {
        status: "ambiguous",
        rawStatus,
        reference,
        transferCode,
        recipientCode,
        amount,
        currency,
        payload,
      };
    }

    return {
      status,
      rawStatus,
      reference,
      transferCode,
      recipientCode,
      amount,
      currency,
      payload,
    };
  }

  static assertPaystackTransferOutcomeMatches({ outcome, line, batch }) {
    if (!outcome) {
      throw EmployerRefundBatchService.createError({
        message: "Paystack Transfer outcome is missing.",
        code: "PAYSTACK_TRANSFER_OUTCOME_REQUIRED",
        statusCode: 502,
      });
    }

    const expectedReference = EmployerRefundBatchService.buildFallbackTransferReference(line);

    if (outcome.reference && outcome.reference !== expectedReference) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack returned a Transfer reference that does not match the authorized fallback Transfer.",
        code: "PAYSTACK_TRANSFER_REFERENCE_MISMATCH",
        statusCode: 409,
        details: {
          expectedReference,
          returnedReference: outcome.reference,
        },
      });
    }

    if (outcome.amount !== null && outcome.amount !== Number(line.totalAmount)) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack returned a Transfer amount that does not match the authorized fallback refund.",
        code: "PAYSTACK_TRANSFER_AMOUNT_MISMATCH",
        statusCode: 409,
        details: {
          expectedAmount: Number(line.totalAmount),
          returnedAmount: outcome.amount,
        },
      });
    }

    if (outcome.currency && outcome.currency !== String(batch.currency || "").toUpperCase()) {
      throw EmployerRefundBatchService.createError({
        message: "Paystack returned a Transfer currency that does not match the refund batch.",
        code: "PAYSTACK_TRANSFER_CURRENCY_MISMATCH",
        statusCode: 409,
        details: {
          expectedCurrency: batch.currency,
          returnedCurrency: outcome.currency,
        },
      });
    }

    return true;
  }

  static normalizeTransferRecipientResponse(response) {
    const payload = response?.data?.data || response?.data || response || {};

    const recipientCode =
      String(payload.recipientCode || payload.recipient_code || "").trim() || null;

    if (!recipientCode) {
      throw EmployerRefundBatchService.createError({
        message: "Paystack returned an incomplete Transfer recipient response.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_CODE_MISSING",
        statusCode: 502,
        details: {
          providerResponse: payload,
        },
      });
    }

    return {
      recipientCode,
      payload,
    };
  }

  static resolvePaystackTransferRecipientType({ countryCode, currency }) {
    const normalizedCountryCode = EmployerRefundBatchService.normalizeCountryCode(countryCode);

    const normalizedCurrency = EmployerRefundBatchService.normalizeCurrency(currency);

    const recipientTypeByMarket = {
      "NG:NGN": "nuban",
      "GH:GHS": "ghipss",
      "ZA:ZAR": "basa",
    };

    const recipientType =
      recipientTypeByMarket[`${normalizedCountryCode}:${normalizedCurrency}`] || null;

    if (!recipientType) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack bank-account fallback Transfer is not configured for this country and currency.",
        code: "PAYSTACK_FALLBACK_TRANSFER_MARKET_UNSUPPORTED",
        statusCode: 409,
        details: {
          countryCode: normalizedCountryCode,
          currency: normalizedCurrency,
        },
      });
    }

    return recipientType;
  }

  static isDefinitivePaystackTransferSubmissionFailure(error) {
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

  static async getActiveVerifiedEmployerRefundBankAccount({
    businessId,
    bankAccountId = null,
    session = null,
  }) {
    const filter = {
      ownerType: "employer",
      employer: businessId,
      isActive: true,
      verificationStatus: "verified",
    };

    if (bankAccountId) {
      filter._id = EmployerRefundBatchService.normalizeObjectId(bankAccountId, "bank account ID");
    }

    let query = BankAccount.findOne(filter).select("+accountNumber").sort({ updatedAt: -1 });

    if (session) {
      query = query.session(session);
    }

    return query;
  }

  static assertUsableRefundBankAccount(bankAccount, businessId) {
    if (
      !bankAccount ||
      bankAccount.ownerType !== "employer" ||
      !EmployerRefundBatchService.sameId(bankAccount.employer, businessId) ||
      bankAccount.isActive !== true ||
      bankAccount.verificationStatus !== "verified"
    ) {
      throw EmployerRefundBatchService.createError({
        message: "An active verified employer bank account is required for refund recovery.",
        code: "VERIFIED_EMPLOYER_REFUND_BANK_ACCOUNT_REQUIRED",
        statusCode: 409,
      });
    }

    const accountNumber = String(bankAccount.accountNumber || "")
      .replace(/\s+/g, "")
      .trim();

    const bankCode = String(bankAccount.paystackBankCode || "").trim();

    if (!accountNumber || !bankCode) {
      throw EmployerRefundBatchService.createError({
        message:
          "The verified employer bank account is missing the Paystack account number or bank code required for refund recovery.",
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
        message: "You do not have permission to manage this employer refund recovery action.",
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

      /*
       * IMPORTANT:
       *
       * A persisted processing line has already crossed Loqum's entitlement
       * point of no return. It must NEVER blindly POST another Paystack
       * refund.
       *
       * The previous provider call may have succeeded even if Loqum timed
       * out before persisting Paystack's response. Therefore every resumed
       * processing line is reconciliation-only.
       */
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

      /*
       * This is a Loqum reconciliation trace key, not a provider-side
       * idempotency guarantee. paystackService places it in merchant_note.
       */
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
    EmployerRefundBatchService.assertPaystackRefundAdapterAvailable();

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
    if (line.fallbackTransfer?.status === "processing") {
      throw EmployerRefundBatchService.createError({
        message:
          "The original Paystack refund moved back to a pending state while a fallback Transfer is already in flight. Manual provider reconciliation is required before either route may complete.",
        code: "PAYSTACK_REFUND_RECOVERED_DURING_FALLBACK_TRANSFER",
        statusCode: 409,
      });
    }

    if (line.retry?.status === "queued") {
      /*
       * The original provider refund recovered before Retry Refund crossed the
       * provider boundary. The unused local retry and consent request can be
       * cleared because no Retry Refund was submitted.
       */
      EmployerRefundBatchService.clearUnsubmittedRetryAudit(line);
    } else if (line.retry?.status === "submitting") {
      /*
       * A pending/processing response proves that Paystack accepted the Retry
       * Refund request. Close the local crossing-boundary state as submitted.
       */
      line.retry.status = "submitted";
      line.retry.submittedAt = currentTime;
      line.retry.failedAt = null;
      line.retry.lastError = null;
    } else if (line.retry?.status === "completed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack moved a refund back to a pending state after Retry Refund was recorded as completed. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_REGRESSED_AFTER_RETRY_COMPLETION",
        statusCode: 409,
      });
    } else if (line.retry?.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack moved a refund back to a pending state after Retry Refund was recorded as failed. Manual reconciliation is required before fallback execution.",
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
        message: "Only a submitted or submitting Retry Refund may be marked failed.",
        code: "PAYSTACK_RETRY_REFUND_FAILURE_STATE_CONFLICT",
        statusCode: 409,
      });
    }

    line.retry.status = "failed";
    line.retry.failedAt = currentTime;
    line.retry.lastError = resolvedFailureReason;

    line.fallbackTransfer.status = "admin_review";
    line.fallbackTransfer.adminReviewStartedAt =
      line.fallbackTransfer.adminReviewStartedAt || currentTime;

    line.status = "awaiting_action";
    line.awaitingActionAt = line.awaitingActionAt || currentTime;
  }

  static applyPaystackNeedsAttentionState({ line, outcome, bankAccount, businessId, currentTime }) {
    if (line.fallbackTransfer?.status === "processing") {
      throw EmployerRefundBatchService.createError({
        message:
          "The original Paystack refund returned to needs_attention while a fallback Transfer is already in flight. Manual provider reconciliation is required before the recovery route can change.",
        code: "PAYSTACK_REFUND_RECOVERED_DURING_FALLBACK_TRANSFER",
        statusCode: 409,
      });
    }

    const providerIdentifier = outcome.reference || outcome.refundId;

    if (!providerIdentifier) {
      throw EmployerRefundBatchService.createError({
        message: "A Paystack refund needing attention requires a provider identifier.",
        code: "PAYSTACK_REFUND_PROVIDER_IDENTIFIER_MISSING",
        statusCode: 409,
      });
    }

    if (line.retry.status === "completed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reported needs_attention after Retry Refund was already completed. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_REGRESSED_AFTER_RETRY_COMPLETION",
        statusCode: 409,
      });
    }

    if (line.retry.status === "submitted") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack returned needs_attention after an accepted Retry Refund. Manual reconciliation is required before any fallback action.",
        code: "PAYSTACK_RETRY_REFUND_REGRESSED_TO_NEEDS_ATTENTION",
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

    line.paystackRefund.rawStatus = outcome.rawStatus || "needs-attention";

    /*
     * If Retry Refund is already crossing the provider boundary, another
     * needs_attention observation does not prove that a second Retry Refund
     * should be submitted. Keep the submitting state and reconcile by refund
     * ID instead.
     */
    if (line.retry.status === "submitting") {
      line.status = "awaiting_action";
      line.awaitingActionAt = line.awaitingActionAt || currentTime;

      return;
    }

    if (line.retry.status === "failed") {
      line.fallbackTransfer.status = "admin_review";
      line.fallbackTransfer.adminReviewStartedAt =
        line.fallbackTransfer.adminReviewStartedAt || currentTime;

      line.status = "awaiting_action";
      line.awaitingActionAt = line.awaitingActionAt || currentTime;

      return;
    }

    if (!bankAccount) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack requires customer bank details to retry this refund, but the employer has no active verified bank account available for consent.",
        code: "EMPLOYER_REFUND_BANK_ACCOUNT_REQUIRED",
        statusCode: 409,
      });
    }

    EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, businessId);

    /*
     * Paystack Retry Refund is the needs-attention continuation of the same
     * provider refund. Submission remains blocked until the employer
     * explicitly confirms use of the verified bank account.
     */
    if (line.retry.status === "not_required") {
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
    }

    if (line.bankConsent.status === "not_required") {
      line.bankConsent.status = "awaiting_consent";
      line.bankConsent.bankAccount = bankAccount._id;
      line.bankConsent.requestedAt = currentTime;
      line.bankConsent.confirmedAt = null;
      line.bankConsent.confirmedBy = null;
      line.bankConsent.withdrawnAt = null;
      line.bankConsent.withdrawnBy = null;
      line.bankConsent.withdrawalReason = null;
    }

    line.status = "awaiting_action";
    line.awaitingActionAt = line.awaitingActionAt || currentTime;
  }

  static applyPaystackFailureState({ line, outcome, currentTime, failureReason = null }) {
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
    } else if (["submitting", "submitted"].includes(line.retry.status)) {
      line.retry.status = "failed";
      line.retry.failedAt = currentTime;
      line.retry.lastError = resolvedFailureReason;
    } else if (line.retry.status === "completed") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack reports a failed refund after Retry Refund was already recorded as completed. Manual reconciliation is required.",
        code: "PAYSTACK_REFUND_FAILURE_AFTER_RETRY_COMPLETION",
        statusCode: 409,
      });
    }

    /*
     * A late duplicate failure event for the original refund must never roll
     * an already-authorized fallback Transfer back to admin_review.
     */
    if (line.fallbackTransfer.status === "processing") {
      line.status = line.fallbackTransfer.submittedAt ? "pending_provider" : "processing";

      return;
    }

    /*
     * A genuinely failed provider refund no longer belongs to Retry Refund.
     * Recovery moves to explicit admin-reviewed fallback Transfer.
     */
    line.fallbackTransfer.status = "admin_review";

    line.fallbackTransfer.adminReviewStartedAt =
      line.fallbackTransfer.adminReviewStartedAt || currentTime;

    line.status = "awaiting_action";
    line.awaitingActionAt = line.awaitingActionAt || currentTime;
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

    if (
      line.bankConsent?.status === "awaiting_consent" &&
      line.fallbackTransfer?.status === "not_required"
    ) {
      line.bankConsent.status = "not_required";
      line.bankConsent.bankAccount = null;
      line.bankConsent.requestedAt = null;
      line.bankConsent.confirmedAt = null;
      line.bankConsent.confirmedBy = null;
      line.bankConsent.withdrawnAt = null;
      line.bankConsent.withdrawnBy = null;
      line.bankConsent.withdrawalReason = null;
    }

    return true;
  }

  static finalizeRetryAuditAfterProviderSuccess(line, currentTime) {
    if (!line?.retry || line.retry.status === "not_required") {
      return;
    }

    if (line.retry.status === "queued") {
      /*
       * The original provider refund recovered before Retry Refund was sent.
       * The queued local retry never crossed the provider boundary.
       */
      EmployerRefundBatchService.clearUnsubmittedRetryAudit(line);
      return;
    }

    if (line.retry.status === "submitting") {
      /*
       * A processed provider state is stronger evidence than a missing Retry
       * Refund HTTP response. It proves the recovery request reached Paystack.
       */
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
          "Paystack reports refund success after the Retry Refund was recorded as failed. Manual reconciliation is required before completing the line.",
        code: "PAYSTACK_REFUND_SUCCESS_AFTER_RETRY_FAILURE",
        statusCode: 409,
      });
    }
  }

  /* ─────────────────────────────── REFUND RECOVERY CONSENT ─────────────────────────────── */

  static async getConfirmedConsentBankAccount({ batch, line, session = null }) {
    if (line.bankConsent?.status !== "confirmed" || !line.bankConsent?.bankAccount) {
      throw EmployerRefundBatchService.createError({
        message: "Confirmed employer bank consent is required for this refund recovery action.",
        code: "EMPLOYER_REFUND_BANK_CONSENT_REQUIRED",
        statusCode: 409,
      });
    }

    const bankAccount = await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount(
      {
        businessId: batch.business,
        bankAccountId: line.bankConsent.bankAccount,
        session,
      }
    );

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
          message: "Bank consent applies only to Paystack-funded employer refund recovery.",
          code: "REFUND_BANK_CONSENT_NOT_APPLICABLE",
          statusCode: 409,
        });
      }

      if (line.bankConsent.status === "confirmed") {
        return {
          batch,
          line,
          confirmed: true,
          idempotent: true,
        };
      }

      if (line.bankConsent.status === "withdrawn") {
        throw EmployerRefundBatchService.createError({
          message:
            "This refund-recovery bank consent was withdrawn. A withdrawn consent cannot be silently reactivated.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_WITHDRAWN",
          statusCode: 409,
        });
      }

      if (
        line.status !== "awaiting_action" ||
        line.bankConsent.status !== "awaiting_consent" ||
        !line.bankConsent.bankAccount
      ) {
        throw EmployerRefundBatchService.createError({
          message: "This refund line is not awaiting employer bank consent.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_NOT_PENDING",
          statusCode: 409,
        });
      }

      const bankAccount =
        await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount({
          businessId: batch.business,
          bankAccountId: line.bankConsent.bankAccount,
          session,
        });

      EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

      line.bankConsent.status = "confirmed";
      line.bankConsent.confirmedAt = normalizedCurrentTime;
      line.bankConsent.confirmedBy = normalizedUserId;
      line.bankConsent.withdrawnAt = null;
      line.bankConsent.withdrawnBy = null;
      line.bankConsent.withdrawalReason = null;

      if (line.fallbackTransfer.status === "awaiting_consent") {
        line.fallbackTransfer.status = "ready";

        line.fallbackTransfer.idempotencyKey =
          line.fallbackTransfer.idempotencyKey ||
          EmployerRefundBatchService.buildFallbackTransferIdempotencyKey(line);
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

  static async withdrawRefundBankConsent(
    { batchId, lineId, userId, reason, currentTime = new Date() },
    options = {}
  ) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const withdrawalReason = EmployerRefundBatchService.shortReason(
      reason || "Employer withdrew consent to use the selected bank account for refund recovery.",
      500
    );

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

      if (line.bankConsent.status === "withdrawn") {
        return {
          batch,
          line,
          withdrawn: true,
          idempotent: true,
        };
      }

      if (!["awaiting_consent", "confirmed"].includes(line.bankConsent.status)) {
        throw EmployerRefundBatchService.createError({
          message: "There is no active refund-recovery bank consent to withdraw.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_NOT_ACTIVE",
          statusCode: 409,
        });
      }

      /*
       * Consent may be withdrawn only before the relevant provider action
       * crosses its external boundary.
       */
      if (
        ["submitting", "submitted", "completed", "failed"].includes(line.retry.status) ||
        ["processing", "completed", "failed"].includes(line.fallbackTransfer.status)
      ) {
        throw EmployerRefundBatchService.createError({
          message:
            "Bank consent can no longer be withdrawn because the corresponding provider recovery action has already started.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_ALREADY_USED",
          statusCode: 409,
        });
      }

      line.bankConsent.status = "withdrawn";
      line.bankConsent.withdrawnAt = normalizedCurrentTime;
      line.bankConsent.withdrawnBy = normalizedUserId;
      line.bankConsent.withdrawalReason = withdrawalReason;

      if (["awaiting_consent", "ready"].includes(line.fallbackTransfer.status)) {
        line.fallbackTransfer.status = "consent_withdrawn";
        line.fallbackTransfer.idempotencyKey = null;
      }

      line.status = "awaiting_action";

      line.awaitingActionAt = line.awaitingActionAt || normalizedCurrentTime;

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        withdrawn: true,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── PAYSTACK RETRY REFUND ─────────────────────────────── */

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
        code: "REFUND_LINE_NOT_PAYSTACK_FUNDED",
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
      line.bankConsent.status !== "confirmed"
    ) {
      throw EmployerRefundBatchService.createError({
        message:
          "Retry Refund requires a needs_attention provider refund, queued retry and confirmed employer bank consent.",
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

    if (line.fallbackTransfer.status !== "not_required") {
      throw EmployerRefundBatchService.createError({
        message: "Retry Refund cannot run after fallback Transfer workflow has started.",
        code: "PAYSTACK_RETRY_REFUND_FALLBACK_CONFLICT",
        statusCode: 409,
      });
    }

    const bankAccount = await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount(
      {
        businessId: batch.business,
        bankAccountId: line.bankConsent.bankAccount,
      }
    );

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
    bankAccountId,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

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
        };
      }

      if (["submitting", "submitted"].includes(line.retry.status)) {
        return {
          batch,
          line,
          authorized: true,
          completed: false,
          requiresReconciliation: true,
        };
      }

      if (
        line.status !== "awaiting_action" ||
        line.paystackRefund.status !== "needs_attention" ||
        line.retry.status !== "queued" ||
        line.bankConsent.status !== "confirmed" ||
        !EmployerRefundBatchService.sameId(line.bankConsent.bankAccount, bankAccountId) ||
        line.fallbackTransfer.status !== "not_required"
      ) {
        throw EmployerRefundBatchService.createError({
          message: "Retry Refund is no longer in an executable state.",
          code: "PAYSTACK_RETRY_REFUND_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      const bankAccount =
        await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount({
          businessId: batch.business,
          bankAccountId,
          session,
        });

      EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

      line.retry.status = "submitting";

      line.retry.attemptCount = Number(line.retry.attemptCount || 0) + 1;

      line.retry.submittingAt = normalizedCurrentTime;
      line.retry.submittedAt = null;
      line.retry.completedAt = null;
      line.retry.failedAt = null;
      line.retry.lastError = null;

      /*
       * awaiting_action remains correct while the outbound request is
       * ambiguous. If the HTTP response is lost, the next attempt must
       * reconcile the existing provider refund by ID rather than POST again.
       */
      line.status = "awaiting_action";

      line.awaitingActionAt = line.awaitingActionAt || normalizedCurrentTime;

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        authorized: true,
        completed: false,
        requiresReconciliation: false,
      };
    });
  }

  static async persistRetrySubmissionFailure({
    batchId,
    lineId,
    reason,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

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

      if (line.retry.status === "failed") {
        return {
          batch,
          line,
          failed: true,
          idempotent: true,
        };
      }

      EmployerRefundBatchService.applyRetryFailureState({
        line,
        currentTime: normalizedCurrentTime,
        failureReason: reason,
      });

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        failed: true,
        idempotent: false,
      };
    });
  }

  static async persistPaystackRetryOutcome({
    batchId,
    lineId,
    outcome,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    if (outcome.status === "processed") {
      return EmployerRefundBatchService.finalizeProcessedPaystackLine({
        batchId,
        lineId,
        outcome,
        providerEventId,
        currentTime: normalizedCurrentTime,
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

      if (["pending", "processing"].includes(outcome.status)) {
        EmployerRefundBatchService.applyPaystackPendingState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else if (outcome.status === "failed") {
        EmployerRefundBatchService.applyPaystackFailureState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
          failureReason: "Paystack refund failed after Retry Refund submission.",
        });
      } else {
        throw EmployerRefundBatchService.createError({
          message: "Retry Refund returned an unsupported provider state.",
          code: "UNSUPPORTED_PAYSTACK_RETRY_REFUND_OUTCOME",
          statusCode: 502,
          details: {
            rawStatus: outcome.rawStatus || null,
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

  static async reconcilePaystackRetryRefund({ batchId, lineId, currentTime = new Date() }) {
    EmployerRefundBatchService.assertPaystackRetryRefundAdapterAvailable();

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
          "Paystack Retry Refund remains ambiguous. No new Retry Refund or fallback Transfer may be submitted.",
        code: "PAYSTACK_RETRY_REFUND_RECONCILIATION_AMBIGUOUS",
        statusCode: 409,
        details: {
          rawStatus: outcome?.rawStatus || null,
        },
      });
    }

    if (outcome.status === "needs_attention") {
      if (line.retry.status === "submitting") {
        /*
         * The provider still exposes the pre-retry state. This does not prove
         * that another POST is safe. Leave submitting intact and reconcile
         * again later.
         */
        return {
          batch,
          line,
          reconciled: false,
          reason: "provider_still_needs_attention",
        };
      }

      return EmployerRefundBatchService.persistRetrySubmissionFailure({
        batchId,
        lineId,
        reason: "Paystack returned needs_attention after Retry Refund had already been accepted.",
        currentTime: normalizedCurrentTime,
      });
    }

    const persisted = await EmployerRefundBatchService.persistPaystackRetryOutcome({
      batchId,
      lineId,
      outcome,
      currentTime: normalizedCurrentTime,
    });

    return {
      ...persisted,
      reconciled: true,
    };
  }

  static async executePaystackRetryRefund({ batchId, lineId, currentTime = new Date() }) {
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
      bankAccountId: preparation.bankAccount._id,
      currentTime: normalizedCurrentTime,
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
      });
    } catch (error) {
      if (EmployerRefundBatchService.isDefinitivePaystackRefundSubmissionFailure(error)) {
        const failed = await EmployerRefundBatchService.persistRetrySubmissionFailure({
          batchId,
          lineId,
          reason: `Paystack Retry Refund was rejected: ${error.message}`,
          currentTime: normalizedCurrentTime,
        });

        return {
          ...failed,
          definitiveProviderFailure: true,
        };
      }

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund submission could not be conclusively confirmed. The next attempt must reconcile the existing refund by ID before any new submission.",
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
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Retry Refund returned an ambiguous response. No additional Retry Refund or fallback Transfer will be submitted until reconciliation succeeds.",
        code: "AMBIGUOUS_PAYSTACK_RETRY_REFUND_RESPONSE",
        statusCode: 502,
        details: {
          rawStatus: outcome?.rawStatus || null,
        },
      });
    }

    if (outcome.status === "needs_attention") {
      return EmployerRefundBatchService.persistRetrySubmissionFailure({
        batchId,
        lineId,
        reason:
          "Paystack Retry Refund returned needs_attention again after customer bank details were submitted.",
        currentTime: normalizedCurrentTime,
      });
    }

    return EmployerRefundBatchService.persistPaystackRetryOutcome({
      batchId,
      lineId,
      outcome,
      currentTime: normalizedCurrentTime,
    });
  }

  /* ─────────────────────────────── FALLBACK REVIEW ─────────────────────────────── */

  static async approveFallbackTransfer(
    { batchId, lineId, adminUserId, notes = null, currentTime = new Date() },
    options = {}
  ) {
    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedAdminUserId = EmployerRefundBatchService.normalizeObjectId(
      adminUserId,
      "admin user ID"
    );

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

      if (line.fundingMethod !== "paystack_checkout" || line.status !== "awaiting_action") {
        throw EmployerRefundBatchService.createError({
          message: "This refund line is not awaiting Paystack fallback review.",
          code: "PAYSTACK_FALLBACK_REVIEW_NOT_AVAILABLE",
          statusCode: 409,
        });
      }

      if (
        ["ready", "awaiting_consent", "consent_withdrawn"].includes(line.fallbackTransfer.status)
      ) {
        return {
          batch,
          line,
          approved: true,
          idempotent: true,
        };
      }

      if (line.fallbackTransfer.status !== "admin_review") {
        throw EmployerRefundBatchService.createError({
          message: "Fallback Transfer is not awaiting admin review.",
          code: "PAYSTACK_FALLBACK_NOT_IN_ADMIN_REVIEW",
          statusCode: 409,
        });
      }

      const refundRouteFailed =
        line.paystackRefund.status === "failed" || line.retry.status === "failed";

      if (!refundRouteFailed) {
        throw EmployerRefundBatchService.createError({
          message: "Fallback Transfer requires a conclusively failed Paystack refund route.",
          code: "PAYSTACK_FALLBACK_REFUND_ROUTE_NOT_FAILED",
          statusCode: 409,
        });
      }

      line.fallbackTransfer.adminApprovedAt = normalizedCurrentTime;

      line.fallbackTransfer.adminApprovedBy = normalizedAdminUserId;

      line.fallbackTransfer.adminNotes = notes
        ? EmployerRefundBatchService.shortReason(notes, 1000)
        : null;

      if (line.bankConsent.status === "confirmed") {
        await EmployerRefundBatchService.getConfirmedConsentBankAccount({
          batch,
          line,
          session,
        });

        line.fallbackTransfer.status = "ready";

        line.fallbackTransfer.idempotencyKey =
          EmployerRefundBatchService.buildFallbackTransferIdempotencyKey(line);
      } else if (line.bankConsent.status === "withdrawn") {
        /*
         * Withdrawal is an explicit user decision. Do not manufacture a new
         * consent request by erasing that audit.
         */
        line.fallbackTransfer.status = "consent_withdrawn";
      } else {
        const bankAccount =
          await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount({
            businessId: batch.business,
            session,
          });

        if (!bankAccount) {
          throw EmployerRefundBatchService.createError({
            message:
              "Fallback Transfer was approved, but the employer has no active verified bank account available for consent.",
            code: "EMPLOYER_REFUND_BANK_ACCOUNT_REQUIRED",
            statusCode: 409,
          });
        }

        EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

        line.bankConsent.status = "awaiting_consent";
        line.bankConsent.bankAccount = bankAccount._id;
        line.bankConsent.requestedAt = normalizedCurrentTime;
        line.bankConsent.confirmedAt = null;
        line.bankConsent.confirmedBy = null;
        line.bankConsent.withdrawnAt = null;
        line.bankConsent.withdrawnBy = null;
        line.bankConsent.withdrawalReason = null;

        line.fallbackTransfer.status = "awaiting_consent";
      }

      line.status = "awaiting_action";

      line.awaitingActionAt = line.awaitingActionAt || normalizedCurrentTime;

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({ session });

      return {
        batch,
        line,
        approved: true,
        idempotent: false,
      };
    });
  }

  /* ─────────────────────────────── FALLBACK TRANSFER EXECUTION ─────────────────────────────── */

  static async getFallbackTransferPreparation({ batchId, lineId }) {
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();
    EmployerRefundBatchService.assertPaystackTransferAdapterAvailable();

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
        message: "Fallback Transfer applies only to a Paystack-funded employer refund line.",
        code: "REFUND_LINE_NOT_PAYSTACK_FUNDED",
        statusCode: 409,
      });
    }

    if (
      line.status === "completed" &&
      line.fallbackTransfer.status === "completed" &&
      line.finalExecutionMethod === "paystack_transfer"
    ) {
      return {
        batch,
        line,
        completed: true,
        requiresReconciliation: false,
        bankAccount: null,
        bankDetails: null,
        recipientType: null,
        transferReference: EmployerRefundBatchService.buildFallbackTransferReference(line),
      };
    }

    if (line.fallbackTransfer.status === "failed") {
      throw EmployerRefundBatchService.createError({
        message:
          "The fallback Transfer has already failed and cannot be automatically submitted again.",
        code: "PAYSTACK_FALLBACK_TRANSFER_ALREADY_FAILED",
        statusCode: 409,
      });
    }

    if (line.fallbackTransfer.status === "processing") {
      if (!line.fallbackTransfer.transaction) {
        throw EmployerRefundBatchService.createError({
          message:
            "Fallback Transfer is processing without its durable Transaction and requires manual reconciliation.",
          code: "PAYSTACK_FALLBACK_TRANSACTION_MISSING",
          statusCode: 409,
        });
      }

      return {
        batch,
        line,
        completed: false,
        requiresReconciliation: true,
        bankAccount: null,
        bankDetails: null,
        recipientType: null,
        transferReference: EmployerRefundBatchService.buildFallbackTransferReference(line),
      };
    }

    if (line.status !== "awaiting_action" || line.fallbackTransfer.status !== "ready") {
      throw EmployerRefundBatchService.createError({
        message: "Fallback Transfer requires an admin-approved ready refund line.",
        code: "PAYSTACK_FALLBACK_TRANSFER_NOT_READY",
        statusCode: 409,
      });
    }

    const refundRouteFailed =
      line.paystackRefund.status === "failed" || line.retry.status === "failed";

    if (!refundRouteFailed) {
      throw EmployerRefundBatchService.createError({
        message:
          "Fallback Transfer requires the original Paystack refund route to be conclusively failed.",
        code: "PAYSTACK_FALLBACK_REFUND_ROUTE_NOT_FAILED",
        statusCode: 409,
      });
    }

    if (["submitting", "submitted"].includes(line.retry.status)) {
      throw EmployerRefundBatchService.createError({
        message: "Fallback Transfer cannot start while Retry Refund remains in flight.",
        code: "PAYSTACK_FALLBACK_RETRY_REFUND_ACTIVE",
        statusCode: 409,
      });
    }

    if (
      !line.fallbackTransfer.adminApprovedAt ||
      !line.fallbackTransfer.adminApprovedBy ||
      !line.fallbackTransfer.idempotencyKey
    ) {
      throw EmployerRefundBatchService.createError({
        message: "Fallback Transfer is missing its admin approval or idempotency audit.",
        code: "PAYSTACK_FALLBACK_APPROVAL_AUDIT_INCOMPLETE",
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

    const recipientType = EmployerRefundBatchService.resolvePaystackTransferRecipientType({
      countryCode: batch.countryCode,
      currency: batch.currency,
    });

    return {
      batch,
      line,
      completed: false,
      requiresReconciliation: false,
      bankAccount,
      bankDetails,
      recipientType,
      transferReference: EmployerRefundBatchService.buildFallbackTransferReference(line),
    };
  }

  static async getOrCreateFallbackTransferRecipient({
    batch,
    line,
    bankAccount,
    bankDetails,
    recipientType,
  }) {
    EmployerRefundBatchService.assertPaystackTransferAdapterAvailable();

    const savedRecipientCode = String(bankAccount?.paystackRecipientCode || "").trim() || null;

    if (savedRecipientCode) {
      return {
        recipientCode: savedRecipientCode,
        created: false,
        reusedSavedRecipient: true,
      };
    }

    const employerProfile = await EmployerRefundBatchService.getEmployerProfile(batch.business);

    const recipientName = String(
      bankAccount?.accountName ||
        employerProfile?.businessName ||
        employerProfile?.name ||
        "Loqum employer refund"
    ).trim();

    const providerResponse = await PaystackService.createTransferRecipient({
      type: recipientType,
      name: recipientName,
      accountNumber: bankDetails.accountNumber,
      bankCode: bankDetails.bankCode,
      currency: batch.currency,
      description: `Loqum employer refund destination for ${batch.referenceCode}`,
      metadata: {
        employerRefundBatchId: String(batch._id),
        employerRefundBatchReference: batch.referenceCode,
        employerRefundBatchLineId: String(line._id),
        employerRefundLineReference: line.lineReference,
        businessId: String(batch.business),
        bankAccountId: String(bankAccount._id),
      },
    });

    const normalizedRecipient =
      EmployerRefundBatchService.normalizeTransferRecipientResponse(providerResponse);

    /*
     * BankAccount already owns this verified destination. Cache the recipient
     * code for later withdrawals/refund fallbacks, but never allow that cache
     * to change which bank account this refund line was consented to use.
     */
    await BankAccount.updateOne(
      {
        _id: bankAccount._id,
        ownerType: "employer",
        employer: batch.business,
        isActive: true,
      },
      {
        $set: {
          paystackRecipientCode: normalizedRecipient.recipientCode,
        },
      }
    );

    return {
      recipientCode: normalizedRecipient.recipientCode,
      created: true,
      reusedSavedRecipient: false,
    };
  }

  static async authorizeFallbackTransfer({
    batchId,
    lineId,
    bankAccountId,
    recipientCode,
    currentTime = new Date(),
  }) {
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedBankAccountId = EmployerRefundBatchService.normalizeObjectId(
      bankAccountId,
      "bank account ID"
    );

    const cleanRecipientCode = String(recipientCode || "").trim();

    if (!cleanRecipientCode) {
      throw EmployerRefundBatchService.createError({
        message: "Paystack Transfer recipient code is required before fallback authorization.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_CODE_REQUIRED",
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

      if (
        line.status === "completed" &&
        line.fallbackTransfer.status === "completed" &&
        line.finalExecutionMethod === "paystack_transfer"
      ) {
        return {
          batch,
          line,
          authorized: false,
          completed: true,
          requiresReconciliation: false,
          transaction: null,
        };
      }

      if (line.fallbackTransfer.status === "processing") {
        return {
          batch,
          line,
          authorized: true,
          completed: false,
          requiresReconciliation: true,
          transaction: null,
        };
      }

      if (
        line.fundingMethod !== "paystack_checkout" ||
        line.status !== "awaiting_action" ||
        line.fallbackTransfer.status !== "ready"
      ) {
        throw EmployerRefundBatchService.createError({
          message: "Fallback Transfer is no longer in an executable ready state.",
          code: "PAYSTACK_FALLBACK_TRANSFER_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      const refundRouteFailed =
        line.paystackRefund.status === "failed" || line.retry.status === "failed";

      if (!refundRouteFailed) {
        throw EmployerRefundBatchService.createError({
          message: "Fallback Transfer requires a conclusively failed Paystack refund route.",
          code: "PAYSTACK_FALLBACK_REFUND_ROUTE_NOT_FAILED",
          statusCode: 409,
        });
      }

      if (["submitting", "submitted"].includes(line.retry.status)) {
        throw EmployerRefundBatchService.createError({
          message: "Fallback Transfer cannot start while Retry Refund remains in flight.",
          code: "PAYSTACK_FALLBACK_RETRY_REFUND_ACTIVE",
          statusCode: 409,
        });
      }

      if (
        line.bankConsent.status !== "confirmed" ||
        !EmployerRefundBatchService.sameId(line.bankConsent.bankAccount, normalizedBankAccountId)
      ) {
        throw EmployerRefundBatchService.createError({
          message:
            "Fallback Transfer requires confirmed consent for the exact bank account being used.",
          code: "EMPLOYER_REFUND_BANK_CONSENT_REQUIRED",
          statusCode: 409,
        });
      }

      const bankAccount =
        await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount({
          businessId: batch.business,
          bankAccountId: normalizedBankAccountId,
          session,
        });

      EmployerRefundBatchService.assertUsableRefundBankAccount(bankAccount, batch.business);

      const transferReference = EmployerRefundBatchService.buildFallbackTransferReference(line);

      const externalDebit = await WalletService.createPendingExternalDebit(
        {
          walletId: batch.escrowWallet,
          amount: line.totalAmount,

          type: "shift_refund",
          purpose: "weekly_employer_refund",
          paymentRail: "paystack_transfer",
          provider: "paystack",

          idempotencyKey:
            line.fallbackTransfer.idempotencyKey ||
            EmployerRefundBatchService.buildFallbackTransferIdempotencyKey(line),

          paystackTransferReference: transferReference,

          bankAccount: bankAccount._id,

          employerRefundBatch: batch._id,
          employerRefundBatchLineId: line._id,

          initiatedBy: {
            role: "system",
            userId: null,
          },

          description: `Employer refund fallback Transfer ${line.lineReference}`,

          metadata: {
            employerRefundBatchReference: batch.referenceCode,
            employerRefundLineReference: line.lineReference,
            originalPaystackReference: line.originalPaystackReference,
            allocationCount: line.allocationCount,
            paystackRecipientCode: cleanRecipientCode,
            fallbackTransferReference: transferReference,
          },

          currentTime: normalizedCurrentTime,
        },
        {
          session,
        }
      );

      const executionTransaction = externalDebit.transaction;

      line.executionTransactions = EmployerRefundBatchService.appendUniqueIds(
        line.executionTransactions,
        [executionTransaction._id]
      );

      line.fallbackTransfer.status = "processing";

      line.fallbackTransfer.idempotencyKey =
        line.fallbackTransfer.idempotencyKey ||
        EmployerRefundBatchService.buildFallbackTransferIdempotencyKey(line);

      line.fallbackTransfer.attemptCount = Number(line.fallbackTransfer.attemptCount || 0) + 1;

      line.fallbackTransfer.lastAttemptAt = normalizedCurrentTime;

      line.fallbackTransfer.transaction = executionTransaction._id;

      line.fallbackTransfer.paystackTransferCode = null;

      line.fallbackTransfer.submittedAt = null;

      line.fallbackTransfer.completedAt = null;

      line.fallbackTransfer.failedAt = null;

      line.fallbackTransfer.failureReason = null;

      line.status = "processing";

      line.attemptCount = Number(line.attemptCount || 0) + 1;

      line.lastAttemptAt = normalizedCurrentTime;

      line.failedAt = null;
      line.failureReason = null;

      /*
       * The occurrence-level refund obligation was originally authorized
       * under paystack_refund. Once fallback starts, completion authority
       * moves to paystack_transfer while the same refund obligation remains
       * processing and reserved.
       */
      for (const allocation of line.allocations) {
        const employerRefund = await EmployerRefund.findById(allocation.employerRefund).session(
          session
        );

        if (!employerRefund) {
          throw EmployerRefundBatchService.createError({
            message:
              "A processing EmployerRefund disappeared before fallback Transfer authorization.",
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

        employerRefund.executionMethod = "paystack_transfer";

        employerRefund.lastEvaluatedAt = normalizedCurrentTime;

        await employerRefund.save({
          session,
        });

        const occurrence = await ShiftOccurrence.findById(employerRefund.occurrence).session(
          session
        );

        if (!occurrence) {
          throw EmployerRefundBatchService.createError({
            message: "The refund occurrence disappeared before fallback Transfer authorization.",
            code: "REFUND_COMPLETION_OCCURRENCE_NOT_FOUND",
            statusCode: 500,
          });
        }

        occurrence.refundStatus = "processing";
        occurrence.refundBatch = batch._id;
        occurrence.refundProcessingStartedAt =
          occurrence.refundProcessingStartedAt ||
          employerRefund.executionStartedAt ||
          normalizedCurrentTime;
        occurrence.refundLastEvaluatedAt = normalizedCurrentTime;

        await occurrence.save({
          session,
        });
      }

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({
        session,
      });

      return {
        batch,
        line,
        authorized: true,
        completed: false,
        requiresReconciliation: false,
        transaction: executionTransaction,
        transferReference,
        recipientCode: cleanRecipientCode,
        idempotent: Boolean(externalDebit.idempotent),
      };
    });
  }

  static async persistFallbackTransferPending({
    batchId,
    lineId,
    outcome,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

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

      if (line.status === "completed" && line.fallbackTransfer.status === "completed") {
        return {
          batch,
          line,
          completed: true,
          idempotent: true,
        };
      }

      if (line.fallbackTransfer.status !== "processing" || !line.fallbackTransfer.transaction) {
        throw EmployerRefundBatchService.createError({
          message:
            "Fallback Transfer provider state cannot be stored without a processing durable Transaction.",
          code: "PAYSTACK_FALLBACK_TRANSFER_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
        outcome,
        line,
        batch,
      });

      await WalletService.markPendingExternalDebitProcessing(
        {
          transactionId: line.fallbackTransfer.transaction,
          currentTime: normalizedCurrentTime,
          metadata: {
            providerEventId: providerEventId || null,
            paystackTransferRawStatus: outcome.rawStatus || null,
          },
        },
        {
          session,
        }
      );

      const transferCode =
        outcome.transferCode || line.fallbackTransfer.paystackTransferCode || null;

      if (!transferCode) {
        /*
         * EmployerRefundBatch requires paystackTransferCode and submittedAt
         * together before a processing fallback may enter pending_provider.
         *
         * Keep the line in processing so the deterministic reference remains
         * reconciliation-only.
         */
        line.status = "processing";

        EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

        await batch.save({
          session,
        });

        return {
          batch,
          line,
          completed: false,
          pendingProvider: false,
          unresolved: true,
          reason: "provider_transfer_code_missing",
        };
      }

      line.fallbackTransfer.paystackTransferCode = transferCode;

      line.fallbackTransfer.submittedAt =
        line.fallbackTransfer.submittedAt || normalizedCurrentTime;

      line.status = "pending_provider";

      line.pendingProviderAt = line.pendingProviderAt || normalizedCurrentTime;

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({
        session,
      });

      return {
        batch,
        line,
        completed: false,
        pendingProvider: true,
        providerStatus: outcome.status,
        requiresOtp: outcome.status === "otp",
        idempotent: false,
      };
    });
  }

  static async finalizeSuccessfulFallbackTransfer({
    batchId,
    lineId,
    outcome,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

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

      if (
        line.status === "completed" &&
        line.fallbackTransfer.status === "completed" &&
        line.finalExecutionMethod === "paystack_transfer"
      ) {
        return {
          batch,
          line,
          completed: true,
          idempotent: true,
        };
      }

      if (line.fallbackTransfer.status !== "processing" || !line.fallbackTransfer.transaction) {
        throw EmployerRefundBatchService.createError({
          message:
            "A successful Paystack fallback Transfer cannot complete without its processing durable Transaction.",
          code: "PAYSTACK_FALLBACK_TRANSFER_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
        outcome,
        line,
        batch,
      });

      const transferCode =
        outcome.transferCode || line.fallbackTransfer.paystackTransferCode || null;

      if (!transferCode) {
        throw EmployerRefundBatchService.createError({
          message: "Successful Paystack fallback Transfer has no provider Transfer code.",
          code: "PAYSTACK_TRANSFER_CODE_MISSING",
          statusCode: 502,
        });
      }

      await WalletService.markPendingExternalDebitProcessing(
        {
          transactionId: line.fallbackTransfer.transaction,
          currentTime: normalizedCurrentTime,
          metadata: {
            paystackTransferRawStatus: outcome.rawStatus || "success",
          },
        },
        {
          session,
        }
      );

      const ledgerResult = await WalletService.completePendingExternalDebit(
        {
          transactionId: line.fallbackTransfer.transaction,
          paystackTransferCode: transferCode,
          providerEventId,
          providerFee: 0,
          netAmount: line.totalAmount,
          currentTime: normalizedCurrentTime,
          metadata: {
            employerRefundBatchReference: batch.referenceCode,
            employerRefundLineReference: line.lineReference,
            originalPaystackReference: line.originalPaystackReference,
            fallbackTransferReference:
              EmployerRefundBatchService.buildFallbackTransferReference(line),
            paystackTransferRawStatus: outcome.rawStatus || "success",
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

      line.finalExecutionMethod = "paystack_transfer";

      line.fallbackTransfer.status = "completed";

      line.fallbackTransfer.paystackTransferCode = transferCode;

      line.fallbackTransfer.submittedAt =
        line.fallbackTransfer.submittedAt || normalizedCurrentTime;

      line.fallbackTransfer.completedAt = normalizedCurrentTime;

      line.fallbackTransfer.failedAt = null;

      line.fallbackTransfer.failureReason = null;

      line.status = "completed";
      line.completedAt = normalizedCurrentTime;
      line.failedAt = null;
      line.failureReason = null;

      await EmployerRefundBatchService.completeRefundObligations({
        batch,
        line,
        executionMethod: "paystack_transfer",
        executionTransactionIds: [executionTransaction._id],
        completedTransactionId: executionTransaction._id,
        currentTime: normalizedCurrentTime,
        session,
      });

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({
        session,
      });

      return {
        batch,
        line,
        completed: true,
        idempotent: Boolean(ledgerResult.idempotent),
      };
    });
  }

  static async failFallbackTransfer({
    batchId,
    lineId,
    outcome = null,
    reason = null,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

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

      if (line.fallbackTransfer.status === "failed") {
        return {
          batch,
          line,
          failed: true,
          idempotent: true,
        };
      }

      if (line.status === "completed" || line.fallbackTransfer.status === "completed") {
        throw EmployerRefundBatchService.createError({
          message: "A completed employer refund fallback Transfer cannot be changed to failed.",
          code: "PAYSTACK_FALLBACK_TRANSFER_ALREADY_COMPLETED",
          statusCode: 409,
        });
      }

      if (line.fallbackTransfer.status !== "processing" || !line.fallbackTransfer.transaction) {
        throw EmployerRefundBatchService.createError({
          message: "Fallback Transfer failure requires a processing durable Transaction.",
          code: "PAYSTACK_FALLBACK_TRANSFER_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      if (outcome) {
        EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
          outcome,
          line,
          batch,
        });
      }

      const resolvedFailureReason = EmployerRefundBatchService.shortReason(
        reason ||
          `Paystack fallback Transfer ended with status ${
            outcome?.rawStatus || outcome?.status || "failed"
          }.`
      );

      const transferCode =
        outcome?.transferCode || line.fallbackTransfer.paystackTransferCode || null;

      const ledgerResult = await WalletService.markPendingExternalDebitFailed(
        {
          transactionId: line.fallbackTransfer.transaction,
          failureReason: resolvedFailureReason,
          paystackTransferCode: transferCode,
          providerEventId,
          currentTime: normalizedCurrentTime,
          metadata: {
            employerRefundBatchReference: batch.referenceCode,
            employerRefundLineReference: line.lineReference,
            originalPaystackReference: line.originalPaystackReference,
            fallbackTransferReference:
              EmployerRefundBatchService.buildFallbackTransferReference(line),
            paystackTransferRawStatus: outcome?.rawStatus || outcome?.status || "failed",
            allocationCount: line.allocationCount,
          },
        },
        {
          session,
        }
      );

      line.executionTransactions = EmployerRefundBatchService.appendUniqueIds(
        line.executionTransactions,
        [ledgerResult.transaction._id]
      );

      line.fallbackTransfer.status = "failed";

      line.fallbackTransfer.paystackTransferCode = transferCode;

      line.fallbackTransfer.submittedAt = transferCode
        ? line.fallbackTransfer.submittedAt || normalizedCurrentTime
        : null;

      line.fallbackTransfer.failedAt = normalizedCurrentTime;

      line.fallbackTransfer.failureReason = resolvedFailureReason;

      line.status = "failed";
      line.failedAt = normalizedCurrentTime;
      line.failureReason = resolvedFailureReason;

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      await batch.save({
        session,
      });

      return {
        batch,
        line,
        failed: true,
        idempotent: Boolean(ledgerResult.idempotent),
      };
    });
  }

  static async reconcileFallbackTransfer({ batchId, lineId, currentTime = new Date() }) {
    EmployerRefundBatchService.assertPaystackTransferAdapterAvailable();
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

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

    if (
      line.status === "completed" &&
      line.fallbackTransfer.status === "completed" &&
      line.finalExecutionMethod === "paystack_transfer"
    ) {
      return {
        batch,
        line,
        completed: true,
        reconciled: true,
        idempotent: true,
      };
    }

    if (line.fallbackTransfer.status !== "processing" || !line.fallbackTransfer.transaction) {
      return {
        batch,
        line,
        reconciled: false,
        reason: "fallback_transfer_not_in_flight",
      };
    }

    const transferReference = EmployerRefundBatchService.buildFallbackTransferReference(line);

    let providerResponse;

    try {
      providerResponse = await PaystackService.verifyTransfer(transferReference);
    } catch (error) {
      /*
       * Verification may temporarily return not-found around provider
       * creation. Once Loqum has entered processing we cannot use not-found as
       * proof that the outbound call never crossed the provider boundary.
       */
      if (Number(error?.providerStatusCode) === 404) {
        throw EmployerRefundBatchService.createError({
          message:
            "The prior fallback Transfer is not yet visible to Paystack verification. Loqum will not submit another Transfer while this attempt remains unresolved.",
          code: "PAYSTACK_FALLBACK_TRANSFER_RECONCILIATION_UNRESOLVED",
          statusCode: 409,
          details: {
            batchId: String(batchId),
            lineId: String(lineId),
            transferReference,
          },
        });
      }

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack fallback Transfer could not be reconciled. No new Transfer was submitted.",
        code: "PAYSTACK_FALLBACK_TRANSFER_RECONCILIATION_FAILED",
        statusCode: 502,
        details: {
          cause: error.message,
          batchId: String(batchId),
          lineId: String(lineId),
          transferReference,
        },
      });
    }

    const outcome = EmployerRefundBatchService.normalizePaystackTransferOutcome(providerResponse);

    if (!outcome || outcome.status === "ambiguous") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack fallback Transfer remains ambiguous. No second Transfer will be submitted.",
        code: "PAYSTACK_FALLBACK_TRANSFER_RECONCILIATION_AMBIGUOUS",
        statusCode: 409,
        details: {
          rawStatus: outcome?.rawStatus || null,
          transferReference,
        },
      });
    }

    EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
      outcome,
      line,
      batch,
    });

    if (outcome.status === "success") {
      const result = await EmployerRefundBatchService.finalizeSuccessfulFallbackTransfer({
        batchId,
        lineId,
        outcome,
        currentTime: normalizedCurrentTime,
      });

      return {
        ...result,
        reconciled: true,
      };
    }

    if (outcome.status === "pending" || outcome.status === "otp") {
      const result = await EmployerRefundBatchService.persistFallbackTransferPending({
        batchId,
        lineId,
        outcome,
        currentTime: normalizedCurrentTime,
      });

      return {
        ...result,
        reconciled: true,
      };
    }

    if (outcome.status === "failed" || outcome.status === "reversed") {
      const result = await EmployerRefundBatchService.failFallbackTransfer({
        batchId,
        lineId,
        outcome,
        reason:
          outcome.status === "reversed"
            ? "Paystack reversed the fallback Transfer before Loqum completed the employer refund."
            : null,
        currentTime: normalizedCurrentTime,
      });

      return {
        ...result,
        reconciled: true,
      };
    }

    throw EmployerRefundBatchService.createError({
      message: "Paystack fallback Transfer returned an unsupported reconciliation state.",
      code: "UNSUPPORTED_PAYSTACK_FALLBACK_TRANSFER_OUTCOME",
      statusCode: 502,
      details: {
        rawStatus: outcome.rawStatus || null,
      },
    });
  }

  static async executeFallbackTransfer({ batchId, lineId, currentTime = new Date() }) {
    EmployerRefundBatchService.assertPaystackTransferAdapterAvailable();
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const preparation = await EmployerRefundBatchService.getFallbackTransferPreparation({
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
      return EmployerRefundBatchService.reconcileFallbackTransfer({
        batchId,
        lineId,
        currentTime: normalizedCurrentTime,
      });
    }

    /*
     * Recipient creation happens before escrow is reserved.
     *
     * Paystack documents duplicate recipient creation as returning the
     * existing recipient, so this preparatory call is safe to repeat while
     * the fallback line is still ready.
     */
    const recipient = await EmployerRefundBatchService.getOrCreateFallbackTransferRecipient({
      batch: preparation.batch,
      line: preparation.line,
      bankAccount: preparation.bankAccount,
      bankDetails: preparation.bankDetails,
      recipientType: preparation.recipientType,
    });

    const authorization = await EmployerRefundBatchService.authorizeFallbackTransfer({
      batchId,
      lineId,
      bankAccountId: preparation.bankAccount._id,
      recipientCode: recipient.recipientCode,
      currentTime: normalizedCurrentTime,
    });

    if (authorization.completed) {
      return authorization;
    }

    if (authorization.requiresReconciliation) {
      return EmployerRefundBatchService.reconcileFallbackTransfer({
        batchId,
        lineId,
        currentTime: normalizedCurrentTime,
      });
    }

    /*
     * This is the provider-boundary marker.
     *
     * From here onward, an exception or timeout must never cause another
     * blind POST /transfer. The deterministic reference is reconciled first.
     */
    await WalletService.markPendingExternalDebitProcessing({
      transactionId: authorization.transaction._id,
      currentTime: normalizedCurrentTime,
      metadata: {
        paystackRecipientCode: recipient.recipientCode,
        fallbackTransferReference: authorization.transferReference,
      },
    });

    let providerResponse;

    try {
      providerResponse = await PaystackService.initiateTransfer({
        source: "balance",
        amount: authorization.line.totalAmount,
        recipient: recipient.recipientCode,
        reference: authorization.transferReference,
        reason: `Loqum employer refund ${authorization.line.lineReference}`,
        currency: authorization.batch.currency,
      });
    } catch (error) {
      if (EmployerRefundBatchService.isDefinitivePaystackTransferSubmissionFailure(error)) {
        const failed = await EmployerRefundBatchService.failFallbackTransfer({
          batchId,
          lineId,
          reason: `Paystack fallback Transfer was rejected: ${error.message}`,
          currentTime: normalizedCurrentTime,
        });

        return {
          ...failed,
          definitiveProviderFailure: true,
        };
      }

      throw EmployerRefundBatchService.createError({
        message:
          "Paystack fallback Transfer submission could not be conclusively confirmed. The protected escrow amount remains reserved, and the next attempt must verify the deterministic Transfer reference before any new submission.",
        code: "PAYSTACK_FALLBACK_TRANSFER_SUBMISSION_UNRESOLVED",
        statusCode: 502,
        details: {
          cause: error.message,
          batchId: String(batchId),
          lineId: String(lineId),
          transferReference: authorization.transferReference,
        },
      });
    }

    const outcome = EmployerRefundBatchService.normalizePaystackTransferOutcome(providerResponse);

    if (!outcome || outcome.status === "ambiguous") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack fallback Transfer returned an ambiguous response. The escrow reservation remains intact until the deterministic Transfer reference is reconciled.",
        code: "AMBIGUOUS_PAYSTACK_FALLBACK_TRANSFER_RESPONSE",
        statusCode: 502,
        details: {
          rawStatus: outcome?.rawStatus || null,
          transferReference: authorization.transferReference,
        },
      });
    }

    EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
      outcome,
      line: authorization.line,
      batch: authorization.batch,
    });

    if (outcome.status === "success") {
      return EmployerRefundBatchService.finalizeSuccessfulFallbackTransfer({
        batchId,
        lineId,
        outcome,
        currentTime: normalizedCurrentTime,
      });
    }

    if (outcome.status === "pending" || outcome.status === "otp") {
      return EmployerRefundBatchService.persistFallbackTransferPending({
        batchId,
        lineId,
        outcome,
        currentTime: normalizedCurrentTime,
      });
    }

    if (outcome.status === "failed" || outcome.status === "reversed") {
      return EmployerRefundBatchService.failFallbackTransfer({
        batchId,
        lineId,
        outcome,
        reason:
          outcome.status === "reversed"
            ? "Paystack reversed the fallback Transfer before Loqum completed the employer refund."
            : null,
        currentTime: normalizedCurrentTime,
      });
    }

    throw EmployerRefundBatchService.createError({
      message: "Paystack fallback Transfer returned an unsupported provider state.",
      code: "UNSUPPORTED_PAYSTACK_FALLBACK_TRANSFER_OUTCOME",
      statusCode: 502,
      details: {
        rawStatus: outcome.rawStatus || null,
      },
    });
  }

  static async submitFallbackTransferOtp({ batchId, lineId, otp, currentTime = new Date() }) {
    EmployerRefundBatchService.assertPaystackTransferOtpAdapterAvailable();
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const normalizedOtp = String(otp || "")
      .replace(/\s+/g, "")
      .trim();

    if (!/^\d{4,10}$/.test(normalizedOtp)) {
      throw EmployerRefundBatchService.createError({
        message: "A valid Paystack Transfer OTP is required.",
        code: "INVALID_PAYSTACK_TRANSFER_OTP",
      });
    }

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

    if (
      line.status === "completed" &&
      line.fallbackTransfer.status === "completed" &&
      line.finalExecutionMethod === "paystack_transfer"
    ) {
      return {
        batch,
        line,
        completed: true,
        idempotent: true,
      };
    }

    if (
      line.fallbackTransfer.status !== "processing" ||
      line.status !== "pending_provider" ||
      !line.fallbackTransfer.transaction ||
      !line.fallbackTransfer.paystackTransferCode ||
      !line.fallbackTransfer.submittedAt
    ) {
      throw EmployerRefundBatchService.createError({
        message: "This fallback Transfer is not awaiting an OTP-protected provider completion.",
        code: "PAYSTACK_FALLBACK_TRANSFER_OTP_NOT_REQUIRED",
        statusCode: 409,
      });
    }

    /*
     * OTP is never stored in Loqum.
     *
     * The fallback Transaction and deterministic Transfer reference already
     * exist, so a lost Finalize Transfer response is reconciled by reference
     * rather than by resubmitting the original Transfer.
     */
    let providerResponse;

    try {
      providerResponse = await PaystackService.finalizeTransfer({
        transferCode: line.fallbackTransfer.paystackTransferCode,
        otp: normalizedOtp,
      });
    } catch (error) {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Transfer OTP completion could not be conclusively confirmed. The escrow reservation remains intact and the Transfer must be reconciled by reference before another recovery action.",
        code: "PAYSTACK_FALLBACK_TRANSFER_OTP_UNRESOLVED",
        statusCode: 502,
        details: {
          cause: error.message,
          batchId: String(batchId),
          lineId: String(lineId),
          transferReference: EmployerRefundBatchService.buildFallbackTransferReference(line),
        },
      });
    }

    const outcome = EmployerRefundBatchService.normalizePaystackTransferOutcome(providerResponse);

    if (!outcome || outcome.status === "ambiguous") {
      throw EmployerRefundBatchService.createError({
        message:
          "Paystack Transfer OTP completion returned an ambiguous response. The escrow reservation remains intact until the Transfer reference is reconciled.",
        code: "AMBIGUOUS_PAYSTACK_FALLBACK_TRANSFER_OTP_RESPONSE",
        statusCode: 502,
        details: {
          rawStatus: outcome?.rawStatus || null,
          transferReference: EmployerRefundBatchService.buildFallbackTransferReference(line),
        },
      });
    }

    EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
      outcome,
      line,
      batch,
    });

    if (outcome.status === "success") {
      return EmployerRefundBatchService.finalizeSuccessfulFallbackTransfer({
        batchId,
        lineId,
        outcome,
        currentTime: normalizedCurrentTime,
      });
    }

    if (outcome.status === "pending" || outcome.status === "otp") {
      return EmployerRefundBatchService.persistFallbackTransferPending({
        batchId,
        lineId,
        outcome,
        currentTime: normalizedCurrentTime,
      });
    }

    if (outcome.status === "failed" || outcome.status === "reversed") {
      return EmployerRefundBatchService.failFallbackTransfer({
        batchId,
        lineId,
        outcome,
        reason:
          outcome.status === "reversed"
            ? "Paystack reversed the fallback Transfer before Loqum completed the employer refund."
            : null,
        currentTime: normalizedCurrentTime,
      });
    }

    throw EmployerRefundBatchService.createError({
      message: "Paystack Transfer OTP completion returned an unsupported provider state.",
      code: "UNSUPPORTED_PAYSTACK_FALLBACK_TRANSFER_OTP_OUTCOME",
      statusCode: 502,
      details: {
        rawStatus: outcome.rawStatus || null,
      },
    });
  }

  static async syncFallbackTransferStatus(
    {
      batchId,
      lineId,
      status,
      reference = null,
      transferCode = null,
      amount = null,
      currency = null,
      providerEventId = null,
      failureReason = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    EmployerRefundBatchService.assertFallbackWalletAdapterAvailable();

    const normalizedCurrentTime = EmployerRefundBatchService.normalizeCurrentTime(currentTime);

    const outcome = EmployerRefundBatchService.normalizePaystackTransferOutcome({
      status,
      reference,
      transferCode,
      amount,
      currency,
    });

    if (!outcome || outcome.status === "ambiguous") {
      throw EmployerRefundBatchService.createError({
        message: "Unsupported Paystack fallback Transfer status.",
        code: "UNSUPPORTED_PAYSTACK_FALLBACK_TRANSFER_STATUS",
        statusCode: 409,
        details: {
          rawStatus: outcome?.rawStatus || String(status || ""),
        },
      });
    }

    /*
     * Read once so a late reversal after local completion is never silently
     * treated as an idempotent success/failure update.
     */
    const currentBatch = await EmployerRefundBatchService.getBatch(batchId, null, {
      includeProcessingToken: true,
    });

    const currentLine = currentBatch.lines.id(lineId);

    if (!currentLine) {
      throw EmployerRefundBatchService.createError({
        message: "Employer refund batch line was not found.",
        code: "EMPLOYER_REFUND_BATCH_LINE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (currentLine.status === "completed" && currentLine.fallbackTransfer.status === "completed") {
      if (outcome.status === "success") {
        return {
          batch: currentBatch,
          line: currentLine,
          completed: true,
          idempotent: true,
        };
      }

      if (outcome.status === "reversed") {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reversed a fallback Transfer after Loqum had already completed the employer refund. Manual financial reconciliation is required.",
          code: "PAYSTACK_FALLBACK_REVERSED_AFTER_COMPLETION",
          statusCode: 409,
          details: {
            batchId: String(batchId),
            lineId: String(lineId),
          },
        });
      }

      return {
        batch: currentBatch,
        line: currentLine,
        completed: true,
        idempotent: true,
      };
    }

    EmployerRefundBatchService.assertPaystackTransferOutcomeMatches({
      outcome,
      line: currentLine,
      batch: currentBatch,
    });

    if (outcome.status === "success") {
      return EmployerRefundBatchService.finalizeSuccessfulFallbackTransfer({
        batchId,
        lineId,
        outcome,
        providerEventId,
        currentTime: normalizedCurrentTime,
      });
    }

    if (outcome.status === "pending" || outcome.status === "otp") {
      return EmployerRefundBatchService.persistFallbackTransferPending({
        batchId,
        lineId,
        outcome,
        providerEventId,
        currentTime: normalizedCurrentTime,
      });
    }

    return EmployerRefundBatchService.failFallbackTransfer({
      batchId,
      lineId,
      outcome,
      reason:
        failureReason ||
        (outcome.status === "reversed"
          ? "Paystack reversed the fallback Transfer before Loqum completed the employer refund."
          : null),
      providerEventId,
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
        return {
          batch,
          line,
          completed: true,
          idempotent: true,
        };
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

      const providerIdentifier = outcome.reference || outcome.refundId;

      if (!providerIdentifier) {
        throw EmployerRefundBatchService.createError({
          message: "Processed Paystack refund has no provider identifier.",
          code: "PAYSTACK_REFUND_PROVIDER_IDENTIFIER_MISSING",
          statusCode: 500,
        });
      }

      if (line.fallbackTransfer.status === "completed") {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports the refund as processed after a fallback transfer already completed. Manual reconciliation is required before any ledger change.",
          code: "PAYSTACK_REFUND_AFTER_FALLBACK_COMPLETION",
          statusCode: 409,
        });
      }

      if (line.fallbackTransfer.status === "processing") {
        throw EmployerRefundBatchService.createError({
          message:
            "Paystack reports the original refund as processed while a fallback Transfer is already in flight. Loqum will not debit escrow for either route until the provider conflict is manually reconciled.",
          code: "PAYSTACK_REFUND_PROCESSED_DURING_FALLBACK_TRANSFER",
          statusCode: 409,
        });
      }

      EmployerRefundBatchService.finalizeRetryAuditAfterProviderSuccess(
        line,
        normalizedCurrentTime
      );

      if (line.fallbackTransfer.status !== "not_required") {
        line.fallbackTransfer.status = "not_required";
        line.fallbackTransfer.adminReviewStartedAt = null;
        line.fallbackTransfer.adminApprovedAt = null;
        line.fallbackTransfer.adminApprovedBy = null;
        line.fallbackTransfer.adminNotes = null;
        line.fallbackTransfer.idempotencyKey = null;
        line.fallbackTransfer.attemptCount = 0;
        line.fallbackTransfer.lastAttemptAt = null;
        line.fallbackTransfer.transaction = null;
        line.fallbackTransfer.paystackTransferCode = null;
        line.fallbackTransfer.submittedAt = null;
        line.fallbackTransfer.completedAt = null;
        line.fallbackTransfer.failedAt = null;
        line.fallbackTransfer.failureReason = null;
      }

      line.paystackRefund.idempotencyKey =
        line.paystackRefund.idempotencyKey ||
        EmployerRefundBatchService.buildPaystackRefundIdempotencyKey(line);

      line.paystackRefund.refundId = outcome.refundId || line.paystackRefund.refundId || null;

      line.paystackRefund.reference = outcome.reference || line.paystackRefund.reference || null;

      line.paystackRefund.status = "processed";

      line.paystackRefund.submittedAt =
        line.paystackRefund.submittedAt || line.processingStartedAt || normalizedCurrentTime;

      line.paystackRefund.processedAt = normalizedCurrentTime;
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
            paystackRefundId: outcome.refundId,
            paystackRefundReference: outcome.reference,
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

      if (outcome.status === "pending" || outcome.status === "processing") {
        EmployerRefundBatchService.applyPaystackPendingState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else if (outcome.status === "needs_attention") {
        const bankAccount =
          await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount({
            businessId: batch.business,
            session,
          });

        EmployerRefundBatchService.applyPaystackNeedsAttentionState({
          line,
          outcome,
          bankAccount,
          businessId: batch.business,
          currentTime: normalizedCurrentTime,
        });
      } else if (outcome.status === "failed") {
        EmployerRefundBatchService.applyPaystackFailureState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
          failureReason,
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

    const outcome = {
      status: normalizedStatus,
      rawStatus: String(status || "")
        .trim()
        .toLowerCase(),
      refundId: refundId ? String(refundId) : null,
      reference: reference ? String(reference) : null,
    };

    if (normalizedStatus === "processed") {
      return EmployerRefundBatchService.finalizeProcessedPaystackLine({
        batchId,
        lineId,
        outcome,
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

      if (line.status === "completed") {
        return {
          batch,
          line,
          idempotent: true,
        };
      }

      if (providerEventId && line.paystackRefund.lastProviderEventId === providerEventId) {
        return {
          batch,
          line,
          idempotent: true,
        };
      }

      if (normalizedStatus === "pending" || normalizedStatus === "processing") {
        const providerIdentifier = outcome.reference || outcome.refundId;

        if (!providerIdentifier) {
          throw EmployerRefundBatchService.createError({
            message: "A pending Paystack refund status requires a provider identifier.",
            code: "PAYSTACK_REFUND_PROVIDER_IDENTIFIER_MISSING",
            statusCode: 409,
          });
        }

        EmployerRefundBatchService.applyPaystackPendingState({
          line,
          outcome,
          currentTime: normalizedCurrentTime,
        });
      } else if (normalizedStatus === "needs_attention") {
        const bankAccount =
          await EmployerRefundBatchService.getActiveVerifiedEmployerRefundBankAccount({
            businessId: batch.business,
            session,
          });

        EmployerRefundBatchService.applyPaystackNeedsAttentionState({
          line,
          outcome,
          bankAccount,
          businessId: batch.business,
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

      EmployerRefundBatchService.applyDerivedBatchState(batch, normalizedCurrentTime);

      if (batch.status === "processing" && ACTIVE_PROVIDER_LINE_STATUSES.includes(line.status)) {
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

      const providerOrActionBlocker = currentBatch.lines.find((line) =>
        ACTIVE_PROVIDER_LINE_STATUSES.includes(line.status)
      );

      if (providerOrActionBlocker) {
        await EmployerRefundBatchService.expireProcessingLock({
          batchId,
          processingToken,
          currentTime: normalizedCurrentTime,
        });

        return {
          batch: currentBatch,
          processed: false,
          reason: providerOrActionBlocker.status,
          blockingLineId: String(providerOrActionBlocker._id),
        };
      }

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
        } else if (currentLine.fallbackTransfer?.status === "processing") {
          /*
           * A processing fallback Transfer has already crossed Loqum's
           * fallback authorization boundary and reserved escrow.
           *
           * It must be reconciled by its deterministic Paystack Transfer
           * reference. Never route it back through executePaystackLine(),
           * because that would reconcile the original Paystack Refund instead
           * of the active fallback Transfer.
           */
          result = await EmployerRefundBatchService.reconcileFallbackTransfer({
            batchId,
            lineId,
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

        if (ACTIVE_PROVIDER_LINE_STATUSES.includes(result.line?.status)) {
          break;
        }
      }

      const finalBatch = await EmployerRefundBatchService.getBatch(batchId, null, {
        includeProcessingToken: true,
      });

      if (finalBatch.status === "processing") {
        const stillBlocked = finalBatch.lines.some((line) =>
          ACTIVE_PROVIDER_LINE_STATUSES.includes(line.status)
        );

        if (stillBlocked) {
          await EmployerRefundBatchService.expireProcessingLock({
            batchId,
            processingToken,
            currentTime: normalizedCurrentTime,
          });
        }
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
