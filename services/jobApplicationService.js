// services/jobApplicationService.js

const Job = require("../models/Job");
const JobPublication = require("../models/JobPublication");
const JobApplication = require("../models/JobApplication");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const ProfessionalResume = require("../models/ProfessionalResume");
const User = require("../models/User");

const JobService = require("./jobService");

const {
  JOB_APPLICATION_STATUSES,
  JOB_APPLICATION_ALLOWED_TRANSITIONS,
  JOB_APPLICATION_SCREENING_OUTCOMES,
  JOB_APPLICATION_REJECTION_REASONS,
  JOB_APPLICATION_WITHDRAWAL_REASONS,
  JOB_APPLICATION_ACTOR_ROLES,
  MAX_JOB_APPLICATION_NOTE_LENGTH,
  MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH,
  MAX_JOB_APPLICATION_REASON_LENGTH,
  MAX_SCREENING_TEXT_ANSWER_LENGTH,
} = require("../constants/jobApplication");

const { createServiceError } = require("./helpers/serviceErrorHelper");
const { normalizeObjectId, normalizeOptionalText } = require("./helpers/serviceValidationHelpers");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const { generateReference } = require("../utils/reference");
const logger = require("../utils/logger");

const ERROR_NAME = "JobApplicationServiceError";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const PIPELINE_STATUSES = ["submitted", "under_review", "shortlisted", "interview", "offered"];

const TERMINAL_STATUSES = ["hired", "rejected", "withdrawn"];

const EMPLOYER_PIPELINE_TARGETS = ["under_review", "shortlisted", "interview", "offered"];

const RESUME_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MAX_RESUME_LABEL_LENGTH = 120;

/**
 * Permanent Job application authority.
 *
 * Owns submission, applicant snapshots, screening evaluation, pipeline
 * transitions, withdrawal/rejection/hiring audits, summaries and hiring
 * capacity.
 *
 * JobPublication lifecycle and Appointment lifecycle remain outside
 * this service.
 */
class JobApplicationService {
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
        code: "JOB_APPLICATION_TRANSACTION_REQUIRED",
        statusCode: 500,
      });
    }

    return runWithOptionalTransaction(options, callback);
  }

  static withSession(query, session) {
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
      createError: JobApplicationService.createError,
    });
  }

  static normalizeOptionalText(value, fieldName, maximumLength) {
    return normalizeOptionalText({
      value,
      fieldName,
      maximumLength,
      createError: JobApplicationService.createError,
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

  static normalizeStatus(value, required = true) {
    const status = String(value || "")
      .trim()
      .toLowerCase();

    if (!status && !required) {
      return null;
    }

    if (!status || !JOB_APPLICATION_STATUSES.includes(status)) {
      throw this.createError({
        message: "Job application status is invalid.",
        code: "INVALID_JOB_APPLICATION_STATUS",
      });
    }

    return status;
  }

  static normalizeActorRole(value) {
    const role = String(value || "")
      .trim()
      .toLowerCase();

    if (!JOB_APPLICATION_ACTOR_ROLES.includes(role)) {
      throw this.createError({
        message: "Job application actor role is invalid.",
        code: "INVALID_JOB_APPLICATION_ACTOR_ROLE",
      });
    }

    return role;
  }

  static normalizeReason(value, allowed, label, code) {
    const reason = String(value || "")
      .trim()
      .toLowerCase();

    if (!allowed.includes(reason)) {
      throw this.createError({
        message: `${label} is invalid.`,
        code,
      });
    }

    return reason;
  }

  static normalizeReasonDetails(value, reason, label) {
    const details = this.normalizeOptionalText(value, label, MAX_JOB_APPLICATION_REASON_LENGTH);

    if (reason === "other" && !details) {
      throw this.createError({
        message: `${label} are required when the reason is other.`,
        code: "JOB_APPLICATION_REASON_DETAILS_REQUIRED",
      });
    }

    return reason === "other" ? details : null;
  }

  static normalizePage(value) {
    const page = Number(value || 1);

    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  }

  static normalizeLimit(value) {
    const limit = Number(value || DEFAULT_PAGE_SIZE);

    return Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
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

  static async getJob(jobId, session = null) {
    const job = await this.withSession(
      Job.findById(this.normalizeObjectId(jobId, "Job ID")),
      session
    );

    if (!job) {
      throw this.createError({
        message: "Job was not found.",
        code: "JOB_NOT_FOUND",
        statusCode: 404,
      });
    }

    return job;
  }

  static async getProfessional(professionalProfileId, session = null) {
    const professional = await this.withSession(
      ProfessionalProfile.findById(
        this.normalizeObjectId(professionalProfileId, "professional profile ID")
      ).select(
        "user type phoneCode phone specialty bio yearsOfExperience state lga " +
          "licenceNumber licenceIssuingBody licenceVerificationStatus licenceExpiryDate " +
          "identityVerificationStatus certifications professionalApprovalStatus accountStatus"
      ),
      session
    );

    if (!professional) {
      throw this.createError({
        message: "Professional profile was not found.",
        code: "PROFESSIONAL_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return professional;
  }

  static async getUser(userId, session = null) {
    const user = await this.withSession(
      User.findById(this.normalizeObjectId(userId, "user ID")).select(
        "firstName lastName displayName email photo"
      ),
      session
    );

    if (!user) {
      throw this.createError({
        message: "User account was not found.",
        code: "USER_NOT_FOUND",
        statusCode: 404,
      });
    }

    return user;
  }

  static async getProfessionalResume({ resumeId, professionalProfileId, session = null }) {
    const resume = await this.withSession(
      ProfessionalResume.findOne({
        _id: this.normalizeObjectId(resumeId, "professional resume ID"),
        professional: this.normalizeObjectId(professionalProfileId, "professional profile ID"),
        status: "active",
      }).select("+fileUrl"),
      session
    );

    if (!resume) {
      throw this.createError({
        message: "Professional resume was not found or is not available to you.",
        code: "PROFESSIONAL_RESUME_NOT_FOUND",
        statusCode: 404,
      });
    }

    return resume;
  }

  static async getDefaultProfessionalResume(professionalProfileId, session = null) {
    return this.withSession(
      ProfessionalResume.findOne({
        professional: this.normalizeObjectId(professionalProfileId, "professional profile ID"),
        status: "active",
        isDefault: true,
      }).select("+fileUrl"),
      session
    );
  }

  static async getApplication(applicationId, session = null) {
    const application = await this.withSession(
      JobApplication.findById(this.normalizeObjectId(applicationId, "Job application ID")),
      session
    );

    if (!application) {
      throw this.createError({
        message: "Job application was not found.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return application;
  }

  static async getProfessionalApplication({
    applicationId,
    professionalProfileId,
    session = null,
  }) {
    const application = await this.withSession(
      JobApplication.findOne({
        _id: this.normalizeObjectId(applicationId, "Job application ID"),
        professional: this.normalizeObjectId(professionalProfileId, "professional profile ID"),
      }),
      session
    );

    if (!application) {
      throw this.createError({
        message: "Job application was not found or is not available to you.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    return application;
  }

  static async getEmployerApplication({
    applicationId,
    employerProfileId,
    employerContext = null,
    session = null,
  }) {
    const application = await this.getApplication(applicationId, session);

    const job = await JobService.getEmployerJob({
      jobId: application.job,
      employerProfileId,
      employerContext,
      session,
    });

    if (
      String(application.business) !== String(job.business) ||
      String(application.branch) !== String(job.branch)
    ) {
      throw this.createError({
        message: "Job application ownership does not match its Job.",
        code: "JOB_APPLICATION_OWNERSHIP_MISMATCH",
        statusCode: 500,
      });
    }

    return {
      application,
      job,
    };
  }

  /* ─────────────────────────────── ELIGIBILITY ─────────────────────────────── */

  static assertPublicationAcceptsApplications({ publication, job, currentTime }) {
    if (publication.status !== "live") {
      throw this.createError({
        message: "This Job publication is not currently accepting applications.",
        code: "JOB_PUBLICATION_NOT_ACCEPTING_APPLICATIONS",
        statusCode: 409,
      });
    }

    if (job.recruitmentStatus !== "active" || job.publicationStatus !== "live") {
      throw this.createError({
        message: "This Job is not currently accepting applications.",
        code: "JOB_NOT_ACCEPTING_APPLICATIONS",
        statusCode: 409,
      });
    }

    if (!job.currentPublication || String(job.currentPublication) !== String(publication._id)) {
      throw this.createError({
        message: "This is no longer the current Job publication.",
        code: "STALE_JOB_PUBLICATION",
        statusCode: 409,
      });
    }

    if (
      String(publication.job) !== String(job._id) ||
      String(publication.business) !== String(job.business) ||
      String(publication.branch) !== String(job.branch)
    ) {
      throw this.createError({
        message: "Job publication ownership is inconsistent.",
        code: "JOB_PUBLICATION_OWNERSHIP_MISMATCH",
        statusCode: 500,
      });
    }

    const expiresAt = new Date(publication.expiresAt);

    if (Number.isNaN(expiresAt.getTime()) || currentTime >= expiresAt) {
      throw this.createError({
        message: "This Job publication has expired.",
        code: "JOB_PUBLICATION_EXPIRED",
        statusCode: 409,
      });
    }

    if (publication.applicationDeadline) {
      const deadline = new Date(publication.applicationDeadline);

      if (Number.isNaN(deadline.getTime()) || currentTime > deadline) {
        throw this.createError({
          message: "The application deadline for this Job has passed.",
          code: "JOB_APPLICATION_DEADLINE_PASSED",
          statusCode: 409,
        });
      }
    }
  }

  static assertProfessionalEligible({ professional, user, publication, currentTime }) {
    if (String(professional.user) !== String(user._id)) {
      throw this.createError({
        message: "Professional profile ownership does not match the submitting user.",
        code: "PROFESSIONAL_USER_MISMATCH",
        statusCode: 403,
      });
    }

    if (
      publication.listingSnapshot?.professionalType &&
      professional.type !== publication.listingSnapshot.professionalType
    ) {
      throw this.createError({
        message: "Your professional type does not match this Job.",
        code: "JOB_PROFESSIONAL_TYPE_MISMATCH",
        statusCode: 403,
      });
    }

    if (professional.professionalApprovalStatus !== "approved") {
      throw this.createError({
        message: "Your professional profile must be approved before applying for Jobs.",
        code: "PROFESSIONAL_NOT_APPROVED_FOR_JOBS",
        statusCode: 403,
      });
    }

    if (professional.accountStatus !== "active") {
      throw this.createError({
        message: "Your professional account is not active.",
        code: "PROFESSIONAL_ACCOUNT_NOT_ACTIVE",
        statusCode: 403,
      });
    }

    if (professional.licenceVerificationStatus !== "verified") {
      throw this.createError({
        message: "Your professional licence must be verified before applying for Jobs.",
        code: "PROFESSIONAL_LICENCE_NOT_VERIFIED",
        statusCode: 403,
      });
    }

    if (professional.licenceExpiryDate && new Date(professional.licenceExpiryDate) <= currentTime) {
      throw this.createError({
        message: "Your professional licence has expired.",
        code: "PROFESSIONAL_LICENCE_EXPIRED",
        statusCode: 403,
      });
    }

    if (professional.identityVerificationStatus !== "verified") {
      throw this.createError({
        message: "Your identity must be verified before applying for Jobs.",
        code: "PROFESSIONAL_IDENTITY_NOT_VERIFIED",
        statusCode: 403,
      });
    }

    /*
     * Permanent-job applications deliberately do not inherit
     * Shift availabilityStatus rules.
     */
  }

  static async getHiringCapacity(job, session = null) {
    const vacancyCount = Number(job.vacancyCount || 0);

    if (!Number.isSafeInteger(vacancyCount) || vacancyCount < 1) {
      throw this.createError({
        message: "Job vacancyCount is invalid.",
        code: "INVALID_JOB_VACANCY_COUNT",
        statusCode: 500,
      });
    }

    const hiredCount = await this.withSession(
      JobApplication.countDocuments({
        job: job._id,
        status: "hired",
      }),
      session
    );

    return {
      hiredCount,
      vacancyCount,
    };
  }

  static async assertVacancyStillOpen(job, session = null) {
    const capacity = await this.getHiringCapacity(job, session);

    if (capacity.hiredCount >= capacity.vacancyCount) {
      throw this.createError({
        message: "This Job has already filled all available vacancies.",
        code: "JOB_VACANCY_CAPACITY_FILLED",
        statusCode: 409,
        details: capacity,
      });
    }

    return capacity;
  }

  /* ─────────────────────────────── SNAPSHOTS ─────────────────────────────── */

  static normalizeCertification(certification) {
    if (!certification) {
      return null;
    }

    if (typeof certification === "string") {
      const name = certification.trim();

      return name
        ? {
            name,
            issuingBody: null,
            dateObtained: null,
            expiryDate: null,
            verified: false,
          }
        : null;
    }

    if (typeof certification !== "object" || Array.isArray(certification)) {
      return null;
    }

    const name = String(certification.name || "").trim();

    if (!name) {
      return null;
    }

    return {
      name,

      issuingBody: String(certification.issuingBody || "").trim() || null,

      dateObtained: certification.dateObtained || null,

      expiryDate: certification.expiryDate || null,

      verified: certification.verified === true,
    };
  }

  static buildCandidateSnapshot({ professional, user, capturedAt }) {
    const firstName = String(user.firstName || "").trim();

    const lastName = String(user.lastName || "").trim();

    const displayName =
      String(user.displayName || "").trim() ||
      [firstName, lastName].filter(Boolean).join(" ") ||
      String(user.email || "").trim();

    return {
      firstName,

      lastName,

      displayName,

      photo: String(user.photo || "").trim() || null,

      email: String(user.email || "")
        .trim()
        .toLowerCase(),

      phoneCode: String(professional.phoneCode || "").trim() || null,

      phone: String(professional.phone || "").trim() || null,

      professionalType: professional.type,

      specialty: professional.specialty || null,

      bio: String(professional.bio || "").trim() || null,

      yearsOfExperience:
        professional.yearsOfExperience === null || professional.yearsOfExperience === undefined
          ? null
          : Number(professional.yearsOfExperience),

      state: professional.state || null,

      lga: professional.lga || null,

      licenceNumber: professional.licenceNumber || null,

      licenceIssuingBody: professional.licenceIssuingBody || null,

      licenceVerificationStatus: professional.licenceVerificationStatus || null,

      licenceExpiryDate: professional.licenceExpiryDate || null,

      identityVerificationStatus: professional.identityVerificationStatus || null,

      certifications: Array.isArray(professional.certifications)
        ? professional.certifications
            .map((item) => this.normalizeCertification(item))
            .filter(Boolean)
        : [],

      capturedAt,
    };
  }

  static normalizeResumeLabel(value, fallbackFileName = "CV") {
    const fallback = String(fallbackFileName || "CV")
      .trim()
      .replace(/\.[^.]+$/, "")
      .slice(0, MAX_RESUME_LABEL_LENGTH);

    const label = String(value || "")
      .trim()
      .slice(0, MAX_RESUME_LABEL_LENGTH);

    return label || fallback || "CV";
  }

  static normalizeResume(resume, capturedAt, metadata = {}) {
    if (resume === null || resume === undefined || resume === "") {
      return undefined;
    }

    if (typeof resume !== "object" || Array.isArray(resume)) {
      throw this.createError({
        message: "Resume must be a valid document snapshot.",
        code: "INVALID_JOB_APPLICATION_RESUME",
      });
    }

    const documentUrl = String(resume.documentUrl || resume.fileUrl || "").trim();

    const fileName = String(resume.fileName || "").trim();

    const mimeType = String(resume.mimeType || "")
      .trim()
      .toLowerCase();

    const sizeBytes = Number(
      resume.sizeBytes === null || resume.sizeBytes === undefined
        ? resume.fileSizeBytes
        : resume.sizeBytes
    );

    if (!documentUrl || !fileName || !mimeType) {
      throw this.createError({
        message: "Resume documentUrl, fileName and mimeType are required.",
        code: "INCOMPLETE_JOB_APPLICATION_RESUME",
      });
    }

    if (!RESUME_MIME_TYPES.includes(mimeType)) {
      throw this.createError({
        message: "Resume must be a PDF, DOC or DOCX file.",
        code: "UNSUPPORTED_JOB_APPLICATION_RESUME_TYPE",
      });
    }

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      throw this.createError({
        message: "Resume sizeBytes must be a positive whole number.",
        code: "INVALID_JOB_APPLICATION_RESUME_SIZE",
      });
    }

    const snapshot = {
      documentUrl,
      fileName,
      mimeType,
      sizeBytes,
      capturedAt,
    };

    if (metadata.source) {
      snapshot.source = metadata.source;
    }

    if (metadata.professionalResumeId) {
      snapshot.professionalResume = this.normalizeObjectId(
        metadata.professionalResumeId,
        "professional resume ID"
      );
    }

    return snapshot;
  }

  static buildResumeSnapshotFromProfessionalResume(resume, capturedAt) {
    if (!resume) {
      return undefined;
    }

    return this.normalizeResume(
      {
        documentUrl: resume.fileUrl,
        fileName: resume.fileName,
        mimeType: resume.mimeType,
        sizeBytes: resume.fileSizeBytes,
      },
      capturedAt,
      {
        source: "profile_resume",
        professionalResumeId: resume._id,
      }
    );
  }

  static async setDefaultProfessionalResume(resume, professionalProfileId, session = null) {
    if (!resume?._id) {
      throw this.createError({
        message: "Professional resume is required before it can be set as default.",
        code: "PROFESSIONAL_RESUME_REQUIRED",
        statusCode: 500,
      });
    }

    const professionalId = this.normalizeObjectId(professionalProfileId, "professional profile ID");

    await ProfessionalResume.updateMany(
      {
        professional: professionalId,
        status: "active",
        isDefault: true,
        _id: {
          $ne: resume._id,
        },
      },
      {
        $set: {
          isDefault: false,
        },
      },
      {
        session,
      }
    );

    if (resume.isDefault !== true) {
      resume.isDefault = true;

      await resume.save({
        session,
      });
    }

    return resume;
  }

  static async saveUploadedResumeToProfile({
    professionalProfileId,
    uploadedResume,
    label = null,
    makeDefault = false,
    session = null,
  }) {
    const professionalId = this.normalizeObjectId(professionalProfileId, "professional profile ID");

    const normalized = this.normalizeResume(uploadedResume, new Date());

    if (makeDefault) {
      await ProfessionalResume.updateMany(
        {
          professional: professionalId,
          status: "active",
          isDefault: true,
        },
        {
          $set: {
            isDefault: false,
          },
        },
        {
          session,
        }
      );
    }

    let savedResume;

    try {
      [savedResume] = await ProfessionalResume.create(
        [
          {
            professional: professionalId,
            label: this.normalizeResumeLabel(label, normalized.fileName),
            fileName: normalized.fileName,
            mimeType: normalized.mimeType,
            fileSizeBytes: normalized.sizeBytes,
            fileUrl: normalized.documentUrl,
            source: "application_upload",
            isDefault: makeDefault === true,
            status: "active",
          },
        ],
        {
          session,
        }
      );
    } catch (error) {
      if (error?.code === 11000 && makeDefault) {
        throw this.createError({
          message:
            "Your default resume changed while this application was being submitted. Please try again.",
          code: "PROFESSIONAL_DEFAULT_RESUME_CONFLICT",
          statusCode: 409,
        });
      }

      throw error;
    }

    return savedResume;
  }

  static async resolveResumeForApplication({
    professionalProfileId,
    resumeId = null,
    resume = null,
    saveResumeToProfile = false,
    saveResumeAsDefault = false,
    resumeLabel = null,
    capturedAt,
    session = null,
  }) {
    const hasResumeId = resumeId !== null && resumeId !== undefined && resumeId !== "";

    const hasUploadedResume = resume !== null && resume !== undefined && resume !== "";

    if (hasResumeId && hasUploadedResume) {
      throw this.createError({
        message: "Choose an existing resume or upload a new resume, not both.",
        code: "MULTIPLE_JOB_APPLICATION_RESUME_SOURCES",
        statusCode: 422,
      });
    }

    if (saveResumeAsDefault === true && !hasResumeId && !hasUploadedResume) {
      throw this.createError({
        message: "A resume must be selected or uploaded before it can be set as default.",
        code: "JOB_APPLICATION_RESUME_REQUIRED_FOR_DEFAULT",
        statusCode: 422,
      });
    }

    if (saveResumeToProfile === true && !hasUploadedResume && !hasResumeId) {
      throw this.createError({
        message: "Only a newly uploaded resume can be saved to your profile from this application.",
        code: "JOB_APPLICATION_RESUME_UPLOAD_REQUIRED_FOR_PROFILE_SAVE",
        statusCode: 422,
      });
    }

    if (hasResumeId) {
      const selectedResume = await this.getProfessionalResume({
        resumeId,
        professionalProfileId,
        session,
      });

      if (saveResumeAsDefault === true) {
        await this.setDefaultProfessionalResume(selectedResume, professionalProfileId, session);
      }

      return {
        resumeSnapshot: this.buildResumeSnapshotFromProfessionalResume(selectedResume, capturedAt),

        professionalResume: selectedResume,

        source: "profile_resume",

        savedToProfile: true,
      };
    }

    if (hasUploadedResume) {
      const uploadedSnapshot = this.normalizeResume(resume, capturedAt, {
        source: "application_upload",
      });

      const shouldSaveToProfile = saveResumeToProfile === true || saveResumeAsDefault === true;

      let savedResume = null;

      if (shouldSaveToProfile) {
        savedResume = await this.saveUploadedResumeToProfile({
          professionalProfileId,
          uploadedResume: resume,
          label: resumeLabel,
          makeDefault: saveResumeAsDefault === true,
          session,
        });

        uploadedSnapshot.professionalResume = savedResume._id;
      }

      return {
        resumeSnapshot: uploadedSnapshot,

        professionalResume: savedResume,

        source: "application_upload",

        savedToProfile: Boolean(savedResume),
      };
    }

    const defaultResume = await this.getDefaultProfessionalResume(professionalProfileId, session);

    if (!defaultResume) {
      throw this.createError({
        message: "A CV is required to apply for this Job.",
        code: "JOB_APPLICATION_RESUME_REQUIRED",
        statusCode: 422,
      });
    }

    return {
      resumeSnapshot: this.buildResumeSnapshotFromProfessionalResume(defaultResume, capturedAt),

      professionalResume: defaultResume,

      source: "profile_resume",

      savedToProfile: true,
    };
  }

  /* ─────────────────────────────── SCREENING ─────────────────────────────── */

  static buildRawAnswerMap(rawAnswers) {
    if (rawAnswers === null || rawAnswers === undefined || rawAnswers === "") {
      return new Map();
    }

    if (!Array.isArray(rawAnswers)) {
      throw this.createError({
        message: "Screening answers must be an array.",
        code: "INVALID_JOB_SCREENING_ANSWERS",
      });
    }

    const map = new Map();

    for (const answer of rawAnswers) {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
        throw this.createError({
          message: "Each screening answer must be an object.",
          code: "INVALID_JOB_SCREENING_ANSWER",
        });
      }

      const key = String(this.normalizeObjectId(answer.questionId, "screening question ID"));

      if (map.has(key)) {
        throw this.createError({
          message: "A screening question cannot be answered more than once.",
          code: "DUPLICATE_JOB_SCREENING_ANSWER",
        });
      }

      map.set(key, answer);
    }

    return map;
  }

  static normalizeSelectedOptions(value) {
    if (value === null || value === undefined || value === "") {
      return [];
    }

    if (!Array.isArray(value)) {
      throw this.createError({
        message: "Selected screening options must be an array.",
        code: "INVALID_JOB_SCREENING_SELECTED_OPTIONS",
      });
    }

    const options = value.map((item) => String(item || "").trim());

    if (options.some((item) => !item) || new Set(options).size !== options.length) {
      throw this.createError({
        message: "Selected screening options must be unique, non-empty values.",
        code: "INVALID_JOB_SCREENING_SELECTED_OPTIONS",
      });
    }

    return options;
  }

  static evaluateCriterion(question, answer, answered) {
    if (!answered || question.requirementLevel === "informational") {
      return null;
    }

    if (question.type === "yes_no") {
      return answer.booleanAnswer === question.qualifyingBoolean;
    }

    if (question.type === "number") {
      if (question.minimumNumber != null && answer.numberAnswer < question.minimumNumber) {
        return false;
      }

      if (question.maximumNumber != null && answer.numberAnswer > question.maximumNumber) {
        return false;
      }

      return true;
    }

    if (question.type === "single_select") {
      return (question.acceptableOptions || []).includes(answer.selectedOptions[0]);
    }

    if (question.type === "multi_select") {
      const selected = new Set(answer.selectedOptions);

      const acceptable = Array.isArray(question.acceptableOptions)
        ? question.acceptableOptions
        : [];

      return question.requireAllOptions
        ? acceptable.every((option) => selected.has(option))
        : acceptable.some((option) => selected.has(option));
    }

    /*
     * short_text is reviewable but intentionally
     * not auto-scored.
     */
    return null;
  }

  static normalizeScreeningAnswer(question, rawAnswer) {
    const answer = {
      questionId: question.questionId,

      promptSnapshot: question.prompt,

      questionType: question.type,

      requirementLevel: question.requirementLevel,

      responseRequired: question.isResponseRequired === true,

      booleanAnswer: null,

      numberAnswer: null,

      selectedOptions: [],

      textAnswer: null,

      criterionMet: null,
    };

    let answered = false;

    if (rawAnswer && question.type === "yes_no" && typeof rawAnswer.booleanAnswer === "boolean") {
      answer.booleanAnswer = rawAnswer.booleanAnswer;

      answered = true;
    } else if (
      rawAnswer &&
      question.type === "number" &&
      rawAnswer.numberAnswer !== null &&
      rawAnswer.numberAnswer !== undefined &&
      rawAnswer.numberAnswer !== ""
    ) {
      const value = Number(rawAnswer.numberAnswer);

      if (!Number.isFinite(value)) {
        throw this.createError({
          message: `A numeric answer is required for: ${question.prompt}`,
          code: "INVALID_JOB_SCREENING_NUMBER_ANSWER",
        });
      }

      answer.numberAnswer = value;

      answered = true;
    } else if (rawAnswer && ["single_select", "multi_select"].includes(question.type)) {
      const selected = this.normalizeSelectedOptions(rawAnswer.selectedOptions);

      const validOptions = Array.isArray(question.options) ? question.options : [];

      if (question.type === "single_select" && selected.length > 1) {
        throw this.createError({
          message: `Select only one answer for: ${question.prompt}`,
          code: "MULTIPLE_JOB_SCREENING_SINGLE_SELECT_ANSWERS",
        });
      }

      if (selected.some((option) => !validOptions.includes(option))) {
        throw this.createError({
          message: `An invalid option was submitted for: ${question.prompt}`,
          code: "INVALID_JOB_SCREENING_OPTION",
        });
      }

      answer.selectedOptions = selected;

      answered = selected.length > 0;
    } else if (rawAnswer && question.type === "short_text") {
      answer.textAnswer = this.normalizeOptionalText(
        rawAnswer.textAnswer,
        "Screening text answer",
        MAX_SCREENING_TEXT_ANSWER_LENGTH
      );

      answered = Boolean(answer.textAnswer);
    } else if (
      !["yes_no", "number", "single_select", "multi_select", "short_text"].includes(question.type)
    ) {
      throw this.createError({
        message: "Published screening question type is unsupported.",
        code: "UNSUPPORTED_JOB_SCREENING_QUESTION_TYPE",
        statusCode: 500,
      });
    }

    if (question.isResponseRequired === true && !answered) {
      throw this.createError({
        message: `A response is required for: ${question.prompt}`,
        code: "JOB_SCREENING_RESPONSE_REQUIRED",
        statusCode: 422,
        details: {
          questionId: String(question.questionId),
        },
      });
    }

    answer.criterionMet = this.evaluateCriterion(question, answer, answered);

    return answer;
  }

  static buildScreeningSnapshot(publication, rawAnswers, evaluatedAt) {
    const questions = Array.isArray(publication.listingSnapshot?.screeningQuestions)
      ? publication.listingSnapshot.screeningQuestions
      : [];

    const rawMap = this.buildRawAnswerMap(rawAnswers);

    const knownIds = new Set(questions.map((question) => String(question.questionId)));

    for (const questionId of rawMap.keys()) {
      if (!knownIds.has(questionId)) {
        throw this.createError({
          message: "A screening answer does not belong to this Job publication.",
          code: "UNKNOWN_JOB_SCREENING_QUESTION",
          statusCode: 422,
          details: {
            questionId,
          },
        });
      }
    }

    const screeningAnswers = questions.map((question) =>
      this.normalizeScreeningAnswer(question, rawMap.get(String(question.questionId)) || null)
    );

    const required = screeningAnswers.filter((answer) => answer.requirementLevel === "required");

    const preferred = screeningAnswers.filter((answer) => answer.requirementLevel === "preferred");

    let screeningOutcome = "not_evaluated";
    let screeningEvaluatedAt = null;

    if (questions.length > 0) {
      if (required.some((answer) => answer.criterionMet === false)) {
        screeningOutcome = "does_not_meet_required_criteria";

        screeningEvaluatedAt = evaluatedAt;
      } else if (!required.some((answer) => answer.criterionMet === null)) {
        screeningOutcome = "meets_required_criteria";

        screeningEvaluatedAt = evaluatedAt;
      }
    }

    if (!JOB_APPLICATION_SCREENING_OUTCOMES.includes(screeningOutcome)) {
      throw this.createError({
        message: "Calculated screening outcome is invalid.",
        code: "INVALID_CALCULATED_JOB_SCREENING_OUTCOME",
        statusCode: 500,
      });
    }

    return {
      screeningAnswers,

      screeningOutcome,

      screeningSummary: {
        requiredCriteriaCount: required.length,

        requiredCriteriaMetCount: required.filter((answer) => answer.criterionMet === true).length,

        preferredCriteriaCount: preferred.length,

        preferredCriteriaMetCount: preferred.filter((answer) => answer.criterionMet === true)
          .length,

        evaluatedAt: screeningEvaluatedAt,
      },
    };
  }

  /* ─────────────────────────────── TRANSITIONS ─────────────────────────────── */

  static assertTransitionAllowed(application, toStatus) {
    const normalized = this.normalizeStatus(toStatus);

    const allowed = JOB_APPLICATION_ALLOWED_TRANSITIONS[application.status];

    if (!Array.isArray(allowed) || !allowed.includes(normalized)) {
      throw this.createError({
        message: `Job application cannot move from ${application.status} to ${normalized}.`,
        code: "JOB_APPLICATION_TRANSITION_NOT_ALLOWED",
        statusCode: 409,
        details: {
          fromStatus: application.status,
          toStatus: normalized,
        },
      });
    }

    return normalized;
  }

  static applyStatusTransition({
    application,
    toStatus,
    actorRole,
    changedByUserId = null,
    changedAt,
    note = null,
  }) {
    const role = this.normalizeActorRole(actorRole);

    const target = this.assertTransitionAllowed(application, toStatus);

    const changedBy =
      role === "system" ? null : this.normalizeObjectId(changedByUserId, "status-change user ID");

    const fromStatus = application.status;

    application.status = target;
    application.statusUpdatedAt = changedAt;
    application.statusUpdatedBy = changedBy;
    application.statusUpdatedByRole = role;

    application.statusHistory.push({
      fromStatus,

      toStatus: target,

      actorRole: role,

      changedBy,

      changedAt,

      note: this.normalizeOptionalText(
        note,
        "Application status note",
        MAX_JOB_APPLICATION_NOTE_LENGTH
      ),
    });

    return changedBy;
  }

  static applyEmployerReview({ application, userId, reviewedAt, privateNote }) {
    const reviewedBy = this.normalizeObjectId(userId, "reviewed-by user ID");

    application.lastReviewedAt = reviewedAt;
    application.lastReviewedBy = reviewedBy;

    if (privateNote !== undefined) {
      application.employerPrivateNote = this.normalizeOptionalText(
        privateNote,
        "Employer private note",
        MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH
      );
    }

    return reviewedBy;
  }

  /* ─────────────────────────────── RECONCILIATION ─────────────────────────────── */

  static async reconcileJobApplicationSummary(jobId, currentTime, session = null) {
    const id = this.normalizeObjectId(jobId, "Job ID");

    const aggregate = JobApplication.aggregate([
      {
        $match: {
          job: id,
        },
      },
      {
        $group: {
          _id: "$status",
          count: {
            $sum: 1,
          },
        },
      },
    ]);

    if (session) {
      aggregate.session(session);
    }

    const rows = await aggregate;

    const counts = Object.fromEntries(JOB_APPLICATION_STATUSES.map((status) => [status, 0]));

    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(counts, row._id)) {
        counts[row._id] = Number(row.count || 0);
      }
    }

    const job = await this.withSession(Job.findById(id), session);

    if (!job) {
      throw this.createError({
        message: "Job was not found.",
        code: "JOB_NOT_FOUND",
        statusCode: 404,
      });
    }

    job.applicationSummary = {
      total: JOB_APPLICATION_STATUSES.reduce((sum, status) => sum + counts[status], 0),

      submitted: counts.submitted,
      underReview: counts.under_review,
      shortlisted: counts.shortlisted,
      interview: counts.interview,
      offered: counts.offered,
      hired: counts.hired,
      rejected: counts.rejected,
      withdrawn: counts.withdrawn,
      lastReconciledAt: currentTime,
    };

    await job.save({
      session,
    });

    return job;
  }

  static async reconcilePublicationApplicationCount(publicationId, currentTime, session = null) {
    const id = this.normalizeObjectId(publicationId, "Job publication ID");

    const applicationCount = await this.withSession(
      JobApplication.countDocuments({
        publication: id,
      }),
      session
    );

    const publication = await JobPublication.findByIdAndUpdate(
      id,
      {
        $set: {
          applicationCount,
          applicationCountLastReconciledAt: currentTime,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session,
      }
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

  /* ─────────────────────────────── SUBMISSION ─────────────────────────────── */

  static async submitApplication(
    {
      publicationId,
      professionalProfileId,
      submittedByUserId,
      coverNote = null,
      resumeId = null,
      resume = null,
      saveResumeToProfile = false,
      saveResumeAsDefault = false,
      resumeLabel = null,
      screeningAnswers = [],
      currentTime = new Date(),
    },
    options = {}
  ) {
    const submittedAt = this.normalizeCurrentTime(currentTime);

    return this.runWithOptionalTransaction(options, async (session) => {
      const publication = await this.getPublication(publicationId, session);

      const job = await this.getJob(publication.job, session);

      this.assertPublicationAcceptsApplications({
        publication,
        job,
        currentTime: submittedAt,
      });

      await this.assertVacancyStillOpen(job, session);

      const professional = await this.getProfessional(professionalProfileId, session);

      const submittedBy = this.normalizeObjectId(submittedByUserId, "submitted-by user ID");

      const user = await this.getUser(professional.user, session);

      if (String(user._id) !== String(submittedBy)) {
        throw this.createError({
          message: "You can only submit a Job application for your own professional profile.",
          code: "JOB_APPLICATION_SUBMITTER_MISMATCH",
          statusCode: 403,
        });
      }

      this.assertProfessionalEligible({
        professional,
        user,
        publication,
        currentTime: submittedAt,
      });

      const existing = await this.withSession(
        JobApplication.findOne({
          job: job._id,
          professional: professional._id,
        }).select("_id status referenceCode"),
        session
      );

      if (existing) {
        throw this.createError({
          message: "You have already applied for this Job.",
          code: "JOB_APPLICATION_ALREADY_EXISTS",
          statusCode: 409,
          details: {
            applicationId: String(existing._id),
            status: existing.status,
          },
        });
      }

      const screening = this.buildScreeningSnapshot(publication, screeningAnswers, submittedAt);

      const resumeResolution = await this.resolveResumeForApplication({
        professionalProfileId: professional._id,
        resumeId,
        resume,
        saveResumeToProfile,
        saveResumeAsDefault,
        resumeLabel,
        capturedAt: submittedAt,
        session,
      });

      const payload = {
        referenceCode: generateReference("LQ-JAPP"),

        job: job._id,
        publication: publication._id,
        business: publication.business,
        branch: publication.branch,
        professional: professional._id,
        submittedBy,
        snapshotVersion: 1,

        candidateSnapshot: this.buildCandidateSnapshot({
          professional,
          user,
          capturedAt: submittedAt,
        }),

        resumeSnapshot: resumeResolution.resumeSnapshot,

        coverNote: this.normalizeOptionalText(
          coverNote,
          "Application cover note",
          MAX_JOB_APPLICATION_NOTE_LENGTH
        ),

        screeningAnswers: screening.screeningAnswers,

        screeningOutcome: screening.screeningOutcome,

        screeningSummary: screening.screeningSummary,

        status: "submitted",
        submittedAt,
        statusUpdatedAt: submittedAt,
        statusUpdatedBy: submittedBy,
        statusUpdatedByRole: "professional",

        statusHistory: [
          {
            fromStatus: null,
            toStatus: "submitted",
            actorRole: "professional",
            changedBy: submittedBy,
            changedAt: submittedAt,
            note: null,
          },
        ],
      };

      let application;

      try {
        [application] = await JobApplication.create([payload], {
          session,
        });
      } catch (error) {
        if (error?.code === 11000) {
          throw this.createError({
            message: "You have already applied for this Job.",
            code: "JOB_APPLICATION_ALREADY_EXISTS",
            statusCode: 409,
          });
        }

        throw error;
      }

      const reconciledJob = await this.reconcileJobApplicationSummary(
        job._id,
        submittedAt,
        session
      );

      const reconciledPublication = await this.reconcilePublicationApplicationCount(
        publication._id,
        submittedAt,
        session
      );

      logger.info(
        `Job application ${application.referenceCode} submitted for Job ${job.referenceCode}`
      );

      return {
        application,

        job: reconciledJob,

        publication: reconciledPublication,

        submitted: true,

        resume: {
          source: resumeResolution.source,

          professionalResumeId: resumeResolution.professionalResume?._id
            ? String(resumeResolution.professionalResume._id)
            : null,

          savedToProfile: resumeResolution.savedToProfile,
        },

        events: [
          {
            type: "job_application_received",

            jobId: String(job._id),

            publicationId: String(publication._id),

            applicationId: String(application._id),

            professionalId: String(professional._id),

            employerProfileId: String(job.business),
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── WITHDRAWAL ─────────────────────────────── */

  static async withdrawApplication(
    {
      applicationId,
      professionalProfileId,
      withdrawnByUserId,
      reason,
      reasonDetails = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const withdrawnAt = this.normalizeCurrentTime(currentTime);

    const withdrawalReason = this.normalizeReason(
      reason,
      JOB_APPLICATION_WITHDRAWAL_REASONS,
      "Withdrawal reason",
      "INVALID_JOB_APPLICATION_WITHDRAWAL_REASON"
    );

    const withdrawalReasonDetails = this.normalizeReasonDetails(
      reasonDetails,
      withdrawalReason,
      "Withdrawal reason details"
    );

    return this.runWithOptionalTransaction(options, async (session) => {
      const application = await this.getProfessionalApplication({
        applicationId,
        professionalProfileId,
        session,
      });

      const withdrawnBy = this.normalizeObjectId(withdrawnByUserId, "withdrawn-by user ID");

      if (String(application.submittedBy) !== String(withdrawnBy)) {
        throw this.createError({
          message: "You can only withdraw your own Job application.",
          code: "JOB_APPLICATION_WITHDRAWER_MISMATCH",
          statusCode: 403,
        });
      }

      if (!PIPELINE_STATUSES.includes(application.status)) {
        throw this.createError({
          message: "This Job application can no longer be withdrawn.",
          code: "JOB_APPLICATION_WITHDRAWAL_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      this.applyStatusTransition({
        application,
        toStatus: "withdrawn",
        actorRole: "professional",
        changedByUserId: withdrawnBy,
        changedAt: withdrawnAt,
      });

      application.withdrawnAt = withdrawnAt;

      application.withdrawnBy = withdrawnBy;

      application.withdrawalReason = withdrawalReason;

      application.withdrawalReasonDetails = withdrawalReasonDetails;

      await application.save({
        session,
      });

      const job = await this.reconcileJobApplicationSummary(application.job, withdrawnAt, session);

      return {
        application,
        job,
        withdrawn: true,

        events: [
          {
            type: "job_application_withdrawn",

            jobId: String(application.job),

            publicationId: String(application.publication),

            applicationId: String(application._id),

            professionalId: String(application.professional),

            employerProfileId: String(application.business),
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── EMPLOYER PIPELINE ─────────────────────────────── */

  static async transitionEmployerApplication(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      changedByUserId,
      toStatus,
      employerPrivateNote = undefined,
      statusNote = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const changedAt = this.normalizeCurrentTime(currentTime);

    const target = this.normalizeStatus(toStatus);

    if (!EMPLOYER_PIPELINE_TARGETS.includes(target)) {
      throw this.createError({
        message: "Use the dedicated rejection or hiring operation for this target status.",
        code: "JOB_APPLICATION_EMPLOYER_TRANSITION_REQUIRES_DEDICATED_OPERATION",
        statusCode: 409,
      });
    }

    return this.runWithOptionalTransaction(options, async (session) => {
      const { application, job } = await this.getEmployerApplication({
        applicationId,
        employerProfileId,
        employerContext,
        session,
      });

      if (job.recruitmentStatus !== "active") {
        throw this.createError({
          message: "Applications cannot be advanced after recruitment has closed.",
          code: "JOB_APPLICATION_REVIEW_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      if (application.status === target) {
        return {
          application,
          job,
          transitioned: false,
          idempotent: true,
        };
      }

      const changedBy = this.applyEmployerReview({
        application,
        userId: changedByUserId,
        reviewedAt: changedAt,
        privateNote: employerPrivateNote,
      });

      this.applyStatusTransition({
        application,
        toStatus: target,
        actorRole: "employer",
        changedByUserId: changedBy,
        changedAt,
        note: statusNote,
      });

      if (target === "offered") {
        application.offeredAt = changedAt;

        application.offeredBy = changedBy;
      }

      await application.save({
        session,
      });

      const reconciledJob = await this.reconcileJobApplicationSummary(job._id, changedAt, session);

      const eventType = {
        under_review: "job_application_under_review",

        shortlisted: "job_application_shortlisted",

        offered: "job_offer_received",
      }[target];

      return {
        application,

        job: reconciledJob,

        transitioned: true,

        idempotent: false,

        /*
         * AppointmentService emits the actual
         * interview invitation event.
         */
        events: eventType
          ? [
              {
                type: eventType,

                jobId: String(job._id),

                publicationId: String(application.publication),

                applicationId: String(application._id),

                professionalId: String(application.professional),

                employerProfileId: String(application.business),
              },
            ]
          : [],
      };
    });
  }

  static markUnderReview(payload, options = {}) {
    return this.transitionEmployerApplication(
      {
        ...payload,
        toStatus: "under_review",
      },
      options
    );
  }

  static shortlistApplication(payload, options = {}) {
    return this.transitionEmployerApplication(
      {
        ...payload,
        toStatus: "shortlisted",
      },
      options
    );
  }

  static moveApplicationToInterview(payload, options = {}) {
    return this.transitionEmployerApplication(
      {
        ...payload,
        toStatus: "interview",
      },
      options
    );
  }

  static offerApplication(payload, options = {}) {
    return this.transitionEmployerApplication(
      {
        ...payload,
        toStatus: "offered",
      },
      options
    );
  }

  /* ─────────────────────────────── REJECTION ─────────────────────────────── */

  static async rejectApplication(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      rejectedByUserId,
      reason,
      reasonDetails = null,
      employerPrivateNote = undefined,
      statusNote = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const rejectedAt = this.normalizeCurrentTime(currentTime);

    const rejectionReason = this.normalizeReason(
      reason,
      JOB_APPLICATION_REJECTION_REASONS,
      "Rejection reason",
      "INVALID_JOB_APPLICATION_REJECTION_REASON"
    );

    const rejectionReasonDetails = this.normalizeReasonDetails(
      reasonDetails,
      rejectionReason,
      "Rejection reason details"
    );

    return this.runWithOptionalTransaction(options, async (session) => {
      const { application, job } = await this.getEmployerApplication({
        applicationId,
        employerProfileId,
        employerContext,
        session,
      });

      if (application.status === "rejected") {
        return {
          application,
          job,
          rejected: false,
          idempotent: true,
        };
      }

      if (TERMINAL_STATUSES.includes(application.status)) {
        throw this.createError({
          message: "This Job application is already terminal.",
          code: "JOB_APPLICATION_REJECTION_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      const rejectedBy = this.applyEmployerReview({
        application,
        userId: rejectedByUserId,
        reviewedAt: rejectedAt,
        privateNote: employerPrivateNote,
      });

      this.applyStatusTransition({
        application,
        toStatus: "rejected",
        actorRole: "employer",
        changedByUserId: rejectedBy,
        changedAt: rejectedAt,
        note: statusNote,
      });

      application.rejectedAt = rejectedAt;

      application.rejectedBy = rejectedBy;

      application.rejectionReason = rejectionReason;

      application.rejectionReasonDetails = rejectionReasonDetails;

      await application.save({
        session,
      });

      const reconciledJob = await this.reconcileJobApplicationSummary(job._id, rejectedAt, session);

      return {
        application,

        job: reconciledJob,

        rejected: true,

        idempotent: false,

        events: [
          {
            type: "job_application_rejected",

            jobId: String(job._id),

            publicationId: String(application.publication),

            applicationId: String(application._id),

            professionalId: String(application.professional),

            employerProfileId: String(application.business),

            rejectionReason,
          },
        ],
      };
    });
  }

  /* ─────────────────────────────── SYSTEM CLOSURE ─────────────────────────────── */

  static async rejectOpenApplicationsForJob(
    { jobId, reason, excludedApplicationId = null, currentTime = new Date() },
    options = {}
  ) {
    const rejectedAt = this.normalizeCurrentTime(currentTime);

    const rejectionReason = this.normalizeReason(
      reason,
      ["position_filled", "recruitment_closed"],
      "System rejection reason",
      "INVALID_SYSTEM_JOB_APPLICATION_REJECTION_REASON"
    );

    return this.runWithOptionalTransaction(options, async (session) => {
      const job = await this.getJob(jobId, session);

      const filter = {
        job: job._id,

        status: {
          $in: PIPELINE_STATUSES,
        },
      };

      if (excludedApplicationId) {
        filter._id = {
          $ne: this.normalizeObjectId(excludedApplicationId, "excluded application ID"),
        };
      }

      const applications = await this.withSession(JobApplication.find(filter), session);

      const events = [];

      for (const application of applications) {
        this.applyStatusTransition({
          application,

          toStatus: "rejected",

          actorRole: "system",

          changedAt: rejectedAt,

          note:
            rejectionReason === "position_filled"
              ? "The position has been filled."
              : "Recruitment has been closed.",
        });

        application.rejectedAt = rejectedAt;

        application.rejectedBy = null;

        application.rejectionReason = rejectionReason;

        application.rejectionReasonDetails = null;

        await application.save({
          session,
        });

        events.push({
          type: "job_application_rejected",

          jobId: String(application.job),

          publicationId: String(application.publication),

          applicationId: String(application._id),

          professionalId: String(application.professional),

          employerProfileId: String(application.business),

          rejectionReason,
        });
      }

      const reconciledJob = await this.reconcileJobApplicationSummary(job._id, rejectedAt, session);

      return {
        job: reconciledJob,

        rejectedCount: applications.length,

        events,
      };
    });
  }

  /* ─────────────────────────────── HIRING ─────────────────────────────── */

  static async hireApplication(
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
      const { application, job: authorizedJob } = await this.getEmployerApplication({
        applicationId,
        employerProfileId,
        employerContext,
        session,
      });

      if (application.status === "hired") {
        return {
          application,
          job: authorizedJob,
          hired: false,
          idempotent: true,
        };
      }

      if (TERMINAL_STATUSES.includes(application.status)) {
        throw this.createError({
          message: "This Job application is already terminal.",
          code: "JOB_APPLICATION_HIRING_NOT_ALLOWED",
          statusCode: 409,
        });
      }

      this.assertTransitionAllowed(application, "hired");

      /*
       * All hire transactions write the same Job document
       * before capacity is evaluated. This creates a shared
       * transactional contention point for concurrent hires.
       */
      const job = await this.withSession(
        Job.findOne({
          _id: authorizedJob._id,
          recruitmentStatus: "active",
        }),
        session
      );

      if (!job) {
        throw this.createError({
          message: "Recruitment for this Job is no longer active.",
          code: "JOB_RECRUITMENT_NOT_ACTIVE",
          statusCode: 409,
        });
      }

      job.applicationSummary.lastReconciledAt = hiredAt;

      job.markModified("applicationSummary");

      await job.save({
        session,
      });

      const capacity = await this.assertVacancyStillOpen(job, session);

      const hiredBy = this.applyEmployerReview({
        application,
        userId: hiredByUserId,
        reviewedAt: hiredAt,
        privateNote: employerPrivateNote,
      });

      this.applyStatusTransition({
        application,
        toStatus: "hired",
        actorRole: "employer",
        changedByUserId: hiredBy,
        changedAt: hiredAt,
        note: statusNote,
      });

      application.hiredAt = hiredAt;
      application.hiredBy = hiredBy;

      await application.save({
        session,
      });

      const hiredCount = capacity.hiredCount + 1;

      const jobFilled = hiredCount === capacity.vacancyCount;

      let systemRejections = {
        job: null,
        rejectedCount: 0,
        events: [],
      };

      if (jobFilled) {
        systemRejections = await this.rejectOpenApplicationsForJob(
          {
            jobId: job._id,

            reason: "position_filled",

            excludedApplicationId: application._id,

            currentTime: hiredAt,
          },
          {
            session,
          }
        );
      }

      let reconciledJob = systemRejections.job;

      if (!reconciledJob) {
        reconciledJob = await this.reconcileJobApplicationSummary(job._id, hiredAt, session);
      }

      let filledClosure = null;

      let requiresPublicationFinalization = false;

      if (jobFilled) {
        if (["live", "paused"].includes(reconciledJob.publicationStatus)) {
          /*
           * JobPublicationService must end the live publication
           * before JobService may close recruitment as filled.
           */
          requiresPublicationFinalization = true;
        } else {
          filledClosure = await JobService.closeFilledJob(
            {
              jobId: reconciledJob._id,

              closedByUserId: hiredBy,

              currentTime: hiredAt,
            },
            {
              session,
            }
          );
        }
      }

      logger.info(
        `Job application ${application.referenceCode} hired for Job ${job.referenceCode}`
      );

      const events = [
        {
          type: "job_application_hired",

          jobId: String(job._id),

          publicationId: String(application.publication),

          applicationId: String(application._id),

          professionalId: String(application.professional),

          employerProfileId: String(application.business),
        },

        ...systemRejections.events,
      ];

      if (jobFilled) {
        events.push({
          type: "job_capacity_filled",

          jobId: String(job._id),

          publicationId: reconciledJob.currentPublication
            ? String(reconciledJob.currentPublication)
            : null,

          hiredCount,

          vacancyCount: capacity.vacancyCount,

          requiresPublicationFinalization,
        });
      }

      return {
        application,

        job: filledClosure?.job || reconciledJob,

        hired: true,

        idempotent: false,

        hiredCount,

        vacancyCount: capacity.vacancyCount,

        jobFilled,

        rejectedRemainingApplicationCount: systemRejections.rejectedCount,

        requiresPublicationFinalization,

        filledClosure,

        events,
      };
    });
  }

  /* ─────────────────────────────── QUERIES ─────────────────────────────── */

  static async getProfessionalApplications(
    { professionalProfileId, status = null, page = 1, limit = DEFAULT_PAGE_SIZE },
    options = {}
  ) {
    const filter = {
      professional: this.normalizeObjectId(professionalProfileId, "professional profile ID"),
    };

    const normalizedStatus = this.normalizeStatus(status, false);

    if (normalizedStatus) {
      filter.status = normalizedStatus;
    }

    const normalizedPage = this.normalizePage(page);

    const normalizedLimit = this.normalizeLimit(limit);

    const itemsQuery = JobApplication.find(filter)
      .sort({
        submittedAt: -1,
        _id: -1,
      })
      .skip((normalizedPage - 1) * normalizedLimit)
      .limit(normalizedLimit);

    const countQuery = JobApplication.countDocuments(filter);

    this.withSession(itemsQuery, options.session || null);

    this.withSession(countQuery, options.session || null);

    const items = await itemsQuery.lean();

    const total = await countQuery;

    return {
      items,

      page: normalizedPage,

      limit: normalizedLimit,

      total,

      totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
    };
  }

  static async getEmployerApplications(
    {
      jobId,
      employerProfileId,
      employerContext = null,
      status = null,
      screeningOutcome = null,
      page = 1,
      limit = DEFAULT_PAGE_SIZE,
    },
    options = {}
  ) {
    const job = await JobService.getEmployerJob({
      jobId,
      employerProfileId,
      employerContext,
      session: options.session || null,
    });

    const filter = {
      job: job._id,
      business: job.business,
      branch: job.branch,
    };

    const normalizedStatus = this.normalizeStatus(status, false);

    if (normalizedStatus) {
      filter.status = normalizedStatus;
    }

    if (screeningOutcome !== null && screeningOutcome !== undefined && screeningOutcome !== "") {
      const outcome = String(screeningOutcome).trim().toLowerCase();

      if (!JOB_APPLICATION_SCREENING_OUTCOMES.includes(outcome)) {
        throw this.createError({
          message: "Screening outcome is invalid.",
          code: "INVALID_JOB_APPLICATION_SCREENING_OUTCOME",
        });
      }

      filter.screeningOutcome = outcome;
    }

    const normalizedPage = this.normalizePage(page);

    const normalizedLimit = this.normalizeLimit(limit);

    const itemsQuery = JobApplication.find(filter)
      .sort({
        submittedAt: -1,
        _id: -1,
      })
      .skip((normalizedPage - 1) * normalizedLimit)
      .limit(normalizedLimit);

    const countQuery = JobApplication.countDocuments(filter);

    this.withSession(itemsQuery, options.session || null);

    this.withSession(countQuery, options.session || null);

    const items = await itemsQuery.lean();

    const total = await countQuery;

    return {
      job,

      items,

      page: normalizedPage,

      limit: normalizedLimit,

      total,

      totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
    };
  }
}

module.exports = JobApplicationService;
