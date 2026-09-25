// services/savedJobService.js

const SavedJob = require("../models/SavedJob");
const Job = require("../models/Job");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId } = require("./helpers/serviceValidationHelpers");

const SAVED_JOB_SERVICE_ERROR_NAME = "SavedJobServiceError";

/* ─────────────────────────────── ERROR CONTRACT ─────────────────────────────── */

function createSavedJobError(options) {
  return createServiceError({
    ...options,
    name: SAVED_JOB_SERVICE_ERROR_NAME,
  });
}

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function applySession(query, session) {
  return session ? query.session(session) : query;
}

function normalizeProfessionalProfileId(value) {
  return normalizeObjectId({
    value,
    fieldName: "professional profile ID",
    createError: createSavedJobError,
  });
}

function normalizeJobId(value) {
  return normalizeObjectId({
    value,
    fieldName: "Job ID",
    createError: createSavedJobError,
  });
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

async function getExistingSavedJob({ professionalProfileId, jobId, session = null }) {
  const query = SavedJob.findOne({
    professional: professionalProfileId,
    job: jobId,
  });

  return applySession(query, session);
}

async function assertJobExists(jobId, session = null) {
  const query = Job.exists({
    _id: jobId,
  });

  const jobExists = await applySession(query, session);

  if (!jobExists) {
    throw createSavedJobError({
      message: "Job not found.",
      code: "JOB_NOT_FOUND",
      statusCode: 404,
    });
  }
}

/* ─────────────────────────────── SAVED JOB SERVICE ─────────────────────────────── */

class SavedJobService {
  /**
   * Saves one permanent Job for one professional.
   *
   * The SavedJob relationship belongs to the Job rather than a particular
   * JobPublication. Publication pause, expiry, renewal or replacement therefore
   * does not remove the bookmark.
   *
   * Public marketplace visibility remains a Job query concern. This command
   * service only owns the bookmark mutation and does not infer publication state.
   */
  static async saveJob({ professionalProfileId, jobId }, options = {}) {
    const normalizedProfessionalProfileId = normalizeProfessionalProfileId(professionalProfileId);

    const normalizedJobId = normalizeJobId(jobId);

    const session = options.session || null;

    await assertJobExists(normalizedJobId, session);

    const existingSavedJob = await getExistingSavedJob({
      professionalProfileId: normalizedProfessionalProfileId,
      jobId: normalizedJobId,
      session,
    });

    if (existingSavedJob) {
      return {
        savedJob: existingSavedJob,
        saved: true,
        created: false,
        idempotent: true,
      };
    }

    try {
      const savedJob = new SavedJob({
        professional: normalizedProfessionalProfileId,
        job: normalizedJobId,
      });

      await savedJob.save(session ? { session } : {});

      return {
        savedJob,
        saved: true,
        created: true,
        idempotent: false,
      };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const savedJob = await getExistingSavedJob({
        professionalProfileId: normalizedProfessionalProfileId,
        jobId: normalizedJobId,
        session,
      });

      if (!savedJob) {
        throw createSavedJobError({
          message: "The Job could not be saved because the bookmark state changed concurrently.",
          code: "SAVED_JOB_CONCURRENT_STATE_CONFLICT",
          statusCode: 409,
        });
      }

      return {
        savedJob,
        saved: true,
        created: false,
        idempotent: true,
      };
    }
  }

  /**
   * Removes one professional's bookmark for a permanent Job.
   *
   * Repeating the same unsave command is intentionally idempotent.
   *
   * The deletion is scoped by both professional and Job, so one professional
   * cannot remove another professional's bookmark by SavedJob ID.
   */
  static async unsaveJob({ professionalProfileId, jobId }, options = {}) {
    const normalizedProfessionalProfileId = normalizeProfessionalProfileId(professionalProfileId);

    const normalizedJobId = normalizeJobId(jobId);

    const query = SavedJob.findOneAndDelete({
      professional: normalizedProfessionalProfileId,
      job: normalizedJobId,
    });

    const removedSavedJob = await applySession(query, options.session || null);

    if (!removedSavedJob) {
      return {
        savedJob: null,
        saved: false,
        removed: false,
        idempotent: true,
      };
    }

    return {
      savedJob: removedSavedJob,
      saved: false,
      removed: true,
      idempotent: false,
    };
  }
}

module.exports = SavedJobService;
