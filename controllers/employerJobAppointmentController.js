// controllers/employerJobAppointmentController.js

const AppointmentService = require("../services/appointmentService");

const JobAppointmentQueryService = require("../services/jobs/appointments/jobAppointmentQueryService");

const JobAppointmentViewService = require("../services/jobs/appointments/jobAppointmentViewService");

const logger = require("../utils/logger");

const EMPLOYER_APPOINTMENTS_VIEW = "employer/job-appointments/index";

const EMPLOYER_APPOINTMENT_DETAIL_VIEW = "employer/job-appointments/show";

const EMPLOYER_APPOINTMENTS_URL = "/employer/job-appointments";

const EMPLOYER_APPLICATIONS_URL = "/employer/job-applications";

const EMPLOYER_JOBS_URL = "/employer/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  res.set("Pragma", "no-cache");

  res.set("Expires", "0");
}

function isOperationalServiceError(error) {
  return ["AppointmentServiceError", "JobApplicationServiceError", "JobServiceError"].includes(
    error?.name
  );
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

function getEmployerServiceContext(req) {
  return {
    employerProfileId: req.employerProfile._id,

    employerContext: req.employerContext || null,
  };
}

function getEmployerReadContext(req) {
  return {
    userId: req.user._id,

    employerProfile: req.employerProfile,

    employerContext: req.employerContext || null,
  };
}

function getActorUserId(req) {
  return req.user._id;
}

function buildScheduleFromBody(body = {}) {
  return {
    format: body?.format,

    startAt: body?.startAt,

    endAt: body?.endAt,

    timeZone: body?.timeZone,

    onsiteLocation: body?.onsiteLocation ?? null,

    meetingLink: body?.meetingLink ?? null,

    phoneNumber: body?.phoneNumber ?? null,
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
 * Employer interview reads are orchestrated here.
 *
 * JobAppointmentQueryService owns:
 *
 * - employer/business authorization;
 * - primary/admin/branch-manager/branch-staff read scope;
 * - optional application scope;
 * - appointment-status filtering;
 * - candidate-response filtering;
 * - derived awaiting_employer_update state;
 * - counts;
 * - pagination; and
 * - read vs management capability.
 *
 * JobAppointmentViewService owns:
 *
 * - appointment and schedule presentation;
 * - candidate presentation;
 * - application/publication presentation;
 * - employer action availability;
 * - read-only state;
 * - filters;
 * - pagination; and
 * - empty states.
 */
exports.getAppointments = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobAppointmentQueryService.getEmployerAppointmentsPageData({
      ...getEmployerReadContext(req),

      status: req.query.status,

      responseStatus: req.query.response,

      applicationId: req.query.application,

      page: req.query.page,

      currentTime,
    });

    const appointmentsView = JobAppointmentViewService.buildEmployerAppointmentsPageView(pageData);

    setNoStoreHeaders(res);

    const breadcrumbs = [
      {
        label: "Home",

        url: "/employer/dashboard",
      },

      {
        label: "Permanent Jobs",

        url: EMPLOYER_JOBS_URL,
      },
    ];

    if (appointmentsView.focusedApplication?.id) {
      breadcrumbs.push({
        label: "Application",

        url: `${EMPLOYER_APPLICATIONS_URL}/${appointmentsView.focusedApplication.id}`,
      });
    }

    breadcrumbs.push({
      label: "Interviews",

      url: null,
    });

    return res.render(EMPLOYER_APPOINTMENTS_VIEW, {
      layout: "layouts/app-layout",

      title: appointmentsView.pageTitle || "Interviews",

      breadcrumbs,

      csrfToken: req.csrfToken(),

      appointmentsView,
    });
  } catch (error) {
    logger.error("Employer Job appointments page error:", error);

    return next(error);
  }
};

exports.getAppointment = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobAppointmentQueryService.getEmployerAppointmentDetailData({
      ...getEmployerReadContext(req),

      appointmentId: req.params.appointmentId,

      currentTime,
    });

    const appointmentView =
      JobAppointmentViewService.buildEmployerAppointmentDetailView(detailData);

    setNoStoreHeaders(res);

    const applicationId = appointmentView.application?.id || null;

    return res.render(EMPLOYER_APPOINTMENT_DETAIL_VIEW, {
      layout: "layouts/app-layout",

      title: appointmentView.pageTitle || "Interview Details",

      breadcrumbs: [
        {
          label: "Home",

          url: "/employer/dashboard",
        },

        {
          label: "Permanent Jobs",

          url: EMPLOYER_JOBS_URL,
        },

        applicationId
          ? {
              label: "Application",

              url: `${EMPLOYER_APPLICATIONS_URL}/${applicationId}`,
            }
          : null,

        {
          label: "Interviews",

          url: EMPLOYER_APPOINTMENTS_URL,
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
    logger.error("Employer Job appointment detail page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── INVITE TO INTERVIEW ─────────────────────────────── */

/**
 * Creates a concrete interview round for one JobApplication.
 *
 * AppointmentService also moves the JobApplication into the interview pipeline
 * stage when required. The Appointment remains the authoritative meeting record.
 */
exports.inviteApplicationToInterview = async (req, res) => {
  try {
    const result = await AppointmentService.inviteApplicationToInterview({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      createdByUserId: getActorUserId(req),

      title: req.body?.title,

      schedule: buildScheduleFromBody(req.body),

      interviewers: Array.isArray(req.body?.interviewers) ? req.body.interviewers : [],

      employerPrivateNote: req.body?.employerPrivateNote ?? null,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(201).json({
      success: true,

      message: "The interview invitation has been created.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer Job interview invitation",

      fallbackMessage: "The interview invitation could not be created. Please try again.",

      fallbackCode: "JOB_APPOINTMENT_INVITATION_FAILED",
    });
  }
};

/* ─────────────────────────────── RESCHEDULE ─────────────────────────────── */

exports.rescheduleAppointment = async (req, res) => {
  try {
    const result = await AppointmentService.rescheduleAppointment({
      appointmentId: req.params.appointmentId,

      ...getEmployerServiceContext(req),

      changedByUserId: getActorUserId(req),

      actorRole: "employer",

      schedule: buildScheduleFromBody(req.body),

      reason: req.body?.reason ?? null,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,

      message: "The interview has been rescheduled.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer Job interview reschedule",

      fallbackMessage: "The interview could not be rescheduled. Please try again.",

      fallbackCode: "JOB_APPOINTMENT_RESCHEDULE_FAILED",
    });
  }
};

/* ─────────────────────────────── CANCEL ─────────────────────────────── */

exports.cancelAppointment = async (req, res) => {
  try {
    const result = await AppointmentService.cancelAppointment({
      appointmentId: req.params.appointmentId,

      ...getEmployerServiceContext(req),

      actorUserId: getActorUserId(req),

      actorRole: "employer",

      cancellationReason: req.body?.cancellationReason ?? req.body?.reason,

      cancellationReasonDetails:
        req.body?.cancellationReasonDetails ?? req.body?.reasonDetails ?? null,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,

      message: "The interview has been cancelled.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer Job interview cancellation",

      fallbackMessage: "The interview could not be cancelled. Please try again.",

      fallbackCode: "JOB_APPOINTMENT_CANCELLATION_FAILED",
    });
  }
};

/* ─────────────────────────────── COMPLETE ─────────────────────────────── */

exports.completeAppointment = async (req, res) => {
  try {
    const result = await AppointmentService.completeAppointment({
      appointmentId: req.params.appointmentId,

      ...getEmployerServiceContext(req),

      completedByUserId: getActorUserId(req),

      actorRole: "employer",

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,

      message: "The interview has been marked completed.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer Job interview completion",

      fallbackMessage: "The interview could not be marked completed. Please try again.",

      fallbackCode: "JOB_APPOINTMENT_COMPLETION_FAILED",
    });
  }
};

/* ─────────────────────────────── NO-SHOW ─────────────────────────────── */

exports.recordNoShow = async (req, res) => {
  try {
    const result = await AppointmentService.recordNoShow({
      appointmentId: req.params.appointmentId,

      ...getEmployerServiceContext(req),

      recordedByUserId: getActorUserId(req),

      actorRole: "employer",

      noShowParty: req.body?.noShowParty,

      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,

      message: "The interview no-show has been recorded.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,

      error,

      logContext: "Employer Job interview no-show",

      fallbackMessage: "The interview no-show could not be recorded. Please try again.",

      fallbackCode: "JOB_APPOINTMENT_NO_SHOW_FAILED",
    });
  }
};
