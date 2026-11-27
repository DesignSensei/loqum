// models/ProviderEvent.js

const mongoose = require("mongoose");

/**
 * Stores provider events before financial execution.
 * Transaction.js remains the wallet ledger.
 *
 * Events are reconciled against their original financial records.
 * Refund events link to execution batch lines.
 * DVA assignment events manage account setup, not funding.
 *
 * Processing claims protect individual processing attempts.
 * First and latest attempt timestamps preserve processing history.
 */

const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const isOptionalNonNegativeInteger = (value) =>
  value === null || value === undefined || isNonNegativeInteger(value);

const preserveNumericType = (value) => {
  if (value !== null && value !== undefined && typeof value !== "number") {
    throw new TypeError("Provider event numeric fields must be Numbers, not coerced values.");
  }

  return value;
};

const PAYSTACK_REFUND_EVENT_NAMES = Object.freeze([
  "refund.pending",
  "refund.processing",
  "refund.needs-attention",
  "refund.failed",
  "refund.processed",
]);

const PAYSTACK_DVA_ASSIGNMENT_EVENT_NAMES = Object.freeze([
  "dedicatedaccount.assign.success",
  "dedicatedaccount.assign.failed",
]);

const providerEventSchema = new mongoose.Schema(
  {
    /* ---------- PROVIDER IDENTITY ---------- */

    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    eventKey: {
      type: String,
      required: true,
      trim: true,
      // Unique internal event idempotency key.
    },

    providerEventId: {
      type: String,
      trim: true,
      default: null,
    },

    providerReference: {
      type: String,
      trim: true,
      default: null,
    },

    providerRefundId: {
      type: String,
      trim: true,
      default: null,
    },

    providerRefundReference: {
      type: String,
      trim: true,
      default: null,
    },

    eventName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    eventCategory: {
      type: String,
      enum: [
        "employer_wallet_funding",
        "shift_checkout_payment",
        "job_publication_purchase",
        "subscription_payment",
        "employer_refund",
        "dva_assignment",
        "transfer_unresolved",
        "financial_obligation_payout",
        "employer_withdrawal_payout",
        "employer_withdrawal_reversal",
        "professional_withdrawal_payout",
        "professional_withdrawal_reversal",
        "other",
      ],
      default: "other",
      required: true,
      trim: true,
      lowercase: true,
    },

    /* ---------- VERIFICATION ---------- */

    isVerified: {
      type: Boolean,
      default: false,
      required: true,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    /* ---------- PROCESSING LIFECYCLE ---------- */

    status: {
      type: String,
      enum: ["received", "processing", "processed", "failed", "ignored"],
      default: "received",
      required: true,
      index: true,
    },

    receivedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },

    processingStartedAt: {
      type: Date,
      default: null,
      // First processing attempt.
    },

    lastProcessingStartedAt: {
      type: Date,
      default: null,
      // Latest processing attempt.
    },

    processingClaimId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
      // Ownership token for the active attempt.
    },

    processedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    ignoredAt: {
      type: Date,
      default: null,
    },

    ignoredReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    retryCount: {
      type: Number,
      required: true,
      set: preserveNumericType,
      default: 0,
      min: 0,
      validate: {
        validator: isNonNegativeInteger,
        message: "Retry count must be a non-negative integer.",
      },
    },

    nextRetryAt: {
      type: Date,
      default: null,
    },

    /* ---------- MONEY ---------- */

    // Amounts are stored in minor units.

    amount: {
      type: Number,
      set: preserveNumericType,
      default: null,
      min: 0,
      validate: {
        validator: isOptionalNonNegativeInteger,
        message: "Provider event amount must be a non-negative integer.",
      },
    },

    providerFee: {
      type: Number,
      set: preserveNumericType,
      default: null,
      min: 0,
      validate: {
        validator: isOptionalNonNegativeInteger,
        message: "Provider event fee must be a non-negative integer.",
      },
    },

    netAmount: {
      type: Number,
      set: preserveNumericType,
      default: null,
      min: 0,
      validate: {
        validator: isOptionalNonNegativeInteger,
        message: "Provider event net amount must be a non-negative integer.",
      },
    },

    countryCode: {
      type: String,
      default: null,
      required: true,
      match: /^[A-Z]{2}$/,
      uppercase: true,
      trim: true,
    },

    currency: {
      type: String,
      default: null,
      required: true,
      match: /^[A-Z]{3}$/,
      uppercase: true,
      trim: true,
    },

    /* ---------- LINKED RECORDS ---------- */

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      default: null,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
    },

    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null,
    },

    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    financialObligation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialObligation",
      default: null,
    },

    dva: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DVA",
      default: null,
    },

    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      default: null,
    },

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    shiftApplication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftApplication",
      default: null,
    },

    employerRefundBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefundBatch",
      default: null,
    },

    employerRefundBatchLineId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      // Embedded refund execution line ID.
    },

    /* ---------- PROVIDER PAYLOADS ---------- */

    rawHeaders: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    normalizedPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

/* ---------- INDEXES ---------- */

// Event idempotency.

providerEventSchema.index(
  {
    eventKey: 1,
  },
  {
    unique: true,
  }
);

providerEventSchema.index(
  {
    provider: 1,
    providerEventId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerEventId: {
        $type: "string",
      },
    },
  }
);

// Provider reference lookups.

providerEventSchema.index({
  provider: 1,
  providerReference: 1,
});

providerEventSchema.index({
  provider: 1,
  providerRefundId: 1,
});

providerEventSchema.index({
  provider: 1,
  providerRefundReference: 1,
});

providerEventSchema.index({
  provider: 1,
  eventName: 1,
});

providerEventSchema.index({
  provider: 1,
  eventCategory: 1,
});

// Processing and recovery.

providerEventSchema.index({
  status: 1,
  receivedAt: -1,
});

providerEventSchema.index({
  status: 1,
  nextRetryAt: 1,
});

providerEventSchema.index({
  isVerified: 1,
  status: 1,
});

// Historical ownership.

providerEventSchema.index({
  employer: 1,
  receivedAt: -1,
});

providerEventSchema.index({
  professional: 1,
  receivedAt: -1,
});

providerEventSchema.index({
  wallet: 1,
  receivedAt: -1,
});

providerEventSchema.index(
  {
    transaction: 1,
  },
  {
    sparse: true,
  }
);

// Multiple verified deliveries may resolve to the same obligation.
providerEventSchema.index(
  {
    financialObligation: 1,
  },
  {
    partialFilterExpression: {
      financialObligation: { $type: "objectId" },
    },
  }
);

providerEventSchema.index(
  {
    dva: 1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    bankAccount: 1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    shift: 1,
  },
  {
    sparse: true,
  }
);

// Refund execution.

providerEventSchema.index(
  {
    employerRefundBatch: 1,
    receivedAt: -1,
  },
  {
    sparse: true,
  }
);

providerEventSchema.index(
  {
    employerRefundBatch: 1,
    employerRefundBatchLineId: 1,
    receivedAt: -1,
  },
  {
    sparse: true,
  }
);

// Market and processing history.

providerEventSchema.index({
  countryCode: 1,
  currency: 1,
});

providerEventSchema.index({
  createdAt: -1,
});

providerEventSchema.index({
  status: 1,
  lastProcessingStartedAt: 1,
});

// Supports bounded recovery sweeps.

providerEventSchema.index(
  {
    isVerified: 1,
    status: 1,
    _id: 1,
  },
  {
    name: "provider_event_recovery_sweep",
  }
);

/* ---------- VALIDATION ---------- */

providerEventSchema.pre("validate", function () {
  /* ---------- Identity normalization ---------- */

  if (this.provider) {
    this.provider = String(this.provider).toLowerCase().trim();
  }

  if (this.eventKey) {
    this.eventKey = String(this.eventKey).trim();
  }

  if (this.providerEventId) {
    this.providerEventId = String(this.providerEventId).trim();
  }

  if (this.providerReference) {
    this.providerReference = String(this.providerReference).trim();
  }

  if (this.providerRefundId) {
    this.providerRefundId = String(this.providerRefundId).trim();
  }

  if (this.providerRefundReference) {
    this.providerRefundReference = String(this.providerRefundReference).trim();
  }

  if (this.eventName) {
    this.eventName = String(this.eventName).toLowerCase().trim();
  }

  if (this.eventCategory) {
    this.eventCategory = String(this.eventCategory).toLowerCase().trim();
  }

  if (this.processingClaimId) {
    this.processingClaimId = String(this.processingClaimId).trim();

    if (!this.processingClaimId) {
      this.processingClaimId = null;
    }
  }

  // Empty IDs must not occupy partial unique indexes.

  for (const field of [
    "providerEventId",
    "providerReference",
    "providerRefundId",
    "providerRefundReference",
  ]) {
    if (typeof this[field] === "string" && !this[field].trim()) {
      this[field] = null;
    }
  }

  if (!this.eventKey) {
    throw new Error("Provider event key is required.");
  }

  if (!this.provider) {
    throw new Error("Provider is required.");
  }

  if (!this.eventName) {
    throw new Error("Provider event name is required.");
  }

  /* ---------- Country and currency ---------- */

  if (!this.countryCode || !/^[A-Z]{2}$/.test(this.countryCode)) {
    throw new Error("Provider event requires an explicit two-letter country code.");
  }

  if (!this.currency || !/^[A-Z]{3}$/.test(this.currency)) {
    throw new Error("Provider event requires an explicit three-letter currency.");
  }

  /* ---------- Employer refund events ---------- */

  const hasEmployerRefundBatch = Boolean(this.employerRefundBatch);

  const hasEmployerRefundBatchLineId = Boolean(this.employerRefundBatchLineId);

  // Refund execution links must be supplied together.

  if (hasEmployerRefundBatch !== hasEmployerRefundBatchLineId) {
    throw new Error("Provider event employer refund batch and batch line must be linked together.");
  }

  if (
    this.eventCategory === "employer_refund" &&
    this.provider === "paystack" &&
    !PAYSTACK_REFUND_EVENT_NAMES.includes(this.eventName)
  ) {
    throw new Error(`Unsupported Paystack employer refund event name: ${this.eventName}.`);
  }

  if (
    this.provider === "paystack" &&
    PAYSTACK_REFUND_EVENT_NAMES.includes(this.eventName) &&
    this.eventCategory !== "employer_refund"
  ) {
    throw new Error("Paystack refund lifecycle events must use employer_refund category.");
  }

  /* ---------- DVA assignment events ---------- */

  // Assignment events manage account setup, not funding.

  if (
    this.eventCategory === "dva_assignment" &&
    (this.provider !== "paystack" || !PAYSTACK_DVA_ASSIGNMENT_EVENT_NAMES.includes(this.eventName))
  ) {
    throw new Error("DVA assignment category requires a supported Paystack assignment event.");
  }

  if (
    this.provider === "paystack" &&
    PAYSTACK_DVA_ASSIGNMENT_EVENT_NAMES.includes(this.eventName) &&
    this.eventCategory !== "dva_assignment"
  ) {
    throw new Error("Paystack DVA assignment events must use dva_assignment category.");
  }

  /* ---------- DVA funding events ---------- */

  if (this.eventCategory === "employer_wallet_funding") {
    if (this.provider !== "paystack" || this.eventName !== "charge.success") {
      throw new Error("DVA funding requires a successful Paystack charge event.");
    }

    if (this.countryCode !== "NG" || this.currency !== "NGN") {
      throw new Error("Paystack DVA funding requires NG/NGN.");
    }

    if (!this.providerReference) {
      throw new Error("DVA funding requires its provider payment reference.");
    }

    if (!Number.isSafeInteger(this.amount) || this.amount <= 0) {
      throw new Error("DVA funding requires a positive payment amount.");
    }

    if (
      this.professional ||
      this.bankAccount ||
      this.shift ||
      this.shiftApplication ||
      this.employerRefundBatch ||
      this.employerRefundBatchLineId
    ) {
      throw new Error("DVA funding contains unrelated financial links.");
    }

    // Ownership may be unresolved at ingestion.

    const ownershipLinks = [this.employer, this.wallet, this.dva];

    const hasOwnership = ownershipLinks.some(Boolean);

    const hasCompleteOwnership = ownershipLinks.every(Boolean);

    if (hasOwnership && !hasCompleteOwnership) {
      throw new Error("DVA funding requires its employer, wallet and DVA to be linked together.");
    }

    const hasTransaction = Boolean(this.transaction);

    const hasFinancialObligation = Boolean(this.financialObligation);

    if ((hasTransaction || hasFinancialObligation) && !hasCompleteOwnership) {
      throw new Error("DVA funding disposition requires its original ownership links.");
    }

    // A DVA payment must have only one financial disposition.

    if (hasTransaction && hasFinancialObligation) {
      throw new Error(
        "DVA funding cannot have both a wallet transaction and a financial obligation."
      );
    }

    if (this.status === "ignored") {
      throw new Error("A successful DVA payment cannot be ignored.");
    }

    const identityConflicts = this.normalizedPayload?.dvaFundingIdentityConflicts;

    if (identityConflicts != null && !Array.isArray(identityConflicts)) {
      throw new Error("DVA funding identity conflicts must be an array.");
    }

    // Completion requires resolved ownership and exactly one financial outcome.

    if (this.status === "processed") {
      if (identityConflicts?.length) {
        throw new Error("DVA funding cannot be processed with unresolved identity conflicts.");
      }

      if (!hasCompleteOwnership) {
        throw new Error("Processed DVA funding requires its original employer, wallet and DVA.");
      }

      if (hasTransaction === hasFinancialObligation) {
        throw new Error(
          "Processed DVA funding requires exactly one financial outcome: a wallet transaction or a historical financial obligation."
        );
      }
    }
  }

  /* ---------- Commercial payment events ---------- */

  if (
    this.provider === "paystack" &&
    ["job_publication_purchase", "subscription_payment"].includes(this.eventCategory) &&
    this.eventName !== "charge.success"
  ) {
    throw new Error(`Paystack ${this.eventCategory} events must use charge.success.`);
  }

  /* ---------- Withdrawal events ---------- */

  const transferEvent =
    this.provider === "paystack" &&
    ["transfer.success", "transfer.failed", "transfer.reversed"].includes(this.eventName);

  const withdrawalCategories = [
    "employer_withdrawal_payout",
    "professional_withdrawal_payout",
    "employer_withdrawal_reversal",
    "professional_withdrawal_reversal",
  ];

  if (transferEvent) {
    const allowed =
      this.eventName === "transfer.success"
        ? ["employer_withdrawal_payout", "professional_withdrawal_payout"]
        : ["employer_withdrawal_reversal", "professional_withdrawal_reversal"];

    // Preserve unresolved transfers for reconciliation.

    if (this.eventCategory === "transfer_unresolved") {
      if (["processed", "ignored"].includes(this.status)) {
        throw new Error("An unresolved Transfer cannot be processed or ignored.");
      }
    } else if (this.eventCategory === "financial_obligation_payout") {
      if (
        this.status !== "processed" ||
        !this.financialObligation ||
        !this.wallet ||
        !this.transaction ||
        !this.bankAccount ||
        Boolean(this.employer) === Boolean(this.professional)
      ) {
        throw new Error("Historical payout requires its verified financial obligation and owner.");
      }
    } else if (!allowed.includes(this.eventCategory)) {
      throw new Error("Paystack Transfer event category does not match its outcome.");
    } else {
      const employerWithdrawal = this.eventCategory.startsWith("employer_");

      if (
        !this.wallet ||
        !this.transaction ||
        !this.bankAccount ||
        (employerWithdrawal
          ? !this.employer || Boolean(this.professional)
          : !this.professional || Boolean(this.employer))
      ) {
        throw new Error(
          "A classified withdrawal requires its original wallet, transaction, bank account and owner."
        );
      }
    }

    if (!this.providerReference) {
      throw new Error("Paystack Transfer event requires its provider reference.");
    }
  } else if (
    this.eventCategory === "transfer_unresolved" ||
    this.eventCategory === "financial_obligation_payout" ||
    withdrawalCategories.includes(this.eventCategory)
  ) {
    throw new Error("Transfer category requires a supported Paystack Transfer event.");
  }

  /* ---------- HISTORICAL FINANCIAL OBLIGATIONS ---------- */

  if (this.financialObligation) {
    const isHistoricalDVAFunding =
      this.provider === "paystack" &&
      this.eventName === "charge.success" &&
      this.eventCategory === "employer_wallet_funding";

    const isHistoricalWithdrawalReversal =
      this.provider === "paystack" &&
      this.eventName === "transfer.reversed" &&
      ["employer_withdrawal_reversal", "professional_withdrawal_reversal"].includes(
        this.eventCategory
      );

    const isHistoricalCommercialPayment =
      this.provider === "paystack" &&
      this.eventName === "charge.success" &&
      ["subscription_payment", "job_publication_purchase"].includes(this.eventCategory);

    const isHistoricalRefund = this.provider === "paystack" &&
      this.eventCategory === "employer_refund" && PAYSTACK_REFUND_EVENT_NAMES.includes(this.eventName);

    const isHistoricalPayout =
      transferEvent &&
      this.eventCategory === "financial_obligation_payout";

    if (!isHistoricalDVAFunding && !isHistoricalWithdrawalReversal && !isHistoricalCommercialPayment && !isHistoricalRefund && !isHistoricalPayout) {
      throw new Error("Unsupported provider event financial obligation.");
    }

    if (this.isVerified !== true || this.status !== "processed") {
      throw new Error(
        "A provider event financial obligation requires a verified processed financial outcome."
      );
    }

    if (
      !this.wallet ||
      !this.providerReference ||
      !Number.isSafeInteger(this.amount) ||
      this.amount <= 0
    ) {
      throw new Error(
        "A provider event financial obligation requires complete financial identity."
      );
    }

    const payload = this.normalizedPayload || {};

    if (String(payload.financialObligationId || "") !== String(this.financialObligation)) {
      throw new Error(
        "Normalized financial obligation identity does not match the linked obligation."
      );
    }

    if (isHistoricalDVAFunding) {
      if (
        !this.employer ||
        !this.dva ||
        this.transaction ||
        this.professional ||
        this.bankAccount
      ) {
        throw new Error(
          "Historical DVA funding requires its original employer, wallet and DVA without a wallet credit transaction."
        );
      }
    }

    if (isHistoricalPayout) {
      if (
        this.dva ||
        this.shift ||
        this.shiftApplication ||
        this.employerRefundBatch ||
        this.employerRefundBatchLineId ||
        this.providerRefundId ||
        this.providerRefundReference ||
        payload.historicalPayoutVerified !== true ||
        !["success", "failed", "reversed"].includes(payload.verifiedPayoutStatus) ||
        payload.payoutReference !== this.providerReference
      ) {
        throw new Error("Invalid verified historical payout disposition.");
      }
    }

    if (isHistoricalRefund) {
      if (!this.employer || !this.providerRefundId || this.professional || this.bankAccount ||
          this.shift || this.shiftApplication || this.employerRefundBatch ||
          this.employerRefundBatchLineId ||
          payload.historicalRefundVerified !== true ||
          !["pending", "processing", "needs_attention", "failed", "processed"]
            .includes(payload.verifiedRefundStatus)) {
        throw new Error("Historical refund requires its verified financial obligation disposition.");
      }
    }

    if (isHistoricalCommercialPayment) {
      if (
        !this.employer || !this.transaction || this.professional || this.dva ||
        this.bankAccount || this.shift || this.shiftApplication ||
        this.employerRefundBatch || this.employerRefundBatchLineId ||
        this.providerRefundId || this.providerRefundReference ||
        payload.paymentFinalized !== false ||
        payload.commercialReceiptCredited !== false ||
        String(payload.paymentTransactionId || "") !== String(this.transaction)
      ) {
        throw new Error("Historical commercial receipt requires its original uncredited payment disposition.");
      }
    }

    if (isHistoricalWithdrawalReversal) {
      const employerWithdrawal = this.eventCategory === "employer_withdrawal_reversal";

      if (
        !this.transaction ||
        !this.bankAccount ||
        this.dva ||
        (employerWithdrawal
          ? !this.employer || Boolean(this.professional)
          : !this.professional || Boolean(this.employer))
      ) {
        throw new Error(
          "Historical withdrawal reversal requires its original withdrawal, wallet, bank account and owner."
        );
      }

      if (
        payload.withdrawalStatus !== "completed" ||
        payload.withdrawalReservationReleased !== false ||
        payload.withdrawalReversalCredited !== false ||
        payload.reversalTransactionId != null ||
        String(payload.withdrawalTransactionId || "") !== String(this.transaction)
      ) {
        throw new Error(
          "Historical withdrawal reversal contains an inconsistent financial disposition."
        );
      }
    }
  } else if (this.normalizedPayload?.financialObligationId != null) {
    throw new Error(
      "Normalized financial obligation identity requires its corresponding financial obligation relationship."
    );
  }

  /* ---------- Verification ---------- */

  // Services supply audit timestamps; validation never invents them.

  if (this.isVerified && !this.verifiedAt) {
    throw new Error("Verified provider event requires its verification time.");
  }

  if (!this.isVerified && this.verifiedAt) {
    throw new Error("Unverified provider event cannot have a verification time.");
  }

  if (["processing", "processed", "ignored"].includes(this.status) && this.isVerified !== true) {
    throw new Error(
      "Only verified provider events may enter processing, processed or ignored status."
    );
  }

  /* ---------- Processing history ---------- */

  const hasFirstAttempt = Boolean(this.processingStartedAt);

  const hasLatestAttempt = Boolean(this.lastProcessingStartedAt);

  if (hasFirstAttempt !== hasLatestAttempt) {
    throw new Error("First and latest provider processing timestamps must be supplied together.");
  }

  if (this.status === "received" && hasFirstAttempt) {
    throw new Error("Received provider event cannot already contain processing history.");
  }

  if (!this.isVerified && hasFirstAttempt) {
    throw new Error("Unverified provider event cannot contain processing history.");
  }

  const requiresProcessingHistory =
    ["processing", "processed", "ignored"].includes(this.status) ||
    (this.status === "failed" && this.isVerified === true);

  if (requiresProcessingHistory && !hasFirstAttempt) {
    throw new Error("Provider event status requires processing history.");
  }

  /* ---------- Processing ownership ---------- */

  if (this.status === "processing" && !this.processingClaimId) {
    throw new Error("Processing provider event requires a processing claim ID.");
  }

  if (this.status !== "processing" && this.processingClaimId) {
    throw new Error("A processing claim must be cleared when its attempt ends.");
  }

  /* ---------- Terminal states ---------- */

  const terminalFields = {
    processed: ["processedAt", null],
    failed: ["failedAt", "failureReason"],
    ignored: ["ignoredAt", "ignoredReason"],
  };

  for (const [status, [dateField, reasonField]] of Object.entries(terminalFields)) {
    if (this.status === status) {
      if (!this[dateField] || (reasonField && !this[reasonField]?.trim())) {
        throw new Error(`Provider event ${status} requires its timestamp and applicable reason.`);
      }
    } else if (this[dateField] || (reasonField && this[reasonField])) {
      throw new Error(
        `Provider event ${dateField} and reason must be cleared outside ${status} status.`
      );
    }
  }

  /* ---------- Retry state ---------- */

  if (this.nextRetryAt && this.status !== "failed") {
    throw new Error("Only failed provider events may have a next retry time.");
  }

  if (!isNonNegativeInteger(this.retryCount)) {
    throw new Error("Provider event retry count must be a non-negative safe integer.");
  }

  if (this.status === "received" && this.retryCount !== 0) {
    throw new Error("Received provider event cannot already contain failed-attempt history.");
  }

  if (this.status === "failed" && this.retryCount < 1) {
    throw new Error("Failed provider event requires a recorded failed-attempt count.");
  }

  if (!this.isVerified && this.nextRetryAt) {
    throw new Error("Unverified provider event cannot be scheduled for processing retry.");
  }

  /* ---------- Timestamp integrity ---------- */

  const dateFields = [
    "receivedAt",
    "verifiedAt",
    "processingStartedAt",
    "lastProcessingStartedAt",
    "processedAt",
    "failedAt",
    "ignoredAt",
    "nextRetryAt",
  ];

  for (const field of dateFields) {
    const value = this[field];

    if (value != null && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
      throw new Error(`Provider event ${field} must be a valid date.`);
    }
  }

  const assertOrder = (earlier, later) => {
    if (this[earlier] && this[later] && this[later].getTime() < this[earlier].getTime()) {
      throw new Error(`Provider event ${later} cannot precede ${earlier}.`);
    }
  };

  // Processing must follow receipt and verification.

  assertOrder("receivedAt", "processingStartedAt");

  assertOrder("verifiedAt", "processingStartedAt");

  assertOrder("processingStartedAt", "lastProcessingStartedAt");

  for (const field of ["processedAt", "failedAt", "ignoredAt"]) {
    assertOrder("receivedAt", field);

    assertOrder("lastProcessingStartedAt", field);
  }

  assertOrder("failedAt", "nextRetryAt");

  /* ---------- Financial integrity ---------- */

  for (const field of ["amount", "providerFee", "netAmount"]) {
    if (!isOptionalNonNegativeInteger(this[field])) {
      throw new Error(`Provider event ${field} must be a non-negative safe integer or null.`);
    }
  }

  if (this.netAmount != null && (this.amount == null || this.providerFee == null)) {
    throw new Error("Net amount requires both amount and provider fee.");
  }

  if (this.netAmount != null && this.netAmount !== this.amount - this.providerFee) {
    throw new Error("Provider event net amount must equal amount minus provider fee.");
  }

  if (
    this.amount !== null &&
    this.amount !== undefined &&
    this.providerFee !== null &&
    this.providerFee !== undefined &&
    this.providerFee > this.amount
  ) {
    throw new Error("Provider event fee cannot be greater than amount.");
  }

  if (
    this.amount !== null &&
    this.amount !== undefined &&
    this.netAmount !== null &&
    this.netAmount !== undefined &&
    this.netAmount > this.amount
  ) {
    throw new Error("Provider event net amount cannot be greater than amount.");
  }
});

module.exports = mongoose.model("ProviderEvent", providerEventSchema);
