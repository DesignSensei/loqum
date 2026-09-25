// models/JobPublication.js

const mongoose = require("mongoose");

const {
  minorUnitAmountField,
  nonNegativeIntegerField,
  nullableDateField,
  nullableReferenceField,
  requiredPositiveSafeIntegerField,
  textListField,
} = require("./helpers/schemaFields");

const {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  nonEmptyText,
  hasAnyDocumentValue,
} = require("./helpers/schemaValidators");

const {
  JOB_PUBLICATION_STATUSES,
  JOB_EMPLOYMENT_TYPES,
  JOB_WORKPLACE_TYPES,
  JOB_SALARY_PERIODS,
  JOB_COMPENSATION_TYPES,
  JOB_SCREENING_QUESTION_TYPES,
  JOB_SCREENING_REQUIREMENT_LEVELS,
  JOB_PUBLICATION_ENTITLEMENT_SOURCES,
  DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,
  MAX_JOB_TITLE_LENGTH,
  MAX_JOB_SUMMARY_LENGTH,
  MAX_JOB_DESCRIPTION_LENGTH,
  MAX_JOB_SECTION_LENGTH,
  MAX_SCREENING_QUESTION_LENGTH,
  MAX_SCREENING_OPTION_LENGTH,
} = require("../constants/jobPosting");

/**
 * JOB PUBLICATION:
 *
 * Represents one free, subscription-allowance or paid marketplace publication
 * cycle for a permanent Job.
 *
 * A publication cycle is separate from the Job's recruitment lifecycle.
 * Natural expiry stops new applications but does not close recruitment or
 * invalidate existing JobApplication records.
 *
 * Each renewal creates a new JobPublication record with a fresh entitlement.
 * Pause/resume does not reset or extend the original expiry clock.
 *
 * listingSnapshot preserves the advertised Job content for this publication
 * cycle. Operational application-deadline changes are intentionally stored
 * outside listingSnapshot because an employer may shorten, extend, clear or
 * reopen the deadline during the same live/paused publication cycle.
 *
 * employerSnapshot preserves the public employer and Branch identity shown
 * for this exact publication cycle. Later EmployerProfile or Branch edits do
 * not rewrite historical publication records.
 *
 * initialApplicationDeadline anchors the cycle's original deadline.
 * applicationDeadline stores the current deadline. deadlineHistory preserves
 * every subsequent deadline change.
 *
 * entitlementSnapshot records why this exact publication was authorized.
 * Commercial charging, allowance accounting and provider execution belong to
 * the monetization/service layer rather than this model.
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

const SUPPORTED_EMPLOYER_TYPES = ["pharmacy", "clinic", "hospital", "laboratory"];

const PUBLICATION_RECORD_STATUSES = JOB_PUBLICATION_STATUSES.filter(
  (status) => status !== "unpublished"
);

const MAX_JOB_LIST_ITEMS = 50;
const MAX_SCREENING_QUESTIONS = 20;
const MAX_PUBLICATION_REFERENCE_LENGTH = 250;
const MAX_PUBLICATION_END_REASON_LENGTH = 500;
const MAX_DEADLINE_CHANGE_REASON_LENGTH = 500;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function sameNullableDate(left, right) {
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

/* ─────────────────────────────── GEOLOCATION SNAPSHOT ─────────────────────────────── */

const locationSnapshotSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },

    coordinates: {
      type: [Number],
      required: true,

      validate: [
        {
          validator: (coordinates) => Array.isArray(coordinates) && coordinates.length === 2,

          message: "Publication location coordinates must contain longitude and latitude.",
        },
        {
          validator: (coordinates) => {
            if (!Array.isArray(coordinates) || coordinates.length !== 2) {
              return false;
            }

            const [longitude, latitude] = coordinates;

            return (
              Number.isFinite(longitude) &&
              Number.isFinite(latitude) &&
              longitude >= -180 &&
              longitude <= 180 &&
              latitude >= -90 &&
              latitude <= 90
            );
          },

          message:
            "Publication location coordinates must be [longitude, latitude] with valid ranges.",
        },
      ],
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── COMPENSATION SNAPSHOT ─────────────────────────────── */

const compensationSnapshotSchema = new mongoose.Schema(
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

compensationSnapshotSchema.pre("validate", function validateCompensationSnapshot() {
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

/* ─────────────────────────────── SCREENING SNAPSHOT ─────────────────────────────── */

const screeningQuestionSnapshotSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

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
      required: true,
    },

    isResponseRequired: {
      type: Boolean,
      required: true,
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
    _id: false,
  }
);

screeningQuestionSnapshotSchema.pre("validate", function validateScreeningQuestionSnapshot() {
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

/* ─────────────────────────────── EMPLOYER SNAPSHOT ─────────────────────────────── */

const employerSnapshotSchema = new mongoose.Schema(
  {
    snapshotVersion: {
      type: Number,
      default: 1,
      required: true,
      min: 1,

      validate: {
        validator: isPositiveSafeInteger,

        message: "employerSnapshot.snapshotVersion must be a positive whole number.",
      },
    },

    businessName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    type: {
      type: String,
      enum: SUPPORTED_EMPLOYER_TYPES,
      required: true,
    },

    logoUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    publicDescription: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: null,
    },

    websiteUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,

      match: [
        /^https?:\/\/\S+$/i,
        "employerSnapshot.websiteUrl must be a valid HTTP or HTTPS URL.",
      ],
    },

    cacVerified: {
      type: Boolean,
      required: true,
    },

    regulatoryVerified: {
      type: Boolean,
      required: true,
    },

    branchName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    branchAddress: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    branchState: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    branchLga: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── LISTING SNAPSHOT ─────────────────────────────── */

const listingSnapshotSchema = new mongoose.Schema(
  {
    snapshotVersion: {
      type: Number,
      default: 1,
      required: true,
      min: 1,

      validate: {
        validator: isPositiveSafeInteger,

        message: "listingSnapshot.snapshotVersion must be a positive whole number.",
      },
    },

    roleTitle: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_JOB_TITLE_LENGTH,
    },

    professionalType: {
      type: String,
      enum: SUPPORTED_PROFESSIONAL_TYPES,
      required: true,
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
      enum: JOB_EMPLOYMENT_TYPES,
      required: true,
    },

    workplaceType: {
      type: String,
      enum: JOB_WORKPLACE_TYPES,
      required: true,
    },

    minimumYearsOfExperience: {
      type: Number,
      default: 0,
      min: 0,

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

    countryCode: {
      type: String,
      uppercase: true,
      trim: true,
      required: true,

      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
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

    /**
     * Retained only in the immutable internal publication snapshot.
     * Public query/view layers must not expose Google Place IDs.
     */
    googlePlaceId: {
      type: String,
      trim: true,
      maxlength: 250,
      default: null,
    },

    /**
     * Retained for internal geospatial operations.
     * Exact coordinates must not be exposed by public Job views.
     */
    location: {
      type: locationSnapshotSchema,
      default: undefined,
    },

    currency: {
      type: String,
      uppercase: true,
      trim: true,
      required: true,

      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
    },

    compensation: {
      type: compensationSnapshotSchema,
      required: true,
    },

    summary: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_SUMMARY_LENGTH,
      default: null,
    },

    description: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_JOB_DESCRIPTION_LENGTH,
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

    vacancyCount: {
      ...requiredPositiveSafeIntegerField({
        label: "vacancyCount",
      }),
    },

    employmentStartDate: nullableDateField(),

    screeningQuestions: {
      type: [screeningQuestionSnapshotSchema],

      default: [],

      validate: {
        validator: (questions) =>
          Array.isArray(questions) && questions.length <= MAX_SCREENING_QUESTIONS,

        message: `A publication may contain at most ${MAX_SCREENING_QUESTIONS} screening questions.`,
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

listingSnapshotSchema.pre("validate", function validateListingSnapshot() {
  if (!nonEmptyText(this.roleTitle)) {
    this.invalidate("roleTitle", "Published listing snapshot requires a roleTitle.");
  }

  if (!nonEmptyText(this.description)) {
    this.invalidate("description", "Published listing snapshot requires a description.");
  }

  if (!Array.isArray(this.requirements) || this.requirements.length === 0) {
    this.invalidate(
      "requirements",
      "Published listing snapshot requires at least one requirement."
    );
  }

  if (["onsite", "hybrid"].includes(this.workplaceType)) {
    if (!nonEmptyText(this.state)) {
      this.invalidate("state", "On-site and hybrid publication snapshots require a state.");
    }

    if (!nonEmptyText(this.lga)) {
      this.invalidate("lga", "On-site and hybrid publication snapshots require an LGA.");
    }

    if (!nonEmptyText(this.address)) {
      this.invalidate("address", "On-site and hybrid publication snapshots require an address.");
    }
  }

  const questionIds = (this.screeningQuestions || []).map((question) =>
    String(question.questionId)
  );

  if (new Set(questionIds).size !== questionIds.length) {
    this.invalidate(
      "screeningQuestions",
      "Publication screening question snapshots must have unique questionId values."
    );
  }
});

/* ─────────────────────────────── ENTITLEMENT SNAPSHOT ─────────────────────────────── */

const entitlementSnapshotSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: JOB_PUBLICATION_ENTITLEMENT_SOURCES,
      required: true,
    },

    /**
     * Unique identifier for the exact free, plan-allowance or paid-post
     * entitlement consumed by this publication.
     */
    consumptionReference: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_PUBLICATION_REFERENCE_LENGTH,
    },

    planCode: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    planName: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    billingCycleKey: {
      type: String,
      trim: true,
      maxlength: 150,
      default: null,
    },

    purchaseReference: {
      type: String,
      trim: true,
      maxlength: MAX_PUBLICATION_REFERENCE_LENGTH,
      default: null,
    },

    paymentTransaction: nullableReferenceField("Transaction"),

    grantedAt: {
      type: Date,
      required: true,
    },

    consumedAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  }
);

entitlementSnapshotSchema.pre("validate", function validateEntitlementSnapshot() {
  if (this.source === "free") {
    if (
      this.planCode ||
      this.planName ||
      this.billingCycleKey ||
      this.purchaseReference ||
      this.paymentTransaction
    ) {
      this.invalidate(
        "source",
        "Free publication entitlement cannot contain plan or paid-purchase details."
      );
    }
  }

  if (this.source === "plan_allowance") {
    if (!nonEmptyText(this.planCode) || !nonEmptyText(this.billingCycleKey)) {
      this.invalidate(
        "planCode",
        "Plan-allowance publication requires planCode and billingCycleKey."
      );
    }

    if (this.purchaseReference || this.paymentTransaction) {
      this.invalidate(
        "purchaseReference",
        "Plan-allowance publication cannot contain paid-single-post purchase details."
      );
    }
  }

  if (this.source === "paid_single_post") {
    if (!nonEmptyText(this.purchaseReference)) {
      this.invalidate(
        "purchaseReference",
        "Paid single-post publication requires purchaseReference."
      );
    }
  }

  if (this.grantedAt && this.consumedAt && this.consumedAt < this.grantedAt) {
    this.invalidate("consumedAt", "Entitlement cannot be consumed before it is granted.");
  }
});

/* ─────────────────────────────── DEADLINE HISTORY ─────────────────────────────── */

const deadlineHistorySchema = new mongoose.Schema(
  {
    fromDeadline: nullableDateField(),

    toDeadline: nullableDateField(),

    changedAt: {
      type: Date,
      required: true,
    },

    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    reason: {
      type: String,
      trim: true,
      maxlength: MAX_DEADLINE_CHANGE_REASON_LENGTH,
      default: null,
    },
  },
  {
    _id: false,
  }
);

deadlineHistorySchema.pre("validate", function validateDeadlineHistoryEntry() {
  if (sameNullableDate(this.fromDeadline, this.toDeadline)) {
    this.invalidate(
      "toDeadline",
      "A deadline history entry must contain an actual deadline change."
    );
  }

  if (this.toDeadline && this.changedAt && this.toDeadline <= this.changedAt) {
    this.invalidate(
      "toDeadline",
      "A new application deadline must be later than the time it is set."
    );
  }
});

/* ─────────────────────────────── PAUSE HISTORY ─────────────────────────────── */

const publicationPauseSchema = new mongoose.Schema(
  {
    pausedAt: {
      type: Date,
      required: true,
    },

    pausedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    resumedAt: nullableDateField(),

    resumedBy: nullableReferenceField("User"),
  },
  {
    _id: false,
  }
);

publicationPauseSchema.pre("validate", function validatePublicationPause() {
  if (Boolean(this.resumedAt) !== Boolean(this.resumedBy)) {
    this.invalidate(
      "resumedBy",
      "resumedAt and resumedBy must either both be set or both be empty."
    );
  }

  if (this.resumedAt && this.pausedAt && this.resumedAt < this.pausedAt) {
    this.invalidate("resumedAt", "A publication cannot resume before it was paused.");
  }
});

/* ─────────────────────────────── JOB PUBLICATION SCHEMA ─────────────────────────────── */

const jobPublicationSchema = new mongoose.Schema(
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

    cycleNumber: {
      ...requiredPositiveSafeIntegerField({
        label: "cycleNumber",
      }),

      immutable: true,
    },

    previousPublication: {
      ...nullableReferenceField("JobPublication"),

      immutable: true,
    },

    // --- HISTORICAL SNAPSHOTS ---

    employerSnapshot: {
      type: employerSnapshotSchema,
      required: true,
      immutable: true,
    },

    listingSnapshot: {
      type: listingSnapshotSchema,
      required: true,
      immutable: true,
    },

    entitlementSnapshot: {
      type: entitlementSnapshotSchema,
      required: true,
      immutable: true,
    },

    // --- PUBLICATION PERIOD ---

    publicationPeriodDays: {
      type: Number,

      default: DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,

      required: true,

      immutable: true,

      min: DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,

      max: DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,

      validate: {
        validator: (value) =>
          isPositiveSafeInteger(value) && value === DEFAULT_JOB_PUBLICATION_PERIOD_DAYS,

        message: `publicationPeriodDays must be ${DEFAULT_JOB_PUBLICATION_PERIOD_DAYS}.`,
      },
    },

    publishedAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    // --- APPLICATION DEADLINE ---

    /**
     * The deadline selected when this publication cycle first goes live.
     * Null means applications initially remain open until publication expiry.
     */
    initialApplicationDeadline: {
      ...nullableDateField(),
      immutable: true,
    },

    /**
     * Current operational deadline for this publication cycle.
     *
     * Null means applications remain open until expiresAt, subject to the
     * publication itself being live.
     */
    applicationDeadline: nullableDateField(),

    deadlineHistory: {
      type: [deadlineHistorySchema],

      default: [],
    },

    // --- PUBLICATION STATE ---

    status: {
      type: String,
      enum: PUBLICATION_RECORD_STATUSES,
      default: "live",
      required: true,
    },

    pauseHistory: {
      type: [publicationPauseSchema],

      default: [],
    },

    endedAt: nullableDateField(),

    endedBy: nullableReferenceField("User"),

    endReason: {
      type: String,
      trim: true,
      maxlength: MAX_PUBLICATION_END_REASON_LENGTH,
      default: null,
    },

    // --- DERIVED ACTIVITY SUMMARY ---

    /**
     * JobApplication remains authoritative. This counter is a reconciled
     * publication-level summary for reporting and listing analytics only.
     */
    applicationCount: nonNegativeIntegerField(),

    applicationCountLastReconciledAt: nullableDateField(),
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

jobPublicationSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

jobPublicationSchema.index(
  {
    job: 1,
    cycleNumber: 1,
  },
  {
    unique: true,
  }
);

jobPublicationSchema.index(
  {
    "entitlementSnapshot.consumptionReference": 1,
  },
  {
    unique: true,
  }
);

jobPublicationSchema.index({
  job: 1,
  status: 1,
  publishedAt: -1,
});

jobPublicationSchema.index({
  business: 1,
  status: 1,
  expiresAt: 1,
});

jobPublicationSchema.index({
  status: 1,
  expiresAt: 1,
});

jobPublicationSchema.index({
  status: 1,
  applicationDeadline: 1,
  expiresAt: 1,
});

jobPublicationSchema.index({
  "listingSnapshot.professionalType": 1,

  "listingSnapshot.employmentType": 1,

  "listingSnapshot.workplaceType": 1,

  "listingSnapshot.state": 1,

  publishedAt: -1,
});

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

jobPublicationSchema.pre("validate", function validateJobPublication() {
  const pauses = Array.isArray(this.pauseHistory) ? this.pauseHistory : [];

  const deadlineHistory = Array.isArray(this.deadlineHistory) ? this.deadlineHistory : [];

  if (!this.isNew) {
    const immutableSnapshotPaths = ["employerSnapshot", "listingSnapshot", "entitlementSnapshot"];

    for (const path of immutableSnapshotPaths) {
      if (this.isModified(path)) {
        this.invalidate(path, `${path} cannot be changed after publication creation.`);
      }
    }

    if (this.isModified("initialApplicationDeadline")) {
      this.invalidate(
        "initialApplicationDeadline",
        "initialApplicationDeadline cannot be changed after publication creation."
      );
    }
  }

  /* ─────────────────────────────── INITIAL STATE ─────────────────────────────── */

  if (this.isNew && this.status !== "live") {
    this.invalidate("status", "A new JobPublication must begin in live status.");
  }

  if (this.status === "unpublished") {
    this.invalidate("status", "JobPublication records cannot use unpublished status.");
  }

  /* ─────────────────────────────── PUBLICATION CHAIN ─────────────────────────────── */

  if (this.cycleNumber === 1 && this.previousPublication) {
    this.invalidate(
      "previousPublication",
      "The first Job publication cycle cannot reference a previous publication."
    );
  }

  if (this.cycleNumber > 1 && !this.previousPublication) {
    this.invalidate(
      "previousPublication",
      "Renewed Job publication cycles must reference the immediately previous publication."
    );
  }

  /* ─────────────────────────────── PUBLICATION CLOCK ─────────────────────────────── */

  if (this.publishedAt && this.expiresAt && this.expiresAt <= this.publishedAt) {
    this.invalidate("expiresAt", "expiresAt must be later than publishedAt.");
  }

  if (this.publishedAt && this.expiresAt) {
    const expectedExpiresAt =
      this.publishedAt.getTime() + DEFAULT_JOB_PUBLICATION_PERIOD_DAYS * MILLISECONDS_PER_DAY;

    if (this.expiresAt.getTime() !== expectedExpiresAt) {
      this.invalidate(
        "expiresAt",
        `expiresAt must be exactly ${DEFAULT_JOB_PUBLICATION_PERIOD_DAYS} days after publishedAt.`
      );
    }
  }

  if (
    this.listingSnapshot?.capturedAt &&
    this.publishedAt &&
    this.listingSnapshot.capturedAt > this.publishedAt
  ) {
    this.invalidate(
      "listingSnapshot.capturedAt",
      "The listing snapshot cannot be captured after publication begins."
    );
  }

  if (
    this.entitlementSnapshot?.consumedAt &&
    this.publishedAt &&
    this.entitlementSnapshot.consumedAt > this.publishedAt
  ) {
    this.invalidate(
      "entitlementSnapshot.consumedAt",
      "Publication entitlement must be consumed before or when publication begins."
    );
  }

  /* ─────────────────────────────── APPLICATION DEADLINE ─────────────────────────────── */

  if (
    this.initialApplicationDeadline &&
    this.publishedAt &&
    this.initialApplicationDeadline <= this.publishedAt
  ) {
    this.invalidate(
      "initialApplicationDeadline",
      "The initial application deadline must be later than publishedAt."
    );
  }

  if (
    this.initialApplicationDeadline &&
    this.expiresAt &&
    this.initialApplicationDeadline > this.expiresAt
  ) {
    this.invalidate(
      "initialApplicationDeadline",
      "The initial application deadline cannot be later than publication expiry."
    );
  }

  if (this.applicationDeadline && this.expiresAt && this.applicationDeadline > this.expiresAt) {
    this.invalidate(
      "applicationDeadline",
      "The current application deadline cannot be later than publication expiry."
    );
  }

  if (this.isNew) {
    if (!sameNullableDate(this.initialApplicationDeadline, this.applicationDeadline)) {
      this.invalidate(
        "applicationDeadline",
        "A new publication applicationDeadline must match initialApplicationDeadline."
      );
    }

    if (deadlineHistory.length > 0) {
      this.invalidate(
        "deadlineHistory",
        "A new publication cannot begin with deadline-change history."
      );
    }
  }

  if (!this.isNew && this.isModified("applicationDeadline")) {
    if (!["live", "paused"].includes(this.status)) {
      this.invalidate(
        "applicationDeadline",
        "Application deadline may only be changed while publication status is live or paused."
      );
    }

    if (!this.isModified("deadlineHistory")) {
      this.invalidate(
        "deadlineHistory",
        "Changing applicationDeadline requires a deadlineHistory entry."
      );
    }
  }

  if (deadlineHistory.length > 0) {
    if (!sameNullableDate(deadlineHistory[0].fromDeadline, this.initialApplicationDeadline)) {
      this.invalidate(
        "deadlineHistory",
        "The first deadline history entry must begin from initialApplicationDeadline."
      );
    }

    for (let index = 0; index < deadlineHistory.length; index += 1) {
      const entry = deadlineHistory[index];

      if (this.publishedAt && entry.changedAt && entry.changedAt < this.publishedAt) {
        this.invalidate(
          "deadlineHistory",
          "Application deadline cannot be changed before publication begins."
        );

        break;
      }

      if (this.expiresAt && entry.changedAt && entry.changedAt >= this.expiresAt) {
        this.invalidate(
          "deadlineHistory",
          "Application deadline cannot be changed at or after publication expiry."
        );

        break;
      }

      if (entry.toDeadline && this.expiresAt && entry.toDeadline > this.expiresAt) {
        this.invalidate(
          "deadlineHistory",
          "A changed application deadline cannot be later than publication expiry."
        );

        break;
      }

      if (index > 0) {
        const previousEntry = deadlineHistory[index - 1];

        if (!sameNullableDate(entry.fromDeadline, previousEntry.toDeadline)) {
          this.invalidate(
            "deadlineHistory",
            "Each deadline history entry must continue from the previous deadline."
          );

          break;
        }

        if (entry.changedAt < previousEntry.changedAt) {
          this.invalidate("deadlineHistory", "Application deadline history must be chronological.");

          break;
        }
      }
    }

    const latestDeadline = deadlineHistory[deadlineHistory.length - 1].toDeadline;

    if (!sameNullableDate(latestDeadline, this.applicationDeadline)) {
      this.invalidate(
        "deadlineHistory",
        "The latest deadline history entry must match the current applicationDeadline."
      );
    }
  } else if (!sameNullableDate(this.initialApplicationDeadline, this.applicationDeadline)) {
    this.invalidate("deadlineHistory", "A changed applicationDeadline requires deadline history.");
  }

  /* ─────────────────────────────── PAUSE HISTORY ─────────────────────────────── */

  for (let index = 0; index < pauses.length; index += 1) {
    const pause = pauses[index];

    const previousPause = index > 0 ? pauses[index - 1] : null;

    if (this.publishedAt && pause.pausedAt && pause.pausedAt < this.publishedAt) {
      this.invalidate(
        "pauseHistory",
        "A publication cannot be paused before its publishedAt time."
      );

      break;
    }

    if (this.expiresAt && pause.pausedAt && pause.pausedAt > this.expiresAt) {
      this.invalidate("pauseHistory", "A publication cannot be paused after its expiry time.");

      break;
    }

    if (this.expiresAt && pause.resumedAt && pause.resumedAt > this.expiresAt) {
      this.invalidate("pauseHistory", "A publication cannot resume after its expiry time.");

      break;
    }

    if (previousPause) {
      if (!previousPause.resumedAt) {
        this.invalidate(
          "pauseHistory",
          "A new pause cannot begin while the previous pause remains unresolved."
        );

        break;
      }

      if (pause.pausedAt < previousPause.resumedAt) {
        this.invalidate("pauseHistory", "Publication pause history must be chronological.");

        break;
      }
    }
  }

  const latestPause = pauses.length > 0 ? pauses[pauses.length - 1] : null;

  if (this.status === "paused") {
    if (!latestPause || latestPause.resumedAt) {
      this.invalidate(
        "status",
        "Paused publication status requires one unresolved latest pause entry."
      );
    }
  }

  if (this.status === "live" && latestPause && !latestPause.resumedAt) {
    this.invalidate("status", "A live publication cannot retain an unresolved pause entry.");
  }

  /* ─────────────────────────────── EARLY END ─────────────────────────────── */

  const hasEndAudit = hasAnyDocumentValue([this.endedAt, this.endedBy, this.endReason]);

  if (this.status === "ended") {
    if (!this.endedAt || !this.endedBy || !nonEmptyText(this.endReason)) {
      this.invalidate("status", "An ended publication requires endedAt, endedBy and endReason.");
    }

    if (this.endedAt && this.publishedAt && this.endedAt < this.publishedAt) {
      this.invalidate("endedAt", "A publication cannot end before it is published.");
    }

    if (this.endedAt && this.expiresAt && this.endedAt >= this.expiresAt) {
      this.invalidate(
        "endedAt",
        "ended status is for publication terminated before natural expiry."
      );
    }
  } else if (hasEndAudit) {
    this.invalidate(
      "endedAt",
      "Early-end audit fields may only be set when publication status is ended."
    );
  }

  /* ─────────────────────────────── EXPIRED STATE ─────────────────────────────── */

  if (this.status === "expired" && hasEndAudit) {
    this.invalidate(
      "status",
      "Naturally expired publications cannot contain early-end audit fields."
    );
  }
});

module.exports = mongoose.model("JobPublication", jobPublicationSchema);
