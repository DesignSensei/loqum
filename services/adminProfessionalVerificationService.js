// services/adminProfessionalVerificationService.js

const mongoose = require("mongoose");

const ProfessionalProfile = require("../models/ProfessionalProfile");
const KYCVerification = require("../models/KYCVerification");

const ProfessionalVerificationService = require("./professionalVerificationService");
const { createServiceError } = require("./helpers/serviceErrorHelper");

const ADMIN_PROFESSIONAL_VERIFICATION_SERVICE_ERROR_NAME =
  "AdminProfessionalVerificationServiceError";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_RECENT_ATTEMPTS = 50;

const PROFESSIONAL_TYPES = Object.freeze([
  "pharmacist",
  "pharmacy_technician",
  "nurse",
  "doctor",
  "lab_scientist",
  "radiographer",
  "physiotherapist",
]);

const QUEUE_STATUSES = Object.freeze([
  "all",
  "awaiting_review",
  "ready_for_approval",
  "identity_review",
  "licence_review",
  "pending",
  "needs_review",
  "approved",
  "rejected",
]);

class AdminProfessionalVerificationService {
  /*
   * ADMIN PROFESSIONAL VERIFICATION ARCHITECTURE
   *
   * Responsibilities:
   * - Administrator authorization;
   * - Verification dashboard summaries;
   * - Paginated professional verification queues;
   * - Professional verification details;
   * - Sanitized KYC attempt history;
   * - Administrative identity review delegation;
   * - Professional licence review delegation;
   * - Final professional approval delegation.
   *
   * ProfessionalVerificationService remains the
   * authority for verification state transitions.
   *
   * IDENTITY POLICY
   *
   * A successful registry lookup does not establish
   * identity-holder authentication.
   *
   * A completed hosted verification flow alone
   * does not establish biometric approval.
   *
   * Identity and licence verification are one-time.
   * No annual or expiry-driven re-verification.
   *
   * A licence-number change triggers fresh licence
   * verification and professional approval.
   *
   * SECURITY
   *
   * All public methods validate an active admin.
   *
   * Never return raw NIN/BVN, provider credentials,
   * full provider responses, document access URLs,
   * selfie URLs, internal request references,
   * provider webhook identifiers, or raw metadata.
   */

  // ───────────────────────── ERRORS ─────────────────────────

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: ADMIN_PROFESSIONAL_VERIFICATION_SERVICE_ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  // ───────────────────────── AUTHORIZATION ─────────────────────────

  static async assertAdmin(adminUserId) {
    return ProfessionalVerificationService.assertAdmin(adminUserId);
  }

  // ───────────────────────── VALIDATION ─────────────────────────

  static assertObjectId(value, label) {
    if (!mongoose.isValidObjectId(value)) {
      throw this.createError({
        message: `Invalid ${label}.`,
        code: "ADMIN_PROFESSIONAL_INVALID_ID",
        statusCode: 400,
      });
    }
  }

  static normalizePage(value) {
    if (value === undefined || value === null || value === "") {
      return 1;
    }

    const page = Number(value);

    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) {
      throw this.createError({
        message: "Invalid pagination page.",
        code: "ADMIN_PROFESSIONAL_INVALID_PAGE",
        statusCode: 400,
      });
    }

    return page;
  }

  static normalizeLimit(value) {
    if (value === undefined || value === null || value === "") {
      return DEFAULT_PAGE_SIZE;
    }

    const limit = Number(value);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw this.createError({
        message: `Page size must be between 1 and ${MAX_PAGE_SIZE}.`,
        code: "ADMIN_PROFESSIONAL_INVALID_LIMIT",
        statusCode: 400,
      });
    }

    return limit;
  }

  static normalizeStatus(value) {
    const status = String(value || "awaiting_review")
      .trim()
      .toLowerCase();

    if (!QUEUE_STATUSES.includes(status)) {
      throw this.createError({
        message: "Invalid professional verification filter.",
        code: "ADMIN_PROFESSIONAL_INVALID_STATUS",
        statusCode: 400,
      });
    }

    return status;
  }

  static normalizeProfessionalType(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    const type = String(value).trim().toLowerCase();

    if (!PROFESSIONAL_TYPES.includes(type)) {
      throw this.createError({
        message: "Invalid professional type.",
        code: "ADMIN_PROFESSIONAL_INVALID_TYPE",
        statusCode: 400,
      });
    }

    return type;
  }

  static normalizeSearch(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    if (typeof value !== "string") {
      throw this.createError({
        message: "Invalid search query.",
        code: "ADMIN_PROFESSIONAL_INVALID_SEARCH",
        statusCode: 400,
      });
    }

    const search = value.trim();

    if (!search) {
      return null;
    }

    if (search.length > 80) {
      throw this.createError({
        message: "Search query is too long.",
        code: "ADMIN_PROFESSIONAL_INVALID_SEARCH",
        statusCode: 400,
      });
    }

    return search;
  }

  static escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ───────────────────────── QUEUE FILTERS ─────────────────────────

  static buildQueueFilter({ status = "awaiting_review", type = null, search = null } = {}) {
    const normalizedStatus = this.normalizeStatus(status);
    const normalizedType = this.normalizeProfessionalType(type);
    const normalizedSearch = this.normalizeSearch(search);

    const filter = {};

    if (normalizedType) {
      filter.type = normalizedType;
    }

    switch (normalizedStatus) {
      case "awaiting_review":
        filter.professionalApprovalStatus = {
          $in: ["pending", "needs_review"],
        };
        break;

      case "ready_for_approval":
        filter.professionalApprovalStatus = {
          $in: ["pending", "needs_review"],
        };

        filter.identityVerificationStatus = "verified";
        filter.licenceVerificationStatus = "verified";
        filter.accountStatus = "active";
        break;

      case "identity_review":
        filter.identityVerificationStatus = {
          $in: ["pending", "needs_review"],
        };
        break;

      case "licence_review":
        filter.licenceVerificationStatus = {
          $in: ["pending", "needs_review"],
        };
        break;

      case "pending":
      case "needs_review":
      case "approved":
      case "rejected":
        filter.professionalApprovalStatus = normalizedStatus;
        break;

      case "all":
        break;
    }

    if (normalizedSearch) {
      const escapedSearch = this.escapeRegex(normalizedSearch);
      const expression = new RegExp(escapedSearch, "i");

      filter.$or = [
        {
          licenceNumber: expression,
        },
        {
          specialty: expression,
        },
        {
          licenceIssuingBody: expression,
        },
      ];
    }

    return filter;
  }

  // ───────────────────────── DASHBOARD OPTIONS ─────────────────────────

  static async getDashboardPageOptions({ adminUserId } = {}) {
    await this.assertAdmin(adminUserId);

    const [
      total,
      awaitingReview,
      readyForApproval,
      identityReview,
      licenceReview,
      approved,
      rejected,
    ] = await Promise.all([
      ProfessionalProfile.countDocuments({}),

      ProfessionalProfile.countDocuments(
        this.buildQueueFilter({
          status: "awaiting_review",
        })
      ),

      ProfessionalProfile.countDocuments(
        this.buildQueueFilter({
          status: "ready_for_approval",
        })
      ),

      ProfessionalProfile.countDocuments(
        this.buildQueueFilter({
          status: "identity_review",
        })
      ),

      ProfessionalProfile.countDocuments(
        this.buildQueueFilter({
          status: "licence_review",
        })
      ),

      ProfessionalProfile.countDocuments({
        professionalApprovalStatus: "approved",
      }),

      ProfessionalProfile.countDocuments({
        professionalApprovalStatus: "rejected",
      }),
    ]);

    return {
      title: "Professional Verifications",

      stats: {
        total,
        awaitingReview,
        readyForApproval,
        identityReview,
        licenceReview,
        approved,
        rejected,
      },

      statusOptions: [...QUEUE_STATUSES],
      professionalTypeOptions: [...PROFESSIONAL_TYPES],
    };
  }

  // ───────────────────────── VERIFICATION QUEUE ─────────────────────────

  static async listProfessionals({
    adminUserId,
    status = "awaiting_review",
    type,
    search,
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
  } = {}) {
    await this.assertAdmin(adminUserId);

    const pageNumber = this.normalizePage(page);
    const pageSize = this.normalizeLimit(limit);

    const normalizedStatus = this.normalizeStatus(status);
    const normalizedType = this.normalizeProfessionalType(type);
    const normalizedSearch = this.normalizeSearch(search);

    const filter = this.buildQueueFilter({
      status: normalizedStatus,
      type: normalizedType,
      search: normalizedSearch,
    });

    const skip = (pageNumber - 1) * pageSize;

    const [profiles, total] = await Promise.all([
      ProfessionalProfile.find(filter)
        .select(
          [
            "user",
            "type",
            "specialty",
            "state",
            "lga",
            "licenceIssuingBody",
            "licenceVerificationStatus",
            "identityVerificationStatus",
            "professionalApprovalStatus",
            "accountStatus",
            "marketplaceStatus",
            "licenceLastCheckedAt",
            "identityLastCheckedAt",
            "licenceVerifiedAt",
            "identityVerifiedAt",
            "updatedAt",
            "createdAt",
          ].join(" ")
        )
        .sort({
          updatedAt: -1,
          _id: -1,
        })
        .skip(skip)
        .limit(pageSize)
        .lean(),

      ProfessionalProfile.countDocuments(filter),
    ]);

    const data = profiles.map((profile) => {
      const readiness = ProfessionalVerificationService.getVerificationReadiness(profile);

      return {
        professionalProfileId: String(profile._id),
        userId: String(profile.user),
        professionalType: profile.type,
        specialty: profile.specialty,
        state: profile.state,
        lga: profile.lga,
        licenceIssuingBody: profile.licenceIssuingBody,

        identityVerificationStatus: profile.identityVerificationStatus,

        licenceVerificationStatus: profile.licenceVerificationStatus,

        professionalApprovalStatus: profile.professionalApprovalStatus,

        accountStatus: profile.accountStatus,
        marketplaceStatus: profile.marketplaceStatus,

        identityLastCheckedAt: profile.identityLastCheckedAt,
        licenceLastCheckedAt: profile.licenceLastCheckedAt,

        identityVerifiedAt: profile.identityVerifiedAt,
        licenceVerifiedAt: profile.licenceVerifiedAt,

        verificationReadiness: readiness,
        updatedAt: profile.updatedAt,
      };
    });

    return {
      success: true,
      data,

      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        hasNextPage: skip + data.length < total,
        hasPreviousPage: pageNumber > 1,
      },

      filters: {
        status: normalizedStatus,
        type: normalizedType,
        search: normalizedSearch,
      },
    };
  }

  // ───────────────────────── VERIFICATION DETAILS ─────────────────────────

  static async getProfessionalVerification({ adminUserId, professionalProfileId } = {}) {
    await this.assertAdmin(adminUserId);

    this.assertObjectId(professionalProfileId, "professional profile ID");

    const profile = await ProfessionalProfile.findById(professionalProfileId)
      .select(
        [
          "user",
          "type",
          "specialty",
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
          "professionalApprovalStatus",
          "approvedForShiftsAt",
          "approvedForShiftsBy",
          "approvalNote",
          "rejectionReason",
          "accountStatus",
          "marketplaceStatus",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .lean();

    if (!profile) {
      throw this.createError({
        message: "Professional profile not found.",
        code: "ADMIN_PROFESSIONAL_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    const [attempts, totalAttempts] = await Promise.all([
      KYCVerification.find({
        professional: profile._id,
        ownerType: "professional",
      })
        .select(
          [
            "type",
            "provider",
            "providerEnvironment",
            "status",
            "nameOnRecord",
            "dateOfBirthMatch",
            "nameMatchScore",
            "rejectionReason",
            "failureReason",
            "reviewNote",
            "documentType",
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
        .limit(MAX_RECENT_ATTEMPTS)
        .lean(),

      KYCVerification.countDocuments({
        professional: profile._id,
        ownerType: "professional",
      }),
    ]);

    const readiness = ProfessionalVerificationService.getVerificationReadiness(profile);

    return {
      success: true,

      data: {
        professionalProfileId: String(profile._id),
        userId: String(profile.user),
        professionalType: profile.type,
        specialty: profile.specialty,

        identityVerification: {
          status: profile.identityVerificationStatus,
          method: profile.identityVerificationMethod,
          source: profile.identityVerificationSource,
          nameOnDocument: profile.identityNameOnDocument,
          documentType: profile.identityDocumentType,
          verifiedAt: profile.identityVerifiedAt,
          lastCheckedAt: profile.identityLastCheckedAt,
          verifiedBy: profile.identityVerifiedBy,
          note: profile.identityVerificationNote,
        },

        licenceVerification: {
          licenceNumber: profile.licenceNumber,
          issuingBody: profile.licenceIssuingBody,
          status: profile.licenceVerificationStatus,
          method: profile.licenceVerificationMethod,
          source: profile.licenceVerificationSource,
          nameOnRecord: profile.licenceNameOnRecord,

          // Informational only. No expiry-driven re-verification.
          expiryDate: profile.licenceExpiryDate,

          verifiedAt: profile.licenceVerifiedAt,
          lastCheckedAt: profile.licenceLastCheckedAt,
          verifiedBy: profile.licenceVerifiedBy,
          note: profile.licenceVerificationNote,
        },

        professionalApproval: {
          status: profile.professionalApprovalStatus,
          approvedForShiftsAt: profile.approvedForShiftsAt,
          approvedForShiftsBy: profile.approvedForShiftsBy,
          approvalNote: profile.approvalNote,
          rejectionReason: profile.rejectionReason,
        },

        accountStatus: profile.accountStatus,
        marketplaceStatus: profile.marketplaceStatus,
        verificationReadiness: readiness,

        verificationHistory: {
          total: totalAttempts,
          returned: attempts.length,
          hasMore: totalAttempts > attempts.length,

          attempts: attempts.map((attempt) => ({
            verificationId: String(attempt._id),
            type: attempt.type,
            provider: attempt.provider,
            environment: attempt.providerEnvironment,
            status: attempt.status,
            nameOnRecord: attempt.nameOnRecord,
            dateOfBirthMatch: attempt.dateOfBirthMatch,
            nameMatchScore: attempt.nameMatchScore,
            rejectionReason: attempt.rejectionReason,
            failureReason: attempt.failureReason,
            reviewNote: attempt.reviewNote,
            documentType: attempt.documentType,
            submittedAt: attempt.submittedAt,
            verifiedAt: attempt.verifiedAt,
            rejectedAt: attempt.rejectedAt,
            failedAt: attempt.failedAt,
            lastCheckedAt: attempt.lastCheckedAt,
            reviewedBy: attempt.reviewedBy,
            isActive: attempt.isActive,
            createdAt: attempt.createdAt,
          })),
        },

        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
    };
  }

  // ───────────────────────── INDIVIDUAL KYC ATTEMPT ─────────────────────────

  static async getVerificationAttempt({ adminUserId, verificationId } = {}) {
    await this.assertAdmin(adminUserId);
    this.assertObjectId(verificationId, "verification ID");

    const attempt = await KYCVerification.findOne({
      _id: verificationId,
      ownerType: "professional",
    }).select("+metadata +documentUrl +selfieUrl");

    if (!attempt) {
      throw this.createError({
        message: "Verification attempt not found.",
        code: "ADMIN_PROFESSIONAL_ATTEMPT_NOT_FOUND",
        statusCode: 404,
      });
    }

    /*
     * Return a fixed allowlist of sanitized fields.
     * Metadata may contain historical provider information.
     * Evidence availability does not prove verification.
     */
    const metadata =
      attempt.metadata && typeof attempt.metadata === "object" && !Array.isArray(attempt.metadata)
        ? attempt.metadata
        : {};

    const safeEvidence = {
      registryFound: typeof metadata.registryFound === "boolean" ? metadata.registryFound : null,

      detailsMatched: typeof metadata.detailsMatched === "boolean" ? metadata.detailsMatched : null,

      holderAuthenticated:
        typeof metadata.holderAuthenticated === "boolean" ? metadata.holderAuthenticated : null,

      hostedStatus:
        typeof metadata.hostedStatus === "string" ? metadata.hostedStatus.slice(0, 40) : null,

      hostedOutcome:
        typeof metadata.hostedOutcome === "string" ? metadata.hostedOutcome.slice(0, 40) : null,

      verificationSource:
        typeof metadata.verificationSource === "string"
          ? metadata.verificationSource.slice(0, 80)
          : null,

      councilReviewed: metadata.councilReviewed === true,

      licenceNumberChanged: metadata.licenceNumberChanged === true,

      documentAvailable: Boolean(attempt.documentUrl),

      selfieAvailable: Boolean(attempt.selfieUrl),
    };

    return {
      success: true,

      data: {
        verificationId: String(attempt._id),
        professionalProfileId: String(attempt.professional),
        userId: String(attempt.user),

        type: attempt.type,
        provider: attempt.provider,
        environment: attempt.providerEnvironment,
        status: attempt.status,

        nameOnRecord: attempt.nameOnRecord,
        dateOfBirthMatch: attempt.dateOfBirthMatch,
        nameMatchScore: attempt.nameMatchScore,
        rejectionReason: attempt.rejectionReason,
        failureReason: attempt.failureReason,
        reviewNote: attempt.reviewNote,
        documentType: attempt.documentType,

        evidence: safeEvidence,

        submittedAt: attempt.submittedAt,
        lastCheckedAt: attempt.lastCheckedAt,
        verifiedAt: attempt.verifiedAt,
        rejectedAt: attempt.rejectedAt,
        failedAt: attempt.failedAt,
        reviewedBy: attempt.reviewedBy,

        isActive: attempt.isActive,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      },
    };
  }

  // ───────────────────────── IDENTITY REVIEW ─────────────────────────

  /*
   * Delegate identity-holder verification decisions
   * to ProfessionalVerificationService.
   *
   * The domain service requires a linked KYC attempt
   * and trusted evidence before approving identity.
   *
   * NIN registry matching or a completed hosted flow
   * alone cannot authenticate the applicant.
   */

  static async reviewIdentity({
    adminUserId,
    professionalProfileId,
    verificationId,
    decision,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    return ProfessionalVerificationService.recordIdentityReview({
      adminUserId,
      professionalProfileId,
      verificationId,
      decision,
      note,
    });
  }

  // ───────────────────────── LICENCE REVIEW ─────────────────────────

  static async reviewLicence({
    adminUserId,
    professionalProfileId,
    decision,
    nameOnRecord,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    return ProfessionalVerificationService.recordLicenceReview({
      adminUserId,
      professionalProfileId,
      decision,
      nameOnRecord,
      note,
    });
  }

  // ───────────────────────── PROFESSIONAL APPROVAL ─────────────────────────

  static async reviewProfessionalApproval({
    adminUserId,
    professionalProfileId,
    decision,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    return ProfessionalVerificationService.reviewProfessionalApproval({
      adminUserId,
      professionalProfileId,
      decision,
      note,
    });
  }
}

module.exports = AdminProfessionalVerificationService;
