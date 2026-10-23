// models/ProfessionalProfile.js

const mongoose = require("mongoose");

/**
 * PROFESSIONAL PROFILE ARCHITECTURE
 *
 * Stores the professional's profile, verification summaries,
 * location, availability, reputation, marketplace visibility,
 * approval status, and operational activity.
 *
 * VERIFICATION RESPONSIBILITIES
 *
 * ProfessionalProfile stores verification summaries.
 * KYCVerification stores individual verification records.
 * ProfessionalVerificationService owns verification transitions.
 *
 * Identity, professional licence, payout KYC, platform approval,
 * and marketplace visibility remain separate states.
 *
 * ONE-TIME VERIFICATION POLICY
 *
 * Identity and professional licence verification are one-time.
 *
 * A verified identity does not require periodic re-verification.
 *
 * A verified professional licence does not require annual,
 * periodic, or expiry-driven re-verification.
 *
 * A change to the professional's licence number requires:
 *
 * - Resetting existing licence verification;
 * - Fresh verification of the new licence number;
 * - Resetting professional platform approval; and
 * - Subsequent administrative approval.
 *
 * A licence number change does not invalidate identity verification.
 *
 * licenceExpiryDate remains available as informational metadata.
 * It must not trigger automatic verification expiry or renewal.
 *
 * MARKETPLACE ELIGIBILITY
 *
 * Marketplace visibility requires:
 *
 * - Verified identity;
 * - Verified professional licence;
 * - Approved professional account; and
 * - Active account status.
 *
 * Meeting these requirements does not automatically set
 * marketplaceStatus to visible.
 *
 * Hidden and paused preferences must be preserved.
 *
 * FINANCIAL POLICY
 *
 * Loqum's platform fees are paid by employers.
 * Professionals receive their agreed or approved pay.
 *
 * Payout accounts are managed by BankAccount.
 * Wallet balances are managed by Wallet.
 *
 * DATA PROTECTION
 *
 * Never store raw NIN/BVN values in this profile.
 * Detailed verification evidence belongs in KYCVerification.
 */

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

const professionalProfileSchema = new mongoose.Schema(
  {
    // ───────────────────────── IDENTITY ─────────────────────────

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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

        // Coordinates use [longitude, latitude].
        validate: {
          validator: function (value) {
            if (!Array.isArray(value) || value.length !== 2) {
              return false;
            }

            const [lng, lat] = value;

            return (
              Number.isFinite(lng) &&
              Number.isFinite(lat) &&
              lng >= -180 &&
              lng <= 180 &&
              lat >= -90 &&
              lat <= 90
            );
          },

          message: "Coordinates must be [longitude, latitude] with valid ranges.",
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

      // Examples: PCN, NMCN, MDCN, MLSCN, RRBN.
    },

    licenceVerificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: "pending",
    },

    licenceVerificationMethod: {
      type: String,
      enum: ["manual", "api", "provider", "not_checked"],
      default: "not_checked",
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

    /*
     * Informational field only.
     *
     * Its date must not automatically invalidate
     * a previously verified licence.
     */

    licenceExpiryDate: {
      type: Date,
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

    /*
     * Certification validity is separate from
     * Loqum's one-time professional licence
     * verification policy.
     *
     * Certification expiry dates remain available
     * for their respective certification records.
     */

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

    // ───────────────────────── IDENTITY VERIFICATION ─────────────────────────

    identityVerificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: "pending",
    },

    identityVerificationMethod: {
      type: String,
      enum: ["manual", "provider", "not_checked"],
      default: "not_checked",
    },

    identityVerificationSource: {
      type: String,
      enum: ["government_id", "nin", "bvn", "selfie_match", "internal_review"],
      default: "internal_review",
    },

    identityNameOnDocument: {
      type: String,
      trim: true,
      default: null,
    },

    identityDocumentType: {
      type: String,
      enum: [
        "nin_slip",
        "national_id",
        "passport",
        "drivers_license",
        "voters_card",
        "other",
        null,
      ],
      default: null,
    },

    identityDocumentUrl: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    identityVerifiedAt: {
      type: Date,
      default: null,
    },

    identityLastCheckedAt: {
      type: Date,
      default: null,
    },

    identityVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    identityVerificationNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    // ───────────────────────── BVN / KYC SUMMARY ─────────────────────────

    /*
     * Full verification records belong in KYCVerification.
     *
     * This object is a profile-level summary for
     * payout readiness and identity-related workflows.
     *
     * Registry matching alone must not set status
     * to verified unless the domain's requirements
     * for that particular verification are satisfied.
     */

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

      /*
       * Only use a genuine provider-issued ID.
       *
       * Internal request references must not
       * be copied into this field.
       */

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
      enum: ["available", "unavailable", "busy", "paused"],
      default: "available",
    },

    /*
     * NEW: AVAILABILITY MODE
     *
     * weekly: Regularly available days of the week.
     * dates: Specific selected calendar dates.
     *
     * Default null preserves compatibility with existing
     * professional profiles until a mode is selected.
     *
     * The profile service will determine the appropriate
     * initial display mode.
     */

    availabilityMode: {
      type: String,
      enum: ["weekly", "dates"],
      default: null,
    },

    /*
     * NEW: RECURRING WEEKDAY PREFERENCES
     *
     * ISO weekday numbering:
     *
     * Monday    = 1
     * Tuesday   = 2
     * Wednesday = 3
     * Thursday  = 4
     * Friday    = 5
     * Saturday  = 6
     * Sunday    = 7
     *
     * These are availability preferences, not guaranteed
     * shift assignments or automatic booking rules.
     *
     * The profile service will validate and normalise
     * submitted selections before saving them.
     */

    availableWeekdays: {
      type: [
        {
          type: Number,
          enum: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
      default: [],
    },

    /*
     * Existing specific-date preferences.
     *
     * Retained for professionals who prefer selecting
     * individual dates instead of weekly weekdays.
     */

    availableDates: [
      {
        type: Date,
      },
    ],

    availabilityNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    // ───────────────────────── FINANCIAL SUMMARY ─────────────────────────

    /*
     * Payout account: BankAccount.
     * Wallet balance: Wallet.
     *
     * Professionals do not pay Loqum's
     * platform commission at launch.
     */

    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ───────────────────────── TIER ─────────────────────────

    /*
     * Tier is periodically evaluated using
     * professional performance metrics.
     *
     * Tier influences trust, visibility and
     * active shift limits.
     *
     * It does not determine a pharmacist-side
     * platform commission.
     */

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
      enum: ["active", "restricted", "suspended"],
      default: "active",
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

    // ───────────────────────── MARKETPLACE VISIBILITY ─────────────────────────

    marketplaceStatus: {
      type: String,
      enum: ["hidden", "visible", "paused"],
      default: "hidden",
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

    /*
     * Final approval is performed through the
     * professional verification/administration
     * service after required checks are satisfied.
     *
     * Approval alone does not make the professional
     * visible in the marketplace.
     */

    professionalApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", "restricted", "needs_review"],
      default: "pending",
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
  }
);

// ───────────────────────── INDEXES ─────────────────────────

professionalProfileSchema.index({ user: 1 }, { unique: true });

professionalProfileSchema.index({
  type: 1,
});

professionalProfileSchema.index({
  specialty: 1,
});

professionalProfileSchema.index({
  tier: 1,
});

professionalProfileSchema.index({
  accountStatus: 1,
});

professionalProfileSchema.index({
  marketplaceStatus: 1,
});

professionalProfileSchema.index({
  availabilityStatus: 1,
});

professionalProfileSchema.index({
  averageRating: -1,
});

professionalProfileSchema.index({
  reliabilityScore: -1,
});

professionalProfileSchema.index({
  state: 1,
  lga: 1,
});

professionalProfileSchema.index({
  location: "2dsphere",
});

professionalProfileSchema.index(
  {
    type: 1,
    licenceNumber: 1,
  },
  {
    unique: true,
  }
);

professionalProfileSchema.index({
  licenceVerificationStatus: 1,
});

professionalProfileSchema.index({
  identityVerificationStatus: 1,
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

// ───────────────────────── VALIDATION / AUTO-CLEANUP ─────────────────────────

professionalProfileSchema.pre("validate", function () {
  /*
   * STRIKE TOTAL
   *
   * Maintain the total strike count from
   * its component values.
   */

  if (this.strikes) {
    const noShows = Number(this.strikes.noShows || 0);
    const lateArrivals = Number(this.strikes.lateArrivals || 0);
    const earlyDepartures = Number(this.strikes.earlyDepartures || 0);

    this.strikes.total = noShows + lateArrivals + earlyDepartures;
  }

  /*
   * LICENCE NUMBER CHANGE
   *
   * A change to licenceNumber invalidates
   * the previous licence verification.
   *
   * It also invalidates the previous platform
   * approval and hides the professional.
   *
   * Identity verification remains unchanged.
   *
   * This is a defensive document-save safeguard.
   * ProfessionalVerificationService remains
   * responsible for the authoritative transition
   * and corresponding KYC audit records.
   */

  if (!this.isNew && this.isModified("licenceNumber")) {
    this.licenceVerificationStatus = "pending";

    this.licenceVerificationMethod = "not_checked";
    this.licenceVerificationSource = "not_checked";

    this.licenceNameOnRecord = null;
    this.licenceDocumentUrl = null;

    this.licenceExpiryDate = null;
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

  /*
   * ONE-TIME VERIFICATION POLICY
   *
   * Licence verification is determined by its
   * recorded verification status.
   *
   * licenceExpiryDate does not automatically
   * invalidate a completed verification.
   */

  const hasVerifiedLicence = this.licenceVerificationStatus === "verified";

  const hasVerifiedIdentity = this.identityVerificationStatus === "verified";

  const hasCoreVerification = hasVerifiedLicence && hasVerifiedIdentity;

  const isApproved = this.professionalApprovalStatus === "approved";

  const accountActive = this.accountStatus === "active";

  /*
   * Preserve existing approval timestamp behavior.
   *
   * This is not an authorization decision.
   * Administrative approval must be granted
   * through the appropriate service.
   */

  if (isApproved && !this.approvedForShiftsAt) {
    this.approvedForShiftsAt = new Date();
  }

  /*
   * MARKETPLACE SAFETY
   *
   * Marketplace eligibility requires:
   *
   * - Verified identity;
   * - Verified licence;
   * - Approved professional status;
   * - Active account.
   *
   * Do not require an unexpired licenceExpiryDate
   * because licence verification is one-time.
   *
   * Do not automatically activate visibility.
   *
   * Preserve hidden/paused preferences when
   * the professional is eligible.
   */

  const canRemainMarketplaceEligible = isApproved && accountActive && hasCoreVerification;

  if (!canRemainMarketplaceEligible) {
    this.marketplaceStatus = "hidden";
  }
});

// ───────────────────────── EXPORT ─────────────────────────

module.exports = mongoose.model("ProfessionalProfile", professionalProfileSchema);
