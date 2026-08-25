// constants/shiftLifecycle.js

exports.MAX_SHIFT_OCCURRENCES = 30;
exports.MAX_APPLICATION_ROUNDS = 99;
exports.MINUTES_PER_DAY = 24 * 60;

/* ─────────────────────────────── PARENT SHIFT ─────────────────────────────── */

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

exports.SHIFT_FINAL_PAYMENT_STATUSES = Object.freeze([
  "released",
  "refunded",
  "partially_refunded",
]);

exports.SHIFT_OPEN_PAYMENT_STATUSES = Object.freeze(["funded", "partially_refunded"]);

exports.SHIFT_CANCELLABLE_FROM_STATUSES = Object.freeze([
  "pending_funding",
  "open",
  "assigned",
  "confirmed",
  "in_progress",
]);

/* ─────────────────────────────── OCCURRENCE ASSIGNMENT ─────────────────────────────── */

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

exports.TERMINAL_OCCURRENCE_STATUSES = Object.freeze([
  "completed",
  "cancelled",
  "no_show",
  "expired_unfilled",
]);

/* ─────────────────────────────── ATTENDANCE ─────────────────────────────── */

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
 * These reasons apply only when the professional confirms that the late
 * checkout was not worked overtime.
 *
 * Worked overtime belongs to the dedicated overtime request lifecycle and is
 * represented by lateCheckout.selectedOption = overtime_requested.
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
 * The professional receives one post-shift review entry point during the
 * ordinary occurrence review window.
 *
 * The UI may allow one or more selections in the same submission.
 *
 * overtime:
 * Routed to the dedicated overtime lifecycle. It is never stored as a
 * ShiftOccurrenceClaim issue.
 *
 * attendance_correction / payment_calculation / employer_fault:
 * Routed into one ordinary professional ShiftOccurrenceClaim case.
 *
 * Once an overtime request already exists, overtime must not be offered as a
 * new review selection.
 *
 * Once the professional has submitted their one original ordinary claim case,
 * additional ordinary claim selections must not be offered.
 */
exports.PROFESSIONAL_REVIEW_SELECTION_TYPES = Object.freeze([
  "overtime",
  "attendance_correction",
  "payment_calculation",
  "employer_fault",
]);

/* ─────────────────────────────── OCCURRENCE CLAIMS ─────────────────────────────── */

/**
 * A ShiftOccurrenceClaim is the professional's one original ordinary claim
 * case for an occurrence.
 *
 * One claim case may contain one or more structured ordinary issues:
 *
 * - attendance_correction
 * - payment_calculation
 * - employer_fault
 *
 * The submitted issue set is immutable.
 *
 * Each issue is reviewed and resolved independently. Mixed outcomes are
 * therefore valid, for example:
 *
 * - attendance_correction approved;
 * - payment_calculation rejected; and
 * - employer_fault approved.
 *
 * A professional claim and employer dispute may coexist when they concern
 * genuinely different ordinary issues and each case was initiated within the
 * shared occurrence challenge window.
 *
 * The same factual controversy must not be duplicated across a professional
 * claim and employer dispute.
 *
 * Example:
 *
 * Loqum records five worked hours.
 * Professional claims eight hours.
 * Employer says the professional actually worked three hours.
 *
 * This remains one attendance_correction issue inside the professional claim.
 * The employer supplies its counter-position and evidence inside that issue.
 * A separate employer dispute must not be created for the same attendance fact.
 *
 * Overtime is deliberately excluded from generic claims.
 *
 * An employer-rejected overtime request uses the dedicated overtime appeal
 * lifecycle. Employer-approved overtime is final in the ordinary lifecycle.
 *
 * An absence explanation is also not a claim.
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
 * Claim-case status is intentionally coarse.
 *
 * active:
 * At least one issue remains unresolved.
 *
 * resolved:
 * Every issue has reached its final outcome.
 *
 * withdrawn:
 * The claim case was withdrawn under the permitted withdrawal rules.
 *
 * Detailed action ownership belongs to each issue, not to the whole claim.
 */
exports.OCCURRENCE_CLAIM_STATUSES = Object.freeze(["active", "resolved", "withdrawn"]);

exports.ACTIVE_OCCURRENCE_CLAIM_STATUSES = Object.freeze(["active"]);

exports.FINAL_OCCURRENCE_CLAIM_STATUSES = Object.freeze(["resolved", "withdrawn"]);

/**
 * Each issue inside one ShiftOccurrenceClaim has its own action-owner status.
 *
 * awaiting_employer_review:
 * Employer must review that issue.
 *
 * awaiting_professional_appeal:
 * Employer rejected the issue without introducing a different factual or
 * financial position, and the professional's appeal window is open.
 *
 * awaiting_professional_rebuttal:
 * Employer rejected the issue and introduced a different factual or financial
 * position. The professional may respond, but silence does not make the
 * employer position authoritative.
 *
 * awaiting_admin_review:
 * The issue requires admin adjudication after professional escalation,
 * employer counter-position, or employer non-response.
 *
 * resolved:
 * The issue has a final outcome.
 */
exports.OCCURRENCE_CLAIM_ISSUE_STATUSES = Object.freeze([
  "awaiting_employer_review",
  "awaiting_professional_appeal",
  "awaiting_professional_rebuttal",
  "awaiting_admin_review",
  "resolved",
]);

exports.ACTIVE_OCCURRENCE_CLAIM_ISSUE_STATUSES = Object.freeze([
  "awaiting_employer_review",
  "awaiting_professional_appeal",
  "awaiting_professional_rebuttal",
  "awaiting_admin_review",
]);

exports.FINAL_OCCURRENCE_CLAIM_ISSUE_STATUSES = Object.freeze(["resolved"]);

exports.OCCURRENCE_CLAIM_ISSUE_STATUSES_REQUIRING_EMPLOYER_ACTION = Object.freeze([
  "awaiting_employer_review",
]);

exports.OCCURRENCE_CLAIM_ISSUE_STATUSES_REQUIRING_PROFESSIONAL_ACTION = Object.freeze([
  "awaiting_professional_appeal",
  "awaiting_professional_rebuttal",
]);

exports.OCCURRENCE_CLAIM_ISSUE_STATUSES_REQUIRING_ADMIN_ACTION = Object.freeze([
  "awaiting_admin_review",
]);

/**
 * Employer decisions are made independently for each claim issue.
 *
 * approved:
 * The professional's requested issue outcome is accepted.
 *
 * rejected:
 * The professional's requested outcome is rejected.
 *
 * A rejected issue may also contain an employer counter-position. For example,
 * the employer may reject the professional's requested attendance correction
 * while proposing a different evidence-supported attendance value.
 */
exports.EMPLOYER_FINANCIAL_CLAIM_DECISIONS = Object.freeze(["approved", "rejected"]);

/**
 * Each employer-rejected claim issue receives at most one professional appeal
 * opportunity.
 */
exports.OCCURRENCE_CLAIM_APPEAL_STATUSES = Object.freeze([
  "not_available",
  "available",
  "submitted",
  "expired",
  "resolved",
]);

/**
 * Each employer adverse counter-position creates at most one professional
 * rebuttal opportunity.
 *
 * Rebuttal is separate from appeal:
 *
 * appeal:
 * Professional challenges an employer rejection.
 *
 * rebuttal:
 * Professional responds to an employer-provided alternative factual or
 * financial position.
 */
exports.OCCURRENCE_CLAIM_REBUTTAL_STATUSES = Object.freeze([
  "not_available",
  "available",
  "submitted",
  "expired",
  "resolved",
]);

/**
 * Admin makes one mutually exclusive final decision for each professional
 * claim issue.
 *
 * approve_professional:
 * The professional's submitted position is accepted as the authoritative
 * outcome.
 *
 * approve_employer:
 * The employer's adverse counter-position is accepted as the authoritative
 * outcome.
 *
 * This decision is only available when the issue actually contains an
 * employer counter-position.
 *
 * maintain_current:
 * Neither party's proposed change is accepted.
 *
 * The existing authoritative Loqum occurrence record remains unchanged.
 *
 * adjusted:
 * Neither submitted position is accepted exactly as proposed.
 *
 * Admin establishes a different evidence-supported authoritative fact/value.
 *
 * Exactly one of these four decisions may be recorded for an issue.
 */
exports.ADMIN_FINANCIAL_CLAIM_DECISIONS = Object.freeze([
  "approve_professional",
  "approve_employer",
  "maintain_current",
  "adjusted",
]);

/**
 * Claim issue escalation has objective lifecycle entry paths.
 *
 * professional_appeal:
 * Employer rejected the issue and the professional submitted the permitted
 * appeal.
 *
 * employer_counter_position:
 * Employer rejected the professional position and supplied a different factual
 * or financial position requiring  admin adjudication.
 *
 * employer_non_response:
 * Employer failed to decide the issue before the response deadline.
 *
 * Investigation reasons such as suspected abuse, conflicting evidence or
 * serious conduct concerns belong to the separate support/case subsystem.
 */
exports.OCCURRENCE_CLAIM_ESCALATION_REASONS = Object.freeze([
  "professional_appeal",
  "employer_counter_position",
  "employer_non_response",
]);

/* ─────────────────────────────── OCCURRENCE EVIDENCE ─────────────────────────────── */

/**
 * Evidence may be supplied by either party or by an administrator while a
 * professional claim issue, employer dispute issue, or overtime appeal is
 * being reviewed.
 *
 * System-owned occurrence records remain authoritative in their own models and
 * do not need to be duplicated as uploaded evidence.
 */
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
 * A ShiftOccurrenceDispute is the employer's one original ordinary dispute case
 * for an occurrence.
 *
 * One dispute case may contain one or more structured BASE/factual issues.
 *
 * The submitted issue set is immutable.
 *
 * Each issue is independently responded to and finally resolved by admin.
 * Mixed outcomes are therefore valid.
 *
 * A professional ShiftOccurrenceClaim and employer ShiftOccurrenceDispute may
 * coexist when:
 *
 * - they concern genuinely different ordinary issues; and
 * - each original case was submitted within the shared occurrence challenge
 *   window.
 *
 * The same factual controversy must not be duplicated across both case types.
 *
 * Example:
 *
 * Loqum records five worked hours.
 * Professional claims eight hours.
 * Employer says the professional actually worked three hours.
 *
 * The employer responds with its three-hour position and evidence inside the
 * professional's attendance_correction issue. It does not open another dispute
 * about the same attendance fact.
 *
 * Overtime is deliberately excluded:
 *
 * - employer-approved overtime is binding and cannot be revoked through an
 *   employer dispute; and
 * - employer-rejected overtime is contested, if necessary, by the professional
 *   through the dedicated overtime appeal lifecycle.
 */
exports.EMPLOYER_OCCURRENCE_DISPUTE_TYPES = Object.freeze([
  "attendance_correction",
  "payment_calculation",
  "other_financial_fact",
]);

/**
 * Employer dispute-case status is intentionally coarse.
 *
 * active:
 * At least one dispute issue remains unresolved.
 *
 * resolved:
 * Every issue has reached its final admin outcome.
 *
 * withdrawn:
 * The dispute case was withdrawn under the permitted withdrawal rules.
 *
 * Detailed action ownership belongs to each issue.
 */
exports.EMPLOYER_OCCURRENCE_DISPUTE_STATUSES = Object.freeze(["active", "resolved", "withdrawn"]);

exports.ACTIVE_EMPLOYER_OCCURRENCE_DISPUTE_STATUSES = Object.freeze(["active"]);

exports.FINAL_EMPLOYER_OCCURRENCE_DISPUTE_STATUSES = Object.freeze(["resolved", "withdrawn"]);

/**
 * Each issue inside one ShiftOccurrenceDispute has its own action-owner status.
 *
 * awaiting_professional_response:
 * Professional may respond to the employer's allegation/correction and provide
 * evidence.
 *
 * awaiting_admin_review:
 * Professional responded, or the response deadline expired, and admin owns the
 * final decision.
 *
 * resolved:
 * Admin established the final outcome for that issue.
 */
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
 * Admin is the final decision-maker for employer-originated dispute issues.
 *
 * approved:
 * The employer's disputed position is accepted.
 *
 * rejected:
 * The employer's disputed position is rejected and no different correction is
 * established.
 *
 * adjusted:
 * Admin establishes a different final fact/value supported by the evidence.
 */
exports.ADMIN_EMPLOYER_OCCURRENCE_DISPUTE_DECISIONS = Object.freeze([
  "approved",
  "rejected",
  "adjusted",
]);

/* ─────────────────────────────── SETTLEMENT ─────────────────────────────── */

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

/**
 * Cancellation compensation remains a settlement outcome.
 *
 * A compensated cancelled occurrence may proceed through professional
 * settlement even though cancellation compensation is not itself a distinct
 * professional claim type.
 */
exports.CANCELLATION_COMPENSATION_SETTLEMENT_STATUSES = Object.freeze([
  "pending_review",
  "approved_for_release",
  "release_pending",
  "released",
  "disputed",
]);

/**
 * approvalSource records the authority that finalized a professional payout
 * component for release.
 *
 * The employer is deliberately excluded. A prefunded ordinary occurrence does
 * not require a second employer settlement approval after work is completed.
 *
 * automatic:
 * Loqum/system finalized a normal payable component after its factual,
 * challenge and funding dependencies were satisfied.
 *
 * admin:
 * An administrator finalized the payable result through an authorized
 * operational intervention, including a final overtime decision.
 *
 * dispute_resolution:
 * A resolved generic professional claim or employer dispute established the
 * final payable BASE result.
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
 * Refund holds protect scheduled/base escrow while the refundable BASE amount
 * is not yet financially final or while positive professional BASE settlement
 * must finish first.
 *
 * challenge_window_open:
 * BASE remains ordinarily challengeable during the shared occurrence challenge
 * window. The scheduled/base refund must remain held because a timely BASE
 * claim or employer dispute could still change professional BASE entitlement.
 *
 * A submitted claim or dispute does not close the shared challenge window.
 * Each party's submitted case becomes immutable while the remaining shared
 * deadline continues to govern any still-unused ordinary challenge right.
 *
 * professional_claim_pending:
 * At least one unresolved professional claim issue affects BASE/refund
 * authority.
 *
 * employer_dispute_pending:
 * At least one unresolved employer dispute issue affects BASE/refund authority.
 *
 * professional_settlement_pending:
 * Positive final BASE professional pay must be released before the related
 * scheduled/base refund executes.
 *
 * Overtime is separately funded. OT-only challengeability, a pending OT
 * request, employer OT rejection, professional OT appeal, or OT top-up does not
 * by itself hold the scheduled/base refund.
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
 * Overtime is its own decision lifecycle.
 *
 * pending:
 * The professional requested OT and the employer response window is open, or
 * the employer failed to respond and admin must decide directly.
 *
 * approved:
 * OT entitlement is final. Employer approval is binding. Admin approval after
 * employer non-response or professional appeal is also final.
 *
 * rejected:
 * Employer rejected the request and the professional appeal opportunity is
 * either available, expired, or admin finally rejected OT.
 *
 * disputed:
 * Professional appealed an employer rejection and admin must make the final OT
 * decision.
 *
 * cancelled:
 * The OT request was cancelled before a final payable outcome existed.
 */
exports.OVERTIME_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "disputed",
  "cancelled",
]);

exports.OVERTIME_DECISION_SOURCES = Object.freeze(["employer", "admin"]);

/**
 * OT appeal is distinct from ShiftOccurrenceClaim.
 *
 * not_available:
 * No employer rejection currently creates an appeal opportunity.
 *
 * available:
 * Employer rejected OT and the professional may appeal before the deadline.
 *
 * submitted:
 * Professional appealed. Overtime status becomes disputed and admin owns the
 * next action.
 *
 * expired:
 * Professional did not appeal before the deadline. Employer rejection becomes
 * final.
 *
 * resolved:
 * Admin made the final OT decision after a submitted appeal.
 */
exports.OVERTIME_APPEAL_STATUSES = Object.freeze([
  "not_available",
  "available",
  "submitted",
  "expired",
  "resolved",
]);

exports.ACTIVE_OVERTIME_APPEAL_STATUSES = Object.freeze(["available", "submitted"]);

exports.OVERTIME_APPEAL_STATUSES_REQUIRING_PROFESSIONAL_ACTION = Object.freeze(["available"]);

exports.OVERTIME_APPEAL_STATUSES_REQUIRING_ADMIN_ACTION = Object.freeze(["submitted"]);

exports.OVERTIME_ADMIN_DECISIONS = Object.freeze(["approved", "rejected"]);

/* ─────────────────────────────── CANCELLATION ─────────────────────────────── */

/**
 * Cancellation actor records the party whose decision caused the cancellation.
 *
 * For parent-propagated occurrence cancellations, the occurrence copies the
 * originating actor from the parent Shift. The propagation service itself is
 * not treated as the cancellation actor.
 */
exports.CANCELLATION_ACTORS = Object.freeze(["employer", "system", "admin"]);

exports.USER_CANCELLATION_ACTORS = Object.freeze(["employer", "admin"]);

exports.ACTIVE_WORK_CANCELLATION_INITIATORS = Object.freeze(["employer", "admin"]);

/**
 * Selective occurrence cancellation is limited to future untouched scheduled
 * occurrences.
 */
exports.OCCURRENCE_CANCELLABLE_FROM_STATUSES = Object.freeze(["scheduled"]);

/**
 * Parent Shift cancellation may propagate into any untouched scheduled
 * occurrence that is unassigned, assigned or awaiting replacement.
 *
 * expired_unfilled is excluded because it is already a terminal outcome.
 */
exports.OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES = Object.freeze([
  "unassigned",
  "assigned",
  "replacement_required",
]);

/**
 * Individual occurrence cancellation is narrower.
 *
 * replacement_required is excluded because selectively removing an occurrence
 * from the middle of the replacement range could make the remaining parent
 * replacementHiring range noncontiguous.
 */
exports.INDIVIDUAL_OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES = Object.freeze([
  "unassigned",
  "assigned",
]);

/**
 * Only the employer or an administrator may directly cancel one occurrence.
 *
 * A system cancellation may still reach an occurrence through parent
 * cancellation propagation.
 */
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

/**
 * Parent Shift cancellation includes funding_deadline_passed because an
 * unpublished Shift may expire before funding is completed.
 */
exports.SHIFT_CANCELLATION_CODES = Object.freeze([...COMMON_CANCELLATION_CODES]);

/**
 * An occurrence stores its actual date-specific cancellation outcome.
 *
 * The lifecycle service determines whether that outcome came from parent
 * propagation or direct occurrence cancellation. No separate cancellationScope
 * field is stored on ShiftOccurrence.
 *
 * A separate parent_engagement_cancelled code is therefore unnecessary.
 */
exports.OCCURRENCE_CANCELLATION_CODES = Object.freeze([...COMMON_CANCELLATION_CODES]);

/**
 * Only cancellation codes that always require one fixed actor belong in this
 * map.
 *
 * Context-dependent codes such as branch_unavailable, compliance_issue and
 * other are excluded because they may originate from different actors.
 */
exports.CANCELLATION_CODE_ACTORS = Object.freeze({
  funding_deadline_passed: "system",
  employer_cancelled: "employer",
  late_employer_cancellation: "employer",
  admin_cancelled: "admin",
  system_cancelled: "system",
});

/**
 * Reasons available when the employer cancels the entire engagement.
 *
 * public_holiday is also valid at parent level when the holiday affects the
 * whole remaining engagement.
 */
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

/**
 * Selective occurrence cancellation supports the ordinary employer reasons
 * plus professional_unavailability.
 *
 * professional_unavailability means the professional cannot work that date and
 * the employer has decided not to seek replacement coverage.
 */
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
