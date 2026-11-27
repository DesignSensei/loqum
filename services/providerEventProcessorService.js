// services/providerEventProcessorService.js

const mongoose = require("mongoose");

const Transaction = require("../models/Transaction");
const DVA = require("../models/DVA");
const Wallet = require("../models/Wallet");
const EmployerRefundBatch = require("../models/EmployerRefundBatch");

const DVAService = require("./dvaService");
const PaystackService = require("./paystackService");
const PaystackEventNormalizerService = require("./paystackEventNormalizerService");
const ProviderEventService = require("./providerEventService");
const ShiftFundingService = require("./shiftFundingService");
const WalletFundingService = require("./walletFundingService");
const WalletWithdrawalService = require("./walletWithdrawalService");
const FinancialObligationService = require("./financialObligationService");
const EmployerRefundBatchService = require("./employerRefundBatchService");
const JobPublicationPaymentService = require("./jobPublicationPaymentService");
const SubscriptionPaymentService = require("./subscriptionPaymentService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const money = require("../utils/money");

const PROVIDER_EVENT_RETRY_DELAY_MS = 5 * 60 * 1000;

const SHIFT_FUNDING_RECOVERY_ERROR_CODES = Object.freeze([
  "PAYSTACK_SHIFT_RECONCILIATION_REQUIRED",
  "SHIFT_FUNDING_APPLICATION_PENDING",
  "PAYSTACK_SHIFT_FUNDING_APPLICATION_PENDING",
  "PAYSTACK_FUNDING_APPLICATION_PENDING",
]);

const PAYSTACK_REFUND_EVENT_STATUS_MAP = Object.freeze({
  "refund.pending": "pending",
  "refund.processing": "processing",
  "refund.needs-attention": "needs_attention",
  "refund.failed": "failed",
  "refund.processed": "processed",
});

const NON_RETRYABLE_SUBSCRIPTION_APPLICATION_CODES = Object.freeze([
  "SUBSCRIPTION_PLAN_CHANGE_APPLICATION_PERIOD_ENDED",
  "SUBSCRIPTION_PLAN_CHANGE_APPLICATION_NOT_ALLOWED",
  "SUBSCRIPTION_PLAN_CHANGE_NOT_PREPARED",
  "PAID_RENEWAL_COMPLETED_AFTER_PERIOD_END",
  "PAID_RENEWAL_BLOCKED_BY_CANCELLATION",
  "SUBSCRIPTION_RENEWAL_NOT_ALLOWED",
  "SUBSCRIPTION_RENEWAL_PERIOD_ALREADY_ELAPSED",
  "SUBSCRIPTION_PAYMENT_RENEWAL_TARGET_MISMATCH",
]);

/**
 * Dispatches verified provider events to their authoritative services.
 *
 * Owns processing claims, historical routing and retry classification.
 * Financial execution remains with the delegated services.
 *
 * Events are marked processed only after a durable financial outcome.
 * Unresolved payment and application obligations remain recoverable.
 */
class ProviderEventProcessorService {
  static eventCategories = {
    dvaAssignment: ["dva_assignment"],

    employerWalletFunding: ["employer_wallet_funding"],

    shiftCheckoutPayment: ["shift_checkout_payment"],

    jobPublicationPayment: ["job_publication_purchase"],

    subscriptionPayment: ["subscription_payment"],

    employerRefund: ["employer_refund"],

    withdrawalPayout: ["employer_withdrawal_payout", "professional_withdrawal_payout"],

    withdrawalReversal: ["employer_withdrawal_reversal", "professional_withdrawal_reversal"],
  };

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  static normalizeCurrentTime(value) {
    const currentTime =
      value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(currentTime.getTime())) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider event processing time is invalid.",
        code: "INVALID_PROVIDER_EVENT_PROCESSING_TIME",
        statusCode: 500,
        retryable: false,
      });
    }

    return currentTime;
  }

  static normalizeFieldCode(value) {
    return String(value || "value")
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  static normalizeOptionalMinorUnitAmount(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    try {
      return money.normalizeMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw ProviderEventProcessorService.createProcessingError({
        message: `${fieldName} must be a non-negative whole number in minor units.`,
        code: `INVALID_PROVIDER_EVENT_${ProviderEventProcessorService.normalizeFieldCode(
          fieldName
        )}`,
        statusCode: 422,
        retryable: false,
        details: {
          value,
        },
      });
    }
  }

  static normalizeRequiredPositiveMinorUnitAmount(value, fieldName) {
    const amount = ProviderEventProcessorService.normalizeOptionalMinorUnitAmount(value, fieldName);

    if (amount === null || amount <= 0) {
      throw ProviderEventProcessorService.createProcessingError({
        message: `${fieldName} must be a positive whole number in minor units.`,
        code: `INVALID_PROVIDER_EVENT_${ProviderEventProcessorService.normalizeFieldCode(
          fieldName
        )}`,
        statusCode: 422,
        retryable: false,
      });
    }

    return amount;
  }

  static getProviderEventAmount(providerEvent, fieldName = "amount") {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const rawAmount =
      payload.amount !== null && payload.amount !== undefined && payload.amount !== ""
        ? payload.amount
        : providerEvent.amount;

    return ProviderEventProcessorService.normalizeOptionalMinorUnitAmount(rawAmount, fieldName);
  }

  static getOperationCurrentTime(options = {}) {
    return ProviderEventProcessorService.normalizeCurrentTime(options.currentTime || new Date());
  }

  /* ─────────────────────────────── EVENT CATEGORY ─────────────────────────────── */

  static isCategory(providerEvent, allowedCategories = []) {
    return allowedCategories.includes(providerEvent.eventCategory);
  }

  /* ─────────────────────────────── PAYLOAD ACCESS ─────────────────────────────── */

  static getNormalizedPayload(providerEvent) {
    return providerEvent.normalizedPayload || {};
  }

  static getPayloadValue(providerEvent, key, fallbackKey = null) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    if (payload[key] !== null && payload[key] !== undefined && payload[key] !== "") {
      return payload[key];
    }

    if (
      fallbackKey &&
      providerEvent[fallbackKey] !== null &&
      providerEvent[fallbackKey] !== undefined &&
      providerEvent[fallbackKey] !== ""
    ) {
      return providerEvent[fallbackKey];
    }

    return null;
  }

  static getRecordId(value) {
    if (!value) {
      return null;
    }

    const candidates = [
      value?._id,
      value?.id,
      value?.walletId,
      value?.transactionId,
      value?.shiftId,
      value,
    ];

    for (const candidate of candidates) {
      if (candidate && mongoose.Types.ObjectId.isValid(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  static getNestedValue(source = {}, path = "") {
    if (!source || !path) {
      return null;
    }

    return path.split(".").reduce((currentValue, key) => {
      if (
        currentValue === null ||
        currentValue === undefined ||
        currentValue[key] === null ||
        currentValue[key] === undefined ||
        currentValue[key] === ""
      ) {
        return null;
      }

      return currentValue[key];
    }, source);
  }

  static getNestedPayloadValue(providerEvent, paths = []) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    for (const path of paths) {
      const value = ProviderEventProcessorService.getNestedValue(payload, path);

      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }

    return null;
  }

  /* ─────────────────────────────── PROCESSING CLAIM ─────────────────────────────── */

  static isProcessingClaimError(error) {
    const code = ProviderEventProcessorService.cleanString(error?.code);

    return Boolean(
      code &&
      (code.startsWith("PROVIDER_EVENT_PROCESSING_CLAIM_") ||
        code === "INVALID_PROVIDER_EVENT_PROCESSING_CLAIM")
    );
  }

  static async getProcessingClaimLostResult(providerEventRecordId, error, options = {}) {
    const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
      session: options.session,
    });

    return {
      providerEvent,
      skipped: true,
      processingClaimed: false,
      processingClaimLost: true,
      errorCode: error?.code || "PROVIDER_EVENT_PROCESSING_CLAIM_LOST",
      errorMessage: error?.message || "Provider event processing ownership is no longer active.",
    };
  }

  /* ─────────────────────────────── WITHDRAWAL IDENTIFIERS ─────────────────────────────── */

  static getWithdrawalTransactionId(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "withdrawalTransactionId",
        "transaction"
      ) ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "transactionId", "transaction")
    );
  }

  static getPaystackTransferCode(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackTransferCode") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "transferCode") ||
      ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
        "metadata.transferCode",
        "metadata.transfer_code",
      ])
    );
  }

  static getPaystackTransferReference(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackTransferReference") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "transferReference") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "providerReference") ||
      ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
        "metadata.paystackTransferReference",
        "metadata.transferReference",
        "metadata.reference",
        "metadata.metadata.paystackTransferReference",
        "metadata.metadata.transferReference",
      ]) ||
      providerEvent.providerReference
    );
  }

  /* ─────────────────────────────── CHECKOUT PAYMENT IDENTIFIER ─────────────────────────────── */

  static getCheckoutPaymentReference(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackReference") ||
        ProviderEventProcessorService.getPayloadValue(providerEvent, "providerReference") ||
        ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
          "metadata.reference",
          "metadata.paystackReference",
          "metadata.metadata.reference",
          "metadata.metadata.paystackReference",
        ]) ||
        providerEvent.providerReference
    );
  }

  /* ─────────────────────────────── SHIFT FUNDING IDENTIFIER ─────────────────────────────── */

  static getShiftFundingReference(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackReference") ||
        ProviderEventProcessorService.getPayloadValue(providerEvent, "providerReference") ||
        ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
          "metadata.reference",
          "metadata.paystackReference",
          "metadata.metadata.reference",
          "metadata.metadata.paystackReference",
        ]) ||
        providerEvent.providerReference
    );
  }

  /* ─────────────────────────────── PROCESSING ERRORS ─────────────────────────────── */

  static createProcessingError({
    message,
    code,
    statusCode = 500,
    retryable = null,
    details = null,
    cause = null,
  }) {
    return createServiceError({
      name: "ProviderEventProcessingError",
      message,
      code,
      statusCode,
      retryable,
      details,
      cause,
    });
  }

  static hasShiftFundingRecoveryMarker(error) {
    const details = error?.details || {};

    const nestedMetadata = details?.transaction?.metadata || details?.metadata || {};

    return Boolean(
      details.fundingApplicationPending === true ||
      details.reconciliationRequired === true ||
      nestedMetadata.fundingApplicationPending === true ||
      nestedMetadata.reconciliationRequired === true ||
      error?.cause?.details?.fundingApplicationPending === true ||
      error?.cause?.details?.reconciliationRequired === true
    );
  }

  static isShiftFundingRecoveryError(error) {
    const code = ProviderEventProcessorService.cleanString(error?.code);

    if (code && SHIFT_FUNDING_RECOVERY_ERROR_CODES.includes(code)) {
      return true;
    }

    if (
      code &&
      /FUNDING/.test(code) &&
      /(APPLICATION|RECONCILIATION)/.test(code) &&
      /(PENDING|REQUIRED)/.test(code)
    ) {
      return true;
    }

    return ProviderEventProcessorService.hasShiftFundingRecoveryMarker(error);
  }

  static isRetryableProcessingError(error) {
    if (typeof error?.retryable === "boolean") {
      return error.retryable;
    }

    if (error?.code === "SUBSCRIPTION_PAYMENT_PAYSTACK_NOT_SUCCESSFUL") {
      return true;
    }

    if (ProviderEventProcessorService.isShiftFundingRecoveryError(error)) {
      return true;
    }

    const statusCode = Number(error?.statusCode);

    if (!Number.isInteger(statusCode)) {
      return true;
    }

    return statusCode >= 500 || [408, 425, 429].includes(statusCode);
  }

  /* ─────────────────────────────── REFUND STATUS ─────────────────────────────── */

  static normalizePaystackRefundStatus(value) {
    const cleanValue = ProviderEventProcessorService.cleanString(value);

    return cleanValue ? cleanValue.toLowerCase().replace(/-/g, "_") : null;
  }

  static getPaystackRefundStatus(providerEvent) {
    const eventName = ProviderEventProcessorService.cleanString(
      providerEvent?.eventName
    )?.toLowerCase();

    const expectedStatus = PAYSTACK_REFUND_EVENT_STATUS_MAP[eventName] || null;

    if (!expectedStatus) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Unsupported Paystack refund lifecycle event.",
        code: "UNSUPPORTED_PAYSTACK_REFUND_EVENT",
        statusCode: 422,
        retryable: false,
      });
    }

    const rawStatus =
      ProviderEventProcessorService.getPayloadValue(providerEvent, "refundStatus") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackRefundStatus") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackStatus");

    const payloadStatus = ProviderEventProcessorService.normalizePaystackRefundStatus(rawStatus);

    if (payloadStatus && payloadStatus !== expectedStatus) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund webhook status does not match the refund lifecycle event name.",
        code: "PAYSTACK_REFUND_EVENT_STATUS_MISMATCH",
        statusCode: 422,
        retryable: false,
        details: {
          eventName,
          expectedStatus,
          payloadStatus,
        },
      });
    }

    return {
      status: expectedStatus,
      rawStatus: ProviderEventProcessorService.cleanString(rawStatus) || expectedStatus,
    };
  }

  /* ─────────────────────────────── REFUND IDENTIFIERS ─────────────────────────────── */

  static getProviderRefundId(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "providerRefundId",
        "providerRefundId"
      ) ||
        ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackRefundId") ||
        providerEvent.providerRefundId
    );
  }

  static getProviderRefundReference(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "providerRefundReference",
        "providerRefundReference"
      ) ||
        ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackRefundReference") ||
        providerEvent.providerRefundReference
    );
  }

  static getRefundOriginalTransactionReference(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "originalTransactionReference"
      ) ||
        ProviderEventProcessorService.getPayloadValue(
          providerEvent,
          "paystackTransactionReference"
        ) ||
        providerEvent.providerReference
    );
  }

  static getRefundTraceKey(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(providerEvent, "refundTraceKey") ||
        ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
          "metadata.refundTraceKey",
          "metadata.metadata.refundTraceKey",
        ])
    );
  }

  static getRefundFailureReason(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(providerEvent, "refundReason") ||
        ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
          "metadata.refundReason",
          "metadata.reason",
          "metadata.gatewayResponse",
        ])
    );
  }

  static getProviderEventMarker(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      providerEvent.providerEventId || providerEvent.eventKey || providerEvent._id
    );
  }

  /* ─────────────────────────────── REFUND EXECUTION LOOKUP ─────────────────────────────── */

  static async getEmployerRefundExecutionByIds({ batchId, lineId }, options = {}) {
    if (!batchId || !lineId) {
      return null;
    }

    const query = EmployerRefundBatch.findById(batchId);

    if (options.session) {
      query.session(options.session);
    }

    const batch = await query;

    if (!batch) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Linked employer refund batch was not found.",
        code: "LINKED_EMPLOYER_REFUND_BATCH_NOT_FOUND",
        statusCode: 409,
        retryable: false,
      });
    }

    const line = batch.lines.id(lineId);

    if (!line) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Linked employer refund batch line was not found.",
        code: "LINKED_EMPLOYER_REFUND_LINE_NOT_FOUND",
        statusCode: 409,
        retryable: false,
      });
    }

    return {
      batch,
      line,
      resolutionSource: "provider_event_link",
    };
  }

  static async findUniqueEmployerRefundExecution({
    batchFilter,
    lineMatches,
    resolutionSource,
    options = {},
  }) {
    const query = EmployerRefundBatch.find(batchFilter).sort({
      createdAt: -1,
      _id: -1,
    });

    if (options.session) {
      query.session(options.session);
    }

    const batches = await query;

    const matches = [];

    for (const batch of batches) {
      for (const line of batch.lines || []) {
        if (line.fundingMethod !== "paystack_checkout") {
          continue;
        }

        if (
          lineMatches({
            batch,
            line,
          })
        ) {
          matches.push({
            batch,
            line,
            resolutionSource,
          });
        }
      }
    }

    if (matches.length > 1) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund event matches more than one employer refund execution line.",
        code: "AMBIGUOUS_EMPLOYER_REFUND_EXECUTION",
        statusCode: 409,
        retryable: false,
        details: {
          matches: matches.map((match) => ({
            batchId: String(match.batch._id),
            lineId: String(match.line._id),
          })),
        },
      });
    }

    return matches[0] || null;
  }

  static async resolveEmployerRefundExecution(providerEvent, options = {}) {
    const linkedBatchId = ProviderEventProcessorService.getRecordId(
      providerEvent.employerRefundBatch
    );

    const linkedLineId = ProviderEventProcessorService.getRecordId(
      providerEvent.employerRefundBatchLineId
    );

    if (linkedBatchId || linkedLineId) {
      if (!linkedBatchId || !linkedLineId) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Provider refund event contains an incomplete employer refund execution link.",
          code: "INCOMPLETE_PROVIDER_REFUND_EXECUTION_LINK",
          statusCode: 409,
          retryable: false,
        });
      }

      return ProviderEventProcessorService.getEmployerRefundExecutionByIds(
        {
          batchId: linkedBatchId,
          lineId: linkedLineId,
        },
        options
      );
    }

    const providerRefundId = ProviderEventProcessorService.getProviderRefundId(providerEvent);

    const providerRefundReference =
      ProviderEventProcessorService.getProviderRefundReference(providerEvent);

    const refundTraceKey = ProviderEventProcessorService.getRefundTraceKey(providerEvent);

    const originalTransactionReference =
      ProviderEventProcessorService.getRefundOriginalTransactionReference(providerEvent);

    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const amount = ProviderEventProcessorService.getProviderEventAmount(
      providerEvent,
      "refund amount"
    );

    const currency = ProviderEventProcessorService.cleanString(
      payload.currency || providerEvent.currency
    );

    const businessId = ProviderEventProcessorService.getRecordId(providerEvent.employer);

    const withScope = (filter) => ({
      ...filter,

      ...(businessId
        ? {
            business: businessId,
          }
        : {}),

      ...(currency
        ? {
            currency: currency.toUpperCase(),
          }
        : {}),
    });

    if (providerRefundId) {
      const byRefundId = await ProviderEventProcessorService.findUniqueEmployerRefundExecution({
        batchFilter: withScope({
          "lines.paystackRefund.refundId": providerRefundId,
        }),
        lineMatches: ({ line }) =>
          ProviderEventProcessorService.cleanString(line.paystackRefund?.refundId) ===
          providerRefundId,
        resolutionSource: "provider_refund_id",
        options,
      });

      if (byRefundId) {
        return byRefundId;
      }
    }

    if (providerRefundReference) {
      const byRefundReference =
        await ProviderEventProcessorService.findUniqueEmployerRefundExecution({
          batchFilter: withScope({
            "lines.paystackRefund.reference": providerRefundReference,
          }),
          lineMatches: ({ line }) =>
            ProviderEventProcessorService.cleanString(line.paystackRefund?.reference) ===
            providerRefundReference,
          resolutionSource: "provider_refund_reference",
          options,
        });

      if (byRefundReference) {
        return byRefundReference;
      }
    }

    if (refundTraceKey) {
      const byTraceKey = await ProviderEventProcessorService.findUniqueEmployerRefundExecution({
        batchFilter: withScope({
          $or: [
            {
              "lines.paystackRefund.idempotencyKey": refundTraceKey,
            },
            {
              "lines.idempotencyKey": refundTraceKey,
            },
          ],
        }),
        lineMatches: ({ line }) =>
          ProviderEventProcessorService.cleanString(line.paystackRefund?.idempotencyKey) ===
            refundTraceKey ||
          ProviderEventProcessorService.cleanString(line.idempotencyKey) === refundTraceKey,
        resolutionSource: "refund_trace_key",
        options,
      });

      if (byTraceKey) {
        return byTraceKey;
      }
    }

    if (originalTransactionReference) {
      const byOriginalReference =
        await ProviderEventProcessorService.findUniqueEmployerRefundExecution({
          batchFilter: withScope({
            "lines.originalPaystackReference": originalTransactionReference,
          }),
          lineMatches: ({ line }) => {
            if (
              ProviderEventProcessorService.cleanString(line.originalPaystackReference) !==
              originalTransactionReference
            ) {
              return false;
            }

            if (line.status === "cancelled") {
              return false;
            }

            if (amount !== null && Number(line.totalAmount) !== amount) {
              return false;
            }

            return true;
          },
          resolutionSource: "original_transaction_reference",
          options,
        });

      if (byOriginalReference) {
        return byOriginalReference;
      }
    }

    throw ProviderEventProcessorService.createProcessingError({
      message: "Employer refund execution line was not found for Paystack refund event.",
      code: "EMPLOYER_REFUND_EXECUTION_NOT_FOUND",
      statusCode: 404,
      retryable: true,
    });
  }

  /* ─────────────────────────────── REFUND EXECUTION VALIDATION ─────────────────────────────── */

  static assertEmployerRefundEventMatchesExecution({ providerEvent, batch, line }) {
    if (
      line.fundingMethod !== "paystack_checkout" ||
      line.initialExecutionMethod !== "paystack_refund"
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund webhook can only be linked to a Paystack Checkout refund line.",
        code: "PAYSTACK_REFUND_EXECUTION_METHOD_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const amount = ProviderEventProcessorService.getProviderEventAmount(
      providerEvent,
      "refund amount"
    );

    if (amount !== null && amount !== Number(line.totalAmount)) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund amount does not match the resolved refund line.",
        code: "PAYSTACK_REFUND_AMOUNT_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const currency = ProviderEventProcessorService.cleanString(
      payload.currency || providerEvent.currency
    );

    if (currency && currency.toUpperCase() !== String(batch.currency).toUpperCase()) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund currency does not match the resolved refund batch.",
        code: "PAYSTACK_REFUND_CURRENCY_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const providerRefundId = ProviderEventProcessorService.getProviderRefundId(providerEvent);

    const lineRefundId = ProviderEventProcessorService.cleanString(line.paystackRefund?.refundId);

    if (providerRefundId && lineRefundId && providerRefundId !== lineRefundId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund ID conflicts with the resolved refund line.",
        code: "PAYSTACK_REFUND_ID_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const providerRefundReference =
      ProviderEventProcessorService.getProviderRefundReference(providerEvent);

    const lineRefundReference = ProviderEventProcessorService.cleanString(
      line.paystackRefund?.reference
    );

    if (
      providerRefundReference &&
      lineRefundReference &&
      providerRefundReference !== lineRefundReference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund reference conflicts with the resolved refund line.",
        code: "PAYSTACK_REFUND_REFERENCE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const originalTransactionReference =
      ProviderEventProcessorService.getRefundOriginalTransactionReference(providerEvent);

    if (
      originalTransactionReference &&
      line.originalPaystackReference &&
      originalTransactionReference !== line.originalPaystackReference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack original transaction reference does not match the resolved refund line.",
        code: "PAYSTACK_REFUND_ORIGINAL_REFERENCE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    if (providerEvent.employer && String(providerEvent.employer) !== String(batch.business)) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider refund employer does not match the resolved refund batch.",
        code: "PAYSTACK_REFUND_EMPLOYER_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    return true;
  }

  static getEmployerRefundLineShiftId(line) {
    const shiftIds = [
      ...new Set(
        (line.allocations || [])
          .map((allocation) => ProviderEventProcessorService.getRecordId(allocation.shift))
          .filter(Boolean)
          .map(String)
      ),
    ];

    return shiftIds.length === 1 ? shiftIds[0] : null;
  }

  /* ─────────────────────────────── WITHDRAWAL LOOKUP ─────────────────────────────── */

  static async resolveWithdrawalRouting(providerEvent, options = {}) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);
    const references = [
      providerEvent.providerReference,
      payload.paystackTransferReference,
      payload.transferReference,
      payload.providerReference,
    ]
      .map(ProviderEventProcessorService.cleanString)
      .filter(Boolean);

    if (
      providerEvent.provider !== "paystack" ||
      !["transfer.success", "transfer.failed", "transfer.reversed"].includes(
        providerEvent.eventName
      ) ||
      !references.length ||
      new Set(references).size !== 1
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack Transfer requires one consistent provider reference.",
        code: "WITHDRAWAL_PROVIDER_TRANSFER_REFERENCE_REQUIRED",
        statusCode: 409,
        retryable: false,
      });
    }

    const reference = references[0];

    const query = Transaction.find({
      type: "withdrawal",
      purpose: "withdrawal",
      direction: "debit",
      provider: "paystack",
      paymentRail: "paystack_transfer",
      paystackTransferReference: reference,
    }).limit(2);

    if (options.session) query.session(options.session);
    const transactions = await query;

    if (!transactions.length) {
      // Non-withdrawal transfers remain recorded for their own reconciliation.
      throw ProviderEventProcessorService.createProcessingError({
        message: "No ordinary withdrawal matches this provider Transfer reference.",
        code: "WITHDRAWAL_TRANSACTION_NOT_FOUND_FOR_PROVIDER_EVENT",
        statusCode: 404,
        retryable: /^lq_withdrawal_[a-f0-9]{24}$/.test(reference),
      });
    }

    if (transactions.length !== 1) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider Transfer reference resolves to multiple withdrawals.",
        code: "WITHDRAWAL_PROVIDER_REFERENCE_AMBIGUOUS",
        statusCode: 409,
        retryable: false,
      });
    }

    const withdrawalTransaction = transactions[0];

    for (const id of [
      payload.withdrawalTransactionId,
      payload.transactionId,
      providerEvent.transaction,
    ]) {
      if (id && String(id) !== String(withdrawalTransaction._id)) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Provider Transfer reference conflicts with the linked transaction.",
          code: "WITHDRAWAL_PROVIDER_TRANSACTION_ID_MISMATCH",
          statusCode: 409,
          retryable: false,
        });
      }
    }

    const walletQuery = Wallet.findById(withdrawalTransaction.wallet);
    if (options.session) walletQuery.session(options.session);
    const wallet = await walletQuery;

    const ownerType = wallet?.ownerType;
    const metadata = withdrawalTransaction.metadata || {};
    const employer = ownerType === "employer" ? wallet.employer : null;
    const professional = ownerType === "professional" ? wallet.professional : null;

    if (
      !wallet ||
      !["employer", "professional"].includes(ownerType) ||
      metadata.ownerType !== ownerType ||
      (ownerType === "employer" &&
        (!employer ||
          wallet.professional ||
          String(metadata.employerProfileId) !== String(employer) ||
          metadata.professionalProfileId)) ||
      (ownerType === "professional" &&
        (!professional ||
          wallet.employer ||
          String(metadata.professionalProfileId) !== String(professional) ||
          metadata.employerProfileId)) ||
      !withdrawalTransaction.bankAccount ||
      wallet.countryCode !== withdrawalTransaction.countryCode ||
      wallet.currency !== withdrawalTransaction.currency
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Withdrawal does not match its historical wallet and owner.",
        code: "WITHDRAWAL_PROVIDER_WALLET_OWNERSHIP_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const suffix = providerEvent.eventName === "transfer.success" ? "payout" : "reversal";
    const eventCategory = `${ownerType}_withdrawal_${suffix}`;

    if (
      providerEvent.eventCategory !== "transfer_unresolved" &&
      providerEvent.eventCategory !== eventCategory
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider Transfer classification conflicts with the original wallet.",
        code: "WITHDRAWAL_PROVIDER_CATEGORY_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    for (const [actual, expected] of [
      [providerEvent.employer, employer],
      [providerEvent.professional, professional],
      [providerEvent.wallet, wallet._id],
      [providerEvent.bankAccount, withdrawalTransaction.bankAccount],
      [payload.employerProfileId, employer],
      [payload.professionalProfileId, professional],
      [payload.ownerType, ownerType],
    ]) {
      if (actual && (!expected || String(actual) !== String(expected))) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Provider Transfer link conflicts with its original withdrawal.",
          code: "WITHDRAWAL_PROVIDER_OWNER_MISMATCH",
          statusCode: 409,
          retryable: false,
        });
      }
    }

    return {
      withdrawalTransaction,
      routing: {
        eventCategory,
        employer,
        professional,
        wallet: wallet._id,
        transaction: withdrawalTransaction._id,
        bankAccount: withdrawalTransaction.bankAccount,
        normalizedPayload: {
          eventCategory,
          ownerType,
          employerProfileId: employer ? String(employer) : null,
          professionalProfileId: professional ? String(professional) : null,
          withdrawalTransactionId: String(withdrawalTransaction._id),
          transactionId: String(withdrawalTransaction._id),
        },
      },
    };
  }

  static async findWithdrawalTransactionForProviderEvent(providerEvent, options = {}) {
    const { withdrawalTransaction } = await ProviderEventProcessorService.resolveWithdrawalRouting(
      providerEvent,
      options
    );

    ProviderEventProcessorService.assertWithdrawalProviderEventMatchesTransaction({
      providerEvent,
      withdrawalTransaction,
    });

    return withdrawalTransaction;
  }

  static getWithdrawalOwnerContext({ withdrawalTransaction, providerEvent }) {
    const metadata = withdrawalTransaction.metadata || {};
    const ownerType = ProviderEventProcessorService.cleanString(metadata.ownerType)?.toLowerCase();
    const employer = ProviderEventProcessorService.getRecordId(metadata.employerProfileId);
    const professional = ProviderEventProcessorService.getRecordId(metadata.professionalProfileId);
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);
    if (
      !["employer", "professional"].includes(ownerType) ||
      (ownerType === "employer" && (!employer || metadata.professionalProfileId)) ||
      (ownerType === "professional" && (!professional || metadata.employerProfileId))
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Withdrawal transaction contains an invalid owner identity.",
        code: "WITHDRAWAL_PROVIDER_OWNER_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }
    if (payload.ownerType && payload.ownerType !== ownerType) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal owner type does not match the transaction.",
        code: "WITHDRAWAL_PROVIDER_OWNER_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }
    for (const [field, expected] of [
      ["employer", employer],
      ["professional", professional],
    ]) {
      for (const value of [providerEvent[field], payload[field + "ProfileId"]]) {
        if (
          value != null &&
          value !== "" &&
          (!expected || String(value._id || value) !== String(expected))
        ) {
          throw ProviderEventProcessorService.createProcessingError({
            message: "Provider withdrawal profile does not match the transaction.",
            code: "WITHDRAWAL_PROVIDER_OWNER_MISMATCH",
            statusCode: 409,
            retryable: false,
          });
        }
      }
    }
    return {
      ownerType,
      employer,
      professional,
      employerProfileId: employer,
      professionalProfileId: professional,
    };
  }

  static assertWithdrawalCategoryMatchesOwner({ providerEvent, ownerType }) {
    const suffix =
      providerEvent.eventName === "transfer.success"
        ? "payout"
        : ["transfer.failed", "transfer.reversed"].includes(providerEvent.eventName)
          ? "reversal"
          : null;
    if (
      providerEvent.provider !== "paystack" ||
      !suffix ||
      providerEvent.eventCategory !== ownerType + "_withdrawal_" + suffix
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Withdrawal event category, event name or provider does not match its owner.",
        code: "WITHDRAWAL_PROVIDER_CATEGORY_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }
  }

  static assertIndependentFinalization(options = {}) {
    if (options.session) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Checkout event finalization must own its claim and completion transactions.",
        code: "CHECKOUT_EVENT_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }
  }

  static assertWithdrawalProviderEventMatchesTransaction({ providerEvent, withdrawalTransaction }) {
    if (!withdrawalTransaction) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Withdrawal transaction is required for provider-event validation.",
        code: "WITHDRAWAL_TRANSACTION_REQUIRED_FOR_PROVIDER_EVENT_VALIDATION",
        statusCode: 500,
        retryable: false,
      });
    }

    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const expectedTransferReference = ProviderEventProcessorService.cleanString(
      withdrawalTransaction.paystackTransferReference
    );

    const providerTransferReference = ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPaystackTransferReference(providerEvent)
    );

    if (!expectedTransferReference) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Provider-bound withdrawal has no persisted deterministic Paystack Transfer reference.",
        code: "WITHDRAWAL_TRANSFER_REFERENCE_MISSING",
        statusCode: 409,
        retryable: false,
        details: {
          withdrawalTransactionId: String(withdrawalTransaction._id),
        },
      });
    }

    if (!providerTransferReference) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal event contains no Paystack Transfer reference.",
        code: "WITHDRAWAL_PROVIDER_TRANSFER_REFERENCE_REQUIRED",
        statusCode: 422,
        retryable: false,
      });
    }

    if (providerTransferReference !== expectedTransferReference) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal Transfer reference does not match the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_TRANSFER_REFERENCE_MISMATCH",
        statusCode: 409,
        retryable: false,
        details: {
          expectedTransferReference,
          providerTransferReference,
          withdrawalTransactionId: String(withdrawalTransaction._id),
        },
      });
    }

    const providerTransferCode = ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPaystackTransferCode(providerEvent)
    );

    const storedTransferCode = ProviderEventProcessorService.cleanString(
      withdrawalTransaction.paystackTransferCode
    );

    if (providerTransferCode && storedTransferCode && providerTransferCode !== storedTransferCode) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal Transfer code conflicts with the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_TRANSFER_CODE_MISMATCH",
        statusCode: 409,
        retryable: false,
        details: {
          storedTransferCode,
          providerTransferCode,
          withdrawalTransactionId: String(withdrawalTransaction._id),
        },
      });
    }

    const providerAmount = ProviderEventProcessorService.getProviderEventAmount(
      providerEvent,
      "withdrawal amount"
    );

    const payoutAmount = ProviderEventProcessorService.normalizeRequiredPositiveMinorUnitAmount(
      withdrawalTransaction.netAmount ?? withdrawalTransaction.amount,
      "withdrawal bank payout"
    );

    if (providerAmount === null || providerAmount !== payoutAmount) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal amount does not match the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_AMOUNT_MISMATCH",
        statusCode: 409,
        retryable: false,
        details: {
          expectedAmount: payoutAmount,
          providerAmount,
          withdrawalTransactionId: String(withdrawalTransaction._id),
        },
      });
    }

    const providerCurrency = ProviderEventProcessorService.cleanString(
      payload.currency || providerEvent.currency
    )?.toUpperCase();

    if (
      !providerCurrency ||
      providerCurrency !== String(withdrawalTransaction.currency || "").toUpperCase()
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal currency does not match the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_CURRENCY_MISMATCH",
        statusCode: 409,
        retryable: false,
        details: {
          expectedCurrency: withdrawalTransaction.currency || null,
          providerCurrency,
          withdrawalTransactionId: String(withdrawalTransaction._id),
        },
      });
    }

    const expectedRecipientCode = ProviderEventProcessorService.cleanString(
      withdrawalTransaction.metadata?.paystackRecipientCode
    );
    const providerRecipientCode = ProviderEventProcessorService.cleanString(payload.recipientCode);

    if (
      !expectedRecipientCode ||
      !providerRecipientCode ||
      expectedRecipientCode !== providerRecipientCode
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Transfer recipient does not match the recorded withdrawal recipient.",
        code: "WITHDRAWAL_PROVIDER_RECIPIENT_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    if (providerEvent.countryCode !== withdrawalTransaction.countryCode) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal country does not match the original withdrawal.",
        code: "WITHDRAWAL_PROVIDER_COUNTRY_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const transactionMetadata = withdrawalTransaction.metadata || {};

    const transactionEmployer = ProviderEventProcessorService.cleanString(
      transactionMetadata.employerProfileId
    );

    const transactionProfessional = ProviderEventProcessorService.cleanString(
      transactionMetadata.professionalProfileId
    );

    const eventEmployer = ProviderEventProcessorService.cleanString(providerEvent.employer);

    const eventProfessional = ProviderEventProcessorService.cleanString(providerEvent.professional);

    if (eventEmployer && transactionEmployer && eventEmployer !== transactionEmployer) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal employer does not match the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_EMPLOYER_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    if (
      eventProfessional &&
      transactionProfessional &&
      eventProfessional !== transactionProfessional
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal professional does not match the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_PROFESSIONAL_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    if (
      providerEvent.bankAccount &&
      withdrawalTransaction.bankAccount &&
      String(providerEvent.bankAccount) !== String(withdrawalTransaction.bankAccount)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider withdrawal bank account does not match the resolved withdrawal.",
        code: "WITHDRAWAL_PROVIDER_BANK_ACCOUNT_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    return true;
  }

  /* ─────────────────────────────── PROCESS PROVIDER EVENT ─────────────────────────────── */

  static async processProviderEvent(
    { providerEventRecordId, currentTime = new Date() },
    options = {}
  ) {
    const normalizedCurrentTime = ProviderEventProcessorService.normalizeCurrentTime(currentTime);

    let providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
      session: options.session,
    });

    if (providerEvent.status === "processed") {
      return {
        providerEvent,
        alreadyProcessed: true,
      };
    }

    if (providerEvent.status === "ignored") {
      return {
        providerEvent,
        alreadyIgnored: true,
      };
    }

    if (!providerEvent.isVerified) {
      const failedResult = await ProviderEventService.markFailed(
        {
          providerEventRecordId: providerEvent._id,
          failureReason: "Unverified provider event cannot be processed.",
          retryable: false,
          metadata: {
            processor: "ProviderEventProcessorService",
          },
          currentTime: normalizedCurrentTime,
        },
        {
          session: options.session,
        }
      );

      return {
        providerEvent: failedResult.providerEvent,
        failed: true,
        retryable: false,
        errorMessage: "Unverified provider event cannot be processed.",
      };
    }

    if (providerEvent.status === "failed") {
      if (!providerEvent.nextRetryAt) {
        return {
          providerEvent,
          failed: true,
          retryable: false,
          retryUnavailable: true,
          errorMessage:
            providerEvent.failureReason || "Provider event failed and is not scheduled for retry.",
        };
      }

      const nextRetryAt = new Date(providerEvent.nextRetryAt);

      if (Number.isNaN(nextRetryAt.getTime())) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Provider event contains an invalid retry deadline.",
          code: "INVALID_PROVIDER_EVENT_RETRY_DEADLINE",
          statusCode: 500,
          retryable: false,
          details: {
            providerEventRecordId: String(providerEvent._id),
          },
        });
      }

      if (nextRetryAt > normalizedCurrentTime) {
        return {
          providerEvent,
          failed: true,
          retryable: true,
          retryNotDue: true,
          nextRetryAt,
          errorMessage: providerEvent.failureReason || "Provider event retry is not due yet.",
        };
      }
    }

    if (
      options.session &&
      ProviderEventProcessorService.isCategory(
        providerEvent,
        ProviderEventProcessorService.eventCategories.subscriptionPayment
      )
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Subscription event processing must own its claim and completion transactions.",
        code: "SUBSCRIPTION_EVENT_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }

    // DVA assignment reconciliation owns its own durable state transition.
    //
    // Do not let an external transaction roll back the event state while
    // its associated DVA update has already been committed.
    if (
      options.session &&
      ProviderEventProcessorService.isCategory(
        providerEvent,
        ProviderEventProcessorService.eventCategories.dvaAssignment
      )
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA assignment event processing does not accept an external session.",
        code: "DVA_ASSIGNMENT_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }

    if (
      ProviderEventProcessorService.isCategory(providerEvent, [
        ...ProviderEventProcessorService.eventCategories.shiftCheckoutPayment,
        ...ProviderEventProcessorService.eventCategories.jobPublicationPayment,
      ])
    ) {
      ProviderEventProcessorService.assertIndependentFinalization(options);
    }

    if (
      options.session &&
      ProviderEventProcessorService.isCategory(
        providerEvent,
        ProviderEventProcessorService.eventCategories.employerWalletFunding
      )
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding processing does not accept an external session.",
        code: "DVA_FUNDING_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }

    if (
      options.session &&
      providerEvent.provider === "paystack" &&
      ["transfer.failed", "transfer.reversed"].includes(providerEvent.eventName)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Withdrawal reversal processing does not accept an external session.",
        code: "WITHDRAWAL_REVERSAL_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }

    const processingResult = await ProviderEventService.markProcessing(
      {
        providerEventRecordId: providerEvent._id,
        currentTime: normalizedCurrentTime,
      },
      {
        session: options.session,
      }
    );

    if (processingResult.alreadyProcessed === true) {
      return {
        providerEvent: processingResult.providerEvent,
        alreadyProcessed: true,
      };
    }

    if (processingResult.claimedForProcessing !== true) {
      return {
        providerEvent: processingResult.providerEvent,
        skipped: true,
        alreadyProcessing: processingResult.alreadyProcessing === true,
        processingClaimed: false,
      };
    }

    providerEvent = processingResult.providerEvent;

    const processingClaimId = ProviderEventProcessorService.cleanString(
      processingResult.processingClaimId || providerEvent.processingClaimId
    );

    if (!processingClaimId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Claimed ProviderEvent contains no processing claim ID.",
        code: "PROVIDER_EVENT_PROCESSING_CLAIM_MISSING",
        statusCode: 500,
        retryable: false,
        details: {
          providerEventRecordId: String(providerEvent._id),
        },
      });
    }

    try {
      // DVA assignment

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.dvaAssignment
        )
      ) {
        return await ProviderEventProcessorService.processDVAAssignmentEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Employer refunds

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.employerRefund
        )
      ) {
        return await ProviderEventProcessorService.processEmployerRefundEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Shift checkout payments

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.shiftCheckoutPayment
        )
      ) {
        return await ProviderEventProcessorService.processShiftCheckoutPaymentEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Job publication payments

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.jobPublicationPayment
        )
      ) {
        return await ProviderEventProcessorService.processJobPublicationPaymentEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Subscription payments

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.subscriptionPayment
        )
      ) {
        return await ProviderEventProcessorService.processSubscriptionPaymentEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Employer wallet funding

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.employerWalletFunding
        )
      ) {
        return await ProviderEventProcessorService.processEmployerWalletFundingEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Historical obligation payouts never use ordinary withdrawal execution.
      if (
        providerEvent.provider === "paystack" &&
        ["transfer.success", "transfer.failed", "transfer.reversed"].includes(providerEvent.eventName)
      ) {
        const reference =
          ProviderEventProcessorService.getPaystackTransferReference(providerEvent);

        if (reference && /^lq_obligation_[a-f0-9]{24}(?:_[2-9]|_[1-9][0-9])?$/.test(reference)) {
          ProviderEventProcessorService.assertIndependentFinalization(options);

          const PayoutService = require("./financialObligationPayoutService");

          return await PayoutService.reconcileFromProviderEvent({
            providerEventRecordId: providerEvent._id,
            processingClaimId,
            reference,
          });
        }
      }

      // Resolve and link withdrawal ownership

      if (
        providerEvent.provider === "paystack" &&
        ["transfer.success", "transfer.failed", "transfer.reversed"].includes(
          providerEvent.eventName
        )
      ) {
        const { routing } = await ProviderEventProcessorService.resolveWithdrawalRouting(
          providerEvent,
          options
        );

        providerEvent = await ProviderEventService.linkWithdrawalRouting(
          {
            providerEventRecordId: providerEvent._id,
            processingClaimId,
            routing,
          },
          options
        );
      }

      // Withdrawal payout

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.withdrawalPayout
        )
      ) {
        return await ProviderEventProcessorService.processWithdrawalPayoutEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Withdrawal reversal

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.withdrawalReversal
        )
      ) {
        return await ProviderEventProcessorService.processWithdrawalReversalEvent(
          providerEvent,
          processingClaimId,
          {
            ...options,
            currentTime: normalizedCurrentTime,
          }
        );
      }

      // Unhandled provider events

      const ignoredResult = await ProviderEventService.markIgnored(
        {
          providerEventRecordId: providerEvent._id,
          processingClaimId,
          ignoredReason: "Provider event category is not handled by this processor.",
          metadata: {
            processor: "ProviderEventProcessorService",
          },
          currentTime: normalizedCurrentTime,
        },
        {
          session: options.session,
        }
      );

      return {
        providerEvent: ignoredResult.providerEvent,
        ignored: true,
      };
    } catch (error) {
      // Processing claim lost

      if (ProviderEventProcessorService.isProcessingClaimError(error)) {
        return ProviderEventProcessorService.getProcessingClaimLostResult(
          providerEvent._id,
          error,
          options
        );
      }

      // Retry classification

      const shiftFundingRecoveryRequired =
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.shiftCheckoutPayment
        ) && ProviderEventProcessorService.isShiftFundingRecoveryError(error);

      const retryable = ProviderEventProcessorService.isRetryableProcessingError(error);

      const failedAt = new Date(normalizedCurrentTime.getTime());

      const nextRetryAt = retryable
        ? new Date(failedAt.getTime() + PROVIDER_EVENT_RETRY_DELAY_MS)
        : null;

      try {
        const failedResult = await ProviderEventService.markFailed(
          {
            providerEventRecordId: providerEvent._id,
            processingClaimId,
            failureReason: error.message || "Provider event processing failed.",
            retryable,
            nextRetryAt,
            metadata: {
              processor: "ProviderEventProcessorService",
              errorCode: error.code || null,
              statusCode: Number.isInteger(Number(error.statusCode))
                ? Number(error.statusCode)
                : null,
              errorDetails: error.details || null,
              shiftFundingRecoveryRequired,
            },
            currentTime: failedAt,
          },
          {
            session: options.session,
          }
        );

        return {
          providerEvent: failedResult.providerEvent,
          failed: true,
          retryable,
          nextRetryAt,
          errorCode: error.code || null,
          shiftFundingRecoveryRequired,
          errorMessage: error.message || "Provider event processing failed.",
        };
      } catch (markFailedError) {
        if (ProviderEventProcessorService.isProcessingClaimError(markFailedError)) {
          return ProviderEventProcessorService.getProcessingClaimLostResult(
            providerEvent._id,
            markFailedError,
            options
          );
        }

        throw markFailedError;
      }
    }
  }

  /* ─────────────────────────────── PAYSTACK DVA ASSIGNMENT ─────────────────────────────── */

  static async processDVAAssignmentEvent(providerEvent, processingClaimId, options = {}) {
    // DVA assignment reconciliation performs independent database updates
    // and may perform external provider operations. It must not execute
    // inside an externally owned database transaction.

    if (options.session) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA assignment processing does not accept an external session.",

        code: "DVA_ASSIGNMENT_EXTERNAL_SESSION_NOT_SUPPORTED",

        statusCode: 500,

        retryable: false,
      });
    }

    if (!providerEvent?._id) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Provider event identity is required.",

        code: "DVA_ASSIGNMENT_EVENT_REQUIRED",

        statusCode: 422,

        retryable: false,
      });
    }

    // Reload the verified event and validate the active processing claim.

    const currentEvent = await ProviderEventService.getProviderEventById(providerEvent._id);

    if (
      currentEvent.provider !== "paystack" ||
      currentEvent.eventCategory !== "dva_assignment" ||
      currentEvent.isVerified !== true
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "A verified Paystack DVA assignment event is required.",

        code: "DVA_ASSIGNMENT_EVENT_NOT_VERIFIED",

        statusCode: 422,

        retryable: false,
      });
    }

    ProviderEventService.assertActiveProcessingClaim(currentEvent, processingClaimId);

    const payload = ProviderEventProcessorService.getNormalizedPayload(currentEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const eventName = ProviderEventProcessorService.cleanString(
      currentEvent.eventName
    )?.toLowerCase();

    if (
      !["dedicatedaccount.assign.success", "dedicatedaccount.assign.failed"].includes(eventName)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Unsupported Paystack dedicated-account assignment event.",

        code: "UNSUPPORTED_PAYSTACK_DVA_ASSIGNMENT_EVENT",

        statusCode: 422,

        retryable: false,
      });
    }

    const expectedOutcome = eventName === "dedicatedaccount.assign.success" ? "success" : "failed";

    const expectedStatus = expectedOutcome === "success" ? "active" : "failed";

    // Require sufficient provider identity to resolve the assignment.

    const customerId = ProviderEventProcessorService.cleanString(payload.paystackCustomerId);

    const customerCode = ProviderEventProcessorService.cleanString(payload.paystackCustomerCode);

    const customerEmail = ProviderEventProcessorService.cleanString(
      payload.customerEmail
    )?.toLowerCase();

    const dedicatedAccountId = ProviderEventProcessorService.cleanString(
      payload.paystackDedicatedAccountId
    );

    if (!customerId && !customerCode && !customerEmail && !dedicatedAccountId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack DVA assignment contains no usable provider identity.",

        code: "PAYSTACK_DVA_ASSIGNMENT_IDENTITY_REQUIRED",

        statusCode: 422,

        retryable: false,
      });
    }

    // DVA assignment is not a financial movement and must not
    // carry unrelated financial relationships.

    if (
      currentEvent.transaction ||
      currentEvent.financialObligation ||
      currentEvent.professional ||
      currentEvent.bankAccount ||
      currentEvent.shift ||
      currentEvent.shiftApplication ||
      currentEvent.employerRefundBatch ||
      currentEvent.employerRefundBatchLineId
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA assignment contains unrelated financial relationships.",

        code: "PAYSTACK_DVA_ASSIGNMENT_RELATIONSHIP_CONFLICT",

        statusCode: 409,

        retryable: false,
      });
    }

    const eventMarker = ProviderEventProcessorService.getProviderEventMarker(currentEvent);

    // Delegate assignment reconciliation to the authoritative DVA service.

    const result = await DVAService.applyPaystackAssignmentEvent({
      eventName,

      normalizedPayload: payload,

      rawPayload: currentEvent.rawPayload,

      providerEventRecordId: currentEvent._id,

      providerEventMarker: eventMarker,

      expectedOwnership: {
        dva: currentEvent.dva || null,

        employer: currentEvent.employer || null,

        wallet: currentEvent.wallet || null,
      },

      currentTime,
    });

    const resolvedDVA = result?.dva;

    if (
      !resolvedDVA?._id ||
      !resolvedDVA.employer ||
      !resolvedDVA.wallet ||
      result.assignmentOutcome !== expectedOutcome
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack DVA assignment has not reached a valid durable outcome.",

        code: "PAYSTACK_DVA_ASSIGNMENT_FINALIZATION_PENDING",

        statusCode: 503,

        retryable: true,
      });
    }

    const historical = result.historicalAssignmentReconciled === true;

    // A normal assignment must reach its expected terminal state.

    if (!historical) {
      if (resolvedDVA.status !== expectedStatus || resolvedDVA.retirementStartedAt) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "DVA assignment outcome conflicts with the resolved DVA lifecycle state.",

          code: "PAYSTACK_DVA_ASSIGNMENT_STATE_MISMATCH",

          statusCode: 409,

          retryable: true,
        });
      }
    }

    // Historical assignments require confirmed provider unassignment
    // without changing the DVA's retirement status.

    const evidence = historical ? result.historicalReconciliation : null;

    if (historical) {
      if (
        !["retiring", "deactivated"].includes(resolvedDVA.status) ||
        !resolvedDVA.retirementStartedAt ||
        resolvedDVA.retirementResolution !== "provider_unassigned" ||
        !resolvedDVA.retirementConfirmedAt ||
        result.retirementResolution !== "provider_unassigned" ||
        result.resolutionSource !== "verified_historical_provider_unassignment" ||
        !evidence ||
        evidence.assigned !== false ||
        evidence.providerMode !== resolvedDVA.metadata?.assignmentMode ||
        String(evidence.providerEventRecordId) !== String(currentEvent._id) ||
        String(evidence.providerEventMarker) !== String(eventMarker) ||
        String(evidence.dedicatedAccountId) !== String(resolvedDVA.paystackDedicatedAccountId) ||
        String(evidence.customerId) !== String(resolvedDVA.paystackCustomerId) ||
        evidence.customerCode !== resolvedDVA.paystackCustomerCode ||
        evidence.accountNumber !== resolvedDVA.accountNumber
      ) {
        throw ProviderEventProcessorService.createProcessingError({
          message:
            "Historical DVA assignment does not contain valid retirement reconciliation evidence.",

          code: "PAYSTACK_DVA_HISTORICAL_OUTCOME_INVALID",

          statusCode: 409,

          retryable: false,
        });
      }

      const evidenceTime = new Date(evidence.verifiedAt);

      if (
        !evidence.verifiedAt ||
        Number.isNaN(evidenceTime.getTime()) ||
        evidenceTime < resolvedDVA.retirementConfirmedAt
      ) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Historical DVA reconciliation has an invalid verification timestamp.",

          code: "PAYSTACK_DVA_HISTORICAL_VERIFICATION_TIME_INVALID",

          statusCode: 409,

          retryable: false,
        });
      }
    }

    // Revalidate the durable DVA outcome and complete the provider event
    // inside a database transaction.

    return ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      const finalEvent = await ProviderEventService.getProviderEventById(currentEvent._id, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(finalEvent, processingClaimId);

      if (
        finalEvent.isVerified !== true ||
        finalEvent.provider !== "paystack" ||
        finalEvent.eventCategory !== "dva_assignment" ||
        finalEvent.eventName !== eventName
      ) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Provider event identity changed during DVA assignment processing.",

          code: "PAYSTACK_DVA_ASSIGNMENT_EVENT_CONFLICT",

          statusCode: 409,

          retryable: false,
        });
      }

      const dva = await DVA.findById(resolvedDVA._id).session(session);

      // Revalidate the original employer, wallet and market.

      if (
        !dva ||
        String(dva.employer) !== String(resolvedDVA.employer) ||
        String(dva.wallet) !== String(resolvedDVA.wallet) ||
        dva.provider !== "paystack" ||
        dva.countryCode !== finalEvent.countryCode ||
        dva.currency !== finalEvent.currency
      ) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Original DVA ownership could not be confirmed during event completion.",

          code: "PAYSTACK_DVA_ASSIGNMENT_OWNERSHIP_CONFLICT",

          statusCode: 409,

          retryable: false,
        });
      }

      // Do not overwrite previously established event relationships.

      for (const [field, expected] of Object.entries({
        employer: dva.employer,

        wallet: dva.wallet,

        dva: dva._id,
      })) {
        if (finalEvent[field] && String(finalEvent[field]) !== String(expected)) {
          throw ProviderEventProcessorService.createProcessingError({
            message: `DVA assignment conflicts with its existing ${field} relationship.`,

            code: "PAYSTACK_DVA_ASSIGNMENT_OWNERSHIP_CONFLICT",

            statusCode: 409,

            retryable: false,
          });
        }
      }

      if (historical) {
        // Confirm the historical retirement evidence remains unchanged.

        const confirmation = dva.metadata?.retirementConfirmation;

        if (
          !["retiring", "deactivated"].includes(dva.status) ||
          !dva.retirementStartedAt ||
          dva.retirementResolution !== "provider_unassigned" ||
          !dva.retirementConfirmedAt ||
          new Date(dva.retirementConfirmedAt).getTime() !==
            new Date(resolvedDVA.retirementConfirmedAt).getTime() ||
          confirmation?.assigned !== false ||
          confirmation?.mode !== evidence.providerMode ||
          dva.isDefault === true ||
          String(dva.paystackDedicatedAccountId) !== String(evidence.dedicatedAccountId) ||
          String(dva.paystackCustomerId) !== String(evidence.customerId) ||
          dva.paystackCustomerCode !== evidence.customerCode ||
          dva.accountNumber !== evidence.accountNumber
        ) {
          throw ProviderEventProcessorService.createProcessingError({
            message: "Historical DVA retirement changed before event completion.",

            code: "PAYSTACK_DVA_HISTORICAL_OUTCOME_CHANGED",

            statusCode: 409,

            retryable: true,
          });
        }
      } else {
        // If retirement began after ordinary assignment processing,
        // retry through the historical reconciliation workflow.

        if (dva.status !== expectedStatus || dva.retirementStartedAt) {
          throw ProviderEventProcessorService.createProcessingError({
            message: "DVA lifecycle changed before assignment event completion.",

            code: "PAYSTACK_DVA_ASSIGNMENT_STATE_CHANGED",

            statusCode: 409,

            retryable: true,
          });
        }

        // Confirm that provider identifiers have not changed.

        for (const field of [
          "paystackDedicatedAccountId",
          "paystackCustomerId",
          "paystackCustomerCode",
          "accountNumber",
        ]) {
          if (String(dva[field] ?? "") !== String(resolvedDVA[field] ?? "")) {
            throw ProviderEventProcessorService.createProcessingError({
              message: "DVA provider identity changed before event completion.",

              code: "PAYSTACK_DVA_ASSIGNMENT_IDENTITY_CHANGED",

              statusCode: 409,

              retryable: true,
            });
          }
        }
      }

      // Preserve the original provider payload and record the resolved
      // identifiers and assignment outcome separately.

      const originalPayload = finalEvent.normalizedPayload || {};

      const normalizedOutcome = {
        ...originalPayload,

        employerProfileId: String(dva.employer),

        walletId: String(dva.wallet),

        dvaId: String(dva._id),

        resolvedPaystackCustomerId:
          dva.paystackCustomerId != null ? String(dva.paystackCustomerId) : null,

        resolvedPaystackCustomerCode: dva.paystackCustomerCode || null,

        resolvedPaystackDedicatedAccountId:
          dva.paystackDedicatedAccountId != null ? String(dva.paystackDedicatedAccountId) : null,

        assignmentOutcome: expectedOutcome,

        dvaAssignmentStatus: dva.status,

        historicalAssignmentReconciled: historical,

        retirementResolution: historical ? dva.retirementResolution : null,

        retirementConfirmedAt: historical ? dva.retirementConfirmedAt : null,
      };

      const completedAt = new Date(
        Math.max(
          Date.now(),

          currentTime.getTime(),

          historical ? new Date(evidence.verifiedAt).getTime() : 0
        )
      );

      // Mark the verified event processed without changing DVA status
      // or creating any wallet transaction.

      const processedResult = await ProviderEventService.markProcessed(
        {
          providerEventRecordId: finalEvent._id,

          processingClaimId,

          employer: dva.employer,

          wallet: dva.wallet,

          dva: dva._id,

          normalizedPayload: normalizedOutcome,

          metadata: {
            processor: "ProviderEventProcessorService",

            dvaAssignmentStatus: dva.status,

            assignmentOutcome: expectedOutcome,

            idempotentDVAAssignment: result.idempotent === true,

            historicalAssignmentReconciled: historical,

            resolutionSource: result.resolutionSource || null,

            retirementResolution: historical ? dva.retirementResolution : null,

            historicalAssignmentReconciliation: historical ? evidence : null,
          },

          currentTime: completedAt,
        },
        { session }
      );

      return {
        providerEvent: processedResult.providerEvent,

        dva,

        processed: true,

        dvaAssignmentStatus: dva.status,

        assignmentOutcome: expectedOutcome,

        historicalAssignmentReconciled: historical,

        retirementResolution: historical ? dva.retirementResolution : null,

        idempotentDVAAssignment: result.idempotent === true,
      };
    });
  }

  /* ─────────────────────────────── EMPLOYER PAYSTACK REFUND ─────────────────────────────── */

  static async processEmployerRefundEvent(providerEvent, processingClaimId, options = {}) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const { status: refundStatus } =
      ProviderEventProcessorService.getPaystackRefundStatus(providerEvent);

    const providerRefundId = ProviderEventProcessorService.getProviderRefundId(providerEvent);

    const providerRefundReference =
      ProviderEventProcessorService.getProviderRefundReference(providerEvent);

    const refundTraceKey = ProviderEventProcessorService.getRefundTraceKey(providerEvent);

    const originalTransactionReference =
      ProviderEventProcessorService.getRefundOriginalTransactionReference(providerEvent);

    const linkedBatchId = ProviderEventProcessorService.getRecordId(
      providerEvent.employerRefundBatch
    );

    const linkedLineId = ProviderEventProcessorService.getRecordId(
      providerEvent.employerRefundBatchLineId
    );

    // Validate refund reconciliation identity

    if (
      !linkedBatchId &&
      !linkedLineId &&
      !providerRefundId &&
      !providerRefundReference &&
      !refundTraceKey &&
      !originalTransactionReference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack refund event contains no usable refund reconciliation identity.",
        code: "PAYSTACK_REFUND_RECONCILIATION_IDENTITY_REQUIRED",
        statusCode: 422,
        retryable: false,
      });
    }

    // Historical obligations are separate from shift refund batches.
    const FinancialObligation = require("../models/FinancialObligation");
    const RefundService = require("./financialObligationRefundService");

    const candidates = [];

    if (providerRefundId) {
      candidates.push({ "refundExecution.providerRefundId": providerRefundId });
    }

    if (refundTraceKey) {
      candidates.push({ "refundExecution.traceKey": refundTraceKey });
    }

    if (originalTransactionReference) {
      candidates.push({ providerReference: originalTransactionReference });
    }

    if (payload.originalTransactionProviderId) {
      candidates.push({
        providerTransactionId: String(payload.originalTransactionProviderId)
      });
    }

    if (candidates.length) {
      const obligations = await FinancialObligation.find({
        provider: "paystack",
        providerMode: PaystackService.getMode(),
        type: {
          $in: ["retired_dva_funding", "historical_commercial_payment"]
        },
        refundExecution: { $ne: null },
        $or: candidates,
      }).limit(2);

      if (obligations.length > 1 || (obligations.length && (linkedBatchId || linkedLineId))) {
        throw new Error("Ambiguous historical refund routing.");
      }

      if (obligations.length) {
        ProviderEventProcessorService.assertIndependentFinalization(options);

        return RefundService.reconcileFromProviderEvent({
          obligationId: obligations[0]._id,
          providerRefundId,
          providerEventRecordId: providerEvent._id,
          processingClaimId,
        });
      }
    }

    // Resolve refund execution

    const execution = await ProviderEventProcessorService.resolveEmployerRefundExecution(
      providerEvent,
      {
        session: options.session,
      }
    );

    // Validate refund against execution

    ProviderEventProcessorService.assertEmployerRefundEventMatchesExecution({
      providerEvent,
      batch: execution.batch,
      line: execution.line,
    });

    const batchId = execution.batch._id;
    const lineId = execution.line._id;
    const employerId = execution.batch.business;

    const shiftId = ProviderEventProcessorService.getEmployerRefundLineShiftId(execution.line);

    const providerEventMarker = ProviderEventProcessorService.getProviderEventMarker(providerEvent);

    const resolvedOriginalTransactionReference =
      originalTransactionReference || execution.line.originalPaystackReference;

    const failureReason =
      refundStatus === "failed"
        ? ProviderEventProcessorService.getRefundFailureReason(providerEvent) ||
          "Paystack reported that the employer refund failed."
        : null;

    // Link provider event to refund execution

    await ProviderEventService.linkEmployerRefundExecution(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        employerRefundBatch: batchId,
        employerRefundBatchLineId: lineId,
        providerRefundId,
        providerRefundReference,
        employer: employerId,
        shift: shiftId,
      },
      {
        session: options.session,
      }
    );

    // Synchronize paystack refund status

    const syncResult = await EmployerRefundBatchService.syncPaystackRefundStatus({
      batchId,
      lineId,
      status: refundStatus,
      refundId: providerRefundId,
      reference: providerRefundReference,
      providerEventId: providerEventMarker,
      failureReason,
      currentTime,
    });

    // Mark provider event processed

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        employer: employerId,
        shift: shiftId,
        providerRefundId,
        providerRefundReference,
        employerRefundBatch: batchId,
        employerRefundBatchLineId: lineId,

        normalizedPayload: {
          ...payload,
          refundStatus,
          paystackRefundStatus: refundStatus,
          providerRefundId,
          providerRefundReference,
          originalTransactionReference: resolvedOriginalTransactionReference,
          refundTraceKey,
          employerProfileId: employerId ? String(employerId) : null,
          shiftId: shiftId ? String(shiftId) : null,
          employerRefundBatchId: String(batchId),
          employerRefundBatchLineId: String(lineId),
        },

        metadata: {
          processor: "ProviderEventProcessorService",
          employerRefundSynchronized: true,
          employerRefundBatchId: String(batchId),
          employerRefundBatchLineId: String(lineId),
          refundStatus,
          resolutionSource: execution.resolutionSource,
          providerEventMarker,
        },

        currentTime,
      },
      {
        session: options.session,
      }
    );

    return {
      providerEvent: processedResult.providerEvent,
      batch: syncResult?.batch || execution.batch,
      line: syncResult?.line || syncResult?.refundLine || execution.line,
      processed: true,
      refundStatus,
      employerRefundBatchId: String(batchId),
      employerRefundBatchLineId: String(lineId),
    };
  }

  /* ─────────────────────────────── SHIFT CHECKOUT PAYMENT ─────────────────────────────── */

  static async processShiftCheckoutPaymentEvent(providerEvent, processingClaimId, options = {}) {
    ProviderEventProcessorService.assertIndependentFinalization(options);
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const reference = ProviderEventProcessorService.getShiftFundingReference(providerEvent);

    const providerEventId = ProviderEventProcessorService.cleanString(
      payload.providerEventId || providerEvent.providerEventId
    );

    if (!reference) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack reference is required to process Shift Checkout funding.",
        code: "SHIFT_CHECKOUT_PROVIDER_REFERENCE_REQUIRED",
        statusCode: 422,
        retryable: false,
      });
    }

    const fundingResult = await ShiftFundingService.finalizePaystackShiftFunding({
      reference,
      providerEventId,
      currentTime,
    });

    const fundingTransactionRecord = await Transaction.findOne({
      paystackReference: reference,
      paymentRail: "paystack_checkout",
      provider: "paystack",
      type: {
        $in: ["shift_funding", "shift_topup"],
      },
    });

    if (!fundingTransactionRecord) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Shift funding transaction was not found after Paystack finalization.",
        code: "SHIFT_FUNDING_TRANSACTION_NOT_FOUND_AFTER_FINALIZATION",
        statusCode: 404,
        retryable: true,
        details: {
          reference,
        },
      });
    }

    const fundingTransactionId = fundingTransactionRecord._id;

    const isBaseFunding =
      fundingTransactionRecord.type === "shift_funding" &&
      fundingTransactionRecord.purpose === "shift_base_funding";

    const isOvertimeTopUp =
      fundingTransactionRecord.type === "shift_topup" &&
      fundingTransactionRecord.purpose === "shift_overtime_topup";

    if (!isBaseFunding && !isOvertimeTopUp) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack Shift payment contains an unsupported funding purpose.",
        code: "UNSUPPORTED_PAYSTACK_SHIFT_PAYMENT_PURPOSE",
        statusCode: 409,
        retryable: false,
        details: {
          type: fundingTransactionRecord.type,
          purpose: fundingTransactionRecord.purpose,
          fundingTransactionId: String(fundingTransactionId),
        },
      });
    }

    const shift = fundingResult.shift || null;

    const shiftId =
      ProviderEventProcessorService.getRecordId(shift) ||
      ProviderEventProcessorService.getRecordId(fundingTransactionRecord.shift) ||
      ProviderEventProcessorService.getRecordId(fundingResult.shiftId) ||
      ProviderEventProcessorService.getRecordId(payload.shiftId) ||
      ProviderEventProcessorService.getRecordId(providerEvent.shift);

    if (!shiftId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Shift could not be identified after Paystack funding finalization.",
        code: "SHIFT_FUNDING_SHIFT_ID_UNRESOLVED",
        statusCode: 500,
        retryable: true,
        details: {
          fundingTransactionId: String(fundingTransactionId),
          reference,
        },
      });
    }

    const transactionMetadata = fundingTransactionRecord.metadata || {};

    const escrowWalletId =
      ProviderEventProcessorService.getRecordId(fundingTransactionRecord.wallet) ||
      ProviderEventProcessorService.getRecordId(fundingResult.wallet) ||
      ProviderEventProcessorService.getRecordId(fundingResult.escrowWallet) ||
      null;

    const employerProfileId =
      ProviderEventProcessorService.getRecordId(transactionMetadata.employerProfileId) ||
      ProviderEventProcessorService.getRecordId(fundingResult.employerProfileId) ||
      ProviderEventProcessorService.getRecordId(shift?.business) ||
      ProviderEventProcessorService.getRecordId(payload.employerProfileId) ||
      ProviderEventProcessorService.getRecordId(providerEvent.employer);

    if (isOvertimeTopUp) {
      const overtimeFundingIntegrityConflict =
        transactionMetadata.overtimeFundingIntegrityConflict === true;

      if (overtimeFundingIntegrityConflict) {
        throw ProviderEventProcessorService.createProcessingError({
          message:
            "Paystack overtime top-up is protected in escrow but has a funding integrity conflict.",
          code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
          statusCode: 409,
          retryable: false,
          details: {
            shiftId: String(shiftId),
            fundingTransactionId: String(fundingTransactionId),
            reason: transactionMetadata.overtimeFundingIntegrityReason || null,
          },
        });
      }

      const overtimeTopUpApplied = transactionMetadata.appliedToOvertimeTopUp === true;

      if (!overtimeTopUpApplied) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Paystack overtime top-up finalization did not reach a durable applied state.",
          code: "SHIFT_OVERTIME_TOPUP_FINALIZATION_INCOMPLETE",
          statusCode: 409,
          retryable: true,
          details: {
            shiftId: String(shiftId),
            fundingTransactionId: String(fundingTransactionId),
          },
        });
      }

      const occurrence = fundingResult.occurrence || null;

      const occurrenceId =
        ProviderEventProcessorService.getRecordId(occurrence) ||
        ProviderEventProcessorService.getRecordId(fundingResult.occurrenceId) ||
        ProviderEventProcessorService.getRecordId(fundingTransactionRecord.shiftOccurrence);

      if (!occurrenceId) {
        throw ProviderEventProcessorService.createProcessingError({
          message:
            "Overtime occurrence could not be identified after Paystack top-up finalization.",
          code: "SHIFT_OVERTIME_OCCURRENCE_ID_UNRESOLVED",
          statusCode: 500,
          retryable: true,
          details: {
            shiftId: String(shiftId),
            fundingTransactionId: String(fundingTransactionId),
          },
        });
      }

      const processedResult = await ProviderEventService.markProcessed(
        {
          providerEventRecordId: providerEvent._id,
          processingClaimId,
          transaction: fundingTransactionId,
          wallet: escrowWalletId,
          employer: employerProfileId,
          shift: shiftId,
          normalizedPayload: {
            ...payload,
            providerReference: reference,
            paystackReference: reference,
            providerEventId,
            employerProfileId: employerProfileId ? String(employerProfileId) : null,
            shiftId: String(shiftId),
            shiftReferenceCode:
              ProviderEventProcessorService.cleanString(shift?.referenceCode) ||
              ProviderEventProcessorService.cleanString(payload.shiftReferenceCode),
            occurrenceId: String(occurrenceId),
            occurrenceReferenceCode:
              ProviderEventProcessorService.cleanString(occurrence?.referenceCode) ||
              ProviderEventProcessorService.cleanString(payload.occurrenceReferenceCode),
            fundingPurpose: "shift_overtime_topup",
            fundingTransactionId: String(fundingTransactionId),
            escrowWalletId: escrowWalletId ? String(escrowWalletId) : null,
            overtimeTopUpApplied: true,
          },
          metadata: {
            processor: "ProviderEventProcessorService",
            shiftCheckoutFinalized: true,
            fundingPurpose: "shift_overtime_topup",
            overtimeTopUpApplied: true,
            occurrenceId: String(occurrenceId),
            fundingTransactionId: String(fundingTransactionId),
            escrowWalletId: escrowWalletId ? String(escrowWalletId) : null,
          },
          currentTime,
        },
        options
      );

      return {
        providerEvent: processedResult.providerEvent,
        shift,
        occurrence,
        transaction: fundingTransactionRecord,
        processed: true,
        fundingPurpose: "shift_overtime_topup",
        overtimeTopUpApplied: true,
      };
    }

    const fundingApplied = Boolean(
      fundingResult.fundingApplied === true || transactionMetadata.appliedToShift === true
    );

    const returnedToEmployerWallet = Boolean(
      fundingResult.returnedToEmployerWallet === true ||
      transactionMetadata.returnedToEmployerWallet === true
    );

    if (fundingApplied && returnedToEmployerWallet) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Shift funding transaction cannot be both applied to the Shift and returned to the employer wallet.",
        code: "SHIFT_FUNDING_TERMINAL_STATE_CONFLICT",
        statusCode: 409,
        retryable: false,
        details: {
          shiftId: String(shiftId),
          fundingTransactionId: String(fundingTransactionId),
        },
      });
    }

    const fundingApplicationPending = Boolean(
      fundingResult.fundingApplicationPending === true ||
      transactionMetadata.fundingApplicationPending === true ||
      fundingResult.reconciliationRequired === true ||
      transactionMetadata.reconciliationRequired === true
    );

    if (!fundingApplied && !returnedToEmployerWallet) {
      throw ProviderEventProcessorService.createProcessingError({
        message: fundingApplicationPending
          ? "Paystack credited escrow, but BASE Shift funding application is still pending recovery."
          : "Paystack BASE Shift funding finalization did not reach an applied or returned terminal state.",
        code: fundingApplicationPending
          ? "SHIFT_FUNDING_APPLICATION_PENDING"
          : "SHIFT_FUNDING_FINALIZATION_INCOMPLETE",
        statusCode: 409,
        retryable: true,
        details: {
          shiftId: String(shiftId),
          fundingTransactionId: String(fundingTransactionId),
          fundingApplicationPending,
          reconciliationRequired: Boolean(
            fundingResult.reconciliationRequired === true ||
            transactionMetadata.reconciliationRequired === true
          ),
        },
      });
    }

    const returnReason = returnedToEmployerWallet
      ? ProviderEventProcessorService.cleanString(
          fundingResult.returnReason || transactionMetadata.returnReason
        )
      : null;

    if (returnedToEmployerWallet && !returnReason) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Returned Shift funding is missing its persisted return reason.",
        code: "SHIFT_FUNDING_RETURN_REASON_MISSING",
        statusCode: 409,
        retryable: false,
        details: {
          shiftId: String(shiftId),
          fundingTransactionId: String(fundingTransactionId),
        },
      });
    }

    const alreadyFunded =
      fundingApplied &&
      Boolean(
        fundingResult.alreadyFunded ||
        fundingResult.idempotent ||
        fundingResult.idempotentFunding ||
        fundingResult.alreadyCompleted
      );

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        transaction: fundingTransactionId,
        wallet: escrowWalletId,
        employer: employerProfileId,
        shift: shiftId,
        normalizedPayload: {
          ...payload,
          providerReference: reference,
          paystackReference: reference,
          providerEventId,
          employerProfileId: employerProfileId ? String(employerProfileId) : null,
          shiftId: String(shiftId),
          shiftReferenceCode:
            ProviderEventProcessorService.cleanString(shift?.referenceCode) ||
            ProviderEventProcessorService.cleanString(payload.shiftReferenceCode),
          fundingPurpose: "shift_base_funding",
          fundingTransactionId: String(fundingTransactionId),
          escrowWalletId: escrowWalletId ? String(escrowWalletId) : null,
          fundingApplied,
          returnedToEmployerWallet,
          returnReason,
          fundingApplicationPending: false,
        },
        metadata: {
          processor: "ProviderEventProcessorService",
          shiftCheckoutFinalized: true,
          fundingPurpose: "shift_base_funding",
          fundingApplied,
          returnedToEmployerWallet,
          returnReason,
          fundingApplicationPending: false,
          idempotentShiftFunding: alreadyFunded,
          fundingTransactionId: String(fundingTransactionId),
          escrowWalletId: escrowWalletId ? String(escrowWalletId) : null,
        },
        currentTime,
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      shift,
      transaction: fundingTransactionRecord,
      processed: true,
      fundingPurpose: "shift_base_funding",
      fundingApplied,
      returnedToEmployerWallet,
      returnReason,
      fundingApplicationPending: false,
      alreadyFunded,
      idempotentShiftFunding: alreadyFunded,
    };
  }

  /* ─────────────────────────────── PAYG JOB PUBLICATION PAYMENT ─────────────────────────────── */

  static async completeHistoricalCommercialEvent(providerEvent, processingClaimId, paymentResult, currentTime) {
    const obligation = paymentResult.financialObligation;

    if (!obligation?._id || paymentResult.paid !== false ||
        obligation.type !== "historical_commercial_payment") {
      throw new Error("Invalid historical commercial payment disposition.");
    }

    const result = await ProviderEventService.runWithOptionalTransaction({}, async (session) =>
      ProviderEventService.markProcessed({
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        financialObligation: obligation._id,
        transaction: obligation.commercialTransaction,
        employer: obligation.employer,
        wallet: obligation.wallet,
        metadata: {
          processor: "ProviderEventProcessorService",
          idempotentFinancialObligation: paymentResult.idempotent === true,
        },
        currentTime,
      }, { session })
    );

    return {
      providerEvent: result.providerEvent,
      payment: paymentResult.payment,
      transaction: paymentResult.paymentTransaction,
      financialObligation: obligation,
      historicalFinancialObligation: true,
      reconciliationRequired: obligation.status !== "settled",
      processed: true,
      paid: false,
    };
  }

  static async processJobPublicationPaymentEvent(providerEvent, processingClaimId, options = {}) {
    ProviderEventProcessorService.assertIndependentFinalization(options);
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const reference = ProviderEventProcessorService.getCheckoutPaymentReference(providerEvent);

    const providerEventId = ProviderEventProcessorService.cleanString(
      payload.providerEventId || providerEvent.providerEventId
    );

    if (!reference) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack reference is required to process a PAYG Job publication payment.",
        code: "JOB_PUBLICATION_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
        statusCode: 422,
        retryable: false,
      });
    }

    const paymentResult = await JobPublicationPaymentService.finalizePaystackPayment({
      reference,
      providerEventId,
      providerEventRecordId: providerEvent._id,
      currentTime,
    });

    if (paymentResult?.financialObligation) {
      return ProviderEventProcessorService.completeHistoricalCommercialEvent(
        providerEvent, processingClaimId, paymentResult, currentTime
      );
    }

    if (paymentResult?.paid !== true || !paymentResult?.payment?._id) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "PAYG Job publication Paystack finalization did not reach a durable paid state.",
        code: "JOB_PUBLICATION_PAYMENT_FINALIZATION_INCOMPLETE",
        statusCode: 409,
        retryable: true,
        details: {
          reference,
          paymentId: paymentResult?.payment?._id ? String(paymentResult.payment._id) : null,
        },
      });
    }

    const payment = paymentResult.payment;

    const paymentTransactionId =
      ProviderEventProcessorService.getRecordId(paymentResult.paymentTransaction) ||
      ProviderEventProcessorService.getRecordId(payment.paymentTransaction);

    if (!paymentTransactionId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paid PAYG Job publication payment has no canonical platform receipt Transaction.",
        code: "JOB_PUBLICATION_PAYMENT_TRANSACTION_UNRESOLVED",
        statusCode: 500,
        retryable: true,
        details: {
          paymentId: String(payment._id),
          reference,
        },
      });
    }

    const paymentTransaction = await Transaction.findById(paymentTransactionId);

    if (!paymentTransaction) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "PAYG Job publication platform receipt Transaction was not found after Paystack finalization.",
        code: "JOB_PUBLICATION_PAYMENT_TRANSACTION_NOT_FOUND_AFTER_FINALIZATION",
        statusCode: 404,
        retryable: true,
        details: {
          paymentId: String(payment._id),
          paymentTransactionId: String(paymentTransactionId),
          reference,
        },
      });
    }

    const employerProfileId =
      ProviderEventProcessorService.getRecordId(payment.business) ||
      ProviderEventProcessorService.getRecordId(paymentTransaction.metadata?.employerProfileId) ||
      ProviderEventProcessorService.getRecordId(payload.employerProfileId) ||
      ProviderEventProcessorService.getRecordId(providerEvent.employer);

    if (!employerProfileId) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Employer profile could not be resolved after PAYG Job publication payment finalization.",
        code: "JOB_PUBLICATION_PAYMENT_EMPLOYER_UNRESOLVED",
        statusCode: 500,
        retryable: true,
        details: {
          paymentId: String(payment._id),
          paymentTransactionId: String(paymentTransactionId),
        },
      });
    }

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        transaction: paymentTransaction._id,
        wallet: paymentTransaction.wallet || null,
        employer: employerProfileId,
        normalizedPayload: {
          ...payload,
          providerReference: reference,
          paystackReference: reference,
          providerEventId,
          employerProfileId: String(employerProfileId),
          jobPaymentId: String(payment._id),
          purchaseReference: payment.purchaseReference || null,
          jobPostingPlanId: payment.plan ? String(payment.plan) : null,
          paymentTransactionId: String(paymentTransaction._id),
          paymentStatus: payment.paymentStatus,
          paymentMethod: payment.paymentMethod,
          paymentFinalized: true,
        },
        metadata: {
          processor: "ProviderEventProcessorService",
          jobPublicationPaymentFinalized: true,
          jobPaymentId: String(payment._id),
          purchaseReference: payment.purchaseReference || null,
          paymentTransactionId: String(paymentTransaction._id),
          idempotentPaymentFinalization: paymentResult.idempotent === true,
        },
        currentTime,
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      payment,
      transaction: paymentTransaction,
      processed: true,
      paid: true,
      idempotentPaymentFinalization: paymentResult.idempotent === true,
    };
  }

  /* ─────────────────────────────── SUBSCRIPTION PAYMENT ─────────────────────────────── */

  static async processSubscriptionPaymentEvent(providerEvent, processingClaimId, options = {}) {
    if (options.session) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Subscription event processing must own its claim and completion transactions.",
        code: "SUBSCRIPTION_EVENT_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }
    // Direct internal callers must also supply a verified, currently claimed event.
    if (providerEvent.isVerified !== true) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Unverified subscription event cannot be processed.",
        code: "SUBSCRIPTION_EVENT_NOT_VERIFIED",
        statusCode: 422,
        retryable: false,
      });
    }
    ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const reference = ProviderEventProcessorService.getCheckoutPaymentReference(providerEvent);

    const providerEventId = ProviderEventProcessorService.cleanString(
      payload.providerEventId || providerEvent.providerEventId
    );

    if (!reference) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack reference is required to process a subscription payment.",
        code: "SUBSCRIPTION_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
        statusCode: 422,
        retryable: false,
      });
    }

    const paymentResult = await SubscriptionPaymentService.finalizePaystackPayment({
      reference,
      providerEventId,
      providerEventRecordId: providerEvent._id,
      currentTime,
    });

    if (paymentResult?.financialObligation) {
      return ProviderEventProcessorService.completeHistoricalCommercialEvent(
        providerEvent, processingClaimId, paymentResult, currentTime
      );
    }

    if (paymentResult?.paid !== true || !paymentResult?.payment?._id) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Subscription Paystack finalization did not reach a durable paid state.",
        code: "SUBSCRIPTION_PAYMENT_FINALIZATION_INCOMPLETE",
        statusCode: 409,
        retryable: true,
        details: {
          reference,
          paymentId: paymentResult?.payment?._id ? String(paymentResult.payment._id) : null,
        },
      });
    }

    const payment = paymentResult.payment;

    const paymentKind = ProviderEventProcessorService.cleanString(payment.paymentKind);

    if (!["initial_purchase", "plan_change", "renewal"].includes(paymentKind)) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paid subscription payment contains an unsupported payment kind.",
        code: "UNSUPPORTED_SUBSCRIPTION_PAYMENT_KIND",
        statusCode: 409,
        retryable: false,
        details: {
          paymentId: String(payment._id),
          paymentKind,
        },
      });
    }

    if (paymentResult.applicationError) {
      const applicationErrorCode = ProviderEventProcessorService.cleanString(
        paymentResult.applicationError.code
      );

      const reconciliationRequired =
        NON_RETRYABLE_SUBSCRIPTION_APPLICATION_CODES.includes(applicationErrorCode);

      throw ProviderEventProcessorService.createProcessingError({
        message:
          paymentResult.applicationError.message ||
          "Subscription payment was captured but its lifecycle application is unresolved.",
        code: applicationErrorCode || "SUBSCRIPTION_PAYMENT_APPLICATION_PENDING",
        statusCode: Number.isInteger(Number(paymentResult.applicationError.statusCode))
          ? Number(paymentResult.applicationError.statusCode)
          : 409,
        retryable: !reconciliationRequired,
        details: {
          paymentCaptured: true,
          reconciliationRequired,
          paymentId: String(payment._id),
          paymentKind,
          reference,
          applicationErrorCode,
        },
      });
    }

    const applicationReason = ProviderEventProcessorService.cleanString(
      paymentResult.application?.reason
    );

    const applied = Boolean(
      paymentResult.applied === true ||
      payment.appliedAt ||
      applicationReason === "already_applied" ||
      applicationReason === "lifecycle_already_advanced"
    );

    if (["initial_purchase", "plan_change"].includes(paymentKind) && !applied) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Immediate subscription payment was captured but its subscription lifecycle change has not been applied.",
        code: "SUBSCRIPTION_IMMEDIATE_PAYMENT_APPLICATION_PENDING",
        statusCode: 409,
        retryable: true,
        details: {
          paymentCaptured: true,
          paymentId: String(payment._id),
          paymentKind,
          reference,
          applicationReason,
        },
      });
    }

    const renewalScheduled =
      paymentKind === "renewal" && !applied && applicationReason === "billing_period_not_started";

    if (paymentKind === "renewal" && !applied && !renewalScheduled) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paid subscription renewal has not reached an applied or safely scheduled state.",
        code: "SUBSCRIPTION_RENEWAL_APPLICATION_PENDING",
        statusCode: 409,
        retryable: true,
        details: {
          paymentCaptured: true,
          paymentId: String(payment._id),
          paymentKind,
          reference,
          applicationReason,
        },
      });
    }

    const paymentTransactionId =
      ProviderEventProcessorService.getRecordId(paymentResult.paymentTransaction) ||
      ProviderEventProcessorService.getRecordId(payment.paymentTransaction);

    if (!paymentTransactionId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paid subscription payment has no canonical platform receipt Transaction.",
        code: "SUBSCRIPTION_PAYMENT_TRANSACTION_UNRESOLVED",
        statusCode: 500,
        retryable: true,
        details: {
          paymentId: String(payment._id),
          paymentKind,
          reference,
        },
      });
    }

    const paymentTransaction = await Transaction.findById(paymentTransactionId);

    if (!paymentTransaction) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Subscription platform receipt Transaction was not found after Paystack finalization.",
        code: "SUBSCRIPTION_PAYMENT_TRANSACTION_NOT_FOUND_AFTER_FINALIZATION",
        statusCode: 404,
        retryable: true,
        details: {
          paymentId: String(payment._id),
          paymentKind,
          paymentTransactionId: String(paymentTransactionId),
          reference,
        },
      });
    }

    const receiptWallet = await Wallet.findById(paymentTransaction.wallet);
    const canonicalReceiptId = ProviderEventProcessorService.getRecordId(
      payment.paymentTransaction
    );
    const employerProfileId = ProviderEventProcessorService.getRecordId(payment.business);
    const snapshot = payment.planSnapshot;

    if (
      payment.paymentStatus !== "paid" ||
      payment.paymentProvider !== "paystack" ||
      !["paystack_checkout", "paystack_authorization"].includes(payment.paymentMethod) ||
      payment.providerReference !== reference ||
      !canonicalReceiptId ||
      String(canonicalReceiptId) !== String(paymentTransaction._id) ||
      paymentTransaction.status !== "completed" ||
      paymentTransaction.direction !== "credit" ||
      paymentTransaction.provider !== "paystack" ||
      paymentTransaction.paymentRail !== "paystack_checkout" ||
      paymentTransaction.type !== "subscription_payment" ||
      paymentTransaction.purpose !== "subscription_payment" ||
      paymentTransaction.paystackReference !== reference ||
      !snapshot ||
      !Number.isSafeInteger(snapshot.priceMinor) ||
      snapshot.priceMinor <= 0 ||
      paymentTransaction.amount !== snapshot.priceMinor ||
      paymentTransaction.countryCode !== snapshot.countryCode ||
      paymentTransaction.currency !== snapshot.currency ||
      !receiptWallet ||
      receiptWallet.ownerType !== "platform" ||
      String(receiptWallet._id) !== String(paymentTransaction.wallet) ||
      receiptWallet.countryCode !== snapshot.countryCode ||
      receiptWallet.currency !== snapshot.currency ||
      !employerProfileId
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paid subscription does not match its completed platform receipt.",
        code: "SUBSCRIPTION_EVENT_RECEIPT_MISMATCH",
        statusCode: 409,
        retryable: false,
        details: {
          paymentCaptured: true,
          reconciliationRequired: true,
          paymentId: String(payment._id),
          paymentTransactionId: String(paymentTransaction._id),
        },
      });
    }

    for (const [field, expected] of Object.entries({
      subscriptionPaymentId: payment._id,
      subscriptionId: payment.subscription,
      employerProfileId,
    })) {
      const recorded = paymentTransaction.metadata?.[field];
      if (recorded != null && String(recorded) !== String(expected)) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Subscription receipt metadata does not match its payment.",
          code: "SUBSCRIPTION_EVENT_RECEIPT_MISMATCH",
          statusCode: 409,
          retryable: false,
          details: { paymentCaptured: true, reconciliationRequired: true, field },
        });
      }
    }

    if (!employerProfileId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Employer profile could not be resolved after subscription payment finalization.",
        code: "SUBSCRIPTION_PAYMENT_EMPLOYER_UNRESOLVED",
        statusCode: 500,
        retryable: true,
        details: {
          paymentId: String(payment._id),
          paymentKind,
          paymentTransactionId: String(paymentTransactionId),
        },
      });
    }

    const applicationState = applied ? "applied" : renewalScheduled ? "scheduled" : "pending";

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        transaction: paymentTransaction._id,
        wallet: paymentTransaction.wallet || null,
        employer: employerProfileId,
        normalizedPayload: {
          ...payload,
          providerReference: reference,
          paystackReference: reference,
          providerEventId,
          employerProfileId: String(employerProfileId),
          subscriptionPaymentId: String(payment._id),
          subscriptionId: payment.subscription ? String(payment.subscription) : null,
          subscriptionPlanId: payment.plan ? String(payment.plan) : null,
          paymentReference: payment.paymentReference || null,
          paymentKind,
          paymentStatus: payment.paymentStatus,
          paymentMethod: payment.paymentMethod,
          paymentTransactionId: String(paymentTransaction._id),
          applicationState,
          applicationReason,
          applied,
          renewalScheduled,
        },
        metadata: {
          processor: "ProviderEventProcessorService",
          subscriptionPaymentFinalized: true,
          subscriptionPaymentId: String(payment._id),
          subscriptionId: payment.subscription ? String(payment.subscription) : null,
          paymentReference: payment.paymentReference || null,
          paymentKind,
          paymentTransactionId: String(paymentTransaction._id),
          subscriptionApplicationState: applicationState,
          subscriptionApplicationReason: applicationReason,
          idempotentPaymentFinalization: paymentResult.idempotent === true,
        },
        currentTime,
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      payment,
      transaction: paymentTransaction,
      processed: true,
      paid: true,
      applied,
      renewalScheduled,
      applicationState,
      idempotentPaymentFinalization: paymentResult.idempotent === true,
    };
  }

  static async verifyDVAFundingPayment(providerEvent) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    if (
      providerEvent.provider !== "paystack" ||
      providerEvent.eventName !== "charge.success" ||
      providerEvent.eventCategory !== "employer_wallet_funding" ||
      providerEvent.isVerified !== true ||
      providerEvent.countryCode !== "NG" ||
      providerEvent.currency !== "NGN"
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Invalid Paystack DVA funding event.",
        code: "INVALID_PAYSTACK_DVA_FUNDING_EVENT",
        statusCode: 409,
        retryable: false,
      });
    }

    const conflicts = payload.dvaFundingIdentityConflicts;

    if (conflicts != null && (!Array.isArray(conflicts) || conflicts.length)) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding contains unresolved identity conflicts.",
        code: "DVA_FUNDING_IDENTITY_CONFLICT",
        statusCode: 409,
        retryable: false,
      });
    }

    const reference = ProviderEventProcessorService.cleanString(providerEvent.providerReference);

    if (
      !reference ||
      [payload.providerReference, payload.paystackReference].some(
        (value) => value != null && value !== reference
      )
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding requires one consistent payment reference.",
        code: "DVA_FUNDING_REFERENCE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const signedPayload = providerEvent.rawPayload;

    if (
      !signedPayload ||
      signedPayload.event !== "charge.success" ||
      signedPayload.data?.reference !== reference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Original DVA funding evidence does not match the event.",
        code: "DVA_FUNDING_RAW_EVIDENCE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const original = PaystackEventNormalizerService.getDVAFundingDetails(signedPayload);

    if (!original || original.identityConflicts.length) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Original DVA payment identity could not be established.",
        code: "DVA_FUNDING_ORIGINAL_IDENTITY_INVALID",
        statusCode: 409,
        retryable: false,
      });
    }

    const verified = await PaystackService.verifyTransaction(reference);

    if (verified.status !== "success") {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack has not confirmed successful DVA funding.",
        code: "DVA_FUNDING_PROVIDER_SUCCESS_UNCONFIRMED",
        statusCode: 503,
        retryable: true,
      });
    }

    const mode = PaystackService.getMode();

    if (
      !["test", "live"].includes(mode) ||
      verified.domain !== mode ||
      (payload.domain && payload.domain !== mode)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA payment belongs to a different Paystack environment.",
        code: "DVA_FUNDING_PROVIDER_MODE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    if (
      verified.reference !== reference ||
      verified.currency !== providerEvent.currency ||
      verified.amount !== providerEvent.amount
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Verified Paystack payment does not match the recorded event.",
        code: "DVA_FUNDING_PROVIDER_PAYMENT_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const verifiedPayload = {
      event: "charge.success",
      data: verified.raw,
    };

    if (!PaystackEventNormalizerService.hasDedicatedNubanChannel(verifiedPayload)) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Verified payment is not a confirmed DVA payment.",
        code: "DVA_FUNDING_PROVIDER_CHANNEL_UNCONFIRMED",
        statusCode: 503,
        retryable: true,
      });
    }

    const confirmed = PaystackEventNormalizerService.getDVAFundingDetails(verifiedPayload);

    if (!confirmed || confirmed.identityConflicts.length) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Verified DVA payment contains incomplete or conflicting evidence.",
        code: "DVA_FUNDING_VERIFIED_IDENTITY_INVALID",
        statusCode: 409,
        retryable: false,
      });
    }

    if (
      !original.paystackTransactionId ||
      !verified.id ||
      String(original.paystackTransactionId) !== String(verified.id)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack payment transaction IDs do not match.",
        code: "DVA_FUNDING_PROVIDER_TRANSACTION_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const identity = {};

    const fields = [
      "paystackCustomerId",
      "paystackCustomerCode",
      "paystackDedicatedAccountId",
      "accountNumber",
      "bankId",
      "bankCode",
      "bankSlug",
      "providerSlug",
    ];

    // Combine compatible provider evidence without replacing conflicts.
    for (const field of fields) {
      const recorded = payload[field];
      const received = original[field];
      const verifiedValue = confirmed[field];

      const values = [recorded, received, verifiedValue]
        .filter((value) => value != null)
        .map(String);

      if (new Set(values).size > 1) {
        throw ProviderEventProcessorService.createProcessingError({
          message: `DVA funding contains conflicting ${field}.`,
          code: "DVA_FUNDING_PROVIDER_IDENTITY_MISMATCH",
          statusCode: 409,
          retryable: false,
        });
      }

      identity[field] = verifiedValue ?? received ?? null;
    }

    const confirmedCustomer =
      (original.paystackCustomerId != null &&
        confirmed.paystackCustomerId != null &&
        String(original.paystackCustomerId) === String(confirmed.paystackCustomerId)) ||
      (original.paystackCustomerCode &&
        confirmed.paystackCustomerCode &&
        original.paystackCustomerCode === confirmed.paystackCustomerCode);

    if (!confirmedCustomer) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "The original Paystack customer could not be confirmed.",
        code: "DVA_FUNDING_PROVIDER_CUSTOMER_UNCONFIRMED",
        statusCode: 503,
        retryable: true,
      });
    }

    if (!original.accountNumber && !original.paystackDedicatedAccountId) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding contains no original receiving account identity.",
        code: "DVA_FUNDING_DESTINATION_REQUIRED",
        statusCode: 503,
        retryable: true,
      });
    }

    const providerFee = ProviderEventProcessorService.normalizeOptionalMinorUnitAmount(
      verified.fees,
      "verified DVA funding fee"
    );

    if (providerFee === null || providerFee > verified.amount) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Paystack DVA funding fees could not be confirmed.",
        code: "DVA_FUNDING_PROVIDER_FEE_UNCONFIRMED",
        statusCode: 503,
        retryable: true,
      });
    }

    const netAmount = verified.amount - providerFee;

    if (
      (providerEvent.providerFee != null && providerEvent.providerFee !== providerFee) ||
      (providerEvent.netAmount != null && providerEvent.netAmount !== netAmount)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Verified DVA funding fees do not match the recorded event.",
        code: "DVA_FUNDING_PROVIDER_FEE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    return {
      providerReference: reference,
      paystackTransactionId: String(verified.id),
      countryCode: providerEvent.countryCode,
      currency: verified.currency,
      amount: verified.amount,
      providerFee,
      netAmount,
      mode,
      identity,
    };
  }

  static async resolveDVAFundingRouting(providerEvent, payment, options = {}) {
    const identity = payment.identity || {};

    const hasCustomerIdentity = Boolean(
      identity.paystackCustomerId || identity.paystackCustomerCode
    );

    const hasReceivingAccountIdentity = Boolean(
      identity.paystackDedicatedAccountId ||
      (identity.accountNumber &&
        (identity.bankId || identity.bankCode || identity.bankSlug || identity.providerSlug))
    );

    if (!hasCustomerIdentity || !hasReceivingAccountIdentity) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding requires confirmed customer and receiving account identity.",
        code: "DVA_FUNDING_ROUTING_IDENTITY_INCOMPLETE",
        statusCode: 503,
        retryable: true,
      });
    }

    const conditions = [];

    const addNumericIdentity = (field, value) => {
      if (value == null) return;

      const normalized = Number(value);

      if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw ProviderEventProcessorService.createProcessingError({
          message: `Invalid DVA funding ${field}.`,
          code: "INVALID_DVA_FUNDING_PROVIDER_IDENTITY",
          statusCode: 409,
          retryable: false,
        });
      }

      conditions.push({
        [field]: normalized,
      });
    };

    addNumericIdentity("paystackDedicatedAccountId", identity.paystackDedicatedAccountId);

    addNumericIdentity("paystackCustomerId", identity.paystackCustomerId);

    if (identity.paystackCustomerCode) {
      conditions.push({
        paystackCustomerCode: identity.paystackCustomerCode,
      });
    }

    if (identity.accountNumber) {
      const accountIdentity = {
        accountNumber: identity.accountNumber,
      };

      let hasBankIdentity = false;

      for (const field of ["bankId", "bankCode", "bankSlug", "providerSlug"]) {
        if (identity[field] != null && identity[field] !== "") {
          accountIdentity[field] = identity[field];
          hasBankIdentity = true;
        }
      }

      if (hasBankIdentity) {
        conditions.push(accountIdentity);
      }
    }

    if (!conditions.length) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding requires provider account identity.",
        code: "DVA_FUNDING_ROUTING_IDENTITY_REQUIRED",
        statusCode: 503,
        retryable: true,
      });
    }

    // Search all DVA generations, including retired accounts.
    const query = DVA.find({
      provider: "paystack",
      countryCode: payment.countryCode,
      currency: payment.currency,
      $or: conditions,
    }).limit(2);

    if (options.session) {
      query.session(options.session);
    }

    const matches = await query;

    if (!matches.length) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "No historical DVA matches the verified payment.",
        code: "DVA_FUNDING_HISTORICAL_ACCOUNT_NOT_FOUND",
        statusCode: 503,
        retryable: true,
      });
    }

    if (matches.length !== 1) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding matches multiple historical accounts.",
        code: "DVA_FUNDING_HISTORICAL_ACCOUNT_AMBIGUOUS",
        statusCode: 409,
        retryable: false,
      });
    }

    const dva = matches[0];

    if (dva.metadata?.assignmentMode !== payment.mode) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Historical DVA belongs to a different provider environment.",
        code: "DVA_FUNDING_ACCOUNT_MODE_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    // All available provider identifiers must match the same DVA.
    for (const field of [
      "paystackDedicatedAccountId",
      "paystackCustomerId",
      "paystackCustomerCode",
      "accountNumber",
      "bankId",
      "bankCode",
      "bankSlug",
      "providerSlug",
    ]) {
      if (
        identity[field] != null &&
        (dva[field] == null || String(dva[field]) !== String(identity[field]))
      ) {
        throw ProviderEventProcessorService.createProcessingError({
          message: `Historical DVA ${field} does not match the payment.`,
          code: "DVA_FUNDING_HISTORICAL_IDENTITY_MISMATCH",
          statusCode: 409,
          retryable: false,
        });
      }
    }

    if (!dva.employer || !dva.wallet || !dva.ownerUser) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Historical DVA contains incomplete ownership.",
        code: "DVA_FUNDING_HISTORICAL_OWNERSHIP_INCOMPLETE",
        statusCode: 409,
        retryable: false,
      });
    }

    const walletQuery = Wallet.findById(dva.wallet);

    if (options.session) {
      walletQuery.session(options.session);
    }

    const wallet = await walletQuery;

    if (
      !wallet ||
      wallet.ownerType !== "employer" ||
      !wallet.employer ||
      wallet.professional ||
      String(wallet.employer) !== String(dva.employer) ||
      wallet.countryCode !== dva.countryCode ||
      wallet.currency !== dva.currency
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Historical DVA does not match its original wallet.",
        code: "DVA_FUNDING_HISTORICAL_WALLET_MISMATCH",
        statusCode: 409,
        retryable: false,
      });
    }

    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    // Previously established ownership must remain unchanged.
    for (const [actual, expected] of [
      [providerEvent.employer, dva.employer],
      [providerEvent.wallet, wallet._id],
      [providerEvent.dva, dva._id],
      [payload.employerProfileId, dva.employer],
      [payload.walletId, wallet._id],
      [payload.dvaId, dva._id],
    ]) {
      if (actual != null && String(actual) !== String(expected)) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "DVA funding conflicts with previously resolved ownership.",
          code: "DVA_FUNDING_EXISTING_OWNERSHIP_MISMATCH",
          statusCode: 409,
          retryable: false,
        });
      }
    }

    return {
      dva,
      wallet,

      routing: {
        employer: dva.employer,
        wallet: wallet._id,
        dva: dva._id,
        providerReference: payment.providerReference,
      },
    };
  }

  /* ─────────────────────────────── EMPLOYER WALLET FUNDING ─────────────────────────────── */

  static async processEmployerWalletFundingEvent(providerEvent, processingClaimId, options = {}) {
    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    if (options.session) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "DVA funding must own its verification and financial transactions.",
        code: "DVA_FUNDING_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }

    // Verify externally before opening the financial transaction.

    const payment = await ProviderEventProcessorService.verifyDVAFundingPayment(providerEvent);

    const { routing } = await ProviderEventProcessorService.resolveDVAFundingRouting(
      providerEvent,
      payment
    );

    // Preserve historical ownership independently.

    const linkedEvent = await ProviderEventService.linkDVAFundingRouting({
      providerEventRecordId: providerEvent._id,
      processingClaimId,
      routing,
    });

    return ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      const currentEvent = await ProviderEventService.getProviderEventById(linkedEvent._id, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(currentEvent, processingClaimId);

      const { dva, wallet } = await ProviderEventProcessorService.resolveDVAFundingRouting(
        currentEvent,
        payment,
        { session }
      );

      const fundingKey = WalletFundingService.buildFundingIdempotencyKey({
        provider: "paystack",
        providerReference: payment.providerReference,
      });

      const existingFunding = await Transaction.findOne({
        idempotencyKey: fundingKey,
      }).session(session);

      const retiredDVA =
        ["retiring", "deactivated"].includes(dva.status) || Boolean(dva.retirementStartedAt);

      // Historical financial obligation

      if (retiredDVA && !existingFunding) {
        const obligationResult = await FinancialObligationService.recordRetiredDVAFunding(
          {
            providerEventRecordId: currentEvent._id,
            processingClaimId,
            payment,
            currentTime,
          },
          { session }
        );

        const obligation = obligationResult.obligation;

        if (!obligation?._id) {
          throw ProviderEventProcessorService.createProcessingError({
            message: "Historical DVA funding did not produce a financial obligation.",
            code: "DVA_FUNDING_OBLIGATION_RESULT_INCOMPLETE",
            statusCode: 500,
            retryable: true,
          });
        }

        const processedResult = await ProviderEventService.markProcessed(
          {
            providerEventRecordId: currentEvent._id,
            processingClaimId,

            financialObligation: obligation._id,
            employer: dva.employer,
            wallet: wallet._id,
            dva: dva._id,

            metadata: {
              processor: "ProviderEventProcessorService",
              historicalFinancialObligation: true,
              financialObligationType: obligation.type,
              financialObligationId: String(obligation._id),
              idempotentFinancialObligation: obligationResult.idempotent === true,
            },

            currentTime,
          },
          { session }
        );

        return {
          providerEvent: processedResult.providerEvent,
          wallet,
          transaction: null,
          financialObligation: obligation,
          processed: true,
          historicalFinancialObligation: true,
          idempotentFinancialObligation: obligationResult.idempotent === true,
        };
      }

      // Normal funding or completed replay

      if (currentEvent.providerFee == null || currentEvent.netAmount == null) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "DVA payment requires reconciliation of recorded provider fees.",
          code: "DVA_FUNDING_RECORDED_FEES_INCOMPLETE",
          statusCode: 409,
          retryable: false,
          details: {
            providerEventRecordId: String(currentEvent._id),
            providerReference: payment.providerReference,
            verifiedProviderFee: payment.providerFee,
            verifiedNetAmount: payment.netAmount,
          },
        });
      }

      const fundingResult = await WalletFundingService.creditEmployerWalletFromDvaFunding(
        {
          employerProfileId: dva.employer,
          dvaId: dva._id,

          amount: payment.amount,
          currency: payment.currency,

          provider: "paystack",
          providerReference: payment.providerReference,
          providerEventId: currentEvent.providerEventId,

          providerFee: payment.providerFee,
          netAmount: payment.netAmount,

          metadata: {
            providerEventRecordId: String(currentEvent._id),
            providerEventKey: currentEvent.eventKey,
            sourceEventName: currentEvent.eventName,
            paystackTransactionId: payment.paystackTransactionId,
            verifiedProviderMode: payment.mode,
          },
        },
        { session }
      );

      if (
        !fundingResult?.transaction?._id ||
        !fundingResult?.wallet?._id ||
        String(fundingResult.wallet._id) !== String(wallet._id)
      ) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "DVA funding did not return its original wallet and transaction.",
          code: "DVA_FUNDING_RESULT_INCOMPLETE",
          statusCode: 500,
          retryable: true,
        });
      }

      const processedResult = await ProviderEventService.markProcessed(
        {
          providerEventRecordId: currentEvent._id,
          processingClaimId,

          transaction: fundingResult.transaction._id,
          wallet: fundingResult.wallet._id,
          employer: dva.employer,
          dva: dva._id,

          metadata: {
            processor: "ProviderEventProcessorService",
            walletFundingTransactionId: String(fundingResult.transaction._id),
            idempotentWalletFunding: fundingResult.idempotent === true,
          },

          currentTime,
        },
        { session }
      );

      return {
        providerEvent: processedResult.providerEvent,
        wallet: fundingResult.wallet,
        transaction: fundingResult.transaction,
        processed: true,
        idempotentWalletFunding: fundingResult.idempotent === true,
      };
    });
  }

  /* ─────────────────────────────── WITHDRAWAL PAYOUT ─────────────────────────────── */

  static async processWithdrawalPayoutEvent(providerEvent, processingClaimId, options = {}) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const withdrawalTransaction =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
        providerEvent,
        options
      );

    const ownerContext = ProviderEventProcessorService.getWithdrawalOwnerContext({
      withdrawalTransaction,
      providerEvent,
    });

    ProviderEventProcessorService.assertWithdrawalCategoryMatchesOwner({
      providerEvent,
      ownerType: ownerContext.ownerType,
    });

    const paystackTransferCode =
      ProviderEventProcessorService.getPaystackTransferCode(providerEvent);

    const paystackTransferReference =
      ProviderEventProcessorService.getPaystackTransferReference(providerEvent);

    const completedResult = await WalletWithdrawalService.markWithdrawalCompleted(
      {
        withdrawalTransactionId: withdrawalTransaction._id,
        paystackTransferCode,
        providerEventId: providerEvent.providerEventId,
        currentTime,
        metadata: {
          providerEventRecordId: String(providerEvent._id),
          providerEventKey: providerEvent.eventKey,
          sourceEventName: providerEvent.eventName,
          providerReference: providerEvent.providerReference,
          providerEventId: providerEvent.providerEventId,
          paystackTransferReference,
          paystackTransferCode,
        },
      },
      options
    );

    const completedTransaction = completedResult.transaction;

    if (!["completed", "reversed"].includes(completedTransaction.status)) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Provider withdrawal success did not leave the withdrawal in completed terminal state.",
        code: "WITHDRAWAL_PROVIDER_PAYOUT_TERMINAL_STATE_INVALID",
        statusCode: 409,
        retryable: false,
        details: {
          withdrawalTransactionId: String(completedTransaction._id),
          status: completedTransaction.status,
        },
      });
    }

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        transaction: completedTransaction._id,
        wallet: completedResult.wallet?._id || completedTransaction.wallet,
        employer: ownerContext.employer,
        professional: ownerContext.professional,
        bankAccount: completedTransaction.bankAccount || providerEvent.bankAccount,
        normalizedPayload: {
          ...payload,
          withdrawalTransactionId: String(completedTransaction._id),
          paystackTransferReference:
            ProviderEventProcessorService.cleanString(
              completedTransaction.paystackTransferReference
            ) || paystackTransferReference,
          paystackTransferCode:
            ProviderEventProcessorService.cleanString(completedTransaction.paystackTransferCode) ||
            paystackTransferCode,
          withdrawalStatus: completedTransaction.status,
          ownerType: ownerContext.ownerType,
          employerProfileId: ownerContext.employerProfileId
            ? String(ownerContext.employerProfileId)
            : null,
          professionalProfileId: ownerContext.professionalProfileId
            ? String(ownerContext.professionalProfileId)
            : null,
        },
        metadata: {
          processor: "ProviderEventProcessorService",
          withdrawalCompleted: true,
          withdrawalTerminalStatus: completedTransaction.status,
          ownerType: ownerContext.ownerType,
          alreadyCompleted: Boolean(completedResult.alreadyCompleted),
        },
        currentTime,
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      wallet: completedResult.wallet || null,
      transaction: completedTransaction,
      processed: true,
      ownerType: ownerContext.ownerType,
      alreadyCompleted: Boolean(completedResult.alreadyCompleted),
    };
  }

  /* ─────────────────────────────── WITHDRAWAL REVERSAL ─────────────────────────────── */

  static async processWithdrawalReversalEvent(providerEvent, processingClaimId, options = {}) {
    if (options.session) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Withdrawal reversal must own its financial transaction.",
        code: "WITHDRAWAL_REVERSAL_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
        retryable: false,
      });
    }

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const withdrawal =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(providerEvent);

    const originalWallet = await Wallet.findById(withdrawal.wallet);

    if (!originalWallet) {
      throw ProviderEventProcessorService.createProcessingError({
        message: "Original withdrawal wallet was not found.",
        code: "WITHDRAWAL_REVERSAL_WALLET_NOT_FOUND",
        statusCode: 409,
        retryable: false,
      });
    }

    let verification = null;

    // External reversal verification

    if (originalWallet.status === "closed" && withdrawal.status === "completed") {
      if (providerEvent.eventName !== "transfer.reversed") {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Completed withdrawals require confirmed reversal evidence.",
          code: "WITHDRAWAL_REVERSAL_NOT_CONFIRMED",
          statusCode: 409,
          retryable: false,
        });
      }

      verification = await FinancialObligationService.verifyClosedWalletWithdrawalReversal({
        withdrawalTransactionId: withdrawal._id,
      });
    }

    // Atomic financial disposition

    return ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      const currentEvent = await ProviderEventService.getProviderEventById(providerEvent._id, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(currentEvent, processingClaimId);

      const currentWithdrawal =
        await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
          currentEvent,
          { session }
        );

      const wallet = await Wallet.findById(currentWithdrawal.wallet).session(session);

      if (!wallet) {
        throw ProviderEventProcessorService.createProcessingError({
          message: "Original withdrawal wallet was not found.",
          code: "WITHDRAWAL_REVERSAL_WALLET_NOT_FOUND",
          statusCode: 409,
          retryable: false,
        });
      }

      const ownerContext = ProviderEventProcessorService.getWithdrawalOwnerContext({
        withdrawalTransaction: currentWithdrawal,
        providerEvent: currentEvent,
      });

      ProviderEventProcessorService.assertWithdrawalCategoryMatchesOwner({
        providerEvent: currentEvent,
        ownerType: ownerContext.ownerType,
      });

      // Closed-wallet obligation

      if (wallet.status === "closed" && currentWithdrawal.status === "completed") {
        if (!verification) {
          throw ProviderEventProcessorService.createProcessingError({
            message: "Withdrawal requires renewed historical reversal verification.",
            code: "WITHDRAWAL_REVERSAL_VERIFICATION_REQUIRED",
            statusCode: 503,
            retryable: true,
          });
        }

        const obligationResult =
          await FinancialObligationService.recordClosedWalletWithdrawalReversal(
            {
              providerEventRecordId: currentEvent._id,
              processingClaimId,
              verification,
            },
            { session }
          );

        const obligation = obligationResult.obligation;

        if (!obligation?._id) {
          throw ProviderEventProcessorService.createProcessingError({
            message: "Closed-wallet reversal did not produce a financial obligation.",
            code: "WITHDRAWAL_REVERSAL_OBLIGATION_RESULT_INCOMPLETE",
            statusCode: 500,
            retryable: true,
          });
        }

        const processedResult = await ProviderEventService.markProcessed(
          {
            providerEventRecordId: currentEvent._id,
            processingClaimId,

            financialObligation: obligation._id,
            transaction: currentWithdrawal._id,

            wallet: wallet._id,
            employer: ownerContext.employer,
            professional: ownerContext.professional,
            bankAccount: currentWithdrawal.bankAccount,

            metadata: {
              processor: "ProviderEventProcessorService",
              historicalFinancialObligation: true,
              financialObligationType: obligation.type,
              financialObligationId: String(obligation._id),
              withdrawalReversalCredited: false,
              withdrawalReservationReleased: false,
              idempotentFinancialObligation: obligationResult.idempotent === true,
            },

            currentTime,
          },
          { session }
        );

        return {
          providerEvent: processedResult.providerEvent,
          wallet,
          transaction: null,
          originalTransaction: currentWithdrawal,
          financialObligation: obligation,
          processed: true,
          ownerType: ownerContext.ownerType,
          historicalFinancialObligation: true,
          idempotentFinancialObligation: obligationResult.idempotent === true,
        };
      }

      // Normal reversal or completed replay

      return ProviderEventProcessorService.processWalletWithdrawalReversalEvent(
        currentEvent,
        processingClaimId,
        {
          session,
          currentTime,
        }
      );
    });
  }

  static async processWalletWithdrawalReversalEvent(
    providerEvent,
    processingClaimId,
    options = {}
  ) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const currentTime = ProviderEventProcessorService.getOperationCurrentTime(options);

    const withdrawalTransaction =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
        providerEvent,
        options
      );

    const ownerContext = ProviderEventProcessorService.getWithdrawalOwnerContext({
      withdrawalTransaction,
      providerEvent,
    });

    ProviderEventProcessorService.assertWithdrawalCategoryMatchesOwner({
      providerEvent,
      ownerType: ownerContext.ownerType,
    });

    const paystackTransferCode =
      ProviderEventProcessorService.getPaystackTransferCode(providerEvent);

    const paystackTransferReference =
      ProviderEventProcessorService.getPaystackTransferReference(providerEvent);

    const creditReversal = ["completed", "reversed"].includes(withdrawalTransaction.status);
    const reverse = creditReversal
      ? WalletWithdrawalService.reverseCompletedWithdrawal
      : WalletWithdrawalService.reverseFailedWithdrawal;
    const reversalResult = await reverse(
      {
        withdrawalTransactionId: withdrawalTransaction._id,
        paystackTransferCode,
        providerEventId: providerEvent.providerEventId,
        reversalReason:
          payload.reversalReason ||
          "Provider reported withdrawal failed or reversed. Wallet balance restored.",
        currentTime,
        metadata: {
          providerEventRecordId: String(providerEvent._id),
          providerEventKey: providerEvent.eventKey,
          sourceEventName: providerEvent.eventName,
          paystackStatus: payload.paystackStatus || null,
          providerReference: providerEvent.providerReference,
          providerEventId: providerEvent.providerEventId,
          paystackTransferReference,
          paystackTransferCode,
        },
      },
      options
    );

    const failedTransaction = reversalResult.originalTransaction || reversalResult.transaction;

    if (failedTransaction.status !== (creditReversal ? "reversed" : "failed")) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Provider withdrawal failure/reversal did not leave the withdrawal in the expected terminal state.",
        code: "WITHDRAWAL_PROVIDER_REVERSAL_TERMINAL_STATE_INVALID",
        statusCode: 409,
        retryable: false,
        details: {
          withdrawalTransactionId: String(failedTransaction._id),
          status: failedTransaction.status,
        },
      });
    }

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,
        processingClaimId,
        transaction: reversalResult.transaction._id,
        wallet: reversalResult.wallet._id,
        employer: ownerContext.employer,
        professional: ownerContext.professional,
        bankAccount: failedTransaction.bankAccount || providerEvent.bankAccount,
        normalizedPayload: {
          ...payload,
          withdrawalTransactionId: String(failedTransaction._id),
          paystackTransferReference:
            ProviderEventProcessorService.cleanString(
              failedTransaction.paystackTransferReference
            ) || paystackTransferReference,
          paystackTransferCode:
            ProviderEventProcessorService.cleanString(failedTransaction.paystackTransferCode) ||
            paystackTransferCode,
          withdrawalStatus: failedTransaction.status,
          withdrawalReservationReleased: !creditReversal,
          withdrawalReversalCredited: creditReversal,
          reversalTransactionId: creditReversal ? String(reversalResult.transaction._id) : null,
          ownerType: ownerContext.ownerType,
          employerProfileId: ownerContext.employerProfileId
            ? String(ownerContext.employerProfileId)
            : null,
          professionalProfileId: ownerContext.professionalProfileId
            ? String(ownerContext.professionalProfileId)
            : null,
        },
        metadata: {
          processor: "ProviderEventProcessorService",
          withdrawalFailedOrReversed: true,
          withdrawalReservationReleased: !creditReversal,
          withdrawalReversalCredited: creditReversal,
          reversalTransactionId: creditReversal ? String(reversalResult.transaction._id) : null,
          withdrawalTerminalStatus: failedTransaction.status,
          ownerType: ownerContext.ownerType,
          idempotentRelease: Boolean(reversalResult.idempotent),
        },
        currentTime,
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      wallet: reversalResult.wallet,
      transaction: reversalResult.transaction,
      originalTransaction: failedTransaction,
      processed: true,
      ownerType: ownerContext.ownerType,
      idempotentRelease: Boolean(reversalResult.idempotent),
    };
  }
}

module.exports = ProviderEventProcessorService;
