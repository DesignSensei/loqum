// services/walletService.js

const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const PlatformSettings = require("../models/PlatformSettings");

const {
  INTERNAL_PAYMENT_RAILS,
  PLATFORM_FEE_PURPOSES,
  SETTLEMENT_BATCH_PURPOSES,
} = require("../constants/transaction");

const {
  runWithOptionalTransaction: runServiceTransaction,
} = require("./helpers/transactionHelper");

const money = require("../utils/money");

const {
  generateReference,
  generateWalletFundingReference,
  generateShiftFundingReference,
  generateWithdrawalReference,
  generateWithdrawalReversalReference,
  generateRefundReference,
  generatePlatformFeeReference,
  generateSettlementReference,
  generateGroupReference,
} = require("../utils/reference");

class WalletService {
  /* ---------- Run with existing session or create new transaction ---------- */

  static async runWithOptionalTransaction(options = {}, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("A transaction callback is required.");
    }

    if (options.session) {
      WalletService.assertActiveTransaction(options.session);
    }

    return runServiceTransaction(options, async (session) => {
      WalletService.assertActiveTransaction(session);
      return callback(session);
    });
  }

  /* ---------- Validate financial inputs before money-helper arithmetic ---------- */

  static assertActiveTransaction(session) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error("Wallet ledger writes require an active transaction.");
    }
  }

  static normalizeSignedMinorUnitAmount(value, label) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(`${label} must be a safe integer in minor units.`);
    }

    return money.normalizeSignedMinorUnitAmount(value, label);
  }

  static normalizeMinorUnitAmount(value, label) {
    WalletService.normalizeSignedMinorUnitAmount(value, label);
    return money.normalizeMinorUnitAmount(value, label);
  }

  static normalizePositiveMinorUnitAmount(value, label) {
    WalletService.normalizeSignedMinorUnitAmount(value, label);
    return money.normalizePositiveMinorUnitAmount(value, label);
  }

  static assertIdempotencyKey(value) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
      throw new Error("Idempotency key must be a non-empty string without outer whitespace.");
    }
  }

  static assertTransactionWallet(transaction, wallet) {
    if (
      !wallet ||
      String(transaction.wallet) !== String(wallet._id) ||
      !wallet.countryCode ||
      !wallet.currency ||
      transaction.countryCode !== wallet.countryCode ||
      transaction.currency !== wallet.currency
    ) {
      throw new Error("Transaction wallet, country or currency does not match.");
    }
  }

  static assertExternalCredit(transaction) {
    if (
      transaction.direction !== "credit" ||
      transaction.provider !== "paystack" ||
      !["paystack_checkout", "paystack_dva"].includes(transaction.paymentRail) ||
      typeof transaction.paystackReference !== "string" ||
      !transaction.paystackReference.trim()
    ) {
      throw new Error("Transaction is not a Paystack external credit instruction.");
    }

    WalletService.normalizePositiveMinorUnitAmount(transaction.amount, "External credit amount");
  }

  static assertExternalDebit(transaction) {
    if (
      transaction.direction !== "debit" ||
      transaction.provider !== "paystack" ||
      transaction.paymentRail !== "paystack_transfer"
    ) {
      throw new Error("Transaction is not a Paystack external debit instruction.");
    }

    WalletService.normalizePositiveMinorUnitAmount(transaction.amount, "External debit amount");
  }

  static assertTransferCode(transaction, transferCode, required = false) {
    if (required || transferCode != null) {
      if (typeof transferCode !== "string" || !transferCode.trim()) {
        throw new Error("Paystack Transfer code is required.");
      }

      if (
        transaction.paystackTransferCode &&
        transaction.paystackTransferCode !== transferCode.trim()
      ) {
        throw new Error("Paystack Transfer code does not match the existing instruction.");
      }
    }
  }

  /* A retry must describe the same financial instruction, not just reuse its key. */
  static assertExistingInstruction(transaction, payload, direction, provider) {
    const expected = {
      wallet: payload.walletId,
      direction,
      type: payload.type,
      purpose: payload.purpose ?? null,
      paymentRail: payload.paymentRail ?? null,
      provider,
    };

    const references = [
      "shift",
      "shiftOccurrence",
      "assignmentCase",
      "shiftApplication",
      "settlementBatch",
      "employerRefundBatch",
      "employerRefundBatchLineId",
      "dispute",
      "bankAccount",
      "dva",
      "counterpartyWallet",
      "relatedTransaction",
      "paystackReference",
      "paystackTransferReference",
    ];

    for (const field of references) {
      expected[field] = payload[field] ?? null;
    }

    for (const [field, value] of Object.entries(expected)) {
      const actual = transaction[field] ?? null;
      if ((actual == null ? null : String(actual)) !== (value == null ? null : String(value))) {
        throw new Error(`Existing transaction does not match the requested ${field}.`);
      }
    }

    const amount = WalletService.normalizePositiveMinorUnitAmount(
      payload.amount,
      "Requested amount"
    );

    const existingAmount = WalletService.normalizePositiveMinorUnitAmount(
      transaction.amount,
      "Recorded amount"
    );

    if (amount !== existingAmount) {
      throw new Error("Existing transaction does not match the requested amount.");
    }
  }

  static assertExistingImmediateMovement(transaction, payload, direction) {
    WalletService.assertExistingInstruction(
      transaction,
      payload,
      direction,
      payload.provider ?? "internal"
    );

    if (transaction.status !== "completed") {
      throw new Error("Existing immediate wallet movement is not completed.");
    }

    const requestedDelta = payload.balanceDelta ?? {
      availableBalance: direction === "credit" ? payload.amount : -payload.amount,
      pendingBalance: 0,
      outstandingBalance: 0,
    };

    for (const field of ["availableBalance", "pendingBalance", "outstandingBalance"]) {
      const requested = WalletService.normalizeSignedMinorUnitAmount(
        requestedDelta[field] ?? 0,
        field
      );

      if (transaction.balanceDelta?.[field] !== requested) {
        throw new Error(`Existing transaction does not match the requested ${field} delta.`);
      }
    }

    const providerFee = WalletService.normalizeMinorUnitAmount(
      payload.providerFee ?? 0,
      "Provider fee"
    );

    const netAmount = WalletService.normalizeMinorUnitAmount(
      payload.netAmount ?? payload.amount,
      "Net amount"
    );

    if (transaction.providerFee !== providerFee || transaction.netAmount !== netAmount) {
      throw new Error("Existing transaction does not match the requested fee or net amount.");
    }
  }

  /* ---------- Get active platform settings ---------- */

  static async getPlatformSettings(options = {}) {
    const query = PlatformSettings.findOne({
      key: "global",
      isActive: true,
    });

    if (options.session) {
      query.session(options.session);
    }

    const settings = await query;

    if (!settings) {
      throw new Error("Active platform settings not found.");
    }

    return settings;
  }

  /* ---------- Normalize country and currency ---------- */

  static normalizeCountryCurrency({ countryCode, currency }) {
    return {
      countryCode: String(countryCode || "NG")
        .toUpperCase()
        .trim(),

      currency: String(currency || "NGN")
        .toUpperCase()
        .trim(),
    };
  }

  /* ---------- Get country-specific platform settings ---------- */

  static getCountrySetting(settings, { countryCode, currency }) {
    const normalized = WalletService.normalizeCountryCurrency({
      countryCode,
      currency,
    });

    const activeCountryCodes = settings.activeCountryCodes || [];
    const supportedCurrencies = settings.supportedCurrencies || [];

    if (!activeCountryCodes.includes(normalized.countryCode)) {
      throw new Error(`${normalized.countryCode} is not an active Loqum country.`);
    }

    if (!supportedCurrencies.includes(normalized.currency)) {
      throw new Error(`${normalized.currency} is not a supported Loqum currency.`);
    }

    const countrySetting = settings.countrySettings?.find(
      (item) =>
        item.countryCode === normalized.countryCode &&
        item.currency === normalized.currency &&
        item.isActive
    );

    if (!countrySetting) {
      throw new Error(
        `No active country setting found for ${normalized.countryCode}/${normalized.currency}.`
      );
    }

    return {
      countryCode: normalized.countryCode,

      currency: normalized.currency,

      platformFeeRate: countrySetting.platformFeeRate ?? settings.platformFeeRate,

      maximumEmployerWalletExternalTopupBalance:
        countrySetting.maximumEmployerWalletExternalTopupBalance ??
        settings.maximumEmployerWalletExternalTopupBalance,

      minimumEmployerWithdrawalAmount:
        countrySetting.minimumEmployerWithdrawalAmount ?? settings.minimumEmployerWithdrawalAmount,

      minimumProfessionalWithdrawalAmount:
        countrySetting.minimumProfessionalWithdrawalAmount ??
        settings.minimumProfessionalWithdrawalAmount,
    };
  }

  /* ---------- Build wallet balance snapshot ---------- */

  static getBalanceSnapshot(wallet) {
    return {
      availableBalance: WalletService.normalizeMinorUnitAmount(
        wallet.availableBalance ?? 0,
        "Available balance"
      ),

      pendingBalance: WalletService.normalizeMinorUnitAmount(
        wallet.pendingBalance ?? 0,
        "Pending balance"
      ),

      outstandingBalance: WalletService.normalizeMinorUnitAmount(
        wallet.outstandingBalance ?? 0,
        "Outstanding balance"
      ),
    };
  }

  /* ---------- Check wallet can transact ---------- */

  static assertWalletIsActive(wallet) {
    if (!wallet) {
      throw new Error("Wallet not found.");
    }

    if (wallet.status !== "active") {
      throw new Error(`Wallet is ${wallet.status}. Transactions are not allowed.`);
    }

    return true;
  }

  /* ---------- Check wallets use the same country and currency ---------- */

  static assertSameCountryAndCurrency(walletA, walletB) {
    if (!walletA || !walletB) {
      throw new Error("Both wallets are required.");
    }

    if (!walletA.countryCode || !walletA.currency || !walletB.countryCode || !walletB.currency) {
      throw new Error("Both wallets must identify their country and currency.");
    }

    if (walletA.countryCode !== walletB.countryCode) {
      throw new Error("Wallet country mismatch.");
    }

    if (walletA.currency !== walletB.currency) {
      throw new Error("Wallet currency mismatch.");
    }

    return true;
  }

  /* ---------- Get transaction reference by type ---------- */

  static getTransactionReference(type) {
    const referenceMap = {
      wallet_funding: generateWalletFundingReference,

      shift_funding: generateShiftFundingReference,

      shift_topup: generateShiftFundingReference,

      shift_refund: generateRefundReference,

      dispute_refund: generateRefundReference,

      professional_payout: generateSettlementReference,

      platform_fee: generatePlatformFeeReference,

      withdrawal: generateWithdrawalReference,

      withdrawal_reversal: generateWithdrawalReversalReference,
    };

    const generator = referenceMap[type] || (() => generateReference("LQ-TXN"));

    return generator();
  }

  /* ---------- Validate settlement / platform-fee transaction ownership ---------- */

  static assertTransactionBusinessContext({
    type,
    purpose = null,
    paymentRail = null,
    shift = null,
    shiftOccurrence = null,
    settlementBatch = null,
  }) {
    const normalizedType = String(type || "")
      .trim()
      .toLowerCase();

    const normalizedPurpose =
      purpose === null || purpose === undefined ? null : String(purpose).trim().toLowerCase();

    const normalizedPaymentRail =
      paymentRail === null || paymentRail === undefined
        ? null
        : String(paymentRail).trim().toLowerCase();

    if (normalizedType === "professional_payout") {
      if (!settlementBatch) {
        throw new Error("Professional payout must belong to a ShiftSettlementBatch.");
      }

      if (shift || shiftOccurrence) {
        throw new Error(
          "Professional settlement-batch payout cannot reference one Shift or occurrence."
        );
      }

      if (!SETTLEMENT_BATCH_PURPOSES.includes(normalizedPurpose)) {
        throw new Error("Professional payout must use the weekly professional payout purpose.");
      }

      if (normalizedPaymentRail !== "internal_transfer") {
        throw new Error("Professional settlement payout must use internal_transfer.");
      }
    }

    if (normalizedType === "platform_fee") {
      if (settlementBatch) {
        throw new Error("Platform-fee movement cannot belong to ShiftSettlementBatch.");
      }

      if (!shift || !shiftOccurrence) {
        throw new Error(
          "Platform-fee movement must reference its Shift and exact ShiftOccurrence."
        );
      }

      if (!PLATFORM_FEE_PURPOSES.includes(normalizedPurpose)) {
        throw new Error(
          "Platform fee must use base_platform_fee_earned or overtime_platform_fee_earned purpose."
        );
      }

      if (normalizedPaymentRail !== "internal_transfer") {
        throw new Error("Platform-fee movement must use internal_transfer.");
      }
    }

    if (PLATFORM_FEE_PURPOSES.includes(normalizedPurpose) && normalizedType !== "platform_fee") {
      throw new Error(`${normalizedPurpose} may only be used by a platform_fee transaction.`);
    }

    if (
      SETTLEMENT_BATCH_PURPOSES.includes(normalizedPurpose) &&
      normalizedType !== "professional_payout"
    ) {
      throw new Error(
        `${normalizedPurpose} may only be used by a professional_payout transaction.`
      );
    }

    return true;
  }

  /* ---------- Get existing transaction by idempotency key ---------- */

  static async getExistingTransactionByIdempotencyKey(idempotencyKey, session = null) {
    if (!idempotencyKey) {
      return null;
    }

    const query = Transaction.findOne({
      idempotencyKey,
    });

    if (session) {
      query.session(session);
    }

    return query;
  }

  /* ---------- Validate a previously completed transfer entry ---------- */

  static assertExistingTransferEntry({
    transaction,
    walletId,
    counterpartyWalletId,
    amount,
    direction,
    type,
    purpose,
    paymentRail,
    countryCode,
    currency,
    groupReference = null,
    shift = null,
    shiftOccurrence = null,
    assignmentCase = null,
    shiftApplication = null,
    settlementBatch = null,
    employerRefundBatch = null,
    employerRefundBatchLineId = null,
    dispute = null,
  }) {
    if (!transaction) {
      throw new Error("Existing transfer transaction is required.");
    }

    const expectedValues = {
      wallet: String(walletId),

      counterpartyWallet: String(counterpartyWalletId),

      amount: Number(amount),

      direction,

      type,

      purpose: purpose ?? null,

      paymentRail,

      provider: "internal",

      countryCode,

      currency,

      shift: shift ? String(shift) : null,

      shiftOccurrence: shiftOccurrence ? String(shiftOccurrence) : null,

      assignmentCase: assignmentCase ? String(assignmentCase) : null,

      shiftApplication: shiftApplication ? String(shiftApplication) : null,

      settlementBatch: settlementBatch ? String(settlementBatch) : null,

      employerRefundBatch: employerRefundBatch ? String(employerRefundBatch) : null,

      employerRefundBatchLineId: employerRefundBatchLineId
        ? String(employerRefundBatchLineId)
        : null,

      dispute: dispute ? String(dispute) : null,
    };

    const actualValues = {
      wallet: String(transaction.wallet),

      counterpartyWallet: transaction.counterpartyWallet
        ? String(transaction.counterpartyWallet)
        : null,

      amount: Number(transaction.amount),

      direction: transaction.direction,

      type: transaction.type,

      purpose: transaction.purpose ?? null,

      paymentRail: transaction.paymentRail,

      provider: transaction.provider,

      countryCode: transaction.countryCode,

      currency: transaction.currency,

      shift: transaction.shift ? String(transaction.shift) : null,

      shiftOccurrence: transaction.shiftOccurrence ? String(transaction.shiftOccurrence) : null,

      assignmentCase: transaction.assignmentCase ? String(transaction.assignmentCase) : null,

      shiftApplication: transaction.shiftApplication ? String(transaction.shiftApplication) : null,

      settlementBatch: transaction.settlementBatch ? String(transaction.settlementBatch) : null,

      employerRefundBatch: transaction.employerRefundBatch
        ? String(transaction.employerRefundBatch)
        : null,

      employerRefundBatchLineId: transaction.employerRefundBatchLineId
        ? String(transaction.employerRefundBatchLineId)
        : null,

      dispute: transaction.dispute ? String(transaction.dispute) : null,
    };

    for (const [field, expectedValue] of Object.entries(expectedValues)) {
      if (actualValues[field] !== expectedValue) {
        throw new Error(`Existing transfer transaction does not match the requested ${field}.`);
      }
    }

    if (!transaction.groupReference) {
      throw new Error("Existing transfer transaction has no group reference.");
    }

    if (groupReference && transaction.groupReference !== groupReference) {
      throw new Error(
        "Existing transfer transaction does not match the requested group reference."
      );
    }

    if (transaction.status !== "completed") {
      throw new Error(
        `Existing transfer transaction is ${transaction.status} and is not in a valid completed state.`
      );
    }

    return true;
  }

  /* ---------- Create employer wallet if missing ---------- */

  static async createEmployerWalletIfMissing(employerProfile, options = {}) {
    if (!employerProfile) {
      throw new Error("Employer profile is required to create employer wallet.");
    }

    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: employerProfile.countryCode || settings.defaultCountryCode,

      currency: employerProfile.currency || settings.defaultCurrency,
    });

    const wallet = await Wallet.findOneAndUpdate(
      {
        ownerType: "employer",

        employer: employerProfile._id,

        countryCode: countrySetting.countryCode,

        currency: countrySetting.currency,
      },
      {
        $set: {
          maximumExternalTopupBalance: countrySetting.maximumEmployerWalletExternalTopupBalance,

          minimumWithdrawalAmount: countrySetting.minimumEmployerWithdrawalAmount,
        },

        $setOnInsert: {
          ownerType: "employer",

          employer: employerProfile._id,

          professional: null,

          countryCode: countrySetting.countryCode,

          currency: countrySetting.currency,

          availableBalance: 0,

          pendingBalance: 0,

          outstandingBalance: 0,

          lifetimeCredit: 0,

          lifetimeDebit: 0,

          status: "active",
        },
      },
      {
        upsert: true,

        returnDocument: "after",

        runValidators: true,

        setDefaultsOnInsert: true,

        context: "query",

        session: options.session,
      }
    );

    return wallet;
  }

  /* ---------- Create professional wallet if missing ---------- */

  static async createProfessionalWalletIfMissing(professionalProfile, options = {}) {
    if (!professionalProfile) {
      throw new Error("Professional profile is required to create professional wallet.");
    }

    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: professionalProfile.countryCode || settings.defaultCountryCode,

      currency: professionalProfile.currency || settings.defaultCurrency,
    });

    const wallet = await Wallet.findOneAndUpdate(
      {
        ownerType: "professional",

        professional: professionalProfile._id,

        countryCode: countrySetting.countryCode,

        currency: countrySetting.currency,
      },
      {
        $set: {
          maximumExternalTopupBalance: null,

          minimumWithdrawalAmount: countrySetting.minimumProfessionalWithdrawalAmount,
        },

        $setOnInsert: {
          ownerType: "professional",

          employer: null,

          professional: professionalProfile._id,

          countryCode: countrySetting.countryCode,

          currency: countrySetting.currency,

          availableBalance: 0,

          pendingBalance: 0,

          outstandingBalance: 0,

          lifetimeCredit: 0,

          lifetimeDebit: 0,

          status: "active",
        },
      },
      {
        upsert: true,

        returnDocument: "after",

        runValidators: true,

        setDefaultsOnInsert: true,

        context: "query",

        session: options.session,
      }
    );

    return wallet;
  }

  /* ---------- Create escrow wallet ---------- */

  static async createEscrowWallet({ countryCode, currency } = {}, options = {}) {
    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: countryCode || settings.defaultCountryCode,

      currency: currency || settings.defaultCurrency,
    });

    const wallet = await Wallet.findOneAndUpdate(
      {
        ownerType: "escrow",

        countryCode: countrySetting.countryCode,

        currency: countrySetting.currency,
      },
      {
        $setOnInsert: {
          ownerType: "escrow",

          employer: null,

          professional: null,

          countryCode: countrySetting.countryCode,

          currency: countrySetting.currency,

          availableBalance: 0,

          pendingBalance: 0,

          outstandingBalance: 0,

          lifetimeCredit: 0,

          lifetimeDebit: 0,

          maximumExternalTopupBalance: null,

          minimumWithdrawalAmount: null,

          status: "active",
        },
      },
      {
        upsert: true,

        returnDocument: "after",

        runValidators: true,

        setDefaultsOnInsert: true,

        context: "query",

        session: options.session,
      }
    );

    return wallet;
  }

  /* ---------- Create platform wallet ---------- */

  static async createPlatformWallet({ countryCode, currency } = {}, options = {}) {
    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: countryCode || settings.defaultCountryCode,

      currency: currency || settings.defaultCurrency,
    });

    const wallet = await Wallet.findOneAndUpdate(
      {
        ownerType: "platform",

        countryCode: countrySetting.countryCode,

        currency: countrySetting.currency,
      },
      {
        $setOnInsert: {
          ownerType: "platform",

          employer: null,

          professional: null,

          countryCode: countrySetting.countryCode,

          currency: countrySetting.currency,

          availableBalance: 0,

          pendingBalance: 0,

          outstandingBalance: 0,

          lifetimeCredit: 0,

          lifetimeDebit: 0,

          maximumExternalTopupBalance: null,

          minimumWithdrawalAmount: null,

          status: "active",
        },
      },
      {
        upsert: true,

        returnDocument: "after",

        runValidators: true,

        setDefaultsOnInsert: true,

        context: "query",

        session: options.session,
      }
    );

    return wallet;
  }

  /* ---------- Get employer wallet ---------- */

  static async getEmployerWallet(
    { employerProfileId, countryCode = null, currency = null },
    options = {}
  ) {
    if (!employerProfileId) {
      throw new Error("Employer profile ID is required.");
    }

    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: countryCode || settings.defaultCountryCode,

      currency: currency || settings.defaultCurrency,
    });

    const query = Wallet.findOne({
      ownerType: "employer",

      employer: employerProfileId,

      countryCode: countrySetting.countryCode,

      currency: countrySetting.currency,
    });

    if (options.session) {
      query.session(options.session);
    }

    return query;
  }

  /* ---------- Get professional wallet ---------- */

  static async getProfessionalWallet(
    { professionalProfileId, countryCode = null, currency = null },
    options = {}
  ) {
    if (!professionalProfileId) {
      throw new Error("Professional profile ID is required.");
    }

    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: countryCode || settings.defaultCountryCode,

      currency: currency || settings.defaultCurrency,
    });

    const query = Wallet.findOne({
      ownerType: "professional",

      professional: professionalProfileId,

      countryCode: countrySetting.countryCode,

      currency: countrySetting.currency,
    });

    if (options.session) {
      query.session(options.session);
    }

    return query;
  }

  /* ---------- Get escrow wallet ---------- */

  static async getEscrowWallet({ countryCode = null, currency = null } = {}, options = {}) {
    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: countryCode || settings.defaultCountryCode,

      currency: currency || settings.defaultCurrency,
    });

    const query = Wallet.findOne({
      ownerType: "escrow",

      countryCode: countrySetting.countryCode,

      currency: countrySetting.currency,
    });

    if (options.session) {
      query.session(options.session);
    }

    return query;
  }

  /* ---------- Get platform wallet ---------- */

  static async getPlatformWallet({ countryCode = null, currency = null } = {}, options = {}) {
    const settings = await WalletService.getPlatformSettings({
      session: options.session,
    });

    const countrySetting = WalletService.getCountrySetting(settings, {
      countryCode: countryCode || settings.defaultCountryCode,

      currency: currency || settings.defaultCurrency,
    });

    const query = Wallet.findOne({
      ownerType: "platform",

      countryCode: countrySetting.countryCode,

      currency: countrySetting.currency,
    });

    if (options.session) {
      query.session(options.session);
    }

    return query;
  }

  /* ---------- Apply movement to one wallet and write transaction ---------- */

  static async applyWalletMovement({
    wallet,
    amount,
    direction,
    balanceDelta,

    type,
    purpose = null,

    paymentRail = null,

    provider = "internal",

    status = "completed",

    paystackStatus = null,

    reference = null,

    groupReference = null,

    idempotencyKey = null,

    paystackReference = null,

    paystackTransferReference = null,

    paystackTransferCode = null,

    providerEventId = null,

    counterpartyWallet = null,

    shift = null,

    shiftOccurrence = null,

    assignmentCase = null,

    shiftApplication = null,

    settlementBatch = null,

    employerRefundBatch = null,

    employerRefundBatchLineId = null,

    dva = null,

    bankAccount = null,

    dispute = null,

    relatedTransaction = null,

    providerFee = 0,

    netAmount = null,

    initiatedBy = {
      role: "system",
      userId: null,
    },

    description = null,

    metadata = {},

    session,
  }) {
    WalletService.assertActiveTransaction(session);
    WalletService.assertWalletIsActive(wallet);

    if (
      String(paymentRail || "")
        .trim()
        .toLowerCase() === "paystack_transfer"
    ) {
      throw new Error(
        "Paystack Transfer wallet movements must use the explicit pending external debit lifecycle."
      );
    }

    WalletService.assertTransactionBusinessContext({
      type,
      purpose,
      paymentRail,
      shift,
      shiftOccurrence,
      settlementBatch,
    });

    if (!["credit", "debit"].includes(direction)) {
      throw new Error("Transaction direction must be either credit or debit.");
    }

    const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
      amount,
      "Wallet movement amount"
    );

    const balanceBefore = WalletService.getBalanceSnapshot(wallet);

    const delta = {
      availableBalance: WalletService.normalizeSignedMinorUnitAmount(
        balanceDelta?.availableBalance ?? 0,
        "Available balance delta"
      ),

      pendingBalance: WalletService.normalizeSignedMinorUnitAmount(
        balanceDelta?.pendingBalance ?? 0,
        "Pending balance delta"
      ),

      outstandingBalance: WalletService.normalizeSignedMinorUnitAmount(
        balanceDelta?.outstandingBalance ?? 0,
        "Outstanding balance delta"
      ),
    };

    const rawBalanceAfter = {
      availableBalance: balanceBefore.availableBalance + delta.availableBalance,

      pendingBalance: balanceBefore.pendingBalance + delta.pendingBalance,

      outstandingBalance: balanceBefore.outstandingBalance + delta.outstandingBalance,
    };

    const hasNegativeBalance =
      rawBalanceAfter.availableBalance < 0 ||
      rawBalanceAfter.pendingBalance < 0 ||
      rawBalanceAfter.outstandingBalance < 0;

    if (hasNegativeBalance) {
      throw new Error("Wallet balance cannot go negative.");
    }

    const balanceAfter = {
      availableBalance: WalletService.normalizeMinorUnitAmount(
        rawBalanceAfter.availableBalance,
        "Available balance after movement"
      ),

      pendingBalance: WalletService.normalizeMinorUnitAmount(
        rawBalanceAfter.pendingBalance,
        "Pending balance after movement"
      ),

      outstandingBalance: WalletService.normalizeMinorUnitAmount(
        rawBalanceAfter.outstandingBalance,
        "Outstanding balance after movement"
      ),
    };

    wallet.availableBalance = balanceAfter.availableBalance;

    wallet.pendingBalance = balanceAfter.pendingBalance;

    wallet.outstandingBalance = balanceAfter.outstandingBalance;

    if (direction === "credit") {
      wallet.lifetimeCredit = WalletService.normalizeMinorUnitAmount(
        WalletService.normalizeMinorUnitAmount(
          wallet.lifetimeCredit ?? 0,
          "Existing lifetime credit"
        ) + normalizedAmount,
        "Lifetime credit"
      );
    }

    if (direction === "debit") {
      wallet.lifetimeDebit = WalletService.normalizeMinorUnitAmount(
        WalletService.normalizeMinorUnitAmount(
          wallet.lifetimeDebit ?? 0,
          "Existing lifetime debit"
        ) + normalizedAmount,
        "Lifetime debit"
      );
    }

    wallet.lastTransactionAt = new Date();

    await wallet.save({
      session,
    });

    const transactionData = {
      reference: reference || WalletService.getTransactionReference(type),

      groupReference,

      idempotencyKey,

      paystackReference,

      paystackTransferReference,

      paystackTransferCode,

      providerEventId,

      provider,

      type,

      purpose,

      direction,

      wallet: wallet._id,

      counterpartyWallet,

      amount: normalizedAmount,

      countryCode: wallet.countryCode,

      currency: wallet.currency,

      providerFee: WalletService.normalizeMinorUnitAmount(providerFee ?? 0, "Provider fee"),

      netAmount:
        netAmount === null || netAmount === undefined
          ? normalizedAmount
          : WalletService.normalizeMinorUnitAmount(netAmount, "Net amount"),

      balanceBefore,

      balanceAfter,

      balanceDelta: delta,

      shift,

      shiftOccurrence,

      assignmentCase,

      shiftApplication,

      settlementBatch,

      employerRefundBatch,

      employerRefundBatchLineId,

      dva,

      bankAccount,

      dispute,

      relatedTransaction,

      paymentRail,

      paystackStatus,

      status,

      initiatedBy,

      description,

      metadata,
    };

    const [transaction] = await Transaction.create([transactionData], {
      session,
    });

    return {
      wallet,
      transaction,
    };
  }

  /* ---------- Create pending external wallet credit ---------- */

  static async createPendingExternalCredit(
    {
      walletId,
      amount,

      type,
      purpose = null,

      paymentRail,
      provider,

      reference = null,

      idempotencyKey,

      paystackReference = null,

      shift = null,

      shiftOccurrence = null,

      assignmentCase = null,

      shiftApplication = null,

      settlementBatch = null,

      dva = null,

      initiatedBy = {
        role: "system",
        userId: null,
      },

      description = null,

      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      WalletService.assertIdempotencyKey(idempotencyKey);

      WalletService.normalizePositiveMinorUnitAmount(amount, "Pending external credit amount");

      if (!idempotencyKey) {
        throw new Error("Idempotency key is required for a pending external credit.");
      }

      const existingTransaction = await WalletService.getExistingTransactionByIdempotencyKey(
        idempotencyKey,
        session
      );

      if (existingTransaction) {
        WalletService.assertExistingInstruction(
          existingTransaction,
          {
            walletId,
            amount,
            type,
            purpose,

            paymentRail: String(paymentRail || "")
              .trim()
              .toLowerCase(),

            paystackReference,

            shift,

            shiftOccurrence,

            assignmentCase,

            shiftApplication,

            settlementBatch,

            dva,
          },
          "credit",
          String(provider || "")
            .trim()
            .toLowerCase()
        );

        WalletService.assertExternalCredit(existingTransaction);

        const existingWallet = await Wallet.findById(existingTransaction.wallet).session(session);

        WalletService.assertTransactionWallet(existingTransaction, existingWallet);

        return {
          wallet: existingWallet,

          transaction: existingTransaction,

          idempotent: true,
        };
      }

      const wallet = await Wallet.findById(walletId).session(session);

      if (!wallet) {
        throw new Error("Wallet not found.");
      }

      WalletService.assertWalletIsActive(wallet);

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        amount,
        "Pending external credit amount"
      );

      const cleanProvider = String(provider || "")
        .trim()
        .toLowerCase();

      const cleanPaymentRail = String(paymentRail || "")
        .trim()
        .toLowerCase();

      if (!cleanProvider) {
        throw new Error("Provider is required for a pending external credit.");
      }

      if (!cleanPaymentRail) {
        throw new Error("Payment rail is required for a pending external credit.");
      }

      WalletService.assertTransactionBusinessContext({
        type,
        purpose,
        paymentRail: cleanPaymentRail,
        shift,
        shiftOccurrence,
        settlementBatch,
      });

      if (
        ["paystack_checkout", "paystack_dva"].includes(cleanPaymentRail) &&
        cleanProvider !== "paystack"
      ) {
        throw new Error("Paystack payment rails must use paystack as provider.");
      }

      if (["paystack_checkout", "paystack_dva"].includes(cleanPaymentRail) && !paystackReference) {
        throw new Error("Paystack reference is required for a Paystack external credit.");
      }

      if (cleanPaymentRail === "paystack_dva") {
        if (wallet.ownerType !== "employer") {
          throw new Error("Paystack DVA can only credit an employer wallet.");
        }

        if (type !== "wallet_funding" || purpose !== "wallet_topup") {
          throw new Error(
            "Paystack DVA credits must use wallet_funding type and wallet_topup purpose."
          );
        }

        if (!dva) {
          throw new Error("DVA reference is required for a Paystack DVA credit.");
        }
      }

      WalletService.assertExternalCredit({
        direction: "credit",
        provider: cleanProvider,
        paymentRail: cleanPaymentRail,
        paystackReference,
        amount: normalizedAmount,
      });

      const balanceSnapshot = WalletService.getBalanceSnapshot(wallet);

      const transactionData = {
        reference: reference || WalletService.getTransactionReference(type),

        idempotencyKey,

        paystackReference,

        provider: cleanProvider,

        type,

        purpose,

        direction: "credit",

        wallet: wallet._id,

        counterpartyWallet: null,

        amount: normalizedAmount,

        countryCode: wallet.countryCode,

        currency: wallet.currency,

        providerFee: 0,

        netAmount: normalizedAmount,

        /**
         * No wallet movement has occurred yet.
         * The before and after balances therefore remain equal.
         */
        balanceBefore: balanceSnapshot,

        balanceAfter: balanceSnapshot,

        balanceDelta: {
          availableBalance: 0,

          pendingBalance: 0,

          outstandingBalance: 0,
        },

        shift,

        shiftOccurrence,

        assignmentCase,

        shiftApplication,

        settlementBatch,

        dva,

        paymentRail: cleanPaymentRail,

        paystackStatus: cleanProvider === "paystack" ? "pending" : null,

        status: "pending",

        initiatedBy,

        description,

        metadata,
      };

      const [transaction] = await Transaction.create([transactionData], {
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,
      };
    });
  }

  /* ---------- Mark pending external wallet credit as failed ---------- */

  static async markPendingExternalCreditFailed(
    { transactionId, failureReason, metadata = {} },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!transactionId) {
        throw new Error("Transaction ID is required.");
      }

      const transaction = await Transaction.findById(transactionId).session(session);

      if (!transaction) {
        throw new Error("Pending external credit transaction not found.");
      }

      WalletService.assertExternalCredit(transaction);

      if (transaction.status === "completed") {
        return {
          transaction,

          alreadyCompleted: true,
        };
      }

      if (["reversed", "cancelled"].includes(transaction.status)) {
        throw new Error(`A ${transaction.status} transaction cannot be marked as failed.`);
      }

      transaction.status = "failed";

      if (transaction.provider === "paystack") {
        transaction.paystackStatus = "failed";
      }

      transaction.failedAt = new Date();

      transaction.failureReason = String(
        failureReason || "External payment initialization failed."
      ).slice(0, 300);

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...metadata,
      };

      await transaction.save({
        session,
      });

      return {
        transaction,

        alreadyCompleted: false,
      };
    });
  }

  /* ---------- Complete pending external wallet credit ---------- */

  static async completePendingExternalCredit(
    {
      transactionId = null,

      paystackReference = null,

      providerEventId = null,

      providerFee = 0,

      netAmount = null,

      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!transactionId && !paystackReference) {
        throw new Error("Transaction ID or Paystack reference is required.");
      }

      const identifierFilter = {
        ...(transactionId ? { _id: transactionId } : {}),

        ...(paystackReference ? { paystackReference } : {}),
      };

      /**
       * Claim the pending transaction for processing.
       *
       * This prevents callback and webhook processing from both
       * crediting the wallet for the same provider payment.
       */
      const transaction = await Transaction.findOneAndUpdate(
        {
          ...identifierFilter,

          direction: "credit",

          provider: "paystack",

          paymentRail: {
            $in: ["paystack_checkout", "paystack_dva"],
          },

          status: {
            $in: ["pending", "failed"],
          },
        },
        {
          $set: {
            status: "processing",
          },
        },
        {
          new: true,

          session,
        }
      );

      if (!transaction) {
        const existingTransaction = await Transaction.findOne(identifierFilter).session(session);

        if (!existingTransaction) {
          throw new Error("Pending external credit transaction not found.");
        }

        WalletService.assertExternalCredit(existingTransaction);

        if (existingTransaction.status === "completed") {
          const existingWallet = await Wallet.findById(existingTransaction.wallet).session(session);

          WalletService.assertTransactionWallet(existingTransaction, existingWallet);

          return {
            wallet: existingWallet,

            transaction: existingTransaction,

            idempotent: true,
          };
        }

        if (existingTransaction.status === "processing") {
          throw new Error("This external payment is already being processed.");
        }

        throw new Error(`A ${existingTransaction.status} external credit cannot be completed.`);
      }

      const wallet = await Wallet.findById(transaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Transaction wallet not found.");
      }

      WalletService.assertExternalCredit(transaction);

      WalletService.assertTransactionWallet(transaction, wallet);

      WalletService.assertWalletIsActive(wallet);

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        transaction.amount,
        "External credit amount"
      );

      const normalizedProviderFee = WalletService.normalizeMinorUnitAmount(
        providerFee ?? 0,
        "Provider fee"
      );

      if (normalizedProviderFee > normalizedAmount) {
        throw new Error("Provider fee cannot exceed the transaction amount.");
      }

      const normalizedNetAmount =
        netAmount === null || netAmount === undefined
          ? normalizedAmount - normalizedProviderFee
          : WalletService.normalizeMinorUnitAmount(netAmount, "External credit net amount");

      if (normalizedNetAmount !== normalizedAmount - normalizedProviderFee) {
        throw new Error("External credit net amount must equal amount minus provider fee.");
      }

      const balanceBefore = WalletService.getBalanceSnapshot(wallet);

      const balanceAfter = {
        availableBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.availableBalance + normalizedAmount,
          "Available balance after external credit"
        ),

        pendingBalance: balanceBefore.pendingBalance,

        outstandingBalance: balanceBefore.outstandingBalance,
      };

      const isEmployerExternalTopup =
        wallet.ownerType === "employer" &&
        transaction.type === "wallet_funding" &&
        transaction.purpose === "wallet_topup" &&
        transaction.paymentRail === "paystack_dva";

      const hasExternalTopupLimit =
        wallet.maximumExternalTopupBalance !== null &&
        wallet.maximumExternalTopupBalance !== undefined &&
        WalletService.normalizeMinorUnitAmount(
          wallet.maximumExternalTopupBalance,
          "External top-up limit"
        ) > 0;

      if (
        isEmployerExternalTopup &&
        hasExternalTopupLimit &&
        balanceAfter.availableBalance > wallet.maximumExternalTopupBalance
      ) {
        throw new Error("Employer wallet external top-up balance limit exceeded.");
      }

      wallet.availableBalance = balanceAfter.availableBalance;

      wallet.pendingBalance = balanceAfter.pendingBalance;

      wallet.outstandingBalance = balanceAfter.outstandingBalance;

      wallet.lifetimeCredit = WalletService.normalizeMinorUnitAmount(
        WalletService.normalizeMinorUnitAmount(
          wallet.lifetimeCredit ?? 0,
          "Existing lifetime credit"
        ) + normalizedAmount,
        "Lifetime credit"
      );

      wallet.lastTransactionAt = new Date();

      await wallet.save({
        session,
      });

      transaction.balanceBefore = balanceBefore;

      transaction.balanceAfter = balanceAfter;

      transaction.balanceDelta = {
        availableBalance: normalizedAmount,

        pendingBalance: 0,

        outstandingBalance: 0,
      };

      transaction.providerFee = normalizedProviderFee;

      transaction.netAmount = normalizedNetAmount;

      if (providerEventId) {
        transaction.providerEventId = String(providerEventId).trim();
      }

      if (transaction.provider === "paystack") {
        transaction.paystackStatus = "success";
      }

      transaction.status = "completed";

      transaction.completedAt = new Date();

      transaction.failedAt = null;

      transaction.failureReason = null;

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...metadata,
      };

      await transaction.save({
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,
      };
    });
  }

  /* ---------- Validate an existing external debit instruction ---------- */

  static assertExistingExternalDebitTransaction({
    transaction,
    walletId,
    amount,
    type,
    purpose,
    paymentRail,
    provider,
    paystackTransferReference = null,
    bankAccount = null,
    employerRefundBatch = null,
    employerRefundBatchLineId = null,
    providerFee = 0,
    netAmount = null,
  }) {
    if (!transaction) {
      throw new Error("Existing external debit transaction is required.");
    }

    const expectedValues = {
      wallet: String(walletId),

      amount: Number(amount),

      direction: "debit",

      type,

      purpose: purpose ?? null,

      paymentRail,

      provider,

      providerFee: Number(providerFee),

      netAmount: netAmount === null || netAmount === undefined ? Number(amount) : Number(netAmount),

      paystackTransferReference: paystackTransferReference || null,

      bankAccount: bankAccount ? String(bankAccount) : null,

      employerRefundBatch: employerRefundBatch ? String(employerRefundBatch) : null,

      employerRefundBatchLineId: employerRefundBatchLineId
        ? String(employerRefundBatchLineId)
        : null,
    };

    const actualValues = {
      wallet: String(transaction.wallet),

      amount: Number(transaction.amount),

      direction: transaction.direction,

      type: transaction.type,

      purpose: transaction.purpose ?? null,

      paymentRail: transaction.paymentRail,

      provider: transaction.provider,

      providerFee: Number(transaction.providerFee),

      netAmount: Number(transaction.netAmount),

      paystackTransferReference: transaction.paystackTransferReference || null,

      bankAccount: transaction.bankAccount ? String(transaction.bankAccount) : null,

      employerRefundBatch: transaction.employerRefundBatch
        ? String(transaction.employerRefundBatch)
        : null,

      employerRefundBatchLineId: transaction.employerRefundBatchLineId
        ? String(transaction.employerRefundBatchLineId)
        : null,
    };

    for (const [field, expectedValue] of Object.entries(expectedValues)) {
      if (actualValues[field] !== expectedValue) {
        throw new Error(
          `Existing external debit transaction does not match the requested ${field}.`
        );
      }
    }

    return true;
  }

  /* ---------- Create pending external wallet debit / reservation ---------- */

  static async createPendingExternalDebit(
    {
      walletId,
      amount,

      type,
      purpose = null,

      paymentRail = "paystack_transfer",

      provider = "paystack",

      reference = null,

      idempotencyKey,

      paystackTransferReference = null,

      shift = null,

      shiftOccurrence = null,

      assignmentCase = null,

      shiftApplication = null,

      settlementBatch = null,

      employerRefundBatch = null,

      employerRefundBatchLineId = null,

      bankAccount,

      providerFee = 0,

      netAmount = null,

      dispute = null,

      initiatedBy = {
        role: "system",
        userId: null,
      },

      description = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime =
      currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

    if (Number.isNaN(normalizedCurrentTime.getTime())) {
      throw new Error("Current time is invalid.");
    }

    return WalletService.runWithOptionalTransaction(options, async (session) => {
      WalletService.assertIdempotencyKey(idempotencyKey);

      if (!idempotencyKey) {
        throw new Error("Idempotency key is required for a pending external debit.");
      }

      const cleanPaymentRail = String(paymentRail || "")
        .trim()
        .toLowerCase();

      const cleanProvider = String(provider || "")
        .trim()
        .toLowerCase();

      if (cleanPaymentRail !== "paystack_transfer") {
        throw new Error("Pending external debit currently supports Paystack Transfer only.");
      }

      if (cleanProvider !== "paystack") {
        throw new Error("Paystack Transfer must use paystack as provider.");
      }

      if (!bankAccount) {
        throw new Error("Bank account is required for a Paystack external debit.");
      }

      const normalizedPaystackTransferReference = paystackTransferReference
        ? String(paystackTransferReference).trim().toLowerCase()
        : null;

      if (
        normalizedPaystackTransferReference &&
        !/^[a-z0-9_-]{16,50}$/.test(normalizedPaystackTransferReference)
      ) {
        throw new Error("Paystack Transfer reference is invalid.");
      }

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        amount,
        "Pending external debit amount"
      );

      const normalizedProviderFee = WalletService.normalizeMinorUnitAmount(
        providerFee ?? 0,
        "External debit provider fee"
      );

      if (normalizedProviderFee > normalizedAmount) {
        throw new Error("Provider fee cannot exceed the external debit amount.");
      }

      const normalizedNetAmount =
        netAmount === null || netAmount === undefined
          ? normalizedAmount
          : WalletService.normalizePositiveMinorUnitAmount(netAmount, "External debit net amount");

      if (normalizedNetAmount > normalizedAmount) {
        throw new Error("Net amount cannot exceed the external debit amount.");
      }

      const existingTransaction = await WalletService.getExistingTransactionByIdempotencyKey(
        idempotencyKey,
        session
      );

      if (existingTransaction) {
        const expectedPaystackTransferReference =
          normalizedPaystackTransferReference ||
          existingTransaction.paystackTransferReference ||
          null;

        WalletService.assertExistingInstruction(
          existingTransaction,
          {
            walletId,

            amount: normalizedAmount,

            type,

            purpose,

            paymentRail: cleanPaymentRail,

            paystackTransferReference: expectedPaystackTransferReference,

            shift,

            shiftOccurrence,

            assignmentCase,

            shiftApplication,

            settlementBatch,

            employerRefundBatch,

            employerRefundBatchLineId,

            bankAccount,

            dispute,
          },
          "debit",
          cleanProvider
        );

        WalletService.assertExistingExternalDebitTransaction({
          transaction: existingTransaction,

          walletId,

          amount: normalizedAmount,

          type,

          purpose,

          paymentRail: cleanPaymentRail,

          provider: cleanProvider,

          providerFee: normalizedProviderFee,

          netAmount: normalizedNetAmount,

          paystackTransferReference: expectedPaystackTransferReference,

          bankAccount,

          employerRefundBatch,

          employerRefundBatchLineId,
        });

        const existingWallet = await Wallet.findById(existingTransaction.wallet).session(session);

        if (!existingWallet) {
          throw new Error("Existing external debit wallet not found.");
        }

        WalletService.assertTransactionWallet(existingTransaction, existingWallet);

        return {
          wallet: existingWallet,

          transaction: existingTransaction,

          idempotent: true,
        };
      }

      const wallet = await Wallet.findById(walletId).session(session);

      if (!wallet) {
        throw new Error("Wallet not found.");
      }

      WalletService.assertWalletIsActive(wallet);

      WalletService.assertTransactionBusinessContext({
        type,
        purpose,

        paymentRail: cleanPaymentRail,

        shift,

        shiftOccurrence,

        settlementBatch,
      });

      const balanceBefore = WalletService.getBalanceSnapshot(wallet);

      if (balanceBefore.availableBalance < normalizedAmount) {
        throw new Error("Wallet has insufficient available balance for this external debit.");
      }

      const balanceAfter = {
        availableBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.availableBalance - normalizedAmount,
          "Available balance after external debit reservation"
        ),

        pendingBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.pendingBalance + normalizedAmount,
          "Pending balance after external debit reservation"
        ),

        outstandingBalance: balanceBefore.outstandingBalance,
      };

      wallet.availableBalance = balanceAfter.availableBalance;

      wallet.pendingBalance = balanceAfter.pendingBalance;

      wallet.outstandingBalance = balanceAfter.outstandingBalance;

      /*
       * Reservation only.
       *
       * The value still exists inside the wallet. It is merely unavailable
       * for another obligation while the external Transfer is unresolved.
       *
       * lifetimeDebit must therefore remain unchanged.
       */
      wallet.lastTransactionAt = normalizedCurrentTime;

      await wallet.save({
        session,
      });

      const transactionData = {
        reference: reference || WalletService.getTransactionReference(type),

        idempotencyKey,

        paystackTransferReference: normalizedPaystackTransferReference,

        provider: cleanProvider,

        type,

        purpose,

        direction: "debit",

        wallet: wallet._id,

        counterpartyWallet: null,

        amount: normalizedAmount,

        countryCode: wallet.countryCode,

        currency: wallet.currency,

        providerFee: normalizedProviderFee,

        netAmount: normalizedNetAmount,

        /*
         * Reservation:
         *
         * available → pending
         *
         * The net wallet value does not change.
         */
        balanceBefore,

        balanceAfter,

        balanceDelta: {
          availableBalance: -normalizedAmount,

          pendingBalance: normalizedAmount,

          outstandingBalance: 0,
        },

        shift,

        shiftOccurrence,

        assignmentCase,

        shiftApplication,

        settlementBatch,

        employerRefundBatch,

        employerRefundBatchLineId,

        bankAccount,

        dispute,

        paymentRail: cleanPaymentRail,

        paystackStatus: "pending",

        status: "pending",

        initiatedBy,

        description,

        metadata: {
          ...(metadata || {}),

          externalDebitReservation: {
            amount: normalizedAmount,

            reservedAt: normalizedCurrentTime,
          },
        },
      };

      const [transaction] = await Transaction.create([transactionData], {
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,
      };
    });
  }

  /* ---------- Mark pending external debit as crossing provider boundary ---------- */

  static async markPendingExternalDebitProcessing(
    {
      transactionId,

      currentTime = new Date(),

      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!transactionId) {
        throw new Error("Transaction ID is required.");
      }

      const transaction = await Transaction.findById(transactionId).session(session);

      if (!transaction) {
        throw new Error("Pending external debit transaction not found.");
      }

      WalletService.assertExternalDebit(transaction);

      const paystackTransferReference = String(transaction.paystackTransferReference || "")
        .trim()
        .toLowerCase();

      if (!paystackTransferReference) {
        throw new Error(
          "Deterministic Paystack Transfer reference must be persisted before provider processing."
        );
      }

      if (!/^[a-z0-9_-]{16,50}$/.test(paystackTransferReference)) {
        throw new Error("Persisted Paystack Transfer reference is invalid.");
      }

      if (transaction.status === "completed") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        WalletService.assertTransactionWallet(transaction, wallet);

        return {
          wallet,

          transaction,

          idempotent: true,

          alreadyCompleted: true,
        };
      }

      if (transaction.status === "processing") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        WalletService.assertTransactionWallet(transaction, wallet);

        return {
          wallet,

          transaction,

          idempotent: true,

          alreadyCompleted: false,
        };
      }

      if (transaction.status !== "pending") {
        throw new Error(`A ${transaction.status} external debit cannot enter provider processing.`);
      }

      if (
        transaction.direction !== "debit" ||
        transaction.paymentRail !== "paystack_transfer" ||
        transaction.provider !== "paystack"
      ) {
        throw new Error("Transaction is not a Paystack external debit instruction.");
      }

      const wallet = await Wallet.findById(transaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Transaction wallet not found.");
      }

      WalletService.assertTransactionWallet(transaction, wallet);

      WalletService.assertWalletIsActive(wallet);

      const normalizedCurrentTime =
        currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

      if (Number.isNaN(normalizedCurrentTime.getTime())) {
        throw new Error("Current time is invalid.");
      }

      transaction.status = "processing";

      transaction.processingStartedAt = normalizedCurrentTime;

      transaction.paystackStatus = "pending";

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...metadata,

        providerSubmissionStartedAt: normalizedCurrentTime,
      };

      await transaction.save({
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,

        alreadyCompleted: false,
      };
    });
  }

  /* ---------- Cancel reserved external debit before provider submission ---------- */

  static async cancelPendingExternalDebit(
    {
      transactionId,

      cancellationReason = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!transactionId) {
        throw new Error("Transaction ID is required.");
      }

      const transaction = await Transaction.findById(transactionId).session(session);

      if (!transaction) {
        throw new Error("Pending external debit transaction not found.");
      }

      WalletService.assertExternalDebit(transaction);

      if (transaction.status === "cancelled") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        WalletService.assertTransactionWallet(transaction, wallet);

        return {
          wallet,

          transaction,

          idempotent: true,
        };
      }

      if (transaction.status !== "pending") {
        throw new Error(
          `A ${transaction.status} external debit cannot be cancelled before provider submission.`
        );
      }

      if (
        transaction.direction !== "debit" ||
        transaction.paymentRail !== "paystack_transfer" ||
        transaction.provider !== "paystack"
      ) {
        throw new Error("Transaction is not a Paystack external debit instruction.");
      }

      const normalizedCurrentTime =
        currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

      if (Number.isNaN(normalizedCurrentTime.getTime())) {
        throw new Error("Current time is invalid.");
      }

      const wallet = await Wallet.findById(transaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Transaction wallet not found.");
      }

      WalletService.assertTransactionWallet(transaction, wallet);

      WalletService.assertWalletIsActive(wallet);

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        transaction.amount,
        "External debit amount"
      );

      const balanceBefore = WalletService.getBalanceSnapshot(wallet);

      if (balanceBefore.pendingBalance < normalizedAmount) {
        throw new Error(
          "Wallet pending balance no longer contains the reserved external debit amount."
        );
      }

      const balanceAfter = {
        availableBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.availableBalance + normalizedAmount,
          "Available balance after external debit cancellation"
        ),

        pendingBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.pendingBalance - normalizedAmount,
          "Pending balance after external debit cancellation"
        ),

        outstandingBalance: balanceBefore.outstandingBalance,
      };

      wallet.availableBalance = balanceAfter.availableBalance;

      wallet.pendingBalance = balanceAfter.pendingBalance;

      wallet.outstandingBalance = balanceAfter.outstandingBalance;

      wallet.lastTransactionAt = normalizedCurrentTime;

      await wallet.save({
        session,
      });

      transaction.balanceBefore = balanceBefore;

      transaction.balanceAfter = balanceAfter;

      transaction.balanceDelta = {
        availableBalance: normalizedAmount,

        pendingBalance: -normalizedAmount,

        outstandingBalance: 0,
      };

      transaction.status = "cancelled";

      transaction.paystackStatus = null;

      transaction.cancelledAt = normalizedCurrentTime;

      transaction.cancellationReason = String(
        cancellationReason || "External Transfer was cancelled before provider submission."
      ).slice(0, 300);

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...metadata,

        reservationReleasedAt: normalizedCurrentTime,
      };

      await transaction.save({
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,
      };
    });
  }

  /* ---------- Complete reserved external wallet debit ---------- */

  static async completePendingExternalDebit(
    {
      transactionId,

      paystackTransferCode,

      providerEventId = null,

      providerFee = null,

      netAmount = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!transactionId) {
        throw new Error("Transaction ID is required.");
      }

      const transaction = await Transaction.findById(transactionId).session(session);

      if (!transaction) {
        throw new Error("Pending external debit transaction not found.");
      }

      WalletService.assertExternalDebit(transaction);

      WalletService.assertTransferCode(transaction, paystackTransferCode, true);

      if (transaction.status === "completed") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        WalletService.assertTransactionWallet(transaction, wallet);

        return {
          wallet,

          transaction,

          idempotent: true,
        };
      }

      if (transaction.status !== "processing") {
        throw new Error(
          `A ${transaction.status} external debit cannot be completed as provider success.`
        );
      }

      if (
        transaction.direction !== "debit" ||
        transaction.paymentRail !== "paystack_transfer" ||
        transaction.provider !== "paystack"
      ) {
        throw new Error("Transaction is not a Paystack external debit instruction.");
      }

      const normalizedTransferCode = String(paystackTransferCode || "").trim();

      if (!normalizedTransferCode) {
        throw new Error("Paystack Transfer code is required to complete an external debit.");
      }

      const normalizedCurrentTime =
        currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

      if (Number.isNaN(normalizedCurrentTime.getTime())) {
        throw new Error("Current time is invalid.");
      }

      const wallet = await Wallet.findById(transaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Transaction wallet not found.");
      }

      WalletService.assertTransactionWallet(transaction, wallet);

      WalletService.assertWalletIsActive(wallet);

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        transaction.amount,
        "External debit amount"
      );

      const normalizedProviderFee =
        providerFee === null || providerFee === undefined
          ? WalletService.normalizeMinorUnitAmount(
              transaction.providerFee ?? 0,
              "Stored external debit provider fee"
            )
          : WalletService.normalizeMinorUnitAmount(providerFee, "Provider fee");

      if (normalizedProviderFee > normalizedAmount) {
        throw new Error("Provider fee cannot exceed the transaction amount.");
      }

      const normalizedNetAmount =
        netAmount === null || netAmount === undefined
          ? WalletService.normalizeMinorUnitAmount(
              transaction.netAmount ?? normalizedAmount,
              "Stored external debit net amount"
            )
          : WalletService.normalizeMinorUnitAmount(netAmount, "External debit net amount");

      if (normalizedNetAmount > normalizedAmount) {
        throw new Error("Net amount cannot exceed the transaction amount.");
      }

      const balanceBefore = WalletService.getBalanceSnapshot(wallet);

      if (balanceBefore.pendingBalance < normalizedAmount) {
        throw new Error(
          "Wallet pending balance no longer contains the reserved external debit amount."
        );
      }

      const balanceAfter = {
        availableBalance: balanceBefore.availableBalance,

        pendingBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.pendingBalance - normalizedAmount,
          "Pending balance after external debit completion"
        ),

        outstandingBalance: balanceBefore.outstandingBalance,
      };

      wallet.availableBalance = balanceAfter.availableBalance;

      wallet.pendingBalance = balanceAfter.pendingBalance;

      wallet.outstandingBalance = balanceAfter.outstandingBalance;

      /*
       * This is the moment the external debit becomes real.
       */
      wallet.lifetimeDebit = WalletService.normalizeMinorUnitAmount(
        WalletService.normalizeMinorUnitAmount(
          wallet.lifetimeDebit ?? 0,
          "Existing lifetime debit"
        ) + normalizedAmount,
        "Lifetime debit"
      );

      wallet.lastTransactionAt = normalizedCurrentTime;

      await wallet.save({
        session,
      });

      transaction.balanceBefore = balanceBefore;

      transaction.balanceAfter = balanceAfter;

      /*
       * The reservation already removed amount from availableBalance.
       *
       * Provider success now removes that reserved amount from
       * pendingBalance. The final movement therefore has net -amount.
       */
      transaction.balanceDelta = {
        availableBalance: 0,

        pendingBalance: -normalizedAmount,

        outstandingBalance: 0,
      };

      transaction.providerFee = normalizedProviderFee;

      transaction.netAmount = normalizedNetAmount;

      transaction.paystackTransferCode = normalizedTransferCode;

      if (providerEventId) {
        transaction.providerEventId = String(providerEventId).trim();
      }

      transaction.paystackStatus = "success";

      transaction.status = "completed";

      transaction.completedAt = normalizedCurrentTime;

      transaction.failedAt = null;

      transaction.failureReason = null;

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...metadata,

        providerCompletedAt: normalizedCurrentTime,
      };

      await transaction.save({
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,
      };
    });
  }

  /* ---------- Fail reserved external wallet debit and release reservation ---------- */

  static async markPendingExternalDebitFailed(
    {
      transactionId,

      failureReason,

      paystackTransferCode = null,

      providerEventId = null,

      metadata = {},

      currentTime = new Date(),
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!transactionId) {
        throw new Error("Transaction ID is required.");
      }

      const transaction = await Transaction.findById(transactionId).session(session);

      if (!transaction) {
        throw new Error("Pending external debit transaction not found.");
      }

      WalletService.assertExternalDebit(transaction);

      WalletService.assertTransferCode(transaction, paystackTransferCode);

      if (transaction.status === "failed") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        WalletService.assertTransactionWallet(transaction, wallet);

        return {
          wallet,

          transaction,

          idempotent: true,

          alreadyCompleted: false,
        };
      }

      if (transaction.status === "completed") {
        const wallet = await Wallet.findById(transaction.wallet).session(session);

        WalletService.assertTransactionWallet(transaction, wallet);

        return {
          wallet,

          transaction,

          idempotent: true,

          alreadyCompleted: true,
        };
      }

      if (transaction.status !== "processing") {
        throw new Error(
          `A ${transaction.status} external debit cannot be marked failed. ` +
            "Use cancelPendingExternalDebit() before provider submission."
        );
      }

      if (
        transaction.direction !== "debit" ||
        transaction.paymentRail !== "paystack_transfer" ||
        transaction.provider !== "paystack"
      ) {
        throw new Error("Transaction is not a Paystack external debit instruction.");
      }

      const normalizedCurrentTime =
        currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

      if (Number.isNaN(normalizedCurrentTime.getTime())) {
        throw new Error("Current time is invalid.");
      }

      const wallet = await Wallet.findById(transaction.wallet).session(session);

      if (!wallet) {
        throw new Error("Transaction wallet not found.");
      }

      WalletService.assertTransactionWallet(transaction, wallet);

      WalletService.assertWalletIsActive(wallet);

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        transaction.amount,
        "External debit amount"
      );

      const balanceBefore = WalletService.getBalanceSnapshot(wallet);

      if (balanceBefore.pendingBalance < normalizedAmount) {
        throw new Error(
          "Wallet pending balance no longer contains the reserved external debit amount."
        );
      }

      const balanceAfter = {
        availableBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.availableBalance + normalizedAmount,
          "Available balance after external debit release"
        ),

        pendingBalance: WalletService.normalizeMinorUnitAmount(
          balanceBefore.pendingBalance - normalizedAmount,
          "Pending balance after external debit release"
        ),

        outstandingBalance: balanceBefore.outstandingBalance,
      };

      wallet.availableBalance = balanceAfter.availableBalance;

      wallet.pendingBalance = balanceAfter.pendingBalance;

      wallet.outstandingBalance = balanceAfter.outstandingBalance;

      wallet.lastTransactionAt = normalizedCurrentTime;

      /*
       * No lifetimeDebit change.
       *
       * Provider failure means the value never left the wallet.
       */
      await wallet.save({
        session,
      });

      transaction.balanceBefore = balanceBefore;

      transaction.balanceAfter = balanceAfter;

      /*
       * Release:
       *
       * pending → available
       *
       * Net wallet value remains unchanged.
       */
      transaction.balanceDelta = {
        availableBalance: normalizedAmount,

        pendingBalance: -normalizedAmount,

        outstandingBalance: 0,
      };

      if (paystackTransferCode) {
        transaction.paystackTransferCode = String(paystackTransferCode).trim();
      }

      if (providerEventId) {
        transaction.providerEventId = String(providerEventId).trim();
      }

      transaction.status = "failed";

      transaction.paystackStatus = "failed";

      transaction.failedAt = normalizedCurrentTime;

      transaction.failureReason = String(failureReason || "External Transfer failed.").slice(
        0,
        300
      );

      transaction.metadata = {
        ...(transaction.metadata || {}),

        ...metadata,

        reservationReleasedAt: normalizedCurrentTime,
      };

      await transaction.save({
        session,
      });

      return {
        wallet,

        transaction,

        idempotent: false,

        alreadyCompleted: false,
      };
    });
  }

  /* ---------- Credit one wallet from an external or system source ---------- */

  static async creditWallet(payload, options = {}) {
    if (payload.status != null && payload.status !== "completed") {
      throw new Error("Immediate wallet credits must be completed movements.");
    }

    WalletService.assertIdempotencyKey(payload.idempotencyKey);

    WalletService.normalizePositiveMinorUnitAmount(payload.amount, "Wallet movement amount");

    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const existingTransaction = await WalletService.getExistingTransactionByIdempotencyKey(
        payload.idempotencyKey,
        session
      );

      if (existingTransaction) {
        WalletService.assertExistingImmediateMovement(existingTransaction, payload, "credit");

        const wallet = await Wallet.findById(existingTransaction.wallet).session(session);

        WalletService.assertTransactionWallet(existingTransaction, wallet);

        return {
          wallet,

          transaction: existingTransaction,

          idempotent: true,
        };
      }

      const wallet = await Wallet.findById(payload.walletId).session(session);

      if (!wallet) {
        throw new Error("Wallet not found.");
      }

      return WalletService.applyWalletMovement({
        ...payload,

        wallet,

        direction: "credit",

        balanceDelta: payload.balanceDelta || {
          availableBalance: payload.amount,

          pendingBalance: 0,

          outstandingBalance: 0,
        },

        session,
      });
    });
  }

  /* ---------- Debit one wallet for immediate non-Transfer movement ---------- */

  static async debitWallet(payload, options = {}) {
    if (payload.status != null && payload.status !== "completed") {
      throw new Error("Immediate wallet debits must be completed movements.");
    }

    const normalizedPaymentRail = String(payload?.paymentRail || "")
      .trim()
      .toLowerCase();

    if (normalizedPaymentRail === "paystack_transfer") {
      throw new Error(
        "Paystack Transfer debits must use createPendingExternalDebit(), " +
          "markPendingExternalDebitProcessing(), and the explicit completion/failure lifecycle."
      );
    }

    WalletService.assertIdempotencyKey(payload.idempotencyKey);

    WalletService.normalizePositiveMinorUnitAmount(payload.amount, "Wallet movement amount");

    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const existingTransaction = await WalletService.getExistingTransactionByIdempotencyKey(
        payload.idempotencyKey,
        session
      );

      if (existingTransaction) {
        WalletService.assertExistingImmediateMovement(existingTransaction, payload, "debit");

        const wallet = await Wallet.findById(existingTransaction.wallet).session(session);

        WalletService.assertTransactionWallet(existingTransaction, wallet);

        return {
          wallet,

          transaction: existingTransaction,

          idempotent: true,
        };
      }

      const wallet = await Wallet.findById(payload.walletId).session(session);

      if (!wallet) {
        throw new Error("Wallet not found.");
      }

      return WalletService.applyWalletMovement({
        ...payload,

        wallet,

        direction: "debit",

        balanceDelta: payload.balanceDelta || {
          availableBalance: -payload.amount,

          pendingBalance: 0,

          outstandingBalance: 0,
        },

        session,
      });
    });
  }

  /* ---------- Transfer between two internal wallets ---------- */

  static async transferBetweenWallets(
    {
      fromWalletId,

      toWalletId,

      amount,

      type,

      purpose = null,

      paymentRail = "internal_transfer",

      groupReference = null,

      debitReference = null,

      creditReference = null,

      debitIdempotencyKey = null,

      creditIdempotencyKey = null,

      shift = null,

      shiftOccurrence = null,

      assignmentCase = null,

      shiftApplication = null,

      settlementBatch = null,

      employerRefundBatch = null,

      employerRefundBatchLineId = null,

      dispute = null,

      initiatedBy = {
        role: "system",
        userId: null,
      },

      description = null,

      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      if (!fromWalletId || !toWalletId) {
        throw new Error("Both source and destination wallet IDs are required.");
      }

      if (String(fromWalletId) === String(toWalletId)) {
        throw new Error("Source and destination wallets must be different.");
      }

      WalletService.assertIdempotencyKey(debitIdempotencyKey);

      WalletService.assertIdempotencyKey(creditIdempotencyKey);

      if (!debitIdempotencyKey || !creditIdempotencyKey) {
        throw new Error(
          "Debit and credit idempotency keys are required for an internal wallet transfer."
        );
      }

      if (String(debitIdempotencyKey) === String(creditIdempotencyKey)) {
        throw new Error("Debit and credit idempotency keys must be different.");
      }

      const normalizedPaymentRail = String(paymentRail || "")
        .trim()
        .toLowerCase();

      if (!INTERNAL_PAYMENT_RAILS.includes(normalizedPaymentRail)) {
        throw new Error("Internal wallet transfers must use an internal payment rail.");
      }

      WalletService.assertTransactionBusinessContext({
        type,
        purpose,

        paymentRail: normalizedPaymentRail,

        shift,

        shiftOccurrence,

        settlementBatch,
      });

      const requestedGroupReference = groupReference
        ? String(groupReference).trim().toUpperCase()
        : null;

      const normalizedAmount = WalletService.normalizePositiveMinorUnitAmount(
        amount,
        "Transfer amount"
      );

      const fromWallet = await Wallet.findById(fromWalletId).session(session);

      const toWallet = await Wallet.findById(toWalletId).session(session);

      if (!fromWallet || !toWallet) {
        throw new Error("Both source and destination wallets are required.");
      }

      WalletService.assertWalletIsActive(fromWallet);

      WalletService.assertWalletIsActive(toWallet);

      WalletService.assertSameCountryAndCurrency(fromWallet, toWallet);

      {
        const existingDebit = await WalletService.getExistingTransactionByIdempotencyKey(
          debitIdempotencyKey,
          session
        );

        const existingCredit = await WalletService.getExistingTransactionByIdempotencyKey(
          creditIdempotencyKey,
          session
        );

        if (existingDebit || existingCredit) {
          if (!existingDebit || !existingCredit) {
            throw new Error(
              "The transfer has only one persisted ledger entry and is financially inconsistent."
            );
          }

          WalletService.assertExistingTransferEntry({
            transaction: existingDebit,

            walletId: fromWallet._id,

            counterpartyWalletId: toWallet._id,

            amount: normalizedAmount,

            direction: "debit",

            type,

            purpose,

            paymentRail: normalizedPaymentRail,

            countryCode: fromWallet.countryCode,

            currency: fromWallet.currency,

            groupReference: requestedGroupReference,

            shift,

            shiftOccurrence,

            assignmentCase,

            shiftApplication,

            settlementBatch,

            employerRefundBatch,

            employerRefundBatchLineId,

            dispute,
          });

          WalletService.assertExistingTransferEntry({
            transaction: existingCredit,

            walletId: toWallet._id,

            counterpartyWalletId: fromWallet._id,

            amount: normalizedAmount,

            direction: "credit",

            type,

            purpose,

            paymentRail: normalizedPaymentRail,

            countryCode: fromWallet.countryCode,

            currency: fromWallet.currency,

            groupReference: requestedGroupReference,

            shift,

            shiftOccurrence,

            assignmentCase,

            shiftApplication,

            settlementBatch,

            employerRefundBatch,

            employerRefundBatchLineId,

            dispute,
          });

          if (
            String(existingDebit.relatedTransaction || "") !== String(existingCredit._id) ||
            String(existingCredit.relatedTransaction || "") !== String(existingDebit._id)
          ) {
            throw new Error("Existing transfer ledger entries are not correctly paired.");
          }

          if (existingDebit.groupReference !== existingCredit.groupReference) {
            throw new Error("Existing transfer ledger entries do not share a group reference.");
          }

          return {
            groupReference: existingDebit.groupReference,

            debit: {
              wallet: fromWallet,

              transaction: existingDebit,
            },

            credit: {
              wallet: toWallet,

              transaction: existingCredit,
            },

            idempotent: true,
          };
        }
      }

      const sharedGroupReference = requestedGroupReference || generateGroupReference();

      /*
       * Both ledger entries begin as processing because Transaction
       * validation requires completed internal wallet movements to reference
       * their paired entry.
       *
       * The wallet movements and both transaction documents remain inside
       * the same MongoDB transaction. They are linked and completed before
       * commit.
       */
      const debitResult = await WalletService.applyWalletMovement({
        wallet: fromWallet,

        amount: normalizedAmount,

        direction: "debit",

        balanceDelta: {
          availableBalance: -normalizedAmount,

          pendingBalance: 0,

          outstandingBalance: 0,
        },

        type,

        purpose,

        paymentRail: normalizedPaymentRail,

        provider: "internal",

        status: "processing",

        reference: debitReference || WalletService.getTransactionReference(type),

        groupReference: sharedGroupReference,

        idempotencyKey: debitIdempotencyKey,

        counterpartyWallet: toWallet._id,

        shift,

        shiftOccurrence,

        assignmentCase,

        shiftApplication,

        settlementBatch,

        employerRefundBatch,

        employerRefundBatchLineId,

        dispute,

        initiatedBy,

        description,

        metadata,

        session,
      });

      const creditResult = await WalletService.applyWalletMovement({
        wallet: toWallet,

        amount: normalizedAmount,

        direction: "credit",

        balanceDelta: {
          availableBalance: normalizedAmount,

          pendingBalance: 0,

          outstandingBalance: 0,
        },

        type,

        purpose,

        paymentRail: normalizedPaymentRail,

        provider: "internal",

        status: "processing",

        reference: creditReference || WalletService.getTransactionReference(type),

        groupReference: sharedGroupReference,

        idempotencyKey: creditIdempotencyKey,

        counterpartyWallet: fromWallet._id,

        shift,

        shiftOccurrence,

        assignmentCase,

        shiftApplication,

        settlementBatch,

        employerRefundBatch,

        employerRefundBatchLineId,

        dispute,

        initiatedBy,

        description,

        metadata,

        session,
      });

      debitResult.transaction.relatedTransaction = creditResult.transaction._id;

      creditResult.transaction.relatedTransaction = debitResult.transaction._id;

      debitResult.transaction.status = "completed";

      creditResult.transaction.status = "completed";

      await debitResult.transaction.save({
        session,
      });

      await creditResult.transaction.save({
        session,
      });

      return {
        groupReference: sharedGroupReference,

        debit: debitResult,

        credit: creditResult,

        idempotent: false,
      };
    });
  }
}

module.exports = WalletService;
