// models/JobApplication.js

const mongoose = require("mongoose");

const {
  nonNegativeIntegerField,
  nullableDateField,
  nullableReferenceField,
} = require("./helpers/schemaFields");

const {
  isPositiveSafeInteger,
  nonEmptyText,
  hasAnyDocumentValue,
} = require("./helpers/schemaValidators");

const {
  JOB_SCREENING_QUESTION_TYPES,
  JOB_SCREENING_REQUIREMENT_LEVELS,
} = require("../constants/jobPosting");

const {
  JOB_APPLICATION_STATUSES,
  ACTIVE_JOB_APPLICATION_STATUSES,
  JOB_APPLICATION_SCREENING_OUTCOMES,
  JOB_APPLICATION_REJECTION_REASONS,
  JOB_APPLICATION_WITHDRAWAL_REASONS,
  JOB_APPLICATION_ACTOR_ROLES,
  JOB_APPLICATION_ALLOWED_TRANSITIONS,
  MAX_JOB_APPLICATION_NOTE_LENGTH,
  MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH,
  MAX_JOB_APPLICATION_REASON_LENGTH,
  MAX_SCREENING_TEXT_ANSWER_LENGTH,
} = require("../constants/jobApplication");

/**
 * JOB APPLICATION:
 *
 * Represents one professional's candidacy for one permanent Job.
 *
 * One professional may submit only one application for a Job. Withdrawal or
 * rejection does not delete that history or create another application slot.
 *
 * JobPublication identifies the exact marketplace publication through which
 * the professional applied. JobPublication preserves the advertised Job terms
 * for that publication period.
 *
 * candidateSnapshot preserves the professional information presented when the
 * application was submitted. Later edits to User or ProfessionalProfile do not
 * rewrite the historical application.
 *
 * status = "interview" means the candidate is in the interview pipeline stage.
 * Individual interview meetings belong to Appointment records.
 *
 * Publication expiry does not expire an existing JobApplication.
 */

const SUPPORTED_PROFESSIONAL_TYPES = [
  "pharmacist",
  "pharmacy_technician",
  "nurse",
  "doctor",
  "lab_scientist",
  "radiographer",
  "physiotherapist",
];

const VERIFICATION_STATUSES = ["pending", "verified", "rejected", "needs_review"];

const MAX_CERTIFICATION_SNAPSHOTS = 30;

const SUPPORTED_RESUME_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const RESUME_SOURCES = ["profile_resume", "application_upload"];

/* ─────────────────────────────── APPLICATION HELPERS ─────────────────────────────── */

function getAnswerValueCount(answer) {
  return [
    typeof answer.booleanAnswer === "boolean",
    answer.numberAnswer !== null && answer.numberAnswer !== undefined,
    Array.isArray(answer.selectedOptions) && answer.selectedOptions.length > 0,
    nonEmptyText(answer.textAnswer),
  ].filter(Boolean).length;
}

/* ─────────────────────────────── CANDIDATE SNAPSHOT ─────────────────────────────── */

const certificationSnapshotSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    issuingBody: {
      type: String,
      trim: true,
      maxlength: 250,
      default: null,
    },

    dateObtained: nullableDateField(),

    expiryDate: nullableDateField(),

    verified: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

const candidateSnapshotSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    lastName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    displayName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    photo: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      maxlength: 254,
    },

    phoneCode: {
      type: String,
      trim: true,
      maxlength: 10,
      default: null,
    },

    phone: {
      type: String,
      trim: true,
      maxlength: 30,
      default: null,
    },

    professionalType: {
      type: String,
      enum: SUPPORTED_PROFESSIONAL_TYPES,
      required: true,
    },

    specialty: {
      type: String,
      trim: true,
      maxlength: 250,
      default: null,
    },

    bio: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    yearsOfExperience: {
      type: Number,
      min: 0,
      default: 0,

      validate: {
        validator: Number.isFinite,
        message: "candidateSnapshot.yearsOfExperience must be a valid number.",
      },
    },

    state: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    lga: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    licenceNumber: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    licenceIssuingBody: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    licenceVerificationStatus: {
      type: String,
      enum: [...VERIFICATION_STATUSES, null],
      default: null,
    },

    licenceExpiryDate: nullableDateField(),

    identityVerificationStatus: {
      type: String,
      enum: [...VERIFICATION_STATUSES, null],
      default: null,
    },

    certifications: {
      type: [certificationSnapshotSchema],
      default: [],

      validate: {
        validator: (certifications) =>
          Array.isArray(certifications) && certifications.length <= MAX_CERTIFICATION_SNAPSHOTS,

        message:
          `candidateSnapshot.certifications cannot exceed ` +
          `${MAX_CERTIFICATION_SNAPSHOTS} items.`,
      },
    },

    capturedAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── RESUME SNAPSHOT ─────────────────────────────── */

const resumeSnapshotSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: RESUME_SOURCES,
      required: true,
    },

    /**
     * Present when the application used a reusable ProfessionalResume.
     *
     * For a fresh application upload this may remain null unless the
     * professional explicitly saved that upload to their resume library.
     */
    professionalResume: nullableReferenceField("ProfessionalResume"),

    documentUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      required: true,
      select: false,
    },

    fileName: {
      type: String,
      trim: true,
      maxlength: 255,
      required: true,
    },

    mimeType: {
      type: String,
      enum: SUPPORTED_RESUME_MIME_TYPES,
      required: true,
    },

    sizeBytes: {
      type: Number,
      required: true,
      min: 1,

      validate: {
        validator: isPositiveSafeInteger,
        message: "resumeSnapshot.sizeBytes must be a positive whole number.",
      },
    },

    capturedAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

resumeSnapshotSchema.pre("validate", function validateResumeSnapshot() {
  if (this.source === "profile_resume" && !this.professionalResume) {
    this.invalidate("professionalResume", "A profile-resume snapshot requires professionalResume.");
  }
});

/* ─────────────────────────────── SCREENING ANSWERS ─────────────────────────────── */

const screeningAnswerSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    promptSnapshot: {
      type: String,
      trim: true,
      required: true,
      maxlength: 500,
    },

    questionType: {
      type: String,
      enum: JOB_SCREENING_QUESTION_TYPES,
      required: true,
    },

    requirementLevel: {
      type: String,
      enum: JOB_SCREENING_REQUIREMENT_LEVELS,
      required: true,
    },

    responseRequired: {
      type: Boolean,
      required: true,
    },

    booleanAnswer: {
      type: Boolean,
      default: null,
    },

    numberAnswer: {
      type: Number,
      default: null,
    },

    selectedOptions: {
      type: [String],
      default: [],
    },

    textAnswer: {
      type: String,
      trim: true,
      maxlength: MAX_SCREENING_TEXT_ANSWER_LENGTH,
      default: null,
    },

    criterionMet: {
      type: Boolean,
      default: null,
    },
  },
  {
    _id: false,
  }
);

screeningAnswerSchema.pre("validate", function validateScreeningAnswer() {
  const answerValueCount = getAnswerValueCount(this);

  if (answerValueCount > 1) {
    this.invalidate("questionId", "A screening answer must use exactly one answer field.");

    return;
  }

  if (this.responseRequired && answerValueCount === 0) {
    this.invalidate("questionId", "A required screening question must contain an answer.");

    return;
  }

  if (answerValueCount === 0) {
    if (this.criterionMet !== null) {
      this.invalidate(
        "criterionMet",
        "An unanswered screening question cannot have a criterion outcome."
      );
    }

    return;
  }

  if (this.questionType === "yes_no" && typeof this.booleanAnswer !== "boolean") {
    this.invalidate("booleanAnswer", "Yes/no screening questions require booleanAnswer.");
  }

  if (
    this.questionType === "number" &&
    (typeof this.numberAnswer !== "number" || !Number.isFinite(this.numberAnswer))
  ) {
    this.invalidate("numberAnswer", "Number screening questions require a finite numberAnswer.");
  }

  if (
    this.questionType === "single_select" &&
    (!Array.isArray(this.selectedOptions) || this.selectedOptions.length !== 1)
  ) {
    this.invalidate(
      "selectedOptions",
      "Single-select screening questions require exactly one selected option."
    );
  }

  if (
    this.questionType === "multi_select" &&
    (!Array.isArray(this.selectedOptions) || this.selectedOptions.length < 1)
  ) {
    this.invalidate(
      "selectedOptions",
      "Multi-select screening questions require at least one selected option."
    );
  }

  if (this.questionType === "short_text" && !nonEmptyText(this.textAnswer)) {
    this.invalidate("textAnswer", "Short-text screening questions require textAnswer.");
  }

  if (this.requirementLevel === "informational" && this.criterionMet !== null) {
    this.invalidate(
      "criterionMet",
      "Informational screening questions cannot have a criterion outcome."
    );
  }
});

/* ─────────────────────────────── STATUS HISTORY ─────────────────────────────── */

const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: {
      type: String,
      enum: [...JOB_APPLICATION_STATUSES, null],
      default: null,
    },

    toStatus: {
      type: String,
      enum: JOB_APPLICATION_STATUSES,
      required: true,
    },

    actorRole: {
      type: String,
      enum: JOB_APPLICATION_ACTOR_ROLES,
      required: true,
    },

    changedBy: nullableReferenceField("User"),

    changedAt: {
      type: Date,
      required: true,
    },

    note: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH,
      default: null,
    },
  },
  {
    _id: false,
  }
);

statusHistorySchema.pre("validate", function validateStatusHistoryEntry() {
  if (this.actorRole !== "system" && !this.changedBy) {
    this.invalidate("changedBy", "Non-system Job application status changes require a user actor.");
  }
});

/* ─────────────────────────────── JOB APPLICATION SCHEMA ─────────────────────────────── */

const jobApplicationSchema = new mongoose.Schema(
  {
    // --- IDENTITY / OWNERSHIP ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      immutable: true,
    },

    /**
     * Exact publication cycle during which this application was submitted.
     */
    publication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobPublication",
      required: true,
      immutable: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      immutable: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
      immutable: true,
    },

    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // --- SUBMITTED APPLICATION SNAPSHOT ---

    snapshotVersion: {
      type: Number,
      default: 1,
      required: true,
      immutable: true,
      min: 1,

      validate: {
        validator: isPositiveSafeInteger,
        message: "snapshotVersion must be a positive whole number.",
      },
    },

    candidateSnapshot: {
      type: candidateSnapshotSchema,
      required: true,
    },

    /**
     * Every permanent-Job application requires an immutable CV snapshot.
     *
     * The snapshot may originate from a reusable ProfessionalResume or from
     * a fresh application upload. Later edits, replacement or archival of the
     * reusable resume do not rewrite this historical application snapshot.
     */
    resumeSnapshot: {
      type: resumeSnapshotSchema,
      required: true,
    },

    coverNote: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPLICATION_NOTE_LENGTH,
      default: null,
    },

    // --- SCREENING ---

    screeningAnswers: {
      type: [screeningAnswerSchema],
      default: [],
    },

    screeningOutcome: {
      type: String,
      enum: JOB_APPLICATION_SCREENING_OUTCOMES,
      default: "not_evaluated",
      required: true,
    },

    screeningSummary: {
      requiredCriteriaCount: nonNegativeIntegerField(),

      requiredCriteriaMetCount: nonNegativeIntegerField(),

      preferredCriteriaCount: nonNegativeIntegerField(),

      preferredCriteriaMetCount: nonNegativeIntegerField(),

      evaluatedAt: nullableDateField(),
    },

    // --- RECRUITMENT PIPELINE ---

    status: {
      type: String,
      enum: JOB_APPLICATION_STATUSES,
      default: "submitted",
      required: true,
    },

    submittedAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true,
    },

    statusUpdatedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },

    statusUpdatedBy: nullableReferenceField("User"),

    statusUpdatedByRole: {
      type: String,
      enum: JOB_APPLICATION_ACTOR_ROLES,
      default: "professional",
      required: true,
    },

    statusHistory: {
      type: [statusHistorySchema],
      default: [],
    },

    // --- EMPLOYER REVIEW ---

    lastReviewedAt: nullableDateField(),

    lastReviewedBy: nullableReferenceField("User"),

    employerPrivateNote: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPLICATION_REVIEW_NOTE_LENGTH,
      default: null,
      select: false,
    },

    // --- OFFER / HIRING OUTCOME ---

    offeredAt: nullableDateField(),

    offeredBy: nullableReferenceField("User"),

    hiredAt: nullableDateField(),

    hiredBy: nullableReferenceField("User"),

    // --- REJECTION OUTCOME ---

    rejectedAt: nullableDateField(),

    rejectedBy: nullableReferenceField("User"),

    rejectionReason: {
      type: String,
      enum: [...JOB_APPLICATION_REJECTION_REASONS, null],
      default: null,
    },

    rejectionReasonDetails: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPLICATION_REASON_LENGTH,
      default: null,
    },

    // --- WITHDRAWAL OUTCOME ---

    withdrawnAt: nullableDateField(),

    withdrawnBy: nullableReferenceField("User"),

    withdrawalReason: {
      type: String,
      enum: [...JOB_APPLICATION_WITHDRAWAL_REASONS, null],
      default: null,
    },

    withdrawalReasonDetails: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPLICATION_REASON_LENGTH,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

jobApplicationSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

/**
 * One professional may apply only once to the same recruitment Job.
 *
 * Extending the same Job's publication does not create another application
 * opportunity for the same professional.
 *
 * A genuine repost is a new Job.
 */
jobApplicationSchema.index(
  {
    job: 1,
    professional: 1,
  },
  {
    unique: true,
  }
);

jobApplicationSchema.index({
  job: 1,
  status: 1,
  createdAt: -1,
});

jobApplicationSchema.index({
  business: 1,
  branch: 1,
  status: 1,
  updatedAt: -1,
});

jobApplicationSchema.index({
  professional: 1,
  status: 1,
  createdAt: -1,
});

jobApplicationSchema.index({
  publication: 1,
  createdAt: -1,
});

jobApplicationSchema.index({
  screeningOutcome: 1,
  status: 1,
});

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

jobApplicationSchema.pre("validate", function validateJobApplication() {
  const screeningSummary = this.screeningSummary || {};

  /* ─────────────────────────────── SUBMISSION SNAPSHOT ─────────────────────────────── */

  if (this.isNew && !this.resumeSnapshot) {
    this.invalidate("resumeSnapshot", "A CV is required for every permanent Job application.");
  }

  if (!this.isNew) {
    const immutableSubmissionPaths = [
      "candidateSnapshot",
      "resumeSnapshot",
      "coverNote",
      "screeningAnswers",
      "screeningOutcome",
      "screeningSummary",
    ];

    for (const path of immutableSubmissionPaths) {
      if (this.isModified(path)) {
        this.invalidate(path, `${path} cannot be changed after application submission.`);
      }
    }
  }

  /* ─────────────────────────────── SCREENING ─────────────────────────────── */

  const questionIds = (this.screeningAnswers || []).map((answer) => String(answer.questionId));

  if (new Set(questionIds).size !== questionIds.length) {
    this.invalidate(
      "screeningAnswers",
      "A Job application may contain only one answer for each screening question."
    );
  }

  const requiredCount = Number(screeningSummary.requiredCriteriaCount || 0);

  const requiredMetCount = Number(screeningSummary.requiredCriteriaMetCount || 0);

  const preferredCount = Number(screeningSummary.preferredCriteriaCount || 0);

  const preferredMetCount = Number(screeningSummary.preferredCriteriaMetCount || 0);

  if (requiredMetCount > requiredCount) {
    this.invalidate(
      "screeningSummary.requiredCriteriaMetCount",
      "requiredCriteriaMetCount cannot exceed requiredCriteriaCount."
    );
  }

  if (preferredMetCount > preferredCount) {
    this.invalidate(
      "screeningSummary.preferredCriteriaMetCount",
      "preferredCriteriaMetCount cannot exceed preferredCriteriaCount."
    );
  }

  if (this.screeningOutcome === "not_evaluated") {
    if (screeningSummary.evaluatedAt) {
      this.invalidate(
        "screeningSummary.evaluatedAt",
        "An unevaluated screening result cannot have evaluatedAt."
      );
    }
  } else {
    if (!screeningSummary.evaluatedAt) {
      this.invalidate(
        "screeningSummary.evaluatedAt",
        "An evaluated screening result requires evaluatedAt."
      );
    }

    if (this.screeningOutcome === "meets_required_criteria" && requiredMetCount !== requiredCount) {
      this.invalidate(
        "screeningOutcome",
        "meets_required_criteria requires all evaluated required criteria to be met."
      );
    }

    if (
      this.screeningOutcome === "does_not_meet_required_criteria" &&
      (requiredCount === 0 || requiredMetCount >= requiredCount)
    ) {
      this.invalidate(
        "screeningOutcome",
        "does_not_meet_required_criteria requires at least one unmet required criterion."
      );
    }
  }

  /* ─────────────────────────────── STATUS HISTORY ─────────────────────────────── */

  if (!Array.isArray(this.statusHistory) || this.statusHistory.length === 0) {
    this.invalidate(
      "statusHistory",
      "Job applications require status history beginning with submission."
    );
  } else {
    const firstEntry = this.statusHistory[0];

    const latestEntry = this.statusHistory[this.statusHistory.length - 1];

    if (
      firstEntry.fromStatus !== null ||
      firstEntry.toStatus !== "submitted" ||
      firstEntry.actorRole !== "professional" ||
      String(firstEntry.changedBy || "") !== String(this.submittedBy || "")
    ) {
      this.invalidate(
        "statusHistory",
        "The first Job application history entry must record submission by the professional."
      );
    }

    for (let index = 1; index < this.statusHistory.length; index += 1) {
      const previousEntry = this.statusHistory[index - 1];

      const currentEntry = this.statusHistory[index];

      if (currentEntry.fromStatus !== previousEntry.toStatus) {
        this.invalidate(
          "statusHistory",
          "Each Job application history entry must continue from the previous status."
        );

        break;
      }

      const allowedTransitions = JOB_APPLICATION_ALLOWED_TRANSITIONS[currentEntry.fromStatus] || [];

      if (!allowedTransitions.includes(currentEntry.toStatus)) {
        this.invalidate(
          "statusHistory",
          `Invalid Job application transition from ${currentEntry.fromStatus} to ${currentEntry.toStatus}.`
        );

        break;
      }

      if (currentEntry.changedAt < previousEntry.changedAt) {
        this.invalidate(
          "statusHistory",
          "Job application history timestamps must be chronological."
        );

        break;
      }
    }

    if (latestEntry.toStatus !== this.status) {
      this.invalidate(
        "statusHistory",
        "The latest Job application history entry must match the current status."
      );
    }
  }

  /* ─────────────────────────────── INITIAL SUBMISSION ─────────────────────────────── */

  if (this.isNew && this.status !== "submitted") {
    this.invalidate("status", "New Job applications must begin with submitted status.");
  }

  if (this.isNew) {
    if (
      this.statusUpdatedByRole !== "professional" ||
      String(this.statusUpdatedBy || "") !== String(this.submittedBy || "")
    ) {
      this.invalidate(
        "statusUpdatedBy",
        "Initial Job application status must be recorded by the submitting professional."
      );
    }
  }

  if (this.statusUpdatedByRole !== "system" && !this.statusUpdatedBy) {
    this.invalidate(
      "statusUpdatedBy",
      "Non-system Job application status updates require a user actor."
    );
  }

  if (this.statusUpdatedAt < this.submittedAt) {
    this.invalidate("statusUpdatedAt", "statusUpdatedAt cannot be earlier than submittedAt.");
  }

  /* ─────────────────────────────── EMPLOYER REVIEW ─────────────────────────────── */

  if (Boolean(this.lastReviewedAt) !== Boolean(this.lastReviewedBy)) {
    this.invalidate(
      "lastReviewedBy",
      "lastReviewedAt and lastReviewedBy must either both be set or both be empty."
    );
  }

  /* ─────────────────────────────── OFFER AUDIT ─────────────────────────────── */

  if (Boolean(this.offeredAt) !== Boolean(this.offeredBy)) {
    this.invalidate(
      "offeredBy",
      "offeredAt and offeredBy must either both be set or both be empty."
    );
  }

  if (this.status === "offered" && (!this.offeredAt || !this.offeredBy)) {
    this.invalidate("status", "An offered application requires offeredAt and offeredBy.");
  }

  /* ─────────────────────────────── HIRED OUTCOME ─────────────────────────────── */

  if (this.status === "hired") {
    if (!this.hiredAt || !this.hiredBy) {
      this.invalidate("status", "A hired application requires hiredAt and hiredBy.");
    }

    if (this.rejectedAt || this.withdrawnAt) {
      this.invalidate("status", "A hired application cannot also be rejected or withdrawn.");
    }
  } else if (this.hiredAt || this.hiredBy) {
    this.invalidate("hiredAt", "Hiring audit fields may only be set when status is hired.");
  }

  /* ─────────────────────────────── REJECTED OUTCOME ─────────────────────────────── */

  const hasRejectionAudit = hasAnyDocumentValue([
    this.rejectedAt,
    this.rejectedBy,
    this.rejectionReason,
    this.rejectionReasonDetails,
  ]);

  if (this.status === "rejected") {
    if (!this.rejectedAt || !this.rejectionReason) {
      this.invalidate("status", "A rejected application requires rejectedAt and rejectionReason.");
    }

    if (this.hiredAt || this.withdrawnAt) {
      this.invalidate("status", "A rejected application cannot also be hired or withdrawn.");
    }

    if (this.rejectionReason === "other" && !nonEmptyText(this.rejectionReasonDetails)) {
      this.invalidate(
        "rejectionReasonDetails",
        "rejectionReasonDetails is required when rejectionReason is other."
      );
    }
  } else if (hasRejectionAudit) {
    this.invalidate(
      "rejectedAt",
      "Rejection audit fields may only be set when status is rejected."
    );
  }

  /* ─────────────────────────────── WITHDRAWN OUTCOME ─────────────────────────────── */

  const hasWithdrawalAudit = hasAnyDocumentValue([
    this.withdrawnAt,
    this.withdrawnBy,
    this.withdrawalReason,
    this.withdrawalReasonDetails,
  ]);

  if (this.status === "withdrawn") {
    if (!this.withdrawnAt || !this.withdrawnBy || !this.withdrawalReason) {
      this.invalidate(
        "status",
        "A withdrawn application requires withdrawnAt, withdrawnBy and withdrawalReason."
      );
    }

    if (this.hiredAt || this.rejectedAt) {
      this.invalidate("status", "A withdrawn application cannot also be hired or rejected.");
    }

    if (this.withdrawalReason === "other" && !nonEmptyText(this.withdrawalReasonDetails)) {
      this.invalidate(
        "withdrawalReasonDetails",
        "withdrawalReasonDetails is required when withdrawalReason is other."
      );
    }
  } else if (hasWithdrawalAudit) {
    this.invalidate(
      "withdrawnAt",
      "Withdrawal audit fields may only be set when status is withdrawn."
    );
  }

  /* ─────────────────────────────── ACTIVE STATUS CONSISTENCY ─────────────────────────────── */

  if (
    ACTIVE_JOB_APPLICATION_STATUSES.includes(this.status) &&
    hasAnyDocumentValue([
      this.hiredAt,
      this.hiredBy,
      this.rejectedAt,
      this.rejectedBy,
      this.rejectionReason,
      this.withdrawnAt,
      this.withdrawnBy,
      this.withdrawalReason,
    ])
  ) {
    this.invalidate(
      "status",
      "An active Job application cannot contain terminal-outcome audit fields."
    );
  }
});

module.exports = mongoose.model("JobApplication", jobApplicationSchema);
