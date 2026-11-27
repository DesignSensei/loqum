// constants/jobPosting.js

/* ─────────────────────────────── RECRUITMENT STATUSES ─────────────────────────────── */

// Recruitment and marketplace publication have independent lifecycles.
exports.JOB_RECRUITMENT_STATUSES = ["draft", "active", "closed", "archived"];

/* ─────────────────────────────── PUBLICATION STATUSES ─────────────────────────────── */

// Publication expiry stops new applications without ending recruitment.
exports.JOB_PUBLICATION_STATUSES = ["unpublished", "live", "paused", "expired", "ended"];

// Free and PAYG publications expire after a fixed period.
// Subscription publications depend on active subscription-slot authority.
// Republishing a Free/PAYG Job requires a fresh entitlement.
exports.FIXED_JOB_PUBLICATION_PERIOD_DAYS = 30;

/* ─────────────────────────────── RECRUITMENT CLOSURE ─────────────────────────────── */

exports.JOB_CLOSE_REASONS = ["filled", "employer_closed", "cancelled", "other"];

/* ─────────────────────────────── EMPLOYMENT ─────────────────────────────── */

exports.JOB_EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "temporary", "internship"];

exports.JOB_WORKPLACE_TYPES = ["onsite", "hybrid", "remote"];

/* ─────────────────────────────── COMPENSATION ─────────────────────────────── */

// Compensation is visible to applicants and stored in integer minor units.
exports.JOB_COMPENSATION_TYPES = ["fixed", "range"];

exports.JOB_SALARY_PERIODS = ["hour", "day", "week", "month", "year"];

/* ─────────────────────────────── SCREENING QUESTIONS ─────────────────────────────── */

exports.JOB_SCREENING_QUESTION_TYPES = [
  "yes_no",
  "number",
  "single_select",
  "multi_select",
  "short_text",
];

// Unmet required criteria flag candidates without automatically rejecting them.
exports.JOB_SCREENING_REQUIREMENT_LEVELS = ["informational", "preferred", "required"];

/* ─────────────────────────────── PUBLICATION ENTITLEMENT ─────────────────────────────── */

// Free: platform-granted publication allowance.
// Subscription: concurrent Job-slot capacity.
// PAYG: one-off publication purchase.
exports.JOB_PUBLICATION_ENTITLEMENT_SOURCES = ["free", "subscription_slot", "paid_single_post"];

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_JOB_TITLE_LENGTH = 150;

exports.MAX_JOB_SUMMARY_LENGTH = 500;

exports.MAX_JOB_DESCRIPTION_LENGTH = 10000;

exports.MAX_JOB_SECTION_LENGTH = 5000;

exports.MAX_JOB_CLOSE_REASON_LENGTH = 500;

exports.MAX_SCREENING_QUESTION_LENGTH = 500;

exports.MAX_SCREENING_OPTION_LENGTH = 250;
