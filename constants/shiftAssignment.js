// constants/shiftAssignment.js

exports.ASSIGNMENT_TYPES = ["initial", "replacement"];

exports.ASSIGNMENT_SOURCES = ["application", "employer_invite", "admin", "system_migration"];

exports.ASSIGNMENT_STATUSES = ["scheduled", "active", "ending", "ended", "cancelled"];

exports.CURRENT_ASSIGNMENT_STATUSES = ["active", "ending"];

exports.OPERATIONAL_ASSIGNMENT_STATUSES = ["scheduled", "active", "ending"];

exports.TERMINAL_ASSIGNMENT_STATUSES = ["ended", "cancelled"];

exports.ASSIGNMENT_ACTOR_ROLES = ["professional", "employer", "admin", "system"];

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

exports.REPLACEABLE_ASSIGNMENT_STATUSES = ["ending", "ended", "cancelled"];

exports.OPEN_CASE_ALLOWED_ASSIGNMENT_STATUSES = ["scheduled", "active"];

exports.REPLACED_ASSIGNMENT_ALLOWED_STATUSES = ["ending", "ended"];

exports.MAX_ASSIGNMENT_END_NOTES_LENGTH = 500;

exports.MAX_ASSIGNMENT_CANCELLATION_REASON_LENGTH = 500;
