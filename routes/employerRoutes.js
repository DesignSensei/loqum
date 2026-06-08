// routes/employerRoutes.js

const express = require("express");
const router = express.Router();

const {
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole,
  isOnboarded,
} = require("../middleware/authMiddleware");

const { attachEmployerProfile } = require("../middleware/employerMiddleware");

const employerController = require("../controllers/employerController");

/* ---------- Middleware ---------- */
router.use(
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole("employer"),
  isOnboarded,
  attachEmployerProfile
);

/* ---------- Protected pages (GET) ---------- */
router.get("/dashboard", employerController.getDashboard);

module.exports = router;
