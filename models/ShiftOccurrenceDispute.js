// models/ShiftOccurrenceDispute.js

const mongoose = require("mongoose");

const occurrenceEvidenceSchema = require("./helpers/occurrenceEvidenceSchema");

const { requiredUniqueEnumArrayField } = require("./helpers/schemaFields");

const { SETTLEMENT_BATCH_COMPONENTS } = require("../constants/shiftSettlement");

const {
  EMPLOYER_OCCURRENCE_DISPUTE_TYPES,
  EMPLOYER_OCCURRENCE_DISPUTE_STATUSES,
  EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES,
  ADMIN_EMPLOYER_OCCURRENCE_DISPUTE_DECISIONS,
} = require("../constants/shiftLifecycle");

/**
 * Employer disputes are BASE/factual only.
 *
 * Case status is coarse. Each issue owns its own workflow state.
 * Overtime remains exclusively in the OT lifecycle.
 */

const FORBIDDEN_SNAPSHOT_AUTHORITY_FIELDS = Object.freeze([
  "finalProfessionalPay",
  "finalPlatformFee",
  "finalEmployerCharge",

  "baseEmployerCharge",
  "overtimeEmployerCharge",

  "baseProfessionalPay",
  "overtimeProfessionalPay",

  "basePlatformFee",
  "overtimePlatformFee",

  "topUpRequired",
  "topUpTransaction",

  "baseSettlement",
  "overtimeSettlement",

  "basePlatformFeeAudit",
  "overtimePlatformFeeAudit",

  "platformFeeTransaction",

  "refundableAmount",
  "refundedAmount",

  "refundStatus",
  "refundReason",
  "refundEligibleAt",
  "refundHeldAt",
  "refundHoldReason",

  "employerRefund",
  "refundBatch",

  "challengeWindowOpenedAt",
  "challengeDeadlineAt",
  "challengeWindowClosedAt",
  "challengeableSettlementComponents",

  "activeClaim",
  "activeDispute",

  "overtime",
]);

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

const hasValue = (value) => {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
};

const hasAny = (values) => values.some(hasValue);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeComponents = (components) => {
  if (!Array.isArray(components)) {
    return [];
  }

  const stringValues = components.map(String);

  return SETTLEMENT_BATCH_COMPONENTS.filter((component) => stringValues.includes(component));
};

const sameComponents = (left, right) => {
  const normalizedLeft = normalizeComponents(left);
  const normalizedRight = normalizeComponents(right);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((component, index) => component === normalizedRight[index])
  );
};

const normalizeIssueTypes = (types) => {
  if (!Array.isArray(types)) {
    return [];
  }

  const stringValues = types.map(String);

  return EMPLOYER_OCCURRENCE_DISPUTE_TYPES.filter((type) => stringValues.includes(type));
};

const sameIssueTypes = (left, right) => {
  const normalizedLeft = normalizeIssueTypes(left);
  const normalizedRight = normalizeIssueTypes(right);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((type, index) => type === normalizedRight[index])
  );
};

const optionalMinorUnitAmountField = () => ({
  type: Number,

  default: null,

  min: 0,

  validate: {
    validator: (value) => value === null || Number.isSafeInteger(value),

    message: "Amount must be a whole minor-unit value.",
  },
});

const evidenceArrayField = ({ immutable = false } = {}) => ({
  type: [occurrenceEvidenceSchema],

  default: [],

  immutable,

  validate: {
    validator: (items) => Array.isArray(items) && items.length <= 10,

    message: "A dispute issue cannot contain more than 10 evidence items in one evidence set.",
  },
});

/* ─────────────────────────────── STRUCTURED POSITIONS ─────────────────────────────── */

const attendanceCorrectionPositionSchema = new mongoose.Schema(
  {
    correctedCheckInAt: {
      type: Date,

      default: null,
    },

    correctedCheckOutAt: {
      type: Date,

      default: null,
    },
  },
  {
    _id: false,
  }
);

/**
 * Employer's immutable submitted position.
 *
 * Final BASE authority remains with resolution/settlement services.
 */
const employerIssueDetailsSchema = new mongoose.Schema(
  {
    attendanceCorrection: {
      type: attendanceCorrectionPositionSchema,

      default: null,
    },

    employerProposedBaseProfessionalPay: optionalMinorUnitAmountField(),
  },
  {
    _id: false,
  }
);

/**
 * Optional structured professional counter-position.
 */
const professionalCounterPositionSchema = new mongoose.Schema(
  {
    correctedCheckInAt: {
      type: Date,

      default: null,
    },

    correctedCheckOutAt: {
      type: Date,

      default: null,
    },

    proposedBaseProfessionalPay: optionalMinorUnitAmountField(),
  },
  {
    _id: false,
  }
);

/**
 * Evidence-supported final authority established by admin.
 */
const adminDisputeOutcomeSchema = new mongoose.Schema(
  {
    finalCheckInAt: {
      type: Date,

      default: null,
    },

    finalCheckOutAt: {
      type: Date,

      default: null,
    },

    finalBaseProfessionalPay: optionalMinorUnitAmountField(),

    finalOutcome: {
      type: String,

      trim: true,

      maxlength: 1500,

      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── DISPUTE ISSUE ─────────────────────────────── */

const disputeIssueSchema = new mongoose.Schema(
  {
    // --- IMMUTABLE EMPLOYER SUBMISSION ---

    type: {
      type: String,

      enum: EMPLOYER_OCCURRENCE_DISPUTE_TYPES,

      required: true,

      immutable: true,
    },

    /**
     * The only stored settlement-component scope authority.
     * Employer disputes are BASE-only.
     */
    affectedSettlementComponents: requiredUniqueEnumArrayField({
      values: SETTLEMENT_BATCH_COMPONENTS,

      immutable: true,

      message:
        "Employer dispute issue affectedSettlementComponents must contain one or more unique valid settlement components.",
    }),

    details: {
      type: employerIssueDetailsSchema,

      required: true,

      immutable: true,
    },

    statement: {
      type: String,

      trim: true,

      minlength: 10,

      maxlength: 2000,

      required: true,

      immutable: true,
    },

    evidence: evidenceArrayField({
      immutable: true,
    }),

    // --- ISSUE WORKFLOW ---

    status: {
      type: String,

      enum: EMPLOYER_OCCURRENCE_DISPUTE_ISSUE_STATUSES,

      default: "awaiting_professional_response",

      required: true,
    },

    // --- PROFESSIONAL RESPONSE ---

    professionalResponseStatement: {
      type: String,

      trim: true,

      minlength: 10,

      maxlength: 2000,

      default: null,
    },

    professionalCounterPosition: {
      type: professionalCounterPositionSchema,

      default: null,
    },

    professionalResponseEvidence: evidenceArrayField(),

    professionalRespondedAt: {
      type: Date,

      default: null,
    },

    professionalRespondedBy: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "User",

      default: null,
    },

    professionalResponseExpiredAt: {
      type: Date,

      default: null,
    },

    // --- ADMIN REVIEW ---

    adminReviewStartedAt: {
      type: Date,

      default: null,
    },

    /**
     * approved means the dispute established that current authority requires
     * correction. adminOutcome records the evidence-supported final result.
     *
     * rejected leaves current authority unchanged.
     */
    adminDecision: {
      type: String,

      enum: [...ADMIN_EMPLOYER_OCCURRENCE_DISPUTE_DECISIONS, null],

      default: null,
    },

    adminDecisionReason: {
      type: String,

      trim: true,

      maxlength: 1500,

      default: null,
    },

    adminDecidedAt: {
      type: Date,

      default: null,
    },

    adminDecidedBy: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "User",

      default: null,
    },

    adminOutcome: {
      type: adminDisputeOutcomeSchema,

      default: null,
    },

    adminEvidence: evidenceArrayField(),

    // --- ISSUE FINALIZATION ---

    resolvedAt: {
      type: Date,

      default: null,
    },
  },
  {
    _id: true,
  }
);

/* ─────────────────────────────── DISPUTE CASE ─────────────────────────────── */

const shiftOccurrenceDisputeSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    referenceCode: {
      type: String,

      trim: true,

      uppercase: true,

      required: true,

      immutable: true,
    },

    idempotencyKey: {
      type: String,

      trim: true,

      maxlength: 200,

      required: true,

      immutable: true,
    },

    shift: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "Shift",

      required: true,

      immutable: true,
    },

    occurrence: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "ShiftOccurrence",

      required: true,

      immutable: true,
    },

    assignment: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "ShiftAssignment",

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

    submittedByUser: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "User",

      required: true,

      immutable: true,
    },

    // --- IMMUTABLE ORIGINAL ISSUE SET ---

    /**
     * Issue types cannot be added or removed after submission.
     */
    submittedIssueTypes: requiredUniqueEnumArrayField({
      values: EMPLOYER_OCCURRENCE_DISPUTE_TYPES,

      immutable: true,

      message:
        "submittedIssueTypes must contain one or more unique valid employer dispute issue types.",
    }),

    issues: {
      type: [disputeIssueSchema],

      required: true,

      validate: [
        {
          validator: (items) =>
            Array.isArray(items) &&
            items.length >= 1 &&
            items.length <= EMPLOYER_OCCURRENCE_DISPUTE_TYPES.length,

          message: "An employer dispute must contain between one and three ordinary issues.",
        },

        {
          validator: (items) => {
            if (!Array.isArray(items)) {
              return false;
            }

            const types = items.map((item) => String(item?.type || ""));

            return types.length === new Set(types).size;
          },

          message: "An employer dispute cannot contain duplicate issue types.",
        },
      ],
    },

    // --- EMPLOYER SUBMISSION ---

    submittedAt: {
      type: Date,

      default: Date.now,

      required: true,

      immutable: true,
    },

    // --- SHARED CHALLENGE WINDOW SNAPSHOT ---

    /**
     * Submission-time copy only. The occurrence owns the live window.
     */
    challengeWindowOpenedAt: {
      type: Date,

      required: true,

      immutable: true,
    },

    challengeDeadlineAt: {
      type: Date,

      required: true,

      immutable: true,
    },

    // --- PROFESSIONAL RESPONSE CLOCK ---

    /**
     * All issues share the response deadline.
     */
    professionalResponseDeadlineAt: {
      type: Date,

      required: true,

      immutable: true,
    },

    // --- PRE-DISPUTE FACT SNAPSHOT ---

    /**
     * Evidential facts only. No financial or lifecycle authority.
     */
    lifecycleSnapshot: {
      type: mongoose.Schema.Types.Mixed,

      required: true,

      immutable: true,

      validate: {
        validator: (value) => {
          if (!isPlainObject(value)) {
            return false;
          }

          return !FORBIDDEN_SNAPSHOT_AUTHORITY_FIELDS.some((field) =>
            Object.prototype.hasOwnProperty.call(value, field)
          );
        },

        message:
          "lifecycleSnapshot must contain only challenge-relevant occurrence facts and must not contain settlement, platform-fee, refund, overtime, delinquency, employer-charge, final aggregate or challenge-window authority fields.",
      },
    },

    // --- CASE WORKFLOW STATUS ---

    /**
     * Coarse case status. Issue status owns action state.
     */
    status: {
      type: String,

      enum: EMPLOYER_OCCURRENCE_DISPUTE_STATUSES,

      default: "active",

      required: true,
    },

    // --- REFUND RELATIONSHIP ---

    /**
     * Reference only. Refund authority remains in the refund service.
     */
    employerRefund: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "EmployerRefund",

      default: null,
    },

    // --- CASE FINALIZATION ---

    resolvedAt: {
      type: Date,

      default: null,
    },

    withdrawnAt: {
      type: Date,

      default: null,
    },

    withdrawnBy: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "User",

      default: null,
    },

    withdrawalReason: {
      type: String,

      trim: true,

      maxlength: 500,

      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── ISSUE VALIDATION HELPERS ─────────────────────────────── */

function hasAttendancePosition(position) {
  return Boolean(position?.correctedCheckInAt || position?.correctedCheckOutAt);
}

function validateAttendancePosition(dispute, position, pathPrefix, label) {
  if (!position) {
    return;
  }

  if (
    position.correctedCheckInAt &&
    position.correctedCheckOutAt &&
    position.correctedCheckOutAt <= position.correctedCheckInAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.correctedCheckOutAt`,
      `${label} corrected checkout must be later than corrected check-in.`
    );
  }
}

function hasProfessionalCounterPosition(position) {
  return Boolean(
    position &&
    (position.correctedCheckInAt ||
      position.correctedCheckOutAt ||
      hasValue(position.proposedBaseProfessionalPay))
  );
}

function hasAdminOutcome(outcome) {
  return Boolean(
    outcome &&
    (outcome.finalCheckInAt ||
      outcome.finalCheckOutAt ||
      hasValue(outcome.finalBaseProfessionalPay) ||
      hasValue(outcome.finalOutcome))
  );
}

function validateAdminOutcome(dispute, outcome, pathPrefix) {
  if (!outcome) {
    return;
  }

  if (
    outcome.finalCheckInAt &&
    outcome.finalCheckOutAt &&
    outcome.finalCheckOutAt <= outcome.finalCheckInAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.finalCheckOutAt`,
      "Admin final checkout must be later than final check-in."
    );
  }
}

function validateDisputeIssue(dispute, issue, index) {
  const pathPrefix = `issues.${index}`;

  const affectedComponents = normalizeComponents(issue.affectedSettlementComponents);

  const details = issue.details || {};

  const attendanceCorrection = details.attendanceCorrection || null;

  const hasAttendanceCorrection = hasAttendancePosition(attendanceCorrection);

  const hasEmployerProposedBasePay = hasValue(details.employerProposedBaseProfessionalPay);

  const hasProfessionalResponse =
    hasAny([
      issue.professionalResponseStatement,
      issue.professionalRespondedAt,
      issue.professionalRespondedBy,
    ]) ||
    (Array.isArray(issue.professionalResponseEvidence) &&
      issue.professionalResponseEvidence.length > 0) ||
    hasProfessionalCounterPosition(issue.professionalCounterPosition);

  const hasProfessionalResponseExpiry = hasValue(issue.professionalResponseExpiredAt);

  const hasAdminDecision = hasValue(issue.adminDecision);

  const hasAdminDecisionAudit = hasAny([
    issue.adminDecisionReason,
    issue.adminDecidedAt,
    issue.adminDecidedBy,
  ]);

  const adminOutcome = issue.adminOutcome || null;

  const hasAdminOutcomeDocument = Boolean(adminOutcome);

  const hasStructuredAdminOutcome = hasAdminOutcome(adminOutcome);

  const hasAdminEvidence = Array.isArray(issue.adminEvidence) && issue.adminEvidence.length > 0;

  /* ─────────────────────────────── TYPE / COMPONENT SCOPE ─────────────────────────────── */

  if (!EMPLOYER_OCCURRENCE_DISPUTE_TYPES.includes(issue.type)) {
    dispute.invalidate(`${pathPrefix}.type`, "Employer dispute issue type is invalid.");
  }

  /**
   * Generic employer disputes are BASE-only.
   */
  if (!sameComponents(affectedComponents, ["base"])) {
    dispute.invalidate(
      `${pathPrefix}.affectedSettlementComponents`,
      "Employer dispute issues must affect only the base settlement component."
    );
  }

  if (issue.type === "attendance_correction") {
    if (!hasAttendanceCorrection) {
      dispute.invalidate(
        `${pathPrefix}.details.attendanceCorrection`,
        "attendance_correction requires a corrected check-in time, corrected checkout time, or both."
      );
    }

    if (hasEmployerProposedBasePay) {
      dispute.invalidate(
        `${pathPrefix}.details.employerProposedBaseProfessionalPay`,
        "attendance_correction must state attendance facts rather than a replacement BASE-pay amount."
      );
    }

    validateAttendancePosition(
      dispute,
      attendanceCorrection,
      `${pathPrefix}.details.attendanceCorrection`,
      "Employer"
    );
  }

  if (issue.type === "payment_calculation") {
    if (hasAttendanceCorrection) {
      dispute.invalidate(
        `${pathPrefix}.details.attendanceCorrection`,
        "payment_calculation cannot contain attendance-correction timestamps."
      );
    }

    if (!hasEmployerProposedBasePay) {
      dispute.invalidate(
        `${pathPrefix}.details.employerProposedBaseProfessionalPay`,
        "payment_calculation requires the employer's proposed BASE professional-pay amount."
      );
    }
  }

  if (issue.type === "other_financial_fact" && hasAttendanceCorrection) {
    dispute.invalidate(
      `${pathPrefix}.details.attendanceCorrection`,
      "other_financial_fact cannot contain attendance-correction timestamps."
    );
  }

  /* ─────────────────────────────── PROFESSIONAL RESPONSE ─────────────────────────────── */

  if (hasProfessionalResponse) {
    if (
      !issue.professionalResponseStatement ||
      !issue.professionalRespondedAt ||
      !issue.professionalRespondedBy
    ) {
      dispute.invalidate(
        `${pathPrefix}.professionalRespondedAt`,
        "A professional issue response requires a statement, response time and responding user."
      );
    }

    if (issue.professionalResponseExpiredAt) {
      dispute.invalidate(
        `${pathPrefix}.professionalResponseExpiredAt`,
        "An issue with a submitted professional response cannot also record professional-response expiry."
      );
    }
  }

  if (
    issue.professionalRespondedAt &&
    dispute.submittedAt &&
    issue.professionalRespondedAt < dispute.submittedAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.professionalRespondedAt`,
      "The professional cannot respond to an issue before the dispute is submitted."
    );
  }

  if (
    issue.professionalRespondedAt &&
    dispute.professionalResponseDeadlineAt &&
    issue.professionalRespondedAt >= dispute.professionalResponseDeadlineAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.professionalRespondedAt`,
      "The professional response must be submitted before professionalResponseDeadlineAt."
    );
  }

  if (
    issue.professionalResponseExpiredAt &&
    dispute.professionalResponseDeadlineAt &&
    issue.professionalResponseExpiredAt < dispute.professionalResponseDeadlineAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.professionalResponseExpiredAt`,
      "Professional response cannot expire before professionalResponseDeadlineAt."
    );
  }

  const professionalCounterPosition = issue.professionalCounterPosition || null;

  if (hasProfessionalCounterPosition(professionalCounterPosition)) {
    validateAttendancePosition(
      dispute,
      professionalCounterPosition,
      `${pathPrefix}.professionalCounterPosition`,
      "Professional"
    );

    if (
      issue.type !== "attendance_correction" &&
      (professionalCounterPosition.correctedCheckInAt ||
        professionalCounterPosition.correctedCheckOutAt)
    ) {
      dispute.invalidate(
        `${pathPrefix}.professionalCounterPosition`,
        "Professional attendance counter-position is only valid for an attendance_correction dispute issue."
      );
    }

    if (
      issue.type === "attendance_correction" &&
      hasValue(professionalCounterPosition.proposedBaseProfessionalPay)
    ) {
      dispute.invalidate(
        `${pathPrefix}.professionalCounterPosition.proposedBaseProfessionalPay`,
        "attendance_correction professional counter-position must state attendance facts, not a replacement BASE-pay amount."
      );
    }
  }

  /* ─────────────────────────────── ADMIN REVIEW ─────────────────────────────── */

  if (
    issue.adminReviewStartedAt &&
    dispute.submittedAt &&
    issue.adminReviewStartedAt < dispute.submittedAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.adminReviewStartedAt`,
      "Admin review cannot begin before the dispute is submitted."
    );
  }

  if (issue.adminReviewStartedAt) {
    if (hasProfessionalResponse) {
      if (
        issue.professionalRespondedAt &&
        issue.adminReviewStartedAt < issue.professionalRespondedAt
      ) {
        dispute.invalidate(
          `${pathPrefix}.adminReviewStartedAt`,
          "Admin review cannot begin before the professional response is submitted."
        );
      }
    } else {
      if (!issue.professionalResponseExpiredAt) {
        dispute.invalidate(
          `${pathPrefix}.professionalResponseExpiredAt`,
          "An issue entering admin review without a professional response must record professional response expiry."
        );
      }

      if (
        issue.professionalResponseExpiredAt &&
        issue.adminReviewStartedAt < issue.professionalResponseExpiredAt
      ) {
        dispute.invalidate(
          `${pathPrefix}.adminReviewStartedAt`,
          "Admin review cannot begin before the professional response opportunity expires."
        );
      }
    }
  }

  /* ─────────────────────────────── ADMIN DECISION ─────────────────────────────── */

  if (hasAdminDecision) {
    if (
      !issue.adminReviewStartedAt ||
      !issue.adminDecisionReason ||
      !issue.adminDecidedAt ||
      !issue.adminDecidedBy
    ) {
      dispute.invalidate(
        `${pathPrefix}.adminDecidedAt`,
        "An admin issue decision requires admin review, a reason, decision time and deciding user."
      );
    }
  } else if (hasAdminDecisionAudit || hasAdminOutcomeDocument) {
    dispute.invalidate(
      `${pathPrefix}.adminDecision`,
      "Admin decision audit or final outcome requires an admin decision."
    );
  }

  if (hasAdminEvidence && !issue.adminReviewStartedAt) {
    dispute.invalidate(
      `${pathPrefix}.adminEvidence`,
      "Admin evidence may only be recorded after the issue enters admin review."
    );
  }

  if (
    issue.adminDecidedAt &&
    issue.adminReviewStartedAt &&
    issue.adminDecidedAt < issue.adminReviewStartedAt
  ) {
    dispute.invalidate(
      `${pathPrefix}.adminDecidedAt`,
      "Admin cannot decide an issue before admin review begins."
    );
  }

  validateAdminOutcome(dispute, adminOutcome, `${pathPrefix}.adminOutcome`);

  if (issue.adminDecision === "rejected" && hasAdminOutcomeDocument) {
    dispute.invalidate(
      `${pathPrefix}.adminOutcome`,
      "A rejected employer dispute issue cannot contain a replacement admin outcome."
    );
  }

  if (issue.type === "attendance_correction") {
    if (adminOutcome && hasValue(adminOutcome.finalBaseProfessionalPay)) {
      dispute.invalidate(
        `${pathPrefix}.adminOutcome.finalBaseProfessionalPay`,
        "attendance_correction admin outcome must establish attendance facts; final BASE pay is recalculated by the resolution/settlement services."
      );
    }

    if (
      issue.adminDecision === "approved" &&
      !hasAny([adminOutcome?.finalCheckInAt, adminOutcome?.finalCheckOutAt])
    ) {
      dispute.invalidate(
        `${pathPrefix}.adminOutcome`,
        "An approved attendance_correction dispute requires admin to establish the final authoritative attendance fact."
      );
    }
  } else if (adminOutcome && (adminOutcome.finalCheckInAt || adminOutcome.finalCheckOutAt)) {
    dispute.invalidate(
      `${pathPrefix}.adminOutcome`,
      "Admin attendance outcome fields are only valid for an attendance_correction dispute issue."
    );
  }

  if (
    issue.type === "payment_calculation" &&
    issue.adminDecision === "approved" &&
    !hasValue(adminOutcome?.finalBaseProfessionalPay)
  ) {
    dispute.invalidate(
      `${pathPrefix}.adminOutcome.finalBaseProfessionalPay`,
      "An approved payment_calculation dispute requires admin to establish the final BASE professional-pay amount."
    );
  }

  if (
    issue.type === "other_financial_fact" &&
    issue.adminDecision === "approved" &&
    !hasStructuredAdminOutcome
  ) {
    dispute.invalidate(
      `${pathPrefix}.adminOutcome`,
      "An approved other_financial_fact dispute requires a final admin outcome."
    );
  }

  /* ─────────────────────────────── ISSUE STATUS ─────────────────────────────── */

  if (issue.status === "awaiting_professional_response") {
    if (
      hasProfessionalResponse ||
      hasProfessionalResponseExpiry ||
      issue.adminReviewStartedAt ||
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasAdminOutcomeDocument ||
      hasAdminEvidence ||
      issue.resolvedAt
    ) {
      dispute.invalidate(
        `${pathPrefix}.status`,
        "awaiting_professional_response cannot contain professional response, response expiry, admin review or finalization data."
      );
    }
  }

  if (issue.status === "awaiting_admin_review") {
    if (!issue.adminReviewStartedAt) {
      dispute.invalidate(
        `${pathPrefix}.adminReviewStartedAt`,
        "An issue awaiting admin review requires adminReviewStartedAt."
      );
    }

    const reachedAdminAfterResponse =
      hasProfessionalResponse &&
      issue.professionalRespondedAt &&
      issue.adminReviewStartedAt &&
      issue.adminReviewStartedAt >= issue.professionalRespondedAt;

    const reachedAdminAfterNonResponse =
      !hasProfessionalResponse &&
      issue.professionalResponseExpiredAt &&
      issue.adminReviewStartedAt &&
      issue.adminReviewStartedAt >= issue.professionalResponseExpiredAt;

    if (!reachedAdminAfterResponse && !reachedAdminAfterNonResponse) {
      dispute.invalidate(
        `${pathPrefix}.status`,
        "A dispute issue may enter admin review only after the professional responds or the professional response opportunity expires."
      );
    }

    if (hasAdminDecision || hasAdminDecisionAudit || hasAdminOutcomeDocument || issue.resolvedAt) {
      dispute.invalidate(
        `${pathPrefix}.status`,
        "awaiting_admin_review cannot contain a final admin decision or resolvedAt."
      );
    }
  }

  if (issue.status === "resolved") {
    if (!issue.resolvedAt) {
      dispute.invalidate(
        `${pathPrefix}.resolvedAt`,
        "A resolved employer dispute issue requires resolvedAt."
      );
    }

    if (
      !hasAdminDecision ||
      !issue.adminDecisionReason ||
      !issue.adminDecidedAt ||
      !issue.adminDecidedBy ||
      !issue.adminReviewStartedAt
    ) {
      dispute.invalidate(
        `${pathPrefix}.status`,
        "A resolved employer dispute issue requires a final admin decision."
      );
    }
  } else if (issue.resolvedAt) {
    dispute.invalidate(
      `${pathPrefix}.resolvedAt`,
      "resolvedAt may only be set when the dispute issue status is resolved."
    );
  }

  /* ─────────────────────────────── DATE ORDERING ─────────────────────────────── */

  if (issue.resolvedAt && dispute.submittedAt && issue.resolvedAt < dispute.submittedAt) {
    dispute.invalidate(
      `${pathPrefix}.resolvedAt`,
      "Issue resolvedAt cannot be earlier than dispute submittedAt."
    );
  }

  if (issue.resolvedAt && issue.adminDecidedAt && issue.resolvedAt < issue.adminDecidedAt) {
    dispute.invalidate(
      `${pathPrefix}.resolvedAt`,
      "Issue resolvedAt cannot be earlier than the admin decision."
    );
  }
}

/* ─────────────────────────────── CASE VALIDATION ─────────────────────────────── */

shiftOccurrenceDisputeSchema.pre("validate", function validateShiftOccurrenceDispute() {
  const issues = Array.isArray(this.issues) ? this.issues : [];

  const submittedIssueTypes = normalizeIssueTypes(this.submittedIssueTypes);

  const actualIssueTypes = normalizeIssueTypes(issues.map((issue) => issue?.type));

  const hasWithdrawalAudit = hasAny([this.withdrawnAt, this.withdrawnBy, this.withdrawalReason]);

  /* ─────────────────────────────── ORIGINAL ISSUE SET ─────────────────────────────── */

  if (submittedIssueTypes.length === 0) {
    this.invalidate(
      "submittedIssueTypes",
      "An employer dispute must contain at least one submitted ordinary issue type."
    );
  }

  if (!sameIssueTypes(submittedIssueTypes, actualIssueTypes)) {
    this.invalidate(
      "issues",
      "The employer dispute issues must exactly match the immutable submittedIssueTypes set."
    );
  }

  issues.forEach((issue, index) => {
    validateDisputeIssue(this, issue, index);
  });

  /* ─────────────────────────────── SHARED CHALLENGE WINDOW ─────────────────────────────── */

  if (
    this.challengeWindowOpenedAt &&
    this.challengeDeadlineAt &&
    this.challengeDeadlineAt <= this.challengeWindowOpenedAt
  ) {
    this.invalidate(
      "challengeDeadlineAt",
      "challengeDeadlineAt must be later than challengeWindowOpenedAt."
    );
  }

  if (
    this.submittedAt &&
    this.challengeWindowOpenedAt &&
    this.submittedAt < this.challengeWindowOpenedAt
  ) {
    this.invalidate(
      "submittedAt",
      "An employer dispute cannot be submitted before the shared occurrence challenge window opens."
    );
  }

  if (
    this.submittedAt &&
    this.challengeDeadlineAt &&
    this.submittedAt >= this.challengeDeadlineAt
  ) {
    this.invalidate(
      "submittedAt",
      "An employer dispute must be submitted strictly before challengeDeadlineAt."
    );
  }

  /* ─────────────────────────────── PROFESSIONAL RESPONSE CLOCK ─────────────────────────────── */

  if (
    this.professionalResponseDeadlineAt &&
    this.submittedAt &&
    this.professionalResponseDeadlineAt <= this.submittedAt
  ) {
    this.invalidate(
      "professionalResponseDeadlineAt",
      "professionalResponseDeadlineAt must be later than submittedAt."
    );
  }

  /* ─────────────────────────────── CASE STATUS ─────────────────────────────── */

  const unresolvedIssues = issues.filter((issue) => issue?.status !== "resolved");

  const resolvedIssues = issues.filter((issue) => issue?.status === "resolved");

  if (this.status === "active") {
    if (issues.length === 0 || unresolvedIssues.length === 0) {
      this.invalidate(
        "status",
        "An active employer dispute requires at least one unresolved issue."
      );
    }

    if (this.resolvedAt || hasWithdrawalAudit) {
      this.invalidate(
        "status",
        "An active employer dispute cannot contain case resolution or withdrawal audit."
      );
    }
  }

  if (this.status === "resolved") {
    if (issues.length === 0 || resolvedIssues.length !== issues.length) {
      this.invalidate(
        "status",
        "A resolved employer dispute requires every submitted issue to be resolved."
      );
    }

    if (!this.resolvedAt) {
      this.invalidate("resolvedAt", "A resolved employer dispute requires resolvedAt.");
    }

    if (hasWithdrawalAudit) {
      this.invalidate(
        "status",
        "A resolved employer dispute cannot also contain withdrawal details."
      );
    }

    const latestIssueResolution = issues.reduce((latest, issue) => {
      if (!issue?.resolvedAt) {
        return latest;
      }

      if (!latest || issue.resolvedAt > latest) {
        return issue.resolvedAt;
      }

      return latest;
    }, null);

    if (latestIssueResolution && this.resolvedAt && this.resolvedAt < latestIssueResolution) {
      this.invalidate(
        "resolvedAt",
        "Dispute resolvedAt cannot be earlier than the latest issue resolution."
      );
    }
  } else if (this.resolvedAt) {
    this.invalidate("resolvedAt", "resolvedAt may only be set when dispute status is resolved.");
  }

  if (this.status === "withdrawn") {
    if (!this.withdrawnAt || !this.withdrawnBy || !this.withdrawalReason) {
      this.invalidate(
        "withdrawnAt",
        "A withdrawn employer dispute requires withdrawal time, user and reason."
      );
    }

    if (this.resolvedAt) {
      this.invalidate("status", "A withdrawn employer dispute cannot also be resolved.");
    }

    /**
     * Withdrawal is available only before professional/admin activity.
     */
    const hasStartedAdjudication = issues.some(
      (issue) =>
        issue?.status !== "awaiting_professional_response" ||
        issue?.professionalRespondedAt ||
        issue?.professionalResponseExpiredAt ||
        issue?.adminReviewStartedAt ||
        hasValue(issue?.adminDecision) ||
        issue?.resolvedAt
    );

    if (hasStartedAdjudication) {
      this.invalidate(
        "status",
        "An employer dispute may be withdrawn only before professional response or admin adjudication begins on any issue."
      );
    }
  } else if (hasWithdrawalAudit) {
    this.invalidate("withdrawnAt", "Withdrawal details require dispute status withdrawn.");
  }

  /* ─────────────────────────────── CASE DATE ORDERING ─────────────────────────────── */

  if (this.resolvedAt && this.submittedAt && this.resolvedAt < this.submittedAt) {
    this.invalidate("resolvedAt", "resolvedAt cannot be earlier than submittedAt.");
  }

  if (this.withdrawnAt && this.submittedAt && this.withdrawnAt < this.submittedAt) {
    this.invalidate("withdrawnAt", "withdrawnAt cannot be earlier than submittedAt.");
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

shiftOccurrenceDisputeSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceDisputeSchema.index(
  {
    idempotencyKey: 1,
  },
  {
    unique: true,
  }
);

/**
 * One original employer dispute case per occurrence.
 */
shiftOccurrenceDisputeSchema.index(
  {
    occurrence: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceDisputeSchema.index({
  business: 1,
  status: 1,
  professionalResponseDeadlineAt: 1,
});

shiftOccurrenceDisputeSchema.index({
  professional: 1,
  status: 1,
  "issues.status": 1,
});

shiftOccurrenceDisputeSchema.index({
  status: 1,
  "issues.status": 1,
  "issues.adminReviewStartedAt": 1,
});

shiftOccurrenceDisputeSchema.index({
  status: 1,
  "issues.professionalRespondedAt": 1,
});

/**
 * Live component scope is derived from unresolved issues only.
 */
shiftOccurrenceDisputeSchema.index({
  "issues.affectedSettlementComponents": 1,
  "issues.status": 1,
  status: 1,
});

shiftOccurrenceDisputeSchema.index({
  "issues.type": 1,
  status: 1,
});

shiftOccurrenceDisputeSchema.index({
  employerRefund: 1,
});

shiftOccurrenceDisputeSchema.index({
  shift: 1,
  occurrence: 1,
});

shiftOccurrenceDisputeSchema.index({
  assignment: 1,
});

module.exports = mongoose.model("ShiftOccurrenceDispute", shiftOccurrenceDisputeSchema);
