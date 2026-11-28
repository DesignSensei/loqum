// routes/employerRoutes.js

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
  attachEmployerProfile,
  attachEmployerContext,
  canPostShifts,
  canFundShifts,
  canViewWallet,
  canManageWallet,
} = require("../middleware/employerMiddleware");

const { parseFacilityPermitUpload } = require("../middleware/uploadMiddleware");

const employerController = require("../controllers/employerController");
const employerVerificationController = require("../controllers/employerVerificationController");
const employerBranchPermitPageController = require("../controllers/employerBranchPermitPageController");
const branchController = require("../controllers/branchController");
const inviteController = require("../controllers/inviteController");
const teamMemberController = require("../controllers/teamMemberController");
const employerBillingController = require("../controllers/employerBillingController");

const employerJobController = require("../controllers/employerJobController");
const employerJobApplicationController = require("../controllers/employerJobApplicationController");
const employerJobAppointmentController = require("../controllers/employerJobAppointmentController");

const employerShiftController = require("../controllers/employerShiftController");
const employerShiftApplicationController = require("../controllers/employerShiftApplicationController");
const employerShiftAssignmentController = require("../controllers/employerShiftAssignmentController");
const employerShiftAttendanceController = require("../controllers/employerShiftAttendanceController");
const employerShiftClaimController = require("../controllers/employerShiftClaimController");
const employerShiftOvertimeController = require("../controllers/employerShiftOvertimeController");

// ───────────────────── AUTHENTICATION ─────────────────────

router.use(isAuthenticated, isAccountAllowed, isVerified, hasRole("employer"));

// ───────────────────── EMPLOYER VERIFICATION ─────────────────────

// Verification is accessible before onboarding is complete.
// The controller independently checks employer profile ownership.

router.get(
  "/verification/:employerProfileId",
  employerVerificationController.getVerificationStatus
);

router.post("/verification/:employerProfileId/cac", employerVerificationController.verifyCAC);

// ───────────────────── EMPLOYER BUSINESS CONTEXT ─────────────────────

router.use(isOnboarded, attachEmployerProfile, attachEmployerContext);

// ───────────────────── DASHBOARD ─────────────────────

router.get("/dashboard", employerController.getDashboard);

// ───────────────────── CASES ─────────────────────

router.get("/cases", employerShiftClaimController.getCases);

// ───────────────────── BUSINESS PROFILE ─────────────────────

router.get("/business-profile", employerController.getBusinessProfile);

router.get(
  "/business-profile/closure/eligibility",
  employerController.getBusinessClosureEligibility
);

router.post("/business-profile/closure", employerController.postCloseBusiness);

router.post(
  "/business-profile/business-details/update",
  employerController.postUpdateBusinessDetails
);

// ───────────────────── BRANCHES ─────────────────────

router.get("/branches", branchController.getBranches);
router.get("/branches/new", branchController.getNewBranch);
router.get("/branches/:branchId/edit", branchController.getEditBranch);
router.get("/branches/:branchId/members", branchController.getBranchMembers);

router.post("/branches", branchController.postNewBranch);
router.post("/branches/:branchId/edit", branchController.postEditBranch);
router.post("/branches/:branchId/update", branchController.postEditBranch);

router.post("/business-profile/branches/update", branchController.postEditBranch);

// Administrative branch activation/deactivation. The controller and service
// enforce business-scoped owner/admin authority; permit readiness stays separate.
router.post("/branches/:branchId/status", branchController.postSetBranchStatus);

// ───────────────────── BRANCH FACILITY PERMITS ─────────────────────

// Facility permits are submitted after onboarding and belong to an
// individual branch. These routes deliberately do not use canPostShifts:
// obtaining regulatory approval must remain possible before a branch
// becomes eligible to post shifts.
//
// The services enforce active business-wide owner/admin authority.
// Branch managers and ordinary staff cannot manage these permits.
// The upload middleware validates the authenticated employer/branch
// context and provides the private upload commit/cleanup lifecycle.
//
// Keep these routes after attachEmployerProfile/attachEmployerContext.
// CSRF protection must be applied by the application's existing
// global/router-level CSRF middleware before POST requests reach here.

// HTML management page. Keep the existing /permits GET route as JSON.
router.get(
  "/branches/:branchId/permits/manage",
  employerBranchPermitPageController.getBranchPermitsPage
);

router.get("/branches/:branchId/permits", employerVerificationController.getBranchFacilityPermits);

router.get(
  "/branches/:branchId/permits/readiness",
  employerVerificationController.getBranchVerificationReadiness
);

router.post(
  "/branches/:branchId/permits",
  parseFacilityPermitUpload,
  employerVerificationController.submitFacilityPermit
);

// ───────────────────── TEAM MEMBERS ─────────────────────

router.get("/business-profile/team-members/:memberId", teamMemberController.getTeamMember);

router.post(
  "/business-profile/team-members/:memberId/update",
  teamMemberController.postUpdateTeamMember
);

router.post(
  "/business-profile/team-members/:memberId/remove",
  teamMemberController.postRemoveTeamMember
);

// ───────────────────── INVITES ─────────────────────

router.get("/invites", inviteController.getInvites);
router.post("/invites", inviteController.postSendInvite);

router.post("/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites", inviteController.postSendInvite);

router.post("/business-profile/invites/:inviteId/resend", inviteController.postResendInvite);

router.post("/business-profile/invites/:inviteId/update", inviteController.postUpdateInvite);

router.post("/business-profile/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites/revoke", inviteController.postRevokeInvite);

// ───────────────────── PERMANENT JOB PAGES ─────────────────────

router.get("/jobs", employerJobController.getJobs);
router.get("/jobs/new", employerJobController.getCreateJob);

router.get("/jobs/:jobId/applications", employerJobApplicationController.getApplications);

router.get("/jobs/:jobId/edit", employerJobController.getEditJob);

router.get("/jobs/:jobId/publish", employerJobController.getPublicationReview);

router.post("/jobs/:jobId/publish/confirm", employerJobController.confirmPublication);

router.get("/jobs/:jobId", employerJobController.getJob);

// ───────────────────── PERMANENT JOB COMMANDS ─────────────────────

router.post("/jobs", employerJobController.createDraft);

router.post("/jobs/:jobId/update", employerJobController.updateJob);

router.post("/jobs/:jobId/archive", employerJobController.archiveJob);

router.post("/jobs/:jobId/delete", employerJobController.deleteDraftJob);

// ───────────────────── JOB PUBLICATION ─────────────────────

// Publication eligibility and entitlement remain service-owned.

router.post("/jobs/:jobId/publish", employerJobController.publishJob);

router.post("/jobs/:jobId/renew", employerJobController.renewJobPublication);

router.post("/job-publications/:publicationId/pause", employerJobController.pausePublication);

router.post("/job-publications/:publicationId/resume", employerJobController.resumePublication);

router.post(
  "/job-publications/:publicationId/application-deadline",
  employerJobController.adjustApplicationDeadline
);

router.post("/job-publications/:publicationId/end", employerJobController.endPublication);

router.post("/jobs/:jobId/close-recruitment", employerJobController.closeRecruitment);

// ───────────────────── JOB APPLICATION PAGES ─────────────────────

router.get("/job-applications", employerJobApplicationController.getApplications);

router.get("/job-applications/:applicationId", employerJobApplicationController.getApplication);

// ───────────────────── JOB APPLICATION COMMANDS ─────────────────────

router.post(
  "/job-applications/:applicationId/under-review",
  employerJobApplicationController.markUnderReview
);

router.post(
  "/job-applications/:applicationId/shortlist",
  employerJobApplicationController.shortlistApplication
);

router.post(
  "/job-applications/:applicationId/interview",
  employerJobApplicationController.moveApplicationToInterview
);

router.post(
  "/job-applications/:applicationId/offer",
  employerJobApplicationController.offerApplication
);

router.post(
  "/job-applications/:applicationId/reject",
  employerJobApplicationController.rejectApplication
);

// Hiring must use the publication finalization workflow.

router.post(
  "/job-applications/:applicationId/hire",
  employerJobApplicationController.hireApplication
);

// ───────────────────── JOB INTERVIEW PAGES ─────────────────────

router.get("/job-appointments", employerJobAppointmentController.getAppointments);

router.get("/job-appointments/:appointmentId", employerJobAppointmentController.getAppointment);

// ───────────────────── JOB INTERVIEW COMMANDS ─────────────────────

router.post(
  "/job-applications/:applicationId/interviews",
  employerJobAppointmentController.inviteApplicationToInterview
);

router.post(
  "/job-appointments/:appointmentId/reschedule",
  employerJobAppointmentController.rescheduleAppointment
);

router.post(
  "/job-appointments/:appointmentId/cancel",
  employerJobAppointmentController.cancelAppointment
);

router.post(
  "/job-appointments/:appointmentId/complete",
  employerJobAppointmentController.completeAppointment
);

router.post(
  "/job-appointments/:appointmentId/no-show",
  employerJobAppointmentController.recordNoShow
);

// ───────────────────── SHIFT PAGES ─────────────────────

router.get("/shifts", employerShiftController.getManageShifts);

router.get("/shifts/applications", employerShiftApplicationController.getApplications);

router.get("/shifts/assignments", employerShiftAssignmentController.getAssignments);

router.get("/shifts/attendance", employerShiftAttendanceController.getAttendance);

router.get("/shifts/:shiftId/occurrences", employerShiftController.getShiftOccurrences);

router.get("/shifts/:shiftId/cancellation-preview", employerShiftController.getCancellationPreview);

// ───────────────────── SHIFT APPLICATIONS ─────────────────────

router.post(
  "/shifts/applications/:applicationId/shortlist",
  employerShiftApplicationController.shortlistApplication
);

router.post(
  "/shifts/applications/:applicationId/reject",
  employerShiftApplicationController.rejectApplication
);

router.post(
  "/shifts/applications/:applicationId/accept",
  employerShiftApplicationController.acceptApplication
);

// ───────────────────── SHIFT ASSIGNMENTS ─────────────────────

router.post(
  "/shifts/assignments/:assignmentId/issues",
  employerShiftAssignmentController.reportAssignmentIssue
);

router.post(
  "/shifts/assignments/:assignmentId/cases/:caseId/respond",
  employerShiftAssignmentController.respondToAssignmentCase
);

// ───────────────────── SHIFT ASSIGNMENTS ─────────────────────

router.post(
  "/shifts/assignments/:assignmentId/cases/:caseId/escalate",
  employerShiftAssignmentController.escalateAssignmentCase
);

// ───────────────────── ATTENDANCE PINS ─────────────────────

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in-pin",
  employerShiftAttendanceController.getCheckInPin
);

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out-pin",
  employerShiftAttendanceController.getCheckOutPin
);

// ───────────────────── SHIFT OVERTIME ─────────────────────

// Existing obligations must remain manageable during delinquency.

/**
 * Read-only evidence retrieval.
 *
 * The employer overtime controller:
 * - verifies the occurrence belongs to the requested Shift;
 * - verifies employer/business/branch permissions;
 * - loads the evidence reference from the saved occurrence;
 * - opens the private file using local storage or AWS S3; and
 * - streams the file without exposing the storage location.
 *
 * This route does not require canPostShifts or canFundShifts,
 * because it concerns an existing Shift obligation.
 */
router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/evidence/:evidenceIndex",
  employerShiftOvertimeController.getOvertimeEvidence
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/approve",
  employerShiftOvertimeController.approveOvertime
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/reject",
  employerShiftOvertimeController.rejectOvertime
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/top-up/wallet",
  employerShiftOvertimeController.fundOvertimeTopUpFromWallet
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/top-up/checkout",
  employerShiftOvertimeController.initializeOvertimeTopUpCheckout
);

// ───────────────────── EMPLOYER DISPUTES ─────────────────────

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/disputes",
  employerShiftClaimController.submitDispute
);

router.post("/shifts/disputes/:disputeId/withdraw", employerShiftClaimController.withdrawDispute);

// ───────────────────── PROFESSIONAL CLAIM REVIEW ─────────────────────

router.post(
  "/shifts/claims/:claimId/issues/:issueId/review",
  employerShiftClaimController.reviewClaim
);

// ───────────────────── SHIFT DETAILS ─────────────────────

router.get("/shifts/:shiftId", employerShiftController.getShiftDetails);

// ───────────────────── SHIFT CREATION ─────────────────────

router.post("/shifts", canPostShifts, employerShiftController.postShift);

// ───────────────────── INITIAL SHIFT FUNDING ─────────────────────

router.post(
  "/shifts/:shiftId/fund-from-wallet",
  canPostShifts,
  canFundShifts,
  employerShiftController.fundShiftFromWallet
);

router.post(
  "/shifts/:shiftId/initialize-checkout",
  canPostShifts,
  canFundShifts,
  employerShiftController.initializeShiftCheckout
);

// ───────────────────── SHIFT LIFECYCLE ─────────────────────

router.post("/shifts/:shiftId/cancel", employerShiftController.postCancelShift);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/active-work-cancellation",
  employerShiftController.postActiveWorkCancellation
);

// ───────────────────── BILLING / WALLET ─────────────────────

router.get("/billing", canViewWallet, employerBillingController.getBilling);

router.get("/billing/wallet", canViewWallet, (req, res) => {
  return res.redirect("/employer/billing");
});

// ───────────────────── EMPLOYER MONETISATION ─────────────────────

router.get(
  "/billing/job-publication-plans",
  canViewWallet,
  employerBillingController.getJobPublicationPlans
);

router.get(
  "/billing/subscription-plans",
  canViewWallet,
  employerBillingController.getSubscriptionPlans
);

router.get("/billing/subscription", canViewWallet, employerBillingController.getActiveSubscription);

// ───────────────────── JOB PUBLICATION PURCHASES ─────────────────────

router.post(
  "/billing/job-publications/purchase/wallet",
  canManageWallet,
  employerBillingController.purchaseJobPublicationFromWallet
);

router.post(
  "/billing/job-publications/verify",
  employerBillingController.verifyJobPublicationPayment
);

router.post(
  "/billing/job-publications/initialize-checkout",
  employerBillingController.initializeJobPublicationCheckout
);

// ───────────────────── SUBSCRIPTION PURCHASES ─────────────────────

router.post(
  "/billing/subscriptions/purchase/wallet",
  canManageWallet,
  employerBillingController.purchaseInitialSubscriptionFromWallet
);

router.post(
  "/billing/subscriptions/initialize-checkout",
  canManageWallet,
  employerBillingController.initializeInitialSubscriptionCheckout
);

// ───────────────────── SUBSCRIPTION PLAN CHANGES ─────────────────────

router.post(
  "/billing/subscriptions/:subscriptionId/plan-change/wallet",
  canManageWallet,
  employerBillingController.purchaseSubscriptionPlanChangeFromWallet
);

router.post(
  "/billing/subscriptions/:subscriptionId/plan-change/initialize-checkout",
  canManageWallet,
  employerBillingController.initializeSubscriptionPlanChangeCheckout
);

// ───────────────────── SUBSCRIPTION RENEWALS ─────────────────────

router.post(
  "/billing/subscriptions/:subscriptionId/renew/wallet",
  canManageWallet,
  employerBillingController.purchaseSubscriptionRenewalFromWallet
);

router.post(
  "/billing/subscriptions/:subscriptionId/renew/initialize-checkout",
  canManageWallet,
  employerBillingController.initializeSubscriptionRenewalCheckout
);

// ───────────────────── SUBSCRIPTION PAYMENT RECOVERY ─────────────────────

router.post(
  "/billing/subscription-payments/:paymentId/verify",
  canManageWallet,
  employerBillingController.verifySubscriptionPayment
);

// ───────────────────── AUTOMATIC RENEWAL ─────────────────────

router.post(
  "/billing/subscriptions/:subscriptionId/automatic-renewal",
  canManageWallet,
  employerBillingController.updateSubscriptionAutomaticRenewal
);

// ───────────────────── SUBSCRIPTION CANCELLATION ─────────────────────

router.post(
  "/billing/subscriptions/:subscriptionId/cancel",
  canManageWallet,
  employerBillingController.requestSubscriptionCancellation
);

// ───────────────────── WALLET MANAGEMENT ─────────────────────

router.post("/billing/setup-dva", canManageWallet, employerBillingController.postSetupDVA);

router.post(
  "/billing/resolve-withdrawal-account",
  canManageWallet,
  employerBillingController.resolveWithdrawalAccount
);

router.post(
  "/billing/withdrawal-account",
  canManageWallet,
  employerBillingController.saveWithdrawalAccount
);

router.post(
  "/billing/withdrawal-account/remove",
  canManageWallet,
  employerBillingController.removeWithdrawalAccount
);

router.post("/billing/withdraw", canManageWallet, employerBillingController.initiateWithdrawal);

module.exports = router;
