// services/notificationService.js

const Notification = require("../models/Notification");

const {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPES_BY_CATEGORY,
} = require("../constants/notification");

const money = require("../utils/money");

const DEFAULT_NOTIFICATION_LIMIT = 20;
const MAX_NOTIFICATION_LIMIT = 100;
const MAX_NOTIFICATION_KEY_LENGTH = 300;

/**
 * NotificationService owns notification persistence, idempotent delivery
 * boundaries and user notification reads.
 *
 * Domain services remain authoritative for the lifecycle event itself and pass
 * already-resolved recipients, relationships and presentation copy here.
 */
class NotificationService {
  /* ─────────────────────────────── NORMALIZATION ─────────────────────────────── */

  static cleanString(value) {
    return String(value ?? "").trim() || null;
  }

  static normalizeMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return {
      ...value,
    };
  }

  static normalizeCategory(value, { required = true } = {}) {
    const category = NotificationService.cleanString(value)?.toLowerCase() || null;

    if (!category) {
      if (!required) {
        return null;
      }

      throw new Error("Notification category is required.");
    }

    if (!NOTIFICATION_CATEGORIES.includes(category)) {
      throw new Error("Notification category is invalid.");
    }

    return category;
  }

  static normalizeType(value, { required = true } = {}) {
    const type = NotificationService.cleanString(value)?.toLowerCase() || null;

    if (!type) {
      if (!required) {
        return null;
      }

      throw new Error("Notification type is required.");
    }

    if (!NOTIFICATION_TYPES.includes(type)) {
      throw new Error("Notification type is invalid.");
    }

    return type;
  }

  static assertTypeMatchesCategory({ category, type }) {
    const allowedTypes = NOTIFICATION_TYPES_BY_CATEGORY[category];

    if (!Array.isArray(allowedTypes) || !allowedTypes.includes(type)) {
      throw new Error(`Notification type ${type} does not belong to category ${category}.`);
    }
  }

  static normalizeStatus(value, { required = false } = {}) {
    const status = NotificationService.cleanString(value)?.toLowerCase() || null;

    if (!status) {
      if (!required) {
        return null;
      }

      throw new Error("Notification status is required.");
    }

    if (!NOTIFICATION_STATUSES.includes(status)) {
      throw new Error("Notification status is invalid.");
    }

    return status;
  }

  static normalizeLimit(value = DEFAULT_NOTIFICATION_LIMIT) {
    const limit = Number(value);

    if (!Number.isInteger(limit) || limit <= 0) {
      return DEFAULT_NOTIFICATION_LIMIT;
    }

    return Math.min(limit, MAX_NOTIFICATION_LIMIT);
  }

  static normalizeCreatedAfter(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  static normalizeNotificationKey(value) {
    const notificationKey = NotificationService.cleanString(value);

    if (!notificationKey) {
      throw new Error("Notification key is required for idempotent notification creation.");
    }

    if (notificationKey.length > MAX_NOTIFICATION_KEY_LENGTH) {
      throw new Error(`Notification key cannot exceed ${MAX_NOTIFICATION_KEY_LENGTH} characters.`);
    }

    return notificationKey;
  }

  static buildNotificationKey(...parts) {
    const normalizedParts = parts
      .flat()
      .map((part) => NotificationService.cleanString(part))
      .filter(Boolean);

    return NotificationService.normalizeNotificationKey(normalizedParts.join(":"));
  }

  static buildCreateOptions(options = {}) {
    return options.session
      ? {
          session: options.session,
        }
      : {};
  }

  static applySession(query, session = null) {
    if (session) {
      query.session(session);
    }

    return query;
  }

  /* ─────────────────────────────── CREATE ─────────────────────────────── */

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
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,
      relatedInvite = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!recipientUser) {
      throw new Error("Notification recipient user is required.");
    }

    if (employer && professional) {
      throw new Error("A notification cannot belong to both an employer and a professional.");
    }

    const normalizedCategory = NotificationService.normalizeCategory(category);

    const normalizedType = NotificationService.normalizeType(type);

    NotificationService.assertTypeMatchesCategory({
      category: normalizedCategory,
      type: normalizedType,
    });

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

      category: normalizedCategory,
      type: normalizedType,

      title: cleanTitle,
      message: cleanMessage,

      actionUrl: NotificationService.cleanString(actionUrl),

      relatedWallet,
      relatedTransaction,
      relatedShift,
      relatedOccurrence,
      relatedClaim,
      relatedDispute,
      relatedEmployerRefund,
      relatedInvite,

      metadata: NotificationService.normalizeMetadata(metadata),
    };

    const [notification] = await Notification.create(
      [notificationPayload],
      NotificationService.buildCreateOptions(options)
    );

    return notification;
  }

  /**
   * Generic idempotency boundary for lifecycle notifications.
   *
   * notificationKey is delivery identity only. Domain identity remains on the
   * first-class related Shift/occurrence/claim/dispute/refund fields.
   */
  static async createNotificationOnce(
    {
      notificationKey,

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
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,
      relatedInvite = null,

      metadata = {},
    },
    options = {}
  ) {
    const normalizedNotificationKey = NotificationService.normalizeNotificationKey(notificationKey);

    const normalizedType = NotificationService.normalizeType(type);

    const existingQuery = Notification.findOne({
      recipientUser,

      type: normalizedType,

      "metadata.notificationKey": normalizedNotificationKey,
    });

    NotificationService.applySession(existingQuery, options.session);

    const existingNotification = await existingQuery;

    if (existingNotification) {
      return existingNotification;
    }

    return NotificationService.createNotification(
      {
        recipientUser,

        employer,
        professional,

        category,
        type: normalizedType,

        title,
        message,
        actionUrl,

        relatedWallet,
        relatedTransaction,
        relatedShift,
        relatedOccurrence,
        relatedClaim,
        relatedDispute,
        relatedEmployerRefund,
        relatedInvite,

        metadata: {
          ...NotificationService.normalizeMetadata(metadata),

          notificationKey: normalizedNotificationKey,
        },
      },
      options
    );
  }

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
      relatedShift = null,
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!relatedTransaction) {
      throw new Error("Related transaction is required.");
    }

    const normalizedType = NotificationService.normalizeType(type);

    const existingQuery = Notification.findOne({
      recipientUser,

      type: normalizedType,

      relatedTransaction,
    });

    NotificationService.applySession(existingQuery, options.session);

    const existingNotification = await existingQuery;

    if (existingNotification) {
      return existingNotification;
    }

    return NotificationService.createNotification(
      {
        recipientUser,

        employer,
        professional,

        category,
        type: normalizedType,

        title,
        message,
        actionUrl,

        relatedWallet,
        relatedTransaction,
        relatedShift,
        relatedOccurrence,
        relatedClaim,
        relatedDispute,
        relatedEmployerRefund,

        metadata,
      },
      options
    );
  }

  /* ─────────────────────────────── OWNER-SCOPED CREATION ─────────────────────────────── */

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
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,
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
        relatedOccurrence,
        relatedClaim,
        relatedDispute,
        relatedEmployerRefund,
        relatedInvite,

        metadata,
      },
      options
    );
  }

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
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,
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
        relatedOccurrence,
        relatedClaim,
        relatedDispute,
        relatedEmployerRefund,
        relatedInvite,

        metadata,
      },
      options
    );
  }

  static async createEmployerLifecycleNotification(
    {
      notificationKey,

      recipientUser,
      employer,

      category,
      type,

      title,
      message,
      actionUrl = null,

      relatedTransaction = null,
      relatedShift = null,
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!employer) {
      throw new Error("Employer profile is required.");
    }

    return NotificationService.createNotificationOnce(
      {
        notificationKey,

        recipientUser,

        employer,
        professional: null,

        category,
        type,

        title,
        message,
        actionUrl,

        relatedTransaction,
        relatedShift,
        relatedOccurrence,
        relatedClaim,
        relatedDispute,
        relatedEmployerRefund,

        metadata,
      },
      options
    );
  }

  static async createProfessionalLifecycleNotification(
    {
      notificationKey,

      recipientUser,
      professional,

      category,
      type,

      title,
      message,
      actionUrl = null,

      relatedTransaction = null,
      relatedShift = null,
      relatedOccurrence = null,
      relatedClaim = null,
      relatedDispute = null,
      relatedEmployerRefund = null,

      metadata = {},
    },
    options = {}
  ) {
    if (!professional) {
      throw new Error("Professional profile is required.");
    }

    return NotificationService.createNotificationOnce(
      {
        notificationKey,

        recipientUser,

        employer: null,
        professional,

        category,
        type,

        title,
        message,
        actionUrl,

        relatedTransaction,
        relatedShift,
        relatedOccurrence,
        relatedClaim,
        relatedDispute,
        relatedEmployerRefund,

        metadata,
      },
      options
    );
  }

  /* ─────────────────────────────── EMPLOYER WALLET ─────────────────────────────── */

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
          ...NotificationService.normalizeMetadata(metadata),

          amount,
          amountDisplay,
          currency,

          source: "employer_wallet_funding",
        },
      },
      options
    );
  }

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
          ...NotificationService.normalizeMetadata(metadata),

          amount,
          amountDisplay,
          currency,

          source: "employer_withdrawal_submitted",
        },
      },
      options
    );
  }

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
          ...NotificationService.normalizeMetadata(metadata),

          amount,
          amountDisplay,
          currency,

          source: "employer_withdrawal_completed",
        },
      },
      options
    );
  }

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

        message:
          `Your withdrawal of ${amountDisplay} could not be completed, ` +
          "so the amount has been returned to your wallet.",

        actionUrl: "/employer/billing#withdrawal-status",

        relatedWallet: wallet._id,

        relatedTransaction: transaction._id,

        metadata: {
          ...NotificationService.normalizeMetadata(metadata),

          amount,
          amountDisplay,
          currency,

          source: "employer_withdrawal_reversed",
        },
      },
      options
    );
  }

  /* ─────────────────────────────── READ ─────────────────────────────── */

  static async getUserNotifications(
    userId,
    {
      status = null,
      category = null,
      type = null,

      limit = DEFAULT_NOTIFICATION_LIMIT,

      createdAfter = null,
    } = {}
  ) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    const normalizedStatus = NotificationService.normalizeStatus(status);

    const normalizedCategory = NotificationService.normalizeCategory(category, {
      required: false,
    });

    const normalizedType = NotificationService.normalizeType(type, {
      required: false,
    });

    const normalizedCreatedAfter = NotificationService.normalizeCreatedAfter(createdAfter);

    if (normalizedCategory && normalizedType) {
      NotificationService.assertTypeMatchesCategory({
        category: normalizedCategory,
        type: normalizedType,
      });
    }

    const query = {
      recipientUser: userId,
    };

    if (normalizedStatus) {
      query.status = normalizedStatus;
    }

    if (normalizedCategory) {
      query.category = normalizedCategory;
    }

    if (normalizedType) {
      query.type = normalizedType;
    }

    if (normalizedCreatedAfter) {
      query.createdAt = {
        $gte: normalizedCreatedAfter,
      };
    }

    return Notification.find(query)
      .sort({
        createdAt: -1,
      })
      .limit(NotificationService.normalizeLimit(limit));
  }

  static async countUnreadNotifications(userId, { createdAfter = null } = {}) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    const query = {
      recipientUser: userId,

      status: "unread",
    };

    const normalizedCreatedAfter = NotificationService.normalizeCreatedAfter(createdAfter);

    if (normalizedCreatedAfter) {
      query.createdAt = {
        $gte: normalizedCreatedAfter,
      };
    }

    return Notification.countDocuments(query);
  }

  /* ─────────────────────────────── READ STATE ─────────────────────────────── */

  static async markNotificationAsRead(
    {
      notificationId,

      recipientUser,

      currentTime = new Date(),
    },
    options = {}
  ) {
    if (!notificationId) {
      throw new Error("Notification ID is required.");
    }

    if (!recipientUser) {
      throw new Error("Recipient user is required.");
    }

    const readAt =
      currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

    if (Number.isNaN(readAt.getTime())) {
      throw new Error("Notification read time is invalid.");
    }

    return Notification.findOneAndUpdate(
      {
        _id: notificationId,

        recipientUser,
      },
      {
        $set: {
          status: "read",

          readAt,
        },
      },
      {
        returnDocument: "after",

        runValidators: true,

        session: options.session || null,
      }
    );
  }

  static async markAllUserNotificationsAsRead(
    userId,
    {
      currentTime = new Date(),

      session = null,
    } = {}
  ) {
    if (!userId) {
      throw new Error("User ID is required.");
    }

    const readAt =
      currentTime instanceof Date ? new Date(currentTime.getTime()) : new Date(currentTime);

    if (Number.isNaN(readAt.getTime())) {
      throw new Error("Notification read time is invalid.");
    }

    return Notification.updateMany(
      {
        recipientUser: userId,

        status: "unread",
      },
      {
        $set: {
          status: "read",

          readAt,
        },
      },
      {
        session,
      }
    );
  }
}

module.exports = NotificationService;
