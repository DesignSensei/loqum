// middleware/authMiddleware.js

const {
  getHomeRoute,
  getOnboardingRoute,
  getPostAuthRedirect,
  userHasRole,
} = require("../utils/routeHelper");

function hasAuthenticatedUser(req) {
  return typeof req.isAuthenticated === "function" && req.isAuthenticated() && Boolean(req.user);
}

function expectsJSON(req) {
  const accept = req.get("Accept") || "";

  return (
    Boolean(req.xhr) ||
    accept.includes("application/json") ||
    req.is("application/json") === "application/json"
  );
}

function redirectOrError(req, res, { redirectUrl, statusCode, message }) {
  if (expectsJSON(req)) {
    return res.status(statusCode).json({
      success: false,
      message,
      redirectUrl,
    });
  }

  return res.redirect(redirectUrl);
}

function requireLogin(req, res) {
  return redirectOrError(req, res, {
    redirectUrl: "/login",
    statusCode: 401,
    message: "Session expired. Please log in again.",
  });
}

// ───────────────────── AUTHENTICATION ─────────────────────

exports.isAuthenticated = (req, res, next) => {
  if (hasAuthenticatedUser(req)) {
    return next();
  }

  return requireLogin(req, res);
};

// ───────────────────── GUEST ACCESS ─────────────────────

exports.isGuest = (req, res, next) => {
  if (!hasAuthenticatedUser(req)) {
    return next();
  }

  return res.redirect(getPostAuthRedirect(req.user));
};

// ───────────────────── ROLE AUTHORIZATION ─────────────────────

exports.hasRole = (...roles) => {
  return (req, res, next) => {
    if (!hasAuthenticatedUser(req)) {
      return requireLogin(req, res);
    }

    if (!userHasRole(req.user.role, roles)) {
      if (expectsJSON(req)) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to access this resource.",
        });
      }

      return res.status(403).render("auth/not-found", {
        layout: "layouts/auth-layout-no-index",
        title: "Forbidden",
      });
    }

    return next();
  };
};

// ───────────────────── TWO-FACTOR SETUP ─────────────────────

exports.hasTwoFactor = (req, res, next) => {
  if (!hasAuthenticatedUser(req)) {
    return requireLogin(req, res);
  }

  if (req.user.twoFactorEnabled) {
    return next();
  }

  return redirectOrError(req, res, {
    redirectUrl: "/two-factor",
    statusCode: 403,
    message: "Two-factor authentication setup is required.",
  });
};

// ───────────────────── ACCOUNT VERIFICATION ─────────────────────

exports.isVerified = (req, res, next) => {
  if (!hasAuthenticatedUser(req)) {
    return requireLogin(req, res);
  }

  if (!req.user.isVerified) {
    return redirectOrError(req, res, {
      redirectUrl: "/two-factor",
      statusCode: 403,
      message: "Account verification is required.",
    });
  }

  return next();
};

// ───────────────────── PENDING OTP AUTHENTICATION ─────────────────────

exports.hasPendingAuth = (req, res, next) => {
  if (req.session?.otpContext?.userId && req.session.otpContext.email) {
    return next();
  }

  if (hasAuthenticatedUser(req)) {
    return res.redirect(getPostAuthRedirect(req.user));
  }

  return requireLogin(req, res);
};

// ───────────────────── INCOMPLETE ONBOARDING ─────────────────────

exports.isNotOnboarded = (req, res, next) => {
  if (!hasAuthenticatedUser(req)) {
    return requireLogin(req, res);
  }

  if (!req.user.isOnboarded) {
    return next();
  }

  return redirectOrError(req, res, {
    redirectUrl: getHomeRoute(req.user.role),
    statusCode: 409,
    message: "Onboarding has already been completed.",
  });
};

// ───────────────────── COMPLETED ONBOARDING ─────────────────────

exports.isOnboarded = (req, res, next) => {
  if (!hasAuthenticatedUser(req)) {
    return requireLogin(req, res);
  }

  if (req.user.isOnboarded) {
    return next();
  }

  return redirectOrError(req, res, {
    redirectUrl: getOnboardingRoute(req.user.role),
    statusCode: 403,
    message: "Please complete onboarding before continuing.",
  });
};

// ───────────────────── ACCOUNT ACCESS ─────────────────────

exports.isAccountAllowed = (req, res, next) => {
  if (!hasAuthenticatedUser(req)) {
    return requireLogin(req, res);
  }

  /*
   * Fail closed.
   *
   * Only an explicitly active account may
   * continue to protected application routes.
   *
   * A missing, null or unrecognized account
   * status must not be treated as active.
   *
   * User.accountStatus defaults to "active"
   * when an account is created.
   */

  const accountStatus = req.user.accountStatus;

  if (accountStatus === "active") {
    return next();
  }

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

  /*
   * Unknown account statuses are denied rather
   * than falling through to next().
   */

  const restriction = blockedStatuses[accountStatus] || {
    title: "Account Unavailable",
    message: "Your account access could not be confirmed. Please contact support.",
  };

  const safeAccountStatus =
    typeof accountStatus === "string" &&
    Object.prototype.hasOwnProperty.call(blockedStatuses, accountStatus)
      ? accountStatus
      : "unknown";

  if (expectsJSON(req)) {
    return res.status(403).json({
      success: false,
      message: restriction.message,
      accountStatus: safeAccountStatus,
    });
  }

  return res.status(403).render("auth/account-restricted", {
    layout: "layouts/auth-layout-no-index",
    title: restriction.title,
    message: restriction.message,
    accountStatus: safeAccountStatus,
  });
};
