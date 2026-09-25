// controllers/professionalJobApplicationController.js

const JobApplicationService = require("../services/jobApplicationService");
const JobApplicationQueryService = require("../services/jobs/applications/jobApplicationQueryService");
const JobApplicationViewService = require("../services/jobs/applications/jobApplicationViewService");

const logger = require("../utils/logger");

const PROFESSIONAL_APPLICATIONS_VIEW = "professional/job-applications/index";
const PROFESSIONAL_APPLICATION_DETAIL_VIEW = "professional/job-applications/show";
const PROFESSIONAL_APPLICATIONS_URL = "/professional/job-applications";
const MARKETPLACE_JOBS_URL = "/jobs";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function createControllerError({ message, code, statusCode = 400, details = null }) {
  const error = new Error(message);

  error.name = "ProfessionalJobApplicationControllerError";
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;

  return error;
}

function isOperationalServiceError(error) {
  return ["JobApplicationServiceError", "ProfessionalJobApplicationControllerError"].includes(
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

function getTrustedResumeUpload(req) {
  return req.jobApplicationResumeUpload || null;
}

async function cleanupTrustedResumeUpload(req) {
  if (typeof req.cleanupJobApplicationResumeUpload !== "function") {
    return;
  }

  try {
    await req.cleanupJobApplicationResumeUpload();
  } catch (error) {
    logger.error("Professional Job application resume cleanup error:", error);
  }
}

function normalizeBooleanFlag(value) {
  if (value === true) {
    return true;
  }

  if (value === false || value === null || value === undefined || value === "") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeScreeningAnswers(value) {
  if (value === null || value === undefined || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    throw createControllerError({
      message: "Screening answers must be an array.",
      code: "INVALID_JOB_APPLICATION_SCREENING_ANSWERS",
      statusCode: 400,
    });
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw createControllerError({
      message: "Screening answers are invalid.",
      code: "INVALID_JOB_APPLICATION_SCREENING_ANSWERS",
      statusCode: 400,
    });
  }

  if (!Array.isArray(parsed)) {
    throw createControllerError({
      message: "Screening answers must be an array.",
      code: "INVALID_JOB_APPLICATION_SCREENING_ANSWERS",
      statusCode: 400,
    });
  }

  return parsed;
}

function getPublicServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const { events, ...publicResult } = result;

  return publicResult;
}

/* ─────────────────────────────── APPLICATION READS ─────────────────────────────── */

/**
 * Professional application-history reads are orchestrated here.
 *
 * JobApplicationQueryService owns:
 * - professional-profile ownership;
 * - application ownership;
 * - status filtering;
 * - exact publication-cycle history;
 * - counts; and
 * - pagination.
 *
 * JobApplicationViewService owns:
 * - advertised Job snapshot presentation;
 * - application status presentation;
 * - CV metadata presentation;
 * - withdrawal action availability;
 * - filters;
 * - pagination; and
 * - empty states.
 */

exports.getApplications = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const pageData = await JobApplicationQueryService.getProfessionalApplicationsPageData({
      ...getProfessionalReadContext(req),
      status: req.query.status,
      page: req.query.page,
      currentTime,
    });

    const applicationsView =
      JobApplicationViewService.buildProfessionalApplicationsPageView(pageData);

    setNoStoreHeaders(res);

    return res.render(PROFESSIONAL_APPLICATIONS_VIEW, {
      layout: "layouts/app-layout",
      title: applicationsView.pageTitle || "My Job Applications",
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
          label: "My Applications",
          url: null,
        },
      ],
      csrfToken: req.csrfToken(),
      applicationsView,
    });
  } catch (error) {
    logger.error("Professional Job applications page error:", error);
    return next(error);
  }
};

exports.getApplication = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const detailData = await JobApplicationQueryService.getProfessionalApplicationDetailData({
      ...getProfessionalReadContext(req),
      applicationId: req.params.applicationId,
      currentTime,
    });

    const applicationView =
      JobApplicationViewService.buildProfessionalApplicationDetailView(detailData);

    setNoStoreHeaders(res);

    const roleTitle = applicationView.application?.publication?.roleTitle || "Application Details";

    return res.render(PROFESSIONAL_APPLICATION_DETAIL_VIEW, {
      layout: "layouts/app-layout",
      title: applicationView.pageTitle || "Application Details",
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
          label: "My Applications",
          url: PROFESSIONAL_APPLICATIONS_URL,
        },
        {
          label: roleTitle,
          url: null,
        },
      ],
      csrfToken: req.csrfToken(),
      applicationView,
    });
  } catch (error) {
    logger.error("Professional Job application detail page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── APPLY ─────────────────────────────── */

/**
 * A CV is mandatory for every permanent Job application.
 *
 * The client may select an existing ProfessionalResume by resumeId.
 *
 * A fresh upload must be normalized by trusted upload middleware and placed on:
 *
 * req.jobApplicationResumeUpload
 *
 * Raw req.body.resume data is never trusted.
 */

exports.submitApplication = async (req, res) => {
  try {
    const result = await JobApplicationService.submitApplication({
      publicationId: req.params.publicationId,
      professionalProfileId: getProfessionalProfileId(req),
      submittedByUserId: getActorUserId(req),
      coverNote: req.body?.coverNote ?? null,
      resumeId: req.body?.resumeId || null,
      resume: getTrustedResumeUpload(req),
      saveResumeToProfile: normalizeBooleanFlag(req.body?.saveResumeToProfile),
      saveResumeAsDefault: normalizeBooleanFlag(req.body?.saveResumeAsDefault),
      resumeLabel: req.body?.resumeLabel ?? null,
      screeningAnswers: normalizeScreeningAnswers(req.body?.screeningAnswers),
      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.status(201).json({
      success: true,
      message: "Your Job application has been submitted.",
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    await cleanupTrustedResumeUpload(req);

    return handleJsonError({
      res,
      error,
      logContext: "Professional Job application submission",
      fallbackMessage: "Your Job application could not be submitted. Please try again.",
      fallbackCode: "JOB_APPLICATION_SUBMISSION_FAILED",
    });
  }
};

/* ─────────────────────────────── WITHDRAW ─────────────────────────────── */

exports.withdrawApplication = async (req, res) => {
  try {
    const result = await JobApplicationService.withdrawApplication({
      applicationId: req.params.applicationId,
      professionalProfileId: getProfessionalProfileId(req),
      withdrawnByUserId: getActorUserId(req),
      reason: req.body?.reason,
      reasonDetails: req.body?.reasonDetails ?? null,
      currentTime: new Date(),
    });

    setNoStoreHeaders(res);

    return res.json({
      success: true,
      message: "Your Job application has been withdrawn.",
      data: getPublicServiceResult(result),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Professional Job application withdrawal",
      fallbackMessage: "Your Job application could not be withdrawn. Please try again.",
      fallbackCode: "JOB_APPLICATION_WITHDRAWAL_FAILED",
    });
  }
};
