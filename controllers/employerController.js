// controllers/employerController.js

exports.getDashboard = (req, res) => {
  res.render("dashboards/employer/index", {
    layout: "layouts/app-layout",
    title: "Dashboard",
    breadcrumbs: [
      { label: "Home", url: "/employer/dashboard" },
      { label: "Dashboard", url: null },
    ],
  });
};
