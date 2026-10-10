// services/providerEventService.js

const mongoose = require("mongoose");
const crypto = require("crypto");

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

  static normalizePositiveInteger(value, label) {
    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
      throw new Error(`${label} must be a positive integer.`);
    }

    return normalizedValue;
  }

  static normalizeProviderEventRecordId(value) {
    if (!value || !mongoose.isValidObjectId(value)) {
      throw new Error("A valid provider event record ID is required.");
    }

    return new mongoose.Types.ObjectId(String(value));
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
    const { employerRefundBatch: normalizedBatch, employerRefundBatchLineId: normalizedLineId } =
      ProviderEventService.assertEmployerRefundExecutionLinkPair({
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

  /* ─────────────────────────────── DVA EVENT VALIDATION ─────────────────────────────── */

  static isDVAAssignmentEvent(provider, eventName) {
    return (
      ProviderEventService.cleanLowerString(provider) === "paystack" &&
      ["dedicatedaccount.assign.success", "dedicatedaccount.assign.failed"].includes(
        ProviderEventService.cleanLowerString(eventName)
      )
    );
  }

  static assertDVAAssignmentCategory(provider, eventName, eventCategory) {
    const assignment = ProviderEventService.isDVAAssignmentEvent(provider, eventName);

    if (assignment !== (eventCategory === "dva_assignment")) {
      throw new Error("Paystack DVA assignment event/category mismatch.");
    }
  }

  /* ─────────────────────────────── DUPLICATE VALIDATION ─────────────────────────────── */

  static assertMatchingDuplicate(existing, { provider, eventName, eventCategory, eventKey }) {
    if (
      existing.provider !== provider ||
      existing.eventName !== eventName ||
      existing.eventCategory !== eventCategory ||
      existing.eventKey !== eventKey
    ) {
      throw new Error(
        "Provider event idempotency key is already associated with a different event."
      );
    }

    return existing;
  }

  /* ─────────────────────────────── PROCESSING CLAIM VALIDATION ─────────────────────────────── */

  static createProcessingClaimError(code, message) {
    const error = new Error(message);

    error.code = code;
    error.statusCode = 409;
    error.retryable = false;

    return error;
  }

  static assertActiveProcessingClaim(providerEvent, processingClaimId) {
    const claim = ProviderEventService.cleanString(processingClaimId);

    if (!claim) {
      throw ProviderEventService.createProcessingClaimError(
        "PROVIDER_EVENT_PROCESSING_CLAIM_REQUIRED",
        "A processing claim ID is required to complete this provider event."
      );
    }

    if (providerEvent.status !== "processing" || providerEvent.processingClaimId !== claim) {
      throw ProviderEventService.createProcessingClaimError(
        "PROVIDER_EVENT_PROCESSING_CLAIM_LOST",
        "Provider event processing claim is no longer owned by this worker."
      );
    }

    return true;
  }

  /* ─────────────────────────────── EVENT KEY ─────────────────────────────── */

  static buildEventKey({
    provider,
    eventName,
    providerEventId = null,
    providerReference = null,
    providerRefundId = null,
    providerRefundReference = null,
    rawPayload = null,
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
     * Refund lifecycle events may not have their own
     * event ID. Keep the lifecycle event name in the key.
     */

    if (cleanProviderRefundId) {
      return `${cleanProvider}:${cleanEventName}:refund:${cleanProviderRefundId}`;
    }

    if (cleanProviderRefundReference) {
      return `${cleanProvider}:${cleanEventName}:refund-reference:${cleanProviderRefundReference}`;
    }

    /*
     * DVA assignment notifications can lack a conventional
     * transaction reference or provider event ID.
     *
     * Fingerprint the signed event payload to distinguish
     * separate attempts while deduplicating redelivery.
     */

    if (ProviderEventService.isDVAAssignmentEvent(cleanProvider, cleanEventName)) {
      if (
        !rawPayload ||
        typeof rawPayload !== "object" ||
        Array.isArray(rawPayload) ||
        !rawPayload.data ||
        typeof rawPayload.data !== "object" ||
        Array.isArray(rawPayload.data)
      ) {
        throw new Error("Signed Paystack DVA assignment payload is required for an event key.");
      }

      const digest = crypto.createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");

      return `${cleanProvider}:${cleanEventName}:payload:${digest}`;
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
    const normalizedProviderEventRecordId =
      ProviderEventService.normalizeProviderEventRecordId(providerEventRecordId);

    const query = ProviderEvent.findById(normalizedProviderEventRecordId);

    if (options.session) {
      query.session(options.session);
    }

    const providerEvent = await query;

    if (!providerEvent) {
      throw new Error("Provider event not found.");
    }

    return providerEvent;
  }

  /*
   * Finds retryable events whose persisted retry deadline
   * has arrived. Finding does not confer ownership.
   */

  static async getDueRetryProviderEventIds(
    { currentTime = new Date(), limit = 100 } = {},
    options = {}
  ) {
    const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

    const normalizedLimit = ProviderEventService.normalizePositiveInteger(
      limit,
      "Provider event retry limit"
    );

    const query = ProviderEvent.find({
      isVerified: true,
      status: "failed",
      nextRetryAt: {
        $ne: null,
        $lte: normalizedCurrentTime,
      },
    })
      .sort({
        nextRetryAt: 1,
        _id: 1,
      })
      .limit(normalizedLimit)
      .select("_id")
      .lean();

    if (options.session) {
      query.session(options.session);
    }

    const providerEvents = await query;

    return providerEvents.map((providerEvent) => String(providerEvent._id));
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
    let duplicateIdentity = null;

    try {
      return await ProviderEventService.runWithOptionalTransaction(options, async (session) => {
        const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

        const cleanProvider = ProviderEventService.cleanLowerString(provider);

        const cleanEventName = ProviderEventService.cleanLowerString(eventName);

        const cleanEventCategory = ProviderEventService.normalizeEventCategory(eventCategory);

        const cleanProviderEventId = ProviderEventService.cleanString(providerEventId);

        const cleanProviderReference = ProviderEventService.cleanString(providerReference);

        const cleanProviderRefundId = ProviderEventService.cleanString(providerRefundId);

        const cleanProviderRefundReference =
          ProviderEventService.cleanString(providerRefundReference);

        ProviderEventService.assertDVAAssignmentCategory(
          cleanProvider,
          cleanEventName,
          cleanEventCategory
        );

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
            rawPayload,
          });

        duplicateIdentity = {
          provider: cleanProvider,
          eventName: cleanEventName,
          eventCategory: cleanEventCategory,
          eventKey: cleanEventKey,
          providerEventId: cleanProviderEventId,
        };

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

        /*
         * Return an already recorded delivery before
         * attempting a duplicate insert.
         */

        const prior = await ProviderEvent.findOne({
          eventKey: cleanEventKey,
        }).session(session);

        if (prior) {
          ProviderEventService.assertMatchingDuplicate(prior, {
            provider: cleanProvider,
            eventName: cleanEventName,
            eventCategory: cleanEventCategory,
            eventKey: cleanEventKey,
          });

          return {
            providerEvent: prior,
            created: false,
            idempotent: true,
          };
        }

        const [providerEvent] = await ProviderEvent.create([providerEventData], {
          session,
        });

        return {
          providerEvent,
          created: true,
          idempotent: false,
        };
      });
    } catch (error) {
      /*
       * A duplicate-key error aborts the transaction.
       * Resolve concurrent duplicates after it ends.
       */

      if (error?.code !== 11000 || options.session || !duplicateIdentity) {
        throw error;
      }

      const predicates = [
        {
          eventKey: duplicateIdentity.eventKey,
        },
      ];

      if (duplicateIdentity.providerEventId) {
        predicates.push({
          provider: duplicateIdentity.provider,
          providerEventId: duplicateIdentity.providerEventId,
        });
      }

      const existing = await ProviderEvent.findOne({
        $or: predicates,
      });

      if (!existing) {
        throw error;
      }

      ProviderEventService.assertMatchingDuplicate(existing, duplicateIdentity);

      return {
        providerEvent: existing,
        created: false,
        idempotent: true,
      };
    }
  }

  /* ─────────────────────────────── LINK EMPLOYER REFUND EXECUTION ─────────────────────────────── */

  static async linkEmployerRefundExecution(
    {
      providerEventRecordId,
      processingClaimId,

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

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

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

  static async markProcessing({ providerEventRecordId, currentTime = new Date() }, options = {}) {
    const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

    const normalizedProviderEventRecordId =
      ProviderEventService.normalizeProviderEventRecordId(providerEventRecordId);

    /*
     * A fresh claim fences each processing attempt.
     * Only received or retry-due failed events qualify.
     */

    const processingClaimId = crypto.randomUUID();

    const baseClaimFilter = {
      _id: normalizedProviderEventRecordId,
      isVerified: true,

      $or: [
        {
          status: "received",
        },
        {
          status: "failed",
          nextRetryAt: {
            $ne: null,
            $lte: normalizedCurrentTime,
          },
        },
      ],
    };

    const commonClaimSet = {
      status: "processing",
      processingClaimId,

      lastProcessingStartedAt: normalizedCurrentTime,

      processedAt: null,
      failedAt: null,
      failureReason: null,

      ignoredAt: null,
      ignoredReason: null,

      nextRetryAt: null,
    };

    const claimOptions = {
      new: true,
      runValidators: true,
      context: "query",
      session: options.session || null,
    };

    /*
     * First processing attempt.
     */

    let claimedProviderEvent = await ProviderEvent.findOneAndUpdate(
      {
        ...baseClaimFilter,
        processingStartedAt: null,
      },
      {
        $set: {
          ...commonClaimSet,
          processingStartedAt: normalizedCurrentTime,
        },
      },
      claimOptions
    );

    /*
     * Subsequent retry. Preserve the first-ever
     * processing timestamp.
     */

    if (!claimedProviderEvent) {
      claimedProviderEvent = await ProviderEvent.findOneAndUpdate(
        {
          ...baseClaimFilter,
          processingStartedAt: {
            $ne: null,
          },
        },
        {
          $set: commonClaimSet,
        },
        claimOptions
      );
    }

    if (claimedProviderEvent) {
      return {
        providerEvent: claimedProviderEvent,
        claimedForProcessing: true,
        processingClaimId,
        alreadyProcessing: false,
        alreadyProcessed: false,
      };
    }

    /*
     * Reload only to explain why claiming failed.
     * The reload does not grant ownership.
     */

    const providerEvent = await ProviderEventService.getProviderEventById(
      normalizedProviderEventRecordId,
      {
        session: options.session,
      }
    );

    if (providerEvent.status === "processed") {
      return {
        providerEvent,
        claimedForProcessing: false,
        alreadyProcessed: true,
        alreadyProcessing: false,
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
        claimedForProcessing: false,
        alreadyProcessed: false,
        alreadyProcessing: true,
      };
    }

    throw new Error(
      `Provider event in ${providerEvent.status} status could not be claimed for processing.`
    );
  }

  /* ─────────────────────────────── MARK PROCESSED ─────────────────────────────── */

  static async markProcessed(
    {
      providerEventRecordId,
      processingClaimId,

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

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

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
      providerEvent.processingClaimId = null;

      providerEvent.processingStartedAt =
        providerEvent.processingStartedAt || normalizedCurrentTime;

      providerEvent.lastProcessingStartedAt =
        providerEvent.lastProcessingStartedAt || providerEvent.processingStartedAt;

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
      processingClaimId = null,

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

      /*
       * Verified events require their active claim.
       * Unverified received events may be rejected
       * without ever entering processing.
       */

      if (providerEvent.isVerified || providerEvent.status === "processing") {
        ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);
      } else if (providerEvent.status !== "received") {
        throw new Error("Unverified provider event can only be rejected from received state.");
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
      providerEvent.processingClaimId = null;

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
      processingClaimId,

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

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

      providerEvent.status = "ignored";
      providerEvent.processingClaimId = null;

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
