// services/shiftAssignmentCaseService.js

const mongoose = require("mongoose");

const ShiftAssignment = require("../models/ShiftAssignment");
const ShiftAssignmentCase = require("../models/ShiftAssignmentCase");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const ShiftAssignmentService = require("./shiftAssignmentService");
const PlatformSettingsService = require("./platformSettingsService");
const { createServiceError } = require("./helpers/serviceErrorHelper");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");
const CASE = require("../constants/shiftAssignmentCase");

const MINUTE_MS = 60 * 1000;

/**
 * Assignment-case workflow authority.
 *
 * actor is trusted server authentication context, never a request-body object:
 * { role, userId, professionalProfileId?, businessId?, employerContext? }.
 * Controllers must authenticate admin/system access before constructing actor.
 * Professional ownership is also checked against ProfessionalProfile.user.
 * Employer access is restricted to the assignment business and allowed branches.
 *
 * All commands use a transaction and the same parent Shift lock as assignment
 * acceptance. The case and occurrence ownership are reloaded after that lock.
 *
 * Exit confirmation closes the case immediately as resolved_exit. Replacement
 * hiring remains available through replacement_required occurrences referencing
 * that case. Hiring does not determine whether the original exit was authorized.
 *
 * This service never changes attendance, money, platform-fee audits or PINs.
 * It releases only an untouched future tail. Isolated occurrence replacement,
 * active-work cancellation and payout adjudication belong to their own flows.
 */
class ShiftAssignmentCaseService {
  /* ------------------------- Validation ------------------------- */

  static error(message, code, statusCode = 409) {
    return createServiceError({
      name: "ShiftAssignmentCaseServiceError",
      message,
      code,
      statusCode,
    });
  }

  static objectId(value, fieldName) {
    if (!value || !mongoose.isValidObjectId(value)) {
      throw this.error(`A valid ${fieldName} is required.`, "INVALID_CASE_CONTEXT_ID", 400);
    }

    return new mongoose.Types.ObjectId(String(value));
  }

  static sameId(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  static text(value, fieldName, maximumLength, required = true) {
    if (value === null || value === undefined) {
      if (!required) return null;
      throw this.error(`${fieldName} is required.`, "CASE_TEXT_REQUIRED", 400);
    }

    if (typeof value !== "string") {
      throw this.error(`${fieldName} must be text.`, "INVALID_CASE_TEXT", 400);
    }

    const normalized = value.trim();

    if ((!normalized && required) || normalized.length > maximumLength) {
      throw this.error(`${fieldName} is missing or too long.`, "INVALID_CASE_TEXT", 400);
    }

    return normalized || null;
  }

  static choice(value, choices, fieldName) {
    if (!choices.includes(value)) {
      throw this.error(`${fieldName} is invalid.`, "INVALID_CASE_DECISION", 400);
    }

    return value;
  }

  static time(value = new Date()) {
    const date = value instanceof Date ? new Date(value.getTime()) : null;

    if (!date || !Number.isFinite(date.getTime())) {
      throw this.error("currentTime must be a valid Date.", "INVALID_CASE_TIME", 400);
    }

    return date;
  }

  static actor(input) {
    if (!input || !["professional", "employer", "admin", "system"].includes(input.role)) {
      throw this.error("Authenticated actor context is required.", "CASE_ACTOR_REQUIRED", 403);
    }

    return {
      ...input,
      userId: input.role === "system" ? null : this.objectId(input.userId, "actor user ID"),
    };
  }

  static async transaction(options, callback) {
    if (
      options.session &&
      (typeof options.session.inTransaction !== "function" || !options.session.inTransaction())
    ) {
      throw this.error(
        "A supplied session must have an active transaction.",
        "ACTIVE_TRANSACTION_REQUIRED",
        500
      );
    }

    return runWithOptionalTransaction(options, callback);
  }

  static requireStatus(assignmentCase, statuses) {
    if (!statuses.includes(assignmentCase.status)) {
      throw this.error(
        "This action is not available in the current case state.",
        "CASE_ACTION_NOT_AVAILABLE"
      );
    }
  }

  static assertTimeOrder(assignmentCase, currentTime) {
    const timestamps = [
      assignmentCase.createdAt,
      assignmentCase.exitProposal?.proposedAt,
      assignmentCase.employerIssue?.reportedAt,
      assignmentCase.professionalResponse?.respondedAt,
      assignmentCase.employerResponse?.respondedAt,
      assignmentCase.escalatedAt,
      assignmentCase.resolution?.resolvedAt,
    ];

    if (timestamps.some((value) => value && new Date(value) > currentTime)) {
      throw this.error(
        "Case actions cannot predate recorded case activity.",
        "CASE_TIME_ORDER_INVALID"
      );
    }
  }

  /* ------------------------- Context and authorization ------------------------- */

  static async authorize(actor, assignment, session) {
    if (["admin", "system"].includes(actor.role)) return;

    if (actor.role === "professional") {
      if (!this.sameId(actor.professionalProfileId, assignment.professional)) {
        throw this.error(
          "This assignment belongs to another professional.",
          "CASE_ACCESS_DENIED",
          403
        );
      }

      const professional = await ProfessionalProfile.findOne({
        _id: assignment.professional,
        user: actor.userId,
      }).session(session);

      if (!professional) {
        throw this.error(
          "Professional authentication does not match this assignment.",
          "CASE_ACCESS_DENIED",
          403
        );
      }

      return;
    }

    if (!this.sameId(actor.businessId, assignment.business)) {
      throw this.error("This assignment belongs to another business.", "CASE_ACCESS_DENIED", 403);
    }

    const context = actor.employerContext;
    const allBranches = context?.isPrimaryEmployer === true || context?.isBusinessAdmin === true;
    const assignedBranches = Array.isArray(context?.assignedBranchIds)
      ? context.assignedBranchIds
      : [];
    const branchAllowed =
      context?.isBranchManager === true &&
      assignedBranches.some((branchId) => this.sameId(branchId, assignment.branch));

    if (!allBranches && !branchAllowed) {
      throw this.error("You cannot manage cases for this branch.", "CASE_ACCESS_DENIED", 403);
    }
  }

  static async loadContext({ assignmentId, caseId, actor, currentTime, session }) {
    // This first read locates the parent; authoritative records are reloaded below.
    const locator = caseId
      ? await ShiftAssignmentCase.findById(this.objectId(caseId, "case ID")).session(session)
      : await ShiftAssignment.findById(this.objectId(assignmentId, "assignment ID")).session(
          session
        );

    if (!locator)
      throw this.error("Assignment or case was not found.", "ASSIGNMENT_CASE_NOT_FOUND", 404);

    if (caseId && assignmentId && !this.sameId(locator.assignment, assignmentId)) {
      throw this.error(
        "The supplied case and assignment do not match.",
        "ASSIGNMENT_CASE_CONTEXT_MISMATCH"
      );
    }

    const shift = await ShiftAssignmentService.lockShiftAndProfessional({
      shiftId: locator.shift,
      session,
    });

    const assignment = await ShiftAssignment.findById(
      caseId ? locator.assignment : locator._id
    ).session(session);

    if (
      !assignment ||
      !this.sameId(assignment.shift, shift._id) ||
      !this.sameId(assignment.business, shift.business) ||
      !this.sameId(assignment.branch, shift.branch)
    ) {
      throw this.error(
        "Assignment context does not match the Shift.",
        "ASSIGNMENT_CASE_CONTEXT_MISMATCH"
      );
    }

    await this.authorize(actor, assignment, session);

    if (currentTime < new Date(assignment.assignedAt)) {
      throw this.error(
        "Case activity cannot predate assignment acceptance.",
        "CASE_TIME_ORDER_INVALID"
      );
    }

    let assignmentCase = null;

    if (caseId) {
      assignmentCase = await ShiftAssignmentCase.findById(locator._id).session(session);

      if (
        !assignmentCase ||
        !this.sameId(assignmentCase.assignment, assignment._id) ||
        !this.sameId(assignmentCase.shift, shift._id) ||
        !this.sameId(assignmentCase.business, assignment.business) ||
        !this.sameId(assignmentCase.branch, assignment.branch) ||
        !this.sameId(assignmentCase.professional, assignment.professional)
      ) {
        throw this.error(
          "Case context does not match the assignment.",
          "ASSIGNMENT_CASE_CONTEXT_MISMATCH"
        );
      }

      this.assertTimeOrder(assignmentCase, currentTime);

      if (
        CASE.OPEN_ASSIGNMENT_CASE_STATUSES.includes(assignmentCase.status) &&
        (!assignmentCase.isOpen || !this.sameId(assignment.openCase, assignmentCase._id))
      ) {
        throw this.error(
          "The assignment no longer points to this open case.",
          "ASSIGNMENT_OPEN_CASE_MISMATCH"
        );
      }
    }

    return { shift, assignment, assignmentCase, actor, currentTime, session };
  }

  static async runCaseCommand(payload, options, roles, command, opening = false) {
    this.objectId(
      opening ? payload.assignmentId : payload.caseId,
      opening ? "assignment ID" : "case ID"
    );

    if (opening && payload.caseId) {
      throw this.error(
        "Opening a case requires an assignment, not an existing case ID.",
        "INVALID_CASE_CONTEXT_ID",
        400
      );
    }

    const actor = this.actor(payload.actor);
    const currentTime = this.time(payload.currentTime);
    this.choice(actor.role, roles, "Actor role");

    return this.transaction(options, async (session) => {
      const context = await this.loadContext({ ...payload, actor, currentTime, session });
      await command(context);
      return this.saveContext(context);
    });
  }

  static async saveContext(context) {
    const { assignmentCase, assignment, shift, currentTime, session } = context;
    await assignmentCase.save({ session });
    await assignment.save({ session });
    await ShiftAssignmentService.refreshAssignmentProgress({ shift, session, currentTime });
    await shift.save({ session });

    return { assignmentCase, assignment, shift };
  }

  /* ------------------------- Opening cases ------------------------- */

  static async assertCanOpen(context) {
    const { assignment, shift, currentTime, session } = context;

    if (
      !["scheduled", "active"].includes(assignment.status) ||
      assignment.openCase ||
      assignment.endCase ||
      ["pending_funding", "cancelled", "completed"].includes(shift.status) ||
      currentTime < new Date(assignment.assignedAt)
    ) {
      throw this.error(
        "This assignment cannot open another case.",
        "ASSIGNMENT_CASE_OPEN_NOT_ALLOWED"
      );
    }

    const existing = await ShiftAssignmentCase.findOne({
      assignment: assignment._id,
      isOpen: true,
    }).session(session);

    if (existing)
      throw this.error(
        "This assignment already has an unresolved case.",
        "ASSIGNMENT_CASE_ALREADY_OPEN"
      );
  }

  static newCase(context, caseType, status) {
    const { assignment, shift, actor } = context;
    const id = new mongoose.Types.ObjectId();

    return new ShiftAssignmentCase({
      _id: id,
      referenceCode: `LQM-ASC-${String(id).toUpperCase()}`,
      caseType,
      status,
      isOpen: true,
      shift: shift._id,
      assignment: assignment._id,
      business: assignment.business,
      branch: assignment.branch,
      professional: assignment.professional,
      initiatedBy: { role: actor.role, userId: actor.userId },
    });
  }

  static async openProfessionalExit(payload, options = {}) {
    return this.runCaseCommand(
      payload,
      options,
      ["professional"],
      async (context) => {
        await this.assertCanOpen(context);
        const { range } = await this.loadExitTail(context, payload.replacementStartSequenceNumber);
        const assignmentCase = this.newCase(
          context,
          "professional_exit",
          "awaiting_employer_acknowledgment"
        );

        assignmentCase.exitProposal = {
          source: "professional_notice",
          reason: this.choice(payload.reason, CASE.ASSIGNMENT_EXIT_REASONS, "Exit reason"),
          details: this.text(
            payload.details,
            "Exit details",
            CASE.MAX_EXIT_PROPOSAL_DETAILS_LENGTH,
            payload.reason === "other"
          ),
          range,
          proposedAt: context.currentTime,
          proposedBy: context.actor.userId,
        };

        context.assignmentCase = assignmentCase;
        context.assignment.openCase = assignmentCase._id;
      },
      true
    );
  }

  static async openEmployerIssue(payload, options = {}) {
    return this.runCaseCommand(
      payload,
      options,
      ["employer", "admin", "system"],
      async (context) => {
        await this.assertCanOpen(context);
        let occurrence = null;

        if (payload.occurrenceId) {
          occurrence = await ShiftOccurrence.findOne({
            _id: this.objectId(payload.occurrenceId, "occurrence ID"),
            shift: context.shift._id,
            assignment: context.assignment._id,
            slotNumber: context.assignment.slotNumber,
            assignedProfessional: context.assignment.professional,
          }).session(context.session);

          if (!occurrence)
            throw this.error(
              "The reported occurrence is not owned by this assignment.",
              "CASE_OCCURRENCE_MISMATCH"
            );
        }

        const issueType = this.choice(
          payload.issueType,
          CASE.EMPLOYER_ASSIGNMENT_ISSUE_TYPES,
          "Issue type"
        );
        if (issueType === "missed_occurrence" && !occurrence) {
          throw this.error("Select the missed occurrence.", "CASE_OCCURRENCE_REQUIRED", 400);
        }

        const occurredAt = payload.occurredAt == null ? null : this.time(payload.occurredAt);
        if (occurredAt && occurredAt > context.currentTime) {
          throw this.error(
            "An issue cannot be reported as occurring in the future.",
            "CASE_TIME_ORDER_INVALID",
            400
          );
        }

        const assignmentCase = this.newCase(
          context,
          "employer_issue",
          "awaiting_professional_response"
        );
        assignmentCase.employerIssue = {
          issueType,
          occurrence: occurrence?._id || null,
          occurrenceSequenceNumber: occurrence?.sequenceNumber || null,
          occurredAt,
          details: this.text(
            payload.details,
            "Issue details",
            CASE.MAX_EMPLOYER_ISSUE_DETAILS_LENGTH
          ),
          reportedAt: context.currentTime,
        };

        context.assignmentCase = assignmentCase;
        context.assignment.openCase = assignmentCase._id;
      },
      true
    );
  }

  /* ------------------------- Responses and escalation ------------------------- */

  static async respondAsProfessional(payload, options = {}) {
    return this.runCaseCommand(payload, options, ["professional"], async (context) => {
      const { assignmentCase, actor, currentTime } = context;
      this.requireStatus(assignmentCase, ["awaiting_professional_response"]);
      const decision = this.choice(
        payload.decision,
        CASE.PROFESSIONAL_ASSIGNMENT_RESPONSE_DECISIONS,
        "Professional decision"
      );

      if (decision === "confirm_exit") {
        const { range } = await this.loadExitTail(context, payload.replacementStartSequenceNumber);
        assignmentCase.exitProposal = {
          source: "professional_response",
          reason: this.choice(payload.reason, CASE.ASSIGNMENT_EXIT_REASONS, "Exit reason"),
          details: this.text(
            payload.exitDetails,
            "Exit details",
            CASE.MAX_EXIT_PROPOSAL_DETAILS_LENGTH,
            payload.reason === "other"
          ),
          range,
          proposedAt: currentTime,
          proposedBy: actor.userId,
        };
      }

      assignmentCase.professionalResponse = {
        decision,
        details: this.text(
          payload.details,
          "Response details",
          CASE.MAX_PROFESSIONAL_RESPONSE_DETAILS_LENGTH
        ),
        respondedAt: currentTime,
        respondedBy: actor.userId,
      };

      assignmentCase.status = "awaiting_employer_response";
    });
  }

  static async respondAsEmployer(payload, options = {}) {
    return this.runCaseCommand(payload, options, ["employer"], async (context) => {
      const { assignmentCase, actor, currentTime } = context;
      this.requireStatus(assignmentCase, [
        "awaiting_employer_acknowledgment",
        "awaiting_employer_response",
      ]);
      const decision = this.choice(
        payload.decision,
        CASE.EMPLOYER_ASSIGNMENT_RESPONSE_DECISIONS,
        "Employer decision"
      );
      const details = this.text(
        payload.details,
        "Response details",
        CASE.MAX_EMPLOYER_RESPONSE_DETAILS_LENGTH
      );

      if (
        assignmentCase.caseType === "professional_exit" &&
        CASE.PROFESSIONAL_EXIT_DISALLOWED_EMPLOYER_DECISIONS.includes(decision)
      ) {
        throw this.error(
          "A professional exit cannot be dismissed or accepted as continuation.",
          "CASE_DECISION_NOT_ALLOWED"
        );
      }

      if (
        decision === "accept_continuation" &&
        assignmentCase.professionalResponse?.decision !== "continue_assignment"
      ) {
        throw this.error(
          "The professional must confirm continuation first.",
          "CASE_DECISION_NOT_ALLOWED"
        );
      }

      if (
        decision === "acknowledge_and_request_replacement" &&
        assignmentCase.caseType !== "professional_exit" &&
        assignmentCase.professionalResponse?.decision !== "confirm_exit"
      ) {
        throw this.error(
          "Replacement requires a professional exit notice or confirmed exit response.",
          "CASE_EXIT_NOT_CONFIRMED"
        );
      }

      assignmentCase.employerResponse = {
        decision,
        details,
        respondedAt: currentTime,
        respondedBy: actor.userId,
      };

      if (decision === "acknowledge_and_request_replacement") {
        assignmentCase.replacementRequestedAt = currentTime;
        assignmentCase.replacementRequestedBy = actor.userId;
        await this.confirmExit(context, {
          startSequence: assignmentCase.exitProposal.range.replacementStartSequenceNumber,
          outcome: "exit_confirmed",
          reason: details,
        });
      } else if (decision === "accept_continuation") {
        this.resolveContinuation(context, details);
      } else if (decision === "dismiss_issue") {
        this.closeCase(
          context,
          "dismissed",
          this.text(details, "Dismissal reason", CASE.MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH)
        );
      } else {
        this.stageEscalation(context, details);
      }
    });
  }

  static stageEscalation(context, reason) {
    const { assignmentCase, actor, currentTime } = context;
    this.requireStatus(assignmentCase, [
      "awaiting_employer_acknowledgment",
      "awaiting_professional_response",
      "awaiting_employer_response",
    ]);
    assignmentCase.status = "under_admin_review";
    assignmentCase.escalatedAt = currentTime;
    assignmentCase.escalatedBy = actor.userId;
    assignmentCase.escalationReason = reason;
  }

  static async escalateCase(payload, options = {}) {
    return this.runCaseCommand(
      payload,
      options,
      ["professional", "employer", "admin", "system"],
      async (context) => {
        this.stageEscalation(
          context,
          this.text(
            payload.reason,
            "Escalation reason",
            CASE.MAX_ASSIGNMENT_CASE_ESCALATION_REASON_LENGTH
          )
        );
      }
    );
  }

  static async resolveByAdmin(payload, options = {}) {
    return this.runCaseCommand(payload, options, ["admin"], async (context) => {
      this.requireStatus(context.assignmentCase, ["under_admin_review"]);
      const outcome = this.choice(
        payload.outcome,
        CASE.ASSIGNMENT_CASE_RESOLUTION_OUTCOMES,
        "Resolution outcome"
      );
      const reason = this.text(
        payload.reason,
        "Resolution reason",
        CASE.MAX_ASSIGNMENT_CASE_RESOLUTION_REASON_LENGTH
      );

      if (outcome === "continue_assignment") {
        this.resolveContinuation(context, reason);
      } else {
        await this.confirmExit(context, {
          startSequence: payload.replacementStartSequenceNumber,
          outcome,
          reason,
        });
      }
    });
  }

  static resolveContinuation(context, reason) {
    const { assignmentCase, assignment, actor, currentTime } = context;
    if (assignmentCase.caseType !== "employer_issue") {
      throw this.error(
        "A professional exit cannot resolve as continuation under the current case contract.",
        "CASE_CONTINUATION_NOT_ALLOWED"
      );
    }

    assignmentCase.status = "resolved_continue";
    assignmentCase.isOpen = false;
    assignmentCase.resolution = {
      outcome: "continue_assignment",
      reason,
      resolvedAt: currentTime,
      resolvedBy: actor.userId,
      resolvedByRole: actor.role,
    };
    assignment.openCase = null;
  }

  /* ------------------------- Exit range and replacement preparation ------------------------- */

  static async loadExitTail(context, startSequence) {
    const { assignment, shift, currentTime, session } = context;
    if (
      !Number.isSafeInteger(startSequence) ||
      startSequence < assignment.startSequence ||
      startSequence > assignment.plannedEndSequence
    ) {
      throw this.error(
        "Select a sequence within the assignment's planned range.",
        "CASE_EXIT_RANGE_INVALID",
        400
      );
    }

    if (!["scheduled", "active"].includes(assignment.status)) {
      throw this.error(
        "This assignment can no longer confirm a new exit.",
        "CASE_ASSIGNMENT_NOT_OPERATIONAL"
      );
    }

    if (assignment.status === "scheduled" && startSequence !== assignment.startSequence) {
      throw this.error(
        "A scheduled assignment can only cancel its entire range before activation.",
        "SCHEDULED_PARTIAL_EXIT_NOT_SUPPORTED"
      );
    }

    if (assignment.status === "active" && startSequence === assignment.startSequence) {
      throw this.error(
        "The current assignment model cannot represent an active exit before its first sequence.",
        "ACTIVE_EMPTY_RANGE_EXIT_NOT_SUPPORTED"
      );
    }

    const occurrences = await ShiftOccurrence.find({
      shift: shift._id,
      slotNumber: assignment.slotNumber,
      sequenceNumber: { $gte: startSequence, $lte: assignment.plannedEndSequence },
    })
      .sort({ sequenceNumber: 1 })
      .session(session);

    ShiftAssignmentService.assertExactSequenceRange({
      occurrences,
      startSequenceNumber: startSequence,
      endSequenceNumber: assignment.plannedEndSequence,
    });

    for (const occurrence of occurrences) {
      if (
        !this.sameId(occurrence.assignment, assignment._id) ||
        !this.sameId(occurrence.assignedProfessional, assignment.professional) ||
        !this.sameId(occurrence.business, assignment.business) ||
        !this.sameId(occurrence.branch, assignment.branch) ||
        occurrence.assignmentStatus !== "assigned" ||
        !ShiftAssignmentService.isOccurrenceUntouched(occurrence) ||
        !ShiftAssignmentService.refundWorkflowHasNotStarted(occurrence) ||
        !occurrence.fillCutoffAt ||
        new Date(occurrence.fillCutoffAt) <= currentTime ||
        !occurrence.startTime ||
        new Date(occurrence.startTime) <= currentTime ||
        occurrence.activeClaim ||
        occurrence.activeDispute ||
        occurrence.overtime?.requested ||
        occurrence.checkoutFallback?.required ||
        occurrence.earlyTermination?.occurred ||
        occurrence.attendanceOverride?.used ||
        occurrence.baseSettlement?.status !== "not_due" ||
        occurrence.overtimeSettlement?.status !== "not_due" ||
        occurrence.baseProfessionalPay !== 0 ||
        occurrence.overtimeProfessionalPay !== 0 ||
        occurrence.overtimePlatformFee !== 0 ||
        occurrence.topUpRequired !== 0 ||
        occurrence.topUpTransaction ||
        occurrence.overtimePlatformFeeAudit?.earnedAt
      ) {
        throw this.error(
          "The exit tail is no longer untouched and available for replacement.",
          "CASE_EXIT_TAIL_NOT_AVAILABLE"
        );
      }
    }

    return {
      occurrences,
      range: {
        lastWorkingSequenceNumber:
          startSequence === assignment.startSequence ? null : startSequence - 1,
        replacementStartSequenceNumber: startSequence,
        replacementEndSequenceNumber: assignment.plannedEndSequence,
        replacementOccurrenceCount: occurrences.length,
      },
    };
  }

  static async confirmExit(context, { startSequence, outcome, reason }) {
    const { assignmentCase, assignment, shift, actor, currentTime, session } = context;
    const { occurrences, range } = await this.loadExitTail(context, startSequence);
    const settings = await PlatformSettingsService.getAttendanceSettings();
    const graceMinutes = settings?.unfilledFinalizationGraceMinutes;

    if (!Number.isSafeInteger(graceMinutes) || graceMinutes <= 0) {
      throw this.error(
        "Unfilled finalization grace must be a positive integer.",
        "INVALID_UNFILLED_FINALIZATION_SETTINGS",
        500
      );
    }

    // Confirm existing protected allocations before changing occurrence ownership.
    const allOccurrences = await ShiftAssignmentService.getOccurrences(shift, session);
    await ShiftAssignmentService.assertAssignmentFunding({ shift, allOccurrences, session });

    assignment.openCase = null;

    if (assignment.status === "scheduled") {
      assignment.status = "cancelled";
      assignment.cancelledAt = currentTime;
      assignment.cancelledBy = actor.userId;
      assignment.cancelledByRole = actor.role;
      assignment.cancellationReason = reason.slice(0, 500);
    } else {
      const endpoint = allOccurrences.find(
        (occurrence) =>
          occurrence.slotNumber === assignment.slotNumber &&
          occurrence.sequenceNumber === startSequence - 1
      );
      if (!endpoint)
        throw this.error(
          "The retained assignment endpoint was not found.",
          "CASE_ENDPOINT_NOT_FOUND"
        );

      assignment.effectiveEndSequence = startSequence - 1;
      assignment.effectiveOccurrenceCount = startSequence - assignment.startSequence;
      assignment.effectiveEndsAt = endpoint.endTime;
      assignment.endCase = assignmentCase._id;
      assignment.endingRequestedAt =
        assignmentCase.exitProposal?.proposedAt || assignmentCase.employerIssue.reportedAt;
      assignment.endingConfirmedAt = currentTime;
      assignment.endingConfirmedBy = actor.userId;
      assignment.endingConfirmedByRole = actor.role;
      assignment.endReason = actor.role === "admin" ? "admin_action" : "professional_request";
      assignment.endNotes = reason.slice(0, 500);
      assignment.status = "ending";
      await ShiftAssignmentService.finalizeEndingAssignmentIfDue({
        assignment,
        currentTime,
        session,
      });
    }

    assignment.openCase = null;
    assignmentCase.status = "resolved_exit";
    assignmentCase.isOpen = false;
    assignmentCase.resolution = {
      outcome,
      reason,
      effectiveExitRange: range,
      resolvedAt: currentTime,
      resolvedBy: actor.userId,
      resolvedByRole: actor.role,
    };

    for (const occurrence of occurrences) {
      const finalizationAt = new Date(
        new Date(occurrence.fillCutoffAt).getTime() + graceMinutes * MINUTE_MS
      );
      if (!Number.isFinite(finalizationAt.getTime()) || finalizationAt <= occurrence.fillCutoffAt) {
        throw this.error(
          "Replacement finalization deadline is invalid.",
          "INVALID_REPLACEMENT_DEADLINE",
          500
        );
      }

      occurrence.assignmentStatus = "replacement_required";
      occurrence.assignedProfessional = null;
      occurrence.assignment = null;
      occurrence.assignedAt = null;
      occurrence.replacementRequiredAt = currentTime;
      occurrence.replacementForAssignment = assignment._id;
      occurrence.replacementCase = assignmentCase._id;
      occurrence.replacementReasonCode = "release_request";
      occurrence.replacementReasonDetails = reason.slice(0, 500);
      occurrence.unfilledFinalizationAt = finalizationAt;
      await occurrence.save({ session });
    }
  }

  /* ------------------------- Withdrawal, dismissal and cancellation ------------------------- */

  static closeCase(context, status, reason) {
    const { assignmentCase, assignment, actor, currentTime } = context;
    if (status === "withdrawn" && assignmentCase.caseType !== "professional_exit") {
      throw this.error(
        "Only a professional exit case may be withdrawn.",
        "CASE_WITHDRAWAL_NOT_ALLOWED"
      );
    }
    if (status === "dismissed" && assignmentCase.caseType !== "employer_issue") {
      throw this.error("Only an employer issue may be dismissed.", "CASE_DISMISSAL_NOT_ALLOWED");
    }

    const fields = {
      withdrawn: ["withdrawnAt", "withdrawnBy", "withdrawalReason"],
      dismissed: ["dismissedAt", "dismissedBy", "dismissalReason"],
      cancelled: ["cancelledAt", "cancelledBy", "cancellationReason"],
    }[status];

    assignmentCase.status = status;
    assignmentCase.isOpen = false;
    assignmentCase[fields[0]] = currentTime;
    assignmentCase[fields[1]] = actor.userId;
    assignmentCase[fields[2]] = reason;
    assignment.openCase = null;
  }

  static async withdrawCase(payload, options = {}) {
    return this.runCaseCommand(payload, options, ["professional"], async (context) => {
      this.requireStatus(context.assignmentCase, [
        "awaiting_employer_acknowledgment",
        "under_admin_review",
      ]);
      this.closeCase(
        context,
        "withdrawn",
        this.text(
          payload.reason,
          "Withdrawal reason",
          CASE.MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH
        )
      );
    });
  }

  static async dismissCase(payload, options = {}) {
    return this.runCaseCommand(payload, options, ["admin"], async (context) => {
      this.requireStatus(context.assignmentCase, ["under_admin_review"]);
      this.closeCase(
        context,
        "dismissed",
        this.text(
          payload.reason,
          "Dismissal reason",
          CASE.MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH
        )
      );
    });
  }

  /** Call before lifecycle cancellation clears assignment.openCase, in its transaction. */
  static async cancelCase(payload, options = {}) {
    return this.runCaseCommand(payload, options, ["admin", "system"], async (context) => {
      this.requireStatus(context.assignmentCase, [
        "awaiting_employer_acknowledgment",
        "awaiting_professional_response",
        "awaiting_employer_response",
        "under_admin_review",
      ]);
      this.closeCase(
        context,
        "cancelled",
        this.text(
          payload.reason,
          "Cancellation reason",
          CASE.MAX_ASSIGNMENT_CASE_TERMINAL_REASON_LENGTH
        )
      );
    });
  }
}

module.exports = ShiftAssignmentCaseService;
