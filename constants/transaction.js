// constants/transaction.js

/**
 * Shared transaction vocabulary.
 *
 * A Transaction records one wallet-side ledger movement.
 *
 * Professional payouts belong to ShiftSettlementBatch.
 * Platform fees are occurrence-level.
 * EmployerRefundBatch owns weekly refund execution.
 * Successful Paystack Shift-funding payments that cannot fund their Shift
 * are returned directly from escrow to the employer wallet.
 */

/* ─────────────────────────────── LIMITS ─────────────────────────────── */

exports.MAX_TRANSACTION_FAILURE_REASON_LENGTH = 500;

exports.MAX_TRANSACTION_REVERSAL_REASON_LENGTH = 500;

exports.MAX_TRANSACTION_CANCELLATION_REASON_LENGTH = 500;

exports.MAX_TRANSACTION_DESCRIPTION_LENGTH = 500;

/* ─────────────────────────────── TRANSACTION TYPES ─────────────────────────────── */

exports.TRANSACTION_TYPES = Object.freeze([
  "wallet_funding",

  "shift_funding",

  "shift_topup",

  "shift_refund",

  "professional_payout",

  "platform_fee",

  "outstanding_charge",

  "outstanding_settlement",

  "withdrawal",

  "withdrawal_reversal",

  "dispute_refund",

  "cancellation_fee",

  "penalty_debit",

  "adjustment",

  "credit_purchase",
]);

/* ─────────────────────────────── SHIFT PAYMENT RETURNS ─────────────────────────────── */

/**
 * Direct wallet-return reasons for successful Paystack Shift payments:
 *
 * late               → payment completed at/after Shift start.
 * duplicate          → another transaction already funded the Shift.
 * timely_expired     → payment was on time, but funding-deadline cancellation occurred before application.
 * employer_cancelled → employer cancelled the pending-funding Shift before payment application.
 */
exports.SHIFT_PAYMENT_RETURN_PURPOSE_BY_REASON = Object.freeze({
  late: "late_shift_payment_return",

  duplicate: "duplicate_shift_payment_return",

  timely_expired: "timely_unapplied_shift_payment_return",

  employer_cancelled: "employer_cancelled_shift_payment_return",
});

exports.SHIFT_PAYMENT_RETURN_PURPOSES = Object.freeze(
  Object.values(exports.SHIFT_PAYMENT_RETURN_PURPOSE_BY_REASON)
);

/* ─────────────────────────────── TRANSACTION PURPOSES ─────────────────────────────── */

exports.TRANSACTION_PURPOSES = Object.freeze([
  "wallet_topup",

  "shift_base_funding",

  "shift_overtime_topup",

  ...exports.SHIFT_PAYMENT_RETURN_PURPOSES,

  "expired_unfilled_refund",

  "unused_occurrence_balance_refund",

  "cancelled_occurrence_refund",

  "confirmed_no_show_refund",

  "closed_occurrence_refund",

  "final_shift_reconciliation_refund",

  "weekly_employer_refund",

  "weekly_professional_payout",

  "base_platform_fee_earned",

  "overtime_platform_fee_earned",

  "withdrawal",

  "withdrawal_reversal",

  "cancellation_fee",

  "dispute_resolution",

  "admin_adjustment",

  "credit_purchase",

  null,
]);

/* ─────────────────────────────── TRANSACTION STATUSES ─────────────────────────────── */

exports.TRANSACTION_STATUSES = Object.freeze([
  "pending",

  "processing",

  "completed",

  "failed",

  "reversed",

  "cancelled",
]);

/* ─────────────────────────────── TRANSACTION DIRECTIONS ─────────────────────────────── */

exports.TRANSACTION_DIRECTIONS = Object.freeze(["credit", "debit"]);

/* ─────────────────────────────── PROVIDERS ─────────────────────────────── */

exports.TRANSACTION_PROVIDERS = Object.freeze(["paystack", "internal", "manual", null]);

/* ─────────────────────────────── PAYMENT RAILS ─────────────────────────────── */

exports.TRANSACTION_PAYMENT_RAILS = Object.freeze([
  "wallet_balance",

  "paystack_checkout",

  "paystack_dva",

  "paystack_refund",

  "paystack_transfer",

  "internal_transfer",

  "platform_wallet",

  "admin_action",

  "system_action",

  null,
]);

/**
 * Movement between Loqum-controlled wallets.
 */
exports.INTERNAL_PAYMENT_RAILS = Object.freeze([
  "wallet_balance",

  "internal_transfer",

  "platform_wallet",
]);

/**
 * Rails handled through Paystack.
 */
exports.PAYSTACK_PAYMENT_RAILS = Object.freeze([
  "paystack_checkout",

  "paystack_dva",

  "paystack_refund",

  "paystack_transfer",
]);

/**
 * Rails that use paystackReference.
 * Paystack Transfer uses paystackTransferCode instead.
 */
exports.PAYSTACK_PAYMENT_REFERENCE_RAILS = Object.freeze([
  "paystack_checkout",

  "paystack_dva",

  "paystack_refund",
]);

/* ─────────────────────────────── PAYSTACK STATUSES ─────────────────────────────── */

exports.PAYSTACK_TRANSACTION_STATUSES = Object.freeze([
  "pending",

  "success",

  "failed",

  "reversed",

  null,
]);

/* ─────────────────────────────── INITIATOR ROLES ─────────────────────────────── */

exports.TRANSACTION_INITIATOR_ROLES = Object.freeze([
  "system",

  "employer",

  "professional",

  "admin",
]);

/* ─────────────────────────────── DIRECT SHIFT TRANSACTIONS ─────────────────────────────── */

/**
 * Types that inherently belong to one Shift.
 *
 * shift_refund is excluded because it may also belong to EmployerRefundBatch.
 * professional_payout belongs to ShiftSettlementBatch.
 */
exports.DIRECT_SHIFT_TRANSACTION_TYPES = Object.freeze([
  "shift_funding",

  "shift_topup",

  "platform_fee",

  "outstanding_charge",

  "outstanding_settlement",

  "dispute_refund",

  "cancellation_fee",
]);

/* ─────────────────────────────── ASSIGNMENT-CASE TRANSACTIONS ─────────────────────────────── */

exports.ASSIGNMENT_CASE_ALLOWED_TRANSACTION_TYPES = Object.freeze([
  "shift_refund",

  "dispute_refund",

  "cancellation_fee",
]);

/* ─────────────────────────────── SHIFT FUNDING ─────────────────────────────── */

exports.SHIFT_FUNDING_TRANSACTION_TYPES = Object.freeze(["shift_funding", "shift_topup"]);

/**
 * Mixed Shift funding is not supported.
 */
exports.SHIFT_FUNDING_PAYMENT_RAILS = Object.freeze(["wallet_balance", "paystack_checkout"]);

/* ─────────────────────────────── PLATFORM FEES ─────────────────────────────── */

/**
 * Exact purpose for each occurrence-level platform fee.
 */
exports.PLATFORM_FEE_PURPOSE_BY_COMPONENT = Object.freeze({
  base: "base_platform_fee_earned",

  overtime: "overtime_platform_fee_earned",
});

exports.PLATFORM_FEE_PURPOSES = Object.freeze(
  Object.values(exports.PLATFORM_FEE_PURPOSE_BY_COMPONENT)
);

/**
 * Earned platform fees move from escrow to the platform wallet.
 */
exports.PLATFORM_FEE_PAYMENT_RAILS = Object.freeze(["internal_transfer"]);

/* ─────────────────────────────── REFUND PURPOSES ─────────────────────────────── */

/**
 * Occurrence-level scheduled/base refunds.
 * Earned platform fees are excluded.
 */
exports.OCCURRENCE_REFUND_PURPOSES = Object.freeze([
  "expired_unfilled_refund",

  "unused_occurrence_balance_refund",

  "cancelled_occurrence_refund",

  "confirmed_no_show_refund",

  "closed_occurrence_refund",
]);

/**
 * Parent-Shift refund and Paystack payment-return purposes.
 */
exports.SHIFT_LEVEL_REFUND_PURPOSES = Object.freeze([
  "final_shift_reconciliation_refund",

  ...exports.SHIFT_PAYMENT_RETURN_PURPOSES,
]);

exports.DIRECT_SHIFT_REFUND_PURPOSES = Object.freeze([
  ...exports.OCCURRENCE_REFUND_PURPOSES,

  ...exports.SHIFT_LEVEL_REFUND_PURPOSES,
]);

exports.EMPLOYER_REFUND_BATCH_PURPOSES = Object.freeze(["weekly_employer_refund"]);

exports.SHIFT_REFUND_PURPOSES = Object.freeze([
  ...exports.DIRECT_SHIFT_REFUND_PURPOSES,

  ...exports.EMPLOYER_REFUND_BATCH_PURPOSES,
]);

/* ─────────────────────────────── REFUND PAYMENT RAILS ─────────────────────────────── */

/**
 * paystack_transfer is reserved for EmployerRefundBatch fallback execution.
 */
exports.SHIFT_REFUND_PAYMENT_RAILS = Object.freeze([
  "internal_transfer",

  "paystack_refund",

  "paystack_transfer",
]);

exports.EMPLOYER_REFUND_BATCH_PAYMENT_RAILS = Object.freeze([
  "internal_transfer",

  "paystack_refund",

  "paystack_transfer",
]);

/* ─────────────────────────────── EMPLOYER REFUND BATCH ─────────────────────────────── */

exports.EMPLOYER_REFUND_BATCH_TRANSACTION_TYPES = Object.freeze(["shift_refund"]);

exports.EMPLOYER_REFUND_BATCH_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  shift_refund: "weekly_employer_refund",
});

/* ─────────────────────────────── PROFESSIONAL SETTLEMENT BATCH ─────────────────────────────── */

/**
 * ShiftSettlementBatch releases professional earnings only.
 */
exports.SETTLEMENT_BATCH_TRANSACTION_TYPES = Object.freeze(["professional_payout"]);

exports.SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  professional_payout: "weekly_professional_payout",
});

exports.SETTLEMENT_BATCH_PURPOSES = Object.freeze(
  Object.values(exports.SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE)
);

/* ─────────────────────────────── REQUIRED PURPOSES ─────────────────────────────── */

/**
 * Types with one legal purpose regardless of caller.
 */
exports.REQUIRED_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  wallet_funding: "wallet_topup",

  shift_funding: "shift_base_funding",

  shift_topup: "shift_overtime_topup",

  professional_payout: "weekly_professional_payout",

  withdrawal: "withdrawal",

  withdrawal_reversal: "withdrawal_reversal",

  dispute_refund: "dispute_resolution",

  cancellation_fee: "cancellation_fee",

  adjustment: "admin_adjustment",

  credit_purchase: "credit_purchase",
});

/* ─────────────────────────────── PAYSTACK TRANSFER ─────────────────────────────── */

/**
 * Allowed only for bank withdrawals and EmployerRefundBatch fallback refunds.
 */
exports.PAYSTACK_TRANSFER_ALLOWED_TRANSACTION_TYPES = Object.freeze(["withdrawal", "shift_refund"]);
