// services/dvaService.js

const DVA = require("../models/DVA");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const PaystackService = require("./paystackService");
const logger = require("../utils/logger");

class DVAService {
  static formatPhone(phoneCode, phone) {
    return `${String(phoneCode || "").trim()}${String(phone || "").trim()}`;
  }

  static extractDVAData(paystackData) {
    const customer = paystackData.customer || {};
    const bank = paystackData.bank || {};

    return {
      customerId: String(customer.id || paystackData.customer_id || ""),
      customerCode: String(customer.customer_code || paystackData.customer_code || ""),

      dedicatedAccountId: Number(paystackData.id),
      accountNumber: String(paystackData.account_number || ""),
      accountName: String(paystackData.account_name || ""),

      bankName: String(bank.name || paystackData.bank_name || ""),
      bankCode: String(bank.id || bank.code || paystackData.bank_code || ""),
      bankSlug: bank.slug || paystackData.bank_slug || null,
    };
  }

  static async createEmployerDVA({ userId, employerProfileId }) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not found.");
    }

    const employerProfile = await EmployerProfile.findById(employerProfileId);

    if (!employerProfile) {
      throw new Error("Employer profile not found.");
    }

    const existingActiveDVA = await DVA.findOne({
      employer: employerProfile._id,
      status: "active",
    });

    if (existingActiveDVA) {
      return existingActiveDVA;
    }

    const phone = DVAService.formatPhone(
      employerProfile.contactPhoneCode,
      employerProfile.contactPhone
    );

    logger.info(`Creating Paystack DVA for employer profile: ${employerProfile._id}`);

    const paystackData = await PaystackService.assignDedicatedVirtualAccount({
      email: user.email,
      firstName: employerProfile.contactFirstName,
      lastName: employerProfile.contactLastName,
      phone,
      metadata: {
        userId: String(user._id),
        employerProfileId: String(employerProfile._id),
        businessName: employerProfile.businessName,
        employerType: employerProfile.type,
      },
    });

    const dvaData = DVAService.extractDVAData(paystackData);

    if (
      !dvaData.customerId ||
      !dvaData.customerCode ||
      !dvaData.dedicatedAccountId ||
      !dvaData.accountNumber ||
      !dvaData.accountName ||
      !dvaData.bankName ||
      !dvaData.bankCode
    ) {
      throw new Error("Incomplete Paystack DVA response.");
    }

    const dva = await DVA.create({
      employer: employerProfile._id,
      ...dvaData,
      status: "active",
      assignedAt: new Date(),
    });

    logger.info(`DVA created for employer profile: ${employerProfile._id}`);

    return dva;
  }
}

module.exports = DVAService;
