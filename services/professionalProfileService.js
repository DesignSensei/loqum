// services/professionalProfileService.js

const ProfessionalProfile = require("../models/ProfessionalProfile");
const { getProfessionalKycStatus } = require("../utils/statusHelper");

// ───────────────────────── CONSTANTS ─────────────────────────

const PROFILE_TABS = [
  {
    key: "overview",
    label: "Overview",
    icon: "ki-element-11",
  },
  {
    key: "personal-details",
    label: "Personal Details",
    icon: "ki-profile-circle",
  },
  {
    key: "professional-details",
    label: "Professional Details",
    icon: "ki-award",
  },
  {
    key: "verification",
    label: "Verification",
    icon: "ki-shield-tick",
  },
  {
    key: "availability",
    label: "Availability",
    icon: "ki-calendar-tick",
  },
  {
    key: "account-settings",
    label: "Account Settings",
    icon: "ki-setting-2",
  },
];

const PROFESSIONAL_TYPES = {
  pharmacist: "Pharmacist",
  pharmacy_technician: "Pharmacy Technician",
  nurse: "Nurse",
  doctor: "Doctor",
  lab_scientist: "Medical Laboratory Scientist",
  radiographer: "Radiographer",
  physiotherapist: "Physiotherapist",
};

const AVAILABILITY_STATUSES = [
  {
    value: "available",
    label: "Available for shifts",
  },
  {
    value: "unavailable",
    label: "Unavailable",
  },
  {
    value: "busy",
    label: "Currently busy",
  },
  {
    value: "paused",
    label: "Pause availability",
  },
];

const AVAILABILITY_MODES = [
  {
    value: "weekly",
    label: "Days of the week",
    description: "For a regular weekly schedule",
  },
  {
    value: "dates",
    label: "Specific dates",
    description: "For a changing schedule",
  },
];

const WEEKDAYS = [
  { value: 1, label: "Monday", shortLabel: "Mon" },
  { value: 2, label: "Tuesday", shortLabel: "Tue" },
  { value: 3, label: "Wednesday", shortLabel: "Wed" },
  { value: 4, label: "Thursday", shortLabel: "Thu" },
  { value: 5, label: "Friday", shortLabel: "Fri" },
  { value: 6, label: "Saturday", shortLabel: "Sat" },
  { value: 7, label: "Sunday", shortLabel: "Sun" },
];

const VALID_AVAILABILITY_STATUSES = AVAILABILITY_STATUSES.map((item) => item.value);

const VALID_AVAILABILITY_MODES = AVAILABILITY_MODES.map((item) => item.value);

const MAX_AVAILABLE_DATES = 90;
const MAX_AVAILABILITY_NOTE_LENGTH = 300;

// ───────────────────────── ERRORS ─────────────────────────

function createError(message, statusCode = 400) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.status = statusCode;

  return error;
}

// ───────────────────────── AUTHORISATION ─────────────────────────

function assertProfessionalUser(actorUser) {
  if (!actorUser || !actorUser._id || actorUser.role !== "professional") {
    throw createError("Professional account access is required.", 403);
  }
}

function assertProfileOwnership(actorUser, professionalProfile) {
  assertProfessionalUser(actorUser);

  if (!professionalProfile) {
    throw createError("Your professional profile could not be found.", 404);
  }

  const owner = professionalProfile.user;
  const ownerId = owner?._id || owner;

  if (!ownerId || String(ownerId) !== String(actorUser._id)) {
    throw createError("You are not authorised to access this profile.", 403);
  }
}

// ───────────────────────── PRESENTATION HELPERS ─────────────────────────

function humaniseStatus(value) {
  if (!value) return "Not available";

  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusBadgeClass(status) {
  const classes = {
    verified: "badge-light-success",
    approved: "badge-light-success",
    active: "badge-light-success",
    visible: "badge-light-success",
    available: "badge-light-success",

    pending: "badge-light-warning",
    needs_review: "badge-light-warning",
    busy: "badge-light-warning",
    paused: "badge-light-warning",

    rejected: "badge-light-danger",
    restricted: "badge-light-danger",
    suspended: "badge-light-danger",

    hidden: "badge-light-secondary",
    unavailable: "badge-light-secondary",
    not_started: "badge-light-secondary",
  };

  return classes[status] || "badge-light-secondary";
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Lagos",
  });
}

function formatISODate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toISOString().slice(0, 10);
}

function formatAvailabilityDate(value) {
  const isoDate = formatISODate(value);

  if (!isoDate) return "";

  const date = new Date(`${isoDate}T12:00:00.000Z`);

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Determine today's calendar date in Nigeria.
 *
 * Availability choices represent calendar dates,
 * not shift start times or timestamps.
 */
function getTodayISODate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};

  parts.forEach((part) => {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = part.value;
    }
  });

  return `${values.year}-${values.month}-${values.day}`;
}

function buildInitials(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "P";

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

function getProfessionalName(actorUser, professionalProfile) {
  const firstName = actorUser.firstName || "";
  const lastName = actorUser.lastName || "";

  return (
    actorUser.fullName ||
    actorUser.displayName ||
    `${firstName} ${lastName}`.trim() ||
    actorUser.name ||
    professionalProfile.identityNameOnDocument ||
    "Professional"
  );
}

function buildStatus(status) {
  return {
    value: status || "pending",
    label: humaniseStatus(status || "pending"),
    badgeClass: statusBadgeClass(status || "pending"),
  };
}

function buildDetail(label, value, options = {}) {
  return {
    label,

    value: value === null || value === undefined || value === "" ? "Not available" : String(value),

    locked: options.locked === true,
  };
}

// ───────────────────────── PROFILE NAVIGATION ─────────────────────────

function resolveActiveTab(requestedTab) {
  const matched = PROFILE_TABS.find((tab) => tab.key === requestedTab);

  return matched ? matched.key : "overview";
}

function buildProfileNavigation(activeTab) {
  return PROFILE_TABS.map((tab) => ({
    ...tab,
    href: `/professional/profile?tab=${tab.key}`,
    active: tab.key === activeTab,
  }));
}

// ───────────────────────── AVAILABILITY HELPERS ─────────────────────────

function getStoredAvailableDates(profile) {
  if (!Array.isArray(profile.availableDates)) {
    return [];
  }

  return [...new Set(profile.availableDates.map(formatISODate).filter(Boolean))].sort();
}

function resolveAvailabilityMode(profile) {
  if (VALID_AVAILABILITY_MODES.includes(profile.availabilityMode)) {
    return profile.availabilityMode;
  }

  // Existing profiles may already have specific dates.
  if (getStoredAvailableDates(profile).length > 0) {
    return "dates";
  }

  return "weekly";
}

function asArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function readSingleString(value, fieldName, options = {}) {
  if (value === undefined || value === null) {
    return options.defaultValue ?? "";
  }

  if (typeof value !== "string") {
    throw createError(`Invalid ${fieldName}.`);
  }

  return value.trim();
}

function normaliseWeekdays(value) {
  const supplied = asArray(value);

  if (supplied.length > 7) {
    throw createError("You can select a maximum of seven weekdays.");
  }

  const weekdays = supplied.map((item) => {
    if (typeof item !== "string" && typeof item !== "number") {
      throw createError("An invalid weekday was selected.");
    }

    const text = String(item).trim();

    if (!/^[1-7]$/.test(text)) {
      throw createError("An invalid weekday was selected.");
    }

    return Number(text);
  });

  return [...new Set(weekdays)].sort((a, b) => a - b);
}

function normaliseAvailableDates(value) {
  const supplied = asArray(value);

  if (supplied.length > MAX_AVAILABLE_DATES) {
    throw createError(`You can select up to ${MAX_AVAILABLE_DATES} dates.`);
  }

  const today = getTodayISODate();

  const dates = supplied.map((item) => {
    if (typeof item !== "string") {
      throw createError("An invalid availability date was supplied.");
    }

    const dateString = item.trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      throw createError("Availability dates must use YYYY-MM-DD.");
    }

    const parsed = new Date(`${dateString}T00:00:00.000Z`);

    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateString) {
      throw createError("An invalid availability date was supplied.");
    }

    if (dateString < today) {
      throw createError("You cannot select a date in the past.");
    }

    return dateString;
  });

  return [...new Set(dates)].sort();
}

// ───────────────────────── SUMMARY VIEW ─────────────────────────

function buildProfessionalProfileSummary(actorUser, profile) {
  const professionalName = getProfessionalName(actorUser, profile);

  const accountStatus = buildStatus(profile.accountStatus);

  const profession = PROFESSIONAL_TYPES[profile.type] || humaniseStatus(profile.type);

  const availabilityStatus = buildStatus(profile.availabilityStatus || "available");

  return {
    professionalName,

    initials: buildInitials(professionalName),

    email: actorUser.email || "",

    phone: [profile.phoneCode, profile.phone].filter(Boolean).join(" "),

    profession,

    specialty: profile.specialty || "Not specified",

    locationLabel:
      [profile.lga, profile.state].filter(Boolean).join(", ") || "Location not available",

    tier: profile.tier || "newcomer",

    tierLabel: humaniseStatus(profile.tier || "newcomer"),

    yearsOfExperience: profile.yearsOfExperience ?? 0,

    totalShiftsCompleted: profile.totalShiftsCompleted ?? 0,

    averageRating: Number(profile.averageRating || 0).toFixed(1),

    accountStatusLabel: accountStatus.label,

    accountStatusBadgeClass: accountStatus.badgeClass,

    availabilityStatusLabel: availabilityStatus.label,

    availabilityStatusBadgeClass: availabilityStatus.badgeClass,
  };
}

// ───────────────────────── VERIFICATION VIEW ─────────────────────────

function buildVerificationItem({ key, title, description, status, verifiedAt, details = [] }) {
  const presentation = buildStatus(status);

  return {
    key,
    title,
    description,

    status: presentation.value,
    statusLabel: presentation.label,
    badgeClass: presentation.badgeClass,

    dateLabel: formatDate(verifiedAt),

    details,
  };
}

function buildVerificationView(profile) {
  const kycStatus = getProfessionalKycStatus(profile);

  // Eligibility, account status and marketplace visibility
  // are separate considerations.
  // This check is informational and does not modify approval.
  const eligibilityChecksPassed = kycStatus?.isEligible === true;

  const accountActive = profile.accountStatus === "active";

  const marketplaceVisible = profile.marketplaceStatus === "visible";

  const isMarketplaceReady = eligibilityChecksPassed && accountActive && marketplaceVisible;

  let readinessLabel = "Marketplace Ready";

  let readinessMessage =
    "Your eligibility checks are satisfied, your account is active, " +
    "and your professional profile is visible on the marketplace.";

  if (!eligibilityChecksPassed) {
    readinessLabel = "Requirements Outstanding";

    readinessMessage =
      "Your account has not satisfied all current professional eligibility " +
      "requirements. Review the statuses below for more information.";
  } else if (!accountActive) {
    readinessLabel = "Account Not Active";

    readinessMessage =
      "Your eligibility checks are satisfied, but your professional account " +
      "is not currently active.";
  } else if (!marketplaceVisible) {
    readinessLabel = "Marketplace Not Visible";

    readinessMessage =
      "Your eligibility checks are satisfied, but your profile is not " +
      "currently visible on the professional marketplace.";
  }

  const items = [
    buildVerificationItem({
      key: "identity",
      title: "Identity Verification",
      description: "Your registered identity verification status.",
      status: profile.identityVerificationStatus,
      verifiedAt: profile.identityVerifiedAt,

      details: [buildDetail("Identity number", "Protected for your security", { locked: true })],
    }),

    buildVerificationItem({
      key: "licence",
      title: "Professional Licence",
      description: "Verification of your professional registration.",
      status: profile.licenceVerificationStatus,
      verifiedAt: profile.licenceVerifiedAt,

      details: [
        buildDetail("Licence number", profile.licenceNumber, { locked: true }),

        buildDetail("Issuing body", profile.licenceIssuingBody, { locked: true }),
      ],
    }),

    buildVerificationItem({
      key: "approval",
      title: "Professional Approval",
      description: "Your approval status on Loqum.",
      status: profile.professionalApprovalStatus,
      verifiedAt: profile.approvedForShiftsAt,
    }),

    buildVerificationItem({
      key: "account",
      title: "Account Status",
      description: "Your professional account's current status.",
      status: profile.accountStatus,
    }),

    buildVerificationItem({
      key: "marketplace",
      title: "Marketplace Visibility",
      description: "Your visibility in Loqum's professional marketplace.",
      status: profile.marketplaceStatus,
    }),
  ];

  return {
    // Retained for compatibility with the existing
    // verification template until its presentation rework.
    isEligible: isMarketplaceReady,

    eligibilityChecksPassed,
    isMarketplaceReady,

    readinessLabel,
    readinessMessage,

    readinessBadgeClass: isMarketplaceReady ? "badge-light-success" : "badge-light-warning",

    readinessNoticeClass: isMarketplaceReady
      ? "bg-light-success border-success"
      : "bg-light-warning border-warning",

    readinessIcon: isMarketplaceReady ? "ki-shield-tick" : "ki-information-5",

    readinessIconClass: isMarketplaceReady ? "text-success" : "text-warning",

    items,

    supportMessage:
      "Verified identity and professional licence details " +
      "cannot be changed directly. Contact Loqum Support " +
      "if a correction is required.",

    licenceExpiryMessage:
      "A recorded licence expiry date is informational. " +
      "Loqum does not automatically revoke a completed " +
      "one-time licence verification because of that date.",
  };
}

// ───────────────────────── OVERVIEW VIEW ─────────────────────────

function buildOverviewView(profile, verificationView) {
  return {
    stats: [
      {
        key: "experience",
        label: "Experience",
        value: String(profile.yearsOfExperience ?? 0),
        suffix: "years",
        icon: "ki-award",
        colorClass: "text-primary",
        backgroundClass: "bg-light-primary",
      },

      {
        key: "shifts",
        label: "Completed Shifts",
        value: String(profile.totalShiftsCompleted ?? 0),
        suffix: "",
        icon: "ki-calendar-tick",
        colorClass: "text-success",
        backgroundClass: "bg-light-success",
      },

      {
        key: "rating",
        label: "Average Rating",
        value: Number(profile.averageRating || 0).toFixed(1),
        suffix: "/ 5",
        icon: "ki-star",
        colorClass: "text-warning",
        backgroundClass: "bg-light-warning",
      },
    ],

    verificationItems: verificationView.items,

    isMarketplaceReady: verificationView.isMarketplaceReady,

    readinessMessage: verificationView.readinessMessage,

    readinessNoticeClass: verificationView.readinessNoticeClass,

    readinessIcon: verificationView.readinessIcon,

    readinessIconClass: verificationView.readinessIconClass,

    readinessLabel: verificationView.readinessLabel,

    readinessBadgeClass: verificationView.readinessBadgeClass,

    professionalDetailsUrl: "/professional/profile?tab=professional-details",

    verificationUrl: "/professional/profile?tab=verification",

    availabilityUrl: "/professional/profile?tab=availability",
  };
}

// ───────────────────────── PERSONAL DETAILS VIEW ─────────────────────────

function buildPersonalDetailsView(actorUser, profile) {
  return {
    fields: [
      buildDetail("Full name", getProfessionalName(actorUser, profile), { locked: true }),

      buildDetail("Email address", actorUser.email),

      buildDetail("Phone number", [profile.phoneCode, profile.phone].filter(Boolean).join(" ")),

      buildDetail("State", profile.state),

      buildDetail("LGA", profile.lga),

      buildDetail("Address", profile.address),
    ],

    identityNotice:
      "Your registered legal identity is protected. " +
      "Contact Loqum Support if your verified identity " +
      "needs correction.",
  };
}

// ───────────────────────── PROFESSIONAL DETAILS VIEW ─────────────────────────

function buildProfessionalDetailsView(profile) {
  return {
    fields: [
      buildDetail("Profession", PROFESSIONAL_TYPES[profile.type] || humaniseStatus(profile.type), {
        locked: true,
      }),

      buildDetail("Specialty", profile.specialty),

      buildDetail("Years of experience", profile.yearsOfExperience ?? 0),

      buildDetail("Professional tier", humaniseStatus(profile.tier || "newcomer")),

      buildDetail("Licence number", profile.licenceNumber, { locked: true }),

      buildDetail("Licence issuing body", profile.licenceIssuingBody, { locked: true }),

      buildDetail("Licence expiry date", formatDate(profile.licenceExpiryDate), { locked: true }),
    ],

    bio: profile.bio || "",

    certifications: (profile.certifications || []).map((certification) => ({
      name: certification.name || "Certification",

      issuingBody: certification.issuingBody || "",

      dateObtainedLabel: formatDate(certification.dateObtained),

      expiryDateLabel: formatDate(certification.expiryDate),

      verified: certification.verified === true,

      verificationLabel: certification.verified === true ? "Verified" : "Not verified",

      verificationBadgeClass:
        certification.verified === true ? "badge-light-success" : "badge-light-secondary",
    })),

    protectedFieldsMessage:
      "Your profession and submitted licence identifiers " +
      "are protected. Corrections must be handled through " +
      "Loqum Support.",
  };
}

// ───────────────────────── AVAILABILITY VIEW ─────────────────────────

function buildAvailabilityView(profile) {
  const today = getTodayISODate();

  const storedDates = getStoredAvailableDates(profile);

  // Show upcoming selectable dates in the editing interface.
  const upcomingDates = storedDates.filter((date) => date >= today);

  const selectedWeekdays = Array.isArray(profile.availableWeekdays)
    ? profile.availableWeekdays.map(Number)
    : [];

  const mode = resolveAvailabilityMode(profile);

  return {
    status: profile.availabilityStatus || "available",

    mode,

    statusOptions: AVAILABILITY_STATUSES.map((option) => ({
      ...option,

      selected: option.value === (profile.availabilityStatus || "available"),
    })),

    modeOptions: AVAILABILITY_MODES.map((option) => ({
      ...option,
      selected: option.value === mode,
    })),

    weekdayOptions: WEEKDAYS.map((day) => ({
      ...day,
      selected: selectedWeekdays.includes(day.value),
    })),

    selectedWeekdays,

    selectedDates: upcomingDates.map((date) => ({
      value: date,
      label: formatAvailabilityDate(date),
    })),

    minimumDate: today,

    note: profile.availabilityNote || "",

    maxDates: MAX_AVAILABLE_DATES,

    maxNoteLength: MAX_AVAILABILITY_NOTE_LENGTH,

    formAction: "/professional/profile/availability",

    helpMessage:
      "Your availability helps communicate when you " +
      "prefer to work. It does not cancel confirmed " +
      "shifts or guarantee automatic bookings.",
  };
}

// ───────────────────────── ACCOUNT SETTINGS VIEW ─────────────────────────

function buildAccountSettingsView(profile) {
  const status = buildStatus(profile.accountStatus);

  return {
    accountStatusLabel: status.label,

    accountStatusBadgeClass: status.badgeClass,

    closureEnabled: false,

    closureMessage:
      "Self-service account closure is not yet available. " +
      "Contact Loqum Support for account-related assistance.",

    financialNotice:
      "Account closure must account for outstanding shifts, " +
      "earnings, withdrawals, unresolved cases, and financial " +
      "history. These safeguards will be implemented as part " +
      "of the shared account-lifecycle workflow.",
  };
}

// ───────────────────────── SERVICE ─────────────────────────

class ProfessionalProfileService {
  /**
   * Prepare all Professional Profile data for rendering.
   *
   * The controller passes:
   * - req.user
   * - req.professionalProfile
   * - the requested profile tab
   *
   * Ownership is checked defensively here.
   */
  static async getProfileData({ actorUser, professionalProfile, activeTab = "overview" } = {}) {
    assertProfileOwnership(actorUser, professionalProfile);

    const selectedTab = resolveActiveTab(activeTab);

    const professionalProfileSummary = buildProfessionalProfileSummary(
      actorUser,
      professionalProfile
    );

    const verificationView = buildVerificationView(professionalProfile);

    return {
      activeTab: selectedTab,

      professionalProfileSummary,

      profileNavigation: buildProfileNavigation(selectedTab),

      overviewView: buildOverviewView(professionalProfile, verificationView),

      personalDetailsView: buildPersonalDetailsView(actorUser, professionalProfile),

      professionalDetailsView: buildProfessionalDetailsView(professionalProfile),

      verificationView,

      availabilityView: buildAvailabilityView(professionalProfile),

      accountSettingsView: buildAccountSettingsView(professionalProfile),
    };
  }

  /**
   * Update the authenticated professional's availability.
   *
   * Only the approved availability fields are written.
   * Preferences for the inactive mode are preserved.
   */
  static async updateAvailability({ actorUser, data } = {}) {
    assertProfessionalUser(actorUser);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw createError("Invalid availability information.");
    }

    const status = readSingleString(data.availabilityStatus, "availability status");

    const mode = readSingleString(data.availabilityMode, "availability mode");

    const note = readSingleString(data.availabilityNote, "availability note");

    if (!VALID_AVAILABILITY_STATUSES.includes(status)) {
      throw createError("Please select a valid availability status.");
    }

    if (!VALID_AVAILABILITY_MODES.includes(mode)) {
      throw createError("Please select a valid availability mode.");
    }

    if (note.length > MAX_AVAILABILITY_NOTE_LENGTH) {
      throw createError(
        `Availability notes cannot exceed ${MAX_AVAILABILITY_NOTE_LENGTH} characters.`
      );
    }

    let weekdays = null;
    let dates = null;

    if (mode === "weekly") {
      weekdays = normaliseWeekdays(data.availableWeekdays ?? data["availableWeekdays[]"]);

      if (status === "available" && weekdays.length === 0) {
        throw createError("Please select at least one available weekday.");
      }
    }

    if (mode === "dates") {
      dates = normaliseAvailableDates(data.availableDates ?? data["availableDates[]"]);

      if (status === "available" && dates.length === 0) {
        throw createError("Please select at least one available date.");
      }
    }

    // Resolve ownership from the authenticated user.
    // Never accept a profile ID from the form.
    const profile = await ProfessionalProfile.findOne({
      user: actorUser._id,
    });

    if (!profile) {
      throw createError("Your professional profile could not be found.", 404);
    }

    profile.availabilityStatus = status;
    profile.availabilityMode = mode;
    profile.availabilityNote = note || null;

    if (mode === "weekly") {
      profile.availableWeekdays = weekdays;
    } else {
      profile.availableDates = dates.map((date) => new Date(`${date}T00:00:00.000Z`));
    }

    // Preserve existing Mongoose validation hooks.
    await profile.save();

    return {
      success: true,

      message: "Your availability has been updated.",

      availabilityStatus: profile.availabilityStatus,

      availabilityMode: profile.availabilityMode,
    };
  }
}

// ───────────────────────── EXPORT ─────────────────────────

module.exports = ProfessionalProfileService;
