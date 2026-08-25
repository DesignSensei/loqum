// services/shiftService.js

const ShiftCreationService = require("./shifts/shiftCreationService");
const ShiftQueryService = require("./shifts/shiftQueryService");
const ShiftViewService = require("./shifts/shiftViewService");

const { createShiftError } = require("./shifts/helpers/shiftServiceHelpers");

class ShiftService {
  /* ─────────────────────────────── CREATE SHIFT ─────────────────────────────── */

  static resolveCreatedShiftCurrency(creationResult) {
    const currency = String(
      creationResult?.pricing?.currency || creationResult?.shift?.currency || ""
    )
      .trim()
      .toUpperCase();

    if (!currency) {
      throw createShiftError({
        message: "The created Shift currency could not be resolved.",
        code: "CREATED_SHIFT_CURRENCY_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    return currency;
  }

  static assertValidCreationResult(creationResult) {
    if (!creationResult || typeof creationResult !== "object" || Array.isArray(creationResult)) {
      throw createShiftError({
        message: "The Shift creation result is invalid.",
        code: "INVALID_SHIFT_CREATION_RESULT",
        statusCode: 500,
      });
    }

    if (!creationResult.shift?._id) {
      throw createShiftError({
        message: "The created Shift could not be resolved.",
        code: "CREATED_SHIFT_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    if (!Array.isArray(creationResult.occurrences)) {
      throw createShiftError({
        message: "The created Shift occurrences could not be resolved.",
        code: "CREATED_SHIFT_OCCURRENCES_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    if (!creationResult.employerWallet) {
      throw createShiftError({
        message: "The employer wallet could not be resolved after Shift creation.",
        code: "CREATED_SHIFT_EMPLOYER_WALLET_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    return creationResult;
  }

  static async createShift(options = {}) {
    /*
     * ShiftCreationService is the authoritative creation boundary.
     *
     * It owns:
     * - employer role eligibility;
     * - business eligibility;
     * - employer delinquency enforcement;
     * - branch authorization;
     * - schedule construction;
     * - pricing snapshots;
     * - occurrence creation;
     * - pricing lock;
     * - neutral pending-funding state; and
     * - prevention of client-supplied mixed funding state.
     *
     * This facade must not duplicate those rules.
     */
    const creationResult = await ShiftCreationService.createShift(options);

    ShiftService.assertValidCreationResult(creationResult);

    const { employerWallet, ...publicResult } = creationResult;

    const currency = ShiftService.resolveCreatedShiftCurrency(publicResult);

    /*
     * employerWallet is intentionally used only to build the payment
     * review and is not exposed directly in the public creation result.
     */
    const paymentReview = ShiftViewService.buildShiftPaymentReview({
      shift: publicResult.shift,

      occurrences: publicResult.occurrences,

      employerWallet,

      currency,

      currentTime: options.currentTime || new Date(),
    });

    return {
      ...publicResult,

      paymentReview,
    };
  }

  /* ─────────────────────────────── SHIFT QUERIES ─────────────────────────────── */

  static async getEmployerShiftsPageData(options) {
    return ShiftQueryService.getEmployerShiftsPageData(options);
  }

  static async getEmployerShiftDetailsPageData(options) {
    return ShiftQueryService.getEmployerShiftDetailsPageData(options);
  }

  /* ─────────────────────────────── SHARED ERROR CONTRACT ─────────────────────────────── */

  static createShiftError(options) {
    return createShiftError(options);
  }
}

module.exports = ShiftService;
a;
