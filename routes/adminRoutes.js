// routes/adminRoutes.js

const express = require("express");
const router = express.Router();

const {
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole,
} = require("../middleware/authMiddleware");

const adminController = require("../controllers/adminController");

const adminShiftClaimController = require("../controllers/adminShiftClaimController");

/* ─────────────────────────────── MIDDLEWARE ─────────────────────────────── */

router.use(isAuthenticated, isAccountAllowed, isVerified, hasRole("admin"));

/* ─────────────────────────────── ADMIN PAGES ─────────────────────────────── */

router.get("/dashboard", adminController.getDashboard);

/* ─────────────────────────────── SHIFT CLAIM ROUTES ─────────────────────────────── */

// Makes the final admin decision on a claim already awaiting admin review.

router.post("/shift-claims/:claimId/resolve", adminShiftClaimController.resolveClaim);

module.exports = router;
