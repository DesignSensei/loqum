// services/paystackService.js

const axios = require("axios");

class PaystackService {
  static baseUrl = "https://api.paystack.co";

  /* ---------- Get Paystack secret key ---------- */
  static getSecretKey() {
    return String(process.env.PAYSTACK_SECRET_KEY || "").trim();
  }

  /* ---------- Get Paystack mode ---------- */
  static getMode() {
    const secretKey = PaystackService.getSecretKey();

    if (secretKey.startsWith("sk_test_")) {
      return "test";
    }

    if (secretKey.startsWith("sk_live_")) {
      return "live";
    }

    return "none";
  }

  /* ---------- Check if Paystack is configured ---------- */
  static hasSecretKey() {
    return PaystackService.getMode() !== "none";
  }

  /* ---------- Check if current key is test key ---------- */
  static isTestMode() {
    return PaystackService.getMode() === "test";
  }

  /* ---------- Check if current key is live key ---------- */
  static isLiveMode() {
    return PaystackService.getMode() === "live";
  }

  /* ---------- Clean string value ---------- */
  static cleanString(value) {
    const cleaned = String(value || "").trim();

    return cleaned || null;
  }

  /* ---------- Clean phone value ---------- */
  static cleanPhone(value) {
    const cleaned = String(value || "")
      .replace(/\s+/g, "")
      .trim();

    return cleaned || null;
  }

  /* ---------- Get Paystack headers ---------- */
  static getHeaders() {
    const secretKey = PaystackService.getSecretKey();

    if (!secretKey) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured.");
    }

    return {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    };
  }

  /* ---------- Get preferred DVA provider ---------- */
  static getPreferredDVABank(preferredBank = null) {
    if (PaystackService.isTestMode()) {
      return "test-bank";
    }

    const cleanPreferredBank = PaystackService.cleanString(preferredBank);

    if (cleanPreferredBank) {
      return cleanPreferredBank.toLowerCase();
    }

    const envPreferredBank = PaystackService.cleanString(process.env.PAYSTACK_DVA_PREFERRED_BANK);

    if (!envPreferredBank) {
      throw new Error("PAYSTACK_DVA_PREFERRED_BANK is not configured.");
    }

    return envPreferredBank.toLowerCase();
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
    const cleanEmail = PaystackService.cleanString(email);
    const cleanFirstName = PaystackService.cleanString(firstName);
    const cleanLastName = PaystackService.cleanString(lastName);
    const cleanPhone = PaystackService.cleanPhone(phone);

    if (!cleanEmail) {
      throw new Error("Email is required for Paystack DVA assignment.");
    }

    if (!cleanFirstName) {
      throw new Error("First name is required for Paystack DVA assignment.");
    }

    if (!cleanLastName) {
      throw new Error("Last name is required for Paystack DVA assignment.");
    }

    if (!cleanPhone) {
      throw new Error("Phone number is required for Paystack DVA assignment.");
    }

    const payload = {
      email: cleanEmail,
      first_name: cleanFirstName,
      last_name: cleanLastName,
      phone: cleanPhone,
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

  /* ---------- Fetch banks ---------- */
  static async fetchBanks({ country = "nigeria", currency = "NGN" } = {}) {
    const response = await PaystackService.request({
      method: "get",
      path: "/bank",
      params: {
        country,
        currency,
      },
    });

    return response.data;
  }

  /* ---------- Resolve bank account ---------- */
  static async resolveBankAccount({ accountNumber, bankCode }) {
    const cleanAccountNumber = String(accountNumber || "")
      .replace(/\s+/g, "")
      .trim();

    const cleanBankCode = String(bankCode || "").trim();

    if (!cleanAccountNumber) {
      throw new Error("Account number is required.");
    }

    if (!cleanBankCode) {
      throw new Error("Bank is required.");
    }

    const response = await PaystackService.request({
      method: "get",
      path: "/bank/resolve",
      params: {
        account_number: cleanAccountNumber,
        bank_code: cleanBankCode,
      },
    });

    return response.data;
  }
}

module.exports = PaystackService;
