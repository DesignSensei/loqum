// constants/shiftAssignment.js

/* ─────────────────────────────── ASSIGNMENT ORIGIN ─────────────────────────────── */

exports.ASSIGNMENT_TYPES = ["initial", "replacement"];

exports.ASSIGNMENT_SOURCES = ["application", "employer_invite", "admin", "system_migration"];

/* ─────────────────────────────── ASSIGNMENT LIFECYCLE ─────────────────────────────── */

/**
 * Each assignment belongs to one Shift slot and one professional.
 *
 * scheduled:
 * Accepted responsibility for a range that has not become active.
 *
 * active:
 * Current responsibility without a confirmed early endpoint.
 *
 * ending:
 * A confirmed early endpoint exists. Responsibility continues through
 * effectiveEndSequence while replacement hiring may cover the future tail.
 *
 * ended:
 * Professional responsibility has concluded.
 *
 * cancelled:
 * Assignment was cancelled before activation.
 */
exports.ASSIGNMENT_STATUSES = ["scheduled", "active", "ending", "ended", "cancelled"];

/**
 * Continuing assignments in these statuses are current within their slot.
 *
 * Different slots may have current assignments simultaneously.
 * Occurrence-targeted replacement assignments are excluded from
 * isCurrentAssignment even when active.
 */
exports.CURRENT_ASSIGNMENT_STATUSES = ["active", "ending"];

/**
 * Assignments that still represent planned or ongoing responsibility.
 *
 * Includes scheduled assignments and occurrence-targeted replacements.
 * Services must inspect occurrence ownership and sequence ranges when
 * determining actual coverage.
 */
exports.OPERATIONAL_ASSIGNMENT_STATUSES = ["scheduled", "active", "ending"];

/**
 * Terminal assignment status does not imply completed financial processing.
 * Its occurrences may still have unresolved claims, payouts or refunds.
 */
exports.TERMINAL_ASSIGNMENT_STATUSES = ["ended", "cancelled"];

/* ─────────────────────────────── ACTOR ROLES ─────────────────────────────── */

exports.ASSIGNMENT_ACTOR_ROLES = ["professional", "employer", "admin", "system"];

/* ─────────────────────────────── ASSIGNMENT END REASONS ─────────────────────────────── */

exports.ASSIGNMENT_END_REASONS = [
  "engagement_completed",
  "engagement_cancelled",
  "professional_unavailable",
  "illness",
  "emergency",
  "professional_request",
  "employer_request",
  "mutual_agreement",
  "repeated_no_show",
  "misconduct",
  "licence_or_compliance_issue",
  "admin_action",
  "other",
];

/**
 * These reasons require the assignment case that authorized the ending.
 *
 * Ending one assignment does not automatically end other professionals'
 * assignments or cancel the parent Shift.
 */
exports.CASE_BASED_ASSIGNMENT_END_REASONS = [
  "professional_unavailable",
  "illness",
  "emergency",
  "professional_request",
  "employer_request",
  "mutual_agreement",
  "repeated_no_show",
  "misconduct",
  "licence_or_compliance_issue",
];

/* ─────────────────────────────── REPLACEMENT ELIGIBILITY ─────────────────────────────── */

/**
 * Candidate statuses for replacement eligibility.
 *
 * Status alone does not authorize replacement. Services must verify
 * the applicable workflow, slot, available occurrence range and funding.
 *
 * A replacement inherits the prior assignment's slotNumber.
 * It does not create another professional position or funded allocation.
 */
exports.REPLACEABLE_ASSIGNMENT_STATUSES = ["ending", "ended", "cancelled"];

/**
 * An unresolved professional-exit or employer-issue case may remain
 * attached to a scheduled or active assignment.
 *
 * Once an ending is confirmed, the model uses endCase and the ending audit.
 */
exports.OPEN_CASE_ALLOWED_ASSIGNMENT_STATUSES = ["scheduled", "active"];

/**
 * Statuses allowing replacedByAssignment on the prior assignment.
 *
 * This link represents replacement of a continuing responsibility range.
 * Reassigning one isolated occurrence does not mark the continuing
 * assignment as replaced.
 *
 * Cancelled assignments are excluded to preserve the model's existing
 * pre-activation cancellation rules.
 */
exports.REPLACED_ASSIGNMENT_ALLOWED_STATUSES = ["ending", "ended"];

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_ASSIGNMENT_END_NOTES_LENGTH = 500;

exports.MAX_ASSIGNMENT_CANCELLATION_REASON_LENGTH = 500;
