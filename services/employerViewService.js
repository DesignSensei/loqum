// services/employerViewService.js

const ProfileInputService = require("./profileInputService");
const money = require("../utils/money");

const {
  getEmployerKycStatus,
  getWalletStatus,
  getEmployerFundingStatus,
  badgeClass,
  formatStatus,
} = require("../utils/statusHelper");

function getBusinessInitials(businessName) {
  if (!businessName || typeof businessName !== "string") {
    return "LP";
  }

  const words = businessName.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return "LP";
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
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

function getMemberDisplayName(member) {
  const user = member.user;

  if (!user) return "Unknown member";
  if (user.displayName) return user.displayName;

  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();

  return fullName || user.email || "Unknown member";
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
  if (!assignment || !assignment.branch) return null;

  return String(assignment.branch._id || assignment.branch);
}

function getBranchCoordinates(branch) {
  const coordinates = branch?.location?.coordinates;

  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return { longitude: "", latitude: "" };
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
    { value: "owner", label: "Owner", isSelected: activeRole === "owner" },
    { value: "director", label: "Director", isSelected: activeRole === "director" },
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
    return { longitude: "", latitude: "" };
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
      contactPhoneCode: employerProfile.contactPhoneCode || "",
      contactPhone: employerProfile.contactPhone || "",
    },
  };
}

function formatVerificationDate(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function getEmployerFacingVerificationNote(status) {
  const messages = {
    pending:
      "CAC verification has not been completed. Contact Loqum Support if you have already finished onboarding.",
    verified: "Your CAC registration has been verified.",
    needs_review:
      "Your CAC registration requires further review. Contact Loqum Support for assistance.",
    rejected: "Your CAC registration could not be verified. Contact Loqum Support for assistance.",
  };

  return messages[status] || "Contact Loqum Support about your CAC verification status.";
}

function buildVerificationView(employerProfile, branchItems = []) {
  const cacVerificationStatus = employerProfile.cacVerificationStatus || "pending";

  const trustedRegisteredName =
    cacVerificationStatus === "verified"
      ? employerProfile.cacNameOnRecord || "Not available"
      : "Not yet verified";

  const cacItem = {
    key: "cac",
    title: "CAC Verification",
    description: "Confirms the registered business identity supplied by the CAC provider.",

    status: cacVerificationStatus,
    statusLabel: formatStatus(cacVerificationStatus),
    badgeClass: badgeClass[cacVerificationStatus] || "badge-light-warning",

    note: getEmployerFacingVerificationNote(cacVerificationStatus),

    details: [
      {
        label: "CAC registration number",
        value: employerProfile.cacRegistrationNumber || "Not available",
      },
      {
        label: "Registered business name",
        value: trustedRegisteredName,
      },
    ],

    identifierLocked: true,
    identityNotice:
      cacVerificationStatus === "verified"
        ? "Registered business details are locked after verification. Contact Loqum Support if a correction is required."
        : "CAC registration details cannot be edited on this page. Contact Loqum Support for corrections.",

    dateLabel: cacVerificationStatus === "verified" ? "Verified on" : "Last checked",

    dateValue: formatVerificationDate(
      cacVerificationStatus === "verified"
        ? employerProfile.cacVerifiedAt || employerProfile.cacLastCheckedAt
        : employerProfile.cacLastCheckedAt
    ),
  };

  return {
    supportMessage:
      "CAC registration details are locked after verification. Contact Loqum Support for corrections. " +
      "Facility permits are assessed separately for each branch.",

    items: [cacItem, ...branchItems],
    cac: cacItem,
    branches: branchItems,
    hasBranches: branchItems.length > 0,
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

function buildBranchPermitVerificationItems(rows = [], access = {}) {
  return rows.map(({ branch, readiness }) => {
    const requirements = Array.isArray(readiness?.requirements) ? readiness.requirements : [];

    const policyUnavailable = String(readiness?.reason || "").startsWith("FACILITY_PERMIT_POLICY_");

    const permitsComplete = Boolean(
      !policyUnavailable &&
      requirements.length > 0 &&
      requirements.every((item) => item.satisfied === true)
    );

    const missingRequirementKeys = Array.isArray(readiness?.missingRequirementKeys)
      ? readiness.missingRequirementKeys
      : [];

    const status = policyUnavailable ? "needs_review" : permitsComplete ? "verified" : "pending";

    const branchActive = branch.isActive === true;

    // Viewing an assigned branch does not grant branch-level posting authority.
    const canManageThisBranch = Boolean(
      access.isBusinessWide === true ||
      (access.isBranchManager === true &&
        Array.isArray(access.managedBranchIds) &&
        access.managedBranchIds.some((branchId) => String(branchId) === String(branch._id)))
    );

    const canPostShifts = Boolean(
      readiness?.canPost === true &&
      access.canPostShifts === true &&
      branchActive &&
      permitsComplete &&
      canManageThisBranch
    );

    let note;

    if (policyUnavailable) {
      note = "Facility-permit requirements are unavailable. Contact Loqum Support.";
    } else if (permitsComplete) {
      note = branchActive
        ? "All currently required facility permits are in force for this branch."
        : "Required facility permits are in force, but this branch is inactive.";
    } else {
      note =
        "One or more required, current facility permits are missing or invalid for this branch.";
    }

    const operationalNotice = policyUnavailable
      ? "Permit readiness cannot be confirmed until applicable regulatory requirements are available."
      : !branchActive && permitsComplete
        ? "This branch's permits are current, but new shifts and permanent Jobs cannot be published while it is inactive."
        : missingRequirementKeys.length > 0
          ? "Outstanding permit requirements must be resolved before this branch can publish new shifts or permanent Jobs."
          : "";

    return {
      key: `branch:${String(branch._id)}`,
      branchId: String(branch._id),
      title: `${branch.name || "Branch"} — Facility Permits`,
      description: "Permit readiness for this branch and its current premises.",

      status,
      statusLabel: status === "verified" ? "Permits Current" : formatStatus(status),
      badgeClass: badgeClass[status] || "badge-light-warning",

      note,
      operationalNotice,

      details: requirements.map((item) => ({
        label: item.authorityName || item.requirementKey,
        value: item.satisfied === true ? "Current" : "Action required",
      })),

      hasDetails: requirements.length > 0,
      showRequirementsUnavailable: requirements.length === 0 && !policyUnavailable,

      identifierLocked: false,
      dateLabel: "",
      dateValue: "",

      branchActive,
      branchStatusLabel: branchActive ? "Active" : "Inactive",
      branchStatusBadgeClass: branchActive ? "badge-light-success" : "badge-light-secondary",

      permitsComplete,
      regulatoryReady: permitsComplete,
      regulatoryReadinessLabel: policyUnavailable
        ? "Unavailable"
        : permitsComplete
          ? "Ready"
          : "Not Ready",
      regulatoryReadinessBadgeClass: permitsComplete
        ? "badge-light-success"
        : "badge-light-warning",

      canPostShifts,
      missingRequirementKeys,
      hasMissingRequirements: missingRequirementKeys.length > 0,
      policyUnavailable,

      showInactiveNotice: !branchActive && permitsComplete,
      showPolicyNotice: policyUnavailable,
      showMissingNotice: !policyUnavailable && missingRequirementKeys.length > 0,

      // Only active business-wide owner/admin accounts can manage permits.
      showManagePermitsAction:
        access.isBusinessWide === true && access.businessAccountStatus === "active",
      managePermitsUrl:
        access.isBusinessWide === true && access.businessAccountStatus === "active"
          ? `/employer/branches/${String(branch._id)}/permits/manage`
          : null,
    };
  });
}

class EmployerViewService {
  static buildBusinessProfilePageView({
    employerProfile,
    activeTab,
    employerContext,
    employerPermissions,
  }) {
    const access = employerPermissions;

    const canManageBranches = Boolean(
      access.isBusinessWide === true &&
      access.canViewBranches === true &&
      employerContext.canManageBranches === true
    );

    const showOverview = activeTab === "overview";

    const showClosureLink =
      employerContext?.isPrimaryEmployer === true &&
      ["active", "closing"].includes(employerProfile.accountStatus);

    const showClosure = showOverview && showClosureLink;
    const showBusinessDetails = activeTab === "business-details";
    const showVerification = activeTab === "verification";

    const showBranches = Boolean(activeTab === "branches" && access.canViewBranches === true);

    const showTeamMembers = Boolean(activeTab === "team" && access.canViewTeamMembers === true);

    const showInvites = Boolean(activeTab === "invites" && access.canInviteMembers === true);

    return {
      countryCode: String(employerProfile.countryCode || "NG")
        .trim()
        .toLowerCase(),

      showOverview,
      showClosureLink,
      showClosure,
      showBusinessDetails,
      showVerification,
      showBranches,
      showTeamMembers,
      showInvites,

      showAddBranchModal: showBranches && canManageBranches,
      showViewBranchModal: showBranches,
      showEditBranchModal: showBranches && canManageBranches,

      showTeamMemberModals: showTeamMembers,
      showInviteModals: showInvites,
    };
  }

  static getBusinessProfileScripts(activeTab, googleMapsBrowserKey) {
    const scripts = ['<script src="/js/employer/business-profile.js"></script>'];

    if (activeTab === "branches" || activeTab === "business-details") {
      scripts.unshift('<script src="/js/location-picker.js"></script>');

      scripts.push(`
      <script
        async
        defer
        src="https://maps.googleapis.com/maps/api/js?key=${googleMapsBrowserKey}&libraries=places&callback=initBusinessProfileAddressAutocomplete"
      ></script>
    `);
    }

    if (activeTab === "team") {
      scripts.push('<script src="/js/employer/team-members.js"></script>');
    }

    if (activeTab === "invites") {
      scripts.push('<script src="/js/employer/invite-member.js"></script>');
    }

    return scripts.join("\n");
  }

  static buildDashboardData({ employerProfile, access, queries }) {
    const {
      wallet,
      defaultDva,
      eligibleBranchCount,
      openShiftsCount,
      applicationsToReviewCount,
      confirmedUpcomingShiftsCount,
      recentShiftsRaw,
    } = queries;

    const employerKycStatus = getEmployerKycStatus({
      ...employerProfile,
      cacVerificationStatus: access.cacVerificationStatus,
      accountStatus: access.businessAccountStatus,
    });

    const walletReadiness = access.canViewWallet
      ? getWalletStatus(wallet)
      : getRestrictedWalletReadiness();

    const fundingReadiness = access.canManageWallet
      ? getEmployerFundingStatus(defaultDva)
      : getRestrictedFundingReadiness();

    const canPostShifts = Boolean(
      employerKycStatus.isEligible && access.canPostShifts && eligibleBranchCount > 0
    );

    const accountStatus = access.businessAccountStatus || "not_started";

    const walletStatus = access.canViewWallet ? wallet?.status || "not_started" : "restricted";

    const fundingAccountStatus = access.canManageWallet
      ? fundingReadiness.displayStatus || "not_started"
      : "restricted";

    const walletBalance = access.canViewWallet ? (wallet?.availableBalance ?? 0) : null;

    const stats = {
      openShifts: openShiftsCount ?? 0,
      applicationsToReview: applicationsToReviewCount ?? 0,
      confirmedUpcomingShifts: confirmedUpcomingShiftsCount ?? 0,
      walletBalance,
    };

    const recentShifts = (Array.isArray(recentShiftsRaw) ? recentShiftsRaw : []).map((shift) => {
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

    const dashboardView = this.buildDashboardView({
      employerKycStatus,
      walletReadiness,
      fundingReadiness,
      walletBalance,
      canPostShifts,
      eligibleBranchCount,
      preliminaryCanPostShifts: access.canPostShifts,
      canViewWallet: access.canViewWallet,
      canManageWallet: access.canManageWallet,
    });

    return {
      employerProfile,
      wallet,
      defaultDva,
      employerPermissions: access,

      statuses: {
        account: accountStatus,
        wallet: walletStatus,
        fundingAccount: fundingAccountStatus,
        canPostShifts,
      },

      setupChecklist: {
        profileCompleted: true,

        walletCreated: access.canViewWallet ? Boolean(wallet) : false,
        walletActive: access.canViewWallet && walletStatus === "active",

        fundingAccountCreated: access.canManageWallet ? Boolean(defaultDva) : false,
        fundingAccountReady: access.canManageWallet && fundingReadiness.isEligible,

        accountActive: accountStatus === "active",
        hasEligibleBranch: eligibleBranchCount > 0,

        canPostShifts,
      },

      employerKycStatus,
      walletReadiness,
      fundingReadiness,

      dashboardView,
      stats,
      recentShifts,
    };
  }

  static buildDashboardView({
    employerKycStatus,
    walletReadiness,
    fundingReadiness,
    walletBalance,
    canPostShifts,
    eligibleBranchCount = 0,
    preliminaryCanPostShifts = false,
    canViewWallet = false,
    canManageWallet = false,
  }) {
    const accountAlertType = employerKycStatus.isEligible ? "success" : "warning";

    const accountAlert = this.getAlertView(accountAlertType);

    const walletItem = walletReadiness.items?.[0] || {
      status: "restricted",
    };

    const fundingItem = fundingReadiness.items?.[0] || {
      status: "restricted",
    };

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

      cacStatusLabel: formatStatus(employerKycStatus.items?.[0]?.status || "pending"),
      cacBadgeClass: badgeClass[employerKycStatus.items?.[0]?.status] || "badge-light-warning",

      eligibleBranchCount,

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

      postShiftLockedMessage: !employerKycStatus.cacVerified
        ? "CAC registration must be verified before posting shifts."
        : !employerKycStatus.accountActive
          ? "Your business account must be active before posting shifts."
          : !preliminaryCanPostShifts
            ? "Shift posting is currently unavailable for this account or team role."
            : "At least one active branch with all required current facility permits is needed to post shifts.",
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

  static buildBusinessProfileView({
    employerProfile,
    activeTab,
    access,

    branchStatus,
    branchStatusCounts,
    branchVerificationItems = [],

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

    const verificationView = {
      ...buildVerificationView(
        {
          cacRegistrationNumber: employerProfile.cacRegistrationNumber,
          cacNameOnRecord: employerProfile.cacNameOnRecord,
          cacVerifiedAt: employerProfile.cacVerifiedAt,
          cacLastCheckedAt: employerProfile.cacLastCheckedAt,
          accountStatus: access.businessAccountStatus,
          cacVerificationStatus: access.cacVerificationStatus,
        },
        branchVerificationItems
      ),

      canViewBranches: access?.canViewBranches === true,
      canManageBusinessDetails: access?.canManageBusinessProfile === true,
      canManagePermits:
        access?.isBusinessWide === true && access?.businessAccountStatus === "active",
    };

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

    const accountStatus = access.businessAccountStatus || "not_started";

    const cacVerificationStatus = access.cacVerificationStatus || "pending";

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

      cacVerificationStatus,
      cacVerificationStatusLabel: formatStatus(cacVerificationStatus),
      cacVerificationStatusBadgeClass: badgeClass[cacVerificationStatus] || "badge-light-warning",
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

  static buildBranchPermitVerificationItems(rows, access) {
    return buildBranchPermitVerificationItems(rows, access);
  }
}

module.exports = EmployerViewService;
