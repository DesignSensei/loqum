// services/subscriptionPaymentService.js

const crypto = require("crypto");

const EmployerProfile = require("../models/EmployerProfile");
const Subscription = require("../models/Subscription");
const SubscriptionPayment = require("../models/SubscriptionPayment");
const Transaction = require("../models/Transaction");

const SubscriptionService = require("./subscriptionService");
const WalletService = require("./walletService");
const PaystackService = require("./paystackService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH } = require("../constants/employerMonetization");

const ERROR_NAME = "SubscriptionPaymentServiceError";

const SUBSCRIPTION_PAYMENT_TYPE = "subscription_payment";
const SUBSCRIPTION_PAYMENT_PURPOSE = "subscription_payment";

const PAYSTACK_OPEN_TRANSACTION_STATUSES = Object.freeze(["pending", "processing"]);
const PAYSTACK_DEFINITIVE_FAILURE_STATUSES = Object.freeze(["failed", "abandoned"]);

const MAX_IDEMPOTENCY_KEY_LENGTH = 250;
const DEFAULT_APPLICATION_BATCH_SIZE = 100;
const MAX_APPLICATION_BATCH_SIZE = 500;

/**
 * SubscriptionPaymentService owns employer subscription money movement.
 *
 * PAYMENT / LIFECYCLE SEPARATION
 *
 * SubscriptionPayment records that money for one billing period has been paid.
 * SubscriptionService remains authoritative for subscription lifecycle state and
 * purchased subscription benefits.
 *
 * Initial purchase:
 *
 *   successful payment
 *   -> activateSubscription()
 *   -> first billing period begins
 *   -> purchased active Job-slot capacity becomes available
 *   -> SubscriptionPayment is stamped with the applied period
 *
 * Plan change purchase:
 *
 *   successful payment
 *   -> the target plan replaces the current plan immediately
 *   -> unused value/time on the previous plan is forfeited
 *   -> downgrade slot-capacity enforcement happens before the switch commits
 *   -> one new billing period begins for the newly purchased plan
 *   -> the old and new plans are never simultaneously effective
 *
 * Renewal:
 *
 *   successful early payment
 *   -> SubscriptionPayment becomes paid
 *   -> the current Subscription period and plan remain unchanged
 *   -> payment remains unapplied until currentPeriodEnd
 *
 * At the billing boundary:
 *
 *   paid unapplied renewal
 *   -> renewSubscription()
 *   -> next billing period begins from the previous currentPeriodEnd
 *   -> SubscriptionPayment.appliedAt is set
 *
 * ONE-PERIOD PREPAYMENT RULE
 *
 * Only one paid, unapplied renewal may exist for a Subscription at a time.
 * This prevents multi-period stacking at launch.
 *
 * CANONICAL RECEIPT
 *
 * Wallet payment:
 *   Employer wallet -> Platform wallet
 *   SubscriptionPayment.paymentTransaction -> platform-wallet credit
 *
 * Paystack payment:
 *   Paystack -> Platform wallet
 *   SubscriptionPayment.paymentTransaction -> platform-wallet credit
 *
 * PAYSTACK AUTHORIZATION
 *
 * A reusable authorization captured from a successful Paystack payment may be
 * used for a later renewal. Authorization charging writes a pending external
 * platform-wallet credit first and completes it only after verification.
 */
class SubscriptionPaymentService {
  /* ─────────────────────────────── ERRORS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });

    if (cause) {
      error.cause = cause;
    }

    return error;
  }

  /* ─────────────────────────────── CORE HELPERS ─────────────────────────────── */

  static normalizeObjectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,
      fieldName,
      required,
      createError: SubscriptionPaymentService.createError,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeCountryCode(value) {
    const countryCode = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw this.createError({
        message: "A valid two-letter country code is required.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_COUNTRY_CODE",
        statusCode: 500,
      });
    }

    return countryCode;
  }

  static normalizeCurrency(value) {
    const currency = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw this.createError({
        message: "A valid three-letter currency code is required.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_CURRENCY",
        statusCode: 500,
      });
    }

    return currency;
  }

  static normalizeIdempotencyKey(value) {
    const idempotencyKey = String(value || "").trim();

    if (!idempotencyKey) {
      throw this.createError({
        message: "An idempotency key is required for a subscription payment.",
        code: "SUBSCRIPTION_PAYMENT_IDEMPOTENCY_KEY_REQUIRED",
      });
    }

    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw this.createError({
        message: "The subscription payment idempotency key is too long.",
        code: "SUBSCRIPTION_PAYMENT_IDEMPOTENCY_KEY_TOO_LONG",
      });
    }

    return idempotencyKey;
  }

  static normalizePaymentKind(value) {
    const paymentKind = String(value || "")
      .trim()
      .toLowerCase();

    if (!["initial_purchase", "plan_change", "renewal"].includes(paymentKind)) {
      throw this.createError({
        message: "Subscription payment kind must be initial_purchase, plan_change or renewal.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_KIND",
      });
    }

    return paymentKind;
  }

  static normalizeBatchLimit(value = DEFAULT_APPLICATION_BATCH_SIZE) {
    const limit = Number(value);

    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_APPLICATION_BATCH_SIZE) {
      throw this.createError({
        message: `Application batch limit must be between 1 and ${MAX_APPLICATION_BATCH_SIZE}.`,
        code: "INVALID_SUBSCRIPTION_PAYMENT_BATCH_LIMIT",
      });
    }

    return limit;
  }

  static applySession(query, session = null) {
    if (session) {
      query.session(session);
    }

    return query;
  }

  static saveOptions(session = null) {
    return session ? { session } : {};
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    if (
      options.session &&
      (typeof options.session.inTransaction !== "function" || !options.session.inTransaction())
    ) {
      throw this.createError({
        message: "An active transaction is required for the supplied session.",
        code: "SUBSCRIPTION_PAYMENT_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  static assertOwnTransactionBoundary(options = {}) {
    if (options.session) {
      throw this.createError({
        message:
          "This payment operation must own its transaction and commit before follow-up work.",
        code: "SUBSCRIPTION_PAYMENT_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
      });
    }
  }

  static async serializePaymentPreparation({ subscriptionId, employerProfileId, session }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.createError({
        message: "Payment preparation requires an active transaction.",
        code: "SUBSCRIPTION_PAYMENT_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    // Coordinate payment-attempt checks with other preparations and lifecycle
    // changes. A real write detects stale snapshots; preserve driver errors so
    // the transaction owner retries all reads/checks, not just this update.
    const result = await Subscription.updateOne(
      { _id: subscriptionId, business: employerProfileId },
      { $inc: { __v: 1 } },
      { session, timestamps: false }
    );

    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw this.createError({
        message: "Subscription is no longer available for payment preparation.",
        code: "SUBSCRIPTION_PAYMENT_SUBSCRIPTION_CHANGED",
        statusCode: 409,
      });
    }
  }

  static assertCanManageSubscription(employerContext = null) {
    return SubscriptionService.assertCanManageSubscription(employerContext);
  }

  static buildPaymentReference({ idempotencyKey, paymentKind }) {
    const normalizedKey = this.normalizeIdempotencyKey(idempotencyKey);
    const normalizedKind = this.normalizePaymentKind(paymentKind);

    const digest = crypto
      .createHash("sha256")
      .update(`${normalizedKind}:${normalizedKey}`)
      .digest("hex")
      .slice(0, 32);

    const kindCode =
      normalizedKind === "initial_purchase"
        ? "INIT"
        : normalizedKind === "plan_change"
          ? "CHG"
          : "REN";

    return `LQ-SUBPAY-${kindCode}-${digest}`.toUpperCase();
  }

  static buildAutomaticRenewalIdempotencyKey({ subscriptionId, billingCycleKey }) {
    return `subscription-auto-renew:${String(subscriptionId)}:${String(billingCycleKey)}`;
  }

  static buildWalletIdempotencyKeys(paymentReference) {
    const prefix = `subscription-payment:${String(paymentReference).trim().toLowerCase()}`;

    return {
      debitIdempotencyKey: `${prefix}:employer-debit`,
      creditIdempotencyKey: `${prefix}:platform-credit`,
    };
  }

  static buildPaystackCreditIdempotencyKey(paymentReference) {
    return `subscription-payment:${String(paymentReference).trim().toLowerCase()}:paystack-credit`;
  }

  static truncateFailureReason(value) {
    return String(value || "Subscription payment failed.")
      .trim()
      .slice(0, MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH);
  }

  static sameDate(left, right) {
    if (!left || !right) {
      return false;
    }

    return new Date(left).getTime() === new Date(right).getTime();
  }

  static resolveApplicationTime({ paidAt = null, currentTime = new Date() }) {
    const normalizedCurrentTime = this.normalizeCurrentTime(currentTime);

    if (!paidAt) {
      return normalizedCurrentTime;
    }

    const normalizedPaidAt = this.normalizeCurrentTime(paidAt);

    return normalizedCurrentTime < normalizedPaidAt ? normalizedPaidAt : normalizedCurrentTime;
  }

  /* ─────────────────────────────── DATA LOADERS ─────────────────────────────── */

  static async getEmployerProfile(employerProfileId, session = null) {
    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const employerProfile = await this.applySession(
      EmployerProfile.findById(normalizedEmployerProfileId).select(
        "user businessName businessEmail countryCode currency"
      ),
      session
    );

    if (!employerProfile) {
      throw this.createError({
        message: "Employer profile not found.",
        code: "SUBSCRIPTION_PAYMENT_EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employerProfile;
  }

  static async getPaymentByReference(paymentReference, session = null) {
    const normalizedReference = String(paymentReference || "")
      .trim()
      .toUpperCase();

    if (!normalizedReference) {
      return null;
    }

    return this.applySession(
      SubscriptionPayment.findOne({
        paymentReference: normalizedReference,
      }),
      session
    );
  }

  static async getPaymentByProviderReference(providerReference, session = null) {
    const normalizedReference = String(providerReference || "").trim();

    if (!normalizedReference) {
      throw this.createError({
        message: "A Paystack payment reference is required.",
        code: "SUBSCRIPTION_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
      });
    }

    const payment = await this.applySession(
      SubscriptionPayment.findOne({
        paymentProvider: "paystack",
        providerReference: normalizedReference,
      }),
      session
    );

    if (!payment) {
      throw this.createError({
        message: "The subscription payment was not found.",
        code: "SUBSCRIPTION_PAYMENT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return payment;
  }

  static async getPayment(paymentId, session = null) {
    const normalizedPaymentId = this.normalizeObjectId(paymentId, "subscription payment ID");

    const payment = await this.applySession(
      SubscriptionPayment.findById(normalizedPaymentId),
      session
    );

    if (!payment) {
      throw this.createError({
        message: "Subscription payment not found.",
        code: "SUBSCRIPTION_PAYMENT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return payment;
  }

  static async getPendingSubscriptionForEmployer(employerProfileId, session = null) {
    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    return this.applySession(
      Subscription.findOne({
        business: normalizedEmployerProfileId,
        status: "pending",
      }).sort({ createdAt: -1 }),
      session
    );
  }

  /* ─────────────────────────────── SNAPSHOTS / TARGET PERIODS ─────────────────────────────── */

  static clonePlanSnapshot(snapshot) {
    const source = snapshot?.toObject ? snapshot.toObject() : snapshot;

    if (!source) {
      throw this.createError({
        message: "Subscription plan snapshot is missing.",
        code: "SUBSCRIPTION_PAYMENT_PLAN_SNAPSHOT_MISSING",
        statusCode: 500,
      });
    }

    return {
      code: source.code,
      version: source.version,
      name: source.name,
      countryCode: source.countryCode,
      currency: source.currency,
      priceMinor: source.priceMinor,
      billingCycle: source.billingCycle,
      benefits: {
        activeJobSlots: source.benefits?.activeJobSlots ?? 0,
        basePlatformFeeRate: source.benefits?.basePlatformFeeRate ?? null,
        featureKeys: Array.isArray(source.benefits?.featureKeys)
          ? [...source.benefits.featureKeys]
          : [],
      },
    };
  }

  static resolveRenewalTarget({ subscription, currentTime = new Date() }) {
    const now = this.normalizeCurrentTime(currentTime);

    if (!subscription || subscription.status !== "active") {
      throw this.createError({
        message: "Only an active subscription can purchase a renewal.",
        code: "SUBSCRIPTION_PAYMENT_RENEWAL_NOT_ALLOWED",
        statusCode: 409,
        details: {
          status: subscription?.status || null,
        },
      });
    }

    if (subscription.cancelAtPeriodEnd) {
      throw this.createError({
        message: "A subscription scheduled for cancellation cannot purchase another renewal.",
        code: "SUBSCRIPTION_PAYMENT_RENEWAL_BLOCKED_BY_CANCELLATION",
        statusCode: 409,
      });
    }

    if (subscription.pendingPlanChange) {
      throw this.createError({
        message:
          "A subscription with a plan-change purchase in progress cannot purchase or charge a renewal.",
        code: "SUBSCRIPTION_PAYMENT_RENEWAL_BLOCKED_BY_PLAN_CHANGE",
        statusCode: 409,
        details: {
          targetPlanId: String(subscription.pendingPlanChange.targetPlan),
        },
      });
    }

    if (!subscription.currentPlanStartedAt || !subscription.currentPeriodEnd) {
      throw this.createError({
        message: "The subscription is missing its current-plan billing boundary.",
        code: "SUBSCRIPTION_PAYMENT_PERIOD_INTEGRITY_ERROR",
        statusCode: 500,
      });
    }

    const periodStart = new Date(subscription.currentPeriodEnd);

    if (now >= periodStart) {
      throw this.createError({
        message:
          "The current paid subscription period has ended. Start a new subscription instead of purchasing a late renewal.",
        code: "SUBSCRIPTION_PAYMENT_RENEWAL_PERIOD_ENDED",
        statusCode: 409,
        details: {
          currentPeriodEnd: periodStart,
        },
      });
    }

    const nextCycleNumber = Number(subscription.renewalCount || 0) + 2;

    const periodEnd = SubscriptionService.getBillingPeriodEnd({
      activatedAt: subscription.currentPlanStartedAt,
      billingCycle: subscription.planSnapshot.billingCycle,
      cycleNumber: nextCycleNumber,
    });

    return {
      periodStart,
      periodEnd,
      billingCycleKey: SubscriptionService.buildBillingCycleKey({
        subscriptionId: subscription._id,
        periodStart,
      }),
    };
  }

  static async assertNoOtherPaidFutureRenewal({
    subscriptionId,
    paymentReference = null,
    session = null,
  }) {
    const filter = {
      subscription: this.normalizeObjectId(subscriptionId, "subscription ID"),
      paymentKind: "renewal",
      paymentStatus: "paid",
      appliedAt: null,
    };

    if (paymentReference) {
      filter.paymentReference = {
        $ne: String(paymentReference).trim().toUpperCase(),
      };
    }

    const existing = await this.applySession(SubscriptionPayment.findOne(filter), session);

    if (existing) {
      throw this.createError({
        message: "This subscription already has one future renewal period paid in advance.",
        code: "SUBSCRIPTION_FUTURE_RENEWAL_ALREADY_PAID",
        statusCode: 409,
        details: {
          paymentId: String(existing._id),
          paymentReference: existing.paymentReference,
          periodStart: existing.periodStart,
          periodEnd: existing.periodEnd,
        },
      });
    }

    return true;
  }

  static async assertNoOutstandingRenewalForPlanChange({
    subscriptionId,
    paymentReference = null,
    session = null,
  }) {
    const normalizedSubscriptionId = this.normalizeObjectId(subscriptionId, "subscription ID");

    const filter = {
      subscription: normalizedSubscriptionId,
      paymentKind: "renewal",
      $or: [
        {
          paymentStatus: "pending",
        },
        {
          paymentStatus: "paid",
          appliedAt: null,
        },
      ],
    };

    if (paymentReference) {
      filter.paymentReference = {
        $ne: String(paymentReference).trim().toUpperCase(),
      };
    }

    const existing = await this.applySession(
      SubscriptionPayment.findOne(filter).sort({
        createdAt: -1,
      }),
      session
    );

    if (existing) {
      throw this.createError({
        message:
          "A pending or prepaid future renewal must be resolved before purchasing a different subscription plan.",
        code: "SUBSCRIPTION_PLAN_CHANGE_BLOCKED_BY_RENEWAL_PAYMENT",
        statusCode: 409,
        details: {
          paymentId: String(existing._id),
          paymentReference: existing.paymentReference,
          paymentStatus: existing.paymentStatus,
          periodStart: existing.periodStart || null,
          periodEnd: existing.periodEnd || null,
        },
      });
    }

    return true;
  }

  static async assertNoOtherOpenPaymentForPeriod({
    subscriptionId,
    paymentKind,
    billingCycleKey = null,
    paymentReference = null,
    session = null,
  }) {
    const filter = {
      subscription: this.normalizeObjectId(subscriptionId, "subscription ID"),
      paymentKind: this.normalizePaymentKind(paymentKind),
      paymentStatus: "pending",
    };

    if (billingCycleKey) {
      filter.billingCycleKey = billingCycleKey;
    }

    if (paymentReference) {
      filter.paymentReference = {
        $ne: String(paymentReference).trim().toUpperCase(),
      };
    }

    const existing = await this.applySession(SubscriptionPayment.findOne(filter), session);

    if (existing) {
      throw this.createError({
        message: "A subscription payment attempt is already open for this billing period.",
        code: "SUBSCRIPTION_PAYMENT_ATTEMPT_ALREADY_OPEN",
        statusCode: 409,
        details: {
          paymentId: String(existing._id),
          paymentReference: existing.paymentReference,
          paymentMethod: existing.paymentMethod,
        },
      });
    }

    return true;
  }

  /* ─────────────────────────────── INITIAL SUBSCRIPTION ─────────────────────────────── */

  static async getOrCreateInitialSubscription(
    { employerProfileId, employerContext = null, planId, initiatedByUserId, currentTime },
    { session }
  ) {
    const pendingSubscription = await this.getPendingSubscriptionForEmployer(
      employerProfileId,
      session
    );

    if (pendingSubscription) {
      if (String(pendingSubscription.plan) !== String(planId)) {
        throw this.createError({
          message:
            "The employer already has a pending subscription for a different plan. Resolve that payment attempt before choosing another plan.",
          code: "EMPLOYER_PENDING_SUBSCRIPTION_PLAN_CONFLICT",
          statusCode: 409,
          details: {
            subscriptionId: String(pendingSubscription._id),
            planId: String(pendingSubscription.plan),
          },
        });
      }

      return {
        subscription: pendingSubscription,
        created: false,
        events: [],
      };
    }

    return SubscriptionService.createSubscription(
      {
        employerProfileId,
        employerContext,
        planId,
        subscribedByUserId: initiatedByUserId,
        currentTime,
      },
      {
        session,
      }
    );
  }

  static assertExistingPaymentMatches({
    payment,
    employerProfileId,
    paymentKind,
    paymentMethod,
    planId = null,
    subscriptionId = null,
  }) {
    const matches = Boolean(
      payment &&
      String(payment.business) === String(employerProfileId) &&
      payment.paymentKind === paymentKind &&
      payment.paymentMethod === paymentMethod &&
      (!planId || String(payment.plan) === String(planId)) &&
      (!subscriptionId || String(payment.subscription) === String(subscriptionId))
    );

    if (!matches) {
      throw this.createError({
        message: "The idempotency key belongs to a different subscription payment.",
        code: "SUBSCRIPTION_PAYMENT_IDEMPOTENCY_CONFLICT",
        statusCode: 409,
        details: {
          paymentReference: payment?.paymentReference || null,
        },
      });
    }

    return true;
  }

  static assertExistingPaymentReusable(payment) {
    if (payment.paymentStatus === "refunded") {
      throw this.createError({
        message: "This subscription payment has been refunded and cannot be reused.",
        code: "SUBSCRIPTION_PAYMENT_ALREADY_REFUNDED",
        statusCode: 409,
      });
    }

    if (["failed", "cancelled"].includes(payment.paymentStatus)) {
      throw this.createError({
        message: "This subscription payment attempt is closed. Start a new payment attempt.",
        code: "SUBSCRIPTION_PAYMENT_ATTEMPT_CLOSED",
        statusCode: 409,
        details: {
          paymentStatus: payment.paymentStatus,
          paymentReference: payment.paymentReference,
        },
      });
    }

    return true;
  }

  /* ─────────────────────────────── PAYMENT APPLICATION ─────────────────────────────── */

  static stampPaymentPeriod({ payment, subscription, appliedAt }) {
    payment.periodStart = new Date(subscription.currentPeriodStart);
    payment.periodEnd = new Date(subscription.currentPeriodEnd);
    payment.billingCycleKey = SubscriptionService.buildBillingCycleKey({
      subscriptionId: subscription._id,
      periodStart: payment.periodStart,
    });
    payment.appliedAt = appliedAt;
  }

  static async applyPaidPaymentInternal({ payment, currentTime, session }) {
    const appliedAt = this.resolveApplicationTime({
      paidAt: payment?.paidAt || null,
      currentTime,
    });

    if (payment.appliedAt) {
      return {
        payment,
        applied: false,
        idempotent: true,
        reason: "already_applied",
        lifecycle: null,
        events: [],
      };
    }

    if (payment.paymentStatus !== "paid") {
      throw this.createError({
        message: "Only a paid subscription payment can be applied.",
        code: "SUBSCRIPTION_PAYMENT_NOT_PAID",
        statusCode: 409,
        details: {
          paymentStatus: payment.paymentStatus,
        },
      });
    }

    if (payment.paymentKind === "initial_purchase") {
      const lifecycle = await SubscriptionService.activateSubscription(
        {
          subscriptionId: payment.subscription,
          employerProfileId: payment.business,
          currentTime: payment.paidAt,
        },
        {
          session,
        }
      );

      this.stampPaymentPeriod({
        payment,
        subscription: lifecycle.subscription,
        appliedAt,
      });

      await payment.save(this.saveOptions(session));

      return {
        payment,
        applied: true,
        idempotent: lifecycle.idempotent === true,
        reason: null,
        lifecycle,
        events: lifecycle.events || [],
      };
    }

    if (payment.paymentKind === "plan_change") {
      const lifecycle = await SubscriptionService.applyPaidPlanChange(
        {
          subscriptionId: payment.subscription,
          employerProfileId: payment.business,
          targetPlanId: payment.plan,
          paymentReference: payment.paymentReference,
          currentTime: payment.paidAt,
        },
        {
          session,
        }
      );

      if (String(lifecycle.subscription.plan) !== String(payment.plan)) {
        throw this.createError({
          message:
            "The applied plan change does not match the plan purchased by the subscription payment.",
          code: "SUBSCRIPTION_PAYMENT_PLAN_CHANGE_TARGET_MISMATCH",
          statusCode: 500,
          details: {
            paymentPlanId: String(payment.plan),
            subscriptionPlanId: String(lifecycle.subscription.plan),
          },
        });
      }

      this.stampPaymentPeriod({
        payment,
        subscription: lifecycle.subscription,
        appliedAt,
      });

      await payment.save(this.saveOptions(session));

      return {
        payment,
        applied: true,
        idempotent: lifecycle.idempotent === true,
        reason: null,
        lifecycle,
        events: lifecycle.events || [],
      };
    }

    if (!payment.periodStart || !payment.periodEnd || !payment.billingCycleKey) {
      throw this.createError({
        message: "The paid renewal does not identify its purchased billing period.",
        code: "SUBSCRIPTION_PAYMENT_RENEWAL_PERIOD_MISSING",
        statusCode: 500,
      });
    }

    if (appliedAt < new Date(payment.periodStart)) {
      return {
        payment,
        applied: false,
        idempotent: false,
        reason: "billing_period_not_started",
        lifecycle: null,
        events: [],
      };
    }

    if (payment.paidAt && new Date(payment.paidAt) > new Date(payment.periodStart)) {
      throw this.createError({
        message:
          "The renewal payment completed after the previous subscription period ended and cannot extend that subscription. Payment reconciliation is required.",
        code: "PAID_RENEWAL_COMPLETED_AFTER_PERIOD_END",
        statusCode: 409,
        details: {
          paymentId: String(payment._id),
          paidAt: payment.paidAt,
          previousPeriodEnd: payment.periodStart,
        },
      });
    }

    const subscription = await SubscriptionService.getSubscription({
      subscriptionId: payment.subscription,
      employerProfileId: payment.business,
      session,
    });

    if (subscription.cancelAtPeriodEnd) {
      throw this.createError({
        message:
          "This renewal is paid but the subscription is scheduled for cancellation. Payment reconciliation is required before lifecycle application.",
        code: "PAID_RENEWAL_BLOCKED_BY_CANCELLATION",
        statusCode: 409,
        details: {
          paymentId: String(payment._id),
          subscriptionId: String(subscription._id),
        },
      });
    }

    if (
      this.sameDate(subscription.currentPeriodStart, payment.periodStart) &&
      this.sameDate(subscription.currentPeriodEnd, payment.periodEnd)
    ) {
      payment.appliedAt = appliedAt;

      await payment.save(this.saveOptions(session));

      return {
        payment,
        applied: true,
        idempotent: true,
        reason: "lifecycle_already_advanced",
        lifecycle: {
          subscription,
        },
        events: [],
      };
    }

    if (!this.sameDate(subscription.currentPeriodEnd, payment.periodStart)) {
      throw this.createError({
        message: "The paid renewal no longer matches the subscription's next billing period.",
        code: "SUBSCRIPTION_PAYMENT_RENEWAL_TARGET_MISMATCH",
        statusCode: 409,
        details: {
          subscriptionCurrentPeriodEnd: subscription.currentPeriodEnd,
          paymentPeriodStart: payment.periodStart,
          paymentPeriodEnd: payment.periodEnd,
        },
      });
    }

    const lifecycle = await SubscriptionService.renewSubscription(
      {
        subscriptionId: payment.subscription,
        employerProfileId: payment.business,
        currentTime: appliedAt,
      },
      {
        session,
      }
    );

    if (
      !this.sameDate(lifecycle.subscription.currentPeriodStart, payment.periodStart) ||
      !this.sameDate(lifecycle.subscription.currentPeriodEnd, payment.periodEnd)
    ) {
      throw this.createError({
        message: "The renewed subscription period does not match the paid renewal period.",
        code: "SUBSCRIPTION_PAYMENT_APPLIED_PERIOD_MISMATCH",
        statusCode: 500,
        details: {
          expectedPeriodStart: payment.periodStart,
          expectedPeriodEnd: payment.periodEnd,
          actualPeriodStart: lifecycle.subscription.currentPeriodStart,
          actualPeriodEnd: lifecycle.subscription.currentPeriodEnd,
        },
      });
    }

    payment.appliedAt = appliedAt;

    await payment.save(this.saveOptions(session));

    return {
      payment,
      applied: true,
      idempotent: lifecycle.idempotent === true,
      reason: null,
      lifecycle,
      events: lifecycle.events || [],
    };
  }

  static async applyPaidPayment({ paymentId, currentTime = new Date() }, options = {}) {
    const normalizedPaymentId = this.normalizeObjectId(paymentId, "subscription payment ID");

    const appliedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const payment = await this.getPayment(normalizedPaymentId, session);

      return this.applyPaidPaymentInternal({
        payment,
        currentTime: appliedAt,
        session,
      });
    });
  }

  static async attemptApplicationAfterPayment({ paymentId, currentTime }) {
    try {
      const application = await this.applyPaidPayment({
        paymentId,
        currentTime,
      });

      return {
        application,
        applicationError: null,
      };
    } catch (error) {
      return {
        application: null,
        applicationError: {
          code: error.code || "SUBSCRIPTION_PAYMENT_APPLICATION_FAILED",
          message: error.message,
          statusCode: error.statusCode || 500,
        },
      };
    }
  }

  /* ─────────────────────────────── PAYMENT CONTEXT ─────────────────────────────── */

  static async resolveInitialPaymentContext({
    employerProfileId,
    employerContext,
    planId,
    initiatedByUserId,
    currentTime,
    paymentReference,
    session,
  }) {
    const employerProfile = await this.getEmployerProfile(employerProfileId, session);
    const plan = await SubscriptionService.getPlan(planId, session);

    SubscriptionService.assertPlanAvailableForEmployer({
      plan,
      employerProfile,
    });

    const subscriptionResult = await this.getOrCreateInitialSubscription(
      {
        employerProfileId,
        employerContext,
        planId,
        initiatedByUserId,
        currentTime,
      },
      {
        session,
      }
    );

    await this.serializePaymentPreparation({
      subscriptionId: subscriptionResult.subscription._id,
      employerProfileId,
      session,
    });

    // A settled initial purchase may still be awaiting lifecycle application.
    // Do not open another checkout or debit while the Subscription remains pending.
    const paidInitial = await this.applySession(
      SubscriptionPayment.exists({
        subscription: subscriptionResult.subscription._id,
        paymentKind: "initial_purchase",
        paymentStatus: "paid",
      }),
      session
    );

    if (paidInitial) {
      throw this.createError({
        message:
          "The initial subscription purchase is already paid and awaits reconciliation or application.",
        code: "SUBSCRIPTION_INITIAL_PURCHASE_ALREADY_PAID",
        statusCode: 409,
      });
    }

    await this.assertNoOtherOpenPaymentForPeriod({
      subscriptionId: subscriptionResult.subscription._id,
      paymentKind: "initial_purchase",
      paymentReference,
      session,
    });

    const planSnapshot = this.clonePlanSnapshot(subscriptionResult.subscription.planSnapshot);

    return {
      employerProfile,
      subscription: subscriptionResult.subscription,
      planId: subscriptionResult.subscription.plan,
      planSnapshot,
      amount: planSnapshot.priceMinor,
      countryCode: this.normalizeCountryCode(planSnapshot.countryCode),
      currency: this.normalizeCurrency(planSnapshot.currency),
      targetPeriod: null,
      events: subscriptionResult.events || [],
    };
  }

  static async resolvePlanChangePaymentContext({
    employerProfileId,
    employerContext,
    subscriptionId,
    planId,
    initiatedByUserId,
    retainedPublicationIds = [],
    currentTime,
    paymentReference,
    session,
  }) {
    // Preparation can reuse pending plan state without saving it again.
    // Always coordinate new payment creation with settlement and expiry.
    await this.serializePaymentPreparation({
      subscriptionId,
      employerProfileId,
      session,
    });

    const employerProfile = await this.getEmployerProfile(employerProfileId, session);

    await this.assertNoOutstandingRenewalForPlanChange({
      subscriptionId,
      paymentReference,
      session,
    });

    await this.assertNoOtherOpenPaymentForPeriod({
      subscriptionId,
      paymentKind: "plan_change",
      paymentReference,
      session,
    });

    const preparation = await SubscriptionService.preparePlanChangePurchase(
      {
        subscriptionId,
        employerProfileId,
        employerContext,
        targetPlanId: planId,
        requestedByUserId: initiatedByUserId,
        retainedPublicationIds,
        paymentReference,
        currentTime,
      },
      {
        session,
      }
    );

    const subscription = preparation.subscription;

    const targetPlanSnapshot = this.clonePlanSnapshot(
      preparation.targetPlanSnapshot ||
        preparation.targetPlan?.toObject?.() ||
        preparation.targetPlan ||
        subscription.pendingPlanChange?.targetPlanSnapshot
    );

    const targetPlanId =
      preparation.targetPlanId ||
      preparation.targetPlan?._id ||
      subscription.pendingPlanChange?.targetPlan ||
      planId;

    const employerCountryCode = this.normalizeCountryCode(employerProfile.countryCode);

    const employerCurrency = this.normalizeCurrency(employerProfile.currency);

    const planCountryCode = this.normalizeCountryCode(targetPlanSnapshot.countryCode);

    const planCurrency = this.normalizeCurrency(targetPlanSnapshot.currency);

    if (employerCountryCode !== planCountryCode || employerCurrency !== planCurrency) {
      throw this.createError({
        message: "The target subscription plan does not match the employer wallet market.",
        code: "SUBSCRIPTION_PAYMENT_MARKET_MISMATCH",
        statusCode: 409,
        details: {
          employerCountryCode,
          employerCurrency,
          planCountryCode,
          planCurrency,
        },
      });
    }

    return {
      employerProfile,
      subscription,
      planId: targetPlanId,
      planSnapshot: targetPlanSnapshot,
      amount: targetPlanSnapshot.priceMinor,
      countryCode: planCountryCode,
      currency: planCurrency,
      targetPeriod: null,
      planChangeType: preparation.changeType || subscription.pendingPlanChange?.changeType || null,
      events: preparation.events || [],
    };
  }

  static async resolveRenewalPaymentContext({
    employerProfileId,
    subscriptionId,
    currentTime,
    paymentReference,
    session,
  }) {
    await this.serializePaymentPreparation({ subscriptionId, employerProfileId, session });

    const employerProfile = await this.getEmployerProfile(employerProfileId, session);
    const subscription = await SubscriptionService.getSubscription({
      subscriptionId,
      employerProfileId,
      session,
    });

    const targetPeriod = this.resolveRenewalTarget({
      subscription,
      currentTime,
    });

    await this.assertNoOtherPaidFutureRenewal({
      subscriptionId: subscription._id,
      paymentReference,
      session,
    });

    await this.assertNoOtherOpenPaymentForPeriod({
      subscriptionId: subscription._id,
      paymentKind: "renewal",
      billingCycleKey: targetPeriod.billingCycleKey,
      paymentReference,
      session,
    });

    const planSnapshot = this.clonePlanSnapshot(subscription.planSnapshot);

    const employerCountryCode = this.normalizeCountryCode(employerProfile.countryCode);

    const employerCurrency = this.normalizeCurrency(employerProfile.currency);

    const planCountryCode = this.normalizeCountryCode(planSnapshot.countryCode);

    const planCurrency = this.normalizeCurrency(planSnapshot.currency);

    if (employerCountryCode !== planCountryCode || employerCurrency !== planCurrency) {
      throw this.createError({
        message: "The subscription market no longer matches the employer wallet market.",
        code: "SUBSCRIPTION_PAYMENT_MARKET_MISMATCH",
        statusCode: 409,
        details: {
          employerCountryCode,
          employerCurrency,
          planCountryCode,
          planCurrency,
        },
      });
    }

    return {
      employerProfile,
      subscription,
      planId: subscription.plan,
      planSnapshot,
      amount: planSnapshot.priceMinor,
      countryCode: planCountryCode,
      currency: planCurrency,
      targetPeriod,
      events: [],
    };
  }

  static buildPaymentPayload({
    paymentReference,
    context,
    initiatedByUserId,
    paymentKind,
    paymentMethod,
    paymentTransaction = null,
    paymentProvider = null,
    providerReference = null,
    providerStatus = null,
    providerAuthorization = null,
  }) {
    return {
      paymentReference,
      business: context.subscription.business,
      subscription: context.subscription._id,
      plan: context.planId,
      initiatedBy: initiatedByUserId || null,
      paymentKind,
      planSnapshot: context.planSnapshot,
      billingCycleKey: context.targetPeriod?.billingCycleKey || null,
      periodStart: context.targetPeriod?.periodStart || null,
      periodEnd: context.targetPeriod?.periodEnd || null,
      paymentMethod,
      paymentTransaction,
      paymentProvider,
      providerReference,
      providerStatus,
      providerAuthorization,
      paymentStatus: "pending",
      paidAt: null,
      failedAt: null,
      failureReason: null,
      cancelledAt: null,
      refundedAt: null,
      appliedAt: null,
    };
  }

  /* ─────────────────────────────── PERIOD-END SUPPORT ─────────────────────────────── */

  static async finalizePeriodEndAfterFailedRenewal({
    subscriptionId,
    employerProfileId,
    currentTime,
  }) {
    const now = this.normalizeCurrentTime(currentTime);

    try {
      let subscription = await SubscriptionService.getSubscription({
        subscriptionId,
        employerProfileId,
      });

      if (subscription.status === "expired") {
        return {
          changed: false,
          outcome: "expired",
          subscription,
          idempotent: true,
        };
      }

      if (subscription.status === "cancelled") {
        return {
          changed: false,
          outcome: "cancelled",
          subscription,
          idempotent: true,
        };
      }

      if (
        subscription.status !== "active" ||
        !subscription.currentPeriodEnd ||
        now < new Date(subscription.currentPeriodEnd)
      ) {
        return {
          changed: false,
          outcome: null,
          subscription,
          idempotent: false,
        };
      }

      // Another attempt can have paid this renewal while this attempt failed.
      // Apply that durable paid authority before choosing expiry. Reconciliation
      // errors flow to the existing catch rather than silently expiring it.
      if (!subscription.cancelAtPeriodEnd) {
        const duePaidRenewal = await SubscriptionPayment.findOne({
          subscription: subscription._id,
          business: subscription.business,
          paymentKind: "renewal",
          paymentStatus: "paid",
          appliedAt: null,
          periodStart: { $lte: now },
        })
          .select("_id")
          .lean();

        if (duePaidRenewal) {
          await this.applyPaidPayment({ paymentId: duePaidRenewal._id, currentTime: now });
          subscription = await SubscriptionService.getSubscription({
            subscriptionId,
            employerProfileId,
          });

          if (
            subscription.status === "active" &&
            subscription.currentPeriodStart &&
            subscription.currentPeriodEnd &&
            now >= new Date(subscription.currentPeriodStart) &&
            now < new Date(subscription.currentPeriodEnd)
          ) {
            return { changed: false, outcome: null, subscription, idempotent: true };
          }
        }
      }

      if (subscription.cancelAtPeriodEnd) {
        const cancellation = await SubscriptionService.finalizeScheduledCancellation({
          subscriptionId: subscription._id,
          employerProfileId: subscription.business,
          currentTime: now,
        });

        return {
          ...cancellation,
          changed: cancellation.cancelled === true,
          outcome: "cancelled",
        };
      }

      const expiry = await SubscriptionService.expireSubscription({
        subscriptionId: subscription._id,
        employerProfileId: subscription.business,
        currentTime: now,
      });

      return {
        ...expiry,
        changed: expiry.expired === true,
        outcome: "expired",
      };
    } catch (error) {
      return {
        changed: false,
        outcome: null,
        subscription: null,
        error: {
          code: error.code || null,
          message: error.message,
        },
      };
    }
  }

  /* ─────────────────────────────── WALLET PAYMENTS ─────────────────────────────── */

  static async purchaseFromWallet(
    {
      paymentKind,
      employerProfileId,
      employerContext = null,
      planId = null,
      subscriptionId = null,
      retainedPublicationIds = [],
      initiatedByUserId,
      idempotencyKey,
      currentTime = new Date(),
    },
    options = {}
  ) {
    this.assertOwnTransactionBoundary(options);

    this.assertCanManageSubscription(employerContext);

    const normalizedPaymentKind = this.normalizePaymentKind(paymentKind);

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedInitiatedByUserId = this.normalizeObjectId(
      initiatedByUserId,
      "initiated-by user ID"
    );

    const normalizedPlanId = ["initial_purchase", "plan_change"].includes(normalizedPaymentKind)
      ? this.normalizeObjectId(planId, "subscription plan ID")
      : null;

    const normalizedSubscriptionId = ["plan_change", "renewal"].includes(normalizedPaymentKind)
      ? this.normalizeObjectId(subscriptionId, "subscription ID")
      : null;

    if (
      normalizedPaymentKind !== "plan_change" &&
      Array.isArray(retainedPublicationIds) &&
      retainedPublicationIds.length > 0
    ) {
      throw this.createError({
        message: "retainedPublicationIds may only be supplied for a subscription plan change.",
        code: "SUBSCRIPTION_PAYMENT_RETAINED_PUBLICATIONS_NOT_ALLOWED",
      });
    }

    const paidAt = this.normalizeCurrentTime(currentTime);

    const paymentReference = this.buildPaymentReference({
      idempotencyKey,
      paymentKind: normalizedPaymentKind,
    });

    let financialResult;

    try {
      financialResult = await this.runWithOptionalTransaction(options, async (session) => {
        const existingPayment = await this.getPaymentByReference(paymentReference, session);

        if (existingPayment) {
          this.assertExistingPaymentMatches({
            payment: existingPayment,
            employerProfileId: normalizedEmployerProfileId,
            paymentKind: normalizedPaymentKind,
            paymentMethod: "wallet",
            planId: normalizedPlanId,
            subscriptionId: normalizedSubscriptionId,
          });

          this.assertExistingPaymentReusable(existingPayment);

          if (existingPayment.paymentStatus === "paid") {
            return {
              payment: existingPayment,
              paymentTransaction: existingPayment.paymentTransaction,
              paid: true,
              idempotent: true,
              events: [],
            };
          }

          throw this.createError({
            message: "The existing wallet subscription payment is unexpectedly still pending.",
            code: "SUBSCRIPTION_WALLET_PAYMENT_PENDING_INTEGRITY_STATE",
            statusCode: 409,
            details: {
              paymentReference,
            },
          });
        }

        const context =
          normalizedPaymentKind === "initial_purchase"
            ? await this.resolveInitialPaymentContext({
                employerProfileId: normalizedEmployerProfileId,
                employerContext,
                planId: normalizedPlanId,
                initiatedByUserId: normalizedInitiatedByUserId,
                currentTime: paidAt,
                paymentReference,
                session,
              })
            : normalizedPaymentKind === "plan_change"
              ? await this.resolvePlanChangePaymentContext({
                  employerProfileId: normalizedEmployerProfileId,
                  employerContext,
                  subscriptionId: normalizedSubscriptionId,
                  planId: normalizedPlanId,
                  initiatedByUserId: normalizedInitiatedByUserId,
                  retainedPublicationIds,
                  currentTime: paidAt,
                  paymentReference,
                  session,
                })
              : await this.resolveRenewalPaymentContext({
                  employerProfileId: normalizedEmployerProfileId,
                  subscriptionId: normalizedSubscriptionId,
                  currentTime: paidAt,
                  paymentReference,
                  session,
                });

        const payment = new SubscriptionPayment(
          this.buildPaymentPayload({
            paymentReference,
            context,
            initiatedByUserId: normalizedInitiatedByUserId,
            paymentKind: normalizedPaymentKind,
            paymentMethod: "wallet",
          })
        );

        await payment.save(this.saveOptions(session));

        const employerWallet = await WalletService.createEmployerWalletIfMissing(
          context.employerProfile,
          { session }
        );
        const platformWallet = await WalletService.createPlatformWallet(
          { countryCode: context.countryCode, currency: context.currency },
          { session }
        );

        if (Number(employerWallet.availableBalance || 0) < Number(context.amount)) {
          throw this.createError({
            message:
              "The employer wallet does not have enough available balance for this subscription payment.",
            code: "SUBSCRIPTION_WALLET_BALANCE_INSUFFICIENT",
            statusCode: 409,
            details: {
              requiredAmount: context.amount,
              availableBalance: Number(employerWallet.availableBalance || 0),
              currency: context.currency,
            },
          });
        }

        const idempotencyKeys = this.buildWalletIdempotencyKeys(paymentReference);

        const transferResult = await WalletService.transferBetweenWallets(
          {
            fromWalletId: employerWallet._id,
            toWalletId: platformWallet._id,
            amount: context.amount,
            type: SUBSCRIPTION_PAYMENT_TYPE,
            purpose: SUBSCRIPTION_PAYMENT_PURPOSE,
            paymentRail: "wallet_balance",
            debitIdempotencyKey: idempotencyKeys.debitIdempotencyKey,
            creditIdempotencyKey: idempotencyKeys.creditIdempotencyKey,
            initiatedBy: {
              role: "employer",
              userId: normalizedInitiatedByUserId,
            },
            description: `Subscription ${normalizedPaymentKind} ${paymentReference}.`,
            metadata: {
              employerProfileId: String(normalizedEmployerProfileId),
              subscriptionPaymentId: String(payment._id),
              subscriptionId: String(context.subscription._id),
              paymentReference,
              paymentKind: normalizedPaymentKind,
              paymentMethod: "wallet",
              subscriptionPlanId: String(context.planId),
              planCode: context.planSnapshot.code,
              planVersion: context.planSnapshot.version,
              planChangeType: context.planChangeType || null,
              billingCycleKey: context.targetPeriod?.billingCycleKey || null,
              periodStart: context.targetPeriod?.periodStart || null,
              periodEnd: context.targetPeriod?.periodEnd || null,
              paidAt,
            },
          },
          {
            session,
          }
        );

        payment.paymentTransaction = transferResult.credit.transaction._id;
        payment.paymentStatus = "paid";
        payment.paidAt = paidAt;

        await payment.save(this.saveOptions(session));

        return {
          payment,
          paymentTransaction: transferResult.credit.transaction,
          employerWallet: transferResult.debit.wallet,
          platformWallet: transferResult.credit.wallet,
          paid: true,
          idempotent: transferResult.idempotent === true,
          events: context.events || [],
        };
      });
    } catch (error) {
      if (
        normalizedPaymentKind === "renewal" &&
        error.code === "SUBSCRIPTION_WALLET_BALANCE_INSUFFICIENT"
      ) {
        await this.finalizePeriodEndAfterFailedRenewal({
          subscriptionId: normalizedSubscriptionId,
          employerProfileId: normalizedEmployerProfileId,
          currentTime: paidAt,
        });
      }

      throw error;
    }

    const applicationResult = await this.attemptApplicationAfterPayment({
      paymentId: financialResult.payment._id,
      currentTime: paidAt,
    });

    return {
      ...financialResult,
      application: applicationResult.application,
      applicationError: applicationResult.applicationError,
      applied: applicationResult.application?.applied === true,
    };
  }

  static async purchaseInitialFromWallet(args, options = {}) {
    return this.purchaseFromWallet(
      {
        ...args,
        paymentKind: "initial_purchase",
      },
      options
    );
  }

  static async purchasePlanChangeFromWallet(args, options = {}) {
    return this.purchaseFromWallet(
      {
        ...args,
        paymentKind: "plan_change",
      },
      options
    );
  }

  static async purchaseRenewalFromWallet(args, options = {}) {
    return this.purchaseFromWallet(
      {
        ...args,
        paymentKind: "renewal",
      },
      options
    );
  }

  /* ─────────────────────────────── PAYSTACK HELPERS ─────────────────────────────── */

  static hasReusableCheckout(transaction) {
    return Boolean(
      transaction &&
      PAYSTACK_OPEN_TRANSACTION_STATUSES.includes(transaction.status) &&
      transaction.metadata?.authorizationUrl &&
      transaction.paystackReference
    );
  }

  static isDefinitiveProviderFailure(error) {
    // Preserve the transport adapter's explicit classification. HTTP status
    // alone cannot establish failure after an uncertain provider request.
    // Unclassified/validation errors stay pending for reconciliation, including
    // malformed provider responses that use the shared input normalizers.
    return error?.code === "PAYSTACK_PROVIDER_REJECTED_REQUEST";
  }

  static buildCheckoutResponse({ payment, transaction, checkout = null, reused = false }) {
    const authorizationUrl =
      checkout?.authorizationUrl || transaction?.metadata?.authorizationUrl || null;

    if (!authorizationUrl) {
      throw this.createError({
        message:
          "The existing Paystack Checkout attempt does not have a reusable authorization URL.",
        code: "SUBSCRIPTION_PAYMENT_CHECKOUT_URL_UNAVAILABLE",
        statusCode: 409,
        details: {
          paymentReference: payment.paymentReference,
          providerReference: payment.providerReference,
        },
      });
    }

    return {
      payment,
      reused,
      checkout: {
        authorizationUrl,
        reference: payment.providerReference,
        mode: checkout?.mode || transaction?.metadata?.paystackMode || null,
      },
    };
  }

  static normalizeProviderMetadata(value) {
    if (!value) {
      return {};
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (error) {
        return {};
      }
    }

    return {};
  }

  static cleanOptionalString(value) {
    const cleaned = String(value || "").trim();

    return cleaned || null;
  }

  static buildProviderAuthorizationSnapshot(verifiedPayment) {
    const authorization = verifiedPayment?.authorization;

    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
      return null;
    }

    const authorizationCode = this.cleanOptionalString(
      authorization.authorization_code || authorization.authorizationCode
    );

    const email = this.cleanOptionalString(verifiedPayment.customerEmail || authorization.email);

    const reusable = Boolean(authorization.reusable === true && authorizationCode && email);

    const snapshot = {
      authorizationCode,
      email: email ? email.toLowerCase() : null,
      signature: this.cleanOptionalString(authorization.signature),
      reusable,
      channel: this.cleanOptionalString(authorization.channel || verifiedPayment.channel),
      cardType: this.cleanOptionalString(authorization.card_type || authorization.cardType),
      bank: this.cleanOptionalString(authorization.bank),
      last4: this.cleanOptionalString(authorization.last4),
      expMonth: this.cleanOptionalString(authorization.exp_month || authorization.expMonth),
      expYear: this.cleanOptionalString(authorization.exp_year || authorization.expYear),
      countryCode: this.cleanOptionalString(
        authorization.country_code || authorization.countryCode
      ),
      accountName: this.cleanOptionalString(
        authorization.account_name || authorization.accountName
      ),
    };

    const hasAnyValue = Object.values(snapshot).some((value) => value !== null && value !== false);

    return hasAnyValue ? snapshot : null;
  }

  static resolveVerifiedPaymentTime(verifiedPayment) {
    const rawPaidAt = verifiedPayment?.paidAt || verifiedPayment?.paid_at || null;

    if (!rawPaidAt) {
      throw this.createError({
        message: "The verified Paystack payment does not contain a confirmed payment time.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_PAID_AT_REQUIRED",
        statusCode: 409,
      });
    }

    const paidAt = new Date(rawPaidAt);

    if (Number.isNaN(paidAt.getTime())) {
      throw this.createError({
        message: "The verified Paystack payment time is invalid.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_PAYSTACK_PAID_AT",
        statusCode: 409,
      });
    }

    return paidAt;
  }

  static getVerifiedProviderAmounts(verifiedPayment) {
    const amount = Number(verifiedPayment?.amount);

    const providerFee = Number.isSafeInteger(Number(verifiedPayment?.fees))
      ? Number(verifiedPayment.fees)
      : 0;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw this.createError({
        message: "The verified Paystack payment amount is invalid.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_PAYSTACK_AMOUNT",
        statusCode: 409,
      });
    }

    if (!Number.isSafeInteger(providerFee) || providerFee < 0 || providerFee > amount) {
      throw this.createError({
        message: "The verified Paystack provider fee is invalid.",
        code: "INVALID_SUBSCRIPTION_PAYMENT_PAYSTACK_PROVIDER_FEE",
        statusCode: 409,
      });
    }

    return {
      amount,
      providerFee,
      netAmount: amount - providerFee,
    };
  }

  static validateVerifiedPaystackPayment({ verifiedPayment, payment, transaction }) {
    const verifiedStatus = String(verifiedPayment?.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      throw this.createError({
        message: "The Paystack subscription payment has not completed successfully.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_NOT_SUCCESSFUL",
        statusCode: 409,
        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    const verifiedAmount = Number(verifiedPayment.amount);

    if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== Number(transaction.amount)) {
      throw this.createError({
        message: "The verified Paystack amount does not match the subscription price.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_AMOUNT_MISMATCH",
        statusCode: 409,
        details: {
          expectedAmount: transaction.amount,
          verifiedAmount,
        },
      });
    }

    const verifiedCurrency = String(verifiedPayment.currency || "")
      .trim()
      .toUpperCase();

    const expectedCurrency = String(transaction.currency || "")
      .trim()
      .toUpperCase();

    if (!verifiedCurrency || verifiedCurrency !== expectedCurrency) {
      throw this.createError({
        message: "The verified Paystack currency does not match the subscription currency.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_CURRENCY_MISMATCH",
        statusCode: 409,
        details: {
          expectedCurrency,
          verifiedCurrency: verifiedCurrency || null,
        },
      });
    }

    const verifiedReference = String(verifiedPayment.reference || "").trim();

    if (
      verifiedReference !== transaction.paystackReference ||
      verifiedReference !== payment.providerReference
    ) {
      throw this.createError({
        message: "The verified Paystack reference does not match the subscription payment.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_REFERENCE_MISMATCH",
        statusCode: 409,
      });
    }

    const expectedEmail = String(transaction.metadata?.customerEmail || "")
      .trim()
      .toLowerCase();

    const verifiedEmail = String(verifiedPayment.customerEmail || "")
      .trim()
      .toLowerCase();

    if (expectedEmail && verifiedEmail && expectedEmail !== verifiedEmail) {
      throw this.createError({
        message: "The verified Paystack customer does not match the expected employer email.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_CUSTOMER_MISMATCH",
        statusCode: 409,
      });
    }

    const metadata = this.normalizeProviderMetadata(verifiedPayment.metadata);

    if (
      metadata.paymentReference &&
      String(metadata.paymentReference).toUpperCase() !== payment.paymentReference
    ) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the subscription payment reference.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_PAYMENT_REFERENCE_MISMATCH",
        statusCode: 409,
      });
    }

    if (
      metadata.employerProfileId &&
      String(metadata.employerProfileId) !== String(payment.business)
    ) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the employer.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_EMPLOYER_MISMATCH",
        statusCode: 409,
      });
    }

    if (
      metadata.subscriptionId &&
      String(metadata.subscriptionId) !== String(payment.subscription)
    ) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the subscription.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_SUBSCRIPTION_MISMATCH",
        statusCode: 409,
      });
    }

    if (
      metadata.subscriptionPlanId &&
      String(metadata.subscriptionPlanId) !== String(payment.plan)
    ) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the subscription plan.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_PLAN_MISMATCH",
        statusCode: 409,
      });
    }

    return true;
  }

  /* ─────────────────────────────── PAYSTACK FAILURE ─────────────────────────────── */

  static async failPaystackAttempt({
    paymentId,
    transactionId,
    failureReason,
    failedAt = new Date(),
    metadata = {},
  }) {
    const normalizedPaymentId = this.normalizeObjectId(paymentId, "subscription payment ID");

    const normalizedTransactionId = this.normalizeObjectId(transactionId, "payment transaction ID");

    const normalizedFailedAt = this.normalizeCurrentTime(failedAt);

    const normalizedFailureReason = this.truncateFailureReason(failureReason);

    const result = await this.runWithOptionalTransaction({}, async (session) => {
      const payment = await this.getPayment(normalizedPaymentId, session);

      if (payment.paymentStatus === "paid") {
        return {
          payment,
          changed: false,
          idempotent: true,
        };
      }

      if (payment.paymentStatus === "failed") {
        return {
          payment,
          changed: false,
          idempotent: true,
        };
      }

      if (payment.paymentStatus !== "pending") {
        throw this.createError({
          message: "This Paystack subscription payment can no longer be marked failed.",
          code: "SUBSCRIPTION_PAYMENT_FAILURE_TRANSITION_NOT_ALLOWED",
          statusCode: 409,
          details: {
            paymentStatus: payment.paymentStatus,
          },
        });
      }

      await WalletService.markPendingExternalCreditFailed(
        {
          transactionId: normalizedTransactionId,
          failureReason: normalizedFailureReason,
          metadata: {
            ...metadata,
            subscriptionPaymentFailedAt: normalizedFailedAt,
          },
        },
        {
          session,
        }
      );

      payment.paymentStatus = "failed";
      payment.providerStatus = "failed";
      payment.failedAt = normalizedFailedAt;
      payment.failureReason = normalizedFailureReason;

      await payment.save(this.saveOptions(session));

      if (payment.paymentKind === "plan_change") {
        await SubscriptionService.cancelPendingPlanChangePurchase(
          {
            subscriptionId: payment.subscription,
            employerProfileId: payment.business,
            targetPlanId: payment.plan,
            paymentReference: payment.paymentReference,
            currentTime: normalizedFailedAt,
          },
          {
            session,
          }
        );
      }

      return {
        payment,
        changed: true,
        idempotent: false,
      };
    });

    let periodEndResult = null;

    if (result.payment.paymentKind === "renewal" && result.payment.paymentStatus === "failed") {
      periodEndResult = await this.finalizePeriodEndAfterFailedRenewal({
        subscriptionId: result.payment.subscription,
        employerProfileId: result.payment.business,
        currentTime: normalizedFailedAt,
      });
    }

    return {
      ...result,
      periodEndResult,
    };
  }

  /* ─────────────────────────────── PAYSTACK CHECKOUT PREPARATION ─────────────────────────────── */

  static async preparePaystackCheckout({
    paymentKind,
    employerProfileId,
    employerContext,
    planId,
    subscriptionId,
    retainedPublicationIds = [],
    initiatedByUserId,
    paymentReference,
    callbackUrl,
    currentTime,
    session,
  }) {
    const existingPayment = await this.getPaymentByReference(paymentReference, session);

    if (existingPayment) {
      this.assertExistingPaymentMatches({
        payment: existingPayment,
        employerProfileId,
        paymentKind,
        paymentMethod: "paystack_checkout",
        planId: ["initial_purchase", "plan_change"].includes(paymentKind) ? planId : null,
        subscriptionId: ["plan_change", "renewal"].includes(paymentKind) ? subscriptionId : null,
      });

      this.assertExistingPaymentReusable(existingPayment);

      if (
        paymentKind === "renewal" &&
        existingPayment.paymentStatus === "pending" &&
        existingPayment.periodStart &&
        currentTime >= new Date(existingPayment.periodStart)
      ) {
        throw this.createError({
          message:
            "This renewal Checkout is no longer valid because the previous subscription period has ended.",
          code: "SUBSCRIPTION_PAYMENT_RENEWAL_CHECKOUT_PERIOD_ENDED",
          statusCode: 409,
          details: {
            paymentId: String(existingPayment._id),
            paymentReference: existingPayment.paymentReference,
            currentPeriodEnd: existingPayment.periodStart,
          },
        });
      }

      const transaction = await this.applySession(
        Transaction.findById(existingPayment.paymentTransaction),
        session
      );

      if (!transaction) {
        throw this.createError({
          message: "The subscription payment is missing its platform-wallet payment Transaction.",
          code: "SUBSCRIPTION_PAYMENT_TRANSACTION_NOT_FOUND",
          statusCode: 500,
        });
      }

      if (existingPayment.paymentStatus === "paid") {
        return {
          alreadyPaid: true,
          reused: true,
          payment: existingPayment,
          transaction,
        };
      }

      if (this.hasReusableCheckout(transaction)) {
        return {
          alreadyPaid: false,
          reused: true,
          payment: existingPayment,
          transaction,
          customerEmail: transaction.metadata?.customerEmail || null,
          amount: transaction.amount,
          currency: transaction.currency,
        };
      }

      if (!PAYSTACK_OPEN_TRANSACTION_STATUSES.includes(transaction.status)) {
        throw this.createError({
          message: "The existing Paystack subscription payment attempt is no longer open.",
          code: "SUBSCRIPTION_PAYMENT_PAYSTACK_ATTEMPT_NOT_OPEN",
          statusCode: 409,
          details: {
            transactionStatus: transaction.status,
            paymentReference,
          },
        });
      }

      throw this.createError({
        message:
          "Paystack Checkout is already being initialized or processed for this subscription payment. Please try again shortly.",
        code: "SUBSCRIPTION_PAYMENT_CHECKOUT_INITIALIZATION_IN_PROGRESS",
        statusCode: 409,
        details: {
          transactionId: String(transaction._id),
          status: transaction.status,
          paymentReference,
        },
      });
    }

    const context =
      paymentKind === "initial_purchase"
        ? await this.resolveInitialPaymentContext({
            employerProfileId,
            employerContext,
            planId,
            initiatedByUserId,
            currentTime,
            paymentReference,
            session,
          })
        : paymentKind === "plan_change"
          ? await this.resolvePlanChangePaymentContext({
              employerProfileId,
              employerContext,
              subscriptionId,
              planId,
              initiatedByUserId,
              retainedPublicationIds,
              currentTime,
              paymentReference,
              session,
            })
          : await this.resolveRenewalPaymentContext({
              employerProfileId,
              subscriptionId,
              currentTime,
              paymentReference,
              session,
            });

    const customerEmail = String(context.employerProfile.businessEmail || "")
      .trim()
      .toLowerCase();

    if (!customerEmail) {
      throw this.createError({
        message: "The employer business email is required for Paystack Checkout.",
        code: "SUBSCRIPTION_PAYMENT_EMPLOYER_EMAIL_REQUIRED",
        statusCode: 409,
      });
    }

    const platformWallet = await WalletService.createPlatformWallet(
      {
        countryCode: context.countryCode,
        currency: context.currency,
      },
      {
        session,
      }
    );

    const providerReference = paymentReference;

    const pendingCredit = await WalletService.createPendingExternalCredit(
      {
        walletId: platformWallet._id,
        amount: context.amount,
        type: SUBSCRIPTION_PAYMENT_TYPE,
        purpose: SUBSCRIPTION_PAYMENT_PURPOSE,
        paymentRail: "paystack_checkout",
        provider: "paystack",
        reference: providerReference,
        idempotencyKey: this.buildPaystackCreditIdempotencyKey(paymentReference),
        paystackReference: providerReference,
        initiatedBy: {
          role: "employer",
          userId: initiatedByUserId,
        },
        description: `Paystack subscription ${paymentKind} ${paymentReference}.`,
        metadata: {
          employerProfileId: String(employerProfileId),
          subscriptionId: String(context.subscription._id),
          paymentReference,
          paymentKind,
          paymentMethod: "paystack_checkout",
          subscriptionPlanId: String(context.planId),
          planCode: context.planSnapshot.code,
          planVersion: context.planSnapshot.version,
          planChangeType: context.planChangeType || null,
          billingCycleKey: context.targetPeriod?.billingCycleKey || null,
          periodStart: context.targetPeriod?.periodStart || null,
          periodEnd: context.targetPeriod?.periodEnd || null,
          customerEmail,
          callbackUrl,
          checkoutPreparedAt: currentTime,
        },
      },
      {
        session,
      }
    );

    const payment = new SubscriptionPayment(
      this.buildPaymentPayload({
        paymentReference,
        context,
        initiatedByUserId,
        paymentKind,
        paymentMethod: "paystack_checkout",
        paymentTransaction: pendingCredit.transaction._id,
        paymentProvider: "paystack",
        providerReference,
        providerStatus: "pending",
      })
    );

    await payment.save(this.saveOptions(session));

    pendingCredit.transaction.metadata = {
      ...(pendingCredit.transaction.metadata || {}),
      subscriptionPaymentId: String(payment._id),
    };

    pendingCredit.transaction.markModified("metadata");

    await pendingCredit.transaction.save(this.saveOptions(session));

    return {
      alreadyPaid: false,
      reused: false,
      payment,
      transaction: pendingCredit.transaction,
      customerEmail,
      amount: context.amount,
      currency: context.currency,
      events: context.events || [],
    };
  }

  /* ─────────────────────────────── PAYSTACK CHECKOUT ─────────────────────────────── */

  static async initializePaystackCheckout(
    {
      paymentKind,
      employerProfileId,
      employerContext = null,
      planId = null,
      subscriptionId = null,
      retainedPublicationIds = [],
      initiatedByUserId,
      idempotencyKey,
      callbackUrl = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    this.assertOwnTransactionBoundary(options);

    this.assertCanManageSubscription(employerContext);

    PaystackService.assertConfigured();

    const normalizedPaymentKind = this.normalizePaymentKind(paymentKind);

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedInitiatedByUserId = this.normalizeObjectId(
      initiatedByUserId,
      "initiated-by user ID"
    );

    const normalizedPlanId = ["initial_purchase", "plan_change"].includes(normalizedPaymentKind)
      ? this.normalizeObjectId(planId, "subscription plan ID")
      : null;

    const normalizedSubscriptionId = ["plan_change", "renewal"].includes(normalizedPaymentKind)
      ? this.normalizeObjectId(subscriptionId, "subscription ID")
      : null;

    if (
      normalizedPaymentKind !== "plan_change" &&
      Array.isArray(retainedPublicationIds) &&
      retainedPublicationIds.length > 0
    ) {
      throw this.createError({
        message: "retainedPublicationIds may only be supplied for a subscription plan change.",
        code: "SUBSCRIPTION_PAYMENT_RETAINED_PUBLICATIONS_NOT_ALLOWED",
      });
    }

    const initializedAt = this.normalizeCurrentTime(currentTime);

    const paymentReference = this.buildPaymentReference({
      idempotencyKey,
      paymentKind: normalizedPaymentKind,
    });

    const preparation = await this.runWithOptionalTransaction(options, async (session) => {
      return this.preparePaystackCheckout({
        paymentKind: normalizedPaymentKind,
        employerProfileId: normalizedEmployerProfileId,
        employerContext,
        planId: normalizedPlanId,
        subscriptionId: normalizedSubscriptionId,
        retainedPublicationIds,
        initiatedByUserId: normalizedInitiatedByUserId,
        paymentReference,
        callbackUrl,
        currentTime: initializedAt,
        session,
      });
    });

    if (preparation.alreadyPaid) {
      const applicationResult = await this.attemptApplicationAfterPayment({
        paymentId: preparation.payment._id,
        currentTime: initializedAt,
      });

      return {
        payment: preparation.payment,
        alreadyPaid: true,
        reused: true,
        checkout: null,
        application: applicationResult.application,
        applicationError: applicationResult.applicationError,
      };
    }

    if (preparation.reused) {
      return {
        ...this.buildCheckoutResponse({
          payment: preparation.payment,
          transaction: preparation.transaction,
          reused: true,
        }),
        alreadyPaid: false,
      };
    }

    try {
      const checkout = await PaystackService.initializeTransaction({
        email: preparation.customerEmail,
        amount: preparation.amount,
        reference: preparation.transaction.paystackReference,
        currency: preparation.currency,
        callbackUrl,
        metadata: {
          purpose: SUBSCRIPTION_PAYMENT_PURPOSE,
          paymentRail: "paystack_checkout",
          paymentReference: preparation.payment.paymentReference,
          subscriptionPaymentId: String(preparation.payment._id),
          subscriptionId: String(preparation.payment.subscription),
          employerProfileId: String(preparation.payment.business),
          subscriptionPlanId: String(preparation.payment.plan),
          paymentKind: preparation.payment.paymentKind,
          paymentMethod: preparation.payment.paymentMethod,
          billingCycleKey: preparation.payment.billingCycleKey || null,
          planCode: preparation.payment.planSnapshot.code,
          planVersion: preparation.payment.planSnapshot.version,
        },
      });

      await Transaction.updateOne(
        {
          _id: preparation.transaction._id,
          status: "pending",
        },
        {
          $set: {
            paystackStatus: "pending",
            "metadata.authorizationUrl": checkout.authorizationUrl,
            "metadata.accessCode": checkout.accessCode,
            "metadata.paystackMode": checkout.mode,
            "metadata.checkoutInitializedAt": initializedAt,
          },
        }
      );

      preparation.transaction.metadata = {
        ...(preparation.transaction.metadata || {}),
        authorizationUrl: checkout.authorizationUrl,
        accessCode: checkout.accessCode,
        paystackMode: checkout.mode,
        checkoutInitializedAt: initializedAt,
      };

      return {
        ...this.buildCheckoutResponse({
          payment: preparation.payment,
          transaction: preparation.transaction,
          checkout,
          reused: false,
        }),
        alreadyPaid: false,
        events: preparation.events || [],
      };
    } catch (error) {
      const definitiveFailure = this.isDefinitiveProviderFailure(error);

      if (definitiveFailure) {
        await this.failPaystackAttempt({
          paymentId: preparation.payment._id,
          transactionId: preparation.transaction._id,
          failureReason: error.message,
          failedAt: initializedAt,
          metadata: {
            checkoutInitializationFailedAt: initializedAt,
            checkoutInitializationErrorCode: error.code || null,
          },
        });
      } else {
        await Transaction.updateOne(
          {
            _id: preparation.transaction._id,
            status: "pending",
          },
          {
            $set: {
              "metadata.checkoutInitializationUncertainAt": initializedAt,
              "metadata.checkoutInitializationError": String(
                error.message || "Paystack Checkout initialization status is uncertain."
              ).slice(0, 300),
              "metadata.checkoutInitializationErrorCode": error.code || null,
            },
          }
        );
      }

      throw error;
    }
  }

  static async initializeInitialPaystackCheckout(args, options = {}) {
    return this.initializePaystackCheckout(
      {
        ...args,
        paymentKind: "initial_purchase",
      },
      options
    );
  }

  static async initializePlanChangePaystackCheckout(args, options = {}) {
    return this.initializePaystackCheckout(
      {
        ...args,
        paymentKind: "plan_change",
      },
      options
    );
  }

  static async initializeRenewalPaystackCheckout(args, options = {}) {
    return this.initializePaystackCheckout(
      {
        ...args,
        paymentKind: "renewal",
      },
      options
    );
  }

  /* ─────────────────────────────── PAYSTACK VERIFICATION ─────────────────────────────── */

  static async finalizePaystackPayment({
    reference,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    const normalizedReference = String(reference || "").trim();

    const finalizedAt = this.normalizeCurrentTime(currentTime);

    if (!normalizedReference) {
      throw this.createError({
        message: "A Paystack payment reference is required.",
        code: "SUBSCRIPTION_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
      });
    }

    const existingPayment = await this.getPaymentByProviderReference(normalizedReference);

    if (existingPayment.paymentStatus === "paid") {
      const applicationResult = await this.attemptApplicationAfterPayment({
        paymentId: existingPayment._id,
        currentTime: finalizedAt,
      });

      return {
        payment: existingPayment,
        paid: true,
        idempotent: true,
        paymentTransaction: existingPayment.paymentTransaction,
        application: applicationResult.application,
        applicationError: applicationResult.applicationError,
        applied: applicationResult.application?.applied === true,
      };
    }

    this.assertExistingPaymentReusable(existingPayment);

    const verifiedPayment = await PaystackService.verifyTransaction(normalizedReference);

    const verifiedStatus = String(verifiedPayment?.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      if (PAYSTACK_DEFINITIVE_FAILURE_STATUSES.includes(verifiedStatus)) {
        const failedResult = await this.failPaystackAttempt({
          paymentId: existingPayment._id,
          transactionId: existingPayment.paymentTransaction,
          failureReason: `Paystack payment status: ${verifiedStatus}.`,
          failedAt: finalizedAt,
          metadata: {
            verifiedAt: finalizedAt,
            verifiedPaystackStatus: verifiedStatus,
          },
        });

        throw this.createError({
          message: "The Paystack subscription payment failed.",
          code: "SUBSCRIPTION_PAYMENT_PAYSTACK_FAILED",
          statusCode: 409,
          details: {
            paystackStatus: verifiedStatus,
            paymentId: String(failedResult.payment._id),
          },
        });
      }

      if (verifiedStatus === "reversed") {
        throw this.createError({
          message:
            "The Paystack subscription payment is reversed and requires payment reconciliation before subscription benefits can be applied.",
          code: "SUBSCRIPTION_PAYMENT_PAYSTACK_REVERSED_RECONCILIATION_REQUIRED",
          statusCode: 409,
        });
      }

      throw this.createError({
        message: "The Paystack subscription payment has not completed successfully.",
        code: "SUBSCRIPTION_PAYMENT_PAYSTACK_NOT_SUCCESSFUL",
        statusCode: 409,
        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    const transaction = await Transaction.findById(existingPayment.paymentTransaction);

    if (!transaction) {
      throw this.createError({
        message: "The subscription payment is missing its platform-wallet payment Transaction.",
        code: "SUBSCRIPTION_PAYMENT_TRANSACTION_NOT_FOUND",
        statusCode: 500,
      });
    }

    this.validateVerifiedPaystackPayment({
      verifiedPayment,
      payment: existingPayment,
      transaction,
    });

    const paidAt = this.resolveVerifiedPaymentTime(verifiedPayment);

    const providerAmounts = this.getVerifiedProviderAmounts(verifiedPayment);

    const providerAuthorization = this.buildProviderAuthorizationSnapshot(verifiedPayment);

    const financialResult = await this.runWithOptionalTransaction({}, async (session) => {
      const payment = await this.getPaymentByProviderReference(normalizedReference, session);

      if (payment.paymentStatus === "paid") {
        const completedTransaction = await this.applySession(
          Transaction.findById(payment.paymentTransaction),
          session
        );

        return {
          payment,
          paymentTransaction: completedTransaction || payment.paymentTransaction,
          platformWallet: null,
          paid: true,
          idempotent: true,
        };
      }

      this.assertExistingPaymentReusable(payment);

      const currentTransaction = await this.applySession(
        Transaction.findById(payment.paymentTransaction),
        session
      );

      if (!currentTransaction) {
        throw this.createError({
          message: "The subscription payment is missing its platform-wallet payment Transaction.",
          code: "SUBSCRIPTION_PAYMENT_TRANSACTION_NOT_FOUND",
          statusCode: 500,
        });
      }

      this.validateVerifiedPaystackPayment({
        verifiedPayment,
        payment,
        transaction: currentTransaction,
      });

      // Share a written Subscription with expiry and payment preparation.
      // A stale transaction must retry its full reads before recording settlement.
      // Terminal status does not discard verified money; lifecycle application
      // remains separate and may require reconciliation after cancellation.
      await this.serializePaymentPreparation({
        subscriptionId: payment.subscription,
        employerProfileId: payment.business,
        session,
      });

      const completedCredit = await WalletService.completePendingExternalCredit(
        {
          transactionId: payment.paymentTransaction,
          paystackReference: normalizedReference,
          providerEventId,
          providerFee: providerAmounts.providerFee,
          netAmount: providerAmounts.netAmount,
          metadata: {
            verifiedAt: finalizedAt,
            verifiedPaymentTime: paidAt,
            verifiedPaystackStatus: "success",
            paystackChannel: verifiedPayment.channel || null,
            paystackDomain: verifiedPayment.domain || null,
          },
        },
        {
          session,
        }
      );

      payment.paymentStatus = "paid";
      payment.providerStatus = "success";
      payment.paidAt = paidAt;
      payment.failedAt = null;
      payment.failureReason = null;

      if (providerAuthorization) {
        payment.providerAuthorization = providerAuthorization;
      }

      await payment.save(this.saveOptions(session));

      return {
        payment,
        paymentTransaction: completedCredit.transaction,
        platformWallet: completedCredit.wallet,
        paid: true,
        idempotent: completedCredit.idempotent === true,
      };
    });

    const applicationResult = await this.attemptApplicationAfterPayment({
      paymentId: financialResult.payment._id,
      currentTime: finalizedAt,
    });

    return {
      ...financialResult,
      application: applicationResult.application,
      applicationError: applicationResult.applicationError,
      applied: applicationResult.application?.applied === true,
    };
  }

  /* ─────────────────────────────── REUSABLE PAYSTACK AUTHORIZATION ─────────────────────────────── */

  static async getReusableAuthorizationPayment(subscriptionId, session = null) {
    const normalizedSubscriptionId = this.normalizeObjectId(subscriptionId, "subscription ID");

    return this.applySession(
      SubscriptionPayment.findOne({
        subscription: normalizedSubscriptionId,
        paymentStatus: "paid",
        "providerAuthorization.reusable": true,
        "providerAuthorization.authorizationCode": {
          $type: "string",
        },
        "providerAuthorization.email": {
          $type: "string",
        },
      }).sort({
        appliedAt: -1,
        paidAt: -1,
        createdAt: -1,
      }),
      session
    );
  }

  static async prepareAuthorizationRenewal({
    employerProfileId,
    subscriptionId,
    currentTime,
    session,
  }) {
    await this.serializePaymentPreparation({ subscriptionId, employerProfileId, session });

    const subscription = await SubscriptionService.getSubscription({
      subscriptionId,
      employerProfileId,
      session,
    });

    const targetPeriod = this.resolveRenewalTarget({
      subscription,
      currentTime,
    });

    const idempotencyKey = this.buildAutomaticRenewalIdempotencyKey({
      subscriptionId: subscription._id,
      billingCycleKey: targetPeriod.billingCycleKey,
    });

    const paymentReference = this.buildPaymentReference({
      idempotencyKey,
      paymentKind: "renewal",
    });

    const existingPayment = await this.getPaymentByReference(paymentReference, session);

    if (existingPayment) {
      this.assertExistingPaymentMatches({
        payment: existingPayment,
        employerProfileId,
        paymentKind: "renewal",
        paymentMethod: "paystack_authorization",
        subscriptionId,
      });

      this.assertExistingPaymentReusable(existingPayment);

      const transaction = await this.applySession(
        Transaction.findById(existingPayment.paymentTransaction),
        session
      );

      if (!transaction) {
        throw this.createError({
          message: "The authorization renewal is missing its platform-wallet payment Transaction.",
          code: "SUBSCRIPTION_PAYMENT_TRANSACTION_NOT_FOUND",
          statusCode: 500,
        });
      }

      return {
        payment: existingPayment,
        transaction,
        existing: true,
        alreadyPaid: existingPayment.paymentStatus === "paid",
        paymentReference,
      };
    }

    await this.assertNoOtherPaidFutureRenewal({
      subscriptionId: subscription._id,
      paymentReference,
      session,
    });

    await this.assertNoOtherOpenPaymentForPeriod({
      subscriptionId: subscription._id,
      paymentKind: "renewal",
      billingCycleKey: targetPeriod.billingCycleKey,
      paymentReference,
      session,
    });

    const authorizationPayment = await this.getReusableAuthorizationPayment(
      subscription._id,
      session
    );

    if (!authorizationPayment) {
      throw this.createError({
        message: "No reusable Paystack authorization is available for this subscription.",
        code: "SUBSCRIPTION_REUSABLE_PAYSTACK_AUTHORIZATION_NOT_FOUND",
        statusCode: 409,
      });
    }

    const employerProfile = await this.getEmployerProfile(employerProfileId, session);

    const planSnapshot = this.clonePlanSnapshot(subscription.planSnapshot);

    const context = {
      employerProfile,
      subscription,
      planId: subscription.plan,
      planSnapshot,
      amount: planSnapshot.priceMinor,
      countryCode: this.normalizeCountryCode(planSnapshot.countryCode),
      currency: this.normalizeCurrency(planSnapshot.currency),
      targetPeriod,
      events: [],
    };

    const platformWallet = await WalletService.createPlatformWallet(
      {
        countryCode: context.countryCode,
        currency: context.currency,
      },
      {
        session,
      }
    );

    const providerReference = paymentReference;

    const sourceAuthorization = authorizationPayment.providerAuthorization?.toObject
      ? authorizationPayment.providerAuthorization.toObject()
      : authorizationPayment.providerAuthorization;

    const pendingCredit = await WalletService.createPendingExternalCredit(
      {
        walletId: platformWallet._id,
        amount: context.amount,
        type: SUBSCRIPTION_PAYMENT_TYPE,
        purpose: SUBSCRIPTION_PAYMENT_PURPOSE,
        paymentRail: "paystack_checkout",
        provider: "paystack",
        reference: providerReference,
        idempotencyKey: this.buildPaystackCreditIdempotencyKey(paymentReference),
        paystackReference: providerReference,
        initiatedBy: {
          role: "system",
          userId: null,
        },
        description: `Paystack authorization subscription renewal ${paymentReference}.`,
        metadata: {
          employerProfileId: String(employerProfileId),
          subscriptionId: String(subscription._id),
          paymentReference,
          paymentKind: "renewal",
          paymentMethod: "paystack_authorization",
          subscriptionPlanId: String(subscription.plan),
          planCode: planSnapshot.code,
          planVersion: planSnapshot.version,
          billingCycleKey: targetPeriod.billingCycleKey,
          periodStart: targetPeriod.periodStart,
          periodEnd: targetPeriod.periodEnd,
          customerEmail: sourceAuthorization.email,
          authorizationSourcePaymentId: String(authorizationPayment._id),
          authorizationPreparedAt: currentTime,
        },
      },
      {
        session,
      }
    );

    const payment = new SubscriptionPayment(
      this.buildPaymentPayload({
        paymentReference,
        context,
        initiatedByUserId: null,
        paymentKind: "renewal",
        paymentMethod: "paystack_authorization",
        paymentTransaction: pendingCredit.transaction._id,
        paymentProvider: "paystack",
        providerReference,
        providerStatus: "pending",
        providerAuthorization: sourceAuthorization,
      })
    );

    await payment.save(this.saveOptions(session));

    pendingCredit.transaction.metadata = {
      ...(pendingCredit.transaction.metadata || {}),
      subscriptionPaymentId: String(payment._id),
    };

    pendingCredit.transaction.markModified("metadata");

    await pendingCredit.transaction.save(this.saveOptions(session));

    return {
      payment,
      transaction: pendingCredit.transaction,
      existing: false,
      alreadyPaid: false,
      paymentReference,
      authorization: sourceAuthorization,
      amount: context.amount,
      currency: context.currency,
      customerEmail: sourceAuthorization.email,
    };
  }

  static async chargeRenewalWithStoredAuthorization({
    employerProfileId,
    subscriptionId,
    currentTime = new Date(),
  }) {
    PaystackService.assertConfigured();

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedSubscriptionId = this.normalizeObjectId(subscriptionId, "subscription ID");

    const chargedAt = this.normalizeCurrentTime(currentTime);

    const preparation = await this.runWithOptionalTransaction({}, async (session) => {
      return this.prepareAuthorizationRenewal({
        employerProfileId: normalizedEmployerProfileId,
        subscriptionId: normalizedSubscriptionId,
        currentTime: chargedAt,
        session,
      });
    });

    if (preparation.alreadyPaid) {
      const applicationResult = await this.attemptApplicationAfterPayment({
        paymentId: preparation.payment._id,
        currentTime: chargedAt,
      });

      return {
        payment: preparation.payment,
        paid: true,
        pending: false,
        idempotent: true,
        application: applicationResult.application,
        applicationError: applicationResult.applicationError,
      };
    }

    if (preparation.existing) {
      return {
        payment: preparation.payment,
        paymentTransaction: preparation.transaction,
        paid: false,
        pending: true,
        idempotent: true,
        reconciliationRequired: true,
      };
    }

    try {
      const response = await PaystackService.request({
        method: "post",
        path: "/transaction/charge_authorization",
        data: {
          email: preparation.customerEmail,
          amount: String(preparation.amount),
          authorization_code: preparation.authorization.authorizationCode,
          reference: preparation.payment.providerReference,
          currency: preparation.currency,
          metadata: JSON.stringify({
            purpose: SUBSCRIPTION_PAYMENT_PURPOSE,
            paymentRail: "paystack_checkout",
            paymentReference: preparation.payment.paymentReference,
            subscriptionPaymentId: String(preparation.payment._id),
            subscriptionId: String(preparation.payment.subscription),
            employerProfileId: String(preparation.payment.business),
            subscriptionPlanId: String(preparation.payment.plan),
            paymentKind: "renewal",
            paymentMethod: "paystack_authorization",
            billingCycleKey: preparation.payment.billingCycleKey,
          }),
          queue: true,
        },
      });

      const providerData = response?.data || {};

      const returnedReference = String(providerData.reference || "").trim();

      const providerStatus = String(providerData.status || "")
        .trim()
        .toLowerCase();

      await Transaction.updateOne(
        {
          _id: preparation.transaction._id,
          status: {
            $in: ["pending", "processing"],
          },
        },
        {
          $set: {
            "metadata.authorizationChargeRequestedAt": chargedAt,
            "metadata.authorizationChargeProviderStatus": providerStatus || null,
          },
        }
      );

      if (returnedReference && returnedReference !== preparation.payment.providerReference) {
        await Transaction.updateOne(
          {
            _id: preparation.transaction._id,
          },
          {
            $set: {
              "metadata.authorizationChargeReferenceMismatchAt": chargedAt,
              "metadata.authorizationChargeReturnedReference": returnedReference,
            },
          }
        );

        throw this.createError({
          message:
            "Paystack returned an unexpected reference for the recurring subscription charge. Reconciliation is required.",
          code: "SUBSCRIPTION_AUTHORIZATION_REFERENCE_MISMATCH",
          statusCode: 409,
          details: {
            expectedReference: preparation.payment.providerReference,
            returnedReference,
          },
        });
      }

      if (PAYSTACK_DEFINITIVE_FAILURE_STATUSES.includes(providerStatus)) {
        const failedResult = await this.failPaystackAttempt({
          paymentId: preparation.payment._id,
          transactionId: preparation.transaction._id,
          failureReason: `Paystack authorization charge status: ${providerStatus}.`,
          failedAt: chargedAt,
          metadata: {
            authorizationChargeFailedAt: chargedAt,
            authorizationChargeProviderStatus: providerStatus,
          },
        });

        return {
          payment: failedResult.payment,
          paid: false,
          pending: false,
          failed: true,
          idempotent: false,
          periodEndResult: failedResult.periodEndResult,
        };
      }

      if (providerStatus === "success") {
        return this.finalizePaystackPayment({
          reference: preparation.payment.providerReference,
          currentTime: chargedAt,
        });
      }

      return {
        payment: preparation.payment,
        paymentTransaction: preparation.transaction,
        paid: false,
        pending: true,
        failed: false,
        idempotent: false,
        providerStatus: providerStatus || null,
      };
    } catch (error) {
      if (error.code === "SUBSCRIPTION_AUTHORIZATION_REFERENCE_MISMATCH") {
        throw error;
      }

      const definitiveFailure = this.isDefinitiveProviderFailure(error);

      if (definitiveFailure) {
        const failedResult = await this.failPaystackAttempt({
          paymentId: preparation.payment._id,
          transactionId: preparation.transaction._id,
          failureReason: error.message,
          failedAt: chargedAt,
          metadata: {
            authorizationChargeFailedAt: chargedAt,
            authorizationChargeErrorCode: error.code || null,
          },
        });

        return {
          payment: failedResult.payment,
          paid: false,
          pending: false,
          failed: true,
          idempotent: false,
          periodEndResult: failedResult.periodEndResult,
          providerError: {
            code: error.code || null,
            message: error.message,
          },
        };
      }

      await Transaction.updateOne(
        {
          _id: preparation.transaction._id,
          status: {
            $in: ["pending", "processing"],
          },
        },
        {
          $set: {
            "metadata.authorizationChargeUncertainAt": chargedAt,
            "metadata.authorizationChargeError": String(
              error.message || "Paystack authorization charge status is uncertain."
            ).slice(0, 300),
            "metadata.authorizationChargeErrorCode": error.code || null,
          },
        }
      );

      throw error;
    }
  }

  /* ─────────────────────────────── DUE PAYMENT APPLICATION ─────────────────────────────── */

  static async applyDuePaidPayments({
    currentTime = new Date(),
    limit = DEFAULT_APPLICATION_BATCH_SIZE,
  } = {}) {
    const now = this.normalizeCurrentTime(currentTime);

    const batchLimit = this.normalizeBatchLimit(limit);

    const payments = await SubscriptionPayment.find({
      paymentStatus: "paid",
      appliedAt: null,
      $or: [
        {
          paymentKind: {
            $in: ["initial_purchase", "plan_change"],
          },
        },
        {
          paymentKind: "renewal",
          periodStart: {
            $lte: now,
          },
        },
      ],
    })
      .select("_id paymentReference paymentKind subscription business periodStart periodEnd")
      .sort({
        periodStart: 1,
        paidAt: 1,
        createdAt: 1,
        _id: 1,
      })
      .limit(batchLimit)
      .lean();

    const results = [];

    for (const candidate of payments) {
      try {
        const result = await this.applyPaidPayment({
          paymentId: candidate._id,
          currentTime: now,
        });

        results.push({
          paymentId: String(candidate._id),
          paymentReference: candidate.paymentReference,
          paymentKind: candidate.paymentKind,
          subscriptionId: String(candidate.subscription),
          success: true,
          applied: result.applied === true,
          idempotent: result.idempotent === true,
          reason: result.reason || null,
          events: result.events || [],
        });
      } catch (error) {
        results.push({
          paymentId: String(candidate._id),
          paymentReference: candidate.paymentReference,
          paymentKind: candidate.paymentKind,
          subscriptionId: String(candidate.subscription),
          success: false,
          applied: false,
          code: error.code || "SUBSCRIPTION_PAYMENT_APPLICATION_FAILED",
          message: error.message,
          events: [],
        });
      }
    }

    return {
      checked: payments.length,
      applied: results.filter((item) => item.success && item.applied).length,
      failed: results.filter((item) => !item.success).length,
      results,
    };
  }
}

module.exports = SubscriptionPaymentService;
