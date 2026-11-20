// public/js/professional/profile.js

"use strict";

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

  var VALID_STATUSES = ["available", "unavailable", "busy", "paused"];
  var MAX_AVAILABLE_DATES = 90;

  var licenceUploadForm;
  var licenceUploadFile;
  var licenceUploadButton;
  var licenceUploadButtonLabel;
  var licenceUploadFeedback;
  var licenceUploadMaxBytes;
  var licenceUploadOriginalLabel = "";
  var licenceUploadBusy = false;

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

  function getTodayISODate() {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());

    var values = {};

    parts.forEach(function (part) {
      if (part.type === "year" || part.type === "month" || part.type === "day") {
        values[part.type] = part.value;
      }
    });

    return values.year + "-" + values.month + "-" + values.day;
  }

  function refreshMinimumDate() {
    if (!datePicker) return "";

    var today = getTodayISODate();
    var configuredMinimum = datePicker.min || "";

    datePicker.min = configuredMinimum > today ? configuredMinimum : today;

    return datePicker.min;
  }

  function getSelectedDates() {
    if (!selectedDatesContainer) return [];

    return Array.from(selectedDatesContainer.querySelectorAll('input[name="availableDates"]')).map(
      function (input) {
        return input.value;
      }
    );
  }

  function isValidDate(dateString) {
    if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
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
    if (!datePicker || !selectedDatesContainer) {
      return;
    }

    clearError();

    var minimumDate = refreshMinimumDate();
    var selectedDate = datePicker.value;

    if (!selectedDate) {
      showError("Please select a date first.");
      return;
    }

    if (!isValidDate(selectedDate)) {
      showError("Please select a valid date.");
      return;
    }

    if (minimumDate && selectedDate < minimumDate) {
      showError("Please select an upcoming date.");
      return;
    }

    var currentDates = getSelectedDates();

    if (currentDates.includes(selectedDate)) {
      showError("You have already added this date.");
      return;
    }

    if (currentDates.length >= maximumDates) {
      showError("You can select a maximum of " + maximumDates + " dates.");
      return;
    }

    selectedDatesContainer.appendChild(createDateChip(selectedDate));
    datePicker.value = "";

    updateEmptyDatesState();
  }

  function bindAddDate() {
    if (!addDateButton || !datePicker) {
      return;
    }

    addDateButton.addEventListener("click", addAvailabilityDate);
    datePicker.addEventListener("change", clearError);
    datePicker.addEventListener("focus", refreshMinimumDate);

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

      if (!target || !target.closest) {
        return;
      }

      var removeButton = target.closest("[data-remove-availability-date]");

      if (!removeButton || removeButton.disabled) {
        return;
      }

      var chip = removeButton.closest("[data-availability-date]");

      if (!chip) return;

      chip.remove();

      clearError();
      updateEmptyDatesState();
    });
  }

  // ───────────────────── VALIDATION HELPERS ─────────────────────

  function validateSelectedDates() {
    var selectedDates = getSelectedDates();

    if (selectedDates.length > maximumDates) {
      showError("You can select a maximum of " + maximumDates + " dates.");
      return false;
    }

    if (new Set(selectedDates).size !== selectedDates.length) {
      showError("Please remove duplicate availability dates.");
      return false;
    }

    var minimumDate = refreshMinimumDate();

    var hasInvalidDate = selectedDates.some(function (dateString) {
      return !isValidDate(dateString) || (minimumDate && dateString < minimumDate);
    });

    if (hasInvalidDate) {
      showError("Please remove any invalid or past dates before saving.");
      return false;
    }

    return true;
  }

  function validateSelectedWeekdays() {
    if (!weeklyPanel) return false;

    var selectedWeekdays = Array.from(
      weeklyPanel.querySelectorAll('input[name="availableWeekdays"]:checked')
    ).map(function (input) {
      return input.value;
    });

    if (selectedWeekdays.length > 7 || new Set(selectedWeekdays).size !== selectedWeekdays.length) {
      showError("Please select valid weekdays without duplicates.");
      return false;
    }

    var invalidWeekday = selectedWeekdays.some(function (day) {
      return !/^[1-7]$/.test(day);
    });

    if (invalidWeekday) {
      showError("An invalid weekday was selected.");
      return false;
    }

    return true;
  }

  // ───────────────────── FORM VALIDATION ─────────────────────

  function validateAvailability() {
    if (!availabilityStatus || !availabilityForm) {
      return false;
    }

    var status = availabilityStatus.value;
    var mode = getActiveMode();

    if (!VALID_STATUSES.includes(status)) {
      showError("Please select a valid availability status.");
      return false;
    }

    if (mode !== "weekly" && mode !== "dates") {
      showError("Please select an availability mode.");
      return false;
    }

    if (mode === "weekly") {
      if (!validateSelectedWeekdays()) {
        return false;
      }

      if (status === "available") {
        var selectedWeekdays = weeklyPanel.querySelectorAll(
          'input[name="availableWeekdays"]:checked'
        );

        if (selectedWeekdays.length === 0) {
          showError("Please select at least one available weekday.");
          return false;
        }
      }

      return true;
    }

    if (!validateSelectedDates()) {
      return false;
    }

    if (status === "available" && getSelectedDates().length === 0) {
      showError("Please add at least one available date.");
      return false;
    }

    return true;
  }

  // ───────────────────── AVAILABILITY SUBMISSION ─────────────────────

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

      setSubmitLoading(true);
    });

    window.addEventListener("pageshow", function () {
      setSubmitLoading(false);
      refreshMinimumDate();
    });
  }

  // ───────────────────── AVAILABILITY INITIALISATION ─────────────────────

  function initializeAvailability() {
    availabilityForm = document.querySelector("#professionalAvailabilityForm");

    if (!availabilityForm) return;

    availabilityStatus = availabilityForm.querySelector("#professionalAvailabilityStatus");
    availabilitySubmitButton = availabilityForm.querySelector("#professionalAvailabilitySubmit");

    weeklyPanel = availabilityForm.querySelector("#professionalWeeklyAvailability");
    datePanel = availabilityForm.querySelector("#professionalDateAvailability");

    datePicker = availabilityForm.querySelector("#professionalAvailabilityDatePicker");
    addDateButton = availabilityForm.querySelector("#professionalAddAvailabilityDate");

    selectedDatesContainer = availabilityForm.querySelector("#professionalSelectedDates");
    emptyDatesMessage = availabilityForm.querySelector("#professionalDatesEmpty");
    errorBox = availabilityForm.querySelector("#professionalAvailabilityError");

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

    var configuredMaximum = Number.parseInt(datePanel.getAttribute("data-max-dates"), 10);

    maximumDates =
      Number.isInteger(configuredMaximum) && configuredMaximum > 0
        ? Math.min(configuredMaximum, MAX_AVAILABLE_DATES)
        : MAX_AVAILABLE_DATES;

    bindAvailabilityModeChanges();
    bindAddDate();
    bindRemoveDate();
    bindAvailabilitySubmission();

    refreshMinimumDate();
    updateAvailabilityMode();
    updateEmptyDatesState();
  }

  // ───────────────────── LICENCE UPLOAD ─────────────────────

  function showLicenceUploadFeedback(message, type) {
    if (!licenceUploadFeedback) return;

    licenceUploadFeedback.textContent = message;
    licenceUploadFeedback.classList.remove(
      "d-none",
      "alert-success",
      "alert-danger",
      "alert-warning"
    );
    licenceUploadFeedback.classList.add("alert-" + type);
  }

  function clearLicenceUploadFeedback() {
    if (!licenceUploadFeedback) return;

    licenceUploadFeedback.textContent = "";
    licenceUploadFeedback.classList.add("d-none");
  }

  function setLicenceUploadLoading(isLoading) {
    licenceUploadBusy = isLoading;
    licenceUploadButton.disabled = isLoading;
    licenceUploadFile.disabled = isLoading;
    licenceUploadForm.setAttribute("aria-busy", isLoading ? "true" : "false");

    if (isLoading) {
      licenceUploadButton.setAttribute("data-kt-indicator", "on");
    } else {
      licenceUploadButton.removeAttribute("data-kt-indicator");
    }

    if (licenceUploadButtonLabel) {
      licenceUploadButtonLabel.textContent = isLoading
        ? "Submitting..."
        : licenceUploadOriginalLabel;
    }
  }

  async function submitLicenceUpload(event) {
    event.preventDefault();

    if (licenceUploadBusy) return;

    clearLicenceUploadFeedback();

    var file = licenceUploadFile.files && licenceUploadFile.files[0];

    if (!file) {
      showLicenceUploadFeedback("Please select a practising-licence document.", "warning");
      return;
    }

    if (file.size === 0) {
      showLicenceUploadFeedback("The selected document is empty.", "warning");
      return;
    }

    if (file.size > licenceUploadMaxBytes) {
      showLicenceUploadFeedback("The document must not exceed 10 MB.", "warning");
      return;
    }

    var csrfInput = licenceUploadForm.querySelector('input[name="_csrf"]');
    var csrfToken = csrfInput && csrfInput.value;

    if (!csrfToken) {
      showLicenceUploadFeedback(
        "Your session needs refreshing. Please reload this page.",
        "warning"
      );
      return;
    }

    var formData = new FormData(licenceUploadForm);

    setLicenceUploadLoading(true);

    try {
      var response = await fetch(licenceUploadForm.action, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "CSRF-Token": csrfToken,
        },
      });

      var contentType = response.headers.get("content-type") || "";

      var result = contentType.includes("application/json") ? await response.json() : null;

      if (!response.ok || !result || result.success !== true) {
        throw new Error(
          result && typeof result.message === "string" && result.message
            ? result.message
            : "Unable to submit your licence. Please try again."
        );
      }

      showLicenceUploadFeedback(
        "Your practising licence has been submitted for review.",
        "success"
      );

      window.location.assign("/professional/profile?tab=verification");
    } catch (error) {
      showLicenceUploadFeedback(
        error && error.message ? error.message : "Unable to submit your licence. Please try again.",
        "danger"
      );

      setLicenceUploadLoading(false);
    }
  }

  function initializeLicenceUpload() {
    licenceUploadForm = document.querySelector("#professionalLicenceUploadForm");

    if (!licenceUploadForm) return;

    licenceUploadFile = licenceUploadForm.querySelector("#professionalLicenceDocument");
    licenceUploadButton = licenceUploadForm.querySelector("#professionalLicenceUploadButton");

    licenceUploadButtonLabel = licenceUploadForm.querySelector(
      "#professionalLicenceUploadButtonLabel"
    );

    licenceUploadFeedback = document.querySelector("#professionalLicenceUploadFeedback");

    if (!licenceUploadFile || !licenceUploadButton || !licenceUploadFeedback) {
      return;
    }

    var configuredMax = Number.parseInt(licenceUploadForm.dataset.maxBytes, 10);
    var maxBytes = 10 * 1024 * 1024;

    licenceUploadMaxBytes =
      Number.isInteger(configuredMax) && configuredMax > 0
        ? Math.min(configuredMax, maxBytes)
        : maxBytes;

    licenceUploadOriginalLabel = licenceUploadButtonLabel
      ? licenceUploadButtonLabel.textContent.trim()
      : "Submit practising licence";

    licenceUploadFile.addEventListener("change", clearLicenceUploadFeedback);
    licenceUploadForm.addEventListener("submit", submitLicenceUpload);
  }

  return {
    init: function () {
      initializeAvailability();
      initializeLicenceUpload();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  ProfessionalProfile.init();
});
