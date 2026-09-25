const mongoose = require("mongoose");

const Appointment = require("../models/Appointment");
const JobApplication = require("../models/JobApplication");

const JobService = require("./jobService");
const JobApplicationService = require("./jobApplicationService");

const {
  JOB_APPOINTMENT_FORMATS,
  JOB_APPOINTMENT_RESPONSE_STATUSES,
  JOB_APPOINTMENT_ACTOR_ROLES,
  JOB_APPOINTMENT_CANCELLATION_REASONS,
  JOB_APPOINTMENT_NO_SHOW_PARTIES,
} = require("../constants/jobAppointment");

const { JOB_APPLICATION_TERMINAL_STATUSES } = require("../constants/jobApplication");

const { generateReference } = require("../utils/reference");
const { createServiceError } = require("./helpers/serviceErrorHelper");
const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

function createAppointmentError(options) {
  return createServiceError({
    ...options,
    name: "AppointmentServiceError",
  });
}

function applySession(query, session) {
  return session ? query.session(session) : query;
}

function saveOptions(session) {
  return session ? { session } : {};
}

function normalizeDate(value, fieldName) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw createAppointmentError({
      message: `${fieldName} must be a valid date.`,
      code: "INVALID_APPOINTMENT_DATE",
      statusCode: 400,
      details: { field: fieldName },
    });
  }

  return date;
}

function normalizeCurrentTime(value) {
  return normalizeDate(value, "currentTime");
}

function normalizeObjectId(value, fieldName) {
  if (!mongoose.isValidObjectId(value)) {
    throw createAppointmentError({
      message: `${fieldName} is invalid.`,
      code: "INVALID_APPOINTMENT_OBJECT_ID",
      statusCode: 400,
      details: { field: fieldName },
    });
  }

  return new mongoose.Types.ObjectId(value);
}

function objectIdEquals(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left) === String(right);
}

function assertValueIn(value, allowedValues, fieldName, code) {
  if (!allowedValues.includes(value)) {
    throw createAppointmentError({
      message: `${fieldName} is invalid.`,
      code,
      statusCode: 400,
      details: {
        field: fieldName,
        allowedValues,
      },
    });
  }
}

function assertEmployerRole(actorRole) {
  if (actorRole !== "employer") {
    throw createAppointmentError({
      message: "This appointment action requires an employer actor.",
      code: "APPOINTMENT_EMPLOYER_REQUIRED",
      statusCode: 403,
    });
  }
}

function assertEmployerOrSystemRole(actorRole) {
  if (!["employer", "system"].includes(actorRole)) {
    throw createAppointmentError({
      message: "This appointment action requires an employer or system actor.",
      code: "APPOINTMENT_EMPLOYER_OR_SYSTEM_REQUIRED",
      statusCode: 403,
    });
  }
}

function assertUserActor(actorRole, actorUserId, fieldName = "actorUserId") {
  if (actorRole === "system") {
    if (actorUserId) {
      throw createAppointmentError({
        message: "System appointment actions must not provide a user actor.",
        code: "APPOINTMENT_SYSTEM_USER_NOT_ALLOWED",
        statusCode: 400,
      });
    }

    return null;
  }

  if (!actorUserId) {
    throw createAppointmentError({
      message: `${fieldName} is required for non-system appointment actions.`,
      code: "APPOINTMENT_USER_ACTOR_REQUIRED",
      statusCode: 400,
      details: { field: fieldName },
    });
  }

  return normalizeObjectId(actorUserId, fieldName);
}

function buildScheduleSnapshot(schedule, currentTime, { requireFuture = false } = {}) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw createAppointmentError({
      message: "schedule is required.",
      code: "APPOINTMENT_SCHEDULE_REQUIRED",
      statusCode: 400,
    });
  }

  assertValueIn(
    schedule.format,
    JOB_APPOINTMENT_FORMATS,
    "schedule.format",
    "INVALID_APPOINTMENT_FORMAT"
  );

  const startAt = normalizeDate(schedule.startAt, "schedule.startAt");
  const endAt = normalizeDate(schedule.endAt, "schedule.endAt");

  if (endAt <= startAt) {
    throw createAppointmentError({
      message: "schedule.endAt must be after schedule.startAt.",
      code: "INVALID_APPOINTMENT_SCHEDULE_RANGE",
      statusCode: 400,
    });
  }

  if (requireFuture && startAt <= currentTime) {
    throw createAppointmentError({
      message: "Appointments must be scheduled to start in the future.",
      code: "APPOINTMENT_START_MUST_BE_FUTURE",
      statusCode: 400,
    });
  }

  return {
    startAt,
    endAt,
    timeZone: schedule.timeZone,
    format: schedule.format,
    onsiteLocation: schedule.onsiteLocation ?? null,
    meetingLink: schedule.meetingLink ?? null,
    phoneNumber: schedule.phoneNumber ?? null,
  };
}

function scheduleValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value === undefined || value === null) {
    return null;
  }

  return String(value);
}

function sameSchedule(left, right) {
  if (!left || !right) {
    return false;
  }

  return (
    scheduleValue(left.startAt) === scheduleValue(right.startAt) &&
    scheduleValue(left.endAt) === scheduleValue(right.endAt) &&
    scheduleValue(left.timeZone) === scheduleValue(right.timeZone) &&
    scheduleValue(left.format) === scheduleValue(right.format) &&
    scheduleValue(left.onsiteLocation) === scheduleValue(right.onsiteLocation) &&
    scheduleValue(left.meetingLink) === scheduleValue(right.meetingLink) &&
    scheduleValue(left.phoneNumber) === scheduleValue(right.phoneNumber)
  );
}

function isTerminalAppointment(appointment) {
  return ["completed", "cancelled", "no_show"].includes(appointment.status);
}

function assertApplicationCanInterview(application) {
  if (JOB_APPLICATION_TERMINAL_STATUSES.includes(application.status)) {
    throw createAppointmentError({
      message: "A terminal job application cannot be scheduled or rescheduled for interview.",
      code: "TERMINAL_JOB_APPLICATION_INTERVIEW_NOT_ALLOWED",
      statusCode: 409,
      details: {
        applicationStatus: application.status,
      },
    });
  }
}

function buildEvent(type, appointment, extra = {}) {
  return {
    type,
    jobId: appointment.job,
    applicationId: appointment.jobApplication,
    appointmentId: appointment._id,
    professionalId: appointment.professional,
    employerProfileId: appointment.business,
    roundNumber: appointment.roundNumber,
    ...extra,
  };
}

async function loadApplication(applicationId, session) {
  const normalizedApplicationId = normalizeObjectId(applicationId, "applicationId");

  const query = JobApplication.findById(normalizedApplicationId);

  const application = await applySession(query, session);

  if (!application) {
    throw createAppointmentError({
      message: "Job application not found.",
      code: "JOB_APPLICATION_NOT_FOUND",
      statusCode: 404,
    });
  }

  return application;
}

async function loadAppointment(appointmentId, session) {
  const normalizedAppointmentId = normalizeObjectId(appointmentId, "appointmentId");

  const query = Appointment.findById(normalizedAppointmentId);

  const appointment = await applySession(query, session);

  if (!appointment) {
    throw createAppointmentError({
      message: "Appointment not found.",
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });
  }

  return appointment;
}

async function loadEmployerAuthorizedJob({ jobId, employerProfileId, employerContext, session }) {
  normalizeObjectId(employerProfileId, "employerProfileId");

  return JobService.getEmployerJob({
    jobId,
    employerProfileId,
    employerContext,
    session,
  });
}

async function loadPrivilegedAppointment({
  appointmentId,
  employerProfileId,
  employerContext,
  actorRole,
  session,
}) {
  const appointment = await loadAppointment(appointmentId, session);

  if (actorRole === "employer") {
    const job = await loadEmployerAuthorizedJob({
      jobId: appointment.job,
      employerProfileId,
      employerContext,
      session,
    });

    return { appointment, job };
  }

  if (actorRole === "system") {
    const job = await JobService.getSystemJob(appointment.job, session);

    if (!job) {
      throw createAppointmentError({
        message: "Job not found.",
        code: "JOB_NOT_FOUND",
        statusCode: 404,
      });
    }

    return { appointment, job };
  }

  throw createAppointmentError({
    message: "Actor is not authorized to manage this appointment.",
    code: "APPOINTMENT_MANAGEMENT_FORBIDDEN",
    statusCode: 403,
  });
}

async function loadProfessionalAppointment({ appointmentId, professionalProfileId, session }) {
  const normalizedProfessionalId = normalizeObjectId(
    professionalProfileId,
    "professionalProfileId"
  );

  const appointment = await loadAppointment(appointmentId, session);

  if (!objectIdEquals(appointment.professional, normalizedProfessionalId)) {
    throw createAppointmentError({
      message: "Appointment not found.",
      code: "APPOINTMENT_NOT_FOUND",
      statusCode: 404,
    });
  }

  return appointment;
}

class AppointmentService {
  static async inviteApplicationToInterview(
    {
      applicationId,
      employerProfileId,
      employerContext = null,
      createdByUserId,
      title,
      schedule,
      interviewers = [],
      employerPrivateNote = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    const now = normalizeCurrentTime(currentTime);

    const normalizedCreatedBy = normalizeObjectId(createdByUserId, "createdByUserId");

    const normalizedEmployerProfileId = normalizeObjectId(employerProfileId, "employerProfileId");

    const normalizedSchedule = buildScheduleSnapshot(schedule, now, {
      requireFuture: true,
    });

    try {
      return await runWithOptionalTransaction(options, async (transactionSession) => {
        const application = await loadApplication(applicationId, transactionSession);

        assertApplicationCanInterview(application);

        const job = await loadEmployerAuthorizedJob({
          jobId: application.job,
          employerProfileId: normalizedEmployerProfileId,
          employerContext,
          session: transactionSession,
        });

        const transition = await JobApplicationService.moveApplicationToInterview(
          {
            applicationId: application._id,
            employerProfileId: normalizedEmployerProfileId,
            employerContext,
            changedByUserId: normalizedCreatedBy,
            currentTime: now,
          },
          { session: transactionSession }
        );

        const lastAppointmentQuery = Appointment.findOne({
          jobApplication: application._id,
        })
          .sort({
            roundNumber: -1,
          })
          .select("roundNumber")
          .lean();

        const lastAppointment = await applySession(lastAppointmentQuery, transactionSession);

        const roundNumber = (lastAppointment?.roundNumber || 0) + 1;

        const appointment = new Appointment({
          referenceCode: generateReference(),

          job: job._id,

          jobApplication: application._id,

          professional: application.professional,

          business: job.business,

          branch: job.branch,

          roundNumber,

          title,

          createdBy: normalizedCreatedBy,

          createdByRole: "employer",

          initialSchedule: normalizedSchedule,

          startAt: normalizedSchedule.startAt,

          endAt: normalizedSchedule.endAt,

          timeZone: normalizedSchedule.timeZone,

          format: normalizedSchedule.format,

          onsiteLocation: normalizedSchedule.onsiteLocation,

          meetingLink: normalizedSchedule.meetingLink,

          phoneNumber: normalizedSchedule.phoneNumber,

          interviewers,

          responseStatus: "pending",

          respondedAt: null,

          respondedBy: null,

          responseNote: null,

          responseHistory: [],

          rescheduleHistory: [],

          status: "scheduled",

          completedAt: null,

          completedBy: null,

          completedByRole: null,

          cancelledAt: null,

          cancelledBy: null,

          cancelledByRole: null,

          cancellationReason: null,

          cancellationReasonDetails: null,

          noShowAt: null,

          noShowRecordedBy: null,

          noShowRecordedByRole: null,

          noShowParty: null,

          employerPrivateNote,
        });

        await appointment.save(saveOptions(transactionSession));

        return {
          appointment,

          application: transition.application,

          job,

          applicationTransitioned: transition.transitioned,

          idempotent: false,

          events: [buildEvent("job_interview_invited", appointment)],
        };
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw createAppointmentError({
          message:
            "The interview round could not be created because a conflicting appointment already exists.",
          code: "APPOINTMENT_ROUND_CONFLICT",
          statusCode: 409,
        });
      }

      throw error;
    }
  }

  static async rescheduleAppointment(
    {
      appointmentId,
      employerProfileId = null,
      employerContext = null,
      changedByUserId,
      actorRole = "employer",
      schedule,
      reason = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    assertEmployerRole(actorRole);

    assertValueIn(
      actorRole,
      JOB_APPOINTMENT_ACTOR_ROLES,
      "actorRole",
      "INVALID_APPOINTMENT_ACTOR_ROLE"
    );

    const now = normalizeCurrentTime(currentTime);

    const normalizedChangedBy = assertUserActor(actorRole, changedByUserId, "changedByUserId");

    const normalizedSchedule = buildScheduleSnapshot(schedule, now, {
      requireFuture: true,
    });

    return runWithOptionalTransaction(options, async (transactionSession) => {
      const { appointment } = await loadPrivilegedAppointment({
        appointmentId,
        employerProfileId,
        employerContext,
        actorRole,
        session: transactionSession,
      });

      if (isTerminalAppointment(appointment)) {
        throw createAppointmentError({
          message: "Terminal appointments cannot be rescheduled.",
          code: "TERMINAL_APPOINTMENT_RESCHEDULE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            appointmentStatus: appointment.status,
          },
        });
      }

      const application = await loadApplication(appointment.jobApplication, transactionSession);

      assertApplicationCanInterview(application);

      if (sameSchedule(appointment, normalizedSchedule)) {
        return {
          appointment,
          application,
          changed: false,
          idempotent: true,
          events: [],
        };
      }

      appointment.rescheduleHistory.push({
        fromSchedule: {
          startAt: appointment.startAt,

          endAt: appointment.endAt,

          timeZone: appointment.timeZone,

          format: appointment.format,

          onsiteLocation: appointment.onsiteLocation ?? null,

          meetingLink: appointment.meetingLink ?? null,

          phoneNumber: appointment.phoneNumber ?? null,
        },

        toSchedule: normalizedSchedule,

        changedAt: now,

        changedBy: normalizedChangedBy,

        actorRole,

        reason,
      });

      appointment.startAt = normalizedSchedule.startAt;

      appointment.endAt = normalizedSchedule.endAt;

      appointment.timeZone = normalizedSchedule.timeZone;

      appointment.format = normalizedSchedule.format;

      appointment.onsiteLocation = normalizedSchedule.onsiteLocation;

      appointment.meetingLink = normalizedSchedule.meetingLink;

      appointment.phoneNumber = normalizedSchedule.phoneNumber;

      appointment.responseStatus = "pending";

      appointment.respondedAt = null;

      appointment.respondedBy = null;

      appointment.responseNote = null;

      await appointment.save(saveOptions(transactionSession));

      return {
        appointment,

        application,

        changed: true,

        idempotent: false,

        events: [buildEvent("job_interview_rescheduled", appointment)],
      };
    });
  }

  static async respondToAppointment(
    {
      appointmentId,
      professionalProfileId,
      respondedByUserId,
      responseStatus,
      responseNote = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    assertValueIn(
      responseStatus,
      JOB_APPOINTMENT_RESPONSE_STATUSES,
      "responseStatus",
      "INVALID_APPOINTMENT_RESPONSE_STATUS"
    );

    if (!["confirmed", "declined"].includes(responseStatus)) {
      throw createAppointmentError({
        message: "Candidates may only confirm or decline an appointment invitation.",
        code: "INVALID_CANDIDATE_APPOINTMENT_RESPONSE",
        statusCode: 400,
      });
    }

    const now = normalizeCurrentTime(currentTime);

    const normalizedRespondedBy = normalizeObjectId(respondedByUserId, "respondedByUserId");

    return runWithOptionalTransaction(options, async (transactionSession) => {
      const appointment = await loadProfessionalAppointment({
        appointmentId,
        professionalProfileId,
        session: transactionSession,
      });

      if (
        responseStatus === "confirmed" &&
        appointment.status === "scheduled" &&
        appointment.responseStatus === "confirmed"
      ) {
        return {
          appointment,
          changed: false,
          idempotent: true,
          events: [],
        };
      }

      if (
        responseStatus === "declined" &&
        appointment.status === "cancelled" &&
        appointment.responseStatus === "declined" &&
        appointment.cancellationReason === "candidate_declined"
      ) {
        return {
          appointment,
          changed: false,
          idempotent: true,
          events: [],
        };
      }

      if (appointment.status !== "scheduled") {
        throw createAppointmentError({
          message: "Only scheduled appointments can receive a candidate response.",
          code: "APPOINTMENT_RESPONSE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            appointmentStatus: appointment.status,
          },
        });
      }

      const application = await loadApplication(appointment.jobApplication, transactionSession);

      assertApplicationCanInterview(application);

      appointment.responseStatus = responseStatus;

      appointment.respondedAt = now;

      appointment.respondedBy = normalizedRespondedBy;

      appointment.responseNote = responseNote;

      appointment.responseHistory.push({
        status: responseStatus,

        respondedAt: now,

        respondedBy: normalizedRespondedBy,

        note: responseNote,
      });

      const events = [];

      if (responseStatus === "confirmed") {
        events.push(buildEvent("job_interview_confirmed", appointment));
      } else {
        appointment.status = "cancelled";

        appointment.cancelledAt = now;

        appointment.cancelledBy = normalizedRespondedBy;

        appointment.cancelledByRole = "professional";

        appointment.cancellationReason = "candidate_declined";

        appointment.cancellationReasonDetails = null;

        events.push(buildEvent("job_interview_declined", appointment));
      }

      await appointment.save(saveOptions(transactionSession));

      return {
        appointment,

        application,

        changed: true,

        idempotent: false,

        events,
      };
    });
  }

  static async cancelAppointment(
    {
      appointmentId,
      employerProfileId = null,
      employerContext = null,
      actorUserId = null,
      actorRole = "employer",
      cancellationReason,
      cancellationReasonDetails = null,
      currentTime = new Date(),
    },
    options = {}
  ) {
    assertEmployerOrSystemRole(actorRole);

    assertValueIn(
      actorRole,
      JOB_APPOINTMENT_ACTOR_ROLES,
      "actorRole",
      "INVALID_APPOINTMENT_ACTOR_ROLE"
    );

    assertValueIn(
      cancellationReason,
      JOB_APPOINTMENT_CANCELLATION_REASONS,
      "cancellationReason",
      "INVALID_APPOINTMENT_CANCELLATION_REASON"
    );

    if (cancellationReason === "candidate_declined") {
      throw createAppointmentError({
        message: "candidate_declined is reserved for the professional decline flow.",
        code: "CANDIDATE_DECLINE_REASON_RESERVED",
        statusCode: 400,
      });
    }

    if (
      cancellationReason === "other" &&
      (typeof cancellationReasonDetails !== "string" || !cancellationReasonDetails.trim())
    ) {
      throw createAppointmentError({
        message: "cancellationReasonDetails is required when cancellationReason is other.",
        code: "APPOINTMENT_CANCELLATION_DETAILS_REQUIRED",
        statusCode: 400,
      });
    }

    const now = normalizeCurrentTime(currentTime);

    const normalizedActorUserId = assertUserActor(actorRole, actorUserId, "actorUserId");

    return runWithOptionalTransaction(options, async (transactionSession) => {
      const { appointment } = await loadPrivilegedAppointment({
        appointmentId,
        employerProfileId,
        employerContext,
        actorRole,
        session: transactionSession,
      });

      if (appointment.status === "cancelled") {
        return {
          appointment,
          changed: false,
          idempotent: true,
          events: [],
        };
      }

      if (["completed", "no_show"].includes(appointment.status)) {
        throw createAppointmentError({
          message: "A completed or no-show appointment cannot be cancelled.",
          code: "TERMINAL_APPOINTMENT_CANCEL_NOT_ALLOWED",
          statusCode: 409,
          details: {
            appointmentStatus: appointment.status,
          },
        });
      }

      appointment.status = "cancelled";

      appointment.cancelledAt = now;

      appointment.cancelledBy = normalizedActorUserId;

      appointment.cancelledByRole = actorRole;

      appointment.cancellationReason = cancellationReason;

      appointment.cancellationReasonDetails = cancellationReasonDetails;

      await appointment.save(saveOptions(transactionSession));

      return {
        appointment,

        changed: true,

        idempotent: false,

        events: [
          buildEvent("job_interview_cancelled", appointment, {
            cancellationReason,
          }),
        ],
      };
    });
  }

  static async completeAppointment(
    {
      appointmentId,
      employerProfileId = null,
      employerContext = null,
      completedByUserId,
      actorRole = "employer",
      currentTime = new Date(),
    },
    options = {}
  ) {
    assertEmployerRole(actorRole);

    assertValueIn(
      actorRole,
      JOB_APPOINTMENT_ACTOR_ROLES,
      "actorRole",
      "INVALID_APPOINTMENT_ACTOR_ROLE"
    );

    const now = normalizeCurrentTime(currentTime);

    const normalizedCompletedBy = assertUserActor(
      actorRole,
      completedByUserId,
      "completedByUserId"
    );

    return runWithOptionalTransaction(options, async (transactionSession) => {
      const { appointment } = await loadPrivilegedAppointment({
        appointmentId,
        employerProfileId,
        employerContext,
        actorRole,
        session: transactionSession,
      });

      if (appointment.status === "completed") {
        return {
          appointment,
          changed: false,
          idempotent: true,
          events: [],
        };
      }

      if (appointment.status !== "scheduled") {
        throw createAppointmentError({
          message: "Only scheduled appointments can be marked completed.",
          code: "APPOINTMENT_COMPLETE_NOT_ALLOWED",
          statusCode: 409,
          details: {
            appointmentStatus: appointment.status,
          },
        });
      }

      appointment.status = "completed";

      appointment.completedAt = now;

      appointment.completedBy = normalizedCompletedBy;

      appointment.completedByRole = actorRole;

      await appointment.save(saveOptions(transactionSession));

      return {
        appointment,

        changed: true,

        idempotent: false,

        events: [],
      };
    });
  }

  static async recordNoShow(
    {
      appointmentId,
      employerProfileId = null,
      employerContext = null,
      recordedByUserId,
      actorRole = "employer",
      noShowParty,
      currentTime = new Date(),
    },
    options = {}
  ) {
    assertEmployerRole(actorRole);

    assertValueIn(
      actorRole,
      JOB_APPOINTMENT_ACTOR_ROLES,
      "actorRole",
      "INVALID_APPOINTMENT_ACTOR_ROLE"
    );

    assertValueIn(
      noShowParty,
      JOB_APPOINTMENT_NO_SHOW_PARTIES,
      "noShowParty",
      "INVALID_APPOINTMENT_NO_SHOW_PARTY"
    );

    const now = normalizeCurrentTime(currentTime);

    const normalizedRecordedBy = assertUserActor(actorRole, recordedByUserId, "recordedByUserId");

    return runWithOptionalTransaction(options, async (transactionSession) => {
      const { appointment } = await loadPrivilegedAppointment({
        appointmentId,
        employerProfileId,
        employerContext,
        actorRole,
        session: transactionSession,
      });

      if (appointment.status === "no_show" && appointment.noShowParty === noShowParty) {
        return {
          appointment,
          changed: false,
          idempotent: true,
          events: [],
        };
      }

      if (appointment.status !== "scheduled") {
        throw createAppointmentError({
          message: "Only scheduled appointments can be marked as no-show.",
          code: "APPOINTMENT_NO_SHOW_NOT_ALLOWED",
          statusCode: 409,
          details: {
            appointmentStatus: appointment.status,
          },
        });
      }

      appointment.status = "no_show";

      appointment.noShowAt = now;

      appointment.noShowRecordedBy = normalizedRecordedBy;

      appointment.noShowRecordedByRole = actorRole;

      appointment.noShowParty = noShowParty;

      await appointment.save(saveOptions(transactionSession));

      return {
        appointment,

        changed: true,

        idempotent: false,

        events: [
          buildEvent("job_interview_no_show", appointment, {
            noShowParty,
          }),
        ],
      };
    });
  }

  static async getEmployerAppointment(
    { appointmentId, employerProfileId, employerContext = null },
    options = {}
  ) {
    const appointment = await loadAppointment(appointmentId, options.session);

    await loadEmployerAuthorizedJob({
      jobId: appointment.job,

      employerProfileId,

      employerContext,

      session: options.session,
    });

    return appointment;
  }

  static async getProfessionalAppointment({ appointmentId, professionalProfileId }, options = {}) {
    return loadProfessionalAppointment({
      appointmentId,
      professionalProfileId,
      session: options.session,
    });
  }

  static async getAdminAppointment({ appointmentId }, options = {}) {
    return loadAppointment(appointmentId, options.session);
  }

  static async getEmployerApplicationAppointments(
    { applicationId, employerProfileId, employerContext = null },
    options = {}
  ) {
    const application = await loadApplication(applicationId, options.session);

    await loadEmployerAuthorizedJob({
      jobId: application.job,

      employerProfileId,

      employerContext,

      session: options.session,
    });

    const query = Appointment.find({
      jobApplication: application._id,
    }).sort({
      roundNumber: 1,
    });

    return applySession(query, options.session);
  }

  static async getProfessionalApplicationAppointments(
    { applicationId, professionalProfileId },
    options = {}
  ) {
    const normalizedProfessionalId = normalizeObjectId(
      professionalProfileId,
      "professionalProfileId"
    );

    const application = await loadApplication(applicationId, options.session);

    if (!objectIdEquals(application.professional, normalizedProfessionalId)) {
      throw createAppointmentError({
        message: "Job application not found.",
        code: "JOB_APPLICATION_NOT_FOUND",
        statusCode: 404,
      });
    }

    const query = Appointment.find({
      jobApplication: application._id,
    }).sort({
      roundNumber: 1,
    });

    return applySession(query, options.session);
  }

  static async getAdminApplicationAppointments({ applicationId }, options = {}) {
    const application = await loadApplication(applicationId, options.session);

    const query = Appointment.find({
      jobApplication: application._id,
    }).sort({
      roundNumber: 1,
    });

    return applySession(query, options.session);
  }
}

module.exports = AppointmentService;
