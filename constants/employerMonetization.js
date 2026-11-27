// constants/employerMonetization.js

// SubscriptionPlan: recurring product definition.
// Subscription: employer subscription lifecycle.
// SubscriptionPayment: purchased subscription periods.
// JobPostingPlan: PAYG product definition.
// JobPayment: PAYG purchase and payment lifecycle.
// JobPublication: publication lifecycle and slot occupancy.

// Publication rules belong to jobPosting.js.
// Financial rate precision belongs to shiftPosting.js.

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

// Wallet payments have no external provider.
exports.JOB_PAYMENT_PROVIDERS = Object.freeze(["paystack", null]);

// Provider status is independent of Loqum's commercial payment status.
exports.JOB_PAYMENT_PROVIDER_STATUSES = Object.freeze([
  "pending",
  "success",
  "failed",
  "reversed",
  null,
]);

/* ─────────────────────────────── SHARED PRODUCT LIMITS ─────────────────────────────── */

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
