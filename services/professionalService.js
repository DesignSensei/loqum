// services/professionalService.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftApplication = require("../models/ShiftApplication");
const Wallet = require("../models/Wallet");
const BankAccount = require("../models/BankAccount");

const ProfessionalVerificationService = require("./professionalVerificationService");

const { PROFESSIONAL_UNAVAILABLE_STATUSES } = require("../constants/shiftApplication");

const {
  getProfessionalKycStatus,
  getProfessionalPayoutStatus,
  getWalletStatus,
  badgeClass,
  formatStatus,
} = require("../utils/statusHelper");

const money = require("../utils/money");

const EXPECTED_VERIFICATION_EVIDENCE_ERRORS = new Set([
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_CONFLICTING_REVIEWS",
  "PROFESSIONAL_VERIFICATION_UNSUPPORTED_PROFESSIONAL_TYPE",
]);

class ProfessionalService {
  // ───────────────────── VERIFICATION READINESS ─────────────────────

  /**
   * Read-only dashboard eligibility assessment.
   *
   * The five profile statuses remain presentation
   * indicators, not authoritative verification evidence.
   *
   * Completed verification additionally requires:
   *
   * - Trusted production NIN evidence;
   * - Administrative NIN documentary review;
   * - Manual professional council licence verification;
   * - Correct council verification source;
   * - Matching NIN and council-confirmed legal names;
   * - Valid active administrative review records.
   *
   * Shift application availability also reflects
   * the professional's availability. Licence expiry alone
   * does not revoke marketplace eligibility.
   *
   * No new paid NIN/BVN lookup is performed.
   *
   * This method does not approve a professional or
   * change any verification state.
   */

  static async getDashboardEligibility(professionalProfile) {
    const unavailable = {
      verificationReady: false,
      canApplyForShifts: false,
    };

    if (!professionalProfile?._id || !professionalProfile?.user) {
      return unavailable;
    }

    const summary = getProfessionalKycStatus(professionalProfile);

    if (!summary.isEligible) {
      return unavailable;
    }

    const session = await mongoose.startSession();

    try {
      let result = unavailable;

      await session.withTransaction(async () => {
        result = unavailable;

        // Re-read current state rather than trusting
        // the previously attached profile document.
        const currentProfile = await ProfessionalProfile.findOne({
          _id: professionalProfile._id,
          user: professionalProfile.user,
        }).session(session);

        if (!currentProfile) {
          return;
        }

        const currentSummary = getProfessionalKycStatus(currentProfile);

        if (!currentSummary.isEligible) {
          return;
        }

        const readiness = ProfessionalVerificationService.getVerificationReadiness(currentProfile);

        if (readiness.verificationReady !== true) {
          return;
        }

        const approvalTime = currentProfile.approvedForShiftsAt
          ? new Date(currentProfile.approvedForShiftsAt).getTime()
          : NaN;

        if (
          !Number.isFinite(approvalTime) ||
          approvalTime > Date.now() ||
          !mongoose.isValidObjectId(currentProfile.approvedForShiftsBy) ||
          String(currentProfile.approvedForShiftsBy) === String(currentProfile.user)
        ) {
          return;
        }

        const trusted = await ProfessionalVerificationService.getTrustedOnboardingNIN({
          profile: currentProfile,
          session,
        });

        await ProfessionalVerificationService.getVerifiedReviewEvidence({
          profile: currentProfile,
          trusted,
          session,
        });

        const availabilityAllowed = !PROFESSIONAL_UNAVAILABLE_STATUSES.includes(
          currentProfile.availabilityStatus
        );

        result = {
          verificationReady: true,
          canApplyForShifts: availabilityAllowed,
        };
      });

      return result;
    } catch (error) {
      if (EXPECTED_VERIFICATION_EVIDENCE_ERRORS.has(error?.code)) {
        return unavailable;
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── DASHBOARD DATA ─────────────────────

  /**
   * Get all data needed for the professional dashboard.
   *
   * This method only reads dashboard data.
   * It does not create profiles, wallets, payout
   * accounts, shifts, or applications.
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

    // Authoritative verification and general
    // application eligibility are separate from
    // the five-status presentation summary.

    const eligibility = await this.getDashboardEligibility(professionalProfile);

    const verificationReady = eligibility.verificationReady;

    const canApplyForShifts = eligibility.canApplyForShifts;

    const walletStatus = wallet?.status || "not_started";
    const walletBalance = wallet?.availableBalance ?? 0;
    const now = new Date();

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

      ShiftOccurrence.countDocuments({
        assignedProfessional: professionalId,
        assignmentStatus: "assigned",
        status: "scheduled",
        startTime: { $gte: now },
      }),

      ShiftOccurrence.countDocuments({
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
        hourlyRateFormatted: this.formatMinorUnitMoney(shift.hourlyRate ?? 0),

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
      verificationReady,
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

  // ───────────────────── DASHBOARD PRESENTATION ─────────────────────

  static buildDashboardView({
    professionalKycStatus,
    payoutReadiness,
    walletReadiness,
    walletBalance,
    verificationReady,
    canApplyForShifts,
  }) {
    const profileAlertType = verificationReady ? "success" : "warning";

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
    ) || { status: "not_started" };

    const profileMessage = !verificationReady
      ? professionalKycStatus.pendingMessage
      : canApplyForShifts
        ? professionalKycStatus.successMessage
        : "Your profile verification is complete. " +
          "Shift applications also require an available professional status.";

    return {
      profileAlertClass: profileAlert.alertClass,
      profileIconClass: profileAlert.iconClass,

      profileTitle: professionalKycStatus.title,
      profileMessage,

      profileStatusLabel: verificationReady ? "Verified" : "Under Review",

      profileBadgeClass: verificationReady ? "badge-light-success" : "badge-light-warning",

      profileBadgeLabel: verificationReady ? "Ready" : "Pending",

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

      walletBalanceFormatted: this.formatMinorUnitMoney(walletBalance),

      walletCtaLabel: walletBalance > 0 ? "View Wallet" : "Wallet",

      walletCtaBadgeClass: walletBalance > 0 ? "badge-light-success" : "badge-light-warning",

      canApplyForShifts,

      applyShiftLockedMessage: verificationReady
        ? "Update your availability to apply for shifts."
        : "Shift applications will be available after profile verification",
    };
  }

  // ───────────────────── ALERT PRESENTATION ─────────────────────

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
      alertClass: "bg-light-warning",
      iconClass: "ki-information-5 text-info",
    };
  }

  // ───────────────────── FORMAT HELPERS ─────────────────────

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
}

module.exports = ProfessionalService;
