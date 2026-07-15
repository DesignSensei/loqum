// public/js/app-notices.js

"use strict";

const AppNotices = (function () {
  const notices = {
    "wallet-permission": {
      icon: "warning",
      title: "Permission required",
      text: "You do not have permission to view the billing wallet for this business.",
      confirmButtonText: "Okay",
    },

    "team-permission": {
      icon: "warning",
      title: "Permission required",
      text: "You do not have permission to manage team members for this business.",
      confirmButtonText: "Okay",
    },

    "account-updated": {
      icon: "success",
      title: "Account updated",
      text: "Your account settings have been updated successfully.",
      confirmButtonText: "Okay",
    },
  };

  const cleanNoticeFromUrl = () => {
    const url = new URL(window.location.href);

    url.searchParams.delete("notice");

    const cleanUrl = `${url.pathname}${url.search}${url.hash}`;

    window.history.replaceState({}, document.title, cleanUrl);
  };

  const showNotice = () => {
    const url = new URL(window.location.href);
    const noticeKey = url.searchParams.get("notice");

    if (!noticeKey || !notices[noticeKey]) return;

    const notice = notices[noticeKey];

    if (!window.Swal) {
      cleanNoticeFromUrl();
      return;
    }

    Swal.fire({
      icon: notice.icon,
      title: notice.title,
      text: notice.text,
      confirmButtonText: notice.confirmButtonText,
      buttonsStyling: false,
      customClass: {
        confirmButton: "btn btn-primary",
      },
    }).then(function () {
      cleanNoticeFromUrl();
    });
  };

  return {
    init: function () {
      showNotice();
    },
  };
})();
