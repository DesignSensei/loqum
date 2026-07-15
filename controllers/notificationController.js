// controllers/notificationController.js

const NotificationService = require("../services/notificationService");
const logger = require("../utils/logger");

function wantsJson(req) {
  return String(req.headers.accept || "").includes("application/json");
}

function getBackUrl(req) {
  return req.get("Referer") || "/";
}

function buildUnreadView(unreadCount) {
  const normalizedUnreadCount = Number(unreadCount || 0);

  return {
    unreadCount: normalizedUnreadCount,
    unreadCountText: normalizedUnreadCount > 9 ? "9+" : String(normalizedUnreadCount),
    unreadBadgeText: `${normalizedUnreadCount} new`,
    hasUnread: normalizedUnreadCount > 0,
  };
}

exports.markNotificationAsRead = async (req, res) => {
  try {
    const notification = await NotificationService.markNotificationAsRead({
      notificationId: req.params.notificationId,
      recipientUser: req.user._id,
    });

    const unreadCount = await NotificationService.countUnreadNotifications(req.user._id);

    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: notification ? "Notification marked as read." : "Notification not found.",
        notificationId: req.params.notificationId,
        ...buildUnreadView(unreadCount),
      });
    }

    return res.redirect(getBackUrl(req));
  } catch (error) {
    logger.error("Mark notification as read error:", error);

    if (wantsJson(req)) {
      return res.status(400).json({
        success: false,
        message: error.message || "Unable to mark notification as read.",
      });
    }

    return res.redirect(getBackUrl(req));
  }
};

exports.markAllNotificationsAsRead = async (req, res) => {
  try {
    await NotificationService.markAllUserNotificationsAsRead(req.user._id);

    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: "All notifications marked as read.",
        ...buildUnreadView(0),
      });
    }

    return res.redirect(getBackUrl(req));
  } catch (error) {
    logger.error("Mark all notifications as read error:", error);

    if (wantsJson(req)) {
      return res.status(400).json({
        success: false,
        message: error.message || "Unable to mark notifications as read.",
      });
    }

    return res.redirect(getBackUrl(req));
  }
};
