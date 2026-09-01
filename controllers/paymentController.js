// controllers/paymentController.js

const ShiftFundingService = require("../services/shiftFundingService");

const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function cleanString(value) {
  const cleaned = String(value || "").trim();

  return cleaned || null;
}

function getPaystackReference(req) {
  return cleanString(req.query.reference || req.query.trxref);
}

function buildManageShiftsRedirect({
  paymentStatus,
  referenceCode = null,
  errorCode = null,
  alreadyFunded = false,
  returnedToEmployerWallet = false,
  returnReason = null,
}) {
  const params = new URLSearchParams();

  params.set("payment", paymentStatus);

  if (referenceCode) {
    params.set("shift", referenceCode);
  }

  if (errorCode) {
    params.set("paymentCode", errorCode);
  }

  if (alreadyFunded) {
    params.set("alreadyFunded", "true");
  }

  if (returnedToEmployerWallet) {
    params.set("returnedToWallet", "true");
  }

  if (returnReason) {
    params.set("returnReason", returnReason);
  }

  return `${EMPLOYER_SHIFTS_URL}?${params.toString()}`;
}

function getFailedPaymentRedirectStatus(error) {
  const paystackStatus = String(error?.details?.paystackStatus || "")
    .trim()
    .toLowerCase();

  const pendingStatuses = ["pending", "processing", "ongoing", "queued"];

  return pendingStatuses.includes(paystackStatus) ? "pending" : "failed";
}

/* ─────────────────────────────── PAYSTACK SHIFT CALLBACK ─────────────────────────────── */

exports.handleShiftCheckoutCallback = async (req, res) => {
  res.set("Cache-Control", "no-store");

  const reference = getPaystackReference(req);

  if (!reference) {
    logger.warn("Paystack shift callback received without a transaction reference.");

    return res.redirect(
      303,
      buildManageShiftsRedirect({
        paymentStatus: "failed",

        errorCode: "PAYSTACK_REFERENCE_REQUIRED",
      })
    );
  }

  try {
    /*
     * The callback query isn't trusted as proof of payment.
     *
     * finalizePaystackShiftFunding() verifies the payment
     * directly with Paystack, records successful money in
     * escrow, then funds the Shift or returns the payment
     * according to the authoritative Shift state.
     */
    const result = await ShiftFundingService.finalizePaystackShiftFunding({
      reference,
    });

    logger.info(
      `Paystack shift callback completed for ${result.shift.referenceCode} using reference ${reference}`
    );

    return res.redirect(
      303,
      buildManageShiftsRedirect({
        paymentStatus:
          result.fundingApplied === true
            ? "success"
            : result.returnedToEmployerWallet === true
              ? "returned"
              : "failed",

        referenceCode: result.shift.referenceCode,

        alreadyFunded: result.alreadyFunded === true,

        returnedToEmployerWallet: result.returnedToEmployerWallet === true,

        returnReason: result.returnReason || null,
      })
    );
  } catch (error) {
    const statusCode = error?.statusCode || 500;

    const errorCode = error?.code || "SHIFT_PAYSTACK_CALLBACK_FAILED";

    if (statusCode >= 500) {
      logger.error(`Paystack shift callback processing error for reference ${reference}:`, error);
    } else {
      logger.warn(
        `Paystack shift callback rejected for reference ${reference}: ${errorCode} - ${error.message}`
      );
    }

    return res.redirect(
      303,
      buildManageShiftsRedirect({
        paymentStatus: getFailedPaymentRedirectStatus(error),

        errorCode,
      })
    );
  }
};
