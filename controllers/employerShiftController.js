// controllers/employerShiftController.js

const ShiftService = require("../services/shiftService");
const ShiftFundingService = require("../services/shiftFundingService");
const ShiftLifecycleService = require("../services/shiftLifecycleService");

const { createServiceError } = require("../services/helpers/serviceErrorHelper");

const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const MANAGE_SHIFTS_VIEW = "employer/shifts/index";
const SHIFT_DETAILS_VIEW = "employer/shifts/show";

const PAYSTACK_SHIFT_CALLBACK_PATH = "/payments/paystack/shift-callback";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function getApplicationBaseUrl(req) {
  const configuredBaseUrl = String(process.env.APP_BASE_URL || process.env.BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function buildAbsoluteUrl(req, path) {
  const normalizedPath = String(path || "").startsWith("/")
    ? String(path)
    : `/${String(path || "")}`;

  return `${getApplicationBaseUrl(req)}${normalizedPath}`;
}

function buildShiftDetailsUrl(shiftId, occurrenceId = null) {
  const baseUrl = `${EMPLOYER_SHIFTS_URL}/${shiftId}`;

  if (!occurrenceId) {
    return baseUrl;
  }

  const searchParams = new URLSearchParams({
    occurrence: String(occurrenceId),
  });

  return `${baseUrl}?${searchParams.toString()}`;
}

function buildActiveWorkCancellationUrl(shiftId, occurrenceId) {
  return (
    `${EMPLOYER_SHIFTS_URL}/${shiftId}` + `/occurrences/${occurrenceId}/active-work-cancellation`
  );
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function isOperationalError(error) {
  return [
    "EmployerShiftControllerError",
    "ShiftServiceError",
    "ShiftFundingServiceError",
    "ShiftLifecycleServiceError",
    "ShiftRefundServiceError",
    "WalletServiceError",
    "PlatformSettingsError",
    "PaystackServiceError",
  ].includes(error?.name);
}

function createControllerError({ message, code, statusCode = 409, details = null }) {
  return createServiceError({
    name: "EmployerShiftControllerError",
    message,
    code,
    statusCode,
    details,
  });
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operationalError = isOperationalError(error);
  const requestedStatusCode = Number(error?.statusCode);

  const statusCode = operationalError
    ? Number.isInteger(requestedStatusCode) &&
      requestedStatusCode >= 400 &&
      requestedStatusCode <= 599
      ? requestedStatusCode
      : 400
    : 500;

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ${error.code || "UNKNOWN"} - ${error.message}`);
  }

  const response = {
    success: false,

    message: operationalError ? error.message : fallbackMessage,

    code: operationalError ? error.code || fallbackCode : fallbackCode,
  };

  if (operationalError && error.details && typeof error.details === "object") {
    response.details = error.details;
  }

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

function buildOccurrenceLifecycleSummary(occurrence) {
  if (!occurrence) {
    return null;
  }

  return {
    id: String(occurrence._id),

    referenceCode: occurrence.referenceCode,

    sequenceNumber: Number(occurrence.sequenceNumber || 0),

    occurrenceDate: occurrence.occurrenceDate || null,

    startTime: occurrence.startTime,

    endTime: occurrence.endTime,

    status: occurrence.status,

    attendanceStatus: occurrence.attendanceStatus,

    assignmentStatus: occurrence.assignmentStatus,

    assignedProfessional: occurrence.assignedProfessional
      ? String(occurrence.assignedProfessional)
      : null,

    assignment: occurrence.assignment ? String(occurrence.assignment) : null,
  };
}

function serializeCancellationPreview(preview) {
  if (!preview || typeof preview !== "object") {
    return preview;
  }

  return {
    ...preview,

    firstAffectedOccurrence: buildOccurrenceLifecycleSummary(preview.firstAffectedOccurrence),

    affectedOccurrences: Array.isArray(preview.affectedOccurrences)
      ? preview.affectedOccurrences.map(buildOccurrenceLifecycleSummary)
      : [],
  };
}

function getLifecycleRequestContext(req) {
  return {
    shiftId: req.params.shiftId,

    userId: req.user._id,

    employerProfileId: req.employerProfile._id,

    employerContext: req.employerContext,

    reason: req.body?.reason,

    now: new Date(),
  };
}

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

    setNoStoreHeaders(res);

    return res.render(MANAGE_SHIFTS_VIEW, {
      layout: "layouts/app-layout",

      title: shiftsView.pageTitle || "Manage Shifts",

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

/* ─────────────────────────────── SHIFT DETAILS ─────────────────────────────── */

exports.getShiftDetails = async (req, res, next) => {
  try {
    const shiftDetailsView = await ShiftService.getEmployerShiftDetailsPageData({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftId: req.params.shiftId,

      occurrenceId: req.query.occurrence,
    });

    const shift = shiftDetailsView.shift;

    setNoStoreHeaders(res);

    return res.render(SHIFT_DETAILS_VIEW, {
      layout: "layouts/app-layout",

      title: shiftDetailsView.pageTitle || "Shift Details",

      breadcrumbs: [
        {
          label: "Home",

          url: "/employer/dashboard",
        },
        {
          label: "Manage Shifts",

          url: EMPLOYER_SHIFTS_URL,
        },
        {
          label: shift?.referenceCode || "Shift Details",

          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      shiftDetailsView,

      scripts: `
        <script src="/js/employer/shift-details.js"></script>
      `,
    });
  } catch (error) {
    logger.error("Employer shift details page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── CREATE PENDING SHIFT ─────────────────────────────── */

exports.postShift = async (req, res) => {
  try {
    const result = await ShiftService.createShift({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftData: req.body,
    });

    const scheduleMode = result.schedule?.scheduleMode || "single";
    const occurrenceCount = Number(result.schedule?.occurrenceCount || 1);

    const successMessage =
      scheduleMode === "multiple"
        ? `Shift engagement ${result.shift.referenceCode} ` +
          `was created with ${occurrenceCount} scheduled shifts. ` +
          "Choose a payment method to publish it."
        : `Shift ${result.shift.referenceCode} was created. ` +
          "Choose a payment method to publish it.";

    const shiftDetailsUrl = buildShiftDetailsUrl(result.shift._id);

    setNoStoreHeaders(res);

    return res.status(201).json({
      success: true,

      message: successMessage,

      nextStep: result.nextStep,

      shift: {
        id: String(result.shift._id),

        referenceCode: result.shift.referenceCode,

        scheduleMode,

        occurrenceCount,

        status: result.shift.status,

        paymentStatus: result.shift.paymentStatus,

        detailsUrl: shiftDetailsUrl,
      },

      schedule: result.schedule,

      occurrences: result.occurrences || [],

      pricing: result.pricing,

      paymentReview: result.paymentReview,

      shiftDetailsUrl,

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer shift creation",

      fallbackMessage: "The Shift could not be created. Please try again.",

      fallbackCode: "SHIFT_CREATION_FAILED",
    });
  }
};

/* ─────────────────────────────── FUND FROM EMPLOYER WALLET ─────────────────────────────── */

exports.fundShiftFromWallet = async (req, res) => {
  try {
    const result = await ShiftFundingService.fundShiftFromWallet({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftId: req.params.shiftId,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      ...result,

      shiftDetailsUrl: buildShiftDetailsUrl(req.params.shiftId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer wallet Shift funding",

      fallbackMessage: "The Shift could not be funded from your wallet. Please try again.",

      fallbackCode: "SHIFT_WALLET_FUNDING_FAILED",
    });
  }
};

/* ─────────────────────────────── INITIALIZE PAYSTACK CHECKOUT ─────────────────────────────── */

exports.initializeShiftCheckout = async (req, res) => {
  try {
    const callbackUrl = buildAbsoluteUrl(req, PAYSTACK_SHIFT_CALLBACK_PATH);

    const result = await ShiftFundingService.initializePaystackCheckout({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftId: req.params.shiftId,

      callbackUrl,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      ...result,

      shiftDetailsUrl: buildShiftDetailsUrl(req.params.shiftId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer Paystack Checkout initialization",

      fallbackMessage: "Paystack Checkout could not be initialized. Please try again.",

      fallbackCode: "SHIFT_CHECKOUT_INITIALIZATION_FAILED",
    });
  }
};

/* ─────────────────────────────── SHIFT OCCURRENCES ─────────────────────────────── */

/**
 * Returns occurrence view data for one parent Shift.
 *
 * This endpoint does not load or expose raw PIN values.
 * Attendance PIN retrieval remains in employerShiftAttendanceController.
 */
exports.getShiftOccurrences = async (req, res) => {
  try {
    const shiftDetailsView = await ShiftService.getEmployerShiftDetailsPageData({
      userId: req.user._id,

      employerProfile: req.employerProfile,

      employerContext: req.employerContext,

      shiftId: req.params.shiftId,

      occurrenceId: req.query.occurrence,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: {
        shiftId: shiftDetailsView.shift.id,

        referenceCode: shiftDetailsView.shift.referenceCode,

        scheduleMode: shiftDetailsView.shift.scheduleMode,

        occurrenceCount: shiftDetailsView.shift.occurrenceCount,

        selectedOccurrenceId: shiftDetailsView.shift.selectedOccurrenceId,

        lifecycleActions: shiftDetailsView.shift.lifecycleActions,

        occurrences: shiftDetailsView.shift.occurrences,
      },
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer Shift occurrence request",

      fallbackMessage: "Unable to retrieve the Shift schedule.",

      fallbackCode: "SHIFT_OCCURRENCE_RETRIEVAL_FAILED",
    });
  }
};

/* ─────────────────────────────── CANCELLATION PREVIEW ─────────────────────────────── */

/**
 * Returns the current employer cancellation outcome before mutation.
 *
 * The preview is recalculated from current occurrence state. The final POST
 * action recalculates the same policy inside its transaction.
 */
exports.getCancellationPreview = async (req, res) => {
  try {
    const preview = await ShiftLifecycleService.getCancellationPreview({
      shiftId: req.params.shiftId,

      employerProfileId: req.employerProfile._id,

      employerContext: req.employerContext,

      now: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      data: serializeCancellationPreview(preview),

      shiftDetailsUrl: buildShiftDetailsUrl(req.params.shiftId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer Shift cancellation preview",

      fallbackMessage: "Unable to calculate the Shift cancellation outcome.",

      fallbackCode: "SHIFT_CANCELLATION_PREVIEW_FAILED",
    });
  }
};

/* ─────────────────────────────── CANCEL SHIFT / ENGAGEMENT ─────────────────────────────── */

/**
 * Unified employer cancellation endpoint.
 *
 * - pending_funding uses cancelPendingFundingShift
 * - funded engagement with no checked-in occurrence uses cancelEngagement
 * - checked-in occurrence must use active-work cancellation
 */
exports.postCancelShift = async (req, res) => {
  try {
    const lifecycleContext = getLifecycleRequestContext(req);

    const preview = await ShiftLifecycleService.getCancellationPreview({
      shiftId: lifecycleContext.shiftId,

      employerProfileId: lifecycleContext.employerProfileId,

      employerContext: lifecycleContext.employerContext,

      now: lifecycleContext.now,
    });

    if (preview.mode === "already_cancelled") {
      setNoStoreHeaders(res);

      return res.status(200).json({
        success: true,

        alreadyFinalized: true,

        message: `Shift ${preview.referenceCode} is already cancelled.`,

        data: serializeCancellationPreview(preview),

        shiftDetailsUrl: buildShiftDetailsUrl(lifecycleContext.shiftId),

        manageShiftsUrl: EMPLOYER_SHIFTS_URL,
      });
    }

    if (preview.mode === "active_work_cancellation") {
      const activeOccurrenceId = preview.firstAffectedOccurrence?._id
        ? String(preview.firstAffectedOccurrence._id)
        : null;

      throw createControllerError({
        message:
          "The professional has checked in. Use active-work cancellation for the active occurrence.",

        code: "SHIFT_ALREADY_CHECKED_IN_USE_ACTIVE_WORK_CANCELLATION",

        statusCode: 409,

        details: {
          occurrenceId: activeOccurrenceId,

          sequenceNumber: preview.firstAffectedOccurrence?.sequenceNumber || null,

          activeWorkCancellationUrl: activeOccurrenceId
            ? buildActiveWorkCancellationUrl(lifecycleContext.shiftId, activeOccurrenceId)
            : null,
        },
      });
    }

    let result;

    if (preview.mode === "pending_funding_cancellation") {
      result = await ShiftLifecycleService.cancelPendingFundingShift(lifecycleContext);
    } else if (preview.mode === "cancellation") {
      result = await ShiftLifecycleService.cancelEngagement(lifecycleContext);
    } else {
      throw createControllerError({
        message: "The current Shift cancellation mode is not supported.",

        code: "UNSUPPORTED_SHIFT_CANCELLATION_MODE",

        statusCode: 409,

        details: {
          mode: preview.mode || null,
        },
      });
    }

    let message;

    if (result.expired) {
      message = "This Shift expired because it was not funded before its scheduled start time.";
    } else if (result.mode === "pending_funding_cancellation") {
      message = `Shift ${result.referenceCode} was cancelled.`;
    } else {
      message = `Shift ${result.referenceCode} was cancelled successfully.`;
    }

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      message,

      data: result,

      shiftDetailsUrl: buildShiftDetailsUrl(lifecycleContext.shiftId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer Shift cancellation",

      fallbackMessage: "The Shift could not be cancelled. Please try again.",

      fallbackCode: "SHIFT_CANCELLATION_FAILED",
    });
  }
};

/* ─────────────────────────────── ACTIVE-WORK CANCELLATION ─────────────────────────────── */

/**
 * Cancels the remaining active work for the selected checked-in occurrence.
 *
 * The lifecycle service applies the greater of the approved pay for time
 * already worked and the snapshotted minimum guaranteed professional pay.
 * Later untouched occurrences are cancelled, and their protected allocations
 * are returned to the employer.
 */
exports.postActiveWorkCancellation = async (req, res) => {
  try {
    const lifecycleContext = getLifecycleRequestContext(req);

    const result = await ShiftLifecycleService.cancelActiveOccurrenceWork({
      ...lifecycleContext,

      occurrenceId: req.params.occurrenceId,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,

      alreadyFinalized: result.alreadyFinalized === true,

      message: result.alreadyFinalized
        ? "Active work has already been cancelled for this occurrence."
        : `Active work was cancelled for Shift occurrence ${result.occurrenceReferenceCode}.`,

      data: result,

      shiftDetailsUrl: buildShiftDetailsUrl(lifecycleContext.shiftId, req.params.occurrenceId),

      manageShiftsUrl: EMPLOYER_SHIFTS_URL,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Employer active-work cancellation",

      fallbackMessage: "Active work could not be cancelled for this Shift occurrence.",

      fallbackCode: "SHIFT_ACTIVE_WORK_CANCELLATION_FAILED",
    });
  }
};
