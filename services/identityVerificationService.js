// services/identityVerificationService.js

const crypto = require("crypto");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const NinjaVerificationService = require("./ninjaVerificationService");
const DojahVerificationService = require("./dojahVerificationService");

const IDENTITY_VERIFICATION_SERVICE_ERROR_NAME = "IdentityVerificationServiceError";

const SUPPORTED_PROVIDERS = Object.freeze({
  ninja: NinjaVerificationService,
  dojah: DojahVerificationService,
});

class IdentityVerificationService {
  /*
   * PROVIDER-INDEPENDENT IDENTITY COORDINATOR
   *
   * Owns:
   *
   * - Explicit identity provider selection;
   * - NIN-only input validation;
   * - Provider-independent registry name retrieval;
   * - Verification environment validation;
   * - Trusted response normalization;
   * - Safe provider error mapping;
   * - Ninja hosted KYC coordination;
   * - Hosted verification result retrieval;
   * - Signed Ninja webhook normalization.
   *
   * Does not:
   *
   * - Authenticate a person from a NIN lookup;
   * - Accept self-declared names as registry evidence;
   * - Approve professional identities;
   * - Approve professional licences;
   * - Write KYC or professional profile records;
   * - Automatically switch providers;
   * - Automatically retry chargeable lookups.
   *
   * NIN registry evidence may establish the legal
   * name recorded by the registry.
   *
   * It does not establish that the applicant
   * is the rightful holder of that NIN.
   *
   * Identity-holder authentication, professional
   * licensing and administrative approval remain
   * separate verification requirements.
   *
   * Active identity verification uses NIN only.
   */

  // ───────────────────── ERRORS ─────────────────────

  static createError({ message, code, statusCode = 503, details = null }) {
    return createServiceError({
      name: IDENTITY_VERIFICATION_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static normalizeProviderError(error) {
    if (
      error?.name === IDENTITY_VERIFICATION_SERVICE_ERROR_NAME &&
      typeof error.code === "string" &&
      error.code.startsWith("IDENTITY_")
    ) {
      return error;
    }

    const code = String(error?.code || "");

    // ───────── PROVIDER CONFIGURATION ─────────

    if (
      [
        "NINJA_NOT_CONFIGURED",
        "DOJAH_NOT_CONFIGURED",
        "NINJA_PRODUCTION_DISABLED",
        "DOJAH_PRODUCTION_DISABLED",
        "NINJA_INVALID_ENV",
        "NINJA_KEY_ENVIRONMENT_MISMATCH",
        "NINJA_KYC_FLOW_NOT_CONFIGURED",
      ].includes(code)
    ) {
      return this.createError({
        message: "Identity provider is not configured for this operation.",
        code: "IDENTITY_NOT_CONFIGURED",
      });
    }

    // ───────── PROVIDER SELECTION ─────────

    if (["NINJA_NOT_SELECTED", "DOJAH_NOT_SELECTED"].includes(code)) {
      return this.createError({
        message: "Identity provider does not match the selected configuration.",
        code: "IDENTITY_PROVIDER_MISMATCH",
        statusCode: 409,
      });
    }

    // ───────── VERIFICATION DISABLED ─────────

    if (
      [
        "NINJA_VERIFICATION_DISABLED",
        "DOJAH_VERIFICATION_DISABLED",
        "VERIFICATION_DISABLED",
      ].includes(code)
    ) {
      return this.createError({
        message: "New identity verification requests are disabled.",
        code: "IDENTITY_VERIFICATION_DISABLED",
      });
    }

    // ───────── INVALID REQUEST REFERENCE ─────────

    if (["NINJA_INVALID_REFERENCE", "DOJAH_INVALID_REFERENCE"].includes(code)) {
      return this.createError({
        message: "Invalid identity verification reference.",
        code: "IDENTITY_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    // ───────── UNSUPPORTED IDENTITY METHOD ─────────

    if (
      [
        "NINJA_INVALID_IDENTITY_TYPE",
        "NINJA_UNSUPPORTED_IDENTITY_TYPE",
        "DOJAH_INVALID_IDENTITY_TYPE",
        "DOJAH_UNSUPPORTED_IDENTITY_TYPE",
      ].includes(code)
    ) {
      return this.createError({
        message: "Only NIN verification is supported.",
        code: "IDENTITY_UNSUPPORTED_METHOD",
        statusCode: 422,
      });
    }

    // ───────── INVALID NIN ─────────

    if (["NINJA_INVALID_IDENTITY_NUMBER", "DOJAH_INVALID_IDENTITY_NUMBER"].includes(code)) {
      return this.createError({
        message: "NIN must contain exactly 11 digits.",
        code: "IDENTITY_INVALID_IDENTIFIER",
        statusCode: 400,
      });
    }

    // ───────── DETAIL VERIFICATION INPUTS ─────────

    /*
     * These errors may originate from the Ninja
     * detail-verification operation.
     *
     * Registry-name prepopulation does not require
     * applicant-supplied identity names.
     */

    if (code === "NINJA_MISSING_IDENTITY_NAME") {
      return this.createError({
        message: "Identity detail verification requires first and last names.",
        code: "IDENTITY_MISSING_NAME",
        statusCode: 400,
      });
    }

    if (code === "NINJA_INVALID_DATE_OF_BIRTH") {
      return this.createError({
        message: "Date of birth must be a valid YYYY-MM-DD date.",
        code: "IDENTITY_INVALID_DATE_OF_BIRTH",
        statusCode: 400,
      });
    }

    // ───────── REJECTED PROVIDER REQUEST ─────────

    if (["NINJA_INVALID_REQUEST", "DOJAH_INVALID_REQUEST"].includes(code)) {
      return this.createError({
        message: "The identity provider rejected the request.",
        code: "IDENTITY_INVALID_REQUEST",
        statusCode: 422,
      });
    }

    // ───────── PROVIDER AUTHORIZATION ─────────

    if (["NINJA_ACCESS_DENIED", "DOJAH_ACCESS_DENIED"].includes(code)) {
      return this.createError({
        message: "Identity provider authorization failed.",
        code: "IDENTITY_PROVIDER_ACCESS_DENIED",
      });
    }

    // ───────── PROVIDER FUNDING ─────────

    if (["NINJA_INSUFFICIENT_FUNDS", "DOJAH_INSUFFICIENT_FUNDS"].includes(code)) {
      return this.createError({
        message: "Identity verification wallet requires funding.",
        code: "IDENTITY_INSUFFICIENT_FUNDS",
      });
    }

    // ───────── RATE LIMITING ─────────

    /*
     * Retryability is informational.
     *
     * This service never automatically retries
     * a potentially chargeable provider request.
     */

    if (["NINJA_RATE_LIMITED", "DOJAH_RATE_LIMITED"].includes(code)) {
      return this.createError({
        message: "Identity provider rate limit reached.",
        code: "IDENTITY_RATE_LIMITED",
        statusCode: 429,
        details: {
          retryable: true,
        },
      });
    }

    // ───────── HTTP CLIENT CONFIGURATION ─────────

    if (["NINJA_INVALID_HTTP_CLIENT", "DOJAH_INVALID_HTTP_CLIENT"].includes(code)) {
      return this.createError({
        message: "Identity provider HTTP client is not configured correctly.",
        code: "IDENTITY_PROVIDER_CONFIGURATION_ERROR",
        statusCode: 500,
      });
    }

    // ───────── INVALID REGISTRY EVIDENCE ─────────

    if (
      [
        "NINJA_INVALID_IDENTITY_RESPONSE",
        "DOJAH_INVALID_IDENTITY_RESPONSE",
        "NINJA_INVALID_NIN_LOOKUP_RESPONSE",
        "NINJA_INCONSISTENT_NIN_LOOKUP",
        "NINJA_NIN_RESPONSE_MISMATCH",
        "NINJA_NIN_NAME_INCOMPLETE",
        "NINJA_NIN_NAME_TOO_LONG",
        "DOJAH_NIN_NAME_TOO_LONG",
        "DOJAH_INVALID_RESPONSE",
        "NINJA_INVALID_RESPONSE",
      ].includes(code)
    ) {
      return this.createError({
        message: "Identity provider returned invalid registry information.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    if (code === "NINJA_INCOMPLETE_KYC_REQUEST") {
      return this.createError({
        message: "Valid names and email are required for hosted verification.",
        code: "IDENTITY_INCOMPLETE_KYC_REQUEST",
        statusCode: 400,
      });
    }

    // ───────── INVALID HOSTED KYC RESPONSE ─────────

    if (
      [
        "NINJA_INVALID_VERIFICATION_RESULT",
        "NINJA_INVALID_KYC_LINK",
        "NINJA_INVALID_KYC_URL",
        "NINJA_UNTRUSTED_KYC_URL",
      ].includes(code)
    ) {
      return this.createError({
        message: "Identity provider returned invalid hosted verification information.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    // ───────── HOSTED VERIFICATION ID ─────────

    if (code === "NINJA_INVALID_VERIFICATION_ID") {
      return this.createError({
        message: "Invalid hosted verification identifier.",
        code: "IDENTITY_INVALID_VERIFICATION_ID",
        statusCode: 400,
      });
    }

    // ───────── WEBHOOK SIGNATURE ─────────

    if (code === "NINJA_INVALID_WEBHOOK_SIGNATURE") {
      return this.createError({
        message: "Invalid identity verification webhook signature.",
        code: "IDENTITY_INVALID_WEBHOOK_SIGNATURE",
        statusCode: 401,
      });
    }

    // ───────── WEBHOOK CONTENT ─────────

    if (
      [
        "NINJA_INVALID_WEBHOOK_PAYLOAD",
        "NINJA_INCOMPLETE_WEBHOOK",
        "NINJA_UNSUPPORTED_WEBHOOK_IDENTITY_TYPE",
      ].includes(code)
    ) {
      return this.createError({
        message: "Invalid identity verification webhook event.",
        code: "IDENTITY_INVALID_WEBHOOK_EVENT",
        statusCode: 400,
      });
    }

    /*
     * All unrecognised provider errors fail closed.
     *
     * An HTTP 404 is not always proof that an
     * identity does not exist in the registry.
     *
     * Do not forward provider responses, HTTP
     * configurations, credentials or raw errors.
     */

    return this.createError({
      message: "Identity verification provider is unavailable.",
      code: "IDENTITY_PROVIDER_UNAVAILABLE",
    });
  }

  // ───────────────────── CONFIGURATION ─────────────────────

  static assertVerificationEnabled() {
    if (process.env.VERIFICATION_ENABLED !== "true") {
      throw this.createError({
        message: "New identity verification requests are disabled.",
        code: "IDENTITY_VERIFICATION_DISABLED",
      });
    }
  }

  static getProvider() {
    const provider = String(process.env.IDENTITY_VERIFICATION_PROVIDER || "")
      .trim()
      .toLowerCase();

    if (!Object.hasOwn(SUPPORTED_PROVIDERS, provider)) {
      throw this.createError({
        message: "A supported identity provider must be configured.",
        code: "IDENTITY_INVALID_PROVIDER",
      });
    }

    return provider;
  }

  static getAdapter(provider = this.getProvider()) {
    if (!Object.hasOwn(SUPPORTED_PROVIDERS, provider)) {
      throw this.createError({
        message: "Unsupported identity verification provider.",
        code: "IDENTITY_INVALID_PROVIDER",
      });
    }

    return SUPPORTED_PROVIDERS[provider];
  }

  // ───────────────────── ENVIRONMENT NORMALIZATION ─────────────────────

  /*
   * Provider environments are normalized for
   * storage using:
   *
   * sandbox -> staging
   * staging -> staging
   * production -> production
   *
   * Staging registry results cannot authorise
   * production identity verification or onboarding.
   */

  static normalizeEnvironment(environment) {
    if (environment === "sandbox" || environment === "staging") {
      return "staging";
    }

    if (environment === "production") {
      return "production";
    }

    throw this.createError({
      message: "Invalid identity verification environment.",
      code: "IDENTITY_INVALID_ENVIRONMENT",
    });
  }

  static assertResponseEnvironment(received, expected) {
    let environment;

    try {
      environment = this.normalizeEnvironment(received);
    } catch (_) {
      throw this.createError({
        message: "Identity provider response environment mismatch.",
        code: "IDENTITY_ENVIRONMENT_MISMATCH",
        statusCode: 502,
      });
    }

    if (environment !== expected) {
      throw this.createError({
        message: "Identity provider response environment mismatch.",
        code: "IDENTITY_ENVIRONMENT_MISMATCH",
        statusCode: 502,
      });
    }

    return environment;
  }

  static getEnvironment(provider = this.getProvider()) {
    const adapter = this.getAdapter(provider);

    if (typeof adapter.getEnvironment !== "function") {
      throw this.createError({
        message: "Selected identity provider has no environment configuration.",
        code: "IDENTITY_PROVIDER_CONFIGURATION_ERROR",
        statusCode: 500,
      });
    }

    let environment;

    try {
      environment = adapter.getEnvironment();
    } catch (error) {
      throw this.normalizeProviderError(error);
    }

    return this.normalizeEnvironment(environment);
  }

  // ───────────────────── INPUT VALIDATION ─────────────────────

  /*
   * The active identity workflow is NIN-only.
   *
   * Do not accept BVN or other document types
   * as substitutes.
   */

  static normalizeMethod(method) {
    const value = (typeof method === "string" ? method : "").trim().toLowerCase();

    if (value !== "nin") {
      throw this.createError({
        message: "Only NIN verification is supported.",
        code: "IDENTITY_UNSUPPORTED_METHOD",
        statusCode: 422,
      });
    }

    return value;
  }

  static normalizeIdentifier(identifier) {
    const value = typeof identifier === "string" ? identifier.trim() : "";

    if (!/^\d{11}$/.test(value)) {
      throw this.createError({
        message: "NIN must contain exactly 11 digits.",
        code: "IDENTITY_INVALID_IDENTIFIER",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── REQUEST CORRELATION ─────────────────────

  /*
   * Every new registry lookup has a bounded
   * internal request reference.
   *
   * The reference is passed to the selected
   * adapter and checked when the result returns.
   *
   * This is not a provider-issued verification ID.
   */

  static normalizeReference(reference) {
    if (reference === undefined || reference === null || reference === "") {
      return crypto.randomUUID();
    }

    if (typeof reference !== "string") {
      throw this.createError({
        message: "Invalid identity verification reference.",
        code: "IDENTITY_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    const value = reference.trim();

    if (!value || value.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
      throw this.createError({
        message: "Invalid identity verification reference.",
        code: "IDENTITY_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── REGISTRY NAME NORMALIZATION ─────────────────────

  /*
   * Registry name components must come directly
   * from the selected provider's trusted response.
   *
   * No fallback to account registration names.
   *
   * Do not split a combined full name to guess
   * individual name components.
   */

  static normalizeRegistryName(value, maxLength = 100, optional = false) {
    if (optional && (value === undefined || value === null || value === "")) {
      return "";
    }

    if (typeof value !== "string") {
      return null;
    }

    if (/[\u0000-\u001F\u007F]/.test(value)) {
      return null;
    }

    const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");

    if (optional && !normalized) {
      return "";
    }

    if (!normalized || normalized.length > maxLength) {
      return null;
    }

    return normalized;
  }

  // ───────────────────── REGISTRY RESPONSE NORMALIZATION ─────────────────────

  /*
   * Ninja and Dojah must expose the same
   * registry-name evidence contract.
   *
   * Successful lookup:
   *
   * {
   *   registryFound: true,
   *   registryLegalName: {
   *     firstName,
   *     middleName,
   *     lastName
   *   },
   *   nameOnRecord,
   *   holderAuthenticated: false
   * }
   *
   * Unconfirmed registry record:
   *
   * {
   *   registryFound: false,
   *   registryLegalName: null,
   *   nameOnRecord: null,
   *   holderAuthenticated: false
   * }
   *
   * A successful registry lookup does not grant
   * identity-holder authentication or professional
   * approval.
   */

  static normalizeLookupResponse(lookup, { provider, environment, method, requestReference }) {
    if (!lookup || typeof lookup !== "object" || Array.isArray(lookup)) {
      throw this.createError({
        message: "Identity provider returned an invalid response.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    // ───────── VERIFY SELECTED PROVIDER ─────────

    if (lookup.provider !== provider) {
      throw this.createError({
        message: "Identity provider response does not match the selected provider.",
        code: "IDENTITY_PROVIDER_MISMATCH",
        statusCode: 502,
      });
    }

    // ───────── VERIFY ENVIRONMENT ─────────

    this.assertResponseEnvironment(lookup.environment, environment);

    // ───────── VERIFY IDENTITY METHOD ─────────

    if (method !== "nin" || lookup.method !== method) {
      throw this.createError({
        message: "Identity provider returned an unsupported identity method.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    // ───────── VERIFY REQUEST CORRELATION ─────────

    const returnedReference = lookup.requestReference ?? lookup.reference;

    if (
      typeof returnedReference !== "string" ||
      returnedReference !== requestReference ||
      (lookup.requestReference != null && lookup.requestReference !== requestReference) ||
      (lookup.reference != null && lookup.reference !== requestReference)
    ) {
      throw this.createError({
        message: "Identity provider response reference mismatch.",
        code: "IDENTITY_REFERENCE_MISMATCH",
        statusCode: 502,
      });
    }

    // ───────── VERIFY REGISTRY OUTCOME ─────────

    if (
      typeof lookup.registryFound !== "boolean" ||
      typeof lookup.found !== "boolean" ||
      lookup.registryFound !== lookup.found ||
      lookup.holderAuthenticated !== false
    ) {
      throw this.createError({
        message: "Identity provider did not confirm a valid registry outcome.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    const expectedStatus = lookup.registryFound ? "found" : "not_found";

    if (lookup.status !== expectedStatus || lookup.verified === true) {
      throw this.createError({
        message: "Identity provider returned inconsistent registry evidence.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    // ───────── PROVIDER REFERENCE ─────────

    let providerReference = null;

    if (lookup.providerReference != null) {
      if (
        typeof lookup.providerReference !== "string" ||
        !lookup.providerReference.trim() ||
        lookup.providerReference.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(lookup.providerReference)
      ) {
        throw this.createError({
          message: "Identity provider returned an invalid reference.",
          code: "IDENTITY_INVALID_RESPONSE",
          statusCode: 502,
        });
      }

      providerReference = lookup.providerReference.trim();
      if (providerReference === requestReference) providerReference = null;
    }

    // ───────── REGISTRY RECORD NOT CONFIRMED ─────────

    /*
     * The provider has not confirmed a record.
     *
     * No legal name can be established from
     * this outcome.
     *
     * No verification or approval is granted.
     */

    if (!lookup.registryFound) {
      if (lookup.registryLegalName != null || lookup.nameOnRecord != null) {
        throw this.createError({
          message: "Identity provider returned inconsistent name evidence.",
          code: "IDENTITY_INVALID_RESPONSE",
          statusCode: 502,
        });
      }

      return {
        provider,
        environment,
        method,

        requestReference,
        providerReference,

        found: false,
        registryFound: false,
        status: "not_found",

        registryLegalName: null,
        nameOnRecord: null,

        holderAuthenticated: false,
        verified: false,
      };
    }

    // ───────── REQUIRE STRUCTURED LEGAL NAME ─────────

    const registryName = lookup.registryLegalName;

    if (!registryName || typeof registryName !== "object" || Array.isArray(registryName)) {
      throw this.createError({
        message: "Identity registry legal-name information is incomplete.",
        code: "IDENTITY_INCOMPLETE_REGISTRY_NAME",
        statusCode: 502,
      });
    }

    const firstName = this.normalizeRegistryName(registryName.firstName, 100);

    const middleName = this.normalizeRegistryName(registryName.middleName, 100, true);

    const lastName = this.normalizeRegistryName(registryName.lastName, 100);

    if (!firstName || !lastName || middleName === null) {
      throw this.createError({
        message: "Identity registry legal-name information is invalid.",
        code: "IDENTITY_INCOMPLETE_REGISTRY_NAME",
        statusCode: 502,
      });
    }

    const nameOnRecord = [firstName, middleName, lastName].filter(Boolean).join(" ");

    if (nameOnRecord.length > 150) {
      throw this.createError({
        message: "Identity registry legal name requires additional review.",
        code: "IDENTITY_REGISTRY_NAME_TOO_LONG",
        statusCode: 502,
      });
    }

    // ───────── CROSS-CHECK COMBINED NAME ─────────

    /*
     * Both adapters provide a combined
     * nameOnRecord.
     *
     * It must agree with the structured
     * registry-name components.
     *
     * Do not accept conflicting combinations.
     */

    const returnedName = this.normalizeRegistryName(lookup.nameOnRecord, 150);

    if (!returnedName || returnedName !== nameOnRecord) {
      throw this.createError({
        message: "Identity provider returned inconsistent legal-name information.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    // ───────── RETURN NORMALIZED EVIDENCE ─────────

    /*
     * Return only the minimum required
     * registry evidence.
     *
     * No raw NIN, provider payload, date of
     * birth, photograph or personal address.
     *
     * This result may establish the registry
     * legal name but not identity ownership.
     */

    return {
      provider,
      environment,
      method,

      requestReference,
      providerReference,

      found: true,
      registryFound: true,
      status: "found",

      registryLegalName: {
        firstName,
        middleName,
        lastName,
      },

      nameOnRecord,

      holderAuthenticated: false,
      verified: false,
    };
  }

  // ───────────────────── REGISTRY IDENTITY LOOKUP ─────────────────────

  /*
   * Provider-independent NIN registry lookup.
   *
   * Both Ninja and Dojah now use their respective
   * lookupIdentityRecord methods.
   *
   * Ninja must use registry lookup mode, not
   * name-comparison mode.
   *
   * Dojah must return structured NIN names.
   *
   * The account's self-declared registration names
   * are not sent to the provider.
   *
   * This method performs one provider request
   * only, through the explicitly selected adapter.
   *
   * The calling domain service is responsible for:
   *
   * - Authenticated user authorization;
   * - Consent;
   * - Lookup cooldown;
   * - Atomic processing claims;
   * - Temporary evidence storage;
   * - Paid-request duplicate prevention.
   */

  static async lookupIdentityRecord({ method = "nin", identifier, reference, httpClient } = {}) {
    this.assertVerificationEnabled();

    const normalizedMethod = this.normalizeMethod(method);

    const idNumber = this.normalizeIdentifier(identifier);

    const requestReference = this.normalizeReference(reference);

    const provider = this.getProvider();

    const environment = this.getEnvironment(provider);

    const adapter = this.getAdapter(provider);

    if (typeof adapter.lookupIdentityRecord !== "function") {
      throw this.createError({
        message: "Selected identity provider does not support NIN registry lookup.",
        code: "IDENTITY_LOOKUP_NOT_SUPPORTED",
        statusCode: 503,
      });
    }

    let lookup;

    try {
      lookup = await adapter.lookupIdentityRecord({
        method: normalizedMethod,

        identifier: idNumber,

        reference: requestReference,

        ...(httpClient !== undefined ? { httpClient } : {}),
      });
    } catch (error) {
      throw this.normalizeProviderError(error);
    }

    return this.normalizeLookupResponse(lookup, {
      provider,
      environment,
      method: normalizedMethod,
      requestReference,
    });
  }

  // ───────────────────── IDENTITY LOOKUP ENTRY POINT ─────────────────────

  /*
   * Keep the existing lookupIdentity entry point
   * for the application's active service callers.
   *
   * Its behaviour is now registry-name retrieval
   * for both Ninja and Dojah.
   *
   * It does not compare applicant-supplied
   * first name, last name or date of birth.
   *
   * Callers must be updated to consume
   * registryLegalName instead of detailsMatched.
   */

  static async lookupIdentity({ method = "nin", identifier, reference, httpClient } = {}) {
    return this.lookupIdentityRecord({
      method,
      identifier,
      reference,
      ...(httpClient !== undefined ? { httpClient } : {}),
    });
  }

  // ───────────────────── HOSTED IDENTITY ─────────────────────

  /*
   * Hosted identity verification is a separate
   * operation from NIN registry-name retrieval.
   *
   * Ninja currently provides Loqum's hosted
   * identity verification flow.
   *
   * When Dojah is selected, this service must
   * not silently use Ninja or create an
   * unexpected second charge.
   *
   * The professional verification domain must
   * provide trusted legal-name values from
   * the saved account identity.
   *
   * Names from the frontend are not sufficient
   * authority to initiate identity approval.
   */

  static async createHostedIdentityLink({
    customerReference,
    firstName,
    lastName,
    email,
    httpClient,
  } = {}) {
    this.assertVerificationEnabled();

    const provider = this.getProvider();

    if (provider !== "ninja") {
      throw this.createError({
        message: "Hosted identity verification is not configured for the selected provider.",
        code: "IDENTITY_HOSTED_KYC_NOT_SUPPORTED",
        statusCode: 422,
      });
    }

    const environment = this.getEnvironment(provider);

    const requestReference = this.normalizeReference(customerReference);
    let link;

    try {
      link = await NinjaVerificationService.createHostedIdentityLink({
        customerReference: requestReference,
        firstName,
        lastName,
        email,

        ...(httpClient !== undefined ? { httpClient } : {}),
      });
    } catch (error) {
      throw this.normalizeProviderError(error);
    }

    if (!link || link.provider !== "ninja") {
      throw this.createError({
        message: "Hosted verification provider mismatch.",
        code: "IDENTITY_PROVIDER_MISMATCH",
        statusCode: 502,
      });
    }

    this.assertResponseEnvironment(link.environment, environment);

    if (
      link.customerReference !== requestReference ||
      typeof link.verificationId !== "string" ||
      !/^vs_[A-Za-z0-9_-]+$/.test(link.verificationId) ||
      typeof link.flowId !== "string" ||
      !/^vf_[A-Za-z0-9_-]+$/.test(link.flowId)
    ) {
      throw this.createError({
        message: "Hosted verification references are inconsistent.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    /*
     * Hosted verification URLs are sensitive
     * access links.
     *
     * Controllers may expose them only to
     * the authenticated and authorized applicant.
     *
     * Do not log or persist the hosted URL
     * as general KYC metadata.
     */

    return {
      provider: "ninja",
      environment,

      verificationId: link.verificationId,

      requestReference,

      flowId: link.flowId,

      verificationUrl: link.verificationUrl,

      expiresAt: link.expiresAt,

      status: "pending",
    };
  }

  // ───────────────────── HOSTED VERIFICATION RESULT ─────────────────────

  /*
   * Previously created Ninja hosted attempts
   * must remain readable after an explicit
   * identity provider configuration change.
   *
   * This is necessary for active verification
   * attempts, not for migration of historical data.
   *
   * The original verification record determines
   * which provider and environment may be queried.
   *
   * Never retrieve a staging attempt using
   * production credentials or vice versa.
   *
   * Reading a hosted result never grants
   * automatic professional approval.
   */

  static async getHostedIdentityResult({ verificationId, httpClient } = {}) {
    const id = typeof verificationId === "string" ? verificationId.trim() : "";
    if (!/^vs_[A-Za-z0-9_-]+$/.test(id)) {
      throw this.createError({
        message: "Invalid hosted verification identifier.",
        code: "IDENTITY_INVALID_VERIFICATION_ID",
        statusCode: 400,
      });
    }
    /*
     * This operation is intentionally pinned
     * to Ninja because it retrieves a Ninja
     * hosted verification attempt.
     *
     * The calling professional domain service
     * must first establish that the saved
     * attempt belongs to Ninja.
     */

    const environment = this.getEnvironment("ninja");

    let outcome;

    try {
      outcome = await NinjaVerificationService.getHostedIdentityResult({
        verificationId: id,

        ...(httpClient !== undefined ? { httpClient } : {}),
      });
    } catch (error) {
      throw this.normalizeProviderError(error);
    }

    if (!outcome || outcome.provider !== "ninja") {
      throw this.createError({
        message: "Hosted identity result provider mismatch.",
        code: "IDENTITY_PROVIDER_MISMATCH",
        statusCode: 502,
      });
    }

    this.assertResponseEnvironment(outcome.environment, environment);
    if (
      outcome.verificationId !== id ||
      typeof outcome.sandbox !== "boolean" ||
      outcome.sandbox !== (environment === "staging")
    ) {
      throw this.createError({
        message: "Hosted verification result does not match the requested attempt.",
        code: "IDENTITY_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    /*
     * A successful hosted session must still
     * be evaluated by the professional domain
     * against the original verification attempt.
     *
     * The domain must check:
     *
     * - Provider;
     * - Environment;
     * - Verification ID;
     * - Flow ID;
     * - Customer reference;
     * - Final verification outcome;
     * - Evidence required by the configured holder-authentication policy.
     *
     * Scores are informational evidence only.
     * This coordinator does not apply biometric
     * approval thresholds.
     */

    return {
      provider: "ninja",
      environment,

      verificationId: outcome.verificationId,

      status: outcome.status,

      outcome: outcome.outcome,

      flowId: outcome.flowId,

      customerReference: outcome.customerReference,

      sandbox: outcome.sandbox,

      score:
        typeof outcome.score === "number" && Number.isFinite(outcome.score) ? outcome.score : null,

      faceScore:
        typeof outcome.faceScore === "number" && Number.isFinite(outcome.faceScore)
          ? outcome.faceScore
          : null,
    };
  }

  // ───────────────────── SIGNED WEBHOOKS ─────────────────────

  /*
   * A valid signed webhook is not final
   * identity verification or approval.
   *
   * The webhook processor must:
   *
   * - Deduplicate event IDs;
   * - Locate the original verification attempt;
   * - Match the original provider and environment;
   * - Validate verification and flow references;
   * - Retrieve and validate final identity evidence;
   * - Apply the configured holder-authentication policy;
   * - Update KYC records transactionally.
   *
   * A sandbox event cannot grant production
   * identity verification.
   *
   * This method parses Ninja webhooks only.
   */

  static parseHostedIdentityWebhook({ rawBody, signature, secret } = {}) {
    let event;

    try {
      event = NinjaVerificationService.parseHostedIdentityWebhook({
        rawBody,
        signature,

        secret: secret ?? process.env.NINJA_KYC_WEBHOOK_SECRET,
      });
    } catch (error) {
      throw this.normalizeProviderError(error);
    }

    if (
      !event ||
      event.provider !== "ninja" ||
      event.method !== "nin" ||
      typeof event.sandbox !== "boolean"
    ) {
      throw this.createError({
        message: "Invalid identity verification webhook event.",
        code: "IDENTITY_INVALID_WEBHOOK_EVENT",
        statusCode: 400,
      });
    }

    return {
      provider: "ninja",
      eventId: event.eventId,
      eventType: event.eventType,
      verificationId: event.verificationId,
      flowId: event.flowId,
      customerReference: event.customerReference,
      status: event.status,
      outcome: event.outcome,
      method: "nin",
      sandbox: event.sandbox,
      score: typeof event.score === "number" && Number.isFinite(event.score) ? event.score : null,
      faceScore:
        typeof event.faceScore === "number" && Number.isFinite(event.faceScore)
          ? event.faceScore
          : null,
      environment: event.sandbox ? "staging" : "production",
    };
  }
}

module.exports = IdentityVerificationService;
