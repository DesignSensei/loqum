// controllers/employer/dashboardController.js

const Shift = require("../models/Shift");
const ShiftApplication = require("../models/ShiftApplication");
const Wallet = require("../models/Wallet");

exports.getDashboard = async (req, res, next) => {
  try {
    const employerProfile = req.employerProfile; // attached by middleware

    // --- SHIFT COUNTS ---
    const [openShifts, applicationsToReview, confirmedUpcomingShifts, recentShifts] =
      await Promise.all([
        // Open shifts — posted, no professional assigned yet
        Shift.countDocuments({
          business: employerProfile._id,
          status: "open",
        }),

        // Applications awaiting employer decision across all assigned shifts
        ShiftApplication.countDocuments({
          status: "pending",
          shift: {
            $in: await Shift.distinct("_id", {
              business: employerProfile._id,
              status: "open",
            }),
          },
        }),

        // Confirmed upcoming shifts — escrow funded, not yet started
        Shift.countDocuments({
          business: employerProfile._id,
          status: { $in: ["confirmed", "assigned"] },
          startTime: { $gte: new Date() },
        }),

        // Recent shifts — last 10
        Shift.find({ business: employerProfile._id })
          .sort({ createdAt: -1 })
          .limit(10)
          .populate("branch", "name")
          .lean(),
      ]);

    // --- WALLET ---
    const wallet = await Wallet.findOne({
      ownerType: "employer",
      employer: employerProfile._id,
    }).lean();

    res.render("dashboards/employer/index", {
      layout: "layouts/app-layout",
      title: "Dashboard",
      breadcrumbs: [
        { label: "Home", url: "/employer/dashboard" },
        { label: "Dashboard", url: null },
      ],
      employerProfile,
      stats: {
        openShifts,
        applicationsToReview,
        confirmedUpcomingShifts,
        walletBalance: wallet?.availableBalance ?? 0,
      },
      recentShifts,
    });
  } catch (error) {
    next(error);
  }
};
