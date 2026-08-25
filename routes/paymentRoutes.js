// routes/paymentRoutes.js

const express = require("express");
const router = express.Router();

const paymentController = require("../controllers/paymentController");

//─────────────────────────────── PAYSTACK CALLBACK ROUTES ───────────────────────────────//

/*
 * Public browser callback used after an employer completes Paystack Checkout for shift funding.
 *
 * The callback reference is not treated as proof of payment.
 * The controller verifies the transaction directly with Paystack before
 * escrow is credited and the shift is published.
 */
router.get("/paystack/shift-callback", paymentController.handleShiftCheckoutCallback);

module.exports = router;
