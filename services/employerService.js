// services/employerService.js

const Shift = require("../models/Shift");
const ShiftApplication = require("../models/ShiftApplication");
const Wallet = require("../models/Wallet");
const DVA = require("../models/DVA");
const Branch = require("../models/Branch");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");

const InviteService = require("./inviteService");
const ProfileInputService = require("./profileInputService");

const {
  getEmployerKycStatus,
  getWalletStatus,
  getEmployerFundingStatus,
  badgeClass,
  formatStatus,
} = require("../utils/statusHelper");

const allowedMemberStatusFilters = ["active", "restricted", "suspended", "removed", "all"];

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
    isCurrent: { $ne: false },
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
    const isCurrent = member.isCurrent !== false;
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
      if (member.isCurrent === false) return false;
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

function shapeBusinessProfileBranches(branches = [], members = []) {
  const managersByBranchId = new Map();

  members.forEach((member) => {
    if (member.isCurrent === false) return;
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

  return branches.map((branch) => {
    const branchId = String(branch._id);
    const managers = managersByBranchId.get(branchId) || [];
    const primaryManager = managers[0] || null;
    const coordinates = getBranchCoordinates(branch);

    return {
      ...branch,

      managers,

      managerMemberId: primaryManager ? primaryManager.id : "",

      managerName:
        managers.length > 0
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

function buildVerificationView(employerProfile) {
  const cacVerificationStatus = employerProfile.cacVerificationStatus || "pending";

  const regulatoryVerificationStatus = employerProfile.regulatoryVerificationStatus || "pending";

  const employerApprovalStatus = employerProfile.employerApprovalStatus || "pending";

  const accountStatus = employerProfile.accountStatus || "active";

  return {
    items: [
      {
        title: "CAC Verification",
        description: "Confirms the business registration number submitted during onboarding.",
        status: cacVerificationStatus,
        statusLabel: formatStatus(cacVerificationStatus),
        badgeClass: badgeClass[cacVerificationStatus] || "badge-light-warning",
        note: employerProfile.cacVerificationNote || employerProfile.cacRejectionReason || "",
      },
      {
        title: "Facility Verification",
        description: "Confirms the facility or regulatory registration number.",
        status: regulatoryVerificationStatus,
        statusLabel: formatStatus(regulatoryVerificationStatus),
        badgeClass: badgeClass[regulatoryVerificationStatus] || "badge-light-warning",
        note:
          employerProfile.regulatoryVerificationNote ||
          employerProfile.regulatoryRejectionReason ||
          "",
      },
      {
        title: "Employer Approval",
        description: "Controls whether this employer can post shifts.",
        status: employerApprovalStatus,
        statusLabel: formatStatus(employerApprovalStatus),
        badgeClass: badgeClass[employerApprovalStatus] || "badge-light-warning",
        note: employerProfile.employerApprovalNote || employerProfile.employerRejectionReason || "",
      },
      {
        title: "Account Status",
        description: "Shows whether the employer account is allowed to operate normally.",
        status: accountStatus,
        statusLabel: formatStatus(accountStatus),
        badgeClass: badgeClass[accountStatus] || "badge-light-success",
        note: employerProfile.accountStatusReason || "",
      },
    ],
  };
}

function profileFieldChanged(oldValue, newValue) {
  return String(oldValue || "").trim() !== String(newValue || "").trim();
}

function getBusinessDetailsVerificationReset(oldProfile, profileData) {
  const update = {};

  const cacChanged = profileFieldChanged(
    oldProfile.cacRegistrationNumber,
    profileData.cacRegistrationNumber
  );

  const regulatoryChanged =
    profileFieldChanged(oldProfile.type, profileData.type) ||
    profileFieldChanged(oldProfile.regulatoryBody, profileData.regulatoryBody) ||
    profileFieldChanged(
      oldProfile.regulatoryRegistrationNumber,
      profileData.regulatoryRegistrationNumber
    );

  if (cacChanged) {
    update.cacVerificationStatus = "pending";
    update.cacVerifiedAt = null;
    update.cacVerifiedBy = null;
    update.cacVerificationNote = null;
    update.cacRejectionReason = null;
  }

  if (regulatoryChanged) {
    update.regulatoryVerificationStatus = "pending";
    update.regulatoryVerifiedAt = null;
    update.regulatoryVerifiedBy = null;
    update.regulatoryVerificationNote = null;
    update.regulatoryRejectionReason = null;
  }

  if (cacChanged || regulatoryChanged) {
    update.employerApprovalStatus = "pending";
    update.approvedToPostShiftsAt = null;
    update.approvedToPostShiftsBy = null;
    update.employerApprovalNote = null;
    update.employerRejectionReason = null;
  }

  return update;
}

class EmployerService {
  /**
   * Get all data needed for the employer dashboard.
   *
   * This method only reads dashboard data.
   * It does not create employer profiles, wallets, DVAs, shifts, or applications.
   */
  static async getDashboardData(employerProfile) {
    if (!employerProfile) {
      throw new Error("Employer profile is required to load dashboard.");
    }

    const [wallet, defaultDva] = await Promise.all([
      Wallet.findOne({
        ownerType: "employer",
        employer: employerProfile._id,
      }).lean(),

      DVA.findOne({
        provider: "paystack",
        employer: employerProfile._id,
        isDefault: true,
      }).lean(),
    ]);

    const employerKycStatus = getEmployerKycStatus(employerProfile);
    const walletReadiness = getWalletStatus(wallet);
    const fundingReadiness = getEmployerFundingStatus(defaultDva);

    const canPostShifts = employerKycStatus.isEligible;

    const accountStatus = employerProfile.accountStatus || "active";
    const employerApprovalStatus = employerProfile.employerApprovalStatus || "pending";

    const walletStatus = wallet?.status || "not_started";
    const fundingAccountStatus = fundingReadiness.displayStatus || "not_started";
    const walletBalance = wallet?.availableBalance ?? 0;

    const openShiftIds = await Shift.distinct("_id", {
      business: employerProfile._id,
      status: "open",
    });

    const [
      openShiftsCount,
      applicationsToReviewCount,
      confirmedUpcomingShiftsCount,
      recentShiftsRaw,
    ] = await Promise.all([
      Shift.countDocuments({
        business: employerProfile._id,
        status: "open",
      }),

      ShiftApplication.countDocuments({
        status: "pending",
        shift: { $in: openShiftIds },
      }),

      Shift.countDocuments({
        business: employerProfile._id,
        status: { $in: ["confirmed", "assigned"] },
        startTime: { $gte: new Date() },
      }),

      Shift.find({
        business: employerProfile._id,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("branch", "name")
        .lean(),
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
        hourlyRateFormatted: this.formatMoney(shift.hourlyRate ?? 0),
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

      walletCreated: Boolean(wallet),
      walletActive: walletStatus === "active",

      fundingAccountCreated: Boolean(defaultDva),
      fundingAccountReady: fundingReadiness.isEligible,

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
    });

    return {
      employerProfile,
      wallet,
      defaultDva,

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

  static buildDashboardView({
    employerKycStatus,
    walletReadiness,
    fundingReadiness,
    walletBalance,
    canPostShifts,
  }) {
    const accountAlertType = employerKycStatus.isEligible ? "success" : "warning";
    const accountAlert = this.getAlertView(accountAlertType);

    const walletItem = walletReadiness.items[0];
    const fundingItem = fundingReadiness.items[0];

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

      walletStatusLabel: formatStatus(walletItem.status),
      walletBadgeClass: badgeClass[walletItem.status] || "badge-light-warning",
      walletBadgeLabel: formatStatus(walletItem.status),

      fundingAccountStatusLabel: formatStatus(fundingItem.status),
      fundingAccountBadgeClass: badgeClass[fundingItem.status] || "badge-light-warning",
      fundingAccountBadgeLabel: fundingReadiness.isEligible ? "Ready" : "Pending",

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

      showFundingNotice: !fundingReadiness.isEligible,
      fundingTitle: fundingReadiness.title,
      fundingMessage: fundingReadiness.isEligible
        ? fundingReadiness.successMessage
        : fundingReadiness.pendingMessage,
      fundingReason: fundingReadiness.reason || null,

      walletBalanceFormatted: this.formatMoney(walletBalance),
      walletCtaLabel: walletBalance > 0 ? "View Wallet" : "Fund Wallet",
      walletCtaBadgeClass: walletBalance > 0 ? "badge-light-success" : "badge-light-warning",

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

  static formatMoney(value) {
    return Number(value || 0).toLocaleString();
  }

  static async getMemberStatusCounts(businessId) {
    const [active, restricted, suspended, removed, current, all] = await Promise.all([
      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "active",
        isCurrent: { $ne: false },
      }),

      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "restricted",
        isCurrent: { $ne: false },
      }),

      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "suspended",
        isCurrent: { $ne: false },
      }),

      EmployerMember.countDocuments({
        business: businessId,
        accountStatus: "removed",
        isCurrent: false,
      }),

      EmployerMember.countDocuments({
        business: businessId,
        isCurrent: { $ne: false },
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

  static async getBusinessProfileData(employerProfile, options = {}) {
    if (!employerProfile) {
      throw new Error("Employer profile is required to load business profile.");
    }

    const employerProfileId = employerProfile._id;

    const activeTab = options.activeTab || "overview";
    const inviteStatus = options.inviteStatus || "active";

    const memberStatus = normalizeMemberStatusFilter(options.memberStatus);

    const memberQuery = getMemberStatusQuery({
      businessId: employerProfileId,
      memberStatus,
    });

    const activeCurrentMemberQuery = {
      business: employerProfileId,
      accountStatus: "active",
      isCurrent: { $ne: false },
    };

    const [
      branches,
      members,
      activeCurrentMembers,
      memberStatusCounts,
      inviteView,
      pendingInvitesCount,
      wallet,
      defaultDva,
    ] = await Promise.all([
      Branch.find({
        business: employerProfileId,
      })
        .sort({ isActive: -1, createdAt: -1 })
        .lean(),

      EmployerMember.find(memberQuery)
        .populate("user", "firstName lastName displayName email photo accountStatus")
        .populate("branches.branch", "name address state lga")
        .sort({ createdAt: -1 })
        .lean(),

      EmployerMember.find(activeCurrentMemberQuery)
        .populate("user", "firstName lastName displayName email photo accountStatus")
        .populate("branches.branch", "name address state lga")
        .sort({ createdAt: -1 })
        .lean(),

      this.getMemberStatusCounts(employerProfileId),

      InviteService.getBusinessInviteView({
        businessId: employerProfileId,
        status: inviteStatus,
      }),

      InviteService.countBusinessInvites({
        businessId: employerProfileId,
        status: "pending",
      }),

      Wallet.findOne({
        ownerType: "employer",
        employer: employerProfileId,
      }).lean(),

      DVA.findOne({
        provider: "paystack",
        employer: employerProfileId,
        isDefault: true,
      }).lean(),
    ]);

    return this.buildBusinessProfileView({
      employerProfile,
      activeTab,
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

  static buildBusinessProfileView({
    employerProfile,
    activeTab,
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
    const businessProfileBranches = shapeBusinessProfileBranches(branches, activeCurrentMembers);

    const branchManagerOptions = buildBranchManagerOptions(activeCurrentMembers);

    const businessProfileMembers = shapeBusinessProfileMembers(members);

    const activeBranches = businessProfileBranches.filter((branch) => branch.isActive);

    const memberStatusFilters = buildMemberStatusFilters(memberStatus, memberStatusCounts);

    const activeMemberStatusFilter = memberStatusFilters.find((filter) => filter.isActive);

    const memberStatusView = {
      activeStatus: memberStatus,
      activeFilterLabel: activeMemberStatusFilter?.label || "Active",
      filters: memberStatusFilters,
    };

    const businessDetailsView = buildBusinessDetailsView(employerProfile);

    const verificationView = buildVerificationView(employerProfile);

    const fundingReadiness = getEmployerFundingStatus(defaultDva);

    const hasActiveFundingAccount = Boolean(
      defaultDva &&
      defaultDva.status === "active" &&
      defaultDva.bankName &&
      defaultDva.accountName &&
      defaultDva.accountNumber
    );

    const billingSetupStatus = hasActiveFundingAccount
      ? "available"
      : fundingReadiness.displayStatus || "not_started";

    const billingSetup = {
      isAvailable: hasActiveFundingAccount,

      status: billingSetupStatus,
      badgeClass: badgeClass[billingSetupStatus] || "badge-light-warning",
      badgeLabel: formatStatus(billingSetupStatus),

      title: "Billing Setup",
      subtitle: "Payment account for employer wallet top-up",

      accountTitle: "Dedicated Payment Account",

      message: hasActiveFundingAccount
        ? "Transfers to this account are credited to your employer wallet."
        : fundingReadiness.pendingMessage,

      footerMessage:
        "Shift funding, wallet balance, top-ups, refunds, and statements will be managed from Billing.",
    };

    const businessProfileStats = {
      totalBranches: businessProfileBranches.length,
      activeBranches: activeBranches.length,

      totalMembers: memberStatusCounts.current || 0,
      activeMembers: memberStatusCounts.active || 0,
      removedMembers: memberStatusCounts.removed || 0,

      pendingInvites: pendingInvitesCount || 0,
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
      businessProfileStats,
      businessProfileSummary,

      businessDetailsView,
      verificationView,

      billingSetup,
      fundingReadiness,

      activeTab,
      memberStatusView,

      branches: businessProfileBranches,
      branchManagerOptions,
      members: businessProfileMembers,

      inviteView,

      wallet,
      defaultDva,
    };
  }

  static async updateBusinessDetails({ employerProfileId, data }) {
    if (!employerProfileId) {
      throw new Error("Employer profile is required.");
    }

    const employerProfile = await EmployerProfile.findById(employerProfileId);

    if (!employerProfile) {
      throw new Error("Employer profile not found.");
    }

    const profileData = ProfileInputService.buildEmployerProfileData(data);

    const verificationReset = getBusinessDetailsVerificationReset(employerProfile, profileData);

    Object.assign(employerProfile, profileData, verificationReset);

    await employerProfile.save();

    return employerProfile;
  }
}

module.exports = EmployerService;
