// controllers/employerJobApplicationController.js

const JobApplicationService = require("../services/jobApplicationService");
const JobPublicationService = require("../services/jobPublicationService");

const JobApplicationQueryService = require("../services/jobs/applications/jobApplicationQueryService");

const JobApplicationViewService = require("../services/jobs/applications/jobApplicationViewService");

const logger = require("../utils/logger");

const EMPLOYER_APPLICATIONS_VIEW = "employer/job-applications/index";

const EMPLOYER_APPLICATION_DETAIL_VIEW = "employer/job-applications/show";

const EMPLOYER_JOBS_URL = "/employer/jobs";

const EMPLOYER_APPLICATIONS_URL = "/employer/job-applications";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

  res.set("Pragma", "no-cache");

  res.set("Expires", "0");
}

function isOperationalServiceError(error) {
  return ["JobApplicationServiceError", "JobPublicationServiceError"].includes(error?.name);
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

function getTransitionNotes(req) {
  return {
    employerPrivateNote: req.body?.employerPrivateNote,

    statusNote: req.body?.statusNote ?? null,
  };
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
 * Employer Job-application page reads are orchestrated here.
 *
 * JobApplicationQueryService owns:
 *
 * - employer/business authorization;
 * - primary/admin/branch-manager/branch-staff read scope;
 * - optional focused Job scope;
 * - status filtering;
 * - candidate/profile enrichment;
 * - employer-only private-note selection;
 * - counts;
 * - pagination; and
 * - read vs management capability.
 *
 * JobApplicationViewService owns:
 *
 * - candidate presentation;
 * - Job/publication presentation;
 * - CV presentation;
 * - screening presentation;
 * - action availability;
 * - read-only state;
 * - filters;
 * - pagination; and
 * - empty states.
 *
 * EJS receives only the finalized applicationsView.
 */
exports.getApplications = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const applicationPageData = await JobApplicationQueryService.getEmployerApplicationsPageData({
      userId: getActorUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,

      status: req.query.status,

      jobId: req.params.jobId || null,

      page: req.query.page,

      currentTime,
    });

    const applicationsView =
      JobApplicationViewService.buildEmployerApplicationsPageView(applicationPageData);

    setNoStoreHeaders(res);

    const focusedJob = applicationsView.focusedJob;

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

    if (focusedJob?.id) {
      breadcrumbs.push({
        label: focusedJob.roleTitle || "Job",

        url: `${EMPLOYER_JOBS_URL}/${focusedJob.id}`,
      });
    }

    breadcrumbs.push({
      label: "Applications",
      url: null,
    });

    return res.render(EMPLOYER_APPLICATIONS_VIEW, {
      layout: "layouts/app-layout",

      title: applicationsView.pageTitle || "Job Applications",

      breadcrumbs,

      csrfToken: req.csrfToken(),

      applicationsView,
    });
  } catch (error) {
    logger.error("Employer Job applications page error:", error);

    return next(error);
  }
};

/**
 * Employer applicant-detail read.
 *
 * Authorization and branch scope are resolved by the QueryService before the
 * application, candidate profile, private note or CV document may reach the
 * presentation layer.
 */
exports.getApplication = async (req, res, next) => {
  try {
    const currentTime = new Date();

    const applicationData = await JobApplicationQueryService.getEmployerApplicationDetailData({
      userId: getActorUserId(req),

      employerProfile: req.employerProfile,

      employerContext: req.employerContext || null,

      applicationId: req.params.applicationId,

      currentTime,
    });

    const applicationView =
      JobApplicationViewService.buildEmployerApplicationDetailView(applicationData);

    setNoStoreHeaders(res);

    const job = applicationView.job;

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

    if (job?.id) {
      breadcrumbs.push({
        label: job.roleTitle || "Job",

        url: `${EMPLOYER_JOBS_URL}/${job.id}`,
      });

      breadcrumbs.push({
        label: "Applications",

        url: `${EMPLOYER_JOBS_URL}/${job.id}/applications`,
      });
    } else {
      breadcrumbs.push({
        label: "Applications",
        url: EMPLOYER_APPLICATIONS_URL,
      });
    }

    breadcrumbs.push({
      label: applicationView.application?.candidate?.name || "Applicant",

      url: null,
    });

    return res.render(EMPLOYER_APPLICATION_DETAIL_VIEW, {
      layout: "layouts/app-layout",

      title: applicationView.pageTitle || "Application Details",

      breadcrumbs,

      csrfToken: req.csrfToken(),

      applicationView,
    });
  } catch (error) {
    logger.error("Employer Job application detail page error:", error);

    return next(error);
  }
};

/* ─────────────────────────────── UNDER REVIEW ─────────────────────────────── */

exports.markUnderReview = async (req, res) => {
  try {
    const result = await JobApplicationService.markUnderReview({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      changedByUserId: getActorUserId(req),

      ...getTransitionNotes(req),
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

      logContext: "Employer Job application review transition",

      fallbackMessage: "The application could not be moved under review. Please try again.",

      fallbackCode: "JOB_APPLICATION_REVIEW_TRANSITION_FAILED",
    });
  }
};

/* ─────────────────────────────── SHORTLIST ─────────────────────────────── */

exports.shortlistApplication = async (req, res) => {
  try {
    const result = await JobApplicationService.shortlistApplication({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      changedByUserId: getActorUserId(req),

      ...getTransitionNotes(req),
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

      logContext: "Employer Job application shortlist",

      fallbackMessage: "The application could not be shortlisted. Please try again.",

      fallbackCode: "JOB_APPLICATION_SHORTLIST_FAILED",
    });
  }
};

/* ─────────────────────────────── INTERVIEW PIPELINE ─────────────────────────────── */

/**
 * This changes the application pipeline stage only.
 *
 * Interview meeting records are owned separately by AppointmentService.
 */
exports.moveApplicationToInterview = async (req, res) => {
  try {
    const result = await JobApplicationService.moveApplicationToInterview({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      changedByUserId: getActorUserId(req),

      ...getTransitionNotes(req),
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

      logContext: "Employer Job application interview transition",

      fallbackMessage: "The application could not be moved to interview. Please try again.",

      fallbackCode: "JOB_APPLICATION_INTERVIEW_TRANSITION_FAILED",
    });
  }
};

/* ─────────────────────────────── OFFER ─────────────────────────────── */

exports.offerApplication = async (req, res) => {
  try {
    const result = await JobApplicationService.offerApplication({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      changedByUserId: getActorUserId(req),

      ...getTransitionNotes(req),
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

      logContext: "Employer Job application offer",

      fallbackMessage: "The application could not be moved to offer. Please try again.",

      fallbackCode: "JOB_APPLICATION_OFFER_FAILED",
    });
  }
};

/* ─────────────────────────────── REJECT ─────────────────────────────── */

exports.rejectApplication = async (req, res) => {
  try {
    const result = await JobApplicationService.rejectApplication({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      rejectedByUserId: getActorUserId(req),

      reason: req.body?.reason,

      reasonDetails: req.body?.reasonDetails ?? null,

      ...getTransitionNotes(req),
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

      logContext: "Employer Job application rejection",

      fallbackMessage: "The application could not be rejected. Please try again.",

      fallbackCode: "JOB_APPLICATION_REJECTION_FAILED",
    });
  }
};

/* ─────────────────────────────── HIRE ─────────────────────────────── */

/**
 * Hiring MUST pass through JobPublicationService.
 *
 * JobPublicationService.hireApplicationAndFinalize() owns the authoritative
 * finalization flow:
 *
 * - hire the selected JobApplication;
 * - determine remaining vacancy capacity;
 * - finalize the publication if the last vacancy is filled;
 * - reject remaining applicants when recruitment is filled; and
 * - close the Job as filled.
 *
 * Never replace this with a bare JobApplicationService.hireApplication() call.
 */
exports.hireApplication = async (req, res) => {
  try {
    const result = await JobPublicationService.hireApplicationAndFinalize({
      applicationId: req.params.applicationId,

      ...getEmployerServiceContext(req),

      hiredByUserId: getActorUserId(req),

      ...getTransitionNotes(req),
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

      logContext: "Employer Job application hire",

      fallbackMessage: "The applicant could not be hired. Please try again.",

      fallbackCode: "JOB_APPLICATION_HIRE_FAILED",
    });
  }
};
