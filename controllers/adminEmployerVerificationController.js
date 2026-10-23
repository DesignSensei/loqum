// controllers/adminEmployerVerificationController.js

const AdminEmployerVerificationService = require("../services/adminEmployerVerificationService");

const logger = require("../utils/logger");

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    logger.error(
      `${operation}: ${
        typeof error?.code === "string" && /^[A-Z0-9_]{2,100}$/.test(error.code)
          ? error.code
          : "ADMIN_EMPLOYER_VERIFICATION_ERROR"
      }`
    );
  }

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? "Unable to complete the verification request."
        : error?.message || "Invalid verification request.",
  });
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

// Dashboard page
exports.getDashboardPage = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const pageOptions = await AdminEmployerVerificationService.getDashboardPageOptions({
      adminUserId: req.user?._id,
    });

    return res.render("admin/employer-verifications/index", {
      ...pageOptions,
      csrfToken: req.csrfToken(),
    });
  } catch (error) {
    logger.error(
      `Render employer verification dashboard: ${
        typeof error?.code === "string" && /^[A-Z0-9_]{2,100}$/.test(error.code)
          ? error.code
          : "ADMIN_EMPLOYER_VERIFICATION_ERROR"
      }`
    );

    return next(error);
  }
};

// Verification queue
exports.listEmployers = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.listEmployers({
      adminUserId: req.user?._id,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "List employer verifications");
  }
};

// Employer verification details
exports.getEmployerVerification = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.getEmployerVerification({
      adminUserId: req.user?._id,
      employerProfileId: req.params.employerProfileId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get employer verification");
  }
};

// Administrator CAC recheck
exports.recheckCAC = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.recheckCAC({
      adminUserId: req.user?._id,
      employerProfileId: req.params.employerProfileId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Recheck CAC registration");
  }
};

// Manual PCN review
exports.reviewPCN = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminEmployerVerificationService.reviewPCN({
      adminUserId: req.user?._id,
      employerProfileId: req.params.employerProfileId,
      decision: req.body?.decision,
      nameOnRecord: req.body?.nameOnRecord,
      note: req.body?.note,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Review PCN registration");
  }
};
