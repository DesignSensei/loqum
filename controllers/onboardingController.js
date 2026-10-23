// controllers/onboardingController.js

const OnboardingService = require("../services/onboardingService");

const PreOnboardingCACVerificationService = require("../services/preOnboardingCACVerificationService");
const PreOnboardingNINVerificationService = require("../services/preOnboardingNINVerificationService");

const locations = require("../config/locations");
const specialtyConfig = require("../config/specialtyConfig");

const logger = require("../utils/logger");

// ───────────────────── RESPONSE HELPERS ─────────────────────

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function getAuthenticatedUserId(req) {
  return req.user?._id || req.session?.user?._id || null;
}

function sendOnboardingError(res, error, operation) {
  const explicitStatus = error?.statusCode || error?.status;

  const statusCode =
    Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500
      ? explicitStatus
      : error?.name === "ValidationError" || error?.name === "CastError"
        ? 400
        : 500;

  logger.error(`${operation}: ${error?.code || error?.name || "ONBOARDING_ERROR"}`);

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? "Unable to complete onboarding. Please try again."
        : error?.message || "Invalid onboarding information.",
  });
}

// ───────────────────── VERIFICATION ERROR HANDLING ─────────────────────

/*
 * Shared error handling for the CAC and NIN
 * pre-onboarding verification endpoints.
 *
 * Never return:
 *
 * - Raw NIN;
 * - NIN hash;
 * - Provider credentials;
 * - Raw provider responses;
 * - Processing claim IDs;
 * - Internal request references.
 *
 * Only explicitly permitted client-facing
 * errors may expose their detailed messages.
 */

const PUBLIC_VERIFICATION_ERROR_CODES = new Set([
  // CAC input validation
  "CAC_UNSUPPORTED_REGISTRATION_FORMAT",
  "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE",

  // CAC onboarding authorization and state
  "CAC_ONBOARDING_INVALID_BUSINESS_NAME",
  "CAC_ONBOARDING_EMPLOYER_REQUIRED",
  "CAC_ONBOARDING_ACCOUNT_INELIGIBLE",
  "CAC_ONBOARDING_ALREADY_COMPLETED",
  "CAC_ONBOARDING_ALREADY_PROCESSING",
  "CAC_ONBOARDING_OUTCOME_UNCERTAIN",
  "CAC_ONBOARDING_ALREADY_CONSUMED",
  "CAC_ONBOARDING_COOLDOWN",
  "CAC_ONBOARDING_CONCURRENT_REQUEST",

  // NIN input validation and consent
  "NIN_ONBOARDING_INVALID_NIN",
  "IDENTITY_INVALID_IDENTIFIER",
  "NIN_ONBOARDING_CONSENT_REQUIRED",

  // NIN onboarding authorization and state
  "NIN_ONBOARDING_PROFESSIONAL_REQUIRED",
  "NIN_ONBOARDING_ACCOUNT_INELIGIBLE",
  "NIN_ONBOARDING_ACCOUNT_NAME_REQUIRED",
  "NIN_ONBOARDING_ALREADY_COMPLETED",
  "NIN_ONBOARDING_ALREADY_PROCESSING",
  "NIN_ONBOARDING_OUTCOME_UNCERTAIN",
  "NIN_ONBOARDING_ALREADY_CONSUMED",
  "NIN_ONBOARDING_COOLDOWN",
  "NIN_ONBOARDING_CONCURRENT_REQUEST",
]);

function sendVerificationError(res, error, operation) {
  const explicitStatus = error?.statusCode || error?.status;

  const statusCode =
    Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
      ? explicitStatus
      : 500;

  const rawCode = typeof error?.code === "string" ? error.code : "";

  const code = /^[A-Z][A-Z0-9_]{2,99}$/.test(rawCode) ? rawCode : "ONBOARDING_VERIFICATION_ERROR";

  logger.warn(`${operation}: ${code}`);

  let message = "Verification is currently unavailable. You can still complete onboarding.";

  if (statusCode === 429) {
    message = "Too many verification requests. Please wait before trying again.";
  } else if (
    statusCode < 500 &&
    PUBLIC_VERIFICATION_ERROR_CODES.has(code) &&
    typeof error?.message === "string"
  ) {
    message = error.message;
  }

  return res.status(statusCode).json({
    success: false,
    code,
    message,
  });
}

// ───────────────────── PROFESSIONAL ONBOARDING PAGE ─────────────────────

exports.getProfessionalOnboarding = (req, res) => {
  setNoStoreHeaders(res);

  return res.render("onboarding/professional", {
    layout: "layouts/onboarding-layout",
    title: "Professional Profile",

    locations: JSON.stringify(locations),
    specialtyConfig: JSON.stringify(specialtyConfig),

    csrfToken: req.csrfToken(),

    googleMapsApiKey: process.env.GOOGLE_MAPS_BROWSER_KEY,

    scripts: `
      <script src="/js/location-picker.js"></script>
      <script src="/js/specialty-picker.js"></script>
      <script src="/js/onboarding/onboarding-professional.js"></script>
      <script
        async
        defer
        src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_BROWSER_KEY}&libraries=places&callback=initAddressAutocomplete"
      ></script>
    `,
  });
};

// ───────────────────── EMPLOYER ONBOARDING PAGE ─────────────────────

exports.getEmployerOnboarding = (req, res) => {
  setNoStoreHeaders(res);

  return res.render("onboarding/employer", {
    layout: "layouts/onboarding-layout",
    title: "Employer Profile",

    locations: JSON.stringify(locations),

    csrfToken: req.csrfToken(),

    googleMapsApiKey: process.env.GOOGLE_MAPS_BROWSER_KEY,

    scripts: `
      <script src="/js/location-picker.js"></script>
      <script src="/js/onboarding/onboarding-employer.js"></script>
      <script
        async
        defer
        src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_BROWSER_KEY}&libraries=places&callback=initAddressAutocomplete"
      ></script>
    `,
  });
};

// ───────────────────── EMPLOYER CAC VERIFICATION ─────────────────────

/*
 * POST /onboarding/employer/verify-cac
 *
 * Verifies an employer's submitted business identity
 * against the configured Ninja or Dojah CAC provider.
 *
 * The service handles:
 *
 * - Provider selection;
 * - RC/BN validation;
 * - Business-name matching;
 * - Chargeable-request concurrency protection;
 * - Cooldown enforcement;
 * - Temporary evidence persistence.
 *
 * This endpoint does not:
 *
 * - Create an employer profile;
 * - Create a wallet or DVA;
 * - Complete onboarding;
 * - Verify PCN premises;
 * - Grant employer administrative approval.
 */

exports.verifyEmployerCAC = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    if (process.env.CAC_ONBOARDING_LOOKUPS_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        code: "CAC_ONBOARDING_LOOKUPS_DISABLED",
        message:
          "Instant CAC verification is currently unavailable. You can still complete onboarding.",
      });
    }

    const { businessName, cacRegistrationNumber } = req.body || {};

    const result = await PreOnboardingCACVerificationService.verifyCAC({
      userId,
      businessName,
      registrationNumber: cacRegistrationNumber,
    });

    /*
     * Return only information needed to display
     * the result under the CAC form field.
     *
     * Temporary verification IDs and provider
     * references must remain server-side.
     */

    return res.status(200).json({
      success: true,

      data: {
        status: result.status,

        matched: result.matched,
        verified: result.verified,

        provisional: true,

        stagingOnly: result.stagingOnly,
        requiresReview: result.requiresReview,

        cached: result.cached,

        registrationNumber: result.registrationNumber,

        registeredBusinessName: result.registeredBusinessName,

        entityType: result.entityType,
        entityStatus: result.entityStatus,

        checks: result.checks,

        checkedAt: result.checkedAt,
        expiresAt: result.expiresAt,

        message: result.message,
      },
    });
  } catch (error) {
    return sendVerificationError(res, error, "Employer CAC onboarding verification");
  }
};

// ───────────────────── PROFESSIONAL NIN VERIFICATION ─────────────────────

/*
 * POST /onboarding/professional/verify-nin
 *
 * NIN ONLY.
 *
 * This endpoint does not support BVN.
 *
 * Accepted request fields:
 *
 * - nin: 11-digit National Identification Number;
 * - consentAccepted: explicit verification consent.
 *
 * The professional's first and last names are
 * retrieved by PreOnboardingNINVerificationService
 * directly from the authenticated User record.
 *
 * The browser cannot supply an alternative identity
 * name or select a verification provider.
 *
 * Successful registry matching does not establish
 * that the professional is the legitimate NIN holder.
 *
 * Therefore this endpoint never approves identity,
 * professional credentials or marketplace access.
 *
 * The request must pass application-level CSRF
 * protection and authenticated professional
 * onboarding middleware.
 */

exports.verifyProfessionalNIN = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    if (process.env.NIN_ONBOARDING_LOOKUPS_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        code: "NIN_ONBOARDING_LOOKUPS_DISABLED",
        message:
          "Instant NIN verification is currently unavailable. You can still complete onboarding.",
      });
    }

    /*
     * FormData submissions may encode a checked
     * checkbox as "on" or "true".
     *
     * Explicit consent is required before every
     * newly initiated verification request.
     */

    const consentValue = req.body?.consentAccepted;

    const consentAccepted =
      consentValue === true ||
      consentValue === "true" ||
      consentValue === "on" ||
      consentValue === "1";

    const nin = req.body?.nin;

    /*
     * No identity attributes supplied by the browser
     * are trusted for the registry comparison.
     *
     * The service reads the first and last names
     * from the authenticated User record.
     */

    const result = await PreOnboardingNINVerificationService.verifyNIN({
      userId,
      nin,
      consentAccepted,
    });

    /*
     * Return only safe, minimal display information.
     *
     * Do NOT return:
     *
     * - Raw NIN;
     * - NIN last four digits;
     * - NIN HMAC;
     * - Full registered identity name;
     * - Date of birth;
     * - Provider request references;
     * - Provider-issued references;
     * - Temporary record identifiers.
     */

    return res.status(200).json({
      success: true,

      data: {
        status: result.status,

        matched: result.matched,

        /*
         * Registry matching is not holder
         * authentication.
         */
        verified: false,
        holderAuthenticated: false,

        requiresHolderAuthentication: true,

        stagingOnly: result.stagingOnly,
        cached: result.cached,

        provider: result.provider,
        environment: result.environment,

        registryFound: result.registryFound,
        detailsMatched: result.detailsMatched,

        checkedAt: result.checkedAt,
        expiresAt: result.expiresAt,

        message: result.message,
      },
    });
  } catch (error) {
    return sendVerificationError(res, error, "Professional NIN onboarding verification");
  }
};

// ───────────────────── PROFESSIONAL ONBOARDING SUBMISSION ─────────────────────

exports.postProfessionalOnboarding = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    await OnboardingService.completeProfessionalOnboarding(userId, req.body);

    if (req.session?.user) {
      req.session.user.isOnboarded = true;
    }

    if (req.user) {
      req.user.isOnboarded = true;
    }

    if (!req.session || typeof req.session.save !== "function") {
      return res.status(500).json({
        success: false,
        message: "Unable to finalize the onboarding session.",
      });
    }

    return req.session.save((error) => {
      if (error) {
        return next(error);
      }

      return res.status(200).json({
        success: true,
        message: "Professional profile completed successfully!",
        redirectUrl: "/professional/dashboard",
      });
    });
  } catch (error) {
    return sendOnboardingError(res, error, "Professional onboarding");
  }
};

// ───────────────────── EMPLOYER ONBOARDING SUBMISSION ─────────────────────

exports.postEmployerOnboarding = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    await OnboardingService.completeEmployerOnboarding(userId, req.body);

    if (req.session?.user) {
      req.session.user.isOnboarded = true;
    }

    if (req.user) {
      req.user.isOnboarded = true;
    }

    if (!req.session || typeof req.session.save !== "function") {
      return res.status(500).json({
        success: false,
        message: "Unable to finalize the onboarding session.",
      });
    }

    return req.session.save((error) => {
      if (error) {
        return next(error);
      }

      return res.status(200).json({
        success: true,
        message: "Business profile completed successfully!",
        redirectUrl: "/employer/dashboard",
      });
    });
  } catch (error) {
    return sendOnboardingError(res, error, "Employer onboarding");
  }
};
