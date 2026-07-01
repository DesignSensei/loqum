// utils/routeHelper.js

exports.normalizeRole = (role) => {
  const roleMap = {
    admin: "admin",
    employer: "employer",
    professional: "professional",
  };

  return roleMap[role] || null;
};

exports.getHomeRoute = (role) => {
  const normalizedRole = exports.normalizeRole(role);

  const routes = {
    admin: "/admin/dashboard",
    employer: "/employer/dashboard",
    professional: "/professional/dashboard",
  };

  return routes[normalizedRole] || "/login";
};

exports.getOnboardingRoute = (role) => {
  const normalizedRole = exports.normalizeRole(role);

  const routes = {
    employer: "/onboarding/employer",
    professional: "/onboarding/professional",
  };

  return routes[normalizedRole] || "/login";
};

exports.getPostAuthRedirect = (user) => {
  if (!user) {
    return "/login";
  }

  if (user.role === "admin") {
    return exports.getHomeRoute(user.role);
  }

  if (!user.isOnboarded) {
    return exports.getOnboardingRoute(user.role);
  }

  return exports.getHomeRoute(user.role);
};

exports.userHasRole = (userRole, allowedRoles = []) => {
  const normalizedUserRole = exports.normalizeRole(userRole);

  const normalizedAllowedRoles = allowedRoles
    .map((role) => exports.normalizeRole(role))
    .filter(Boolean);

  return normalizedAllowedRoles.includes(normalizedUserRole);
};
