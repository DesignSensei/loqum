// services/dvaService.js

const DVA = require("../models/DVA");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const Wallet = require("../models/Wallet");

const PaystackService = require("./paystackService");
const WalletService = require("./walletService");

const { createServiceError } = require("./helpers/serviceErrorHelper");

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

  static createAssignmentError(
    message,
    code,
    { retryable = false, statusCode = 409, details = null, cause = null } = {}
  ) {
    return createServiceError({
      name: "DVAAssignmentError",
      message,
      code,
      statusCode,
      retryable,
      details,
      cause,
    });
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

  static isNeverDispatchedAssignment(dva) {
    if (!dva) {
      return false;
    }

    const metadata = dva.metadata || {};

    return (
      metadata.assignmentDispatchState === "prepared" &&
      metadata.assignmentDispatchStartedAt == null &&
      metadata.assignmentAcknowledgedAt == null &&
      metadata.submitUncertainAt == null &&
      metadata.lastAssignmentEventId == null &&
      metadata.assignmentSubmissionOutcome == null &&
      dva.activatedAt == null &&
      dva.paystackDedicatedAccountId == null &&
      dva.paystackCustomerId == null &&
      dva.paystackCustomerCode == null &&
      dva.accountNumber == null
    );
  }

  static canRetryDVA(dva) {
    if (!dva) {
      return true;
    }

    if (dva.retirementStartedAt || !["pending", "failed"].includes(dva.status)) {
      return false;
    }

    // A locally prepared instruction has never reached Paystack.
    if (DVAService.isNeverDispatchedAssignment(dva)) {
      return true;
    }

    // Previously submitted pending instructions may be reconciled,
    // but must never be automatically resubmitted.
    if (dva.status === "pending") {
      return (
        DVAService.hasUserRetryWindowPassed(dva) ||
        (process.env.NODE_ENV === "development" &&
          PaystackService.isTestMode() &&
          process.env.ALLOW_DVA_IMMEDIATE_TEST_RETRY === "true")
      );
    }

    // A failed status does not establish that an earlier provider
    // submission created no dedicated account.
    return false;
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
    return "Dedicated virtual account setup is not available for this business yet. We will complete setup once the payment provider activates this feature.";
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

  static async claimEmployerDVAAssignmentDispatch({
    dvaId,
    userId,
    employerProfileId,
    walletId,
    requestedAt,
    assignmentEmail,
    assignmentMode,
  } = {}) {
    if (
      !dvaId ||
      !userId ||
      !employerProfileId ||
      !walletId ||
      !requestedAt ||
      !assignmentEmail ||
      !["test", "live"].includes(assignmentMode)
    ) {
      throw DVAService.createAssignmentError(
        "Complete assignment identity is required before provider submission.",
        "DVA_ASSIGNMENT_DISPATCH_IDENTITY_REQUIRED",
        { statusCode: 400 }
      );
    }

    if (PaystackService.getMode() !== assignmentMode) {
      throw DVAService.createAssignmentError(
        "Paystack environment changed before assignment submission.",
        "DVA_ASSIGNMENT_DISPATCH_MODE_MISMATCH"
      );
    }

    const dispatchStartedAt = new Date();

    const claimed = await DVA.findOneAndUpdate(
      {
        _id: dvaId,
        ownerUser: userId,
        employer: employerProfileId,
        wallet: walletId,
        provider: "paystack",

        status: "pending",
        requestedAt,

        retirementStartedAt: null,
        retirementConfirmedAt: null,
        retirementResolution: null,

        activatedAt: null,
        paystackDedicatedAccountId: null,
        paystackCustomerId: null,
        paystackCustomerCode: null,
        accountNumber: null,

        "metadata.assignmentEmail": assignmentEmail,
        "metadata.assignmentMode": assignmentMode,

        "metadata.assignmentDispatchState": "prepared",
        "metadata.assignmentDispatchStartedAt": null,
        "metadata.assignmentAcknowledgedAt": null,
        "metadata.assignmentSubmissionOutcome": null,
        "metadata.submitUncertainAt": null,
        "metadata.lastAssignmentEventId": null,
      },
      {
        $set: {
          "metadata.assignmentDispatchState": "dispatch_started",

          "metadata.assignmentDispatchStartedAt": dispatchStartedAt,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    return {
      dva: claimed,
      claimed: Boolean(claimed),
      dispatchStartedAt: claimed ? dispatchStartedAt : null,
    };
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
      !data.paystackCustomerId ||
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

  /* ---------- Re-registration customer identity ---------- */

  static historicalIdentityScope(email, employerProfileId) {
    return {
      provider: "paystack",
      employer: { $ne: employerProfileId },
      $or: [
        { "metadata.assignmentEmail": email },
        { "metadata.requestedWith.email": email },
      ],
    };
  }

  static customerMatchesAssignment(customer, dva) {
    const metadata = DVAService.parsePaystackMetadata(customer?.metadata);
    const requested = dva.metadata?.requestedWith || {};

    return Boolean(
      metadata &&
      DVAService.cleanNumber(customer.id) &&
      DVAService.cleanString(customer.customer_code) &&
      DVAService.cleanString(customer.email)?.toLowerCase() ===
        dva.metadata?.assignmentEmail &&
      DVAService.cleanString(customer.domain)?.toLowerCase() ===
        dva.metadata?.assignmentMode &&
      String(metadata.userId) === String(dva.ownerUser) &&
      String(metadata.employerProfileId) === String(dva.employer) &&
      String(metadata.walletId) === String(dva.wallet) &&
      String(requested.userId) === String(dva.ownerUser) &&
      String(requested.employerProfileId) === String(dva.employer) &&
      String(requested.walletId) === String(dva.wallet) &&
      metadata.countryCode === dva.countryCode &&
      metadata.currency === dva.currency
    );
  }

  static async assertHistoricalIdentityRetired(
    email,
    employerProfileId,
    session = null
  ) {
    const scope = DVAService.historicalIdentityScope(
      email,
      employerProfileId
    );

    const unsafe = await DVA.exists({
      $and: [
        scope,
        {
          $or: [
            { status: { $ne: "deactivated" } },
            { retirementStartedAt: null },
            { retirementConfirmedAt: null },
            { deactivatedAt: null },
            {
              retirementResolution: {
                $nin: [
                  "provider_unassigned",
                  "assignment_never_created",
                ],
              },
            },
          ],
        },
      ],
    }).session(session);

    if (unsafe) {
      throw DVAService.createAssignmentError(
        "A previous dedicated account requires provider reconciliation before setup can continue.",
        "DVA_ASSIGNMENT_HISTORICAL_IDENTITY_CONFLICT"
      );
    }

    return Boolean(
      await DVA.exists(scope).session(session)
    );
  }

  static async verifyFreshCustomerIdentity(dva) {
    const email = dva.metadata?.assignmentEmail;
    const mode = dva.metadata?.assignmentMode;

    if (!email || mode !== PaystackService.getMode()) {
      throw DVAService.createAssignmentError(
        "Dedicated account environment or email changed.",
        "DVA_ASSIGNMENT_PREPARED_IDENTITY_MISMATCH"
      );
    }

    let customer;

    try {
      customer = await PaystackService.fetchPaystackCustomer(email);
    } catch (error) {
      // Only an explicit provider customer-not-found response
      // is accepted. A generic 404, timeout, authorization failure
      // or provider outage is not proof of customer absence.

      const message = String(
        error.providerResponse?.message || ""
      ).trim();

      if (
        error.providerStatusCode === 404 &&
        error.providerResponse?.status === false &&
        /^customer (?:not found|does not exist)[.!]?$/i.test(message)
      ) {
        return;
      }

      throw DVAService.createAssignmentError(
        "Paystack customer identity could not be confirmed. Retry after provider reconciliation.",
        "DVA_ASSIGNMENT_CUSTOMER_VERIFICATION_UNAVAILABLE",
        {
          statusCode: 503,
          retryable: true,
        }
      );
    }

    const customerId = DVAService.cleanNumber(customer?.id);
    const customerCode = DVAService.cleanString(
      customer?.customer_code
    );

    if (
      !DVAService.customerMatchesAssignment(customer, dva) ||
      customer.dedicated_account != null ||
      customer.dedicatedAccount != null ||
      await DVA.exists({
        provider: "paystack",
        _id: { $ne: dva._id },
        $or: [
          { paystackCustomerId: customerId },
          { paystackCustomerCode: customerCode },
        ],
      })
    ) {
      throw DVAService.createAssignmentError(
        "Paystack customer identity requires support reconciliation before a new account can be assigned.",
        "DVA_ASSIGNMENT_HISTORICAL_IDENTITY_CONFLICT"
      );
    }
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

    if (
      DVAService.isNeverDispatchedAssignment(dva) ||
      dva.retirementStartedAt
    ) {
      return dva;
    }

    const email = DVAService.cleanString(dva.metadata?.assignmentEmail)?.toLowerCase();
    const mode = PaystackService.getMode();
    const requested = dva.metadata?.requestedWith || {};

    // Verify the original Loqum assignment.
    if (
      !email ||
      DVAService.cleanString(requested.email)?.toLowerCase() !== email ||
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

  /* ---------- DVA retirement ---------- */

  static async beginEmployerDVARetirement({ dvaId, employerProfileId, walletId, session } = {}) {
    if (!session?.inTransaction?.()) {
      throw DVAService.createAssignmentError(
        "DVA retirement requires an active database transaction.",
        "DVA_RETIREMENT_TRANSACTION_REQUIRED"
      );
    }

    if (!dvaId || !employerProfileId || !walletId) {
      throw DVAService.createAssignmentError(
        "Complete DVA ownership details are required.",
        "DVA_RETIREMENT_IDENTITY_REQUIRED",
        { statusCode: 400 }
      );
    }

    const selector = {
      _id: dvaId,
      employer: employerProfileId,
      wallet: walletId,
      provider: "paystack",
    };

    const dva = await DVA.findOne(selector).session(session);

    if (!dva) {
      throw DVAService.createAssignmentError(
        "Employer DVA not found.",
        "DVA_RETIREMENT_NOT_FOUND",
        { statusCode: 404 }
      );
    }

    if (["retiring", "deactivated"].includes(dva.status)) {
      return {
        dva,
        idempotent: true,
      };
    }

    if (
      !["pending", "active", "failed"].includes(dva.status) ||
      dva.retirementStartedAt ||
      dva.retirementConfirmedAt ||
      dva.retirementResolution
    ) {
      throw DVAService.createAssignmentError(
        "DVA is not eligible for retirement.",
        "DVA_RETIREMENT_STATUS_INVALID"
      );
    }

    const wallet = await Wallet.findOne({
      _id: walletId,
      ownerType: "employer",
      employer: employerProfileId,
      countryCode: dva.countryCode,
      currency: dva.currency,
    }).session(session);

    if (!wallet) {
      throw DVAService.createAssignmentError(
        "DVA does not belong to the original employer wallet.",
        "DVA_RETIREMENT_WALLET_MISMATCH"
      );
    }

    const now = new Date();

    const neverDispatched =
      ["pending", "failed"].includes(dva.status) && DVAService.isNeverDispatchedAssignment(dva);

    const retirementFilter = {
      ...selector,

      status: dva.status,

      retirementStartedAt: null,
      retirementConfirmedAt: null,
      retirementResolution: null,
    };

    const retirementUpdate = {
      status: "retiring",

      isDefault: false,

      retirementStartedAt: now,

      "metadata.retirementPreviousStatus": dva.status,
    };

    // Assignment never created

    if (neverDispatched) {
      Object.assign(retirementFilter, {
        requestedAt: dva.requestedAt,

        activatedAt: null,

        paystackDedicatedAccountId: null,

        paystackCustomerId: null,

        paystackCustomerCode: null,

        accountNumber: null,

        "metadata.assignmentDispatchState": "prepared",

        "metadata.assignmentDispatchStartedAt": null,

        "metadata.assignmentAcknowledgedAt": null,

        "metadata.assignmentSubmissionOutcome": null,

        "metadata.submitUncertainAt": null,

        "metadata.lastAssignmentEventId": null,
      });

      Object.assign(retirementUpdate, {
        retirementResolution: "assignment_never_created",

        retirementConfirmedAt: now,

        "metadata.retirementConfirmation": {
          source: "verified_local_never_dispatched",

          assignmentDispatchState: "prepared",

          assignmentDispatchStartedAt: null,

          providerRequestSubmitted: false,

          confirmedAt: now,
        },
      });
    }

    // Atomic retirement initiation

    const updated = await DVA.findOneAndUpdate(
      retirementFilter,
      {
        $set: retirementUpdate,
      },
      {
        new: true,
        runValidators: true,
        session,
      }
    );

    if (!updated) {
      throw DVAService.createAssignmentError(
        "DVA changed during retirement initiation.",
        "DVA_RETIREMENT_CONCURRENT_UPDATE",
        { retryable: true }
      );
    }

    return {
      dva: updated,
      idempotent: false,
    };
  }

  static async reconcileRetiringDVAAssignment(dva) {
    if (
      !dva ||
      dva.status !== "retiring" ||
      !dva.retirementStartedAt ||
      dva.retirementResolution ||
      dva.retirementConfirmedAt
    ) {
      throw DVAService.createAssignmentError(
        "DVA is not eligible for assignment retirement reconciliation.",
        "DVA_RETIREMENT_RECONCILIATION_STATE_INVALID"
      );
    }

    const metadata = dva.metadata || {};
    const requested = metadata.requestedWith || {};

    const mode = metadata.assignmentMode;

    const email = DVAService.cleanString(metadata.assignmentEmail)?.toLowerCase();

    if (
      !["test", "live"].includes(mode) ||
      PaystackService.getMode() !== mode ||
      !email ||
      !requested.userId ||
      String(requested.employerProfileId) !== String(dva.employer) ||
      String(requested.walletId) !== String(dva.wallet) ||
      requested.countryCode !== dva.countryCode ||
      requested.currency !== dva.currency ||
      DVAService.cleanString(requested.email)?.toLowerCase() !== email
    ) {
      throw DVAService.createAssignmentError(
        "Historical DVA assignment identity is incomplete or inconsistent.",
        "DVA_RETIREMENT_ASSIGNMENT_IDENTITY_MISMATCH"
      );
    }

    const customer = await PaystackService.fetchPaystackCustomer(dva.paystackCustomerCode || email);

    const customerId = DVAService.cleanNumber(customer?.id);

    const customerCode = DVAService.cleanString(customer?.customer_code);

    const customerMetadata = DVAService.parsePaystackMetadata(customer?.metadata);

    if (
      !customerId ||
      !customerCode ||
      DVAService.cleanString(customer.domain)?.toLowerCase() !== mode ||
      DVAService.cleanString(customer.email)?.toLowerCase() !== email ||
      !customerMetadata ||
      String(customerMetadata.userId) !== String(requested.userId) ||
      String(customerMetadata.employerProfileId) !== String(dva.employer) ||
      String(customerMetadata.walletId) !== String(dva.wallet) ||
      customerMetadata.countryCode !== dva.countryCode ||
      customerMetadata.currency !== dva.currency ||
      (dva.paystackCustomerId && dva.paystackCustomerId !== customerId) ||
      (dva.paystackCustomerCode && dva.paystackCustomerCode !== customerCode)
    ) {
      throw DVAService.createAssignmentError(
        "Paystack customer does not match the original DVA assignment.",
        "DVA_RETIREMENT_CUSTOMER_MISMATCH"
      );
    }

    const assignedAccount = customer.dedicated_account || customer.dedicatedAccount;

    const assignedAccountId = DVAService.cleanNumber(assignedAccount?.id);

    if (
      assignedAccountId &&
      dva.paystackDedicatedAccountId &&
      assignedAccountId !== dva.paystackDedicatedAccountId
    ) {
      throw DVAService.createAssignmentError(
        "Paystack customer contains a conflicting dedicated account.",
        "DVA_RETIREMENT_ACCOUNT_ID_CONFLICT"
      );
    }

    const accountId = dva.paystackDedicatedAccountId || assignedAccountId;

    if (!accountId) {
      throw DVAService.createAssignmentError(
        "Paystack has not conclusively resolved the original assignment.",
        "DVA_RETIREMENT_ASSIGNMENT_UNRESOLVED",
        { retryable: true }
      );
    }

    const account = await PaystackService.fetchDedicatedVirtualAccount(accountId);

    const linkedCustomerId = DVAService.cleanNumber(
      typeof account.customer === "object" ? account.customer?.id : account.customer
    );

    const linkedCustomerCode = DVAService.cleanString(account.customer?.customer_code);

    if (
      DVAService.cleanNumber(account.id) !== accountId ||
      account.assigned !== true ||
      linkedCustomerId !== customerId ||
      (linkedCustomerCode && linkedCustomerCode !== customerCode) ||
      DVAService.cleanString(account.currency)?.toUpperCase() !== dva.currency
    ) {
      throw DVAService.createAssignmentError(
        "The dedicated account cannot be conclusively linked to the historical assignment.",
        "DVA_RETIREMENT_ACCOUNT_OWNERSHIP_UNCONFIRMED",
        { retryable: true }
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

    if (
      fields.paystackDedicatedAccountId !== accountId ||
      fields.paystackCustomerId !== customerId ||
      fields.paystackCustomerCode !== customerCode
    ) {
      throw DVAService.createAssignmentError(
        "Recovered dedicated account identifiers are inconsistent.",
        "DVA_RETIREMENT_RECOVERED_IDENTITY_MISMATCH"
      );
    }

    for (const field of [
      "paystackDedicatedAccountId",
      "paystackCustomerId",
      "paystackCustomerCode",
      "paystackReference",
      "accountNumber",
      "bankId",
      "bankCode",
      "bankSlug",
      "providerSlug",
    ]) {
      if (dva[field] != null && dva[field] !== "" && fields[field] !== dva[field]) {
        throw DVAService.createAssignmentError(
          `Recovered DVA identity conflicts with ${field}.`,
          "DVA_RETIREMENT_HISTORICAL_IDENTITY_CONFLICT"
        );
      }
    }

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

    if (fields.providerSlug && fields.accountNumber) {
      conflictConditions.push({
        providerSlug: fields.providerSlug,
        accountNumber: fields.accountNumber,
      });
    }

    const conflict = await DVA.exists({
      _id: { $ne: dva._id },
      provider: "paystack",
      $or: conflictConditions,
    });

    if (conflict) {
      throw DVAService.createAssignmentError(
        "Recovered provider identity belongs to another DVA.",
        "DVA_RETIREMENT_ACCOUNT_ALREADY_CLAIMED"
      );
    }

    const now = new Date();

    const updated = await DVA.findOneAndUpdate(
      {
        _id: dva._id,
        employer: dva.employer,
        wallet: dva.wallet,
        provider: "paystack",
        status: "retiring",
        retirementStartedAt: dva.retirementStartedAt,
        retirementResolution: null,
        retirementConfirmedAt: null,

        paystackDedicatedAccountId: dva.paystackDedicatedAccountId ?? null,

        paystackCustomerId: dva.paystackCustomerId ?? null,

        paystackCustomerCode: dva.paystackCustomerCode ?? null,

        accountNumber: dva.accountNumber ?? null,

        "metadata.assignmentMode": mode,
      },
      {
        $set: {
          ...fields,

          isDefault: false,

          lastSyncedAt: now,

          "metadata.retirementAssignmentReconciledAt": now,

          "metadata.retirementAssignmentReconciliation": {
            source: "verified_paystack_customer_and_account",
            customerId,
            customerCode,
            dedicatedAccountId: accountId,
            reconciledAt: now,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updated) {
      throw DVAService.createAssignmentError(
        "DVA changed during assignment retirement reconciliation.",
        "DVA_RETIREMENT_CONCURRENT_UPDATE",
        { retryable: true }
      );
    }

    return updated;
  }

  static async confirmEmployerDVARetirement({ dvaId, employerProfileId, walletId } = {}) {
    if (!dvaId || !employerProfileId || !walletId) {
      throw DVAService.createAssignmentError(
        "Complete DVA ownership details are required.",
        "DVA_RETIREMENT_IDENTITY_REQUIRED",
        { statusCode: 400 }
      );
    }

    const selector = {
      _id: dvaId,
      employer: employerProfileId,
      wallet: walletId,
      provider: "paystack",
    };

    let dva = await DVA.findOne(selector);

    if (!dva) {
      throw DVAService.createAssignmentError(
        "Employer DVA not found.",
        "DVA_RETIREMENT_NOT_FOUND",
        { statusCode: 404 }
      );
    }

    if (!["retiring", "deactivated"].includes(dva.status)) {
      throw DVAService.createAssignmentError(
        "DVA retirement has not been initiated.",
        "DVA_RETIREMENT_NOT_STARTED"
      );
    }

    if (dva.retirementResolution && dva.retirementConfirmedAt) {
      return {
        dva,
        idempotent: true,
      };
    }

    if (dva.status !== "retiring" || !dva.retirementStartedAt) {
      throw DVAService.createAssignmentError(
        "DVA retirement state is invalid.",
        "DVA_RETIREMENT_STATE_INVALID"
      );
    }

    if (
      dva.metadata?.retirementPreviousStatus !== "active" &&
      !dva.metadata?.retirementAssignmentReconciledAt
    ) {
      dva = await DVAService.reconcileRetiringDVAAssignment(dva);
    }

    const expectedMode = dva.metadata?.assignmentMode;

    if (
      !dva.paystackDedicatedAccountId ||
      !dva.paystackCustomerId ||
      !dva.paystackCustomerCode ||
      !dva.accountNumber ||
      !dva.currency ||
      !["test", "live"].includes(expectedMode)
    ) {
      throw DVAService.createAssignmentError(
        "Historical DVA identity is incomplete.",
        "DVA_RETIREMENT_PROVIDER_IDENTITY_INCOMPLETE"
      );
    }

    const confirmation = await PaystackService.deactivateDedicatedVirtualAccount({
      dedicatedAccountId: dva.paystackDedicatedAccountId,
      expectedCustomerId: dva.paystackCustomerId,
      expectedCustomerCode: dva.paystackCustomerCode,
      expectedAccountNumber: dva.accountNumber,
      expectedCurrency: dva.currency,
      expectedMode,
    });

    if (
      confirmation.assigned !== false ||
      String(confirmation.dedicatedAccountId) !== String(dva.paystackDedicatedAccountId) ||
      String(confirmation.customerId) !== String(dva.paystackCustomerId) ||
      confirmation.customerCode !== dva.paystackCustomerCode ||
      confirmation.accountNumber !== dva.accountNumber ||
      confirmation.currency !== dva.currency ||
      confirmation.mode !== expectedMode
    ) {
      throw DVAService.createAssignmentError(
        "Paystack DVA retirement could not be confirmed.",
        "DVA_RETIREMENT_PROVIDER_UNCONFIRMED",
        { retryable: true }
      );
    }

    const now = new Date();

    const updated = await DVA.findOneAndUpdate(
      {
        ...selector,
        status: "retiring",
        retirementStartedAt: dva.retirementStartedAt,
        retirementResolution: null,
        retirementConfirmedAt: null,
        paystackDedicatedAccountId: dva.paystackDedicatedAccountId,
        paystackCustomerId: dva.paystackCustomerId,
        paystackCustomerCode: dva.paystackCustomerCode,
        accountNumber: dva.accountNumber,
        currency: dva.currency,
        "metadata.assignmentMode": expectedMode,
      },
      {
        $set: {
          retirementResolution: "provider_unassigned",
          retirementConfirmedAt: now,
          lastSyncedAt: now,

          "metadata.retirementConfirmation": {
            source: confirmation.confirmationSource,
            alreadyUnassigned: confirmation.alreadyUnassigned,
            assigned: false,
            active: confirmation.active,
            mode: confirmation.mode,
            confirmedAt: now,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updated) {
      const latest = await DVA.findOne(selector);

      if (
        latest?.retirementResolution === "provider_unassigned" &&
        latest.retirementConfirmedAt &&
        ["retiring", "deactivated"].includes(latest.status)
      ) {
        return {
          dva: latest,
          idempotent: true,
        };
      }

      throw DVAService.createAssignmentError(
        "DVA changed during provider retirement.",
        "DVA_RETIREMENT_CONCURRENT_UPDATE",
        { retryable: true }
      );
    }

    return {
      dva: updated,
      idempotent: false,
    };
  }

  /* ---------- FINALIZE DVA RETIREMENT ---------- */

  static async finalizeEmployerDVARetirement({
    dvaId,
    employerProfileId,
    walletId,
    currentTime = new Date(),
    session,
  } = {}) {
    // Transaction requirement

    if (!session?.inTransaction?.()) {
      throw DVAService.createAssignmentError(
        "Final DVA retirement requires an active database transaction.",
        "DVA_RETIREMENT_TRANSACTION_REQUIRED"
      );
    }

    if (!dvaId || !employerProfileId || !walletId) {
      throw DVAService.createAssignmentError(
        "Complete DVA ownership details are required.",
        "DVA_RETIREMENT_IDENTITY_REQUIRED"
      );
    }

    const at =
      currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

    if (Number.isNaN(at.getTime())) {
      throw DVAService.createAssignmentError(
        "Invalid DVA retirement finalization time.",
        "DVA_RETIREMENT_TIME_INVALID"
      );
    }

    // Load original DVA

    const dva = await DVA.findOne({
      _id: dvaId,
      employer: employerProfileId,
      wallet: walletId,
      provider: "paystack",
    }).session(session);

    if (!dva) {
      throw DVAService.createAssignmentError(
        "Original employer DVA was not found.",
        "DVA_RETIREMENT_NOT_FOUND"
      );
    }

    // Verify original wallet

    const wallet = await Wallet.findById(walletId).session(session);

    if (
      !wallet ||
      wallet.ownerType !== "employer" ||
      String(wallet.employer) !== String(employerProfileId) ||
      wallet.countryCode !== dva.countryCode ||
      wallet.currency !== dva.currency
    ) {
      throw DVAService.createAssignmentError(
        "DVA does not match its original employer wallet.",
        "DVA_RETIREMENT_WALLET_MISMATCH"
      );
    }

    // Require confirmed provider resolution

    if (
      !dva.retirementStartedAt ||
      !dva.retirementConfirmedAt ||
      !["provider_unassigned", "assignment_never_created"].includes(dva.retirementResolution)
    ) {
      throw DVAService.createAssignmentError(
        "Provider retirement must be resolved before finalization.",
        "DVA_RETIREMENT_PROVIDER_UNCONFIRMED"
      );
    }

    if (dva.retirementResolution === "provider_unassigned" && !dva.paystackDedicatedAccountId) {
      throw DVAService.createAssignmentError(
        "Provider retirement requires its historical dedicated account ID.",
        "DVA_RETIREMENT_PROVIDER_IDENTITY_INCOMPLETE"
      );
    }

    if (
      dva.retirementResolution === "assignment_never_created" &&
      (dva.activatedAt || dva.paystackDedicatedAccountId || dva.accountNumber)
    ) {
      throw DVAService.createAssignmentError(
        "Existing dedicated account identity requires provider unassignment.",
        "DVA_RETIREMENT_RESOLUTION_CONFLICT"
      );
    }

    // Require closed original wallet

    if (
      wallet.status !== "closed" ||
      !wallet.closedAt ||
      wallet.availableBalance !== 0 ||
      wallet.pendingBalance !== 0 ||
      wallet.outstandingBalance !== 0
    ) {
      throw DVAService.createAssignmentError(
        "The original employer wallet must be closed with zero balances.",
        "DVA_RETIREMENT_WALLET_NOT_CLOSED"
      );
    }

    // Idempotent finalization

    if (dva.status === "deactivated") {
      if (!dva.deactivatedAt || dva.isDefault || dva.deactivatedAt < dva.retirementConfirmedAt) {
        throw DVAService.createAssignmentError(
          "Existing DVA retirement state is inconsistent.",
          "DVA_RETIREMENT_STATE_INVALID"
        );
      }

      return {
        dva,
        idempotent: true,
      };
    }

    // Validate final transition

    if (
      dva.status !== "retiring" ||
      dva.deactivatedAt ||
      dva.retirementConfirmedAt < dva.retirementStartedAt ||
      at < dva.retirementConfirmedAt ||
      at < wallet.closedAt
    ) {
      throw DVAService.createAssignmentError(
        "DVA retirement cannot be finalized in its current state.",
        "DVA_RETIREMENT_FINALIZATION_INVALID"
      );
    }

    // Finalize without altering ownership

    dva.status = "deactivated";
    dva.isDefault = false;
    dva.deactivatedAt = at;

    dva.metadata = {
      ...(dva.metadata || {}),

      retirementFinalization: {
        source: "business_closure",
        finalizedAt: at,
        employerProfileId: String(dva.employer),
        walletId: String(dva.wallet),
        resolution: dva.retirementResolution,
      },
    };

    dva.markModified("metadata");

    await dva.save({ session });

    return {
      dva,
      idempotent: false,
    };
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

        message: "Your dedicated virtual account has not been set up yet.",

        canRetrySetup: true,

        canReconcile: false,

        requiresReconciliation: false,

        retryAvailableAt: null,

        dva: null,
      };
    }

    const rawStatus = dva.status;

    // Retirement states

    if (dva.retirementStartedAt || ["retiring", "deactivated"].includes(rawStatus)) {
      const retiredStatus = rawStatus === "deactivated" ? "deactivated" : "retiring";

      return {
        status: retiredStatus,

        rawStatus,

        message:
          retiredStatus === "retiring"
            ? "Your dedicated virtual account is being retired. Do not send further payments."
            : "Your dedicated virtual account has been deactivated.",

        canRetrySetup: false,

        canReconcile: false,

        requiresReconciliation: false,

        retryAvailableAt: null,

        dva: null,
      };
    }

    // Active DVA

    if (rawStatus === "active") {
      return {
        status: "active",

        rawStatus,

        message: "Your dedicated virtual account is ready.",

        canRetrySetup: false,

        canReconcile: false,

        requiresReconciliation: false,

        retryAvailableAt: null,

        dva,
      };
    }

    // Never-dispatched assignment

    if (DVAService.isNeverDispatchedAssignment(dva)) {
      return {
        status: "setup_pending",

        rawStatus,

        message: "Your dedicated virtual account setup is ready to continue.",

        canRetrySetup: true,

        canReconcile: false,

        requiresReconciliation: false,

        retryAvailableAt: null,

        dva,
      };
    }

    // Previously submitted assignment

    if (rawStatus === "pending") {
      const canReconcile = DVAService.canRetryDVA(dva);

      return {
        status: "setup_pending",

        rawStatus,

        message:
          "Your dedicated virtual account assignment is awaiting confirmation from the payment provider.",

        // Preserve the existing frontend retry contract.
        // Calling setup again will reconcile the existing
        // assignment, not submit another provider request.

        canRetrySetup: canReconcile,

        canReconcile,

        requiresReconciliation: true,

        retryAvailableAt: canReconcile ? null : DVAService.getRetryAvailableAt(dva),

        dva,
      };
    }

    // Failed provider assignment

    if (rawStatus === "failed") {
      return {
        status: "setup_pending",

        rawStatus,

        message:
          dva.failureReason ||
          "Your dedicated virtual account requires reconciliation before setup can continue.",

        canRetrySetup: false,

        canReconcile: false,

        requiresReconciliation: true,

        retryAvailableAt: null,

        dva,
      };
    }

    throw DVAService.createAssignmentError(
      "Dedicated virtual account has an unsupported status.",
      "DVA_STATUS_UNSUPPORTED"
    );
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

    const identityKeys = [];

    if (accountId) {
      identityKeys.push({
        paystackDedicatedAccountId: accountId,
      });
    }

    if (customerCode) {
      identityKeys.push({
        paystackCustomerCode: customerCode,
      });
    }

    if (customerId) {
      identityKeys.push({
        paystackCustomerId: customerId,
      });
    }

    const scope = {
      provider: "paystack",
      countryCode: "NG",
      currency: "NGN",
    };

    if (!identityKeys.length && !customerEmail) {
      throw DVAService.createAssignmentError(
        "Paystack assignment event has no usable identity.",
        "PAYSTACK_DVA_ASSIGNMENT_IDENTITY_REQUIRED",
        {
          retryable: false,
          statusCode: 422,
        }
      );
    }

    // Provider identifiers take precedence over email.
    let candidates = identityKeys.length
      ? await DVA.find({
          ...scope,
          $or: identityKeys,
        }).limit(2)
      : [];

    const matchedByProviderIdentity = candidates.length > 0;

    if (!candidates.length && customerEmail) {
      candidates = await DVA.find({
        ...scope,
        $or: [
          { "metadata.assignmentEmail": customerEmail },
          { "metadata.requestedWith.email": customerEmail },
        ],
      }).limit(2);
    }

    if (
      candidates.length > 1 &&
      !matchedByProviderIdentity
    ) {
      // A reused email cannot establish ownership of
      // an assignment. Verify the provider customer and
      // its exact employer-wallet metadata independently.

      if (!customerId && !customerCode) {
        throw DVAService.createAssignmentError(
          "Paystack assignment matches multiple historical DVA records.",
          "PAYSTACK_DVA_ASSIGNMENT_AMBIGUOUS"
        );
      }

      const customer = await PaystackService.fetchPaystackCustomer(
        customerCode || customerEmail
      );

      const metadata = DVAService.parsePaystackMetadata(
        customer?.metadata
      );

      if (
        !metadata ||
        (
          customerId &&
          DVAService.cleanNumber(customer.id) !== customerId
        ) ||
        (
          customerCode &&
          DVAService.cleanString(customer.customer_code) !== customerCode
        )
      ) {
        throw DVAService.createAssignmentError(
          "Paystack assignment customer could not be verified.",
          "PAYSTACK_DVA_ASSIGNMENT_AMBIGUOUS"
        );
      }

      const selected = await DVA.findOne({
        ...scope,
        status: "pending",
        retirementStartedAt: null,
        "metadata.assignmentEmail": customerEmail,
        "metadata.assignmentMode": PaystackService.getMode(),
        "metadata.requestedWith.userId": String(metadata.userId),
        "metadata.requestedWith.employerProfileId": String(metadata.employerProfileId),
        "metadata.requestedWith.walletId": String(metadata.walletId),
      });

      if (
        !selected ||
        DVAService.isNeverDispatchedAssignment(selected) ||
        !DVAService.customerMatchesAssignment(customer, selected)
      ) {
        throw DVAService.createAssignmentError(
          "Paystack assignment cannot be matched to a new employer wallet.",
          "PAYSTACK_DVA_ASSIGNMENT_AMBIGUOUS"
        );
      }

      candidates = [selected];
    }

    if (candidates.length > 1) {
      throw DVAService.createAssignmentError(
        "Paystack assignment matches multiple historical DVA records.",
        "PAYSTACK_DVA_ASSIGNMENT_AMBIGUOUS"
      );
    }

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

  static async reconcileHistoricalAssignmentEvent({
    identity,
    eventName,
    normalizedPayload = {},
    rawPayload = {},
    providerEventRecordId,
    providerEventMarker,
  } = {}) {
    let dva = identity?.dva;

    // Validate the historical DVA and its retirement state.

    if (
      !dva?._id ||
      !dva.employer ||
      !dva.wallet ||
      !["retiring", "deactivated"].includes(dva.status) ||
      !dva.retirementStartedAt
    ) {
      throw DVAService.createAssignmentError(
        "Historical assignment requires a retiring or deactivated DVA.",
        "DVA_HISTORICAL_ASSIGNMENT_STATE_INVALID"
      );
    }

    if (
      !["dedicatedaccount.assign.success", "dedicatedaccount.assign.failed"].includes(eventName) ||
      !providerEventRecordId ||
      !providerEventMarker
    ) {
      throw DVAService.createAssignmentError(
        "Verified historical assignment event identity is required.",
        "DVA_HISTORICAL_ASSIGNMENT_EVENT_INVALID"
      );
    }

    DVAService.assertAssignmentMode(dva, normalizedPayload, rawPayload);

    const mode = dva.metadata?.assignmentMode;

    if (!["test", "live"].includes(mode) || PaystackService.getMode() !== mode) {
      throw DVAService.createAssignmentError(
        "Historical assignment belongs to a different provider environment.",
        "DVA_HISTORICAL_ASSIGNMENT_MODE_MISMATCH"
      );
    }

    // An email address alone cannot establish historical provider identity.

    const eventAccountId = DVAService.cleanNumber(identity.accountId);

    const eventCustomerId = DVAService.cleanNumber(identity.customerId);

    const eventCustomerCode = DVAService.cleanString(identity.customerCode);

    const eventAccountNumber = DVAService.cleanString(normalizedPayload.accountNumber);

    if (!eventAccountId && !eventCustomerId && !eventCustomerCode) {
      throw DVAService.createAssignmentError(
        "Historical assignment cannot be reconciled using email alone.",
        "DVA_HISTORICAL_ASSIGNMENT_IDENTITY_INSUFFICIENT"
      );
    }

    // Do not overwrite an established never-created retirement resolution.

    if (dva.retirementResolution === "assignment_never_created") {
      throw DVAService.createAssignmentError(
        "Provider assignment conflicts with the recorded never-created retirement resolution.",
        "DVA_HISTORICAL_ASSIGNMENT_RESOLUTION_CONFLICT"
      );
    }

    // Validate the event against the original DVA's provider identity.

    const assertMatchingIdentity = (historicalDVA, requireComplete = false) => {
      const storedAccountId = DVAService.cleanNumber(historicalDVA.paystackDedicatedAccountId);

      const storedCustomerId = DVAService.cleanNumber(historicalDVA.paystackCustomerId);

      const storedCustomerCode = DVAService.cleanString(historicalDVA.paystackCustomerCode);

      const storedAccountNumber = DVAService.cleanString(historicalDVA.accountNumber);

      const storedEmail = DVAService.cleanString(
        historicalDVA.metadata?.assignmentEmail
      )?.toLowerCase();

      const eventEmail = DVAService.cleanString(identity.customerEmail)?.toLowerCase();

      if (
        (eventAccountId && storedAccountId && eventAccountId !== storedAccountId) ||
        (eventCustomerId && storedCustomerId && eventCustomerId !== storedCustomerId) ||
        (eventCustomerCode && storedCustomerCode && eventCustomerCode !== storedCustomerCode) ||
        (eventAccountNumber && storedAccountNumber && eventAccountNumber !== storedAccountNumber) ||
        (eventEmail && storedEmail && eventEmail !== storedEmail)
      ) {
        throw DVAService.createAssignmentError(
          "Provider assignment conflicts with the historical DVA identity.",
          "DVA_HISTORICAL_ASSIGNMENT_IDENTITY_CONFLICT"
        );
      }

      if (requireComplete) {
        if (
          !storedAccountId ||
          !storedCustomerId ||
          !storedCustomerCode ||
          !storedAccountNumber ||
          !storedEmail
        ) {
          throw DVAService.createAssignmentError(
            "Historical DVA provider identity remains incomplete.",
            "DVA_HISTORICAL_ASSIGNMENT_IDENTITY_INCOMPLETE",
            { retryable: true }
          );
        }

        if (
          (eventAccountId && eventAccountId !== storedAccountId) ||
          (eventCustomerId && eventCustomerId !== storedCustomerId) ||
          (eventCustomerCode && eventCustomerCode !== storedCustomerCode) ||
          (eventAccountNumber && eventAccountNumber !== storedAccountNumber)
        ) {
          throw DVAService.createAssignmentError(
            "Historical assignment event could not be conclusively matched.",
            "DVA_HISTORICAL_ASSIGNMENT_MATCH_UNCONFIRMED"
          );
        }
      }

      return true;
    };

    assertMatchingIdentity(dva);

    const originalDvaId = String(dva._id);

    const originalEmployerId = String(dva.employer);

    const originalWalletId = String(dva.wallet);

    let idempotent = Boolean(dva.retirementResolution && dva.retirementConfirmedAt);

    // Reconcile retirement if provider unassignment remains unconfirmed.

    if (!dva.retirementResolution || !dva.retirementConfirmedAt) {
      if (dva.status !== "retiring") {
        throw DVAService.createAssignmentError(
          "A deactivated DVA must already have a confirmed retirement resolution.",
          "DVA_HISTORICAL_ASSIGNMENT_RETIREMENT_INVALID"
        );
      }

      // Recover the original account without restoring the DVA to active.

      if (
        dva.metadata?.retirementPreviousStatus !== "active" &&
        !dva.metadata?.retirementAssignmentReconciledAt
      ) {
        dva = await DVAService.reconcileRetiringDVAAssignment(dva);
      }

      // Verify the signed event against the recovered provider identity.

      assertMatchingIdentity(dva, true);

      const confirmation = await DVAService.confirmEmployerDVARetirement({
        dvaId: dva._id,
        employerProfileId: dva.employer,
        walletId: dva.wallet,
      });

      dva = confirmation?.dva;

      if (!dva) {
        throw DVAService.createAssignmentError(
          "Historical DVA retirement returned no confirmed record.",
          "DVA_HISTORICAL_ASSIGNMENT_RETIREMENT_UNCONFIRMED",
          { retryable: true }
        );
      }

      idempotent = confirmation.idempotent === true;
    }

    // Confirm that retirement preserved the original ownership and status.

    if (
      String(dva._id) !== originalDvaId ||
      String(dva.employer) !== originalEmployerId ||
      String(dva.wallet) !== originalWalletId ||
      !["retiring", "deactivated"].includes(dva.status) ||
      !dva.retirementStartedAt ||
      dva.retirementResolution !== "provider_unassigned" ||
      !dva.retirementConfirmedAt ||
      dva.retirementConfirmedAt < dva.retirementStartedAt ||
      dva.isDefault === true
    ) {
      throw DVAService.createAssignmentError(
        "Historical assignment requires confirmed provider unassignment.",
        "DVA_HISTORICAL_ASSIGNMENT_RETIREMENT_UNCONFIRMED",
        { retryable: true }
      );
    }

    assertMatchingIdentity(dva, true);

    const retirementConfirmation = dva.metadata?.retirementConfirmation;

    if (
      !retirementConfirmation ||
      retirementConfirmation.assigned !== false ||
      retirementConfirmation.mode !== mode
    ) {
      throw DVAService.createAssignmentError(
        "Historical DVA retirement evidence is incomplete.",
        "DVA_HISTORICAL_ASSIGNMENT_EVIDENCE_INVALID"
      );
    }

    // Independently verify the current provider account state.

    const account = await PaystackService.fetchDedicatedVirtualAccount(
      dva.paystackDedicatedAccountId
    );

    const accountId = DVAService.cleanNumber(account?.id);

    const accountNumber = DVAService.cleanString(account?.account_number);

    const currency = DVAService.cleanString(account?.currency)?.toUpperCase();

    if (
      accountId !== DVAService.cleanNumber(dva.paystackDedicatedAccountId) ||
      accountNumber !== dva.accountNumber ||
      currency !== dva.currency ||
      typeof account.assigned !== "boolean" ||
      typeof account.active !== "boolean"
    ) {
      throw DVAService.createAssignmentError(
        "Provider account does not match the historical DVA.",
        "DVA_HISTORICAL_ASSIGNMENT_ACCOUNT_MISMATCH"
      );
    }

    const returnedCustomerId = DVAService.cleanNumber(
      typeof account.customer === "object" ? account.customer?.id : account.customer
    );

    const returnedCustomerCode = DVAService.cleanString(account.customer?.customer_code);

    if (
      (returnedCustomerId &&
        returnedCustomerId !== DVAService.cleanNumber(dva.paystackCustomerId)) ||
      (returnedCustomerCode && returnedCustomerCode !== dva.paystackCustomerCode)
    ) {
      throw DVAService.createAssignmentError(
        "Provider account is associated with a conflicting customer.",
        "DVA_HISTORICAL_ASSIGNMENT_CUSTOMER_CONFLICT"
      );
    }

    // Never automatically unassign an account reported as reassigned
    // after retirement. It may now belong to another provider customer.

    if (account.assigned !== false) {
      throw DVAService.createAssignmentError(
        "Provider reports an assigned account after confirmed retirement.",
        "DVA_HISTORICAL_ASSIGNMENT_REASSIGNED",
        { retryable: true }
      );
    }

    // Return the verified historical outcome without changing DVA status.

    return {
      dva,

      idempotent,

      historicalAssignmentReconciled: true,

      assignmentOutcome: eventName === "dedicatedaccount.assign.success" ? "success" : "failed",

      retirementResolution: dva.retirementResolution,

      retirementConfirmedAt: dva.retirementConfirmedAt,

      resolutionSource: "verified_historical_provider_unassignment",

      historicalReconciliation: {
        providerEventRecordId: String(providerEventRecordId),

        providerEventMarker: String(providerEventMarker),

        dedicatedAccountId: String(dva.paystackDedicatedAccountId),

        customerId: String(dva.paystackCustomerId),

        customerCode: dva.paystackCustomerCode,

        accountNumber: dva.accountNumber,

        providerMode: mode,

        assigned: false,

        active: account.active,

        verifiedAt: new Date(),
      },
    };
  }

  static async applyPaystackAssignmentEvent({
    eventName,
    normalizedPayload = {},
    rawPayload = {},
    providerEventRecordId,
    providerEventMarker,
    expectedOwnership = {},
    currentTime = new Date(),
  } = {}) {
    // Validate the verified assignment event.

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

    const at =
      currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

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

    // Resolve the original DVA and validate its provider environment.

    const identity = await DVAService.resolveAssignmentDVA({
      normalizedPayload,
      rawPayload,
    });

    const dva = identity.dva;

    if (!dva?._id || !dva.employer || !dva.wallet) {
      throw DVAService.createAssignmentError(
        "DVA assignment could not resolve its original ownership.",
        "PAYSTACK_DVA_ASSIGNMENT_OWNERSHIP_REQUIRED"
      );
    }

    DVAService.assertAssignmentMode(dva, normalizedPayload, rawPayload);

    // Preserve any previously established provider event relationships.

    const assertExpectedOwnership = (record) => {
      for (const [field, actual] of Object.entries({
        dva: record._id,
        employer: record.employer,
        wallet: record.wallet,
      })) {
        const expected = expectedOwnership[field];

        if (expected != null && String(expected) !== String(actual)) {
          throw DVAService.createAssignmentError(
            `DVA assignment conflicts with its established ${field} relationship.`,
            "PAYSTACK_DVA_ASSIGNMENT_OWNERSHIP_CONFLICT"
          );
        }
      }
    };

    assertExpectedOwnership(dva);

    // Historical assignments must not reverse or finalize DVA retirement.

    if (dva.retirementStartedAt || ["retiring", "deactivated"].includes(dva.status)) {
      return DVAService.reconcileHistoricalAssignmentEvent({
        identity,

        eventName,

        normalizedPayload,

        rawPayload,

        providerEventRecordId,

        providerEventMarker,
      });
    }

    // Determine the expected normal assignment outcome.

    const success = eventName === "dedicatedaccount.assign.success";

    const desiredStatus = success ? "active" : "failed";

    const eventAccountNumber = DVAService.cleanString(normalizedPayload.accountNumber);

    const assertEventIdentity = (record, requireComplete = false) => {
      const comparisons = [
        [identity.accountId, DVAService.cleanNumber(record.paystackDedicatedAccountId)],

        [identity.customerId, DVAService.cleanNumber(record.paystackCustomerId)],

        [identity.customerCode, DVAService.cleanString(record.paystackCustomerCode)],

        [eventAccountNumber, DVAService.cleanString(record.accountNumber)],
      ];

      for (const [incoming, stored] of comparisons) {
        if (
          incoming != null &&
          ((stored != null && incoming !== stored) || (requireComplete && stored == null))
        ) {
          throw DVAService.createAssignmentError(
            "Provider assignment conflicts with the established DVA identity.",
            "PAYSTACK_DVA_ASSIGNMENT_IDENTITY_CONFLICT"
          );
        }
      }

      return true;
    };

    assertEventIdentity(dva);

    // A duplicate terminal assignment must not repeat the state transition.

    if (dva.status === desiredStatus) {
      assertEventIdentity(dva, success);

      return {
        dva,

        idempotent: true,

        historicalAssignmentReconciled: false,

        assignmentOutcome: success ? "success" : "failed",

        resolutionSource: "existing_terminal_state",
      };
    }

    if (dva.status !== "pending") {
      throw DVAService.createAssignmentError(
        "Paystack DVA assignment conflicts with the existing terminal DVA status.",
        "PAYSTACK_DVA_TERMINAL_STATUS_CONFLICT"
      );
    }

    // A locally prepared assignment has not reached Paystack.
    // A provider event must not activate or fail that record.

    if (DVAService.isNeverDispatchedAssignment(dva)) {
      throw DVAService.createAssignmentError(
        "Provider assignment conflicts with an instruction that has not been dispatched.",
        "PAYSTACK_DVA_ASSIGNMENT_NOT_DISPATCHED"
      );
    }

    // Preserve the verified assignment event audit.

    const audit = {
      "metadata.lastAssignmentEventId": String(providerEventRecordId),

      "metadata.lastAssignmentEventMarker": String(providerEventMarker),

      "metadata.lastAssignmentEventName": eventName,

      "metadata.lastAssignmentEventAt": at,

      "metadata.initialReconciliationPending": false,
    };

    let update;

    if (success) {
      // Verify the original Paystack customer and assignment identity.

      const requested = dva.metadata?.requestedWith || {};

      const expectedEmail = DVAService.cleanString(dva.metadata?.assignmentEmail)?.toLowerCase();

      const expectedMode = dva.metadata?.assignmentMode;

      const lookupKey = dva.paystackCustomerCode || identity.customerCode || expectedEmail;

      if (
        !lookupKey ||
        !expectedEmail ||
        !requested.userId ||
        !["test", "live"].includes(expectedMode) ||
        PaystackService.getMode() !== expectedMode ||
        String(requested.employerProfileId) !== String(dva.employer) ||
        String(requested.walletId) !== String(dva.wallet) ||
        requested.countryCode !== dva.countryCode ||
        requested.currency !== dva.currency
      ) {
        throw DVAService.createAssignmentError(
          "Original DVA assignment identity is incomplete.",
          "PAYSTACK_DVA_CUSTOMER_LOOKUP_REQUIRED",
          {
            retryable: true,
            statusCode: 503,
          }
        );
      }

      const customer = await PaystackService.fetchPaystackCustomer(lookupKey);

      const customerMetadata = DVAService.parsePaystackMetadata(customer.metadata);

      const customerId = DVAService.cleanNumber(customer.id);

      const customerCode = DVAService.cleanString(customer.customer_code);

      const customerEmail = DVAService.cleanString(customer.email)?.toLowerCase();

      const customerMode = DVAService.cleanString(customer.domain)?.toLowerCase();

      if (
        !customerId ||
        !customerCode ||
        customerEmail !== expectedEmail ||
        customerMode !== expectedMode ||
        !customerMetadata ||
        String(customerMetadata.userId) !== String(requested.userId) ||
        String(customerMetadata.employerProfileId) !== String(dva.employer) ||
        String(customerMetadata.walletId) !== String(dva.wallet) ||
        String(customerMetadata.countryCode || "").toUpperCase() !== dva.countryCode ||
        String(customerMetadata.currency || "").toUpperCase() !== dva.currency
      ) {
        throw DVAService.createAssignmentError(
          "Paystack customer does not match the original employer wallet assignment.",
          "PAYSTACK_DVA_CUSTOMER_OWNERSHIP_MISMATCH"
        );
      }

      if (
        (identity.customerId && identity.customerId !== customerId) ||
        (identity.customerCode && identity.customerCode !== customerCode) ||
        (dva.paystackCustomerId && DVAService.cleanNumber(dva.paystackCustomerId) !== customerId) ||
        (dva.paystackCustomerCode && dva.paystackCustomerCode !== customerCode)
      ) {
        throw DVAService.createAssignmentError(
          "Paystack customer conflicts with the signed assignment event.",
          "PAYSTACK_DVA_CUSTOMER_IDENTITY_MISMATCH"
        );
      }

      // Resolve the dedicated account associated with the verified customer.

      const assignedAccount = customer.dedicated_account || customer.dedicatedAccount;

      const accountId = DVAService.cleanNumber(assignedAccount?.id);

      if (!accountId || assignedAccount.assigned !== true || assignedAccount.active !== true) {
        throw DVAService.createAssignmentError(
          "Paystack has not confirmed an active assigned account.",
          "PAYSTACK_DVA_CUSTOMER_ACCOUNT_PENDING",
          {
            retryable: true,
            statusCode: 503,
          }
        );
      }

      if (identity.accountId && identity.accountId !== accountId) {
        throw DVAService.createAssignmentError(
          "Paystack account ID conflicts with the assignment event.",
          "PAYSTACK_DVA_ACCOUNT_IDENTITY_MISMATCH"
        );
      }

      // Independently verify account ownership and assignment status.

      const account = await PaystackService.fetchDedicatedVirtualAccount(accountId);

      const linkedCustomerId = DVAService.cleanNumber(
        typeof account.customer === "object" ? account.customer?.id : account.customer
      );

      const linkedCustomerCode = DVAService.cleanString(account.customer?.customer_code);

      if (
        DVAService.cleanNumber(account.id) !== accountId ||
        account.assigned !== true ||
        account.active !== true ||
        linkedCustomerId !== customerId ||
        (linkedCustomerCode && linkedCustomerCode !== customerCode) ||
        DVAService.cleanString(account.currency)?.toUpperCase() !== dva.currency
      ) {
        throw DVAService.createAssignmentError(
          "Independent Paystack verification did not confirm the assigned account.",
          "PAYSTACK_DVA_ACCOUNT_OWNERSHIP_MISMATCH",
          { retryable: true }
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
          "Paystack returned incomplete assigned-account details.",
          "PAYSTACK_DVA_CUSTOMER_ACCOUNT_INCOMPLETE",
          {
            retryable: true,
            statusCode: 503,
          }
        );
      }

      if (
        fields.paystackDedicatedAccountId !== accountId ||
        fields.paystackCustomerId !== customerId ||
        fields.paystackCustomerCode !== customerCode
      ) {
        throw DVAService.createAssignmentError(
          "Verified provider identifiers are inconsistent.",
          "PAYSTACK_DVA_ACCOUNT_IDENTITY_MISMATCH"
        );
      }

      assertEventIdentity(fields, true);

      // Preserve provider identifiers already recorded on the DVA.

      const protectedIdentityFields = [
        "paystackDedicatedAccountId",
        "paystackCustomerId",
        "paystackCustomerCode",
        "paystackReference",
        "accountNumber",
        "bankId",
        "bankCode",
        "bankSlug",
        "providerSlug",
      ];

      for (const field of protectedIdentityFields) {
        if (dva[field] != null && dva[field] !== "" && fields[field] !== dva[field]) {
          throw DVAService.createAssignmentError(
            `Verified assignment conflicts with existing ${field}.`,
            "PAYSTACK_DVA_EXISTING_IDENTITY_CONFLICT"
          );
        }
      }

      // Prevent another DVA's current or historical identity from being claimed.

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

      if (fields.providerSlug && fields.accountNumber) {
        conflictConditions.push({
          providerSlug: fields.providerSlug,
          accountNumber: fields.accountNumber,
        });
      }

      const conflict = await DVA.exists({
        _id: { $ne: dva._id },

        provider: "paystack",

        $or: conflictConditions,
      });

      if (conflict) {
        throw DVAService.createAssignmentError(
          "Paystack account identity is already associated with another DVA.",
          "PAYSTACK_DVA_ACCOUNT_ALREADY_CLAIMED"
        );
      }

      // Prepare the verified activation.

      update = {
        ...fields,

        status: "active",

        activatedAt: at,

        failedAt: null,

        failureReason: null,

        lastSyncedAt: at,

        "metadata.assignmentSubmissionOutcome": "confirmed_success",

        ...audit,
      };
    } else {
      // Record the reported failure without resetting the dispatch marker.
      // A reported failure does not prove that no assignment was created
      // and must not authorize automatic provider resubmission.

      update = {
        status: "failed",

        failedAt: at,

        failureReason: DVAService.shortenErrorMessage(
          normalizedPayload.dvaFailureReason ||
            rawPayload?.data?.reason ||
            "Paystack could not assign the dedicated virtual account."
        ),

        lastSyncedAt: at,

        "metadata.assignmentSubmissionOutcome": "reported_failed",

        ...audit,
      };
    }

    // Commit only if the original pending assignment remains unchanged.

    const assignmentFilter = {
      _id: dva._id,

      ownerUser: dva.ownerUser,

      employer: dva.employer,

      wallet: dva.wallet,

      provider: "paystack",

      status: "pending",

      requestedAt: dva.requestedAt,

      retirementStartedAt: null,

      retirementConfirmedAt: null,

      retirementResolution: null,

      paystackDedicatedAccountId: dva.paystackDedicatedAccountId ?? null,

      paystackCustomerId: dva.paystackCustomerId ?? null,

      paystackCustomerCode: dva.paystackCustomerCode ?? null,

      accountNumber: dva.accountNumber ?? null,

      "metadata.assignmentEmail": dva.metadata?.assignmentEmail,

      "metadata.assignmentMode": dva.metadata?.assignmentMode,

      "metadata.assignmentDispatchState": dva.metadata?.assignmentDispatchState ?? null,

      "metadata.assignmentDispatchStartedAt": dva.metadata?.assignmentDispatchStartedAt ?? null,
    };

    const committed = await DVA.findOneAndUpdate(
      assignmentFilter,
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

        historicalAssignmentReconciled: false,

        assignmentOutcome: success ? "success" : "failed",

        resolutionSource: "verified_webhook",
      };
    }

    // Reload the record if another operation changed its state.

    const latest = await DVA.findById(dva._id);

    if (!latest) {
      throw DVAService.createAssignmentError(
        "DVA disappeared during assignment processing.",
        "PAYSTACK_DVA_ASSIGNMENT_NOT_FOUND",
        {
          retryable: true,
          statusCode: 404,
        }
      );
    }

    assertExpectedOwnership(latest);

    if (
      String(latest.employer) !== String(dva.employer) ||
      String(latest.wallet) !== String(dva.wallet)
    ) {
      throw DVAService.createAssignmentError(
        "Original DVA ownership changed during assignment processing.",
        "PAYSTACK_DVA_ASSIGNMENT_OWNERSHIP_CONFLICT"
      );
    }

    // If reti  rement won the concurrent update, reconcile the event
    // historically instead of attempting another activation.

    if (latest.retirementStartedAt || ["retiring", "deactivated"].includes(latest.status)) {
      return DVAService.reconcileHistoricalAssignmentEvent({
        identity: {
          ...identity,
          dva: latest,
        },

        eventName,

        normalizedPayload,

        rawPayload,

        providerEventRecordId,

        providerEventMarker,
      });
    }

    // Accept a matching outcome committed by another worker.

    if (latest.status === desiredStatus) {
      assertEventIdentity(latest, success);

      return {
        dva: latest,

        idempotent: true,

        historicalAssignmentReconciled: false,

        assignmentOutcome: success ? "success" : "failed",

        resolutionSource: "concurrent_terminal_state",
      };
    }

    throw DVAService.createAssignmentError(
      "DVA status changed while processing the assignment event.",
      "PAYSTACK_DVA_ASSIGNMENT_CONCURRENT_UPDATE",
      { retryable: true }
    );
  }

  /* ---------- Create employer DVA through Paystack ---------- */

  static async createEmployerDVA({ userId, employerProfileId }) {
    // Prepare assignment transactionally

    const preparation = await WalletService.runWithOptionalTransaction({}, async (session) => {
      const user = await User.findById(userId).session(session);

      if (!user) {
        throw new Error("User not found.");
      }

      const employerProfile = await EmployerProfile.findById(employerProfileId).session(session);

      if (!employerProfile) {
        throw new Error("Employer profile not found.");
      }

      if (String(employerProfile.user) !== String(user._id)) {
        throw new Error("Employer profile does not belong to this user.");
      }

      if (user.role !== "employer" || user.accountStatus !== "active") {
        throw new Error("This user account is not eligible to create a dedicated virtual account.");
      }

      if (employerProfile.accountStatus !== "active") {
        throw new Error("This business is not eligible to create a dedicated virtual account.");
      }

      // Serialize new DVA preparation with business closure.
      const lockedEmployer = await EmployerProfile.findOneAndUpdate(
        { _id: employerProfile._id, user: user._id, accountStatus: "active" },
        { $inc: { __v: 1 } },
        { session, new: true }
      );

      if (!lockedEmployer) {
        throw DVAService.createAssignmentError(
          "Business closure prevents new DVA setup.",
          "DVA_ASSIGNMENT_BUSINESS_UNAVAILABLE"
        );
      }

      const wallet = await WalletService.createEmployerWalletIfMissing(lockedEmployer, {
        session,
      });

      if (!wallet || wallet.status !== "active") {
        throw new Error("An active employer wallet is required for DVA creation.");
      }

      const selector = {
        wallet: wallet._id,
        provider: "paystack",
        countryCode: wallet.countryCode,
        currency: wallet.currency,
      };

      const existing = await DVA.findOne(selector).session(session);

      // Existing active DVA

      if (existing?.status === "active") {
        return {
          action: "return_existing",
          dva: existing,
        };
      }

      // Retirement protection

      if (existing?.retirementStartedAt || ["retiring", "deactivated"].includes(existing?.status)) {
        throw DVAService.createAssignmentError(
          "This dedicated virtual account is no longer available for setup.",
          "DVA_RETIREMENT_SETUP_BLOCKED"
        );
      }

      // Previously submitted assignment

      if (existing?.status === "pending" && !DVAService.isNeverDispatchedAssignment(existing)) {
        return {
          action: "reconcile_existing",
          dva: existing,
        };
      }

      // A failed record without definitive evidence that
      // it was never dispatched must not be resubmitted.

      if (existing?.status === "failed" && !DVAService.isNeverDispatchedAssignment(existing)) {
        throw DVAService.createAssignmentError(
          "The previous dedicated account assignment requires reconciliation before another assignment can be submitted.",
          "DVA_ASSIGNMENT_RECONCILIATION_REQUIRED"
        );
      }

      if (existing && !["pending", "failed"].includes(existing.status)) {
        throw DVAService.createAssignmentError(
          "The existing DVA is not eligible for setup.",
          "DVA_ASSIGNMENT_STATE_INVALID"
        );
      }

      // Validate provider configuration

      PaystackService.assertConfigured();

      const email = existing
        ? PaystackService.normalizeEmail(existing.metadata?.assignmentEmail)
        : PaystackService.normalizeEmail(user.email);

      // Confirm historical DVA retirement before preparing
      // a new assignment using a previously registered email.

      await DVAService.assertHistoricalIdentityRetired(
        email,
        employerProfile._id,
        session
      );

      const assignmentMode = PaystackService.getMode();

      const preferredProviderSlug = DVAService.getPreferredProviderSlug();

      const firstName = DVAService.cleanString(employerProfile.contactFirstName);

      const lastName = DVAService.cleanString(employerProfile.contactLastName);

      const phone = DVAService.formatPhone(
        employerProfile.contactPhoneCode,
        employerProfile.contactPhone
      );

      if (!firstName || !lastName || !phone || !["test", "live"].includes(assignmentMode)) {
        throw DVAService.createAssignmentError(
          "Complete employer contact details and provider configuration are required.",
          "DVA_ASSIGNMENT_DETAILS_INCOMPLETE",
          { statusCode: 400 }
        );
      }

      if (wallet.countryCode !== "NG" || wallet.currency !== "NGN") {
        throw DVAService.createAssignmentError(
          "Paystack DVA provisioning requires an NG/NGN employer wallet.",
          "DVA_ASSIGNMENT_MARKET_UNSUPPORTED",
          { statusCode: 400 }
        );
      }

      // Provider assignment metadata

      const providerMetadata = {
        userId: String(user._id),

        employerProfileId: String(employerProfile._id),

        walletId: String(wallet._id),

        businessName: employerProfile.businessName,

        employerType: employerProfile.type,

        countryCode: wallet.countryCode,

        currency: wallet.currency,
      };

      const requestedWith = {
        ...providerMetadata,
        email,
        preferredProviderSlug,
      };

      // Resume an unsent assignment

      if (existing) {
        const stored = existing.metadata || {};
        const requested = stored.requestedWith || {};

        if (
          String(existing.ownerUser) !== String(user._id) ||
          String(existing.employer) !== String(employerProfile._id) ||
          String(existing.wallet) !== String(wallet._id) ||
          stored.assignmentEmail !== email ||
          stored.assignmentMode !== assignmentMode ||
          String(requested.userId) !== String(user._id) ||
          String(requested.employerProfileId) !== String(employerProfile._id) ||
          String(requested.walletId) !== String(wallet._id) ||
          requested.countryCode !== wallet.countryCode ||
          requested.currency !== wallet.currency ||
          requested.preferredProviderSlug !== preferredProviderSlug
        ) {
          throw DVAService.createAssignmentError(
            "Prepared assignment identity no longer matches the employer wallet.",
            "DVA_ASSIGNMENT_PREPARED_IDENTITY_MISMATCH"
          );
        }

        if (existing.status === "failed") {
          const resumed = await DVA.findOneAndUpdate(
            {
              _id: existing._id,
              status: "failed",

              requestedAt: existing.requestedAt,

              retirementStartedAt: null,

              "metadata.assignmentDispatchState": "prepared",

              "metadata.assignmentDispatchStartedAt": null,

              "metadata.assignmentAcknowledgedAt": null,

              "metadata.assignmentSubmissionOutcome": null,

              "metadata.submitUncertainAt": null,

              "metadata.lastAssignmentEventId": null,
            },
            {
              $set: {
                status: "pending",
                failedAt: null,
                failureReason: null,
              },
            },
            {
              new: true,
              runValidators: true,
              session,
            }
          );

          if (!resumed) {
            throw DVAService.createAssignmentError(
              "DVA changed during assignment preparation.",
              "DVA_ASSIGNMENT_CONCURRENT_UPDATE",
              { retryable: true }
            );
          }

          return {
            action: "submit_prepared",
            dva: resumed,

            assignment: {
              email,
              firstName,
              lastName,
              phone,

              preferredBank: preferredProviderSlug,

              countryCode: wallet.countryCode,

              metadata: requested,
            },

            assignmentMode,
          };
        }

        return {
          action: "submit_prepared",
          dva: existing,

          assignment: {
            email,
            firstName,
            lastName,
            phone,

            preferredBank: preferredProviderSlug,

            countryCode: wallet.countryCode,

            metadata: requested,
          },

          assignmentMode,
        };
      }

      // Coordinate with wallet closure

      // Creating a new DVA must conflict with a concurrent
      // transaction that closes the original wallet.
      //
      // Incrementing the wallet document version establishes
      // a write dependency without changing financial balances.

      const lockedWallet = await Wallet.findOneAndUpdate(
        {
          _id: wallet._id,

          ownerType: "employer",

          employer: employerProfile._id,

          countryCode: wallet.countryCode,

          currency: wallet.currency,

          status: "active",
          closedAt: null,
        },
        {
          $inc: {
            __v: 1,
          },
        },
        {
          new: true,
          runValidators: true,
          session,
        }
      );

      if (!lockedWallet) {
        throw DVAService.createAssignmentError(
          "The original employer wallet is no longer available for DVA creation.",
          "DVA_ASSIGNMENT_WALLET_UNAVAILABLE"
        );
      }

      // Create local prepared instruction

      const requestedAt = new Date();

      const [pendingDVA] = await DVA.create(
        [
          {
            ...selector,

            ownerUser: user._id,

            employer: employerProfile._id,

            isDefault: true,

            status: "pending",

            requestedAt,

            providerSlug: preferredProviderSlug,

            metadata: {
              requestedWith,

              assignmentEmail: email,

              assignmentMode,

              assignmentDispatchState: "prepared",

              assignmentDispatchStartedAt: null,

              assignmentSubmissionOutcome: null,

              assignmentPreparedAt: requestedAt,
            },
          },
        ],
        { session }
      );

      return {
        action: "submit_prepared",
        dva: pendingDVA,

        assignment: {
          email,
          firstName,
          lastName,
          phone,

          preferredBank: preferredProviderSlug,

          countryCode: wallet.countryCode,

          metadata: providerMetadata,
        },

        assignmentMode,
      };
    });

    // Return existing account

    if (preparation.action === "return_existing") {
      return preparation.dva;
    }

    // Reconcile previous submission

    if (preparation.action === "reconcile_existing") {
      try {
        const reconciled = await DVAService.reconcilePendingEmployerDVA({
          userId,
          employerProfileId,
        });

        return reconciled || preparation.dva;
      } catch (error) {
        logger.warn(
          `Paystack DVA reconciliation failed for ${employerProfileId}: ${error.message}`
        );

        return (await DVA.findById(preparation.dva._id)) || preparation.dva;
      }
    }

    if (preparation.action !== "submit_prepared" || !preparation.dva?._id) {
      throw DVAService.createAssignmentError(
        "DVA assignment preparation returned an invalid result.",
        "DVA_ASSIGNMENT_PREPARATION_INVALID"
      );
    }

    const pendingDVA = preparation.dva;

    // Verify historical provider identity before crossing
    // the durable dispatch boundary.
    //
    // These provider reads happen outside the preparation
    // transaction. A failed identity check does not mark
    // the assignment as dispatched.

    const hasHistory = await DVAService.assertHistoricalIdentityRetired(
      preparation.assignment.email,
      employerProfileId
    );

    if (hasHistory) {
      await DVAService.verifyFreshCustomerIdentity(pendingDVA);
    }

    // Acquire durable dispatch claim

    const dispatch = await DVAService.claimEmployerDVAAssignmentDispatch({
      dvaId: pendingDVA._id,

      userId,

      employerProfileId,

      walletId: pendingDVA.wallet,

      requestedAt: pendingDVA.requestedAt,

      assignmentEmail: preparation.assignment.email,

      assignmentMode: preparation.assignmentMode,
    });

    if (!dispatch.claimed) {
      return DVA.findById(pendingDVA._id);
    }

    // From this point forward, the assignment must be treated
    // as potentially submitted to Paystack.
    //
    // Never reset the dispatch marker merely because a request
    // timed out, returned an error or failed to return a response.

    const submissionFilter = {
      _id: pendingDVA._id,

      ownerUser: pendingDVA.ownerUser,

      employer: pendingDVA.employer,

      wallet: pendingDVA.wallet,

      requestedAt: pendingDVA.requestedAt,

      status: {
        $in: ["pending", "retiring"],
      },

      retirementResolution: null,
      retirementConfirmedAt: null,

      "metadata.assignmentDispatchState": "dispatch_started",

      "metadata.assignmentDispatchStartedAt": dispatch.dispatchStartedAt,
    };

    let response;

    // External provider submission

    try {
      logger.info(`Creating Paystack DVA for employer profile: ${employerProfileId}`);

      response = await PaystackService.assignDedicatedVirtualAccount(preparation.assignment);
    } catch (error) {
      const failedAt = new Date();

      const providerUnavailable = DVAService.isProviderUnavailableError(error);

      const failureReason = providerUnavailable
        ? DVAService.getProviderUnavailableMessage()
        : DVAService.shortenErrorMessage(error.message);

      // The request has crossed the durable dispatch boundary.
      //
      // Even a provider rejection is not automatically proof
      // that no assignment exists unless the provider contract
      // establishes that fact conclusively.

      await DVA.updateOne(
        submissionFilter,
        {
          $set: {
            "metadata.assignmentSubmissionOutcome": "uncertain",

            "metadata.submitUncertainAt": failedAt,

            "metadata.submitUncertainReason": failureReason,

            "metadata.lastFailure": {
              message: failureReason,

              code: error.code || null,

              providerStatusCode: error.providerStatusCode || null,

              providerUnavailable,

              failedAt,
            },
          },
        },
        {
          runValidators: true,
        }
      );

      logger.warn(
        `Paystack DVA submission requires reconciliation for ${employerProfileId}: ${failureReason}`
      );

      return DVA.findById(pendingDVA._id);
    }

    // Provider acknowledgement

    const acknowledgedAt = new Date();

    await DVA.updateOne(
      submissionFilter,
      {
        $set: {
          "metadata.assignmentSubmissionOutcome": "acknowledged",

          "metadata.assignmentAcknowledgedAt": acknowledgedAt,

          "metadata.assignmentMessage":
            response?.pending === true ? response.message || null : null,

          "metadata.initialReconciliationPending": true,
        },
      },
      {
        runValidators: true,
      }
    );

    const latest = await DVA.findById(pendingDVA._id);

    if (!latest) {
      throw DVAService.createAssignmentError(
        "Submitted DVA record could not be reloaded.",
        "DVA_ASSIGNMENT_RECORD_NOT_FOUND",
        { retryable: true }
      );
    }

    // Do not reactivate retiring accounts

    if (latest.retirementStartedAt || ["retiring", "deactivated"].includes(latest.status)) {
      return latest;
    }

    if (latest.status !== "pending") {
      return latest;
    }

    // Asynchronous provider acceptance

    if (response?.pending === true) {
      return latest;
    }

    // Independent account reconciliation

    try {
      const reconciled = await DVAService.reconcilePendingEmployerDVA({
        userId,
        employerProfileId,
      });

      if (
        reconciled?.status === "active" ||
        reconciled?.retirementStartedAt ||
        ["retiring", "deactivated"].includes(reconciled?.status)
      ) {
        return reconciled;
      }

      await DVA.updateOne(
        {
          ...submissionFilter,
          status: "pending",
        },
        {
          $set: {
            "metadata.initialReconciliationPending": true,

            "metadata.initialReconciliationCheckedAt": new Date(),
          },
        }
      );

      return DVA.findById(pendingDVA._id);
    } catch (reconciliationError) {
      logger.warn(
        `Paystack DVA immediate reconciliation pending for ${employerProfileId}: ${reconciliationError.message}`
      );

      await DVA.updateOne(
        {
          ...submissionFilter,
          status: "pending",
        },
        {
          $set: {
            "metadata.initialReconciliationPending": true,

            "metadata.initialReconciliationCheckedAt": new Date(),

            "metadata.initialReconciliationReason": DVAService.shortenErrorMessage(
              reconciliationError.message
            ),
          },
        }
      );

      return DVA.findById(pendingDVA._id);
    }
  }
}

module.exports = DVAService;
