// middleware/paystackWebhookMiddleware.js

const express = require("express");

/*
  Paystack needs the original raw request body for signature verification.

  This middleware:
  1. Reads the webhook body as a raw Buffer.
  2. Stores that Buffer on req.rawBody.
  3. Parses the Buffer into req.paystackPayload for the controller/service.
*/

exports.paystackRawBodyParser = express.raw({
  type: "application/json",
  limit: "1mb",
});

exports.attachPaystackWebhookBody = (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      const error = new Error("Paystack webhook raw body is unavailable.");
      error.statusCode = 400;
      throw error;
    }

    req.rawBody = req.body;

    const rawBodyString = req.body.toString("utf8");

    req.paystackPayload = rawBodyString ? JSON.parse(rawBodyString) : {};

    return next();
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    return next(error);
  }
};
