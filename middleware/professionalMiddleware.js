// middleware/professionalMiddleware.js

const ProfessionalProfile = require("../models/ProfessionalProfile");

exports.attachProfessionalProfile = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.redirect("/login");
    }

    if (req.user.role !== "professional") {
      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    }

    const profile = await ProfessionalProfile.findOne({ user: req.user._id });

    if (!profile) {
      return res.redirect("/onboarding/professional");
    }

    req.professionalProfile = profile;
    return next();
  } catch (error) {
    return next(error);
  }
};

exports.canApplyForShifts = (req, res, next) => {
  const profile = req.professionalProfile;

  if (!profile) {
    return res.redirect("/onboarding/professional");
  }

  const isApprovedForShifts =
    profile.identityVerificationStatus === "verified" &&
    profile.licenceVerificationStatus === "verified" &&
    profile.professionalApprovalStatus === "approved" &&
    profile.accountStatus === "active";

  if (!isApprovedForShifts) {
    return res.status(403).json({
      success: false,
      message: "Your profile must be verified and approved before you can apply for shifts.",
    });
  }

  return next();
};
