// utils/money.js

const MINOR_UNIT_FACTOR = 100;

/* ---------- Check blank value ---------- */
const isBlank = (value) => value === null || value === undefined || value === "";

/* ---------- Round money safely to 2 decimal places ---------- */
exports.roundMoney = (amount) => {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    throw new Error("Invalid money amount");
  }

  return Math.round((numericAmount + Number.EPSILON) * 100) / 100;
};

/* ---------- Convert major-unit amount to minor-unit amount ---------- */
/*
 * Example:
 * ₦5,000.00 -> 500000
 * $5,000.00 -> 500000
 */
exports.toMinorUnit = (amount) => {
  const roundedAmount = exports.roundMoney(amount);

  return Math.round(roundedAmount * MINOR_UNIT_FACTOR);
};

/* ---------- Convert minor-unit amount to major-unit amount ---------- */
/*
 * Example:
 * 500000 -> 5000
 */
exports.fromMinorUnit = (amount) => {
  const minorAmount = exports.normalizeMinorUnitAmount(amount, "Money amount");

  return minorAmount / MINOR_UNIT_FACTOR;
};

/* ---------- Validate non-negative minor-unit amount ---------- */
/*
 * Used for stored balances, transaction amounts, provider fees, and net amounts.
 * Valid: 0, 500000, 1000000
 * Invalid: -500000, 5000.75, "abc"
 */
exports.normalizeMinorUnitAmount = (amount, fieldName = "Money amount") => {
  if (isBlank(amount)) {
    throw new Error(`${fieldName} is required.`);
  }

  const numericAmount = Number(amount);

  if (!Number.isInteger(numericAmount) || numericAmount < 0) {
    throw new Error(`${fieldName} must be a non-negative integer minor-unit amount.`);
  }

  return numericAmount;
};

/* ---------- Validate positive minor-unit amount ---------- */
/*
 * Used for wallet movement amounts.
 * Valid: 1, 500000
 * Invalid: 0, -500000, 5000.75
 */
exports.normalizePositiveMinorUnitAmount = (amount, fieldName = "Money amount") => {
  const numericAmount = exports.normalizeMinorUnitAmount(amount, fieldName);

  if (numericAmount <= 0) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }

  return numericAmount;
};

/* ---------- Validate signed minor-unit amount ---------- */
/*
 * Used for balance deltas.
 * Valid: -500000, 0, 500000
 * Invalid: 5000.75, "abc"
 */
exports.normalizeSignedMinorUnitAmount = (amount, fieldName = "Money amount") => {
  if (isBlank(amount)) {
    throw new Error(`${fieldName} is required.`);
  }

  const numericAmount = Number(amount);

  if (!Number.isInteger(numericAmount)) {
    throw new Error(`${fieldName} must be an integer minor-unit amount.`);
  }

  return numericAmount;
};

/* ---------- Format minor-unit amount for display ---------- */
/*
 * Example:
 * formatMoney(500000, "NGN") -> ₦5,000.00
 */
exports.formatMoney = (amount, currency = "NGN", locale = "en-NG") => {
  const majorAmount = exports.fromMinorUnit(amount);

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(majorAmount);
};

/* ---------- Calculate professional pay ---------- */
/*
 * Returns major-unit amount.
 * Example: 5000 means ₦5,000.00.
 */
exports.calculateProfessionalPay = (hourlyRate, billableHours) => {
  const rate = Number(hourlyRate);
  const hours = Number(billableHours);

  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error("Invalid hourly rate");
  }

  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error("Invalid billable hours");
  }

  return exports.roundMoney(rate * hours);
};

/* ---------- Calculate Loqum employer-side platform fee ---------- */
/*
 * Returns major-unit amount.
 */
exports.calculatePlatformFee = (professionalPay, platformFeeRate) => {
  const pay = Number(professionalPay);
  const feeRate = Number(platformFeeRate);

  if (!Number.isFinite(pay) || pay < 0) {
    throw new Error("Invalid professional pay");
  }

  if (!Number.isFinite(feeRate) || feeRate < 0) {
    throw new Error("Invalid platform fee rate");
  }

  return exports.roundMoney(pay * feeRate);
};

/* ---------- Calculate total amount employer pays ---------- */
/*
 * Returns major-unit amount.
 */
exports.calculateEmployerCharge = (professionalPay, platformFee) => {
  const pay = Number(professionalPay);
  const fee = Number(platformFee);

  if (!Number.isFinite(pay) || pay < 0) {
    throw new Error("Invalid professional pay");
  }

  if (!Number.isFinite(fee) || fee < 0) {
    throw new Error("Invalid platform fee");
  }

  return exports.roundMoney(pay + fee);
};

/* ---------- Calculate full shift pricing ---------- */
/*
 * Returns major-unit pricing values.
 * Convert to minor units only when funding wallet/escrow or creating transactions.
 */
exports.calculateShiftPricing = ({ hourlyRate, scheduledHours, platformFeeRate }) => {
  const estimatedProfessionalPay = exports.calculateProfessionalPay(hourlyRate, scheduledHours);

  const estimatedPlatformFee = exports.calculatePlatformFee(
    estimatedProfessionalPay,
    platformFeeRate
  );

  const estimatedEmployerCharge = exports.calculateEmployerCharge(
    estimatedProfessionalPay,
    estimatedPlatformFee
  );

  return {
    hourlyRate: exports.roundMoney(hourlyRate),
    scheduledHours,
    platformFeeRate,
    estimatedProfessionalPay,
    estimatedPlatformFee,
    estimatedEmployerCharge,
  };
};

/* ---------- Calculate extra amount employer needs to add ---------- */
/*
 * Returns major-unit amount.
 */
exports.calculateTopUpRequired = (finalEmployerCharge, fundedAmount) => {
  const finalCharge = Number(finalEmployerCharge);
  const funded = Number(fundedAmount);

  if (!Number.isFinite(finalCharge) || finalCharge < 0) {
    throw new Error("Invalid final employer charge");
  }

  if (!Number.isFinite(funded) || funded < 0) {
    throw new Error("Invalid funded amount");
  }

  return exports.roundMoney(Math.max(finalCharge - funded, 0));
};

/* ---------- Calculate amount to refund to employer wallet ---------- */
/*
 * Returns major-unit amount.
 */
exports.calculateRefundAmount = (fundedAmount, finalEmployerCharge) => {
  const funded = Number(fundedAmount);
  const finalCharge = Number(finalEmployerCharge);

  if (!Number.isFinite(funded) || finalCharge < 0) {
    throw new Error("Invalid funded amount");
  }

  if (!Number.isFinite(finalCharge) || finalCharge < 0) {
    throw new Error("Invalid final employer charge");
  }

  return exports.roundMoney(Math.max(funded - finalCharge, 0));
};
