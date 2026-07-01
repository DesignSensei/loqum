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
} = require("../middleware/employerMiddleware");

const employerController = require("../controllers/employerController");
const branchController = require("../controllers/branchController");
const inviteController = require("../controllers/inviteController");
const teamMemberController = require("../controllers/teamMemberController");

//─────────────────────────────── EMPLOYER ROUTE PROTECTION ───────────────────────────────//

router.use(
  isAuthenticated,
  isAccountAllowed,
  isVerified,
  hasRole("employer"),
  isOnboarded,
  attachEmployerProfile,
  attachEmployerContext
);

//─────────────────────────────── DASHBOARD ROUTES ───────────────────────────────//

router.get("/dashboard", employerController.getDashboard);

//─────────────────────────────── BUSINESS PROFILE ROUTES ───────────────────────────────//

router.get("/business-profile", employerController.getBusinessProfile);

router.post(
  "/business-profile/business-details/update",
  employerController.postUpdateBusinessDetails
);

//─────────────────────────────── BRANCH ROUTES ───────────────────────────────//

// Safe GET redirects.
// Branches are now managed from /employer/business-profile.
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

//─────────────────────────────── TEAM MEMBER ROUTES ───────────────────────────────//

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

//─────────────────────────────── INVITE ROUTES ───────────────────────────────//

// Safe GET redirect.
// Invites are now managed from /employer/business-profile?tab=invites.
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

module.exports = router;
