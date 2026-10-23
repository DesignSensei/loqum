// routes/adminRoutes.js

const express = require("express");

const router = express.Router();

const {
  isAuthenticated,
  isVerified,
  isAccountAllowed,
  hasRole,
} = require("../middleware/authMiddleware");

const {
  attachAdminEmployerContext,
  requireAdminEmployerContext,
} = require("../middleware/adminMiddleware");

const adminController = require("../controllers/adminController");
const adminShiftClaimController = require("../controllers/adminShiftClaimController");
const adminPlatformSettingsController = require("../controllers/adminPlatformSettingsController");

const adminShiftController = require("../controllers/adminShiftController");
const adminShiftApplicationController = require("../controllers/adminShiftApplicationController");

const adminJobController = require("../controllers/adminJobController");
const adminJobApplicationController = require("../controllers/adminJobApplicationController");
const adminJobAppointmentController = require("../controllers/adminJobAppointmentController");

const adminEmployerVerificationController = require("../controllers/adminEmployerVerificationController");

const adminUserController = require("../controllers/adminUserController");

/* ─────────────────────────────── ROUTE PROTECTION ─────────────────────────────── */

router.use(isAuthenticated, isAccountAllowed, isVerified, hasRole("admin"));

/* ─────────────────────────────── ADMIN PAGES ─────────────────────────────── */

router.get("/dashboard", adminController.getDashboard);

router.get("/cases", adminShiftClaimController.getCases);

/* ─────────────────────────────── USER MANAGEMENT ─────────────────────────────── */

/**
 * Admin user management supports employers and professionals.
 *
 * Both roles share the same management interface.
 *
 * The service prepares:
 * - User records
 * - Verification summaries
 * - Approval statuses
 * - Account statuses
 * - Summary counts
 * - Search and filtering
 * - Pagination
 *
 * Individual user details include the appropriate
 * employer or professional profile.
 *
 * These endpoints are read-only.
 * Verification decisions and account changes
 * are handled by their respective services.
 */

// Employers and Professionals management page
router.get("/users", adminUserController.getUsersPage);

// Filtered users and summary card data
router.get("/users/data", adminUserController.getUsersData);

// Individual user details and verification summary
router.get("/users/:userId/data", adminUserController.getUserDetailsData);

router.get("/users/:userId", adminUserController.getUserDetailsPage);

/* ─────────────────────────────── EMPLOYER VERIFICATION ─────────────────────────────── */

/**
 * Employer verification is managed by platform administrators.
 *
 * The page route renders the verification interface.
 * The data route returns the employer verification queue as JSON.
 *
 * Employer-specific endpoints provide verification details,
 * controlled CAC rechecks, and manual PCN review.
 *
 * These operations do not impersonate employers.
 *
 * Actual verification decisions remain service-owned.
 * Final employer approval is handled separately.
 *
 * All mutation routes must remain protected by the
 * application's existing CSRF middleware.
 */

// Employer verification page
router.get("/employer-verifications", adminEmployerVerificationController.getDashboardPage);

// Employer verification queue data
router.get("/employer-verifications/data", adminEmployerVerificationController.listEmployers);

// Individual employer verification details and history
router.get(
  "/employers/:employerProfileId/verification",
  adminEmployerVerificationController.getEmployerVerification
);

// Controlled CAC verification recheck
router.post(
  "/employers/:employerProfileId/verification/cac/recheck",
  adminEmployerVerificationController.recheckCAC
);

// Manual PCN premises review
router.post(
  "/employers/:employerProfileId/verification/pcn/review",
  adminEmployerVerificationController.reviewPCN
);

/* ─────────────────────────────── SHIFT OVERSIGHT ─────────────────────────────── */

/**
 * Admin shift reads provide platform oversight without employer impersonation.
 * Keep fixed paths before /shifts/:shiftId so they are not treated as shift IDs.
 *
 * Page handlers require the application's existing CSRF middleware and templates.
 */

router.get("/shifts", adminShiftController.getShifts);

router.get("/shifts/data", adminShiftController.getShiftsData);

router.get("/shifts/attention", adminShiftController.getAttentionQueue);

router.get("/shifts/attention/data", adminShiftController.getAttentionQueueData);

/* ─────────────────────────────── SHIFT CANCELLATION HISTORY ─────────────────────────────── */

router.get("/shifts/cancellations", adminShiftController.getCancellationRequests);

router.get("/shifts/cancellations/data", adminShiftController.getCancellationRequestsData);

router.get(
  "/shifts/cancellations/:requestReference/data",
  adminShiftController.getCancellationRequestDetailsData
);

router.get(
  "/shifts/cancellations/:requestReference",
  adminShiftController.getCancellationRequestDetails
);

/* ─────────────────────────────── SHIFT APPLICATION OVERSIGHT ─────────────────────────────── */

/**
 * Application oversight is read-only and scoped to one shift.
 * Shortlisting, acceptance and rejection remain employer-owned.
 */

router.get("/shifts/:shiftId/applications", adminShiftApplicationController.getApplications);

router.get(
  "/shifts/:shiftId/applications/data",
  adminShiftApplicationController.getApplicationsData
);

router.get(
  "/shifts/:shiftId/applications/:applicationId/data",
  adminShiftApplicationController.getApplicationDetailsData
);

router.get(
  "/shifts/:shiftId/applications/:applicationId",
  adminShiftApplicationController.getApplicationDetails
);

/* ─────────────────────────────── SHIFT DETAILS ─────────────────────────────── */

router.get("/shifts/:shiftId/data", adminShiftController.getShiftDetailsData);

router.get("/shifts/:shiftId", adminShiftController.getShiftDetails);

/* ─────────────────────────────── EMPLOYER-TARGETED SHIFT CANCELLATION ─────────────────────────────── */

/**
 * Preview is read-only. Confirm records the reviewed employer instruction and
 * executes cancellation in one service transaction. There is no separate
 * request-creation endpoint and no platform-initiated cancellation endpoint.
 *
 * Both routes retain the actual admin actor and verify the selected employer.
 * The application's CSRF protection must run before the POST handler, as for
 * the other mutation routes in this router. JSON parsing must also be mounted.
 *
 * For individual occurrence cancellation, supply occurrenceId and scope in the
 * query (preview) or JSON body (confirm); whole-shift cancellation uses scope=shift.
 */

router.get(
  "/employers/:employerProfileId/shifts/:shiftId/cancellation-preview",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminShiftController.getCancellationPreview
);

router.post(
  "/employers/:employerProfileId/shifts/:shiftId/cancel",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminShiftController.cancelOnEmployerBehalf
);

/* ─────────────────────────────── PLATFORM SETTINGS ─────────────────────────────── */

/**
 * Platform settings are admin-owned configuration.
 *
 * The controller exposes JSON read/update endpoints while
 * AdminPlatformSettingsService remains the authority for validation
 * and persistence.
 */

router.get("/platform-settings", adminPlatformSettingsController.getPlatformSettings);

/* ─────────────────────────────── COUNTRY SETTINGS ─────────────────────────────── */

router.post("/platform-settings/countries", adminPlatformSettingsController.addCountrySetting);

router.patch(
  "/platform-settings/countries/:countryCode/platform-fee",
  adminPlatformSettingsController.updateCountryPlatformFee
);

router.patch(
  "/platform-settings/countries/:countryCode/currency",
  adminPlatformSettingsController.updateCountryCurrency
);

router.patch(
  "/platform-settings/countries/:countryCode/financial-limits",
  adminPlatformSettingsController.updateCountryFinancialLimits
);

router.patch(
  "/platform-settings/countries/:countryCode/protected-shift-limits/:facilityType",
  adminPlatformSettingsController.updateCountryProtectedShiftLimits
);

router.post(
  "/platform-settings/countries/:countryCode/activate",
  adminPlatformSettingsController.activateCountrySetting
);

router.post(
  "/platform-settings/countries/:countryCode/deactivate",
  adminPlatformSettingsController.deactivateCountrySetting
);

router.post(
  "/platform-settings/countries/:countryCode/default",
  adminPlatformSettingsController.setDefaultCountry
);

/* ─────────────────────────────── PLATFORM POLICIES ─────────────────────────────── */

router.patch(
  "/platform-settings/shift-cancellation",
  adminPlatformSettingsController.updateShiftCancellationPolicy
);

router.patch(
  "/platform-settings/attendance",
  adminPlatformSettingsController.updateAttendancePolicy
);

router.patch(
  "/platform-settings/occurrence-challenges",
  adminPlatformSettingsController.updateOccurrenceChallengePolicy
);

router.patch("/platform-settings/overtime", adminPlatformSettingsController.updateOvertimePolicy);

router.patch(
  "/platform-settings/professional-settlement",
  adminPlatformSettingsController.updateProfessionalSettlementSchedule
);

router.patch("/platform-settings/location", adminPlatformSettingsController.updateLocationPolicy);

router.patch("/platform-settings/job-board", adminPlatformSettingsController.updateJobBoardPolicy);

router.patch("/platform-settings/credits", adminPlatformSettingsController.updateCreditsPolicy);

/* ─────────────────────────────── PERMANENT JOB OVERSIGHT ─────────────────────────────── */

/**
 * Platform-admin Job reads are oversight reads.
 *
 * They do not establish employerContext and do not impersonate an employer.
 */

router.get("/jobs", adminJobController.getJobs);

router.get("/jobs/:jobId", adminJobController.getJob);

/* ─────────────────────────────── JOB APPLICATION OVERSIGHT ─────────────────────────────── */

/**
 * Admin application access is read-only platform oversight.
 * Candidate-stage transitions remain employer-owned.
 */

router.get("/job-applications", adminJobApplicationController.getApplications);

router.get("/job-applications/:applicationId", adminJobApplicationController.getApplication);

/* ─────────────────────────────── JOB APPOINTMENT OVERSIGHT ─────────────────────────────── */

/**
 * Admin appointment access is read-only platform oversight.
 *
 * Scheduling and interview lifecycle mutations remain employer/professional-owned.
 */

router.get("/job-appointments", adminJobAppointmentController.getAppointments);

router.get("/job-appointments/:appointmentId", adminJobAppointmentController.getAppointment);

/* ─────────────────────────────── EMPLOYER-TARGETED JOB SUPPORT ─────────────────────────────── */

/**
 * Admin Job support must first establish one exact employer context.
 *
 * attachAdminEmployerContext records the real admin actor and selected employer.
 * requireAdminEmployerContext verifies that trusted context before the controller
 * invokes Job services.
 *
 * This does not create employerContext and does not impersonate the employer.
 */

router.post(
  "/employers/:employerProfileId/jobs",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.createDraft
);

router.patch(
  "/employers/:employerProfileId/jobs/:jobId",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.updateJob
);

router.delete(
  "/employers/:employerProfileId/jobs/:jobId",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.deleteDraftJob
);

/* ─────────────────────────────── EMPLOYER-TARGETED JOB PUBLICATION SUPPORT ─────────────────────────────── */

/**
 * Publish and renew resolve publication authority through
 * JobPublicationEntitlementService inside adminJobController.
 *
 * Admin support obey the same publication eligibility and entitlement policy
 * as the employer path. Admin does not bypass or construct an entitlement grant.
 */

router.post(
  "/employers/:employerProfileId/jobs/:jobId/publish",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.publishJob
);

router.post(
  "/employers/:employerProfileId/jobs/:jobId/renew",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.renewJobPublication
);

router.post(
  "/employers/:employerProfileId/job-publications/:publicationId/pause",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.pausePublication
);

router.post(
  "/employers/:employerProfileId/job-publications/:publicationId/resume",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.resumePublication
);

router.patch(
  "/employers/:employerProfileId/job-publications/:publicationId/application-deadline",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.adjustApplicationDeadline
);

router.post(
  "/employers/:employerProfileId/job-publications/:publicationId/end",
  attachAdminEmployerContext,
  requireAdminEmployerContext,
  adminJobController.endPublication
);

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
