// services/employerService.js

const mongoose = require("mongoose");

const Shift = require("../models/Shift");
const ShiftApplication = require("../models/ShiftApplication");
const Wallet = require("../models/Wallet");
const DVA = require("../models/DVA");
const Branch = require("../models/Branch");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const User = require("../models/User");

const InviteService = require("./inviteService");
const ProfileInputService = require("./profileInputService");

const money = require("../utils/money");

const {
  getEmployerKycStatus,
  getWalletStatus,
  getEmployerFundingStatus,
  badgeClass,
  formatStatus,
} = require("../utils/statusHelper");

const allowedBranchStatusFilters = ["active", "inactive", "all"];

const allowedMemberStatusFilters = ["active", "restricted", "suspended", "removed", "all"];

// ───────────────────── BUSINESS DISPLAY HELPERS ─────────────────────

function getBusinessInitials(businessName) {
  if (!businessName || typeof businessName !== "string") {
    return "LP";
  }

  const words = businessName.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return "LP";
  }

  if (words.length === 1) {
    return words[0].substring(0, 2).toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

// ───────────────────── BRANCH FILTER HELPERS ─────────────────────

function normalizeBranchStatusFilter(status) {
  const normalizedStatus = String(status || "active")
    .toLowerCase()
    .trim();

  return allowedBranchStatusFilters.includes(normalizedStatus) ? normalizedStatus : "active";
}

function getBranchStatusQuery({ businessId, branchStatus }) {
  const query = {
    business: businessId,
  };

  if (branchStatus === "all") {
    return query;
  }

  return {
    ...query,
    isActive: branchStatus === "active",
  };
}

function buildBranchStatusFilters(activeStatus, counts = {}) {
  return [
    {
      key: "active",
      label: "Active",
      count: counts.active || 0,
      isActive: activeStatus === "active",
      url: "/employer/business-profile?tab=branches&branchStatus=active",
    },
    {
      key: "inactive",
      label: "Inactive",
      count: counts.inactive || 0,
      isActive: activeStatus === "inactive",
      url: "/employer/business-profile?tab=branches&branchStatus=inactive",
    },
    {
      key: "all",
      label: "All",
      count: counts.all || 0,
      isActive: activeStatus === "all",
      url: "/employer/business-profile?tab=branches&branchStatus=all",
    },
  ];
}

// ───────────────────── MEMBER FILTER HELPERS ─────────────────────

function normalizeMemberStatusFilter(status) {
  const normalizedStatus = String(status || "active")
    .toLowerCase()
    .trim();

  return allowedMemberStatusFilters.includes(normalizedStatus) ? normalizedStatus : "active";
}

function getMemberStatusQuery({ businessId, memberStatus }) {
  const query = {
    business: businessId,
  };

  /*
   * The All filter must include current and
   * removed historical memberships.
   *
   * Removed members are retained for audit,
   * not permanently deleted from Loqum.
   */

  if (memberStatus === "all") {
    return query;
  }

  if (memberStatus === "removed") {
    return {
      ...query,
      accountStatus: "removed",
      isCurrent: false,
    };
  }

  return {
    ...query,
    accountStatus: memberStatus,
    isCurrent: true,
  };
}

function buildMemberStatusFilters(activeStatus, counts = {}) {
  return [
    {
      key: "active",
      label: "Active",
      count: counts.active || 0,
      isActive: activeStatus === "active",
      url: "/employer/business-profile?tab=team&memberStatus=active",
    },
    {
      key: "restricted",
      label: "Restricted",
      count: counts.restricted || 0,
      isActive: activeStatus === "restricted",
      url: "/employer/business-profile?tab=team&memberStatus=restricted",
    },
    {
      key: "suspended",
      label: "Suspended",
      count: counts.suspended || 0,
      isActive: activeStatus === "suspended",
      url: "/employer/business-profile?tab=team&memberStatus=suspended",
    },
    {
      key: "removed",
      label: "Removed",
      count: counts.removed || 0,
      isActive: activeStatus === "removed",
      url: "/employer/business-profile?tab=team&memberStatus=removed",
    },
    {
      key: "all",
      label: "All",
      count: counts.all || 0,
      isActive: activeStatus === "all",
      url: "/employer/business-profile?tab=team&memberStatus=all",
    },
  ];
}

// ───────────────────── MEMBER DISPLAY HELPERS ─────────────────────

function getMemberDisplayName(member) {
  const user = member.user;

  if (!user) {
    return "Unknown member";
  }

  if (user.displayName) {
    return user.displayName;
  }

  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

  if (fullName) {
    return fullName;
  }

  return user.email || "Unknown member";
}

function formatMemberRole(role) {
  const roleLabels = {
    admin: "Admin",
    branch_manager: "Branch Manager",
    branch_staff: "Branch Staff",
  };

  return roleLabels[role] || formatStatus(role || "");
}

function getMemberAccountStatus(member) {
  return member.accountStatus || member.status || member.user?.accountStatus || "active";
}

function shapeBusinessProfileMembers(members = []) {
  return members.map((member) => {
    const accountStatus = getMemberAccountStatus(member);
    const isRemoved = accountStatus === "removed";
    const isCurrent = member.isCurrent === true;
    const memberId = String(member._id);

    return {
      _id: member._id,

      user: member.user,
      branches: member.branches || [],

      name: getMemberDisplayName(member),
      email: member.user?.email || "-",

      role: member.role || "",
      roleLabel: formatMemberRole(member.role),
      roleBadgeClass: "badge-light-primary",

      accountStatus,
      statusLabel: formatStatus(accountStatus),
      statusBadgeClass: badgeClass[accountStatus] || "badge-light-success",

      isCurrent,
      isRemoved,

      removedAt: member.removedAt || null,
      removedBy: member.removedBy || null,
      removalReason: member.removalReason || "",

      canView: true,
      canEdit: isCurrent && !isRemoved,
      canRemove: isCurrent && !isRemoved,

      viewUrl: `/employer/business-profile/team-members/${memberId}`,
      updateUrl: `/employer/business-profile/team-members/${memberId}/update`,
      removeUrl: `/employer/business-profile/team-members/${memberId}/remove`,
    };
  });
}

function getBranchIdFromAssignment(assignment) {
  if (!assignment || !assignment.branch) {
    return null;
  }

  return String(assignment.branch._id || assignment.branch);
}

function getBranchCoordinates(branch) {
  const coordinates = branch?.location?.coordinates;

  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return {
      longitude: "",
      latitude: "",
    };
  }

  return {
    longitude: coordinates[0] ?? "",
    latitude: coordinates[1] ?? "",
  };
}

function buildBranchManagerOptions(members = []) {
  return members
    .filter((member) => {
      if (member.isCurrent !== true) return false;
      if (getMemberAccountStatus(member) !== "active") return false;

      return ["branch_manager", "branch_staff"].includes(member.role);
    })
    .map((member) => ({
      _id: String(member._id),
      displayName: getMemberDisplayName(member),
      email: member.user?.email || "",
      role: member.role,
      roleLabel: formatMemberRole(member.role),
    }));
}

function shapeBusinessProfileBranches(
  branches = [],
  members = [],
  { canViewManagerDetails = true } = {}
) {
  const managersByBranchId = new Map();

  if (canViewManagerDetails) {
    members.forEach((member) => {
      if (member.isCurrent !== true) return;
      if (getMemberAccountStatus(member) !== "active") return;
      if (member.role !== "branch_manager") return;

      const branchAssignments = Array.isArray(member.branches) ? member.branches : [];

      branchAssignments.forEach((assignment) => {
        if (assignment.role !== "branch_manager") return;

        const branchId = getBranchIdFromAssignment(assignment);
        if (!branchId) return;

        const manager = {
          id: String(member._id),
          userId: String(member.user?._id || member.user || ""),
          name: getMemberDisplayName(member),
          email: member.user?.email || "",
        };

        if (!managersByBranchId.has(branchId)) {
          managersByBranchId.set(branchId, []);
        }

        managersByBranchId.get(branchId).push(manager);
      });
    });
  }

  return branches.map((branch) => {
    const branchId = String(branch._id);
    const managers = managersByBranchId.get(branchId) || [];
    const primaryManager = managers[0] || null;
    const coordinates = getBranchCoordinates(branch);

    return {
      ...branch,

      managers,

      managerMemberId: primaryManager ? primaryManager.id : "",

      managerName: !canViewManagerDetails
        ? "Restricted"
        : managers.length > 0
          ? managers.length === 1
            ? managers[0].name
            : `${managers[0].name} +${managers.length - 1} more`
          : "Not assigned",

      longitude: coordinates.longitude,
      latitude: coordinates.latitude,
    };
  });
}

// ───────────────────── EMPLOYER FORM OPTIONS ─────────────────────

function getEmployerTypeOptions(activeType) {
  return [
    {
      value: "pharmacy",
      label: "Pharmacy",
      isSelected: activeType === "pharmacy",
    },
    {
      value: "clinic",
      label: "Clinic",
      isSelected: activeType === "clinic",
    },
    {
      value: "hospital",
      label: "Hospital",
      isSelected: activeType === "hospital",
    },
    {
      value: "laboratory",
      label: "Laboratory",
      isSelected: activeType === "laboratory",
    },
  ];
}

function getContactRoleOptions(activeRole) {
  return [
    {
      value: "owner",
      label: "Owner",
      isSelected: activeRole === "owner",
    },
    {
      value: "director",
      label: "Director",
      isSelected: activeRole === "director",
    },
    {
      value: "superintendent_pharmacist",
      label: "Superintendent Pharmacist",
      isSelected: activeRole === "superintendent_pharmacist",
    },
    {
      value: "branch_manager",
      label: "Branch Manager",
      isSelected: activeRole === "branch_manager",
    },
    {
      value: "hr_admin",
      label: "HR/Admin",
      isSelected: activeRole === "hr_admin",
    },
    {
      value: "operations_manager",
      label: "Operations Manager",
      isSelected: activeRole === "operations_manager",
    },
    {
      value: "procurement_manager",
      label: "Procurement Manager",
      isSelected: activeRole === "procurement_manager",
    },
    {
      value: "other",
      label: "Other",
      isSelected: activeRole === "other",
    },
  ];
}

function getEmployerProfileCoordinates(employerProfile) {
  const coordinates = employerProfile?.location?.coordinates;

  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return {
      longitude: "",
      latitude: "",
    };
  }

  return {
    longitude: coordinates[0] ?? "",
    latitude: coordinates[1] ?? "",
  };
}

function getRegulatoryBodyLabel(regulatoryBody) {
  const labels = {
    pcn: "Pharmacists Council of Nigeria",
    hefamaa: "Health Facilities Monitoring and Accreditation Agency",
    state_moh: "State Ministry of Health",
    mlscn: "Medical Laboratory Science Council of Nigeria",
    other: "Other Regulatory Body",
  };

  return labels[regulatoryBody] || "-";
}

function getBusinessDetailsRegulatoryBody(employerProfile) {
  return (
    employerProfile.regulatoryBody ||
    ProfileInputService.getRegulatoryBody(employerProfile.type, employerProfile.state) ||
    ""
  );
}

function buildBusinessDetailsView(employerProfile) {
  const coordinates = getEmployerProfileCoordinates(employerProfile);

  const regulatoryBody = getBusinessDetailsRegulatoryBody(employerProfile);

  return {
    updateUrl: "/employer/business-profile/business-details/update",

    typeOptions: getEmployerTypeOptions(employerProfile.type),
    contactRoleOptions: getContactRoleOptions(employerProfile.contactRole),

    protectedFields: [
      "type",
      "businessName",
      "cacRegistrationNumber",
      "regulatoryBody",
      "regulatoryRegistrationNumber",
    ],

    values: {
      type: employerProfile.type || "",

      businessName: employerProfile.businessName || "",
      businessEmail: employerProfile.businessEmail || "",

      cacRegistrationNumber: employerProfile.cacRegistrationNumber || "",
      regulatoryBody,
      regulatoryBodyLabel: getRegulatoryBodyLabel(regulatoryBody),
      regulatoryRegistrationNumber: employerProfile.regulatoryRegistrationNumber || "",

      businessPhoneCode: employerProfile.businessPhoneCode || "+234",
      businessPhone: employerProfile.businessPhone || "",

      address: employerProfile.address || "",
      googlePlaceId: employerProfile.googlePlaceId || "",
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      state: employerProfile.state || "",
      lga: employerProfile.lga || "",

      contactFirstName: employerProfile.contactFirstName || "",
      contactLastName: employerProfile.contactLastName || "",
      contactRole: employerProfile.contactRole || "",
      contactPhoneCode: employerProfile.contactPhoneCode || "+234",
      contactPhone: employerProfile.contactPhone || "",
    },
  };
}

// ───────────────────── VERIFICATION PRESENTATION ─────────────────────

function formatVerificationDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Verification decisions and internal review notes are separate.
 *
 * Employer-facing views receive controlled status explanations.
 * Internal investigation notes, rejection reasons, provider
 * diagnostics and account restriction details remain private.
 */
function getEmployerFacingVerificationNote(type, status) {
  const messages = {
    cac: {
      pending: "Your CAC registration is awaiting verification.",

      verified: "Your CAC registration has been verified.",

      needs_review:
        "Your CAC registration requires further review. Contact Loqum Support for assistance.",

      rejected: "Your CAC registration was not approved. Contact Loqum Support for assistance.",
    },

    regulatory: {
      pending: "Your facility registration is awaiting verification.",

      verified: "Your facility registration has been verified.",

      needs_review:
        "Your facility registration requires further review. Contact Loqum Support for assistance.",

      rejected:
        "Your facility registration was not approved. Contact Loqum Support for assistance.",
    },

    approval: {
      pending: "Your business is awaiting final approval.",

      approved: "Your business has received final approval.",

      needs_review:
        "Your business approval requires further review. Contact Loqum Support for assistance.",

      rejected: "Your business was not approved. Contact Loqum Support for assistance.",

      restricted: "Your business approval is restricted. Contact Loqum Support for assistance.",
    },

    account: {
      active: "Your business account is active.",

      restricted:
        "Your business account has restricted access. Contact Loqum Support for assistance.",

      suspended: "Your business account is suspended. Contact Loqum Support for assistance.",
    },
  };

  return (
    messages[type]?.[status] ||
    "Contact Loqum Support for information about this verification status."
  );
}

/**
 * Display the four existing verification decisions.
 *
 * Registration identifiers are read-only after submission.
 * Corrections require support review, not ordinary editing.
 *
 * CAC verification, facility verification, employer approval
 * and account status remain independent decisions.
 */
function buildVerificationView(employerProfile) {
  const cacVerificationStatus = employerProfile.cacVerificationStatus || "pending";

  const regulatoryVerificationStatus = employerProfile.regulatoryVerificationStatus || "pending";

  const employerApprovalStatus = employerProfile.employerApprovalStatus || "pending";

  const accountStatus = employerProfile.accountStatus || "active";

  const regulatoryBody = getBusinessDetailsRegulatoryBody(employerProfile);

  const regulatoryBodyLabel = getRegulatoryBodyLabel(regulatoryBody);

  return {
    supportMessage:
      "Verification registration details are locked after submission. " +
      "Contact Loqum Support if a number is incorrect or has changed.",

    items: [
      // ───────────────────── CAC VERIFICATION ─────────────────────

      {
        key: "cac",

        title: "CAC Verification",

        description: "Confirms the CAC registration and registered legal business name.",

        status: cacVerificationStatus,

        statusLabel: formatStatus(cacVerificationStatus),

        badgeClass: badgeClass[cacVerificationStatus] || "badge-light-warning",

        note: getEmployerFacingVerificationNote("cac", cacVerificationStatus),

        details: [
          {
            label: "CAC registration number",
            value: employerProfile.cacRegistrationNumber || "Not available",
          },
          {
            label: "Registered business name",
            value: employerProfile.businessName || "Not available",
          },
        ],

        identifierLocked: true,

        dateLabel: cacVerificationStatus === "verified" ? "Verified on" : "Last checked",

        dateValue: formatVerificationDate(
          cacVerificationStatus === "verified"
            ? employerProfile.cacVerifiedAt || employerProfile.cacLastCheckedAt
            : employerProfile.cacLastCheckedAt
        ),
      },

      // ───────────────────── FACILITY VERIFICATION ─────────────────────

      {
        key: "regulatory",

        title: "Facility Verification",

        description: "Confirms the facility or regulatory registration number.",

        status: regulatoryVerificationStatus,

        statusLabel: formatStatus(regulatoryVerificationStatus),

        badgeClass: badgeClass[regulatoryVerificationStatus] || "badge-light-warning",

        note: getEmployerFacingVerificationNote("regulatory", regulatoryVerificationStatus),

        details: [
          {
            label: "Regulatory body",
            value: regulatoryBodyLabel === "-" ? "Not available" : regulatoryBodyLabel,
          },
          {
            label: "Registration number",
            value: employerProfile.regulatoryRegistrationNumber || "Not available",
          },
        ],

        identifierLocked: true,

        dateLabel: regulatoryVerificationStatus === "verified" ? "Verified on" : "Last checked",

        dateValue: formatVerificationDate(
          regulatoryVerificationStatus === "verified"
            ? employerProfile.regulatoryVerifiedAt || employerProfile.regulatoryLastCheckedAt
            : employerProfile.regulatoryLastCheckedAt
        ),
      },

      // ───────────────────── EMPLOYER APPROVAL ─────────────────────

      {
        key: "approval",

        title: "Employer Approval",

        description: "The platform's separate administrative approval decision.",

        status: employerApprovalStatus,

        statusLabel: formatStatus(employerApprovalStatus),

        badgeClass: badgeClass[employerApprovalStatus] || "badge-light-warning",

        note: getEmployerFacingVerificationNote("approval", employerApprovalStatus),

        details: [],

        identifierLocked: false,

        dateLabel: "Last updated",

        dateValue: formatVerificationDate(employerProfile.employerApprovalStatusUpdatedAt),
      },

      // ───────────────────── ACCOUNT STATUS ─────────────────────

      {
        key: "account",

        title: "Account Status",

        description: "Shows whether the employer account can operate normally.",

        status: accountStatus,

        statusLabel: formatStatus(accountStatus),

        badgeClass: badgeClass[accountStatus] || "badge-light-success",

        note: getEmployerFacingVerificationNote("account", accountStatus),

        details: [],

        identifierLocked: false,

        dateLabel: "Last updated",

        dateValue: formatVerificationDate(employerProfile.accountStatusUpdatedAt),
      },
    ],
  };
}

// ───────────────────── BUSINESS PROFILE CHANGE DETECTION ─────────────────────

function profileFieldChanged(oldValue, newValue) {
  return String(oldValue ?? "").trim() !== String(newValue ?? "").trim();
}

/*
 * The previous business profile update method
 * allowed applicants to change businessName
 * and CAC registration details and automatically
 * reset verification states.
 *
 * That is no longer permitted.
 *
 * Legal registration and regulatory identities
 * require dedicated authorised workflows.
 *
 * This helper now detects material changes
 * without automatically clearing evidence,
 * administrative restrictions or approval history.
 */

function getBusinessDetailsVerificationReset(oldProfile, profileData) {
  const cacChanged =
    profileFieldChanged(oldProfile.businessName, profileData.businessName) ||
    profileFieldChanged(oldProfile.cacRegistrationNumber, profileData.cacRegistrationNumber);

  const regulatoryChanged =
    profileFieldChanged(oldProfile.type, profileData.type) ||
    profileFieldChanged(oldProfile.regulatoryBody, profileData.regulatoryBody) ||
    profileFieldChanged(
      oldProfile.regulatoryRegistrationNumber,
      profileData.regulatoryRegistrationNumber
    );

  const coordinates = getEmployerProfileCoordinates(oldProfile);

  const premisesChanged =
    profileFieldChanged(oldProfile.address, profileData.address) ||
    profileFieldChanged(oldProfile.googlePlaceId, profileData.googlePlaceId) ||
    profileFieldChanged(oldProfile.state, profileData.state) ||
    profileFieldChanged(oldProfile.lga, profileData.lga) ||
    Number(coordinates.latitude) !== Number(profileData.location?.coordinates?.[1]) ||
    Number(coordinates.longitude) !== Number(profileData.location?.coordinates?.[0]);

  const representativeChanged =
    profileFieldChanged(oldProfile.contactFirstName, profileData.contactFirstName) ||
    profileFieldChanged(oldProfile.contactLastName, profileData.contactLastName) ||
    profileFieldChanged(oldProfile.contactRole, profileData.contactRole);

  return {
    cacChanged,
    regulatoryChanged,
    premisesChanged,
    representativeChanged,

    /*
     * Ordinary editing must not silently
     * reset verification decisions or deactivate
     * previously authoritative KYC evidence.
     */

    update: {},
    invalidatedTypes: [],
  };
}

// ───────────────────── PROTECTED BUSINESS IDENTITY ─────────────────────

/*
 * Ordinary employer forms may include read-only
 * legal and regulatory fields.
 *
 * These fields are accepted only when their
 * submitted values agree with the stored values.
 *
 * Missing protected fields are permitted
 * because the service obtains them from the
 * persisted employer profile.
 *
 * Changes require a dedicated verification flow.
 */

function normalizeProtectedBusinessName(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : "";
}

function normalizeProtectedCACNumber(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

function normalizeProtectedRegulatoryNumber(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeProtectedType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function assertProtectedBusinessIdentityUnchanged(employerProfile, data) {
  const protectedFields = [
    {
      field: "type",
      normalize: normalizeProtectedType,
    },
    {
      field: "businessName",
      normalize: normalizeProtectedBusinessName,
    },
    {
      field: "cacRegistrationNumber",
      normalize: normalizeProtectedCACNumber,
    },
    {
      field: "regulatoryBody",
      normalize: normalizeProtectedType,
    },
    {
      field: "regulatoryRegistrationNumber",
      normalize: normalizeProtectedRegulatoryNumber,
    },
  ];

  for (const { field, normalize } of protectedFields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      continue;
    }

    if (normalize(data[field]) !== normalize(employerProfile[field])) {
      throw new Error(
        `${field} cannot be changed through ordinary business profile editing. Please contact support.`
      );
    }
  }
}

/*
 * Verification statuses, administrative decisions,
 * account restrictions and financial summaries
 * must never be changed from an employer's
 * ordinary business details form.
 *
 * Reject rather than silently applying or
 * ignoring explicit attempts to change them.
 *
 * This is defence in depth alongside the
 * explicit persistence allowlist below.
 */

function assertNoProtectedStateUpdates(data) {
  const protectedFields = [
    "user",
    "_id",
    "countryCode",
    "currency",

    "cacVerificationStatus",
    "cacVerificationMethod",
    "cacVerificationSource",
    "cacNameOnRecord",
    "cacVerifiedAt",
    "cacLastCheckedAt",
    "cacVerifiedBy",
    "cacVerificationNote",
    "cacRejectionReason",

    "regulatoryVerificationStatus",
    "regulatoryVerificationMethod",
    "regulatoryVerificationSource",
    "regulatoryNameOnRecord",
    "regulatoryVerifiedAt",
    "regulatoryLastCheckedAt",
    "regulatoryVerifiedBy",
    "regulatoryVerificationNote",
    "regulatoryRejectionReason",

    "employerApprovalStatus",
    "employerApprovalStatusUpdatedAt",
    "employerApprovalStatusUpdatedBy",
    "approvedToPostShiftsAt",
    "approvedToPostShiftsBy",
    "employerApprovalNote",
    "employerRejectionReason",

    "accountStatus",
    "accountStatusReason",
    "accountStatusUpdatedAt",
    "accountStatusUpdatedBy",

    "totalShiftsPaid",
    "totalAmountFunded",
    "totalAmountSpent",
    "totalProfessionalPayFunded",
    "totalPlatformFeesPaid",
    "totalRefundedAmount",

    "averageRating",
    "totalReviews",
    "reviews",
    "totalShiftsPosted",
    "totalShiftsCompleted",
    "activeShiftCount",
    "lastShiftPostedAt",
    "lastShiftCompletedAt",
  ];

  for (const field of protectedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      throw new Error(
        "Verification, financial and administrative fields cannot be updated through business details."
      );
    }
  }
}

// ───────────────────── EMPLOYER PROFILE INPUT SUPPORT ─────────────────────

/*
 * Build a complete input object using the
 * existing persisted employer profile.
 *
 * This allows partial contact-information
 * updates without requiring the applicant
 * to resubmit protected legal identity fields.
 *
 * The trusted business name and registration
 * numbers always come from the database.
 */

function buildEditableEmployerProfileInput(employerProfile, data) {
  const coordinates = getEmployerProfileCoordinates(employerProfile);

  return {
    type: employerProfile.type,

    businessName: employerProfile.businessName,
    businessEmail: data.businessEmail ?? employerProfile.businessEmail,

    cacRegistrationNumber: employerProfile.cacRegistrationNumber,

    regulatoryRegistrationNumber: employerProfile.regulatoryRegistrationNumber,

    state: data.state ?? employerProfile.state,
    lga: data.lga ?? employerProfile.lga,
    address: data.address ?? employerProfile.address,

    latitude: data.latitude ?? coordinates.latitude,
    longitude: data.longitude ?? coordinates.longitude,

    googlePlaceId: data.googlePlaceId ?? employerProfile.googlePlaceId,

    businessPhoneCode: data.businessPhoneCode ?? employerProfile.businessPhoneCode,
    businessPhone: data.businessPhone ?? employerProfile.businessPhone,

    contactFirstName: data.contactFirstName ?? employerProfile.contactFirstName,
    contactLastName: data.contactLastName ?? employerProfile.contactLastName,
    contactRole: data.contactRole ?? employerProfile.contactRole,
    contactPhoneCode: data.contactPhoneCode ?? employerProfile.contactPhoneCode,
    contactPhone: data.contactPhone ?? employerProfile.contactPhone,
  };
}

// ───────────────────── EMPLOYER DATA ACCESS ─────────────────────

/*
 * A loaded EmployerProfile does not establish
 * which authenticated user is requesting data.
 *
 * Dashboard and business-profile reads must
 * receive an authenticated actorUserId and
 * employerContext from their controller.
 *
 * Current database ownership or membership
 * is then checked independently.
 *
 * Permissions from employerContext are used
 * as an additional restriction, never as
 * a substitute for database authorisation.
 *
 * No platform administrator or professional
 * can acquire employer team access here.
 */

function createEmployerAccessError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

async function resolveEmployerDataAccess({ employerProfile, actorUserId, employerContext }) {
  if (!employerProfile?._id || !mongoose.isValidObjectId(employerProfile._id)) {
    throw new Error("Employer profile is required.");
  }

  if (!actorUserId || !mongoose.isValidObjectId(actorUserId)) {
    throw createEmployerAccessError("Authenticated employer access is required.");
  }

  if (!employerContext || employerContext.canViewBusinessProfile !== true) {
    throw createEmployerAccessError("Employer business access is required.");
  }

  const [actor, business] = await Promise.all([
    User.findOne({
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .lean(),

    EmployerProfile.findById(employerProfile._id).select("_id user accountStatus").lean(),
  ]);

  if (!actor || !business) {
    throw createEmployerAccessError("Employer business access is not available.");
  }

  const isPrimaryEmployer = String(business.user) === String(actor._id);

  const member = isPrimaryEmployer
    ? null
    : await EmployerMember.findOne({
        user: actor._id,
        business: business._id,
        accountStatus: "active",
        isCurrent: true,
      })
        .select("role branches")
        .lean();

  if (!isPrimaryEmployer && !member) {
    throw createEmployerAccessError("You do not have access to this employer business.");
  }

  const memberRole = member?.role || null;
  const isBusinessAdmin = memberRole === "admin";
  const isBranchManager = memberRole === "branch_manager";
  const isBranchStaff = memberRole === "branch_staff";

  if (!isPrimaryEmployer && !isBusinessAdmin && !isBranchManager && !isBranchStaff) {
    throw createEmployerAccessError("You do not have an authorised employer team role.");
  }

  const assignedBranchIds =
    isPrimaryEmployer || isBusinessAdmin
      ? []
      : (Array.isArray(member?.branches) ? member.branches : [])
          .map((assignment) => assignment?.branch)
          .filter((branchId) => mongoose.isValidObjectId(branchId));

  const isBusinessWide = isPrimaryEmployer || isBusinessAdmin;

  const canViewShifts = Boolean(
    employerContext.canViewShifts === true && (isBusinessWide || isBranchManager || isBranchStaff)
  );

  const canViewTeamMembers = Boolean(isBusinessWide && employerContext.canViewTeamMembers === true);

  const canInviteMembers = Boolean(
    isBusinessWide &&
    employerContext.canInviteMembers === true &&
    business.accountStatus === "active"
  );

  const canViewBranches = employerContext.canViewBranches === true;

  const canViewWallet = Boolean(
    (isBusinessWide || isBranchManager) && employerContext.canViewWallet === true
  );

  const canManageWallet = Boolean(isBusinessWide && employerContext.canManageWallet === true);

  const canPostShifts = Boolean(
    (isBusinessWide || isBranchManager) && employerContext.canPostShifts === true
  );

  return {
    actorUserId: actor._id,
    businessId: business._id,

    isPrimaryEmployer,
    isBusinessAdmin,
    isBranchManager,
    isBranchStaff,
    isBusinessWide,

    assignedBranchIds,

    canViewShifts,
    canPostShifts,
    canManageAllShifts: isBusinessWide && employerContext.canManageAllShifts === true,

    canViewBranches,
    canViewTeamMembers,
    canInviteMembers,

    canViewWallet,
    canManageWallet,
  };
}

function getRestrictedFundingReadiness() {
  const readiness = getEmployerFundingStatus(null);

  return {
    ...readiness,
    isEligible: false,
    displayStatus: "restricted",
    title: "Billing access restricted",
    reason: "insufficient_permissions",
    pendingMessage: "Billing information is available to authorised employer team members.",
    items: (readiness.items || []).map((item) => ({
      ...item,
      status: "restricted",
    })),
  };
}

function getRestrictedWalletReadiness() {
  const readiness = getWalletStatus(null);

  return {
    ...readiness,
    items: (readiness.items || []).map((item) => ({
      ...item,
      status: "restricted",
    })),
  };
}

class EmployerService {
  /**
   * Get all data needed for the employer dashboard.
   *
   * This method only reads dashboard data.
   * It does not create employer profiles, wallets, DVAs, shifts, or applications.
   *
   * The requesting employer's identity and
   * current permissions must be supplied.
   */

  // ───────────────────── EMPLOYER DASHBOARD ─────────────────────

  static async getDashboardData(employerProfile, options = {}) {
    if (!employerProfile) {
      throw new Error("Employer profile is required to load dashboard.");
    }

    const access = await resolveEmployerDataAccess({
      employerProfile,
      actorUserId: options.actorUserId,
      employerContext: options.employerContext,
    });

    /*
     * Wallet balance may be viewed by the
     * business owner, business administrators
     * and authorised branch managers.
     *
     * Dedicated payment account details
     * are available only to users authorised
     * to manage the employer wallet.
     *
     * Branch staff must not receive either
     * financial dataset merely by loading
     * the employer dashboard.
     */

    const [wallet, defaultDva] = await Promise.all([
      access.canViewWallet
        ? Wallet.findOne({
            ownerType: "employer",
            employer: access.businessId,
          }).lean()
        : Promise.resolve(null),

      access.canManageWallet
        ? DVA.findOne({
            provider: "paystack",
            employer: access.businessId,
            isDefault: true,
          }).lean()
        : Promise.resolve(null),
    ]);

    const employerKycStatus = getEmployerKycStatus(employerProfile);

    const walletReadiness = access.canViewWallet
      ? getWalletStatus(wallet)
      : getRestrictedWalletReadiness();

    const fundingReadiness = access.canManageWallet
      ? getEmployerFundingStatus(defaultDva)
      : getRestrictedFundingReadiness();

    const canPostShifts = Boolean(employerKycStatus.isEligible && access.canPostShifts);

    const accountStatus = employerProfile.accountStatus || "active";
    const employerApprovalStatus = employerProfile.employerApprovalStatus || "pending";

    const walletStatus = access.canViewWallet ? wallet?.status || "not_started" : "restricted";

    const fundingAccountStatus = access.canManageWallet
      ? fundingReadiness.displayStatus || "not_started"
      : "restricted";

    const walletBalance = access.canViewWallet ? (wallet?.availableBalance ?? 0) : null;

    /*
     * Business owners and business admins
     * can view business-wide shift summaries.
     *
     * Branch managers and branch staff may
     * see only shifts belonging to their
     * assigned branches.
     *
     * This prevents a branch-scoped user
     * from receiving another branch's
     * recent shift or application information.
     */

    const shiftScope = access.isBusinessWide
      ? { business: access.businessId }
      : {
          business: access.businessId,
          branch: { $in: access.assignedBranchIds },
        };

    const openShiftIds = access.canViewShifts
      ? await Shift.distinct("_id", {
          ...shiftScope,
          status: "open",
        })
      : [];

    const [
      openShiftsCount,
      applicationsToReviewCount,
      confirmedUpcomingShiftsCount,
      recentShiftsRaw,
    ] = await Promise.all([
      access.canViewShifts
        ? Shift.countDocuments({
            ...shiftScope,
            status: "open",
          })
        : Promise.resolve(0),

      access.canViewShifts
        ? ShiftApplication.countDocuments({
            status: "pending",
            shift: { $in: openShiftIds },
          })
        : Promise.resolve(0),

      access.canViewShifts
        ? Shift.countDocuments({
            ...shiftScope,
            status: { $in: ["confirmed", "assigned"] },
            startTime: { $gte: new Date() },
          })
        : Promise.resolve(0),

      access.canViewShifts
        ? Shift.find(shiftScope).sort({ createdAt: -1 }).limit(10).populate("branch", "name").lean()
        : Promise.resolve([]),
    ]);

    const stats = {
      openShifts: openShiftsCount ?? 0,
      applicationsToReview: applicationsToReviewCount ?? 0,
      confirmedUpcomingShifts: confirmedUpcomingShiftsCount ?? 0,
      walletBalance,
    };

    const safeRecentShiftsRaw = Array.isArray(recentShiftsRaw) ? recentShiftsRaw : [];

    const recentShifts = safeRecentShiftsRaw.map((shift) => {
      const status = shift.status || "open";

      return {
        _id: shift._id,
        referenceCode: shift.referenceCode || "-",
        roleTitle: shift.roleTitle || "-",
        branchName: shift.branch?.name || "-",
        startDateLabel: this.formatDate(shift.startTime),
        hourlyRateFormatted: this.formatMinorUnitMoney(shift.hourlyRate ?? 0),
        totalApplications: shift.totalApplications ?? 0,
        status,
        statusLabel: formatStatus(status),
        statusBadgeClass: badgeClass[status] || "badge-light",
      };
    });

    const statuses = {
      account: accountStatus,
      employerApproval: employerApprovalStatus,
      wallet: walletStatus,
      fundingAccount: fundingAccountStatus,
      canPostShifts,
    };

    const setupChecklist = {
      profileCompleted: true,

      walletCreated: access.canViewWallet ? Boolean(wallet) : false,
      walletActive: access.canViewWallet && walletStatus === "active",

      fundingAccountCreated: access.canManageWallet ? Boolean(defaultDva) : false,
      fundingAccountReady: access.canManageWallet && fundingReadiness.isEligible,

      accountActive: accountStatus === "active",
      employerApproved: employerApprovalStatus === "approved",

      canPostShifts,
    };

    const dashboardView = this.buildDashboardView({
      employerKycStatus,
      walletReadiness,
      fundingReadiness,
      walletBalance,
      canPostShifts,
      canViewWallet: access.canViewWallet,
      canManageWallet: access.canManageWallet,
    });

    return {
      employerProfile,
      wallet,
      defaultDva,

      employerPermissions: access,

      statuses,
      setupChecklist,

      employerKycStatus,
      walletReadiness,
      fundingReadiness,

      dashboardView,
      stats,
      recentShifts,
    };
  }

  // ───────────────────── DASHBOARD PRESENTATION ─────────────────────

  static buildDashboardView({
    employerKycStatus,
    walletReadiness,
    fundingReadiness,
    walletBalance,
    canPostShifts,
    canViewWallet = false,
    canManageWallet = false,
  }) {
    const accountAlertType = employerKycStatus.isEligible ? "success" : "warning";
    const accountAlert = this.getAlertView(accountAlertType);

    const walletItem = walletReadiness.items?.[0] || { status: "restricted" };
    const fundingItem = fundingReadiness.items?.[0] || { status: "restricted" };

    return {
      accountAlertClass: accountAlert.alertClass,
      accountIconClass: accountAlert.iconClass,

      accountTitle: employerKycStatus.title,
      accountMessage: employerKycStatus.isEligible
        ? employerKycStatus.successMessage
        : employerKycStatus.pendingMessage,

      businessProfileStatusLabel: "Completed",
      businessProfileBadgeClass: "badge-light-success",
      businessProfileBadgeLabel: "Ready",

      walletStatusLabel: canViewWallet ? formatStatus(walletItem.status) : "Restricted",

      walletBadgeClass: canViewWallet
        ? badgeClass[walletItem.status] || "badge-light-warning"
        : "badge-light-secondary",

      walletBadgeLabel: canViewWallet ? formatStatus(walletItem.status) : "Restricted",

      fundingAccountStatusLabel: canManageWallet ? formatStatus(fundingItem.status) : "Restricted",

      fundingBadgeClass: canManageWallet
        ? badgeClass[fundingItem.status] || "badge-light-warning"
        : "badge-light-secondary",

      fundingBadgeLabel: canManageWallet
        ? fundingReadiness.isEligible
          ? "Ready"
          : "Pending"
        : "Restricted",

      approvalStatusLabel: formatStatus(
        employerKycStatus.items.find((item) => item.label === "Employer approval")?.status ||
          "pending"
      ),
      approvalBadgeClass:
        badgeClass[
          employerKycStatus.items.find((item) => item.label === "Employer approval")?.status ||
            "pending"
        ] || "badge-light-warning",
      approvalBadgeLabel: formatStatus(
        employerKycStatus.items.find((item) => item.label === "Employer approval")?.status ||
          "pending"
      ),

      showFundingNotice: canManageWallet && !fundingReadiness.isEligible,
      fundingTitle: fundingReadiness.title,
      fundingMessage: canManageWallet
        ? fundingReadiness.isEligible
          ? fundingReadiness.successMessage
          : fundingReadiness.pendingMessage
        : "Billing information is restricted.",

      fundingReason: canManageWallet ? fundingReadiness.reason || null : "insufficient_permissions",

      walletBalanceFormatted: canViewWallet ? this.formatMinorUnitMoney(walletBalance) : "—",

      walletCtaLabel: canManageWallet
        ? walletBalance > 0
          ? "View Wallet"
          : "Fund Wallet"
        : canViewWallet
          ? "View Wallet"
          : "Restricted",

      walletCtaBadgeClass:
        canManageWallet && walletBalance > 0 ? "badge-light-success" : "badge-light-warning",

      canViewWallet,
      canManageWallet,

      canPostShifts,
      postShiftLockedMessage: "Shift posting will be available after admin approval",
    };
  }

  static getAlertView(type) {
    if (type === "success") {
      return {
        alertClass: "bg-light-success border-success",
        iconClass: "ki-check-circle text-success",
      };
    }

    if (type === "danger") {
      return {
        alertClass: "bg-light-danger border-danger",
        iconClass: "ki-cross-circle text-danger",
      };
    }

    if (type === "info") {
      return {
        alertClass: "bg-light-info border-info",
        iconClass: "ki-information-5 text-info",
      };
    }

    return {
      alertClass: "bg-light-warning border-warning",
      iconClass: "ki-information-5 text-warning",
    };
  }

  static formatDate(value) {
    if (!value) return "-";

    return new Date(value).toLocaleDateString("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  static formatMinorUnitMoney(value) {
    return money.fromMinorUnit(value || 0).toLocaleString("en-NG", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  // ───────────────────── BRANCH COUNTS ─────────────────────

  static async getBranchStatusCounts(businessId) {
    const [active, inactive, all] = await Promise.all([
      Branch.countDocuments({
        business: businessId,
        isActive: true,
      }),

      Branch.countDocuments({
        business: businessId,
        isActive: false,
      }),

      Branch.countDocuments({
        business: businessId,
      }),
    ]);

    return {
      active,
      inactive,
      all,
    };
  }

  // ───────────────────── MEMBER COUNTS ─────────────────────

  static async getMemberStatusCounts(businessId) {
    const [active, restricted, suspended, removed, current, all] = await Promise.all([
      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "active",
        isCurrent: true,
      }),

      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "restricted",
        isCurrent: true,
      }),

      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "suspended",
        isCurrent: true,
      }),

      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "removed",
        isCurrent: false,
      }),

      EmployerMember.countDocuments({
        business: businessId,
        isCurrent: true,
        accountStatus: { $ne: "removed" },
      }),

      EmployerMember.countDocuments({
        business: businessId,
      }),
    ]);

    return {
      active,
      restricted,
      suspended,
      removed,
      current,
      all,
    };
  }

  // ───────────────────── BUSINESS PROFILE DATA ─────────────────────

  static async getBusinessProfileData(employerProfile, options = {}) {
    if (!employerProfile) {
      throw new Error("Employer profile is required to load business profile.");
    }

    const access = await resolveEmployerDataAccess({
      employerProfile,
      actorUserId: options.actorUserId,
      employerContext: options.employerContext,
    });

    const employerProfileId = access.businessId;

    const activeTab = options.activeTab || "overview";
    const inviteStatus = options.inviteStatus || "active";

    const branchStatus = normalizeBranchStatusFilter(options.branchStatus);
    const memberStatus = normalizeMemberStatusFilter(options.memberStatus);

    /*
     * Sensitive business profile tabs must
     * be authorised at the service layer.
     *
     * The controller performs the first
     * check, but direct service calls must
     * not bypass these permissions.
     */

    if (activeTab === "team" && !access.canViewTeamMembers) {
      throw createEmployerAccessError("You do not have permission to view employer team members.");
    }

    if (activeTab === "invites" && !access.canInviteMembers) {
      throw createEmployerAccessError("You do not have permission to view employer invitations.");
    }

    if (activeTab === "branches" && !access.canViewBranches) {
      throw createEmployerAccessError("You do not have permission to view employer branches.");
    }

    const branchQuery = getBranchStatusQuery({
      businessId: employerProfileId,
      branchStatus,
    });

    const memberQuery = getMemberStatusQuery({
      businessId: employerProfileId,
      memberStatus,
    });

    const activeCurrentMemberQuery = {
      business: employerProfileId,
      accountStatus: "active",
      isCurrent: true,
    };

    /*
     * Do not retrieve team records,
     * invitations or financial records
     * for users who lack the corresponding
     * permissions.
     *
     * Restricted datasets are not merely
     * hidden after retrieval. Their queries
     * are skipped entirely.
     *
     * Team member details and branch manager
     * personal information are available
     * only to business owners and authorised
     * business administrators.
     *
     * Wallet read permission is separate
     * from payment-account management.
     */

    const [
      branches,
      branchStatusCounts,
      members,
      activeCurrentMembers,
      memberStatusCounts,
      inviteView,
      pendingInvitesCount,
      wallet,
      defaultDva,
    ] = await Promise.all([
      access.canViewBranches
        ? Branch.find(branchQuery).sort({ isActive: -1, createdAt: -1 }).lean()
        : Promise.resolve([]),

      access.canViewBranches
        ? this.getBranchStatusCounts(employerProfileId)
        : Promise.resolve({ active: 0, inactive: 0, all: 0 }),

      access.canViewTeamMembers
        ? EmployerMember.find(memberQuery)
            .populate("user", "firstName lastName displayName email photo accountStatus")
            .populate("branches.branch", "name address state lga")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),

      access.canViewTeamMembers
        ? EmployerMember.find(activeCurrentMemberQuery)
            .populate("user", "firstName lastName displayName email photo accountStatus")
            .populate("branches.branch", "name address state lga")
            .sort({ createdAt: -1 })
            .lean()
        : Promise.resolve([]),

      access.canViewTeamMembers
        ? this.getMemberStatusCounts(employerProfileId)
        : Promise.resolve({
            active: 0,
            restricted: 0,
            suspended: 0,
            removed: 0,
            current: 0,
            all: 0,
          }),

      access.canInviteMembers
        ? InviteService.getBusinessInviteView({
            businessId: employerProfileId,
            status: inviteStatus,
          })
        : Promise.resolve(null),

      access.canInviteMembers
        ? InviteService.countBusinessInvites({
            businessId: employerProfileId,
            status: "pending",
          })
        : Promise.resolve(0),

      access.canViewWallet
        ? Wallet.findOne({
            ownerType: "employer",
            employer: employerProfileId,
          }).lean()
        : Promise.resolve(null),

      access.canManageWallet
        ? DVA.findOne({
            provider: "paystack",
            employer: employerProfileId,
            isDefault: true,
          }).lean()
        : Promise.resolve(null),
    ]);

    return this.buildBusinessProfileView({
      employerProfile,
      activeTab,

      access,

      branchStatus,
      branchStatusCounts,

      memberStatus,
      branches,
      members,
      activeCurrentMembers,
      memberStatusCounts,

      inviteView,
      pendingInvitesCount,

      wallet,
      defaultDva,
    });
  }

  // ───────────────────── BUSINESS PROFILE PRESENTATION ─────────────────────

  static buildBusinessProfileView({
    employerProfile,
    activeTab,

    access,

    branchStatus,
    branchStatusCounts,

    memberStatus,
    branches,
    members,
    activeCurrentMembers,
    memberStatusCounts,

    inviteView,
    pendingInvitesCount,

    wallet,
    defaultDva,
  }) {
    const canViewTeamMembers = access?.canViewTeamMembers === true;
    const canInviteMembers = access?.canInviteMembers === true;
    const canViewWallet = access?.canViewWallet === true;
    const canManageWallet = access?.canManageWallet === true;

    const businessProfileBranches = shapeBusinessProfileBranches(branches, activeCurrentMembers, {
      canViewManagerDetails: canViewTeamMembers,
    });

    const branchManagerOptions = canViewTeamMembers
      ? buildBranchManagerOptions(activeCurrentMembers)
      : [];

    const businessProfileMembers = canViewTeamMembers ? shapeBusinessProfileMembers(members) : [];

    const branchStatusFilters = buildBranchStatusFilters(branchStatus, branchStatusCounts);

    const activeBranchStatusFilter = branchStatusFilters.find((filter) => filter.isActive);

    const activeBranchStatusLabel = activeBranchStatusFilter?.label || "Active";

    const branchStatusView = {
      activeStatus: branchStatus,
      activeFilterLabel: activeBranchStatusLabel,
      filters: branchStatusFilters,
      counts: branchStatusCounts,

      hasAnyBranches: (branchStatusCounts.all || 0) > 0,

      emptyTitle:
        branchStatus === "all"
          ? "No Branches Found"
          : `No ${activeBranchStatusLabel} Branches Found`,

      emptyMessage:
        branchStatus === "active"
          ? "Active branches will appear here."
          : branchStatus === "inactive"
            ? "Inactive branches will appear here."
            : "Branches will appear here.",
    };

    const memberStatusFilters = canViewTeamMembers
      ? buildMemberStatusFilters(memberStatus, memberStatusCounts)
      : [];

    const activeMemberStatusFilter = memberStatusFilters.find((filter) => filter.isActive);

    const activeMemberStatusLabel = activeMemberStatusFilter?.label || "Active";

    const memberStatusView = {
      activeStatus: memberStatus,
      activeFilterLabel: activeMemberStatusLabel,
      filters: memberStatusFilters,
    };

    const businessDetailsView = buildBusinessDetailsView(employerProfile);

    const verificationView = buildVerificationView(employerProfile);

    const fundingReadiness = canManageWallet
      ? getEmployerFundingStatus(defaultDva)
      : getRestrictedFundingReadiness();

    const hasActiveFundingAccount = Boolean(
      canManageWallet &&
      defaultDva &&
      defaultDva.status === "active" &&
      defaultDva.bankName &&
      defaultDva.accountName &&
      defaultDva.accountNumber
    );

    const billingSetupStatus = !canManageWallet
      ? "restricted"
      : hasActiveFundingAccount
        ? "available"
        : fundingReadiness.displayStatus || "not_started";

    const billingSetup = {
      isAvailable: hasActiveFundingAccount,

      status: billingSetupStatus,
      badgeClass: badgeClass[billingSetupStatus] || "badge-light-warning",
      badgeLabel: canManageWallet ? formatStatus(billingSetupStatus) : "Restricted",

      title: "Billing Setup",
      subtitle: "Payment account for employer wallet top-up",

      accountTitle: "Dedicated Payment Account",

      message: !canManageWallet
        ? "Billing information is available to authorised business administrators."
        : hasActiveFundingAccount
          ? "Transfers to this account are credited to your employer wallet."
          : fundingReadiness.pendingMessage,

      footerMessage:
        "Shift funding, wallet balance, top-ups, refunds, and statements will be managed from Billing.",
    };

    const businessProfileStats = {
      totalBranches: branchStatusCounts.all || 0,
      activeBranches: branchStatusCounts.active || 0,

      totalMembers: canViewTeamMembers ? memberStatusCounts.current || 0 : null,
      activeMembers: canViewTeamMembers ? memberStatusCounts.active || 0 : null,
      removedMembers: canViewTeamMembers ? memberStatusCounts.removed || 0 : null,

      pendingInvites: canInviteMembers ? pendingInvitesCount || 0 : null,
    };

    const accountStatus = employerProfile.accountStatus || "active";

    const employerApprovalStatus = employerProfile.employerApprovalStatus || "pending";

    const cacVerificationStatus = employerProfile.cacVerificationStatus || "pending";

    const regulatoryVerificationStatus = employerProfile.regulatoryVerificationStatus || "pending";

    const businessProfileSummary = {
      businessName: employerProfile.businessName || "Business Profile",

      businessEmail: employerProfile.businessEmail || "No business email added",

      initials: getBusinessInitials(employerProfile.businessName),

      totalBranches: businessProfileStats.totalBranches,
      activeBranches: businessProfileStats.activeBranches,

      totalMembers: businessProfileStats.totalMembers,
      activeMembers: businessProfileStats.activeMembers,
      pendingInvites: businessProfileStats.pendingInvites,

      accountStatus,
      accountStatusLabel: formatStatus(accountStatus),
      accountStatusBadgeClass: badgeClass[accountStatus] || "badge-light-primary",

      employerApprovalStatus,
      employerApprovalStatusLabel: formatStatus(employerApprovalStatus),
      employerApprovalStatusBadgeClass: badgeClass[employerApprovalStatus] || "badge-light-warning",

      cacVerificationStatus,
      cacVerificationStatusLabel: formatStatus(cacVerificationStatus),
      cacVerificationStatusBadgeClass: badgeClass[cacVerificationStatus] || "badge-light-warning",

      regulatoryVerificationStatus,
      regulatoryVerificationStatusLabel: formatStatus(regulatoryVerificationStatus),
      regulatoryVerificationStatusBadgeClass:
        badgeClass[regulatoryVerificationStatus] || "badge-light-warning",
    };

    return {
      employerProfile,
      employerPermissions: access,

      businessProfileStats,
      businessProfileSummary,

      businessDetailsView,
      verificationView,

      billingSetup,
      fundingReadiness,

      activeTab,
      branchStatusView,
      memberStatusView,

      branches: businessProfileBranches,
      branchManagerOptions,
      members: businessProfileMembers,

      inviteView: canInviteMembers ? inviteView : null,

      wallet: canViewWallet ? wallet : null,
      defaultDva: canManageWallet ? defaultDva : null,
    };
  }

  // ───────────────────── BUSINESS PROFILE AUTHORISATION ─────────────────────

  /*
   * Business profile edits must be authorised
   * using an authenticated user ID supplied
   * by the controller, never by the request body.
   *
   * The business owner may edit ordinary details.
   *
   * A current, active employer team administrator
   * may also edit ordinary details.
   *
   * Branch managers and ordinary branch staff
   * do not receive business-wide profile editing
   * rights through this method.
   *
   * Administrative verification and legal identity
   * changes are not permitted here, even for
   * the business owner or team administrators.
   */

  static async assertCanEditBusinessDetails({ employerProfile, actorUserId, session }) {
    if (!mongoose.isValidObjectId(actorUserId)) {
      throw new Error("An authenticated user is required to update business details.");
    }

    if (employerProfile.accountStatus !== "active") {
      throw new Error("This business account is not eligible for profile editing.");
    }

    const actor = await User.findOne({
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .session(session);

    if (!actor) {
      throw new Error("Your account is not eligible to update business details.");
    }

    const isOwner = String(employerProfile.user) === String(actorUserId);

    if (isOwner) {
      return true;
    }

    const membership = await EmployerMember.exists({
      business: employerProfile._id,
      user: actorUserId,
      role: "admin",
      accountStatus: "active",
      isCurrent: true,
    }).session(session);

    if (!membership) {
      throw new Error("You are not authorised to update this business profile.");
    }

    return true;
  }

  // ───────────────────── BUSINESS DETAILS UPDATE ─────────────────────

  /*
   * Ordinary business profile editing supports:
   *
   * - Business email and phone;
   * - Contact phone and contact details;
   * - Unverified premises-location corrections.
   *
   * Protected business identity includes:
   *
   * - Registered legal business name;
   * - CAC registration number;
   * - Employer facility type;
   * - Regulatory body;
   * - Regulatory registration number.
   *
   * These identity fields cannot be changed
   * through ordinary business profile editing.
   *
   * Verified premises cannot be moved by changing
   * an address or map location in this form.
   *
   * Such changes require a separate, authorised
   * regulatory verification workflow.
   *
   * Changing a previously reviewed representative
   * also requires a separate authorisation workflow.
   *
   * The service must not reset restricted/rejected
   * administrative decisions or clear KYC history
   * to make an account appear unverified again.
   */

  static async updateBusinessDetails({ employerProfileId, actorUserId, data } = {}) {
    if (!mongoose.isValidObjectId(employerProfileId)) {
      throw new Error("A valid employer profile is required.");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Valid business profile details are required.");
    }

    const session = await mongoose.startSession();

    let employerProfile;

    try {
      await session.withTransaction(async () => {
        // ───────── LOAD CURRENT PROFILE ─────────

        employerProfile = await EmployerProfile.findById(employerProfileId).session(session);

        if (!employerProfile) {
          throw new Error("Employer profile not found.");
        }

        // ───────── AUTHORISE THE EDITOR ─────────

        await this.assertCanEditBusinessDetails({
          employerProfile,
          actorUserId,
          session,
        });

        // ───────── PROTECT VERIFICATION AND APPROVAL STATE ─────────

        assertNoProtectedStateUpdates(data);

        assertProtectedBusinessIdentityUnchanged(employerProfile, data);

        // ───────── BUILD VALIDATED PROFILE DATA ─────────

        /*
         * Legal business identity is injected
         * from trusted persisted profile fields.
         *
         * The applicant cannot override the
         * verified registered legal name.
         *
         * ProfileInputService continues to validate
         * the ordinary contact and location fields.
         */

        const input = buildEditableEmployerProfileInput(employerProfile, data);

        const profileData = ProfileInputService.buildEmployerProfileData(input);

        // ───────── ASSESS MATERIAL CHANGES ─────────

        const changes = getBusinessDetailsVerificationReset(employerProfile, profileData);

        if (changes.cacChanged || changes.regulatoryChanged) {
          throw new Error(
            "Business registration or regulatory identity changes require a separate verification process."
          );
        }

        // ───────── PROTECT REGULATORY PREMISES ─────────

        /*
         * A location change after premises have
         * been reviewed cannot be treated as an
         * ordinary contact-information update.
         *
         * This prevents an employer from retaining
         * an old PCN or facility verification while
         * changing the premises it refers to.
         *
         * Location corrections before any regulatory
         * review may still be made normally.
         */

        if (changes.premisesChanged) {
          const regulatoryReviewStarted =
            employerProfile.regulatoryVerificationStatus !== "pending" ||
            employerProfile.regulatoryVerificationMethod !== "not_checked" ||
            employerProfile.regulatoryVerificationSource !== "not_checked" ||
            Boolean(employerProfile.regulatoryLastCheckedAt) ||
            Boolean(employerProfile.regulatoryVerifiedAt);

          if (regulatoryReviewStarted || employerProfile.employerApprovalStatus !== "pending") {
            throw new Error(
              "Changes to reviewed business premises require additional regulatory review. Please contact support."
            );
          }

          /*
           * A state change may alter the regulator
           * applicable to a clinic or hospital.
           *
           * Never silently replace the stored
           * regulatory identity in an ordinary
           * profile edit.
           */

          if (profileData.regulatoryBody !== employerProfile.regulatoryBody) {
            throw new Error(
              "This location change affects your regulatory body and requires a separate verification process."
            );
          }
        }

        // ───────── PROTECT REVIEWED REPRESENTATIVES ─────────

        /*
         * Changes to contact person names or
         * declared authority may affect existing
         * representative approval.
         *
         * These changes are allowed while the
         * employer is awaiting its initial review.
         *
         * Once an administrative decision exists,
         * the representative must be changed
         * through a separate reviewed workflow.
         *
         * Ordinary contact phone changes remain
         * independently editable.
         */

        if (changes.representativeChanged && employerProfile.employerApprovalStatus !== "pending") {
          throw new Error(
            "Changing a reviewed business representative requires administrative review. Please contact support."
          );
        }

        // ───────── BUILD ALLOWED UPDATES ─────────

        /*
         * Persist only explicitly allowed fields.
         *
         * Do not spread an entire request body or
         * validation result into the EmployerProfile.
         *
         * This protects legal identity, CAC/PCN
         * verification status, administrative
         * restrictions and financial summaries.
         */

        const updates = {
          businessEmail: profileData.businessEmail,

          businessPhoneCode: profileData.businessPhoneCode,
          businessPhone: profileData.businessPhone,

          address: profileData.address,
          googlePlaceId: profileData.googlePlaceId,
          location: profileData.location,
          state: profileData.state,
          lga: profileData.lga,

          contactFirstName: profileData.contactFirstName,
          contactLastName: profileData.contactLastName,
          contactRole: profileData.contactRole,
          contactPhoneCode: profileData.contactPhoneCode,
          contactPhone: profileData.contactPhone,
        };

        // ───────── SAVE BUSINESS DETAILS ─────────

        /*
         * All registered legal identity fields,
         * verification statuses, approval decisions
         * and financial records remain untouched.
         *
         * Ordinary edits do not deactivate
         * authoritative KYC evidence or erase
         * previous administrator decisions.
         */

        employerProfile.set(updates);

        await employerProfile.save({ session });
      });

      return employerProfile;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = EmployerService;
