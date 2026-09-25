// models/ProfessionalResume.js

const mongoose = require("mongoose");

/**
 * PROFESSIONAL RESUME:
 *
 * Stores reusable CV/resume files owned by a professional.
 *
 * A professional may keep multiple resumes and choose one as their default.
 * When applying for a permanent Job, the selected resume is copied into the
 * JobApplication resumeSnapshot so later profile-resume changes do not alter
 * historical applications.
 *
 * Application uploads may also be promoted into this collection when the
 * professional explicitly chooses to save them for future use.
 *
 * File access is private. The underlying file URL is excluded from normal
 * queries and should only be selected by an authorized professional workflow
 * or by the application service while creating the immutable resume snapshot.
 */

const ALLOWED_RESUME_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const professionalResumeSchema = new mongoose.Schema(
  {
    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
      immutable: true,
    },

    label: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "CV",
    },

    fileName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 255,
      immutable: true,
    },

    mimeType: {
      type: String,
      enum: ALLOWED_RESUME_MIME_TYPES,
      required: true,
      immutable: true,
    },

    fileSizeBytes: {
      type: Number,
      min: 1,
      required: true,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "fileSizeBytes must be a positive whole number.",
      },
    },

    fileUrl: {
      type: String,
      trim: true,
      required: true,
      immutable: true,
      select: false,
    },

    source: {
      type: String,
      enum: ["profile_upload", "application_upload"],
      default: "profile_upload",
      required: true,
      immutable: true,
    },

    isDefault: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
      required: true,
    },

    archivedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

professionalResumeSchema.index({
  professional: 1,
  status: 1,
  createdAt: -1,
});

professionalResumeSchema.index(
  {
    professional: 1,
    isDefault: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      isDefault: true,
      status: "active",
    },
  }
);

// --- VALIDATION / AUTO-CLEANUP ---

professionalResumeSchema.pre("validate", function validateProfessionalResume() {
  if (this.status === "archived") {
    this.isDefault = false;

    if (!this.archivedAt) {
      this.archivedAt = new Date();
    }

    return;
  }

  this.archivedAt = null;
});

module.exports = mongoose.model("ProfessionalResume", professionalResumeSchema);
