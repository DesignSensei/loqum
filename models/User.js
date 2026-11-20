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

const LEGAL_NAME_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "legalNameSource",
  "legalNameEvidence",
];

const IDENTITY_FIELDS = [...LEGAL_NAME_FIELDS, "role"];

function isValidLegalName(value) {
  return (
    value == null ||
    (typeof value === "string" && value.length <= 100 && !/[\u0000-\u001F\u007F]/.test(value))
  );
}

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
      maxlength: 100,
      validate: {
        validator: isValidLegalName,
        message: "Legal name component is invalid.",
      },
      default: "",
    },

    middleName: {
      type: String,
      trim: true,
      maxlength: 100,
      validate: {
        validator: isValidLegalName,
        message: "Legal name component is invalid.",
      },
      default: "",
    },

    lastName: {
      type: String,

      required: function () {
        return this.role !== "professional" || this.legalNameSource === "nin_registry";
      },

      trim: true,
      maxlength: 100,
      validate: {
        validator: isValidLegalName,
        message: "Legal name component is invalid.",
      },
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
    optimisticConcurrency: true,
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
    if (
      (this.isNew || this.isSelected("firstName") || this.isModified("firstName")) &&
      !this.firstName
    ) {
      this.invalidate("firstName", "NIN registry-derived professional first name is required.");
    }

    if (
      (this.isNew || this.isSelected("lastName") || this.isModified("lastName")) &&
      !this.lastName
    ) {
      this.invalidate("lastName", "NIN registry-derived professional last name is required.");
    }

    /**
     * Newly established NIN provenance requires an evidence reference.
     * Existing documents may omit legalNameEvidence because select
     * is false, so an unrelated save must not invalidate them.
     */

    const mustValidateEvidenceReference =
      this.isNew ||
      this.isSelected("legalNameEvidence") ||
      this.isModified("legalNameSource") ||
      this.isModified("legalNameEvidence");

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
 * Query identity writes are guarded separately below. Controllers and
 * services still need input allowlists and authentic evidence checks.
 */

userSchema.pre("save", async function protectRegistryLegalName() {
  if (this.isNew) {
    return;
  }

  const protectedFields = IDENTITY_FIELDS;

  const hasProtectedChange = protectedFields.some((field) => {
    return this.isModified(field);
  });

  if (!hasProtectedChange) {
    return;
  }

  if (!this.isSelected("role") || !this.isSelected("legalNameSource")) {
    throw new Error("Load role and legal-name provenance before changing account identity.");
  }

  // Compare against stored provenance, not the submitted document state.
  const previousUser = await this.constructor
    .findById(this._id)
    .select("role firstName middleName lastName legalNameSource +legalNameEvidence")
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

// ───────────────────── QUERY IDENTITY PROTECTION ─────────────────────

/**
 * Query updates do not run document validation or save middleware.
 *
 * Preserve the existing transactional onboarding assignment, with an
 * explicit unverified professional filter and complete name evidence.
 * Other identity changes must use a loaded document and save().
 *
 * This protects model operations, not raw collection writes. Services
 * must verify the evidence and must never forward arbitrary request
 * filters, update operators or transaction options into this model.
 */

function assertSafeIdentityUpdate(filter, update, options = {}, operation) {
  if (
    Array.isArray(update) ||
    ["replaceOne", "findOneAndReplace"].includes(operation) ||
    options.overwrite
  ) {
    throw new Error("User pipeline and replacement writes are not supported; use document save().");
  }
  if (!update) return false;

  const touchesIdentity = (path) => IDENTITY_FIELDS.includes(String(path).split(".")[0]);
  const changed = [];
  for (const [operator, values] of Object.entries(update)) {
    if (!operator.startsWith("$")) {
      if (touchesIdentity(operator)) changed.push(["direct", operator]);
      continue;
    }
    for (const [path, value] of Object.entries(values || {})) {
      if (touchesIdentity(path) || (operator === "$rename" && touchesIdentity(value))) {
        changed.push([operator, path]);
      }
    }
  }
  if (!changed.length) return false;

  const fields = update.$set || {};
  const onboardingAssignment =
    ["updateOne", "findOneAndUpdate"].includes(operation) &&
    !options.upsert &&
    options.session?.inTransaction?.() === true &&
    filter.role === "professional" &&
    filter.legalNameSource === "unverified" &&
    Object.prototype.hasOwnProperty.call(filter, "legalNameEvidence") &&
    filter.legalNameEvidence === null &&
    changed.every(([operator, path]) => operator === "$set" && LEGAL_NAME_FIELDS.includes(path)) &&
    LEGAL_NAME_FIELDS.every((path) => Object.prototype.hasOwnProperty.call(fields, path)) &&
    fields.legalNameSource === "nin_registry" &&
    mongoose.isValidObjectId(fields.legalNameEvidence) &&
    typeof fields.firstName === "string" &&
    fields.firstName.trim().length > 0 &&
    isValidLegalName(fields.firstName) &&
    typeof fields.lastName === "string" &&
    fields.lastName.trim().length > 0 &&
    isValidLegalName(fields.lastName) &&
    isValidLegalName(fields.middleName);

  if (!onboardingAssignment) {
    throw new Error(
      "Identity query updates require a complete transactional onboarding assignment; use document save() for other changes."
    );
  }
  // Invalidate stale documents loaded before the registry-name assignment.
  // The service must not supply its own version mutation alongside this one.
  if (
    Object.entries(update).some(
      ([operator, values]) =>
        operator.startsWith("$") &&
        Object.entries(values || {}).some(
          ([path, value]) =>
            path === "__v" || path.startsWith("__v.") || (operator === "$rename" && value === "__v")
        )
    )
  ) {
    throw new Error("Identity assignment versioning is managed by the User model.");
  }
  update.$inc = { ...(update.$inc || {}), __v: 1 };
  return true;
}

userSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  function () {
    if (assertSafeIdentityUpdate(this.getFilter(), this.getUpdate(), this.getOptions(), this.op)) {
      this.setOptions({ runValidators: true });
    }
  }
);

// Bulk identity writes bypass document guards and are deliberately excluded.
userSchema.pre("bulkWrite", function (operations) {
  for (const operation of operations) {
    if (operation.replaceOne || operation.insertOne) {
      throw new Error("Bulk user creation/replacement is not supported; use create() or save().");
    }
    for (const name of ["updateOne", "updateMany"]) {
      if (operation[name]) {
        assertSafeIdentityUpdate(
          operation[name].filter,
          operation[name].update,
          operation[name],
          name
        );
      }
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
