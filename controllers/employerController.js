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

const allowedMemberStatusFilters = ["active", "restricted", "suspended", "removed", "all"];

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

function sendBadRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
}

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

exports.getDashboard = async (req, res, next) => {
  try {
    const employerProfile = req.employerProfile;

    const dashboardData = await EmployerService.getDashboardData(employerProfile);

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

exports.getBusinessProfile = async (req, res, next) => {
  try {
    const employerProfile = req.employerProfile;

    const requestedTab = req.query.tab || "overview";
    const activeTab = getActiveBusinessProfileTab(requestedTab);

    const inviteStatus = getInviteStatusFilter(req.query.inviteStatus || "active");
    const memberStatus = getMemberStatusFilter(req.query.memberStatus || "active");

    const businessProfileData = await EmployerService.getBusinessProfileData(employerProfile, {
      activeTab,
      inviteStatus,
      memberStatus,
    });

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

exports.postUpdateBusinessDetails = async (req, res) => {
  try {
    const employerProfile = req.employerProfile;

    if (!employerProfile?._id) {
      return sendBadRequest(res, "Employer profile is required.");
    }

    await EmployerService.updateBusinessDetails({
      employerProfileId: employerProfile._id,
      data: req.body,
    });

    return res.json({
      success: true,
      message: "Business details updated successfully.",
      redirectUrl: BUSINESS_PROFILE_BUSINESS_DETAILS_URL,
    });
  } catch (error) {
    logger.error("Update business details error:", error);

    return sendBadRequest(res, error.message || "Unable to update business details.");
  }
};
