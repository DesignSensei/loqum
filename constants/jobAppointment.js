// constants/jobAppointment.js

/* ─────────────────────────────── APPOINTMENT FORMATS ─────────────────────────────── */

exports.JOB_APPOINTMENT_FORMATS = ["onsite", "video", "phone"];

/* ─────────────────────────────── APPOINTMENT STATUSES ─────────────────────────────── */

// Completion and no-show require explicit employer action.
// Elapsed time alone does not change appointment status.
exports.JOB_APPOINTMENT_STATUSES = ["scheduled", "completed", "cancelled", "no_show"];

/* ─────────────────────────────── PROFESSIONAL RESPONSE ─────────────────────────────── */

exports.JOB_APPOINTMENT_RESPONSE_STATUSES = ["pending", "confirmed", "declined"];

/* ─────────────────────────────── ACTOR ROLES ─────────────────────────────── */

// Platform administrators have read-only appointment oversight.
exports.JOB_APPOINTMENT_ACTOR_ROLES = ["professional", "employer", "system"];

/* ─────────────────────────────── CANCELLATION REASONS ─────────────────────────────── */

// Administrative cancellation covers system lifecycle actions.
// The "other" reason requires explanatory details.
exports.JOB_APPOINTMENT_CANCELLATION_REASONS = [
  "candidate_declined",
  "employer_cancelled",
  "scheduling_conflict",
  "recruitment_closed",
  "position_filled",
  "administrative",
  "other",
];

/* ─────────────────────────────── NO-SHOW PARTIES ─────────────────────────────── */

exports.JOB_APPOINTMENT_NO_SHOW_PARTIES = ["professional", "employer", "both"];

/* ─────────────────────────────── TEXT LIMITS ─────────────────────────────── */

exports.MAX_JOB_APPOINTMENT_TITLE_LENGTH = 150;
exports.MAX_JOB_APPOINTMENT_LOCATION_LENGTH = 500;
exports.MAX_JOB_APPOINTMENT_MEETING_LINK_LENGTH = 1000;
exports.MAX_JOB_APPOINTMENT_PHONE_LENGTH = 30;
exports.MAX_JOB_APPOINTMENT_INTERVIEWER_NAME_LENGTH = 150;
exports.MAX_JOB_APPOINTMENT_INTERVIEWER_ROLE_LENGTH = 150;
exports.MAX_JOB_APPOINTMENT_NOTE_LENGTH = 2000;
exports.MAX_JOB_APPOINTMENT_REASON_LENGTH = 500;
exports.MAX_JOB_APPOINTMENT_RESCHEDULE_HISTORY = 20;
