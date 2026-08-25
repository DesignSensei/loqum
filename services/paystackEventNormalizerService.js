// services/paystackEventNormalizerService.js

const REFUND_EVENT_NAMES = new Set([
  "refund.pending",
  "refund.processing",
  "refund.needs-attention",
  "refund.failed",
  "refund.processed",
]);

class PaystackEventNormalizerService {
  /* ─────────────────────────────── STRING NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const cleanValue = String(value).trim();

    return cleanValue || null;
  }

  static cleanLowerString(value) {
    const cleanValue = PaystackEventNormalizerService.cleanString(value);

    return cleanValue ? cleanValue.toLowerCase() : null;
  }

  static cleanUpperString(value) {
    const cleanValue = PaystackEventNormalizerService.cleanString(value);

    return cleanValue ? cleanValue.toUpperCase() : null;
  }

  /* ─────────────────────────────── NUMERIC NORMALIZATION ─────────────────────────────── */

  static normalizeNonNegativeMinorUnitAmount(value, { defaultValue = null } = {}) {
    if (value === null || value === undefined || value === "") {
      return defaultValue;
    }

    const normalizedValue = Number(value);

    if (!Number.isSafeInteger(normalizedValue) || normalizedValue < 0) {
      return defaultValue;
    }

    return normalizedValue;
  }

  static normalizeOptionalProviderId(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return PaystackEventNormalizerService.cleanString(value);
  }

  /* ─────────────────────────────── BASE EVENT SHAPE ─────────────────────────────── */

  static getEventName(payload = {}) {
    return PaystackEventNormalizerService.cleanLowerString(payload.event);
  }

  static getData(payload = {}) {
    const data = payload?.data;

    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  static getPaystackMetadata(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    const metadata = data?.metadata;

    return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  }

  /* ─────────────────────────────── EVENT IDENTITY ─────────────────────────────── */

  /**
   * Provider event ID means an ID identifying the WEBHOOK EVENT itself.
   *
   * Do not fall back to data.id.
   *
   * Paystack commonly places the affected resource inside data. For example:
   *
   * - charge data.id = transaction resource ID
   * - transfer data.id = transfer resource ID
   * - refund data.id, when present = refund resource ID
   *
   * Treating those values as webhook-event IDs creates false deduplication
   * across lifecycle events concerning the same provider resource.
   */
  static getProviderEventId(payload = {}) {
    return (
      PaystackEventNormalizerService.cleanString(payload.id) ||
      PaystackEventNormalizerService.cleanString(payload.event_id) ||
      PaystackEventNormalizerService.cleanString(payload.eventId) ||
      null
    );
  }

  /* ─────────────────────────────── REFUND IDENTIFICATION ─────────────────────────────── */

  static isRefundLifecycleEvent(payload = {}) {
    const eventName =
      typeof payload === "string"
        ? PaystackEventNormalizerService.cleanLowerString(payload)
        : PaystackEventNormalizerService.getEventName(payload);

    return REFUND_EVENT_NAMES.has(eventName);
  }

  /**
   * Paystack Refund API resources contain an `id`.
   *
   * Paystack's documented refund webhook sample does not include that field,
   * so this must remain nullable.
   */
  static getProviderRefundId(payload = {}) {
    if (!PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return null;
    }

    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.normalizeOptionalProviderId(data.refund_id) ||
      PaystackEventNormalizerService.normalizeOptionalProviderId(data.refundId) ||
      PaystackEventNormalizerService.normalizeOptionalProviderId(data.id) ||
      null
    );
  }

  /**
   * Paystack refund webhook notifications may expose `refund_reference`.
   *
   * It can legitimately be null, particularly early in the provider
   * lifecycle, so this field must also remain nullable.
   */
  static getProviderRefundReference(payload = {}) {
    if (!PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return null;
    }

    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.refund_reference) ||
      PaystackEventNormalizerService.cleanString(data.refundReference) ||
      null
    );
  }

  /* ─────────────────────────────── ORIGINAL TRANSACTION ─────────────────────────────── */

  static getOriginalTransactionReference(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    const transaction = data.transaction;

    const nestedTransactionReference =
      transaction && typeof transaction === "object" && !Array.isArray(transaction)
        ? transaction.reference
        : null;

    return (
      PaystackEventNormalizerService.cleanString(data.transaction_reference) ||
      PaystackEventNormalizerService.cleanString(data.transactionReference) ||
      PaystackEventNormalizerService.cleanString(nestedTransactionReference) ||
      PaystackEventNormalizerService.cleanString(data.original_transaction_reference) ||
      PaystackEventNormalizerService.cleanString(data.originalTransactionReference) ||
      null
    );
  }

  static getOriginalTransactionProviderId(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    const transaction = data.transaction;

    if (transaction && typeof transaction === "object" && !Array.isArray(transaction)) {
      return PaystackEventNormalizerService.normalizeOptionalProviderId(transaction.id) || null;
    }

    const explicitTransactionId = data.transaction_id ?? data.transactionId;

    if (explicitTransactionId !== null && explicitTransactionId !== undefined) {
      return PaystackEventNormalizerService.normalizeOptionalProviderId(explicitTransactionId);
    }

    /*
     * Refund list/fetch responses may expose `transaction` directly as
     * the Paystack transaction ID.
     *
     * Do not interpret an arbitrary non-numeric transaction reference
     * string as a provider transaction ID.
     */
    if (typeof transaction === "number" && Number.isSafeInteger(transaction)) {
      return String(transaction);
    }

    if (typeof transaction === "string" && /^\d+$/.test(transaction.trim())) {
      return transaction.trim();
    }

    return null;
  }

  /* ─────────────────────────────── PROVIDER REFERENCE ─────────────────────────────── */

  static getProviderReference(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    /*
     * For refund lifecycle events the principal providerReference remains
     * the ORIGINAL Paystack transaction reference.
     *
     * The refund resource has dedicated providerRefundId and
     * providerRefundReference fields.
     *
     * This allows downstream reconciliation to find the original protected
     * Shift payment without confusing that reference with the refund itself.
     */
    if (PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return (
        PaystackEventNormalizerService.getOriginalTransactionReference(payload) ||
        PaystackEventNormalizerService.getProviderRefundReference(payload) ||
        null
      );
    }

    return (
      PaystackEventNormalizerService.cleanString(data.reference) ||
      PaystackEventNormalizerService.cleanString(data.transfer_code) ||
      PaystackEventNormalizerService.cleanString(data.transaction_reference) ||
      null
    );
  }

  /* ─────────────────────────────── MONEY ─────────────────────────────── */

  static getAmount(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.normalizeNonNegativeMinorUnitAmount(data.amount);
  }

  static getProviderFee(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.normalizeNonNegativeMinorUnitAmount(data.fees, {
      defaultValue: 0,
    });
  }

  static getNetAmount(payload = {}) {
    const amount = PaystackEventNormalizerService.getAmount(payload);

    const providerFee = PaystackEventNormalizerService.getProviderFee(payload);

    if (amount === null) {
      return null;
    }

    const netAmount = amount - providerFee;

    return Number.isSafeInteger(netAmount) ? netAmount : null;
  }

  /* ─────────────────────────────── CURRENCY / COUNTRY ─────────────────────────────── */

  static getCurrency(payload = {}, options = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanUpperString(
        data.currency || options.defaultCurrency || "NGN"
      ) || "NGN"
    );
  }

  static getCountryCode(payload = {}, options = {}) {
    const currency = PaystackEventNormalizerService.getCurrency(payload, options);

    const mappedCountryCode = options.currencyCountryMap?.[currency];

    return (
      PaystackEventNormalizerService.cleanUpperString(
        options.countryCode || mappedCountryCode || options.defaultCountryCode || "NG"
      ) || "NG"
    );
  }

  /* ─────────────────────────────── REFUND DETAILS ─────────────────────────────── */

  static getRefundStatus(payload = {}) {
    if (!PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return null;
    }

    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.cleanLowerString(data.status);
  }

  static getRefundMerchantNote(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.merchant_note) ||
      PaystackEventNormalizerService.cleanString(data.merchantNote) ||
      null
    );
  }

  static getRefundCustomerNote(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.customer_note) ||
      PaystackEventNormalizerService.cleanString(data.customerNote) ||
      null
    );
  }

  static getRefundTraceKey(payload = {}) {
    const merchantNote = PaystackEventNormalizerService.getRefundMerchantNote(payload);

    if (!merchantNote) {
      return null;
    }

    /*
     * Loqum embeds its internal refund reconciliation trace inside
     * merchant_note as:
     *
     * key=<internal-trace-key>
     *
     * This is a Loqum reconciliation marker, not Paystack idempotency.
     */
    const match = merchantNote.match(/(?:^|[\s;|,])key=([^\s;|,\]]+)/i);

    return match?.[1] ? PaystackEventNormalizerService.cleanString(match[1]) : null;
  }

  static getRefundProcessor(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.cleanString(data.processor);
  }

  static getRefundReason(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.reason) ||
      PaystackEventNormalizerService.cleanString(data.failure_reason) ||
      null
    );
  }

  static getRefundDeductedAmount(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.normalizeNonNegativeMinorUnitAmount(
      data.deducted_amount ?? data.deductedAmount
    );
  }

  static getRefundFullyDeducted(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    const value = data.fully_deducted ?? data.fullyDeducted;

    return typeof value === "boolean" ? value : null;
  }

  static getRefundExpectedAt(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.expected_at) ||
      PaystackEventNormalizerService.cleanString(data.expectedAt) ||
      null
    );
  }

  static getRefundedAt(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return (
      PaystackEventNormalizerService.cleanString(data.refunded_at) ||
      PaystackEventNormalizerService.cleanString(data.refundedAt) ||
      null
    );
  }

  /* ─────────────────────────────── EVENT CLASSIFICATION ─────────────────────────────── */

  static isShiftCheckoutPaymentEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    if (eventName !== "charge.success") {
      return false;
    }

    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);

    const purpose = PaystackEventNormalizerService.cleanLowerString(metadata.purpose);

    const fundingType = PaystackEventNormalizerService.cleanLowerString(metadata.fundingType);

    const paymentRail = PaystackEventNormalizerService.cleanLowerString(metadata.paymentRail);

    const shiftId = PaystackEventNormalizerService.cleanString(metadata.shiftId);

    if (["shift_funding", "shift_checkout"].includes(purpose)) {
      return true;
    }

    if (fundingType === "shift_base_funding") {
      return true;
    }

    return paymentRail === "paystack_checkout" && Boolean(shiftId);
  }

  static isEmployerWalletFundingEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    const data = PaystackEventNormalizerService.getData(payload);

    if (eventName !== "charge.success") {
      return false;
    }

    /*
     * Shift Checkout and DVA deposits both arrive as charge.success.
     * Shift Checkout must be excluded before checking DVA signals.
     */
    if (PaystackEventNormalizerService.isShiftCheckoutPaymentEvent(payload)) {
      return false;
    }

    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);

    const purpose = PaystackEventNormalizerService.cleanLowerString(metadata.purpose);

    const paymentRail = PaystackEventNormalizerService.cleanLowerString(metadata.paymentRail);

    if (purpose === "wallet_topup" || paymentRail === "paystack_dva") {
      return true;
    }

    if (PaystackEventNormalizerService.cleanString(metadata.dvaId)) {
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

  static isWithdrawalPayoutEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    return eventName === "transfer.success";
  }

  static isWithdrawalReversalEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    return eventName === "transfer.failed" || eventName === "transfer.reversed";
  }

  static getEventCategory(payload = {}) {
    /*
     * Refund must be checked independently before charge/transfer
     * classification.
     */
    if (PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return "employer_refund";
    }

    /*
     * Shift Checkout must be checked before wallet funding because both use
     * charge.success and both can contain employerProfileId metadata.
     */
    if (PaystackEventNormalizerService.isShiftCheckoutPaymentEvent(payload)) {
      return "shift_checkout_payment";
    }

    if (PaystackEventNormalizerService.isEmployerWalletFundingEvent(payload)) {
      return "wallet_funding";
    }

    if (PaystackEventNormalizerService.isWithdrawalPayoutEvent(payload)) {
      return "withdrawal_transfer";
    }

    if (PaystackEventNormalizerService.isWithdrawalReversalEvent(payload)) {
      return "transfer_reversal";
    }

    return "other";
  }

  /* ─────────────────────────────── NORMALIZED PROVIDER METADATA ─────────────────────────────── */

  static normalizeMetadata(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);

    const providerRefundId = PaystackEventNormalizerService.getProviderRefundId(payload);

    const providerRefundReference =
      PaystackEventNormalizerService.getProviderRefundReference(payload);

    const originalTransactionReference =
      PaystackEventNormalizerService.getOriginalTransactionReference(payload);

    const originalTransactionProviderId =
      PaystackEventNormalizerService.getOriginalTransactionProviderId(payload);

    return {
      paystackCustomerCode:
        PaystackEventNormalizerService.cleanString(data.customer?.customer_code) ||
        PaystackEventNormalizerService.cleanString(data.customer_code),

      paystackCustomerId: data.customer?.id || data.customer_id || null,

      customerEmail:
        PaystackEventNormalizerService.cleanLowerString(data.customer?.email) ||
        PaystackEventNormalizerService.cleanLowerString(data.email),

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

      channel: PaystackEventNormalizerService.cleanLowerString(data.channel),

      paidAt:
        PaystackEventNormalizerService.cleanString(data.paid_at) ||
        PaystackEventNormalizerService.cleanString(data.paidAt),

      gatewayResponse: PaystackEventNormalizerService.cleanString(data.gateway_response),

      reason:
        PaystackEventNormalizerService.cleanString(data.reason) ||
        PaystackEventNormalizerService.cleanString(data.failure_reason),

      purpose: PaystackEventNormalizerService.cleanLowerString(metadata.purpose),

      fundingType: PaystackEventNormalizerService.cleanLowerString(metadata.fundingType),

      paymentRail: PaystackEventNormalizerService.cleanLowerString(metadata.paymentRail),

      /* ───────── REFUND PROVIDER STATE ───────── */

      providerRefundId,

      providerRefundReference,

      refundStatus: PaystackEventNormalizerService.getRefundStatus(payload),

      originalTransactionReference,

      originalTransactionProviderId,

      refundMerchantNote: PaystackEventNormalizerService.getRefundMerchantNote(payload),

      refundCustomerNote: PaystackEventNormalizerService.getRefundCustomerNote(payload),

      refundTraceKey: PaystackEventNormalizerService.getRefundTraceKey(payload),

      refundProcessor: PaystackEventNormalizerService.getRefundProcessor(payload),

      refundReason: PaystackEventNormalizerService.getRefundReason(payload),

      refundDeductedAmount: PaystackEventNormalizerService.getRefundDeductedAmount(payload),

      refundFullyDeducted: PaystackEventNormalizerService.getRefundFullyDeducted(payload),

      refundExpectedAt: PaystackEventNormalizerService.getRefundExpectedAt(payload),

      refundedAt: PaystackEventNormalizerService.getRefundedAt(payload),

      metadata,
    };
  }

  /* ─────────────────────────────── NORMALIZE PAYSTACK EVENT ─────────────────────────────── */

  static normalize(payload = {}, rawHeaders = {}, options = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    const eventCategory = PaystackEventNormalizerService.getEventCategory(payload);

    const providerEventId = PaystackEventNormalizerService.getProviderEventId(payload);

    const providerReference = PaystackEventNormalizerService.getProviderReference(payload);

    const providerRefundId = PaystackEventNormalizerService.getProviderRefundId(payload);

    const providerRefundReference =
      PaystackEventNormalizerService.getProviderRefundReference(payload);

    const amount = PaystackEventNormalizerService.getAmount(payload);

    const providerFee = PaystackEventNormalizerService.getProviderFee(payload);

    const netAmount = PaystackEventNormalizerService.getNetAmount(payload);

    const currency = PaystackEventNormalizerService.getCurrency(payload, options);

    const countryCode = PaystackEventNormalizerService.getCountryCode(payload, options);

    const metadata = PaystackEventNormalizerService.normalizeMetadata(payload);

    const paystackMetadata = metadata.metadata || {};

    const employerProfileId =
      PaystackEventNormalizerService.cleanString(paystackMetadata.employerProfileId) || null;

    const professionalProfileId =
      PaystackEventNormalizerService.cleanString(paystackMetadata.professionalProfileId) || null;

    const dvaId = PaystackEventNormalizerService.cleanString(paystackMetadata.dvaId) || null;

    const shiftId = PaystackEventNormalizerService.cleanString(paystackMetadata.shiftId) || null;

    const shiftReferenceCode =
      PaystackEventNormalizerService.cleanString(paystackMetadata.shiftReferenceCode) ||
      PaystackEventNormalizerService.cleanString(paystackMetadata.referenceCode) ||
      null;

    const withdrawalTransactionId =
      PaystackEventNormalizerService.cleanString(paystackMetadata.withdrawalTransactionId) ||
      PaystackEventNormalizerService.cleanString(paystackMetadata.transactionId) ||
      null;

    /*
     * `transaction` on ProviderEvent is Loqum's internal Transaction ObjectId.
     *
     * Do NOT put the Paystack transaction ID into this field.
     *
     * Refund webhooks normally resolve their internal Transaction/batch
     * ownership later through ProviderEventProcessorService using the
     * original provider transaction reference.
     */
    const transactionId =
      PaystackEventNormalizerService.cleanString(paystackMetadata.transactionId) ||
      PaystackEventNormalizerService.cleanString(paystackMetadata.withdrawalTransactionId) ||
      null;

    const originalTransactionReference = metadata.originalTransactionReference || null;

    const originalTransactionProviderId = metadata.originalTransactionProviderId || null;

    return {
      provider: "paystack",

      eventName,

      eventCategory,

      providerEventId,

      providerReference,

      providerRefundId,

      providerRefundReference,

      countryCode,

      currency,

      amount,

      providerFee,

      netAmount,

      employer: employerProfileId,

      professional: professionalProfileId,

      transaction: transactionId,

      dva: dvaId,

      shift: shiftId,

      rawPayload: payload,

      rawHeaders,

      metadata: {
        normalizer: "PaystackEventNormalizerService",

        purpose: metadata.purpose,

        fundingType: metadata.fundingType,

        paymentRail: metadata.paymentRail,

        refundStatus: metadata.refundStatus,

        refundTraceKey: metadata.refundTraceKey,
      },

      normalizedPayload: {
        eventName,

        eventCategory,

        providerEventId,

        /*
         * providerReference for refund events is deliberately the original
         * transaction reference rather than the refund resource reference.
         */
        providerReference,

        paystackReference: providerReference,

        providerRefundId,

        providerRefundReference,

        paystackRefundId: providerRefundId,

        paystackRefundReference: providerRefundReference,

        originalTransactionReference,

        originalTransactionProviderId,

        paystackTransactionReference: originalTransactionReference,

        paystackTransactionId: originalTransactionProviderId,

        countryCode,

        currency,

        amount,

        providerFee,

        netAmount,

        paystackStatus: metadata.status,

        customerEmail: metadata.customerEmail,

        channel: metadata.channel,

        paidAt: metadata.paidAt,

        gatewayResponse: metadata.gatewayResponse,

        purpose: metadata.purpose,

        fundingType: metadata.fundingType,

        paymentRail: metadata.paymentRail,

        employerProfileId,

        professionalProfileId,

        dvaId,

        shiftId,

        shiftReferenceCode,

        withdrawalTransactionId,

        transactionId,

        transferCode: metadata.transferCode,

        paystackTransferCode: metadata.transferCode,

        transferReference: metadata.transferReference,

        paystackTransferReference:
          PaystackEventNormalizerService.cleanString(paystackMetadata.paystackTransferReference) ||
          PaystackEventNormalizerService.cleanString(paystackMetadata.transferReference) ||
          metadata.transferReference ||
          (eventCategory === "withdrawal_transfer" || eventCategory === "transfer_reversal"
            ? providerReference
            : null),

        reversalReason:
          eventCategory === "transfer_reversal"
            ? metadata.reason ||
              metadata.gatewayResponse ||
              "Paystack reported transfer failed or reversed."
            : null,

        /* ───────── EMPLOYER REFUND ───────── */

        refundStatus: metadata.refundStatus,

        paystackRefundStatus: metadata.refundStatus,

        refundMerchantNote: metadata.refundMerchantNote,

        refundCustomerNote: metadata.refundCustomerNote,

        refundTraceKey: metadata.refundTraceKey,

        refundProcessor: metadata.refundProcessor,

        refundReason: metadata.refundReason,

        refundDeductedAmount: metadata.refundDeductedAmount,

        refundFullyDeducted: metadata.refundFullyDeducted,

        refundExpectedAt: metadata.refundExpectedAt,

        refundedAt: metadata.refundedAt,

        metadata,
      },
    };
  }
}

module.exports = PaystackEventNormalizerService;
