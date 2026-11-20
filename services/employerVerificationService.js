const mongoose = require("mongoose");
const crypto = require("crypto");

const EmployerProfile = require("../models/EmployerProfile");
const KYCVerification = require("../models/KYCVerification");
const VerificationRequestLock = require("../models/VerificationRequestLock");
const User = require("../models/User");

const CACVerificationService = require("./cacVerificationService");
const { createServiceError } = require("./helpers/serviceErrorHelper");

const SERVICE_ERROR_NAME = "EmployerVerificationServiceError";

const CAC_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
const CAC_LOCK_LEASE_MS = 15 * 60 * 1000;
const CAC_LOCK_RENEWAL_MS = 60 * 1000;

const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;

// Accept recognised company classifications only.
// Unknown provider classifications require review.
const CAC_RC_ENTITY_TYPES = new Set([
  "COMPANY",
  "PRIVATE_COMPANY",
  "PUBLIC_COMPANY",
  "PRIVATE_COMPANY_LIMITED_BY_SHARES",
  "PUBLIC_COMPANY_LIMITED_BY_SHARES",
  "COMPANY_LIMITED_BY_SHARES",
  "COMPANY_LIMITED_BY_GUARANTEE",
  "PRIVATE_COMPANY_LIMITED_BY_GUARANTEE",
  "PUBLIC_COMPANY_LIMITED_BY_GUARANTEE",
  "UNLIMITED_COMPANY",
  "PRIVATE_UNLIMITED_COMPANY",
  "PUBLIC_UNLIMITED_COMPANY",
  "LIMITED_LIABILITY_COMPANY",
  "PRIVATE_LIMITED_COMPANY",
  "PUBLIC_LIMITED_COMPANY",
]);

const CAC_PREFLIGHT_ERROR_CODES = new Set([
  "CAC_NOT_CONFIGURED",
  "CAC_INVALID_PROVIDER",
  "CAC_INVALID_ENVIRONMENT",
  "CAC_VERIFICATION_DISABLED",
  "CAC_PROVIDER_MISMATCH",
  "CAC_PROVIDER_NOT_READY",
  "CAC_PROVIDER_CONFIGURATION_ERROR",
  "CAC_UNSUPPORTED_REGISTRATION_FORMAT",
  "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE",
  "CAC_INVALID_REFERENCE",
  "CAC_LEGACY_CLIENT_UNSUPPORTED",
]);

// Only CAC profile fields may be changed by this service.
// Facility permits and account restrictions are managed elsewhere.
const CAC_PROFILE_UPDATE_FIELDS = new Set([
  "cacVerificationStatus",
  "cacVerificationMethod",
  "cacVerificationSource",
  "cacNameOnRecord",
  "cacVerifiedAt",
  "cacLastCheckedAt",
  "cacVerifiedBy",
  "cacVerificationNote",
  "cacRejectionReason",
]);

class EmployerVerificationService {
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

  // ───────────────────── IDENTIFIERS AND NAMES ─────────────────────

  static assertObjectId(value, label) {
    if (!mongoose.isValidObjectId(value)) {
      throw this.createError({
        message: `Invalid ${label}.`,
        code: "EMPLOYER_VERIFICATION_INVALID_ID",
        statusCode: 400,
      });
    }
  }

  /*
   * Name comparison is retained for comparing
   * existing CAC-authoritative business names
   * during an explicitly requested recheck.
   *
   * It must not compare a manually submitted
   * business name against the registry to decide
   * whether an initial CAC lookup is eligible.
   */

  static normalizeName(value) {
    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/[^A-Z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static namesMatch(nameA, nameB) {
    const first = this.normalizeName(nameA);
    const second = this.normalizeName(nameB);

    return Boolean(first && second && first === second);
  }

  /*
   * The authoritative registered business name
   * is obtained from the selected CAC provider.
   *
   * Do not truncate long registry names or
   * fabricate one from user-submitted fields.
   *
   * Invalid or incomplete names require review
   * rather than becoming verified evidence.
   */

  static getRegisteredBusinessName(value) {
    if (typeof value !== "string") {
      return null;
    }

    const name = value.normalize("NFC").trim().replace(/\s+/g, " ");

    if (!name || name.length > 150 || /[\u0000-\u001F\u007F]/.test(name)) {
      return null;
    }

    return name;
  }

  static truncate(value, maximum = 500) {
    return String(value || "")
      .trim()
      .slice(0, maximum);
  }

  // ───────────────────── EMPLOYER AND ADMIN AUTHORIZATION ─────────────────────

  static async getEmployer(employerProfileId) {
    this.assertObjectId(employerProfileId, "employer profile ID");

    const employer = await EmployerProfile.findById(employerProfileId);

    if (!employer) {
      throw this.createError({
        message: "Employer profile not found.",
        code: "EMPLOYER_VERIFICATION_EMPLOYER_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employer;
  }

  static async assertAdmin(adminUserId) {
    this.assertObjectId(adminUserId, "admin user ID");

    const admin = await User.findById(adminUserId).select("role accountStatus isVerified");

    if (
      !admin ||
      admin.role !== "admin" ||
      admin.accountStatus !== "active" ||
      admin.isVerified !== true
    ) {
      throw this.createError({
        message: "An active administrator is required.",
        code: "EMPLOYER_VERIFICATION_ADMIN_REQUIRED",
        statusCode: 403,
      });
    }

    return admin;
  }

  // ───────────────────── RECENT ATTEMPT HELPER ─────────────────────

  /*
   * Retained for compatibility with callers that
   * inspect recent verification history.
   *
   * The post-onboarding verification workflow no
   * longer uses this to enforce a blanket cooldown.
   */

  static isWithinRecheckInterval(date) {
    if (!date) return false;

    const checkedAt = new Date(date).getTime();

    return (
      Number.isFinite(checkedAt) &&
      checkedAt <= Date.now() &&
      Date.now() - checkedAt < CAC_RECHECK_INTERVAL_MS
    );
  }

  // ───────────────────── CAC REQUEST LOCK ─────────────────────

  static getCACLockKey(employerProfileId) {
    this.assertObjectId(employerProfileId, "employer profile ID");

    return `cac:${String(employerProfileId).toLowerCase()}`;
  }

  static async acquireCACLock({ employerProfileId, requestReference }) {
    const lockKey = this.getCACLockKey(employerProfileId);
    const ownerToken = crypto.randomBytes(32).toString("hex");

    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + CAC_LOCK_LEASE_MS);

    try {
      await VerificationRequestLock.create({
        _id: lockKey,
        employer: employerProfileId,
        ownerToken,
        acquiredAt,
        expiresAt,
        requestReference,
      });
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }

      const existing = await VerificationRequestLock.findById(lockKey).select("expiresAt").lean();

      if (!existing) {
        throw this.createError({
          message: "CAC lock state changed. Please try again.",
          code: "EMPLOYER_CAC_LOCK_CONFLICT",
          statusCode: 409,
        });
      }

      const expired = new Date(existing.expiresAt).getTime() <= Date.now();

      throw this.createError({
        message: expired
          ? "An earlier CAC request requires administrative reconciliation."
          : "CAC verification is already in progress for this employer.",
        code: expired
          ? "EMPLOYER_CAC_LOCK_RECONCILIATION_REQUIRED"
          : "EMPLOYER_CAC_VERIFICATION_IN_PROGRESS",
        statusCode: 409,
      });
    }

    return { lockKey, ownerToken };
  }

  static async assertCACLockOwner(lock) {
    const owner = await VerificationRequestLock.exists({
      _id: lock.lockKey,
      ownerToken: lock.ownerToken,
      expiresAt: { $gt: new Date() },
    });

    if (!owner) {
      throw this.createError({
        message: "CAC verification lock ownership is no longer valid.",
        code: "EMPLOYER_CAC_LOCK_LOST",
        statusCode: 409,
      });
    }
  }

  static async renewCACLock(lock) {
    const now = new Date();

    const result = await VerificationRequestLock.updateOne(
      {
        _id: lock.lockKey,
        ownerToken: lock.ownerToken,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          renewedAt: now,
          expiresAt: new Date(now.getTime() + CAC_LOCK_LEASE_MS),
        },
      }
    );

    if (result.matchedCount !== 1) {
      throw this.createError({
        message: "CAC verification lock could not be renewed.",
        code: "EMPLOYER_CAC_LOCK_RENEWAL_FAILED",
        statusCode: 409,
      });
    }
  }

  static startCACLockHeartbeat(lock) {
    let stopped = false;
    let renewalError = null;
    let pending = Promise.resolve();

    const timer = setInterval(() => {
      if (stopped || renewalError) return;

      pending = pending
        .then(() => this.renewCACLock(lock))
        .catch((error) => {
          renewalError = error;
        });
    }, CAC_LOCK_RENEWAL_MS);

    timer.unref?.();

    return {
      async stop() {
        stopped = true;
        clearInterval(timer);
        await pending;
      },

      assertHealthy() {
        if (renewalError) {
          throw renewalError;
        }
      },
    };
  }

  // Fences verification writes against concurrent lock recovery.

  static async fenceCACLock(lock, session) {
    const now = new Date();

    const result = await VerificationRequestLock.updateOne(
      {
        _id: lock.lockKey,
        ownerToken: lock.ownerToken,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          renewedAt: now,
          expiresAt: new Date(now.getTime() + CAC_LOCK_LEASE_MS),
        },
      },
      { session }
    );

    if (result.matchedCount !== 1) {
      throw this.createError({
        message: "CAC lock ownership was lost before verification could be saved.",
        code: "EMPLOYER_CAC_LOCK_FENCE_FAILED",
        statusCode: 409,
      });
    }
  }

  static async releaseCACLock(lock) {
    const result = await VerificationRequestLock.deleteOne({
      _id: lock.lockKey,
      ownerToken: lock.ownerToken,
    });

    if (result.deletedCount !== 1) {
      throw this.createError({
        message: "Unable to confirm CAC verification lock release.",
        code: "EMPLOYER_CAC_LOCK_RELEASE_FAILED",
        statusCode: 409,
      });
    }
  }

  // ───────────────────── BUSINESS IDENTITY READINESS ─────────────────────

  /*
   * Compatibility summary for employer verification dashboards.
   * This method does NOT determine marketplace eligibility.
   * Marketplace access is calculated for a specific branch only,
   * after checking its applicable, current facility permits.
   *
   * verificationReady intentionally remains false here so legacy
   * consumers cannot interpret a business-wide CAC result as
   * permission to post shifts before branch checks are integrated.
   */

  static getVerificationReadiness(employer) {
    const cacVerified = employer?.cacVerificationStatus === "verified";
    const accountActive = employer?.accountStatus === "active";

    return {
      cacVerified,
      accountActive,
      businessIdentityReady: cacVerified && accountActive,
      branchPermitsRequired: true,
      verificationReady: false,
    };
  }

  // ───────────────────── CAC REGISTRY EVALUATION ─────────────────────

  /*
   * Determine whether the CAC registry supplied a
   * supported active registration and an authoritative
   * registered legal business name.
   *
   * No user-entered business name is required.
   *
   * Registration numbers are compared in the
   * normalized RC/BN form returned by the adapter.
   *
   * Evaluating a CAC registration does not establish that
   * any physical branch has an approved operating permit.
   */

  static evaluateCACResult({ registration, result } = {}) {
    const requestedNumber =
      typeof registration?.submitted === "string"
        ? registration.submitted.trim().toUpperCase()
        : null;

    const responseNumber =
      typeof result?.registrationNumber === "string"
        ? result.registrationNumber.trim().toUpperCase()
        : null;

    const registrationMatches = Boolean(
      requestedNumber &&
      responseNumber &&
      CAC_REGISTRATION_PATTERN.test(requestedNumber) &&
      responseNumber === requestedNumber
    );

    const entityType = String(result?.entityType || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

    const categoryMatches =
      registration?.prefix === "BN"
        ? entityType === "BUSINESS_NAME" || entityType.startsWith("BUSINESS_NAME_")
        : registration?.prefix === "RC" && CAC_RC_ENTITY_TYPES.has(entityType);

    const registrationActive =
      String(result?.entityStatus || "")
        .trim()
        .toUpperCase() === "ACTIVE";

    const registeredBusinessName = this.getRegisteredBusinessName(result?.entityName);

    const checks = {
      registrationNumberMatches: registrationMatches,
      entityCategoryMatches: categoryMatches,
      registrationIsActive: registrationActive,
    };

    const eligible = Boolean(Object.values(checks).every(Boolean) && registeredBusinessName);

    const reasons = [];

    if (!registrationMatches) {
      reasons.push("Registration number mismatch");
    }

    if (!categoryMatches) {
      reasons.push("Registration category mismatch or unconfirmed");
    }

    if (!registrationActive) {
      reasons.push("Registration is not confirmed active");
    }

    if (!registeredBusinessName) {
      reasons.push("Registered legal business name is missing or invalid");
    }

    return {
      eligible,
      checks,
      reasons,
      registeredBusinessName,
    };
  }

  // ───────────────────── RECENT CAC ATTEMPTS ─────────────────────

  /*
   * An optional recent-lookup record can be inspected by
   * registration number, provider and environment.
   * This helper does not impose a waiting period.
   *
   * A manually submitted legal business name
   * is never part of the lookup identity or cache key.
   *
   * Post-onboarding rechecks remain distinct
   * from the temporary pre-onboarding lookup cache.
   */

  static async getRecentCACAttempt({
    employerProfileId,
    provider,
    environment,
    registrationNumber,
  }) {
    const cutoff = new Date(Date.now() - CAC_RECHECK_INTERVAL_MS);

    return KYCVerification.findOne({
      employer: employerProfileId,
      type: "cac",
      provider,
      providerEnvironment: environment,
      "metadata.submittedRegistrationNumber": registrationNumber,
      lastCheckedAt: { $gte: cutoff },
    })
      .sort({
        lastCheckedAt: -1,
        createdAt: -1,
      })
      .select("status lastCheckedAt")
      .lean();
  }

  // ───────────────────── NON-AUTHORITATIVE KYC HISTORY ─────────────────────

  static async recordNonAuthoritativeAttempt({
    employer,
    provider,
    environment,
    status,
    reason,
    company = null,
    requestReference = null,
    providerReference = null,
    metadata = {},
    lock = null,
  }) {
    if (!["ninja", "dojah"].includes(provider)) {
      throw this.createError({
        message: "Invalid CAC verification provider.",
        code: "EMPLOYER_VERIFICATION_INVALID_PROVIDER",
        statusCode: 400,
      });
    }

    if (!["staging", "production"].includes(environment)) {
      throw this.createError({
        message: "Invalid CAC verification environment.",
        code: "EMPLOYER_VERIFICATION_INVALID_ENVIRONMENT",
        statusCode: 400,
      });
    }

    if (!["pending", "needs_review", "failed"].includes(status)) {
      throw this.createError({
        message: "Invalid non-authoritative verification status.",
        code: "EMPLOYER_VERIFICATION_INVALID_STATUS",
        statusCode: 400,
      });
    }

    const checkedAt = new Date();

    const record = {
      user: employer.user,
      employer: employer._id,
      ownerType: "employer",
      type: "cac",
      provider,
      providerEnvironment: environment,
      requestReference,
      providerReference,
      status,
      nameOnRecord: this.getRegisteredBusinessName(company?.entityName),
      submittedAt: checkedAt,
      lastCheckedAt: checkedAt,
      failureReason: status === "failed" ? this.truncate(reason) : null,
      reviewNote: status === "pending" || status === "needs_review" ? this.truncate(reason) : null,
      metadata,
      isActive: false,
    };

    if (!lock) {
      return KYCVerification.create(record);
    }

    const session = await mongoose.startSession();

    try {
      let verification;

      await session.withTransaction(async () => {
        await this.fenceCACLock(lock, session);

        const records = await KYCVerification.create([record], { session });

        verification = records[0];
      });

      return verification;
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── AUTHORITATIVE CAC PERSISTENCE ─────────────────────

  /*
   * CAC verification history and EmployerProfile CAC summary are updated
   * together, inside the existing fenced CAC-request transaction.
   *
   * Facility regulatory history is not written here. Branch permits are
   * reviewed independently and must never be globally deactivated by a
   * business-level CAC recheck.
   *
   * An established legal name cannot be changed by a routine recheck.
   * A provider name difference results in needs_review.
   */

  static async persistVerification({
    employerSnapshot,
    type,
    kycData,
    profileUpdates,
    lock = null,
  }) {
    if (type !== "cac") {
      throw this.createError({
        message: "This service only persists business-level CAC verification.",
        code: "EMPLOYER_VERIFICATION_CAC_ONLY",
        statusCode: 400,
      });
    }

    if (
      !["ninja", "dojah"].includes(kycData?.provider) ||
      kycData?.providerEnvironment !== "production"
    ) {
      throw this.createError({
        message: "Authoritative CAC verification requires a supported production provider.",
        code: "EMPLOYER_VERIFICATION_NON_PRODUCTION",
        statusCode: 409,
      });
    }

    if (!lock) {
      throw this.createError({
        message: "A valid CAC verification lock is required.",
        code: "EMPLOYER_CAC_LOCK_REQUIRED",
        statusCode: 409,
      });
    }

    if (!employerSnapshot?._id || !employerSnapshot?.user || !employerSnapshot?.updatedAt) {
      throw this.createError({
        message: "Current employer CAC verification evidence is required.",
        code: "EMPLOYER_CAC_SNAPSHOT_REQUIRED",
        statusCode: 409,
      });
    }

    if (!profileUpdates || typeof profileUpdates !== "object" || Array.isArray(profileUpdates)) {
      throw this.createError({
        message: "Invalid CAC profile update.",
        code: "EMPLOYER_CAC_INVALID_UPDATE",
        statusCode: 400,
      });
    }

    for (const field of Object.keys(profileUpdates)) {
      if (!CAC_PROFILE_UPDATE_FIELDS.has(field)) {
        throw this.createError({
          message: "CAC verification cannot update business identity, account or facility state.",
          code: "EMPLOYER_CAC_UNAUTHORIZED_PROFILE_UPDATE",
          statusCode: 409,
        });
      }
    }

    if (
      !["verified", "needs_review"].includes(kycData?.status) ||
      profileUpdates.cacVerificationStatus !== kycData.status
    ) {
      throw this.createError({
        message: "CAC verification outcome is inconsistent.",
        code: "EMPLOYER_CAC_STATUS_MISMATCH",
        statusCode: 409,
      });
    }

    if (
      kycData.status === "verified" &&
      (kycData.nameOnRecord !== employerSnapshot.businessName ||
        profileUpdates.cacNameOnRecord !== employerSnapshot.businessName)
    ) {
      throw this.createError({
        message: "An established CAC legal name cannot change during an ordinary recheck.",
        code: "EMPLOYER_CAC_NAME_CORRECTION_REQUIRED",
        statusCode: 409,
      });
    }

    const session = await mongoose.startSession();

    try {
      let savedRecord;
      let updatedEmployer;

      await session.withTransaction(async () => {
        await this.fenceCACLock(lock, session);

        const filter = {
          _id: employerSnapshot._id,
          updatedAt: employerSnapshot.updatedAt,
          businessName: employerSnapshot.businessName,
          cacRegistrationNumber: employerSnapshot.cacRegistrationNumber,
        };

        const currentEmployer = await EmployerProfile.findOne(filter).session(session);

        if (!currentEmployer) {
          throw this.createError({
            message: "Employer details changed during verification. Please retry.",
            code: "EMPLOYER_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        // Account restrictions and branch permit decisions are untouched.
        currentEmployer.set(profileUpdates);

        updatedEmployer = await currentEmployer.save({ session });

        await KYCVerification.updateMany(
          {
            employer: employerSnapshot._id,
            type: "cac",
            isActive: true,
          },
          {
            $set: { isActive: false },
          },
          { session }
        );

        const records = await KYCVerification.create(
          [
            {
              ...kycData,
              user: employerSnapshot.user,
              employer: employerSnapshot._id,
              ownerType: "employer",
              type: "cac",
              isActive: true,
            },
          ],
          { session }
        );

        savedRecord = records[0];
      });

      return {
        employer: updatedEmployer,
        verification: savedRecord,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── POST-ONBOARDING CAC VERIFICATION ─────────────────────

  /*
   * Verify CAC registration against the configured provider
   * only when explicitly requested.
   *
   * A verified CAC record is reused unless an authorised caller
   * explicitly requests a recheck.
   *
   * No automatic scheduled re-verification, provider fallback
   * or duplicate paid request.
   */

  static async verifyCAC({ employerProfileId, force = false, httpClient, fetchImpl } = {}) {
    if (fetchImpl !== undefined) {
      throw this.createError({
        message: "Legacy fetchImpl is no longer supported. Use httpClient.",
        code: "EMPLOYER_VERIFICATION_LEGACY_CLIENT",
        statusCode: 400,
      });
    }

    const employer = await this.getEmployer(employerProfileId);

    if (employer.countryCode !== "NG") {
      return {
        status: employer.cacVerificationStatus,
        verified: employer.cacVerificationStatus === "verified",
        skipped: true,
        reason: "CAC verification applies to Nigerian businesses.",
      };
    }

    if (!force && employer.cacVerificationStatus === "verified") {
      return {
        status: "verified",
        verified: true,
        skipped: true,
        reason: "CAC verification is already complete.",
      };
    }

    const requestReference = crypto.randomUUID();

    const lock = await this.acquireCACLock({
      employerProfileId: employer._id,
      requestReference,
    });

    const state = {
      providerRequested: false,
      completedSafely: false,
    };

    const heartbeat = this.startCACLockHeartbeat(lock);

    try {
      return await this.runCACVerificationUnderLock({
        employerProfileId: employer._id,
        force,
        httpClient,
        requestReference,
        lock,
        state,
        heartbeat,
      });
    } finally {
      await heartbeat.stop();

      // Uncertain production requests remain locked.
      if (!state.providerRequested || state.completedSafely) {
        await this.releaseCACLock(lock);
      }
    }
  }

  static async runCACVerificationUnderLock({
    employerProfileId,
    force,
    httpClient,
    requestReference,
    lock,
    state,
    heartbeat,
  }) {
    const employer = await this.getEmployer(employerProfileId);

    if (employer.countryCode !== "NG") {
      return {
        status: employer.cacVerificationStatus,
        verified: employer.cacVerificationStatus === "verified",
        skipped: true,
        reason: "CAC verification applies to Nigerian businesses.",
      };
    }

    if (!force && employer.cacVerificationStatus === "verified") {
      return {
        status: "verified",
        verified: true,
        skipped: true,
        reason: "CAC verification is already complete.",
      };
    }

    const provider = CACVerificationService.getProvider();
    const environment = CACVerificationService.getEnvironment(provider);

    const registration = CACVerificationService.normalizeRegistrationNumber(
      employer.cacRegistrationNumber
    );

    // Locking replaces the former blanket post-onboarding cooldown.
    await this.assertCACLockOwner(lock);

    let lookupResult = null;
    let lookupError = null;

    try {
      state.providerRequested = true;

      lookupResult = await CACVerificationService.lookupRegistration({
        registrationNumber: registration.submitted,
        reference: requestReference,
        ...(httpClient !== undefined ? { httpClient } : {}),
      });
    } catch (error) {
      lookupError = error;
    }

    await heartbeat.stop();
    heartbeat.assertHealthy();
    await this.assertCACLockOwner(lock);

    const checkedAt = new Date();

    const baseMetadata = {
      submittedRegistrationNumber: registration.submitted,
    };

    // ───────────────────── LOOKUP ERRORS ─────────────────────

    if (lookupError) {
      const errorCode = lookupError.code || "CAC_LOOKUP_FAILED";

      const reason =
        errorCode === "CAC_COMPANY_NOT_FOUND"
          ? "CAC registration was not found."
          : "CAC verification could not be completed safely.";

      const retryable = lookupError?.details?.retryable === true || lookupError?.retryable === true;

      if (CAC_PREFLIGHT_ERROR_CODES.has(errorCode)) {
        state.completedSafely = true;

        return {
          status: employer.cacVerificationStatus,
          verified: employer.cacVerificationStatus === "verified",
          skipped: true,
          verificationChanged: false,
          provider,
          environment,
          errorCode,
          reason,
        };
      }

      if (environment !== "production") {
        const attempt = await this.recordNonAuthoritativeAttempt({
          employer,
          provider,
          environment,
          status: "failed",
          reason,
          requestReference,
          metadata: {
            ...baseMetadata,
            errorCode,
            stagingOnly: true,
            retryable,
          },
          lock,
        });

        state.completedSafely = true;

        return {
          status: employer.cacVerificationStatus,
          verified: employer.cacVerificationStatus === "verified",
          verificationChanged: false,
          stagingOnly: true,
          provider,
          environment,
          retryable,
          errorCode,
          reason,
          attemptId: attempt._id,
        };
      }

      const confirmedNotFound = errorCode === "CAC_COMPANY_NOT_FOUND";

      if (!confirmedNotFound) {
        const attempt = await this.recordNonAuthoritativeAttempt({
          employer,
          provider,
          environment,
          status: "failed",
          reason,
          requestReference,
          metadata: {
            ...baseMetadata,
            errorCode,
            retryable,
          },
          lock,
        });

        return {
          status: employer.cacVerificationStatus,
          verified: employer.cacVerificationStatus === "verified",
          verificationChanged: false,
          providerFailure: true,
          requiresManualReconciliation: true,
          provider,
          environment,
          retryable,
          errorCode,
          reason,
          attemptId: attempt._id,
        };
      }

      const saved = await this.persistVerification({
        employerSnapshot: employer,
        type: "cac",
        lock,
        kycData: {
          provider,
          providerEnvironment: "production",
          requestReference,
          status: "needs_review",
          submittedAt: checkedAt,
          lastCheckedAt: checkedAt,
          reviewNote: reason,
          metadata: {
            ...baseMetadata,
            errorCode,
          },
        },
        profileUpdates: {
          cacVerificationStatus: "needs_review",
          cacVerificationMethod: "api",
          cacVerificationSource: "provider",
          cacNameOnRecord: null,
          cacVerifiedAt: null,
          cacVerifiedBy: null,
          cacLastCheckedAt: checkedAt,
          cacVerificationNote: reason,
          cacRejectionReason: null,
        },
      });

      state.completedSafely = true;

      return {
        status: "needs_review",
        verified: false,
        requiresReview: true,
        verificationChanged: true,
        provider,
        environment,
        errorCode,
        reason,
        verificationId: saved.verification._id,
      };
    }

    // ───────────────────── RESPONSE VALIDATION ─────────────────────

    /*
     * A completed provider result must belong to the same
     * provider, environment, registration and request.
     * Mismatches require reconciliation, not automatic retry.
     */

    if (
      !lookupResult ||
      lookupResult.provider !== provider ||
      lookupResult.environment !== environment ||
      lookupResult.registration?.submitted !== registration.submitted ||
      lookupResult.registration?.prefix !== registration.prefix ||
      lookupResult.registration?.rc_number !== registration.rc_number ||
      (lookupResult.requestReference != null &&
        lookupResult.requestReference !== requestReference) ||
      !lookupResult.result ||
      typeof lookupResult.result !== "object" ||
      Array.isArray(lookupResult.result)
    ) {
      throw this.createError({
        message: "CAC verification result could not be confirmed.",
        code: "EMPLOYER_CAC_RESULT_CONTEXT_MISMATCH",
        statusCode: 502,
      });
    }

    // ───────────────────── RESULT EVALUATION ─────────────────────

    const company = lookupResult.result;

    const evaluation = this.evaluateCACResult({
      registration,
      result: company,
    });

    const {
      registrationNumberMatches: registrationMatches,
      entityCategoryMatches: categoryMatches,
      registrationIsActive: registrationActive,
    } = evaluation.checks;

    const registeredBusinessName = evaluation.registeredBusinessName;

    // Preserve the established CAC legal identity during routine rechecks.
    const previousAuthoritativeName = this.getRegisteredBusinessName(employer.businessName);

    const registeredNameChanged = Boolean(
      registeredBusinessName &&
      previousAuthoritativeName &&
      registeredBusinessName !== previousAuthoritativeName
    );

    const resolvedRequestReference = lookupResult.requestReference || requestReference;

    const providerReference = lookupResult.providerReference || null;

    const evidenceMetadata = {
      ...baseMetadata,
      responseRegistrationNumber: company.registrationNumber || null,
      responseEntityType: company.entityType || null,
      responseEntityStatus: company.entityStatus || null,
      responseRegistrationDate: company.registrationDate || null,
      endpoint: lookupResult.endpoint || null,
      checks: evaluation.checks,
      registeredNameChanged,
    };

    // ───────────────────── STAGING RESULT ─────────────────────

    if (environment !== "production") {
      const attempt = await this.recordNonAuthoritativeAttempt({
        employer,
        provider,
        environment,
        status: "needs_review",
        reason: evaluation.eligible
          ? "CAC sandbox lookup matched. Production verification is required."
          : "CAC sandbox lookup requires review and cannot establish production verification.",
        company,
        requestReference: resolvedRequestReference,
        providerReference,
        metadata: {
          ...evidenceMetadata,
          stagingOnly: true,
        },
        lock,
      });

      state.completedSafely = true;

      return {
        status: employer.cacVerificationStatus,
        verified: employer.cacVerificationStatus === "verified",
        verificationChanged: false,
        stagingOnly: true,
        requiresProductionVerification: true,
        provider,
        environment,
        checks: evaluation.checks,
        attemptId: attempt._id,
        reason: "Staging lookup completed without changing production verification.",
      };
    }

    // ───────────────────── PRODUCTION RESULT ─────────────────────

    const verified = evaluation.eligible && !registeredNameChanged;

    const status = verified ? "verified" : "needs_review";

    const reviewReasons = [...evaluation.reasons];

    if (registeredNameChanged) {
      reviewReasons.push("Established registered business name differs from current CAC record");
    }

    const note = verified
      ? "CAC registration verified through the configured provider."
      : reviewReasons.length
        ? reviewReasons.join("; ")
        : "CAC registration requires administrative review.";

    const profileUpdates = {
      cacVerificationStatus: status,
      cacVerificationMethod: "api",
      cacVerificationSource: "provider",
      cacNameOnRecord: registeredBusinessName,
      cacLastCheckedAt: checkedAt,
      cacVerifiedAt: verified ? checkedAt : null,
      cacVerifiedBy: null,
      cacVerificationNote: this.truncate(note),
      cacRejectionReason: null,
    };

    const saved = await this.persistVerification({
      employerSnapshot: employer,
      type: "cac",
      lock,
      kycData: {
        provider,
        providerEnvironment: "production",
        requestReference: resolvedRequestReference,
        providerReference,
        status,
        nameOnRecord: registeredBusinessName,
        submittedAt: checkedAt,
        lastCheckedAt: checkedAt,
        verifiedAt: verified ? checkedAt : null,
        reviewNote: verified ? null : this.truncate(note),
        metadata: evidenceMetadata,
      },
      profileUpdates,
    });

    state.completedSafely = true;

    return {
      status,
      verified,
      requiresReview: !verified,
      verificationChanged: true,
      registrationMatches,
      categoryMatches,
      registrationActive,
      registeredNameChanged,
      provider,
      environment: "production",
      verificationId: saved.verification._id,
      employerProfileId: saved.employer._id,
      reason: note,
    };
  }

  // ───────────────────── CAC LOCK RECONCILIATION ─────────────────────

  static async getCACLockForReconciliation({ adminUserId, employerProfileId } = {}) {
    await this.assertAdmin(adminUserId);

    const lockKey = this.getCACLockKey(employerProfileId);

    const lock = await VerificationRequestLock.findById(lockKey)
      .select("+requestReference employer acquiredAt renewedAt expiresAt")
      .lean();

    if (!lock) {
      return {
        locked: false,
        requiresReconciliation: false,
      };
    }

    const expired = new Date(lock.expiresAt).getTime() <= Date.now();

    return {
      locked: true,
      requiresReconciliation: expired,
      employerProfileId: String(lock.employer),
      requestReference: lock.requestReference,
      acquiredAt: lock.acquiredAt,
      renewedAt: lock.renewedAt,
      expiresAt: lock.expiresAt,
    };
  }

  static async reconcileCACLock({
    adminUserId,
    employerProfileId,
    requestReference,
    resolution,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    const employer = await this.getEmployer(employerProfileId);

    const lockKey = this.getCACLockKey(employer._id);

    const cleanNote = this.truncate(note);
    const cleanReference = String(requestReference || "").trim();

    const allowedResolutions = ["provider_not_called", "provider_outcome_confirmed"];

    if (!allowedResolutions.includes(resolution)) {
      throw this.createError({
        message: "Invalid CAC lock reconciliation resolution.",
        code: "EMPLOYER_CAC_INVALID_RECONCILIATION",
        statusCode: 400,
      });
    }

    if (!cleanReference || cleanNote.length < 20) {
      throw this.createError({
        message: "Provide the original request reference and a meaningful reconciliation note.",
        code: "EMPLOYER_CAC_RECONCILIATION_DETAILS_REQUIRED",
        statusCode: 400,
      });
    }

    const session = await mongoose.startSession();

    try {
      let releasedLock;

      await session.withTransaction(async () => {
        const now = new Date();

        releasedLock = await VerificationRequestLock.findOneAndDelete({
          _id: lockKey,
          requestReference: cleanReference,
          expiresAt: { $lte: now },
        }).session(session);

        if (!releasedLock) {
          throw this.createError({
            message: "The CAC lock is active, missing, or its request reference does not match.",
            code: "EMPLOYER_CAC_RECONCILIATION_CONFLICT",
            statusCode: 409,
          });
        }

        await KYCVerification.create(
          [
            {
              user: employer.user,
              employer: employer._id,
              ownerType: "employer",
              type: "cac",
              provider: "internal_review",
              providerEnvironment: null,
              status: "needs_review",
              submittedAt: now,
              lastCheckedAt: now,
              reviewedBy: adminUserId,
              reviewNote: cleanNote,
              isActive: false,
              metadata: {
                action: "cac_lock_reconciliation",
                requestReference: cleanReference,
                resolution,
              },
            },
          ],
          { session }
        );
      });

      return {
        reconciled: true,
        employerProfileId: String(employer._id),
        resolution,
        reviewedBy: adminUserId,
      };
    } finally {
      await session.endSession();
    }
  }
}

module.exports = EmployerVerificationService;
