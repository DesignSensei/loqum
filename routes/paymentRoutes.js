// routes/paymentRoutes.js

const express = require("express");

const router = express.Router();

const paymentController = require("../controllers/paymentController");

/* ─────────────────────────────── PAYSTACK CALLBACKS ─────────────────────────────── */

// Shift Checkout callback.
router.get("/paystack/shift-callback", paymentController.handleShiftCheckoutCallback);

// PAYG Job publication callback.
router.get(
  "/paystack/job-publication-callback",
  paymentController.handleJobPublicationCheckoutCallback
);

// Subscription payment callback.
router.get("/paystack/subscription-callback", paymentController.handleSubscriptionCheckoutCallback);

module.exports = router;
