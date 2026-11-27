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
const READINESS_BATCH_SIZE = 10;

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
  "licence_review",
  "pending",
  "needs_review",
  "approved",
  "rejected",
]);

const EXPECTED_VERIFICATION_EVIDENCE_ERRORS = new Set([
  "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_CONFLICTING_REVIEWS",
  "PROFESSIONAL_VERIFICATION_UPCOMING_INCONSISTENT",
  "PROFESSIONAL_VERIFICATION_UPCOMING_EVIDENCE_MISMATCH",
]);

class AdminProfessionalVerificationService {
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

  // ───────────────────────── QUEUE PROJECTION ─────────────────────────

  static getQueueProjection() {
    return [
      "user",
      "type",
      "specialty",
      "state",
      "lga",
      "licenceNumber",
      "licenceIssuingBody",
      "licenceVerificationStatus",
      "licenceVerificationMethod",
      "licenceVerificationSource",
      "licenceNameOnRecord",
      "licenceValidityType",
      "licenceLicensingYear",
      "licenceExpiryDate",
      "licenceVerifiedAt",
      "licenceVerifiedBy",
      "licenceLastCheckedAt",
      "licencePendingDocumentSubmittedAt",
      "upcomingLicence",
      "professionalApprovalStatus",
      "approvedForShiftsAt",
      "approvedForShiftsBy",
      "accountStatus",
      "marketplaceStatus",
      "updatedAt",
      "createdAt",
    ].join(" ");
  }

  // ───────────────────────── QUEUE FILTERS ─────────────────────────

  static buildQueueFilter({ status = "awaiting_review", type = null, search = null } = {}) {
    const normalizedStatus = this.normalizeStatus(status);
    const normalizedType = this.normalizeProfessionalType(type);
    const normalizedSearch = this.normalizeSearch(search);
    const filter = {};
    const andConditions = [];

    if (normalizedType) filter.type = normalizedType;

    if (["awaiting_review", "licence_review", "pending", "needs_review"].includes(normalizedStatus)) {
      filter.accountStatus = { $ne: "closed" };
    }

    switch (normalizedStatus) {
      case "awaiting_review":
        // Include pending final approvals AND renewal uploads from professionals
        // whose currently approved licence remains verified.
        andConditions.push({
          $or: [
            { professionalApprovalStatus: { $in: ["pending", "needs_review"] } },
            { licencePendingDocumentSubmittedAt: { $type: "date" } },
          ],
        });
        break;

      case "ready_for_approval":
        filter.professionalApprovalStatus = { $in: ["pending", "needs_review"] };
        filter.licenceVerificationStatus = "verified";
        filter.licenceVerificationMethod = "manual";
        filter.licenceVerificationSource = "uploaded_document";
        filter.accountStatus = "active";
        filter.licenceNumber = { $type: "string", $ne: "" };
        filter.licenceNameOnRecord = { $type: "string", $ne: "" };
        break;

      case "licence_review":
        // The pending upload, not the active licence status, defines the queue.
        // Otherwise early renewal submissions are invisible to admins.
        filter.licencePendingDocumentSubmittedAt = { $type: "date" };
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
      const expression = new RegExp(this.escapeRegex(normalizedSearch), "i");
      andConditions.push({
        $or: [
          { licenceNumber: expression },
          { specialty: expression },
          { licenceIssuingBody: expression },
        ],
      });
    }

    if (andConditions.length) filter.$and = andConditions;
    return filter;
  }

  // ───────────────────────── PROFILE READINESS ─────────────────────────

  static getProfileApprovalReadiness(profile, trusted = null) {
    const readiness = ProfessionalVerificationService.getVerificationReadiness(profile, trusted);
    const approvalPending = ["pending", "needs_review"].includes(
      profile.professionalApprovalStatus
    );
    const validLicenceNumber =
      typeof profile.licenceNumber === "string" && profile.licenceNumber.trim().length > 0;

    // A stored NIN registry-name match is evidence, not a separate admin
    // identity approval. The licence and final approval remain separate.
    return {
      ...readiness,
      readyForApproval:
        approvalPending &&
        readiness.ninEvidenceConfirmed === true &&
        readiness.licenceVerified === true &&
        readiness.licenceCurrent === true &&
        readiness.licenceSourceValid === true &&
        readiness.namesConsistent === true &&
        readiness.accountActive === true &&
        validLicenceNumber,
    };
  }

  // ───────────────────────── TRUSTED NIN EVIDENCE ─────────────────────────

  /**
   * Retained independently for existing callers.
   *
   * Confirms trusted production NIN onboarding evidence
   * without requiring an administrative review decision.
   */

  static async hasTrustedNinEvidence(profile) {
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        await ProfessionalVerificationService.getTrustedOnboardingNIN({
          profile,
          session,
        });
      });

      return true;
    } catch (error) {
      if (EXPECTED_VERIFICATION_EVIDENCE_ERRORS.has(error?.code)) {
        return false;
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────────── COMPLETE REVIEW EVIDENCE ─────────────────────────

  /**
   * Read the ORIGINAL production NIN registry evidence and the active
   * manually reviewed practising-licence record. There is no second NIN
   * lookup, no government-ID upload, and no admin identity-review record.
   *
   * Read current profile data rather than trusting an earlier queue snapshot.
   * Incomplete/mismatched evidence blocks readiness; unexpected DB errors
   * are not silently treated as a negative verification decision.
   */
  static async getReviewEvidenceStatus(profile) {
    this.assertObjectId(profile?._id, "professional profile ID");
    const session = await mongoose.startSession();

    let trustedNinEvidence = false;
    let verifiedReviewEvidence = false;
    let ninEvidence = null;
    let readiness = this.getProfileApprovalReadiness(profile);
    let evidenceErrorCode = null;

    try {
      await session.withTransaction(async () => {
        const current = await ProfessionalProfile.findById(profile._id)
          .select(this.getQueueProjection())
          .session(session);

        if (!current) {
          throw this.createError({
            message: "Professional profile not found.",
            code: "ADMIN_PROFESSIONAL_PROFILE_NOT_FOUND",
            statusCode: 404,
          });
        }

        const trusted = await ProfessionalVerificationService.getTrustedOnboardingNIN({
          profile: current,
          session,
        });
        trustedNinEvidence = true;
        ninEvidence = {
          evidenceId: String(trusted.evidence._id),
          registryLegalName: trusted.legalName,
          provider: trusted.evidence.provider,
          providerEnvironment: trusted.evidence.providerEnvironment,
          registryLookupStatus: "name_returned_and_acknowledged",
          nameAcknowledged: true,
          holderAuthenticated: false,
          checkedAt: trusted.evidence.lastCheckedAt || null,
          adminNinApprovalRequired: false,
        };

        readiness = this.getProfileApprovalReadiness(current, trusted);

        if (
          readiness.licenceVerified &&
          readiness.licenceSourceValid &&
          readiness.namesConsistent
        ) {
          await ProfessionalVerificationService.getVerifiedReviewEvidence({
            profile: current,
            trusted,
            session,
          });
          verifiedReviewEvidence = true;
        }
      });
    } catch (error) {
      if (!EXPECTED_VERIFICATION_EVIDENCE_ERRORS.has(error?.code)) throw error;
      evidenceErrorCode = error.code;
    } finally {
      await session.endSession();
    }

    return {
      ...readiness,
      trustedNinEvidence,
      verifiedReviewEvidence,
      ninEvidence,
      evidenceErrorCode,
      readyForApproval: readiness.readyForApproval && verifiedReviewEvidence,
    };
  }

  // ───────────────────────── READY QUEUE EVALUATION ─────────────────────────

  /**
   * Pre-filter in MongoDB, then confirm NIN and licence audit evidence.
   * Use bounded batches rather than loading every candidate into memory.
   * The same verification drives paginated counts and dashboard totals.
   */
  static async getReadyForApprovalQueue({
    filter,
    skip = 0,
    limit = DEFAULT_PAGE_SIZE,
    collect = true,
  } = {}) {
    const profiles = [];
    let total = 0;
    let offset = 0;

    while (true) {
      const batch = await ProfessionalProfile.find(filter)
        .select(this.getQueueProjection())
        .sort({ updatedAt: -1, _id: -1 })
        .skip(offset)
        .limit(READINESS_BATCH_SIZE)
        .lean();

      if (batch.length === 0) break;
      offset += batch.length;

      const evaluated = await Promise.all(
        batch.map(async (profile) => ({
          profile,
          readiness: await this.getApprovalEligibility(profile),
        }))
      );

      for (const result of evaluated) {
        if (!result.readiness.readyForApproval) continue;
        if (collect && total >= skip && profiles.length < limit) {
          profiles.push(result);
        }
        total += 1;
      }

      if (batch.length < READINESS_BATCH_SIZE) break;
    }

    return { profiles, total };
  }

  // ───────────────────────── INDIVIDUAL ELIGIBILITY ─────────────────────────

  static async getApprovalEligibility(profile) {
    return this.getReviewEvidenceStatus(profile);
  }

  // ───────────────────────── DASHBOARD OPTIONS ─────────────────────────

  static async getDashboardPageOptions({ adminUserId } = {}) {
    await this.assertAdmin(adminUserId);

    const [total, awaitingReview, readyQueue, licenceReview, approved, rejected] =
      await Promise.all([
        ProfessionalProfile.countDocuments({}),
        ProfessionalProfile.countDocuments(this.buildQueueFilter({ status: "awaiting_review" })),
        this.getReadyForApprovalQueue({
          filter: this.buildQueueFilter({ status: "ready_for_approval" }),
          collect: false,
        }),
        ProfessionalProfile.countDocuments(this.buildQueueFilter({ status: "licence_review" })),
        ProfessionalProfile.countDocuments({ professionalApprovalStatus: "approved" }),
        ProfessionalProfile.countDocuments({ professionalApprovalStatus: "rejected" }),
      ]);

    return {
      title: "Professional Verifications",
      stats: {
        total,
        awaitingReview,
        readyForApproval: readyQueue.total,
        licenceReview,
        approved,
        rejected,
      },
      statusOptions: [...QUEUE_STATUSES],
      professionalTypeOptions: [...PROFESSIONAL_TYPES],
      licenceValidityTypeOptions: ["expiry_date", "licensing_year", "life"],
    };
  }

  // ───────────────────────── QUEUE RESPONSE ─────────────────────────

  static formatQueueProfile(profile, readiness) {
    return {
      professionalProfileId: String(profile._id),
      userId: String(profile.user),
      professionalType: profile.type,
      specialty: profile.specialty,
      state: profile.state,
      lga: profile.lga,
      licenceIssuingBody: profile.licenceIssuingBody,
      licenceVerificationStatus: profile.licenceVerificationStatus,
      licencePendingDocumentSubmittedAt: profile.licencePendingDocumentSubmittedAt || null,
      licenceValidityType: profile.licenceValidityType || null,
      licenceExpiryDate: profile.licenceExpiryDate || null,
      professionalApprovalStatus: profile.professionalApprovalStatus,
      accountStatus: profile.accountStatus,
      marketplaceStatus: profile.marketplaceStatus,
      licenceLastCheckedAt: profile.licenceLastCheckedAt,
      licenceVerifiedAt: profile.licenceVerifiedAt,
      verificationReadiness: readiness,
      updatedAt: profile.updatedAt,
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

    if (normalizedStatus === "ready_for_approval") {
      const { profiles, total } = await this.getReadyForApprovalQueue({
        filter,
        skip,
        limit: pageSize,
      });
      const data = profiles.map(({ profile, readiness }) =>
        this.formatQueueProfile(profile, readiness)
      );
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

    const [profiles, total] = await Promise.all([
      ProfessionalProfile.find(filter)
        .select(this.getQueueProjection())
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      ProfessionalProfile.countDocuments(filter),
    ]);

    // Do not calculate readiness without loading the actual NIN evidence.
    const data = await Promise.all(
      profiles.map(async (profile) => {
        const readiness = await this.getApprovalEligibility(profile);
        return this.formatQueueProfile(profile, readiness);
      })
    );

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
          "licenceValidityType",
          "licenceLicensingYear",
          "licenceExpiryDate",
          "licenceVerifiedAt",
          "licenceLastCheckedAt",
          "licenceVerifiedBy",
          "licenceVerificationNote",
          "licencePendingDocumentSubmittedAt",
          "upcomingLicence",
          "professionalApprovalStatus",
          "approvedForShiftsAt",
          "approvedForShiftsBy",
          "approvalNote",
          "rejectionReason",
          "accountStatus",
          "marketplaceStatus",
          "createdAt",
          "updatedAt",
          "+licenceDocumentUrl",
          "+licencePendingDocumentUrl",
          "+upcomingLicence.documentUrl",
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

    const [attempts, totalAttempts, readiness] = await Promise.all([
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
        .sort({ createdAt: -1, _id: -1 })
        .limit(MAX_RECENT_ATTEMPTS)
        .lean(),
      KYCVerification.countDocuments({
        professional: profile._id,
        ownerType: "professional",
      }),
      this.getApprovalEligibility(profile),
    ]);

    const upcoming = profile.upcomingLicence;

    return {
      success: true,
      data: {
        professionalProfileId: String(profile._id),
        userId: String(profile.user),
        professionalType: profile.type,
        specialty: profile.specialty,

        // Populated from the ONE production NIN lookup made during onboarding.
        // This is reference evidence for the licence reviewer, not a separate
        // NIN approval button or a claim of biometric holder authentication.
        ninEvidence: readiness.ninEvidence,

        licenceVerification: {
          licenceNumber: profile.licenceNumber,
          issuingBody: profile.licenceIssuingBody,
          status: profile.licenceVerificationStatus,
          method: profile.licenceVerificationMethod,
          source: profile.licenceVerificationSource,
          expectedSource: ProfessionalVerificationService.getExpectedLicenceSource(profile.type),
          sourceValid: readiness.licenceSourceValid,
          nameOnRecord: profile.licenceNameOnRecord,
          validityType: profile.licenceValidityType,
          licensingYear: profile.licenceLicensingYear,
          expiryDate: profile.licenceExpiryDate,
          expired: readiness.licenceExpired,
          withinGrace: readiness.licenceWithinGrace,
          graceEndsOn: readiness.licenceGraceEndsOn,
          verifiedAt: profile.licenceVerifiedAt,
          lastCheckedAt: profile.licenceLastCheckedAt,
          verifiedBy: profile.licenceVerifiedBy,
          note: profile.licenceVerificationNote,
          documentAvailable: Boolean(profile.licenceDocumentUrl),
          pendingDocumentAvailable: Boolean(profile.licencePendingDocumentUrl),
          pendingDocumentSubmittedAt: profile.licencePendingDocumentSubmittedAt,
          upcomingLicence: upcoming
            ? {
                reviewId: String(upcoming.reviewId),
                nameOnRecord: upcoming.nameOnRecord,
                validFrom: upcoming.validFrom,
                evidenceValidFrom: upcoming.evidenceValidFrom,
                validityType: upcoming.validityType,
                licensingYear: upcoming.licensingYear,
                expiryDate: upcoming.expiryDate,
                verifiedAt: upcoming.verifiedAt,
                lastCheckedAt: upcoming.lastCheckedAt,
                verifiedBy: upcoming.verifiedBy,
                reviewNote: upcoming.reviewNote,
                documentAvailable: Boolean(upcoming.documentUrl),
              }
            : null,
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
    }).select("+metadata +documentUrl");

    if (!attempt) {
      throw this.createError({
        message: "Verification attempt not found.",
        code: "ADMIN_PROFESSIONAL_ATTEMPT_NOT_FOUND",
        statusCode: 404,
      });
    }

    // Explicit allowlist: do not return raw provider payloads, document
    // storage paths, unmasked NIN/BVN values, or obsolete selfie indicators.
    const metadata =
      attempt.metadata && typeof attempt.metadata === "object" && !Array.isArray(attempt.metadata)
        ? attempt.metadata
        : {};

    const safeEvidence = {
      verificationSource:
        typeof metadata.verificationSource === "string"
          ? metadata.verificationSource.slice(0, 80)
          : null,
      registryFound: typeof metadata.registryFound === "boolean" ? metadata.registryFound : null,
      registryMatched:
        typeof metadata.registryMatched === "boolean" ? metadata.registryMatched : null,
      nameAcknowledged:
        typeof metadata.nameAcknowledged === "boolean" ? metadata.nameAcknowledged : null,
      holderAuthenticated:
        typeof metadata.holderAuthenticated === "boolean" ? metadata.holderAuthenticated : null,
      stagingOnly: typeof metadata.stagingOnly === "boolean" ? metadata.stagingOnly : null,
      documentReviewed: metadata.documentReviewed === true,
      currentAuthorisationReviewed: metadata.currentAuthorisationReviewed === true,
      ninLicenceNameMatched: metadata.ninLicenceNameMatched === true,
      councilReviewed: metadata.councilReviewed === true,
      councilSource:
        typeof metadata.councilSource === "string" ? metadata.councilSource.slice(0, 150) : null,
      licenceNumber:
        typeof metadata.licenceNumber === "string" ? metadata.licenceNumber.slice(0, 100) : null,
      professionalType:
        typeof metadata.professionalType === "string"
          ? metadata.professionalType.slice(0, 50)
          : null,
      validityType:
        typeof metadata.validityType === "string" ? metadata.validityType.slice(0, 30) : null,
      licensingYear: Number.isInteger(metadata.licensingYear) ? metadata.licensingYear : null,
      expiryDate: typeof metadata.expiryDate === "string" ? metadata.expiryDate.slice(0, 10) : null,
      validFromDate:
        typeof metadata.validFromDate === "string" ? metadata.validFromDate.slice(0, 10) : null,
      futureApproved: metadata.futureApproved === true,
      renewal: metadata.renewal === true,
      licenceNumberChanged: metadata.licenceNumberChanged === true,
      documentAvailable: Boolean(attempt.documentUrl),
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

  // ───────────────────────── PRACTISING LICENCE REVIEW ─────────────────────────

  static async reviewLicence({
    adminUserId,
    professionalProfileId,
    decision,
    nameOnRecord,
    note,
    validityType = null,
    expiryDate = null,
    licensingYear = null,
    councilReviewed = false,
    councilSource = null,
  } = {}) {
    await this.assertAdmin(adminUserId);

    // HTML form submissions may encode booleans as strings. Reject other
    // values rather than incorrectly recording a council check as completed.
    const councilCheck =
      councilReviewed === true || councilReviewed === "true"
        ? true
        : councilReviewed === false ||
            councilReviewed === "false" ||
            councilReviewed === "" ||
            councilReviewed == null
          ? false
          : null;

    return ProfessionalVerificationService.recordLicenceReview({
      adminUserId,
      professionalProfileId,
      decision,
      nameOnRecord,
      note,
      validityType,
      expiryDate: expiryDate === "" ? null : expiryDate,
      licensingYear: licensingYear === "" ? null : licensingYear,
      councilReviewed: councilCheck,
      councilSource: councilSource === "" ? null : councilSource,
    });
  }

  // ───────────────────────── FINAL PROFESSIONAL APPROVAL ─────────────────────────

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
