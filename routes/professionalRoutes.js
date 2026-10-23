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
const { parseJobApplicationResumeUpload } = require("../middleware/uploadMiddleware");

const professionalController = require("../controllers/professionalController");
const professionalVerificationController = require("../controllers/professionalVerificationController");

const professionalJobController = require("../controllers/professionalJobController");
const professionalJobApplicationController = require("../controllers/professionalJobApplicationController");
const professionalJobAppointmentController = require("../controllers/professionalJobAppointmentController");

const professionalShiftController = require("../controllers/professionalShiftController");
const professionalShiftApplicationController = require("../controllers/professionalShiftApplicationController");
const professionalShiftAttendanceController = require("../controllers/professionalShiftAttendanceController");
const professionalShiftClaimController = require("../controllers/professionalShiftClaimController");

// ───────────────────── AUTHENTICATION ─────────────────────

router.use(
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("professional"),
  isOnboarded,
  attachProfessionalProfile
);

// ───────────────────── PROFESSIONAL VERIFICATION ─────────────────────

/**
 * Professional verification is available to authenticated,
 * onboarded professionals.
 *
 * Initial pre-onboarding NIN verification remains in
 * onboardingRoutes.js.
 *
 * Identity provider operations must enforce ownership,
 * approved verification methods and one-time verification
 * safeguards in their controllers and services.
 *
 * Submitted NIN and professional licence numbers cannot
 * be changed directly through professional-facing routes.
 *
 * Corrections require Loqum Support and an authorised
 * administrative verification process.
 *
 * All mutations remain subject to application-level
 * CSRF protection.
 */

// Read the professional's verification status.
router.get(
  "/verification/:professionalProfileId",
  professionalVerificationController.getVerificationStatus
);

// Look up identity registry evidence.
router.post(
  "/verification/:professionalProfileId/identity/lookup",
  professionalVerificationController.lookupIdentityEvidence
);

// Start hosted identity verification.
router.post(
  "/verification/:professionalProfileId/identity/hosted",
  professionalVerificationController.startHostedIdentityVerification
);

// Synchronise a previously started hosted verification.
router.post(
  "/verification/:professionalProfileId/identity/hosted/:verificationId/sync",
  professionalVerificationController.syncHostedIdentityResult
);

// ───────────────────── PROFESSIONAL PAGES ─────────────────────

router.get("/dashboard", professionalController.getDashboard);

router.get("/cases", professionalShiftClaimController.getCases);

// ───────────────────── PROFESSIONAL PROFILE ─────────────────────

// View Professional Profile and its tabs.
router.get("/profile", professionalController.getProfile);

// Update weekly or specific-date availability.
router.post("/profile/availability", professionalController.postUpdateAvailability);

// ───────────────────── SAVED JOBS ─────────────────────

router.get("/jobs/saved", professionalJobController.getSavedJobs);

router.post("/jobs/:jobId/save", professionalJobController.saveJob);

router.delete("/jobs/:jobId/save", professionalJobController.unsaveJob);

// ───────────────────── JOB APPLICATIONS ─────────────────────

router.get("/job-applications", professionalJobApplicationController.getApplications);

router.get("/job-applications/:applicationId", professionalJobApplicationController.getApplication);

/**
 * Applications belong to a specific JobPublication cycle.
 *
 * Upload middleware validates a fresh CV and provides
 * trusted metadata through req.jobApplicationResumeUpload.
 *
 * The controller must not trust resume metadata from req.body.
 */
router.post(
  "/job-publications/:publicationId/apply",
  parseJobApplicationResumeUpload,
  professionalJobApplicationController.submitApplication
);

router.post(
  "/job-applications/:applicationId/withdraw",
  professionalJobApplicationController.withdrawApplication
);

// ───────────────────── JOB INTERVIEWS ─────────────────────

router.get("/job-appointments", professionalJobAppointmentController.getAppointments);

router.get("/job-appointments/:appointmentId", professionalJobAppointmentController.getAppointment);

router.post(
  "/job-appointments/:appointmentId/confirm",
  professionalJobAppointmentController.confirmAppointment
);

router.post(
  "/job-appointments/:appointmentId/decline",
  professionalJobAppointmentController.declineAppointment
);

// ───────────────────── SHIFT PAGES ─────────────────────

// Fixed shift paths must precede dynamic shift detail routes.
router.get("/shifts", professionalShiftController.getShifts);

router.get("/shifts/my", professionalShiftController.getMyShifts);

router.get("/shifts/:shiftId/occurrences", professionalShiftController.getShiftOccurrences);

router.get("/shifts/:shiftId", professionalShiftController.getShiftDetails);

// ───────────────────── SHIFT APPLICATIONS ─────────────────────

/**
 * The authenticated user determines the professional profile.
 *
 * Application eligibility, capacity and replacement rules
 * remain service-owned.
 *
 * Withdrawing an application must not cancel an accepted
 * shift assignment.
 */
router.post("/shifts/:shiftId/apply", professionalShiftApplicationController.createApplication);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/apply",
  professionalShiftApplicationController.createApplication
);

router.post(
  "/shifts/:shiftId/applications/:applicationId/withdraw",
  professionalShiftApplicationController.withdrawApplication
);

// ───────────────────── SHIFT ATTENDANCE ─────────────────────

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
 * Absence explanations are handled by attendance.
 *
 * Worked-but-recorded-absent cases must use an
 * attendance_correction claim.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/absence-explanation",
  professionalShiftAttendanceController.submitAbsenceExplanation
);

// ───────────────────── SHIFT CLAIMS ─────────────────────

/**
 * A claim case can contain multiple ordinary BASE-side issues.
 *
 * Settlement-component scope is determined by the claim service.
 * Employer rejection sends unresolved issues for admin review.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/claims",
  professionalShiftClaimController.submitClaim
);

// Withdrawal applies to the claim case and consumes its claim right.
router.post("/claims/:claimId/withdraw", professionalShiftClaimController.withdrawClaim);

// ───────────────────── EMPLOYER DISPUTE RESPONSES ─────────────────────

/**
 * Respond to employer-originated disputes.
 *
 * This workflow remains separate from professional claims.
 */
router.post(
  "/disputes/:disputeId/issues/:issueId/respond",
  professionalShiftClaimController.respondToDispute
);

module.exports = router;
