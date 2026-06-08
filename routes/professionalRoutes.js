// routes/professionalRoutes.js

const express = require("express");
const router = express.Router();

const {
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole,
  isOnboarded,
} = require("../middleware/authMiddleware");

const { attachProfessionalProfile } = require("../middleware/professionalMiddleware");

const professionalController = require("../controllers/professionalController");

/* ---------- Middleware ---------- */
router.use(
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole("professional"),
  isOnboarded,
  attachProfessionalProfile
);

/* ---------- Protected pages (GET) ---------- */
router.get("/dashboard", professionalController.getDashboard);

module.exports = router;
