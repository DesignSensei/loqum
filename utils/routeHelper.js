// utils/routeHelper.js

exports.getHomeRoute = (role) => {
  const routes = {
    admin: "/admin/dashboard",
    pharmacist: "/professional/dashboard",
    employer: "/employer/dashboard",
  };
  return routes[role] || "/auth/login";
};
