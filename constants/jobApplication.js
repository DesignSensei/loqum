// constants/jobApplication.js

/**
 * Job applications belong to permanent recruitment.
 *
 * They do not use Shift acceptance, assignment, attendance, settlement,
 * replacement or occurrence semantics.
 *
 * Publication expiry does not expire existing Job applications.
 */
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

/**
 * Active statuses represent professionals who remain in the employer's
 * recruitment pipeline.
 *
 * Interview is a recruitment stage. Individual interview meetings belong
 * to Appointment records.
 */
exports.ACTIVE_JOB_APPLICATION_STATUSES = [
  "submitted",
  "under_review",
  "shortlisted",
  "interview",
  "offered",
];

exports.TERMINAL_JOB_APPLICATION_STATUSES = ["hired", "rejected", "withdrawn"];

/**
 * A professional may withdraw while their candidacy remains active.
 *
 * Terminal applications cannot be withdrawn through the ordinary workflow.
 */
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

/**
 * The normal recruitment path is:
 *
 * submitted
 * → under_review
 * → shortlisted
 * → interview
 * → offered
 * → hired
 *
 * Employers are not required to manufacture stages that did not actually
 * occur. A candidate may therefore move directly between certain later
 * recruitment stages where appropriate.
 *
 * Terminal outcomes do not transition through the ordinary workflow.
 */
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

/**
 * Screening outcomes assist employer review.
 *
 * A professional who does not meet a required screening criterion is flagged
 * rather than automatically rejected.
 */
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

/**
 * Job application actors are limited to:
 *
 * - professional: candidate-owned actions such as submission and withdrawal;
 * - employer: recruitment decisions and pipeline transitions;
 * - system: automatic lifecycle consequences such as rejecting remaining
 *   active applications when recruitment closes or all vacancies are filled.
 *
 * Platform admins may inspect Job applications but do not act as recruitment
 * decision-makers on behalf of employers.
 */
exports.JOB_APPLICATION_ACTOR_ROLES = ["professional", "employer", "system"];

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_JOB_APPLICATION_NOTE_LENGTH = 1000;

exports.MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH = 1000;

exports.MAX_JOB_APPLICATION_REASON_LENGTH = 500;

exports.MAX_SCREENING_TEXT_ANSWER_LENGTH = 2000;
