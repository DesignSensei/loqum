// constants/shiftApplication.js

exports.MAX_APPLICATION_ROUNDS = 99;

exports.APPLICATION_TYPES = ["initial", "replacement"];

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

exports.TERMINAL_APPLICATION_STATUSES = [
  "accepted",
  "rejected",
  "withdrawn",
  "expired",
  "cancelled",
];

exports.ACTIVE_APPLICATION_STATUSES = ["pending", "shortlisted"];

exports.INITIAL_APPLICATION_PAYMENT_STATUS = "funded";

exports.REPLACEMENT_APPLICATION_PARENT_STATUSES = [
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "disputed",
  "no_show",
];

exports.REPLACEMENT_APPLICATION_BLOCKED_PAYMENT_STATUSES = ["unpaid", "released", "refunded"];

exports.REPLACEABLE_ASSIGNMENT_STATUSES = ["ending", "ended", "cancelled"];

exports.ACTIVE_SINGLE_SHIFT_STATUSES = [
  "assigned",
  "confirmed",
  "in_progress",
  "pending_settlement",
  "disputed",
];

exports.ACTIVE_OCCURRENCE_STATUSES = ["scheduled", "in_progress", "pending_settlement", "disputed"];

exports.PROFESSIONAL_UNAVAILABLE_STATUSES = ["unavailable", "paused"];

exports.REPLACEMENT_HIRING_STATUSES = {
  OPEN: "open",
  CLOSED: "closed",
};

exports.MAX_APPLICATION_NOTE_LENGTH = 500;

exports.MAX_REVIEW_NOTE_LENGTH = 500;

exports.MAX_REASON_LENGTH = 300;

exports.OTHER_APPLICANT_SELECTED_REASON =
  "Another applicant was selected for this application round.";
