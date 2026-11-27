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
const CLOSED_EMAIL_SUFFIX = "@closed.loqum.invalid";

function closedAccountEmail(id) {
  return String(id) + CLOSED_EMAIL_SUFFIX;
}

function isReservedClosureEmail(email) {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(CLOSED_EMAIL_SUFFIX);
}

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
        return this.authProvider === "local" && this.accountStatus !== "closed";
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
      enum: ["active", "restricted", "suspended", "deactivated", "banned", "closed"],
      default: "active",
    },

    // ───────────────────── ACCOUNT CLOSURE ─────────────────────

    closedAt: {
      type: Date,
      default: null,
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

// ───────────────────── ACCOUNT CLOSURE PROTECTION ─────────────────────

userSchema.pre("validate", function validateAccountClosure() {
  if (this.accountStatus !== "closed") {
    if (this.closedAt) this.invalidate("closedAt", "Only closed accounts may have a closure timestamp.");
    if (isReservedClosureEmail(this.email)) this.invalidate("email", "This email namespace is reserved.");
    return;
  }

  if (this.isNew) this.invalidate("accountStatus", "New accounts cannot be created closed.");
  if (!(this.closedAt instanceof Date) || !Number.isFinite(this.closedAt.getTime()) ||
      (this.createdAt && this.closedAt < this.createdAt)) {
    this.invalidate("closedAt", "A valid account closure timestamp is required.");
  }

  if (this.email !== closedAccountEmail(this._id)) {
    this.invalidate("email", "Closed accounts require a released registration identity.");
  }

  for (const field of [
    "password",
    "googleId",
    "otp",
    "otpExpiry",
    "otpLastSentAt",
    "resetPasswordToken",
    "resetPasswordExpiry"
  ]) {
    if (this[field] != null) {
      this.invalidate(field, "Closed accounts cannot retain authentication credentials.");
    }
  }

  if (this.isVerified || this.twoFactorEnabled || this.otpAttempts !== 0) {
    this.invalidate("accountStatus", "Closed accounts cannot retain active security settings.");
  }
});

userSchema.pre("save", async function protectAccountClosure() {
  if (this.isNew) return;

  const previous = await this.constructor.findById(this._id)
    .select("accountStatus closedAt")
    .session(this.$session())
    .lean();

  if (!previous) {
    throw new Error("Original account was not found.");
  }

  if (previous.accountStatus === "closed" && this.isModified()) {
    throw new Error("Closed accounts cannot be modified or reopened.");
  }

  if (this.accountStatus === "closed" && previous.accountStatus !== "closed") {
    if (previous.accountStatus !== "active" || !this.$session()?.inTransaction?.()) {
      throw new Error("Account closure requires an active account and transaction.");
    }

    // Hidden credentials must be explicitly loaded before they are cleared.

    for (const field of [
      "password",
      "otp",
      "otpExpiry",
      "resetPasswordToken",
      "resetPasswordExpiry"
    ]) {
      if (!this.isSelected(field)) {
        throw new Error("Load all authentication credentials before closure.");
      }
    }
  }
});

// Low-level closure primitive; callers must establish eligibility first.

userSchema.statics.closeForAccountClosure = async function (
  { userId, currentTime = new Date() } = {},
  { session } = {}
) {
  if (!session?.inTransaction?.() || !mongoose.isValidObjectId(userId)) {
    throw new Error("Account closure requires a valid user and active transaction.");
  }

  const user = await this.findById(userId)
    .select("+password +otp +otpExpiry +resetPasswordToken +resetPasswordExpiry")
    .session(session);

  if (!user) {
    throw new Error("User not found.");
  }

  if (user.accountStatus === "closed") {
    return user;
  }

  if (
    user.accountStatus !== "active" ||
    !["employer", "professional"].includes(user.role)
  ) {
    throw new Error("This account requires manual closure review.");
  }

  user.accountStatus = "closed";
  user.closedAt = currentTime;
  user.email = closedAccountEmail(user._id);

  for (const field of [
    "password",
    "googleId",
    "otp",
    "otpExpiry",
    "otpLastSentAt",
    "resetPasswordToken",
    "resetPasswordExpiry"
  ]) {
    user.set(field, undefined);
  }

  user.isVerified = false;
  user.twoFactorEnabled = false;
  user.otpAttempts = 0;

  await user.save({ session });

  return user;
};

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

  // Closure is a document-only transition.
  // Query writes cannot reopen closed accounts.

  for (const [operator, values] of Object.entries(update)) {
    const entries = operator.startsWith("$")
      ? Object.entries(values || {})
      : [[operator, values]];

    for (const [path, value] of entries) {
      const root = String(path).split(".")[0];

      const target = operator === "$rename"
        ? String(value).split(".")[0]
        : null;

      if (
        root === "closedAt" ||
        target === "closedAt" ||
        target === "accountStatus" ||
        (
          root === "accountStatus" &&
          (
            !["$set", "$setOnInsert", path].includes(operator) ||
            ![
              "active",
              "restricted",
              "suspended",
              "deactivated",
              "banned"
            ].includes(value)
          )
        )
      ) {
        throw new Error("Account closure fields require document save().");
      }

      if (
        target === "email" ||
        (
          root === "email" &&
          (
            !["$set", "$setOnInsert", path].includes(operator) ||
            isReservedClosureEmail(value)
          )
        )
      ) {
        throw new Error("Invalid registration email update.");
      }
    }
  }

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

    this.setQuery({
      $and: [
        this.getFilter(),
        { accountStatus: { $ne: "closed" } }
      ]
    });
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

        operation[name].filter = {
          $and: [
            operation[name].filter,
            { accountStatus: { $ne: "closed" } }
          ],
        };
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
  if (this.accountStatus === "closed" || !this.password) {
    return false;
  }

  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
