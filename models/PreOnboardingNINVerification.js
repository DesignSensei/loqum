// models/PreOnboardingNINVerification.js

const mongoose = require("mongoose");

// ───────────────────── REGISTRY LEGAL NAME ─────────────────────

/*
 * Structured legal-name evidence obtained from
 * the configured NIN registry verification provider.
 *
 * Names must originate from trusted Ninja or Dojah
 * responses, not user-submitted registration data.
 *
 * Middle name is optional.
 *
 * Registry name retrieval does not authenticate
 * the person submitting the NIN.
 */

function isValidRegistryNameComponent(value, optional = false) {
  if (optional && (value === "" || value == null)) {
    return true;
  }

  return (
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001F\u007F]/.test(value)
  );
}

const registryLegalNameSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      validate: {
        validator: (value) => isValidRegistryNameComponent(value),
        message: "Registry first name is invalid.",
      },
    },

    middleName: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "",
      validate: {
        validator: (value) => isValidRegistryNameComponent(value, true),
        message: "Registry middle name is invalid.",
      },
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      validate: {
        validator: (value) => isValidRegistryNameComponent(value),
        message: "Registry last name is invalid.",
      },
    },
  },
  {
    _id: false,
  }
);

// ───────────────────── PRE-ONBOARDING NIN EVIDENCE ─────────────────────

const preOnboardingNINVerificationSchema = new mongoose.Schema(
  {
    // ───────────────────── OWNERSHIP ─────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // ───────────────────── VERIFICATION PROVIDER ─────────────────────

    /*
     * NIN only. BVN is not supported.
     *
     * The provider is selected through the
     * application's verification configuration.
     *
     * Switching providers must be explicit.
     * No automatic fallback or double-charging.
     */

    provider: {
      type: String,
      enum: ["ninja", "dojah"],
      required: true,
    },

    providerEnvironment: {
      type: String,
      enum: ["staging", "production"],
      required: true,
    },

    // ───────────────────── NIN IDENTIFIER EVIDENCE ─────────────────────

    /*
     * HMAC-SHA256 of the NIN, generated server-side
     * using a dedicated secret key.
     *
     * Never store the original 11-digit NIN.
     *
     * The hash and last four digits support
     * controlled evidence matching and retrieval.
     */

    ninHash: {
      type: String,
      required: true,
      select: false,
      match: /^[a-f0-9]{64}$/,
    },

    ninLast4: {
      type: String,
      required: true,
      select: false,
      match: /^\d{4}$/,
    },

    // ───────────────────── VERIFICATION STATUS ─────────────────────

    /*
     * processing:
     * A registry lookup has been claimed and
     * is currently in progress.
     *
     * matched:
     * A trusted registry record was found and
     * structured legal-name evidence was obtained.
     * Name acknowledgement is tracked separately.
     *
     * needs_review:
     * The lookup result requires additional review
     * and cannot authorise normal onboarding.
     *
     * not_found:
     * The provider confirmed the NIN record
     * was not found.
     *
     * failed:
     * The lookup could not be confirmed safely.
     *
     * cancelled:
     * The applicant invalidated an unconsumed,
     * nonprocessing lookup.
     *
     * An in-flight lookup keeps its processing
     * claim until the provider outcome has been
     * safely recorded.
     *
     * consumed:
     * Acknowledged production evidence has been
     * consumed inside the onboarding transaction.
     *
     * Registry matching and name acknowledgement
     * do not establish identity-holder authentication
     * or final professional approval.
     *
     * The service must enforce permitted status
     * transitions through atomic database updates.
     */

    status: {
      type: String,
      enum: [
        "processing",
        "matched",
        "needs_review",
        "not_found",
        "failed",
        "cancelled",
        "consumed",
      ],
      required: true,
      default: "processing",
    },

    // ───────────────────── REGISTRY RESULT ─────────────────────

    registryFound: {
      type: Boolean,
      default: null,
    },

    /*
     * Authoritative structured legal-name evidence.
     *
     * The configured provider supplies first,
     * middle and last names separately.
     *
     * The service must not derive these fields from
     * registration names or split a combined name.
     *
     * Complete structured names are required
     * for matched and consumed records.
     *
     * The field is excluded from ordinary queries.
     * Trusted consumers must explicitly select
     * +registryLegalName before using it.
     */

    registryLegalName: {
      type: registryLegalNameSchema,
      default: null,
      select: false,
    },

    // ───────────────────── CONSENT ─────────────────────

    /*
     * Explicit consent to the NIN registry lookup.
     *
     * The service validates consent before
     * sending a chargeable provider request.
     */

    consentAcceptedAt: {
      type: Date,
      required: true,
    },

    // ───────────────────── PROCESSING REFERENCES ─────────────────────

    /*
     * Processing claims and references support:
     *
     * - Atomic lookup acquisition;
     * - Duplicate-request prevention;
     * - Provider result correlation;
     * - Name acknowledgement of the current result;
     * - Entering a different NIN;
     * - Transactional onboarding consumption.
     *
     * Never store provider credentials, raw NIN
     * values or sensitive hosted-KYC URLs.
     */

    processingClaimId: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
      select: false,
    },

    requestReference: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      match: /^[A-Za-z0-9_.:-]{1,64}$/,
      select: false,
    },

    providerReference: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
      select: false,
    },

    // ───────────────────── PROCESSING TIMESTAMPS ─────────────────────

    lookupStartedAt: {
      type: Date,
      required: true,
    },

    processingLeaseExpiresAt: {
      type: Date,
      default: null,
    },

    checkedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── NAME ACKNOWLEDGEMENT ─────────────────────

    /*
     * The user must explicitly acknowledge the
     * full legal name returned for the current NIN.
     *
     * requestReference ties acknowledgement to
     * the displayed lookup result, preventing an
     * old browser tab from confirming new evidence.
     *
     * This is an applicant acknowledgement,
     * NOT proof that they own the NIN.
     *
     * The service clears acknowledgement when
     * verification evidence is superseded.
     */

    nameAcknowledgedAt: {
      type: Date,
      default: null,
    },

    nameAcknowledgedRequestReference: {
      type: String,
      trim: true,
      maxlength: 64,
      match: /^[A-Za-z0-9_.:-]{1,64}$/,
      default: null,
    },

    // ───────────────────── ENTER A DIFFERENT NIN ─────────────────────

    /*
     * Selecting "Enter a different NIN" clears
     * acknowledgement and marks correction pending.
     *
     * An in-flight lookup keeps its processing
     * claim and lease. A second chargeable lookup
     * cannot proceed until the first outcome has
     * been safely recorded.
     *
     * A completed nonmatched lookup can be
     * cancelled. Matched evidence remains cached
     * but cannot be consumed during correction.
     *
     * The same NIN may reuse valid cached evidence.
     * A different NIN replaces the current record
     * through an atomic processing claim.
     *
     * No blanket correction cooldown applies.
     */

    correctionRequestedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── EVIDENCE VALIDITY ─────────────────────

    /*
     * resultExpiresAt controls the period during
     * which a completed registry result can be
     * reused, acknowledged or consumed.
     *
     * expiresAt controls MongoDB TTL cleanup.
     *
     * The temporary record may outlive its
     * usable result to preserve lookup-attempt
     * counter snapshots.
     *
     * Durable lookup-attempt audit records are
     * stored separately.
     *
     * Neither timestamp imposes a correction
     * cooldown.
     */

    resultExpiresAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── LOOKUP ATTEMPT CONTROLS ─────────────────────

    /*
     * The verification service tracks chargeable
     * lookup attempts across NIN changes and
     * application restarts.
     *
     * attemptDistinctNINHashes contains only
     * server-generated HMACs, never raw NINs.
     *
     * These counters are temporary snapshots.
     * NINLookupAttempt supplies durable audit data.
     *
     * Additional account, IP and device rate
     * limiting belongs to separate controls.
     */

    attemptWindowStartedAt: {
      type: Date,
      required: true,
    },

    attemptCount: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
      validate: {
        validator: (value) => Number.isSafeInteger(value),
        message: "NIN lookup attempt count must be an integer.",
      },
    },

    attemptDistinctNINHashes: {
      type: [
        {
          type: String,
          match: /^[a-f0-9]{64}$/,
        },
      ],
      default: [],
      select: false,
      validate: {
        validator: (value) => Array.isArray(value) && new Set(value).size === value.length,
        message: "NIN lookup attempt hashes must be unique.",
      },
    },

    // ───────────────────── CONSUMPTION ─────────────────────

    /*
     * Only eligible, acknowledged production NIN
     * evidence may be consumed transactionally.
     *
     * The trusted onboarding service must create
     * permanent KYC evidence and save registry
     * legal names in the same transaction.
     *
     * Consumption does not itself approve the
     * professional for marketplace participation.
     */

    consumedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────── ERROR INFORMATION ─────────────────────

    /*
     * Store sanitised error information only.
     *
     * Never persist raw provider responses,
     * NIN values or personal data in errors.
     */

    errorCode: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    reason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    // ───────────────────── TEMPORARY EVIDENCE RETENTION ─────────────────────

    /*
     * expiresAt controls MongoDB TTL cleanup.
     *
     * The record may outlive the usable lookup
     * result so attempt controls survive correction
     * and application restarts.
     *
     * MongoDB TTL cleanup is asynchronous.
     * Services must check resultExpiresAt before
     * accepting evidence for onboarding.
     *
     * Expiry of temporary evidence does not
     * revoke permanent KYC, licences or approval.
     */

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────────────────── DOCUMENT VALIDATION ─────────────────────

preOnboardingNINVerificationSchema.pre("validate", function () {
  /*
   * These document checks apply when documents
   * are created or saved.
   *
   * Query-level findOneAndUpdate() does NOT run
   * document validation middleware.
   *
   * The service independently enforces atomic
   * transitions, expiry and acknowledgement fencing.
   */

  if (!this.lookupStartedAt || !this.consentAcceptedAt) {
    throw new Error("NIN evidence must include lookup and consent timestamps.");
  }

  if (this.consentAcceptedAt > this.lookupStartedAt) {
    throw new Error("NIN lookup consent must precede or coincide with the lookup.");
  }

  if (!this.expiresAt || this.expiresAt <= this.lookupStartedAt) {
    throw new Error("NIN evidence retention must extend beyond the lookup start.");
  }

  /*
   * Each claimed lookup is counted and its HMAC
   * is included in the current attempt window.
   */

  if (
    !this.attemptWindowStartedAt ||
    this.attemptWindowStartedAt > this.lookupStartedAt ||
    !Number.isSafeInteger(this.attemptCount) ||
    this.attemptCount < 1 ||
    !Array.isArray(this.attemptDistinctNINHashes) ||
    this.attemptDistinctNINHashes.length < 1 ||
    this.attemptDistinctNINHashes.length > this.attemptCount ||
    !this.attemptDistinctNINHashes.includes(this.ninHash)
  ) {
    throw new Error("NIN lookup attempt evidence is incomplete or inconsistent.");
  }

  // ───────── PROCESSING EVIDENCE ─────────

  /*
   * A processing lookup retains its claim and lease,
   * even if the applicant has selected a different NIN.
   *
   * A pending correction is allowed, but completed
   * registry evidence and acknowledgement are not.
   */

  if (this.status === "processing") {
    if (!this.processingClaimId || !this.processingLeaseExpiresAt) {
      throw new Error("Processing NIN evidence must include a claim and lease.");
    }

    if (
      this.processingLeaseExpiresAt <= this.lookupStartedAt ||
      this.processingLeaseExpiresAt > this.expiresAt
    ) {
      throw new Error(
        "NIN processing lease must extend beyond lookup start and remain within retention."
      );
    }

    if (
      this.registryFound !== null ||
      this.registryLegalName ||
      this.checkedAt ||
      this.resultExpiresAt ||
      this.nameAcknowledgedAt ||
      this.nameAcknowledgedRequestReference ||
      this.consumedAt
    ) {
      throw new Error("Processing NIN evidence cannot contain completed lookup evidence.");
    }
  } else if (this.status === "cancelled") {
    // ───────── CANCELLED EVIDENCE ─────────

    if (
      !this.correctionRequestedAt ||
      this.correctionRequestedAt < this.lookupStartedAt ||
      this.processingClaimId ||
      this.processingLeaseExpiresAt ||
      this.registryFound !== null ||
      this.registryLegalName ||
      this.checkedAt ||
      this.resultExpiresAt ||
      this.nameAcknowledgedAt ||
      this.nameAcknowledgedRequestReference ||
      this.consumedAt
    ) {
      throw new Error(
        "Cancelled NIN evidence must record correction and clear claims and results."
      );
    }
  } else {
    // ───────── COMPLETED EVIDENCE ─────────

    /*
     * Completed results require a lookup timestamp
     * and a finite evidence validity window.
     */

    if (this.processingClaimId || this.processingLeaseExpiresAt) {
      throw new Error("Completed NIN evidence cannot retain an active processing claim.");
    }

    if (
      !this.checkedAt ||
      !this.resultExpiresAt ||
      this.checkedAt < this.lookupStartedAt ||
      this.resultExpiresAt <= this.checkedAt ||
      this.resultExpiresAt > this.expiresAt
    ) {
      throw new Error("Completed NIN evidence requires a valid result expiry.");
    }
  }

  // ───────── STRUCTURED REGISTRY NAME ─────────

  /*
   * Only matched or consumed results may retain
   * authoritative structured registry names.
   */

  if (this.status === "matched" || this.status === "consumed") {
    if (this.registryFound !== true) {
      throw new Error("Matched NIN evidence must confirm that the registry record was found.");
    }

    if (
      !this.registryLegalName ||
      !isValidRegistryNameComponent(this.registryLegalName.firstName) ||
      !isValidRegistryNameComponent(this.registryLegalName.middleName, true) ||
      !isValidRegistryNameComponent(this.registryLegalName.lastName)
    ) {
      throw new Error(
        "Matched NIN evidence must include a complete structured registry legal name."
      );
    }
  } else if (this.registryLegalName) {
    throw new Error("Unconfirmed NIN evidence cannot contain authoritative legal names.");
  }

  // ───────── NOT FOUND ─────────

  if (this.status === "not_found" && this.registryFound !== false) {
    throw new Error("A not-found NIN result must confirm that the record was not found.");
  }

  // ───────── FAILED LOOKUP ─────────

  if (this.status === "failed" && this.registryFound !== null) {
    throw new Error("A failed NIN lookup cannot assert a registry outcome.");
  }

  // ───────── NAME ACKNOWLEDGEMENT ─────────

  /*
   * Acknowledgement must apply to the currently
   * displayed lookup after the registry result.
   *
   * It cannot coexist with a pending correction.
   */

  if (this.nameAcknowledgedAt) {
    if (
      !["matched", "consumed"].includes(this.status) ||
      this.correctionRequestedAt ||
      this.nameAcknowledgedRequestReference !== this.requestReference ||
      !this.checkedAt ||
      this.nameAcknowledgedAt < this.checkedAt ||
      this.nameAcknowledgedAt >= this.resultExpiresAt
    ) {
      throw new Error("NIN name acknowledgement must belong to the current valid result.");
    }
  } else if (this.nameAcknowledgedRequestReference) {
    throw new Error("NIN acknowledgement reference requires an acknowledgement timestamp.");
  }

  // ───────── PENDING NIN CHANGE ─────────

  /*
   * A correction invalidates acknowledgement
   * without imposing a blanket cooldown.
   *
   * A processing request keeps its claim.
   * Its provider result may arrive after the
   * correction timestamp.
   *
   * Completed matched, not-found, failed and
   * review outcomes may also retain the correction
   * flag until another NIN is submitted.
   *
   * No evidence can be consumed while this
   * flag remains set.
   */

  if (this.correctionRequestedAt && this.status !== "cancelled") {
    if (
      !["processing", "matched", "needs_review", "not_found", "failed"].includes(this.status) ||
      this.consumedAt ||
      this.nameAcknowledgedAt ||
      this.nameAcknowledgedRequestReference ||
      this.correctionRequestedAt < this.lookupStartedAt
    ) {
      throw new Error("NIN correction must invalidate unconsumed name acknowledgement.");
    }
  }

  // ───────── CONSUMED EVIDENCE ─────────

  /*
   * Only acknowledged production evidence may
   * be consumed during an onboarding transaction.
   */

  if (this.status === "consumed") {
    if (
      this.providerEnvironment !== "production" ||
      !this.consumedAt ||
      !this.nameAcknowledgedAt ||
      this.correctionRequestedAt ||
      this.consumedAt < this.nameAcknowledgedAt ||
      this.consumedAt >= this.resultExpiresAt ||
      this.consumedAt >= this.expiresAt
    ) {
      throw new Error(
        "Consumed NIN evidence must be acknowledged production evidence consumed before expiry."
      );
    }
  } else if (this.consumedAt) {
    throw new Error("Unconsumed NIN evidence cannot contain a consumption timestamp.");
  }
});

// ───────────────────── INDEXES ─────────────────────

/*
 * One temporary NIN evidence record per user.
 *
 * The service must enforce atomic lookup claims
 * and prevent duplicate paid requests.
 */

preOnboardingNINVerificationSchema.index({ user: 1 }, { unique: true });

/*
 * MongoDB TTL cleanup controls document retention,
 * not correction cooldown or result validity.
 *
 * The service independently enforces resultExpiresAt.
 */

preOnboardingNINVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ───────────────────── SAFE SERIALIZATION ─────────────────────

/*
 * Sensitive evidence must not appear when
 * a Mongoose document is serialised to JSON.
 *
 * The verification service explicitly constructs
 * the authorised registry-name preview.
 */

preOnboardingNINVerificationSchema.set("toJSON", {
  transform(_document, result) {
    delete result.ninHash;
    delete result.ninLast4;
    delete result.registryLegalName;

    delete result.processingClaimId;
    delete result.requestReference;
    delete result.providerReference;

    delete result.nameAcknowledgedRequestReference;

    delete result.attemptWindowStartedAt;
    delete result.attemptCount;
    delete result.attemptDistinctNINHashes;

    delete result.errorCode;

    return result;
  },
});

module.exports = mongoose.model("PreOnboardingNINVerification", preOnboardingNINVerificationSchema);
