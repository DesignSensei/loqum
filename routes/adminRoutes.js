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
  requireActiveAdmin,
  attachAdminEmployerContext,
  requireAdminEmployerContext,
} = require("../middleware/adminMiddleware");

const adminController = require("../controllers/adminController");
const adminShiftClaimController = require("../controllers/adminShiftClaimController");

const adminPlatformSettingsController = require("../controllers/adminPlatformSettingsController");
const adminSubscriptionPlanController = require("../controllers/adminSubscriptionPlanController");

const adminShiftController = require("../controllers/adminShiftController");
const adminShiftApplicationController = require("../controllers/adminShiftApplicationController");

const adminJobController = require("../controllers/adminJobController");
const adminJobApplicationController = require("../controllers/adminJobApplicationController");
const adminJobAppointmentController = require("../controllers/adminJobAppointmentController");

const adminEmployerVerificationController = require("../controllers/adminEmployerVerificationController");
const adminProfessionalVerificationController = require("../controllers/adminProfessionalVerificationController");

const adminUserController = require("../controllers/adminUserController");

// Mount application CSRF protection before this router for mutations.
router.use(isAuthenticated, isAccountAllowed, isVerified, hasRole("admin"), requireActiveAdmin);

// Admin pages
router.get("/dashboard", adminController.getDashboard);
router.get("/cases", adminShiftClaimController.getCases);

// User management
router.get("/users", adminUserController.getUsersPage);
router.get("/users/data", adminUserController.getUsersData);

router.get("/users/:userId/data", adminUserController.getUserDetailsData);
router.get("/users/:userId", adminUserController.getUserDetailsPage);

// Employer verification
router.get("/employer-verifications", adminEmployerVerificationController.getDashboardPage);
router.get("/employer-verifications/data", adminEmployerVerificationController.listEmployers);

router.get(
  "/employer-verifications/permits",
  adminEmployerVerificationController.listFacilityPermits
);

router.get(
  "/employers/:employerProfileId/verification",
  adminEmployerVerificationController.getEmployerVerification
);

router.post(
  "/employers/:employerProfileId/verification/cac/recheck",
  adminEmployerVerificationController.recheckCAC
);

router.get(
  "/employers/:employerProfileId/branches/:branchId/permits/:permitId",
  adminEmployerVerificationController.getFacilityPermit
);

router.get(
  "/employers/:employerProfileId/branches/:branchId/permits/:permitId/document",
  adminEmployerVerificationController.viewFacilityPermitDocument
);

router.post(
  "/employers/:employerProfileId/branches/:branchId/permits/:permitId/review",
  adminEmployerVerificationController.reviewFacilityPermit
);

router.post(
  "/employers/:employerProfileId/branches/:branchId/permits/:permitId/revoke",
  adminEmployerVerificationController.revokeFacilityPermit
);

// Professional verification
router.get("/professional-verifications", adminProfessionalVerificationController.getDashboardPage);

router.get(
  "/professional-verifications/summary",
  adminProfessionalVerificationController.getDashboard
);

router.get(
  "/professional-verifications/data",
  adminProfessionalVerificationController.listProfessionals
);

router.get(
  "/professional-verifications/attempts/:verificationId",
  adminProfessionalVerificationController.getVerificationAttempt
);

router.get(
  "/professionals/:professionalProfileId/verification",
  adminProfessionalVerificationController.getProfessionalVerification
);

router.get(
  "/professionals/:professionalProfileId/verification/licence/document",
  adminProfessionalVerificationController.viewLicenceDocument
);

router.post(
  "/professionals/:professionalProfileId/verification/licence/review",
  adminProfessionalVerificationController.reviewLicence
);

router.post(
  "/professionals/:professionalProfileId/verification/approval/review",
  adminProfessionalVerificationController.reviewProfessionalApproval
);

// Shift oversight
router.get("/shifts", adminShiftController.getShifts);
router.get("/shifts/data", adminShiftController.getShiftsData);
router.get("/shifts/attention", adminShiftController.getAttentionQueue);
router.get("/shifts/attention/data", adminShiftController.getAttentionQueueData);

// Shift cancellation history
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

// Shift application oversight
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

// Shift details
router.get("/shifts/:shiftId/data", adminShiftController.getShiftDetailsData);
router.get("/shifts/:shiftId", adminShiftController.getShiftDetails);

// Employer-targeted shift cancellation
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

// Employer subscription oversight

const adminSubscriptionController = require("../controllers/adminSubscriptionController");

router.get("/subscriptions", adminSubscriptionController.getSubscriptions);
router.get("/subscriptions/:subscriptionId", adminSubscriptionController.getSubscription);

// Subscription plan administration

router.get(
  "/subscription-plans",
  adminSubscriptionPlanController.getPlansPage
);

router.get(
  "/subscription-plans/data",
  adminSubscriptionPlanController.listPlans
);

router.get(
  "/subscription-plans/:planId/data",
  adminSubscriptionPlanController.getPlan
);

router.post(
  "/subscription-plans",
  adminSubscriptionPlanController.createDraft
);

router.post(
  "/subscription-plans/:planId/update",
  adminSubscriptionPlanController.updateDraft
);

router.post(
  "/subscription-plans/:planId/activate",
  adminSubscriptionPlanController.activatePlan
);

router.post(
  "/subscription-plans/:planId/retire",
  adminSubscriptionPlanController.retirePlan
);

// Platform settings
router.get("/platform-settings", adminPlatformSettingsController.getPlatformSettings);

// Country settings
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

// Platform policies
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

// Permanent Job oversight
router.get("/jobs", adminJobController.getJobs);
router.get("/jobs/:jobId", adminJobController.getJob);

// Job application oversight
router.get("/job-applications", adminJobApplicationController.getApplications);

router.get("/job-applications/:applicationId", adminJobApplicationController.getApplication);

// Job appointment oversight
router.get("/job-appointments", adminJobAppointmentController.getAppointments);

router.get("/job-appointments/:appointmentId", adminJobAppointmentController.getAppointment);

// Employer-targeted Job support
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

// Employer-targeted Job publication support
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

// Professional claim adjudication
router.post(
  "/shift-claims/:claimId/issues/:issueId/resolve",
  adminShiftClaimController.resolveClaim
);

// Employer dispute adjudication
router.post(
  "/shift-disputes/:disputeId/issues/:issueId/resolve",
  adminShiftClaimController.resolveDispute
);

// Historical financial obligation reconciliation.
const adminFinancialObligationController = require("../controllers/adminFinancialObligationController");
router.get("/financial-obligations/data", adminFinancialObligationController.list);
router.post("/financial-obligations/:obligationId/refund", adminFinancialObligationController.refund);
router.post("/financial-obligations/:obligationId/reconcile", adminFinancialObligationController.reconcile);

router.post(
  "/financial-obligations/:obligationId/payout",
  adminFinancialObligationController.payout
);

router.post(
  "/financial-obligations/:obligationId/reconcile-payout",
  adminFinancialObligationController.reconcilePayout
);

router.post("/financial-obligations/:obligationId/recover-refund", adminFinancialObligationController.recoverRefund);
router.post("/financial-obligations/:obligationId/retry-payout", adminFinancialObligationController.retryPayout);
router.post("/financial-obligations/:obligationId/payout-otp", adminFinancialObligationController.payoutOtp);


router.get(
  "/financial-obligations",
  adminFinancialObligationController.getDashboardPage
);

router.get(
  "/financial-obligations/:obligationId",
  adminFinancialObligationController.getObligationPage
);

module.exports = router;
