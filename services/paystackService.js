// services/paystackService.js

const axios = require("axios");

class PaystackService {
  static baseUrl = "https://api.paystack.co";

  /* ---------- Get Paystack headers ---------- */
  static getHeaders() {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured.");
    }

    return {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    };
  }

  /* ---------- Check if current key is test key ---------- */
  static isTestMode() {
    return String(process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_test_");
  }

  /* ---------- Get preferred DVA provider ---------- */
  static getPreferredDVABank(preferredBank = null) {
    if (PaystackService.isTestMode()) {
      return "test-bank";
    }

    if (preferredBank) {
      return String(preferredBank).trim().toLowerCase();
    }

    const envPreferredBank = process.env.PAYSTACK_DVA_PREFERRED_BANK;

    if (!envPreferredBank) {
      throw new Error("PAYSTACK_DVA_PREFERRED_BANK is not configured.");
    }

    return String(envPreferredBank).trim().toLowerCase();
  }

  /* ---------- Make Paystack request ---------- */
  static async request({ method, path, data = null, params = null }) {
    try {
      const response = await axios({
        method,
        url: `${PaystackService.baseUrl}${path}`,
        headers: PaystackService.getHeaders(),
        data,
        params,
        timeout: 30000,
      });

      if (!response.data || response.data.status !== true) {
        throw new Error(response.data?.message || "Paystack request failed.");
      }

      return response.data;
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Paystack request failed.";

      throw new Error(message);
    }
  }

  /* ---------- Assign dedicated virtual account ---------- */
  static async assignDedicatedVirtualAccount({
    email,
    firstName,
    lastName,
    phone,
    preferredBank = null,
    countryCode = "NG",
    metadata = {},
  }) {
    if (!email) {
      throw new Error("Email is required for Paystack DVA assignment.");
    }

    if (!firstName) {
      throw new Error("First name is required for Paystack DVA assignment.");
    }

    if (!lastName) {
      throw new Error("Last name is required for Paystack DVA assignment.");
    }

    if (!phone) {
      throw new Error("Phone number is required for Paystack DVA assignment.");
    }

    const payload = {
      email,
      first_name: firstName,
      last_name: lastName,
      phone,
      preferred_bank: PaystackService.getPreferredDVABank(preferredBank),
      country: String(countryCode || "NG")
        .toUpperCase()
        .trim(),
      metadata,
    };

    const response = await PaystackService.request({
      method: "post",
      path: "/dedicated_account/assign",
      data: payload,
    });

    return response.data;
  }

  /* ---------- Fetch DVA providers ---------- */
  static async fetchDedicatedAccountProviders() {
    const response = await PaystackService.request({
      method: "get",
      path: "/dedicated_account/available_providers",
    });

    return response.data;
  }
}

module.exports = PaystackService;
