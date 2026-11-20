// services/preOnboardingCACVerificationService.js

const mongoose = require("mongoose");

const crypto = require("crypto");

const User = require("../models/User");

const PreOnboardingCACVerification = require("../models/PreOnboardingCACVerification");

const CACLookupAttempt = require("../models/CACLookupAttempt");

const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const CACVerificationService = require("./cacVerificationService");

const EmployerVerificationService = require("./employerVerificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const SERVICE_ERROR_NAME = "PreOnboardingCACVerificationServiceError";
const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKUPS_PER_WINDOW = 8;
const MAX_DISTINCT_REGISTRATIONS_PER_WINDOW = 6;
const PROCESSING_LEASE_MS = 3 * 60 * 1000;
const RESULT_TTL_MS = 60 * 60 * 1000;
const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;
const COMPLETED_STATUSES = new Set(["matched", "needs_review", "not_found", "failed"]);

const CONSUMABLE_STATUS = "matched";
class PreOnboardingCACVerificationService {
  /*
   * PRE-ONBOARDING CAC VERIFICATION
   *
   * Handles:
   *
   * - Employer account eligibility;
   * - RC/BN registration normalization;
   * - Explicit CAC registry lookups;
   * - Authoritative registered business names;
   * - Provider lookup coordination;
   * - Atomic processing claims;
   * - Persistent lookup attempt history;
   * - Rolling 24-hour lookup limits;
   * - Cached result reuse;
   * - Transactional onboarding evidence consumption.
   *
   * LOOKUP POLICY
   *
   * - No blanket cooldown between completed lookups;
   * - Up to eight lookups within a rolling 24 hours;
   * - Up to six distinct registration numbers;
   * - Immediate corrections within those limits;
   * - One active provider lookup per account;
   * - No automatic provider retries or fallback;
   * - Uncertain provider outcomes require review.
   *
   * CAC registered business names come exclusively
   * from trusted server-side registry evidence.
   *
   * CAC registration validity does not establish
   * representative authority, PCN premises
   * eligibility or marketplace approval.
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

  // ───────────────────── NORMALIZATION ─────────────────────

  static normalizeUserId(userId) {
    if (!mongoose.isValidObjectId(userId)) {
      throw this.createError({
        message: "Invalid employer user ID.",
        code: "CAC_ONBOARDING_INVALID_USER",
        statusCode: 400,
      });
    }

    return userId;
  }

  /*
   * Only the registration number is required
   * for the authoritative registry lookup.
   *
   * The applicant's submitted business name
   * must not establish the registered legal name.
   */

  static normalizeInput({ registrationNumber } = {}) {
    const registration = CACVerificationService.normalizeRegistrationNumber(registrationNumber);
    if (
      !registration ||
      typeof registration.submitted !== "string" ||
      !CAC_REGISTRATION_PATTERN.test(registration.submitted)
    ) {
      throw this.createError({
        message: "Enter a valid CAC registration number.",
        code: "CAC_ONBOARDING_INVALID_REGISTRATION_NUMBER",
        statusCode: 400,
      });
    }

    return {
      registration,
    };
  }

  // ───────────────────── REGISTRY NAME VALIDATION ─────────────────────

  static normalizeRegistryBusinessName(value) {
    if (typeof value !== "string") {
      return null;
    }

    const name = value.trim();
    if (!name) {
      return null;
    }

    if (name.length > 150 || /[\u0000-\u001F\u007F]/.test(name)) {
      throw this.createError({
        message: "CAC registry returned an invalid registered business name.",
        code: "CAC_ONBOARDING_INVALID_REGISTRY_NAME",
        statusCode: 502,
      });
    }

    return name;
  }

  /*
   * Non-authoritative descriptive registry fields
   * must be normalized before persistence.
   *
   * Do not silently truncate invalid responses.
   */

  static normalizeRegistryText(value, maxLength) {
    if (value == null) {
      return null;
    }

    if (typeof value !== "string") {
      throw this.createError({
        message: "CAC registry returned invalid registration details.",
        code: "CAC_ONBOARDING_INVALID_REGISTRY_DETAILS",
        statusCode: 502,
      });
    }

    const text = value.trim();
    if (!text) {
      return null;
    }

    if (text.length > maxLength || /[\u0000-\u001F\u007F]/.test(text)) {
      throw this.createError({
        message: "CAC registry returned invalid registration details.",
        code: "CAC_ONBOARDING_INVALID_REGISTRY_DETAILS",
        statusCode: 502,
      });
    }

    return text;
  }

  /*
   * Bind returned registration digits to the
   * originally requested RC/BN identifier.
   *
   * Preserve leading zeroes.
   *
   * A returned explicit RC or BN prefix must
   * match the requested category.
   */

  static normalizeResponseRegistrationNumber(value, registration) {
    if (typeof value !== "string" || !registration) {
      return null;
    }

    const match = /^(RC|BN)?(\d{4,10})$/.exec(value.trim().toUpperCase());
    if (
      !match ||
      match[2] !== registration.rc_number ||
      (match[1] && match[1] !== registration.prefix) ||
      registration.submitted !== registration.prefix + match[2] ||
      !CAC_REGISTRATION_PATTERN.test(registration.submitted)
    ) {
      return null;
    }

    return registration.submitted;
  }

  // ───────────────────── USER AUTHORIZATION ─────────────────────

  static async assertEmployerCanVerify(userId, session = null) {
    this.normalizeUserId(userId);

    const query = User.findById(userId).select("role accountStatus isVerified isOnboarded");
    if (session) {
      query.session(session);
    }

    const user = await query;
    if (!user || user.role !== "employer") {
      throw this.createError({
        message: "An employer account is required.",
        code: "CAC_ONBOARDING_EMPLOYER_REQUIRED",
        statusCode: 403,
      });
    }

    if (user.accountStatus !== "active" || user.isVerified !== true) {
      throw this.createError({
        message: "Your account is not eligible for verification.",
        code: "CAC_ONBOARDING_ACCOUNT_INELIGIBLE",
        statusCode: 403,
      });
    }

    if (user.isOnboarded === true) {
      throw this.createError({
        message: "Employer onboarding has already been completed.",
        code: "CAC_ONBOARDING_ALREADY_COMPLETED",
        statusCode: 409,
      });
    }

    return user;
  }

  // ───────────────────── PROVIDER READINESS ─────────────────────

  /*
   * Confirm provider readiness and registration
   * category support before a chargeable lookup.
   *
   * Never silently switch providers.
   */

  static getProviderContext(registration) {
    CACVerificationService.assertVerificationEnabled();

    const provider = CACVerificationService.getProvider();

    const environment = CACVerificationService.getEnvironment(provider);
    CACVerificationService.assertProviderSupportsRegistration(provider, registration);

    const adapter = CACVerificationService.getAdapter(provider);
    try {
      adapter.assertNewVerificationEnabled("cac");
    } catch (error) {
      throw CACVerificationService.normalizeProviderError(error, provider);
    }

    return {
      provider,
      environment,
    };
  }

  // ───────────────────── RECORD MATCHING ─────────────────────

  static matchesSubmittedIdentity(record, input, context) {
    return (
      record.provider === context.provider &&
      record.providerEnvironment === context.environment &&
      record.registrationNumber === input.registration.submitted
    );
  }

  static hasNotExpired(record, now = new Date()) {
    return Boolean(record?.expiresAt && new Date(record.expiresAt).getTime() > now.getTime());
  }

  static isReusableResult(record, input, context, now) {
    return (
      this.hasNotExpired(record, now) &&
      COMPLETED_STATUSES.has(record.status) &&
      Boolean(record.checkedAt) &&
      this.matchesSubmittedIdentity(record, input, context)
    );
  }

  // ───────────────────── REGISTRY EVIDENCE CHECKS ─────────────────────

  static hasPassedRegistrationChecks(checks) {
    return Boolean(
      checks &&
      checks.registrationNumberMatches === true &&
      checks.entityCategoryMatches === true &&
      checks.registrationIsActive === true
    );
  }

  static hasCompleteRegistryEvidence(record) {
    return Boolean(
      record &&
      typeof record.nameOnRecord === "string" &&
      record.nameOnRecord.trim() &&
      record.nameOnRecord.length <= 150 &&
      !/[\u0000-\u001F\u007F]/.test(record.nameOnRecord) &&
      typeof record.registrationNumber === "string" &&
      CAC_REGISTRATION_PATTERN.test(record.registrationNumber) &&
      record.responseRegistrationNumber === record.registrationNumber &&
      typeof record.entityType === "string" &&
      record.entityType.trim() &&
      record.entityType.length <= 150 &&
      !/[\u0000-\u001f\u007f]/.test(record.entityType) &&
      typeof record.entityStatus === "string" &&
      record.entityStatus.trim() &&
      record.entityStatus.length <= 100 &&
      !/[\u0000-\u001f\u007f]/.test(record.entityStatus) &&
      this.hasPassedRegistrationChecks(record.checks)
    );
  }

  // ───────────────────── PUBLIC RESULT ─────────────────────

  /*
   * A successful CAC registry lookup is not
   * employer identity authentication or approval.
   *
   * Partial business names from failed or
   * needs_review results are not disclosed.
   */

  static getPublicResult(record, { cached = false } = {}) {
    const production = record.providerEnvironment === "production";
    const validResult = this.hasNotExpired(record);

    const matched =
      record.status === "matched" && validResult && this.hasCompleteRegistryEvidence(record);

    const verified = production && matched;
    const eligibleForOnboarding = verified;
    let message;
    if (!validResult && COMPLETED_STATUSES.has(record.status)) {
      message = "CAC verification has expired. Please verify again.";
    } else {
      switch (record.status) {
        case "matched":
          message = matched
            ? production
              ? "CAC registration confirmed. Please review the registered business name."
              : "Sandbox CAC registration confirmed. Production verification is required."
            : "CAC registry evidence requires additional review.";
          break;
        case "needs_review":
          message = "CAC registration details require additional review.";
          break;
        case "not_found":
          message = "CAC registration could not be confirmed.";
          break;
        case "failed":
          message = "CAC verification could not be completed. Please contact support.";
          break;
        case "cancelled":
          message = "CAC verification was cancelled.";
          break;
        case "consumed":
          message = "CAC verification has already been used.";
          break;
        default:
          message = "CAC verification is processing.";
      }
    }

    return {
      status: record.status,
      matched,
      verified,
      eligibleForOnboarding,
      provisional: true,
      stagingOnly: !production,

      requiresReview: production && ["needs_review", "not_found"].includes(record.status),
      cached,
      provider: record.provider,
      environment: record.providerEnvironment,
      registrationNumber: record.registrationNumber,
      registeredBusinessName: matched ? record.nameOnRecord : null,
      entityType: matched ? record.entityType : null,
      entityStatus: matched ? record.entityStatus : null,
      checks: record.checks
        ? {
            registrationNumberMatches: record.checks.registrationNumberMatches ?? null,
            entityCategoryMatches: record.checks.entityCategoryMatches ?? null,
            registrationIsActive: record.checks.registrationIsActive ?? null,
          }
        : null,
      checkedAt: record.checkedAt || null,
      expiresAt: record.expiresAt,
      errorCode: record.status === "failed" ? "CAC_LOOKUP_FAILED" : null,
      message,
    };
  }

  // ───────────────────── PROCESSING CLAIM ─────────────────────

  /*
   * A new processing claim clears the previous
   * temporary CAC evidence before requesting
   * another provider lookup.
   *
   * No applicant-entered business name becomes
   * authoritative registry evidence.
   */

  static buildProcessingData({ input, context, claimId, requestReference, now }) {
    return {
      provider: context.provider,
      providerEnvironment: context.environment,
      registrationNumber: input.registration.submitted,
      status: "processing",
      processingClaimId: claimId,
      requestReference,
      providerReference: null,
      nameOnRecord: null,
      responseRegistrationNumber: null,
      entityType: null,
      entityStatus: null,
      registrationDate: null,
      checks: {
        registrationNumberMatches: null,
        entityCategoryMatches: null,
        registrationIsActive: null,
      },
      reason: null,
      errorCode: null,
      lookupStartedAt: now,
      processingLeaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS),
      checkedAt: null,
      consumedAt: null,
      cancelledAt: null,
      expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
    };
  }

  // ───────────────────── RECORDED LOOKUP OUTCOME ─────────────────────

  /*
   * Cached evidence must correspond to a
   * completed entry in the persistent audit.
   *
   * Temporary evidence alone is insufficient.
   */

  static async assertRecordedOutcome(record, session = null) {
    const query = CACLookupAttempt.findOne({
      user: record.user,
      registrationNumber: record.registrationNumber,
      provider: record.provider,
      providerEnvironment: record.providerEnvironment,
      requestReference: record.requestReference,
      startedAt: record.lookupStartedAt,
      completedAt: record.checkedAt,
      status: record.status === "failed" ? "uncertain" : record.status,
    });
    if (session) {
      query.session(session);
    }

    if (!(await query)) {
      throw this.createError({
        message: "CAC verification audit evidence is unavailable. Please contact support.",
        code: "CAC_ONBOARDING_INVALID_EVIDENCE",
        statusCode: 409,
      });
    }
  }

  // ───────────────────── ROLLING LOOKUP BUDGET ─────────────────────

  /*
   * Every newly claimed lookup counts regardless
   * of whether the provider confirms a record.
   *
   * Limits within a rolling 24-hour period:
   *
   * - Eight total lookup attempts per employer;
   * - Six distinct RC/BN registration numbers.
   *
   * Corrections have no blanket waiting period.
   *
   * A registration already included among the
   * six can be checked again if total attempts
   * remain and no valid cached result is reusable.
   *
   * Unresolved provider requests are blocked
   * independently of this rolling-window budget.
   */

  static async assertLookupBudget({ userId, registrationNumber, now, session }) {
    // ───────── LOAD DURABLE ATTEMPT HISTORY ─────────

    const attempts = await CACLookupAttempt.find({
      user: userId,
      startedAt: {
        $gt: new Date(now.getTime() - ATTEMPT_WINDOW_MS),
        $lte: now,
      },
    })
      .select("+registrationNumber startedAt")
      .sort({
        startedAt: 1,
      })
      .session(session)
      .lean();

    // Any malformed historical entry makes paid-lookup eligibility unsafe to calculate.
    const invalidHistory = attempts.some((attempt) => {
      const startedAtMs = new Date(attempt.startedAt).getTime();
      return (
        typeof attempt.registrationNumber !== "string" ||
        !CAC_REGISTRATION_PATTERN.test(attempt.registrationNumber) ||
        !Number.isFinite(startedAtMs) ||
        startedAtMs > now.getTime()
      );
    });
    if (invalidHistory) {
      throw this.createError({
        message: "CAC lookup history requires review before another request.",
        code: "CAC_ONBOARDING_INVALID_ATTEMPT_HISTORY",
        statusCode: 409,
      });
    }

    const recentRegistrations = new Set(attempts.map((attempt) => attempt.registrationNumber));

    const totalLimitReached = attempts.length >= MAX_LOOKUPS_PER_WINDOW;
    const distinctLimitReached =
      !recentRegistrations.has(registrationNumber) &&
      recentRegistrations.size >= MAX_DISTINCT_REGISTRATIONS_PER_WINDOW;
    if (!totalLimitReached && !distinctLimitReached) {
      return;
    }

    // ───────── CALCULATE NEXT ELIGIBLE TIME ─────────

    let nextEligibleAtMs = 0;
    if (totalLimitReached) {
      /*
       * Enough attempts must leave the rolling
       * window to reduce the count below eight.
       *
       * Usually the oldest of eight attempts
       * determines when another lookup is allowed.
       */

      const index = attempts.length - MAX_LOOKUPS_PER_WINDOW;
      const oldestRequiredExpiry =
        new Date(attempts[index].startedAt).getTime() + ATTEMPT_WINDOW_MS;
      nextEligibleAtMs = Math.max(nextEligibleAtMs, oldestRequiredExpiry);
    }

    if (distinctLimitReached) {
      /*
       * Each distinct registration remains counted
       * until its MOST RECENT lookup expires.
       *
       * Expiry of an earlier lookup for the same
       * registration does not free a distinct slot.
       */

      const latestAttemptByRegistration = new Map();
      for (const attempt of attempts) {
        const attemptAtMs = new Date(attempt.startedAt).getTime();

        const previousAtMs = latestAttemptByRegistration.get(attempt.registrationNumber) || 0;
        latestAttemptByRegistration.set(
          attempt.registrationNumber,
          Math.max(previousAtMs, attemptAtMs)
        );
      }

      const registrationExpiryTimes = [...latestAttemptByRegistration.values()]
        .map((startedAtMs) => startedAtMs + ATTEMPT_WINDOW_MS)
        .sort((first, second) => first - second);

      const index = registrationExpiryTimes.length - MAX_DISTINCT_REGISTRATIONS_PER_WINDOW;
      nextEligibleAtMs = Math.max(nextEligibleAtMs, registrationExpiryTimes[index]);
    }

    /*
     * Reject malformed audit timestamps instead
     * of accidentally authorizing another charge.
     */

    if (!Number.isFinite(nextEligibleAtMs) || nextEligibleAtMs <= now.getTime()) {
      throw this.createError({
        message: "CAC lookup history requires review before another request.",
        code: "CAC_ONBOARDING_INVALID_ATTEMPT_HISTORY",
        statusCode: 409,
      });
    }

    // ───────── PREPARE SAFE RATE-LIMIT RESPONSE ─────────

    const nextEligibleAt = new Date(nextEligibleAtMs).toISOString();

    const retryAfterSeconds = Math.max(1, Math.ceil((nextEligibleAtMs - now.getTime()) / 1000));

    const limitType =
      totalLimitReached && distinctLimitReached ? "both" : totalLimitReached ? "total" : "distinct";
    const message =
      limitType === "total"
        ? `You have used all ${MAX_LOOKUPS_PER_WINDOW} CAC lookups allowed within a rolling 24-hour period.`
        : limitType === "distinct"
          ? `You have checked ${MAX_DISTINCT_REGISTRATIONS_PER_WINDOW} different CAC registration numbers within a rolling 24-hour period.`
          : "You have reached both CAC lookup limits for the rolling 24-hour period.";
    const error = this.createError({
      message: `${message} Please try again when your allowance becomes available.`,
      code: "CAC_ONBOARDING_RATE_LIMITED",
      statusCode: 429,
      details: {
        nextEligibleAt,
        retryAfterSeconds,
        limitType,
      },
    });

    /*
     * The controller must explicitly whitelist
     * these approved public retry properties.
     *
     * Never expose arbitrary error.details.
     */

    error.nextEligibleAt = nextEligibleAt;
    error.retryAfterSeconds = retryAfterSeconds;
    error.limitType = limitType;
    throw error;
  }

  // ───────────────────── ATOMIC LOOKUP CLAIM ─────────────────────

  static async acquireLookupClaim(args) {
    try {
      return await runWithOptionalTransaction({}, (session) =>
        this.acquireLookupClaimInTransaction(args, session)
      );
    } catch (error) {
      if (error?.code === 11000) {
        throw this.createError({
          message: "Another CAC verification request is processing.",
          code: "CAC_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }

      throw error;
    }
  }

  static async acquireLookupClaimInTransaction(
    { userId, input, context, claimId, requestReference },
    session
  ) {
    /*
     * Refresh time if a database-only transaction
     * is retried by the transaction helper.
     */

    const now = new Date();
    await this.assertEmployerCanVerify(userId, session);

    const existing = await PreOnboardingCACVerification.findOne({
      user: userId,
    })
      .select("+processingClaimId +requestReference +providerReference")
      .session(session);

    // ───────── ACTIVE PROCESSING CLAIM ─────────

    if (existing?.status === "processing") {
      const leaseExpired =
        !existing.processingLeaseExpiresAt || existing.processingLeaseExpiresAt <= now;
      throw this.createError({
        message: leaseExpired
          ? "We couldn't confirm your CAC verification. Please contact support."
          : "CAC verification is already processing.",
        code: leaseExpired
          ? "CAC_ONBOARDING_OUTCOME_UNCERTAIN"
          : "CAC_ONBOARDING_ALREADY_PROCESSING",
        statusCode: 409,
      });
    }

    // ───────── CONSUMED EVIDENCE ─────────

    if (existing?.status === "consumed") {
      throw this.createError({
        message: "This CAC verification has already been used.",
        code: "CAC_ONBOARDING_ALREADY_CONSUMED",
        statusCode: 409,
      });
    }

    // ───────── UNRESOLVED ATTEMPTS ─────────

    /*
     * Switching registration numbers or providers
     * must not bypass an unresolved paid lookup.
     *
     * The persistent audit remains authoritative
     * after temporary evidence expires.
     */

    const unresolved = await CACLookupAttempt.findOne({
      user: userId,
      status: {
        $in: ["pending", "uncertain"],
      },
    }).session(session);
    if (
      unresolved ||
      (existing?.status === "failed" && existing.errorCode === "CAC_ONBOARDING_OUTCOME_UNCERTAIN")
    ) {
      throw this.createError({
        message:
          "The previous CAC lookup outcome is uncertain. Please contact support before starting another lookup.",
        code: "CAC_ONBOARDING_OUTCOME_UNCERTAIN",
        statusCode: 409,
      });
    }

    // ───────── CACHED RESULT REUSE ─────────

    /*
     * Reusing valid evidence does not consume
     * another lookup allowance.
     *
     * Confirm that the cached outcome has a
     * matching persistent audit entry.
     */

    if (existing && this.isReusableResult(existing, input, context, now)) {
      await this.assertRecordedOutcome(existing, session);
      return {
        record: existing,
        cached: true,
      };
    }

    // ───────── ROLLING 24-HOUR LOOKUP LIMITS ─────────

    /*
     * No 10-minute cooldown applies.
     *
     * A new lookup can begin immediately after
     * the previous one has completed safely,
     * subject to the rolling-window limits.
     */

    await this.assertLookupBudget({
      userId,
      registrationNumber: input.registration.submitted,
      now,
      session,
    });

    // ───────── PREPARE NEW PROCESSING CLAIM ─────────

    const processingData = this.buildProcessingData({
      input,
      context,
      claimId,
      requestReference,
      now,
    });

    const candidate = new PreOnboardingCACVerification({
      user: userId,
      ...processingData,
    });
    await candidate.validate();

    let record;

    // ───────── REPLACE TEMPORARY EVIDENCE ─────────

    if (existing) {
      record = await PreOnboardingCACVerification.findOneAndUpdate(
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
          session,
        }
      );
      if (!record) {
        throw this.createError({
          message: "Another CAC verification request is processing.",
          code: "CAC_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }
    } else {
      [record] = await PreOnboardingCACVerification.create(
        [
          {
            user: userId,
            ...processingData,
          },
        ],
        {
          session,
        }
      );
    }

    // ───────── RECORD DURABLE LOOKUP ATTEMPT ─────────

    await CACLookupAttempt.create(
      [
        {
          user: userId,
          registrationNumber: input.registration.submitted,
          provider: context.provider,
          providerEnvironment: context.environment,
          requestReference,
          processingClaimId: claimId,
          startedAt: now,
          status: "pending",
        },
      ],
      {
        session,
      }
    );

    /*
     * The evidence claim and audit entry must
     * commit before the external provider call.
     */

    return {
      record,
      cached: false,
    };
  }

  // ───────────────────── COMPLETE LOOKUP CLAIM ─────────────────────

  /*
   * Only the original active claim may complete.
   *
   * The claim ID, registration number, provider
   * and request reference fence its result.
   *
   * An expired or superseded claim must not
   * overwrite newer evidence.
   */

  static async completeClaim(args) {
    return runWithOptionalTransaction({}, (session) =>
      this.completeClaimInTransaction(args, session)
    );
  }

  static async completeClaimInTransaction(
    { recordId, userId, claimId, registrationNumber, requestReference, context, updates },
    session
  ) {
    const completedAt = new Date();
    if (
      !updates ||
      !COMPLETED_STATUSES.has(updates.status) ||
      !(updates.checkedAt instanceof Date) ||
      !Number.isFinite(updates.checkedAt.getTime()) ||
      updates.checkedAt > completedAt ||
      !requestReference ||
      !context
    ) {
      throw this.createError({
        message: "Invalid CAC lookup completion evidence.",
        code: "CAC_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    // ───────── ORIGINAL ACTIVE CLAIM FILTER ─────────

    const filter = {
      _id: recordId,
      user: userId,
      registrationNumber,
      requestReference,
      provider: context.provider,
      providerEnvironment: context.environment,
      status: "processing",
      processingClaimId: claimId,
      cancelledAt: null,
      consumedAt: null,
      lookupStartedAt: {
        $lte: updates.checkedAt,
      },
      processingLeaseExpiresAt: {
        $gt: completedAt,
      },
      expiresAt: {
        $gt: completedAt,
      },
    };

    const current = await PreOnboardingCACVerification.findOne(filter)
      .select("+processingClaimId +requestReference +providerReference")
      .session(session);

    const claimLost = () =>
      this.createError({
        message: "The CAC lookup result could not be recorded safely.",
        code: "CAC_ONBOARDING_CLAIM_LOST",
        statusCode: 409,
      });
    if (!current) {
      throw claimLost();
    }

    // ───────── VALIDATE COMPLETION EVIDENCE ─────────

    /*
     * Query validators do not execute the
     * cross-field document validation hooks.
     *
     * Validate a complete candidate before
     * updating the processing record.
     */

    const changes = {
      status: updates.status,
      checkedAt: updates.checkedAt,
      providerReference: updates.providerReference ?? null,
      nameOnRecord: updates.nameOnRecord ?? null,
      responseRegistrationNumber: updates.responseRegistrationNumber ?? null,
      entityType: updates.entityType ?? null,
      entityStatus: updates.entityStatus ?? null,
      registrationDate: updates.registrationDate ?? null,
      checks: {
        registrationNumberMatches: updates.checks?.registrationNumberMatches ?? null,
        entityCategoryMatches: updates.checks?.entityCategoryMatches ?? null,
        registrationIsActive: updates.checks?.registrationIsActive ?? null,
      },
      reason: updates.reason ?? null,
      errorCode: updates.errorCode ?? null,
      processingClaimId: null,
      processingLeaseExpiresAt: null,
      cancelledAt: null,
      expiresAt: new Date(completedAt.getTime() + RESULT_TTL_MS),
    };

    if (
      (updates.status === "matched" &&
        !this.hasCompleteRegistryEvidence({
          ...changes,
          registrationNumber,
        })) ||
      (["not_found", "failed"].includes(updates.status) &&
        (changes.nameOnRecord != null ||
          changes.responseRegistrationNumber != null ||
          changes.entityType != null ||
          changes.entityStatus != null ||
          changes.registrationDate != null ||
          Object.values(changes.checks).some((value) => value != null)))
    ) {
      throw this.createError({
        message: "Invalid CAC lookup completion evidence.",
        code: "CAC_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    const candidate = new PreOnboardingCACVerification({
      ...current.toObject(),
      ...changes,
    });
    await candidate.validate();

    // ───────── FENCED DATABASE UPDATE ─────────

    const writeAt = new Date();

    const record = await PreOnboardingCACVerification.findOneAndUpdate(
      {
        ...filter,
        __v: current.__v,
        processingLeaseExpiresAt: {
          $gt: writeAt,
        },
        expiresAt: {
          $gt: writeAt,
        },
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
        session,
      }
    ).select("+requestReference +providerReference");
    if (!record) {
      throw claimLost();
    }

    // ───────── COMPLETE DURABLE AUDIT ENTRY ─────────

    /*
     * If the audit update fails, the evidence
     * update must also fail within the transaction.
     *
     * Uncertain attempts remain recorded after
     * temporary evidence expiry.
     */

    const attempt = await CACLookupAttempt.findOneAndUpdate(
      {
        user: userId,
        registrationNumber,
        provider: context.provider,
        providerEnvironment: context.environment,
        requestReference,
        processingClaimId: claimId,
        status: "pending",
        completedAt: null,
        startedAt: current.lookupStartedAt,
      },
      {
        $set: {
          status: updates.status === "failed" ? "uncertain" : updates.status,
          completedAt: updates.checkedAt,
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
    if (!attempt) {
      throw claimLost();
    }

    return record;
  }

  // ───────────────────── VERIFY CAC ─────────────────────

  /*
   * The applicant submits only a CAC registration
   * number for this registry check.
   *
   * The businessName in an onboarding form is
   * not used to establish the legal registry name.
   *
   * Exactly one external lookup is made per
   * newly acquired claim.
   */

  static async verifyCAC({ userId, registrationNumber } = {}) {
    await this.assertEmployerCanVerify(userId);

    const input = this.normalizeInput({
      registrationNumber,
    });

    const context = this.getProviderContext(input.registration);

    const claimId = crypto.randomUUID();

    const requestReference = crypto.randomUUID();

    const claim = await this.acquireLookupClaim({
      userId,
      input,
      context,
      claimId,
      requestReference,
    });

    // ───────── CACHED EVIDENCE ─────────

    if (claim.cached) {
      return this.getPublicResult(claim.record, {
        cached: true,
      });
    }

    let lookup = null;
    let normalizedResult = null;
    let evaluation = null;
    let lookupError = null;

    // ───────── SINGLE PROVIDER REQUEST ─────────

    try {
      lookup = await CACVerificationService.lookupRegistration({
        registrationNumber: input.registration.submitted,
        reference: requestReference,
      });

      // ───────── PROVIDER CONTEXT VALIDATION ─────────

      if (
        lookup?.provider !== context.provider ||
        lookup?.environment !== context.environment ||
        lookup?.registration?.submitted !== input.registration.submitted ||
        lookup.requestReference !== requestReference
      ) {
        throw this.createError({
          message: "CAC verification context mismatch.",
          code: "CAC_ONBOARDING_CONTEXT_MISMATCH",
          statusCode: 409,
        });
      }

      if (!lookup.result || typeof lookup.result !== "object" || Array.isArray(lookup.result)) {
        throw this.createError({
          message: "CAC provider returned incomplete information.",
          code: "CAC_ONBOARDING_INVALID_RESPONSE",
          statusCode: 502,
        });
      }

      // ───────── MATCH RETURNED REGISTRATION ─────────

      const responseRegistrationNumber = this.normalizeResponseRegistrationNumber(
        lookup.result.registrationNumber,
        input.registration
      );
      if (!responseRegistrationNumber) {
        throw this.createError({
          message: "CAC returned a different or incomplete registration number.",
          code: "CAC_ONBOARDING_CONTEXT_MISMATCH",
          statusCode: 502,
        });
      }

      normalizedResult = {
        ...lookup.result,
        registrationNumber: responseRegistrationNumber,
      };

      // ───────── REGISTRY DOMAIN EVALUATION ─────────

      /*
       * EmployerVerificationService owns the
       * registration category and status rules.
       *
       * No applicant-supplied business-name
       * comparison is required.
       */

      evaluation = EmployerVerificationService.evaluateCACResult({
        registration: lookup.registration,
        result: normalizedResult,
      });
      if (
        !evaluation ||
        typeof evaluation.eligible !== "boolean" ||
        !evaluation.checks ||
        typeof evaluation.checks !== "object"
      ) {
        throw this.createError({
          message: "CAC registry evaluation is incomplete.",
          code: "CAC_ONBOARDING_INVALID_RESPONSE",
          statusCode: 502,
        });
      }
    } catch (error) {
      lookupError = error;
    }

    const checkedAt = new Date();

    // ───────── PROVIDER FAILURE OR INVALID RESPONSE ─────────

    if (lookupError) {
      /*
       * Only a definitive not-found response is
       * classified as not_found.
       *
       * Transport failures, context mismatches
       * and incomplete provider responses are
       * treated as uncertain outcomes.
       *
       * Never retry automatically.
       */

      const notFound = lookupError.code === "CAC_COMPANY_NOT_FOUND";
      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,
        requestReference,
        context,
        registrationNumber: input.registration.submitted,
        updates: {
          status: notFound ? "not_found" : "failed",
          checkedAt,
          nameOnRecord: null,
          responseRegistrationNumber: null,
          entityType: null,
          entityStatus: null,
          registrationDate: null,
          checks: {
            registrationNumberMatches: null,
            entityCategoryMatches: null,
            registrationIsActive: null,
          },
          reason: notFound
            ? "CAC registration was not found."
            : "CAC verification could not be completed safely.",
          errorCode: notFound ? "CAC_COMPANY_NOT_FOUND" : "CAC_ONBOARDING_OUTCOME_UNCERTAIN",
          providerReference: null,
        },
      });
      return this.getPublicResult(record);
    }

    // ───────── NORMALIZE PROVIDER EVIDENCE ─────────

    let registryEvidence;
    try {
      registryEvidence = {
        registrationNumber: input.registration.submitted,
        nameOnRecord: this.normalizeRegistryBusinessName(lookup.result.entityName),
        responseRegistrationNumber: this.normalizeResponseRegistrationNumber(
          normalizedResult.registrationNumber,
          input.registration
        ),
        entityType: this.normalizeRegistryText(lookup.result.entityType, 150),
        entityStatus: this.normalizeRegistryText(lookup.result.entityStatus, 100),
        registrationDate: this.normalizeRegistryText(lookup.result.registrationDate, 100),
        checks: {
          registrationNumberMatches: evaluation.checks.registrationNumberMatches === true,
          entityCategoryMatches: evaluation.checks.entityCategoryMatches === true,
          registrationIsActive: evaluation.checks.registrationIsActive === true,
        },
      };
    } catch (error) {
      /*
       * The provider request already occurred.
       *
       * Invalid registry evidence must not be
       * silently accepted or retried.
       */

      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,
        requestReference,
        context,
        registrationNumber: input.registration.submitted,
        updates: {
          status: "failed",
          checkedAt,
          nameOnRecord: null,
          responseRegistrationNumber: null,
          entityType: null,
          entityStatus: null,
          registrationDate: null,
          checks: {
            registrationNumberMatches: null,
            entityCategoryMatches: null,
            registrationIsActive: null,
          },
          reason: "CAC registry evidence could not be safely normalized.",
          errorCode: "CAC_ONBOARDING_OUTCOME_UNCERTAIN",
          providerReference: lookup.providerReference || null,
        },
      });
      return this.getPublicResult(record);
    }

    // ───────── DETERMINE REGISTRY ELIGIBILITY ─────────

    const matched =
      evaluation.eligible === true && this.hasCompleteRegistryEvidence(registryEvidence);

    // ───────── STORE COMPLETED LOOKUP ─────────

    const record = await this.completeClaim({
      recordId: claim.record._id,
      userId,
      claimId,
      requestReference,
      context,
      registrationNumber: input.registration.submitted,
      updates: {
        status: matched ? "matched" : "needs_review",
        checkedAt,
        providerReference: lookup.providerReference || null,
        nameOnRecord: registryEvidence.nameOnRecord,
        responseRegistrationNumber: registryEvidence.responseRegistrationNumber,
        entityType: registryEvidence.entityType,
        entityStatus: registryEvidence.entityStatus,
        registrationDate: registryEvidence.registrationDate,
        checks: registryEvidence.checks,
        reason: matched ? null : "CAC registration evidence requires additional review.",
        errorCode: null,
      },
    });
    return this.getPublicResult(record);
  }

  // ───────────────────── ONBOARDING EVIDENCE ─────────────────────

  /*
   * Trusted server-side onboarding requires:
   *
   * - An eligible authenticated employer;
   * - Matching normalized CAC registration;
   * - Successful production registry verification;
   * - Unexpired and unconsumed evidence;
   * - Authoritative registered business name;
   * - Matching requested and returned numbers;
   * - Valid entity category and active status;
   * - All required registry checks passing.
   *
   * A user-entered business name is not trusted
   * as the legal registry name.
   */

  static async getEvidenceForOnboarding({ userId, registrationNumber, session = null } = {}) {
    await this.assertEmployerCanVerify(userId, session);

    const input = this.normalizeInput({
      registrationNumber,
    });

    const query = PreOnboardingCACVerification.findOne({
      user: userId,
    }).select("+processingClaimId +requestReference +providerReference");
    if (session) {
      query.session(session);
    }

    const evidence = await query;
    if (!evidence) {
      return null;
    }

    const now = new Date();

    // ───────── INCOMPLETE LOOKUP ─────────

    if (evidence.status === "processing") {
      const leaseExpired =
        evidence.processingLeaseExpiresAt && evidence.processingLeaseExpiresAt <= now;
      throw this.createError({
        message: leaseExpired
          ? "We couldn't confirm your CAC verification. Please contact support."
          : "CAC verification is still processing. Please wait.",
        code: leaseExpired
          ? "CAC_ONBOARDING_OUTCOME_UNCERTAIN"
          : "CAC_ONBOARDING_ALREADY_PROCESSING",
        statusCode: 409,
      });
    }

    // ───────── CONSUMED EVIDENCE ─────────

    if (evidence.status === "consumed") {
      throw this.createError({
        message: "This CAC verification has already been used.",
        code: "CAC_ONBOARDING_ALREADY_CONSUMED",
        statusCode: 409,
      });
    }

    // ───────── REGISTRATION CONSISTENCY ─────────

    if (evidence.registrationNumber !== input.registration.submitted) {
      return null;
    }

    // ───────── EXPIRY ─────────

    if (!this.hasNotExpired(evidence, now) || evidence.consumedAt) {
      throw this.createError({
        message: "CAC verification has expired. Please verify again.",
        code: "CAC_ONBOARDING_EVIDENCE_EXPIRED",
        statusCode: 409,
      });
    }

    // ───────── SUCCESSFUL MATCH ─────────

    if (evidence.status !== CONSUMABLE_STATUS) {
      const message =
        evidence.status === "failed"
          ? "CAC verification could not be confirmed. Please contact support."
          : "A successful CAC registration lookup is required before continuing.";
      throw this.createError({
        message,
        code: "CAC_ONBOARDING_NOT_MATCHED",
        statusCode: 409,
      });
    }

    // ───────── PRODUCTION REQUIRED ─────────

    if (evidence.providerEnvironment !== "production") {
      throw this.createError({
        message: "Production CAC verification is required to continue.",
        code: "CAC_ONBOARDING_PRODUCTION_REQUIRED",
        statusCode: 409,
      });
    }

    // ───────── EVIDENCE INTEGRITY ─────────

    if (
      !["ninja", "dojah"].includes(evidence.provider) ||
      !evidence.checkedAt ||
      !evidence.lookupStartedAt ||
      typeof evidence.requestReference !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(evidence.requestReference) ||
      evidence.cancelledAt ||
      evidence.processingClaimId ||
      evidence.processingLeaseExpiresAt ||
      !CAC_REGISTRATION_PATTERN.test(evidence.registrationNumber) ||
      !this.hasCompleteRegistryEvidence(evidence)
    ) {
      throw this.createError({
        message: "CAC verification evidence is incomplete. Please contact support.",
        code: "CAC_ONBOARDING_INVALID_EVIDENCE",
        statusCode: 409,
      });
    }

    if (
      !Number.isFinite(new Date(evidence.checkedAt).getTime()) ||
      !Number.isFinite(new Date(evidence.lookupStartedAt).getTime()) ||
      evidence.checkedAt < evidence.lookupStartedAt ||
      evidence.checkedAt > now ||
      evidence.checkedAt >= evidence.expiresAt
    ) {
      throw this.createError({
        message: "CAC verification timestamps are inconsistent.",
        code: "CAC_ONBOARDING_INVALID_EVIDENCE",
        statusCode: 409,
      });
    }

    // ───────── CHECK DURABLE AUDIT EVIDENCE ─────────

    await this.assertRecordedOutcome(evidence, session);
    return evidence;
  }

  // ───────────────────── TRANSACTIONAL CONSUMPTION ─────────────────────

  /*
   * Only trusted onboarding services may call
   * this inside an active MongoDB transaction.
   *
   * Permanent CAC KYC evidence and the registered
   * business name must be saved in the SAME
   * transaction as temporary evidence consumption.
   *
   * CAC verification does not authorize business
   * representation or grant marketplace approval.
   */

  static async consumeForOnboarding({ userId, registrationNumber, session } = {}) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.createError({
        message: "An active onboarding transaction is required.",
        code: "CAC_ONBOARDING_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    const evidence = await this.getEvidenceForOnboarding({
      userId,
      registrationNumber,
      session,
    });
    if (!evidence) {
      return null;
    }

    const consumedAt = new Date();

    // ───────── ATOMIC EVIDENCE CONSUMPTION ─────────

    /*
     * Version fencing prevents a newer lookup
     * from being consumed with stale evidence.
     *
     * Staging, expired, unconfirmed and
     * superseded results cannot satisfy this update.
     */

    const consumed = await PreOnboardingCACVerification.findOneAndUpdate(
      {
        _id: evidence._id,
        user: userId,
        __v: evidence.__v,
        status: CONSUMABLE_STATUS,
        consumedAt: null,
        cancelledAt: null,
        processingClaimId: null,
        processingLeaseExpiresAt: null,
        checkedAt: {
          $eq: evidence.checkedAt,
          $lte: consumedAt,
        },
        lookupStartedAt: evidence.lookupStartedAt,
        provider: evidence.provider,
        providerEnvironment: "production",
        registrationNumber: evidence.registrationNumber,
        responseRegistrationNumber: evidence.registrationNumber,
        requestReference: evidence.requestReference,
        "checks.registrationNumberMatches": true,
        "checks.entityCategoryMatches": true,
        "checks.registrationIsActive": true,
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
        message: "CAC verification has expired or already been used.",
        code: "CAC_ONBOARDING_EVIDENCE_UNAVAILABLE",
        statusCode: 409,
      });
    }

    /*
     * Return the original validated evidence.
     *
     * OnboardingService persists the permanent
     * CAC KYC history and EmployerProfile.businessName
     * from this trusted registry result.
     */

    return evidence;
  }
}

module.exports = PreOnboardingCACVerificationService;
