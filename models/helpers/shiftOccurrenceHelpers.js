// models/helpers/shiftOccurrenceHelpers.js

const { hasDocumentValue } = require("./schemaValidators");

/* ─────────────────────────────── AMOUNT HELPERS ─────────────────────────────── */

/**
 * Convenience accessor for occurrence model validation.
 *
 * Monetary authority and arithmetic do not belong in this helper.
 *
 * Authoritative financial calculations are performed through utils/money.js
 * by the relevant model/service validation paths.
 *
 * This helper only normalizes an already-stored numeric model value for
 * comparison inside ShiftOccurrence validation.
 */
exports.amount = function amount(value) {
  return Number(value ?? 0);
};

/* ─────────────────────────────── DOCUMENT-VALUE HELPERS ─────────────────────────────── */

exports.hasAll = function hasAll(values) {
  return Array.isArray(values) && values.every(hasDocumentValue);
};

exports.hasAny = function hasAny(values) {
  return Array.isArray(values) && values.some(hasDocumentValue);
};

/* ─────────────────────────────── VALIDATION HELPERS ─────────────────────────────── */

exports.validateDetailsLength = function validateDetailsLength(document, path, value, label) {
  if (value && value.length < 10) {
    document.invalidate(path, `${label} must contain at least 10 characters when provided.`);
  }
};
