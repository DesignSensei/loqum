// services/bankProviderService.js

const PaystackService = require("./paystackService");

class BankProviderService {
  /* ---------- Fallback banks ---------- */
  static getFallbackBanks() {
    return [
      { name: "Access Bank", value: "Access Bank", paystackBankCode: null },
      { name: "Fidelity Bank", value: "Fidelity Bank", paystackBankCode: null },
      {
        name: "First Bank of Nigeria",
        value: "First Bank of Nigeria",
        paystackBankCode: null,
      },
      {
        name: "Guaranty Trust Bank",
        value: "Guaranty Trust Bank",
        paystackBankCode: null,
      },
      { name: "Sterling Bank", value: "Sterling Bank", paystackBankCode: null },
      {
        name: "United Bank for Africa",
        value: "United Bank for Africa",
        paystackBankCode: null,
      },
      { name: "Wema Bank", value: "Wema Bank", paystackBankCode: null },
      { name: "Zenith Bank", value: "Zenith Bank", paystackBankCode: null },
    ];
  }

  /* ---------- Format Paystack bank for dropdown ---------- */
  static formatPaystackBank(bank) {
    return {
      name: bank.name,
      value: bank.code,
      paystackBankCode: bank.code,
      slug: bank.slug || null,
      longcode: bank.longcode || null,
    };
  }

  /* ---------- Get manual withdrawal bank setup ---------- */
  static getManualWithdrawalBankSetup(providerError = null) {
    return {
      mode: "manual",
      providerMode: PaystackService.getMode(),
      providerError,
      canResolveAccountName: false,
      bankSelectName: "bankName",
      accountNameReadonly: false,
      accountNamePlaceholder: "Enter account name",
      banks: BankProviderService.getFallbackBanks(),
    };
  }

  /* ---------- Get Paystack withdrawal bank setup ---------- */
  static async getPaystackWithdrawalBankSetup() {
    const banks = await PaystackService.fetchBanks({
      country: "nigeria",
      currency: "NGN",
    });

    return {
      mode: PaystackService.getMode(),
      providerMode: PaystackService.getMode(),
      providerError: null,
      canResolveAccountName: true,
      bankSelectName: "paystackBankCode",
      accountNameReadonly: true,
      accountNamePlaceholder: "Account name will appear here",
      banks: banks.map(BankProviderService.formatPaystackBank),
    };
  }

  /* ---------- Get withdrawal bank setup ---------- */
  static async getWithdrawalBankSetup() {
    if (!PaystackService.hasSecretKey()) {
      return BankProviderService.getManualWithdrawalBankSetup();
    }

    try {
      return await BankProviderService.getPaystackWithdrawalBankSetup();
    } catch (error) {
      return BankProviderService.getManualWithdrawalBankSetup(error.message);
    }
  }

  /* ---------- Resolve account number ---------- */
  static async resolveAccountNumber({ accountNumber, paystackBankCode }) {
    const result = await PaystackService.resolveBankAccount({
      accountNumber,
      bankCode: paystackBankCode,
    });

    return {
      accountNumber: result.account_number,
      accountName: result.account_name,
      bankId: result.bank_id || null,
    };
  }
}

module.exports = BankProviderService;
