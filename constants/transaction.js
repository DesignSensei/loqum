// constants/transaction.js

/**
 * TRANSACTION CONSTANTS
 *
 * This file defines the shared transaction vocabulary used across:
 *
 * - Transaction model validation;
 * - WalletService;
 * - Shift funding;
 * - overtime top-up;
 * - direct Shift refunds;
 * - weekly employer refund batching;
 * - weekly professional settlement;
 * - occurrence-level platform-fee earning;
 * - withdrawals; and
 * - administrative ledger adjustments.
 *
 * IMPORTANT ARCHITECTURE
 *
 * One Transaction represents one WALLET-SIDE ledger movement.
 *
 * A Transaction does not need to describe every business component that
 * contributed to that wallet movement.
 *
 * PROFESSIONAL SETTLEMENT
 *
 * One weekly ShiftSettlementBatch may contain:
 *
 * - worked BASE pay;
 * - cancellation compensation;
 * - active-work cancellation compensation; and
 * - OVERTIME pay.
 *
 * The detailed component allocation remains authoritative in:
 *
 * - ShiftSettlementBatch.lines[].settlementComponent;
 * - ShiftSettlementBatch.lines[].earningType;
 * - ShiftSettlementBatch.releaseKeys;
 * - ShiftOccurrence.baseSettlement; and
 * - ShiftOccurrence.overtimeSettlement.
 *
 * Therefore the weekly batch produces only:
 *
 *   professional_payout
 *   → weekly_professional_payout
 *
 * Platform fees do NOT belong to ShiftSettlementBatch.
 *
 * PLATFORM FEES
 *
 * Platform fees are earned occurrence by occurrence.
 *
 * Base:
 *
 *   platform_fee
 *   → base_platform_fee_earned
 *
 * Overtime:
 *
 *   platform_fee
 *   → overtime_platform_fee_earned
 *
 * The base fee is earned when the occurrence first becomes part of a
 * successfully confirmed professional assignment.
 *
 * The overtime fee is earned when the final payable overtime obligation is
 * established.
 *
 * Once validly earned, neither fee is ordinarily reversed through the normal
 * claim, dispute, settlement or refund lifecycle.
 *
 * EMPLOYER REFUNDS
 *
 * Refunds have two execution shapes:
 *
 * 1. Direct Shift / occurrence refund
 *    - references Shift;
 *    - may reference ShiftOccurrence; and
 *    - uses an exact direct refund purpose.
 *
 * 2. Weekly EmployerRefundBatch execution
 *    - references EmployerRefundBatch;
 *    - references the exact embedded execution line; and
 *    - uses weekly_employer_refund.
 *
 * There is deliberately no generic "shift_refund" purpose.
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

/* ─────────────────────────────── TRANSACTION PURPOSES ─────────────────────────────── */

exports.TRANSACTION_PURPOSES = Object.freeze([
  // Employer wallet funding.
  "wallet_topup",

  // Protected Shift funding.
  "shift_base_funding",

  // Additional final approved overtime funding.
  "shift_overtime_topup",

  // Direct occurrence-level scheduled/base allocation refunds.
  "expired_unfilled_refund",

  "unused_occurrence_balance_refund",

  "cancelled_occurrence_refund",

  "confirmed_no_show_refund",

  "closed_occurrence_refund",

  // Parent Shift final protected-fund reconciliation.
  "final_shift_reconciliation_refund",

  // Weekly aggregated employer refund execution.
  "weekly_employer_refund",

  // Weekly aggregated professional settlement.
  "weekly_professional_payout",

  // Occurrence-level Loqum platform-fee earning.
  "base_platform_fee_earned",

  "overtime_platform_fee_earned",

  // Professional or employer bank withdrawal.
  "withdrawal",

  "withdrawal_reversal",

  // Other financial purposes.
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
 * Rails representing movement between Loqum-controlled wallets.
 */
exports.INTERNAL_PAYMENT_RAILS = Object.freeze([
  "wallet_balance",

  "internal_transfer",

  "platform_wallet",
]);

/**
 * Rails involving Paystack as the external provider.
 */
exports.PAYSTACK_PAYMENT_RAILS = Object.freeze([
  "paystack_checkout",

  "paystack_dva",

  "paystack_refund",

  "paystack_transfer",
]);

/**
 * Paystack operations represented through paystackReference.
 *
 * Paystack Transfer is excluded because it has its dedicated:
 *
 *   paystackTransferCode
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
 * Transaction types that inherently belong to one Shift.
 *
 * shift_refund is deliberately excluded because it may either:
 *
 * - directly reference one Shift; or
 * - belong to an EmployerRefundBatch that may aggregate several Shifts.
 *
 * professional_payout is excluded because professional payout now belongs
 * exclusively to ShiftSettlementBatch.
 *
 * platform_fee IS included because fee earning happens directly against the
 * specific Shift occurrence whose fee was earned.
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

/**
 * Only these transaction types may optionally trace back to a
 * ShiftAssignmentCase.
 */
exports.ASSIGNMENT_CASE_ALLOWED_TRANSACTION_TYPES = Object.freeze([
  "shift_refund",

  "dispute_refund",

  "cancellation_fee",
]);

/* ─────────────────────────────── SHIFT FUNDING ─────────────────────────────── */

exports.SHIFT_FUNDING_TRANSACTION_TYPES = Object.freeze(["shift_funding", "shift_topup"]);

/**
 * A Shift is funded entirely from:
 *
 * - employer wallet balance; or
 * - Paystack Checkout.
 *
 * Mixed Shift funding is not supported.
 */
exports.SHIFT_FUNDING_PAYMENT_RAILS = Object.freeze(["wallet_balance", "paystack_checkout"]);

/* ─────────────────────────────── PLATFORM FEES ─────────────────────────────── */

/**
 * Exact legal purpose for each occurrence-level Loqum fee.
 *
 * There is deliberately no generic platform-fee earning purpose because the
 * ledger must show whether the money was earned from:
 *
 * - the confirmed scheduled/base engagement; or
 * - the final established overtime obligation.
 */
exports.PLATFORM_FEE_PURPOSE_BY_COMPONENT = Object.freeze({
  base: "base_platform_fee_earned",

  overtime: "overtime_platform_fee_earned",
});

exports.PLATFORM_FEE_PURPOSES = Object.freeze(
  Object.values(exports.PLATFORM_FEE_PURPOSE_BY_COMPONENT)
);

/**
 * Earned platform fees move only between Loqum-controlled wallets:
 *
 * escrow → platform wallet.
 */
exports.PLATFORM_FEE_PAYMENT_RAILS = Object.freeze(["internal_transfer"]);

/* ─────────────────────────────── REFUND PURPOSES ─────────────────────────────── */

/**
 * Occurrence-specific refunds return unused scheduled/base allocation.
 *
 * An earned platform fee is excluded from ordinary employer refund
 * calculation.
 */
exports.OCCURRENCE_REFUND_PURPOSES = Object.freeze([
  "expired_unfilled_refund",

  "unused_occurrence_balance_refund",

  "cancelled_occurrence_refund",

  "confirmed_no_show_refund",

  "closed_occurrence_refund",
]);

/**
 * Parent Shift protected-fund reconciliation.
 *
 * This purpose is Shift-level rather than occurrence-level.
 */
exports.SHIFT_LEVEL_REFUND_PURPOSES = Object.freeze(["final_shift_reconciliation_refund"]);

/**
 * Refund purposes that may be represented directly against one Shift.
 */
exports.DIRECT_SHIFT_REFUND_PURPOSES = Object.freeze([
  ...exports.OCCURRENCE_REFUND_PURPOSES,

  ...exports.SHIFT_LEVEL_REFUND_PURPOSES,
]);

/**
 * Purpose used when EmployerRefundBatch aggregates employer refund execution.
 */
exports.EMPLOYER_REFUND_BATCH_PURPOSES = Object.freeze(["weekly_employer_refund"]);

/**
 * Every valid purpose for:
 *
 *   type: "shift_refund"
 *
 * There is deliberately no generic "shift_refund" purpose.
 */
exports.SHIFT_REFUND_PURPOSES = Object.freeze([
  ...exports.DIRECT_SHIFT_REFUND_PURPOSES,

  ...exports.EMPLOYER_REFUND_BATCH_PURPOSES,
]);

/* ─────────────────────────────── REFUND PAYMENT RAILS ─────────────────────────────── */

/**
 * All rails technically available to shift_refund.
 *
 * Direct Shift refunds have tighter model rules:
 *
 * - internal_transfer; or
 * - paystack_refund.
 *
 * paystack_transfer is reserved for the EmployerRefundBatch fallback route.
 */
exports.SHIFT_REFUND_PAYMENT_RAILS = Object.freeze([
  "internal_transfer",

  "paystack_refund",

  "paystack_transfer",
]);

/**
 * Weekly EmployerRefundBatch lines may execute through:
 *
 * - internal wallet transfer;
 * - original Paystack refund route; or
 * - Paystack Transfer fallback.
 */
exports.EMPLOYER_REFUND_BATCH_PAYMENT_RAILS = Object.freeze([
  "internal_transfer",

  "paystack_refund",

  "paystack_transfer",
]);

/* ─────────────────────────────── EMPLOYER REFUND BATCH ─────────────────────────────── */

/**
 * EmployerRefundBatch currently produces shift_refund ledger movements.
 */
exports.EMPLOYER_REFUND_BATCH_TRANSACTION_TYPES = Object.freeze(["shift_refund"]);

exports.EMPLOYER_REFUND_BATCH_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  shift_refund: "weekly_employer_refund",
});

/* ─────────────────────────────── PROFESSIONAL SETTLEMENT BATCH ─────────────────────────────── */

/**
 * ShiftSettlementBatch exists only to release professional earnings.
 *
 * Platform fees are intentionally excluded because their earning/collection
 * lifecycle is occurrence-level and independent of weekly professional
 * settlement.
 */
exports.SETTLEMENT_BATCH_TRANSACTION_TYPES = Object.freeze(["professional_payout"]);

/**
 * One aggregated weekly ShiftSettlementBatch may contain both BASE and
 * OVERTIME professional settlement lines.
 *
 * Therefore the resulting professional wallet transaction is intentionally
 * component-neutral.
 */
exports.SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  professional_payout: "weekly_professional_payout",
});

exports.SETTLEMENT_BATCH_PURPOSES = Object.freeze(
  Object.values(exports.SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE)
);

/* ─────────────────────────────── REQUIRED PURPOSES ─────────────────────────────── */

/**
 * Transaction types with exactly one legal purpose regardless of caller.
 *
 * shift_refund is excluded because its legal purpose depends on whether it is:
 *
 * - a direct Shift/occurrence refund; or
 * - an EmployerRefundBatch execution.
 *
 * platform_fee is also excluded because its legal purpose depends on the
 * occurrence fee component:
 *
 * - base_platform_fee_earned; or
 * - overtime_platform_fee_earned.
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
 * Paystack Transfer is currently allowed only for:
 *
 * - bank withdrawals; and
 * - EmployerRefundBatch fallback refunds.
 *
 * Transaction model validation further restricts shift_refund +
 * paystack_transfer to EmployerRefundBatch.
 */
exports.PAYSTACK_TRANSFER_ALLOWED_TRANSACTION_TYPES = Object.freeze(["withdrawal", "shift_refund"]);
