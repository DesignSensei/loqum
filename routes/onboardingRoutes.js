// routes/onboardingRoutes.js

const express = require("express");
const router = express.Router();

const onboardingController = require("../controllers/onboardingController");

const {
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole,
  isNotOnboarded,
} = require("../middleware/authMiddleware");

/* ---------- Protected onboarding pages (GET) ---------- */
router.get(
  "/professional",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.getProfessionalOnboarding
);

router.get(
  "/employer",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isNotOnboarded,
  onboardingController.getEmployerOnboarding
);

/* ---------- Onboarding submissions (POST) ---------- */
router.post(
  "/professional",
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isNotOnboarded,
  onboardingController.postProfessionalOnboarding
);

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
