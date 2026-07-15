// services/providerEventProcessorService.js

const mongoose = require("mongoose");

const Transaction = require("../models/Transaction");

const ProviderEventService = require("./providerEventService");
const WalletFundingService = require("./walletFundingService");
const WalletWithdrawalService = require("./walletWithdrawalService");

class ProviderEventProcessorService {
  static eventCategories = {
    employerWalletFunding: ["employer_wallet_funding", "wallet_funding"],
    shiftCheckoutPayment: ["shift_checkout_payment", "checkout_payment"],

    withdrawalPayout: [
      "withdrawal_transfer",
      "employer_withdrawal_payout",
      "professional_withdrawal_payout",
    ],

    withdrawalReversal: [
      "transfer_reversal",
      "employer_withdrawal_reversal",
      "professional_withdrawal_reversal",
    ],
  };

  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Check event category ---------- */
  static isCategory(providerEvent, allowedCategories = []) {
    return allowedCategories.includes(providerEvent.eventCategory);
  }

  /* ---------- Get normalized payload ---------- */
  static getNormalizedPayload(providerEvent) {
    return providerEvent.normalizedPayload || {};
  }

  /* ---------- Get value from normalized payload or provider event ---------- */
  static getPayloadValue(providerEvent, key, fallbackKey = null) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    if (payload[key] !== null && payload[key] !== undefined && payload[key] !== "") {
      return payload[key];
    }

    if (
      fallbackKey &&
      providerEvent[fallbackKey] !== null &&
      providerEvent[fallbackKey] !== undefined &&
      providerEvent[fallbackKey] !== ""
    ) {
      return providerEvent[fallbackKey];
    }

    return null;
  }

  /* ---------- Get nested value from object ---------- */
  static getNestedValue(source = {}, path = "") {
    if (!source || !path) {
      return null;
    }

    return path.split(".").reduce((currentValue, key) => {
      if (
        currentValue === null ||
        currentValue === undefined ||
        currentValue[key] === null ||
        currentValue[key] === undefined ||
        currentValue[key] === ""
      ) {
        return null;
      }

      return currentValue[key];
    }, source);
  }

  /* ---------- Get value from normalized payload nested paths ---------- */
  static getNestedPayloadValue(providerEvent, paths = []) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    for (const path of paths) {
      const value = ProviderEventProcessorService.getNestedValue(payload, path);

      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }

    return null;
  }

  /* ---------- Get withdrawal transaction ID from provider event ---------- */
  static getWithdrawalTransactionId(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(
        providerEvent,
        "withdrawalTransactionId",
        "transaction"
      ) ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "transactionId", "transaction")
    );
  }

  /* ---------- Get Paystack transfer code from provider event ---------- */
  static getPaystackTransferCode(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackTransferCode") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "transferCode") ||
      ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
        "metadata.transferCode",
        "metadata.transfer_code",
      ])
    );
  }

  /* ---------- Get Paystack transfer reference from provider event ---------- */
  static getPaystackTransferReference(providerEvent) {
    return (
      ProviderEventProcessorService.getPayloadValue(providerEvent, "paystackTransferReference") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "transferReference") ||
      ProviderEventProcessorService.getPayloadValue(providerEvent, "providerReference") ||
      ProviderEventProcessorService.getNestedPayloadValue(providerEvent, [
        "metadata.paystackTransferReference",
        "metadata.transferReference",
        "metadata.reference",
        "metadata.metadata.paystackTransferReference",
        "metadata.metadata.transferReference",
      ]) ||
      providerEvent.providerReference
    );
  }

  /* ---------- Find withdrawal transaction from provider event ---------- */
  static async findWithdrawalTransactionForProviderEvent(providerEvent, options = {}) {
    const withdrawalTransactionId =
      ProviderEventProcessorService.getWithdrawalTransactionId(providerEvent);

    if (withdrawalTransactionId && mongoose.Types.ObjectId.isValid(withdrawalTransactionId)) {
      const query = Transaction.findOne({
        _id: withdrawalTransactionId,
        type: "withdrawal",
      });

      if (options.session) {
        query.session(options.session);
      }

      const transaction = await query;

      if (transaction) {
        return transaction;
      }
    }

    const paystackTransferCode =
      ProviderEventProcessorService.getPaystackTransferCode(providerEvent);

    const paystackTransferReference =
      ProviderEventProcessorService.getPaystackTransferReference(providerEvent);

    const orFilters = [];

    if (paystackTransferCode) {
      orFilters.push({
        paystackTransferCode,
      });

      orFilters.push({
        "metadata.paystackTransferCode": paystackTransferCode,
      });
    }

    if (paystackTransferReference) {
      orFilters.push({
        "metadata.paystackTransferReference": paystackTransferReference,
      });

      orFilters.push({
        paystackReference: paystackTransferReference,
      });

      orFilters.push({
        reference: paystackTransferReference,
      });
    }

    if (!orFilters.length) {
      throw new Error("Withdrawal transaction lookup value is required.");
    }

    const query = Transaction.findOne({
      type: "withdrawal",
      $or: orFilters,
    });

    if (options.session) {
      query.session(options.session);
    }

    const transaction = await query;

    if (!transaction) {
      throw new Error("Withdrawal transaction not found for provider event.");
    }

    return transaction;
  }

  /* ---------- Get withdrawal owner context ---------- */
  static getWithdrawalOwnerContext({ withdrawalTransaction, providerEvent }) {
    const metadata = withdrawalTransaction.metadata || {};

    const employerProfileId = metadata.employerProfileId || providerEvent.employer || null;

    const professionalProfileId =
      metadata.professionalProfileId || providerEvent.professional || null;

    let ownerType = metadata.ownerType || null;

    if (!ownerType && professionalProfileId) {
      ownerType = "professional";
    }

    if (!ownerType && employerProfileId) {
      ownerType = "employer";
    }

    return {
      ownerType,
      employer: ownerType === "employer" ? employerProfileId : null,
      professional: ownerType === "professional" ? professionalProfileId : null,
      employerProfileId,
      professionalProfileId,
    };
  }

  /* ---------- Process recorded provider event ---------- */
  static async processProviderEvent({ providerEventRecordId }, options = {}) {
    return ProviderEventService.runWithOptionalTransaction(options, async (session) => {
      const providerEvent = await ProviderEventService.getProviderEventById(providerEventRecordId, {
        session,
      });

      if (providerEvent.status === "processed") {
        return {
          providerEvent,
          alreadyProcessed: true,
        };
      }

      if (providerEvent.status === "ignored") {
        return {
          providerEvent,
          alreadyIgnored: true,
        };
      }

      if (!providerEvent.isVerified) {
        const failedResult = await ProviderEventService.markFailed(
          {
            providerEventRecordId: providerEvent._id,
            failureReason: "Unverified provider event cannot be processed.",
            retryable: false,
            metadata: {
              processor: "ProviderEventProcessorService",
            },
          },
          {
            session,
          }
        );

        return {
          providerEvent: failedResult.providerEvent,
          failed: true,
          errorMessage: "Unverified provider event cannot be processed.",
        };
      }

      await ProviderEventService.markProcessing(
        {
          providerEventRecordId: providerEvent._id,
        },
        {
          session,
        }
      );

      try {
        if (
          ProviderEventProcessorService.isCategory(
            providerEvent,
            ProviderEventProcessorService.eventCategories.employerWalletFunding
          )
        ) {
          return ProviderEventProcessorService.processEmployerWalletFundingEvent(providerEvent, {
            session,
          });
        }

        if (
          ProviderEventProcessorService.isCategory(
            providerEvent,
            ProviderEventProcessorService.eventCategories.withdrawalPayout
          )
        ) {
          return ProviderEventProcessorService.processWithdrawalPayoutEvent(providerEvent, {
            session,
          });
        }

        if (
          ProviderEventProcessorService.isCategory(
            providerEvent,
            ProviderEventProcessorService.eventCategories.withdrawalReversal
          )
        ) {
          return ProviderEventProcessorService.processWithdrawalReversalEvent(providerEvent, {
            session,
          });
        }

        if (
          ProviderEventProcessorService.isCategory(
            providerEvent,
            ProviderEventProcessorService.eventCategories.shiftCheckoutPayment
          )
        ) {
          const ignoredResult = await ProviderEventService.markIgnored(
            {
              providerEventRecordId: providerEvent._id,
              ignoredReason: "Shift checkout provider event processing is not implemented yet.",
              metadata: {
                processor: "ProviderEventProcessorService",
              },
            },
            {
              session,
            }
          );

          return {
            providerEvent: ignoredResult.providerEvent,
            ignored: true,
          };
        }

        const ignoredResult = await ProviderEventService.markIgnored(
          {
            providerEventRecordId: providerEvent._id,
            ignoredReason: "Provider event category is not handled by this processor.",
            metadata: {
              processor: "ProviderEventProcessorService",
            },
          },
          {
            session,
          }
        );

        return {
          providerEvent: ignoredResult.providerEvent,
          ignored: true,
        };
      } catch (error) {
        const failedResult = await ProviderEventService.markFailed(
          {
            providerEventRecordId: providerEvent._id,
            failureReason: error.message || "Provider event processing failed.",
            retryable: false,
            metadata: {
              processor: "ProviderEventProcessorService",
            },
          },
          {
            session,
          }
        );

        return {
          providerEvent: failedResult.providerEvent,
          failed: true,
          errorMessage: error.message || "Provider event processing failed.",
        };
      }
    });
  }

  /* ---------- Process employer wallet funding event ---------- */
  static async processEmployerWalletFundingEvent(providerEvent, options = {}) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const employerProfileId =
      payload.employerProfileId || payload.employer || providerEvent.employer;

    const dvaId = payload.dvaId || payload.dva || providerEvent.dva;

    const amount =
      payload.amount !== null && payload.amount !== undefined
        ? payload.amount
        : providerEvent.amount;

    const providerFee =
      payload.providerFee !== null && payload.providerFee !== undefined
        ? payload.providerFee
        : providerEvent.providerFee;

    const netAmount =
      payload.netAmount !== null && payload.netAmount !== undefined
        ? payload.netAmount
        : providerEvent.netAmount;

    const currency = payload.currency || providerEvent.currency || "NGN";
    const providerReference = payload.providerReference || providerEvent.providerReference;
    const providerEventId = payload.providerEventId || providerEvent.providerEventId;

    if (!employerProfileId) {
      throw new Error("Employer profile ID is required to process wallet funding event.");
    }

    if (!dvaId) {
      throw new Error("DVA ID is required to process wallet funding event.");
    }

    if (amount === null || amount === undefined) {
      throw new Error("Amount is required to process wallet funding event.");
    }

    if (!providerReference) {
      throw new Error("Provider reference is required to process wallet funding event.");
    }

    const fundingResult = await WalletFundingService.creditEmployerWalletFromDvaFunding(
      {
        employerProfileId,
        dvaId,

        amount,
        currency,

        provider: providerEvent.provider,
        providerReference,
        providerEventId,

        providerFee,
        netAmount,

        metadata: {
          providerEventRecordId: String(providerEvent._id),
          providerEventKey: providerEvent.eventKey,
          sourceEventName: providerEvent.eventName,
        },
      },
      options
    );

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,

        transaction: fundingResult.transaction._id,
        wallet: fundingResult.wallet._id,
        employer: employerProfileId,
        dva: dvaId,

        normalizedPayload: {
          ...payload,
          employerProfileId: String(employerProfileId),
          dvaId: String(dvaId),
          amount,
          currency,
          providerReference,
          providerEventId,
        },

        metadata: {
          processor: "ProviderEventProcessorService",
          walletFundingTransactionId: String(fundingResult.transaction._id),
          idempotentWalletFunding: Boolean(fundingResult.idempotent),
        },
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      wallet: fundingResult.wallet,
      transaction: fundingResult.transaction,
      processed: true,
      idempotentWalletFunding: Boolean(fundingResult.idempotent),
    };
  }

  /* ---------- Process withdrawal payout success event ---------- */
  static async processWithdrawalPayoutEvent(providerEvent, options = {}) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const withdrawalTransaction =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
        providerEvent,
        options
      );

    const completedResult = await WalletWithdrawalService.markWithdrawalCompleted(
      {
        withdrawalTransactionId: withdrawalTransaction._id,
        metadata: {
          providerEventRecordId: String(providerEvent._id),
          providerEventKey: providerEvent.eventKey,
          sourceEventName: providerEvent.eventName,
          providerReference: providerEvent.providerReference,
          providerEventId: providerEvent.providerEventId,
        },
      },
      options
    );

    const ownerContext = ProviderEventProcessorService.getWithdrawalOwnerContext({
      withdrawalTransaction: completedResult.transaction,
      providerEvent,
    });

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,

        transaction: completedResult.transaction._id,
        wallet: completedResult.transaction.wallet,
        employer: ownerContext.employer,
        professional: ownerContext.professional,
        bankAccount: completedResult.transaction.bankAccount || providerEvent.bankAccount,

        normalizedPayload: {
          ...payload,
          withdrawalTransactionId: String(completedResult.transaction._id),
          ownerType: ownerContext.ownerType,
          employerProfileId: ownerContext.employerProfileId
            ? String(ownerContext.employerProfileId)
            : null,
          professionalProfileId: ownerContext.professionalProfileId
            ? String(ownerContext.professionalProfileId)
            : null,
        },

        metadata: {
          processor: "ProviderEventProcessorService",
          withdrawalCompleted: true,
          ownerType: ownerContext.ownerType,
          alreadyCompleted: Boolean(completedResult.alreadyCompleted),
        },
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      transaction: completedResult.transaction,
      processed: true,
      ownerType: ownerContext.ownerType,
      alreadyCompleted: Boolean(completedResult.alreadyCompleted),
    };
  }

  /* ---------- Process withdrawal reversal event ---------- */
  static async processWithdrawalReversalEvent(providerEvent, options = {}) {
    const payload = ProviderEventProcessorService.getNormalizedPayload(providerEvent);

    const withdrawalTransaction =
      await ProviderEventProcessorService.findWithdrawalTransactionForProviderEvent(
        providerEvent,
        options
      );

    const reversalResult = await WalletWithdrawalService.reverseFailedWithdrawal(
      {
        withdrawalTransactionId: withdrawalTransaction._id,
        reversalReason:
          payload.reversalReason ||
          "Provider reported withdrawal failed or reversed. Wallet balance reversed.",
        metadata: {
          providerEventRecordId: String(providerEvent._id),
          providerEventKey: providerEvent.eventKey,
          sourceEventName: providerEvent.eventName,
          providerReference: providerEvent.providerReference,
          providerEventId: providerEvent.providerEventId,
        },
      },
      options
    );

    const ownerContext = ProviderEventProcessorService.getWithdrawalOwnerContext({
      withdrawalTransaction: reversalResult.originalTransaction,
      providerEvent,
    });

    const processedResult = await ProviderEventService.markProcessed(
      {
        providerEventRecordId: providerEvent._id,

        transaction: reversalResult.transaction._id,
        wallet: reversalResult.wallet._id,
        employer: ownerContext.employer,
        professional: ownerContext.professional,
        bankAccount: reversalResult.transaction.bankAccount || providerEvent.bankAccount,

        normalizedPayload: {
          ...payload,
          withdrawalTransactionId: String(reversalResult.originalTransaction._id),
          reversalTransactionId: String(reversalResult.transaction._id),
          ownerType: ownerContext.ownerType,
          employerProfileId: ownerContext.employerProfileId
            ? String(ownerContext.employerProfileId)
            : null,
          professionalProfileId: ownerContext.professionalProfileId
            ? String(ownerContext.professionalProfileId)
            : null,
        },

        metadata: {
          processor: "ProviderEventProcessorService",
          withdrawalReversed: true,
          ownerType: ownerContext.ownerType,
          idempotentReversal: Boolean(reversalResult.idempotent),
        },
      },
      options
    );

    return {
      providerEvent: processedResult.providerEvent,
      wallet: reversalResult.wallet,
      transaction: reversalResult.transaction,
      originalTransaction: reversalResult.originalTransaction,
      processed: true,
      ownerType: ownerContext.ownerType,
      idempotentReversal: Boolean(reversalResult.idempotent),
    };
  }
}

module.exports = ProviderEventProcessorService;
