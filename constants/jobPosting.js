// constants/jobPosting.js

/**
 * Job recruitment state is separate from marketplace publication state.
 *
 * A Job may stop accepting new applications because its publication expires
 * while recruitment continues with professionals who already applied.
 */
exports.JOB_RECRUITMENT_STATUSES = ["draft", "active", "closed", "archived"];

/* ─────────────────────────────── PUBLICATION STATUSES ─────────────────────────────── */

/**
 * Publication status controls marketplace visibility and whether new
 * applications may be submitted.
 *
 * Expiry does not close recruitment or invalidate existing applications.
 */
exports.JOB_PUBLICATION_STATUSES = ["unpublished", "live", "paused", "expired", "ended"];

/**
 * Standard Job marketplace visibility period.
 *
 * A fresh publication entitlement is required to extend or renew visibility
 * for another publication period.
 */
exports.DEFAULT_JOB_PUBLICATION_PERIOD_DAYS = 45;

/* ─────────────────────────────── RECRUITMENT CLOSURE ─────────────────────────────── */

exports.JOB_CLOSE_REASONS = ["filled", "employer_closed", "cancelled", "other"];

/* ─────────────────────────────── EMPLOYMENT ─────────────────────────────── */

exports.JOB_EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "temporary", "internship"];

exports.JOB_WORKPLACE_TYPES = ["onsite", "hybrid", "remote"];

/* ─────────────────────────────── COMPENSATION ─────────────────────────────── */

/**
 * Job compensation is visible to professionals.
 *
 * A Job may advertise either one fixed salary amount or a salary range.
 * Monetary values are stored in integer minor units.
 */
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

/**
 * Required criteria may flag an application as not meeting the employer's
 * stated requirements.
 *
 * They do not automatically reject the professional.
 */
exports.JOB_SCREENING_REQUIREMENT_LEVELS = ["informational", "preferred", "required"];

/* ─────────────────────────────── PUBLICATION ENTITLEMENT ─────────────────────────────── */

/**
 * Publication entitlement source records how one Job publication was
 * commercially authorized.
 *
 * - free covers platform-granted free publication authority, including the
 *   recurring monthly free allowance used by hybrid monetisation.
 * - plan_allowance covers included publication allowance from a paid
 *   subscription plan.
 * - paid_single_post covers a one-off PAYG Job publication purchase.
 */
exports.JOB_PUBLICATION_ENTITLEMENT_SOURCES = ["free", "plan_allowance", "paid_single_post"];

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_JOB_TITLE_LENGTH = 150;

exports.MAX_JOB_SUMMARY_LENGTH = 500;

exports.MAX_JOB_DESCRIPTION_LENGTH = 10000;

exports.MAX_JOB_SECTION_LENGTH = 5000;

exports.MAX_JOB_CLOSE_REASON_LENGTH = 500;

exports.MAX_SCREENING_QUESTION_LENGTH = 500;

exports.MAX_SCREENING_OPTION_LENGTH = 250;
