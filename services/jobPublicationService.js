// services/jobPublicationService.js

const Job = require("../models/Job");
const JobPublication = require("../models/JobPublication");
const EmployerProfile = require("../models/EmployerProfile");

const JobService = require("./jobService");
const JobApplicationService = require("./jobApplicationService");

const {
  JOB_PUBLICATION_ENTITLEMENT_SOURCES,
  JOB_SALARY_PERIODS,
  JOB_COMPENSATION_TYPES,
  DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,
} = require("../constants/jobPosting");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId, normalizeOptionalText } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");
const logger = require("../utils/logger");

const ERROR_NAME = "JobPublicationServiceError";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PUBLICATION_REFERENCE_LENGTH = 250;
const MAX_PUBLICATION_END_REASON_LENGTH = 500;
const MAX_DEADLINE_CHANGE_REASON_LENGTH = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_EXPIRY_BATCH_SIZE = 100;
const MAX_EXPIRY_BATCH_SIZE = 500;

const LIVE_PUBLICATION_STATUSES = ["live", "paused"];
const REPUBLISHABLE_PUBLICATION_STATUSES = ["expired", "ended"];

/**
 * JobPublicationService owns permanent-Job marketplace publication lifecycle.
 *
 * Commercial authority is intentionally injected as an already-authorized
 * entitlement grant. JobPublicationEntitlementService owns publication
 * entitlement resolution and consumption orchestration before calling
 * publishJob with that durable grant.
 *
 * SubscriptionAllowance / JobPayment authority does not yet exist in the
 * current repository, so this service does not invent allowance balances,
 * prices or payment state. Future subscription and PAYG producers plug into
 * JobPublicationEntitlementService without changing this lifecycle service.
 *
 * Notifications are represented as post-commit events. This service does not
 * create Notification documents inside lifecycle transactions.
 *
 * Trusted admin employer support is limited to publication assistance:
 * publish/renew, pause/resume, application-deadline changes and early ending.
 * Hiring and recruitment-closure orchestration remain employer-only.
 */
class JobPublicationService {
  /* ─────────────────────────────── CORE HELPERS ─────────────────────────────── */

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: ERROR_NAME,
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
      throw this.createError({
        message: "An active transaction is required for the supplied session.",
        code: "JOB_PUBLICATION_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  static withSession(query, session = null) {
    if (session) {
      query.session(session);
    }

    return query;
  }

  static normalizeObjectId(value, fieldName, required = true) {
    return normalizeObjectId({
      value,
      fieldName,
      required,
      createError: JobPublicationService.createError,
    });
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    return normalizeOptionalText({
      value,
      fieldName,
      maximumLength,
      createError: JobPublicationService.createError,
      emptyValue: null,
    });
  }

  static normalizeCurrentTime(value = new Date()) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw this.createError({
        message: "Current time is invalid.",
        code: "INVALID_CURRENT_TIME",
      });
    }

    return date;
  }

  static normalizeNullableDate(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw this.createError({
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

    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  }

  static normalizeLimit(value) {
    const limit = Number(value || DEFAULT_PAGE_SIZE);

    if (!Number.isSafeInteger(limit) || limit < 1) {
      return DEFAULT_PAGE_SIZE;
    }

    return Math.min(limit, MAX_PAGE_SIZE);
  }

  static normalizeExpiryBatchLimit(value = DEFAULT_EXPIRY_BATCH_SIZE) {
    const limit = Number(value);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPIRY_BATCH_SIZE) {
      throw this.createError({
        message: `Expiry batch limit must be between 1 and ${MAX_EXPIRY_BATCH_SIZE}.`,
        code: "INVALID_JOB_PUBLICATION_EXPIRY_BATCH_LIMIT",
      });
    }

    return limit;
  }

  static normalizeSafeAmount(value, fieldName, required = false) {
    if (value === null || value === undefined || value === "") {
      if (!required) {
        return null;
      }

      throw this.createError({
        message: `${fieldName} is required.`,
        code: `${String(fieldName)
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")}_REQUIRED`,
      });
    }

    const amount = Number(value);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw this.createError({
        message: `${fieldName} must be a non-negative whole minor-unit amount.`,
        code: `INVALID_${String(fieldName)
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")}`,
      });
    }

    return amount;
  }

  static sameNullableDate(left, right) {
    if (!left && !right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    const leftDate = left instanceof Date ? left : new Date(left);
    const rightDate = right instanceof Date ? right : new Date(right);

    if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) {
      return false;
    }

    return leftDate.getTime() === rightDate.getTime();
  }

  static escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
  }

  /* ─────────────────────────────── ENTITLEMENT GRANT ─────────────────────────────── */

  static normalizeEntitlementGrant(entitlementGrant, publishedAt) {
    if (
      !entitlementGrant ||
      typeof entitlementGrant !== "object" ||
      Array.isArray(entitlementGrant)
    ) {
      throw this.createError({
        message: "An authorized publication entitlement grant is required.",
        code: "JOB_PUBLICATION_ENTITLEMENT_REQUIRED",
        statusCode: 409,
      });
    }

    const source = String(entitlementGrant.source || "")
      .trim()
      .toLowerCase();

    if (!JOB_PUBLICATION_ENTITLEMENT_SOURCES.includes(source)) {
      throw this.createError({
        message: "Publication entitlement source is invalid.",
        code: "INVALID_JOB_PUBLICATION_ENTITLEMENT_SOURCE",
      });
    }

    const consumptionReference = this.normalizeOptionalText(
      entitlementGrant.consumptionReference,
      "Publication entitlement consumption reference",
      MAX_PUBLICATION_REFERENCE_LENGTH
    );

    if (!consumptionReference) {
      throw this.createError({
        message: "Publication entitlement consumption reference is required.",
        code: "JOB_PUBLICATION_CONSUMPTION_REFERENCE_REQUIRED",
      });
    }

    const grantedAt = this.normalizeNullableDate(
      entitlementGrant.grantedAt,
      "Publication entitlement grantedAt"
    );

    const consumedAt = this.normalizeNullableDate(
      entitlementGrant.consumedAt,
      "Publication entitlement consumedAt"
    );

    if (!grantedAt || !consumedAt) {
      throw this.createError({
        message: "Publication entitlement grantedAt and consumedAt are required.",
        code: "JOB_PUBLICATION_ENTITLEMENT_TIMESTAMPS_REQUIRED",
      });
    }

    if (consumedAt < grantedAt) {
      throw this.createError({
        message: "Publication entitlement cannot be consumed before it is granted.",
        code: "INVALID_JOB_PUBLICATION_ENTITLEMENT_TIMELINE",
      });
    }

    if (consumedAt > publishedAt) {
      throw this.createError({
        message: "Publication entitlement must be consumed before or when publication begins.",
        code: "JOB_PUBLICATION_ENTITLEMENT_NOT_CONSUMED",
        statusCode: 409,
      });
    }

    const planCode = this.normalizeOptionalText(
      entitlementGrant.planCode,
      "Publication entitlement plan code",
      100
    );

    const planName = this.normalizeOptionalText(
      entitlementGrant.planName,
      "Publication entitlement plan name",
      150
    );

    const billingCycleKey = this.normalizeOptionalText(
      entitlementGrant.billingCycleKey,
      "Publication entitlement billing cycle key",
      150
    );

    const purchaseReference = this.normalizeOptionalText(
      entitlementGrant.purchaseReference,
      "Publication entitlement purchase reference",
      MAX_PUBLICATION_REFERENCE_LENGTH
    );

    const paymentTransaction = this.normalizeObjectId(
      entitlementGrant.paymentTransaction,
      "publication payment transaction ID",
      false
    );

    if (source === "free") {
      if (planCode || planName || billingCycleKey || purchaseReference || paymentTransaction) {
        throw this.createError({
          message: "Free publication entitlement cannot contain plan or paid-purchase details.",
          code: "FREE_JOB_PUBLICATION_ENTITLEMENT_METADATA_CONFLICT",
        });
      }
    }

    if (source === "plan_allowance") {
      if (!planCode || !billingCycleKey) {
        throw this.createError({
          message: "Plan-allowance publication requires planCode and billingCycleKey.",
          code: "INCOMPLETE_PLAN_ALLOWANCE_PUBLICATION_ENTITLEMENT",
        });
      }

      if (purchaseReference || paymentTransaction) {
        throw this.createError({
          message: "Plan-allowance publication cannot contain paid single-post purchase details.",
          code: "PLAN_ALLOWANCE_PUBLICATION_PAYMENT_CONFLICT",
        });
      }
    }

    if (source === "paid_single_post" && !purchaseReference) {
      throw this.createError({
        message: "Paid single-post publication requires purchaseReference.",
        code: "PAID_JOB_PUBLICATION_PURCHASE_REFERENCE_REQUIRED",
      });
    }

    return {
      source,
      consumptionReference,
      planCode,
      planName,
      billingCycleKey,
      purchaseReference,
      paymentTransaction,
      grantedAt,
      consumedAt,
    };
  }

  /* ─────────────────────────────── SNAPSHOTS ─────────────────────────────── */

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

  static buildScreeningSnapshot(job) {
    return (job.screeningQuestions || []).map((question) => ({
      questionId: question._id,
      prompt: question.prompt,
      type: question.type,
      requirementLevel: question.requirementLevel,
      isResponseRequired: question.isResponseRequired === true,
      options: Array.isArray(question.options) ? [...question.options] : [],
      qualifyingBoolean:
        typeof question.qualifyingBoolean === "boolean" ? question.qualifyingBoolean : null,
      minimumNumber: question.minimumNumber ?? null,
      maximumNumber: question.maximumNumber ?? null,
      acceptableOptions: Array.isArray(question.acceptableOptions)
        ? [...question.acceptableOptions]
        : [],
      requireAllOptions: question.requireAllOptions === true,
    }));
  }

  static buildListingSnapshot(job, capturedAt) {
    const compensation = job.compensation || {};

    return {
      snapshotVersion: 1,
      roleTitle: job.roleTitle,
      professionalType: job.professionalType,
      specialty: job.specialty || null,
      department: job.department || null,
      employmentType: job.employmentType,
      workplaceType: job.workplaceType,
      minimumYearsOfExperience: Number(job.minimumYearsOfExperience || 0),
      educationRequirement: job.educationRequirement || null,
      countryCode: job.countryCode,
      state: job.state || null,
      lga: job.lga || null,
      address: job.address || null,
      googlePlaceId: job.googlePlaceId || null,
      location: this.cloneLocation(job.location),
      currency: job.currency,
      compensation: {
        type: compensation.type,
        minimumAmount: compensation.minimumAmount,
        maximumAmount: compensation.maximumAmount,
        period: compensation.period,
        negotiable: compensation.negotiable === true,
      },
      summary: job.summary || null,
      description: job.description,
      responsibilities: Array.isArray(job.responsibilities) ? [...job.responsibilities] : [],
      requirements: Array.isArray(job.requirements) ? [...job.requirements] : [],
      preferredQualifications: Array.isArray(job.preferredQualifications)
        ? [...job.preferredQualifications]
        : [],
      skills: Array.isArray(job.skills) ? [...job.skills] : [],
      benefits: Array.isArray(job.benefits) ? [...job.benefits] : [],
      vacancyCount: job.vacancyCount,
      employmentStartDate: job.employmentStartDate || null,
      screeningQuestions: this.buildScreeningSnapshot(job),
      capturedAt,
    };
  }

  static buildEmployerSnapshot(employerProfile, branch) {
    return {
      snapshotVersion: 1,
      businessName: employerProfile.businessName,
      type: employerProfile.type,
      logoUrl: String(employerProfile.logoUrl || "").trim() || null,
      publicDescription: String(employerProfile.publicDescription || "").trim() || null,
      websiteUrl: String(employerProfile.websiteUrl || "").trim() || null,
      cacVerified: employerProfile.cacVerificationStatus === "verified",
      regulatoryVerified: employerProfile.regulatoryVerificationStatus === "verified",
      branchName: branch.name,
      branchAddress: branch.address || null,
      branchState: branch.state || null,
      branchLga: branch.lga || null,
    };
  }

  /* ─────────────────────────────── PUBLICATION INTEGRITY ─────────────────────────────── */

  static assertEmployerEligibleToPublish(employerProfile) {
    if (employerProfile.accountStatus !== "active") {
      throw this.createError({
        message: "Employer account must be active before publishing Jobs.",
        code: "EMPLOYER_ACCOUNT_NOT_ACTIVE_FOR_JOB_PUBLICATION",
        statusCode: 403,
      });
    }

    if (employerProfile.employerApprovalStatus !== "approved") {
      throw this.createError({
        message: "Employer profile must be approved before publishing Jobs.",
        code: "EMPLOYER_NOT_APPROVED_FOR_JOB_PUBLICATION",
        statusCode: 403,
      });
    }
  }

  static assertJobPublishable(job) {
    if (!job.branch) {
      throw this.createError({
        message: "Select an active branch before publishing this Job.",
        code: "JOB_BRANCH_REQUIRED_FOR_PUBLICATION",
        statusCode: 409,
      });
    }

    if (["closed", "archived"].includes(job.recruitmentStatus)) {
      throw this.createError({
        message: "Closed or archived recruitment cannot be published.",
        code: "JOB_RECRUITMENT_NOT_PUBLISHABLE",
        statusCode: 409,
      });
    }

    if (LIVE_PUBLICATION_STATUSES.includes(job.publicationStatus)) {
      throw this.createError({
        message: "This Job already has a live or paused publication.",
        code: "JOB_ALREADY_HAS_ACTIVE_PUBLICATION",
        statusCode: 409,
      });
    }

    const initialPublication =
      job.recruitmentStatus === "draft" && job.publicationStatus === "unpublished";

    const renewalPublication =
      job.recruitmentStatus === "active" &&
      REPUBLISHABLE_PUBLICATION_STATUSES.includes(job.publicationStatus);

    if (!initialPublication && !renewalPublication) {
      throw this.createError({
        message: "The Job is not in a publishable lifecycle state.",
        code: "JOB_PUBLICATION_STATE_INVALID",
        statusCode: 409,
        details: {
          recruitmentStatus: job.recruitmentStatus,
          publicationStatus: job.publicationStatus,
        },
      });
    }
  }

  static validatePublicationDeadline(applicationDeadline, publishedAt, expiresAt) {
    if (!applicationDeadline) {
      return null;
    }

    if (applicationDeadline <= publishedAt) {
      throw this.createError({
        message: "Application deadline must be later than the publication start time.",
        code: "JOB_APPLICATION_DEADLINE_NOT_FUTURE",
        statusCode: 409,
      });
    }

    if (applicationDeadline > expiresAt) {
      throw this.createError({
        message: "Application deadline cannot exceed the 45-day publication expiry.",
        code: "JOB_APPLICATION_DEADLINE_AFTER_PUBLICATION_EXPIRY",
        statusCode: 409,
      });
    }

    return applicationDeadline;
  }

  static async getLatestPublication(jobId, session = null) {
    return this.withSession(
      JobPublication.findOne({
        job: jobId,
      }).sort({
        cycleNumber: -1,
        _id: -1,
      }),
      session
    );
  }

  static async assertPublicationChain(job, latestPublication) {
    const jobPublicationCount = Number(job.publicationCount || 0);

    if (!latestPublication) {
      if (jobPublicationCount !== 0 || job.currentPublication) {
        throw this.createError({
          message: "Job publication summary does not match publication history.",
          code: "JOB_PUBLICATION_HISTORY_MISMATCH",
          statusCode: 500,
        });
      }

      return;
    }

    if (
      !job.currentPublication ||
      String(job.currentPublication) !== String(latestPublication._id)
    ) {
      throw this.createError({
        message: "Job currentPublication does not point to its latest publication.",
        code: "JOB_CURRENT_PUBLICATION_MISMATCH",
        statusCode: 500,
      });
    }

    if (jobPublicationCount !== Number(latestPublication.cycleNumber)) {
      throw this.createError({
        message: "Job publicationCount does not match its latest publication cycle.",
        code: "JOB_PUBLICATION_COUNT_MISMATCH",
        statusCode: 500,
      });
    }
  }

  /* ─────────────────────────────── LOADERS ─────────────────────────────── */

  static async getPublication(publicationId, session = null) {
    const publication = await this.withSession(
      JobPublication.findById(this.normalizeObjectId(publicationId, "Job publication ID")),
      session
    );

    if (!publication) {
      throw this.createError({
        message: "Job publication was not found.",
        code: "JOB_PUBLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return publication;
  }

  static async getEmployerProfileForPublication(employerProfileId, session = null) {
    const employerProfile = await this.withSession(
      EmployerProfile.findById(
        this.normalizeObjectId(employerProfileId, "employer profile ID")
      ).select(
        "businessName type logoUrl publicDescription websiteUrl " +
          "cacVerificationStatus regulatoryVerificationStatus " +
          "accountStatus employerApprovalStatus"
      ),
      session
    );

    if (!employerProfile) {
      throw this.createError({
        message: "Employer profile was not found.",
        code: "EMPLOYER_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return employerProfile;
  }

  static async getEmployerPublication({
    publicationId,
    employerProfileId,
    employerContext = null,
    adminEmployerContext = null,
    session = null,
  }) {
    const publication = await this.getPublication(publicationId, session);

    const job = await JobService.getEmployerJob({
      jobId: publication.job,
      employerProfileId,
      employerContext,
      adminEmployerContext,
      session,
    });

    if (
      String(publication.business) !== String(job.business) ||
      String(publication.branch) !== String(job.branch)
    ) {
      throw this.createError({
        message: "Job publication ownership does not match its Job.",
        code: "JOB_PUBLICATION_OWNERSHIP_MISMATCH",
        statusCode: 500,
      });
    }

    return {
      publication,
      job,
    };
  }

  /* ─────────────────────────────── JOB SYNCHRONIZATION ─────────────────────────────── */

  static async synchronizeJobToPublication({ job, publication, session }) {
    job.currentPublication = publication._id;
    job.publicationCount = publication.cycleNumber;
    job.publicationStatus = publication.status;
    job.lastPublishedAt = publication.publishedAt;
    job.publicationExpiresAt = publication.expiresAt;
    job.applicationDeadline = publication.applicationDeadline || null;

    if (job.recruitmentStatus === "draft") {
      job.recruitmentStatus = "active";
    }

    await job.save({
      session,
    });

    return job;
  }

  static async synchronizeCurrentPublicationStatus({ job, publication, session }) {
    if (!job.currentPublication || String(job.currentPublication) !== String(publication._id)) {
      throw this.createError({
        message: "Publication is not the Job's current publication.",
        code: "JOB_PUBLICATION_NOT_CURRENT",
        statusCode: 409,
      });
    }

    job.publicationStatus = publication.status;
    job.applicationDeadline = publication.applicationDeadline || null;

    await job.save({
      session,
    });

    return job;
  }

  /* ─────────────────────────────── PUBLISH / RENEW ─────────────────────────────── */

  static async publishJob(
    {
      jobId,
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      publishedByUserId,
      entitlementGrant,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const publishedAt = this.normalizeCurrentTime(currentTime);

    const publishedBy = JobService.assertAdminActorMatchesContext({
      actorUserId: publishedByUserId,
      adminEmployerContext,
      fieldName: "published-by user ID",
    });

    const normalizedEntitlement = this.normalizeEntitlementGrant(entitlementGrant, publishedAt);

    return this.runWithOptionalTransaction(options, async (session) => {
      const existingEntitlementPublication = await this.withSession(
        JobPublication.findOne({
          "entitlementSnapshot.consumptionReference": normalizedEntitlement.consumptionReference,
        }),
        session
      );

      if (existingEntitlementPublication) {
        if (String(existingEntitlementPublication.job) !== String(jobId)) {
          throw this.createError({
            message: "This publication entitlement has already been consumed by another Job.",
            code: "JOB_PUBLICATION_ENTITLEMENT_ALREADY_CONSUMED",
            statusCode: 409,
          });
        }

        const existingJob = await JobService.getEmployerJob({
          jobId: existingEntitlementPublication.job,
          employerProfileId,
          employerContext,
          adminEmployerContext,
          session,
        });

        return {
          job: existingJob,
          publication: existingEntitlementPublication,
          published: false,
          idempotent: true,
          events: [],
        };
      }

      const job = await JobService.getEmployerJob({
        jobId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      const employerProfile = await this.getEmployerProfileForPublication(job.business, session);

      this.assertEmployerEligibleToPublish(employerProfile);

      let latestPublication = await this.getLatestPublication(job._id, session);

      await this.assertPublicationChain(job, latestPublication);

      const events = [];

      /*
       * Scheduler lag must not force a user to wait before renewing an already
       * elapsed publication. Normalize the due current publication first.
       */
      if (
        latestPublication &&
        LIVE_PUBLICATION_STATUSES.includes(latestPublication.status) &&
        publishedAt >= new Date(latestPublication.expiresAt)
      ) {
        const expiryResult = await this.expirePublicationInternal({
          publication: latestPublication,
          job,
          expiredAt: publishedAt,
          session,
        });

        latestPublication = expiryResult.publication;

        events.push(...expiryResult.events);
      }

      this.assertJobPublishable(job);

      const branch = await JobService.getActiveBranch({
        branchId: job.branch,
        employerProfileId: employerProfile._id,
        employerContext,
        adminEmployerContext,
        session,
      });

      const cycleNumber = latestPublication ? Number(latestPublication.cycleNumber) + 1 : 1;

      const expiresAt = new Date(
        publishedAt.getTime() + DEFAULT_JOB_PUBLICATION_PERIOD_DAYS * MILLISECONDS_PER_DAY
      );

      const applicationDeadline = this.validatePublicationDeadline(
        this.normalizeNullableDate(job.applicationDeadline, "applicationDeadline"),
        publishedAt,
        expiresAt
      );

      const publicationPayload = {
        referenceCode: generateReference("LQ-JPUB"),
        job: job._id,
        business: job.business,
        branch: branch._id,
        cycleNumber,
        previousPublication: latestPublication ? latestPublication._id : null,
        employerSnapshot: this.buildEmployerSnapshot(employerProfile, branch),
        listingSnapshot: this.buildListingSnapshot(job, publishedAt),
        entitlementSnapshot: normalizedEntitlement,
        publicationPeriodDays: DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,
        publishedAt,
        publishedBy,
        expiresAt,
        initialApplicationDeadline: applicationDeadline,
        applicationDeadline,
        deadlineHistory: [],
        status: "live",
        pauseHistory: [],
        applicationCount: 0,
        applicationCountLastReconciledAt: publishedAt,
      };

      let publication;

      try {
        [publication] = await JobPublication.create([publicationPayload], {
          session,
        });
      } catch (error) {
        if (error?.code === 11000) {
          throw this.createError({
            message: "This Job publication cycle or entitlement has already been used.",
            code: "JOB_PUBLICATION_DUPLICATE",
            statusCode: 409,
          });
        }

        throw error;
      }

      await this.synchronizeJobToPublication({
        job,
        publication,
        session,
      });

      events.push({
        type: "job_published",
        jobId: String(job._id),
        publicationId: String(publication._id),
        employerProfileId: String(job.business),
        cycleNumber: publication.cycleNumber,
      });

      logger.info(
        `Permanent Job ${job.referenceCode} published as ${publication.referenceCode} cycle ${cycleNumber}`
      );

      return {
        job,
        publication,
        published: true,
        idempotent: false,
        events,
      };
    });
  }

  /* ─────────────────────────────── PAUSE / RESUME ─────────────────────────────── */

  static async pausePublication(
    {
      publicationId,
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      pausedByUserId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const pausedAt = this.normalizeCurrentTime(currentTime);

    const pausedBy = JobService.assertAdminActorMatchesContext({
      actorUserId: pausedByUserId,
      adminEmployerContext,
      fieldName: "paused-by user ID",
    });

    return this.runWithOptionalTransaction(options, async (session) => {
      const { publication, job } = await this.getEmployerPublication({
        publicationId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      if (publication.status === "paused") {
        return {
          publication,
          job,
          paused: false,
          idempotent: true,
          events: [],
        };
      }

      if (publication.status !== "live") {
        throw this.createError({
          message: "Only a live Job publication can be paused.",
          code: "JOB_PUBLICATION_PAUSE_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      if (pausedAt >= new Date(publication.expiresAt)) {
        const expiryResult = await this.expirePublicationInternal({
          publication,
          job,
          expiredAt: pausedAt,
          session,
        });

        return {
          ...expiryResult,
          paused: false,
          expired: true,
        };
      }

      publication.pauseHistory.push({
        pausedAt,
        pausedBy,
        resumedAt: null,
        resumedBy: null,
      });

      publication.status = "paused";

      await publication.save({
        session,
      });

      await this.synchronizeCurrentPublicationStatus({
        job,
        publication,
        session,
      });

      return {
        publication,
        job,
        paused: true,
        idempotent: false,
        events: [
          {
            type: "job_publication_paused",
            jobId: String(job._id),
            publicationId: String(publication._id),
            employerProfileId: String(job.business),
          },
        ],
      };
    });
  }

  static async resumePublication(
    {
      publicationId,
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      resumedByUserId,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const resumedAt = this.normalizeCurrentTime(currentTime);

    const resumedBy = JobService.assertAdminActorMatchesContext({
      actorUserId: resumedByUserId,
      adminEmployerContext,
      fieldName: "resumed-by user ID",
    });

    return this.runWithOptionalTransaction(options, async (session) => {
      const { publication, job } = await this.getEmployerPublication({
        publicationId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      if (publication.status === "live") {
        return {
          publication,
          job,
          resumed: false,
          idempotent: true,
          events: [],
        };
      }

      if (publication.status !== "paused") {
        throw this.createError({
          message: "Only a paused Job publication can be resumed.",
          code: "JOB_PUBLICATION_RESUME_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      if (resumedAt >= new Date(publication.expiresAt)) {
        const expiryResult = await this.expirePublicationInternal({
          publication,
          job,
          expiredAt: resumedAt,
          session,
        });

        return {
          ...expiryResult,
          resumed: false,
          expired: true,
        };
      }

      const latestPause = publication.pauseHistory[publication.pauseHistory.length - 1];

      if (!latestPause || latestPause.resumedAt) {
        throw this.createError({
          message: "Paused Job publication is missing its active pause audit.",
          code: "JOB_PUBLICATION_PAUSE_AUDIT_INVALID",
          statusCode: 500,
        });
      }

      latestPause.resumedAt = resumedAt;
      latestPause.resumedBy = resumedBy;

      publication.status = "live";

      await publication.save({
        session,
      });

      await this.synchronizeCurrentPublicationStatus({
        job,
        publication,
        session,
      });

      return {
        publication,
        job,
        resumed: true,
        idempotent: false,
        events: [
          {
            type: "job_publication_resumed",
            jobId: String(job._id),
            publicationId: String(publication._id),
            employerProfileId: String(job.business),
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── APPLICATION DEADLINE ─────────────────────────────── */

  static async adjustApplicationDeadline(
    {
      publicationId,
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      changedByUserId,
      applicationDeadline,
      reason = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const changedAt = this.normalizeCurrentTime(currentTime);

    const changedBy = JobService.assertAdminActorMatchesContext({
      actorUserId: changedByUserId,
      adminEmployerContext,
      fieldName: "deadline-change user ID",
    });

    const requestedDeadline = this.normalizeNullableDate(
      applicationDeadline,
      "applicationDeadline"
    );

    const normalizedReason = this.normalizeOptionalText(
      reason,
      "Application deadline change reason",
      MAX_DEADLINE_CHANGE_REASON_LENGTH
    );

    return this.runWithOptionalTransaction(options, async (session) => {
      const { publication, job } = await this.getEmployerPublication({
        publicationId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      if (!LIVE_PUBLICATION_STATUSES.includes(publication.status)) {
        throw this.createError({
          message: "Application deadline can only be changed while publication is live or paused.",
          code: "JOB_APPLICATION_DEADLINE_CHANGE_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      if (changedAt >= new Date(publication.expiresAt)) {
        const expiryResult = await this.expirePublicationInternal({
          publication,
          job,
          expiredAt: changedAt,
          session,
        });

        return {
          ...expiryResult,
          adjusted: false,
          expired: true,
        };
      }

      if (requestedDeadline) {
        if (requestedDeadline <= changedAt) {
          throw this.createError({
            message: "The new application deadline must be in the future.",
            code: "JOB_APPLICATION_DEADLINE_NOT_FUTURE",
            statusCode: 409,
          });
        }

        if (requestedDeadline > new Date(publication.expiresAt)) {
          throw this.createError({
            message: "Application deadline cannot exceed publication expiry.",
            code: "JOB_APPLICATION_DEADLINE_AFTER_PUBLICATION_EXPIRY",
            statusCode: 409,
          });
        }
      }

      if (this.sameNullableDate(publication.applicationDeadline, requestedDeadline)) {
        return {
          publication,
          job,
          adjusted: false,
          idempotent: true,
          events: [],
        };
      }

      publication.deadlineHistory.push({
        fromDeadline: publication.applicationDeadline || null,
        toDeadline: requestedDeadline,
        changedAt,
        changedBy,
        reason: normalizedReason,
      });

      publication.applicationDeadline = requestedDeadline;

      await publication.save({
        session,
      });

      await this.synchronizeCurrentPublicationStatus({
        job,
        publication,
        session,
      });

      return {
        publication,
        job,
        adjusted: true,
        idempotent: false,
        events: [],
      };
    });
  }

  /* ─────────────────────────────── EARLY END ─────────────────────────────── */

  static async endPublicationInternal({ publication, job, endedBy, reason, endedAt, session }) {
    if (publication.status === "ended") {
      return {
        publication,
        job,
        ended: false,
        idempotent: true,
        events: [],
      };
    }

    if (publication.status === "expired") {
      return {
        publication,
        job,
        ended: false,
        expired: true,
        idempotent: true,
        events: [],
      };
    }

    if (!LIVE_PUBLICATION_STATUSES.includes(publication.status)) {
      throw this.createError({
        message: "This Job publication cannot be ended from its current state.",
        code: "JOB_PUBLICATION_END_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    if (endedAt >= new Date(publication.expiresAt)) {
      return this.expirePublicationInternal({
        publication,
        job,
        expiredAt: endedAt,
        session,
      });
    }

    publication.status = "ended";
    publication.endedAt = endedAt;
    publication.endedBy = endedBy;
    publication.endReason = reason;

    await publication.save({
      session,
    });

    await this.synchronizeCurrentPublicationStatus({
      job,
      publication,
      session,
    });

    return {
      publication,
      job,
      ended: true,
      idempotent: false,
      events: [
        {
          type: "job_publication_ended",
          jobId: String(job._id),
          publicationId: String(publication._id),
          employerProfileId: String(job.business),
        },
      ],
    };
  }

  static async endPublication(
    {
      publicationId,
      employerProfileId,
      employerContext = null,
      adminEmployerContext = null,
      endedByUserId,
      reason,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const endedAt = this.normalizeCurrentTime(currentTime);

    const endedBy = JobService.assertAdminActorMatchesContext({
      actorUserId: endedByUserId,
      adminEmployerContext,
      fieldName: "ended-by user ID",
    });

    const normalizedReason = this.normalizeOptionalText(
      reason,
      "Publication end reason",
      MAX_PUBLICATION_END_REASON_LENGTH
    );

    if (!normalizedReason) {
      throw this.createError({
        message: "Publication end reason is required.",
        code: "JOB_PUBLICATION_END_REASON_REQUIRED",
      });
    }

    return this.runWithOptionalTransaction(options, async (session) => {
      const { publication, job } = await this.getEmployerPublication({
        publicationId,
        employerProfileId,
        employerContext,
        adminEmployerContext,
        session,
      });

      return this.endPublicationInternal({
        publication,
        job,
        endedBy,
        reason: normalizedReason,
        endedAt,
        session,
      });
    });
  }

  /* ─────────────────────────────── NATURAL EXPIRY ─────────────────────────────── */

  static async expirePublicationInternal({ publication, job, expiredAt, session }) {
    if (publication.status === "expired") {
      return {
        publication,
        job,
        expired: false,
        idempotent: true,
        events: [],
      };
    }

    if (publication.status === "ended") {
      return {
        publication,
        job,
        expired: false,
        ended: true,
        idempotent: true,
        events: [],
      };
    }

    if (!LIVE_PUBLICATION_STATUSES.includes(publication.status)) {
      throw this.createError({
        message: "This Job publication cannot expire from its current state.",
        code: "JOB_PUBLICATION_EXPIRY_NOT_ALLOWED",
        statusCode: 409,
      });
    }

    if (expiredAt < new Date(publication.expiresAt)) {
      throw this.createError({
        message: "Job publication has not reached its expiry time.",
        code: "JOB_PUBLICATION_NOT_DUE_FOR_EXPIRY",
        statusCode: 409,
      });
    }

    publication.status = "expired";

    await publication.save({
      session,
    });

    await this.synchronizeCurrentPublicationStatus({
      job,
      publication,
      session,
    });

    return {
      publication,
      job,
      expired: true,
      idempotent: false,
      events: [
        {
          type: "job_publication_expired",
          jobId: String(job._id),
          publicationId: String(publication._id),
          employerProfileId: String(job.business),
        },
      ],
    };
  }

  static async expirePublication({ publicationId, currentTime = new Date() }, options = {}) {
    const expiredAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const publication = await this.getPublication(publicationId, session);

      const job = await JobService.getSystemJob(publication.job, session);

      return this.expirePublicationInternal({
        publication,
        job,
        expiredAt,
        session,
      });
    });
  }

  static async expireDuePublications({
    currentTime = new Date(),
    limit = DEFAULT_EXPIRY_BATCH_SIZE,
  } = {}) {
    const expiredAt = this.normalizeCurrentTime(currentTime);

    const batchLimit = this.normalizeExpiryBatchLimit(limit);

    const candidates = await JobPublication.find({
      status: {
        $in: LIVE_PUBLICATION_STATUSES,
      },
      expiresAt: {
        $lte: expiredAt,
      },
    })
      .select("_id job referenceCode expiresAt status")
      .sort({
        expiresAt: 1,
        _id: 1,
      })
      .limit(batchLimit)
      .lean();

    const results = [];

    for (const candidate of candidates) {
      try {
        const result = await this.expirePublication({
          publicationId: candidate._id,
          currentTime: expiredAt,
        });

        results.push({
          publicationId: String(candidate._id),
          jobId: String(candidate.job),
          success: true,
          expired: result.expired === true,
          events: result.events || [],
        });
      } catch (error) {
        logger.error(`Failed to expire Job publication ${candidate._id}: ${error.message}`);

        results.push({
          publicationId: String(candidate._id),
          jobId: String(candidate.job),
          success: false,
          code: error.code || "JOB_PUBLICATION_EXPIRY_FAILED",
          message: error.message,
          events: [],
        });
      }
    }

    return {
      checked: candidates.length,
      expired: results.filter((item) => item.success && item.expired).length,
      failed: results.filter((item) => !item.success).length,
      results,
    };
  }

  /* ─────────────────────────────── HIRE / FILLED ORCHESTRATION ─────────────────────────────── */

  static async hireApplicationAndFinalize(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      hiredByUserId,
      employerPrivateNote = undefined,
      statusNote = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const hiredAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const hireResult = await JobApplicationService.hireApplication(
        {
          applicationId,
          employerProfileId,
          employerContext,
          hiredByUserId,
          employerPrivateNote,
          statusNote,
          currentTime: hiredAt,
        },
        {
          session,
        }
      );

      if (!hireResult.jobFilled) {
        return {
          ...hireResult,
          finalization: null,
        };
      }

      const finalization = await this.finalizeFilledJob(
        {
          jobId: hireResult.job._id,
          closedByUserId: hiredByUserId,
          currentTime: hiredAt,
        },
        {
          session,
        }
      );

      const events = [
        ...(hireResult.events || []).filter((event) => event.type !== "job_capacity_filled"),
        ...(finalization.events || []),
      ];

      return {
        ...hireResult,
        job: finalization.job,
        requiresPublicationFinalization: false,
        finalization,
        events,
      };
    });
  }

  /* ─────────────────────────────── RECRUITMENT CLOSURE ORCHESTRATION ─────────────────────────────── */

  static async closeRecruitment(
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
    const closedAt = this.normalizeCurrentTime(currentTime);

    const closedBy = this.normalizeObjectId(closedByUserId, "closed-by user ID");

    return this.runWithOptionalTransaction(options, async (session) => {
      let job = await JobService.getEmployerJob({
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
          events: [],
        };
      }

      const events = [];

      let publicationResult = null;

      if (LIVE_PUBLICATION_STATUSES.includes(job.publicationStatus)) {
        if (!job.currentPublication) {
          throw this.createError({
            message: "Active Job publication is missing currentPublication.",
            code: "JOB_CURRENT_PUBLICATION_REQUIRED",
            statusCode: 500,
          });
        }

        const publication = await this.getPublication(job.currentPublication, session);

        publicationResult = await this.endPublicationInternal({
          publication,
          job,
          endedBy: closedBy,
          reason: "Recruitment closed by employer.",
          endedAt: closedAt,
          session,
        });

        job = publicationResult.job;

        events.push(...(publicationResult.events || []));
      }

      const rejectionResult = await JobApplicationService.rejectOpenApplicationsForJob(
        {
          jobId: job._id,
          reason: "recruitment_closed",
          currentTime: closedAt,
        },
        {
          session,
        }
      );

      events.push(...(rejectionResult.events || []));

      const closeResult = await JobService.closeJob(
        {
          jobId: job._id,
          employerProfileId,
          employerContext,
          closedByUserId: closedBy,
          reason,
          reasonDetails,
          currentTime: closedAt,
        },
        {
          session,
        }
      );

      return {
        job: closeResult.job,
        publication: publicationResult?.publication || null,
        closed: closeResult.closed === true,
        idempotent: closeResult.idempotent === true,
        rejectedOpenApplications: rejectionResult.rejectedCount,
        events,
      };
    });
  }

  static async finalizeFilledJob(
    { jobId, closedByUserId, currentTime = new Date() },
    options = {}
  ) {
    const closedAt = this.normalizeCurrentTime(currentTime);

    const closedBy = this.normalizeObjectId(closedByUserId, "closed-by user ID");

    return this.runWithOptionalTransaction(options, async (session) => {
      let job = await JobService.getSystemJob(jobId, session);

      if (job.recruitmentStatus === "closed" && job.closeReason === "filled") {
        return {
          job,
          finalized: false,
          idempotent: true,
          events: [],
        };
      }

      const capacity = await JobApplicationService.getHiringCapacity(job, session);

      if (capacity.hiredCount !== capacity.vacancyCount) {
        throw this.createError({
          message: "Job cannot be finalized as filled until every vacancy is hired.",
          code: "JOB_NOT_FULLY_HIRED",
          statusCode: 409,
          details: capacity,
        });
      }

      const events = [];

      let publicationResult = null;

      if (LIVE_PUBLICATION_STATUSES.includes(job.publicationStatus)) {
        if (!job.currentPublication) {
          throw this.createError({
            message: "Filled Job with active publication is missing currentPublication.",
            code: "JOB_CURRENT_PUBLICATION_REQUIRED",
            statusCode: 500,
          });
        }

        const publication = await this.getPublication(job.currentPublication, session);

        if (closedAt >= new Date(publication.expiresAt)) {
          publicationResult = await this.expirePublicationInternal({
            publication,
            job,
            expiredAt: closedAt,
            session,
          });
        } else {
          publicationResult = await this.endPublicationInternal({
            publication,
            job,
            endedBy: closedBy,
            reason: "All Job vacancies have been filled.",
            endedAt: closedAt,
            session,
          });
        }

        job = publicationResult.job;

        events.push(...(publicationResult.events || []));
      }

      const rejectionResult = await JobApplicationService.rejectOpenApplicationsForJob(
        {
          jobId: job._id,
          reason: "position_filled",
          currentTime: closedAt,
        },
        {
          session,
        }
      );

      events.push(...(rejectionResult.events || []));

      const closeResult = await JobService.closeFilledJob(
        {
          jobId: job._id,
          closedByUserId: closedBy,
          currentTime: closedAt,
        },
        {
          session,
        }
      );

      return {
        job: closeResult.job,
        publication: publicationResult?.publication || null,
        finalized: closeResult.closed === true,
        idempotent: closeResult.idempotent === true,
        rejectedOpenApplications: rejectionResult.rejectedCount,
        events,
      };
    });
  }

  /* ─────────────────────────────── PUBLIC MARKETPLACE ─────────────────────────────── */

  static buildPublicMarketplaceFilter({
    currentTime,
    professionalType = null,
    employmentType = null,
    workplaceType = null,
    state = null,
    lga = null,
    currency = null,
    salaryPeriod = null,
    compensationType = null,
    minimumCompensation = null,
    maximumCompensation = null,
    search = null,
  }) {
    const filter = {
      status: "live",
      expiresAt: {
        $gt: currentTime,
      },
    };

    if (professionalType) {
      filter["listingSnapshot.professionalType"] = String(professionalType).trim().toLowerCase();
    }

    if (employmentType) {
      filter["listingSnapshot.employmentType"] = String(employmentType).trim().toLowerCase();
    }

    if (workplaceType) {
      filter["listingSnapshot.workplaceType"] = String(workplaceType).trim().toLowerCase();
    }

    if (state) {
      filter["listingSnapshot.state"] = new RegExp(
        `^${this.escapeRegExp(String(state).trim())}$`,
        "i"
      );
    }

    if (lga) {
      filter["listingSnapshot.lga"] = new RegExp(`^${this.escapeRegExp(String(lga).trim())}$`, "i");
    }

    const normalizedCurrency = currency ? String(currency).trim().toUpperCase() : null;

    const normalizedSalaryPeriod = salaryPeriod ? String(salaryPeriod).trim().toLowerCase() : null;

    const normalizedCompensationType = compensationType
      ? String(compensationType).trim().toLowerCase()
      : null;

    if (normalizedCurrency) {
      if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
        throw this.createError({
          message: "Marketplace currency must be a valid three-letter currency code.",
          code: "INVALID_JOB_MARKETPLACE_CURRENCY",
        });
      }

      filter["listingSnapshot.currency"] = normalizedCurrency;
    }

    if (normalizedSalaryPeriod) {
      if (!JOB_SALARY_PERIODS.includes(normalizedSalaryPeriod)) {
        throw this.createError({
          message: "Marketplace salary period is invalid.",
          code: "INVALID_JOB_MARKETPLACE_SALARY_PERIOD",
        });
      }

      filter["listingSnapshot.compensation.period"] = normalizedSalaryPeriod;
    }

    if (normalizedCompensationType) {
      if (!JOB_COMPENSATION_TYPES.includes(normalizedCompensationType)) {
        throw this.createError({
          message: "Marketplace compensation type is invalid.",
          code: "INVALID_JOB_MARKETPLACE_COMPENSATION_TYPE",
        });
      }

      filter["listingSnapshot.compensation.type"] = normalizedCompensationType;
    }

    const minComp = this.normalizeSafeAmount(minimumCompensation, "minimum compensation", false);

    const maxComp = this.normalizeSafeAmount(maximumCompensation, "maximum compensation", false);

    if ((minComp !== null || maxComp !== null) && !normalizedCurrency) {
      throw this.createError({
        message: "Currency is required when filtering Jobs by compensation amount.",
        code: "JOB_MARKETPLACE_COMPENSATION_CURRENCY_REQUIRED",
      });
    }

    if ((minComp !== null || maxComp !== null) && !normalizedSalaryPeriod) {
      throw this.createError({
        message: "Salary period is required when filtering Jobs by compensation amount.",
        code: "JOB_MARKETPLACE_COMPENSATION_PERIOD_REQUIRED",
      });
    }

    if (minComp !== null) {
      filter["listingSnapshot.compensation.maximumAmount"] = {
        $gte: minComp,
      };
    }

    if (maxComp !== null) {
      filter["listingSnapshot.compensation.minimumAmount"] = {
        $lte: maxComp,
      };
    }

    if (minComp !== null && maxComp !== null && maxComp < minComp) {
      throw this.createError({
        message: "maximum compensation cannot be lower than minimum compensation.",
        code: "INVALID_JOB_MARKETPLACE_COMPENSATION_RANGE",
      });
    }

    const normalizedSearch = String(search || "")
      .trim()
      .slice(0, 150);

    if (normalizedSearch) {
      const pattern = new RegExp(this.escapeRegExp(normalizedSearch), "i");

      filter.$or = [
        {
          "listingSnapshot.roleTitle": pattern,
        },
        {
          "listingSnapshot.specialty": pattern,
        },
        {
          "listingSnapshot.department": pattern,
        },
        {
          "listingSnapshot.summary": pattern,
        },
        {
          "employerSnapshot.businessName": pattern,
        },
      ];
    }

    return filter;
  }

  static sanitizePublicScreeningQuestion(question) {
    return {
      questionId: question.questionId,
      prompt: question.prompt,
      type: question.type,
      isResponseRequired: question.isResponseRequired === true,
      options: Array.isArray(question.options) ? [...question.options] : [],
    };
  }

  static decoratePublicPublication(publication, currentTime) {
    const deadline = publication.applicationDeadline
      ? new Date(publication.applicationDeadline)
      : null;

    const listingSnapshot = publication.listingSnapshot || {};

    /*
     * googlePlaceId and exact GeoJSON coordinates are retained in the immutable
     * publication snapshot for internal use but are not part of public Job data.
     */
    const {
      googlePlaceId: _googlePlaceId,
      location: _location,
      ...publicListingSnapshot
    } = listingSnapshot;

    return {
      _id: publication._id,
      referenceCode: publication.referenceCode,
      job: publication.job,
      employerSnapshot: publication.employerSnapshot,
      listingSnapshot: {
        ...publicListingSnapshot,
        screeningQuestions: Array.isArray(listingSnapshot.screeningQuestions)
          ? listingSnapshot.screeningQuestions.map((question) =>
              this.sanitizePublicScreeningQuestion(question)
            )
          : [],
      },
      status: publication.status,
      publishedAt: publication.publishedAt,
      expiresAt: publication.expiresAt,
      applicationDeadline: publication.applicationDeadline || null,
      acceptingApplications:
        publication.status === "live" &&
        new Date(publication.expiresAt) > currentTime &&
        (!deadline || deadline >= currentTime),
    };
  }

  static async getPublicListings({
    professionalType = null,
    employmentType = null,
    workplaceType = null,
    state = null,
    lga = null,
    currency = null,
    salaryPeriod = null,
    compensationType = null,
    minimumCompensation = null,
    maximumCompensation = null,
    search = null,
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
    currentTime = new Date(),
  } = {}) {
    const now = this.normalizeCurrentTime(currentTime);

    const normalizedPage = this.normalizePage(page);

    const normalizedLimit = this.normalizeLimit(limit);

    const filter = this.buildPublicMarketplaceFilter({
      currentTime: now,
      professionalType,
      employmentType,
      workplaceType,
      state,
      lga,
      currency,
      salaryPeriod,
      compensationType,
      minimumCompensation,
      maximumCompensation,
      search,
    });

    const pipeline = [
      {
        $match: filter,
      },
      {
        $lookup: {
          from: Job.collection.name,
          localField: "job",
          foreignField: "_id",
          as: "jobRecord",
        },
      },
      {
        $unwind: "$jobRecord",
      },
      {
        $match: {
          "jobRecord.recruitmentStatus": "active",
          "jobRecord.publicationStatus": "live",
          $expr: {
            $eq: ["$jobRecord.currentPublication", "$_id"],
          },
        },
      },
      {
        $sort: {
          publishedAt: -1,
          _id: -1,
        },
      },
      {
        $facet: {
          items: [
            {
              $skip: (normalizedPage - 1) * normalizedLimit,
            },
            {
              $limit: normalizedLimit,
            },
            {
              $project: {
                jobRecord: 0,
              },
            },
          ],
          meta: [
            {
              $count: "total",
            },
          ],
        },
      },
    ];

    const [result] = await JobPublication.aggregate(pipeline);

    const items = (result?.items || []).map((item) => this.decoratePublicPublication(item, now));

    const total = Number(result?.meta?.[0]?.total || 0);

    return {
      items,
      page: normalizedPage,
      limit: normalizedLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
    };
  }

  static async getPublicListing({ publicationId, currentTime = new Date() }) {
    const now = this.normalizeCurrentTime(currentTime);

    const id = this.normalizeObjectId(publicationId, "Job publication ID");

    const publication = await JobPublication.findOne({
      _id: id,
      status: "live",
      expiresAt: {
        $gt: now,
      },
    }).lean();

    if (!publication) {
      throw this.createError({
        message: "Published Job listing was not found.",
        code: "PUBLIC_JOB_LISTING_NOT_FOUND",
        statusCode: 404,
      });
    }

    const job = await Job.findOne({
      _id: publication.job,
      recruitmentStatus: "active",
      publicationStatus: "live",
      currentPublication: publication._id,
    })
      .select("_id referenceCode")
      .lean();

    if (!job) {
      throw this.createError({
        message: "Published Job listing was not found.",
        code: "PUBLIC_JOB_LISTING_NOT_FOUND",
        statusCode: 404,
      });
    }

    return this.decoratePublicPublication(publication, now);
  }
}

module.exports = JobPublicationService;
