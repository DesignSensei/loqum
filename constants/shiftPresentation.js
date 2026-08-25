// constants/shiftPresentation.js

exports.EMPLOYER_SHIFTS_URL = "/employer/shifts";

exports.POST_SHIFT_MODAL_ID = "postShiftModal";

exports.FUND_SHIFT_MODAL_ID = "fundShiftModal";

exports.PIN_BRAND_COLOR = "#6A23FF";

exports.PIN_DISPLAY_FORMAT = "1234";

exports.SHIFTS_PER_PAGE = 10;

exports.SHIFT_STATUS_FILTERS = [
  {
    value: "all",
    label: "All Shifts",
  },
  {
    value: "pending_funding",
    label: "Pending Funding",
  },
  {
    value: "open",
    label: "Open",
  },
  {
    value: "assigned",
    label: "Assigned",
  },
  {
    value: "confirmed",
    label: "Confirmed",
  },
  {
    value: "in_progress",
    label: "In Progress",
  },
  {
    value: "pending_settlement",
    label: "Pending Settlement",
  },
  {
    value: "completed",
    label: "Completed",
  },
  {
    value: "cancelled",
    label: "Cancelled",
  },
  {
    value: "disputed",
    label: "Disputed",
  },
  {
    value: "no_show",
    label: "No-show",
  },
];
