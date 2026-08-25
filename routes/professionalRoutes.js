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

/* ─────────────────────────────── PROTECTED PAGES ─────────────────────────────── */

router.get("/dashboard", professionalController.getDashboard);

/* ─────────────────────────────── SHIFT ATTENDANCE ROUTES ─────────────────────────────── */

/**
 * Check in to one exact assigned ShiftOccurrence.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in",
  professionalShiftAttendanceController.checkIn
);

/**
 * Check out from one exact assigned ShiftOccurrence.
 *
 * Late checkout may record:
 *
 * - no overtime; or
 * - an overtime request.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out",
  professionalShiftAttendanceController.checkOut
);

/**
 * Request manual checkout review when normal checkout cannot be completed.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/checkout-fallback",
  professionalShiftAttendanceController.requestCheckoutFallback
);

/**
 * Confirm that the professional did not work a recorded no-show occurrence
 * and submit the one absence explanation.
 *
 * This is attendance information, not a claim.
 *
 * If the professional says they actually worked, the attendance_correction
 * claim route below must be used instead.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/absence-explanation",
  professionalShiftAttendanceController.submitAbsenceExplanation
);

/* ─────────────────────────────── SHIFT CLAIM ROUTES ─────────────────────────────── */

/**
 * Submit the professional's one original financially relevant claim for an
 * assigned occurrence.
 *
 * Supported claim types are service-controlled and include:
 *
 * - attendance_correction
 * - payment_calculation
 * - employer_fault
 *
 * affectedSettlementComponents is derived by the claim service and must not
 * be supplied as client authority.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/claims",
  professionalShiftClaimController.submitClaim
);

/**
 * Submit the professional's one appeal after the employer rejects an original
 * occurrence claim.
 */
router.post("/claims/:claimId/appeal", professionalShiftClaimController.submitAppeal);

/**
 * Withdraw an active occurrence claim.
 *
 * Withdrawal consumes the original claim opportunity and does not reopen the
 * occurrence challenge window.
 */
router.post("/claims/:claimId/withdraw", professionalShiftClaimController.withdrawClaim);

module.exports = router;
