// services/helpers/serviceErrorHelper.js

exports.createServiceError = function createServiceError({
  name = "ServiceError",
  message,
  code,
  statusCode = 400,
  details = null,
  retryable = null,
  cause = null,
}) {
  const error = new Error(message);

  error.name = name;
  error.code = code;
  error.statusCode = statusCode;

  if (details && typeof details === "object" && !Array.isArray(details)) {
    error.details = details;
  }

  if (typeof retryable === "boolean") {
    error.retryable = retryable;
  }

  if (cause !== null && cause !== undefined) {
    error.cause = cause;
  }

  return error;
};
