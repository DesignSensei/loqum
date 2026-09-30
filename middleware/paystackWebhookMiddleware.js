// middleware/paystackWebhookMiddleware.js

const express = require("express");

// Hash the received bytes, not a parsed/re-serialized object. Reject compressed
// bodies rather than silently changing the bytes used for signature verification.
exports.paystackRawBodyParser = express.raw({
  type: "application/json",
  limit: "1mb",
  inflate: false,
});

exports.attachPaystackWebhookBody = function attachPaystackWebhookBody(req, res, next) {
  if (!Buffer.isBuffer(req.body)) {
    return res.status(415).json({
      success: false,
      message: "Paystack webhook requires an application/json request body.",
    });
  }

  req.rawBody = Buffer.from(req.body);
  // Parsing and shape validation happen in the service only after verification.
  return next();
};
