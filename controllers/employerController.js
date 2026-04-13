// controllers/employerController.js

exports.getDashboard = (req, res) => {
  res.render("dashboard/employer/index", {
    layout: "layouts/app-layout",
    title: "Dashboard",
    breadcrumbs: [
      { label: "Home", url: "/dashboard/employer" },
      { label: "Dashboard", url: null },
    ],
  });
};
