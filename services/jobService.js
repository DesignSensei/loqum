// services/jobService.js

const mongoose = require("mongoose");

const Job = require("../models/Job");
const JobApplication = require("../models/JobApplication");
const JobPublication = require("../models/JobPublication");
const EmployerProfile = require("../models/EmployerProfile");
const Branch = require("../models/Branch");

const {
  JOB_RECRUITMENT_STATUSES,
  JOB_PUBLICATION_STATUSES,
  JOB_CLOSE_REASONS,
  MAX_JOB_CLOSE_REASON_LENGTH,
} = require("../constants/jobPosting");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId, normalizeOptionalText } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");
const logger = require("../utils/logger");

const JOB_SERVICE_ERROR_NAME = "JobServiceError";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const LIVE_PUBLICATION_STATUSES = Object.freeze(["live", "paused"]);

const EDITABLE_AFTER_PUBLICATION_STATUSES = Object.freeze(["expired", "ended"]);

const EMPLOYER_CLOSE_REASONS = Object.freeze(
  JOB_CLOSE_REASONS.filter((reason) => reason !== "filled")
);

/**
 * Fields owned by the employer-editable Job master record.
 *
 * Publication lifecycle fields, application summaries, ownership and audit
 * fields are intentionally absent. Those are service-owned and must never be
 * accepted as client authority through this service.
 */
const EMPLOYER_EDITABLE_JOB_FIELDS = Object.freeze([
  "roleTitle",
  "professionalType",
  "specialty",
  "department",
  "employmentType",
  "workplaceType",
  "minimumYearsOfExperience",
  "educationRequirement",
  "compensation",
  "summary",
  "description",
  "responsibilities",
  "requirements",
  "preferredQualifications",
  "skills",
  "benefits",
  "vacancyCount",
  "employmentStartDate",
  "applicationDeadline",
  "screeningQuestions",
]);

/**
 * JOB SERVICE ARCHITECTURE
 *
 * JobService owns the permanent-recruitment master record:
 *
 * - employer draft creation and controlled editing;
 * - employer business / branch authorization;
 * - trusted admin-on-behalf-of-employer posting support;
 * - branch-derived location snapshots;
 * - employer-only recruitment closure and archive boundaries;
 * - draft deletion; and
 * - employer-scoped Job queries retained by this service.
 *
 * Admin employer support is intentionally limited to posting preparation and
 * publication support. It never impersonates an employer user and never
 * manufactures employerContext. A trusted adminEmployerContext identifies the
 * actual admin actor and the exact EmployerProfile being assisted.
 *
 * It does NOT:
 *
 * - publish or renew a Job;
 * - consume a posting entitlement;
 * - create or mutate JobPublication snapshots;
 * - pause / resume / expire / end a publication;
 * - adjust a live publication application deadline;
 * - close or archive recruitment on behalf of an employer;
 * - accept, reject, shortlist, hire or otherwise transition JobApplications;
 * - schedule appointments; or
 * - serve the public marketplace from mutable Job fields.
 *
 * The public marketplace must ultimately read the authoritative current
 * JobPublication snapshot, not the mutable Job master record.
 */
class JobService {
  /* ─────────────────────────────── ERRORS / TRANSACTIONS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: JOB_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static async runWithOptionalTransaction(options = {}, callback) {
    if (
      options.session &&
      (typeof options.session.inTransaction !== "function" || !options.session.inTransaction())
    ) {
      throw JobService.createError({
        message: "An active transaction is required for the supplied session.",
        code: "JOB_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static normalizeObjectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,
      fieldName,
      required,
      createError: JobService.createError,
    });
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    return normalizeOptionalText({
      value,
      fieldName,
      maximumLength,
      createError: JobService.createError,
      emptyValue: null,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw JobService.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return currentTime;
  }

  static normalizeNullableDate(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw JobService.createError({
        message: `${fieldName} is invalid.`,
        code: `INVALID_${String(fieldName || "DATE")
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")}`,
      });
    }

    return date;
  }

  static normalizePage(value) {
    const page = Number(value || 1);

    if (!Number.isSafeInteger(page) || page < 1) {
      return 1;
    }

    return page;
  }

  static normalizeLimit(value) {
    const limit = Number(value || DEFAULT_PAGE_SIZE);

    if (!Number.isSafeInteger(limit) || limit < 1) {
      return DEFAULT_PAGE_SIZE;
    }

    return Math.min(limit, MAX_PAGE_SIZE);
  }

  static normalizeRecruitmentStatus(value, { required = false } = {}) {
    const status = String(value || "")
      .trim()
      .toLowerCase();

    if (!status) {
      if (!required) {
        return null;
      }

      throw JobService.createError({
        message: "Recruitment status is required.",
        code: "JOB_RECRUITMENT_STATUS_REQUIRED",
      });
    }

    if (!JOB_RECRUITMENT_STATUSES.includes(status)) {
      throw JobService.createError({
        message: "Recruitment status is invalid.",
        code: "INVALID_JOB_RECRUITMENT_STATUS",
      });
    }

    return status;
  }

  static normalizePublicationStatus(value, { required = false } = {}) {
    const status = String(value || "")
      .trim()
      .toLowerCase();

    if (!status) {
      if (!required) {
        return null;
      }

      throw JobService.createError({
        message: "Publication status is required.",
        code: "JOB_PUBLICATION_STATUS_REQUIRED",
      });
    }

    if (!JOB_PUBLICATION_STATUSES.includes(status)) {
      throw JobService.createError({
        message: "Publication status is invalid.",
        code: "INVALID_JOB_PUBLICATION_STATUS",
      });
    }

    return status;
  }

  static normalizeCloseReason(value, { allowFilled = false } = {}) {
    const reason = String(value || "")
      .trim()
      .toLowerCase();

    const allowedReasons = allowFilled ? JOB_CLOSE_REASONS : EMPLOYER_CLOSE_REASONS;

    if (!allowedReasons.includes(reason)) {
      throw JobService.createError({
        message: allowFilled
          ? "Job close reason is invalid."
          : "Employer Job close reason is invalid.",
        code: "INVALID_JOB_CLOSE_REASON",
      });
    }

    return reason;
  }

  static normalizeCloseReasonDetails(value, closeReason) {
    const details = JobService.normalizeOptionalText(
      value,
      "Job close reason details",
      MAX_JOB_CLOSE_REASON_LENGTH
    );

    if (closeReason === "other" && !details) {
      throw JobService.createError({
        message: "Job close reason details are required when the reason is other.",
        code: "JOB_CLOSE_REASON_DETAILS_REQUIRED",
      });
    }

    return closeReason === "other" ? details : null;
  }

  static normalizeSearch(value) {
    return String(value || "")
      .trim()
      .slice(0, 150);
  }

  static escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  static normalizeEmployerProfileSnapshot(employerProfile) {
    const countryCode = String(employerProfile?.countryCode || "")
      .trim()
      .toUpperCase();

    const currency = String(employerProfile?.currency || "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currency)) {
      throw JobService.createError({
        message: "Employer country or currency configuration is incomplete.",
        code: "EMPLOYER_JOB_CONFIGURATION_INCOMPLETE",
        statusCode: 409,
      });
    }

    return {
      countryCode,
      currency,
    };
  }

  /* ─────────────────────────────── MANAGEMENT AUTHORITY ─────────────────────────────── */

  static canManageAllBranches(employerContext) {
    return Boolean(
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true
    );
  }

  static isBranchManager(employerContext) {
    return employerContext?.isBranchManager === true;
  }

  static hasAdminEmployerContext(adminEmployerContext = null) {
    return Boolean(adminEmployerContext?.adminUserId && adminEmployerContext?.employerProfileId);
  }

  static normalizeAdminEmployerContext({ adminEmployerContext, employerProfileId }) {
    if (!JobService.hasAdminEmployerContext(adminEmployerContext)) {
      return null;
    }

    const normalizedEmployerProfileId = JobService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const contextEmployerProfileId = JobService.normalizeObjectId(
      adminEmployerContext.employerProfileId,
      "admin employer-context employer profile ID"
    );

    const adminUserId = JobService.normalizeObjectId(
      adminEmployerContext.adminUserId,
      "admin employer-context user ID"
    );

    if (String(contextEmployerProfileId) !== String(normalizedEmployerProfileId)) {
      throw JobService.createError({
        message: "Admin employer context does not match the target employer.",
        code: "ADMIN_EMPLOYER_CONTEXT_MISMATCH",
        statusCode: 403,
      });
    }

    return {
      adminUserId,
      employerProfileId: contextEmployerProfileId,
    };
  }

  static assertEmployerCanManageJobs({
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
  }) {
    if (JobService.hasAdminEmployerContext(adminEmployerContext)) {
      if (employerContext) {
        throw JobService.createError({
          message: "Employer and admin support authority cannot be combined.",
          code: "JOB_MANAGEMENT_AUTHORITY_AMBIGUOUS",
          statusCode: 500,
        });
      }

      JobService.normalizeAdminEmployerContext({
        adminEmployerContext,
        employerProfileId,
      });

      return "admin_support";
    }

    if (
      !JobService.canManageAllBranches(employerContext) &&
      !JobService.isBranchManager(employerContext)
    ) {
      throw JobService.createError({
        message: "You do not have permission to manage permanent Jobs.",
        code: "JOB_MANAGEMENT_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return "employer";
  }

  static assertAdminActorMatchesContext({
    actorUserId,
    adminEmployerContext = null,
    fieldName = "admin actor user ID",
  }) {
    const actor = JobService.normalizeObjectId(actorUserId, fieldName);

    if (!JobService.hasAdminEmployerContext(adminEmployerContext)) {
      return actor;
    }

    const adminUserId = JobService.normalizeObjectId(
      adminEmployerContext.adminUserId,
      "admin employer-context user ID"
    );

    if (String(actor) !== String(adminUserId)) {
      throw JobService.createError({
        message: "The recorded actor does not match the active admin employer context.",
        code: "ADMIN_EMPLOYER_ACTOR_MISMATCH",
        statusCode: 403,
      });
    }

    return actor;
  }

  static getAssignedBranchIds(employerContext) {
    return (employerContext?.assignedBranchIds || [])
      .filter((branchId) => mongoose.isValidObjectId(branchId))
      .map((branchId) => new mongoose.Types.ObjectId(String(branchId)));
  }

  static assertBranchManagerCanAccessBranch({
    branchId,
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
  }) {
    const authority = JobService.assertEmployerCanManageJobs({
      employerProfileId,
      employerContext,
      adminEmployerContext,
    });

    if (authority === "admin_support" || JobService.canManageAllBranches(employerContext)) {
      return true;
    }

    const assignedBranchIds = JobService.getAssignedBranchIds(employerContext);

    if (
      !assignedBranchIds.some((assignedBranchId) => String(assignedBranchId) === String(branchId))
    ) {
      throw JobService.createError({
        message: "You do not have permission to manage Jobs for this branch.",
        code: "JOB_BRANCH_ACCESS_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    return true;
  }

  static buildEmployerJobFilter({
    jobId = null,
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
  }) {
    const authority = JobService.assertEmployerCanManageJobs({
      employerProfileId,
      employerContext,
      adminEmployerContext,
    });

    const filter = {
      business: JobService.normalizeObjectId(employerProfileId, "employer profile ID"),
    };

    if (jobId) {
      filter._id = JobService.normalizeObjectId(jobId, "Job ID");
    }

    if (authority !== "admin_support" && !JobService.canManageAllBranches(employerContext)) {
      filter.branch = {
        $in: JobService.getAssignedBranchIds(employerContext),
      };
    }

    return filter;
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getEmployerProfile(employerProfileId, session = null) {
    const normalizedEmployerProfileId = JobService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    const query = EmployerProfile.findById(normalizedEmployerProfileId).select(
      "user businessName countryCode currency accountStatus employerApprovalStatus"
    );

    if (session) {
      query.session(session);
    }

    const employerProfile = await query;

    if (!employerProfile) {
      throw JobService.createError({
        message: "Employer profile was not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employerProfile;
  }

  static async getActiveBranch({
    branchId,
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
    session = null,
  }) {
    const normalizedBranchId = JobService.normalizeObjectId(branchId, "branch ID");

    const normalizedEmployerProfileId = JobService.normalizeObjectId(
      employerProfileId,
      "employer profile ID"
    );

    JobService.assertBranchManagerCanAccessBranch({
      branchId: normalizedBranchId,
      employerProfileId: normalizedEmployerProfileId,
      employerContext,
      adminEmployerContext,
    });

    const query = Branch.findOne({
      _id: normalizedBranchId,
      business: normalizedEmployerProfileId,
      isActive: true,
    }).select("business name address state lga googlePlaceId location isActive");

    if (session) {
      query.session(session);
    }

    const branch = await query;

    if (!branch) {
      throw JobService.createError({
        message: "The selected branch was not found or is inactive.",
        code: "ACTIVE_JOB_BRANCH_NOT_FOUND",
        statusCode: 404,
      });
    }

    return branch;
  }

  static async getEmployerJob({
    jobId,
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
    session = null,
  }) {
    const query = Job.findOne(
      JobService.buildEmployerJobFilter({
        jobId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
      })
    );

    if (session) {
      query.session(session);
    }

    const job = await query;

    if (!job) {
      throw JobService.createError({
        message: "Job was not found or is not available to you.",
        code: "JOB_NOT_FOUND",
        statusCode: 404,
      });
    }

    return job;
  }

  static async getSystemJob(jobId, session = null) {
    const normalizedJobId = JobService.normalizeObjectId(jobId, "Job ID");

    const query = Job.findById(normalizedJobId);

    if (session) {
      query.session(session);
    }

    const job = await query;

    if (!job) {
      throw JobService.createError({
        message: "Job was not found.",
        code: "JOB_NOT_FOUND",
        statusCode: 404,
      });
    }

    return job;
  }

  /* ─────────────────────────────── BRANCH SNAPSHOT ─────────────────────────────── */

  static cloneLocation(location) {
    if (
      !location ||
      location.type !== "Point" ||
      !Array.isArray(location.coordinates) ||
      location.coordinates.length !== 2
    ) {
      return undefined;
    }

    const longitude = Number(location.coordinates[0]);
    const latitude = Number(location.coordinates[1]);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return undefined;
    }

    return {
      type: "Point",
      coordinates: [longitude, latitude],
    };
  }

  static getBranchSnapshot(branch) {
    if (!branch) {
      return {
        branch: null,
        state: null,
        lga: null,
        address: null,
        googlePlaceId: null,
        location: undefined,
      };
    }

    return {
      branch: branch._id,
      state: branch.state || null,
      lga: branch.lga || null,
      address: branch.address || null,
      googlePlaceId: branch.googlePlaceId || null,
      location: JobService.cloneLocation(branch.location),
    };
  }

  static applyBranchSnapshot(job, branch) {
    const snapshot = JobService.getBranchSnapshot(branch);

    job.branch = snapshot.branch;
    job.state = snapshot.state;
    job.lga = snapshot.lga;
    job.address = snapshot.address;
    job.googlePlaceId = snapshot.googlePlaceId;

    if (snapshot.location) {
      job.location = snapshot.location;
    } else {
      job.set("location", undefined);
    }

    return job;
  }

  /* ─────────────────────────────── EDITABLE PAYLOAD ─────────────────────────────── */

  static buildEditablePayload(data = {}) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw JobService.createError({
        message: "Job data must be an object.",
        code: "INVALID_JOB_DATA",
      });
    }

    const payload = {};

    for (const field of EMPLOYER_EDITABLE_JOB_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(data, field)) {
        continue;
      }

      if (["employmentStartDate", "applicationDeadline"].includes(field)) {
        payload[field] = JobService.normalizeNullableDate(data[field], field);
        continue;
      }

      payload[field] = data[field];
    }

    return payload;
  }

  static assertJobContentEditable(job) {
    if (["closed", "archived"].includes(job.recruitmentStatus)) {
      throw JobService.createError({
        message: "Closed or archived recruitment cannot be edited.",
        code: "JOB_RECRUITMENT_NOT_EDITABLE",
        statusCode: 409,
        details: {
          recruitmentStatus: job.recruitmentStatus,
          publicationStatus: job.publicationStatus,
        },
      });
    }

    if (LIVE_PUBLICATION_STATUSES.includes(job.publicationStatus)) {
      throw JobService.createError({
        message:
          "Published vacancy content cannot be edited while the current publication is live or paused. End the publication before changing advertised terms.",
        code: "JOB_PUBLICATION_CONTENT_LOCKED",
        statusCode: 409,
        details: {
          publicationStatus: job.publicationStatus,
          currentPublication: job.currentPublication ? String(job.currentPublication) : null,
        },
      });
    }

    const isDraft = job.recruitmentStatus === "draft" && job.publicationStatus === "unpublished";

    const isRepublishPreparation =
      job.recruitmentStatus === "active" &&
      EDITABLE_AFTER_PUBLICATION_STATUSES.includes(job.publicationStatus);

    if (!isDraft && !isRepublishPreparation) {
      throw JobService.createError({
        message: "The Job is not in an editable recruitment/publication state.",
        code: "JOB_EDIT_STATE_INVALID",
        statusCode: 409,
        details: {
          recruitmentStatus: job.recruitmentStatus,
          publicationStatus: job.publicationStatus,
        },
      });
    }

    return true;
  }

  /* ─────────────────────────────── CREATE / UPDATE ─────────────────────────────── */

  static async createDraft(
    {
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      createdByUserId,
      data = {},
    },
    options = {}
  ) {
    const authority = JobService.assertEmployerCanManageJobs({
      employerProfileId,
      employerContext,
      adminEmployerContext,
    });

    return JobService.runWithOptionalTransaction(options, async (session) => {
      const employerProfile = await JobService.getEmployerProfile(employerProfileId, session);

      const createdBy = JobService.assertAdminActorMatchesContext({
        actorUserId: createdByUserId,
        adminEmployerContext,
        fieldName: "created-by user ID",
      });

      const businessSnapshot = JobService.normalizeEmployerProfileSnapshot(employerProfile);

      const editablePayload = JobService.buildEditablePayload(data);

      const hasBranchInput = Object.prototype.hasOwnProperty.call(data, "branch");

      const requestedBranchId = hasBranchInput ? data.branch : null;

      if (
        authority !== "admin_support" &&
        JobService.isBranchManager(employerContext) &&
        !requestedBranchId
      ) {
        throw JobService.createError({
          message: "A branch manager must create the Job for one of their assigned branches.",
          code: "JOB_BRANCH_REQUIRED_FOR_BRANCH_MANAGER",
          statusCode: 403,
        });
      }

      const branch = requestedBranchId
        ? await JobService.getActiveBranch({
            branchId: requestedBranchId,
            employerProfileId: employerProfile._id,
            employerContext,
            adminEmployerContext,
            session,
          })
        : null;

      const job = new Job({
        referenceCode: generateReference("LQ-JOB"),
        business: employerProfile._id,
        createdBy,
        countryCode: businessSnapshot.countryCode,
        currency: businessSnapshot.currency,
        ...editablePayload,
        recruitmentStatus: "draft",
        publicationStatus: "unpublished",
      });

      JobService.applyBranchSnapshot(job, branch);

      await job.save({
        session,
      });

      logger.info(`Permanent Job draft ${job.referenceCode} created`);

      return {
        job,
        created: true,
      };
    });
  }

  static async updateJob(
    { jobId, employerProfileId, employerContext = null, adminEmployerContext = null, data = {} },
    options = {}
  ) {
    return JobService.runWithOptionalTransaction(options, async (session) => {
      const job = await JobService.getEmployerJob({
        jobId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      JobService.assertJobContentEditable(job);

      const employerProfile = await JobService.getEmployerProfile(employerProfileId, session);

      const businessSnapshot = JobService.normalizeEmployerProfileSnapshot(employerProfile);

      const editablePayload = JobService.buildEditablePayload(data);

      const hasBranchInput = Object.prototype.hasOwnProperty.call(data, "branch");

      if (hasBranchInput) {
        if (!data.branch) {
          const hasPublicationHistory =
            Number(job.publicationCount || 0) > 0 || Boolean(job.currentPublication);

          if (hasPublicationHistory) {
            throw JobService.createError({
              message: "A Job with publication history must retain a branch.",
              code: "PUBLISHED_JOB_BRANCH_REQUIRED",
              statusCode: 409,
            });
          }

          if (JobService.isBranchManager(employerContext)) {
            throw JobService.createError({
              message: "A branch manager cannot remove the Job branch.",
              code: "JOB_BRANCH_REQUIRED_FOR_BRANCH_MANAGER",
              statusCode: 403,
            });
          }

          JobService.applyBranchSnapshot(job, null);
        } else {
          const branch = await JobService.getActiveBranch({
            branchId: data.branch,
            employerProfileId,
            employerContext,
            adminEmployerContext,
            session,
          });

          JobService.applyBranchSnapshot(job, branch);
        }
      }

      for (const [field, value] of Object.entries(editablePayload)) {
        job.set(field, value);
      }

      /*
       * EmployerProfile remains authoritative for these business-level values.
       * They are refreshed only while the Job master is in an editable state.
       */
      job.countryCode = businessSnapshot.countryCode;
      job.currency = businessSnapshot.currency;

      await job.save({
        session,
      });

      logger.info(`Permanent Job ${job.referenceCode} updated`);

      return {
        job,
        updated: true,
      };
    });
  }

  /* ─────────────────────────────── RECRUITMENT CLOSURE ─────────────────────────────── */

  static assertPublicationAllowsRecruitmentClosure(job) {
    if (LIVE_PUBLICATION_STATUSES.includes(job.publicationStatus)) {
      throw JobService.createError({
        message: "The current Job publication must be ended before the recruitment can be closed.",
        code: "JOB_PUBLICATION_MUST_END_BEFORE_CLOSURE",
        statusCode: 409,
        details: {
          publicationStatus: job.publicationStatus,
          currentPublication: job.currentPublication ? String(job.currentPublication) : null,
        },
      });
    }

    return true;
  }

  static async closeJob(
    {
      jobId,
      employerProfileId,
      employerContext = null,
      closedByUserId,
      reason,
      reasonDetails = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedReason = JobService.normalizeCloseReason(reason);

    const normalizedReasonDetails = JobService.normalizeCloseReasonDetails(
      reasonDetails,
      normalizedReason
    );

    const closedAt = JobService.normalizeCurrentTime(currentTime);

    const closedBy = JobService.normalizeObjectId(closedByUserId, "closed-by user ID");

    return JobService.runWithOptionalTransaction(options, async (session) => {
      const job = await JobService.getEmployerJob({
        jobId,
        employerProfileId,
        employerContext,
        session,
      });

      if (job.recruitmentStatus === "closed") {
        return {
          job,
          closed: false,
          idempotent: true,
        };
      }

      if (job.recruitmentStatus === "archived") {
        throw JobService.createError({
          message: "An archived Job cannot be closed again.",
          code: "ARCHIVED_JOB_CLOSURE_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      if (job.recruitmentStatus !== "active") {
        throw JobService.createError({
          message: "Only active recruitment can be closed. Delete an unpublished draft instead.",
          code: "JOB_CLOSURE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            recruitmentStatus: job.recruitmentStatus,
          },
        });
      }

      JobService.assertPublicationAllowsRecruitmentClosure(job);

      job.recruitmentStatus = "closed";
      job.closeReason = normalizedReason;
      job.closeReasonDetails = normalizedReasonDetails;
      job.closedAt = closedAt;
      job.closedBy = closedBy;

      await job.save({
        session,
      });

      logger.info(`Permanent Job ${job.referenceCode} closed: ${normalizedReason}`);

      return {
        job,
        closed: true,
        idempotent: false,
      };
    });
  }

  /**
   * Internal closure boundary used after hiring reaches vacancyCount.
   *
   * JobApplicationService remains responsible for transactionally preventing
   * over-hiring. This method independently verifies the persisted hired count
   * before recording the terminal recruitment state.
   *
   * If a publication is still live/paused, the owning orchestration must end
   * that JobPublication first inside the same transaction.
   */
  static async closeFilledJob({ jobId, closedByUserId, currentTime = new Date() }, options = {}) {
    const closedAt = JobService.normalizeCurrentTime(currentTime);

    const closedBy = JobService.normalizeObjectId(closedByUserId, "closed-by user ID");

    return JobService.runWithOptionalTransaction(options, async (session) => {
      const job = await JobService.getSystemJob(jobId, session);

      if (job.recruitmentStatus === "closed" && job.closeReason === "filled") {
        return {
          job,
          closed: false,
          idempotent: true,
        };
      }

      if (job.recruitmentStatus !== "active") {
        throw JobService.createError({
          message: "Only active recruitment can be auto-closed as filled.",
          code: "FILLED_JOB_CLOSURE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            recruitmentStatus: job.recruitmentStatus,
          },
        });
      }

      JobService.assertPublicationAllowsRecruitmentClosure(job);

      const hiredCountQuery = JobApplication.countDocuments({
        job: job._id,
        status: "hired",
      });

      if (session) {
        hiredCountQuery.session(session);
      }

      const hiredCount = await hiredCountQuery;
      const vacancyCount = Number(job.vacancyCount || 0);

      if (!Number.isSafeInteger(vacancyCount) || vacancyCount < 1) {
        throw JobService.createError({
          message: "Job vacancyCount is invalid.",
          code: "INVALID_JOB_VACANCY_COUNT",
          statusCode: 500,
        });
      }

      if (hiredCount > vacancyCount) {
        throw JobService.createError({
          message: "Persisted hired applications exceed the Job vacancy capacity.",
          code: "JOB_HIRING_CAPACITY_EXCEEDED",
          statusCode: 500,
          details: {
            hiredCount,
            vacancyCount,
          },
        });
      }

      if (hiredCount !== vacancyCount) {
        throw JobService.createError({
          message: "The Job cannot be closed as filled until every vacancy is hired.",
          code: "JOB_NOT_FULLY_HIRED",
          statusCode: 409,
          details: {
            hiredCount,
            vacancyCount,
          },
        });
      }

      job.recruitmentStatus = "closed";
      job.closeReason = "filled";
      job.closeReasonDetails = null;
      job.closedAt = closedAt;
      job.closedBy = closedBy;

      await job.save({
        session,
      });

      logger.info(`Permanent Job ${job.referenceCode} auto-closed as filled`);

      return {
        job,
        closed: true,
        idempotent: false,
        hiredCount,
        vacancyCount,
      };
    });
  }

  /* ─────────────────────────────── ARCHIVE / DELETE DRAFT ─────────────────────────────── */

  static async archiveJob(
    {
      jobId,
      employerProfileId,
      employerContext = null,
      archivedByUserId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const archivedAt = JobService.normalizeCurrentTime(currentTime);

    const archivedBy = JobService.normalizeObjectId(archivedByUserId, "archived-by user ID");

    return JobService.runWithOptionalTransaction(options, async (session) => {
      const job = await JobService.getEmployerJob({
        jobId,
        employerProfileId,
        employerContext,
        session,
      });

      if (job.recruitmentStatus === "archived") {
        return {
          job,
          archived: false,
          idempotent: true,
        };
      }

      if (job.recruitmentStatus !== "closed") {
        throw JobService.createError({
          message: "Only closed recruitment can be archived.",
          code: "JOB_ARCHIVE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            recruitmentStatus: job.recruitmentStatus,
          },
        });
      }

      JobService.assertPublicationAllowsRecruitmentClosure(job);

      job.recruitmentStatus = "archived";
      job.archivedAt = archivedAt;
      job.archivedBy = archivedBy;

      await job.save({
        session,
      });

      logger.info(`Permanent Job ${job.referenceCode} archived`);

      return {
        job,
        archived: true,
        idempotent: false,
      };
    });
  }

  static async deleteDraftJob(
    { jobId, employerProfileId, employerContext = null, adminEmployerContext = null },
    options = {}
  ) {
    return JobService.runWithOptionalTransaction(options, async (session) => {
      const job = await JobService.getEmployerJob({
        jobId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      if (job.recruitmentStatus !== "draft" || job.publicationStatus !== "unpublished") {
        throw JobService.createError({
          message: "Only an unpublished draft Job can be deleted.",
          code: "JOB_DELETE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            recruitmentStatus: job.recruitmentStatus,
            publicationStatus: job.publicationStatus,
          },
        });
      }

      if (Number(job.publicationCount || 0) !== 0 || Boolean(job.currentPublication)) {
        throw JobService.createError({
          message: "A Job with publication history cannot be deleted.",
          code: "JOB_PUBLICATION_HISTORY_PREVENTS_DELETE",
          statusCode: 409,
        });
      }

      const applicationCountQuery = JobApplication.countDocuments({
        job: job._id,
      });

      const publicationCountQuery = JobPublication.countDocuments({
        job: job._id,
      });

      if (session) {
        applicationCountQuery.session(session);
        publicationCountQuery.session(session);
      }

      const [applicationCount, publicationCount] = await Promise.all([
        applicationCountQuery,
        publicationCountQuery,
      ]);

      if (applicationCount > 0 || publicationCount > 0) {
        throw JobService.createError({
          message: "A Job with application or publication history cannot be deleted.",
          code: "JOB_HISTORY_PREVENTS_DELETE",
          statusCode: 409,
          details: {
            applicationCount,
            publicationCount,
          },
        });
      }

      await job.deleteOne({
        session,
      });

      logger.info(`Permanent Job draft ${job.referenceCode} deleted`);

      return {
        jobId: String(job._id),
        referenceCode: job.referenceCode,
        deleted: true,
      };
    });
  }

  /* ─────────────────────────────── EMPLOYER QUERIES ─────────────────────────────── */

  static async getAvailableBranches({
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
    session = null,
  }) {
    const authority = JobService.assertEmployerCanManageJobs({
      employerProfileId,
      employerContext,
      adminEmployerContext,
    });

    const filter = {
      business: JobService.normalizeObjectId(employerProfileId, "employer profile ID"),
      isActive: true,
    };

    if (authority !== "admin_support" && !JobService.canManageAllBranches(employerContext)) {
      filter._id = {
        $in: JobService.getAssignedBranchIds(employerContext),
      };
    }

    const query = Branch.find(filter)
      .select("name address state lga googlePlaceId location isActive")
      .sort({
        name: 1,
      });

    if (session) {
      query.session(session);
    }

    return query.lean();
  }

  static async getEmployerJobs(
    {
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      recruitmentStatus = null,
      publicationStatus = null,
      branchId = null,
      search = null,
      page = 1,
      limit = DEFAULT_PAGE_SIZE,
    },
    options = {}
  ) {
    const normalizedPage = JobService.normalizePage(page);
    const normalizedLimit = JobService.normalizeLimit(limit);

    const filter = JobService.buildEmployerJobFilter({
      employerProfileId,
      employerContext,
      adminEmployerContext,
    });

    const normalizedRecruitmentStatus = JobService.normalizeRecruitmentStatus(recruitmentStatus);

    const normalizedPublicationStatus = JobService.normalizePublicationStatus(publicationStatus);

    if (normalizedRecruitmentStatus) {
      filter.recruitmentStatus = normalizedRecruitmentStatus;
    }

    if (normalizedPublicationStatus) {
      filter.publicationStatus = normalizedPublicationStatus;
    }

    if (branchId) {
      const normalizedBranchId = JobService.normalizeObjectId(branchId, "branch ID");

      JobService.assertBranchManagerCanAccessBranch({
        branchId: normalizedBranchId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
      });

      filter.branch = normalizedBranchId;
    }

    const normalizedSearch = JobService.normalizeSearch(search);

    if (normalizedSearch) {
      const pattern = new RegExp(JobService.escapeRegExp(normalizedSearch), "i");

      filter.$or = [
        {
          referenceCode: pattern,
        },
        {
          roleTitle: pattern,
        },
        {
          specialty: pattern,
        },
        {
          department: pattern,
        },
      ];
    }

    const skip = (normalizedPage - 1) * normalizedLimit;

    const itemsQuery = Job.find(filter)
      .sort({
        updatedAt: -1,
        createdAt: -1,
        _id: -1,
      })
      .skip(skip)
      .limit(normalizedLimit);

    const countQuery = Job.countDocuments(filter);

    if (options.session) {
      itemsQuery.session(options.session);
      countQuery.session(options.session);
    }

    const [items, total] = await Promise.all([itemsQuery.lean(), countQuery]);

    return {
      items,
      page: normalizedPage,
      limit: normalizedLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
    };
  }
}

module.exports = JobService;
