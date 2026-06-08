// utils/kycStatus.js

const badgeClass = {
  pending: "badge-light-warning",
  not_started: "badge-light-warning",
  verified: "badge-light-success",
  approved: "badge-light-success",
  rejected: "badge-light-danger",
  restricted: "badge-light-danger",
  needs_review: "badge-light-info",
  active: "badge-light-success",
  suspended: "badge-light-danger",

  visible: "badge-light-success",
  hidden: "badge-light-warning",
  paused: "badge-light-warning",

  available: "badge-light-success",
  unavailable: "badge-light-warning",
  busy: "badge-light-info",
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
