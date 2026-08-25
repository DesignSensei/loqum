// utils/money.js

const MINOR_UNIT_FACTOR = 100;

const MAX_DECIMAL_EXPONENT = 100;

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/* ─────────────────────────────── INTERNAL HELPERS ─────────────────────────────── */

function isBlank(value) {
  return value === null || value === undefined || value === "";
}

function assertPowerOfTenScale(scale, fieldName = "Scale") {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer.`);
  }

  let remaining = scale;

  let decimalPlaces = 0;

  while (remaining > 1 && remaining % 10 === 0) {
    remaining /= 10;

    decimalPlaces += 1;
  }

  if (remaining !== 1) {
    throw new Error(`${fieldName} must be a power of ten.`);
  }

  return decimalPlaces;
}

function parseDecimal(value, fieldName) {
  if (isBlank(value)) {
    throw new Error(`${fieldName} is required.`);
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite decimal value.`);
  }

  if (!["string", "number", "bigint"].includes(typeof value)) {
    throw new Error(`${fieldName} must be a decimal value.`);
  }

  const normalizedValue = String(value).trim();

  const match = normalizedValue.match(DECIMAL_PATTERN);

  if (!match) {
    throw new Error(`${fieldName} must be a valid decimal value.`);
  }

  const sign = match[1] === "-" ? -1n : 1n;

  const integerPart = match[2];

  const fractionalPart = match[3] || "";

  const exponent = Number(match[4] || 0);

  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) {
    throw new Error(`${fieldName} exponent is outside the supported range.`);
  }

  const digits = `${integerPart}${fractionalPart}`.replace(/^0+(?=\d)/, "") || "0";

  return {
    sign,

    digits: BigInt(digits),

    decimalExponent: exponent - fractionalPart.length,
  };
}

function decimalToScaledBigInt(
  value,
  scale,
  {
    fieldName = "Decimal value",

    allowRounding = false,
  } = {}
) {
  const scaleDecimalPlaces = assertPowerOfTenScale(
    scale,

    "Decimal scale"
  );

  const {
    sign,

    digits,

    decimalExponent,
  } = parseDecimal(value, fieldName);

  const scaleShift = decimalExponent + scaleDecimalPlaces;

  let scaledAbsoluteValue;

  if (scaleShift >= 0) {
    scaledAbsoluteValue = digits * 10n ** BigInt(scaleShift);
  } else {
    const divisor = 10n ** BigInt(-scaleShift);

    const quotient = digits / divisor;

    const remainder = digits % divisor;

    if (remainder !== 0n && !allowRounding) {
      throw new Error(`${fieldName} has more precision than the configured scale supports.`);
    }

    scaledAbsoluteValue = quotient;

    if (allowRounding && remainder * 2n >= divisor) {
      scaledAbsoluteValue += 1n;
    }
  }

  return sign * scaledAbsoluteValue;
}

function bigIntToSafeInteger(value, fieldName) {
  if (typeof value !== "bigint") {
    throw new Error(`${fieldName} must be an integer calculation result.`);
  }

  const numberValue = Number(value);

  if (!Number.isSafeInteger(numberValue) || BigInt(numberValue) !== value) {
    throw new Error(`${fieldName} is outside the safe integer range.`);
  }

  return numberValue;
}

function integerToBigInt(
  value,
  fieldName,
  {
    allowNegative = false,

    positive = false,
  } = {}
) {
  let normalizedValue;

  if (typeof value === "bigint") {
    normalizedValue = value;
  } else if (Number.isSafeInteger(value)) {
    normalizedValue = BigInt(value);
  } else {
    throw new Error(`${fieldName} must be a safe integer.`);
  }

  if (!allowNegative && normalizedValue < 0n) {
    throw new Error(`${fieldName} cannot be negative.`);
  }

  if (positive && normalizedValue <= 0n) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }

  return normalizedValue;
}

/* ─────────────────────────────── BOUNDARY CONVERSION ─────────────────────────────── */

/*
 * Round a major-unit amount to two decimal places.
 *
 * This is a boundary/display helper.
 *
 * Authoritative Loqum domain money should remain integer minor units
 * once it enters the system.
 */
exports.roundMoney = function roundMoney(amount) {
  const scaledAmount = decimalToScaledBigInt(
    amount,

    MINOR_UNIT_FACTOR,

    {
      fieldName: "Money amount",

      allowRounding: true,
    }
  );

  const minorAmount = bigIntToSafeInteger(
    scaledAmount,

    "Money amount"
  );

  return minorAmount / MINOR_UNIT_FACTOR;
};

/*
 * Convert a major-unit amount to integer minor units.
 *
 * Decimal parsing is exact before deterministic half-up rounding
 * at the minor-unit boundary.
 *
 * Examples:
 *
 * ₦5,000.00 -> 500000
 * ₦1.005    -> 101
 */
exports.toMinorUnit = function toMinorUnit(amount) {
  const scaledAmount = decimalToScaledBigInt(
    amount,

    MINOR_UNIT_FACTOR,

    {
      fieldName: "Money amount",

      allowRounding: true,
    }
  );

  return bigIntToSafeInteger(
    scaledAmount,

    "Money amount"
  );
};

/*
 * Convert integer minor units to a major-unit display number.
 *
 * Example:
 *
 * 500000 -> 5000
 */
exports.fromMinorUnit = function fromMinorUnit(amount) {
  const minorAmount = exports.normalizeMinorUnitAmount(
    amount,

    "Money amount"
  );

  return minorAmount / MINOR_UNIT_FACTOR;
};

/* ─────────────────────────────── MINOR-UNIT VALIDATION ─────────────────────────────── */

/*
 * Validate a non-negative minor-unit amount.
 *
 * Stored financial values must be safe integers so JavaScript can
 * represent them exactly.
 */
exports.normalizeMinorUnitAmount = function normalizeMinorUnitAmount(
  amount,

  fieldName = "Money amount"
) {
  if (isBlank(amount)) {
    throw new Error(`${fieldName} is required.`);
  }

  const numericAmount = Number(amount);

  if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) {
    throw new Error(`${fieldName} must be a non-negative integer minor-unit amount.`);
  }

  return numericAmount;
};

/*
 * Validate a positive minor-unit amount.
 */
exports.normalizePositiveMinorUnitAmount = function normalizePositiveMinorUnitAmount(
  amount,

  fieldName = "Money amount"
) {
  const numericAmount = exports.normalizeMinorUnitAmount(
    amount,

    fieldName
  );

  if (numericAmount <= 0) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }

  return numericAmount;
};

/*
 * Validate a signed minor-unit amount.
 *
 * Used for balance deltas.
 */
exports.normalizeSignedMinorUnitAmount = function normalizeSignedMinorUnitAmount(
  amount,

  fieldName = "Money amount"
) {
  if (isBlank(amount)) {
    throw new Error(`${fieldName} is required.`);
  }

  const numericAmount = Number(amount);

  if (!Number.isSafeInteger(numericAmount)) {
    throw new Error(`${fieldName} must be an integer minor-unit amount.`);
  }

  return numericAmount;
};

/* ─────────────────────────────── FIXED-POINT RATE HELPERS ─────────────────────────────── */

/*
 * Convert a decimal rate to an exact scaled integer representation.
 *
 * The caller owns the rate scale.
 *
 * This keeps utils/money.js neutral and prevents a second hidden
 * rate-scale authority from being introduced here.
 *
 * Example:
 *
 * rateScale = 1_000_000
 *
 * 0.145 -> 145000
 *
 * A rate with more precision than the supplied scale supports is
 * rejected rather than silently rounded.
 */
exports.scaleRate = function scaleRate({
  rate,

  rateScale,

  fieldName = "Rate",
}) {
  assertPowerOfTenScale(
    rateScale,

    "Rate scale"
  );

  const scaledRate = decimalToScaledBigInt(
    rate,

    rateScale,

    {
      fieldName,

      allowRounding: false,
    }
  );

  const maximumScaledRate = BigInt(rateScale);

  if (scaledRate < 0n || scaledRate > maximumScaledRate) {
    throw new Error(`${fieldName} must be between 0 and 1.`);
  }

  return bigIntToSafeInteger(
    scaledRate,

    `${fieldName} scaled value`
  );
};

/*
 * Validate an already-scaled rate.
 *
 * Example:
 *
 * rateScale = 1_000_000
 * scaledRate = 145000
 */
exports.normalizeScaledRate = function normalizeScaledRate({
  scaledRate,

  rateScale,

  fieldName = "Scaled rate",
}) {
  assertPowerOfTenScale(
    rateScale,

    "Rate scale"
  );

  const normalizedScaledRate = exports.normalizeMinorUnitAmount(
    scaledRate,

    fieldName
  );

  if (normalizedScaledRate > rateScale) {
    throw new Error(`${fieldName} cannot exceed the configured rate scale.`);
  }

  return normalizedScaledRate;
};

/* ─────────────────────────────── AUTHORITATIVE INTEGER ARITHMETIC ─────────────────────────────── */

/*
 * Divide a non-negative integer numerator by a positive integer
 * denominator using deterministic half-up rounding.
 *
 * Number safe integers and BigInt values are accepted.
 *
 * A Number safe integer is returned because current Loqum Mongo
 * monetary fields are stored as Number minor-unit values.
 */
exports.divideAndRound = function divideAndRound(
  numerator,

  denominator,

  fieldName = "Calculated amount"
) {
  const normalizedNumerator = integerToBigInt(
    numerator,

    `${fieldName} numerator`
  );

  const normalizedDenominator = integerToBigInt(
    denominator,

    `${fieldName} denominator`,

    {
      positive: true,
    }
  );

  const quotient = normalizedNumerator / normalizedDenominator;

  const remainder = normalizedNumerator % normalizedDenominator;

  const roundedResult = remainder * 2n >= normalizedDenominator ? quotient + 1n : quotient;

  return bigIntToSafeInteger(
    roundedResult,

    fieldName
  );
};

/*
 * Calculate professional pay from:
 *
 * - integer minor-unit hourly rate; and
 * - integer worked/scheduled minutes.
 *
 * Formula:
 *
 * hourlyRateMinor × minutes
 * ───────────────────────
 *           60
 */
exports.calculateMinorPayFromMinutes = function calculateMinorPayFromMinutes({
  hourlyRateMinor,

  minutes,

  fieldName = "Professional pay",
}) {
  const normalizedHourlyRate = exports.normalizePositiveMinorUnitAmount(
    hourlyRateMinor,

    "Hourly rate"
  );

  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error("Minutes must be a non-negative safe integer.");
  }

  return exports.divideAndRound(
    BigInt(normalizedHourlyRate) * BigInt(minutes),

    60n,

    fieldName
  );
};

/*
 * Calculate a minor-unit amount from a fixed-point rate.
 *
 * Supply exactly one of:
 *
 * - rate
 *     Current decimal snapshot, converted exactly to scaled form.
 *
 * - scaledRate
 *     Already-scaled integer rate.
 *
 * Supplying both is rejected so that one calculation cannot contain
 * two competing rate authorities.
 */
exports.calculateMinorAmountFromRate = function calculateMinorAmountFromRate({
  amountMinor,

  rate = null,

  scaledRate = null,

  rateScale,

  fieldName = "Calculated amount",

  rateFieldName = "Rate",
}) {
  const normalizedAmount = exports.normalizeMinorUnitAmount(
    amountMinor,

    `${fieldName} source amount`
  );

  const hasRate = rate !== null && rate !== undefined && rate !== "";

  const hasScaledRate = scaledRate !== null && scaledRate !== undefined && scaledRate !== "";

  if (hasRate === hasScaledRate) {
    throw new Error(`${fieldName} requires exactly one of rate or scaledRate.`);
  }

  const normalizedScaledRate = hasScaledRate
    ? exports.normalizeScaledRate({
        scaledRate,

        rateScale,

        fieldName: `${rateFieldName} scaled value`,
      })
    : exports.scaleRate({
        rate,

        rateScale,

        fieldName: rateFieldName,
      });

  return exports.divideAndRound(
    BigInt(normalizedAmount) * BigInt(normalizedScaledRate),

    BigInt(rateScale),

    fieldName
  );
};

/*
 * Sum non-negative minor-unit amounts without permitting an unsafe
 * Number intermediate result.
 */
exports.sumMinorUnitAmounts = function sumMinorUnitAmounts(
  values,

  fieldName = "Money total"
) {
  if (!Array.isArray(values)) {
    throw new Error(`${fieldName} values must be an array.`);
  }

  let total = 0n;

  for (const value of values) {
    const normalizedValue = exports.normalizeMinorUnitAmount(
      value,

      fieldName
    );

    total += BigInt(normalizedValue);
  }

  return bigIntToSafeInteger(
    total,

    fieldName
  );
};

/* ─────────────────────────────── DISPLAY ─────────────────────────────── */

/*
 * Format an integer minor-unit amount for display.
 *
 * Example:
 *
 * formatMoney(500000, "NGN") -> ₦5,000.00
 */
exports.formatMoney = function formatMoney(
  amount,

  currency = "NGN",

  locale = "en-NG"
) {
  const majorAmount = exports.fromMinorUnit(amount);

  return new Intl.NumberFormat(locale, {
    style: "currency",

    currency,

    minimumFractionDigits: 2,

    maximumFractionDigits: 2,
  }).format(majorAmount);
};

/* ─────────────────────────────── LEGACY MAJOR-UNIT CALCULATORS ─────────────────────────────── */

/*
 * COMPATIBILITY ONLY.
 *
 * The functions below retain the pre-existing major-unit API for any
 * callers outside the current Shift financial path.
 *
 * They must not be used as authoritative Shift pricing, settlement,
 * platform-fee, cancellation, refund or payout arithmetic.
 *
 * New financial-domain code must use the integer minor-unit helpers
 * above.
 */

exports.calculateProfessionalPay = function calculateProfessionalPay(
  hourlyRate,

  billableHours
) {
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

exports.calculatePlatformFee = function calculatePlatformFee(
  professionalPay,

  platformFeeRate
) {
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

exports.calculateEmployerCharge = function calculateEmployerCharge(
  professionalPay,

  platformFee
) {
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

exports.calculateShiftPricing = function calculateShiftPricing({
  hourlyRate,

  scheduledHours,

  platformFeeRate,
}) {
  const estimatedProfessionalPay = exports.calculateProfessionalPay(
    hourlyRate,

    scheduledHours
  );

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

exports.calculateTopUpRequired = function calculateTopUpRequired(
  finalEmployerCharge,

  fundedAmount
) {
  const finalCharge = Number(finalEmployerCharge);

  const funded = Number(fundedAmount);

  if (!Number.isFinite(finalCharge) || finalCharge < 0) {
    throw new Error("Invalid final employer charge");
  }

  if (!Number.isFinite(funded) || funded < 0) {
    throw new Error("Invalid funded amount");
  }

  return exports.roundMoney(
    Math.max(
      finalCharge - funded,

      0
    )
  );
};

exports.calculateRefundAmount = function calculateRefundAmount(
  fundedAmount,

  finalEmployerCharge
) {
  const funded = Number(fundedAmount);

  const finalCharge = Number(finalEmployerCharge);

  if (!Number.isFinite(funded) || funded < 0) {
    throw new Error("Invalid funded amount");
  }

  if (!Number.isFinite(finalCharge) || finalCharge < 0) {
    throw new Error("Invalid final employer charge");
  }

  return exports.roundMoney(
    Math.max(
      funded - finalCharge,

      0
    )
  );
};
