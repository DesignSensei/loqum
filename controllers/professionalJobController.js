// controllers/professionalJobController.js

const SavedJobService = require("../services/savedJobService");

const JobQueryService = require("../services/jobs/jobQueryService");
const JobViewService = require("../services/jobs/jobViewService");

const logger = require("../utils/logger");

const PROFESSIONAL_SAVED_JOBS_VIEW = "professional/jobs/saved";

const MARKETPLACE_JOBS_URL = "/jobs";

const PROFESSIONAL_SAVED_JOBS_URL = "/professional/jobs/saved";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  res.set("Pragma", "no-cache");

  res.set("Expires", "0");
}

function isOperationalServiceError(error) {
  return ["SavedJobServiceError"].includes(error?.name);
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

function getProfessionalReadContext(req) {
  return {
    userId: req.user._id,

    professionalProfile: req.professionalProfile,
  };
}

function getCsrfToken(req) {
  return typeof req.csrfToken === "function" ? req.csrfToken() : null;
}

function getPublicServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const { events, ...publicResult } = result;

  return publicResult;
}

/* ─────────────────────────────── SAVED JOBS PAGE ─────────────────────────────── */

/**
 * SavedJob references the Job master rather than a publication.
 *
 * This allows the bookmark to survive publication pause, expiry and later
 * publication cycles while JobQueryService determines whether the Job is
 * currently publicly available.
 */
exports.getSavedJobs = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobQueryService.getProfessionalSavedJobsPageData({
      ...getProfessionalReadContext(req),

      page: req.query.page,

      currentTime,
    });

    const savedJobsView = JobViewService.buildSavedJobsPageView(pageData);

    setNoStoreHeaders(res);

    return res.render(PROFESSIONAL_SAVED_JOBS_VIEW, {
      layout: "layouts/app-layout",

      title: savedJobsView.pageTitle || "Saved Jobs",

      breadcrumbs: [
        {
          label: "Home",

          url: "/professional/dashboard",
        },

        {
          label: "Jobs",

          url: MARKETPLACE_JOBS_URL,
        },

        {
          label: "Saved Jobs",

          url: null,
        },
      ],

      csrfToken: getCsrfToken(req),

      savedJobsView,
    });
  } catch (error) {
    logger.error("Professional saved Jobs page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── SAVE JOB ─────────────────────────────── */

exports.saveJob = async (req, res) => {
  try {
    const result = await SavedJobService.saveJob({
      professionalProfileId: getProfessionalProfileId(req),

      jobId: req.params.jobId,
    });

    setNoStoreHeaders(res);

    return res.status(result.created === true ? 201 : 200).json({
      success: true,

      message: result.created === true ? "Job saved." : "This Job is already saved.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Professional Job save",

      fallbackMessage: "The Job could not be saved. Please try again.",

      fallbackCode: "JOB_SAVE_FAILED",
    });
  }
};

/* ─────────────────────────────── UNSAVE JOB ─────────────────────────────── */

exports.unsaveJob = async (req, res) => {
  try {
    const result = await SavedJobService.unsaveJob({
      professionalProfileId: getProfessionalProfileId(req),

      jobId: req.params.jobId,
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,

      message:
        result.removed === true
          ? "Job removed from saved Jobs."
          : "This Job is not currently saved.",

      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,

      logContext: "Professional Job unsave",

      fallbackMessage: "The Job could not be removed from saved Jobs. Please try again.",

      fallbackCode: "JOB_UNSAVE_FAILED",
    });
  }
};
