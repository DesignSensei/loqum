// services/preOnboardingNINVerificationService.js

const mongoose = require("mongoose");
const crypto = require("crypto");

const User = require("../models/User");
const PreOnboardingNINVerification = require("../models/PreOnboardingNINVerification");
const NINLookupAttempt = require("../models/NINLookupAttempt");

const { runWithOptionalTransaction } = require("./helpers/transactionHelper");
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
   * Changing NIN is unavailable while a provider
   * request is processing or unresolved.
   *
   * Starting a correction invalidates the existing
   * name acknowledgement.
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
   * Registry lookup and name acknowledgement do NOT
   * establish identity-holder authentication.
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
   * Required evidence fields must exist before
   * any potentially chargeable provider lookup.
   *
   * Fail closed if acknowledgement, correction
   * or attempt-budget fields are unavailable.
   */

  static assertSchemaReady() {
    const missing = REQUIRED_SCHEMA_FIELDS.filter(
      (field) => !PreOnboardingNINVerification.schema.path(field)
    );

    const statusPath = PreOnboardingNINVerification.schema.path("status");

    if (
      missing.length > 0 ||
      !statusPath ||
      !Array.isArray(statusPath.enumValues) ||
      !statusPath.enumValues.includes("cancelled")
    ) {
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

    const normalized = IdentityVerificationService.normalizeIdentifier(nin);

    if (typeof normalized !== "string" || !/^\d{11}$/.test(normalized)) {
      throw this.createError({
        message: "Enter a valid 11-digit NIN.",
        code: "NIN_ONBOARDING_INVALID_NIN",
        statusCode: 400,
      });
    }

    return normalized;
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
     * A dedicated HMAC-SHA256 secret protects the
     * NIN more effectively than an unkeyed hash.
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
     * Registration names and date of birth
     * are not used for NIN registry matching.
     *
     * Official names originate from trusted
     * NIN registry evidence.
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
   * Full-name preview requires approved provider
   * permissions and a completed privacy assessment.
   *
   * Provider-specific flags default to disabled.
   *
   * Check permission before initiating a lookup
   * that may incur a charge.
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
   * resultExpiresAt determines whether completed
   * registry evidence can be reused or consumed.
   *
   * expiresAt controls temporary document retention.
   *
   * TTL cleanup does not impose a correction cooldown
   * or reset the persistent attempt history.
   */

  static hasNotExpired(record, now = new Date()) {
    const expiry = record?.resultExpiresAt ? new Date(record.resultExpiresAt).getTime() : NaN;

    const retention = record?.expiresAt ? new Date(record.expiresAt).getTime() : NaN;

    return (
      Number.isFinite(expiry) &&
      Number.isFinite(retention) &&
      expiry > now.getTime() &&
      retention > now.getTime()
    );
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
   * Maximum 8 lookup attempts across up to
   * 4 distinct NINs in a rolling 24-hour window.
   *
   * NINLookupAttempt is the durable source.
   *
   * There is no blanket correction cooldown.
   *
   * Pending and uncertain provider outcomes block
   * additional paid lookups until resolved.
   *
   * The next eligible time is based on actual
   * lookup timestamps, not the latest attempt
   * plus an arbitrary waiting period.
   */

  static async getAttemptBudget(existing, ninHash, now, userId, session) {
    // ───────── BLOCK UNRESOLVED PROVIDER ATTEMPTS ─────────

    /*
     * A different NIN must not bypass an unresolved
     * provider request belonging to the same account.
     *
     * This also protects the account if temporary
     * evidence is replaced or removed by TTL cleanup.
     */

    const unresolved = await NINLookupAttempt.findOne({
      user: userId,
      status: {
        $in: ["pending", "uncertain"],
      },
    })
      .select("status")
      .session(session);

    if (unresolved) {
      throw this.createError({
        message:
          "A previous NIN lookup is unresolved. Please contact support before requesting another lookup.",
        code: "NIN_ONBOARDING_OUTCOME_UNCERTAIN",
        statusCode: 409,
      });
    }

    // ───────── LOAD ROLLING 24-HOUR ATTEMPTS ─────────

    /*
     * Read the current window from durable records.
     *
     * Do not cap the query at eight results because
     * the precise retry time should remain correct
     * if historical records exceed the normal limit.
     */

    const attempts = await NINLookupAttempt.find({
      user: userId,
      startedAt: {
        $gt: new Date(now.getTime() - ATTEMPT_WINDOW_MS),
        $lte: now,
      },
    })
      .select("+ninHash startedAt")
      .sort({ startedAt: 1 })
      .session(session)
      .lean();

    const distinctHashes = new Set(attempts.map((attempt) => attempt.ninHash));

    const totalLimitReached = attempts.length >= MAX_LOOKUPS_PER_WINDOW;

    const distinctLimitReached =
      !distinctHashes.has(ninHash) && distinctHashes.size >= MAX_DISTINCT_NINS_PER_WINDOW;

    // ───────── CALCULATE NEXT ELIGIBLE TIME ─────────

    if (totalLimitReached || distinctLimitReached) {
      let nextEligibleAtMs = 0;

      if (totalLimitReached) {
        /*
         * Enough old attempts must leave the window
         * to reduce the active count below eight.
         *
         * With exactly eight attempts, the oldest
         * timestamp is the one that matters.
         */

        const index = attempts.length - MAX_LOOKUPS_PER_WINDOW;

        const totalEligibleAt = new Date(attempts[index].startedAt).getTime() + ATTEMPT_WINDOW_MS;

        nextEligibleAtMs = Math.max(nextEligibleAtMs, totalEligibleAt);
      }

      if (distinctLimitReached) {
        /*
         * A distinct NIN remains counted until its
         * most recent lookup leaves the window.
         *
         * For a fifth NIN, at least one existing
         * identifier must stop counting.
         *
         * This also handles an abnormal history
         * containing more than four identifiers.
         */

        const lastLookupByHash = new Map();

        for (const attempt of attempts) {
          const startedAtMs = new Date(attempt.startedAt).getTime();

          const previous = lastLookupByHash.get(attempt.ninHash) || 0;

          lastLookupByHash.set(attempt.ninHash, Math.max(previous, startedAtMs));
        }

        const expiryTimes = [...lastLookupByHash.values()]
          .map((startedAtMs) => startedAtMs + ATTEMPT_WINDOW_MS)
          .sort((first, second) => first - second);

        const index = expiryTimes.length - MAX_DISTINCT_NINS_PER_WINDOW;

        nextEligibleAtMs = Math.max(nextEligibleAtMs, expiryTimes[index]);
      }

      /*
       * If both limits apply, the later expiry wins.
       * Both restrictions must be satisfied before
       * another chargeable lookup is allowed.
       */

      const nextEligibleAt = new Date(nextEligibleAtMs).toISOString();

      const retryAfterSeconds = Math.max(1, Math.ceil((nextEligibleAtMs - now.getTime()) / 1000));

      const limitType =
        totalLimitReached && distinctLimitReached
          ? "both"
          : totalLimitReached
            ? "total"
            : "distinct";

      const message = totalLimitReached
        ? "You have reached the limit of 8 NIN lookups in 24 hours. Please try again when your allowance becomes available."
        : "You have reached the limit of 4 different NINs in 24 hours. Please try again when your allowance becomes available.";

      const error = this.createError({
        message,
        code: "NIN_ONBOARDING_RATE_LIMITED",
        statusCode: 429,
        details: {
          limitType,
          nextEligibleAt,
          retryAfterSeconds,
        },
      });

      /*
       * These explicit properties allow the
       * controller to expose approved retry fields
       * without returning arbitrary error details.
       */

      error.nextEligibleAt = nextEligibleAt;
      error.retryAfterSeconds = retryAfterSeconds;
      error.limitType = limitType;

      throw error;
    }

    // ───────── LOOKUP IS WITHIN ALLOWANCE ─────────

    return {
      attemptWindowStartedAt: attempts[0]?.startedAt || now,

      attemptCount: attempts.length + 1,

      attemptDistinctNINHashes: [...new Set([...distinctHashes, ninHash])],
    };
  }

  static async recordAttempt({ userId, input, context, claimId, requestReference, now, session }) {
    await NINLookupAttempt.create(
      [
        {
          user: userId,
          ninHash: input.ninHash,

          provider: context.provider,
          providerEnvironment: context.environment,

          processingClaimId: claimId,
          requestReference,

          startedAt: now,
          status: "pending",
        },
      ],
      { session }
    );
  }

  // ───────────────────── PUBLIC RESPONSE ─────────────────────

  /*
   * Only authenticated authorised callers may
   * receive registry-name preview information.
   *
   * Corrected or superseded evidence must not be
   * displayed as the current identity.
   *
   * Acknowledgement does not authenticate
   * ownership of the NIN.
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
       * This reference pins name acknowledgement
       * and correction to the displayed result.
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

  static async acquireLookupClaim(args) {
    return runWithOptionalTransaction({}, (session) =>
      this.acquireLookupClaimInTransaction(args, session)
    );
  }

  static async acquireLookupClaimInTransaction(
    { userId, input, context, claimId, requestReference, now },
    session
  ) {
    const existing = await PreOnboardingNINVerification.findOne({
      user: userId,
    })
      .select(EVIDENCE_SELECTION)
      .session(session);

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
         * after beginning a correction.
         *
         * Restore its valid cached preview without
         * another potentially chargeable lookup.
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

            expiresAt: {
              $gt: now,
            },

            resultExpiresAt: {
              $gt: now,
            },
          },
          {
            $set: {
              requestReference,
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
        )
          .select(EVIDENCE_SELECTION)
          .session(session);

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
       * A previous uncertain provider result must
       * not trigger another paid request.
       *
       * The durable attempt-budget check also
       * blocks a different NIN while an unresolved
       * provider attempt exists.
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

      // ───────── REPLACEMENT LOOKUP ─────────

      /*
       * No blanket correction cooldown applies.
       *
       * A new NIN replaces the earlier temporary
       * evidence after the previous request has
       * safely completed and attempt limits pass.
       */

      const budget = await this.getAttemptBudget(existing, input.ninHash, now, userId, session);

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
      )
        .select(EVIDENCE_SELECTION)
        .session(session);

      if (!claimed) {
        throw this.createError({
          message: "Another NIN verification request is processing.",
          code: "NIN_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }

      await this.recordAttempt({
        userId,
        input,
        context,
        claimId,
        requestReference,
        now,
        session,
      });

      return {
        record: claimed,
        cached: false,
      };
    }

    // ───────── FIRST LOOKUP ─────────

    const budget = await this.getAttemptBudget(null, input.ninHash, now, userId, session);

    const processingData = this.buildProcessingData({
      input,
      context,
      claimId,
      requestReference,
      now,
      budget,
    });

    try {
      const [created] = await PreOnboardingNINVerification.create(
        [
          {
            user: userId,
            ...processingData,
          },
        ],
        { session }
      );

      await this.recordAttempt({
        userId,
        input,
        context,
        claimId,
        requestReference,
        now,
        session,
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

  static async completeClaim(args) {
    return runWithOptionalTransaction({}, (session) =>
      this.completeClaimInTransaction(args, session)
    );
  }

  static async completeClaimInTransaction(
    { recordId, userId, claimId, requestReference, context, updates },
    session
  ) {
    if (!updates || !["matched", "not_found", "failed", "needs_review"].includes(updates.status)) {
      throw this.createError({
        message: "Invalid NIN lookup completion status.",
        code: "NIN_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    const checkedAt =
      updates.checkedAt instanceof Date ? new Date(updates.checkedAt) : new Date(NaN);

    if (
      Number.isNaN(checkedAt.getTime()) ||
      checkedAt > new Date() ||
      !context ||
      !requestReference
    ) {
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

    if (updates.status === "failed" && updates.registryFound != null) {
      throw this.createError({
        message: "Failed lookup cannot confirm a registry outcome.",
        code: "NIN_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    const resultExpiresAt = new Date(checkedAt.getTime() + RESULT_TTL_MS);

    /*
     * The claim ID and request reference fence the
     * provider response to the original lookup.
     *
     * Do not require correctionRequestedAt to be
     * null here or overwrite that flag.
     *
     * If a correction was marked concurrently,
     * the provider result can still be recorded
     * without making it eligible for onboarding.
     */

    const record = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        _id: recordId,
        user: userId,

        status: "processing",
        processingClaimId: claimId,
        requestReference,

        provider: context.provider,
        providerEnvironment: context.environment,

        lookupStartedAt: {
          $lte: checkedAt,
        },

        expiresAt: {
          $gte: resultExpiresAt,
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
           * Result validity is separate from
           * the retention period of audit history.
           */

          resultExpiresAt,

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
        session,
      }
    ).select(EVIDENCE_SELECTION);

    if (!record) {
      throw this.createError({
        message: "The NIN lookup result could not be recorded safely.",
        code: "NIN_ONBOARDING_CLAIM_LOST",
        statusCode: 409,
      });
    }

    const attempt = await NINLookupAttempt.findOneAndUpdate(
      {
        user: userId,
        processingClaimId: claimId,
        requestReference,

        status: "pending",

        provider: context.provider,
        providerEnvironment: context.environment,
      },
      {
        $set: {
          status: updates.status === "failed" ? "uncertain" : updates.status,

          completedAt: checkedAt,
        },
      },
      {
        new: true,
        runValidators: true,
        session,
      }
    );

    if (!attempt) {
      throw this.createError({
        message: "NIN lookup audit claim is unavailable.",
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
     * Prevent chargeable requests when full-name
     * preview permission is unavailable.
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
     * No provider request runs inside the MongoDB
     * onboarding transaction.
     *
     * Raw NIN stays in memory only.
     * No registration names are sent.
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
       * A failed provider call may have been accepted
       * or charged remotely.
       *
       * Record its uncertain outcome. Never
       * automatically retry the request.
       */

      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,
        requestReference,
        context,

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

    // ───────── ASSESS PROVIDER RESPONSE ─────────

    let evaluation;

    try {
      evaluation = this.evaluateLookup({ lookup });
    } catch {
      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,
        requestReference,
        context,

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

    // ───────── PERSIST PROVIDER RESULT ─────────

    const record = await this.completeClaim({
      recordId: claim.record._id,
      userId,
      claimId,
      requestReference,
      context,

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
   * displayed for the current registry lookup.
   *
   * requestReference prevents an old browser tab
   * from confirming superseded evidence.
   *
   * Acknowledgement does not authenticate
   * ownership of the NIN.
   */

  static async acknowledgeRegistryName({ userId, requestReference } = {}) {
    this.assertSchemaReady();

    await this.assertProfessionalCanVerify(userId);

    const reference = this.normalizeRequestReference(requestReference);

    const now = new Date();

    const evidence = await PreOnboardingNINVerification.findOne({
      user: userId,
      requestReference: reference,
    }).select(EVIDENCE_SELECTION);

    if (
      !evidence ||
      evidence.status !== "matched" ||
      evidence.registryFound !== true ||
      evidence.correctionRequestedAt ||
      evidence.consumedAt ||
      !this.hasNotExpired(evidence, now) ||
      !evidence.checkedAt ||
      evidence.checkedAt > now ||
      evidence.checkedAt < evidence.lookupStartedAt
    ) {
      throw this.createError({
        message: "This NIN preview is no longer current. Please verify your NIN again.",
        code: "NIN_ONBOARDING_PREVIEW_UNAVAILABLE",
        statusCode: 409,
      });
    }

    // Confirm disclosure permission before acknowledgement.
    this.assertNamePreviewAllowed(evidence.provider);

    this.normalizeRegistryLegalName(evidence.registryLegalName);

    const record = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        _id: evidence._id,
        user: userId,
        __v: evidence.__v,

        status: "matched",
        requestReference: reference,

        registryFound: true,
        correctionRequestedAt: null,
        consumedAt: null,

        resultExpiresAt: {
          $gt: now,
        },

        expiresAt: {
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
        message: "This NIN preview has changed. Please refresh and try again.",
        code: "NIN_ONBOARDING_PREVIEW_UNAVAILABLE",
        statusCode: 409,
      });
    }

    return this.getPublicResult(record);
  }

  // ───────────────────── CHANGE NIN ─────────────────────

  /*
   * Called when the applicant selects:
   *
   * "No, enter a different NIN".
   *
   * A processing claim must never be cancelled
   * or released while its provider request is active.
   *
   * For a completed result, correction clears
   * any existing name acknowledgement.
   *
   * Matched evidence can remain cached temporarily,
   * but cannot be consumed during correction.
   *
   * No blanket correction cooldown applies.
   */

  static async beginNINCorrection({ userId, requestReference } = {}) {
    this.assertSchemaReady();

    await this.assertProfessionalCanVerify(userId);

    const reference = this.normalizeRequestReference(requestReference);

    const now = new Date();

    const existing = await PreOnboardingNINVerification.findOne({
      user: userId,
      requestReference: reference,
    }).select(EVIDENCE_SELECTION);

    if (
      !existing ||
      existing.consumedAt ||
      !["processing", "matched", "needs_review", "not_found", "failed", "cancelled"].includes(
        existing.status
      )
    ) {
      throw this.createError({
        message: "This NIN lookup has changed or has already been used.",
        code: "NIN_ONBOARDING_CORRECTION_UNAVAILABLE",
        statusCode: 409,
      });
    }

    // ───────── PROTECT ACTIVE PROCESSING CLAIM ─────────

    /*
     * The UI disables Change NIN during processing,
     * but the backend must enforce that independently.
     *
     * A processing claim retains its lease until the
     * provider outcome has been safely recorded.
     */

    if (existing.status === "processing") {
      const leaseExpired =
        existing.processingLeaseExpiresAt && existing.processingLeaseExpiresAt <= now;

      throw this.createError({
        message: leaseExpired
          ? "Your previous NIN lookup has an uncertain outcome. Please contact support."
          : "Please wait for the current NIN lookup to finish before changing your NIN.",

        code: leaseExpired
          ? "NIN_ONBOARDING_OUTCOME_UNCERTAIN"
          : "NIN_ONBOARDING_ALREADY_PROCESSING",

        statusCode: 409,
      });
    }

    if (existing.correctionRequestedAt) {
      return this.getPublicResult(existing);
    }

    // ───────── INVALIDATE PREVIOUS ACKNOWLEDGEMENT ─────────

    const changes = {
      correctionRequestedAt: now,

      nameAcknowledgedAt: null,
      nameAcknowledgedRequestReference: null,
    };

    /*
     * Completed unmatched results may be cancelled.
     * Matched results remain temporarily cached so
     * re-entering the same NIN does not require
     * another provider call.
     */

    if (existing.status !== "matched") {
      Object.assign(changes, {
        status: "cancelled",

        processingClaimId: null,
        processingLeaseExpiresAt: null,

        registryFound: null,
        registryLegalName: null,

        checkedAt: null,
        resultExpiresAt: null,

        consumedAt: null,
        providerReference: null,

        errorCode: null,
        reason: null,
      });
    }

    const record = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        _id: existing._id,
        user: userId,

        requestReference: reference,
        status: existing.status,
        __v: existing.__v,

        consumedAt: null,
      },
      {
        $set: changes,

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
        message: "This NIN lookup changed. Please refresh and try again.",
        code: "NIN_ONBOARDING_CORRECTION_UNAVAILABLE",
        statusCode: 409,
      });
    }

    return this.getPublicResult(record);
  }

  // ───────────────────── ONBOARDING EVIDENCE ─────────────────────

  /*
   * The trusted onboarding service requires:
   *
   * - An eligible professional account;
   * - A successful production NIN lookup;
   * - Valid, unexpired evidence;
   * - Explicit lookup consent;
   * - Current name acknowledgement;
   * - No pending NIN correction;
   * - Structured registry legal names.
   *
   * A registry lookup does not authenticate
   * the identity holder.
   *
   * No external provider request occurs here.
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

    // ───────── REQUIRE MATCHED REGISTRY EVIDENCE ─────────

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

    // ───────── VALID RESULT ─────────

    if (!this.hasNotExpired(evidence, now) || evidence.consumedAt) {
      throw this.createError({
        message: "NIN verification has expired. Please verify again.",
        code: "NIN_ONBOARDING_EVIDENCE_EXPIRED",
        statusCode: 409,
      });
    }

    // ───────── NO PENDING CORRECTION ─────────

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

    // ───────── STRUCTURED REGISTRY LEGAL NAME ─────────

    this.normalizeRegistryLegalName(evidence.registryLegalName);

    return evidence;
  }

  // ───────────────────── TRANSACTIONAL CONSUMPTION ─────────────────────

  /*
   * Only trusted onboarding services invoke this.
   *
   * Permanent KYC evidence, User legal names and
   * provenance must be persisted in the same
   * MongoDB transaction.
   *
   * An onboarding failure rolls back consumption.
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
     * Pin consumption to the current lookup,
     * acknowledgement and correction state.
     *
     * Superseded or corrected evidence cannot
     * be consumed using a stale request reference.
     */

    const consumed = await PreOnboardingNINVerification.findOneAndUpdate(
      {
        _id: evidence._id,
        user: userId,
        __v: evidence.__v,

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
     * Return the previously validated evidence
     * including the structured registry name.
     *
     * OnboardingService creates permanent KYC
     * history and establishes legal-name provenance
     * in the same transaction.
     *
     * This does not approve the professional.
     */

    return evidence;
  }
}

module.exports = PreOnboardingNINVerificationService;
