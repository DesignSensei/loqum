// models/SavedJob.js

const mongoose = require("mongoose");

/**
 * SAVED JOB:
 *
 * Represents one professional bookmarking one permanent Job.
 *
 * The bookmark belongs to the Job rather than a JobPublication so the saved
 * relationship survives publication pause, expiry or renewal of the same Job.
 *
 * Saving a Job does not affect recruitment status, publication state,
 * application eligibility or JobApplication history.
 */

const savedJobSchema = new mongoose.Schema(
  {
    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
      immutable: true,
    },

    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      immutable: true,
    },

    savedAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true,
    },
  },
  {
    versionKey: false,
  }
);

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

savedJobSchema.index(
  {
    professional: 1,
    job: 1,
  },
  {
    unique: true,
  }
);

savedJobSchema.index({
  professional: 1,
  savedAt: -1,
});

savedJobSchema.index({
  job: 1,
});

module.exports = mongoose.model("SavedJob", savedJobSchema);
