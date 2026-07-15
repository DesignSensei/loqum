// services/paystackWebhookService.js

const crypto = require("crypto");

const PlatformSettings = require("../models/PlatformSettings");

const PaystackEventNormalizerService = require("./paystackEventNormalizerService");
const ProviderEventService = require("./providerEventService");
const ProviderEventProcessorService = require("./providerEventProcessorService");

class PaystackWebhookService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Clean uppercase string ---------- */
  static cleanUpperString(value) {
    const cleanValue = PaystackWebhookService.cleanString(value);

    return cleanValue ? cleanValue.toUpperCase() : null;
  }

  /* ---------- Get Paystack secret key ---------- */
  static getSecretKey() {
    const secretKey = PaystackWebhookService.cleanString(process.env.PAYSTACK_SECRET_KEY);

    if (!secretKey) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured.");
    }

    return secretKey;
  }

  /* ---------- Get Paystack signature from request headers ---------- */
  static getSignature(headers = {}) {
    return (
      PaystackWebhookService.cleanString(headers["x-paystack-signature"]) ||
      PaystackWebhookService.cleanString(headers["X-Paystack-Signature"])
    );
  }

  /* ---------- Get signature payload ---------- */
  static getSignaturePayload({ rawBody = null, payload = null }) {
    if (Buffer.isBuffer(rawBody)) {
      return rawBody;
    }

    if (typeof rawBody === "string") {
      return Buffer.from(rawBody, "utf8");
    }

    if (payload) {
      return Buffer.from(JSON.stringify(payload), "utf8");
    }

    throw new Error("Paystack webhook payload is required for signature verification.");
  }

  /* ---------- Compare signatures safely ---------- */
  static signaturesMatch(expectedSignature, receivedSignature) {
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const receivedBuffer = Buffer.from(receivedSignature, "hex");

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  }

  /* ---------- Verify Paystack webhook signature ---------- */
  static verifySignature({ rawBody = null, payload = null, rawHeaders = {}, secretKey = null }) {
    const receivedSignature = PaystackWebhookService.getSignature(rawHeaders);

    if (!receivedSignature) {
      return false;
    }

    const activeSecretKey = secretKey || PaystackWebhookService.getSecretKey();

    const signaturePayload = PaystackWebhookService.getSignaturePayload({
      rawBody,
      payload,
    });

    const expectedSignature = crypto
      .createHmac("sha512", activeSecretKey)
      .update(signaturePayload)
      .digest("hex");

    return PaystackWebhookService.signaturesMatch(expectedSignature, receivedSignature);
  }

  /* ---------- Get active platform settings ---------- */
  static async getPlatformSettings(options = {}) {
    const query = PlatformSettings.findOne({
      key: "global",
      isActive: true,
    });

    if (options.session) {
      query.session(options.session);
    }

    const settings = await query;

    if (!settings) {
      throw new Error("Active platform settings not found.");
    }

    return settings;
  }

  /* ---------- Build currency-country map from platform settings ---------- */
  static buildCurrencyCountryMap(settings) {
    const currencyCountryMap = {};

    const countrySettings = Array.isArray(settings.countrySettings) ? settings.countrySettings : [];

    countrySettings.forEach((countrySetting) => {
      if (!countrySetting.isActive) {
        return;
      }

      const countryCode = PaystackWebhookService.cleanUpperString(countrySetting.countryCode);
      const currency = PaystackWebhookService.cleanUpperString(countrySetting.currency);

      if (countryCode && currency) {
        currencyCountryMap[currency] = countryCode;
      }
    });

    return currencyCountryMap;
  }

  /* ---------- Validate normalized event country and currency ---------- */
  static validateNormalizedEventCountryCurrency({ normalizedEvent, settings }) {
    const countryCode = PaystackWebhookService.cleanUpperString(normalizedEvent.countryCode);
    const currency = PaystackWebhookService.cleanUpperString(normalizedEvent.currency);

    if (!countryCode) {
      throw new Error("Provider event country code is required.");
    }

    if (!currency) {
      throw new Error("Provider event currency is required.");
    }

    const activeCountryCodes = Array.isArray(settings.activeCountryCodes)
      ? settings.activeCountryCodes.map((item) => PaystackWebhookService.cleanUpperString(item))
      : [];

    const supportedCurrencies = Array.isArray(settings.supportedCurrencies)
      ? settings.supportedCurrencies.map((item) => PaystackWebhookService.cleanUpperString(item))
      : [];

    if (!activeCountryCodes.includes(countryCode)) {
      throw new Error(`${countryCode} is not an active Loqum country.`);
    }

    if (!supportedCurrencies.includes(currency)) {
      throw new Error(`${currency} is not a supported Loqum currency.`);
    }

    const hasCountrySetting = Array.isArray(settings.countrySettings)
      ? settings.countrySettings.some((countrySetting) => {
          return (
            countrySetting.isActive &&
            PaystackWebhookService.cleanUpperString(countrySetting.countryCode) === countryCode &&
            PaystackWebhookService.cleanUpperString(countrySetting.currency) === currency
          );
        })
      : false;

    if (!hasCountrySetting) {
      throw new Error(`No active country setting found for ${countryCode}/${currency}.`);
    }

    return {
      countryCode,
      currency,
    };
  }

  /* ---------- Normalize Paystack event with platform context ---------- */
  static async normalizePaystackEvent({ payload, rawHeaders = {} }, options = {}) {
    const settings = await PaystackWebhookService.getPlatformSettings(options);

    const normalizedEvent = PaystackEventNormalizerService.normalize(payload, rawHeaders, {
      defaultCountryCode: settings.defaultCountryCode,
      defaultCurrency: settings.defaultCurrency,
      currencyCountryMap: PaystackWebhookService.buildCurrencyCountryMap(settings),
    });

    const validated = PaystackWebhookService.validateNormalizedEventCountryCurrency({
      normalizedEvent,
      settings,
    });

    return {
      ...normalizedEvent,
      countryCode: validated.countryCode,
      currency: validated.currency,
      normalizedPayload: {
        ...(normalizedEvent.normalizedPayload || {}),
        countryCode: validated.countryCode,
        currency: validated.currency,
      },
    };
  }

  /* ---------- Record Paystack webhook event ---------- */
  static async recordPaystackWebhookEvent(
    { payload, rawBody = null, rawHeaders = {}, processImmediately = false },
    options = {}
  ) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const isVerified = PaystackWebhookService.verifySignature({
        rawBody,
        payload,
        rawHeaders,
      });

      const normalizedEvent = await PaystackWebhookService.normalizePaystackEvent(
        {
          payload,
          rawHeaders,
        },
        {
          session,
        }
      );

      const recordResult = await ProviderEventService.recordProviderEvent(
        {
          ...normalizedEvent,
          isVerified,
        },
        {
          session,
        }
      );

      if (!processImmediately) {
        return {
          ...recordResult,
          isVerified,
          processedImmediately: false,
        };
      }

      if (!isVerified) {
        return {
          ...recordResult,
          isVerified,
          processedImmediately: false,
          skippedProcessingReason: "Unverified Paystack webhook event.",
        };
      }

      const processResult = await ProviderEventProcessorService.processProviderEvent(
        {
          providerEventRecordId: recordResult.providerEvent._id,
        },
        {
          session,
        }
      );

      return {
        ...recordResult,
        isVerified,
        processedImmediately: true,
        processResult,
      };
    });
  }
}

module.exports = PaystackWebhookService;
