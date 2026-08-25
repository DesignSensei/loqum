// models/helpers/occurrenceEvidenceSchema.js

const mongoose = require("mongoose");

const {
  OCCURRENCE_EVIDENCE_TYPES,
  OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,
} = require("../../constants/shiftLifecycle");

/**
 * Shared evidence schema for occurrence claims and disputes.
 *
 * Evidence is supporting material supplied by a professional, employer or
 * administrator while an occurrence claim or dispute is being reviewed.
 *
 * The reference field stores the durable reference to the evidence itself,
 * such as an uploaded file reference, message reference or other stored
 * evidence identifier.
 *
 * System-owned ShiftOccurrence and attendance records remain authoritative in
 * their own models. They should be referenced when useful rather than copied
 * into the evidence object.
 */

const occurrenceEvidenceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: OCCURRENCE_EVIDENCE_TYPES,
      required: true,
    },

    reference: {
      type: String,
      trim: true,
      maxlength: 1000,
      required: true,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    submittedByRole: {
      type: String,
      enum: OCCURRENCE_EVIDENCE_SUBMITTER_ROLES,
      required: true,
    },

    submittedByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    recordedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    _id: true,
  }
);

module.exports = occurrenceEvidenceSchema;
