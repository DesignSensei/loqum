// services/shiftPlatformFeeService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const Transaction = require("../models/Transaction");

const WalletService = require("./walletService");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeFieldCode } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");
const logger = require("../utils/logger");

const SHIFT_PLATFORM_FEE_SERVICE_ERROR_NAME = "ShiftPlatformFeeServiceError";

const PLATFORM_FEE_COMPONENTS = Object.freeze(["base", "overtime"]);

/**
 * These values must remain aligned with constants/transaction.js and the
 * Transaction model when that compatibility pass is completed.
 *
 * A platform-fee Transaction represents actual collection into Loqum's
 * platform wallet. Earning itself is represented on ShiftOccurrence through
 * the component fee amount plus its platform-fee audit.
 */
const PLATFORM_FEE_PURPOSE_BY_COMPONENT = Object.freeze({
  base: "base_platform_fee_earned",
  overtime: "overtime_platform_fee_earned",
});

const PLATFORM_FEE_AUDIT_PATH_BY_COMPONENT = Object.freeze({
  base: "basePlatformFeeAudit",
  overtime: "overtimePlatformFeeAudit",
});

const PLATFORM_FEE_AMOUNT_PATH_BY_COMPONENT = Object.freeze({
  base: "basePlatformFee",
  overtime: "overtimePlatformFee",
});

/**
 * SHIFT PLATFORM FEE AUTHORITY
 *
 * ShiftPlatformFeeService owns only Loqum platform-fee truth at occurrence
 * level.
 *
 * It does NOT own:
 *
 * - professional BASE or OT entitlement;
 * - overtime employer approval/rejection;
 * - overtime appeals/admin adjudication;
 * - overtime top-up establishment, deadlines or delinquency;
 * - professional payout approval/execution;
 * - employer refund authority/execution; or
 * - parent Shift financial aggregation.
 *
 * BASE
 *
 * The BASE fee is earned once when the professional engagement for the
 * occurrence is confirmed by the surrounding assignment lifecycle.
 *
 * The original Shift allocation is already protected at that point, so a
 * positive BASE fee is collected immediately from escrow into the platform
 * wallet in the same transactional workflow.
 *
 * Once earned, BASE fee amount is immutable and remains earned through later
 * cancellation/no-show/settlement outcomes. There is no ordinary reversal
 * path here.
 *
 * OVERTIME
 *
 * Pending/rejected/disputed OT earns no fee.
 *
 * Final approved OT earns:
 *
 *   overtimeProfessionalPay × fixed-point snapshotted platformFeeRate
 *
 * The calculation is performed through utils/money.js using integer minor
 * units, a scaled rate, BigInt arithmetic and deterministic half-up rounding.
 *
 * The OT fee is marked outstanding while the separately owned overtime top-up
 * remains unfunded.
 *
 * Once the full OT top-up has been funded, collectOvertimePlatformFee() moves
 * only Loqum's already-earned fee from escrow into the platform wallet.
 *
 * This service does not create or calculate an employerCharge field. The
 * overtime funding requirement is owned by shiftOvertimeFundingService and is
 * derived from authoritative professional OT pay plus the fee produced here.
 *
 * IMPORTANT ORCHESTRATION DETAIL
 *
 * Final OT approval, OT fee earning and OT top-up establishment must be saved
 * atomically because ShiftOccurrence validates the complete final-approved OT
 * state as one coherent authority.
 *
 * For that reason earnOvertimePlatformFee() accepts an already-loaded
 * ShiftOccurrence document, mutates only its fee fields/audit, and deliberately
 * does not save it. shiftOvertimeService / shiftOvertimeFundingService will
 * stage their own authorities on that same document and perform the final save
 * inside the shared Mongo transaction.
 *
 * IDEMPOTENCY
 *
 * Each actual fee collection uses deterministic wallet-transfer keys:
 *
 *   shift-platform-fee:<occurrenceId>:base:escrow-debit
 *   shift-platform-fee:<occurrenceId>:base:platform-credit
 *
 *   shift-platform-fee:<occurrenceId>:overtime:escrow-debit
 *   shift-platform-fee:<occurrenceId>:overtime:platform-credit
 */

class ShiftPlatformFeeService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null, cause = null }) {
    const error = createServiceError({
      name: SHIFT_PLATFORM_FEE_SERVICE_ERROR_NAME,
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

  static async transaction(options = {}, callback) {
    return runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeObjectId(value, fieldName) {
    const fieldCode = normalizeFieldCode(fieldName);

    if (!value || !mongoose.isValidObjectId(value)) {
      throw ShiftPlatformFeeService.createError({
        message: `A valid ${fieldName} is required.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static normalizeDate(value, fieldName = "date") {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(date.getTime())) {
      throw ShiftPlatformFeeService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }

    return date;
  }

  static normalizeInitiatedBy(value) {
    const initiatedBy = value || {
      role: "system",
      userId: null,
    };

    const role = String(initiatedBy.role || "system")
      .trim()
      .toLowerCase();

    if (!["system", "employer", "professional", "admin"].includes(role)) {
      throw ShiftPlatformFeeService.createError({
        message: "Platform-fee initiator role is invalid.",
        code: "INVALID_PLATFORM_FEE_INITIATOR_ROLE",
      });
    }

    let userId = null;

    if (initiatedBy.userId) {
      userId = ShiftPlatformFeeService.normalizeObjectId(
        initiatedBy.userId,
        "platform-fee initiator user ID"
      );
    }

    if (role !== "system" && !userId) {
      throw ShiftPlatformFeeService.createError({
        message: "A user ID is required when a user initiates platform-fee processing.",
        code: "PLATFORM_FEE_INITIATOR_USER_ID_REQUIRED",
      });
    }

    if (role === "system") {
      userId = null;
    }

    return {
      role,
      userId,
    };
  }

  static normalizeComponent(value) {
    const component = String(value || "")
      .trim()
      .toLowerCase();

    if (!PLATFORM_FEE_COMPONENTS.includes(component)) {
      throw ShiftPlatformFeeService.createError({
        message: "Platform-fee component must be base or overtime.",
        code: "INVALID_PLATFORM_FEE_COMPONENT",
      });
    }

    return component;
  }

  static normalizePositiveAmount(value, fieldName) {
    try {
      return money.normalizePositiveMinorUnitAmount(value, fieldName);
    } catch (error) {
      throw ShiftPlatformFeeService.createError({
        message: `${fieldName} must be a positive whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
        cause: error,
      });
    }
  }

  static normalizeNonNegativeAmount(value, fieldName) {
    try {
      return money.normalizeMinorUnitAmount(value ?? 0, fieldName);
    } catch (error) {
      throw ShiftPlatformFeeService.createError({
        message: `${fieldName} must be a non-negative whole number in minor units.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
        statusCode: 500,
        cause: error,
      });
    }
  }

  static normalizePlatformFeeRate(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw ShiftPlatformFeeService.createError({
        message: "The occurrence platform fee rate is invalid.",
        code: "INVALID_OCCURRENCE_PLATFORM_FEE_RATE",
        statusCode: 500,
      });
    }

    try {
      money.scaleRate({
        rate: value,
        rateScale: FINANCIAL_RATE_SCALE,
        fieldName: "Occurrence platform fee rate",
      });
    } catch (error) {
      throw ShiftPlatformFeeService.createError({
        message: "The occurrence platform fee rate exceeds the supported financial precision.",
        code: "INVALID_OCCURRENCE_PLATFORM_FEE_RATE",
        statusCode: 500,
        cause: error,
      });
    }

    return value;
  }

  /* ─────────────────────────────── CONTEXT ─────────────────────────────── */

  static async loadOccurrenceContext({ occurrenceId, session }) {
    const normalizedOccurrenceId = ShiftPlatformFeeService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const occurrence = await ShiftOccurrence.findById(normalizedOccurrenceId).session(session);

    if (!occurrence) {
      throw ShiftPlatformFeeService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    const shift = await Shift.findById(occurrence.shift)
      .select(
        [
          "referenceCode",
          "business",
          "branch",
          "countryCode",
          "currency",
          "status",
          "paymentStatus",
          "fundingMethod",
          "fundedAmount",
          "fundedAt",
          "fundingTransaction",
          "estimatedEmployerCharge",
        ].join(" ")
      )
      .session(session);

    if (!shift) {
      throw ShiftPlatformFeeService.createError({
        message: "The parent Shift for this occurrence was not found.",
        code: "PARENT_SHIFT_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (String(occurrence.business) !== String(shift.business)) {
      throw ShiftPlatformFeeService.createError({
        message: "Occurrence business does not match its parent Shift.",
        code: "SHIFT_OCCURRENCE_BUSINESS_MISMATCH",
        statusCode: 500,
      });
    }

    if (String(occurrence.branch) !== String(shift.branch)) {
      throw ShiftPlatformFeeService.createError({
        message: "Occurrence branch does not match its parent Shift.",
        code: "SHIFT_OCCURRENCE_BRANCH_MISMATCH",
        statusCode: 500,
      });
    }

    return {
      shift,
      occurrence,
    };
  }

  static assertShiftWasFunded(shift) {
    const fundedAmount = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      shift?.fundedAmount,
      "funded amount"
    );

    const estimatedEmployerCharge = ShiftPlatformFeeService.normalizePositiveAmount(
      shift?.estimatedEmployerCharge,
      "estimated employer charge"
    );

    if (!shift?.fundedAt || !shift?.fundingMethod || !shift?.fundingTransaction) {
      throw ShiftPlatformFeeService.createError({
        message: "The Shift has not completed protected funding.",
        code: "SHIFT_NOT_FULLY_FUNDED",
        statusCode: 409,
      });
    }

    if (fundedAmount < estimatedEmployerCharge) {
      throw ShiftPlatformFeeService.createError({
        message:
          "The Shift does not contain enough protected initial funding to earn its BASE platform fee.",
        code: "SHIFT_INITIAL_FUNDING_INCOMPLETE",
        statusCode: 409,
        details: {
          fundedAmount,
          requiredAmount: estimatedEmployerCharge,
        },
      });
    }

    return true;
  }

  static async resolveFeeWallets({ shift, session }) {
    const countryCode = String(shift?.countryCode || "")
      .trim()
      .toUpperCase();

    const currency = String(shift?.currency || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currency)) {
      throw ShiftPlatformFeeService.createError({
        message: "The Shift country or currency is invalid for platform-fee collection.",
        code: "INVALID_PLATFORM_FEE_CURRENCY_CONTEXT",
        statusCode: 500,
      });
    }

    const [escrowWallet, platformWallet] = await Promise.all([
      WalletService.getEscrowWallet(
        {
          countryCode,
          currency,
        },
        {
          session,
        }
      ),

      WalletService.getPlatformWallet(
        {
          countryCode,
          currency,
        },
        {
          session,
        }
      ),
    ]);

    if (!escrowWallet) {
      throw ShiftPlatformFeeService.createError({
        message: "The escrow wallet required for platform-fee collection was not found.",
        code: "ESCROW_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    if (!platformWallet) {
      throw ShiftPlatformFeeService.createError({
        message: "The Loqum platform wallet required for fee collection was not found.",
        code: "PLATFORM_WALLET_NOT_FOUND",
        statusCode: 500,
      });
    }

    WalletService.assertWalletIsActive(escrowWallet);
    WalletService.assertWalletIsActive(platformWallet);
    WalletService.assertSameCountryAndCurrency(escrowWallet, platformWallet);

    if (escrowWallet.ownerType !== "escrow") {
      throw ShiftPlatformFeeService.createError({
        message: "The resolved source wallet is not an escrow wallet.",
        code: "INVALID_PLATFORM_FEE_SOURCE_WALLET",
        statusCode: 500,
      });
    }

    if (platformWallet.ownerType !== "platform") {
      throw ShiftPlatformFeeService.createError({
        message: "The resolved destination wallet is not the platform wallet.",
        code: "INVALID_PLATFORM_FEE_DESTINATION_WALLET",
        statusCode: 500,
      });
    }

    return {
      countryCode,
      currency,
      escrowWallet,
      platformWallet,
    };
  }

  /* ─────────────────────────────── COMPONENT HELPERS ─────────────────────────────── */

  static getAuditPath(component) {
    return PLATFORM_FEE_AUDIT_PATH_BY_COMPONENT[
      ShiftPlatformFeeService.normalizeComponent(component)
    ];
  }

  static getFeeAmountPath(component) {
    return PLATFORM_FEE_AMOUNT_PATH_BY_COMPONENT[
      ShiftPlatformFeeService.normalizeComponent(component)
    ];
  }

  static getPurpose(component) {
    return PLATFORM_FEE_PURPOSE_BY_COMPONENT[ShiftPlatformFeeService.normalizeComponent(component)];
  }

  static buildTransferIdempotencyKeys({ occurrenceId, component }) {
    const normalizedComponent = ShiftPlatformFeeService.normalizeComponent(component);

    const occurrenceKey = String(occurrenceId).toLowerCase();

    const prefix = `shift-platform-fee:${occurrenceKey}:${normalizedComponent}`;

    return {
      debitIdempotencyKey: `${prefix}:escrow-debit`,

      creditIdempotencyKey: `${prefix}:platform-credit`,
    };
  }

  static getFeeState({ occurrence, component }) {
    const normalizedComponent = ShiftPlatformFeeService.normalizeComponent(component);

    const auditPath = ShiftPlatformFeeService.getAuditPath(normalizedComponent);

    const feeAmountPath = ShiftPlatformFeeService.getFeeAmountPath(normalizedComponent);

    const audit = occurrence?.[auditPath] || {};

    const feeAmount = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      occurrence?.[feeAmountPath],
      `${normalizedComponent} platform fee`
    );

    if (feeAmount === 0 && !audit.earnedAt) {
      return {
        component: normalizedComponent,
        feeAmount: 0,
        state: "not_earned",
        earnedAt: null,
        outstandingAt: null,
        collectedAt: null,
        collectionTransaction: null,
      };
    }

    if (!audit.earnedAt) {
      throw ShiftPlatformFeeService.createError({
        message: `${normalizedComponent} platform fee amount exists without an earning audit.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_EARNING_AUDIT_MISSING`,
        statusCode: 500,
      });
    }

    if (audit.outstandingAt) {
      return {
        component: normalizedComponent,
        feeAmount,
        state: "earned_outstanding",
        earnedAt: audit.earnedAt,
        outstandingAt: audit.outstandingAt,
        collectedAt: audit.collectedAt || null,
        collectionTransaction: audit.collectionTransaction || null,
      };
    }

    if (!audit.collectedAt) {
      return {
        component: normalizedComponent,
        feeAmount,
        state: "earned_pending_collection",
        earnedAt: audit.earnedAt,
        outstandingAt: null,
        collectedAt: null,
        collectionTransaction: null,
      };
    }

    return {
      component: normalizedComponent,
      feeAmount,
      state: "collected",
      earnedAt: audit.earnedAt,
      outstandingAt: null,
      collectedAt: audit.collectedAt,
      collectionTransaction: audit.collectionTransaction || null,
    };
  }

  /* ─────────────────────────────── PRICING AUTHORITY ─────────────────────────────── */

  static calculateOvertimePlatformFee({ professionalPay, platformFeeRate }) {
    const normalizedProfessionalPay = ShiftPlatformFeeService.normalizePositiveAmount(
      professionalPay,
      "overtime professional pay"
    );

    const normalizedPlatformFeeRate =
      ShiftPlatformFeeService.normalizePlatformFeeRate(platformFeeRate);

    try {
      return money.calculateMinorAmountFromRate({
        amountMinor: normalizedProfessionalPay,

        rate: normalizedPlatformFeeRate,

        rateScale: FINANCIAL_RATE_SCALE,

        fieldName: "Overtime platform fee",

        rateFieldName: "Occurrence platform fee rate",
      });
    } catch (error) {
      throw ShiftPlatformFeeService.createError({
        message: "The calculated overtime platform fee is invalid or too large.",
        code: "INVALID_OVERTIME_PLATFORM_FEE",
        statusCode: 500,
        cause: error,
      });
    }
  }

  static assertBaseFeeAmountIsAuthoritative(occurrence) {
    const expectedFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      occurrence?.estimatedPlatformFee,
      "estimated platform fee"
    );

    const storedFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      occurrence?.basePlatformFee,
      "base platform fee"
    );

    if (storedFee !== expectedFee) {
      throw ShiftPlatformFeeService.createError({
        message: "The earned BASE platform fee no longer matches the occurrence pricing snapshot.",
        code: "BASE_PLATFORM_FEE_AMOUNT_MISMATCH",
        statusCode: 409,
        details: {
          storedFee,
          expectedFee,
        },
      });
    }

    return expectedFee;
  }

  static assertOvertimeFeeAmountIsAuthoritative(occurrence) {
    const overtimeProfessionalPay = ShiftPlatformFeeService.normalizePositiveAmount(
      occurrence?.overtimeProfessionalPay,
      "final overtime professional pay"
    );

    const expectedFee = ShiftPlatformFeeService.calculateOvertimePlatformFee({
      professionalPay: overtimeProfessionalPay,

      platformFeeRate: occurrence?.platformFeeRate,
    });

    const storedFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      occurrence?.overtimePlatformFee,
      "overtime platform fee"
    );

    if (storedFee !== expectedFee) {
      throw ShiftPlatformFeeService.createError({
        message:
          "The earned overtime platform fee no longer matches final overtime professional pay and the snapshotted platform fee rate.",
        code: "OVERTIME_PLATFORM_FEE_AMOUNT_MISMATCH",
        statusCode: 409,
        details: {
          storedFee,
          expectedFee,
        },
      });
    }

    return {
      overtimeProfessionalPay,
      expectedFee,
    };
  }

  /* ─────────────────────────────── COLLECTION VALIDATION ─────────────────────────────── */

  static async assertStoredCollectionTransaction({
    occurrence,
    shift,
    component,
    platformWallet,
    session,
    expectedAmount,
  }) {
    const normalizedComponent = ShiftPlatformFeeService.normalizeComponent(component);

    const auditPath = ShiftPlatformFeeService.getAuditPath(normalizedComponent);

    const audit = occurrence[auditPath] || {};

    if (!audit.collectionTransaction) {
      throw ShiftPlatformFeeService.createError({
        message: `The stored ${normalizedComponent} platform-fee collection audit has no Transaction reference.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_TRANSACTION_MISSING`,
        statusCode: 500,
      });
    }

    const transaction = await Transaction.findById(audit.collectionTransaction).session(session);

    if (!transaction) {
      throw ShiftPlatformFeeService.createError({
        message: `The stored ${normalizedComponent} platform-fee Transaction was not found.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_TRANSACTION_NOT_FOUND`,
        statusCode: 500,
      });
    }

    const normalizedExpectedAmount = ShiftPlatformFeeService.normalizePositiveAmount(
      expectedAmount,
      `${normalizedComponent} expected platform fee`
    );

    const transactionAmount = ShiftPlatformFeeService.normalizePositiveAmount(
      transaction.amount,
      `${normalizedComponent} stored platform-fee transaction amount`
    );

    const matches =
      transaction.type === "platform_fee" &&
      transaction.purpose === ShiftPlatformFeeService.getPurpose(normalizedComponent) &&
      transaction.direction === "credit" &&
      transaction.status === "completed" &&
      transaction.paymentRail === "internal_transfer" &&
      transaction.provider === "internal" &&
      transactionAmount === normalizedExpectedAmount &&
      String(transaction.wallet) === String(platformWallet._id) &&
      String(transaction.shift || "") === String(shift._id) &&
      String(transaction.shiftOccurrence || "") === String(occurrence._id);

    if (!matches) {
      throw ShiftPlatformFeeService.createError({
        message: `The stored ${normalizedComponent} platform-fee Transaction does not match the occurrence fee audit.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_TRANSACTION_MISMATCH`,
        statusCode: 409,
      });
    }

    return transaction;
  }

  static assertOvertimeTopUpIsFunded(occurrence) {
    const overtime = occurrence?.overtime || {};

    if (
      overtime.requested !== true ||
      overtime.status !== "approved" ||
      overtime.topUpPaid !== true ||
      !overtime.topUpPaidAt ||
      !occurrence?.topUpTransaction
    ) {
      throw ShiftPlatformFeeService.createError({
        message:
          "Overtime platform fee cannot be collected until the full approved overtime top-up has been funded.",
        code: "OVERTIME_TOPUP_NOT_FUNDED",
        statusCode: 409,
      });
    }

    const topUpRequired = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      occurrence.topUpRequired,
      "outstanding overtime top-up"
    );

    if (topUpRequired !== 0) {
      throw ShiftPlatformFeeService.createError({
        message: "Funded overtime cannot retain an outstanding top-up requirement.",
        code: "FUNDED_OVERTIME_TOPUP_REQUIREMENT_REMAINS",
        statusCode: 500,
      });
    }

    const professionalPay = ShiftPlatformFeeService.normalizePositiveAmount(
      occurrence.overtimeProfessionalPay,
      "overtime professional pay"
    );

    const platformFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
      occurrence.overtimePlatformFee,
      "overtime platform fee"
    );

    let expectedTopUpAmount;

    try {
      expectedTopUpAmount = money.sumMinorUnitAmounts(
        [professionalPay, platformFee],
        "Final overtime funding requirement"
      );
    } catch (error) {
      throw ShiftPlatformFeeService.createError({
        message: "The final overtime funding requirement is invalid or too large.",
        code: "INVALID_OVERTIME_FUNDING_REQUIREMENT",
        statusCode: 500,
        cause: error,
      });
    }

    if (expectedTopUpAmount <= 0) {
      throw ShiftPlatformFeeService.createError({
        message: "The final overtime funding requirement must be greater than zero.",
        code: "INVALID_OVERTIME_FUNDING_REQUIREMENT",
        statusCode: 500,
      });
    }

    const fundedTopUpAmount = ShiftPlatformFeeService.normalizePositiveAmount(
      overtime.topUpAmount,
      "funded overtime top-up amount"
    );

    if (fundedTopUpAmount !== expectedTopUpAmount) {
      throw ShiftPlatformFeeService.createError({
        message:
          "The funded overtime top-up does not match authoritative overtime professional pay plus the earned overtime platform fee.",
        code: "FUNDED_OVERTIME_TOPUP_AMOUNT_MISMATCH",
        statusCode: 409,
        details: {
          fundedTopUpAmount,
          expectedTopUpAmount,
        },
      });
    }

    return {
      professionalPay,
      platformFee,
      topUpAmount: fundedTopUpAmount,
      topUpPaidAt: ShiftPlatformFeeService.normalizeDate(
        overtime.topUpPaidAt,
        "overtime top-up paid time"
      ),
    };
  }

  /* ─────────────────────────────── COLLECTION CORE ─────────────────────────────── */

  static async collectEarnedFee({
    shift,
    occurrence,
    component,
    collectedAt,
    initiatedBy,
    session,
  }) {
    const normalizedComponent = ShiftPlatformFeeService.normalizeComponent(component);

    const auditPath = ShiftPlatformFeeService.getAuditPath(normalizedComponent);

    const feeAmountPath = ShiftPlatformFeeService.getFeeAmountPath(normalizedComponent);

    const audit = occurrence[auditPath] || {};

    if (!audit.earnedAt) {
      throw ShiftPlatformFeeService.createError({
        message: `${normalizedComponent} platform fee cannot be collected before it is earned.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_NOT_EARNED`,
        statusCode: 409,
      });
    }

    const feeAmount = ShiftPlatformFeeService.normalizePositiveAmount(
      occurrence[feeAmountPath],
      `${normalizedComponent} platform fee`
    );

    const normalizedCollectedAt = ShiftPlatformFeeService.normalizeDate(
      collectedAt,
      `${normalizedComponent} platform fee collection time`
    );

    if (normalizedCollectedAt < new Date(audit.earnedAt)) {
      throw ShiftPlatformFeeService.createError({
        message: `${normalizedComponent} platform-fee collection cannot predate fee earning.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_COLLECTION_TOO_EARLY`,
        statusCode: 409,
      });
    }

    const wallets = await ShiftPlatformFeeService.resolveFeeWallets({
      shift,
      session,
    });

    if (audit.collectedAt || audit.collectionTransaction) {
      if (!audit.collectedAt || !audit.collectionTransaction) {
        throw ShiftPlatformFeeService.createError({
          message: `${normalizedComponent} platform-fee collection audit is incomplete.`,
          code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_COLLECTION_AUDIT_INCOMPLETE`,
          statusCode: 500,
        });
      }

      const transaction = await ShiftPlatformFeeService.assertStoredCollectionTransaction({
        occurrence,
        shift,
        component: normalizedComponent,
        platformWallet: wallets.platformWallet,
        session,
        expectedAmount: feeAmount,
      });

      return {
        occurrence,
        shift,
        component: normalizedComponent,
        feeAmount,
        earned: true,
        collected: true,
        outstanding: false,
        idempotent: true,
        transaction,
      };
    }

    const transfer = await WalletService.transferBetweenWallets(
      {
        fromWalletId: wallets.escrowWallet._id,

        toWalletId: wallets.platformWallet._id,

        amount: feeAmount,

        type: "platform_fee",

        purpose: ShiftPlatformFeeService.getPurpose(normalizedComponent),

        paymentRail: "internal_transfer",

        ...ShiftPlatformFeeService.buildTransferIdempotencyKeys({
          occurrenceId: occurrence._id,

          component: normalizedComponent,
        }),

        shift: shift._id,

        shiftOccurrence: occurrence._id,

        initiatedBy,

        description:
          normalizedComponent === "base"
            ? `Earned BASE platform fee for occurrence ${occurrence.referenceCode}.`
            : `Earned overtime platform fee for occurrence ${occurrence.referenceCode}.`,

        metadata: {
          platformFeeComponent: normalizedComponent,

          shiftId: String(shift._id),

          shiftReferenceCode: shift.referenceCode,

          occurrenceId: String(occurrence._id),

          occurrenceReferenceCode: occurrence.referenceCode,

          businessId: String(occurrence.business),

          branchId: String(occurrence.branch),

          professionalId: occurrence.assignedProfessional
            ? String(occurrence.assignedProfessional)
            : null,

          assignmentId: occurrence.assignment ? String(occurrence.assignment) : null,

          feeAmount,

          platformFeeRate: Number(occurrence.platformFeeRate || 0),

          earnedAt: audit.earnedAt,
        },
      },
      {
        session,
      }
    );

    const creditTransaction = transfer?.credit?.transaction;

    if (!creditTransaction) {
      throw ShiftPlatformFeeService.createError({
        message: `${normalizedComponent} platform-fee transfer did not return a platform-wallet credit Transaction.`,
        code: `${normalizedComponent.toUpperCase()}_PLATFORM_FEE_CREDIT_TRANSACTION_MISSING`,
        statusCode: 500,
      });
    }

    occurrence.set(
      `${auditPath}.collectedAt`,
      creditTransaction.completedAt || normalizedCollectedAt
    );

    occurrence.set(`${auditPath}.collectionTransaction`, creditTransaction._id);

    occurrence.set(`${auditPath}.outstandingAt`, null);

    await occurrence.save({
      session,
    });

    logger.info(
      `Collected ${normalizedComponent} platform fee ${feeAmount} for occurrence ${occurrence.referenceCode}.`
    );

    return {
      occurrence,
      shift,
      component: normalizedComponent,
      feeAmount,
      earned: true,
      collected: true,
      outstanding: false,
      idempotent: transfer.idempotent === true,
      transfer,
      transaction: creditTransaction,
    };
  }

  /* ─────────────────────────────── BASE PLATFORM FEE ─────────────────────────────── */

  static assertBaseFeeCanBeEarned(occurrence) {
    if (
      occurrence.assignmentStatus !== "assigned" ||
      !occurrence.assignedProfessional ||
      !occurrence.assignment ||
      !occurrence.assignedAt
    ) {
      throw ShiftPlatformFeeService.createError({
        message:
          "BASE platform fee may only be earned after a professional engagement is established for the occurrence.",
        code: "BASE_PLATFORM_FEE_ASSIGNMENT_REQUIRED",
        statusCode: 409,
      });
    }

    return true;
  }

  /**
   * Earn the immutable BASE fee and immediately collect it from protected
   * initial Shift funding.
   *
   * A zero-fee pricing snapshot needs no platform-fee audit or wallet movement.
   */
  static async earnBasePlatformFee(
    {
      occurrenceId,

      earnedAt = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },
    options = {}
  ) {
    const normalizedEarnedAt = ShiftPlatformFeeService.normalizeDate(
      earnedAt,
      "BASE platform fee earned time"
    );

    const normalizedInitiatedBy = ShiftPlatformFeeService.normalizeInitiatedBy(initiatedBy);

    return ShiftPlatformFeeService.transaction(options, async (session) => {
      const { shift, occurrence } = await ShiftPlatformFeeService.loadOccurrenceContext({
        occurrenceId,
        session,
      });

      ShiftPlatformFeeService.assertShiftWasFunded(shift);

      ShiftPlatformFeeService.assertBaseFeeCanBeEarned(occurrence);

      const expectedFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
        occurrence.estimatedPlatformFee,
        "estimated platform fee"
      );

      const audit = occurrence.basePlatformFeeAudit || {};

      if (expectedFee === 0) {
        if (
          ShiftPlatformFeeService.normalizeNonNegativeAmount(
            occurrence.basePlatformFee,
            "base platform fee"
          ) !== 0 ||
          audit.earnedAt ||
          audit.outstandingAt ||
          audit.collectedAt ||
          audit.collectionTransaction
        ) {
          throw ShiftPlatformFeeService.createError({
            message:
              "A zero BASE platform-fee snapshot cannot contain an earned or collected fee audit.",
            code: "ZERO_BASE_PLATFORM_FEE_AUDIT_INVALID",
            statusCode: 500,
          });
        }

        return {
          occurrence,
          shift,
          component: "base",
          feeAmount: 0,
          earned: false,
          collected: false,
          outstanding: false,
          idempotent: true,
          transaction: null,
        };
      }

      if (audit.earnedAt) {
        ShiftPlatformFeeService.assertBaseFeeAmountIsAuthoritative(occurrence);

        if (audit.outstandingAt) {
          throw ShiftPlatformFeeService.createError({
            message:
              "BASE platform fee cannot be marked employer-outstanding because initial Shift funding is already protected.",
            code: "BASE_PLATFORM_FEE_CANNOT_BE_OUTSTANDING",
            statusCode: 500,
          });
        }

        return ShiftPlatformFeeService.collectEarnedFee({
          shift,
          occurrence,
          component: "base",
          collectedAt: normalizedEarnedAt,
          initiatedBy: normalizedInitiatedBy,
          session,
        });
      }

      if (audit.collectedAt || audit.collectionTransaction || audit.outstandingAt) {
        throw ShiftPlatformFeeService.createError({
          message:
            "BASE platform-fee collection/outstanding audit exists before the fee earning audit.",
          code: "BASE_PLATFORM_FEE_AUDIT_ORDER_INVALID",
          statusCode: 500,
        });
      }

      occurrence.basePlatformFee = expectedFee;

      occurrence.set("basePlatformFeeAudit.earnedAt", normalizedEarnedAt);

      occurrence.set("basePlatformFeeAudit.outstandingAt", null);

      occurrence.set("basePlatformFeeAudit.collectedAt", null);

      occurrence.set("basePlatformFeeAudit.collectionTransaction", null);

      await occurrence.save({
        session,
      });

      return ShiftPlatformFeeService.collectEarnedFee({
        shift,
        occurrence,
        component: "base",
        collectedAt: normalizedEarnedAt,
        initiatedBy: normalizedInitiatedBy,
        session,
      });
    });
  }

  /**
   * Retry/verify collection of an already-earned positive BASE fee.
   *
   * Normal earning calls collect immediately. This explicit method exists so a
   * transactional retry or operational recovery does not need to re-run fee
   * earning logic.
   */
  static async collectBasePlatformFee(
    {
      occurrenceId,

      collectedAt = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },
    options = {}
  ) {
    const normalizedCollectedAt = ShiftPlatformFeeService.normalizeDate(
      collectedAt,
      "BASE platform fee collection time"
    );

    const normalizedInitiatedBy = ShiftPlatformFeeService.normalizeInitiatedBy(initiatedBy);

    return ShiftPlatformFeeService.transaction(options, async (session) => {
      const { shift, occurrence } = await ShiftPlatformFeeService.loadOccurrenceContext({
        occurrenceId,
        session,
      });

      ShiftPlatformFeeService.assertShiftWasFunded(shift);

      const audit = occurrence.basePlatformFeeAudit || {};

      const feeAmount = ShiftPlatformFeeService.normalizeNonNegativeAmount(
        occurrence.basePlatformFee,
        "base platform fee"
      );

      if (feeAmount === 0) {
        if (
          audit.earnedAt ||
          audit.outstandingAt ||
          audit.collectedAt ||
          audit.collectionTransaction
        ) {
          throw ShiftPlatformFeeService.createError({
            message: "Zero BASE platform fee cannot contain platform-fee audit data.",
            code: "ZERO_BASE_PLATFORM_FEE_AUDIT_INVALID",
            statusCode: 500,
          });
        }

        return {
          occurrence,
          shift,
          component: "base",
          feeAmount: 0,
          earned: false,
          collected: false,
          outstanding: false,
          idempotent: true,
          transaction: null,
        };
      }

      ShiftPlatformFeeService.assertBaseFeeAmountIsAuthoritative(occurrence);

      if (!audit.earnedAt) {
        throw ShiftPlatformFeeService.createError({
          message: "BASE platform fee has not been earned yet.",
          code: "BASE_PLATFORM_FEE_NOT_EARNED",
          statusCode: 409,
        });
      }

      if (audit.outstandingAt) {
        throw ShiftPlatformFeeService.createError({
          message:
            "BASE platform fee cannot be employer-outstanding because the initial Shift was prefunded.",
          code: "BASE_PLATFORM_FEE_CANNOT_BE_OUTSTANDING",
          statusCode: 500,
        });
      }

      return ShiftPlatformFeeService.collectEarnedFee({
        shift,
        occurrence,
        component: "base",
        collectedAt: normalizedCollectedAt,
        initiatedBy: normalizedInitiatedBy,
        session,
      });
    });
  }

  /* ─────────────────────────────── OVERTIME PLATFORM FEE ─────────────────────────────── */

  static assertFinalOvertimeEntitlement(occurrence) {
    const overtime = occurrence?.overtime || {};

    if (
      overtime.requested !== true ||
      overtime.status !== "approved" ||
      !overtime.approvedAt ||
      !overtime.approvedBy ||
      !overtime.decisionSource
    ) {
      throw ShiftPlatformFeeService.createError({
        message:
          "Overtime platform fee may only be earned after final overtime approval is established.",
        code: "OVERTIME_ENTITLEMENT_NOT_FINAL",
        statusCode: 409,
      });
    }

    const approvedAt = ShiftPlatformFeeService.normalizeDate(
      overtime.approvedAt,
      "overtime approval time"
    );

    return {
      overtime,
      approvedAt,
    };
  }

  /**
   * Stage OT fee earning on an already-loaded ShiftOccurrence document.
   *
   * This method deliberately does not save the occurrence. The caller must
   * stage the OT top-up authority through shiftOvertimeFundingService and save
   * the complete approved-OT state once inside the surrounding transaction.
   */
  static earnOvertimePlatformFee({ occurrence, earnedAt = null }) {
    if (!occurrence || typeof occurrence.set !== "function") {
      throw ShiftPlatformFeeService.createError({
        message: "earnOvertimePlatformFee requires a loaded ShiftOccurrence document.",
        code: "SHIFT_OCCURRENCE_DOCUMENT_REQUIRED",
        statusCode: 500,
      });
    }

    const { approvedAt } = ShiftPlatformFeeService.assertFinalOvertimeEntitlement(occurrence);

    const authoritativeEarnedAt = earnedAt
      ? ShiftPlatformFeeService.normalizeDate(earnedAt, "overtime platform fee earned time")
      : approvedAt;

    if (authoritativeEarnedAt.getTime() !== approvedAt.getTime()) {
      throw ShiftPlatformFeeService.createError({
        message: "Overtime platform-fee earned time must match final overtime approval time.",
        code: "OVERTIME_PLATFORM_FEE_EARNED_TIME_MISMATCH",
        statusCode: 409,
      });
    }

    const overtimeProfessionalPay = ShiftPlatformFeeService.normalizePositiveAmount(
      occurrence.overtimeProfessionalPay,
      "final overtime professional pay"
    );

    const feeAmount = ShiftPlatformFeeService.calculateOvertimePlatformFee({
      professionalPay: overtimeProfessionalPay,

      platformFeeRate: occurrence.platformFeeRate,
    });

    const audit = occurrence.overtimePlatformFeeAudit || {};

    if (feeAmount === 0) {
      const storedFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
        occurrence.overtimePlatformFee,
        "overtime platform fee"
      );

      if (
        storedFee !== 0 ||
        audit.earnedAt ||
        audit.outstandingAt ||
        audit.collectedAt ||
        audit.collectionTransaction
      ) {
        throw ShiftPlatformFeeService.createError({
          message:
            "A zero overtime platform fee cannot contain an earned or collected platform-fee audit.",
          code: "ZERO_OVERTIME_PLATFORM_FEE_AUDIT_INVALID",
          statusCode: 500,
        });
      }

      occurrence.overtimePlatformFee = 0;

      return {
        occurrence,
        component: "overtime",
        feeAmount: 0,
        earned: false,
        collected: false,
        outstanding: false,
        idempotent: true,
      };
    }

    if (audit.earnedAt) {
      const storedEarnedAt = ShiftPlatformFeeService.normalizeDate(
        audit.earnedAt,
        "stored overtime platform fee earned time"
      );

      if (storedEarnedAt.getTime() !== authoritativeEarnedAt.getTime()) {
        throw ShiftPlatformFeeService.createError({
          message:
            "The overtime platform-fee earning audit no longer matches final overtime approval.",
          code: "OVERTIME_PLATFORM_FEE_EARNING_AUDIT_CHANGED",
          statusCode: 409,
        });
      }

      const storedFee = ShiftPlatformFeeService.normalizeNonNegativeAmount(
        occurrence.overtimePlatformFee,
        "stored overtime platform fee"
      );

      if (storedFee !== feeAmount) {
        throw ShiftPlatformFeeService.createError({
          message:
            "An already-earned overtime platform fee cannot be repriced through the ordinary lifecycle.",
          code: "EARNED_OVERTIME_PLATFORM_FEE_IMMUTABLE",
          statusCode: 409,
          details: {
            storedFee,
            expectedFee: feeAmount,
          },
        });
      }

      return {
        occurrence,
        component: "overtime",
        feeAmount,
        earned: true,
        collected: Boolean(audit.collectedAt),
        outstanding: Boolean(audit.outstandingAt),
        idempotent: true,
      };
    }

    if (audit.outstandingAt || audit.collectedAt || audit.collectionTransaction) {
      throw ShiftPlatformFeeService.createError({
        message: "Overtime platform-fee collection/outstanding audit exists before fee earning.",
        code: "OVERTIME_PLATFORM_FEE_AUDIT_ORDER_INVALID",
        statusCode: 500,
      });
    }

    occurrence.overtimePlatformFee = feeAmount;

    occurrence.set("overtimePlatformFeeAudit.earnedAt", authoritativeEarnedAt);

    occurrence.set("overtimePlatformFeeAudit.collectedAt", null);

    occurrence.set("overtimePlatformFeeAudit.collectionTransaction", null);

    /**
     * If the top-up is already marked funded in-memory, collection can follow
     * without an outstanding period. Otherwise the earned OT fee is owed by
     * the employer until the separate funding authority records full payment.
     */
    occurrence.set(
      "overtimePlatformFeeAudit.outstandingAt",
      occurrence.overtime?.topUpPaid === true ? null : authoritativeEarnedAt
    );

    return {
      occurrence,
      component: "overtime",
      feeAmount,
      earned: true,
      collected: false,
      outstanding: occurrence.overtime?.topUpPaid !== true,
      idempotent: false,
    };
  }

  /**
   * Collect the already-earned OT fee after the full OT top-up has been funded.
   *
   * Professional OT pay remains protected in escrow for professional payout.
   * Only Loqum's fee is transferred here.
   */
  static async collectOvertimePlatformFee(
    {
      occurrenceId,

      collectedAt = new Date(),

      initiatedBy = {
        role: "system",
        userId: null,
      },
    },
    options = {}
  ) {
    const normalizedCollectedAt = ShiftPlatformFeeService.normalizeDate(
      collectedAt,
      "overtime platform fee collection time"
    );

    const normalizedInitiatedBy = ShiftPlatformFeeService.normalizeInitiatedBy(initiatedBy);

    return ShiftPlatformFeeService.transaction(options, async (session) => {
      const { shift, occurrence } = await ShiftPlatformFeeService.loadOccurrenceContext({
        occurrenceId,
        session,
      });

      const { approvedAt } = ShiftPlatformFeeService.assertFinalOvertimeEntitlement(occurrence);

      const audit = occurrence.overtimePlatformFeeAudit || {};

      const { expectedFee } =
        ShiftPlatformFeeService.assertOvertimeFeeAmountIsAuthoritative(occurrence);

      if (expectedFee === 0) {
        if (
          audit.earnedAt ||
          audit.outstandingAt ||
          audit.collectedAt ||
          audit.collectionTransaction
        ) {
          throw ShiftPlatformFeeService.createError({
            message: "Zero overtime platform fee cannot contain platform-fee audit data.",
            code: "ZERO_OVERTIME_PLATFORM_FEE_AUDIT_INVALID",
            statusCode: 500,
          });
        }

        return {
          occurrence,
          shift,
          component: "overtime",
          feeAmount: 0,
          earned: false,
          collected: false,
          outstanding: false,
          idempotent: true,
          transaction: null,
        };
      }

      if (!audit.earnedAt) {
        throw ShiftPlatformFeeService.createError({
          message: "Overtime platform fee has not been earned yet.",
          code: "OVERTIME_PLATFORM_FEE_NOT_EARNED",
          statusCode: 409,
        });
      }

      if (new Date(audit.earnedAt).getTime() !== approvedAt.getTime()) {
        throw ShiftPlatformFeeService.createError({
          message: "Overtime platform-fee earnedAt no longer matches final overtime approval time.",
          code: "OVERTIME_PLATFORM_FEE_EARNED_TIME_MISMATCH",
          statusCode: 409,
        });
      }

      const funded = ShiftPlatformFeeService.assertOvertimeTopUpIsFunded(occurrence);

      if (normalizedCollectedAt < funded.topUpPaidAt) {
        throw ShiftPlatformFeeService.createError({
          message: "Overtime platform-fee collection cannot predate the completed top-up.",
          code: "OVERTIME_PLATFORM_FEE_COLLECTION_TOO_EARLY",
          statusCode: 409,
        });
      }

      return ShiftPlatformFeeService.collectEarnedFee({
        shift,
        occurrence,
        component: "overtime",
        collectedAt: normalizedCollectedAt,
        initiatedBy: normalizedInitiatedBy,
        session,
      });
    });
  }

  /* ─────────────────────────────── READ / STATE ─────────────────────────────── */

  static async getOccurrencePlatformFeeState({ occurrenceId }, options = {}) {
    const normalizedOccurrenceId = ShiftPlatformFeeService.normalizeObjectId(
      occurrenceId,
      "occurrence ID"
    );

    const query = ShiftOccurrence.findById(normalizedOccurrenceId).select(
      [
        "referenceCode",
        "shift",
        "business",
        "branch",
        "assignedProfessional",
        "assignment",
        "platformFeeRate",
        "estimatedPlatformFee",
        "basePlatformFee",
        "basePlatformFeeAudit",
        "overtimeProfessionalPay",
        "overtimePlatformFee",
        "overtimePlatformFeeAudit",
        "topUpRequired",
        "topUpTransaction",
        "overtime",
      ].join(" ")
    );

    if (options.session) {
      query.session(options.session);
    }

    const occurrence = await query;

    if (!occurrence) {
      throw ShiftPlatformFeeService.createError({
        message: "Shift occurrence was not found.",
        code: "SHIFT_OCCURRENCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return {
      occurrenceId: String(occurrence._id),

      referenceCode: occurrence.referenceCode,

      base: ShiftPlatformFeeService.getFeeState({
        occurrence,
        component: "base",
      }),

      overtime: {
        ...ShiftPlatformFeeService.getFeeState({
          occurrence,
          component: "overtime",
        }),

        entitlementEstablished: Boolean(
          occurrence.overtime?.requested === true &&
          occurrence.overtime?.status === "approved" &&
          occurrence.overtime?.approvedAt &&
          occurrence.overtime?.approvedBy &&
          occurrence.overtime?.decisionSource
        ),

        professionalPay: Number(occurrence.overtimeProfessionalPay || 0),

        topUpRequired: Number(occurrence.topUpRequired || 0),

        topUpAmount: Number(occurrence.overtime?.topUpAmount || 0),

        topUpPaid: occurrence.overtime?.topUpPaid === true,

        topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,
      },
    };
  }
}

module.exports = ShiftPlatformFeeService;
