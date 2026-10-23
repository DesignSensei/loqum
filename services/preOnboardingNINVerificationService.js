// services/preOnboardingNINVerificationService.js

const mongoose = require("mongoose");
const crypto = require("crypto");

const User = require("../models/User");
const PreOnboardingNINVerification = require("../models/PreOnboardingNINVerification");

const IdentityVerificationService = require("./identityVerificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const SERVICE_ERROR_NAME = "PreOnboardingNINVerificationServiceError";

const PROCESSING_LEASE_MS = 3 * 60 * 1000;
const RESULT_TTL_MS = 60 * 60 * 1000;

const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECORD_RETENTION_MS = ATTEMPT_WINDOW_MS + RESULT_TTL_MS;

const MAX_DISTINCT_NINS_PER_WINDOW = 4;
const MAX_LOOKUPS_PER_WINDOW = 8;

const COMPLETED_STATUSES = new Set(["matched", "needs_review", "not_found", "failed"]);

const CONSUMABLE_STATUS = "matched";

const EVIDENCE_SELECTION = [
  "+ninHash",
  "+ninLast4",
  "+registryLegalName",
  "+processingClaimId",
  "+requestReference",
  "+providerReference",
  "+attemptDistinctNINHashes",
].join(" ");

const REQUIRED_SCHEMA_FIELDS = [
  "registryLegalName",
  "nameAcknowledgedAt",
  "nameAcknowledgedRequestReference",
  "correctionRequestedAt",
  "resultExpiresAt",
  "attemptWindowStartedAt",
  "attemptCount",
  "attemptDistinctNINHashes",
];

class PreOnboardingNINVerificationService {
  /*
   * PRE-ONBOARDING NIN VERIFICATION
   *
   * Active identity lookup method: NIN only.
   *
   * GREENFIELD ONBOARDING FLOW
   *
   * 1. Applicant enters an 11-digit NIN.
   * 2. Applicant gives explicit lookup consent.
   * 3. The selected provider retrieves registry data.
   * 4. Loqum displays the legal name, where permitted.
   * 5. Applicant acknowledges the name or corrects NIN.
   * 6. Only acknowledged production evidence may
   *    be consumed during professional onboarding.
   *
   * Registration names are not required.
   *
   * Professional legal names originate exclusively
   * from structured, trusted NIN registry evidence.
   *
   * CORRECTION POLICY
   *
   * Ordinary corrections have no blanket cooldown.
   *
   * Starting a correction immediately invalidates
   * the existing name acknowledgement.
   *
   * A replacement lookup atomically supersedes the
   * previous temporary evidence.
   *
   * Same-NIN lookups reuse valid cached evidence.
   *
   * ABUSE PREVENTION
   *
   * - One temporary record per account;
   * - Atomic processing claims;
   * - Fenced provider response completion;
   * - Persistent per-account lookup attempt limits;
   * - Distinct NIN lookup limits;
   * - No automatic provider retries;
   * - No automatic provider fallback.
   *
   * Identity-holder authentication is NOT established
   * by registry lookup or name acknowledgement.
   *
   * PCN licence verification and administrative
   * approval remain independent.
   *
   * Never store or log a raw NIN.
   */

  // ───────────────────── ERRORS ─────────────────────

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  // ───────────────────── MODEL CONTRACT ─────────────────────

  /*
   * These fields must exist in the updated
   * PreOnboardingNINVerification schema.
   *
   * Fail before making a chargeable provider call
   * if the schema is not ready.
   *
   * Mongoose strict mode must never silently
   * discard acknowledgement or correction fields.
   */

  static assertSchemaReady() {
    const missing = REQUIRED_SCHEMA_FIELDS.filter(
      (field) => !PreOnboardingNINVerification.schema.path(field)
    );

    if (missing.length > 0) {
      throw this.createError({
        message: "NIN verification storage is not fully configured.",
        code: "NIN_ONBOARDING_SCHEMA_INCOMPLETE",
        statusCode: 500,
      });
    }
  }

  // ───────────────────── IDENTIFIERS ─────────────────────

  static normalizeUserId(userId) {
    if (!mongoose.isValidObjectId(userId)) {
      throw this.createError({
        message: "Invalid professional user ID.",
        code: "NIN_ONBOARDING_INVALID_USER",
        statusCode: 400,
      });
    }

    return userId;
  }

  static normalizeNIN(nin) {
    if (typeof nin !== "string") {
      throw this.createError({
        message: "Enter a valid 11-digit NIN.",
        code: "NIN_ONBOARDING_INVALID_NIN",
        statusCode: 400,
      });
    }

    return IdentityVerificationService.normalizeIdentifier(nin);
  }

  static getNINHash(nin) {
    const secret = process.env.NIN_HASH_SECRET;

    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw this.createError({
        message: "NIN verification is not configured.",
        code: "NIN_ONBOARDING_HASH_KEY_MISSING",
        statusCode: 503,
      });
    }

    /*
     * HMAC-SHA256 protects the identifier against
     * offline enumeration more effectively than
     * an ordinary unkeyed hash.
     *
     * Use a dedicated, protected secret.
     */

    return crypto.createHmac("sha256", secret).update(`nin:${nin}`, "utf8").digest("hex");
  }

  static normalizeRequestReference(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
      throw this.createError({
        message: "Invalid NIN verification reference.",
        code: "NIN_ONBOARDING_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── AUTHORIZATION ─────────────────────

  static async assertProfessionalCanVerify(userId, session = null) {
    this.normalizeUserId(userId);

    const query = User.findById(userId).select("_id role accountStatus isVerified isOnboarded");

    if (session) {
      query.session(session);
    }

    const user = await query;

    if (!user || user.role !== "professional") {
      throw this.createError({
        message: "A professional account is required.",
        code: "NIN_ONBOARDING_PROFESSIONAL_REQUIRED",
        statusCode: 403,
      });
    }

    if (user.accountStatus !== "active" || user.isVerified !== true) {
      throw this.createError({
        message: "Your account is not eligible for NIN verification.",
        code: "NIN_ONBOARDING_ACCOUNT_INELIGIBLE",
        statusCode: 403,
      });
    }

    if (user.isOnboarded === true) {
      throw this.createError({
        message: "Professional onboarding has already been completed.",
        code: "NIN_ONBOARDING_ALREADY_COMPLETED",
        statusCode: 409,
      });
    }

    /*
     * No first-name, surname or date-of-birth
     * comparison against registration data.
     *
     * Official legal names will originate
     * from NIN registry evidence.
     */

    return user;
  }

  // ───────────────────── PROVIDER CONFIGURATION ─────────────────────

  static getProviderContext() {
    IdentityVerificationService.assertVerificationEnabled();

    const provider = IdentityVerificationService.getProvider();

    const environment = IdentityVerificationService.getEnvironment(provider);

    const adapter = IdentityVerificationService.getAdapter(provider);

    try {
      adapter.assertNewVerificationEnabled("identity");
    } catch (error) {
      throw IdentityVerificationService.normalizeProviderError(error);
    }

    return {
      provider,
      environment,
    };
  }

  // ───────────────────── FULL-NAME PREVIEW PERMISSION ─────────────────────

  /*
   * Full-name preview is enabled only after
   * Loqum confirms the selected provider's
   * applicable permissions and completes the
   * necessary privacy assessment.
   *
   * Separate provider configuration prevents
   * one provider's permission being assumed
   * to apply to another provider.
   *
   * These flags default to disabled.
   *
   * This gate is checked BEFORE a lookup so
   * the applicant is not charged for a result
   * the selected workflow cannot display.
   */

  static assertNamePreviewAllowed(provider) {
    const settings = {
      ninja: "NINJA_NIN_FULL_NAME_PREVIEW_ALLOWED",
      dojah: "DOJAH_NIN_FULL_NAME_PREVIEW_ALLOWED",
    };

    const setting = settings[provider];

    if (!setting || process.env[setting] !== "true") {
      throw this.createError({
        message: "NIN name preview is not enabled for the selected provider.",
        code: "NIN_ONBOARDING_PREVIEW_NOT_ENABLED",
        statusCode: 503,
      });
    }
  }

  // ───────────────────── REGISTRY NAME VALIDATION ─────────────────────

  static normalizeRegistryLegalName(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw this.createError({
        message: "NIN registry legal-name evidence is incomplete.",
        code: "NIN_ONBOARDING_INVALID_REGISTRY_NAME",
        statusCode: 502,
      });
    }

    const firstName = IdentityVerificationService.normalizeRegistryName(value.firstName, 100);

    const middleName = IdentityVerificationService.normalizeRegistryName(
      value.middleName,
      100,
      true
    );

    const lastName = IdentityVerificationService.normalizeRegistryName(value.lastName, 100);

    if (!firstName || !lastName || middleName === null) {
      throw this.createError({
        message: "NIN registry legal-name evidence is invalid.",
        code: "NIN_ONBOARDING_INVALID_REGISTRY_NAME",
        statusCode: 502,
      });
    }

    const nameOnRecord = [firstName, middleName, lastName].filter(Boolean).join(" ");

    if (nameOnRecord.length > 150) {
      throw this.createError({
        message: "NIN legal-name evidence requires additional review.",
        code: "NIN_ONBOARDING_REGISTRY_NAME_TOO_LONG",
        statusCode: 502,
      });
    }

    return {
      firstName,
      middleName,
      lastName,
      nameOnRecord,
    };
  }

  // ───────────────────── EVIDENCE EXPIRY ─────────────────────

  /*
   * resultExpiresAt controls whether a registry
   * result may be reused and consumed.
   *
   * expiresAt controls MongoDB TTL cleanup.
   *
   * The document is retained longer than the
   * result's validity to preserve the account's
   * short-term lookup-attempt budget.
   *
   * TTL expiry is not a correction cooldown.
   */

  static hasNotExpired(record, now = new Date()) {
    const expiry = record?.resultExpiresAt ? new Date(record.resultExpiresAt).getTime() : NaN;

    return Number.isFinite(expiry) && expiry > now.getTime();
  }

  static matchesLookupIdentity(record, input, context) {
    return (
      record.provider === context.provider &&
      record.providerEnvironment === context.environment &&
      record.ninHash === input.ninHash
    );
  }

  static isReusableResult(record, input, context, now) {
    return (
      this.hasNotExpired(record, now) &&
      COMPLETED_STATUSES.has(record.status) &&
      Boolean(record.checkedAt) &&
      this.matchesLookupIdentity(record, input, context)
    );
  }

  // ───────────────────── ATTEMPT BUDGET ─────────────────────

  /*
   * Replace the blanket cooldown with a bounded
   * number of database-tracked lookups.
   *
   * Ordinary first corrections happen immediately.
   *
   * Excessive distinct-NIN lookups or excessive
   * paid requests trigger targeted review.
   *
   * These counters remain in the user-scoped
   * temporary document for at least 24 hours,
   * including across application restarts.
   *
   * Longer-lived security audit records and
   * account/IP/device rate limiting are separate
   * integration responsibilities.
   */

  static getAttemptBudget(existing, ninHash, now) {
    const windowStartedAt = existing?.attemptWindowStartedAt
      ? new Date(existing.attemptWindowStartedAt).getTime()
      : NaN;

    const withinWindow =
      Number.isFinite(windowStartedAt) &&
      windowStartedAt <= now.getTime() &&
      now.getTime() - windowStartedAt < ATTEMPT_WINDOW_MS;

    const previousHashes = withinWindow
      ? Array.isArray(existing?.attemptDistinctNINHashes)
        ? existing.attemptDistinctNINHashes
        : []
      : [];

    const previousCount = withinWindow ? Number(existing?.attemptCount || 0) : 0;

    const distinctHashes = [...new Set([...previousHashes, ninHash])];

    if (
      distinctHashes.length > MAX_DISTINCT_NINS_PER_WINDOW ||
      previousCount >= MAX_LOOKUPS_PER_WINDOW
    ) {
      throw this.createError({
        message:
          "We need to review further NIN verification attempts on this account. Please contact support.",
        code: "NIN_ONBOARDING_REVIEW_REQUIRED",
        statusCode: 429,
      });
    }

    return {
      attemptWindowStartedAt: withinWindow ? new Date(windowStartedAt) : now,

      attemptCount: previousCount + 1,

      attemptDistinctNINHashes: distinctHashes,
    };
  }

  // ───────────────────── PUBLIC RESPONSE ─────────────────────

  /*
   * Only authenticated and authorised callers
   * may expose this result to the account owner.
   *
   * A corrected or superseded preview must never
   * be presented as the current identity.
   *
   * Acknowledgement does not authenticate
   * NIN ownership.
   */

  static getPublicResult(record, { cached = false } = {}) {
    const matched = record.status === "matched";

    const stagingOnly = record.providerEnvironment !== "production";

    const correctionPending = Boolean(record.correctionRequestedAt);

    const validResult = this.hasNotExpired(record);

    const acknowledged =
      matched &&
      validResult &&
      !correctionPending &&
      Boolean(record.nameAcknowledgedAt) &&
      record.nameAcknowledgedRequestReference === record.requestReference;

    const eligibleForOnboarding = acknowledged && !stagingOnly;

    let registryLegalName = null;

    if (matched && validResult && !correctionPending) {
      this.assertNamePreviewAllowed(record.provider);

      const legalName = this.normalizeRegistryLegalName(record.registryLegalName);

      registryLegalName = {
        firstName: legalName.firstName,
        middleName: legalName.middleName,
        lastName: legalName.lastName,
      };
    }

    let message;

    if (correctionPending) {
      message = "Enter the correct NIN to continue.";
    } else if (matched && !validResult) {
      message = "Your NIN lookup has expired. Please verify again.";
    } else {
      switch (record.status) {
        case "matched":
          message = stagingOnly
            ? "Sandbox NIN record found. Production verification is required."
            : acknowledged
              ? "Registry name acknowledged. You can continue onboarding."
              : "NIN record found. Please review and confirm your legal name.";
          break;

        case "needs_review":
          message = "NIN registry information requires additional review.";
          break;

        case "not_found":
          message = "We couldn't confirm this NIN. Check the number and try again.";
          break;

        case "failed":
          message = "NIN verification could not be completed. Please contact support.";
          break;

        default:
          message = "NIN verification is processing.";
      }
    }

    return {
      verificationId: String(record._id),

      /*
       * The internal request reference binds
       * acknowledgement and correction to the
       * exact currently displayed lookup result.
       */

      requestReference: record.requestReference || null,

      status: correctionPending ? "correction_required" : record.status,

      matched: matched && validResult && !correctionPending,

      acknowledged,

      verified: false,
      holderAuthenticated: false,
      requiresHolderAuthentication: true,

      eligibleForOnboarding,

      stagingOnly,
      cached,

      provider: record.provider,
      environment: record.providerEnvironment,

      registryFound: typeof record.registryFound === "boolean" ? record.registryFound : null,

      registryLegalName,

      checkedAt: record.checkedAt || null,
      expiresAt: record.resultExpiresAt || null,

      message,
    };
  }

  // ───────────────────── PROCESSING DATA ─────────────────────

  static buildProcessingData({ input, context, claimId, requestReference, now, budget }) {
    return {
      provider: context.provider,
      providerEnvironment: context.environment,

      ninHash: input.ninHash,
      ninLast4: input.ninLast4,

      status: "processing",

      registryFound: null,
      registryLegalName: null,

      consentAcceptedAt: now,

      processingClaimId: claimId,
      requestReference,
      providerReference: null,

      lookupStartedAt: now,

      processingLeaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS),

      checkedAt: null,

      nameAcknowledgedAt: null,
      nameAcknowledgedRequestReference: null,
      correctionRequestedAt: null,

      resultExpiresAt: null,

      attemptWindowStartedAt: budget.attemptWindowStartedAt,

      attemptCount: budget.attemptCount,

      attemptDistinctNINHashes: budget.attemptDistinctNINHashes,

      consumedAt: null,
      errorCode: null,
      reason: null,

      expiresAt: new Date(now.getTime() + RECORD_RETENTION_MS),
    };
  }

  // ───────────────────── ATOMIC LOOKUP CLAIM ─────────────────────

  static async acquireLookupClaim({ userId, input, context, claimId, requestReference, now }) {
    const existing = await PreOnboardingNINVerification.findOne({
      user: userId,
    }).select(EVIDENCE_SELECTION);

    if (existing) {
      // ───────── IN-FLIGHT LOOKUP ─────────

      if (existing.status === "processing") {
        const leaseExpired =
          existing.processingLeaseExpiresAt && existing.processingLeaseExpiresAt <= now;

        throw this.createError({
          message: leaseExpired
            ? "We couldn't confirm your previous NIN lookup. Please contact support."
            : "NIN verification is already processing.",

          code: leaseExpired
            ? "NIN_ONBOARDING_OUTCOME_UNCERTAIN"
            : "NIN_ONBOARDING_ALREADY_PROCESSING",

          statusCode: 409,
        });
      }

      // ───────── CONSUMED EVIDENCE ─────────

      if (existing.status === "consumed") {
        throw this.createError({
          message: "This NIN verification has already been used.",
          code: "NIN_ONBOARDING_ALREADY_CONSUMED",
          statusCode: 409,
        });
      }

      // ───────── CACHE REUSE ─────────

      if (this.isReusableResult(existing, input, context, now)) {
        if (!existing.correctionRequestedAt) {
          return {
            record: existing,
            cached: true,
          };
        }

        /*
         * The applicant returned to the same NIN
         * during correction.
         *
         * Restore its preview without a second
         * chargeable provider lookup.
         *
         * The old acknowledgement remains cleared.
         */

        const restored = await PreOnboardingNINVerification.findOneAndUpdate(
          {
            _id: existing._id,
            user: userId,
            status: existing.status,
            requestReference: existing.requestReference,
            __v: existing.__v,

            resultExpiresAt: {
              $gt: now,
            },
          },
          {
            $set: {
              correctionRequestedAt: null,

              nameAcknowledgedAt: null,
              nameAcknowledgedRequestReference: null,
            },
            $inc: {
              __v: 1,
            },
          },
          {
            new: true,
            runValidators: true,
          }
        ).select(EVIDENCE_SELECTION);

        if (!restored) {
          throw this.createError({
            message: "Your NIN verification changed. Please refresh and try again.",
            code: "NIN_ONBOARDING_CONCURRENT_REQUEST",
            statusCode: 409,
          });
        }

        return {
          record: restored,
          cached: true,
        };
      }

      // ───────── UNCERTAIN PREVIOUS OUTCOME ─────────

      /*
       * A failed lookup whose provider outcome
       * is uncertain must not automatically
       * repeat the same NIN request.
       *
       * This protects against duplicate charges
       * after an ambiguous timeout.
       *
       * A genuinely different NIN may still be
       * submitted as a correction, subject to
       * account-level attempt limits.
       */

      if (
        existing.status === "failed" &&
        existing.errorCode === "NIN_OUTCOME_UNCERTAIN" &&
        this.matchesLookupIdentity(existing, input, context)
      ) {
        throw this.createError({
          message:
            "We couldn't confirm the previous lookup outcome. Please contact support before retrying this NIN.",
          code: "NIN_ONBOARDING_OUTCOME_UNCERTAIN",
          statusCode: 409,
        });
      }

      // ───────── IMMEDIATE CORRECTION ─────────

      /*
       * There is intentionally no blanket
       * time-based cooldown here.
       *
       * The new NIN replaces the old result
       * immediately after a successful atomic claim.
       *
       * Previous name acknowledgement and
       * legal-name evidence are cleared.
       */

      const budget = this.getAttemptBudget(existing, input.ninHash, now);

      const processingData = this.buildProcessingData({
        input,
        context,
        claimId,
        requestReference,
        now,
        budget,
      });

      const claimed = await PreOnboardingNINVerification.findOneAndUpdate(
        {
          _id: existing._id,
          user: userId,

          status: existing.status,
          __v: existing.__v,
        },
        {
          $set: processingData,

          $inc: {
            __v: 1,
          },
        },
        {
          new: true,
          runValidators: true,
        }
      ).select(EVIDENCE_SELECTION);

      if (!claimed) {
        throw this.createError({
          message: "Another NIN verification request is processing.",
          code: "NIN_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }

      return {
        record: claimed,
        cached: false,
      };
    }

    // ───────── FIRST LOOKUP ─────────

    const budget = this.getAttemptBudget(null, input.ninHash, now);

    const processingData = this.buildProcessingData({
      input,
      context,
      claimId,
      requestReference,
      now,
      budget,
    });

    try {
      const created = await PreOnboardingNINVerification.create({
        user: userId,
        ...processingData,
      });

      return {
        record: created,
        cached: false,
      };
    } catch (error) {
      if (error?.code === 11000) {
        throw this.createError({
          message: "Another NIN verification request is processing.",
          code: "NIN_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }

      throw error;
    }
  }

  // ───────────────────── COMPLETE LOOKUP CLAIM ─────────────────────

  static async completeClaim({ recordId, userId, claimId, updates }) {
    if (!updates || !["matched", "not_found", "failed", "needs_review"].includes(updates.status)) {
      throw this.createError({
        message: "Invalid NIN lookup completion status.",
        code: "NIN_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    const checkedAt = new Date(updates.checkedAt);

    if (Number.isNaN(checkedAt.getTime())) {
      throw this.createError({
        message: "Invalid NIN lookup completion timestamp.",
        code: "NIN_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    let legalName = null;

    if (updates.status === "matched") {
      if (updates.registryFound !== true) {
        throw this.createError({
          message: "Matched NIN evidence requires a confirmed registry record.",
          code: "NIN_ONBOARDING_INVALID_COMPLETION",
          statusCode: 500,
        });
      }

      legalName = this.normalizeRegistryLegalName(updates.registryLegalName);
    } else if (updates.registryLegalName != null) {
      throw this.createError({
        message: "Unsuccessful NIN lookup cannot establish a legal name.",
        code: "NIN_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    if (updates.status === "not_found" && updates.registryFound !== false) {
      throw this.createError({
        message: "Not-found NIN evidence is inconsistent.",
        code: "NIN_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    const record = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        _id: recordId,
        user: userId,

        status: "processing",
        processingClaimId: claimId,

        expiresAt: {
          $gt: new Date(),
        },
      },
      {
        $set: {
          status: updates.status,

          checkedAt,

          registryFound: updates.registryFound ?? null,

          registryLegalName: legalName
            ? {
                firstName: legalName.firstName,
                middleName: legalName.middleName,
                lastName: legalName.lastName,
              }
            : null,

          providerReference: updates.providerReference || null,

          reason: updates.reason || null,

          errorCode: updates.errorCode || null,

          processingClaimId: null,

          processingLeaseExpiresAt: null,

          /*
           * Validity of lookup evidence is
           * separate from the TTL retention
           * of the attempt-budget record.
           */

          resultExpiresAt: new Date(checkedAt.getTime() + RESULT_TTL_MS),

          nameAcknowledgedAt: null,
          nameAcknowledgedRequestReference: null,
          correctionRequestedAt: null,
        },

        $inc: {
          __v: 1,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).select(EVIDENCE_SELECTION);

    if (!record) {
      throw this.createError({
        message: "The NIN lookup result could not be recorded safely.",
        code: "NIN_ONBOARDING_CLAIM_LOST",
        statusCode: 409,
      });
    }

    return record;
  }

  // ───────────────────── PROVIDER RESULT ASSESSMENT ─────────────────────

  static evaluateLookup({ lookup }) {
    if (
      !lookup ||
      typeof lookup.registryFound !== "boolean" ||
      lookup.holderAuthenticated !== false
    ) {
      throw this.createError({
        message: "NIN provider returned an indeterminate registry outcome.",
        code: "NIN_ONBOARDING_INCOMPLETE_RESPONSE",
        statusCode: 502,
      });
    }

    if (lookup.registryFound === false) {
      if (lookup.registryLegalName != null || lookup.nameOnRecord != null) {
        throw this.createError({
          message: "NIN provider returned inconsistent registry evidence.",
          code: "NIN_ONBOARDING_INCOMPLETE_RESPONSE",
          statusCode: 502,
        });
      }

      return {
        status: "not_found",

        registryFound: false,

        registryLegalName: null,

        reason: "NIN registry record not confirmed.",
      };
    }

    const legalName = this.normalizeRegistryLegalName(lookup.registryLegalName);

    if (lookup.nameOnRecord !== legalName.nameOnRecord) {
      throw this.createError({
        message: "NIN provider returned inconsistent legal-name evidence.",
        code: "NIN_ONBOARDING_INCOMPLETE_RESPONSE",
        statusCode: 502,
      });
    }

    return {
      status: "matched",

      registryFound: true,

      registryLegalName: {
        firstName: legalName.firstName,
        middleName: legalName.middleName,
        lastName: legalName.lastName,
      },

      reason: "NIN registry record confirmed. Holder authentication remains outstanding.",
    };
  }

  // ───────────────────── VERIFY NIN ─────────────────────

  static async verifyNIN({ userId, nin, consentAccepted } = {}) {
    this.assertSchemaReady();

    await this.assertProfessionalCanVerify(userId);

    if (consentAccepted !== true) {
      throw this.createError({
        message: "Consent is required before checking your NIN.",
        code: "NIN_ONBOARDING_CONSENT_REQUIRED",
        statusCode: 400,
      });
    }

    const normalizedNIN = this.normalizeNIN(nin);

    const context = this.getProviderContext();

    /*
     * Prevent chargeable lookups when the
     * current provider cannot legally support
     * the agreed full-name preview UX.
     */

    this.assertNamePreviewAllowed(context.provider);

    const input = {
      ninHash: this.getNINHash(normalizedNIN),

      ninLast4: normalizedNIN.slice(-4),
    };

    const now = new Date();

    const claimId = crypto.randomUUID();
    const requestReference = crypto.randomUUID();

    const claim = await this.acquireLookupClaim({
      userId,
      input,
      context,
      claimId,
      requestReference,
      now,
    });

    // ───────── SAME-NIN CACHE ─────────

    if (claim.cached) {
      return this.getPublicResult(claim.record, { cached: true });
    }

    let lookup = null;
    let lookupError = null;

    /*
     * Exactly one provider request per claim.
     *
     * No provider request occurs inside a
     * MongoDB onboarding transaction.
     *
     * Do not send account registration names.
     *
     * Raw NIN stays in memory only.
     */

    try {
      lookup = await IdentityVerificationService.lookupIdentityRecord({
        method: "nin",

        identifier: normalizedNIN,

        reference: requestReference,
      });

      if (
        lookup.method !== "nin" ||
        lookup.provider !== context.provider ||
        lookup.environment !== context.environment ||
        lookup.requestReference !== requestReference ||
        lookup.holderAuthenticated !== false
      ) {
        throw this.createError({
          message: "NIN verification context mismatch.",
          code: "NIN_ONBOARDING_CONTEXT_MISMATCH",
          statusCode: 409,
        });
      }
    } catch (error) {
      lookupError = error;
    }

    const checkedAt = new Date();

    // ───────── PROVIDER FAILURE ─────────

    if (lookupError) {
      /*
       * A failed provider call may have been
       * accepted or charged remotely.
       *
       * Mark its outcome uncertain rather than
       * silently retrying the same identifier.
       */

      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,

        updates: {
          status: "failed",
          checkedAt,

          registryFound: null,
          registryLegalName: null,

          reason: "The NIN provider lookup could not be confirmed.",

          errorCode: "NIN_OUTCOME_UNCERTAIN",
        },
      });

      return this.getPublicResult(record);
    }

    // ───────── ASSESS RESPONSE ─────────

    let evaluation;

    try {
      evaluation = this.evaluateLookup({ lookup });
    } catch (_) {
      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,

        updates: {
          status: "failed",
          checkedAt,

          registryFound: null,
          registryLegalName: null,

          reason: "NIN evidence could not be safely evaluated.",

          errorCode: "NIN_ONBOARDING_EVALUATION_FAILED",
        },
      });

      return this.getPublicResult(record);
    }

    // ───────── SAVE RESULT ─────────

    const record = await this.completeClaim({
      recordId: claim.record._id,
      userId,
      claimId,

      updates: {
        status: evaluation.status,

        checkedAt,

        providerReference: lookup.providerReference || null,

        registryFound: evaluation.registryFound,

        registryLegalName: evaluation.registryLegalName,

        reason: evaluation.reason,

        errorCode: null,
      },
    });

    return this.getPublicResult(record);
  }

  // ───────────────────── NAME ACKNOWLEDGEMENT ─────────────────────

  /*
   * The applicant acknowledges the legal name
   * returned by the currently displayed lookup.
   *
   * The requestReference pins the action to
   * the exact lookup attempt being confirmed.
   *
   * An old browser tab cannot confirm a
   * superseded verification result.
   *
   * Acknowledgement is not identity-holder
   * authentication.
   */

  static async acknowledgeRegistryName({ userId, requestReference } = {}) {
    this.assertSchemaReady();

    await this.assertProfessionalCanVerify(userId);

    const reference = this.normalizeRequestReference(requestReference);

    const now = new Date();

    const record = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        user: userId,

        status: "matched",
        requestReference: reference,

        registryFound: true,
        correctionRequestedAt: null,

        resultExpiresAt: {
          $gt: now,
        },
      },
      {
        $set: {
          nameAcknowledgedAt: now,

          nameAcknowledgedRequestReference: reference,
        },

        $inc: {
          __v: 1,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).select(EVIDENCE_SELECTION);

    if (!record) {
      throw this.createError({
        message: "This NIN preview is no longer current. Please verify your NIN again.",
        code: "NIN_ONBOARDING_PREVIEW_UNAVAILABLE",
        statusCode: 409,
      });
    }

    return this.getPublicResult(record);
  }

  // ───────────────────── BEGIN IMMEDIATE CORRECTION ─────────────────────

  /*
   * Called when the applicant selects:
   *
   * "No, correct my NIN".
   *
   * This immediately clears the current
   * name acknowledgement.
   *
   * No blanket cooldown is applied.
   *
   * The old provider evidence remains cached
   * temporarily so re-entering the exact same
   * NIN need not trigger another paid request.
   *
   * The old result is not consumable while
   * correctionRequestedAt is present.
   *
   * A different NIN may replace the evidence
   * atomically through verifyNIN.
   */

  static async beginNINCorrection({ userId, requestReference } = {}) {
    this.assertSchemaReady();

    await this.assertProfessionalCanVerify(userId);

    const reference = this.normalizeRequestReference(requestReference);

    const now = new Date();

    const record = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        user: userId,

        status: "matched",
        requestReference: reference,

        consumedAt: null,

        resultExpiresAt: {
          $gt: now,
        },
      },
      {
        $set: {
          correctionRequestedAt: now,

          nameAcknowledgedAt: null,
          nameAcknowledgedRequestReference: null,
        },

        $inc: {
          __v: 1,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).select(EVIDENCE_SELECTION);

    if (!record) {
      throw this.createError({
        message: "This NIN preview has changed. Please start verification again.",
        code: "NIN_ONBOARDING_CORRECTION_UNAVAILABLE",
        statusCode: 409,
      });
    }

    return this.getPublicResult(record);
  }

  // ───────────────────── ONBOARDING EVIDENCE ─────────────────────

  /*
   * Trusted internal method.
   *
   * Normal professional onboarding requires:
   *
   * - Eligible professional account;
   * - Successful production NIN lookup;
   * - Valid, unexpired evidence;
   * - Explicit user name acknowledgement;
   * - Acknowledgement of the current lookup;
   * - No pending NIN correction;
   * - Complete structured registryLegalName;
   * - Valid HMAC-protected identifier evidence.
   *
   * Registry lookup and acknowledgement do not
   * establish identity-holder authentication.
   *
   * No external provider call occurs here.
   */

  static async getEvidenceForOnboarding({ userId, session = null } = {}) {
    this.assertSchemaReady();

    await this.assertProfessionalCanVerify(userId, session);

    const query = PreOnboardingNINVerification.findOne({
      user: userId,
    }).select(EVIDENCE_SELECTION);

    if (session) {
      query.session(session);
    }

    const evidence = await query;

    if (!evidence) {
      return null;
    }

    const now = new Date();

    // ───────── IN-FLIGHT LOOKUP ─────────

    if (evidence.status === "processing") {
      throw this.createError({
        message: "NIN verification is still processing or requires support review.",
        code: "NIN_ONBOARDING_ALREADY_PROCESSING",
        statusCode: 409,
      });
    }

    // ───────── ALREADY CONSUMED ─────────

    if (evidence.status === "consumed") {
      throw this.createError({
        message: "This NIN verification has already been used.",
        code: "NIN_ONBOARDING_ALREADY_CONSUMED",
        statusCode: 409,
      });
    }

    // ───────── REQUIRED RESULT ─────────

    if (evidence.status !== CONSUMABLE_STATUS || evidence.registryFound !== true) {
      throw this.createError({
        message: "A successful NIN registry lookup is required before continuing.",
        code: "NIN_ONBOARDING_NOT_MATCHED",
        statusCode: 409,
      });
    }

    // ───────── PRODUCTION ONLY ─────────

    if (evidence.providerEnvironment !== "production") {
      throw this.createError({
        message: "Production NIN verification is required to continue.",
        code: "NIN_ONBOARDING_PRODUCTION_REQUIRED",
        statusCode: 409,
      });
    }

    // ───────── RESULT VALIDITY ─────────

    if (!this.hasNotExpired(evidence, now) || evidence.consumedAt) {
      throw this.createError({
        message: "NIN verification has expired. Please verify again.",
        code: "NIN_ONBOARDING_EVIDENCE_EXPIRED",
        statusCode: 409,
      });
    }

    // ───────── NO CORRECTION IN PROGRESS ─────────

    if (evidence.correctionRequestedAt) {
      throw this.createError({
        message: "Complete your NIN correction before continuing.",
        code: "NIN_ONBOARDING_CORRECTION_PENDING",
        statusCode: 409,
      });
    }

    // ───────── CURRENT NAME ACKNOWLEDGEMENT ─────────

    const acknowledgedAt = evidence.nameAcknowledgedAt
      ? new Date(evidence.nameAcknowledgedAt).getTime()
      : NaN;

    const checkedAt = evidence.checkedAt ? new Date(evidence.checkedAt).getTime() : NaN;

    const lookupStartedAt = evidence.lookupStartedAt
      ? new Date(evidence.lookupStartedAt).getTime()
      : NaN;

    const consentAcceptedAt = evidence.consentAcceptedAt
      ? new Date(evidence.consentAcceptedAt).getTime()
      : NaN;

    if (
      !Number.isFinite(acknowledgedAt) ||
      !Number.isFinite(checkedAt) ||
      !Number.isFinite(lookupStartedAt) ||
      !Number.isFinite(consentAcceptedAt) ||
      acknowledgedAt < checkedAt ||
      acknowledgedAt > now.getTime() ||
      checkedAt < lookupStartedAt ||
      checkedAt > now.getTime() ||
      consentAcceptedAt > lookupStartedAt ||
      evidence.nameAcknowledgedRequestReference !== evidence.requestReference
    ) {
      throw this.createError({
        message: "Please confirm your current NIN registry name before continuing.",
        code: "NIN_ONBOARDING_NAME_NOT_ACKNOWLEDGED",
        statusCode: 409,
      });
    }

    // ───────── IDENTIFIER AND PROVIDER EVIDENCE ─────────

    if (
      !["ninja", "dojah"].includes(evidence.provider) ||
      !/^[a-f0-9]{64}$/.test(evidence.ninHash || "") ||
      !/^\d{4}$/.test(evidence.ninLast4 || "") ||
      typeof evidence.requestReference !== "string" ||
      !evidence.requestReference
    ) {
      throw this.createError({
        message: "NIN verification evidence is incomplete. Please contact support.",
        code: "NIN_ONBOARDING_INVALID_EVIDENCE",
        statusCode: 409,
      });
    }

    // ───────── REGISTRY LEGAL NAME ─────────

    this.normalizeRegistryLegalName(evidence.registryLegalName);

    return evidence;
  }

  // ───────────────────── TRANSACTIONAL CONSUMPTION ─────────────────────

  /*
   * Only trusted onboarding services should
   * invoke this method.
   *
   * The permanent NIN KYC record, User legal
   * names and legal-name provenance must be
   * persisted in the same transaction.
   *
   * If onboarding fails, evidence consumption
   * is rolled back.
   */

  static async consumeForOnboarding({ userId, session } = {}) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.createError({
        message: "An active onboarding transaction is required.",
        code: "NIN_ONBOARDING_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    const evidence = await this.getEvidenceForOnboarding({
      userId,
      session,
    });

    if (!evidence) {
      return null;
    }

    const consumedAt = new Date();

    /*
     * The acknowledgement, reference and correction
     * state are checked again in the atomic update.
     *
     * A superseded or newly corrected lookup
     * cannot be consumed using stale evidence.
     */

    const consumed = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        _id: evidence._id,
        user: userId,

        status: CONSUMABLE_STATUS,
        consumedAt: null,

        providerEnvironment: "production",
        registryFound: true,

        requestReference: evidence.requestReference,

        nameAcknowledgedAt: evidence.nameAcknowledgedAt,

        nameAcknowledgedRequestReference: evidence.requestReference,

        correctionRequestedAt: null,

        resultExpiresAt: {
          $gt: consumedAt,
        },

        expiresAt: {
          $gt: consumedAt,
        },
      },
      {
        $set: {
          status: "consumed",
          consumedAt,
        },

        $inc: {
          __v: 1,
        },
      },
      {
        new: true,
        runValidators: true,
        session,
      }
    );

    if (!consumed) {
      throw this.createError({
        message: "NIN evidence is no longer valid or has already been used.",
        code: "NIN_ONBOARDING_EVIDENCE_UNAVAILABLE",
        statusCode: 409,
      });
    }

    /*
     * Return the already validated matched
     * evidence, including registryLegalName.
     *
     * OnboardingService creates permanent KYC
     * evidence and saves User legal names in
     * the same transaction.
     *
     * This does not independently authenticate
     * the NIN holder or approve the professional.
     */

    return evidence;
  }
}

module.exports = PreOnboardingNINVerificationService;
