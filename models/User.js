// models/User.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

/**
 * USER MODEL
 *
 * Stores account information, authentication credentials,
 * identity provenance, access roles and security settings.
 *
 * Platform administrators, employers and professionals share
 * this model. Employer team roles belong to EmployerMember.
 *
 * Professional legal names must originate from trusted NIN
 * registry evidence, not applicant-entered registration data.
 */

// ───────────────────── USER SCHEMA ─────────────────────

const userSchema = new mongoose.Schema(
  {
    // ───────────────────── LEGAL NAME ─────────────────────

    /**
     * Professionals register without manually entering legal names.
     * Trusted production NIN evidence supplies separate name components.
     *
     * Employer and administrator names identify account holders,
     * not CAC-registered businesses.
     */

    firstName: {
      type: String,

      required: function () {
        return this.role !== "professional" || this.legalNameSource === "nin_registry";
      },

      trim: true,
      default: "",
    },

    middleName: {
      type: String,
      trim: true,
      default: "",
    },

    lastName: {
      type: String,

      required: function () {
        return this.role !== "professional" || this.legalNameSource === "nin_registry";
      },

      trim: true,
      default: "",
    },

    // ───────────────────── DISPLAY NAME ─────────────────────

    /**
     * Display names are not authoritative legal identity evidence.
     * They cannot replace NIN-derived names or establish
     * identity-holder authentication.
     */

    displayName: {
      type: String,
      trim: true,
      default: "",
    },

    // ───────────────────── LEGAL NAME PROVENANCE ─────────────────────

    /**
     * unverified: No authoritative NIN-derived name is established.
     * nin_registry: Legal names came from trusted production NIN evidence.
     *
     * Provenance does not establish biometric authentication or
     * final KYC approval. Only trusted services may assign it.
     */

    legalNameSource: {
      type: String,
      enum: ["unverified", "nin_registry"],
      default: "unverified",
      required: true,
    },

    /**
     * Permanent KYC record supporting the registry-derived name.
     * Assigned during trusted onboarding, not from request bodies.
     *
     * The record may still require additional identity checks.
     * Explicit selection is required when retrieving this field.
     */

    legalNameEvidence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KYCVerification",
      default: null,
      select: false,
    },

    // ───────────────────── EMAIL ADDRESS ─────────────────────

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    // ───────────────────── CONTACT INFORMATION ─────────────────────

    phoneCode: {
      type: String,
      trim: true,
      default: "+234",
    },

    phoneNumber: {
      type: String,
      trim: true,
      default: "",
    },

    // ───────────────────── PASSWORD ─────────────────────

    // Local authentication requires a password stored as a hash.
    password: {
      type: String,

      required: function () {
        return this.authProvider === "local";
      },

      select: false,
    },

    // ───────────────────── AUTHENTICATION PROVIDER ─────────────────────

    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },

    // ───────────────────── GOOGLE AUTHENTICATION ─────────────────────

    googleId: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },

    photo: {
      type: String,
      default: "",
    },

    // ───────────────────── ACCESS CONTROL ─────────────────────

    /**
     * Platform roles identify the account category.
     *
     * Both founders use admin. Employer owners, business admins,
     * branch managers and staff are managed separately through
     * EmployerProfile and EmployerMember.
     *
     * Public registration must never assign the admin role.
     */

    role: {
      type: String,
      enum: ["admin", "professional", "employer"],
      required: true,
    },

    professionalProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
    },

    employerProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
    },

    // ───────────────────── ACCOUNT SECURITY ─────────────────────

    /**
     * Email verification is separate from NIN identity checks,
     * professional licensing and final marketplace approval.
     */

    isVerified: {
      type: Boolean,
      default: false,
    },

    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended", "deactivated", "banned"],
      default: "active",
    },

    // ───────────────────── ONBOARDING STATUS ─────────────────────

    // Completing onboarding does not automatically grant KYC approval.
    isOnboarded: {
      type: Boolean,
      default: false,
    },

    // ───────────────────── OTP / TWO-FACTOR AUTHENTICATION ─────────────────────

    otp: {
      type: String,
      select: false,
    },

    otpExpiry: {
      type: Date,
      select: false,
    },

    otpAttempts: {
      type: Number,
      default: 0,
    },

    otpLastSentAt: {
      type: Date,
    },

    // ───────────────────── PASSWORD RECOVERY ─────────────────────

    resetPasswordToken: {
      type: String,
      select: false,
    },

    resetPasswordExpiry: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// ───────────────────── PROFESSIONAL LEGAL NAME VALIDATION ─────────────────────

/**
 * Professional registration must not accept applicant-entered legal names.
 *
 * Before NIN onboarding, all legal-name fields remain empty.
 * After registry provenance is established, first and last names
 * and permanent verification evidence become mandatory.
 *
 * This validates document consistency. Trusted onboarding services
 * must independently verify evidence authenticity and eligibility.
 */

userSchema.pre("validate", function validateProfessionalLegalName() {
  if (this.role !== "professional") {
    return;
  }

  // ───────────────────── UNVERIFIED LEGAL NAME ─────────────────────

  if (this.legalNameSource === "unverified") {
    if (this.firstName) {
      this.invalidate(
        "firstName",
        "Professional legal first name must come from NIN registry evidence."
      );
    }

    if (this.middleName) {
      this.invalidate(
        "middleName",
        "Professional legal middle name must come from NIN registry evidence."
      );
    }

    if (this.lastName) {
      this.invalidate(
        "lastName",
        "Professional legal last name must come from NIN registry evidence."
      );
    }

    if (this.legalNameEvidence) {
      this.invalidate(
        "legalNameEvidence",
        "Unverified professional names cannot have authoritative NIN name evidence."
      );
    }

    return;
  }

  // ───────────────────── NIN REGISTRY NAME ─────────────────────

  if (this.legalNameSource === "nin_registry") {
    if (!this.firstName) {
      this.invalidate("firstName", "NIN registry-derived professional first name is required.");
    }

    if (!this.lastName) {
      this.invalidate("lastName", "NIN registry-derived professional last name is required.");
    }

    /**
     * Newly established NIN provenance requires an evidence reference.
     * Existing documents may omit legalNameEvidence because select
     * is false, so an unrelated save must not invalidate them.
     */

    const mustValidateEvidenceReference =
      this.isNew || this.isModified("legalNameSource") || this.isModified("legalNameEvidence");

    if (mustValidateEvidenceReference && !this.legalNameEvidence) {
      this.invalidate(
        "legalNameEvidence",
        "NIN registry-derived professional names require permanent verification evidence."
      );
    }
  }
});

// ───────────────────── REGISTRY LEGAL NAME PROTECTION ─────────────────────

/**
 * Once NIN provenance is established, ordinary account updates
 * cannot alter the legal name or its supporting evidence.
 *
 * The initial transition from unverified to nin_registry remains
 * permitted through the trusted onboarding workflow.
 *
 * Query-based updates bypass save middleware. Controllers and
 * services must independently protect these fields.
 */

userSchema.pre("save", async function protectRegistryLegalName() {
  if (this.isNew) {
    return;
  }

  const protectedFields = [
    "firstName",
    "middleName",
    "lastName",
    "legalNameSource",
    "legalNameEvidence",
  ];

  const hasProtectedChange = protectedFields.some((field) => {
    return this.isModified(field);
  });

  if (!hasProtectedChange) {
    return;
  }

  // Compare against stored provenance, not the submitted document state.
  const previousUser = await this.constructor
    .findById(this._id)
    .select("firstName middleName lastName legalNameSource +legalNameEvidence")
    .session(this.$session())
    .lean();

  if (!previousUser || previousUser.legalNameSource !== "nin_registry") {
    return;
  }

  // Reject changes to previously established registry identity.
  for (const field of protectedFields) {
    if (!this.isModified(field)) {
      continue;
    }

    const previousValue = previousUser[field];
    const currentValue = this[field];

    const previousComparableValue = previousValue == null ? "" : String(previousValue);

    const currentComparableValue = currentValue == null ? "" : String(currentValue);

    if (previousComparableValue !== currentComparableValue) {
      throw new Error(
        "NIN registry-derived legal names and their evidence cannot be changed through ordinary account updates."
      );
    }
  }
});

// ───────────────────── PASSWORD HASHING ─────────────────────

/**
 * Hash new or modified passwords before saving.
 * Unchanged passwords must not be hashed again.
 */

userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) {
    return;
  }

  try {
    const salt = await bcrypt.genSalt(10);

    this.password = await bcrypt.hash(this.password, salt);
  } catch (error) {
    throw error;
  }
});

// ───────────────────── PASSWORD VERIFICATION ─────────────────────

// Compare a supplied password against its stored bcrypt hash.
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) {
    return false;
  }

  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
