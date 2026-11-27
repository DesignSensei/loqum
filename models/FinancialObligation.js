// models/FinancialObligation.js

const mongoose = require("mongoose");

const {
  isPositiveSafeInteger,
  isNonNegativeSafeInteger,
  nonEmptyText,
} = require("./helpers/schemaValidators");

const {
  minorUnitAmountField,
  requiredPositiveMinorUnitAmountField,
  nullableReferenceField,
} = require("./helpers/schemaFields");

const OBLIGATION_TYPES = Object.freeze([
  "retired_dva_funding",
  "closed_wallet_withdrawal_reversal",
  "historical_commercial_payment",
]);

const OBLIGATION_STATUSES = Object.freeze(["open", "review_required", "settled"]);

const SETTLEMENT_METHODS = Object.freeze(["paystack_refund", "paystack_transfer", "verified_external_payment"]);

const preserveNumericType = (value) => {
  if (value != null && typeof value !== "number") {
    throw new TypeError("Financial amounts must be Numbers.");
  }

  return value;
};

const isEvidenceObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length);

/* ---------- SETTLEMENT EVIDENCE ---------- */

const settlementSchema = new mongoose.Schema(
  {
    method: {
      type: String,
      enum: SETTLEMENT_METHODS,
      required: true,
    },

    reference: {
      type: String,
      required: true,
      trim: true,
    },

    providerRefundId: {
      type: String,
      trim: true,
      default: null,
    },

    amount: {
      ...requiredPositiveMinorUnitAmountField("Settlement amount"),
      set: preserveNumericType,
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z]{3}$/,
    },

    confirmedAt: {
      type: Date,
      required: true,
    },

    confirmedBy: nullableReferenceField("User"),

    evidence: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      validate: {
        validator: isEvidenceObject,
        message: "Confirmed settlement evidence is required.",
      },
    },
  },
  {
    _id: false,
  }
);

const refundExecutionSchema = new mongoose.Schema({
  traceKey: { type: String, required: true },
  authorizedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  authorizedAt: { type: Date, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  state: {
    type: String,
    enum: ["dispatching", "uncertain", "pending", "processing", "needs_attention", "failed", "processed"],
    required: true,
  },
  providerRefundId: { type: String, default: null, match: /^[1-9]\d*$/ },
  lastCheckedAt: { type: Date, default: null },
}, { _id: false });

const payoutExecutionSchema = new mongoose.Schema({
  reference: { type: String, required: true },
  recipientCode: { type: String, required: true },
  authorizedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  authorizedAt: { type: Date, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  state: {
    type: String,
    enum: [
      "dispatching", "uncertain", "pending", "otp",
      "success", "failed", "reversed",
    ],
    required: true,
  },
  transferCode: { type: String, default: null },
  lastCheckedAt: { type: Date, default: null },
  otpSubmittedAt: { type: Date, default: null },
  previousSettlement: { type: settlementSchema, default: null },
}, { _id: false });

/* ---------- FINANCIAL OBLIGATION ---------- */

const financialObligationSchema = new mongoose.Schema(
  {
    /* ---------- IDENTITY ---------- */

    type: {
      type: String,
      enum: OBLIGATION_TYPES,
      required: true,
      immutable: true,
    },

    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },

    status: {
      type: String,
      enum: OBLIGATION_STATUSES,
      default: "open",
      required: true,
    },

    /* ---------- HISTORICAL OWNERSHIP ---------- */

    ownerType: {
      type: String,
      enum: ["employer", "professional"],
      required: true,
      immutable: true,
    },

    employer: {
      ...nullableReferenceField("EmployerProfile"),
      immutable: true,
    },

    professional: {
      ...nullableReferenceField("ProfessionalProfile"),
      immutable: true,
    },

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      immutable: true,
    },

    /* ---------- SOURCE RECORDS ---------- */

    dva: {
      ...nullableReferenceField("DVA"),
      immutable: true,
    },

    withdrawalTransaction: {
      ...nullableReferenceField("Transaction"),
      immutable: true,
    },

    commercialTransaction: {
      ...nullableReferenceField("Transaction"),
      immutable: true,
    },

    subscriptionPayment: {
      ...nullableReferenceField("SubscriptionPayment"),
      immutable: true,
    },

    jobPayment: {
      ...nullableReferenceField("JobPayment"),
      immutable: true,
    },

    sourceProviderEvent: {
      ...nullableReferenceField("ProviderEvent"),
      immutable: true,
    },

    /* ---------- PROVIDER IDENTITY ---------- */

    provider: {
      type: String,
      enum: ["paystack"],
      default: "paystack",
      required: true,
      immutable: true,
    },

    providerMode: {
      type: String,
      enum: ["test", "live"],
      required: true,
      immutable: true,
    },

    providerReference: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },

    providerTransactionId: {
      type: String,
      trim: true,
      default: null,
      match: /^[1-9]\d*$/,
      immutable: true,
    },

    providerTransferCode: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },

    providerStatus: {
      type: String,
      enum: ["success", "reversed"],
      required: true,
      immutable: true,
    },

    /* ---------- MONEY ---------- */

    amount: {
      ...requiredPositiveMinorUnitAmountField("Obligation amount"),
      set: preserveNumericType,
      immutable: true,
    },

    providerAmount: {
      ...requiredPositiveMinorUnitAmountField("Provider amount"),
      set: preserveNumericType,
      immutable: true,
    },

    providerFee: {
      ...minorUnitAmountField({
        defaultValue: null,
      }),
      set: preserveNumericType,
      immutable: true,
    },

    providerNetAmount: {
      ...minorUnitAmountField({
        defaultValue: null,
      }),
      set: preserveNumericType,
      immutable: true,
    },

    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z]{2}$/,
      immutable: true,
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z]{3}$/,
      immutable: true,
    },

    /* ---------- VERIFIED EVIDENCE ---------- */

    verifiedAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    verificationSource: {
      type: String,
      enum: ["paystack_transaction_verification", "paystack_transfer_verification"],
      required: true,
      immutable: true,
    },

    providerEvidence: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: isEvidenceObject,
        message: "Verified provider evidence is required.",
      },
    },

    /* ---------- REVIEW / SETTLEMENT ---------- */

    reviewReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    refundExecution: { type: refundExecutionSchema, default: null },

    payoutExecution: { type: payoutExecutionSchema, default: null },
    payoutExecutionHistory: { type: [payoutExecutionSchema], default: [] },

    settlement: {
      type: settlementSchema,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ---------- IDEMPOTENCY INDEXES ---------- */

financialObligationSchema.index({ idempotencyKey: 1 }, { unique: true });

financialObligationSchema.index(
  {
    provider: 1,
    providerMode: 1,
    type: 1,
    providerReference: 1,
  },
  {
    unique: true,
    name: "unique_financial_obligation_source",
  }
);

financialObligationSchema.index(
  {
    provider: 1,
    providerMode: 1,
    providerTransactionId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerTransactionId: {
        $type: "string",
      },
    },
    name: "unique_financial_obligation_provider_transaction",
  }
);

financialObligationSchema.index(
  {
    withdrawalTransaction: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      withdrawalTransaction: {
        $type: "objectId",
      },
    },
    name: "unique_financial_obligation_withdrawal",
  }
);

financialObligationSchema.index(
  {
    provider: 1,
    providerMode: 1,
    providerTransferCode: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerTransferCode: {
        $type: "string",
      },
    },
    name: "unique_financial_obligation_transfer",
  }
);

financialObligationSchema.index(
  { commercialTransaction: 1 },
  {
    unique: true,
    partialFilterExpression: {
      commercialTransaction: { $type: "objectId" },
    },
    name: "unique_financial_obligation_commercial_receipt",
  }
);

/* ---------- OWNERSHIP / REVIEW INDEXES ---------- */

financialObligationSchema.index({
  employer: 1,
  status: 1,
});

financialObligationSchema.index({
  professional: 1,
  status: 1,
});

financialObligationSchema.index({
  wallet: 1,
  status: 1,
});

financialObligationSchema.index({
  dva: 1,
  status: 1,
});

financialObligationSchema.index({
  sourceProviderEvent: 1,
});

financialObligationSchema.index({
  status: 1,
  createdAt: 1,
});

financialObligationSchema.index(
  { provider: 1, providerMode: 1, "refundExecution.providerRefundId": 1 },
  {
    unique: true,
    partialFilterExpression: { "refundExecution.providerRefundId": { $type: "string" } },
    name: "unique_financial_obligation_refund_execution",
  }
);

financialObligationSchema.index(
  { provider: 1, providerMode: 1, "payoutExecution.reference": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "payoutExecution.reference": { $type: "string" },
    },
    name: "unique_obligation_payout_reference",
  }
);

financialObligationSchema.index(
  { provider: 1, providerMode: 1, "payoutExecution.transferCode": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "payoutExecution.transferCode": { $type: "string" },
    },
    name: "unique_obligation_payout_transfer",
  }
);

/* ---------- SETTLEMENT INDEXES ---------- */

financialObligationSchema.index(
  {
    provider: 1,
    providerMode: 1,
    "settlement.providerRefundId": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "settlement.providerRefundId": {
        $type: "string",
      },
    },
    name: "unique_financial_obligation_refund",
  }
);

financialObligationSchema.index(
  {
    providerMode: 1,
    "settlement.method": 1,
    "settlement.reference": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "settlement.reference": {
        $type: "string",
      },
    },
    name: "unique_financial_obligation_settlement",
  }
);

/* ---------- ADMIN QUERY INDEXES ---------- */

financialObligationSchema.index(
  { providerMode: 1, _id: -1 },
  { name: "obligation_admin_cursor" }
);

financialObligationSchema.index(
  { providerMode: 1, status: 1, _id: -1 },
  { name: "obligation_admin_status_cursor" }
);

financialObligationSchema.index(
  { providerMode: 1, type: 1, _id: -1 },
  { name: "obligation_admin_type_cursor" }
);

financialObligationSchema.index(
  { providerMode: 1, currency: 1, _id: -1 },
  { name: "obligation_admin_currency_cursor" }
);

financialObligationSchema.index(
  { providerMode: 1, createdAt: -1, _id: -1 },
  { name: "obligation_admin_date_cursor" }
);

financialObligationSchema.index(
  { providerMode: 1, providerReference: 1 },
  { name: "obligation_admin_reference" }
);

/* ---------- VALIDATION ---------- */

financialObligationSchema.pre("validate", function () {
  const isDVAFunding = this.type === "retired_dva_funding";

  const isWithdrawalReversal = this.type === "closed_wallet_withdrawal_reversal";
  const isCommercial = this.type === "historical_commercial_payment";

  if (!isCommercial &&
      (this.commercialTransaction || this.subscriptionPayment || this.jobPayment)) {
    throw new Error("Non-commercial obligations cannot reference commercial payments.");
  }

  if (isCommercial) {
    if (
      this.ownerType !== "employer" ||
      !this.employer ||
      this.dva ||
      this.withdrawalTransaction ||
      !this.commercialTransaction ||
      Boolean(this.subscriptionPayment) === Boolean(this.jobPayment) ||
      !this.providerTransactionId ||
      this.providerTransferCode ||
      this.providerStatus !== "success" ||
      this.verificationSource !== "paystack_transaction_verification" ||
      this.amount !== this.providerAmount
    ) {
      throw new Error("Commercial obligation requires its original verified purchase and receipt.");
    }

    if (
      (this.providerFee == null) !== (this.providerNetAmount == null) ||
      (this.providerFee != null &&
        (this.providerFee > this.providerAmount ||
          this.providerNetAmount !== this.providerAmount - this.providerFee))
    ) {
      throw new Error("Commercial obligation provider amounts are inconsistent.");
    }
  }

  /* ---------- HISTORICAL OWNERSHIP ---------- */

  if (this.ownerType === "employer" && (!this.employer || this.professional)) {
    throw new Error("Employer obligation requires its original employer only.");
  }

  if (this.ownerType === "professional" && (!this.professional || this.employer)) {
    throw new Error("Professional obligation requires its original professional only.");
  }

  if (!this.wallet) {
    throw new Error("Financial obligation requires its original wallet.");
  }

  /* ---------- PROVIDER IDENTITY ---------- */

  for (const field of ["providerTransactionId", "providerTransferCode"]) {
    if (typeof this[field] === "string" && !nonEmptyText(this[field])) {
      this[field] = null;
    }
  }

  if (!nonEmptyText(this.providerReference)) {
    throw new Error("Financial obligation requires its original provider reference.");
  }

  /* ---------- FINANCIAL INTEGRITY ---------- */

  if (!isPositiveSafeInteger(this.amount)) {
    throw new Error("Financial obligation requires a positive amount.");
  }

  if (!isPositiveSafeInteger(this.providerAmount)) {
    throw new Error("Financial obligation requires a positive provider amount.");
  }

  for (const field of ["providerFee", "providerNetAmount"]) {
    if (this[field] != null && !isNonNegativeSafeInteger(this[field])) {
      throw new Error(`Financial obligation contains invalid ${field}.`);
    }
  }

  /* ---------- RETIRED DVA FUNDING ---------- */

  if (isDVAFunding) {
    if (
      this.ownerType !== "employer" ||
      !this.employer ||
      !this.dva ||
      this.withdrawalTransaction
    ) {
      throw new Error("Retired DVA funding requires its original employer and DVA.");
    }

    if (this.provider !== "paystack" || this.countryCode !== "NG" || this.currency !== "NGN") {
      throw new Error("Paystack DVA funding requires NG/NGN.");
    }

    if (
      !this.providerTransactionId ||
      this.providerTransferCode ||
      this.providerStatus !== "success"
    ) {
      throw new Error("Retired DVA funding requires a successful provider transaction.");
    }

    if (this.verificationSource !== "paystack_transaction_verification") {
      throw new Error("Retired DVA funding requires transaction verification.");
    }

    if (this.amount !== this.providerAmount) {
      throw new Error("DVA funding obligation must preserve the original payment amount.");
    }

    const hasFee = this.providerFee != null;

    const hasNetAmount = this.providerNetAmount != null;

    if (hasFee !== hasNetAmount) {
      throw new Error("DVA funding fee and net amount must be supplied together.");
    }

    if (
      hasFee &&
      (this.providerFee > this.providerAmount ||
        this.providerNetAmount !== this.providerAmount - this.providerFee)
    ) {
      throw new Error("DVA funding contains inconsistent provider amounts.");
    }
  }

  /* ---------- CLOSED-WALLET WITHDRAWAL REVERSAL ---------- */

  if (isWithdrawalReversal) {
    if (!this.withdrawalTransaction || this.dva) {
      throw new Error("Withdrawal reversal requires its original withdrawal transaction.");
    }

    if (
      !this.providerTransferCode ||
      this.providerTransactionId ||
      this.providerStatus !== "reversed"
    ) {
      throw new Error("Withdrawal reversal requires a confirmed provider reversal.");
    }

    if (this.verificationSource !== "paystack_transfer_verification") {
      throw new Error("Withdrawal reversal requires Transfer verification.");
    }

    if (this.providerAmount > this.amount) {
      throw new Error("Reversed provider payout cannot exceed the original withdrawal amount.");
    }

    if (this.providerFee != null || this.providerNetAmount != null) {
      throw new Error("Withdrawal reversal must not use DVA payment fee fields.");
    }
  }

  /* ---------- CANONICAL IDEMPOTENCY ---------- */

  let expectedKey = null;

  if (isDVAFunding) {
    expectedKey = [
      "financial-obligation",
      this.provider,
      this.providerMode,
      "dva-funding",
      this.providerReference,
    ].join(":");
  }

  if (isWithdrawalReversal) {
    expectedKey = [
      "financial-obligation",
      "withdrawal-reversal",
      String(this.withdrawalTransaction),
    ].join(":");
  }

  if (isCommercial) {
    expectedKey = [
      "financial-obligation",
      this.provider,
      this.providerMode,
      "commercial-payment",
      this.providerReference,
    ].join(":");
  }

  if (!expectedKey) {
    throw new Error("Unsupported financial obligation type.");
  }

  if (this.isNew && !this.idempotencyKey) {
    this.idempotencyKey = expectedKey;
  }

  if (this.idempotencyKey !== expectedKey) {
    throw new Error("Financial obligation idempotency key does not match its source.");
  }

  /* ---------- VERIFICATION EVIDENCE ---------- */

  if (!(this.verifiedAt instanceof Date) || !Number.isFinite(this.verifiedAt.getTime())) {
    throw new Error("Financial obligation requires a valid verification time.");
  }

  if (!isEvidenceObject(this.providerEvidence)) {
    throw new Error("Financial obligation requires verified provider evidence.");
  }

  /* ---------- REVIEW LIFECYCLE ---------- */

  if (this.status === "review_required" && !nonEmptyText(this.reviewReason)) {
    throw new Error("Financial obligation review requires a reason.");
  }

  if (this.isNew && this.status === "settled") {
    throw new Error("A new financial obligation must be recorded before settlement.");
  }

  if (this.refundExecution) {
    const execution = this.refundExecution;

    if (
      (!isDVAFunding && !isCommercial) ||
      execution.traceKey !== "financial-obligation-refund:" + String(this._id) ||
      !execution.authorizedBy || !execution.authorizedAt ||
      !nonEmptyText(execution.reason) ||
      (!["dispatching", "uncertain"].includes(execution.state) && !execution.providerRefundId)
    ) {
      throw new Error("Invalid financial obligation refund execution.");
    }

    if ((execution.state === "processed") !== (this.status === "settled")) {
      throw new Error("Refund execution and obligation settlement must agree.");
    }

    if (this.status === "settled" && (
      this.settlement?.method !== "paystack_refund" ||
      this.settlement?.providerRefundId !== execution.providerRefundId
    )) {
      throw new Error("Settlement must reference its verified refund execution.");
    }
  }

  const history = this.payoutExecutionHistory || [];
  const baseReference = "lq_obligation_" + String(this._id);
  const attemptReference = (index) => baseReference + (index ? "_" + (index + 1) : "");

  if (history.length > 98 || (history.length && !this.payoutExecution)) {
    throw new Error("Invalid payout execution history.");
  }

  const previousCodes = new Set();

  for (const [index, previous] of history.entries()) {
    if (!isWithdrawalReversal ||
        previous.reference !== attemptReference(index) ||
        !["failed", "reversed"].includes(previous.state) ||
        !previous.transferCode ||
        previous.transferCode === this.providerTransferCode ||
        previousCodes.has(previous.transferCode) ||
        !previous.lastCheckedAt ||
        previous.recipientCode !== this.payoutExecution.recipientCode ||
        (previous.previousSettlement && previous.state !== "reversed")) {
      throw new Error("Invalid historical payout attempt.");
    }

    previousCodes.add(previous.transferCode);
  }

  if (this.payoutExecution) {
    const execution = this.payoutExecution;

    if (
      !isWithdrawalReversal ||
      this.refundExecution ||
      execution.reference !== attemptReference(history.length) ||
      (execution.transferCode && previousCodes.has(execution.transferCode)) ||
      !nonEmptyText(execution.recipientCode) ||
      !execution.authorizedBy ||
      !execution.authorizedAt ||
      !nonEmptyText(execution.reason) ||
      execution.reference === this.providerReference ||
      (execution.transferCode &&
        execution.transferCode === this.providerTransferCode) ||
      (!["dispatching", "uncertain"].includes(execution.state) &&
        !execution.transferCode)
    ) {
      throw new Error("Invalid historical obligation payout execution.");
    }

    if ((execution.state === "success") !== (this.status === "settled")) {
      throw new Error("Payout execution and settlement status must agree.");
    }

    if (execution.previousSettlement && execution.state !== "reversed") {
      throw new Error("Previous settlement requires a reversed replacement payout.");
    }

    if (this.status === "settled" && (
      this.settlement?.method !== "paystack_transfer" ||
      this.settlement?.reference !== execution.reference
    )) {
      throw new Error("Settlement must match the verified obligation payout.");
    }
  }

  /* ---------- SETTLEMENT INTEGRITY ---------- */

  if (this.status !== "settled") {
    if (this.settlement) {
      throw new Error("Unsettled obligation cannot contain confirmed settlement evidence.");
    }

    return;
  }

  if (!this.settlement) {
    throw new Error("Settled obligation requires confirmed settlement evidence.");
  }

  if (this.settlement.amount !== this.amount || this.settlement.currency !== this.currency) {
    throw new Error("Settlement must cover the full financial obligation.");
  }

  if (
    !(this.settlement.confirmedAt instanceof Date) ||
    !Number.isFinite(this.settlement.confirmedAt.getTime())
  ) {
    throw new Error("Financial obligation requires a valid settlement confirmation time.");
  }

  if (!isEvidenceObject(this.settlement.evidence)) {
    throw new Error("Financial obligation requires settlement proof.");
  }

  if (this.settlement.method === "paystack_refund") {
    if ((!isDVAFunding && !isCommercial) || !this.settlement.providerRefundId) {
      throw new Error(
        "Paystack refund settlement requires its original incoming payment and refund ID."
      );
    }
  }

  if (this.settlement.method === "paystack_transfer") {
    if (
      !isWithdrawalReversal ||
      !this.payoutExecution ||
      this.payoutExecution.state !== "success" ||
      this.settlement.reference !== this.payoutExecution.reference ||
      !this.settlement.confirmedBy ||
      this.settlement.providerRefundId
    ) {
      throw new Error("Paystack payout settlement requires its authorized verified Transfer.");
    }
  }

  if (this.settlement.method === "verified_external_payment") {
    if (!this.settlement.confirmedBy) {
      throw new Error("External settlement requires an authorised confirmation.");
    }

    if (this.settlement.providerRefundId) {
      throw new Error("External settlement must not contain a Paystack refund ID.");
    }
  }
});

module.exports = mongoose.model("FinancialObligation", financialObligationSchema);
