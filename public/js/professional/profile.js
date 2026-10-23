"use strict";

// public/js/professional/profile.js

var ProfessionalProfile = (function () {
  var availabilityForm;
  var availabilityStatus;
  var availabilitySubmitButton;

  var weeklyPanel;
  var datePanel;
  var datePicker;
  var addDateButton;
  var selectedDatesContainer;
  var emptyDatesMessage;
  var errorBox;
  var maximumDates;

  // ───────────────────── FEEDBACK ─────────────────────

  function showError(message) {
    if (!errorBox) return;

    errorBox.textContent = message;
    errorBox.classList.remove("d-none");

    errorBox.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  function clearError() {
    if (!errorBox) return;

    errorBox.textContent = "";
    errorBox.classList.add("d-none");
  }

  function setSubmitLoading(isLoading) {
    if (!availabilitySubmitButton) return;

    if (isLoading) {
      availabilitySubmitButton.setAttribute("data-kt-indicator", "on");
      availabilitySubmitButton.disabled = true;
      return;
    }

    availabilitySubmitButton.removeAttribute("data-kt-indicator");
    availabilitySubmitButton.disabled = false;
  }

  // ───────────────────── AVAILABILITY MODE ─────────────────────

  function getActiveMode() {
    if (!availabilityForm) return "";

    var selected = availabilityForm.querySelector('input[name="availabilityMode"]:checked');

    return selected ? selected.value : "";
  }

  function setPanelEnabled(panel, enabled) {
    if (!panel) return;

    panel.classList.toggle("d-none", !enabled);

    panel.querySelectorAll("input, button").forEach(function (element) {
      element.disabled = !enabled;
    });
  }

  function updateAvailabilityMode() {
    var mode = getActiveMode();

    setPanelEnabled(weeklyPanel, mode === "weekly");
    setPanelEnabled(datePanel, mode === "dates");

    clearError();
  }

  function bindAvailabilityModeChanges() {
    if (!availabilityForm) return;

    availabilityForm.querySelectorAll('input[name="availabilityMode"]').forEach(function (input) {
      input.addEventListener("change", updateAvailabilityMode);
    });
  }

  // ───────────────────── DATE HELPERS ─────────────────────

  function getSelectedDates() {
    if (!selectedDatesContainer) return [];

    return Array.from(selectedDatesContainer.querySelectorAll('input[name="availableDates"]')).map(
      function (input) {
        return input.value;
      }
    );
  }

  function isValidDate(dateString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return false;
    }

    var date = new Date(dateString + "T12:00:00.000Z");

    if (Number.isNaN(date.getTime())) {
      return false;
    }

    return date.toISOString().slice(0, 10) === dateString;
  }

  function formatSelectedDate(dateString) {
    return new Date(dateString + "T12:00:00.000Z").toLocaleDateString("en-NG", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  function updateEmptyDatesState() {
    if (!emptyDatesMessage) return;

    emptyDatesMessage.classList.toggle("d-none", getSelectedDates().length > 0);
  }

  // ───────────────────── DATE CHIP ─────────────────────

  function createDateChip(dateString) {
    var dateLabel = formatSelectedDate(dateString);

    var chip = document.createElement("div");

    chip.className =
      "d-inline-flex align-items-center gap-2 " +
      "bg-light-primary border border-primary " +
      "border-dashed rounded px-3 py-2";

    chip.setAttribute("data-availability-date", dateString);

    var label = document.createElement("span");

    label.className = "fw-semibold text-gray-800 fs-7";
    label.textContent = dateLabel;

    var input = document.createElement("input");

    input.type = "hidden";
    input.name = "availableDates";
    input.value = dateString;

    var removeButton = document.createElement("button");

    removeButton.type = "button";
    removeButton.className = "btn btn-icon btn-sm btn-light-primary fs-3";

    removeButton.setAttribute("data-remove-availability-date", "");
    removeButton.setAttribute("aria-label", "Remove " + dateLabel);
    removeButton.setAttribute("title", "Remove date");

    removeButton.textContent = "\u00D7";

    chip.appendChild(label);
    chip.appendChild(input);
    chip.appendChild(removeButton);

    return chip;
  }

  // ───────────────────── ADD DATE ─────────────────────

  function addAvailabilityDate() {
    if (!datePicker || !selectedDatesContainer) return;

    clearError();

    var selectedDate = datePicker.value;

    if (!selectedDate) {
      showError("Please select a date first.");
      return;
    }

    if (!isValidDate(selectedDate)) {
      showError("Please select a valid date.");
      return;
    }

    if (datePicker.min && selectedDate < datePicker.min) {
      showError("Please select an upcoming date.");
      return;
    }

    var currentDates = getSelectedDates();

    if (currentDates.includes(selectedDate)) {
      showError("You have already added this date.");
      return;
    }

    if (Number.isInteger(maximumDates) && maximumDates > 0 && currentDates.length >= maximumDates) {
      showError("You can select a maximum of " + maximumDates + " dates.");
      return;
    }

    selectedDatesContainer.appendChild(createDateChip(selectedDate));

    datePicker.value = "";

    updateEmptyDatesState();
  }

  function bindAddDate() {
    if (!addDateButton || !datePicker) return;

    addDateButton.addEventListener("click", addAvailabilityDate);

    datePicker.addEventListener("change", clearError);

    datePicker.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;

      event.preventDefault();
      addAvailabilityDate();
    });
  }

  // ───────────────────── REMOVE DATE ─────────────────────

  function bindRemoveDate() {
    if (!selectedDatesContainer) return;

    selectedDatesContainer.addEventListener("click", function (event) {
      var target = event.target;

      if (!target || !target.closest) return;

      var removeButton = target.closest("[data-remove-availability-date]");

      if (!removeButton || removeButton.disabled) return;

      var chip = removeButton.closest("[data-availability-date]");

      if (!chip) return;

      chip.remove();

      clearError();
      updateEmptyDatesState();
    });
  }

  // ───────────────────── FORM VALIDATION ─────────────────────

  function validateAvailability() {
    if (!availabilityStatus) return false;

    var status = availabilityStatus.value;
    var mode = getActiveMode();

    if (mode !== "weekly" && mode !== "dates") {
      showError("Please select an availability mode.");
      return false;
    }

    // Empty preferences are permitted when the professional
    // is not currently marked as available.
    if (status !== "available") {
      return true;
    }

    if (mode === "weekly") {
      var selectedWeekdays = weeklyPanel.querySelectorAll(
        'input[name="availableWeekdays"]:checked'
      );

      if (selectedWeekdays.length === 0) {
        showError("Please select at least one available weekday.");
        return false;
      }

      return true;
    }

    var selectedDates = getSelectedDates();

    if (selectedDates.length === 0) {
      showError("Please add at least one available date.");
      return false;
    }

    if (Number.isInteger(maximumDates) && maximumDates > 0 && selectedDates.length > maximumDates) {
      showError("You can select a maximum of " + maximumDates + " dates.");
      return false;
    }

    if (
      selectedDates.some(function (dateString) {
        return !isValidDate(dateString) || (datePicker.min && dateString < datePicker.min);
      })
    ) {
      showError("Please remove any invalid or past dates before saving.");
      return false;
    }

    return true;
  }

  // ───────────────────── FORM SUBMISSION ─────────────────────

  function bindAvailabilitySubmission() {
    if (!availabilityForm) return;

    availabilityForm.addEventListener("submit", function (event) {
      clearError();

      if (availabilitySubmitButton.disabled) {
        event.preventDefault();
        return;
      }

      if (!validateAvailability()) {
        event.preventDefault();
        return;
      }

      // Native form submission to the existing controller.
      // Server-side validation and CSRF remain authoritative.
      setSubmitLoading(true);
    });

    // Restore the button when returning through the browser cache.
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) {
        setSubmitLoading(false);
      }
    });
  }

  // ───────────────────── INITIALISATION ─────────────────────

  function initializeAvailability() {
    availabilityForm = document.querySelector("#professionalAvailabilityForm");

    if (!availabilityForm) return;

    availabilityStatus = document.querySelector("#professionalAvailabilityStatus");

    availabilitySubmitButton = document.querySelector("#professionalAvailabilitySubmit");

    weeklyPanel = document.querySelector("#professionalWeeklyAvailability");

    datePanel = document.querySelector("#professionalDateAvailability");

    datePicker = document.querySelector("#professionalAvailabilityDatePicker");

    addDateButton = document.querySelector("#professionalAddAvailabilityDate");

    selectedDatesContainer = document.querySelector("#professionalSelectedDates");

    emptyDatesMessage = document.querySelector("#professionalDatesEmpty");

    errorBox = document.querySelector("#professionalAvailabilityError");

    if (
      !availabilityStatus ||
      !availabilitySubmitButton ||
      !weeklyPanel ||
      !datePanel ||
      !datePicker ||
      !addDateButton ||
      !selectedDatesContainer ||
      !emptyDatesMessage ||
      !errorBox
    ) {
      return;
    }

    maximumDates = Number.parseInt(datePanel.getAttribute("data-max-dates"), 10);

    bindAvailabilityModeChanges();
    bindAddDate();
    bindRemoveDate();
    bindAvailabilitySubmission();

    updateAvailabilityMode();
    updateEmptyDatesState();
  }

  return {
    init: function () {
      initializeAvailability();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  ProfessionalProfile.init();
});
