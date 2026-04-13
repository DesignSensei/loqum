// controllers/employerController.js

exports.getDashboard = (req, res) => {
  res.render("dashboard/pharmacist/index", {
    layout: "layouts/app-layout",
    title: "Dashboard",
    breadcrumbs: [
      { label: "Home", url: "/dashboard/pharmacist" },
      { label: "Dashboard", url: null },
    ],
  });
};
