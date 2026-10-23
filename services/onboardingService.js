// services/onboardingService.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const KYCVerification = require("../models/KYCVerification");

const logger = require("../utils/logger");

const walletService = require("./walletService");
const DVAService = require("./dvaService");
const ProfileInputService = require("./profileInputService");

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
   * Normal professional onboarding requires successful,
   * unexpired, acknowledged production NIN registry evidence.
   *
   * Professional legal names originate exclusively from
   * trusted NIN registry evidence.
   *
   * A user may correct an incorrect NIN immediately
   * during pre-onboarding verification.
   *
   * Only the currently acknowledged NIN evidence
   * may be consumed during onboarding.
   *
   * Normal employer onboarding requires successful,
   * unexpired, production CAC registration evidence.
   *
   * Employer registered legal business names originate
   * exclusively from trusted CAC registry evidence.
   *
   * Verification requests occur BEFORE onboarding
   * through explicit actions in the onboarding forms.
   *
   * No NIN or CAC provider calls occur in this service.
   *
   * Frontend-submitted names are not authoritative
   * identity or business-registration evidence.
   *
   * Registry matching and name acknowledgement
   * are not identity-holder authentication.
   *
   * Registry verification is not final KYC/KYB approval.
   *
   * Professional licensing, employer representative
   * checks, PCN premises verification and administrative
   * approval remain separate requirements.
   *
   * All onboarding database changes occur within
   * a MongoDB transaction.
   *
   * Wallet creation remains part of onboarding.
   *
   * Employer DVA provisioning remains a post-commit
   * operation independent of final KYB approval.
   *
   * Failed DVA provisioning does not roll back onboarding.
   *
   * Account closure and returning-customer DVA handling
   * belong to the separate account-lifecycle workstream.
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
   * Registry names must originate from trusted,
   * server-persisted verification evidence.
   *
   * Read-only frontend fields are informational.
   *
   * Never trust request-body firstName, middleName,
   * lastName or businessName as authoritative
   * verification evidence.
   *
   * Preserve legitimate name components without
   * guessing their order or splitting full names.
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
   * Required trusted NIN evidence contract:
   *
   * registryLegalName: {
   *   firstName: String,
   *   middleName: String,
   *   lastName: String
   * }
   *
   * Middle name may be empty.
   *
   * The pre-onboarding NIN service obtains
   * these values from trusted registry responses.
   *
   * Do not derive individual name fields by
   * splitting nameOnRecord.
   *
   * Compound names and different name ordering
   * make such splitting unreliable.
   *
   * Names cannot originate from the onboarding
   * request or provisional registration fields.
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

    return {
      firstName,
      middleName,
      lastName,
      displayName,
    };
  }

  // ───────────────────── PERSIST PROFESSIONAL LEGAL NAME ─────────────────────

  /*
   * Establish the professional's registry-derived
   * legal name in the User document.
   *
   * Persist the following fields atomically:
   *
   * - firstName;
   * - middleName;
   * - lastName;
   * - legalNameSource;
   * - legalNameEvidence.
   *
   * legalNameEvidence references the permanent
   * KYCVerification record created within the
   * same onboarding transaction.
   *
   * Registry-name provenance identifies the
   * source of the name.
   *
   * It does not establish that the applicant
   * has authenticated ownership of the NIN.
   *
   * An existing registry-authoritative identity
   * must not be silently overwritten.
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
     * Fail closed if the required User schema
     * fields are unavailable.
     *
     * Otherwise, Mongoose strict mode could
     * silently discard unknown update fields.
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
     * The legal-name source must still be unverified
     * when its first authoritative registry evidence
     * is being established.
     *
     * Loqum is greenfield, so this does not include
     * compatibility handling for historical data.
     *
     * Existing trusted provenance cannot be
     * overwritten through ordinary onboarding.
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
   * EmployerProfile.businessName must be obtained
   * from trusted CAC registration evidence.
   *
   * The applicant supplies their CAC registration
   * number before onboarding.
   *
   * The applicant does not supply an authoritative
   * registered legal business name.
   *
   * A trading name or public display name may
   * exist separately but cannot replace the
   * registered legal business name.
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
    const normalized = String(registrationNumber || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");

    return /^(RC|BN)\d{4,10}$/.test(normalized);
  }

  // ───────────────────── REQUIRED NIN EVIDENCE ─────────────────────

  /*
   * Invoked within the professional onboarding transaction.
   *
   * Normal onboarding requires:
   *
   * - Successful production NIN registry lookup;
   * - Current, unexpired temporary evidence;
   * - Explicit lookup consent;
   * - Complete structured registry legal names;
   * - Applicant acknowledgement of the current name;
   * - No outstanding NIN correction;
   * - Transactional evidence consumption.
   *
   * No provider lookup occurs here.
   *
   * The pre-onboarding NIN service validates
   * these requirements before consumption.
   *
   * Even after successful NIN registry lookup:
   *
   * - Identity-holder authentication remains separate;
   * - Professional approval is not granted;
   * - Marketplace access is not granted.
   */

  static async persistPreOnboardingNINVerification({ userId, profile, session }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw new Error("An active onboarding transaction is required to persist NIN evidence.");
    }

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
     * Confirmation must refer to the exact
     * registry lookup being consumed.
     *
     * A previous acknowledgement cannot authorise
     * an updated or corrected NIN.
     *
     * The pre-onboarding service also checks
     * these conditions in its atomic query.
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

    // ───────── REQUIRE AUTHORITATIVE LEGAL NAME ─────────

    const legalName = this.getAuthoritativeProfessionalName(evidence);

    /*
     * Evidence ownership, expiry, provider,
     * acknowledgement and consumption are checked
     * by the pre-onboarding service.
     *
     * All persistence remains transactional.
     *
     * A subsequent failure rolls back evidence
     * consumption, profile updates and wallet creation.
     */

    const reviewNote =
      "NIN registry name acknowledged and recorded. Identity-holder authentication remains outstanding.";

    const metadata = {
      verificationSource: "pre_onboarding",

      preOnboardingVerificationId: String(evidence._id),

      registryFound: true,
      registryMatched: true,

      // Acknowledgement is not identity-holder authentication.
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
     * Persist structured registry legal-name evidence
     * alongside the display-oriented nameOnRecord.
     *
     * No registration-name matching is required.
     *
     * The verification remains needs_review because
     * the registry lookup and acknowledgement do not
     * independently establish NIN ownership.
     *
     * It must not automatically qualify the
     * professional for marketplace participation.
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
     * Update User legal-name fields and link
     * their provenance to permanent KYC evidence.
     *
     * The applicant's registration fields do not
     * override the registry-derived legal name.
     *
     * Registry authority establishes the source
     * of the name, not final identity approval.
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
   * CAC evidence must be validated before using
   * its registered business name for the employer
   * profile.
   *
   * The preparation stage:
   *
   * - Consumes trusted pre-onboarding evidence;
   * - Requires a successful production result;
   * - Validates the CAC registration identity;
   * - Obtains the authoritative registered name;
   * - Re-evaluates registration eligibility.
   *
   * This happens within the onboarding transaction.
   *
   * No provider requests occur here.
   *
   * The user-submitted businessName is not
   * required by this verification process.
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

    /*
     * The revised pre-onboarding CAC service
     * accepts the registration number only.
     *
     * businessName is intentionally excluded.
     *
     * Evidence is owned by the employer account
     * and consumed within this transaction.
     */

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
     * active status and the trusted registered name.
     *
     * Do not reintroduce submittedBusinessName
     * or businessNameMatches.
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
   * This method persists previously validated
   * CAC evidence to the employer profile and
   * permanent verification history.
   *
   * The optional preparedCAC argument allows
   * completeEmployerOnboarding to validate and
   * consume evidence BEFORE creating the profile.
   *
   * Without preparedCAC, this method retains
   * its existing prepare-and-persist behaviour.
   *
   * Evidence must never be consumed twice.
   *
   * The preparation context is trusted internal
   * service data, never a request-body argument.
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
     * Always persist the CAC-registered legal name.
     *
     * The employer profile is created using
     * this same authoritative value.
     *
     * A caller supplying an existing profile
     * is also corrected to the registry name.
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

    /*
     * Only the CAC registration component
     * is verified.
     *
     * Employer approval remains dependent on
     * representative checks, PCN premises review
     * and administrator approval.
     */

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

    /*
     * Record the verified registration identity,
     * registered legal business name and all
     * required CAC registry checks.
     *
     * Do not persist obsolete submitted-name
     * comparison metadata.
     *
     * The registered business name remains
     * registry-authoritative.
     */

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

  // ───────────────────── PROFESSIONAL ONBOARDING ─────────────────────

  static async completeProfessionalOnboarding(userId, data) {
    /*
     * ProfileInputService remains responsible
     * for validating professional profile inputs.
     *
     * Remove user-supplied legal-name fields from
     * the resulting profile data.
     *
     * Registry-derived legal names are persisted
     * separately to User within the transaction.
     */

    const profileData = {
      ...ProfileInputService.buildProfessionalProfileData(data),
    };

    delete profileData.firstName;
    delete profileData.middleName;
    delete profileData.lastName;
    delete profileData.legalNameSource;
    delete profileData.legalNameEvidence;

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

        profile = await ProfessionalProfile.findOneAndUpdate(
          {
            user: userId,
          },
          {
            $set: profileData,

            $setOnInsert: {
              user: userId,
            },
          },
          {
            returnDocument: "after",
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            context: "query",
            session,
          }
        );

        // ───────── CREATE WALLET ─────────

        wallet = await walletService.createProfessionalWalletIfMissing(profile, { session });

        // ───────── REQUIRE ACKNOWLEDGED PRODUCTION NIN EVIDENCE ─────────

        /*
         * Consume the current, acknowledged
         * production NIN registry evidence.
         *
         * Persist permanent KYC evidence and
         * establish the professional's:
         *
         * - firstName;
         * - middleName;
         * - lastName;
         * - legalNameSource;
         * - legalNameEvidence.
         *
         * All changes occur in the same transaction.
         *
         * No selfie verification is introduced.
         *
         * Identity-holder assurance, PCN licence
         * verification and final approval remain
         * separate from this onboarding step.
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

  // ───────────────────── EMPLOYER ONBOARDING ─────────────────────

  static async completeEmployerOnboarding(userId, data) {
    /*
     * Unlike the previous implementation,
     * buildEmployerProfileData() must not be
     * called with an unverified business name.
     *
     * First validate and consume CAC evidence.
     *
     * Then build the employer profile using
     * the trusted registered business name.
     *
     * This allows the applicant to complete
     * onboarding without manually entering
     * their authoritative legal business name.
     *
     * The original registration number comes
     * from the onboarding request, but its
     * identity is checked against trusted
     * pre-onboarding evidence.
     */

    const submittedProfileData =
      data && typeof data === "object" && !Array.isArray(data) ? data : {};

    const session = await mongoose.startSession();

    let profile;
    let wallet;
    let preOnboardingCACResult = null;

    try {
      await session.withTransaction(async () => {
        preOnboardingCACResult = null;

        await this.assertCanCompleteOnboarding({
          userId,
          role: "employer",
          session,
        });

        // ───────── VALIDATE CAC BEFORE PROFILE CREATION ─────────

        /*
         * Consume trusted production CAC evidence
         * before building or creating the profile.
         *
         * The authoritative registered business
         * name comes only from this evidence.
         *
         * No second CAC lookup or charge occurs.
         *
         * Consumption remains transactional.
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
         * Supply the registry name to the existing
         * ProfileInputService so its validation
         * works with the authoritative business name.
         *
         * This also avoids requiring applicants
         * to manually enter businessName.
         *
         * An applicant-supplied businessName,
         * if present in the request, is replaced
         * before the profile builder runs.
         */

        const verifiedProfileData = {
          ...ProfileInputService.buildEmployerProfileData({
            ...submittedProfileData,

            cacRegistrationNumber: preparedCAC.evidence.registrationNumber,

            businessName: preparedCAC.registeredBusinessName,
          }),

          businessName: preparedCAC.registeredBusinessName,

          cacRegistrationNumber: preparedCAC.evidence.registrationNumber,
        };

        /*
         * Registry and approval fields must not be
         * supplied as ordinary employer profile inputs.
         *
         * CAC verification fields are established
         * through persistPreOnboardingCACVerification.
         *
         * PCN, representative and administrator
         * approval remain separate processes.
         */

        delete verifiedProfileData.cacNameOnRecord;
        delete verifiedProfileData.cacVerificationStatus;
        delete verifiedProfileData.cacVerifiedAt;
        delete verifiedProfileData.cacVerifiedBy;
        delete verifiedProfileData.cacLastCheckedAt;
        delete verifiedProfileData.cacVerificationMethod;
        delete verifiedProfileData.cacVerificationSource;
        delete verifiedProfileData.cacVerificationNote;
        delete verifiedProfileData.cacRejectionReason;

        delete verifiedProfileData.regulatoryVerificationStatus;
        delete verifiedProfileData.regulatoryVerifiedAt;
        delete verifiedProfileData.regulatoryVerifiedBy;
        delete verifiedProfileData.regulatoryNameOnRecord;

        delete verifiedProfileData.employerApprovalStatus;
        delete verifiedProfileData.employerApprovalStatusUpdatedAt;
        delete verifiedProfileData.employerApprovalStatusUpdatedBy;
        delete verifiedProfileData.approvedToPostShiftsAt;
        delete verifiedProfileData.approvedToPostShiftsBy;

        // ───────── CREATE EMPLOYER PROFILE ─────────

        profile = await EmployerProfile.findOneAndUpdate(
          {
            user: userId,
          },
          {
            $set: verifiedProfileData,

            $setOnInsert: {
              user: userId,
            },
          },
          {
            returnDocument: "after",
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            context: "query",
            session,
          }
        );

        // ───────── CREATE WALLET ─────────

        wallet = await walletService.createEmployerWalletIfMissing(profile, { session });

        // ───────── PERSIST CAC VERIFICATION HISTORY ─────────

        /*
         * Reuse the already validated CAC evidence.
         *
         * Do not consume it again.
         *
         * Persist the registry-authoritative
         * business name and permanent CAC history
         * inside this same transaction.
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

    logger.info(`Employer wallet ready for profile: ${profile._id}, wallet: ${wallet._id}`);

    logger.info(
      `Production CAC registration verified for employer ${profile._id}: ` +
        `${preOnboardingCACResult.provider}/${preOnboardingCACResult.environment}.`
    );

    // ───────────────────── PAYSTACK DVA PROVISIONING ─────────────────────

    /*
     * Preserve existing post-commit DVA behaviour.
     *
     * Successful production CAC registration
     * verification is required to reach this stage
     * through normal onboarding.
     *
     * DVA provisioning does not mean the employer
     * has received final KYB approval or marketplace
     * authorisation.
     *
     * Failed DVA provisioning does not reverse
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
        logger.info(`Employer DVA status for profile ${profile._id}: ${dva?.status || "unknown"}`);
      }
    } catch (error) {
      /*
       * Do not log raw Paystack errors that might
       * contain sensitive customer information.
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
