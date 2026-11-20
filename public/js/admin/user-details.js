// public/js/admin/user-details.js

"use strict";

var AdminUserDetails = (function () {
  var root = null;
  var elements = {};

  var csrfToken = "";
  var role = "";
  var profileId = "";

  var state = {
    initialized: false,
    actionPending: false,
    actionsReady: false,
  };

  // ───────── Elements ─────────

  function initializeElements() {
    elements = {
      feedback: root.querySelector("#adminUserDetailsFeedback"),
      verificationFeedback: root.querySelector("#adminUserVerificationFeedback"),
      overviewTab: root.querySelector("#adminUserTab-overview"),
      verificationTab: root.querySelector("#adminUserTab-verification"),
      cacRecheckButton: root.querySelector("#adminUserCACRecheck"),
    };
  }

  // ───────── Response helpers ─────────

  function getErrorMessage(error, fallback) {
    var responseMessage =
      error && error.response && error.response.data && error.response.data.message;

    if (typeof responseMessage === "string" && responseMessage.trim()) {
      return responseMessage.trim();
    }

    if (
      error &&
      typeof error.message === "string" &&
      error.message.trim() &&
      error.message !== "Network Error"
    ) {
      return error.message.trim();
    }

    return fallback;
  }

  function getResponseMessage(response, fallback) {
    var message = response && response.data && response.data.message;

    return typeof message === "string" && message.trim() ? message.trim() : fallback;
  }

  function assertSuccessfulResponse(response, fallback) {
    if (!response || !response.data || response.data.success !== true) {
      throw new Error(getResponseMessage(response, fallback));
    }

    return response;
  }

  // ───────── UI helpers ─────────

  function setIndicator(button, loading) {
    if (!button) {
      return;
    }

    if (loading) {
      button.setAttribute("data-kt-indicator", "on");
    } else {
      button.removeAttribute("data-kt-indicator");
    }
  }

  function setActionPending(pending) {
    state.actionPending = Boolean(pending);

    var button = elements.cacRecheckButton;

    if (!button) {
      return;
    }

    button.disabled = !state.actionsReady || state.actionPending;

    setIndicator(button, state.actionPending);
  }

  function showFeedback(message, type) {
    var feedback = elements.verificationFeedback || elements.feedback;

    if (!feedback) {
      return;
    }

    feedback.className = "alert alert-" + (type || "danger") + " mb-6";

    feedback.textContent = message;
    feedback.classList.remove("d-none");
  }

  function clearFeedback() {
    [elements.feedback, elements.verificationFeedback].forEach(function (feedback) {
      if (!feedback) {
        return;
      }

      feedback.textContent = "";
      feedback.classList.add("d-none");
    });
  }

  function showActionError(error, fallback) {
    var message = getErrorMessage(error, fallback);

    showFeedback(message, "danger");

    return Swal.fire({
      icon: "error",
      title: "Action Unsuccessful",
      text: message,
      confirmButtonText: "OK",
      buttonsStyling: false,
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function confirmAction(options) {
    return Swal.fire({
      icon: options.icon || "question",
      title: options.title,
      text: options.text,

      showCancelButton: true,
      confirmButtonText: options.confirmButtonText || "Confirm",
      cancelButtonText: "Cancel",

      reverseButtons: true,
      focusCancel: true,

      buttonsStyling: false,
      customClass: {
        confirmButton: options.confirmButtonClass || "btn btn-primary",
        cancelButton: "btn btn-light me-3",
      },
    });
  }

  // ───────── API helper ─────────

  function apiPost(url, payload) {
    return axios.post(url, payload || {}, {
      headers: {
        "CSRF-Token": csrfToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      withCredentials: true,
    });
  }

  // ───────── Tab management ─────────

  function updateTabHash(hash) {
    if (window.location.hash === hash) {
      return;
    }

    window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
  }

  function attachTabEvents() {
    if (elements.overviewTab) {
      elements.overviewTab.addEventListener("shown.bs.tab", function () {
        updateTabHash("#overview");
      });
    }

    if (elements.verificationTab) {
      elements.verificationTab.addEventListener("shown.bs.tab", function () {
        updateTabHash("#verification");
      });
    }
  }

  function activateTabFromUrl() {
    if (window.location.hash !== "#verification" || !elements.verificationTab) {
      return;
    }

    if (typeof bootstrap !== "undefined" && bootstrap.Tab) {
      bootstrap.Tab.getOrCreateInstance(elements.verificationTab).show();

      return;
    }

    elements.verificationTab.click();
  }

  function refreshVerificationPage() {
    updateTabHash("#verification");
    window.location.reload();
  }

  // ───────── CAC verification ─────────

  // Action configuration comes from the server-rendered button.
  function getCACActionConfig() {
    var button = elements.cacRecheckButton;

    if (!button) {
      return null;
    }

    return {
      url: button.dataset.actionUrl || "",
      method: (button.dataset.actionMethod || "").toUpperCase(),

      confirmationTitle: button.dataset.confirmTitle || "Recheck CAC Registration?",

      confirmationText:
        button.dataset.confirmText || "Run a new CAC registration verification check?",
    };
  }

  function handleCACRecheck() {
    if (!state.actionsReady || state.actionPending || !elements.cacRecheckButton) {
      return;
    }

    var action = getCACActionConfig();

    if (!action || !action.url || action.method !== "POST") {
      showFeedback("The CAC verification endpoint is not configured correctly.", "danger");

      return;
    }

    clearFeedback();

    confirmAction({
      title: action.confirmationTitle,
      text: action.confirmationText,
      confirmButtonText: "Recheck CAC",
    }).then(function (result) {
      if (!result.isConfirmed || state.actionPending) {
        return;
      }

      setActionPending(true);

      apiPost(action.url, {})
        .then(function (response) {
          return assertSuccessfulResponse(
            response,
            "The CAC verification request could not be completed."
          );
        })
        .then(function (response) {
          var resultData = response.data.data || {};

          var message = getResponseMessage(
            response,
            "The CAC verification request has been processed."
          );

          // Staging checks do not grant production verification.
          if (resultData.environment === "staging") {
            message += " This was a staging check. " + "It does not grant production verification.";
          }

          return Swal.fire({
            icon: "info",
            title: "CAC Check Processed",
            text: message,
            confirmButtonText: "View Updated Record",
            buttonsStyling: false,
            customClass: {
              confirmButton: "btn btn-primary",
            },
          }).then(function () {
            refreshVerificationPage();
          });
        })
        .catch(function (error) {
          return showActionError(error, "Unable to recheck CAC registration. Please try again.");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────── Initialization ─────────

  function initializeActions() {
    // Professional details remain read-only here.
    if (role !== "employer" || !profileId || !elements.cacRecheckButton) {
      return;
    }

    if (typeof axios === "undefined" || typeof Swal === "undefined") {
      showFeedback("Verification controls are unavailable. Please refresh the page.", "warning");

      return;
    }

    if (!csrfToken) {
      showFeedback(
        "The security token is missing. Refresh the page before rechecking CAC.",
        "warning"
      );

      return;
    }

    var action = getCACActionConfig();

    if (!action || !action.url || action.method !== "POST") {
      showFeedback("The CAC verification endpoint is not configured correctly.", "danger");

      return;
    }

    elements.cacRecheckButton.addEventListener("click", handleCACRecheck);

    state.actionsReady = true;

    // Enable the button only after initialization succeeds.
    setActionPending(false);
  }

  return {
    init: function () {
      if (state.initialized) {
        return;
      }

      root = document.querySelector("#adminUserDetails");

      if (!root) {
        return;
      }

      state.initialized = true;

      initializeElements();

      csrfToken = root.dataset.csrfToken || "";
      role = root.dataset.role || "";
      profileId = root.dataset.profileId || "";

      attachTabEvents();
      activateTabFromUrl();

      initializeActions();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminUserDetails.init();
});
