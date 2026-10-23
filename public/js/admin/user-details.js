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

  // ───────────────────────── ELEMENTS ─────────────────────────

  function initializeElements() {
    elements = {
      feedback: root.querySelector("#adminUserDetailsFeedback"),

      verificationFeedback: root.querySelector("#adminUserVerificationFeedback"),

      overviewTab: root.querySelector("#adminUserTab-overview"),

      verificationTab: root.querySelector("#adminUserTab-verification"),

      cacRecheckButton: root.querySelector("#adminUserCACRecheck"),

      pcnReviewForm: root.querySelector("#adminUserPCNReviewForm"),

      pcnDecision: root.querySelector("#adminUserPCNDecision"),

      pcnRegisteredName: root.querySelector("#adminUserPCNRegisteredName"),

      pcnReviewNote: root.querySelector("#adminUserPCNReviewNote"),

      pcnSubmitButton: root.querySelector("#adminUserPCNSubmit"),
    };
  }

  // ───────────────────────── RESPONSE HELPERS ─────────────────────────

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

  function isSuccessfulResponse(response) {
    return Boolean(response && response.data && response.data.success === true);
  }

  function assertSuccessfulResponse(response, fallback) {
    if (!isSuccessfulResponse(response)) {
      throw new Error(getResponseMessage(response, fallback));
    }

    return response;
  }

  // ───────────────────────── UI HELPERS ─────────────────────────

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

  function setActionPending(pending, activeButton) {
    state.actionPending = Boolean(pending);

    var disabled = !state.actionsReady || state.actionPending;

    if (elements.cacRecheckButton) {
      elements.cacRecheckButton.disabled = disabled;

      setIndicator(
        elements.cacRecheckButton,
        state.actionPending && activeButton === elements.cacRecheckButton
      );
    }

    if (elements.pcnSubmitButton) {
      elements.pcnSubmitButton.disabled = disabled;

      setIndicator(
        elements.pcnSubmitButton,
        state.actionPending && activeButton === elements.pcnSubmitButton
      );
    }

    if (elements.pcnDecision) {
      elements.pcnDecision.disabled = disabled;
    }

    if (elements.pcnRegisteredName) {
      elements.pcnRegisteredName.disabled = disabled;
    }

    if (elements.pcnReviewNote) {
      elements.pcnReviewNote.disabled = disabled;
    }
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

  // ───────────────────────── API HELPER ─────────────────────────

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

  // ───────────────────────── TAB MANAGEMENT ─────────────────────────

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

  // ───────────────────────── CAC VERIFICATION ─────────────────────────

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

    var button = elements.cacRecheckButton;
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

      setActionPending(true, button);

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

  // ───────────────────────── PCN REVIEW ─────────────────────────

  function getPCNReviewValues() {
    return {
      decision: elements.pcnDecision ? elements.pcnDecision.value.trim() : "",

      nameOnRecord: elements.pcnRegisteredName ? elements.pcnRegisteredName.value.trim() : "",

      note: elements.pcnReviewNote ? elements.pcnReviewNote.value.trim() : "",
    };
  }

  function validatePCNReview(values) {
    var validDecisions = ["verified", "needs_review", "rejected"];

    if (!validDecisions.includes(values.decision)) {
      return "Select a valid PCN review decision.";
    }

    if (values.decision === "verified" && !values.nameOnRecord) {
      return (
        "Enter the name shown on the official " +
        "PCN record before marking the premises " +
        "as verified."
      );
    }

    if (values.nameOnRecord.length > 150) {
      return "The registered name cannot exceed " + "150 characters.";
    }

    if (values.note.length < 10) {
      return "Enter a review note containing at least " + "10 characters.";
    }

    if (values.note.length > 500) {
      return "The review note cannot exceed " + "500 characters.";
    }

    return null;
  }

  function getPCNConfirmationOptions(decision) {
    if (decision === "verified") {
      return {
        icon: "question",
        title: "Confirm PCN Verification?",
        text:
          "Confirm that you independently checked " +
          "the official PCN premises register and " +
          "that the submitted registration details " +
          "match the record.",
        confirmButtonText: "Confirm Verification",
      };
    }

    if (decision === "rejected") {
      return {
        icon: "warning",
        title: "Reject PCN Verification?",
        text:
          "This records a rejected regulatory " +
          "verification decision and may revoke " +
          "existing employer approval. Confirm " +
          "that your findings support this decision.",
        confirmButtonText: "Reject Verification",
        confirmButtonClass: "btn btn-danger",
      };
    }

    return {
      icon: "warning",
      title: "Mark PCN as Needs Review?",
      text:
        "This flags the employer's regulatory " +
        "registration for further review and " +
        "may revoke existing employer approval.",
      confirmButtonText: "Mark as Needs Review",
    };
  }

  function handlePCNReview(event) {
    event.preventDefault();

    if (!state.actionsReady || state.actionPending || !elements.pcnReviewForm) {
      return;
    }

    var form = elements.pcnReviewForm;

    var url = form.dataset.reviewUrl || "";

    var method = (form.dataset.reviewMethod || "").toUpperCase();

    if (!url || method !== "POST") {
      showFeedback("The PCN review endpoint is not configured correctly.", "danger");

      return;
    }

    var values = getPCNReviewValues();

    var validationError = validatePCNReview(values);

    if (validationError) {
      showFeedback(validationError, "warning");

      Swal.fire({
        icon: "warning",
        title: "Review Information Required",
        text: validationError,
        confirmButtonText: "OK",
      });

      return;
    }

    clearFeedback();

    confirmAction(getPCNConfirmationOptions(values.decision)).then(function (result) {
      if (!result.isConfirmed || state.actionPending) {
        return;
      }

      setActionPending(true, elements.pcnSubmitButton);

      // Exact backend payload:
      // decision, nameOnRecord, note.
      apiPost(url, {
        decision: values.decision,
        nameOnRecord: values.nameOnRecord,
        note: values.note,
      })
        .then(function (response) {
          return assertSuccessfulResponse(response, "The PCN review could not be saved.");
        })
        .then(function (response) {
          return Swal.fire({
            icon: "success",
            title: "PCN Review Recorded",
            text: getResponseMessage(
              response,
              "The regulatory verification review has been recorded."
            ),
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
          return showActionError(error, "Unable to save the PCN review. Please try again.");
        })
        .finally(function () {
          setActionPending(false);
        });
    });
  }

  // ───────────────────────── INITIALIZATION VALIDATION ─────────────────────────

  function hasValidActionEndpoints() {
    if (elements.cacRecheckButton) {
      var cacAction = getCACActionConfig();

      if (!cacAction || !cacAction.url || cacAction.method !== "POST") {
        return false;
      }
    }

    if (elements.pcnReviewForm) {
      var form = elements.pcnReviewForm;

      if (!form.dataset.reviewUrl || (form.dataset.reviewMethod || "").toUpperCase() !== "POST") {
        return false;
      }

      if (
        !elements.pcnDecision ||
        !elements.pcnRegisteredName ||
        !elements.pcnReviewNote ||
        !elements.pcnSubmitButton
      ) {
        return false;
      }
    }

    return true;
  }

  // ───────────────────────── EVENTS ─────────────────────────

  function attachActionEvents() {
    if (elements.cacRecheckButton) {
      elements.cacRecheckButton.addEventListener("click", handleCACRecheck);
    }

    if (elements.pcnReviewForm) {
      elements.pcnReviewForm.addEventListener("submit", handlePCNReview);
    }
  }

  // ───────────────────────── INITIALIZATION ─────────────────────────

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

      // Tab events are registered exactly once.
      attachTabEvents();
      activateTabFromUrl();

      // Professional verification remains read-only.
      if (role !== "employer" || !profileId) {
        return;
      }

      var hasMutationControls = Boolean(elements.cacRecheckButton || elements.pcnReviewForm);

      if (!hasMutationControls) {
        return;
      }

      if (typeof axios === "undefined" || typeof Swal === "undefined") {
        showFeedback("Verification controls are unavailable. Please refresh the page.", "warning");

        return;
      }

      if (!csrfToken) {
        showFeedback(
          "The security token is missing. Refresh the page before recording a verification decision.",
          "warning"
        );

        return;
      }

      if (!hasValidActionEndpoints()) {
        showFeedback("The verification endpoints are not configured correctly.", "danger");

        return;
      }

      attachActionEvents();

      state.actionsReady = true;

      // Buttons were disabled by EJS.
      // Enable only after initialization succeeds.
      setActionPending(false);
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AdminUserDetails.init();
});
