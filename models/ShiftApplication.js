// models/ShiftApplication.js

const mongoose = require("mongoose");

const {
  MAX_APPLICATION_ROUNDS,
  APPLICATION_TYPES,
  APPLICATION_STATUSES,
  EMPLOYER_REVIEW_STATUSES,
  TERMINAL_APPLICATION_STATUSES,
} = require("../constants/shiftApplication");

/**
 * SHIFT APPLICATION MODEL
 *
 * ShiftApplication records one professional's application for one hiring
 * opportunity belonging to a parent Shift engagement.
 *
 * APPLICATION AUTHORITY
 *
 * Every application belongs to one parent Shift.
 *
 * An application may additionally target one exact ShiftOccurrence when an
 * individual future occurrence has been reopened for isolated replacement.
 *
 * ShiftApplication does not own:
 *
 * - occurrence assignment state;
 * - attendance state;
 * - cancellation state;
 * - worked time;
 * - professional settlement;
 * - platform-fee accounting; or
 * - employer refunds.
 *
 * Those responsibilities belong to their occurrence-level authorities.
 *
 * HIRING OPPORTUNITY TYPES
 *
 * Initial engagement hiring:
 *
 * applicationType: initial
 * applicationRound: 1
 * occurrence: null
 *
 * Remaining-engagement replacement hiring:
 *
 * applicationType: replacement
 * applicationRound: 2 or greater
 * occurrence: null
 *
 * Isolated occurrence replacement:
 *
 * applicationType: replacement
 * applicationRound: 2 or greater
 * occurrence: <ShiftOccurrence._id>
 *
 * OCCURRENCE-TARGETED REPLACEMENT
 *
 * For an isolated replacement:
 *
 * - occurrence identifies the exact ShiftOccurrence being refilled;
 * - replacementForAssignment identifies the assignment that previously owned
 *   that occurrence;
 * - acceptance creates a replacement ShiftAssignment for that occurrence;
 * - only that occurrence changes professional ownership; and
 * - the continuing professional's main assignment and later occurrences remain
 *   unchanged.
 *
 * An isolated replacement assignment must not become the parent Shift's
 * continuing engagement assignment.
 *
 * APPLICATION ROUNDS
 *
 * Ordinary parent-level hiring and isolated occurrence hiring have independent
 * uniqueness scopes.
 *
 * This means two different replacement-required occurrences under the same
 * parent Shift may both independently use applicationRound 2.
 *
 * The occurrence itself distinguishes those opportunities.
 *
 * REPLACEMENT ASSIGNMENT
 *
 * replacementForAssignment identifies the previous ShiftAssignment whose
 * professional previously owned the work being replaced.
 *
 * It is required for every replacement application.
 *
 * ACCEPTED ASSIGNMENT
 *
 * acceptedAssignment identifies the ShiftAssignment created from this
 * application.
 *
 * It is set only after acceptance.
 *
 * ACCEPTANCE
 *
 * accepted means:
 *
 * - the employer selected the professional;
 * - the appropriate ShiftAssignment was created; and
 * - the relevant ShiftOccurrence record or records were assigned.
 *
 * It does not mean:
 *
 * - attendance completed;
 * - professional earnings were approved;
 * - money was released;
 * - platform fees were collected; or
 * - settlement completed.
 *
 * Parent Shift state is reconciled separately from authoritative occurrence
 * state. Replacement acceptance must never blindly force the parent Shift to
 * confirmed.
 *
 * SCHEDULE CONFLICTS
 *
 * Schedule-overlap enforcement belongs to ShiftApplicationService.
 *
 * It runs:
 *
 * 1. when the professional applies; and
 * 2. again transactionally when the employer accepts.
 *
 * For isolated replacement, only the targeted occurrence interval is tested.
 *
 * FUTURE CREDITS
 *
 * Credits remain dormant while creditsEnabled is false in PlatformSettings.
 * The credit fields remain available for the future application-credit flow.
 */

/* ─────────────────────────────── SCHEMA ─────────────────────────────── */

const shiftApplicationSchema = new mongoose.Schema(
  {
    /* ─────────────────────────────── CORE RELATIONSHIPS ─────────────────────────────── */

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    /**
     * null
     *
     * - initial parent-Shift hiring; or
     * - remaining-engagement replacement hiring.
     *
     * ObjectId
     *
     * - isolated replacement for one exact ShiftOccurrence.
     *
     * Only replacement applications may target an occurrence.
     */
    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    /* ─────────────────────────────── APPLICATION ROUND ─────────────────────────────── */

    applicationType: {
      type: String,
      enum: APPLICATION_TYPES,
      default: "initial",
      required: true,
    },

    applicationRound: {
      type: Number,
      default: 1,
      required: true,
      min: 1,
      max: MAX_APPLICATION_ROUNDS,
      validate: {
        validator: Number.isSafeInteger,
        message: "applicationRound must be a whole number.",
      },
    },

    /**
     * Required for every replacement application.
     *
     * Parent-tail replacement:
     * identifies the assignment whose untouched future tail is being replaced.
     *
     * Isolated replacement:
     * identifies the assignment that previously owned the targeted occurrence.
     */
    replacementForAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    /**
     * Set only after application acceptance.
     *
     * Identifies the ShiftAssignment created from this application.
     */
    acceptedAssignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
      default: null,
    },

    /* ─────────────────────────────── APPLICATION STATUS ─────────────────────────────── */

    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: "pending",
      required: true,
    },

    /* ─────────────────────────────── PROFESSIONAL NOTE ─────────────────────────────── */

    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    /* ─────────────────────────────── EMPLOYER REVIEW ─────────────────────────────── */

    reviewedAt: {
      type: Date,
      default: null,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    employerPrivateNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    /* ─────────────────────────────── STATUS TIMESTAMPS ─────────────────────────────── */

    shortlistedAt: {
      type: Date,
      default: null,
    },

    acceptedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    rejectedReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    withdrawnAt: {
      type: Date,
      default: null,
    },

    withdrawalReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    expiredAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    /* ─────────────────────────────── MATCHING SNAPSHOT ─────────────────────────────── */

    matchSnapshot: {
      professionalType: {
        type: String,
        trim: true,
        default: null,
      },

      specialty: {
        type: String,
        trim: true,
        default: null,
      },

      yearsOfExperience: {
        type: Number,
        min: 0,
        default: null,
      },

      preferredRate: {
        type: Number,
        min: 0,
        default: null,
      },

      distanceKm: {
        type: Number,
        min: 0,
        default: null,
      },

      rating: {
        type: Number,
        min: 0,
        max: 5,
        default: null,
      },

      completedShifts: {
        type: Number,
        min: 0,
        default: null,
      },
    },

    /* ─────────────────────────────── FUTURE CREDITS ─────────────────────────────── */

    credits: {
      used: {
        type: Boolean,
        default: false,
      },

      applicationCreditsUsed: {
        type: Number,
        min: 0,
        default: 0,
        validate: {
          validator: Number.isSafeInteger,
          message: "applicationCreditsUsed must be a whole number.",
        },
      },

      boostCreditsUsed: {
        type: Number,
        min: 0,
        default: 0,
        validate: {
          validator: Number.isSafeInteger,
          message: "boostCreditsUsed must be a whole number.",
        },
      },

      totalCreditsUsed: {
        type: Number,
        min: 0,
        default: 0,
        validate: {
          validator: Number.isSafeInteger,
          message: "totalCreditsUsed must be a whole number.",
        },
      },

      isBoosted: {
        type: Boolean,
        default: false,
      },

      boostLevel: {
        type: String,
        enum: ["standard", "priority", "premium", null],
        default: null,
      },

      creditTransactions: {
        type: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CreditTransaction",
          },
        ],
        default: [],
      },

      refunded: {
        type: Boolean,
        default: false,
      },

      refundedAt: {
        type: Date,
        default: null,
      },

      refundReason: {
        type: String,
        enum: [
          "employer_cancelled_shift",
          "shift_withdrawn",
          "shift_expired_without_selection",
          "loqum_removed_shift",
          "shift_details_changed",
          "admin_refund",
          null,
        ],
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── VALIDATION HELPERS ─────────────────────────────── */

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function sameId(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left) === String(right);
}

function invalidateTerminalConflict(application, fieldName, message) {
  if (hasValue(application[fieldName])) {
    application.invalidate(fieldName, message);
  }
}

function validateSafeNonNegativeIntegerSnapshot(application, fieldName, value, message) {
  if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    application.invalidate(fieldName, message);
  }
}

/* ─────────────────────────────── VALIDATION / AUTO-TIMESTAMPS ─────────────────────────────── */

shiftApplicationSchema.pre("validate", function validateShiftApplication() {
  const now = new Date();

  /* ─────────────────────────────── APPLICATION SCOPE ─────────────────────────────── */

  if (this.applicationType === "initial") {
    if (this.applicationRound !== 1) {
      this.invalidate(
        "applicationRound",
        "An initial application must belong to application round 1."
      );
    }

    if (this.replacementForAssignment) {
      this.invalidate(
        "replacementForAssignment",
        "An initial application cannot reference a replaced assignment."
      );
    }

    if (this.occurrence) {
      this.invalidate("occurrence", "An initial application cannot target a single occurrence.");
    }
  }

  if (this.applicationType === "replacement") {
    if (!Number.isSafeInteger(this.applicationRound) || this.applicationRound < 2) {
      this.invalidate(
        "applicationRound",
        "A replacement application must belong to application round 2 or greater."
      );
    }

    if (!this.replacementForAssignment) {
      this.invalidate(
        "replacementForAssignment",
        "A replacement application must identify the assignment being replaced."
      );
    }
  }

  /* ─────────────────────────────── ASSIGNMENT LINKS ─────────────────────────────── */

  if (sameId(this.replacementForAssignment, this.acceptedAssignment)) {
    this.invalidate(
      "acceptedAssignment",
      "The accepted assignment cannot be the assignment being replaced."
    );
  }

  /* ─────────────────────────────── AUTO TIMESTAMPS ─────────────────────────────── */

  if (this.status === "shortlisted" && !this.shortlistedAt) {
    this.shortlistedAt = now;
  }

  if (this.status === "accepted" && !this.acceptedAt) {
    this.acceptedAt = now;
  }

  if (this.status === "rejected" && !this.rejectedAt) {
    this.rejectedAt = now;
  }

  if (this.status === "withdrawn" && !this.withdrawnAt) {
    this.withdrawnAt = now;
  }

  if (this.status === "expired" && !this.expiredAt) {
    this.expiredAt = now;
  }

  if (this.status === "cancelled" && !this.cancelledAt) {
    this.cancelledAt = now;
  }

  if (EMPLOYER_REVIEW_STATUSES.includes(this.status) && !this.reviewedAt) {
    this.reviewedAt = now;
  }

  /* ─────────────────────────────── EMPLOYER REVIEW ─────────────────────────────── */

  if (EMPLOYER_REVIEW_STATUSES.includes(this.status)) {
    if (!this.reviewedAt) {
      this.invalidate("reviewedAt", "reviewedAt is required for an employer-reviewed application.");
    }

    if (!this.reviewedBy) {
      this.invalidate("reviewedBy", "reviewedBy is required for an employer-reviewed application.");
    }
  }

  if (this.reviewedBy && !this.reviewedAt) {
    this.invalidate("reviewedAt", "reviewedAt is required when reviewedBy is recorded.");
  }

  /* ─────────────────────────────── ACCEPTED ASSIGNMENT ─────────────────────────────── */

  if (this.status === "accepted") {
    if (!this.acceptedAssignment) {
      this.invalidate(
        "acceptedAssignment",
        "acceptedAssignment is required when an application is accepted."
      );
    }

    if (!this.acceptedAt) {
      this.invalidate("acceptedAt", "acceptedAt is required when an application is accepted.");
    }
  } else if (this.acceptedAssignment) {
    this.invalidate(
      "acceptedAssignment",
      "acceptedAssignment can only be set on an accepted application."
    );
  }

  /* ─────────────────────────────── STATUS-SPECIFIC REASONS ─────────────────────────────── */

  if (this.status !== "rejected" && this.rejectedReason) {
    this.invalidate("rejectedReason", "rejectedReason can only be set on a rejected application.");
  }

  if (this.status !== "withdrawn" && this.withdrawalReason) {
    this.invalidate(
      "withdrawalReason",
      "withdrawalReason can only be set on a withdrawn application."
    );
  }

  /* ─────────────────────────────── TERMINAL STATUS CONSISTENCY ─────────────────────────────── */

  /*
   * shortlistedAt may remain after later acceptance/rejection because it is
   * historical review information.
   *
   * Conflicting terminal outcomes are not allowed.
   */

  if (this.status === "accepted") {
    invalidateTerminalConflict(
      this,
      "rejectedAt",
      "An accepted application cannot also be rejected."
    );

    invalidateTerminalConflict(
      this,
      "withdrawnAt",
      "An accepted application cannot also be withdrawn."
    );

    invalidateTerminalConflict(
      this,
      "expiredAt",
      "An accepted application cannot also be expired."
    );

    invalidateTerminalConflict(
      this,
      "cancelledAt",
      "An accepted application cannot also be cancelled."
    );
  }

  if (this.status === "rejected") {
    invalidateTerminalConflict(
      this,
      "acceptedAt",
      "A rejected application cannot also be accepted."
    );

    invalidateTerminalConflict(
      this,
      "withdrawnAt",
      "A rejected application cannot also be withdrawn."
    );

    invalidateTerminalConflict(this, "expiredAt", "A rejected application cannot also be expired.");

    invalidateTerminalConflict(
      this,
      "cancelledAt",
      "A rejected application cannot also be cancelled."
    );
  }

  if (this.status === "withdrawn") {
    invalidateTerminalConflict(
      this,
      "acceptedAt",
      "A withdrawn application cannot also be accepted."
    );

    invalidateTerminalConflict(
      this,
      "rejectedAt",
      "A withdrawn application cannot also be rejected."
    );

    invalidateTerminalConflict(
      this,
      "expiredAt",
      "A withdrawn application cannot also be expired."
    );

    invalidateTerminalConflict(
      this,
      "cancelledAt",
      "A withdrawn application cannot also be cancelled."
    );
  }

  if (this.status === "expired") {
    invalidateTerminalConflict(
      this,
      "acceptedAt",
      "An expired application cannot also be accepted."
    );

    invalidateTerminalConflict(
      this,
      "rejectedAt",
      "An expired application cannot also be rejected."
    );

    invalidateTerminalConflict(
      this,
      "withdrawnAt",
      "An expired application cannot also be withdrawn."
    );

    invalidateTerminalConflict(
      this,
      "cancelledAt",
      "An expired application cannot also be cancelled."
    );
  }

  if (this.status === "cancelled") {
    invalidateTerminalConflict(
      this,
      "acceptedAt",
      "A cancelled application cannot also be accepted."
    );

    invalidateTerminalConflict(
      this,
      "rejectedAt",
      "A cancelled application cannot also be rejected."
    );

    invalidateTerminalConflict(
      this,
      "withdrawnAt",
      "A cancelled application cannot also be withdrawn."
    );

    invalidateTerminalConflict(
      this,
      "expiredAt",
      "A cancelled application cannot also be expired."
    );
  }

  if (
    !TERMINAL_APPLICATION_STATUSES.includes(this.status) &&
    (this.acceptedAt || this.rejectedAt || this.withdrawnAt || this.expiredAt || this.cancelledAt)
  ) {
    this.invalidate(
      "status",
      "A non-terminal application cannot contain terminal status timestamps."
    );
  }

  /* ─────────────────────────────── TIMESTAMP ORDER ─────────────────────────────── */

  if (this.createdAt && this.reviewedAt && this.reviewedAt < this.createdAt) {
    this.invalidate("reviewedAt", "reviewedAt cannot be earlier than application creation.");
  }

  if (this.reviewedAt && this.acceptedAt && this.acceptedAt < this.reviewedAt) {
    this.invalidate("acceptedAt", "acceptedAt cannot be earlier than reviewedAt.");
  }

  if (this.reviewedAt && this.rejectedAt && this.rejectedAt < this.reviewedAt) {
    this.invalidate("rejectedAt", "rejectedAt cannot be earlier than reviewedAt.");
  }

  if (this.createdAt && this.withdrawnAt && this.withdrawnAt < this.createdAt) {
    this.invalidate("withdrawnAt", "withdrawnAt cannot be earlier than application creation.");
  }

  if (this.createdAt && this.expiredAt && this.expiredAt < this.createdAt) {
    this.invalidate("expiredAt", "expiredAt cannot be earlier than application creation.");
  }

  if (this.createdAt && this.cancelledAt && this.cancelledAt < this.createdAt) {
    this.invalidate("cancelledAt", "cancelledAt cannot be earlier than application creation.");
  }

  /* ─────────────────────────────── MATCH SNAPSHOT ─────────────────────────────── */

  if (
    this.matchSnapshot?.yearsOfExperience !== null &&
    this.matchSnapshot?.yearsOfExperience !== undefined &&
    (!Number.isFinite(this.matchSnapshot.yearsOfExperience) ||
      this.matchSnapshot.yearsOfExperience < 0)
  ) {
    this.invalidate(
      "matchSnapshot.yearsOfExperience",
      "yearsOfExperience must be a non-negative valid number."
    );
  }

  validateSafeNonNegativeIntegerSnapshot(
    this,
    "matchSnapshot.preferredRate",
    this.matchSnapshot?.preferredRate,
    "preferredRate must be a non-negative whole number in minor currency units."
  );

  validateSafeNonNegativeIntegerSnapshot(
    this,
    "matchSnapshot.completedShifts",
    this.matchSnapshot?.completedShifts,
    "completedShifts must be a non-negative whole number."
  );

  /* ─────────────────────────────── FUTURE CREDIT CONSISTENCY ─────────────────────────────── */

  if (this.credits) {
    const applicationCreditsUsed = Number(this.credits.applicationCreditsUsed || 0);

    const boostCreditsUsed = Number(this.credits.boostCreditsUsed || 0);

    if (!Number.isSafeInteger(applicationCreditsUsed) || applicationCreditsUsed < 0) {
      this.invalidate(
        "credits.applicationCreditsUsed",
        "applicationCreditsUsed must be a non-negative whole number."
      );
    }

    if (!Number.isSafeInteger(boostCreditsUsed) || boostCreditsUsed < 0) {
      this.invalidate(
        "credits.boostCreditsUsed",
        "boostCreditsUsed must be a non-negative whole number."
      );
    }

    const totalCreditsUsed = applicationCreditsUsed + boostCreditsUsed;

    if (!Number.isSafeInteger(totalCreditsUsed)) {
      this.invalidate("credits.totalCreditsUsed", "The total credits used value is too large.");
    } else {
      this.credits.totalCreditsUsed = totalCreditsUsed;

      this.credits.used = totalCreditsUsed > 0;
    }

    if (!this.credits.isBoosted) {
      this.credits.boostLevel = null;
    } else if (!this.credits.boostLevel) {
      this.invalidate(
        "credits.boostLevel",
        "boostLevel is required when the application is boosted."
      );
    }

    const creditTransactionIds = (this.credits.creditTransactions || []).map((transactionId) =>
      String(transactionId)
    );

    if (new Set(creditTransactionIds).size !== creditTransactionIds.length) {
      this.invalidate(
        "credits.creditTransactions",
        "The same credit transaction cannot be linked more than once."
      );
    }

    if (this.credits.refunded) {
      if (!this.credits.used || totalCreditsUsed <= 0) {
        this.invalidate(
          "credits.refunded",
          "Application credits cannot be marked as refunded when no credits were used."
        );
      }

      if (!this.credits.refundedAt) {
        this.credits.refundedAt = now;
      }

      if (!this.credits.refundReason) {
        this.invalidate(
          "credits.refundReason",
          "refundReason is required when application credits are refunded."
        );
      }
    } else {
      this.credits.refundedAt = null;
      this.credits.refundReason = null;
    }
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

/**
 * ORDINARY PARENT-SHIFT HIRING
 *
 * One application per:
 *
 * - Shift
 * - professional
 * - application type
 * - application round
 *
 * occurrence must be null.
 *
 * This covers:
 *
 * - initial engagement hiring; and
 * - remaining-engagement replacement hiring.
 */
shiftApplicationSchema.index(
  {
    shift: 1,
    professional: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      occurrence: null,
    },
  }
);

/**
 * ISOLATED OCCURRENCE REPLACEMENT
 *
 * One application per:
 *
 * - Shift
 * - occurrence
 * - professional
 * - application type
 * - application round.
 *
 * Two different occurrences under the same parent Shift therefore do not
 * collide even when both are in applicationRound 2.
 */
shiftApplicationSchema.index(
  {
    shift: 1,
    occurrence: 1,
    professional: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      occurrence: {
        $type: "objectId",
      },
    },
  }
);

/**
 * ORDINARY PARENT-SHIFT ACCEPTANCE
 *
 * Only one application may be accepted for one ordinary hiring opportunity.
 */
shiftApplicationSchema.index(
  {
    shift: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      status: "accepted",
      occurrence: null,
    },
  }
);

/**
 * ISOLATED OCCURRENCE ACCEPTANCE
 *
 * Only one application may be accepted for one occurrence-specific hiring
 * opportunity.
 */
shiftApplicationSchema.index(
  {
    shift: 1,
    occurrence: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      status: "accepted",

      occurrence: {
        $type: "objectId",
      },
    },
  }
);

/**
 * One accepted application may create only one ShiftAssignment.
 */
shiftApplicationSchema.index(
  {
    acceptedAssignment: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      acceptedAssignment: {
        $type: "objectId",
      },
    },
  }
);

/**
 * Employer review of one ordinary or occurrence-targeted hiring opportunity.
 */
shiftApplicationSchema.index({
  shift: 1,
  occurrence: 1,
  applicationType: 1,
  applicationRound: 1,
  status: 1,
  createdAt: -1,
});

/**
 * Efficient lookup of the current and previous isolated replacement cycles.
 *
 * ShiftApplicationService uses replacementRequiredAt plus createdAt to
 * determine the current occurrence-specific replacement round.
 */
shiftApplicationSchema.index({
  shift: 1,
  occurrence: 1,
  applicationType: 1,
  applicationRound: -1,
  createdAt: -1,
});

/**
 * Replacement assignment context.
 */
shiftApplicationSchema.index({
  replacementForAssignment: 1,
  occurrence: 1,
  applicationType: 1,
  status: 1,
});

/**
 * General employer Shift application listing.
 */
shiftApplicationSchema.index({
  shift: 1,
  status: 1,
  createdAt: -1,
});

/**
 * Occurrence-targeted replacement lookup.
 */
shiftApplicationSchema.index({
  occurrence: 1,
  status: 1,
  createdAt: -1,
});

/**
 * Professional application history.
 */
shiftApplicationSchema.index({
  professional: 1,
  status: 1,
  createdAt: -1,
});

/**
 * General status lookup.
 */
shiftApplicationSchema.index({
  status: 1,
  createdAt: -1,
});

/**
 * Employer review workflow.
 */
shiftApplicationSchema.index({
  reviewedBy: 1,
  status: 1,
  reviewedAt: -1,
});

shiftApplicationSchema.index({
  acceptedAt: 1,
});

shiftApplicationSchema.index({
  rejectedAt: 1,
});

/**
 * Future boosted-application sorting.
 */
shiftApplicationSchema.index({
  "credits.isBoosted": 1,
  "credits.boostLevel": 1,
  createdAt: -1,
});

module.exports = mongoose.model("ShiftApplication", shiftApplicationSchema);
