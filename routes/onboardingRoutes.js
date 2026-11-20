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

// ───────────────────── PROFESSIONAL ONBOARDING ─────────────────────

// Render professional onboarding
router.get(
  "/professional",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.getProfessionalOnboarding
);

// Verify NIN
router.post(
  "/professional/verify-nin",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.verifyProfessionalNIN
);

// Acknowledge registry legal name
router.post(
  "/professional/nin/acknowledge-name",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.acknowledgeProfessionalNINName
);

// Begin NIN correction
router.post(
  "/professional/nin/begin-correction",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.beginProfessionalNINCorrection
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

// Render employer onboarding
router.get(
  "/employer",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isNotOnboarded,
  onboardingController.getEmployerOnboarding
);

// Verify CAC
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
