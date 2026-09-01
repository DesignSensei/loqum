// routes/paymentRoutes.js

const express = require("express");

const router = express.Router();

const paymentController = require("../controllers/paymentController");

/* ─────────────────────────────── PAYSTACK CALLBACK ─────────────────────────────── */

/*
 * Public browser callback after employer Shift Checkout.
 *
 * The callback reference is only an identifier. The controller verifies
 * the transaction directly with Paystack before ShiftFundingService
 * decides whether to fund the Shift or return the payment safely.
 */
router.get("/paystack/shift-callback", paymentController.handleShiftCheckoutCallback);

module.exports = router;
