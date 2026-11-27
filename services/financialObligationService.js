// services/financialObligationService.js

const mongoose = require("mongoose");

const FinancialObligation = require("../models/FinancialObligation");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");
const DVA = require("../models/DVA");
const EmployerProfile = require("../models/EmployerProfile");
const SubscriptionPayment = require("../models/SubscriptionPayment");
const JobPayment = require("../models/JobPayment");

const PaystackService = require("./paystackService");
const ProviderEventService = require("./providerEventService");
const WalletFundingService = require("./walletFundingService");

class FinancialObligationService {
  /* ---------- HELPERS ---------- */

  static createError({ message, code, statusCode = 409, retryable = false }) {
    const error = new Error(message);

    error.name = "FinancialObligationError";
    error.code = code;
    error.statusCode = statusCode;
    error.retryable = retryable;

    return error;
  }

  static fail(message, code, retryable = false) {
    throw FinancialObligationService.createError({
      message,
      code,
      statusCode: retryable ? 503 : 409,
      retryable,
    });
  }

  static cleanString(value) {
    if (typeof value !== "string") return null;

    return value.trim() || null;
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  static normalizeObjectId(value, label) {
    const id = String(value?._id || value || "");

    if (!/^[a-f0-9]{24}$/i.test(id)) {
      throw new Error(`${label} must be a valid ObjectId.`);
    }

    return new mongoose.Types.ObjectId(id);
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (!Number.isFinite(currentTime.getTime())) {
      throw new Error("Financial obligation time is invalid.");
    }

    return currentTime;
  }

  static assertPositiveAmount(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer in minor units.`);
    }

    return value;
  }

  static assertNonNegativeAmount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer in minor units.`);
    }

    return value;
  }

  static assertProviderMode(mode) {
    if (!["test", "live"].includes(mode)) {
      FinancialObligationService.fail(
        "A confirmed Paystack environment is required.",
        "FINANCIAL_OBLIGATION_PROVIDER_MODE_INVALID"
      );
    }
  }

  static assertActiveFinancialTransaction(session) {
    if (!session?.inTransaction?.()) {
      throw new Error(
        "Financial obligation recording requires an active caller-owned transaction."
      );
    }
  }

  /* ---------- IDEMPOTENCY ---------- */

  static buildDVAFundingKey({ providerMode, providerReference }) {
    FinancialObligationService.assertProviderMode(providerMode);

    const reference = FinancialObligationService.cleanString(providerReference);

    if (!reference) {
      throw new Error("DVA payment reference is required.");
    }

    return ["financial-obligation", "paystack", providerMode, "dva-funding", reference].join(":");
  }

  static buildWithdrawalReversalKey(withdrawalTransactionId) {
    const id = FinancialObligationService.normalizeObjectId(
      withdrawalTransactionId,
      "Withdrawal transaction ID"
    );

    return ["financial-obligation", "withdrawal-reversal", String(id)].join(":");
  }

  static assertMatchingObligation(existing, expected) {
    for (const field of [
      "type",
      "idempotencyKey",
      "ownerType",
      "provider",
      "providerMode",
      "providerReference",
      "providerTransactionId",
      "providerTransferCode",
      "providerStatus",
      "amount",
      "providerAmount",
      "providerFee",
      "providerNetAmount",
      "countryCode",
      "currency",
      "verificationSource",
    ]) {
      if ((existing[field] ?? null) !== (expected[field] ?? null)) {
        FinancialObligationService.fail(
          `Existing financial obligation has conflicting ${field}.`,
          "FINANCIAL_OBLIGATION_IDENTITY_MISMATCH"
        );
      }
    }

    for (const field of [
      "employer", "professional", "wallet", "dva", "withdrawalTransaction",
      "commercialTransaction", "subscriptionPayment", "jobPayment",
    ]) {
      const previous = existing[field] ?? null;
      const incoming = expected[field] ?? null;

      if (!previous && !incoming) continue;

      if (!FinancialObligationService.sameId(previous, incoming)) {
        FinancialObligationService.fail(
          `Existing financial obligation has conflicting ${field}.`,
          "FINANCIAL_OBLIGATION_OWNERSHIP_MISMATCH"
        );
      }
    }

    return existing;
  }

  static async createOrGetObligation(data, session) {
    FinancialObligationService.assertActiveFinancialTransaction(session);

    const existing = await FinancialObligation.findOne({
      idempotencyKey: data.idempotencyKey,
    }).session(session);

    if (existing) {
      FinancialObligationService.assertMatchingObligation(existing, data);

      return {
        obligation: existing,
        created: false,
        idempotent: true,
      };
    }

    const [obligation] = await FinancialObligation.create([data], { session });

    return {
      obligation,
      created: true,
      idempotent: false,
    };
  }

  /* ---------- RECORD LOADERS ---------- */

  static async getObligationById(financialObligationId, options = {}) {
    const id = FinancialObligationService.normalizeObjectId(
      financialObligationId,
      "Financial obligation ID"
    );

    const query = FinancialObligation.findById(id);

    if (options.session) {
      query.session(options.session);
    }

    const obligation = await query;

    if (!obligation) {
      throw FinancialObligationService.createError({
        message: "Financial obligation was not found.",
        code: "FINANCIAL_OBLIGATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return obligation;
  }

  static async getOriginalWallet(walletId, session) {
    const id = FinancialObligationService.normalizeObjectId(walletId, "Wallet ID");

    const wallet = await Wallet.findById(id).session(session);

    if (!wallet) {
      FinancialObligationService.fail(
        "Original financial wallet was not found.",
        "FINANCIAL_OBLIGATION_WALLET_NOT_FOUND"
      );
    }

    return wallet;
  }

  static getWalletOwnership(wallet) {
    const employer = wallet.ownerType === "employer" ? wallet.employer : null;

    const professional = wallet.ownerType === "professional" ? wallet.professional : null;

    if (
      !["employer", "professional"].includes(wallet.ownerType) ||
      (wallet.ownerType === "employer" && (!employer || wallet.professional)) ||
      (wallet.ownerType === "professional" && (!professional || wallet.employer))
    ) {
      FinancialObligationService.fail(
        "Original wallet has inconsistent ownership.",
        "FINANCIAL_OBLIGATION_WALLET_OWNER_INVALID"
      );
    }

    return {
      ownerType: wallet.ownerType,
      employer,
      professional,
    };
  }

  /* ---------- DVA PAYMENT VALIDATION ---------- */

  static assertVerifiedDVAPayment(providerEvent, payment) {
    if (
      !payment ||
      providerEvent.provider !== "paystack" ||
      providerEvent.eventName !== "charge.success" ||
      providerEvent.eventCategory !== "employer_wallet_funding" ||
      providerEvent.isVerified !== true
    ) {
      FinancialObligationService.fail(
        "Verified DVA funding evidence is required.",
        "FINANCIAL_OBLIGATION_DVA_PAYMENT_INVALID"
      );
    }

    FinancialObligationService.assertProviderMode(payment.mode);

    const payload = providerEvent.normalizedPayload || {};

    const conflicts = payload.dvaFundingIdentityConflicts;

    if (conflicts != null && (!Array.isArray(conflicts) || conflicts.length)) {
      FinancialObligationService.fail(
        "DVA payment contains unresolved identity conflicts.",
        "FINANCIAL_OBLIGATION_DVA_IDENTITY_CONFLICT"
      );
    }

    FinancialObligationService.assertPositiveAmount(payment.amount, "DVA payment amount");

    FinancialObligationService.assertNonNegativeAmount(payment.providerFee, "DVA provider fee");

    FinancialObligationService.assertNonNegativeAmount(
      payment.netAmount,
      "DVA provider net amount"
    );

    if (
      payment.providerReference !== providerEvent.providerReference ||
      payment.amount !== providerEvent.amount ||
      payment.currency !== providerEvent.currency ||
      payment.countryCode !== providerEvent.countryCode ||
      payment.countryCode !== "NG" ||
      payment.currency !== "NGN" ||
      !/^[1-9]\d*$/.test(String(payment.paystackTransactionId || "")) ||
      payment.providerFee > payment.amount ||
      payment.netAmount !== payment.amount - payment.providerFee
    ) {
      FinancialObligationService.fail(
        "Verified DVA payment does not match the provider event.",
        "FINANCIAL_OBLIGATION_DVA_PAYMENT_MISMATCH"
      );
    }

    if (
      (payload.dvaFundingTransactionId != null &&
        String(payload.dvaFundingTransactionId) !== String(payment.paystackTransactionId)) ||
      (payload.domain && payload.domain !== payment.mode) ||
      (providerEvent.providerFee != null && providerEvent.providerFee !== payment.providerFee) ||
      (providerEvent.netAmount != null && providerEvent.netAmount !== payment.netAmount)
    ) {
      FinancialObligationService.fail(
        "Verified DVA payment conflicts with recorded provider evidence.",
        "FINANCIAL_OBLIGATION_DVA_EVIDENCE_MISMATCH"
      );
    }
  }

  static assertHistoricalDVA({ dva, wallet, payment }) {
    if (
      !dva ||
      !dva.employer ||
      !dva.wallet ||
      dva.provider !== "paystack" ||
      dva.countryCode !== payment.countryCode ||
      dva.currency !== payment.currency ||
      dva.metadata?.assignmentMode !== payment.mode
    ) {
      FinancialObligationService.fail(
        "Historical DVA does not match the verified payment.",
        "FINANCIAL_OBLIGATION_DVA_MISMATCH"
      );
    }

    if (!["retiring", "deactivated"].includes(dva.status) || !dva.retirementStartedAt) {
      FinancialObligationService.fail(
        "Only retiring or deactivated DVAs use historical funding obligations.",
        "FINANCIAL_OBLIGATION_DVA_NOT_RETIRED"
      );
    }

    const ownership = FinancialObligationService.getWalletOwnership(wallet);

    if (
      ownership.ownerType !== "employer" ||
      !FinancialObligationService.sameId(dva.wallet, wallet._id) ||
      !FinancialObligationService.sameId(dva.employer, ownership.employer) ||
      wallet.countryCode !== dva.countryCode ||
      wallet.currency !== dva.currency
    ) {
      FinancialObligationService.fail(
        "Historical DVA does not match its original employer wallet.",
        "FINANCIAL_OBLIGATION_DVA_WALLET_MISMATCH"
      );
    }

    const identity = payment.identity || {};

    for (const field of [
      "paystackDedicatedAccountId",
      "paystackCustomerId",
      "paystackCustomerCode",
      "accountNumber",
      "bankId",
      "bankCode",
      "bankSlug",
      "providerSlug",
    ]) {
      if (
        identity[field] != null &&
        (dva[field] == null || String(identity[field]) !== String(dva[field]))
      ) {
        FinancialObligationService.fail(
          `Historical DVA contains conflicting ${field}.`,
          "FINANCIAL_OBLIGATION_DVA_IDENTITY_MISMATCH"
        );
      }
    }

    const hasCustomerIdentity = Boolean(
      identity.paystackCustomerId || identity.paystackCustomerCode
    );

    const hasReceivingAccountIdentity = Boolean(
      identity.paystackDedicatedAccountId ||
      (identity.accountNumber &&
        (identity.bankId || identity.bankCode || identity.bankSlug || identity.providerSlug))
    );

    if (!hasCustomerIdentity || !hasReceivingAccountIdentity) {
      FinancialObligationService.fail(
        "Historical DVA requires confirmed customer and receiving account identity.",
        "FINANCIAL_OBLIGATION_DVA_IDENTITY_INCOMPLETE"
      );
    }

    return ownership;
  }

  /* ---------- RETIRED DVA FUNDING ---------- */

  static async recordRetiredDVAFunding(
    { providerEventRecordId, processingClaimId, payment, currentTime = new Date() },
    options = {}
  ) {
    FinancialObligationService.assertActiveFinancialTransaction(options.session);

    const verifiedAt = FinancialObligationService.normalizeCurrentTime(currentTime);

    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

      FinancialObligationService.assertVerifiedDVAPayment(providerEvent, payment);

      if (!providerEvent.dva || !providerEvent.employer || !providerEvent.wallet) {
        FinancialObligationService.fail(
          "Historical DVA ownership must be resolved first.",
          "FINANCIAL_OBLIGATION_DVA_ROUTING_REQUIRED"
        );
      }

      /* ---------- SHARED DVA LOCK ---------- */

      await WalletFundingService.lockDVAFundingDisposition(
        {
          dvaId: providerEvent.dva,
          employerProfileId: providerEvent.employer,
        },
        session
      );

      const dva = await DVA.findById(providerEvent.dva).session(session);

      const wallet = await FinancialObligationService.getOriginalWallet(
        providerEvent.wallet,
        session
      );

      const ownership = FinancialObligationService.assertHistoricalDVA({
        dva,
        wallet,
        payment,
      });

      if (
        !FinancialObligationService.sameId(providerEvent.employer, ownership.employer) ||
        providerEvent.professional
      ) {
        FinancialObligationService.fail(
          "Provider event conflicts with historical DVA ownership.",
          "FINANCIAL_OBLIGATION_DVA_OWNER_MISMATCH"
        );
      }

      /* ---------- EXISTING LEDGER PROTECTION ---------- */

      const fundingKey = WalletFundingService.buildFundingIdempotencyKey({
        provider: "paystack",
        providerReference: payment.providerReference,
      });

      const existingFunding = await Transaction.findOne({
        $or: [
          {
            idempotencyKey: fundingKey,
          },
          {
            provider: "paystack",
            paystackReference: payment.providerReference,
          },
        ],
      }).session(session);

      if (existingFunding || providerEvent.transaction) {
        FinancialObligationService.fail(
          "DVA payment already has a ledger transaction.",
          "FINANCIAL_OBLIGATION_DVA_ALREADY_CREDITED"
        );
      }

      /* ---------- PROVIDER MODE PROTECTION ---------- */

      const conflictingObligation = await FinancialObligation.exists({
        type: "retired_dva_funding",
        provider: "paystack",
        providerReference: payment.providerReference,
        providerMode: {
          $ne: payment.mode,
        },
      }).session(session);

      if (conflictingObligation) {
        FinancialObligationService.fail(
          "DVA payment reference conflicts with another provider environment.",
          "FINANCIAL_OBLIGATION_DVA_PROVIDER_MODE_CONFLICT"
        );
      }

      /* ---------- RECORD OBLIGATION ---------- */

      const idempotencyKey = FinancialObligationService.buildDVAFundingKey({
        providerMode: payment.mode,
        providerReference: payment.providerReference,
      });

      return FinancialObligationService.createOrGetObligation(
        {
          type: "retired_dva_funding",
          idempotencyKey,
          status: "open",

          ...ownership,

          wallet: wallet._id,
          dva: dva._id,
          withdrawalTransaction: null,
          sourceProviderEvent: providerEvent._id,

          provider: "paystack",
          providerMode: payment.mode,
          providerReference: payment.providerReference,
          providerTransactionId: String(payment.paystackTransactionId),
          providerTransferCode: null,
          providerStatus: "success",

          amount: payment.amount,
          providerAmount: payment.amount,
          providerFee: payment.providerFee,
          providerNetAmount: payment.netAmount,

          countryCode: payment.countryCode,
          currency: payment.currency,

          verifiedAt,
          verificationSource: "paystack_transaction_verification",

          providerEvidence: {
            providerEventRecordId: String(providerEvent._id),

            providerReference: payment.providerReference,

            transactionId: String(payment.paystackTransactionId),

            domain: payment.mode,
            status: "success",

            amount: payment.amount,
            fees: payment.providerFee,
            netAmount: payment.netAmount,
            currency: payment.currency,

            identity: payment.identity,
          },

          settlement: null,
        },
        session
      );
    });
  }

  /* ---------- WITHDRAWAL VALIDATION ---------- */

  static assertCompletedWithdrawal(withdrawal) {
    if (
      !withdrawal ||
      withdrawal.type !== "withdrawal" ||
      withdrawal.purpose !== "withdrawal" ||
      withdrawal.direction !== "debit" ||
      withdrawal.paymentRail !== "paystack_transfer" ||
      withdrawal.provider !== "paystack" ||
      withdrawal.status !== "completed" ||
      withdrawal.paystackStatus !== "success" ||
      !withdrawal.completedAt ||
      !withdrawal.wallet ||
      !withdrawal.bankAccount ||
      !withdrawal.paystackTransferReference ||
      !withdrawal.paystackTransferCode ||
      !withdrawal.metadata?.paystackRecipientCode
    ) {
      FinancialObligationService.fail(
        "A completed provider-bound withdrawal is required.",
        "FINANCIAL_OBLIGATION_WITHDRAWAL_INVALID"
      );
    }

    FinancialObligationService.assertPositiveAmount(
      withdrawal.amount,
      "Original withdrawal amount"
    );

    FinancialObligationService.assertPositiveAmount(withdrawal.netAmount, "Original bank payout");

    if (withdrawal.netAmount > withdrawal.amount) {
      FinancialObligationService.fail(
        "Withdrawal payout exceeds its original wallet debit.",
        "FINANCIAL_OBLIGATION_WITHDRAWAL_AMOUNT_INVALID"
      );
    }
  }

  static assertVerifiedWithdrawalReversal(withdrawal, transfer) {
    FinancialObligationService.assertCompletedWithdrawal(withdrawal);

    FinancialObligationService.assertProviderMode(transfer?.domain);

    if (!transfer || transfer.status !== "reversed") {
      FinancialObligationService.fail(
        "Paystack has not confirmed reversal of the withdrawal.",
        "FINANCIAL_OBLIGATION_REVERSAL_UNCONFIRMED",
        true
      );
    }

    if (
      transfer.reference !== withdrawal.paystackTransferReference ||
      transfer.transferCode !== withdrawal.paystackTransferCode ||
      transfer.recipientCode !== withdrawal.metadata.paystackRecipientCode ||
      transfer.currency !== withdrawal.currency ||
      transfer.amount !== withdrawal.netAmount
    ) {
      FinancialObligationService.fail(
        "Verified Transfer does not match the original withdrawal.",
        "FINANCIAL_OBLIGATION_REVERSAL_MISMATCH"
      );
    }

    const originalProviderMode = withdrawal.metadata?.paystackMode;

    FinancialObligationService.assertProviderMode(originalProviderMode);

    if (transfer.domain !== originalProviderMode || transfer.domain !== PaystackService.getMode()) {
      FinancialObligationService.fail(
        "Verified Transfer does not match the original withdrawal environment.",
        "FINANCIAL_OBLIGATION_REVERSAL_MODE_MISMATCH"
      );
    }

    return true;
  }

  /* ---------- PROVIDER REVERSAL VERIFICATION ---------- */

  static async verifyClosedWalletWithdrawalReversal({ withdrawalTransactionId }) {
    const id = FinancialObligationService.normalizeObjectId(
      withdrawalTransactionId,
      "Withdrawal transaction ID"
    );

    const withdrawal = await Transaction.findById(id);

    FinancialObligationService.assertCompletedWithdrawal(withdrawal);

    const wallet = await Wallet.findById(withdrawal.wallet);

    if (!wallet || wallet.status !== "closed") {
      FinancialObligationService.fail(
        "Historical withdrawal obligations require a closed wallet.",
        "FINANCIAL_OBLIGATION_WALLET_NOT_CLOSED"
      );
    }

    const originalProviderMode = withdrawal.metadata?.paystackMode;

    FinancialObligationService.assertProviderMode(originalProviderMode);

    if (originalProviderMode !== PaystackService.getMode()) {
      FinancialObligationService.fail(
        "Original withdrawal belongs to another Paystack environment.",
        "FINANCIAL_OBLIGATION_REVERSAL_MODE_MISMATCH"
      );
    }

    // Provider verification remains outside the transaction.

    const transfer = await PaystackService.verifyTransfer(withdrawal.paystackTransferReference);

    FinancialObligationService.assertVerifiedWithdrawalReversal(withdrawal, transfer);

    return {
      withdrawalTransactionId: String(withdrawal._id),

      verifiedAt: new Date(),

      transfer: {
        reference: transfer.reference,
        transferCode: transfer.transferCode,
        recipientCode: transfer.recipientCode,
        domain: transfer.domain,
        status: transfer.status,
        amount: transfer.amount,
        currency: transfer.currency,
        providerTransferId: transfer.id || null,
        updatedAt: transfer.updatedAt || null,
      },
    };
  }

  /* ---------- WITHDRAWAL DISPOSITION ---------- */

  static async linkWithdrawalFinancialObligation({ withdrawal, obligation }, session) {
    FinancialObligationService.assertActiveFinancialTransaction(session);

    const previousObligationId = withdrawal.metadata?.financialObligationId;

    const previousDisposition = withdrawal.metadata?.providerReversalDisposition;

    if (
      previousObligationId &&
      !FinancialObligationService.sameId(previousObligationId, obligation._id)
    ) {
      FinancialObligationService.fail(
        "Withdrawal already references another financial obligation.",
        "FINANCIAL_OBLIGATION_WITHDRAWAL_LINK_CONFLICT"
      );
    }

    if (previousDisposition && previousDisposition !== "financial_obligation") {
      FinancialObligationService.fail(
        "Withdrawal already has a conflicting reversal disposition.",
        "FINANCIAL_OBLIGATION_WITHDRAWAL_DISPOSITION_CONFLICT"
      );
    }

    const previousReversalStatus = withdrawal.metadata?.providerReversalStatus;

    if (previousReversalStatus && previousReversalStatus !== "reversed") {
      FinancialObligationService.fail(
        "Withdrawal has a conflicting historical provider reversal status.",
        "FINANCIAL_OBLIGATION_WITHDRAWAL_REVERSAL_STATUS_CONFLICT"
      );
    }

    if (
      previousObligationId &&
      previousDisposition === "financial_obligation" &&
      previousReversalStatus === "reversed" &&
      withdrawal.metadata?.providerReversalVerifiedAt
    ) {
      return withdrawal;
    }

    // Preserve the original completed ledger debit.

    withdrawal.metadata = {
      ...(withdrawal.metadata || {}),

      financialObligationId: String(obligation._id),

      providerReversalDisposition: "financial_obligation",

      providerReversalStatus: "reversed",

      providerReversalVerifiedAt: obligation.verifiedAt,
    };

    await withdrawal.save({ session });

    return withdrawal;
  }

  /* ---------- CLOSED-WALLET WITHDRAWAL REVERSAL ---------- */

  static async recordClosedWalletWithdrawalReversal(
    { providerEventRecordId, processingClaimId, verification },
    options = {}
  ) {
    FinancialObligationService.assertActiveFinancialTransaction(options.session);

    if (!verification?.transfer || !verification.verifiedAt) {
      throw new Error("Verified Paystack withdrawal reversal evidence is required.");
    }

    const verifiedAt = FinancialObligationService.normalizeCurrentTime(verification.verifiedAt);

    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      ProviderEventService.assertActiveProcessingClaim(providerEvent, processingClaimId);

      if (
        providerEvent.provider !== "paystack" ||
        providerEvent.eventName !== "transfer.reversed" ||
        providerEvent.isVerified !== true ||
        !["employer_withdrawal_reversal", "professional_withdrawal_reversal"].includes(
          providerEvent.eventCategory
        )
      ) {
        FinancialObligationService.fail(
          "Verified withdrawal reversal event is required.",
          "FINANCIAL_OBLIGATION_REVERSAL_EVENT_INVALID"
        );
      }

      const withdrawalId = FinancialObligationService.normalizeObjectId(
        verification.withdrawalTransactionId,
        "Withdrawal transaction ID"
      );

      const withdrawal = await Transaction.findById(withdrawalId).session(session);

      const transfer = verification.transfer;

      FinancialObligationService.assertVerifiedWithdrawalReversal(withdrawal, transfer);

      if (verifiedAt < withdrawal.completedAt) {
        FinancialObligationService.fail(
          "Reversal verification cannot precede withdrawal completion.",
          "FINANCIAL_OBLIGATION_REVERSAL_TIME_INVALID"
        );
      }

      const wallet = await FinancialObligationService.getOriginalWallet(withdrawal.wallet, session);

      if (wallet.status !== "closed") {
        FinancialObligationService.fail(
          "Original withdrawal wallet is not closed.",
          "FINANCIAL_OBLIGATION_WALLET_NOT_CLOSED"
        );
      }

      const ownership = FinancialObligationService.getWalletOwnership(wallet);

      const expectedCategory = `${ownership.ownerType}_withdrawal_reversal`;

      const payload = providerEvent.normalizedPayload || {};

      /* ---------- PROVIDER ENVIRONMENT ---------- */

      if (payload.domain != null && payload.domain !== transfer.domain) {
        FinancialObligationService.fail(
          "Withdrawal reversal event conflicts with its verified provider environment.",
          "FINANCIAL_OBLIGATION_REVERSAL_EVENT_MODE_MISMATCH"
        );
      }

      /* ---------- HISTORICAL WITHDRAWAL VALIDATION ---------- */

      if (
        providerEvent.eventCategory !== expectedCategory ||
        providerEvent.providerReference !== transfer.reference ||
        providerEvent.amount !== transfer.amount ||
        providerEvent.currency !== withdrawal.currency ||
        providerEvent.countryCode !== withdrawal.countryCode ||
        wallet.currency !== withdrawal.currency ||
        wallet.countryCode !== withdrawal.countryCode ||
        !FinancialObligationService.sameId(providerEvent.transaction, withdrawal._id) ||
        !FinancialObligationService.sameId(providerEvent.wallet, wallet._id) ||
        !FinancialObligationService.sameId(providerEvent.bankAccount, withdrawal.bankAccount) ||
        withdrawal.metadata.ownerType !== ownership.ownerType ||
        payload.recipientCode !== transfer.recipientCode
      ) {
        FinancialObligationService.fail(
          "Provider reversal does not match the historical withdrawal.",
          "FINANCIAL_OBLIGATION_REVERSAL_EVENT_MISMATCH"
        );
      }

      for (const [field, expected] of [
        ["employer", ownership.employer],
        ["professional", ownership.professional],
      ]) {
        const eventOwner = providerEvent[field];

        const transactionOwner = withdrawal.metadata[`${field}ProfileId`];

        if (expected) {
          if (
            !FinancialObligationService.sameId(eventOwner, expected) ||
            !FinancialObligationService.sameId(transactionOwner, expected)
          ) {
            FinancialObligationService.fail(
              "Withdrawal reversal conflicts with historical ownership.",
              "FINANCIAL_OBLIGATION_REVERSAL_OWNER_MISMATCH"
            );
          }
        } else if (eventOwner || transactionOwner) {
          FinancialObligationService.fail(
            "Withdrawal reversal contains unrelated ownership.",
            "FINANCIAL_OBLIGATION_REVERSAL_OWNER_MISMATCH"
          );
        }
      }

      for (const value of [payload.paystackTransferCode, payload.transferCode]) {
        if (value != null && value !== transfer.transferCode) {
          FinancialObligationService.fail(
            "Withdrawal reversal contains a conflicting Transfer code.",
            "FINANCIAL_OBLIGATION_REVERSAL_CODE_MISMATCH"
          );
        }
      }

      /* ---------- EXISTING REVERSAL PROTECTION ---------- */

      const reversalKey = `withdrawal-reversal:${withdrawal._id}`;

      const existingCredit = await Transaction.findOne({
        $or: [
          {
            idempotencyKey: reversalKey,
          },
          {
            relatedTransaction: withdrawal._id,
            type: "withdrawal_reversal",
          },
        ],
      }).session(session);

      if (existingCredit || withdrawal.metadata?.reversalTransactionId) {
        FinancialObligationService.fail(
          "Withdrawal reversal already has a ledger credit.",
          "FINANCIAL_OBLIGATION_REVERSAL_ALREADY_CREDITED"
        );
      }

      /* ---------- RECORD OBLIGATION ---------- */

      const idempotencyKey = FinancialObligationService.buildWithdrawalReversalKey(withdrawal._id);

      const obligationResult = await FinancialObligationService.createOrGetObligation(
        {
          type: "closed_wallet_withdrawal_reversal",
          idempotencyKey,
          status: "open",

          ...ownership,

          wallet: wallet._id,
          dva: null,
          withdrawalTransaction: withdrawal._id,
          sourceProviderEvent: providerEvent._id,

          provider: "paystack",
          providerMode: transfer.domain,
          providerReference: transfer.reference,
          providerTransactionId: null,
          providerTransferCode: transfer.transferCode,
          providerStatus: "reversed",

          amount: withdrawal.amount,
          providerAmount: transfer.amount,
          providerFee: null,
          providerNetAmount: null,

          countryCode: withdrawal.countryCode,
          currency: withdrawal.currency,

          verifiedAt,
          verificationSource: "paystack_transfer_verification",

          providerEvidence: {
            ...transfer,

            providerEventRecordId: String(providerEvent._id),

            originalWithdrawalId: String(withdrawal._id),

            originalWalletDebit: withdrawal.amount,

            originalBankPayout: withdrawal.netAmount,
          },

          settlement: null,
        },
        session
      );

      /* ---------- PERSIST FINANCIAL DISPOSITION ---------- */

      await FinancialObligationService.linkWithdrawalFinancialObligation(
        {
          withdrawal,
          obligation: obligationResult.obligation,
        },
        session
      );

      return obligationResult;
    });
  }

  /* ---------- HISTORICAL COMMERCIAL RECEIPTS ---------- */

  static async recordHistoricalCommercialPayment(
    { kind, paymentId, verifiedPayment, providerEventId = null, currentTime = new Date() },
    options = {}
  ) {
    const session = options.session;
    this.assertActiveFinancialTransaction(session);

    if (!["subscription", "job_publication"].includes(kind)) {
      throw new Error("Unsupported commercial payment kind.");
    }

    const isSubscription = kind === "subscription";
    const PaymentModel = isSubscription ? SubscriptionPayment : JobPayment;
    const purpose = isSubscription ? "subscription_payment" : "job_publication_purchase";
    const payment = await PaymentModel.findById(
      this.normalizeObjectId(paymentId, "Commercial payment ID")
    ).session(session);

    if (!payment) {
      this.fail("Original commercial payment was not found.", "COMMERCIAL_PAYMENT_NOT_FOUND");
    }

    // Share the business write fence with closure and payment preparation.
    const business = await EmployerProfile.findOneAndUpdate(
      {
        _id: payment.business,
        accountStatus: { $in: ["active", "restricted", "suspended", "closing", "closed"] },
      },
      { $inc: { __v: 1 } },
      { session, new: true, timestamps: false }
    ).select("_id accountStatus");

    const transaction = await Transaction.findById(payment.paymentTransaction).session(session);
    const wallet = transaction
      ? await this.getOriginalWallet(transaction.wallet, session)
      : null;

    const reference = this.cleanString(verifiedPayment?.reference);
    const mode = verifiedPayment?.domain;
    const providerTransactionId = String(verifiedPayment?.id || "");
    const amount = verifiedPayment?.amount;
    const currency = verifiedPayment?.currency;
    const fee = verifiedPayment?.fees ?? null;

    this.assertProviderMode(mode);
    this.assertPositiveAmount(amount, "Verified commercial amount");

    if (fee != null) {
      this.assertNonNegativeAmount(fee, "Commercial provider fee");
      if (fee > amount) {
        this.fail("Invalid provider fee.", "COMMERCIAL_PAYMENT_FEE_INVALID");
      }
    }

    const paymentMetadataId = isSubscription ? "subscriptionPaymentId" : "jobPaymentId";
    const localReference = isSubscription ? "paymentReference" : "purchaseReference";
    const snapshot = payment.planSnapshot;

    if (
      !business ||
      !transaction ||
      !wallet ||
      !snapshot ||
      verifiedPayment.status !== "success" ||
      mode !== PaystackService.getMode() ||
      !/^[1-9]\d*$/.test(providerTransactionId) ||
      !reference ||
      payment.paymentProvider !== "paystack" ||
      !["paystack_checkout", ...(isSubscription ? ["paystack_authorization"] : [])]
        .includes(payment.paymentMethod) ||
      reference !== payment.providerReference ||
      reference !== transaction.paystackReference ||
      transaction.provider !== "paystack" ||
      transaction.direction !== "credit" ||
      transaction.paymentRail !== "paystack_checkout" ||
      transaction.type !== purpose ||
      transaction.purpose !== purpose ||
      (transaction.metadata?.paystackMode && transaction.metadata.paystackMode !== mode) ||
      !this.sameId(transaction.metadata?.[paymentMetadataId], payment._id) ||
      !this.sameId(transaction.metadata?.employerProfileId, payment.business) ||
      transaction.metadata?.[localReference] !== payment[localReference] ||
      amount !== transaction.amount ||
      amount !== snapshot.priceMinor ||
      currency !== transaction.currency ||
      currency !== snapshot.currency ||
      transaction.countryCode !== snapshot.countryCode ||
      wallet.ownerType !== "platform" ||
      wallet.currency !== currency ||
      wallet.countryCode !== transaction.countryCode
    ) {
      this.fail("Verified receipt conflicts with its original purchase.", "COMMERCIAL_PAYMENT_MISMATCH");
    }

    const idempotencyKey = [
      "financial-obligation", "paystack", mode, "commercial-payment", reference,
    ].join(":");

    const previous = await FinancialObligation.findOne({ idempotencyKey }).session(session);

    // Already credited receipts require a different accounting disposition.
    // Never create a second liability or reopen a completed purchase here.
    if (
      !previous &&
      (
        !["pending", "failed", "cancelled"].includes(payment.paymentStatus) ||
        !["pending", "processing", "failed", "cancelled"].includes(transaction.status) ||
        (payment.paymentStatus === "pending" &&
          !["closing", "closed"].includes(business.accountStatus))
      )
    ) {
      this.fail("Receipt is not eligible for historical uncredited reconciliation.",
        "COMMERCIAL_PAYMENT_DISPOSITION_INVALID");
    }

    let event = null;
    if (providerEventId) {
      event = await ProviderEventService.getProviderEventById(providerEventId, { session });

      if (
        event.provider !== "paystack" ||
        event.isVerified !== true ||
        event.eventName !== "charge.success" ||
        event.eventCategory !== purpose ||
        event.providerReference !== reference ||
        event.amount !== amount ||
        event.currency !== currency ||
        event.countryCode !== transaction.countryCode ||
        (event.employer && !this.sameId(event.employer, payment.business)) ||
        (event.transaction && !this.sameId(event.transaction, transaction._id)) ||
        (event.normalizedPayload?.domain && event.normalizedPayload.domain !== mode)
      ) {
        this.fail("Provider event conflicts with the commercial receipt.",
          "COMMERCIAL_PAYMENT_EVENT_MISMATCH");
      }
    }

    return this.createOrGetObligation({
      type: "historical_commercial_payment",
      idempotencyKey,
      status: "review_required",
      ownerType: "employer",
      employer: payment.business,
      professional: null,
      wallet: wallet._id,
      dva: null,
      withdrawalTransaction: null,
      commercialTransaction: transaction._id,
      subscriptionPayment: isSubscription ? payment._id : null,
      jobPayment: isSubscription ? null : payment._id,
      sourceProviderEvent: event?._id || null,
      provider: "paystack",
      providerMode: mode,
      providerReference: reference,
      providerTransactionId,
      providerTransferCode: null,
      providerStatus: "success",
      amount,
      providerAmount: amount,
      providerFee: fee,
      providerNetAmount: fee == null ? null : amount - fee,
      countryCode: transaction.countryCode,
      currency,
      verifiedAt: this.normalizeCurrentTime(currentTime),
      verificationSource: "paystack_transaction_verification",
      providerEvidence: {
        reference,
        transactionId: providerTransactionId,
        domain: mode,
        status: "success",
        amount,
        currency,
        paidAt: verifiedPayment.paidAt || null,
        originalPaymentStatus: payment.paymentStatus,
        originalTransactionStatus: transaction.status,
        originalBusinessStatus: business.accountStatus,
      },
      reviewReason: "Verified commercial receipt without usable purchase entitlement.",
      settlement: null,
    }, session);
  }

  /* ---------- REVIEW LIFECYCLE ---------- */

  static async markReviewRequired({ financialObligationId, reviewReason }, options = {}) {
    const reason = FinancialObligationService.cleanString(reviewReason);

    if (!reason || reason.length > 1000) {
      throw new Error("A valid financial obligation review reason is required.");
    }

    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const obligation = await FinancialObligationService.getObligationById(financialObligationId, {
        session,
      });

      if (obligation.status === "settled") {
        FinancialObligationService.fail(
          "A settled obligation cannot return to review.",
          "FINANCIAL_OBLIGATION_ALREADY_SETTLED"
        );
      }

      if (obligation.status === "review_required" && obligation.reviewReason === reason) {
        return {
          obligation,
          idempotent: true,
        };
      }

      obligation.status = "review_required";
      obligation.reviewReason = reason;

      await obligation.save({ session });

      return {
        obligation,
        idempotent: false,
      };
    });
  }

  /* ---------- OUTSTANDING LIABILITY LOOKUP ---------- */

  static async hasOutstandingObligations(
    { employerProfileId = null, professionalProfileId = null, walletId = null, dvaId = null } = {},
    options = {}
  ) {
    const ownership = {};

    for (const [field, value] of [
      ["employer", employerProfileId],
      ["professional", professionalProfileId],
      ["wallet", walletId],
      ["dva", dvaId],
    ]) {
      if (value != null) {
        ownership[field] = FinancialObligationService.normalizeObjectId(value, field);
      }
    }

    if (!Object.keys(ownership).length) {
      throw new Error("An original ownership reference is required.");
    }

    if (ownership.employer && ownership.professional) {
      throw new Error("Financial obligation lookup cannot combine different owner types.");
    }

    const query = FinancialObligation.exists({
      ...ownership,

      status: {
        $in: ["open", "review_required"],
      },
    });

    if (options.session) {
      query.session(options.session);
    }

    return Boolean(await query);
  }
}

module.exports = FinancialObligationService;
