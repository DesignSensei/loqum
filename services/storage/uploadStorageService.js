// services/storage/uploadStorageService.js

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UPLOAD_STORAGE_SERVICE_ERROR_NAME = "UploadStorageServiceError";

const SUPPORTED_STORAGE_DRIVERS = Object.freeze(["local", "s3"]);
const PRIVATE_FILE_URL_PREFIX = "private://";

function createUploadStorageError({
  message,
  code,
  statusCode = 500,
  details = null,
  cause = null,
}) {
  const error = new Error(message);

  error.name = UPLOAD_STORAGE_SERVICE_ERROR_NAME;
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

function getStorageDriver() {
  const driver = String(process.env.FILE_STORAGE_DRIVER || "")
    .trim()
    .toLowerCase();

  if (!driver) {
    throw createUploadStorageError({
      message: "FILE_STORAGE_DRIVER is not configured.",
      code: "FILE_STORAGE_DRIVER_REQUIRED",
      statusCode: 500,
    });
  }

  if (!SUPPORTED_STORAGE_DRIVERS.includes(driver)) {
    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
      statusCode: 500,
      details: {
        supportedDrivers: [...SUPPORTED_STORAGE_DRIVERS],
      },
    });
  }

  return driver;
}

function getPrivateUploadRoot() {
  const configuredRoot = String(process.env.PRIVATE_UPLOAD_ROOT || "").trim();

  if (!configuredRoot) {
    throw createUploadStorageError({
      message: "PRIVATE_UPLOAD_ROOT is not configured for local private file storage.",
      code: "PRIVATE_UPLOAD_ROOT_REQUIRED",
      statusCode: 500,
    });
  }

  return path.isAbsolute(configuredRoot)
    ? path.normalize(configuredRoot)
    : path.resolve(process.cwd(), configuredRoot);
}

function normalizePathSegment(value, fieldName) {
  const normalized = String(value || "").trim();

  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw createUploadStorageError({
      message: `${fieldName} must contain only letters, numbers, underscores, or hyphens.`,
      code: "FILE_STORAGE_PATH_SEGMENT_INVALID",
      statusCode: 400,
      details: {
        fieldName,
      },
    });
  }

  return normalized;
}

function normalizeCategory(value) {
  return normalizePathSegment(String(value || "").toLowerCase(), "category");
}

function normalizeOwnerId(value) {
  return normalizePathSegment(value, "ownerId");
}

function normalizeFileName(value) {
  const fileName = path.basename(String(value || "").trim());

  if (!fileName) {
    throw createUploadStorageError({
      message: "A file name is required for storage.",
      code: "FILE_STORAGE_FILE_NAME_REQUIRED",
      statusCode: 400,
    });
  }

  return (
    fileName
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 255) || "file"
  );
}

function normalizeMimeType(value) {
  const mimeType = String(value || "")
    .trim()
    .toLowerCase();

  if (!mimeType || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)) {
    throw createUploadStorageError({
      message: "A valid MIME type is required for storage.",
      code: "FILE_STORAGE_MIME_TYPE_INVALID",
      statusCode: 400,
    });
  }

  return mimeType;
}

function normalizeBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw createUploadStorageError({
      message: "A non-empty file buffer is required for storage.",
      code: "FILE_STORAGE_BUFFER_REQUIRED",
      statusCode: 400,
    });
  }

  return value;
}

function normalizeExtension(value, fileName) {
  const candidate = String(value || path.extname(fileName || "") || "")
    .trim()
    .toLowerCase();

  if (!candidate) {
    return "";
  }

  const extension = candidate.startsWith(".") ? candidate : `.${candidate}`;

  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) {
    throw createUploadStorageError({
      message: "The file extension is invalid.",
      code: "FILE_STORAGE_EXTENSION_INVALID",
      statusCode: 400,
    });
  }

  return extension;
}

function buildStorageKey({ category, ownerId, extension }) {
  return [category, ownerId, `${crypto.randomUUID()}${extension}`].join("/");
}

function normalizeStorageKey(value) {
  let storageKey = String(value || "").trim();

  if (storageKey.startsWith(PRIVATE_FILE_URL_PREFIX)) {
    storageKey = storageKey.slice(PRIVATE_FILE_URL_PREFIX.length);
  }

  storageKey = storageKey.replace(/\\/g, "/");
  storageKey = path.posix.normalize(storageKey);

  if (
    !storageKey ||
    storageKey === "." ||
    storageKey.startsWith("../") ||
    path.posix.isAbsolute(storageKey)
  ) {
    throw createUploadStorageError({
      message: "Private file storage reference is invalid.",
      code: "PRIVATE_FILE_STORAGE_REFERENCE_INVALID",
      statusCode: 400,
    });
  }

  const segments = storageKey.split("/").filter(Boolean);

  if (segments.length < 3) {
    throw createUploadStorageError({
      message: "Private file storage reference is incomplete.",
      code: "PRIVATE_FILE_STORAGE_REFERENCE_INVALID",
      statusCode: 400,
    });
  }

  normalizeCategory(segments[0]);
  normalizeOwnerId(segments[1]);

  return storageKey;
}

function resolveLocalPrivatePath(storageKey) {
  const privateUploadRoot = getPrivateUploadRoot();
  const normalizedStorageKey = normalizeStorageKey(storageKey);
  const absolutePath = path.resolve(privateUploadRoot, normalizedStorageKey);
  const relativePath = path.relative(privateUploadRoot, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || relativePath === "") {
    throw createUploadStorageError({
      message: "Private file storage path is invalid.",
      code: "PRIVATE_FILE_STORAGE_PATH_INVALID",
      statusCode: 400,
    });
  }

  return absolutePath;
}

async function storePrivateFileLocally({
  category,
  ownerId,
  buffer,
  fileName,
  mimeType,
  extension,
}) {
  const storageKey = buildStorageKey({
    category,
    ownerId,
    extension,
  });

  const absolutePath = resolveLocalPrivatePath(storageKey);

  try {
    await fs.promises.mkdir(path.dirname(absolutePath), {
      recursive: true,
      mode: 0o700,
    });

    await fs.promises.writeFile(absolutePath, buffer, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw createUploadStorageError({
      message: "The private file could not be stored locally.",
      code: "LOCAL_PRIVATE_FILE_STORAGE_WRITE_FAILED",
      statusCode: 500,
      cause: error,
    });
  }

  return {
    driver: "local",
    visibility: "private",
    storageKey,
    fileUrl: `${PRIVATE_FILE_URL_PREFIX}${storageKey}`,
    fileName,
    mimeType,
    fileSizeBytes: buffer.length,
  };
}

async function deletePrivateFileLocally(storageKey) {
  const normalizedStorageKey = normalizeStorageKey(storageKey);
  const absolutePath = resolveLocalPrivatePath(normalizedStorageKey);

  try {
    await fs.promises.unlink(absolutePath);

    return {
      deleted: true,
      driver: "local",
      storageKey: normalizedStorageKey,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        deleted: false,
        driver: "local",
        storageKey: normalizedStorageKey,
      };
    }

    throw createUploadStorageError({
      message: "The private file could not be deleted from local storage.",
      code: "LOCAL_PRIVATE_FILE_STORAGE_DELETE_FAILED",
      statusCode: 500,
      cause: error,
    });
  }
}

function createS3NotConfiguredError() {
  return createUploadStorageError({
    message: "S3 file storage is selected but the S3 storage adapter has not been configured yet.",
    code: "S3_FILE_STORAGE_NOT_CONFIGURED",
    statusCode: 503,
  });
}

class UploadStorageService {
  static getConfiguredDriver() {
    return getStorageDriver();
  }

  static async storePrivateFile({
    category,
    ownerId,
    buffer,
    fileName,
    mimeType,
    extension = null,
  }) {
    const driver = getStorageDriver();
    const normalizedCategory = normalizeCategory(category);
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    const normalizedBuffer = normalizeBuffer(buffer);
    const normalizedFileName = normalizeFileName(fileName);
    const normalizedMimeType = normalizeMimeType(mimeType);
    const normalizedExtension = normalizeExtension(extension, normalizedFileName);

    const options = {
      category: normalizedCategory,
      ownerId: normalizedOwnerId,
      buffer: normalizedBuffer,
      fileName: normalizedFileName,
      mimeType: normalizedMimeType,
      extension: normalizedExtension,
    };

    if (driver === "local") {
      return storePrivateFileLocally(options);
    }

    if (driver === "s3") {
      throw createS3NotConfiguredError();
    }

    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
      statusCode: 500,
    });
  }

  static async deletePrivateFile({ storageKey = null, fileUrl = null } = {}) {
    const driver = getStorageDriver();
    const reference = storageKey || fileUrl;

    if (!reference) {
      return {
        deleted: false,
        driver,
        storageKey: null,
      };
    }

    const normalizedStorageKey = normalizeStorageKey(reference);

    if (driver === "local") {
      return deletePrivateFileLocally(normalizedStorageKey);
    }

    if (driver === "s3") {
      throw createS3NotConfiguredError();
    }

    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
      statusCode: 500,
    });
  }

  static createError(options) {
    return createUploadStorageError(options);
  }
}

module.exports = UploadStorageService;
