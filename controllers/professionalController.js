// controllers/professionalController.js

const ProfessionalService = require("../services/professionalService");

exports.getDashboard = async (req, res, next) => {
  try {
    const professionalProfile = req.professionalProfile;

    const dashboardData = await ProfessionalService.getDashboardData(professionalProfile);

    res.render("professional/dashboard/index", {
      layout: "layouts/app-layout",
      title: "Dashboard",
      breadcrumbs: [
        { label: "Home", url: "/professional/dashboard" },
        { label: "Dashboard", url: null },
      ],
      ...dashboardData,
    });
  } catch (error) {
    next(error);
  }
};
