// services/paystackService.js

const axios = require("axios");

class PaystackService {
  static baseUrl = "https://api.paystack.co";

  static allowedTransactionChannels = [
    "card",
    "bank",
    "apple_pay",
    "ussd",
    "qr",
    "mobile_money",
    "bank_transfer",
    "eft",
    "capitec_pay",
    "payattitude",
  ];

  static supportedBankCountries = Object.freeze({
    NG: "nigeria",
    GH: "ghana",
    KE: "kenya",
    ZA: "south africa",
  });

  /* ─────────────────────────────── ERRORS ─────────────────────────────── */

  static createPaystackError({
    message,
    code = "PAYSTACK_REQUEST_FAILED",
    statusCode = 502,
    providerStatusCode = null,
    providerResponse = null,
  }) {
    const error = new Error(message);

    error.name = "PaystackServiceError";
    error.code = code;
    error.statusCode = statusCode;
    error.providerStatusCode = providerStatusCode;
    error.providerResponse = providerResponse;

    return error;
  }

  /* ─────────────────────────────── CONFIGURATION ─────────────────────────────── */

  static getSecretKey() {
    return String(process.env.PAYSTACK_SECRET_KEY || "").trim();
  }

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

  static hasSecretKey() {
    return PaystackService.getMode() !== "none";
  }

  static isTestMode() {
    return PaystackService.getMode() === "test";
  }

  static isLiveMode() {
    return PaystackService.getMode() === "live";
  }

  static assertConfigured() {
    if (!PaystackService.hasSecretKey()) {
      throw PaystackService.createPaystackError({
        message: "Paystack is not configured. Add a valid PAYSTACK_SECRET_KEY.",
        code: "PAYSTACK_NOT_CONFIGURED",
        statusCode: 503,
      });
    }

    return true;
  }

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    const cleaned = String(value || "").trim();

    return cleaned || null;
  }

  static cleanPhone(value) {
    const cleaned = String(value || "")
      .replace(/\s+/g, "")
      .trim();

    return cleaned || null;
  }

  static normalizeEmail(value) {
    const email = PaystackService.cleanString(value);

    if (!email) {
      throw PaystackService.createPaystackError({
        message: "Email is required for Paystack payment.",
        code: "PAYSTACK_EMAIL_REQUIRED",
        statusCode: 400,
      });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
      throw PaystackService.createPaystackError({
        message: "A valid email address is required for Paystack payment.",
        code: "INVALID_PAYSTACK_EMAIL",
        statusCode: 400,
      });
    }

    return email.toLowerCase();
  }

  static normalizeAmount(value) {
    const amount = Number(value);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw PaystackService.createPaystackError({
        message: "Paystack amount must be a positive whole number in minor units.",
        code: "INVALID_PAYSTACK_AMOUNT",
        statusCode: 400,
      });
    }

    return amount;
  }

  static normalizeOptionalAmount(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return PaystackService.normalizeAmount(value);
  }

  static normalizeCurrency(value, defaultCurrency = "NGN") {
    const currency = String(value || defaultCurrency)
      .trim()
      .toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw PaystackService.createPaystackError({
        message: "Paystack currency must be a valid three-letter currency code.",
        code: "INVALID_PAYSTACK_CURRENCY",
        statusCode: 400,
      });
    }

    return currency;
  }

  static normalizeOptionalCurrency(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return PaystackService.normalizeCurrency(value);
  }

  static normalizeReference(value) {
    const reference = PaystackService.cleanString(value);

    if (!reference) {
      throw PaystackService.createPaystackError({
        message: "A transaction reference is required.",
        code: "PAYSTACK_TRANSACTION_REFERENCE_REQUIRED",
        statusCode: 400,
      });
    }

    /*
     * Paystack transaction references may contain
     * alphanumeric characters and:
     * hyphen, period and equals sign.
     */
    if (!/^[A-Za-z0-9.=-]+$/.test(reference)) {
      throw PaystackService.createPaystackError({
        message: "The Paystack transaction reference contains unsupported characters.",
        code: "INVALID_PAYSTACK_TRANSACTION_REFERENCE",
        statusCode: 400,
      });
    }

    if (reference.length > 100) {
      throw PaystackService.createPaystackError({
        message: "The Paystack transaction reference is too long.",
        code: "PAYSTACK_TRANSACTION_REFERENCE_TOO_LONG",
        statusCode: 400,
      });
    }

    return reference;
  }

  static normalizeTransactionIdentifier(value) {
    const identifier = PaystackService.cleanString(value);

    if (!identifier) {
      throw PaystackService.createPaystackError({
        message: "A Paystack transaction ID or reference is required.",
        code: "PAYSTACK_TRANSACTION_IDENTIFIER_REQUIRED",
        statusCode: 400,
      });
    }

    if (/^\d+$/.test(identifier)) {
      return identifier;
    }

    return PaystackService.normalizeReference(identifier);
  }

  static normalizeRefundId(value) {
    const refundId = PaystackService.cleanString(value);

    if (!refundId || !/^\d+$/.test(refundId)) {
      throw PaystackService.createPaystackError({
        message: "A valid Paystack refund ID is required.",
        code: "INVALID_PAYSTACK_REFUND_ID",
        statusCode: 400,
      });
    }

    return refundId;
  }

  static normalizeCallbackUrl(value) {
    const callbackUrl = PaystackService.cleanString(value);

    if (!callbackUrl) {
      return null;
    }

    try {
      const parsedUrl = new URL(callbackUrl);

      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new Error("Unsupported callback protocol.");
      }

      return parsedUrl.toString();
    } catch {
      throw PaystackService.createPaystackError({
        message: "Paystack callback URL must be a fully qualified HTTP or HTTPS URL.",
        code: "INVALID_PAYSTACK_CALLBACK_URL",
        statusCode: 400,
      });
    }
  }

  static normalizeChannels(value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (!Array.isArray(value)) {
      throw PaystackService.createPaystackError({
        message: "Paystack payment channels must be provided as an array.",
        code: "INVALID_PAYSTACK_CHANNELS",
        statusCode: 400,
      });
    }

    const uniqueChannels = [
      ...new Set(
        value
          .map((channel) =>
            String(channel || "")
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      ),
    ];

    if (uniqueChannels.length === 0) {
      return null;
    }

    const invalidChannel = uniqueChannels.find(
      (channel) => !PaystackService.allowedTransactionChannels.includes(channel)
    );

    if (invalidChannel) {
      throw PaystackService.createPaystackError({
        message: `Unsupported Paystack payment channel: ${invalidChannel}.`,
        code: "UNSUPPORTED_PAYSTACK_CHANNEL",
        statusCode: 400,
      });
    }

    return uniqueChannels;
  }

  static normalizeMetadata(value) {
    if (value === null || value === undefined) {
      return {};
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw PaystackService.createPaystackError({
        message: "Paystack metadata must be an object.",
        code: "INVALID_PAYSTACK_METADATA",
        statusCode: 400,
      });
    }

    return value;
  }

  static normalizeOptionalNote(value, fieldName) {
    const note = PaystackService.cleanString(value);

    if (!note) {
      return null;
    }

    if (note.length > 1000) {
      throw PaystackService.createPaystackError({
        message: `${fieldName} is too long.`,
        code: "PAYSTACK_REFUND_NOTE_TOO_LONG",
        statusCode: 400,
      });
    }

    return note;
  }

  static normalizeTraceKey(value) {
    const traceKey = PaystackService.cleanString(value);

    if (!traceKey) {
      return null;
    }

    if (traceKey.length > 200) {
      throw PaystackService.createPaystackError({
        message: "Paystack refund trace key is too long.",
        code: "PAYSTACK_REFUND_TRACE_KEY_TOO_LONG",
        statusCode: 400,
      });
    }

    return traceKey;
  }

  static normalizePositiveInteger(value, fieldName, { defaultValue = null } = {}) {
    if (value === null || value === undefined || value === "") {
      return defaultValue;
    }

    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue <= 0) {
      throw PaystackService.createPaystackError({
        message: `${fieldName} must be a positive whole number.`,
        code: `INVALID_${String(fieldName)
          .replace(/[^a-z0-9]+/gi, "_")
          .toUpperCase()}`,
        statusCode: 400,
      });
    }

    return normalizedValue;
  }

  static normalizeRefundDateFilter(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw PaystackService.createPaystackError({
          message: `${fieldName} is invalid.`,
          code: "INVALID_PAYSTACK_REFUND_DATE_FILTER",
          statusCode: 400,
        });
      }

      return value.toISOString().slice(0, 10);
    }

    const normalizedValue = String(value).trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
      throw PaystackService.createPaystackError({
        message: `${fieldName} must use YYYY-MM-DD format.`,
        code: "INVALID_PAYSTACK_REFUND_DATE_FILTER",
        statusCode: 400,
      });
    }

    const parsed = new Date(`${normalizedValue}T00:00:00.000Z`);

    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalizedValue) {
      throw PaystackService.createPaystackError({
        message: `${fieldName} is invalid.`,
        code: "INVALID_PAYSTACK_REFUND_DATE_FILTER",
        statusCode: 400,
      });
    }

    return normalizedValue;
  }

  static normalizeBankAccountNumber(value) {
    const accountNumber = String(value || "")
      .replace(/\s+/g, "")
      .trim();

    if (!accountNumber) {
      throw PaystackService.createPaystackError({
        message: "Account number is required.",
        code: "BANK_ACCOUNT_NUMBER_REQUIRED",
        statusCode: 400,
      });
    }

    return accountNumber;
  }

  static normalizeBankId(value) {
    const bankId = PaystackService.cleanString(value);

    if (!bankId) {
      throw PaystackService.createPaystackError({
        message: "Paystack bank ID is required.",
        code: "PAYSTACK_BANK_ID_REQUIRED",
        statusCode: 400,
      });
    }

    return bankId;
  }

  static normalizeBankCode(value) {
    const bankCode = PaystackService.cleanString(value);

    if (!bankCode) {
      throw PaystackService.createPaystackError({
        message: "Paystack bank code is required.",
        code: "PAYSTACK_BANK_CODE_REQUIRED",
        statusCode: 400,
      });
    }

    return bankCode;
  }

  static normalizeBankCountry(value = "NG") {
    const rawValue = String(value || "NG")
      .trim()
      .toLowerCase();

    const countryByCode = PaystackService.supportedBankCountries;

    const normalizedCode = rawValue.toUpperCase();

    if (countryByCode[normalizedCode]) {
      return {
        countryCode: normalizedCode,
        country: countryByCode[normalizedCode],
      };
    }

    const matchingEntry = Object.entries(countryByCode).find(([, country]) => country === rawValue);

    if (matchingEntry) {
      return {
        countryCode: matchingEntry[0],
        country: matchingEntry[1],
      };
    }

    throw PaystackService.createPaystackError({
      message: "Paystack bank country is unsupported.",
      code: "UNSUPPORTED_PAYSTACK_BANK_COUNTRY",
      statusCode: 400,
      providerResponse: {
        suppliedCountry: value,
        supportedCountries: countryByCode,
      },
    });
  }

  static normalizeOptionalCursor(value) {
    const cursor = PaystackService.cleanString(value);

    if (!cursor) {
      return null;
    }

    if (cursor.length > 500) {
      throw PaystackService.createPaystackError({
        message: "Paystack bank-list cursor is too long.",
        code: "INVALID_PAYSTACK_BANK_CURSOR",
        statusCode: 400,
      });
    }

    return cursor;
  }

  static normalizeTransferReference(value) {
    const reference = PaystackService.cleanString(value);

    if (!reference) {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer reference is required.",
        code: "PAYSTACK_TRANSFER_REFERENCE_REQUIRED",
        statusCode: 400,
      });
    }

    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) {
      throw PaystackService.createPaystackError({
        message:
          "Paystack Transfer reference must contain 16 to 50 lowercase letters, digits, hyphens or underscores.",
        code: "INVALID_PAYSTACK_TRANSFER_REFERENCE",
        statusCode: 400,
      });
    }

    return reference;
  }

  static normalizeTransferCode(value) {
    const transferCode = PaystackService.cleanString(value);

    if (!transferCode) {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer code is required.",
        code: "PAYSTACK_TRANSFER_CODE_REQUIRED",
        statusCode: 400,
      });
    }

    if (transferCode.length > 100) {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer code is too long.",
        code: "INVALID_PAYSTACK_TRANSFER_CODE",
        statusCode: 400,
      });
    }

    return transferCode;
  }

  static normalizeTransferRecipientCode(value) {
    const recipientCode = PaystackService.cleanString(value);

    if (!recipientCode) {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer recipient code is required.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_CODE_REQUIRED",
        statusCode: 400,
      });
    }

    if (recipientCode.length > 100) {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer recipient code is too long.",
        code: "INVALID_PAYSTACK_TRANSFER_RECIPIENT_CODE",
        statusCode: 400,
      });
    }

    return recipientCode;
  }

  static normalizeTransferRecipientType(value) {
    const recipientType = String(value || "")
      .trim()
      .toLowerCase();

    const supportedTypes = ["nuban", "ghipss", "mobile_money", "kepss", "basa"];

    if (!supportedTypes.includes(recipientType)) {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer recipient type is unsupported.",
        code: "UNSUPPORTED_PAYSTACK_TRANSFER_RECIPIENT_TYPE",
        statusCode: 400,
        providerResponse: {
          suppliedType: value,
          supportedTypes,
        },
      });
    }

    return recipientType;
  }

  static normalizeTransferSource(value = "balance") {
    const source = String(value || "balance")
      .trim()
      .toLowerCase();

    if (source !== "balance") {
      throw PaystackService.createPaystackError({
        message: "Paystack Transfer source must be balance.",
        code: "INVALID_PAYSTACK_TRANSFER_SOURCE",
        statusCode: 400,
      });
    }

    return source;
  }

  static normalizeTransferOtp(value) {
    const otp = String(value || "")
      .replace(/\s+/g, "")
      .trim();

    if (!/^\d{4,10}$/.test(otp)) {
      throw PaystackService.createPaystackError({
        message: "A valid Paystack Transfer OTP is required.",
        code: "INVALID_PAYSTACK_TRANSFER_OTP",
        statusCode: 400,
      });
    }

    return otp;
  }

  static normalizeTransferName(value) {
    const name = PaystackService.cleanString(value);

    if (!name) {
      throw PaystackService.createPaystackError({
        message: "Transfer recipient name is required.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_NAME_REQUIRED",
        statusCode: 400,
      });
    }

    return name;
  }

  static normalizeOptionalTransferText(value, fieldName, maxLength = 1000) {
    const text = PaystackService.cleanString(value);

    if (!text) {
      return null;
    }

    if (text.length > maxLength) {
      throw PaystackService.createPaystackError({
        message: `${fieldName} is too long.`,
        code: "PAYSTACK_TRANSFER_TEXT_TOO_LONG",
        statusCode: 400,
      });
    }

    return text;
  }

  /* ─────────────────────────────── HEADERS / REQUEST ─────────────────────────────── */

  static getHeaders() {
    PaystackService.assertConfigured();

    return {
      Authorization: `Bearer ${PaystackService.getSecretKey()}`,
      "Content-Type": "application/json",
    };
  }

  static async request({ method, path, data = null, params = null }) {
    PaystackService.assertConfigured();

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
        throw PaystackService.createPaystackError({
          message: response.data?.message || "Paystack request failed.",
          code: "PAYSTACK_PROVIDER_REJECTED_REQUEST",
          statusCode: 502,
          providerStatusCode: response.status || null,
          providerResponse: response.data || null,
        });
      }

      return response.data;
    } catch (error) {
      if (error.name === "PaystackServiceError") {
        throw error;
      }

      const providerResponse = error.response?.data || null;

      const message =
        providerResponse?.message ||
        providerResponse?.error ||
        error.message ||
        "Paystack request failed.";

      throw PaystackService.createPaystackError({
        message,
        code:
          error.code === "ECONNABORTED" ? "PAYSTACK_REQUEST_TIMEOUT" : "PAYSTACK_REQUEST_FAILED",
        statusCode: 502,
        providerStatusCode: error.response?.status || null,
        providerResponse,
      });
    }
  }

  /* ─────────────────────────────── TRANSACTIONS ─────────────────────────────── */

  static async initializeTransaction({
    email,
    amount,
    reference,
    currency = "NGN",
    callbackUrl = null,
    channels = null,
    metadata = {},
  }) {
    const normalizedEmail = PaystackService.normalizeEmail(email);

    const normalizedAmount = PaystackService.normalizeAmount(amount);

    const normalizedReference = PaystackService.normalizeReference(reference);

    const normalizedCurrency = PaystackService.normalizeCurrency(currency);

    const normalizedCallbackUrl = PaystackService.normalizeCallbackUrl(callbackUrl);

    const normalizedChannels = PaystackService.normalizeChannels(channels);

    const normalizedMetadata = PaystackService.normalizeMetadata(metadata);

    const payload = {
      email: normalizedEmail,

      /*
       * Amount is sent in the currency's
       * minor unit.
       */
      amount: String(normalizedAmount),

      reference: normalizedReference,

      currency: normalizedCurrency,

      metadata: normalizedMetadata,
    };

    if (normalizedCallbackUrl) {
      payload.callback_url = normalizedCallbackUrl;
    }

    if (normalizedChannels) {
      payload.channels = normalizedChannels;
    }

    const response = await PaystackService.request({
      method: "post",
      path: "/transaction/initialize",
      data: payload,
    });

    const authorizationUrl = PaystackService.cleanString(response.data?.authorization_url);

    const accessCode = PaystackService.cleanString(response.data?.access_code);

    const returnedReference = PaystackService.cleanString(response.data?.reference);

    if (!authorizationUrl || !accessCode || !returnedReference) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete transaction initialization response.",
        code: "INVALID_PAYSTACK_INITIALIZATION_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (returnedReference !== normalizedReference) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an unexpected transaction reference.",
        code: "PAYSTACK_REFERENCE_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return {
      authorizationUrl,
      accessCode,
      reference: returnedReference,
      mode: PaystackService.getMode(),
      raw: response.data,
    };
  }

  static async verifyTransaction(reference) {
    const normalizedReference = PaystackService.normalizeReference(reference);

    const response = await PaystackService.request({
      method: "get",
      path: `/transaction/verify/${encodeURIComponent(normalizedReference)}`,
    });

    const transaction = response.data;

    if (!transaction) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an empty transaction verification response.",
        code: "EMPTY_PAYSTACK_VERIFICATION_RESPONSE",
        statusCode: 502,
      });
    }

    const returnedReference = PaystackService.cleanString(transaction.reference);

    if (returnedReference !== normalizedReference) {
      throw PaystackService.createPaystackError({
        message:
          "The verified Paystack transaction reference does not match the requested reference.",
        code: "PAYSTACK_VERIFICATION_REFERENCE_MISMATCH",
        statusCode: 502,
        providerResponse: transaction,
      });
    }

    return {
      id: transaction.id !== null && transaction.id !== undefined ? String(transaction.id) : null,

      reference: returnedReference,

      status: PaystackService.cleanString(transaction.status),

      amount: Number(transaction.amount),

      currency: PaystackService.normalizeCurrency(transaction.currency),

      channel: PaystackService.cleanString(transaction.channel),

      domain: PaystackService.cleanString(transaction.domain),

      paidAt: transaction.paid_at || transaction.paidAt || null,

      createdAt: transaction.created_at || transaction.createdAt || null,

      gatewayResponse: PaystackService.cleanString(transaction.gateway_response),

      fees: Number.isFinite(Number(transaction.fees)) ? Number(transaction.fees) : null,

      customerEmail: PaystackService.cleanString(transaction.customer?.email),

      metadata: transaction.metadata || null,

      authorization: transaction.authorization || null,

      raw: transaction,
    };
  }

  /* ─────────────────────────────── REFUNDS ─────────────────────────────── */

  static buildRefundMerchantNote({
    merchantNote = null,
    idempotencyKey = null,
    metadata = {},
  } = {}) {
    const normalizedMerchantNote = PaystackService.normalizeOptionalNote(
      merchantNote,
      "Paystack refund merchant note"
    );

    if (normalizedMerchantNote) {
      return normalizedMerchantNote;
    }

    const normalizedTraceKey = PaystackService.normalizeTraceKey(idempotencyKey);

    const normalizedMetadata = PaystackService.normalizeMetadata(metadata);

    const batchReference = PaystackService.cleanString(
      normalizedMetadata.employerRefundBatchReference
    );

    const lineReference = PaystackService.cleanString(
      normalizedMetadata.employerRefundLineReference
    );

    const parts = ["Loqum employer refund"];

    if (batchReference) {
      parts.push(`batch=${batchReference}`);
    }

    if (lineReference) {
      parts.push(`line=${lineReference}`);
    }

    if (normalizedTraceKey) {
      parts.push(`key=${normalizedTraceKey}`);
    }

    return parts.join(" | ");
  }

  static normalizeRefundRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an invalid refund record.",
        code: "INVALID_PAYSTACK_REFUND_RESPONSE",
        statusCode: 502,
        providerResponse: value || null,
      });
    }

    const transaction =
      value.transaction && typeof value.transaction === "object"
        ? {
            id:
              value.transaction.id !== null && value.transaction.id !== undefined
                ? String(value.transaction.id)
                : null,

            reference: PaystackService.cleanString(value.transaction.reference),

            amount: Number.isFinite(Number(value.transaction.amount))
              ? Number(value.transaction.amount)
              : null,

            currency: PaystackService.cleanString(value.transaction.currency)
              ? PaystackService.normalizeCurrency(value.transaction.currency)
              : null,

            status: PaystackService.cleanString(value.transaction.status),

            raw: value.transaction,
          }
        : value.transaction !== null && value.transaction !== undefined
          ? {
              id: String(value.transaction),
              reference: null,
              amount: null,
              currency: null,
              status: null,
              raw: value.transaction,
            }
          : null;

    const status = PaystackService.cleanString(value.status);

    return {
      id: value.id !== null && value.id !== undefined ? String(value.id) : null,

      transaction,

      status: status ? status.toLowerCase() : null,

      amount: Number.isFinite(Number(value.amount)) ? Number(value.amount) : null,

      deductedAmount: Number.isFinite(Number(value.deducted_amount))
        ? Number(value.deducted_amount)
        : null,

      currency: PaystackService.cleanString(value.currency)
        ? PaystackService.normalizeCurrency(value.currency)
        : null,

      channel: PaystackService.cleanString(value.channel),

      domain: PaystackService.cleanString(value.domain),

      customerNote: PaystackService.cleanString(value.customer_note),

      merchantNote: PaystackService.cleanString(value.merchant_note),

      refundedBy: PaystackService.cleanString(value.refunded_by),

      refundedAt: value.refunded_at || value.refundedAt || null,

      expectedAt: value.expected_at || value.expectedAt || null,

      fullyDeducted:
        value.fully_deducted === null || value.fully_deducted === undefined
          ? null
          : Boolean(value.fully_deducted),

      bankReference: PaystackService.cleanString(value.bank_reference),

      reason: PaystackService.cleanString(value.reason),

      createdAt: value.created_at || value.createdAt || null,

      updatedAt: value.updated_at || value.updatedAt || null,

      raw: value,
    };
  }

  static async createRefund({
    transaction,
    amount = null,
    currency = null,
    customerNote = null,
    merchantNote = null,

    /*
     * Loqum trace key only.
     *
     * Paystack's documented Create Refund
     * request does not expose an
     * idempotency-key field.
     *
     * We therefore place this value in
     * merchant_note for reconciliation.
     */
    idempotencyKey = null,

    /*
     * Loqum-only trace metadata.
     *
     * This is not sent as a Paystack
     * "metadata" field because the Refund
     * API does not document one.
     */
    metadata = {},
  }) {
    const normalizedTransaction = PaystackService.normalizeTransactionIdentifier(transaction);

    const normalizedAmount = PaystackService.normalizeOptionalAmount(amount);

    const normalizedCurrency = PaystackService.normalizeOptionalCurrency(currency);

    const normalizedCustomerNote = PaystackService.normalizeOptionalNote(
      customerNote,
      "Paystack refund customer note"
    );

    const normalizedMetadata = PaystackService.normalizeMetadata(metadata);

    const normalizedTraceKey = PaystackService.normalizeTraceKey(idempotencyKey);

    const normalizedMerchantNote = PaystackService.buildRefundMerchantNote({
      merchantNote,
      idempotencyKey: normalizedTraceKey,
      metadata: normalizedMetadata,
    });

    const payload = {
      transaction: normalizedTransaction,
    };

    if (normalizedAmount !== null) {
      payload.amount = normalizedAmount;
    }

    if (normalizedCurrency) {
      payload.currency = normalizedCurrency;
    }

    if (normalizedCustomerNote) {
      payload.customer_note = normalizedCustomerNote;
    }

    if (normalizedMerchantNote) {
      payload.merchant_note = normalizedMerchantNote;
    }

    const response = await PaystackService.request({
      method: "post",
      path: "/refund",
      data: payload,
    });

    const refund = PaystackService.normalizeRefundRecord(response.data);

    if (!refund.id || !refund.status) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete refund creation response.",
        code: "INCOMPLETE_PAYSTACK_REFUND_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return {
      ...refund,

      trace: {
        idempotencyKey: normalizedTraceKey,
        metadata: normalizedMetadata,
      },
    };
  }

  static async fetchRefund(refundId) {
    const normalizedRefundId = PaystackService.normalizeRefundId(refundId);

    const response = await PaystackService.request({
      method: "get",
      path: `/refund/${encodeURIComponent(normalizedRefundId)}`,
    });

    return PaystackService.normalizeRefundRecord(response.data);
  }

  static async listRefunds({
    transaction = null,
    currency = null,
    from = null,
    to = null,
    perPage = 50,
    page = 1,
  } = {}) {
    const normalizedTransaction =
      transaction === null || transaction === undefined || transaction === ""
        ? null
        : PaystackService.normalizeTransactionIdentifier(transaction);

    const normalizedCurrency = PaystackService.normalizeOptionalCurrency(currency);

    const normalizedFrom = PaystackService.normalizeRefundDateFilter(
      from,
      "Refund list start date"
    );

    const normalizedTo = PaystackService.normalizeRefundDateFilter(to, "Refund list end date");

    const normalizedPerPage = PaystackService.normalizePositiveInteger(
      perPage,
      "refunds per page",
      {
        defaultValue: 50,
      }
    );

    const normalizedPage = PaystackService.normalizePositiveInteger(page, "refund page", {
      defaultValue: 1,
    });

    const params = {
      perPage: normalizedPerPage,
      page: normalizedPage,
    };

    if (normalizedTransaction) {
      params.transaction = normalizedTransaction;
    }

    if (normalizedCurrency) {
      params.currency = normalizedCurrency;
    }

    if (normalizedFrom) {
      params.from = normalizedFrom;
    }

    if (normalizedTo) {
      params.to = normalizedTo;
    }

    const response = await PaystackService.request({
      method: "get",
      path: "/refund",
      params,
    });

    const records = Array.isArray(response.data) ? response.data : [];

    return {
      refunds: records.map((record) => PaystackService.normalizeRefundRecord(record)),

      meta: response.meta || null,

      raw: response,
    };
  }

  static async retryRefundWithCustomerDetails({ refundId, currency, accountNumber, bankId }) {
    const normalizedRefundId = PaystackService.normalizeRefundId(refundId);

    const normalizedCurrency = PaystackService.normalizeCurrency(currency);

    const normalizedAccountNumber = PaystackService.normalizeBankAccountNumber(accountNumber);

    const normalizedBankId = PaystackService.normalizeBankId(bankId);

    const response = await PaystackService.request({
      method: "post",

      path: `/refund/retry_with_customer_details/${encodeURIComponent(normalizedRefundId)}`,

      data: {
        refund_account_details: {
          currency: normalizedCurrency,
          account_number: normalizedAccountNumber,
          bank_id: normalizedBankId,
        },
      },
    });

    const refund = PaystackService.normalizeRefundRecord(response.data);

    if (!refund.id || !refund.status) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete refund retry response.",
        code: "INCOMPLETE_PAYSTACK_REFUND_RETRY_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (refund.id !== normalizedRefundId) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an unexpected refund after Retry Refund submission.",
        code: "PAYSTACK_REFUND_RETRY_ID_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return refund;
  }

  static async findRefundByTraceKey({
    transaction,
    idempotencyKey,
    currency = null,
    perPage = 50,
  }) {
    const normalizedTraceKey = PaystackService.normalizeTraceKey(idempotencyKey);

    if (!normalizedTraceKey) {
      throw PaystackService.createPaystackError({
        message: "A Loqum refund trace key is required for refund reconciliation.",
        code: "PAYSTACK_REFUND_TRACE_KEY_REQUIRED",
        statusCode: 400,
      });
    }

    const normalizedTransaction = PaystackService.normalizeTransactionIdentifier(transaction);

    let transactionId = normalizedTransaction;

    /*
     * Paystack's refund-list transaction
     * filter is provider-transaction based.
     *
     * If Loqum has only the Checkout
     * reference, resolve it first.
     */
    if (!/^\d+$/.test(normalizedTransaction)) {
      const verifiedTransaction = await PaystackService.verifyTransaction(normalizedTransaction);

      if (!verifiedTransaction.id) {
        throw PaystackService.createPaystackError({
          message: "The Paystack transaction could not be resolved to a provider transaction ID.",
          code: "PAYSTACK_TRANSACTION_ID_UNAVAILABLE",
          statusCode: 502,
          providerResponse: verifiedTransaction.raw || null,
        });
      }

      transactionId = verifiedTransaction.id;
    }

    const result = await PaystackService.listRefunds({
      transaction: transactionId,
      currency,
      perPage,
      page: 1,
    });

    const marker = `key=${normalizedTraceKey}`;

    const refund =
      result.refunds.find((item) => String(item.merchantNote || "").includes(marker)) || null;

    return {
      found: Boolean(refund),
      refund,
      transactionId,
      traceKey: normalizedTraceKey,
      meta: result.meta,
    };
  }

  /* ─────────────────────────────── TRANSFER RECIPIENTS / TRANSFERS ─────────────────────────────── */

  static normalizeTransferRecipientRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an invalid Transfer recipient record.",
        code: "INVALID_PAYSTACK_TRANSFER_RECIPIENT_RESPONSE",
        statusCode: 502,
        providerResponse: value || null,
      });
    }

    const recipientCode = PaystackService.cleanString(value.recipient_code || value.recipientCode);

    const details =
      value.details && typeof value.details === "object" && !Array.isArray(value.details)
        ? value.details
        : {};

    return {
      id: value.id === null || value.id === undefined ? null : String(value.id),

      recipientCode,

      type: PaystackService.cleanString(value.type)
        ? String(value.type).trim().toLowerCase()
        : null,

      name: PaystackService.cleanString(value.name),

      description: PaystackService.cleanString(value.description),

      currency: PaystackService.cleanString(value.currency)
        ? PaystackService.normalizeCurrency(value.currency)
        : null,

      active: value.active === null || value.active === undefined ? null : Boolean(value.active),

      isDeleted:
        value.is_deleted !== undefined
          ? Boolean(value.is_deleted)
          : value.isDeleted !== undefined
            ? Boolean(value.isDeleted)
            : null,

      accountNumber: PaystackService.cleanString(details.account_number || details.accountNumber),

      accountName: PaystackService.cleanString(details.account_name || details.accountName),

      bankCode: PaystackService.cleanString(details.bank_code || details.bankCode),

      bankName: PaystackService.cleanString(details.bank_name || details.bankName),

      metadata: value.metadata && typeof value.metadata === "object" ? value.metadata : null,

      createdAt: value.createdAt || value.created_at || null,

      updatedAt: value.updatedAt || value.updated_at || null,

      raw: value,
    };
  }

  static normalizeTransferRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an invalid Transfer record.",
        code: "INVALID_PAYSTACK_TRANSFER_RESPONSE",
        statusCode: 502,
        providerResponse: value || null,
      });
    }

    const rawStatus = PaystackService.cleanString(value.status);

    let recipientCode = null;
    let recipientId = null;

    if (value.recipient && typeof value.recipient === "object") {
      recipientCode = PaystackService.cleanString(
        value.recipient.recipient_code || value.recipient.recipientCode
      );

      if (value.recipient.id !== null && value.recipient.id !== undefined) {
        recipientId = String(value.recipient.id);
      }
    } else if (value.recipient !== null && value.recipient !== undefined) {
      const rawRecipient = String(value.recipient).trim();

      if (rawRecipient.startsWith("RCP_")) {
        recipientCode = rawRecipient;
      } else if (rawRecipient) {
        recipientId = rawRecipient;
      }
    }

    return {
      id: value.id === null || value.id === undefined ? null : String(value.id),

      domain: PaystackService.cleanString(value.domain),

      amount: Number.isFinite(Number(value.amount)) ? Number(value.amount) : null,

      currency: PaystackService.cleanString(value.currency)
        ? PaystackService.normalizeCurrency(value.currency)
        : null,

      reference: PaystackService.cleanString(value.reference),

      source: PaystackService.cleanString(value.source),

      reason: PaystackService.cleanString(value.reason),

      status: rawStatus ? rawStatus.toLowerCase() : null,

      transferCode: PaystackService.cleanString(value.transfer_code || value.transferCode),

      recipientCode,

      recipientId,

      failures: value.failures === null || value.failures === undefined ? null : value.failures,

      transferredAt: value.transferred_at || value.transferredAt || null,

      createdAt: value.createdAt || value.created_at || null,

      updatedAt: value.updatedAt || value.updated_at || null,

      raw: value,
    };
  }

  static async createTransferRecipient({
    type,
    name,
    accountNumber,
    bankCode,
    currency = "NGN",
    description = null,
    metadata = {},
  }) {
    const normalizedType = PaystackService.normalizeTransferRecipientType(type);

    const normalizedName = PaystackService.normalizeTransferName(name);

    const normalizedAccountNumber = PaystackService.normalizeBankAccountNumber(accountNumber);

    const normalizedBankCode = PaystackService.normalizeBankCode(bankCode);

    const normalizedCurrency = PaystackService.normalizeCurrency(currency);

    const normalizedDescription = PaystackService.normalizeOptionalTransferText(
      description,
      "Paystack Transfer recipient description",
      1000
    );

    const normalizedMetadata = PaystackService.normalizeMetadata(metadata);

    const payload = {
      type: normalizedType,
      name: normalizedName,
      account_number: normalizedAccountNumber,
      bank_code: normalizedBankCode,
      currency: normalizedCurrency,
      metadata: normalizedMetadata,
    };

    if (normalizedDescription) {
      payload.description = normalizedDescription;
    }

    const response = await PaystackService.request({
      method: "post",
      path: "/transferrecipient",
      data: payload,
    });

    const recipient = PaystackService.normalizeTransferRecipientRecord(response.data);

    if (!recipient.recipientCode) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete Transfer recipient response.",
        code: "INCOMPLETE_PAYSTACK_TRANSFER_RECIPIENT_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (recipient.currency && recipient.currency !== normalizedCurrency) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned a Transfer recipient with an unexpected currency.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_CURRENCY_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (recipient.bankCode && recipient.bankCode !== normalizedBankCode) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned a Transfer recipient with an unexpected bank code.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_BANK_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (recipient.accountNumber && recipient.accountNumber !== normalizedAccountNumber) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned a Transfer recipient with an unexpected account number.",
        code: "PAYSTACK_TRANSFER_RECIPIENT_ACCOUNT_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return recipient;
  }

  static async initiateTransfer({
    source = "balance",
    amount,
    recipient,
    reference,
    reason = null,
    currency = "NGN",
  }) {
    const normalizedSource = PaystackService.normalizeTransferSource(source);

    const normalizedAmount = PaystackService.normalizeAmount(amount);

    const normalizedRecipient = PaystackService.normalizeTransferRecipientCode(recipient);

    const normalizedReference = PaystackService.normalizeTransferReference(reference);

    const normalizedCurrency = PaystackService.normalizeCurrency(currency);

    const normalizedReason = PaystackService.normalizeOptionalTransferText(
      reason,
      "Paystack Transfer reason",
      1000
    );

    const payload = {
      source: normalizedSource,
      amount: normalizedAmount,
      recipient: normalizedRecipient,
      reference: normalizedReference,
      currency: normalizedCurrency,
    };

    if (normalizedReason) {
      payload.reason = normalizedReason;
    }

    const response = await PaystackService.request({
      method: "post",
      path: "/transfer",
      data: payload,
    });

    const transfer = PaystackService.normalizeTransferRecord(response.data);

    if (!transfer.reference || !transfer.status) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete Transfer initiation response.",
        code: "INCOMPLETE_PAYSTACK_TRANSFER_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (transfer.reference !== normalizedReference) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an unexpected Transfer reference.",
        code: "PAYSTACK_TRANSFER_REFERENCE_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (transfer.amount !== null && transfer.amount !== normalizedAmount) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an unexpected Transfer amount.",
        code: "PAYSTACK_TRANSFER_AMOUNT_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (transfer.currency && transfer.currency !== normalizedCurrency) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an unexpected Transfer currency.",
        code: "PAYSTACK_TRANSFER_CURRENCY_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return transfer;
  }

  static async verifyTransfer(reference) {
    const normalizedReference = PaystackService.normalizeTransferReference(reference);

    const response = await PaystackService.request({
      method: "get",
      path: `/transfer/verify/${encodeURIComponent(normalizedReference)}`,
    });

    const transfer = PaystackService.normalizeTransferRecord(response.data);

    if (!transfer.reference || !transfer.status) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete Transfer verification response.",
        code: "INCOMPLETE_PAYSTACK_TRANSFER_VERIFICATION_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (transfer.reference !== normalizedReference) {
      throw PaystackService.createPaystackError({
        message: "The verified Paystack Transfer reference does not match the requested reference.",
        code: "PAYSTACK_TRANSFER_VERIFICATION_REFERENCE_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return transfer;
  }

  static async finalizeTransfer({ transferCode, otp }) {
    const normalizedTransferCode = PaystackService.normalizeTransferCode(transferCode);

    const normalizedOtp = PaystackService.normalizeTransferOtp(otp);

    const response = await PaystackService.request({
      method: "post",
      path: "/transfer/finalize_transfer",
      data: {
        transfer_code: normalizedTransferCode,
        otp: normalizedOtp,
      },
    });

    const transfer = PaystackService.normalizeTransferRecord(response.data);

    if (!transfer.status) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an incomplete Transfer finalization response.",
        code: "INCOMPLETE_PAYSTACK_TRANSFER_FINALIZATION_RESPONSE",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    if (transfer.transferCode && transfer.transferCode !== normalizedTransferCode) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an unexpected Transfer code after OTP finalization.",
        code: "PAYSTACK_TRANSFER_CODE_MISMATCH",
        statusCode: 502,
        providerResponse: response.data || null,
      });
    }

    return transfer;
  }

  /* ─────────────────────────────── DEDICATED VIRTUAL ACCOUNTS ─────────────────────────────── */

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
      throw PaystackService.createPaystackError({
        message: "PAYSTACK_DVA_PREFERRED_BANK is not configured.",
        code: "PAYSTACK_DVA_PREFERRED_BANK_NOT_CONFIGURED",
        statusCode: 503,
      });
    }

    return envPreferredBank.toLowerCase();
  }

  static async assignDedicatedVirtualAccount({
    email,
    firstName,
    lastName,
    phone,
    preferredBank = null,
    countryCode = "NG",
    metadata = {},
  }) {
    const cleanEmail = PaystackService.normalizeEmail(email);

    const cleanFirstName = PaystackService.cleanString(firstName);

    const cleanLastName = PaystackService.cleanString(lastName);

    const cleanPhone = PaystackService.cleanPhone(phone);

    if (!cleanFirstName) {
      throw PaystackService.createPaystackError({
        message: "First name is required for Paystack DVA assignment.",
        code: "PAYSTACK_DVA_FIRST_NAME_REQUIRED",
        statusCode: 400,
      });
    }

    if (!cleanLastName) {
      throw PaystackService.createPaystackError({
        message: "Last name is required for Paystack DVA assignment.",
        code: "PAYSTACK_DVA_LAST_NAME_REQUIRED",
        statusCode: 400,
      });
    }

    if (!cleanPhone) {
      throw PaystackService.createPaystackError({
        message: "Phone number is required for Paystack DVA assignment.",
        code: "PAYSTACK_DVA_PHONE_REQUIRED",
        statusCode: 400,
      });
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

      metadata: PaystackService.normalizeMetadata(metadata),
    };

    const response = await PaystackService.request({
      method: "post",
      path: "/dedicated_account/assign",
      data: payload,
    });

    return response.data;
  }

  static async fetchDedicatedAccountProviders() {
    const response = await PaystackService.request({
      method: "get",
      path: "/dedicated_account/available_providers",
    });

    return response.data;
  }

  /* ─────────────────────────────── BANKS ─────────────────────────────── */

  static normalizeBankRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw PaystackService.createPaystackError({
        message: "Paystack returned an invalid bank record.",
        code: "INVALID_PAYSTACK_BANK_RESPONSE",
        statusCode: 502,
        providerResponse: value || null,
      });
    }

    const id = value.id === null || value.id === undefined ? null : String(value.id);

    const code = PaystackService.cleanString(value.code);

    return {
      id,

      name: PaystackService.cleanString(value.name),

      slug: PaystackService.cleanString(value.slug),

      code,

      longCode: PaystackService.cleanString(value.longcode),

      gateway: PaystackService.cleanString(value.gateway),

      payWithBank:
        value.pay_with_bank === null || value.pay_with_bank === undefined
          ? null
          : Boolean(value.pay_with_bank),

      active: value.active === null || value.active === undefined ? null : Boolean(value.active),

      isDeleted:
        value.is_deleted === null || value.is_deleted === undefined
          ? null
          : Boolean(value.is_deleted),

      country: PaystackService.cleanString(value.country),

      currency: PaystackService.cleanString(value.currency)
        ? PaystackService.normalizeCurrency(value.currency)
        : null,

      type: PaystackService.cleanString(value.type),

      raw: value,
    };
  }

  static async listBanks({
    country = "nigeria",
    currency = "NGN",
    useCursor = true,
    perPage = 100,
    next = null,
    previous = null,
  } = {}) {
    const normalizedCountry = PaystackService.normalizeBankCountry(country);

    const normalizedCurrency = PaystackService.normalizeCurrency(currency);

    const normalizedPerPage = PaystackService.normalizePositiveInteger(perPage, "banks per page", {
      defaultValue: 100,
    });

    if (normalizedPerPage > 100) {
      throw PaystackService.createPaystackError({
        message: "Paystack bank-list page size cannot exceed 100.",
        code: "PAYSTACK_BANK_PAGE_SIZE_TOO_LARGE",
        statusCode: 400,
      });
    }

    const normalizedNext = PaystackService.normalizeOptionalCursor(next);

    const normalizedPrevious = PaystackService.normalizeOptionalCursor(previous);

    if (normalizedNext && normalizedPrevious) {
      throw PaystackService.createPaystackError({
        message: "Use either next or previous when paging Paystack banks, not both.",
        code: "INVALID_PAYSTACK_BANK_CURSOR_DIRECTION",
        statusCode: 400,
      });
    }

    const params = {
      country: normalizedCountry.country,
      currency: normalizedCurrency,
      perPage: normalizedPerPage,
      use_cursor: Boolean(useCursor),
    };

    if (normalizedNext) {
      params.next = normalizedNext;
    }

    if (normalizedPrevious) {
      params.previous = normalizedPrevious;
    }

    const response = await PaystackService.request({
      method: "get",
      path: "/bank",
      params,
    });

    const records = Array.isArray(response.data) ? response.data : [];

    return {
      banks: records.map((record) => PaystackService.normalizeBankRecord(record)),

      meta: response.meta || null,

      countryCode: normalizedCountry.countryCode,

      country: normalizedCountry.country,

      currency: normalizedCurrency,

      raw: response,
    };
  }

  static async fetchBanks({ country = "nigeria", currency = "NGN" } = {}) {
    const result = await PaystackService.listBanks({
      country,
      currency,
      useCursor: false,
      perPage: 100,
    });

    /*
     * Compatibility wrapper. Existing callers of fetchBanks() receive the
     * provider-style bank objects rather than the richer listBanks() envelope.
     */
    return result.banks.map((bank) => bank.raw);
  }

  static async resolveBankId({ bankCode, countryCode = "NG", currency = "NGN" }) {
    const normalizedBankCode = PaystackService.normalizeBankCode(bankCode);

    const normalizedCountry = PaystackService.normalizeBankCountry(countryCode);

    const normalizedCurrency = PaystackService.normalizeCurrency(currency);

    let nextCursor = null;
    let pageCount = 0;

    /*
     * List Banks is cursor-paginated and returns both `code` and provider `id`.
     * Retry Refund requires the provider bank ID, while Loqum stores the bank
     * code used for ordinary account resolution. Resolve the ID at execution
     * time instead of treating these two identifiers as interchangeable.
     */
    do {
      pageCount += 1;

      if (pageCount > 50) {
        throw PaystackService.createPaystackError({
          message: "Paystack bank lookup exceeded the safe pagination limit.",
          code: "PAYSTACK_BANK_LOOKUP_PAGINATION_LIMIT",
          statusCode: 502,
        });
      }

      const result = await PaystackService.listBanks({
        country: normalizedCountry.countryCode,
        currency: normalizedCurrency,
        useCursor: true,
        perPage: 100,
        next: nextCursor,
      });

      const bank =
        result.banks.find(
          (item) =>
            item.code === normalizedBankCode &&
            item.currency === normalizedCurrency &&
            item.active !== false &&
            item.isDeleted !== true
        ) || null;

      if (bank) {
        if (!bank.id) {
          throw PaystackService.createPaystackError({
            message: "Paystack bank record does not contain the bank ID required for Retry Refund.",
            code: "PAYSTACK_BANK_ID_UNAVAILABLE",
            statusCode: 502,
            providerResponse: bank.raw || null,
          });
        }

        return {
          bankId: bank.id,
          id: bank.id,
          bankCode: bank.code,
          bankName: bank.name,

          countryCode: normalizedCountry.countryCode,

          country: normalizedCountry.country,

          currency: normalizedCurrency,

          raw: bank.raw,
        };
      }

      nextCursor = PaystackService.cleanString(result.meta?.next);
    } while (nextCursor);

    throw PaystackService.createPaystackError({
      message: "Paystack bank ID could not be found for the supplied bank code.",
      code: "PAYSTACK_BANK_ID_NOT_FOUND",
      statusCode: 404,

      providerResponse: {
        bankCode: normalizedBankCode,

        countryCode: normalizedCountry.countryCode,

        country: normalizedCountry.country,

        currency: normalizedCurrency,
      },
    });
  }

  static async resolveBankAccount({ accountNumber, bankCode }) {
    const cleanAccountNumber = PaystackService.normalizeBankAccountNumber(accountNumber);

    const cleanBankCode = PaystackService.normalizeBankCode(bankCode);

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
