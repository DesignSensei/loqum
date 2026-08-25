// utils/statusHelper.js

const badgeClass = {
  pending: "badge-light-warning",
  not_started: "badge-light-warning",
  verified: "badge-light-success",
  approved: "badge-light-success",
  rejected: "badge-light-danger",
  restricted: "badge-light-danger",
  needs_review: "badge-light-info",

  active: "badge-light-success",
  removed: "badge-light-danger",
  suspended: "badge-light-danger",
  frozen: "badge-light-danger",
  closed: "badge-light-dark",

  visible: "badge-light-success",
  hidden: "badge-light-warning",
  paused: "badge-light-warning",

  available: "badge-light-success",
  unavailable: "badge-light-warning",
  busy: "badge-light-info",

  failed: "badge-light-warning",
  missing: "badge-light-warning",
  setup_pending: "badge-light-warning",

  processing: "badge-light-warning",
  success: "badge-light-success",
  reversed: "badge-light-info",
  deactivated: "badge-light-dark",

  // Shift funding
  pending_funding: "badge-light-warning",
  unpaid: "badge-light-warning",
  expired: "badge-light-dark",

  // Shift lifecycle
  open: "badge-light-primary",
  scheduled: "badge-light-info",
  assigned: "badge-light-warning",
  confirmed: "badge-light-info",
  in_progress: "badge-light-warning",
  pending_settlement: "badge-light-info",
  completed: "badge-light-success",
  cancelled: "badge-light-danger",
  disputed: "badge-light-danger",
  no_show: "badge-light-danger",

  // Refund lifecycle
  not_eligible: "badge-light-secondary",

  deleted: "badge-light-danger",
  revoked: "badge-light-danger",
};
const formatStatus = (status) => {
  if (!status) return "Unknown";

  return String(status)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

exports.getProfessionalKycStatus = (profile) => {
  const items = [
    {
      label: "Licence verification",
      status: profile.licenceVerificationStatus,
      passed: profile.licenceVerificationStatus === "verified",
    },
    {
      label: "Identity verification",
      status: profile.identityVerificationStatus,
      passed: profile.identityVerificationStatus === "verified",
    },
    {
      label: "Professional approval",
      status: profile.professionalApprovalStatus,
      passed: profile.professionalApprovalStatus === "approved",
    },
    {
      label: "Account status",
      status: profile.accountStatus,
      passed: profile.accountStatus === "active",
    },
    {
      label: "Marketplace visibility",
      status: profile.marketplaceStatus,
      passed: profile.marketplaceStatus === "visible",
    },
  ];

  const isEligible = items.every((item) => item.passed);

  return {
    title: "Profile Verification",
    isEligible,
    successMessage: "Your profile is verified. You can apply for shifts.",
    pendingMessage:
      "Your profile is under review. You’ll be able to apply for shifts once your licence, identity, approval, and account checks are complete.",
    items,
    badgeClass,
    formatStatus,
  };
};

exports.getProfessionalPayoutStatus = (profile, payoutAccount) => {
  const items = [
    {
      label: "BVN verification",
      status: profile.bvnVerification?.status || "not_started",
      passed: profile.bvnVerification?.status === "verified",
    },
    {
      label: "Payout account",
      status: payoutAccount?.verificationStatus || "not_started",
      passed: payoutAccount?.verificationStatus === "verified",
    },
  ];

  const isEligible = items.every((item) => item.passed);

  return {
    title: "Payout Readiness",
    isEligible,
    successMessage: "Your payout setup is complete. You can receive withdrawals.",
    pendingMessage:
      "Your payout setup is not complete yet. Please complete your BVN verification and payout account verification before withdrawing funds.",
    items,
    badgeClass,
    formatStatus,
  };
};

exports.getEmployerKycStatus = (profile) => {
  const items = [
    {
      label: "CAC verification",
      status: profile.cacVerificationStatus,
      passed: profile.cacVerificationStatus === "verified",
    },
    {
      label: "Facility verification",
      status: profile.regulatoryVerificationStatus,
      passed: profile.regulatoryVerificationStatus === "verified",
    },
    {
      label: "Employer approval",
      status: profile.employerApprovalStatus,
      passed: profile.employerApprovalStatus === "approved",
    },
    {
      label: "Account status",
      status: profile.accountStatus,
      passed: profile.accountStatus === "active",
    },
  ];

  const isEligible = items.every((item) => item.passed);

  return {
    title: "Business Verification",
    isEligible,
    successMessage: "Your business is verified. You can post shifts.",
    pendingMessage:
      "Your business profile is under review. You’ll be able to post shifts once your CAC, facility, and approval checks are complete.",
    items,
    badgeClass,
    formatStatus,
  };
};

exports.getWalletStatus = (wallet) => {
  const walletStatus = wallet?.status || "not_started";

  const items = [
    {
      label: "Wallet status",
      status: walletStatus,
      passed: walletStatus === "active",
    },
  ];

  const isEligible = items.every((item) => item.passed);

  return {
    title: "Wallet Status",
    isEligible,
    successMessage: "Your wallet is active and ready for transactions.",
    pendingMessage:
      "Your wallet is not active yet. Some wallet actions may be unavailable until this is resolved.",
    items,
    badgeClass,
    formatStatus,
  };
};

exports.getEmployerFundingStatus = (dva) => {
  const rawStatus = dva?.status || "not_started";

  const displayStatus = rawStatus === "failed" ? "setup_pending" : rawStatus;

  const items = [
    {
      label: "Funding account",
      status: displayStatus,
      passed: rawStatus === "active",
    },
  ];

  const isEligible = items.every((item) => item.passed);

  return {
    title: "Funding Account",
    isEligible,
    successMessage: "Your dedicated funding account is active and ready to receive payments.",
    pendingMessage:
      rawStatus === "failed"
        ? "Your dedicated funding account is still being set up."
        : "Your dedicated funding account is not ready yet.",
    reason: rawStatus === "failed" ? dva?.failureReason || null : null,
    rawStatus,
    displayStatus,
    items,
    badgeClass,
    formatStatus,
  };
};

exports.badgeClass = badgeClass;
exports.formatStatus = formatStatus;
