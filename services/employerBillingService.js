// services/employerBillingService.js

const EmployerProfile = require("../models/EmployerProfile");
const Transaction = require("../models/Transaction");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const BankAccount = require("../models/BankAccount");

const DVAService = require("./dvaService");
const WalletService = require("./walletService");
const BankProviderService = require("./bankProviderService");
const EmployerDelinquencyService = require("./employerDelinquencyService");

const money = require("../utils/money");
const { badgeClass, formatStatus } = require("../utils/statusHelper");

const TRANSACTIONS_PER_PAGE = 25;

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

  /* ---------- Clean string value ---------- */

  static cleanString(value) {
    const cleaned = String(value || "").trim();

    return cleaned || null;
  }

  /* ---------- Normalize current time ---------- */

  static normalizeCurrentTime(value = new Date()) {
    const currentTime = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(currentTime.getTime())) {
      throw new Error("Current time is invalid.");
    }

    return currentTime;
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

  /* ---------- Get human-readable transaction purpose ---------- */

  static getTransactionPurposeLabel(purpose) {
    const purposeMap = {
      employer_wallet_funding: "Employer wallet funding",
      shift_escrow_funding: "Shift protected-fund deposit",
      shift_overtime_topup: "Shift overtime top-up",
      expired_unfilled_refund: "Expired unfilled occurrence refund",
      unused_occurrence_balance_refund: "Unused occurrence balance refund",
      cancelled_occurrence_refund: "Cancelled occurrence refund",
      confirmed_no_show_refund: "Confirmed no-show refund",
      closed_occurrence_refund: "Closed occurrence refund",
      final_shift_reconciliation_refund: "Final Shift reconciliation refund",
      shift_refund: "Shift refund",
      weekly_professional_payout: "Weekly professional payout",
      employer_withdrawal: "Employer withdrawal",
      employer_withdrawal_reversal: "Employer withdrawal reversal",
    };

    return purposeMap[purpose] || formatStatus(purpose || "transaction");
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

  /* ---------- Get employer occurrence payments that need attention ---------- */

  static async getPaymentsDueSummary({
    employerProfileId,
    currency = "NGN",
    currentTime = new Date(),
  }) {
    const now = EmployerBillingService.normalizeCurrentTime(currentTime);

    /*
     * ShiftOccurrence is the authoritative overtime/top-up source.
     *
     * Do not depend on parent Shift.paymentStatus or the compatibility
     * settlementStatus summary to decide whether money is owed.
     */
    const occurrences = await ShiftOccurrence.find({
      business: employerProfileId,

      "overtime.requested": true,

      "overtime.status": "approved",

      "overtime.topUpPaid": {
        $ne: true,
      },

      topUpRequired: {
        $gt: 0,
      },
    })
      .select(
        [
          "shift",
          "referenceCode",
          "sequenceNumber",
          "startTime",
          "endTime",
          "topUpRequired",
          "topUpTransaction",
          "overtime",
        ].join(" ")
      )
      .populate({
        path: "shift",

        select: "referenceCode roleTitle scheduleMode",
      })
      .sort({
        "overtime.topUpDeadlineAt": 1,

        startTime: -1,
      })
      .lean();

    const items = occurrences.map((occurrence) => {
      const amount = Number(occurrence.topUpRequired || 0);

      const topUpDeadlineAt = occurrence.overtime?.topUpDeadlineAt || null;

      const topUpOverdueAt = occurrence.overtime?.topUpOverdueAt || null;

      const restrictionTriggeredAt = occurrence.overtime?.restrictionTriggeredAt || null;

      const deadlineTime = topUpDeadlineAt ? new Date(topUpDeadlineAt).getTime() : null;

      const restrictionTime = restrictionTriggeredAt
        ? new Date(restrictionTriggeredAt).getTime()
        : null;

      const isOverdue = Boolean(
        topUpOverdueAt ||
        (deadlineTime !== null && !Number.isNaN(deadlineTime) && deadlineTime <= now.getTime())
      );

      const restrictionTriggered = Boolean(
        restrictionTime !== null &&
        !Number.isNaN(restrictionTime) &&
        restrictionTime <= now.getTime()
      );

      const attentionStatus = restrictionTriggered
        ? "restricted"
        : isOverdue
          ? "overdue"
          : "payment_due";

      return {
        occurrenceId: String(occurrence._id),

        occurrenceReferenceCode: occurrence.referenceCode,

        sequenceNumber: occurrence.sequenceNumber,

        shiftId: occurrence.shift?._id ? String(occurrence.shift._id) : null,

        shiftReferenceCode: occurrence.shift?.referenceCode || null,

        roleTitle: occurrence.shift?.roleTitle || "Shift",

        scheduleMode: occurrence.shift?.scheduleMode || null,

        startTime: occurrence.startTime,

        startTimeDisplay: EmployerBillingService.formatDateTime(occurrence.startTime),

        endTime: occurrence.endTime,

        endTimeDisplay: EmployerBillingService.formatDateTime(occurrence.endTime),

        amount,

        amountDisplay: EmployerBillingService.formatAmount(amount, currency),

        overtimeStatus: occurrence.overtime?.status || null,

        topUpPaid: occurrence.overtime?.topUpPaid === true,

        topUpPaidAt: occurrence.overtime?.topUpPaidAt || null,

        topUpDeadlineAt,

        topUpDeadlineAtDisplay: EmployerBillingService.formatDateTime(topUpDeadlineAt),

        topUpOverdueAt,

        topUpOverdueAtDisplay: EmployerBillingService.formatDateTime(topUpOverdueAt),

        restrictionTriggeredAt,

        restrictionTriggeredAtDisplay:
          EmployerBillingService.formatDateTime(restrictionTriggeredAt),

        isOverdue,

        restrictionTriggered,

        attentionStatus,

        attentionStatusLabel: formatStatus(attentionStatus),

        topUpTransactionId: occurrence.topUpTransaction
          ? String(occurrence.topUpTransaction)
          : null,
      };
    });

    const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);

    const overdueCount = items.filter((item) => item.isOverdue).length;

    const restrictedCount = items.filter((item) => item.restrictionTriggered).length;

    let message = "No additional Shift payments are currently due.";

    if (items.length === 1) {
      message = "One Shift occurrence needs an additional payment before settlement can continue.";
    } else if (items.length > 1) {
      message =
        `${items.length} Shift occurrences need additional payment ` +
        "before settlement can continue.";
    }

    return {
      hasPaymentsDue: totalAmount > 0,

      count: items.length,

      overdueCount,

      restrictedCount,

      totalAmount,

      totalAmountDisplay: EmployerBillingService.formatAmount(totalAmount, currency),

      items,

      message,
    };
  }

  /* ---------- Build employer delinquency display state ---------- */

  static buildDelinquencyView(restrictionState, currency = "NGN") {
    const state = restrictionState || {};

    const restricted = state.restricted === true;

    const totalOutstandingTopUp = Number(state.totalOutstandingTopUp || 0);

    return {
      status: state.status || (restricted ? "restricted" : "clear"),

      restricted,

      restrictionReason: state.restrictionReason || null,

      canCreateNewObligations: state.canCreateNewObligations !== false,

      canPostShifts: state.canPostShifts !== false,

      blockingOccurrenceCount: Number(state.blockingOccurrenceCount || 0),

      totalOutstandingTopUp,

      totalOutstandingTopUpDisplay: EmployerBillingService.formatAmount(
        totalOutstandingTopUp,
        currency
      ),

      oldestRestrictionTriggeredAt: state.oldestRestrictionTriggeredAt || null,

      oldestRestrictionTriggeredAtDisplay: EmployerBillingService.formatDateTime(
        state.oldestRestrictionTriggeredAt
      ),

      evaluatedAt: state.evaluatedAt || null,

      evaluatedAtDisplay: EmployerBillingService.formatDateTime(state.evaluatedAt),

      blockingOccurrences: Array.isArray(state.blockingOccurrences)
        ? state.blockingOccurrences
        : [],

      /*
       * First-level delinquency restricts new obligations only.
       * It does not freeze the employer wallet or block debt resolution.
       */
      walletUsable: true,

      message: restricted
        ? "New Shift posting is temporarily unavailable until the overdue overtime payment is completed. Your wallet remains available for this payment."
        : null,
    };
  }

  /* ---------- Get wallet activity summary for display cards ---------- */

  static async getWalletActivitySummary({ walletId, currency = "NGN" }) {
    if (!walletId) {
      return {
        moneyAdded: 0,

        moneyUsed: 0,

        refundsReturned: 0,

        shiftsFunded: 0,

        moneyAddedDisplay: EmployerBillingService.formatAmount(0, currency),

        moneyUsedDisplay: EmployerBillingService.formatAmount(0, currency),

        refundsReturnedDisplay: EmployerBillingService.formatAmount(0, currency),

        shiftsFundedDisplay: EmployerBillingService.formatAmount(0, currency),
      };
    }

    const [summary] = await Transaction.aggregate([
      {
        $match: {
          wallet: walletId,

          status: "completed",
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
                    {
                      $eq: ["$direction", "credit"],
                    },
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
                  $eq: ["$direction", "debit"],
                },
                "$amount",
                0,
              ],
            },
          },

          refundsReturned: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $eq: ["$direction", "credit"],
                    },
                    {
                      $in: ["$type", ["shift_refund", "dispute_refund"]],
                    },
                  ],
                },
                "$amount",
                0,
              ],
            },
          },

          shiftsFunded: {
            $sum: {
              $cond: [
                {
                  $and: [
                    {
                      $eq: ["$direction", "debit"],
                    },
                    {
                      $in: ["$type", ["shift_funding", "shift_topup"]],
                    },
                  ],
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

    const refundsReturned = summary?.refundsReturned || 0;

    const shiftsFunded = summary?.shiftsFunded || 0;

    return {
      moneyAdded,

      moneyUsed,

      refundsReturned,

      shiftsFunded,

      moneyAddedDisplay: EmployerBillingService.formatAmount(moneyAdded, currency),

      moneyUsedDisplay: EmployerBillingService.formatAmount(moneyUsed, currency),

      refundsReturnedDisplay: EmployerBillingService.formatAmount(refundsReturned, currency),

      shiftsFundedDisplay: EmployerBillingService.formatAmount(shiftsFunded, currency),
    };
  }

  /* ---------- Build wallet summary view ---------- */

  static buildWalletSummary(wallet, walletActivitySummary = {}) {
    const currency = wallet.currency || "NGN";

    const moneyAdded = walletActivitySummary.moneyAdded ?? 0;

    const moneyUsed = walletActivitySummary.moneyUsed ?? 0;

    const refundsReturned = walletActivitySummary.refundsReturned ?? 0;

    const shiftsFunded = walletActivitySummary.shiftsFunded ?? 0;

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

      refundsReturned,

      shiftsFunded,

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

      refundsReturnedDisplay: EmployerBillingService.formatAmount(refundsReturned, currency),

      shiftsFundedDisplay: EmployerBillingService.formatAmount(shiftsFunded, currency),

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

    const shift = transaction.shift || null;

    const occurrence = transaction.shiftOccurrence || null;

    const settlementBatch = transaction.settlementBatch || null;

    return {
      id: String(transaction._id),

      reference: transaction.reference,

      groupReference: transaction.groupReference || null,

      type: transaction.type,

      typeLabel: EmployerBillingService.getTransactionTypeLabel(transaction.type),

      purpose: transaction.purpose || null,

      purposeLabel: EmployerBillingService.getTransactionPurposeLabel(transaction.purpose),

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

      shiftId: shift?._id ? String(shift._id) : shift ? String(shift) : null,

      shiftReferenceCode: shift?.referenceCode || null,

      shiftRoleTitle: shift?.roleTitle || null,

      shiftScheduleMode: shift?.scheduleMode || null,

      occurrenceId: occurrence?._id
        ? String(occurrence._id)
        : occurrence
          ? String(occurrence)
          : null,

      occurrenceReferenceCode: occurrence?.referenceCode || null,

      occurrenceSequenceNumber: occurrence?.sequenceNumber ?? null,

      occurrenceStartTime: occurrence?.startTime || null,

      occurrenceStartTimeDisplay: EmployerBillingService.formatDateTime(occurrence?.startTime),

      assignmentCaseId: transaction.assignmentCase ? String(transaction.assignmentCase) : null,

      settlementBatchId: settlementBatch?._id
        ? String(settlementBatch._id)
        : settlementBatch
          ? String(settlementBatch)
          : null,

      settlementBatchReferenceCode: settlementBatch?.referenceCode || null,

      settlementBatchPayoutDate: settlementBatch?.payoutDate || null,

      settlementBatchComponent: settlementBatch?.settlementComponent || null,

      relatedTransactionId: transaction.relatedTransaction
        ? String(transaction.relatedTransaction)
        : null,

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
    const perPage = TRANSACTIONS_PER_PAGE;

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
      .populate({
        path: "shift",

        select: "referenceCode roleTitle scheduleMode",
      })
      .populate({
        path: "shiftOccurrence",

        select: "referenceCode sequenceNumber startTime",
      })
      .populate({
        path: "settlementBatch",

        select: "referenceCode payoutDate settlementComponent",
      })
      .sort({
        createdAt: -1,
      })
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
      {
        includeAccountNumber: true,
      }
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

      const selectedBank = withdrawalBankSetup.banks.find(
        (bank) => String(bank.paystackBankCode || bank.value || "").trim() === cleanPaystackBankCode
      );

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
    currentTime = new Date(),
  }) {
    const now = EmployerBillingService.normalizeCurrentTime(currentTime);

    const profile = await EmployerBillingService.getEmployerProfileForUser(userId, employerProfile);

    const wallet = await WalletService.createEmployerWalletIfMissing(profile);

    const currency = wallet.currency || "NGN";

    const [
      dvaStatus,
      transactionResult,
      walletActivitySummary,
      paymentsDue,
      restrictionState,
      withdrawalAccount,
      withdrawalBankSetup,
    ] = await Promise.all([
      DVAService.getEmployerDVAStatus({
        employerProfileId: profile._id,
      }),

      EmployerBillingService.getRecentTransactions({
        walletId: wallet._id,

        page: transactionsPage,
      }),

      EmployerBillingService.getWalletActivitySummary({
        walletId: wallet._id,

        currency,
      }),

      EmployerBillingService.getPaymentsDueSummary({
        employerProfileId: profile._id,

        currency,

        currentTime: now,
      }),

      EmployerDelinquencyService.getRestrictionState({
        businessId: profile._id,

        currentTime: now,
      }),

      EmployerBillingService.getEmployerWithdrawalAccountView(profile._id),

      BankProviderService.getWithdrawalBankSetup(),
    ]);

    return {
      pageTitle: "Billing & Wallet",

      employer: {
        id: String(profile._id),

        businessName: profile.businessName || "Employer",

        type: profile.type || null,
      },

      wallet: EmployerBillingService.buildWalletSummary(wallet, walletActivitySummary),

      dva: EmployerBillingService.buildDVAView(dvaStatus),

      delinquency: EmployerBillingService.buildDelinquencyView(restrictionState, currency),

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
