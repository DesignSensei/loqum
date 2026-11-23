const mongoose = require("mongoose");

const FacilityPermitVerificationService = require("../services/facilityPermitVerificationService");
const logger = require("../utils/logger");

const BRANCHES_URL = "/employer/business-profile?tab=branches";

function renderNotFound(res, statusCode = 404) {
  return res.status(statusCode).render("auth/not-found", {
    layout: "layouts/auth-layout-no-index",
    title: statusCode === 403 ? "Forbidden" : "Not Found",
  });
}

function formatRequirementName(value) {
  return String(value || "").replace(/[_:-]/g, " ");
}

function formatSubmissionDate(value) {
  if (!value) return "-";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos",
      });
}

function buildPermitView({ branch, branchId, permits, readiness }) {
  const requirements = Array.isArray(readiness?.requirements) ? readiness.requirements : [];
  const history = Array.isArray(permits) ? permits : [];

  const policyUnavailable = String(readiness?.reason || "").startsWith("FACILITY_PERMIT_POLICY_");

  const readinessMode = policyUnavailable
    ? "policy_unavailable"
    : readiness?.canPost === true
      ? "ready"
      : "not_ready";

  let readinessMessage = null;

  if (readinessMode === "not_ready") {
    if (readiness?.branchActive !== true) {
      readinessMessage =
        "This branch is administratively inactive. Reactivating it will not bypass permit requirements.";
    } else if (readiness?.identityReady !== true) {
      readinessMessage =
        "The business or branch must meet the applicable account and CAC eligibility checks.";
    } else {
      readinessMessage = "One or more required facility permits are not currently in force.";
    }
  }

  const requirementCards = requirements.map((requirement) => {
    const records = history.filter((item) => item.requirementKey === requirement.requirementKey);

    const pending = records.some((item) => item.status === "pending");
    const newest = records[0] || null;
    const satisfied = Boolean(requirement.satisfied);

    let helpMessage = "Upload a valid document for administrative verification.";

    if (pending) {
      helpMessage =
        "A submission is awaiting administrative review. You cannot submit another pending document for this requirement.";
    } else if (satisfied) {
      helpMessage =
        "This requirement is currently satisfied. You can submit a renewal when you have updated evidence.";
    } else if (newest?.status === "needs_review") {
      helpMessage = "Additional review is required. You may submit updated supporting evidence.";
    } else if (newest?.status === "rejected") {
      helpMessage =
        "The previous submission was not approved. You may submit a replacement document.";
    }

    return {
      requirementKey: requirement.requirementKey,
      displayName: formatRequirementName(requirement.requirementKey),
      authorityName: requirement.authorityName || "Relevant regulatory authority",
      statusLabel: satisfied ? "Satisfied" : pending ? "Pending review" : "Required",
      statusBadgeClass: satisfied
        ? "badge-light-success"
        : pending
          ? "badge-light-warning"
          : "badge-light-danger",
      helpMessage,
      canSubmit: !pending,
      submitLabel: satisfied ? "Submit Renewal" : "Submit Evidence",
    };
  });

  const historyRows = history.map((permit) => {
    const state = permit.revoked ? "revoked" : permit.status;
    const showValidity = permit.status === "verified" && !permit.revoked;

    const statusBadgeClass =
      state === "verified"
        ? "badge-light-success"
        : state === "pending"
          ? "badge-light-warning"
          : state === "needs_review"
            ? "badge-light-info"
            : "badge-light-danger";

    return {
      requirementLabel: formatRequirementName(permit.requirementKey),
      authorityName: permit.authorityName || "-",
      permitNumber: permit.permitNumber || "-",
      isRenewal: Boolean(permit.renewalOfId),
      statusLabel: String(state || "-").replace(/_/g, " "),
      statusBadgeClass,
      isCurrent: Boolean(permit.isCurrent && !permit.revoked),
      showValidity,
      validFromLabel: permit.validFromDate || "-",
      validUntilLabel:
        permit.validityType === "indefinite" ? "No fixed expiry" : permit.expiryDate || "-",
      isScheduled: Boolean(showValidity && !permit.isCurrent && !permit.activatedAt),
      submittedDateLabel: formatSubmissionDate(permit.submittedAt),
    };
  });

  return {
    branchName: branch.name || "Branch",
    branchLocationLabel: `${branch.state || "-"}, ${branch.lga || "-"}`,
    submitUrl: `/employer/branches/${branchId}/permits`,
    readinessUrl: `/employer/branches/${branchId}/permits/readiness`,
    readinessMode,
    readinessMessage,
    requirements: requirementCards,
    history: historyRows,
    showSubmissionForm: !policyUnavailable && requirementCards.length > 0,
  };
}

exports.getBranchPermitsPage = async (req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });

  try {
    const businessId = req.employerProfile?._id;
    const branchId = req.params?.branchId;
    const actorUserId = req.user?._id;

    if (
      !mongoose.isValidObjectId(businessId) ||
      !mongoose.isValidObjectId(branchId) ||
      !mongoose.isValidObjectId(actorUserId)
    ) {
      return renderNotFound(res);
    }

    await FacilityPermitVerificationService.assertEmployerManager({
      businessId,
      actorUserId,
    });

    const branch = await FacilityPermitVerificationService.getOwnedBranch({
      businessId,
      branchId,
    });

    try {
      await FacilityPermitVerificationService.activateDuePermits({
        businessId,
        branchId,
      });
    } catch (error) {
      if (!String(error?.code || "").startsWith("FACILITY_PERMIT_POLICY_")) {
        throw error;
      }
    }

    const { permits, readiness } = await FacilityPermitVerificationService.listBranchPermits({
      businessId,
      branchId,
      actorUserId,
    });

    const permitView = buildPermitView({
      branch,
      branchId: String(branchId),
      permits,
      readiness,
    });

    return res.render("employer/branch-permits/index", {
      layout: "layouts/app-layout",
      title: "Branch Facility Permits",
      breadcrumbs: [
        { label: "Home", url: "/employer/dashboard" },
        { label: "Business Profile", url: BRANCHES_URL },
        { label: "Branch Facility Permits", url: null },
      ],
      permitView,
      branchesUrl: BRANCHES_URL,
      csrfToken: req.csrfToken(),
      scripts: '<script src="/js/employer/branch-permits.js"></script>',
    });
  } catch (error) {
    const statusCode = error?.statusCode;

    if ([401, 403, 404].includes(statusCode)) {
      return renderNotFound(res, statusCode === 401 ? 403 : statusCode);
    }

    logger.error("Employer branch permits page failed:", error?.code || error?.name);
    return next(error);
  }
};
