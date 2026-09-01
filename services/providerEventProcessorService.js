// services/providerEventProcessorService.js

const mongoose = require("mongoose");

const Transaction = require("../models/Transaction");
const EmployerRefundBatch = require("../models/EmployerRefundBatch");

const ProviderEventService = require("./providerEventService");
const ShiftFundingService = require("./shiftFundingService");
const WalletFundingService = require("./walletFundingService");
const WalletWithdrawalService = require("./walletWithdrawalService");
const EmployerRefundBatchService = require("./employerRefundBatchService");

const PROVIDER_EVENT_RETRY_DELAY_MS = 5 * 60 * 1000;

const PAYSTACK_REFUND_EVENT_STATUS_MAP = Object.freeze({
  "refund.pending": "pending",
  "refund.processing": "processing",
  "refund.needs-attention": "needs_attention",
  "refund.failed": "failed",
  "refund.processed": "processed",
});

class ProviderEventProcessorService {
  static eventCategories = {
    employerWalletFunding: ["employer_wallet_funding", "wallet_funding"],

    shiftCheckoutPayment: ["shift_checkout_payment", "checkout_payment"],

    employerRefund: ["employer_refund"],

    withdrawalPayout: [
      "withdrawal_transfer",
      "employer_withdrawal_payout",
      "professional_withdrawal_payout",
    ],

    withdrawalReversal: [
      "transfer_reversal",
      "employer_withdrawal_reversal",
      "professional_withdrawal_reversal",
    ],
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

  static async getProcessingClaimLostResult(
    providerEventRecordId,
    error,
    options = {}
  ) {
    const providerEvent = await ProviderEventService.getProviderEventById(
      providerEventRecordId,
      {
        session: options.session,
      }
    );

    return {
      providerEvent,

      skipped: true,

      processingClaimed: false,

      processingClaimLost: true,

      errorCode:
        error?.code ||
        "PROVIDER_EVENT_PROCESSING_CLAIM_LOST",

      errorMessage:
        error?.message ||
        "Provider event processing ownership is no longer active.",
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
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "transactionId",
        "transaction"
      )
    );
  }

  static getPaystackTransferCode(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "paystackTransferCode"
      ) ||
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "transferCode"
      ) ||
      ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
        "metadata.transferCode",
        "metadata.transfer_code",
      ])
    );
  }

  static getPaystackTransferReference(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "paystackTransferReference"
      ) ||
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "transferReference"
      ) ||
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "providerReference"
      ) ||
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

  /* ─────────────────────────────── SHIFT FUNDING IDENTIFIER ─────────────────────────────── */

  static getShiftFundingReference(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "paystackReference"
      ) ||
        ProviderEventProcessorService.getPayloadValue(
          providerEvent,
          "providerReference"
        ) ||
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
  }) {
    const error = new Error(message);

    error.name = "ProviderEventProcessingError";
    error.code = code;
    error.statusCode = statusCode;

    if (typeof retryable === "boolean") {
      error.retryable = retryable;
    }

    if (details !== null && details !== undefined) {
      error.details = details;
    }

    return error;
  }

  static isRetryableProcessingError(error) {
    if (typeof error?.retryable === "boolean") {
      return error.retryable;
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
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "refundStatus"
      ) ||
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "paystackRefundStatus"
      ) ||
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "paystackStatus"
      );

    const payloadStatus =
      ProviderEventProcessorService.normalizePaystackRefundStatus(rawStatus);

    if (payloadStatus && payloadStatus !== expectedStatus) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund webhook status does not match the refund lifecycle event name.",

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

      rawStatus:
        ProviderEventProcessorService.cleanString(rawStatus) ||
        expectedStatus,
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
        ProviderEventProcessorService.getPayloadValue(
          providerEvent,
          "paystackRefundId"
        ) ||
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
        ProviderEventProcessorService.getPayloadValue(
          providerEvent,
          "paystackRefundReference"
        ) ||
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
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "refundTraceKey"
      ) ||
        ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
          "metadata.refundTraceKey",
          "metadata.metadata.refundTraceKey",
        ])
    );
  }

  static getRefundFailureReason(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "refundReason"
      ) ||
        ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
          "metadata.refundReason",
          "metadata.reason",
          "metadata.gatewayResponse",
        ])
    );
  }

  static getProviderEventMarker(providerEvent) {
    return ProviderEventProcessorService.cleanString(
      providerEvent.providerEventId ||
        providerEvent.eventKey ||
        providerEvent._id
    );
  }

  /* ─────────────────────────────── REFUND EXECUTION LOOKUP ─────────────────────────────── */

  static async getEmployerRefundExecutionByIds(
    { batchId, lineId },
    options = {}
  ) {
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
        message:
          "Paystack refund event matches more than one employer refund execution line.",

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
          message:
            "Provider refund event contains an incomplete employer refund execution link.",

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

    const providerRefundId =
      ProviderEventProcessorService.getProviderRefundId(providerEvent);

    const providerRefundReference =
      ProviderEventProcessorService.getProviderRefundReference(providerEvent);

    const refundTraceKey =
      ProviderEventProcessorService.getRefundTraceKey(providerEvent);

    const originalTransactionReference =
      ProviderEventProcessorService.getRefundOriginalTransactionReference(
        providerEvent
      );

    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const amount =
      payload.amount !== null && payload.amount !== undefined
        ? Number(payload.amount)
        : providerEvent.amount !== null && providerEvent.amount !== undefined
          ? Number(providerEvent.amount)
          : null;

    const currency = ProviderEventProcessorService.cleanString(
      payload.currency || providerEvent.currency
    );

    const businessId =
      ProviderEventProcessorService.getRecordId(providerEvent.employer);

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
      const byRefundId =
        await ProviderEventProcessorService.findUniqueEmployerRefundExecution({
          batchFilter: withScope({
            "lines.paystackRefund.refundId": providerRefundId,
          }),

          lineMatches: ({ line }) =>
            ProviderEventProcessorService.cleanString(
              line.paystackRefund?.refundId
            ) === providerRefundId,

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
            ProviderEventProcessorService.cleanString(
              line.paystackRefund?.reference
            ) === providerRefundReference,

          resolutionSource: "provider_refund_reference",

          options,
        });

      if (byRefundReference) {
        return byRefundReference;
      }
    }

    if (refundTraceKey) {
      const byTraceKey =
        await ProviderEventProcessorService.findUniqueEmployerRefundExecution({
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
            ProviderEventProcessorService.cleanString(
              line.paystackRefund?.idempotencyKey
            ) === refundTraceKey ||
            ProviderEventProcessorService.cleanString(
              line.idempotencyKey
            ) === refundTraceKey,

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
            "lines.originalPaystackReference":
              originalTransactionReference,
          }),

          lineMatches: ({ line }) => {
            if (
              ProviderEventProcessorService.cleanString(
                line.originalPaystackReference
              ) !== originalTransactionReference
            ) {
              return false;
            }

            /*
             * Cancelled lines never crossed the provider boundary.
             * Completed/failed lines remain discoverable so late
             * provider events can reconcile safely.
             */
            if (line.status === "cancelled") {
              return false;
            }

            if (
              amount !== null &&
              Number.isSafeInteger(amount) &&
              Number(line.totalAmount) !== amount
            ) {
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
      message:
        "Employer refund execution line was not found for Paystack refund event.",

      code: "EMPLOYER_REFUND_EXECUTION_NOT_FOUND",

      statusCode: 404,

      /*
       * Provider delivery may race persistence of the
       * initial refund response, so retry can resolve it.
       */
      retryable: true,
    });
  }

  /* ─────────────────────────────── REFUND EXECUTION VALIDATION ─────────────────────────────── */

  static assertEmployerRefundEventMatchesExecution({
    providerEvent,
    batch,
    line,
  }) {
    if (
      line.fundingMethod !== "paystack_checkout" ||
      line.initialExecutionMethod !== "paystack_refund"
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund webhook can only be linked to a Paystack Checkout refund line.",

        code: "PAYSTACK_REFUND_EXECUTION_METHOD_MISMATCH",

        statusCode: 409,

        retryable: false,
      });
    }

    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const amount =
      payload.amount !== null && payload.amount !== undefined
        ? Number(payload.amount)
        : providerEvent.amount !== null && providerEvent.amount !== undefined
          ? Number(providerEvent.amount)
          : null;

    if (
      amount !== null &&
      Number.isSafeInteger(amount) &&
      amount !== Number(line.totalAmount)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund amount does not match the resolved refund line.",

        code: "PAYSTACK_REFUND_AMOUNT_MISMATCH",

        statusCode: 409,

        retryable: false,
      });
    }

    const currency = ProviderEventProcessorService.cleanString(
      payload.currency || providerEvent.currency
    );

    if (
      currency &&
      currency.toUpperCase() !==
        String(batch.currency).toUpperCase()
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund currency does not match the resolved refund batch.",

        code: "PAYSTACK_REFUND_CURRENCY_MISMATCH",

        statusCode: 409,

        retryable: false,
      });
    }

    const providerRefundId =
      ProviderEventProcessorService.getProviderRefundId(providerEvent);

    const lineRefundId =
      ProviderEventProcessorService.cleanString(
        line.paystackRefund?.refundId
      );

    if (
      providerRefundId &&
      lineRefundId &&
      providerRefundId !== lineRefundId
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund ID conflicts with the resolved refund line.",

        code: "PAYSTACK_REFUND_ID_MISMATCH",

        statusCode: 409,

        retryable: false,
      });
    }

    const providerRefundReference =
      ProviderEventProcessorService.getProviderRefundReference(providerEvent);

    const lineRefundReference =
      ProviderEventProcessorService.cleanString(
        line.paystackRefund?.reference
      );

    if (
      providerRefundReference &&
      lineRefundReference &&
      providerRefundReference !== lineRefundReference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund reference conflicts with the resolved refund line.",

        code: "PAYSTACK_REFUND_REFERENCE_MISMATCH",

        statusCode: 409,

        retryable: false,
      });
    }

    const originalTransactionReference =
      ProviderEventProcessorService.getRefundOriginalTransactionReference(
        providerEvent
      );

    if (
      originalTransactionReference &&
      line.originalPaystackReference &&
      originalTransactionReference !==
        line.originalPaystackReference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack original transaction reference does not match the resolved refund line.",

        code: "PAYSTACK_REFUND_ORIGINAL_REFERENCE_MISMATCH",

        statusCode: 409,

        retryable: false,
      });
    }

    if (
      providerEvent.employer &&
      String(providerEvent.employer) !==
        String(batch.business)
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Provider refund employer does not match the resolved refund batch.",

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
          .map((allocation) =>
            ProviderEventProcessorService.getRecordId(allocation.shift)
          )
          .filter(Boolean)
          .map(String)
      ),
    ];

    return shiftIds.length === 1
      ? shiftIds[0]
      : null;
  }

  /* ─────────────────────────────── WITHDRAWAL LOOKUP ─────────────────────────────── */

  static async findWithdrawalTransactionForProviderEvent(
    providerEvent,
    options = {}
  ) {
    const withdrawalTransactionId =
      ProviderEventProcessorService.getWithdrawalTransactionId(providerEvent);

    if (
      withdrawalTransactionId &&
      mongoose.Types.ObjectId.isValid(withdrawalTransactionId)
    ) {
      const query = Transaction.findOne({
        _id: withdrawalTransactionId,
        type: "withdrawal",
      });

      if (options.session) {
        query.session(options.session);
      }

      const transaction = await query;

      if (transaction) {
        return transaction;
      }
    }

    const paystackTransferCode =
      ProviderEventProcessorService.getPaystackTransferCode(providerEvent);

    const paystackTransferReference =
      ProviderEventProcessorService.getPaystackTransferReference(
        providerEvent
      );

    const orFilters = [];

    if (paystackTransferCode) {
      orFilters.push({
        paystackTransferCode,
      });

      orFilters.push({
        "metadata.paystackTransferCode": paystackTransferCode,
      });
    }

    if (paystackTransferReference) {
      orFilters.push({
        "metadata.paystackTransferReference":
          paystackTransferReference,
      });

      orFilters.push({
        paystackReference:
          paystackTransferReference,
      });

      orFilters.push({
        reference:
          paystackTransferReference,
      });
    }

    if (!orFilters.length) {
      throw new Error(
        "Withdrawal transaction lookup value is required."
      );
    }

    const query = Transaction.findOne({
      type: "withdrawal",
      $or: orFilters,
    });

    if (options.session) {
      query.session(options.session);
    }

    const transaction = await query;

    if (!transaction) {
      throw new Error(
        "Withdrawal transaction not found for provider event."
      );
    }

    return transaction;
  }

  static getWithdrawalOwnerContext({
    withdrawalTransaction,
    providerEvent,
  }) {
    const metadata =
      withdrawalTransaction.metadata || {};

    const employerProfileId =
      metadata.employerProfileId ||
      providerEvent.employer ||
      null;

    const professionalProfileId =
      metadata.professionalProfileId ||
      providerEvent.professional ||
      null;

    let ownerType =
      metadata.ownerType || null;

    if (
      !ownerType &&
      professionalProfileId
    ) {
      ownerType = "professional";
    }

    if (
      !ownerType &&
      employerProfileId
    ) {
      ownerType = "employer";
    }

    return {
      ownerType,

      employer:
        ownerType === "employer"
          ? employerProfileId
          : null,

      professional:
        ownerType === "professional"
          ? professionalProfileId
          : null,

      employerProfileId,
      professionalProfileId,
    };
  }

  /* ─────────────────────────────── PROCESS PROVIDER EVENT ─────────────────────────────── */

  static async processProviderEvent(
    {
      providerEventRecordId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime =
      ProviderEventProcessorService.normalizeCurrentTime(currentTime);

    let providerEvent =
      await ProviderEventService.getProviderEventById(
        providerEventRecordId,
        {
          session: options.session,
        }
      );

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

    /*
     * An unverified event never enters processing and
     * therefore has no processing claim to present.
     */
    if (!providerEvent.isVerified) {
      const failedResult =
        await ProviderEventService.markFailed(
          {
            providerEventRecordId:
              providerEvent._id,

            failureReason:
              "Unverified provider event cannot be processed.",

            retryable: false,

            metadata: {
              processor:
                "ProviderEventProcessorService",
            },

            currentTime:
              normalizedCurrentTime,
          },
          {
            session: options.session,
          }
        );

      return {
        providerEvent:
          failedResult.providerEvent,

        failed: true,

        retryable: false,

        errorMessage:
          "Unverified provider event cannot be processed.",
      };
    }

    /*
     * Failed events may run again only when a retry
     * was actually scheduled and that deadline is due.
     */
    if (providerEvent.status === "failed") {
      if (!providerEvent.nextRetryAt) {
        return {
          providerEvent,

          failed: true,

          retryable: false,

          retryUnavailable: true,

          errorMessage:
            providerEvent.failureReason ||
            "Provider event failed and is not scheduled for retry.",
        };
      }

      const nextRetryAt =
        new Date(providerEvent.nextRetryAt);

      if (Number.isNaN(nextRetryAt.getTime())) {
        throw ProviderEventProcessorService.createProcessingError({
          message:
            "Provider event contains an invalid retry deadline.",

          code:
            "INVALID_PROVIDER_EVENT_RETRY_DEADLINE",

          statusCode: 500,

          retryable: false,

          details: {
            providerEventRecordId:
              String(providerEvent._id),
          },
        });
      }

      if (
        nextRetryAt >
        normalizedCurrentTime
      ) {
        return {
          providerEvent,

          failed: true,

          retryable: true,

          retryNotDue: true,

          nextRetryAt,

          errorMessage:
            providerEvent.failureReason ||
            "Provider event retry is not due yet.",
        };
      }
    }

    /*
     * markProcessing() is the atomic ownership gate.
     *
     * The successful claim also creates the unique
     * processingClaimId for this exact attempt.
     */
    const processingResult =
      await ProviderEventService.markProcessing(
        {
          providerEventRecordId:
            providerEvent._id,

          currentTime:
            normalizedCurrentTime,
        },
        {
          session: options.session,
        }
      );

    if (
      processingResult.alreadyProcessed ===
      true
    ) {
      return {
        providerEvent:
          processingResult.providerEvent,

        alreadyProcessed: true,
      };
    }

    if (
      processingResult.claimedForProcessing !==
      true
    ) {
      return {
        providerEvent:
          processingResult.providerEvent,

        skipped: true,

        alreadyProcessing:
          processingResult.alreadyProcessing ===
          true,

        processingClaimed: false,
      };
    }

    providerEvent =
      processingResult.providerEvent;

    const processingClaimId =
      ProviderEventProcessorService.cleanString(
        processingResult.processingClaimId ||
          providerEvent.processingClaimId
      );

    /*
     * A successful processing claim must always carry
     * its ownership token. Missing it is an internal
     * consistency error, not a business retry.
     */
    if (!processingClaimId) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Claimed ProviderEvent contains no processing claim ID.",

        code:
          "PROVIDER_EVENT_PROCESSING_CLAIM_MISSING",

        statusCode: 500,

        retryable: false,

        details: {
          providerEventRecordId:
            String(providerEvent._id),
        },
      });
    }

    try {
      /*
       * Refund provider states such as failed and
       * needs_attention are valid refund lifecycle
       * events, not ProviderEvent processing failures.
       */
      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.employerRefund
        )
      ) {
        return ProviderEventProcessorService.processEmployerRefundEvent(
          providerEvent,
          processingClaimId,
          options
        );
      }

      /*
       * Shift Checkout is checked before employer
       * wallet funding because both can arrive as
       * charge.success.
       */
      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.shiftCheckoutPayment
        )
      ) {
        return ProviderEventProcessorService.processShiftCheckoutPaymentEvent(
          providerEvent,
          processingClaimId,
          options
        );
      }

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.employerWalletFunding
        )
      ) {
        return ProviderEventProcessorService.processEmployerWalletFundingEvent(
          providerEvent,
          processingClaimId,
          options
        );
      }

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.withdrawalPayout
        )
      ) {
        return ProviderEventProcessorService.processWithdrawalPayoutEvent(
          providerEvent,
          processingClaimId,
          options
        );
      }

      if (
        ProviderEventProcessorService.isCategory(
          providerEvent,
          ProviderEventProcessorService.eventCategories.withdrawalReversal
        )
      ) {
        return ProviderEventProcessorService.processWithdrawalReversalEvent(
          providerEvent,
          processingClaimId,
          options
        );
      }

      const ignoredResult =
        await ProviderEventService.markIgnored(
          {
            providerEventRecordId:
              providerEvent._id,

            processingClaimId,

            ignoredReason:
              "Provider event category is not handled by this processor.",

            metadata: {
              processor:
                "ProviderEventProcessorService",
            },

            currentTime:
              normalizedCurrentTime,
          },
          {
            session: options.session,
          }
        );

      return {
        providerEvent:
          ignoredResult.providerEvent,

        ignored: true,
      };
    } catch (error) {
      /*
       * A claim conflict means this worker no longer
       * owns the ProviderEvent.
       *
       * Do not turn that into another failed event:
       * Worker B may already own or have completed it.
       */
      if (
        ProviderEventProcessorService.isProcessingClaimError(
          error
        )
      ) {
        return ProviderEventProcessorService.getProcessingClaimLostResult(
          providerEvent._id,
          error,
          options
        );
      }

      const retryable =
        ProviderEventProcessorService.isRetryableProcessingError(
          error
        );

      const failedAt = new Date();

      const nextRetryAt = retryable
        ? new Date(
            failedAt.getTime() +
              PROVIDER_EVENT_RETRY_DELAY_MS
          )
        : null;

      try {
        const failedResult =
          await ProviderEventService.markFailed(
            {
              providerEventRecordId:
                providerEvent._id,

              processingClaimId,

              failureReason:
                error.message ||
                "Provider event processing failed.",

              retryable,

              nextRetryAt,

              metadata: {
                processor:
                  "ProviderEventProcessorService",

                errorCode:
                  error.code || null,

                statusCode:
                  Number.isInteger(
                    Number(error.statusCode)
                  )
                    ? Number(error.statusCode)
                    : null,

                errorDetails:
                  error.details || null,
              },

              currentTime:
                failedAt,
            },
            {
              session:
                options.session,
            }
          );

        return {
          providerEvent:
            failedResult.providerEvent,

          failed: true,

          retryable,

          nextRetryAt,

          errorCode:
            error.code || null,

          errorMessage:
            error.message ||
            "Provider event processing failed.",
        };
      } catch (markFailedError) {
        /*
         * Ownership may have expired between the
         * business error and markFailed().
         *
         * In that case the stale worker must stop
         * without modifying the new owner's state.
         */
        if (
          ProviderEventProcessorService.isProcessingClaimError(
            markFailedError
          )
        ) {
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

  /* ─────────────────────────────── EMPLOYER PAYSTACK REFUND ─────────────────────────────── */

  static async processEmployerRefundEvent(
    providerEvent,
    processingClaimId,
    options = {}
  ) {
    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const { status: refundStatus } =
      ProviderEventProcessorService.getPaystackRefundStatus(providerEvent);

    const providerRefundId =
      ProviderEventProcessorService.getProviderRefundId(providerEvent);

    const providerRefundReference =
      ProviderEventProcessorService.getProviderRefundReference(providerEvent);

    const refundTraceKey =
      ProviderEventProcessorService.getRefundTraceKey(providerEvent);

    const originalTransactionReference =
      ProviderEventProcessorService.getRefundOriginalTransactionReference(
        providerEvent
      );

    const linkedBatchId =
      ProviderEventProcessorService.getRecordId(
        providerEvent.employerRefundBatch
      );

    const linkedLineId =
      ProviderEventProcessorService.getRecordId(
        providerEvent.employerRefundBatchLineId
      );

    /*
     * Paystack refund webhooks can omit refund resource
     * identifiers. Original transaction reference and
     * Loqum trace key remain valid identities.
     */
    if (
      !linkedBatchId &&
      !linkedLineId &&
      !providerRefundId &&
      !providerRefundReference &&
      !refundTraceKey &&
      !originalTransactionReference
    ) {
      throw ProviderEventProcessorService.createProcessingError({
        message:
          "Paystack refund event contains no usable refund reconciliation identity.",

        code:
          "PAYSTACK_REFUND_RECONCILIATION_IDENTITY_REQUIRED",

        statusCode: 422,

        retryable: false,
      });
    }

    const execution =
      await ProviderEventProcessorService.resolveEmployerRefundExecution(
        providerEvent,
        {
          session: options.session,
        }
      );

    ProviderEventProcessorService.assertEmployerRefundEventMatchesExecution({
      providerEvent,

      batch: execution.batch,

      line: execution.line,
    });

    const batchId =
      execution.batch._id;

    const lineId =
      execution.line._id;

    const employerId =
      execution.batch.business;

    const shiftId =
      ProviderEventProcessorService.getEmployerRefundLineShiftId(
        execution.line
      );

    const providerEventMarker =
      ProviderEventProcessorService.getProviderEventMarker(
        providerEvent
      );

    const resolvedOriginalTransactionReference =
      originalTransactionReference ||
      execution.line.originalPaystackReference;

    const failureReason =
      refundStatus === "failed"
        ? ProviderEventProcessorService.getRefundFailureReason(
            providerEvent
          ) ||
          "Paystack reported that the employer refund failed."
        : null;

    /*
     * Persist the exact execution link before mutating
     * provider refund state so retries target the same
     * line.
     *
     * processingClaimId is supplied so this mutation
     * can also be fenced to the active worker.
     */
    await ProviderEventService.linkEmployerRefundExecution(
      {
        providerEventRecordId:
          providerEvent._id,

        processingClaimId,

        employerRefundBatch:
          batchId,

        employerRefundBatchLineId:
          lineId,

        providerRefundId,

        providerRefundReference,

        employer:
          employerId,

        shift:
          shiftId,
      },
      {
        session:
          options.session,
      }
    );

    /*
     * EmployerRefundBatchService owns provider state
     * and every resulting financial consequence.
     *
     * Its operations remain independently idempotent,
     * which protects a retry if a worker dies after
     * the downstream operation but before ProviderEvent
     * completion is recorded.
     */
    const syncResult =
      await EmployerRefundBatchService.syncPaystackRefundStatus({
        batchId,

        lineId,

        status:
          refundStatus,

        refundId:
          providerRefundId,

        reference:
          providerRefundReference,

        providerEventId:
          providerEventMarker,

        failureReason,

        currentTime:
          new Date(),
      });

    const processedResult =
      await ProviderEventService.markProcessed(
        {
          providerEventRecordId:
            providerEvent._id,

          processingClaimId,

          employer:
            employerId,

          shift:
            shiftId,

          providerRefundId,

          providerRefundReference,

          employerRefundBatch:
            batchId,

          employerRefundBatchLineId:
            lineId,

          normalizedPayload: {
            ...payload,

            refundStatus,

            paystackRefundStatus:
              refundStatus,

            providerRefundId,

            providerRefundReference,

            originalTransactionReference:
              resolvedOriginalTransactionReference,

            refundTraceKey,

            employerProfileId:
              employerId
                ? String(employerId)
                : null,

            shiftId:
              shiftId
                ? String(shiftId)
                : null,

            employerRefundBatchId:
              String(batchId),

            employerRefundBatchLineId:
              String(lineId),
          },

          metadata: {
            processor:
              "ProviderEventProcessorService",

            employerRefundSynchronized:
              true,

            employerRefundBatchId:
              String(batchId),

            employerRefundBatchLineId:
              String(lineId),

            refundStatus,

            resolutionSource:
              execution.resolutionSource,

            providerEventMarker,
          },
        },
        {
          session:
            options.session,
        }
      );

    return {
      providerEvent:
        processedResult.providerEvent,

      batch:
        syncResult?.batch ||
        execution.batch,

      line:
        syncResult?.line ||
        syncResult?.refundLine ||
        execution.line,

      processed: true,

      refundStatus,

      employerRefundBatchId:
        String(batchId),

      employerRefundBatchLineId:
        String(lineId),
    };
  }

  /* ─────────────────────────────── SHIFT CHECKOUT PAYMENT ─────────────────────────────── */

  static async processShiftCheckoutPaymentEvent(
    providerEvent,
    processingClaimId,
    options = {}
  ) {
    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const reference =
      ProviderEventProcessorService.getShiftFundingReference(providerEvent);

    const providerEventId =
      ProviderEventProcessorService.cleanString(
        payload.providerEventId ||
          providerEvent.providerEventId
      );

    if (!reference) {
      throw new Error(
        "Paystack reference is required to process shift Checkout funding."
      );
    }

    /*
     * Provider delivery is only a trigger.
     * ShiftFundingService independently verifies Paystack
     * and owns fund, return, or integrity-conflict handling.
     *
     * Its funding/return operations remain independently
     * idempotent for safe ProviderEvent retry.
     */
    const fundingResult =
      await ShiftFundingService.finalizePaystackShiftFunding({
        reference,
        providerEventId,
      });

    const shift =
      fundingResult.shift || null;

    const shiftId =
      ProviderEventProcessorService.getRecordId(shift) ||
      ProviderEventProcessorService.getRecordId(
        fundingResult.shiftId
      ) ||
      ProviderEventProcessorService.getRecordId(
        payload.shiftId
      ) ||
      ProviderEventProcessorService.getRecordId(
        providerEvent.shift
      );

    if (!shiftId) {
      throw new Error(
        "Shift could not be identified after Paystack verification."
      );
    }

    const fundingTransaction =
      fundingResult.transaction ||
      fundingResult.paystackTransaction ||
      fundingResult.fundingTransaction ||
      null;

    const fundingTransactionId =
      ProviderEventProcessorService.getRecordId(
        fundingTransaction
      ) ||
      ProviderEventProcessorService.getRecordId(
        shift?.fundingTransaction
      ) ||
      null;

    let fundingTransactionRecord =
      null;

    if (fundingTransactionId) {
      fundingTransactionRecord =
        await Transaction.findById(
          fundingTransactionId
        );
    }

    const escrowWalletId =
      ProviderEventProcessorService.getRecordId(
        fundingTransactionRecord?.wallet
      ) || null;

    const employerProfileId =
      ProviderEventProcessorService.getRecordId(
        fundingTransactionRecord?.metadata?.employerProfileId
      ) ||
      ProviderEventProcessorService.getRecordId(
        fundingResult.employerProfileId
      ) ||
      ProviderEventProcessorService.getRecordId(
        payload.employerProfileId
      ) ||
      ProviderEventProcessorService.getRecordId(
        providerEvent.employer
      );

    const fundingApplied =
      fundingResult.fundingApplied === true;

    const returnedToEmployerWallet =
      fundingResult.returnedToEmployerWallet ===
      true;

    const returnReason =
      returnedToEmployerWallet
        ? ProviderEventProcessorService.cleanString(
            fundingResult.returnReason
          )
        : null;

    const alreadyFunded =
      fundingApplied &&
      Boolean(
        fundingResult.alreadyFunded ||
          fundingResult.idempotent ||
          fundingResult.idempotentFunding ||
          fundingResult.alreadyCompleted
      );

    const processedResult =
      await ProviderEventService.markProcessed(
        {
          providerEventRecordId:
            providerEvent._id,

          processingClaimId,

          transaction:
            fundingTransactionId,

          wallet:
            escrowWalletId,

          employer:
            employerProfileId,

          shift:
            shiftId,

          normalizedPayload: {
            ...payload,

            providerReference:
              reference,

            paystackReference:
              reference,

            providerEventId,

            employerProfileId:
              employerProfileId
                ? String(employerProfileId)
                : null,

            shiftId:
              String(shiftId),

            shiftReferenceCode:
              ProviderEventProcessorService.cleanString(
                shift?.referenceCode
              ) ||
              ProviderEventProcessorService.cleanString(
                payload.shiftReferenceCode
              ),

            fundingTransactionId:
              fundingTransactionId
                ? String(fundingTransactionId)
                : null,

            escrowWalletId:
              escrowWalletId
                ? String(escrowWalletId)
                : null,

            fundingApplied,

            returnedToEmployerWallet,

            returnReason,
          },

          metadata: {
            processor:
              "ProviderEventProcessorService",

            shiftCheckoutFinalized:
              true,

            fundingApplied,

            returnedToEmployerWallet,

            returnReason,

            idempotentShiftFunding:
              alreadyFunded,

            fundingTransactionId:
              fundingTransactionId
                ? String(fundingTransactionId)
                : null,

            escrowWalletId:
              escrowWalletId
                ? String(escrowWalletId)
                : null,
          },
        },
        options
      );

    return {
      providerEvent:
        processedResult.providerEvent,

      shift,

      transaction:
        fundingTransactionRecord ||
        fundingTransaction,

      processed: true,

      fundingApplied,

      returnedToEmployerWallet,

      returnReason,

      alreadyFunded,

      idempotentShiftFunding:
        alreadyFunded,
    };
  }

  /* ─────────────────────────────── EMPLOYER WALLET FUNDING ─────────────────────────────── */

  static async processEmployerWalletFundingEvent(
    providerEvent,
    processingClaimId,
    options = {}
  ) {
    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const employerProfileId =
      payload.employerProfileId ||
      payload.employer ||
      providerEvent.employer;

    const dvaId =
      payload.dvaId ||
      payload.dva ||
      providerEvent.dva;

    const amount =
      payload.amount !== null &&
      payload.amount !== undefined
        ? payload.amount
        : providerEvent.amount;

    const providerFee =
      payload.providerFee !== null &&
      payload.providerFee !== undefined
        ? payload.providerFee
        : providerEvent.providerFee;

    const netAmount =
      payload.netAmount !== null &&
      payload.netAmount !== undefined
        ? payload.netAmount
        : providerEvent.netAmount;

    const currency =
      payload.currency ||
      providerEvent.currency ||
      "NGN";

    const providerReference =
      payload.providerReference ||
      providerEvent.providerReference;

    const providerEventId =
      payload.providerEventId ||
      providerEvent.providerEventId;

    if (!employerProfileId) {
      throw new Error(
        "Employer profile ID is required to process wallet funding event."
      );
    }

    if (!dvaId) {
      throw new Error(
        "DVA ID is required to process wallet funding event."
      );
    }

    if (
      amount === null ||
      amount === undefined
    ) {
      throw new Error(
        "Amount is required to process wallet funding event."
      );
    }

    if (!providerReference) {
      throw new Error(
        "Provider reference is required to process wallet funding event."
      );
    }

    const fundingResult =
      await WalletFundingService.creditEmployerWalletFromDvaFunding(
        {
          employerProfileId,

          dvaId,

          amount,

          currency,

          provider:
            providerEvent.provider,

          providerReference,

          providerEventId,

          providerFee,

          netAmount,

          metadata: {
            providerEventRecordId:
              String(providerEvent._id),

            providerEventKey:
              providerEvent.eventKey,

            sourceEventName:
              providerEvent.eventName,
          },
        },
        options
      );

    const processedResult =
      await ProviderEventService.markProcessed(
        {
          providerEventRecordId:
            providerEvent._id,

          processingClaimId,

          transaction:
            fundingResult.transaction._id,

          wallet:
            fundingResult.wallet._id,

          employer:
            employerProfileId,

          dva:
            dvaId,

          normalizedPayload: {
            ...payload,

            employerProfileId:
              String(employerProfileId),

            dvaId:
              String(dvaId),

            amount,

            currency,

            providerReference,

            providerEventId,
          },

          metadata: {
            processor:
              "ProviderEventProcessorService",

            walletFundingTransactionId:
              String(
                fundingResult.transaction._id
              ),

            idempotentWalletFunding:
              Boolean(
                fundingResult.idempotent
              ),
          },
        },
        options
      );

    return {
      providerEvent:
        processedResult.providerEvent,

      wallet:
        fundingResult.wallet,

      transaction:
        fundingResult.transaction,

      processed: true,

      idempotentWalletFunding:
        Boolean(fundingResult.idempotent),
    };
  }

  /* ─────────────────────────────── WITHDRAWAL PAYOUT ─────────────────────────────── */

  static async processWithdrawalPayoutEvent(
    providerEvent,
    processingClaimId,
    options = {}
  ) {
    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const withdrawalTransaction =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
        providerEvent,
        options
      );

    /*
     * Withdrawal service remains independently
     * idempotent because a worker can die after this
     * operation but before ProviderEvent completion.
     */
    const completedResult =
      await WalletWithdrawalService.markWithdrawalCompleted(
        {
          withdrawalTransactionId:
            withdrawalTransaction._id,

          metadata: {
            providerEventRecordId:
              String(providerEvent._id),

            providerEventKey:
              providerEvent.eventKey,

            sourceEventName:
              providerEvent.eventName,

            providerReference:
              providerEvent.providerReference,

            providerEventId:
              providerEvent.providerEventId,
          },
        },
        options
      );

    const ownerContext =
      ProviderEventProcessorService.getWithdrawalOwnerContext({
        withdrawalTransaction:
          completedResult.transaction,

        providerEvent,
      });

    const processedResult =
      await ProviderEventService.markProcessed(
        {
          providerEventRecordId:
            providerEvent._id,

          processingClaimId,

          transaction:
            completedResult.transaction._id,

          wallet:
            completedResult.transaction.wallet,

          employer:
            ownerContext.employer,

          professional:
            ownerContext.professional,

          bankAccount:
            completedResult.transaction.bankAccount ||
            providerEvent.bankAccount,

          normalizedPayload: {
            ...payload,

            withdrawalTransactionId:
              String(
                completedResult.transaction._id
              ),

            ownerType:
              ownerContext.ownerType,

            employerProfileId:
              ownerContext.employerProfileId
                ? String(
                    ownerContext.employerProfileId
                  )
                : null,

            professionalProfileId:
              ownerContext.professionalProfileId
                ? String(
                    ownerContext.professionalProfileId
                  )
                : null,
          },

          metadata: {
            processor:
              "ProviderEventProcessorService",

            withdrawalCompleted:
              true,

            ownerType:
              ownerContext.ownerType,

            alreadyCompleted:
              Boolean(
                completedResult.alreadyCompleted
              ),
          },
        },
        options
      );

    return {
      providerEvent:
        processedResult.providerEvent,

      transaction:
        completedResult.transaction,

      processed: true,

      ownerType:
        ownerContext.ownerType,

      alreadyCompleted:
        Boolean(
          completedResult.alreadyCompleted
        ),
    };
  }

  /* ─────────────────────────────── WITHDRAWAL REVERSAL ─────────────────────────────── */

  static async processWithdrawalReversalEvent(
    providerEvent,
    processingClaimId,
    options = {}
  ) {
    const payload =
      ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const withdrawalTransaction =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
        providerEvent,
        options
      );

    /*
     * Reversal service remains independently
     * idempotent for the same crash/retry boundary.
     */
    const reversalResult =
      await WalletWithdrawalService.reverseFailedWithdrawal(
        {
          withdrawalTransactionId:
            withdrawalTransaction._id,

          reversalReason:
            payload.reversalReason ||
            "Provider reported withdrawal failed or reversed. Wallet balance reversed.",

          metadata: {
            providerEventRecordId:
              String(providerEvent._id),

            providerEventKey:
              providerEvent.eventKey,

            sourceEventName:
              providerEvent.eventName,

            providerReference:
              providerEvent.providerReference,

            providerEventId:
              providerEvent.providerEventId,
          },
        },
        options
      );

    const ownerContext =
      ProviderEventProcessorService.getWithdrawalOwnerContext({
        withdrawalTransaction:
          reversalResult.originalTransaction,

        providerEvent,
      });

    const processedResult =
      await ProviderEventService.markProcessed(
        {
          providerEventRecordId:
            providerEvent._id,

          processingClaimId,

          transaction:
            reversalResult.transaction._id,

          wallet:
            reversalResult.wallet._id,

          employer:
            ownerContext.employer,

          professional:
            ownerContext.professional,

          bankAccount:
            reversalResult.transaction.bankAccount ||
            providerEvent.bankAccount,

          normalizedPayload: {
            ...payload,

            withdrawalTransactionId:
              String(
                reversalResult.originalTransaction._id
              ),

            reversalTransactionId:
              String(
                reversalResult.transaction._id
              ),

            ownerType:
              ownerContext.ownerType,

            employerProfileId:
              ownerContext.employerProfileId
                ? String(
                    ownerContext.employerProfileId
                  )
                : null,

            professionalProfileId:
              ownerContext.professionalProfileId
                ? String(
                    ownerContext.professionalProfileId
                  )
                : null,
          },

          metadata: {
            processor:
              "ProviderEventProcessorService",

            withdrawalReversed:
              true,

            ownerType:
              ownerContext.ownerType,

            idempotentReversal:
              Boolean(
                reversalResult.idempotent
              ),
          },
        },
        options
      );

    return {
      providerEvent:
        processedResult.providerEvent,

      wallet:
        reversalResult.wallet,

      transaction:
        reversalResult.transaction,

      originalTransaction:
        reversalResult.originalTransaction,

      processed: true,

      ownerType:
        ownerContext.ownerType,

      idempotentReversal:
        Boolean(
          reversalResult.idempotent
        ),
    };
  }
}

module.exports = ProviderEventProcessorService;