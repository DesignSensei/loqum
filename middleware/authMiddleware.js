// middleware/authMiddleware.js

/* ---------- Check if user is authenticated ---------- */
exports.isAuthenticated = (req, res, next) => {
  if (process.env.NODE_ENV === "development") return next();
  if (req.isAuthenticated()) return next();
  return res.redirect("/login");
};

/* ---------- Check if user is already logged in (for guest-only pages) ---------- */
exports.isGuest = (req, res, next) => {
  if (!req.isAuthenticated()) return next();
  return res.redirect(`/dashboard/${req.user.role}`);
};

/* ---------- Check if user has a specific role ---------- */
exports.hasRole = (...roles) => {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.redirect("/login");
    if (!roles.includes(req.user.role))
      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    return next();
  };
};

/* ---------- Check if user is verified ---------- */
exports.isVerified = (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect("/login");
  if (!req.user.isVerified) return res.redirect("/two-factor");
  return next();
};

/* ---------- Check if user has a pending two-factor session ---------- */
exports.hasPendingAuth = (req, res, next) => {
  if (req.session.user && !req.session.user.isVerified) return next();
  if (req.isAuthenticated()) return res.redirect(`/dashboard/${req.user.role}`);
  return res.redirect("/login");
};

/* ---------- Check if user has NOT completed onboarding ---------- */
exports.isNotOnboarded = (req, res, next) => {
  if (req.user && !req.user.isOnboarded) return next();
  return res.redirect(`/dashboard/${req.user.role}`);
};

/* ---------- Check if user HAS completed onboarding ---------- */
exports.isOnboarded = (req, res, next) => {
  if (req.user && req.user.isOnboarded) return next();
  return res.redirect(`/onboarding/${req.user.role}`);
};

/* ---------- Resolve Employer Context ---------- */
exports.resolveEmployerContext = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== "employer") return next();

    const EmployerProfile = require("../models/EmployerProfile");
    const EmployerMember = require("../models/EmployerMember");

    // Check if they are an owner
    const profile = await EmployerProfile.findOne({ user: req.user._id });
    if (profile) {
      req.employer = {
        type: "owner",
        business: profile._id,
        branch: null,
        role: "owner",
        profile,
      };
      return next();
    }

    // Check if they are an invited member
    const member = await EmployerMember.findOne({ user: req.user._id })
      .populate("business")
      .populate("branch");

    if (member) {
      req.employer = {
        type: "member",
        business: member.business._id,
        branch: member.branch._id,
        role: member.role,
        profile: member,
      };
      return next();
    }

    return res.status(403).json({ message: "Employer profile not found" });
  } catch (error) {
    next(error);
  }
};
