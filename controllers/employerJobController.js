// controllers/employerJobController.js

const JobService = require("../services/jobService");
const JobPublicationService = require("../services/jobPublicationService");
const JobPublicationEntitlementService = require("../services/jobPublicationEntitlementService");

const JobQueryService = require("../services/jobs/jobQueryService");
const JobViewService = require("../services/jobs/jobViewService");

const JobPublicationReviewService = require("../services/jobs/jobPublicationReviewService");

const logger = require("../utils/logger");

const EMPLOYER_JOBS_VIEW = "employer/jobs/index";
const EMPLOYER_JOB_CREATE_VIEW = "employer/jobs/new";
const EMPLOYER_JOB_EDIT_VIEW = "employer/jobs/edit";
const EMPLOYER_JOB_DETAIL_VIEW = "employer/jobs/show";

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
    "JobApplicationServiceError",
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

function getEmployerServiceContext(req) {
  return {
    employerProfileId: req.employerProfile._id,
    employerContext: req.employerContext || null,
  };
}

function getActorUserId(req) {
  return req.user._id;
}

function getPublicServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const { events, ...publicResult } = result;

  return publicResult;
}

/* ─────────────────────────────── JOB READS ─────────────────────────────── */

/**
 * Employer Job page reads are orchestrated here.
 *
 * JobQueryService owns:
 *
 * - authenticated employer/business authorization;
 * - primary/admin/branch-manager/branch-staff read scope;
 * - branch filtering;
 * - recruitment/publication filtering;
 * - search;
 * - counts;
 * - pagination; and
 * - read vs management capability.
 *
 * JobViewService owns:
 *
 * - labels;
 * - badges;
 * - formatted dates;
 * - filter links;
 * - read-only presentation;
 * - pagination presentation; and
 * - empty states.
 *
 * EJS receives only the finalized jobsView.
 */
exports.getJobs = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobQueryService.getEmployerJobsPageData({
      userId: getActorUserId(req),
      employerProfile: req.employerProfile,
      employerContext: req.employerContext || null,
      recruitmentStatus: req.query.recruitmentStatus,
      publicationStatus: req.query.publicationStatus,
      branchId: req.query.branch,
      search: req.query.search,
      page: req.query.page,
      currentTime,
    });

    const jobsView = JobViewService.buildEmployerJobsPageView(pageData);

    setNoStoreHeaders(res);

    return res.render(EMPLOYER_JOBS_VIEW, {
      layout: "layouts/app-layout",
      title: jobsView.pageTitle || "Permanent Jobs",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Permanent Jobs",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),
      jobsView,
      scripts: [
        '<script src="/js/form-controls.js" defer></script>',
        '<script src="/js/employer/job-list.js" defer></script>',
      ].join("\n"),
    });
  } catch (error) {
    logger.error("Employer Jobs page error:", error);

    return next(error);
  }
};

exports.getJob = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobQueryService.getEmployerJobDetailData({
      userId: getActorUserId(req),
      employerProfile: req.employerProfile,
      employerContext: req.employerContext || null,
      jobId: req.params.jobId,
      currentTime,
    });

    const jobView = JobViewService.buildEmployerJobDetailView(detailData);

    setNoStoreHeaders(res);

    return res.render(EMPLOYER_JOB_DETAIL_VIEW, {
      layout: "layouts/app-layout",
      title: jobView.pageTitle || "Job Details",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Permanent Jobs",
          url: "/employer/jobs",
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
    logger.error("Employer Job detail page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── CREATE JOB PAGE ─────────────────────────────── */

/**
 * Read-only form preparation. The query service checks employer membership,
 * management authority and active branch scope before presentation is built.
 * Saving a draft remains the separate createDraft POST handler below.
 */
exports.getCreateJob = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const pageData = await JobQueryService.getEmployerJobCreatePageData({
      userId: getActorUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,
    });

    const jobCreateView = JobViewService.buildEmployerJobCreatePageView(pageData);

    return res.render(EMPLOYER_JOB_CREATE_VIEW, {
      layout: "layouts/app-layout",

      title: jobCreateView.pageTitle || "Create Job",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Permanent Jobs",
          url: "/employer/jobs",
        },
        {
          label: "Create Job",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      jobCreateView,

      scripts: [
        '<script src="/js/form-controls.js" defer></script>',
        '<script src="/js/employer/job-create.js" defer></script>',
      ].join("\n"),
    });
  } catch (error) {
    logger.error("Employer Create Job page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── EDIT JOB PAGE ─────────────────────────────── */

/**
 * Read-only preparation of the existing Job's edit form.
 * The query checks business/branch access and editable recruitment/publication
 * state. The updateJob POST handler remains authoritative when changes are saved.
 */
exports.getEditJob = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const pageData = await JobQueryService.getEmployerJobEditPageData({
      userId: getActorUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,

      jobId: req.params.jobId,
    });

    const jobEditView = JobViewService.buildEmployerJobEditPageView(pageData);

    return res.render(EMPLOYER_JOB_EDIT_VIEW, {
      layout: "layouts/app-layout",

      title: jobEditView.pageTitle || "Edit Job",

      breadcrumbs: [
        {
          label: "Home",
          url: "/employer/dashboard",
        },
        {
          label: "Permanent Jobs",
          url: "/employer/jobs",
        },
        {
          label: jobEditView.referenceCode || "Job Details",
          url: jobEditView.actions.detailsUrl,
        },
        {
          label: "Edit Job",
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      jobEditView,

      scripts: [
        '<script src="/js/form-controls.js" defer></script>',
        '<script src="/js/employer/job-edit.js" defer></script>',
      ].join("\n"),
    });
  } catch (error) {
    logger.error("Employer Edit Job page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── PUBLICATION REVIEW ─────────────────────────────── */

exports.getPublicationReview = async (req, res, next) => {
  setNoStoreHeaders(res);

  try {
    const data = await JobPublicationReviewService.getPageData({
      userId: req.user._id,
      employerProfile: req.employerProfile,
      employerContext: req.employerContext || null,
      jobId: req.params.jobId,
    });

    const publicationView = JobViewService.buildEmployerJobPublicationReviewView(data);

    return res.render("employer/jobs/publish", {
      layout: "layouts/app-layout",
      title: publicationView.pageTitle,
      breadcrumbs: [
        { label: "Jobs", url: "/employer/jobs" },
        { label: "Review and publish", url: null },
      ],
      csrfToken: req.csrfToken(),
      publicationView,
      scripts: [
        '<script src="https://js.paystack.co/v2/inline.js" defer></script>',
        '<script src="/js/form-controls.js" defer></script>',
        '<script src="/js/employer/job-publish.js" defer></script>',
      ].join("\n"),
    });
  } catch (error) {
    return next(error);
  }
};

exports.confirmPublication = async (req, res) => {
  try {
    const review = req.body?.review;

    if (
      !review ||
      typeof review !== "object" ||
      Array.isArray(review) ||
      typeof review.sourceType !== "string" ||
      typeof review.sourceReference !== "string" ||
      typeof review.jobUpdatedAt !== "string"
    ) {
      throw JobPublicationEntitlementService.createError({
        message: "Review the job before publishing.",
        code: "JOB_PUBLICATION_REVIEW_REQUIRED",
        statusCode: 400,
      });
    }

    const result = await JobPublicationEntitlementService.publishJobWithEntitlement({
      ...getEmployerServiceContext(req),
      jobId: req.params.jobId,
      publishedByUserId: getActorUserId(req),
      review,
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      data: {
        published: result.published,
        publicationId: String(result.publication._id),
      },
      redirectUrl: `/employer/jobs/${result.job._id}`,
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Employer reviewed Job publication",
      fallbackMessage: "Publication could not be confirmed. Check the job before trying again.",
      fallbackCode: "JOB_PUBLICATION_CONFIRM_FAILED",
    });
  }
};

/* ─────────────────────────────── JOB MASTER COMMANDS ─────────────────────────────── */

exports.createDraft = async (req, res) => {
  try {
    const result = await JobService.createDraft({
      ...getEmployerServiceContext(req),
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

      logContext: "Employer Job draft creation",

      fallbackMessage: "The Job draft could not be created. Please try again.",

      fallbackCode: "JOB_DRAFT_CREATION_FAILED",
    });
  }
};

exports.updateJob = async (req, res) => {
  try {
    const result = await JobService.updateJob({
      jobId: req.params.jobId,
      ...getEmployerServiceContext(req),
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

      logContext: "Employer Job update",

      fallbackMessage: "The Job could not be updated. Please try again.",

      fallbackCode: "JOB_UPDATE_FAILED",
    });
  }
};

exports.archiveJob = async (req, res) => {
  try {
    const result = await JobService.archiveJob({
      jobId: req.params.jobId,
      ...getEmployerServiceContext(req),
      archivedByUserId: getActorUserId(req),
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

      logContext: "Employer Job archive",

      fallbackMessage: "The Job could not be archived. Please try again.",

      fallbackCode: "JOB_ARCHIVE_FAILED",
    });
  }
};

exports.deleteDraftJob = async (req, res) => {
  try {
    const result = await JobService.deleteDraftJob({
      jobId: req.params.jobId,
      ...getEmployerServiceContext(req),
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

      logContext: "Employer Job draft deletion",

      fallbackMessage: "The Job draft could not be deleted. Please try again.",

      fallbackCode: "JOB_DRAFT_DELETION_FAILED",
    });
  }
};

/* ─────────────────────────────── PUBLICATION COMMANDS ─────────────────────────────── */

async function publishJobWithEntitlement(req, res, logContext) {
  try {
    const result = await JobPublicationEntitlementService.publishJobWithEntitlement({
      jobId: req.params.jobId,

      ...getEmployerServiceContext(req),

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

      fallbackCode: "JOB_PUBLICATION_FAILED",
    });
  }
}

exports.publishJob = async (req, res) => {
  return publishJobWithEntitlement(req, res, "Employer Job publication");
};

exports.renewJobPublication = async (req, res) => {
  return publishJobWithEntitlement(req, res, "Employer Job publication renewal");
};

exports.pausePublication = async (req, res) => {
  try {
    const result = await JobPublicationService.pausePublication({
      publicationId: req.params.publicationId,

      ...getEmployerServiceContext(req),

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

      logContext: "Employer Job publication pause",

      fallbackMessage: "The Job publication could not be paused. Please try again.",

      fallbackCode: "JOB_PUBLICATION_PAUSE_FAILED",
    });
  }
};

exports.resumePublication = async (req, res) => {
  try {
    const result = await JobPublicationService.resumePublication({
      publicationId: req.params.publicationId,

      ...getEmployerServiceContext(req),

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

      logContext: "Employer Job publication resume",

      fallbackMessage: "The Job publication could not be resumed. Please try again.",

      fallbackCode: "JOB_PUBLICATION_RESUME_FAILED",
    });
  }
};

exports.adjustApplicationDeadline = async (req, res) => {
  try {
    const result = await JobPublicationService.adjustApplicationDeadline({
      publicationId: req.params.publicationId,

      ...getEmployerServiceContext(req),

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

      logContext: "Employer Job application deadline adjustment",

      fallbackMessage: "The application deadline could not be changed. Please try again.",

      fallbackCode: "JOB_APPLICATION_DEADLINE_UPDATE_FAILED",
    });
  }
};

exports.endPublication = async (req, res) => {
  try {
    const result = await JobPublicationService.endPublication({
      publicationId: req.params.publicationId,

      ...getEmployerServiceContext(req),

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

      logContext: "Employer Job publication end",

      fallbackMessage: "The Job publication could not be ended. Please try again.",

      fallbackCode: "JOB_PUBLICATION_END_FAILED",
    });
  }
};

exports.closeRecruitment = async (req, res) => {
  try {
    const result = await JobPublicationService.closeRecruitment({
      jobId: req.params.jobId,

      ...getEmployerServiceContext(req),

      closedByUserId: getActorUserId(req),

      reason: req.body?.reason ?? null,

      reasonDetails: req.body?.reasonDetails ?? null,
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

      logContext: "Employer Job recruitment closure",

      fallbackMessage: "Recruitment could not be closed. Please try again.",

      fallbackCode: "JOB_RECRUITMENT_CLOSE_FAILED",
    });
  }
};
