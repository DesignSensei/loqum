// middleware/errorHandler.js

const logger = require("../utils/logger");

// ───────────────────── HELPERS ─────────────────────

function wantsJSON(req) {
  const accept = req.get("Accept") || "";

  return req.xhr || Boolean(req.is("application/json")) || accept.includes("application/json");
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function getPublicErrorCode(error, statusCode) {
  // Internal server error codes must not be exposed to clients.
  if (statusCode < 400 || statusCode >= 500) {
    return null;
  }

  const code = error?.code;

  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
    return null;
  }

  return code;
}

// ───────────────────── NOT FOUND ─────────────────────

function notFoundHandler(req, res) {
  if (wantsJSON(req)) {
    return res.status(404).json({
      success: false,
      message: "The requested resource was not found.",
      code: "RESOURCE_NOT_FOUND",
    });
  }

  return res.status(404).render("errors/not-found", {
    layout: "layouts/error-layout",
    title: "Not Found",
    wfPage: "66b93fd9c65755b8a91df18e",
  });
}

// ───────────────────── GLOBAL ERROR HANDLING ─────────────────────

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const isCSRFError = err?.code === "EBADCSRFTOKEN";

  const requestedStatusCode = Number(err?.statusCode);

  const statusCode = isCSRFError
    ? 403
    : Number.isInteger(requestedStatusCode) &&
        requestedStatusCode >= 400 &&
        requestedStatusCode <= 599
      ? requestedStatusCode
      : 500;

  setNoStoreHeaders(res);

  // ───────────────── CSRF ERRORS ─────────────────

  if (isCSRFError) {
    const message =
      "Session expired or security token invalid. Please refresh the page and try again.";

    if (wantsJSON(req)) {
      return res.status(403).json({
        success: false,
        message,
        code: "INVALID_CSRF_TOKEN",
      });
    }

    return res.status(403).render("errors/error", {
      layout: "layouts/error-layout",
      title: "Session Expired",
      message,
      wfPage: "66b93fd9c65755b8a91df18e",
    });
  }

  // ───────────────── NOT FOUND ERRORS ─────────────────

  if (statusCode === 404) {
    if (wantsJSON(req)) {
      return res.status(404).json({
        success: false,
        message: "The requested resource was not found.",
        code: "RESOURCE_NOT_FOUND",
      });
    }

    return res.status(404).render("errors/not-found", {
      layout: "layouts/error-layout",
      title: "Not Found",
      wfPage: "66b93fd9c65755b8a91df18e",
    });
  }

  // ───────────────── ERROR LOGGING ─────────────────

  if (statusCode >= 500) {
    logger.error(
      `[${statusCode}] ${req.method} ${req.path} :: ${
        err?.message || "Unexpected error"
      }\n${err?.stack || ""}`
    );
  } else {
    logger.warn(
      `[${statusCode}] ${req.method} ${req.path} :: ${
        err?.code || "REQUEST_REJECTED"
      } - ${err?.message || "Request rejected"}`
    );
  }

  // ───────────────── PUBLIC ERROR MESSAGE ─────────────────

  const message =
    statusCode >= 500
      ? "Something went wrong. Please try again."
      : err?.message || "Unable to complete the request.";

  // ───────────────── JSON ERROR RESPONSE ─────────────────

  if (wantsJSON(req)) {
    const publicErrorCode = getPublicErrorCode(err, statusCode);

    return res.status(statusCode).json({
      success: false,
      message,

      ...(publicErrorCode ? { code: publicErrorCode } : {}),
    });
  }

  // ───────────────── HTML ERROR RESPONSE ─────────────────

  return res.status(statusCode).render("errors/error", {
    layout: "layouts/error-layout",
    title: "Error",
    message,
    wfPage: "66b93fd9c65755b8a91df18e",
  });
}

// ───────────────────── EXPORTS ─────────────────────

module.exports = {
  notFoundHandler,
  errorHandler,
};
