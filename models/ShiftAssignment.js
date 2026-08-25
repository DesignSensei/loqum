// models/ShiftAssignment.js

const mongoose = require("mongoose");

const { isNullableSafeInteger, hasDocumentValue } = require("./helpers/schemaValidators");

const { MAX_SHIFT_OCCURRENCES } = require("../constants/shiftPosting");

const {
  ASSIGNMENT_TYPES,
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_STATUSES,
  CURRENT_ASSIGNMENT_STATUSES,
  ASSIGNMENT_ACTOR_ROLES,
  ASSIGNMENT_END_REASONS,
  CASE_BASED_ASSIGNMENT_END_REASONS,
  OPEN_CASE_ALLOWED_ASSIGNMENT_STATUSES,
  REPLACED_ASSIGNMENT_ALLOWED_STATUSES,
  MAX_ASSIGNMENT_END_NOTES_LENGTH,
  MAX_ASSIGNMENT_CANCELLATION_REASON_LENGTH,
} = require("../constants/shiftAssignment");

/**
 * SHIFT ASSIGNMENT ARCHITECTURE:
 *
 * ShiftAssignment records one professional's responsibility for a defined
 * sequence range inside one parent Shift engagement.
 *
 * Shift remains the public marketplace post.
 * ShiftOccurrence remains the authoritative operational and payout record
 * for each work date.
 *
 * STATUS LIFECYCLE:
 *
 * scheduled:
 * The professional has been accepted for this assignment range, but their
 * first assigned occurrence has not started.
 *
 * active:
 * The professional is currently responsible for the assignment range and no
 * confirmed early endpoint has been recorded.
 *
 * ending:
 * An assignment exit has been confirmed. The professional remains responsible
 * through effectiveEndSequence while replacement hiring may already be open
 * for the untouched future tail.
 *
 * ended:
 * The professional's responsibility has concluded.
 *
 * cancelled:
 * The assignment was cancelled before it became active.
 *
 * REPLACEMENT:
 *
 * A replacement assignment always links to the prior assignment through
 * replacesAssignment.
 *
 * Remaining-engagement replacement:
 * - occurrence is null
 * - replacementCase is required
 * - the prior assignment may move to ending/ended
 * - the replacement assignment may become the parent Shift's current assignment
 *
 * Single-occurrence replacement:
 * - occurrence identifies exactly one ShiftOccurrence
 * - replacementCase is optional
 * - the prior assignment remains the continuing engagement assignment
 * - the prior assignment is not marked replacedByAssignment merely because one
 *   occurrence is reassigned
 * - the isolated replacement assignment never becomes the parent Shift's current
 *   assignment
 *
 * FINANCIAL AUTHORITY:
 *
 * ShiftAssignment explains why a professional owns an occurrence.
 * ShiftOccurrence.assignedProfessional remains the authoritative payout
 * recipient for that specific work date.
 */

function nullableSequenceField({ min = 1, message }) {
  return {
    type: Number,
    default: null,
    min,
    max: MAX_SHIFT_OCCURRENCES,
    validate: {
      validator: isNullableSafeInteger,
      message,
    },
  };
}

function sameId(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left) === String(right);
}

function hasAnyValue(values) {
  return values.some(hasDocumentValue);
}

const shiftAssignmentSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      unique: true,
      // Example: LQM-ABC123-A01.
    },

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
    },

    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    // --- ASSIGNMENT ORIGIN ---

    assignmentType: {
      type: String,
      enum: ASSIGNMENT_TYPES,
      required: true,
    },

    source: {
      type: String,
      enum: ASSIGNMENT_SOURCES,
      default: "application",
      required: true,
    },

    application: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftApplication",
      default: null,
    },

    /**
     * null:
     * Ordinary initial assignment or remaining-engagement replacement.
     *
     * ObjectId:
     * This assignment exists only for one specific ShiftOccurrence.
     *
     * Only replacement assignments may target one occurrence.
     */
    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    replacesAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    replacedByAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
      // Used when this assignment itself is replaced as an engagement range.
      //
      // Do not set this on a continuing assignment merely because one of its
      // occurrences is reassigned to another professional.
    },

    replacementCase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignmentCase",
      default: null,
      // Required for remaining-engagement replacement assignments under the
      // protected exit workflow. Optional for one-occurrence replacement.
    },

    // --- CASE WORKFLOW LINKS ---

    openCase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignmentCase",
      default: null,
      // Current unresolved professional-exit or employer-issue case.
    },

    endCase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignmentCase",
      default: null,
      // Case that confirmed an early assignment endpoint.
    },

    endingRequestedAt: {
      type: Date,
      default: null,
    },

    endingConfirmedAt: {
      type: Date,
      default: null,
    },

    endingConfirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    endingConfirmedByRole: {
      type: String,
      enum: [...ASSIGNMENT_ACTOR_ROLES, null],
      default: null,
    },

    // --- PLANNED RESPONSIBILITY RANGE ---

    startSequence: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: Number.isSafeInteger,
        message: "startSequence must be a whole number.",
      },
    },

    plannedEndSequence: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: Number.isSafeInteger,
        message: "plannedEndSequence must be a whole number.",
      },
    },

    plannedOccurrenceCount: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SHIFT_OCCURRENCES,
      validate: {
        validator: Number.isSafeInteger,
        message: "plannedOccurrenceCount must be a whole number.",
      },
    },

    startsAt: {
      type: Date,
      required: true,
    },

    plannedEndsAt: {
      type: Date,
      required: true,
    },

    // --- EFFECTIVE RESPONSIBILITY END ---
    //
    // These fields remain null for scheduled and ordinary active assignments.
    // They are set when an early endpoint is confirmed or when the assignment
    // reaches its final completed occurrence.

    effectiveEndSequence: nullableSequenceField({
      message: "effectiveEndSequence must be a whole number.",
    }),

    effectiveOccurrenceCount: nullableSequenceField({
      min: 1,
      message: "effectiveOccurrenceCount must be a whole number.",
    }),

    effectiveEndsAt: {
      type: Date,
      default: null,
    },

    // --- STATUS AND ACTIVATION ---

    status: {
      type: String,
      enum: ASSIGNMENT_STATUSES,
      default: "scheduled",
      required: true,
    },

    isCurrentAssignment: {
      type: Boolean,
      default: false,
      required: true,
      // Derived from status and assignment scope.
      //
      // Ordinary assignments may be current while active or ending.
      // Occurrence-targeted assignments are never the parent Shift's current
      // engagement assignment.
    },

    assignedAt: {
      type: Date,
      default: Date.now,
      required: true,
      // Time the professional was accepted for this assignment.
    },

    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    activatedAt: {
      type: Date,
      default: null,
      // Time the assignment became operationally active.
    },

    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // --- ENDING AND ENDED AUDIT ---

    endedAt: {
      type: Date,
      default: null,
    },

    endedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    endedByRole: {
      type: String,
      enum: [...ASSIGNMENT_ACTOR_ROLES, null],
      default: null,
    },

    endReason: {
      type: String,
      enum: [...ASSIGNMENT_END_REASONS, null],
      default: null,
    },

    endNotes: {
      type: String,
      trim: true,
      maxlength: MAX_ASSIGNMENT_END_NOTES_LENGTH,
      default: null,
    },

    // --- PRE-ACTIVATION CANCELLATION ---

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancelledByRole: {
      type: String,
      enum: [...ASSIGNMENT_ACTOR_ROLES, null],
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: MAX_ASSIGNMENT_CANCELLATION_REASON_LENGTH,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── MODEL VALIDATION ─────────────────────────────── */

shiftAssignmentSchema.pre("validate", function validateShiftAssignment() {
  const status = this.status || "scheduled";

  const isScheduled = status === "scheduled";

  const isActive = status === "active";

  const isEnding = status === "ending";

  const isEnded = status === "ended";

  const isCancelled = status === "cancelled";

  const hasOccurrenceTarget = hasDocumentValue(this.occurrence);

  const shouldBeCurrent = !hasOccurrenceTarget && CURRENT_ASSIGNMENT_STATUSES.includes(status);

  this.isCurrentAssignment = shouldBeCurrent;

  // --- PLANNED RANGE ---

  if (Number.isSafeInteger(this.startSequence) && Number.isSafeInteger(this.plannedEndSequence)) {
    if (this.plannedEndSequence < this.startSequence) {
      this.invalidate(
        "plannedEndSequence",
        "plannedEndSequence cannot be earlier than startSequence."
      );
    }

    const calculatedPlannedCount = this.plannedEndSequence - this.startSequence + 1;

    if (this.plannedOccurrenceCount !== calculatedPlannedCount) {
      this.invalidate(
        "plannedOccurrenceCount",
        "plannedOccurrenceCount must match the planned sequence range."
      );
    }
  }

  if (this.startsAt && this.plannedEndsAt && this.plannedEndsAt <= this.startsAt) {
    this.invalidate("plannedEndsAt", "plannedEndsAt must be later than startsAt.");
  }

  if (hasOccurrenceTarget) {
    if (this.assignmentType !== "replacement") {
      this.invalidate(
        "occurrence",
        "Only a replacement assignment may target one specific occurrence."
      );
    }

    if (
      Number.isSafeInteger(this.startSequence) &&
      Number.isSafeInteger(this.plannedEndSequence) &&
      this.startSequence !== this.plannedEndSequence
    ) {
      this.invalidate(
        "plannedEndSequence",
        "An occurrence-targeted assignment must cover exactly one sequence."
      );
    }

    if (this.plannedOccurrenceCount !== 1) {
      this.invalidate(
        "plannedOccurrenceCount",
        "An occurrence-targeted assignment must have plannedOccurrenceCount of 1."
      );
    }
  }

  // --- ORIGIN AND REPLACEMENT LINKS ---

  if (this.source === "application" && !this.application) {
    this.invalidate(
      "application",
      "An application-sourced assignment must reference its accepted application."
    );
  }

  if (this.source !== "application" && this.application) {
    this.invalidate(
      "application",
      "Only an application-sourced assignment may reference a ShiftApplication."
    );
  }

  if (this.assignmentType === "initial") {
    if (this.replacesAssignment) {
      this.invalidate(
        "replacesAssignment",
        "An initial assignment cannot replace another assignment."
      );
    }

    if (this.replacementCase) {
      this.invalidate(
        "replacementCase",
        "An initial assignment cannot reference a replacement case."
      );
    }

    if (hasOccurrenceTarget) {
      this.invalidate("occurrence", "An initial assignment cannot target one specific occurrence.");
    }
  }

  if (this.assignmentType === "replacement") {
    if (!this.replacesAssignment) {
      this.invalidate(
        "replacesAssignment",
        "A replacement assignment must identify the assignment whose responsibility it replaces."
      );
    }

    if (!hasOccurrenceTarget && !this.replacementCase) {
      this.invalidate(
        "replacementCase",
        "A remaining-engagement replacement assignment must reference the assignment case that opened replacement hiring."
      );
    }
  }

  if (this.replacesAssignment && sameId(this.replacesAssignment, this._id)) {
    this.invalidate("replacesAssignment", "An assignment cannot replace itself.");
  }

  if (this.replacedByAssignment && sameId(this.replacedByAssignment, this._id)) {
    this.invalidate("replacedByAssignment", "An assignment cannot be replaced by itself.");
  }

  if (
    this.replacesAssignment &&
    this.replacedByAssignment &&
    sameId(this.replacesAssignment, this.replacedByAssignment)
  ) {
    this.invalidate(
      "replacedByAssignment",
      "The assignment being replaced cannot also be the assignment replacing this record."
    );
  }

  if (this.replacedByAssignment && !REPLACED_ASSIGNMENT_ALLOWED_STATUSES.includes(status)) {
    this.invalidate(
      "replacedByAssignment",
      "replacedByAssignment may only be recorded on an ending or ended assignment."
    );
  }

  // --- OPEN CASE ---

  if (this.openCase && !OPEN_CASE_ALLOWED_ASSIGNMENT_STATUSES.includes(status)) {
    this.invalidate(
      "openCase",
      "An unresolved assignment case may only remain on a scheduled or active assignment."
    );
  }

  if (this.openCase && this.endCase) {
    this.invalidate(
      "openCase",
      "An assignment cannot retain an open case after an end case has been confirmed."
    );
  }

  // --- ACTIVATION ---

  const hasActivatedAt = hasDocumentValue(this.activatedAt);

  const hasActivatedBy = hasDocumentValue(this.activatedBy);

  if (hasActivatedAt !== hasActivatedBy) {
    this.invalidate("activatedAt", "activatedAt and activatedBy must be recorded together.");
  }

  if (isScheduled) {
    if (hasActivatedAt || hasActivatedBy) {
      this.invalidate("activatedAt", "A scheduled assignment cannot contain activation details.");
    }
  }

  if (isActive || isEnding || isEnded) {
    /*
     * Preserve compatibility for assignments created before activatedAt and
     * activatedBy were introduced.
     */
    if (!this.activatedAt && this.assignedAt) {
      this.activatedAt = this.assignedAt;
    }

    if (!this.activatedBy && this.assignedBy) {
      this.activatedBy = this.assignedBy;
    }

    if (!this.activatedAt || !this.activatedBy) {
      this.invalidate("activatedAt", `${status} requires activatedAt and activatedBy.`);
    }
  }

  if (this.activatedAt && this.assignedAt && this.activatedAt < this.assignedAt) {
    this.invalidate("activatedAt", "activatedAt cannot be earlier than assignedAt.");
  }

  // --- EFFECTIVE END RANGE ---

  const effectiveValues = [
    this.effectiveEndSequence,
    this.effectiveOccurrenceCount,
    this.effectiveEndsAt,
  ];

  const effectiveValueCount = effectiveValues.filter(hasDocumentValue).length;

  if (effectiveValueCount > 0 && effectiveValueCount !== effectiveValues.length) {
    this.invalidate(
      "effectiveEndSequence",
      "effectiveEndSequence, effectiveOccurrenceCount and effectiveEndsAt must be recorded together."
    );
  }

  if (effectiveValueCount === effectiveValues.length) {
    if (
      Number.isSafeInteger(this.effectiveEndSequence) &&
      Number.isSafeInteger(this.startSequence)
    ) {
      if (
        this.effectiveEndSequence < this.startSequence ||
        this.effectiveEndSequence > this.plannedEndSequence
      ) {
        this.invalidate(
          "effectiveEndSequence",
          "effectiveEndSequence must fall within the planned assignment range."
        );
      }

      const calculatedEffectiveCount = this.effectiveEndSequence - this.startSequence + 1;

      if (this.effectiveOccurrenceCount !== calculatedEffectiveCount) {
        this.invalidate(
          "effectiveOccurrenceCount",
          "effectiveOccurrenceCount must match the effective sequence range."
        );
      }
    }

    if (this.effectiveEndsAt && this.startsAt && this.effectiveEndsAt <= this.startsAt) {
      this.invalidate("effectiveEndsAt", "effectiveEndsAt must be later than startsAt.");
    }

    if (this.effectiveEndsAt && this.plannedEndsAt && this.effectiveEndsAt > this.plannedEndsAt) {
      this.invalidate("effectiveEndsAt", "effectiveEndsAt cannot be later than plannedEndsAt.");
    }
  }

  // --- ENDING REQUEST AND CONFIRMATION ---

  const endingWorkflowValues = [
    this.endCase,
    this.endingRequestedAt,
    this.endingConfirmedAt,
    this.endingConfirmedByRole,
  ];

  const hasAnyEndingWorkflowValue = hasAnyValue(endingWorkflowValues);

  if (hasAnyEndingWorkflowValue) {
    if (
      !this.endCase ||
      !this.endingRequestedAt ||
      !this.endingConfirmedAt ||
      !this.endingConfirmedByRole
    ) {
      this.invalidate(
        "endCase",
        "Confirmed ending workflow data requires endCase, endingRequestedAt, endingConfirmedAt and endingConfirmedByRole."
      );
    }

    if (
      this.endingConfirmedByRole &&
      this.endingConfirmedByRole !== "system" &&
      !this.endingConfirmedBy
    ) {
      this.invalidate(
        "endingConfirmedBy",
        "endingConfirmedBy is required when a user confirms the assignment ending."
      );
    }

    if (
      this.endingConfirmedAt &&
      this.endingRequestedAt &&
      this.endingConfirmedAt < this.endingRequestedAt
    ) {
      this.invalidate(
        "endingConfirmedAt",
        "endingConfirmedAt cannot be earlier than endingRequestedAt."
      );
    }
  } else if (this.endingConfirmedBy) {
    this.invalidate(
      "endingConfirmedBy",
      "endingConfirmedBy cannot be recorded without confirmed ending workflow data."
    );
  }

  // --- SCHEDULED ---

  if (isScheduled) {
    if (effectiveValueCount > 0) {
      this.invalidate(
        "effectiveEndSequence",
        "A scheduled assignment cannot contain an effective end range."
      );
    }

    if (hasAnyEndingWorkflowValue || this.endingConfirmedBy || this.endReason || this.endNotes) {
      this.invalidate("status", "A scheduled assignment cannot contain ending details.");
    }

    if (this.endedAt || this.endedBy || this.endedByRole) {
      this.invalidate("status", "A scheduled assignment cannot contain ended details.");
    }

    if (this.cancelledAt || this.cancelledBy || this.cancelledByRole || this.cancellationReason) {
      this.invalidate(
        "status",
        "A scheduled assignment cannot contain cancellation details unless status is cancelled."
      );
    }
  }

  // --- ACTIVE ---

  if (isActive) {
    if (effectiveValueCount > 0) {
      this.invalidate(
        "effectiveEndSequence",
        "An active assignment cannot have an effective end range."
      );
    }

    if (hasAnyEndingWorkflowValue || this.endingConfirmedBy || this.endReason || this.endNotes) {
      this.invalidate("status", "An active assignment cannot contain confirmed ending details.");
    }

    if (this.endedAt || this.endedBy || this.endedByRole) {
      this.invalidate("status", "An active assignment cannot contain ended details.");
    }

    if (this.cancelledAt || this.cancelledBy || this.cancelledByRole || this.cancellationReason) {
      this.invalidate("status", "An active assignment cannot contain cancellation details.");
    }
  }

  // --- ENDING ---

  if (isEnding) {
    if (effectiveValueCount !== effectiveValues.length) {
      this.invalidate(
        "effectiveEndSequence",
        "An ending assignment requires a complete effective end range."
      );
    }

    if (
      Number.isSafeInteger(this.effectiveEndSequence) &&
      Number.isSafeInteger(this.plannedEndSequence) &&
      this.effectiveEndSequence >= this.plannedEndSequence
    ) {
      this.invalidate(
        "effectiveEndSequence",
        "An ending assignment must leave at least one untouched future occurrence for replacement."
      );
    }

    if (!this.endReason) {
      this.invalidate("endReason", "endReason is required when an assignment is ending.");
    }

    if (!this.endCase) {
      this.invalidate("endCase", "endCase is required when an assignment is ending.");
    }

    if (!this.endingConfirmedAt || !this.endingConfirmedByRole) {
      this.invalidate(
        "endingConfirmedAt",
        "An ending assignment requires confirmed ending audit details."
      );
    }

    if (this.endedAt || this.endedBy || this.endedByRole) {
      this.invalidate("status", "An ending assignment cannot contain final ended details.");
    }

    if (this.cancelledAt || this.cancelledBy || this.cancelledByRole || this.cancellationReason) {
      this.invalidate("status", "An ending assignment cannot contain cancellation details.");
    }
  }

  // --- ENDED ---

  if (isEnded) {
    if (!this.endedAt) {
      this.invalidate("endedAt", "endedAt is required when an assignment is ended.");
    }

    if (!this.endedByRole) {
      this.invalidate("endedByRole", "endedByRole is required when an assignment is ended.");
    }

    if (this.endedByRole && this.endedByRole !== "system" && !this.endedBy) {
      this.invalidate("endedBy", "endedBy is required when a user ends the assignment.");
    }

    if (!this.endReason) {
      this.invalidate("endReason", "endReason is required when an assignment is ended.");
    }

    if (effectiveValueCount !== effectiveValues.length) {
      this.invalidate(
        "effectiveEndSequence",
        "An ended assignment requires a complete effective end range."
      );
    }

    if (this.endedAt && this.activatedAt && this.endedAt < this.activatedAt) {
      this.invalidate("endedAt", "endedAt cannot be earlier than activatedAt.");
    }

    if (this.endedAt && this.effectiveEndsAt && this.endedAt < this.effectiveEndsAt) {
      this.invalidate("endedAt", "endedAt cannot be earlier than effectiveEndsAt.");
    }

    if (this.endReason === "engagement_completed") {
      if (this.effectiveEndSequence !== this.plannedEndSequence) {
        this.invalidate(
          "effectiveEndSequence",
          "A completed assignment must end at plannedEndSequence."
        );
      }

      if (this.effectiveOccurrenceCount !== this.plannedOccurrenceCount) {
        this.invalidate(
          "effectiveOccurrenceCount",
          "A completed assignment must cover its full planned occurrence count."
        );
      }

      if (this.endCase || hasAnyEndingWorkflowValue || this.endingConfirmedBy) {
        this.invalidate(
          "endCase",
          "A normally completed assignment cannot contain an early-exit case."
        );
      }
    }

    if (CASE_BASED_ASSIGNMENT_END_REASONS.includes(this.endReason) && !this.endCase) {
      this.invalidate(
        "endCase",
        `${this.endReason} requires the ShiftAssignmentCase that authorized the early ending.`
      );
    }

    if (
      CASE_BASED_ASSIGNMENT_END_REASONS.includes(this.endReason) &&
      (!this.endingRequestedAt || !this.endingConfirmedAt || !this.endingConfirmedByRole)
    ) {
      this.invalidate(
        "endingConfirmedAt",
        `${this.endReason} requires complete ending request and confirmation audit data.`
      );
    }

    if (this.cancelledAt || this.cancelledBy || this.cancelledByRole || this.cancellationReason) {
      this.invalidate("status", "An ended assignment cannot also contain cancellation details.");
    }
  }

  // --- CANCELLED ---

  if (isCancelled) {
    if (hasActivatedAt || hasActivatedBy) {
      this.invalidate("activatedAt", "A cancelled assignment must not have become active.");
    }

    if (effectiveValueCount > 0) {
      this.invalidate(
        "effectiveEndSequence",
        "A cancelled assignment cannot contain an effective end range."
      );
    }

    if (
      hasAnyEndingWorkflowValue ||
      this.endingConfirmedBy ||
      this.endReason ||
      this.endNotes ||
      this.endedAt ||
      this.endedBy ||
      this.endedByRole
    ) {
      this.invalidate(
        "status",
        "A cancelled assignment cannot also contain ending or ended details."
      );
    }

    if (!this.cancelledAt) {
      this.invalidate("cancelledAt", "cancelledAt is required when an assignment is cancelled.");
    }

    if (!this.cancelledByRole) {
      this.invalidate(
        "cancelledByRole",
        "cancelledByRole is required when an assignment is cancelled."
      );
    }

    if (this.cancelledByRole && this.cancelledByRole !== "system" && !this.cancelledBy) {
      this.invalidate("cancelledBy", "cancelledBy is required when a user cancels the assignment.");
    }

    if (!this.cancellationReason) {
      this.invalidate(
        "cancellationReason",
        "cancellationReason is required when an assignment is cancelled."
      );
    }

    if (this.cancelledAt && this.assignedAt && this.cancelledAt < this.assignedAt) {
      this.invalidate("cancelledAt", "cancelledAt cannot be earlier than assignedAt.");
    }

    if (this.replacedByAssignment) {
      this.invalidate(
        "replacedByAssignment",
        "A cancelled assignment cannot be marked as replaced."
      );
    }
  }

  // --- TERMINAL FIELD CONSISTENCY ---

  if (!isEnded && (this.endedAt || this.endedBy || this.endedByRole)) {
    this.invalidate(
      "endedAt",
      "endedAt, endedBy and endedByRole may only be recorded when status is ended."
    );
  }

  if (
    !isCancelled &&
    (this.cancelledAt || this.cancelledBy || this.cancelledByRole || this.cancellationReason)
  ) {
    this.invalidate(
      "cancelledAt",
      "Cancellation details may only be recorded when status is cancelled."
    );
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

shiftAssignmentSchema.index(
  {
    shift: 1,
    isCurrentAssignment: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      isCurrentAssignment: true,
    },
  }
);

/**
 * One ordinary scheduled engagement assignment per parent Shift.
 *
 * Occurrence-targeted assignments are excluded because they do not replace
 * the parent Shift's continuing assignment.
 */
shiftAssignmentSchema.index(
  {
    shift: 1,
    status: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      status: "scheduled",
      occurrence: null,
    },
  }
);

/**
 * A specific occurrence may have only one scheduled isolated assignment.
 *
 * Final transactional guards in the assignment service will still verify that
 * the occurrence has not already been assigned before acceptance commits.
 */
shiftAssignmentSchema.index(
  {
    occurrence: 1,
    status: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      status: "scheduled",
      occurrence: {
        $type: "objectId",
      },
    },
  }
);

shiftAssignmentSchema.index(
  {
    application: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      application: {
        $type: "objectId",
      },
    },
  }
);

shiftAssignmentSchema.index({
  occurrence: 1,
  status: 1,
  startsAt: 1,
});

shiftAssignmentSchema.index({
  shift: 1,
  startSequence: 1,
  plannedEndSequence: 1,
});

shiftAssignmentSchema.index({
  shift: 1,
  status: 1,
  startsAt: 1,
});

shiftAssignmentSchema.index({
  professional: 1,
  status: 1,
  startsAt: 1,
});

shiftAssignmentSchema.index({
  business: 1,
  status: 1,
  startsAt: 1,
});

shiftAssignmentSchema.index({
  branch: 1,
  status: 1,
  startsAt: 1,
});

shiftAssignmentSchema.index({
  replacesAssignment: 1,
});

shiftAssignmentSchema.index({
  replacedByAssignment: 1,
});

shiftAssignmentSchema.index({
  replacementCase: 1,
});

shiftAssignmentSchema.index({
  openCase: 1,
});

shiftAssignmentSchema.index({
  endCase: 1,
});

shiftAssignmentSchema.index({
  status: 1,
  activatedAt: 1,
});

shiftAssignmentSchema.index({
  status: 1,
  effectiveEndsAt: 1,
});

module.exports = mongoose.model("ShiftAssignment", shiftAssignmentSchema);
