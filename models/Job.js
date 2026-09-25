// models/Job.js

const mongoose = require("mongoose");

const {
  minorUnitAmountField,
  nonNegativeIntegerField,
  nullableDateField,
  nullableReferenceField,
  textListField,
} = require("./helpers/schemaFields");

const {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  nonEmptyText,
  hasAnyDocumentValue,
} = require("./helpers/schemaValidators");

const {
  JOB_RECRUITMENT_STATUSES,
  JOB_PUBLICATION_STATUSES,
  JOB_CLOSE_REASONS,
  JOB_EMPLOYMENT_TYPES,
  JOB_WORKPLACE_TYPES,
  JOB_SALARY_PERIODS,
  JOB_COMPENSATION_TYPES,
  JOB_SCREENING_QUESTION_TYPES,
  JOB_SCREENING_REQUIREMENT_LEVELS,
  MAX_JOB_TITLE_LENGTH,
  MAX_JOB_SUMMARY_LENGTH,
  MAX_JOB_DESCRIPTION_LENGTH,
  MAX_JOB_SECTION_LENGTH,
  MAX_JOB_CLOSE_REASON_LENGTH,
  MAX_SCREENING_QUESTION_LENGTH,
  MAX_SCREENING_OPTION_LENGTH,
} = require("../constants/jobPosting");

const geoPointSchema = require("./helpers/geoPointSchema");

/**
 * JOB:
 *
 * Represents one permanent-employment recruitment opportunity.
 *
 * RECRUITMENT VS PUBLICATION:
 *
 * recruitmentStatus controls the employer's overall recruitment lifecycle.
 *
 * publicationStatus controls marketplace visibility and whether the current
 * publication period remains active.
 *
 * These lifecycles are intentionally independent.
 *
 * A Job may therefore have:
 *
 * recruitmentStatus = "active"
 * publicationStatus = "expired"
 *
 * Existing applicants can continue through review, interview, offer and hiring
 * after the public listing stops accepting new applications.
 *
 * PUBLICATION:
 *
 * Individual 45-day publication periods and their commercial entitlement
 * provenance belong to JobPublication.
 *
 * Job stores the current publication locator and marketplace summary only.
 *
 * SHIFT SEPARATION:
 *
 * Job does not own:
 *
 * - ShiftOccurrence
 * - ShiftAssignment
 * - attendance
 * - PINs
 * - BASE or overtime
 * - protected Shift funding
 * - Shift settlement/refund
 * - Shift claims/disputes
 * - replacement hiring
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

const MAX_SCREENING_QUESTIONS = 20;
const MAX_JOB_LIST_ITEMS = 50;

/* ─────────────────────────────── COMPENSATION ─────────────────────────────── */

const compensationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: JOB_COMPENSATION_TYPES,
      required: true,
    },

    minimumAmount: {
      ...minorUnitAmountField({
        required: true,
        defaultValue: undefined,
      }),

      min: [1, "minimumAmount must be at least 1 minor unit."],
    },

    maximumAmount: {
      ...minorUnitAmountField({
        required: true,
        defaultValue: undefined,
      }),

      min: [1, "maximumAmount must be at least 1 minor unit."],
    },

    period: {
      type: String,
      enum: JOB_SALARY_PERIODS,
      required: true,
    },

    negotiable: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

compensationSchema.pre("validate", function validateCompensation() {
  if (!isPositiveSafeInteger(this.minimumAmount) || !isPositiveSafeInteger(this.maximumAmount)) {
    return;
  }

  if (this.type === "fixed" && this.minimumAmount !== this.maximumAmount) {
    this.invalidate(
      "maximumAmount",
      "Fixed compensation requires minimumAmount and maximumAmount to be equal."
    );
  }

  if (this.type === "range" && this.maximumAmount < this.minimumAmount) {
    this.invalidate(
      "maximumAmount",
      "Range compensation maximumAmount cannot be lower than minimumAmount."
    );
  }
});

/* ─────────────────────────────── SCREENING QUESTIONS ─────────────────────────────── */

const screeningQuestionSchema = new mongoose.Schema(
  {
    prompt: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_SCREENING_QUESTION_LENGTH,
    },

    type: {
      type: String,
      enum: JOB_SCREENING_QUESTION_TYPES,
      required: true,
    },

    requirementLevel: {
      type: String,
      enum: JOB_SCREENING_REQUIREMENT_LEVELS,
      default: "informational",
      required: true,
    },

    isResponseRequired: {
      type: Boolean,
      default: true,
    },

    options: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: MAX_SCREENING_OPTION_LENGTH,
        },
      ],

      default: [],
    },

    qualifyingBoolean: {
      type: Boolean,
      default: null,
    },

    minimumNumber: {
      type: Number,
      default: null,
    },

    maximumNumber: {
      type: Number,
      default: null,
    },

    acceptableOptions: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: MAX_SCREENING_OPTION_LENGTH,
        },
      ],

      default: [],
    },

    requireAllOptions: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: false,
  }
);

screeningQuestionSchema.pre("validate", function validateScreeningQuestion() {
  const options = Array.isArray(this.options)
    ? this.options.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const acceptableOptions = Array.isArray(this.acceptableOptions)
    ? this.acceptableOptions.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const hasAutomaticCriterion = this.requirementLevel !== "informational";

  if (new Set(options).size !== options.length) {
    this.invalidate("options", "Screening question options must be unique.");
  }

  if (new Set(acceptableOptions).size !== acceptableOptions.length) {
    this.invalidate("acceptableOptions", "Acceptable screening options must be unique.");
  }

  if (["single_select", "multi_select"].includes(this.type)) {
    if (options.length < 2) {
      this.invalidate("options", "Select screening questions require at least two options.");
    }

    if (acceptableOptions.some((value) => !options.includes(value))) {
      this.invalidate(
        "acceptableOptions",
        "Every acceptable option must exist in the screening question options."
      );
    }

    if (hasAutomaticCriterion && acceptableOptions.length === 0) {
      this.invalidate(
        "acceptableOptions",
        "Preferred or required select criteria require at least one acceptable option."
      );
    }
  } else if (options.length > 0 || acceptableOptions.length > 0) {
    this.invalidate(
      "options",
      "Only select screening questions may define options or acceptableOptions."
    );
  }

  if (this.type === "yes_no") {
    if (hasAutomaticCriterion && typeof this.qualifyingBoolean !== "boolean") {
      this.invalidate(
        "qualifyingBoolean",
        "Preferred or required yes/no criteria require a qualifyingBoolean."
      );
    }

    if (this.minimumNumber !== null || this.maximumNumber !== null) {
      this.invalidate(
        "minimumNumber",
        "Yes/no screening questions cannot define numeric criteria."
      );
    }
  } else if (this.qualifyingBoolean !== null) {
    this.invalidate(
      "qualifyingBoolean",
      "qualifyingBoolean may only be used with yes/no screening questions."
    );
  }

  if (this.type === "number") {
    if (
      this.minimumNumber !== null &&
      (typeof this.minimumNumber !== "number" || !Number.isFinite(this.minimumNumber))
    ) {
      this.invalidate("minimumNumber", "minimumNumber must be a finite number.");
    }

    if (
      this.maximumNumber !== null &&
      (typeof this.maximumNumber !== "number" || !Number.isFinite(this.maximumNumber))
    ) {
      this.invalidate("maximumNumber", "maximumNumber must be a finite number.");
    }

    if (
      this.minimumNumber !== null &&
      this.maximumNumber !== null &&
      this.maximumNumber < this.minimumNumber
    ) {
      this.invalidate("maximumNumber", "maximumNumber cannot be lower than minimumNumber.");
    }

    if (hasAutomaticCriterion && this.minimumNumber === null && this.maximumNumber === null) {
      this.invalidate(
        "minimumNumber",
        "Preferred or required numeric criteria require a minimumNumber or maximumNumber."
      );
    }
  } else if (this.minimumNumber !== null || this.maximumNumber !== null) {
    this.invalidate(
      "minimumNumber",
      "Numeric criteria may only be used with number screening questions."
    );
  }

  if (this.type !== "multi_select" && this.requireAllOptions) {
    this.invalidate(
      "requireAllOptions",
      "requireAllOptions may only be enabled for multi-select screening questions."
    );
  }

  if (
    this.type === "short_text" &&
    (this.qualifyingBoolean !== null ||
      this.minimumNumber !== null ||
      this.maximumNumber !== null ||
      acceptableOptions.length > 0)
  ) {
    this.invalidate(
      "type",
      "Short-text screening questions cannot define automatic qualification criteria."
    );
  }
});

/* ─────────────────────────────── APPLICATION SUMMARY ─────────────────────────────── */

const applicationSummarySchema = new mongoose.Schema(
  {
    total: nonNegativeIntegerField(),

    submitted: nonNegativeIntegerField(),

    underReview: nonNegativeIntegerField(),

    shortlisted: nonNegativeIntegerField(),

    interview: nonNegativeIntegerField(),

    offered: nonNegativeIntegerField(),

    hired: nonNegativeIntegerField(),

    rejected: nonNegativeIntegerField(),

    withdrawn: nonNegativeIntegerField(),

    lastReconciledAt: nullableDateField(),
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── JOB SCHEMA ─────────────────────────────── */

const jobSchema = new mongoose.Schema(
  {
    // --- IDENTITY / OWNERSHIP ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
    },

    branch: nullableReferenceField("Branch"),

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // --- ROLE ---

    roleTitle: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_TITLE_LENGTH,
      default: null,
    },

    professionalType: {
      type: String,
      enum: [...SUPPORTED_PROFESSIONAL_TYPES, null],
      default: null,
    },

    specialty: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    department: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    employmentType: {
      type: String,
      enum: [...JOB_EMPLOYMENT_TYPES, null],
      default: null,
    },

    workplaceType: {
      type: String,
      enum: [...JOB_WORKPLACE_TYPES, null],
      default: null,
    },

    minimumYearsOfExperience: {
      type: Number,
      min: 0,
      default: 0,

      validate: {
        validator: isNonNegativeSafeInteger,
        message: "minimumYearsOfExperience must be a non-negative whole number.",
      },
    },

    educationRequirement: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    // --- LOCATION SNAPSHOT ---

    countryCode: {
      type: String,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
      required: true,
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

    address: {
      type: String,
      trim: true,
      maxlength: 250,
      default: null,
    },

    googlePlaceId: {
      type: String,
      trim: true,
      maxlength: 250,
      default: null,
    },

    location: {
      type: geoPointSchema,
      default: undefined,
    },

    // --- COMPENSATION ---

    currency: {
      type: String,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
      required: true,
    },

    compensation: {
      type: compensationSchema,
      default: undefined,
    },

    // --- JOB CONTENT ---

    summary: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_SUMMARY_LENGTH,
      default: null,
    },

    description: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_DESCRIPTION_LENGTH,
      default: null,
    },

    responsibilities: textListField({
      itemMaxLength: MAX_JOB_SECTION_LENGTH,
      maxItems: MAX_JOB_LIST_ITEMS,
    }),

    requirements: textListField({
      itemMaxLength: MAX_JOB_SECTION_LENGTH,
      maxItems: MAX_JOB_LIST_ITEMS,
    }),

    preferredQualifications: textListField({
      itemMaxLength: MAX_JOB_SECTION_LENGTH,
      maxItems: MAX_JOB_LIST_ITEMS,
    }),

    skills: textListField({
      itemMaxLength: 500,
      maxItems: MAX_JOB_LIST_ITEMS,
    }),

    benefits: textListField({
      itemMaxLength: 1000,
      maxItems: MAX_JOB_LIST_ITEMS,
    }),

    // --- RECRUITMENT CAPACITY ---

    vacancyCount: {
      type: Number,
      default: 1,
      min: 1,
      required: true,

      validate: {
        validator: isPositiveSafeInteger,
        message: "vacancyCount must be a positive whole number.",
      },
    },

    // --- APPLICATION SETTINGS ---

    applicationDeadline: nullableDateField(),

    employmentStartDate: nullableDateField(),

    screeningQuestions: {
      type: [screeningQuestionSchema],
      default: [],

      validate: {
        validator: (questions) =>
          Array.isArray(questions) && questions.length <= MAX_SCREENING_QUESTIONS,

        message: `A Job may contain at most ${MAX_SCREENING_QUESTIONS} screening questions.`,
      },
    },

    applicationSummary: {
      type: applicationSummarySchema,
      default: () => ({}),
    },

    // --- RECRUITMENT LIFECYCLE ---

    recruitmentStatus: {
      type: String,
      enum: JOB_RECRUITMENT_STATUSES,
      default: "draft",
      required: true,
    },

    closedAt: nullableDateField(),

    closedBy: nullableReferenceField("User"),

    closeReason: {
      type: String,
      enum: [...JOB_CLOSE_REASONS, null],
      default: null,
    },

    closeReasonDetails: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_CLOSE_REASON_LENGTH,
      default: null,
    },

    archivedAt: nullableDateField(),

    archivedBy: nullableReferenceField("User"),

    // --- MARKETPLACE PUBLICATION ---

    publicationStatus: {
      type: String,
      enum: JOB_PUBLICATION_STATUSES,
      default: "unpublished",
      required: true,
    },

    currentPublication: nullableReferenceField("JobPublication"),

    publicationCount: nonNegativeIntegerField(),

    firstPublishedAt: nullableDateField(),

    lastPublishedAt: nullableDateField(),

    publicationExpiresAt: nullableDateField(),

    publicationPausedAt: nullableDateField(),

    publicationEndedAt: nullableDateField(),
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

jobSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

jobSchema.index({
  business: 1,
  recruitmentStatus: 1,
  createdAt: -1,
});

jobSchema.index({
  business: 1,
  branch: 1,
  recruitmentStatus: 1,
  createdAt: -1,
});

jobSchema.index({
  publicationStatus: 1,
  recruitmentStatus: 1,
  professionalType: 1,
  employmentType: 1,
  workplaceType: 1,
  state: 1,
  lastPublishedAt: -1,
});

jobSchema.index({
  publicationStatus: 1,
  publicationExpiresAt: 1,
});

jobSchema.index({
  professionalType: 1,
  specialty: 1,
  state: 1,
  lga: 1,
});

jobSchema.index({
  currency: 1,
  "compensation.minimumAmount": 1,
  "compensation.maximumAmount": 1,
});

jobSchema.index(
  {
    roleTitle: "text",
    specialty: "text",
    department: "text",
    summary: "text",
    description: "text",
  },
  {
    name: "job_marketplace_text_search",

    weights: {
      roleTitle: 10,
      specialty: 8,
      department: 5,
      summary: 3,
      description: 1,
    },
  }
);

jobSchema.index(
  {
    location: "2dsphere",
  },
  {
    sparse: true,
  }
);

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

jobSchema.pre("validate", function validateJob() {
  const summary = this.applicationSummary || {};

  const countedApplications =
    Number(summary.submitted || 0) +
    Number(summary.underReview || 0) +
    Number(summary.shortlisted || 0) +
    Number(summary.interview || 0) +
    Number(summary.offered || 0) +
    Number(summary.hired || 0) +
    Number(summary.rejected || 0) +
    Number(summary.withdrawn || 0);

  /* ─────────────────────────────── APPLICATION SUMMARY ─────────────────────────────── */

  if (Number(summary.total || 0) !== countedApplications) {
    this.invalidate(
      "applicationSummary.total",
      "applicationSummary.total must equal the sum of all application status counts."
    );
  }

  if (Number(summary.hired || 0) > Number(this.vacancyCount || 0)) {
    this.invalidate("applicationSummary.hired", "Hired professionals cannot exceed vacancyCount.");
  }

  if (
    this.recruitmentStatus === "active" &&
    Number(summary.hired || 0) >= Number(this.vacancyCount || 0)
  ) {
    this.invalidate("recruitmentStatus", "A fully hired Job cannot remain active.");
  }

  /* ─────────────────────────────── RECRUITMENT CLOSURE ─────────────────────────────── */

  const hasCloseAudit = hasAnyDocumentValue([
    this.closedAt,
    this.closedBy,
    this.closeReason,
    this.closeReasonDetails,
  ]);

  if (["closed", "archived"].includes(this.recruitmentStatus)) {
    if (!this.closedAt || !this.closedBy || !this.closeReason) {
      this.invalidate(
        "recruitmentStatus",
        "Closed or archived Jobs require closedAt, closedBy and closeReason."
      );
    }
  } else if (hasCloseAudit) {
    this.invalidate(
      "recruitmentStatus",
      "Close audit fields may only be retained on closed or archived Jobs."
    );
  }

  if (this.closeReason === "other" && !nonEmptyText(this.closeReasonDetails)) {
    this.invalidate(
      "closeReasonDetails",
      "closeReasonDetails is required when closeReason is other."
    );
  }

  if (
    this.closeReason === "filled" &&
    Number(summary.hired || 0) !== Number(this.vacancyCount || 0)
  ) {
    this.invalidate(
      "closeReason",
      "A Job closed as filled must have hired count equal to vacancyCount."
    );
  }

  /* ─────────────────────────────── ARCHIVING ─────────────────────────────── */

  if (this.recruitmentStatus === "archived") {
    if (!this.archivedAt || !this.archivedBy) {
      this.invalidate("recruitmentStatus", "Archived Jobs require archivedAt and archivedBy.");
    }
  } else if (this.archivedAt || this.archivedBy) {
    this.invalidate(
      "recruitmentStatus",
      "Archive audit fields may only be set when recruitmentStatus is archived."
    );
  }

  /* ─────────────────────────────── DRAFTS ─────────────────────────────── */

  if (this.recruitmentStatus === "draft") {
    if (Number(summary.total || 0) !== 0) {
      this.invalidate("applicationSummary.total", "Draft Jobs cannot have applications.");
    }

    if (this.publicationStatus !== "unpublished") {
      this.invalidate("publicationStatus", "Draft Jobs must remain unpublished.");
    }
  }

  /* ─────────────────────────────── PUBLICATION AUDIT ─────────────────────────────── */

  const hasEverBeenPublished = this.publicationStatus !== "unpublished";

  const publicationAuditFields = [
    this.currentPublication,
    this.firstPublishedAt,
    this.lastPublishedAt,
    this.publicationExpiresAt,
    this.publicationPausedAt,
    this.publicationEndedAt,
  ];

  if (!hasEverBeenPublished) {
    if (this.publicationCount !== 0 || hasAnyDocumentValue(publicationAuditFields)) {
      this.invalidate(
        "publicationStatus",
        "Unpublished Jobs cannot retain publication audit data."
      );
    }
  } else {
    if (
      !this.currentPublication ||
      !this.firstPublishedAt ||
      !this.lastPublishedAt ||
      !this.publicationExpiresAt ||
      this.publicationCount < 1
    ) {
      this.invalidate(
        "publicationStatus",
        "A published Job requires currentPublication, publication timestamps and publicationCount."
      );
    }

    if (
      this.firstPublishedAt &&
      this.lastPublishedAt &&
      this.lastPublishedAt < this.firstPublishedAt
    ) {
      this.invalidate(
        "lastPublishedAt",
        "lastPublishedAt cannot be earlier than firstPublishedAt."
      );
    }

    if (
      this.lastPublishedAt &&
      this.publicationExpiresAt &&
      this.publicationExpiresAt <= this.lastPublishedAt
    ) {
      this.invalidate(
        "publicationExpiresAt",
        "publicationExpiresAt must be later than lastPublishedAt."
      );
    }
  }

  /* ─────────────────────────────── LIVE / PAUSED PUBLICATION ─────────────────────────────── */

  if (["live", "paused"].includes(this.publicationStatus)) {
    if (this.recruitmentStatus !== "active") {
      this.invalidate("publicationStatus", "Only actively recruiting Jobs may be live or paused.");
    }

    if (
      this.applicationDeadline &&
      this.lastPublishedAt &&
      this.applicationDeadline <= this.lastPublishedAt
    ) {
      this.invalidate(
        "applicationDeadline",
        "A live or paused publication applicationDeadline must be later than lastPublishedAt."
      );
    }

    if (
      this.applicationDeadline &&
      this.publicationExpiresAt &&
      this.applicationDeadline > this.publicationExpiresAt
    ) {
      this.invalidate(
        "applicationDeadline",
        "A live or paused publication applicationDeadline cannot be later than publication expiry."
      );
    }
  }

  if (this.publicationStatus === "live" && this.publicationPausedAt) {
    this.invalidate("publicationPausedAt", "A live Job cannot retain publicationPausedAt.");
  }

  if (this.publicationStatus === "paused" && !this.publicationPausedAt) {
    this.invalidate("publicationPausedAt", "A paused Job requires publicationPausedAt.");
  }

  if (this.publicationStatus !== "paused" && this.publicationPausedAt) {
    this.invalidate(
      "publicationPausedAt",
      "publicationPausedAt may only be set while publicationStatus is paused."
    );
  }

  /* ─────────────────────────────── ENDED PUBLICATION ─────────────────────────────── */

  if (this.publicationStatus === "ended" && !this.publicationEndedAt) {
    this.invalidate("publicationEndedAt", "An ended publication requires publicationEndedAt.");
  }

  if (this.publicationStatus !== "ended" && this.publicationEndedAt) {
    this.invalidate(
      "publicationEndedAt",
      "publicationEndedAt may only be set when publicationStatus is ended."
    );
  }

  if (
    ["closed", "archived"].includes(this.recruitmentStatus) &&
    ["live", "paused"].includes(this.publicationStatus)
  ) {
    this.invalidate(
      "publicationStatus",
      "Closed or archived recruitment cannot remain live or paused in the marketplace."
    );
  }

  /* ─────────────────────────────── PUBLISHED JOB COMPLETENESS ─────────────────────────────── */

  if (hasEverBeenPublished) {
    if (!this.branch) {
      this.invalidate("branch", "Published Jobs require a branch.");
    }

    if (!nonEmptyText(this.roleTitle)) {
      this.invalidate("roleTitle", "Published Jobs require a roleTitle.");
    }

    if (!this.professionalType) {
      this.invalidate("professionalType", "Published Jobs require a professionalType.");
    }

    if (!this.employmentType) {
      this.invalidate("employmentType", "Published Jobs require an employmentType.");
    }

    if (!this.workplaceType) {
      this.invalidate("workplaceType", "Published Jobs require a workplaceType.");
    }

    if (!this.compensation) {
      this.invalidate("compensation", "Published Jobs require visible compensation.");
    }

    if (!nonEmptyText(this.description)) {
      this.invalidate("description", "Published Jobs require a description.");
    }

    if (this.requirements.length === 0) {
      this.invalidate("requirements", "Published Jobs require at least one requirement.");
    }

    if (["onsite", "hybrid"].includes(this.workplaceType)) {
      if (!nonEmptyText(this.state)) {
        this.invalidate("state", "On-site and hybrid Jobs require a state.");
      }

      if (!nonEmptyText(this.lga)) {
        this.invalidate("lga", "On-site and hybrid Jobs require an LGA.");
      }

      if (!nonEmptyText(this.address)) {
        this.invalidate("address", "On-site and hybrid Jobs require a work address.");
      }
    }
  }
});

module.exports = mongoose.model("Job", jobSchema);
