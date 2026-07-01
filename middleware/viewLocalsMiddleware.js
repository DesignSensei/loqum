// middleware/viewLocalsMiddleware.js

const { getPostAuthRedirect } = require("../utils/routeHelper");

function getUserDisplayName(user) {
  if (!user) return "";

  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

  return user.displayName || fullName || user.email || "User";
}

function getUserInitials(user) {
  if (!user) return "U";

  const firstName = String(user.firstName || "").trim();
  const lastName = String(user.lastName || "").trim();

  if (firstName && lastName) {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
  }

  if (firstName) {
    return firstName.charAt(0).toUpperCase();
  }

  if (user.email) {
    return user.email.charAt(0).toUpperCase();
  }

  return "U";
}

function getUserAccountUrl(user) {
  if (!user) return "";

  return "/account/settings";
}

function getUserRoleBadge(user) {
  if (!user || !user.role) {
    return {
      label: "User",
      className: "badge-light-secondary",
    };
  }

  const badges = {
    admin: {
      label: "Admin",
      className: "badge-light-danger",
    },
    employer: {
      label: "Employer",
      className: "badge-light-primary",
    },
    professional: {
      label: "Professional",
      className: "badge-light-success",
    },
  };

  return (
    badges[user.role] || {
      label: "User",
      className: "badge-light-secondary",
    }
  );
}

module.exports = function attachViewLocals(req, res, next) {
  const currentUser = req.user || req.session.user || null;

  res.locals.user = currentUser;
  res.locals.currentUser = currentUser;

  res.locals.csrfToken = req.csrfToken();

  res.locals.userHome = currentUser ? getPostAuthRedirect(currentUser) : "/";

  res.locals.userDisplayName = getUserDisplayName(currentUser);
  res.locals.userInitials = getUserInitials(currentUser);
  res.locals.userEmail = currentUser?.email || "";
  res.locals.userPhoto = currentUser?.photo || "";
  res.locals.userRoleBadge = getUserRoleBadge(currentUser);
  res.locals.userAccountUrl = getUserAccountUrl(currentUser);

  res.locals.breadcrumbs = res.locals.breadcrumbs || [];

  next();
};
