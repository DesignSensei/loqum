// middleware/uploadMiddleware.js

const fs = require("fs");
const path = require("path");
const multer = require("multer");

const UploadStorageService = require("../services/storage/uploadStorageService");

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
