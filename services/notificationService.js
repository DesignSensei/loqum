// services/notificationService.js

const Notification = require("../models/Notification");

const money = require("../utils/money");

class NotificationService {
  /* ---------- Clean string ---------- */
  static cleanString(value) {
    const cleanValue = String(value || "").trim();

    return cleanValue || null;
  }

  /* ---------- Build create options ---------- */
  static buildCreateOptions(options = {}) {
    return options.session
      ? {
          session: options.session,
        }
      : {};
  }

  /* ---------- Create notification ---------- */
  static async createNotification(
    {
      recipientUser,
      employer = null,
      professional = null,

      category,
      type,

      title,
      message,
      actionUrl = null,

      relatedWallet = null,
      relatedTransaction = null,
      relatedShift = null,
      relatedInvite = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!recipientUser) {
      throw new Error("Notification recipient user is required.");
    }

    if (!category) {
      throw new Error("Notification category is required.");
    }

    if (!type) {
      throw new Error("Notification type is required.");
    }

    const cleanTitle = NotificationService.cleanString(title);
    const cleanMessage = NotificationService.cleanString(message);

    if (!cleanTitle) {
      throw new Error("Notification title is required.");
    }

    if (!cleanMessage) {
      throw new Error("Notification message is required.");
    }

    const notificationPayload = {
      recipientUser,

      employer,
      professional,

      category,
      type,

      title: cleanTitle,
      message: cleanMessage,
      actionUrl: NotificationService.cleanString(actionUrl),

      relatedWallet,
      relatedTransaction,
      relatedShift,
      relatedInvite,

      metadata,
    };

    const [notification] = await Notification.create(
      [notificationPayload],
      NotificationService.buildCreateOptions(options)
    );

    return notification;
  }

  /* ---------- Create notification once for transaction ---------- */
  static async createTransactionNotificationOnce(
    {
      recipientUser,
      employer = null,
      professional = null,

      category,
      type,

      title,
      message,
      actionUrl = null,

      relatedWallet = null,
      relatedTransaction,

      metadata = {},
    },
    options = {}
  ) {
    if (!relatedTransaction) {
      throw new Error("Related transaction is required.");
    }

    const existingNotification = await Notification.findOne({
      recipientUser,
      type,
      relatedTransaction,
    }).session(options.session || null);

    if (existingNotification) {
      return existingNotification;
    }

    return NotificationService.createNotification(
      {
        recipientUser,
        employer,
        professional,

        category,
        type,

        title,
        message,
        actionUrl,

        relatedWallet,
        relatedTransaction,

        metadata,
      },
      options
    );
  }

  /* ---------- Create employer notification ---------- */
  static async createEmployerNotification(
    {
      recipientUser,
      employer,

      category,
      type,

      title,
      message,
      actionUrl = null,

      relatedWallet = null,
      relatedTransaction = null,
      relatedShift = null,
      relatedInvite = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!employer) {
      throw new Error("Employer profile is required.");
    }

    return NotificationService.createNotification(
      {
        recipientUser,
        employer,
        professional: null,

        category,
        type,

        title,
        message,
        actionUrl,

        relatedWallet,
        relatedTransaction,
        relatedShift,
        relatedInvite,

        metadata,
      },
      options
    );
  }

  /* ---------- Create professional notification ---------- */
  static async createProfessionalNotification(
    {
      recipientUser,
      professional,

      category,
      type,

      title,
      message,
      actionUrl = null,

      relatedWallet = null,
      relatedTransaction = null,
      relatedShift = null,
      relatedInvite = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!professional) {
      throw new Error("Professional profile is required.");
    }

    return NotificationService.createNotification(
      {
        recipientUser,
        employer: null,
        professional,

        category,
        type,

        title,
        message,
        actionUrl,

        relatedWallet,
        relatedTransaction,
        relatedShift,
        relatedInvite,

        metadata,
      },
      options
    );
  }

  /* ---------- Notify employer wallet funded ---------- */
  static async notifyEmployerWalletFunded(
    {
      recipientUser,
      employer,
      wallet,
      transaction,

      amount,
      currency = "NGN",

      metadata = {},
    },
    options = {}
  ) {
    if (!wallet?._id) {
      throw new Error("Wallet is required.");
    }

    if (!transaction?._id) {
      throw new Error("Transaction is required.");
    }

    const amountDisplay = money.formatMoney(amount, currency);

    return NotificationService.createTransactionNotificationOnce(
      {
        recipientUser,
        employer,

        category: "finance",
        type: "wallet_funded",

        title: "Wallet funded",
        message: `${amountDisplay} has been added to your employer wallet.`,
        actionUrl: "/employer/billing",

        relatedWallet: wallet._id,
        relatedTransaction: transaction._id,

        metadata: {
          ...metadata,
          amount,
          amountDisplay,
          currency,
          source: "employer_wallet_funding",
        },
      },
      options
    );
  }

  /* ---------- Notify employer withdrawal submitted ---------- */
  static async notifyEmployerWithdrawalSubmitted(
    {
      recipientUser,
      employer,
      wallet,
      transaction,

      amount,
      currency = "NGN",

      metadata = {},
    },
    options = {}
  ) {
    if (!wallet?._id) {
      throw new Error("Wallet is required.");
    }

    if (!transaction?._id) {
      throw new Error("Transaction is required.");
    }

    const amountDisplay = money.formatMoney(amount, currency);

    return NotificationService.createTransactionNotificationOnce(
      {
        recipientUser,
        employer,

        category: "finance",
        type: "withdrawal_submitted",

        title: "Withdrawal submitted",
        message: `Your withdrawal request of ${amountDisplay} has been submitted.`,
        actionUrl: "/employer/billing#withdrawal-status",

        relatedWallet: wallet._id,
        relatedTransaction: transaction._id,

        metadata: {
          ...metadata,
          amount,
          amountDisplay,
          currency,
          source: "employer_withdrawal_submitted",
        },
      },
      options
    );
  }

  /* ---------- Notify employer withdrawal completed ---------- */
  static async notifyEmployerWithdrawalCompleted(
    {
      recipientUser,
      employer,
      wallet,
      transaction,

      amount,
      currency = "NGN",

      metadata = {},
    },
    options = {}
  ) {
    if (!wallet?._id) {
      throw new Error("Wallet is required.");
    }

    if (!transaction?._id) {
      throw new Error("Transaction is required.");
    }

    const amountDisplay = money.formatMoney(amount, currency);

    return NotificationService.createTransactionNotificationOnce(
      {
        recipientUser,
        employer,

        category: "finance",
        type: "withdrawal_completed",

        title: "Withdrawal completed",
        message: `Your withdrawal of ${amountDisplay} has been completed.`,
        actionUrl: "/employer/billing#withdrawal-status",

        relatedWallet: wallet._id,
        relatedTransaction: transaction._id,

        metadata: {
          ...metadata,
          amount,
          amountDisplay,
          currency,
          source: "employer_withdrawal_completed",
        },
      },
      options
    );
  }

  /* ---------- Notify employer withdrawal reversed ---------- */
  static async notifyEmployerWithdrawalReversed(
    {
      recipientUser,
      employer,
      wallet,
      transaction,

      amount,
      currency = "NGN",

      metadata = {},
    },
    options = {}
  ) {
    if (!wallet?._id) {
      throw new Error("Wallet is required.");
    }

    if (!transaction?._id) {
      throw new Error("Transaction is required.");
    }

    const amountDisplay = money.formatMoney(amount, currency);

    return NotificationService.createTransactionNotificationOnce(
      {
        recipientUser,
        employer,

        category: "finance",
        type: "withdrawal_reversed",

        title: "Withdrawal reversed",
        message: `Your withdrawal of ${amountDisplay} could not be completed, so the amount has been returned to your wallet.`,
        actionUrl: "/employer/billing#withdrawal-status",

        relatedWallet: wallet._id,
        relatedTransaction: transaction._id,

        metadata: {
          ...metadata,
          amount,
          amountDisplay,
          currency,
          source: "employer_withdrawal_reversed",
        },
      },
      options
    );
  }

  /* ---------- Get user notifications ---------- */
  static async getUserNotifications(
    userId,
    { status = null, category = null, limit = 20, createdAfter = null } = {}
  ) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    const query = {
      recipientUser: userId,
    };

    if (status) {
      query.status = status;
    }

    if (category) {
      query.category = category;
    }

    if (createdAfter instanceof Date && !Number.isNaN(createdAfter.getTime())) {
      query.createdAt = {
        $gte: createdAfter,
      };
    }

    return Notification.find(query)
      .sort({
        createdAt: -1,
      })
      .limit(limit);
  }

  /* ---------- Count unread notifications ---------- */
  static async countUnreadNotifications(userId, { createdAfter = null } = {}) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    const query = {
      recipientUser: userId,
      status: "unread",
    };

    if (createdAfter instanceof Date && !Number.isNaN(createdAfter.getTime())) {
      query.createdAt = {
        $gte: createdAfter,
      };
    }

    return Notification.countDocuments(query);
  }

  /* ---------- Mark notification as read ---------- */
  static async markNotificationAsRead({ notificationId, recipientUser }, options = {}) {
    if (!notificationId) {
      throw new Error("Notification ID is required.");
    }

    if (!recipientUser) {
      throw new Error("Recipient user is required.");
    }

    return Notification.findOneAndUpdate(
      {
        _id: notificationId,
        recipientUser,
      },
      {
        $set: {
          status: "read",
          readAt: new Date(),
        },
      },
      {
        returnDocument: "after",
        session: options.session || null,
      }
    );
  }

  /* ---------- Mark all user notifications as read ---------- */
  static async markAllUserNotificationsAsRead(userId, options = {}) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    return Notification.updateMany(
      {
        recipientUser: userId,
        status: "unread",
      },
      {
        $set: {
          status: "read",
          readAt: new Date(),
        },
      },
      {
        session: options.session || null,
      }
    );
  }
}

module.exports = NotificationService;
