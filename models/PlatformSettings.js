// models/PlatformSettings.js

const mongoose = require("mongoose");

const {
  nonNegativeIntegerField,
  requiredPositiveSafeIntegerField,
  requiredPositiveMinorUnitAmountField,
} = require("./helpers/schemaFields");

const { FINANCIAL_RATE_SCALE } = require("../constants/shiftPosting");

const money = require("../utils/money");

const FACILITY_TYPES = ["pharmacy", "clinic", "hospital", "laboratory"];

const MAX_OCCURRENCES_PER_PARENT_SHIFT = 30;

const normalizeCodeList = (values, fallback) => {
  if (!Array.isArray(values)) {
    return fallback;
  }

  return [...new Set(values.map((value) => String(value).toUpperCase().trim()).filter(Boolean))];
};

const isSupportedFinancialRate = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return false;
  }

  try {
    money.scaleRate({
      rate: value,
      rateScale: FINANCIAL_RATE_SCALE,
      fieldName: "Financial rate",
    });

    return true;
  } catch (error) {
    return false;
  }
};

/**
 * PLATFORM SETTINGS MODEL
 *
 * Stores Loqum's global and country-specific rules. Only one global settings
 * document should exist.
 *
 * FINANCIAL AND PROTECTED SHIFT RULES:
 *
 * - Employers pay approved professional pay plus the employer-side platform fee.
 * - Professionals pay no commission at launch.
 * - Pricing and the resolved platformFeeRate are snapshotted when a Shift is posted.
 * - Financial percentage rates that create money must be exactly representable
 *   at FINANCIAL_RATE_SCALE before they may enter active settings.
 * - Shifts remain pending_funding and unpublished until the full engagement
 *   charge is secured through the employer wallet or Paystack.
 * - No additional payment is required when a professional is accepted.
 *
 * Protected Shift exposure limits apply only to funded, published and initially
 * unassigned parent Shifts that still contain fillable occurrences.
 * Replacement hiring does not create new initial exposure.
 *
 * Exposure reduces as occurrences are assigned, cancelled, expire unfilled or
 * become refund-eligible. Facility policies are centrally configured, with no
 * employer-specific or branch-specific overrides.
 *
 * COUNTRY SETTINGS:
 *
 * Active countrySettings entries are the preferred source for currency,
 * platform fees, external employer top-up limits, withdrawal limits, and
 * facility-based Protected Shift limits.
 *
 * Monetary limits are stored in currency minor units. Global fee, external
 * top-up and withdrawal fields remain fallbacks for existing services.
 *
 * ATTENDANCE:
 *
 * checkInWindowBeforeMinutes controls professional check-in availability, not
 * employer PIN visibility. Attendance remains subject to assignment, occurrence
 * state, geofence, location accuracy and PIN-use rules.
 *
 * noShowGraceMinutes is measured from occurrence startTime, or from assignedAt
 * when assignment occurs after startTime.
 *
 * SINGLE-OCCURRENCE PROFESSIONAL RELEASE:
 *
 * singleOccurrenceReleaseNoticeHours defines the normal notice threshold for a
 * professional releasing one future occurrence while remaining assigned to the
 * rest of the Shift.
 *
 * The default threshold is 72 hours before occurrence startTime.
 *
 * This setting does not block a release inside the threshold. A late release is
 * still accepted so Loqum can immediately attempt replacement hiring instead of
 * learning about the absence only after a no-show.
 *
 * Whether a release was inside or outside the configured threshold is derived
 * from the occurrence startTime, the release timestamp and this setting. A
 * separate stored lateRelease boolean is unnecessary.
 *
 * Once the occurrence has started, it is no longer eligible for ordinary
 * professional release and the attendance/no-show lifecycle applies instead.
 *
 * PROFESSIONAL SETTLEMENT PAYOUTS:
 *
 * Professional earnings are released on the configured weekly payout schedule.
 *
 * professionalSettlementPayoutWeekday, professionalSettlementPayoutHour,
 * professionalSettlementPayoutMinute and professionalSettlementPayoutTimeZone
 * define that payout boundary.
 *
 * Base earnings and approved overtime are independently releasable settlement
 * components. They use the same payout calendar but may enter different weekly
 * batches when they become release-ready at different times.
 *
 * An active occurrence claim or dispute blocks only the settlement component(s)
 * financially affected by that challenge. An undisputed component may continue
 * through the normal payout schedule.
 *
 * UNFILLED OCCURRENCES:
 *
 * Each ShiftOccurrence has a fillCutoffAt marking the final time it may be
 * assigned. After the cutoff, it leaves the marketplace and may become
 * expired_unfilled and refund-eligible.
 *
 * unfilledFinalizationGraceMinutes delays finalisation after fillCutoffAt to
 * prevent race conditions. It does not extend marketplace visibility or act as
 * an occurrence challenge window.
 *
 * An expired-unfilled occurrence has no assigned professional and does not open
 * an occurrence challenge window. Once finalised, its full funded occurrence
 * charge may become refund-eligible immediately.
 *
 * A multi-occurrence parent remains visible while at least one occurrence is
 * still fillable.
 *
 * OCCURRENCE CHALLENGES:
 *
 * occurrenceClaimWindowHours retains its existing field name for compatibility,
 * but controls the shared occurrence challenge window.
 *
 * During that window:
 *
 * - the assigned professional may submit one original ShiftOccurrenceClaim; and
 * - the employer may submit one original ShiftOccurrenceDispute when the
 *   submitted cases concern genuinely different issues/components.
 *
 * Claim or dispute submission does not close the shared challenge clock early.
 * The original time opportunity remains governed by challengeDeadlineAt.
 *
 * At or after challengeDeadlineAt, no new original occurrence challenge may be
 * created.
 *
 * The shared challenge window applies only to assigned and contestable outcomes,
 * such as:
 *
 * - confirmed no-show;
 * - missed check-in or disputed attendance;
 * - employer cancellation;
 * - active-work cancellation;
 * - disputed worked hours;
 * - overtime facts; and
 * - payment calculation.
 *
 * It does not apply to:
 *
 * - expired-unfilled occurrences;
 * - unassigned cancellations; or
 * - unfunded occurrences.
 *
 * ABSENCE EXPLANATIONS:
 *
 * An absence explanation is not a claim or dispute.
 *
 * It records why a professional did not attend after Loqum has already
 * determined that the occurrence was a no-show.
 *
 * It cannot create professional payment, does not require employer approval,
 * does not require admin adjudication and does not independently hold an
 * employer refund.
 *
 * If the professional says they actually worked and the attendance record is
 * wrong, the professional must use the ordinary Report issue flow and submit an
 * attendance_correction claim instead.
 *
 * PROFESSIONAL CLAIM REVIEW:
 *
 * Every accepted original professional occurrence claim is reviewed by the
 * employer first.
 *
 * employerClaimResponseHours controls the employer's response period after an
 * accepted ShiftOccurrenceClaim is submitted.
 *
 * Employer non-response escalates the professional claim for admin review. It
 * does not automatically reject the professional's claim.
 *
 * professionalAppealWindowHours controls the professional's single appeal
 * period after the employer rejects an occurrence claim issue without
 * introducing an adverse counter-position.
 *
 * professionalRebuttalWindowHours controls the professional's optional
 * rebuttal period after the employer rejects an occurrence claim issue and
 * introduces a different factual or financial position.
 *
 * If the professional does not rebut before that deadline, the issue still
 * proceeds to admin adjudication. Professional silence does not make the
 * employer's counter-position authoritative.
 *
 * EMPLOYER DISPUTE REVIEW:
 *
 * A ShiftOccurrenceDispute is raised by the employer and is not adjudicated by
 * the employer.
 *
 * professionalDisputeResponseHours controls the professional's single response
 * period after an employer occurrence dispute is submitted.
 *
 * If the professional responds before the deadline, the dispute proceeds to
 * admin review with that response.
 *
 * If the professional does not respond before the deadline, the dispute still
 * proceeds to admin review with the employer's submitted evidence and the
 * authoritative system records.
 *
 * The resulting exact deadlines are stored on ShiftOccurrenceClaim or
 * ShiftOccurrenceDispute so later changes to PlatformSettings do not alter an
 * already-open workflow.
 *
 * CANCELLATION AND ACTIVE WORK SETTLEMENT:
 *
 * Cancellation rules are snapshotted into each Shift.
 *
 * - Cancellation outside the protected window creates no automatic compensation.
 * - Cancellation inside the window before check-in pays the configured percentage.
 * - Employer cancellation after check-in pays the greater of approved worked pay
 *   or the configured minimum percentage.
 *
 * The cancellation window applies independently to each occurrence.
 *
 * Professional-initiated release or departure does not automatically trigger
 * employer-cancellation compensation.
 *
 * Where employer fault or another financial fact is challenged, the affected
 * settlement and refund may be held pending the applicable claim or dispute
 * resolution.
 *
 * CREDITS:
 *
 * Credits remain disabled until deliberately activated.
 */

/* ─────────────────────────────── PROTECTED SHIFT LIMITS ─────────────────────────────── */

const protectedShiftFacilityPolicySchema = new mongoose.Schema(
  {
    maxOccurrencesPerParentShift: requiredPositiveSafeIntegerField({
      label: "maxOccurrencesPerParentShift",
      maximum: MAX_OCCURRENCES_PER_PARENT_SHIFT,
    }),

    maxOpenFundedUnassignedParentsPerBranch: requiredPositiveSafeIntegerField({
      label: "maxOpenFundedUnassignedParentsPerBranch",
    }),

    maxOpenFundedUnassignedAmountMinorPerBranch: requiredPositiveMinorUnitAmountField(
      "maxOpenFundedUnassignedAmountMinorPerBranch"
    ),

    maxOpenFundedUnassignedAmountMinorPerBusiness: requiredPositiveMinorUnitAmountField(
      "maxOpenFundedUnassignedAmountMinorPerBusiness"
    ),

    maxAdvanceBookingDays: requiredPositiveSafeIntegerField({
      label: "maxAdvanceBookingDays",
    }),
  },
  {
    _id: false,
  }
);

protectedShiftFacilityPolicySchema.pre("validate", function validateProtectedShiftFacilityPolicy() {
  if (
    this.maxOpenFundedUnassignedAmountMinorPerBranch >
    this.maxOpenFundedUnassignedAmountMinorPerBusiness
  ) {
    this.invalidate(
      "maxOpenFundedUnassignedAmountMinorPerBusiness",
      "The business funded-unassigned amount limit cannot be lower than the branch limit."
    );
  }
});

const protectedShiftLimitsSchema = new mongoose.Schema(
  {
    pharmacy: {
      type: protectedShiftFacilityPolicySchema,
      required: true,
    },

    clinic: {
      type: protectedShiftFacilityPolicySchema,
      required: true,
    },

    hospital: {
      type: protectedShiftFacilityPolicySchema,
      required: true,
    },

    laboratory: {
      type: protectedShiftFacilityPolicySchema,
      required: true,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── COUNTRY SETTINGS ─────────────────────────────── */

const countrySettingSchema = new mongoose.Schema(
  {
    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "countryCode must be a valid two-letter country code."],
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "currency must be a valid three-letter currency code."],
    },

    platformFeeRate: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
      validate: {
        validator: isSupportedFinancialRate,
        message: "countrySettings.platformFeeRate must use the supported financial rate precision.",
      },
    },

    maximumEmployerWalletExternalTopupBalance: requiredPositiveMinorUnitAmountField(
      "maximumEmployerWalletExternalTopupBalance"
    ),

    minimumEmployerWithdrawalAmount: requiredPositiveMinorUnitAmountField(
      "minimumEmployerWithdrawalAmount"
    ),

    minimumProfessionalWithdrawalAmount: requiredPositiveMinorUnitAmountField(
      "minimumProfessionalWithdrawalAmount"
    ),

    protectedShiftLimits: {
      type: protectedShiftLimitsSchema,
      required: true,
    },

    isActive: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── CANCELLATION POLICY ─────────────────────────────── */

const shiftCancellationPolicySchema = new mongoose.Schema(
  {
    lateCancellationWindowMinutes: {
      type: Number,
      default: 30,
      min: 0,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "shiftCancellationPolicy.lateCancellationWindowMinutes must be a whole number.",
      },
    },

    lateCancellationProfessionalPayRate: {
      type: Number,
      default: 0.25,
      min: 0,
      max: 1,
      required: true,
      validate: {
        validator: isSupportedFinancialRate,
        message:
          "shiftCancellationPolicy.lateCancellationProfessionalPayRate must use the supported financial rate precision.",
      },
    },

    activeWorkCancellationMinimumPayRate: {
      type: Number,
      default: 0.25,
      min: 0,
      max: 1,
      required: true,
      validate: {
        validator: isSupportedFinancialRate,
        message:
          "shiftCancellationPolicy.activeWorkCancellationMinimumPayRate must use the supported financial rate precision.",
      },
    },
  },
  {
    _id: false,
  }
);

/* ─────────────────────────────── PLATFORM SETTINGS ─────────────────────────────── */

const platformSettingsSchema = new mongoose.Schema(
  {
    // --- IDENTITY ---

    key: {
      type: String,
      enum: ["global"],
      default: "global",
      required: true,
      immutable: true,
    },

    defaultCountryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{2}$/, "defaultCountryCode must be a valid two-letter country code."],
    },

    defaultCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "defaultCurrency must be a valid three-letter currency code."],
    },

    activeCountryCodes: {
      type: [String],
      required: true,
      default: undefined,
      set: (countryCodes) => normalizeCodeList(countryCodes, []),
      validate: {
        validator: (countryCodes) =>
          Array.isArray(countryCodes) &&
          countryCodes.length > 0 &&
          countryCodes.every((countryCode) => /^[A-Z]{2}$/.test(countryCode)),
        message: "At least one valid active two-letter country code is required.",
      },
    },

    supportedCurrencies: {
      type: [String],
      required: true,
      default: undefined,
      set: (currencies) => normalizeCodeList(currencies, []),
      validate: {
        validator: (currencies) =>
          Array.isArray(currencies) &&
          currencies.length > 0 &&
          currencies.every((currency) => /^[A-Z]{3}$/.test(currency)),
        message: "At least one valid supported three-letter currency code is required.",
      },
    },

    countrySettings: {
      type: [countrySettingSchema],
      required: true,
      default: undefined,
      validate: {
        validator: (settings) => Array.isArray(settings) && settings.length > 0,
        message: "At least one country setting is required.",
      },
    },

    // --- PLATFORM FEE FALLBACK ---

    platformFeeRate: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
      validate: {
        validator: isSupportedFinancialRate,
        message: "platformFeeRate must use the supported financial rate precision.",
      },
    },

    // --- WALLET TOP-UP AND WITHDRAWAL FALLBACKS ---

    maximumEmployerWalletExternalTopupBalance: requiredPositiveMinorUnitAmountField(
      "maximumEmployerWalletExternalTopupBalance"
    ),

    minimumEmployerWithdrawalAmount: requiredPositiveMinorUnitAmountField(
      "minimumEmployerWithdrawalAmount"
    ),

    minimumProfessionalWithdrawalAmount: requiredPositiveMinorUnitAmountField(
      "minimumProfessionalWithdrawalAmount"
    ),

    // --- OVERTIME RULES ---

    overtimeResponseHours: requiredPositiveSafeIntegerField({
      label: "overtimeResponseHours",
      defaultValue: 24,
    }),
    // Time given to the employer to approve or reject a professional's
    // overtime request.
    //
    // Employer non-response does not approve or reject overtime.
    // Once this deadline expires, the overtime request requires admin review.

    overtimeTopUpDeadlineHours: requiredPositiveSafeIntegerField({
      label: "overtimeTopUpDeadlineHours",
      defaultValue: 24,
    }),
    // Payment deadline after approved overtime creates an additional employer
    // funding obligation.
    //
    // Missing this deadline does not reverse approved overtime. The professional's
    // approved entitlement remains owed.

    overtimeTopUpRestrictionGraceHours: requiredPositiveSafeIntegerField({
      label: "overtimeTopUpRestrictionGraceHours",
      defaultValue: 72,
    }),
    // Grace period after an approved overtime top-up becomes overdue.
    //
    // During this period, Loqum warns and reminds the employer to pay.
    //
    // If the amount remains unpaid when this grace period expires, employer
    // payment-delinquency restrictions may begin, including blocking:
    // - posting new Shifts; and
    // - creating new hiring obligations.
    //
    // Existing engagements, payment of the outstanding obligation, wallet access,
    // and other necessary account operations are not blocked merely because this
    // grace period expired.

    // --- PROFESSIONAL SETTLEMENT PAYOUT RULES ---

    professionalSettlementPayoutWeekday: {
      type: Number,
      required: true,
      default: 1,
      min: 0,
      max: 6,
      validate: {
        validator: Number.isSafeInteger,
        message: "professionalSettlementPayoutWeekday must be a whole number from 0 to 6.",
      },
    },

    professionalSettlementPayoutHour: {
      type: Number,
      required: true,
      default: 9,
      min: 0,
      max: 23,
      validate: {
        validator: Number.isSafeInteger,
        message: "professionalSettlementPayoutHour must be a whole number from 0 to 23.",
      },
    },

    professionalSettlementPayoutMinute: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 59,
      validate: {
        validator: Number.isSafeInteger,
        message: "professionalSettlementPayoutMinute must be a whole number from 0 to 59.",
      },
    },

    professionalSettlementPayoutTimeZone: {
      type: String,
      required: true,
      trim: true,
      default: "Africa/Lagos",
      validate: {
        validator(value) {
          try {
            new Intl.DateTimeFormat("en-US", {
              timeZone: value,
            }).format();

            return true;
          } catch {
            return false;
          }
        },
        message: "professionalSettlementPayoutTimeZone must be a valid IANA time zone.",
      },
    },
    // These values determine the weekly payout boundary used when a professional
    // settlement component becomes approved_for_release.
    //
    // Base and overtime components use the same payout calendar, but they may
    // become eligible in different weeks and therefore enter different batches.

    // --- SHIFT ATTENDANCE RULES ---

    checkInWindowBeforeMinutes: nonNegativeIntegerField({
      required: true,
      defaultValue: 30,
    }),
    // Controls how early an assigned professional may attempt check-in.
    //
    // It does not control when an authorised employer may retrieve attendance
    // PINs.

    noShowGraceMinutes: nonNegativeIntegerField({
      required: true,
      defaultValue: 30,
    }),
    // For an assignment created before occurrence start, this is measured
    // from startTime.
    //
    // For an assignment created after occurrence start, this is measured
    // from assignedAt and capped at occurrence endTime.

    // --- SINGLE-OCCURRENCE RELEASE RULES ---

    singleOccurrenceReleaseNoticeHours: nonNegativeIntegerField({
      required: true,
      defaultValue: 72,
    }),
    // Defines the normal notice threshold for an assigned professional
    // releasing one future occurrence while remaining assigned to the rest
    // of the Shift.
    //
    // A release submitted at least this many hours before startTime is normal
    // notice.
    //
    // A release submitted inside this threshold is late notice, but it is
    // still accepted.
    //
    // The service must immediately place the released occurrence into
    // replacement_required and attempt marketplace repopulation.
    //
    // Once startTime has been reached, ordinary occurrence release is no
    // longer available and attendance/no-show rules apply.
    //
    // No penalty or reliability consequence is configured here yet.

    // --- UNFILLED OCCURRENCE RULES ---

    unfilledFinalizationGraceMinutes: requiredPositiveSafeIntegerField({
      label: "unfilledFinalizationGraceMinutes",
      defaultValue: 15,
    }),
    // An unassigned or replacement-required occurrence may become
    // expired_unfilled after:
    //
    // fillCutoffAt + unfilledFinalizationGraceMinutes.
    //
    // Marketplace visibility ends at fillCutoffAt.
    //
    // This delay protects against assignment acceptance, webhook and
    // reconciliation operations racing with finalisation.
    //
    // It is a technical grace period, not an occurrence challenge window.

    // --- OCCURRENCE CHALLENGE RULES ---

    occurrenceClaimWindowHours: requiredPositiveSafeIntegerField({
      label: "occurrenceClaimWindowHours",
      defaultValue: 24,
    }),
    // Retains its existing field name for compatibility, but controls the
    // shared original occurrence challenge window.
    //
    // During this window:
    //
    // - the professional may submit one original ShiftOccurrenceClaim; and
    // - the employer may submit one original ShiftOccurrenceDispute when the
    //   two cases concern genuinely different issues/components.
    //
    // Submitting either case does not close the shared clock early.
    //
    // New original challenge submissions must be made before the occurrence's
    // challengeDeadlineAt.
    //
    // This does not apply to expired-unfilled occurrences, unassigned
    // cancellations or unfunded occurrences.

    employerClaimResponseHours: requiredPositiveSafeIntegerField({
      label: "employerClaimResponseHours",
      defaultValue: 24,
    }),
    // Controls how long the employer has to respond to a professional-originated
    // financial occurrence claim.
    //
    // Employer non-response escalates the claim to admin review.
    // It does not approve or reject the professional's claim.

    professionalDisputeResponseHours: requiredPositiveSafeIntegerField({
      label: "professionalDisputeResponseHours",
      defaultValue: 24,
    }),
    // Controls how long the professional has to respond to an employer-originated
    // occurrence dispute.
    //
    // Professional non-response does not mean the employer wins.
    // Once the deadline expires, the dispute proceeds to admin review using the
    // evidence already available.

    professionalAppealWindowHours: requiredPositiveSafeIntegerField({
      label: "professionalAppealWindowHours",
      defaultValue: 12,
    }),
    // Controls the professional's single appeal period after the employer
    // rejects an occurrence claim.
    //
    // The exact appealDeadlineAt is stored on ShiftOccurrenceClaim.
    //
    // No second appeal is available after the final admin decision.

    professionalRebuttalWindowHours: requiredPositiveSafeIntegerField({
      label: "professionalRebuttalWindowHours",
      defaultValue: 12,
    }),
    // Controls the professional's single rebuttal period after the employer
    // rejects a claim issue and submits an adverse counter-position.
    //
    // The professional may submit a rebuttal before the exact
    // rebuttalDeadlineAt stored on ShiftOccurrenceClaim.
    //
    // If the professional does not rebut before the deadline, the rebuttal
    // expires and the issue still proceeds to admin adjudication.
    //
    // Professional silence does not make the employer's counter-position
    // authoritative.

    // --- LOCATION RULES ---

    defaultGeofenceRadiusMeters: {
      type: Number,
      default: 100,
      min: 20,
      max: 1000,
      validate: {
        validator: Number.isSafeInteger,
        message: "defaultGeofenceRadiusMeters must be a whole number.",
      },
    },

    minimumGeofenceRadiusMeters: {
      type: Number,
      default: 20,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "minimumGeofenceRadiusMeters must be a whole number.",
      },
    },

    maximumGeofenceRadiusMeters: {
      type: Number,
      default: 1000,
      min: 20,
      validate: {
        validator: Number.isSafeInteger,
        message: "maximumGeofenceRadiusMeters must be a whole number.",
      },
    },

    maximumLocationAccuracyMeters: nonNegativeIntegerField({
      required: true,
      defaultValue: 100,
    }),

    // --- CANCELLATION RULES ---

    shiftCancellationPolicy: {
      type: shiftCancellationPolicySchema,
      default: () => ({}),
      required: true,
    },

    // --- CREDITS, DORMANT FOR NOW ---

    creditsEnabled: {
      type: Boolean,
      default: false,
    },

    freeMonthlyCredits: nonNegativeIntegerField({
      defaultValue: 20,
    }),

    normalApplicationCreditCost: nonNegativeIntegerField({
      defaultValue: 1,
    }),

    urgentApplicationCreditCost: nonNegativeIntegerField({
      defaultValue: 2,
    }),

    boostApplicationCreditCost: nonNegativeIntegerField({
      defaultValue: 3,
    }),

    // --- STATUS AND AUDIT ---

    isActive: {
      type: Boolean,
      default: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* ─────────────────────────────── INSTANCE METHODS ─────────────────────────────── */

platformSettingsSchema.methods.getActiveCountrySetting = function getActiveCountrySetting(
  countryCode
) {
  const normalizedCountryCode = String(countryCode || this.defaultCountryCode)
    .toUpperCase()
    .trim();

  return this.countrySettings.find(
    (setting) => setting.countryCode === normalizedCountryCode && setting.isActive === true
  );
};

platformSettingsSchema.methods.getProtectedShiftLimits = function getProtectedShiftLimits({
  countryCode,
  facilityType,
}) {
  const normalizedFacilityType = String(facilityType || "")
    .toLowerCase()
    .trim();

  if (!FACILITY_TYPES.includes(normalizedFacilityType)) {
    throw new Error(`Unsupported facility type: ${normalizedFacilityType || "missing"}`);
  }

  const countrySetting = this.getActiveCountrySetting(countryCode);

  if (!countrySetting) {
    const normalizedCountryCode = String(countryCode || this.defaultCountryCode)
      .toUpperCase()
      .trim();

    throw new Error(`No active country setting exists for ${normalizedCountryCode}.`);
  }

  const limits = countrySetting.protectedShiftLimits?.[normalizedFacilityType];

  if (!limits) {
    throw new Error(`No Protected Shift limits exist for facility type ${normalizedFacilityType}.`);
  }

  return limits;
};

/* ─────────────────────────────── CROSS-FIELD VALIDATION ─────────────────────────────── */

platformSettingsSchema.pre("validate", function validatePlatformSettings() {
  const countrySettings = Array.isArray(this.countrySettings) ? this.countrySettings : [];

  const activeCountryCodes = Array.isArray(this.activeCountryCodes) ? this.activeCountryCodes : [];

  const supportedCurrencies = Array.isArray(this.supportedCurrencies)
    ? this.supportedCurrencies
    : [];

  const countryCodes = countrySettings.map((setting) =>
    String(setting.countryCode || "")
      .toUpperCase()
      .trim()
  );

  if (new Set(countryCodes).size !== countryCodes.length) {
    this.invalidate("countrySettings", "Each country code can have only one country setting.");
  }

  if (!activeCountryCodes.includes(this.defaultCountryCode)) {
    this.invalidate(
      "defaultCountryCode",
      "defaultCountryCode must be included in activeCountryCodes."
    );
  }

  if (!supportedCurrencies.includes(this.defaultCurrency)) {
    this.invalidate("defaultCurrency", "defaultCurrency must be included in supportedCurrencies.");
  }

  for (const countryCode of activeCountryCodes) {
    const activeCountrySetting = countrySettings.find(
      (setting) => setting.countryCode === countryCode && setting.isActive === true
    );

    if (!activeCountrySetting) {
      this.invalidate(
        "countrySettings",
        `Active country ${countryCode} must have an active country setting.`
      );
    }
  }

  for (const countrySetting of countrySettings) {
    if (countrySetting.isActive && !activeCountryCodes.includes(countrySetting.countryCode)) {
      this.invalidate(
        "activeCountryCodes",
        `Active country setting ${countrySetting.countryCode} must be included in activeCountryCodes.`
      );
    }

    if (countrySetting.isActive && !supportedCurrencies.includes(countrySetting.currency)) {
      this.invalidate(
        "supportedCurrencies",
        `Currency ${countrySetting.currency} must be included in supportedCurrencies when country ${countrySetting.countryCode} is active.`
      );
    }

    if (!countrySetting.protectedShiftLimits) {
      this.invalidate(
        "countrySettings",
        `Country ${countrySetting.countryCode} must have Protected Shift limits.`
      );

      continue;
    }

    for (const facilityType of FACILITY_TYPES) {
      const facilityPolicy = countrySetting.protectedShiftLimits[facilityType];

      if (!facilityPolicy) {
        this.invalidate(
          "countrySettings",
          `Country ${countrySetting.countryCode} must have a Protected Shift policy for ${facilityType}.`
        );
      }
    }
  }

  const defaultCountrySetting = countrySettings.find(
    (setting) => setting.countryCode === this.defaultCountryCode && setting.isActive === true
  );

  if (defaultCountrySetting) {
    this.platformFeeRate = defaultCountrySetting.platformFeeRate;

    this.maximumEmployerWalletExternalTopupBalance =
      defaultCountrySetting.maximumEmployerWalletExternalTopupBalance;

    this.minimumEmployerWithdrawalAmount = defaultCountrySetting.minimumEmployerWithdrawalAmount;

    this.minimumProfessionalWithdrawalAmount =
      defaultCountrySetting.minimumProfessionalWithdrawalAmount;
  }

  if (defaultCountrySetting && defaultCountrySetting.currency !== this.defaultCurrency) {
    this.invalidate(
      "defaultCurrency",
      "defaultCurrency must match the active default country setting."
    );
  }

  if (this.minimumGeofenceRadiusMeters > this.maximumGeofenceRadiusMeters) {
    this.invalidate(
      "minimumGeofenceRadiusMeters",
      "minimumGeofenceRadiusMeters cannot exceed maximumGeofenceRadiusMeters."
    );
  }

  if (
    this.defaultGeofenceRadiusMeters < this.minimumGeofenceRadiusMeters ||
    this.defaultGeofenceRadiusMeters > this.maximumGeofenceRadiusMeters
  ) {
    this.invalidate(
      "defaultGeofenceRadiusMeters",
      "defaultGeofenceRadiusMeters must be within the configured minimum and maximum geofence radii."
    );
  }
});

/* ─────────────────────────────── INDEXES ─────────────────────────────── */

platformSettingsSchema.index(
  {
    key: 1,
  },
  {
    unique: true,
  }
);

platformSettingsSchema.index({
  isActive: 1,
});

module.exports = mongoose.model("PlatformSettings", platformSettingsSchema);
