// services/storage/uploadStorageService.js

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

// ───────────────────── CONSTANTS ─────────────────────

const ERROR_NAME = "UploadStorageServiceError";

const SUPPORTED_STORAGE_DRIVERS = Object.freeze(["local", "s3"]);

const PRIVATE_FILE_URL_PREFIX = "private://";

const PRIVATE_FILE_MIME_TYPES = Object.freeze({
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

let s3Client = null;
let s3ClientRegion = null;

// ───────────────────── ERRORS ─────────────────────

function createUploadStorageError({
  message,
  code,
  statusCode = 500,
  details = null,
  cause = null,
}) {
  const error = new Error(message);

  error.name = ERROR_NAME;
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

// ───────────────────── CONFIGURATION ─────────────────────

function getStorageDriver() {
  const driver = String(process.env.FILE_STORAGE_DRIVER || "")
    .trim()
    .toLowerCase();

  if (!driver) {
    throw createUploadStorageError({
      message: "FILE_STORAGE_DRIVER is not configured.",
      code: "FILE_STORAGE_DRIVER_REQUIRED",
    });
  }

  if (!SUPPORTED_STORAGE_DRIVERS.includes(driver)) {
    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
      details: {
        supportedDrivers: [...SUPPORTED_STORAGE_DRIVERS],
      },
    });
  }

  return driver;
}

function isPathWithin(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath);

  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function getPrivateUploadRoot() {
  const configuredRoot = String(process.env.PRIVATE_UPLOAD_ROOT || "").trim();

  if (!configuredRoot) {
    throw createUploadStorageError({
      message: "PRIVATE_UPLOAD_ROOT is not configured for local private file storage.",
      code: "PRIVATE_UPLOAD_ROOT_REQUIRED",
    });
  }

  const root = path.resolve(process.cwd(), configuredRoot);
  const publicRoot = path.resolve(__dirname, "..", "..", "public");

  const resolvedRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;

  const resolvedPublicRoot = fs.existsSync(publicRoot) ? fs.realpathSync(publicRoot) : publicRoot;

  if (isPathWithin(publicRoot, root) || isPathWithin(resolvedPublicRoot, resolvedRoot)) {
    throw createUploadStorageError({
      message: "Private uploads must be stored outside the public directory.",
      code: "PRIVATE_UPLOAD_ROOT_PUBLICLY_EXPOSED",
    });
  }

  return root;
}

function getS3Configuration() {
  const region = String(process.env.AWS_REGION || "").trim();

  const bucket = String(process.env.AWS_S3_PRIVATE_BUCKET || "").trim();

  if (!region) {
    throw createUploadStorageError({
      message: "AWS_REGION is not configured.",
      code: "AWS_REGION_REQUIRED",
    });
  }

  if (!bucket) {
    throw createUploadStorageError({
      message: "AWS_S3_PRIVATE_BUCKET is not configured.",
      code: "AWS_S3_PRIVATE_BUCKET_REQUIRED",
    });
  }

  return { region, bucket };
}

function getS3Client() {
  const { region } = getS3Configuration();

  if (!s3Client || s3ClientRegion !== region) {
    s3Client = new S3Client({ region });
    s3ClientRegion = region;
  }

  return s3Client;
}

// ───────────────────── NORMALIZATION ─────────────────────

function normalizePathSegment(value, fieldName) {
  const normalized = String(value || "").trim();

  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw createUploadStorageError({
      message: `${fieldName} must contain only letters, numbers, ` + "underscores, or hyphens.",
      code: "FILE_STORAGE_PATH_SEGMENT_INVALID",
      statusCode: 400,
      details: { fieldName },
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
  const fileName = path.basename(
    String(value || "")
      .trim()
      .replace(/\\/g, "/")
  );

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

// ───────────────────── STORAGE REFERENCES ─────────────────────

function buildStorageKey({ category, ownerId, extension }) {
  return [category, ownerId, `${crypto.randomUUID()}${extension}`].join("/");
}

function normalizeStorageKey(value) {
  let storageKey = String(value || "").trim();

  if (storageKey.startsWith(PRIVATE_FILE_URL_PREFIX)) {
    storageKey = storageKey.slice(PRIVATE_FILE_URL_PREFIX.length);
  }

  storageKey = storageKey.replace(/\\/g, "/");

  const segments = storageKey.split("/");

  if (
    segments.length !== 3 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw createUploadStorageError({
      message: "Private file storage reference is invalid.",
      code: "PRIVATE_FILE_STORAGE_REFERENCE_INVALID",
      statusCode: 400,
    });
  }

  normalizeCategory(segments[0]);
  normalizeOwnerId(segments[1]);

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[2])) {
    throw createUploadStorageError({
      message: "Private file storage filename is invalid.",
      code: "PRIVATE_FILE_STORAGE_REFERENCE_INVALID",
      statusCode: 400,
    });
  }

  return segments.join("/");
}

function assertPrivateFileScope({ storageKey, expectedCategory, expectedOwnerId }) {
  if (
    expectedCategory === undefined ||
    expectedCategory === null ||
    expectedOwnerId === undefined ||
    expectedOwnerId === null
  ) {
    throw createUploadStorageError({
      message: "An expected category and owner ID are required to open a private file.",
      code: "PRIVATE_FILE_SCOPE_REQUIRED",
    });
  }

  const normalizedKey = normalizeStorageKey(storageKey);

  const category = normalizeCategory(expectedCategory);
  const ownerId = normalizeOwnerId(expectedOwnerId);

  const segments = normalizedKey.split("/");

  if (segments[0] !== category || segments[1] !== ownerId) {
    throw createUploadStorageError({
      message: "The requested private file was not found.",
      code: "PRIVATE_FILE_NOT_FOUND",
      statusCode: 404,
    });
  }

  return normalizedKey;
}

// ───────────────────── FILE METADATA ─────────────────────

function getMimeTypeFromStorageKey(storageKey) {
  const extension = path.extname(storageKey).toLowerCase();

  return PRIVATE_FILE_MIME_TYPES[extension] || "application/octet-stream";
}

function normalizeStoredMimeType(value, storageKey) {
  const mimeType = String(value || "")
    .trim()
    .toLowerCase();

  const expectedMimeType = getMimeTypeFromStorageKey(storageKey);

  // Prefer known extension-based MIME types.
  if (expectedMimeType !== "application/octet-stream") {
    return expectedMimeType;
  }

  if (mimeType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)) {
    return mimeType;
  }

  return "application/octet-stream";
}

function normalizePrivateFileRange({ rangeStart, rangeEnd, fileSizeBytes }) {
  const start = rangeStart === null || rangeStart === undefined ? 0 : Number(rangeStart);

  const end = rangeEnd === null || rangeEnd === undefined ? fileSizeBytes - 1 : Number(rangeEnd);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= fileSizeBytes
  ) {
    throw createUploadStorageError({
      message: "The requested file range is invalid.",
      code: "PRIVATE_FILE_RANGE_INVALID",
      statusCode: 416,
      details: { fileSizeBytes },
    });
  }

  return {
    start,
    end,
    partial: start !== 0 || end !== fileSizeBytes - 1,
    contentLength: end - start + 1,
  };
}

function createPrivateFileResponse({ driver, storageKey, fileSizeBytes, mimeType, range, stream }) {
  return {
    driver,
    visibility: "private",
    storageKey,
    fileUrl: `${PRIVATE_FILE_URL_PREFIX}${storageKey}`,
    fileName: path.basename(storageKey),
    mimeType,
    fileSizeBytes,
    contentLength: range.contentLength,
    partial: range.partial,

    range: range.partial
      ? {
          start: range.start,
          end: range.end,
          total: fileSizeBytes,
        }
      : null,

    stream,
  };
}

// ───────────────────── LOCAL STORAGE ─────────────────────

function resolveLocalPrivatePath(storageKey) {
  const root = getPrivateUploadRoot();
  const normalizedKey = normalizeStorageKey(storageKey);
  const absolutePath = path.resolve(root, normalizedKey);

  if (absolutePath === root || !isPathWithin(root, absolutePath)) {
    throw createUploadStorageError({
      message: "Private file storage path is invalid.",
      code: "PRIVATE_FILE_STORAGE_PATH_INVALID",
      statusCode: 400,
    });
  }

  return absolutePath;
}

async function assertSafeLocalDirectories(storageKey) {
  const root = getPrivateUploadRoot();
  const segments = normalizeStorageKey(storageKey).split("/");

  const directories = [
    root,
    path.join(root, segments[0]),
    path.join(root, segments[0], segments[1]),
  ];

  for (const directory of directories) {
    let stats;

    try {
      stats = await fs.promises.lstat(directory);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw createUploadStorageError({
          message: "The requested private file was not found.",
          code: "PRIVATE_FILE_NOT_FOUND",
          statusCode: 404,
        });
      }

      throw error;
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw createUploadStorageError({
        message: "The private storage directory is invalid.",
        code: "PRIVATE_FILE_DIRECTORY_INVALID",
      });
    }
  }
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

    await assertSafeLocalDirectories(storageKey);

    await fs.promises.writeFile(absolutePath, buffer, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw createUploadStorageError({
      message: "The private file could not be stored locally.",
      code: "LOCAL_PRIVATE_FILE_STORAGE_WRITE_FAILED",
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

async function openPrivateFileLocally({
  storageKey,
  expectedCategory,
  expectedOwnerId,
  rangeStart,
  rangeEnd,
}) {
  const scopedKey = assertPrivateFileScope({
    storageKey,
    expectedCategory,
    expectedOwnerId,
  });

  await assertSafeLocalDirectories(scopedKey);

  const absolutePath = resolveLocalPrivatePath(scopedKey);

  let handle = null;

  try {
    handle = await fs.promises.open(
      absolutePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );

    const stats = await handle.stat();

    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0) {
      throw createUploadStorageError({
        message: "The private file is invalid.",
        code: "PRIVATE_FILE_INVALID",
        statusCode: 404,
      });
    }

    const range = normalizePrivateFileRange({
      rangeStart,
      rangeEnd,
      fileSizeBytes: stats.size,
    });

    const stream = handle.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: true,
    });

    handle = null;

    return createPrivateFileResponse({
      driver: "local",
      storageKey: scopedKey,
      fileSizeBytes: stats.size,
      mimeType: getMimeTypeFromStorageKey(scopedKey),
      range,
      stream,
    });
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        // Preserve the original error.
      }
    }

    if (error?.name === ERROR_NAME) {
      throw error;
    }

    if (error?.code === "ENOENT" || error?.code === "ELOOP") {
      throw createUploadStorageError({
        message: "The requested private file was not found.",
        code: "PRIVATE_FILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    throw createUploadStorageError({
      message: "The private file could not be opened.",
      code: "LOCAL_PRIVATE_FILE_READ_FAILED",
      cause: error,
    });
  }
}

async function deletePrivateFileLocally(storageKey) {
  const normalizedKey = normalizeStorageKey(storageKey);
  const absolutePath = resolveLocalPrivatePath(normalizedKey);

  try {
    await assertSafeLocalDirectories(normalizedKey);
    await fs.promises.unlink(absolutePath);

    return {
      deleted: true,
      driver: "local",
      storageKey: normalizedKey,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "PRIVATE_FILE_NOT_FOUND") {
      return {
        deleted: false,
        driver: "local",
        storageKey: normalizedKey,
      };
    }

    throw createUploadStorageError({
      message: "The private file could not be deleted.",
      code: "LOCAL_PRIVATE_FILE_STORAGE_DELETE_FAILED",
      cause: error,
    });
  }
}

// ───────────────────── AMAZON S3 ─────────────────────

function isS3NotFoundError(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

function createS3Failure({ message, code, cause }) {
  return createUploadStorageError({
    message,
    code,
    statusCode: 503,
    cause,
  });
}

async function storePrivateFileInS3({ category, ownerId, buffer, fileName, mimeType, extension }) {
  const { bucket } = getS3Configuration();

  const storageKey = buildStorageKey({
    category,
    ownerId,
    extension,
  });

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: mimeType,

        // Bucket policy should also enforce private access.
        ServerSideEncryption: "AES256",

        Metadata: {
          originalfilename: fileName,
        },
      })
    );
  } catch (error) {
    throw createS3Failure({
      message: "The private file could not be stored in S3.",
      code: "S3_PRIVATE_FILE_STORAGE_WRITE_FAILED",
      cause: error,
    });
  }

  return {
    driver: "s3",
    visibility: "private",
    storageKey,
    fileUrl: `${PRIVATE_FILE_URL_PREFIX}${storageKey}`,
    fileName,
    mimeType,
    fileSizeBytes: buffer.length,
  };
}

async function openPrivateFileFromS3({
  storageKey,
  expectedCategory,
  expectedOwnerId,
  rangeStart,
  rangeEnd,
}) {
  const scopedKey = assertPrivateFileScope({
    storageKey,
    expectedCategory,
    expectedOwnerId,
  });

  const { bucket } = getS3Configuration();
  const client = getS3Client();

  let metadata;

  try {
    metadata = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: scopedKey,
      })
    );
  } catch (error) {
    if (isS3NotFoundError(error)) {
      throw createUploadStorageError({
        message: "The requested private file was not found.",
        code: "PRIVATE_FILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    throw createS3Failure({
      message: "The private file metadata could not be retrieved.",
      code: "S3_PRIVATE_FILE_METADATA_FAILED",
      cause: error,
    });
  }

  const fileSizeBytes = Number(metadata.ContentLength);

  if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) {
    throw createUploadStorageError({
      message: "The private file is invalid.",
      code: "PRIVATE_FILE_INVALID",
      statusCode: 404,
    });
  }

  const range = normalizePrivateFileRange({
    rangeStart,
    rangeEnd,
    fileSizeBytes,
  });

  const hasRequestedRange =
    (rangeStart !== null && rangeStart !== undefined) ||
    (rangeEnd !== null && rangeEnd !== undefined);

  let response;

  try {
    response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: scopedKey,

        ...(hasRequestedRange
          ? {
              Range: `bytes=${range.start}-${range.end}`,
            }
          : {}),
      })
    );
  } catch (error) {
    if (isS3NotFoundError(error)) {
      throw createUploadStorageError({
        message: "The requested private file was not found.",
        code: "PRIVATE_FILE_NOT_FOUND",
        statusCode: 404,
      });
    }

    throw createS3Failure({
      message: "The private file could not be retrieved.",
      code: "S3_PRIVATE_FILE_READ_FAILED",
      cause: error,
    });
  }

  const stream = response.Body;

  if (!stream || typeof stream.pipe !== "function") {
    stream?.destroy?.();

    throw createS3Failure({
      message: "S3 did not return a readable file stream.",
      code: "S3_PRIVATE_FILE_STREAM_INVALID",
    });
  }

  // Verify the returned representation before streaming.
  const receivedLength = Number(response.ContentLength);

  const expectedLength = hasRequestedRange ? range.contentLength : fileSizeBytes;

  if (!Number.isSafeInteger(receivedLength) || receivedLength !== expectedLength) {
    stream.destroy();

    throw createS3Failure({
      message: "The private file changed during retrieval.",
      code: "S3_PRIVATE_FILE_LENGTH_MISMATCH",
    });
  }

  return {
    ...createPrivateFileResponse({
      driver: "s3",
      storageKey: scopedKey,
      fileSizeBytes,
      mimeType: normalizeStoredMimeType(response.ContentType || metadata.ContentType, scopedKey),
      range,
      stream,
    }),

    fileName: path.basename(scopedKey),
  };
}

async function deletePrivateFileFromS3(storageKey) {
  const normalizedKey = normalizeStorageKey(storageKey);
  const { bucket } = getS3Configuration();

  try {
    // S3 deletion is idempotent.
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: normalizedKey,
      })
    );

    return {
      deleted: true,
      driver: "s3",
      storageKey: normalizedKey,
    };
  } catch (error) {
    throw createS3Failure({
      message: "The private file could not be deleted from S3.",
      code: "S3_PRIVATE_FILE_STORAGE_DELETE_FAILED",
      cause: error,
    });
  }
}

// ───────────────────── STORAGE SERVICE ─────────────────────

class UploadStorageService {
  static getConfiguredDriver() {
    return getStorageDriver();
  }

  // ───────────────── PRIVATE UPLOAD ─────────────────

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
      return storePrivateFileInS3(options);
    }

    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
    });
  }

  // ───────────────── PRIVATE RETRIEVAL ─────────────────

  static async openPrivateFile({
    storageKey = null,
    fileUrl = null,
    expectedCategory,
    expectedOwnerId,
    rangeStart = null,
    rangeEnd = null,
  } = {}) {
    // Callers must authorize access to the underlying resource.
    const driver = getStorageDriver();
    const reference = storageKey || fileUrl;

    if (!reference) {
      throw createUploadStorageError({
        message: "A private file reference is required.",
        code: "PRIVATE_FILE_REFERENCE_REQUIRED",
        statusCode: 400,
      });
    }

    const options = {
      storageKey: reference,
      expectedCategory,
      expectedOwnerId,
      rangeStart,
      rangeEnd,
    };

    if (driver === "local") {
      return openPrivateFileLocally(options);
    }

    if (driver === "s3") {
      return openPrivateFileFromS3(options);
    }

    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
    });
  }

  // ───────────────── PRIVATE DELETION ─────────────────

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

    const normalizedKey = normalizeStorageKey(reference);

    if (driver === "local") {
      return deletePrivateFileLocally(normalizedKey);
    }

    if (driver === "s3") {
      return deletePrivateFileFromS3(normalizedKey);
    }

    throw createUploadStorageError({
      message: `Unsupported file storage driver: ${driver}.`,
      code: "FILE_STORAGE_DRIVER_UNSUPPORTED",
    });
  }

  // ───────────────── ERROR FACTORY ─────────────────

  static createError(options) {
    return createUploadStorageError(options);
  }
}

module.exports = UploadStorageService;
