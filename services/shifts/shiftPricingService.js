// services/shifts/shiftPricingService.js

const money = require("../../utils/money");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const { createServiceError } = require("../helpers/serviceErrorHelper");

const { normalizeFieldCode } = require("../helpers/serviceValidationHelpers");

const SHIFT_SERVICE_ERROR_NAME = "ShiftServiceError";

function createShiftError(options) {
  return createServiceError({
    ...options,

    name: SHIFT_SERVICE_ERROR_NAME,
  });
}

class ShiftPricingService {
  /* ─────────────────────────────── HOURLY RATE ─────────────────────────────── */

  static normalizeHourlyRateToMinorUnit(value) {
    const cleanValue = String(value ?? "")
      .trim()
      .replace(/,/g, "");

    /*
     * Shift posting accepts a positive major-unit hourly rate
     * with at most two decimal places.
     *
     * Keep the value as a string until money.toMinorUnit()
     * performs the exact decimal-to-minor-unit conversion.
     *
     * Do not convert the input to Number first.
     */
    if (!/^\d+(\.\d{1,2})?$/.test(cleanValue)) {
      throw createShiftError({
        message: "Enter a valid hourly rate.",

        code: "INVALID_HOURLY_RATE",
      });
    }

    let hourlyRate;

    try {
      hourlyRate = money.toMinorUnit(cleanValue);
    } catch (error) {
      throw createShiftError({
        message: "Enter a valid hourly rate.",

        code: "INVALID_HOURLY_RATE",

        cause: error,
      });
    }

    if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) {
      throw createShiftError({
        message: "Hourly rate must be greater than zero.",

        code: "INVALID_HOURLY_RATE",
      });
    }

    return hourlyRate;
  }

  /* ─────────────────────────────── RATE VALIDATION ─────────────────────────────── */

  static normalizeFinancialRate(
    value,
    fieldName,
    {
      code = null,

      statusCode = 500,
    } = {}
  ) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw createShiftError({
        message: `${fieldName} is invalid.`,

        code: code || `INVALID_${normalizeFieldCode(fieldName)}`,

        statusCode,
      });
    }

    /*
     * Validate that the decimal rate can be represented exactly
     * by Loqum's fixed-point rate scale.
     *
     * This does not calculate money.
     *
     * It prevents a rate with more precision than the configured
     * scale supports from being silently rounded before it is
     * snapshotted into Shift financial state.
     */
    try {
      money.scaleRate({
        rate: value,

        rateScale: FINANCIAL_RATE_SCALE,

        fieldName,
      });
    } catch (error) {
      throw createShiftError({
        message:
          `${fieldName} cannot be represented by the supported ` + "financial rate precision.",

        code: code || `INVALID_${normalizeFieldCode(fieldName)}`,

        statusCode,

        cause: error,
      });
    }

    return value;
  }

  /* ─────────────────────────────── CANCELLATION POLICY ─────────────────────────────── */

  static normalizeCancellationPolicy(value) {
    const policy = value && typeof value === "object" && !Array.isArray(value) ? value : null;

    if (!policy) {
      throw createShiftError({
        message: "The active Shift cancellation policy could not be resolved.",

        code: "SHIFT_CANCELLATION_POLICY_NOT_RESOLVED",

        statusCode: 500,
      });
    }

    const lateCancellationWindowMinutes = Number(policy.lateCancellationWindowMinutes);

    if (!Number.isSafeInteger(lateCancellationWindowMinutes) || lateCancellationWindowMinutes < 0) {
      throw createShiftError({
        message: "The active late-cancellation window is invalid.",

        code: "INVALID_LATE_CANCELLATION_WINDOW",

        statusCode: 500,
      });
    }

    const lateCancellationProfessionalPayRate = ShiftPricingService.normalizeFinancialRate(
      Number(policy.lateCancellationProfessionalPayRate),

      "lateCancellationProfessionalPayRate",

      {
        code: "INVALID_LATE_CANCELLATION_PROFESSIONAL_PAY_RATE",

        statusCode: 500,
      }
    );

    const activeWorkCancellationMinimumPayRate = ShiftPricingService.normalizeFinancialRate(
      Number(policy.activeWorkCancellationMinimumPayRate),

      "activeWorkCancellationMinimumPayRate",

      {
        code: "INVALID_ACTIVE_WORK_CANCELLATION_MINIMUM_PAY_RATE",

        statusCode: 500,
      }
    );

    return {
      lateCancellationWindowMinutes,

      lateCancellationProfessionalPayRate,

      activeWorkCancellationMinimumPayRate,
    };
  }

  /* ─────────────────────────────── PRICING CALCULATION ─────────────────────────────── */

  static assertCalculatedMinorUnitAmount(value, fieldName, { positive = false } = {}) {
    const valid = Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);

    if (!valid) {
      throw createShiftError({
        message: `The calculated ${fieldName} is invalid or too large.`,

        code: "CALCULATED_AMOUNT_TOO_LARGE",

        statusCode: 500,
      });
    }

    return value;
  }

  static calculateShiftPricing({
    hourlyRate,

    scheduledMinutes,

    platformFeeRate,
  }) {
    if (!Number.isSafeInteger(hourlyRate) || hourlyRate <= 0) {
      throw createShiftError({
        message: "Hourly rate must be a positive whole number in minor units.",

        code: "INVALID_HOURLY_RATE",
      });
    }

    if (!Number.isSafeInteger(scheduledMinutes) || scheduledMinutes <= 0) {
      throw createShiftError({
        message: "Scheduled minutes must be greater than zero.",

        code: "INVALID_SCHEDULED_MINUTES",
      });
    }

    const normalizedPlatformFeeRate = ShiftPricingService.normalizeFinancialRate(
      platformFeeRate,

      "platform fee rate",

      {
        code: "INVALID_PLATFORM_FEE_RATE",

        statusCode: 500,
      }
    );

    /*
     * AUTHORITATIVE POSTING-TIME PRICING
     *
     * Money is already represented in integer minor units.
     *
     * Professional pay:
     *
     *   hourlyRate × scheduledMinutes
     *   ─────────────────────────────
     *                60
     *
     * is calculated with BigInt integer arithmetic and
     * deterministic half-up division inside utils/money.js.
     */
    let estimatedProfessionalPay;

    try {
      estimatedProfessionalPay = money.calculateMinorPayFromMinutes({
        hourlyRateMinor: hourlyRate,

        minutes: scheduledMinutes,

        fieldName: "Estimated professional pay",
      });
    } catch (error) {
      throw createShiftError({
        message: "The calculated professional pay is invalid or too large.",

        code: "CALCULATED_AMOUNT_TOO_LARGE",

        statusCode: 500,

        cause: error,
      });
    }

    ShiftPricingService.assertCalculatedMinorUnitAmount(
      estimatedProfessionalPay,

      "professional pay",

      {
        positive: true,
      }
    );

    /*
     * Platform fee:
     *
     *   estimatedProfessionalPay × scaled platformFeeRate
     *   ─────────────────────────────────────────────────
     *                     RATE_SCALE
     *
     * No authoritative money × floating-point-rate
     * multiplication occurs here.
     */
    let estimatedPlatformFee;

    try {
      estimatedPlatformFee = money.calculateMinorAmountFromRate({
        amountMinor: estimatedProfessionalPay,

        rate: normalizedPlatformFeeRate,

        rateScale: FINANCIAL_RATE_SCALE,

        fieldName: "Estimated platform fee",

        rateFieldName: "Platform fee rate",
      });
    } catch (error) {
      throw createShiftError({
        message: "The calculated platform fee is invalid or too large.",

        code: "CALCULATED_AMOUNT_TOO_LARGE",

        statusCode: 500,

        cause: error,
      });
    }

    ShiftPricingService.assertCalculatedMinorUnitAmount(
      estimatedPlatformFee,

      "platform fee"
    );

    /*
     * Employer charge contains no decimal arithmetic.
     *
     * It is the exact sum of two authoritative minor-unit
     * integer amounts.
     */
    let estimatedEmployerCharge;

    try {
      estimatedEmployerCharge = money.sumMinorUnitAmounts(
        [estimatedProfessionalPay, estimatedPlatformFee],

        "Estimated employer charge"
      );
    } catch (error) {
      throw createShiftError({
        message: "The calculated employer charge is invalid or too large.",

        code: "CALCULATED_AMOUNT_TOO_LARGE",

        statusCode: 500,

        cause: error,
      });
    }

    ShiftPricingService.assertCalculatedMinorUnitAmount(
      estimatedEmployerCharge,

      "employer charge",

      {
        positive: true,
      }
    );

    return {
      estimatedProfessionalPay,

      estimatedPlatformFee,

      estimatedEmployerCharge,
    };
  }

  /* ─────────────────────────────── AGGREGATION ─────────────────────────────── */

  static sumSafeIntegerAmounts(values, fieldName) {
    if (!Array.isArray(values)) {
      throw createShiftError({
        message: `${fieldName} must be an array of amounts.`,

        code: `INVALID_${normalizeFieldCode(fieldName)}`,

        statusCode: 500,
      });
    }

    try {
      return money.sumMinorUnitAmounts(
        values,

        fieldName
      );
    } catch (error) {
      const containsInvalidAmount = values.some(
        (value) => !Number.isSafeInteger(value) || value < 0
      );

      throw createShiftError({
        message: containsInvalidAmount
          ? `${fieldName} contains an invalid amount.`
          : `${fieldName} is too large.`,

        code: containsInvalidAmount
          ? `INVALID_${normalizeFieldCode(fieldName)}`
          : `${normalizeFieldCode(fieldName)}_TOO_LARGE`,

        statusCode: 500,

        cause: error,
      });
    }
  }
}

module.exports = ShiftPricingService;
