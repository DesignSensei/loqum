// services/shiftFundingService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const Transaction = require("../models/Transaction");
const EmployerProfile = require("../models/EmployerProfile");

const WalletService = require("./walletService");
const PaystackService = require("./paystackService");
const ShiftLifecycleService = require("./shiftLifecycleService");
const ShiftOvertimeFundingService = require("./shiftOvertimeFundingService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { SHIFT_PAYMENT_RETURN_PURPOSE_BY_REASON } = require("../constants/transaction");

const { MAX_SHIFT_OCCURRENCES } = require("../constants/shiftPosting");

const money = require("../utils/money");
const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";

const PAYSTACK_OPEN_STATUSES = ["pending", "processing"];
const PAYSTACK_DEFINITIVE_FAILURE_STATUSES = ["failed", "abandoned", "reversed"];

const BASE_FUNDING_TRANSACTION_TYPE = "shift_funding";
const BASE_FUNDING_TRANSACTION_PURPOSE = "shift_base_funding";

const OVERTIME_TOPUP_TRANSACTION_TYPE = "shift_topup";
const OVERTIME_TOPUP_TRANSACTION_PURPOSE = "shift_overtime_topup";

class ShiftFundingService {
  /* ─────────────────────────────── ERRORS / NORMALIZATION ─────────────────────────────── */

  static createFundingError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: "ShiftFundingServiceError",
      message,
      code,
      statusCode,
      details,
    });

    if (cause) {
      error.cause = cause;
    }

    return error;
  }

  static validateObjectId(value, fieldName) {
    if (!value || !mongoose.isValidObjectId(value)) {
      throw ShiftFundingService.createFundingError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeCurrentTime(value) {
    const currentTime =
      value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(currentTime.getTime())) {
      throw ShiftFundingService.createFundingError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static resolveVerifiedPaymentTime(verifiedPayment) {
    const rawPaidAt = verifiedPayment?.paidAt || verifiedPayment?.paid_at || null;

    if (!rawPaidAt) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack payment does not contain a confirmed payment time.",
        code: "PAYSTACK_PAYMENT_TIME_REQUIRED",
        statusCode: 409,
      });
    }

    const paidAt = new Date(rawPaidAt);

    if (Number.isNaN(paidAt.getTime())) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack payment time is invalid.",
        code: "INVALID_PAYSTACK_PAYMENT_TIME",
        statusCode: 409,
      });
    }

    return paidAt;
  }

  static normalizeCountryCode(value, fieldName = "country code") {
    const countryCode = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw ShiftFundingService.createFundingError({
        message: `The ${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return countryCode;
  }

  static normalizeCurrency(value, fieldName = "currency") {
    const currency = String(value || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw ShiftFundingService.createFundingError({
        message: `The ${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
      });
    }

    return currency;
  }

  /* ─────────────────────────────── EMPLOYER ACCESS ─────────────────────────────── */

  static async getEmployerProfileForUser(userId, employerProfile = null) {
    const normalizedUserId = ShiftFundingService.validateObjectId(userId, "user ID");

    /*
     * Middleware may attach the primary business profile while the
     * authenticated user is an authorized admin or branch manager.
     */
    if (employerProfile?._id) {
      return employerProfile;
    }

    const profile = await EmployerProfile.findOne({
      user: normalizedUserId,
    });

    if (!profile) {
      throw ShiftFundingService.createFundingError({
        message: "Employer profile not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return profile;
  }

  static assertCanFundShifts(employerContext) {
    if (employerContext?.canFundShifts !== true) {
      throw ShiftFundingService.createFundingError({
        message: "You do not have permission to fund and publish shifts.",
        code: "SHIFT_FUNDING_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
  }

  static assertCanActivatePendingShift(employerContext) {
    if (employerContext?.canPostShifts !== true) {
      throw ShiftFundingService.createFundingError({
        message: "You do not have permission to fund and publish shifts.",
        code: "SHIFT_FUNDING_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
  }

  static roleCanResolveExistingShiftObligations(employerContext = null) {
    return employerContext?.canManageFinancialObligations === true;
  }

  static assertCanResolveExistingShiftObligations(employerContext = null) {
    if (!ShiftFundingService.roleCanResolveExistingShiftObligations(employerContext)) {
      throw ShiftFundingService.createFundingError({
        message: "You do not have permission to resolve existing Shift payment obligations.",
        code: "SHIFT_OBLIGATION_PAYMENT_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
  }

  static canManageAllBranches(employerContext) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static getAssignedBranchIds(employerContext) {
    return (employerContext?.assignedBranchIds || [])
      .filter((branchId) => mongoose.isValidObjectId(branchId))
      .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));
  }

  static buildShiftAccessFilter({ shiftId, employerProfileId, employerContext }) {
    const filter = {
      _id: ShiftFundingService.validateObjectId(shiftId, "shift ID"),

      business: ShiftFundingService.validateObjectId(employerProfileId, "employer profile ID"),
    };

    if (!ShiftFundingService.canManageAllBranches(employerContext)) {
      const assignedBranchIds = ShiftFundingService.getAssignedBranchIds(employerContext);

      if (assignedBranchIds.length === 0) {
        throw ShiftFundingService.createFundingError({
          message: "You are not assigned to a branch that can fund this Shift.",
          code: "SHIFT_BRANCH_ACCESS_NOT_AVAILABLE",
          statusCode: 403,
        });
      }

      filter.branch = {
        $in: assignedBranchIds,
      };
    }

    return filter;
  }

  static getFundingShiftFields() {
    return [
      "referenceCode",
      "business",
      "branch",
      "postedBy",
      "roleTitle",

      "scheduleMode",
      "occurrenceCount",
      "requiredProfessionals",
      "totalOccurrenceCount",

      "countryCode",
      "currency",

      "startTime",
      "endTime",

      "status",
      "paymentStatus",

      "cancelledFromStatus",
      "cancellationCode",
      "cancelledAt",

      "fundingMethod",
      "fundingInitiatedAt",
      "fundedAmount",
      "fundedAt",
      "publishedAt",
      "fundingTransaction",

      "estimatedProfessionalPay",
      "estimatedPlatformFee",
      "estimatedEmployerCharge",
    ].join(" ");
  }

  static async getEmployerShiftForFunding({
    shiftId,
    employerProfileId,
    employerContext,
    session = null,
  }) {
    const filter = ShiftFundingService.buildShiftAccessFilter({
      shiftId,
      employerProfileId,
      employerContext,
    });

    const query = session
      ? Shift.findOneAndUpdate(filter, { $inc: { __v: 1 } }, { new: true, session })
      : Shift.findOne(filter);

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftFundingService.createFundingError({
        message: "Shift was not found or is not available to you.",
        code: "SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static async getSystemShiftForFunding({ shiftId, session = null }) {
    const normalizedShiftId = ShiftFundingService.validateObjectId(shiftId, "shift ID");

    const query = session
      ? Shift.findOneAndUpdate(
          { _id: normalizedShiftId },
          { $inc: { __v: 1 } },
          { new: true, session }
        )
      : Shift.findById(normalizedShiftId);

    if (session) {
      query.session(session);
    }

    const shift = await query;

    if (!shift) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift linked to the payment was not found.",
        code: "PAYSTACK_SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    return shift;
  }

  static buildOccurrenceAccessFilter({
    occurrenceId,
    employerProfileId,
    employerContext,
    shiftId = null,
  }) {
    const filter = {
      _id: ShiftFundingService.validateObjectId(occurrenceId, "occurrence ID"),

      business: ShiftFundingService.validateObjectId(employerProfileId, "employer profile ID"),
    };

    if (shiftId) {
      filter.shift = ShiftFundingService.validateObjectId(shiftId, "shift ID");
    }

    if (!ShiftFundingService.canManageAllBranches(employerContext)) {
      const assignedBranchIds = ShiftFundingService.getAssignedBranchIds(employerContext);

      if (assignedBranchIds.length === 0) {
        throw ShiftFundingService.createFundingError({
          message: "You are not assigned to a branch that can resolve this Shift payment.",
          code: "SHIFT_BRANCH_ACCESS_NOT_AVAILABLE",
          statusCode: 403,
        });
      }

      filter.branch = {
        $in: assignedBranchIds,
      };
    }

    return filter;
  }

  static async getEmployerOccurrenceForOvertimeFunding({
    occurrenceId,
    employerProfileId,
    employerContext,
    shiftId = null,
    session = null,
  }) {
    const filter = ShiftFundingService.buildOccurrenceAccessFilter({
      occurrenceId,
      employerProfileId,
      employerContext,
      shiftId,
    });

    const query = ShiftOccurrence.findOne(filter);

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftFundingService.createFundingError({
        message: "Shift occurrence was not found or is not available to you.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static async getSystemOccurrenceForOvertimeFunding({ occurrenceId, session = null }) {
    const normalizedOccurrenceId = ShiftFundingService.validateObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = ShiftOccurrence.findById(normalizedOccurrenceId);

    if (session) {
      query.session(session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift occurrence linked to the overtime payment was not found.",
        code: "PAYSTACK_OVERTIME_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return occurrence;
  }

  static assertFundingContext({ shift, countryCode, currency }) {
    if (shift.countryCode !== countryCode || shift.currency !== currency) {
      throw ShiftFundingService.createFundingError({
        message: "The funding country and currency must match the Shift snapshots.",
        code: "SHIFT_FUNDING_CONTEXT_MISMATCH",
        statusCode: 409,
      });
    }
  }

  static assertOccurrenceBelongsToShift({ occurrence, shift }) {
    const valid = Boolean(
      occurrence &&
      shift &&
      String(occurrence.shift || "") === String(shift._id || "") &&
      String(occurrence.business || "") === String(shift.business || "") &&
      String(occurrence.branch || "") === String(shift.branch || "") &&
      occurrence.countryCode === shift.countryCode &&
      occurrence.currency === shift.currency &&
      Number.isSafeInteger(occurrence.slotNumber) &&
      occurrence.slotNumber >= 1 &&
      occurrence.slotNumber <= shift.requiredProfessionals &&
      Number.isSafeInteger(occurrence.sequenceNumber) &&
      occurrence.sequenceNumber >= 1 &&
      occurrence.sequenceNumber <= shift.occurrenceCount
    );

    if (!valid) {
      throw ShiftFundingService.createFundingError({
        message: "The overtime occurrence does not match the resolved parent Shift.",
        code: "OVERTIME_OCCURRENCE_SHIFT_MISMATCH",
        statusCode: 409,
      });
    }

    return true;
  }

  static isOvertimeTopUpFunded(occurrence) {
    return Boolean(
      occurrence?.overtime?.topUpPaid === true &&
      occurrence?.overtime?.topUpPaidAt &&
      occurrence?.topUpTransaction &&
      occurrence?.topUpRequired === 0
    );
  }

  /* ─────────────────────────────── FUNDING VALIDATION ─────────────────────────────── */

  static validateFundingAmount(shift) {
    const amount = shift?.estimatedEmployerCharge;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift employer charge is invalid.",
        code: "INVALID_SHIFT_FUNDING_AMOUNT",
        statusCode: 500,
      });
    }

    return amount;
  }

  static async assertOccurrenceFundingAllocation({ shift, session }) {
    const dates = shift.occurrenceCount;
    const positions = shift.requiredProfessionals;
    const expectedOccurrenceCount = dates * positions;

    if (
      !Number.isSafeInteger(dates) ||
      dates < 1 ||
      dates > MAX_SHIFT_OCCURRENCES ||
      !Number.isSafeInteger(positions) ||
      positions < 1 ||
      !Number.isSafeInteger(expectedOccurrenceCount) ||
      shift.totalOccurrenceCount !== expectedOccurrenceCount
    ) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift slot/date counts are invalid.",
        code: "SHIFT_OCCURRENCE_COUNT_MISMATCH",
        statusCode: 409,
      });
    }

    const occurrences = await ShiftOccurrence.find({ shift: shift._id })
      .select(
        [
          "shift business branch countryCode currency slotNumber sequenceNumber",
          "assignmentStatus assignedProfessional assignment assignedAt status",
          "estimatedProfessionalPay estimatedPlatformFee estimatedEmployerCharge",
        ].join(" ")
      )
      .sort({ slotNumber: 1, sequenceNumber: 1 })
      .session(session)
      .lean();

    if (occurrences.length !== expectedOccurrenceCount) {
      throw ShiftFundingService.createFundingError({
        message: "The occurrence count does not match the Shift's funded positions and dates.",
        code: "SHIFT_OCCURRENCE_COUNT_MISMATCH",
        statusCode: 409,
        details: {
          expectedOccurrenceCount,
          actualOccurrenceCount: occurrences.length,
        },
      });
    }

    const amountFields = [
      "estimatedProfessionalPay",
      "estimatedPlatformFee",
      "estimatedEmployerCharge",
    ];

    const validateAmounts = (record) => {
      for (const field of amountFields) {
        if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
          throw ShiftFundingService.createFundingError({
            message: "Every funding allocation must contain valid integer minor-unit amounts.",
            code: "INVALID_SHIFT_OCCURRENCE_FUNDING_AMOUNT",
            statusCode: 409,
            details: { recordId: String(record._id), field },
          });
        }
      }

      if (
        BigInt(record.estimatedEmployerCharge) !==
        BigInt(record.estimatedProfessionalPay) + BigInt(record.estimatedPlatformFee)
      ) {
        throw ShiftFundingService.createFundingError({
          message: "Professional pay and platform fee must equal the employer charge.",
          code: "SHIFT_OCCURRENCE_FUNDING_MISMATCH",
          statusCode: 409,
          details: { recordId: String(record._id) },
        });
      }
    };

    validateAmounts(shift);

    occurrences.forEach((occurrence, index) => {
      if (
        occurrence.slotNumber !== Math.floor(index / dates) + 1 ||
        occurrence.sequenceNumber !== (index % dates) + 1 ||
        String(occurrence.shift) !== String(shift._id) ||
        String(occurrence.business) !== String(shift.business) ||
        String(occurrence.branch) !== String(shift.branch) ||
        occurrence.countryCode !== shift.countryCode ||
        occurrence.currency !== shift.currency
      ) {
        throw ShiftFundingService.createFundingError({
          message: "Occurrence identity does not match the Shift slot/date structure.",
          code: "SHIFT_OCCURRENCE_CONTEXT_MISMATCH",
          statusCode: 409,
        });
      }

      if (
        occurrence.assignmentStatus !== "unassigned" ||
        occurrence.assignedProfessional ||
        occurrence.assignment ||
        occurrence.assignedAt ||
        occurrence.status !== "scheduled"
      ) {
        throw ShiftFundingService.createFundingError({
          message: "Initial funding requires scheduled, unassigned occurrences in every slot.",
          code: "PENDING_SHIFT_OCCURRENCE_NOT_UNASSIGNED",
          statusCode: 409,
        });
      }

      validateAmounts(occurrence);
    });

    const summary = { occurrenceCount: occurrences.length };

    for (const field of amountFields) {
      const total = occurrences.reduce((sum, occurrence) => sum + BigInt(occurrence[field]), 0n);

      if (total !== BigInt(shift[field])) {
        throw ShiftFundingService.createFundingError({
          message: "The occurrence allocations do not match the parent Shift totals.",
          code: "SHIFT_OCCURRENCE_FUNDING_MISMATCH",
          statusCode: 409,
          details: { field, expected: shift[field], actual: total.toString() },
        });
      }

      summary[field] = Number(total);
    }

    return summary;
  }

  static isShiftFullyFunded(shift) {
    const employerCharge = shift?.estimatedEmployerCharge;
    const fundedAmount = shift?.fundedAmount;

    return Boolean(
      Number.isSafeInteger(employerCharge) &&
      employerCharge > 0 &&
      Number.isSafeInteger(fundedAmount) &&
      fundedAmount >= employerCharge &&
      shift?.fundingMethod &&
      shift?.fundingTransaction &&
      shift?.fundedAt &&
      shift?.publishedAt &&
      shift?.status !== "pending_funding" &&
      shift?.paymentStatus !== "unpaid"
    );
  }

  static isAuthoritativeFundingTransaction(shift, transaction) {
    return Boolean(
      shift?.fundingTransaction &&
      transaction?._id &&
      String(shift.fundingTransaction) === String(transaction._id)
    );
  }

  static buildFundingWindowExpiredError(shift, details = {}) {
    return ShiftFundingService.createFundingError({
      message: "This Shift expired because it was not funded before its scheduled start time.",
      code: "SHIFT_FUNDING_WINDOW_EXPIRED",
      statusCode: 409,

      details: {
        shiftId: shift?._id ? String(shift._id) : shift?.shiftId || null,
        referenceCode: shift?.referenceCode || null,
        startTime: shift?.startTime || null,
        cancelledAt: shift?.cancelledAt || null,
        ...details,
      },
    });
  }

  static async expireShiftWhenFundingWindowPassed({ shift, currentTime, session }) {
    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    if (ShiftFundingService.isShiftFullyFunded(shift)) {
      return {
        expired: false,
        alreadyFunded: true,
      };
    }

    if (shift.status === "cancelled" && shift.cancellationCode === "funding_deadline_passed") {
      return {
        expired: true,
        alreadyFinalized: true,

        shiftId: String(shift._id),
        referenceCode: shift.referenceCode,
        startTime: shift.startTime,
        cancelledAt: shift.cancelledAt || null,
      };
    }

    const startTime = shift.startTime ? new Date(shift.startTime) : null;

    if (!startTime || Number.isNaN(startTime.getTime())) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift start time is invalid.",
        code: "INVALID_SHIFT_START_TIME",
        statusCode: 500,
      });
    }

    const shouldExpire =
      shift.status === "pending_funding" &&
      shift.paymentStatus === "unpaid" &&
      shift.fundedAmount === 0 &&
      startTime <= normalizedCurrentTime;

    if (!shouldExpire) {
      return {
        expired: false,
        alreadyFunded: false,
      };
    }

    const expirationResult = await ShiftLifecycleService.expireUnfundedShift(
      {
        shiftId: shift._id,
        now: normalizedCurrentTime,
      },
      {
        session,
      }
    );

    return {
      expired: true,
      alreadyFinalized: expirationResult?.alreadyFinalized === true,

      shiftId: String(shift._id),
      referenceCode: shift.referenceCode,
      startTime: shift.startTime,
      cancelledAt: normalizedCurrentTime,

      expirationResult,
    };
  }

  static assertShiftAwaitingInitialFunding(shift) {
    if (ShiftFundingService.isShiftFullyFunded(shift)) {
      return {
        alreadyFunded: true,
      };
    }

    if (shift.status === "cancelled" && shift.cancellationCode === "funding_deadline_passed") {
      throw ShiftFundingService.buildFundingWindowExpiredError(shift);
    }

    if (shift.status !== "pending_funding") {
      throw ShiftFundingService.createFundingError({
        message: "Only a pending-funding Shift can receive its initial funding.",
        code: "SHIFT_NOT_PENDING_FUNDING",
        statusCode: 409,
      });
    }

    if (shift.paymentStatus !== "unpaid") {
      throw ShiftFundingService.createFundingError({
        message: "This Shift is not awaiting its initial payment.",
        code: "SHIFT_NOT_AWAITING_PAYMENT",
        statusCode: 409,
      });
    }

    if (shift.fundedAmount !== 0) {
      throw ShiftFundingService.createFundingError({
        message: "An unpaid pending-funding Shift cannot already contain protected funding.",
        code: "PENDING_SHIFT_CONTAINS_FUNDS",
        statusCode: 409,
      });
    }

    ShiftFundingService.validateFundingAmount(shift);

    return {
      alreadyFunded: false,
    };
  }

  static assertShiftCanBeFundedFromWallet(shift) {
    const fundingState = ShiftFundingService.assertShiftAwaitingInitialFunding(shift);

    if (fundingState.alreadyFunded) {
      return fundingState;
    }

    if (shift.fundingMethod && shift.fundingMethod !== "wallet") {
      throw ShiftFundingService.createFundingError({
        message: "A Paystack Checkout payment has already been initiated for this Shift.",
        code: "SHIFT_PAYSTACK_CHECKOUT_ALREADY_INITIATED",
        statusCode: 409,
      });
    }

    return fundingState;
  }

  static assertShiftCanInitializePaystack(shift) {
    const fundingState = ShiftFundingService.assertShiftAwaitingInitialFunding(shift);

    if (fundingState.alreadyFunded) {
      return fundingState;
    }

    if (shift.fundingMethod && shift.fundingMethod !== "paystack_checkout") {
      throw ShiftFundingService.createFundingError({
        message: "Wallet funding has already been selected for this Shift.",
        code: "SHIFT_WALLET_FUNDING_ALREADY_INITIATED",
        statusCode: 409,
      });
    }

    return fundingState;
  }

  static assertShiftCanApplyPaystackFunding(shift) {
    if (ShiftFundingService.isShiftFullyFunded(shift)) {
      return {
        alreadyFunded: true,
      };
    }

    if (shift.status !== "pending_funding" || shift.paymentStatus !== "unpaid") {
      throw ShiftFundingService.createFundingError({
        message: "The successful Paystack payment cannot be applied to the current Shift state.",
        code: "SHIFT_NOT_ELIGIBLE_FOR_PAYSTACK_FUNDING",
        statusCode: 409,

        details: {
          status: shift.status,
          paymentStatus: shift.paymentStatus,
        },
      });
    }

    if (shift.fundedAmount !== 0) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift already contains protected funding without a completed funding state.",
        code: "INCONSISTENT_SHIFT_FUNDING_STATE",
        statusCode: 409,
      });
    }

    ShiftFundingService.validateFundingAmount(shift);

    return {
      alreadyFunded: false,
    };
  }

  static assertWalletCanFundShift({ employerWallet, escrowWallet, amount }) {
    WalletService.assertWalletIsActive(employerWallet);
    WalletService.assertWalletIsActive(escrowWallet);
    WalletService.assertSameCountryAndCurrency(employerWallet, escrowWallet);

    if (employerWallet.ownerType !== "employer" || escrowWallet.ownerType !== "escrow") {
      throw ShiftFundingService.createFundingError({
        message: "The wallet funding source or escrow destination is invalid.",
        code: "INVALID_SHIFT_FUNDING_WALLET_TYPES",
        statusCode: 500,
      });
    }

    const availableBalance = employerWallet.availableBalance;

    if (!Number.isSafeInteger(availableBalance) || availableBalance < 0) {
      throw ShiftFundingService.createFundingError({
        message: "The employer wallet available balance is invalid.",
        code: "INVALID_EMPLOYER_WALLET_BALANCE",
        statusCode: 500,
      });
    }

    if (availableBalance < amount) {
      const shortfall = amount - availableBalance;

      throw ShiftFundingService.createFundingError({
        message: "Your employer wallet balance is not sufficient to fund this Shift.",
        code: "INSUFFICIENT_EMPLOYER_WALLET_BALANCE",
        statusCode: 409,

        details: {
          availableBalance,
          requiredAmount: amount,
          shortfall,
          currency: employerWallet.currency,
        },
      });
    }

    return true;
  }

  static assertWalletCanFundOvertimeTopUp({ employerWallet, escrowWallet, amount }) {
    WalletService.assertWalletIsActive(employerWallet);
    WalletService.assertWalletIsActive(escrowWallet);
    WalletService.assertSameCountryAndCurrency(employerWallet, escrowWallet);

    if (employerWallet.ownerType !== "employer" || escrowWallet.ownerType !== "escrow") {
      throw ShiftFundingService.createFundingError({
        message: "The overtime top-up wallet source or escrow destination is invalid.",
        code: "INVALID_OVERTIME_TOPUP_WALLET_TYPES",
        statusCode: 500,
      });
    }

    const availableBalance = employerWallet.availableBalance;

    if (!Number.isSafeInteger(availableBalance) || availableBalance < 0) {
      throw ShiftFundingService.createFundingError({
        message: "The employer wallet available balance is invalid.",
        code: "INVALID_EMPLOYER_WALLET_BALANCE",
        statusCode: 500,
      });
    }

    if (availableBalance < amount) {
      const shortfall = amount - availableBalance;

      throw ShiftFundingService.createFundingError({
        message: "Your employer wallet balance is not sufficient to pay this overtime top-up.",
        code: "INSUFFICIENT_EMPLOYER_WALLET_BALANCE_FOR_OVERTIME_TOPUP",
        statusCode: 409,
        details: {
          availableBalance,
          requiredAmount: amount,
          shortfall,
          currency: employerWallet.currency,
        },
      });
    }

    return true;
  }

  static assertEscrowWallet({ wallet, countryCode, currency }) {
    if (!wallet) {
      throw ShiftFundingService.createFundingError({
        message: "The escrow wallet required for Shift funding has not been configured.",
        code: "ESCROW_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    WalletService.assertWalletIsActive(wallet);

    if (
      wallet.ownerType !== "escrow" ||
      wallet.countryCode !== countryCode ||
      wallet.currency !== currency
    ) {
      throw ShiftFundingService.createFundingError({
        message: "The resolved escrow wallet does not match the Shift funding context.",
        code: "INVALID_SHIFT_ESCROW_WALLET",
        statusCode: 500,
      });
    }

    return wallet;
  }

  /* ─────────────────────────────── DISPLAY / RESPONSES ─────────────────────────────── */

  static formatAmount(amount, currency) {
    return money.formatMoney(amount ?? 0, currency);
  }

  static buildAlreadyFundedResponse({ shift, currency }) {
    return {
      alreadyFunded: true,
      fundingApplied: true,
      returnedToEmployerWallet: false,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
        status: shift.status,
        paymentStatus: shift.paymentStatus,
        fundingMethod: shift.fundingMethod,
        fundedAmount: shift.fundedAmount,

        fundedAmountDisplay: ShiftFundingService.formatAmount(shift.fundedAmount, currency),

        fundedAt: shift.fundedAt,
        publishedAt: shift.publishedAt,
      },

      message: `Shift ${shift.referenceCode} has already been funded and published.`,

      redirectUrl: EMPLOYER_SHIFTS_URL,
    };
  }

  static buildWalletFundingResponse({ shift, employerWallet, transferResult, currency }) {
    return {
      alreadyFunded: false,
      fundingApplied: true,
      returnedToEmployerWallet: false,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
        status: shift.status,
        paymentStatus: shift.paymentStatus,
        fundingMethod: shift.fundingMethod,

        professionalPay: shift.estimatedProfessionalPay,

        professionalPayDisplay: ShiftFundingService.formatAmount(
          shift.estimatedProfessionalPay,
          currency
        ),

        platformFee: shift.estimatedPlatformFee,

        platformFeeDisplay: ShiftFundingService.formatAmount(shift.estimatedPlatformFee, currency),

        fundedAmount: shift.fundedAmount,

        fundedAmountDisplay: ShiftFundingService.formatAmount(shift.fundedAmount, currency),

        fundedAt: shift.fundedAt,
        publishedAt: shift.publishedAt,
      },

      wallet: {
        availableBalance: employerWallet.availableBalance,

        availableBalanceDisplay: ShiftFundingService.formatAmount(
          employerWallet.availableBalance,
          currency
        ),
      },

      transaction: {
        groupReference: transferResult.groupReference,

        debitTransactionId: String(transferResult.debit.transaction._id),

        creditTransactionId: String(transferResult.credit.transaction._id),
      },

      message: `Shift ${shift.referenceCode} was funded from your wallet and published successfully.`,

      redirectUrl: EMPLOYER_SHIFTS_URL,
    };
  }

  static buildCheckoutInitializationResponse({
    shift,
    transaction,
    checkout,
    currency,
    reused = false,
  }) {
    return {
      alreadyFunded: false,
      fundingApplied: false,
      returnedToEmployerWallet: false,
      reused,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
        status: shift.status,
        paymentStatus: shift.paymentStatus,
        fundingMethod: shift.fundingMethod,

        employerCharge: shift.estimatedEmployerCharge,

        employerChargeDisplay: ShiftFundingService.formatAmount(
          shift.estimatedEmployerCharge,
          currency
        ),
      },

      checkout: {
        authorizationUrl: checkout.authorizationUrl,
        reference: transaction.paystackReference,
        mode: checkout.mode || transaction.metadata?.paystackMode || null,
      },

      message: reused
        ? "Continue with the existing Paystack Checkout payment."
        : "Paystack Checkout was initialized successfully.",
    };
  }

  static buildPaystackReturnResponse({
    shift,
    transaction,
    employerWallet,
    returnTransfer,
    returnReason,
    idempotent,
  }) {
    const messages = {
      duplicate:
        `The additional successful Paystack payment for Shift ${shift.referenceCode} ` +
        `was returned to the employer wallet because the Shift had already been funded.`,

      late:
        `The successful Paystack payment for Shift ${shift.referenceCode} ` +
        `was returned to the employer wallet because it was completed after the funding deadline.`,

      timely_expired:
        `The payment for Shift ${shift.referenceCode} was completed before the funding deadline, ` +
        `but the Shift was cancelled at the funding deadline before the payment could be confirmed and applied. ` +
        `The amount was returned to the employer wallet.`,

      employer_cancelled:
        `The successful Paystack payment for Shift ${shift.referenceCode} ` +
        `was returned to the employer wallet because the Shift had already been cancelled.`,
    };

    return {
      alreadyFunded: ShiftFundingService.isShiftFullyFunded(shift),
      fundingApplied: false,
      returnedToEmployerWallet: true,
      returnReason,
      idempotent,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
        status: shift.status,
        paymentStatus: shift.paymentStatus,
        fundingMethod: shift.fundingMethod,
        fundedAmount: shift.fundedAmount,
        fundedAt: shift.fundedAt,
        publishedAt: shift.publishedAt,
      },

      paystackTransaction: {
        id: String(transaction._id),
        reference: transaction.reference,
        paystackReference: transaction.paystackReference,
        amount: transaction.amount,
        status: transaction.status,
      },

      walletReturn: {
        groupReference: returnTransfer.groupReference,

        debitTransactionId: String(returnTransfer.debit.transaction._id),

        creditTransactionId: String(returnTransfer.credit.transaction._id),

        amount: transaction.amount,

        employerWalletId: String(employerWallet._id),
        availableBalance: employerWallet.availableBalance,
      },

      message:
        messages[returnReason] ||
        `The successful Paystack payment for Shift ${shift.referenceCode} ` +
          `was returned to the employer wallet.`,

      redirectUrl: EMPLOYER_SHIFTS_URL,
    };
  }

  static buildPaystackFundingResponse({ shift, transaction, currency, idempotent = false }) {
    return {
      alreadyFunded: idempotent,
      fundingApplied: true,
      returnedToEmployerWallet: false,
      idempotent,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
        status: shift.status,
        paymentStatus: shift.paymentStatus,
        fundingMethod: shift.fundingMethod,

        professionalPay: shift.estimatedProfessionalPay,

        professionalPayDisplay: ShiftFundingService.formatAmount(
          shift.estimatedProfessionalPay,
          currency
        ),

        platformFee: shift.estimatedPlatformFee,

        platformFeeDisplay: ShiftFundingService.formatAmount(shift.estimatedPlatformFee, currency),

        fundedAmount: shift.fundedAmount,

        fundedAmountDisplay: ShiftFundingService.formatAmount(shift.fundedAmount, currency),

        fundedAt: shift.fundedAt,
        publishedAt: shift.publishedAt,
      },

      transaction: {
        id: String(transaction._id),
        reference: transaction.reference,
        paystackReference: transaction.paystackReference,
        amount: transaction.amount,
        status: transaction.status,
      },

      message: idempotent
        ? `Shift ${shift.referenceCode} has already been funded through Paystack and published.`
        : `Shift ${shift.referenceCode} was funded through Paystack and published successfully.`,

      redirectUrl: EMPLOYER_SHIFTS_URL,
    };
  }

  static buildOvertimeTopUpAlreadyFundedResponse({ shift, occurrence, currency }) {
    const topUpAmount = Number(occurrence?.overtime?.topUpAmount || 0);

    return {
      alreadyFunded: true,
      fundingApplied: true,
      fundingType: "overtime_topup",

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
      },

      occurrence: {
        id: String(occurrence._id),
        referenceCode: occurrence.referenceCode,
        topUpAmount,
        topUpAmountDisplay: ShiftFundingService.formatAmount(topUpAmount, currency),
        topUpRequired: Number(occurrence.topUpRequired || 0),
        topUpPaid: occurrence.overtime?.topUpPaid === true,
        topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,
        topUpTransaction: occurrence.topUpTransaction ? String(occurrence.topUpTransaction) : null,
      },

      message: `Overtime top-up for ${occurrence.referenceCode} has already been paid.`,

      redirectUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}` + `?occurrence=${occurrence._id}`,
    };
  }

  static buildOvertimeWalletFundingResponse({
    shift,
    occurrence,
    employerWallet,
    transferResult,
    currency,
    confirmationResult,
  }) {
    const topUpAmount = Number(occurrence?.overtime?.topUpAmount || 0);

    return {
      alreadyFunded: confirmationResult?.idempotent === true,
      fundingApplied: true,
      fundingType: "overtime_topup",

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
      },

      occurrence: {
        id: String(occurrence._id),
        referenceCode: occurrence.referenceCode,
        topUpAmount,
        topUpAmountDisplay: ShiftFundingService.formatAmount(topUpAmount, currency),
        topUpRequired: Number(occurrence.topUpRequired || 0),
        topUpPaid: occurrence.overtime?.topUpPaid === true,
        topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,
        topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,
        topUpOverdueAt: occurrence.overtime?.topUpOverdueAt || null,
        restrictionTriggeredAt: occurrence.overtime?.restrictionTriggeredAt || null,
        topUpTransaction: occurrence.topUpTransaction ? String(occurrence.topUpTransaction) : null,
      },

      wallet: {
        availableBalance: Number(employerWallet.availableBalance || 0),
        availableBalanceDisplay: ShiftFundingService.formatAmount(
          employerWallet.availableBalance || 0,
          currency
        ),
      },

      transaction: {
        groupReference: transferResult.groupReference,
        debitTransactionId: String(transferResult.debit.transaction._id),
        creditTransactionId: String(transferResult.credit.transaction._id),
      },

      message: `Overtime top-up for ${occurrence.referenceCode} was paid from your wallet.`,

      redirectUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}` + `?occurrence=${occurrence._id}`,
    };
  }

  static buildOvertimeCheckoutInitializationResponse({
    shift,
    occurrence,
    transaction,
    checkout,
    currency,
    reused = false,
  }) {
    const topUpAmount = Number(occurrence?.overtime?.topUpAmount || occurrence?.topUpRequired || 0);

    return {
      alreadyFunded: false,
      fundingApplied: false,
      fundingType: "overtime_topup",
      reused,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
      },

      occurrence: {
        id: String(occurrence._id),
        referenceCode: occurrence.referenceCode,
        topUpAmount,
        topUpAmountDisplay: ShiftFundingService.formatAmount(topUpAmount, currency),
        topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,
        topUpOverdueAt: occurrence.overtime?.topUpOverdueAt || null,
        restrictionTriggeredAt: occurrence.overtime?.restrictionTriggeredAt || null,
      },

      checkout: {
        authorizationUrl: checkout.authorizationUrl,
        reference: transaction.paystackReference,
        mode: checkout.mode || transaction.metadata?.paystackMode || null,
      },

      message: reused
        ? "Continue with the existing Paystack Checkout overtime top-up."
        : "Paystack Checkout was initialized for the overtime top-up.",
    };
  }

  static buildPaystackOvertimeTopUpResponse({
    shift,
    occurrence,
    transaction,
    currency,
    confirmationResult,
  }) {
    const topUpAmount = Number(occurrence?.overtime?.topUpAmount || transaction.amount || 0);
    const idempotent = confirmationResult?.idempotent === true;

    return {
      alreadyFunded: idempotent,
      fundingApplied: true,
      fundingType: "overtime_topup",
      idempotent,

      shift: {
        id: String(shift._id),
        referenceCode: shift.referenceCode,
      },

      occurrence: {
        id: String(occurrence._id),
        referenceCode: occurrence.referenceCode,
        topUpAmount,
        topUpAmountDisplay: ShiftFundingService.formatAmount(topUpAmount, currency),
        topUpRequired: Number(occurrence.topUpRequired || 0),
        topUpPaid: occurrence.overtime?.topUpPaid === true,
        topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,
        topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,
        topUpOverdueAt: occurrence.overtime?.topUpOverdueAt || null,
        restrictionTriggeredAt: occurrence.overtime?.restrictionTriggeredAt || null,
        topUpTransaction: occurrence.topUpTransaction ? String(occurrence.topUpTransaction) : null,
      },

      transaction: {
        id: String(transaction._id),
        reference: transaction.reference,
        paystackReference: transaction.paystackReference,
        amount: transaction.amount,
        status: transaction.status,
      },

      message: idempotent
        ? `Overtime top-up for ${occurrence.referenceCode} has already been confirmed.`
        : `Overtime top-up for ${occurrence.referenceCode} was paid successfully.`,

      redirectUrl: `${EMPLOYER_SHIFTS_URL}/${shift._id}` + `?occurrence=${occurrence._id}`,
    };
  }

  /* ─────────────────────────────── PAYSTACK ATTEMPTS ─────────────────────────────── */

  static async clearFailedPaystackFundingSelection({ shiftId, transactionId }) {
    return runWithOptionalTransaction({}, async (session) => {
      const shift = await ShiftFundingService.getSystemShiftForFunding({ shiftId, session });

      if (
        shift.status !== "pending_funding" ||
        shift.paymentStatus !== "unpaid" ||
        shift.fundingMethod !== "paystack_checkout" ||
        shift.fundingTransaction
      ) {
        return;
      }

      const openAttempt = await ShiftFundingService.getOpenPaystackAttempt({ shiftId, session });
      const latestAttempt = await ShiftFundingService.getLatestPaystackAttempt({
        shiftId,
        session,
      });

      if (
        openAttempt ||
        !latestAttempt ||
        String(latestAttempt._id) !== String(transactionId) ||
        latestAttempt.status !== "failed"
      ) {
        return;
      }

      shift.fundingMethod = null;
      shift.fundingInitiatedAt = null;

      await shift.save({ session });
    });
  }

  static getPaystackAttemptFilter(shiftId) {
    return {
      shift: shiftId,
      type: "shift_funding",
      purpose: "shift_base_funding",
      paymentRail: "paystack_checkout",
      provider: "paystack",
    };
  }

  static async getLatestPaystackAttempt({ shiftId, session = null }) {
    const query = Transaction.findOne(ShiftFundingService.getPaystackAttemptFilter(shiftId)).sort({
      createdAt: -1,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  static async getOpenPaystackAttempt({ shiftId, session = null }) {
    const query = Transaction.findOne({
      ...ShiftFundingService.getPaystackAttemptFilter(shiftId),

      status: {
        $in: PAYSTACK_OPEN_STATUSES,
      },
    }).sort({
      createdAt: -1,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  static getOvertimeTopUpPaystackAttemptFilter({ shiftId, occurrenceId }) {
    return {
      shift: shiftId,
      shiftOccurrence: occurrenceId,
      type: OVERTIME_TOPUP_TRANSACTION_TYPE,
      purpose: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
      paymentRail: "paystack_checkout",
      provider: "paystack",
    };
  }

  static async getLatestOvertimeTopUpPaystackAttempt({ shiftId, occurrenceId, session = null }) {
    const query = Transaction.findOne(
      ShiftFundingService.getOvertimeTopUpPaystackAttemptFilter({
        shiftId,
        occurrenceId,
      })
    ).sort({
      createdAt: -1,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  static async getOpenOvertimeTopUpPaystackAttempt({ shiftId, occurrenceId, session = null }) {
    const query = Transaction.findOne({
      ...ShiftFundingService.getOvertimeTopUpPaystackAttemptFilter({
        shiftId,
        occurrenceId,
      }),

      status: {
        $in: PAYSTACK_OPEN_STATUSES,
      },
    }).sort({
      createdAt: -1,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  static hasReusableCheckout(transaction) {
    return Boolean(
      transaction &&
      PAYSTACK_OPEN_STATUSES.includes(transaction.status) &&
      transaction.metadata?.authorizationUrl &&
      transaction.paystackReference
    );
  }

  static isDefinitiveInitializationFailure(error) {
    const providerStatusCode = Number(error?.providerStatusCode);

    if (
      Number.isInteger(providerStatusCode) &&
      providerStatusCode >= 400 &&
      providerStatusCode < 500
    ) {
      return true;
    }

    return Boolean(!error?.providerStatusCode && Number(error?.statusCode) === 400);
  }

  static buildPaystackReturnGroupReference(transactionId) {
    return `LQM-PAYSTACK-RETURN-${String(transactionId).toUpperCase()}`;
  }

  static buildPaystackReturnIdempotencyKeys(transactionId) {
    const prefix = `paystack-shift-payment-return:${transactionId}`;

    return {
      debitIdempotencyKey: `${prefix}:escrow-debit`,
      creditIdempotencyKey: `${prefix}:employer-credit`,
    };
  }

  static async markPaystackFundingIntegrityConflict({
    transaction,
    shift,
    reason,
    verifiedPaymentTime,
    currentTime,
    session,
  }) {
    transaction.metadata = {
      ...(transaction.metadata || {}),

      appliedToShift: false,
      returnedToEmployerWallet: false,

      fundingIntegrityConflict: true,
      fundingApplicationPending: true,
      fundingIntegrityReason: reason,
      fundingIntegrityDetectedAt: currentTime,

      verifiedPaymentTime,

      shiftStatusAtConflict: shift.status,
      shiftPaymentStatusAtConflict: shift.paymentStatus,

      authoritativeFundingTransactionId: shift.fundingTransaction
        ? String(shift.fundingTransaction)
        : null,
    };

    transaction.markModified("metadata");

    await transaction.save({
      session,
    });

    logger.error(
      `Paystack funding integrity conflict for Shift ${shift.referenceCode}: ` +
        `${reason}. Payment ${transaction.paystackReference} remains protected in escrow.`
    );

    return {
      fundingIntegrityConflict: true,
      reason,

      shiftId: String(shift._id),
      referenceCode: shift.referenceCode,

      transactionId: String(transaction._id),
      paystackReference: transaction.paystackReference,

      amount: transaction.amount,
      verifiedPaymentTime,
    };
  }

  static async recordUnappliedBaseFundingError({ transactionId, error, currentTime }) {
    // Recheck terminal application flags atomically: a concurrent retry may
    // already have applied or returned this payment after our attempt failed.
    return Transaction.updateOne(
      {
        _id: transactionId,
        type: BASE_FUNDING_TRANSACTION_TYPE,
        purpose: BASE_FUNDING_TRANSACTION_PURPOSE,
        provider: "paystack",
        paymentRail: "paystack_checkout",
        status: "completed",
        "metadata.appliedToShift": { $ne: true },
        "metadata.returnedToEmployerWallet": { $ne: true },
      },
      {
        $set: {
          "metadata.fundingApplicationPending": true,
          "metadata.fundingIntegrityConflict": true,
          "metadata.fundingIntegrityReason": "base_funding_application_not_confirmed",
          "metadata.fundingIntegrityDetectedAt": currentTime,
          "metadata.fundingApplicationLastErrorAt": currentTime,
          "metadata.fundingApplicationLastErrorCode": String(
            error?.code || error?.name || "BASE_FUNDING_APPLICATION_ERROR"
          ).slice(0, 100),
          "metadata.fundingApplicationLastErrorMessage": String(
            error?.message || "The credited payment could not be applied or returned."
          ).slice(0, 500),
        },
      }
    );
  }

  static async returnSuccessfulPaystackPaymentToEmployer({
    transaction,
    shift,
    escrowWallet,
    returnReason,
    verifiedPaymentTime,
    currentTime,
    session,
  }) {
    const purpose = SHIFT_PAYMENT_RETURN_PURPOSE_BY_REASON[returnReason];

    if (!purpose) {
      throw ShiftFundingService.createFundingError({
        message: "The Paystack payment return reason is not supported.",
        code: "UNSUPPORTED_PAYSTACK_PAYMENT_RETURN_REASON",
        statusCode: 500,
      });
    }

    if (transaction.status !== "completed" || transaction.paystackStatus !== "success") {
      throw ShiftFundingService.createFundingError({
        message: "Only a completed successful Paystack payment can be returned.",
        code: "PAYSTACK_PAYMENT_NOT_COMPLETED_FOR_RETURN",
        statusCode: 409,
      });
    }

    if (String(transaction.wallet) !== String(escrowWallet._id)) {
      throw ShiftFundingService.createFundingError({
        message: "The successful Paystack payment does not belong to the resolved escrow wallet.",
        code: "PAYSTACK_PAYMENT_ESCROW_WALLET_MISMATCH",
        statusCode: 409,
      });
    }

    const employerProfile = await EmployerProfile.findById(shift.business).session(session);

    if (!employerProfile) {
      throw ShiftFundingService.createFundingError({
        message: "The employer profile required for the payment return was not found.",
        code: "PAYSTACK_RETURN_EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    const employerWallet = await WalletService.createEmployerWalletIfMissing(employerProfile, {
      session,
    });

    WalletService.assertWalletIsActive(employerWallet);

    WalletService.assertSameCountryAndCurrency(escrowWallet, employerWallet);

    const recordedReturnPurpose = transaction.metadata?.returnPurpose || null;

    if (recordedReturnPurpose && recordedReturnPurpose !== purpose) {
      throw ShiftFundingService.createFundingError({
        message:
          "The successful Paystack payment was already classified with another return purpose.",
        code: "PAYSTACK_PAYMENT_RETURN_PURPOSE_CONFLICT",
        statusCode: 409,

        details: {
          recordedReturnPurpose,
          requestedReturnPurpose: purpose,
        },
      });
    }

    const returnTransfer = await WalletService.transferBetweenWallets(
      {
        fromWalletId: escrowWallet._id,
        toWalletId: employerWallet._id,

        amount: transaction.amount,

        type: "shift_refund",
        purpose,

        paymentRail: "internal_transfer",

        groupReference: ShiftFundingService.buildPaystackReturnGroupReference(transaction._id),

        ...ShiftFundingService.buildPaystackReturnIdempotencyKeys(transaction._id),

        shift: shift._id,

        initiatedBy: {
          role: "system",
          userId: null,
        },

        description:
          `Return of successful Paystack payment ` +
          `${transaction.paystackReference} for Shift ` +
          `${shift.referenceCode}.`,

        metadata: {
          sourcePaystackTransactionId: String(transaction._id),
          sourcePaystackReference: transaction.paystackReference,

          shiftId: String(shift._id),
          shiftReferenceCode: shift.referenceCode,

          returnReason,
          returnPurpose: purpose,

          verifiedPaymentTime,
          returnedAt: currentTime,

          authoritativeFundingTransactionId: shift.fundingTransaction
            ? String(shift.fundingTransaction)
            : null,
        },
      },
      {
        session,
      }
    );

    transaction.metadata = {
      ...(transaction.metadata || {}),

      appliedToShift: false,

      fundingApplicationPending: false,
      fundingApplicationLastErrorAt: null,
      fundingApplicationLastErrorCode: null,
      fundingApplicationLastErrorMessage: null,
      returnedToEmployerWallet: true,
      returnReason,
      returnPurpose: purpose,

      returnGroupReference: returnTransfer.groupReference,

      returnEscrowDebitTransactionId: String(returnTransfer.debit.transaction._id),

      returnEmployerCreditTransactionId: String(returnTransfer.credit.transaction._id),

      returnedAt: transaction.metadata?.returnedAt || currentTime,

      fundingIntegrityConflict: false,

      fundingIntegrityReason: null,

      verifiedPaymentTime,

      authoritativeFundingTransactionId: shift.fundingTransaction
        ? String(shift.fundingTransaction)
        : null,
    };

    transaction.markModified("metadata");

    await transaction.save({
      session,
    });

    return ShiftFundingService.buildPaystackReturnResponse({
      shift,
      transaction,

      employerWallet: returnTransfer.credit.wallet,

      returnTransfer,
      returnReason,

      idempotent: returnTransfer.idempotent === true,
    });
  }

  /* ─────────────────────────────── WALLET FUNDING ─────────────────────────────── */

  static async fundShiftFromWallet({
    userId,
    employerProfile = null,
    employerContext = null,
    shiftId,
    currentTime = new Date(),
  }) {
    const normalizedUserId = ShiftFundingService.validateObjectId(userId, "user ID");

    const normalizedShiftId = ShiftFundingService.validateObjectId(shiftId, "shift ID");

    ShiftFundingService.assertCanFundShifts(employerContext);

    ShiftFundingService.assertCanActivatePendingShift(employerContext);

    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    const profile = await ShiftFundingService.getEmployerProfileForUser(
      normalizedUserId,
      employerProfile
    );

    const currency = ShiftFundingService.normalizeCurrency(
      profile.currency,
      "employer funding currency"
    );

    const countryCode = ShiftFundingService.normalizeCountryCode(
      profile.countryCode,
      "employer funding country code"
    );

    const fundingResult = await runWithOptionalTransaction({}, async (session) => {
      const shift = await ShiftFundingService.getEmployerShiftForFunding({
        shiftId: normalizedShiftId,
        employerProfileId: profile._id,
        employerContext,
        session,
      });

      ShiftFundingService.assertFundingContext({ shift, countryCode, currency });

      const fundingWindowState = await ShiftFundingService.expireShiftWhenFundingWindowPassed({
        shift,
        currentTime: normalizedCurrentTime,
        session,
      });

      if (fundingWindowState.expired) {
        return {
          fundingWindowExpired: true,
          ...fundingWindowState,
        };
      }

      const fundingState = ShiftFundingService.assertShiftCanBeFundedFromWallet(shift);

      if (fundingState.alreadyFunded) {
        return ShiftFundingService.buildAlreadyFundedResponse({
          shift,
          currency,
        });
      }

      const unresolvedPaystackAttempt = await ShiftFundingService.getOpenPaystackAttempt({
        shiftId: shift._id,
        session,
      });

      if (unresolvedPaystackAttempt) {
        throw ShiftFundingService.createFundingError({
          message: "A Paystack Checkout payment is still unresolved for this Shift.",
          code: "SHIFT_PAYSTACK_PAYMENT_UNRESOLVED",
          statusCode: 409,

          details: {
            transactionId: String(unresolvedPaystackAttempt._id),
            paystackReference: unresolvedPaystackAttempt.paystackReference,
            status: unresolvedPaystackAttempt.status,
          },
        });
      }

      const amount = ShiftFundingService.validateFundingAmount(shift);

      await ShiftFundingService.assertOccurrenceFundingAllocation({
        shift,
        session,
      });

      const employerWallet = await WalletService.createEmployerWalletIfMissing(profile, {
        session,
      });

      const escrowWallet = await WalletService.getEscrowWallet(
        {
          countryCode,
          currency,
        },
        {
          session,
        }
      );

      ShiftFundingService.assertEscrowWallet({
        wallet: escrowWallet,
        countryCode,
        currency,
      });

      ShiftFundingService.assertWalletCanFundShift({
        employerWallet,
        escrowWallet,
        amount,
      });

      const fundingTime = normalizedCurrentTime;

      const transferResult = await WalletService.transferBetweenWallets(
        {
          fromWalletId: employerWallet._id,
          toWalletId: escrowWallet._id,

          amount,

          type: "shift_funding",
          purpose: "shift_base_funding",

          paymentRail: "wallet_balance",

          debitIdempotencyKey: `shift-funding:${shift._id}:employer-debit`,

          creditIdempotencyKey: `shift-funding:${shift._id}:escrow-credit`,

          shift: shift._id,

          initiatedBy: {
            role: "employer",
            userId: normalizedUserId,
          },

          description: `Wallet funding for Shift ${shift.referenceCode}.`,

          metadata: {
            fundingMethod: "wallet",

            employerProfileId: String(profile._id),

            shiftId: String(shift._id),
            referenceCode: shift.referenceCode,

            professionalPay: shift.estimatedProfessionalPay,
            platformFee: shift.estimatedPlatformFee,
            employerCharge: shift.estimatedEmployerCharge,

            fundedAt: fundingTime,
          },
        },
        {
          session,
        }
      );

      shift.fundingMethod = "wallet";
      shift.fundingInitiatedAt = fundingTime;

      shift.fundedAmount = amount;
      shift.fundedAt = fundingTime;
      shift.publishedAt = fundingTime;

      shift.fundingTransaction = transferResult.credit.transaction._id;

      shift.paymentStatus = "funded";
      shift.status = "open";

      await shift.save({
        session,
      });

      await EmployerProfile.updateOne(
        {
          _id: profile._id,
        },
        {
          $inc: {
            totalShiftsPosted: 1,
            totalShiftsPaid: 1,
            totalAmountFunded: amount,

            totalProfessionalPayFunded: shift.estimatedProfessionalPay,
          },

          $set: {
            lastShiftPostedAt: fundingTime,
          },
        },
        {
          session,
        }
      );

      logger.info(
        `Shift ${shift.referenceCode} funded from employer wallet ` +
          `and published by user ${normalizedUserId}`
      );

      return ShiftFundingService.buildWalletFundingResponse({
        shift,

        employerWallet: transferResult.debit.wallet,

        transferResult,
        currency,
      });
    });

    if (fundingResult?.fundingWindowExpired) {
      throw ShiftFundingService.buildFundingWindowExpiredError(fundingResult, {
        ...fundingResult,
      });
    }

    return fundingResult;
  }

  /* ─────────────────────────────── OVERTIME TOP-UP FROM EMPLOYER WALLET ─────────────────────────────── */

  static async fundOvertimeTopUpFromWallet({
    userId,
    employerProfile = null,
    employerContext = null,
    shiftId,
    occurrenceId,
    currentTime = new Date(),
  }) {
    const normalizedUserId = ShiftFundingService.validateObjectId(userId, "user ID");
    const normalizedShiftId = ShiftFundingService.validateObjectId(shiftId, "shift ID");
    const normalizedOccurrenceId = ShiftFundingService.validateObjectId(
      occurrenceId,
      "occurrence ID"
    );

    ShiftFundingService.assertCanResolveExistingShiftObligations(employerContext);

    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    const profile = await ShiftFundingService.getEmployerProfileForUser(
      normalizedUserId,
      employerProfile
    );

    const currency = ShiftFundingService.normalizeCurrency(
      profile.currency,
      "employer overtime funding currency"
    );

    const countryCode = ShiftFundingService.normalizeCountryCode(
      profile.countryCode,
      "employer overtime funding country code"
    );

    return runWithOptionalTransaction({}, async (session) => {
      const shift = await ShiftFundingService.getEmployerShiftForFunding({
        shiftId: normalizedShiftId,
        employerProfileId: profile._id,
        employerContext,
        session,
      });

      const occurrence = await ShiftFundingService.getEmployerOccurrenceForOvertimeFunding({
        occurrenceId: normalizedOccurrenceId,
        employerProfileId: profile._id,
        employerContext,
        shiftId: normalizedShiftId,
        session,
      });

      ShiftFundingService.assertOccurrenceBelongsToShift({
        occurrence,
        shift,
      });

      ShiftFundingService.assertFundingContext({ shift, countryCode, currency });

      if (ShiftFundingService.isOvertimeTopUpFunded(occurrence)) {
        return ShiftFundingService.buildOvertimeTopUpAlreadyFundedResponse({
          shift,
          occurrence,
          currency,
        });
      }

      const { fundingRequirement } =
        ShiftOvertimeFundingService.assertOutstandingFundingState(occurrence);

      const unresolvedPaystackAttempt =
        await ShiftFundingService.getOpenOvertimeTopUpPaystackAttempt({
          shiftId: shift._id,
          occurrenceId: occurrence._id,
          session,
        });

      if (unresolvedPaystackAttempt) {
        throw ShiftFundingService.createFundingError({
          message: "A Paystack Checkout overtime top-up is still unresolved for this occurrence.",
          code: "OVERTIME_TOPUP_PAYSTACK_PAYMENT_UNRESOLVED",
          statusCode: 409,
          details: {
            transactionId: String(unresolvedPaystackAttempt._id),
            paystackReference: unresolvedPaystackAttempt.paystackReference,
            status: unresolvedPaystackAttempt.status,
          },
        });
      }

      const latestPaystackAttempt = await ShiftFundingService.getLatestOvertimeTopUpPaystackAttempt(
        {
          shiftId: shift._id,
          occurrenceId: occurrence._id,
          session,
        }
      );

      if (latestPaystackAttempt?.status === "completed") {
        throw ShiftFundingService.createFundingError({
          message:
            "A completed Paystack overtime top-up already exists for this occurrence " +
            "but is not reflected as the authoritative paid state.",
          code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
          statusCode: 409,
          details: {
            transactionId: String(latestPaystackAttempt._id),
            paystackReference: latestPaystackAttempt.paystackReference,
            appliedToOvertimeTopUp: latestPaystackAttempt.metadata?.appliedToOvertimeTopUp === true,
            fundingIntegrityReason:
              latestPaystackAttempt.metadata?.overtimeFundingIntegrityReason || null,
          },
        });
      }

      const employerWallet = await WalletService.createEmployerWalletIfMissing(profile, {
        session,
      });

      const escrowWallet = await WalletService.getEscrowWallet(
        {
          countryCode,
          currency,
        },
        {
          session,
        }
      );

      ShiftFundingService.assertEscrowWallet({
        wallet: escrowWallet,
        countryCode,
        currency,
      });

      ShiftFundingService.assertWalletCanFundOvertimeTopUp({
        employerWallet,
        escrowWallet,
        amount: fundingRequirement,
      });

      const idempotencyPrefix = `shift-overtime-topup:${occurrence._id}`;

      const transferResult = await WalletService.transferBetweenWallets(
        {
          fromWalletId: employerWallet._id,
          toWalletId: escrowWallet._id,

          amount: fundingRequirement,

          type: OVERTIME_TOPUP_TRANSACTION_TYPE,
          purpose: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
          paymentRail: "wallet_balance",

          debitIdempotencyKey: `${idempotencyPrefix}:employer-debit`,
          creditIdempotencyKey: `${idempotencyPrefix}:escrow-credit`,

          shift: shift._id,
          shiftOccurrence: occurrence._id,

          initiatedBy: {
            role: "employer",
            userId: normalizedUserId,
          },

          description: `Overtime top-up funding for ${occurrence.referenceCode}.`,

          metadata: {
            fundingType: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
            employerProfileId: String(profile._id),
            shiftId: String(shift._id),
            shiftReferenceCode: shift.referenceCode,
            occurrenceId: String(occurrence._id),
            occurrenceReferenceCode: occurrence.referenceCode,
            overtimeProfessionalPay: Number(occurrence.overtimeProfessionalPay || 0),
            overtimePlatformFee: Number(occurrence.overtimePlatformFee || 0),
            topUpAmount: fundingRequirement,
            topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,
            fundedAt: normalizedCurrentTime,
          },
        },
        {
          session,
        }
      );

      const confirmationResult = await ShiftOvertimeFundingService.confirmTopUpFunding(
        {
          occurrenceId: occurrence._id,
          topUpTransactionId: transferResult.credit.transaction._id,
          currentTime: normalizedCurrentTime,
          initiatedBy: {
            role: "employer",
            userId: normalizedUserId,
          },
        },
        {
          session,
        }
      );

      const finalOccurrence = confirmationResult.occurrence || occurrence;

      logger.info(
        `Overtime top-up for occurrence ${occurrence.referenceCode} ` +
          `funded from employer wallet by user ${normalizedUserId}`
      );

      return ShiftFundingService.buildOvertimeWalletFundingResponse({
        shift,
        occurrence: finalOccurrence,
        employerWallet: transferResult.debit.wallet,
        transferResult,
        currency,
        confirmationResult,
      });
    });
  }

  /* ─────────────────────────────── INITIALIZE PAYSTACK CHECKOUT ─────────────────────────────── */

  static async initializePaystackCheckout({
    userId,
    employerProfile = null,
    employerContext = null,
    shiftId,
    callbackUrl,
    currentTime = new Date(),
  }) {
    const normalizedUserId = ShiftFundingService.validateObjectId(userId, "user ID");

    const normalizedShiftId = ShiftFundingService.validateObjectId(shiftId, "shift ID");

    ShiftFundingService.assertCanFundShifts(employerContext);

    ShiftFundingService.assertCanActivatePendingShift(employerContext);

    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    PaystackService.assertConfigured();

    const profile = await ShiftFundingService.getEmployerProfileForUser(
      normalizedUserId,
      employerProfile
    );

    const currency = ShiftFundingService.normalizeCurrency(
      profile.currency,
      "employer checkout currency"
    );

    const countryCode = ShiftFundingService.normalizeCountryCode(
      profile.countryCode,
      "employer checkout country code"
    );

    const customerEmail = String(profile.businessEmail || "")
      .trim()
      .toLowerCase();

    if (!customerEmail) {
      throw ShiftFundingService.createFundingError({
        message: "The employer payment email could not be resolved.",
        code: "EMPLOYER_CHECKOUT_EMAIL_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    const preparation = await runWithOptionalTransaction({}, async (session) => {
      const shift = await ShiftFundingService.getEmployerShiftForFunding({
        shiftId: normalizedShiftId,
        employerProfileId: profile._id,
        employerContext,
        session,
      });

      ShiftFundingService.assertFundingContext({ shift, countryCode, currency });

      const fundingWindowState = await ShiftFundingService.expireShiftWhenFundingWindowPassed({
        shift,
        currentTime: normalizedCurrentTime,
        session,
      });

      if (fundingWindowState.expired) {
        return {
          fundingWindowExpired: true,
          ...fundingWindowState,
        };
      }

      const fundingState = ShiftFundingService.assertShiftCanInitializePaystack(shift);

      if (fundingState.alreadyFunded) {
        return {
          alreadyFunded: true,
          shift,
        };
      }

      const openAttempt = await ShiftFundingService.getOpenPaystackAttempt({
        shiftId: shift._id,
        session,
      });

      if (ShiftFundingService.hasReusableCheckout(openAttempt)) {
        return {
          alreadyFunded: false,
          reused: true,

          shift,
          transaction: openAttempt,

          checkout: {
            authorizationUrl: openAttempt.metadata.authorizationUrl,

            mode: openAttempt.metadata.paystackMode || null,
          },
        };
      }

      if (openAttempt) {
        throw ShiftFundingService.createFundingError({
          message:
            "Paystack Checkout is already being initialized or processed " +
            "for this Shift. Please try again shortly.",

          code: "PAYSTACK_CHECKOUT_INITIALIZATION_IN_PROGRESS",
          statusCode: 409,

          details: {
            transactionId: String(openAttempt._id),
            status: openAttempt.status,
          },
        });
      }

      const latestAttempt = await ShiftFundingService.getLatestPaystackAttempt({
        shiftId: shift._id,
        session,
      });

      if (
        latestAttempt?.status === "completed" &&
        latestAttempt.metadata?.returnedToEmployerWallet !== true
      ) {
        throw ShiftFundingService.createFundingError({
          message:
            "A successful unapplied Paystack payment already exists for this Shift. " +
            "Another Checkout cannot be created.",

          code: "PAYSTACK_SHIFT_FUNDING_INTEGRITY_CONFLICT",
          statusCode: 409,

          details: {
            transactionId: String(latestAttempt._id),
            paystackReference: latestAttempt.paystackReference,

            fundingIntegrityReason: latestAttempt.metadata?.fundingIntegrityReason || null,
          },
        });
      }

      const amount = ShiftFundingService.validateFundingAmount(shift);

      await ShiftFundingService.assertOccurrenceFundingAllocation({
        shift,
        session,
      });

      const escrowWallet = await WalletService.getEscrowWallet(
        {
          countryCode,
          currency,
        },
        {
          session,
        }
      );

      ShiftFundingService.assertEscrowWallet({
        wallet: escrowWallet,
        countryCode,
        currency,
      });

      const paystackReference = WalletService.getTransactionReference("shift_funding");

      const idempotencyKey = `shift-paystack-checkout:${shift._id}:${paystackReference}`;

      const fundingInitiatedAt = normalizedCurrentTime;

      const pendingCredit = await WalletService.createPendingExternalCredit(
        {
          walletId: escrowWallet._id,

          amount,

          type: "shift_funding",
          purpose: "shift_base_funding",

          paymentRail: "paystack_checkout",
          provider: "paystack",

          reference: paystackReference,
          paystackReference,
          idempotencyKey,

          shift: shift._id,

          initiatedBy: {
            role: "employer",
            userId: normalizedUserId,
          },

          description: `Paystack Checkout funding for Shift ` + `${shift.referenceCode}.`,

          metadata: {
            fundingMethod: "paystack_checkout",

            employerProfileId: String(profile._id),

            shiftId: String(shift._id),
            referenceCode: shift.referenceCode,

            customerEmail,

            professionalPay: shift.estimatedProfessionalPay,
            platformFee: shift.estimatedPlatformFee,
            employerCharge: shift.estimatedEmployerCharge,

            callbackUrl,
            fundingInitiatedAt,

            appliedToShift: false,
            returnedToEmployerWallet: false,
            fundingIntegrityConflict: false,
          },
        },
        {
          session,
        }
      );

      shift.fundingMethod = "paystack_checkout";
      shift.fundingInitiatedAt = fundingInitiatedAt;

      await shift.save({
        session,
      });

      return {
        alreadyFunded: false,
        reused: false,

        shift,
        transaction: pendingCredit.transaction,

        amount,
        customerEmail,
        currency,
      };
    });

    if (preparation.fundingWindowExpired) {
      throw ShiftFundingService.buildFundingWindowExpiredError(preparation, {
        ...preparation,
      });
    }

    if (preparation.alreadyFunded) {
      return ShiftFundingService.buildAlreadyFundedResponse({
        shift: preparation.shift,
        currency,
      });
    }

    if (preparation.reused) {
      return ShiftFundingService.buildCheckoutInitializationResponse({
        shift: preparation.shift,
        transaction: preparation.transaction,
        checkout: preparation.checkout,
        currency,
        reused: true,
      });
    }

    try {
      const checkout = await PaystackService.initializeTransaction({
        email: preparation.customerEmail,
        amount: preparation.amount,
        reference: preparation.transaction.paystackReference,
        currency: preparation.currency,
        callbackUrl,

        metadata: {
          purpose: "shift_funding",
          fundingType: "shift_base_funding",
          paymentRail: "paystack_checkout",

          shiftId: String(preparation.shift._id),
          employerProfileId: String(profile._id),

          referenceCode: preparation.shift.referenceCode,
        },
      });

      const checkoutInitializedAt = normalizedCurrentTime;

      await Transaction.updateOne(
        {
          _id: preparation.transaction._id,
          status: "pending",
        },
        {
          $set: {
            paystackStatus: "pending",

            "metadata.authorizationUrl": checkout.authorizationUrl,
            "metadata.accessCode": checkout.accessCode,
            "metadata.paystackMode": checkout.mode,

            "metadata.checkoutInitializedAt": checkoutInitializedAt,
          },
        }
      );

      preparation.transaction.metadata = {
        ...(preparation.transaction.metadata || {}),

        authorizationUrl: checkout.authorizationUrl,
        accessCode: checkout.accessCode,
        paystackMode: checkout.mode,

        checkoutInitializedAt,
      };

      logger.info(
        `Paystack Checkout initialized for Shift ` +
          `${preparation.shift.referenceCode} with reference ` +
          `${checkout.reference}`
      );

      return ShiftFundingService.buildCheckoutInitializationResponse({
        shift: preparation.shift,
        transaction: preparation.transaction,
        checkout,
        currency,
        reused: false,
      });
    } catch (error) {
      const definitiveFailure = ShiftFundingService.isDefinitiveInitializationFailure(error);

      if (definitiveFailure) {
        await WalletService.markPendingExternalCreditFailed({
          transactionId: preparation.transaction._id,
          failureReason: error.message,

          metadata: {
            checkoutInitializationFailedAt: normalizedCurrentTime,
            checkoutInitializationErrorCode: error.code || null,
          },
        });

        await ShiftFundingService.clearFailedPaystackFundingSelection({
          shiftId: preparation.shift._id,
          transactionId: preparation.transaction._id,
        });
      } else {
        /*
         * Keep uncertain Paystack attempts pending to prevent duplicate funding.
         */
        await Transaction.updateOne(
          {
            _id: preparation.transaction._id,
            status: "pending",
          },
          {
            $set: {
              "metadata.checkoutInitializationUncertainAt": normalizedCurrentTime,

              "metadata.checkoutInitializationError": String(
                error.message || "Paystack initialization status is uncertain."
              ).slice(0, 300),

              "metadata.checkoutInitializationErrorCode": error.code || null,
            },
          }
        );
      }

      throw error;
    }
  }

  /* ─────────────────────────────── INITIALIZE OVERTIME TOP-UP CHECKOUT ─────────────────────────────── */

  static async initializeOvertimeTopUpCheckout({
    userId,
    employerProfile = null,
    employerContext = null,
    shiftId,
    occurrenceId,
    callbackUrl,
    currentTime = new Date(),
  }) {
    const normalizedUserId = ShiftFundingService.validateObjectId(userId, "user ID");
    const normalizedShiftId = ShiftFundingService.validateObjectId(shiftId, "shift ID");
    const normalizedOccurrenceId = ShiftFundingService.validateObjectId(
      occurrenceId,
      "occurrence ID"
    );

    ShiftFundingService.assertCanResolveExistingShiftObligations(employerContext);

    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    PaystackService.assertConfigured();

    const profile = await ShiftFundingService.getEmployerProfileForUser(
      normalizedUserId,
      employerProfile
    );

    const currency = ShiftFundingService.normalizeCurrency(
      profile.currency,
      "employer overtime checkout currency"
    );

    const countryCode = ShiftFundingService.normalizeCountryCode(
      profile.countryCode,
      "employer overtime checkout country code"
    );

    const customerEmail = String(profile.businessEmail || "")
      .trim()
      .toLowerCase();

    if (!customerEmail) {
      throw ShiftFundingService.createFundingError({
        message: "The employer payment email could not be resolved.",
        code: "EMPLOYER_CHECKOUT_EMAIL_NOT_RESOLVED",
        statusCode: 500,
      });
    }

    const preparation = await runWithOptionalTransaction({}, async (session) => {
      const shift = await ShiftFundingService.getEmployerShiftForFunding({
        shiftId: normalizedShiftId,
        employerProfileId: profile._id,
        employerContext,
        session,
      });

      const occurrence = await ShiftFundingService.getEmployerOccurrenceForOvertimeFunding({
        occurrenceId: normalizedOccurrenceId,
        employerProfileId: profile._id,
        employerContext,
        shiftId: normalizedShiftId,
        session,
      });

      ShiftFundingService.assertOccurrenceBelongsToShift({
        occurrence,
        shift,
      });

      ShiftFundingService.assertFundingContext({ shift, countryCode, currency });

      if (ShiftFundingService.isOvertimeTopUpFunded(occurrence)) {
        return {
          alreadyFunded: true,
          shift,
          occurrence,
        };
      }

      const { fundingRequirement } =
        ShiftOvertimeFundingService.assertOutstandingFundingState(occurrence);

      const openAttempt = await ShiftFundingService.getOpenOvertimeTopUpPaystackAttempt({
        shiftId: shift._id,
        occurrenceId: occurrence._id,
        session,
      });

      if (ShiftFundingService.hasReusableCheckout(openAttempt)) {
        return {
          alreadyFunded: false,
          reused: true,
          shift,
          occurrence,
          transaction: openAttempt,
          checkout: {
            authorizationUrl: openAttempt.metadata.authorizationUrl,
            mode: openAttempt.metadata.paystackMode || null,
          },
        };
      }

      if (openAttempt) {
        throw ShiftFundingService.createFundingError({
          message:
            "Paystack Checkout is already being initialized or processed for this overtime top-up.",
          code: "OVERTIME_TOPUP_CHECKOUT_INITIALIZATION_IN_PROGRESS",
          statusCode: 409,
          details: {
            transactionId: String(openAttempt._id),
            status: openAttempt.status,
          },
        });
      }

      const latestAttempt = await ShiftFundingService.getLatestOvertimeTopUpPaystackAttempt({
        shiftId: shift._id,
        occurrenceId: occurrence._id,
        session,
      });

      if (latestAttempt?.status === "completed") {
        throw ShiftFundingService.createFundingError({
          message:
            "A completed Paystack overtime top-up already exists for this occurrence " +
            "but is not reflected as the authoritative paid state. Another Checkout cannot be created.",
          code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
          statusCode: 409,
          details: {
            transactionId: String(latestAttempt._id),
            paystackReference: latestAttempt.paystackReference,
            appliedToOvertimeTopUp: latestAttempt.metadata?.appliedToOvertimeTopUp === true,
            fundingIntegrityReason: latestAttempt.metadata?.overtimeFundingIntegrityReason || null,
          },
        });
      }

      const escrowWallet = await WalletService.getEscrowWallet(
        {
          countryCode,
          currency,
        },
        {
          session,
        }
      );

      ShiftFundingService.assertEscrowWallet({
        wallet: escrowWallet,
        countryCode,
        currency,
      });

      const paystackReference = WalletService.getTransactionReference(
        OVERTIME_TOPUP_TRANSACTION_TYPE
      );

      const idempotencyKey =
        `shift-overtime-paystack-checkout:${occurrence._id}:` + paystackReference;

      const pendingCredit = await WalletService.createPendingExternalCredit(
        {
          walletId: escrowWallet._id,
          amount: fundingRequirement,

          type: OVERTIME_TOPUP_TRANSACTION_TYPE,
          purpose: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
          paymentRail: "paystack_checkout",
          provider: "paystack",

          reference: paystackReference,
          paystackReference,
          idempotencyKey,

          shift: shift._id,
          shiftOccurrence: occurrence._id,

          initiatedBy: {
            role: "employer",
            userId: normalizedUserId,
          },

          description: `Paystack Checkout overtime top-up for ${occurrence.referenceCode}.`,

          metadata: {
            fundingType: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
            employerProfileId: String(profile._id),
            shiftId: String(shift._id),
            shiftReferenceCode: shift.referenceCode,
            occurrenceId: String(occurrence._id),
            occurrenceReferenceCode: occurrence.referenceCode,
            customerEmail,
            overtimeProfessionalPay: Number(occurrence.overtimeProfessionalPay || 0),
            overtimePlatformFee: Number(occurrence.overtimePlatformFee || 0),
            topUpAmount: fundingRequirement,
            topUpDeadlineAt: occurrence.overtime?.topUpDeadlineAt || null,
            callbackUrl,
            checkoutInitiatedAt: normalizedCurrentTime,
            appliedToOvertimeTopUp: false,
            overtimeFundingIntegrityConflict: false,
          },
        },
        {
          session,
        }
      );

      return {
        alreadyFunded: false,
        reused: false,
        shift,
        occurrence,
        transaction: pendingCredit.transaction,
        amount: fundingRequirement,
        customerEmail,
        currency,
      };
    });

    if (preparation.alreadyFunded) {
      return ShiftFundingService.buildOvertimeTopUpAlreadyFundedResponse({
        shift: preparation.shift,
        occurrence: preparation.occurrence,
        currency,
      });
    }

    if (preparation.reused) {
      return ShiftFundingService.buildOvertimeCheckoutInitializationResponse({
        shift: preparation.shift,
        occurrence: preparation.occurrence,
        transaction: preparation.transaction,
        checkout: preparation.checkout,
        currency,
        reused: true,
      });
    }

    try {
      const checkout = await PaystackService.initializeTransaction({
        email: preparation.customerEmail,
        amount: preparation.amount,
        reference: preparation.transaction.paystackReference,
        currency: preparation.currency,
        callbackUrl,

        metadata: {
          purpose: "shift_topup",
          fundingType: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
          paymentRail: "paystack_checkout",
          shiftId: String(preparation.shift._id),
          occurrenceId: String(preparation.occurrence._id),
          employerProfileId: String(profile._id),
          referenceCode: preparation.shift.referenceCode,
          occurrenceReferenceCode: preparation.occurrence.referenceCode,
        },
      });

      // OT Checkout initialization
      const checkoutInitializedAt = normalizedCurrentTime;

      await Transaction.updateOne(
        {
          _id: preparation.transaction._id,
          status: "pending",
        },
        {
          $set: {
            paystackStatus: "pending",
            "metadata.authorizationUrl": checkout.authorizationUrl,
            "metadata.accessCode": checkout.accessCode,
            "metadata.paystackMode": checkout.mode,
            "metadata.checkoutInitializedAt": normalizedCurrentTime,
          },
        }
      );

      preparation.transaction.metadata = {
        ...(preparation.transaction.metadata || {}),
        authorizationUrl: checkout.authorizationUrl,
        accessCode: checkout.accessCode,
        paystackMode: checkout.mode,
        checkoutInitializedAt,
      };

      logger.info(
        `Paystack Checkout initialized for overtime top-up ` +
          `${preparation.occurrence.referenceCode} with reference ${checkout.reference}`
      );

      return ShiftFundingService.buildOvertimeCheckoutInitializationResponse({
        shift: preparation.shift,
        occurrence: preparation.occurrence,
        transaction: preparation.transaction,
        checkout,
        currency,
        reused: false,
      });
    } catch (error) {
      const definitiveFailure = ShiftFundingService.isDefinitiveInitializationFailure(error);

      if (definitiveFailure) {
        await WalletService.markPendingExternalCreditFailed({
          transactionId: preparation.transaction._id,
          failureReason: error.message,

          metadata: {
            checkoutInitializationFailedAt: normalizedCurrentTime,
            checkoutInitializationErrorCode: error.code || null,
          },
        });
      } else {
        await Transaction.updateOne(
          {
            _id: preparation.transaction._id,
            status: "pending",
          },
          {
            $set: {
              "metadata.checkoutInitializationUncertainAt": normalizedCurrentTime,
              "metadata.checkoutInitializationError": String(
                error.message || "Paystack overtime top-up initialization status is uncertain."
              ).slice(0, 300),
              "metadata.checkoutInitializationErrorCode": error.code || null,
            },
          }
        );
      }

      throw error;
    }
  }

  /* ─────────────────────────────── VERIFY PAYSTACK PAYMENT ─────────────────────────────── */

  static validateVerifiedPaystackPayment({ verifiedPayment, transaction }) {
    const verifiedStatus = String(verifiedPayment?.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      throw ShiftFundingService.createFundingError({
        message: "The Paystack payment has not been completed successfully.",
        code: "PAYSTACK_PAYMENT_NOT_SUCCESSFUL",
        statusCode: 409,

        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    const verifiedAmount = Number(verifiedPayment.amount);

    if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== Number(transaction.amount)) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack amount does not match the Shift funding amount.",
        code: "PAYSTACK_PAYMENT_AMOUNT_MISMATCH",
        statusCode: 409,

        details: {
          expectedAmount: transaction.amount,
          verifiedAmount,
        },
      });
    }

    const verifiedCurrency = String(verifiedPayment.currency || "")
      .trim()
      .toUpperCase();

    const expectedCurrency = String(transaction.currency || "")
      .trim()
      .toUpperCase();

    if (!verifiedCurrency || verifiedCurrency !== expectedCurrency) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack currency does not match the Shift currency.",
        code: "PAYSTACK_PAYMENT_CURRENCY_MISMATCH",
        statusCode: 409,

        details: {
          expectedCurrency,
          verifiedCurrency: verifiedCurrency || null,
        },
      });
    }

    const verifiedReference = String(verifiedPayment.reference || "").trim();

    if (verifiedReference !== transaction.paystackReference) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack reference does not match the internal funding transaction.",
        code: "PAYSTACK_PAYMENT_REFERENCE_MISMATCH",
        statusCode: 409,
      });
    }

    const expectedEmail = String(transaction.metadata?.customerEmail || "")
      .trim()
      .toLowerCase();

    const verifiedEmail = String(verifiedPayment.customerEmail || "")
      .trim()
      .toLowerCase();

    if (expectedEmail && verifiedEmail && expectedEmail !== verifiedEmail) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack customer does not match the expected employer email.",
        code: "PAYSTACK_PAYMENT_CUSTOMER_MISMATCH",
        statusCode: 409,
      });
    }

    const metadataShiftId =
      verifiedPayment.metadata && typeof verifiedPayment.metadata === "object"
        ? verifiedPayment.metadata.shiftId
        : null;

    if (metadataShiftId && String(metadataShiftId) !== String(transaction.shift)) {
      throw ShiftFundingService.createFundingError({
        message: "The Paystack payment metadata does not match the expected Shift.",
        code: "PAYSTACK_PAYMENT_SHIFT_MISMATCH",
        statusCode: 409,
      });
    }

    const metadataOccurrenceId =
      verifiedPayment.metadata && typeof verifiedPayment.metadata === "object"
        ? verifiedPayment.metadata.occurrenceId || verifiedPayment.metadata.shiftOccurrenceId
        : null;

    if (
      transaction.shiftOccurrence &&
      metadataOccurrenceId &&
      String(metadataOccurrenceId) !== String(transaction.shiftOccurrence)
    ) {
      throw ShiftFundingService.createFundingError({
        message: "The Paystack payment metadata does not match the expected Shift occurrence.",
        code: "PAYSTACK_PAYMENT_OCCURRENCE_MISMATCH",
        statusCode: 409,
      });
    }

    ShiftFundingService.resolveVerifiedPaymentTime(verifiedPayment);

    return true;
  }

  static getVerifiedProviderAmounts(verifiedPayment) {
    const amount = Number(verifiedPayment.amount);

    const rawProviderFee = verifiedPayment.fees;
    const providerFee =
      typeof rawProviderFee === "number" ||
      (typeof rawProviderFee === "string" && /^\d+$/.test(rawProviderFee))
        ? Number(rawProviderFee)
        : NaN;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack payment amount is invalid.",
        code: "INVALID_VERIFIED_PAYSTACK_AMOUNT",
        statusCode: 409,
      });
    }

    if (!Number.isSafeInteger(providerFee) || providerFee < 0 || providerFee > amount) {
      throw ShiftFundingService.createFundingError({
        message: "The verified Paystack provider fee is invalid.",
        code: "INVALID_VERIFIED_PAYSTACK_PROVIDER_FEE",
        statusCode: 409,
      });
    }

    return {
      providerFee,
      netAmount: amount - providerFee,
    };
  }

  /* ─────────────────────────────── PAYSTACK SHIFT-PAYMENT DISPATCH ─────────────────────────────── */

  static async finalizePaystackShiftFunding({
    reference,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    const normalizedReference = String(reference || "").trim();

    if (!normalizedReference) {
      throw ShiftFundingService.createFundingError({
        message: "A Paystack payment reference is required.",
        code: "PAYSTACK_PAYMENT_REFERENCE_REQUIRED",
      });
    }

    const transaction = await Transaction.findOne({
      paystackReference: normalizedReference,
      paymentRail: "paystack_checkout",
      provider: "paystack",
      type: {
        $in: [BASE_FUNDING_TRANSACTION_TYPE, OVERTIME_TOPUP_TRANSACTION_TYPE],
      },
    }).select("type purpose");

    if (!transaction) {
      throw ShiftFundingService.createFundingError({
        message: "The internal Paystack Shift payment transaction was not found.",
        code: "PAYSTACK_SHIFT_TRANSACTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (
      transaction.type === BASE_FUNDING_TRANSACTION_TYPE &&
      transaction.purpose === BASE_FUNDING_TRANSACTION_PURPOSE
    ) {
      return ShiftFundingService.finalizePaystackBaseFunding({
        reference: normalizedReference,
        providerEventId,
        currentTime,
      });
    }

    if (
      transaction.type === OVERTIME_TOPUP_TRANSACTION_TYPE &&
      transaction.purpose === OVERTIME_TOPUP_TRANSACTION_PURPOSE
    ) {
      return ShiftFundingService.finalizePaystackOvertimeTopUp({
        reference: normalizedReference,
        providerEventId,
        currentTime,
      });
    }

    throw ShiftFundingService.createFundingError({
      message: "The Paystack Shift payment transaction has an unsupported funding purpose.",
      code: "UNSUPPORTED_PAYSTACK_SHIFT_PAYMENT_PURPOSE",
      statusCode: 409,
      details: {
        type: transaction.type,
        purpose: transaction.purpose,
      },
    });
  }

  /* ─────────────────────────────── FINALIZE BASE PAYSTACK FUNDING ─────────────────────────────── */

  static async finalizePaystackBaseFunding({
    reference,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    const verifiedPayment = await PaystackService.verifyTransaction(reference);

    const internalTransaction = await Transaction.findOne({
      paystackReference: verifiedPayment.reference,

      type: "shift_funding",
      purpose: "shift_base_funding",

      paymentRail: "paystack_checkout",
      provider: "paystack",
    });

    if (!internalTransaction) {
      throw ShiftFundingService.createFundingError({
        message: "The internal Paystack Shift-funding transaction was not found.",
        code: "PAYSTACK_SHIFT_TRANSACTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    const verifiedStatus = String(verifiedPayment.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      if (PAYSTACK_DEFINITIVE_FAILURE_STATUSES.includes(verifiedStatus)) {
        await WalletService.markPendingExternalCreditFailed({
          transactionId: internalTransaction._id,

          failureReason: `Paystack payment status: ${verifiedStatus}.`,

          // OT Paystack definitive failure
          metadata: {
            verifiedAt: normalizedCurrentTime,
            verifiedPaystackStatus: verifiedStatus,
          },
        });

        await ShiftFundingService.clearFailedPaystackFundingSelection({
          shiftId: internalTransaction.shift,
          transactionId: internalTransaction._id,
        });
      }

      throw ShiftFundingService.createFundingError({
        message: "The Paystack payment has not been completed successfully.",
        code: "PAYSTACK_PAYMENT_NOT_SUCCESSFUL",
        statusCode: 409,

        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    ShiftFundingService.validateVerifiedPaystackPayment({
      verifiedPayment,
      transaction: internalTransaction,
    });

    const verifiedPaymentTime = ShiftFundingService.resolveVerifiedPaymentTime(verifiedPayment);

    const providerAmounts = ShiftFundingService.getVerifiedProviderAmounts(verifiedPayment);

    /*
     * A provider payment cannot be rolled back by a local validation failure.
     * Commit its idempotent escrow credit before applying or returning it.
     */
    const completedCredit = await WalletService.completePendingExternalCredit({
      transactionId: internalTransaction._id,
      providerEventId,

      providerFee: providerAmounts.providerFee,
      netAmount: providerAmounts.netAmount,

      metadata: {
        fundingApplicationPending: true,
        fundingApplicationRecordedAt: normalizedCurrentTime,
        appliedToShift: false,
        returnedToEmployerWallet: false,
        verifiedAt: normalizedCurrentTime,
        verifiedPaymentTime,

        paystackTransactionId: verifiedPayment.id,
        paystackChannel: verifiedPayment.channel,
        paystackDomain: verifiedPayment.domain,
        paystackPaidAt: verifiedPayment.paidAt,

        paystackGatewayResponse: verifiedPayment.gatewayResponse,

        verifiedAmount: verifiedPayment.amount,
        verifiedCurrency: verifiedPayment.currency,

        verifiedCustomerEmail: verifiedPayment.customerEmail,
      },
    });

    const finalizationResult = await runWithOptionalTransaction({}, async (session) => {
      const transaction = await Transaction.findOne({
        _id: internalTransaction._id,

        paystackReference: verifiedPayment.reference,

        type: "shift_funding",
        purpose: "shift_base_funding",

        paymentRail: "paystack_checkout",
        provider: "paystack",
      }).session(session);

      if (!transaction) {
        throw ShiftFundingService.createFundingError({
          message: "The internal Paystack funding transaction was not found.",
          code: "PAYSTACK_SHIFT_TRANSACTION_NOT_FOUND",
          statusCode: 404,
        });
      }

      ShiftFundingService.validateVerifiedPaystackPayment({
        verifiedPayment,
        transaction,
      });

      let shift = await ShiftFundingService.getSystemShiftForFunding({
        shiftId: transaction.shift,
        session,
      });

      const shiftStartTime = shift.startTime ? new Date(shift.startTime) : null;

      if (!shiftStartTime || Number.isNaN(shiftStartTime.getTime())) {
        throw ShiftFundingService.createFundingError({
          message: "The Shift start time is invalid.",
          code: "INVALID_SHIFT_START_TIME",
          statusCode: 500,
        });
      }

      const completedTransaction = transaction;
      const escrowWallet = completedCredit.wallet;

      ShiftFundingService.assertEscrowWallet({
        wallet: escrowWallet,
        countryCode: completedTransaction.countryCode,
        currency: completedTransaction.currency,
      });

      /*
       * A previously completed return must be replayed through
       * the same deterministic transfer keys. WalletService will
       * return the existing paired entries without moving money again.
       */
      if (completedTransaction.metadata?.returnedToEmployerWallet === true) {
        const recordedReturnReason = completedTransaction.metadata.returnReason;

        if (!SHIFT_PAYMENT_RETURN_PURPOSE_BY_REASON[recordedReturnReason]) {
          throw ShiftFundingService.createFundingError({
            message: "The completed Paystack payment contains an invalid recorded return reason.",
            code: "INVALID_RECORDED_PAYSTACK_RETURN_REASON",
            statusCode: 409,
          });
        }

        return ShiftFundingService.returnSuccessfulPaystackPaymentToEmployer({
          transaction: completedTransaction,
          shift,
          escrowWallet,

          returnReason: recordedReturnReason,

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      /*
       * The Shift is already fully funded.
       *
       * If this exact Paystack transaction is authoritative, this
       * is a normal idempotent replay.
       *
       * If another transaction is authoritative, this successful
       * payment is duplicate funding and must be returned.
       */
      if (ShiftFundingService.isShiftFullyFunded(shift)) {
        if (ShiftFundingService.isAuthoritativeFundingTransaction(shift, completedTransaction)) {
          completedTransaction.metadata = {
            ...(completedTransaction.metadata || {}),

            fundingApplicationPending: false,
            fundingApplicationLastErrorAt: null,
            fundingApplicationLastErrorCode: null,
            fundingApplicationLastErrorMessage: null,
            appliedToShift: true,

            appliedToShiftAt: completedTransaction.metadata?.appliedToShiftAt || shift.fundedAt,

            returnedToEmployerWallet: false,

            fundingIntegrityConflict: false,

            fundingIntegrityReason: null,

            authoritativeFundingTransactionId: String(completedTransaction._id),
          };

          completedTransaction.markModified("metadata");

          await completedTransaction.save({
            session,
          });

          return ShiftFundingService.buildPaystackFundingResponse({
            shift,
            transaction: completedTransaction,
            currency: completedTransaction.currency,
            idempotent: true,
          });
        }

        return ShiftFundingService.returnSuccessfulPaystackPaymentToEmployer({
          transaction: completedTransaction,
          shift,
          escrowWallet,

          returnReason: "duplicate",

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      if (
        shift.status === "cancelled" &&
        shift.cancelledFromStatus === "pending_funding" &&
        shift.cancellationCode === "employer_cancelled"
      ) {
        return ShiftFundingService.returnSuccessfulPaystackPaymentToEmployer({
          transaction: completedTransaction,
          shift,
          escrowWallet,

          returnReason: "employer_cancelled",

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      const paymentMissedFundingDeadline = verifiedPaymentTime >= shiftStartTime;

      const confirmationArrivedAfterStart = normalizedCurrentTime >= shiftStartTime;

      /*
       * A payment completed at/after startTime is genuinely late.
       */
      if (paymentMissedFundingDeadline) {
        if (shift.status === "pending_funding" && shift.paymentStatus === "unpaid") {
          await ShiftLifecycleService.expireUnfundedShift(
            {
              shiftId: shift._id,
              now: normalizedCurrentTime,
            },
            {
              session,
            }
          );

          shift = await ShiftFundingService.getSystemShiftForFunding({
            shiftId: shift._id,
            session,
          });
        }

        return ShiftFundingService.returnSuccessfulPaystackPaymentToEmployer({
          transaction: completedTransaction,
          shift,
          escrowWallet,

          returnReason: "late",

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      /*
       * The employer paid on time, but confirmation arrived after the
       * unfunded Shift reached its operational start.
       */
      if (confirmationArrivedAfterStart) {
        if (shift.status === "pending_funding" && shift.paymentStatus === "unpaid") {
          await ShiftLifecycleService.expireUnfundedShift(
            {
              shiftId: shift._id,
              now: normalizedCurrentTime,
            },
            {
              session,
            }
          );

          shift = await ShiftFundingService.getSystemShiftForFunding({
            shiftId: shift._id,
            session,
          });
        }

        if (shift.status === "cancelled" && shift.cancellationCode === "funding_deadline_passed") {
          return ShiftFundingService.returnSuccessfulPaystackPaymentToEmployer({
            transaction: completedTransaction,
            shift,
            escrowWallet,

            returnReason: "timely_expired",

            verifiedPaymentTime,
            currentTime: normalizedCurrentTime,

            session,
          });
        }

        return ShiftFundingService.markPaystackFundingIntegrityConflict({
          transaction: completedTransaction,
          shift,

          reason: "timely_payment_state_conflict_after_start",

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      /*
       * Any non-standard funding state before start requires investigation.
       */
      if (shift.fundingMethod && shift.fundingMethod !== "paystack_checkout") {
        return ShiftFundingService.markPaystackFundingIntegrityConflict({
          transaction: completedTransaction,
          shift,

          reason: "another_funding_method_selected_without_completed_funding",

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      if (shift.status !== "pending_funding" || shift.paymentStatus !== "unpaid") {
        return ShiftFundingService.markPaystackFundingIntegrityConflict({
          transaction: completedTransaction,
          shift,

          reason: "shift_state_no_longer_accepts_initial_funding",

          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,

          session,
        });
      }

      const fundingState = ShiftFundingService.assertShiftCanApplyPaystackFunding(shift);

      if (fundingState.alreadyFunded) {
        throw ShiftFundingService.createFundingError({
          message: "The Shift funding state changed while the Paystack payment was processed.",
          code: "INCONSISTENT_SHIFT_FUNDING_STATE",
          statusCode: 409,
        });
      }

      if (
        completedTransaction.amount !== ShiftFundingService.validateFundingAmount(shift) ||
        completedTransaction.countryCode !== shift.countryCode ||
        completedTransaction.currency !== shift.currency
      ) {
        return ShiftFundingService.markPaystackFundingIntegrityConflict({
          transaction: completedTransaction,
          shift,
          reason: "payment_does_not_match_shift_funding_snapshot",
          verifiedPaymentTime,
          currentTime: normalizedCurrentTime,
          session,
        });
      }

      await ShiftFundingService.assertOccurrenceFundingAllocation({
        shift,
        session,
      });

      /*
       * fundedAt records when Paystack says the payment succeeded.
       * publishedAt records when Loqum applied it and published the Shift.
       */
      const fundingTime = verifiedPaymentTime;
      const publicationTime = normalizedCurrentTime;

      shift.fundingMethod = "paystack_checkout";

      shift.fundedAmount = shift.estimatedEmployerCharge;
      shift.fundedAt = fundingTime;
      shift.publishedAt = publicationTime;

      shift.fundingTransaction = completedTransaction._id;

      shift.paymentStatus = "funded";
      shift.status = "open";

      await shift.save({
        session,
      });

      completedTransaction.metadata = {
        ...(completedTransaction.metadata || {}),

        fundingApplicationPending: false,
        fundingApplicationLastErrorAt: null,
        fundingApplicationLastErrorCode: null,
        fundingApplicationLastErrorMessage: null,
        appliedToShift: true,
        appliedToShiftAt: publicationTime,
        fundingEffectiveAt: fundingTime,

        returnedToEmployerWallet: false,

        fundingIntegrityConflict: false,

        fundingIntegrityReason: null,

        authoritativeFundingTransactionId: String(completedTransaction._id),
      };

      completedTransaction.markModified("metadata");

      await completedTransaction.save({
        session,
      });

      await EmployerProfile.updateOne(
        {
          _id: shift.business,
        },
        {
          $inc: {
            totalShiftsPosted: 1,
            totalShiftsPaid: 1,

            totalAmountFunded: shift.estimatedEmployerCharge,

            totalProfessionalPayFunded: shift.estimatedProfessionalPay,
          },

          $set: {
            lastShiftPostedAt: publicationTime,
          },
        },
        {
          session,
        }
      );

      logger.info(
        `Shift ${shift.referenceCode} funded through Paystack ` +
          `Checkout and published with reference ` +
          `${completedTransaction.paystackReference}`
      );

      return ShiftFundingService.buildPaystackFundingResponse({
        shift,
        transaction: completedTransaction,
        currency: completedTransaction.currency,
        idempotent: false,
      });
    }).catch(async (error) => {
      try {
        await ShiftFundingService.recordUnappliedBaseFundingError({
          transactionId: completedCredit.transaction._id,
          error,
          currentTime: normalizedCurrentTime,
        });
      } catch (auditError) {
        // The committed credit still carries its initial pending marker.
        logger.error("Unable to record the BASE funding application error.", {
          transactionId: String(completedCredit.transaction._id),
          error: auditError.message,
        });
      }

      throw error;
    });

    if (finalizationResult?.fundingIntegrityConflict) {
      throw ShiftFundingService.createFundingError({
        message:
          "The Paystack payment succeeded and remains protected in escrow, " +
          "but the Shift funding state is financially inconsistent and requires investigation.",

        code: "PAYSTACK_SHIFT_FUNDING_INTEGRITY_CONFLICT",
        statusCode: 409,

        details: finalizationResult,
      });
    }

    return finalizationResult;
  }

  /* ─────────────────────────────── OVERTIME PAYSTACK INTEGRITY ─────────────────────────────── */

  static async markPaystackOvertimeFundingIntegrityConflict({
    transaction,
    reason,
    currentTime,
    verifiedPaymentTime,
    error = null,
  }) {
    transaction.metadata = {
      ...(transaction.metadata || {}),
      appliedToOvertimeTopUp: false,
      overtimeFundingIntegrityConflict: true,
      overtimeFundingIntegrityReason: reason,
      overtimeFundingIntegrityDetectedAt: currentTime,
      verifiedPaymentTime,
      overtimeFundingIntegrityErrorCode: error?.code || null,
      overtimeFundingIntegrityErrorMessage: error?.message
        ? String(error.message).slice(0, 300)
        : null,
    };

    transaction.markModified("metadata");

    await transaction.save();

    logger.error(
      `Paystack overtime top-up integrity conflict for transaction ` +
        `${transaction.paystackReference}: ${reason}. Funds remain protected in escrow.`
    );

    return {
      fundingIntegrityConflict: true,
      reason,
      transactionId: String(transaction._id),
      paystackReference: transaction.paystackReference,
      shiftId: transaction.shift ? String(transaction.shift) : null,
      occurrenceId: transaction.shiftOccurrence ? String(transaction.shiftOccurrence) : null,
      amount: transaction.amount,
      verifiedPaymentTime,
    };
  }

  /* ─────────────────────────────── FINALIZE OVERTIME PAYSTACK TOP-UP ─────────────────────────────── */

  static async finalizePaystackOvertimeTopUp({
    reference,
    providerEventId = null,
    currentTime = new Date(),
  }) {
    const normalizedCurrentTime = ShiftFundingService.normalizeCurrentTime(currentTime);

    const verifiedPayment = await PaystackService.verifyTransaction(reference);

    const internalTransaction = await Transaction.findOne({
      paystackReference: verifiedPayment.reference,
      type: OVERTIME_TOPUP_TRANSACTION_TYPE,
      purpose: OVERTIME_TOPUP_TRANSACTION_PURPOSE,
      paymentRail: "paystack_checkout",
      provider: "paystack",
    });

    if (!internalTransaction) {
      throw ShiftFundingService.createFundingError({
        message: "The internal Paystack overtime top-up transaction was not found.",
        code: "PAYSTACK_OVERTIME_TOPUP_TRANSACTION_NOT_FOUND",
        statusCode: 404,
      });
    }

    const verifiedStatus = String(verifiedPayment.status || "")
      .trim()
      .toLowerCase();

    if (verifiedStatus !== "success") {
      if (PAYSTACK_DEFINITIVE_FAILURE_STATUSES.includes(verifiedStatus)) {
        await WalletService.markPendingExternalCreditFailed({
          transactionId: internalTransaction._id,
          failureReason: `Paystack payment status: ${verifiedStatus}.`,

          // BASE Paystack definitive failure
          metadata: {
            verifiedAt: normalizedCurrentTime,
            verifiedPaystackStatus: verifiedStatus,
          },
        });
      }

      throw ShiftFundingService.createFundingError({
        message: "The Paystack overtime top-up has not been completed successfully.",
        code: "PAYSTACK_OVERTIME_TOPUP_NOT_SUCCESSFUL",
        statusCode: 409,
        details: {
          paystackStatus: verifiedStatus || null,
        },
      });
    }

    ShiftFundingService.validateVerifiedPaystackPayment({
      verifiedPayment,
      transaction: internalTransaction,
    });

    const verifiedPaymentTime = ShiftFundingService.resolveVerifiedPaymentTime(verifiedPayment);
    const providerAmounts = ShiftFundingService.getVerifiedProviderAmounts(verifiedPayment);

    /*
     * External money is recorded first and committed independently.
     *
     * Unlike an internal wallet transfer, a successful provider payment cannot
     * be rolled back at Paystack if later Loqum business-state application
     * fails. The escrow credit must therefore remain recorded even when a
     * downstream OT authority conflict requires reconciliation.
     */
    const completedCredit = await WalletService.completePendingExternalCredit({
      transactionId: internalTransaction._id,
      providerEventId,
      providerFee: providerAmounts.providerFee,
      netAmount: providerAmounts.netAmount,
      metadata: {
        verifiedAt: normalizedCurrentTime,
        verifiedPaymentTime,
        paystackTransactionId: verifiedPayment.id,
        paystackChannel: verifiedPayment.channel,
        paystackDomain: verifiedPayment.domain,
        paystackPaidAt: verifiedPayment.paidAt,
        paystackGatewayResponse: verifiedPayment.gatewayResponse,
        verifiedAmount: verifiedPayment.amount,
        verifiedCurrency: verifiedPayment.currency,
        verifiedCustomerEmail: verifiedPayment.customerEmail,
      },
    });

    const completedTransaction = completedCredit.transaction;
    const escrowWallet = completedCredit.wallet;

    ShiftFundingService.assertEscrowWallet({
      wallet: escrowWallet,
      countryCode: completedTransaction.countryCode,
      currency: completedTransaction.currency,
    });

    if (!completedTransaction.shiftOccurrence) {
      const conflict = await ShiftFundingService.markPaystackOvertimeFundingIntegrityConflict({
        transaction: completedTransaction,
        reason: "missing_shift_occurrence_link",
        currentTime: normalizedCurrentTime,
        verifiedPaymentTime,
      });

      throw ShiftFundingService.createFundingError({
        message:
          "The Paystack overtime payment succeeded and remains protected in escrow, " +
          "but its Shift occurrence link is missing and requires investigation.",
        code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
        statusCode: 409,
        details: conflict,
      });
    }

    let occurrence;
    let shift;

    try {
      [occurrence, shift] = await Promise.all([
        ShiftFundingService.getSystemOccurrenceForOvertimeFunding({
          occurrenceId: completedTransaction.shiftOccurrence,
        }),
        ShiftFundingService.getSystemShiftForFunding({
          shiftId: completedTransaction.shift,
        }),
      ]);

      ShiftFundingService.assertOccurrenceBelongsToShift({
        occurrence,
        shift,
      });

      ShiftFundingService.assertFundingContext({
        shift,
        countryCode: completedTransaction.countryCode,
        currency: completedTransaction.currency,
      });
    } catch (error) {
      const conflict = await ShiftFundingService.markPaystackOvertimeFundingIntegrityConflict({
        transaction: completedTransaction,
        reason: "overtime_authority_resolution_failed",
        currentTime: normalizedCurrentTime,
        verifiedPaymentTime,
        error,
      });

      throw ShiftFundingService.createFundingError({
        message:
          "The Paystack overtime payment succeeded and remains protected in escrow, " +
          "but the linked overtime authority could not be resolved.",
        code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
        statusCode: 409,
        details: conflict,
        cause: error,
      });
    }

    if (
      ShiftFundingService.isOvertimeTopUpFunded(occurrence) &&
      String(occurrence.topUpTransaction) !== String(completedTransaction._id)
    ) {
      const conflict = await ShiftFundingService.markPaystackOvertimeFundingIntegrityConflict({
        transaction: completedTransaction,
        reason: "different_overtime_topup_transaction_already_authoritative",
        currentTime: normalizedCurrentTime,
        verifiedPaymentTime,
      });

      throw ShiftFundingService.createFundingError({
        message:
          "The Paystack overtime payment succeeded and remains protected in escrow, " +
          "but this occurrence was already funded by another transaction.",
        code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
        statusCode: 409,
        details: conflict,
      });
    }

    let confirmationResult;

    try {
      confirmationResult = await ShiftOvertimeFundingService.confirmTopUpFunding({
        occurrenceId: occurrence._id,
        topUpTransactionId: completedTransaction._id,
        currentTime: normalizedCurrentTime,
        initiatedBy: {
          role: "system",
          userId: null,
        },
      });
    } catch (error) {
      const conflict = await ShiftFundingService.markPaystackOvertimeFundingIntegrityConflict({
        transaction: completedTransaction,
        reason: "overtime_topup_confirmation_failed",
        currentTime: normalizedCurrentTime,
        verifiedPaymentTime,
        error,
      });

      throw ShiftFundingService.createFundingError({
        message:
          "The Paystack overtime payment succeeded and remains protected in escrow, " +
          "but it could not be applied to the overtime obligation automatically.",
        code: "PAYSTACK_OVERTIME_TOPUP_INTEGRITY_CONFLICT",
        statusCode: 409,
        details: conflict,
        cause: error,
      });
    }

    occurrence = confirmationResult.occurrence || occurrence;

    await Transaction.updateOne(
      {
        _id: completedTransaction._id,
      },
      {
        $set: {
          "metadata.appliedToOvertimeTopUp": true,
          "metadata.appliedToOvertimeTopUpAt":
            completedTransaction.metadata?.appliedToOvertimeTopUpAt || normalizedCurrentTime,
          "metadata.overtimeFundingIntegrityConflict": false,
          "metadata.overtimeFundingIntegrityReason": null,
          "metadata.authoritativeTopUpTransactionId": String(completedTransaction._id),
        },
      }
    );

    completedTransaction.metadata = {
      ...(completedTransaction.metadata || {}),
      appliedToOvertimeTopUp: true,
      appliedToOvertimeTopUpAt:
        completedTransaction.metadata?.appliedToOvertimeTopUpAt || normalizedCurrentTime,
      overtimeFundingIntegrityConflict: false,
      overtimeFundingIntegrityReason: null,
      authoritativeTopUpTransactionId: String(completedTransaction._id),
    };

    logger.info(
      `Paystack overtime top-up confirmed for occurrence ` +
        `${occurrence.referenceCode} with reference ${completedTransaction.paystackReference}`
    );

    return ShiftFundingService.buildPaystackOvertimeTopUpResponse({
      shift,
      occurrence,
      transaction: completedTransaction,
      currency: completedTransaction.currency,
      confirmationResult,
    });
  }
}

module.exports = ShiftFundingService;
