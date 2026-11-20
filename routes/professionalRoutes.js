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

const {
  attachProfessionalProfile,
  canApplyForShifts,
} = require("../middleware/professionalMiddleware");

const {
  parseJobApplicationResumeUpload,
  parseProfessionalOvertimeEvidenceUpload,
  parseProfessionalLicenceUpload,
} = require("../middleware/uploadMiddleware");

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

// Post-onboarding licence submission reuses trusted NIN evidence from onboarding.
// Uploads remain private and require independent admin review.
// Pending renewals preserve a current approved licence; expired licences never
// authorize work, including during the 30-day renewal grace period.
// Controllers/services enforce ownership and state transitions.
// Mount the application's CSRF protection before this router.

// Read the professional's verification status.
router.get(
  "/verification/:professionalProfileId",
  professionalVerificationController.getVerificationStatus
);

// Upload licenceDocument through the private upload middleware, then persist
// the submission before committing the file. Do not require shift eligibility.
router.post(
  "/verification/:professionalProfileId/licence-document",
  parseProfessionalLicenceUpload,
  professionalVerificationController.submitLicenceDocument
);

// Submit a corrected or replacement licence number.
router.post(
  "/verification/:professionalProfileId/licence-number",
  professionalVerificationController.changeLicenceNumber
);

// ───────────────────── PROFESSIONAL PAGES ─────────────────────

router.get("/dashboard", professionalController.getDashboard);

router.get("/cases", professionalShiftClaimController.getCases);

// ───────────────────── PROFESSIONAL PROFILE ─────────────────────

// View professional profile and its tabs.
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

// Applications belong to a publication cycle. Resume metadata must come
// from the upload middleware, not client-supplied request fields.
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

// Keep fixed shift paths before dynamic shift detail routes.

router.get("/shifts", professionalShiftController.getShifts);

router.get("/shifts/my-shifts", professionalShiftController.getMyShifts);

router.get("/shifts/:shiftId/occurrences", professionalShiftController.getShiftOccurrences);

router.get("/shifts/:shiftId", professionalShiftController.getShiftDetails);

// ───────────────────── SHIFT APPLICATIONS ─────────────────────

// Middleware checks current professional eligibility before application.
// Services recheck licence evidence, approval and eligibility in transactions.
// Withdrawal must not cancel an accepted assignment.

// Apply for a shift.
router.post(
  "/shifts/:shiftId/apply",
  canApplyForShifts,
  professionalShiftApplicationController.createApplication
);

// Apply for a specific shift occurrence.
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/apply",
  canApplyForShifts,
  professionalShiftApplicationController.createApplication
);

// Withdraw a pending shift application.
router.post(
  "/shifts/:shiftId/applications/:applicationId/withdraw",
  professionalShiftApplicationController.withdrawApplication
);

// ───────────────────── SHIFT ATTENDANCE ─────────────────────

// Check-in verifies the occurrence PIN and the professional's location.
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in",
  professionalShiftAttendanceController.checkIn
);

// Checkout may include privately stored overtime evidence.
// Attendance and overtime rules remain service-owned.
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out",
  parseProfessionalOvertimeEvidenceUpload,
  professionalShiftAttendanceController.checkOut
);

// Checkout fallback requires attendance review.
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/checkout-fallback",
  professionalShiftAttendanceController.requestCheckoutFallback
);

// Attendance handles absence explanations; worked-but-recorded-absent
// cases use an attendance_correction claim.
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/absence-explanation",
  professionalShiftAttendanceController.submitAbsenceExplanation
);

// ───────────────────── SHIFT CLAIMS ─────────────────────

// Claim scope and settlement rules remain service-owned.
// Rejected claims proceed to admin review.
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/claims",
  professionalShiftClaimController.submitClaim
);

// Withdrawal applies to the claim case and consumes its claim right.
router.post("/claims/:claimId/withdraw", professionalShiftClaimController.withdrawClaim);

// ───────────────────── EMPLOYER DISPUTE RESPONSES ─────────────────────

// Employer dispute responses are separate from professional claims.
router.post(
  "/disputes/:disputeId/issues/:issueId/respond",
  professionalShiftClaimController.respondToDispute
);

module.exports = router;
