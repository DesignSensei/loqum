// services/helpers/serviceValidationHelpers.js

const mongoose = require("mongoose");

exports.normalizeFieldCode = function normalizeFieldCode(value) {
  return String(value)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

exports.normalizeObjectId = function normalizeObjectId({
  value,
  fieldName,
  required = true,
  createError,
}) {
  if (value === null || value === undefined || value === "") {
    if (!required) {
      return null;
    }

    throw createError({
      message: `${fieldName} is required.`,

      code: `${exports.normalizeFieldCode(fieldName)}_REQUIRED`,
    });
  }

  if (!mongoose.isValidObjectId(value)) {
    throw createError({
      message: `A valid ${fieldName} is required.`,

      code: `INVALID_${exports.normalizeFieldCode(fieldName)}`,
    });
  }

  return new mongoose.Types.ObjectId(String(value));
};

exports.normalizeOptionalText = function normalizeOptionalText({
  value,
  fieldName,
  maximumLength,
  createError,
  emptyValue = null,
}) {
  const normalizedValue = String(value ?? "").trim();

  if (!normalizedValue) {
    return emptyValue;
  }

  if (normalizedValue.length > maximumLength) {
    throw createError({
      message: `${fieldName} cannot exceed ` + `${maximumLength} characters.`,

      code: `${exports.normalizeFieldCode(fieldName)}_TOO_LONG`,
    });
  }

  return normalizedValue;
};
