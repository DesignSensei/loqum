// routes/employerRoutes.js

const express = require("express");
const router = express.Router();
const {
  isAuthenticated,
  isVerified,
  hasRole,
  isOnboarded,
} = require("../middleware/authMiddleware");
const employerController = require("../controllers/employerController");

/* ---------- Middleware ---------- */
// router.use(isAuthenticated, isVerified, hasRole("employer"), isOnboarded);

/* ---------- Public pages (GET) ---------- */
router.get("/dashboard", employerController.getDashboard);

module.exports = router;
