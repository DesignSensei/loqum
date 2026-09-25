// controllers/adminJobAppointmentController.js

const JobAppointmentQueryService = require("../services/jobs/appointments/jobAppointmentQueryService");
const JobAppointmentViewService = require("../services/jobs/appointments/jobAppointmentViewService");

const logger = require("../utils/logger");

const ADMIN_APPOINTMENTS_VIEW = "admin/job-appointments/index";
const ADMIN_APPOINTMENT_DETAIL_VIEW = "admin/job-appointments/show";

const ADMIN_APPOINTMENTS_URL = "/admin/job-appointments";
const ADMIN_APPLICATIONS_URL = "/admin/job-applications";
const ADMIN_JOBS_URL = "/admin/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

/* ─────────────────────────────── APPOINTMENT READS ─────────────────────────────── */

/**
 * Platform-admin appointment reads are read-only oversight.
 *
 * JobAppointmentQueryService owns:
 *
 * - optional employer scope;
 * - optional application scope;
 * - appointment-status filtering;
 * - candidate-response filtering;
 * - derived awaiting_employer_update state;
 * - counts; and
 * - pagination.
 *
 * JobAppointmentViewService owns:
 *
 * - appointment and schedule presentation;
 * - candidate presentation;
 * - application/publication presentation;
 * - filters;
 * - pagination;
 * - empty states; and
 * - read-only admin presentation.
 *
 * This controller exposes no appointment mutation authority.
 */
exports.getAppointments = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobAppointmentQueryService.getAdminAppointmentsPageData({
      employerProfileId: req.query.employer,

      status: req.query.status,

      responseStatus: req.query.response,

      applicationId: req.query.application,

      page: req.query.page,

      currentTime,
    });

    const appointmentsView = JobAppointmentViewService.buildAdminAppointmentsPageView(pageData);

    setNoStoreHeaders(res);

    const breadcrumbs = [
      {
        label: "Home",

        url: "/admin/dashboard",
      },

      {
        label: "Permanent Jobs",

        url: ADMIN_JOBS_URL,
      },
    ];

    if (appointmentsView.focusedApplication?.id) {
      breadcrumbs.push({
        label: "Application",

        url: `${ADMIN_APPLICATIONS_URL}/${appointmentsView.focusedApplication.id}`,
      });
    }

    breadcrumbs.push({
      label: "Interviews",

      url: null,
    });

    return res.render(ADMIN_APPOINTMENTS_VIEW, {
      layout: "layouts/app-layout",

      title: appointmentsView.pageTitle || "Interviews",

      breadcrumbs,

      csrfToken: req.csrfToken(),

      appointmentsView,
    });
  } catch (error) {
    logger.error("Admin Job appointments page error:", error);

    return next(error);
  }
};

exports.getAppointment = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobAppointmentQueryService.getAdminAppointmentDetailData({
      appointmentId: req.params.appointmentId,

      currentTime,
    });

    const appointmentView = JobAppointmentViewService.buildAdminAppointmentDetailView(detailData);

    setNoStoreHeaders(res);

    const applicationId = appointmentView.application?.id || null;

    return res.render(ADMIN_APPOINTMENT_DETAIL_VIEW, {
      layout: "layouts/app-layout",

      title: appointmentView.pageTitle || "Interview Details",

      breadcrumbs: [
        {
          label: "Home",

          url: "/admin/dashboard",
        },

        {
          label: "Permanent Jobs",

          url: ADMIN_JOBS_URL,
        },

        applicationId
          ? {
              label: "Application",

              url: `${ADMIN_APPLICATIONS_URL}/${applicationId}`,
            }
          : null,

        {
          label: "Interviews",

          url: ADMIN_APPOINTMENTS_URL,
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
    logger.error("Admin Job appointment detail page error:", error);

    return next(error);
  }
};
