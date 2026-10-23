// services/dojahVerificationService.js

const axios = require("axios");
const crypto = require("crypto");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const DOJAH_VERIFICATION_SERVICE_ERROR_NAME = "DojahVerificationServiceError";

const BASE_URLS = Object.freeze({
  sandbox: "https://sandbox.dojah.io",
  production: "https://api.dojah.io",
});

const ENDPOINTS = Object.freeze({
  nin: "/api/v1/kyc/nin",
  cac: "/api/v1/kyc/cac/basic",
});

const CAC_COMPANY_TYPES = Object.freeze({
  RC: "COMPANY",
  BN: "BUSINESS_NAME",
});

class DojahVerificationService {
  /*
   * DOJAH VERIFICATION ADAPTER
   *
   * Responsibilities:
   *
   * - Retrieve authoritative NIN registry names;
   * - Retrieve registered CAC business details;
   * - Normalize provider responses;
   * - Enforce provider configuration;
   * - Prevent use of disabled environments;
   * - Return only the evidence required by Loqum.
   *
   * Active professional identity verification
   * uses NIN only.
   *
   * BVN and virtual NIN are not part of the
   * current Loqum verification architecture.
   *
   * Registry lookups do not establish:
   *
   * - Identity-holder authentication;
   * - Business representative authority;
   * - Professional licence approval;
   * - PCN premises approval;
   * - Final platform approval.
   *
   * The domain services remain responsible for
   * authorization, duplicate-request protection,
   * evidence persistence and approval decisions.
   *
   * No automatic provider fallback.
   *
   * No automatic retry of chargeable requests.
   *
   * Never log raw identity numbers, credentials,
   * registry photographs or raw provider responses.
   */

  // ───────────────────── ERRORS ─────────────────────

  static createError({ message, code, statusCode = 503, details = null }) {
    return createServiceError({
      name: DOJAH_VERIFICATION_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static normalizeProviderError(error) {
    if (
      error?.name === DOJAH_VERIFICATION_SERVICE_ERROR_NAME &&
      typeof error.code === "string" &&
      error.code.startsWith("DOJAH_")
    ) {
      return error;
    }

    const status = error?.response?.status;

    if (status === 400 || status === 422) {
      return this.createError({
        message: "Dojah rejected the verification request.",
        code: "DOJAH_INVALID_REQUEST",
        statusCode: 422,
      });
    }

    if (status === 401 || status === 403) {
      return this.createError({
        message: "Dojah API access is unavailable.",
        code: "DOJAH_ACCESS_DENIED",
        statusCode: 503,
      });
    }

    if (status === 402) {
      return this.createError({
        message: "Dojah verification wallet requires funding.",
        code: "DOJAH_INSUFFICIENT_FUNDS",
        statusCode: 503,
      });
    }

    /*
     * Dojah documents HTTP 404 for identifiers
     * that cannot be located.
     *
     * The lookup method translates this into
     * a non-verified, not-found result.
     *
     * An unavailable endpoint would also fail
     * closed because no verification evidence
     * would be accepted.
     */

    if (status === 404) {
      return this.createError({
        message: "The requested registry record was not found.",
        code: "DOJAH_RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (status === 429) {
      return this.createError({
        message: "Dojah API rate limit reached.",
        code: "DOJAH_RATE_LIMITED",
        statusCode: 429,
      });
    }

    /*
     * Never expose raw Axios errors.
     *
     * Axios configurations may contain:
     *
     * - API credentials;
     * - NIN values;
     * - CAC registration numbers;
     * - Personal information;
     * - Sensitive request parameters.
     *
     * A timeout does not prove that the provider
     * failed to process or charge for a request.
     *
     * Do not automatically retry.
     */

    return this.createError({
      message: "Dojah verification request failed or timed out.",
      code: "DOJAH_PROVIDER_UNAVAILABLE",
      statusCode: 503,
    });
  }

  // ───────────────────── CONFIGURATION ─────────────────────

  static getEnvironment() {
    const environment = String(process.env.DOJAH_ENV || "")
      .trim()
      .toLowerCase();

    if (!Object.hasOwn(BASE_URLS, environment)) {
      throw this.createError({
        message: "Invalid Dojah verification environment.",
        code: "DOJAH_NOT_CONFIGURED",
        statusCode: 500,
      });
    }

    if (environment === "production" && process.env.DOJAH_ALLOW_PRODUCTION !== "true") {
      throw this.createError({
        message: "Dojah production verification is disabled.",
        code: "DOJAH_PRODUCTION_DISABLED",
      });
    }

    return environment;
  }

  static getCredentials() {
    const appId = String(process.env.DOJAH_APP_ID || "").trim();

    const secretKey = String(process.env.DOJAH_SECRET_KEY || "").trim();

    if (!appId || !secretKey) {
      throw this.createError({
        message: "Dojah API credentials are not configured.",
        code: "DOJAH_NOT_CONFIGURED",
      });
    }

    /*
     * Dojah uses environment-specific credentials.
     *
     * The application must configure credentials
     * appropriate for DOJAH_ENV.
     *
     * Dojah credentials do not provide a documented
     * prefix that reliably identifies the environment.
     *
     * Consequently, we do not guess the environment
     * from the secret key.
     */

    return {
      appId,
      secretKey,
    };
  }

  // ───────────────────── NEW VERIFICATION POLICY ─────────────────────

  static assertNewVerificationEnabled(type) {
    if (!["identity", "cac"].includes(type)) {
      throw this.createError({
        message: "Invalid verification category.",
        code: "DOJAH_INVALID_VERIFICATION_TYPE",
        statusCode: 400,
      });
    }

    if (process.env.VERIFICATION_ENABLED !== "true") {
      throw this.createError({
        message: "New verification requests are disabled.",
        code: "DOJAH_VERIFICATION_DISABLED",
      });
    }

    if (process.env.DOJAH_LOOKUPS_ENABLED !== "true") {
      throw this.createError({
        message: "Dojah lookups are disabled.",
        code: "DOJAH_VERIFICATION_DISABLED",
      });
    }

    const setting =
      type === "identity" ? "IDENTITY_VERIFICATION_PROVIDER" : "CAC_VERIFICATION_PROVIDER";

    const selectedProvider = String(process.env[setting] || "")
      .trim()
      .toLowerCase();

    if (selectedProvider !== "dojah") {
      throw this.createError({
        message: "Dojah is not the selected verification provider.",
        code: "DOJAH_NOT_SELECTED",
        statusCode: 409,
      });
    }
  }

  // ───────────────────── HTTP CONFIGURATION ─────────────────────

  static getRequestOptions(environment, params = {}) {
    if (!Object.hasOwn(BASE_URLS, environment)) {
      throw this.createError({
        message: "Invalid Dojah request environment.",
        code: "DOJAH_NOT_CONFIGURED",
        statusCode: 500,
      });
    }

    const { appId, secretKey } = this.getCredentials();

    /*
     * Dojah authenticates requests using:
     *
     * AppId: application ID
     * Authorization: secret key
     *
     * Do not add a Bearer prefix.
     *
     * These credentials are strictly server-side.
     */

    return {
      headers: {
        AppId: appId,
        Authorization: secretKey,
        Accept: "application/json",
      },

      params,

      timeout: 15000,

      maxRedirects: 0,

      withCredentials: false,
    };
  }

  static normalizeReference(reference) {
    if (reference == null || reference === "") {
      return crypto.randomUUID();
    }

    const value = String(reference).trim();

    if (!value || value.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
      throw this.createError({
        message: "Invalid verification reference.",
        code: "DOJAH_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── HTTP REQUESTS ─────────────────────

  static async get(path, params, type, httpClient = axios) {
    this.assertNewVerificationEnabled(type);

    const environment = this.getEnvironment();

    if (!Object.values(ENDPOINTS).includes(path)) {
      throw this.createError({
        message: "Invalid Dojah verification endpoint.",
        code: "DOJAH_INVALID_ENDPOINT",
        statusCode: 500,
      });
    }

    if (!httpClient || typeof httpClient.get !== "function") {
      throw this.createError({
        message: "Invalid Dojah HTTP client.",
        code: "DOJAH_INVALID_HTTP_CLIENT",
        statusCode: 500,
      });
    }

    const options = this.getRequestOptions(environment, params);

    let response;

    try {
      response = await httpClient.get(BASE_URLS[environment] + path, options);
    } catch (error) {
      throw this.normalizeProviderError(error);
    }

    /*
     * An injected HTTP client may not reject
     * unsuccessful HTTP status codes.
     */

    if (
      !response ||
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    ) {
      throw this.normalizeProviderError({
        response: {
          status: response?.status,
        },
      });
    }

    const payload = response.data;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw this.createError({
        message: "Dojah returned invalid verification information.",
        code: "DOJAH_INVALID_RESPONSE",
      });
    }

    const responseStatus =
      typeof payload.status === "string" ? payload.status.trim().toLowerCase() : null;

    /*
     * A provider-reported missing registry record
     * must not become a successful lookup.
     */

    if (responseStatus === "not_found") {
      throw this.createError({
        message: "The requested registry record was not found.",
        code: "DOJAH_RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (payload.status === false || payload.error || ["failed", "error"].includes(responseStatus)) {
      throw this.createError({
        message: "Dojah returned an unsuccessful verification response.",
        code: "DOJAH_INVALID_RESPONSE",
      });
    }

    if (!payload.entity || typeof payload.entity !== "object" || Array.isArray(payload.entity)) {
      throw this.createError({
        message: "Dojah returned incomplete verification information.",
        code: "DOJAH_INVALID_RESPONSE",
      });
    }

    /*
     * Return only the entity to the adapter's
     * normalization layer.
     *
     * Raw provider payloads are not exposed to
     * controllers or persisted by this service.
     */

    return {
      environment,
      entity: payload.entity,
    };
  }

  // ───────────────────── REGISTRY NAME SUPPORT ─────────────────────

  /*
   * Names must come directly from the configured
   * verification provider's registry response.
   *
   * No account registration name may be used
   * as fallback evidence.
   *
   * Do not split combined full names into
   * presumed first, middle and last names.
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

  // ───────────────────── IDENTITY METHOD ─────────────────────

  /*
   * Loqum professional identity verification
   * supports NIN only.
   *
   * BVN and virtual NIN are not available through
   * the active identity verification workflow.
   */

  static normalizeIdentityType(method) {
    const value = String(method || "")
      .trim()
      .toLowerCase();

    if (value !== "nin") {
      throw this.createError({
        message: "Only NIN verification is supported.",
        code: "DOJAH_UNSUPPORTED_IDENTITY_TYPE",
        statusCode: 400,
      });
    }

    return value;
  }

  static normalizeIdentityNumber(identifier) {
    const value = String(identifier || "").trim();

    if (!/^\d{11}$/.test(value)) {
      throw this.createError({
        message: "NIN must contain exactly 11 digits.",
        code: "DOJAH_INVALID_IDENTITY_NUMBER",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── NIN RESPONSE NORMALIZATION ─────────────────────

  /*
   * Dojah's NIN endpoint returns separate legal
   * name components.
   *
   * Only these components are required for
   * authoritative legal-name prepopulation.
   *
   * Do not return:
   *
   * - Raw NIN;
   * - Photographs;
   * - Phone numbers;
   * - Addresses;
   * - Gender;
   * - Other unnecessary registry information.
   *
   * Registry-name retrieval does not establish
   * identity-holder authentication.
   */

  static normalizeIdentityResponse(entity) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      throw this.createError({
        message: "Dojah returned invalid identity information.",
        code: "DOJAH_INVALID_IDENTITY_RESPONSE",
      });
    }

    const firstName = this.normalizeRegistryName(entity.first_name ?? entity.firstname, 100);

    const middleName = this.normalizeRegistryName(
      entity.middle_name ?? entity.middlename,
      100,
      true
    );

    const lastName = this.normalizeRegistryName(entity.last_name ?? entity.surname, 100);

    if (!firstName || !lastName || middleName === null) {
      throw this.createError({
        message: "Dojah returned incomplete NIN legal-name information.",
        code: "DOJAH_INVALID_IDENTITY_RESPONSE",
      });
    }

    const nameOnRecord = [firstName, middleName, lastName].filter(Boolean).join(" ");

    if (nameOnRecord.length > 150) {
      throw this.createError({
        message: "NIN legal name requires additional review.",
        code: "DOJAH_NIN_NAME_TOO_LONG",
      });
    }

    return {
      registryLegalName: {
        firstName,
        middleName,
        lastName,
      },

      nameOnRecord,
    };
  }

  // ───────────────────── NIN REGISTRY LOOKUP ─────────────────────

  /*
   * GET /api/v1/kyc/nin
   *
   * Dojah returns a registry identity record
   * for the supplied 11-digit NIN.
   *
   * This method exposes the same authoritative
   * name contract as Ninja.lookupIdentityRecord.
   *
   * The provider response is normalized to:
   *
   * - registryFound;
   * - registryLegalName;
   * - nameOnRecord;
   * - holderAuthenticated.
   *
   * A registry record is not proof that the
   * applicant is the rightful identity holder.
   */

  static async lookupIdentityRecord({
    method = "nin",
    identifier,
    reference,
    httpClient = axios,
  } = {}) {
    this.assertNewVerificationEnabled("identity");

    const identityType = this.normalizeIdentityType(method);

    const idNumber = this.normalizeIdentityNumber(identifier);

    const requestReference = this.normalizeReference(reference);

    /*
     * Send only documented NIN parameters.
     *
     * The reference is maintained internally
     * for correlation and is not sent as an
     * undocumented Dojah query parameter.
     */

    let response;

    try {
      response = await this.get(
        ENDPOINTS.nin,
        {
          nin: idNumber,
        },
        "identity",
        httpClient
      );
    } catch (error) {
      if (error?.code === "DOJAH_RESOURCE_NOT_FOUND") {
        return {
          provider: "dojah",
          environment: this.getEnvironment(),

          endpoint: ENDPOINTS.nin,
          method: identityType,

          reference: requestReference,
          requestReference,
          providerReference: null,

          found: false,
          registryFound: false,

          status: "not_found",

          registryLegalName: null,
          nameOnRecord: null,

          holderAuthenticated: false,
        };
      }

      throw error;
    }

    const normalized = this.normalizeIdentityResponse(response.entity);

    return {
      provider: "dojah",
      environment: response.environment,

      endpoint: ENDPOINTS.nin,
      method: identityType,

      /*
       * Internal request correlation.
       *
       * Not a provider-issued transaction ID.
       */

      reference: requestReference,
      requestReference,
      providerReference: null,

      found: true,
      registryFound: true,

      status: "found",

      registryLegalName: normalized.registryLegalName,

      nameOnRecord: normalized.nameOnRecord,

      holderAuthenticated: false,
    };
  }

  // ───────────────────── IDENTITY LOOKUP ENTRY POINT ─────────────────────

  /*
   * Keep the existing lookupIdentity entry point
   * while unifying the provider-independent
   * identity service around lookupIdentityRecord.
   *
   * Both methods enforce NIN-only verification.
   *
   * This is active-code integration support,
   * not historical-data compatibility.
   */

  static async lookupIdentity({ method = "nin", identifier, reference, httpClient = axios } = {}) {
    return this.lookupIdentityRecord({
      method,
      identifier,
      reference,
      httpClient,
    });
  }

  // ───────────────────── NIN LOOKUP CONVENIENCE ─────────────────────

  static async lookupNIN({ nin, reference, httpClient = axios } = {}) {
    return this.lookupIdentityRecord({
      method: "nin",
      identifier: nin,
      reference,
      httpClient,
    });
  }

  // ───────────────────── CAC REGISTRATION SUPPORT ─────────────────────

  /*
   * CAC lookup retrieves the registered legal
   * business name and registration evidence.
   *
   * No user-entered legal business name is
   * required by this adapter.
   *
   * Supported registration categories:
   *
   * RC -> COMPANY
   * BN -> BUSINESS_NAME
   *
   * Verification of a business registration
   * does not establish that the applicant
   * is an authorised representative.
   */

  static normalizeCACNumber(value) {
    const clean = String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");

    const match = /^(RC|BN)(\d{4,10})$/.exec(clean);

    if (!match) {
      throw this.createError({
        message: "A valid RC or BN registration number is required.",
        code: "DOJAH_INVALID_CAC_NUMBER",
        statusCode: 400,
      });
    }

    return {
      submitted: `${match[1]}${match[2]}`,

      prefix: match[1],

      rc_number: match[2],

      company_type: CAC_COMPANY_TYPES[match[1]],
    };
  }

  // ───────────────────── CAC RESPONSE NORMALIZATION ─────────────────────

  static normalizeCACResponse(entity, registration) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      throw this.createError({
        message: "Dojah returned an invalid CAC response.",
        code: "DOJAH_INVALID_CAC_RESPONSE",
      });
    }

    /*
     * Dojah Basic CAC returns a registration
     * number and registered company information.
     *
     * The provider-independent CAC service
     * currently expects registrationNumber
     * without the RC/BN prefix.
     *
     * Preserve that internal contract.
     *
     * The pre-onboarding CAC model stores the
     * canonical RC/BN-prefixed number.
     */

    const registrationValue =
      registration.prefix === "BN" ? entity.business_number || entity.rc_number : entity.rc_number;

    const rawRegistrationNumber = String(registrationValue || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");

    const registrationMatch = /^(?:(RC|BN))?(\d{4,10})$/.exec(rawRegistrationNumber);

    if (
      !registrationMatch ||
      (registrationMatch[1] && registrationMatch[1] !== registration.prefix) ||
      registrationMatch[2] !== registration.rc_number
    ) {
      throw this.createError({
        message: "Dojah returned a different CAC registration number.",
        code: "DOJAH_REGISTRATION_MISMATCH",
      });
    }

    const entityName = this.normalizeRegistryName(entity.company_name, 150);

    const entityType = String(entity.type_of_company || "")
      .trim()
      .toUpperCase();

    const entityStatus = String(entity.status || "")
      .trim()
      .toUpperCase();

    if (!entityName || !entityType || !entityStatus || entityType !== registration.company_type) {
      throw this.createError({
        message: "Dojah returned incomplete or mismatched CAC information.",
        code: "DOJAH_INVALID_CAC_RESPONSE",
      });
    }

    /*
     * Do not infer that a company is active
     * merely because the registry returned it.
     *
     * The employer verification domain service
     * decides whether entityStatus qualifies
     * as an active registration.
     *
     * Do not request advanced CAC data or
     * expose directors' personal information.
     */

    return {
      registrationNumber: registrationMatch[2],

      entityName,

      entityType,

      entityStatus,

      registrationDate: entity.date_of_registration || null,
    };
  }

  // ───────────────────── CAC REGISTRATION LOOKUP ─────────────────────

  /*
   * GET /api/v1/kyc/cac/basic
   *
   * Requires:
   *
   * - rc_number;
   * - company_type.
   *
   * The lookup returns provider registry evidence,
   * not final employer KYB approval.
   */

  static async lookupCACRegistration({ registrationNumber, reference, httpClient = axios } = {}) {
    this.assertNewVerificationEnabled("cac");

    const registration = this.normalizeCACNumber(registrationNumber);

    const requestReference = this.normalizeReference(reference);

    const params = {
      rc_number: registration.rc_number,

      company_type: registration.company_type,
    };

    let response;

    try {
      response = await this.get(ENDPOINTS.cac, params, "cac", httpClient);
    } catch (error) {
      if (error?.code === "DOJAH_RESOURCE_NOT_FOUND") {
        return {
          provider: "dojah",
          environment: this.getEnvironment(),

          endpoint: ENDPOINTS.cac,

          requestReference,
          providerReference: null,

          registration,

          found: false,
          result: null,
        };
      }

      throw error;
    }

    const result = this.normalizeCACResponse(response.entity, registration);

    return {
      provider: "dojah",
      environment: response.environment,

      endpoint: ENDPOINTS.cac,

      /*
       * Internal request correlation ID.
       *
       * Not a provider-issued reference.
       */

      requestReference,
      providerReference: null,

      registration,

      found: true,

      result,
    };
  }
}

module.exports = DojahVerificationService;
