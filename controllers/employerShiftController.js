// controllers/employerShiftController.js

const ShiftService = require("../services/shiftService");
const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const MANAGE_SHIFTS_VIEW = "employer/shifts/index";

/* ─────────────────────────────── MANAGE SHIFTS ─────────────────────────────── */

exports.getManageShifts = async (req, res, next) => {
  try {
    const shiftsView = await ShiftService.getEmployerShiftsPageData({
      userId: req.user._id,
      employerProfile: req.employerProfile,
      employerContext: req.employerContext,
      status: req.query.status,
      page: req.query.page,
    });

    return res.render(MANAGE_SHIFTS_VIEW, {
      layout: "layouts/app-layout",
      title: "Manage Shifts",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Manage Shifts",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      shiftsView,

      scripts: `
        <script src="/js/employer/manage-shifts.js"></script>
      `,
    });
  } catch (error) {
    logger.error("Employer manage shifts page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── CREATE SHIFT ─────────────────────────────── */

exports.postShift = async (req, res) => {
  try {
    const result = await ShiftService.createShift({
      userId: req.user._id,
      employerProfile: req.employerProfile,
      employerContext: req.employerContext,
      shiftData: req.body,
    });

    return res.status(201).json({
      success: true,
      message: `Shift ${result.shift.referenceCode} was posted successfully.`,

      shift: {
        id: String(result.shift._id),
        referenceCode: result.shift.referenceCode,
      },

      pricing: result.pricing,

      redirectUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    const isShiftServiceError = error.name === "ShiftServiceError";

    const statusCode = isShiftServiceError ? error.statusCode || 400 : 500;

    if (statusCode >= 500) {
      logger.error("Employer shift creation error:", error);
    } else {
      logger.warn(
        `Employer shift creation rejected: ${error.code || "UNKNOWN"} - ${error.message}`
      );
    }

    return res.status(statusCode).json({
      success: false,

      message: isShiftServiceError
        ? error.message
        : "The shift could not be posted. Please try again.",

      code: isShiftServiceError ? error.code : "SHIFT_CREATION_FAILED",
    });
  }
};

/* ─────────────────────────────── CHECK-IN PIN ─────────────────────────────── */

exports.getCheckInPin = async (req, res) => {
  try {
    const result = await ShiftService.getEmployerCheckInPin({
      shiftId: req.params.shiftId,
      employerProfileId: req.employerProfile._id,
      employerContext: req.employerContext,
    });

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const isShiftServiceError = error.name === "ShiftServiceError";

    const statusCode = isShiftServiceError ? error.statusCode || 400 : 500;

    if (statusCode >= 500) {
      logger.error("Employer check-in PIN error:", error);
    } else {
      logger.warn(
        `Employer check-in PIN request rejected: ${error.code || "UNKNOWN"} - ${error.message}`
      );
    }

    res.set("Cache-Control", "no-store");

    return res.status(statusCode).json({
      success: false,

      message: isShiftServiceError ? error.message : "Unable to retrieve the check-in PIN.",

      code: isShiftServiceError ? error.code : "CHECK_IN_PIN_RETRIEVAL_FAILED",
    });
  }
};

/* ─────────────────────────────── CHECK-OUT PIN ─────────────────────────────── */

exports.getCheckOutPin = async (req, res) => {
  try {
    const result = await ShiftService.getEmployerCheckOutPin({
      shiftId: req.params.shiftId,
      employerProfileId: req.employerProfile._id,
      employerContext: req.employerContext,
    });

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const isShiftServiceError = error.name === "ShiftServiceError";

    const statusCode = isShiftServiceError ? error.statusCode || 400 : 500;

    if (statusCode >= 500) {
      logger.error("Employer check-out PIN error:", error);
    } else {
      logger.warn(
        `Employer check-out PIN request rejected: ${error.code || "UNKNOWN"} - ${error.message}`
      );
    }

    res.set("Cache-Control", "no-store");

    return res.status(statusCode).json({
      success: false,

      message: isShiftServiceError ? error.message : "Unable to retrieve the check-out PIN.",

      code: isShiftServiceError ? error.code : "CHECK_OUT_PIN_RETRIEVAL_FAILED",
    });
  }
};
