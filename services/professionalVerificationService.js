// services/professionalVerificationService.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");
const KYCVerification = require("../models/KYCVerification");
const User = require("../models/User");

const IdentityVerificationService = require("./identityVerificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const PROFESSIONAL_VERIFICATION_SERVICE_ERROR_NAME = "ProfessionalVerificationServiceError";

const IDENTITY_LOOKUP_COOLDOWN_MS = 10 * 60 * 1000;

class ProfessionalVerificationService {
  /*
   * PROFESSIONAL VERIFICATION ARCHITECTURE
   *
   * Owns:
   * - Professional identity verification orchestration;
   * - Verification attempt persistence;
   * - Hosted KYC initiation and result synchronization;
   * - Administrative identity and professional licence reviews;
   * - Licence-number changes;
   * - Professional approval decisions;
   * - Verification readiness assessment.
   *
   * Does NOT own:
   * - Provider-specific HTTP implementations;
   * - External identity registry APIs;
   * - Automatic provider fallback;
   * - Verification billing;
   * - Financial restrictions or sanctions;
   * - Shift assignment or payment execution.
   *
   * IDENTITY POLICY
   *
   * NIN/BVN registry matching does not authenticate
   * the person supplying the identifier.
   *
   * Hosted identity checks must establish required
   * selfie/liveness and identity matching evidence.
   *
   * The current Ninja normalized result does not
   * expose enough biometric evidence for safe
   * automatic approval. Such results require review.
   *
   * LICENCE POLICY
   *
   * Professional licence verification is manual.
   *
   * Identity and licence verification are one-time.
   * No annual or expiry-driven re-verification.
   *
   * Changing the licence number resets licence
   * verification and final professional approval.
   *
   * Identity verification remains unchanged when
   * only the licence number changes.
   *
   * SECURITY
   *
   * Never persist raw NIN/BVN values.
   * Never persist full provider responses.
   * Never persist provider credentials.
   * Never automatically retry paid lookups.
   */

  // ───────────────────────── ERRORS ─────────────────────────

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: PROFESSIONAL_VERIFICATION_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  // ───────────────────────── HELPERS ─────────────────────────

  static assertObjectId(value, label) {
    if (!mongoose.isValidObjectId(value)) {
      throw this.createError({
        message: `Invalid ${label}.`,
        code: "PROFESSIONAL_VERIFICATION_INVALID_ID",
        statusCode: 400,
      });
    }
  }

  static normalizeName(value) {
    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/[^A-Z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static normalizeLicenceNumber(value) {
    const number = String(value || "")
      .normalize("NFKC")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");

    if (!number || number.length > 100) {
      throw this.createError({
        message: "A valid professional licence number is required.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_LICENCE_NUMBER",
        statusCode: 400,
      });
    }

    return number;
  }

  static truncate(value, maximum = 500) {
    return String(value || "")
      .trim()
      .slice(0, maximum);
  }

  static async getProfessional(professionalProfileId) {
    this.assertObjectId(professionalProfileId, "professional profile ID");

    const profile = await ProfessionalProfile.findById(professionalProfileId);

    if (!profile) {
      throw this.createError({
        message: "Professional profile not found.",
        code: "PROFESSIONAL_VERIFICATION_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return profile;
  }

  static async getOwnedProfessional(professionalProfileId, userId) {
    this.assertObjectId(professionalProfileId, "professional profile ID");

    this.assertObjectId(userId, "user ID");

    const profile = await ProfessionalProfile.findOne({
      _id: professionalProfileId,
      user: userId,
    });

    if (!profile) {
      throw this.createError({
        message: "Professional profile not found or access denied.",
        code: "PROFESSIONAL_VERIFICATION_ACCESS_DENIED",
        statusCode: 403,
      });
    }

    return profile;
  }

  static async assertAdmin(adminUserId) {
    this.assertObjectId(adminUserId, "admin user ID");

    const admin = await User.findById(adminUserId).select("role accountStatus");

    if (!admin || admin.role !== "admin" || admin.accountStatus !== "active") {
      throw this.createError({
        message: "An active administrator is required.",
        code: "PROFESSIONAL_VERIFICATION_ADMIN_REQUIRED",
        statusCode: 403,
      });
    }

    return admin;
  }

  // ───────────────────── TRUSTED ACCOUNT DETAILS ─────────────────────

  static async getAccountIdentity(profile) {
    const user = await User.findById(profile.user).select(
      "role accountStatus isVerified isOnboarded firstName lastName email dateOfBirth"
    );

    if (
      !user ||
      user.role !== "professional" ||
      user.accountStatus !== "active" ||
      user.isVerified !== true ||
      user.isOnboarded !== true
    ) {
      throw this.createError({
        message: "Your account is not eligible for identity verification.",
        code: "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
        statusCode: 403,
      });
    }

    const firstName = String(user.firstName || "").trim();
    const lastName = String(user.lastName || "").trim();

    if (!this.normalizeName(firstName) || !this.normalizeName(lastName)) {
      throw this.createError({
        message: "Your account needs a valid first and last name.",
        code: "PROFESSIONAL_VERIFICATION_ACCOUNT_NAME_REQUIRED",
        statusCode: 409,
      });
    }

    let dateOfBirth;

    if (user.dateOfBirth) {
      const date = new Date(user.dateOfBirth);

      if (!Number.isNaN(date.getTime())) {
        dateOfBirth = date.toISOString().slice(0, 10);
      }
    }

    return {
      firstName,
      lastName,
      email: String(user.email || "").trim(),
      dateOfBirth,
    };
  }

  // ───────────────────── VERIFICATION READINESS ─────────────────────

  static getVerificationReadiness(profile) {
    const identityVerified = profile?.identityVerificationStatus === "verified";

    const licenceVerified = profile?.licenceVerificationStatus === "verified";

    const adminApproved = profile?.professionalApprovalStatus === "approved";

    const accountActive = profile?.accountStatus === "active";

    return {
      identityVerified,
      licenceVerified,
      adminApproved,
      accountActive,

      verificationReady: identityVerified && licenceVerified && adminApproved && accountActive,
    };
  }

  // ───────────────────── APPROVAL RESET ─────────────────────

  static getApprovalResetUpdates() {
    return {
      professionalApprovalStatus: "pending",

      approvedForShiftsAt: null,
      approvedForShiftsBy: null,

      approvalNote: null,
      rejectionReason: null,

      marketplaceStatus: "hidden",
    };
  }

  // ───────────────────── REGISTRY IDENTITY LOOKUP ─────────────────────

  static async lookupIdentityEvidence({
    professionalProfileId,
    userId,
    method,
    identifier,
    firstName,
    lastName,
    dateOfBirth,
    httpClient,
  } = {}) {
    const profile = await this.getOwnedProfessional(professionalProfileId, userId);

    /*
     * Identity verification is one-time.
     *
     * Do not repeat completed verification simply
     * because the selected provider has changed.
     */
    if (profile.identityVerificationStatus === "verified") {
      return {
        status: "verified",
        skipped: true,
        reason: "Identity verification is already complete.",
      };
    }

    // Never trust caller-supplied names or date of birth.
    const accountIdentity = await this.getAccountIdentity(profile);

    const idType = IdentityVerificationService.normalizeMethod(method);

    const provider = IdentityVerificationService.getProvider();

    const environment = IdentityVerificationService.getEnvironment(provider);

    /*
     * Avoid accidental repeat paid lookups.
     *
     * The cooldown is scoped to the professional,
     * identity type, provider and environment.
     *
     * It is not an in-flight concurrency lock.
     */
    const cutoff = new Date(Date.now() - IDENTITY_LOOKUP_COOLDOWN_MS);

    const recent = await KYCVerification.findOne({
      professional: profile._id,
      type: idType,
      provider,
      providerEnvironment: environment,

      lastCheckedAt: {
        $gte: cutoff,
      },
    })
      .select("status lastCheckedAt")
      .lean();

    if (recent) {
      return {
        status: profile.identityVerificationStatus,
        skipped: true,
        provider,
        environment,
        reason: "An identity lookup was completed recently.",
      };
    }

    /*
     * The coordinator validates the identifier.
     *
     * Never save the raw NIN/BVN, a reversible
     * identifier or the complete provider response.
     */
    const lookup = await IdentityVerificationService.lookupIdentity({
      method: idType,
      identifier,

      firstName: accountIdentity.firstName,
      lastName: accountIdentity.lastName,

      ...(accountIdentity.dateOfBirth ? { dateOfBirth: accountIdentity.dateOfBirth } : {}),

      ...(httpClient !== undefined ? { httpClient } : {}),
    });

    let detailsMatched = lookup.detailsMatched;
    let nameOnRecord = null;

    /*
     * Dojah returns basic registry attributes.
     *
     * Compare account details with registry
     * attributes without treating a match as
     * identity-holder authentication.
     */
    if (provider === "dojah" && lookup.registryFound && lookup.result) {
      const returned = lookup.result;

      nameOnRecord = [returned.firstName, returned.middleName, returned.lastName]
        .filter(Boolean)
        .join(" ");

      const nameMatches =
        this.normalizeName(accountIdentity.firstName) === this.normalizeName(returned.firstName) &&
        this.normalizeName(accountIdentity.lastName) === this.normalizeName(returned.lastName);

      const dobMatches =
        accountIdentity.dateOfBirth && returned.dateOfBirth
          ? accountIdentity.dateOfBirth === String(returned.dateOfBirth).trim()
          : null;

      detailsMatched = Boolean(nameMatches && dobMatches !== false);
    }

    const checkedAt = new Date();

    /*
     * Registry evidence is non-authoritative
     * until holder authentication is established.
     *
     * Do not replace an existing verified identity
     * record with a registry-only lookup.
     */
    const record = await KYCVerification.create({
      user: profile.user,
      professional: profile._id,

      ownerType: "professional",
      type: idType,

      provider,
      providerEnvironment: environment,

      requestReference: lookup.requestReference || null,

      providerReference: lookup.providerReference || null,

      status: "needs_review",

      nameOnRecord,

      submittedAt: checkedAt,
      lastCheckedAt: checkedAt,

      reviewNote: "Registry evidence collected. Holder authentication remains required.",

      metadata: {
        registryFound: lookup.registryFound,
        detailsMatched: detailsMatched ?? null,
        holderAuthenticated: false,
        stagingOnly: environment !== "production",
      },

      isActive: false,
    });

    return {
      status: "needs_review",
      verified: false,

      provider,
      environment,

      registryFound: lookup.registryFound,
      detailsMatched: detailsMatched ?? null,

      holderAuthenticated: false,

      verificationId: String(record._id),
      requiresHolderAuthentication: true,
    };
  }

  // ───────────────────── HOSTED IDENTITY INITIATION ─────────────────────

  static async startHostedIdentityVerification({
    professionalProfileId,
    userId,
    firstName,
    lastName,
    email,
    httpClient,
  } = {}) {
    const profile = await this.getOwnedProfessional(professionalProfileId, userId);

    if (profile.identityVerificationStatus === "verified") {
      return {
        status: "verified",
        skipped: true,
        reason: "Identity verification is already complete.",
      };
    }

    /*
     * Hosted KYC is currently implemented by Ninja.
     *
     * Do not silently invoke Ninja when Dojah is
     * selected as the identity provider.
     */
    const provider = IdentityVerificationService.getProvider();

    if (provider !== "ninja") {
      throw this.createError({
        message: "Hosted identity verification is not configured for the selected provider.",
        code: "PROFESSIONAL_VERIFICATION_HOSTED_PROVIDER_UNAVAILABLE",
        statusCode: 422,
      });
    }

    const accountIdentity = await this.getAccountIdentity(profile);

    if (!accountIdentity.email) {
      throw this.createError({
        message: "Your account must have an email address.",
        code: "PROFESSIONAL_VERIFICATION_ACCOUNT_EMAIL_REQUIRED",
        statusCode: 409,
      });
    }

    const environment = IdentityVerificationService.getEnvironment("ninja");

    /*
     * Avoid creating another chargeable hosted
     * verification while a previous one is pending.
     */
    const pending = await KYCVerification.findOne({
      professional: profile._id,
      type: "selfie_match",
      provider: "ninja",
      providerEnvironment: environment,
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .select("+metadata");

    if (pending) {
      const linkExpiry = pending.metadata?.linkExpiresAt
        ? new Date(pending.metadata.linkExpiresAt).getTime()
        : NaN;

      if (!Number.isFinite(linkExpiry) || linkExpiry > Date.now()) {
        throw this.createError({
          message: "A hosted identity verification is already pending.",
          code: "PROFESSIONAL_VERIFICATION_ALREADY_PENDING",
          statusCode: 409,
        });
      }
    }

    /*
     * The trusted caller must serialize starts
     * for each professional.
     *
     * The pending-record check is not a distributed
     * concurrency lock.
     */
    const link = await IdentityVerificationService.createHostedIdentityLink({
      customerReference: new mongoose.Types.ObjectId().toString(),

      firstName: accountIdentity.firstName,
      lastName: accountIdentity.lastName,
      email: accountIdentity.email,

      ...(httpClient !== undefined ? { httpClient } : {}),
    });

    const now = new Date();

    const record = await KYCVerification.create({
      user: profile.user,
      professional: profile._id,

      ownerType: "professional",
      type: "selfie_match",

      provider: "ninja",
      providerEnvironment: link.environment,

      requestReference: link.requestReference,
      providerReference: link.verificationId,

      status: "pending",

      submittedAt: now,
      lastCheckedAt: now,

      reviewNote: "Hosted verification initiated; awaiting identity evidence.",

      metadata: {
        flowId: link.flowId,

        customerReference: link.requestReference,

        /*
         * Hosted link expiry is not identity
         * verification expiry.
         *
         * Do not populate KYCVerification.expiresAt.
         */
        linkExpiresAt: link.expiresAt,
      },

      isActive: false,
    });

    /*
     * Return the hosted link to the authorized
     * applicant only.
     *
     * Do not store this access URL in KYC metadata.
     */
    return {
      status: "pending",

      provider: "ninja",
      environment: link.environment,

      verificationId: String(record._id),

      providerVerificationId: link.verificationId,

      verificationUrl: link.verificationUrl,
      expiresAt: link.expiresAt,
    };
  }

  // ───────────────────── HOSTED IDENTITY RESULT ─────────────────────

  static async syncHostedIdentityResult({
    professionalProfileId,
    userId,
    verificationId,
    httpClient,
  } = {}) {
    await this.getOwnedProfessional(professionalProfileId, userId);

    this.assertObjectId(verificationId, "verification ID");

    const record = await KYCVerification.findOne({
      _id: verificationId,
      professional: professionalProfileId,

      ownerType: "professional",
      type: "selfie_match",
      provider: "ninja",
    }).select("+providerReference +requestReference +metadata");

    if (!record || !record.providerReference) {
      throw this.createError({
        message: "Hosted identity verification record not found.",
        code: "PROFESSIONAL_VERIFICATION_ATTEMPT_NOT_FOUND",
        statusCode: 404,
      });
    }

    /*
     * Read the original Ninja attempt even if
     * the selected identity provider has changed.
     *
     * Do not fetch a sandbox attempt using
     * production credentials or vice versa.
     */
    if (record.providerEnvironment !== IdentityVerificationService.getEnvironment("ninja")) {
      throw this.createError({
        message: "Hosted verification environment differs from the original attempt.",
        code: "PROFESSIONAL_VERIFICATION_ENVIRONMENT_MISMATCH",
        statusCode: 409,
      });
    }

    const outcome = await IdentityVerificationService.getHostedIdentityResult({
      verificationId: record.providerReference,

      ...(httpClient !== undefined ? { httpClient } : {}),
    });

    /*
     * The result must match the original
     * verification attempt.
     */
    if (
      outcome.provider !== record.provider ||
      outcome.environment !== record.providerEnvironment ||
      outcome.flowId !== record.metadata?.flowId ||
      outcome.customerReference !== record.requestReference
    ) {
      throw this.createError({
        message: "Hosted identity result does not match the original attempt.",
        code: "PROFESSIONAL_VERIFICATION_RESULT_MISMATCH",
        statusCode: 502,
      });
    }

    /*
     * A completed hosted flow is not sufficient
     * evidence of passed selfie/liveness checks.
     *
     * Do not set identityVerificationStatus
     * to verified from status alone.
     */
    const completed = String(outcome.status || "").toLowerCase() === "completed";

    if (record.status === "pending") {
      record.status = completed ? "needs_review" : "pending";

      record.reviewNote = completed
        ? "Hosted flow completed; trusted biometric evidence is required before approval."
        : "Hosted verification has not completed.";

      record.lastCheckedAt = new Date();

      record.metadata = {
        ...(record.metadata || {}),

        hostedStatus: String(outcome.status || ""),

        hostedOutcome: String(outcome.outcome || ""),
      };

      await record.save();
    }

    return {
      status: record.status,
      verified: false,

      provider: "ninja",
      environment: record.providerEnvironment,

      requiresBiometricEvidence: true,

      verificationId: String(record._id),
    };
  }

  // ───────────────────── ADMINISTRATIVE IDENTITY REVIEW ─────────────────────

  /*
   * A registry match or a completed hosted flow does NOT
   * prove identity-holder authentication.
   *
   * Only an authorized administrator may issue a decision.
   *
   * A verified decision requires an existing PRODUCTION
   * hosted attempt with independently attested, trusted
   * biometric and identity-matching evidence recorded
   * server-side.
   *
   * IMPORTANT:
   *
   * The current Ninja result synchronization does not
   * provide these attestations. Until a trusted evidence
   * integration is implemented, this method intentionally
   * refuses to mark identity as verified.
   *
   * Reviewers can record needs_review or rejected decisions
   * against an existing KYC attempt.
   *
   * Decisions are logged in a separate permanent KYC record.
   */

  static async recordIdentityReview({
    professionalProfileId,
    adminUserId,
    verificationId,
    decision,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    this.assertObjectId(professionalProfileId, "professional profile ID");

    this.assertObjectId(verificationId, "identity verification ID");

    if (!["verified", "rejected", "needs_review"].includes(decision)) {
      throw this.createError({
        message: "Invalid identity verification decision.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_IDENTITY_DECISION",
        statusCode: 400,
      });
    }

    const cleanNote = this.truncate(note);

    if (cleanNote.length < 10) {
      throw this.createError({
        message: "Provide a meaningful identity review note.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_IDENTITY_NOTE",
        statusCode: 400,
      });
    }

    const snapshot = await this.getProfessional(professionalProfileId);

    /*
     * Approved identity is one-time.
     *
     * An investigation or revocation needs its own
     * controlled workflow, not another routine review.
     */
    if (snapshot.identityVerificationStatus === "verified") {
      if (decision === "verified") {
        return {
          status: "verified",
          verified: true,
          skipped: true,
          reason: "Identity verification is already complete.",
        };
      }

      throw this.createError({
        message: "Verified identity requires a separate administrative investigation.",
        code: "PROFESSIONAL_VERIFICATION_IDENTITY_ALREADY_VERIFIED",
        statusCode: 409,
      });
    }

    const session = await mongoose.startSession();

    try {
      let savedRecord;
      let profile;

      const now = new Date();

      await session.withTransaction(async () => {
        profile = await ProfessionalProfile.findOne({
          _id: snapshot._id,
          updatedAt: snapshot.updatedAt,
        }).session(session);

        if (!profile || profile.identityVerificationStatus === "verified") {
          throw this.createError({
            message: "Professional identity details changed during review.",
            code: "PROFESSIONAL_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        const attempt = await KYCVerification.findOne({
          _id: verificationId,

          professional: profile._id,
          user: profile.user,

          ownerType: "professional",

          type: {
            $in: ["nin", "bvn", "government_id", "selfie_match"],
          },
        })
          .select("+metadata +providerReference")
          .session(session);

        if (!attempt) {
          throw this.createError({
            message: "Identity verification attempt not found.",
            code: "PROFESSIONAL_VERIFICATION_IDENTITY_ATTEMPT_NOT_FOUND",
            statusCode: 404,
          });
        }

        const verified = decision === "verified";

        if (verified) {
          const evidence = attempt.metadata;

          /*
           * Each condition is required.
           *
           * The flags must originate from a trusted
           * server-side evidence integration, not
           * user-supplied request fields.
           */
          const trustedEvidence =
            attempt.type === "selfie_match" &&
            ["ninja", "dojah"].includes(attempt.provider) &&
            attempt.providerEnvironment === "production" &&
            attempt.status === "needs_review" &&
            Boolean(attempt.providerReference) &&
            Boolean(attempt.nameOnRecord) &&
            evidence?.hostedStatus === "completed" &&
            evidence?.holderAuthenticated === true &&
            evidence?.trustedBiometricEvidence === true &&
            evidence?.livenessPassed === true &&
            evidence?.faceMatchPassed === true &&
            evidence?.identityDetailsMatched === true;

          if (!trustedEvidence) {
            throw this.createError({
              message: "Trusted identity-holder evidence is required before verification.",
              code: "PROFESSIONAL_VERIFICATION_HOLDER_EVIDENCE_REQUIRED",
              statusCode: 409,
            });
          }
        }

        /*
         * Preserve earlier attempts for audit.
         *
         * Only the new administrative review record
         * represents this decision.
         */
        await KYCVerification.updateMany(
          {
            professional: profile._id,

            type: {
              $in: ["nin", "bvn", "government_id", "selfie_match"],
            },

            isActive: true,
          },
          {
            $set: {
              isActive: false,
            },
          },
          { session }
        );

        const records = await KYCVerification.create(
          [
            {
              user: profile.user,
              professional: profile._id,

              ownerType: "professional",
              type: "selfie_match",

              provider: "internal_review",
              providerEnvironment: null,

              status: decision,

              nameOnRecord: verified ? attempt.nameOnRecord || null : null,

              reviewedBy: adminUserId,

              submittedAt: now,
              lastCheckedAt: now,

              verifiedAt: verified ? now : null,

              rejectedAt: decision === "rejected" ? now : null,

              rejectionReason: decision === "rejected" ? cleanNote : null,

              reviewNote: cleanNote,

              metadata: {
                verificationSource: "admin_identity_review",

                reviewedVerificationId: String(attempt._id),

                evidenceProvider: attempt.provider,

                evidenceEnvironment: attempt.providerEnvironment,

                holderAuthenticated: verified,

                trustedBiometricEvidence: verified,
              },

              isActive: true,
            },
          ],
          { session }
        );

        savedRecord = records[0];

        profile.set({
          identityVerificationStatus: decision,

          identityVerificationMethod: "manual",

          identityVerificationSource: verified ? "selfie_match" : "internal_review",

          identityNameOnDocument: verified ? attempt.nameOnRecord || null : null,

          identityDocumentType: verified ? attempt.documentType || null : null,

          identityVerifiedAt: verified ? now : null,

          identityLastCheckedAt: now,

          identityVerifiedBy: verified ? adminUserId : null,

          identityVerificationNote: cleanNote,

          ...(!verified ? this.getApprovalResetUpdates() : {}),
        });

        await profile.save({
          session,
        });
      });

      return {
        status: profile.identityVerificationStatus,

        verified: profile.identityVerificationStatus === "verified",

        verificationId: String(savedRecord._id),

        professionalProfileId: String(profile._id),

        reviewedBy: String(adminUserId),

        reviewedAt: now,

        requiresProfessionalApproval: decision === "verified",
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── LICENCE NUMBER CHANGES ─────────────────────

  static async changeLicenceNumber({ professionalProfileId, userId, licenceNumber } = {}) {
    const snapshot = await this.getOwnedProfessional(professionalProfileId, userId);

    const nextNumber = this.normalizeLicenceNumber(licenceNumber);

    const existingNumber = this.normalizeLicenceNumber(snapshot.licenceNumber);

    /*
     * Do not repeat licence verification when
     * the licence number has not changed.
     */
    if (nextNumber === existingNumber) {
      return {
        changed: false,

        licenceVerificationStatus: snapshot.licenceVerificationStatus,

        reason: "Licence number is unchanged.",
      };
    }

    const session = await mongoose.startSession();

    try {
      let updated;

      await session.withTransaction(async () => {
        const current = await ProfessionalProfile.findOne({
          _id: snapshot._id,
          user: userId,

          licenceNumber: snapshot.licenceNumber,

          updatedAt: snapshot.updatedAt,
        }).session(session);

        if (!current) {
          throw this.createError({
            message: "Professional profile changed during licence update.",
            code: "PROFESSIONAL_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        /*
         * A licence number change invalidates
         * the previous licence verification.
         *
         * Identity verification remains unchanged.
         */
        current.set({
          licenceNumber: nextNumber,

          licenceVerificationStatus: "pending",

          licenceVerificationMethod: "not_checked",

          licenceVerificationSource: "not_checked",

          licenceNameOnRecord: null,
          licenceExpiryDate: null,

          licenceVerifiedAt: null,
          licenceLastCheckedAt: null,
          licenceVerifiedBy: null,

          licenceVerificationNote: null,

          ...this.getApprovalResetUpdates(),
        });

        /*
         * Retain historical licence records.
         *
         * Only deactivate their authoritative status.
         */
        await KYCVerification.updateMany(
          {
            professional: current._id,
            type: "licence",
            isActive: true,
          },
          {
            $set: {
              isActive: false,
            },
          },
          { session }
        );

        /*
         * Create a fresh pending licence
         * verification record.
         */
        await KYCVerification.create(
          [
            {
              user: current.user,
              professional: current._id,

              ownerType: "professional",
              type: "licence",

              provider: "internal_review",
              providerEnvironment: null,

              status: "pending",

              reviewNote: "Licence number changed; new verification and approval required.",

              submittedAt: new Date(),

              metadata: {
                licenceNumberChanged: true,
              },

              isActive: true,
            },
          ],
          { session }
        );

        updated = await current.save({
          session,
        });
      });

      return {
        changed: true,

        licenceVerificationStatus: updated.licenceVerificationStatus,

        professionalApprovalStatus: updated.professionalApprovalStatus,

        identityVerificationStatus: updated.identityVerificationStatus,

        requiresLicenceReview: true,
        requiresProfessionalApproval: true,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── MANUAL LICENCE REVIEW ─────────────────────

  static async recordLicenceReview({
    professionalProfileId,
    adminUserId,
    decision,
    nameOnRecord,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    const snapshot = await this.getProfessional(professionalProfileId);

    /*
     * Licence verification is one-time for
     * the same registered licence number.
     *
     * A genuine licence number change resets
     * verification to pending.
     */
    if (snapshot.licenceVerificationStatus === "verified") {
      return {
        status: "verified",
        verified: true,
        skipped: true,

        reason: "This licence has already been verified.",
      };
    }

    if (!["verified", "rejected", "needs_review"].includes(decision)) {
      throw this.createError({
        message: "Invalid licence verification decision.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_DECISION",
        statusCode: 400,
      });
    }

    const cleanNote = this.truncate(note);

    if (cleanNote.length < 10) {
      throw this.createError({
        message: "Provide a meaningful licence review note.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_REVIEW_NOTE",
        statusCode: 400,
      });
    }

    const cleanName = String(nameOnRecord || "")
      .trim()
      .slice(0, 150);

    if (decision === "verified" && !cleanName) {
      throw this.createError({
        message: "Registered licence-holder name is required.",
        code: "PROFESSIONAL_VERIFICATION_MISSING_REGISTERED_NAME",
        statusCode: 400,
      });
    }

    /*
     * Pharmacy professionals are reviewed
     * through the appropriate PCN register.
     *
     * Other professional types require the
     * relevant professional council's register.
     *
     * The administrator must independently
     * confirm registration before approval.
     */
    const source = ["pharmacist", "pharmacy_technician"].includes(snapshot.type)
      ? "pcn_public_portal"
      : "professional_council_portal";

    const now = new Date();
    const verified = decision === "verified";

    const session = await mongoose.startSession();

    try {
      let savedRecord;

      await session.withTransaction(async () => {
        /*
         * Ensure the licence has not changed
         * during administrative review.
         */
        const current = await ProfessionalProfile.findOne({
          _id: snapshot._id,

          updatedAt: snapshot.updatedAt,

          licenceNumber: snapshot.licenceNumber,
        }).session(session);

        if (!current) {
          throw this.createError({
            message: "Professional licence details changed during review.",
            code: "PROFESSIONAL_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        if (current.licenceVerificationStatus === "verified") {
          throw this.createError({
            message: "This licence has already been verified.",
            code: "PROFESSIONAL_VERIFICATION_ALREADY_VERIFIED",
            statusCode: 409,
          });
        }

        current.set({
          licenceVerificationStatus: decision,

          licenceVerificationMethod: "manual",

          licenceVerificationSource: source,

          licenceNameOnRecord: cleanName || null,

          licenceVerifiedAt: verified ? now : null,

          licenceLastCheckedAt: now,

          licenceVerifiedBy: adminUserId,

          licenceVerificationNote: cleanNote,

          // No expiry-driven re-verification.
          licenceExpiryDate: null,

          /*
           * Unsuccessful reviews reset
           * administrative approval.
           */
          ...(!verified ? this.getApprovalResetUpdates() : {}),
        });

        /*
         * Deactivate earlier active licence
         * records while retaining history.
         */
        await KYCVerification.updateMany(
          {
            professional: current._id,
            type: "licence",
            isActive: true,
          },
          {
            $set: {
              isActive: false,
            },
          },
          { session }
        );

        const records = await KYCVerification.create(
          [
            {
              user: current.user,
              professional: current._id,

              ownerType: "professional",
              type: "licence",

              provider: "manual",
              providerEnvironment: null,

              status: decision,

              nameOnRecord: cleanName || null,

              reviewedBy: adminUserId,

              submittedAt: now,

              lastCheckedAt: now,

              verifiedAt: verified ? now : null,

              rejectedAt: decision === "rejected" ? now : null,

              rejectionReason: decision === "rejected" ? cleanNote : null,

              reviewNote: cleanNote,

              metadata: {
                verificationSource: source,
                councilReviewed: true,
              },

              isActive: true,
            },
          ],
          { session }
        );

        savedRecord = records[0];

        await current.save({
          session,
        });
      });

      return {
        status: decision,
        verified,

        verificationId: String(savedRecord._id),

        professionalProfileId: String(snapshot._id),

        reviewedBy: String(adminUserId),

        reviewedAt: now,

        requiresProfessionalApproval: verified,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── FINAL PROFESSIONAL APPROVAL ─────────────────────

  static async reviewProfessionalApproval({
    professionalProfileId,
    adminUserId,
    decision,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    this.assertObjectId(professionalProfileId, "professional profile ID");

    if (!["approved", "rejected", "needs_review"].includes(decision)) {
      throw this.createError({
        message: "Invalid professional approval decision.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_APPROVAL_DECISION",
        statusCode: 400,
      });
    }

    const cleanNote = this.truncate(note);

    if (cleanNote.length < 10) {
      throw this.createError({
        message: "Provide a meaningful professional approval note.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_APPROVAL_NOTE",
        statusCode: 400,
      });
    }

    const session = await mongoose.startSession();

    try {
      let profile;

      await session.withTransaction(async () => {
        profile = await ProfessionalProfile.findById(professionalProfileId).session(session);

        if (!profile) {
          throw this.createError({
            message: "Professional profile not found.",
            code: "PROFESSIONAL_VERIFICATION_PROFILE_NOT_FOUND",
            statusCode: 404,
          });
        }

        /*
         * Final approval requires completed
         * identity and licence verification.
         *
         * Provider results alone cannot
         * automatically approve the professional.
         */
        if (decision === "approved") {
          if (
            profile.identityVerificationStatus !== "verified" ||
            profile.licenceVerificationStatus !== "verified" ||
            profile.accountStatus !== "active"
          ) {
            throw this.createError({
              message:
                "Identity, licence and account requirements must be satisfied before approval.",
              code: "PROFESSIONAL_VERIFICATION_NOT_READY",
              statusCode: 409,
            });
          }
        }

        profile.set({
          professionalApprovalStatus: decision,

          approvedForShiftsAt: decision === "approved" ? new Date() : null,

          approvedForShiftsBy: decision === "approved" ? adminUserId : null,

          approvalNote: cleanNote,

          rejectionReason: decision === "rejected" ? cleanNote : null,

          ...(decision !== "approved"
            ? {
                marketplaceStatus: "hidden",
              }
            : {}),
        });

        await profile.save({
          session,
        });
      });

      return {
        status: profile.professionalApprovalStatus,

        approved: profile.professionalApprovalStatus === "approved",

        professionalProfileId: String(profile._id),
      };
    } finally {
      await session.endSession();
    }
  }
}

module.exports = ProfessionalVerificationService;
