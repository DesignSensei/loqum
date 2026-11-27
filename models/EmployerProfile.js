// models/EmployerProfile.js

const mongoose = require("mongoose");

const geoPointSchema = require("./helpers/geoPointSchema");
const { minorUnitAmountField, nonNegativeIntegerField } = require("./helpers/schemaFields");
const { hasAnyValue, validateVerificationState } = require("./helpers/employerProfileHelpers");

// CAC verifies business identity; permits are branch-specific.
const CAC_REGISTRATION_PATTERN = /^(RC|BN)\d{4,10}$/;

function isValidRegisteredBusinessName(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 150 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

const employerProfileSchema = new mongoose.Schema(
  {
    // ───────── Business identity ─────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    type: {
      type: String,
      enum: ["pharmacy", "clinic", "hospital", "laboratory"],
      required: true,
      immutable: true,
    },

    countryCode: {
      type: String,
      default: "NG",
      uppercase: true,
      trim: true,
      required: true,
      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
    },

    currency: {
      type: String,
      default: "NGN",
      uppercase: true,
      trim: true,
      required: true,
      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
    },

    // Registered legal name from trusted CAC evidence.
    businessName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,

      validate: {
        validator: isValidRegisteredBusinessName,
        message: "businessName must contain a valid CAC registered legal business name.",
      },
    },

    // ───────── Business branding ─────────

    logoUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    publicDescription: {
      type: String,
      trim: true,
      maxlength: 1500,
      default: null,
    },

    websiteUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
      match: [/^https?:\/\/\S+$/i, "websiteUrl must be a valid HTTP or HTTPS URL."],
    },

    // ───────── Business contact ─────────

    businessEmail: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      maxlength: 254,
    },

    businessPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
      maxlength: 10,
    },

    businessPhone: {
      type: String,
      trim: true,
      required: true,
      maxlength: 30,
    },

    // ───────── Onboarding location ─────────
    // Branch records govern facility premises and permits.
    // GeoJSON coordinates: [longitude, latitude].

    address: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    googlePlaceId: {
      type: String,
      trim: true,
      required: true,
      maxlength: 250,
    },

    location: {
      type: geoPointSchema,
      required: true,
    },

    state: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    lga: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    // ───────── CAC verification ─────────
    // Production provider evidence is required for verification.

    cacRegistrationNumber: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      maxlength: 100,

      match: [
        CAC_REGISTRATION_PATTERN,
        "cacRegistrationNumber must be a valid RC or BN registration number.",
      ],
    },

    cacVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
      required: true,
    },

    cacVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
      required: true,
    },

    cacVerificationSource: {
      type: String,
      enum: ["cac_portal", "uploaded_document", "provider", "internal_review", "not_checked"],
      default: "not_checked",
      required: true,
    },

    // Must match businessName when CAC is verified.
    cacNameOnRecord: {
      type: String,
      trim: true,
      default: null,
      maxlength: 150,

      validate: {
        validator(value) {
          return value == null || isValidRegisteredBusinessName(value);
        },
        message: "cacNameOnRecord must contain a valid registered legal business name.",
      },
    },

    cacVerifiedAt: {
      type: Date,
      default: null,
    },

    cacLastCheckedAt: {
      type: Date,
      default: null,
    },

    cacVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cacVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    cacRejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────── Contact person ─────────
    // These details are declared by the employer.

    contactFirstName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    contactLastName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
    },

    contactRole: {
      type: String,
      enum: [
        "owner",
        "director",
        "superintendent_pharmacist",
        "branch_manager",
        "hr_admin",
        "operations_manager",
        "procurement_manager",
        "other",
      ],
      required: true,
      trim: true,
    },

    contactPhoneCode: {
      type: String,
      trim: true,
      default: "+234",
      maxlength: 10,
    },

    contactPhone: {
      type: String,
      trim: true,
      required: true,
      maxlength: 30,
    },

    // ───────── Financial summary ─────────
    // Amounts use minor units; wallet balances live elsewhere.

    totalShiftsPaid: nonNegativeIntegerField(),

    totalAmountFunded: minorUnitAmountField({
      defaultValue: 0,
    }),

    totalAmountSpent: minorUnitAmountField({
      defaultValue: 0,
    }),

    totalProfessionalPayFunded: minorUnitAmountField({
      defaultValue: 0,
    }),

    totalPlatformFeesPaid: minorUnitAmountField({
      defaultValue: 0,
      select: false,
    }),

    totalRefundedAmount: minorUnitAmountField({
      defaultValue: 0,
    }),

    // ───────── Account status ─────────
    // Restrictions are independent of CAC and permit verification.

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended", "closing", "closed"],
      default: "active",
      required: true,
    },

    closureStartedAt: {
      type: Date,
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    accountStatusReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    accountStatusUpdatedAt: {
      type: Date,
      default: null,
    },

    accountStatusUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ───────── Reputation ─────────

    reviews: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Review",
      },
    ],

    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    totalReviews: nonNegativeIntegerField(),

    // ───────── Shift activity ─────────

    totalShiftsPosted: nonNegativeIntegerField(),

    totalShiftsCompleted: nonNegativeIntegerField(),

    activeShiftCount: nonNegativeIntegerField(),

    lastShiftPostedAt: {
      type: Date,
      default: null,
    },

    lastShiftCompletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────── Indexes ─────────

employerProfileSchema.index({ user: 1 }, { unique: true });

employerProfileSchema.index({
  accountStatus: 1,
});

employerProfileSchema.index({
  type: 1,
});

employerProfileSchema.index({
  state: 1,
  lga: 1,
});

employerProfileSchema.index({
  location: "2dsphere",
});

employerProfileSchema.index(
  {
    countryCode: 1,
    cacRegistrationNumber: 1,
  },
  {
    name: "unique_open_cac_registration",
    unique: true,
    partialFilterExpression: {
      accountStatus: {
        $in: ["active", "restricted", "suspended", "closing"],
      },
    },
  }
);

employerProfileSchema.index({
  cacVerificationStatus: 1,
});

employerProfileSchema.index({
  type: 1,
  state: 1,
  lga: 1,
  accountStatus: 1,
});

// Facility-permit indexes belong to FacilityPermit.

// ───────── Document validation ─────────

employerProfileSchema.pre("validate", function validateEmployerProfile() {
  // Validate CAC registration.
  if (
    this.countryCode === "NG" &&
    !CAC_REGISTRATION_PATTERN.test(this.cacRegistrationNumber || "")
  ) {
    this.invalidate(
      "cacRegistrationNumber",
      "A Nigerian employer requires a valid RC or BN registration number."
    );
  }

  // Validate CAC evidence.
  validateVerificationState(this, {
    label: "CAC",
    pathPrefix: "cac",
    status: this.cacVerificationStatus,
    method: this.cacVerificationMethod,
    source: this.cacVerificationSource,
    nameOnRecord: this.cacNameOnRecord,
    verifiedAt: this.cacVerifiedAt,
    lastCheckedAt: this.cacLastCheckedAt,
    verifiedBy: this.cacVerifiedBy,
    verificationNote: this.cacVerificationNote,
    rejectionReason: this.cacRejectionReason,
  });

  // Verified CAC must match the established legal identity.
  if (this.cacVerificationStatus === "verified") {
    if (!isValidRegisteredBusinessName(this.cacNameOnRecord)) {
      this.invalidate(
        "cacNameOnRecord",
        "Verified CAC registration requires a valid registry-derived legal business name."
      );
    }

    if (this.businessName !== this.cacNameOnRecord) {
      this.invalidate(
        "businessName",
        "The verified registered business name must match the CAC name on record."
      );
    }

    if (this.cacVerificationMethod !== "api" && this.cacVerificationMethod !== "provider") {
      this.invalidate(
        "cacVerificationMethod",
        "CAC verification must originate from the configured verification provider."
      );
    }

    if (this.cacVerificationSource !== "provider") {
      this.invalidate(
        "cacVerificationSource",
        "Verified CAC registration requires trusted provider evidence."
      );
    }
  }

  // Identity changes require a separate correction workflow.
  if (
    !this.isNew &&
    ["cacRegistrationNumber", "countryCode", "type"].some((path) => this.isModified(path))
  ) {
    this.invalidate(
      "cacRegistrationNumber",
      "Established CAC registration, country and business type cannot be changed by ordinary profile updates."
    );
  }

  // Owners cannot verify their own CAC records.
  if (this.user && this.cacVerifiedBy && String(this.user) === String(this.cacVerifiedBy)) {
    this.invalidate("cacVerifiedBy", "An employer cannot verify their own CAC registration.");
  }
  if (this.isNew && ["closing", "closed"].includes(this.accountStatus)) {
    this.invalidate("accountStatus", "New businesses cannot start in closure.");
  }

  if (this.accountStatus === "closing" && !this.closureStartedAt) {
    this.invalidate("closureStartedAt", "Closing businesses require a start timestamp.");
  }

  if (this.closureStartedAt && !["closing", "closed"].includes(this.accountStatus)) {
    this.invalidate("closureStartedAt", "Closure history cannot exist on an operating business.");
  }

  if (this.closureStartedAt && this.closedAt && this.closedAt < this.closureStartedAt) {
    this.invalidate("closedAt", "Closure cannot precede its start timestamp.");
  }

  if (this.accountStatus === "closed" && !this.closedAt) {
    this.invalidate("closedAt", "A closed business must have a closure timestamp.");
  }

  if (this.accountStatus !== "closed" && this.closedAt) {
    this.invalidate("closedAt", "A closure timestamp is only permitted for closed businesses.");
  }

  // ───────── Account-status audit ─────────
  // Restrictions require a reason, actor and timestamp.

  const accountStatusHasAudit = hasAnyValue([
    this.accountStatusReason,
    this.accountStatusUpdatedAt,
    this.accountStatusUpdatedBy,
  ]);

  if (["restricted", "suspended"].includes(this.accountStatus)) {
    if (!this.accountStatusReason) {
      this.invalidate(
        "accountStatusReason",
        `${this.accountStatus} account status requires a reason.`
      );
    }

    if (!this.accountStatusUpdatedAt) {
      this.invalidate(
        "accountStatusUpdatedAt",
        `${this.accountStatus} account status requires an update timestamp.`
      );
    }

    if (!this.accountStatusUpdatedBy) {
      this.invalidate(
        "accountStatusUpdatedBy",
        `${this.accountStatus} account status requires an update actor.`
      );
    }
  } else if (
    accountStatusHasAudit &&
    (!this.accountStatusUpdatedAt || !this.accountStatusUpdatedBy)
  ) {
    this.invalidate(
      "accountStatusUpdatedAt",
      "Account-status audit data requires both accountStatusUpdatedAt and accountStatusUpdatedBy."
    );
  }
});

// ───────── Closure transition protection ─────────

employerProfileSchema.pre("save", async function () {
  if (this.isNew || !["accountStatus", "closureStartedAt", "closedAt"]
    .some((path) => this.isModified(path))) return;

  const previous = await this.constructor.findById(this._id)
    .select("accountStatus closureStartedAt closedAt")
    .session(this.$session()).lean();

  if (!previous) throw new Error("Business profile no longer exists.");

  const closureTransition =
    ["closing", "closed"].includes(previous.accountStatus) ||
    ["closing", "closed"].includes(this.accountStatus) ||
    this.isModified("closureStartedAt") || this.isModified("closedAt");

  if (!closureTransition) return;

  const starting = previous.accountStatus === "active" &&
    this.accountStatus === "closing" && !previous.closureStartedAt;

  const finishing = previous.accountStatus === "closing" &&
    this.accountStatus === "closed" &&
    previous.closureStartedAt &&
    this.closureStartedAt &&
    previous.closureStartedAt.getTime() === this.closureStartedAt.getTime();

  if (
    this.$locals.businessClosureTransition !== true ||
    !this.$session()?.inTransaction?.() ||
    (!starting && !finishing)
  ) {
    throw new Error("Business closure requires an authorized transactional transition.");
  }
});

function isAccountStatusUpdate(update) {
  let changesStatus = false;

  function inspect(path, value, operator) {
    const root = String(path).split(".")[0];
    const target = operator === "$rename" ? String(value).split(".")[0] : null;

    if (["closureStartedAt", "closedAt"].includes(root) ||
        ["closureStartedAt", "closedAt", "accountStatus"].includes(target)) {
      throw new Error("Closure fields require the business closure service.");
    }

    if (root === "accountStatus") {
      if (operator !== "$set" ||
          !["active", "restricted", "suspended"].includes(value)) {
        throw new Error("Closure status requires the business closure service.");
      }
      changesStatus = true;
    }
  }

  for (const [operator, values] of Object.entries(update || {})) {
    if (!operator.startsWith("$")) {
      inspect(operator, values, "$set");
    } else {
      for (const [path, value] of Object.entries(values || {})) {
        inspect(path, value, operator);
      }
    }
  }

  return changesStatus;
}

// ───────── Established legal name ─────────
// Routine saves cannot replace the trusted CAC business name.

employerProfileSchema.pre("save", async function () {
  if (this.isNew || !this.isModified("businessName")) return;

  const previous = await this.constructor
    .findById(this._id)
    .select("businessName")
    .session(this.$session())
    .lean();

  if (!previous || previous.businessName !== this.businessName) {
    throw new Error(
      "Established CAC business names cannot be changed through ordinary profile updates."
    );
  }
});

// ───────── Query identity protection ─────────
// Reject query updates that bypass legal identity protections.

function assertSafeIdentityUpdate(update, options = {}, operation) {
  if (
    Array.isArray(update) ||
    options.overwrite ||
    ["replaceOne", "findOneAndReplace"].includes(operation)
  ) {
    throw new Error(
      "Employer profile replacements and pipelines are unsupported; use document save()."
    );
  }

  const protectedPath = (path) =>
    ["user", "businessName", "cacRegistrationNumber", "countryCode", "type"].includes(
      String(path).split(".")[0]
    );

  for (const [operator, values] of Object.entries(update || {})) {
    if (!operator.startsWith("$")) {
      if (protectedPath(operator)) {
        throw new Error(
          "Employer ownership, CAC identity and business type cannot be changed by query updates."
        );
      }
      continue;
    }

    for (const [path, value] of Object.entries(values || {})) {
      if (protectedPath(path) || (operator === "$rename" && protectedPath(value))) {
        throw new Error(
          "Employer ownership, CAC identity and business type cannot be changed by query updates."
        );
      }
    }
  }
}

employerProfileSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  function () {
    assertSafeIdentityUpdate(this.getUpdate(), this.getOptions(), this.op);

    if (isAccountStatusUpdate(this.getUpdate())) {
      this.setQuery({
        $and: [
          this.getFilter(),
          { accountStatus: { $nin: ["closing", "closed"] } },
        ],
      });
    }
  }
);

employerProfileSchema.pre("bulkWrite", function (operations) {
  for (const operation of operations) {
    if (operation.replaceOne) {
      throw new Error("Bulk employer profile replacement is unsupported; use document save().");
    }

    for (const name of ["updateOne", "updateMany"]) {
      if (operation[name]) {
        assertSafeIdentityUpdate(operation[name].update, operation[name], name);

        if (isAccountStatusUpdate(operation[name].update)) {
          operation[name].filter = {
            $and: [
              operation[name].filter,
              { accountStatus: { $nin: ["closing", "closed"] } },
            ],
          };
        }
      }
    }
  }
});

module.exports = mongoose.model("EmployerProfile", employerProfileSchema);
