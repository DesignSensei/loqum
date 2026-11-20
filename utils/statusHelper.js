const badgeClass = {
  pending: "badge-light-warning",
  not_started: "badge-light-warning",
  verified: "badge-light-success",
  approved: "badge-light-success",
  rejected: "badge-light-danger",
  restricted: "badge-light-danger",
  needs_review: "badge-light-info",
  recorded: "badge-light-info",

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

// ───────────────────────── PROFESSIONAL VERIFICATION ─────────────────────────

/**
 * Prepare a professional verification summary for presentation.
 *
 * verificationStatus must be produced by the trusted server-side
 * ProfessionalVerificationService.getVerificationStatus() method.
 *
 * This helper does not query databases, perform NIN lookups,
 * validate licence evidence or authorise marketplace operations.
 *
 * Missing or inconsistent status information never establishes
 * marketplace readiness.
 */
exports.getProfessionalKycStatus = (profile, verificationStatus = null) => {
  const professional = profile || {};

  const status =
    verificationStatus &&
    typeof verificationStatus === "object" &&
    !Array.isArray(verificationStatus) &&
    professional._id &&
    verificationStatus.professionalProfileId &&
    String(professional._id) === String(verificationStatus.professionalProfileId)
      ? verificationStatus
      : null;

  const readiness =
    status?.verificationReadiness &&
    typeof status.verificationReadiness === "object" &&
    !Array.isArray(status.verificationReadiness)
      ? status.verificationReadiness
      : null;

  const hasReadiness = Boolean(readiness);

  // Onboarding NIN evidence is reused, not verified again.
  // "Recorded" does not imply NIN-holder authentication.
  const ninEvidenceConfirmed = Boolean(
    readiness?.ninEvidenceConfirmed === true &&
    status?.ninEvidenceStatus === "registry_name_recorded"
  );

  const licenceVerified = readiness?.licenceVerified === true;
  const licenceSourceValid = readiness?.licenceSourceValid === true;
  const namesConsistent = readiness?.namesConsistent === true;
  const licenceCurrent = readiness?.licenceCurrent === true;
  const licenceExpired = readiness?.licenceExpired === true;
  const licenceWithinGrace = readiness?.licenceWithinGrace === true;

  const verifiedReviewEvidence = Boolean(
    readiness?.verifiedReviewEvidence === true && readiness?.evidenceErrorCode == null
  );

  const adminApproved = Boolean(
    readiness?.adminApproved === true && status?.professionalApprovalStatus === "approved"
  );

  // Verification evidence is distinct from account and visibility status.
  const coreVerificationPassed = Boolean(
    hasReadiness &&
    ninEvidenceConfirmed &&
    licenceVerified &&
    licenceSourceValid &&
    namesConsistent &&
    licenceCurrent &&
    verifiedReviewEvidence
  );

  const verificationChecksPassed = coreVerificationPassed && adminApproved;

  // Compare the verification snapshot with the refreshed profile.
  // A mismatch must not produce a positive readiness indication.
  const statusAligned = Boolean(
    status &&
    status.licenceVerificationStatus === professional.licenceVerificationStatus &&
    status.professionalApprovalStatus === professional.professionalApprovalStatus &&
    status.accountStatus === professional.accountStatus &&
    status.marketplaceStatus === professional.marketplaceStatus
  );

  const accountStatus = professional.accountStatus || "not_started";

  const marketplaceStatus = professional.marketplaceStatus || "hidden";

  const accountActive = accountStatus === "active";

  const marketplaceVisible = marketplaceStatus === "visible";

  const isMarketplaceReady = Boolean(
    statusAligned &&
    verificationChecksPassed &&
    accountActive &&
    marketplaceVisible &&
    readiness?.verificationReady === true &&
    readiness?.accountActive === true
  );

  const pendingLicenceReview = Boolean(status?.pendingLicenceReview === true);

  const recordedLicenceStatus = professional.licenceVerificationStatus || "not_started";

  let licenceStatus = recordedLicenceStatus;

  if (licenceExpired && recordedLicenceStatus === "verified") {
    licenceStatus = "expired";
  } else if (recordedLicenceStatus === "verified" && hasReadiness && !licenceCurrent) {
    licenceStatus = "needs_review";
  } else if (
    recordedLicenceStatus === "verified" &&
    ninEvidenceConfirmed &&
    licenceVerified &&
    !verifiedReviewEvidence
  ) {
    licenceStatus = "needs_review";
  }

  const ninStatus = !hasReadiness
    ? "unavailable"
    : ninEvidenceConfirmed
      ? "recorded"
      : accountActive
        ? "needs_review"
        : "unavailable";

  const items = [
    {
      label: "NIN onboarding evidence",
      status: ninStatus,
      passed: ninEvidenceConfirmed,
    },
    {
      label: "Practising licence",
      status: licenceStatus,
      passed: coreVerificationPassed,
    },
    {
      label: "Professional approval",
      status: professional.professionalApprovalStatus || "pending",
      passed: verificationChecksPassed,
    },
    {
      label: "Account status",
      status: accountStatus,
      passed: accountActive,
    },
    {
      label: "Marketplace visibility",
      status: marketplaceStatus,
      passed: marketplaceVisible,
    },
  ];

  // ───────────────────────── READINESS PRESENTATION ─────────────────────────

  let readinessLabel = "Marketplace Ready";
  let readinessMessage = "Your profile is verified and ready for shifts.";

  if (!hasReadiness || !statusAligned) {
    readinessLabel = "Status Unavailable";
    readinessMessage = "Your verification status needs confirmation.";
  } else if (licenceExpired) {
    readinessLabel = "Licence Expired";
    readinessMessage = "Your licence has expired. Renew it before taking on new work.";
  } else if (!accountActive) {
    readinessLabel = "Account Not Active";
    readinessMessage = "Your account is not active.";
  } else if (!ninEvidenceConfirmed) {
    readinessLabel = "Verification Needs Review";
    readinessMessage = "Your onboarding records need review.";
  } else if (!licenceVerified) {
    readinessLabel = "Licence Review Pending";

    if (recordedLicenceStatus === "rejected") {
      readinessLabel = "Licence Rejected";
      readinessMessage = "Your licence submission was rejected.";
    } else if (recordedLicenceStatus === "needs_review") {
      readinessMessage = "Your licence needs further review.";
    } else {
      readinessMessage = pendingLicenceReview
        ? "Your practising licence is awaiting review."
        : "Submit your practising licence for review.";
    }
  } else if (!licenceSourceValid || !namesConsistent || !verifiedReviewEvidence) {
    readinessLabel = "Verification Needs Review";
    readinessMessage = "Your licence review records need checking.";
  } else if (!licenceCurrent) {
    readinessLabel = "Licence Not Current";
    readinessMessage = "Your licence validity needs review.";
  } else if (!adminApproved) {
    readinessLabel = "Approval Pending";
    readinessMessage = "Final professional approval is pending.";
  } else if (!marketplaceVisible) {
    readinessLabel = "Marketplace Not Visible";
    readinessMessage =
      marketplaceStatus === "paused"
        ? "Your marketplace visibility is paused."
        : "Your profile is not visible on the marketplace.";
  } else if (!isMarketplaceReady) {
    readinessLabel = "Eligibility Check Required";
    readinessMessage = "Your marketplace readiness needs confirmation.";
  }

  const readinessBadgeClass = isMarketplaceReady
    ? "badge-light-success"
    : licenceExpired
      ? "badge-light-danger"
      : "badge-light-warning";

  const readinessNoticeClass = isMarketplaceReady
    ? "bg-light-success border-success"
    : licenceExpired
      ? "bg-light-danger border-danger"
      : "bg-light-warning";

  const readinessIcon = isMarketplaceReady ? "ki-shield-tick" : "ki-information-5";

  const readinessIconClass = isMarketplaceReady
    ? "text-success"
    : licenceExpired
      ? "text-danger"
      : "text-warning";

  return {
    title: "Profile Verification",

    coreVerificationPassed,
    verificationChecksPassed,

    ninEvidenceConfirmed,
    licenceVerified,
    licenceSourceValid,
    namesConsistent,
    verifiedReviewEvidence,
    licenceCurrent,
    licenceExpired,
    licenceWithinGrace,

    licenceExpiryISODate: readiness?.licenceExpiryISODate || null,

    licenceGraceEndsOn: readiness?.licenceGraceEndsOn || null,

    pendingLicenceReview,
    adminApproved,
    accountActive,
    marketplaceVisible,

    isMarketplaceReady,
    isEligible: isMarketplaceReady,

    readinessLabel,
    readinessMessage,
    readinessBadgeClass,
    readinessNoticeClass,
    readinessIcon,
    readinessIconClass,

    successMessage: "Your profile is verified and ready for shifts.",

    pendingMessage: isMarketplaceReady ? "" : readinessMessage,

    items,
    badgeClass,
    formatStatus,
  };
};

// ───────────────────────── PROFESSIONAL PAYOUT ─────────────────────────

exports.getProfessionalPayoutStatus = (profile, payoutAccount) => {
  const items = [
    {
      label: "BVN verification",
      status: profile?.bvnVerification?.status || "not_started",
      passed: profile?.bvnVerification?.status === "verified",
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
      "Your payout setup is not complete yet. Please complete your " +
      "BVN verification and payout account verification before " +
      "withdrawing funds.",
    items,
    badgeClass,
    formatStatus,
  };
};

// ───────────────────────── EMPLOYER VERIFICATION ─────────────────────────

/**
 * Summarise business-level verification only.
 *
 * A trusted CAC workflow is responsible for setting cacVerificationStatus
 * to "verified" after validating the returned registration evidence.
 * This display helper cannot independently authenticate a CAC lookup.
 *
 * Facility-permit readiness belongs to each branch and must be evaluated
 * by the authorised branch/permit services at the point of use.
 * Neither the legacy employer-wide regulatory status nor a separate
 * employerApprovalStatus is a prerequisite for business verification.
 *
 * Account restrictions remain an independent business-level gate.
 * isEligible therefore means "CAC verified and account active", NOT
 * "every branch can post shifts".
 */
exports.getEmployerKycStatus = (profile) => {
  const cacStatus = profile?.cacVerificationStatus || "pending";
  const accountStatus = profile?.accountStatus || "not_started";

  const cacVerified = cacStatus === "verified";
  const accountActive = accountStatus === "active";
  const isEligible = cacVerified && accountActive;

  const items = [
    {
      label: "CAC verification",
      status: cacStatus,
      passed: cacVerified,
    },
  ];

  let pendingMessage;

  if (!cacVerified) {
    if (cacStatus === "needs_review") {
      pendingMessage = "Your CAC registration needs review before your business can be verified.";
    } else if (cacStatus === "rejected") {
      pendingMessage =
        "Your CAC registration was not verified. Contact Loqum Support for assistance.";
    } else if (cacStatus === "pending") {
      pendingMessage = "Your CAC registration is awaiting verification.";
    } else {
      pendingMessage = "Your CAC registration has not been verified.";
    }
  } else if (!accountActive) {
    pendingMessage = "Your CAC registration is verified, but your business account is not active.";
  } else {
    pendingMessage = "";
  }

  return {
    title: "Business Verification",
    isEligible,
    cacVerified,
    accountActive,
    successMessage:
      "Your CAC registration is verified. Facility permits are checked separately for each branch.",
    pendingMessage,
    items,
    badgeClass,
    formatStatus,
  };
};

// ───────────────────────── WALLET STATUS ─────────────────────────

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
      "Your wallet is not active yet. Some wallet actions may be " +
      "unavailable until this is resolved.",
    items,
    badgeClass,
    formatStatus,
  };
};

// ───────────────────────── EMPLOYER FUNDING ─────────────────────────

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
    pendingMessage: "Your dedicated funding account is still being set up.",
    reason: rawStatus === "failed" ? dva?.failureReason || null : null,
    rawStatus,
    displayStatus,
    items,
    badgeClass,
    formatStatus,
  };
};

// ───────────────────────── EXPORTS ─────────────────────────

exports.badgeClass = badgeClass;
exports.formatStatus = formatStatus;
