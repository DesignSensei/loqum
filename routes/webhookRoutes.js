// routes/webhookRoutes.js

const express = require("express");

const router = express.Router();

const paystackWebhookController = require("../controllers/paystackWebhookController");

const {
  paystackRawBodyParser,
  attachPaystackWebhookBody,
} = require("../middleware/paystackWebhookMiddleware");

/* ─────────────────────────────── PAYSTACK WEBHOOK ─────────────────────────────── */

/*
 * Public provider endpoint for Paystack webhook delivery.
 *
 * The raw request body must be preserved before normal body parsing because
 * Paystack signature verification depends on the exact bytes received.
 *
 * attachPaystackWebhookBody prepares the verified webhook payload consumed
 * by the controller. The controller then delegates durable recording and
 * ProviderEvent processing to the Paystack webhook service.
 *
 * User authentication middleware is deliberately not used here because
 * Paystack, not an authenticated Loqum user, is the caller.
 */
router.post(
  "/paystack",
  paystackRawBodyParser,
  attachPaystackWebhookBody,
  paystackWebhookController.handleWebhook
);

module.exports = router;
