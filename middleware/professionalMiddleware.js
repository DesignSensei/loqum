// middleware/professionalMiddleware.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");

const ProfessionalVerificationService = require("../services/professionalVerificationService");

/**
 * PROFESSIONAL MIDDLEWARE — POST-ONBOARDING VERIFICATION
 *
 * Professional identity evidence:
 * - The production NIN lookup occurs once during onboarding.
 * - The stored NIN registry name is reused during licence review.
 * - A registry lookup does not independently authenticate its holder.
 * - No separate administrative NIN documentary review is required.
 *
 * Practising-licence verification:
 * - A genuine uploaded licence must receive manual admin review.
 * - Council checks are optional and must be accurately recorded.
 * - Licence holder name must match trusted NIN legal-name evidence.
 * - The licence must be valid under its approved validity mode.
 * - Final professional approval is a separate admin decision.
 *
 * Shift application:
 * - Requires an active, verified, onboarded professional User.
 * - Requires trusted NIN and verified licence evidence.
 * - Requires a current practising licence.
 * - Requires independent final administrative approval.
 * - Requires an active professional profile and visible marketplace status.
 *
 * Pending renewals do not invalidate existing approved licences.
 * Approved upcoming licences may be promoted transactionally when due.
 *
 * The 30-day renewal grace period does not permit clinical work
 * with an expired practising licence.
 *
 * Payout/BVN readiness is a separate workflow.
 *
 * This middleware is a preliminary application guard.
 * Shift application and assignment services MUST independently
 * revalidate eligibility inside their own database transactions.
 */

const EXPECTED_VERIFICATION_ERRORS = new Set([
  "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
  "PROFESSIONAL_VERIFICATION_ACCOUNT_NAME_REQUIRED",

  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_MISMATCH",

  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_CONFLICTING_REVIEWS",

  "PROFESSIONAL_VERIFICATION_UNSUPPORTED_PROFESSIONAL_TYPE",

  "PROFESSIONAL_VERIFICATION_UPCOMING_INCONSISTENT",
  "PROFESSIONAL_VERIFICATION_UPCOMING_EVIDENCE_MISMATCH",

  "PROFESSIONAL_VERIFICATION_INVALID_VALIDITY_START",
  "PROFESSIONAL_VERIFICATION_RENEWAL_NOT_EXTENDED",
  "PROFESSIONAL_VERIFICATION_LIFE_LICENCE_REPLACEMENT",
]);

// ───────────────────── ERRORS ─────────────────────

function createError(message, statusCode, code) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.status = statusCode;
  error.code = code;

  return error;
}

// ───────────────────── ATTACH PROFESSIONAL PROFILE ─────────────────────

/**
 * Attach the authenticated User's professional profile.
 *
 * This middleware must run after:
 *
 * - isAuthenticated
 * - isAccountAllowed
 * - isVerified
 * - hasRole("professional")
 * - isOnboarded
 *
 * The profile is resolved using the trusted authenticated User ID.
 *
 * Do not accept professional profile IDs from request parameters,
 * query strings or request bodies as an alternative ownership source.
 *
 * Verification eligibility is not decided here.
 * Professionals must retain access to their dashboard and licence
 * submission/renewal endpoints even before final approval.
 */

exports.attachProfessionalProfile = async (req, res, next) => {
  try {
    if (!req.user?._id) {
      return res.redirect("/login");
    }

    if (req.user.role !== "professional") {
      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    }

    const profile = await ProfessionalProfile.findOne({
      user: req.user._id,
    });

    if (!profile) {
      return next(
        createError(
          "Your professional profile could not be found. Please contact Loqum Support.",
          409,
          "PROFESSIONAL_PROFILE_MISSING"
        )
      );
    }

    req.professionalProfile = profile;

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── APPROVAL EVIDENCE ─────────────────────

/**
 * Final approval must be recorded with:
 *
 * - An approved decision;
 * - A valid approval timestamp;
 * - An administrator identifier;
 * - An approver different from the professional.
 *
 * The admin verification service is responsible for verifying
 * the administrator's authority when the approval is recorded.
 *
 * An old approval timestamp is not invalidated merely because
 * an independently approved licence renewal becomes effective.
 */

function hasValidIndependentApproval(profile) {
  if (!profile || profile.professionalApprovalStatus !== "approved") {
    return false;
  }

  const approvedAt = profile.approvedForShiftsAt;

  if (
    !(approvedAt instanceof Date) ||
    !Number.isFinite(approvedAt.getTime()) ||
    approvedAt.getTime() > Date.now()
  ) {
    return false;
  }

  if (
    !mongoose.isValidObjectId(profile.approvedForShiftsBy) ||
    !mongoose.isValidObjectId(profile.user)
  ) {
    return false;
  }

  if (String(profile.approvedForShiftsBy) === String(profile.user)) {
    return false;
  }

  return true;
}

// ───────────────────── SHIFT APPLICATION ELIGIBILITY ─────────────────────

/**
 * Validate current professional eligibility using authoritative
 * database state inside a MongoDB transaction.
 *
 * The transaction intentionally loads a hydrated Mongoose document,
 * not a lean object.
 *
 * ProfessionalVerificationService.getVerifiedReadiness() may:
 *
 * 1. Promote an already-approved upcoming licence when due;
 * 2. Validate the original production NIN onboarding evidence;
 * 3. Check the current licence validity mode and expiry;
 * 4. Match the stored NIN legal name against the licence-holder name;
 * 5. Validate the active manual licence-review KYC evidence;
 * 6. Check professional approval and account readiness.
 *
 * No new provider lookup or administrative decision is performed.
 *
 * Expected missing/inconsistent verification evidence returns false.
 * Unexpected database errors propagate instead of being disguised
 * as verification failures.
 *
 * This preliminary middleware does not replace transactional
 * verification inside the application and assignment services.
 */

async function isEligibleForShiftApplication({ professionalProfileId, userId } = {}) {
  if (!mongoose.isValidObjectId(professionalProfileId) || !mongoose.isValidObjectId(userId)) {
    return false;
  }

  const session = await mongoose.startSession();

  try {
    let eligible = false;

    await session.withTransaction(async () => {
      eligible = false;

      const profile = await ProfessionalProfile.findOne({
        _id: professionalProfileId,
        user: userId,
      })
        .select("+licenceDocumentUrl " + "+upcomingLicence.documentUrl")
        .session(session);

      if (!profile) {
        return;
      }

      // The profile must belong to the authenticated User.
      // This check is independent of the route attachment.
      if (String(profile.user) !== String(userId)) {
        return;
      }

      /*
       * Validate trusted production NIN evidence, current manual
       * licence review, expiry and independent final approval.
       *
       * The service may activate a preapproved future licence
       * inside this transaction before returning readiness.
       *
       * Do not call getVerificationReadiness(profile) alone:
       * that method cannot establish trusted KYC evidence without
       * the independently validated onboarding NIN record.
       */

      const readiness = await ProfessionalVerificationService.getVerifiedReadiness({
        profile,
        session,
      });

      if (readiness.verificationReady !== true) {
        return;
      }

      /*
       * A verified licence must be current.
       *
       * Expired credentials cannot authorize clinical shifts,
       * including within the post-expiry renewal grace period.
       */

      if (
        readiness.licenceVerified !== true ||
        readiness.licenceCurrent !== true ||
        readiness.namesConsistent !== true ||
        readiness.ninEvidenceConfirmed !== true
      ) {
        return;
      }

      /*
       * Require an independently approved professional.
       *
       * The domain service verifies the approved status.
       * Here we additionally validate the persisted approval
       * timestamp and independent approver identity.
       */

      if (!hasValidIndependentApproval(profile)) {
        return;
      }

      /*
       * Profile-level account and marketplace controls.
       *
       * The underlying User's active, verified and onboarded
       * state is checked by getTrustedOnboardingNIN().
       */

      if (profile.accountStatus !== "active" || profile.marketplaceStatus !== "visible") {
        return;
      }

      /*
       * All required checks have passed:
       *
       * - Trusted original NIN name evidence;
       * - Verified uploaded practising licence;
       * - Current licence validity;
       * - Matching legal names;
       * - Active KYC review evidence;
       * - Independent final approval;
       * - Active professional profile;
       * - Visible marketplace status.
       */

      eligible = true;
    });

    return eligible;
  } catch (error) {
    if (EXPECTED_VERIFICATION_ERRORS.has(error?.code)) {
      return false;
    }

    throw error;
  } finally {
    await session.endSession();
  }
}

// ───────────────────── SHIFT APPLICATION GUARD ─────────────────────

/**
 * Preliminary guard for:
 *
 * POST /shifts/:shiftId/apply
 *
 * POST /shifts/:shiftId/occurrences/:occurrenceId/apply
 *
 * Professionals may access other professional routes without
 * being eligible for clinical shifts.
 *
 * The professional profile ID comes from trusted middleware.
 * Never accept a user-supplied profile ID for authorization.
 *
 * Eligibility must be checked again by the shift application
 * service during its own write transaction.
 */

exports.canApplyForShifts = async (req, res, next) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    if (req.user.role !== "professional") {
      return res.status(403).json({
        success: false,
        message: "Professional account access is required.",
      });
    }

    const profile = req.professionalProfile;

    if (!profile?._id) {
      return res.status(409).json({
        success: false,
        message: "Your professional profile is unavailable. Please contact Loqum Support.",
      });
    }

    /*
     * The attached profile must belong to the authenticated User.
     *
     * The database lookup repeats this ownership check inside
     * the eligibility transaction.
     */

    if (
      !mongoose.isValidObjectId(req.user._id) ||
      !mongoose.isValidObjectId(profile._id) ||
      String(profile.user) !== String(req.user._id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Professional profile access is not permitted.",
      });
    }

    const eligible = await isEligibleForShiftApplication({
      professionalProfileId: profile._id,
      userId: req.user._id,
    });

    if (!eligible) {
      return res.status(403).json({
        success: false,
        message:
          "Your practising licence, registered name evidence, " +
          "final professional approval, account status and " +
          "marketplace visibility must meet Loqum's requirements " +
          "before you can apply for shifts.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
