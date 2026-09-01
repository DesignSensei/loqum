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
} = require("../middleware/employerMiddleware");

const employerController = require("../controllers/employerController");
const branchController = require("../controllers/branchController");
const inviteController = require("../controllers/inviteController");
const teamMemberController = require("../controllers/teamMemberController");
const employerBillingController = require("../controllers/employerBillingController");
const employerShiftController = require("../controllers/employerShiftController");
const employerShiftApplicationController = require("../controllers/employerShiftApplicationController");
const employerShiftAttendanceController = require("../controllers/employerShiftAttendanceController");
const employerShiftClaimController = require("../controllers/employerShiftClaimController");

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

/* ─────────────────────────────── ATTENDANCE PINS ─────────────────────────────── */

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in-pin",
  employerShiftAttendanceController.getCheckInPin
);

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out-pin",
  employerShiftAttendanceController.getCheckOutPin
);

/*
 * Single-date compatibility routes resolve occurrence sequence 1.
 */
router.get("/shifts/:shiftId/check-in-pin", employerShiftAttendanceController.getCheckInPin);

router.get("/shifts/:shiftId/check-out-pin", employerShiftAttendanceController.getCheckOutPin);

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

/* ─────────────────────────────── SHIFT FUNDING ─────────────────────────────── */

/*
 * Funding publishes a pending Shift, so new-obligation restrictions apply.
 */
router.post(
  "/shifts/:shiftId/fund-from-wallet",
  canPostShifts,
  employerShiftController.fundShiftFromWallet
);

router.post(
  "/shifts/:shiftId/initialize-checkout",
  canPostShifts,
  employerShiftController.initializeShiftCheckout
);

/* ─────────────────────────────── SHIFT LIFECYCLE ─────────────────────────────── */

/*
 * Cancellation reduces or closes an existing obligation.
 */
router.post("/shifts/:shiftId/cancel", employerShiftController.postCancelShift);

/*
 * Active-work cancellation resolves work already in progress.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/active-work-cancellation",
  employerShiftController.postActiveWorkCancellation
);

/* ─────────────────────────────── BILLING / WALLET ─────────────────────────────── */

router.get("/billing", employerBillingController.getBilling);

router.get("/billing/wallet", (req, res) => {
  return res.redirect("/employer/billing");
});

/*
 * Employer delinquency does not freeze ordinary wallet/account management.
 */
router.post("/billing/setup-dva", employerBillingController.postSetupDVA);

router.post(
  "/billing/resolve-withdrawal-account",
  employerBillingController.resolveWithdrawalAccount
);

router.post("/billing/withdrawal-account", employerBillingController.saveWithdrawalAccount);

router.post(
  "/billing/withdrawal-account/remove",
  employerBillingController.removeWithdrawalAccount
);

router.post("/billing/withdraw", employerBillingController.initiateWithdrawal);

module.exports = router;
