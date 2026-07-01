// services/professionalService.js

const Shift = require("../models/Shift");
const ShiftApplication = require("../models/ShiftApplication");
const Wallet = require("../models/Wallet");
const BankAccount = require("../models/BankAccount");

const {
  getProfessionalKycStatus,
  getProfessionalPayoutStatus,
  getWalletStatus,
  badgeClass,
  formatStatus,
} = require("../utils/statusHelper");

class ProfessionalService {
  /**
   * Get all data needed for the professional dashboard.
   *
   * This method only reads dashboard data.
   * It does not create profiles, wallets, payout accounts, shifts, or applications.
   */
  static async getDashboardData(professionalProfile) {
    if (!professionalProfile) {
      throw new Error("Professional profile is required to load dashboard.");
    }

    const professionalId = professionalProfile._id;

    /**
     * Professional wallet and payout account lookup.
     *
     * Wallet:
     * - ownerType: "professional"
     * - professional: ProfessionalProfile _id
     *
     * Bank account:
     * - ownerType: "professional"
     * - professional: ProfessionalProfile _id
     * - isActive: true
     */
    const [wallet, payoutAccount] = await Promise.all([
      Wallet.findOne({
        ownerType: "professional",
        professional: professionalId,
      }).lean(),

      BankAccount.findOne({
        ownerType: "professional",
        professional: professionalId,
        isActive: true,
      }).lean(),
    ]);

    const professionalKycStatus = getProfessionalKycStatus(professionalProfile);

    const payoutReadiness = getProfessionalPayoutStatus(professionalProfile, payoutAccount);

    const walletReadiness = getWalletStatus(wallet);

    /**
     * For now, professionals can apply for shifts only when profile checks pass.
     */
    const canApplyForShifts = professionalKycStatus.isEligible;

    const walletStatus = wallet?.status || "not_started";
    const walletBalance = wallet?.availableBalance ?? 0;

    const [
      applicationsSubmittedCount,
      pendingApplicationsCount,
      upcomingShiftsCount,
      completedShiftsCount,
      recentApplicationsRaw,
    ] = await Promise.all([
      ShiftApplication.countDocuments({
        professional: professionalId,
      }),

      ShiftApplication.countDocuments({
        professional: professionalId,
        status: "pending",
      }),

      Shift.countDocuments({
        assignedProfessional: professionalId,
        status: { $in: ["assigned", "confirmed", "in_progress"] },
        startTime: { $gte: new Date() },
      }),

      Shift.countDocuments({
        assignedProfessional: professionalId,
        status: "completed",
      }),

      ShiftApplication.find({
        professional: professionalId,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate({
          path: "shift",
          select: "referenceCode roleTitle startTime hourlyRate status branch",
          populate: {
            path: "branch",
            select: "name",
          },
        })
        .lean(),
    ]);

    const stats = {
      applicationsSubmitted: applicationsSubmittedCount ?? 0,
      pendingApplications: pendingApplicationsCount ?? 0,
      upcomingShifts: upcomingShiftsCount ?? 0,
      completedShifts: completedShiftsCount ?? 0,
      walletBalance,
    };

    const safeRecentApplicationsRaw = Array.isArray(recentApplicationsRaw)
      ? recentApplicationsRaw
      : [];

    const recentApplications = safeRecentApplicationsRaw.map((application) => {
      const applicationStatus = application.status || "pending";
      const shift = application.shift || {};
      const shiftStatus = shift.status || "missing";

      return {
        _id: application._id,

        shiftId: shift._id || null,
        referenceCode: shift.referenceCode || "-",
        roleTitle: shift.roleTitle || "-",
        branchName: shift.branch?.name || "-",
        startDateLabel: this.formatDate(shift.startTime),
        hourlyRateFormatted: this.formatMoney(shift.hourlyRate ?? 0),

        applicationStatus,
        applicationStatusLabel: formatStatus(applicationStatus),
        applicationStatusBadgeClass: badgeClass[applicationStatus] || "badge-light",

        shiftStatus,
        shiftStatusLabel: formatStatus(shiftStatus),
        shiftStatusBadgeClass: badgeClass[shiftStatus] || "badge-light-warning",
      };
    });

    const statuses = {
      account: professionalProfile.accountStatus || "active",
      professionalApproval: professionalProfile.professionalApprovalStatus || "pending",
      marketplace: professionalProfile.marketplaceStatus || "hidden",
      wallet: walletStatus,
      payoutAccount: payoutAccount?.verificationStatus || "not_started",
      canApplyForShifts,
    };

    const setupChecklist = {
      profileCompleted: true,

      licenceVerified: professionalProfile.licenceVerificationStatus === "verified",
      identityVerified: professionalProfile.identityVerificationStatus === "verified",
      professionalApproved: professionalProfile.professionalApprovalStatus === "approved",
      accountActive: professionalProfile.accountStatus === "active",
      marketplaceVisible: professionalProfile.marketplaceStatus === "visible",

      walletCreated: Boolean(wallet),
      walletActive: walletStatus === "active",

      payoutAccountAdded: Boolean(payoutAccount),
      payoutAccountVerified: payoutAccount?.verificationStatus === "verified",
      payoutReady: payoutReadiness.isEligible,

      canApplyForShifts,
    };

    const dashboardView = this.buildDashboardView({
      professionalKycStatus,
      payoutReadiness,
      walletReadiness,
      walletBalance,
      canApplyForShifts,
    });

    return {
      professionalProfile,
      wallet,
      payoutAccount,

      statuses,
      setupChecklist,

      professionalKycStatus,
      payoutReadiness,
      walletReadiness,

      dashboardView,
      stats,
      recentApplications,
    };
  }

  static buildDashboardView({
    professionalKycStatus,
    payoutReadiness,
    walletReadiness,
    walletBalance,
    canApplyForShifts,
  }) {
    const profileAlertType = professionalKycStatus.isEligible ? "success" : "warning";

    const profileAlert = this.getAlertView(profileAlertType);

    const walletItem = walletReadiness.items[0];

    const marketplaceItem = professionalKycStatus.items.find(
      (item) => item.label === "Marketplace visibility"
    ) || { status: "hidden" };

    const approvalItem = professionalKycStatus.items.find(
      (item) => item.label === "Professional approval"
    ) || { status: "pending" };

    const payoutAccountItem = payoutReadiness.items.find(
      (item) => item.label === "Payout account"
    ) || {
      status: "not_started",
    };

    return {
      profileAlertClass: profileAlert.alertClass,
      profileIconClass: profileAlert.iconClass,

      profileTitle: professionalKycStatus.title,
      profileMessage: professionalKycStatus.isEligible
        ? professionalKycStatus.successMessage
        : professionalKycStatus.pendingMessage,

      profileStatusLabel: professionalKycStatus.isEligible ? "Verified" : "Under Review",
      profileBadgeClass: professionalKycStatus.isEligible
        ? "badge-light-success"
        : "badge-light-warning",
      profileBadgeLabel: professionalKycStatus.isEligible ? "Ready" : "Pending",

      marketplaceStatusLabel: formatStatus(marketplaceItem.status),
      marketplaceBadgeClass: badgeClass[marketplaceItem.status] || "badge-light-warning",
      marketplaceBadgeLabel: formatStatus(marketplaceItem.status),

      approvalStatusLabel: formatStatus(approvalItem.status),
      approvalBadgeClass: badgeClass[approvalItem.status] || "badge-light-warning",
      approvalBadgeLabel: formatStatus(approvalItem.status),

      payoutStatusLabel: payoutReadiness.isEligible
        ? "Ready"
        : formatStatus(payoutAccountItem.status),
      payoutBadgeClass: payoutReadiness.isEligible
        ? "badge-light-success"
        : badgeClass[payoutAccountItem.status] || "badge-light-warning",
      payoutBadgeLabel: payoutReadiness.isEligible
        ? "Ready"
        : formatStatus(payoutAccountItem.status),

      showPayoutNotice: !payoutReadiness.isEligible,
      payoutTitle: payoutReadiness.title,
      payoutMessage: payoutReadiness.isEligible
        ? payoutReadiness.successMessage
        : payoutReadiness.pendingMessage,

      walletStatusLabel: formatStatus(walletItem.status),
      walletBadgeClass: badgeClass[walletItem.status] || "badge-light-warning",
      walletBadgeLabel: formatStatus(walletItem.status),

      walletBalanceFormatted: this.formatMoney(walletBalance),
      walletCtaLabel: walletBalance > 0 ? "View Wallet" : "Wallet",
      walletCtaBadgeClass: walletBalance > 0 ? "badge-light-success" : "badge-light-warning",

      canApplyForShifts,
      applyShiftLockedMessage: "Shift applications will be available after profile verification",
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
}

module.exports = ProfessionalService;
