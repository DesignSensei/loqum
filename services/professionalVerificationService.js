// services/professionalVerificationService.js

const mongoose = require("mongoose");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const KYCVerification = require("../models/KYCVerification");
const User = require("../models/User");
const UploadStorageService = require("./storage/uploadStorageService");
const { createServiceError } = require("./helpers/serviceErrorHelper");

const ERROR_NAME = "ProfessionalVerificationServiceError";

const PROFESSIONAL_TYPES = new Set([
  "pharmacist",
  "pharmacy_technician",
  "nurse",
  "doctor",
  "lab_scientist",
  "radiographer",
  "physiotherapist",
]);

const LICENCE_VALIDITY_TYPES = new Set(["expiry_date", "licensing_year", "life"]);

const RENEWAL_GRACE_DAYS = 30;

const EXPECTED_STATUS_EVIDENCE_ERRORS = new Set([
  "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_REQUIRED",
  "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_MISMATCH",
  "PROFESSIONAL_VERIFICATION_CONFLICTING_REVIEWS",
  "PROFESSIONAL_VERIFICATION_UPCOMING_INCONSISTENT",
  "PROFESSIONAL_VERIFICATION_UPCOMING_EVIDENCE_MISMATCH",
]);

// Store date-only values at UTC midnight.
// Compare calendar dates in Nigeria's time zone.
function parseISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

function storedISODate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return null;
  }

  return value.toISOString().slice(0, 10);
}

function todayInNigeria() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(isoDate, count) {
  const date = parseISODate(isoDate);

  if (!date || !Number.isInteger(count)) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + count);

  return date.toISOString().slice(0, 10);
}

class ProfessionalVerificationService {
  // ───────────────────────── ERRORS ─────────────────────────

  static createError({ message, code, statusCode = 400, details = null }) {
    return createServiceError({
      name: ERROR_NAME,
      message,
      code,
      statusCode,
      details,
    });
  }

  static assertObjectId(value, label) {
    if (!mongoose.isValidObjectId(value)) {
      throw this.createError({
        message: `Invalid ${label}.`,
        code: "PROFESSIONAL_VERIFICATION_INVALID_ID",
      });
    }
  }

  // ───────────────────────── NAME COMPARISON ─────────────────────────

  static normalizeName(value) {
    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/[^A-Z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static normalizedLegalNameTokens(value) {
    if (typeof value !== "string") {
      return [];
    }

    const normalized = value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();

    return normalized ? normalized.split(/\s+/).sort() : [];
  }

  static legalNamesMatch(registryName, licenceName) {
    const left = this.normalizedLegalNameTokens(registryName);
    const right = this.normalizedLegalNameTokens(licenceName);

    return (
      left.length >= 2 &&
      left.length === right.length &&
      left.every((part, index) => part === right[index])
    );
  }

  // ───────────────────────── LICENCE SOURCE ─────────────────────────

  static getExpectedLicenceSource(type) {
    if (!PROFESSIONAL_TYPES.has(type)) {
      throw this.createError({
        message: "Unsupported professional type for licence verification.",
        code: "PROFESSIONAL_VERIFICATION_UNSUPPORTED_PROFESSIONAL_TYPE",
        statusCode: 409,
      });
    }

    // The document is uploaded after onboarding and reviewed by admin.
    // Optional council checks are supplementary evidence.
    return "uploaded_document";
  }

  // ───────────────────────── LICENCE VALIDITY ─────────────────────────

  static resolveLicenceValidity({
    professionalType,
    validityType,
    expiryDate = null,
    licensingYear = null,
    previousLicenceExpiryDate = null,
    isRenewal = false,
  } = {}) {
    this.getExpectedLicenceSource(professionalType);

    if (!LICENCE_VALIDITY_TYPES.has(validityType)) {
      throw this.createError({
        message: "Choose Expiry Date, Licensing Year, or Life Licence.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_VALIDITY_TYPE",
      });
    }

    if (validityType === "life") {
      if (expiryDate != null || licensingYear != null) {
        throw this.createError({
          message: "Life licences do not take an expiry date or licensing year.",
          code: "PROFESSIONAL_VERIFICATION_CONFLICTING_VALIDITY",
        });
      }

      return {
        validityType: "life",
        licensingYear: null,
        expiryDate: null,
        expiryISODate: null,
        validFromISODate: todayInNigeria(),
        graceEndsOn: null,
      };
    }

    const today = todayInNigeria();

    let expiryISODate;
    let validFromISODate = today;
    let acceptedYear = null;

    if (validityType === "expiry_date") {
      if (licensingYear != null) {
        throw this.createError({
          message: "Choose either an expiry date or a licensing year.",
          code: "PROFESSIONAL_VERIFICATION_CONFLICTING_VALIDITY",
        });
      }

      if (!parseISODate(expiryDate)) {
        throw this.createError({
          message: "Select a valid expiry date.",
          code: "PROFESSIONAL_VERIFICATION_INVALID_EXPIRY_DATE",
        });
      }

      expiryISODate = expiryDate;
    } else {
      if (expiryDate != null) {
        throw this.createError({
          message: "Choose either a licensing year or an expiry date.",
          code: "PROFESSIONAL_VERIFICATION_CONFLICTING_VALIDITY",
        });
      }

      if (!/^(?:19|20|21)\d{2}$/.test(String(licensingYear ?? ""))) {
        throw this.createError({
          message: "Enter a valid four-digit licensing year.",
          code: "PROFESSIONAL_VERIFICATION_INVALID_LICENSING_YEAR",
        });
      }

      acceptedYear = Number(licensingYear);

      const currentYear = Number(today.slice(0, 4));

      if (acceptedYear > currentYear + 1) {
        throw this.createError({
          message: "The selected licensing year is too far in the future.",
          code: "PROFESSIONAL_VERIFICATION_INVALID_LICENSING_YEAR",
        });
      }

      // A licensing-year credential ends on 31 December of that year.
      expiryISODate = `${acceptedYear}-12-31`;
      validFromISODate = `${acceptedYear}-01-01`;

      if (acceptedYear === currentYear + 1 && !isRenewal) {
        throw this.createError({
          message: "A future-year licence requires a previously approved licence.",
          code: "PROFESSIONAL_VERIFICATION_FUTURE_YEAR_RENEWAL_REQUIRED",
          statusCode: 409,
        });
      }
    }

    if (expiryISODate < today) {
      throw this.createError({
        message: "An expired credential cannot be newly approved as current.",
        code: "PROFESSIONAL_VERIFICATION_LICENCE_EXPIRED",
        statusCode: 409,
      });
    }

    return {
      validityType,
      licensingYear: acceptedYear,
      expiryDate: parseISODate(expiryISODate),
      expiryISODate,
      validFromISODate,
      graceEndsOn: addDays(expiryISODate, RENEWAL_GRACE_DAYS),
    };
  }

  // ───────────────────────── RENEWAL TRANSITION ─────────────────────────

  // An approved replacement activates after the previous licence expires,
  // or on its own later effective date.
  static getRenewalTransitionDate({ profile, validity } = {}) {
    const newStart = validity?.validFromISODate;

    if (!parseISODate(newStart)) {
      throw this.createError({
        message: "The reviewed licence has no valid commencement date.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_VALIDITY_START",
        statusCode: 409,
      });
    }

    const oldExpiry = storedISODate(profile?.licenceExpiryDate);
    const oldIsLife = profile?.licenceValidityType === "life";
    const newExpiry = validity?.expiryISODate;

    if (oldIsLife && validity.validityType !== "life") {
      throw this.createError({
        message:
          "Replacing a life licence with a time-limited licence requires administrative investigation.",
        code: "PROFESSIONAL_VERIFICATION_LIFE_LICENCE_REPLACEMENT",
        statusCode: 409,
      });
    }

    const startsAfterOld = oldExpiry ? addDays(oldExpiry, 1) : null;

    const transitionOn = startsAfterOld && startsAfterOld > newStart ? startsAfterOld : newStart;

    if (newExpiry && transitionOn > newExpiry) {
      throw this.createError({
        message: "The replacement licence expires before it could become effective.",
        code: "PROFESSIONAL_VERIFICATION_RENEWAL_NOT_EXTENDED",
        statusCode: 409,
      });
    }

    return transitionOn;
  }

  // ───────────────────────── FUTURE LICENCE ─────────────────────────

  static getUpcomingLicenceSummary(profile) {
    const upcoming = profile?.upcomingLicence;

    if (!upcoming || profile?.licenceVerificationStatus !== "verified") {
      return null;
    }

    const startsOn = storedISODate(upcoming.validFrom);
    const evidenceStartsOn = storedISODate(upcoming.evidenceValidFrom);
    const expiryISODate = storedISODate(upcoming.expiryDate);

    const validReviewTimes =
      upcoming.verifiedAt instanceof Date &&
      Number.isFinite(upcoming.verifiedAt.getTime()) &&
      upcoming.lastCheckedAt instanceof Date &&
      Number.isFinite(upcoming.lastCheckedAt.getTime()) &&
      upcoming.verifiedAt <= upcoming.lastCheckedAt;

    const validMode =
      upcoming.validityType === "life"
        ? upcoming.expiryDate == null && upcoming.licensingYear == null
        : upcoming.validityType === "expiry_date"
          ? expiryISODate !== null && upcoming.licensingYear == null
          : upcoming.validityType === "licensing_year" &&
            Number.isInteger(upcoming.licensingYear) &&
            expiryISODate === `${upcoming.licensingYear}-12-31`;

    if (
      !startsOn ||
      !evidenceStartsOn ||
      startsOn < evidenceStartsOn ||
      (expiryISODate && startsOn > expiryISODate) ||
      !mongoose.isValidObjectId(upcoming.reviewId) ||
      !upcoming.verifiedBy ||
      String(upcoming.verifiedBy) === String(profile.user) ||
      !validReviewTimes ||
      !validMode ||
      this.normalizedLegalNameTokens(upcoming.nameOnRecord).length < 2
    ) {
      return null;
    }

    return {
      upcoming,
      startsOn,
      evidenceStartsOn,
      expiryISODate,
    };
  }

  static getLicenceValidityState(profile) {
    if (!profile || profile.licenceVerificationStatus !== "verified") {
      return {
        current: false,
        expired: false,
        withinGrace: false,
        expiryISODate: null,
        graceEndsOn: null,
        usingUpcoming: false,
        upcomingStartsOn: null,
      };
    }

    const today = todayInNigeria();
    const future = this.getUpcomingLicenceSummary(profile);

    const usingUpcoming = Boolean(future && future.startsOn <= today);

    const upcomingStartsOn = future?.startsOn || null;

    const licence = usingUpcoming
      ? future.upcoming
      : {
          validityType: profile.licenceValidityType,
          licensingYear: profile.licenceLicensingYear,
          expiryDate: profile.licenceExpiryDate,
        };

    if (licence.validityType === "life") {
      return {
        current: true,
        expired: false,
        withinGrace: false,
        expiryISODate: null,
        graceEndsOn: null,
        usingUpcoming,
        upcomingStartsOn,
      };
    }

    const expiryISODate = storedISODate(licence.expiryDate);

    const validYear =
      licence.validityType !== "licensing_year" ||
      (Number.isInteger(licence.licensingYear) &&
        expiryISODate === `${licence.licensingYear}-12-31`);

    if (
      !expiryISODate ||
      !validYear ||
      !["expiry_date", "licensing_year"].includes(licence.validityType)
    ) {
      return {
        current: false,
        expired: false,
        withinGrace: false,
        expiryISODate: null,
        graceEndsOn: null,
        usingUpcoming: false,
        upcomingStartsOn,
      };
    }

    const graceEndsOn = addDays(expiryISODate, RENEWAL_GRACE_DAYS);

    return {
      current: today <= expiryISODate,
      expired: today > expiryISODate,
      withinGrace: today > expiryISODate && today <= graceEndsOn,
      expiryISODate,
      graceEndsOn,
      usingUpcoming,
      upcomingStartsOn,
    };
  }

  // ───────────────────────── RENEWAL PROMOTION ─────────────────────────

  static async promoteUpcomingLicenceInSession({ profile, session }) {
    if (!session?.inTransaction()) {
      throw new Error("Licence promotion requires an active transaction.");
    }

    if (profile.accountStatus === "closed") return false;

    const upcoming = profile.upcomingLicence;

    if (!upcoming) {
      return false;
    }

    const startsOn = storedISODate(upcoming.validFrom);

    if (!startsOn || startsOn > todayInNigeria()) {
      return false;
    }

    // Reuse stored onboarding evidence; do not repeat the provider lookup.
    const trusted = await this.getTrustedOnboardingNIN({
      profile,
      session,
    });

    const summary = this.getUpcomingLicenceSummary(profile);

    if (
      !summary ||
      startsOn !== summary.startsOn ||
      startsOn !==
        this.getRenewalTransitionDate({
          profile,
          validity: {
            validityType: upcoming.validityType,
            validFromISODate: summary.evidenceStartsOn,
            expiryISODate: summary.expiryISODate,
          },
        })
    ) {
      throw this.createError({
        message: "Upcoming licence evidence requires administrative reconciliation.",
        code: "PROFESSIONAL_VERIFICATION_UPCOMING_INCONSISTENT",
        statusCode: 409,
      });
    }

    const record = await KYCVerification.findOne({
      _id: upcoming.reviewId,
      professional: profile._id,
      user: profile.user,
      ownerType: "professional",
      type: "licence",
      provider: "manual",
      status: "verified",
      isActive: false,
    })
      .select("+documentUrl +metadata")
      .session(session);

    const metadata = record?.metadata || {};

    if (
      !record ||
      record.documentUrl !== upcoming.documentUrl ||
      String(record.reviewedBy) !== String(upcoming.verifiedBy) ||
      new Date(record.verifiedAt).getTime() !== upcoming.verifiedAt.getTime() ||
      new Date(record.lastCheckedAt).getTime() !== upcoming.lastCheckedAt.getTime() ||
      metadata.verificationSource !== "uploaded_document" ||
      metadata.documentReviewed !== true ||
      metadata.currentAuthorisationReviewed !== true ||
      metadata.ninLicenceNameMatched !== true ||
      typeof metadata.councilReviewed !== "boolean" ||
      metadata.validityType !== upcoming.validityType ||
      (metadata.licensingYear ?? null) !== (upcoming.licensingYear ?? null) ||
      (metadata.expiryDate ?? null) !== summary.expiryISODate ||
      metadata.validFromDate !== startsOn ||
      metadata.documentRef !== upcoming.documentUrl ||
      metadata.professionalType !== profile.type ||
      metadata.licenceNumber !== profile.licenceNumber ||
      String(metadata.ninEvidenceId || "") !== String(trusted.evidence._id) ||
      !this.legalNamesMatch(record.nameOnRecord, upcoming.nameOnRecord) ||
      !this.legalNamesMatch(upcoming.nameOnRecord, trusted.legalName)
    ) {
      throw this.createError({
        message: "Upcoming licence review evidence no longer matches the profile.",
        code: "PROFESSIONAL_VERIFICATION_UPCOMING_EVIDENCE_MISMATCH",
        statusCode: 409,
      });
    }

    await KYCVerification.updateMany(
      {
        professional: profile._id,
        user: profile.user,
        ownerType: "professional",
        type: "licence",
        isActive: true,
      },
      {
        $set: {
          isActive: false,
        },
      },
      { session }
    );

    const activation = await KYCVerification.updateOne(
      {
        _id: record._id,
        isActive: false,
      },
      {
        $set: {
          isActive: true,
        },
      },
      { session }
    );

    if (activation.modifiedCount !== 1) {
      throw this.createError({
        message: "Upcoming licence was changed during activation.",
        code: "PROFESSIONAL_VERIFICATION_STALE",
        statusCode: 409,
      });
    }

    profile.set({
      licenceDocumentUrl: upcoming.documentUrl,
      licenceVerificationStatus: "verified",
      licenceVerificationMethod: "manual",
      licenceVerificationSource: "uploaded_document",
      licenceNameOnRecord: upcoming.nameOnRecord,
      licenceValidityType: upcoming.validityType,
      licenceLicensingYear: upcoming.licensingYear,
      licenceExpiryDate: upcoming.expiryDate,
      licenceVerifiedAt: upcoming.verifiedAt,
      licenceLastCheckedAt: upcoming.lastCheckedAt,
      licenceVerifiedBy: upcoming.verifiedBy,
      licenceVerificationNote: upcoming.reviewNote,
      upcomingLicence: null,
    });

    return true;
  }

  static async promoteUpcomingLicenceIfDue({ professionalProfileId } = {}) {
    this.assertObjectId(professionalProfileId, "professional profile ID");

    const session = await mongoose.startSession();

    try {
      let promoted = false;

      await session.withTransaction(async () => {
        const profile = await ProfessionalProfile.findById(professionalProfileId)
          .select("+licenceDocumentUrl +upcomingLicence.documentUrl")
          .session(session);

        if (!profile) {
          throw this.createError({
            message: "Professional profile not found.",
            code: "PROFESSIONAL_VERIFICATION_PROFILE_NOT_FOUND",
            statusCode: 404,
          });
        }

        promoted = await this.promoteUpcomingLicenceInSession({
          profile,
          session,
        });

        if (promoted) {
          await profile.save({ session });
        }
      });

      return { promoted };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────────── INPUT HELPERS ─────────────────────────

  static truncate(value, maximum = 500) {
    return String(value || "")
      .trim()
      .slice(0, maximum);
  }

  static normalizeLicenceNumber(value) {
    const number = String(value || "")
      .normalize("NFKC")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");

    if (!number || number.length > 100 || /[\u0000-\u001f\u007f]/.test(number)) {
      throw this.createError({
        message: "A valid professional licence number is required.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_LICENCE_NUMBER",
      });
    }

    return number;
  }

  // ───────────────────────── TRUSTED LICENCE UPLOAD ─────────────────────────

  /**
   * The multipart upload middleware supplies a private file reference. A
   * professional cannot submit a URL or storage key through the request body.
   * The service independently checks the expected profile-specific namespace
   * and file metadata; this is not a substitute for the middleware's binary
   * validation or malware scanning.
   */
  static validateProfessionalLicenceUpload({ professionalProfileId, upload } = {}) {
    this.assertObjectId(professionalProfileId, "professional profile ID");

    const reference = upload?.fileUrl;
    const match =
      typeof reference === "string"
        ? /^private:\/\/professional_licence\/([a-f0-9]{24})\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(pdf|jpg|jpeg|png|webp)$/i.exec(
            reference
          )
        : null;

    const mimeTypes = {
      pdf: "application/pdf",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    };

    if (
      !match ||
      match[1].toLowerCase() !== String(professionalProfileId).toLowerCase() ||
      upload.mimeType !== mimeTypes[match[3].toLowerCase()] ||
      !Number.isSafeInteger(upload.fileSizeBytes) ||
      upload.fileSizeBytes <= 0 ||
      upload.fileSizeBytes > 10 * 1024 * 1024 ||
      typeof upload.fileName !== "string" ||
      upload.fileName.trim().length === 0 ||
      upload.fileName.length > 255
    ) {
      throw this.createError({
        message: "The practising-licence upload is invalid or belongs to another profile.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_LICENCE_UPLOAD",
        statusCode: 400,
      });
    }

    return { reference, extension: match[3].toLowerCase() };
  }

  /**
   * Submit/resubmit a practising licence after onboarding. Persist only the
   * untrusted PENDING document reference. The current approved licence and
   * its KYC evidence stay active throughout renewal review. A previous
   * unverified review may be superseded but is never erased from the audit.
   *
   * Called by the professional controller after parseProfessionalLicenceUpload:
   *   submitLicenceDocument({ professionalProfileId, userId,
   *     licenceUpload: req.professionalLicenceUpload })
   *
   * The controller MUST call req.commitProfessionalLicenceUpload() immediately
   * after this operation succeeds, before sending an HTTP response. On failure
   * it must call req.cleanupProfessionalLicenceUpload() to remove the NEW
   * uncommitted object. The service does not delete that new object itself.
   */
  static async submitLicenceDocument({ professionalProfileId, userId, licenceUpload } = {}) {
    this.assertObjectId(professionalProfileId, "professional profile ID");
    this.assertObjectId(userId, "user ID");

    const { reference } = this.validateProfessionalLicenceUpload({
      professionalProfileId,
      upload: licenceUpload,
    });

    const snapshot = await this.getOwnedProfessional(professionalProfileId, userId);
    const session = await mongoose.startSession();
    let response;
    let supersededDocument = null;

    try {
      await session.withTransaction(async () => {
        const current = await ProfessionalProfile.findOne({
          _id: snapshot._id,
          user: userId,
          accountStatus: { $ne: "closed" },
          __v: snapshot.__v,
        })
          .select("+licenceDocumentUrl +licencePendingDocumentUrl +upcomingLicence.documentUrl")
          .session(session);

        if (!current) {
          throw this.createError({
            message: "The professional profile was updated during the upload. Please retry.",
            code: "PROFESSIONAL_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        this.getExpectedLicenceSource(current.type);
        this.normalizeLicenceNumber(current.licenceNumber);

        // An approved future renewal may have become effective since the
        // upload began. Promote first within this same transaction.
        if (await this.promoteUpcomingLicenceInSession({ profile: current, session })) {
          await current.save({ session });
        }

        if (current.upcomingLicence) {
          throw this.createError({
            message:
              "An approved future licence is already scheduled. Contact support before replacing it.",
            code: "PROFESSIONAL_VERIFICATION_UPCOMING_ALREADY_APPROVED",
            statusCode: 409,
          });
        }

        const trusted = await this.getTrustedOnboardingNIN({
          profile: current,
          session,
        });

        const existingLicenceVerified = current.licenceVerificationStatus === "verified";

        if (existingLicenceVerified) {
          // A verified profile must be backed by exactly one ACTIVE, matching
          // reviewed licence. Do not use an upload to hide an inconsistent
          // credential state or bypass the original admin decision.
          await this.getVerifiedReviewEvidence({
            profile: current,
            trusted,
            session,
          });
        } else {
          if (current.professionalApprovalStatus === "approved") {
            throw this.createError({
              message: "Professional approval and licence verification are inconsistent.",
              code: "PROFESSIONAL_VERIFICATION_APPROVAL_INCONSISTENT",
              statusCode: 409,
            });
          }

          // Supersede any active pending/needs-review audit. Historical
          // entries remain in KYCVerification and retain their documents.
          const activeRecords = await KYCVerification.find({
            professional: current._id,
            user: current.user,
            ownerType: "professional",
            type: "licence",
            isActive: true,
          }).session(session);

          if (activeRecords.some((record) => record.status === "verified")) {
            throw this.createError({
              message:
                "An active verified licence conflicts with the profile. Admin reconciliation is required.",
              code: "PROFESSIONAL_VERIFICATION_CONFLICTING_REVIEWS",
              statusCode: 409,
            });
          }

          await KYCVerification.updateMany(
            {
              professional: current._id,
              user: current.user,
              ownerType: "professional",
              type: "licence",
              isActive: true,
            },
            { $set: { isActive: false } },
            { session }
          );
        }

        const previousPending = current.licencePendingDocumentUrl || null;
        if (previousPending === reference) {
          throw this.createError({
            message: "This practising-licence document is already pending review.",
            code: "PROFESSIONAL_VERIFICATION_DUPLICATE_UPLOAD",
            statusCode: 409,
          });
        }

        const submittedAt = new Date();
        const isRenewal = existingLicenceVerified;

        // Record upload provenance separately from the admin's later review.
        // A verified renewal's existing active review MUST remain active.
        const [submission] = await KYCVerification.create(
          [
            {
              user: current.user,
              professional: current._id,
              ownerType: "professional",
              type: "licence",
              provider: "internal_review",
              providerEnvironment: null,
              status: "pending",
              documentType: "licence_certificate",
              documentUrl: reference,
              submittedAt,
              reviewNote: "Practising licence submitted; awaiting independent admin review.",
              metadata: {
                verificationSource: "uploaded_document",
                documentRef: reference,
                ninEvidenceId: String(trusted.evidence._id),
                licenceNumber: current.licenceNumber,
                professionalType: current.type,
                renewal: isRenewal,
                documentReviewed: false,
              },
              isActive: !isRenewal,
            },
          ],
          { session }
        );

        current.set({
          licencePendingDocumentUrl: reference,
          licencePendingDocumentSubmittedAt: submittedAt,
        });

        if (!isRenewal) {
          current.set({
            licenceVerificationStatus: "pending",
            licenceVerificationMethod: "not_checked",
            licenceVerificationSource: "not_checked",
            licenceNameOnRecord: null,
            licenceDocumentUrl: null,
            licenceValidityType: null,
            licenceLicensingYear: null,
            licenceExpiryDate: null,
            licenceVerifiedAt: null,
            licenceLastCheckedAt: null,
            licenceVerifiedBy: null,
            licenceVerificationNote: null,
            ...this.getApprovalResetUpdates(),
          });
        }

        const updated = await current.save({ session });
        supersededDocument = previousPending;

        response = {
          submitted: true,
          professionalProfileId: String(updated._id),
          submissionId: String(submission._id),
          submittedAt,
          pendingLicenceReview: true,
          currentLicenceVerificationStatus: updated.licenceVerificationStatus,
          currentProfessionalApprovalStatus: updated.professionalApprovalStatus,
          existingApprovedLicencePreserved: isRenewal,
          requiresIndependentAdminReview: true,
          requiresFinalProfessionalApproval: updated.professionalApprovalStatus !== "approved",
        };
      });
    } finally {
      await session.endSession();
    }

    // Clean a superseded PRIVATE object only if no profile/review still
    // references it. Reviewed or submitted audit evidence must be retained.
    // Cleanup failures must not turn a COMMITTED upload into an HTTP failure:
    // the controller must still commit the middleware's new file reference.
    if (supersededDocument && supersededDocument !== reference) {
      try {
        const [stillOnProfile, referencedInAudit] = await Promise.all([
          ProfessionalProfile.exists({
            _id: professionalProfileId,
            $or: [
              { licencePendingDocumentUrl: supersededDocument },
              { licenceDocumentUrl: supersededDocument },
              { "upcomingLicence.documentUrl": supersededDocument },
            ],
          }),
          KYCVerification.exists({
            professional: professionalProfileId,
            ownerType: "professional",
            type: "licence",
            documentUrl: supersededDocument,
          }),
        ]);

        if (!stillOnProfile && !referencedInAudit) {
          await UploadStorageService.deletePrivateFile({
            storageKey: supersededDocument,
          });
        }
      } catch (_cleanupError) {
        // Safe to return success: the committed submission is valid. A
        // storage-reconciliation task should retry obsolete-file cleanup.
      }
    }

    return response;
  }

  // ───────────────────────── PROFILE LOOKUP ─────────────────────────

  static async getProfessional(professionalProfileId) {
    this.assertObjectId(professionalProfileId, "professional profile ID");

    const profile = await ProfessionalProfile.findById(professionalProfileId).select(
      "+licenceDocumentUrl +licencePendingDocumentUrl +upcomingLicence.documentUrl"
    );

    if (!profile) {
      throw this.createError({
        message: "Professional profile not found.",
        code: "PROFESSIONAL_VERIFICATION_PROFILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    return profile;
  }

  static async getOwnedProfessional(professionalProfileId, userId) {
    this.assertObjectId(professionalProfileId, "professional profile ID");

    this.assertObjectId(userId, "user ID");

    const profile = await ProfessionalProfile.findOne({
      _id: professionalProfileId,
      user: userId,
      accountStatus: { $ne: "closed" },
    });

    if (!profile) {
      throw this.createError({
        message: "Professional profile not found or access denied.",
        code: "PROFESSIONAL_VERIFICATION_ACCESS_DENIED",
        statusCode: 403,
      });
    }

    return profile;
  }

  // ───────────────────────── ADMIN AUTHORISATION ─────────────────────────

  static async assertAdmin(adminUserId, session = null) {
    this.assertObjectId(adminUserId, "admin user ID");

    const query = User.findOne({
      _id: adminUserId,
      role: "admin",
      accountStatus: "active",
    }).select("_id role accountStatus");

    if (session) {
      query.session(session);
    }

    const admin = await query;

    if (!admin) {
      throw this.createError({
        message: "An active administrator is required.",
        code: "PROFESSIONAL_VERIFICATION_ADMIN_REQUIRED",
        statusCode: 403,
      });
    }

    return admin;
  }

  // ───────────────────────── ACCOUNT IDENTITY ─────────────────────────

  static async getAccountIdentity(profile) {
    const user = await User.findById(profile.user).select(
      "role accountStatus isVerified isOnboarded firstName lastName email dateOfBirth"
    );

    if (
      !user ||
      user.role !== "professional" ||
      user.accountStatus !== "active" ||
      user.isVerified !== true ||
      user.isOnboarded !== true
    ) {
      throw this.createError({
        message: "Your account is not eligible for identity verification.",
        code: "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
        statusCode: 403,
      });
    }

    const firstName = String(user.firstName || "").trim();
    const lastName = String(user.lastName || "").trim();

    if (!this.normalizeName(firstName) || !this.normalizeName(lastName)) {
      throw this.createError({
        message: "Your account needs a valid first and last name.",
        code: "PROFESSIONAL_VERIFICATION_ACCOUNT_NAME_REQUIRED",
        statusCode: 409,
      });
    }

    const dob = user.dateOfBirth ? new Date(user.dateOfBirth) : null;

    return {
      firstName,
      lastName,
      email: String(user.email || "").trim(),
      dateOfBirth:
        dob && Number.isFinite(dob.getTime()) ? dob.toISOString().slice(0, 10) : undefined,
    };
  }

  // ───────────────────────── TRUSTED ONBOARDING NIN ─────────────────────────

  static async getTrustedOnboardingNIN({ profile, session }) {
    if (!session?.inTransaction()) {
      throw new Error("An active transaction is required to read NIN evidence.");
    }

    const user = await User.findOne({
      _id: profile.user,
      role: "professional",
      accountStatus: "active",
      isVerified: true,
      isOnboarded: true,
      legalNameSource: "nin_registry",
    })
      .select("firstName middleName lastName legalNameSource +legalNameEvidence")
      .session(session);

    if (!user || !mongoose.isValidObjectId(user.legalNameEvidence)) {
      throw this.createError({
        message: "Authoritative production NIN onboarding evidence is required.",
        code: "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_REQUIRED",
        statusCode: 409,
      });
    }

    const evidence = await KYCVerification.findOne({
      _id: user.legalNameEvidence,
      professional: profile._id,
      user: user._id,
      ownerType: "professional",
      type: "nin",
      provider: {
        $in: ["ninja", "dojah"],
      },
      providerEnvironment: "production",
      status: "needs_review",
    })
      .select("+metadata +requestReference +registryLegalName")
      .session(session);

    const meta = evidence?.metadata;
    const components = evidence?.registryLegalName;

    const legalName = [components?.firstName, components?.middleName, components?.lastName]
      .filter(Boolean)
      .join(" ");

    if (
      !evidence ||
      meta?.verificationSource !== "pre_onboarding" ||
      !mongoose.isValidObjectId(meta?.preOnboardingVerificationId) ||
      meta.registryFound !== true ||
      meta.registryMatched !== true ||
      meta.legalNameSource !== "nin_registry" ||
      meta.nameAcknowledged !== true ||
      meta.stagingOnly !== false ||
      meta.holderAuthenticated !== false ||
      typeof evidence.requestReference !== "string" ||
      !evidence.requestReference.trim() ||
      meta.nameAcknowledgedRequestReference !== evidence.requestReference ||
      !components?.firstName ||
      !components?.lastName ||
      evidence.nameOnRecord !== legalName ||
      this.normalizeName(user.firstName) !== this.normalizeName(components.firstName) ||
      this.normalizeName(user.middleName) !== this.normalizeName(components.middleName) ||
      this.normalizeName(user.lastName) !== this.normalizeName(components.lastName)
    ) {
      throw this.createError({
        message: "NIN legal-name evidence is incomplete or inconsistent.",
        code: "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_MISMATCH",
        statusCode: 409,
      });
    }

    return {
      user,
      evidence,
      legalName,
    };
  }

  // ───────────────────────── VERIFIED LICENCE EVIDENCE ─────────────────────────

  static async getVerifiedReviewEvidence({ profile, trusted, session }) {
    if (!session?.inTransaction()) {
      throw new Error("An active transaction is required to verify licence evidence.");
    }

    if (!trusted?.evidence?._id || !trusted.legalName) {
      throw this.createError({
        message: "Stored production NIN evidence is required.",
        code: "PROFESSIONAL_VERIFICATION_NIN_EVIDENCE_REQUIRED",
        statusCode: 409,
      });
    }

    const source = this.getExpectedLicenceSource(profile.type);

    const reviews = await KYCVerification.find({
      professional: profile._id,
      user: profile.user,
      ownerType: "professional",
      type: "licence",
      provider: "manual",
      status: "verified",
      isActive: true,
    })
      .select("+metadata +documentUrl")
      .session(session);

    if (reviews.length !== 1) {
      throw this.createError({
        message: "Exactly one active verified practising-licence review is required.",
        code: "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_REQUIRED",
        statusCode: 409,
      });
    }

    const [licence] = reviews;
    const meta = licence.metadata || {};

    const documentProfile = await ProfessionalProfile.findById(profile._id)
      .select("+licenceDocumentUrl")
      .session(session);

    const documentRef = documentProfile?.licenceDocumentUrl;

    const validReviewTiming = () => {
      const verified = licence.verifiedAt instanceof Date ? licence.verifiedAt.getTime() : NaN;

      const checked = licence.lastCheckedAt instanceof Date ? licence.lastCheckedAt.getTime() : NaN;

      const profileVerified =
        profile.licenceVerifiedAt instanceof Date ? profile.licenceVerifiedAt.getTime() : NaN;

      const profileChecked =
        profile.licenceLastCheckedAt instanceof Date ? profile.licenceLastCheckedAt.getTime() : NaN;

      return (
        Number.isFinite(verified) &&
        Number.isFinite(checked) &&
        verified <= checked &&
        verified === profileVerified &&
        checked === profileChecked &&
        String(licence.reviewedBy || "") === String(profile.licenceVerifiedBy || "") &&
        String(licence.reviewedBy || "") !== String(profile.user)
      );
    };

    const expiryISO = storedISODate(profile.licenceExpiryDate);

    const validityMatches =
      meta.validityType === profile.licenceValidityType &&
      (profile.licenceValidityType === "life"
        ? profile.licenceExpiryDate == null &&
          profile.licenceLicensingYear == null &&
          meta.expiryDate == null &&
          meta.licensingYear == null
        : expiryISO !== null &&
          meta.expiryDate === expiryISO &&
          (profile.licenceValidityType === "expiry_date"
            ? profile.licenceLicensingYear == null && meta.licensingYear == null
            : profile.licenceValidityType === "licensing_year" &&
              Number.isInteger(profile.licenceLicensingYear) &&
              meta.licensingYear === profile.licenceLicensingYear &&
              expiryISO === `${profile.licenceLicensingYear}-12-31`));

    if (
      meta.verificationSource !== source ||
      meta.documentReviewed !== true ||
      meta.currentAuthorisationReviewed !== true ||
      typeof meta.councilReviewed !== "boolean" ||
      meta.ninLicenceNameMatched !== true ||
      String(meta.ninEvidenceId || "") !== String(trusted.evidence._id) ||
      meta.licenceNumber !== profile.licenceNumber ||
      meta.professionalType !== profile.type ||
      !documentRef ||
      licence.documentUrl !== documentRef ||
      meta.documentRef !== documentRef ||
      !validityMatches ||
      !this.legalNamesMatch(licence.nameOnRecord, trusted.legalName) ||
      !this.legalNamesMatch(licence.nameOnRecord, profile.licenceNameOnRecord) ||
      !validReviewTiming()
    ) {
      throw this.createError({
        message: "The licence review does not match the stored NIN evidence and current profile.",
        code: "PROFESSIONAL_VERIFICATION_REVIEW_EVIDENCE_MISMATCH",
        statusCode: 409,
      });
    }

    const conflict = await KYCVerification.exists({
      professional: profile._id,
      user: profile.user,
      ownerType: "professional",
      type: "licence",
      isActive: true,
      _id: {
        $ne: licence._id,
      },
    }).session(session);

    if (conflict) {
      throw this.createError({
        message: "Conflicting active licence reviews require reconciliation.",
        code: "PROFESSIONAL_VERIFICATION_CONFLICTING_REVIEWS",
        statusCode: 409,
      });
    }

    return {
      licenceReview: licence,
      expectedLicenceSource: source,
    };
  }

  // ───────────────────────── READINESS ─────────────────────────

  static getVerificationReadiness(profile, trusted = null) {
    const expectedLicenceSource = this.getExpectedLicenceSource(profile?.type);

    const ninEvidenceConfirmed = Boolean(trusted?.evidence?._id && trusted?.legalName);

    const licenceSourceValid = profile?.licenceVerificationSource === expectedLicenceSource;

    const licenceVerified =
      profile?.licenceVerificationStatus === "verified" &&
      profile?.licenceVerificationMethod === "manual" &&
      licenceSourceValid;

    const validity = this.getLicenceValidityState(profile);

    const effectiveLicenceName = validity.usingUpcoming
      ? profile.upcomingLicence.nameOnRecord
      : profile?.licenceNameOnRecord;

    const namesConsistent =
      ninEvidenceConfirmed && this.legalNamesMatch(trusted.legalName, effectiveLicenceName);

    const adminApproved = profile?.professionalApprovalStatus === "approved";

    const accountActive = profile?.accountStatus === "active";

    return {
      ninEvidenceConfirmed,
      licenceVerified,
      licenceSourceValid,
      expectedLicenceSource,
      namesConsistent,
      adminApproved,
      accountActive,
      licenceCurrent: validity.current,
      licenceExpired: validity.expired,
      licenceWithinGrace: validity.withinGrace,
      licenceExpiryISODate: validity.expiryISODate,
      licenceGraceEndsOn: validity.graceEndsOn,
      usingUpcomingLicence: validity.usingUpcoming,
      upcomingLicenceStartsOn: validity.upcomingStartsOn,

      verificationReady:
        ninEvidenceConfirmed &&
        licenceVerified &&
        namesConsistent &&
        validity.current &&
        adminApproved &&
        accountActive,
    };
  }

  // Transaction-safe readiness for eligibility-sensitive operations.
  // This promotes a due renewal before checking the active evidence.
  static async getVerifiedReadiness({ profile, session } = {}) {
    if (!session?.inTransaction()) {
      throw new Error("Eligibility verification requires an active transaction.");
    }

    if (
      await this.promoteUpcomingLicenceInSession({
        profile,
        session,
      })
    ) {
      await profile.save({ session });
    }

    const trusted = await this.getTrustedOnboardingNIN({
      profile,
      session,
    });

    const readiness = this.getVerificationReadiness(profile, trusted);

    if (!readiness.verificationReady) {
      return readiness;
    }

    await this.getVerifiedReviewEvidence({
      profile,
      trusted,
      session,
    });

    return readiness;
  }

  // ───────────────────────── EVIDENCE-BACKED STATUS ─────────────────────────

  // Shared by the professional status endpoint and server-rendered profile.
  // This may transactionally promote a due approved renewal. It neither
  // performs another NIN lookup nor creates a new verification or approval.
  // Work actions must still call getVerifiedReadiness in their own transaction.
  static async getVerificationStatus({ professionalProfileId, userId } = {}) {
    const owned = await this.getOwnedProfessional(professionalProfileId, userId);
    const session = await mongoose.startSession();

    try {
      let result;

      await session.withTransaction(async () => {
        const profile = await ProfessionalProfile.findOne({
          _id: owned._id,
          user: userId,
          accountStatus: { $ne: "closed" },
        })
          .select("+licenceDocumentUrl +licencePendingDocumentUrl +upcomingLicence.documentUrl")
          .session(session);

        if (!profile) {
          throw this.createError({
            message: "Professional profile not found or access denied.",
            code: "PROFESSIONAL_VERIFICATION_ACCESS_DENIED",
            statusCode: 403,
          });
        }

        let trusted = null;
        let evidenceErrorCode = null;
        let verifiedReviewEvidence = false;

        try {
          trusted = await this.getTrustedOnboardingNIN({ profile, session });
        } catch (error) {
          if (!EXPECTED_STATUS_EVIDENCE_ERRORS.has(error?.code)) throw error;
          evidenceErrorCode = error.code;
        }

        if (trusted && profile.upcomingLicence) {
          const licenceState = this.getLicenceValidityState(profile);

          if (licenceState.usingUpcoming) {
            try {
              const promoted = await this.promoteUpcomingLicenceInSession({ profile, session });
              if (promoted) await profile.save({ session });
            } catch (error) {
              if (!EXPECTED_STATUS_EVIDENCE_ERRORS.has(error?.code)) throw error;
              evidenceErrorCode = error.code;
            }
          }
        }

        const readiness = this.getVerificationReadiness(profile, trusted);

        if (
          trusted &&
          !evidenceErrorCode &&
          readiness.licenceVerified === true &&
          readiness.namesConsistent === true
        ) {
          try {
            await this.getVerifiedReviewEvidence({ profile, trusted, session });
            verifiedReviewEvidence = true;
          } catch (error) {
            if (!EXPECTED_STATUS_EVIDENCE_ERRORS.has(error?.code)) throw error;
            evidenceErrorCode = error.code;
          }
        }

        readiness.verificationReady = Boolean(
          readiness.verificationReady && verifiedReviewEvidence && !evidenceErrorCode
        );

        result = {
          professionalProfileId: String(profile._id),
          ninEvidenceStatus: trusted ? "registry_name_recorded" : "missing_or_inconsistent",
          ninHolderAuthenticated: false,
          adminNinDocumentaryReviewRequired: false,
          licenceVerificationStatus: profile.licenceVerificationStatus,
          licenceValidityType: profile.licenceValidityType || null,
          licenceLicensingYear: profile.licenceLicensingYear ?? null,
          licenceExpiryDate: profile.licenceExpiryDate || null,
          licencePendingDocumentSubmittedAt: profile.licencePendingDocumentSubmittedAt || null,
          pendingLicenceReview: Boolean(profile.licencePendingDocumentSubmittedAt),
          upcomingLicence: profile.upcomingLicence
            ? {
                validFrom: profile.upcomingLicence.validFrom,
                validityType: profile.upcomingLicence.validityType,
                licensingYear: profile.upcomingLicence.licensingYear ?? null,
                expiryDate: profile.upcomingLicence.expiryDate || null,
              }
            : null,
          professionalApprovalStatus: profile.professionalApprovalStatus,
          accountStatus: profile.accountStatus,
          marketplaceStatus: profile.marketplaceStatus,
          verificationReadiness: {
            ...readiness,
            verifiedReviewEvidence,
            evidenceErrorCode,
          },
        };
      });

      return result;
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────────── APPROVAL RESET ─────────────────────────

  static getApprovalResetUpdates() {
    return {
      professionalApprovalStatus: "pending",
      approvedForShiftsAt: null,
      approvedForShiftsBy: null,
      approvalNote: null,
      rejectionReason: null,
      marketplaceStatus: "hidden",
    };
  }

  // ───────────────────────── LICENCE NUMBER CHANGES ─────────────────────────

  static async changeLicenceNumber({ professionalProfileId, userId, licenceNumber } = {}) {
    const snapshot = await this.getOwnedProfessional(professionalProfileId, userId);

    const nextNumber = this.normalizeLicenceNumber(licenceNumber);

    const previous = snapshot.licenceNumber
      ? this.normalizeLicenceNumber(snapshot.licenceNumber)
      : null;

    if (nextNumber === previous) {
      return {
        changed: false,
        licenceVerificationStatus: snapshot.licenceVerificationStatus,
        reason: "Licence number is unchanged.",
      };
    }

    const session = await mongoose.startSession();

    try {
      let updated;

      await session.withTransaction(async () => {
        const current = await ProfessionalProfile.findOne({
          _id: snapshot._id,
          user: userId,
          licenceNumber: snapshot.licenceNumber,
          accountStatus: { $ne: "closed" },
          __v: snapshot.__v,
        })
          .select("+licenceDocumentUrl +licencePendingDocumentUrl +upcomingLicence.documentUrl")
          .session(session);

        if (!current) {
          throw this.createError({
            message: "Professional profile changed during licence update.",
            code: "PROFESSIONAL_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        current.set({
          licenceNumber: nextNumber,
          licenceVerificationStatus: "pending",
          licenceVerificationMethod: "not_checked",
          licenceVerificationSource: "not_checked",
          licenceNameOnRecord: null,
          licenceDocumentUrl: null,
          licencePendingDocumentUrl: null,
          licencePendingDocumentSubmittedAt: null,
          licenceValidityType: null,
          licenceLicensingYear: null,
          licenceExpiryDate: null,
          upcomingLicence: null,
          licenceVerifiedAt: null,
          licenceLastCheckedAt: null,
          licenceVerifiedBy: null,
          licenceVerificationNote: null,
          ...this.getApprovalResetUpdates(),
        });

        await KYCVerification.updateMany(
          {
            professional: current._id,
            user: current.user,
            ownerType: "professional",
            type: "licence",
            isActive: true,
          },
          {
            $set: {
              isActive: false,
            },
          },
          { session }
        );

        await KYCVerification.create(
          [
            {
              user: current.user,
              professional: current._id,
              ownerType: "professional",
              type: "licence",
              provider: "internal_review",
              providerEnvironment: null,
              status: "pending",
              reviewNote: "Licence number changed; new verification and approval required.",
              submittedAt: new Date(),
              metadata: {
                licenceNumberChanged: true,
                licenceNumber: nextNumber,
                professionalType: current.type,
              },
              isActive: true,
            },
          ],
          { session }
        );

        updated = await current.save({ session });
      });

      return {
        changed: true,
        licenceVerificationStatus: updated.licenceVerificationStatus,
        professionalApprovalStatus: updated.professionalApprovalStatus,
        requiresLicenceReview: true,
        requiresProfessionalApproval: true,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────────── LICENCE REVIEW ─────────────────────────

  static async recordLicenceReview({
    professionalProfileId,
    adminUserId,
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

    this.assertObjectId(professionalProfileId, "professional profile ID");

    if (!["verified", "rejected", "needs_review"].includes(decision)) {
      throw this.createError({
        message: "Invalid licence verification decision.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_DECISION",
      });
    }

    const cleanNote = this.truncate(note);

    if (cleanNote.length < 10) {
      throw this.createError({
        message: "Provide a meaningful licence review note.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_REVIEW_NOTE",
      });
    }

    const cleanName = typeof nameOnRecord === "string" ? nameOnRecord.trim() : "";

    if (cleanName.length > 150 || /[\u0000-\u001f\u007f]/.test(cleanName)) {
      throw this.createError({
        message: "Registered licence-holder name is invalid.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_REGISTERED_NAME",
      });
    }

    if (typeof councilReviewed !== "boolean") {
      throw this.createError({
        message: "Council review must be recorded accurately as true or false.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_COUNCIL_REVIEW",
      });
    }

    const cleanCouncilSource = typeof councilSource === "string" ? councilSource.trim() : "";

    if (
      cleanCouncilSource.length > 150 ||
      /[\u0000-\u001f\u007f]/.test(cleanCouncilSource) ||
      (councilReviewed && cleanCouncilSource.length < 3) ||
      (!councilReviewed && cleanCouncilSource.length > 0)
    ) {
      throw this.createError({
        message: "Specify a council source only if a council check was performed.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_COUNCIL_SOURCE",
      });
    }

    const snapshot = await this.getProfessional(professionalProfileId);

    if (snapshot.accountStatus === "closed") {
      throw this.createError({
        message: "A closed professional profile cannot receive a licence review.",
        code: "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
        statusCode: 409,
      });
    }

    const pendingDocument = snapshot.licencePendingDocumentUrl;

    if (
      typeof pendingDocument !== "string" ||
      !pendingDocument.trim() ||
      !snapshot.licencePendingDocumentSubmittedAt
    ) {
      throw this.createError({
        message: "A securely uploaded licence is required for review.",
        code: "PROFESSIONAL_VERIFICATION_DOCUMENT_REQUIRED",
        statusCode: 409,
      });
    }

    if (decision === "verified" && (!cleanName || !snapshot.licenceNumber)) {
      throw this.createError({
        message: "The licence-holder name and registration number are required.",
        code: "PROFESSIONAL_VERIFICATION_LICENCE_DETAILS_REQUIRED",
        statusCode: 409,
      });
    }

    const session = await mongoose.startSession();
    const now = new Date();

    try {
      let savedRecord;
      let updatedProfile;
      let renewal = false;

      await session.withTransaction(async () => {
        await this.assertAdmin(adminUserId, session);

        const current = await ProfessionalProfile.findOne({
          _id: snapshot._id,
          licenceNumber: snapshot.licenceNumber,
          accountStatus: { $ne: "closed" },
          __v: snapshot.__v,
        })
          .select("+licenceDocumentUrl +licencePendingDocumentUrl +upcomingLicence.documentUrl")
          .session(session);

        if (
          !current ||
          current.licencePendingDocumentUrl !== pendingDocument ||
          !current.licencePendingDocumentSubmittedAt
        ) {
          throw this.createError({
            message: "The uploaded licence changed during review.",
            code: "PROFESSIONAL_VERIFICATION_STALE",
            statusCode: 409,
          });
        }

        await this.promoteUpcomingLicenceInSession({
          profile: current,
          session,
        });

        // Read the NIN evidence already stored during onboarding.
        // No second provider lookup or NIN admin approval is performed.
        const trusted = await this.getTrustedOnboardingNIN({
          profile: current,
          session,
        });

        const verified = decision === "verified";

        if (verified && !this.legalNamesMatch(trusted.legalName, cleanName)) {
          throw this.createError({
            message: "The licence name does not match the trusted NIN legal name.",
            code: "PROFESSIONAL_VERIFICATION_NIN_LICENCE_NAME_MISMATCH",
            statusCode: 409,
          });
        }

        renewal =
          current.licenceVerificationStatus === "verified" && Boolean(current.licenceDocumentUrl);

        const validity = verified
          ? this.resolveLicenceValidity({
              professionalType: current.type,
              validityType,
              expiryDate,
              licensingYear,
              previousLicenceExpiryDate: current.licenceExpiryDate,
              isRenewal: renewal,
            })
          : null;

        if (verified && current.upcomingLicence) {
          throw this.createError({
            message:
              "An approved future licence already exists. Reconcile it before approving another.",
            code: "PROFESSIONAL_VERIFICATION_UPCOMING_ALREADY_APPROVED",
            statusCode: 409,
          });
        }

        const transitionOn =
          verified && renewal
            ? this.getRenewalTransitionDate({
                profile: current,
                validity,
              })
            : validity?.validFromISODate || null;

        const futureRenewal = Boolean(verified && renewal && transitionOn > todayInNigeria());

        const preserveExistingLicence = renewal && (!verified || futureRenewal);

        if ((verified && !futureRenewal) || !preserveExistingLicence) {
          await KYCVerification.updateMany(
            {
              professional: current._id,
              user: current.user,
              ownerType: "professional",
              type: "licence",
              isActive: true,
            },
            {
              $set: {
                isActive: false,
              },
            },
            { session }
          );
        }

        const source = this.getExpectedLicenceSource(current.type);

        [savedRecord] = await KYCVerification.create(
          [
            {
              user: current.user,
              professional: current._id,
              ownerType: "professional",
              type: "licence",
              provider: "manual",
              providerEnvironment: null,
              documentType: "licence_certificate",
              documentUrl: pendingDocument,
              status: decision,
              nameOnRecord: cleanName || null,
              reviewedBy: adminUserId,
              submittedAt: current.licencePendingDocumentSubmittedAt,
              lastCheckedAt: now,
              verifiedAt: verified ? now : null,
              rejectedAt: decision === "rejected" ? now : null,
              rejectionReason: decision === "rejected" ? cleanNote : null,
              reviewNote: cleanNote,
              metadata: {
                verificationSource: source,
                documentReviewed: true,
                currentAuthorisationReviewed: verified,
                documentRef: pendingDocument,
                licenceNumber: current.licenceNumber,
                professionalType: current.type,
                ninEvidenceId: String(trusted.evidence._id),
                ninLicenceNameMatched: this.legalNamesMatch(trusted.legalName, cleanName),
                councilReviewed,
                councilSource: councilReviewed ? cleanCouncilSource : null,
                validityType: validity?.validityType || null,
                licensingYear: validity?.licensingYear ?? null,
                expiryDate: validity?.expiryISODate || null,
                validFromDate: transitionOn,
                futureApproved: futureRenewal,
                renewal,
              },
              isActive: !preserveExistingLicence,
            },
          ],
          { session }
        );

        if (futureRenewal) {
          current.set({
            upcomingLicence: {
              reviewId: savedRecord._id,
              documentUrl: pendingDocument,
              nameOnRecord: cleanName,
              validFrom: parseISODate(transitionOn),
              evidenceValidFrom: parseISODate(validity.validFromISODate),
              validityType: validity.validityType,
              licensingYear: validity.licensingYear,
              expiryDate: validity.expiryDate,
              verifiedBy: adminUserId,
              verifiedAt: now,
              lastCheckedAt: now,
              reviewNote: cleanNote,
            },
            licencePendingDocumentUrl: null,
            licencePendingDocumentSubmittedAt: null,
          });
        } else if (verified) {
          current.set({
            licenceVerificationStatus: "verified",
            licenceVerificationMethod: "manual",
            licenceVerificationSource: source,
            licenceNameOnRecord: cleanName,
            licenceDocumentUrl: pendingDocument,
            licencePendingDocumentUrl: null,
            licencePendingDocumentSubmittedAt: null,
            licenceValidityType: validity.validityType,
            licenceLicensingYear: validity.licensingYear,
            licenceExpiryDate: validity.expiryDate,
            licenceVerifiedAt: now,
            licenceLastCheckedAt: now,
            licenceVerifiedBy: adminUserId,
            licenceVerificationNote: cleanNote,
          });
        } else if (preserveExistingLicence) {
          if (decision === "rejected") {
            current.set({
              licencePendingDocumentUrl: null,
              licencePendingDocumentSubmittedAt: null,
            });
          }
        } else {
          current.set({
            licenceVerificationStatus: decision,
            licenceVerificationMethod: "manual",
            licenceVerificationSource: source,
            licenceNameOnRecord: cleanName || null,
            licenceValidityType: null,
            licenceLicensingYear: null,
            licenceExpiryDate: null,
            licenceVerifiedAt: null,
            licenceLastCheckedAt: now,
            licenceVerifiedBy: adminUserId,
            licenceVerificationNote: cleanNote,
            ...(decision === "rejected"
              ? {
                  licencePendingDocumentUrl: null,
                  licencePendingDocumentSubmittedAt: null,
                }
              : {}),
            ...this.getApprovalResetUpdates(),
          });
        }

        updatedProfile = await current.save({ session });
      });

      return {
        status: decision,
        verified: decision === "verified",
        renewal,
        futureApproved: Boolean(updatedProfile.upcomingLicence && decision === "verified"),
        futureEffectiveOn: updatedProfile.upcomingLicence
          ? storedISODate(updatedProfile.upcomingLicence.validFrom)
          : null,
        currentLicenceVerificationStatus: updatedProfile.licenceVerificationStatus,
        verificationId: String(savedRecord._id),
        professionalProfileId: String(snapshot._id),
        reviewedBy: String(adminUserId),
        reviewedAt: now,
        requiresProfessionalApproval:
          decision === "verified" && updatedProfile.professionalApprovalStatus !== "approved",
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────────── FINAL APPROVAL ─────────────────────────

  static async reviewProfessionalApproval({
    professionalProfileId,
    adminUserId,
    decision,
    note,
  } = {}) {
    await this.assertAdmin(adminUserId);

    this.assertObjectId(professionalProfileId, "professional profile ID");

    if (!["approved", "rejected", "needs_review"].includes(decision)) {
      throw this.createError({
        message: "Invalid professional approval decision.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_APPROVAL_DECISION",
      });
    }

    const cleanNote = this.truncate(note);

    if (cleanNote.length < 10) {
      throw this.createError({
        message: "Provide a meaningful professional approval note.",
        code: "PROFESSIONAL_VERIFICATION_INVALID_APPROVAL_NOTE",
      });
    }

    const session = await mongoose.startSession();

    try {
      let profile;
      let skipped = false;

      await session.withTransaction(async () => {
        await this.assertAdmin(adminUserId, session);

        profile = await ProfessionalProfile.findById(professionalProfileId)
          .select("+licenceDocumentUrl +upcomingLicence.documentUrl")
          .session(session);

        if (!profile) {
          throw this.createError({
            message: "Professional profile not found.",
            code: "PROFESSIONAL_VERIFICATION_PROFILE_NOT_FOUND",
            statusCode: 404,
          });
        }

        if (profile.accountStatus === "closed") {
          throw this.createError({
            message: "A closed professional profile cannot receive an approval decision.",
            code: "PROFESSIONAL_VERIFICATION_ACCOUNT_INELIGIBLE",
            statusCode: 409,
          });
        }

        if (decision === "approved") {
          if (
            await this.promoteUpcomingLicenceInSession({
              profile,
              session,
            })
          ) {
            await profile.save({ session });
          }
        }

        if (profile.professionalApprovalStatus === "approved" && decision !== "approved") {
          throw this.createError({
            message: "Changing an approved professional requires a separate investigation.",
            code: "PROFESSIONAL_VERIFICATION_ALREADY_APPROVED",
            statusCode: 409,
          });
        }

        if (decision === "approved") {
          if (profile.accountStatus !== "active") {
            throw this.createError({
              message: "The professional account is not active.",
              code: "PROFESSIONAL_VERIFICATION_NOT_READY",
              statusCode: 409,
            });
          }

          const trusted = await this.getTrustedOnboardingNIN({
            profile,
            session,
          });

          const readiness = this.getVerificationReadiness(profile, trusted);

          if (
            !readiness.ninEvidenceConfirmed ||
            !readiness.licenceVerified ||
            !readiness.licenceCurrent ||
            !readiness.namesConsistent ||
            !readiness.accountActive ||
            !profile.licenceNumber ||
            !this.legalNamesMatch(profile.licenceNameOnRecord, trusted.legalName)
          ) {
            throw this.createError({
              message:
                "Stored production NIN evidence, a matching current licence and active account are required.",
              code: "PROFESSIONAL_VERIFICATION_NOT_READY",
              statusCode: 409,
            });
          }

          await this.getVerifiedReviewEvidence({
            profile,
            trusted,
            session,
          });

          if (profile.professionalApprovalStatus === "approved") {
            if (!profile.approvedForShiftsAt || !profile.approvedForShiftsBy) {
              throw this.createError({
                message: "Existing approval requires administrative reconciliation.",
                code: "PROFESSIONAL_VERIFICATION_APPROVAL_INCONSISTENT",
                statusCode: 409,
              });
            }

            if (profile.isModified()) {
              await profile.save({ session });
            }

            skipped = true;
            return;
          }
        }

        const now = new Date();

        profile.set({
          professionalApprovalStatus: decision,
          approvedForShiftsAt: decision === "approved" ? now : null,
          approvedForShiftsBy: decision === "approved" ? adminUserId : null,
          approvalNote: cleanNote,
          rejectionReason: decision === "rejected" ? cleanNote : null,
          ...(decision !== "approved" ? { marketplaceStatus: "hidden" } : {}),
        });

        await profile.save({ session });
      });

      return {
        status: profile.professionalApprovalStatus,
        approved: profile.professionalApprovalStatus === "approved",
        professionalProfileId: String(profile._id),
        ...(skipped
          ? {
              skipped: true,
              reason: "Professional approval is already complete.",
            }
          : {}),
      };
    } finally {
      await session.endSession();
    }
  }
}

module.exports = ProfessionalVerificationService;
