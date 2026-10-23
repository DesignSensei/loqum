// services/preOnboardingCACVerificationService.js

const mongoose = require("mongoose");
const crypto = require("crypto");

const User = require("../models/User");
const PreOnboardingCACVerification = require("../models/PreOnboardingCACVerification");

const CACVerificationService = require("./cacVerificationService");
const EmployerVerificationService = require("./employerVerificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const SERVICE_ERROR_NAME = "PreOnboardingCACVerificationServiceError";

const LOOKUP_COOLDOWN_MS = 10 * 60 * 1000;
const PROCESSING_LEASE_MS = 3 * 60 * 1000;
const RESULT_TTL_MS = 60 * 60 * 1000;

const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;

const COMPLETED_STATUSES = new Set(["matched", "needs_review", "not_found", "failed"]);

const CONSUMABLE_STATUS = "matched";

class PreOnboardingCACVerificationService {
  /*
   * PRE-ONBOARDING CAC VERIFICATION
   *
   * This service handles:
   * - Employer account eligibility;
   * - Explicit CAC registration lookups;
   * - Registration-number normalization;
   * - Authoritative CAC business-name retrieval;
   * - Provider lookup coordination;
   * - Atomic request claims and cooldowns;
   * - Temporary verification evidence;
   * - Cached result reuse;
   * - Transactional onboarding evidence consumption.
   *
   * REGISTRY-AUTHORITATIVE BUSINESS NAMES
   *
   * The applicant supplies the CAC registration
   * number, not the authoritative legal business name.
   *
   * The registered business name is retrieved
   * directly from trusted Ninja or Dojah evidence.
   *
   * OnboardingService uses that name to populate
   * EmployerProfile.businessName.
   *
   * NORMAL ONBOARDING POLICY
   *
   * Normal employer onboarding requires an
   * unexpired, successful production CAC lookup.
   *
   * Registration number, entity category and
   * registration status checks must pass.
   *
   * CACVerificationService owns provider integration.
   *
   * EmployerVerificationService owns interpretation
   * of business registration categories and statuses.
   *
   * OnboardingService owns permanent evidence transfer.
   *
   * CAC registration verification does not prove
   * that the applicant represents the business.
   *
   * Representative authority, PCN premises
   * verification and administrator approval
   * remain separate.
   *
   * Never automatically retry chargeable requests.
   * Never silently switch providers.
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
   * Only the CAC registration number is supplied
   * as the registry-lookup identity.
   *
   * The authoritative legal business name must
   * never be sourced from the request body.
   *
   * CACVerificationService normalizes supported
   * RC and BN registration identifiers.
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

  /*
   * The registered business name comes from
   * trusted server-side CAC provider evidence.
   *
   * Preserve the provider's legal business name
   * without guessing or reconstructing it.
   *
   * Do not silently truncate a registered name
   * that exceeds the supported database limit.
   *
   * Incomplete or invalid names cannot establish
   * a successful registry match.
   */

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
   * Normalize non-authoritative descriptive fields
   * before storing them as registry evidence.
   *
   * Missing values remain null rather than being
   * replaced with assumptions.
   */

  static normalizeRegistryText(value, maxLength) {
    if (value == null) {
      return null;
    }

    const text = String(value).trim();

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
   * The provider adapter is responsible for
   * normalizing returned RC/BN identifiers.
   *
   * Do not invent a missing registration prefix
   * or assume that an unqualified numeric value
   * refers to the requested registration.
   */

  static normalizeResponseRegistrationNumber(value) {
    if (typeof value !== "string") {
      return null;
    }

    const registrationNumber = value.trim().toUpperCase();

    return CAC_REGISTRATION_PATTERN.test(registrationNumber) ? registrationNumber : null;
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
   * CAC provider selection is explicit.
   *
   * Validate the registration category before
   * making a potentially chargeable lookup.
   *
   * A provider that cannot verify the requested
   * registration category must fail immediately.
   *
   * Do not automatically switch to another provider.
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

  /*
   * Cached CAC evidence is associated with:
   *
   * - The authenticated employer account;
   * - The normalized CAC registration number;
   * - The explicitly selected provider;
   * - The provider environment.
   *
   * A manually entered business name is not
   * part of this comparison.
   */

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

  /*
   * The registry must confirm all three
   * required registration checks.
   *
   * A provider returning a legal business name
   * alone is insufficient.
   *
   * These checks determine CAC registry validity,
   * not representative authority or final KYB.
   */

  static hasPassedRegistrationChecks(checks) {
    return Boolean(
      checks &&
      checks.registrationNumberMatches === true &&
      checks.entityCategoryMatches === true &&
      checks.registrationIsActive === true
    );
  }

  /*
   * Only complete and internally consistent
   * registry evidence may be considered matched.
   *
   * The requested registration number must equal
   * the registration number returned by CAC.
   *
   * The registered business name must originate
   * from the evaluated provider response.
   */

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
      typeof record.entityStatus === "string" &&
      record.entityStatus.trim() &&
      this.hasPassedRegistrationChecks(record.checks)
    );
  }

  // ───────────────────── PUBLIC RESULT ─────────────────────

  /*
   * The controller must authorize the requester
   * before returning this public result.
   *
   * "verified" describes the CAC registry check
   * only, not employer identity or KYB approval.
   *
   * Do not expose partial registered business
   * names from failed or needs_review lookups.
   *
   * Only a current matched record may provide
   * authoritative registered business details.
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

        default:
          message = "CAC verification is processing.";
      }
    }

    return {
      status: record.status,

      matched,
      verified,
      eligibleForOnboarding,

      /*
       * The registry check remains provisional
       * until onboarding transfers permanent CAC
       * evidence to the employer account.
       */

      provisional: true,
      stagingOnly: !production,

      /*
       * These checks do not replace business
       * representative or PCN premises approval.
       */

      representativeAuthorized: false,
      employerApproved: false,
      requiresRepresentativeVerification: true,

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

      // Avoid exposing raw provider failure details.
      errorCode: record.status === "failed" ? "CAC_LOOKUP_FAILED" : null,

      message,
    };
  }

  // ───────────────────── PROCESSING CLAIM ─────────────────────

  /*
   * A new processing claim replaces temporary
   * evidence from the previous registration lookup.
   *
   * All previously returned business details,
   * registry checks and processing references
   * must be cleared before a new provider request.
   *
   * The applicant's manually entered business
   * name is never persisted as CAC evidence.
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

      nextLookupAllowedAt: new Date(now.getTime() + LOOKUP_COOLDOWN_MS),

      consumedAt: null,

      expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
    };
  }

  // ───────────────────── ATOMIC LOOKUP CLAIM ─────────────────────

  static async acquireLookupClaim({ userId, input, context, now, claimId, requestReference }) {
    const existing = await PreOnboardingCACVerification.findOne({
      user: userId,
    }).select("+processingClaimId +requestReference +providerReference");

    if (existing) {
      // ───────── CURRENTLY PROCESSING ─────────

      if (existing.status === "processing") {
        const leaseExpired =
          existing.processingLeaseExpiresAt && existing.processingLeaseExpiresAt <= now;

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

      // ───────── ALREADY CONSUMED ─────────

      if (existing.status === "consumed") {
        throw this.createError({
          message: "This CAC verification has already been used.",
          code: "CAC_ONBOARDING_ALREADY_CONSUMED",
          statusCode: 409,
        });
      }

      // ───────── CACHE REUSE ─────────

      /*
       * Reuse a valid completed lookup for the
       * same registration, provider and environment.
       *
       * A cache hit does not trigger another
       * potentially chargeable provider request.
       */

      if (this.isReusableResult(existing, input, context, now)) {
        return {
          record: existing,
          cached: true,
        };
      }

      // ───────── UNCERTAIN PREVIOUS OUTCOME ─────────

      /*
       * A failed lookup may already have reached
       * the provider and incurred a charge.
       *
       * Do not repeat the same uncertain request
       * simply because the cooldown elapsed.
       *
       * Require controlled review before
       * resubmitting an uncertain registration.
       */

      if (
        existing.status === "failed" &&
        existing.errorCode === "CAC_ONBOARDING_OUTCOME_UNCERTAIN" &&
        this.matchesSubmittedIdentity(existing, input, context)
      ) {
        throw this.createError({
          message:
            "The previous CAC lookup outcome is uncertain. Please contact support before retrying this registration.",

          code: "CAC_ONBOARDING_OUTCOME_UNCERTAIN",
          statusCode: 409,
        });
      }

      // ───────── CAC LOOKUP COOLDOWN ─────────

      /*
       * Preserve the existing CAC lookup
       * cooldown policy.
       *
       * This is separate from the NIN correction
       * workflow, which has no blanket cooldown.
       *
       * The cooldown protects against repeated
       * chargeable CAC provider requests.
       */

      if (existing.nextLookupAllowedAt && existing.nextLookupAllowedAt > now) {
        throw this.createError({
          message: "Please wait before requesting another CAC verification.",

          code: "CAC_ONBOARDING_COOLDOWN",
          statusCode: 429,

          details: {
            nextLookupAllowedAt: existing.nextLookupAllowedAt,
          },
        });
      }

      const processingData = this.buildProcessingData({
        input,
        context,
        claimId,
        requestReference,
        now,
      });

      /*
       * Optimistic version fencing prevents
       * competing requests from both acquiring
       * a new chargeable provider lookup claim.
       */

      const claimed = await PreOnboardingCACVerification.findOneAndUpdate(
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
      );

      if (!claimed) {
        throw this.createError({
          message: "Another CAC verification request is processing.",

          code: "CAC_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }

      return {
        record: claimed,
        cached: false,
      };
    }

    // ───────── FIRST LOOKUP ─────────

    const processingData = this.buildProcessingData({
      input,
      context,
      claimId,
      requestReference,
      now,
    });

    try {
      const created = await PreOnboardingCACVerification.create({
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
          message: "Another CAC verification request is processing.",

          code: "CAC_ONBOARDING_CONCURRENT_REQUEST",
          statusCode: 409,
        });
      }

      throw error;
    }
  }

  // ───────────────────── COMPLETE LOOKUP CLAIM ─────────────────────

  /*
   * A provider result may complete only the
   * processing claim that initiated its lookup.
   *
   * A stale or superseded provider response must
   * never overwrite newer CAC evidence.
   *
   * Match the expected registration number
   * against the active processing claim.
   *
   * Complete registry evidence must include:
   *
   * - The requested registration number;
   * - The registration number returned by CAC;
   * - The registered legal business name;
   * - Entity category and registration status;
   * - All three required registration checks.
   *
   * Completion must clear the processing claim
   * and active lease.
   *
   * Completed evidence receives a fresh expiry.
   */

  static async completeClaim({ recordId, userId, claimId, registrationNumber, updates }) {
    if (
      typeof registrationNumber !== "string" ||
      !CAC_REGISTRATION_PATTERN.test(registrationNumber) ||
      !updates ||
      !COMPLETED_STATUSES.has(updates.status) ||
      !(updates.checkedAt instanceof Date) ||
      Number.isNaN(updates.checkedAt.getTime())
    ) {
      throw this.createError({
        message: "Invalid CAC lookup completion evidence.",
        code: "CAC_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    /*
     * The requested registration number is
     * supplied separately because it belongs
     * to the processing claim, not to the
     * provider's completion payload.
     *
     * Combine it with the returned evidence
     * before validating a successful match.
     *
     * This avoids incorrectly rejecting valid
     * CAC results because updates does not
     * contain registrationNumber.
     */

    if (
      updates.status === "matched" &&
      !this.hasCompleteRegistryEvidence({
        registrationNumber,
        nameOnRecord: updates.nameOnRecord,
        responseRegistrationNumber: updates.responseRegistrationNumber,
        entityType: updates.entityType,
        entityStatus: updates.entityStatus,
        checks: updates.checks,
      })
    ) {
      throw this.createError({
        message: "Matched CAC registry evidence is incomplete.",
        code: "CAC_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    /*
     * A definitive not-found result cannot
     * retain authoritative registry details.
     *
     * Failed requests must also remain
     * non-authoritative.
     *
     * needs_review may retain partial evidence
     * for controlled administrative review.
     */

    if (
      ["not_found", "failed"].includes(updates.status) &&
      (updates.nameOnRecord != null ||
        updates.responseRegistrationNumber != null ||
        updates.entityType != null ||
        updates.entityStatus != null)
    ) {
      throw this.createError({
        message: "Unsuccessful CAC lookup cannot establish registered business identity.",
        code: "CAC_ONBOARDING_INVALID_COMPLETION",
        statusCode: 500,
      });
    }

    const completedAt = new Date();

    const record = await PreOnboardingCACVerification.findOneAndUpdate(
      {
        _id: recordId,
        user: userId,

        registrationNumber,

        status: "processing",
        processingClaimId: claimId,

        expiresAt: {
          $gt: completedAt,
        },
      },
      {
        $set: {
          status: updates.status,

          checkedAt: updates.checkedAt,

          providerReference: updates.providerReference || null,

          nameOnRecord: updates.nameOnRecord || null,

          responseRegistrationNumber: updates.responseRegistrationNumber || null,

          entityType: updates.entityType || null,

          entityStatus: updates.entityStatus || null,

          registrationDate: updates.registrationDate || null,

          checks: {
            registrationNumberMatches: updates.checks?.registrationNumberMatches ?? null,

            entityCategoryMatches: updates.checks?.entityCategoryMatches ?? null,

            registrationIsActive: updates.checks?.registrationIsActive ?? null,
          },

          reason: updates.reason || null,

          errorCode: updates.errorCode || null,

          processingClaimId: null,
          processingLeaseExpiresAt: null,

          expiresAt: new Date(completedAt.getTime() + RESULT_TTL_MS),
        },

        $inc: {
          __v: 1,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).select("+requestReference +providerReference");

    if (!record) {
      throw this.createError({
        message: "The CAC lookup result could not be recorded safely.",

        code: "CAC_ONBOARDING_CLAIM_LOST",
        statusCode: 409,
      });
    }

    return record;
  }

  // ───────────────────── VERIFY CAC ─────────────────────

  /*
   * The applicant submits a CAC registration
   * number only.
   *
   * businessName is deliberately excluded from
   * the verification input.
   *
   * Any optional display or trading name belongs
   * to the appropriate employer profile workflow,
   * not to this authoritative registry lookup.
   */

  static async verifyCAC({ userId, registrationNumber } = {}) {
    await this.assertEmployerCanVerify(userId);

    const input = this.normalizeInput({
      registrationNumber,
    });

    const context = this.getProviderContext(input.registration);

    const now = new Date();

    const claimId = crypto.randomUUID();

    const requestReference = crypto.randomUUID();

    const claim = await this.acquireLookupClaim({
      userId,
      input,
      context,
      now,
      claimId,
      requestReference,
    });

    if (claim.cached) {
      return this.getPublicResult(claim.record, { cached: true });
    }

    let lookup = null;
    let evaluation = null;
    let lookupError = null;

    /*
     * Exactly one provider lookup per claim.
     *
     * No external request runs inside the
     * employer onboarding transaction.
     *
     * The provider is responsible for retrieving
     * the registered legal business name.
     *
     * Evaluate the result before completing
     * the temporary evidence record.
     *
     * Do not automatically retry an uncertain
     * request or switch providers.
     */

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
        (lookup.requestReference != null && lookup.requestReference !== requestReference)
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

      // ───────── REGISTRY EVALUATION ─────────

      /*
       * EmployerVerificationService must evaluate
       * the CAC registration independently of any
       * user-supplied business name.
       *
       * Required checks:
       *
       * - registrationNumberMatches;
       * - entityCategoryMatches;
       * - registrationIsActive.
       *
       * No businessNameMatches condition.
       */

      evaluation = EmployerVerificationService.evaluateCACResult({
        registration: lookup.registration,

        result: lookup.result,
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

    // ───────────────────── LOOKUP OR EVALUATION ERROR ─────────────────────

    if (lookupError) {
      /*
       * Only a definitive provider response
       * confirming that the registration does not
       * exist may be classified as not_found.
       *
       * Transport failures, context mismatches
       * and incomplete responses are not proof
       * that a registration is absent.
       *
       * Treat other failures as uncertain so the
       * same lookup is not silently repeated.
       */

      const notFound = lookupError.code === "CAC_COMPANY_NOT_FOUND";

      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,

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

    // ───────────────────── NORMALIZE REGISTRY RESULT ─────────────────────

    let registryEvidence;

    try {
      registryEvidence = {
        registrationNumber: input.registration.submitted,

        nameOnRecord: this.normalizeRegistryBusinessName(lookup.result.entityName),

        responseRegistrationNumber: this.normalizeResponseRegistrationNumber(
          lookup.result.registrationNumber
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
       * Do not persist a malformed registered
       * business name as authoritative evidence.
       *
       * The provider request has already occurred,
       * so the failure cannot be retried silently.
       */

      const record = await this.completeClaim({
        recordId: claim.record._id,
        userId,
        claimId,

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

    // ───────────────────── ASSESS REGISTRY ELIGIBILITY ─────────────────────

    /*
     * Both the domain evaluation and the
     * required evidence checks must succeed.
     *
     * Missing registration details or any failed
     * registration check result in needs_review.
     *
     * A user-entered business name is never
     * considered in this decision.
     */

    const matched =
      evaluation.eligible === true && this.hasCompleteRegistryEvidence(registryEvidence);

    // ───────────────────── STORE REGISTRY RESULT ─────────────────────

    const record = await this.completeClaim({
      recordId: claim.record._id,
      userId,
      claimId,

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
   * Only trusted server-side onboarding workflows
   * should retrieve this evidence.
   *
   * Normal onboarding requires:
   *
   * - An eligible, authenticated employer account;
   * - The same normalized CAC registration number;
   * - Successful production registry verification;
   * - An unexpired and unconsumed result;
   * - A trusted CAC-registered legal business name;
   * - Matching requested and returned numbers;
   * - Valid entity category and active status;
   * - All required registry checks passing.
   *
   * The applicant's submitted business name
   * is not part of the verification requirements.
   *
   * An unfinished or uncertain lookup blocks
   * normal onboarding.
   *
   * This method never calls Ninja or Dojah.
   */

  static async getEvidenceForOnboarding({ userId, registrationNumber, session = null } = {}) {
    await this.assertEmployerCanVerify(userId, session);

    const input = this.normalizeInput({
      registrationNumber,
    });

    const query = PreOnboardingCACVerification.findOne({
      user: userId,
    }).select("+requestReference +providerReference");

    if (session) {
      query.session(session);
    }

    const evidence = await query;

    if (!evidence) {
      return null;
    }

    const now = new Date();

    // ───────────────────── INCOMPLETE LOOKUPS ─────────────────────

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

    // ───────────────────── ALREADY CONSUMED ─────────────────────

    if (evidence.status === "consumed") {
      throw this.createError({
        message: "This CAC verification has already been used.",

        code: "CAC_ONBOARDING_ALREADY_CONSUMED",
        statusCode: 409,
      });
    }

    // ───────────────────── REGISTRATION CONSISTENCY ─────────────────────

    /*
     * Evidence for another CAC registration
     * cannot satisfy this onboarding request.
     */

    if (evidence.registrationNumber !== input.registration.submitted) {
      return null;
    }

    // ───────────────────── EXPIRED EVIDENCE ─────────────────────

    if (!this.hasNotExpired(evidence, now) || evidence.consumedAt) {
      throw this.createError({
        message: "CAC verification has expired. Please verify again.",

        code: "CAC_ONBOARDING_EVIDENCE_EXPIRED",
        statusCode: 409,
      });
    }

    // ───────────────────── SUCCESSFUL MATCH REQUIRED ─────────────────────

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

    // ───────────────────── PRODUCTION REQUIRED ─────────────────────

    if (evidence.providerEnvironment !== "production") {
      throw this.createError({
        message: "Production CAC verification is required to continue.",

        code: "CAC_ONBOARDING_PRODUCTION_REQUIRED",
        statusCode: 409,
      });
    }

    // ───────────────────── EVIDENCE INTEGRITY ─────────────────────

    if (
      !["ninja", "dojah"].includes(evidence.provider) ||
      !evidence.checkedAt ||
      !evidence.lookupStartedAt ||
      !evidence.requestReference ||
      !CAC_REGISTRATION_PATTERN.test(evidence.registrationNumber) ||
      !this.hasCompleteRegistryEvidence(evidence)
    ) {
      throw this.createError({
        message: "CAC verification evidence is incomplete. Please contact support.",

        code: "CAC_ONBOARDING_INVALID_EVIDENCE",
        statusCode: 409,
      });
    }

    if (evidence.checkedAt < evidence.lookupStartedAt || evidence.checkedAt > now) {
      throw this.createError({
        message: "CAC verification timestamps are inconsistent.",

        code: "CAC_ONBOARDING_INVALID_EVIDENCE",
        statusCode: 409,
      });
    }

    return evidence;
  }

  // ───────────────────── TRANSACTIONAL CONSUMPTION ─────────────────────

  /*
   * Only trusted onboarding services should
   * invoke this method inside an active
   * MongoDB onboarding transaction.
   *
   * The caller must persist permanent CAC KYC
   * evidence and the registered legal business
   * name inside the SAME transaction.
   *
   * If the transaction fails, temporary evidence
   * consumption is rolled back.
   *
   * Consumption confirms the registry evidence
   * was transferred to permanent records.
   *
   * It does not approve the applicant's authority
   * to represent the business, confirm PCN premises
   * eligibility or grant employer marketplace access.
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

    /*
     * Recheck the relevant registry evidence
     * inside the atomic consumption filter.
     *
     * Version fencing prevents a newer lookup
     * result from being consumed through an
     * older onboarding request.
     *
     * A failed, superseded, staging or expired
     * lookup cannot satisfy this update.
     */

    const consumed = await PreOnboardingCACVerification.findOneAndUpdate(
      {
        _id: evidence._id,
        user: userId,

        __v: evidence.__v,

        status: CONSUMABLE_STATUS,
        consumedAt: null,

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
     * OnboardingService persists permanent CAC
     * KYC history and EmployerProfile.businessName
     * from this trusted registry result.
     */

    return evidence;
  }
}

module.exports = PreOnboardingCACVerificationService;
