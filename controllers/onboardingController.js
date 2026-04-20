// controllers/onboardingController.js

const User = require("../models/User");
const PharmacistProfile = require("../models/PharmacistProfile");
const EmployerProfile = require("../models/EmployerProfile");
const OnboardingService = require("../services/onboardingService");
const locations = require("../utils/locations");

//─────────────────────────────── AUTH RENDER BLOCK (GET ROUTES) ───────────────────────────────//

// Renders the Pharmacist setup page
exports.getPharmacistOnboarding = (req, res) => {
  res.render("onboarding/pharmacist", {
    layout: "layouts/auth-layout-no-index",
    title: "Professional Profile",
    locationData: locations,
    locationDataJson: JSON.stringify(locations),
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="/js/location-picker.js"></script>
    <script src="/js//onboarding/onboarding-pharmacist.js"></script>
    `,
  });
};

exports.getEmployerOnboarding = (req, res) => {
  res.render("onboarding/employer", {
    layout: "layouts/auth-layout-no-index",
    title: "Pharmacy Profile",
    locationData: locations,
    locationDataJson: JSON.stringify(locations),
    csrfToken: req.csrfToken(),
    scripts: `
    <script src="/js/location-picker.js"></script>
    <script src="/js/onboarding/onboarding-employer.js"></script>
    `,
  });
};

//─────────────────────────────── AUTH ACTIONS (POST ROUTES) ───────────────────────────────//

exports.postPharmacistOnboarding = async (req, res) => {
  try {
    const userId = req.session.user?._id;

    if (!userId)
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });

    const profile = await OnboardingService.completePharmacistOnboarding(
      userId,
      req.body,
    );

    req.session.user.isOnboarded = true;

    req.session.save((err) => {
      if (err) return next(err);
      res.json({
        success: true,
        message: "Profile completed successfully!",
        redirectUrl: "/dashboard/pharmacist",
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

    const profile = await OnboardingService.completeEmployerOnboarding(
      userId,
      req.body,
    );

    req.session.user.isOnboarded = true;

    req.session.save((err) => {
      if (err) return next(err);
      res.json({
        success: true,
        message: "Pharmacy profile completed successfully!",
        redirectUrl: "/dashboard/employer",
      });
    });
  } catch (error) {
    logger.error(error.message);
    res.status(400).json({ success: false, message: error.message });
  }
};
