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
const professionalJobController = require("../controllers/professionalJobController");
const professionalJobApplicationController = require("../controllers/professionalJobApplicationController");
const professionalJobAppointmentController = require("../controllers/professionalJobAppointmentController");

const professionalShiftController = require("../controllers/professionalShiftController");
const professionalShiftApplicationController = require("../controllers/professionalShiftApplicationController");
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

router.get("/cases", professionalShiftClaimController.getCases);

/* ─────────────────────────────── SAVED JOBS ─────────────────────────────── */

router.get("/jobs/saved", professionalJobController.getSavedJobs);

router.post("/jobs/:jobId/save", professionalJobController.saveJob);

router.delete("/jobs/:jobId/save", professionalJobController.unsaveJob);

/* ─────────────────────────────── JOB APPLICATIONS ─────────────────────────────── */

router.get("/job-applications", professionalJobApplicationController.getApplications);

router.get("/job-applications/:applicationId", professionalJobApplicationController.getApplication);

/**
 * Application identity is the exact JobPublication cycle.
 *
 * A fresh CV upload is parsed, validated and stored by trusted middleware.
 * The resulting metadata is placed on req.jobApplicationResumeUpload.
 *
 * The controller never trusts raw resume metadata from req.body.
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

/* ─────────────────────────────── JOB INTERVIEWS ─────────────────────────────── */

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

/* ─────────────────────────────── SHIFT PAGES ─────────────────────────────── */

// Register the fixed My Shifts path before the dynamic shift details path.
router.get("/shifts", professionalShiftController.getShifts);

router.get("/shifts/my", professionalShiftController.getMyShifts);

router.get("/shifts/:shiftId/occurrences", professionalShiftController.getShiftOccurrences);

router.get("/shifts/:shiftId", professionalShiftController.getShiftDetails);

/* ─────────────────────────────── SHIFT APPLICATIONS ─────────────────────────────── */

/**
 * The controller resolves the professional from the authenticated user.
 * The service owns eligibility, capacity and replacement validation.
 * Application withdrawal does not cancel an accepted assignment.
 *
 * The existing application-level CSRF protection and body parser must run
 * before these POST routes. Page handlers also require req.csrfToken().
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
 * One claim case may contain multiple ordinary BASE-side financial/factual
 * issues. Settlement-component scope is derived by the claim service.
 *
 * Employer rejection routes the unresolved issue to admin review.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/claims",
  professionalShiftClaimController.submitClaim
);

/**
 * Withdrawal applies to the claim case and consumes the original claim right.
 */
router.post("/claims/:claimId/withdraw", professionalShiftClaimController.withdrawClaim);

/* ─────────────────────────────── EMPLOYER DISPUTE RESPONSES ─────────────────────────────── */

/**
 * This is the professional response stage for an employer-originated dispute.
 * It is separate from the professional claim lifecycle.
 */
router.post(
  "/disputes/:disputeId/issues/:issueId/respond",
  professionalShiftClaimController.respondToDispute
);

module.exports = router;
