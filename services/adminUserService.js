// services/adminUserService.js

const mongoose = require("mongoose");

const User = require("../models/User");
const EmployerProfile = require("../models/EmployerProfile");
const ProfessionalProfile = require("../models/ProfessionalProfile");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE_NUMBER = 100000;

const ALLOWED_ROLES = ["employer", "professional"];

const ALLOWED_VERIFICATION_FILTERS = [
  "all",
  "attention",
  "pending",
  "needs_review",
  "verified",
  "rejected",
  "expired",
  "not_onboarded",
];

const ALLOWED_ACCOUNT_STATUSES = ["active", "restricted", "suspended", "deactivated", "banned"];

class AdminUserService {
  // ───────────────────────── VALIDATION ─────────────────────────

  static createError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  static async assertAdmin(adminUserId) {
    if (!adminUserId) {
      throw this.createError("Authentication is required.", 401);
    }

    if (!mongoose.isValidObjectId(adminUserId)) {
      throw this.createError("Invalid administrator ID.", 400);
    }

    const admin = await User.findById(adminUserId).select("role accountStatus").lean();

    if (!admin || admin.role !== "admin" || admin.accountStatus !== "active") {
      throw this.createError("An active administrator is required.", 403);
    }

    return admin;
  }

  static normalizeRole(value) {
    const role = String(value || "employer")
      .trim()
      .toLowerCase();

    if (!ALLOWED_ROLES.includes(role)) {
      throw this.createError("Role must be employer or professional.");
    }

    return role;
  }

  static normalizeVerificationFilter(value) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    if (!ALLOWED_VERIFICATION_FILTERS.includes(status)) {
      throw this.createError("Invalid verification status filter.");
    }

    return status;
  }

  static normalizeAccountStatus(value) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    if (status !== "all" && !ALLOWED_ACCOUNT_STATUSES.includes(status)) {
      throw this.createError("Invalid account status filter.");
    }

    return status;
  }

  static parsePositiveInteger(value, fallback, maximum) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number) || number < 1) {
      return fallback;
    }

    return Math.min(number, maximum);
  }

  static normalizeSearch(value) {
    return typeof value === "string" ? value.trim().slice(0, 100) : "";
  }

  static escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ───────────────────────── PROFILE CONFIGURATION ─────────────────────────

  static getProfileModel(role) {
    return role === "employer" ? EmployerProfile : ProfessionalProfile;
  }

  static getListProfileProjection(role) {
    if (role === "employer") {
      return {
        _id: 1,
        user: 1,
        type: 1,
        businessName: 1,
        businessEmail: 1,
        state: 1,
        lga: 1,
        countryCode: 1,
        cacRegistrationNumber: 1,
        cacVerificationStatus: 1,
        regulatoryBody: 1,
        regulatoryRegistrationNumber: 1,
        regulatoryVerificationStatus: 1,
        employerApprovalStatus: 1,
        accountStatus: 1,
      };
    }

    return {
      _id: 1,
      user: 1,
      type: 1,
      specialty: 1,
      state: 1,
      lga: 1,
      licenceNumber: 1,
      licenceIssuingBody: 1,
      licenceVerificationStatus: 1,
      licenceExpiryDate: 1,
      identityVerificationStatus: 1,
      "bvnVerification.status": 1,
      professionalApprovalStatus: 1,
      accountStatus: 1,
      marketplaceStatus: 1,
    };
  }

  // ───────────────────────── VERIFICATION RULES ─────────────────────────

  /**
   * These statuses summarize core registration
   * and identity verification for admin display.
   *
   * Employer:
   * CAC registration + regulatory registration.
   *
   * Professional:
   * Identity + professional licence.
   *
   * BVN status is displayed separately because
   * payout KYC and professional licensing are
   * distinct verification requirements.
   *
   * Final administrative approval is also separate.
   */

  static getVerificationStatusExpression(role, now) {
    const profile = "$profile";

    const fields =
      role === "employer"
        ? [`${profile}.cacVerificationStatus`, `${profile}.regulatoryVerificationStatus`]
        : [`${profile}.identityVerificationStatus`, `${profile}.licenceVerificationStatus`];

    const anyStatus = (status) => ({
      $or: fields.map((field) => ({
        $eq: [field, status],
      })),
    });

    const allVerified = {
      $and: fields.map((field) => ({
        $eq: [field, "verified"],
      })),
    };

    const branches = [
      {
        case: {
          $eq: ["$hasProfile", false],
        },
        then: "not_onboarded",
      },
      {
        case: anyStatus("rejected"),
        then: "rejected",
      },
      {
        case: anyStatus("needs_review"),
        then: "needs_review",
      },
    ];

    if (role === "professional") {
      branches.push({
        case: {
          $and: [
            {
              $eq: ["$profile.licenceVerificationStatus", "verified"],
            },
            {
              $ne: ["$profile.licenceExpiryDate", null],
            },
            {
              $lt: ["$profile.licenceExpiryDate", now],
            },
          ],
        },
        then: "expired",
      });
    }

    branches.push({
      case: allVerified,
      then: "verified",
    });

    return {
      $switch: {
        branches,
        default: "pending",
      },
    };
  }

  static deriveVerificationStatus(role, profile, now = new Date()) {
    if (!profile) {
      return "not_onboarded";
    }

    const statuses =
      role === "employer"
        ? [profile.cacVerificationStatus, profile.regulatoryVerificationStatus]
        : [profile.identityVerificationStatus, profile.licenceVerificationStatus];

    if (statuses.includes("rejected")) {
      return "rejected";
    }

    if (statuses.includes("needs_review")) {
      return "needs_review";
    }

    if (
      role === "professional" &&
      profile.licenceVerificationStatus === "verified" &&
      profile.licenceExpiryDate &&
      new Date(profile.licenceExpiryDate) < now
    ) {
      return "expired";
    }

    if (statuses.every((status) => status === "verified")) {
      return "verified";
    }

    return "pending";
  }

  static requiresVerificationAttention(status) {
    return ["pending", "needs_review", "rejected", "expired"].includes(status);
  }

  // ───────────────────────── AGGREGATION PIPELINE ─────────────────────────

  static buildUserViewPipeline(role, now) {
    const ProfileModel = this.getProfileModel(role);

    const approvalField =
      role === "employer"
        ? "$profile.employerApprovalStatus"
        : "$profile.professionalApprovalStatus";

    return [
      {
        $lookup: {
          from: ProfileModel.collection.name,
          localField: "_id",
          foreignField: "user",
          pipeline: [
            {
              $project: this.getListProfileProjection(role),
            },
          ],
          as: "profiles",
        },
      },
      {
        $addFields: {
          hasProfile: {
            $gt: [{ $size: "$profiles" }, 0],
          },
          profile: {
            $arrayElemAt: ["$profiles", 0],
          },
        },
      },
      {
        $addFields: {
          verificationStatus: this.getVerificationStatusExpression(role, now),

          approvalStatus: {
            $ifNull: [approvalField, "pending"],
          },
        },
      },
      {
        $addFields: {
          requiresAttention: {
            $in: ["$verificationStatus", ["pending", "needs_review", "rejected", "expired"]],
          },
        },
      },
    ];
  }

  // ───────────────────────── SEARCH AND FILTERS ─────────────────────────

  static buildListFilters({ role, search, verificationStatus, accountStatus }) {
    const conditions = [];

    if (verificationStatus === "attention") {
      conditions.push({
        requiresAttention: true,
      });
    } else if (verificationStatus !== "all") {
      conditions.push({
        verificationStatus,
      });
    }

    if (accountStatus !== "all") {
      conditions.push({
        accountStatus,
      });
    }

    if (search) {
      const regex = this.escapeRegExp(search);

      const searchFields = ["firstName", "lastName", "displayName", "email"];

      if (role === "employer") {
        searchFields.push(
          "profile.businessName",
          "profile.cacRegistrationNumber",
          "profile.regulatoryRegistrationNumber"
        );
      } else {
        searchFields.push("profile.licenceNumber", "profile.specialty");
      }

      conditions.push({
        $or: searchFields.map((field) => ({
          [field]: {
            $regex: regex,
            $options: "i",
          },
        })),
      });
    }

    if (!conditions.length) {
      return {};
    }

    return {
      $and: conditions,
    };
  }

  // ───────────────────────── SUMMARY CARDS ─────────────────────────

  static getSummaryGroupStage() {
    const countWhere = (expression) => ({
      $sum: {
        $cond: [expression, 1, 0],
      },
    });

    return {
      $group: {
        _id: null,

        total: { $sum: 1 },

        pending: countWhere({
          $eq: ["$verificationStatus", "pending"],
        }),

        needsReview: countWhere({
          $eq: ["$verificationStatus", "needs_review"],
        }),

        verified: countWhere({
          $eq: ["$verificationStatus", "verified"],
        }),

        rejected: countWhere({
          $eq: ["$verificationStatus", "rejected"],
        }),

        expired: countWhere({
          $eq: ["$verificationStatus", "expired"],
        }),

        notOnboarded: countWhere({
          $eq: ["$verificationStatus", "not_onboarded"],
        }),

        requiresAttention: countWhere({
          $eq: ["$requiresAttention", true],
        }),

        approved: countWhere({
          $eq: ["$approvalStatus", "approved"],
        }),

        awaitingApproval: countWhere({
          $and: [
            {
              $eq: ["$verificationStatus", "verified"],
            },
            {
              $eq: ["$approvalStatus", "pending"],
            },
          ],
        }),

        restrictedAccounts: countWhere({
          $in: ["$accountStatus", ["restricted", "suspended", "banned"]],
        }),
      },
    };
  }

  static emptySummary() {
    return {
      total: 0,
      pending: 0,
      needsReview: 0,
      verified: 0,
      rejected: 0,
      expired: 0,
      notOnboarded: 0,
      requiresAttention: 0,
      approved: 0,
      awaitingApproval: 0,
      restrictedAccounts: 0,
    };
  }

  // ───────────────────────── LIST USERS ─────────────────────────

  /**
   * Supplies the Employers or Professionals page.
   *
   * Includes:
   * - Summary card counts
   * - Search
   * - Verification status filtering
   * - Account status filtering
   * - Pagination
   * - Core verification badges
   * - Administrative approval status
   *
   * Counts represent the entire selected role,
   * independently of the current search or filter.
   *
   * Users without profiles remain visible.
   */
  static async listUsers({ adminUserId, role, search, status, accountStatus, page, limit }) {
    await this.assertAdmin(adminUserId);

    const selectedRole = this.normalizeRole(role);

    const selectedStatus = this.normalizeVerificationFilter(status);

    const selectedAccountStatus = this.normalizeAccountStatus(accountStatus);

    const searchTerm = this.normalizeSearch(search);

    const currentPage = this.parsePositiveInteger(page, 1, MAX_PAGE_NUMBER);

    const pageSize = this.parsePositiveInteger(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filters = this.buildListFilters({
      role: selectedRole,
      search: searchTerm,
      verificationStatus: selectedStatus,
      accountStatus: selectedAccountStatus,
    });

    const filteredStages = Object.keys(filters).length ? [{ $match: filters }] : [];

    const pipeline = [
      {
        $match: {
          role: selectedRole,
        },
      },

      ...this.buildUserViewPipeline(selectedRole, new Date()),

      {
        $facet: {
          summary: [this.getSummaryGroupStage()],

          totalMatching: [
            ...filteredStages,
            {
              $count: "total",
            },
          ],

          users: [
            ...filteredStages,

            {
              $sort: {
                createdAt: -1,
                _id: -1,
              },
            },

            {
              $skip: (currentPage - 1) * pageSize,
            },

            {
              $limit: pageSize,
            },

            {
              $project: {
                _id: 1,
                firstName: 1,
                lastName: 1,
                displayName: 1,
                email: 1,
                role: 1,
                photo: 1,

                isVerified: 1,
                isOnboarded: 1,
                accountStatus: 1,

                hasProfile: 1,
                profile: 1,

                verificationStatus: 1,
                approvalStatus: 1,
                requiresAttention: 1,

                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
        },
      },
    ];

    const results = await User.aggregate(pipeline);

    const result = results[0] || {};

    const users = result.users || [];

    const summary = result.summary?.[0] || this.emptySummary();

    const total = result.totalMatching?.[0]?.total || 0;

    if (summary._id !== undefined) {
      delete summary._id;
    }

    return {
      success: true,

      data: {
        role: selectedRole,

        users,

        summary,

        filters: {
          role: selectedRole,
          search: searchTerm,
          status: selectedStatus,
          accountStatus: selectedAccountStatus,
        },

        pagination: {
          page: currentPage,
          limit: pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      },
    };
  }

  // ───────────────────────── USER DETAILS ─────────────────────────

  /**
   * Retrieves one employer or professional with
   * the relevant verification summary.
   *
   * This does not retrieve private identity
   * documents, raw BVN data, payment details,
   * or password information.
   *
   * Role comes from the User record.
   */
  static async getUserDetails({ adminUserId, userId }) {
    await this.assertAdmin(adminUserId);

    if (!mongoose.isValidObjectId(userId)) {
      throw this.createError("Invalid user ID.");
    }

    const user = await User.findById(userId)
      .select(
        [
          "firstName",
          "lastName",
          "displayName",
          "email",
          "phoneCode",
          "phoneNumber",
          "photo",
          "role",
          "professionalProfile",
          "employerProfile",
          "isVerified",
          "isOnboarded",
          "accountStatus",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .lean();

    if (!user) {
      throw this.createError("User not found.", 404);
    }

    if (!ALLOWED_ROLES.includes(user.role)) {
      throw this.createError("This endpoint supports employers and professionals only.", 400);
    }

    const ProfileModel = this.getProfileModel(user.role);

    const profileFields =
      user.role === "employer"
        ? [
            "user",
            "type",
            "businessName",
            "businessEmail",
            "businessPhoneCode",
            "businessPhone",
            "countryCode",
            "state",
            "lga",
            "address",

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
            "approvedToPostShiftsAt",
            "approvedToPostShiftsBy",
            "employerApprovalNote",
            "employerRejectionReason",

            "accountStatus",
            "accountStatusReason",
            "createdAt",
            "updatedAt",
          ]
        : [
            "user",
            "type",
            "specialty",
            "phone",
            "phoneCode",
            "yearsOfExperience",
            "state",
            "lga",

            "licenceNumber",
            "licenceIssuingBody",
            "licenceVerificationStatus",
            "licenceVerificationMethod",
            "licenceVerificationSource",
            "licenceNameOnRecord",
            "licenceExpiryDate",
            "licenceVerifiedAt",
            "licenceLastCheckedAt",
            "licenceVerifiedBy",
            "licenceVerificationNote",

            "identityVerificationStatus",
            "identityVerificationMethod",
            "identityVerificationSource",
            "identityNameOnDocument",
            "identityDocumentType",
            "identityVerifiedAt",
            "identityLastCheckedAt",
            "identityVerifiedBy",
            "identityVerificationNote",

            "bvnVerification.status",
            "bvnVerification.lastCheckedAt",
            "bvnVerification.verifiedAt",

            "professionalApprovalStatus",
            "approvedForShiftsAt",
            "approvedForShiftsBy",
            "approvalNote",
            "rejectionReason",

            "accountStatus",
            "accountStatusReason",
            "marketplaceStatus",
            "createdAt",
            "updatedAt",
          ];

    const profile = await ProfileModel.findOne({
      user: user._id,
    })
      .select(profileFields.join(" "))
      .lean();

    const verificationStatus = this.deriveVerificationStatus(user.role, profile);

    const approvalStatus =
      user.role === "employer"
        ? profile?.employerApprovalStatus || "pending"
        : profile?.professionalApprovalStatus || "pending";

    const verification = {
      status: verificationStatus,

      requiresAttention: this.requiresVerificationAttention(verificationStatus),

      coreVerified: verificationStatus === "verified",

      approvalStatus,

      accountStatus: user.accountStatus,
      profileAccountStatus: profile?.accountStatus || null,
    };

    if (user.role === "employer") {
      verification.cacStatus = profile?.cacVerificationStatus || null;

      verification.regulatoryStatus = profile?.regulatoryVerificationStatus || null;
    } else {
      verification.identityStatus = profile?.identityVerificationStatus || null;

      verification.licenceStatus = profile?.licenceVerificationStatus || null;

      verification.bvnStatus = profile?.bvnVerification?.status || "not_started";

      verification.licenceExpired = Boolean(
        profile?.licenceExpiryDate && new Date(profile.licenceExpiryDate) < new Date()
      );
    }

    return {
      success: true,

      data: {
        user,
        profile,
        verification,
      },
    };
  }

  // ───────────────────────── PAGE OPTIONS ─────────────────────────

  /**
   * Prepares the shared user-management page
   * for Employers and Professionals.
   *
   * The controller supplies the CSRF token.
   */
  static async getUsersPageOptions({ adminUserId, role }) {
    await this.assertAdmin(adminUserId);

    const selectedRole = this.normalizeRole(role);

    const label = selectedRole === "employer" ? "Employers" : "Professionals";

    return {
      layout: "layouts/app-layout",

      title: label,

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },
        {
          label,
          url: null,
        },
      ],

      selectedRole,

      scripts: `
        <script src="/js/admin/users.js"></script>
      `,
    };
  }
}

module.exports = AdminUserService;
