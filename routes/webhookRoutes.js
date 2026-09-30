// routes/webhookRoutes.js

const express = require("express");

const router = express.Router();

const paystackWebhookController = require("../controllers/paystackWebhookController");

const {
  paystackRawBodyParser,
  attachPaystackWebhookBody,
} = require("../middleware/paystackWebhookMiddleware");

/* ─────────────────────────────── PAYSTACK WEBHOOK ─────────────────────────────── */

// Public Paystack webhook endpoint with raw-body preservation.
router.post(
  "/paystack",
  paystackRawBodyParser,
  attachPaystackWebhookBody,
  paystackWebhookController.handleWebhook
);

module.exports = router;
