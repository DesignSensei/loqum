// controllers/professionalController.js

exports.getDashboard = (req, res) => {
  res.render("dashboards/professional/index", {
    layout: "layouts/app-layout",
    title: "Dashboard",
    breadcrumbs: [
      { label: "Home", url: "/professional/dashboard" },
      { label: "Dashboard", url: null },
    ],
  });
};
