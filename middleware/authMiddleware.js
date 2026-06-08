// middleware/authMiddleware.js

const { getHomeRoute, getOnboardingRoute, userHasRole } = require("../utils/routeHelper");

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

  return res.redirect(getHomeRoute(req.user.role));
};

/* ---------- Check if user has a specific role ---------- */
exports.hasRole = (...roles) => {
  return (req, res, next) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.redirect("/login");
    }

    if (!userHasRole(req.user.role, roles)) {
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
    return res.redirect(getHomeRoute(req.user.role));
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

  return res.redirect(getHomeRoute(req.user.role));
};

/* ---------- Check if user HAS completed onboarding ---------- */
exports.isOnboarded = (req, res, next) => {
  if (!req.user) {
    return res.redirect("/login");
  }

  if (req.user.isOnboarded) {
    return next();
  }

  return res.redirect(getOnboardingRoute(req.user.role));
};

/* ---------- Check if user account is allowed to access the platform ---------- */
exports.isAccountAllowed = (req, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.redirect("/login");
  }

  const accountStatus = req.user.accountStatus || "active";

  const blockedStatuses = {
    suspended: {
      title: "Account Suspended",
      message:
        "Your account has been suspended. Please contact support if you believe this is a mistake.",
    },
    restricted: {
      title: "Account Restricted",
      message: "Your account is currently restricted. Some platform features are unavailable.",
    },
    deactivated: {
      title: "Account Deactivated",
      message: "This account has been deactivated. Please contact support for assistance.",
    },
    banned: {
      title: "Account Unavailable",
      message: "This account can no longer access the platform.",
    },
  };

  if (blockedStatuses[accountStatus]) {
    return res.status(403).render("auth/account-restricted", {
      layout: "layouts/auth-layout-no-index",
      title: blockedStatuses[accountStatus].title,
      message: blockedStatuses[accountStatus].message,
      accountStatus,
    });
  }

  return next();
};
