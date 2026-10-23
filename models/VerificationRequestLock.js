const mongoose = require("mongoose");

const LOCK_KEY_PATTERN = /^cac:[a-f0-9]{24}$/;

const verificationRequestLockSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
      immutable: true,
      match: [LOCK_KEY_PATTERN, "Invalid verification lock key."],
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      required: true,
      immutable: true,
      index: true,
    },

    ownerToken: {
      type: String,
      required: true,
      trim: true,
      minlength: 32,
      maxlength: 128,
      select: false,
    },

    acquiredAt: {
      type: Date,
      required: true,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    renewedAt: {
      type: Date,
      default: null,
    },

    requestReference: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "verification_request_locks",
  }
);

verificationRequestLockSchema.pre("validate", function () {
  if (this.employer && this._id) {
    const expectedKey = `cac:${String(this.employer._id || this.employer).toLowerCase()}`;

    if (this._id !== expectedKey) {
      this.invalidate("employer", "Employer ID does not match the verification lock key.");
    }
  }

  if (this.acquiredAt && this.expiresAt) {
    const acquiredAt = new Date(this.acquiredAt).getTime();
    const expiresAt = new Date(this.expiresAt).getTime();

    if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt) || expiresAt <= acquiredAt) {
      this.invalidate("expiresAt", "Lock expiration must be later than acquisition.");
    }
  }
});

// Lease acquisition, renewal, and release must use atomic,
// ownership-checked database operations in the service.

module.exports = mongoose.model("VerificationRequestLock", verificationRequestLockSchema);
