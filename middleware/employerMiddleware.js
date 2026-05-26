// middleware/employerMiddleware.js

const EmployerProfile = require("../models/EmployerProfile");

exports.attachEmployerProfile = async (req, res, next) => {
  try {
    const profile = await EmployerProfile.findOne({ user: req.user._id });
    if (!profile) return res.redirect("/onboarding");
    req.employerProfile = profile;
    next();
  } catch (error) {
    next(error);
  }
};
