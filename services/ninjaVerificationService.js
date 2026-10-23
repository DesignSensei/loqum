
 // services/ninjaVerificationService.js

const axios = require("axios");
const crypto = require("crypto");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const NINJA_VERIFICATION_SERVICE_ERROR_NAME = "NinjaVerificationServiceError";

const BASE_URLS = Object.freeze({
  sandbox: "https://api.sandbox.ninja.boucloud.io",
  production: "https://api.ninja.boucloud.io",
});

const ENDPOINTS = Object.freeze({
  identity: "/api/identity/identify",
  cac: "/api/company/lookup",
  hostedKyc: "/api/flows",
  verification: "/api/verifications",
});

class NinjaVerificationService {
  /*
   * NINJA VERIFICATION ADAPTER
   *
   * Responsibilities:
   *
   * - Retrieve authoritative NIN registry names;
   * - Verify NIN details when explicitly required;
   * - Retrieve CAC registration information;
   * - Create hosted identity verification links;
   * - Read hosted verification results;
   * - Validate and parse signed Ninja webhooks.
   *
   * Active identity verification uses NIN only.
   *
   * Registry lookup does not authenticate the
   * identity holder or grant KYC approval.
   *
   * CAC lookup confirms registration information
   * but does not establish representative authority
   * or final employer KYB approval.
   *
   * The identity and CAC domain services own
   * verification persistence, authorization,
   * duplicate prevention and approval policies.
   *
   * No automatic retries or provider fallback.
   *
   * Never return unnecessary registry personal data
   * or log NIN values, photos, credentials or KYC URLs.
   */

  // ───────────────────── ERRORS ─────────────────────

  static createError({
    message,
    code,
    statusCode = 503,
    details = null,
  }) {
    return createServiceError({
      name: NINJA_VERIFICATION_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static normalizeProviderError(error) {
    if (
      error?.name === NINJA_VERIFICATION_SERVICE_ERROR_NAME &&
      typeof error.code === "string" &&
      error.code.startsWith("NINJA_")
    ) {
      return error;
    }

    const status = error?.response?.status;

    if (status === 400 || status === 422) {
      return this.createError({
        message: "The verification request was not accepted.",
        code: "NINJA_INVALID_REQUEST",
        statusCode: 422,
      });
    }

    if (status === 401 || status === 403) {
      return this.createError({
        message: "Ninja API access is unavailable.",
        code: "NINJA_ACCESS_DENIED",
        statusCode: 503,
      });
    }

    if (status === 402) {
      return this.createError({
        message: "Ninja verification wallet requires funding.",
        code: "NINJA_INSUFFICIENT_FUNDS",
        statusCode: 503,
      });
    }

    if (status === 404) {
      return this.createError({
        message: "The requested verification record was not found.",
        code: "NINJA_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (status === 429) {
      return this.createError({
        message: "Ninja API rate limit reached.",
        code: "NINJA_RATE_LIMITED",
        statusCode: 429,
      });
    }

    /*
     * Never expose raw Axios errors.
     *
     * Request configurations may contain credentials,
     * identity numbers, personal details or KYC URLs.
     *
     * A timeout may have occurred after a chargeable
     * request was accepted by the provider.
     *
     * Do not automatically retry.
     */

    return this.createError({
      message: "Ninja verification request failed or timed out.",
      code: "NINJA_PROVIDER_UNAVAILABLE",
      statusCode: 503,
    });
  }

  // ───────────────────── CONFIGURATION ─────────────────────

  static getEnvironment() {
    const environment = String(process.env.NINJA_ENV || "sandbox")
      .trim()
      .toLowerCase();

    if (!Object.hasOwn(BASE_URLS, environment)) {
      throw this.createError({
        message: "Invalid Ninja verification environment.",
        code: "NINJA_INVALID_ENV",
        statusCode: 500,
      });
    }

    if (
      environment === "production" &&
      process.env.NINJA_PRODUCTION_ENABLED !== "true"
    ) {
      throw this.createError({
        message: "Ninja production verification is disabled.",
        code: "NINJA_PRODUCTION_DISABLED",
      });
    }

    return environment;
  }

  static getCredentials(environment) {
    const secretKey = String(process.env.NINJA_SECRET_KEY || "").trim();

    if (!secretKey) {
      throw this.createError({
        message: "Ninja API credentials are not configured.",
        code: "NINJA_NOT_CONFIGURED",
      });
    }

    const expectedPrefix =
      environment === "sandbox" ? "sk_sandbox_" : "sk_";

    if (!secretKey.startsWith(expectedPrefix)) {
      throw this.createError({
        message: "Ninja API key does not match the configured environment.",
        code: "NINJA_KEY_ENVIRONMENT_MISMATCH",
        statusCode: 500,
      });
    }

    if (
      environment === "production" &&
      secretKey.startsWith("sk_sandbox_")
    ) {
      throw this.createError({
        message: "Sandbox credentials cannot be used for production.",
        code: "NINJA_KEY_ENVIRONMENT_MISMATCH",
        statusCode: 500,
      });
    }

    return { secretKey };
  }

  static assertNewVerificationEnabled(type) {
    if (!["identity", "cac"].includes(type)) {
      throw this.createError({
        message: "Invalid verification category.",
        code: "NINJA_INVALID_VERIFICATION_TYPE",
        statusCode: 400,
      });
    }

    if (process.env.VERIFICATION_ENABLED !== "true") {
      throw this.createError({
        message: "New verification requests are disabled.",
        code: "NINJA_VERIFICATION_DISABLED",
      });
    }

    const setting =
      type === "identity"
        ? "IDENTITY_VERIFICATION_PROVIDER"
        : "CAC_VERIFICATION_PROVIDER";

    const selectedProvider = String(process.env[setting] || "")
      .trim()
      .toLowerCase();

    if (selectedProvider !== "ninja") {
      throw this.createError({
        message: "Ninja is not the selected verification provider.",
        code: "NINJA_NOT_SELECTED",
        statusCode: 409,
      });
    }
  }

  static getRequestOptions(environment) {
    const { secretKey } = this.getCredentials(environment);

    /*
     * Ninja's current server-to-server API accepts
     * the environment-specific Secret Key directly
     * as the Bearer credential.
     *
     * Do not expose this key to the frontend.
     */

    return {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },

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

    if (
      !value ||
      value.length > 64 ||
      !/^[A-Za-z0-9_.:-]+$/.test(value)
    ) {
      throw this.createError({
        message: "Invalid verification reference.",
        code: "NINJA_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── HTTP REQUESTS ─────────────────────

  static async post(path, payload, httpClient = axios) {
    const environment = this.getEnvironment();

    if (!httpClient || typeof httpClient.post !== "function") {
      throw this.createError({
        message: "Invalid Ninja HTTP client.",
        code: "NINJA_INVALID_HTTP_CLIENT",
        statusCode: 500,
      });
    }

    const options = this.getRequestOptions(environment);

    try {
      const response = await httpClient.post(
        BASE_URLS[environment] + path,
        payload,
        options
      );

      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        throw {
          response: {
            status: response?.status,
          },
        };
      }

      return {
        environment,
        data: response.data,
      };
    } catch (error) {
      throw this.normalizeProviderError(error);
    }
  }

  static async get(path, httpClient = axios) {
    const environment = this.getEnvironment();

    if (!httpClient || typeof httpClient.get !== "function") {
      throw this.createError({
        message: "Invalid Ninja HTTP client.",
        code: "NINJA_INVALID_HTTP_CLIENT",
        statusCode: 500,
      });
    }

    const options = this.getRequestOptions(environment);

    try {
      const response = await httpClient.get(
        BASE_URLS[environment] + path,
        options
      );

      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        throw {
          response: {
            status: response?.status,
          },
        };
      }

      return {
        environment,
        data: response.data,
      };
    } catch (error) {
      throw this.normalizeProviderError(error);
    }
  }

  // ───────────────────── REGISTRY NAME NORMALIZATION ─────────────────────

  /*
   * Registry names must be taken from trusted
   * provider responses.
   *
   * Do not construct them from user-submitted
   * registration or onboarding details.
   *
   * Never split a combined name into presumed
   * first, middle and last name components.
   */

  static normalizeRegistryName(value, maxLength = 100, optional = false) {
    if (optional && (value == null || value === "")) {
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
   * Loqum currently supports NIN-only identity
   * verification for professionals.
   *
   * BVN, passport, driver's licence and VIN
   * are not enabled in the active workflow.
   */

  static normalizeIdentityType(method) {
    const value = String(method || "").trim().toLowerCase();

    if (value !== "nin") {
      throw this.createError({
        message: "Only NIN verification is supported.",
        code: "NINJA_UNSUPPORTED_IDENTITY_TYPE",
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
        code: "NINJA_INVALID_IDENTITY_NUMBER",
        statusCode: 400,
      });
    }

    return value;
  }

  // ───────────────────── NIN REGISTRY LOOKUP ─────────────────────

  /*
   * POST /api/identity/identify
   *
   * mode: lookup
   *
   * Retrieves the authoritative legal-name
   * components supplied by the NIN registry.
   *
   * The adapter validates:
   *
   * - Registry lookup outcome;
   * - Returned identity type;
   * - Returned identifier;
   * - First name;
   * - Optional middle name;
   * - Last name.
   *
   * Only minimal name evidence is returned.
   *
   * Raw NIN, photo, date of birth, address,
   * phone number and other registry personal
   * information are not returned.
   *
   * A found record is not identity-holder
   * authentication or final KYC approval.
   */

  static normalizeIdentityLookupResponse(payload, requestedNIN) {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw this.createError({
        message: "Ninja returned an invalid NIN lookup response.",
        code: "NINJA_INVALID_NIN_LOOKUP_RESPONSE",
      });
    }

    if (payload.status === "not_found") {
      if (payload.data != null) {
        throw this.createError({
          message: "Ninja returned inconsistent NIN lookup information.",
          code: "NINJA_INCONSISTENT_NIN_LOOKUP",
        });
      }

      return {
        found: false,
        registryFound: false,
        status: "not_found",
        registryLegalName: null,
        nameOnRecord: null,
        holderAuthenticated: false,
      };
    }

    if (
      payload.status !== "found" ||
      !payload.data ||
      typeof payload.data !== "object" ||
      Array.isArray(payload.data)
    ) {
      throw this.createError({
        message: "Ninja did not return a valid registry result.",
        code: "NINJA_INVALID_NIN_LOOKUP_RESPONSE",
      });
    }

    const data = payload.data;

    const returnedNIN = String(data.id_number || "").trim();

    const returnedType = String(data.type || "")
      .trim()
      .toLowerCase();

    if (
      returnedType !== "nin" ||
      returnedNIN !== requestedNIN
    ) {
      throw this.createError({
        message: "NIN registry response does not match the requested identity.",
        code: "NINJA_NIN_RESPONSE_MISMATCH",
      });
    }

    const firstName = this.normalizeRegistryName(
      data.first_name,
      100
    );

    const middleName = this.normalizeRegistryName(
      data.middle_name,
      100,
      true
    );

    const lastName = this.normalizeRegistryName(
      data.last_name,
      100
    );

    if (!firstName || !lastName || middleName === null) {
      throw this.createError({
        message: "NIN registry legal-name evidence is incomplete.",
        code: "NINJA_NIN_NAME_INCOMPLETE",
      });
    }

    const nameOnRecord = [
      firstName,
      middleName,
      lastName,
    ]
      .filter(Boolean)
      .join(" ");

    if (nameOnRecord.length > 150) {
      throw this.createError({
        message: "NIN registry legal name requires additional review.",
        code: "NINJA_NIN_NAME_TOO_LONG",
      });
    }

    return {
      found: true,
      registryFound: true,
      status: "found",

      registryLegalName: {
        firstName,
        middleName,
        lastName,
      },

      nameOnRecord,

      /*
       * A registry record does not authenticate
       * the person submitting the NIN.
       */

      holderAuthenticated: false,
    };
  }

  static async lookupIdentityRecord({
    method = "nin",
    identifier,
    reference,
    httpClient = axios,
  } = {}) {
    this.assertNewVerificationEnabled("identity");

    const idType = this.normalizeIdentityType(method);

    const idNumber = this.normalizeIdentityNumber(identifier);

    const requestReference = this.normalizeReference(reference);

    /*
     * Basic-level lookup is sufficient for
     * legal-name prepopulation.
     *
     * It avoids requesting unnecessary advanced
     * personal information or registry photos.
     */

    const response = await this.post(
      ENDPOINTS.identity,
      {
        idType,
        mode: "lookup",
        level: "basic",
        idNumber,
        reference: requestReference,
      },
      httpClient
    );

    const normalized = this.normalizeIdentityLookupResponse(
      response.data,
      idNumber
    );

    return {
      provider: "ninja",
      environment: response.environment,

      endpoint: ENDPOINTS.identity,

      method: idType,

      reference: requestReference,
      requestReference,

      /*
       * Ninja's documented lookup response does
       * not guarantee a separate provider-issued
       * verification reference.
       */

      providerReference: null,

      ...normalized,
    };
  }

  // ───────────────────── NIN DETAIL VERIFICATION ─────────────────────

  /*
   * mode: verify
   *
   * Retained as a separate operation for workflows
   * that explicitly need to compare known details
   * against a registry record.
   *
   * This operation DOES NOT return the registered
   * first, middle or last names.
   *
   * It must not be used to establish authoritative
   * legal-name prepopulation.
   *
   * Initial professional onboarding must use
   * lookupIdentityRecord instead.
   *
   * Matching known details is not proof that
   * the applicant owns the identity.
   */

  static normalizeDateOfBirth(value) {
    if (!value) {
      return null;
    }

    const dob = String(value).trim();

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
      Number.isNaN(Date.parse(dob)) ||
      new Date(dob).toISOString().slice(0, 10) !== dob
    ) {
      throw this.createError({
        message: "Date of birth must be a valid YYYY-MM-DD date.",
        code: "NINJA_INVALID_DATE_OF_BIRTH",
        statusCode: 400,
      });
    }

    return dob;
  }

  static async verifyIdentityDetails({
    method,
    identifier,
    firstName,
    lastName,
    dateOfBirth,
    reference,
    httpClient = axios,
  } = {}) {
    this.assertNewVerificationEnabled("identity");

    const idType = this.normalizeIdentityType(method);

    const idNumber = this.normalizeIdentityNumber(identifier);

    const givenName = this.normalizeRegistryName(firstName, 100);

    const familyName = this.normalizeRegistryName(lastName, 100);

    if (!givenName || !familyName) {
      throw this.createError({
        message: "First name and last name are required.",
        code: "NINJA_MISSING_IDENTITY_NAME",
        statusCode: 400,
      });
    }

    const payload = {
      idType,
      mode: "verify",
      idNumber,
      firstName: givenName,
      lastName: familyName,
      reference: this.normalizeReference(reference),
    };

    const dob = this.normalizeDateOfBirth(dateOfBirth);

    if (dob) {
      payload.dateOfBirth = dob;
    }

    const response = await this.post(
      ENDPOINTS.identity,
      payload,
      httpClient
    );

    const result = response.data;

    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      typeof result.found !== "boolean" ||
      typeof result.verified !== "boolean" ||
      (result.verified && !result.found)
    ) {
      throw this.createError({
        message: "Ninja returned an invalid identity verification response.",
        code: "NINJA_INVALID_IDENTITY_RESPONSE",
      });
    }

    return {
      provider: "ninja",
      environment: response.environment,

      reference: payload.reference,
      method: idType,

      registryFound: result.found,
      detailsMatched: result.verified,

      recommendation:
        String(result.recommendation || "")
          .trim()
          .toLowerCase() || null,

      score:
        typeof result.score === "number" &&
        Number.isFinite(result.score) &&
        result.score >= 0 &&
        result.score <= 1
          ? result.score
          : null,

      /*
       * Matching registry details does not
       * authenticate the identity holder.
       */

      holderAuthenticated: false,
    };
  }

  // ───────────────────── CAC REGISTRATION ─────────────────────

  /*
   * CAC lookup retrieves the registered legal
   * business name and registration details.
   *
   * No user-entered business name is required
   * or submitted to Ninja.
   *
   * RC registrations are supported.
   *
   * BN support is not enabled for this adapter
   * until its request contract is confirmed.
   */

  static normalizeCACNumber(value) {
    const clean = String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");

    if (clean.startsWith("BN")) {
      throw this.createError({
        message: "BN registration lookup is not supported by this Ninja integration.",
        code: "NINJA_BN_NOT_CONFIRMED",
        statusCode: 422,
      });
    }

    const match = /^(?:RC)?(\d{4,10})$/.exec(clean);

    if (!match) {
      throw this.createError({
        message: "Enter a valid CAC RC registration number.",
        code: "NINJA_INVALID_CAC_NUMBER",
        statusCode: 400,
      });
    }

    return {
      submitted: `RC${match[1]}`,
      prefix: "RC",
      rc_number: match[1],
    };
  }

  // ───────────────────── CAC RESPONSE NORMALIZATION ─────────────────────

  static normalizeCACResponse(payload, requestedNumber) {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw this.createError({
        message: "Ninja returned an invalid CAC response.",
        code: "NINJA_INVALID_CAC_RESPONSE",
      });
    }

    if (payload.status === "not_found") {
      if (payload.data != null) {
        throw this.createError({
          message: "Ninja returned inconsistent CAC lookup information.",
          code: "NINJA_INCONSISTENT_CAC_LOOKUP",
        });
      }

      return {
        found: false,
        result: null,
      };
    }

    if (
      payload.status !== "found" ||
      !payload.data ||
      typeof payload.data !== "object" ||
      Array.isArray(payload.data)
    ) {
      throw this.createError({
        message: "Ninja returned an invalid CAC response.",
        code: "NINJA_INVALID_CAC_RESPONSE",
      });
    }

    const data = payload.data;

    const rawRegistrationNumber = String(
      data.registration_number || ""
    )
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");

    const match = /^(?:RC)?(\d{4,10})$/.exec(
      rawRegistrationNumber
    );

    const entityName = this.normalizeRegistryName(
      data.name,
      150
    );

    const entityType = String(data.company_type || "")
      .trim()
      .toUpperCase();

    const entityStatus = String(data.status || "")
      .trim()
      .toUpperCase();

    if (
      !match ||
      match[1] !== requestedNumber ||
      !entityName ||
      !entityType ||
      !entityStatus
    ) {
      throw this.createError({
        message:
          "CAC registry information is incomplete or does not match the request.",
        code: "NINJA_CAC_RESPONSE_MISMATCH",
      });
    }

    /*
     * Preserve the provider-independent domain
     * contract currently used by CACVerificationService.
     *
     * registrationNumber contains the numeric
     * portion of the RC registration.
     *
     * The CAC domain/pre-onboarding services
     * will persist the canonical RC-prefixed
     * registration number where required.
     *
     * Preserve the detailed company classification.
     *
     * Do not return directors, addresses,
     * shareholders or other unnecessary data.
     */

    return {
      found: true,

      result: {
        registrationNumber: match[1],

        entityName,
        entityType,
        entityStatus,

        registrationDate: null,
      },
    };
  }

  // ───────────────────── CAC LOOKUP ─────────────────────

  static async lookupRegistration({
    registrationNumber,
    reference,
    httpClient = axios,
  } = {}) {
    this.assertNewVerificationEnabled("cac");

    const registration = this.normalizeCACNumber(
      registrationNumber
    );

    const requestReference = this.normalizeReference(reference);

    const response = await this.post(
      ENDPOINTS.cac,
      {
        rc_number: registration.rc_number,
        reference: requestReference,
      },
      httpClient
    );

    const normalized = this.normalizeCACResponse(
      response.data,
      registration.rc_number
    );

    return {
      provider: "ninja",
      environment: response.environment,

      endpoint: ENDPOINTS.cac,

      /*
       * Internal correlation ID.
       * Not a provider-issued transaction ID.
       */

      reference: requestReference,
      requestReference,
      providerReference: null,

      registration,

      ...normalized,
    };
  }

  // ───────────────────── HOSTED KYC ─────────────────────

  /*
   * Hosted KYC is separate from NIN registry
   * legal-name prepopulation.
   *
   * The flow is used for identity-holder
   * verification and any configured biometric
   * checks.
   *
   * Trusted services must provide names
   * already established from registry evidence.
   *
   * Hosted KYC completion alone must not
   * automatically grant professional approval.
   */

  static getKycFlowId() {
    const flowId = String(
      process.env.NINJA_KYC_FLOW_ID || ""
    ).trim();

    if (!/^vf_[A-Za-z0-9_-]+$/.test(flowId)) {
      throw this.createError({
        message: "Ninja KYC flow is not configured.",
        code: "NINJA_KYC_FLOW_NOT_CONFIGURED",
      });
    }

    return flowId;
  }

  // ───────────────────── CREATE HOSTED VERIFICATION LINK ─────────────────────

  static async createHostedIdentityLink({
    customerReference,
    firstName,
    lastName,
    email,
    httpClient = axios,
  } = {}) {
    this.assertNewVerificationEnabled("identity");

    const first = this.normalizeRegistryName(firstName, 100);

    const last = this.normalizeRegistryName(lastName, 100);

    const customerEmail = String(email || "").trim();

    if (
      !first ||
      !last ||
      !customerEmail ||
      customerEmail.length > 254
    ) {
      throw this.createError({
        message: "Name and email are required for hosted identity verification.",
        code: "NINJA_INCOMPLETE_KYC_REQUEST",
        statusCode: 400,
      });
    }

    const flowId = this.getKycFlowId();

    const customerRef = this.normalizeReference(
      customerReference
    );

    const response = await this.post(
      `${ENDPOINTS.hostedKyc}/${flowId}/links`,
      {
        customer_name: `${first} ${last}`,
        customer_email: customerEmail,
        customer_ref: customerRef,

        values: {
          first_name: first,
          last_name: last,
        },
      },
      httpClient
    );

    const data = response.data;

    if (
      !data ||
      typeof data.id !== "string" ||
      !/^vs_[A-Za-z0-9_-]+$/.test(data.id) ||
      typeof data.url !== "string" ||
      typeof data.sandbox !== "boolean" ||
      data.sandbox !== (response.environment === "sandbox")
    ) {
      throw this.createError({
        message: "Ninja returned an invalid hosted verification link.",
        code: "NINJA_INVALID_KYC_LINK",
      });
    }

    /*
     * Hosted verification URLs are sensitive.
     *
     * Validate the provider destination and
     * never log the URL.
     */

    let linkUrl;

    try {
      linkUrl = new URL(data.url);
    } catch (_) {
      throw this.createError({
        message: "Ninja returned an invalid verification URL.",
        code: "NINJA_INVALID_KYC_URL",
      });
    }

    if (
      linkUrl.protocol !== "https:" ||
      !["www.ninja.ng", "ninja.ng"].includes(
        linkUrl.hostname
      ) ||
      !linkUrl.pathname.startsWith("/kyc/") ||
      linkUrl.username ||
      linkUrl.password ||
      linkUrl.port
    ) {
      throw this.createError({
        message: "Ninja verification URL failed validation.",
        code: "NINJA_UNTRUSTED_KYC_URL",
      });
    }

    return {
      provider: "ninja",
      environment: response.environment,

      verificationId: data.id,

      customerReference: customerRef,
      flowId,

      verificationUrl: data.url,
      expiresAt: data.expires_at || null,

      status: "pending",
    };
  }

  // ───────────────────── HOSTED RESULT SYNCHRONIZATION ─────────────────────

  static async getHostedIdentityResult({
    verificationId,
    httpClient = axios,
  } = {}) {
    const id = String(verificationId || "").trim();

    if (!/^vs_[A-Za-z0-9_-]+$/.test(id)) {
      throw this.createError({
        message: "Invalid hosted verification ID.",
        code: "NINJA_INVALID_VERIFICATION_ID",
        statusCode: 400,
      });
    }

    /*
     * Existing verification results may be read
     * even when new verification requests are disabled.
     *
     * The identity domain service must independently
     * validate the original provider, environment,
     * verification ID, flow ID and customer reference.
     */

    const response = await this.get(
      `${ENDPOINTS.verification}/${id}`,
      httpClient
    );

    const data = response.data;

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.sandbox !== "boolean" ||
      data.sandbox !== (response.environment === "sandbox")
    ) {
      throw this.createError({
        message: "Ninja returned an invalid verification result.",
        code: "NINJA_INVALID_VERIFICATION_RESULT",
      });
    }

    return {
      provider: "ninja",
      environment: response.environment,

      verificationId: id,

      status: data.status || null,
      outcome: data.outcome || null,

      sandbox: data.sandbox,

      flowId: data.flow_id || null,

      customerReference:
        data.customer_ref || null,

      /*
       * These scores are informational.
       *
       * A completed session without trusted
       * selfie/liveness evidence must not be
       * treated as holder authentication.
       */

      score:
        typeof data.score === "number" &&
        Number.isFinite(data.score)
          ? data.score
          : null,

      faceScore:
        typeof data.face_score === "number" &&
        Number.isFinite(data.face_score)
          ? data.face_score
          : null,
    };
  }

  // ───────────────────── SIGNED WEBHOOKS ─────────────────────

  static verifyWebhookSignature({
    rawBody,
    signature,
    secret,
  } = {}) {
    if (
      !Buffer.isBuffer(rawBody) ||
      !signature ||
      typeof secret !== "string" ||
      !secret
    ) {
      return false;
    }

    const expected =
      "hmac-sha256=" +
      crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

    const receivedBuffer = Buffer.from(
      String(signature),
      "utf8"
    );

    const expectedBuffer = Buffer.from(
      expected,
      "utf8"
    );

    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    );
  }

  // ───────────────────── PARSE HOSTED KYC WEBHOOK ─────────────────────

  static parseHostedIdentityWebhook({
    rawBody,
    signature,
    secret,
  } = {}) {
    if (
      !this.verifyWebhookSignature({
        rawBody,
        signature,
        secret,
      })
    ) {
      throw this.createError({
        message: "Invalid Ninja webhook signature.",
        code: "NINJA_INVALID_WEBHOOK_SIGNATURE",
        statusCode: 401,
      });
    }

    let event;

    try {
      event = JSON.parse(
        rawBody.toString("utf8")
      );
    } catch (_) {
      throw this.createError({
        message: "Invalid Ninja webhook payload.",
        code: "NINJA_INVALID_WEBHOOK_PAYLOAD",
        statusCode: 400,
      });
    }

    if (
      event?.event !== "verification.completed" ||
      typeof event.event_id !== "string" ||
      !event.event_id ||
      typeof event.data?.verification_id !== "string" ||
      !event.data.verification_id ||
      typeof event.data.flow_id !== "string" ||
      !event.data.flow_id ||
      typeof event.data.customer_ref !== "string" ||
      !event.data.customer_ref ||
      typeof event.data.sandbox !== "boolean"
    ) {
      throw this.createError({
        message: "Incomplete Ninja verification event.",
        code: "NINJA_INCOMPLETE_WEBHOOK",
        statusCode: 400,
      });
    }

    const method = String(
      event.data.id_type || ""
    )
      .trim()
      .toLowerCase();

    /*
     * The active Loqum professional workflow
     * supports NIN-only identity verification.
     */

    if (method !== "nin") {
      throw this.createError({
        message: "Unsupported Ninja identity verification method.",
        code: "NINJA_UNSUPPORTED_WEBHOOK_IDENTITY_TYPE",
        statusCode: 422,
      });
    }

    /*
     * Signature validation authenticates the
     * message source but does not approve the
     * professional.
     *
     * The webhook processor must:
     *
     * - Deduplicate event IDs;
     * - Locate the existing verification;
     * - Match provider and environment;
     * - Match verification, flow and customer IDs;
     * - Validate the final outcome;
     * - Require trusted biometric evidence;
     * - Apply approval rules transactionally.
     *
     * Sandbox events cannot approve production
     * identity verification.
     */

    return {
      provider: "ninja",

      eventId: String(event.event_id),
      eventType: String(event.event),

      verificationId:
        String(event.data.verification_id),

      flowId:
        String(event.data.flow_id),

      customerReference:
        String(event.data.customer_ref),

      status:
        String(event.data.status || ""),

      outcome:
        String(event.data.outcome || ""),

      method,

      sandbox: event.data.sandbox,

      score:
        typeof event.data.score === "number" &&
        Number.isFinite(event.data.score)
          ? event.data.score
          : null,

      faceScore:
        typeof event.data.face_score === "number" &&
        Number.isFinite(event.data.face_score)
          ? event.data.face_score
          : null,
    };
  }
}

module.exports = NinjaVerificationService;
