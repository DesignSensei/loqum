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
 * Professionals apply once to the shared Shift for initial hiring.
 * Initial applications have no slotNumber until acceptance. Acceptance binds
 * each selected professional to one distinct position and ShiftAssignment.
 *
 * Replacement applications target the prior assignment and its stable slot.
 * occurrence is null for remaining-schedule replacement, or identifies one
 * exact occurrence for isolated replacement. Rounds belong to that opportunity.
 *
 * The service must transactionally verify slotNumber <= Shift.requiredProfessionals,
 * matching Shift/slot/assignment/occurrence links, remaining capacity and schedule
 * conflicts. Schema validation does not load those related documents.
 *
 * Acceptance does not complete attendance, approve earnings or release money.
 * Accepted applications remain historical acceptance records after assignments
 * end. Further coverage uses replacement hiring, not a second initial acceptance.
 *
 * Credits remain dormant while creditsEnabled is false in PlatformSettings.
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
     * null:
     * - initial parent-Shift hiring; or
     * - remaining-engagement replacement hiring.
     *
     * ObjectId:
     * - isolated replacement for one exact ShiftOccurrence.
     *
     * Only replacement applications may target an occurrence.
     */
    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    /**
     * Initial: null before acceptance; populated when a position is assigned.
     * Replacement: required from submission and inherited from the prior assignment.
     */
    slotNumber: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: (value) => value == null || Number.isSafeInteger(value),
        message: "slotNumber must be a positive safe whole number when supplied.",
      },
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

  return String(left._id || left) === String(right._id || right);
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

  /* ─────────────────────────────── POSITION SCOPE ─────────────────────────────── */

  const hasSlot = hasValue(this.slotNumber);

  const validSlot = Number.isSafeInteger(this.slotNumber) && this.slotNumber > 0;

  if (hasSlot && !validSlot) {
    this.invalidate("slotNumber", "slotNumber must be a positive safe whole number.");
  }

  if (this.applicationType === "initial") {
    if (this.status === "accepted" && !validSlot) {
      this.invalidate(
        "slotNumber",
        "An accepted initial application must identify its assigned position."
      );
    }

    if (this.status !== "accepted" && hasSlot) {
      this.invalidate(
        "slotNumber",
        "An initial application is assigned a position only on acceptance."
      );
    }
  }

  if (this.applicationType === "replacement" && !validSlot) {
    this.invalidate(
      "slotNumber",
      "A replacement application must identify the prior assignment's position."
    );
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

  // Preserve shortlisting history while rejecting conflicting terminal outcomes.
  const terminalTimestamps = {
    accepted: "acceptedAt",
    rejected: "rejectedAt",
    withdrawn: "withdrawnAt",
    expired: "expiredAt",
    cancelled: "cancelledAt",
  };

  if (TERMINAL_APPLICATION_STATUSES.includes(this.status)) {
    for (const [status, field] of Object.entries(terminalTimestamps)) {
      if (status !== this.status) {
        invalidateTerminalConflict(
          this,
          field,
          `A ${this.status} application cannot also contain ${field}.`
        );
      }
    }
  } else if (Object.values(terminalTimestamps).some((field) => hasValue(this[field]))) {
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

// One initial application per professional per Shift, regardless of headcount.
shiftApplicationSchema.index(
  {
    shift: 1,
    professional: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    name: "unique_initial_application_per_professional",
    unique: true,
    partialFilterExpression: {
      applicationType: "initial",
      occurrence: null,
    },
  }
);

// Independent remaining-schedule opportunities for different prior assignments.
shiftApplicationSchema.index(
  {
    shift: 1,
    replacementForAssignment: 1,
    professional: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    name: "unique_tail_replacement_application",
    unique: true,
    partialFilterExpression: {
      applicationType: "replacement",
      occurrence: null,
    },
  }
);

// The occurrence and prior assignment identify the isolated replacement context.
shiftApplicationSchema.index(
  {
    shift: 1,
    occurrence: 1,
    replacementForAssignment: 1,
    professional: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    name: "unique_isolated_replacement_application",
    unique: true,
    partialFilterExpression: {
      applicationType: "replacement",
      occurrence: {
        $type: "objectId",
      },
    },
  }
);

// Multiple initial acceptances are allowed, with one initial acceptance per slot.
shiftApplicationSchema.index(
  {
    shift: 1,
    slotNumber: 1,
  },
  {
    name: "unique_initial_acceptance_per_slot",
    unique: true,
    partialFilterExpression: {
      applicationType: "initial",
      status: "accepted",
    },
  }
);

// One accepted applicant for each remaining-schedule replacement round.
shiftApplicationSchema.index(
  {
    shift: 1,
    replacementForAssignment: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    name: "unique_tail_replacement_acceptance",
    unique: true,
    partialFilterExpression: {
      applicationType: "replacement",
      status: "accepted",
      occurrence: null,
    },
  }
);

// One accepted applicant for each isolated replacement round.
shiftApplicationSchema.index(
  {
    shift: 1,
    occurrence: 1,
    replacementForAssignment: 1,
    applicationType: 1,
    applicationRound: 1,
  },
  {
    name: "unique_isolated_replacement_acceptance",
    unique: true,
    partialFilterExpression: {
      applicationType: "replacement",
      status: "accepted",
      occurrence: {
        $type: "objectId",
      },
    },
  }
);

// One assignment cannot be linked as the result of two accepted applications.
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

shiftApplicationSchema.index({
  shift: 1,
  occurrence: 1,
  applicationType: 1,
  applicationRound: 1,
  status: 1,
  createdAt: -1,
});

// Retrieve rounds within the exact replacement opportunity.
shiftApplicationSchema.index({
  shift: 1,
  replacementForAssignment: 1,
  occurrence: 1,
  applicationType: 1,
  applicationRound: -1,
  createdAt: -1,
});

shiftApplicationSchema.index({
  replacementForAssignment: 1,
  occurrence: 1,
  applicationType: 1,
  status: 1,
});

shiftApplicationSchema.index({
  shift: 1,
  slotNumber: 1,
  status: 1,
});

shiftApplicationSchema.index({
  shift: 1,
  status: 1,
  createdAt: -1,
});

shiftApplicationSchema.index({
  occurrence: 1,
  status: 1,
  createdAt: -1,
});

shiftApplicationSchema.index({
  professional: 1,
  status: 1,
  createdAt: -1,
});

shiftApplicationSchema.index({
  status: 1,
  createdAt: -1,
});

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

shiftApplicationSchema.index({
  "credits.isBoosted": 1,
  "credits.boostLevel": 1,
  createdAt: -1,
});

module.exports = mongoose.model("ShiftApplication", shiftApplicationSchema);
