// services/shiftFundingService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const Transaction = require("../models/Transaction");
const EmployerProfile = require("../models/EmployerProfile");

const WalletService = require("./walletService");
const PaystackService = require("./paystackService");
const ShiftLifecycleService = require("./shiftLifecycleService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { SHIFT_PAYMENT_RETURN_PURPOSE_BY_REASON } = require("../constants/transaction");

const money = require("../utils/money");
const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";

const PAYSTACK_OPEN_STATUSES = ["pending", "processing"];
const PAYSTACK_DEFINITIVE_FAILURE_STATUSES = ["failed", "abandoned", "reversed"];

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
    if (employerContext?.canPostShifts !== true) {
      throw ShiftFundingService.createFundingError({
        message: "You do not have permission to fund and publish shifts.",
        code: "SHIFT_FUNDING_NOT_ALLOWED",
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

      "assignedProfessional",
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

    const query = Shift.findOne(filter).select(ShiftFundingService.getFundingShiftFields());

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

    const query = Shift.findById(normalizedShiftId).select(
      ShiftFundingService.getFundingShiftFields()
    );

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

  /* ─────────────────────────────── FUNDING VALIDATION ─────────────────────────────── */

  static validateFundingAmount(shift) {
    const amount = Number(shift?.estimatedEmployerCharge);

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
    const allocation = await ShiftOccurrence.aggregate([
      {
        $match: {
          shift: shift._id,
        },
      },
      {
        $group: {
          _id: "$shift",

          occurrenceCount: {
            $sum: 1,
          },

          estimatedProfessionalPay: {
            $sum: "$estimatedProfessionalPay",
          },

          estimatedPlatformFee: {
            $sum: "$estimatedPlatformFee",
          },

          estimatedEmployerCharge: {
            $sum: "$estimatedEmployerCharge",
          },
        },
      },
    ]).session(session);

    const summary = allocation[0];

    if (!summary) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift does not have any occurrence funding allocations.",
        code: "SHIFT_OCCURRENCES_NOT_FOUND",
        statusCode: 409,
      });
    }

    const expectedOccurrenceCount = Number(shift.occurrenceCount || 0);

    if (
      !Number.isSafeInteger(expectedOccurrenceCount) ||
      expectedOccurrenceCount <= 0 ||
      summary.occurrenceCount !== expectedOccurrenceCount
    ) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift occurrence count does not match its funding allocation.",
        code: "SHIFT_OCCURRENCE_COUNT_MISMATCH",
        statusCode: 409,

        details: {
          expectedOccurrenceCount,
          actualOccurrenceCount: summary.occurrenceCount,
        },
      });
    }

    const expectedProfessionalPay = Number(shift.estimatedProfessionalPay);
    const expectedPlatformFee = Number(shift.estimatedPlatformFee);
    const expectedEmployerCharge = Number(shift.estimatedEmployerCharge);

    const allocationIsValid =
      Number.isSafeInteger(summary.estimatedProfessionalPay) &&
      Number.isSafeInteger(summary.estimatedPlatformFee) &&
      Number.isSafeInteger(summary.estimatedEmployerCharge) &&
      summary.estimatedProfessionalPay === expectedProfessionalPay &&
      summary.estimatedPlatformFee === expectedPlatformFee &&
      summary.estimatedEmployerCharge === expectedEmployerCharge &&
      summary.estimatedEmployerCharge ===
        summary.estimatedProfessionalPay + summary.estimatedPlatformFee;

    if (!allocationIsValid) {
      throw ShiftFundingService.createFundingError({
        message: "The occurrence funding allocation does not match the parent Shift totals.",
        code: "SHIFT_OCCURRENCE_FUNDING_MISMATCH",
        statusCode: 409,

        details: {
          parent: {
            estimatedProfessionalPay: expectedProfessionalPay,
            estimatedPlatformFee: expectedPlatformFee,
            estimatedEmployerCharge: expectedEmployerCharge,
          },

          occurrences: {
            estimatedProfessionalPay: summary.estimatedProfessionalPay,
            estimatedPlatformFee: summary.estimatedPlatformFee,
            estimatedEmployerCharge: summary.estimatedEmployerCharge,
          },
        },
      });
    }

    return summary;
  }

  static isShiftFullyFunded(shift) {
    const employerCharge = Number(shift?.estimatedEmployerCharge || 0);
    const fundedAmount = Number(shift?.fundedAmount || 0);

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
      Number(shift.fundedAmount || 0) === 0 &&
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

    if (Number(shift.fundedAmount || 0) !== 0) {
      throw ShiftFundingService.createFundingError({
        message: "An unpaid pending-funding Shift cannot already contain protected funding.",
        code: "PENDING_SHIFT_CONTAINS_FUNDS",
        statusCode: 409,
      });
    }

    if (shift.assignedProfessional) {
      throw ShiftFundingService.createFundingError({
        message: "A pending-funding Shift cannot already have an assigned professional.",
        code: "PENDING_SHIFT_HAS_ASSIGNED_PROFESSIONAL",
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

    if (Number(shift.fundedAmount || 0) !== 0) {
      throw ShiftFundingService.createFundingError({
        message: "The Shift already contains protected funding without a completed funding state.",
        code: "INCONSISTENT_SHIFT_FUNDING_STATE",
        statusCode: 409,
      });
    }

    if (shift.assignedProfessional) {
      throw ShiftFundingService.createFundingError({
        message: "A pending-funding Shift cannot already have an assigned professional.",
        code: "PENDING_SHIFT_HAS_ASSIGNED_PROFESSIONAL",
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

    const availableBalance = Number(employerWallet.availableBalance || 0);

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

  /* ─────────────────────────────── PAYSTACK ATTEMPTS ─────────────────────────────── */

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

      const [employerWallet, escrowWallet] = await Promise.all([
        WalletService.createEmployerWalletIfMissing(profile, {
          session,
        }),

        WalletService.getEscrowWallet(
          {
            countryCode,
            currency,
          },
          {
            session,
          }
        ),
      ]);

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

      const checkoutInitializedAt = new Date();

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
            checkoutInitializationFailedAt: new Date(),

            checkoutInitializationErrorCode: error.code || null,
          },
        });

        await Shift.updateOne(
          {
            _id: preparation.shift._id,

            status: "pending_funding",
            paymentStatus: "unpaid",

            fundingMethod: "paystack_checkout",
            fundingTransaction: null,
          },
          {
            $set: {
              fundingMethod: null,
              fundingInitiatedAt: null,
            },
          }
        );
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
              "metadata.checkoutInitializationUncertainAt": new Date(),

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

    ShiftFundingService.resolveVerifiedPaymentTime(verifiedPayment);

    return true;
  }

  static getVerifiedProviderAmounts(verifiedPayment) {
    const amount = Number(verifiedPayment.amount);

    const providerFee = Number.isSafeInteger(Number(verifiedPayment.fees))
      ? Number(verifiedPayment.fees)
      : 0;

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

  /* ─────────────────────────────── FINALIZE PAYSTACK FUNDING ─────────────────────────────── */

  static async finalizePaystackShiftFunding({
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

          metadata: {
            verifiedAt: new Date(),
            verifiedPaystackStatus: verifiedStatus,
          },
        });

        await Shift.updateOne(
          {
            _id: internalTransaction.shift,

            status: "pending_funding",
            paymentStatus: "unpaid",

            fundingMethod: "paystack_checkout",
            fundingTransaction: null,
          },
          {
            $set: {
              fundingMethod: null,
              fundingInitiatedAt: null,
            },
          }
        );
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

      /*
       * Record successful Paystack money in escrow before fund/return/integrity handling.
       */
      const completedCredit = await WalletService.completePendingExternalCredit(
        {
          transactionId: transaction._id,
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
        },
        {
          session,
        }
      );

      const completedTransaction = completedCredit.transaction;

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
}

module.exports = ShiftFundingService;
