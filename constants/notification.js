// constants/notification.js

/* ------------------------------- CATEGORIES ------------------------------- */

exports.NOTIFICATION_CATEGORIES = Object.freeze(["finance", "shift", "team", "account", "system"]);

/* ------------------------------- STATUSES ------------------------------- */

exports.NOTIFICATION_STATUSES = Object.freeze(["unread", "read", "archived"]);

/* ------------------------------- FINANCE TYPES ------------------------------- */

exports.FINANCE_NOTIFICATION_TYPES = Object.freeze([
  // Employer wallet
  "wallet_funded",
  "withdrawal_submitted",
  "withdrawal_completed",
  "withdrawal_reversed",

  // Overtime funding
  "overtime_top_up_required",
  "overtime_top_up_completed",

  // Employer refunds
  "employer_refund_held",
  "employer_refund_eligible",
  "employer_refund_processing",
  "employer_refund_completed",

  // Professional payout
  "professional_payout_ready",
  "professional_payout_processing",
  "professional_payout_completed",
]);

/* ------------------------------- SHIFT TYPES ------------------------------- */

exports.SHIFT_NOTIFICATION_TYPES = Object.freeze([
  // Parent Shift
  "shift_created",
  "shift_approved",
  "shift_cancelled",
  "shift_filled",
  "payment_required",

  // Occurrence lifecycle
  "shift_occurrence_cancelled",
  "shift_occurrence_active_work_cancelled",
  "shift_occurrence_replacement_required",
  "shift_occurrence_replacement_filled",

  // Professional claims
  "professional_claim_submitted",
  "professional_claim_issue_approved",
  "professional_claim_issue_rejected",
  "professional_claim_issue_admin_review_required",
  "professional_claim_issue_resolved",

  // Employer disputes
  "employer_dispute_submitted",
  "employer_dispute_professional_response_submitted",
  "employer_dispute_professional_response_expired",
  "employer_dispute_issue_admin_review_required",
  "employer_dispute_issue_resolved",

  // Overtime
  "overtime_submitted",
  "overtime_approved",
  "overtime_rejected",
  "overtime_admin_review_required",
  "overtime_resolved",
]);

/* ------------------------------- TEAM TYPES ------------------------------- */

exports.TEAM_NOTIFICATION_TYPES = Object.freeze([
  "team_invite_received",
  "team_invite_accepted",
  "team_member_removed",
  "team_role_changed",
]);

/* ------------------------------- ACCOUNT TYPES ------------------------------- */

exports.ACCOUNT_NOTIFICATION_TYPES = Object.freeze(["account_updated", "security_alert"]);

/* ------------------------------- SYSTEM TYPES ------------------------------- */

exports.SYSTEM_NOTIFICATION_TYPES = Object.freeze(["system_message"]);

/* ------------------------------- ALL TYPES ------------------------------- */

exports.NOTIFICATION_TYPES = Object.freeze([
  ...exports.FINANCE_NOTIFICATION_TYPES,
  ...exports.SHIFT_NOTIFICATION_TYPES,
  ...exports.TEAM_NOTIFICATION_TYPES,
  ...exports.ACCOUNT_NOTIFICATION_TYPES,
  ...exports.SYSTEM_NOTIFICATION_TYPES,
]);

/* ------------------------------- CATEGORY / TYPE CONTRACT ------------------------------- */

/**
 * Notification category is presentation grouping.
 * Notification type identifies the lifecycle event.
 */
exports.NOTIFICATION_TYPES_BY_CATEGORY = Object.freeze({
  finance: exports.FINANCE_NOTIFICATION_TYPES,
  shift: exports.SHIFT_NOTIFICATION_TYPES,
  team: exports.TEAM_NOTIFICATION_TYPES,
  account: exports.ACCOUNT_NOTIFICATION_TYPES,
  system: exports.SYSTEM_NOTIFICATION_TYPES,
});
