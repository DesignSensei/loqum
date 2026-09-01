// controllers/adminController.js

exports.getDashboard = (req, res) => {
  res.render("admin/dashboard/index", {
    layout: "layouts/app-layout",
    title: "Dashboard",
    breadcrumbs: [
      { label: "Home", url: "/admin/dashboard" },
      { label: "Dashboard", url: null },
    ],
  });
};
