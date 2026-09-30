// controllers/paystackWebhookController.js

const PaystackWebhookService = require("../services/paystackWebhookService");

const logger = require("../utils/logger");

exports.handleWebhook = async (req, res) => {
  try {
    const result = await PaystackWebhookService.recordPaystackWebhookEvent({
      payload: req.paystackPayload,

      rawBody: req.rawBody,

      rawHeaders: req.headers,

      // Acknowledge after recording; the recovery scheduler owns dispatch.
      processImmediately: false,

      currentTime: new Date(),
    });

    // Reject unverified webhook requests.
    if (result.isVerified !== true) {
      logger.warn("Rejected unverified Paystack webhook.", {
        reason: result.skippedProcessingReason || "Invalid Paystack webhook signature.",
      });

      return res.status(401).json({
        success: false,
        message: "Webhook verification failed.",
      });
    }

    if (result.recorded !== true || !result.providerEvent?._id) {
      const error = new Error("Webhook recording did not confirm a persisted event.");
      error.code = "PAYSTACK_WEBHOOK_RECORDING_NOT_CONFIRMED";
      throw error;
    }

    // Verified event has been durably recorded, including duplicate deliveries.
    // Deploy with received-event recovery enabled in ProviderEventRetryScheduler.
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

    // Non-200 is reserved for verification or recording failure.
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
