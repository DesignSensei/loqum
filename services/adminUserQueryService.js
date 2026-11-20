// services/adminUserQueryService.js

const mongoose = require("mongoose");

const User = require("../models/User");
const EmployerProfile = require("../models/EmployerProfile");
const ProfessionalProfile = require("../models/ProfessionalProfile");

// ───────── Configuration ─────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE_NUMBER = 100000;

const VALID_ROLES = ["employer", "professional"];

const VERIFICATION_FILTERS = [
  "all",
  "attention",
  "pending",
  "needs_review",
  "verified",
  "rejected",
  "expired",
  "not_onboarded",
];

const ACCOUNT_FILTERS = ["all", "active", "restricted", "suspended", "deactivated", "banned"];

const ATTENTION_STATUSES = ["pending", "needs_review", "rejected", "expired"];

// Aggregation requires explicit fields; select:false does not apply.
const DIRECTORY_USER_PROJECTION = {
  _id: 1,
  firstName: 1,
  lastName: 1,
  displayName: 1,
  email: 1,
  role: 1,
  isVerified: 1,
  isOnboarded: 1,
  accountStatus: 1,
  createdAt: 1,
};

const DETAIL_USER_FIELDS = [
  "_id",
  "firstName",
  "lastName",
  "displayName",
  "email",
  "phoneCode",
  "phoneNumber",
  "role",
  "isVerified",
  "isOnboarded",
  "accountStatus",
  "createdAt",
  "updatedAt",
];

class AdminUserQueryService {
  // ───────── Errors ─────────

  static createError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  // ───────── Authorization ─────────

  static async assertAdmin(adminUserId) {
    if (!adminUserId) {
      throw this.createError("Authentication is required.", 401);
    }

    if (!mongoose.isValidObjectId(adminUserId)) {
      throw this.createError("Invalid administrator ID.", 400);
    }

    const admin = await User.findById(adminUserId).select("role accountStatus isVerified").lean();

    if (
      !admin ||
      admin.role !== "admin" ||
      admin.accountStatus !== "active" ||
      admin.isVerified !== true
    ) {
      throw this.createError("An active administrator is required.", 403);
    }

    return admin;
  }

  // ───────── Normalization ─────────

  static normalizeRole(value) {
    const role = String(value || "employer")
      .trim()
      .toLowerCase();

    if (!VALID_ROLES.includes(role)) {
      throw this.createError("Role must be employer or professional.");
    }

    return role;
  }

  static normalizeVerificationFilter(value, role) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    if (!VERIFICATION_FILTERS.includes(status)) {
      throw this.createError("Invalid verification status filter.");
    }

    if (role === "employer" && status === "expired") {
      throw this.createError("The expired licence filter is only available for professionals.");
    }

    return status;
  }

  static normalizeAccountFilter(value) {
    const status = String(value || "all")
      .trim()
      .toLowerCase();

    if (!ACCOUNT_FILTERS.includes(status)) {
      throw this.createError("Invalid account status filter.");
    }

    return status;
  }

  static normalizeSearch(value) {
    if (typeof value !== "string") {
      return "";
    }

    return value.trim().slice(0, 100);
  }

  static normalizePositiveInteger(value, fallback, maximum) {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number) || number < 1) {
      return fallback;
    }

    return Math.min(number, maximum);
  }

  static escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ───────── Profile Models ─────────

  static getProfileModel(role) {
    if (role === "employer") {
      return EmployerProfile;
    }

    if (role === "professional") {
      return ProfessionalProfile;
    }

    throw this.createError("Unsupported user role.");
  }

  // ───────── Directory Projections ─────────

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
        cacRegistrationNumber: 1,
        cacVerificationStatus: 1,
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
      licenceVerificationStatus: 1,
      licenceExpiryDate: 1,
      identityVerificationStatus: 1,
      professionalApprovalStatus: 1,
      accountStatus: 1,
      marketplaceStatus: 1,
    };
  }

  // ───────── Details Projections ─────────

  static getDetailProfileFields(role) {
    if (role === "employer") {
      return [
        "_id",
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
        "cacVerificationNote",
        "cacRejectionReason",

        "accountStatus",
        "accountStatusReason",
        "createdAt",
        "updatedAt",
      ];
    }

    return [
      "_id",
      "user",
      "type",
      "specialty",
      "yearsOfExperience",
      "state",
      "lga",
      "address",

      "licenceNumber",
      "licenceIssuingBody",
      "licenceVerificationStatus",
      "licenceVerificationMethod",
      "licenceVerificationSource",
      "licenceNameOnRecord",
      "licenceExpiryDate",
      "licenceVerifiedAt",
      "licenceLastCheckedAt",
      "licenceVerificationNote",

      "identityVerificationStatus",
      "identityVerificationMethod",
      "identityVerificationSource",
      "identityNameOnDocument",
      "identityDocumentType",
      "identityVerifiedAt",
      "identityLastCheckedAt",
      "identityVerificationNote",

      "bvnVerification.status",
      "bvnVerification.verifiedAt",
      "bvnVerification.lastCheckedAt",

      "professionalApprovalStatus",
      "approvedForShiftsAt",
      "approvalNote",
      "rejectionReason",

      "accountStatus",
      "accountStatusReason",
      "marketplaceStatus",
      "createdAt",
      "updatedAt",
    ];
  }

  // ───────── Verification Rules ─────────

  // Employers: CAC only. Professionals: identity and licence.
  // Branch permits, payout KYC and account restrictions are separate.

  static getCoreVerificationFields(role) {
    if (role === "employer") {
      return ["cacVerificationStatus"];
    }

    return ["identityVerificationStatus", "licenceVerificationStatus"];
  }

  static isLicenceExpired(profile, now = new Date()) {
    if (!profile || !profile.licenceExpiryDate) {
      return false;
    }

    const expiryDate = new Date(profile.licenceExpiryDate);

    if (Number.isNaN(expiryDate.getTime())) {
      return false;
    }

    return expiryDate < now;
  }

  static deriveVerificationStatus(role, profile, now = new Date()) {
    if (!profile) {
      return "not_onboarded";
    }

    const fields = this.getCoreVerificationFields(role);

    const statuses = fields.map((field) => profile[field] || "pending");

    if (statuses.includes("rejected")) {
      return "rejected";
    }

    if (statuses.includes("needs_review")) {
      return "needs_review";
    }

    if (
      role === "professional" &&
      profile.licenceVerificationStatus === "verified" &&
      this.isLicenceExpired(profile, now)
    ) {
      return "expired";
    }

    if (statuses.every((status) => status === "verified")) {
      return "verified";
    }

    return "pending";
  }

  // ───────── Aggregation Verification ─────────

  static getVerificationStatusExpression(role, now = new Date()) {
    const fields = this.getCoreVerificationFields(role).map((field) => `$profile.${field}`);

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

  // ───────── Profile Lookup ─────────

  static buildUserLookupPipeline(role, now = new Date()) {
    const ProfileModel = this.getProfileModel(role);

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
        $set: {
          hasProfile: {
            $gt: [{ $size: "$profiles" }, 0],
          },
          profile: {
            $arrayElemAt: ["$profiles", 0],
          },
        },
      },
      {
        $unset: "profiles",
      },
      {
        $set: {
          verificationStatus: this.getVerificationStatusExpression(role, now),

          ...(role === "professional"
            ? {
                approvalStatus: {
                  $cond: [
                    "$hasProfile",
                    { $ifNull: ["$profile.professionalApprovalStatus", "pending"] },
                    "not_available",
                  ],
                },
              }
            : {}),
        },
      },
      {
        $set: {
          requiresAttention: {
            $in: ["$verificationStatus", ATTENTION_STATUSES],
          },
        },
      },
    ];
  }

  // ───────── Search ─────────

  static buildSearchCondition(role, search) {
    if (!search) {
      return null;
    }

    const regex = this.escapeRegExp(search);

    const userFields = ["firstName", "lastName", "displayName", "email"];

    const profileFields =
      role === "employer"
        ? ["profile.businessName", "profile.businessEmail", "profile.cacRegistrationNumber"]
        : ["profile.type", "profile.specialty", "profile.licenceNumber"];

    const conditions = [...userFields, ...profileFields].map((field) => ({
      [field]: {
        $regex: regex,
        $options: "i",
      },
    }));

    conditions.push({
      $expr: {
        $regexMatch: {
          input: {
            $concat: [
              {
                $ifNull: ["$firstName", ""],
              },
              " ",
              {
                $ifNull: ["$lastName", ""],
              },
            ],
          },
          regex,
          options: "i",
        },
      },
    });

    return {
      $or: conditions,
    };
  }

  // ───────── Filters ─────────

  static buildFilters({ role, search, verificationStatus, accountStatus }) {
    const conditions = [];

    const searchCondition = this.buildSearchCondition(role, search);

    if (searchCondition) {
      conditions.push(searchCondition);
    }

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

    if (!conditions.length) {
      return null;
    }

    return {
      $and: conditions,
    };
  }

  // ───────── Summary ─────────

  static getSummaryGroupStage(role) {
    const countWhen = (condition) => ({
      $sum: {
        $cond: [condition, 1, 0],
      },
    });

    const countStatus = (status) =>
      countWhen({
        $eq: ["$verificationStatus", status],
      });

    const group = {
      _id: null,

      total: {
        $sum: 1,
      },

      pending: countStatus("pending"),

      needsReview: countStatus("needs_review"),

      verified: countStatus("verified"),

      rejected: countStatus("rejected"),

      expired: countStatus("expired"),

      notOnboarded: countStatus("not_onboarded"),

      requiresAttention: countWhen({
        $eq: ["$requiresAttention", true],
      }),

      restrictedAccounts: countWhen({
        $in: ["$accountStatus", ["restricted", "suspended", "banned"]],
      }),
    };

    // Only professionals have an approval stage.
    if (role === "professional") {
      group.approved = countWhen({ $eq: ["$approvalStatus", "approved"] });

      group.awaitingApproval = countWhen({
        $and: [
          { $eq: ["$verificationStatus", "verified"] },
          { $eq: ["$approvalStatus", "pending"] },
        ],
      });
    }

    return { $group: group };
  }

  static emptySummary(role) {
    return {
      total: 0,
      pending: 0,
      needsReview: 0,
      verified: 0,
      rejected: 0,
      expired: 0,
      notOnboarded: 0,
      requiresAttention: 0,
      restrictedAccounts: 0,
      ...(role === "professional" ? { approved: 0, awaitingApproval: 0 } : {}),
    };
  }

  // ───────── Directory Pipeline ─────────

  static buildDirectoryBasePipeline(role, now) {
    return [
      {
        $match: {
          role,
        },
      },
      {
        $project: DIRECTORY_USER_PROJECTION,
      },
      ...this.buildUserLookupPipeline(role, now),
    ];
  }

  static buildDirectoryRowsPipeline(filter, page, limit) {
    return [
      ...(filter ? [{ $match: filter }] : []),

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
    ];
  }

  // ───────── List Users ─────────
  // Directory summaries ignore filters; results include incomplete onboarding.

  static async listUsers({ adminUserId, role, search, status, accountStatus, page, limit }) {
    await this.assertAdmin(adminUserId);

    const selectedRole = this.normalizeRole(role);

    const selectedStatus = this.normalizeVerificationFilter(status, selectedRole);

    const selectedAccountStatus = this.normalizeAccountFilter(accountStatus);

    const searchTerm = this.normalizeSearch(search);

    const requestedPage = this.normalizePositiveInteger(page, 1, MAX_PAGE_NUMBER);

    const pageSize = this.normalizePositiveInteger(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const now = new Date();

    const basePipeline = this.buildDirectoryBasePipeline(selectedRole, now);

    const filter = this.buildFilters({
      role: selectedRole,
      search: searchTerm,
      verificationStatus: selectedStatus,
      accountStatus: selectedAccountStatus,
    });

    const filteredStages = filter ? [{ $match: filter }] : [];

    const pipeline = [
      ...basePipeline,
      {
        $facet: {
          summary: [this.getSummaryGroupStage(selectedRole)],

          matching: [
            ...filteredStages,
            {
              $count: "total",
            },
          ],

          users: this.buildDirectoryRowsPipeline(filter, requestedPage, pageSize),
        },
      },
    ];

    const [result = {}] = await User.aggregate(pipeline);

    const rawSummary = result.summary?.[0] || {};

    const { _id: ignoredSummaryId, ...summaryValues } = rawSummary;

    const summary = {
      ...this.emptySummary(selectedRole),
      ...summaryValues,
    };

    const total = result.matching?.[0]?.total || 0;

    const totalPages = Math.ceil(total / pageSize);

    // Clamp out-of-range pages to available results.
    const currentPage = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);

    let users = result.users || [];

    if (total > 0 && currentPage !== requestedPage) {
      users = await User.aggregate([
        ...basePipeline,
        ...this.buildDirectoryRowsPipeline(filter, currentPage, pageSize),
      ]);
    }

    return {
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
        totalPages,

        hasPreviousPage: currentPage > 1,

        hasNextPage: currentPage < totalPages,
      },
    };
  }

  // ───────── User Details ─────────
  // Exclude sensitive identity, BVN and authentication data.

  static async getUserDetails({ adminUserId, userId }) {
    await this.assertAdmin(adminUserId);

    if (!mongoose.isValidObjectId(userId)) {
      throw this.createError("Invalid user ID.", 400);
    }

    const user = await User.findById(userId).select(DETAIL_USER_FIELDS.join(" ")).lean();

    if (!user) {
      throw this.createError("User not found.", 404);
    }

    if (!VALID_ROLES.includes(user.role)) {
      throw this.createError("Only employer and professional accounts are supported.", 400);
    }

    const ProfileModel = this.getProfileModel(user.role);

    const profile = await ProfileModel.findOne({
      user: user._id,
    })
      .select(this.getDetailProfileFields(user.role).join(" "))
      .lean();

    const now = new Date();

    const verificationStatus = this.deriveVerificationStatus(user.role, profile, now);

    const verification = {
      status: verificationStatus,

      requiresAttention: ATTENTION_STATUSES.includes(verificationStatus),

      coreVerified: verificationStatus === "verified",

      userAccountStatus: user.accountStatus,

      profileAccountStatus: profile?.accountStatus || null,
    };

    if (user.role === "employer") {
      verification.cacStatus = profile?.cacVerificationStatus || null;
    } else {
      verification.approvalStatus = !profile
        ? "not_available"
        : profile.professionalApprovalStatus || "pending";

      verification.identityStatus = profile?.identityVerificationStatus || null;

      verification.licenceStatus = profile?.licenceVerificationStatus || null;

      verification.bvnStatus = profile?.bvnVerification?.status || "not_started";

      verification.licenceExpired = this.isLicenceExpired(profile, now);
    }

    return {
      user,
      profile,
      verification,
    };
  }
}

module.exports = AdminUserQueryService;
