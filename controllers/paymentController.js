// controllers/paymentController.js

const ShiftFundingService = require("../services/shiftFundingService");
const JobPublicationPaymentService = require("../services/jobPublicationPaymentService");
const SubscriptionPaymentService = require("../services/subscriptionPaymentService");

const logger = require("../utils/logger");

const EMPLOYER_SHIFTS_URL = "/employer/shifts";
const EMPLOYER_BILLING_URL = "/employer/billing";

const SHIFT_FUNDING_PENDING_ERROR_CODES = new Set([
  "PAYSTACK_SHIFT_FUNDING_INTEGRITY_CONFLICT",
  "PAYSTACK_SHIFT_RECONCILIATION_REQUIRED",
  "SHIFT_FUNDING_APPLICATION_PENDING",
  "PAYSTACK_SHIFT_FUNDING_APPLICATION_PENDING",
  "PAYSTACK_FUNDING_APPLICATION_PENDING",
]);

const COMMERCIAL_PAYMENT_PENDING_ERROR_CODES = new Set([
  "JOB_PAYMENT_PAYSTACK_REVERSED_RECONCILIATION_REQUIRED",
  "SUBSCRIPTION_PAYMENT_PAYSTACK_REVERSED_RECONCILIATION_REQUIRED",
  "SUBSCRIPTION_PAYMENT_APPLICATION_FAILED",
  "SUBSCRIPTION_PAYMENT_RENEWAL_TARGET_MISMATCH",
  "PAID_RENEWAL_BLOCKED_BY_CANCELLATION",
]);

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function cleanString(value) {
  const cleaned = String(value || "").trim();

  return cleaned || null;
}

function getPaystackReference(req) {
  const { reference, trxref } = req.query || {};
  // Query arrays/objects must never be coerced into provider references.
  if ([reference, trxref].some((value) => value != null && typeof value !== "string")) {
    return null;
  }
  const primary = cleanString(reference);
  const alternate = cleanString(trxref);
  if (primary && alternate && primary !== alternate) {
    return null;
  }
  return primary || alternate;
}

function getPaystackStatus(error) {
  return String(error?.details?.paystackStatus || "")
    .trim()
    .toLowerCase();
}

function isPendingProviderStatus(value) {
  return ["pending", "processing", "ongoing", "queued"].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
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

function buildEmployerBillingRedirect({
  section,
  paymentStatus,
  errorCode = null,
  paymentKind = null,
  applicationStatus = null,
  applicationCode = null,
}) {
  const params = new URLSearchParams();

  params.set("payment", paymentStatus);

  if (section) {
    params.set("paymentFor", section);
  }

  if (errorCode) {
    params.set("paymentCode", errorCode);
  }

  if (paymentKind) {
    params.set("paymentKind", paymentKind);
  }

  if (applicationStatus) {
    params.set("application", applicationStatus);
  }

  if (applicationCode) {
    params.set("applicationCode", applicationCode);
  }

  const anchor = section === "job-publication" ? "job-publications" : "subscription";

  return `${EMPLOYER_BILLING_URL}?${params.toString()}#${anchor}`;
}

function getFailedPaymentRedirectStatus(error, pendingErrorCodes = null) {
  const errorCode = cleanString(error?.code);

  if (errorCode && pendingErrorCodes?.has(errorCode)) {
    return "pending";
  }

  return isPendingProviderStatus(getPaystackStatus(error)) ? "pending" : "failed";
}

function getCommercialPaymentRedirectStatus(error) {
  const code = cleanString(error?.code);
  if (COMMERCIAL_PAYMENT_PENDING_ERROR_CODES.has(code)) {
    return "pending";
  }

  // A failed verification request is not evidence of a failed payment.
  // Only terminal provider states or known local rejection states show failure.
  if (
    [
      "JOB_PAYMENT_PAYSTACK_NOT_SUCCESSFUL",
      "SUBSCRIPTION_PAYMENT_PAYSTACK_NOT_SUCCESSFUL",
      "SUBSCRIPTION_PAYMENT_PAYSTACK_FAILED",
    ].includes(code) &&
    ["failed", "abandoned"].includes(getPaystackStatus(error))
  ) {
    return "failed";
  }
  if (
    [
      "JOB_PAYMENT_NOT_FOUND",
      "SUBSCRIPTION_PAYMENT_NOT_FOUND",
      "JOB_PAYMENT_ATTEMPT_CLOSED",
      "SUBSCRIPTION_PAYMENT_ATTEMPT_CLOSED",
      "JOB_PAYMENT_ALREADY_REFUNDED",
      "SUBSCRIPTION_PAYMENT_ALREADY_REFUNDED",
      "JOB_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
      "SUBSCRIPTION_PAYMENT_PROVIDER_REFERENCE_REQUIRED",
      "PAYSTACK_TRANSACTION_REFERENCE_REQUIRED",
      "INVALID_PAYSTACK_TRANSACTION_REFERENCE",
      "PAYSTACK_TRANSACTION_REFERENCE_TOO_LONG",
    ].includes(code)
  ) {
    return "failed";
  }
  return "pending";
}

function getSubscriptionPaymentKind(result) {
  return cleanString(result?.payment?.paymentKind);
}

function resolveSubscriptionCallbackState(result) {
  const paymentKind = getSubscriptionPaymentKind(result);

  if (result?.applicationError) {
    return {
      paymentStatus: "pending",
      paymentKind,
      applicationStatus: "pending",
      applicationCode: result.applicationError.code || "SUBSCRIPTION_PAYMENT_APPLICATION_FAILED",
    };
  }

  if (result?.paid !== true) {
    return {
      paymentStatus: "pending",
      paymentKind,
      applicationStatus: null,
      applicationCode: null,
    };
  }

  if (result?.applied === true) {
    return {
      paymentStatus: "success",
      paymentKind,
      applicationStatus: "applied",
      applicationCode: null,
    };
  }

  /*
   * A paid early renewal is expected to remain unapplied until periodStart.
   * This is a successful payment, not a failed lifecycle application.
   */
  if (paymentKind === "renewal" && result?.application?.reason === "billing_period_not_started") {
    return {
      paymentStatus: "success",
      paymentKind,
      applicationStatus: "scheduled",
      applicationCode: null,
    };
  }

  /*
   * Initial purchases and plan changes normally apply immediately.
   *
   * If money is confirmed but lifecycle application is not yet complete,
   * surface the state as pending/reconciliation rather than incorrectly
   * reporting payment failure.
   */
  return {
    paymentStatus: "pending",
    paymentKind,
    applicationStatus: "pending",
    applicationCode: "SUBSCRIPTION_PAYMENT_APPLICATION_PENDING",
  };
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
        paymentStatus: getFailedPaymentRedirectStatus(error, SHIFT_FUNDING_PENDING_ERROR_CODES),

        errorCode,
      })
    );
  }
};

/* ─────────────────────────────── PAYSTACK JOB PUBLICATION CALLBACK ─────────────────────────────── */

exports.handleJobPublicationCheckoutCallback = async (req, res) => {
  res.set("Cache-Control", "no-store");

  const reference = getPaystackReference(req);

  if (!reference) {
    logger.warn("Paystack Job publication callback received without a transaction reference.");

    return res.redirect(
      303,
      buildEmployerBillingRedirect({
        section: "job-publication",

        paymentStatus: "failed",

        errorCode: "PAYSTACK_REFERENCE_REQUIRED",
      })
    );
  }

  try {
    /*
     * The callback query is not proof of payment.
     *
     * JobPublicationPaymentService verifies the transaction directly
     * with Paystack before completing the platform-wallet credit and
     * marking the PAYG JobPayment paid.
     */
    const result = await JobPublicationPaymentService.finalizePaystackPayment({
      reference,

      currentTime: new Date(),
    });

    logger.info(`Paystack Job publication callback completed for reference ${reference}`);

    return res.redirect(
      303,
      buildEmployerBillingRedirect({
        section: "job-publication",

        paymentStatus: result.paid === true ? "success" : "pending",
      })
    );
  } catch (error) {
    const statusCode = error?.statusCode || 500;

    const errorCode = error?.code || "JOB_PUBLICATION_PAYSTACK_CALLBACK_FAILED";

    if (statusCode >= 500) {
      logger.error(
        `Paystack Job publication callback processing error for reference ${reference}:`,
        error
      );
    } else {
      logger.warn(
        `Paystack Job publication callback rejected for reference ${reference}: ${errorCode} - ${error.message}`
      );
    }

    return res.redirect(
      303,
      buildEmployerBillingRedirect({
        section: "job-publication",

        paymentStatus: getCommercialPaymentRedirectStatus(error),

        errorCode,
      })
    );
  }
};

/* ─────────────────────────────── PAYSTACK SUBSCRIPTION CALLBACK ─────────────────────────────── */

exports.handleSubscriptionCheckoutCallback = async (req, res) => {
  res.set("Cache-Control", "no-store");

  const reference = getPaystackReference(req);

  if (!reference) {
    logger.warn("Paystack subscription callback received without a transaction reference.");

    return res.redirect(
      303,
      buildEmployerBillingRedirect({
        section: "subscription",

        paymentStatus: "failed",

        errorCode: "PAYSTACK_REFERENCE_REQUIRED",
      })
    );
  }

  try {
    /*
     * The callback query is not proof of payment.
     *
     * SubscriptionPaymentService verifies directly with Paystack,
     * completes the canonical platform-wallet receipt and then applies
     * the appropriate lifecycle action:
     *
     * initial_purchase
     * -> activates the Subscription immediately.
     *
     * plan_change
     * -> replaces the current plan immediately.
     *
     * renewal
     * -> applies at the billing boundary, or remains safely
     *    paid/unapplied when purchased early.
     */
    const result = await SubscriptionPaymentService.finalizePaystackPayment({
      reference,

      currentTime: new Date(),
    });

    const callbackState = resolveSubscriptionCallbackState(result);

    logger.info(
      `Paystack subscription callback completed for reference ${reference}` +
        `${callbackState.paymentKind ? ` (${callbackState.paymentKind})` : ""}`
    );

    return res.redirect(
      303,
      buildEmployerBillingRedirect({
        section: "subscription",

        paymentStatus: callbackState.paymentStatus,

        paymentKind: callbackState.paymentKind,

        applicationStatus: callbackState.applicationStatus,

        applicationCode: callbackState.applicationCode,
      })
    );
  } catch (error) {
    const statusCode = error?.statusCode || 500;

    const errorCode = error?.code || "SUBSCRIPTION_PAYSTACK_CALLBACK_FAILED";

    if (statusCode >= 500) {
      logger.error(
        `Paystack subscription callback processing error for reference ${reference}:`,
        error
      );
    } else {
      logger.warn(
        `Paystack subscription callback rejected for reference ${reference}: ${errorCode} - ${error.message}`
      );
    }

    return res.redirect(
      303,
      buildEmployerBillingRedirect({
        section: "subscription",

        paymentStatus: getCommercialPaymentRedirectStatus(error),

        errorCode,
      })
    );
  }
};
