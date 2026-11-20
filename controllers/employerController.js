// controllers/employerController.js

const EmployerService = require("../services/employerService");
const locations = require("../config/locations");
const logger = require("../utils/logger");

const BUSINESS_PROFILE_BUSINESS_DETAILS_URL = "/employer/business-profile?tab=business-details";

const allowedBusinessProfileTabs = [
  "overview",
  "business-details",
  "verification",
  "branches",
  "team",
  "invites",
];

const allowedInviteStatusFilters = [
  "active",
  "pending",
  "accepted",
  "expired",
  "deleted",
  "revoked",
  "all",
];

const allowedBranchStatusFilters = ["active", "inactive", "all"];

const allowedMemberStatusFilters = ["active", "restricted", "suspended", "removed", "all"];

// ───────────────────── PROFILE FILTERS ─────────────────────

function getActiveBusinessProfileTab(requestedTab) {
  return allowedBusinessProfileTabs.includes(requestedTab) ? requestedTab : "overview";
}

function getInviteStatusFilter(requestedStatus) {
  return allowedInviteStatusFilters.includes(requestedStatus) ? requestedStatus : "active";
}

function getMemberStatusFilter(requestedStatus) {
  return allowedMemberStatusFilters.includes(requestedStatus) ? requestedStatus : "active";
}

function getBranchStatusFilter(requestedStatus) {
  return allowedBranchStatusFilters.includes(requestedStatus) ? requestedStatus : "active";
}

// ───────────────────── RESPONSE HELPERS ─────────────────────

function sendBadRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
}

function sendUnauthorized(res) {
  return res.status(401).json({
    success: false,
    message: "Please sign in to update your business details.",
  });
}

function sendForbidden(res, message) {
  return res.status(403).json({
    success: false,
    message,
  });
}

function sendForbiddenPage(res) {
  return res.status(403).render("auth/not-found", {
    layout: "layouts/auth-layout-no-index",
    title: "Forbidden",
  });
}

function sendConflict(res, message) {
  return res.status(409).json({
    success: false,
    message,
  });
}

// ───────────────────── PROFILE AUTHORISATION ─────────────────────

function canAccessBusinessProfileTab(employerContext, activeTab) {
  if (!employerContext?.canViewBusinessProfile) {
    return false;
  }

  if (activeTab === "team") {
    return employerContext.canViewTeamMembers === true;
  }

  if (activeTab === "invites") {
    return employerContext.canInviteMembers === true;
  }

  if (activeTab === "branches") {
    return employerContext.canViewBranches === true;
  }

  return true;
}

// ───────────────────── PAGE PRESENTATION ─────────────────────

function buildBusinessProfilePageView({
  employerProfile,
  activeTab,
  employerContext,
  employerPermissions,
}) {
  const access = employerPermissions;

  const canManageBranches = Boolean(
    access.isBusinessWide === true &&
    access.canViewBranches === true &&
    employerContext.canManageBranches === true
  );

  const showOverview = activeTab === "overview";
  const showBusinessDetails = activeTab === "business-details";
  const showVerification = activeTab === "verification";

  const showBranches = Boolean(activeTab === "branches" && access.canViewBranches === true);

  const showTeamMembers = Boolean(activeTab === "team" && access.canViewTeamMembers === true);

  const showInvites = Boolean(activeTab === "invites" && access.canInviteMembers === true);

  return {
    countryCode: String(employerProfile.countryCode || "NG")
      .trim()
      .toLowerCase(),

    showOverview,
    showBusinessDetails,
    showVerification,
    showBranches,
    showTeamMembers,
    showInvites,

    showAddBranchModal: showBranches && canManageBranches,
    showViewBranchModal: showBranches,
    showEditBranchModal: showBranches && canManageBranches,

    showTeamMemberModals: showTeamMembers,
    showInviteModals: showInvites,
  };
}

// Encode data as a safe JavaScript literal for an HTML script element.
function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ───────────────────── UPDATE ERROR HANDLING ─────────────────────

function handleBusinessDetailsUpdateError(error, res, next) {
  const message = typeof error?.message === "string" ? error.message : "";

  const forbiddenMessages = new Set([
    "This business account is not eligible for profile editing.",
    "Your account is not eligible to update business details.",
    "You are not authorised to update this business profile.",
  ]);

  if (forbiddenMessages.has(message)) {
    return sendForbidden(res, message);
  }

  const protectedIdentityChange =
    /^(type|businessName|cacRegistrationNumber|regulatoryBody|regulatoryRegistrationNumber) cannot be changed through ordinary business profile editing\./.test(
      message
    );

  if (protectedIdentityChange) {
    return sendConflict(res, message);
  }

  const conflictMessages = new Set([
    "Business registration or regulatory identity changes require a separate verification process.",
    "Changes to reviewed business premises require additional regulatory review. Please contact support.",
    "This location change affects your regulatory body and requires a separate verification process.",
    "Changing a reviewed business representative requires administrative review. Please contact support.",
    "Change the main facility's location through Branch management so its permits can be reassessed.",
  ]);

  if (conflictMessages.has(message)) {
    return sendConflict(res, message);
  }

  const invalidRequestMessages = new Set([
    "A valid employer profile is required.",
    "Valid business profile details are required.",
    "Employer profile is required.",
    "Missing required employer profile fields.",
    "Invalid employer type selected.",
    "Please select a valid business address from the suggestions.",
    "Enter a valid business email address.",
    "Enter a valid CAC number, e.g. RC1234567 or BN1234567.",
    "Enter a valid regulatory registration number exactly as shown on the certificate.",
    "Verified CAC registered business name is required.",
    "Verified CAC registered business name is invalid.",
    "Verification, financial and administrative fields cannot be updated through business details.",
  ]);

  if (invalidRequestMessages.has(message)) {
    return sendBadRequest(res, message);
  }

  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return sendBadRequest(res, "The submitted business details are invalid.");
  }

  if (message === "Employer profile not found.") {
    return res.status(404).json({
      success: false,
      message,
    });
  }

  return next(error);
}

// ───────────────────── BUSINESS PROFILE SCRIPTS ─────────────────────

function getBusinessProfileScripts(activeTab) {
  const scripts = ['<script src="/js/employer/business-profile.js"></script>'];

  if (activeTab === "branches" || activeTab === "business-details") {
    scripts.unshift('<script src="/js/location-picker.js"></script>');

    scripts.push(`
      <script
        async
        defer
        src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_BROWSER_KEY}&libraries=places&callback=initBusinessProfileAddressAutocomplete"
      ></script>
    `);
  }

  if (activeTab === "team") {
    scripts.push('<script src="/js/employer/team-members.js"></script>');
  }

  if (activeTab === "invites") {
    scripts.push('<script src="/js/employer/invite-member.js"></script>');
  }

  return scripts.join("\n");
}

// ───────────────────── EMPLOYER DASHBOARD ─────────────────────

exports.getDashboard = async (req, res, next) => {
  try {
    const employerProfile = req.employerProfile;

    const dashboardData = await EmployerService.getDashboardData(employerProfile, {
      actorUserId: req.user._id,
      employerContext: req.employerContext,
    });

    return res.render("employer/dashboard/index", {
      layout: "layouts/app-layout",
      title: "Dashboard",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Dashboard",
          url: null,
        },
      ],

      ...dashboardData,
    });
  } catch (error) {
    logger.error("Employer dashboard error:", error);

    return next(error);
  }
};

// ───────────────────── EMPLOYER BUSINESS PROFILE ─────────────────────

exports.getBusinessProfile = async (req, res, next) => {
  try {
    const employerProfile = req.employerProfile;
    const employerContext = req.employerContext;

    if (!employerProfile?._id || !employerContext?.canViewBusinessProfile) {
      return sendForbiddenPage(res);
    }

    const requestedTab = req.query.tab || "overview";

    const activeTab = getActiveBusinessProfileTab(requestedTab);

    if (!canAccessBusinessProfileTab(employerContext, activeTab)) {
      return sendForbiddenPage(res);
    }

    const branchStatus = getBranchStatusFilter(req.query.branchStatus || "active");

    const inviteStatus = getInviteStatusFilter(req.query.inviteStatus || "active");

    const memberStatus = getMemberStatusFilter(req.query.memberStatus || "active");

    const businessProfileData = await EmployerService.getBusinessProfileData(employerProfile, {
      actorUserId: req.user._id,
      employerContext,
      activeTab,
      branchStatus,
      inviteStatus,
      memberStatus,
    });

    const businessProfilePage = buildBusinessProfilePageView({
      employerProfile,
      activeTab,
      employerContext,
      employerPermissions: businessProfileData.employerPermissions,
    });

    return res.render("employer/business-profile/index", {
      layout: "layouts/app-layout",
      title: "Business Profile",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Business Profile",
          url: null,
        },
      ],

      activeTab,
      businessProfilePage,

      csrfToken: req.csrfToken(),

      locations: serializeForInlineScript(locations),

      googleMapsApiKey: process.env.GOOGLE_MAPS_BROWSER_KEY,

      scripts: getBusinessProfileScripts(activeTab),

      ...businessProfileData,
    });
  } catch (error) {
    logger.error("Employer business profile error:", error);

    return next(error);
  }
};

// ───────────────────── UPDATE BUSINESS DETAILS ─────────────────────

exports.postUpdateBusinessDetails = async (req, res, next) => {
  try {
    const actorUserId = req.user?._id || req.user?.id;

    if (!actorUserId) {
      return sendUnauthorized(res);
    }

    const employerProfile = req.employerProfile;

    if (!employerProfile?._id) {
      return sendBadRequest(res, "Employer profile is required.");
    }

    if (req.employerContext?.canManageBusinessProfile !== true) {
      return sendForbidden(res, "You are not authorised to update this business profile.");
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return sendBadRequest(res, "Valid business profile details are required.");
    }

    await EmployerService.updateBusinessDetails({
      employerProfileId: employerProfile._id,
      actorUserId,
      data: req.body,
    });

    return res.json({
      success: true,
      message: "Business details updated successfully.",
      redirectUrl: BUSINESS_PROFILE_BUSINESS_DETAILS_URL,
    });
  } catch (error) {
    logger.error("Update business details error:", error);

    return handleBusinessDetailsUpdateError(error, res, next);
  }
};
