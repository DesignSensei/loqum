// middleware/professionalMiddleware.js

const ProfessionalProfile = require("../models/ProfessionalProfile");

const { getProfessionalKycStatus } = require("../utils/statusHelper");

// ───────────────────── ATTACH PROFESSIONAL PROFILE ─────────────────────

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

    // Resolve the profile through the authenticated user.
    const profile = await ProfessionalProfile.findOne({
      user: req.user._id,
    });

    if (!profile) {
      return res.redirect("/onboarding/professional");
    }

    req.professionalProfile = profile;

    return next();
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── SHIFT APPLICATION ELIGIBILITY ─────────────────────

/**
 * A professional must satisfy all five existing
 * marketplace eligibility requirements:
 *
 * - Verified identity
 * - Verified professional licence
 * - Approved professional account
 * - Active account status
 * - Visible marketplace status
 *
 * Payout readiness is separate from eligibility
 * to apply for shifts.
 *
 * Recheck the current database state before allowing
 * a new application.
 */
exports.canApplyForShifts = async (req, res, next) => {
  try {
    const profile = req.professionalProfile;

    if (!profile) {
      return res.redirect("/onboarding/professional");
    }

    // Check the current verification and marketplace state.
    const currentProfile = await ProfessionalProfile.findOne({
      _id: profile._id,
      user: req.user?._id,
    })
      .select(
        "identityVerificationStatus " +
          "licenceVerificationStatus " +
          "professionalApprovalStatus " +
          "accountStatus " +
          "marketplaceStatus"
      )
      .lean();

    if (!currentProfile) {
      return res.status(403).json({
        success: false,
        message: "Professional profile access is unavailable.",
      });
    }

    const professionalKycStatus = getProfessionalKycStatus(currentProfile);

    if (!professionalKycStatus.isEligible) {
      return res.status(403).json({
        success: false,
        message:
          "Your identity, licence, professional approval, account status, " +
          "and marketplace visibility must meet Loqum's requirements " +
          "before you can apply for shifts.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
