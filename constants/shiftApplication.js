// constants/shiftApplication.js

/* ─────────────────────────────── APPLICATION TYPES ─────────────────────────────── */

// Initial applications use round 1. Replacement rounds are scoped to the
// replaced assignment and, where applicable, the targeted occurrence.
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

// Accepted applications remain historical records. Subsequent lifecycle
// changes belong to the associated assignment.
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

// Replacement and initial hiring may coexist.
// Eligibility also requires valid assignment, slot, occurrence and funding.
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

// Replacement remains subject to assignment, case and cancellation rules.
exports.REPLACEABLE_ASSIGNMENT_STATUSES = ["ending", "ended", "cancelled"];

/* ─────────────────────────────── PROFESSIONAL AVAILABILITY ─────────────────────────────── */

// Parent statuses are preliminary filters.
// Conflict checks must inspect actual assignments and occurrence ownership.
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

// Independent of the parent Shift's initial hiring status.
exports.REPLACEMENT_HIRING_STATUSES = {
  OPEN: "open",
  CLOSED: "closed",
};

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_APPLICATION_NOTE_LENGTH = 500;

exports.MAX_REVIEW_NOTE_LENGTH = 500;

exports.MAX_REASON_LENGTH = 300;

/* ─────────────────────────────── APPLICATION OUTCOME REASONS ─────────────────────────────── */

// Use only when the relevant hiring opportunity has no remaining capacity.
exports.OTHER_APPLICANT_SELECTED_REASON =
  "All available positions for this application round have been filled.";
