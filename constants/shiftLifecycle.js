// constants/shiftLifecycle.js

const { MAX_SHIFT_OCCURRENCES, MINUTES_PER_DAY } = require("./shiftPosting");

const { MAX_APPLICATION_ROUNDS } = require("./shiftApplication");

/**
 * Compatibility exports for existing consumers.
 *
 * MAX_SHIFT_OCCURRENCES limits shared work dates per slot.
 * Total occurrence records equal occurrenceCount × requiredProfessionals.
 *
 * MAX_APPLICATION_ROUNDS applies to application rounds within their
 * hiring scope. Replacement hiring does not advance the parent's
 * initial application round.
 */
exports.MAX_SHIFT_OCCURRENCES = MAX_SHIFT_OCCURRENCES;

exports.MAX_APPLICATION_ROUNDS = MAX_APPLICATION_ROUNDS;

exports.MINUTES_PER_DAY = MINUTES_PER_DAY;

/* ─────────────────────────────── PARENT SHIFT ─────────────────────────────── */

/**
 * Parent statuses summarize the engagement across all professional slots.
 *
 * open may coexist with occupied slots while initial vacancies remain.
 * Assignment ownership and operational facts belong to assignments
 * and occurrences.
 */
exports.SHIFT_STATUSES = Object.freeze([
  "pending_funding",
  "open",
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "completed",
  "cancelled",
  "disputed",
  "no_show",
]);

exports.SHIFT_PAYMENT_STATUSES = Object.freeze([
  "unpaid",
  "funded",
  "release_pending",
  "partially_released",
  "awaiting_overtime_review",
  "awaiting_topup",
  "released",
  "failed",
  "refunded",
  "partially_refunded",
]);

/**
 * These statuses require assignment context during reconciliation.
 *
 * This does not identify a single parent assignment.
 * An open Shift may also contain assignments, but may legitimately
 * have none before its first acceptance.
 */
exports.SHIFT_ASSIGNMENT_SUMMARY_REQUIRED_STATUSES = Object.freeze([
  "assigned",
  "confirmed",
  "in_progress",
]);

exports.SHIFT_PUBLISHED_PAYMENT_STATUSES = Object.freeze([
  "funded",
  "release_pending",
  "partially_released",
  "awaiting_overtime_review",
  "awaiting_topup",
  "released",
  "refunded",
  "partially_refunded",
  "failed",
]);

/**
 * Payment states compatible with completed engagement reconciliation.
 *
 * A listed payment state alone does not establish completion.
 * In particular, partially_refunded may also describe an engagement
 * that still has unresolved occurrence workflows.
 */
exports.SHIFT_FINAL_PAYMENT_STATUSES = Object.freeze([
  "released",
  "refunded",
  "partially_refunded",
]);

/**
 * Occupied slots may have payment activity while initial vacancies remain.
 *
 * Match the Shift model's open-state payment guard:
 * published payment states except fully released or fully refunded.
 *
 * Membership does not authorize hiring or prove sufficient funding.
 * Services must still verify the protected allocation for the target slot.
 */
exports.SHIFT_OPEN_PAYMENT_STATUSES = Object.freeze(
  exports.SHIFT_PUBLISHED_PAYMENT_STATUSES.filter(
    (status) => !["released", "refunded"].includes(status)
  )
);

exports.SHIFT_CANCELLABLE_FROM_STATUSES = Object.freeze([
  "pending_funding",
  "open",
  "assigned",
  "confirmed",
  "in_progress",
]);

/* ─────────────────────────────── OCCURRENCE ASSIGNMENT ─────────────────────────────── */

/**
 * Assignment state belongs to one slot on one work date.
 *
 * Replacing a professional preserves that occurrence's slot, schedule,
 * identity and funded allocation.
 */
exports.OCCURRENCE_ASSIGNMENT_STATUSES = Object.freeze([
  "unassigned",
  "assigned",
  "replacement_required",
  "expired_unfilled",
]);

exports.EXPIRED_FROM_ASSIGNMENT_STATUSES = Object.freeze(["unassigned", "replacement_required"]);

/* ─────────────────────────────── OCCURRENCE STATUS ─────────────────────────────── */

exports.OCCURRENCE_STATUSES = Object.freeze([
  "scheduled",
  "in_progress",
  "pending_settlement",
  "completed",
  "cancelled",
  "no_show",
  "expired_unfilled",
  "disputed",
]);

exports.OCCURRENCE_STATUSES_REQUIRING_ASSIGNMENT = Object.freeze([
  "in_progress",
  "pending_settlement",
  "completed",
  "no_show",
  "disputed",
]);

/**
 * Operational terminal states do not by themselves establish that
 * claims, professional payouts and employer refunds have finished.
 */
exports.TERMINAL_OCCURRENCE_STATUSES = Object.freeze([
  "completed",
  "cancelled",
  "no_show",
  "expired_unfilled",
]);

/* ─────────────────────────────── ATTENDANCE ─────────────────────────────── */

/**
 * Attendance is independent for every professional occurrence.
 */
exports.ATTENDANCE_STATUSES = Object.freeze([
  "not_started",
  "checked_in",
  "checked_out",
  "missed_checkin_review",
  "checkout_fallback_review",
  "no_show",
  "disputed",
  "settled",
]);

exports.ATTENDANCE_STATUSES_REQUIRING_ASSIGNMENT = Object.freeze([
  "checked_in",
  "checked_out",
  "missed_checkin_review",
  "checkout_fallback_review",
  "no_show",
  "disputed",
  "settled",
]);

exports.ATTENDANCE_OVERRIDE_TYPES = Object.freeze(["checkin", "checkout", "both"]);

exports.ATTENDANCE_OVERRIDE_REASONS = Object.freeze([
  "branch_location_incorrect",
  "gps_accuracy_issue",
  "location_permission_issue",
  "network_issue",
  "employer_confirmed_presence",
  "admin_confirmed_presence",
  "system_error",
  "other",
]);

exports.LATE_CHECKOUT_OPTIONS = Object.freeze(["normal_late_checkout", "overtime_requested"]);

/**
 * Worked overtime belongs to the dedicated OT lifecycle.
 */
exports.LATE_CHECKOUT_REASONS = Object.freeze(["forgot_to_checkout", "system_issue", "other"]);

exports.CHECKOUT_FALLBACK_REASONS = Object.freeze([
  "professional_forgot",
  "system_timeout",
  "outside_geofence",
  "gps_accuracy_too_low",
  "location_permission_denied",
  "employer_confirmed",
  "admin_override",
  "other",
]);

exports.MISSED_CHECKIN_REASONS = Object.freeze([
  "forgot_to_checkin",
  "outside_geofence",
  "gps_accuracy_too_low",
  "location_permission_denied",
  "branch_location_incorrect",
  "network_issue",
  "system_error",
  "other",
]);

exports.MISSED_CHECKIN_OUTCOMES = Object.freeze(["approved", "rejected"]);

/* ─────────────────────────────── PROFESSIONAL POST-SHIFT REVIEW ─────────────────────────────── */

/**
 * OT routes to the OT lifecycle.
 * All other selections belong to one immutable ordinary claim case.
 *
 * The review concerns the professional's own occurrence.
 * Submission does not close its shared challenge window early.
 */
exports.PROFESSIONAL_REVIEW_SELECTION_TYPES = Object.freeze([
  "overtime",
  "attendance_correction",
  "payment_calculation",
  "employer_fault",
]);

/* ─────────────────────────────── OCCURRENCE CLAIMS ─────────────────────────────── */

/**
 * One professional claim case may contain multiple immutable ordinary issues.
 * OT is excluded.
 *
 * Claim ownership is scoped to the occurrence and its professional assignment.
 */
exports.OCCURRENCE_CLAIM_TYPES = Object.freeze([
  "attendance_correction",
  "payment_calculation",
  "employer_fault",
]);

exports.FINANCIAL_OCCURRENCE_CLAIM_TYPES = Object.freeze([
  "attendance_correction",
  "payment_calculation",
  "employer_fault",
]);

/**
 * Case status is coarse. Individual issues own workflow state.
 */
exports.OCCURRENCE_CLAIM_STATUSES = Object.freeze(["active", "resolved", "withdrawn"]);

exports.ACTIVE_OCCURRENCE_CLAIM_STATUSES = Object.freeze(["active"]);

exports.FINAL_OCCURRENCE_CLAIM_STATUSES = Object.freeze(["resolved", "withdrawn"]);

exports.OCCURRENCE_CLAIM_ISSUE_STATUSES = Object.freeze([
  "awaiting_employer_review",
  "awaiting_admin_review",
  "resolved",
]);

exports.ACTIVE_OCCURRENCE_CLAIM_ISSUE_STATUSES = Object.freeze([
  "awaiting_employer_review",
  "awaiting_admin_review",
]);

exports.FINAL_OCCURRENCE_CLAIM_ISSUE_STATUSES = Object.freeze(["resolved"]);

exports.OCCURRENCE_CLAIM_ISSUE_STATUSES_REQUIRING_EMPLOYER_ACTION = Object.freeze([
  "awaiting_employer_review",
]);

exports.OCCURRENCE_CLAIM_ISSUE_STATUSES_REQUIRING_ADMIN_ACTION = Object.freeze([
  "awaiting_admin_review",
]);

/**
 * Employer provides a position on each professional claim issue.
 *
 * approved:
 * Employer accepts the professional position.
 *
 * rejected:
 * Employer disagrees and may provide supporting evidence and an
 * alternative factual position. Disagreement proceeds to admin review.
 */
exports.EMPLOYER_FINANCIAL_CLAIM_DECISIONS = Object.freeze(["approved", "rejected"]);

/**
 * Admin may accept either party, maintain current authority, or establish
 * an evidence-supported adjusted outcome.
 *
 * Financial adjudication does not change the earned BASE platform fee.
 */
exports.ADMIN_FINANCIAL_CLAIM_DECISIONS = Object.freeze([
  "approve_professional",
  "approve_employer",
  "maintain_current",
  "adjusted",
]);

exports.OCCURRENCE_CLAIM_ADMIN_REVIEW_REASONS = Object.freeze([
  "employer_disagreement",
  "employer_non_response",
]);

/* ─────────────────────────────── OCCURRENCE EVIDENCE ─────────────────────────────── */

exports.OCCURRENCE_EVIDENCE_TYPES = Object.freeze([
  "image",
  "video",
  "document",
  "screenshot",
  "message",
  "attendance_record",
  "other",
]);

exports.OCCURRENCE_EVIDENCE_SUBMITTER_ROLES = Object.freeze(["professional", "employer", "admin"]);

/* ─────────────────────────────── EMPLOYER OCCURRENCE DISPUTES ─────────────────────────────── */

/**
 * One employer dispute case may contain multiple immutable BASE/factual issues.
 * OT is excluded.
 *
 * A dispute targets one professional occurrence, not every professional
 * working the same Shift date.
 */
exports.EMPLOYER_OCCURRENCE_DISPUTE_TYPES = Object.freeze([
  "attendance_correction",
  "payment_calculation",
  "other_financial_fact",
]);

/**
 * Case status is coarse. Individual issues own workflow state.
 */
exports.EMPLOYER_OCCURRENCE_DISPUTE_STATUSES = Object.freeze(["active", "resolved", "withdrawn"]);

exports.ACTIVE_EMPLOYER_OCCURRENCE_DISPUTE_STATUSES = Object.freeze(["active"]);

exports.FINAL_EMPLOYER_OCCURRENCE_DISPUTE_STATUSES = Object.freeze(["resolved", "withdrawn"]);

exports.EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES = Object.freeze([
  "awaiting_professional_response",
  "awaiting_admin_review",
  "resolved",
]);

exports.ACTIVE_EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES = Object.freeze([
  "awaiting_professional_response",
  "awaiting_admin_review",
]);

exports.FINAL_EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES = Object.freeze(["resolved"]);

exports.EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES_REQUIRING_PROFESSIONAL_ACTION = Object.freeze([
  "awaiting_professional_response",
]);

exports.EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES_REQUIRING_ADMIN_ACTION = Object.freeze([
  "awaiting_admin_review",
]);

/**
 * approved:
 * The employer established that current Loqum authority requires correction.
 * Admin records the final evidence-supported fact/value.
 *
 * rejected:
 * Current Loqum authority remains unchanged.
 */
exports.ADMIN_EMPLOYER_OCCURRENCE_DISPUTE_DECISIONS = Object.freeze(["approved", "rejected"]);

/* ─────────────────────────────── SETTLEMENT ─────────────────────────────── */

/**
 * Settlement is evaluated independently for each professional occurrence.
 * BASE and OT retain separate professional payout components.
 * Platform-fee collection has its own audit.
 */
exports.SETTLEMENT_STATUSES = Object.freeze([
  "not_due",
  "pending_review",
  "awaiting_overtime_review",
  "awaiting_topup",
  "approved_for_release",
  "release_pending",
  "released",
  "disputed",
]);

exports.SETTLEMENT_STATUSES_REQUIRING_ASSIGNMENT = Object.freeze([
  "pending_review",
  "awaiting_overtime_review",
  "awaiting_topup",
  "approved_for_release",
  "release_pending",
  "released",
  "disputed",
]);

exports.SETTLEMENT_STATUSES_REQUIRING_FINAL_PRICING = Object.freeze([
  "awaiting_topup",
  "approved_for_release",
  "release_pending",
  "released",
]);

exports.CANCELLATION_COMPENSATION_SETTLEMENT_STATUSES = Object.freeze([
  "pending_review",
  "approved_for_release",
  "release_pending",
  "released",
  "disputed",
]);

/**
 * Professional payout release authority.
 */
exports.SETTLEMENT_APPROVAL_SOURCES = Object.freeze(["automatic", "admin", "dispute_resolution"]);

/* ─────────────────────────────── REFUNDS ─────────────────────────────── */

exports.REFUND_STATUSES = Object.freeze([
  "not_eligible",
  "held",
  "eligible",
  "batched",
  "processing",
  "refunded",
]);

exports.ACTIVE_REFUND_STATUSES = Object.freeze(["held", "eligible", "batched", "processing"]);

exports.REFUND_STATUSES_REQUIRING_AMOUNT = Object.freeze([
  "held",
  "eligible",
  "batched",
  "processing",
  "refunded",
]);

exports.REFUND_STATUSES_AWAITING_EXECUTION = Object.freeze(["eligible", "batched"]);

exports.REFUND_EXECUTION_STATUSES = Object.freeze(["batched", "processing", "refunded"]);

/**
 * BASE refund holds remain while that occurrence's BASE is challengeable,
 * challenged, or awaiting professional payout.
 *
 * OT-only state does not hold BASE refunds.
 * Another slot's unresolved workflow does not automatically hold this
 * occurrence's refund.
 */
exports.REFUND_HOLD_REASONS = Object.freeze([
  "attendance_review_pending",
  "challenge_window_open",
  "professional_claim_pending",
  "employer_dispute_pending",
  "professional_settlement_pending",
  "manual_review",
  "other",
]);

exports.REFUND_REASONS = Object.freeze([
  "expired_unfilled",
  "unused_scheduled_time",
  "occurrence_cancelled",
  "confirmed_no_show",
  "engagement_closed",
  "dispute_resolution",
  "other",
]);

/**
 * Refund-domain funding values.
 *
 * Shift fundingMethod "wallet" maps to refund fundingMethod "wallet_balance".
 * Each Shift retains one original funding source; mixed funding is unsupported.
 */
exports.EMPLOYER_REFUND_FUNDING_METHODS = Object.freeze(["wallet_balance", "paystack_checkout"]);

exports.EMPLOYER_REFUND_EXECUTION_METHODS = Object.freeze([
  "wallet_balance",
  "paystack_refund",
  "paystack_transfer",
]);

exports.EMPLOYER_REFUND_BATCH_EXECUTION_METHODS = Object.freeze([
  "wallet_balance",
  "paystack_refund",
]);

exports.PAYSTACK_REFUND_STATUSES = Object.freeze([
  "not_started",
  "pending",
  "processing",
  "needs_attention",
  "processed",
  "failed",
]);

/* ─────────────────────────────── REPLACEMENT HIRING ─────────────────────────────── */

/**
 * Replacement lifecycle state belongs to its own hiring scope.
 *
 * Separate slots may have independent replacement opportunities.
 * Initial hiring may remain open at the same time.
 *
 * These lifecycle values include outcome history. The application
 * constants' OPEN/CLOSED object remains a separate eligibility interface.
 */
exports.REPLACEMENT_HIRING_STATUSES = Object.freeze(["closed", "open", "filled", "cancelled"]);

exports.ACTIVE_REPLACEMENT_HIRING_STATUSES = Object.freeze(["open"]);

exports.REPLACEMENT_HIRING_CONTEXT_STATUSES = Object.freeze(["open", "filled", "cancelled"]);

exports.REPLACEMENT_REASON_CODES = Object.freeze([
  "unavailable",
  "release_request",
  "health_emergency",
  "schedule_conflict",
  "attendance_issue",
  "unreachable",
  "conduct_concern",
  "licence_issue",
  "mutual_agreement",
  "other",
]);

exports.REPLACEMENT_REASON_CODES_REQUIRING_DETAILS = Object.freeze([
  "attendance_issue",
  "unreachable",
  "conduct_concern",
  "licence_issue",
  "other",
]);

/* ─────────────────────────────── OVERTIME ─────────────────────────────── */

exports.OVERTIME_SOURCES = Object.freeze(["late_checkout_prompt", "manual_request"]);

/**
 * The professional requests OT for their own occurrence.
 *
 * Employer approval is final.
 * Employer rejection/non-response moves unresolved OT to admin.
 * Final rejected status requires admin authority.
 */
exports.OVERTIME_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "disputed",
  "cancelled",
]);

exports.OVERTIME_DECISION_SOURCES = Object.freeze(["employer", "admin"]);

exports.OVERTIME_REJECTION_BASES = Object.freeze([
  "overtime_not_worked",
  "minutes_incorrect",
  "remained_on_site_not_working",
  "worked_without_authorization",
  "attendance_record_incorrect",
  "other",
]);

exports.OVERTIME_ADMIN_REVIEW_REASONS = Object.freeze([
  "employer_rejection",
  "employer_non_response",
]);

/**
 * Admin may establish the final approved OT minutes from the evidence.
 */
exports.OVERTIME_ADMIN_DECISIONS = Object.freeze(["approved", "rejected"]);

/* ─────────────────────────────── CANCELLATION ─────────────────────────────── */

exports.CANCELLATION_ACTORS = Object.freeze(["employer", "system", "admin"]);

exports.USER_CANCELLATION_ACTORS = Object.freeze(["employer", "admin"]);

exports.ACTIVE_WORK_CANCELLATION_INITIATORS = Object.freeze(["employer", "admin"]);

exports.OCCURRENCE_CANCELLABLE_FROM_STATUSES = Object.freeze(["scheduled"]);

exports.OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES = Object.freeze([
  "unassigned",
  "assigned",
  "replacement_required",
]);

/**
 * Selective occurrence cancellation excludes replacement_required.
 *
 * Select one occurrence by its identity or complete slot/date key.
 * A shared Shift date can contain multiple professional occurrences.
 */
exports.INDIVIDUAL_OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES = Object.freeze([
  "unassigned",
  "assigned",
]);

exports.INDIVIDUAL_OCCURRENCE_CANCELLATION_ACTORS = Object.freeze(["employer", "admin"]);

const COMMON_CANCELLATION_CODES = Object.freeze([
  "funding_deadline_passed",
  "employer_cancelled",
  "late_employer_cancellation",
  "admin_cancelled",
  "system_cancelled",
  "branch_unavailable",
  "compliance_issue",
  "other",
]);

exports.COMMON_CANCELLATION_CODES = COMMON_CANCELLATION_CODES;

exports.SHIFT_CANCELLATION_CODES = Object.freeze([...COMMON_CANCELLATION_CODES]);

exports.OCCURRENCE_CANCELLATION_CODES = Object.freeze([...COMMON_CANCELLATION_CODES]);

/**
 * Only codes with a fixed actor belong here.
 */
exports.CANCELLATION_CODE_ACTORS = Object.freeze({
  funding_deadline_passed: "system",
  employer_cancelled: "employer",
  late_employer_cancellation: "employer",
  admin_cancelled: "admin",
  system_cancelled: "system",
});

const EMPLOYER_CANCELLATION_REASON_CODES = Object.freeze([
  "not_needed",
  "staff_available",
  "staffing_change",
  "schedule_error",
  "branch_closure",
  "public_holiday",
  "operational_issue",
  "safety_concern",
  "compliance_issue",
  "external_disruption",
  "other",
]);

exports.EMPLOYER_CANCELLATION_REASON_CODES = EMPLOYER_CANCELLATION_REASON_CODES;

exports.OCCURRENCE_EMPLOYER_CANCELLATION_REASON_CODES = Object.freeze([
  ...EMPLOYER_CANCELLATION_REASON_CODES,
  "professional_unavailability",
]);

const CANCELLATION_REASON_CODES_REQUIRING_DETAILS = Object.freeze([
  "schedule_error",
  "operational_issue",
  "safety_concern",
  "compliance_issue",
  "external_disruption",
  "other",
]);

exports.CANCELLATION_REASON_CODES_REQUIRING_DETAILS = CANCELLATION_REASON_CODES_REQUIRING_DETAILS;

exports.OCCURRENCE_CANCELLATION_REASON_CODES_REQUIRING_DETAILS = Object.freeze([
  ...CANCELLATION_REASON_CODES_REQUIRING_DETAILS,
]);

exports.BASE_PLATFORM_FEE_BENEFIT_SOURCES = Object.freeze(["standard", "subscription"]);
