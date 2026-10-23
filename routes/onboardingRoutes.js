// routes/onboardingRoutes.js

const express = require("express");
const router = express.Router();

const {
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole,
  isNotOnboarded,
} = require("../middleware/authMiddleware");

const onboardingController = require("../controllers/onboardingController");

/*
 * ONBOARDING ROUTES
 *
 * Both employer and professional onboarding require:
 *
 * - An authenticated account;
 * - An account permitted to use the platform;
 * - Verified email;
 * - The appropriate account role;
 * - Onboarding not yet completed.
 *
 * CAC and NIN verification are separate workflows.
 *
 * The corresponding controller also checks the
 * environment feature switch before initiating
 * potentially chargeable provider lookups.
 *
 * CSRF protection must be applied by the
 * application's existing CSRF middleware.
 */

// ───────────────────── PROFESSIONAL ONBOARDING ─────────────────────

// Display professional onboarding form
router.get(
  "/professional",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.getProfessionalOnboarding
);

// Verify NIN before completing professional onboarding
router.post(
  "/professional/verify-nin",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.verifyProfessionalNIN
);

// Complete professional onboarding
router.post(
  "/professional",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.postProfessionalOnboarding
);

// ───────────────────── EMPLOYER ONBOARDING ─────────────────────

// Display employer onboarding form
router.get(
  "/employer",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isNotOnboarded,
  onboardingController.getEmployerOnboarding
);

// Verify CAC before completing employer onboarding
router.post(
  "/employer/verify-cac",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isNotOnboarded,
  onboardingController.verifyEmployerCAC
);

// Complete employer onboarding
router.post(
  "/employer",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isNotOnboarded,
  onboardingController.postEmployerOnboarding
);

module.exports = router;
