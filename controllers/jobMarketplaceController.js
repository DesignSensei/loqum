// controllers/jobMarketplaceController.js

const JobQueryService = require("../services/jobs/jobQueryService");
const JobViewService = require("../services/jobs/jobViewService");

const logger = require("../utils/logger");

const MARKETPLACE_JOBS_VIEW = "jobs/index";

const MARKETPLACE_JOB_DETAIL_VIEW = "jobs/show";

const MARKETPLACE_JOBS_URL = "/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  res.set("Pragma", "no-cache");

  res.set("Expires", "0");
}

/**
 * Public marketplace access does not require authentication.
 *
 * When optional authentication middleware has resolved an authenticated
 * professional, the QueryService can additionally return professional-specific
 * marketplace state such as:
 *
 * - isSaved; and
 * - hasApplied.
 *
 * A non-professional user or guest remains a normal public marketplace reader.
 */
function getOptionalProfessionalReadContext(req) {
  if (!req.user?._id || !req.professionalProfile?._id) {
    return {
      userId: null,

      professionalProfile: null,
    };
  }

  return {
    userId: req.user._id,

    professionalProfile: req.professionalProfile,
  };
}

function getCsrfToken(req) {
  return typeof req.csrfToken === "function" ? req.csrfToken() : null;
}

function getHomeUrl(req) {
  if (req.user?._id && req.professionalProfile?._id) {
    return "/professional/dashboard";
  }

  return "/";
}

/* ─────────────────────────────── MARKETPLACE LIST ─────────────────────────────── */

/**
 * Public permanent-Job marketplace.
 *
 * JobQueryService owns:
 *
 * - live publication filtering;
 * - current Job/publication consistency;
 * - marketplace filters;
 * - search;
 * - pagination;
 * - immutable publication snapshot reads;
 * - Saved Job enrichment for professionals; and
 * - prior-application enrichment for professionals.
 *
 * JobViewService owns:
 *
 * - public employer/business presentation;
 * - Job listing presentation;
 * - filter URLs;
 * - save/unsave state;
 * - Apply availability;
 * - pagination; and
 * - empty states.
 */
exports.getJobs = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const professionalContext = getOptionalProfessionalReadContext(req);

    const pageData = await JobQueryService.getMarketplaceJobsPageData({
      ...professionalContext,

      search: req.query.search,

      professionalType: req.query.professionalType,

      employmentType: req.query.employmentType,

      workplaceType: req.query.workplaceType,

      state: req.query.state,

      lga: req.query.lga,

      page: req.query.page,

      currentTime,
    });

    const jobsView = JobViewService.buildMarketplaceJobsPageView(pageData);

    setNoStoreHeaders(res);

    return res.render(MARKETPLACE_JOBS_VIEW, {
      title: jobsView.pageTitle || "Jobs",

      breadcrumbs: [
        {
          label: "Home",

          url: getHomeUrl(req),
        },

        {
          label: "Jobs",

          url: null,
        },
      ],

      csrfToken: getCsrfToken(req),

      jobsView,
    });
  } catch (error) {
    logger.error("Job marketplace page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── MARKETPLACE DETAIL ─────────────────────────────── */

/**
 * Marketplace detail identity is the JobPublication ID.
 *
 * This ensures the professional sees the exact immutable publication-cycle
 * snapshot currently exposed to the marketplace rather than mutable Job master
 * fields.
 */
exports.getJob = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const professionalContext = getOptionalProfessionalReadContext(req);

    const detailData = await JobQueryService.getMarketplaceJobDetailData({
      publicationId: req.params.publicationId,

      ...professionalContext,

      currentTime,
    });

    const jobView = JobViewService.buildMarketplaceJobDetailView(detailData);

    setNoStoreHeaders(res);

    return res.render(MARKETPLACE_JOB_DETAIL_VIEW, {
      title: jobView.pageTitle || "Job Details",

      breadcrumbs: [
        {
          label: "Home",

          url: getHomeUrl(req),
        },

        {
          label: "Jobs",

          url: MARKETPLACE_JOBS_URL,
        },

        {
          label: jobView.job?.roleTitle || "Job Details",

          url: null,
        },
      ],

      csrfToken: getCsrfToken(req),

      jobView,
    });
  } catch (error) {
    logger.error("Job marketplace detail page error:", error);

    return next(error);
  }
};
