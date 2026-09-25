// controllers/adminJobApplicationController.js

const JobApplicationQueryService = require("../services/jobs/applications/jobApplicationQueryService");
const JobApplicationViewService = require("../services/jobs/applications/jobApplicationViewService");

const logger = require("../utils/logger");

const ADMIN_APPLICATIONS_VIEW = "admin/job-applications/index";
const ADMIN_APPLICATION_DETAIL_VIEW = "admin/job-applications/show";

const ADMIN_APPLICATIONS_URL = "/admin/job-applications";
const ADMIN_JOBS_URL = "/admin/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

/* ─────────────────────────────── APPLICATION READS ─────────────────────────────── */

/**
 * Platform-admin application reads are read-only oversight.
 *
 * JobApplicationQueryService owns:
 *
 * - optional employer scope;
 * - optional Job scope;
 * - application-status filtering;
 * - admin-safe candidate projection;
 * - admin-safe resume projection;
 * - counts; and
 * - pagination.
 *
 * JobApplicationViewService owns:
 *
 * - candidate presentation;
 * - Job/publication presentation;
 * - screening presentation;
 * - filters;
 * - pagination;
 * - empty states; and
 * - read-only admin presentation.
 *
 * This controller exposes no recruitment-stage mutation authority.
 */
exports.getApplications = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobApplicationQueryService.getAdminApplicationsPageData({
      employerProfileId: req.query.employer,

      status: req.query.status,

      jobId: req.query.job,

      page: req.query.page,

      currentTime,
    });

    const applicationsView = JobApplicationViewService.buildAdminApplicationsPageView(pageData);

    setNoStoreHeaders(res);

    return res.render(ADMIN_APPLICATIONS_VIEW, {
      layout: "layouts/app-layout",

      title: applicationsView.pageTitle || "Job Applications",

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },

        {
          label: "Permanent Jobs",
          url: ADMIN_JOBS_URL,
        },

        {
          label: "Applications",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      applicationsView,
    });
  } catch (error) {
    logger.error("Admin Job applications page error:", error);

    return next(error);
  }
};

exports.getApplication = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobApplicationQueryService.getAdminApplicationDetailData({
      applicationId: req.params.applicationId,

      currentTime,
    });

    const applicationView = JobApplicationViewService.buildAdminApplicationDetailView(detailData);

    setNoStoreHeaders(res);

    return res.render(ADMIN_APPLICATION_DETAIL_VIEW, {
      layout: "layouts/app-layout",

      title: applicationView.pageTitle || "Application Details",

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },

        {
          label: "Permanent Jobs",
          url: ADMIN_JOBS_URL,
        },

        {
          label: "Applications",
          url: ADMIN_APPLICATIONS_URL,
        },

        {
          label:
            applicationView.application?.candidate?.name ||
            applicationView.application?.publication?.roleTitle ||
            "Application Details",

          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      applicationView,
    });
  } catch (error) {
    logger.error("Admin Job application detail page error:", error);

    return next(error);
  }
};
