// controllers/professionalJobAppointmentController.js

const AppointmentService = require("../services/appointmentService");

const JobAppointmentQueryService = require("../services/jobs/appointments/jobAppointmentQueryService");

const JobAppointmentViewService = require("../services/jobs/appointments/jobAppointmentViewService");

const logger = require("../utils/logger");

const PROFESSIONAL_APPOINTMENTS_VIEW = "professional/job-appointments/index";

const PROFESSIONAL_APPOINTMENT_DETAIL_VIEW = "professional/job-appointments/show";

const PROFESSIONAL_APPOINTMENTS_URL = "/professional/job-appointments";

const PROFESSIONAL_APPLICATIONS_URL = "/professional/job-applications";

const MARKETPLACE_JOBS_URL = "/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  res.set("Pragma", "no-cache");

  res.set("Expires", "0");
}

function isOperationalServiceError(error) {
  return ["AppointmentServiceError"].includes(error?.name);
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const isOperationalError = isOperationalServiceError(error);

  const candidateStatusCode = Number(error?.statusCode);

  const statusCode =
    isOperationalError &&
    Number.isInteger(candidateStatusCode) &&
    candidateStatusCode >= 400 &&
    candidateStatusCode <= 599
      ? candidateStatusCode
      : isOperationalError
        ? 400
        : 500;

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ` + `${error.code || "UNKNOWN"} - ` + error.message);
  }

  const response = {
    success: false,

    message: isOperationalError ? error.message : fallbackMessage,

    code: isOperationalError ? error.code : fallbackCode,
  };

  if (isOperationalError && error.details && typeof error.details === "object") {
    response.details = error.details;
  }

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

function getProfessionalProfileId(req) {
  return req.professionalProfile._id;
}

function getActorUserId(req) {
  return req.user._id;
}

function getProfessionalReadContext(req) {
  return {
    userId: getActorUserId(req),

    professionalProfile: req.professionalProfile,
  };
}

function getPublicServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const { events, ...publicResult } = result;

  return publicResult;
}

/* ─────────────────────────────── APPOINTMENT READS ─────────────────────────────── */

/**
 * Professional interview reads are orchestrated here.
 *
 * JobAppointmentQueryService owns:
 *
 * - professional-profile ownership;
 * - appointment ownership;
 * - optional application scope;
 * - appointment-status filtering;
 * - candidate-response filtering;
 * - derived awaiting_employer_update state;
 * - counts; and
 * - pagination.
 *
 * JobAppointmentViewService owns:
 *
 * - interview-round presentation;
 * - schedule/time-zone presentation;
 * - exact publication-cycle presentation;
 * - employer snapshot presentation;
 * - Confirm / Decline availability;
 * - filters;
 * - pagination; and
 * - empty states.
 */
exports.getAppointments = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobAppointmentQueryService.getProfessionalAppointmentsPageData({
      ...getProfessionalReadContext(req),

      status: req.query.status,

      responseStatus: req.query.response,

      applicationId: req.query.application,

      page: req.query.page,

      currentTime,
    });

    const appointmentsView =
      JobAppointmentViewService.buildProfessionalAppointmentsPageView(pageData);

    setNoStoreHeaders(res);

    const breadcrumbs = [
      {
        label: "Home",

        url: "/professional/dashboard",
      },

      {
        label: "Jobs",

        url: MARKETPLACE_JOBS_URL,
      },
    ];

    if (appointmentsView.focusedApplication?.id) {
      breadcrumbs.push({
        label: "Application",

        url: `${PROFESSIONAL_APPLICATIONS_URL}/${appointmentsView.focusedApplication.id}`,
      });
    }

    breadcrumbs.push({
      label: "Interviews",

      url: null,
    });

    return res.render(PROFESSIONAL_APPOINTMENTS_VIEW, {
      layout: "layouts/app-layout",

      title: appointmentsView.pageTitle || "My Interviews",

      breadcrumbs,

      csrfToken: req.csrfToken(),

      appointmentsView,
    });
  } catch (error) {
    logger.error("Professional Job appointments page error:", error);

    return next(error);
  }
};

exports.getAppointment = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobAppointmentQueryService.getProfessionalAppointmentDetailData({
      ...getProfessionalReadContext(req),

      appointmentId: req.params.appointmentId,

      currentTime,
    });

    const appointmentView =
      JobAppointmentViewService.buildProfessionalAppointmentDetailView(detailData);

    setNoStoreHeaders(res);

    const applicationId = appointmentView.application?.id || null;

    return res.render(PROFESSIONAL_APPOINTMENT_DETAIL_VIEW, {
      layout: "layouts/app-layout",

      title: appointmentView.pageTitle || "Interview Details",

      breadcrumbs: [
        {
          label: "Home",

          url: "/professional/dashboard",
        },

        {
          label: "Jobs",

          url: MARKETPLACE_JOBS_URL,
        },

        applicationId
          ? {
              label: "Application",

              url: `${PROFESSIONAL_APPLICATIONS_URL}/${applicationId}`,
            }
          : null,

        {
          label: "Interviews",

          url: PROFESSIONAL_APPOINTMENTS_URL,
        },

        {
          label: appointmentView.appointment?.title || "Interview Details",

          url: null,
        },
      ].filter(Boolean),

      csrfToken: req.csrfToken(),

      appointmentView,
    });
  } catch (error) {
    logger.error("Professional Job appointment detail page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── RESPONSE COMMAND ─────────────────────────────── */

async function respondToAppointment({
  req,
  res,
  responseStatus,
  successMessage,
  logContext,
  fallbackMessage,
  fallbackCode,
}) {
  try {
    const result = await AppointmentService.respondToAppointment({
      appointmentId: req.params.appointmentId,

      professionalProfileId: getProfessionalProfileId(req),

      respondedByUserId: getActorUserId(req),

      responseStatus,

      responseNote: req.body?.responseNote ?? null,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,

      message: successMessage,

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext,
      fallbackMessage,
      fallbackCode,
    });
  }
}

/* ─────────────────────────────── CONFIRM ─────────────────────────────── */

exports.confirmAppointment = async (req, res) => {
  return respondToAppointment({
    req,
    res,

    responseStatus: "confirmed",

    successMessage: "The interview has been confirmed.",

    logContext: "Professional Job interview confirmation",

    fallbackMessage: "The interview could not be confirmed. Please try again.",

    fallbackCode: "JOB_APPOINTMENT_CONFIRMATION_FAILED",
  });
};

/* ─────────────────────────────── DECLINE ─────────────────────────────── */

/**
 * Declining is an Appointment response, not a direct cancellation command.
 *
 * AppointmentService owns the authoritative decline behavior and records the
 * resulting candidate response / appointment cancellation audit consistently.
 */
exports.declineAppointment = async (req, res) => {
  return respondToAppointment({
    req,
    res,

    responseStatus: "declined",

    successMessage: "The interview has been declined.",

    logContext: "Professional Job interview decline",

    fallbackMessage: "The interview could not be declined. Please try again.",

    fallbackCode: "JOB_APPOINTMENT_DECLINE_FAILED",
  });
};
