// services/providerEventService.js

const crypto = require("crypto");
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

  static normalizeProcessingClaimId(value, { required = true } = {}) {
    const processingClaimId = ProviderEventService.cleanString(value);

    if (required && !processingClaimId) {
      throw ProviderEventService.createProcessingClaimError({
        message: "Provider event processing claim ID is required.",

        code: "PROVIDER_EVENT_PROCESSING_CLAIM_REQUIRED",
      });
    }

    if (processingClaimId && processingClaimId.length > 100) {
      throw ProviderEventService.createProcessingClaimError({
        message: "Provider event processing claim ID is invalid.",

        code: "INVALID_PROVIDER_EVENT_PROCESSING_CLAIM",
      });
    }

    return processingClaimId;
  }

  static hasValue(value) {
    return !(value === null || value === undefined || value === "");
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  /* ─────────────────────────────── PROCESSING CLAIMS ─────────────────────────────── */

  static createProcessingClaimError({ message, code }) {
    const error = new Error(message);

    error.name = "ProviderEventProcessingClaimError";

    error.code = code;

    error.statusCode = 409;

    error.retryable = false;

    return error;
  }

  static generateProcessingClaimId() {
    return crypto.randomUUID();
  }

  static assertActiveProcessingClaim(providerEvent, processingClaimId) {
    const normalizedProcessingClaimId =
      ProviderEventService.normalizeProcessingClaimId(processingClaimId);

    if (providerEvent.status !== "processing") {
      throw ProviderEventService.createProcessingClaimError({
        message: "Provider event processing claim is no longer active.",

        code: "PROVIDER_EVENT_PROCESSING_CLAIM_INACTIVE",
      });
    }

    const activeProcessingClaimId = ProviderEventService.cleanString(
      providerEvent.processingClaimId
    );

    if (!activeProcessingClaimId) {
      throw ProviderEventService.createProcessingClaimError({
        message: "Provider event has no active processing claim.",

        code: "PROVIDER_EVENT_PROCESSING_CLAIM_MISSING",
      });
    }

    if (activeProcessingClaimId !== normalizedProcessingClaimId) {
      throw ProviderEventService.createProcessingClaimError({
        message:
          "Provider event processing claim does not belong to the current processing attempt.",

        code: "PROVIDER_EVENT_PROCESSING_CLAIM_MISMATCH",
      });
    }

    return normalizedProcessingClaimId;
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
     * eventName remains part of the key because one
     * refund can emit multiple lifecycle events.
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
   * Finds retryable failed events whose persisted
   * retry deadline has arrived.
   *
   * Finding is not ownership. markProcessing()
   * remains the atomic processing claim.
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

  /*
   * Finds processing claims whose latest processing
   * attempt has exceeded the allowed worker lifetime.
   *
   * Legacy processing records may have only
   * processingStartedAt, so that timestamp remains a
   * compatibility fallback.
   *
   * Finding a stale event does not recover or process
   * it. Recovery remains a separate atomic operation.
   */
  static async getStaleProcessingProviderEventIds(
    { currentTime = new Date(), staleProcessingMinutes = 30, limit = 100 } = {},
    options = {}
  ) {
    const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

    const normalizedStaleProcessingMinutes = ProviderEventService.normalizePositiveInteger(
      staleProcessingMinutes,
      "Provider event stale processing minutes"
    );

    const normalizedLimit = ProviderEventService.normalizePositiveInteger(
      limit,
      "Provider event stale processing limit"
    );

    const staleBefore = new Date(
      normalizedCurrentTime.getTime() - normalizedStaleProcessingMinutes * 60 * 1000
    );

    const query = ProviderEvent.find({
      isVerified: true,

      status: "processing",

      $or: [
        {
          lastProcessingStartedAt: {
            $ne: null,
            $lte: staleBefore,
          },
        },
        {
          lastProcessingStartedAt: null,

          processingStartedAt: {
            $ne: null,
            $lte: staleBefore,
          },
        },
      ],
    })
      .sort({
        lastProcessingStartedAt: 1,
        processingStartedAt: 1,
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

        processingClaimId: null,

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

      /*
       * Linking the refund execution mutates a
       * ProviderEvent that is currently being processed.
       *
       * Only the worker that owns the current processing
       * claim may persist this intermediate state.
       *
       * This prevents a stale Worker A from modifying
       * the ProviderEvent after Worker B has reclaimed it.
       */
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

  /*
   * Atomically claims one verified received/failed event.
   *
   * processingStartedAt is the first-ever processing
   * attempt and is never replaced.
   *
   * lastProcessingStartedAt is updated every time a
   * new processing claim succeeds.
   *
   * processingClaimId identifies only the currently
   * active processing attempt.
   *
   * Only the worker that changes the status to
   * processing owns execution.
   */
  static async markProcessing(
    {
      providerEventRecordId,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

    const normalizedProviderEventRecordId =
      ProviderEventService.normalizeProviderEventRecordId(providerEventRecordId);

    /*
     * The service generates the claim.
     *
     * The scheduler/caller cannot choose processing
     * ownership by supplying its own claim ID.
     */
    const processingClaimId = ProviderEventService.generateProcessingClaimId();

    const baseClaimFilter = {
      _id: normalizedProviderEventRecordId,

      isVerified: true,

      status: {
        $in: ["received", "failed"],
      },
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
     * First-ever claim.
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
     * Retry claim.
     *
     * Preserve the permanent first-start timestamp.
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

        processingClaimId,

        claimedForProcessing: true,

        alreadyProcessing: false,

        alreadyProcessed: false,
      };
    }

    /*
     * Neither claim matched.
     *
     * Reload only to explain why. This read never
     * grants processing ownership.
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

        processingClaimId: null,

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

        /*
         * Do not return the current owner's claim as
         * this worker did not win ownership.
         */
        processingClaimId: null,

        claimedForProcessing: false,

        alreadyProcessed: false,

        alreadyProcessing: true,
      };
    }

    throw new Error(
      `Provider event in ${providerEvent.status} status could not be claimed for processing.`
    );
  }

  /* ─────────────────────────────── RECOVER STALE PROCESSING ─────────────────────────────── */

  /*
   * Releases one abandoned processing claim.
   *
   * Recovery invalidates the stale worker's ownership
   * token before the event becomes retryable.
   *
   * A new worker must still win markProcessing()
   * before any event-specific processing continues.
   */
  static async recoverStaleProcessingProviderEvent(
    {
      providerEventRecordId,

      currentTime = new Date(),

      staleProcessingMinutes = 30,
    },
    options = {}
  ) {
    const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

    const normalizedStaleProcessingMinutes = ProviderEventService.normalizePositiveInteger(
      staleProcessingMinutes,
      "Provider event stale processing minutes"
    );

    const normalizedProviderEventRecordId =
      ProviderEventService.normalizeProviderEventRecordId(providerEventRecordId);

    const staleBefore = new Date(
      normalizedCurrentTime.getTime() - normalizedStaleProcessingMinutes * 60 * 1000
    );

    /*
     * Recovery is atomic.
     *
     * If the worker completed or another recovery
     * already changed the event, this no longer
     * matches.
     */
    const recoveredProviderEvent = await ProviderEvent.findOneAndUpdate(
      {
        _id: normalizedProviderEventRecordId,

        isVerified: true,

        status: "processing",

        $or: [
          {
            lastProcessingStartedAt: {
              $ne: null,
              $lte: staleBefore,
            },
          },
          {
            lastProcessingStartedAt: null,

            processingStartedAt: {
              $ne: null,
              $lte: staleBefore,
            },
          },
        ],
      },
      {
        $set: {
          status: "failed",

          /*
           * Explicitly invalidate Worker A's
           * processing ownership.
           */
          processingClaimId: null,

          failedAt: normalizedCurrentTime,

          failureReason: "Provider event processing claim became stale before completion.",

          /*
           * Immediately eligible for normal
           * retry discovery.
           */
          nextRetryAt: normalizedCurrentTime,

          processedAt: null,

          ignoredAt: null,

          ignoredReason: null,
        },

        $inc: {
          retryCount: 1,
        },
      },
      {
        new: true,

        runValidators: true,

        context: "query",

        session: options.session || null,
      }
    );

    if (recoveredProviderEvent) {
      return {
        providerEvent: recoveredProviderEvent,

        recovered: true,

        retryDue: true,

        staleBefore,
      };
    }

    const providerEvent = await ProviderEventService.getProviderEventById(
      normalizedProviderEventRecordId,
      {
        session: options.session,
      }
    );

    if (providerEvent.status === "processed") {
      return {
        providerEvent,

        recovered: false,

        alreadyProcessed: true,
      };
    }

    if (providerEvent.status === "ignored") {
      return {
        providerEvent,

        recovered: false,

        alreadyIgnored: true,
      };
    }

    if (providerEvent.status === "failed") {
      return {
        providerEvent,

        recovered: false,

        alreadyFailed: true,

        retryDue:
          Boolean(providerEvent.nextRetryAt) &&
          new Date(providerEvent.nextRetryAt).getTime() <= normalizedCurrentTime.getTime(),
      };
    }

    if (!providerEvent.isVerified) {
      return {
        providerEvent,

        recovered: false,

        unverified: true,
      };
    }

    if (providerEvent.status === "processing") {
      const effectiveProcessingStartedAt =
        providerEvent.lastProcessingStartedAt || providerEvent.processingStartedAt || null;

      return {
        providerEvent,

        recovered: false,

        stillProcessing: true,

        stale: Boolean(
          effectiveProcessingStartedAt &&
          new Date(effectiveProcessingStartedAt).getTime() <= staleBefore.getTime()
        ),

        effectiveProcessingStartedAt,

        staleBefore,
      };
    }

    return {
      providerEvent,

      recovered: false,

      status: providerEvent.status,
    };
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

      /*
       * Idempotent read-only completion remains safe.
       *
       * No mutation occurs if another worker already
       * completed the event.
       */
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

      /*
       * Only the worker that currently owns this
       * processing attempt may complete it.
       */
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

      /*
       * Completion invalidates the active claim.
       *
       * Historical first/latest timestamps remain.
       */
      providerEvent.processingClaimId = null;

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
       * Normal processing failures are claim-bound.
       */
      if (providerEvent.status === "processing") {
        ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);
      } else {
        /*
         * The only legitimate claimless failure path
         * is rejection of an unverified received
         * event before processing ever begins.
         *
         * A stale Worker A therefore cannot mark a
         * recovered failed event again.
         */
        const isUnverifiedReceivedEvent =
          providerEvent.status === "received" && providerEvent.isVerified !== true;

        if (!isUnverifiedReceivedEvent) {
          throw ProviderEventService.createProcessingClaimError({
            message: "Provider event is no longer owned by this processing attempt.",

            code: "PROVIDER_EVENT_PROCESSING_CLAIM_INACTIVE",
          });
        }

        if (ProviderEventService.cleanString(processingClaimId)) {
          throw ProviderEventService.createProcessingClaimError({
            message: "Unverified received provider event must not carry a processing claim.",

            code: "INVALID_PROVIDER_EVENT_PROCESSING_CLAIM",
          });
        }
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

      /*
       * Leaving processing invalidates ownership.
       */
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

      /*
       * Idempotent read-only result.
       */
      if (providerEvent.status === "ignored") {
        return {
          providerEvent,

          alreadyIgnored: true,
        };
      }

      if (!providerEvent.isVerified) {
        throw new Error("Unverified provider event cannot be ignored after processing.");
      }

      /*
       * Ignore is a terminal result of the active
       * processing attempt, so it is claim-bound.
       */
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
