// public/js/cases.js

"use strict";

var Cases = (function () {
  /* Messages */

  function showMessage(form, message, success) {
    var messageElement = form.querySelector("[data-case-action-message]");

    if (!messageElement) {
      return;
    }

    messageElement.className = success
      ? "alert alert-success py-3 px-4 mt-3"
      : "alert alert-danger py-3 px-4 mt-3";

    messageElement.textContent = message;
  }

  function clearMessage(form) {
    var messageElement = form.querySelector("[data-case-action-message]");

    if (!messageElement) {
      return;
    }

    messageElement.className = "mt-3 d-none";
    messageElement.textContent = "";
  }

  /* Form field state */

  function setFieldsEnabled(container, enabled) {
    if (!container) {
      return;
    }

    container.querySelectorAll("input, textarea, select").forEach(function (field) {
      field.disabled = !enabled;
    });
  }

  /* Employer counter-position */

  function synchronizeEmployerCounterPosition(form) {
    var decisionSelect = form.querySelector("[data-employer-review-decision]");

    var counterPosition = form.querySelector("[data-employer-counter-position]");

    if (!decisionSelect || !counterPosition) {
      return;
    }

    var counterPositionDecision = decisionSelect.dataset.counterPositionDecision || "";

    var enabled =
      Boolean(counterPositionDecision) && decisionSelect.value === counterPositionDecision;

    counterPosition.classList.toggle("d-none", !enabled);

    setFieldsEnabled(counterPosition, enabled);
  }

  function bindEmployerDecisionFields() {
    document.querySelectorAll("[data-employer-claim-review]").forEach(function (form) {
      var decisionSelect = form.querySelector("[data-employer-review-decision]");

      if (!decisionSelect) {
        return;
      }

      decisionSelect.addEventListener("change", function () {
        synchronizeEmployerCounterPosition(form);
      });

      synchronizeEmployerCounterPosition(form);
    });
  }

  /* Admin authoritative outcome */

  function getAdminOutcomeDecisions(decisionSelect) {
    var rawValue = decisionSelect.dataset.adminOutcomeDecisions || "";

    return rawValue
      .split(",")
      .map(function (value) {
        return value.trim();
      })
      .filter(Boolean);
  }

  function synchronizeAdminOutcome(form) {
    var decisionSelect = form.querySelector("[data-admin-decision]");

    var adminOutcome = form.querySelector("[data-admin-outcome]");

    if (!decisionSelect || !adminOutcome) {
      return;
    }

    var outcomeDecisions = getAdminOutcomeDecisions(decisionSelect);

    var enabled = Boolean(decisionSelect.value) && outcomeDecisions.includes(decisionSelect.value);

    adminOutcome.classList.toggle("d-none", !enabled);

    adminOutcome.querySelectorAll("[data-admin-outcome-input]").forEach(function (field) {
      field.disabled = !enabled;
    });
  }

  function bindAdminDecisionFields() {
    document.querySelectorAll("[data-admin-adjudication]").forEach(function (form) {
      var decisionSelect = form.querySelector("[data-admin-decision]");

      if (!decisionSelect) {
        return;
      }

      decisionSelect.addEventListener("change", function () {
        synchronizeAdminOutcome(form);
      });

      synchronizeAdminOutcome(form);
    });
  }

  /* Evidence */

  function getEvidenceRows(container) {
    var list = container.querySelector("[data-evidence-list]");

    if (!list) {
      return [];
    }

    return Array.from(list.querySelectorAll("[data-evidence-row]"));
  }

  function getEvidenceMaxItems(container) {
    var value = Number.parseInt(container.dataset.evidenceMaxItems || "0", 10);

    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  function updateEvidenceLimitState(container) {
    var rows = getEvidenceRows(container);

    var maxItems = getEvidenceMaxItems(container);

    var addButton = container.querySelector("[data-add-evidence]");

    var limitMessage = container.querySelector("[data-evidence-limit-message]");

    var atLimit = maxItems > 0 && rows.length >= maxItems;

    if (addButton) {
      addButton.disabled = atLimit;
    }

    if (limitMessage) {
      limitMessage.classList.toggle("d-none", !atLimit);
    }
  }

  function replaceEvidenceIndex(value, index) {
    if (!value) {
      return value;
    }

    return value
      .replace(/evidence\[(?:__INDEX__|\d+)\]/g, "evidence[" + index + "]")
      .replace(/__INDEX__/g, String(index));
  }

  function updateEvidenceRowIndex(row, index) {
    var numberElement = row.querySelector("[data-evidence-number]");

    if (numberElement) {
      numberElement.textContent = String(index + 1);
    }

    row.querySelectorAll("[name]").forEach(function (field) {
      field.name = replaceEvidenceIndex(field.name, index);
    });

    row.querySelectorAll("[id]").forEach(function (field) {
      field.id = replaceEvidenceIndex(field.id, index);
    });

    row.querySelectorAll("label[for]").forEach(function (label) {
      label.htmlFor = replaceEvidenceIndex(label.htmlFor, index);
    });
  }

  function renumberEvidenceRows(container) {
    getEvidenceRows(container).forEach(function (row, index) {
      updateEvidenceRowIndex(row, index);
    });

    updateEvidenceLimitState(container);
  }

  function createEvidenceRow(container) {
    var template = container.querySelector("[data-evidence-template]");

    var list = container.querySelector("[data-evidence-list]");

    if (!template || !list) {
      return;
    }

    var maxItems = getEvidenceMaxItems(container);

    var rows = getEvidenceRows(container);

    if (maxItems > 0 && rows.length >= maxItems) {
      updateEvidenceLimitState(container);

      return;
    }

    var fragment = template.content.cloneNode(true);

    var row = fragment.querySelector("[data-evidence-row]");

    if (!row) {
      return;
    }

    list.appendChild(fragment);

    renumberEvidenceRows(container);

    var firstField = row.querySelector("select, input, textarea");

    if (firstField) {
      firstField.focus();
    }
  }

  function removeEvidenceRow(container, row) {
    if (!row) {
      return;
    }

    row.remove();

    renumberEvidenceRows(container);
  }

  function bindEvidenceCollection(container) {
    var addButton = container.querySelector("[data-add-evidence]");

    if (addButton) {
      addButton.addEventListener("click", function () {
        createEvidenceRow(container);
      });
    }

    container.addEventListener("click", function (event) {
      var removeButton = event.target.closest("[data-remove-evidence]");

      if (!removeButton || !container.contains(removeButton)) {
        return;
      }

      var row = removeButton.closest("[data-evidence-row]");

      removeEvidenceRow(container, row);
    });

    renumberEvidenceRows(container);
  }

  function bindEvidenceCollections() {
    document.querySelectorAll("[data-case-evidence]").forEach(function (container) {
      bindEvidenceCollection(container);
    });
  }

  /* Submission */

  function setSubmitting(submitButton, submitting, originalText) {
    if (!submitButton) {
      return;
    }

    submitButton.disabled = submitting;

    submitButton.textContent = submitting ? "Submitting…" : originalText;
  }

  async function readResponsePayload(response) {
    var contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      return response.json();
    }

    var text = await response.text();

    return {
      success: response.ok,

      message: text || null,
    };
  }

  async function submitCaseAction(form) {
    var submitButton = form.querySelector('[type="submit"]');

    var originalButtonText = submitButton ? submitButton.textContent.trim() : "";

    clearMessage(form);

    setSubmitting(submitButton, true, originalButtonText);

    try {
      var formData = new FormData(form);

      var response = await fetch(form.action, {
        method: (form.method || "POST").toUpperCase(),

        headers: {
          Accept: "application/json",
        },

        credentials: "same-origin",

        body: new URLSearchParams(formData),
      });

      var payload = await readResponsePayload(response);

      if (!response.ok || payload.success === false) {
        throw new Error(payload.message || "The case action could not be completed.");
      }

      showMessage(form, payload.message || "The case was updated.", true);

      window.setTimeout(function () {
        window.location.reload();
      }, 700);
    } catch (error) {
      showMessage(form, error.message || "The case action could not be completed.", false);

      setSubmitting(submitButton, false, originalButtonText);
    }
  }

  /* Case action forms */

  function bindCaseActionForms() {
    document.querySelectorAll("[data-case-action-form]").forEach(function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();

        submitCaseAction(form);
      });
    });
  }

  /* Public */

  return {
    init: function () {
      bindEmployerDecisionFields();
      bindAdminDecisionFields();
      bindEvidenceCollections();
      bindCaseActionForms();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  Cases.init();
});
