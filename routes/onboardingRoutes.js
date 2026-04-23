// routes/onboardingRoutes.js

const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/onboardingController");
const { isAuthenticated, isNotOnboarded, isOnboarded } = require("../middleware/authMiddleware");

/* ---------- Public pages (GET) ---------- */
router.get(
  "/professional",
  // isAuthenticated,
  // isNotOnboarded,
  onboardingController.getProfessionalOnboarding
);
router.get(
  "/employer",
  // isAuthenticated,
  // isNotOnboarded,
  onboardingController.getEmployerOnboarding
);

/* ---------- Action pages (POST}) ---------- */
/* router.post(
  "/professional",
  isAuthenticated,
  onboardingController.postProfessionalOnboarding,
);

router.post(
  "/employer",
  isAuthenticated,
  onboardingController.postEmployerOnboarding,
);
*/

module.exports = router;
