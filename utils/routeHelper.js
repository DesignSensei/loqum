// utils/routeHelper.js

exports.getHomeRoute = (role) => {
  const routes = {
    admin: "/admin/dashboard",
    pharmacist: "/pharmacist/dashboard",
    employer: "/employer/dashboard",
  };
  return routes[role] || "/auth/login";
};
