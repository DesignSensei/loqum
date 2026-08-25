// middleware/notificationMiddleware.js

const NotificationService = require("../services/notificationService");
const logger = require("../utils/logger");

const HEADER_NOTIFICATION_MAX_AGE_HOURS = 24;
const HEADER_NOTIFICATION_LIMIT = 15;

function isPageRequest(req) {
  if (req.method !== "GET") {
    return false;
  }

  const acceptHeader = String(req.headers.accept || "");

  return acceptHeader.includes("text/html");
}

function getHeaderNotificationCutoff() {
  const maximumAgeMs = HEADER_NOTIFICATION_MAX_AGE_HOURS * 60 * 60 * 1000;

  return new Date(Date.now() - maximumAgeMs);
}

function formatRelativeNotificationTime(date) {
  if (!date) {
    return null;
  }

  const createdAt = new Date(date);

  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  const now = new Date();

  const diffMs = Math.max(0, now.getTime() - createdAt.getTime());
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return "Just now";
  }

  if (diffMinutes < 60) {
    return diffMinutes === 1 ? "1 min ago" : `${diffMinutes} mins ago`;
  }

  if (diffHours < 24) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  }

  if (diffDays === 1) {
    return "Yesterday";
  }

  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }

  return new Intl.DateTimeFormat("en-NG", {
    month: "short",
    day: "numeric",
    year: createdAt.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(createdAt);
}

function buildHeaderNotificationItem(notification) {
  return {
    id: String(notification._id),

    category: notification.category,
    type: notification.type,

    title: notification.title,
    message: notification.message,

    status: notification.status,
    isUnread: notification.status === "unread",

    createdAt: notification.createdAt,
    createdAtDisplay: formatRelativeNotificationTime(notification.createdAt),
  };
}

function buildEmptyHeaderNotificationView() {
  return {
    items: [],

    unreadCount: 0,
    unreadCountText: "0",
    unreadBadgeText: "0 new",

    hasItems: false,
    hasUnread: false,

    title: "Notifications",

    subtitle: "Updates about shifts, invites, wallet activity, and account activity.",

    emptyTitle: "No notifications yet",

    emptyMessage: "Important updates will appear here when activity starts.",
  };
}

exports.attachNotificationLocals = async (req, res, next) => {
  res.locals.headerNotificationView = buildEmptyHeaderNotificationView();

  try {
    if (!req.user?._id) {
      return next();
    }

    if (!isPageRequest(req)) {
      return next();
    }

    const createdAfter = getHeaderNotificationCutoff();

    const [notifications, unreadCount] = await Promise.all([
      NotificationService.getUserNotifications(req.user._id, {
        limit: HEADER_NOTIFICATION_LIMIT,
        createdAfter,
      }),

      NotificationService.countUnreadNotifications(req.user._id, {
        createdAfter,
      }),
    ]);

    const items = notifications.map(buildHeaderNotificationItem);

    const normalizedUnreadCount = Math.max(0, Number(unreadCount || 0));

    res.locals.headerNotificationView = {
      ...buildEmptyHeaderNotificationView(),

      items,

      unreadCount: normalizedUnreadCount,

      unreadCountText: normalizedUnreadCount > 9 ? "9+" : String(normalizedUnreadCount),

      unreadBadgeText: `${normalizedUnreadCount} new`,

      hasItems: items.length > 0,

      hasUnread: normalizedUnreadCount > 0,
    };

    return next();
  } catch (error) {
    logger.error("Attach notification locals error:", error);

    return next();
  }
};
