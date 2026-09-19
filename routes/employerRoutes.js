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

const employerController = require("../controllers/employerController");
const branchController = require("../controllers/branchController");
const inviteController = require("../controllers/inviteController");
const teamMemberController = require("../controllers/teamMemberController");
const employerBillingController = require("../controllers/employerBillingController");

const employerShiftController = require("../controllers/employerShiftController");
const employerShiftApplicationController = require("../controllers/employerShiftApplicationController");
const employerShiftAssignmentController = require("../controllers/employerShiftAssignmentController");
const employerShiftAttendanceController = require("../controllers/employerShiftAttendanceController");
const employerShiftClaimController = require("../controllers/employerShiftClaimController");
const employerShiftOvertimeController = require("../controllers/employerShiftOvertimeController");

/* ───────────────────── ROUTE PROTECTION ───────────────────── */

router.use(
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isOnboarded,
  attachEmployerProfile,
  attachEmployerContext
);

/* ───────────────────── DASHBOARD ───────────────────── */

router.get("/dashboard", employerController.getDashboard);

/* ───────────────────── CASES ───────────────────── */

// Read access is scoped by employer context; mutation authority remains service-owned.
router.get("/cases", employerShiftClaimController.getCases);

/* ───────────────────── BUSINESS PROFILE ───────────────────── */

router.get("/business-profile", employerController.getBusinessProfile);

router.post(
  "/business-profile/business-details/update",
  employerController.postUpdateBusinessDetails
);

/* ───────────────────── BRANCHES ───────────────────── */

router.get("/branches", branchController.getBranches);

router.get("/branches/new", branchController.getNewBranch);

router.get("/branches/:branchId/edit", branchController.getEditBranch);

router.get("/branches/:branchId/members", branchController.getBranchMembers);

router.post("/branches", branchController.postNewBranch);

router.post("/branches/:branchId/edit", branchController.postEditBranch);

router.post("/branches/:branchId/update", branchController.postEditBranch);

router.post("/business-profile/branches/update", branchController.postEditBranch);

/* ───────────────────── TEAM MEMBERS ───────────────────── */

router.get("/business-profile/team-members/:memberId", teamMemberController.getTeamMember);

router.post(
  "/business-profile/team-members/:memberId/update",
  teamMemberController.postUpdateTeamMember
);

router.post(
  "/business-profile/team-members/:memberId/remove",
  teamMemberController.postRemoveTeamMember
);

/* ───────────────────── INVITES ───────────────────── */

router.get("/invites", inviteController.getInvites);

router.post("/invites", inviteController.postSendInvite);

router.post("/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites", inviteController.postSendInvite);

router.post("/business-profile/invites/:inviteId/resend", inviteController.postResendInvite);

router.post("/business-profile/invites/:inviteId/update", inviteController.postUpdateInvite);

router.post("/business-profile/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites/revoke", inviteController.postRevokeInvite);

/* ───────────────────── SHIFT PAGES ───────────────────── */

router.get("/shifts", employerShiftController.getManageShifts);

// Keep literal sub-pages before parameterized /shifts/:shiftId routes.
router.get("/shifts/applications", employerShiftApplicationController.getApplications);

router.get("/shifts/assignments", employerShiftAssignmentController.getAssignments);

router.get("/shifts/attendance", employerShiftAttendanceController.getAttendance);

router.get("/shifts/:shiftId/occurrences", employerShiftController.getShiftOccurrences);

// Existing-Shift resolution remains available during delinquency.
router.get("/shifts/:shiftId/cancellation-preview", employerShiftController.getCancellationPreview);

/* ───────────────────── SHIFT APPLICATIONS ───────────────────── */

// Shortlisting and rejection only change application state.
router.post(
  "/shifts/applications/:applicationId/shortlist",
  employerShiftApplicationController.shortlistApplication
);

router.post(
  "/shifts/applications/:applicationId/reject",
  employerShiftApplicationController.rejectApplication
);

/**
 * Acceptance creates an assignment.
 *
 * The application service owns the fresh delinquency check before
 * creating the new obligation.
 */
router.post(
  "/shifts/applications/:applicationId/accept",
  employerShiftApplicationController.acceptApplication
);

/* ───────────────────── SHIFT ASSIGNMENTS ───────────────────── */

/**
 * Assignment-case actions resolve existing assignment responsibility.
 *
 * ShiftAssignmentCaseService owns business/branch authorization
 * and lifecycle validity.
 */
router.post(
  "/shifts/assignments/:assignmentId/issues",
  employerShiftAssignmentController.reportAssignmentIssue
);

router.post(
  "/shifts/assignments/:assignmentId/cases/:caseId/respond",
  employerShiftAssignmentController.respondToAssignmentCase
);

router.post(
  "/shifts/assignments/:assignmentId/cases/:caseId/escalate",
  employerShiftAssignmentController.escalateAssignmentCase
);

/* ───────────────────── ATTENDANCE PINS ───────────────────── */

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in-pin",
  employerShiftAttendanceController.getCheckInPin
);

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out-pin",
  employerShiftAttendanceController.getCheckOutPin
);

/* ───────────────────── SHIFT OVERTIME ───────────────────── */

/**
 * Employer reviews the professional's submitted OT request.
 *
 * These decisions resolve an existing obligation, so employer
 * delinquency must not block them.
 *
 * ShiftOvertimeService owns authorization, deadline validity,
 * decision validity and financial consequences.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/approve",
  employerShiftOvertimeController.approveOvertime
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/reject",
  employerShiftOvertimeController.rejectOvertime
);

/**
 * Approved OT creates an occurrence-specific top-up obligation.
 *
 * Paying existing employer debt must remain available during
 * delinquency. Do not apply canPostShifts to these routes.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/top-up/wallet",
  employerShiftOvertimeController.fundOvertimeTopUpFromWallet
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/top-up/checkout",
  employerShiftOvertimeController.initializeOvertimeTopUpCheckout
);

/* ───────────────────── EMPLOYER DISPUTES ───────────────────── */

/**
 * Employer's one substantive dispute submission.
 *
 * Disputes challenge an existing occurrence outcome and do not create
 * a new Shift obligation, so delinquency must not block submission.
 *
 * The dispute service owns authorization, scope, overlap,
 * challenge-window validity and financial consequences.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/disputes",
  employerShiftClaimController.submitDispute
);

// Withdrawal is allowed only while the dispute remains withdrawable.
router.post("/shifts/disputes/:disputeId/withdraw", employerShiftClaimController.withdrawDispute);

/* ───────────────────── PROFESSIONAL CLAIM REVIEW ───────────────────── */

/**
 * Employer's one substantive response to a professional claim issue.
 *
 * The employer may approve or reject. Rejection may include a
 * counter-position and evidence, then proceeds to admin review.
 *
 * There is no second response, rebuttal or appeal.
 */
router.post(
  "/shifts/claims/:claimId/issues/:issueId/review",
  employerShiftClaimController.reviewClaim
);

/* ───────────────────── SHIFT DETAILS ───────────────────── */

// Keep after more-specific /shifts/... GET routes.
router.get("/shifts/:shiftId", employerShiftController.getShiftDetails);

/* ───────────────────── SHIFT CREATION ───────────────────── */

// Shift creation introduces a new employer obligation.
router.post("/shifts", canPostShifts, employerShiftController.postShift);

/* ───────────────────── INITIAL SHIFT FUNDING ───────────────────── */

/**
 * Initial funding activates a new employer obligation.
 *
 * New-obligation restrictions apply. canFundShifts remains separate
 * from general wallet-management authority.
 */
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

/* ───────────────────── SHIFT LIFECYCLE ───────────────────── */

// Cancellation reduces or closes an existing obligation.
router.post("/shifts/:shiftId/cancel", employerShiftController.postCancelShift);

/**
 * Active-work cancellation resolves work already in progress.
 *
 * This is the authoritative route used by ShiftViewService.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/active-work-cancellation",
  employerShiftController.postActiveWorkCancellation
);

/* ───────────────────── BILLING / WALLET ───────────────────── */

/**
 * Wallet visibility is broader than wallet-management authority.
 *
 * Branch managers may inspect wallet information but may not
 * withdraw funds or modify wallet/account configuration.
 */
router.get("/billing", canViewWallet, employerBillingController.getBilling);

router.get("/billing/wallet", canViewWallet, (req, res) => {
  return res.redirect("/employer/billing");
});

/**
 * Delinquency does not freeze ordinary wallet/account management.
 *
 * These actions remain limited to users with wallet-management
 * authority.
 */
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
