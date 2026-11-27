// services/financialObligationRefundService.js

const FinancialObligation = require("../models/FinancialObligation");
const User = require("../models/User");
const DVA = require("../models/DVA");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const EmployerProfile = require("../models/EmployerProfile");
const SubscriptionPayment = require("../models/SubscriptionPayment");
const JobPayment = require("../models/JobPayment");
const PaystackService = require("./paystackService");
const ProviderEventService = require("./providerEventService");
const FinancialObligationService = require("./financialObligationService");
const WalletFundingService = require("./walletFundingService");

class FinancialObligationRefundService {
  static fail(message, statusCode = 409) {
    throw Object.assign(new Error(message), { statusCode });
  }

  static sameId(a, b) {
    return Boolean(a && b && String(a) === String(b));
  }

  static async assertAdmin(adminId, session = null) {
    const id = FinancialObligationService.normalizeObjectId(adminId, "Admin ID");
    const admin = await User.findOne({
      _id: id,
      role: "admin",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .session(session);
    if (!admin) this.fail("Active verified admin required.", 403);
    return admin;
  }

  static assertRefundable(o) {
    if (
      !["retired_dva_funding", "historical_commercial_payment"].includes(o.type) ||
      o.provider !== "paystack" ||
      o.providerStatus !== "success" ||
      o.providerMode !== PaystackService.getMode() ||
      !/^[1-9]\d*$/.test(o.providerTransactionId || "") ||
      !Number.isSafeInteger(o.amount) ||
      o.amount <= 0 ||
      o.amount !== o.providerAmount
    ) {
      this.fail("Obligation is not eligible for an incoming-payment refund.");
    }
  }

  static async lockObligation(id, session) {
    const o = await FinancialObligation.findOneAndUpdate(
      { _id: FinancialObligationService.normalizeObjectId(id, "Obligation ID") },
      { $inc: { __v: 1 } },
      { session, new: true, timestamps: false }
    );
    if (!o) this.fail("Financial obligation not found.", 404);
    return o;
  }

  static async assertUncredited(o, session) {
    if (o.type === "retired_dva_funding") {
      await WalletFundingService.lockDVAFundingDisposition(
        {
          dvaId: o.dva,
          employerProfileId: o.employer,
        },
        session
      );

      const dva = await DVA.findById(o.dva).session(session);
      const wallet = await Wallet.findById(o.wallet).session(session);

      if (
        !dva ||
        !wallet ||
        !["retiring", "deactivated"].includes(dva.status) ||
        !this.sameId(dva.employer, o.employer) ||
        !this.sameId(dva.wallet, o.wallet) ||
        wallet.ownerType !== "employer" ||
        !this.sameId(wallet.employer, o.employer) ||
        wallet.currency !== o.currency ||
        wallet.countryCode !== o.countryCode ||
        (await Transaction.exists({
          provider: "paystack",
          paystackReference: o.providerReference,
        }).session(session))
      ) {
        this.fail("Historical DVA payment disposition requires review.");
      }

      return;
    }

    const business = await EmployerProfile.findOneAndUpdate(
      {
        _id: o.employer,
        accountStatus: { $in: ["active", "restricted", "suspended", "closing", "closed"] },
      },
      { $inc: { __v: 1 } },
      { session, new: true, timestamps: false }
    );

    const receipt = await Transaction.findById(o.commercialTransaction).session(session);
    const wallet = await Wallet.findById(o.wallet).session(session);
    const Model = o.subscriptionPayment ? SubscriptionPayment : JobPayment;
    const payment = await Model.findById(o.subscriptionPayment || o.jobPayment).session(session);
    const purpose = o.subscriptionPayment ? "subscription_payment" : "job_publication_purchase";

    if (
      !business ||
      !receipt ||
      !wallet ||
      !payment ||
      wallet.ownerType !== "platform" ||
      !this.sameId(receipt.wallet, o.wallet) ||
      wallet.currency !== o.currency ||
      wallet.countryCode !== o.countryCode ||
      receipt.provider !== "paystack" ||
      receipt.paystackReference !== o.providerReference ||
      receipt.purpose !== purpose ||
      receipt.type !== purpose ||
      receipt.direction !== "credit" ||
      !["pending", "processing", "failed", "cancelled"].includes(receipt.status) ||
      receipt.amount !== o.amount ||
      receipt.currency !== o.currency ||
      receipt.countryCode !== o.countryCode ||
      !this.sameId(payment.business, o.employer) ||
      !this.sameId(payment.paymentTransaction, receipt._id) ||
      payment.providerReference !== o.providerReference ||
      !["pending", "failed", "cancelled"].includes(payment.paymentStatus) ||
      (payment.paymentStatus === "pending" &&
        !["closing", "closed"].includes(business.accountStatus))
    ) {
      this.fail("Commercial receipt is no longer eligible for uncredited reconciliation.");
    }
  }

  static assertRefundIdentity(o, refund) {
    if (
      !refund ||
      !/^[1-9]\d*$/.test(refund.id || "") ||
      refund.amount !== o.amount ||
      refund.currency !== o.currency ||
      (refund.domain && refund.domain !== o.providerMode) ||
      (!refund.transaction?.id && !refund.transaction?.reference) ||
      (refund.transaction?.id && refund.transaction.id !== o.providerTransactionId) ||
      (refund.transaction?.reference && refund.transaction.reference !== o.providerReference) ||
      (o.refundExecution?.providerRefundId && refund.id !== o.refundExecution.providerRefundId)
    ) {
      this.fail("Provider refund identity does not match the obligation.");
    }
  }

  static async getObligation(id) {
    return FinancialObligationService.getObligationById(id);
  }

  static async authorizeAndRefund({ obligationId, adminId, reason }) {
    await this.assertAdmin(adminId);

    reason = typeof reason === "string" ? reason.trim() : "";
    if (!reason || reason.length > 1000) {
      this.fail("Refund reason is required.", 400);
    }

    const original = await this.getObligation(obligationId);

    if (original.status === "settled" || original.refundExecution) {
      return original;
    }

    this.assertRefundable(original);

    // Provider reads before any dispatch. Never create a refund if one already exists.
    const verified = await PaystackService.verifyTransaction(original.providerReference);

    if (
      verified.status !== "success" ||
      verified.domain !== original.providerMode ||
      verified.id !== original.providerTransactionId ||
      verified.amount !== original.amount ||
      verified.currency !== original.currency
    ) {
      this.fail("Original payment verification did not match.");
    }

    const existing = await PaystackService.listRefunds({
      transaction: original.providerTransactionId,
      perPage: 50,
      page: 1,
    });

    if (
      existing.refunds.length ||
      (existing.meta?.pageCount != null && existing.meta.pageCount > 1) ||
      (existing.meta?.total != null && existing.meta.total > 0)
    ) {
      this.fail("A provider refund already exists. Review before any new dispatch.");
    }

    const claim = await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      const admin = await this.assertAdmin(adminId, session);
      const o = await this.lockObligation(obligationId, session);

      if (o.status === "settled" || o.refundExecution) {
        return { o, dispatch: false };
      }

      this.assertRefundable(o);
      await this.assertUncredited(o, session);

      o.refundExecution = {
        traceKey: "financial-obligation-refund:" + String(o._id),
        authorizedBy: admin._id,
        authorizedAt: new Date(),
        reason,
        state: "dispatching",
      };

      o.status = "review_required";
      o.reviewReason = "Admin-authorized refund awaiting provider confirmation.";

      await o.save({ session });

      return { o, dispatch: true };
    });

    if (!claim.dispatch) return claim.o;

    try {
      const refund = await PaystackService.createRefund({
        transaction: claim.o.providerTransactionId,
        amount: claim.o.amount,
        currency: claim.o.currency,
        idempotencyKey: claim.o.refundExecution.traceKey,
        merchantNote: "LOQUM historical payment refund",
      });

      this.assertRefundIdentity(claim.o, refund);

      await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
        const o = await this.lockObligation(obligationId, session);

        this.assertRefundIdentity(o, refund);

        if (o.status === "settled") return;

        o.refundExecution.providerRefundId = refund.id;

        // Do not settle based on the creation response.
        if (["dispatching", "uncertain"].includes(o.refundExecution.state)) {
          o.refundExecution.state = "processing";
        }

        await o.save({ session });
      });
    } catch (error) {
      await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
        const o = await this.lockObligation(obligationId, session);

        if (o.status !== "settled" && o.refundExecution.state === "dispatching") {
          o.refundExecution.state = "uncertain";
          o.reviewReason =
            "Refund dispatch outcome uncertain. Reconcile with Paystack; do not resend.";

          await o.save({ session });
        }
      });

      this.fail("Refund outcome requires provider reconciliation. Do not resend.", 503);
    }

    return this.reconcile({ obligationId, adminId });
  }

  static async recoverExistingRefund({ obligationId, adminId, refundId, reason }) {
    await this.assertAdmin(adminId);
    reason = typeof reason === "string" ? reason.trim() : "";
    if (!reason || reason.length > 1000 ||
        typeof refundId !== "string" || !/^[1-9]\d*$/.test(refundId)) {
      this.fail("A refund ID and recovery reason are required.", 400);
    }

    const original = await this.getObligation(obligationId);
    this.assertRefundable(original);

    if (original.refundExecution?.providerRefundId) {
      if (original.refundExecution.providerRefundId !== refundId) {
        this.fail("Reconcile the original refund ID; a different refund cannot replace it.");
      }
      return this.reconcile({ obligationId, adminId });
    }

    const verified = await PaystackService.fetchRefund(refundId);
    this.assertRefundIdentity(original, verified);

    if (verified.id !== refundId || verified.domain !== original.providerMode) {
      this.fail("Refund ID or environment could not be verified.");
    }

    const listed = await PaystackService.listRefunds({
      transaction: original.providerTransactionId, perPage: 50, page: 1,
    });

    if (listed.refunds.length !== 1 || listed.refunds[0].id !== refundId ||
        (listed.meta?.pageCount != null && Number(listed.meta.pageCount) > 1) ||
        (listed.meta?.total != null && Number(listed.meta.total) !== 1)) {
      this.fail("Multiple or inconsistent provider refunds require manual investigation.");
    }

    const hasTrace = (execution) => String(verified.merchantNote || "")
      .split("|").map(part => part.trim()).includes("key=" + execution.traceKey);

    if (original.refundExecution && !hasTrace(original.refundExecution)) {
      this.fail("An uncertain original refund exists. Confirm its trace before adoption.");
    }

    await ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      const admin = await this.assertAdmin(adminId, session);
      const o = await this.lockObligation(obligationId, session);
      this.assertRefundable(o);
      this.assertRefundIdentity(o, verified);

      if (o.status === "settled" || o.refundExecution?.providerRefundId) {
        if (o.refundExecution?.providerRefundId !== refundId) {
          this.fail("Refund identity changed during recovery.");
        }
        return;
      }

      await this.assertUncredited(o, session);

      if (o.refundExecution && !hasTrace(o.refundExecution)) {
        this.fail("Original refund dispatch is unresolved.");
      }

      if (!o.refundExecution) {
        o.refundExecution = {
          traceKey: "financial-obligation-refund:" + String(o._id),
          authorizedBy: admin._id,
          authorizedAt: new Date(),
          reason,
          state: "processing",
        };
      }

      o.refundExecution.providerRefundId = refundId;
      o.refundExecution.state = "processing";
      o.status = "review_required";
      o.reviewReason = "Existing Paystack refund linked for verification.";

      await o.save({ session });
    });

    // No refund POST is issued by recovery.
    return this.reconcile({ obligationId, adminId });
  }

  static async reconcile({ obligationId, adminId }) {
    await this.assertAdmin(adminId);

    const original = await this.getObligation(obligationId);

    if (original.status === "settled") return original;

    this.assertRefundable(original);

    if (!original.refundExecution) {
      this.fail("No authorized refund execution exists.");
    }

    let refundId = original.refundExecution.providerRefundId;

    if (!refundId) {
      const result = await PaystackService.findRefundByTraceKey({
        transaction: original.providerTransactionId,
        idempotencyKey: original.refundExecution.traceKey,
        currency: original.currency,
      });

      if (!result.found) return original;

      this.assertRefundIdentity(original, result.refund);
      refundId = result.refund.id;
    }

    const refund = await PaystackService.fetchRefund(refundId);

    this.assertRefundIdentity(original, refund);

    if (refund.id !== refundId) {
      this.fail("Refund verification ID mismatch.");
    }

    return this.applyVerifiedRefund({ obligationId, adminId, refund });
  }

  static async reconcileFromProviderEvent({
    obligationId,
    providerRefundId,
    providerEventRecordId,
    processingClaimId,
  }) {
    const original = await this.getObligation(obligationId);
    this.assertRefundable(original);

    const execution = original.refundExecution;

    if (!execution) this.fail("No authorized refund execution exists.");

    const id = providerRefundId || execution.providerRefundId;

    if (!id) this.fail("Refund ID not yet available; reconcile later.", 503);

    const refund = await PaystackService.fetchRefund(id);
    this.assertRefundIdentity(original, refund);

    if (refund.id !== id) this.fail("Refund verification ID mismatch.");

    if (
      !execution.providerRefundId &&
      !String(refund.merchantNote || "")
        .split("|")
        .map((part) => part.trim())
        .includes("key=" + execution.traceKey)
    ) {
      this.fail("Unlinked provider refund lacks its authorized trace key.");
    }

    return this.applyVerifiedRefund({
      obligationId,
      refund,
      eventContext: { providerEventRecordId, processingClaimId },
    });
  }

  static async applyVerifiedRefund({ obligationId, adminId = null, refund, eventContext = null }) {
    if (!adminId && !eventContext) this.fail("Refund reconciliation authority required.", 403);

    const state = String(refund.status || "")
      .toLowerCase()
      .replace(/-/g, "_");

    if (!["pending", "processing", "needs_attention", "failed", "processed"].includes(state)) {
      this.fail("Unrecognized provider refund status.");
    }

    return ProviderEventService.runWithOptionalTransaction({}, async (session) => {
      if (adminId) await this.assertAdmin(adminId, session);

      const o = await this.lockObligation(obligationId, session);

      this.assertRefundIdentity(o, refund);

      const completeEvent = () =>
        ProviderEventService.markHistoricalRefundProcessed(
          {
            ...eventContext,
            obligation: o,
            refund,
          },
          session
        );

      if (!o.refundExecution) this.fail("No authorized refund execution exists.");

      if (o.status === "settled") {
        if (state !== "processed") this.fail("Provider status conflicts with settled refund.");
        return eventContext ? completeEvent() : o;
      }

      this.assertRefundable(o);
      await this.assertUncredited(o, session);

      o.refundExecution.providerRefundId = refund.id;
      o.refundExecution.state = state;
      o.refundExecution.lastCheckedAt = new Date();

      if (state === "processed") {
        o.status = "settled";
        o.reviewReason = null;

        o.settlement = {
          method: "paystack_refund",
          reference: "paystack-refund:" + refund.id,
          providerRefundId: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          confirmedAt: new Date(),
          confirmedBy: adminId || o.refundExecution.authorizedBy,
          evidence: {
            refundId: refund.id,
            originalReference: o.providerReference,
            transactionId: o.providerTransactionId,
            mode: o.providerMode,
            status: state,
            amount: refund.amount,
            currency: refund.currency,
            refundedAt: refund.refundedAt || null,
          },
        };
      } else {
        o.status = "review_required";
        o.reviewReason = "Paystack refund status: " + state + ". Do not resend.";
      }

      await o.save({ session });

      return eventContext ? completeEvent() : o;
    });
  }
}

module.exports = FinancialObligationRefundService;
