// models/CACLookupAttempt.js

const mongoose = require("mongoose");

/**
 * CAC LOOKUP ATTEMPT MODEL
 *
 * Records lookup attempts separately from temporary CAC evidence.
 * Expiry, correction or cancellation of that evidence must not erase
 * an unresolved provider request or its audit history.
 *
 * Stores the normalized registration number and lookup outcome only.
 * Do not store registered business names, directors, credentials,
 * raw provider responses or raw provider errors here.
 *
 * This collection has no TTL index. Retention and anonymisation
 * require a reviewed audit policy.
 *
 * The service must create this record with the processing claim in
 * one transaction, before making a provider request. This model alone
 * does not prevent duplicate provider calls or duplicate charges.
 */

// ───────────────────── CAC LOOKUP ATTEMPT SCHEMA ─────────────────────

const cacLookupAttemptSchema = new mongoose.Schema(
  {
    // ───────────────────── OWNERSHIP ─────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // ───────────────────── REGISTRATION IDENTITY ─────────────────────

    /**
     * Canonical RC/BN identifier, including its prefix and leading zeroes.
     * The service must normalize and validate the input before lookup.
     */

    registrationNumber: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^(RC|BN)\d{4,10}$/,
    },

    // ───────────────────── VERIFICATION PROVIDER ─────────────────────

    provider: {
      type: String,
      enum: ["ninja", "dojah"],
      required: true,
      immutable: true,
    },

    providerEnvironment: {
      type: String,
      enum: ["staging", "production"],
      required: true,
      immutable: true,
    },

    // ───────────────────── REQUEST REFERENCES ─────────────────────

    /**
     * Internal references identify the original lookup and processing claim.
     * They are not provider-issued transaction IDs.
     */

    requestReference: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[A-Za-z0-9_.:-]{1,64}$/,
    },

    processingClaimId: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[A-Za-z0-9_.:-]{1,128}$/,
    },

    // ───────────────────── LOOKUP TIMESTAMPS ─────────────────────

    startedAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    // ───────────────────── LOOKUP OUTCOME ─────────────────────

    /**
     * pending: A claim exists without a recorded lookup outcome.
     * matched: Registration evidence passed the required CAC checks.
     * not_found: The provider explicitly confirmed no matching record.
     * needs_review: Registry evidence requires additional review.
     * uncertain: The provider outcome could not be confirmed safely.
     *
     * pending and uncertain must block uncontrolled resubmission.
     * completedAt on uncertain records means uncertainty was recorded;
     * it does not prove that the provider request failed or was uncharged.
     *
     * Cancelling temporary evidence does not resolve the provider outcome.
     * These statuses do not approve representative authority or KYB.
     */

    status: {
      type: String,
      enum: ["pending", "matched", "not_found", "needs_review", "uncertain"],
      default: "pending",
      required: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

/**
 * Query updates do not run these document validation hooks.
 * Services must enforce equivalent timestamp checks and allowed state
 * transitions in atomic filters, with request/claim and version checks.
 * Reconciliation of an uncertain outcome requires a controlled workflow.
 */

cacLookupAttemptSchema.pre("validate", function () {
  if (this.status === "pending") {
    if (this.completedAt != null) {
      throw new Error("Pending CAC attempts cannot have a completion timestamp.");
    }
  } else if (!this.completedAt || this.completedAt < this.startedAt) {
    throw new Error("Completed CAC attempts require a valid completion timestamp.");
  }
});

// ───────────────────── INDEXES ─────────────────────

// One audit record per internal request; the unique index must be installed.
cacLookupAttemptSchema.index({ requestReference: 1 }, { unique: true });

// Account-level history and unresolved-outcome checks.
cacLookupAttemptSchema.index({ user: 1, startedAt: -1 });
cacLookupAttemptSchema.index({ user: 1, status: 1 });

// Match attempts for a registration within its provider/environment context.
cacLookupAttemptSchema.index({
  user: 1,
  registrationNumber: 1,
  provider: 1,
  providerEnvironment: 1,
  status: 1,
});

// ───────────────────── SAFE SERIALIZATION ─────────────────────

/**
 * Keep internal identifiers out of ordinary document JSON.
 * This does not redact lean queries or toObject() output.
 * Controllers must return explicitly selected, authorized public fields.
 */

cacLookupAttemptSchema.set("toJSON", {
  transform(_document, result) {
    delete result.registrationNumber;
    delete result.processingClaimId;
    delete result.requestReference;

    return result;
  },
});

// ───────────────────── EXPORT ─────────────────────

module.exports = mongoose.model("CACLookupAttempt", cacLookupAttemptSchema);
