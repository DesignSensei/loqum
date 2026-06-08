// middleware/employerMiddleware.js

const EmployerProfile = require("../models/EmployerProfile");

/**
 * Attaches the employer's business profile to the request.
 * Use this on protected employer routes.
 */
exports.attachEmployerProfile = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.redirect("/login");
    }

    if (req.user.role !== "employer") {
      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    }

    const profile = await EmployerProfile.findOne({ user: req.user._id });

    if (!profile) {
      return res.redirect("/onboarding/employer");
    }

    req.employerProfile = profile;
    return next();
  } catch (error) {
    return next(error);
  }
};

// Checks whether an employer is approved to post shifts
exports.canPostShifts = (req, res, next) => {
  const profile = req.employerProfile;

  if (!profile) {
    return res.redirect("/onboarding/employer");
  }

  const isApprovedToPost =
    profile.cacVerificationStatus === "verified" &&
    profile.regulatoryVerificationStatus === "verified" &&
    profile.employerApprovalStatus === "approved" &&
    profile.accountStatus === "active";

  if (!isApprovedToPost) {
    return res.status(403).json({
      success: false,
      message: "Your business profile must be verified and approved before you can post shifts.",
      requirements: {
        cacVerificationStatus: profile.cacVerificationStatus,
        regulatoryVerificationStatus: profile.regulatoryVerificationStatus,
        employerApprovalStatus: profile.employerApprovalStatus,
        accountStatus: profile.accountStatus,
      },
    });
  }

  return next();
};
