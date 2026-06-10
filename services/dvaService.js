// services/dvaService.js

const DVA = require("../models/DVA");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");

const PaystackService = require("./paystackService");
const WalletService = require("./walletService");

const logger = require("../utils/logger");

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

  /* ---------- Format phone number for Paystack ---------- */
  static formatPhone(phoneCode, phone) {
    return `${String(phoneCode || "").trim()}${String(phone || "").trim()}`.replace(/\s+/g, "");
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
        message: "Wallet account setup pending.",
        dva: null,
      };
    }

    if (dva.status === "active") {
      return {
        status: "active",
        message: "Wallet account is active.",
        dva,
      };
    }

    if (dva.status === "failed") {
      return {
        status: "pending",
        message: "Wallet account setup pending. Please contact support if this persists.",
        dva,
      };
    }

    if (dva.status === "deactivated") {
      return {
        status: "deactivated",
        message: "Wallet account has been deactivated.",
        dva,
      };
    }

    return {
      status: "pending",
      message: "Wallet account setup pending.",
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

    const existingActiveDVA = await DVA.findOne({
      wallet: wallet._id,
      provider: "paystack",
      countryCode: wallet.countryCode,
      currency: wallet.currency,
      status: "active",
    });

    if (existingActiveDVA) {
      return existingActiveDVA;
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
          user: user._id,
          employer: employerProfile._id,
          wallet: wallet._id,
          provider: "paystack",
          countryCode: wallet.countryCode,
          currency: wallet.currency,
          isDefault: true,
        },
        $set: {
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
      pendingDVA.set({
        status: "failed",
        failedAt: new Date(),
        failureReason: DVAService.shortenErrorMessage(error.message),
        metadata: {
          ...(pendingDVA.metadata || {}),
          lastFailure: {
            message: error.message,
            failedAt: new Date(),
          },
        },
      });

      await pendingDVA.save();

      logger.error(`DVA creation failed for profile ${employerProfile._id}: ${error.message}`);

      throw error;
    }
  }
}

module.exports = DVAService;
