// utils/routeHelper.js

exports.normalizeRole = (role) => {
  const roleMap = {
    admin: "admin",
    employer: "employer",

    // Backward compatibility
    pharmacist: "professional",
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

  return routes[normalizedRole] || "/auth/login";
};

exports.getOnboardingRoute = (role) => {
  const normalizedRole = exports.normalizeRole(role);

  const routes = {
    employer: "/onboarding/employer",
    professional: "/onboarding/professional",
  };

  return routes[normalizedRole] || "/auth/login";
};

exports.userHasRole = (userRole, allowedRoles = []) => {
  const normalizedUserRole = exports.normalizeRole(userRole);

  const normalizedAllowedRoles = allowedRoles
    .map((role) => exports.normalizeRole(role))
    .filter(Boolean);

  return normalizedAllowedRoles.includes(normalizedUserRole);
};
