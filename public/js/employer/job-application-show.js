"use strict";

// public/js/employer/job-application-show.js

var EmployerJobApplicationShow = (function () {
  var ACTION_ROUTES = {
    under_review: {
      status: "under_review",
      suffix: "under-review",
    },
    shortlisted: {
      status: "shortlisted",
      suffix: "shortlist",
    },
    interview: {
      status: "interview",
      suffix: "interview",
    },
    offered: {
      status: "offered",
      suffix: "offer",
    },
    rejected: {
      status: "rejected",
      suffix: "reject",
    },
    hired: {
      status: "hired",
      suffix: "hire",
    },
  };

  var ALLOWED_FIELDS = ["reason", "reasonDetails", "statusNote", "employerPrivateNote"];

  function initialize() {
    var page = document.getElementById("jobApplicationDetailPage");

    if (!page || page.dataset.initialized === "true") {
      return;
    }

    var modal = document.getElementById("jobApplicationActionModal");
    var form = document.getElementById("jobApplicationActionForm");

    var triggers = Array.from(page.querySelectorAll(".js-job-application-action-trigger"));

    if (!triggers.length) {
      page.dataset.initialized = "true";
      return;
    }

    var feedback = document.getElementById("job-application-feedback");

    var fieldsContainer = document.getElementById("jobApplicationActionFields");

    var modalAlert = document.getElementById("jobApplicationActionAlert");

    var modalNotice = document.getElementById("jobApplicationActionNotice");

    var modalTitle = document.getElementById("jobApplicationActionModalLabel");

    var actionTypeInput = document.getElementById("jobApplicationActionType");

    var actionUrlInput = document.getElementById("jobApplicationActionUrl");

    var submitButton = document.getElementById("jobApplicationActionSubmit");

    var csrfInput = form?.querySelector('input[name="_csrf"]');

    function showPageMessage(message, type) {
      if (!feedback) {
        return;
      }

      feedback.className = "alert alert-" + (type || "info") + " mb-0";
      feedback.textContent = message;
      feedback.hidden = false;
    }

    function showModalError(message) {
      if (!modalAlert) {
        showPageMessage(message, "danger");
        return;
      }

      modalAlert.textContent = message;
      modalAlert.classList.remove("d-none");
    }

    function clearModalError() {
      if (!modalAlert) {
        return;
      }

      modalAlert.textContent = "";
      modalAlert.classList.add("d-none");
    }

    if (
      !modal ||
      !form ||
      !fieldsContainer ||
      !modalTitle ||
      !modalNotice ||
      !actionTypeInput ||
      !actionUrlInput ||
      !submitButton ||
      !csrfInput?.value ||
      typeof window.axios === "undefined" ||
      typeof window.bootstrap === "undefined" ||
      !window.bootstrap.Modal
    ) {
      showPageMessage(
        "Recruitment actions are temporarily unavailable. Please refresh the page or contact support.",
        "warning"
      );

      return;
    }

    var csrfToken = csrfInput.value;
    var busy = false;
    var locked = false;
    var activeAction = null;

    var indicatorLabel = submitButton.querySelector(".indicator-label");

    var applicationPath = window.location.pathname.match(
      /^\/employer\/job-applications\/([a-f0-9]{24})\/?$/i
    );

    function isValidAction(action) {
      if (!action || typeof action !== "object") {
        return false;
      }

      var route = ACTION_ROUTES[action.key];

      if (!route || !applicationPath) {
        return false;
      }

      if (action.method !== "POST" || action.targetStatus !== route.status) {
        return false;
      }

      var expectedUrl = "/employer/job-applications/" + applicationPath[1] + "/" + route.suffix;

      return (
        typeof action.url === "string" &&
        action.url === expectedUrl &&
        Array.isArray(action.fields) &&
        action.fields.every(function (field) {
          return field && typeof field.name === "string" && ALLOWED_FIELDS.includes(field.name);
        })
      );
    }

    function setBusy(value) {
      busy = value;

      page.setAttribute("aria-busy", String(busy));

      triggers.forEach(function (trigger) {
        trigger.disabled = busy || locked;
      });

      if (busy) {
        submitButton.disabled = true;
        submitButton.setAttribute("data-kt-indicator", "on");
      } else {
        submitButton.removeAttribute("data-kt-indicator");
        updateSubmitState();
      }
    }

    function resetModal() {
      if (busy) {
        return;
      }

      activeAction = null;

      form.reset();
      fieldsContainer.replaceChildren();

      clearModalError();

      modalNotice.textContent = "";
      modalNotice.className = "notice rounded border border-dashed p-5 mb-6 d-none";

      modalTitle.textContent = "Manage Application";

      actionTypeInput.value = "";
      actionUrlInput.value = "";

      submitButton.className = "btn btn-primary";
      submitButton.disabled = true;

      submitButton.removeAttribute("data-kt-indicator");

      if (indicatorLabel) {
        indicatorLabel.textContent = "Confirm Action";
      }
    }

    function createField(field) {
      var wrapper = document.createElement("div");

      wrapper.className = "mb-5";

      var label = document.createElement("label");

      label.className = "form-label fw-semibold";
      label.textContent = field.label || field.name;

      var inputId = "jobApplicationField-" + field.name;

      label.setAttribute("for", inputId);

      var input;

      /*
       * The employer rejection-reason enum is not exposed by
       * the current view service.
       *
       * "other" is supported by the application service and
       * requires explanatory details. Do not invent additional
       * rejection reason codes in the browser.
       */
      if (field.name === "reason") {
        input = document.createElement("select");

        input.className = "form-select";
        input.required = true;

        var option = document.createElement("option");

        option.value = "other";
        option.textContent = "Other (specify reason)";

        input.appendChild(option);
      } else if (field.type === "textarea") {
        input = document.createElement("textarea");

        input.className = "form-control";
        input.rows = Number(field.rows) > 0 ? Math.min(Number(field.rows), 8) : 3;

        input.required = field.required === true;
      } else {
        input = document.createElement("input");

        input.type = "text";
        input.className = "form-control";
        input.required = field.required === true;
      }

      input.id = inputId;
      input.name = field.name;

      if (field.name === "reasonDetails") {
        input.required = true;
        input.placeholder = "Explain why this application is being rejected";
      }

      if (field.name === "statusNote") {
        input.placeholder = "Add an optional note about this decision";
      }

      if (field.name === "employerPrivateNote") {
        input.placeholder = "Add an optional private employer note";
      }

      wrapper.appendChild(label);
      wrapper.appendChild(input);

      if (field.helpText) {
        var help = document.createElement("div");

        help.className = "form-text mt-2";
        help.textContent = field.helpText;

        wrapper.appendChild(help);
      }

      if (field.name === "employerPrivateNote") {
        var privateNoteHelp = document.createElement("div");

        privateNoteHelp.className = "form-text mt-2";
        privateNoteHelp.textContent = "Leave blank to retain the existing private note.";

        wrapper.appendChild(privateNoteHelp);
      }

      return wrapper;
    }

    function createHiringAcknowledgement() {
      var wrapper = document.createElement("div");

      wrapper.className = "border border-dashed border-warning bg-light-warning rounded p-5 mt-4";

      var label = document.createElement("label");

      label.className = "form-check form-check-custom form-check-solid align-items-start";

      var input = document.createElement("input");

      input.type = "checkbox";
      input.name = "confirmHiringConsequences";
      input.value = "yes";
      input.required = true;
      input.className = "form-check-input";

      var text = document.createElement("span");

      text.className = "form-check-label text-gray-800";

      text.textContent =
        "I understand that hiring this applicant may fill the final vacancy, " +
        "close recruitment, and reject remaining open applications.";

      label.appendChild(input);
      label.appendChild(text);

      wrapper.appendChild(label);

      return wrapper;
    }

    function updateSubmitState() {
      if (busy || locked || !activeAction) {
        submitButton.disabled = true;
        return;
      }

      submitButton.disabled = !form.checkValidity();
    }

    function openAction(action) {
      resetModal();

      activeAction = action;

      actionTypeInput.value = action.key;
      actionUrlInput.value = action.url;

      modalTitle.textContent = action.modalTitle || action.label || "Manage Application";

      submitButton.className =
        "btn " +
        (["btn-primary", "btn-info", "btn-success", "btn-danger"].includes(
          action.confirmButtonClass
        )
          ? action.confirmButtonClass
          : "btn-primary");

      if (indicatorLabel) {
        indicatorLabel.textContent = action.confirmLabel || "Confirm Action";
      }

      action.fields.forEach(function (field) {
        fieldsContainer.appendChild(createField(field));
      });

      if (action.notice?.message) {
        modalNotice.textContent = action.notice.message;

        modalNotice.className = "notice rounded border border-dashed p-5 mb-6";

        if (action.key === "hired") {
          modalNotice.classList.add("bg-light-warning", "border-warning");
        }
      }

      if (action.key === "hired") {
        fieldsContainer.appendChild(createHiringAcknowledgement());
      }

      updateSubmitState();
    }

    function buildPayload() {
      var payload = {
        _csrf: csrfToken,
      };

      activeAction.fields.forEach(function (field) {
        var input = fieldsContainer.querySelector('[name="' + field.name + '"]');

        if (!input) {
          return;
        }

        var value = String(input.value || "").trim();

        /*
         * Omitting an empty private note preserves the existing
         * stored note. Sending an empty string would clear it.
         */
        if (!value && !field.required) {
          return;
        }

        payload[field.name] = value;
      });

      return payload;
    }

    function getErrorMessage(error) {
      if (error?.response?.data?.message) {
        return error.response.data.message;
      }

      if (error?.serverMessage) {
        return error.serverMessage;
      }

      return "The recruitment action could not be completed. Please try again.";
    }

    /*
     * Install all event handlers before enabling the buttons.
     */
    modal.addEventListener("show.bs.modal", function (event) {
      if (busy || locked) {
        event.preventDefault();
        return;
      }

      var trigger = event.relatedTarget;

      if (!trigger || !trigger.matches(".js-job-application-action-trigger")) {
        event.preventDefault();
        return;
      }

      var action;

      try {
        action = JSON.parse(trigger.getAttribute("data-action-config") || "");
      } catch (error) {
        event.preventDefault();

        showPageMessage(
          "This recruitment action could not be prepared. Please refresh the page.",
          "warning"
        );

        return;
      }

      if (!isValidAction(action)) {
        event.preventDefault();

        showPageMessage(
          "This recruitment action is unavailable. Please refresh the page.",
          "warning"
        );

        return;
      }

      openAction(action);
    });

    modal.addEventListener("hide.bs.modal", function (event) {
      if (busy) {
        event.preventDefault();
      }
    });

    modal.addEventListener("hidden.bs.modal", function () {
      if (!busy) {
        resetModal();
      }
    });

    form.addEventListener("input", updateSubmitState);
    form.addEventListener("change", updateSubmitState);

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (busy || locked || !activeAction) {
        return;
      }

      if (!isValidAction(activeAction)) {
        showModalError("This recruitment action is no longer valid. Refresh the page.");

        return;
      }

      if (!form.reportValidity()) {
        updateSubmitState();
        return;
      }

      var actionUrl = activeAction.url;
      var actionLabel = activeAction.confirmLabel || activeAction.label || "Recruitment action";

      var payload = buildPayload();

      clearModalError();
      setBusy(true);

      try {
        var response = await axios.post(actionUrl, payload, {
          headers: {
            Accept: "application/json",
            "CSRF-Token": csrfToken,
          },
          validateStatus: function () {
            return true;
          },
        });

        if (response.status < 200 || response.status >= 300 || response.data?.success !== true) {
          var requestError = new Error("Recruitment action was not confirmed.");

          requestError.status = response.status;
          requestError.serverMessage = response.data?.message || null;

          throw requestError;
        }

        /*
         * Do not update the status locally.
         *
         * The server owns the authoritative application state,
         * vacancy capacity and publication finalization.
         */
        locked = true;

        showPageMessage(
          actionLabel + " completed successfully. Refreshing application...",
          "success"
        );

        window.location.reload();
      } catch (error) {
        var message = getErrorMessage(error);

        var status = Number(error?.status) || Number(error?.response?.status) || 0;

        /*
         * A network failure, server error, authorization change
         * or state conflict requires a fresh server read before
         * another recruitment decision is attempted.
         *
         * In particular, never automatically retry a hire action.
         */
        if (!status || status === 401 || status === 403 || status === 409 || status >= 500) {
          locked = true;

          message += " Refresh this application to verify its current status before trying again.";

          showPageMessage(message, "warning");
        }

        showModalError(message);
      } finally {
        setBusy(false);
      }
    });

    /*
     * The EJS deliberately renders management buttons disabled.
     * Only enable them after initialization is complete.
     */
    page.dataset.initialized = "true";

    triggers.forEach(function (trigger) {
      trigger.disabled = false;
    });

    submitButton.disabled = true;
  }

  return {
    init: initialize,
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerJobApplicationShow.init();
});
