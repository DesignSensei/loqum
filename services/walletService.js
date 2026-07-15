// services/walletService.js

const mongoose = require("mongoose");

const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const PlatformSettings = require("../models/PlatformSettings");

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
    if (options.session) {
      return callback(options.session);
    }

    const session = await mongoose.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        result = await callback(session);
      });

      return result;
    } finally {
      await session.endSession();
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

      maximumEmployerWalletBalance:
        countrySetting.maximumEmployerWalletBalance ?? settings.maximumEmployerWalletBalance,

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
      availableBalance: money.normalizeMinorUnitAmount(
        wallet.availableBalance ?? 0,
        "Available balance"
      ),
      pendingBalance: money.normalizeMinorUnitAmount(wallet.pendingBalance ?? 0, "Pending balance"),
      outstandingBalance: money.normalizeMinorUnitAmount(
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

  /* ---------- Get existing transaction by idempotency key ---------- */
  static async getExistingTransactionByIdempotencyKey(idempotencyKey, session = null) {
    if (!idempotencyKey) {
      return null;
    }

    const query = Transaction.findOne({ idempotencyKey });

    if (session) {
      query.session(session);
    }

    return query;
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

          maximumBalance: countrySetting.maximumEmployerWalletBalance,
          minimumWithdrawalAmount: countrySetting.minimumEmployerWithdrawalAmount,

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

          maximumBalance: null,
          minimumWithdrawalAmount: countrySetting.minimumProfessionalWithdrawalAmount,

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

          maximumBalance: null,
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

          maximumBalance: null,
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
    paystackTransferCode = null,
    providerEventId = null,

    counterpartyWallet = null,
    shift = null,
    shiftApplication = null,
    dva = null,
    bankAccount = null,
    dispute = null,
    relatedTransaction = null,

    providerFee = 0,
    netAmount = null,

    initiatedBy = { role: "system", userId: null },
    description = null,
    metadata = {},

    session,
  }) {
    WalletService.assertWalletIsActive(wallet);

    if (!["credit", "debit"].includes(direction)) {
      throw new Error("Transaction direction must be either credit or debit.");
    }

    const normalizedAmount = money.normalizePositiveMinorUnitAmount(
      amount,
      "Wallet movement amount"
    );

    const balanceBefore = WalletService.getBalanceSnapshot(wallet);

    const delta = {
      availableBalance: money.normalizeSignedMinorUnitAmount(
        balanceDelta?.availableBalance ?? 0,
        "Available balance delta"
      ),
      pendingBalance: money.normalizeSignedMinorUnitAmount(
        balanceDelta?.pendingBalance ?? 0,
        "Pending balance delta"
      ),
      outstandingBalance: money.normalizeSignedMinorUnitAmount(
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
      availableBalance: money.normalizeMinorUnitAmount(
        rawBalanceAfter.availableBalance,
        "Available balance after movement"
      ),
      pendingBalance: money.normalizeMinorUnitAmount(
        rawBalanceAfter.pendingBalance,
        "Pending balance after movement"
      ),
      outstandingBalance: money.normalizeMinorUnitAmount(
        rawBalanceAfter.outstandingBalance,
        "Outstanding balance after movement"
      ),
    };

    const hasMaximumBalance =
      wallet.maximumBalance !== null &&
      wallet.maximumBalance !== undefined &&
      Number(wallet.maximumBalance) > 0;

    if (hasMaximumBalance && balanceAfter.availableBalance > wallet.maximumBalance) {
      throw new Error("Wallet maximum balance limit exceeded.");
    }

    wallet.availableBalance = balanceAfter.availableBalance;
    wallet.pendingBalance = balanceAfter.pendingBalance;
    wallet.outstandingBalance = balanceAfter.outstandingBalance;

    if (direction === "credit") {
      wallet.lifetimeCredit = money.normalizeMinorUnitAmount(
        (wallet.lifetimeCredit ?? 0) + normalizedAmount,
        "Lifetime credit"
      );
    }

    if (direction === "debit") {
      wallet.lifetimeDebit = money.normalizeMinorUnitAmount(
        (wallet.lifetimeDebit ?? 0) + normalizedAmount,
        "Lifetime debit"
      );
    }

    wallet.lastTransactionAt = new Date();

    await wallet.save({ session });

    const transactionData = {
      reference: reference || WalletService.getTransactionReference(type),
      groupReference,
      idempotencyKey,

      paystackReference,
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

      providerFee: money.normalizeMinorUnitAmount(providerFee ?? 0, "Provider fee"),
      netAmount:
        netAmount === null || netAmount === undefined
          ? normalizedAmount
          : money.normalizeMinorUnitAmount(netAmount, "Net amount"),

      balanceBefore,
      balanceAfter,
      balanceDelta: delta,

      shift,
      shiftApplication,
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

    const [transaction] = await Transaction.create([transactionData], { session });

    return {
      wallet,
      transaction,
    };
  }

  /* ---------- Credit one wallet from an external or system source ---------- */
  static async creditWallet(payload, options = {}) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const existingTransaction = await WalletService.getExistingTransactionByIdempotencyKey(
        payload.idempotencyKey,
        session
      );

      if (existingTransaction) {
        const wallet = await Wallet.findById(existingTransaction.wallet).session(session);

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

  /* ---------- Debit one wallet for withdrawal or external movement ---------- */
  static async debitWallet(payload, options = {}) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const existingTransaction = await WalletService.getExistingTransactionByIdempotencyKey(
        payload.idempotencyKey,
        session
      );

      if (existingTransaction) {
        const wallet = await Wallet.findById(existingTransaction.wallet).session(session);

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

      shift = null,
      shiftApplication = null,
      dispute = null,

      initiatedBy = { role: "system", userId: null },
      description = null,
      metadata = {},
    },
    options = {}
  ) {
    return WalletService.runWithOptionalTransaction(options, async (session) => {
      const fromWallet = await Wallet.findById(fromWalletId).session(session);
      const toWallet = await Wallet.findById(toWalletId).session(session);

      if (!fromWallet || !toWallet) {
        throw new Error("Both source and destination wallets are required.");
      }

      WalletService.assertWalletIsActive(fromWallet);
      WalletService.assertWalletIsActive(toWallet);
      WalletService.assertSameCountryAndCurrency(fromWallet, toWallet);

      const normalizedAmount = money.normalizePositiveMinorUnitAmount(amount, "Transfer amount");

      const sharedGroupReference = groupReference || generateGroupReference();

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
        paymentRail,
        provider: "internal",
        status: "completed",

        reference: debitReference || WalletService.getTransactionReference(type),
        groupReference: sharedGroupReference,
        counterpartyWallet: toWallet._id,

        shift,
        shiftApplication,
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
        paymentRail,
        provider: "internal",
        status: "completed",

        reference: creditReference || WalletService.getTransactionReference(type),
        groupReference: sharedGroupReference,
        counterpartyWallet: fromWallet._id,

        shift,
        shiftApplication,
        dispute,

        initiatedBy,
        description,
        metadata,

        session,
      });

      debitResult.transaction.relatedTransaction = creditResult.transaction._id;
      creditResult.transaction.relatedTransaction = debitResult.transaction._id;

      await debitResult.transaction.save({ session });
      await creditResult.transaction.save({ session });

      return {
        groupReference: sharedGroupReference,
        debit: debitResult,
        credit: creditResult,
      };
    });
  }
}

module.exports = WalletService;
