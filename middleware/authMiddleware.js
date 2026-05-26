// middleware/authMiddleware.js

/* ---------- Check if user is authenticated ---------- */
exports.isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    return next();
  }

  return res.redirect("/login");
};

/* ---------- Check if user is already logged in (for guest-only pages) ---------- */
exports.isGuest = (req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return next();
  }

  return res.redirect(`/${req.user.role}/dashboard`);
};

/* ---------- Check if user has a specific role ---------- */
exports.hasRole = (...roles) => {
  return (req, res, next) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.redirect("/login");
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    }

    return next();
  };
};

/* ---------- Check if user is verified ---------- */
exports.isVerified = (req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.redirect("/login");
  }

  if (!req.user.isVerified) {
    return res.redirect("/two-factor");
  }

  return next();
};

/* ---------- Check if user has a pending two-factor session ---------- */
exports.hasPendingAuth = (req, res, next) => {
  if (req.session.user && !req.session.user.isVerified) {
    return next();
  }

  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    return res.redirect(`/${req.user.role}/dashboard`);
  }

  return res.redirect("/login");
};

/* ---------- Check if user has NOT completed onboarding ---------- */
exports.isNotOnboarded = (req, res, next) => {
  if (!req.user) {
    return res.redirect("/login");
  }

  if (!req.user.isOnboarded) {
    return next();
  }

  return res.redirect(`/${req.user.role}/dashboard`);
};

/* ---------- Check if user HAS completed onboarding ---------- */
exports.isOnboarded = (req, res, next) => {
  if (!req.user) {
    return res.redirect("/login");
  }

  if (req.user.isOnboarded) {
    return next();
  }

  return res.redirect(`/${req.user.role}/onboarding`);
};
