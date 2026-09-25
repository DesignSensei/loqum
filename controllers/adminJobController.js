// controllers/adminJobController.js

const JobService = require("../services/jobService");
const JobPublicationService = require("../services/jobPublicationService");
const JobPublicationEntitlementService = require("../services/jobPublicationEntitlementService");

const JobQueryService = require("../services/jobs/jobQueryService");
const JobViewService = require("../services/jobs/jobViewService");

const logger = require("../utils/logger");

const ADMIN_JOBS_VIEW = "admin/jobs/index";
const ADMIN_JOB_DETAIL_VIEW = "admin/jobs/show";

const ADMIN_JOBS_URL = "/admin/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function isOperationalServiceError(error) {
  return [
    "JobServiceError",
    "JobPublicationServiceError",
    "JobPublicationEntitlementServiceError",
  ].includes(error?.name);
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

function getActorUserId(req) {
  return req.user._id;
}

function getAdminEmployerServiceContext(req) {
  return {
    employerProfileId: req.adminEmployerContext.employerProfileId,
    employerContext: null,
    adminEmployerContext: req.adminEmployerContext,
  };
}

function getPublicServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const { events, ...publicResult } = result;

  return publicResult;
}

/* ─────────────────────────────── ADMIN JOB READS ─────────────────────────────── */

/**
 * Platform-admin Job reads are oversight reads.
 *
 * They do not use employerContext and do not impersonate an employer.
 * JobQueryService owns platform-wide filtering and Job ownership resolution.
 * JobViewService owns the read-only admin presentation contract.
 */
exports.getJobs = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobQueryService.getAdminJobsPageData({
      employerProfileId: req.query.employer,
      recruitmentStatus: req.query.recruitmentStatus,
      publicationStatus: req.query.publicationStatus,
      branchId: req.query.branch,
      search: req.query.search,
      page: req.query.page,
      currentTime,
    });

    const jobsView = JobViewService.buildAdminJobsPageView(pageData);

    setNoStoreHeaders(res);

    return res.render(ADMIN_JOBS_VIEW, {
      layout: "layouts/app-layout",
      title: jobsView.pageTitle || "Permanent Jobs",

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },
        {
          label: "Permanent Jobs",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),
      jobsView,
    });
  } catch (error) {
    logger.error("Admin Jobs page error:", error);

    return next(error);
  }
};

exports.getJob = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobQueryService.getAdminJobDetailData({
      jobId: req.params.jobId,
      currentTime,
    });

    const jobView = JobViewService.buildAdminJobDetailView(detailData);

    setNoStoreHeaders(res);

    return res.render(ADMIN_JOB_DETAIL_VIEW, {
      layout: "layouts/app-layout",
      title: jobView.pageTitle || "Job Details",

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
          label: jobView.job?.roleTitle || "Job Details",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),
      jobView,
    });
  } catch (error) {
    logger.error("Admin Job detail page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── DRAFT SUPPORT ─────────────────────────────── */

/**
 * Admin draft support is employer-targeted but never employer-impersonated.
 *
 * The route must first establish req.adminEmployerContext through the trusted
 * admin middleware. JobService remains authoritative for employer ownership,
 * branch resolution and unpublished-draft restrictions.
 */
exports.createDraft = async (req, res) => {
  try {
    const result = await JobService.createDraft({
      ...getAdminEmployerServiceContext(req),
      createdByUserId: getActorUserId(req),
      data: req.body,
    });

    setNoStoreHeaders(res);

    return res.status(201).json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job draft creation",
      fallbackMessage: "The Job draft could not be created. Please try again.",
      fallbackCode: "ADMIN_JOB_DRAFT_CREATION_FAILED",
    });
  }
};

exports.updateJob = async (req, res) => {
  try {
    const result = await JobService.updateJob({
      jobId: req.params.jobId,
      ...getAdminEmployerServiceContext(req),
      data: req.body,
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job draft update",
      fallbackMessage: "The Job draft could not be updated. Please try again.",
      fallbackCode: "ADMIN_JOB_DRAFT_UPDATE_FAILED",
    });
  }
};

exports.deleteDraftJob = async (req, res) => {
  try {
    const result = await JobService.deleteDraftJob({
      jobId: req.params.jobId,
      ...getAdminEmployerServiceContext(req),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job draft deletion",
      fallbackMessage: "The Job draft could not be deleted. Please try again.",
      fallbackCode: "ADMIN_JOB_DRAFT_DELETION_FAILED",
    });
  }
};

/* ─────────────────────────────── PUBLICATION SUPPORT ─────────────────────────────── */

async function publishJobWithEntitlement(req, res, logContext) {
  try {
    const result = await JobPublicationEntitlementService.publishJobWithEntitlement({
      jobId: req.params.jobId,
      ...getAdminEmployerServiceContext(req),
      publishedByUserId: getActorUserId(req),
    });

    setNoStoreHeaders(res);

    return res.status(201).json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext,
      fallbackMessage: "The Job could not be published. Please try again.",
      fallbackCode: "ADMIN_JOB_PUBLICATION_FAILED",
    });
  }
}

exports.publishJob = async (req, res) => {
  return publishJobWithEntitlement(req, res, "Admin Job publication");
};

exports.renewJobPublication = async (req, res) => {
  return publishJobWithEntitlement(req, res, "Admin Job publication renewal");
};

exports.pausePublication = async (req, res) => {
  try {
    const result = await JobPublicationService.pausePublication({
      publicationId: req.params.publicationId,
      ...getAdminEmployerServiceContext(req),
      pausedByUserId: getActorUserId(req),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job publication pause",
      fallbackMessage: "The Job publication could not be paused. Please try again.",
      fallbackCode: "ADMIN_JOB_PUBLICATION_PAUSE_FAILED",
    });
  }
};

exports.resumePublication = async (req, res) => {
  try {
    const result = await JobPublicationService.resumePublication({
      publicationId: req.params.publicationId,
      ...getAdminEmployerServiceContext(req),
      resumedByUserId: getActorUserId(req),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job publication resume",
      fallbackMessage: "The Job publication could not be resumed. Please try again.",
      fallbackCode: "ADMIN_JOB_PUBLICATION_RESUME_FAILED",
    });
  }
};

exports.adjustApplicationDeadline = async (req, res) => {
  try {
    const result = await JobPublicationService.adjustApplicationDeadline({
      publicationId: req.params.publicationId,
      ...getAdminEmployerServiceContext(req),
      changedByUserId: getActorUserId(req),
      applicationDeadline: req.body?.applicationDeadline ?? null,
      reason: req.body?.reason ?? null,
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job application deadline adjustment",
      fallbackMessage: "The application deadline could not be changed. Please try again.",
      fallbackCode: "ADMIN_JOB_APPLICATION_DEADLINE_UPDATE_FAILED",
    });
  }
};

exports.endPublication = async (req, res) => {
  try {
    const result = await JobPublicationService.endPublication({
      publicationId: req.params.publicationId,
      ...getAdminEmployerServiceContext(req),
      endedByUserId: getActorUserId(req),
      reason: req.body?.reason ?? null,
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Admin Job publication end",
      fallbackMessage: "The Job publication could not be ended. Please try again.",
      fallbackCode: "ADMIN_JOB_PUBLICATION_END_FAILED",
    });
  }
};
