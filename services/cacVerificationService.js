// services/cacVerificationService.js

const { randomUUID } = require("crypto");

const { createServiceError } = require("./helpers/serviceErrorHelper");

const NinjaVerificationService = require("./ninjaVerificationService");
const DojahVerificationService = require("./dojahVerificationService");

const CAC_VERIFICATION_SERVICE_ERROR_NAME = "CACVerificationServiceError";

const SUPPORTED_PROVIDERS = Object.freeze({
  ninja: NinjaVerificationService,
  dojah: DojahVerificationService,
});

class CACVerificationService {
  /*
   * CAC VERIFICATION ARCHITECTURE
   *
   * Provider-independent coordinator for Nigerian
   * CAC registration verification.
   *
   * RESPONSIBILITIES
   *
   * - Select the configured CAC provider.
   * - Validate RC and BN registration numbers.
   * - Enforce provider-specific capabilities.
   * - Normalize provider environments.
   * - Invoke the selected provider adapter.
   * - Normalize registration evidence.
   * - Translate provider errors into CAC errors.
   *
   * NOT RESPONSIBLE FOR
   *
   * - Employer onboarding or approval.
   * - Registered business name matching.
   * - Company eligibility decisions.
   * - KYC record persistence.
   * - Administrative review.
   * - Marketplace eligibility.
   * - Provider billing.
   *
   * EmployerVerificationService owns the domain
   * decisions and consumes the evidence returned here.
   *
   * PROVIDER POLICY
   *
   * Ninja:
   * - RC lookup supported.
   * - BN lookup blocked until confirmed.
   *
   * Dojah:
   * - RC and BN lookup supported by its CAC adapter.
   *
   * Provider selection is configuration-driven.
   *
   * There is no automatic fallback and no automatic
   * retry of potentially chargeable requests.
   */

  // ───────────────────────── ERRORS ─────────────────────────

  static createError({ message, code, statusCode = 503, details = null }) {
    return createServiceError({
      name: CAC_VERIFICATION_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static normalizeProviderError(error, provider) {
    /*
     * Preserve errors already created by this service.
     */

    if (
      error?.name === CAC_VERIFICATION_SERVICE_ERROR_NAME &&
      typeof error.code === "string" &&
      error.code.startsWith("CAC_")
    ) {
      return error;
    }

    const code = String(error?.code || "");

    /*
     * Configuration and production safety failures.
     */

    if (
      [
        "NINJA_NOT_CONFIGURED",
        "DOJAH_NOT_CONFIGURED",
        "NINJA_PRODUCTION_DISABLED",
        "DOJAH_PRODUCTION_DISABLED",
        "NINJA_INVALID_ENV",
        "NINJA_KEY_ENVIRONMENT_MISMATCH",
      ].includes(code)
    ) {
      return this.createError({
        message: "CAC provider is not configured for this environment.",
        code: "CAC_NOT_CONFIGURED",
        statusCode: 503,
      });
    }

    /*
     * Provider selection mismatch.
     */

    if (["NINJA_NOT_SELECTED", "DOJAH_NOT_SELECTED"].includes(code)) {
      return this.createError({
        message: "Selected CAC provider does not match its configuration.",
        code: "CAC_PROVIDER_MISMATCH",
        statusCode: 409,
      });
    }

    /*
     * Disabled verification requests.
     */

    if (
      [
        "NINJA_VERIFICATION_DISABLED",
        "DOJAH_VERIFICATION_DISABLED",
        "VERIFICATION_DISABLED",
      ].includes(code)
    ) {
      return this.createError({
        message: "New CAC verification requests are disabled.",
        code: "CAC_VERIFICATION_DISABLED",
        statusCode: 503,
      });
    }

    /*
     * Invalid request reference.
     */

    if (["NINJA_INVALID_REFERENCE", "DOJAH_INVALID_REFERENCE"].includes(code)) {
      return this.createError({
        message: "Invalid CAC verification reference.",
        code: "CAC_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    /*
     * Unsupported registration type.
     */

    if (code === "NINJA_BN_NOT_CONFIRMED") {
      return this.createError({
        message: "Selected provider does not support this registration type.",
        code: "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE",
        statusCode: 422,
      });
    }

    /*
     * Invalid registration number.
     */

    if (["NINJA_INVALID_CAC_NUMBER", "DOJAH_INVALID_CAC_NUMBER"].includes(code)) {
      return this.createError({
        message: "A valid CAC registration number is required.",
        code: "CAC_UNSUPPORTED_REGISTRATION_FORMAT",
        statusCode: 400,
      });
    }

    /*
     * Rejected provider request.
     */

    if (["NINJA_INVALID_REQUEST", "DOJAH_INVALID_REQUEST"].includes(code)) {
      return this.createError({
        message: "CAC provider rejected the verification request.",
        code: "CAC_INVALID_REQUEST",
        statusCode: 422,
      });
    }

    /*
     * Provider access failure.
     */

    if (["NINJA_ACCESS_DENIED", "DOJAH_ACCESS_DENIED"].includes(code)) {
      return this.createError({
        message: "CAC provider authorization failed.",
        code: "CAC_PROVIDER_ACCESS_DENIED",
        statusCode: 503,
      });
    }

    /*
     * Provider wallet funding failure.
     */

    if (["NINJA_INSUFFICIENT_FUNDS", "DOJAH_INSUFFICIENT_FUNDS"].includes(code)) {
      return this.createError({
        message: "CAC verification wallet requires funding.",
        code: "CAC_INSUFFICIENT_FUNDS",
        statusCode: 503,
      });
    }

    /*
     * Provider rate limiting.
     *
     * Retryability is informational metadata.
     * This service never automatically retries.
     */

    if (["NINJA_RATE_LIMITED", "DOJAH_RATE_LIMITED"].includes(code)) {
      return this.createError({
        message: "CAC provider rate limit reached.",
        code: "CAC_RATE_LIMITED",
        statusCode: 429,
        details: {
          retryable: true,
        },
      });
    }

    /*
     * Confirmed registration number mismatch.
     */

    if (code === "DOJAH_REGISTRATION_MISMATCH") {
      return this.createError({
        message: "CAC provider returned a different registration number.",
        code: "CAC_REGISTRATION_MISMATCH",
        statusCode: 502,
      });
    }

    /*
     * Invalid, incomplete or mismatched response.
     *
     * Ninja's CAC response mismatch code may indicate
     * missing required fields as well as number mismatch.
     * Do not incorrectly classify every such failure
     * as a registration-number mismatch.
     */

    if (
      [
        "NINJA_CAC_RESPONSE_MISMATCH",
        "NINJA_INVALID_CAC_RESPONSE",
        "DOJAH_INVALID_CAC_RESPONSE",
        "DOJAH_COMPANY_TYPE_MISMATCH",
        "NINJA_INVALID_RESPONSE",
        "DOJAH_INVALID_RESPONSE",
      ].includes(code)
    ) {
      return this.createError({
        message: "CAC provider returned invalid verification information.",
        code: "CAC_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    /*
     * HTTP client configuration.
     */

    if (["NINJA_INVALID_HTTP_CLIENT", "DOJAH_INVALID_HTTP_CLIENT"].includes(code)) {
      return this.createError({
        message: "CAC provider HTTP client is not configured correctly.",
        code: "CAC_PROVIDER_CONFIGURATION_ERROR",
        statusCode: 500,
      });
    }

    /*
     * Remaining failures are treated as unavailable.
     *
     * A provider HTTP 404 does not automatically mean
     * that the company is absent from the CAC registry.
     *
     * Only explicit normalized found === false
     * confirms a not-found lookup outcome.
     *
     * Never expose raw Axios errors, credentials,
     * authorization headers or provider payloads.
     */

    return this.createError({
      message: "CAC verification provider is unavailable.",
      code: "CAC_PROVIDER_UNAVAILABLE",
      statusCode: 503,
    });
  }

  // ───────────────────── PROVIDER CONFIGURATION ─────────────────────

  static getProvider() {
    const provider = String(process.env.CAC_VERIFICATION_PROVIDER || "")
      .trim()
      .toLowerCase();

    if (!Object.hasOwn(SUPPORTED_PROVIDERS, provider)) {
      throw this.createError({
        message: "A supported CAC verification provider must be configured.",
        code: "CAC_INVALID_PROVIDER",
        statusCode: 503,
      });
    }

    return provider;
  }

  static getAdapter(provider = this.getProvider()) {
    if (!Object.hasOwn(SUPPORTED_PROVIDERS, provider)) {
      throw this.createError({
        message: "Unsupported CAC verification provider.",
        code: "CAC_INVALID_PROVIDER",
        statusCode: 503,
      });
    }

    return SUPPORTED_PROVIDERS[provider];
  }

  static getEnvironment(provider = this.getProvider()) {
    const adapter = this.getAdapter(provider);

    if (typeof adapter.getEnvironment !== "function") {
      throw this.createError({
        message: "Selected CAC provider has no environment configuration.",
        code: "CAC_PROVIDER_CONFIGURATION_ERROR",
        statusCode: 503,
      });
    }

    let environment;

    try {
      environment = adapter.getEnvironment();
    } catch (error) {
      throw this.normalizeProviderError(error, provider);
    }

    /*
     * Provider adapters return sandbox/production.
     *
     * KYC records use staging/production.
     */

    if (environment === "sandbox" || environment === "staging") {
      return "staging";
    }

    if (environment === "production") {
      return "production";
    }

    throw this.createError({
      message: "Invalid CAC provider environment.",
      code: "CAC_INVALID_ENVIRONMENT",
      statusCode: 503,
    });
  }

  static assertVerificationEnabled() {
    if (process.env.VERIFICATION_ENABLED !== "true") {
      throw this.createError({
        message: "New CAC verification requests are disabled.",
        code: "CAC_VERIFICATION_DISABLED",
        statusCode: 503,
      });
    }
  }

  // ───────────────────── REGISTRATION VALIDATION ─────────────────────

  static normalizeRegistrationNumber(input) {
    const clean = (typeof input === "string" ? input : "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");

    const match = /^(RC|BN)(\d{4,10})$/.exec(clean);

    if (!match) {
      throw this.createError({
        message: "A valid RC or BN registration number is required.",
        code: "CAC_UNSUPPORTED_REGISTRATION_FORMAT",
        statusCode: 400,
      });
    }

    return {
      submitted: `${match[1]}${match[2]}`,
      prefix: match[1],
      rc_number: match[2],
    };
  }

  static assertProviderSupportsRegistration(provider, registration) {
    /*
     * Ninja currently supports the RC lookup flow.
     *
     * Do not assume BN support for Ninja until its
     * provider contract has been confirmed.
     *
     * Dojah supports RC and BN in its configured
     * CAC Basic lookup adapter.
     */

    if (provider === "ninja" && registration.prefix === "BN") {
      throw this.createError({
        message: "Automatic BN lookup is not confirmed for Ninja.",
        code: "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE",
        statusCode: 422,
      });
    }
  }

  static normalizeEvidenceText(value, maxLength) {
    if (value == null || value === "") return "";

    if (
      typeof value !== "string" ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      value.trim().length > maxLength
    ) {
      throw this.createError({
        message: "CAC provider returned invalid registration data.",
        code: "CAC_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    return value.trim();
  }

  static normalizeRequestReference(reference) {
    if (reference == null || reference === "") return randomUUID();

    if (typeof reference !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(reference.trim())) {
      throw this.createError({
        message: "Invalid CAC verification reference.",
        code: "CAC_INVALID_REFERENCE",
        statusCode: 400,
      });
    }

    return reference.trim();
  }

  // ───────────────────── RESPONSE NORMALIZATION ─────────────────────

  static normalizeProviderResponse(lookup, registration, provider, expectedEnvironment) {
    if (!lookup || typeof lookup !== "object" || Array.isArray(lookup)) {
      throw this.createError({
        message: "CAC provider returned an invalid response.",
        code: "CAC_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    if (lookup.provider !== provider) {
      throw this.createError({
        message: "CAC provider response does not match the selected provider.",
        code: "CAC_PROVIDER_MISMATCH",
        statusCode: 502,
      });
    }

    const responseEnvironment = lookup.environment === "sandbox" ? "staging" : lookup.environment;

    if (responseEnvironment !== expectedEnvironment) {
      throw this.createError({
        message: "CAC provider response environment mismatch.",
        code: "CAC_ENVIRONMENT_MISMATCH",
        statusCode: 502,
      });
    }

    /*
     * Only an explicitly confirmed absence is treated
     * as a CAC company-not-found result.
     */

    if (lookup.found === false && lookup.result != null) {
      throw this.createError({
        message: "CAC provider returned a contradictory lookup outcome.",
        code: "CAC_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    if (lookup.found === false) {
      throw this.createError({
        message: "No matching CAC registration was found.",
        code: "CAC_COMPANY_NOT_FOUND",
        statusCode: 404,
      });
    }

    if (lookup.found !== true) {
      throw this.createError({
        message: "CAC provider did not confirm the lookup outcome.",
        code: "CAC_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    const result = lookup.result;

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw this.createError({
        message: "CAC provider returned incomplete registration data.",
        code: "CAC_INCOMPLETE_RESPONSE",
        statusCode: 502,
      });
    }

    const reportedNumber =
      typeof result.registrationNumber === "string"
        ? result.registrationNumber.trim().toUpperCase().replace(/[\s-]/g, "")
        : "";
    const numberMatch = /^(RC|BN)?(\d{4,10})$/.exec(reportedNumber);
    const registrationNumber = numberMatch?.[2];

    const entityName = this.normalizeEvidenceText(result.entityName, 150);
    const entityType = this.normalizeEvidenceText(result.entityType, 150).toUpperCase();
    const entityStatus = this.normalizeEvidenceText(result.entityStatus, 100).toUpperCase();
    const registrationDate =
      result.registrationDate == null || result.registrationDate === ""
        ? null
        : this.normalizeEvidenceText(result.registrationDate, 100);

    /*
     * Registration numbers must match exactly.
     *
     * Leading zeroes are preserved.
     */

    if (
      !numberMatch ||
      (numberMatch[1] && numberMatch[1] !== registration.prefix) ||
      registrationNumber !== registration.rc_number
    ) {
      throw this.createError({
        message: "CAC returned a different registration number.",
        code: "CAC_REGISTRATION_MISMATCH",
        statusCode: 502,
      });
    }

    if (!entityName || !entityType || !entityStatus) {
      throw this.createError({
        message: "CAC returned incomplete company information.",
        code: "CAC_INCOMPLETE_RESPONSE",
        statusCode: 502,
      });
    }

    /*
     * Return normalized registry evidence only.
     *
     * EmployerVerificationService determines:
     *
     * - representative authority checks;
     * - registration type matching;
     * - active/inactive status;
     * - verification eligibility;
     * - employer administrative approval.
     *
     * Directors' personal data and unrelated provider
     * response fields are intentionally excluded.
     */

    return {
      registrationNumber: registration.submitted,
      entityName,
      entityType,
      entityStatus,
      registrationDate,
    };
  }

  // ───────────────────────── CAC LOOKUP ─────────────────────────

  static async lookupRegistration({ registrationNumber, reference, httpClient, fetchImpl } = {}) {
    this.assertVerificationEnabled();

    /*
     * Provider selection is explicit.
     *
     * Changing CAC_VERIFICATION_PROVIDER determines
     * which adapter performs the lookup.
     *
     * There is no automatic fallback.
     */

    const provider = this.getProvider();

    const registration = this.normalizeRegistrationNumber(registrationNumber);

    this.assertProviderSupportsRegistration(provider, registration);

    /*
     * Fail closed if an outdated caller supplies
     * the old fetchImpl dependency.
     *
     * Do not silently ignore it and accidentally
     * perform a live, chargeable lookup.
     *
     * Remove this compatibility guard after all
     * callers have migrated to httpClient.
     */

    if (fetchImpl !== undefined) {
      throw this.createError({
        message: "Legacy fetchImpl injection is no longer supported. Use httpClient.",
        code: "CAC_LEGACY_CLIENT_UNSUPPORTED",
        statusCode: 400,
      });
    }

    /*
     * Resolve the environment for the selected provider.
     */

    const requestReference = this.normalizeRequestReference(reference);
    const environment = this.getEnvironment(provider);
    const adapter = this.getAdapter(provider);

    const method = provider === "ninja" ? "lookupRegistration" : "lookupCACRegistration";

    if (typeof adapter[method] !== "function") {
      throw this.createError({
        message: "Selected CAC provider adapter is not implemented.",
        code: "CAC_PROVIDER_NOT_READY",
        statusCode: 503,
      });
    }

    /*
     * Adapter owns credentials, provider HTTP calls,
     * timeout configuration and API-specific responses.
     */

    let lookup;

    try {
      lookup = await adapter[method]({
        registrationNumber: registration.submitted,

        reference: requestReference,

        ...(httpClient !== undefined ? { httpClient } : {}),
      });
    } catch (error) {
      throw this.normalizeProviderError(error, provider);
    }

    /*
     * Validate provider and environment consistency.
     * Never automatically retry a failed lookup.
     */

    if (
      !lookup ||
      typeof lookup !== "object" ||
      Array.isArray(lookup) ||
      (lookup.requestReference == null && lookup.reference == null) ||
      (lookup.requestReference != null && lookup.requestReference !== requestReference) ||
      (lookup.reference != null && lookup.reference !== requestReference)
    ) {
      throw this.createError({
        message: "CAC provider returned an invalid request reference.",
        code: "CAC_INVALID_RESPONSE",
        statusCode: 502,
      });
    }

    const result = this.normalizeProviderResponse(lookup, registration, provider, environment);

    /*
     * Internal request reference:
     *
     * Created or supplied by Loqum for correlation.
     *
     * This is NOT a provider-issued transaction ID.
     */

    // The returned evidence is bound to the reference sent to the adapter.

    /*
     * Provider reference:
     *
     * Store only when it is an actual provider-issued
     * reference, distinct from the internal reference.
     *
     * Defensively handle older adapter versions that
     * incorrectly returned requestReference as
     * providerReference.
     */

    const reportedProviderReference =
      typeof lookup.providerReference === "string" ? lookup.providerReference.trim() : null;

    const providerReference =
      reportedProviderReference && reportedProviderReference !== requestReference
        ? reportedProviderReference
        : null;

    return {
      provider,
      environment,

      registration,
      result,

      endpoint: lookup.endpoint || null,

      requestReference,
      providerReference,
    };
  }
}

module.exports = CACVerificationService;
