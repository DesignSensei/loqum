// services/professionalProfileService.js

const ProfessionalProfile = require("../models/ProfessionalProfile");
const { getProfessionalKycStatus } = require("../utils/statusHelper");
const ProfessionalVerificationService = require("./professionalVerificationService");

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

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}

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
    needs_review: "badge-light-info",
    busy: "badge-light-info",
    paused: "badge-light-warning",
    rejected: "badge-light-danger",
    restricted: "badge-light-danger",
    suspended: "badge-light-danger",
    expired: "badge-light-danger",
    recorded: "badge-light-info",
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
  const value = status || "pending";

  return {
    value,
    label: humaniseStatus(value),
    badgeClass: statusBadgeClass(value),
  };
}

function buildDetail(label, value, options = {}) {
  return {
    label,
    value: value === null || value === undefined || value === "" ? "Not available" : String(value),
    locked: options.locked === true,
  };
}

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

function describeLicenceValidity(type, licensingYear) {
  if (type === "life") return "Confirmed lifetime licence";

  if (type === "licensing_year") {
    return Number.isInteger(licensingYear)
      ? `Approved licensing year ${licensingYear}`
      : "Licensing year awaiting confirmation";
  }

  if (type === "expiry_date") return "Approved expiry date";

  return "Not yet established";
}

function daysBetweenISO(first, second) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first || "") || !/^\d{4}-\d{2}-\d{2}$/.test(second || "")) {
    return null;
  }

  const a = Date.parse(`${first}T00:00:00.000Z`);
  const b = Date.parse(`${second}T00:00:00.000Z`);

  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
}

function buildLicencePresentation(profile) {
  const validity = ProfessionalVerificationService.getLicenceValidityState(profile);
  const approved = profile.licenceVerificationStatus === "verified";
  const pendingAt = profile.licencePendingDocumentSubmittedAt || null;
  const hasPendingSubmission = Boolean(pendingAt);
  const future = profile.upcomingLicence || null;
  const hasApprovedUpcoming = Boolean(future && !validity.usingUpcoming);

  const effectiveValidityType =
    validity.usingUpcoming && future ? future.validityType : profile.licenceValidityType;

  const effectiveLicensingYear =
    validity.usingUpcoming && future ? future.licensingYear : profile.licenceLicensingYear;

  const expiryISODate = validity.expiryISODate || null;
  const today = getTodayISODate();
  const daysUntilExpiry = expiryISODate ? daysBetweenISO(today, expiryISODate) : null;
  const current = approved && validity.current;

  let status = profile.licenceVerificationStatus || "pending";
  let statusLabel = humaniseStatus(status);

  if (approved && !validity.current) {
    status = validity.expired ? "expired" : "needs_review";
    statusLabel = validity.expired ? "Expired" : "Validity review required";
  }

  let expiryMessage =
    "Licence validity is determined from reviewed evidence. " +
    "An expired licence never authorises new work.";

  if (approved && validity.expired) {
    expiryMessage = validity.withinGrace
      ? `Licence expired on ${expiryISODate}. Renewal grace ends ${validity.graceEndsOn}. ` +
        "You may renew, but cannot take on new work."
      : `Licence expired on ${expiryISODate}. Renew to regain work eligibility.`;
  } else if (approved && current && effectiveValidityType === "life") {
    expiryMessage = "Lifetime licence confirmed. Other eligibility checks still apply.";
  } else if (approved && current && daysUntilExpiry !== null && daysUntilExpiry <= 30) {
    expiryMessage =
      `Licence expires on ${expiryISODate}. Renew early; the grace period ` +
      "does not permit work after expiry.";
  } else if (approved && current) {
    expiryMessage = expiryISODate
      ? `Licence current through ${expiryISODate}.`
      : "Licence is current.";
  }

  const reviewFeedback = ["rejected", "needs_review"].includes(profile.licenceVerificationStatus)
    ? String(profile.licenceVerificationNote || "").trim()
    : "";

  const canSubmitDocument = Boolean(profile._id && profile.licenceNumber) && !hasApprovedUpcoming;

  return {
    status,
    statusLabel,
    statusBadgeClass: statusBadgeClass(status),
    approved,
    current,
    expired: validity.expired === true,
    withinGrace: validity.withinGrace === true,
    graceEndsOn: validity.graceEndsOn || null,
    graceEndsLabel: validity.graceEndsOn || "",
    expiryISODate,
    expiryLabel:
      expiryISODate ||
      (approved && effectiveValidityType === "life" ? "Lifetime" : "Not available"),
    daysUntilExpiry,
    validityType: effectiveValidityType || null,
    validityLabel: describeLicenceValidity(effectiveValidityType, effectiveLicensingYear),
    verifiedDateLabel: formatDate(
      validity.usingUpcoming ? future?.verifiedAt : profile.licenceVerifiedAt
    ),
    hasPendingSubmission,
    pendingDateLabel: formatDate(pendingAt),
    pendingStatusLabel: hasPendingSubmission ? "Awaiting review" : "No pending document",
    reviewFeedback,
    hasApprovedUpcoming,
    upcoming: hasApprovedUpcoming
      ? {
          statusLabel: "Approved — not yet effective",
          startsOnLabel: formatDate(future.validFrom),
          validityLabel: describeLicenceValidity(future.validityType, future.licensingYear),
          expiryLabel:
            future.validityType === "life"
              ? "Lifetime"
              : formatDate(future.expiryDate) || "Not available",
          reviewedDateLabel: formatDate(future.verifiedAt),
        }
      : null,
    canSubmitDocument,
    uploadAction: profile._id
      ? `/professional/verification/${encodeURIComponent(String(profile._id))}/licence-document`
      : null,
    uploadFieldName: "licenceDocument",
    uploadAccept: ".pdf,.jpg,.jpeg,.png,.webp",
    uploadMaxBytes: 10 * 1024 * 1024,
    uploadButtonLabel: hasPendingSubmission
      ? "Replace submitted document"
      : approved
        ? "Submit renewal"
        : "Submit practising licence",
    uploadHelpMessage: hasApprovedUpcoming
      ? "An approved upcoming renewal is already scheduled. Contact support " +
        "if that approved document needs correction."
      : !profile.licenceNumber
        ? "A registered licence number is required before document submission."
        : "Submit a PDF or image of your practising licence (maximum 10 MB). " +
          "Submission is not verification or permission to work.",
    expiryMessage,
  };
}

function buildVerificationView(profile, verificationStatus) {
  const kycStatus = getProfessionalKycStatus(profile, verificationStatus);
  const licence = buildLicencePresentation(profile);

  // Present the audit-backed status rather than a locally inferred approval.
  const licenceItem = kycStatus.items.find((item) => item.label === "Practising licence");

  if (licenceItem && licenceItem.status !== licence.status) {
    licence.status = licenceItem.status;
    licence.statusLabel = humaniseStatus(licence.status);
    licence.statusBadgeClass = statusBadgeClass(licence.status);
  }

  const licenceDetails = [
    buildDetail("Licence number", profile.licenceNumber, { locked: true }),
    buildDetail("Issuing body", profile.licenceIssuingBody, { locked: true }),
    buildDetail("Validity", licence.validityLabel),
    buildDetail("Valid until", licence.expiryLabel),
  ];

  if (licence.reviewFeedback) {
    licenceDetails.push(buildDetail("Review feedback", licence.reviewFeedback));
  }

  if (licence.hasPendingSubmission) {
    licenceDetails.push(buildDetail("Document submitted", licence.pendingDateLabel));
    licenceDetails.push(buildDetail("Submission", "Awaiting administrative review"));
  }

  const items = [
    buildVerificationItem({
      key: "licence",
      title: "Professional Licence",
      description: "Administrative review of your practising-licence evidence.",
      status: licence.status,
      verifiedAt: profile.licenceVerifiedAt,
      details: licenceDetails,
    }),
    buildVerificationItem({
      key: "approval",
      title: "Professional Approval",
      description: "Separate final approval to participate in Loqum's marketplace.",
      status: profile.professionalApprovalStatus,
      verifiedAt: profile.approvedForShiftsAt,
    }),
    buildVerificationItem({
      key: "account",
      title: "Account Status",
      description: "Your professional account's current operational status.",
      status: profile.accountStatus,
    }),
    buildVerificationItem({
      key: "marketplace",
      title: "Marketplace Visibility",
      description: "Whether your profile is visible in Loqum's marketplace.",
      status: profile.marketplaceStatus,
    }),
  ];

  if (licence.hasApprovedUpcoming) {
    items.push(
      buildVerificationItem({
        key: "upcoming-licence",
        title: "Upcoming Licence",
        description: "Approved renewal scheduled to become effective later.",
        status: "approved",
        verifiedAt: profile.upcomingLicence.verifiedAt,
        details: [
          buildDetail("Effective from", licence.upcoming.startsOnLabel),
          buildDetail("Validity", licence.upcoming.validityLabel),
          buildDetail("Valid until", licence.upcoming.expiryLabel),
        ],
      })
    );
  }

  return {
    isEligible: kycStatus.isMarketplaceReady,
    eligibilityChecksPassed: kycStatus.verificationChecksPassed,
    verificationChecksPassed: kycStatus.verificationChecksPassed,
    accountActive: kycStatus.accountActive,
    marketplaceVisible: kycStatus.marketplaceVisible,
    isMarketplaceReady: kycStatus.isMarketplaceReady,
    readinessLabel: kycStatus.readinessLabel,
    readinessMessage: kycStatus.readinessMessage,
    readinessBadgeClass: kycStatus.readinessBadgeClass,
    readinessNoticeClass: kycStatus.readinessNoticeClass,
    readinessIcon: kycStatus.readinessIcon,
    readinessIconClass: kycStatus.readinessIconClass,
    items,
    licence,
    ninEvidenceMessage:
      "Your onboarding NIN legal-name evidence is reused for licence review. " +
      "No second NIN lookup is required.",
    supportMessage:
      "Your identity and licence details are protected. " +
      "Submit licence renewals here or contact support for corrections.",
    licenceExpiryMessage: licence.expiryMessage,
  };
}

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
    eligibilityChecksPassed: verificationView.verificationChecksPassed,
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

function buildProfessionalDetailsView(profile, licence) {
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
      buildDetail("Licence validity", licence.validityLabel, { locked: true }),
      buildDetail("Licence expiry date", licence.expiryLabel, { locked: true }),
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

function buildAvailabilityView(profile) {
  const today = getTodayISODate();
  const storedDates = getStoredAvailableDates(profile);
  const upcomingDates = storedDates.filter((date) => date >= today);

  const selectedWeekdays = Array.isArray(profile.availableWeekdays)
    ? [
        ...new Set(
          profile.availableWeekdays
            .map(Number)
            .filter((day) => WEEKDAYS.some((weekday) => weekday.value === day))
        ),
      ].sort((a, b) => a - b)
    : [];

  const mode = resolveAvailabilityMode(profile);
  const status = profile.availabilityStatus || "available";

  return {
    status,
    mode,
    statusOptions: AVAILABILITY_STATUSES.map((option) => ({
      ...option,
      selected: option.value === status,
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

class ProfessionalProfileService {
  static async getProfileData({ actorUser, professionalProfile, activeTab = "overview" } = {}) {
    assertProfileOwnership(actorUser, professionalProfile);

    const verificationStatus = await ProfessionalVerificationService.getVerificationStatus({
      professionalProfileId: professionalProfile._id,
      userId: actorUser._id,
    });

    // The status flow may activate an approved renewal that is now effective.
    // Refresh after its transaction so the profile displays current licence data.
    const profile = await ProfessionalProfile.findOne({
      _id: professionalProfile._id,
      user: actorUser._id,
    });

    if (!profile) {
      throw createError("Your professional profile could not be found.", 404);
    }

    const selectedTab = resolveActiveTab(activeTab);
    const professionalProfileSummary = buildProfessionalProfileSummary(actorUser, profile);
    const verificationView = buildVerificationView(profile, verificationStatus);

    return {
      activeTab: selectedTab,
      professionalProfileSummary,
      profileNavigation: buildProfileNavigation(selectedTab),
      overviewView: buildOverviewView(profile, verificationView),
      personalDetailsView: buildPersonalDetailsView(actorUser, profile),
      professionalDetailsView: buildProfessionalDetailsView(profile, verificationView.licence),
      verificationView,
      availabilityView: buildAvailabilityView(profile),
      accountSettingsView: buildAccountSettingsView(profile),
    };
  }

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

    await profile.save();

    return {
      success: true,
      message: "Your availability has been updated.",
      availabilityStatus: profile.availabilityStatus,
      availabilityMode: profile.availabilityMode,
    };
  }
}

module.exports = ProfessionalProfileService;
