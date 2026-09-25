// constants/jobAppointment.js

/**
 * JOB APPOINTMENT FORMATS:
 *
 * Defines how an interview appointment takes place.
 */
exports.JOB_APPOINTMENT_FORMATS = ["onsite", "video", "phone"];

/**
 * JOB APPOINTMENT STATUSES:
 *
 * These describe the meeting itself, not the JobApplication pipeline.
 *
 * scheduled:
 * - the appointment is expected to take place at its current scheduled time.
 *
 * completed:
 * - an authorized employer user explicitly recorded that the meeting occurred.
 *
 * cancelled:
 * - the appointment will not take place.
 *
 * no_show:
 * - an authorized employer user explicitly recorded that one or both parties
 *   failed to attend.
 *
 * Time passing alone must never automatically mark an appointment completed
 * or no_show.
 */
exports.JOB_APPOINTMENT_STATUSES = ["scheduled", "completed", "cancelled", "no_show"];

/**
 * PROFESSIONAL RESPONSE:
 *
 * The professional's response to the current appointment schedule.
 */
exports.JOB_APPOINTMENT_RESPONSE_STATUSES = ["pending", "confirmed", "declined"];

/**
 * ACTOR ROLES:
 *
 * Used for appointment lifecycle and scheduling audit entries.
 *
 * Platform admins have read-only appointment oversight and are intentionally
 * excluded from appointment lifecycle mutation actors.
 */
exports.JOB_APPOINTMENT_ACTOR_ROLES = ["professional", "employer", "system"];

/**
 * CANCELLATION REASONS:
 *
 * candidate_declined:
 * - the professional declined the appointment schedule.
 *
 * employer_cancelled:
 * - the employer no longer wants this specific meeting to proceed.
 *
 * scheduling_conflict:
 * - the appointment cannot proceed because of a scheduling conflict.
 *
 * recruitment_closed:
 * - the recruitment exercise has been closed.
 *
 * position_filled:
 * - the relevant recruitment capacity has been filled.
 *
 * administrative:
 * - a system/platform operational lifecycle action ended the appointment.
 *
 * other:
 * - requires explanatory details.
 */
exports.JOB_APPOINTMENT_CANCELLATION_REASONS = [
  "candidate_declined",
  "employer_cancelled",
  "scheduling_conflict",
  "recruitment_closed",
  "position_filled",
  "administrative",
  "other",
];

/**
 * NO-SHOW PARTY:
 *
 * Identifies who failed to attend when status is no_show.
 */
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
