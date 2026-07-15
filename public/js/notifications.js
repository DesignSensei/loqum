// public/js/notifications.js

"use strict";

const HeaderNotifications = (function () {
  const createReadLabel = () => {
    const readLabel = document.createElement("span");

    readLabel.className = "text-muted fs-8";
    readLabel.textContent = "Read";

    return readLabel;
  };

  const setButtonLoading = (button, isLoading, loadingText = "Marking...") => {
    if (!button) return;

    if (isLoading) {
      button.dataset.originalText = button.textContent.trim();
      button.disabled = true;
      button.textContent = loadingText;
      return;
    }

    button.disabled = false;
    button.textContent = button.dataset.originalText || "Mark as read";
  };

  const postFormAsJson = async (form) => {
    const formData = new FormData(form);
    const body = new URLSearchParams(formData);

    const response = await fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.message || "Request failed.");
      error.response = data;
      throw error;
    }

    return data;
  };

  const updateUnreadView = (data) => {
    const countText = data.unreadCountText || "0";
    const badgeText = data.unreadBadgeText || "0 new";
    const hasUnread = Boolean(data.hasUnread);

    document.querySelectorAll("[data-notification-unread-count-text]").forEach((element) => {
      element.textContent = countText;
    });

    document.querySelectorAll("[data-notification-unread-badge-text]").forEach((element) => {
      element.textContent = badgeText;
    });

    document.querySelectorAll("[data-notification-icon-badge]").forEach((element) => {
      if (hasUnread) {
        element.classList.remove("d-none");
      } else {
        element.classList.add("d-none");
      }
    });

    document.querySelectorAll("[data-notifications-read-all-button]").forEach((button) => {
      if (hasUnread) {
        button.disabled = false;
        button.textContent = "Mark all as read";
        button.classList.remove("btn-light");
        button.classList.add("btn-light-primary");
      } else {
        button.disabled = true;
        button.textContent = "All caught up";
        button.classList.remove("btn-light-primary");
        button.classList.add("btn-light");
      }
    });
  };

  const markNotificationRowAsRead = (form) => {
    const row = form.closest("[data-notification-item]");
    const unreadDot = row ? row.querySelector("[data-notification-unread-dot]") : null;

    if (unreadDot) {
      unreadDot.remove();
    }

    form.replaceWith(createReadLabel());
  };

  const markAllNotificationRowsAsRead = () => {
    document.querySelectorAll("[data-notification-unread-dot]").forEach((dot) => {
      dot.remove();
    });

    document.querySelectorAll("[data-notification-read-form]").forEach((form) => {
      form.replaceWith(createReadLabel());
    });
  };

  const handleSingleNotificationRead = (form) => {
    const button = form.querySelector("[data-notification-read-button]");

    setButtonLoading(button, true, "Marking...");

    postFormAsJson(form)
      .then((data) => {
        markNotificationRowAsRead(form);
        updateUnreadView(data);
      })
      .catch(() => {
        setButtonLoading(button, false);
      });
  };

  const handleAllNotificationsRead = (form) => {
    const button = form.querySelector("[data-notifications-read-all-button]");

    setButtonLoading(button, true, "Marking...");

    postFormAsJson(form)
      .then((data) => {
        markAllNotificationRowsAsRead();
        updateUnreadView(data);
      })
      .catch(() => {
        setButtonLoading(button, false);
      });
  };

  const handleNotificationForms = () => {
    document.addEventListener("submit", function (event) {
      const singleReadForm = event.target.closest("[data-notification-read-form]");
      const readAllForm = event.target.closest("[data-notifications-read-all-form]");

      if (!singleReadForm && !readAllForm) {
        return;
      }

      event.preventDefault();

      if (singleReadForm) {
        handleSingleNotificationRead(singleReadForm);
        return;
      }

      handleAllNotificationsRead(readAllForm);
    });
  };

  return {
    init: function () {
      handleNotificationForms();
    },
  };
})();
