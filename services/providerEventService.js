// services/providerEventService.js

const mongoose = require("mongoose");

const ProviderEvent = require("../models/ProviderEvent");

const money = require("../utils/money");

class ProviderEventService {
  /* ---------- Run with existing session or create new transaction ---------- */
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

  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Clean lowercase string ---------- */
  static cleanLowerString(value) {
    const cleanValue = ProviderEventService.cleanString(value);

    return cleanValue ? cleanValue.toLowerCase() : null;
  }

  /* ---------- Normalize optional minor-unit amount ---------- */
  static normalizeOptionalMinorUnitAmount(value, label) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return money.normalizeMinorUnitAmount(value, label);
  }

  /* ---------- Build provider event key ---------- */
  static buildEventKey({ provider, eventName, providerEventId = null, providerReference = null }) {
    const cleanProvider = ProviderEventService.cleanLowerString(provider);
    const cleanEventName = ProviderEventService.cleanLowerString(eventName);
    const cleanProviderEventId = ProviderEventService.cleanString(providerEventId);
    const cleanProviderReference = ProviderEventService.cleanString(providerReference);

    if (!cleanProvider) {
      throw new Error("Provider is required.");
    }

    if (!cleanEventName) {
      throw new Error("Provider event name is required.");
    }

    if (cleanProviderEventId) {
      return `${cleanProvider}:event:${cleanProviderEventId}`;
    }

    if (cleanProviderReference) {
      return `${cleanProvider}:${cleanEventName}:reference:${cleanProviderReference}`;
    }

    throw new Error("Provider event ID or provider reference is required.");
  }

  /* ---------- Find provider event by ID ---------- */
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

  /* ---------- Record provider event idempotently ---------- */
  static async recordProviderEvent(
    {
      provider,
      eventName,
      eventCategory = "other",

      providerEventId = null,
      providerReference = null,
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

      rawHeaders = {},
      rawPayload = {},
      normalizedPayload = {},
      metadata = {},
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const cleanProvider = ProviderEventService.cleanLowerString(provider);
      const cleanEventName = ProviderEventService.cleanLowerString(eventName);
      const cleanProviderEventId = ProviderEventService.cleanString(providerEventId);
      const cleanProviderReference = ProviderEventService.cleanString(providerReference);

      const cleanEventKey =
        ProviderEventService.cleanString(eventKey) ||
        ProviderEventService.buildEventKey({
          provider: cleanProvider,
          eventName: cleanEventName,
          providerEventId: cleanProviderEventId,
          providerReference: cleanProviderReference,
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

        eventName: cleanEventName,
        eventCategory,

        isVerified,
        verifiedAt: isVerified ? new Date() : null,

        status: "received",
        receivedAt: new Date(),

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

        const duplicateQuery = ProviderEvent.findOne({
          $or: [
            { eventKey: cleanEventKey },
            ...(cleanProviderEventId
              ? [{ provider: cleanProvider, providerEventId: cleanProviderEventId }]
              : []),
          ],
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

  /* ---------- Mark provider event as processing ---------- */
  static async markProcessing({ providerEventRecordId }, options = {}) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
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

      providerEvent.status = "processing";
      providerEvent.processingStartedAt = new Date();

      await providerEvent.save({ session });

      return {
        providerEvent,
      };
    });
  }

  /* ---------- Mark provider event as processed ---------- */
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

      normalizedPayload = null,
      metadata = {},
    },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
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

      providerEvent.status = "processed";
      providerEvent.processedAt = new Date();

      providerEvent.transaction = transaction || providerEvent.transaction;
      providerEvent.wallet = wallet || providerEvent.wallet;
      providerEvent.employer = employer || providerEvent.employer;
      providerEvent.professional = professional || providerEvent.professional;
      providerEvent.dva = dva || providerEvent.dva;
      providerEvent.bankAccount = bankAccount || providerEvent.bankAccount;
      providerEvent.shift = shift || providerEvent.shift;
      providerEvent.shiftApplication = shiftApplication || providerEvent.shiftApplication;

      if (normalizedPayload) {
        providerEvent.normalizedPayload = normalizedPayload;
      }

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),
        ...metadata,
      };

      await providerEvent.save({ session });

      return {
        providerEvent,
      };
    });
  }

  /* ---------- Mark provider event as failed ---------- */
  static async markFailed(
    { providerEventRecordId, failureReason, retryable = false, nextRetryAt = null, metadata = {} },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        throw new Error("Processed provider event cannot be marked as failed.");
      }

      if (providerEvent.status === "ignored") {
        throw new Error("Ignored provider event cannot be marked as failed.");
      }

      providerEvent.status = "failed";
      providerEvent.failedAt = new Date();
      providerEvent.failureReason = failureReason || "Provider event processing failed.";
      providerEvent.retryCount = Number(providerEvent.retryCount || 0) + 1;
      providerEvent.nextRetryAt = retryable ? nextRetryAt : null;

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),
        ...metadata,
      };

      await providerEvent.save({ session });

      return {
        providerEvent,
      };
    });
  }

  /* ---------- Mark provider event as ignored ---------- */
  static async markIgnored({ providerEventRecordId, ignoredReason, metadata = {} }, options = {}) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
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
      providerEvent.ignoredAt = new Date();
      providerEvent.ignoredReason = ignoredReason || "Provider event ignored.";
      providerEvent.nextRetryAt = null;

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),
        ...metadata,
      };

      await providerEvent.save({ session });

      return {
        providerEvent,
      };
    });
  }
}

module.exports = ProviderEventService;
