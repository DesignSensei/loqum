// services/adminEmployerVerificationService.js

const mongoose = require("mongoose");

const EmployerProfile = require("../models/EmployerProfile");
const KYCVerification = require("../models/KYCVerification");

const EmployerVerificationService = require("./employerVerificationService");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE_NUMBER = 100000;
const VERIFICATION_HISTORY_LIMIT = 100;

const ALLOWED_STATUS_FILTERS = [
  "review",
  "all",
  "pending",
  "needs_review",
  "verified",
  "rejected",
  "approved",
  "restricted",
  "suspended",
];

class AdminEmployerVerificationService {
  static async assertAdmin(adminUserId) {
    if (!adminUserId) {
      const error = new Error("Authentication is required.");
      error.statusCode = 401;
      throw error;
    }

    return EmployerVerificationService.assertAdmin(adminUserId);
  }

  static validateEmployerProfileId(employerProfileId) {
    if (!mongoose.isValidObjectId(employerProfileId)) {
      const error = new Error("Invalid employer profile ID.");
      error.statusCode = 400;
      throw error;
    }

    return employerProfileId;
  }

  static parsePositiveInteger(value, fallback, maximum) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return fallback;
    }

    return Math.min(parsed, maximum);
  }

  static normalizeStatusFilter(value) {
    const filter = String(value || "review")
      .trim()
      .toLowerCase();

    return ALLOWED_STATUS_FILTERS.includes(filter) ? filter : "review";
  }

  static normalizeDecision(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  static normalizeReviewText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // ───────────────────────── QUERY PREPARATION ─────────────────────────

  static buildEmployerQuery(filter) {
    switch (filter) {
      case "all":
        return {};

      case "pending":
      case "needs_review":
      case "rejected":
        return {
          $or: [
            { cacVerificationStatus: filter },
            { regulatoryVerificationStatus: filter },
            { employerApprovalStatus: filter },
          ],
        };

      case "verified":
        return {
          $or: [
            { cacVerificationStatus: "verified" },
            { regulatoryVerificationStatus: "verified" },
          ],
        };

      case "approved":
        return {
          employerApprovalStatus: "approved",
        };

      case "restricted":
        return {
          $or: [{ accountStatus: "restricted" }, { employerApprovalStatus: "restricted" }],
        };

      case "suspended":
        return {
          accountStatus: "suspended",
        };

      case "review":
      default:
        return {
          $or: [
            {
              cacVerificationStatus: {
                $in: ["pending", "needs_review"],
              },
            },
            {
              regulatoryVerificationStatus: {
                $in: ["pending", "needs_review"],
              },
            },
            {
              employerApprovalStatus: {
                $in: ["pending", "needs_review"],
              },
            },
          ],
        };
    }
  }

  // ───────────────────────── DASHBOARD OPTIONS ─────────────────────────

  static async getDashboardPageOptions({ adminUserId }) {
    await this.assertAdmin(adminUserId);

    return {
      layout: "layouts/app-layout",
      title: "Employer Verification",

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },
        {
          label: "Employer Verification",
          url: null,
        },
      ],

      scripts: `
        <script src="/js/admin/employer-verifications.js"></script>
      `,
    };
  }

  // ───────────────────────── EMPLOYER LIST ─────────────────────────

  static async listEmployers({ adminUserId, status, page, limit }) {
    await this.assertAdmin(adminUserId);

    const currentPage = this.parsePositiveInteger(page, 1, MAX_PAGE_NUMBER);

    const pageSize = this.parsePositiveInteger(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filter = this.normalizeStatusFilter(status);
    const query = this.buildEmployerQuery(filter);

    const [employers, total] = await Promise.all([
      EmployerProfile.find(query)
        .select(
          [
            "user",
            "businessName",
            "type",
            "countryCode",
            "cacRegistrationNumber",
            "cacVerificationStatus",
            "cacVerificationMethod",
            "cacNameOnRecord",
            "cacLastCheckedAt",
            "regulatoryBody",
            "regulatoryRegistrationNumber",
            "regulatoryVerificationStatus",
            "regulatoryNameOnRecord",
            "regulatoryLastCheckedAt",
            "employerApprovalStatus",
            "accountStatus",
            "createdAt",
            "updatedAt",
          ].join(" ")
        )
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .skip((currentPage - 1) * pageSize)
        .limit(pageSize)
        .lean(),

      EmployerProfile.countDocuments(query),
    ]);

    return {
      success: true,

      data: {
        employers,

        pagination: {
          page: currentPage,
          limit: pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },

        filter,
      },
    };
  }

  // ───────────────────────── EMPLOYER VERIFICATION DETAILS ─────────────────────────

  static async getEmployerVerification({ adminUserId, employerProfileId }) {
    await this.assertAdmin(adminUserId);

    const employerId = this.validateEmployerProfileId(employerProfileId);

    const employer = await EmployerProfile.findById(employerId)
      .select(
        [
          "user",
          "businessName",
          "businessEmail",
          "type",
          "countryCode",
          "address",
          "state",
          "lga",

          "cacRegistrationNumber",
          "cacVerificationStatus",
          "cacVerificationMethod",
          "cacVerificationSource",
          "cacNameOnRecord",
          "cacVerifiedAt",
          "cacLastCheckedAt",
          "cacVerifiedBy",
          "cacVerificationNote",
          "cacRejectionReason",

          "regulatoryBody",
          "regulatoryRegistrationNumber",
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

          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .lean();

    if (!employer) {
      const error = new Error("Employer profile not found.");
      error.statusCode = 404;
      throw error;
    }

    const verificationHistory = await KYCVerification.find({
      employer: employerId,
      ownerType: "employer",

      type: {
        $in: ["cac", "facility_regulatory"],
      },
    })
      .select(
        [
          "type",
          "provider",
          "providerEnvironment",
          "status",
          "nameOnRecord",
          "nameMatchScore",
          "reviewNote",
          "rejectionReason",
          "failureReason",
          "submittedAt",
          "verifiedAt",
          "rejectedAt",
          "failedAt",
          "lastCheckedAt",
          "reviewedBy",
          "isActive",
          "createdAt",
        ].join(" ")
      )
      .sort({
        createdAt: -1,
      })
      .limit(VERIFICATION_HISTORY_LIMIT)
      .lean();

    const readiness = EmployerVerificationService.getVerificationReadiness(employer);

    return {
      success: true,

      data: {
        employer,
        verificationHistory,
        readiness,
      },
    };
  }

  // ───────────────────────── CAC RECHECK ─────────────────────────

  static async recheckCAC({ adminUserId, employerProfileId }) {
    await this.assertAdmin(adminUserId);

    const employerId = this.validateEmployerProfileId(employerProfileId);

    /*
     * The domain service owns the MongoDB lock,
     * paid-lookup cooldown and verification persistence.
     *
     * This is an explicit administrator-requested
     * recheck, not an automatic onboarding lookup.
     */
    const result = await EmployerVerificationService.verifyCAC({
      employerProfileId: employerId,
      force: true,
    });

    let message = "CAC verification check completed.";

    if (result.skipped) {
      message = result.reason || "CAC verification check was skipped.";
    } else if (result.providerFailure) {
      message = result.requiresManualReconciliation
        ? "CAC verification could not be completed. The request requires administrative reconciliation."
        : "CAC verification could not be completed. Existing verification was preserved.";
    } else if (result.stagingOnly) {
      message = "CAC staging test completed without changing production verification.";
    } else if (result.requiresReview) {
      message = "CAC verification requires administrative review.";
    } else if (result.verified) {
      message = "CAC registration verified successfully.";
    }

    return {
      success: true,
      message,
      data: result,
    };
  }

  // ───────────────────────── PCN REVIEW ─────────────────────────

  static async reviewPCN({ adminUserId, employerProfileId, decision, nameOnRecord, note }) {
    await this.assertAdmin(adminUserId);

    const employerId = this.validateEmployerProfileId(employerProfileId);

    const cleanDecision = this.normalizeDecision(decision);

    const cleanName = this.normalizeReviewText(nameOnRecord);

    const cleanNote = this.normalizeReviewText(note);

    const result = await EmployerVerificationService.recordPCNReview({
      employerProfileId: employerId,
      adminUserId,

      decision: cleanDecision,
      nameOnRecord: cleanName,
      note: cleanNote,
    });

    let message = "PCN verification review recorded successfully.";

    if (result.status === "verified") {
      message = "PCN premises registration verified successfully.";
    } else if (result.status === "rejected") {
      message = "PCN premises verification rejection recorded.";
    } else if (result.status === "needs_review") {
      message = "PCN premises registration marked for further review.";
    }

    return {
      success: true,
      message,
      data: result,
    };
  }
}

module.exports = AdminEmployerVerificationService;
