// models/helpers/schemaValidators.js

const money = require("../../utils/money");

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

exports.isNonNegativeSafeInteger = function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
};

exports.isPositiveSafeInteger = function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
};

exports.isSignedSafeInteger = function isSignedSafeInteger(value) {
  return Number.isSafeInteger(value);
};

exports.isNullableSafeInteger = function isNullableSafeInteger(value) {
  return value === null || value === undefined || Number.isSafeInteger(value);
};

exports.isValidLocalDateString = function isValidLocalDateString(value) {
  const normalizedValue = String(value || "");

  if (!LOCAL_DATE_PATTERN.test(normalizedValue)) {
    return false;
  }

  const [year, month, day] = normalizedValue.split("-").map(Number);

  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  return (
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day
  );
};

exports.isNullableLocalDateString = function isNullableLocalDateString(value) {
  if (value === null || value === undefined || value === "") {
    return true;
  }

  return exports.isValidLocalDateString(value);
};

exports.isValidTimeZone = function isValidTimeZone(value) {
  if (!value) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).format();

    return true;
  } catch (error) {
    return false;
  }
};

exports.approximatelyEqual = function approximatelyEqual(left, right, tolerance = 0.000001) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
};

exports.hasDocumentValue = function hasDocumentValue(value) {
  return value !== null && value !== undefined && value !== "";
};

exports.hasCompleteAmountTriple = function hasCompleteAmountTriple({
  professionalPay,
  platformFee,
  employerCharge,
}) {
  return [professionalPay, platformFee, employerCharge].every(exports.isNonNegativeSafeInteger);
};

exports.validateAmountTriple = function validateAmountTriple(
  document,
  { professionalPath, platformPath, employerPath, label }
) {
  const professionalPay = document.get(professionalPath);

  const platformFee = document.get(platformPath);

  const employerCharge = document.get(employerPath);

  const suppliedValues = [professionalPay, platformFee, employerCharge].filter(
    exports.hasDocumentValue
  );

  if (suppliedValues.length === 0) {
    return;
  }

  if (
    !exports.hasCompleteAmountTriple({
      professionalPay,
      platformFee,
      employerCharge,
    })
  ) {
    document.invalidate(
      employerPath,
      `${label} professional pay, platform fee and employer charge must be complete non-negative whole amounts.`
    );

    return;
  }

  let expectedEmployerCharge;

  try {
    expectedEmployerCharge = money.sumMinorUnitAmounts(
      [professionalPay, platformFee],
      `${label} employer charge`
    );
  } catch (error) {
    document.invalidate(
      employerPath,
      `${label} employer charge exceeds the supported safe-integer range.`
    );

    return;
  }

  if (employerCharge !== expectedEmployerCharge) {
    document.invalidate(
      employerPath,
      `${label} employer charge must equal professional pay plus platform fee.`
    );
  }
};

exports.sumSafeIntegerValues = function sumSafeIntegerValues(values) {
  if (!Array.isArray(values)) {
    return null;
  }

  try {
    return money.sumMinorUnitAmounts(values, "Safe integer amount total");
  } catch (error) {
    return null;
  }
};
