// services/paystackWebhookService.js

const crypto = require("crypto");

const PlatformSettings = require("../models/PlatformSettings");

const PaystackEventNormalizerService = require("./paystackEventNormalizerService");
const ProviderEventService = require("./providerEventService");
const ProviderEventProcessorService = require("./providerEventProcessorService");

class PaystackWebhookService {
  static refundEventNames = Object.freeze([
    "refund.pending",
    "refund.processing",
    "refund.needs-attention",
    "refund.failed",
    "refund.processed",
  ]);

  static transferEventNames = Object.freeze([
    "transfer.success",
    "transfer.failed",
    "transfer.reversed",
  ]);

  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  static cleanLowerString(value) {
    const cleanValue = PaystackWebhookService.cleanString(value);

    return cleanValue ? cleanValue.toLowerCase() : null;
  }

  static cleanUpperString(value) {
    const cleanValue = PaystackWebhookService.cleanString(value);

    return cleanValue ? cleanValue.toUpperCase() : null;
  }

  static normalizeCurrentTime(value) {
    const currentTime =
      value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());

    if (Number.isNaN(currentTime.getTime())) {
      throw new Error("Paystack webhook current time is invalid.");
    }

    return currentTime;
  }

  /* ─────────────────────────────── CONFIGURATION ─────────────────────────────── */

  static getSecretKey() {
    const secretKey = PaystackWebhookService.cleanString(process.env.PAYSTACK_SECRET_KEY);

    if (!secretKey) {
      throw new Error("PAYSTACK_SECRET_KEY is not configured.");
    }

    return secretKey;
  }

  /* ─────────────────────────────── SIGNATURE VERIFICATION ─────────────────────────────── */

  static getSignature(headers = {}) {
    return (
      PaystackWebhookService.cleanString(headers["x-paystack-signature"]) ||
      PaystackWebhookService.cleanString(headers["X-Paystack-Signature"])
    );
  }

  static normalizeSignature(value) {
    const signature = PaystackWebhookService.cleanString(value);

    if (!signature) {
      return null;
    }

    const normalizedSignature = signature.toLowerCase();

    /*
     * SHA-512 produces 64 bytes,
     * represented as 128 hexadecimal characters.
     */
    if (!/^[a-f0-9]{128}$/.test(normalizedSignature)) {
      return null;
    }

    return normalizedSignature;
  }

  static getSignaturePayload({ rawBody = null, payload = null }) {
    /*
     * Prefer the exact raw request bytes whenever
     * the HTTP layer preserved them.
     */
    if (Buffer.isBuffer(rawBody)) {
      return rawBody;
    }

    if (typeof rawBody === "string") {
      return Buffer.from(rawBody, "utf8");
    }

    /*
     * Paystack's Node webhook example also
     * supports signing JSON.stringify(req.body).
     *
     * Raw body remains preferable because it
     * preserves the exact request representation.
     */
    if (payload !== null && payload !== undefined) {
      return Buffer.from(JSON.stringify(payload), "utf8");
    }

    throw new Error("Paystack webhook payload is required for signature verification.");
  }

  static signaturesMatch(expectedSignature, receivedSignature) {
    const normalizedExpected = PaystackWebhookService.normalizeSignature(expectedSignature);

    const normalizedReceived = PaystackWebhookService.normalizeSignature(receivedSignature);

    if (!normalizedExpected || !normalizedReceived) {
      return false;
    }

    const expectedBuffer = Buffer.from(normalizedExpected, "hex");

    const receivedBuffer = Buffer.from(normalizedReceived, "hex");

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  }

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

  /* ─────────────────────────────── PLATFORM SETTINGS ─────────────────────────────── */

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

  /* ─────────────────────────────── COUNTRY / CURRENCY VALIDATION ─────────────────────────────── */

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
      ? settings.activeCountryCodes
          .map((item) => PaystackWebhookService.cleanUpperString(item))
          .filter(Boolean)
      : [];

    const supportedCurrencies = Array.isArray(settings.supportedCurrencies)
      ? settings.supportedCurrencies
          .map((item) => PaystackWebhookService.cleanUpperString(item))
          .filter(Boolean)
      : [];

    if (!activeCountryCodes.includes(countryCode)) {
      throw new Error(`${countryCode} is not an active Loqum country.`);
    }

    if (!supportedCurrencies.includes(currency)) {
      throw new Error(`${currency} is not a supported Loqum currency.`);
    }

    const hasCountrySetting = Array.isArray(settings.countrySettings)
      ? settings.countrySettings.some(
          (countrySetting) =>
            countrySetting.isActive &&
            PaystackWebhookService.cleanUpperString(countrySetting.countryCode) === countryCode &&
            PaystackWebhookService.cleanUpperString(countrySetting.currency) === currency
        )
      : false;

    if (!hasCountrySetting) {
      throw new Error(`No active country setting found for ${countryCode}/${currency}.`);
    }

    return {
      countryCode,
      currency,
    };
  }

  /* ─────────────────────────────── PROVIDER EVENT COMPATIBILITY ─────────────────────────────── */

  static isRefundLifecycleEvent(eventName) {
    const normalizedEventName = PaystackWebhookService.cleanLowerString(eventName);

    return (
      Boolean(normalizedEventName) &&
      PaystackWebhookService.refundEventNames.includes(normalizedEventName)
    );
  }

  static isTransferLifecycleEvent(eventName) {
    const normalizedEventName = PaystackWebhookService.cleanLowerString(eventName);

    return (
      Boolean(normalizedEventName) &&
      PaystackWebhookService.transferEventNames.includes(normalizedEventName)
    );
  }

  static getNormalizedTransferReference(normalizedEvent = {}) {
    const normalizedPayload =
      normalizedEvent.normalizedPayload &&
      typeof normalizedEvent.normalizedPayload === "object" &&
      !Array.isArray(normalizedEvent.normalizedPayload)
        ? normalizedEvent.normalizedPayload
        : {};

    return (
      PaystackWebhookService.cleanString(normalizedPayload.paystackTransferReference) ||
      PaystackWebhookService.cleanString(normalizedPayload.transferReference) ||
      PaystackWebhookService.cleanString(normalizedEvent.providerReference)
    );
  }

  static getAllowedWithdrawalTransferCategories(eventName) {
    const normalizedEventName = PaystackWebhookService.cleanLowerString(eventName);

    if (normalizedEventName === "transfer.success") {
      return [
        "withdrawal_transfer",
        "employer_withdrawal_payout",
        "professional_withdrawal_payout",
      ];
    }

    if (["transfer.failed", "transfer.reversed"].includes(normalizedEventName)) {
      return [
        "transfer_reversal",
        "employer_withdrawal_reversal",
        "professional_withdrawal_reversal",
      ];
    }

    return [];
  }

  static assertNormalizedEventCompatibility({ normalizedEvent }) {
    if (!normalizedEvent || typeof normalizedEvent !== "object" || Array.isArray(normalizedEvent)) {
      throw new Error("Paystack event normalizer returned an invalid event.");
    }

    const provider = PaystackWebhookService.cleanLowerString(normalizedEvent.provider);

    const eventName = PaystackWebhookService.cleanLowerString(normalizedEvent.eventName);

    const eventCategory = PaystackWebhookService.cleanLowerString(normalizedEvent.eventCategory);

    if (provider !== "paystack") {
      throw new Error("Paystack webhook normalizer must return paystack as provider.");
    }

    if (!eventName) {
      throw new Error("Normalized Paystack event name is required.");
    }

    if (!eventCategory) {
      throw new Error("Normalized Paystack event category is required.");
    }

    if (PaystackWebhookService.isRefundLifecycleEvent(eventName)) {
      /*
       * Fail closed rather than accidentally recording a
       * refund webhook as "other".
       *
       * paystackEventNormalizerService owns the provider
       * payload shape. This webhook service should not
       * independently reinterpret Paystack's refund payload.
       */
      if (eventCategory !== "employer_refund") {
        throw new Error(
          `Paystack refund event ${eventName} was not normalized as employer_refund.`
        );
      }
    }

    if (PaystackWebhookService.isTransferLifecycleEvent(eventName)) {
      const transferReference =
        PaystackWebhookService.getNormalizedTransferReference(normalizedEvent);

      if (!transferReference) {
        throw new Error(
          `Paystack Transfer event ${eventName} requires the provider Transfer reference.`
        );
      }

      const allowedCategories =
        PaystackWebhookService.getAllowedWithdrawalTransferCategories(eventName);

      if (!allowedCategories.includes(eventCategory)) {
        throw new Error(
          `Paystack Transfer event ${eventName} was normalized to unsupported category ${eventCategory}.`
        );
      }
    }

    return {
      provider,
      eventName,
      eventCategory,
    };
  }

  static processorSupportsEmployerRefund() {
    const categories = ProviderEventProcessorService?.eventCategories?.employerRefund;

    return Array.isArray(categories) && categories.includes("employer_refund");
  }

  /* ─────────────────────────────── EVENT NORMALIZATION ─────────────────────────────── */

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

    const finalNormalizedEvent = {
      ...normalizedEvent,

      countryCode: validated.countryCode,

      currency: validated.currency,

      normalizedPayload: {
        ...(normalizedEvent.normalizedPayload || {}),

        countryCode: validated.countryCode,

        currency: validated.currency,
      },
    };

    PaystackWebhookService.assertNormalizedEventCompatibility({
      normalizedEvent: finalNormalizedEvent,
    });

    return finalNormalizedEvent;
  }

  /* ─────────────────────────────── WEBHOOK RECORDING ─────────────────────────────── */

  static async recordPaystackWebhookEvent(
    {
      payload,

      rawBody = null,

      rawHeaders = {},

      processImmediately = false,

      currentTime = new Date(),
    },
    options = {}
  ) {
    const normalizedCurrentTime = PaystackWebhookService.normalizeCurrentTime(currentTime);

    /*
     * SECURITY BOUNDARY:
     *
     * Never create a ProviderEvent for an unverified
     * request.
     *
     * ProviderEvent.eventKey is an idempotency key.
     * Allowing an unsigned request to claim that key
     * could prevent a later legitimate Paystack
     * webhook from being recorded.
     */
    const isVerified = PaystackWebhookService.verifySignature({
      rawBody,
      payload,
      rawHeaders,
    });

    if (!isVerified) {
      return {
        providerEvent: null,

        created: false,

        idempotent: false,

        recorded: false,

        isVerified: false,

        processedImmediately: false,

        skippedProcessingReason: "Invalid Paystack webhook signature.",
      };
    }

    /*
     * Only verified provider requests are permitted to
     * trigger platform-setting lookups, normalization
     * and ProviderEvent persistence.
     */
    const normalizedEvent = await PaystackWebhookService.normalizePaystackEvent(
      {
        payload,
        rawHeaders,
      },
      options
    );

    /*
     * Record the provider event through its own
     * transaction boundary.
     *
     * Do not wrap both recording and all downstream
     * financial processing inside one broad webhook
     * transaction. The durable provider event should
     * exist independently before ledger/refund work
     * begins.
     *
     * If the caller explicitly supplies a session,
     * that caller remains responsible for its
     * transaction boundary.
     */
    const recordResult = await ProviderEventService.recordProviderEvent(
      {
        ...normalizedEvent,

        isVerified: true,

        currentTime: normalizedCurrentTime,
      },
      options
    );

    const providerEvent = recordResult.providerEvent;

    /*
     * Protect against legacy ProviderEvent rows that
     * may have been created before the verify-first
     * rule was introduced.
     */
    if (!providerEvent.isVerified) {
      return {
        ...recordResult,

        recorded: true,

        isVerified: true,

        processedImmediately: false,

        skippedProcessingReason:
          "A duplicate legacy ProviderEvent exists but is not verified. Manual reconciliation is required.",
      };
    }

    if (!processImmediately) {
      return {
        ...recordResult,

        recorded: true,

        isVerified: true,

        processedImmediately: false,
      };
    }

    /*
     * During a staged deployment, do not allow an older
     * ProviderEventProcessorService to mark a valid
     * employer-refund event as ignored merely because
     * its processor has not been deployed yet.
     *
     * The durable ProviderEvent remains pending and can
     * be processed after the matching processor lands.
     */
    if (
      normalizedEvent.eventCategory === "employer_refund" &&
      !PaystackWebhookService.processorSupportsEmployerRefund()
    ) {
      return {
        ...recordResult,

        recorded: true,

        isVerified: true,

        processedImmediately: false,

        skippedProcessingReason: "Employer refund provider-event processing is not aligned yet.",
      };
    }

    const processResult = await ProviderEventProcessorService.processProviderEvent(
      {
        providerEventRecordId: providerEvent._id,
      },
      options
    );

    return {
      ...recordResult,

      recorded: true,

      isVerified: true,

      processedImmediately: true,

      processResult,
    };
  }
}

module.exports = PaystackWebhookService;
