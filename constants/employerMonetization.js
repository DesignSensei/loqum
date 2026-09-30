// constants/employerMonetization.js

/**
 * EMPLOYER MONETIZATION CONSTANTS
 *
 * Shared commercial vocabulary for Loqum employer subscriptions and permanent-
 * Job PAYG publication purchases.
 *
 * DOMAIN OWNERSHIP:
 *
 * SubscriptionPlan
 * → recurring product definition, including active permanent-Job slot capacity.
 *
 * Subscription
 * → one employer's recurring commercial relationship and purchased plan snapshot.
 *
 * SubscriptionPayment
 * → authoritative payment record for one subscription billing period.
 *
 * JobPostingPlan
 * → one-off PAYG permanent-Job publication product.
 *
 * JobPayment
 * → one employer's actual PAYG purchase and payment record.
 *
 * JobPublication
 * → durable evidence of publication lifecycle and subscription Job-slot occupancy.
 *
 * Job-publication lifecycle rules such as publication duration remain owned by
 * constants/jobPosting.js.
 *
 * Shift financial-rate precision remains owned by constants/shiftPosting.js.
 */

/* ─────────────────────────────── SUBSCRIPTION PLANS ─────────────────────────────── */

exports.SUBSCRIPTION_PLAN_STATUSES = Object.freeze(["draft", "active", "retired"]);

exports.SUBSCRIPTION_BILLING_CYCLES = Object.freeze(["monthly", "yearly"]);

/* ─────────────────────────────── SUBSCRIPTIONS ─────────────────────────────── */

exports.SUBSCRIPTION_STATUSES = Object.freeze(["pending", "active", "cancelled", "expired"]);

/* ─────────────────────────────── JOB PAYMENTS ─────────────────────────────── */

exports.JOB_PAYMENT_METHODS = Object.freeze(["wallet", "paystack_checkout"]);

exports.JOB_PAYMENT_STATUSES = Object.freeze([
  "pending",
  "paid",
  "failed",
  "cancelled",
  "refunded",
]);

/**
 * Direct provider provenance for commercial purchases.
 *
 * Wallet payments have no external payment provider.
 * Direct Paystack Checkout payments use "paystack".
 */
exports.JOB_PAYMENT_PROVIDERS = Object.freeze(["paystack", null]);

/**
 * Provider-side state for a direct Paystack Checkout purchase.
 *
 * This describes the external payment provider's state and is intentionally
 * separate from JobPayment.paymentStatus, which describes Loqum's commercial
 * interpretation of the purchase.
 */
exports.JOB_PAYMENT_PROVIDER_STATUSES = Object.freeze([
  "pending",
  "success",
  "failed",
  "reversed",
  null,
]);

/* ─────────────────────────────── SHARED PRODUCT LIMITS ─────────────────────────────── */

/**
 * SubscriptionPlan and JobPostingPlan use the same commercial identity limits.
 * Their historical snapshots should use these same limits.
 */
exports.MAX_COMMERCIAL_PLAN_CODE_LENGTH = 80;

exports.MAX_COMMERCIAL_PLAN_NAME_LENGTH = 120;

exports.MAX_COMMERCIAL_PLAN_DESCRIPTION_LENGTH = 1000;

exports.MAX_COMMERCIAL_FEATURE_KEYS = 50;

exports.MAX_COMMERCIAL_FEATURE_KEY_LENGTH = 100;

/* ─────────────────────────────── SUBSCRIPTION LIMITS ─────────────────────────────── */

exports.MAX_SUBSCRIPTION_REFERENCE_LENGTH = 120;

exports.MAX_SUBSCRIPTION_BILLING_CYCLE_KEY_LENGTH = 150;

/* ─────────────────────────────── JOB PAYMENT LIMITS ─────────────────────────────── */

exports.MAX_JOB_PAYMENT_PURCHASE_REFERENCE_LENGTH = 180;

exports.MAX_JOB_PAYMENT_ENTITLEMENT_REFERENCE_LENGTH = 250;

exports.MAX_JOB_PAYMENT_PROVIDER_REFERENCE_LENGTH = 250;

exports.MAX_JOB_PAYMENT_FAILURE_REASON_LENGTH = 500;
