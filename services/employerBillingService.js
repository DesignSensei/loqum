// services/employerBillingService.js

const EmployerProfile = require("../models/EmployerProfile");
const Transaction = require("../models/Transaction");
const Shift = require("../models/Shift");
const BankAccount = require("../models/BankAccount");

const DVAService = require("./dvaService");
const WalletService = require("./walletService");
const BankProviderService = require("./bankProviderService");

const money = require("../utils/money");
const { badgeClass, formatStatus } = require("../utils/statusHelper");

class EmployerBillingService {
  /* ---------- Get employer profile for logged-in user ---------- */
  static async getEmployerProfileForUser(userId, employerProfile = null) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    if (employerProfile?._id) {
      return employerProfile;
    }

    const foundEmployerProfile = await EmployerProfile.findOne({
      user: userId,
    });

    if (!foundEmployerProfile) {
      throw new Error("Employer profile not found.");
    }

    return foundEmployerProfile;
  }

  /* ---------- Format date for display ---------- */
  static formatDateTime(date) {
    if (!date) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-NG", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(date));
  }

  /* ---------- Format minor-unit money for display ---------- */
  static formatAmount(amount, currency = "NGN") {
    return money.formatMoney(amount ?? 0, currency);
  }

  /* ---------- Format major-unit money for display ---------- */
  static formatMajorAmount(amount, currency = "NGN") {
    return money.formatMoney(money.toMinorUnit(amount || 0), currency);
  }

  /* ---------- Clean string value ---------- */
  static cleanString(value) {
    const cleaned = String(value || "").trim();

    return cleaned || null;
  }

  /* ---------- Clean account number ---------- */
  static cleanAccountNumber(value) {
    const cleaned = String(value || "")
      .replace(/\D/g, "")
      .trim();

    return cleaned || null;
  }

  /* ---------- Get human-readable transaction type ---------- */
  static getTransactionTypeLabel(type) {
    const typeMap = {
      wallet_funding: "Wallet funding",
      shift_funding: "Shift funding",
      shift_topup: "Shift top-up",
      shift_refund: "Shift refund",
      professional_payout: "Professional payout",
      platform_fee: "Platform fee",
      outstanding_charge: "Outstanding charge",
      outstanding_settlement: "Outstanding settlement",
      withdrawal: "Withdrawal",
      withdrawal_reversal: "Withdrawal reversal",
      dispute_refund: "Dispute refund",
      cancellation_fee: "Cancellation fee",
      penalty_debit: "Penalty debit",
      adjustment: "Adjustment",
      credit_purchase: "Credit purchase",
    };

    return typeMap[type] || formatStatus(type || "transaction");
  }

  /* ---------- Get human-readable payment method ---------- */
  static getPaymentRailLabel(paymentRail) {
    const railMap = {
      wallet_balance: "Wallet balance",
      paystack_checkout: "Checkout payment",
      paystack_dva: "Bank transfer",
      paystack_transfer: "Bank payout",
      internal_transfer: "Wallet transfer",
      platform_wallet: "Platform wallet",
      admin_action: "Admin action",
      system_action: "System action",
    };

    return railMap[paymentRail] || "-";
  }

  /* ---------- Get employer payments that need attention ---------- */
  static async getPaymentsDueSummary({ employerProfileId, currency = "NGN" }) {
    const shifts = await Shift.find({
      business: employerProfileId,
      paymentStatus: "awaiting_topup",
      topUpRequired: { $gt: 0 },
    })
      .select("referenceCode roleTitle startTime topUpRequired overtime")
      .sort({ updatedAt: -1 })
      .lean();

    const totalAmount = shifts.reduce((sum, shift) => {
      return sum + Number(shift.topUpRequired || 0);
    }, 0);

    return {
      hasPaymentsDue: totalAmount > 0,
      count: shifts.length,
      totalAmount,
      totalAmountDisplay: EmployerBillingService.formatMajorAmount(totalAmount, currency),

      message:
        shifts.length === 1
          ? "One shift needs an additional payment before settlement can be completed."
          : `${shifts.length} shifts need additional payment before settlement can be completed.`,
    };
  }

  /* ---------- Get wallet activity summary for display cards ---------- */
  static async getWalletActivitySummary({ walletId, currency = "NGN" }) {
    if (!walletId) {
      return {
        moneyAdded: 0,
        moneyUsed: 0,
        moneyAddedDisplay: EmployerBillingService.formatAmount(0, currency),
        moneyUsedDisplay: EmployerBillingService.formatAmount(0, currency),
      };
    }

    const [summary] = await Transaction.aggregate([
      {
        $match: {
          wallet: walletId,
        },
      },
      {
        $group: {
          _id: null,

          moneyAdded: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$direction", "credit"] },
                    { $eq: ["$status", "completed"] },
                    {
                      $in: ["$type", ["wallet_funding", "adjustment", "credit_purchase"]],
                    },
                  ],
                },
                "$amount",
                0,
              ],
            },
          },

          moneyUsed: {
            $sum: {
              $cond: [
                {
                  $and: [{ $eq: ["$direction", "debit"] }, { $eq: ["$status", "completed"] }],
                },
                "$amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const moneyAdded = summary?.moneyAdded || 0;
    const moneyUsed = summary?.moneyUsed || 0;

    return {
      moneyAdded,
      moneyUsed,
      moneyAddedDisplay: EmployerBillingService.formatAmount(moneyAdded, currency),
      moneyUsedDisplay: EmployerBillingService.formatAmount(moneyUsed, currency),
    };
  }

  /* ---------- Build wallet summary view ---------- */
  static buildWalletSummary(wallet, walletActivitySummary = {}) {
    const currency = wallet.currency || "NGN";

    const moneyAdded = walletActivitySummary.moneyAdded ?? 0;
    const moneyUsed = walletActivitySummary.moneyUsed ?? 0;

    return {
      id: String(wallet._id),
      ownerType: wallet.ownerType,

      status: wallet.status,
      statusLabel: formatStatus(wallet.status),
      statusBadgeClass: badgeClass[wallet.status] || "badge-light-secondary",

      countryCode: wallet.countryCode,
      currency,

      availableBalance: wallet.availableBalance ?? 0,
      pendingBalance: wallet.pendingBalance ?? 0,
      outstandingBalance: wallet.outstandingBalance ?? 0,
      lifetimeCredit: wallet.lifetimeCredit ?? 0,
      lifetimeDebit: wallet.lifetimeDebit ?? 0,

      moneyAdded,
      moneyUsed,

      availableBalanceDisplay: EmployerBillingService.formatAmount(
        wallet.availableBalance ?? 0,
        currency
      ),
      pendingBalanceDisplay: EmployerBillingService.formatAmount(
        wallet.pendingBalance ?? 0,
        currency
      ),
      outstandingBalanceDisplay: EmployerBillingService.formatAmount(
        wallet.outstandingBalance ?? 0,
        currency
      ),
      lifetimeCreditDisplay: EmployerBillingService.formatAmount(
        wallet.lifetimeCredit ?? 0,
        currency
      ),
      lifetimeDebitDisplay: EmployerBillingService.formatAmount(
        wallet.lifetimeDebit ?? 0,
        currency
      ),
      moneyAddedDisplay: EmployerBillingService.formatAmount(moneyAdded, currency),
      moneyUsedDisplay: EmployerBillingService.formatAmount(moneyUsed, currency),

      maximumBalance: wallet.maximumBalance,
      minimumWithdrawalAmount: wallet.minimumWithdrawalAmount,

      maximumBalanceDisplay:
        wallet.maximumBalance === null || wallet.maximumBalance === undefined
          ? null
          : EmployerBillingService.formatAmount(wallet.maximumBalance, currency),

      minimumWithdrawalAmountDisplay:
        wallet.minimumWithdrawalAmount === null || wallet.minimumWithdrawalAmount === undefined
          ? null
          : EmployerBillingService.formatAmount(wallet.minimumWithdrawalAmount, currency),

      lastTransactionAt: wallet.lastTransactionAt,
      lastTransactionAtDisplay: EmployerBillingService.formatDateTime(wallet.lastTransactionAt),

      frozenReason: wallet.frozenReason || null,
    };
  }

  /* ---------- Build wallet bank account display view ---------- */
  static buildDVAView(dvaStatus) {
    const dva = dvaStatus?.dva || null;
    const status = dvaStatus?.status || "not_started";
    const rawStatus = dvaStatus?.rawStatus || status;

    const hasAccountDetails = Boolean(dva && dva.accountNumber && dva.accountName && dva.bankName);

    const canRetrySetup = Boolean(dvaStatus?.canRetrySetup);

    const setupButtonLabel =
      rawStatus === "not_started" ? "Set up wallet bank account" : "Try setup again";

    return {
      status,
      rawStatus,

      statusLabel: formatStatus(status),
      statusBadgeClass: badgeClass[status] || "badge-light-secondary",

      message: dvaStatus?.message || "Your wallet bank account is being set up.",
      supportMessage: "Please allow up to 24 hours for your wallet bank account to be completed.",

      hasDVA: Boolean(dva),
      hasAccountDetails,

      accountName: dva?.accountName || null,
      accountNumber: dva?.accountNumber || null,
      bankName: dva?.bankName || null,
      bankCode: dva?.bankCode || null,

      provider: dva?.provider || "paystack",
      providerSlug: dva?.providerSlug || null,

      requestedAt: dva?.requestedAt || null,
      activatedAt: dva?.activatedAt || null,
      failedAt: dva?.failedAt || null,
      failureReason: dva?.failureReason || null,
      lastSyncedAt: dva?.lastSyncedAt || null,

      retryAvailableAt: dvaStatus?.retryAvailableAt || null,

      requestedAtDisplay: EmployerBillingService.formatDateTime(dva?.requestedAt),
      activatedAtDisplay: EmployerBillingService.formatDateTime(dva?.activatedAt),
      failedAtDisplay: EmployerBillingService.formatDateTime(dva?.failedAt),
      lastSyncedAtDisplay: EmployerBillingService.formatDateTime(dva?.lastSyncedAt),
      retryAvailableAtDisplay: EmployerBillingService.formatDateTime(dvaStatus?.retryAvailableAt),

      setupButtonLabel,

      canRetrySetup,
      canDisplayBankDetails: status === "active" && hasAccountDetails,
    };
  }

  /* ---------- Build one transaction row ---------- */
  static buildTransactionView(transaction) {
    const currency = transaction.currency || "NGN";
    const direction = transaction.direction;
    const amountDisplay = EmployerBillingService.formatAmount(transaction.amount, currency);

    return {
      id: String(transaction._id),
      reference: transaction.reference,
      groupReference: transaction.groupReference || null,

      type: transaction.type,
      typeLabel: EmployerBillingService.getTransactionTypeLabel(transaction.type),

      purpose: transaction.purpose || null,
      purposeLabel: transaction.purpose ? formatStatus(transaction.purpose) : "-",

      direction,
      directionLabel: formatStatus(direction),

      amount: transaction.amount,
      amountDisplay,
      signedAmountDisplay: direction === "credit" ? `+${amountDisplay}` : `-${amountDisplay}`,
      amountClass: direction === "credit" ? "text-success" : "text-danger",

      providerFee: transaction.providerFee ?? 0,
      providerFeeDisplay: EmployerBillingService.formatAmount(
        transaction.providerFee ?? 0,
        currency
      ),

      netAmount: transaction.netAmount ?? transaction.amount,
      netAmountDisplay: EmployerBillingService.formatAmount(
        transaction.netAmount ?? transaction.amount,
        currency
      ),

      countryCode: transaction.countryCode,
      currency,

      paymentRail: transaction.paymentRail || null,
      paymentRailLabel: EmployerBillingService.getPaymentRailLabel(transaction.paymentRail),

      provider: transaction.provider || null,

      status: transaction.status,
      statusLabel: formatStatus(transaction.status),
      statusBadgeClass: badgeClass[transaction.status] || "badge-light-secondary",

      description: transaction.description || null,

      createdAt: transaction.createdAt,
      createdAtDisplay: EmployerBillingService.formatDateTime(transaction.createdAt),

      completedAt: transaction.completedAt || null,
      completedAtDisplay: EmployerBillingService.formatDateTime(transaction.completedAt),
    };
  }

  /* ---------- Build pagination page numbers ---------- */
  static buildPaginationPages({ currentPage, totalPages }) {
    if (totalPages <= 1) {
      return [];
    }

    const maxVisiblePages = 5;

    let startPage = Math.max(currentPage - 2, 1);
    let endPage = Math.min(startPage + maxVisiblePages - 1, totalPages);

    startPage = Math.max(endPage - maxVisiblePages + 1, 1);

    const pages = [];

    for (let page = startPage; page <= endPage; page += 1) {
      pages.push({
        page,
        isActive: page === currentPage,
      });
    }

    return pages;
  }

  /* ---------- Get paginated wallet transactions ---------- */
  static async getRecentTransactions({ walletId, page = 1 }) {
    const perPage = 25;

    if (!walletId) {
      return {
        transactions: [],
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalTransactions: 0,
          perPage,
          startItem: 0,
          endItem: 0,
          hasPreviousPage: false,
          hasNextPage: false,
          previousPage: null,
          nextPage: null,
          pages: [],
          hasPagination: false,
        },
      };
    }

    const requestedPage = Math.max(Number.parseInt(page, 10) || 1, 1);

    const filter = {
      wallet: walletId,
    };

    const totalTransactions = await Transaction.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(totalTransactions / perPage), 1);
    const currentPage = Math.min(requestedPage, totalPages);
    const skip = (currentPage - 1) * perPage;

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean();

    const startItem = totalTransactions > 0 ? skip + 1 : 0;
    const endItem = totalTransactions > 0 ? skip + transactions.length : 0;

    return {
      transactions: transactions.map((transaction) =>
        EmployerBillingService.buildTransactionView(transaction)
      ),

      pagination: {
        currentPage,
        totalPages,
        totalTransactions,
        perPage,

        startItem,
        endItem,

        hasPreviousPage: currentPage > 1,
        hasNextPage: currentPage < totalPages,

        previousPage: currentPage > 1 ? currentPage - 1 : null,
        nextPage: currentPage < totalPages ? currentPage + 1 : null,

        pages: EmployerBillingService.buildPaginationPages({
          currentPage,
          totalPages,
        }),

        hasPagination: totalPages > 1,
      },
    };
  }

  /* ---------- Build withdrawal bank account display view ---------- */
  static buildWithdrawalAccountView(bankAccount) {
    if (!bankAccount) {
      return {
        hasAccount: false,

        accountName: "-",
        accountNumber: "-",
        bankName: "-",
        bankCode: null,

        verificationStatus: "not_added",
        statusLabel: "Not added",
        statusBadgeClass: "badge-light-warning",

        canAddAccount: true,
        canWithdraw: false,

        message:
          "Add a withdrawal bank account to receive eligible wallet withdrawals when withdrawals become available.",
        supportMessage:
          "Wallet withdrawals are not available yet because payment provider setup is still pending.",
      };
    }

    return {
      hasAccount: true,

      accountName: bankAccount.accountName || "-",
      accountNumber: bankAccount.accountNumber || "-",
      bankName: bankAccount.bankName || "-",
      bankCode: bankAccount.bankCode || null,

      verificationStatus: bankAccount.verificationStatus,
      statusLabel: formatStatus(bankAccount.verificationStatus),
      statusBadgeClass: badgeClass[bankAccount.verificationStatus] || "badge-light-secondary",

      canAddAccount: false,

      // Keep this false until Paystack transfer access is ready.
      canWithdraw: false,

      message: "Your withdrawal bank account has been saved for future wallet withdrawals.",
      supportMessage:
        "Wallet withdrawals are not available yet because payment provider setup is still pending.",
    };
  }

  static async getEmployerWithdrawalAccountView(employerProfileId) {
    const bankAccount = await EmployerBillingService.getActiveEmployerBankAccount(
      employerProfileId,
      { includeAccountNumber: true }
    );

    return EmployerBillingService.buildWithdrawalAccountView(bankAccount);
  }

  /* ---------- Resolve withdrawal account name ---------- */
  static async resolveWithdrawalAccount({ paystackBankCode, accountNumber }) {
    return BankProviderService.resolveAccountNumber({
      paystackBankCode,
      accountNumber,
    });
  }

  /* ---------- Get active employer withdrawal bank account ---------- */
  static async getActiveEmployerBankAccount(
    employerProfileId,
    { includeAccountNumber = false } = {}
  ) {
    let query = BankAccount.findOne({
      ownerType: "employer",
      employer: employerProfileId,
      isActive: true,
    });

    if (includeAccountNumber) {
      query = query.select("+accountNumber");
    }

    return query.lean();
  }

  /* ---------- Save employer withdrawal bank account ---------- */
  static async saveEmployerWithdrawalAccount({
    userId,
    employerProfile = null,
    bankName,
    accountNumber,
    accountName,
    paystackBankCode = null,
    replaceExisting = false,
  }) {
    const profile = await EmployerBillingService.getEmployerProfileForUser(userId, employerProfile);

    const cleanAccountNumber = EmployerBillingService.cleanAccountNumber(accountNumber);

    const cleanPaystackBankCode = EmployerBillingService.cleanString(paystackBankCode);

    let cleanBankName = EmployerBillingService.cleanString(bankName);
    let cleanAccountName = EmployerBillingService.cleanString(accountName);

    if (!cleanAccountNumber) {
      throw new Error("Account number is required.");
    }

    if (cleanAccountNumber.length !== 10) {
      throw new Error("Account number must be 10 digits.");
    }

    const existingAccount = await EmployerBillingService.getActiveEmployerBankAccount(profile._id);

    if (existingAccount && !replaceExisting) {
      throw new Error("A withdrawal bank account has already been added.");
    }

    if (existingAccount && replaceExisting) {
      await BankAccount.updateOne(
        {
          _id: existingAccount._id,
          ownerType: "employer",
          employer: profile._id,
          isActive: true,
        },
        {
          $set: {
            isActive: false,
            deactivatedAt: new Date(),
          },
        }
      );
    }

    let verificationProvider = "manual";
    let verificationStatus = "pending";
    let verifiedAt = null;

    if (cleanPaystackBankCode) {
      const resolvedAccount = await BankProviderService.resolveAccountNumber({
        paystackBankCode: cleanPaystackBankCode,
        accountNumber: cleanAccountNumber,
      });

      cleanAccountName = resolvedAccount.accountName;

      const withdrawalBankSetup = await BankProviderService.getWithdrawalBankSetup();

      const selectedBank = withdrawalBankSetup.banks.find((bank) => {
        return String(bank.paystackBankCode || bank.value || "").trim() === cleanPaystackBankCode;
      });

      cleanBankName = selectedBank?.name || cleanBankName;

      verificationProvider = "paystack";
      verificationStatus = "verified";
      verifiedAt = new Date();
    }

    if (!cleanBankName) {
      throw new Error("Bank name is required.");
    }

    if (!cleanAccountName) {
      throw new Error("Account name is required.");
    }

    const bankAccount = await BankAccount.create({
      ownerType: "employer",
      employer: profile._id,
      professional: null,

      bankName: cleanBankName,
      accountNumber: cleanAccountNumber,
      accountName: cleanAccountName,

      paystackBankCode: cleanPaystackBankCode,
      paystackRecipientCode: null,

      verificationProvider,
      verificationStatus,
      verifiedAt,

      isActive: true,
    });

    return {
      outcome: "saved",
      bankAccountId: String(bankAccount._id),
      message: "Withdrawal bank account saved successfully.",
    };
  }

  /* ---------- Remove employer withdrawal bank account ---------- */
  static async removeEmployerWithdrawalAccount({ userId, employerProfile = null }) {
    const profile = await EmployerBillingService.getEmployerProfileForUser(userId, employerProfile);

    const existingAccount = await EmployerBillingService.getActiveEmployerBankAccount(profile._id);

    if (!existingAccount) {
      throw new Error("No active withdrawal bank account was found.");
    }

    await BankAccount.updateOne(
      {
        _id: existingAccount._id,
        ownerType: "employer",
        employer: profile._id,
        isActive: true,
      },
      {
        $set: {
          isActive: false,
          deactivatedAt: new Date(),
        },
      }
    );

    return {
      outcome: "removed",
      message: "Withdrawal bank account removed successfully.",
    };
  }

  /* ---------- Build employer wallet page data ---------- */
  static async getEmployerBillingPageData({
    userId,
    employerProfile = null,
    transactionsPage = 1,
  }) {
    const profile = await EmployerBillingService.getEmployerProfileForUser(userId, employerProfile);

    const wallet = await WalletService.createEmployerWalletIfMissing(profile);

    const dvaStatus = await DVAService.getEmployerDVAStatus({
      employerProfileId: profile._id,
    });

    const transactionResult = await EmployerBillingService.getRecentTransactions({
      walletId: wallet._id,
      page: transactionsPage,
    });

    const walletActivitySummary = await EmployerBillingService.getWalletActivitySummary({
      walletId: wallet._id,
      currency: wallet.currency || "NGN",
    });

    const walletSummary = EmployerBillingService.buildWalletSummary(wallet, walletActivitySummary);

    const dvaView = EmployerBillingService.buildDVAView(dvaStatus);

    const paymentsDue = await EmployerBillingService.getPaymentsDueSummary({
      employerProfileId: profile._id,
      currency: wallet.currency || "NGN",
    });

    const withdrawalAccount = await EmployerBillingService.getEmployerWithdrawalAccountView(
      profile._id
    );

    const withdrawalBankSetup = await BankProviderService.getWithdrawalBankSetup();

    return {
      pageTitle: "Billing & Wallet",

      employer: {
        id: String(profile._id),
        businessName: profile.businessName || "Employer",
        type: profile.type || null,
      },

      wallet: walletSummary,
      dva: dvaView,
      withdrawalAccount,

      withdrawalBankSetup,
      withdrawalBanks: withdrawalBankSetup.banks,

      paymentsDue,
      transactions: transactionResult.transactions,
      transactionsPagination: transactionResult.pagination,

      hasTransactions: transactionResult.transactions.length > 0,

      emptyState: {
        transactions: "No wallet transactions yet.",
      },
    };
  }

  /* ---------- Build DVA setup result ---------- */
  static buildDVASetupResult(dva) {
    if (dva.status === "active") {
      return {
        outcome: "active",
        dvaStatus: dva.status,
        message: "Wallet bank account is ready.",
      };
    }

    return {
      outcome: "setup_pending",
      dvaStatus: dva.status,
      message:
        dva.failureReason ||
        "Wallet bank account setup has been received. Please allow up to 24 hours.",
    };
  }

  /* ---------- Request employer DVA setup ---------- */
  static async requestEmployerDVASetup({ userId, employerProfile = null }) {
    const profile = await EmployerBillingService.getEmployerProfileForUser(userId, employerProfile);

    const dva = await DVAService.createEmployerDVA({
      userId,
      employerProfileId: profile._id,
    });

    return EmployerBillingService.buildDVASetupResult(dva);
  }
}

module.exports = EmployerBillingService;
