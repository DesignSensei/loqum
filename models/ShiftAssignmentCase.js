// models/ShiftAssignmentCase.js

const mongoose = require("mongoose");

const { isNullableSafeInteger, hasDocumentValue } = require("./helpers/schemaValidators");

const { MAX_SHIFT_OCCURRENCES } = require("../constants/shiftPosting");

const { ASSIGNMENT_ACTOR_ROLES } = require("../constants/shiftAssignment");

const {
  ASSIGNMENT_CASE_TYPES,
  ASSIGNMENT_CASE_STATUSES,
  OPEN_ASSIGNMENT_CASE_STATUSES,
  TERMINAL_ASSIGNMENT_CASE_STATUSES,
  ASSIGNMENT_EXIT_REASONS,
  EMPLOYER_ASSIGNMENT_ISSUE_TYPES,
  PROFESSIONAL_ASSIGNMENT_RESPONSE_DECISIONS,
  EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS,
  ASSIGNMENT_CASE_RESOLUTION_OUTCOMES,
  ASSIGNMENT_EXIT_PROPOSAL_SOURCES,
  EMPLOYER_ISSUE_ALLOWED_INITIATOR_ROLES,
  EMPLOYER_ISSUE_EXIT_PROPOSAL_SOURCES,
  RESOLVED_ASSIGNMENT_CASE_STATUSES,
  REPLACEMENT_REQUEST_RETAINING_CASE_STATUSES,
  RESOLVED_EXIT_OUTCOMES,
  PROFESSIONAL_EXIT_DISALLOWED_EMPLOYER_DECISIONS,
  MAX_EXIT_PROPOSAL_DETAILS_LENGTH,
  MAX_EMPLOYER_ISSUE_DETAILS_LENGTH,
  MAX_PROFESSIONAL_RESPONSE_DETAILS_LENGTH,
  MAX_EMPLOYER_RESPONSE_DETAILS_LENGTH,
  MAX_ASSIGNMENT_CASE_RESOLUTION_REASON_LENGTH,
  MAX_ASSIGNMENT_CASE_ESCALATION_REASON_LENGTH,
  MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH,
} = require("../constants/shiftAssignmentCase");

/**
 * SHIFT ASSIGNMENT CASE ARCHITECTURE:
 *
 * This model controls early assignment exits and employer-reported assignment
 * issues. It prevents an employer from silently removing a professional and
 * prevents future occurrences from being released without a recorded process.
 *
 * professional_exit:
 * The professional submits Leave engagement and identifies the untouched
 * future occurrence tail they can no longer work. The employer may then
 * acknowledge the notice and request replacement for that exact tail.
 *
 * employer_issue:
 * The employer reports a no-show, disappearance, verbal exit notice or another
 * serious issue. Reporting the issue does not remove the professional. The
 * professional responds or the case is escalated for admin resolution.
 *
 * Only a confirmed exit resolution may cause the service layer to mark future
 * ShiftOccurrence records replacement_required and open replacement hiring.
 */

function nullableSequenceField(message) {
  return {
    type: Number,
    default: null,
    min: 1,
    max: MAX_SHIFT_OCCURRENCES,
    validate: {
      validator: isNullableSafeInteger,
      message,
    },
  };
}

const actorSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ASSIGNMENT_ACTOR_ROLES,
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    _id: false,
  }
);

const exitRangeSchema = new mongoose.Schema(
  {
    lastWorkingSequenceNumber: nullableSequenceField(
      "lastWorkingSequenceNumber must be a whole number when supplied."
    ),

    replacementStartSequenceNumber: nullableSequenceField(
      "replacementStartSequenceNumber must be a whole number when supplied."
    ),

    replacementEndSequenceNumber: nullableSequenceField(
      "replacementEndSequenceNumber must be a whole number when supplied."
    ),

    replacementOccurrenceCount: nullableSequenceField(
      "replacementOccurrenceCount must be a whole number when supplied."
    ),
  },
  {
    _id: false,
  }
);

const exitProposalSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: [...ASSIGNMENT_EXIT_PROPOSAL_SOURCES, null],
      default: null,
    },

    reason: {
      type: String,
      enum: [...ASSIGNMENT_EXIT_REASONS, null],
      default: null,
    },

    details: {
      type: String,
      trim: true,
      maxlength: MAX_EXIT_PROPOSAL_DETAILS_LENGTH,
      default: null,
    },

    range: {
      type: exitRangeSchema,
      default: () => ({}),
    },

    proposedAt: {
      type: Date,
      default: null,
    },

    proposedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    _id: false,
  }
);

const employerIssueSchema = new mongoose.Schema(
  {
    issueType: {
      type: String,
      enum: [...EMPLOYER_ASSIGNMENT_ISSUE_TYPES, null],
      default: null,
    },

    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    occurrenceSequenceNumber: nullableSequenceField(
      "occurrenceSequenceNumber must be a whole number when supplied."
    ),

    occurredAt: {
      type: Date,
      default: null,
    },

    details: {
      type: String,
      trim: true,
      maxlength: MAX_EMPLOYER_ISSUE_DETAILS_LENGTH,
      default: null,
    },

    reportedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

const professionalResponseSchema = new mongoose.Schema(
  {
    decision: {
      type: String,
      enum: [...PROFESSIONAL_ASSIGNMENT_RESPONSE_DECISIONS, null],
      default: null,
    },

    details: {
      type: String,
      trim: true,
      maxlength: MAX_PROFESSIONAL_RESPONSE_DETAILS_LENGTH,
      default: null,
    },

    respondedAt: {
      type: Date,
      default: null,
    },

    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    _id: false,
  }
);

const employerResponseSchema = new mongoose.Schema(
  {
    decision: {
      type: String,
      enum: [...EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS, null],
      default: null,
    },

    details: {
      type: String,
      trim: true,
      maxlength: MAX_EMPLOYER_RESPONSE_DETAILS_LENGTH,
      default: null,
    },

    respondedAt: {
      type: Date,
      default: null,
    },

    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    _id: false,
  }
);

const resolutionSchema = new mongoose.Schema(
  {
    outcome: {
      type: String,
      enum: [...ASSIGNMENT_CASE_RESOLUTION_OUTCOMES, null],
      default: null,
    },

    reason: {
      type: String,
      trim: true,
      maxlength: MAX_ASSIGNMENT_CASE_RESOLUTION_REASON_LENGTH,
      default: null,
    },

    effectiveExitRange: {
      type: exitRangeSchema,
      default: () => ({}),
    },

    resolvedAt: {
      type: Date,
      default: null,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    resolvedByRole: {
      type: String,
      enum: [...ASSIGNMENT_ACTOR_ROLES, null],
      default: null,
    },
  },
  {
    _id: false,
  }
);

const shiftAssignmentCaseSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      // Example: LQM-ASC-7F2A91.
    },

    caseType: {
      type: String,
      enum: ASSIGNMENT_CASE_TYPES,
      required: true,
    },

    status: {
      type: String,
      enum: ASSIGNMENT_CASE_STATUSES,
      required: true,
    },

    isOpen: {
      type: Boolean,
      default: true,
      required: true,
      // Supports one unresolved case per assignment.
    },

    // --- ASSIGNMENT CONTEXT ---

    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },

    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftAssignment",
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

    // --- INITIATOR AND CASE CONTENT ---

    initiatedBy: {
      type: actorSchema,
      required: true,
    },

    exitProposal: {
      type: exitProposalSchema,
      default: () => ({}),
    },

    employerIssue: {
      type: employerIssueSchema,
      default: () => ({}),
    },

    // --- RESPONSES ---

    professionalResponse: {
      type: professionalResponseSchema,
      default: () => ({}),
    },

    employerResponse: {
      type: employerResponseSchema,
      default: () => ({}),
    },

    // --- REPLACEMENT REQUEST ---

    replacementRequestedAt: {
      type: Date,
      default: null,
    },

    replacementRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // --- ESCALATION ---

    escalatedAt: {
      type: Date,
      default: null,
    },

    escalatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    escalationReason: {
      type: String,
      trim: true,
      maxlength: MAX_ASSIGNMENT_CASE_ESCALATION_REASON_LENGTH,
      default: null,
    },

    // --- RESOLUTION ---

    resolution: {
      type: resolutionSchema,
      default: () => ({}),
    },

    // --- TERMINAL AUDIT ---

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
      maxlength: MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH,
      default: null,
    },

    dismissedAt: {
      type: Date,
      default: null,
    },

    dismissedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    dismissalReason: {
      type: String,
      trim: true,
      maxlength: MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      maxlength: MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

function sameId(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left) === String(right);
}

function hasAnyExitRangeValue(range) {
  if (!range) {
    return false;
  }

  return [
    range.lastWorkingSequenceNumber,
    range.replacementStartSequenceNumber,
    range.replacementEndSequenceNumber,
    range.replacementOccurrenceCount,
  ].some(hasDocumentValue);
}

function validateExitRange(document, range, pathPrefix, { required = false } = {}) {
  const lastWorkingSequenceNumber = range?.lastWorkingSequenceNumber;

  const replacementStartSequenceNumber = range?.replacementStartSequenceNumber;

  const replacementEndSequenceNumber = range?.replacementEndSequenceNumber;

  const replacementOccurrenceCount = range?.replacementOccurrenceCount;

  if (!hasAnyExitRangeValue(range)) {
    if (required) {
      document.invalidate(
        `${pathPrefix}.replacementStartSequenceNumber`,
        "A replacement occurrence range is required."
      );
    }

    return;
  }

  if (!Number.isSafeInteger(replacementStartSequenceNumber)) {
    document.invalidate(
      `${pathPrefix}.replacementStartSequenceNumber`,
      "replacementStartSequenceNumber is required and must be a whole number."
    );
  }

  if (!Number.isSafeInteger(replacementEndSequenceNumber)) {
    document.invalidate(
      `${pathPrefix}.replacementEndSequenceNumber`,
      "replacementEndSequenceNumber is required and must be a whole number."
    );
  }

  if (!Number.isSafeInteger(replacementOccurrenceCount)) {
    document.invalidate(
      `${pathPrefix}.replacementOccurrenceCount`,
      "replacementOccurrenceCount is required and must be a whole number."
    );
  }

  if (
    Number.isSafeInteger(lastWorkingSequenceNumber) &&
    Number.isSafeInteger(replacementStartSequenceNumber) &&
    replacementStartSequenceNumber !== lastWorkingSequenceNumber + 1
  ) {
    document.invalidate(
      `${pathPrefix}.replacementStartSequenceNumber`,
      "replacementStartSequenceNumber must immediately follow lastWorkingSequenceNumber."
    );
  }

  if (
    Number.isSafeInteger(replacementStartSequenceNumber) &&
    Number.isSafeInteger(replacementEndSequenceNumber) &&
    replacementEndSequenceNumber < replacementStartSequenceNumber
  ) {
    document.invalidate(
      `${pathPrefix}.replacementEndSequenceNumber`,
      "replacementEndSequenceNumber cannot be earlier than replacementStartSequenceNumber."
    );
  }

  if (
    Number.isSafeInteger(replacementStartSequenceNumber) &&
    Number.isSafeInteger(replacementEndSequenceNumber) &&
    Number.isSafeInteger(replacementOccurrenceCount)
  ) {
    const expectedCount = replacementEndSequenceNumber - replacementStartSequenceNumber + 1;

    if (replacementOccurrenceCount !== expectedCount) {
      document.invalidate(
        `${pathPrefix}.replacementOccurrenceCount`,
        "replacementOccurrenceCount must match the replacement sequence range."
      );
    }
  }
}

shiftAssignmentCaseSchema.pre("validate", function validateShiftAssignmentCase() {
  const statusIsOpen = OPEN_ASSIGNMENT_CASE_STATUSES.includes(this.status);

  const statusIsTerminal = TERMINAL_ASSIGNMENT_CASE_STATUSES.includes(this.status);

  const hasProfessionalResponse = Boolean(this.professionalResponse?.decision);

  const hasEmployerResponse = Boolean(this.employerResponse?.decision);

  // --- STATUS AND INITIATOR ---

  if (statusIsOpen && this.isOpen !== true) {
    this.invalidate("isOpen", `isOpen must be true while case status is ${this.status}.`);
  }

  if (statusIsTerminal && this.isOpen !== false) {
    this.invalidate("isOpen", `isOpen must be false when case status is ${this.status}.`);
  }

  if (this.initiatedBy?.role !== "system" && !this.initiatedBy?.userId) {
    this.invalidate(
      "initiatedBy.userId",
      "initiatedBy.userId is required when a user initiates the case."
    );
  }

  // --- CASE TYPE ---

  if (this.caseType === "professional_exit") {
    if (this.initiatedBy?.role !== "professional") {
      this.invalidate(
        "initiatedBy.role",
        "A professional exit case must be initiated by the professional."
      );
    }

    if (this.exitProposal?.source !== "professional_notice") {
      this.invalidate(
        "exitProposal.source",
        "A professional exit case must use professional_notice as its exit proposal source."
      );
    }

    if (!this.exitProposal?.reason) {
      this.invalidate(
        "exitProposal.reason",
        "exitProposal.reason is required for a professional exit case."
      );
    }

    if (!this.exitProposal?.proposedAt || !this.exitProposal?.proposedBy) {
      this.invalidate(
        "exitProposal.proposedAt",
        "exitProposal.proposedAt and proposedBy are required for a professional exit case."
      );
    }

    if (
      this.initiatedBy?.userId &&
      this.exitProposal?.proposedBy &&
      !sameId(this.initiatedBy.userId, this.exitProposal.proposedBy)
    ) {
      this.invalidate(
        "exitProposal.proposedBy",
        "The professional who initiated the case must own the exit proposal."
      );
    }

    validateExitRange(this, this.exitProposal?.range, "exitProposal.range", {
      required: true,
    });

    if (this.employerIssue?.issueType) {
      this.invalidate(
        "employerIssue.issueType",
        "A professional exit case cannot also contain an employer issue."
      );
    }

    if (hasProfessionalResponse) {
      this.invalidate(
        "professionalResponse.decision",
        "A professional exit case cannot contain a separate professional response."
      );
    }
  }

  if (this.caseType === "employer_issue") {
    if (!EMPLOYER_ISSUE_ALLOWED_INITIATOR_ROLES.includes(this.initiatedBy?.role)) {
      this.invalidate(
        "initiatedBy.role",
        "An employer issue case must be initiated by an employer, admin or the system."
      );
    }

    if (!this.employerIssue?.issueType) {
      this.invalidate(
        "employerIssue.issueType",
        "employerIssue.issueType is required for an employer issue case."
      );
    }

    if (!this.employerIssue?.reportedAt) {
      this.invalidate(
        "employerIssue.reportedAt",
        "employerIssue.reportedAt is required for an employer issue case."
      );
    }

    if (
      this.exitProposal?.source &&
      !EMPLOYER_ISSUE_EXIT_PROPOSAL_SOURCES.includes(this.exitProposal.source)
    ) {
      this.invalidate(
        "exitProposal.source",
        "An employer issue exit proposal must come from a professional response or admin decision."
      );
    }
  }

  // --- WORKFLOW STATUS ---

  if (this.status === "awaiting_employer_acknowledgment" && this.caseType !== "professional_exit") {
    this.invalidate("status", "Only a professional exit case may await employer acknowledgment.");
  }

  if (this.status === "awaiting_professional_response" && this.caseType !== "employer_issue") {
    this.invalidate("status", "Only an employer issue case may await a professional response.");
  }

  if (this.status === "awaiting_employer_response") {
    if (this.caseType !== "employer_issue") {
      this.invalidate("status", "Only an employer issue case may await an employer response.");
    }

    if (!hasProfessionalResponse) {
      this.invalidate(
        "professionalResponse.decision",
        "A professional response is required before the case can await employer action."
      );
    }
  }

  // --- PROFESSIONAL RESPONSE ---

  if (hasProfessionalResponse) {
    if (!this.professionalResponse?.respondedAt || !this.professionalResponse?.respondedBy) {
      this.invalidate(
        "professionalResponse.respondedAt",
        "professionalResponse.respondedAt and respondedBy are required."
      );
    }
  } else if (this.professionalResponse?.respondedAt || this.professionalResponse?.respondedBy) {
    this.invalidate(
      "professionalResponse.decision",
      "professionalResponse.decision is required when response data is recorded."
    );
  }

  if (this.professionalResponse?.decision === "confirm_exit") {
    if (this.exitProposal?.source !== "professional_response") {
      this.invalidate(
        "exitProposal.source",
        "A confirmed employer-issue exit must use professional_response as its source."
      );
    }

    if (!this.exitProposal?.proposedAt || !this.exitProposal?.proposedBy) {
      this.invalidate(
        "exitProposal.proposedAt",
        "The confirmed exit proposal must record proposedAt and proposedBy."
      );
    }

    if (
      this.professionalResponse?.respondedBy &&
      this.exitProposal?.proposedBy &&
      !sameId(this.professionalResponse.respondedBy, this.exitProposal.proposedBy)
    ) {
      this.invalidate(
        "exitProposal.proposedBy",
        "The professional response author must own the confirmed exit proposal."
      );
    }

    validateExitRange(this, this.exitProposal?.range, "exitProposal.range", {
      required: true,
    });
  }

  // --- EMPLOYER RESPONSE ---

  if (
    this.caseType === "professional_exit" &&
    PROFESSIONAL_EXIT_DISALLOWED_EMPLOYER_DECISIONS.includes(this.employerResponse?.decision)
  ) {
    this.invalidate(
      "employerResponse.decision",
      "A professional exit request cannot be treated as continuation or dismissed as an issue."
    );
  }

  if (
    this.employerResponse?.decision === "accept_continuation" &&
    this.professionalResponse?.decision !== "continue_assignment"
  ) {
    this.invalidate(
      "employerResponse.decision",
      "The employer may accept continuation only after the professional confirms continuation."
    );
  }

  if (this.employerResponse?.decision === "dismiss_issue" && this.caseType !== "employer_issue") {
    this.invalidate("employerResponse.decision", "Only an employer issue case may be dismissed.");
  }

  if (hasEmployerResponse) {
    if (!this.employerResponse?.respondedAt || !this.employerResponse?.respondedBy) {
      this.invalidate(
        "employerResponse.respondedAt",
        "employerResponse.respondedAt and respondedBy are required."
      );
    }
  } else if (this.employerResponse?.respondedAt || this.employerResponse?.respondedBy) {
    this.invalidate(
      "employerResponse.decision",
      "employerResponse.decision is required when response data is recorded."
    );
  }

  if (
    this.employerResponse?.decision === "acknowledge_and_request_replacement" &&
    this.caseType !== "professional_exit" &&
    this.professionalResponse?.decision !== "confirm_exit"
  ) {
    this.invalidate(
      "employerResponse.decision",
      "Replacement may be requested only after a professional exit or confirmed exit response."
    );
  }

  // --- REPLACEMENT AND ESCALATION ---

  if (this.status === "replacement_requested") {
    if (!this.replacementRequestedAt || !this.replacementRequestedBy) {
      this.invalidate(
        "replacementRequestedAt",
        "replacementRequestedAt and replacementRequestedBy are required."
      );
    }

    if (
      this.employerResponse?.respondedBy &&
      this.replacementRequestedBy &&
      !sameId(this.employerResponse.respondedBy, this.replacementRequestedBy)
    ) {
      this.invalidate(
        "replacementRequestedBy",
        "The employer response author must own the replacement request."
      );
    }

    if (this.employerResponse?.decision !== "acknowledge_and_request_replacement") {
      this.invalidate(
        "employerResponse.decision",
        "The employer must acknowledge and request replacement before this status is used."
      );
    }

    validateExitRange(this, this.exitProposal?.range, "exitProposal.range", {
      required: true,
    });
  }

  if (
    !REPLACEMENT_REQUEST_RETAINING_CASE_STATUSES.includes(this.status) &&
    (this.replacementRequestedAt || this.replacementRequestedBy)
  ) {
    this.invalidate(
      "replacementRequestedAt",
      "Replacement request data may remain only on replacement_requested or resolved_exit cases."
    );
  }

  if (this.status === "under_admin_review") {
    if (!this.escalatedAt || !this.escalationReason) {
      this.invalidate(
        "escalatedAt",
        "escalatedAt and escalationReason are required during admin review."
      );
    }
  }

  // --- RESOLUTION ---

  if (RESOLVED_ASSIGNMENT_CASE_STATUSES.includes(this.status)) {
    if (!this.resolution?.outcome) {
      this.invalidate("resolution.outcome", "resolution.outcome is required for a resolved case.");
    }

    if (!this.resolution?.resolvedAt || !this.resolution?.resolvedByRole) {
      this.invalidate(
        "resolution.resolvedAt",
        "resolution.resolvedAt and resolvedByRole are required for a resolved case."
      );
    }

    if (this.resolution?.resolvedByRole !== "system" && !this.resolution?.resolvedBy) {
      this.invalidate(
        "resolution.resolvedBy",
        "resolution.resolvedBy is required when a user resolves the case."
      );
    }
  }

  if (this.status === "resolved_continue") {
    if (this.caseType !== "employer_issue") {
      this.invalidate(
        "status",
        "Only an employer issue case may resolve with the assignment continuing."
      );
    }

    if (this.resolution?.outcome !== "continue_assignment") {
      this.invalidate(
        "resolution.outcome",
        "A resolved_continue case must have continue_assignment outcome."
      );
    }

    if (hasAnyExitRangeValue(this.resolution?.effectiveExitRange)) {
      this.invalidate(
        "resolution.effectiveExitRange",
        "A continued assignment cannot contain an effective exit range."
      );
    }
  }

  if (this.status === "resolved_exit") {
    if (!RESOLVED_EXIT_OUTCOMES.includes(this.resolution?.outcome)) {
      this.invalidate(
        "resolution.outcome",
        "A resolved_exit case must confirm an exit or assignment termination."
      );
    }

    validateExitRange(this, this.resolution?.effectiveExitRange, "resolution.effectiveExitRange", {
      required: true,
    });
  }

  // --- TERMINAL STATES ---

  if (this.status === "withdrawn") {
    if (this.caseType !== "professional_exit") {
      this.invalidate("status", "Only a professional exit case may be withdrawn.");
    }

    if (!this.withdrawnAt || !this.withdrawnBy) {
      this.invalidate(
        "withdrawnAt",
        "withdrawnAt and withdrawnBy are required when a case is withdrawn."
      );
    }
  }

  if (this.status === "dismissed") {
    if (this.caseType !== "employer_issue") {
      this.invalidate("status", "Only an employer issue case may be dismissed.");
    }

    if (!this.dismissedAt || !this.dismissedBy) {
      this.invalidate(
        "dismissedAt",
        "dismissedAt and dismissedBy are required when a case is dismissed."
      );
    }
  }

  if (this.status === "cancelled" && !this.cancelledAt) {
    this.invalidate("cancelledAt", "cancelledAt is required when a case is cancelled.");
  }

  const terminalTimestamps = {
    withdrawn: this.withdrawnAt,
    dismissed: this.dismissedAt,
    cancelled: this.cancelledAt,
  };

  for (const [terminalStatus, timestamp] of Object.entries(terminalTimestamps)) {
    if (this.status !== terminalStatus && timestamp) {
      this.invalidate(
        `${terminalStatus}At`,
        `${terminalStatus}At can only be recorded when status is ${terminalStatus}.`
      );
    }
  }
});

shiftAssignmentCaseSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

shiftAssignmentCaseSchema.index(
  {
    assignment: 1,
    isOpen: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      isOpen: true,
    },
  }
);

shiftAssignmentCaseSchema.index({
  shift: 1,
  status: 1,
  createdAt: -1,
});

shiftAssignmentCaseSchema.index({
  professional: 1,
  status: 1,
  createdAt: -1,
});

shiftAssignmentCaseSchema.index({
  business: 1,
  status: 1,
  createdAt: -1,
});

shiftAssignmentCaseSchema.index({
  caseType: 1,
  status: 1,
  createdAt: -1,
});

shiftAssignmentCaseSchema.index({
  "employerIssue.occurrence": 1,
});

shiftAssignmentCaseSchema.index({
  replacementRequestedAt: 1,
  status: 1,
});

shiftAssignmentCaseSchema.index({
  escalatedAt: 1,
  status: 1,
});

module.exports = mongoose.model("ShiftAssignmentCase", shiftAssignmentCaseSchema);
