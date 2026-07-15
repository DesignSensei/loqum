// controllers/paystackWebhookController.js

const PaystackWebhookService = require("../services/paystackWebhookService");
const logger = require("../utils/logger");

exports.handleWebhook = async (req, res) => {
  try {
    await PaystackWebhookService.recordPaystackWebhookEvent({
      payload: req.paystackPayload,
      rawBody: req.rawBody,
      rawHeaders: req.headers,
      processImmediately: true,
    });

    return res.status(200).json({
      success: true,
      message: "Webhook received.",
    });
  } catch (error) {
    logger.error("Paystack webhook error:", error);

    return res.status(error.statusCode || 400).json({
      success: false,
      message: "Webhook could not be processed.",
    });
  }
};
