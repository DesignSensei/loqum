// services/employerCancellationRequestService.js

const mongoose = require("mongoose");
const crypto = require("crypto");

const EmployerCancellationRequest = require("../models/EmployerCancellationRequest");

const EmployerProfile = require("../models/EmployerProfile");

const EmployerMember = require("../models/EmployerMember");

const Shift = require("../models/Shift");

const ShiftOccurrence = require("../models/ShiftOccurrence");

const User = require("../models/User");

const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

/**
 * Admin-assisted employer cancellation only. Platform intervention and direct
 * employer cancellation do not pass through this service.
 *
 * Controllers MUST derive adminUserId from authenticated req.user._id, never
 * req.body. Evidence is an administrator's reviewed attestation. This service
 * does not fetch emails, authenticate senders or upload/scan attachments.
 * Evidence references must identify retained, access-controlled records.
 *
 * Use recordAndExecute as the entry point: it wires the cancellation
 * verifier and atomically marks the request fulfilled. Do not call the lower
 * cancellation service with a verifier assembled from client input.
 */
class EmployerCancellationRequestService {
  static error(code, message, statusCode = 400) {
    return Object.assign(new Error(message), {
      name: "EmployerCancellationRequestError",
      code,
      statusCode,
    });
  }

  static id(value, field) {
    if (!/^[a-f\d]{24}$/i.test(String(value || "")))
      throw this.error("INVALID_ID", `${field} is invalid.`);

    return new mongoose.Types.ObjectId(String(value));
  }

  static same(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  static text(value, field, min = 1, max = 500) {
    if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
      throw this.error("INVALID_TEXT", `${field} must contain ${min}–${max} characters.`);
    }

    return value.trim();
  }

  static date(value, field) {
    const date = value ? new Date(value) : null;

    if (!date || !Number.isFinite(date.getTime()))
      throw this.error("INVALID_DATE", `${field} is required and must be a valid date.`);

    return date;
  }

  static assertTransaction(session) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.error(
        "ACTIVE_TRANSACTION_REQUIRED",
        "An active database transaction is required.",
        500
      );
    }
  }

  static async transaction(options, callback) {
    if (options.session) this.assertTransaction(options.session);

    return runWithOptionalTransaction(options, async (session) => {
      this.assertTransaction(session);

      return callback(session);
    });
  }

  static async assertAdmin(adminUserId, session) {
    const id = this.id(adminUserId, "Admin user ID");

    const admin = await User.findOne({
      _id: id,
      role: "admin",
    })
      .select("_id")
      .session(session)
      .lean();

    if (!admin) throw this.error("ADMIN_ACCESS_REQUIRED", "Admin access is required.", 403);

    return id;
  }

  static async loadTarget({ employerProfileId, shiftId, occurrenceId, scope }, session) {
    if (!["shift", "occurrence"].includes(scope))
      throw this.error("INVALID_REQUEST_SCOPE", "Choose shift or occurrence scope.");

    const business = this.id(employerProfileId, "Employer profile ID");

    const shift = await Shift.findOne({
      _id: this.id(shiftId, "Shift ID"),
      business,
    }).session(session);

    if (!shift) throw this.error("SHIFT_NOT_FOUND", "Shift was not found for this employer.", 404);

    let occurrence = null;

    if (scope === "occurrence") {
      occurrence = await ShiftOccurrence.findOne({
        _id: this.id(occurrenceId, "Occurrence ID"),
        shift: shift._id,
        business,
      }).session(session);

      if (!occurrence)
        throw this.error("OCCURRENCE_NOT_FOUND", "Occurrence was not found for this shift.", 404);

      if (!this.same(occurrence.branch, shift.branch))
        throw this.error(
          "OCCURRENCE_BRANCH_MISMATCH",
          "Occurrence branch does not match its shift.",
          409
        );
    } else if (occurrenceId != null) {
      throw this.error(
        "INVALID_REQUEST_SCOPE",
        "Whole-shift requests cannot specify a single occurrence."
      );
    }

    return {
      shift,
      occurrence,
    };
  }

  // Uses the membership fields already used by ShiftQueryService. Branch staff
  // cannot authorize cancellations; owners, business admins and managers of the
  // affected branch can. Recheck at creation AND execution.
  static async assertEmployerAuthority(requestedBy, shift, session) {
    const userId = this.id(requestedBy, "Employer requester ID");

    const profile = await EmployerProfile.findById(shift.business)
      .select("user")
      .session(session)
      .lean();

    if (!profile) throw this.error("EMPLOYER_NOT_FOUND", "Employer profile was not found.", 404);

    if (this.same(profile.user, userId)) return userId;

    const member = await EmployerMember.findOne({
      business: shift.business,
      user: userId,
      accountStatus: "active",
      isCurrent: { $ne: false },
    })
      .select("role branches")
      .session(session)
      .lean();

    if (
      member?.role === "admin" ||
      (member?.role === "branch_manager" &&
        member.branches?.some((assignment) => this.same(assignment.branch, shift.branch)))
    )
      return userId;

    throw this.error(
      "EMPLOYER_CANCELLATION_AUTHORITY_REQUIRED",
      "The requester is not authorized to cancel for this branch.",
      403
    );
  }

  static async loadRequest(requestReference, employerProfileId, session) {
    const request = await EmployerCancellationRequest.findOne({
      _id: this.id(requestReference, "Request reference"),
      business: this.id(employerProfileId, "Employer profile ID"),
    }).session(session);

    if (!request)
      throw this.error(
        "CANCELLATION_REQUEST_NOT_FOUND",
        "Cancellation request was not found for this employer.",
        404
      );

    return request;
  }

  /**
   * One Confirm command, one transaction. requestReference is a client-generated
   * ObjectId retained across retries. It is an idempotency identifier, NOT access
   * authority. Evidence _ids must also remain stable across retries.
   * adminUserId must come from authenticated middleware, never req.body.
   */
  static normalizeImmediateCommand(input) {
    if (input.mode && input.mode !== "employer_assisted") {
      throw this.error(
        "PLATFORM_CANCELLATION_FINANCIAL_POLICY_REQUIRED",
        "Platform intervention is a separate workflow.",
        409
      );
    }

    if (
      input.expiresAt != null ||
      input.consent?.evidenceIndex != null ||
      input.consent?.maxProfessionalCompensationMinor != null ||
      input.consent?.financialTerms != null
    ) {
      throw this.error(
        "OUTDATED_CANCELLATION_REQUEST",
        "Use the immediate written-instruction request format."
      );
    }

    if (input.evidenceReviewed !== true) {
      throw this.error(
        "EVIDENCE_REVIEW_REQUIRED",
        "Review the written instructions and employer authority before confirming."
      );
    }

    if (!["occurrence", "shift"].includes(input.scope)) {
      throw this.error("INVALID_REQUEST_SCOPE", "Choose occurrence or shift scope.");
    }

    const action = input.action || (input.scope === "occurrence" ? "cancel_occurrence" : null);
    const actions =
      input.scope === "occurrence"
        ? ["cancel_occurrence"]
        : ["cancel_pending_funding", "cancel_engagement", "terminate_active_work"];

    if (!actions.includes(action)) {
      throw this.error(
        "INVALID_CANCELLATION_ACTION",
        "Choose an action matching the requested scope."
      );
    }

    if (input.scope === "shift" && input.occurrenceId != null) {
      throw this.error(
        "INVALID_REQUEST_SCOPE",
        "Whole-shift instructions cannot specify only one occurrence."
      );
    }

    if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 10) {
      throw this.error("WRITTEN_EVIDENCE_REQUIRED", "Provide one to ten evidence references.");
    }

    const evidence = input.evidence
      .map((item) => ({
        _id: String(this.id(item._id, "Evidence ID")),
        type: this.text(item.type, "Evidence type", 1, 40),
        reference: this.text(item.reference, "Evidence reference", 1, 1000),
        description:
          item.description == null || item.description === ""
            ? null
            : this.text(item.description, "Evidence description", 1, 500),
      }))
      .sort((left, right) => left._id.localeCompare(right._id));

    if (new Set(evidence.map((item) => item._id)).size !== evidence.length) {
      throw this.error("DUPLICATE_EVIDENCE_ID", "Evidence IDs must be distinct.");
    }

    const evidenceId = String(
      this.id(input.consent?.evidenceId, "Written instruction evidence ID")
    );
    const selected = evidence.find((item) => item._id === evidenceId);

    if (!selected || !["message", "document", "screenshot", "image"].includes(selected.type)) {
      throw this.error(
        "WRITTEN_INSTRUCTION_REQUIRED",
        "Select written-instruction evidence belonging to this request."
      );
    }

    const command = {
      requestReference: String(this.id(input.requestReference, "Stable request reference")),
      adminUserId: String(this.id(input.adminUserId, "Admin user ID")),
      employerProfileId: String(this.id(input.employerProfileId, "Employer profile ID")),
      shiftId: String(this.id(input.shiftId, "Shift ID")),
      scope: input.scope,
      occurrenceId:
        input.scope === "occurrence" ? String(this.id(input.occurrenceId, "Occurrence ID")) : null,
      action,
      requestedBy: String(this.id(input.requestedBy, "Employer requester ID")),
      requestedAt: this.date(input.requestedAt, "Request time").toISOString(),
      cancellationReasonCode: this.text(
        input.cancellationReasonCode,
        "Cancellation reason code",
        1,
        80
      ),
      cancellationReason: this.text(input.cancellationReason, "Employer explanation", 10),
      evidenceReviewNotes: this.text(input.evidenceReviewNotes, "Evidence review notes", 10, 2000),
      evidence,
      consent: {
        confirmedAt: this.date(
          input.consent?.confirmedAt,
          "Written instruction time"
        ).toISOString(),
        evidenceId,
      },
      // The same explanation supplies the audit reason unless a separate internal
      // note is needed. The UI does not require a second cancellation dropdown.
      reason: this.text(input.reason || input.cancellationReason, "Execution audit reason", 10),
    };

    return {
      command,
      commandHash: crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    };
  }

  // Preview does not create a request, reserve a price or change the shift.
  static async getCancellationPreview(input, options = {}) {
    return this.transaction(options, async (session) => {
      await this.assertAdmin(input.adminUserId, session);

      if (input.mode && input.mode !== "employer_assisted") {
        throw this.error(
          "PLATFORM_CANCELLATION_FINANCIAL_POLICY_REQUIRED",
          "Platform intervention is a separate workflow.",
          409
        );
      }

      const { shift, occurrence } = await this.loadTarget(input, session);
      await this.assertEmployerAuthority(input.requestedBy, shift, session);
      const now = new Date();

      if (input.scope === "shift") {
        const lifecycle = require("./shiftLifecycleService");
        const occurrences = await lifecycle.getOccurrences({
          shiftId: shift._id,
          session,
        });
        const preview = await lifecycle.buildCancellationPreview({
          shift,
          occurrences,
          now,
        });
        return { ...preview, scope: "shift", currency: shift.currency };
      }

      const cancellation = require("./shiftOccurrenceCancellationService");
      const {
        INDIVIDUAL_OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES,
      } = require("../constants/shiftLifecycle");
      cancellation.assertParentAllowsIndividualCancellation(shift);
      cancellation.assertFutureUntouchedOccurrence({
        occurrence,
        currentTime: now,
        allowedAssignmentStatuses: INDIVIDUAL_OCCURRENCE_CANCELLABLE_ASSIGNMENT_STATUSES,
      });

      const outcome = cancellation.determineOccurrenceCancellationOutcome({
        shift,
        occurrence,
        fromParentCancellation: false,
        cancelledBy: "employer",
        parentCancellationCode: null,
        currentTime: now,
      });

      return {
        mode: "occurrence_cancellation",
        scope: "occurrence",
        shiftId: String(shift._id),
        occurrenceId: String(occurrence._id),
        currency: shift.currency,
        affectedOccurrenceCount: 1,
        professionalCompensation: { amount: outcome.professionalPay },
        retainedPlatformFee: { amount: outcome.retainedBasePlatformFee },
        refund: { amount: outcome.refundableAmount },
      };
    });
  }

  static async recordAndExecute(input, options = {}) {
    const { command, commandHash } = this.normalizeImmediateCommand(input);

    try {
      return await this.transaction(options, async (session) => {
        const admin = await this.assertAdmin(command.adminUserId, session);
        const existing = await EmployerCancellationRequest.findById(
          command.requestReference
        ).session(session);

        if (
          existing &&
          (!this.same(existing.business, command.employerProfileId) ||
            !this.same(existing.recordedBy, admin) ||
            existing.commandHash !== commandHash)
        ) {
          throw this.error(
            "REQUEST_IDEMPOTENCY_CONFLICT",
            "This request identifier was used for a different command.",
            409
          );
        }

        const { shift, occurrence } = await this.loadTarget(command, session);

        if (existing) {
          const target = command.scope === "shift" ? shift : occurrence;

          if (
            existing.status !== "fulfilled" ||
            !this.same(existing.execution?.adminUserId, admin) ||
            target.status !== "cancelled" ||
            target.cancellationAdministration?.requestReference !== String(existing._id) ||
            !this.same(target.cancellationAdministration?.executedBy, admin)
          ) {
            throw this.error(
              "REQUEST_EXECUTION_CONFLICT",
              "The existing request is not a matching completed cancellation.",
              409
            );
          }

          return {
            request: existing,
            shift,
            occurrence,
            idempotent: true,
            professionalCompensation: existing.execution.professionalCompensationMinor,
            currency: existing.execution.currency,
          };
        }

        const requestedBy = await this.assertEmployerAuthority(command.requestedBy, shift, session);

        if (this.same(admin, requestedBy)) {
          throw this.error(
            "INVALID_REQUESTER",
            "Employer requester and executing admin must differ.",
            403
          );
        }

        if (shift.status === "cancelled" || occurrence?.status === "cancelled") {
          throw this.error(
            "TARGET_ALREADY_CANCELLED",
            "A new request cannot adopt an earlier cancellation.",
            409
          );
        }

        const now = new Date();
        const requestedAt = new Date(command.requestedAt);
        const confirmedAt = new Date(command.consent.confirmedAt);

        if (!(requestedAt <= confirmedAt && confirmedAt <= now)) {
          throw this.error(
            "INVALID_REQUEST_TIMING",
            "The written instruction must follow the request and precede recording."
          );
        }

        const request = new EmployerCancellationRequest({
          _id: this.id(command.requestReference, "Request reference"),
          commandHash,
          business: shift.business,
          shift: shift._id,
          scope: command.scope,
          occurrence: occurrence?._id,
          requestedBy,
          requestedAt,
          recordedBy: admin,
          recordedAt: now,
          cancellationReasonCode: command.cancellationReasonCode,
          cancellationReason: command.cancellationReason,
          evidence: command.evidence.map((item) => ({
            ...item,
            _id: this.id(item._id, "Evidence ID"),
            submittedByRole: "admin",
            submittedByUser: admin,
            recordedAt: now,
          })),
          evidenceReviewedBy: admin,
          evidenceReviewedAt: now,
          evidenceReviewNotes: command.evidenceReviewNotes,
          consent: {
            confirmedAt,
            evidenceId: this.id(command.consent.evidenceId, "Evidence ID"),
          },
        });

        // This insert is not committed on its own. Cancellation failures abort it.
        // _id uniqueness serializes duplicate submissions using the same identifier.
        await request.save({ session });

        if (command.scope === "shift") {
          const lifecycle = require("./shiftLifecycleService");
          const result = await lifecycle.cancelShiftAsAdmin(
            {
              adminUserId: admin,
              employerProfileId: request.business,
              requestReference: String(request._id),
              reason: command.reason,
              action: command.action,
            },
            { session }
          );

          if (result.request?.status !== "fulfilled" || !result.request.execution?.currency) {
            throw this.error(
              "LIFECYCLE_RESULT_INVALID",
              "Lifecycle did not fulfill the request with its financial outcome.",
              500
            );
          }

          return {
            ...result,
            professionalCompensation: result.request.execution.professionalCompensationMinor,
            currency: result.request.execution.currency,
            idempotent: false,
          };
        }

        const cancellation = require("./shiftOccurrenceCancellationService");
        const result = await cancellation.cancelOccurrenceAsAdmin(
          {
            adminUserId: admin,
            employerProfileId: request.business,
            shiftId: request.shift,
            occurrenceId: request.occurrence,
            mode: "employer_assisted",
            requestReference: String(request._id),
            reason: command.reason,
            currentTime: now,
          },
          {
            session,
            verifyEmployerCancellationRequest: async (target) => {
              if (
                target.session !== session ||
                target.requestReference !== String(request._id) ||
                !this.same(target.adminUserId, admin) ||
                !this.same(target.employerProfileId, request.business) ||
                !this.same(target.shiftId, request.shift) ||
                !this.same(target.occurrenceId, request.occurrence)
              ) {
                throw this.error(
                  "REQUEST_SCOPE_MISMATCH",
                  "Cancellation does not match the recorded instruction.",
                  403
                );
              }

              return {
                authorized: true,
                requestReference: String(request._id),
                employerProfileId: request.business,
                shiftId: request.shift,
                occurrenceId: request.occurrence,
                requestedBy: request.requestedBy,
                requestedAt: request.requestedAt,
                cancellationReasonCode: request.cancellationReasonCode,
                cancellationReason: request.cancellationReason,
              };
            },
          }
        );

        const compensation = result.professionalCompensation;

        if (!Number.isSafeInteger(compensation) || compensation < 0) {
          throw this.error(
            "INVALID_CANCELLATION_OUTCOME",
            "Cancellation returned invalid professional compensation.",
            500
          );
        }

        request.status = "fulfilled";
        request.execution = {
          adminUserId: admin,
          executedAt: now,
          reason: command.reason,
          currency: shift.currency,
          professionalCompensationMinor: compensation,
        };
        await request.save({ session });

        return { ...result, request, currency: shift.currency, idempotent: false };
      });
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?._id) {
        // Never retry inside a failed caller-owned transaction. The caller must
        // abort and retry the SAME command in a fresh transaction.
        throw this.error(
          "CANCELLATION_RETRY_REQUIRED",
          "Concurrent request detected. Retry the same request identifier and payload.",
          409
        );
      }

      throw error;
    }
  }

  // Old endpoints must not leave new requests waiting in a separate queue.
  static async createRequest() {
    throw this.error(
      "USE_IMMEDIATE_CANCELLATION",
      "Use recordAndExecute to record and cancel together.",
      409
    );
  }

  static async executeOccurrenceRequest() {
    throw this.error(
      "USE_IMMEDIATE_CANCELLATION",
      "Use recordAndExecute with the reviewed instruction.",
      409
    );
  }

  static async getRequest({ adminUserId, requestReference, employerProfileId }, options = {}) {
    return this.transaction(options, async (session) => {
      await this.assertAdmin(adminUserId, session);

      return this.loadRequest(requestReference, employerProfileId, session);
    });
  }

  static async withdrawRequest(input, options = {}) {
    return this.transaction(options, async (session) => {
      const admin = await this.assertAdmin(input.adminUserId, session);

      const reason = this.text(input.reason, "Withdrawal reason", 10);

      const request = await this.loadRequest(
        input.requestReference,
        input.employerProfileId,
        session
      );

      if (request.status === "withdrawn") {
        if (
          !this.same(request.withdrawal.adminUserId, admin) ||
          request.withdrawal.reason !== reason
        ) {
          throw this.error(
            "REQUEST_ALREADY_WITHDRAWN",
            "The request was withdrawn by a different command.",
            409
          );
        }

        return request;
      }

      if (request.status !== "pending")
        throw this.error("REQUEST_NOT_PENDING", "A fulfilled request cannot be withdrawn.", 409);

      request.status = "withdrawn";

      request.withdrawal = {
        adminUserId: admin,
        withdrawnAt: new Date(),
        reason,
      };

      await request.save({ session });

      return request;
    });
  }
}

module.exports = EmployerCancellationRequestService;
