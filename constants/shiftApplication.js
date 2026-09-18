// constants/shiftApplication.js

/**
 * Initial applications use round 1.
 *
 * Replacement rounds are scoped to the assignment being replaced and,
 * for an isolated replacement, the targeted occurrence.
 *
 * They do not advance the parent Shift's initial application round.
 */
exports.MAX_APPLICATION_ROUNDS = 99;

exports.APPLICATION_TYPES = ["initial", "replacement"];

/* ─────────────────────────────── APPLICATION STATUSES ─────────────────────────────── */

exports.APPLICATION_STATUSES = [
  "pending",
  "shortlisted",
  "accepted",
  "rejected",
  "withdrawn",
  "expired",
  "cancelled",
];

exports.EMPLOYER_REVIEW_STATUSES = ["shortlisted", "accepted", "rejected"];

/**
 * Acceptance completes the application workflow.
 *
 * The accepted application remains historical evidence of acceptance.
 * Subsequent activation, ending or cancellation belongs to its assignment.
 */
exports.TERMINAL_APPLICATION_STATUSES = [
  "accepted",
  "rejected",
  "withdrawn",
  "expired",
  "cancelled",
];

exports.ACTIVE_APPLICATION_STATUSES = ["pending", "shortlisted"];

/* ─────────────────────────────── INITIAL APPLICATION FUNDING ─────────────────────────────── */

exports.INITIAL_APPLICATION_PAYMENT_STATUS = "funded";

/* ─────────────────────────────── REPLACEMENT ELIGIBILITY ─────────────────────────────── */

/**
 * An open parent may already contain accepted professional assignments
 * while other initial positions remain available.
 *
 * Replacement hiring operates independently within the affected slot.
 * It can therefore coexist with initial hiring.
 *
 * Parent status alone does not establish replacement eligibility.
 * Services must verify the replacement assignment, slot, occurrence range,
 * hiring opportunity and available funded allocation.
 */
exports.REPLACEMENT_APPLICATION_PARENT_STATUSES = [
  "open",
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "disputed",
  "no_show",
];

exports.REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES = ["unpaid", "released", "refunded"];

/**
 * These statuses identify assignments that may need replacement.
 *
 * A qualifying status alone does not authorize acceptance.
 * The assignment service applies the relevant case, cancellation and
 * remaining-occurrence rules.
 */
exports.REPLACEABLE_ASSIGNMENT_STATUSES = ["ending", "ended", "cancelled"];

/* ─────────────────────────────── PROFESSIONAL AVAILABILITY ─────────────────────────────── */

/**
 * An open single-date Shift may already have occupied positions.
 *
 * These parent statuses are only a preliminary filter.
 * Professional conflict checks must inspect that professional's actual
 * assignments and occurrence ownership, including occupied slots under
 * a partially filled parent.
 */
exports.ACTIVE_SINGLE_SHIFT_STATUSES = [
  "open",
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "disputed",
];

exports.ACTIVE_OCCURRENCE_STATUSES = ["scheduled", "in_progress", "pending_settlement", "disputed"];

exports.PROFESSIONAL_UNAVAILABLE_STATUSES = ["unavailable", "paused"];

/* ─────────────────────────────── REPLACEMENT HIRING ─────────────────────────────── */

/**
 * Status of an individual replacement hiring opportunity.
 * This is independent of the parent Shift's initial hiring status.
 */
exports.REPLACEMENT_HIRING_STATUSES = {
  OPEN: "open",
  CLOSED: "closed",
};

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_APPLICATION_NOTE_LENGTH = 500;

exports.MAX_REVIEW_NOTE_LENGTH = 500;

exports.MAX_REASON_LENGTH = 300;

/* ─────────────────────────────── APPLICATION OUTCOME REASONS ─────────────────────────────── */

/**
 * Retained export name for existing consumers.
 *
 * Use only after the relevant hiring capacity is filled.
 * Accepting one professional must not reject remaining applicants while
 * other initial positions are still available.
 *
 * Replacement capacity is evaluated within its own hiring opportunity.
 */
exports.OTHER_APPLICANT_SELECTED_REASON =
  "All available positions for this application round have been filled.";
