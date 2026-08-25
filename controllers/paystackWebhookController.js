// controllers/paystackWebhookController.js

const PaystackWebhookService = require("../services/paystackWebhookService");

const logger = require("../utils/logger");

exports.handleWebhook = async (req, res) => {
  try {
    const result = await PaystackWebhookService.recordPaystackWebhookEvent({
      payload: req.paystackPayload,

      rawBody: req.rawBody,

      rawHeaders: req.headers,

      processImmediately: true,

      currentTime: new Date(),
    });

    /*
     * SECURITY:
     *
     * paystackWebhookService verifies the Paystack
     * signature before recording a ProviderEvent.
     *
     * An invalid request must not be reported as a
     * successfully accepted Paystack event.
     *
     * Returning a non-200 response also means a real
     * Paystack event affected by a temporary signature/
     * configuration problem is not silently discarded.
     */
    if (!result.isVerified) {
      logger.warn("Rejected unverified Paystack webhook.", {
        reason: result.skippedProcessingReason || "Invalid Paystack webhook signature.",
      });

      return res.status(401).json({
        success: false,
        message: "Webhook verification failed.",
      });
    }

    /*
     * At this point the verified provider event has
     * been durably recorded.
     *
     * Some event categories may intentionally not be
     * processed immediately during a staged deployment.
     * That is still a successful webhook receipt and
     * must not cause unnecessary Paystack redelivery.
     */
    return res.status(200).json({
      success: true,
      message: "Webhook received.",
    });
  } catch (error) {
    logger.error("Paystack webhook error:", {
      name: error.name,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      stack: error.stack,
    });

    /*
     * Do not return internal/provider details to the
     * webhook caller.
     *
     * A non-200 response is deliberate here:
     * if a verified Paystack event could not be safely
     * recorded or processed, Paystack should be allowed
     * to redeliver it.
     */
    return res
      .status(
        Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
          ? error.statusCode
          : 500
      )
      .json({
        success: false,
        message: "Webhook could not be processed.",
      });
  }
};
