// public/js/employer/shift-applications.js

"use strict";

var EmployerShiftApplications = (function () {
  var page = null;

  var actionModal = null;
  var actionForm = null;
  var actionAlert = null;
  var actionModalTitle = null;
  var actionModalContext = null;
  var actionTypeInput = null;
  var actionUrlInput = null;
  var actionFieldsContainer = null;
  var actionNotice = null;
  var actionSubmitButton = null;

  var currentAction = null;

  /* ---------- Parse application action config ---------- */

  function parseActionConfig(trigger) {
    if (!trigger) return null;

    var serializedAction = trigger.getAttribute("data-action-config");

    if (!serializedAction) return null;

    try {
      return JSON.parse(serializedAction);
    } catch (error) {
      console.error("Unable to parse Shift application action configuration.", error);

      return null;
    }
  }

  /* ---------- Reset action alert ---------- */

  function resetActionAlert() {
    if (!actionAlert) return;

    actionAlert.classList.add("d-none");
    actionAlert.textContent = "";
  }

  /* ---------- Show action alert ---------- */

  function showActionAlert(message) {
    if (!actionAlert) return;

    actionAlert.textContent = message || "The application action could not be completed.";

    actionAlert.classList.remove("d-none");
  }

  /* ---------- Reset action notice ---------- */

  function resetActionNotice() {
    if (!actionNotice) return;

    actionNotice.className = "notice rounded border border-dashed p-5 mb-7 d-none";

    actionNotice.textContent = "";
  }

  /* ---------- Render action notice ---------- */

  function renderActionNotice(notice) {
    resetActionNotice();

    if (!actionNotice || !notice || !notice.message) return;

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

  /* ---------- Clear action fields ---------- */

  function clearActionFields() {
    if (!actionFieldsContainer) return;

    actionFieldsContainer.innerHTML = "";
  }

  /* ---------- Build one action field ---------- */

  function buildActionField(field) {
    if (!field || !field.key || !field.name || !field.label) {
      return null;
    }

    var wrapper = document.createElement("div");

    wrapper.className = "mb-7 fv-row";

    var fieldId = "shiftApplicationField_" + field.key;

    var label = document.createElement("label");

    label.className = "form-label fw-semibold";
    label.setAttribute("for", fieldId);
    label.textContent = field.label;

    wrapper.appendChild(label);

    var input = null;

    if (field.type === "textarea") {
      input = document.createElement("textarea");

      input.rows =
        Number.isSafeInteger(Number(field.rows)) && Number(field.rows) > 0 ? Number(field.rows) : 3;
    } else {
      input = document.createElement("input");

      input.type = field.type || "text";
    }

    input.className = "form-control";
    input.id = fieldId;
    input.name = field.name;
    input.required = field.required === true;
    input.value = field.value || "";

    if (field.placeholder) {
      input.setAttribute("placeholder", field.placeholder);
    }

    wrapper.appendChild(input);

    if (field.helpText) {
      var helpText = document.createElement("div");

      helpText.className = "form-text";
      helpText.textContent = field.helpText;

      wrapper.appendChild(helpText);
    }

    return wrapper;
  }

  /* ---------- Render action fields ---------- */

  function renderActionFields(fields) {
    clearActionFields();

    if (!actionFieldsContainer || !Array.isArray(fields)) return;

    fields.forEach(function (field) {
      var fieldElement = buildActionField(field);

      if (!fieldElement) return;

      actionFieldsContainer.appendChild(fieldElement);
    });
  }

  /* ---------- Set action submit state ---------- */

  function setActionSubmitting(isSubmitting) {
    if (!actionSubmitButton) return;

    actionSubmitButton.disabled = isSubmitting;

    if (isSubmitting) {
      actionSubmitButton.setAttribute("data-kt-indicator", "on");

      return;
    }

    actionSubmitButton.removeAttribute("data-kt-indicator");
  }

  /* ---------- Set action submit presentation ---------- */

  function setActionSubmitPresentation(action) {
    if (!actionSubmitButton || !action) return;

    var indicatorLabel = actionSubmitButton.querySelector(".indicator-label");

    actionSubmitButton.className = "btn " + (action.modal?.confirmButtonClass || "btn-primary");

    if (indicatorLabel) {
      indicatorLabel.textContent = action.modal?.confirmLabel || "Continue";
    }
  }

  /* ---------- Apply application action to modal ---------- */

  function applyApplicationAction(action) {
    if (!action) return;

    currentAction = action;

    resetActionAlert();
    resetActionNotice();
    clearActionFields();
    setActionSubmitting(false);

    if (actionTypeInput) {
      actionTypeInput.value = action.key || "";
    }

    if (actionUrlInput) {
      actionUrlInput.value = action.url || "";
    }

    if (actionModalTitle) {
      actionModalTitle.textContent = action.modal?.title || "Review application";
    }

    if (actionModalContext) {
      actionModalContext.textContent = action.modal?.description || "";
    }

    renderActionNotice(action.modal?.notice);

    renderActionFields(action.modal?.fields);

    setActionSubmitPresentation(action);
  }

  /* ---------- Reset application action modal ---------- */

  function resetApplicationActionModal() {
    currentAction = null;

    if (actionForm) {
      actionForm.reset();
    }

    if (actionTypeInput) {
      actionTypeInput.value = "";
    }

    if (actionUrlInput) {
      actionUrlInput.value = "";
    }

    resetActionAlert();
    resetActionNotice();
    clearActionFields();
    setActionSubmitting(false);
  }

  /* ---------- Build backend error message ---------- */

  function buildBackendErrorMessage(error) {
    var response = error?.response?.data || null;

    if (!response) {
      return "The application action could not be completed. Please try again.";
    }

    var message =
      response.message || "The application action could not be completed. Please try again.";

    if (response.code) {
      message += " [" + response.code + "]";
    }

    return message;
  }

  /* ---------- Show configuration error ---------- */

  function showConfigurationError() {
    Swal.fire({
      text: "The application action could not be prepared. Please refresh the page and try again.",

      icon: "error",

      buttonsStyling: false,

      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  /* ---------- Handle application action triggers ---------- */

  function handleApplicationActionTriggers() {
    document.addEventListener("click", function (event) {
      var trigger = event.target.closest(".js-application-action-trigger");

      if (!trigger) return;

      if (!page || !page.contains(trigger)) return;

      var action = parseActionConfig(trigger);

      if (!action || !action.url || !action.key) {
        event.preventDefault();

        showConfigurationError();

        return;
      }

      applyApplicationAction(action);
    });
  }

  /* ---------- Submit application action ---------- */

  function submitApplicationAction() {
    if (!actionForm || !actionSubmitButton || !currentAction || !currentAction.url) {
      return;
    }

    setActionSubmitting(true);
    resetActionAlert();

    var formData = new FormData(actionForm);

    var data = Object.fromEntries(formData);

    axios({
      method: currentAction.method || "POST",

      url: currentAction.url,

      data: data,
    })
      .then(function (response) {
        setActionSubmitting(false);

        var result = response.data || {};

        Swal.fire({
          text: result.message || "The application has been updated successfully.",

          icon: "success",

          buttonsStyling: false,

          confirmButtonText: "Ok, got it!",

          customClass: {
            confirmButton: "btn btn-primary",
          },
        }).then(function () {
          if (result.redirectUrl) {
            window.location.href = result.redirectUrl;

            return;
          }

          window.location.reload();
        });
      })
      .catch(function (error) {
        setActionSubmitting(false);

        var message = buildBackendErrorMessage(error);

        showActionAlert(message);

        Swal.fire({
          text: message,

          icon: "error",

          buttonsStyling: false,

          confirmButtonText: "Ok, got it!",

          customClass: {
            confirmButton: "btn btn-primary",
          },
        });
      });
  }

  /* ---------- Handle application action submission ---------- */

  function handleApplicationActionSubmission() {
    if (!actionForm || !actionSubmitButton) return;

    actionForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (!currentAction || !currentAction.url) {
        showActionAlert("The application action is unavailable. Refresh the page and try again.");

        return;
      }

      if (!actionForm.checkValidity()) {
        actionForm.reportValidity();

        return;
      }

      submitApplicationAction();
    });
  }

  /* ---------- Handle application action modal ---------- */

  function handleApplicationActionModal() {
    if (!actionModal) return;

    actionModal.addEventListener("hidden.bs.modal", function () {
      resetApplicationActionModal();
    });
  }

  /* ---------- Initialise application actions ---------- */

  function initApplicationActions() {
    page = document.querySelector("#shiftApplicationsPage");

    if (!page) return;

    actionModal = document.querySelector("#shiftApplicationActionModal");
    actionForm = document.querySelector("#shiftApplicationActionForm");
    actionAlert = document.querySelector("#shiftApplicationActionAlert");
    actionModalTitle = document.querySelector("#shiftApplicationActionModalLabel");
    actionModalContext = document.querySelector("#shiftApplicationActionContext");
    actionTypeInput = document.querySelector("#shiftApplicationActionType");
    actionUrlInput = document.querySelector("#shiftApplicationActionUrl");
    actionFieldsContainer = document.querySelector("#shiftApplicationActionFields");
    actionNotice = document.querySelector("#shiftApplicationActionNotice");
    actionSubmitButton = document.querySelector("#shiftApplicationActionSubmit");

    /*
     * A read-only applications page intentionally has no action modal.
     */
    if (!actionModal || !actionForm || !actionSubmitButton) {
      return;
    }

    handleApplicationActionTriggers();
    handleApplicationActionSubmission();
    handleApplicationActionModal();
  }

  return {
    init: function () {
      initApplicationActions();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerShiftApplications.init();
});
