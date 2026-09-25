// models/Appointment.js

const mongoose = require("mongoose");

const {
  nonNegativeIntegerField,
  nullableDateField,
  nullableReferenceField,
  requiredPositiveSafeIntegerField,
} = require("./helpers/schemaFields");

const {
  isValidTimeZone,
  nonEmptyText,
  hasAnyDocumentValue,
} = require("./helpers/schemaValidators");

const {
  JOB_APPOINTMENT_FORMATS,
  JOB_APPOINTMENT_STATUSES,
  JOB_APPOINTMENT_RESPONSE_STATUSES,
  JOB_APPOINTMENT_ACTOR_ROLES,
  JOB_APPOINTMENT_CANCELLATION_REASONS,
  JOB_APPOINTMENT_NO_SHOW_PARTIES,
  MAX_JOB_APPOINTMENT_TITLE_LENGTH,
  MAX_JOB_APPOINTMENT_LOCATION_LENGTH,
  MAX_JOB_APPOINTMENT_MEETING_LINK_LENGTH,
  MAX_JOB_APPOINTMENT_PHONE_LENGTH,
  MAX_JOB_APPOINTMENT_INTERVIEWER_NAME_LENGTH,
  MAX_JOB_APPOINTMENT_INTERVIEWER_ROLE_LENGTH,
  MAX_JOB_APPOINTMENT_NOTE_LENGTH,
  MAX_JOB_APPOINTMENT_REASON_LENGTH,
  MAX_JOB_APPOINTMENT_RESCHEDULE_HISTORY,
} = require("../constants/jobAppointment");

/**
 * APPOINTMENT:
 *
 * Represents one actual interview meeting for one JobApplication.
 *
 * JobApplication.status = "interview" describes the recruitment pipeline stage.
 * Appointment describes the individual meeting itself. Multiple interview rounds
 * therefore use separate Appointment records rather than interview_1/interview_2
 * application statuses.
 *
 * Appointment completion and no-show are explicit employer/admin actions. The
 * passage of time alone must never mutate appointment status.
 *
 * If a scheduled appointment has ended without a terminal outcome, services may
 * derive "awaiting_employer_update" from status = "scheduled" and endAt <= now.
 * That attention state is deliberately not persisted here.
 */

const MAX_INTERVIEWERS = 10;

const RESPONSE_HISTORY_STATUSES = JOB_APPOINTMENT_RESPONSE_STATUSES.filter(
  (status) => status !== "pending"
);

function sameSchedule(left, right) {
  if (!left || !right) {
    return false;
  }

  return (
    left.startAt?.getTime() === right.startAt?.getTime() &&
    left.endAt?.getTime() === right.endAt?.getTime() &&
    left.timeZone === right.timeZone &&
    left.format === right.format &&
    (left.onsiteLocation || null) === (right.onsiteLocation || null) &&
    (left.meetingLink || null) === (right.meetingLink || null) &&
    (left.phoneNumber || null) === (right.phoneNumber || null)
  );
}

/* ─────────────────────────────── INTERVIEWERS ─────────────────────────────── */

const interviewerSchema = new mongoose.Schema(
  {
    user: nullableReferenceField("User"),

    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: MAX_JOB_APPOINTMENT_INTERVIEWER_NAME_LENGTH,
    },

    role: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_INTERVIEWER_ROLE_LENGTH,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── SCHEDULE SNAPSHOT ─────────────────────────────── */

const scheduleSnapshotSchema = new mongoose.Schema(
  {
    startAt: {
      type: Date,
      required: true,
    },

    endAt: {
      type: Date,
      required: true,
    },

    timeZone: {
      type: String,
      trim: true,
      required: true,

      validate: {
        validator: isValidTimeZone,
        message: "timeZone must be a valid IANA time zone.",
      },
    },

    format: {
      type: String,
      enum: JOB_APPOINTMENT_FORMATS,
      required: true,
    },

    onsiteLocation: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_LOCATION_LENGTH,
      default: null,
    },

    meetingLink: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_MEETING_LINK_LENGTH,
      default: null,
    },

    phoneNumber: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_PHONE_LENGTH,
      default: null,
    },
  },
  {
    _id: false,
  }
);

scheduleSnapshotSchema.pre("validate", function validateScheduleSnapshot() {
  if (this.startAt && this.endAt && this.endAt <= this.startAt) {
    this.invalidate("endAt", "Appointment endAt must be later than startAt.");
  }

  if (this.format === "onsite") {
    if (!nonEmptyText(this.onsiteLocation)) {
      this.invalidate("onsiteLocation", "On-site appointments require onsiteLocation.");
    }

    if (this.meetingLink || this.phoneNumber) {
      this.invalidate(
        "format",
        "On-site appointments cannot contain video or phone meeting details."
      );
    }
  }

  if (this.format === "video") {
    if (!nonEmptyText(this.meetingLink)) {
      this.invalidate("meetingLink", "Video appointments require meetingLink.");
    }

    if (this.onsiteLocation || this.phoneNumber) {
      this.invalidate(
        "format",
        "Video appointments cannot contain on-site or phone meeting details."
      );
    }
  }

  if (this.format === "phone") {
    if (!nonEmptyText(this.phoneNumber)) {
      this.invalidate("phoneNumber", "Phone appointments require phoneNumber.");
    }

    if (this.onsiteLocation || this.meetingLink) {
      this.invalidate(
        "format",
        "Phone appointments cannot contain on-site or video meeting details."
      );
    }
  }
});

/* ─────────────────────────────── RESCHEDULE HISTORY ─────────────────────────────── */

const rescheduleHistorySchema = new mongoose.Schema(
  {
    fromSchedule: {
      type: scheduleSnapshotSchema,
      required: true,
    },

    toSchedule: {
      type: scheduleSnapshotSchema,
      required: true,
    },

    changedAt: {
      type: Date,
      required: true,
    },

    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    actorRole: {
      type: String,
      enum: JOB_APPOINTMENT_ACTOR_ROLES,
      required: true,
    },

    reason: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_REASON_LENGTH,
      default: null,
    },
  },
  {
    _id: false,
  }
);

rescheduleHistorySchema.pre("validate", function validateRescheduleHistoryEntry() {
  if (this.actorRole === "system") {
    this.invalidate("actorRole", "Appointment rescheduling requires a human actor.");
  }

  if (sameSchedule(this.fromSchedule, this.toSchedule)) {
    this.invalidate(
      "toSchedule",
      "A reschedule history entry must contain an actual schedule change."
    );
  }
});

/* ─────────────────────────────── RESPONSE HISTORY ─────────────────────────────── */

const responseHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: RESPONSE_HISTORY_STATUSES,
      required: true,
    },

    respondedAt: {
      type: Date,
      required: true,
    },

    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    note: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_REASON_LENGTH,
      default: null,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── APPOINTMENT SCHEMA ─────────────────────────────── */

const appointmentSchema = new mongoose.Schema(
  {
    // --- IDENTITY / RELATIONSHIPS ---

    referenceCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      immutable: true,
    },

    jobApplication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobApplication",
      required: true,
      immutable: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
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

    roundNumber: {
      ...requiredPositiveSafeIntegerField({
        label: "roundNumber",
      }),

      immutable: true,
    },

    title: {
      type: String,
      trim: true,
      default: "Interview",
      required: true,
      maxlength: MAX_JOB_APPOINTMENT_TITLE_LENGTH,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    createdByRole: {
      type: String,
      enum: JOB_APPOINTMENT_ACTOR_ROLES,
      required: true,
      immutable: true,
    },

    // --- CURRENT SCHEDULE ---

    /**
     * Immutable baseline used to verify the first reschedule history entry.
     */
    initialSchedule: {
      type: scheduleSnapshotSchema,
      required: true,
      immutable: true,
    },

    startAt: {
      type: Date,
      required: true,
    },

    endAt: {
      type: Date,
      required: true,
    },

    timeZone: {
      type: String,
      trim: true,
      required: true,

      validate: {
        validator: isValidTimeZone,
        message: "timeZone must be a valid IANA time zone.",
      },
    },

    format: {
      type: String,
      enum: JOB_APPOINTMENT_FORMATS,
      required: true,
    },

    onsiteLocation: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_LOCATION_LENGTH,
      default: null,
    },

    meetingLink: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_MEETING_LINK_LENGTH,
      default: null,
    },

    phoneNumber: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_PHONE_LENGTH,
      default: null,
    },

    meetingInstructions: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_NOTE_LENGTH,
      default: null,
    },

    interviewers: {
      type: [interviewerSchema],
      required: true,

      validate: {
        validator: (items) =>
          Array.isArray(items) && items.length > 0 && items.length <= MAX_INTERVIEWERS,

        message: `Appointments require between 1 and ${MAX_INTERVIEWERS} interviewers.`,
      },
    },

    // --- PROFESSIONAL RESPONSE ---

    responseStatus: {
      type: String,
      enum: JOB_APPOINTMENT_RESPONSE_STATUSES,
      default: "pending",
      required: true,
    },

    respondedAt: nullableDateField(),

    respondedBy: nullableReferenceField("User"),

    responseNote: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_REASON_LENGTH,
      default: null,
    },

    responseHistory: {
      type: [responseHistorySchema],
      default: [],
    },

    // --- RESCHEDULING ---

    rescheduleCount: nonNegativeIntegerField(),

    rescheduleHistory: {
      type: [rescheduleHistorySchema],
      default: [],

      validate: {
        validator: (items) =>
          Array.isArray(items) && items.length <= MAX_JOB_APPOINTMENT_RESCHEDULE_HISTORY,

        message:
          `rescheduleHistory cannot exceed ` + `${MAX_JOB_APPOINTMENT_RESCHEDULE_HISTORY} entries.`,
      },
    },

    // --- MEETING LIFECYCLE ---

    status: {
      type: String,
      enum: JOB_APPOINTMENT_STATUSES,
      default: "scheduled",
      required: true,
    },

    completedAt: nullableDateField(),

    completedBy: nullableReferenceField("User"),

    completedByRole: {
      type: String,
      enum: [...JOB_APPOINTMENT_ACTOR_ROLES, null],
      default: null,
    },

    cancelledAt: nullableDateField(),

    cancelledBy: nullableReferenceField("User"),

    cancelledByRole: {
      type: String,
      enum: [...JOB_APPOINTMENT_ACTOR_ROLES, null],
      default: null,
    },

    cancellationReason: {
      type: String,
      enum: [...JOB_APPOINTMENT_CANCELLATION_REASONS, null],
      default: null,
    },

    cancellationReasonDetails: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_REASON_LENGTH,
      default: null,
    },

    noShowAt: nullableDateField(),

    noShowRecordedBy: nullableReferenceField("User"),

    noShowRecordedByRole: {
      type: String,
      enum: [...JOB_APPOINTMENT_ACTOR_ROLES, null],
      default: null,
    },

    noShowParty: {
      type: String,
      enum: [...JOB_APPOINTMENT_NO_SHOW_PARTIES, null],
      default: null,
    },

    // --- EMPLOYER-ONLY NOTES ---

    employerPrivateNote: {
      type: String,
      trim: true,
      maxlength: MAX_JOB_APPOINTMENT_NOTE_LENGTH,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

appointmentSchema.index(
  {
    referenceCode: 1,
  },
  {
    unique: true,
  }
);

appointmentSchema.index(
  {
    jobApplication: 1,
    roundNumber: 1,
  },
  {
    unique: true,
  }
);

appointmentSchema.index({
  professional: 1,
  status: 1,
  startAt: 1,
});

appointmentSchema.index({
  business: 1,
  branch: 1,
  status: 1,
  startAt: 1,
});

appointmentSchema.index({
  job: 1,
  status: 1,
  startAt: 1,
});

appointmentSchema.index({
  status: 1,
  endAt: 1,
});

/* ─────────────────────────────── VALIDATION ─────────────────────────────── */

appointmentSchema.pre("validate", function validateAppointment() {
  const rescheduleHistory = Array.isArray(this.rescheduleHistory) ? this.rescheduleHistory : [];

  const responseHistory = Array.isArray(this.responseHistory) ? this.responseHistory : [];

  /* ─────────────────────────────── CREATION AUTHORITY ─────────────────────────────── */

  if (!["employer", "admin"].includes(this.createdByRole)) {
    this.invalidate(
      "createdByRole",
      "Job interview appointments must be created by an employer or admin."
    );
  }

  /* ─────────────────────────────── CURRENT SCHEDULE ─────────────────────────────── */

  const currentSchedule = {
    startAt: this.startAt,
    endAt: this.endAt,
    timeZone: this.timeZone,
    format: this.format,
    onsiteLocation: this.onsiteLocation,
    meetingLink: this.meetingLink,
    phoneNumber: this.phoneNumber,
  };

  if (this.isNew && !sameSchedule(this.initialSchedule, currentSchedule)) {
    this.invalidate(
      "initialSchedule",
      "A new Appointment initialSchedule must match its current schedule."
    );
  }

  if (this.startAt && this.endAt && this.endAt <= this.startAt) {
    this.invalidate("endAt", "Appointment endAt must be later than startAt.");
  }

  if (this.format === "onsite") {
    if (!nonEmptyText(this.onsiteLocation)) {
      this.invalidate("onsiteLocation", "On-site appointments require onsiteLocation.");
    }

    if (this.meetingLink || this.phoneNumber) {
      this.invalidate(
        "format",
        "On-site appointments cannot contain video or phone meeting details."
      );
    }
  }

  if (this.format === "video") {
    if (!nonEmptyText(this.meetingLink)) {
      this.invalidate("meetingLink", "Video appointments require meetingLink.");
    }

    if (this.onsiteLocation || this.phoneNumber) {
      this.invalidate(
        "format",
        "Video appointments cannot contain on-site or phone meeting details."
      );
    }
  }

  if (this.format === "phone") {
    if (!nonEmptyText(this.phoneNumber)) {
      this.invalidate("phoneNumber", "Phone appointments require phoneNumber.");
    }

    if (this.onsiteLocation || this.meetingLink) {
      this.invalidate(
        "format",
        "Phone appointments cannot contain on-site or video meeting details."
      );
    }
  }

  /* ─────────────────────────────── RESCHEDULE AUDIT ─────────────────────────────── */

  if (this.rescheduleCount !== rescheduleHistory.length) {
    this.invalidate(
      "rescheduleCount",
      "rescheduleCount must equal the number of rescheduleHistory entries."
    );
  }

  if (rescheduleHistory.length > 0) {
    if (!sameSchedule(rescheduleHistory[0].fromSchedule, this.initialSchedule)) {
      this.invalidate(
        "rescheduleHistory",
        "The first reschedule entry must begin from initialSchedule."
      );
    }

    for (let index = 1; index < rescheduleHistory.length; index += 1) {
      const previousEntry = rescheduleHistory[index - 1];

      const currentEntry = rescheduleHistory[index];

      if (currentEntry.changedAt < previousEntry.changedAt) {
        this.invalidate(
          "rescheduleHistory",
          "Appointment reschedule history must be chronological."
        );

        break;
      }

      if (!sameSchedule(previousEntry.toSchedule, currentEntry.fromSchedule)) {
        this.invalidate(
          "rescheduleHistory",
          "Each reschedule entry must continue from the previous resulting schedule."
        );

        break;
      }
    }

    const latestSchedule = rescheduleHistory[rescheduleHistory.length - 1].toSchedule;

    if (!sameSchedule(latestSchedule, currentSchedule)) {
      this.invalidate(
        "rescheduleHistory",
        "The latest reschedule entry must match the Appointment's current schedule."
      );
    }
  } else if (!sameSchedule(this.initialSchedule, currentSchedule)) {
    this.invalidate(
      "rescheduleHistory",
      "A changed Appointment schedule requires reschedule history."
    );
  }

  if (!this.isNew) {
    if (this.isModified("initialSchedule")) {
      this.invalidate(
        "initialSchedule",
        "initialSchedule cannot be changed after Appointment creation."
      );
    }

    const schedulePaths = [
      "startAt",
      "endAt",
      "timeZone",
      "format",
      "onsiteLocation",
      "meetingLink",
      "phoneNumber",
    ];

    const scheduleChanged = schedulePaths.some((path) => this.isModified(path));

    if (scheduleChanged && !this.isModified("rescheduleHistory")) {
      this.invalidate(
        "rescheduleHistory",
        "Changing an Appointment schedule requires a rescheduleHistory entry."
      );
    }

    if (scheduleChanged && !this.isModified("rescheduleCount")) {
      this.invalidate(
        "rescheduleCount",
        "Changing an Appointment schedule requires rescheduleCount to advance."
      );
    }

    if (scheduleChanged && this.responseStatus !== "pending") {
      this.invalidate(
        "responseStatus",
        "A rescheduled Appointment must return the professional response to pending."
      );
    }

    if (scheduleChanged && ["completed", "cancelled", "no_show"].includes(this.status)) {
      this.invalidate("status", "Terminal appointments cannot be rescheduled.");
    }
  }

  /* ─────────────────────────────── PROFESSIONAL RESPONSE ─────────────────────────────── */

  if (this.isNew && this.responseStatus !== "pending") {
    this.invalidate(
      "responseStatus",
      "New interview appointments must begin with a pending professional response."
    );
  }

  if (this.isNew && responseHistory.length > 0) {
    this.invalidate(
      "responseHistory",
      "New interview appointments cannot begin with response history."
    );
  }

  if (this.responseStatus === "pending") {
    if (this.respondedAt || this.respondedBy || this.responseNote) {
      this.invalidate(
        "responseStatus",
        "Pending appointment response cannot contain current response audit fields."
      );
    }
  } else {
    if (!this.respondedAt || !this.respondedBy) {
      this.invalidate(
        "responseStatus",
        "Confirmed or declined appointment response requires respondedAt and respondedBy."
      );
    }

    const latestResponse = responseHistory[responseHistory.length - 1];

    if (
      !latestResponse ||
      latestResponse.status !== this.responseStatus ||
      latestResponse.respondedAt?.getTime() !== this.respondedAt?.getTime() ||
      String(latestResponse.respondedBy || "") !== String(this.respondedBy || "")
    ) {
      this.invalidate(
        "responseHistory",
        "The latest responseHistory entry must match the current professional response."
      );
    }
  }

  for (let index = 1; index < responseHistory.length; index += 1) {
    if (responseHistory[index].respondedAt < responseHistory[index - 1].respondedAt) {
      this.invalidate("responseHistory", "Appointment response history must be chronological.");

      break;
    }
  }

  if (this.responseStatus === "declined") {
    if (this.status !== "cancelled" || this.cancellationReason !== "candidate_declined") {
      this.invalidate(
        "responseStatus",
        "A declined appointment must be cancelled with candidate_declined reason."
      );
    }
  }

  /* ─────────────────────────────── TERMINAL OUTCOME AUDIT ─────────────────────────────── */

  const hasCompletedAudit = hasAnyDocumentValue([
    this.completedAt,
    this.completedBy,
    this.completedByRole,
  ]);

  const hasCancellationAudit = hasAnyDocumentValue([
    this.cancelledAt,
    this.cancelledBy,
    this.cancelledByRole,
    this.cancellationReason,
    this.cancellationReasonDetails,
  ]);

  const hasNoShowAudit = hasAnyDocumentValue([
    this.noShowAt,
    this.noShowRecordedBy,
    this.noShowRecordedByRole,
    this.noShowParty,
  ]);

  if (this.status === "scheduled") {
    if (hasCompletedAudit || hasCancellationAudit || hasNoShowAudit) {
      this.invalidate(
        "status",
        "Scheduled appointments cannot contain terminal-outcome audit fields."
      );
    }
  }

  if (this.status === "completed") {
    if (!this.completedAt || !this.completedBy || !this.completedByRole) {
      this.invalidate(
        "status",
        "Completed appointments require completedAt, completedBy and completedByRole."
      );
    }

    if (!["employer", "admin"].includes(this.completedByRole)) {
      this.invalidate(
        "completedByRole",
        "Appointment completion must be recorded by an employer or admin."
      );
    }

    if (hasCancellationAudit || hasNoShowAudit) {
      this.invalidate(
        "status",
        "Completed appointments cannot also be cancelled or recorded as no-show."
      );
    }

    if (this.completedAt && this.startAt && this.completedAt < this.startAt) {
      this.invalidate(
        "completedAt",
        "Appointment cannot be completed before its scheduled start time."
      );
    }
  } else if (hasCompletedAudit) {
    this.invalidate(
      "completedAt",
      "Completion audit fields may only be set when status is completed."
    );
  }

  if (this.status === "cancelled") {
    if (
      !this.cancelledAt ||
      !this.cancelledByRole ||
      !this.cancellationReason ||
      (this.cancelledByRole !== "system" && !this.cancelledBy)
    ) {
      this.invalidate(
        "status",
        "Cancelled appointments require cancellation audit fields and a user actor unless cancelled by system."
      );
    }

    if (hasCompletedAudit || hasNoShowAudit) {
      this.invalidate(
        "status",
        "Cancelled appointments cannot also be completed or recorded as no-show."
      );
    }

    if (this.cancellationReason === "other" && !nonEmptyText(this.cancellationReasonDetails)) {
      this.invalidate(
        "cancellationReasonDetails",
        "cancellationReasonDetails is required when cancellationReason is other."
      );
    }

    if (
      this.cancellationReason === "candidate_declined" &&
      this.cancelledByRole !== "professional"
    ) {
      this.invalidate(
        "cancelledByRole",
        "candidate_declined cancellation must be attributed to the professional."
      );
    }

    if (this.cancelledByRole === "system" && this.cancelledBy) {
      this.invalidate("cancelledBy", "System cancellation cannot reference a user actor.");
    }
  } else if (hasCancellationAudit) {
    this.invalidate(
      "cancelledAt",
      "Cancellation audit fields may only be set when status is cancelled."
    );
  }

  if (this.status === "no_show") {
    if (
      !this.noShowAt ||
      !this.noShowRecordedBy ||
      !this.noShowRecordedByRole ||
      !this.noShowParty
    ) {
      this.invalidate(
        "status",
        "No-show appointments require noShowAt, noShowRecordedBy, noShowRecordedByRole and noShowParty."
      );
    }

    if (!["employer", "admin"].includes(this.noShowRecordedByRole)) {
      this.invalidate(
        "noShowRecordedByRole",
        "Appointment no-show must be recorded by an employer or admin."
      );
    }

    if (hasCompletedAudit || hasCancellationAudit) {
      this.invalidate("status", "No-show appointments cannot also be completed or cancelled.");
    }

    if (this.noShowAt && this.startAt && this.noShowAt < this.startAt) {
      this.invalidate(
        "noShowAt",
        "An appointment cannot be recorded as no-show before its scheduled start time."
      );
    }
  } else if (hasNoShowAudit) {
    this.invalidate("noShowAt", "No-show audit fields may only be set when status is no_show.");
  }
});

module.exports = mongoose.model("Appointment", appointmentSchema);
