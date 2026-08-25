// controllers/branchController.js

const BranchService = require("../services/branchService");

const BUSINESS_PROFILE_BRANCHES_URL = "/employer/business-profile?tab=branches";

const BUSINESS_PROFILE_TEAM_URL = "/employer/business-profile?tab=team";

//─────────────────────────────── LEGACY / SAFE GET REDIRECTS ───────────────────────────────//

exports.getBranches = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_BRANCHES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.getNewBranch = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_BRANCHES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.getEditBranch = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_BRANCHES_URL);
  } catch (error) {
    return next(error);
  }
};

exports.getBranchMembers = async (req, res, next) => {
  try {
    return res.redirect(BUSINESS_PROFILE_TEAM_URL);
  } catch (error) {
    return next(error);
  }
};

//─────────────────────────────── BRANCH ACTIONS ───────────────────────────────//

exports.postNewBranch = async (req, res) => {
  try {
    await BranchService.createBranch({
      businessId: req.employerProfile._id,
      body: req.body,
    });

    return res.status(201).json({
      success: true,
      message: "Branch added successfully.",
      redirectUrl: BUSINESS_PROFILE_BRANCHES_URL,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Unable to add branch.",
    });
  }
};

exports.postEditBranch = async (req, res) => {
  try {
    const branchId = req.params.branchId || req.body.branchId;

    if (!branchId) {
      return res.status(400).json({
        success: false,
        message: "Branch ID is required.",
      });
    }

    await BranchService.updateBranch({
      branchId,
      businessId: req.employerProfile._id,
      body: req.body,
    });

    return res.json({
      success: true,
      message: "Branch updated successfully.",
      redirectUrl: BUSINESS_PROFILE_BRANCHES_URL,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Unable to update branch.",
    });
  }
};
