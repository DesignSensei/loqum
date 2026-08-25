// models/ShiftOccurrenceClaim.js

const mongoose = require("mongoose");

const { requiredUniqueEnumArrayField } = require("./helpers/schemaFields");
const occurrenceEvidenceSchema = require("./helpers/occurrenceEvidenceSchema");

const {
  FINANCIAL_OCCURRENCE_CLAIM_TYPES,
  OCCURRENCE_CLAIM_STATUSES,
  OCCURRENCE_CLAIM_ISSUE_STATUSES,
  EMPLOYER_FINANCIAL_CLAIM_DECISIONS,
  OCCURRENCE_CLAIM_APPEAL_STATUSES,
  OCCURRENCE_CLAIM_REBUTTAL_STATUSES,
  ADMIN_FINANCIAL_CLAIM_DECISIONS,
  OCCURRENCE_CLAIM_ESCALATION_REASONS,
} = require("../constants/shiftLifecycle");

const { SETTLEMENT_BATCH_COMPONENTS } = require("../constants/shiftSettlement");

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

    message: "A claim issue cannot contain more than 10 evidence items in one evidence set.",
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

const professionalIssueDetailsSchema = new mongoose.Schema(
  {
    attendanceCorrection: {
      type: attendanceCorrectionPositionSchema,
      default: null,
    },

    /**
     * Optional professional estimate for a BASE-pay complaint.
     *
     * It is not financial authority. Final BASE entitlement is always
     * recalculated by the resolution/settlement services.
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
     * Required when admin chooses adjusted and the final result cannot be
     * fully expressed by the structured fields above.
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

/* ─────────────────────────────── CLAIM ISSUE ─────────────────────────────── */

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
     * Service-derived immutable component scope for this individual issue.
     *
     * The professional never submits backend component names directly.
     *
     * This issue-level scope is the only stored settlement-component scope
     * authority on the claim.
     *
     * Live blocking scope is derived only from unresolved issues.
     */
    affectedSettlementComponents: requiredUniqueEnumArrayField({
      values: SETTLEMENT_BATCH_COMPONENTS,

      immutable: true,

      message:
        "Claim issue affectedSettlementComponents must contain one or more unique valid settlement components.",
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

    // --- PROFESSIONAL REBUTTAL ---

    rebuttalStatus: {
      type: String,
      enum: OCCURRENCE_CLAIM_REBUTTAL_STATUSES,
      default: "not_available",
      required: true,
    },

    rebuttalDeadlineAt: {
      type: Date,
      default: null,
    },

    rebuttedAt: {
      type: Date,
      default: null,
    },

    rebuttedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    rebuttalStatement: {
      type: String,
      trim: true,
      minlength: 10,
      maxlength: 2000,
      default: null,
    },

    rebuttalEvidence: evidenceArrayField(),

    // --- ISSUE WORKFLOW ---

    status: {
      type: String,
      enum: OCCURRENCE_CLAIM_ISSUE_STATUSES,
      default: "awaiting_employer_review",
      required: true,
    },

    // --- EMPLOYER REVIEW ---

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
     * Used only when the employer rejects the professional's requested
     * correction and proposes a different factual/financial position.
     *
     * Empty counterPosition means the employer says the existing Loqum record
     * should remain unchanged.
     */
    employerCounterPosition: {
      type: employerCounterPositionSchema,
      default: null,
    },

    employerEvidence: evidenceArrayField(),

    // --- PROFESSIONAL APPEAL ---

    appealStatus: {
      type: String,
      enum: OCCURRENCE_CLAIM_APPEAL_STATUSES,
      default: "not_available",
      required: true,
    },

    appealDeadlineAt: {
      type: Date,
      default: null,
    },

    appealedAt: {
      type: Date,
      default: null,
    },

    appealedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    appealStatement: {
      type: String,
      trim: true,
      minlength: 10,
      maxlength: 2000,
      default: null,
    },

    appealEvidence: evidenceArrayField(),

    // --- ADMIN ESCALATION ---

    escalatedAt: {
      type: Date,
      default: null,
    },

    escalationReason: {
      type: String,
      enum: [...OCCURRENCE_CLAIM_ESCALATION_REASONS, null],
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

/* ─────────────────────────────── CLAIM CASE ─────────────────────────────── */

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

    // --- IMMUTABLE ORIGINAL ISSUE SET ---

    /**
     * Immutable list of ordinary issue types included in the professional's
     * one original claim submission.
     *
     * This list prevents later addition/removal of issue types while allowing
     * workflow fields inside each issue to evolve.
     *
     * It is not settlement-component scope.
     */
    submittedIssueTypes: requiredUniqueEnumArrayField({
      values: FINANCIAL_OCCURRENCE_CLAIM_TYPES,

      immutable: true,

      message:
        "submittedIssueTypes must contain one or more unique valid professional claim issue types.",
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

    // --- SHARED OCCURRENCE CHALLENGE WINDOW SNAPSHOT ---

    /**
     * Historical copy of the ShiftOccurrence-owned shared challenge window
     * that permitted this original professional claim submission.
     *
     * Submitting this claim does not close the ShiftOccurrence challenge
     * window. The employer may still use its unused ordinary dispute right
     * before the shared deadline for a genuinely different issue.
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
     * All issues are submitted together, so they share one employer response
     * deadline. At expiry, only still-unresolved employer-review issues are
     * escalated for employer non-response.
     */
    employerResponseDeadlineAt: {
      type: Date,
      required: true,
      immutable: true,
    },

    // --- PRE-CLAIM FACT SNAPSHOT ---

    /**
     * Snapshot of challenge-relevant occurrence facts immediately before the
     * professional claim is created.
     *
     * This snapshot is evidential/restorative context only. It must never own
     * settlement, platform-fee, refund, OT-decision, delinquency or challenge-
     * window authority.
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
          "lifecycleSnapshot must contain only challenge-relevant occurrence facts and must not contain settlement, platform-fee, refund, overtime, delinquency, employer-charge, legacy final or challenge-window authority fields.",
      },
    },

    // --- CASE WORKFLOW STATUS ---

    /**
     * Case status is intentionally coarse.
     *
     * active:
     * At least one issue is unresolved.
     *
     * resolved:
     * Every issue is finally resolved.
     *
     * withdrawn:
     * The professional withdrew the untouched claim before employer action.
     */
    status: {
      type: String,
      enum: OCCURRENCE_CLAIM_STATUSES,
      default: "active",
      required: true,
    },

    // --- REFUND RELATIONSHIP ---

    /**
     * EmployerRefund relates only to scheduled/base allocation.
     *
     * The relationship is valid only when at least one submitted claim issue
     * affects BASE.
     *
     * There is no case-level component-scope authority.
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

function validateClaimIssue(claim, issue, index) {
  const pathPrefix = `issues.${index}`;

  const affectedComponents = normalizeComponents(issue.affectedSettlementComponents);

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

  const employerCounterPosition = issue.employerCounterPosition || null;

  const hasCounterPosition = hasEmployerCounterPosition(employerCounterPosition);

  const hasProfessionalEvidence = Array.isArray(issue.evidence) && issue.evidence.length > 0;

  const hasEmployerEvidence =
    Array.isArray(issue.employerEvidence) && issue.employerEvidence.length > 0;

  const hasAppealSubmission =
    hasAny([issue.appealedAt, issue.appealedBy, issue.appealStatement]) ||
    (Array.isArray(issue.appealEvidence) && issue.appealEvidence.length > 0);

  const hasRebuttalSubmission =
    hasAny([issue.rebuttedAt, issue.rebuttedBy, issue.rebuttalStatement]) ||
    (Array.isArray(issue.rebuttalEvidence) && issue.rebuttalEvidence.length > 0);

  if (issue.appealStatus !== "not_available" && issue.rebuttalStatus !== "not_available") {
    claim.invalidate(
      `${pathPrefix}.appealStatus`,
      "An issue cannot have both appeal and rebuttal lifecycles active."
    );
  }

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

  const adminOutcome = issue.adminOutcome || null;

  const hasStructuredAdminOutcome = hasAdminOutcome(adminOutcome);

  /* ─────────────────────────────── TYPE / COMPONENT SCOPE ─────────────────────────────── */

  if (!FINANCIAL_OCCURRENCE_CLAIM_TYPES.includes(issue.type)) {
    claim.invalidate(`${pathPrefix}.type`, "Professional claim issue type is invalid.");
  }

  if (affectedComponents.length === 0) {
    claim.invalidate(
      `${pathPrefix}.affectedSettlementComponents`,
      "Each professional claim issue must affect at least one settlement component."
    );
  }

  if (issue.type === "attendance_correction") {
    if (!hasAttendanceCorrection) {
      claim.invalidate(
        `${pathPrefix}.details.attendanceCorrection`,
        "attendance_correction requires a corrected check-in time, corrected checkout time, or both."
      );
    }

    if (hasExpectedBasePay) {
      claim.invalidate(
        `${pathPrefix}.details.expectedBaseProfessionalPay`,
        "attendance_correction cannot also contain an expected BASE-pay amount."
      );
    }

    validateAttendancePosition(
      claim,
      attendanceCorrection,
      `${pathPrefix}.details.attendanceCorrection`,
      "Professional"
    );
  }

  if (issue.type === "payment_calculation") {
    if (hasAttendanceCorrection) {
      claim.invalidate(
        `${pathPrefix}.details.attendanceCorrection`,
        "payment_calculation cannot contain attendance-correction timestamps."
      );
    }

    if (!sameComponents(affectedComponents, ["base"])) {
      claim.invalidate(
        `${pathPrefix}.affectedSettlementComponents`,
        "payment_calculation is a BASE claim and must affect only the base settlement component."
      );
    }
  }

  if (issue.type === "employer_fault") {
    if (hasAttendanceCorrection) {
      claim.invalidate(
        `${pathPrefix}.details.attendanceCorrection`,
        "employer_fault cannot contain attendance-correction timestamps."
      );
    }

    if (!affectedComponents.includes("base")) {
      claim.invalidate(
        `${pathPrefix}.affectedSettlementComponents`,
        "employer_fault must affect BASE entitlement and cannot be used as an overtime-only claim."
      );
    }
  }

  /* ─────────────────────────────── EMPLOYER REVIEW ─────────────────────────────── */

  if (hasEmployerDecision) {
    if (!issue.employerDecisionReason || !issue.employerDecidedAt || !issue.employerDecidedBy) {
      claim.invalidate(
        `${pathPrefix}.employerDecidedAt`,
        "An employer issue decision requires a reason, decision time and deciding user."
      );
    }
  } else if (hasEmployerDecisionAudit || hasCounterPosition || hasEmployerEvidence) {
    claim.invalidate(
      `${pathPrefix}.employerDecision`,
      "Employer decision audit, counter-position or evidence requires an employer decision."
    );
  }

  if (issue.employerDecidedAt && claim.submittedAt && issue.employerDecidedAt < claim.submittedAt) {
    claim.invalidate(
      `${pathPrefix}.employerDecidedAt`,
      "The employer cannot decide an issue before the claim is submitted."
    );
  }

  if (
    issue.employerDecidedAt &&
    claim.employerResponseDeadlineAt &&
    issue.employerDecidedAt >= claim.employerResponseDeadlineAt
  ) {
    claim.invalidate(
      `${pathPrefix}.employerDecidedAt`,
      "The employer decision must be recorded before employerResponseDeadlineAt."
    );
  }

  if (issue.employerDecision === "approved" && hasCounterPosition) {
    claim.invalidate(
      `${pathPrefix}.employerCounterPosition`,
      "Employer approval accepts the professional's requested issue outcome and cannot contain a different counter-position."
    );
  }

  if (hasCounterPosition) {
    if (!hasProfessionalEvidence) {
      claim.invalidate(
        `${pathPrefix}.employerCounterPosition`,
        "An employer counter-position requires the professional's original claim issue to contain supporting evidence."
      );
    }

    if (!hasEmployerEvidence) {
      claim.invalidate(
        `${pathPrefix}.employerEvidence`,
        "An employer counter-position requires supporting employer evidence."
      );
    }

    validateAttendancePosition(
      claim,
      employerCounterPosition,
      `${pathPrefix}.employerCounterPosition`,
      "Employer"
    );

    if (
      issue.type !== "attendance_correction" &&
      (employerCounterPosition.correctedCheckInAt || employerCounterPosition.correctedCheckOutAt)
    ) {
      claim.invalidate(
        `${pathPrefix}.employerCounterPosition`,
        "Employer attendance counter-position is only valid for an attendance_correction issue."
      );
    }

    if (
      issue.type === "attendance_correction" &&
      hasValue(employerCounterPosition.proposedBaseProfessionalPay)
    ) {
      claim.invalidate(
        `${pathPrefix}.employerCounterPosition.proposedBaseProfessionalPay`,
        "attendance_correction employer counter-position must state attendance facts, not a replacement BASE-pay amount."
      );
    }
  }

  /* ─────────────────────────────── APPEAL ─────────────────────────────── */

  if (issue.appealStatus === "not_available") {
    if (issue.appealDeadlineAt || hasAppealSubmission) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "An unavailable issue appeal cannot contain an appeal deadline or appeal submission."
      );
    }
  }

  if (["available", "submitted", "expired", "resolved"].includes(issue.appealStatus)) {
    if (
      issue.employerDecision !== "rejected" ||
      !issue.appealDeadlineAt ||
      !issue.employerDecidedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        `${issue.appealStatus} issue appeal status requires an employer rejection and appeal deadline.`
      );
    }

    if (
      issue.appealDeadlineAt &&
      issue.employerDecidedAt &&
      issue.appealDeadlineAt <= issue.employerDecidedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.appealDeadlineAt`,
        "Issue appeal deadline must be later than the employer rejection."
      );
    }
  }

  if (issue.appealStatus !== "not_available" && hasCounterPosition) {
    claim.invalidate(
      `${pathPrefix}.appealStatus`,
      "A claim issue with an employer counter-position cannot use the professional appeal lifecycle."
    );
  }

  if (issue.appealStatus === "available") {
    if (hasAppealSubmission) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "An available issue appeal cannot already contain submitted appeal details."
      );
    }

    if (
      hasEscalationAudit ||
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasStructuredAdminOutcome ||
      hasAdminEvidence
    ) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "An available issue appeal cannot already contain escalation or admin-resolution data."
      );
    }
  }

  if (issue.appealStatus === "submitted") {
    if (!issue.appealedAt || !issue.appealedBy || !issue.appealStatement) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "A submitted issue appeal requires appeal time, appealing user and appeal statement."
      );
    }

    if (issue.appealedAt && issue.employerDecidedAt && issue.appealedAt < issue.employerDecidedAt) {
      claim.invalidate(
        `${pathPrefix}.appealedAt`,
        "An issue appeal cannot be submitted before the employer decision."
      );
    }

    if (issue.appealedAt && issue.appealDeadlineAt && issue.appealedAt >= issue.appealDeadlineAt) {
      claim.invalidate(
        `${pathPrefix}.appealedAt`,
        "An issue appeal must be submitted before appealDeadlineAt."
      );
    }
  }

  if (issue.appealStatus === "expired") {
    if (hasAppealSubmission) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "An expired issue appeal cannot contain submitted appeal details."
      );
    }

    if (
      hasEscalationAudit ||
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasStructuredAdminOutcome ||
      hasAdminEvidence
    ) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "An unappealed employer rejection cannot contain admin-escalation data."
      );
    }
  }

  if (issue.appealStatus === "resolved") {
    if (!issue.appealedAt || !issue.appealedBy || !issue.appealStatement || !hasAdminDecision) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "A resolved issue appeal requires a submitted professional appeal and final admin decision."
      );
    }
  }

  /* ─────────────────────────────── REBUTTAL ─────────────────────────────── */

  if (issue.rebuttalStatus === "not_available") {
    if (issue.rebuttalDeadlineAt || hasRebuttalSubmission) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "An unavailable issue rebuttal cannot contain a rebuttal deadline or rebuttal submission."
      );
    }
  }

  if (["available", "submitted", "expired", "resolved"].includes(issue.rebuttalStatus)) {
    if (
      issue.employerDecision !== "rejected" ||
      !hasCounterPosition ||
      !issue.rebuttalDeadlineAt ||
      !issue.employerDecidedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        `${issue.rebuttalStatus} issue rebuttal status requires employer rejection, counter-position and rebuttal deadline.`
      );
    }

    if (
      issue.rebuttalDeadlineAt &&
      issue.employerDecidedAt &&
      issue.rebuttalDeadlineAt <= issue.employerDecidedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.rebuttalDeadlineAt`,
        "Issue rebuttal deadline must be later than employer counter-position."
      );
    }
  }

  if (issue.rebuttalStatus === "available") {
    if (hasRebuttalSubmission) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "An available issue rebuttal cannot already contain submitted rebuttal details."
      );
    }
  }

  if (issue.rebuttalStatus === "submitted") {
    if (!issue.rebuttedAt || !issue.rebuttedBy || !issue.rebuttalStatement) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "A submitted issue rebuttal requires rebuttal time, submitting user and rebuttal statement."
      );
    }

    if (
      issue.rebuttedAt &&
      issue.rebuttalDeadlineAt &&
      issue.rebuttedAt >= issue.rebuttalDeadlineAt
    ) {
      claim.invalidate(
        `${pathPrefix}.rebuttedAt`,
        "An issue rebuttal must be submitted before rebuttalDeadlineAt."
      );
    }
  }

  if (issue.rebuttalStatus === "expired") {
    if (hasRebuttalSubmission) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "An expired issue rebuttal cannot contain submitted rebuttal details."
      );
    }
  }

  if (issue.rebuttalStatus === "resolved") {
    if (!issue.rebuttedAt || !issue.rebuttedBy || !issue.rebuttalStatement || !hasAdminDecision) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "A resolved issue rebuttal requires submitted professional rebuttal and final admin decision."
      );
    }
  }

  if (issue.rebuttedAt && issue.employerDecidedAt && issue.rebuttedAt < issue.employerDecidedAt) {
    claim.invalidate(
      `${pathPrefix}.rebuttedAt`,
      "An issue rebuttal cannot be submitted before the employer decision."
    );
  }

  /* ─────────────────────────────── ESCALATION ─────────────────────────────── */

  if (hasEscalationAudit) {
    if (!issue.escalatedAt || !issue.escalationReason) {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Issue escalation requires escalatedAt and escalationReason."
      );
    }
  }

  if (issue.escalatedAt && claim.submittedAt && issue.escalatedAt < claim.submittedAt) {
    claim.invalidate(
      `${pathPrefix}.escalatedAt`,
      "An issue cannot be escalated before the claim is submitted."
    );
  }

  if (issue.escalationReason === "professional_appeal") {
    if (
      issue.employerDecision !== "rejected" ||
      !["submitted", "resolved"].includes(issue.appealStatus) ||
      !issue.appealedAt ||
      !issue.appealStatement
    ) {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Professional-appeal escalation requires an employer rejection and submitted professional appeal."
      );
    }

    if (issue.escalatedAt && issue.appealedAt && issue.escalatedAt < issue.appealedAt) {
      claim.invalidate(
        `${pathPrefix}.escalatedAt`,
        "Professional-appeal escalation cannot predate the appeal."
      );
    }
  }

  if (issue.escalationReason === "employer_counter_position") {
    if (
      issue.employerDecision !== "rejected" ||
      !hasCounterPosition ||
      !["submitted", "expired", "resolved"].includes(issue.rebuttalStatus)
    ) {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Employer counter-position escalation requires an employer rejection, supported counter-position and a submitted, expired or resolved professional rebuttal lifecycle."
      );
    }
  }

  if (issue.escalationReason === "employer_non_response") {
    if (
      hasEmployerDecision ||
      !claim.employerResponseDeadlineAt ||
      !issue.escalatedAt ||
      issue.escalatedAt < claim.employerResponseDeadlineAt
    ) {
      claim.invalidate(
        `${pathPrefix}.escalationReason`,
        "Employer non-response escalation requires no employer decision and an expired employer response deadline."
      );
    }

    if (issue.appealStatus !== "not_available") {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "Employer non-response escalation cannot create a professional appeal."
      );
    }
  }

  /* ─────────────────────────────── ADMIN DECISION ─────────────────────────────── */

  if (hasAdminDecision) {
    if (
      !issue.adminDecisionReason ||
      !issue.adminDecidedAt ||
      !issue.adminDecidedBy ||
      !issue.escalatedAt ||
      !issue.escalationReason
    ) {
      claim.invalidate(
        `${pathPrefix}.adminDecidedAt`,
        "An admin issue decision requires escalation, reason, decision time and deciding user."
      );
    }
  } else if (hasAdminDecisionAudit || hasStructuredAdminOutcome) {
    claim.invalidate(
      `${pathPrefix}.adminDecision`,
      "Admin decision audit or final outcome requires an admin decision."
    );
  }

  if (hasAdminEvidence && !issue.escalatedAt) {
    claim.invalidate(
      `${pathPrefix}.adminEvidence`,
      "Admin evidence may only be recorded after the issue has been escalated for admin review."
    );
  }

  if (issue.adminDecidedAt && issue.escalatedAt && issue.adminDecidedAt < issue.escalatedAt) {
    claim.invalidate(
      `${pathPrefix}.adminDecidedAt`,
      "Admin cannot decide an issue before escalation."
    );
  }

  validateAdminOutcome(claim, adminOutcome, `${pathPrefix}.adminOutcome`);

  if (issue.adminDecision === "adjusted" && !hasStructuredAdminOutcome) {
    claim.invalidate(
      `${pathPrefix}.adminOutcome`,
      "An adjusted admin decision requires a recorded final adjusted outcome."
    );
  }

  if (issue.adminDecision === "adjusted" && issue.type === "attendance_correction") {
    if (!adminOutcome?.finalCheckInAt && !adminOutcome?.finalCheckOutAt) {
      claim.invalidate(
        `${pathPrefix}.adminOutcome`,
        "An adjusted attendance_correction requires final authoritative check-in, checkout, or both."
      );
    }

    if (hasValue(adminOutcome?.finalBaseProfessionalPay)) {
      claim.invalidate(
        `${pathPrefix}.adminOutcome.finalBaseProfessionalPay`,
        "An attendance_correction establishes attendance facts; BASE pay must be recalculated from those facts."
      );
    }
  }

  if (
    issue.adminDecision === "adjusted" &&
    issue.type === "payment_calculation" &&
    !hasValue(adminOutcome?.finalBaseProfessionalPay)
  ) {
    claim.invalidate(
      `${pathPrefix}.adminOutcome.finalBaseProfessionalPay`,
      "An adjusted payment_calculation requires the final authoritative BASE professional-pay amount."
    );
  }

  if (issue.adminDecision !== "adjusted" && hasStructuredAdminOutcome) {
    claim.invalidate(
      `${pathPrefix}.adminOutcome`,
      "Only an adjusted admin decision may contain replacement authoritative facts or values."
    );
  }

  if (
    issue.type !== "attendance_correction" &&
    adminOutcome &&
    (adminOutcome.finalCheckInAt || adminOutcome.finalCheckOutAt)
  ) {
    claim.invalidate(
      `${pathPrefix}.adminOutcome`,
      "Admin attendance outcome fields are only valid for an attendance_correction issue."
    );
  }

  if (issue.adminDecision === "approve_employer" && !hasCounterPosition) {
    claim.invalidate(
      `${pathPrefix}.adminDecision`,
      "approve_employer requires an employer counter-position on the claim issue."
    );
  }

  /* ─────────────────────────────── ISSUE STATUS ─────────────────────────────── */

  if (issue.status === "awaiting_employer_review") {
    if (
      hasEmployerDecision ||
      hasEmployerDecisionAudit ||
      hasCounterPosition ||
      hasEmployerEvidence ||
      issue.appealStatus !== "not_available" ||
      hasAppealSubmission ||
      hasEscalationAudit ||
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasStructuredAdminOutcome ||
      hasAdminEvidence ||
      issue.resolvedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_employer_review cannot contain employer decision, appeal, escalation, admin resolution or finalization data."
      );
    }
  }

  if (issue.status === "awaiting_professional_appeal") {
    if (
      issue.employerDecision !== "rejected" ||
      issue.appealStatus !== "available" ||
      !issue.appealDeadlineAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_professional_appeal requires employer rejection and an available appeal."
      );
    }

    if (
      hasAppealSubmission ||
      hasEscalationAudit ||
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasStructuredAdminOutcome ||
      hasAdminEvidence ||
      issue.resolvedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_professional_appeal cannot contain submitted appeal, escalation, admin resolution or finalization data."
      );
    }
  }

  if (issue.status === "awaiting_professional_rebuttal") {
    if (
      issue.employerDecision !== "rejected" ||
      !hasCounterPosition ||
      issue.rebuttalStatus !== "available" ||
      !issue.rebuttalDeadlineAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_professional_rebuttal requires employer counter-position and available rebuttal."
      );
    }

    if (
      issue.appealStatus !== "not_available" ||
      hasAppealSubmission ||
      hasRebuttalSubmission ||
      hasEscalationAudit ||
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasStructuredAdminOutcome ||
      hasAdminEvidence ||
      issue.resolvedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_professional_rebuttal cannot contain submitted rebuttal, escalation, admin resolution or finalization data."
      );
    }
  }

  if (issue.status === "awaiting_admin_review") {
    if (!issue.escalatedAt || !issue.escalationReason) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_admin_review requires an escalated issue."
      );
    }

    if (issue.escalationReason === "professional_appeal" && issue.appealStatus !== "submitted") {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "A professionally appealed issue awaiting admin review must have submitted appeal status."
      );
    }

    if (
      issue.escalationReason === "employer_non_response" &&
      issue.appealStatus !== "not_available"
    ) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "Employer non-response issue awaiting admin review cannot have an appeal lifecycle."
      );
    }

    if (
      issue.escalationReason === "employer_counter_position" &&
      !["submitted", "expired"].includes(issue.rebuttalStatus)
    ) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "Employer counter-position issue awaiting admin review must have submitted or expired rebuttal status."
      );
    }

    if (
      issue.escalationReason !== "employer_counter_position" &&
      issue.rebuttalStatus !== "not_available"
    ) {
      claim.invalidate(
        `${pathPrefix}.rebuttalStatus`,
        "Only employer_counter_position escalation may use the rebuttal lifecycle."
      );
    }

    if (
      hasAdminDecision ||
      hasAdminDecisionAudit ||
      hasStructuredAdminOutcome ||
      issue.resolvedAt
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "awaiting_admin_review cannot contain a final admin outcome or resolvedAt."
      );
    }
  }

  if (issue.status === "resolved") {
    if (!issue.resolvedAt) {
      claim.invalidate(`${pathPrefix}.resolvedAt`, "A resolved claim issue requires resolvedAt.");
    }

    const resolvedByEmployerApproval =
      issue.employerDecision === "approved" &&
      issue.employerDecisionReason &&
      issue.employerDecidedAt &&
      issue.employerDecidedBy &&
      issue.appealStatus === "not_available" &&
      issue.rebuttalStatus === "not_available" &&
      !hasEscalationAudit &&
      !hasAdminDecision;

    const resolvedByUnappealedEmployerRejection =
      issue.employerDecision === "rejected" &&
      issue.employerDecisionReason &&
      issue.employerDecidedAt &&
      issue.employerDecidedBy &&
      !hasCounterPosition &&
      issue.appealStatus === "expired" &&
      issue.appealDeadlineAt &&
      issue.rebuttalStatus === "not_available" &&
      !hasAppealSubmission &&
      !hasEscalationAudit;

    const resolvedByAdmin =
      hasAdminDecision &&
      issue.adminDecisionReason &&
      issue.adminDecidedAt &&
      issue.adminDecidedBy &&
      issue.escalatedAt &&
      issue.escalationReason &&
      issue.escalationReason !== "employer_counter_position";

    const resolvedByEmployerCounterPositionAdmin =
      issue.escalationReason === "employer_counter_position" &&
      ["resolved", "expired"].includes(issue.rebuttalStatus) &&
      hasAdminDecision &&
      issue.adminDecisionReason &&
      issue.adminDecidedAt &&
      issue.adminDecidedBy &&
      issue.escalatedAt;

    if (
      !resolvedByEmployerApproval &&
      !resolvedByUnappealedEmployerRejection &&
      !resolvedByAdmin &&
      !resolvedByEmployerCounterPositionAdmin
    ) {
      claim.invalidate(
        `${pathPrefix}.status`,
        "A resolved claim issue requires employer approval, an unappealed employer rejection or a final admin decision."
      );
    }

    if (issue.escalationReason === "professional_appeal" && issue.appealStatus !== "resolved") {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "A professionally appealed issue must have resolved appeal status after the admin decision."
      );
    }

    if (
      issue.escalationReason === "employer_non_response" &&
      issue.appealStatus !== "not_available"
    ) {
      claim.invalidate(
        `${pathPrefix}.appealStatus`,
        "Employer non-response resolution cannot contain a professional appeal."
      );
    }
  } else if (issue.resolvedAt) {
    claim.invalidate(
      `${pathPrefix}.resolvedAt`,
      "resolvedAt may only be set when the claim issue status is resolved."
    );
  }

  /* ─────────────────────────────── DATE ORDERING ─────────────────────────────── */

  if (issue.resolvedAt && claim.submittedAt && issue.resolvedAt < claim.submittedAt) {
    claim.invalidate(
      `${pathPrefix}.resolvedAt`,
      "Issue resolvedAt cannot be earlier than claim submittedAt."
    );
  }

  if (issue.resolvedAt && issue.employerDecidedAt && issue.resolvedAt < issue.employerDecidedAt) {
    claim.invalidate(
      `${pathPrefix}.resolvedAt`,
      "Issue resolvedAt cannot be earlier than the employer decision."
    );
  }

  if (issue.resolvedAt && issue.adminDecidedAt && issue.resolvedAt < issue.adminDecidedAt) {
    claim.invalidate(
      `${pathPrefix}.resolvedAt`,
      "Issue resolvedAt cannot be earlier than the admin decision."
    );
  }
}

/* ─────────────────────────────── CASE VALIDATION ─────────────────────────────── */

shiftOccurrenceClaimSchema.pre("validate", function validateShiftOccurrenceClaim() {
  const issues = Array.isArray(this.issues) ? this.issues : [];

  const submittedIssueTypes = normalizeIssueTypes(this.submittedIssueTypes);

  const actualIssueTypes = normalizeIssueTypes(issues.map((issue) => issue?.type));

  /**
   * Derived only for validation.
   *
   * This is not stored on the case.
   *
   * Original submitted component scope can always be reconstructed from all
   * issues, while live scope is reconstructed from unresolved issues only.
   */
  const submittedIssueComponents = SETTLEMENT_BATCH_COMPONENTS.filter((component) =>
    issues.some((issue) =>
      normalizeComponents(issue?.affectedSettlementComponents).includes(component)
    )
  );

  const hasWithdrawalAudit = hasAny([this.withdrawnAt, this.withdrawnBy, this.withdrawalReason]);

  /* ─────────────────────────────── ORIGINAL ISSUE SET ─────────────────────────────── */

  if (submittedIssueTypes.length === 0) {
    this.invalidate(
      "submittedIssueTypes",
      "A professional claim must contain at least one submitted ordinary issue type."
    );
  }

  if (!sameIssueTypes(submittedIssueTypes, actualIssueTypes)) {
    this.invalidate(
      "issues",
      "The claim issues must exactly match the immutable submittedIssueTypes set."
    );
  }

  issues.forEach((issue, index) => {
    validateClaimIssue(this, issue, index);
  });

  /*
   * EmployerRefund is a BASE-only relationship.
   *
   * There is deliberately no persisted case-level component union.
   */
  if (this.employerRefund && !submittedIssueComponents.includes("base")) {
    this.invalidate(
      "employerRefund",
      "A claim with no BASE-affecting issue cannot own a scheduled/base EmployerRefund relationship."
    );
  }

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
      "A professional claim cannot be submitted before the shared occurrence challenge window opens."
    );
  }

  /**
   * At the deadline the ordinary submission right has expired.
   */
  if (
    this.submittedAt &&
    this.challengeDeadlineAt &&
    this.submittedAt >= this.challengeDeadlineAt
  ) {
    this.invalidate(
      "submittedAt",
      "A professional claim must be submitted strictly before challengeDeadlineAt."
    );
  }

  /* ─────────────────────────────── EMPLOYER RESPONSE CLOCK ─────────────────────────────── */

  if (
    this.employerResponseDeadlineAt &&
    this.submittedAt &&
    this.employerResponseDeadlineAt <= this.submittedAt
  ) {
    this.invalidate(
      "employerResponseDeadlineAt",
      "employerResponseDeadlineAt must be later than submittedAt."
    );
  }

  /* ─────────────────────────────── CASE STATUS ─────────────────────────────── */

  const unresolvedIssues = issues.filter((issue) => issue?.status !== "resolved");

  const resolvedIssues = issues.filter((issue) => issue?.status === "resolved");

  if (this.status === "active") {
    if (unresolvedIssues.length === 0) {
      this.invalidate("status", "An active claim must contain at least one unresolved issue.");
    }

    if (this.resolvedAt || hasWithdrawalAudit) {
      this.invalidate(
        "status",
        "An active claim cannot contain case resolution or withdrawal audit."
      );
    }
  }

  if (this.status === "resolved") {
    if (issues.length === 0 || resolvedIssues.length !== issues.length) {
      this.invalidate("status", "A resolved claim requires every submitted issue to be resolved.");
    }

    if (!this.resolvedAt) {
      this.invalidate("resolvedAt", "A resolved claim requires resolvedAt.");
    }

    if (hasWithdrawalAudit) {
      this.invalidate("status", "A resolved claim cannot also contain withdrawal details.");
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
        "Claim resolvedAt cannot be earlier than the latest issue resolution."
      );
    }
  } else if (this.resolvedAt) {
    this.invalidate("resolvedAt", "resolvedAt may only be set when claim status is resolved.");
  }

  if (this.status === "withdrawn") {
    if (!this.withdrawnAt || !this.withdrawnBy || !this.withdrawalReason) {
      this.invalidate(
        "withdrawnAt",
        "A withdrawn claim requires withdrawal time, user and reason."
      );
    }

    if (this.resolvedAt) {
      this.invalidate("status", "A withdrawn claim cannot also be resolved.");
    }

    /**
     * Withdrawal is allowed only before the employer has acted on any issue
     * and before any appeal/admin path has started.
     */
    const hasStartedIssueAdjudication = issues.some(
      (issue) =>
        issue?.status !== "awaiting_employer_review" ||
        hasValue(issue?.employerDecision) ||
        issue?.employerDecidedAt ||
        issue?.appealStatus !== "not_available" ||
        issue?.rebuttalStatus !== "not_available" ||
        issue?.escalatedAt ||
        hasValue(issue?.adminDecision) ||
        issue?.resolvedAt
    );

    if (hasStartedIssueAdjudication) {
      this.invalidate(
        "status",
        "A professional claim may be withdrawn only before employer review or adjudication begins."
      );
    }
  } else if (hasWithdrawalAudit) {
    this.invalidate("withdrawnAt", "Withdrawal details require claim status withdrawn.");
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

/**
 * One original professional claim case per occurrence.
 *
 * Multiple ordinary professional issues are carried inside this one case.
 */
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
  "issues.appealDeadlineAt": 1,
  "issues.rebuttalDeadlineAt": 1,
});

shiftOccurrenceClaimSchema.index({
  status: 1,
  "issues.status": 1,
  "issues.escalationReason": 1,
  "issues.escalatedAt": 1,
});

/**
 * Issue-level component scope is the only stored component-scope authority.
 *
 * Combining it with issue status supports unresolved-component queries without
 * reintroducing a case-level aggregate field.
 */
shiftOccurrenceClaimSchema.index({
  "issues.affectedSettlementComponents": 1,
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
