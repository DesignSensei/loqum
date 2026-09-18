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

/* ─────────────────────────────── ROUTE PROTECTION ─────────────────────────────── */

router.use(
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isOnboarded,
  attachEmployerProfile,
  attachEmployerContext
);

/* ─────────────────────────────── DASHBOARD ─────────────────────────────── */

router.get("/dashboard", employerController.getDashboard);

router.get("/cases", employerShiftClaimController.getCases);

/* ─────────────────────────────── BUSINESS PROFILE ─────────────────────────────── */

router.get("/business-profile", employerController.getBusinessProfile);

router.post(
  "/business-profile/business-details/update",
  employerController.postUpdateBusinessDetails
);

/* ─────────────────────────────── BRANCHES ─────────────────────────────── */

router.get("/branches", branchController.getBranches);

router.get("/branches/new", branchController.getNewBranch);

router.get("/branches/:branchId/edit", branchController.getEditBranch);

router.get("/branches/:branchId/members", branchController.getBranchMembers);

router.post("/branches", branchController.postNewBranch);

router.post("/branches/:branchId/edit", branchController.postEditBranch);

router.post("/branches/:branchId/update", branchController.postEditBranch);

router.post("/business-profile/branches/update", branchController.postEditBranch);

/* ─────────────────────────────── TEAM MEMBERS ─────────────────────────────── */

router.get("/business-profile/team-members/:memberId", teamMemberController.getTeamMember);

router.post(
  "/business-profile/team-members/:memberId/update",
  teamMemberController.postUpdateTeamMember
);

router.post(
  "/business-profile/team-members/:memberId/remove",
  teamMemberController.postRemoveTeamMember
);

/* ─────────────────────────────── INVITES ─────────────────────────────── */

router.get("/invites", inviteController.getInvites);

router.post("/invites", inviteController.postSendInvite);

router.post("/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites", inviteController.postSendInvite);

router.post("/business-profile/invites/:inviteId/resend", inviteController.postResendInvite);

router.post("/business-profile/invites/:inviteId/update", inviteController.postUpdateInvite);

router.post("/business-profile/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites/revoke", inviteController.postRevokeInvite);

/* ─────────────────────────────── SHIFT PAGES ─────────────────────────────── */

router.get("/shifts", employerShiftController.getManageShifts);

/*
 * Keep literal Shift sub-pages before parameterized /shifts/:shiftId routes.
 */
router.get("/shifts/applications", employerShiftApplicationController.getApplications);

router.get("/shifts/assignments", employerShiftAssignmentController.getAssignments);

router.get("/shifts/attendance", employerShiftAttendanceController.getAttendance);

router.get("/shifts/:shiftId/occurrences", employerShiftController.getShiftOccurrences);

/*
 * Existing-Shift resolution remains available during delinquency.
 */
router.get("/shifts/:shiftId/cancellation-preview", employerShiftController.getCancellationPreview);

/* ─────────────────────────────── SHIFT APPLICATIONS ─────────────────────────────── */

/*
 * Shortlist/reject only change application state.
 */
router.post(
  "/shifts/applications/:applicationId/shortlist",
  employerShiftApplicationController.shortlistApplication
);

router.post(
  "/shifts/applications/:applicationId/reject",
  employerShiftApplicationController.rejectApplication
);

/*
 * Acceptance creates an assignment.
 *
 * Application authority differs from posting authority. The application
 * service owns the fresh delinquency check before creating the obligation.
 */
router.post(
  "/shifts/applications/:applicationId/accept",
  employerShiftApplicationController.acceptApplication
);

/* ─────────────────────────────── SHIFT ASSIGNMENTS ─────────────────────────────── */

/*
 * Assignment cases manage early exits and employer-reported assignment issues.
 *
 * These actions resolve existing assignment responsibility and do not create
 * new funded Shift capacity. ShiftAssignmentCaseService remains authoritative
 * for employer/business/branch authorization and lifecycle validity.
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

/* ─────────────────────────────── ATTENDANCE PINS ─────────────────────────────── */

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in-pin",
  employerShiftAttendanceController.getCheckInPin
);

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out-pin",
  employerShiftAttendanceController.getCheckOutPin
);

/* ─────────────────────────────── SHIFT OVERTIME ─────────────────────────────── */

/*
 * Employer reviews the professional's submitted OT request.
 *
 * These actions resolve an existing occurrence obligation.
 * Employer delinquency must therefore NOT block either decision.
 *
 * ShiftOvertimeService remains authoritative for:
 *
 * - employer/business/branch authorization;
 * - OT response deadline;
 * - approval/rejection validity; and
 * - final OT financial consequences.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/approve",
  employerShiftOvertimeController.approveOvertime
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/reject",
  employerShiftOvertimeController.rejectOvertime
);

/*
 * Approved OT creates an occurrence-specific employer top-up obligation.
 *
 * Paying that obligation resolves existing employer debt and must remain
 * available even when delinquency prevents creation of new obligations.
 *
 * Do NOT apply canPostShifts to either top-up route.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/top-up/wallet",
  employerShiftOvertimeController.fundOvertimeTopUpFromWallet
);

router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/overtime/top-up/checkout",
  employerShiftOvertimeController.initializeOvertimeTopUpCheckout
);

/* ─────────────────────────────── SHIFT DISPUTES ─────────────────────────────── */

/*
 * Employer disputes challenge an existing occurrence outcome.
 *
 * They do not create a new Shift obligation, so delinquency must not
 * prevent submission. The dispute service owns issue scope, overlap
 * checks, challenge-window authority and financial consequences.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/disputes",
  employerShiftClaimController.submitDispute
);

router.post("/shifts/disputes/:disputeId/withdraw", employerShiftClaimController.withdrawDispute);

/* ─────────────────────────────── SHIFT CLAIMS ─────────────────────────────── */

/*
 * Employer reviews one issue within an active professional claim.
 *
 * Claim review resolves an existing controversy and remains available
 * during delinquency.
 */
router.post(
  "/shifts/claims/:claimId/issues/:issueId/review",
  employerShiftClaimController.reviewClaim
);

/* ─────────────────────────────── SHIFT DETAILS ─────────────────────────────── */

/*
 * Keep this after more-specific /shifts/... GET routes.
 */
router.get("/shifts/:shiftId", employerShiftController.getShiftDetails);

/* ─────────────────────────────── SHIFT CREATION ─────────────────────────────── */

/*
 * Shift creation introduces a new employer obligation.
 */
router.post("/shifts", canPostShifts, employerShiftController.postShift);

/* ─────────────────────────────── INITIAL SHIFT FUNDING ─────────────────────────────── */

/*
 * Initial funding publishes a pending Shift and therefore creates/activates
 * the new employer obligation.
 *
 * New-obligation restrictions apply here.
 *
 * canFundShifts is separate from general wallet-management authority:
 * branch managers may fund Shifts within their assigned branches without
 * gaining withdrawal or wallet-administration permission.
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

/* ─────────────────────────────── SHIFT LIFECYCLE ─────────────────────────────── */

/*
 * Cancellation reduces or closes an existing obligation.
 */
router.post("/shifts/:shiftId/cancel", employerShiftController.postCancelShift);

/*
 * Active-work cancellation resolves work already in progress.
 *
 * This is the authoritative route used by ShiftViewService.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/active-work-cancellation",
  employerShiftController.postActiveWorkCancellation
);

/* ─────────────────────────────── BILLING / WALLET ─────────────────────────────── */

/*
 * Wallet visibility is broader than wallet-management authority.
 *
 * Branch managers may inspect the business wallet, including available
 * balance and transaction information, but may not withdraw funds or
 * modify wallet/account configuration.
 */
router.get("/billing", canViewWallet, employerBillingController.getBilling);

router.get("/billing/wallet", canViewWallet, (req, res) => {
  return res.redirect("/employer/billing");
});

/*
 * Employer delinquency does not freeze ordinary wallet/account management.
 *
 * These actions remain limited to users with wallet-management authority.
 * A branch manager's ability to fund an authorized Shift does not grant
 * permission to administer the employer wallet.
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
