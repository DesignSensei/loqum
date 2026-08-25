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

/* ─────────────────────────────── EMPLOYER ROUTE PROTECTION ─────────────────────────────── */

router.use(
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isOnboarded,
  attachEmployerProfile,
  attachEmployerContext
);

/* ─────────────────────────────── DASHBOARD ROUTES ─────────────────────────────── */

router.get("/dashboard", employerController.getDashboard);

/* ─────────────────────────────── BUSINESS PROFILE ROUTES ─────────────────────────────── */

router.get("/business-profile", employerController.getBusinessProfile);

router.post(
  "/business-profile/business-details/update",
  employerController.postUpdateBusinessDetails
);

/* ─────────────────────────────── BRANCH ROUTES ─────────────────────────────── */

// Safe GET redirects.
router.get("/branches", branchController.getBranches);

router.get("/branches/new", branchController.getNewBranch);

router.get("/branches/:branchId/edit", branchController.getEditBranch);

router.get("/branches/:branchId/members", branchController.getBranchMembers);

// Branch actions.
router.post("/branches", branchController.postNewBranch);

router.post("/branches/:branchId/edit", branchController.postEditBranch);

router.post("/branches/:branchId/update", branchController.postEditBranch);

// Business profile branch actions.
router.post("/business-profile/branches/update", branchController.postEditBranch);

/* ─────────────────────────────── TEAM MEMBER ROUTES ─────────────────────────────── */

// Team members are managed from /employer/business-profile?tab=team.
router.get("/business-profile/team-members/:memberId", teamMemberController.getTeamMember);

router.post(
  "/business-profile/team-members/:memberId/update",
  teamMemberController.postUpdateTeamMember
);

router.post(
  "/business-profile/team-members/:memberId/remove",
  teamMemberController.postRemoveTeamMember
);

/* ─────────────────────────────── INVITE ROUTES ─────────────────────────────── */

// Safe GET redirect.
// Invites are managed from /employer/business-profile?tab=invites.
router.get("/invites", inviteController.getInvites);

// Invite actions.
router.post("/invites", inviteController.postSendInvite);

router.post("/invites/:inviteId/revoke", inviteController.postRevokeInvite);

// Business profile invite actions.
router.post("/business-profile/invites", inviteController.postSendInvite);

router.post("/business-profile/invites/:inviteId/resend", inviteController.postResendInvite);

router.post("/business-profile/invites/:inviteId/update", inviteController.postUpdateInvite);

router.post("/business-profile/invites/:inviteId/revoke", inviteController.postRevokeInvite);

router.post("/business-profile/invites/revoke", inviteController.postRevokeInvite);

/* ─────────────────────────────── SHIFT PAGE ROUTES ─────────────────────────────── */

// Manage Shifts page.
router.get("/shifts", employerShiftController.getManageShifts);

// Returns occurrence schedule data for one Shift.
router.get("/shifts/:shiftId/occurrences", employerShiftController.getShiftOccurrences);

/*
 * Returns the employer cancellation or active-work cancellation preview.
 *
 * Employer delinquency does not prevent resolution of an existing Shift.
 * Therefore this route deliberately does not use canPostShifts.
 */
router.get("/shifts/:shiftId/cancellation-preview", employerShiftController.getCancellationPreview);

/* ─────────────────────────────── SHIFT APPLICATION ROUTES ─────────────────────────────── */

/*
 * Shortlisting changes application review state only.
 * It does not create a professional financial obligation.
 */
router.post(
  "/shifts/applications/:applicationId/shortlist",
  employerShiftApplicationController.shortlistApplication
);

/*
 * Rejection reduces/ends an application opportunity and does not create a new
 * employer obligation.
 */
router.post(
  "/shifts/applications/:applicationId/reject",
  employerShiftApplicationController.rejectApplication
);

/*
 * Acceptance creates an assignment.
 *
 * Application-management role/branch authority is not identical to Shift
 * posting authority, so canPostShifts is deliberately not reused here.
 *
 * ShiftApplicationService must own the fresh business-level delinquency /
 * new-obligation check immediately before assignment creation.
 */
router.post(
  "/shifts/applications/:applicationId/accept",
  employerShiftApplicationController.acceptApplication
);

/* ─────────────────────────────── SHIFT ATTENDANCE PIN ROUTES ─────────────────────────────── */

// Occurrence-authoritative attendance PIN routes.
router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-in-pin",
  employerShiftAttendanceController.getCheckInPin
);

router.get(
  "/shifts/:shiftId/occurrences/:occurrenceId/check-out-pin",
  employerShiftAttendanceController.getCheckOutPin
);

// Single-date Shift compatibility PIN routes.
// ShiftAttendanceService resolves occurrence sequence 1.
router.get("/shifts/:shiftId/check-in-pin", employerShiftAttendanceController.getCheckInPin);

router.get("/shifts/:shiftId/check-out-pin", employerShiftAttendanceController.getCheckOutPin);

/* ─────────────────────────────── SHIFT CLAIM ROUTES ─────────────────────────────── */

/*
 * Employer reviews one original financially relevant ShiftOccurrence claim.
 *
 * Claim review resolves an existing financial/factual issue and therefore
 * remains available during employer delinquency.
 */
router.post("/shifts/claims/:claimId/review", employerShiftClaimController.reviewClaim);

/*
 * Dedicated parent Shift details page.
 *
 * Keep this after every more-specific /shifts/... GET route so :shiftId does
 * not consume route segments such as applications.
 */
router.get("/shifts/:shiftId", employerShiftController.getShiftDetails);

/* ─────────────────────────────── SHIFT CREATION ROUTES ─────────────────────────────── */

/*
 * Creating a Shift creates a new employer obligation.
 */
router.post("/shifts", canPostShifts, employerShiftController.postShift);

/* ─────────────────────────────── SHIFT FUNDING ROUTES ─────────────────────────────── */

/*
 * A pending-funding Shift is not yet published.
 *
 * Funding activates/publishes that new Shift obligation, so the fresh
 * new-obligation restriction still applies.
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

/* ─────────────────────────────── SHIFT LIFECYCLE ROUTES ─────────────────────────────── */

/*
 * Cancelling an existing Shift must remain available while the employer is
 * delinquent because it reduces or closes an existing obligation.
 */
router.post("/shifts/:shiftId/cancel", employerShiftController.postCancelShift);

/*
 * Employer-initiated active-work cancellation for one checked-in occurrence.
 *
 * This resolves work already in progress and must remain available while the
 * business is restricted from creating new obligations.
 */
router.post(
  "/shifts/:shiftId/occurrences/:occurrenceId/active-work-cancellation",
  employerShiftController.postActiveWorkCancellation
);

/* ─────────────────────────────── BILLING / WALLET ROUTES ─────────────────────────────── */

// Safe GET redirects.
router.get("/billing", employerBillingController.getBilling);

router.get("/billing/wallet", (req, res) => {
  return res.redirect("/employer/billing");
});

/*
 * First-level employer delinquency does not freeze the employer wallet.
 *
 * Billing/account actions therefore do not use canPostShifts.
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
