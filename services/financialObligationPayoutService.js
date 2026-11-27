// services/financialObligationPayoutService.js

const FinancialObligation = require("../models/FinancialObligation");
const Transaction = require("../models/Transaction");
const Wallet = require("../models/Wallet");

const PaystackService = require("./paystackService");
const PaystackTransferService = require("./paystackTransferService");
const FinancialObligationService = require("./financialObligationService");
const RefundService = require("./financialObligationRefundService");
const ProviderEventService = require("./providerEventService");

class FinancialObligationPayoutService {
  static fail(message, statusCode = 409) {
    throw Object.assign(new Error(message), {
      statusCode,
      retryable: statusCode >= 500,
    });
  }

  static sameId(a, b) {
    return Boolean(a && b && String(a) === String(b));
  }

  static async getObligation(id) {
    return FinancialObligationService.getObligationById(id);
  }

  static assertPayable(o) {
    if (
      o.type !== "closed_wallet_withdrawal_reversal" ||
      o.provider !== "paystack" ||
      o.providerStatus !== "reversed" ||
      o.providerMode !== PaystackService.getMode() ||
      o.refundExecution ||
      !Number.isSafeInteger(o.amount) ||
      o.amount <= 0 ||
      !o.withdrawalTransaction
    ) {
      this.fail("Financial obligation is not eligible for historical payout.");
    }
  }

  static async getHistoricalContext(o, session = null) {
    this.assertPayable(o);

    const withdrawal = await Transaction.findById(o.withdrawalTransaction).session(session);

    FinancialObligationService.assertCompletedWithdrawal(withdrawal);

    const wallet = await Wallet.findById(o.wallet).session(session);

    const metadata = withdrawal.metadata || {};

    const owner = PaystackTransferService.getWithdrawalOwnerContext(withdrawal);

    const ownerId = o.employer || o.professional;

    const expectedOwner =
      o.ownerType === "employer" ? owner.employerProfileId : owner.professionalProfileId;

    const recipient = metadata.paystackRecipientCode;

    if (
      !wallet ||
      wallet.status !== "closed" ||
      wallet.ownerType !== o.ownerType ||
      owner.ownerType !== o.ownerType ||
      !this.sameId(wallet[o.ownerType], ownerId) ||
      !this.sameId(expectedOwner, ownerId) ||
      !this.sameId(withdrawal.wallet, wallet._id) ||
      wallet.countryCode !== o.countryCode ||
      wallet.currency !== o.currency ||
      withdrawal.currency !== o.currency ||
      withdrawal.countryCode !== o.countryCode ||
      withdrawal.amount !== o.amount ||
      PaystackTransferService.getPayoutAmount(withdrawal) !== o.providerAmount ||
      withdrawal.paystackTransferReference !== o.providerReference ||
      withdrawal.paystackTransferCode !== o.providerTransferCode ||
      metadata.paystackMode !== o.providerMode ||
      metadata.providerReversalStatus !== "reversed" ||
      metadata.providerReversalDisposition !== "financial_obligation" ||
      !this.sameId(metadata.financialObligationId, o._id) ||
      metadata.reversalTransactionId ||
      !recipient ||
      o.providerEvidence?.recipientCode !== recipient ||
      (o.payoutExecution && o.payoutExecution.recipientCode !== recipient)
    ) {
      this.fail("Historical payout ownership or recipient is inconsistent.");
    }

    const existingCredit = await Transaction.exists({
      $or: [
        { idempotencyKey: "withdrawal-reversal:" + String(withdrawal._id) },
        { relatedTransaction: withdrawal._id, type: "withdrawal_reversal" },
      ],
    }).session(session);

    if (existingCredit) {
      this.fail("Historical reversal already has a wallet credit.");
    }

    return { withdrawal, wallet, recipient };
  }

  static assertOutcome(o, outcome) {
    const execution = o.payoutExecution;

    if (
      !execution ||
      outcome.domain !== o.providerMode ||
      outcome.reference !== execution.reference ||
      outcome.amount !== o.amount ||
      outcome.currency !== o.currency ||
      outcome.recipientCode !== execution.recipientCode ||
      !outcome.transferCode ||
      outcome.transferCode === o.providerTransferCode ||
      (execution.transferCode && execution.transferCode !== outcome.transferCode) ||
      !["pending", "otp", "success", "failed", "reversed"].includes(outcome.status)
    ) {
      this.fail("Replacement Transfer verification does not match the obligation.");
    }
  }

  static isConclusiveFailure(outcome) {
    return ["failed", "reversed", "abandoned", "blocked", "rejected"].includes(outcome.rawStatus);
  }

  static async authorizeAndPay({ obligationId, adminId, reason, retry = false }) {
    await RefundService.assertAdmin(adminId);

    reason = typeof reason === "string" ? reason.trim() : "";

    if (!reason || reason.length > 1000) {
      this.fail("Payout reason is required.", 400);
    }

    const original = await this.getObligation(obligationId);

    if (!retry && (original.status === "settled" || original.payoutExecution)) {
      return original;
    }

    let priorOutcome = null;

    if (retry) {
      if (original.status === "settled" || !original.payoutExecution ||
          !["failed", "reversed"].includes(original.payoutExecution.state)) {
        this.fail("Reconcile the previous payout to a definitive failure or reversal first.");
      }

      const priorTransfer = await PaystackService.verifyTransfer(original.payoutExecution.reference);
      priorOutcome = PaystackTransferService.normalizeTransferOutcome(priorTransfer);
      this.assertOutcome(original, priorOutcome);

      if (!this.isConclusiveFailure(priorOutcome) ||
          priorOutcome.status !== original.payoutExecution.state) {
        this.fail("Previous payout has not been conclusively resolved.");
      }
    }

    const originalContext = await this.getHistoricalContext(original);

    // Independently confirm the original reversal before authorizing a payout.
    const originalTransfer = await PaystackService.verifyTransfer(original.providerReference);

    FinancialObligationService.assertVerifiedWithdrawalReversal(
      originalContext.withdrawal,
      originalTransfer
    );

    const claim = await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      const admin = await RefundService.assertAdmin(adminId, session);

      const o = await RefundService.lockObligation(obligationId, session);

      if (retry) {
        if (o.status === "settled" ||
            o.payoutExecution?.reference !== original.payoutExecution.reference ||
            o.payoutExecution?.state !== priorOutcome.status) {
          this.fail("Payout attempt changed. Reconcile before retrying.");
        }

        this.assertOutcome(o, priorOutcome);

        if (o.payoutExecutionHistory.length >= 98) {
          this.fail("Payout retry history limit reached.");
        }
      } else if (o.status === "settled" || o.payoutExecution) {
        return { obligation: o, dispatch: false };
      }

      const context = await this.getHistoricalContext(o, session);

      FinancialObligationService.assertVerifiedWithdrawalReversal(
        context.withdrawal,
        originalTransfer
      );

      if (retry) {
        o.payoutExecutionHistory.push(o.payoutExecution.toObject());
      }

      const count = o.payoutExecutionHistory.length;

      o.payoutExecution = {
        reference: "lq_obligation_" + String(o._id) + (count ? "_" + (count + 1) : ""),
        recipientCode: context.recipient,
        authorizedBy: admin._id,
        authorizedAt: new Date(),
        reason,
        state: "dispatching",
      };

      o.status = "review_required";
      o.reviewReason = "Authorized historical payout awaiting provider confirmation.";

      await o.save({ session });

      return { obligation: o, dispatch: true };
    });

    if (!claim.dispatch) return claim.obligation;

    const o = claim.obligation;

    try {
      // External provider execution happens after the durable authorization.
      await PaystackService.initiateTransfer({
        source: "balance",
        amount: o.amount,
        currency: o.currency,
        recipient: o.payoutExecution.recipientCode,
        reference: o.payoutExecution.reference,
        reason: "LOQUM historical withdrawal reversal resolution",
      });
    } catch (error) {
      await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
        const current = await RefundService.lockObligation(obligationId, session);

        if (current.payoutExecution.state === "dispatching") {
          current.payoutExecution.state = "uncertain";
          current.reviewReason =
            "Payout outcome uncertain. Reconcile the original reference; do not resend.";

          await current.save({ session });
        }
      });

      this.fail("Payout outcome uncertain. Reconcile; do not resend.", 503);
    }

    // The submission response alone cannot settle the obligation.
    return this.reconcile({ obligationId, adminId });
  }

  static async submitOtp({ obligationId, adminId, otp }) {
    await RefundService.assertAdmin(adminId);
    if (typeof otp !== "string" || !/^\d{4,10}$/.test(otp)) {
      this.fail("A valid provider OTP is required.", 400);
    }

    const original = await this.getObligation(obligationId);
    this.assertPayable(original);

    if (!original.payoutExecution || original.status === "settled") {
      this.fail("No outstanding payout requires OTP.");
    }

    const transfer = await PaystackService.verifyTransfer(original.payoutExecution.reference);
    const outcome = PaystackTransferService.normalizeTransferOutcome(transfer);
    this.assertOutcome(original, outcome);

    if (outcome.status !== "otp") {
      return this.applyOutcome({ obligationId, adminId, outcome });
    }

    await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      await RefundService.assertAdmin(adminId, session);
      const o = await RefundService.lockObligation(obligationId, session);
      await this.getHistoricalContext(o, session);
      this.assertOutcome(o, outcome);

      if (o.status === "settled" || o.payoutExecution.otpSubmittedAt ||
          !["otp", "dispatching", "uncertain", "pending"].includes(o.payoutExecution.state)) {
        this.fail("OTP already submitted or payout no longer eligible. Reconcile.");
      }

      o.payoutExecution.state = "otp";
      o.payoutExecution.transferCode = outcome.transferCode;
      o.payoutExecution.otpSubmittedAt = new Date();
      o.reviewReason = "OTP authorization submitted; awaiting provider outcome.";
      await o.save({ session });
    });

    try {
      await PaystackService.finalizeTransfer({
        transferCode: outcome.transferCode, otp,
      });
    } catch (_error) {
      this.fail("OTP submission outcome uncertain. Reconcile the same transfer.", 503);
    }

    return this.reconcile({ obligationId, adminId });
  }

  static async reconcile({ obligationId, adminId }) {
    await RefundService.assertAdmin(adminId);

    const o = await this.getObligation(obligationId);

    this.assertPayable(o);

    if (!o.payoutExecution) {
      this.fail("No authorized payout execution exists.");
    }

    const transfer = await PaystackService.verifyTransfer(o.payoutExecution.reference);

    const outcome = PaystackTransferService.normalizeTransferOutcome(transfer);

    this.assertOutcome(o, outcome);

    return this.applyOutcome({
      obligationId,
      adminId,
      outcome,
    });
  }

  static async reconcileFromProviderEvent({ providerEventRecordId, processingClaimId, reference }) {
    const obligation = await FinancialObligation.findOne({
      provider: "paystack",
      providerMode: PaystackService.getMode(),
      type: "closed_wallet_withdrawal_reversal",
      $or: [
        { "payoutExecution.reference": reference },
        { "payoutExecutionHistory.reference": reference },
      ],
    });

    if (!obligation) {
      this.fail("Historical payout obligation not found.", 503);
    }

    const transfer = await PaystackService.verifyTransfer(reference);

    const outcome = PaystackTransferService.normalizeTransferOutcome(transfer);

    const selected = obligation.payoutExecution?.reference === reference
      ? obligation.payoutExecution
      : obligation.payoutExecutionHistory.find(item => item.reference === reference);

    this.assertOutcome({ ...obligation.toObject(), payoutExecution: selected }, outcome);

    return this.applyOutcome({
      obligationId: obligation._id,
      outcome,
      eventContext: {
        providerEventRecordId,
        processingClaimId,
      },
    });
  }

  static async applyOutcome({ obligationId, adminId = null, outcome, eventContext = null }) {
    if (!adminId && !eventContext) {
      this.fail("Payout reconciliation authority required.", 403);
    }

    return ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      if (adminId) {
        await RefundService.assertAdmin(adminId, session);
      }

      const o = await RefundService.lockObligation(obligationId, session);

      const context = await this.getHistoricalContext(o, session);

      if (outcome.reference !== o.payoutExecution?.reference) {
        const previous = o.payoutExecutionHistory.find(item => item.reference === outcome.reference);

        if (!eventContext || !previous) {
          this.fail("Payout observation refers to a superseded attempt.", 503);
        }

        const historical = { ...o.toObject(), payoutExecution: previous };
        this.assertOutcome(historical, outcome);

        if (!this.isConclusiveFailure(outcome) || outcome.status !== previous.state) {
          this.fail("Archived payout outcome changed; investigate before further payment.", 503);
        }

        const event = await ProviderEventService.getProviderEventById(
          eventContext.providerEventRecordId, { session }
        );
        ProviderEventService.assertActiveProcessingClaim(event, eventContext.processingClaimId);
        this.assertEvent(event, historical, outcome, context);

        return this.completeEvent(event, o, outcome, context, session);
      }

      this.assertOutcome(o, outcome);

      const execution = o.payoutExecution;

      let event = null;

      if (eventContext) {
        event = await ProviderEventService.getProviderEventById(
          eventContext.providerEventRecordId,
          { session }
        );

        ProviderEventService.assertActiveProcessingClaim(event, eventContext.processingClaimId);

        this.assertEvent(event, o, outcome, context);
      }

      // Never let an older success observation overwrite a confirmed reversal.
      if (execution.state === "reversed" && outcome.status !== "reversed") {
        this.fail("Provider observation conflicts with a recorded payout reversal.", 503);
      }

      if (execution.state === "success" && !["success", "reversed"].includes(outcome.status)) {
        this.fail("Provider observation conflicts with a verified successful payout.", 503);
      }

      if (execution.state === "failed" && ["pending", "otp"].includes(outcome.status)) {
        this.fail("Provider observation conflicts with a terminal payout failure.", 503);
      }

      execution.transferCode = outcome.transferCode;
      execution.lastCheckedAt = new Date();
      execution.state = outcome.status;

      if (outcome.status === "success") {
        if (o.status !== "settled") {
          o.status = "settled";
          o.reviewReason = null;

          o.settlement = {
            method: "paystack_transfer",
            reference: execution.reference,
            providerRefundId: null,
            amount: o.amount,
            currency: o.currency,
            confirmedAt: new Date(),
            confirmedBy: execution.authorizedBy,
            evidence: {
              transferCode: outcome.transferCode,
              providerTransferId: outcome.providerTransferId,
              recipientCode: execution.recipientCode,
              originalWithdrawalId: String(o.withdrawalTransaction),
              originalTransferReference: o.providerReference,
              reference: execution.reference,
              status: "success",
              domain: outcome.domain,
              amount: outcome.amount,
              currency: outcome.currency,
            },
          };
        }
      } else {
        if (outcome.status === "reversed" && o.status === "settled") {
          execution.previousSettlement = o.settlement.toObject();
          o.settlement = null;
        }

        o.status = "review_required";
        o.reviewReason =
          "Replacement payout status: " + outcome.status + ". Reconcile before further payment.";
      }

      await o.save({ session });

      if (!event) return o;

      return this.completeEvent(event, o, outcome, context, session);
    });
  }

  static assertEvent(event, o, outcome, context) {
    const payload = event.normalizedPayload || {};

    const expected = {
      "transfer.success": ["success", "reversed"],
      "transfer.failed": ["failed", "reversed"],
      "transfer.reversed": ["reversed"],
    };

    if (
      event.provider !== "paystack" ||
      event.isVerified !== true ||
      event.eventCategory !== "transfer_unresolved" ||
      !expected[event.eventName] ||
      event.providerReference !== o.payoutExecution.reference ||
      event.amount !== o.amount ||
      event.currency !== o.currency ||
      event.countryCode !== o.countryCode ||
      (payload.domain && payload.domain !== o.providerMode) ||
      (payload.recipientCode && payload.recipientCode !== o.payoutExecution.recipientCode) ||
      (payload.transferCode && payload.transferCode !== outcome.transferCode) ||
      (payload.paystackTransferCode && payload.paystackTransferCode !== outcome.transferCode) ||
      (payload.transferReference && payload.transferReference !== outcome.reference) ||
      (payload.paystackTransferReference &&
        payload.paystackTransferReference !== outcome.reference) ||
      event.dva ||
      event.shift ||
      event.shiftApplication ||
      event.employerRefundBatch ||
      event.employerRefundBatchLineId ||
      event.providerRefundId ||
      event.providerRefundReference
    ) {
      this.fail("Historical payout event has conflicting provider identity.");
    }

    if (!expected[event.eventName].includes(outcome.status)) {
      this.fail("Provider verification has not confirmed the webhook outcome.", 503);
    }

    for (const [field, value] of Object.entries({
      financialObligation: o._id,
      transaction: context.withdrawal._id,
      wallet: o.wallet,
      bankAccount: context.withdrawal.bankAccount,
      employer: o.employer || null,
      professional: o.professional || null,
    })) {
      if (event[field] && !this.sameId(event[field], value)) {
        this.fail("Payout event conflicts with historical " + field + ".");
      }
    }
  }

  static async completeEvent(event, o, outcome, context, session) {
    event.eventCategory = "financial_obligation_payout";
    event.financialObligation = o._id;
    event.transaction = context.withdrawal._id;
    event.wallet = o.wallet;
    event.bankAccount = context.withdrawal.bankAccount;
    event.employer = o.employer || null;
    event.professional = o.professional || null;

    event.normalizedPayload = {
      ...(event.normalizedPayload || {}),
      financialObligationId: String(o._id),
      historicalPayoutVerified: true,
      verifiedPayoutStatus: outcome.status,
      payoutReference: outcome.reference,
      payoutTransferCode: outcome.transferCode,
    };

    event.metadata = {
      ...(event.metadata || {}),
      historicalFinancialObligationPayout: true,
      verifiedPayoutStatus: outcome.status,
    };

    event.status = "processed";
    event.processedAt = new Date(Math.max(Date.now(), event.lastProcessingStartedAt.getTime()));
    event.processingClaimId = null;
    event.failedAt = null;
    event.failureReason = null;
    event.ignoredAt = null;
    event.ignoredReason = null;
    event.nextRetryAt = null;

    await event.save({ session });

    return {
      providerEvent: event,
      financialObligation: o,
      processed: true,
      payoutStatus: outcome.status,
    };
  }
}

module.exports = FinancialObligationPayoutService;
