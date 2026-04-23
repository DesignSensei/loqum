// controllers/onboardingController.js

const OnboardingService = require("../services/onboardingService");
const locations = require("../config/locations");
const specialtyConfig = require("../config/specialtyConfig");
const logger = require("../utils/logger");

//─────────────────────────────── AUTH RENDER BLOCK (GET ROUTES) ───────────────────────────────//

// Renders the Professional setup page
exports.getProfessionalOnboarding = (req, res) => {
  res.render("onboarding/professional", {
    layout: "layouts/auth-layout-no-index",
    title: "Professional Profile",
    locations: JSON.stringify(locations),
    specialtyConfig: JSON.stringify(specialtyConfig),
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="/js/location-picker.js"></script>
    <script src="/js/specialty-picker.js"></script>
    <script src="/js/onboarding/onboarding-professional.js"></script>
    `,
  });
};

exports.getEmployerOnboarding = (req, res) => {
  res.render("onboarding/employer", {
    layout: "layouts/auth-layout-no-index",
    title: "Pharmacy Profile",
    locations: JSON.stringify(locations),
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="/js/location-picker.js"></script>
    <script src="/js/onboarding/onboarding-employer.js"></script>
    `,
  });
};

//─────────────────────────────── AUTH ACTIONS (POST ROUTES) ───────────────────────────────//

exports.postProfessionalOnboarding = async (req, res, next) => {
  try {
    const userId = req.session.user?._id;

    if (!userId)
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });

    await OnboardingService.completeProfessionalOnboarding(userId, req.body);

    req.session.user.isOnboarded = true;

    req.session.save((err) => {
      if (err) return next(err);
      res.json({
        success: true,
        message: "Professional profile completed successfully!",
        redirectUrl: "/dashboard/professional",
      });
    });
  } catch (error) {
    logger.error(error.message);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.postEmployerOnboarding = async (req, res, next) => {
  try {
    const userId = req.session.user?._id;

    if (!userId)
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });

    await OnboardingService.completeEmployerOnboarding(userId, req.body);

    req.session.user.isOnboarded = true;

    req.session.save((err) => {
      if (err) return next(err);
      res.json({
        success: true,
        message: "Business profile completed successfully!",
        redirectUrl: "/dashboard/employer",
      });
    });
  } catch (error) {
    logger.error(error.message);
    res.status(400).json({ success: false, message: error.message });
  }
};
