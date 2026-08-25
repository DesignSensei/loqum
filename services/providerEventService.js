// services/providerEventService.js

const mongoose = require("mongoose");

const ProviderEvent = require("../models/ProviderEvent");

const money = require("../utils/money");

class ProviderEventService {
  /* ─────────────────────────────── TRANSACTIONS ─────────────────────────────── */

  static async runWithOptionalTransaction(options = {}, callback) {
    if (options.session) {
      return callback(options.session);
    }

    const session = await mongoose.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        result = await callback(session);
      });

      return result;
    } finally {
      await session.endSession();
    }
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  static cleanLowerString(value) {
    const cleanValue = ProviderEventService.cleanString(value);

    return cleanValue ? cleanValue.toLowerCase() : null;
  }

  static normalizeCurrentTime(value) {
    const currentTime =
      value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(currentTime.getTime())) {
      throw new Error("Provider event current time is invalid.");
    }

    return currentTime;
  }

  static normalizeOptionalMinorUnitAmount(value, label) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return money.normalizeMinorUnitAmount(value, label);
  }

  static normalizeEventCategory(value) {
    const eventCategory = ProviderEventService.cleanLowerString(value || "other");

    return eventCategory || "other";
  }

  static hasValue(value) {
    return !(value === null || value === undefined || value === "");
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  /* ─────────────────────────────── REFUND LINK VALIDATION ─────────────────────────────── */

  static assertEmployerRefundExecutionLinkPair({
    employerRefundBatch = null,
    employerRefundBatchLineId = null,
  }) {
    const hasBatch = ProviderEventService.hasValue(employerRefundBatch);

    const hasLine = ProviderEventService.hasValue(employerRefundBatchLineId);

    if (hasBatch !== hasLine) {
      throw new Error(
        "Employer refund batch and employer refund batch line ID must be supplied together."
      );
    }

    return {
      employerRefundBatch: hasBatch ? employerRefundBatch : null,

      employerRefundBatchLineId: hasLine ? employerRefundBatchLineId : null,
    };
  }

  static applyEmployerRefundExecutionLink(
    providerEvent,
    {
      employerRefundBatch,
      employerRefundBatchLineId,

      providerRefundId = null,
      providerRefundReference = null,

      employer = null,
      shift = null,
    }
  ) {
    const {
      employerRefundBatch: normalizedBatch,

      employerRefundBatchLineId: normalizedLineId,
    } = ProviderEventService.assertEmployerRefundExecutionLinkPair({
      employerRefundBatch,
      employerRefundBatchLineId,
    });

    if (
      providerEvent.employerRefundBatch &&
      !ProviderEventService.sameId(providerEvent.employerRefundBatch, normalizedBatch)
    ) {
      throw new Error("Provider event is already linked to a different employer refund batch.");
    }

    if (
      providerEvent.employerRefundBatchLineId &&
      !ProviderEventService.sameId(providerEvent.employerRefundBatchLineId, normalizedLineId)
    ) {
      throw new Error(
        "Provider event is already linked to a different employer refund batch line."
      );
    }

    const cleanProviderRefundId = ProviderEventService.cleanString(providerRefundId);

    const cleanProviderRefundReference = ProviderEventService.cleanString(providerRefundReference);

    if (
      providerEvent.providerRefundId &&
      cleanProviderRefundId &&
      providerEvent.providerRefundId !== cleanProviderRefundId
    ) {
      throw new Error("Provider event is already linked to a different provider refund ID.");
    }

    if (
      providerEvent.providerRefundReference &&
      cleanProviderRefundReference &&
      providerEvent.providerRefundReference !== cleanProviderRefundReference
    ) {
      throw new Error("Provider event is already linked to a different provider refund reference.");
    }

    providerEvent.eventCategory = "employer_refund";

    providerEvent.employerRefundBatch = normalizedBatch;

    providerEvent.employerRefundBatchLineId = normalizedLineId;

    if (cleanProviderRefundId) {
      providerEvent.providerRefundId = cleanProviderRefundId;
    }

    if (cleanProviderRefundReference) {
      providerEvent.providerRefundReference = cleanProviderRefundReference;
    }

    if (employer) {
      providerEvent.employer = employer;
    }

    if (shift) {
      providerEvent.shift = shift;
    }

    return providerEvent;
  }

  /* ─────────────────────────────── EVENT KEY ─────────────────────────────── */

  static buildEventKey({
    provider,
    eventName,

    providerEventId = null,

    providerReference = null,

    providerRefundId = null,

    providerRefundReference = null,
  }) {
    const cleanProvider = ProviderEventService.cleanLowerString(provider);

    const cleanEventName = ProviderEventService.cleanLowerString(eventName);

    const cleanProviderEventId = ProviderEventService.cleanString(providerEventId);

    const cleanProviderReference = ProviderEventService.cleanString(providerReference);

    const cleanProviderRefundId = ProviderEventService.cleanString(providerRefundId);

    const cleanProviderRefundReference = ProviderEventService.cleanString(providerRefundReference);

    if (!cleanProvider) {
      throw new Error("Provider is required.");
    }

    if (!cleanEventName) {
      throw new Error("Provider event name is required.");
    }

    /*
     * Prefer the provider's actual webhook/event ID
     * whenever one exists.
     */
    if (cleanProviderEventId) {
      return `${cleanProvider}:event:${cleanProviderEventId}`;
    }

    /*
     * Refund lifecycle webhooks may not expose a
     * separate event ID.
     *
     * eventName is deliberately included because the
     * same refund can legitimately generate:
     *
     * refund.pending
     * refund.processing
     * refund.needs-attention
     * refund.failed
     * refund.processed
     *
     * A duplicate delivery of the same lifecycle event
     * should still resolve to the same eventKey.
     */
    if (cleanProviderRefundId) {
      return `${cleanProvider}:${cleanEventName}:refund:${cleanProviderRefundId}`;
    }

    if (cleanProviderRefundReference) {
      return `${cleanProvider}:${cleanEventName}:refund-reference:${cleanProviderRefundReference}`;
    }

    if (cleanProviderReference) {
      return `${cleanProvider}:${cleanEventName}:reference:${cleanProviderReference}`;
    }

    throw new Error(
      "Provider event ID, provider refund ID, provider refund reference or provider reference is required."
    );
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getProviderEventById(providerEventRecordId, options = {}) {
    if (!providerEventRecordId) {
      throw new Error("Provider event record ID is required.");
    }

    const query = ProviderEvent.findById(providerEventRecordId);

    if (options.session) {
      query.session(options.session);
    }

    const providerEvent = await query;

    if (!providerEvent) {
      throw new Error("Provider event not found.");
    }

    return providerEvent;
  }

  /* ─────────────────────────────── RECORD EVENT ─────────────────────────────── */

  static async recordProviderEvent(
    {
      provider,
      eventName,
      eventCategory = "other",

      providerEventId = null,
      providerReference = null,

      providerRefundId = null,
      providerRefundReference = null,

      eventKey = null,

      isVerified = false,

      amount = null,
      providerFee = null,
      netAmount = null,

      countryCode = "NG",
      currency = "NGN",

      user = null,
      employer = null,
      professional = null,
      wallet = null,
      transaction = null,
      dva = null,
      bankAccount = null,
      shift = null,
      shiftApplication = null,

      employerRefundBatch = null,
      employerRefundBatchLineId = null,

      rawHeaders = {},
      rawPayload = {},
      normalizedPayload = {},
      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

      const cleanProvider = ProviderEventService.cleanLowerString(provider);

      const cleanEventName = ProviderEventService.cleanLowerString(eventName);

      const cleanEventCategory = ProviderEventService.normalizeEventCategory(eventCategory);

      const cleanProviderEventId = ProviderEventService.cleanString(providerEventId);

      const cleanProviderReference = ProviderEventService.cleanString(providerReference);

      const cleanProviderRefundId = ProviderEventService.cleanString(providerRefundId);

      const cleanProviderRefundReference =
        ProviderEventService.cleanString(providerRefundReference);

      const {
        employerRefundBatch: normalizedEmployerRefundBatch,

        employerRefundBatchLineId: normalizedEmployerRefundBatchLineId,
      } = ProviderEventService.assertEmployerRefundExecutionLinkPair({
        employerRefundBatch,
        employerRefundBatchLineId,
      });

      const cleanEventKey =
        ProviderEventService.cleanString(eventKey) ||
        ProviderEventService.buildEventKey({
          provider: cleanProvider,
          eventName: cleanEventName,

          providerEventId: cleanProviderEventId,

          providerReference: cleanProviderReference,

          providerRefundId: cleanProviderRefundId,

          providerRefundReference: cleanProviderRefundReference,
        });

      const normalizedAmount = ProviderEventService.normalizeOptionalMinorUnitAmount(
        amount,
        "Provider event amount"
      );

      const normalizedProviderFee = ProviderEventService.normalizeOptionalMinorUnitAmount(
        providerFee,
        "Provider event fee"
      );

      const normalizedNetAmount = ProviderEventService.normalizeOptionalMinorUnitAmount(
        netAmount,
        "Provider event net amount"
      );

      if (
        normalizedAmount !== null &&
        normalizedProviderFee !== null &&
        normalizedProviderFee > normalizedAmount
      ) {
        throw new Error("Provider event fee cannot be greater than amount.");
      }

      if (
        normalizedAmount !== null &&
        normalizedNetAmount !== null &&
        normalizedNetAmount > normalizedAmount
      ) {
        throw new Error("Provider event net amount cannot be greater than amount.");
      }

      const providerEventData = {
        provider: cleanProvider,

        eventKey: cleanEventKey,

        providerEventId: cleanProviderEventId,

        providerReference: cleanProviderReference,

        providerRefundId: cleanProviderRefundId,

        providerRefundReference: cleanProviderRefundReference,

        eventName: cleanEventName,

        eventCategory: cleanEventCategory,

        isVerified: Boolean(isVerified),

        verifiedAt: isVerified ? normalizedCurrentTime : null,

        status: "received",

        receivedAt: normalizedCurrentTime,

        amount: normalizedAmount,

        providerFee: normalizedProviderFee,

        netAmount: normalizedNetAmount,

        countryCode,
        currency,

        user,
        employer,
        professional,
        wallet,
        transaction,
        dva,
        bankAccount,
        shift,
        shiftApplication,

        employerRefundBatch: normalizedEmployerRefundBatch,

        employerRefundBatchLineId: normalizedEmployerRefundBatchLineId,

        rawHeaders,
        rawPayload,
        normalizedPayload,
        metadata,
      };

      try {
        const [providerEvent] = await ProviderEvent.create([providerEventData], {
          session,
        });

        return {
          providerEvent,
          created: true,
          idempotent: false,
        };
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }

        const duplicateConditions = [
          {
            eventKey: cleanEventKey,
          },
        ];

        if (cleanProviderEventId) {
          duplicateConditions.push({
            provider: cleanProvider,

            providerEventId: cleanProviderEventId,
          });
        }

        const duplicateQuery = ProviderEvent.findOne({
          $or: duplicateConditions,
        });

        duplicateQuery.session(session);

        const existingProviderEvent = await duplicateQuery;

        if (!existingProviderEvent) {
          throw error;
        }

        return {
          providerEvent: existingProviderEvent,

          created: false,

          idempotent: true,
        };
      }
    });
  }

  /* ─────────────────────────────── LINK EMPLOYER REFUND EXECUTION ─────────────────────────────── */

  static async linkEmployerRefundExecution(
    {
      providerEventRecordId,

      employerRefundBatch,
      employerRefundBatchLineId,

      providerRefundId = null,
      providerRefundReference = null,

      employer = null,
      shift = null,

      normalizedPayload = null,
      metadata = {},
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      ProviderEventService.applyEmployerRefundExecutionLink(providerEvent, {
        employerRefundBatch,
        employerRefundBatchLineId,

        providerRefundId,
        providerRefundReference,

        employer,
        shift,
      });

      if (normalizedPayload) {
        providerEvent.normalizedPayload = normalizedPayload;
      }

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),

        ...metadata,
      };

      await providerEvent.save({
        session,
      });

      return {
        providerEvent,
      };
    });
  }

  /* ─────────────────────────────── MARK PROCESSING ─────────────────────────────── */

  static async markProcessing(
    {
      providerEventRecordId,

      currentTime = new Date(),
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        return {
          providerEvent,

          alreadyProcessed: true,
        };
      }

      if (providerEvent.status === "ignored") {
        throw new Error("Ignored provider event cannot be processed.");
      }

      if (!providerEvent.isVerified) {
        throw new Error("Unverified provider event cannot be processed.");
      }

      if (providerEvent.status === "processing") {
        return {
          providerEvent,

          alreadyProcessing: true,
        };
      }

      providerEvent.status = "processing";

      /*
       * Preserve the original processing
       * start for audit history.
       *
       * A failed event may later be retried,
       * but retrying must not replace the
       * first time processing started.
       */
      providerEvent.processingStartedAt =
        providerEvent.processingStartedAt || normalizedCurrentTime;

      providerEvent.nextRetryAt = null;

      await providerEvent.save({
        session,
      });

      return {
        providerEvent,

        alreadyProcessing: false,
      };
    });
  }

  /* ─────────────────────────────── MARK PROCESSED ─────────────────────────────── */

  static async markProcessed(
    {
      providerEventRecordId,

      transaction = null,
      wallet = null,

      employer = null,
      professional = null,

      dva = null,
      bankAccount = null,

      shift = null,
      shiftApplication = null,

      employerRefundBatch = null,
      employerRefundBatchLineId = null,

      providerRefundId = null,
      providerRefundReference = null,

      normalizedPayload = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        return {
          providerEvent,

          alreadyProcessed: true,
        };
      }

      if (providerEvent.status === "ignored") {
        throw new Error("Ignored provider event cannot be marked as processed.");
      }

      if (!providerEvent.isVerified) {
        throw new Error("Unverified provider event cannot be marked as processed.");
      }

      const hasIncomingRefundBatch = ProviderEventService.hasValue(employerRefundBatch);

      const hasIncomingRefundLine = ProviderEventService.hasValue(employerRefundBatchLineId);

      if (hasIncomingRefundBatch || hasIncomingRefundLine) {
        ProviderEventService.applyEmployerRefundExecutionLink(providerEvent, {
          employerRefundBatch,
          employerRefundBatchLineId,

          providerRefundId,
          providerRefundReference,

          employer,
          shift,
        });
      } else {
        const cleanProviderRefundId = ProviderEventService.cleanString(providerRefundId);

        const cleanProviderRefundReference =
          ProviderEventService.cleanString(providerRefundReference);

        if (cleanProviderRefundId) {
          if (
            providerEvent.providerRefundId &&
            providerEvent.providerRefundId !== cleanProviderRefundId
          ) {
            throw new Error("Provider event is already linked to a different provider refund ID.");
          }

          providerEvent.providerRefundId = cleanProviderRefundId;
        }

        if (cleanProviderRefundReference) {
          if (
            providerEvent.providerRefundReference &&
            providerEvent.providerRefundReference !== cleanProviderRefundReference
          ) {
            throw new Error(
              "Provider event is already linked to a different provider refund reference."
            );
          }

          providerEvent.providerRefundReference = cleanProviderRefundReference;
        }
      }

      providerEvent.status = "processed";

      providerEvent.processingStartedAt =
        providerEvent.processingStartedAt || normalizedCurrentTime;

      providerEvent.processedAt = normalizedCurrentTime;

      providerEvent.nextRetryAt = null;

      if (transaction) {
        providerEvent.transaction = transaction;
      }

      if (wallet) {
        providerEvent.wallet = wallet;
      }

      if (employer) {
        providerEvent.employer = employer;
      }

      if (professional) {
        providerEvent.professional = professional;
      }

      if (dva) {
        providerEvent.dva = dva;
      }

      if (bankAccount) {
        providerEvent.bankAccount = bankAccount;
      }

      if (shift) {
        providerEvent.shift = shift;
      }

      if (shiftApplication) {
        providerEvent.shiftApplication = shiftApplication;
      }

      if (normalizedPayload) {
        providerEvent.normalizedPayload = normalizedPayload;
      }

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),

        ...metadata,
      };

      await providerEvent.save({
        session,
      });

      return {
        providerEvent,

        alreadyProcessed: false,
      };
    });
  }

  /* ─────────────────────────────── MARK FAILED ─────────────────────────────── */

  static async markFailed(
    {
      providerEventRecordId,

      failureReason,

      retryable = false,

      nextRetryAt = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        throw new Error("Processed provider event cannot be marked as failed.");
      }

      if (providerEvent.status === "ignored") {
        throw new Error("Ignored provider event cannot be marked as failed.");
      }

      let normalizedNextRetryAt = null;

      if (retryable) {
        if (!nextRetryAt) {
          throw new Error("A retryable provider event failure requires nextRetryAt.");
        }

        normalizedNextRetryAt = ProviderEventService.normalizeCurrentTime(nextRetryAt);

        if (normalizedNextRetryAt.getTime() <= normalizedCurrentTime.getTime()) {
          throw new Error("Provider event next retry time must be in the future.");
        }
      }

      providerEvent.status = "failed";

      providerEvent.failedAt = normalizedCurrentTime;

      providerEvent.failureReason =
        ProviderEventService.cleanString(failureReason) || "Provider event processing failed.";

      providerEvent.retryCount = Number(providerEvent.retryCount || 0) + 1;

      providerEvent.nextRetryAt = retryable ? normalizedNextRetryAt : null;

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),

        ...metadata,
      };

      await providerEvent.save({
        session,
      });

      return {
        providerEvent,
      };
    });
  }

  /* ─────────────────────────────── MARK IGNORED ─────────────────────────────── */

  static async markIgnored(
    {
      providerEventRecordId,

      ignoredReason,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        throw new Error("Processed provider event cannot be ignored.");
      }

      if (providerEvent.status === "ignored") {
        return {
          providerEvent,

          alreadyIgnored: true,
        };
      }

      providerEvent.status = "ignored";

      providerEvent.ignoredAt = normalizedCurrentTime;

      providerEvent.ignoredReason =
        ProviderEventService.cleanString(ignoredReason) || "Provider event ignored.";

      providerEvent.nextRetryAt = null;

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),

        ...metadata,
      };

      await providerEvent.save({
        session,
      });

      return {
        providerEvent,

        alreadyIgnored: false,
      };
    });
  }
}

module.exports = ProviderEventService;
