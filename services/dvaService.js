// services/dvaService.js

const DVA = require("../models/DVA");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const PaystackService = require("./paystackService");
const WalletService = require("./walletService");
const logger = require("../utils/logger");

const DVA_USER_RETRY_WAIT_HOURS = 24;
const DVA_USER_RETRY_WAIT_MS = DVA_USER_RETRY_WAIT_HOURS * 60 * 60 * 1000;

class DVAService {
  /* ---------- Shared normalization and errors ---------- */

  static cleanString(value) {
    return String(value ?? "").trim() || null;
  }

  static cleanNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  static shortenErrorMessage(message) {
    return String(message || "DVA creation failed.").slice(0, 300);
  }

  static createAssignmentError(message, code, { retryable = false, statusCode = 409 } = {}) {
    const error = new Error(message);

    error.name = "DVAAssignmentError";
    error.code = code;
    error.retryable = retryable;
    error.statusCode = statusCode;

    return error;
  }

  /* ---------- Retry helpers ---------- */

  static getRetryAnchorDate(dva) {
    return dva?.failedAt || dva?.requestedAt || dva?.updatedAt || null;
  }

  static hasUserRetryWindowPassed(dva) {
    const anchor = DVAService.getRetryAnchorDate(dva);

    if (!anchor) {
      return true;
    }

    return Date.now() - new Date(anchor).getTime() >= DVA_USER_RETRY_WAIT_MS;
  }

  static canRetryDVA(dva) {
    if (!dva) {
      return true;
    }

    if (dva.status === "active" || dva.status === "deactivated") {
      return false;
    }

    if (DVAService.hasUserRetryWindowPassed(dva)) {
      return true;
    }

    return (
      ["failed", "pending"].includes(dva.status) &&
      process.env.NODE_ENV === "development" &&
      PaystackService.isTestMode() &&
      process.env.ALLOW_DVA_IMMEDIATE_TEST_RETRY === "true"
    );
  }

  static getRetryAvailableAt(dva) {
    const anchor = DVAService.getRetryAnchorDate(dva);

    return anchor ? new Date(new Date(anchor).getTime() + DVA_USER_RETRY_WAIT_MS) : null;
  }

  /* ---------- Provider helpers ---------- */

  static formatPhone(phoneCode, phone) {
    return `${String(phoneCode || "").trim()}${String(phone || "").trim()}`.replace(/\s+/g, "");
  }

  static isProviderUnavailableError(error) {
    const message = String(error?.message || error || "").toLowerCase();

    return [
      "dedicated nuban is not available",
      "access denied",
      "not available for your business",
      "not activated",
      "not enabled",
    ].some((fragment) => message.includes(fragment));
  }

  static getProviderUnavailableMessage() {
    return "Wallet bank account setup is not available for this business yet. We will complete setup once the payment provider activates this feature.";
  }

  static getPreferredProviderSlug() {
    if (PaystackService.isTestMode()) {
      return "test-bank";
    }

    const preferred = DVAService.cleanString(process.env.PAYSTACK_DVA_PREFERRED_BANK);

    if (!preferred) {
      throw new Error("PAYSTACK_DVA_PREFERRED_BANK is not configured.");
    }

    return preferred.toLowerCase();
  }

  /* ---------- Extract provider account details ---------- */

  static extractDVAData(paystackResponse, preferredProviderSlug = null) {
    const source = paystackResponse?.data || paystackResponse || {};

    const account = source.dedicated_account || source.dedicatedAccount || source;

    const customer = source.customer || account.customer || source;

    const bank = account.bank || {};

    return {
      paystackCustomerId: DVAService.cleanNumber(customer.id || source.customer_id),

      paystackCustomerCode: DVAService.cleanString(
        customer.customer_code || customer.customerCode || source.customer_code
      ),

      paystackDedicatedAccountId: DVAService.cleanNumber(account.id || source.dedicated_account_id),

      paystackReference: DVAService.cleanString(account.reference || source.reference),

      accountNumber: DVAService.cleanString(account.account_number || account.accountNumber),

      accountName: DVAService.cleanString(account.account_name || account.accountName),

      bankId: DVAService.cleanNumber(bank.id || bank.bank_id || account.bank_id),

      bankName: DVAService.cleanString(bank.name || account.bank_name),

      bankCode: DVAService.cleanString(bank.code || account.bank_code),

      bankSlug: DVAService.cleanString(bank.slug || account.bank_slug),

      providerSlug: DVAService.cleanString(
        account.provider_slug || bank.provider_slug || bank.slug || preferredProviderSlug
      ),
    };
  }

  static validateDVAData(data) {
    if (
      !data.paystackCustomerCode ||
      !data.paystackDedicatedAccountId ||
      !data.accountNumber ||
      !data.accountName ||
      !data.bankName ||
      !data.providerSlug
    ) {
      throw new Error("Incomplete Paystack DVA response.");
    }

    return true;
  }

  /* ---------- Parse Paystack customer metadata ---------- */

  static parsePaystackMetadata(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  /* ---------- Reconcile an existing pending DVA ---------- */

  static async reconcilePendingEmployerDVA({ userId, employerProfileId }) {
    const user = await User.findById(userId);
    const employer = await EmployerProfile.findById(employerProfileId);

    if (!user || !employer || String(employer.user) !== String(user._id)) {
      throw DVAService.createAssignmentError(
        "Employer ownership verification failed.",
        "DVA_RECONCILIATION_OWNERSHIP_MISMATCH",
        { statusCode: 403 }
      );
    }

    const dva = await DVA.findOne({
      ownerUser: user._id,
      employer: employer._id,
      provider: "paystack",
      status: "pending",
    });

    if (!dva) {
      return DVAService.getEmployerDVA({ employerProfileId });
    }

    const email = PaystackService.normalizeEmail(user.email);
    const mode = PaystackService.getMode();
    const requested = dva.metadata?.requestedWith || {};

    // Verify the original Loqum assignment.
    if (
      DVAService.cleanString(dva.metadata?.assignmentEmail)?.toLowerCase() !== email ||
      dva.metadata?.assignmentMode !== mode ||
      String(requested.userId) !== String(user._id) ||
      String(requested.employerProfileId) !== String(employer._id) ||
      String(requested.walletId) !== String(dva.wallet)
    ) {
      throw DVAService.createAssignmentError(
        "Stored assignment identity does not match this employer wallet.",
        "DVA_RECONCILIATION_LOCAL_IDENTITY_MISMATCH"
      );
    }

    const customer = await PaystackService.fetchPaystackCustomer(email);
    const metadata = DVAService.parsePaystackMetadata(customer.metadata);

    const customerId = DVAService.cleanNumber(customer.id);
    const customerCode = DVAService.cleanString(customer.customer_code);

    // Verify that Paystack's customer belongs to this employer.
    if (
      !customerId ||
      !customerCode ||
      DVAService.cleanString(customer.email)?.toLowerCase() !== email ||
      DVAService.cleanString(customer.domain)?.toLowerCase() !== mode ||
      !metadata ||
      String(metadata.userId) !== String(user._id) ||
      String(metadata.employerProfileId) !== String(employer._id) ||
      String(metadata.walletId) !== String(dva.wallet) ||
      String(metadata.countryCode || "").toUpperCase() !== dva.countryCode ||
      String(metadata.currency || "").toUpperCase() !== dva.currency
    ) {
      throw DVAService.createAssignmentError(
        "Paystack customer metadata does not match the employer wallet.",
        "DVA_RECONCILIATION_CUSTOMER_MISMATCH"
      );
    }

    const assignedAccount = customer.dedicated_account || customer.dedicatedAccount;

    // An unassigned account must remain pending.
    if (!assignedAccount || assignedAccount.active !== true || assignedAccount.assigned !== true) {
      return dva;
    }

    const accountId = DVAService.cleanNumber(assignedAccount.id);

    if (!accountId) {
      return dva;
    }

    // Independently verify the dedicated account.
    const response = await PaystackService.request({
      method: "get",
      path: `/dedicated_account/${accountId}`,
    });

    const account = response.data;

    const linkedCustomer = account?.customer;

    const linkedCustomerId = DVAService.cleanNumber(
      typeof linkedCustomer === "object" ? linkedCustomer?.id : linkedCustomer
    );

    const linkedCustomerCode =
      typeof linkedCustomer === "object"
        ? DVAService.cleanString(linkedCustomer?.customer_code)
        : null;

    if (
      !account ||
      DVAService.cleanNumber(account.id) !== accountId ||
      account.active !== true ||
      account.assigned !== true ||
      linkedCustomerId !== customerId ||
      (linkedCustomerCode && linkedCustomerCode !== customerCode)
    ) {
      throw DVAService.createAssignmentError(
        "Dedicated account ownership could not be verified.",
        "DVA_RECONCILIATION_ACCOUNT_MISMATCH"
      );
    }

    const accountCurrency = DVAService.cleanString(account.currency)?.toUpperCase();

    if (accountCurrency && accountCurrency !== dva.currency) {
      throw DVAService.createAssignmentError(
        "Dedicated account currency does not match the wallet.",
        "DVA_RECONCILIATION_CURRENCY_MISMATCH"
      );
    }

    const fields = DVAService.extractDVAData(
      {
        ...account,
        customer,
      },
      dva.providerSlug
    );

    DVAService.validateDVAData(fields);

    // Reject mismatches with identifiers previously recorded locally.
    if (
      fields.paystackCustomerId !== customerId ||
      fields.paystackCustomerCode !== customerCode ||
      fields.paystackDedicatedAccountId !== accountId ||
      (dva.paystackCustomerId && Number(dva.paystackCustomerId) !== customerId) ||
      (dva.paystackCustomerCode && dva.paystackCustomerCode !== customerCode) ||
      (dva.paystackDedicatedAccountId && Number(dva.paystackDedicatedAccountId) !== accountId) ||
      (dva.providerSlug && dva.providerSlug !== fields.providerSlug)
    ) {
      throw DVAService.createAssignmentError(
        "Paystack account conflicts with the existing DVA record.",
        "DVA_RECONCILIATION_EXISTING_IDENTITY_CONFLICT"
      );
    }

    // Prevent claiming an account already associated with another DVA.
    const conflictConditions = [
      { paystackDedicatedAccountId: accountId },
      { paystackCustomerId: customerId },
      { paystackCustomerCode: customerCode },
    ];

    if (fields.bankId && fields.accountNumber) {
      conflictConditions.push({
        bankId: fields.bankId,
        accountNumber: fields.accountNumber,
      });
    }

    const conflict = await DVA.findOne({
      _id: { $ne: dva._id },
      provider: "paystack",
      $or: conflictConditions,
    }).select("_id employer wallet");

    if (conflict) {
      throw DVAService.createAssignmentError(
        "Paystack account is already associated with another DVA.",
        "DVA_RECONCILIATION_ACCOUNT_ALREADY_CLAIMED"
      );
    }

    const now = new Date();

    // Update only the same pending employer wallet.
    const updated = await DVA.findOneAndUpdate(
      {
        _id: dva._id,
        ownerUser: user._id,
        employer: employer._id,
        wallet: dva.wallet,
        provider: "paystack",
        status: "pending",
      },
      {
        $set: {
          ...fields,
          status: "active",
          activatedAt: now,
          lastSyncedAt: now,
          failedAt: null,
          failureReason: null,
          deactivatedAt: null,
          "metadata.lastReconciledAt": now,
          "metadata.reconciliationSource": "verified_paystack_api",
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    if (!updated) {
      // A webhook or another request may have changed the status.
      return DVA.findById(dva._id);
    }

    logger.info(`Paystack DVA reconciled for employer profile: ${employer._id}`);

    return updated;
  }

  /* ---------- Employer-facing DVA methods ---------- */

  static async getEmployerDVA({ employerProfileId }) {
    return DVA.findOne({
      employer: employerProfileId,
      provider: "paystack",
    }).sort({
      updatedAt: -1,
    });
  }

  static async getEmployerDVAStatus({ employerProfileId }) {
    const dva = await DVAService.getEmployerDVA({
      employerProfileId,
    });

    if (!dva) {
      return {
        status: "not_started",
        rawStatus: "not_started",
        message: "Your wallet bank account has not been set up yet.",
        canRetrySetup: true,
        retryAvailableAt: null,
        dva: null,
      };
    }

    const rawStatus = dva.status;

    const canRetrySetup = ["failed", "pending"].includes(rawStatus) && DVAService.canRetryDVA(dva);

    const retryAvailableAt = canRetrySetup ? null : DVAService.getRetryAvailableAt(dva);

    if (rawStatus === "active") {
      return {
        status: "active",
        rawStatus,
        message: "Your wallet bank account is ready.",
        canRetrySetup: false,
        retryAvailableAt: null,
        dva,
      };
    }

    if (rawStatus === "failed") {
      return {
        status: "setup_pending",
        rawStatus,
        message:
          dva.failureReason ||
          "Your wallet bank account could not be completed automatically. Please allow up to 24 hours while we review it.",
        canRetrySetup,
        retryAvailableAt,
        dva,
      };
    }

    if (rawStatus === "deactivated") {
      return {
        status: "deactivated",
        rawStatus,
        message: "Your wallet bank account is currently unavailable. Please contact support.",
        canRetrySetup: false,
        retryAvailableAt: null,
        dva,
      };
    }

    return {
      status: "setup_pending",
      rawStatus,
      message: "Your wallet bank account is being set up. Please allow up to 24 hours.",
      canRetrySetup,
      retryAvailableAt,
      dva,
    };
  }

  /* ---------- Resolve Paystack assignment identity ---------- */

  static async resolveAssignmentDVA({ normalizedPayload = {}, rawPayload = {} }) {
    const raw = rawPayload?.data || {};

    const rawCustomer = raw.customer && typeof raw.customer === "object" ? raw.customer : {};

    const customerEmail = DVAService.cleanString(
      normalizedPayload.customerEmail || rawCustomer.email || raw.email
    )?.toLowerCase();

    const customerCode = DVAService.cleanString(
      normalizedPayload.paystackCustomerCode || rawCustomer.customer_code || raw.customer_code
    );

    const customerId = DVAService.cleanNumber(
      normalizedPayload.paystackCustomerId || rawCustomer.id || raw.customer_id
    );

    const accountId = DVAService.cleanNumber(normalizedPayload.paystackDedicatedAccountId);

    const keys = [];

    if (accountId) {
      keys.push({
        paystackDedicatedAccountId: accountId,
      });
    }

    if (customerCode) {
      keys.push({
        paystackCustomerCode: customerCode,
      });
    }

    if (customerId) {
      keys.push({
        paystackCustomerId: customerId,
      });
    }

    if (customerEmail) {
      keys.push({
        "metadata.assignmentEmail": customerEmail,
      });

      keys.push({
        "metadata.requestedWith.email": customerEmail,
      });

      const user = await User.findOne({
        email: customerEmail,
      });

      if (user) {
        keys.push({
          ownerUser: user._id,
        });
      }
    }

    if (!keys.length) {
      throw DVAService.createAssignmentError(
        "Paystack assignment event has no usable customer identity.",
        "PAYSTACK_DVA_ASSIGNMENT_IDENTITY_REQUIRED",
        {
          retryable: false,
          statusCode: 422,
        }
      );
    }

    const candidates = await DVA.find({
      provider: "paystack",
      countryCode: "NG",
      currency: "NGN",
      status: {
        $in: ["pending", "active", "failed"],
      },
      $or: keys,
    }).limit(20);

    const compatible = candidates.filter((dva) => {
      if (
        accountId &&
        dva.paystackDedicatedAccountId &&
        Number(dva.paystackDedicatedAccountId) !== accountId
      ) {
        return false;
      }

      if (customerCode && dva.paystackCustomerCode && dva.paystackCustomerCode !== customerCode) {
        return false;
      }

      if (customerId && dva.paystackCustomerId && Number(dva.paystackCustomerId) !== customerId) {
        return false;
      }

      const expectedEmail = DVAService.cleanString(
        dva.metadata?.assignmentEmail || dva.metadata?.requestedWith?.email
      )?.toLowerCase();

      if (customerEmail && expectedEmail && customerEmail !== expectedEmail) {
        return false;
      }

      return true;
    });

    if (compatible.length > 1) {
      throw DVAService.createAssignmentError(
        "Paystack assignment identity matches multiple employer DVA records.",
        "PAYSTACK_DVA_ASSIGNMENT_AMBIGUOUS",
        {
          retryable: false,
        }
      );
    }

    if (!compatible.length) {
      throw DVAService.createAssignmentError(
        "Matching employer DVA is not yet available for Paystack assignment event.",
        "PAYSTACK_DVA_ASSIGNMENT_NOT_FOUND",
        {
          retryable: true,
          statusCode: 404,
        }
      );
    }

    return {
      dva: compatible[0],
      customerEmail,
      customerCode,
      customerId,
      accountId,
    };
  }

  /* ---------- Validate Paystack environment ---------- */

  static assertAssignmentMode(dva, payload, rawPayload) {
    const mode = PaystackService.getMode();

    const storedMode = DVAService.cleanString(dva.metadata?.assignmentMode)?.toLowerCase();

    const providerDomain = DVAService.cleanString(
      payload.domain || rawPayload?.data?.domain || rawPayload?.data?.customer?.domain
    )?.toLowerCase();

    if (
      !["test", "live"].includes(mode) ||
      (storedMode && storedMode !== mode) ||
      (providerDomain && providerDomain !== mode)
    ) {
      throw DVAService.createAssignmentError(
        "Paystack DVA assignment environment does not match the recorded request.",
        "PAYSTACK_DVA_ASSIGNMENT_MODE_MISMATCH",
        {
          retryable: false,
        }
      );
    }

    if (
      (payload.countryCode && String(payload.countryCode).toUpperCase() !== dva.countryCode) ||
      (payload.currency && String(payload.currency).toUpperCase() !== dva.currency)
    ) {
      throw DVAService.createAssignmentError(
        "Paystack DVA assignment country or currency does not match the wallet.",
        "PAYSTACK_DVA_ASSIGNMENT_CURRENCY_MISMATCH",
        {
          retryable: false,
        }
      );
    }
  }

  /* ---------- Apply verified assignment webhook ---------- */

  /*
   * Only the signed webhook pipeline may call this method.
   * ProviderEventProcessorService must first claim
   * a verified provider event.
   *
   * Assignment never credits the wallet.
   * Only the payment funding workflow may do that.
   */

  static async applyPaystackAssignmentEvent({
    eventName,
    normalizedPayload = {},
    rawPayload = {},
    providerEventRecordId,
    providerEventMarker,
    currentTime = new Date(),
  }) {
    const allowedEvents = ["dedicatedaccount.assign.success", "dedicatedaccount.assign.failed"];

    if (!allowedEvents.includes(eventName)) {
      throw DVAService.createAssignmentError(
        "Unsupported Paystack dedicated-account assignment event.",
        "UNSUPPORTED_PAYSTACK_DVA_ASSIGNMENT_EVENT",
        {
          retryable: false,
          statusCode: 422,
        }
      );
    }

    if (!providerEventRecordId || !providerEventMarker) {
      throw DVAService.createAssignmentError(
        "Verified provider event identity is required for DVA assignment.",
        "PAYSTACK_DVA_EVENT_MARKER_REQUIRED",
        {
          retryable: false,
          statusCode: 422,
        }
      );
    }

    const at = currentTime instanceof Date ? currentTime : new Date(currentTime);

    if (Number.isNaN(at.getTime())) {
      throw DVAService.createAssignmentError(
        "Invalid DVA assignment event time.",
        "PAYSTACK_DVA_EVENT_TIME_INVALID",
        {
          retryable: false,
          statusCode: 422,
        }
      );
    }

    const identity = await DVAService.resolveAssignmentDVA({
      normalizedPayload,
      rawPayload,
    });

    const dva = identity.dva;

    DVAService.assertAssignmentMode(dva, normalizedPayload, rawPayload);

    const success = eventName === "dedicatedaccount.assign.success";

    const desiredStatus = success ? "active" : "failed";

    /*
     * Duplicate delivery must not repeat activation.
     * A conflicting terminal status must not be overwritten.
     */

    if (dva.status === desiredStatus) {
      if (success) {
        if (
          (identity.accountId && Number(dva.paystackDedicatedAccountId) !== identity.accountId) ||
          (identity.customerCode && dva.paystackCustomerCode !== identity.customerCode)
        ) {
          throw DVAService.createAssignmentError(
            "Existing active DVA conflicts with Paystack assignment details.",
            "PAYSTACK_DVA_ACTIVE_IDENTITY_CONFLICT"
          );
        }
      }

      return {
        dva,
        idempotent: true,
        resolutionSource: "existing_terminal_state",
      };
    }

    if (dva.status !== "pending") {
      throw DVAService.createAssignmentError(
        "Paystack DVA assignment conflicts with the existing terminal DVA status.",
        "PAYSTACK_DVA_TERMINAL_STATUS_CONFLICT"
      );
    }

    const audit = {
      "metadata.lastAssignmentEventId": String(providerEventRecordId),

      "metadata.lastAssignmentEventMarker": String(providerEventMarker),

      "metadata.lastAssignmentEventName": eventName,

      "metadata.lastAssignmentEventAt": at,
    };

    let update;

    if (success) {
      /*
       * Confirm account details directly with Paystack.
       * Do not activate from an incomplete webhook payload.
       */

      const lookupKey = identity.customerEmail || identity.customerCode;

      if (!lookupKey) {
        throw DVAService.createAssignmentError(
          "A customer email or code is needed to verify Paystack DVA assignment.",
          "PAYSTACK_DVA_CUSTOMER_LOOKUP_REQUIRED",
          {
            retryable: true,
            statusCode: 503,
          }
        );
      }

      const customer = await PaystackService.fetchPaystackCustomer(lookupKey);

      const verifiedEmail = DVAService.cleanString(customer.email)?.toLowerCase();

      const verifiedMode = DVAService.cleanString(customer.domain)?.toLowerCase();

      const expectedEmail = DVAService.cleanString(
        dva.metadata?.assignmentEmail ||
          dva.metadata?.requestedWith?.email ||
          identity.customerEmail
      )?.toLowerCase();

      if (!expectedEmail || !verifiedEmail || verifiedEmail !== expectedEmail) {
        throw DVAService.createAssignmentError(
          "Paystack customer email does not match the employer's DVA assignment.",
          "PAYSTACK_DVA_CUSTOMER_EMAIL_MISMATCH",
          {
            retryable: false,
          }
        );
      }

      if (verifiedMode && verifiedMode !== PaystackService.getMode()) {
        throw DVAService.createAssignmentError(
          "Paystack customer belongs to a different environment.",
          "PAYSTACK_DVA_CUSTOMER_MODE_MISMATCH"
        );
      }

      if (
        (identity.customerCode && customer.customer_code !== identity.customerCode) ||
        (identity.customerId && Number(customer.id) !== identity.customerId)
      ) {
        throw DVAService.createAssignmentError(
          "Paystack customer identity does not match the assignment webhook.",
          "PAYSTACK_DVA_CUSTOMER_IDENTITY_MISMATCH"
        );
      }

      const account = customer.dedicated_account || customer.dedicatedAccount;

      if (!account || account.active === false || account.assigned === false) {
        throw DVAService.createAssignmentError(
          "Paystack has not yet returned an active assigned account for this customer.",
          "PAYSTACK_DVA_CUSTOMER_ACCOUNT_PENDING",
          {
            retryable: true,
            statusCode: 503,
          }
        );
      }

      const accountCurrency = DVAService.cleanString(account.currency)?.toUpperCase();

      if (accountCurrency && accountCurrency !== dva.currency) {
        throw DVAService.createAssignmentError(
          "Paystack account currency does not match the employer wallet.",
          "PAYSTACK_DVA_ACCOUNT_CURRENCY_MISMATCH"
        );
      }

      const fields = DVAService.extractDVAData(
        {
          ...account,
          customer,
        },
        dva.providerSlug
      );

      try {
        DVAService.validateDVAData(fields);
      } catch {
        throw DVAService.createAssignmentError(
          "Paystack customer lookup returned incomplete assigned-account details.",
          "PAYSTACK_DVA_CUSTOMER_ACCOUNT_INCOMPLETE",
          {
            retryable: true,
            statusCode: 503,
          }
        );
      }

      if (
        (identity.accountId && fields.paystackDedicatedAccountId !== identity.accountId) ||
        (identity.customerCode && fields.paystackCustomerCode !== identity.customerCode) ||
        (identity.customerId && fields.paystackCustomerId !== identity.customerId) ||
        (normalizedPayload.accountNumber &&
          fields.accountNumber !== String(normalizedPayload.accountNumber))
      ) {
        throw DVAService.createAssignmentError(
          "Fetched Paystack account does not match the signed assignment webhook.",
          "PAYSTACK_DVA_ACCOUNT_IDENTITY_MISMATCH"
        );
      }

      update = {
        ...fields,

        status: "active",
        activatedAt: at,
        failedAt: null,
        failureReason: null,
        deactivatedAt: null,
        lastSyncedAt: at,

        ...audit,
      };
    } else {
      /*
       * Failure events may not have an account number.
       * Only an identified, pending assignment can fail.
       */

      update = {
        status: "failed",

        failedAt: at,

        failureReason: DVAService.shortenErrorMessage(
          normalizedPayload.dvaFailureReason ||
            rawPayload?.data?.reason ||
            "Paystack could not assign the wallet bank account."
        ),

        lastSyncedAt: at,

        ...audit,
      };
    }

    /*
     * Atomic update prevents a delayed webhook from
     * overwriting an already completed assignment.
     */

    const committed = await DVA.findOneAndUpdate(
      {
        _id: dva._id,
        status: "pending",
        provider: "paystack",
      },
      {
        $set: update,
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (committed) {
      logger.info(`Paystack DVA assignment ${desiredStatus}: ${committed._id}`);

      return {
        dva: committed,
        idempotent: false,
        resolutionSource: "verified_webhook",
      };
    }

    /*
     * Another worker may have completed the assignment
     * before this update. Re-read instead of overwriting.
     */

    const latest = await DVA.findById(dva._id);

    if (latest?.status === desiredStatus) {
      return {
        dva: latest,
        idempotent: true,
        resolutionSource: "concurrent_terminal_state",
      };
    }

    throw DVAService.createAssignmentError(
      "DVA status changed while processing the assignment webhook.",
      "PAYSTACK_DVA_ASSIGNMENT_CONCURRENT_UPDATE",
      {
        retryable: true,
        statusCode: 409,
      }
    );
  }

  /* ---------- Create employer DVA through Paystack ---------- */

  static async createEmployerDVA({ userId, employerProfileId }) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    const employerProfile = await EmployerProfile.findById(employerProfileId);

    if (!employerProfile) {
      throw new Error("Employer profile not found.");
    }

    if (String(employerProfile.user) !== String(user._id)) {
      throw new Error("Employer profile does not belong to this user.");
    }

    const wallet = await WalletService.createEmployerWalletIfMissing(employerProfile);

    const selector = {
      wallet: wallet._id,
      provider: "paystack",
      countryCode: wallet.countryCode,
      currency: wallet.currency,
    };

    const existing = await DVA.findOne(selector);

    if (existing?.status === "active") {
      return existing;
    }

    if (existing?.status === "deactivated") {
      throw new Error("Your wallet bank account is deactivated. Please contact support.");
    }

    /*
     * Reconciliation is not an assignment retry.
     * An existing pending DVA may be checked against Paystack
     * without waiting for the 24-hour retry window.
     */
    if (existing?.status === "pending") {
      try {
        const reconciled = await DVAService.reconcilePendingEmployerDVA({
          userId,
          employerProfileId,
        });

        return reconciled || existing;
      } catch (error) {
        logger.warn(
          `Paystack DVA reconciliation failed for ${employerProfileId}: ${error.message}`
        );

        // Never submit a duplicate assignment because reconciliation failed.
        return (await DVA.findById(existing._id)) || existing;
      }
    }

    if (existing && !DVAService.canRetryDVA(existing)) {
      throw new Error(
        "Your wallet bank account is being set up. Please allow up to 24 hours before trying again."
      );
    }

    const email = PaystackService.normalizeEmail(user.email);

    const assignmentMode = PaystackService.getMode();

    const preferredProviderSlug = DVAService.getPreferredProviderSlug();

    const phone = DVAService.formatPhone(
      employerProfile.contactPhoneCode,
      employerProfile.contactPhone
    );

    const requestedAt = new Date();

    /*
     * Store the customer email and Paystack mode
     * before making the asynchronous provider request.
     */

    const metadata = {
      requestedWith: {
        userId: String(user._id),

        employerProfileId: String(employerProfile._id),

        walletId: String(wallet._id),

        email,

        businessName: employerProfile.businessName,

        employerType: employerProfile.type,

        preferredProviderSlug,

        countryCode: wallet.countryCode,

        currency: wallet.currency,
      },

      assignmentEmail: email,
      assignmentMode,
    };

    /* ---------- Persist pending assignment ---------- */

    let pendingDVA;

    if (existing?.status === "failed") {
      pendingDVA = await DVA.findOneAndUpdate(
        {
          _id: existing._id,
          status: "failed",
          requestedAt: existing.requestedAt,
        },
        {
          $set: {
            ownerUser: user._id,

            employer: employerProfile._id,

            status: "pending",
            requestedAt,

            failedAt: null,
            failureReason: null,
            deactivatedAt: null,

            providerSlug: preferredProviderSlug,

            metadata,
          },
        },
        {
          new: true,
          runValidators: true,
        }
      );

      if (!pendingDVA) {
        return DVA.findOne(selector);
      }
    } else {
      try {
        pendingDVA = await DVA.create({
          ...selector,

          ownerUser: user._id,
          employer: employerProfile._id,

          isDefault: true,
          status: "pending",

          requestedAt,
          providerSlug: preferredProviderSlug,

          metadata,
        });
      } catch (error) {
        if (error.code === 11000) {
          return DVA.findOne(selector);
        }

        throw error;
      }
    }

    /* ---------- Submit assignment ---------- */

    try {
      logger.info(`Creating Paystack DVA for employer profile: ${employerProfile._id}`);

      const response = await PaystackService.assignDedicatedVirtualAccount({
        email,

        firstName: employerProfile.contactFirstName,

        lastName: employerProfile.contactLastName,

        phone,
        preferredBank: preferredProviderSlug,

        countryCode: wallet.countryCode,

        metadata: {
          userId: String(user._id),

          employerProfileId: String(employerProfile._id),

          walletId: String(wallet._id),

          businessName: employerProfile.businessName,

          employerType: employerProfile.type,

          countryCode: wallet.countryCode,

          currency: wallet.currency,
        },
      });

      /*
       * Paystack has accepted the request, but the
       * dedicated account may not exist yet.
       */

      if (response?.pending === true) {
        await DVA.updateOne(
          {
            _id: pendingDVA._id,
            status: "pending",
          },
          {
            $set: {
              "metadata.assignmentAcknowledgedAt": new Date(),

              "metadata.assignmentMessage": response.message || null,
            },
          }
        );

        return (await DVA.findById(pendingDVA._id)) || pendingDVA;
      }

      /* ---------- Immediate account response ---------- */

      const fields = DVAService.extractDVAData(response, preferredProviderSlug);

      DVAService.validateDVAData(fields);

      const active = await DVA.findOneAndUpdate(
        {
          _id: pendingDVA._id,
          status: "pending",
        },
        {
          $set: {
            ...fields,

            status: "active",
            activatedAt: new Date(),

            failedAt: null,
            failureReason: null,
            deactivatedAt: null,

            lastSyncedAt: new Date(),

            "metadata.immediateResponseReceivedAt": new Date(),
          },
        },
        {
          new: true,
          runValidators: true,
        }
      );

      return active || (await DVA.findById(pendingDVA._id));
    } catch (error) {
      const failedAt = new Date();

      const providerUnavailable = DVAService.isProviderUnavailableError(error);

      const failureReason = providerUnavailable
        ? DVAService.getProviderUnavailableMessage()
        : error.message;

      /*
       * A timeout after submitting to Paystack does
       * not prove assignment failed. Keep it pending.
       */

      const uncertain =
        error.code === "PAYSTACK_REQUEST_TIMEOUT" ||
        (error.code === "PAYSTACK_REQUEST_FAILED" &&
          (!error.providerStatusCode || error.providerStatusCode >= 500));

      const update = uncertain
        ? {
            "metadata.submitUncertainAt": failedAt,

            "metadata.submitUncertainReason": DVAService.shortenErrorMessage(failureReason),
          }
        : {
            status: "failed",
            failedAt,

            failureReason: DVAService.shortenErrorMessage(failureReason),

            "metadata.lastFailure": {
              message: DVAService.shortenErrorMessage(error.message),

              providerUnavailable,
              failedAt,
            },
          };

      /*
       * Only change a record still marked pending.
       * Never overwrite a webhook-completed account.
       */

      const savedDVA = await DVA.findOneAndUpdate(
        {
          _id: pendingDVA._id,
          status: "pending",
        },
        {
          $set: update,
        },
        {
          new: true,
          runValidators: true,
        }
      );

      const latest = savedDVA || (await DVA.findById(pendingDVA._id));

      logger.error(`DVA assignment request failed for ${employerProfile._id}: ${error.message}`);

      if (providerUnavailable || uncertain || latest?.status === "active") {
        return latest;
      }

      throw error;
    }
  }
}

module.exports = DVAService;
