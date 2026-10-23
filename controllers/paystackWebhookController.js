// controllers/paystackWebhookController.js

const PaystackWebhookService = require("../services/paystackWebhookService");
const logger = require("../utils/logger");

exports.handleWebhook = async (req, res) => {
  try {
    const rawBody = req.rawBody;

    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).json({
        success: false,
        message: "Invalid webhook request body.",
      });
    }

    // Authenticate the original request bytes before parsing JSON.
    const signatureValid = PaystackWebhookService.verifySignature({
      rawBody,
      rawHeaders: req.headers,
    });

    if (!signatureValid) {
      logger.warn("Rejected unverified Paystack webhook.");

      return res.status(401).json({
        success: false,
        message: "Webhook verification failed.",
      });
    }

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (_) {
      return res.status(400).json({
        success: false,
        message: "Invalid webhook JSON payload.",
      });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({
        success: false,
        message: "Invalid webhook payload.",
      });
    }

    // The service independently verifies the signature before recording.
    const result = await PaystackWebhookService.recordPaystackWebhookEvent({
      payload,
      rawBody,
      rawHeaders: req.headers,

      // Background processing remains the intended architecture.
      processImmediately: false,

      currentTime: new Date(),
    });

    if (result.isVerified !== true) {
      logger.warn("Paystack webhook service rejected verification.");

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

    // Do not acknowledge a duplicate legacy event that remains unverified.
    if (result.providerEvent.isVerified !== true) {
      logger.error("Paystack webhook requires event reconciliation.", {
        providerEventId: String(result.providerEvent._id),
      });

      return res.status(503).json({
        success: false,
        message: "Webhook requires reconciliation.",
      });
    }

    // Acknowledge only after verified, durable recording.
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
    });

    const statusCode =
      Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode
        : 500;

    return res.status(statusCode).json({
      success: false,
      message: "Webhook could not be processed.",
    });
  }
};
