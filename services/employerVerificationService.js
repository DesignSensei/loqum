// services/employerVerificationService.js

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

const PROTECTED_APPROVAL_STATUSES = new Set(["restricted", "rejected"]);

const APPROVAL_RESET_FIELDS = [
  "employerApprovalStatus",
  "employerApprovalStatusUpdatedAt",
  "employerApprovalStatusUpdatedBy",
  "approvedToPostShiftsAt",
  "approvedToPostShiftsBy",
  "employerApprovalNote",
  "employerRejectionReason",
];

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

    const name = value.trim();

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

    const admin = await User.findById(adminUserId).select("role accountStatus");

    if (!admin || admin.role !== "admin" || admin.accountStatus !== "active") {
      throw this.createError({
        message: "An active administrator is required.",
        code: "EMPLOYER_VERIFICATION_ADMIN_REQUIRED",
        statusCode: 403,
      });
    }

    return admin;
  }

  // ───────────────────── RECHECK CONTROL ─────────────────────

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
      if (error?.code !== 11000) throw error;

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
        if (renewalError) throw renewalError;
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

  // ───────────────────── APPROVAL AND MARKETPLACE READINESS ─────────────────────

  static getApprovalResetUpdates(employer) {
    if (PROTECTED_APPROVAL_STATUSES.has(employer?.employerApprovalStatus)) {
      return {};
    }

    return {
      employerApprovalStatus: "pending",
      employerApprovalStatusUpdatedAt: null,
      employerApprovalStatusUpdatedBy: null,
      approvedToPostShiftsAt: null,
      approvedToPostShiftsBy: null,
      employerApprovalNote: null,
      employerRejectionReason: null,
    };
  }

  static getVerificationReadiness(employer) {
    const cacVerified = employer?.cacVerificationStatus === "verified";

    const regulatoryVerified = employer?.regulatoryVerificationStatus === "verified";

    const adminApproved = employer?.employerApprovalStatus === "approved";

    const accountActive = employer?.accountStatus === "active";

    return {
      cacVerified,
      regulatoryVerified,
      adminApproved,
      accountActive,
      verificationReady: cacVerified && regulatoryVerified && adminApproved && accountActive,
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
   * Evaluating a CAC registration does NOT establish
   * the applicant's authority to represent the business,
   * PCN premises approval or final employer KYB approval.
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
        : registration?.prefix === "RC" &&
          (entityType === "COMPANY" ||
            (entityType.includes("COMPANY") && !entityType.startsWith("BUSINESS_NAME")));

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
   * Recent lookup suppression uses the CAC
   * registration number, provider and environment.
   *
   * A manually submitted legal business name
   * is never part of the lookup identity or cache key.
   *
   * This post-onboarding check remains distinct
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
      .sort({ lastCheckedAt: -1, createdAt: -1 })
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

  // ───────────────────── AUTHORITATIVE VERIFICATION PERSISTENCE ─────────────────────

  static async persistVerification({
    employerSnapshot,
    type,
    kycData,
    profileUpdates,
    lock = null,
  }) {
    if (!["cac", "facility_regulatory"].includes(type)) {
      throw this.createError({
        message: "Unsupported employer verification type.",
        code: "EMPLOYER_VERIFICATION_INVALID_TYPE",
        statusCode: 400,
      });
    }

    if (type === "cac") {
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

      /*
       * The legal business name may only be
       * changed using trusted verified CAC evidence.
       *
       * A failed or review-only CAC lookup must
       * not silently overwrite the business identity.
       */

      if (profileUpdates?.businessName !== undefined) {
        const verifiedName = this.getRegisteredBusinessName(kycData?.nameOnRecord);

        if (
          kycData?.status !== "verified" ||
          !verifiedName ||
          profileUpdates.businessName !== verifiedName
        ) {
          throw this.createError({
            message: "Registered business name updates require verified CAC evidence.",
            code: "EMPLOYER_CAC_NAME_UPDATE_NOT_AUTHORIZED",
            statusCode: 409,
          });
        }
      }
    }

    const session = await mongoose.startSession();

    try {
      let savedRecord;
      let updatedEmployer;

      await session.withTransaction(async () => {
        if (type === "cac") {
          await this.fenceCACLock(lock, session);
        }

        const filter = {
          _id: employerSnapshot._id,
          updatedAt: employerSnapshot.updatedAt,
        };

        if (type === "cac") {
          filter.businessName = employerSnapshot.businessName;
          filter.cacRegistrationNumber = employerSnapshot.cacRegistrationNumber;
        }

        if (type === "facility_regulatory") {
          filter.regulatoryBody = employerSnapshot.regulatoryBody;
          filter.regulatoryRegistrationNumber = employerSnapshot.regulatoryRegistrationNumber;
        }

        const currentEmployer = await EmployerProfile.findOne(filter).session(session);

        if (!currentEmployer) {
          throw this.createError({
            message: "Employer details changed during verification. Please retry.",
            code: "EMPLOYER_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        const safeUpdates = { ...profileUpdates };

        // Verification must not overwrite a separate admin restriction.
        if (PROTECTED_APPROVAL_STATUSES.has(currentEmployer.employerApprovalStatus)) {
          for (const field of APPROVAL_RESET_FIELDS) {
            delete safeUpdates[field];
          }
        }

        currentEmployer.set(safeUpdates);

        updatedEmployer = await currentEmployer.save({
          session,
        });

        await KYCVerification.updateMany(
          {
            employer: employerSnapshot._id,
            type,
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
              user: employerSnapshot.user,
              employer: employerSnapshot._id,
              ownerType: "employer",
              type,
              ...kycData,
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
   * Verify CAC registration against the configured
   * provider only when explicitly requested.
   *
   * A verified CAC record is reused unless an
   * authorised caller explicitly requests a recheck.
   *
   * No automatic scheduled re-verification,
   * provider fallback or duplicate paid request.
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

      // An uncertain production request remains locked.
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

    const recentAttempt = await this.getRecentCACAttempt({
      employerProfileId: employer._id,
      provider,
      environment,
      registrationNumber: registration.submitted,
    });

    if (recentAttempt && this.isWithinRecheckInterval(recentAttempt.lastCheckedAt)) {
      return {
        status: employer.cacVerificationStatus,
        verified: employer.cacVerificationStatus === "verified",
        skipped: true,
        provider,
        environment,
        reason: "A CAC verification attempt was made recently.",
      };
    }

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

      const reason = this.truncate(
        lookupError.message || "CAC verification could not be completed."
      );

      const retryable = lookupError?.details?.retryable === true;

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
          ...this.getApprovalResetUpdates(employer),
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
     * Before trusting a completed provider response,
     * confirm it belongs to this lookup request.
     *
     * Never persist staging evidence as production
     * or evaluate a different RC/BN registration.
     *
     * An inconsistent provider outcome requires
     * reconciliation, not an automatic second lookup.
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

    /*
     * Only an already CAC-verified business name
     * may be used as a previous authoritative name.
     *
     * A genuine change in the registry's legal name
     * during a forced recheck requires review rather
     * than silently overwriting an approved identity.
     *
     * This is not a comparison against a submitted
     * onboarding or trading name.
     */

    const previousAuthoritativeName =
      employer.cacVerificationStatus === "verified"
        ? this.getRegisteredBusinessName(employer.cacNameOnRecord || employer.businessName)
        : null;

    const registeredNameChanged = Boolean(
      previousAuthoritativeName &&
      registeredBusinessName &&
      !this.namesMatch(previousAuthoritativeName, registeredBusinessName)
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
        status: "pending",
        reason: evaluation.eligible
          ? "CAC sandbox lookup matched. Production verification is required."
          : "CAC sandbox lookup requires review and cannot support production approval.",
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
      reviewReasons.push(
        "Previously verified registered business name differs from current CAC record"
      );
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

      /*
       * The first successful CAC verification
       * sets the authoritative legal business name.
       *
       * Review-only evidence cannot overwrite it.
       */

      ...(verified ? { businessName: registeredBusinessName } : {}),
    };

    if (!verified) {
      Object.assign(profileUpdates, this.getApprovalResetUpdates(employer));
    }

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
      .select("+requestReference acquiredAt renewedAt expiresAt")
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

  // ───────────────────── PCN PREMISES REVIEW ─────────────────────

  static async recordPCNReview({
    employerProfileId,
    adminUserId,
    decision,
    nameOnRecord,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    const employer = await this.getEmployer(employerProfileId);

    if (employer.regulatoryBody !== "pcn") {
      throw this.createError({
        message: "This employer is not registered under PCN.",
        code: "EMPLOYER_VERIFICATION_NOT_PCN",
        statusCode: 400,
      });
    }

    const allowedDecisions = ["verified", "rejected", "needs_review"];

    if (!allowedDecisions.includes(decision)) {
      throw this.createError({
        message: "Invalid PCN verification decision.",
        code: "EMPLOYER_VERIFICATION_INVALID_DECISION",
        statusCode: 400,
      });
    }

    const cleanNote = this.truncate(note);

    if (cleanNote.length < 10) {
      throw this.createError({
        message: "Provide a meaningful PCN review note.",
        code: "EMPLOYER_VERIFICATION_INVALID_REVIEW_NOTE",
        statusCode: 400,
      });
    }

    const cleanName = String(nameOnRecord || "")
      .trim()
      .slice(0, 150);

    if (decision === "verified" && !cleanName) {
      throw this.createError({
        message: "The registered premises name is required.",
        code: "EMPLOYER_VERIFICATION_MISSING_PREMISES_NAME",
        statusCode: 400,
      });
    }

    const checkedAt = new Date();

    const verified = decision === "verified";
    const rejected = decision === "rejected";

    const profileUpdates = {
      regulatoryVerificationStatus: decision,
      regulatoryVerificationMethod: "manual",
      regulatoryVerificationSource: "pcn_public_portal",
      regulatoryNameOnRecord: cleanName || null,
      regulatoryLastCheckedAt: checkedAt,
      regulatoryVerifiedAt: verified ? checkedAt : null,
      regulatoryVerifiedBy: adminUserId,
      regulatoryVerificationNote: cleanNote,
      regulatoryRejectionReason: rejected ? cleanNote : null,
    };

    if (!verified) {
      Object.assign(profileUpdates, this.getApprovalResetUpdates(employer));
    }

    const saved = await this.persistVerification({
      employerSnapshot: employer,
      type: "facility_regulatory",
      kycData: {
        provider: "manual",
        providerEnvironment: null,
        status: decision,
        nameOnRecord: cleanName || null,
        reviewedBy: adminUserId,
        submittedAt: checkedAt,
        lastCheckedAt: checkedAt,
        verifiedAt: verified ? checkedAt : null,
        rejectedAt: rejected ? checkedAt : null,
        rejectionReason: rejected ? cleanNote : null,
        reviewNote: cleanNote,
        metadata: {
          regulatoryBody: "pcn",
          verificationSource: "pcn_public_portal",
          regulatoryRegistrationNumber: employer.regulatoryRegistrationNumber,
        },
      },
      profileUpdates,
    });

    return {
      status: decision,
      regulatoryBody: "pcn",
      verified,
      verificationId: saved.verification._id,
      employerProfileId: saved.employer._id,
      reviewedBy: adminUserId,
      reviewedAt: checkedAt,
    };
  }
}

module.exports = EmployerVerificationService;
