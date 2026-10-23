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
  if (!allowedInviteStatusFilters.includes(requestedStatus)) {
    return "active";
  }

  return requestedStatus;
}

function getMemberStatusFilter(requestedStatus) {
  if (!allowedMemberStatusFilters.includes(requestedStatus)) {
    return "active";
  }

  return requestedStatus;
}

function getBranchStatusFilter(requestedStatus) {
  if (!allowedBranchStatusFilters.includes(requestedStatus)) {
    return "active";
  }

  return requestedStatus;
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

// ───────────────────── BUSINESS PROFILE AUTHORISATION ─────────────────────

/**
 * Employer context comes from authenticated middleware.
 *
 * Team details and invitations are restricted to business owners
 * and authorised business administrators. Branch users retain
 * only their permitted profile and branch access.
 *
 * EmployerMember.role "admin" is not a platform administrator.
 */
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

// ───────────────────── UPDATE ERROR HANDLING ─────────────────────

/**
 * Return safe, actionable errors for recognised update failures.
 * Unexpected errors pass to the central Express error handler.
 */
function handleBusinessDetailsUpdateError(error, res, next) {
  const message = typeof error?.message === "string" ? error.message : "";

  // ───────────────────── AUTHORISATION ERRORS ─────────────────────

  const forbiddenMessages = new Set([
    "This business account is not eligible for profile editing.",
    "Your account is not eligible to update business details.",
    "You are not authorised to update this business profile.",
  ]);

  if (forbiddenMessages.has(message)) {
    return sendForbidden(res, message);
  }

  // ───────────────────── PROTECTED IDENTITY CHANGES ─────────────────────

  // Verified business identity cannot be changed through ordinary editing.
  const protectedIdentityChange =
    /^(type|businessName|cacRegistrationNumber|regulatoryBody|regulatoryRegistrationNumber) cannot be changed through ordinary business profile editing\./.test(
      message
    );

  if (protectedIdentityChange) {
    return sendConflict(res, message);
  }

  // ───────────────────── VERIFICATION AND REVIEW CONFLICTS ─────────────────────

  const conflictMessages = new Set([
    "Business registration or regulatory identity changes require a separate verification process.",
    "Changes to reviewed business premises require additional regulatory review. Please contact support.",
    "This location change affects your regulatory body and requires a separate verification process.",
    "Changing a reviewed business representative requires administrative review. Please contact support.",
  ]);

  if (conflictMessages.has(message)) {
    return sendConflict(res, message);
  }

  // ───────────────────── INVALID REQUESTS ─────────────────────

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

  // ───────────────────── PROFILE NOT FOUND ─────────────────────

  if (message === "Employer profile not found.") {
    return res.status(404).json({
      success: false,
      message,
    });
  }

  // ───────────────────── UNEXPECTED ERRORS ─────────────────────

  return next(error);
}

// ───────────────────── BUSINESS PROFILE SCRIPTS ─────────────────────

function getBusinessProfileScripts(activeTab) {
  const scripts = [`<script src="/js/employer/business-profile.js"></script>`];

  if (activeTab === "branches" || activeTab === "business-details") {
    scripts.unshift(`<script src="/js/location-picker.js"></script>`);

    scripts.push(`
      <script
        async
        defer
        src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_BROWSER_KEY}&libraries=places&callback=initBusinessProfileAddressAutocomplete"
      ></script>
    `);
  }

  if (activeTab === "team") {
    scripts.push(`<script src="/js/employer/team-members.js"></script>`);
  }

  if (activeTab === "invites") {
    scripts.push(`<script src="/js/employer/invite-member.js"></script>`);
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
        { label: "Home", url: "/employer/dashboard" },
        { label: "Dashboard", url: null },
      ],

      ...dashboardData,
    });
  } catch (error) {
    logger.error("Employer dashboard error:", error);

    return next(error);
  }
};

// ───────────────────── EMPLOYER BUSINESS PROFILE ─────────────────────

/**
 * Render the requested business-profile tab.
 *
 * Middleware establishes employer context; the service independently
 * enforces account, membership and data-access permissions.
 */
exports.getBusinessProfile = async (req, res, next) => {
  try {
    const employerProfile = req.employerProfile;
    const employerContext = req.employerContext;

    // ───────────────────── BUSINESS ACCESS ─────────────────────

    if (!employerProfile?._id || !employerContext?.canViewBusinessProfile) {
      return sendForbiddenPage(res);
    }

    // ───────────────────── ACTIVE TAB ─────────────────────

    const requestedTab = req.query.tab || "overview";

    const activeTab = getActiveBusinessProfileTab(requestedTab);

    // Restricted tabs must also be protected against direct URLs.
    if (!canAccessBusinessProfileTab(employerContext, activeTab)) {
      return sendForbiddenPage(res);
    }

    // ───────────────────── PROFILE FILTERS ─────────────────────

    const branchStatus = getBranchStatusFilter(req.query.branchStatus || "active");

    const inviteStatus = getInviteStatusFilter(req.query.inviteStatus || "active");

    const memberStatus = getMemberStatusFilter(req.query.memberStatus || "active");

    // ───────────────────── BUSINESS PROFILE DATA ─────────────────────

    /**
     * The service prepares verificationView and other tab data.
     * Restricted datasets are not fetched for unauthorised users.
     */
    const businessProfileData = await EmployerService.getBusinessProfileData(employerProfile, {
      actorUserId: req.user._id,
      employerContext: req.employerContext,
      activeTab,
      branchStatus,
      inviteStatus,
      memberStatus,
    });

    // ───────────────────── RENDER PROFILE ─────────────────────

    return res.render("employer/business-profile/index", {
      layout: "layouts/app-layout",
      title: "Business Profile",

      breadcrumbs: [
        { label: "Home", url: "/employer/dashboard" },
        { label: "Business Profile", url: null },
      ],

      activeTab,

      csrfToken: req.csrfToken(),

      locations: JSON.stringify(locations),
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

/**
 * Update ordinary business details for an authorised employer.
 *
 * The authenticated actor comes from middleware, never request input.
 * EmployerService rechecks permissions and protects CAC identity,
 * regulatory registrations, verification states and approval history.
 *
 * Protected identity corrections require a separate support-led flow.
 */
exports.postUpdateBusinessDetails = async (req, res, next) => {
  try {
    // ───────────────────── AUTHENTICATED ACTOR ─────────────────────

    const actorUserId = req.user?._id || req.user?.id;

    if (!actorUserId) {
      return sendUnauthorized(res);
    }

    // ───────────────────── TARGET EMPLOYER ─────────────────────

    const employerProfile = req.employerProfile;

    if (!employerProfile?._id) {
      return sendBadRequest(res, "Employer profile is required.");
    }

    // ───────────────────── BUSINESS-LEVEL AUTHORISATION ─────────────────────

    // Only the owner or an authorised business admin may update details.
    if (req.employerContext?.canManageBusinessProfile !== true) {
      return sendForbidden(res, "You are not authorised to update this business profile.");
    }

    // ───────────────────── REQUEST VALIDATION ─────────────────────

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return sendBadRequest(res, "Valid business profile details are required.");
    }

    // ───────────────────── AUTHORISED PROFILE UPDATE ─────────────────────

    /**
     * Service validation restricts writable fields and detects
     * reviewed premises or representative changes.
     *
     * Ordinary profile edits do not trigger paid registry lookups
     * or silently invalidate authoritative KYC evidence.
     */
    await EmployerService.updateBusinessDetails({
      employerProfileId: employerProfile._id,
      actorUserId,
      data: req.body,
    });

    // ───────────────────── SUCCESS RESPONSE ─────────────────────

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
