// routes/employerRoutes.js

const express = require("express");
const router = express.Router();
const {
  isAuthenticated,
  isVerified,
  hasRole,
  isOnboarded,
} = require("../middleware/authMiddleware");
const { attachEmployerProfile } = require("../middleware/employerMiddleware");
const employerController = require("../controllers/employerController");

/* ---------- Middleware ---------- */
// router.use(isAuthenticated, isVerified, hasRole("employer"), isOnboarded, attachEmployerProfile);

/* ---------- Public pages (GET) ---------- */
router.get("/dashboard", employerController.getDashboard);

module.exports = router;
