// models/NINLookupAttempt.js

const mongoose = require("mongoose");

/**
 * NIN LOOKUP ATTEMPT MODEL
 *
 * Records lookup attempts separately from temporary NIN evidence.
 * Temporary evidence cleanup must not erase lookup history.
 *
 * Stores keyed identifier hashes, never raw NINs, legal names
 * or provider responses.
 *
 * Retention and anonymisation must follow the application's
 * reviewed audit policy. This collection has no TTL index.
 */

// ───────────────────── NIN LOOKUP ATTEMPT SCHEMA ─────────────────────

const ninLookupAttemptSchema = new mongoose.Schema(
  {
    // ───────────────────── OWNERSHIP ─────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // ───────────────────── IDENTIFIER EVIDENCE ─────────────────────

    /**
     * Server-generated keyed hash used to match lookup attempts.
     * The original NIN must never be stored here.
     */

    ninHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/,
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
     * References bind the audit entry to its original lookup claim.
     * They must not change when temporary evidence is replaced.
     */

    requestReference: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 64,
      match: /^[A-Za-z0-9_.:-]+$/,
    },

    processingClaimId: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 128,
      select: false,
    },

    // ───────────────────── LOOKUP TIMESTAMPS ─────────────────────

    startedAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    // ───────────────────── LOOKUP OUTCOME ─────────────────────

    /**
     * pending: A lookup claim exists without a recorded final outcome.
     * matched: The provider returned matching registry evidence.
     * not_found: The provider did not confirm a registry record.
     * needs_review: The result requires additional review.
     * uncertain: The provider outcome could not be confirmed safely.
     *
     * These states do not establish NIN ownership or marketplace approval.
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

ninLookupAttemptSchema.pre("validate", function () {
  if (this.status === "pending") {
    if (this.completedAt) {
      throw new Error("Pending NIN attempts cannot have a completion timestamp.");
    }
  } else if (!this.completedAt || this.completedAt < this.startedAt) {
    throw new Error("Completed NIN attempts require a valid completion timestamp.");
  }
});

// ───────────────────── INDEXES ─────────────────────

ninLookupAttemptSchema.index({ requestReference: 1 }, { unique: true });

ninLookupAttemptSchema.index({ user: 1, startedAt: -1 });

ninLookupAttemptSchema.index({ user: 1, ninHash: 1, status: 1 });

// ───────────────────── SAFE SERIALIZATION ─────────────────────

ninLookupAttemptSchema.set("toJSON", {
  transform(_document, result) {
    delete result.ninHash;
    delete result.processingClaimId;
    delete result.requestReference;

    return result;
  },
});

// ───────────────────── EXPORT ─────────────────────

module.exports = mongoose.model("NINLookupAttempt", ninLookupAttemptSchema);
