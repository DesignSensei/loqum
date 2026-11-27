// services/providerEventService.js

const mongoose = require("mongoose");
const crypto = require("crypto");

const ProviderEvent = require("../models/ProviderEvent");
const DVA = require("../models/DVA");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const FinancialObligation = require("../models/FinancialObligation");

const money = require("../utils/money");

class ProviderEventService {
  /* ─────────────────────────────── TRANSACTIONS ─────────────────────────────── */

  static async runWithOptionalTransaction(options = {}, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("A transaction callback is required.");
    }

    if (options.session) {
      if (typeof options.session.inTransaction !== "function" || !options.session.inTransaction()) {
        throw new Error("Provider event writes require an active transaction.");
      }
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

  static assertMatchingDVAFundingEvidence(existing, identity) {
    const previous = existing.normalizedPayload || {};
    const incoming = identity.dvaFundingEvidence || {};

    const fields = [
      "dvaFundingTransactionId",
      "paystackCustomerId",
      "paystackCustomerCode",
      "paystackDedicatedAccountId",
      "accountNumber",
      "bankId",
      "bankCode",
      "bankSlug",
      "providerSlug",
      "domain",
    ];

    for (const field of fields) {
      if (
        previous[field] != null &&
        incoming[field] != null &&
        String(previous[field]) !== String(incoming[field])
      ) {
        throw new Error(`Duplicate DVA funding has conflicting ${field}.`);
      }
    }

    const normalizeConflicts = (value) => {
      if (value == null) return [];

      if (!Array.isArray(value)) {
        throw new Error("Invalid DVA funding identity conflicts.");
      }

      return [...new Set(value)].sort();
    };

    const previousConflicts = normalizeConflicts(previous.dvaFundingIdentityConflicts);

    const incomingConflicts = normalizeConflicts(incoming.dvaFundingIdentityConflicts);

    if (JSON.stringify(previousConflicts) !== JSON.stringify(incomingConflicts)) {
      throw new Error("Duplicate DVA funding contains different identity conflicts.");
    }

    return true;
  }

  /* ─────────────────────────────── DUPLICATE VALIDATION ─────────────────────────────── */

  static assertMatchingDuplicate(existing, identity) {
    const { provider, eventName, eventCategory, eventKey } = identity;

    const resolvedCategories =
      eventName === "transfer.success"
        ? ["employer_withdrawal_payout", "professional_withdrawal_payout", "financial_obligation_payout"]
        : ["transfer.failed", "transfer.reversed"].includes(eventName)
          ? ["employer_withdrawal_reversal", "professional_withdrawal_reversal", "financial_obligation_payout"]
          : [];

    // Classification is a state transition, not an alternate withdrawal architecture.
    const sameTransferDuringResolution =
      provider === "paystack" &&
      existing.isVerified === true &&
      identity.isVerified === true &&
      identity.providerReference &&
      existing.providerReference === identity.providerReference &&
      ((existing.eventCategory === "transfer_unresolved" &&
        resolvedCategories.includes(eventCategory)) ||
        (eventCategory === "transfer_unresolved" &&
          resolvedCategories.includes(existing.eventCategory)));

    if (
      existing.provider !== provider ||
      existing.eventName !== eventName ||
      (existing.eventCategory !== eventCategory && !sameTransferDuringResolution) ||
      existing.eventKey !== eventKey
    ) {
      throw new Error(
        "Provider event idempotency key is already associated with a different event."
      );
    }

    for (const field of [
      "amount",
      "providerFee",
      "netAmount",
      "countryCode",
      "currency",
      "isVerified",
    ]) {
      if (
        Object.prototype.hasOwnProperty.call(identity, field) &&
        (existing[field] ?? null) !== (identity[field] ?? null)
      ) {
        throw new Error(`Duplicate provider event has conflicting ${field}.`);
      }
    }

    // Processing may enrich previously absent references. Do not overwrite them,
    // but reject a retry that supplies a different non-empty reference.
    for (const field of [
      "providerEventId",
      "providerReference",
      "providerRefundId",
      "providerRefundReference",
    ]) {
      if (identity[field] != null && existing[field] !== identity[field]) {
        throw new Error(`Duplicate provider event has conflicting ${field}.`);
      }
    }

    if (provider === "paystack" && resolvedCategories.length) {
      for (const field of ["employer", "professional", "wallet", "bankAccount"]) {
        if (
          identity[field] &&
          existing[field] &&
          !ProviderEventService.sameId(identity[field], existing[field])
        ) {
          throw new Error(`Duplicate Transfer has conflicting ${field}.`);
        }
      }

      for (const field of [
        "withdrawalTransactionId",
        "recipientCode",
        "domain",
        "transferCode",
        "transferReference",
      ]) {
        const prior = existing.normalizedPayload?.[field];
        const incoming = identity[field];

        if (prior && incoming && String(prior) !== String(incoming)) {
          throw new Error(`Duplicate Transfer has conflicting ${field}.`);
        }
      }
    }

    if (provider === "paystack" && eventCategory === "employer_wallet_funding") {
      ProviderEventService.assertMatchingDVAFundingEvidence(existing, identity);
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

    if (cleanProviderEventId) {
      return `${cleanProvider}:event:${cleanProviderEventId}`;
    }

    if (cleanProviderRefundId) {
      return `${cleanProvider}:${cleanEventName}:refund:${cleanProviderRefundId}`;
    }

    if (cleanProviderRefundReference) {
      return `${cleanProvider}:${cleanEventName}:refund-reference:${cleanProviderRefundReference}`;
    }

    // Signed DVA assignment payloads may have no conventional event ID.
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

  /* ─────────────────────────────── RECOVERY BATCH DISCOVERY ─────────────────────────────── */

  static getStaleProcessingFilter(cutoff) {
    return {
      status: "processing",
      $or: [
        { lastProcessingStartedAt: { $lte: cutoff } },
        {
          lastProcessingStartedAt: null,
          processingStartedAt: { $lte: cutoff },
        },
      ],
    };
  }

  static normalizeRecoveryCursor(cursor) {
    if (cursor == null) {
      return null;
    }

    if (
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      typeof cursor.after !== "string" ||
      typeof cursor.through !== "string" ||
      !/^[a-f0-9]{24}$/.test(cursor.after) ||
      !/^[a-f0-9]{24}$/.test(cursor.through) ||
      cursor.after > cursor.through
    ) {
      throw new Error("Invalid provider event recovery cursor.");
    }

    return cursor;
  }

  static async getRecoveryProviderEventBatch(
    {
      kind,
      currentTime = new Date(),
      limit = 100,
      staleProcessingMinutes = 30,
      cursor = null,
    } = {},
    options = {}
  ) {
    if (!["received", "retry", "stale"].includes(kind)) {
      throw new Error("Invalid provider event recovery batch kind.");
    }

    const now = this.normalizeCurrentTime(currentTime);

    const batchLimit = this.normalizePositiveInteger(limit, "Provider event recovery limit");

    if (batchLimit > 1000) {
      throw new Error("Provider event recovery limit cannot exceed 1000.");
    }

    let criteria = { isVerified: true };

    if (kind === "received") {
      criteria.status = "received";
    } else if (kind === "retry") {
      criteria.status = "failed";
      criteria.nextRetryAt = { $type: "date", $lte: now };
    } else {
      const minutes = this.normalizePositiveInteger(
        staleProcessingMinutes,
        "Stale processing minutes"
      );

      const cutoff = new Date(now.getTime() - minutes * 60 * 1000);

      if (Number.isNaN(cutoff.getTime())) {
        throw new Error("Stale processing cutoff is invalid.");
      }

      criteria = {
        ...criteria,
        ...this.getStaleProcessingFilter(cutoff),
      };
    }

    const normalizedCursor = this.normalizeRecoveryCursor(cursor);

    let through = normalizedCursor?.through || null;

    // Fix the upper boundary for each sweep.
    if (!through) {
      const lastQuery = ProviderEvent.findOne(criteria).sort({ _id: -1 }).select("_id").lean();

      if (options.session) {
        lastQuery.session(options.session);
      }

      const newest = await lastQuery;

      if (!newest) {
        return { providerEventIds: [], cursor: null };
      }

      through = String(newest._id);
    }

    const idRange = {
      $lte: new mongoose.Types.ObjectId(through),
    };

    if (normalizedCursor) {
      idRange.$gt = new mongoose.Types.ObjectId(normalizedCursor.after);
    }

    const query = ProviderEvent.find({
      ...criteria,
      _id: idRange,
    })
      .sort({ _id: 1 })
      .limit(batchLimit + 1)
      .select("_id")
      .lean();

    if (options.session) {
      query.session(options.session);
    }

    const records = await query;

    const providerEventIds = records.slice(0, batchLimit).map((record) => String(record._id));

    const nextCursor =
      records.length > batchLimit
        ? { after: providerEventIds[providerEventIds.length - 1], through }
        : null;

    return { providerEventIds, cursor: nextCursor };
  }

  /* ─────────────────────────────── ATOMIC STALE PROCESSING RECOVERY ─────────────────────────────── */

  static async recoverStaleProcessingProviderEvent(
    { providerEventRecordId, currentTime = new Date(), staleProcessingMinutes = 30 } = {},
    options = {}
  ) {
    const eventId = this.normalizeProviderEventRecordId(providerEventRecordId);
    const now = this.normalizeCurrentTime(currentTime);

    const minutes = this.normalizePositiveInteger(
      staleProcessingMinutes,
      "Stale processing minutes"
    );

    const cutoff = new Date(now.getTime() - minutes * 60 * 1000);

    if (Number.isNaN(cutoff.getTime())) {
      throw new Error("Stale processing cutoff is invalid.");
    }

    // Invalidate the previous worker's claim atomically.
    const recovered = await ProviderEvent.findOneAndUpdate(
      {
        _id: eventId,
        isVerified: true,
        ...this.getStaleProcessingFilter(cutoff),
      },
      {
        $set: {
          status: "failed",
          processingClaimId: null,
          failedAt: now,
          failureReason: "Provider event processing claim became stale.",
          nextRetryAt: now,
        },
        $inc: { retryCount: 1 },
      },
      {
        new: true,
        runValidators: true,
        session: options.session || null,
      }
    );

    if (recovered) {
      return {
        providerEvent: recovered,
        recovered: true,
      };
    }

    const providerEvent = await this.getProviderEventById(eventId, options);

    const lastStart = providerEvent.lastProcessingStartedAt || providerEvent.processingStartedAt;

    const stale =
      providerEvent.status === "processing" &&
      lastStart instanceof Date &&
      lastStart.getTime() <= cutoff.getTime();

    return {
      providerEvent,
      recovered: false,
      alreadyProcessed: providerEvent.status === "processed",
      alreadyIgnored: providerEvent.status === "ignored",
      alreadyFailed: providerEvent.status === "failed",
      unverified: providerEvent.isVerified !== true,
      stillProcessing: providerEvent.status === "processing",
      stale,
    };
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
    if (typeof isVerified !== "boolean") {
      throw new TypeError("Provider event isVerified must be a boolean.");
    }

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

        duplicateIdentity = {
          ...duplicateIdentity,
          employer,
          professional,
          wallet,
          bankAccount,
          dvaFundingEvidence:
            cleanEventCategory === "employer_wallet_funding" ? normalizedPayload : null,
          withdrawalTransactionId: normalizedPayload?.withdrawalTransactionId,
          recipientCode: normalizedPayload?.recipientCode,
          domain: normalizedPayload?.domain,
          transferCode: normalizedPayload?.transferCode,
          transferReference: normalizedPayload?.transferReference,
          providerReference: cleanProviderReference,
          providerRefundId: cleanProviderRefundId,
          providerRefundReference: cleanProviderRefundReference,
          amount: normalizedAmount,
          providerFee: normalizedProviderFee,
          netAmount: normalizedNetAmount,
          countryCode: String(countryCode).trim().toUpperCase(),
          currency: String(currency).trim().toUpperCase(),
          isVerified,
        };

        const prior = await ProviderEvent.findOne({
          eventKey: cleanEventKey,
        }).session(session);

        if (prior) {
          ProviderEventService.assertMatchingDuplicate(prior, duplicateIdentity);

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

  /* ---------- LINK DVA FUNDING ---------- */

  static async linkDVAFundingRouting(
    { providerEventRecordId, processingClaimId, routing },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

      if (
        providerEvent.provider !== "paystack" ||
        providerEvent.eventName !== "charge.success" ||
        providerEvent.eventCategory !== "employer_wallet_funding" ||
        providerEvent.isVerified !== true
      ) {
        throw new Error("Provider event is not verified DVA funding.");
      }

      const conflicts = providerEvent.normalizedPayload?.dvaFundingIdentityConflicts;

      if (conflicts != null && (!Array.isArray(conflicts) || conflicts.length)) {
        throw new Error("DVA funding contains unresolved identity conflicts.");
      }

      if (
        !routing ||
        !routing.employer ||
        !routing.wallet ||
        !routing.dva ||
        !routing.providerReference
      ) {
        throw new Error("Complete historical DVA funding routing is required.");
      }

      if (providerEvent.providerReference !== routing.providerReference) {
        throw new Error("DVA funding routing reference does not match the event.");
      }

      const dva = await DVA.findOne({
        _id: routing.dva,
        employer: routing.employer,
        wallet: routing.wallet,
        provider: "paystack",
        countryCode: providerEvent.countryCode,
        currency: providerEvent.currency,
      }).session(session);

      if (!dva) {
        throw new Error("Resolved DVA does not match the original employer wallet.");
      }

      const wallet = await Wallet.findOne({
        _id: routing.wallet,
        ownerType: "employer",
        employer: routing.employer,
        countryCode: providerEvent.countryCode,
        currency: providerEvent.currency,
      }).session(session);

      if (!wallet) {
        throw new Error("Resolved employer wallet does not match DVA funding.");
      }

      // Existing financial ownership cannot be replaced.
      for (const field of ["employer", "wallet", "dva"]) {
        const previous = providerEvent[field];
        const incoming = routing[field];

        if (previous && !ProviderEventService.sameId(previous, incoming)) {
          throw new Error(`DVA funding ${field} conflicts with its resolved ownership.`);
        }
      }

      const payload = providerEvent.normalizedPayload || {};

      const ownership = {
        employerProfileId: String(routing.employer),
        walletId: String(routing.wallet),
        dvaId: String(routing.dva),
      };

      for (const [field, value] of Object.entries(ownership)) {
        if (payload[field] != null && String(payload[field]) !== value) {
          throw new Error(`DVA funding contains conflicting ${field}.`);
        }
      }

      providerEvent.employer = routing.employer;
      providerEvent.wallet = routing.wallet;
      providerEvent.dva = routing.dva;

      providerEvent.normalizedPayload = {
        ...payload,
        ...ownership,
      };

      await providerEvent.save({ session });

      return providerEvent;
    });
  }

  /* ─────────────────────────────── LINK WITHDRAWAL ROUTING ─────────────────────────────── */

  static async linkWithdrawalRouting(
    { providerEventRecordId, processingClaimId, routing },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

      const expected =
        providerEvent.eventName === "transfer.success"
          ? ["employer_withdrawal_payout", "professional_withdrawal_payout"]
          : ["transfer.failed", "transfer.reversed"].includes(providerEvent.eventName)
            ? ["employer_withdrawal_reversal", "professional_withdrawal_reversal"]
            : [];

      if (
        providerEvent.provider !== "paystack" ||
        !providerEvent.isVerified ||
        !expected.includes(routing.eventCategory) ||
        (providerEvent.eventCategory !== "transfer_unresolved" &&
          providerEvent.eventCategory !== routing.eventCategory)
      ) {
        throw new Error("Provider event cannot be linked to this withdrawal category.");
      }

      for (const field of ["transaction", "wallet", "employer", "professional", "bankAccount"]) {
        const previous = providerEvent[field];
        const incoming = routing[field];

        if (previous && (!incoming || !ProviderEventService.sameId(previous, incoming))) {
          throw new Error(
            `Provider event withdrawal ${field} conflicts with its resolved identity.`
          );
        }

        providerEvent[field] = incoming ?? null;
      }

      providerEvent.eventCategory = routing.eventCategory;

      providerEvent.normalizedPayload = {
        ...(providerEvent.normalizedPayload || {}),
        ...routing.normalizedPayload,
      };

      await providerEvent.save({ session });

      return providerEvent;
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

  static async markHistoricalRefundProcessed({ providerEventRecordId, processingClaimId, obligation, refund }, session) {
    if (!session?.inTransaction?.()) throw new Error("Active refund reconciliation transaction required.");

    const event = await this.getProviderEventById(providerEventRecordId, { session });
    this.assertActiveProcessingClaim(event, processingClaimId);

    const payload = event.normalizedPayload || {};
    const execution = obligation.refundExecution;

    if (event.isVerified !== true || event.provider !== "paystack" ||
        event.eventCategory !== "employer_refund" ||
        !["refund.pending", "refund.processing", "refund.needs-attention", "refund.failed", "refund.processed"].includes(event.eventName) ||
        !["retired_dva_funding", "historical_commercial_payment"].includes(obligation.type) ||
        obligation.provider !== event.provider || !execution || execution.providerRefundId !== refund.id ||
        event.amount !== obligation.amount || event.currency !== obligation.currency ||
        event.countryCode !== obligation.countryCode ||
        (event.providerReference && event.providerReference !== obligation.providerReference) ||
        (event.providerRefundId && event.providerRefundId !== refund.id) ||
        (payload.originalTransactionReference && payload.originalTransactionReference !== obligation.providerReference) ||
        (payload.originalTransactionProviderId && String(payload.originalTransactionProviderId) !== obligation.providerTransactionId) ||
        (payload.domain && payload.domain !== obligation.providerMode) ||
        (payload.refundTraceKey && payload.refundTraceKey !== execution.traceKey) ||
        event.professional || event.bankAccount || event.shift || event.shiftApplication ||
        event.employerRefundBatch || event.employerRefundBatchLineId) {
      throw new Error("Refund event conflicts with its verified obligation.");
    }

    for (const [field, expected] of Object.entries({
      financialObligation: obligation._id,
      employer: obligation.employer,
      wallet: obligation.wallet,
      transaction: obligation.commercialTransaction || null,
      dva: obligation.dva || null,
    })) {
      if (event[field] && !this.sameId(event[field], expected)) {
        throw new Error("Refund event has conflicting " + field + ".");
      }
      event[field] = expected;
    }

    event.providerReference = obligation.providerReference;
    event.providerRefundId = refund.id;

    event.normalizedPayload = {
      ...payload,
      financialObligationId: String(obligation._id),
      historicalRefundVerified: true,
      verifiedRefundStatus: execution.state,
    };

    event.metadata = {
      ...(event.metadata || {}),
      historicalFinancialObligationRefund: true,
      verifiedRefundStatus: execution.state,
    };

    event.status = "processed";
    event.processedAt = new Date(Math.max(Date.now(), event.lastProcessingStartedAt.getTime()));
    event.processingClaimId = null;
    event.failedAt = null;
    event.failureReason = null;
    event.ignoredAt = null;
    event.ignoredReason = null;
    event.nextRetryAt = null;

    await event.save({ session });

    return {
      providerEvent: event,
      financialObligation: obligation,
      processed: true,
      refundStatus: execution.state,
    };
  }

  static async markProcessed(
    {
      providerEventRecordId,
      processingClaimId,
      transaction = null,
      financialObligation = null,
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
    if (financialObligation && !options.session?.inTransaction?.()) {
      throw new Error("Financial obligation completion requires the original active transaction.");
    }

    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const normalizedCurrentTime = ProviderEventService.normalizeCurrentTime(currentTime);

      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        for (const [field, incoming] of Object.entries({
          transaction,
          financialObligation,
          wallet,
          employer,
          professional,
          dva,
          bankAccount,
          shift,
          shiftApplication,
          employerRefundBatch,
          employerRefundBatchLineId,
        })) {
          if (incoming != null && !ProviderEventService.sameId(providerEvent[field], incoming)) {
            throw new Error(`Processed provider event cannot change its established ${field}.`);
          }
        }

        for (const [field, incoming] of Object.entries({
          providerRefundId,
          providerRefundReference,
        })) {
          if (
            incoming != null &&
            providerEvent[field] !== ProviderEventService.cleanString(incoming)
          ) {
            throw new Error(`Processed provider event cannot change its established ${field}.`);
          }
        }

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

      const isDVAFunding = providerEvent.eventCategory === "employer_wallet_funding";

      const isWithdrawalReversal = [
        "employer_withdrawal_reversal",
        "professional_withdrawal_reversal",
      ].includes(providerEvent.eventCategory);

      const isWithdrawalPayout = [
        "employer_withdrawal_payout",
        "professional_withdrawal_payout",
      ].includes(providerEvent.eventCategory);

      if (providerEvent.eventCategory === "transfer_unresolved") {
        throw new Error("Unresolved Transfer events require financial ownership resolution.");
      }

      let completedObligation = null;

      /* ---------- FINANCIAL OBLIGATION ---------- */

      if (financialObligation) {
        if (
          shift ||
          shiftApplication ||
          employerRefundBatch ||
          employerRefundBatchLineId ||
          providerRefundId ||
          providerRefundReference
        ) {
          throw new Error("Financial obligation completion contains unrelated financial links.");
        }

        completedObligation = await ProviderEventService.assertFinancialObligationCompletion(
          providerEvent,
          {
            financialObligation,
            transaction,
            employer,
            professional,
            wallet,
            dva,
            bankAccount,
          },
          session
        );

        providerEvent.financialObligation = completedObligation._id;

        if (isDVAFunding) {
          transaction = null;
        } else if (completedObligation.type === "historical_commercial_payment") {
          transaction = completedObligation.commercialTransaction;
          employer = completedObligation.employer;
          wallet = completedObligation.wallet;
        } else {
          transaction = completedObligation.withdrawalTransaction;
        }

        /* ---------- DVA WALLET FUNDING ---------- */
      } else if (isDVAFunding) {
        if (
          professional ||
          bankAccount ||
          shift ||
          shiftApplication ||
          employerRefundBatch ||
          employerRefundBatchLineId ||
          providerRefundId ||
          providerRefundReference
        ) {
          throw new Error("DVA funding completion contains unrelated financial links.");
        }

        const completedTransaction = await ProviderEventService.assertDVAFundingCompletion(
          providerEvent,
          {
            transaction,
            employer,
            wallet,
            dva,
          },
          session
        );

        transaction = completedTransaction._id;

        /* ---------- WITHDRAWAL COMPLETION ---------- */
      } else if (isWithdrawalReversal || isWithdrawalPayout) {
        if (
          dva ||
          shift ||
          shiftApplication ||
          employerRefundBatch ||
          employerRefundBatchLineId ||
          providerRefundId ||
          providerRefundReference
        ) {
          throw new Error("Withdrawal completion contains unrelated financial links.");
        }

        const originalWithdrawalId = providerEvent.transaction;

        const completedTransaction = await ProviderEventService.assertWithdrawalCompletion(
          providerEvent,
          {
            transaction,
            employer,
            professional,
            wallet,
            bankAccount,
            normalizedPayload,
          },
          session
        );

        const isReversalCredit = completedTransaction.type === "withdrawal_reversal";

        const originalWithdrawal = isReversalCredit
          ? await Transaction.findById(originalWithdrawalId).session(session)
          : completedTransaction;

        if (
          !originalWithdrawal ||
          originalWithdrawal.type !== "withdrawal" ||
          !ProviderEventService.sameId(originalWithdrawal._id, originalWithdrawalId)
        ) {
          throw new Error("Withdrawal completion could not resolve its original withdrawal.");
        }

        const withdrawalStatus = originalWithdrawal.status;

        const reservationReleased = isWithdrawalReversal && withdrawalStatus === "failed";

        const reversalTransactionId = isReversalCredit ? String(completedTransaction._id) : null;

        const withdrawalMetadata = originalWithdrawal.metadata || {};

        normalizedPayload = {
          ...(providerEvent.normalizedPayload || {}),

          transactionId: String(originalWithdrawalId),

          withdrawalTransactionId: String(originalWithdrawalId),

          paystackTransferReference: originalWithdrawal.paystackTransferReference,

          paystackTransferCode: originalWithdrawal.paystackTransferCode || null,

          ownerType: withdrawalMetadata.ownerType,

          employerProfileId: withdrawalMetadata.employerProfileId || null,

          professionalProfileId: withdrawalMetadata.professionalProfileId || null,

          walletId: String(originalWithdrawal.wallet),

          withdrawalStatus,

          withdrawalReservationReleased: reservationReleased,

          withdrawalReversalCredited: isReversalCredit,

          reversalTransactionId,

          financialObligationId: null,
        };

        metadata = {
          ...metadata,

          withdrawalTerminalStatus: withdrawalStatus,

          withdrawalReservationReleased: reservationReleased,

          withdrawalReversalCredited: isReversalCredit,

          reversalTransactionId,

          financialObligationId: null,
        };

        transaction = completedTransaction._id;
      }

      /* ---------- EMPLOYER REFUND LINKS ---------- */

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

      /* ---------- PROCESSING COMPLETION ---------- */

      providerEvent.status = "processed";

      providerEvent.processingClaimId = null;

      providerEvent.processingStartedAt =
        providerEvent.processingStartedAt || normalizedCurrentTime;

      providerEvent.lastProcessingStartedAt =
        providerEvent.lastProcessingStartedAt || providerEvent.processingStartedAt;

      providerEvent.processedAt = normalizedCurrentTime;

      providerEvent.nextRetryAt = null;

      /* ---------- FINANCIAL RELATIONSHIPS ---------- */

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

      /* ---------- NORMALIZED FINANCIAL OUTCOME ---------- */

      if (isDVAFunding) {
        providerEvent.normalizedPayload = {
          ...(providerEvent.normalizedPayload || {}),

          employerProfileId: String(providerEvent.employer),

          walletId: String(providerEvent.wallet),

          dvaId: String(providerEvent.dva),

          transactionId: providerEvent.transaction ? String(providerEvent.transaction) : null,

          financialObligationId: completedObligation ? String(completedObligation._id) : null,
        };
      } else if (completedObligation?.type === "historical_commercial_payment") {
        providerEvent.normalizedPayload = {
          ...(providerEvent.normalizedPayload || {}),
          employerProfileId: String(completedObligation.employer),
          walletId: String(completedObligation.wallet),
          paymentTransactionId: String(completedObligation.commercialTransaction),
          subscriptionPaymentId: completedObligation.subscriptionPayment
            ? String(completedObligation.subscriptionPayment) : null,
          jobPaymentId: completedObligation.jobPayment
            ? String(completedObligation.jobPayment) : null,
          financialObligationId: String(completedObligation._id),
          paymentFinalized: false,
          commercialReceiptCredited: false,
        };

        metadata = {
          ...metadata,
          historicalFinancialObligation: true,
          financialObligationId: String(completedObligation._id),
          financialObligationType: completedObligation.type,
          commercialReceiptCredited: false,
        };
      } else if (completedObligation) {
        providerEvent.normalizedPayload = {
          ...(providerEvent.normalizedPayload || {}),

          ownerType: completedObligation.ownerType,

          employerProfileId: completedObligation.employer
            ? String(completedObligation.employer)
            : null,

          professionalProfileId: completedObligation.professional
            ? String(completedObligation.professional)
            : null,

          walletId: String(completedObligation.wallet),

          transactionId: String(completedObligation.withdrawalTransaction),

          withdrawalTransactionId: String(completedObligation.withdrawalTransaction),

          financialObligationId: String(completedObligation._id),

          withdrawalStatus: "completed",

          withdrawalReservationReleased: false,

          withdrawalReversalCredited: false,

          reversalTransactionId: null,
        };

        metadata = {
          ...metadata,

          financialObligationId: String(completedObligation._id),

          withdrawalTerminalStatus: "completed",

          withdrawalReservationReleased: false,

          withdrawalReversalCredited: false,

          reversalTransactionId: null,
        };
      } else if (normalizedPayload) {
        providerEvent.normalizedPayload = normalizedPayload;
      }

      providerEvent.metadata = {
        ...(providerEvent.metadata || {}),
        ...metadata,
      };

      await providerEvent.save({ session });

      return {
        providerEvent,
        alreadyProcessed: false,
      };
    });
  }

  static async assertDVAFundingCompletion(
    providerEvent,
    { transaction, employer, wallet, dva },
    session
  ) {
    if (!session?.inTransaction?.()) {
      throw new Error("DVA funding completion requires an active transaction.");
    }

    if (
      providerEvent.provider !== "paystack" ||
      providerEvent.eventName !== "charge.success" ||
      providerEvent.eventCategory !== "employer_wallet_funding" ||
      providerEvent.isVerified !== true ||
      providerEvent.countryCode !== "NG" ||
      providerEvent.currency !== "NGN" ||
      !providerEvent.providerReference ||
      !Number.isSafeInteger(providerEvent.amount) ||
      providerEvent.amount <= 0
    ) {
      throw new Error("Provider event is not confirmed Paystack DVA funding.");
    }

    if (
      !providerEvent.employer ||
      !providerEvent.wallet ||
      !providerEvent.dva ||
      providerEvent.professional ||
      providerEvent.bankAccount ||
      providerEvent.financialObligation
    ) {
      throw new Error("DVA funding ownership or financial disposition is inconsistent.");
    }

    const sameId = ProviderEventService.sameId;

    for (const [field, incoming] of Object.entries({
      employer,
      wallet,
      dva,
    })) {
      if (incoming && !sameId(providerEvent[field], incoming)) {
        throw new Error(`DVA funding completion cannot replace its original ${field}.`);
      }
    }

    const transactionId = transaction || providerEvent.transaction;

    if (!transactionId) {
      throw new Error("DVA funding completion requires a ledger transaction.");
    }

    if (providerEvent.transaction && !sameId(providerEvent.transaction, transactionId)) {
      throw new Error("DVA funding is already linked to another transaction.");
    }

    const payload = providerEvent.normalizedPayload || {};

    const conflicts = payload.dvaFundingIdentityConflicts;

    if (conflicts != null && (!Array.isArray(conflicts) || conflicts.length)) {
      throw new Error("DVA funding has unresolved identity conflicts.");
    }

    if (
      !Number.isSafeInteger(providerEvent.providerFee) ||
      providerEvent.providerFee < 0 ||
      providerEvent.providerFee > providerEvent.amount ||
      !Number.isSafeInteger(providerEvent.netAmount) ||
      providerEvent.netAmount !== providerEvent.amount - providerEvent.providerFee
    ) {
      throw new Error(
        "DVA funding requires confirmed and consistent provider fees and net amount."
      );
    }

    const historicalDVA = await DVA.findById(providerEvent.dva).session(session);

    const originalWallet = await Wallet.findById(providerEvent.wallet).session(session);

    if (
      !historicalDVA ||
      !originalWallet ||
      historicalDVA.provider !== "paystack" ||
      originalWallet.ownerType !== "employer" ||
      originalWallet.professional ||
      !sameId(historicalDVA.employer, providerEvent.employer) ||
      !sameId(historicalDVA.wallet, providerEvent.wallet) ||
      !sameId(originalWallet.employer, providerEvent.employer) ||
      historicalDVA.countryCode !== providerEvent.countryCode ||
      historicalDVA.currency !== providerEvent.currency ||
      originalWallet.countryCode !== providerEvent.countryCode ||
      originalWallet.currency !== providerEvent.currency
    ) {
      throw new Error("DVA funding does not match its original financial ownership.");
    }

    const completedTransaction = await Transaction.findById(transactionId)
      .select("+idempotencyKey")
      .session(session);

    const valid =
      completedTransaction &&
      completedTransaction.type === "wallet_funding" &&
      completedTransaction.purpose === "wallet_topup" &&
      completedTransaction.direction === "credit" &&
      completedTransaction.paymentRail === "paystack_dva" &&
      completedTransaction.provider === "paystack" &&
      completedTransaction.status === "completed" &&
      completedTransaction.paystackStatus === "success" &&
      completedTransaction.paystackReference === providerEvent.providerReference &&
      completedTransaction.idempotencyKey ===
        `wallet_funding:paystack:reference:${providerEvent.providerReference}` &&
      completedTransaction.amount === providerEvent.amount &&
      completedTransaction.providerFee === providerEvent.providerFee &&
      completedTransaction.netAmount === providerEvent.netAmount &&
      completedTransaction.countryCode === providerEvent.countryCode &&
      completedTransaction.currency === providerEvent.currency &&
      sameId(completedTransaction.wallet, providerEvent.wallet) &&
      sameId(completedTransaction.dva, providerEvent.dva) &&
      completedTransaction.balanceDelta?.availableBalance === providerEvent.amount &&
      completedTransaction.balanceDelta?.pendingBalance === 0 &&
      completedTransaction.balanceDelta?.outstandingBalance === 0;

    if (!valid) {
      throw new Error("Completed transaction does not match the original DVA funding event.");
    }

    const providerMode = completedTransaction.metadata?.verifiedProviderMode;

    if (
      !["test", "live"].includes(providerMode) ||
      historicalDVA.metadata?.assignmentMode !== providerMode ||
      (payload.domain != null && payload.domain !== providerMode)
    ) {
      throw new Error("DVA funding belongs to a conflicting Paystack environment.");
    }

    if (
      payload.dvaFundingTransactionId != null &&
      String(payload.dvaFundingTransactionId) !==
        String(completedTransaction.metadata?.paystackTransactionId || "")
    ) {
      throw new Error("DVA funding contains a conflicting provider transaction ID.");
    }

    const existingObligation = await FinancialObligation.exists({
      type: "retired_dva_funding",
      provider: "paystack",
      providerReference: providerEvent.providerReference,
    }).session(session);

    if (existingObligation) {
      throw new Error("DVA payment already has a historical financial obligation.");
    }

    return completedTransaction;
  }

  static async assertWithdrawalCompletion(
    providerEvent,
    { transaction, employer, professional, wallet, bankAccount, normalizedPayload },
    session
  ) {
    if (!session?.inTransaction?.()) {
      throw new Error("Withdrawal completion requires an active transaction.");
    }

    const sameId = ProviderEventService.sameId;

    const payload = providerEvent.normalizedPayload || {};

    const completionPayload = normalizedPayload || {};

    const protectedEvidenceFields = [
      "domain",
      "recipientCode",
      "transferCode",
      "paystackTransferCode",
      "transferReference",
      "paystackTransferReference",
      "withdrawalTransactionId",
      "ownerType",
      "employerProfileId",
      "professionalProfileId",
      "currency",
      "status",
      "paystackStatus",
    ];

    for (const field of protectedEvidenceFields) {
      if (
        payload[field] != null &&
        Object.prototype.hasOwnProperty.call(completionPayload, field) &&
        completionPayload[field] !== payload[field]
      ) {
        throw new Error(`Withdrawal completion cannot replace verified ${field}.`);
      }
    }

    const isPayout = providerEvent.eventName === "transfer.success";

    const isReversal = ["transfer.failed", "transfer.reversed"].includes(providerEvent.eventName);

    if (
      providerEvent.provider !== "paystack" ||
      providerEvent.isVerified !== true ||
      (!isPayout && !isReversal) ||
      !providerEvent.providerReference ||
      !providerEvent.transaction ||
      !providerEvent.wallet ||
      !providerEvent.bankAccount ||
      providerEvent.dva ||
      providerEvent.financialObligation ||
      providerEvent.shift ||
      providerEvent.shiftApplication ||
      providerEvent.employerRefundBatch ||
      providerEvent.employerRefundBatchLineId
    ) {
      throw new Error("Provider event is not a valid withdrawal completion.");
    }

    const withdrawal = await Transaction.findById(providerEvent.transaction).session(session);

    if (
      !withdrawal ||
      withdrawal.type !== "withdrawal" ||
      withdrawal.purpose !== "withdrawal" ||
      withdrawal.direction !== "debit" ||
      withdrawal.provider !== "paystack" ||
      withdrawal.paymentRail !== "paystack_transfer" ||
      withdrawal.paystackTransferReference !== providerEvent.providerReference ||
      withdrawal.netAmount !== providerEvent.amount ||
      withdrawal.currency !== providerEvent.currency ||
      withdrawal.countryCode !== providerEvent.countryCode ||
      !sameId(withdrawal.wallet, providerEvent.wallet) ||
      !sameId(withdrawal.bankAccount, providerEvent.bankAccount)
    ) {
      throw new Error("Provider event does not match its original withdrawal.");
    }

    const originalWallet = await Wallet.findById(withdrawal.wallet).session(session);

    if (
      !originalWallet ||
      !["employer", "professional"].includes(originalWallet.ownerType) ||
      originalWallet.currency !== withdrawal.currency ||
      originalWallet.countryCode !== withdrawal.countryCode
    ) {
      throw new Error("Withdrawal does not match its original wallet.");
    }

    const metadata = withdrawal.metadata || {};

    const ownerType = originalWallet.ownerType;

    const expectedEmployer = ownerType === "employer" ? originalWallet.employer : null;

    const expectedProfessional = ownerType === "professional" ? originalWallet.professional : null;

    const expectedCategory = `${ownerType}_withdrawal_${isPayout ? "payout" : "reversal"}`;

    if (
      metadata.ownerType !== ownerType ||
      providerEvent.eventCategory !== expectedCategory ||
      (ownerType === "employer" && (!expectedEmployer || originalWallet.professional)) ||
      (ownerType === "professional" && (!expectedProfessional || originalWallet.employer))
    ) {
      throw new Error("Withdrawal event classification conflicts with historical ownership.");
    }

    for (const [field, expected, incoming] of [
      ["employer", expectedEmployer, employer],
      ["professional", expectedProfessional, professional],
      ["wallet", withdrawal.wallet, wallet],
      ["bankAccount", withdrawal.bankAccount, bankAccount],
    ]) {
      const recorded = providerEvent[field];

      if (
        ((recorded || expected) && !sameId(recorded, expected)) ||
        (incoming && !sameId(incoming, expected))
      ) {
        throw new Error(`Withdrawal completion contains a conflicting ${field}.`);
      }
    }

    for (const [recorded, expected] of [
      [metadata.employerProfileId, expectedEmployer],
      [metadata.professionalProfileId, expectedProfessional],
    ]) {
      if ((recorded || expected) && !sameId(recorded, expected)) {
        throw new Error("Withdrawal metadata conflicts with historical ownership.");
      }
    }

    if (
      !["test", "live"].includes(metadata.paystackMode) ||
      payload.domain !== metadata.paystackMode ||
      !metadata.paystackRecipientCode ||
      payload.recipientCode !== metadata.paystackRecipientCode
    ) {
      throw new Error("Withdrawal provider environment or recipient could not be confirmed.");
    }

    for (const code of [payload.transferCode, payload.paystackTransferCode]) {
      if (code != null && code !== withdrawal.paystackTransferCode) {
        throw new Error("Withdrawal provider event contains a conflicting Transfer code.");
      }
    }

    for (const reference of [payload.transferReference, payload.paystackTransferReference]) {
      if (reference != null && reference !== withdrawal.paystackTransferReference) {
        throw new Error("Withdrawal provider event contains a conflicting Transfer reference.");
      }
    }

    if (
      completionPayload.withdrawalTransactionId != null &&
      !sameId(completionPayload.withdrawalTransactionId, withdrawal._id)
    ) {
      throw new Error("Withdrawal completion cannot replace its original transaction.");
    }

    const disposition = metadata.providerReversalDisposition;

    // Historical success can arrive again after a later reversal.
    if (isPayout) {
      if (
        !["completed", "reversed"].includes(withdrawal.status) ||
        !withdrawal.completedAt ||
        !withdrawal.paystackTransferCode ||
        !sameId(transaction, withdrawal._id)
      ) {
        throw new Error("Withdrawal payout did not produce its original completed debit.");
      }

      return withdrawal;
    }

    const historicalObligation = await FinancialObligation.exists({
      type: "closed_wallet_withdrawal_reversal",
      withdrawalTransaction: withdrawal._id,
    }).session(session);

    if (
      historicalObligation ||
      disposition === "financial_obligation" ||
      metadata.financialObligationId
    ) {
      throw new Error("Withdrawal reversal already has a historical financial obligation.");
    }

    // Provider failure before successful payment releases the reservation.
    if (withdrawal.status === "failed") {
      if (
        withdrawal.paystackStatus !== "failed" ||
        !withdrawal.failedAt ||
        disposition != null ||
        metadata.reversalTransactionId ||
        !sameId(transaction, withdrawal._id)
      ) {
        throw new Error("Failed withdrawal does not match its reservation release.");
      }

      const existingCredit = await Transaction.exists({
        type: "withdrawal_reversal",
        relatedTransaction: withdrawal._id,
      }).session(session);

      if (existingCredit) {
        throw new Error("Failed withdrawal cannot also have a reversal credit.");
      }

      if (
        withdrawal.balanceDelta?.availableBalance !== withdrawal.amount ||
        withdrawal.balanceDelta?.pendingBalance !== -withdrawal.amount ||
        withdrawal.balanceDelta?.outstandingBalance !== 0
      ) {
        throw new Error("Failed withdrawal did not correctly release its reservation.");
      }

      return withdrawal;
    }

    // A previously completed withdrawal requires an actual reversal.
    if (
      providerEvent.eventName !== "transfer.reversed" ||
      withdrawal.status !== "reversed" ||
      withdrawal.paystackStatus !== "reversed" ||
      !withdrawal.completedAt ||
      !withdrawal.reversedAt ||
      disposition !== "wallet_credit" ||
      !metadata.reversalTransactionId ||
      !sameId(transaction, metadata.reversalTransactionId)
    ) {
      throw new Error("Completed withdrawal reversal has an invalid financial disposition.");
    }

    const reversalCredit = await Transaction.findById(metadata.reversalTransactionId)
      .select("+idempotencyKey")
      .session(session);

    if (
      !reversalCredit ||
      reversalCredit.type !== "withdrawal_reversal" ||
      reversalCredit.purpose !== "withdrawal_reversal" ||
      reversalCredit.direction !== "credit" ||
      reversalCredit.provider !== "internal" ||
      reversalCredit.paymentRail !== "system_action" ||
      reversalCredit.status !== "completed" ||
      reversalCredit.idempotencyKey !== `withdrawal-reversal:${withdrawal._id}` ||
      reversalCredit.amount !== withdrawal.amount ||
      reversalCredit.netAmount !== withdrawal.amount ||
      reversalCredit.providerFee !== 0 ||
      reversalCredit.currency !== withdrawal.currency ||
      reversalCredit.countryCode !== withdrawal.countryCode ||
      !sameId(reversalCredit.wallet, withdrawal.wallet) ||
      !sameId(reversalCredit.bankAccount, withdrawal.bankAccount) ||
      !sameId(reversalCredit.relatedTransaction, withdrawal._id) ||
      reversalCredit.balanceDelta?.availableBalance !== withdrawal.amount ||
      reversalCredit.balanceDelta?.pendingBalance !== 0 ||
      reversalCredit.balanceDelta?.outstandingBalance !== 0
    ) {
      throw new Error("Withdrawal reversal credit does not match the original withdrawal.");
    }

    return reversalCredit;
  }

  /* ---------- FINANCIAL OBLIGATION COMPLETION ---------- */

  static async assertFinancialObligationCompletion(
    providerEvent,
    { financialObligation, transaction, employer, professional, wallet, dva, bankAccount },
    session
  ) {
    if (!session?.inTransaction?.()) {
      throw new Error("Financial obligation validation requires an active transaction.");
    }

    const obligation = await FinancialObligation.findById(financialObligation).session(session);

    if (!obligation) {
      throw new Error("Financial obligation was not found.");
    }

    const sameId = ProviderEventService.sameId;

    const payload = providerEvent.normalizedPayload || {};
    const evidence = obligation.providerEvidence || {};

    if (
      providerEvent.provider !== "paystack" ||
      providerEvent.isVerified !== true ||
      obligation.provider !== providerEvent.provider ||
      obligation.providerReference !== providerEvent.providerReference ||
      obligation.countryCode !== providerEvent.countryCode ||
      obligation.currency !== providerEvent.currency ||
      !["test", "live"].includes(obligation.providerMode) ||
      !["open", "review_required", "settled"].includes(obligation.status) ||
      !obligation.verifiedAt ||
      (!obligation.sourceProviderEvent && obligation.type !== "historical_commercial_payment")
    ) {
      throw new Error("Financial obligation does not match the verified provider event.");
    }

    if (payload.domain && payload.domain !== obligation.providerMode) {
      throw new Error("Financial obligation belongs to another provider environment.");
    }

    if (
      providerEvent.financialObligation &&
      !sameId(providerEvent.financialObligation, obligation._id)
    ) {
      throw new Error("Provider event is already linked to another financial obligation.");
    }

    if (
      providerEvent.shift ||
      providerEvent.shiftApplication ||
      providerEvent.employerRefundBatch ||
      providerEvent.employerRefundBatchLineId ||
      providerEvent.providerRefundId ||
      providerEvent.providerRefundReference
    ) {
      throw new Error("Financial obligation contains unrelated provider event links.");
    }

    if (obligation.type === "historical_commercial_payment") {
      const expectedCategory = obligation.subscriptionPayment
        ? "subscription_payment" : "job_publication_purchase";

      if (
        providerEvent.eventName !== "charge.success" ||
        providerEvent.eventCategory !== expectedCategory ||
        obligation.ownerType !== "employer" ||
        !obligation.employer || !obligation.commercialTransaction ||
        Boolean(obligation.subscriptionPayment) === Boolean(obligation.jobPayment) ||
        obligation.professional || obligation.dva || obligation.withdrawalTransaction ||
        professional || dva || bankAccount ||
        providerEvent.professional || providerEvent.dva || providerEvent.bankAccount ||
        obligation.providerStatus !== "success" ||
        obligation.verificationSource !== "paystack_transaction_verification" ||
        !obligation.providerTransactionId || obligation.providerTransferCode ||
        obligation.amount !== providerEvent.amount ||
        obligation.providerAmount !== providerEvent.amount ||
        (providerEvent.providerFee != null && providerEvent.providerFee !== obligation.providerFee) ||
        (providerEvent.netAmount != null && providerEvent.netAmount !== obligation.providerNetAmount) ||
        evidence.reference !== obligation.providerReference ||
        evidence.transactionId !== obligation.providerTransactionId ||
        evidence.domain !== obligation.providerMode ||
        evidence.status !== "success" ||
        evidence.amount !== obligation.amount ||
        evidence.currency !== obligation.currency
      ) {
        throw new Error("Historical commercial obligation conflicts with verified receipt.");
      }

      for (const [field, expected, incoming] of [
        ["employer", obligation.employer, employer],
        ["wallet", obligation.wallet, wallet],
        ["transaction", obligation.commercialTransaction, transaction],
      ]) {
        if (
          (providerEvent[field] && !sameId(providerEvent[field], expected)) ||
          (incoming && !sameId(incoming, expected))
        ) {
          throw new Error("Commercial obligation cannot replace historical " + field + ".");
        }
      }

      const receipt = await Transaction.findById(obligation.commercialTransaction).session(session);
      const platformWallet = await Wallet.findById(obligation.wallet).session(session);

      if (
        !receipt || !platformWallet ||
        !sameId(receipt.wallet, obligation.wallet) ||
        platformWallet.ownerType !== "platform" ||
        platformWallet.countryCode !== obligation.countryCode ||
        platformWallet.currency !== obligation.currency ||
        receipt.provider !== "paystack" ||
        receipt.paystackReference !== obligation.providerReference ||
        receipt.type !== expectedCategory || receipt.purpose !== expectedCategory ||
        receipt.direction !== "credit" ||
        !["pending", "processing", "failed", "cancelled"].includes(receipt.status) ||
        receipt.amount !== obligation.amount ||
        receipt.currency !== obligation.currency ||
        receipt.countryCode !== obligation.countryCode ||
        !sameId(receipt.metadata?.employerProfileId, obligation.employer) ||
        !sameId(
          receipt.metadata?.[obligation.subscriptionPayment ? "subscriptionPaymentId" : "jobPaymentId"],
          obligation.subscriptionPayment || obligation.jobPayment
        )
      ) {
        throw new Error("Commercial obligation requires its original uncredited platform receipt.");
      }

      // Direct verification may have recorded the obligation without a webhook.
      // A separately committed source event need not have completed yet.
      if (obligation.sourceProviderEvent && !sameId(obligation.sourceProviderEvent, providerEvent._id)) {
        const sourceEvent = await ProviderEvent.findById(obligation.sourceProviderEvent).session(session);

        if (
          !sourceEvent || sourceEvent.isVerified !== true ||
          sourceEvent.provider !== providerEvent.provider ||
          sourceEvent.eventName !== providerEvent.eventName ||
          sourceEvent.eventCategory !== providerEvent.eventCategory ||
          sourceEvent.providerReference !== providerEvent.providerReference ||
          sourceEvent.amount !== providerEvent.amount ||
          sourceEvent.currency !== providerEvent.currency ||
          sourceEvent.countryCode !== providerEvent.countryCode ||
          (sourceEvent.financialObligation && !sameId(sourceEvent.financialObligation, obligation._id))
        ) {
          throw new Error("Commercial obligation has an inconsistent source event.");
        }
      }

      return obligation;
    }

    // Financial ownership cannot be reassigned during completion.

    for (const [field, incoming] of Object.entries({
      employer,
      professional,
      wallet,
      dva,
    })) {
      const expected = obligation[field] ?? null;
      const recorded = providerEvent[field] ?? null;

      if ((expected || recorded) && !sameId(expected, recorded)) {
        throw new Error(`Financial obligation has conflicting historical ${field}.`);
      }

      if (incoming && !sameId(expected, incoming)) {
        throw new Error(`Financial obligation completion cannot replace ${field}.`);
      }
    }

    const originalWallet = await Wallet.findById(obligation.wallet).session(session);

    if (
      !originalWallet ||
      originalWallet.ownerType !== obligation.ownerType ||
      originalWallet.countryCode !== obligation.countryCode ||
      originalWallet.currency !== obligation.currency
    ) {
      throw new Error("Financial obligation does not match its original wallet.");
    }

    if (
      obligation.ownerType === "employer"
        ? !sameId(originalWallet.employer, obligation.employer) ||
          originalWallet.professional ||
          obligation.professional
        : obligation.ownerType === "professional"
          ? !sameId(originalWallet.professional, obligation.professional) ||
            originalWallet.employer ||
            obligation.employer
          : true
    ) {
      throw new Error("Financial obligation has inconsistent wallet ownership.");
    }

    // Additional deliveries may reference an existing obligation.

    if (!sameId(obligation.sourceProviderEvent, providerEvent._id)) {
      const sourceEvent = await ProviderEvent.findById(obligation.sourceProviderEvent).session(
        session
      );

      if (
        !sourceEvent ||
        sourceEvent.isVerified !== true ||
        sourceEvent.status !== "processed" ||
        sourceEvent.provider !== providerEvent.provider ||
        sourceEvent.eventName !== providerEvent.eventName ||
        sourceEvent.eventCategory !== providerEvent.eventCategory ||
        sourceEvent.providerReference !== providerEvent.providerReference ||
        sourceEvent.amount !== providerEvent.amount ||
        sourceEvent.currency !== providerEvent.currency ||
        sourceEvent.countryCode !== providerEvent.countryCode ||
        !sameId(sourceEvent.financialObligation, obligation._id)
      ) {
        throw new Error("Existing financial obligation has an inconsistent source event.");
      }
    }

    /* ---------- RETIRED DVA FUNDING ---------- */

    if (obligation.type === "retired_dva_funding") {
      if (
        providerEvent.eventCategory !== "employer_wallet_funding" ||
        providerEvent.eventName !== "charge.success" ||
        obligation.ownerType !== "employer" ||
        obligation.providerStatus !== "success" ||
        obligation.verificationSource !== "paystack_transaction_verification" ||
        obligation.amount !== providerEvent.amount ||
        obligation.providerAmount !== providerEvent.amount ||
        obligation.withdrawalTransaction ||
        obligation.providerTransferCode ||
        transaction ||
        providerEvent.transaction ||
        bankAccount ||
        providerEvent.bankAccount
      ) {
        throw new Error("Invalid retired DVA funding obligation.");
      }

      const conflicts = payload.dvaFundingIdentityConflicts;

      if (conflicts != null && (!Array.isArray(conflicts) || conflicts.length)) {
        throw new Error("DVA funding contains unresolved identity conflicts.");
      }

      if (
        !obligation.providerTransactionId ||
        (payload.dvaFundingTransactionId != null &&
          String(payload.dvaFundingTransactionId) !== String(obligation.providerTransactionId)) ||
        evidence.transactionId !== obligation.providerTransactionId ||
        evidence.providerReference !== obligation.providerReference ||
        evidence.domain !== obligation.providerMode ||
        evidence.status !== "success" ||
        evidence.amount !== obligation.providerAmount ||
        evidence.currency !== obligation.currency
      ) {
        throw new Error("Financial obligation contains inconsistent DVA payment evidence.");
      }

      if (
        !Number.isSafeInteger(obligation.providerFee) ||
        obligation.providerFee < 0 ||
        obligation.providerFee > obligation.providerAmount ||
        obligation.providerNetAmount !== obligation.providerAmount - obligation.providerFee ||
        evidence.fees !== obligation.providerFee ||
        evidence.netAmount !== obligation.providerNetAmount ||
        (providerEvent.providerFee != null &&
          providerEvent.providerFee !== obligation.providerFee) ||
        (providerEvent.netAmount != null &&
          providerEvent.netAmount !== obligation.providerNetAmount)
      ) {
        throw new Error("Financial obligation contains inconsistent DVA funding amounts.");
      }

      const historicalDVA = await DVA.findById(obligation.dva).session(session);

      if (
        !historicalDVA ||
        !["retiring", "deactivated"].includes(historicalDVA.status) ||
        !historicalDVA.retirementStartedAt ||
        historicalDVA.provider !== obligation.provider ||
        historicalDVA.countryCode !== obligation.countryCode ||
        historicalDVA.currency !== obligation.currency ||
        historicalDVA.metadata?.assignmentMode !== obligation.providerMode ||
        !sameId(historicalDVA.employer, obligation.employer) ||
        !sameId(historicalDVA.wallet, obligation.wallet)
      ) {
        throw new Error("Financial obligation does not match its historical DVA.");
      }

      const identity = evidence.identity || {};

      if (
        !(identity.paystackCustomerId || identity.paystackCustomerCode) ||
        !(
          identity.paystackDedicatedAccountId ||
          (identity.accountNumber &&
            (identity.bankId || identity.bankCode || identity.bankSlug || identity.providerSlug))
        )
      ) {
        throw new Error("Financial obligation lacks confirmed DVA identity.");
      }

      for (const field of [
        "paystackCustomerId",
        "paystackCustomerCode",
        "paystackDedicatedAccountId",
        "accountNumber",
        "bankId",
        "bankCode",
        "bankSlug",
        "providerSlug",
      ]) {
        if (
          identity[field] != null &&
          (historicalDVA[field] == null || String(historicalDVA[field]) !== String(identity[field]))
        ) {
          throw new Error(`Financial obligation contains conflicting DVA ${field}.`);
        }

        if (
          payload[field] != null &&
          (identity[field] == null || String(payload[field]) !== String(identity[field]))
        ) {
          throw new Error(`Financial obligation conflicts with recorded ${field}.`);
        }
      }

      const existingCredit = await Transaction.exists({
        $or: [
          {
            idempotencyKey: `wallet_funding:paystack:reference:${obligation.providerReference}`,
          },
          {
            provider: "paystack",
            paystackReference: obligation.providerReference,
          },
        ],
      }).session(session);

      if (existingCredit) {
        throw new Error("Historical DVA payment already has a ledger transaction.");
      }

      return obligation;
    }

    /* ---------- CLOSED-WALLET WITHDRAWAL REVERSAL ---------- */

    if (obligation.type === "closed_wallet_withdrawal_reversal") {
      const expectedCategory = `${obligation.ownerType}_withdrawal_reversal`;

      if (
        providerEvent.eventCategory !== expectedCategory ||
        providerEvent.eventName !== "transfer.reversed" ||
        obligation.providerStatus !== "reversed" ||
        obligation.verificationSource !== "paystack_transfer_verification" ||
        originalWallet.status !== "closed" ||
        obligation.dva ||
        providerEvent.dva ||
        obligation.providerTransactionId ||
        !obligation.providerTransferCode ||
        !obligation.withdrawalTransaction ||
        obligation.providerAmount !== providerEvent.amount ||
        !sameId(providerEvent.transaction, obligation.withdrawalTransaction) ||
        (transaction && !sameId(transaction, obligation.withdrawalTransaction))
      ) {
        throw new Error("Invalid closed-wallet withdrawal reversal obligation.");
      }

      const withdrawal = await Transaction.findById(obligation.withdrawalTransaction).session(
        session
      );

      if (
        !withdrawal ||
        withdrawal.type !== "withdrawal" ||
        withdrawal.purpose !== "withdrawal" ||
        withdrawal.direction !== "debit" ||
        withdrawal.provider !== "paystack" ||
        withdrawal.paymentRail !== "paystack_transfer" ||
        withdrawal.status !== "completed" ||
        withdrawal.paystackStatus !== "success" ||
        !withdrawal.completedAt ||
        withdrawal.amount !== obligation.amount ||
        withdrawal.netAmount !== obligation.providerAmount ||
        withdrawal.currency !== obligation.currency ||
        withdrawal.countryCode !== obligation.countryCode ||
        withdrawal.paystackTransferReference !== obligation.providerReference ||
        withdrawal.paystackTransferCode !== obligation.providerTransferCode ||
        !sameId(withdrawal.wallet, obligation.wallet) ||
        !sameId(withdrawal.bankAccount, providerEvent.bankAccount) ||
        (bankAccount && !sameId(bankAccount, withdrawal.bankAccount))
      ) {
        throw new Error("Financial obligation does not match its original completed withdrawal.");
      }

      const withdrawalMetadata = withdrawal.metadata || {};

      if (
        withdrawalMetadata.paystackMode !== obligation.providerMode ||
        withdrawalMetadata.providerReversalDisposition !== "financial_obligation" ||
        withdrawalMetadata.providerReversalStatus !== "reversed" ||
        !sameId(withdrawalMetadata.financialObligationId, obligation._id) ||
        withdrawalMetadata.reversalTransactionId != null
      ) {
        throw new Error(
          "Original withdrawal has an inconsistent historical financial disposition."
        );
      }

      const recordedVerificationTime = withdrawalMetadata.providerReversalVerifiedAt;

      if (
        !(recordedVerificationTime instanceof Date) ||
        !Number.isFinite(recordedVerificationTime.getTime()) ||
        !(obligation.verifiedAt instanceof Date) ||
        !Number.isFinite(obligation.verifiedAt.getTime()) ||
        recordedVerificationTime.getTime() !== obligation.verifiedAt.getTime()
      ) {
        throw new Error(
          "Withdrawal reversal verification time conflicts with its financial obligation."
        );
      }

      if (
        withdrawalMetadata.bankAccountId != null &&
        !sameId(withdrawalMetadata.bankAccountId, withdrawal.bankAccount)
      ) {
        throw new Error("Withdrawal obligation conflicts with its original bank account.");
      }

      if (
        withdrawal.metadata?.ownerType !== obligation.ownerType ||
        (obligation.ownerType === "employer"
          ? !sameId(withdrawal.metadata?.employerProfileId, obligation.employer) ||
            withdrawal.metadata?.professionalProfileId
          : !sameId(withdrawal.metadata?.professionalProfileId, obligation.professional) ||
            withdrawal.metadata?.employerProfileId)
      ) {
        throw new Error("Withdrawal obligation conflicts with historical ownership.");
      }

      if (
        evidence.reference !== obligation.providerReference ||
        evidence.transferCode !== obligation.providerTransferCode ||
        evidence.status !== "reversed" ||
        evidence.domain !== obligation.providerMode ||
        evidence.amount !== obligation.providerAmount ||
        evidence.currency !== obligation.currency ||
        evidence.originalWalletDebit !== obligation.amount ||
        evidence.originalBankPayout !== obligation.providerAmount ||
        !withdrawal.metadata?.paystackRecipientCode ||
        evidence.recipientCode !== withdrawal.metadata.paystackRecipientCode ||
        payload.recipientCode !== evidence.recipientCode ||
        obligation.verifiedAt < withdrawal.completedAt
      ) {
        throw new Error("Withdrawal obligation contains inconsistent provider reversal evidence.");
      }

      for (const value of [payload.paystackTransferCode, payload.transferCode]) {
        if (value != null && value !== obligation.providerTransferCode) {
          throw new Error("Withdrawal obligation contains a conflicting Transfer code.");
        }
      }

      const existingCredit = await Transaction.exists({
        $or: [
          {
            idempotencyKey: `withdrawal-reversal:${withdrawal._id}`,
          },
          {
            relatedTransaction: withdrawal._id,
            type: "withdrawal_reversal",
          },
        ],
      }).session(session);

      if (existingCredit || withdrawal.metadata?.reversalTransactionId) {
        throw new Error("Withdrawal reversal already has a ledger credit.");
      }

      return obligation;
    }

    throw new Error("Unsupported financial obligation type.");
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

      if (
        providerEvent.eventCategory === "employer_wallet_funding" ||
        (providerEvent.provider === "paystack" && providerEvent.eventName === "transfer.reversed")
      ) {
        throw new Error("Confirmed financial events must be reconciled, not ignored.");
      }

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
