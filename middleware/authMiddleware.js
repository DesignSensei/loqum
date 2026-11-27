// middleware/authMiddleware.js

const User = require("../models/User");

const {
  getHomeRoute,
  getOnboardingRoute,
  getPostAuthRedirect,
  userHasRole,
} = require("../utils/routeHelper");

function hasAuthenticatedUser(req) {
  const authenticated =
    typeof req.isAuthenticated === "function" &&
    req.isAuthenticated() &&
    Boolean(req.user) &&
    req.user.accountStatus !== "closed";

  if (!authenticated && req.session) {
    delete req.session.user;
  }

  return authenticated;
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

exports.hasPendingAuth = async (req, res, next) => {
  try {
    const context = req.session?.otpContext;

    if (context) {
      const userId = String(context.userId || "");

      const email = String(context.email || "")
        .trim()
        .toLowerCase();

      if (
        /^[a-f0-9]{24}$/i.test(userId) &&
        email &&
        !email.endsWith("@closed.loqum.invalid")
      ) {
        const user = await User.findOne({
          _id: userId,
          email,
          accountStatus: {
            $in: ["active", "restricted"],
          },
        })
          .select("_id")
          .lean();

        if (user) {
          return next();
        }
      }

      delete req.session.otpContext;
    }

    if (hasAuthenticatedUser(req)) {
      return res.redirect(getPostAuthRedirect(req.user));
    }

    return requireLogin(req, res);
  } catch (error) {
    return next(error);
  }
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

  // Fail closed. Only explicitly active accounts may access
  // protected application routes.
  // Missing or unknown statuses are not treated as active.
  // Closed accounts cannot regain access to historical accounts.

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

    closed: {
      title: "Account Closed",
      message:
        "This LOQUM account has been closed and can no longer be accessed. You may register again if eligible.",
    },
  };

  // Unknown account statuses are denied rather than falling through.

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
