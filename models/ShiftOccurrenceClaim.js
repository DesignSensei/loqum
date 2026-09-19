// models/ShiftOccurrenceClaim.js

const mongoose = require("mongoose");

const { requiredUniqueEnumArrayField } = require("./helpers/schemaFields");
const occurrenceEvidenceSchema = require("./helpers/occurrenceEvidenceSchema");

const {
  FINANCIAL_OCCURRENCE_CLAIM_TYPES,
  OCCURRENCE_CLAIM_STATUSES,
  OCCURRENCE_CLAIM_ISSUE_STATUSES,
  EMPLOYER_FINANCIAL_CLAIM_DECISIONS,
  ADMIN_FINANCIAL_CLAIM_DECISIONS,
  OCCURRENCE_CLAIM_ADMIN_REVIEW_REASONS,
} = require("../constants/shiftLifecycle");

const { SETTLEMENT_BATCH_COMPONENTS } = require("../constants/shiftSettlement");

/* ───────────────────── SNAPSHOT PROTECTION ───────────────────── */

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

  "baseSettlement",
  "overtimeSettlement",

  "basePlatformFeeAudit",
  "overtimePlatformFeeAudit",

  "platformFeeTransaction",
  "topUpTransaction",

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

/* ───────────────────── HELPERS ───────────────────── */

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

  return FINANCIAL_OCCURRENCE_CLAIM_TYPES.filter((type) => stringValues.includes(type));
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
    message: "A claim issue cannot contain more than 10 evidence items.",
  },
});

/* ───────────────────── STRUCTURED POSITIONS ───────────────────── */

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

const professionalIssueDetailsSchema = new mongoose.Schema(
  {
    attendanceCorrection: {
      type: attendanceCorrectionPositionSchema,
      default: null,
    },

    /**
     * Professional requested BASE amount.
     *
     * This is a position only.
     * It never becomes settlement authority.
     */
    expectedBaseProfessionalPay: optionalMinorUnitAmountField(),
  },
  {
    _id: false,
  }
);

const employerCounterPositionSchema = new mongoose.Schema(
  {
    correctedCheckInAt: {
      type: Date,
      default: null,
    },

    correctedCheckOutAt: {
      type: Date,
      default: null,
    },

    /**
     * Employer proposed BASE amount.
     *
     * Evidence/position only.
     */
    proposedBaseProfessionalPay: optionalMinorUnitAmountField(),
  },
  {
    _id: false,
  }
);

const adminOutcomeSchema = new mongoose.Schema(
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

    /**
     * Used when admin establishes
     * an outcome that cannot be represented
     * only by structured fields.
     */
    adjustedOutcome: {
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

/* ───────────────────── CLAIM ISSUE ───────────────────── */

const claimIssueSchema = new mongoose.Schema(
  {
    // --- IMMUTABLE PROFESSIONAL SUBMISSION ---

    type: {
      type: String,
      enum: FINANCIAL_OCCURRENCE_CLAIM_TYPES,
      required: true,
      immutable: true,
    },

    /**
     * Stored BASE scope only.
     *
     * Professional ordinary claims never modify
     * overtime settlement authority.
     */
    challengedSettlementComponents: requiredUniqueEnumArrayField({
      values: SETTLEMENT_BATCH_COMPONENTS,
      immutable: true,
      message:
        "Claim issue challengedSettlementComponents must contain valid unique settlement components.",
    }),

    details: {
      type: professionalIssueDetailsSchema,
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
      enum: OCCURRENCE_CLAIM_ISSUE_STATUSES,
      default: "awaiting_employer_review",
      required: true,
    },

    // --- EMPLOYER REVIEW ---

    // Employer agrees or disagrees with the professional's submitted position.
    employerDecision: {
      type: String,
      enum: [...EMPLOYER_FINANCIAL_CLAIM_DECISIONS, null],
      default: null,
    },

    employerDecisionReason: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: null,
    },

    employerDecidedAt: {
      type: Date,
      default: null,
    },

    employerDecidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    /**
     * Employer's alternative factual/financial
     * position after rejecting the claim.
     *
     * This does not resolve the claim.
     * It only records disagreement.
     */
    employerCounterPosition: {
      type: employerCounterPositionSchema,
      default: null,
    },

    employerEvidence: evidenceArrayField(),

    // --- ADMIN ESCALATION ---

    /**
     * Escalation means:
     *
     * "The parties did not reach agreement
     * and admin authority is now required."
     */
    escalatedAt: {
      type: Date,
      default: null,
    },

    escalationReason: {
      type: String,
      enum: [...OCCURRENCE_CLAIM_ADMIN_REVIEW_REASONS, null],
      default: null,
    },

    escalatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    escalationNotes: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: null,
    },

    // --- ADMIN FINAL DECISION ---

    adminDecision: {
      type: String,
      enum: [...ADMIN_FINANCIAL_CLAIM_DECISIONS, null],
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
      type: adminOutcomeSchema,
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

/* ───────────────────── CLAIM CASE ───────────────────── */

const shiftOccurrenceClaimSchema = new mongoose.Schema(
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

    // --- ORIGINAL IMMUTABLE ISSUE SET ---

    /**
     * The professional's original complaint scope.
     *
     * Cannot expand after submission.
     */
    submittedIssueTypes: requiredUniqueEnumArrayField({
      values: FINANCIAL_OCCURRENCE_CLAIM_TYPES,
      immutable: true,
      message: "submittedIssueTypes must contain valid unique professional claim types.",
    }),

    issues: {
      type: [claimIssueSchema],
      required: true,

      validate: [
        {
          validator: (items) =>
            Array.isArray(items) &&
            items.length >= 1 &&
            items.length <= FINANCIAL_OCCURRENCE_CLAIM_TYPES.length,

          message: "A professional claim must contain between one and three ordinary issues.",
        },

        {
          validator: (items) => {
            if (!Array.isArray(items)) {
              return false;
            }

            const types = items.map((item) => String(item?.type || ""));

            return types.length === new Set(types).size;
          },

          message: "A professional claim cannot contain duplicate issue types.",
        },
      ],
    },

    // --- PROFESSIONAL SUBMISSION ---

    submittedAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true,
    },

    // --- CHALLENGE WINDOW SNAPSHOT ---

    /**
     * Historical snapshot only.
     *
     * ShiftOccurrence owns live challenge authority.
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

    // --- EMPLOYER RESPONSE CLOCK ---

    /**
     * Shared employer response deadline
     * for all issues in this claim.
     */
    employerResponseDeadlineAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    // --- FACT SNAPSHOT ---

    /**
     * Evidence snapshot only.
     *
     * Never owns:
     * - settlement authority
     * - refund authority
     * - overtime authority
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

        message: "lifecycleSnapshot may only contain challenge-relevant facts.",
      },
    },

    // --- CASE WORKFLOW ---

    /**
     * Coarse case status.
     *
     * Individual issue status owns workflow.
     */
    status: {
      type: String,
      enum: OCCURRENCE_CLAIM_STATUSES,
      default: "active",
      required: true,
    },

    // --- REFUND RELATIONSHIP ---

    /**
     * Optional reference only.
     *
     * Refund lifecycle remains owned by EmployerRefund.
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

/* ───────────────────── VALIDATION HELPERS ───────────────────── */

function validateClaimLifecycleDates(claim) {
  if (
    claim.submittedAt &&
    claim.challengeWindowOpenedAt &&
    claim.submittedAt < claim.challengeWindowOpenedAt
  ) {
    claim.invalidate("submittedAt", "Claim submission cannot precede the challenge window.");
  }

  if (
    claim.submittedAt &&
    claim.challengeDeadlineAt &&
    claim.submittedAt >= claim.challengeDeadlineAt
  ) {
    claim.invalidate(
      "submittedAt",
      "Claim submission must occur strictly before the challenge deadline."
    );
  }

  if (
    claim.challengeDeadlineAt &&
    claim.challengeWindowOpenedAt &&
    claim.challengeDeadlineAt <= claim.challengeWindowOpenedAt
  ) {
    claim.invalidate(
      "challengeDeadlineAt",
      "Challenge deadline must be later than challenge window opening."
    );
  }

  if (
    claim.employerResponseDeadlineAt &&
    claim.submittedAt &&
    claim.employerResponseDeadlineAt < claim.submittedAt
  ) {
    claim.invalidate(
      "employerResponseDeadlineAt",
      "Employer response deadline cannot be before claim submission."
    );
  }

  if (claim.resolvedAt && claim.submittedAt && claim.resolvedAt < claim.submittedAt) {
    claim.invalidate("resolvedAt", "Claim cannot resolve before submission.");
  }

  if (claim.withdrawnAt && claim.submittedAt && claim.withdrawnAt < claim.submittedAt) {
    claim.invalidate("withdrawnAt", "Claim cannot be withdrawn before submission.");
  }
}

function hasAttendancePosition(position) {
  return Boolean(position?.correctedCheckInAt || position?.correctedCheckOutAt);
}

function validateAttendancePosition(claim, position, pathPrefix, label) {
  if (!position) {
    return;
  }

  if (
    position.correctedCheckInAt &&
    position.correctedCheckOutAt &&
    position.correctedCheckOutAt <= position.correctedCheckInAt
  ) {
    claim.invalidate(
      `${pathPrefix}.correctedCheckOutAt`,
      `${label} corrected checkout must be later than corrected check-in.`
    );
  }
}

function hasEmployerCounterPosition(position) {
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
      hasValue(outcome.adjustedOutcome))
  );
}

function validateAdminOutcome(claim, outcome, pathPrefix) {
  if (!outcome) {
    return;
  }

  if (
    outcome.finalCheckInAt &&
    outcome.finalCheckOutAt &&
    outcome.finalCheckOutAt <= outcome.finalCheckInAt
  ) {
    claim.invalidate(
      `${pathPrefix}.finalCheckOutAt`,
      "Admin final checkout must be later than final check-in."
    );
  }
}

/* ───────────────────── ISSUE VALIDATION ───────────────────── */

function validateIssueLifecycleDates(claim, issue, pathPrefix) {
  const timestamps = ["employerDecidedAt", "escalatedAt", "adminDecidedAt", "resolvedAt"];

  for (const fieldName of timestamps) {
    if (issue[fieldName] && claim.submittedAt && issue[fieldName] < claim.submittedAt) {
      claim.invalidate(`${pathPrefix}.${fieldName}`, `${fieldName} cannot precede submission.`);
    }
  }

  const orderedPairs = [
    ["employerDecidedAt", "escalatedAt"],
    ["escalatedAt", "adminDecidedAt"],
    ["employerDecidedAt", "resolvedAt"],
    ["adminDecidedAt", "resolvedAt"],
  ];

  for (const [earlierField, laterField] of orderedPairs) {
    if (issue[earlierField] && issue[laterField] && issue[laterField] < issue[earlierField]) {
      claim.invalidate(
        `${pathPrefix}.${laterField}`,
        `${laterField} cannot precede ${earlierField}.`
      );
    }
  }
}

function validateClaimIssue(claim, issue, index) {
  const pathPrefix = `issues.${index}`;

  validateIssueLifecycleDates(claim, issue, pathPrefix);

  const affectedComponents = normalizeComponents(issue.challengedSettlementComponents);

  const details = issue.details || {};

  const attendanceCorrection = details.attendanceCorrection || null;

  const hasAttendanceCorrection = hasAttendancePosition(attendanceCorrection);

  const hasExpectedBasePay = hasValue(details.expectedBaseProfessionalPay);

  const hasEmployerDecision = hasValue(issue.employerDecision);

  const hasEmployerDecisionAudit = hasAny([
    issue.employerDecisionReason,
    issue.employerDecidedAt,
    issue.employerDecidedBy,
  ]);

  const hasCounterPosition = hasEmployerCounterPosition(issue.employerCounterPosition);

  const hasEmployerEvidence =
    Array.isArray(issue.employerEvidence) && issue.employerEvidence.length > 0;

  const hasEscalationAudit = hasAny([
    issue.escalatedAt,
    issue.escalationReason,
    issue.escalatedBy,
    issue.escalationNotes,
  ]);

  const hasAdminDecision = hasValue(issue.adminDecision);

  const hasAdminDecisionAudit = hasAny([
    issue.adminDecisionReason,
    issue.adminDecidedAt,
    issue.adminDecidedBy,
  ]);

  const hasAdminEvidence = Array.isArray(issue.adminEvidence) && issue.adminEvidence.length > 0;

  const hasStructuredAdminOutcome = hasAdminOutcome(issue.adminOutcome);

  // --- TYPE / SCOPE ---

  if (!FINANCIAL_OCCURRENCE_CLAIM_TYPES.includes(issue.type)) {
    claim.invalidate(`${pathPrefix}.type`, "Invalid professional claim issue type.");
  }

  if (!sameComponents(affectedComponents, ["base"])) {
    claim.invalidate(
      `${pathPrefix}.challengedSettlementComponents`,
      "Professional claims may only affect BASE settlement."
    );
  }

  // --- PROFESSIONAL DETAILS ---

  if (issue.type === "attendance_correction") {
    if (!hasAttendanceCorrection) {
      claim.invalidate(
        `${pathPrefix}.details.attendanceCorrection`,
        "Attendance correction requires corrected attendance facts."
      );
    }

    if (hasExpectedBasePay) {
      claim.invalidate(
        `${pathPrefix}.details.expectedBaseProfessionalPay`,
        "Attendance correction cannot contain BASE amount request."
      );
    }

    validateAttendancePosition(
      claim,
      attendanceCorrection,
      `${pathPrefix}.details.attendanceCorrection`,
      "Professional"
    );
  }

  if (issue.type !== "attendance_correction" && hasAttendanceCorrection) {
    claim.invalidate(
      `${pathPrefix}.details.attendanceCorrection`,
      "Only attendance correction issues may contain attendance facts."
    );
  }

  // --- EMPLOYER REVIEW ---

  if (hasEmployerDecision) {
    if (!issue.employerDecisionReason || !issue.employerDecidedAt || !issue.employerDecidedBy) {
      claim.invalidate(
        `${pathPrefix}.employerDecision`,
        "Employer decision requires reason, timestamp and user."
      );
    }
  } else if (hasEmployerDecisionAudit || hasCounterPosition || hasEmployerEvidence) {
    claim.invalidate(
      `${pathPrefix}.employerDecision`,
      "Employer response data requires employer decision."
    );
  }

  if (issue.employerDecision === "approved" && hasCounterPosition) {
    claim.invalidate(
      `${pathPrefix}.employerCounterPosition`,
      "Approved claims cannot contain employer counter-position."
    );
  }

  if (hasCounterPosition) {
    if (
      issue.type === "attendance_correction" &&
      hasValue(issue.employerCounterPosition.proposedBaseProfessionalPay)
    ) {
      claim.invalidate(
        `${pathPrefix}.employerCounterPosition.proposedBaseProfessionalPay`,
        "Attendance counter-positions must contain attendance facts, not a direct BASE amount."
      );
    }

    validateAttendancePosition(
      claim,
      issue.employerCounterPosition,
      `${pathPrefix}.employerCounterPosition`,
      "Employer"
    );

    if (
      issue.type !== "attendance_correction" &&
      (issue.employerCounterPosition.correctedCheckInAt ||
        issue.employerCounterPosition.correctedCheckOutAt)
    ) {
      claim.invalidate(
        `${pathPrefix}.employerCounterPosition`,
        "Employer attendance position only applies to attendance correction."
      );
    }
  }

  // --- ESCALATION ---

  if (hasEscalationAudit) {
    if (!issue.escalatedAt || !issue.escalationReason) {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Escalation requires a timestamp and reason."
      );
    }

    if (issue.escalationReason !== "employer_non_response" && !issue.escalatedBy) {
      claim.invalidate(
        `${pathPrefix}.escalatedBy`,
        "An escalation other than employer non-response requires a user."
      );
    }
  }

  if (issue.escalationReason === "employer_disagreement") {
    if (issue.employerDecision !== "rejected") {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Employer disagreement requires an audited rejection."
      );
    }
  }

  if (issue.escalationReason === "employer_non_response") {
    if (
      hasEmployerDecision ||
      !claim.employerResponseDeadlineAt ||
      issue.escalatedAt < claim.employerResponseDeadlineAt
    ) {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Employer non-response requires expired response window."
      );
    }
  }

  // --- ADMIN DECISION ---

  if (hasAdminDecision) {
    if (
      !issue.adminDecisionReason ||
      !issue.adminDecidedAt ||
      !issue.adminDecidedBy ||
      !issue.escalatedAt ||
      !issue.escalationReason
    ) {
      claim.invalidate(`${pathPrefix}.adminDecision`, "Admin decision requires escalation audit.");
    }
  } else if (hasAdminDecisionAudit || hasStructuredAdminOutcome) {
    claim.invalidate(`${pathPrefix}.adminDecision`, "Admin outcome requires admin decision.");
  }

  if (hasAdminEvidence && !issue.escalatedAt) {
    claim.invalidate(`${pathPrefix}.adminEvidence`, "Admin evidence requires escalation.");
  }

  if (hasAdminDecision && issue.status !== "resolved") {
    claim.invalidate(
      `${pathPrefix}.adminDecision`,
      "A final admin decision requires resolved issue status."
    );
  }

  if (issue.adminDecision === "approve_employer" && !hasCounterPosition) {
    claim.invalidate(
      `${pathPrefix}.adminDecision`,
      "Approving the employer position requires a recorded counter-position."
    );
  }

  if (hasAdminDecision && issue.adminDecision !== "adjusted" && issue.adminOutcome != null) {
    claim.invalidate(
      `${pathPrefix}.adminOutcome`,
      "Only an adjusted decision may contain an admin outcome."
    );
  }

  if (issue.adminDecision === "adjusted") {
    if (!hasStructuredAdminOutcome) {
      claim.invalidate(
        `${pathPrefix}.adminOutcome`,
        "An adjusted decision requires a final outcome."
      );
    }

    const outcome = issue.adminOutcome || {};

    const hasFinalAttendance = Boolean(outcome.finalCheckInAt || outcome.finalCheckOutAt);

    const hasFinalBasePay = hasValue(outcome.finalBaseProfessionalPay);

    if (issue.type === "attendance_correction") {
      if (!hasFinalAttendance || hasFinalBasePay) {
        claim.invalidate(
          `${pathPrefix}.adminOutcome`,
          "Adjusted attendance requires final attendance facts, without a direct BASE amount."
        );
      }
    } else if (hasFinalAttendance) {
      claim.invalidate(
        `${pathPrefix}.adminOutcome`,
        "Only attendance correction may contain final attendance facts."
      );
    }

    if (issue.type === "payment_calculation" && !hasFinalBasePay) {
      claim.invalidate(
        `${pathPrefix}.adminOutcome.finalBaseProfessionalPay`,
        "An adjusted payment calculation requires final BASE professional pay."
      );
    }
  }

  validateAdminOutcome(claim, issue.adminOutcome, `${pathPrefix}.adminOutcome`);

  // --- ISSUE STATUS ---

  if (issue.status === "awaiting_employer_review") {
    if (
      hasEmployerDecision ||
      hasCounterPosition ||
      hasEmployerEvidence ||
      hasEscalationAudit ||
      hasAdminDecision ||
      issue.resolvedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "Awaiting employer review cannot contain later workflow data."
      );
    }
  }

  if (issue.status === "awaiting_admin_review") {
    if (!issue.escalatedAt || !issue.escalationReason) {
      claim.invalidate(`${pathPrefix}.status`, "Admin review requires escalation.");
    }

    if (hasAdminDecision || hasAdminDecisionAudit || hasStructuredAdminOutcome) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "An issue awaiting admin review cannot contain a final admin decision or outcome."
      );
    }
  }

  if (issue.status === "resolved") {
    if (!issue.resolvedAt) {
      claim.invalidate(`${pathPrefix}.resolvedAt`, "Resolved issue requires resolvedAt.");
    }

    const resolvedByEmployer =
      issue.employerDecision === "approved" && !issue.escalatedAt && !issue.adminDecision;

    const resolvedByAdmin =
      hasAdminDecision &&
      issue.escalatedAt &&
      issue.escalationReason &&
      issue.adminDecidedAt &&
      issue.adminDecidedBy &&
      (issue.adminDecision !== "adjusted" || hasStructuredAdminOutcome);

    if (!resolvedByEmployer && !resolvedByAdmin) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "Resolved issue requires employer approval or admin decision."
      );
    }
  } else if (issue.resolvedAt) {
    claim.invalidate(`${pathPrefix}.resolvedAt`, "resolvedAt only applies to resolved issues.");
  }
}

/* ───────────────────── CASE VALIDATION ───────────────────── */

shiftOccurrenceClaimSchema.pre("validate", function validateShiftOccurrenceClaim() {
  validateClaimLifecycleDates(this);

  const issues = Array.isArray(this.issues) ? this.issues : [];

  const submittedIssueTypes = normalizeIssueTypes(this.submittedIssueTypes);

  const actualIssueTypes = normalizeIssueTypes(issues.map((issue) => issue?.type));

  issues.forEach((issue, index) => validateClaimIssue(this, issue, index));

  if (!sameIssueTypes(submittedIssueTypes, actualIssueTypes)) {
    this.invalidate("issues", "Issues must match submitted issue types.");
  }

  if (this.status === "active" && !issues.some((issue) => issue.status !== "resolved")) {
    this.invalidate("status", "Active claim requires unresolved issues.");
  }

  if (this.status === "resolved" && issues.some((issue) => issue.status !== "resolved")) {
    this.invalidate("status", "Resolved claim requires all issues resolved.");
  }

  if (this.status === "resolved") {
    if (!this.resolvedAt) {
      this.invalidate("resolvedAt", "A resolved claim requires resolvedAt.");
    }

    if (issues.some((issue) => issue.resolvedAt && this.resolvedAt < issue.resolvedAt)) {
      this.invalidate("resolvedAt", "Claim resolution cannot precede issue resolution.");
    }
  } else if (this.resolvedAt) {
    this.invalidate("resolvedAt", "resolvedAt may only be recorded on a resolved claim.");
  }

  const withdrawalFields = ["withdrawnAt", "withdrawnBy", "withdrawalReason"];

  if (this.status === "withdrawn") {
    for (const fieldName of withdrawalFields) {
      if (!hasValue(this[fieldName])) {
        this.invalidate(fieldName, `A withdrawn claim requires ${fieldName}.`);
      }
    }

    // Withdrawal preserves untouched submissions; it does not erase responses.

    if (issues.some((issue) => issue.status !== "awaiting_employer_review")) {
      this.invalidate(
        "status",
        "A claim cannot be withdrawn after its issues progress beyond employer review."
      );
    }
  } else {
    for (const fieldName of withdrawalFields) {
      if (hasValue(this[fieldName])) {
        this.invalidate(fieldName, `${fieldName} may only be recorded on a withdrawn claim.`);
      }
    }
  }
});

/* ───────────────────── INDEXES ───────────────────── */

shiftOccurrenceClaimSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceClaimSchema.index(
  {
    idempotencyKey: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceClaimSchema.index(
  {
    occurrence: 1,
  },
  {
    unique: true,
  }
);

shiftOccurrenceClaimSchema.index({
  business: 1,
  status: 1,
  employerResponseDeadlineAt: 1,
});

shiftOccurrenceClaimSchema.index({
  professional: 1,
  status: 1,
  "issues.status": 1,
});

shiftOccurrenceClaimSchema.index({
  status: 1,
  "issues.status": 1,
  "issues.escalationReason": 1,
  "issues.escalatedAt": 1,
});

shiftOccurrenceClaimSchema.index({
  "issues.challengedSettlementComponents": 1,
  "issues.status": 1,
  status: 1,
});

shiftOccurrenceClaimSchema.index({
  "issues.type": 1,
  status: 1,
});

shiftOccurrenceClaimSchema.index({
  employerRefund: 1,
});

shiftOccurrenceClaimSchema.index({
  shift: 1,
  occurrence: 1,
});

shiftOccurrenceClaimSchema.index({
  assignment: 1,
});

module.exports = mongoose.model("ShiftOccurrenceClaim", shiftOccurrenceClaimSchema);
