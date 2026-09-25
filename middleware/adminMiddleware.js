// middleware/adminMiddleware.js

const mongoose = require("mongoose");

const EmployerProfile = require("../models/EmployerProfile");

function createAdminMiddlewareError({ message, code, statusCode = 400, details = null }) {
  const error = new Error(message);

  error.name = "AdminMiddlewareError";
  error.code = code;
  error.statusCode = statusCode;

  if (details && typeof details === "object") {
    error.details = details;
  }

  return error;
}

function assertAdminRequest(req) {
  if (!req.user?._id) {
    throw createAdminMiddlewareError({
      message: "Admin authentication context is unavailable.",
      code: "ADMIN_AUTH_CONTEXT_REQUIRED",
      statusCode: 401,
    });
  }

  if (req.user.role !== "admin") {
    throw createAdminMiddlewareError({
      message: "Admin access is required.",
      code: "ADMIN_ACCESS_REQUIRED",
      statusCode: 403,
    });
  }

  return true;
}

function getEmployerProfileId(req) {
  const employerProfileId = req.params?.employerProfileId;

  if (!employerProfileId || !mongoose.isValidObjectId(employerProfileId)) {
    throw createAdminMiddlewareError({
      message: "Employer profile ID is invalid.",
      code: "INVALID_EMPLOYER_PROFILE_ID",
      statusCode: 400,
    });
  }

  return new mongoose.Types.ObjectId(String(employerProfileId));
}

/**
 * Establishes the employer an authenticated admin is currently acting for.
 *
 * This does not:
 *
 * - replace req.user;
 * - impersonate an employer user;
 * - manufacture employerContext;
 * - grant branch-manager/business-admin permissions.
 *
 * The admin remains the actual actor throughout the request.
 */
exports.attachAdminEmployerContext = async (req, res, next) => {
  try {
    assertAdminRequest(req);

    const employerProfileId = getEmployerProfileId(req);

    const employerProfile = await EmployerProfile.findById(employerProfileId).select(
      "user businessName countryCode currency accountStatus employerApprovalStatus"
    );

    if (!employerProfile) {
      throw createAdminMiddlewareError({
        message: "Employer profile was not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    req.adminEmployerContext = {
      adminUserId: req.user._id,
      employerProfileId: employerProfile._id,
      employerProfile,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Defensive middleware for routes that require an employer-targeted
 * admin operation after attachAdminEmployerContext has already run.
 */
exports.requireAdminEmployerContext = (req, res, next) => {
  try {
    assertAdminRequest(req);

    const adminEmployerContext = req.adminEmployerContext;

    if (
      !adminEmployerContext?.adminUserId ||
      !adminEmployerContext?.employerProfileId ||
      !adminEmployerContext?.employerProfile?._id
    ) {
      throw createAdminMiddlewareError({
        message: "An employer context is required for this admin operation.",
        code: "ADMIN_EMPLOYER_CONTEXT_REQUIRED",
        statusCode: 500,
      });
    }

    if (String(adminEmployerContext.adminUserId) !== String(req.user._id)) {
      throw createAdminMiddlewareError({
        message: "Admin employer context actor does not match the authenticated admin.",
        code: "ADMIN_EMPLOYER_CONTEXT_ACTOR_MISMATCH",
        statusCode: 500,
      });
    }

    if (
      String(adminEmployerContext.employerProfileId) !==
      String(adminEmployerContext.employerProfile._id)
    ) {
      throw createAdminMiddlewareError({
        message: "Admin employer context contains inconsistent employer identity.",
        code: "ADMIN_EMPLOYER_CONTEXT_EMPLOYER_MISMATCH",
        statusCode: 500,
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
