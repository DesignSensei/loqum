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

/* ─────────────────────────────── ROUTE PROTECTION ─────────────────────────────── */

router.use(isAuthenticated, isAccountAllowed, isVerified, hasRole("admin"));

/* ─────────────────────────────── ADMIN PAGES ─────────────────────────────── */

router.get("/dashboard", adminController.getDashboard);

/* ─────────────────────────────── PROFESSIONAL CLAIM ADJUDICATION ─────────────────────────────── */

/*
 * Admin resolves one issue within a professional claim case.
 *
 * The resolution service owns the final authoritative occurrence facts,
 * settlement continuation, refund reevaluation and case-level completion.
 */
router.post(
  "/shift-claims/:claimId/issues/:issueId/resolve",
  adminShiftClaimController.resolveClaim
);

/* ─────────────────────────────── EMPLOYER DISPUTE ADJUDICATION ─────────────────────────────── */

/*
 * Admin resolves one issue within an employer standalone dispute case.
 *
 * The resolution service owns the final authoritative occurrence facts,
 * settlement continuation, refund reevaluation and case-level completion.
 */
router.post(
  "/shift-disputes/:disputeId/issues/:issueId/resolve",
  adminShiftClaimController.resolveDispute
);

module.exports = router;
