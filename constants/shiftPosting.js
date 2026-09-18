// constants/shiftPosting.js

exports.SHIFT_TIME_ZONE = "Africa/Lagos";

/**
 * Maximum number of shared work dates in one Shift engagement.
 *
 * This limits occurrenceCount and each slot's sequence range.
 * It does not limit the total number of ShiftOccurrence documents.
 *
 * Total occurrence records:
 *
 * occurrenceCount × requiredProfessionals
 *
 * Example:
 * 10 work dates × 3 professional positions = 30 occurrence records.
 */
exports.MAX_SHIFT_OCCURRENCES = 30;

exports.MINUTES_PER_DAY = 24 * 60;

exports.MILLISECONDS_PER_MINUTE = 60 * 1000;

exports.MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

exports.MAX_GENERATION_LOOKAHEAD_DAYS = 366;

/* ─────────────────────────────── FINANCIAL RATE PRECISION ─────────────────────────────── */

/**
 * Authoritative fixed-point precision for financial percentage rates.
 *
 * Monetary amounts are stored as integer minor units.
 *
 * Percentage rates that can produce monetary amounts remain represented as
 * decimal Number values at the model/settings boundary, but they must be
 * exactly representable at this scale before participating in authoritative
 * financial arithmetic.
 *
 * Example:
 *
 *   0.145
 *   -> 145000 / 1000000
 *
 * Authoritative monetary calculations then use:
 *
 *   minorUnitAmount × scaledRate
 *   ────────────────────────────
 *          rateScale
 *
 * through utils/money.js using BigInt arithmetic and deterministic half-up
 * rounding.
 *
 * This scale currently applies to:
 *
 * - platformFeeRate;
 * - lateCancellationProfessionalPayRate; and
 * - activeWorkCancellationMinimumPayRate.
 *
 * A rate requiring more than six decimal places is rejected rather than
 * silently rounded.
 *
 * For multiple professionals, calculate and round each occurrence's
 * professional pay and platform fee before aggregating across dates and slots.
 */
const FINANCIAL_RATE_SCALE = 1_000_000;

exports.FINANCIAL_RATE_SCALE = FINANCIAL_RATE_SCALE;

/* ─────────────────────────────── PROFESSIONAL TYPES ─────────────────────────────── */

/**
 * One Shift selects one professional type.
 * Every professional position within that Shift uses the selected type.
 */
exports.PROFESSIONAL_TYPE_OPTIONS = [
  {
    value: "pharmacist",
    label: "Pharmacist",
  },
  {
    value: "pharmacy_technician",
    label: "Pharmacy Technician",
  },
  {
    value: "nurse",
    label: "Nurse",
  },
  {
    value: "doctor",
    label: "Doctor",
  },
  {
    value: "lab_scientist",
    label: "Laboratory Scientist",
  },
  {
    value: "radiographer",
    label: "Radiographer",
  },
  {
    value: "physiotherapist",
    label: "Physiotherapist",
  },
];

exports.ACTIVE_SHIFT_PROFESSIONAL_TYPES = ["pharmacist"];

/* ─────────────────────────────── SCHEDULE MODES ─────────────────────────────── */

/**
 * Schedule mode describes work dates.
 * requiredProfessionals independently determines the number of positions.
 *
 * Both modes support one or more professionals sharing the same branch
 * and schedule, with independent assignments and occurrence records.
 */
exports.SCHEDULE_MODE_OPTIONS = [
  {
    value: "single",
    label: "Single Shift",
    description: "Post one work date for one or more professionals.",
  },
  {
    value: "multiple",
    label: "Multiple Shifts",
    description:
      "Post one engagement containing up to 30 repeated work dates for one or more professionals.",
  },
];

/* ─────────────────────────────── REPEAT DAYS ─────────────────────────────── */

exports.REPEAT_DAY_OPTIONS = [
  {
    value: 1,
    shortLabel: "Mon",
    label: "Monday",
  },
  {
    value: 2,
    shortLabel: "Tue",
    label: "Tuesday",
  },
  {
    value: 3,
    shortLabel: "Wed",
    label: "Wednesday",
  },
  {
    value: 4,
    shortLabel: "Thu",
    label: "Thursday",
  },
  {
    value: 5,
    shortLabel: "Fri",
    label: "Friday",
  },
  {
    value: 6,
    shortLabel: "Sat",
    label: "Saturday",
  },
  {
    value: 0,
    shortLabel: "Sun",
    label: "Sunday",
  },
];
