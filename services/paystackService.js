// services/paystackService.js

const axios = require("axios");

class PaystackService {
  static baseUrl = "https://api.paystack.co";

  static getHeaders() {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured.");
    }

    return {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    };
  }

  static async assignDedicatedVirtualAccount({
    email,
    firstName,
    lastName,
    phone,
    preferredBank,
    metadata = {},
  }) {
    try {
      const payload = {
        email,
        first_name: firstName,
        last_name: lastName,
        phone,
        preferred_bank: preferredBank || process.env.PAYSTACK_DVA_PREFERRED_BANK,
        country: "NG",
        metadata,
      };

      if (!payload.preferred_bank) {
        throw new Error("PAYSTACK_DVA_PREFERRED_BANK is not configured.");
      }

      const response = await axios.post(
        `${PaystackService.baseUrl}/dedicated_account/assign`,
        payload,
        {
          headers: PaystackService.getHeaders(),
        }
      );

      if (!response.data || response.data.status !== true) {
        throw new Error(response.data?.message || "Paystack DVA assignment failed.");
      }

      return response.data.data;
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.message ||
        "Unable to assign Paystack dedicated virtual account.";

      throw new Error(message);
    }
  }
}

module.exports = PaystackService;
