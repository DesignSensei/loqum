// services/paystackEventNormalizerService.js

const REFUND_EVENT_NAMES = new Set([
  "refund.pending",
  "refund.processing",
  "refund.needs-attention",
  "refund.failed",
  "refund.processed",
]);

const DVA_ASSIGNMENT_EVENT_NAMES = new Set([
  "dedicatedaccount.assign.success",
  "dedicatedaccount.assign.failed",
]);

class PaystackEventNormalizerService {
  static cleanString(value) {
    if (value === null || value === undefined) return null;

    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) {
      throw new Error("Provider text must be a string or safe integer identifier.");
    }

    return String(value).trim() || null;
  }

  static cleanLowerString(value) {
    const cleaned = PaystackEventNormalizerService.cleanString(value);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  static cleanUpperString(value) {
    const cleaned = PaystackEventNormalizerService.cleanString(value);
    return cleaned ? cleaned.toUpperCase() : null;
  }

  static normalizeNonNegativeMinorUnitAmount(value, { defaultValue = null } = {}) {
    if (value === null || value === undefined) return defaultValue;

    if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) {
      throw new Error("Provider amount must be an integer in minor units.");
    }

    const amount = Number(value);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("Provider amount must be a non-negative safe integer.");
    }

    return amount;
  }

  static normalizeOptionalProviderId(value) {
    if (value === null || value === undefined) return null;

    const id = PaystackEventNormalizerService.cleanString(value);

    if (!id || !/^[1-9]\d*$/.test(id)) {
      throw new Error("Provider resource ID must be a positive integer identifier.");
    }

    return id;
  }

  static getEventName(payload = {}) {
    return PaystackEventNormalizerService.cleanLowerString(payload.event);
  }

  static getData(payload = {}) {
    const data = payload?.data;

    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  static getPaystackMetadata(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    let metadata = data.metadata;

    if (
      metadata === null ||
      metadata === undefined ||
      (typeof metadata === "string" && !metadata.trim())
    ) {
      return {};
    }

    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        throw new Error("Paystack metadata must contain a valid JSON object.");
      }
    }

    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("Paystack metadata must be an object.");
    }

    return metadata;
  }

  static getTransferRecipientMetadata(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    const recipient =
      data.recipient && typeof data.recipient === "object" && !Array.isArray(data.recipient)
        ? data.recipient
        : {};

    const metadata = recipient.metadata;

    return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  }

  static getWithdrawalMetadata(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    if (!["transfer.success", "transfer.failed", "transfer.reversed"].includes(eventName)) {
      return {};
    }

    return PaystackEventNormalizerService.getTransferRecipientMetadata(payload);
  }

  // ───────────────────────── PROVIDER EVENT IDENTITY ─────────────────────────

  static getProviderEventId(payload = {}) {
    // data.id belongs to the affected Paystack resource, not the webhook itself.
    return (
      PaystackEventNormalizerService.cleanString(payload.id) ||
      PaystackEventNormalizerService.cleanString(payload.event_id) ||
      PaystackEventNormalizerService.cleanString(payload.eventId) ||
      null
    );
  }

  // ───────────────────────── DVA ASSIGNMENT ─────────────────────────

  static isDVAAssignmentEvent(payload = {}) {
    const eventName =
      typeof payload === "string"
        ? PaystackEventNormalizerService.cleanLowerString(payload)
        : PaystackEventNormalizerService.getEventName(payload);

    return DVA_ASSIGNMENT_EVENT_NAMES.has(eventName);
  }

  static normalizeOptionalProviderBoolean(value) {
    if (value === null || value === undefined) return null;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;

    throw new Error("Paystack dedicated account boolean field is invalid.");
  }

  static getDVAAssignmentDetails(payload = {}) {
    if (!PaystackEventNormalizerService.isDVAAssignmentEvent(payload)) {
      return null;
    }

    const data = PaystackEventNormalizerService.getData(payload);

    const objectOrEmpty = (value) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : {};

    const dedicatedAccount = Object.keys(objectOrEmpty(data.dedicated_account)).length
      ? objectOrEmpty(data.dedicated_account)
      : Object.keys(objectOrEmpty(data.dedicatedAccount)).length
        ? objectOrEmpty(data.dedicatedAccount)
        : PaystackEventNormalizerService.getEventName(payload) === "dedicatedaccount.assign.success"
          ? data
          : {};

    const customer = Object.keys(objectOrEmpty(data.customer)).length
      ? objectOrEmpty(data.customer)
      : objectOrEmpty(dedicatedAccount.customer);

    const bank = Object.keys(objectOrEmpty(dedicatedAccount.bank)).length
      ? objectOrEmpty(dedicatedAccount.bank)
      : objectOrEmpty(data.bank);

    return {
      paystackCustomerId: PaystackEventNormalizerService.normalizeOptionalProviderId(
        customer.id ?? data.customer_id ?? data.customerId
      ),

      paystackCustomerCode: PaystackEventNormalizerService.cleanString(
        customer.customer_code ?? customer.customerCode ?? data.customer_code ?? data.customerCode
      ),

      customerEmail: PaystackEventNormalizerService.cleanLowerString(customer.email ?? data.email),

      paystackDedicatedAccountId: PaystackEventNormalizerService.normalizeOptionalProviderId(
        dedicatedAccount.id ?? data.dedicated_account_id ?? data.dedicatedAccountId
      ),

      accountNumber: PaystackEventNormalizerService.cleanString(
        dedicatedAccount.account_number ?? dedicatedAccount.accountNumber
      ),

      accountName: PaystackEventNormalizerService.cleanString(
        dedicatedAccount.account_name ?? dedicatedAccount.accountName
      ),

      bankId: PaystackEventNormalizerService.normalizeOptionalProviderId(
        bank.id ?? dedicatedAccount.bank_id
      ),

      bankName: PaystackEventNormalizerService.cleanString(bank.name ?? dedicatedAccount.bank_name),

      bankCode: PaystackEventNormalizerService.cleanString(bank.code ?? dedicatedAccount.bank_code),

      bankSlug: PaystackEventNormalizerService.cleanLowerString(
        bank.slug ?? dedicatedAccount.bank_slug
      ),

      providerSlug: PaystackEventNormalizerService.cleanLowerString(
        dedicatedAccount.provider_slug ?? bank.provider_slug ?? bank.slug
      ),

      assigned: PaystackEventNormalizerService.normalizeOptionalProviderBoolean(
        dedicatedAccount.assigned
      ),

      active: PaystackEventNormalizerService.normalizeOptionalProviderBoolean(
        dedicatedAccount.active
      ),

      currency: PaystackEventNormalizerService.cleanUpperString(
        dedicatedAccount.currency ?? data.currency
      ),

      countryCode: PaystackEventNormalizerService.cleanUpperString(
        data.identification?.country ?? data.country_code ?? data.country
      ),

      failureReason: PaystackEventNormalizerService.cleanString(
        data.reason ?? data.failure_reason ?? data.failureReason ?? data.message
      ),
    };
  }

  // ───────────────────────── REFUND IDENTIFICATION ─────────────────────────

  static isRefundLifecycleEvent(payload = {}) {
    const eventName =
      typeof payload === "string"
        ? PaystackEventNormalizerService.cleanLowerString(payload)
        : PaystackEventNormalizerService.getEventName(payload);

    return REFUND_EVENT_NAMES.has(eventName);
  }

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

  // ───────────────────────── ORIGINAL TRANSACTION ─────────────────────────

  static getOriginalTransactionReference(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    const transaction = data.transaction;

    const nestedReference =
      transaction && typeof transaction === "object" && !Array.isArray(transaction)
        ? transaction.reference
        : null;

    return (
      PaystackEventNormalizerService.cleanString(data.transaction_reference) ||
      PaystackEventNormalizerService.cleanString(data.transactionReference) ||
      PaystackEventNormalizerService.cleanString(nestedReference) ||
      PaystackEventNormalizerService.cleanString(data.original_transaction_reference) ||
      PaystackEventNormalizerService.cleanString(data.originalTransactionReference) ||
      null
    );
  }

  static getOriginalTransactionProviderId(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    const transaction = data.transaction;

    if (transaction && typeof transaction === "object" && !Array.isArray(transaction)) {
      return PaystackEventNormalizerService.normalizeOptionalProviderId(transaction.id);
    }

    const transactionId = data.transaction_id ?? data.transactionId;

    if (transactionId !== null && transactionId !== undefined) {
      return PaystackEventNormalizerService.normalizeOptionalProviderId(transactionId);
    }

    if (typeof transaction === "number") {
      return PaystackEventNormalizerService.normalizeOptionalProviderId(transaction);
    }

    if (typeof transaction === "string" && /^\d+$/.test(transaction.trim())) {
      return PaystackEventNormalizerService.normalizeOptionalProviderId(transaction.trim());
    }

    return null;
  }

  static getProviderReference(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    if (PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return PaystackEventNormalizerService.getOriginalTransactionReference(payload);
    }

    if (PaystackEventNormalizerService.getEventName(payload) === "charge.success") {
      return PaystackEventNormalizerService.cleanString(data.reference);
    }

    return (
      PaystackEventNormalizerService.cleanString(data.reference) ||
      PaystackEventNormalizerService.cleanString(data.transfer_code) ||
      PaystackEventNormalizerService.cleanString(data.transaction_reference) ||
      null
    );
  }

  // ───────────────────────── MONEY ─────────────────────────

  static getAmount(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.normalizeNonNegativeMinorUnitAmount(data.amount);
  }

  static getProviderFee(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);

    return PaystackEventNormalizerService.normalizeNonNegativeMinorUnitAmount(data.fees);
  }

  static getNetAmount(payload = {}) {
    const amount = PaystackEventNormalizerService.getAmount(payload);
    const providerFee = PaystackEventNormalizerService.getProviderFee(payload);

    if (amount === null || providerFee === null) return null;

    const netAmount = amount - providerFee;

    if (!Number.isSafeInteger(netAmount) || netAmount < 0) {
      throw new Error("Provider fee cannot exceed the event amount.");
    }

    return netAmount;
  }

  // ───────────────────────── CURRENCY / COUNTRY ─────────────────────────

  static getCurrency(payload = {}, options = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    const isMoneyEvent =
      eventName === "charge.success" ||
      eventName?.startsWith("transfer.") ||
      REFUND_EVENT_NAMES.has(eventName);

    const nestedDVACurrency = PaystackEventNormalizerService.isDVAAssignmentEvent(payload)
      ? (data.dedicated_account?.currency ?? data.dedicatedAccount?.currency)
      : null;

    const currency = PaystackEventNormalizerService.cleanUpperString(
      data.currency ?? nestedDVACurrency ?? (isMoneyEvent ? null : options.defaultCurrency)
    );

    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error(
        "Provider event requires a valid currency; financial events cannot use a default."
      );
    }

    return currency;
  }

  static getCountryCode(payload = {}, options = {}) {
    const currency = PaystackEventNormalizerService.getCurrency(payload, options);

    const mapped = PaystackEventNormalizerService.cleanUpperString(
      options.currencyCountryMap?.[currency]
    );

    const eventCountry = PaystackEventNormalizerService.isDVAAssignmentEvent(payload)
      ? PaystackEventNormalizerService.getDVAAssignmentDetails(payload)?.countryCode
      : null;

    const suppliedCountry = PaystackEventNormalizerService.cleanUpperString(options.countryCode);

    if (eventCountry && suppliedCountry && eventCountry !== suppliedCountry) {
      throw new Error("Paystack DVA assignment country conflicts with the supplied country.");
    }

    const explicit = eventCountry || suppliedCountry;

    if (mapped && explicit && mapped !== explicit) {
      throw new Error("Explicit provider country conflicts with the currency-country mapping.");
    }

    const defaultCurrency = PaystackEventNormalizerService.cleanUpperString(
      options.defaultCurrency
    );

    const country =
      explicit ||
      mapped ||
      (currency === defaultCurrency
        ? PaystackEventNormalizerService.cleanUpperString(options.defaultCountryCode)
        : null);

    if (!country || !/^[A-Z]{2}$/.test(country)) {
      throw new Error("Provider event country could not be resolved for its currency.");
    }

    return country;
  }

  // ───────────────────────── REFUND DETAILS ─────────────────────────

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

    if (!merchantNote) return null;

    const keys = merchantNote
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("key="))
      .map((part) => part.slice(4));

    const uniqueKeys = [...new Set(keys)];

    if (
      uniqueKeys.length > 1 ||
      uniqueKeys.some((key) => !key || key.length > 200 || /[\r\n]/.test(key))
    ) {
      throw new Error("Refund note contains an invalid or ambiguous trace key.");
    }

    return uniqueKeys[0] || null;
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

    if (value === null || value === undefined) return null;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;

    throw new Error("Refund fully-deducted value is invalid.");
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

  // ───────────────────────── EVENT CLASSIFICATION ─────────────────────────

  static isShiftCheckoutPaymentEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);

    if (eventName !== "charge.success") return false;

    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);
    const purpose = PaystackEventNormalizerService.cleanLowerString(metadata.purpose);

    if (["subscription_payment", "job_publication_purchase"].includes(purpose)) {
      return false;
    }

    const fundingType = PaystackEventNormalizerService.cleanLowerString(metadata.fundingType);

    const paymentRail = PaystackEventNormalizerService.cleanLowerString(metadata.paymentRail);

    const shiftId = PaystackEventNormalizerService.cleanString(metadata.shiftId);

    if (
      [
        "shift_funding",
        "shift_checkout",
        "shift_base_funding",
        "shift_topup",
        "shift_overtime_topup",
      ].includes(purpose)
    ) {
      return true;
    }

    if (["shift_base_funding", "shift_overtime_topup"].includes(fundingType)) {
      return true;
    }

    return paymentRail === "paystack_checkout" && Boolean(shiftId);
  }

  static isJobPublicationPaymentEvent(payload = {}) {
    if (PaystackEventNormalizerService.getEventName(payload) !== "charge.success") {
      return false;
    }

    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);

    return (
      PaystackEventNormalizerService.cleanLowerString(metadata.purpose) ===
      "job_publication_purchase"
    );
  }

  static isSubscriptionPaymentEvent(payload = {}) {
    if (PaystackEventNormalizerService.getEventName(payload) !== "charge.success") {
      return false;
    }

    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);

    return (
      PaystackEventNormalizerService.cleanLowerString(metadata.purpose) === "subscription_payment"
    );
  }

  static getSubscriptionPaymentKind(payload = {}, { required = false } = {}) {
    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);

    const paymentKind = PaystackEventNormalizerService.cleanLowerString(metadata.paymentKind);

    if (!paymentKind) {
      if (required) {
        throw new Error("Subscription payment event requires paymentKind metadata.");
      }

      return null;
    }

    if (!["initial_purchase", "plan_change", "renewal"].includes(paymentKind)) {
      throw new Error("Subscription payment event contains an unsupported paymentKind.");
    }

    return paymentKind;
  }

  static isEmployerWalletFundingEvent(payload = {}) {
    const eventName = PaystackEventNormalizerService.getEventName(payload);
    const data = PaystackEventNormalizerService.getData(payload);

    if (eventName !== "charge.success") return false;

    if (
      PaystackEventNormalizerService.isShiftCheckoutPaymentEvent(payload) ||
      PaystackEventNormalizerService.isJobPublicationPaymentEvent(payload) ||
      PaystackEventNormalizerService.isSubscriptionPaymentEvent(payload)
    ) {
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

    return PaystackEventNormalizerService.cleanLowerString(data.channel) === "dedicated_nuban";
  }

  static getWithdrawalOwnerType(payload = {}) {
    const metadata = PaystackEventNormalizerService.getWithdrawalMetadata(payload);

    const declaredOwnerType = PaystackEventNormalizerService.cleanLowerString(metadata.ownerType);

    const employerProfileId = PaystackEventNormalizerService.cleanString(
      metadata.employerProfileId
    );

    const professionalProfileId = PaystackEventNormalizerService.cleanString(
      metadata.professionalProfileId
    );

    if (declaredOwnerType && !["employer", "professional"].includes(declaredOwnerType)) {
      throw new Error("Withdrawal transfer contains an invalid owner type.");
    }

    if (employerProfileId && professionalProfileId) {
      throw new Error("Withdrawal transfer cannot belong to both an employer and a professional.");
    }

    if (declaredOwnerType === "employer" && professionalProfileId) {
      throw new Error("Employer withdrawal cannot contain a professional profile ID.");
    }

    if (declaredOwnerType === "professional" && employerProfileId) {
      throw new Error("Professional withdrawal cannot contain an employer profile ID.");
    }

    const ownerType =
      declaredOwnerType ||
      (employerProfileId ? "employer" : professionalProfileId ? "professional" : null);

    if (!ownerType) {
      throw new Error("Withdrawal transfer requires an employer or professional owner.");
    }

    return ownerType;
  }

  static isWithdrawalPayoutEvent(payload = {}) {
    return PaystackEventNormalizerService.getEventName(payload) === "transfer.success";
  }

  static isWithdrawalReversalEvent(payload = {}) {
    return ["transfer.failed", "transfer.reversed"].includes(
      PaystackEventNormalizerService.getEventName(payload)
    );
  }

  static getEventCategory(payload = {}) {
    if (PaystackEventNormalizerService.isDVAAssignmentEvent(payload)) {
      return "dva_assignment";
    }

    if (PaystackEventNormalizerService.isRefundLifecycleEvent(payload)) {
      return "employer_refund";
    }

    if (PaystackEventNormalizerService.isShiftCheckoutPaymentEvent(payload)) {
      return "shift_checkout_payment";
    }

    if (PaystackEventNormalizerService.isJobPublicationPaymentEvent(payload)) {
      return "job_publication_purchase";
    }

    if (PaystackEventNormalizerService.isSubscriptionPaymentEvent(payload)) {
      PaystackEventNormalizerService.getSubscriptionPaymentKind(payload, {
        required: true,
      });

      return "subscription_payment";
    }

    if (PaystackEventNormalizerService.isEmployerWalletFundingEvent(payload)) {
      return "employer_wallet_funding";
    }

    if (PaystackEventNormalizerService.isWithdrawalPayoutEvent(payload)) {
      return PaystackEventNormalizerService.getWithdrawalOwnerType(payload) === "employer"
        ? "employer_withdrawal_payout"
        : "professional_withdrawal_payout";
    }

    if (PaystackEventNormalizerService.isWithdrawalReversalEvent(payload)) {
      return PaystackEventNormalizerService.getWithdrawalOwnerType(payload) === "employer"
        ? "employer_withdrawal_reversal"
        : "professional_withdrawal_reversal";
    }

    return "other";
  }

  // ───────────────────────── NORMALIZED PROVIDER METADATA ─────────────────────────

  static normalizeMetadata(payload = {}) {
    const data = PaystackEventNormalizerService.getData(payload);
    const metadata = PaystackEventNormalizerService.getPaystackMetadata(payload);
    const dvaAssignment = PaystackEventNormalizerService.getDVAAssignmentDetails(payload);

    const providerRefundId = PaystackEventNormalizerService.getProviderRefundId(payload);
    const providerRefundReference =
      PaystackEventNormalizerService.getProviderRefundReference(payload);

    const originalTransactionReference =
      PaystackEventNormalizerService.getOriginalTransactionReference(payload);

    const originalTransactionProviderId =
      PaystackEventNormalizerService.getOriginalTransactionProviderId(payload);

    return {
      paystackCustomerCode:
        dvaAssignment?.paystackCustomerCode ||
        PaystackEventNormalizerService.cleanString(data.customer?.customer_code) ||
        PaystackEventNormalizerService.cleanString(data.customer_code),

      paystackCustomerId: PaystackEventNormalizerService.normalizeOptionalProviderId(
        dvaAssignment?.paystackCustomerId ?? data.customer?.id ?? data.customer_id
      ),

      customerEmail:
        dvaAssignment?.customerEmail ||
        PaystackEventNormalizerService.cleanLowerString(data.customer?.email) ||
        PaystackEventNormalizerService.cleanLowerString(data.email),

      paystackDedicatedAccountId: PaystackEventNormalizerService.normalizeOptionalProviderId(
        dvaAssignment?.paystackDedicatedAccountId ??
          data.dedicated_account?.id ??
          data.dedicatedAccount?.id
      ),

      bankName:
        dvaAssignment?.bankName ||
        PaystackEventNormalizerService.cleanString(data.authorization?.receiver_bank) ||
        PaystackEventNormalizerService.cleanString(data.dedicated_account?.bank?.name) ||
        PaystackEventNormalizerService.cleanString(data.dedicatedAccount?.bank?.name),

      accountNumber:
        dvaAssignment?.accountNumber ||
        PaystackEventNormalizerService.cleanString(
          data.authorization?.receiver_bank_account_number
        ) ||
        PaystackEventNormalizerService.cleanString(data.dedicated_account?.account_number) ||
        PaystackEventNormalizerService.cleanString(data.dedicatedAccount?.account_number),

      accountName: dvaAssignment?.accountName || null,
      bankId: dvaAssignment?.bankId || null,
      bankCode: dvaAssignment?.bankCode || null,
      bankSlug: dvaAssignment?.bankSlug || null,
      providerSlug: dvaAssignment?.providerSlug || null,
      dvaAssigned: dvaAssignment?.assigned ?? null,
      dvaActive: dvaAssignment?.active ?? null,
      dvaFailureReason: dvaAssignment?.failureReason || null,

      transferCode: PaystackEventNormalizerService.cleanString(data.transfer_code),
      transferReference: PaystackEventNormalizerService.cleanString(data.reference),

      recipientCode:
        PaystackEventNormalizerService.cleanString(data.recipient?.recipient_code) ||
        PaystackEventNormalizerService.cleanString(data.recipient_code),

      status: PaystackEventNormalizerService.cleanLowerString(data.status),
      domain: PaystackEventNormalizerService.cleanLowerString(data.domain),
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
      paymentReference: PaystackEventNormalizerService.cleanString(metadata.paymentReference),

      paymentKind: PaystackEventNormalizerService.isSubscriptionPaymentEvent(payload)
        ? PaystackEventNormalizerService.getSubscriptionPaymentKind(payload, {
            required: true,
          })
        : PaystackEventNormalizerService.cleanLowerString(metadata.paymentKind),

      paymentMethod: PaystackEventNormalizerService.cleanLowerString(metadata.paymentMethod),
      jobPaymentId: PaystackEventNormalizerService.cleanString(metadata.jobPaymentId),
      jobPostingPlanId: PaystackEventNormalizerService.cleanString(metadata.jobPostingPlanId),

      subscriptionPaymentId: PaystackEventNormalizerService.cleanString(
        metadata.subscriptionPaymentId
      ),

      subscriptionId: PaystackEventNormalizerService.cleanString(metadata.subscriptionId),
      subscriptionPlanId: PaystackEventNormalizerService.cleanString(metadata.subscriptionPlanId),
      billingCycleKey: PaystackEventNormalizerService.cleanString(metadata.billingCycleKey),
      planCode: PaystackEventNormalizerService.cleanString(metadata.planCode),
      planVersion: PaystackEventNormalizerService.cleanString(metadata.planVersion),

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

  // ───────────────────────── NORMALIZE PAYSTACK EVENT ─────────────────────────

  static normalize(payload = {}, rawHeaders = {}, options = {}) {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.event !== "string" ||
      !payload.event.trim() ||
      !payload.data ||
      typeof payload.data !== "object" ||
      Array.isArray(payload.data)
    ) {
      throw new Error("Provider event must contain an event name and data object.");
    }

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
    const dvaAssignment = PaystackEventNormalizerService.getDVAAssignmentDetails(payload);

    const isTransfer = ["transfer.success", "transfer.failed", "transfer.reversed"].includes(
      eventName
    );

    if (isTransfer && !metadata.transferReference) {
      throw new Error("Transfer event requires its reference, not just its transfer code.");
    }

    if (
      (eventName === "charge.success" || isTransfer || REFUND_EVENT_NAMES.has(eventName)) &&
      (amount === null || amount <= 0)
    ) {
      throw new Error("Financial provider events require a positive amount.");
    }

    if (eventName === "charge.success" && !providerReference) {
      throw new Error("Successful charge requires its transaction reference.");
    }

    const paystackMetadata = isTransfer
      ? PaystackEventNormalizerService.getWithdrawalMetadata(payload)
      : metadata.metadata || {};

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

    const withdrawalTransactionId = isTransfer
      ? null
      : PaystackEventNormalizerService.cleanString(paystackMetadata.withdrawalTransactionId) ||
        PaystackEventNormalizerService.cleanString(paystackMetadata.transactionId) ||
        null;

    const transactionId = isTransfer
      ? null
      : PaystackEventNormalizerService.cleanString(paystackMetadata.transactionId) ||
        PaystackEventNormalizerService.cleanString(paystackMetadata.withdrawalTransactionId) ||
        null;

    const paymentReference = metadata.paymentReference || null;
    const paymentKind = metadata.paymentKind || null;
    const paymentMethod = metadata.paymentMethod || null;
    const jobPaymentId = metadata.jobPaymentId || null;
    const jobPostingPlanId = metadata.jobPostingPlanId || null;
    const subscriptionPaymentId = metadata.subscriptionPaymentId || null;
    const subscriptionId = metadata.subscriptionId || null;
    const subscriptionPlanId = metadata.subscriptionPlanId || null;
    const billingCycleKey = metadata.billingCycleKey || null;
    const planCode = metadata.planCode || null;
    const planVersion = metadata.planVersion || null;
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
        paymentReference,
        paymentKind,
        paymentMethod,
        jobPaymentId,
        subscriptionPaymentId,
        subscriptionId,
        subscriptionPlanId,
        refundStatus: metadata.refundStatus,
        refundTraceKey: metadata.refundTraceKey,
      },

      normalizedPayload: {
        eventName,
        eventCategory,
        providerEventId,
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
        domain: metadata.domain,
        customerEmail: metadata.customerEmail,
        channel: metadata.channel,
        paidAt: metadata.paidAt,
        gatewayResponse: metadata.gatewayResponse,

        purpose: metadata.purpose,
        fundingType: metadata.fundingType,
        paymentRail: metadata.paymentRail,
        paymentReference,
        paymentKind,
        paymentMethod,
        jobPaymentId,
        jobPostingPlanId,
        subscriptionPaymentId,
        subscriptionId,
        subscriptionPlanId,
        billingCycleKey,
        planCode,
        planVersion,

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

        paystackTransferReference: isTransfer ? metadata.transferReference : null,

        reversalReason: PaystackEventNormalizerService.isWithdrawalReversalEvent(payload)
          ? metadata.reason ||
            metadata.gatewayResponse ||
            "Paystack reported transfer failed or reversed."
          : null,

        // Employer refund lifecycle
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

        // DVA assignment lifecycle
        paystackCustomerId: dvaAssignment?.paystackCustomerId || metadata.paystackCustomerId,

        paystackCustomerCode: dvaAssignment?.paystackCustomerCode || metadata.paystackCustomerCode,

        paystackDedicatedAccountId:
          dvaAssignment?.paystackDedicatedAccountId || metadata.paystackDedicatedAccountId,

        accountNumber: dvaAssignment?.accountNumber || metadata.accountNumber,

        accountName: dvaAssignment?.accountName || metadata.accountName,

        bankId: dvaAssignment?.bankId || metadata.bankId,

        bankName: dvaAssignment?.bankName || metadata.bankName,

        bankCode: dvaAssignment?.bankCode || metadata.bankCode,

        bankSlug: dvaAssignment?.bankSlug || metadata.bankSlug,

        providerSlug: dvaAssignment?.providerSlug || metadata.providerSlug,

        dvaAssigned: dvaAssignment?.assigned ?? null,
        dvaActive: dvaAssignment?.active ?? null,
        dvaFailureReason: dvaAssignment?.failureReason || null,

        metadata,
      },
    };
  }
}

module.exports = PaystackEventNormalizerService;
