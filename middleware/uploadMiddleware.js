// middleware/uploadMiddleware.js

const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mongoose = require("mongoose");

const UploadStorageService = require("../services/storage/uploadStorageService");
const Branch = require("../models/Branch");
const BranchService = require("../services/branchService");

const { OCCURRENCE_EVIDENCE_TYPES } = require("../constants/shiftLifecycle");

const userUploadDir = path.join(__dirname, "..", "public", "uploads", "users");

if (!fs.existsSync(userUploadDir)) {
  fs.mkdirSync(userUploadDir, { recursive: true });
}

const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];

const JOB_APPLICATION_RESUME_MAX_BYTES = 5 * 1024 * 1024;

const JOB_APPLICATION_RESUME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

/* ─────────────────────────────── USER PHOTO ─────────────────────────────── */

const userPhotoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, userUploadDir);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const userId = req.user?._id || req.session?.user?._id || "user";

    cb(null, `${userId}-${Date.now()}${ext}`);
  },
});

function imageFileFilter(req, file, cb) {
  if (!allowedImageTypes.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, and WEBP images are allowed."));
  }

  cb(null, true);
}

exports.uploadUserPhoto = multer({
  storage: userPhotoStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

/* ─────────────────────────────── JOB APPLICATION RESUME ─────────────────────────────── */

function createJobApplicationResumeUploadError({
  message,
  code,
  statusCode = 400,
  details = null,
  cause = null,
}) {
  const error = new Error(message);

  error.name = "JobApplicationResumeUploadError";
  error.code = code;
  error.statusCode = statusCode;

  if (details && typeof details === "object") {
    error.details = details;
  }

  if (cause) {
    error.cause = cause;
  }

  return error;
}

function normalizeOriginalFileName(value) {
  const fileName = path.basename(String(value || "resume").trim());

  return (
    fileName
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 255) || "resume"
  );
}

function getResumeExtension(fileName) {
  return path.extname(String(fileName || "")).toLowerCase();
}

function jobApplicationResumeFileFilter(req, file, cb) {
  const extension = getResumeExtension(file.originalname);

  if (!JOB_APPLICATION_RESUME_TYPES[extension]) {
    return cb(
      createJobApplicationResumeUploadError({
        message: "Only PDF, DOC, and DOCX resume files are allowed.",
        code: "JOB_APPLICATION_RESUME_TYPE_NOT_ALLOWED",
      })
    );
  }

  return cb(null, true);
}

const jobApplicationResumeUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: jobApplicationResumeFileFilter,
  limits: {
    files: 1,
    fileSize: JOB_APPLICATION_RESUME_MAX_BYTES,
  },
});

function isPdfBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

function isLegacyDocBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return false;
  }

  const compoundDocumentSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  return buffer.subarray(0, 8).equals(compoundDocumentSignature);
}

function isDocxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }

  const hasZipSignature =
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08));

  if (!hasZipSignature) {
    return false;
  }

  const hasContentTypes = buffer.includes(Buffer.from("[Content_Types].xml"));
  const hasWordDocument = buffer.includes(Buffer.from("word/document.xml"));

  return hasContentTypes && hasWordDocument;
}

function validateResumeBuffer(file) {
  const extension = getResumeExtension(file?.originalname);
  const buffer = file?.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createJobApplicationResumeUploadError({
      message: "The uploaded resume file is empty or could not be read.",
      code: "JOB_APPLICATION_RESUME_FILE_EMPTY",
    });
  }

  const isValid =
    (extension === ".pdf" && isPdfBuffer(buffer)) ||
    (extension === ".doc" && isLegacyDocBuffer(buffer)) ||
    (extension === ".docx" && isDocxBuffer(buffer));

  if (!isValid) {
    throw createJobApplicationResumeUploadError({
      message: "The uploaded resume file does not match its PDF, DOC, or DOCX format.",
      code: "JOB_APPLICATION_RESUME_CONTENT_INVALID",
    });
  }

  return {
    extension,
    mimeType: JOB_APPLICATION_RESUME_TYPES[extension],
  };
}

function normalizeResumeMulterError(error) {
  if (!(error instanceof multer.MulterError)) {
    return error;
  }

  if (error.code === "LIMIT_FILE_SIZE") {
    return createJobApplicationResumeUploadError({
      message: "Resume files cannot exceed 5 MB.",
      code: "JOB_APPLICATION_RESUME_TOO_LARGE",
      statusCode: 413,
    });
  }

  if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
    return createJobApplicationResumeUploadError({
      message: "Only one resume file may be uploaded.",
      code: "JOB_APPLICATION_RESUME_FILE_COUNT_INVALID",
    });
  }

  return createJobApplicationResumeUploadError({
    message: "The resume upload could not be processed.",
    code: "JOB_APPLICATION_RESUME_UPLOAD_FAILED",
    cause: error,
  });
}

function getProfessionalProfileId(req) {
  const professionalProfileId = req.professionalProfile?._id;

  if (!professionalProfileId) {
    throw createJobApplicationResumeUploadError({
      message: "Professional profile context is unavailable for resume upload.",
      code: "JOB_APPLICATION_RESUME_PROFESSIONAL_CONTEXT_REQUIRED",
      statusCode: 500,
    });
  }

  return professionalProfileId;
}

exports.parseJobApplicationResumeUpload = function parseJobApplicationResumeUpload(req, res, next) {
  jobApplicationResumeUpload.single("resume")(req, res, async (uploadError) => {
    if (uploadError) {
      return next(normalizeResumeMulterError(uploadError));
    }

    req.jobApplicationResumeUpload = null;
    req.cleanupJobApplicationResumeUpload = null;

    if (!req.file) {
      return next();
    }

    let storedFile = null;

    try {
      const { extension, mimeType } = validateResumeBuffer(req.file);

      storedFile = await UploadStorageService.storePrivateFile({
        category: "professional_resume",
        ownerId: getProfessionalProfileId(req),
        buffer: req.file.buffer,
        fileName: normalizeOriginalFileName(req.file.originalname),
        mimeType,
        extension,
      });

      req.jobApplicationResumeUpload = {
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
        fileSizeBytes: storedFile.fileSizeBytes,
        fileUrl: storedFile.fileUrl,
      };

      req.cleanupJobApplicationResumeUpload = async () => {
        if (!storedFile?.storageKey) {
          return {
            deleted: false,
          };
        }

        return UploadStorageService.deletePrivateFile({
          storageKey: storedFile.storageKey,
        });
      };

      return next();
    } catch (error) {
      if (storedFile?.storageKey) {
        try {
          await UploadStorageService.deletePrivateFile({
            storageKey: storedFile.storageKey,
          });
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
        }
      }

      return next(error);
    }
  });
};

/* ─────────────────────────────── PRACTISING LICENCE DOCUMENT ─────────────────────────────── */

/**
 * POST-ONBOARDING PROFESSIONAL LICENCE UPLOAD
 *
 * Field: licenceDocument (exactly one PDF, JPG, PNG or WEBP file, max 10 MB).
 *
 * Uses the same private:// storage service as existing document uploads.
 * The owner of the private storage key is the authenticated ProfessionalProfile.
 * Never accept a file URL or storage key from the request body.
 *
 *
 * The controller/service must persist req.professionalLicenceUpload.fileUrl
 * as licencePendingDocumentUrl with a submission timestamp, preserving the
 * already-approved current licence and its upcoming-licence slot.
 * Call req.commitProfessionalLicenceUpload() ONLY after persistence succeeds.
 * Before commit, req.cleanupProfessionalLicenceUpload() removes the private
 * object on rejected requests, abandoned responses or write failures.
 *
 * This middleware validates file signatures, not document authenticity,
 * malware safety, or professional registration. Admin review is mandatory.
 */

const PROFESSIONAL_LICENCE_MAX_BYTES = 10 * 1024 * 1024;
const PROFESSIONAL_LICENCE_FIELD = "licenceDocument";
const PROFESSIONAL_LICENCE_STORAGE_CATEGORY = "professional_licence";

const PROFESSIONAL_LICENCE_MIME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

function createProfessionalLicenceUploadError({ message, code, statusCode = 400, cause = null }) {
  const error = new Error(message);
  error.name = "ProfessionalLicenceUploadError";
  error.code = code;
  error.statusCode = statusCode;

  if (cause) {
    error.cause = cause;
  }

  return error;
}

function normalizeProfessionalLicenceUploadError(error) {
  if (!(error instanceof multer.MulterError)) {
    return error;
  }

  if (error.code === "LIMIT_FILE_SIZE") {
    return createProfessionalLicenceUploadError({
      message: "A practising licence file cannot exceed 10 MB.",
      code: "PROFESSIONAL_LICENCE_FILE_TOO_LARGE",
      statusCode: 413,
    });
  }

  if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
    return createProfessionalLicenceUploadError({
      message: "Upload exactly one practising licence using the licenceDocument field.",
      code: "PROFESSIONAL_LICENCE_FILE_COUNT_INVALID",
    });
  }

  return createProfessionalLicenceUploadError({
    message: "The practising licence upload could not be processed.",
    code: "PROFESSIONAL_LICENCE_UPLOAD_FAILED",
    cause: error,
  });
}

function professionalLicenceFileFilter(_req, file, cb) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const expectedType = PROFESSIONAL_LICENCE_MIME_TYPES[extension];
  const suppliedType = String(file.mimetype || "").toLowerCase();

  if (!expectedType) {
    return cb(
      createProfessionalLicenceUploadError({
        message: "Practising licences must be PDF, JPG, PNG or WEBP files.",
        code: "PROFESSIONAL_LICENCE_TYPE_NOT_ALLOWED",
      })
    );
  }

  if (
    suppliedType &&
    suppliedType !== "application/octet-stream" &&
    suppliedType !== expectedType
  ) {
    return cb(
      createProfessionalLicenceUploadError({
        message: "The practising licence MIME type does not match its file extension.",
        code: "PROFESSIONAL_LICENCE_MIME_TYPE_MISMATCH",
      })
    );
  }

  return cb(null, true);
}

const professionalLicenceUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: professionalLicenceFileFilter,
  limits: {
    files: 1,
    fileSize: PROFESSIONAL_LICENCE_MAX_BYTES,
    fields: 20,
    fieldSize: 16 * 1024,
    parts: 21,
  },
});

function validateProfessionalLicenceBuffer(file) {
  const extension = path.extname(file?.originalname || "").toLowerCase();
  const buffer = file?.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createProfessionalLicenceUploadError({
      message: "The practising licence file is empty or unreadable.",
      code: "PROFESSIONAL_LICENCE_FILE_EMPTY",
    });
  }

  // These detection helpers are also used by overtime evidence uploads.
  const detectors = {
    ".pdf": isPdfBuffer,
    ".jpg": isJpegBuffer,
    ".jpeg": isJpegBuffer,
    ".png": isPngBuffer,
    ".webp": isWebpBuffer,
  };

  if (!detectors[extension] || !detectors[extension](buffer)) {
    throw createProfessionalLicenceUploadError({
      message: "The practising licence content does not match its file format.",
      code: "PROFESSIONAL_LICENCE_CONTENT_INVALID",
    });
  }

  return {
    extension,
    mimeType: PROFESSIONAL_LICENCE_MIME_TYPES[extension],
  };
}

function getProfessionalLicenceUploadOwner(req) {
  const profile = req.professionalProfile;
  const userId = req.user?._id;
  const profileId = profile?._id;
  const ownerUserId = profile?.user?._id || profile?.user;
  const paramId = req.params?.professionalProfileId;

  if (
    !userId ||
    !profileId ||
    !ownerUserId ||
    !/^[a-f\d]{24}$/i.test(String(userId)) ||
    !/^[a-f\d]{24}$/i.test(String(profileId)) ||
    String(userId) !== String(ownerUserId) ||
    (paramId && String(paramId) !== String(profileId))
  ) {
    throw createProfessionalLicenceUploadError({
      message: "A matching authenticated professional profile is required.",
      code: "PROFESSIONAL_LICENCE_PROFILE_ACCESS_DENIED",
      statusCode: 403,
    });
  }

  return String(profileId);
}

function assertNoClientSuppliedLicenceReference(body) {
  for (const key of [
    "licenceDocumentUrl",
    "licencePendingDocumentUrl",
    "fileUrl",
    "storageKey",
    "documentUrl",
  ]) {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) {
      throw createProfessionalLicenceUploadError({
        message: "Licence file references must come from a genuine uploaded file.",
        code: "PROFESSIONAL_LICENCE_CLIENT_REFERENCE_NOT_ALLOWED",
      });
    }
  }
}

exports.parseProfessionalLicenceUpload = function parseProfessionalLicenceUpload(req, res, next) {
  req.professionalLicenceUpload = null;
  req.cleanupProfessionalLicenceUpload = null;
  req.commitProfessionalLicenceUpload = null;

  let ownerId;

  try {
    ownerId = getProfessionalLicenceUploadOwner(req);

    if (!req.is("multipart/form-data")) {
      throw createProfessionalLicenceUploadError({
        message: "Submit the practising licence as a multipart file upload.",
        code: "PROFESSIONAL_LICENCE_MULTIPART_REQUIRED",
      });
    }
  } catch (error) {
    return next(error);
  }

  professionalLicenceUpload.single(PROFESSIONAL_LICENCE_FIELD)(req, res, async (uploadError) => {
    if (uploadError) {
      return next(normalizeProfessionalLicenceUploadError(uploadError));
    }

    let storedFile = null;
    let committed = false;
    let cleanupPromise = null;

    const cleanup = () => {
      if (committed) return Promise.resolve({ deleted: false, committed: true });
      if (cleanupPromise) return cleanupPromise;

      cleanupPromise = storedFile?.storageKey
        ? UploadStorageService.deletePrivateFile({
            storageKey: storedFile.storageKey,
          })
        : Promise.resolve({ deleted: false });

      return cleanupPromise;
    };

    try {
      assertNoClientSuppliedLicenceReference(req.body);

      if (!req.file) {
        throw createProfessionalLicenceUploadError({
          message: "Choose a practising licence document to upload.",
          code: "PROFESSIONAL_LICENCE_DOCUMENT_REQUIRED",
        });
      }

      const { extension, mimeType } = validateProfessionalLicenceBuffer(req.file);

      storedFile = await UploadStorageService.storePrivateFile({
        category: PROFESSIONAL_LICENCE_STORAGE_CATEGORY,
        ownerId,
        buffer: req.file.buffer,
        fileName: normalizeOriginalFileName(req.file.originalname),
        mimeType,
        extension,
      });

      if (
        typeof storedFile?.storageKey !== "string" ||
        !storedFile.storageKey.startsWith(`${PROFESSIONAL_LICENCE_STORAGE_CATEGORY}/${ownerId}/`) ||
        storedFile.fileUrl !== `private://${storedFile.storageKey}`
      ) {
        throw createProfessionalLicenceUploadError({
          message: "Private practising licence storage returned an invalid reference.",
          code: "PROFESSIONAL_LICENCE_STORAGE_INVALID",
          statusCode: 500,
        });
      }

      req.professionalLicenceUpload = Object.freeze({
        fileName: storedFile.fileName,
        mimeType: storedFile.mimeType,
        fileSizeBytes: storedFile.fileSizeBytes,
        fileUrl: storedFile.fileUrl,
      });

      req.cleanupProfessionalLicenceUpload = cleanup;
      req.commitProfessionalLicenceUpload = () => {
        if (cleanupPromise) {
          throw createProfessionalLicenceUploadError({
            message: "A discarded practising licence upload cannot be committed.",
            code: "PROFESSIONAL_LICENCE_ALREADY_DISCARDED",
            statusCode: 409,
          });
        }
        committed = true;
      };

      // Do not leave an orphan even if a controller forgets to commit after
      // sending a 2xx response, or the client disconnects mid-request.
      function cleanupIfUncommitted() {
        if (!committed) {
          cleanup().catch(() => {
            // The calling service should also reconcile orphaned files.
            // Avoid exposing filenames and private paths in application logs.
            console.error("Private practising licence upload cleanup failed.");
          });
        }
      }

      res.once("finish", cleanupIfUncommitted);
      res.once("close", cleanupIfUncommitted);

      // The buffer is no longer required once the object is safely stored.
      req.file.buffer = null;

      return next();
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
      return next(error);
    }
  });
};

/* ─────────────────────────────── FACILITY PERMIT DOCUMENT ─────────────────────────────── */

/**
 * POST-ONBOARDING BRANCH FACILITY PERMIT UPLOAD
 *
 * Use ONLY on the employer-owned route for a particular branch, after the
 * existing authenticated/verified/onboarded employer middleware.
 *
 * Expected multipart field: permitDocument (one PDF/JPG/PNG/WEBP, <= 10 MB).
 * The employer-specific controller persists req.facilityPermitUpload in
 * FacilityPermitVerificationService.submitPermit(), then calls
 * req.commitFacilityPermitUpload() immediately after DB commit.
 *
 * The middleware does not issue permits, review documents or grant posting
 * entitlement. File signatures are a format check, not malware screening.
 */

const FACILITY_PERMIT_FIELD = "permitDocument";
const FACILITY_PERMIT_CATEGORY = "facility_permit";
const FACILITY_PERMIT_MAX_BYTES = 10 * 1024 * 1024;
const FACILITY_PERMIT_MIME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

function facilityPermitUploadError(message, code, statusCode = 400, cause = null) {
  const error = new Error(message);
  error.name = "FacilityPermitUploadError";
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
}

function normalizeFacilityPermitMulterError(error) {
  if (!(error instanceof multer.MulterError)) return error;

  if (error.code === "LIMIT_FILE_SIZE") {
    return facilityPermitUploadError(
      "Facility permit documents cannot exceed 10 MB.",
      "FACILITY_PERMIT_FILE_TOO_LARGE",
      413
    );
  }
  if (["LIMIT_UNEXPECTED_FILE", "LIMIT_FILE_COUNT"].includes(error.code)) {
    return facilityPermitUploadError(
      "Upload exactly one document using the permitDocument field.",
      "FACILITY_PERMIT_FILE_COUNT_INVALID"
    );
  }
  return facilityPermitUploadError(
    "The facility permit upload could not be processed.",
    "FACILITY_PERMIT_UPLOAD_FAILED",
    400,
    error
  );
}

function facilityPermitFileFilter(_req, file, callback) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const expected = FACILITY_PERMIT_MIME_TYPES[extension];
  const supplied = String(file.mimetype || "").toLowerCase();

  if (!expected) {
    return callback(
      facilityPermitUploadError(
        "Facility permits must be PDF, JPG, PNG or WEBP files.",
        "FACILITY_PERMIT_TYPE_NOT_ALLOWED"
      )
    );
  }
  if (supplied && supplied !== expected && supplied !== "application/octet-stream") {
    return callback(
      facilityPermitUploadError(
        "The permit document MIME type does not match its extension.",
        "FACILITY_PERMIT_MIME_MISMATCH"
      )
    );
  }
  return callback(null, true);
}

const facilityPermitMultipart = multer({
  storage: multer.memoryStorage(),
  fileFilter: facilityPermitFileFilter,
  limits: {
    files: 1,
    fileSize: FACILITY_PERMIT_MAX_BYTES,
    fields: 20,
    fieldSize: 16 * 1024,
    parts: 21,
  },
});

function validateFacilityPermitBuffer(file) {
  const extension = path.extname(file?.originalname || "").toLowerCase();
  const buffer = file?.buffer;
  const detectors = {
    ".pdf": isPdfBuffer,
    ".jpg": isJpegBuffer,
    ".jpeg": isJpegBuffer,
    ".png": isPngBuffer,
    ".webp": isWebpBuffer,
  };

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw facilityPermitUploadError(
      "The facility permit file is empty or unreadable.",
      "FACILITY_PERMIT_FILE_EMPTY"
    );
  }
  if (buffer.length > FACILITY_PERMIT_MAX_BYTES) {
    throw facilityPermitUploadError(
      "Facility permit documents cannot exceed 10 MB.",
      "FACILITY_PERMIT_FILE_TOO_LARGE",
      413
    );
  }
  if (!detectors[extension] || !detectors[extension](buffer)) {
    throw facilityPermitUploadError(
      "The permit document content does not match its file format.",
      "FACILITY_PERMIT_CONTENT_INVALID"
    );
  }

  return {
    extension,
    mimeType: FACILITY_PERMIT_MIME_TYPES[extension],
  };
}

function rejectClientFacilityReferences(body) {
  const forbidden = [
    "documentRef",
    "documentUrl",
    "permitDocumentUrl",
    "facilityPermitDocumentUrl",
    "fileUrl",
    "storageKey",
    "fileReference",
    "documentStorageKey",
    "documentMimeType",
    "documentSizeBytes",
    "submittedBy",
    "reviewedBy",
    "status",
    "verifiedAt",
    "isCurrent",
    "activatedAt",
    "revokedAt",
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) {
      throw facilityPermitUploadError(
        "Document references and verification decisions cannot be provided by the client.",
        "FACILITY_PERMIT_CLIENT_EVIDENCE_NOT_ALLOWED"
      );
    }
  }
}

async function assertFacilityPermitUploadContext(req) {
  // Identity is derived from existing authenticated employer middleware,
  // never from multipart fields; route IDs only constrain that identity.
  const userId = req.user?._id;
  const profileId = req.employerProfile?._id;
  const branchId = req.params?.branchId;
  const requestedBusinessId = req.params?.businessId || req.params?.employerProfileId;

  if (
    req.user?.role !== "employer" ||
    !mongoose.isValidObjectId(userId) ||
    !mongoose.isValidObjectId(profileId) ||
    !mongoose.isValidObjectId(branchId) ||
    (requestedBusinessId && String(requestedBusinessId) !== String(profileId))
  ) {
    throw facilityPermitUploadError(
      "An authenticated employer and a matching branch are required.",
      "FACILITY_PERMIT_UPLOAD_CONTEXT_INVALID",
      403
    );
  }

  await BranchService.assertCanManageBranches({
    businessId: profileId,
    actorUserId: userId,
  });

  const branch = await Branch.findOne({
    _id: branchId,
    business: profileId,
  })
    .select("_id")
    .lean();

  if (!branch) {
    throw facilityPermitUploadError(
      "This branch was not found for your business.",
      "FACILITY_PERMIT_BRANCH_NOT_FOUND",
      404
    );
  }

  return String(branch._id);
}

exports.parseFacilityPermitUpload = async function parseFacilityPermitUpload(req, res, next) {
  req.facilityPermitUpload = null;
  req.cleanupFacilityPermitUpload = null;
  req.commitFacilityPermitUpload = null;

  let branchId;
  try {
    branchId = await assertFacilityPermitUploadContext(req);
    if (!req.is("multipart/form-data")) {
      throw facilityPermitUploadError(
        "Submit the facility permit using multipart/form-data.",
        "FACILITY_PERMIT_MULTIPART_REQUIRED"
      );
    }
  } catch (error) {
    return next(error);
  }

  return facilityPermitMultipart.single(FACILITY_PERMIT_FIELD)(req, res, async (uploadError) => {
    if (uploadError) return next(normalizeFacilityPermitMulterError(uploadError));

    let storedFile = null;
    let committed = false;
    let cleanupPromise = null;

    const expectedPrefix = `${FACILITY_PERMIT_CATEGORY}/${branchId}/`;
    const cleanup = () => {
      if (committed) return Promise.resolve({ deleted: false, committed: true });
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = storedFile?.storageKey?.startsWith(expectedPrefix)
        ? UploadStorageService.deletePrivateFile({ storageKey: storedFile.storageKey })
        : Promise.resolve({ deleted: false });
      return cleanupPromise;
    };

    try {
      rejectClientFacilityReferences(req.body);
      if (!req.file) {
        throw facilityPermitUploadError(
          "Choose a facility permit document to upload.",
          "FACILITY_PERMIT_DOCUMENT_REQUIRED"
        );
      }

      const { extension, mimeType } = validateFacilityPermitBuffer(req.file);
      const sizeBytes = req.file.buffer.length;

      storedFile = await UploadStorageService.storePrivateFile({
        category: FACILITY_PERMIT_CATEGORY,
        ownerId: branchId,
        buffer: req.file.buffer,
        fileName: normalizeOriginalFileName(req.file.originalname),
        mimeType,
        extension,
      });

      const storageKey = storedFile?.storageKey;
      const uuidPattern =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(pdf|jpg|jpeg|png|webp)$/i;
      const actualFilename =
        typeof storageKey === "string" ? storageKey.slice(expectedPrefix.length) : "";

      if (
        typeof storageKey !== "string" ||
        !storageKey.startsWith(expectedPrefix) ||
        !uuidPattern.test(actualFilename) ||
        storedFile.fileUrl !== `private://${storageKey}` ||
        storedFile.mimeType !== mimeType ||
        storedFile.fileSizeBytes !== sizeBytes
      ) {
        throw facilityPermitUploadError(
          "Private facility-permit storage returned invalid evidence.",
          "FACILITY_PERMIT_STORAGE_INVALID",
          500
        );
      }

      req.facilityPermitUpload = Object.freeze({
        category: FACILITY_PERMIT_CATEGORY,
        ownerId: branchId,
        fileUrl: storedFile.fileUrl,
        mimeType,
        sizeBytes,
      });
      req.cleanupFacilityPermitUpload = cleanup;
      req.commitFacilityPermitUpload = () => {
        if (cleanupPromise) {
          throw facilityPermitUploadError(
            "A discarded permit upload cannot be committed.",
            "FACILITY_PERMIT_UPLOAD_ALREADY_DISCARDED",
            409
          );
        }
        committed = true;
      };

      const cleanupIfUncommitted = () => {
        if (committed) return;
        cleanup().catch(() => {
          // Do not log private file references or sensitive documents.
          console.error("Private facility-permit upload cleanup failed.");
        });
      };
      res.once("finish", cleanupIfUncommitted);
      res.once("close", cleanupIfUncommitted);

      req.file.buffer = null;
      return next();
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
      return next(error);
    }
  });
};

/* ─────────────────────────────── OVERTIME EVIDENCE ─────────────────────────────── */

const OVERTIME_EVIDENCE_MAX_FILES = 3;
const OVERTIME_EVIDENCE_MAX_FILE_BYTES = 20 * 1024 * 1024;
const OVERTIME_EVIDENCE_MAX_DESCRIPTION_LENGTH = 500;

const OVERTIME_EVIDENCE_MIME_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

const OVERTIME_EVIDENCE_IMAGE_EXTENSIONS = Object.freeze([".jpg", ".jpeg", ".png", ".webp"]);

const OVERTIME_EVIDENCE_DOCUMENT_EXTENSIONS = Object.freeze([".pdf", ".doc", ".docx"]);

const OVERTIME_EVIDENCE_VIDEO_EXTENSIONS = Object.freeze([".mp4", ".webm"]);

const OVERTIME_EVIDENCE_ALLOWED_EXTENSIONS = Object.freeze({
  image: OVERTIME_EVIDENCE_IMAGE_EXTENSIONS,
  screenshot: OVERTIME_EVIDENCE_IMAGE_EXTENSIONS,
  video: OVERTIME_EVIDENCE_VIDEO_EXTENSIONS,
  document: OVERTIME_EVIDENCE_DOCUMENT_EXTENSIONS,

  message: [...OVERTIME_EVIDENCE_IMAGE_EXTENSIONS, ...OVERTIME_EVIDENCE_DOCUMENT_EXTENSIONS],

  attendance_record: [
    ...OVERTIME_EVIDENCE_IMAGE_EXTENSIONS,
    ...OVERTIME_EVIDENCE_DOCUMENT_EXTENSIONS,
  ],

  other: Object.keys(OVERTIME_EVIDENCE_MIME_TYPES),
});

function createOvertimeEvidenceUploadError({
  message,
  code,
  statusCode = 400,
  details = null,
  cause = null,
}) {
  const error = new Error(message);

  error.name = "OvertimeEvidenceUploadError";
  error.code = code;
  error.statusCode = statusCode;

  if (details && typeof details === "object") {
    error.details = details;
  }

  if (cause) {
    error.cause = cause;
  }

  return error;
}

function normalizeOvertimeEvidenceMulterError(error) {
  if (!(error instanceof multer.MulterError)) {
    return error;
  }

  if (error.code === "LIMIT_FILE_SIZE") {
    return createOvertimeEvidenceUploadError({
      message: "Each overtime evidence file must not exceed 20 MB.",
      code: "OVERTIME_EVIDENCE_FILE_TOO_LARGE",
      statusCode: 413,
    });
  }

  if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
    return createOvertimeEvidenceUploadError({
      message: "You may upload up to three overtime evidence files.",
      code: "OVERTIME_EVIDENCE_FILE_COUNT_INVALID",
    });
  }

  return createOvertimeEvidenceUploadError({
    message: "The overtime evidence upload could not be processed.",
    code: "OVERTIME_EVIDENCE_UPLOAD_FAILED",
    cause: error,
  });
}

function overtimeEvidenceFileFilter(req, file, cb) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const expectedMimeType = OVERTIME_EVIDENCE_MIME_TYPES[extension];

  if (!expectedMimeType) {
    return cb(
      createOvertimeEvidenceUploadError({
        message:
          "Unsupported overtime evidence format. Use JPG, PNG, WEBP, PDF, DOC, DOCX, MP4, or WEBM.",
        code: "OVERTIME_EVIDENCE_TYPE_NOT_ALLOWED",
      })
    );
  }

  const suppliedMimeType = String(file.mimetype || "").toLowerCase();

  if (
    suppliedMimeType &&
    suppliedMimeType !== "application/octet-stream" &&
    suppliedMimeType !== expectedMimeType
  ) {
    return cb(
      createOvertimeEvidenceUploadError({
        message: "The overtime evidence file type does not match its extension.",
        code: "OVERTIME_EVIDENCE_MIME_TYPE_MISMATCH",
      })
    );
  }

  return cb(null, true);
}

const overtimeEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: overtimeEvidenceFileFilter,

  limits: {
    files: OVERTIME_EVIDENCE_MAX_FILES,
    fileSize: OVERTIME_EVIDENCE_MAX_FILE_BYTES,
    fields: 40,
    fieldSize: 64 * 1024,
    parts: 43,
  },
});

function isJpegBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

function isPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return false;
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return buffer.subarray(0, 8).equals(signature);
}

function isWebpBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function isMp4Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp"
  );
}

function isWebmBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return false;
  }

  const signature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

  return (
    buffer.subarray(0, 4).equals(signature) &&
    buffer.subarray(0, Math.min(buffer.length, 512)).toString("ascii").includes("webm")
  );
}

function validateOvertimeEvidenceBuffer(file) {
  const extension = path.extname(file?.originalname || "").toLowerCase();
  const buffer = file?.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createOvertimeEvidenceUploadError({
      message: "An overtime evidence file is empty or could not be read.",
      code: "OVERTIME_EVIDENCE_FILE_EMPTY",
    });
  }

  const validators = {
    ".jpg": isJpegBuffer,
    ".jpeg": isJpegBuffer,
    ".png": isPngBuffer,
    ".webp": isWebpBuffer,
    ".pdf": isPdfBuffer,
    ".doc": isLegacyDocBuffer,
    ".docx": isDocxBuffer,
    ".mp4": isMp4Buffer,
    ".webm": isWebmBuffer,
  };

  const validator = validators[extension];

  if (!validator || !validator(buffer)) {
    throw createOvertimeEvidenceUploadError({
      message: "An overtime evidence file does not match its declared format.",
      code: "OVERTIME_EVIDENCE_CONTENT_INVALID",
    });
  }

  return {
    extension,
    mimeType: OVERTIME_EVIDENCE_MIME_TYPES[extension],
  };
}

function parseOvertimeEvidenceManifest(value, fileCount) {
  if (value === undefined || value === null || value === "") {
    if (fileCount === 0) {
      return [];
    }

    throw createOvertimeEvidenceUploadError({
      message: "Evidence details are required for each uploaded file.",
      code: "OVERTIME_EVIDENCE_MANIFEST_REQUIRED",
    });
  }

  let manifest;

  try {
    manifest = JSON.parse(value);
  } catch (error) {
    throw createOvertimeEvidenceUploadError({
      message: "Overtime evidence details are invalid.",
      code: "OVERTIME_EVIDENCE_MANIFEST_INVALID",
      cause: error,
    });
  }

  if (!Array.isArray(manifest) || manifest.length !== fileCount) {
    throw createOvertimeEvidenceUploadError({
      message: "Each overtime evidence file must have one matching evidence entry.",
      code: "OVERTIME_EVIDENCE_MANIFEST_COUNT_MISMATCH",
    });
  }

  return manifest.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createOvertimeEvidenceUploadError({
        message: `Evidence item ${index + 1} is invalid.`,
        code: "OVERTIME_EVIDENCE_ITEM_INVALID",
      });
    }

    const type = String(item.type || "")
      .trim()
      .toLowerCase();
    const description = String(item.description || "").trim();

    if (!OCCURRENCE_EVIDENCE_TYPES.includes(type)) {
      throw createOvertimeEvidenceUploadError({
        message: `Evidence item ${index + 1} has an unsupported type.`,
        code: "OVERTIME_EVIDENCE_TYPE_INVALID",
      });
    }

    if (description.length > OVERTIME_EVIDENCE_MAX_DESCRIPTION_LENGTH) {
      throw createOvertimeEvidenceUploadError({
        message: `Evidence item ${index + 1} description cannot exceed 500 characters.`,
        code: "OVERTIME_EVIDENCE_DESCRIPTION_TOO_LONG",
      });
    }

    return {
      type,
      description: description || null,
    };
  });
}

function validateOvertimeEvidenceFileCategory(file, item, index) {
  const extension = path.extname(file.originalname || "").toLowerCase();

  const allowedExtensions = OVERTIME_EVIDENCE_ALLOWED_EXTENSIONS[item.type];

  if (!allowedExtensions || !allowedExtensions.includes(extension)) {
    throw createOvertimeEvidenceUploadError({
      message: `Evidence item ${index + 1} file format is not supported for ${item.type.replace(/_/g, " ")} evidence.`,
      code: "OVERTIME_EVIDENCE_CATEGORY_FORMAT_INVALID",
    });
  }
}

function parseOvertimeCheckoutLocation(req) {
  const value = req.body?.location;

  if (typeof value !== "string") {
    return;
  }

  let location;

  try {
    location = JSON.parse(value);
  } catch (error) {
    throw createOvertimeEvidenceUploadError({
      message: "Checkout location data is invalid.",
      code: "OVERTIME_CHECKOUT_LOCATION_INVALID",
      cause: error,
    });
  }

  if (!location || typeof location !== "object" || Array.isArray(location)) {
    throw createOvertimeEvidenceUploadError({
      message: "Checkout location data is invalid.",
      code: "OVERTIME_CHECKOUT_LOCATION_INVALID",
    });
  }

  req.body.location = location;
}

function getOvertimeEvidenceOccurrenceId(req) {
  const occurrenceId = String(req.params?.occurrenceId || "").trim();

  if (!/^[a-fA-F0-9]{24}$/.test(occurrenceId)) {
    throw createOvertimeEvidenceUploadError({
      message: "A valid occurrence is required for overtime evidence.",
      code: "OVERTIME_EVIDENCE_OCCURRENCE_REQUIRED",
    });
  }

  return occurrenceId;
}

function requireOvertimeEvidenceProfessionalContext(req) {
  const userId = req.user?._id || req.session?.user?._id;
  const professionalProfileId = req.professionalProfile?._id;

  if (!userId || !professionalProfileId) {
    throw createOvertimeEvidenceUploadError({
      message: "An authenticated professional profile is required for overtime evidence.",
      code: "OVERTIME_EVIDENCE_PROFESSIONAL_CONTEXT_REQUIRED",
      statusCode: 403,
    });
  }
}

function createOvertimeEvidenceCleanup(storedFiles) {
  let cleanupPromise = null;

  return function cleanupProfessionalOvertimeEvidenceUpload() {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = Promise.allSettled(
      storedFiles.map((file) =>
        UploadStorageService.deletePrivateFile({
          storageKey: file.storageKey,
        })
      )
    ).then((results) => {
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);

      if (errors.length > 0) {
        const error = createOvertimeEvidenceUploadError({
          message: "One or more overtime evidence files could not be cleaned up.",
          code: "OVERTIME_EVIDENCE_CLEANUP_FAILED",
          statusCode: 500,
        });

        error.cleanupErrors = errors;

        throw error;
      }

      return {
        deleted: results.filter((result) => result.status === "fulfilled" && result.value.deleted)
          .length,
      };
    });

    return cleanupPromise;
  };
}

function attachOvertimeEvidenceCleanupOnFailure(res, cleanup) {
  function cleanupSilently() {
    cleanup().catch((error) => {
      console.error("Overtime evidence cleanup failed:", error);
    });
  }

  res.once("finish", function () {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      cleanupSilently();
    }
  });

  res.once("close", function () {
    if (!res.writableEnded) {
      cleanupSilently();
    }
  });
}

/**
 * Parse uploaded evidence on the existing professional checkout route.
 *
 * The authenticated checkout request may use multipart/form-data with:
 *
 * - overtimeEvidenceFiles: up to three private file uploads
 * - overtimeEvidenceManifest: JSON array matching the files in order
 * - location: JSON-encoded browser geolocation data
 * - normal checkout fields, including PIN and overtime statement
 *
 * The middleware builds req.body.requestEvidence for ShiftAttendanceService.
 * Authorization and overtime approval remain the responsibility of their
 * existing domain services.
 */
exports.parseProfessionalOvertimeEvidenceUpload = function parseProfessionalOvertimeEvidenceUpload(
  req,
  res,
  next
) {
  req.professionalOvertimeEvidenceUploads = [];
  req.cleanupProfessionalOvertimeEvidenceUpload = null;

  if (!req.is("multipart/form-data")) {
    return next();
  }

  overtimeEvidenceUpload.array("overtimeEvidenceFiles", OVERTIME_EVIDENCE_MAX_FILES)(
    req,
    res,
    async (uploadError) => {
      if (uploadError) {
        return next(normalizeOvertimeEvidenceMulterError(uploadError));
      }

      const files = Array.isArray(req.files) ? req.files : [];
      const storedFiles = [];

      const cleanup = createOvertimeEvidenceCleanup(storedFiles);

      req.cleanupProfessionalOvertimeEvidenceUpload = cleanup;

      try {
        requireOvertimeEvidenceProfessionalContext(req);

        if (Object.prototype.hasOwnProperty.call(req.body, "requestEvidence")) {
          throw createOvertimeEvidenceUploadError({
            message: "Overtime evidence references must be generated from uploaded files.",
            code: "OVERTIME_EVIDENCE_REFERENCE_NOT_ALLOWED",
          });
        }

        parseOvertimeCheckoutLocation(req);

        const manifest = parseOvertimeEvidenceManifest(
          req.body.overtimeEvidenceManifest,
          files.length
        );

        if (files.length > 0 && req.body.lateCheckoutOption !== "overtime_requested") {
          throw createOvertimeEvidenceUploadError({
            message: "Supporting evidence may only be uploaded with an overtime request.",
            code: "OVERTIME_EVIDENCE_WITHOUT_OVERTIME_REQUEST",
          });
        }

        const validatedFiles = files.map((file, index) => {
          const format = validateOvertimeEvidenceBuffer(file);

          validateOvertimeEvidenceFileCategory(file, manifest[index], index);

          return {
            file,
            ...format,
          };
        });

        if (validatedFiles.length > 0) {
          const occurrenceId = getOvertimeEvidenceOccurrenceId(req);

          for (let index = 0; index < validatedFiles.length; index += 1) {
            const { file, extension, mimeType } = validatedFiles[index];

            const storedFile = await UploadStorageService.storePrivateFile({
              category: "occurrence_evidence",
              ownerId: occurrenceId,
              buffer: file.buffer,
              fileName: normalizeOriginalFileName(file.originalname),
              mimeType,
              extension,
            });

            storedFiles.push(storedFile);

            req.professionalOvertimeEvidenceUploads.push({
              type: manifest[index].type,
              reference: storedFile.fileUrl,
              description: manifest[index].description,
              fileName: storedFile.fileName,
              mimeType: storedFile.mimeType,
              fileSizeBytes: storedFile.fileSizeBytes,
            });
          }
        }

        req.body.requestEvidence = req.professionalOvertimeEvidenceUploads.map((item) => ({
          type: item.type,
          reference: item.reference,
          description: item.description,
        }));

        delete req.body.overtimeEvidenceManifest;

        attachOvertimeEvidenceCleanupOnFailure(res, cleanup);

        return next();
      } catch (error) {
        try {
          await cleanup();
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
        }

        return next(error);
      }
    }
  );
};
