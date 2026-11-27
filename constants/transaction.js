// constants/transaction.js

/* ---------- LIMITS ---------- */

exports.MAX_TRANSACTION_FAILURE_REASON_LENGTH = 500;
exports.MAX_TRANSACTION_REVERSAL_REASON_LENGTH = 500;
exports.MAX_TRANSACTION_CANCELLATION_REASON_LENGTH = 500;
exports.MAX_TRANSACTION_DESCRIPTION_LENGTH = 500;

/* ---------- TRANSACTION TYPES ---------- */

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
  "job_publication_purchase",
  "subscription_payment",
  "credit_purchase",
]);

/* ---------- TRANSACTION PURPOSES ---------- */

exports.TRANSACTION_PURPOSES = Object.freeze([
  "wallet_topup",
  "shift_base_funding",
  "shift_overtime_topup",
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
  "job_publication_purchase",
  "subscription_payment",
  "withdrawal",
  "withdrawal_reversal",
  "cancellation_fee",
  "dispute_resolution",
  "admin_adjustment",
  "credit_purchase",
  null,
]);

/* ---------- STATUSES ---------- */

exports.TRANSACTION_STATUSES = Object.freeze([
  "pending",
  "processing",
  "completed",
  "failed",
  "reversed",
  "cancelled",
]);

/* ---------- DIRECTIONS ---------- */

exports.TRANSACTION_DIRECTIONS = Object.freeze(["credit", "debit"]);

/* ---------- PROVIDERS ---------- */

exports.TRANSACTION_PROVIDERS = Object.freeze(["paystack", "internal", "manual", null]);

/* ---------- PAYMENT RAILS ---------- */

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

exports.INTERNAL_PAYMENT_RAILS = Object.freeze([
  "wallet_balance",
  "internal_transfer",
  "platform_wallet",
]);

exports.PAYSTACK_PAYMENT_RAILS = Object.freeze([
  "paystack_checkout",
  "paystack_dva",
  "paystack_refund",
  "paystack_transfer",
]);

exports.PAYSTACK_PAYMENT_REFERENCE_RAILS = Object.freeze([
  "paystack_checkout",
  "paystack_dva",
  "paystack_refund",
]);

/* ---------- PAYSTACK STATUSES ---------- */

exports.PAYSTACK_TRANSACTION_STATUSES = Object.freeze([
  "pending",
  "success",
  "failed",
  "reversed",
  null,
]);

/* ---------- INITIATOR ROLES ---------- */

exports.TRANSACTION_INITIATOR_ROLES = Object.freeze([
  "system",
  "employer",
  "professional",
  "admin",
]);

/* ---------- DIRECT SHIFT TRANSACTIONS ---------- */

exports.DIRECT_SHIFT_TRANSACTION_TYPES = Object.freeze([
  "shift_funding",
  "shift_topup",
  "platform_fee",
  "outstanding_charge",
  "outstanding_settlement",
  "dispute_refund",
  "cancellation_fee",
]);

/* ---------- ASSIGNMENT CASE TRANSACTIONS ---------- */

exports.ASSIGNMENT_CASE_ALLOWED_TRANSACTION_TYPES = Object.freeze([
  "shift_refund",
  "dispute_refund",
  "cancellation_fee",
]);

/* ---------- SHIFT FUNDING ---------- */

exports.SHIFT_FUNDING_TRANSACTION_TYPES = Object.freeze(["shift_funding", "shift_topup"]);

exports.SHIFT_FUNDING_PAYMENT_RAILS = Object.freeze(["wallet_balance", "paystack_checkout"]);

/* ---------- PLATFORM FEES ---------- */

exports.PLATFORM_FEE_PURPOSE_BY_COMPONENT = Object.freeze({
  base: "base_platform_fee_earned",
  overtime: "overtime_platform_fee_earned",
});

exports.PLATFORM_FEE_PURPOSES = Object.freeze(
  Object.values(exports.PLATFORM_FEE_PURPOSE_BY_COMPONENT)
);

exports.PLATFORM_FEE_PAYMENT_RAILS = Object.freeze(["internal_transfer"]);

/* ---------- REFUND PURPOSES ---------- */

exports.OCCURRENCE_REFUND_PURPOSES = Object.freeze([
  "expired_unfilled_refund",
  "unused_occurrence_balance_refund",
  "cancelled_occurrence_refund",
  "confirmed_no_show_refund",
  "closed_occurrence_refund",
]);

exports.SHIFT_LEVEL_REFUND_PURPOSES = Object.freeze(["final_shift_reconciliation_refund"]);

exports.DIRECT_SHIFT_REFUND_PURPOSES = Object.freeze([
  ...exports.OCCURRENCE_REFUND_PURPOSES,
  ...exports.SHIFT_LEVEL_REFUND_PURPOSES,
]);

exports.EMPLOYER_REFUND_BATCH_PURPOSES = Object.freeze(["weekly_employer_refund"]);

exports.SHIFT_REFUND_PURPOSES = Object.freeze([
  ...exports.DIRECT_SHIFT_REFUND_PURPOSES,
  ...exports.EMPLOYER_REFUND_BATCH_PURPOSES,
]);

/* ---------- REFUND PAYMENT RAILS ---------- */

exports.SHIFT_REFUND_PAYMENT_RAILS = Object.freeze(["internal_transfer", "paystack_refund"]);

exports.EMPLOYER_REFUND_BATCH_PAYMENT_RAILS = Object.freeze([
  "internal_transfer",
  "paystack_refund",
]);

/* ---------- EMPLOYER REFUND BATCH ---------- */

exports.EMPLOYER_REFUND_BATCH_TRANSACTION_TYPES = Object.freeze(["shift_refund"]);

exports.EMPLOYER_REFUND_BATCH_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  shift_refund: "weekly_employer_refund",
});

/* ---------- PROFESSIONAL SETTLEMENT BATCH ---------- */

exports.SETTLEMENT_BATCH_TRANSACTION_TYPES = Object.freeze(["professional_payout"]);

exports.SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  professional_payout: "weekly_professional_payout",
});

exports.SETTLEMENT_BATCH_PURPOSES = Object.freeze(
  Object.values(exports.SETTLEMENT_BATCH_PURPOSE_BY_TRANSACTION_TYPE)
);

/* ---------- REQUIRED PURPOSES ---------- */

exports.REQUIRED_PURPOSE_BY_TRANSACTION_TYPE = Object.freeze({
  wallet_funding: "wallet_topup",
  shift_funding: "shift_base_funding",
  shift_topup: "shift_overtime_topup",
  professional_payout: "weekly_professional_payout",
  job_publication_purchase: "job_publication_purchase",
  subscription_payment: "subscription_payment",
  withdrawal: "withdrawal",
  withdrawal_reversal: "withdrawal_reversal",
  dispute_refund: "dispute_resolution",
  cancellation_fee: "cancellation_fee",
  adjustment: "admin_adjustment",
  credit_purchase: "credit_purchase",
});

/* ---------- PAYSTACK TRANSFER ---------- */

exports.PAYSTACK_TRANSFER_ALLOWED_TRANSACTION_TYPES = Object.freeze(["withdrawal"]);

/* ---------- CHECKOUT QUERY UPDATE POLICY ---------- */

exports.CHECKOUT_QUERY_UPDATE_FIELDS = Object.freeze([
  "paystackStatus",

  "metadata.authorizationUrl",
  "metadata.accessCode",
  "metadata.paystackMode",
  "metadata.checkoutInitializedAt",

  "metadata.checkoutInitializationUncertainAt",
  "metadata.checkoutInitializationError",
  "metadata.checkoutInitializationErrorCode",

  "metadata.fundingApplicationPending",
  "metadata.fundingIntegrityConflict",
  "metadata.fundingIntegrityReason",
  "metadata.fundingIntegrityDetectedAt",
  "metadata.fundingApplicationLastErrorAt",
  "metadata.fundingApplicationLastErrorCode",
  "metadata.fundingApplicationLastErrorMessage",

  "metadata.appliedToOvertimeTopUp",
  "metadata.appliedToOvertimeTopUpAt",
  "metadata.overtimeFundingIntegrityConflict",
  "metadata.overtimeFundingIntegrityReason",
  "metadata.authoritativeTopUpTransactionId",

  "metadata.authorizationChargeRequestedAt",
  "metadata.authorizationChargeProviderStatus",
  "metadata.authorizationChargeReferenceMismatchAt",
  "metadata.authorizationChargeReturnedReference",
  "metadata.authorizationChargeUncertainAt",
  "metadata.authorizationChargeError",
  "metadata.authorizationChargeErrorCode",

  "updatedAt",
]);

/* ---------- PROTECTED FINANCIAL TRANSACTIONS ---------- */

exports.PROTECTED_FINANCIAL_TRANSACTION_TYPES = Object.freeze([
  "withdrawal",
  "withdrawal_reversal",
  "wallet_funding",
]);

/* ---------- WITHDRAWAL STATUS TRANSITIONS ---------- */

exports.WITHDRAWAL_STATUS_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["pending", "processing", "cancelled"]),

  processing: Object.freeze(["processing", "completed", "failed"]),

  completed: Object.freeze(["completed", "reversed"]),

  failed: Object.freeze(["failed"]),

  reversed: Object.freeze(["reversed"]),

  cancelled: Object.freeze(["cancelled"]),
});

/* ---------- FINANCIAL IDENTITY PROTECTION ---------- */

exports.PROTECTED_FINANCIAL_IDENTITY_FIELDS = Object.freeze([
  "reference",
  "groupReference",
  "wallet",
  "bankAccount",
  "dva",
  "relatedTransaction",
  "counterpartyWallet",
  "type",
  "purpose",
  "direction",
  "provider",
  "paymentRail",
  "countryCode",
  "currency",
  "amount",
  "providerFee",
  "netAmount",
  "paystackReference",
  "shift",
  "shiftOccurrence",
  "assignmentCase",
  "shiftApplication",
  "settlementBatch",
  "employerRefundBatch",
  "employerRefundBatchLineId",
  "dispute",
  "initiatedBy.role",
  "initiatedBy.userId",
]);

/* ---------- WITHDRAWAL OWNER IDENTITY ---------- */

exports.WITHDRAWAL_OWNER_METADATA_FIELDS = Object.freeze([
  "ownerType",
  "employerProfileId",
  "professionalProfileId",
  "recipientUserId",
  "bankAccountId",
  "requestReference",
]);

/* ---------- WITHDRAWAL PROVIDER IDENTITY ---------- */

exports.WITHDRAWAL_PROVIDER_METADATA_FIELDS = Object.freeze([
  "paystackMode",
  "paystackRecipientCode",
  "paystackTransferReason",
]);

/* ---------- WITHDRAWAL REVERSAL DISPOSITION ---------- */

exports.WITHDRAWAL_DISPOSITION_METADATA_FIELDS = Object.freeze([
  "providerReversalDisposition",
  "providerReversalStatus",
  "providerReversalVerifiedAt",
  "financialObligationId",
  "reversalTransactionId",
]);
