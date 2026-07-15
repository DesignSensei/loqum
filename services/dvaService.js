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
  /* ---------- Clean string value ---------- */
  static cleanString(value) {
    const cleaned = String(value || "").trim();

    return cleaned || null;
  }

  /* ---------- Clean number value ---------- */
  static cleanNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
  }

  /* ---------- Shorten error message for DB storage ---------- */
  static shortenErrorMessage(message) {
    return String(message || "DVA creation failed.").slice(0, 300);
  }

  /* ---------- Get DVA retry anchor date ---------- */
  static getRetryAnchorDate(dva) {
    return dva?.failedAt || dva?.requestedAt || dva?.updatedAt || null;
  }

  /* ---------- Check if user retry window has passed ---------- */
  static hasUserRetryWindowPassed(dva) {
    const retryAnchorDate = DVAService.getRetryAnchorDate(dva);

    if (!retryAnchorDate) {
      return true;
    }

    const retryAgeMs = Date.now() - new Date(retryAnchorDate).getTime();

    return retryAgeMs >= DVA_USER_RETRY_WAIT_MS;
  }

  /* ---------- Get retry availability date ---------- */
  static getRetryAvailableAt(dva) {
    const retryAnchorDate = DVAService.getRetryAnchorDate(dva);

    if (!retryAnchorDate) {
      return null;
    }

    return new Date(new Date(retryAnchorDate).getTime() + DVA_USER_RETRY_WAIT_MS);
  }

  /* ---------- Format phone number for Paystack ---------- */
  static formatPhone(phoneCode, phone) {
    return `${String(phoneCode || "").trim()}${String(phone || "").trim()}`.replace(/\s+/g, "");
  }

  /* ---------- Check if DVA provider is unavailable ---------- */
  static isProviderUnavailableError(error) {
    const message = String(error?.message || error || "").toLowerCase();

    const providerUnavailableMessages = [
      "dedicated nuban is not available",
      "access denied",
      "not available for your business",
      "not activated",
      "not enabled",
    ];

    return providerUnavailableMessages.some((providerMessage) => message.includes(providerMessage));
  }

  /* ---------- Get provider unavailable message ---------- */
  static getProviderUnavailableMessage() {
    return "Wallet bank account setup is not available for this business yet. We will complete setup once the payment provider activates this feature.";
  }

  static getPreferredProviderSlug() {
    const secretKey = String(process.env.PAYSTACK_SECRET_KEY || "");

    if (secretKey.startsWith("sk_test_")) {
      return "test-bank";
    }

    const preferredBank = process.env.PAYSTACK_DVA_PREFERRED_BANK;

    if (!preferredBank) {
      throw new Error("PAYSTACK_DVA_PREFERRED_BANK is not configured.");
    }

    return String(preferredBank).trim().toLowerCase();
  }

  /* ---------- Extract usable DVA data from Paystack response ---------- */
  static extractDVAData(paystackResponse, preferredProviderSlug = null) {
    const paystackData = paystackResponse?.data || paystackResponse || {};
    const customer = paystackData.customer || {};
    const bank = paystackData.bank || {};

    return {
      paystackCustomerId: DVAService.cleanNumber(customer.id || paystackData.customer_id),

      paystackCustomerCode: DVAService.cleanString(
        customer.customer_code || paystackData.customer_code
      ),

      paystackDedicatedAccountId: DVAService.cleanNumber(paystackData.id),

      paystackReference: DVAService.cleanString(paystackData.reference),

      accountNumber: DVAService.cleanString(paystackData.account_number),
      accountName: DVAService.cleanString(paystackData.account_name),

      bankId: DVAService.cleanNumber(bank.id || bank.bank_id || paystackData.bank_id),

      bankName: DVAService.cleanString(bank.name || paystackData.bank_name),

      bankCode: DVAService.cleanString(bank.code || paystackData.bank_code),

      bankSlug: DVAService.cleanString(bank.slug || paystackData.bank_slug),

      providerSlug: DVAService.cleanString(
        paystackData.provider_slug || bank.provider_slug || bank.slug || preferredProviderSlug
      ),
    };
  }

  /* ---------- Validate successful DVA response ---------- */
  static validateDVAData(dvaData) {
    if (
      !dvaData.paystackCustomerCode ||
      !dvaData.paystackDedicatedAccountId ||
      !dvaData.accountNumber ||
      !dvaData.accountName ||
      !dvaData.bankName ||
      !dvaData.providerSlug
    ) {
      throw new Error("Incomplete Paystack DVA response.");
    }

    return true;
  }

  /* ---------- Get latest employer DVA ---------- */
  static async getEmployerDVA({ employerProfileId }) {
    return DVA.findOne({
      employer: employerProfileId,
      provider: "paystack",
    }).sort({ updatedAt: -1 });
  }

  /* ---------- Get employer DVA display status ---------- */
  static async getEmployerDVAStatus({ employerProfileId }) {
    const dva = await DVAService.getEmployerDVA({ employerProfileId });

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
    const canRetrySetup =
      ["failed", "pending"].includes(rawStatus) && DVAService.hasUserRetryWindowPassed(dva);

    const retryAvailableAt = DVAService.getRetryAvailableAt(dva);

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
    if (rawStatus === "failed") {
      return {
        status: "setup_pending",
        rawStatus,
        message:
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

    const existingDVA = await DVA.findOne({
      wallet: wallet._id,
      provider: "paystack",
      countryCode: wallet.countryCode,
      currency: wallet.currency,
    });

    if (existingDVA?.status === "active") {
      return existingDVA;
    }

    if (
      existingDVA &&
      ["pending", "failed"].includes(existingDVA.status) &&
      !DVAService.hasUserRetryWindowPassed(existingDVA)
    ) {
      throw new Error(
        "Your wallet bank account is being set up. Please allow up to 24 hours before trying again."
      );
    }

    const preferredProviderSlug = DVAService.getPreferredProviderSlug();

    const phone = DVAService.formatPhone(
      employerProfile.contactPhoneCode,
      employerProfile.contactPhone
    );

    const pendingDVA = await DVA.findOneAndUpdate(
      {
        wallet: wallet._id,
        provider: "paystack",
        countryCode: wallet.countryCode,
        currency: wallet.currency,
      },
      {
        $setOnInsert: {
          wallet: wallet._id,
          provider: "paystack",
          countryCode: wallet.countryCode,
          currency: wallet.currency,
          isDefault: true,
        },
        $set: {
          ownerUser: user._id,
          employer: employerProfile._id,
          status: "pending",
          requestedAt: new Date(),
          failedAt: null,
          failureReason: null,
          deactivatedAt: null,
          providerSlug: preferredProviderSlug,
          metadata: {
            requestedWith: {
              userId: String(user._id),
              employerProfileId: String(employerProfile._id),
              walletId: String(wallet._id),
              businessName: employerProfile.businessName,
              employerType: employerProfile.type,
              preferredProviderSlug,
              countryCode: wallet.countryCode,
              currency: wallet.currency,
            },
          },
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        context: "query",
      }
    );

    try {
      logger.info(`Creating Paystack DVA for employer profile: ${employerProfile._id}`);

      const paystackData = await PaystackService.assignDedicatedVirtualAccount({
        email: user.email,
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

      const dvaData = DVAService.extractDVAData(paystackData, preferredProviderSlug);

      DVAService.validateDVAData(dvaData);

      pendingDVA.set({
        ...dvaData,
        status: "active",
        activatedAt: new Date(),
        failedAt: null,
        failureReason: null,
        deactivatedAt: null,
        lastSyncedAt: new Date(),
        metadata: {
          ...(pendingDVA.metadata || {}),
          paystackResponse: paystackData,
        },
      });

      const savedDVA = await pendingDVA.save();

      logger.info(`DVA created for employer profile: ${employerProfile._id}`);

      return savedDVA;
    } catch (error) {
      const failedAt = new Date();
      const providerUnavailable = DVAService.isProviderUnavailableError(error);

      const failureReason = providerUnavailable
        ? DVAService.getProviderUnavailableMessage()
        : error.message;

      pendingDVA.set({
        status: "failed",
        failedAt,
        failureReason: DVAService.shortenErrorMessage(failureReason),
        metadata: {
          ...(pendingDVA.metadata || {}),
          lastFailure: {
            message: error.message,
            providerUnavailable,
            failedAt,
          },
        },
      });

      const savedDVA = await pendingDVA.save();

      logger.error(`DVA creation failed for profile ${employerProfile._id}: ${error.message}`);

      if (providerUnavailable) {
        return savedDVA;
      }

      throw error;
    }
  }
}

module.exports = DVAService;
