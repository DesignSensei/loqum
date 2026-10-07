// models/EmployerCancellationRequest.js

const mongoose = require("mongoose");

const occurrenceEvidenceSchema = require("./helpers/occurrenceEvidenceSchema");

const {
  EMPLOYER_CANCELLATION_REASON_CODES,
  OCCURRENCE_EMPLOYER_CANCELLATION_REASON_CODES,
} = require("../constants/shiftLifecycle");

const objectId = (ref, required = true) => ({
  type: mongoose.Schema.Types.ObjectId,
  ref,
  required,
});

const text = (maxlength, required = true) => ({
  type: String,
  trim: true,
  maxlength,
  required,
});

const requestSchema = new mongoose.Schema(
  {
    business: objectId("EmployerProfile"),

    shift: objectId("Shift"),

    occurrence: objectId("ShiftOccurrence", false),

    scope: {
      type: String,
      enum: ["occurrence", "shift"],
      required: true,
    },

    // Set by the service for new immediate commands. Optional for historical
    // records; binds a stable request ID to the exact reviewed instruction.
    commandHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
    },

    requestedBy: objectId("User"),

    requestedAt: {
      type: Date,
      required: true,
    },

    recordedBy: objectId("User"),

    recordedAt: {
      type: Date,
      required: true,
    },

    cancellationReasonCode: text(80),

    cancellationReason: {
      ...text(500),
      minlength: 10,
    },

    evidence: {
      type: [occurrenceEvidenceSchema],
      required: true,
      validate: (value) => Array.isArray(value) && value.length >= 1 && value.length <= 10,
    },

    // Admin attestation, not automated verification of the email's authenticity.
    evidenceReviewedBy: objectId("User"),

    evidenceReviewedAt: {
      type: Date,
      required: true,
    },

    evidenceReviewNotes: {
      ...text(2000),
      minlength: 10,
    },

    // Written instruction to cancel under the disclosed cancellation policy.
    // This is not approval of a quoted amount or an expiry-based permission.
    consent: {
      confirmedAt: {
        type: Date,
        required: true,
      },

      // Identifies an embedded evidence item, not a separate collection.
      evidenceId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
      },
    },

    // Pending is available while the service builds the record in the same
    // transaction as cancellation. It does not require a separate approval queue.
    // Withdrawn is retained for existing records; no renewal workflow is required.
    status: {
      type: String,
      enum: ["pending", "fulfilled", "withdrawn"],
      default: "pending",
      required: true,
    },

    execution: {
      adminUserId: objectId("User", false),

      executedAt: Date,

      reason: {
        ...text(500, false),
        minlength: 10,
      },

      // Actual financial outcome, not an employer-approved maximum.
      currency: {
        type: String,
        uppercase: true,
        match: /^[A-Z]{3}$/,
      },

      professionalCompensationMinor: {
        type: Number,
        min: 0,
        validate: (value) => value == null || Number.isSafeInteger(value),
      },
    },

    withdrawal: {
      adminUserId: objectId("User", false),

      withdrawnAt: Date,

      reason: {
        ...text(500, false),
        minlength: 10,
      },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    strict: "throw",
  }
);

requestSchema.pre("validate", function () {
  const fail = (path, message) => this.invalidate(path, message);

  if ((this.scope === "occurrence") !== Boolean(this.occurrence)) {
    fail("occurrence", "An occurrence is required only for occurrence scope.");
  }

  const codes =
    this.scope === "occurrence"
      ? OCCURRENCE_EMPLOYER_CANCELLATION_REASON_CODES
      : EMPLOYER_CANCELLATION_REASON_CODES;

  if (!codes.includes(this.cancellationReasonCode))
    fail("cancellationReasonCode", "Reason does not match scope.");

  if (String(this.requestedBy) === String(this.recordedBy))
    fail("requestedBy", "Employer requester and recording admin must differ.");

  if (String(this.evidenceReviewedBy) !== String(this.recordedBy))
    fail("evidenceReviewedBy", "Recording admin must review the evidence.");

  if (!(this.requestedAt <= this.recordedAt)) {
    fail("recordedAt", "The employer request must precede or match its recording time.");
  }

  if (!(this.evidenceReviewedAt >= this.requestedAt && this.evidenceReviewedAt <= this.recordedAt))
    fail("evidenceReviewedAt", "Evidence review timing is inconsistent.");

  if (!(
    this.consent?.confirmedAt >= this.requestedAt &&
    this.consent.confirmedAt <= this.evidenceReviewedAt
  ))
    fail("consent.confirmedAt", "Consent must precede evidence review.");

  const matchingEvidence = (this.evidence || []).filter(
    (evidence) =>
      evidence._id &&
      this.consent?.evidenceId &&
      String(evidence._id) === String(this.consent.evidenceId)
  );

  // A suitable type is necessary, but does not prove the content is an
  // authorized instruction. The service must require the admin's review.
  const writtenEvidenceTypes = ["message", "document", "screenshot", "image"];

  if (matchingEvidence.length !== 1 || !writtenEvidenceTypes.includes(matchingEvidence[0].type)) {
    fail("consent.evidenceId", "Select one written-instruction evidence item in this request.");
  }

  const evidenceIds = new Set();

  // Shared recordedAt means entry into the system, not email receipt or sender
  // confirmation. Do not use it to infer when the employer gave instructions.
  for (const evidence of this.evidence || []) {
    const evidenceId = evidence._id ? String(evidence._id) : null;

    if (!evidenceId || evidenceIds.has(evidenceId)) {
      fail("evidence", "Evidence items must have distinct IDs.");
    }

    evidenceIds.add(evidenceId);

    if (!(evidence.recordedAt <= this.recordedAt)) {
      fail("evidence", "Evidence recording cannot follow the request recording time.");
    }
  }

  const executed = Boolean(
    this.execution?.adminUserId ||
    this.execution?.executedAt ||
    this.execution?.reason ||
    this.execution?.currency ||
    this.execution?.professionalCompensationMinor != null
  );

  const withdrawn = Boolean(
    this.withdrawal?.adminUserId || this.withdrawal?.withdrawnAt || this.withdrawal?.reason
  );

  if (this.status === "fulfilled") {
    if (
      !this.execution?.adminUserId ||
      !this.execution?.reason ||
      !(this.execution.executedAt >= this.recordedAt) ||
      String(this.execution.adminUserId) === String(this.requestedBy) ||
      !/^[A-Z]{3}$/.test(this.execution.currency || "") ||
      !Number.isSafeInteger(this.execution.professionalCompensationMinor) ||
      this.execution.professionalCompensationMinor < 0 ||
      withdrawn
    ) {
      fail(
        "execution",
        "Fulfilled requests require an admin executor, execution time, currency and non-negative professional compensation."
      );
    }
  } else if (executed) fail("execution", "Only fulfilled requests may have execution details.");

  if (this.status === "withdrawn") {
    if (
      !this.withdrawal?.adminUserId ||
      !this.withdrawal?.reason ||
      !(this.withdrawal.withdrawnAt >= this.recordedAt)
    )
      fail("withdrawal", "Withdrawal details are required.");
  } else if (withdrawn) fail("withdrawal", "Only withdrawn requests may have withdrawal details.");
});

requestSchema.index({
  business: 1,
  shift: 1,
  status: 1,
  createdAt: -1,
});

requestSchema.index({
  occurrence: 1,
  status: 1,
});

// No TTL index: retain the employer instruction and execution history.
// The service must record the instruction and execute cancellation atomically.
// Failed cancellation must not leave a fulfilled record or partial financial writes.

module.exports = mongoose.model("EmployerCancellationRequest", requestSchema);
