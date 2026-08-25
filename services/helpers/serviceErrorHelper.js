// services/helpers/serviceErrorHelper.js

exports.createServiceError = function createServiceError({
  name = "ServiceError",
  message,
  code,
  statusCode = 400,
  details = null,
}) {
  const error = new Error(message);

  error.name = name;
  error.code = code;
  error.statusCode = statusCode;

  if (details && typeof details === "object" && !Array.isArray(details)) {
    error.details = details;
  }

  return error;
};
