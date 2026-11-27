// models/ProfessionalProfile.js

const mongoose = require("mongoose");

// ───────────────────────── CONSTANTS ─────────────────────────

const PROFESSIONAL_TYPES = [
  "pharmacist",
  "pharmacy_technician",
  "nurse",
  "doctor",
  "lab_scientist",
  "radiographer",
  "physiotherapist",
];

const VERIFICATION_STATUSES = ["pending", "verified", "rejected", "needs_review"];

const LICENCE_VALIDITY_TYPES = ["expiry_date", "licensing_year", "life"];

const AVAILABILITY_STATUSES = ["available", "unavailable", "busy", "paused"];

const AVAILABILITY_MODES = ["weekly", "dates"];
const MAX_AVAILABLE_DATES = 90;

const PROTECTED_QUERY_PATHS = new Set([
  "user",
  "type",
  "licenceNumber",
  "licenceIssuingBody",
  "licenceVerificationStatus",
  "licenceVerificationMethod",
  "licenceVerificationSource",
  "licenceNameOnRecord",
  "licenceDocumentUrl",
  "licencePendingDocumentUrl",
  "licencePendingDocumentSubmittedAt",
  "licenceValidityType",
  "licenceLicensingYear",
  "licenceExpiryDate",
  "upcomingLicence",
  "licenceVerifiedAt",
  "licenceLastCheckedAt",
  "licenceVerifiedBy",
  "licenceVerificationNote",

  "bvnVerification",

  "professionalApprovalStatus",
  "approvedForShiftsAt",
  "approvedForShiftsBy",
  "approvalNote",
  "rejectionReason",

  "accountStatus",
  "closedAt",
  "accountStatusReason",
  "accountStatusUpdatedAt",
  "accountStatusUpdatedBy",

  "marketplaceStatus",

  "availabilityStatus",
  "availabilityMode",
  "availableWeekdays",
  "availableDates",
  "availabilityNote",

  "certifications",
]);

// ───────────────────────── DATE HELPERS ─────────────────────────

function getTodayISODate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isValidCalendarDate(value) {
  if (!isValidDate(value)) {
    return false;
  }

  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

// ───────────────────────── SCHEMA ─────────────────────────

const professionalProfileSchema = new mongoose.Schema(
  {
    // ───────────────────────── IDENTITY ─────────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    type: {
      type: String,
      enum: PROFESSIONAL_TYPES,
      required: true,
    },

    phone: {
      type: String,
      trim: true,
      required: true,
    },

    phoneCode: {
      type: String,
      trim: true,
      required: true,
      default: "+234",
    },

    specialty: {
      type: String,
      trim: true,
      required: true,
    },

    bio: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    yearsOfExperience: {
      type: Number,
      min: 0,
      default: 0,
    },

    // ───────────────────────── LOCATION ─────────────────────────

    address: {
      type: String,
      trim: true,
      required: true,
    },

    googlePlaceId: {
      type: String,
      trim: true,
      default: "",
    },

    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
        required: true,
      },

      coordinates: {
        type: [Number],
        required: true,

        validate: {
          validator(value) {
            if (!Array.isArray(value) || value.length !== 2) {
              return false;
            }

            const [longitude, latitude] = value;

            return (
              Number.isFinite(longitude) &&
              Number.isFinite(latitude) &&
              longitude >= -180 &&
              longitude <= 180 &&
              latitude >= -90 &&
              latitude <= 90
            );
          },

          message: "Coordinates must contain valid longitude and latitude.",
        },
      },
    },

    state: {
      type: String,
      trim: true,
      required: true,
    },

    lga: {
      type: String,
      trim: true,
      required: true,
    },

    // ───────────────────────── LICENCE VERIFICATION ─────────────────────────

    licenceNumber: {
      type: String,
      trim: true,
      required: true,
    },

    licenceIssuingBody: {
      type: String,
      trim: true,
      default: null,
    },

    licenceVerificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: "pending",
      required: true,
    },

    licenceVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
      required: true,
    },

    licenceVerificationSource: {
      type: String,
      enum: [
        "pcn_public_portal",
        "professional_council_portal",
        "uploaded_document",
        "provider",
        "internal_review",
        "not_checked",
      ],
      default: "internal_review",
      required: true,
    },

    licenceNameOnRecord: {
      type: String,
      trim: true,
      default: null,
    },

    licenceDocumentUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    // Unreviewed uploads remain separate from an approved licence.
    // A renewal upload must not overwrite the current verified licence.
    licencePendingDocumentUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    licencePendingDocumentSubmittedAt: {
      type: Date,
      default: null,
    },

    // The administrator selects exactly one validity mode.
    // Licensing-year expiry is automatically 31 December.
    licenceValidityType: {
      type: String,
      enum: [...LICENCE_VALIDITY_TYPES, null],
      default: null,
    },

    licenceLicensingYear: {
      type: Number,
      min: 1900,
      max: 2199,
      default: null,
    },

    // Calendar date stored at UTC midnight.
    // Null for a verified life licence.
    licenceExpiryDate: {
      type: Date,
      default: null,
    },

    // One independently approved future renewal may be stored.
    // Its supporting audit evidence is held in KYCVerification.
    upcomingLicence: {
      type: new mongoose.Schema(
        {
          reviewId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "KYCVerification",
            required: true,
          },

          documentUrl: {
            type: String,
            trim: true,
            default: null,
            select: false,
          },

          nameOnRecord: {
            type: String,
            trim: true,
            required: true,
          },

          validFrom: {
            type: Date,
            required: true,
          },

          evidenceValidFrom: {
            type: Date,
            required: true,
          },

          validityType: {
            type: String,
            enum: LICENCE_VALIDITY_TYPES,
            required: true,
          },

          licensingYear: {
            type: Number,
            min: 1900,
            max: 2199,
            default: null,
          },

          expiryDate: {
            type: Date,
            default: null,
          },

          verifiedAt: {
            type: Date,
            required: true,
          },

          lastCheckedAt: {
            type: Date,
            required: true,
          },

          verifiedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },

          reviewNote: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
          },
        },
        {
          _id: false,
        }
      ),
      default: null,
    },

    licenceVerifiedAt: {
      type: Date,
      default: null,
    },

    licenceLastCheckedAt: {
      type: Date,
      default: null,
    },

    licenceVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    licenceVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────────────────────── CERTIFICATIONS ─────────────────────────

    certifications: [
      {
        name: {
          type: String,
          trim: true,
          required: true,
        },

        issuingBody: {
          type: String,
          trim: true,
        },

        dateObtained: {
          type: Date,
        },

        expiryDate: {
          type: Date,
          default: null,
        },

        documentUrl: {
          type: String,
          trim: true,
          default: null,
          select: false,
        },

        verified: {
          type: Boolean,
          default: false,
        },

        verifiedAt: {
          type: Date,
          default: null,
        },

        verifiedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
    ],

    // ───────────────────────── BVN / PAYOUT KYC ─────────────────────────

    // BVN verification is separate from NIN onboarding and
    // practising-licence approval. It does not itself authorise
    // professional participation in clinical shifts.
    bvnVerification: {
      status: {
        type: String,
        enum: ["not_started", "pending", "verified", "rejected", "needs_review"],
        default: "not_started",
      },

      provider: {
        type: String,
        enum: ["ninja", "dojah", "paystack", "smile_identity", "manual", null],
        default: null,
      },

      providerReference: {
        type: String,
        trim: true,
        default: null,
        select: false,
      },

      last4: {
        type: String,
        trim: true,
        maxlength: 4,
        default: null,
        select: false,
      },

      verifiedAt: {
        type: Date,
        default: null,
      },

      lastCheckedAt: {
        type: Date,
        default: null,
      },

      verifiedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      note: {
        type: String,
        trim: true,
        maxlength: 500,
        default: null,
      },
    },

    // ───────────────────────── AVAILABILITY ─────────────────────────

    availabilityStatus: {
      type: String,
      enum: AVAILABILITY_STATUSES,
      default: "unavailable",
      required: true,
    },

    availabilityMode: {
      type: String,
      enum: AVAILABILITY_MODES,
      default: "weekly",
      required: true,
    },

    availableWeekdays: {
      type: [
        {
          type: Number,
          enum: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
      default: [],
    },

    availableDates: {
      type: [Date],
      default: [],
    },

    availabilityNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    // ───────────────────────── FINANCIAL SUMMARY ─────────────────────────

    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ───────────────────────── TIER ─────────────────────────

    tier: {
      type: String,
      enum: ["newcomer", "accredited", "elite"],
      default: "newcomer",
    },

    tierSnapshot: {
      averageRating: {
        type: Number,
        default: null,
        min: 0,
        max: 5,
      },

      totalShiftsCompleted: {
        type: Number,
        default: null,
        min: 0,
      },

      reliabilityScore: {
        type: Number,
        default: null,
        min: 0,
        max: 100,
      },

      evaluatedAt: {
        type: Date,
        default: null,
      },
    },

    tierUpdatedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────────── ACCOUNT STATUS ─────────────────────────

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended", "closed"],
      default: "active",
      required: true,
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

    closedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────────── MARKETPLACE VISIBILITY ─────────────────────────

    marketplaceStatus: {
      type: String,
      enum: ["hidden", "visible", "paused"],
      default: "hidden",
      required: true,
    },

    // ───────────────────────── STRIKES ─────────────────────────

    strikes: {
      noShows: {
        type: Number,
        default: 0,
        min: 0,
      },

      lateArrivals: {
        type: Number,
        default: 0,
        min: 0,
      },

      earlyDepartures: {
        type: Number,
        default: 0,
        min: 0,
      },

      total: {
        type: Number,
        default: 0,
        min: 0,
      },
    },

    // ───────────────────────── SHIFT ACTIVITY ─────────────────────────

    totalShiftsCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },

    activeShiftCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalHoursWorked: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastShiftCompletedAt: {
      type: Date,
      default: null,
    },

    // ───────────────────────── REPUTATION ─────────────────────────

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

    totalReviews: {
      type: Number,
      default: 0,
      min: 0,
    },

    reliabilityScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },

    // ───────────────────────── PROFESSIONAL APPROVAL ─────────────────────────

    professionalApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "restricted", "needs_review"],
      default: "pending",
      required: true,
    },

    approvedForShiftsAt: {
      type: Date,
      default: null,
    },

    approvedForShiftsBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvalNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

// ───────────────────────── INDEXES ─────────────────────────

professionalProfileSchema.index({ user: 1 }, { unique: true });

professionalProfileSchema.index({ type: 1 });
professionalProfileSchema.index({ specialty: 1 });
professionalProfileSchema.index({ tier: 1 });
professionalProfileSchema.index({ accountStatus: 1 });
professionalProfileSchema.index({ marketplaceStatus: 1 });
professionalProfileSchema.index({ availabilityStatus: 1 });
professionalProfileSchema.index({ averageRating: -1 });
professionalProfileSchema.index({ reliabilityScore: -1 });
professionalProfileSchema.index({ state: 1, lga: 1 });
professionalProfileSchema.index({ location: "2dsphere" });

professionalProfileSchema.index(
  {
    type: 1,
    licenceNumber: 1,
  },
  {
    name: "unique_open_professional_licence",
    unique: true,
    partialFilterExpression: {
      accountStatus: {
        $in: ["active", "restricted", "suspended"],
      },
    },
  }
);

professionalProfileSchema.index({
  licenceVerificationStatus: 1,
});

// Individual licence-expiry reminders and approved renewal transitions.
professionalProfileSchema.index({
  licenceExpiryDate: 1,
});

professionalProfileSchema.index({
  "upcomingLicence.validFrom": 1,
});

professionalProfileSchema.index({
  "bvnVerification.status": 1,
});

professionalProfileSchema.index({
  professionalApprovalStatus: 1,
});

professionalProfileSchema.index({
  type: 1,
  state: 1,
  lga: 1,
  professionalApprovalStatus: 1,
  accountStatus: 1,
  marketplaceStatus: 1,
});

// ───────────────────────── LICENCE VERIFICATION VALIDATION ─────────────────────────

function validateVerificationSummary(profile) {
  const status = profile.licenceVerificationStatus;
  const method = profile.licenceVerificationMethod;
  const source = profile.licenceVerificationSource;
  const verifiedAt = profile.licenceVerifiedAt;
  const checkedAt = profile.licenceLastCheckedAt;
  const reviewedBy = profile.licenceVerifiedBy;
  const name = profile.licenceNameOnRecord;

  if (status === "verified") {
    if (method !== "manual" || source !== "uploaded_document") {
      profile.invalidate(
        "licenceVerificationMethod",
        "Verified licences require an independent manual uploaded-document review."
      );
    }

    if (!isValidDate(verifiedAt) || !isValidDate(checkedAt)) {
      profile.invalidate("licenceVerifiedAt", "Verified licences require review timestamps.");
    }

    if (!reviewedBy || String(reviewedBy) === String(profile.user)) {
      profile.invalidate("licenceVerifiedBy", "Independent admin review is required.");
    }

    if (typeof name !== "string" || !name.trim() || /[\u0000-\u001f\u007f]/.test(name)) {
      profile.invalidate("licenceNameOnRecord", "Verified licences require a legal name.");
    }
  } else if (verifiedAt) {
    profile.invalidate(
      "licenceVerifiedAt",
      "Only verified licences may retain a verification timestamp."
    );
  }

  if (isValidDate(verifiedAt) && isValidDate(checkedAt) && verifiedAt > checkedAt) {
    profile.invalidate("licenceLastCheckedAt", "Last check cannot precede verification.");
  }

  if (reviewedBy && String(reviewedBy) === String(profile.user)) {
    profile.invalidate("licenceVerifiedBy", "A professional cannot verify their own licence.");
  }
}

// ───────────────────────── LICENCE VALIDITY VALIDATION ─────────────────────────

// Keep the history of an approved licence even after its expiry.
// Operational eligibility is enforced by the service.
// Expiry does not erase the 30-day LOQUM renewal grace.
function validateLicenceValidity(profile) {
  const verified = profile.licenceVerificationStatus === "verified";

  const mode = profile.licenceValidityType;
  const expiry = profile.licenceExpiryDate;
  const year = profile.licenceLicensingYear;

  if (verified) {
    if (!LICENCE_VALIDITY_TYPES.includes(mode)) {
      profile.invalidate("licenceValidityType", "Approved licences require a validity type.");
    } else if (mode === "life") {
      if (expiry != null || year != null) {
        profile.invalidate(
          "licenceValidityType",
          "Life licences must not have an expiry date or licensing year."
        );
      }
    } else if (!isValidCalendarDate(expiry)) {
      profile.invalidate(
        "licenceExpiryDate",
        "Approved licences require a UTC calendar-date expiry."
      );
    } else if (mode === "expiry_date") {
      if (year != null) {
        profile.invalidate(
          "licenceLicensingYear",
          "Expiry-date licences must not include a licensing year."
        );
      }
    } else if (
      !Number.isInteger(year) ||
      year < 1900 ||
      year > 2199 ||
      expiry.toISOString().slice(0, 10) !== `${year}-12-31`
    ) {
      profile.invalidate(
        "licenceLicensingYear",
        "Licensing years must expire on 31 December of the selected year."
      );
    }
  } else if (mode != null || expiry != null || year != null) {
    profile.invalidate(
      "licenceValidityType",
      "Only verified licences may retain approved validity details."
    );
  }

  const future = profile.upcomingLicence;

  if (!future) {
    return;
  }

  if (!verified) {
    profile.invalidate(
      "upcomingLicence",
      "An upcoming licence requires a verified existing licence."
    );
    return;
  }

  // Sensitive nested document URLs are select:false.
  // Check the full future record when it is created or modified.
  if (!profile.isNew && !profile.isModified("upcomingLicence")) {
    return;
  }

  if (!future.documentUrl || !String(future.documentUrl).trim()) {
    profile.invalidate(
      "upcomingLicence.documentUrl",
      "Upcoming licences require a reviewed document reference."
    );
  }

  if (!future.reviewId) {
    profile.invalidate(
      "upcomingLicence.reviewId",
      "Upcoming licences require their verification review record."
    );
  }

  if (typeof future.nameOnRecord !== "string" || !future.nameOnRecord.trim()) {
    profile.invalidate(
      "upcomingLicence.nameOnRecord",
      "An approved future licence needs a legal name."
    );
  }

  if (!isValidCalendarDate(future.validFrom) || !isValidCalendarDate(future.evidenceValidFrom)) {
    profile.invalidate(
      "upcomingLicence.validFrom",
      "Upcoming licence commencement dates must be valid calendar dates."
    );
  } else if (future.validFrom < future.evidenceValidFrom) {
    profile.invalidate(
      "upcomingLicence.validFrom",
      "The licence cannot activate before its own validity period."
    );
  }

  if (
    !isValidDate(future.verifiedAt) ||
    !isValidDate(future.lastCheckedAt) ||
    future.verifiedAt > future.lastCheckedAt
  ) {
    profile.invalidate(
      "upcomingLicence.verifiedAt",
      "Upcoming licences require consistent administrative review timestamps."
    );
  }

  if (!future.verifiedBy || String(future.verifiedBy) === String(profile.user)) {
    profile.invalidate(
      "upcomingLicence.verifiedBy",
      "An independent administrator must approve upcoming licences."
    );
  }

  if (future.validityType === "life") {
    if (future.expiryDate != null || future.licensingYear != null) {
      profile.invalidate(
        "upcomingLicence.validityType",
        "A future life licence has no expiry or licensing year."
      );
    }
  } else if (!isValidCalendarDate(future.expiryDate)) {
    profile.invalidate(
      "upcomingLicence.expiryDate",
      "The future licence must have a valid expiry date."
    );
  } else if (isValidCalendarDate(future.validFrom) && future.expiryDate < future.validFrom) {
    profile.invalidate(
      "upcomingLicence.expiryDate",
      "A future licence cannot expire before activation."
    );
  } else if (future.validityType === "expiry_date") {
    if (future.licensingYear != null) {
      profile.invalidate(
        "upcomingLicence.licensingYear",
        "Expiry-date licences must not include a licensing year."
      );
    }
  } else if (future.validityType === "licensing_year") {
    if (
      !Number.isInteger(future.licensingYear) ||
      future.expiryDate.toISOString().slice(0, 10) !== `${future.licensingYear}-12-31`
    ) {
      profile.invalidate(
        "upcomingLicence.licensingYear",
        "The future licensing-year expiry must be 31 December."
      );
    }
  } else {
    profile.invalidate("upcomingLicence.validityType", "Unsupported future licence validity type.");
  }
}

// ───────────────────────── AVAILABILITY VALIDATION ─────────────────────────

function validateAvailability(profile) {
  const weekdays = profile.availableWeekdays || [];
  const dates = profile.availableDates || [];

  if (weekdays.length > 7) {
    profile.invalidate("availableWeekdays", "A maximum of seven weekdays may be selected.");
  }

  if (new Set(weekdays).size !== weekdays.length) {
    profile.invalidate("availableWeekdays", "Duplicate available weekdays are not permitted.");
  }

  if (dates.length > MAX_AVAILABLE_DATES) {
    profile.invalidate(
      "availableDates",
      `A maximum of ${MAX_AVAILABLE_DATES} availability dates may be stored.`
    );
  }

  const storedDates = new Set();

  for (const date of dates) {
    if (!isValidCalendarDate(date)) {
      profile.invalidate("availableDates", "Availability dates must be valid UTC calendar dates.");
      continue;
    }

    const isoDate = date.toISOString().slice(0, 10);

    if (storedDates.has(isoDate)) {
      profile.invalidate("availableDates", "Duplicate availability dates are not permitted.");
    }

    storedDates.add(isoDate);
  }

  if (profile.availabilityStatus === "available") {
    if (profile.availabilityMode === "weekly" && weekdays.length === 0) {
      profile.invalidate(
        "availableWeekdays",
        "Select at least one weekday before becoming available."
      );
    }

    if (profile.availabilityMode === "dates") {
      const today = getTodayISODate();

      const upcoming = [...storedDates].filter((date) => date >= today);

      if (upcoming.length === 0) {
        profile.invalidate(
          "availableDates",
          "Select at least one upcoming date before becoming available."
        );
      }
    }
  }
}

// ───────────────────────── DOCUMENT VALIDATION ─────────────────────────

professionalProfileSchema.pre("validate", function () {
  // ───────────────────────── STRIKES ─────────────────────────

  if (this.strikes) {
    this.strikes.total =
      Number(this.strikes.noShows || 0) +
      Number(this.strikes.lateArrivals || 0) +
      Number(this.strikes.earlyDepartures || 0);
  }

  // ───────────────────────── LICENCE CHANGE RESET ─────────────────────────

  /*
   * A licence-number or profession change invalidates the
   * existing licence review and final professional approval.
   *
   * The production onboarding NIN evidence remains intact.
   * No separate admin NIN review exists.
   *
   * The verification service must deactivate the
   * corresponding licence-review evidence records.
   */

  if (!this.isNew && (this.isModified("licenceNumber") || this.isModified("type"))) {
    this.licenceVerificationStatus = "pending";
    this.licenceVerificationMethod = "not_checked";
    this.licenceVerificationSource = "not_checked";

    this.licenceNameOnRecord = null;
    this.licenceDocumentUrl = null;
    this.licencePendingDocumentUrl = null;
    this.licencePendingDocumentSubmittedAt = null;
    this.licenceValidityType = null;
    this.licenceLicensingYear = null;
    this.licenceExpiryDate = null;
    this.upcomingLicence = null;
    this.licenceVerifiedAt = null;
    this.licenceLastCheckedAt = null;
    this.licenceVerifiedBy = null;
    this.licenceVerificationNote = null;

    this.professionalApprovalStatus = "pending";
    this.approvedForShiftsAt = null;
    this.approvedForShiftsBy = null;
    this.approvalNote = null;
    this.rejectionReason = null;

    this.marketplaceStatus = "hidden";
  }

  // ───────────────────────── VERIFICATION SUMMARY ─────────────────────────

  validateVerificationSummary(this);
  validateLicenceValidity(this);

  // There is no admin identity-verification summary on this profile.
  // Production NIN evidence is checked by the verification service
  // against User.legalNameEvidence and KYCVerification.
  const licenceVerified =
    this.licenceVerificationStatus === "verified" &&
    this.licenceVerificationMethod === "manual" &&
    this.licenceVerificationSource === "uploaded_document";

  // ───────────────────────── FINAL APPROVAL ─────────────────────────

  const approved = this.professionalApprovalStatus === "approved";

  const hasApprovalTimestamp = isValidDate(this.approvedForShiftsAt);

  const hasApprovalActor = Boolean(this.approvedForShiftsBy);

  if (hasApprovalTimestamp !== hasApprovalActor) {
    this.invalidate(
      "approvedForShiftsAt",
      "Approval timestamp and approver must be recorded together."
    );
  }

  if (
    this.approvedForShiftsBy &&
    this.user &&
    String(this.approvedForShiftsBy) === String(this.user)
  ) {
    this.invalidate("approvedForShiftsBy", "Professionals cannot approve themselves.");
  }

  if (approved && (!licenceVerified || !hasApprovalTimestamp || !hasApprovalActor)) {
    this.invalidate(
      "professionalApprovalStatus",
      "Approval requires an independently verified uploaded licence and a final administrative decision; NIN evidence is checked in the service."
    );
  }

  if (
    !["approved", "restricted"].includes(this.professionalApprovalStatus) &&
    (this.approvedForShiftsAt || this.approvedForShiftsBy)
  ) {
    this.invalidate(
      "approvedForShiftsAt",
      "This approval status cannot retain shift approval details."
    );
  }

  if (this.professionalApprovalStatus === "rejected") {
    if (!this.rejectionReason || !this.rejectionReason.trim()) {
      this.invalidate("rejectionReason", "Rejected approval requires a reason.");
    }
  } else if (this.rejectionReason) {
    this.invalidate("rejectionReason", "Only rejected approval may retain a rejection reason.");
  }

  // ───────────────────────── ACCOUNT CLOSURE ─────────────────────────

  if (this.accountStatus === "closed") {
    if (!isValidDate(this.closedAt)) {
      this.invalidate(
        "closedAt",
        "A closed professional profile must have a valid closure timestamp."
      );
    }

    this.marketplaceStatus = "hidden";
    this.availabilityStatus = "unavailable";
  } else if (this.closedAt) {
    this.invalidate(
      "closedAt",
      "A closure timestamp is only permitted for closed professional profiles."
    );
  }

  if (isValidDate(this.closedAt) && isValidDate(this.createdAt) && this.closedAt < this.createdAt) {
    this.invalidate("closedAt", "Closure cannot precede professional profile creation.");
  }

  // ───────────────────────── MARKETPLACE READINESS ─────────────────────────

  /*
   * Documentary approval does not automatically make
   * a professional visible in the marketplace.
   *
   * Hidden and paused preferences remain unchanged.
   * A professional who loses eligibility cannot stay visible.
   */

  const today = getTodayISODate();

  const upcoming = this.upcomingLicence;

  const upcomingDate = isValidCalendarDate(upcoming?.validFrom)
    ? upcoming.validFrom.toISOString().slice(0, 10)
    : null;

  const activeValidity =
    upcomingDate && upcomingDate <= today && upcoming?.verifiedAt && upcoming?.verifiedBy
      ? upcoming
      : this;

  const effectiveMode = activeValidity === this ? this.licenceValidityType : upcoming.validityType;

  const effectiveExpiry = activeValidity === this ? this.licenceExpiryDate : upcoming.expiryDate;

  const licenceCurrent =
    effectiveMode === "life" ||
    (isValidCalendarDate(effectiveExpiry) && effectiveExpiry.toISOString().slice(0, 10) >= today);

  const marketplaceEligible =
    licenceVerified && approved && this.accountStatus === "active" && licenceCurrent;

  if (!marketplaceEligible && this.marketplaceStatus === "visible") {
    this.marketplaceStatus = "hidden";
  }

  // ───────────────────────── AVAILABILITY ─────────────────────────

  validateAvailability(this);
});

// ───────────────────────── QUERY UPDATE PROTECTION ─────────────────────────

/*
 * Trusted services must use document save() for
 * verification, approval, account and availability changes.
 *
 * Operational query updates remain available for permitted
 * counters, reputation summaries and other ordinary fields.
 *
 * Schema middleware is not a substitute for authorisation.
 */

function assertSafeProfileUpdate(update, options = {}, operation) {
  if (
    !update ||
    typeof update !== "object" ||
    Array.isArray(update) ||
    options.overwrite === true ||
    options.upsert === true ||
    ["replaceOne", "findOneAndReplace"].includes(operation)
  ) {
    throw new Error(
      "Professional profile replacement and upsert operations are unsupported; use document save()."
    );
  }

  const allowedOperators = new Set([
    "$set",
    "$unset",
    "$inc",
    "$min",
    "$max",
    "$currentDate",
    "$setOnInsert",
    "$addToSet",
    "$pull",
    "$push",
  ]);

  for (const [operator, values] of Object.entries(update)) {
    if (!allowedOperators.has(operator)) {
      throw new Error("Only explicitly supported atomic profile updates are allowed.");
    }

    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Invalid professional profile update structure.");
    }

    for (const [path, value] of Object.entries(values)) {
      const root = String(path).split(".")[0];

      if (root === "__v") {
        if (path !== "__v" || operator !== "$inc" || value !== 1) {
          throw new Error(
            "Only an atomic increment of one is permitted for profile version locks."
          );
        }

        continue;
      }

      if (PROTECTED_QUERY_PATHS.has(root)) {
        throw new Error(
          "Protected professional verification, approval, availability and account fields require document save()."
        );
      }
    }
  }
}

function assertSafeProfileBulkWrite(operations) {
  if (!Array.isArray(operations)) {
    throw new TypeError("Professional profile bulk operations must be an array.");
  }

  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new Error("Invalid professional profile bulk operation.");
    }

    if (operation.updateOne) {
      assertSafeProfileUpdate(operation.updateOne.update, operation.updateOne, "updateOne");
    } else if (operation.updateMany) {
      assertSafeProfileUpdate(operation.updateMany.update, operation.updateMany, "updateMany");
    } else {
      throw new Error(
        "Only validated updateOne and updateMany profile bulk operations are allowed."
      );
    }
  }
}

professionalProfileSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"],
  function () {
    assertSafeProfileUpdate(this.getUpdate(), this.getOptions(), this.op);
  }
);

// ───────────────────────── SAFE SERIALISATION ─────────────────────────

professionalProfileSchema.set("toJSON", {
  transform(_document, result) {
    delete result.licenceDocumentUrl;
    delete result.licencePendingDocumentUrl;
    delete result.licenceNameOnRecord;
    delete result.upcomingLicence;

    if (result.bvnVerification) {
      delete result.bvnVerification.providerReference;
      delete result.bvnVerification.last4;
    }

    for (const certification of result.certifications || []) {
      delete certification.documentUrl;
    }

    return result;
  },
});

// ───────────────────────── EXPORT ─────────────────────────

const ProfessionalProfile = mongoose.model("ProfessionalProfile", professionalProfileSchema);

// Some Mongoose versions do not execute bulkWrite middleware.
// Guard the model API directly to prevent bulk-write bypasses.
const originalBulkWrite = ProfessionalProfile.bulkWrite;

ProfessionalProfile.bulkWrite = function guardedBulkWrite(operations, ...args) {
  assertSafeProfileBulkWrite(operations);

  return originalBulkWrite.call(this, operations, ...args);
};

module.exports = ProfessionalProfile;
