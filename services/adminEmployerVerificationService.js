const mongoose = require("mongoose");

const EmployerProfile = require("../models/EmployerProfile");
const Branch = require("../models/Branch");
const FacilityPermit = require("../models/FacilityPermit");
const KYCVerification = require("../models/KYCVerification");

const EmployerVerificationService = require("./employerVerificationService");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE_NUMBER = 100000;
const CAC_HISTORY_LIMIT = 100;
const PERMIT_HISTORY_LIMIT = 200;

const ALLOWED_EMPLOYER_FILTERS = new Set([
  "review",
  "all",
  "pending",
  "needs_review",
  "verified",
  "rejected",
  "restricted",
  "suspended",
]);

const ALLOWED_PERMIT_FILTERS = new Set([
  "review",
  "all",
  "pending",
  "needs_review",
  "verified",
  "rejected",
]);

const EMPLOYER_LIST_FIELDS = {
  user: 1,
  businessName: 1,
  type: 1,
  countryCode: 1,
  cacRegistrationNumber: 1,
  cacVerificationStatus: 1,
  cacVerificationMethod: 1,
  cacNameOnRecord: 1,
  cacLastCheckedAt: 1,
  accountStatus: 1,
  createdAt: 1,
  updatedAt: 1,
};

const PERMIT_PUBLIC_FIELDS = [
  "business",
  "branch",
  "requirementKey",
  "scope",
  "authorityCode",
  "authorityName",
  "permitNumber",
  "permitDescription",
  "branchLocationSnapshot",
  "documentMimeType",
  "documentSizeBytes",
  "submittedAt",
  "submittedBy",
  "status",
  "reviewedBy",
  "reviewedAt",
  "verifiedAt",
  "reviewNote",
  "rejectionReason",
  "validityType",
  "validFromDate",
  "expiryDate",
  "licensingYear",
  "isCurrent",
  "renewalOf",
  "activatedAt",
  "deactivatedAt",
  "revokedAt",
  "revokedBy",
  "revocationReason",
  "createdAt",
  "updatedAt",
].join(" ");

class AdminEmployerVerificationService {
  static createError(message, statusCode = 400, code = "ADMIN_EMPLOYER_VERIFICATION_ERROR") {
    const error = new Error(message);
    error.name = "AdminEmployerVerificationServiceError";
    error.statusCode = statusCode;
    error.code = code;
    return error;
  }

  static async assertAdmin(adminUserId) {
    if (!adminUserId) {
      throw this.createError("Authentication is required.", 401);
    }

    return EmployerVerificationService.assertAdmin(adminUserId);
  }

  static validateEmployerProfileId(employerProfileId) {
    if (!mongoose.isValidObjectId(employerProfileId)) {
      throw this.createError("Invalid employer profile ID.");
    }

    return employerProfileId;
  }

  static validateBranchId(branchId) {
    if (!mongoose.isValidObjectId(branchId)) {
      throw this.createError("Invalid branch ID.");
    }

    return branchId;
  }

  static validatePermitId(permitId) {
    if (!mongoose.isValidObjectId(permitId)) {
      throw this.createError("Invalid facility permit ID.");
    }

    return permitId;
  }

  static parsePositiveInteger(value, fallback, maximum) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }

    const parsed = Number(value);

    return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, maximum) : fallback;
  }

  static normalizeStatusFilter(value) {
    const filter = String(value || "review")
      .trim()
      .toLowerCase();

    return ALLOWED_EMPLOYER_FILTERS.has(filter) ? filter : "review";
  }

  static normalizePermitFilter(value) {
    const filter = String(value || "review")
      .trim()
      .toLowerCase();

    return ALLOWED_PERMIT_FILTERS.has(filter) ? filter : "review";
  }

  static buildEmployerQuery(filter) {
    if (filter === "restricted") {
      return { accountStatus: "restricted" };
    }

    if (filter === "suspended") {
      return { accountStatus: "suspended" };
    }

    return {};
  }

  static getReviewStatusCriteria(filter) {
    switch (filter) {
      case "review":
        return {
          cacStatuses: ["pending", "needs_review"],
          permitStatuses: ["pending", "needs_review"],
        };

      case "pending":
      case "needs_review":
      case "verified":
      case "rejected":
        return {
          cacStatuses: [filter],
          permitStatuses: [filter],
        };

      default:
        return null;
    }
  }

  static buildEmployerListPipeline({ filter, page, limit }) {
    const pipeline = [
      {
        $match: this.buildEmployerQuery(filter),
      },
    ];

    const criteria = this.getReviewStatusCriteria(filter);

    if (criteria) {
      pipeline.push({
        $lookup: {
          from: FacilityPermit.collection.name,
          let: {
            employerId: "$_id",
          },
          pipeline: [
            {
              $match: {
                status: {
                  $in: criteria.permitStatuses,
                },
                $expr: {
                  $eq: ["$business", "$$employerId"],
                },
              },
            },
            {
              $limit: 1,
            },
            {
              $project: {
                _id: 1,
              },
            },
          ],
          as: "_matchingPermits",
        },
      });

      pipeline.push({
        $match: {
          $or: [
            {
              cacVerificationStatus: {
                $in: criteria.cacStatuses,
              },
            },
            {
              "_matchingPermits.0": {
                $exists: true,
              },
            },
          ],
        },
      });
    }

    pipeline.push({
      $facet: {
        employers: [
          {
            $sort: {
              createdAt: -1,
              _id: -1,
            },
          },
          {
            $skip: (page - 1) * limit,
          },
          {
            $limit: limit,
          },
          {
            $project: EMPLOYER_LIST_FIELDS,
          },
        ],
        count: [
          {
            $count: "total",
          },
        ],
      },
    });

    return pipeline;
  }

  static permitCountsGroup(groupId) {
    const countStatus = (status) => ({
      $sum: {
        $cond: [
          {
            $eq: ["$status", status],
          },
          1,
          0,
        ],
      },
    });

    return {
      $group: {
        _id: groupId,
        total: {
          $sum: 1,
        },
        pending: countStatus("pending"),
        needsReview: countStatus("needs_review"),
        verified: countStatus("verified"),
        rejected: countStatus("rejected"),
        selectedCurrent: {
          $sum: {
            $cond: [
              {
                $eq: ["$isCurrent", true],
              },
              1,
              0,
            ],
          },
        },
      },
    };
  }

  static emptyPermitCounts() {
    return {
      total: 0,
      pending: 0,
      needsReview: 0,
      verified: 0,
      rejected: 0,
      selectedCurrent: 0,
    };
  }

  static copyPermitCounts(group) {
    if (!group) {
      return this.emptyPermitCounts();
    }

    return {
      total: group.total || 0,
      pending: group.pending || 0,
      needsReview: group.needsReview || 0,
      verified: group.verified || 0,
      rejected: group.rejected || 0,
      selectedCurrent: group.selectedCurrent || 0,
    };
  }

  static async getEmployerListSummaries(employers) {
    if (!employers.length) {
      return employers;
    }

    const ids = employers.map((item) => item._id);

    const [branchGroups, permitGroups] = await Promise.all([
      Branch.aggregate([
        {
          $match: {
            business: {
              $in: ids,
            },
          },
        },
        {
          $group: {
            _id: "$business",
            branchCount: {
              $sum: 1,
            },
            activeBranchCount: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$isActive", true],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      FacilityPermit.aggregate([
        {
          $match: {
            business: {
              $in: ids,
            },
          },
        },
        this.permitCountsGroup("$business"),
      ]),
    ]);

    const byBusinessBranch = new Map(branchGroups.map((group) => [String(group._id), group]));

    const byBusinessPermit = new Map(permitGroups.map((group) => [String(group._id), group]));

    return employers.map((employer) => {
      const id = String(employer._id);
      const branches = byBusinessBranch.get(id);

      return {
        ...employer,
        branchCount: branches?.branchCount || 0,
        activeBranchCount: branches?.activeBranchCount || 0,
        permitSummary: this.copyPermitCounts(byBusinessPermit.get(id)),
      };
    });
  }

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
      scripts: '<script src="/js/admin/employer-verifications.js"></script>',
    };
  }

  static async listEmployers({ adminUserId, status, page, limit }) {
    await this.assertAdmin(adminUserId);

    const currentPage = this.parsePositiveInteger(page, 1, MAX_PAGE_NUMBER);
    const pageSize = this.parsePositiveInteger(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const filter = this.normalizeStatusFilter(status);

    const [result] = await EmployerProfile.aggregate(
      this.buildEmployerListPipeline({
        filter,
        page: currentPage,
        limit: pageSize,
      })
    );

    const employers = await this.getEmployerListSummaries(result?.employers || []);
    const total = result?.count?.[0]?.total || 0;

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
          "accountStatus",
          "accountStatusReason",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .lean();

    if (!employer) {
      throw this.createError("Employer profile not found.", 404);
    }

    const [branches, verificationHistory, facilityPermitHistory, historyCount, byBranch] =
      await Promise.all([
        Branch.find({
          business: employer._id,
        })
          .select(
            "name address state lga googlePlaceId location geofenceRadiusMeters isActive isPrimary createdAt updatedAt"
          )
          .sort({
            isPrimary: -1,
            createdAt: 1,
            _id: 1,
          })
          .lean(),

        KYCVerification.find({
          employer: employer._id,
          ownerType: "employer",
          type: "cac",
        })
          .select(
            [
              "type",
              "provider",
              "providerEnvironment",
              "status",
              "nameOnRecord",
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
            _id: -1,
          })
          .limit(CAC_HISTORY_LIMIT)
          .lean(),

        FacilityPermit.find({
          business: employer._id,
        })
          .select(PERMIT_PUBLIC_FIELDS)
          .sort({
            submittedAt: -1,
            _id: -1,
          })
          .limit(PERMIT_HISTORY_LIMIT)
          .lean(),

        FacilityPermit.countDocuments({
          business: employer._id,
        }),

        FacilityPermit.aggregate([
          {
            $match: {
              business: employer._id,
            },
          },
          this.permitCountsGroup("$branch"),
        ]),
      ]);

    const summaryByBranch = new Map(
      byBranch.map((group) => [String(group._id), this.copyPermitCounts(group)])
    );

    const permitHistoryByBranch = new Map();

    for (const permit of facilityPermitHistory) {
      const key = String(permit.branch);

      if (!permitHistoryByBranch.has(key)) {
        permitHistoryByBranch.set(key, []);
      }

      permitHistoryByBranch.get(key).push(permit);
    }

    const branchDetails = branches.map((branch) => ({
      ...branch,
      permitSummary: summaryByBranch.get(String(branch._id)) || this.emptyPermitCounts(),
      permits: permitHistoryByBranch.get(String(branch._id)) || [],
    }));

    const permitSummary = [...summaryByBranch.values()].reduce((summary, counts) => {
      for (const key of Object.keys(summary)) {
        summary[key] += counts[key];
      }

      return summary;
    }, this.emptyPermitCounts());

    return {
      success: true,
      data: {
        employer,
        verificationHistory,
        readiness: EmployerVerificationService.getVerificationReadiness(employer),
        branches: branchDetails,
        facilityPermitHistory,
        permitHistoryTotal: historyCount,
        permitHistoryTruncated: historyCount > facilityPermitHistory.length,
        permitSummary,
      },
    };
  }

  static async listFacilityPermits({
    adminUserId,
    status,
    page,
    limit,
    employerProfileId,
    branchId,
  }) {
    await this.assertAdmin(adminUserId);

    const currentPage = this.parsePositiveInteger(page, 1, MAX_PAGE_NUMBER);
    const pageSize = this.parsePositiveInteger(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const filter = this.normalizePermitFilter(status);

    const query = {};

    if (filter === "review") {
      query.status = {
        $in: ["pending", "needs_review"],
      };
    } else if (filter !== "all") {
      query.status = filter;
    }

    if (employerProfileId !== undefined && employerProfileId !== null && employerProfileId !== "") {
      query.business = this.validateEmployerProfileId(employerProfileId);
    }

    if (branchId !== undefined && branchId !== null && branchId !== "") {
      query.branch = this.validateBranchId(branchId);
    }

    const [permits, total] = await Promise.all([
      FacilityPermit.find(query)
        .select(PERMIT_PUBLIC_FIELDS)
        .populate("business", "businessName type cacVerificationStatus accountStatus")
        .populate("branch", "business name state lga address isActive isPrimary")
        .sort({
          submittedAt: -1,
          _id: -1,
        })
        .skip((currentPage - 1) * pageSize)
        .limit(pageSize)
        .lean(),

      FacilityPermit.countDocuments(query),
    ]);

    return {
      success: true,
      data: {
        permits,
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

  static async getFacilityPermit({ adminUserId, employerProfileId, branchId, permitId }) {
    await this.assertAdmin(adminUserId);

    const business = this.validateEmployerProfileId(employerProfileId);
    const branch = this.validateBranchId(branchId);
    const permit = this.validatePermitId(permitId);

    const [branchRecord, permitRecord] = await Promise.all([
      Branch.findOne({
        _id: branch,
        business,
      })
        .select("business name state lga address googlePlaceId location isActive")
        .lean(),

      FacilityPermit.findOne({
        _id: permit,
        business,
        branch,
      })
        .select(PERMIT_PUBLIC_FIELDS)
        .lean(),
    ]);

    if (!branchRecord || !permitRecord) {
      throw this.createError("Facility permit not found for this employer branch.", 404);
    }

    return {
      success: true,
      data: {
        branch: branchRecord,
        permit: permitRecord,
      },
    };
  }

  static async recheckCAC({ adminUserId, employerProfileId }) {
    await this.assertAdmin(adminUserId);

    const employerId = this.validateEmployerProfileId(employerProfileId);

    const result = await EmployerVerificationService.verifyCAC({
      employerProfileId: employerId,
      force: true,
    });

    let message = "CAC verification check completed.";

    if (result.skipped) {
      message = result.reason || "CAC verification check was skipped.";
    } else if (result.providerFailure) {
      message = result.requiresManualReconciliation
        ? "CAC verification could not be completed. Administrative reconciliation is required."
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
}

module.exports = AdminEmployerVerificationService;
