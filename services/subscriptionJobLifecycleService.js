// services/subscriptionJobLifecycleService.js

const Subscription = require("../models/Subscription");
const JobPublication = require("../models/JobPublication");

const JobPublicationService = require("./jobPublicationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const ERROR_NAME = "SubscriptionJobLifecycleServiceError";

const ACTIVE_SUBSCRIPTION_PUBLICATION_STATUSES = Object.freeze(["live", "paused"]);
const SUBSCRIPTION_ENTITLEMENT_SOURCE = "subscription_slot";

const DEFAULT_SUBSCRIPTION_END_REASON =
  "Subscription ended and no longer provides Job-slot publication authority.";

const DEFAULT_DOWNGRADE_END_REASON =
  "Subscription plan downgrade reduced active Job-slot capacity.";

const MAX_PUBLICATION_END_REASON_LENGTH = 500;

/**
 * SubscriptionJobLifecycleService owns the boundary between Subscription
 * lifecycle changes and subscription-funded JobPublication lifecycle changes.
 *
 * RESPONSIBILITIES:
 *
 * - identify live/paused JobPublications funded by one exact Subscription;
 * - validate retained JobPublication selections before an immediate paid downgrade;
 * - end excess publications immediately when lower slot capacity is applied;
 * - end all active subscription-funded publications when Subscription authority
 *   terminates;
 * - preserve the underlying Job, JobApplication records and publication history.
 *
 * This service does not change Subscription status, billing periods, plans or
 * payment state. SubscriptionService remains authoritative for those changes.
 *
 * A subscription-funded JobPublication is ended, never naturally expired.
 */
class SubscriptionJobLifecycleService {
  /* ─────────────────────────────── ERRORS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  /* ─────────────────────────────── CORE HELPERS ─────────────────────────────── */

  static normalizeObjectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,
      fieldName,
      required,
      createError: SubscriptionJobLifecycleService.createError,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_SUBSCRIPTION_JOB_LIFECYCLE_CURRENT_TIME",
      });
    }

    return date;
  }

  static normalizeTargetActiveJobSlots(value) {
    const capacity = Number(value);

    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw this.createError({
        message: "Target active Job-slot capacity must be a non-negative whole number.",
        code: "INVALID_TARGET_ACTIVE_JOB_SLOT_CAPACITY",
      });
    }

    return capacity;
  }

  static normalizeEndReason(value, fallback) {
    const reason = String(value || fallback || "").trim();

    if (!reason) {
      throw this.createError({
        message: "Job publication end reason is required.",
        code: "SUBSCRIPTION_JOB_PUBLICATION_END_REASON_REQUIRED",
      });
    }

    if (reason.length > MAX_PUBLICATION_END_REASON_LENGTH) {
      throw this.createError({
        message: `Job publication end reason cannot exceed ${MAX_PUBLICATION_END_REASON_LENGTH} characters.`,
        code: "SUBSCRIPTION_JOB_PUBLICATION_END_REASON_TOO_LONG",
      });
    }

    return reason;
  }

  static normalizeRetainedPublicationIds(value) {
    if (value === null || value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw this.createError({
        message: "retainedPublicationIds must be an array.",
        code: "INVALID_RETAINED_JOB_PUBLICATION_IDS",
      });
    }

    const normalized = value.map((publicationId) =>
      this.normalizeObjectId(publicationId, "retained Job publication ID")
    );

    const normalizedStrings = normalized.map((publicationId) => String(publicationId));

    if (new Set(normalizedStrings).size !== normalizedStrings.length) {
      throw this.createError({
        message: "retainedPublicationIds cannot contain duplicates.",
        code: "DUPLICATE_RETAINED_JOB_PUBLICATION_IDS",
      });
    }

    return normalized;
  }

  static assertActiveForDowngrade(subscription) {
    if (!subscription || subscription.status !== "active") {
      throw this.createError({
        message: "Only an active subscription can apply downgrade Job-slot capacity.",
        code: "SUBSCRIPTION_DOWNGRADE_JOB_LIFECYCLE_NOT_ALLOWED",
        statusCode: 409,
        details: {
          status: subscription?.status || null,
        },
      });
    }

    return true;
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    if (
      options.session &&
      (typeof options.session.inTransaction !== "function" || !options.session.inTransaction())
    ) {
      throw this.createError({
        message: "An active transaction is required for the supplied session.",
        code: "SUBSCRIPTION_JOB_LIFECYCLE_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  static applySession(query, session = null) {
    if (session) {
      query.session(session);
    }

    return query;
  }

  /* ─────────────────────────────── SUBSCRIPTION CONTEXT ─────────────────────────────── */

  static async getSubscription({ subscriptionId, businessId, session = null }) {
    const normalizedSubscriptionId = this.normalizeObjectId(subscriptionId, "subscription ID");

    const normalizedBusinessId = this.normalizeObjectId(businessId, "employer profile ID");

    const subscription = await this.applySession(
      Subscription.findById(normalizedSubscriptionId).select(
        "_id business status currentPeriodStart currentPeriodEnd plan planSnapshot pendingPlanChange"
      ),
      session
    );

    if (!subscription) {
      throw this.createError({
        message: "Subscription was not found.",
        code: "SUBSCRIPTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (String(subscription.business) !== String(normalizedBusinessId)) {
      throw this.createError({
        message: "Subscription does not belong to this employer.",
        code: "SUBSCRIPTION_EMPLOYER_MISMATCH",
        statusCode: 409,
      });
    }

    return subscription;
  }

  /* ─────────────────────────────── ACTIVE OCCUPANCY ─────────────────────────────── */

  static async listActiveSubscriptionPublications({ subscriptionId, businessId, session = null }) {
    const subscription = await this.getSubscription({
      subscriptionId,
      businessId,
      session,
    });

    const publications = await this.applySession(
      JobPublication.find({
        business: subscription.business,
        "entitlementSnapshot.source": SUBSCRIPTION_ENTITLEMENT_SOURCE,
        "entitlementSnapshot.subscription": subscription._id,
        status: {
          $in: ACTIVE_SUBSCRIPTION_PUBLICATION_STATUSES,
        },
      })
        .select(
          "_id job business status publishedAt applicationDeadline " +
            "entitlementSnapshot.subscription entitlementSnapshot.consumptionReference"
        )
        .sort({
          publishedAt: 1,
          _id: 1,
        })
        .lean(),
      session
    );

    return {
      subscription,
      publications,
      count: publications.length,
    };
  }

  /* ─────────────────────────────── DOWNGRADE SELECTION ─────────────────────────────── */

  static async validateDowngradeRetentionSelection({
    subscriptionId,
    businessId,
    targetActiveJobSlots,
    retainedPublicationIds = [],
    session = null,
  }) {
    const targetCapacity = this.normalizeTargetActiveJobSlots(targetActiveJobSlots);

    const normalizedRetainedIds = this.normalizeRetainedPublicationIds(retainedPublicationIds);

    const { subscription, publications } = await this.listActiveSubscriptionPublications({
      subscriptionId,
      businessId,
      session,
    });

    this.assertActiveForDowngrade(subscription);

    const activePublicationCount = publications.length;

    const activePublicationById = new Map(
      publications.map((publication) => [String(publication._id), publication])
    );

    /*
     * If occupancy has already fallen to or below the target capacity, every
     * currently active publication can remain. A previously prepared selection may
     * have become stale because one of its publications closed before the paid
     * downgrade is applied; no arbitrary replacement publication needs to be chosen.
     */
    if (activePublicationCount <= targetCapacity) {
      return {
        subscription,
        targetActiveJobSlots: targetCapacity,
        activePublications: publications,
        activePublicationCount,
        requiresSelection: false,
        requestedRetainedPublicationIds: normalizedRetainedIds,
        effectiveRetainedPublicationIds: publications.map((publication) => publication._id),
        excessPublications: [],
      };
    }

    if (normalizedRetainedIds.length !== targetCapacity) {
      throw this.createError({
        message:
          targetCapacity === 0
            ? "No Job publications may be retained when the target plan has zero active Job slots."
            : `Select exactly ${targetCapacity} active Job publication${
                targetCapacity === 1 ? "" : "s"
              } to retain after the downgrade.`,
        code: "SUBSCRIPTION_DOWNGRADE_RETENTION_SELECTION_REQUIRED",
        statusCode: 409,
        details: {
          activePublicationCount,
          targetActiveJobSlots: targetCapacity,
          requiredSelectionCount: targetCapacity,
          selectedPublicationCount: normalizedRetainedIds.length,
        },
      });
    }

    for (const publicationId of normalizedRetainedIds) {
      if (!activePublicationById.has(String(publicationId))) {
        throw this.createError({
          message:
            "Every retained Job publication must currently be active and funded by this Subscription.",
          code: "INVALID_SUBSCRIPTION_DOWNGRADE_RETAINED_PUBLICATION",
          statusCode: 409,
          details: {
            publicationId: String(publicationId),
            subscriptionId: String(subscription._id),
          },
        });
      }
    }

    const retainedSet = new Set(
      normalizedRetainedIds.map((publicationId) => String(publicationId))
    );

    const excessPublications = publications.filter(
      (publication) => !retainedSet.has(String(publication._id))
    );

    return {
      subscription,
      targetActiveJobSlots: targetCapacity,
      activePublications: publications,
      activePublicationCount,
      requiresSelection: targetCapacity > 0,
      requestedRetainedPublicationIds: normalizedRetainedIds,
      effectiveRetainedPublicationIds: normalizedRetainedIds,
      excessPublications,
    };
  }

  /* ─────────────────────────────── APPLY DOWNGRADE CAPACITY ─────────────────────────────── */

  static async applyDowngradePublicationCapacity(
    {
      subscriptionId,
      businessId,
      targetActiveJobSlots,
      retainedPublicationIds = [],
      currentTime = new Date(),
      reason = DEFAULT_DOWNGRADE_END_REASON,
    },
    options = {}
  ) {
    const appliedAt = this.normalizeCurrentTime(currentTime);

    const normalizedReason = this.normalizeEndReason(reason, DEFAULT_DOWNGRADE_END_REASON);

    return this.runWithOptionalTransaction(options, async (session) => {
      const validation = await this.validateDowngradeRetentionSelection({
        subscriptionId,
        businessId,
        targetActiveJobSlots,
        retainedPublicationIds,
        session,
      });

      const endedPublicationIds = [];
      const events = [];

      for (const publication of validation.excessPublications) {
        const result = await JobPublicationService.endPublicationBySystem(
          {
            publicationId: publication._id,
            reason: normalizedReason,
            currentTime: appliedAt,
          },
          {
            session,
          }
        );

        if (result.ended === true) {
          endedPublicationIds.push(result.publication._id);
        }

        events.push(...(result.events || []));
      }

      const postApplicationState = await this.listActiveSubscriptionPublications({
        subscriptionId: validation.subscription._id,
        businessId: validation.subscription.business,
        session,
      });

      if (postApplicationState.count > validation.targetActiveJobSlots) {
        throw this.createError({
          message:
            "The immediate subscription downgrade did not reduce active Job publications to the target slot capacity.",
          code: "SUBSCRIPTION_DOWNGRADE_CAPACITY_APPLICATION_INCOMPLETE",
          statusCode: 500,
          details: {
            subscriptionId: String(validation.subscription._id),
            targetActiveJobSlots: validation.targetActiveJobSlots,
            activePublicationCountAfter: postApplicationState.count,
          },
        });
      }

      return {
        subscription: validation.subscription,
        targetActiveJobSlots: validation.targetActiveJobSlots,
        activePublicationCountBefore: validation.activePublicationCount,
        activePublicationCountAfter: postApplicationState.count,
        retainedPublicationIds: postApplicationState.publications.map(
          (publication) => publication._id
        ),
        endedPublicationIds,
        endedPublicationCount: endedPublicationIds.length,
        events,
      };
    });
  }

  /* ─────────────────────────────── END SUBSCRIPTION PUBLICATIONS ─────────────────────────────── */

  static async endActiveSubscriptionPublications(
    {
      subscriptionId,
      businessId,
      currentTime = new Date(),
      reason = DEFAULT_SUBSCRIPTION_END_REASON,
    },
    options = {}
  ) {
    const endedAt = this.normalizeCurrentTime(currentTime);

    const normalizedReason = this.normalizeEndReason(reason, DEFAULT_SUBSCRIPTION_END_REASON);

    return this.runWithOptionalTransaction(options, async (session) => {
      const { subscription, publications } = await this.listActiveSubscriptionPublications({
        subscriptionId,
        businessId,
        session,
      });

      const endedPublicationIds = [];
      const events = [];

      for (const publication of publications) {
        const result = await JobPublicationService.endPublicationBySystem(
          {
            publicationId: publication._id,
            reason: normalizedReason,
            currentTime: endedAt,
          },
          {
            session,
          }
        );

        if (result.ended === true) {
          endedPublicationIds.push(result.publication._id);
        }

        events.push(...(result.events || []));
      }

      return {
        subscription,
        activePublicationCountBefore: publications.length,
        endedPublicationIds,
        endedPublicationCount: endedPublicationIds.length,
        events,
      };
    });
  }
}

module.exports = SubscriptionJobLifecycleService;
