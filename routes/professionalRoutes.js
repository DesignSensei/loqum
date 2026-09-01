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

const professionalShiftAttendanceController = require("../controllers/professionalShiftAttendanceController");

const professionalShiftClaimController = require("../controllers/professionalShiftClaimController");

/* ─────────────────────────────── MIDDLEWARE ─────────────────────────────── */

router.use(
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isOnboarded,
  attachProfessionalProfile
);

/* ─────────────────────────────── PAGES ─────────────────────────────── */

router.get("/dashboard", professionalController.getDashboard);

/* ─────────────────────────────── SHIFT ATTENDANCE ─────────────────────────────── */

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in",
  professionalShiftAttendanceController.checkIn
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out",
  professionalShiftAttendanceController.checkOut
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/checkout-fallback",
  professionalShiftAttendanceController.requestCheckoutFallback
);

/**
 * Absence explanations belong to attendance.
 * Worked-but-recorded-absent cases use an attendance_correction claim.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/absence-explanation",
  professionalShiftAttendanceController.submitAbsenceExplanation
);

/* ─────────────────────────────── SHIFT CLAIMS ─────────────────────────────── */

/**
 * One claim case may contain multiple financial issues.
 * Settlement-component scope is derived by the claim service.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/claims",
  professionalShiftClaimController.submitClaim
);

/**
 * Appeal and rebuttal operate on one issue within the claim case.
 */
router.post(
  "/claims/:claimId/issues/:issueId/appeal",
  professionalShiftClaimController.submitAppeal
);

router.post(
  "/claims/:claimId/issues/:issueId/rebuttal",
  professionalShiftClaimController.submitRebuttal
);

/**
 * Withdrawal applies to the claim case and consumes the original claim right.
 */
router.post("/claims/:claimId/withdraw", professionalShiftClaimController.withdrawClaim);

module.exports = router;
