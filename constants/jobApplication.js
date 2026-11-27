// constants/jobApplication.js

/* ─────────────────────────────── APPLICATION STATUSES ─────────────────────────────── */

// Permanent recruitment is independent of Shift workflows.
// Publication expiry does not expire existing applications.
exports.JOB_APPLICATION_STATUSES = [
  "submitted",
  "under_review",
  "shortlisted",
  "interview",
  "offered",
  "hired",
  "rejected",
  "withdrawn",
];

/* ─────────────────────────────── ACTIVE / TERMINAL STATUSES ─────────────────────────────── */

// Interview is a recruitment stage. Individual meetings belong to Appointment.
exports.ACTIVE_JOB_APPLICATION_STATUSES = [
  "submitted",
  "under_review",
  "shortlisted",
  "interview",
  "offered",
];

exports.TERMINAL_JOB_APPLICATION_STATUSES = ["hired", "rejected", "withdrawn"];

// Only active applications may be withdrawn.
exports.WITHDRAWABLE_JOB_APPLICATION_STATUSES = [
  "submitted",
  "under_review",
  "shortlisted",
  "interview",
  "offered",
];

/* ─────────────────────────────── EMPLOYER REVIEW ─────────────────────────────── */

exports.EMPLOYER_JOB_APPLICATION_REVIEW_STATUSES = [
  "under_review",
  "shortlisted",
  "interview",
  "offered",
  "hired",
  "rejected",
];

/* ─────────────────────────────── STATUS TRANSITIONS ─────────────────────────────── */

// Intermediate stages may be skipped where appropriate.
// Terminal outcomes cannot transition through ordinary workflows.
exports.JOB_APPLICATION_ALLOWED_TRANSITIONS = {
  submitted: ["under_review", "shortlisted", "interview", "rejected", "withdrawn"],

  under_review: ["shortlisted", "interview", "offered", "hired", "rejected", "withdrawn"],

  shortlisted: ["under_review", "interview", "offered", "hired", "rejected", "withdrawn"],

  interview: ["shortlisted", "offered", "hired", "rejected", "withdrawn"],

  offered: ["interview", "hired", "rejected", "withdrawn"],

  hired: [],
  rejected: [],
  withdrawn: [],
};

/* ─────────────────────────────── SCREENING ─────────────────────────────── */

// Screening flags candidates without automatically rejecting them.
exports.JOB_APPLICATION_SCREENING_OUTCOMES = [
  "not_evaluated",
  "meets_required_criteria",
  "does_not_meet_required_criteria",
];

/* ─────────────────────────────── REJECTION REASONS ─────────────────────────────── */

exports.JOB_APPLICATION_REJECTION_REASONS = [
  "does_not_meet_required_criteria",
  "qualifications_mismatch",
  "experience_mismatch",
  "availability_mismatch",
  "location_mismatch",
  "compensation_mismatch",
  "not_selected",
  "position_filled",
  "recruitment_closed",
  "other",
];

/* ─────────────────────────────── WITHDRAWAL REASONS ─────────────────────────────── */

exports.JOB_APPLICATION_WITHDRAWAL_REASONS = [
  "no_longer_interested",
  "accepted_other_offer",
  "availability_changed",
  "role_no_longer_suitable",
  "personal_reasons",
  "other",
];

/* ─────────────────────────────── ACTORS ─────────────────────────────── */

// Professional: submission and withdrawal.
// Employer: recruitment decisions.
// System: automatic lifecycle outcomes.
// Platform administrators have read-only oversight.
exports.JOB_APPLICATION_ACTOR_ROLES = ["professional", "employer", "system"];

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_JOB_APPLICATION_NOTE_LENGTH = 1000;

exports.MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH = 1000;

exports.MAX_JOB_APPLICATION_REASON_LENGTH = 500;

exports.MAX_SCREENING_TEXT_ANSWER_LENGTH = 2000;
