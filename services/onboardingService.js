// services/onboardingService.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const Branch = require("../models/Branch");
const User = require("../models/User");
const KYCVerification = require("../models/KYCVerification");

const logger = require("../utils/logger");

const walletService = require("./walletService");
const DVAService = require("./dvaService");
const ProfileInputService = require("./profileInputService");
const BranchService = require("./branchService");

const ProfessionalVerificationService = require("./professionalVerificationService");
const EmployerVerificationService = require("./employerVerificationService");
const CACVerificationService = require("./cacVerificationService");

const PreOnboardingCACVerificationService = require("./preOnboardingCACVerificationService");
const PreOnboardingNINVerificationService = require("./preOnboardingNINVerificationService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const SERVICE_ERROR_NAME = "OnboardingServiceError";

class OnboardingService {
  /*
   * ONBOARDING POLICY
   *
   * Professional onboarding requires successful,
   * unexpired, acknowledged production NIN evidence.
   *
   * Professional legal names originate exclusively
   * from trusted structured NIN registry evidence.
   *
   * The applicant may enter a different NIN during
   * pre-onboarding verification, subject to the
   * verification service's attempt limits.
   *
   * Employer onboarding requires successful,
   * unexpired production CAC evidence.
   *
   * Employer registered legal names originate
   * exclusively from trusted CAC registry evidence.
   *
   * No chargeable provider calls occur here.
   *
   * Registry lookup and name acknowledgement do not
   * establish identity-holder authentication.
   *
   * Professional practising-licence and branch facility-permit
   * verification are separate post-onboarding workflows.
   * Completing onboarding does not grant marketplace eligibility.
   *
   * Onboarding database changes are transactional.
   * Wallet creation is part of onboarding.
   * Employer onboarding creates its initial primary Branch
   * in that same transaction, using the submitted location.
   *
   * Employer DVA provisioning occurs after commit.
   * Failed DVA provisioning does not roll back onboarding.
   */

  // ───────────────────── ERRORS ─────────────────────

  static createError({ message, code, statusCode = 409 }) {
    return createServiceError({
      name: SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
    });
  }

  // ───────────────────── ACCOUNT ELIGIBILITY ─────────────────────

  static getOnboardingUserFilter(userId, role) {
    return {
      _id: userId,
      role,
      accountStatus: "active",
      isVerified: true,
      isOnboarded: { $ne: true },
    };
  }

  static async assertCanCompleteOnboarding({ userId, role, session }) {
    if (!mongoose.isValidObjectId(userId)) {
      throw this.createError({
        message: "Invalid account.",
        code: "ONBOARDING_INVALID_USER",
        statusCode: 400,
      });
    }

    const user = await User.findOne(this.getOnboardingUserFilter(userId, role))
      .select("_id role")
      .session(session);

    if (!user) {
      throw this.createError({
        message: "Your account is not eligible to complete onboarding.",
        code: "ONBOARDING_ACCOUNT_INELIGIBLE",
        statusCode: 403,
      });
    }

    return user;
  }

  static async markUserOnboarded({ userId, role, profileId, session }) {
    const update =
      role === "professional"
        ? {
            isOnboarded: true,
            professionalProfile: profileId,
          }
        : {
            isOnboarded: true,
            employerProfile: profileId,
          };

    const user = await User.findOneAndUpdate(
      this.getOnboardingUserFilter(userId, role),
      {
        $set: update,

        // Advance the version used by document saves.
        $inc: {
          __v: 1,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session,
      }
    );

    if (!user) {
      throw this.createError({
        message: "Your onboarding session could not be completed. Please try again.",
        code: "ONBOARDING_ACCOUNT_STATE_CHANGED",
        statusCode: 409,
      });
    }

    return user;
  }

  // ───────────────────── REGISTRY NAME SUPPORT ─────────────────────

  /*
   * Legal names must originate from server-persisted
   * provider evidence, not browser-submitted names.
   *
   * Preserve individual name components without
   * guessing name order or splitting full names.
   */

  static normalizeRegistryName(value, maxLength = 150) {
    if (typeof value !== "string") {
      return null;
    }

    if (/[\u0000-\u001F\u007F]/.test(value)) {
      return null;
    }

    const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");

    if (!normalized || normalized.length > maxLength) {
      return null;
    }

    return normalized;
  }

  // ───────────────────── PROFESSIONAL LEGAL NAME ─────────────────────

  /*
   * The current NIN pre-onboarding service persists:
   *
   * registryLegalName: {
   *   firstName,
   *   middleName,
   *   lastName
   * }
   *
   * It does not persist a separate nameOnRecord
   * in the temporary verification record.
   *
   * Build the display name from these already
   * validated structured registry components.
   *
   * Never derive individual names by splitting
   * an unstructured display name.
   */

  static getAuthoritativeProfessionalName(evidence) {
    const registryName = evidence?.registryLegalName;

    if (!registryName || typeof registryName !== "object" || Array.isArray(registryName)) {
      throw this.createError({
        message: "NIN registry name details are incomplete. Please contact support.",
        code: "ONBOARDING_NIN_NAME_EVIDENCE_REQUIRED",
      });
    }

    const firstName = this.normalizeRegistryName(registryName.firstName, 100);

    const lastName = this.normalizeRegistryName(registryName.lastName, 100);

    let middleName = "";

    if (
      registryName.middleName !== undefined &&
      registryName.middleName !== null &&
      registryName.middleName !== ""
    ) {
      middleName = this.normalizeRegistryName(registryName.middleName, 100);
    }

    if (!firstName || !lastName || middleName === null) {
      throw this.createError({
        message: "NIN registry legal-name details are invalid.",
        code: "ONBOARDING_NIN_INVALID_LEGAL_NAME",
      });
    }

    const displayName = [firstName, middleName, lastName].filter(Boolean).join(" ");

    if (displayName.length > 150) {
      throw this.createError({
        message: "NIN registry legal-name details require additional review.",
        code: "ONBOARDING_NIN_LEGAL_NAME_TOO_LONG",
      });
    }

    /*
     * The pre-onboarding service validated the
     * structured registry name against the provider
     * response before persisting temporary evidence.
     *
     * Requiring evidence.nameOnRecord here would
     * reject valid records because that field is
     * not part of the current temporary contract.
     */

    return {
      firstName,
      middleName,
      lastName,
      displayName,
    };
  }

  // ───────────────────── PERSIST PROFESSIONAL LEGAL NAME ─────────────────────

  /*
   * Establish the professional's authoritative
   * registry-derived legal name in User.
   *
   * The permanent KYCVerification record provides
   * the legal-name evidence reference.
   *
   * An already established registry-authoritative
   * identity cannot be overwritten by onboarding.
   *
   * The User model's identity update middleware
   * manages the name-assignment version increment.
   */

  static async persistAuthoritativeProfessionalName({
    userId,
    legalName,
    verificationId,
    session,
  }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error(
        "An active onboarding transaction is required to persist a professional legal name."
      );
    }

    if (!mongoose.isValidObjectId(verificationId)) {
      throw this.createError({
        message: "Registry identity evidence is invalid.",
        code: "ONBOARDING_NIN_INVALID_PERMANENT_EVIDENCE",
      });
    }

    /*
     * Fail before updating a professional's legal
     * name if the User schema lacks any required
     * provenance field.
     */

    if (
      !User.schema.path("firstName") ||
      !User.schema.path("middleName") ||
      !User.schema.path("lastName") ||
      !User.schema.path("legalNameSource") ||
      !User.schema.path("legalNameEvidence")
    ) {
      throw this.createError({
        message: "Legal-name verification configuration is incomplete.",
        code: "ONBOARDING_LEGAL_NAME_SCHEMA_UNAVAILABLE",
        statusCode: 500,
      });
    }

    /*
     * Only the first transition from unverified
     * to nin_registry is permitted here.
     *
     * Existing trusted provenance must not be
     * silently replaced.
     */

    const user = await User.findOneAndUpdate(
      {
        ...this.getOnboardingUserFilter(userId, "professional"),

        legalNameSource: "unverified",
        legalNameEvidence: null,
      },
      {
        $set: {
          firstName: legalName.firstName,
          middleName: legalName.middleName,
          lastName: legalName.lastName,
          legalNameSource: "nin_registry",
          legalNameEvidence: verificationId,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session,
      }
    );

    if (!user) {
      throw this.createError({
        message:
          "Your account's legal identity cannot be updated automatically. Please contact support.",
        code: "ONBOARDING_PROFESSIONAL_NAME_CONFLICT",
      });
    }

    return user;
  }

  // ───────────────────── EMPLOYER REGISTERED BUSINESS NAME ─────────────────────

  /*
   * EmployerProfile.businessName must come from
   * trusted CAC registration evidence.
   *
   * The applicant supplies a registration number,
   * not an authoritative registered business name.
   */

  static getAuthoritativeBusinessName(evidence) {
    const businessName = this.normalizeRegistryName(evidence?.nameOnRecord, 150);

    if (!businessName) {
      throw this.createError({
        message: "CAC registered business name is missing or invalid.",
        code: "ONBOARDING_CAC_REGISTERED_NAME_REQUIRED",
      });
    }

    return businessName;
  }

  // ───────────────────── CAC REGISTRATION SUPPORT ─────────────────────

  static supportsAutomatedCACRegistration(registrationNumber) {
    if (typeof registrationNumber !== "string") {
      return false;
    }

    const normalized = registrationNumber.trim().toUpperCase().replace(/[\s-]/g, "");

    return /^(RC|BN)\d{4,10}$/.test(normalized);
  }

  // ───────────────────── REQUIRED NIN EVIDENCE ─────────────────────

  /*
   * Called inside the professional onboarding
   * transaction.
   *
   * The pre-onboarding service requires:
   *
   * - Successful production NIN lookup;
   * - Current, unexpired evidence;
   * - Explicit lookup consent;
   * - Applicant name acknowledgement;
   * - No outstanding NIN change;
   * - Valid structured registry names.
   *
   * This method creates permanent KYC history,
   * establishes User legal-name provenance and
   * leaves identity-holder authentication pending.
   */

  static async persistPreOnboardingNINVerification({ userId, profile, session }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error("An active onboarding transaction is required to persist NIN evidence.");
    }

    /*
     * Ensure permanent evidence storage supports
     * structured NIN legal names.
     *
     * Mongoose strict mode must not silently
     * discard this authoritative information.
     */

    if (!KYCVerification.schema.path("registryLegalName")) {
      throw this.createError({
        message: "Permanent NIN evidence storage is not configured.",
        code: "ONBOARDING_NIN_KYC_SCHEMA_UNAVAILABLE",
        statusCode: 500,
      });
    }

    // ───────── CONSUME ACKNOWLEDGED NIN EVIDENCE ─────────

    const evidence = await PreOnboardingNINVerificationService.consumeForOnboarding({
      userId,
      session,
    });

    if (!evidence) {
      throw this.createError({
        message: "NIN verification is required to continue.",
        code: "ONBOARDING_NIN_REQUIRED",
      });
    }

    // ───────── REQUIRE PRODUCTION NIN RESULT ─────────

    if (
      !["ninja", "dojah"].includes(evidence.provider) ||
      evidence.providerEnvironment !== "production" ||
      evidence.status !== "matched" ||
      evidence.registryFound !== true
    ) {
      throw this.createError({
        message: "Your NIN registry verification must be completed successfully before continuing.",
        code: "ONBOARDING_NIN_NOT_MATCHED",
      });
    }

    // ───────── VERIFY STORED EVIDENCE ─────────

    if (
      !evidence.checkedAt ||
      !evidence.lookupStartedAt ||
      !evidence.consentAcceptedAt ||
      !evidence.requestReference ||
      !/^[a-f0-9]{64}$/.test(evidence.ninHash || "") ||
      !/^\d{4}$/.test(evidence.ninLast4 || "")
    ) {
      throw this.createError({
        message: "NIN verification evidence is incomplete. Please contact support.",
        code: "ONBOARDING_NIN_INVALID_EVIDENCE",
      });
    }

    const checkedAt = new Date(evidence.checkedAt);
    const lookupStartedAt = new Date(evidence.lookupStartedAt);
    const consentAcceptedAt = new Date(evidence.consentAcceptedAt);

    const acknowledgedAt = evidence.nameAcknowledgedAt
      ? new Date(evidence.nameAcknowledgedAt)
      : null;

    if (
      Number.isNaN(checkedAt.getTime()) ||
      Number.isNaN(lookupStartedAt.getTime()) ||
      Number.isNaN(consentAcceptedAt.getTime()) ||
      !acknowledgedAt ||
      Number.isNaN(acknowledgedAt.getTime()) ||
      consentAcceptedAt > lookupStartedAt ||
      lookupStartedAt > checkedAt ||
      checkedAt > acknowledgedAt ||
      acknowledgedAt > new Date()
    ) {
      throw this.createError({
        message: "NIN verification and acknowledgement timestamps are invalid.",
        code: "ONBOARDING_NIN_INVALID_TIMESTAMP",
      });
    }

    // ───────── REQUIRE CURRENT NAME ACKNOWLEDGEMENT ─────────

    /*
     * Acknowledgement must belong to the exact
     * current NIN lookup.
     *
     * Previous acknowledgements cannot authorize
     * newly submitted or changed NINs.
     */

    if (
      evidence.nameAcknowledgedRequestReference !== evidence.requestReference ||
      evidence.correctionRequestedAt != null
    ) {
      throw this.createError({
        message: "Please confirm your current NIN registry name before continuing.",
        code: "ONBOARDING_NIN_NAME_NOT_ACKNOWLEDGED",
      });
    }

    // ───────── AUTHORITATIVE LEGAL NAME ─────────

    const legalName = this.getAuthoritativeProfessionalName(evidence);

    /*
     * The pre-onboarding service already checked
     * account ownership, expiry and provider context.
     *
     * These changes remain in the same transaction.
     * Any later failure rolls back evidence consumption.
     */

    const reviewNote =
      "NIN registry name acknowledged and recorded. Identity-holder authentication remains outstanding.";

    const metadata = {
      verificationSource: "pre_onboarding",

      preOnboardingVerificationId: String(evidence._id),

      registryFound: true,
      registryMatched: true,

      // Acknowledgement is not holder authentication.
      nameAcknowledged: true,
      nameAcknowledgedAt: acknowledgedAt,
      nameAcknowledgedRequestReference: evidence.requestReference,

      legalNameSource: "nin_registry",

      holderAuthenticated: false,
      requiresHolderAuthentication: true,

      stagingOnly: false,
      consentAcceptedAt,
    };

    // ───────── PERMANENT NIN VERIFICATION HISTORY ─────────

    /*
     * Preserve both structured legal-name components
     * and the derived display name.
     *
     * The record remains needs_review because registry
     * evidence does not independently authenticate
     * the person submitting the NIN.
     *
     * Do not grant marketplace access here.
     */

    const records = await KYCVerification.create(
      [
        {
          user: profile.user,
          professional: profile._id,

          ownerType: "professional",
          type: "nin",

          provider: evidence.provider,
          providerEnvironment: "production",

          requestReference: evidence.requestReference,
          providerReference: evidence.providerReference || null,

          maskedValue: `*******${evidence.ninLast4}`,
          valueLast4: evidence.ninLast4,
          valueHash: evidence.ninHash,

          status: "needs_review",

          nameOnRecord: legalName.displayName,

          registryLegalName: {
            firstName: legalName.firstName,
            middleName: legalName.middleName,
            lastName: legalName.lastName,
          },

          submittedAt: lookupStartedAt,
          lastCheckedAt: checkedAt,

          reviewNote: ProfessionalVerificationService.truncate(reviewNote),

          metadata,

          isActive: false,
        },
      ],
      { session }
    );

    const verificationId = records[0]._id;

    // ───────── PERSIST AUTHORITATIVE USER NAME ─────────

    /*
     * Link the professional's legal-name provenance
     * to the permanent KYC verification record.
     *
     * This establishes where the name came from,
     * not that identity ownership was authenticated.
     */

    await this.persistAuthoritativeProfessionalName({
      userId,
      legalName,
      verificationId,
      session,
    });

    return {
      consumed: true,

      provider: evidence.provider,
      environment: "production",

      status: "needs_review",

      registryMatched: true,
      nameAcknowledged: true,

      holderAuthenticated: false,
      verified: false,

      stagingOnly: false,
      requiresHolderAuthentication: true,

      verificationId,
    };
  }

  // ───────────────────── REQUIRED CAC EVIDENCE ─────────────────────

  /*
   * Validate and consume trusted production CAC
   * evidence before creating the employer profile.
   *
   * The registered business name comes from the
   * provider, not the request body.
   *
   * No provider request is made here.
   */

  static async preparePreOnboardingCACVerification({ userId, profileData, session }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error("An active onboarding transaction is required to prepare CAC evidence.");
    }

    if (!this.supportsAutomatedCACRegistration(profileData?.cacRegistrationNumber)) {
      throw this.createError({
        message:
          "This CAC registration type requires additional verification. Please contact support.",
        code: "ONBOARDING_CAC_UNSUPPORTED_TYPE",
      });
    }

    // ───────── CONSUME CURRENT CAC EVIDENCE ─────────

    const evidence = await PreOnboardingCACVerificationService.consumeForOnboarding({
      userId,
      registrationNumber: profileData.cacRegistrationNumber,
      session,
    });

    if (!evidence) {
      throw this.createError({
        message: "CAC verification is required to continue.",
        code: "ONBOARDING_CAC_REQUIRED",
      });
    }

    // ───────── REQUIRE PRODUCTION CAC RESULT ─────────

    if (
      !["ninja", "dojah"].includes(evidence.provider) ||
      evidence.providerEnvironment !== "production" ||
      evidence.status !== "matched"
    ) {
      throw this.createError({
        message: "Your CAC verification must be completed successfully before continuing.",
        code: "ONBOARDING_CAC_NOT_MATCHED",
      });
    }

    // ───────── VERIFY STORED CAC EVIDENCE ─────────

    if (!evidence.checkedAt || !evidence.lookupStartedAt || !evidence.requestReference) {
      throw this.createError({
        message: "CAC verification evidence is incomplete. Please contact support.",
        code: "ONBOARDING_CAC_INVALID_EVIDENCE",
      });
    }

    const checkedAt = new Date(evidence.checkedAt);
    const lookupStartedAt = new Date(evidence.lookupStartedAt);

    if (
      Number.isNaN(checkedAt.getTime()) ||
      Number.isNaN(lookupStartedAt.getTime()) ||
      lookupStartedAt > checkedAt ||
      checkedAt > new Date()
    ) {
      throw this.createError({
        message: "CAC verification evidence contains invalid timestamps.",
        code: "ONBOARDING_CAC_INVALID_TIMESTAMP",
      });
    }

    // ───────── VALIDATE REGISTRATION NUMBER ─────────

    const submittedRegistration = CACVerificationService.normalizeRegistrationNumber(
      profileData.cacRegistrationNumber
    );

    const evidenceRegistration = CACVerificationService.normalizeRegistrationNumber(
      evidence.registrationNumber
    );

    if (
      !submittedRegistration?.submitted ||
      !evidenceRegistration?.submitted ||
      submittedRegistration.submitted !== evidenceRegistration.submitted ||
      evidence.responseRegistrationNumber !== submittedRegistration.submitted
    ) {
      throw this.createError({
        message: "CAC verification does not match your registration number.",
        code: "ONBOARDING_CAC_NUMBER_MISMATCH",
      });
    }

    // ───────── GET REGISTERED BUSINESS NAME ─────────

    const registeredBusinessName = this.getAuthoritativeBusinessName(evidence);

    // ───────── RE-EVALUATE CAC REGISTRY DETAILS ─────────

    /*
     * Verify registration identity, entity category,
     * active status and the trusted business name.
     *
     * Do not compare against an applicant-supplied
     * business name.
     */

    const company = {
      registrationNumber: evidence.responseRegistrationNumber,
      entityName: registeredBusinessName,
      entityType: evidence.entityType,
      entityStatus: evidence.entityStatus,
      registrationDate: evidence.registrationDate || null,
    };

    if (
      !company.registrationNumber ||
      !company.entityName ||
      !company.entityType ||
      !company.entityStatus
    ) {
      throw this.createError({
        message: "CAC verification evidence is incomplete. Please contact support.",
        code: "ONBOARDING_CAC_INVALID_EVIDENCE",
      });
    }

    const evaluation = EmployerVerificationService.evaluateCACResult({
      registration: submittedRegistration,
      result: company,
    });

    if (
      evaluation?.eligible !== true ||
      evaluation.registeredBusinessName !== registeredBusinessName ||
      evaluation.checks?.registrationNumberMatches !== true ||
      evaluation.checks?.entityCategoryMatches !== true ||
      evaluation.checks?.registrationIsActive !== true ||
      evidence.checks?.registrationNumberMatches !== true ||
      evidence.checks?.entityCategoryMatches !== true ||
      evidence.checks?.registrationIsActive !== true
    ) {
      throw this.createError({
        message: "CAC registration details could not be confirmed.",
        code: "ONBOARDING_CAC_DETAILS_MISMATCH",
      });
    }

    return {
      evidence,
      checkedAt,
      company,
      evaluation,
      registeredBusinessName,
    };
  }

  // ───────────────────── PERSIST CAC VERIFICATION ─────────────────────

  /*
   * Persist the prepared CAC evidence to the
   * employer profile and permanent KYC history.
   *
   * When preparedCAC is supplied, evidence has
   * already been validated and consumed.
   *
   * The preparation context must be internal
   * service data, never request-body data.
   */

  static async persistPreOnboardingCACVerification({
    userId,
    profile,
    profileData,
    session,
    preparedCAC = null,
  }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error("An active onboarding transaction is required to persist CAC evidence.");
    }

    const prepared =
      preparedCAC ||
      (await this.preparePreOnboardingCACVerification({
        userId,
        profileData,
        session,
      }));

    const { evidence, checkedAt, company, evaluation, registeredBusinessName } = prepared;

    // ───────── EMPLOYER PROFILE SUMMARY ─────────

    const reason = "CAC registration verified through the configured provider.";

    /*
     * Persist the CAC registered legal name.
     * Employer approval remains separate.
     */

    profile.set({
      businessName: registeredBusinessName,

      cacVerificationStatus: "verified",
      cacVerificationMethod: "api",
      cacVerificationSource: "provider",

      cacNameOnRecord: registeredBusinessName,

      cacVerifiedAt: checkedAt,
      cacLastCheckedAt: checkedAt,
      cacVerifiedBy: null,

      cacVerificationNote: EmployerVerificationService.truncate(reason),

      cacRejectionReason: null,
    });

    await profile.save({ session });

    // ───────── DEACTIVATE EARLIER ACTIVE CAC HISTORY ─────────

    await KYCVerification.updateMany(
      {
        employer: profile._id,
        type: "cac",
        isActive: true,
      },
      {
        $set: {
          isActive: false,
        },
      },
      { session }
    );

    // ───────── PERMANENT CAC EVIDENCE ─────────

    const metadata = {
      verificationSource: "pre_onboarding",

      preOnboardingVerificationId: String(evidence._id),

      submittedRegistrationNumber: evidence.registrationNumber,

      responseRegistrationNumber: company.registrationNumber,
      responseEntityType: company.entityType,
      responseEntityStatus: company.entityStatus,
      responseRegistrationDate: company.registrationDate,

      checks: evaluation.checks,

      registeredBusinessNameSource: "cac_registry",

      stagingOnly: false,
    };

    const records = await KYCVerification.create(
      [
        {
          user: userId,
          employer: profile._id,

          ownerType: "employer",
          type: "cac",

          provider: evidence.provider,
          providerEnvironment: "production",

          requestReference: evidence.requestReference || null,
          providerReference: evidence.providerReference || null,

          status: "verified",
          nameOnRecord: registeredBusinessName,

          submittedAt: evidence.lookupStartedAt || checkedAt,
          lastCheckedAt: checkedAt,
          verifiedAt: checkedAt,

          reviewNote: null,

          metadata,

          isActive: true,
        },
      ],
      { session }
    );

    return {
      consumed: true,

      provider: evidence.provider,
      environment: "production",

      status: "verified",
      verified: true,

      requiresReview: false,
      stagingOnly: false,

      representativeAuthorized: false,
      employerApproved: false,

      verificationId: records[0]._id,
    };
  }

  // ───────────────────── PROFILE FIELD ALLOWLIST ─────────────────────

  /*
   * Only ordinary profile fields may be persisted.
   * Verification, ownership, approval and financial
   * fields remain service-owned.
   */

  static pickProfileFields(data, fields) {
    return Object.fromEntries(
      fields.filter((field) => Object.hasOwn(data, field)).map((field) => [field, data[field]])
    );
  }

  // ───────────────────── PROFESSIONAL ONBOARDING ─────────────────────

  static async completeProfessionalOnboarding(userId, data) {
    /*
     * ProfileInputService validates ordinary
     * professional profile inputs.
     *
     * Browser-supplied legal-name fields are excluded.
     * Registry-derived names are persisted separately
     * to User inside the transaction.
     */

    const profileData = this.pickProfileFields(
      ProfileInputService.buildProfessionalProfileData(data),
      [
        "type",
        "licenceNumber",
        "phoneCode",
        "phone",
        "specialty",
        "address",
        "googlePlaceId",
        "location",
        "state",
        "lga",
        "yearsOfExperience",
        "bio",
      ]
    );

    const session = await mongoose.startSession();

    let profile;
    let wallet;
    let preOnboardingNINResult = null;

    try {
      await session.withTransaction(async () => {
        preOnboardingNINResult = null;

        await this.assertCanCompleteOnboarding({
          userId,
          role: "professional",
          session,
        });

        // ───────── CREATE PROFESSIONAL PROFILE ─────────

        profile = await ProfessionalProfile.findOne({
          user: userId,
        }).session(session);

        if (profile) {
          profile.set(profileData);
        } else {
          profile = new ProfessionalProfile({
            ...profileData,
            user: userId,
          });
        }

        // Document validation also protects licence changes.
        await profile.save({ session });

        // ───────── CREATE WALLET ─────────

        wallet = await walletService.createProfessionalWalletIfMissing(profile, { session });

        // ───────── REQUIRE ACKNOWLEDGED PRODUCTION NIN ─────────

        /*
         * Consume the current acknowledged NIN
         * evidence and persist:
         *
         * - Permanent KYC record;
         * - User first, middle and last names;
         * - Legal-name source;
         * - Permanent legal-name evidence reference.
         *
         * All operations remain transactional.
         */

        preOnboardingNINResult = await this.persistPreOnboardingNINVerification({
          userId,
          profile,
          session,
        });

        // ───────── COMPLETE ONBOARDING ─────────

        await this.markUserOnboarded({
          userId,
          role: "professional",
          profileId: profile._id,
          session,
        });
      });

      logger.info(`Professional wallet ready for profile: ${profile._id}, wallet: ${wallet._id}`);

      logger.info(
        `Production NIN registry evidence recorded for professional ${profile._id}: ` +
          `${preOnboardingNINResult.provider}/${preOnboardingNINResult.environment}.`
      );

      logger.info(`Professional onboarding completed for user: ${userId}`);

      return profile;
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── INITIAL EMPLOYER BRANCH ─────────────────────

  static async createInitialEmployerBranch({ profile, session }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error("An active onboarding transaction is required to create the initial branch.");
    }

    if (!profile?._id) {
      throw this.createError({
        message: "The employer profile must exist before creating its initial branch.",
        code: "ONBOARDING_EMPLOYER_PROFILE_REQUIRED",
        statusCode: 500,
      });
    }

    const currentLocation = profile.location?.coordinates;
    const longitude = Array.isArray(currentLocation) ? Number(currentLocation[0]) : NaN;
    const latitude = Array.isArray(currentLocation) ? Number(currentLocation[1]) : NaN;

    if (
      !profile.address ||
      !profile.googlePlaceId ||
      !profile.state ||
      !profile.lga ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw this.createError({
        message: "Please select a valid business location before completing onboarding.",
        code: "ONBOARDING_INITIAL_BRANCH_INVALID_LOCATION",
        statusCode: 400,
      });
    }

    const existingPrimary = await Branch.findOne({
      business: profile._id,
      isPrimary: true,
    }).session(session);

    if (existingPrimary) {
      const previousCoordinates = existingPrimary.location?.coordinates;
      const sameLocation =
        existingPrimary.googlePlaceId === profile.googlePlaceId &&
        existingPrimary.address === profile.address &&
        existingPrimary.state === profile.state &&
        existingPrimary.lga === profile.lga &&
        Array.isArray(previousCoordinates) &&
        previousCoordinates.length === 2 &&
        Number(previousCoordinates[0]) === longitude &&
        Number(previousCoordinates[1]) === latitude;

      if (!sameLocation) {
        throw this.createError({
          message: "The existing primary branch does not match the onboarding location.",
          code: "ONBOARDING_PRIMARY_BRANCH_LOCATION_CONFLICT",
        });
      }

      return existingPrimary;
    }

    // The same configured geofence default used when employers add branches.
    const geofencePolicy = await BranchService.getGeofencePolicy();
    if (
      !Number.isSafeInteger(geofencePolicy.defaultRadius) ||
      geofencePolicy.defaultRadius < geofencePolicy.minimumRadius ||
      geofencePolicy.defaultRadius > geofencePolicy.maximumRadius
    ) {
      throw this.createError({
        message: "The default branch geofence configuration is invalid.",
        code: "ONBOARDING_BRANCH_GEOFENCE_CONFIGURATION_INVALID",
        statusCode: 500,
      });
    }

    const branch = new Branch({
      business: profile._id,
      isPrimary: true,
      name: "Main Branch",
      address: profile.address,
      state: profile.state,
      lga: profile.lga,
      googlePlaceId: profile.googlePlaceId,
      location: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      geofenceRadiusMeters: geofencePolicy.defaultRadius,
      contactPhoneCode: profile.businessPhoneCode || "",
      contactPhone: profile.businessPhone || "",
      isActive: true,
    });

    await branch.save({ session });
    return branch;
  }

  // ───────────────────── EMPLOYER ONBOARDING ─────────────────────

  static async completeEmployerOnboarding(userId, data) {
    /*
     * Consume CAC evidence before building the
     * employer profile.
     *
     * The provider's registered legal business name
     * replaces any applicant-supplied business name.
     *
     * CAC verification does not verify a facility permit or
     * grant clinical marketplace eligibility.
     */

    const submittedProfileData =
      data && typeof data === "object" && !Array.isArray(data) ? data : {};

    const session = await mongoose.startSession();

    let profile;
    let wallet;
    let initialBranch;
    let preOnboardingCACResult = null;

    try {
      await session.withTransaction(async () => {
        preOnboardingCACResult = null;
        initialBranch = null;

        await this.assertCanCompleteOnboarding({
          userId,
          role: "employer",
          session,
        });

        // ───────── VALIDATE CAC BEFORE PROFILE CREATION ─────────

        /*
         * Consume verified production CAC evidence.
         *
         * This does not trigger another paid lookup.
         */

        const preparedCAC = await this.preparePreOnboardingCACVerification({
          userId,
          profileData: {
            cacRegistrationNumber: submittedProfileData.cacRegistrationNumber,
          },
          session,
        });

        // ───────── BUILD REGISTRY-AUTHORITATIVE PROFILE DATA ─────────

        /*
         * Pass the trusted registered business name
         * into ProfileInputService for validation.
         *
         * Ignore any request-body businessName.
         */

        // Facility permits are submitted after onboarding, against a Branch.
        // Never accept profile-level regulatory details from this request.
        const profileInput = { ...submittedProfileData };
        delete profileInput.regulatoryBody;
        delete profileInput.regulatoryRegistrationNumber;

        const verifiedProfileData = {
          ...ProfileInputService.buildEmployerProfileData({
            ...profileInput,

            cacRegistrationNumber: preparedCAC.evidence.registrationNumber,

            businessName: preparedCAC.registeredBusinessName,
          }),

          businessName: preparedCAC.registeredBusinessName,

          cacRegistrationNumber: preparedCAC.evidence.registrationNumber,
        };

        const employerProfileData = this.pickProfileFields(verifiedProfileData, [
          "type",
          "businessName",
          "businessEmail",
          "cacRegistrationNumber",
          "businessPhoneCode",
          "businessPhone",
          "address",
          "googlePlaceId",
          "location",
          "state",
          "lga",
          "contactFirstName",
          "contactLastName",
          "contactRole",
          "contactPhoneCode",
          "contactPhone",
        ]);

        // ───────── CREATE EMPLOYER PROFILE ─────────

        profile = await EmployerProfile.findOne({
          user: userId,
        }).session(session);

        if (profile) {
          if (profile.businessName !== preparedCAC.registeredBusinessName) {
            throw this.createError({
              message:
                "Your registered business name requires a controlled correction. Please contact support.",
              code: "ONBOARDING_EMPLOYER_NAME_CONFLICT",
            });
          }

          profile.set(employerProfileData);
        } else {
          profile = new EmployerProfile({
            ...employerProfileData,
            user: userId,
          });
        }

        await profile.save({ session });

        // ───────── CREATE INITIAL PRIMARY BRANCH ─────────

        // Address and Google location are already present on EmployerProfile.
        // Do not require a separate Add Branch step or an uploaded permit here.
        initialBranch = await this.createInitialEmployerBranch({ profile, session });

        // ───────── CREATE WALLET ─────────

        wallet = await walletService.createEmployerWalletIfMissing(profile, { session });

        // ───────── PERSIST CAC VERIFICATION HISTORY ─────────

        /*
         * Reuse the prepared CAC result.
         * Do not consume evidence twice.
         */

        preOnboardingCACResult = await this.persistPreOnboardingCACVerification({
          userId,
          profile,

          profileData: {
            cacRegistrationNumber: preparedCAC.evidence.registrationNumber,
          },

          session,
          preparedCAC,
        });

        // ───────── COMPLETE ONBOARDING ─────────

        await this.markUserOnboarded({
          userId,
          role: "employer",
          profileId: profile._id,
          session,
        });
      });
    } finally {
      await session.endSession();
    }

    logger.info(
      `Employer initial branch ready for profile: ${profile._id}, branch: ${initialBranch._id}`
    );
    logger.info(`Employer wallet ready for profile: ${profile._id}, wallet: ${wallet._id}`);

    logger.info(
      `Production CAC registration verified for employer ${profile._id}: ` +
        `${preOnboardingCACResult.provider}/${preOnboardingCACResult.environment}.`
    );

    // ───────────────────── PAYSTACK DVA PROVISIONING ─────────────────────

    /*
     * Preserve post-commit DVA provisioning.
     *
     * CAC verification and DVA provisioning do not establish
     * facility-permit approval or marketplace eligibility.
     *
     * DVA provisioning failure does not reverse
     * completed onboarding.
     */

    try {
      const dva = await DVAService.createEmployerDVA({
        userId,
        employerProfileId: profile._id,
      });

      if (dva?.status === "active") {
        logger.info(`Employer DVA active for profile: ${profile._id}`);
      } else if (dva?.status === "pending") {
        logger.info(`Employer DVA provisioning pending for profile: ${profile._id}`);
      } else if (dva?.status === "failed") {
        logger.warn(`Employer DVA provisioning failed for profile: ${profile._id}`);
      } else {
        logger.info(`Employer DVA status unavailable for profile: ${profile._id}`);
      }
    } catch (error) {
      /*
       * Never log raw Paystack errors containing
       * potentially sensitive customer information.
       */

      const errorCode =
        typeof error?.code === "string" && /^[A-Z0-9_]{2,100}$/.test(error.code)
          ? error.code
          : "EMPLOYER_DVA_PROVISIONING_ERROR";

      logger.error(`Employer DVA creation failed for profile ${profile._id}: ${errorCode}`);
    }

    logger.info(`Employer onboarding completed for user: ${userId}`);

    return profile;
  }
}

module.exports = OnboardingService;
