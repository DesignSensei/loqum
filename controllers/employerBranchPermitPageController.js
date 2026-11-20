// controllers/employerBranchPermitPageController.js

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

    // Reuse the authoritative owner/admin policy; page visibility is not authorization.
    await FacilityPermitVerificationService.assertEmployerManager({
      businessId,
      actorUserId,
    });

    const branch = await FacilityPermitVerificationService.getOwnedBranch({
      businessId,
      branchId,
    });

    // Bring approved, due renewals into effect before displaying their status.
    // Policy misconfiguration must not be turned into a default approval.
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

    return res.render("employer/branch-permits/index", {
      layout: "layouts/app-layout",
      title: "Branch Facility Permits",
      breadcrumbs: [
        { label: "Home", url: "/employer/dashboard" },
        { label: "Business Profile", url: BRANCHES_URL },
        { label: "Branch Facility Permits", url: null },
      ],
      branch,
      branchId: String(branchId),
      permits,
      readiness,
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
