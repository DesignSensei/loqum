// public/js/cases.js

"use strict";

var Cases = (function () {
  /* ─────────────────────────────── MESSAGES ─────────────────────────────── */

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

  /* ─────────────────────────────── ADMIN ADJUSTED OUTCOME ─────────────────────────────── */

  function synchronizeAdjustedOutcome(form) {
    var decisionSelect = form.querySelector("[data-admin-decision]");
    var adjustedOutcome = form.querySelector("[data-adjusted-outcome]");

    if (!decisionSelect || !adjustedOutcome) {
      return;
    }

    var enabled = decisionSelect.value === "adjusted";

    adjustedOutcome.classList.toggle("d-none", !enabled);

    adjustedOutcome.querySelectorAll("input, textarea, select").forEach(function (field) {
      field.disabled = !enabled;
    });
  }

  function bindAdminDecisionFields() {
    document.querySelectorAll("[data-admin-decision]").forEach(function (decisionSelect) {
      var form = decisionSelect.closest("[data-case-action-form]");

      if (!form) {
        return;
      }

      decisionSelect.addEventListener("change", function () {
        synchronizeAdjustedOutcome(form);
      });

      synchronizeAdjustedOutcome(form);
    });
  }

  /* ─────────────────────────────── SUBMISSION ─────────────────────────────── */

  function setSubmitting(submitButton, submitting, originalText) {
    if (!submitButton) {
      return;
    }

    submitButton.disabled = submitting;

    submitButton.textContent = submitting ? "Submitting…" : originalText;
  }

  async function submitCaseAction(form) {
    var submitButton = form.querySelector('[type="submit"]');

    var originalButtonText = submitButton ? submitButton.textContent : "";

    clearMessage(form);

    setSubmitting(submitButton, true, originalButtonText);

    try {
      var response = await fetch(form.action, {
        method: form.method || "POST",

        headers: {
          Accept: "application/json",
        },

        body: new URLSearchParams(new FormData(form)),
      });

      var payload = await response.json();

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

  /* ─────────────────────────────── CASE ACTION FORMS ─────────────────────────────── */

  function bindCaseActionForms() {
    document.querySelectorAll("[data-case-action-form]").forEach(function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();

        submitCaseAction(form);
      });
    });
  }

  /* ─────────────────────────────── PUBLIC ─────────────────────────────── */

  return {
    init: function () {
      bindAdminDecisionFields();
      bindCaseActionForms();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  Cases.init();
});
