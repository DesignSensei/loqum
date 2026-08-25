// constants/shiftAssignmentCase.js

exports.ASSIGNMENT_CASE_TYPES = ["professional_exit", "employer_issue"];

exports.ASSIGNMENT_CASE_STATUSES = [
  "awaiting_employer_acknowledgment",
  "awaiting_professional_response",
  "awaiting_employer_response",
  "under_admin_review",
  "replacement_requested",
  "resolved_continue",
  "resolved_exit",
  "withdrawn",
  "dismissed",
  "cancelled",
];

exports.OPEN_ASSIGNMENT_CASE_STATUSES = [
  "awaiting_employer_acknowledgment",
  "awaiting_professional_response",
  "awaiting_employer_response",
  "under_admin_review",
  "replacement_requested",
];

exports.TERMINAL_ASSIGNMENT_CASE_STATUSES = [
  "resolved_continue",
  "resolved_exit",
  "withdrawn",
  "dismissed",
  "cancelled",
];

exports.ASSIGNMENT_EXIT_REASONS = [
  "personal_unavailability",
  "health_or_emergency",
  "schedule_conflict",
  "relocation",
  "professional_commitment",
  "assignment_concern",
  "other",
];

exports.EMPLOYER_ASSIGNMENT_ISSUE_TYPES = [
  "missed_occurrence",
  "repeated_no_show",
  "professional_unreachable",
  "verbal_exit_notice",
  "suspected_abandonment",
  "serious_misconduct",
  "account_restriction",
  "other",
];

exports.PROFESSIONAL_ASSIGNMENT_RESPONSE_DECISIONS = [
  "continue_assignment",
  "confirm_exit",
  "dispute_issue",
];

exports.EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS = [
  "acknowledge_and_request_replacement",
  "accept_continuation",
  "escalate_to_admin",
  "dismiss_issue",
];

exports.ASSIGNMENT_CASE_RESOLUTION_OUTCOMES = [
  "continue_assignment",
  "exit_confirmed",
  "assignment_terminated",
];

exports.ASSIGNMENT_EXIT_PROPOSAL_SOURCES = [
  "professional_notice",
  "professional_response",
  "admin_decision",
];

exports.EMPLOYER_ISSUE_ALLOWED_INITIATOR_ROLES = ["employer", "admin", "system"];

exports.EMPLOYER_ISSUE_EXIT_PROPOSAL_SOURCES = ["professional_response", "admin_decision"];

exports.RESOLVED_ASSIGNMENT_CASE_STATUSES = ["resolved_continue", "resolved_exit"];

exports.REPLACEMENT_REQUEST_RETAINING_CASE_STATUSES = ["replacement_requested", "resolved_exit"];

exports.RESOLVED_EXIT_OUTCOMES = ["exit_confirmed", "assignment_terminated"];

exports.PROFESSIONAL_EXIT_DISALLOWED_EMPLOYER_DECISIONS = ["accept_continuation", "dismiss_issue"];

exports.MAX_EXIT_PROPOSAL_DETAILS_LENGTH = 500;

exports.MAX_EMPLOYER_ISSUE_DETAILS_LENGTH = 1000;

exports.MAX_PROFESSIONAL_RESPONSE_DETAILS_LENGTH = 1000;

exports.MAX_EMPLOYER_RESPONSE_DETAILS_LENGTH = 1000;

exports.MAX_ASSIGNMENT_CASE_RESOLUTION_REASON_LENGTH = 1000;

exports.MAX_ASSIGNMENT_CASE_ESCALATION_REASON_LENGTH = 1000;

exports.MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH = 500;
