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
 * Shared error handling for CAC and NIN
 * pre-onboarding verification endpoints.
 *
 * Never expose:
 *
 * - Raw NIN or NIN hash;
 * - Provider credentials or raw responses;
 * - Processing claim IDs;
 * - Internal verification data;
 * - Arbitrary service error details.
 *
 * Only explicitly approved client-facing
 * error messages may be returned.
 */

const PUBLIC_VERIFICATION_ERROR_CODES = new Set([
  // CAC input validation
  "CAC_UNSUPPORTED_REGISTRATION_FORMAT",
  "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE",

  // CAC onboarding authorization and state
  "CAC_ONBOARDING_INVALID_REGISTRATION_NUMBER",
  "CAC_ONBOARDING_EMPLOYER_REQUIRED",
  "CAC_ONBOARDING_ACCOUNT_INELIGIBLE",
  "CAC_ONBOARDING_ALREADY_COMPLETED",
  "CAC_ONBOARDING_ALREADY_PROCESSING",
  "CAC_ONBOARDING_OUTCOME_UNCERTAIN",
  "CAC_ONBOARDING_ALREADY_CONSUMED",
  "CAC_ONBOARDING_RATE_LIMITED",
  "CAC_ONBOARDING_CONCURRENT_REQUEST",

  // NIN input validation and consent
  "NIN_ONBOARDING_INVALID_NIN",
  "IDENTITY_INVALID_IDENTIFIER",
  "NIN_ONBOARDING_CONSENT_REQUIRED",
  "NIN_ONBOARDING_INVALID_REFERENCE",

  // NIN onboarding authorization and state
  "NIN_ONBOARDING_PROFESSIONAL_REQUIRED",
  "NIN_ONBOARDING_ACCOUNT_INELIGIBLE",
  "NIN_ONBOARDING_ALREADY_COMPLETED",
  "NIN_ONBOARDING_ALREADY_PROCESSING",
  "NIN_ONBOARDING_OUTCOME_UNCERTAIN",
  "NIN_ONBOARDING_ALREADY_CONSUMED",
  "NIN_ONBOARDING_CONCURRENT_REQUEST",

  // NIN name acknowledgement and correction
  "NIN_ONBOARDING_PREVIEW_UNAVAILABLE",
  "NIN_ONBOARDING_CORRECTION_UNAVAILABLE",
  "NIN_ONBOARDING_NAME_NOT_ACKNOWLEDGED",
]);

// ───────────────────── VERIFICATION RATE-LIMIT RESPONSE ─────────────────────

/*
 * CAC: 8 lookups / 6 distinct registrations per rolling 24 hours.
 * NIN: 8 lookups / 4 distinct NINs per rolling 24 hours.
 *
 * An eligible cached result may be reusable regardless of these limits.
 * For distinct limits, the server may permit another request against
 * an identifier already counted in the window.
 *
 * Only the two explicitly recognized rate-limit error codes may expose:
 * - nextEligibleAt: strict ISO 8601 UTC timestamp;
 * - retryAfterSeconds: positive safe integer;
 * - limitType: total, distinct, or both.
 *
 * Never serialize arbitrary error.details or internal provider data.
 * Unresolved provider outcomes are not rolling-window rate limits.
 */

const VERIFICATION_RATE_LIMIT_POLICIES = Object.freeze({
  NIN_ONBOARDING_RATE_LIMITED: Object.freeze({
    label: "NIN",
    total: 8,
    distinct: 4,
  }),
  CAC_ONBOARDING_RATE_LIMITED: Object.freeze({
    label: "CAC",
    total: 8,
    distinct: 6,
  }),
});

function getVerificationRateLimitDetails(error, statusCode, code) {
  if (
    statusCode !== 429 ||
    !Object.prototype.hasOwnProperty.call(VERIFICATION_RATE_LIMIT_POLICIES, code)
  ) {
    return null;
  }

  const nextEligibleAt = error?.nextEligibleAt;
  const retryAfterSeconds = error?.retryAfterSeconds;
  const limitType = error?.limitType;

  if (
    typeof nextEligibleAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(nextEligibleAt) ||
    !Number.isFinite(Date.parse(nextEligibleAt)) ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    !["total", "distinct", "both"].includes(limitType)
  ) {
    return null;
  }

  return {
    nextEligibleAt,
    retryAfterSeconds,
    limitType,
    policy: VERIFICATION_RATE_LIMIT_POLICIES[code],
  };
}

function sendVerificationError(res, error, operation) {
  const explicitStatus = error?.statusCode || error?.status;

  const statusCode =
    Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
      ? explicitStatus
      : 500;

  const rawCode = typeof error?.code === "string" ? error.code : "";

  const code = /^[A-Z][A-Z0-9_]{2,99}$/.test(rawCode) ? rawCode : "ONBOARDING_VERIFICATION_ERROR";

  logger.warn(`${operation}: ${code}`);

  // ───────── APPROVED RATE-LIMIT DETAILS ─────────

  const rateLimitDetails = getVerificationRateLimitDetails(error, statusCode, code);

  let message = "Verification is currently unavailable. Please try again later.";

  if (rateLimitDetails) {
    const { label, total, distinct } = rateLimitDetails.policy;

    if (rateLimitDetails.limitType === "total") {
      message = `You have used all ${total} ${label} verification attempts allowed within a rolling 24-hour period.`;

      message +=
        " New paid lookups are temporarily unavailable; eligible cached results may still be reusable.";
    } else if (rateLimitDetails.limitType === "distinct") {
      message = `You have reached the limit of ${distinct} different ${
        label === "NIN" ? "NINs" : "CAC registration numbers"
      } within a rolling 24-hour period.`;

      message +=
        " An already attempted identifier may still be eligible if the total lookup allowance permits.";
    } else {
      message = `You have reached both the total and distinct ${label} verification limits for the submitted identifier.`;

      message +=
        " An already attempted identifier may become eligible sooner, and eligible cached results may still be reusable.";
    }

    message += " The next eligible time for the rejected request is provided in nextEligibleAt.";

    res.set("Retry-After", String(rateLimitDetails.retryAfterSeconds));
  } else if (statusCode === 429) {
    message = "Too many verification requests. Please wait before trying again.";
  } else if (
    statusCode < 500 &&
    PUBLIC_VERIFICATION_ERROR_CODES.has(code) &&
    typeof error?.message === "string"
  ) {
    message = error.message;
  }

  const response = {
    success: false,
    code,
    message,
  };

  if (rateLimitDetails) {
    response.nextEligibleAt = rateLimitDetails.nextEligibleAt;
    response.retryAfterSeconds = rateLimitDetails.retryAfterSeconds;
    response.limitType = rateLimitDetails.limitType;
  }

  return res.status(statusCode).json(response);
}

// ───────────────────── PROFESSIONAL NIN RESPONSE ─────────────────────

/*
 * The verification service controls permission
 * to disclose NIN registry-name information.
 *
 * This controller returns only the fields required
 * for the professional's confirmation workflow.
 *
 * requestReference is an opaque lookup reference
 * used to acknowledge or change the current result.
 *
 * It is not the raw NIN, NIN hash, processing claim,
 * provider reference or identity credential.
 *
 * All NIN endpoints require authenticated,
 * authorised professional access and CSRF protection.
 */

function buildNINPublicResponse(result) {
  return {
    status: result.status,
    matched: result.matched,

    // Registry matching is not identity-holder authentication.
    verified: false,
    holderAuthenticated: false,
    requiresHolderAuthentication: true,

    registryFound: result.registryFound,
    registryLegalName: result.registryLegalName,
    requestReference: result.requestReference,

    acknowledged: result.acknowledged,
    eligibleForOnboarding: result.eligibleForOnboarding,

    stagingOnly: result.stagingOnly,
    cached: result.cached,

    provider: result.provider,
    environment: result.environment,

    checkedAt: result.checkedAt,
    expiresAt: result.expiresAt,
    message: result.message,
  };
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
 * Verifies an employer's submitted CAC
 * registration using the configured provider.
 *
 * Provider selection, lookup safeguards and
 * temporary evidence persistence are owned
 * by PreOnboardingCACVerificationService.
 *
 * This endpoint does not create a profile,
 * wallet, DVA or employer approval.
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
        message: "CAC verification is currently unavailable. Please try again later.",
      });
    }

    const { cacRegistrationNumber } = req.body || {};

    const result = await PreOnboardingCACVerificationService.verifyCAC({
      userId,
      registrationNumber: cacRegistrationNumber,
    });

    /*
     * Only return fields required to display
     * the applicant's CAC verification result.
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
 * NIN only. BVN is not supported.
 *
 * Accepted request fields:
 *
 * - nin: 11-digit National Identification Number;
 * - consentAccepted: explicit lookup consent.
 *
 * The professional's registered legal name
 * originates from trusted registry evidence,
 * not registration fields submitted by the browser.
 *
 * This endpoint does not establish identity-holder
 * authentication, professional licensing approval
 * or marketplace access.
 *
 * Authentication, role checks, account eligibility
 * and CSRF protection are enforced by the routes.
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
        message: "NIN verification is currently unavailable. Please try again later.",
      });
    }

    /*
     * FormData submissions may encode consent
     * as "on", "true" or "1".
     *
     * A new lookup must always be explicitly
     * initiated by the professional.
     */

    const consentValue = req.body?.consentAccepted;

    const consentAccepted =
      consentValue === true ||
      consentValue === "true" ||
      consentValue === "on" ||
      consentValue === "1";

    const nin = req.body?.nin;

    /*
     * No applicant-supplied first name, surname,
     * date of birth or provider selection is used.
     */

    const result = await PreOnboardingNINVerificationService.verifyNIN({
      userId,
      nin,
      consentAccepted,
    });

    return res.status(200).json({
      success: true,
      data: buildNINPublicResponse(result),
    });
  } catch (error) {
    return sendVerificationError(res, error, "Professional NIN onboarding verification");
  }
};

// ───────────────────── NIN NAME ACKNOWLEDGEMENT ─────────────────────

/*
 * POST /onboarding/professional/nin/acknowledge-name
 *
 * The professional explicitly confirms the legal
 * name returned by their current NIN lookup.
 *
 * requestReference identifies the displayed result.
 *
 * Name acknowledgement does not prove that the
 * applicant owns the NIN.
 *
 * No external provider lookup occurs here.
 */

exports.acknowledgeProfessionalNINName = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    const result = await PreOnboardingNINVerificationService.acknowledgeRegistryName({
      userId,
      requestReference: req.body?.requestReference,
    });

    return res.status(200).json({
      success: true,
      data: buildNINPublicResponse(result),
    });
  } catch (error) {
    return sendVerificationError(res, error, "Professional NIN legal-name acknowledgement");
  }
};

// ───────────────────── CHANGE PROFESSIONAL NIN ─────────────────────

/*
 * POST /onboarding/professional/nin/begin-correction
 *
 * Invoked when the professional selects:
 *
 * "No, enter a different NIN".
 *
 * Acknowledgement of the previous result is
 * invalidated before another NIN can be submitted.
 *
 * The backend prevents changes while a paid
 * provider request remains in progress.
 *
 * This endpoint does not initiate another lookup.
 */

exports.beginProfessionalNINCorrection = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    const result = await PreOnboardingNINVerificationService.beginNINCorrection({
      userId,
      requestReference: req.body?.requestReference,
    });

    return res.status(200).json({
      success: true,
      data: buildNINPublicResponse(result),
    });
  } catch (error) {
    return sendVerificationError(res, error, "Professional NIN correction");
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

    /*
     * OnboardingService independently requires
     * current, acknowledged production NIN evidence.
     *
     * The frontend cannot bypass these requirements.
     */

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
        onboardingCompleted: true,
        message:
          "Your profile was saved, but the session could not be updated. Please sign in again.",
      });
    }

    return req.session.save((error) => {
      if (error) {
        logger.error("Professional onboarding session update failed.");

        return res.status(500).json({
          success: false,
          onboardingCompleted: true,
          message:
            "Your profile was saved, but the session could not be updated. Please sign in again.",
        });
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
        onboardingCompleted: true,
        message:
          "Your business profile was saved, but the session could not be updated. Please sign in again.",
      });
    }

    return req.session.save((error) => {
      if (error) {
        logger.error("Employer onboarding session update failed.");

        return res.status(500).json({
          success: false,
          onboardingCompleted: true,
          message:
            "Your business profile was saved, but the session could not be updated. Please sign in again.",
        });
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
