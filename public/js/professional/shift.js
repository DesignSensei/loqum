// public/js/professional/shifts.js

"use strict";

var ProfessionalShifts = (function () {
  var filtersForm;
  var filterSubmitButton;

  var dateFromInput;
  var dateToInput;

  var isSubmitting = false;
  var originalButtonContent = null;

  // ───────────────────── DATE VALIDATION ─────────────────────

  function getDateErrorElement() {
    if (!dateToInput) return null;

    var errorElement = document.querySelector("#professionalShiftDateRangeError");

    if (errorElement) return errorElement;

    errorElement = document.createElement("div");

    errorElement.id = "professionalShiftDateRangeError";
    errorElement.className = "invalid-feedback";
    errorElement.setAttribute("role", "alert");

    dateToInput.insertAdjacentElement("afterend", errorElement);

    return errorElement;
  }

  function clearDateError() {
    if (dateFromInput) {
      dateFromInput.classList.remove("is-invalid");
      dateFromInput.removeAttribute("aria-invalid");
    }

    if (dateToInput) {
      dateToInput.classList.remove("is-invalid");
      dateToInput.removeAttribute("aria-invalid");
    }

    var errorElement = document.querySelector("#professionalShiftDateRangeError");

    if (errorElement) {
      errorElement.textContent = "";
    }
  }

  function showDateError(message) {
    if (!dateToInput) return;

    dateToInput.classList.add("is-invalid");
    dateToInput.setAttribute("aria-invalid", "true");

    var errorElement = getDateErrorElement();

    if (errorElement) {
      errorElement.textContent = message;
    }
  }

  function validateDateRange() {
    if (!dateFromInput || !dateToInput) return true;

    clearDateError();

    var dateFrom = dateFromInput.value;
    var dateTo = dateToInput.value;

    // Allow open-ended searches.
    if (!dateFrom || !dateTo) {
      return true;
    }

    // Native date inputs provide YYYY-MM-DD values.
    if (dateTo < dateFrom) {
      showDateError("The end date cannot be earlier than the start date.");

      return false;
    }

    return true;
  }

  function bindDateChanges() {
    if (dateFromInput) {
      dateFromInput.addEventListener("input", clearDateError);
      dateFromInput.addEventListener("change", clearDateError);
    }

    if (dateToInput) {
      dateToInput.addEventListener("input", clearDateError);
      dateToInput.addEventListener("change", clearDateError);
    }
  }

  // ───────────────────── SUBMIT LOADING STATE ─────────────────────

  function setSubmitLoading(isLoading) {
    if (!filterSubmitButton) return;

    if (isLoading) {
      if (originalButtonContent === null) {
        originalButtonContent = filterSubmitButton.innerHTML;
      }

      filterSubmitButton.disabled = true;
      filterSubmitButton.setAttribute("aria-busy", "true");

      var spinner = document.createElement("span");

      spinner.className = "spinner-border spinner-border-sm me-2";
      spinner.setAttribute("aria-hidden", "true");

      var label = document.createElement("span");

      label.textContent = "Searching...";

      filterSubmitButton.replaceChildren(spinner, label);

      return;
    }

    filterSubmitButton.disabled = false;
    filterSubmitButton.removeAttribute("aria-busy");

    if (originalButtonContent !== null) {
      filterSubmitButton.innerHTML = originalButtonContent;
    }
  }

  // ───────────────────── FORM SUBMISSION ─────────────────────

  function bindFilterSubmission() {
    if (!filtersForm) return;

    filtersForm.addEventListener("submit", function (event) {
      if (isSubmitting) {
        event.preventDefault();
        return;
      }

      if (!validateDateRange()) {
        event.preventDefault();

        if (dateToInput) {
          dateToInput.focus();
        }

        return;
      }

      // Native GET submission to the existing controller.
      // The backend remains responsible for validating all filters.
      isSubmitting = true;

      setSubmitLoading(true);
    });

    // Restore submission state when returning through browser history.
    window.addEventListener("pageshow", function (event) {
      if (event.persisted || isSubmitting) {
        isSubmitting = false;
        setSubmitLoading(false);
      }
    });
  }

  // ───────────────────── INITIALISATION ─────────────────────

  function initializeShifts() {
    filtersForm = document.querySelector("#professionalShiftFiltersForm");

    if (!filtersForm) return;

    filterSubmitButton = document.querySelector("#professionalShiftFilterSubmit");

    dateFromInput = document.querySelector("#professionalShiftDateFrom");

    dateToInput = document.querySelector("#professionalShiftDateTo");

    if (!filterSubmitButton) return;

    bindDateChanges();
    bindFilterSubmission();
  }

  return {
    init: function () {
      initializeShifts();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  ProfessionalShifts.init();
});
