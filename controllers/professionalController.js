// controllers/professionalController.js

const ProfessionalService = require("../services/professionalService");

const ProfessionalProfileService = require("../services/professionalProfileService");

// ───────────────────── PROFILE PAGE RENDERER ─────────────────────

/**
 * Shared renderer for Professional Profile requests.
 *
 * All profile view models are prepared by the service.
 * This renderer is also used when availability validation fails.
 *
 * The application layout handles page-specific scripts.
 * CSRF tokens are supplied globally through res.locals.
 */
async function renderProfessionalProfile(
  req,
  res,
  { activeTab = "overview", saved = false, errorMessage = null, statusCode = 200 } = {}
) {
  const profileData = await ProfessionalProfileService.getProfileData({
    actorUser: req.user,
    professionalProfile: req.professionalProfile,
    activeTab,
  });

  return res.status(statusCode).render("professional/profile/index", {
    layout: "layouts/app-layout",

    title: "My Profile",

    breadcrumbs: [
      {
        label: "Home",
        url: "/professional/dashboard",
      },
      {
        label: "My Profile",
        url: null,
      },
    ],

    // Loaded by the existing application layout.
    // No script tags are required inside EJS partials.
    scripts: '<script src="/js/professional/profile.js"></script>',

    ...profileData,

    saved,
    errorMessage,
  });
}

// ───────────────────── PROFESSIONAL DASHBOARD ─────────────────────

exports.getDashboard = async (req, res, next) => {
  try {
    const professionalProfile = req.professionalProfile;

    const dashboardData = await ProfessionalService.getDashboardData(professionalProfile);

    return res.render("professional/dashboard/index", {
      layout: "layouts/app-layout",

      title: "Dashboard",

      breadcrumbs: [
        {
          label: "Home",
          url: "/professional/dashboard",
        },
        {
          label: "Dashboard",
          url: null,
        },
      ],

      ...dashboardData,
    });
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── PROFESSIONAL PROFILE ─────────────────────

/**
 * GET /professional/profile
 *
 * Supported tabs:
 * - overview
 * - personal-details
 * - professional-details
 * - verification
 * - availability
 * - account-settings
 *
 * The service validates and normalises the active tab.
 */
exports.getProfile = async (req, res, next) => {
  try {
    const activeTab = typeof req.query.tab === "string" ? req.query.tab : "overview";

    const saved = activeTab === "availability" && req.query.saved === "1";

    return await renderProfessionalProfile(req, res, {
      activeTab,
      saved,
    });
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── UPDATE AVAILABILITY ─────────────────────

/**
 * POST /professional/profile/availability
 *
 * The service:
 * - Resolves the authenticated professional.
 * - Validates status, mode, weekdays and dates.
 * - Updates only approved availability fields.
 * - Preserves inactive-mode preferences.
 * - Enforces the ProfessionalProfile schema.
 *
 * Existing shift assignments remain unaffected.
 */
exports.postUpdateAvailability = async (req, res, next) => {
  try {
    await ProfessionalProfileService.updateAvailability({
      actorUser: req.user,
      data: req.body,
    });

    return res.redirect(303, "/professional/profile?tab=availability&saved=1");
  } catch (error) {
    if (error.statusCode === 400) {
      try {
        return await renderProfessionalProfile(req, res, {
          activeTab: "availability",
          saved: false,
          errorMessage: error.message,
          statusCode: 400,
        });
      } catch (renderError) {
        return next(renderError);
      }
    }

    return next(error);
  }
};
