// public/js/employer/shift-assignments.js

"use strict";

var EmployerShiftAssignments = (function () {
  var page = null;
  var actionModalElement = null;
  var actionModal = null;
  var actionForm = null;
  var actionTitle = null;
  var actionContext = null;
  var actionAlert = null;
  var actionNotice = null;
  var actionFields = null;
  var actionTypeInput = null;
  var actionUrlInput = null;
  var actionSubmitButton = null;
  var currentAction = null;

  /* ─────────────────────────────── HELPERS ─────────────────────────────── */

  function parseActionConfig(element) {
    if (!element) return null;

    var raw = element.getAttribute("data-action-config");

    if (!raw) return null;

    try {
      var config = JSON.parse(raw);

      return config && typeof config === "object" ? config : null;
    } catch (error) {
      return null;
    }
  }

  function getCsrfToken() {
    if (!actionForm) return null;

    var csrfInput = actionForm.querySelector('input[name="_csrf"]');

    return csrfInput ? csrfInput.value : null;
  }

  function showAlert(message) {
    if (!actionAlert) return;

    actionAlert.textContent = message || "Unable to complete this action.";

    actionAlert.classList.remove("d-none");
  }

  function hideAlert() {
    if (!actionAlert) return;

    actionAlert.textContent = "";
    actionAlert.classList.add("d-none");
  }

  function resetNoticeClasses() {
    if (!actionNotice) return;

    actionNotice.className = "notice rounded border border-dashed p-5 mb-7 d-none";
  }

  function renderNotice(notice) {
    if (!actionNotice) return;

    resetNoticeClasses();
    actionNotice.textContent = "";

    if (!notice || !notice.message) {
      return;
    }

    if (notice.noticeClass) {
      String(notice.noticeClass)
        .split(/\s+/)
        .filter(Boolean)
        .forEach(function (className) {
          actionNotice.classList.add(className);
        });
    }

    actionNotice.textContent = notice.message;

    actionNotice.classList.remove("d-none");
  }

  function createLabel(field, inputId) {
    var label = document.createElement("label");

    label.className = "form-label fw-semibold text-gray-800";

    label.setAttribute("for", inputId);

    label.textContent = field.label || field.name || "Field";

    if (field.required === true) {
      var requiredMark = document.createElement("span");

      requiredMark.className = "text-danger ms-1";

      requiredMark.textContent = "*";

      label.appendChild(requiredMark);
    }

    return label;
  }

  function createHelpText(field) {
    if (!field.helpText) {
      return null;
    }

    var help = document.createElement("div");

    help.className = "form-text text-muted";

    help.textContent = field.helpText;

    return help;
  }

  function createOptionDescriptions(field) {
    if (!Array.isArray(field.options)) {
      return null;
    }

    var describedOptions = field.options.filter(function (option) {
      return option && option.description;
    });

    if (describedOptions.length === 0) {
      return null;
    }

    var wrapper = document.createElement("div");

    wrapper.className = "mt-3 d-flex flex-column gap-2";

    describedOptions.forEach(function (option) {
      var row = document.createElement("div");

      var title = document.createElement("span");

      var description = document.createElement("span");

      row.className = "fs-8 text-muted";

      title.className = "fw-semibold text-gray-700";

      title.textContent = option.label || option.value || "Option";

      description.textContent = ": " + option.description;

      row.appendChild(title);
      row.appendChild(description);

      wrapper.appendChild(row);
    });

    return wrapper;
  }

  function createSelectField(field, inputId) {
    var select = document.createElement("select");

    select.className = "form-select form-select-solid";

    select.id = inputId;
    select.name = field.name;

    if (field.required === true) {
      select.required = true;
    }

    var placeholder = document.createElement("option");

    placeholder.value = "";

    placeholder.textContent = field.placeholder || "Select an option";

    select.appendChild(placeholder);

    (Array.isArray(field.options) ? field.options : []).forEach(function (option) {
      if (!option) return;

      var optionElement = document.createElement("option");

      optionElement.value = option.value == null ? "" : String(option.value);

      optionElement.textContent = option.label || optionElement.value;

      select.appendChild(optionElement);
    });

    return select;
  }

  function createTextareaField(field, inputId) {
    var textarea = document.createElement("textarea");

    textarea.className = "form-control form-control-solid";

    textarea.id = inputId;
    textarea.name = field.name;

    textarea.rows = Number.isSafeInteger(Number(field.rows)) ? Number(field.rows) : 4;

    if (field.placeholder) {
      textarea.placeholder = field.placeholder;
    }

    if (field.required === true) {
      textarea.required = true;
    }

    if (Number.isSafeInteger(Number(field.maxLength)) && Number(field.maxLength) > 0) {
      textarea.maxLength = Number(field.maxLength);
    }

    return textarea;
  }

  function createInputField(field, inputId) {
    var input = document.createElement("input");

    input.className = "form-control form-control-solid";

    input.id = inputId;
    input.name = field.name;
    input.type = field.type || "text";

    if (field.placeholder) {
      input.placeholder = field.placeholder;
    }

    if (field.required === true) {
      input.required = true;
    }

    if (Number.isSafeInteger(Number(field.maxLength)) && Number(field.maxLength) > 0) {
      input.maxLength = Number(field.maxLength);
    }

    if (field.value !== null && field.value !== undefined) {
      input.value = String(field.value);
    }

    if (field.valueFormat) {
      input.setAttribute("data-value-format", field.valueFormat);
    }

    return input;
  }

  function createFieldControl(field, inputId) {
    if (field.type === "select") {
      return createSelectField(field, inputId);
    }

    if (field.type === "textarea") {
      return createTextareaField(field, inputId);
    }

    return createInputField(field, inputId);
  }

  function renderFields(fields) {
    if (!actionFields) return;

    actionFields.innerHTML = "";

    (Array.isArray(fields) ? fields : []).forEach(function (field, index) {
      if (!field || !field.name) {
        return;
      }

      var row = document.createElement("div");

      var inputId = "shiftAssignmentActionField_" + index + "_" + field.name;

      var label = createLabel(field, inputId);

      var control = createFieldControl(field, inputId);

      var help = createHelpText(field);

      var optionDescriptions = createOptionDescriptions(field);

      row.className = "fv-row mb-7";

      row.appendChild(label);
      row.appendChild(control);

      if (help) {
        row.appendChild(help);
      }

      if (optionDescriptions) {
        row.appendChild(optionDescriptions);
      }

      actionFields.appendChild(row);
    });
  }

  function setSubmitButtonPresentation(action) {
    if (!actionSubmitButton) {
      return;
    }

    var modal = action && action.modal ? action.modal : {};

    var label = actionSubmitButton.querySelector(".indicator-label");

    actionSubmitButton.className = "btn " + (modal.confirmButtonClass || "btn-primary");

    if (label) {
      label.textContent = modal.confirmLabel || "Continue";
    }
  }

  function setSubmitting(submitting) {
    if (!actionSubmitButton) {
      return;
    }

    if (submitting) {
      actionSubmitButton.setAttribute("data-kt-indicator", "on");

      actionSubmitButton.disabled = true;

      return;
    }

    actionSubmitButton.removeAttribute("data-kt-indicator");

    actionSubmitButton.disabled = false;
  }

  function resetModal() {
    currentAction = null;

    hideAlert();
    resetNoticeClasses();

    if (actionNotice) {
      actionNotice.textContent = "";
    }

    if (actionFields) {
      actionFields.innerHTML = "";
    }

    if (actionTitle) {
      actionTitle.textContent = "Manage assignment";
    }

    if (actionContext) {
      actionContext.textContent = "";
    }

    if (actionTypeInput) {
      actionTypeInput.value = "";
    }

    if (actionUrlInput) {
      actionUrlInput.value = "";
    }

    if (actionSubmitButton) {
      actionSubmitButton.className = "btn btn-primary";

      var label = actionSubmitButton.querySelector(".indicator-label");

      if (label) {
        label.textContent = "Continue";
      }
    }

    setSubmitting(false);
  }

  function presentAction(action) {
    resetModal();

    if (!action || action.kind !== "modal" || !action.url) {
      showAlert("This assignment action is unavailable.");

      return;
    }

    currentAction = action;

    if (actionTitle) {
      actionTitle.textContent = action.modal?.title || action.label || "Manage assignment";
    }

    if (actionContext) {
      actionContext.textContent = action.modal?.description || "";
    }

    if (actionTypeInput) {
      actionTypeInput.value = action.key || "";
    }

    if (actionUrlInput) {
      actionUrlInput.value = action.url;
    }

    renderNotice(action.modal?.notice || null);

    renderFields(action.modal?.fields || []);

    setSubmitButtonPresentation(action);
  }

  function normalizeFieldValue(control) {
    if (!control) return null;

    var value = String(control.value || "").trim();

    if (!value) {
      return null;
    }

    if (control.getAttribute("data-value-format") === "iso_datetime") {
      var date = new Date(value);

      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }

    return value;
  }

  function validateRequiredFields() {
    if (!actionFields) {
      return true;
    }

    var requiredControls = actionFields.querySelectorAll("[name][required]");

    for (var index = 0; index < requiredControls.length; index += 1) {
      var control = requiredControls[index];

      var value = String(control.value || "").trim();

      if (!value) {
        control.focus();

        showAlert("Please complete all required fields.");

        return false;
      }
    }

    return true;
  }

  function buildPayload() {
    var payload = {};

    var csrfToken = getCsrfToken();

    if (csrfToken) {
      payload._csrf = csrfToken;
    }

    if (!actionFields) {
      return payload;
    }

    actionFields.querySelectorAll("[name]").forEach(function (control) {
      var value = normalizeFieldValue(control);

      if (value !== null) {
        payload[control.name] = value;
      }
    });

    return payload;
  }

  function getRequestMethod(action) {
    return (
      String(action?.method || "POST")
        .trim()
        .toLowerCase() || "post"
    );
  }

  function closeModal() {
    if (actionModal) {
      actionModal.hide();
    }
  }

  function showSuccess(message) {
    return Swal.fire({
      text: message || "The assignment action was completed successfully.",

      icon: "success",

      buttonsStyling: false,

      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function showRequestError(error) {
    var message =
      error?.response?.data?.message ||
      "The assignment action could not be completed. Please try again.";

    showAlert(message);

    Swal.fire({
      text: message,

      icon: "error",

      buttonsStyling: false,

      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  /* ─────────────────────────────── ACTION SUBMISSION ─────────────────────────────── */

  function submitCurrentAction() {
    if (!currentAction || !currentAction.url) {
      showAlert("This assignment action is unavailable.");

      return;
    }

    hideAlert();

    if (!validateRequiredFields()) {
      return;
    }

    setSubmitting(true);

    axios({
      method: getRequestMethod(currentAction),

      url: currentAction.url,

      data: buildPayload(),
    })
      .then(function (response) {
        closeModal();

        showSuccess(response.data?.message).then(function () {
          window.location.reload();
        });
      })
      .catch(function (error) {
        setSubmitting(false);

        showRequestError(error);
      });
  }

  /* ─────────────────────────────── EVENTS ─────────────────────────────── */

  function bindActionTriggers() {
    if (!page) return;

    page.addEventListener("click", function (event) {
      var trigger = event.target.closest(".js-assignment-action-trigger");

      if (!trigger || !page.contains(trigger)) {
        return;
      }

      var action = parseActionConfig(trigger);

      if (!action) {
        event.preventDefault();

        Swal.fire({
          text: "This assignment action could not be loaded. Refresh the page and try again.",

          icon: "error",

          buttonsStyling: false,

          confirmButtonText: "Ok, got it!",

          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        return;
      }

      presentAction(action);
    });
  }

  function bindFormSubmission() {
    if (!actionForm) return;

    actionForm.addEventListener("submit", function (event) {
      event.preventDefault();

      submitCurrentAction();
    });
  }

  function bindModalReset() {
    if (!actionModalElement) {
      return;
    }

    actionModalElement.addEventListener("hidden.bs.modal", function () {
      resetModal();
    });
  }

  /* ─────────────────────────────── INITIALIZATION ─────────────────────────────── */

  function initializeElements() {
    page = document.querySelector("#shiftAssignmentsPage");

    actionModalElement = document.querySelector("#shiftAssignmentActionModal");

    actionForm = document.querySelector("#shiftAssignmentActionForm");

    actionTitle = document.querySelector("#shiftAssignmentActionModalLabel");

    actionContext = document.querySelector("#shiftAssignmentActionContext");

    actionAlert = document.querySelector("#shiftAssignmentActionAlert");

    actionNotice = document.querySelector("#shiftAssignmentActionNotice");

    actionFields = document.querySelector("#shiftAssignmentActionFields");

    actionTypeInput = document.querySelector("#shiftAssignmentActionType");

    actionUrlInput = document.querySelector("#shiftAssignmentActionUrl");

    actionSubmitButton = document.querySelector("#shiftAssignmentActionSubmit");

    if (actionModalElement && typeof bootstrap !== "undefined" && bootstrap.Modal) {
      actionModal = bootstrap.Modal.getOrCreateInstance(actionModalElement);
    }
  }

  function initAssignmentActions() {
    initializeElements();

    if (!page) return;

    bindActionTriggers();
    bindFormSubmission();
    bindModalReset();
  }

  return {
    init: function () {
      initAssignmentActions();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerShiftAssignments.init();
});
