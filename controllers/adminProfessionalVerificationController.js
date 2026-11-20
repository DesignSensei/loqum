// controllers/adminProfessionalVerificationController.js

const AdminProfessionalVerificationService = require("../services/adminProfessionalVerificationService");
const { pipeline } = require("stream/promises");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const UploadStorageService = require("../services/storage/uploadStorageService");
const logger = require("../utils/logger");

// Routes require authenticated admin access and CSRF for mutations.
// NIN onboarding evidence supports licence review; no separate identity review.
const LICENCE_DOCUMENT_FIELDS = Object.freeze({
  pending: "licencePendingDocumentUrl",
  current: "licenceDocumentUrl",
  upcoming: "upcomingLicence.documentUrl",
});

const LICENCE_MIME_TYPES = Object.freeze({
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});

// ───────────────────────── ERROR HANDLING ─────────────────────────

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    const rawCode = typeof error?.code === "string" ? error.code : "";

    const code = /^[A-Z][A-Z0-9_]{2,99}$/.test(rawCode)
      ? rawCode
      : "ADMIN_PROFESSIONAL_VERIFICATION_ERROR";

    logger.error(`${operation}: ${code}`);
  }

  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return;
  }

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? "Unable to complete the verification request."
        : error?.message || "Invalid verification request.",
  });
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

// ───────────────────────── DASHBOARD DATA ─────────────────────────

exports.getDashboard = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminProfessionalVerificationService.getDashboardPageOptions({
      adminUserId: req.user?._id,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Get professional verification dashboard");
  }
};

// ───────────────────────── VERIFICATION QUEUE ─────────────────────────

exports.listProfessionals = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminProfessionalVerificationService.listProfessionals({
      adminUserId: req.user?._id,
      status: req.query?.status,
      type: req.query?.type,
      search: req.query?.search,
      page: req.query?.page,
      limit: req.query?.limit,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "List professional verifications");
  }
};

// ───────────────────────── PROFESSIONAL VERIFICATION DETAILS ─────────────────────────

exports.getProfessionalVerification = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminProfessionalVerificationService.getProfessionalVerification({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get professional verification");
  }
};

// ───────────────────────── INDIVIDUAL KYC ATTEMPT ─────────────────────────

exports.getVerificationAttempt = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminProfessionalVerificationService.getVerificationAttempt({
      adminUserId: req.user?._id,
      verificationId: req.params.verificationId,
    });

    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, "Get professional verification attempt");
  }
};

// ───────────────────────── PRIVATE LICENCE DOCUMENT ─────────────────────────

function documentError(message, code, statusCode) {
  return AdminProfessionalVerificationService.createError({ message, code, statusCode });
}

// document=pending (default), current, or upcoming. Never accepts a file URL.
exports.viewLicenceDocument = async (req, res) => {
  setNoStoreHeaders(res);
  let openedFile = null;

  try {
    await AdminProfessionalVerificationService.assertAdmin(req.user?._id);

    const professionalProfileId = req.params.professionalProfileId;

    AdminProfessionalVerificationService.assertObjectId(
      professionalProfileId,
      "professional profile ID"
    );

    const documentKind = req.query?.document === undefined ? "pending" : req.query.document;

    if (
      typeof documentKind !== "string" ||
      !Object.prototype.hasOwnProperty.call(LICENCE_DOCUMENT_FIELDS, documentKind)
    ) {
      throw documentError(
        "Select pending, current or upcoming licence evidence.",
        "ADMIN_PROFESSIONAL_DOCUMENT_SELECTION_INVALID",
        400
      );
    }

    const profile = await ProfessionalProfile.findById(professionalProfileId)
      .select(`_id +${LICENCE_DOCUMENT_FIELDS[documentKind]}`)
      .lean();

    const fileUrl =
      documentKind === "upcoming"
        ? profile?.upcomingLicence?.documentUrl
        : profile?.[LICENCE_DOCUMENT_FIELDS[documentKind]];

    if (!profile || !fileUrl) {
      throw documentError(
        "The selected practising-licence document is unavailable.",
        "ADMIN_PROFESSIONAL_DOCUMENT_NOT_FOUND",
        404
      );
    }

    const match =
      typeof fileUrl === "string"
        ? /^private:\/\/professional_licence\/([a-f0-9]{24})\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(pdf|jpg|jpeg|png|webp)$/i.exec(
            fileUrl
          )
        : null;

    const ownerId = String(profile._id);

    if (!match || match[1].toLowerCase() !== ownerId.toLowerCase()) {
      throw documentError(
        "The stored licence-document reference is invalid.",
        "ADMIN_PROFESSIONAL_DOCUMENT_REFERENCE_INVALID",
        500
      );
    }

    const extension = match[3].toLowerCase();
    const mimeType = LICENCE_MIME_TYPES[extension];

    openedFile = await UploadStorageService.openPrivateFile({
      fileUrl,
      expectedCategory: "professional_licence",
      expectedOwnerId: ownerId,
    });

    // Metadata checks complement the upload middleware's content validation.
    if (
      !openedFile ||
      openedFile.visibility !== "private" ||
      openedFile.mimeType !== mimeType ||
      !Number.isSafeInteger(openedFile.fileSizeBytes) ||
      openedFile.fileSizeBytes <= 0 ||
      openedFile.fileSizeBytes > 10 * 1024 * 1024 ||
      openedFile.contentLength !== openedFile.fileSizeBytes ||
      openedFile.partial !== false ||
      !openedFile.stream ||
      typeof openedFile.stream.pipe !== "function"
    ) {
      throw documentError(
        "The stored licence document failed metadata checks.",
        "ADMIN_PROFESSIONAL_DOCUMENT_METADATA_INVALID",
        500
      );
    }

    res.status(200);

    res.set({
      "Content-Type": mimeType,
      "Content-Length": String(openedFile.contentLength),
      "Content-Disposition": `attachment; filename="professional-licence-${ownerId}-${documentKind}.${extension}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Accept-Ranges": "none",
    });

    await pipeline(openedFile.stream, res);
  } catch (error) {
    openedFile?.stream?.destroy?.();

    if (!res.headersSent && !res.destroyed) {
      // Do not leave document headers on a JSON error response.
      for (const header of ["Content-Type", "Content-Length", "Content-Disposition"]) {
        res.removeHeader(header);
      }
    }

    return sendError(res, error, "View private professional licence document");
  }
};

// ───────────────────────── PRACTISING LICENCE REVIEW ─────────────────────────

exports.reviewLicence = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminProfessionalVerificationService.reviewLicence({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
      decision: req.body?.decision,
      nameOnRecord: req.body?.nameOnRecord,
      note: req.body?.note,
      validityType: req.body?.validityType,
      expiryDate: req.body?.expiryDate,
      licensingYear: req.body?.licensingYear,
      councilReviewed: req.body?.councilReviewed,
      councilSource: req.body?.councilSource,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Review professional licence");
  }
};

// ───────────────────────── FINAL PROFESSIONAL APPROVAL ─────────────────────────

exports.reviewProfessionalApproval = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const result = await AdminProfessionalVerificationService.reviewProfessionalApproval({
      adminUserId: req.user?._id,
      professionalProfileId: req.params.professionalProfileId,
      decision: req.body?.decision,
      note: req.body?.note,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Review professional approval");
  }
};
