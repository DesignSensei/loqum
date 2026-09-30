// services/jobPublicationPaymentService.js

const crypto = require("crypto");

const EmployerProfile = require("../models/EmployerProfile");
const JobPostingPlan = require("../models/JobPostingPlan");
const JobPayment = require("../models/JobPayment");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");

const WalletService = require("./walletService");
const PaystackService = require("./paystackService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH } = require("../constants/employerMonetization");

const ERROR_NAME = "JobPublicationPaymentServiceError";

const JOB_PUBLICATION_PURCHASE_TYPE = "job_publication_purchase";
const JOB_PUBLICATION_PURCHASE_PURPOSE = "job_publication_purchase";

const PAYSTACK_OPEN_TRANSACTION_STATUSES = Object.freeze(["pending", "processing"]);
const PAYSTACK_DEFINITIVE_FAILURE_STATUSES = Object.freeze(["failed", "abandoned"]);

const MAX_IDEMPOTENCY_KEY_LENGTH = 250;

/**
 * JobPublicationPaymentService owns PAYG permanent-Job publication purchases.
 *
 * PRODUCT / PURCHASE BOUNDARY:
 *
 * JobPostingPlan
 * → the one-off product Loqum sells.
 *
 * JobPayment
 * → one employer's actual purchase and one-use publication entitlement.
 *
 * PAYMENT RAILS:
 *
 * wallet
 * → employer wallet debit + platform wallet credit.
 * → JobPayment.paymentTransaction points to the platform-wallet credit.
 *
 * paystack_checkout
 * → one pending external Paystack credit against the platform wallet.
 * → JobPayment.paymentTransaction points to that platform-wallet Transaction.
 * → successful verification completes the wallet-side Transaction and marks the
 *   JobPayment paid.
 *
 * IDEMPOTENCY:
 *
 * Financial purchase entry points require a caller-supplied idempotency key.
 * The key is converted into a deterministic purchaseReference. Replaying the
 * same key therefore resolves the same JobPayment instead of buying a second
 * publication entitlement.
 *
 * ENTITLEMENT CONSUMPTION:
 *
 * A paid JobPayment remains unused until publication. Consumption is claimed
 * atomically inside the surrounding Job-publication transaction. The resulting
 * grant uses source "paid_single_post" and is passed to JobPublicationService.
 *
 * The surrounding entitlement service must link the created JobPublication to
 * consumedByPublication before the transaction commits.
 *
 * ENTITLEMENT RESTORATION:
 *
 * A PAYG purchase is one-use. Once its entitlement has been consumed by a
 * JobPublication, ending or closing that publication early does not restore the
 * purchase. Republishing requires another eligible PAYG purchase.
 *
 * Payment refund or provider-reconciliation handling is a separate concern.
 * A refunded purchase is never reusable as publication authority.
 */
class JobPublicationPaymentService {
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
      createError: JobPublicationPaymentService.createError,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_JOB_PAYMENT_CURRENT_TIME",
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
        code: "INVALID_JOB_PAYMENT_COUNTRY_CODE",
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
        code: "INVALID_JOB_PAYMENT_CURRENCY",
        statusCode: 500,
      });
    }

    return currency;
  }

  static normalizeIdempotencyKey(value) {
    const idempotencyKey = String(value || "").trim();

    if (!idempotencyKey) {
      throw this.createError({
        message: "An idempotency key is required for a Job publication purchase.",
        code: "JOB_PAYMENT_IDEMPOTENCY_KEY_REQUIRED",
      });
    }

    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw this.createError({
        message: "The Job publication purchase idempotency key is too long.",
        code: "JOB_PAYMENT_IDEMPOTENCY_KEY_TOO_LONG",
      });
    }

    return idempotencyKey;
  }

  static buildPurchaseReference(idempotencyKey) {
    const normalizedKey = this.normalizeIdempotencyKey(idempotencyKey);

    const digest = crypto.createHash("sha256").update(normalizedKey).digest("hex").slice(0, 32);

    return `LQ-JPAY-${digest}`.toUpperCase();
  }

  static buildEntitlementConsumptionReference(purchaseReference) {
    return `paid-single:${String(purchaseReference).trim().toUpperCase()}`;
  }

  static buildWalletIdempotencyKeys(purchaseReference) {
    const prefix = `job-payment:${String(purchaseReference).trim().toLowerCase()}`;

    return {
      debitIdempotencyKey: `${prefix}:employer-debit`,
      creditIdempotencyKey: `${prefix}:platform-credit`,
    };
  }

  static buildPaystackCreditIdempotencyKey(purchaseReference) {
    return `job-payment:${String(purchaseReference).trim().toLowerCase()}:paystack-credit`;
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
        code: "JOB_PAYMENT_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  static assertEntitlementConsumptionTransaction(session) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.createError({
        message:
          "PAYG Job publication entitlement consumption must run inside the surrounding " +
          "Job publication transaction.",
        code: "JOB_PAYMENT_ENTITLEMENT_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return true;
  }

  static assertCanPurchaseJobPublication(employerContext = null) {
    const canPurchase = Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );

    if (!canPurchase) {
      throw this.createError({
        message: "You do not have permission to purchase permanent-Job publication access.",
        code: "JOB_PUBLICATION_PURCHASE_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
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
        code: "JOB_PAYMENT_EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employerProfile;
  }

  static async getPlan(planId, session = null) {
    const normalizedPlanId = this.normalizeObjectId(planId, "Job posting plan ID");

    const plan = await this.applySession(JobPostingPlan.findById(normalizedPlanId), session);

    if (!plan) {
      throw this.createError({
        message: "Job posting plan not found.",
        code: "JOB_POSTING_PLAN_NOT_FOUND",
        statusCode: 404,
      });
    }

    return plan;
  }

  static async getPaymentByPurchaseReference(purchaseReference, session = null) {
    const normalizedReference = String(purchaseReference || "")
      .trim()
      .toUpperCase();

    if (!normalizedReference) {
      return null;
    }

    return this.applySession(
      JobPayment.findOne({
        purchaseReference: normalizedReference,
      }),
      session
    );
  }

  static async getPaymentByProviderReference(providerReference, session = null) {
    const normalizedReference = String(providerReference || "").trim();

    if (!normalizedReference) {
      throw this.createError({
        message: "A Paystack payment reference is required.",
        code: "JOB_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
      });
    }

    const payment = await this.applySession(
      JobPayment.findOne({
        paymentMethod: "paystack_checkout",
        paymentProvider: "paystack",
        providerReference: normalizedReference,
      }),
      session
    );

    if (!payment) {
      throw this.createError({
        message: "The PAYG Job publication payment was not found.",
        code: "JOB_PAYMENT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return payment;
  }

  /* ─────────────────────────────── PRODUCT VALIDATION ─────────────────────────────── */

  static assertPlanAvailableForEmployer({ plan, employerProfile }) {
    if (plan.isActive !== true) {
      throw this.createError({
        message: "This PAYG Job posting plan is not currently available.",
        code: "JOB_POSTING_PLAN_NOT_ACTIVE",
        statusCode: 409,
      });
    }

    const employerCountryCode = this.normalizeCountryCode(employerProfile.countryCode);
    const employerCurrency = this.normalizeCurrency(employerProfile.currency);

    const planCountryCode = this.normalizeCountryCode(plan.countryCode);
    const planCurrency = this.normalizeCurrency(plan.currency);

    if (employerCountryCode !== planCountryCode || employerCurrency !== planCurrency) {
      throw this.createError({
        message: "This PAYG Job posting plan is not available for the employer's market.",
        code: "JOB_POSTING_PLAN_MARKET_MISMATCH",
        statusCode: 409,
        details: {
          employerCountryCode,
          employerCurrency,
          planCountryCode,
          planCurrency,
        },
      });
    }

    return true;
  }

  static buildPlanSnapshot(plan) {
    return {
      code: plan.code,
      version: plan.version,
      name: plan.name,
      countryCode: plan.countryCode,
      currency: plan.currency,
      priceMinor: plan.priceMinor,
      publicationPeriodDays: plan.publicationPeriodDays,
      featureKeys: Array.isArray(plan.featureKeys) ? [...plan.featureKeys] : [],
    };
  }

  static assertExistingPurchaseMatches({ payment, employerProfileId, planId, paymentMethod }) {
    const matches = Boolean(
      payment &&
      String(payment.business) === String(employerProfileId) &&
      String(payment.plan) === String(planId) &&
      payment.paymentMethod === paymentMethod
    );

    if (!matches) {
      throw this.createError({
        message: "The idempotency key belongs to a different Job publication purchase.",
        code: "JOB_PAYMENT_IDEMPOTENCY_CONFLICT",
        statusCode: 409,
        details: {
          purchaseReference: payment?.purchaseReference || null,
        },
      });
    }

    return true;
  }

  static assertExistingPurchaseReusable(payment) {
    if (payment.paymentStatus === "refunded") {
      throw this.createError({
        message: "This PAYG Job publication purchase has been refunded and cannot be reused.",
        code: "JOB_PAYMENT_ALREADY_REFUNDED",
        statusCode: 409,
      });
    }

    if (["failed", "cancelled"].includes(payment.paymentStatus)) {
      throw this.createError({
        message:
          "This Job publication purchase attempt is no longer payable. Start a new purchase.",
        code: "JOB_PAYMENT_ATTEMPT_CLOSED",
        statusCode: 409,
        details: {
          paymentStatus: payment.paymentStatus,
          purchaseReference: payment.purchaseReference,
        },
      });
    }

    return true;
  }

  /* ─────────────────────────────── PLAN READS ─────────────────────────────── */

  static async listActivePlans({ employerProfileId }, options = {}) {
    const employerProfile = await this.getEmployerProfile(
      employerProfileId,
      options.session || null
    );

    const countryCode = this.normalizeCountryCode(employerProfile.countryCode);
    const currency = this.normalizeCurrency(employerProfile.currency);

    const query = JobPostingPlan.find({
      countryCode,
      currency,
      isActive: true,
    }).sort({
      priceMinor: 1,
      name: 1,
      version: -1,
    });

    return this.applySession(query, options.session || null);
  }

  /* ─────────────────────────────── WALLET PURCHASE ─────────────────────────────── */

  static async purchaseFromWallet(
    {
      employerProfileId,
      employerContext = null,
      planId,
      purchasedByUserId,
      idempotencyKey,
      currentTime = new Date(),
    },
    options = {}
  ) {
    this.assertCanPurchaseJobPublication(employerContext);

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedPlanId = this.normalizeObjectId(planId, "Job posting plan ID");

    const normalizedPurchasedByUserId = this.normalizeObjectId(
      purchasedByUserId,
      "purchased-by user ID"
    );

    const purchasedAt = this.normalizeCurrentTime(currentTime);

    const purchaseReference = this.buildPurchaseReference(idempotencyKey);

    return this.runWithOptionalTransaction(options, async (session) => {
      const existingPayment = await this.getPaymentByPurchaseReference(purchaseReference, session);

      if (existingPayment) {
        this.assertExistingPurchaseMatches({
          payment: existingPayment,
          employerProfileId: normalizedEmployerProfileId,
          planId: normalizedPlanId,
          paymentMethod: "wallet",
        });

        this.assertExistingPurchaseReusable(existingPayment);

        if (existingPayment.paymentStatus === "paid") {
          return {
            payment: existingPayment,
            paymentTransactionId: existingPayment.paymentTransaction,
            paid: true,
            idempotent: true,
          };
        }

        throw this.createError({
          message:
            "The existing wallet Job publication purchase is in an unexpected pending state.",
          code: "JOB_PAYMENT_WALLET_PENDING_INTEGRITY_STATE",
          statusCode: 409,
          details: {
            purchaseReference,
          },
        });
      }

      const employerProfile = await this.getEmployerProfile(normalizedEmployerProfileId, session);
      const plan = await this.getPlan(normalizedPlanId, session);

      this.assertPlanAvailableForEmployer({
        plan,
        employerProfile,
      });

      const payment = new JobPayment({
        purchaseReference,

        entitlementConsumptionReference:
          this.buildEntitlementConsumptionReference(purchaseReference),

        business: normalizedEmployerProfileId,
        plan: normalizedPlanId,
        purchasedBy: normalizedPurchasedByUserId,

        planSnapshot: this.buildPlanSnapshot(plan),

        paymentMethod: "wallet",
        paymentTransaction: null,

        paymentProvider: null,
        providerReference: null,
        providerStatus: null,

        paymentStatus: "pending",

        paidAt: null,
        failedAt: null,
        failureReason: null,
        cancelledAt: null,
        refundedAt: null,

        consumedAt: null,
        consumedForJob: null,
        consumedByPublication: null,
      });

      await payment.save(this.saveOptions(session));

      const employerWallet = await WalletService.createEmployerWalletIfMissing(employerProfile, {
        session,
      });
      const platformWallet = await WalletService.createPlatformWallet(
        { countryCode: plan.countryCode, currency: plan.currency },
        { session }
      );

      const idempotencyKeys = this.buildWalletIdempotencyKeys(purchaseReference);

      const transferResult = await WalletService.transferBetweenWallets(
        {
          fromWalletId: employerWallet._id,
          toWalletId: platformWallet._id,

          amount: plan.priceMinor,

          type: JOB_PUBLICATION_PURCHASE_TYPE,
          purpose: JOB_PUBLICATION_PURCHASE_PURPOSE,

          paymentRail: "wallet_balance",

          debitIdempotencyKey: idempotencyKeys.debitIdempotencyKey,
          creditIdempotencyKey: idempotencyKeys.creditIdempotencyKey,

          initiatedBy: {
            role: "employer",
            userId: normalizedPurchasedByUserId,
          },

          description: `PAYG permanent-Job publication purchase ${purchaseReference}.`,

          metadata: {
            employerProfileId: String(normalizedEmployerProfileId),
            jobPaymentId: String(payment._id),
            purchaseReference,
            jobPostingPlanId: String(plan._id),
            planCode: plan.code,
            planVersion: plan.version,
            paymentMethod: "wallet",
            purchasedAt,
          },
        },
        {
          session,
        }
      );

      payment.paymentTransaction = transferResult.credit.transaction._id;
      payment.paymentStatus = "paid";
      payment.paidAt = purchasedAt;

      await payment.save(this.saveOptions(session));

      return {
        payment,
        paymentTransaction: transferResult.credit.transaction,
        employerWallet: transferResult.debit.wallet,
        platformWallet: transferResult.credit.wallet,
        paid: true,
        idempotent: transferResult.idempotent === true,
      };
    });
  }

  /* ─────────────────────────────── PAYSTACK CHECKOUT ─────────────────────────────── */

  static hasReusableCheckout(transaction) {
    return Boolean(
      transaction &&
      PAYSTACK_OPEN_TRANSACTION_STATUSES.includes(transaction.status) &&
      transaction.metadata?.authorizationUrl &&
      transaction.paystackReference
    );
  }

  static isDefinitiveInitializationFailure(error) {
    // Timeouts, rate limits and ambiguous responses leave a reconcilable attempt.
    return error?.code === "PAYSTACK_PROVIDER_REJECTED_REQUEST";
  }

  static buildCheckoutResponse({ payment, transaction, checkout = null, reused = false }) {
    const authorizationUrl =
      checkout?.authorizationUrl || transaction?.metadata?.authorizationUrl || null;

    if (!authorizationUrl) {
      throw this.createError({
        message:
          "The existing Paystack Checkout attempt does not have a reusable authorization URL.",
        code: "JOB_PAYMENT_CHECKOUT_URL_UNAVAILABLE",
        statusCode: 409,
        details: {
          purchaseReference: payment.purchaseReference,
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

  static async initializePaystackCheckout(
    {
      employerProfileId,
      employerContext = null,
      planId,
      purchasedByUserId,
      idempotencyKey,
      callbackUrl = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    if (options.session) {
      throw this.createError({
        message:
          "Checkout must commit preparation before contacting Paystack; external sessions are not supported.",
        code: "JOB_PAYMENT_EXTERNAL_SESSION_NOT_SUPPORTED",
        statusCode: 500,
      });
    }

    this.assertCanPurchaseJobPublication(employerContext);

    PaystackService.assertConfigured();

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedPlanId = this.normalizeObjectId(planId, "Job posting plan ID");

    const normalizedPurchasedByUserId = this.normalizeObjectId(
      purchasedByUserId,
      "purchased-by user ID"
    );

    const initializedAt = this.normalizeCurrentTime(currentTime);

    const purchaseReference = this.buildPurchaseReference(idempotencyKey);

    const preparation = await this.runWithOptionalTransaction(options, async (session) => {
      const existingPayment = await this.getPaymentByPurchaseReference(purchaseReference, session);

      if (existingPayment) {
        this.assertExistingPurchaseMatches({
          payment: existingPayment,
          employerProfileId: normalizedEmployerProfileId,
          planId: normalizedPlanId,
          paymentMethod: "paystack_checkout",
        });

        this.assertExistingPurchaseReusable(existingPayment);

        const transaction = await this.applySession(
          Transaction.findById(existingPayment.paymentTransaction),
          session
        );

        if (!transaction) {
          throw this.createError({
            message: "The PAYG Job payment is missing its platform-wallet payment Transaction.",
            code: "JOB_PAYMENT_TRANSACTION_NOT_FOUND",
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
            message: "The existing Paystack Job publication purchase attempt is no longer open.",
            code: "JOB_PAYMENT_PAYSTACK_ATTEMPT_NOT_OPEN",
            statusCode: 409,
            details: {
              transactionStatus: transaction.status,
              purchaseReference,
            },
          });
        }

        throw this.createError({
          message:
            "Paystack Checkout is already being initialized or processed for this Job publication purchase. Please try again shortly.",
          code: "JOB_PAYMENT_CHECKOUT_INITIALIZATION_IN_PROGRESS",
          statusCode: 409,
          details: {
            transactionId: String(transaction._id),
            status: transaction.status,
            purchaseReference,
          },
        });
      }

      const employerProfile = await this.getEmployerProfile(normalizedEmployerProfileId, session);
      const plan = await this.getPlan(normalizedPlanId, session);

      this.assertPlanAvailableForEmployer({
        plan,
        employerProfile,
      });

      const customerEmail = String(employerProfile.businessEmail || "")
        .trim()
        .toLowerCase();

      if (!customerEmail) {
        throw this.createError({
          message: "The employer business email is required for Paystack Checkout.",
          code: "JOB_PAYMENT_EMPLOYER_EMAIL_REQUIRED",
          statusCode: 409,
        });
      }

      const platformWallet = await WalletService.createPlatformWallet(
        {
          countryCode: plan.countryCode,
          currency: plan.currency,
        },
        {
          session,
        }
      );

      const providerReference = purchaseReference;

      const pendingCredit = await WalletService.createPendingExternalCredit(
        {
          walletId: platformWallet._id,

          amount: plan.priceMinor,

          type: JOB_PUBLICATION_PURCHASE_TYPE,
          purpose: JOB_PUBLICATION_PURCHASE_PURPOSE,

          paymentRail: "paystack_checkout",
          provider: "paystack",

          reference: providerReference,

          idempotencyKey: this.buildPaystackCreditIdempotencyKey(purchaseReference),

          paystackReference: providerReference,

          initiatedBy: {
            role: "employer",
            userId: normalizedPurchasedByUserId,
          },

          description:
            `Paystack PAYG permanent-Job publication purchase ` + `${purchaseReference}.`,

          metadata: {
            employerProfileId: String(normalizedEmployerProfileId),
            purchaseReference,
            jobPostingPlanId: String(plan._id),
            planCode: plan.code,
            planVersion: plan.version,
            paymentMethod: "paystack_checkout",
            customerEmail,
            callbackUrl,
            checkoutPreparedAt: initializedAt,
          },
        },
        {
          session,
        }
      );

      const payment = new JobPayment({
        purchaseReference,

        entitlementConsumptionReference:
          this.buildEntitlementConsumptionReference(purchaseReference),

        business: normalizedEmployerProfileId,
        plan: normalizedPlanId,
        purchasedBy: normalizedPurchasedByUserId,

        planSnapshot: this.buildPlanSnapshot(plan),

        paymentMethod: "paystack_checkout",
        paymentTransaction: pendingCredit.transaction._id,

        paymentProvider: "paystack",
        providerReference,
        providerStatus: "pending",

        paymentStatus: "pending",

        paidAt: null,
        failedAt: null,
        failureReason: null,
        cancelledAt: null,
        refundedAt: null,

        consumedAt: null,
        consumedForJob: null,
        consumedByPublication: null,
      });

      await payment.save(this.saveOptions(session));

      pendingCredit.transaction.metadata = {
        ...(pendingCredit.transaction.metadata || {}),
        jobPaymentId: String(payment._id),
      };

      pendingCredit.transaction.markModified("metadata");

      await pendingCredit.transaction.save(this.saveOptions(session));

      return {
        alreadyPaid: false,
        reused: false,

        payment,
        transaction: pendingCredit.transaction,

        customerEmail,
        amount: plan.priceMinor,
        currency: plan.currency,
      };
    });

    if (preparation.alreadyPaid) {
      return {
        payment: preparation.payment,
        alreadyPaid: true,
        reused: true,
        checkout: null,
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
          purpose: JOB_PUBLICATION_PURCHASE_PURPOSE,
          paymentRail: "paystack_checkout",

          purchaseReference: preparation.payment.purchaseReference,

          jobPaymentId: String(preparation.payment._id),

          employerProfileId: String(preparation.payment.business),

          jobPostingPlanId: String(preparation.payment.plan),

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
      };
    } catch (error) {
      const definitiveFailure = this.isDefinitiveInitializationFailure(error);

      if (definitiveFailure) {
        await this.runWithOptionalTransaction({}, async (session) => {
          await WalletService.markPendingExternalCreditFailed(
            {
              transactionId: preparation.transaction._id,

              failureReason: error.message,

              metadata: {
                checkoutInitializationFailedAt: initializedAt,

                checkoutInitializationErrorCode: error.code || null,
              },
            },
            {
              session,
            }
          );

          const payment = await this.applySession(
            JobPayment.findById(preparation.payment._id),
            session
          );

          if (payment && payment.paymentStatus === "pending") {
            payment.paymentStatus = "failed";
            payment.providerStatus = "failed";
            payment.failedAt = initializedAt;

            payment.failureReason = String(
              error.message || "Paystack Checkout initialization failed."
            ).slice(0, MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH);

            await payment.save(this.saveOptions(session));
          }
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

  /* ─────────────────────────────── PAYSTACK VERIFICATION ─────────────────────────────── */

  static resolveVerifiedPaymentTime(verifiedPayment) {
    const rawPaidAt = verifiedPayment?.paidAt || verifiedPayment?.paid_at || null;

    if (!rawPaidAt) {
      throw this.createError({
        message: "The verified Paystack payment does not contain a confirmed payment time.",
        code: "JOB_PAYMENT_PAYSTACK_PAID_AT_REQUIRED",
        statusCode: 409,
      });
    }

    const paidAt = new Date(rawPaidAt);

    if (Number.isNaN(paidAt.getTime())) {
      throw this.createError({
        message: "The verified Paystack payment time is invalid.",
        code: "INVALID_JOB_PAYMENT_PAYSTACK_PAID_AT",
        statusCode: 409,
      });
    }

    return paidAt;
  }

  static getVerifiedProviderAmounts(verifiedPayment) {
    const amount = Number(verifiedPayment?.amount);

    const providerFee = verifiedPayment?.fees == null ? 0 : Number(verifiedPayment.fees);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw this.createError({
        message: "The verified Paystack payment amount is invalid.",
        code: "INVALID_JOB_PAYMENT_PAYSTACK_AMOUNT",
        statusCode: 409,
      });
    }

    if (!Number.isSafeInteger(providerFee) || providerFee < 0 || providerFee > amount) {
      throw this.createError({
        message: "The verified Paystack provider fee is invalid.",
        code: "INVALID_JOB_PAYMENT_PAYSTACK_PROVIDER_FEE",
        statusCode: 409,
      });
    }

    return {
      amount,
      providerFee,
      netAmount: amount - providerFee,
    };
  }

  static async getCanonicalPaystackReceipt(payment, session = null) {
    const transaction = await this.applySession(
      Transaction.findById(payment.paymentTransaction),
      session
    );
    const wallet = transaction
      ? await this.applySession(Wallet.findById(transaction.wallet), session)
      : null;
    const snapshot = payment.planSnapshot;
    if (
      !transaction ||
      !wallet ||
      !snapshot ||
      payment.paymentMethod !== "paystack_checkout" ||
      payment.paymentProvider !== "paystack" ||
      !payment.providerReference ||
      String(transaction._id) !== String(payment.paymentTransaction) ||
      transaction.direction !== "credit" ||
      transaction.provider !== "paystack" ||
      transaction.paymentRail !== "paystack_checkout" ||
      transaction.type !== JOB_PUBLICATION_PURCHASE_TYPE ||
      transaction.purpose !== JOB_PUBLICATION_PURCHASE_PURPOSE ||
      transaction.paystackReference !== payment.providerReference ||
      !Number.isSafeInteger(snapshot.priceMinor) ||
      snapshot.priceMinor <= 0 ||
      transaction.amount !== snapshot.priceMinor ||
      transaction.currency !== snapshot.currency ||
      transaction.countryCode !== snapshot.countryCode ||
      wallet.ownerType !== "platform" ||
      String(wallet._id) !== String(transaction.wallet) ||
      wallet.currency !== snapshot.currency ||
      wallet.countryCode !== snapshot.countryCode ||
      String(transaction.metadata?.jobPaymentId) !== String(payment._id) ||
      String(transaction.metadata?.employerProfileId) !== String(payment.business) ||
      transaction.metadata?.purchaseReference !== payment.purchaseReference ||
      String(transaction.metadata?.jobPostingPlanId) !== String(payment.plan) ||
      (payment.paymentStatus === "paid" && transaction.status !== "completed")
    ) {
      throw this.createError({
        message: "The PAYG payment does not match its canonical platform receipt.",
        code: "JOB_PAYMENT_CANONICAL_RECEIPT_MISMATCH",
        statusCode: 409,
      });
    }
    return transaction;
  }

  static validateVerifiedPaystackPayment({ verifiedPayment, payment, transaction }) {
    const verifiedStatus = String(verifiedPayment?.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      throw this.createError({
        message: "The Paystack Job publication payment has not completed successfully.",
        code: "JOB_PAYMENT_PAYSTACK_NOT_SUCCESSFUL",
        statusCode: 409,

        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    const verifiedAmount = Number(verifiedPayment.amount);

    if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== Number(transaction.amount)) {
      throw this.createError({
        message: "The verified Paystack amount does not match the PAYG Job publication price.",
        code: "JOB_PAYMENT_PAYSTACK_AMOUNT_MISMATCH",
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
        message: "The verified Paystack currency does not match the PAYG Job publication currency.",
        code: "JOB_PAYMENT_PAYSTACK_CURRENCY_MISMATCH",
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
        message: "The verified Paystack reference does not match the PAYG Job publication payment.",
        code: "JOB_PAYMENT_PAYSTACK_REFERENCE_MISMATCH",
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
        code: "JOB_PAYMENT_PAYSTACK_CUSTOMER_MISMATCH",
        statusCode: 409,
      });
    }

    const metadata =
      verifiedPayment.metadata && typeof verifiedPayment.metadata === "object"
        ? verifiedPayment.metadata
        : {};

    if (
      metadata.purchaseReference &&
      String(metadata.purchaseReference).toUpperCase() !== payment.purchaseReference
    ) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the PAYG purchase reference.",
        code: "JOB_PAYMENT_PAYSTACK_PURCHASE_MISMATCH",
        statusCode: 409,
      });
    }

    if (
      metadata.employerProfileId &&
      String(metadata.employerProfileId) !== String(payment.business)
    ) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the employer.",
        code: "JOB_PAYMENT_PAYSTACK_EMPLOYER_MISMATCH",
        statusCode: 409,
      });
    }

    if (metadata.jobPostingPlanId && String(metadata.jobPostingPlanId) !== String(payment.plan)) {
      throw this.createError({
        message: "The Paystack payment metadata does not match the purchased Job posting plan.",
        code: "JOB_PAYMENT_PAYSTACK_PLAN_MISMATCH",
        statusCode: 409,
      });
    }

    return true;
  }

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
        code: "JOB_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
      });
    }

    const existingPayment = await this.getPaymentByProviderReference(normalizedReference);

    if (existingPayment.paymentStatus === "paid") {
      await this.getCanonicalPaystackReceipt(existingPayment);
      return {
        payment: existingPayment,
        paid: true,
        idempotent: true,
      };
    }

    this.assertExistingPurchaseReusable(existingPayment);

    const verifiedPayment = await PaystackService.verifyTransaction(normalizedReference);

    const verifiedStatus = String(verifiedPayment?.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      if (PAYSTACK_DEFINITIVE_FAILURE_STATUSES.includes(verifiedStatus)) {
        await this.runWithOptionalTransaction({}, async (session) => {
          const payment = await this.getPaymentByProviderReference(normalizedReference, session);

          if (payment.paymentStatus === "paid") {
            return;
          }

          this.assertExistingPurchaseReusable(payment);
          await this.getCanonicalPaystackReceipt(payment, session);
          await WalletService.markPendingExternalCreditFailed(
            {
              transactionId: payment.paymentTransaction,

              failureReason: `Paystack payment status: ${verifiedStatus}.`,

              metadata: {
                verifiedAt: finalizedAt,
                verifiedPaystackStatus: verifiedStatus,
              },
            },
            {
              session,
            }
          );

          payment.paymentStatus = "failed";
          payment.providerStatus = "failed";
          payment.failedAt = finalizedAt;

          payment.failureReason = `Paystack payment status: ${verifiedStatus}.`;

          await payment.save(this.saveOptions(session));
        });
      }

      if (verifiedStatus === "reversed") {
        throw this.createError({
          message:
            "The Paystack payment is reversed and requires payment reconciliation before the entitlement can be used.",
          code: "JOB_PAYMENT_PAYSTACK_REVERSED_RECONCILIATION_REQUIRED",
          statusCode: 409,
        });
      }

      throw this.createError({
        message: "The Paystack Job publication payment has not completed successfully.",
        code: "JOB_PAYMENT_PAYSTACK_NOT_SUCCESSFUL",
        statusCode: 409,

        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    const transaction = await this.getCanonicalPaystackReceipt(existingPayment);

    this.validateVerifiedPaystackPayment({
      verifiedPayment,
      payment: existingPayment,
      transaction,
    });

    const paidAt = this.resolveVerifiedPaymentTime(verifiedPayment);

    const providerAmounts = this.getVerifiedProviderAmounts(verifiedPayment);

    return this.runWithOptionalTransaction({}, async (session) => {
      const payment = await this.getPaymentByProviderReference(normalizedReference, session);

      if (payment.paymentStatus === "paid") {
        await this.getCanonicalPaystackReceipt(payment, session);
        return {
          payment,
          paid: true,
          idempotent: true,
        };
      }

      this.assertExistingPurchaseReusable(payment);

      const currentTransaction = await this.getCanonicalPaystackReceipt(payment, session);
      this.validateVerifiedPaystackPayment({
        verifiedPayment,
        payment,
        transaction: currentTransaction,
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

      await payment.save(this.saveOptions(session));

      return {
        payment,

        paymentTransaction: completedCredit.transaction,

        platformWallet: completedCredit.wallet,

        paid: true,

        idempotent: completedCredit.idempotent === true,
      };
    });
  }

  /* ─────────────────────────────── ENTITLEMENT CONSUMPTION ─────────────────────────────── */

  static async consumePaidPublicationEntitlement(
    { employerProfileId, jobId, currentTime = new Date() },
    options = {}
  ) {
    const session = options.session || null;

    this.assertEntitlementConsumptionTransaction(session);

    const normalizedEmployerProfileId = this.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const normalizedJobId = this.normalizeObjectId(jobId, "Job ID");

    const consumedAt = this.normalizeCurrentTime(currentTime);

    const payment = await JobPayment.findOneAndUpdate(
      {
        business: normalizedEmployerProfileId,

        paymentStatus: "paid",

        paidAt: {
          $lte: consumedAt,
        },

        consumedAt: null,
        consumedForJob: null,
        consumedByPublication: null,
      },
      {
        $set: {
          consumedAt,
          consumedForJob: normalizedJobId,
        },
      },
      {
        new: true,

        sort: {
          paidAt: 1,
          createdAt: 1,
        },

        session,
      }
    );

    if (!payment) {
      return {
        eligible: false,
        reason: "no_unconsumed_paid_purchase",
        payment: null,
        entitlementGrant: null,
      };
    }

    return {
      eligible: true,
      reason: null,

      payment,

      entitlementGrant: {
        source: "paid_single_post",

        consumptionReference: payment.entitlementConsumptionReference,

        planCode: payment.planSnapshot.code,

        planName: payment.planSnapshot.name,

        billingCycleKey: null,

        purchaseReference: payment.purchaseReference,

        paymentTransaction: payment.paymentTransaction,

        grantedAt: payment.paidAt,
        consumedAt,
      },
    };
  }

  static async linkConsumedPublication({ jobPaymentId, jobId, publicationId }, options = {}) {
    const session = options.session || null;

    this.assertEntitlementConsumptionTransaction(session);

    const normalizedJobPaymentId = this.normalizeObjectId(jobPaymentId, "Job payment ID");

    const normalizedJobId = this.normalizeObjectId(jobId, "Job ID");

    const normalizedPublicationId = this.normalizeObjectId(publicationId, "Job publication ID");

    const payment = await this.applySession(JobPayment.findById(normalizedJobPaymentId), session);

    if (!payment) {
      throw this.createError({
        message: "PAYG Job publication payment not found.",
        code: "JOB_PAYMENT_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (!payment.consumedAt || !payment.consumedForJob) {
      throw this.createError({
        message: "The PAYG Job publication entitlement has not been consumed.",
        code: "JOB_PAYMENT_ENTITLEMENT_NOT_CONSUMED",
        statusCode: 409,
      });
    }

    if (String(payment.consumedForJob) !== String(normalizedJobId)) {
      throw this.createError({
        message: "The PAYG entitlement was consumed for a different Job.",
        code: "JOB_PAYMENT_CONSUMED_JOB_MISMATCH",
        statusCode: 409,
      });
    }

    if (payment.consumedByPublication) {
      if (String(payment.consumedByPublication) === String(normalizedPublicationId)) {
        return {
          payment,
          linked: false,
          idempotent: true,
        };
      }

      throw this.createError({
        message: "The PAYG entitlement is already linked to a different Job publication.",
        code: "JOB_PAYMENT_PUBLICATION_CONSUMPTION_CONFLICT",
        statusCode: 409,
      });
    }

    payment.consumedByPublication = normalizedPublicationId;

    await payment.save(this.saveOptions(session));

    return {
      payment,
      linked: true,
      idempotent: false,
    };
  }
}

module.exports = JobPublicationPaymentService;
