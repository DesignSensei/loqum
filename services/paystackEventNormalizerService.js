// services/paystackEventNormalizerService.js

class PaystackEventNormalizerService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Clean lowercase string ---------- */
  static cleanLowerString(value) {
    const cleanValue = PaystackEventNormalizerService.cleanString(value);

    return cleanValue ? cleanValue.toLowerCase() : null;
  }

  /* ---------- Get Paystack event name ---------- */
  static getEventName(payload = {}) {
    return PaystackEventNormalizerService.cleanLowerString(payload.event);
  }

  /* ---------- Get Paystack data object ---------- */
  static getData(payload = {}) {
    return payload.data || {};
  }

  /* ---------- Get provider event ID ---------- */
  static getProviderEventId(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(payload.id) ||
      PaystackEventNormalizerService.cleanString(data.id)
    );
  }

  /* ---------- Get provider reference ---------- */
  static getProviderReference(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.reference) ||
      PaystackEventNormalizerService.cleanString(data.transfer_code) ||
      PaystackEventNormalizerService.cleanString(data.transaction_reference)
    );
  }

  /* ---------- Get amount ---------- */
  static getAmount(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return data.amount !== null && data.amount !== undefined ? data.amount : null;
  }

  /* ---------- Get provider fee ---------- */
  static getProviderFee(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return data.fees !== null && data.fees !== undefined ? data.fees : 0;
  }

  /* ---------- Get net amount ---------- */
  static getNetAmount(payload = {}) {
    const amount = PaystackEventNormalizerService.getAmount(payload);
    const providerFee = PaystackEventNormalizerService.getProviderFee(payload);

    if (amount === null || amount === undefined) {
      return null;
    }

    return amount - providerFee;
  }

  /* ---------- Get currency ---------- */
  static getCurrency(payload = {}, options = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return String(data.currency || options.defaultCurrency || "NGN")
      .toUpperCase()
      .trim();
  }

  /* ---------- Get country code ---------- */
  static getCountryCode(payload = {}, options = {}) {
    const currency = PaystackEventNormalizerService.getCurrency(payload, options);

    const mappedCountryCode = options.currencyCountryMap?.[currency];

    return String(options.countryCode || mappedCountryCode || options.defaultCountryCode || "NG")
      .toUpperCase()
      .trim();
  }

  /* ---------- Check if event is employer wallet funding ---------- */
  static isEmployerWalletFundingEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);
    const data = PaystackEventNormalizerService.getData(payload);

    if (eventName !== "charge.success") {
      return false;
    }

    const metadata = data.metadata || {};

    if (metadata.purpose === "wallet_topup" || metadata.paymentRail === "paystack_dva") {
      return true;
    }

    if (metadata.dvaId || metadata.employerProfileId) {
      return true;
    }

    if (data.dedicated_account || data.dedicatedAccount) {
      return true;
    }

    if (data.authorization?.receiver_bank_account_number) {
      return true;
    }

    const channel = PaystackEventNormalizerService.cleanLowerString(data.channel);

    return channel === "dedicated_nuban";
  }

  /* ---------- Check if event is shift checkout payment ---------- */
  static isShiftCheckoutPaymentEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);
    const data = PaystackEventNormalizerService.getData(payload);

    if (eventName !== "charge.success") {
      return false;
    }

    const metadata = data.metadata || {};

    return (
      metadata.purpose === "shift_funding" ||
      metadata.purpose === "shift_checkout" ||
      metadata.paymentRail === "paystack_checkout" ||
      Boolean(metadata.shiftId)
    );
  }

  /* ---------- Check if event is withdrawal payout success ---------- */
  static isWithdrawalPayoutEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    return eventName === "transfer.success";
  }

  /* ---------- Check if event is withdrawal reversal ---------- */
  static isWithdrawalReversalEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    return eventName === "transfer.failed" || eventName === "transfer.reversed";
  }

  /* ---------- Get event category ---------- */
  static getEventCategory(payload = {}) {
    if (PaystackEventNormalizerService.isEmployerWalletFundingEvent(payload)) {
      return "wallet_funding";
    }

    if (PaystackEventNormalizerService.isShiftCheckoutPaymentEvent(payload)) {
      return "checkout_payment";
    }

    if (PaystackEventNormalizerService.isWithdrawalPayoutEvent(payload)) {
      return "withdrawal_transfer";
    }

    if (PaystackEventNormalizerService.isWithdrawalReversalEvent(payload)) {
      return "transfer_reversal";
    }

    return "other";
  }

  /* ---------- Normalize Paystack metadata ---------- */
  static normalizeMetadata(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    const metadata = data.metadata || {};

    return {
      paystackCustomerCode:
        PaystackEventNormalizerService.cleanString(data.customer?.customer_code) ||
        PaystackEventNormalizerService.cleanString(data.customer_code),

      paystackCustomerId: data.customer?.id || data.customer_id || null,

      paystackDedicatedAccountId: data.dedicated_account?.id || data.dedicatedAccount?.id || null,

      bankName:
        PaystackEventNormalizerService.cleanString(data.authorization?.receiver_bank) ||
        PaystackEventNormalizerService.cleanString(data.dedicated_account?.bank?.name) ||
        PaystackEventNormalizerService.cleanString(data.dedicatedAccount?.bank?.name),

      accountNumber:
        PaystackEventNormalizerService.cleanString(
          data.authorization?.receiver_bank_account_number
        ) ||
        PaystackEventNormalizerService.cleanString(data.dedicated_account?.account_number) ||
        PaystackEventNormalizerService.cleanString(data.dedicatedAccount?.account_number),

      transferCode: PaystackEventNormalizerService.cleanString(data.transfer_code),

      transferReference: PaystackEventNormalizerService.cleanString(data.reference),

      recipientCode:
        PaystackEventNormalizerService.cleanString(data.recipient?.recipient_code) ||
        PaystackEventNormalizerService.cleanString(data.recipient_code),

      status: PaystackEventNormalizerService.cleanLowerString(data.status),

      gatewayResponse: PaystackEventNormalizerService.cleanString(data.gateway_response),

      reason:
        PaystackEventNormalizerService.cleanString(data.reason) ||
        PaystackEventNormalizerService.cleanString(data.failure_reason),

      metadata,
    };
  }

  /* ---------- Normalize Paystack event ---------- */
  static normalize(payload = {}, rawHeaders = {}, options = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    const eventName = PaystackEventNormalizerService.getEventName(payload);
    const providerEventId = PaystackEventNormalizerService.getProviderEventId(payload);
    const providerReference = PaystackEventNormalizerService.getProviderReference(payload);

    const amount = PaystackEventNormalizerService.getAmount(payload);
    const providerFee = PaystackEventNormalizerService.getProviderFee(payload);
    const netAmount = PaystackEventNormalizerService.getNetAmount(payload);

    const currency = PaystackEventNormalizerService.getCurrency(payload, options);
    const countryCode = PaystackEventNormalizerService.getCountryCode(payload, options);
    const eventCategory = PaystackEventNormalizerService.getEventCategory(payload);
    const metadata = PaystackEventNormalizerService.normalizeMetadata(payload);

    const paystackMetadata = metadata.metadata || {};

    return {
      provider: "paystack",
      eventName,
      eventCategory,

      providerEventId,
      providerReference,

      countryCode,
      currency,

      amount,
      providerFee,
      netAmount,

      rawPayload: payload,
      rawHeaders,

      normalizedPayload: {
        eventName,
        eventCategory,

        providerEventId,
        providerReference,

        countryCode,
        currency,

        amount,
        providerFee,
        netAmount,

        paystackStatus: metadata.status,

        employerProfileId:
          PaystackEventNormalizerService.cleanString(paystackMetadata.employerProfileId) || null,

        professionalProfileId:
          PaystackEventNormalizerService.cleanString(paystackMetadata.professionalProfileId) ||
          null,

        dvaId: PaystackEventNormalizerService.cleanString(paystackMetadata.dvaId) || null,

        withdrawalTransactionId:
          PaystackEventNormalizerService.cleanString(paystackMetadata.withdrawalTransactionId) ||
          PaystackEventNormalizerService.cleanString(paystackMetadata.transactionId) ||
          null,

        transactionId:
          PaystackEventNormalizerService.cleanString(paystackMetadata.transactionId) ||
          PaystackEventNormalizerService.cleanString(paystackMetadata.withdrawalTransactionId) ||
          null,

        transferCode: metadata.transferCode,

        paystackTransferCode: metadata.transferCode,

        transferReference: metadata.transferReference,

        paystackTransferReference:
          PaystackEventNormalizerService.cleanString(paystackMetadata.paystackTransferReference) ||
          PaystackEventNormalizerService.cleanString(paystackMetadata.transferReference) ||
          metadata.transferReference ||
          providerReference,

        reversalReason:
          metadata.reason ||
          metadata.gatewayResponse ||
          "Paystack reported transfer failed or reversed.",

        metadata,
      },
    };
  }
}

module.exports = PaystackEventNormalizerService;
