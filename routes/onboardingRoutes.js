// routes/onboardingRoutes.js

const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/onboardingController");
const {
  isAuthenticated,
  isNotOnboarded,
  isOnboarded,
} = require("../middleware/authMiddleware");

/* ---------- Public pages (GET) ---------- */
router.get(
  "/pharmacist",
  // isAuthenticated,
  // isNotOnboarded,
  onboardingController.getPharmacistOnboarding,
);
router.get(
  "/employer",
  // isAuthenticated,
  // isNotOnboarded,
  onboardingController.getEmployerOnboarding,
);

/* ---------- Action pages (POST}) ---------- */
/* router.post(
  "/pharmacist",
  isAuthenticated,
  onboardingController.postPharmacistOnboarding,
);

router.post(
  "/employer",
  isAuthenticated,
  onboardingController.postEmployerOnboarding,
);
*/

module.exports = router;
