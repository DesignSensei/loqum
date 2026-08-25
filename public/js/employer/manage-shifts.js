// public/js/employer/manage-shifts.js

"use strict";

var EmployerManageShifts = (function () {
  var MINUTES_PER_DAY = 24 * 60;
  var MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
  var SHIFT_TIME_ZONE = "Africa/Lagos";
  var SHIFT_TIME_ZONE_OFFSET = "+01:00";

  var manageShiftsPage;

  var postShiftForm;
  var postShiftSubmitButton;
  var postShiftFormAlert;
  var postShiftModalElement;
  var postShiftModal;

  var branchSelect;
  var professionalTypeSelect;
  var requiredSkillsInput;
  var breakDurationInput;
  var hourlyRateInput;

  var scheduleModeInputs = [];
  var singleScheduleFields;
  var multipleScheduleFields;

  var singleDateInput;
  var singleStartTimeInput;
  var singleEndTimeInput;
  var singleEndsNextDayInput;

  var startTimeInput;
  var endTimeInput;

  var firstOccurrenceDateInput;
  var occurrenceCountInput;
  var dailyStartTimeInput;
  var dailyEndTimeInput;
  var endsNextDayInput;
  var repeatDayInputs = [];
  var repeatDaysFeedback;

  var generatedOccurrenceCount;
  var occurrencePreviewEmptyState;
  var occurrencePreviewTableWrapper;
  var occurrencePreviewBody;

  var occurrenceCountPreview;
  var scheduledHoursPerOccurrencePreview;
  var scheduledHoursPreview;
  var employerChargePerOccurrencePreview;
  var professionalPayPreview;
  var platformFeePreview;
  var employerChargePreview;

  var singleDatePicker;
  var singleStartTimePicker;
  var singleEndTimePicker;
  var firstOccurrenceDatePicker;
  var dailyStartTimePicker;
  var dailyEndTimePicker;

  var fundShiftModalElement;
  var fundShiftModal;
  var fundShiftModalTitle;
  var fundShiftCsrfToken;
  var fundShiftId;
  var fundShiftWalletFundingUrl;
  var fundShiftCheckoutUrl;
  var fundShiftAlert;

  var fundShiftReference;
  var fundShiftStatusBadge;
  var fundShiftRole;
  var fundShiftBranch;
  var fundShiftSchedule;
  var fundShiftOccurrenceCount;
  var fundShiftHoursPerOccurrence;
  var fundShiftTotalHours;
  var fundShiftEmployerCharge;
  var fundShiftProfessionalPay;
  var fundShiftPlatformFee;

  var fundShiftWalletOption;
  var fundShiftWalletStatusBadge;
  var fundShiftWalletAvailableBalance;
  var fundShiftWalletBalanceAfter;
  var fundShiftWalletShortfallRow;
  var fundShiftWalletShortfall;
  var fundShiftWalletMessage;
  var fundShiftFromWalletButton;
  var fundShiftAddWalletFundsLink;

  var fundShiftCheckoutOption;
  var fundShiftCheckoutStatusBadge;
  var fundShiftCheckoutMessage;
  var initializeFundShiftCheckoutButton;

  var walletCanUse = false;
  var checkoutCanUse = false;
  var fundingRequestInProgress = false;
  var createdShiftRedirectUrl;

  /* ─────────────────────────────── GENERAL HELPERS ─────────────────────────────── */

  function getErrorMessage(error, fallbackMessage) {
    return (
      error?.response?.data?.message ||
      error?.response?.data?.error?.message ||
      error?.message ||
      fallbackMessage
    );
  }

  function getErrorDetails(error) {
    return error?.response?.data?.details || error?.response?.data?.error?.details || null;
  }

  function getResponsePayload(response) {
    var responseData = response?.data || {};

    if (responseData.data && typeof responseData.data === "object") {
      return responseData.data;
    }

    return responseData;
  }

  function getNestedValue(source, path) {
    if (!source || !path) {
      return null;
    }

    return path.split(".").reduce(function (currentValue, key) {
      if (currentValue === null || currentValue === undefined) {
        return null;
      }

      return currentValue[key];
    }, source);
  }

  function hasUsableValue(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function getFirstValue(source, paths, fallbackValue) {
    for (var index = 0; index < paths.length; index += 1) {
      var value = getNestedValue(source, paths[index]);

      if (hasUsableValue(value)) {
        return value;
      }
    }

    return fallbackValue === undefined ? null : fallbackValue;
  }

  function parseBoolean(value) {
    if (typeof value === "boolean") {
      return value;
    }

    return (
      String(value || "")
        .trim()
        .toLowerCase() === "true"
    );
  }

  function setText(element, value, fallbackValue) {
    if (!element) return;

    if (hasUsableValue(value)) {
      element.textContent = String(value);
      return;
    }

    element.textContent = fallbackValue !== undefined ? fallbackValue : "—";
  }

  function setButtonLoading(button, isLoading, disabledWhenIdle) {
    if (!button) return;

    if (isLoading) {
      button.setAttribute("data-kt-indicator", "on");
      button.disabled = true;
      return;
    }

    button.removeAttribute("data-kt-indicator");
    button.disabled = Boolean(disabledWhenIdle);
  }

  function showAlert({ title = null, text, icon, confirmButtonText = "Ok, got it!" }) {
    return Swal.fire({
      title,
      text,
      icon,
      buttonsStyling: false,
      confirmButtonText,

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function parseNumber(value) {
    var normalizedValue = String(value ?? "")
      .replace(/,/g, "")
      .trim();

    if (!normalizedValue) {
      return null;
    }

    var numberValue = Number(normalizedValue);

    return Number.isFinite(numberValue) ? numberValue : null;
  }

  function padNumber(value, width) {
    return String(value).padStart(width || 2, "0");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getCurrency() {
    return (
      postShiftForm?.dataset.currency ||
      manageShiftsPage?.dataset.currency ||
      fundShiftModalElement?.dataset.currency ||
      "NGN"
    );
  }

  function getCsrfToken() {
    return (
      fundShiftCsrfToken?.value || postShiftForm?.querySelector('input[name="_csrf"]')?.value || ""
    );
  }

  function parseLagosDateTime(value) {
    var cleanValue = String(value || "").trim();

    if (!cleanValue) {
      return null;
    }

    var localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

    var parsedDate = localDateTimePattern.test(cleanValue)
      ? new Date(cleanValue + ":00" + SHIFT_TIME_ZONE_OFFSET)
      : new Date(cleanValue);

    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  function normalizeLocalDate(value) {
    var cleanValue = String(value || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanValue)) {
      return null;
    }

    var parts = cleanValue.split("-").map(Number);

    var year = parts[0];
    var month = parts[1];
    var day = parts[2];

    var parsedDate = new Date(Date.UTC(year, month - 1, day));

    if (
      parsedDate.getUTCFullYear() !== year ||
      parsedDate.getUTCMonth() !== month - 1 ||
      parsedDate.getUTCDate() !== day
    ) {
      return null;
    }

    return cleanValue;
  }

  function addDaysToLocalDate(localDate, daysToAdd) {
    var normalizedDate = normalizeLocalDate(localDate);

    if (!normalizedDate) {
      return null;
    }

    var parts = normalizedDate.split("-").map(Number);

    var date = new Date(
      Date.UTC(parts[0], parts[1] - 1, parts[2]) + Number(daysToAdd || 0) * MILLISECONDS_PER_DAY
    );

    return [
      date.getUTCFullYear(),
      padNumber(date.getUTCMonth() + 1),
      padNumber(date.getUTCDate()),
    ].join("-");
  }

  function getLocalDateWeekday(localDate) {
    var normalizedDate = normalizeLocalDate(localDate);

    if (!normalizedDate) {
      return null;
    }

    var parts = normalizedDate.split("-").map(Number);

    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  }

  function parseTimeMinutes(value) {
    var cleanValue = String(value || "").trim();

    var match = cleanValue.match(/^(\d{2}):(\d{2})$/);

    if (!match) {
      return null;
    }

    var hour = Number(match[1]);
    var minute = Number(match[2]);

    if (
      !Number.isSafeInteger(hour) ||
      !Number.isSafeInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }

    return hour * 60 + minute;
  }

  function formatTimeMinutes(timeMinutes) {
    if (!Number.isSafeInteger(timeMinutes) || timeMinutes < 0 || timeMinutes >= MINUTES_PER_DAY) {
      return null;
    }

    return padNumber(Math.floor(timeMinutes / 60)) + ":" + padNumber(timeMinutes % 60);
  }

  function formatTimeMinutesForDisplay(timeMinutes) {
    if (!Number.isSafeInteger(timeMinutes) || timeMinutes < 0 || timeMinutes >= MINUTES_PER_DAY) {
      return null;
    }

    var hour24 = Math.floor(timeMinutes / 60);
    var minute = timeMinutes % 60;
    var period = hour24 >= 12 ? "PM" : "AM";
    var hour12 = hour24 % 12 || 12;

    return hour12 + ":" + padNumber(minute) + " " + period;
  }

  function buildLagosDateTime(localDate, timeMinutes, daysToAdd) {
    var adjustedDate = addDaysToLocalDate(localDate, daysToAdd || 0);

    var localTime = formatTimeMinutes(timeMinutes);

    if (!adjustedDate || !localTime) {
      return null;
    }

    var parsedDate = new Date(adjustedDate + "T" + localTime + ":00" + SHIFT_TIME_ZONE_OFFSET);

    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  function formatLocalDateForDisplay(localDate) {
    var normalizedDate = normalizeLocalDate(localDate);

    if (!normalizedDate) {
      return null;
    }

    try {
      return new Intl.DateTimeFormat("en-NG", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(normalizedDate + "T00:00:00Z"));
    } catch (error) {
      return normalizedDate;
    }
  }

  function formatMoneyFromMinorUnit(amount, currency) {
    var normalizedAmount = Number(amount || 0) / 100;

    var normalizedCurrency = String(currency || "NGN")
      .trim()
      .toUpperCase();

    try {
      return new Intl.NumberFormat("en-NG", {
        style: "currency",
        currency: normalizedCurrency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(normalizedAmount);
    } catch (error) {
      return normalizedCurrency + " " + normalizedAmount.toFixed(2);
    }
  }

  function formatScheduledMinutes(scheduledMinutes) {
    var normalizedMinutes = Number(scheduledMinutes);

    if (!Number.isSafeInteger(normalizedMinutes) || normalizedMinutes <= 0) {
      return null;
    }

    var wholeHours = Math.floor(normalizedMinutes / 60);
    var remainingMinutes = normalizedMinutes % 60;

    if (wholeHours === 0) {
      return remainingMinutes + (remainingMinutes === 1 ? " minute" : " minutes");
    }

    if (remainingMinutes === 0) {
      return wholeHours + (wholeHours === 1 ? " hour" : " hours");
    }

    return (
      wholeHours +
      (wholeHours === 1 ? " hour " : " hours ") +
      remainingMinutes +
      (remainingMinutes === 1 ? " minute" : " minutes")
    );
  }

  function getSelectedOptionLabel(selectElement) {
    if (!selectElement || selectElement.selectedIndex < 0) {
      return null;
    }

    var selectedOption = selectElement.options[selectElement.selectedIndex];

    if (!selectedOption || !selectedOption.value) {
      return null;
    }

    return selectedOption.textContent.replace(/\s+/g, " ").trim();
  }

  function focusFormField(field) {
    if (!field) return;

    if (
      field.tagName === "SELECT" &&
      window.jQuery &&
      window.jQuery.fn.select2 &&
      window.jQuery(field).hasClass("select2-hidden-accessible")
    ) {
      window.jQuery(field).select2("open");
      return;
    }

    if (field._flatpickr) {
      field._flatpickr.open();
      return;
    }

    field.focus();
  }

  function getMaximumOccurrenceCount() {
    var maximum = Number(
      postShiftForm?.dataset.maximumOccurrenceCount ||
        manageShiftsPage?.dataset.maximumOccurrenceCount ||
        30
    );

    return Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 30;
  }

  /* ─────────────────────────────── POST SHIFT ALERT ─────────────────────────────── */

  function showPostShiftFormAlert(message) {
    if (!postShiftFormAlert) return;

    postShiftFormAlert.textContent = message;
    postShiftFormAlert.classList.remove("d-none");

    postShiftFormAlert.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  function hidePostShiftFormAlert() {
    if (!postShiftFormAlert) return;

    postShiftFormAlert.textContent = "";
    postShiftFormAlert.classList.add("d-none");
  }

  /* ─────────────────────────────── SELECT2 ─────────────────────────────── */

  function initializeSelect2Field(selectElement, options) {
    if (!selectElement || !window.jQuery || !window.jQuery.fn.select2) {
      return;
    }

    var select = window.jQuery(selectElement);

    if (select.hasClass("select2-hidden-accessible")) {
      return;
    }

    var modalElement = selectElement.closest(".modal");

    var placeholderOption = selectElement.querySelector('option[value=""]');

    select.select2({
      width: "100%",

      dropdownParent: modalElement ? window.jQuery(modalElement) : window.jQuery(document.body),

      placeholder:
        options?.placeholder || placeholderOption?.textContent?.trim() || "Select an option",

      minimumResultsForSearch:
        options?.minimumResultsForSearch === undefined ? 0 : options.minimumResultsForSearch,
    });

    select.on("change", function () {
      clearSelect2InvalidState(selectElement);
      updatePricingPreview();
    });
  }

  function initializeShiftSelect2() {
    initializeSelect2Field(branchSelect, {
      placeholder: "Select a branch",
      minimumResultsForSearch: 0,
    });

    initializeSelect2Field(professionalTypeSelect, {
      placeholder: "Select a professional type",
      minimumResultsForSearch: Infinity,
    });
  }

  function setSelect2InvalidState(selectElement) {
    if (!selectElement || !window.jQuery) {
      return;
    }

    window.jQuery(selectElement).next(".select2").find(".select2-selection").addClass("is-invalid");
  }

  function clearSelect2InvalidState(selectElement) {
    if (!selectElement || !window.jQuery) {
      return;
    }

    window
      .jQuery(selectElement)
      .next(".select2")
      .find(".select2-selection")
      .removeClass("is-invalid");
  }

  function validateSelect2Fields() {
    var isValid = true;

    clearSelect2InvalidState(branchSelect);
    clearSelect2InvalidState(professionalTypeSelect);

    if (branchSelect?.required && !branchSelect.value) {
      setSelect2InvalidState(branchSelect);
      isValid = false;
    }

    if (professionalTypeSelect?.required && !professionalTypeSelect.value) {
      setSelect2InvalidState(professionalTypeSelect);
      isValid = false;
    }

    return isValid;
  }

  function getOnlySelectableValue(selectElement) {
    if (!selectElement) {
      return "";
    }

    var options = Array.from(selectElement.options).filter(function (option) {
      return option.value && !option.disabled;
    });

    return options.length === 1 ? options[0].value : "";
  }

  function resetSelect2Fields() {
    var professionalTypeValue = getOnlySelectableValue(professionalTypeSelect);

    if (window.jQuery && window.jQuery.fn.select2) {
      if (branchSelect) {
        window.jQuery(branchSelect).val("").trigger("change");
      }

      if (professionalTypeSelect) {
        window.jQuery(professionalTypeSelect).val(professionalTypeValue).trigger("change");
      }
    } else {
      if (branchSelect) {
        branchSelect.value = "";
      }

      if (professionalTypeSelect) {
        professionalTypeSelect.value = professionalTypeValue;
      }
    }

    clearSelect2InvalidState(branchSelect);
    clearSelect2InvalidState(professionalTypeSelect);
  }

  /* ─────────────────────────────── SCHEDULE MODE / PICKERS ─────────────────────────────── */

  function getScheduleMode() {
    var selectedInput = scheduleModeInputs.find(function (input) {
      return input.checked;
    });

    return selectedInput?.value === "multiple" ? "multiple" : "single";
  }

  function setFlatpickrInputEnabled(input, enabled) {
    if (!input) return;

    input.disabled = !enabled;

    if (input._flatpickr?.altInput) {
      input._flatpickr.altInput.disabled = !enabled;
    }
  }

  function setInputRequired(input, required) {
    if (!input) return;

    input.required = required;
  }

  function clearFieldValidation(input) {
    if (!input) return;

    input.classList.remove("is-invalid", "is-valid");

    if (input._flatpickr?.altInput) {
      input._flatpickr.altInput.classList.remove("is-invalid", "is-valid");
    }
  }

  function setRepeatDaysFeedbackVisible(visible) {
    repeatDaysFeedback?.classList.toggle("d-none", !visible);
  }

  function syncFirstDateRepeatDay() {
    var firstOccurrenceDate = normalizeLocalDate(firstOccurrenceDateInput?.value);

    if (!firstOccurrenceDate) {
      return;
    }

    var weekday = getLocalDateWeekday(firstOccurrenceDate);

    repeatDayInputs.forEach(function (input) {
      if (Number(input.value) === weekday) {
        input.checked = true;
      }
    });

    setRepeatDaysFeedbackVisible(false);
  }

  function applyScheduleMode() {
    var isMultiple = getScheduleMode() === "multiple";

    singleScheduleFields?.classList.toggle("d-none", isMultiple);
    multipleScheduleFields?.classList.toggle("d-none", !isMultiple);

    [singleDateInput, singleStartTimeInput, singleEndTimeInput].forEach(function (input) {
      setFlatpickrInputEnabled(input, !isMultiple);
      setInputRequired(input, !isMultiple);
    });

    if (singleEndsNextDayInput) {
      singleEndsNextDayInput.disabled = isMultiple;
    }

    if (startTimeInput) {
      startTimeInput.disabled = isMultiple;
      startTimeInput.required = false;
    }

    if (endTimeInput) {
      endTimeInput.disabled = isMultiple;
      endTimeInput.required = false;
    }

    setFlatpickrInputEnabled(firstOccurrenceDateInput, isMultiple);
    setFlatpickrInputEnabled(dailyStartTimeInput, isMultiple);
    setFlatpickrInputEnabled(dailyEndTimeInput, isMultiple);

    setInputRequired(firstOccurrenceDateInput, isMultiple);
    setInputRequired(dailyStartTimeInput, isMultiple);
    setInputRequired(dailyEndTimeInput, isMultiple);

    if (occurrenceCountInput) {
      occurrenceCountInput.disabled = !isMultiple;
      occurrenceCountInput.required = isMultiple;
    }

    if (endsNextDayInput) {
      endsNextDayInput.disabled = !isMultiple;
    }

    repeatDayInputs.forEach(function (input) {
      input.disabled = !isMultiple;
    });

    if (isMultiple) {
      if (startTimeInput) {
        startTimeInput.value = "";
      }

      if (endTimeInput) {
        endTimeInput.value = "";
      }
    } else {
      setRepeatDaysFeedbackVisible(false);
      syncSingleScheduleFields();
    }

    [
      singleDateInput,
      singleStartTimeInput,
      singleEndTimeInput,
      firstOccurrenceDateInput,
      dailyStartTimeInput,
      dailyEndTimeInput,
      occurrenceCountInput,
    ].forEach(clearFieldValidation);

    renderOccurrencePreview();
    updatePricingPreview();
  }

  function initializeDateTimePickers() {
    if (!window.flatpickr) return;

    if (singleDateInput && !singleDatePicker) {
      singleDatePicker = window.flatpickr(singleDateInput, {
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "F j, Y",
        minDate: "today",
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          syncSingleScheduleFields();
          updatePricingPreview();
        },
      });
    }

    if (singleStartTimeInput && !singleStartTimePicker) {
      singleStartTimePicker = window.flatpickr(singleStartTimeInput, {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",
        altInput: true,
        altFormat: "h:i K",
        minuteIncrement: 5,
        time_24hr: false,
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          syncSingleScheduleFields();
          updatePricingPreview();
        },
      });
    }

    if (singleEndTimeInput && !singleEndTimePicker) {
      singleEndTimePicker = window.flatpickr(singleEndTimeInput, {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",
        altInput: true,
        altFormat: "h:i K",
        minuteIncrement: 5,
        time_24hr: false,
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          syncSingleScheduleFields();
          updatePricingPreview();
        },
      });
    }

    if (firstOccurrenceDateInput && !firstOccurrenceDatePicker) {
      firstOccurrenceDatePicker = window.flatpickr(firstOccurrenceDateInput, {
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "F j, Y",
        minDate: "today",
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          syncFirstDateRepeatDay();
          renderOccurrencePreview();
          updatePricingPreview();
        },
      });
    }

    if (dailyStartTimeInput && !dailyStartTimePicker) {
      dailyStartTimePicker = window.flatpickr(dailyStartTimeInput, {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",
        altInput: true,
        altFormat: "h:i K",
        minuteIncrement: 5,
        time_24hr: false,
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          renderOccurrencePreview();
          updatePricingPreview();
        },
      });
    }

    if (dailyEndTimeInput && !dailyEndTimePicker) {
      dailyEndTimePicker = window.flatpickr(dailyEndTimeInput, {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",
        altInput: true,
        altFormat: "h:i K",
        minuteIncrement: 5,
        time_24hr: false,
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          renderOccurrencePreview();
          updatePricingPreview();
        },
      });
    }

    applyScheduleMode();
  }

  function resetDateTimePickers() {
    [
      singleDatePicker,
      singleStartTimePicker,
      singleEndTimePicker,
      firstOccurrenceDatePicker,
      dailyStartTimePicker,
      dailyEndTimePicker,
    ]
      .filter(Boolean)
      .forEach(function (picker) {
        picker.clear();
      });

    singleDatePicker?.set("minDate", "today");
    firstOccurrenceDatePicker?.set("minDate", "today");

    if (startTimeInput) {
      startTimeInput.value = "";
    }

    if (endTimeInput) {
      endTimeInput.value = "";
    }
  }

  function calculateScheduledMinutes(startMinutes, endMinutes, endsNextDay) {
    if (!Number.isSafeInteger(startMinutes) || !Number.isSafeInteger(endMinutes)) {
      return null;
    }

    var scheduledMinutes = endsNextDay
      ? MINUTES_PER_DAY - startMinutes + endMinutes
      : endMinutes - startMinutes;

    if (
      !Number.isSafeInteger(scheduledMinutes) ||
      scheduledMinutes <= 0 ||
      scheduledMinutes > MINUTES_PER_DAY
    ) {
      return null;
    }

    return scheduledMinutes;
  }

  function buildLocalDateTimeValue(localDate, timeMinutes, daysToAdd) {
    var adjustedDate = addDaysToLocalDate(localDate, daysToAdd || 0);

    var localTime = formatTimeMinutes(timeMinutes);

    if (!adjustedDate || !localTime) {
      return "";
    }

    return adjustedDate + "T" + localTime;
  }

  function syncSingleScheduleFields() {
    if (!startTimeInput || !endTimeInput) {
      return {
        startTimeValue: "",
        endTimeValue: "",
      };
    }

    if (getScheduleMode() !== "single") {
      startTimeInput.value = "";
      endTimeInput.value = "";

      return {
        startTimeValue: "",
        endTimeValue: "",
      };
    }

    var localDate = normalizeLocalDate(singleDateInput?.value);

    var startMinutes = parseTimeMinutes(singleStartTimeInput?.value);

    var endMinutes = parseTimeMinutes(singleEndTimeInput?.value);

    var endsNextDay = Boolean(singleEndsNextDayInput?.checked);

    var startTimeValue = buildLocalDateTimeValue(localDate, startMinutes, 0);

    var endTimeValue = buildLocalDateTimeValue(localDate, endMinutes, endsNextDay ? 1 : 0);

    startTimeInput.value = startTimeValue;
    endTimeInput.value = endTimeValue;

    return {
      localDate,
      startMinutes,
      endMinutes,
      endsNextDay,
      startTimeValue,
      endTimeValue,
    };
  }

  function getSelectedRepeatDays() {
    return repeatDayInputs
      .filter(function (input) {
        return input.checked && !input.disabled;
      })
      .map(function (input) {
        return Number(input.value);
      });
  }

  function buildSingleScheduleData() {
    var singleSchedule = syncSingleScheduleFields();

    var startTime = parseLagosDateTime(singleSchedule.startTimeValue);

    var endTime = parseLagosDateTime(singleSchedule.endTimeValue);

    var scheduledMinutesPerOccurrence = calculateScheduledMinutes(
      singleSchedule.startMinutes,
      singleSchedule.endMinutes,
      singleSchedule.endsNextDay
    );

    var baseResult = {
      scheduleMode: "single",
      occurrenceCount: 1,
      repeatDays: [],
      localDate: singleSchedule.localDate || null,
      startTimeMinutes: singleSchedule.startMinutes,
      endTimeMinutes: singleSchedule.endMinutes,
      endsNextDay: Boolean(singleSchedule.endsNextDay),
      scheduledMinutesPerOccurrence,
      totalScheduledMinutes: null,
      occurrences: [],
      complete: false,
    };

    if (
      !singleSchedule.localDate ||
      !startTime ||
      !endTime ||
      !Number.isSafeInteger(scheduledMinutesPerOccurrence) ||
      endTime <= startTime
    ) {
      return baseResult;
    }

    return {
      ...baseResult,

      totalScheduledMinutes: scheduledMinutesPerOccurrence,

      complete: true,

      occurrences: [
        {
          sequenceNumber: 1,

          localDate: singleSchedule.localDate,

          startTime,

          endTime,

          occurrenceDateDisplay: formatLocalDateForDisplay(singleSchedule.localDate),

          startTimeDisplay: formatTimeMinutesForDisplay(singleSchedule.startMinutes),

          endTimeDisplay: formatTimeMinutesForDisplay(singleSchedule.endMinutes),

          scheduledMinutes: scheduledMinutesPerOccurrence,
        },
      ],
    };
  }

  function buildMultipleScheduleData() {
    var firstOccurrenceDate = normalizeLocalDate(firstOccurrenceDateInput?.value);

    var occurrenceCount = Number(occurrenceCountInput?.value);

    var repeatDays = getSelectedRepeatDays();

    var dailyStartTimeMinutes = parseTimeMinutes(dailyStartTimeInput?.value);

    var dailyEndTimeMinutes = parseTimeMinutes(dailyEndTimeInput?.value);

    var endsNextDay = Boolean(endsNextDayInput?.checked);

    var scheduledMinutesPerOccurrence = calculateScheduledMinutes(
      dailyStartTimeMinutes,
      dailyEndTimeMinutes,
      endsNextDay
    );

    var maximumOccurrenceCount = getMaximumOccurrenceCount();

    var baseResult = {
      scheduleMode: "multiple",
      occurrenceCount,
      repeatDays,
      firstOccurrenceDate,
      dailyStartTimeMinutes,
      dailyEndTimeMinutes,
      endsNextDay,
      scheduledMinutesPerOccurrence,
      totalScheduledMinutes: null,
      occurrences: [],
      complete: false,
    };

    if (
      !firstOccurrenceDate ||
      !Number.isSafeInteger(occurrenceCount) ||
      occurrenceCount < 2 ||
      occurrenceCount > maximumOccurrenceCount ||
      repeatDays.length === 0 ||
      !Number.isSafeInteger(scheduledMinutesPerOccurrence)
    ) {
      return baseResult;
    }

    var firstWeekday = getLocalDateWeekday(firstOccurrenceDate);

    if (!repeatDays.includes(firstWeekday)) {
      return baseResult;
    }

    var occurrences = [];
    var currentDate = firstOccurrenceDate;
    var inspectedDays = 0;

    while (occurrences.length < occurrenceCount && inspectedDays <= 366) {
      var weekday = getLocalDateWeekday(currentDate);

      if (repeatDays.includes(weekday)) {
        var sequenceNumber = occurrences.length + 1;

        var startTime = buildLagosDateTime(currentDate, dailyStartTimeMinutes, 0);

        var endTime = buildLagosDateTime(currentDate, dailyEndTimeMinutes, endsNextDay ? 1 : 0);

        if (!startTime || !endTime) {
          return baseResult;
        }

        occurrences.push({
          sequenceNumber,
          localDate: currentDate,
          startTime,
          endTime,

          occurrenceDateDisplay: formatLocalDateForDisplay(currentDate),

          startTimeDisplay: formatTimeMinutesForDisplay(dailyStartTimeMinutes),

          endTimeDisplay: formatTimeMinutesForDisplay(dailyEndTimeMinutes),

          scheduledMinutes: scheduledMinutesPerOccurrence,
        });
      }

      currentDate = addDaysToLocalDate(currentDate, 1);
      inspectedDays += 1;
    }

    if (occurrences.length !== occurrenceCount) {
      return baseResult;
    }

    return {
      ...baseResult,

      occurrences,

      totalScheduledMinutes: scheduledMinutesPerOccurrence * occurrenceCount,

      complete: true,
    };
  }

  function getCurrentScheduleData() {
    return getScheduleMode() === "multiple"
      ? buildMultipleScheduleData()
      : buildSingleScheduleData();
  }

  function renderOccurrencePreview() {
    if (!occurrencePreviewBody) {
      return;
    }

    var scheduleData = buildMultipleScheduleData();

    var occurrenceCount = Number(occurrenceCountInput?.value);

    setText(
      generatedOccurrenceCount,

      Number.isSafeInteger(occurrenceCount) && occurrenceCount > 0
        ? occurrenceCount + (occurrenceCount === 1 ? " Shift" : " Shifts")
        : "0 Shifts"
    );

    occurrencePreviewBody.innerHTML = "";

    if (!scheduleData.complete || scheduleData.occurrences.length === 0) {
      occurrencePreviewEmptyState?.classList.remove("d-none");
      occurrencePreviewTableWrapper?.classList.add("d-none");
      return;
    }

    scheduleData.occurrences.forEach(function (occurrence) {
      var row = document.createElement("tr");

      row.innerHTML =
        '<td class="fw-bold text-gray-700">' +
        escapeHtml(occurrence.sequenceNumber) +
        "</td>" +
        '<td class="fw-semibold text-gray-900">' +
        escapeHtml(occurrence.occurrenceDateDisplay) +
        "</td>" +
        '<td class="text-gray-700">' +
        escapeHtml(occurrence.startTimeDisplay) +
        " – " +
        escapeHtml(occurrence.endTimeDisplay) +
        (scheduleData.endsNextDay ? ' <span class="fs-8 text-muted">(next day)</span>' : "") +
        "</td>" +
        '<td class="text-gray-700">' +
        escapeHtml(formatScheduledMinutes(occurrence.scheduledMinutes) || "—") +
        "</td>";

      occurrencePreviewBody.appendChild(row);
    });

    occurrencePreviewEmptyState?.classList.add("d-none");
    occurrencePreviewTableWrapper?.classList.remove("d-none");
  }

  function resetOccurrencePreview() {
    if (occurrencePreviewBody) {
      occurrencePreviewBody.innerHTML = "";
    }

    setText(generatedOccurrenceCount, "0 Shifts");

    occurrencePreviewEmptyState?.classList.remove("d-none");

    occurrencePreviewTableWrapper?.classList.add("d-none");

    setRepeatDaysFeedbackVisible(false);
  }

  function handleScheduleControls() {
    scheduleModeInputs.forEach(function (input) {
      input.addEventListener("change", applyScheduleMode);
    });

    [singleDateInput, singleStartTimeInput, singleEndTimeInput]
      .filter(Boolean)
      .forEach(function (input) {
        input.addEventListener("input", function () {
          syncSingleScheduleFields();
          updatePricingPreview();
        });

        input.addEventListener("change", function () {
          syncSingleScheduleFields();
          updatePricingPreview();
        });
      });

    singleEndsNextDayInput?.addEventListener("change", function () {
      syncSingleScheduleFields();
      updatePricingPreview();
    });

    [firstOccurrenceDateInput, occurrenceCountInput, dailyStartTimeInput, dailyEndTimeInput]
      .filter(Boolean)
      .forEach(function (input) {
        input.addEventListener("input", function () {
          renderOccurrencePreview();
          updatePricingPreview();
        });

        input.addEventListener("change", function () {
          renderOccurrencePreview();
          updatePricingPreview();
        });
      });

    endsNextDayInput?.addEventListener("change", function () {
      renderOccurrencePreview();
      updatePricingPreview();
    });

    repeatDayInputs.forEach(function (input) {
      input.addEventListener("change", function () {
        setRepeatDaysFeedbackVisible(false);
        renderOccurrencePreview();
        updatePricingPreview();
      });
    });
  }

  /* ─────────────────────────────── PRICING PREVIEW ─────────────────────────────── */

  function resetPricingPreview() {
    setText(occurrenceCountPreview, null);
    setText(scheduledHoursPerOccurrencePreview, null);
    setText(scheduledHoursPreview, null);
    setText(employerChargePerOccurrencePreview, null);
    setText(professionalPayPreview, null);
    setText(platformFeePreview, null);
    setText(employerChargePreview, null);
  }

  function updatePricingPreview() {
    if (!postShiftForm) return;

    var scheduleData = getCurrentScheduleData();

    var hourlyRateMajorUnit = parseNumber(hourlyRateInput?.value);

    var platformFeeRate = Number(postShiftForm.dataset.platformFeeRate);

    var currency = getCurrency();

    resetPricingPreview();

    var displayedOccurrenceCount =
      scheduleData.scheduleMode === "multiple" &&
      Number.isSafeInteger(scheduleData.occurrenceCount) &&
      scheduleData.occurrenceCount > 0
        ? scheduleData.occurrenceCount
        : 1;

    setText(
      occurrenceCountPreview,

      displayedOccurrenceCount + (displayedOccurrenceCount === 1 ? " Shift" : " Shifts")
    );

    if (
      !Number.isSafeInteger(scheduleData.scheduledMinutesPerOccurrence) ||
      scheduleData.scheduledMinutesPerOccurrence <= 0
    ) {
      return;
    }

    setText(
      scheduledHoursPerOccurrencePreview,

      formatScheduledMinutes(scheduleData.scheduledMinutesPerOccurrence)
    );

    if (
      Number.isSafeInteger(scheduleData.totalScheduledMinutes) &&
      scheduleData.totalScheduledMinutes > 0
    ) {
      setText(
        scheduledHoursPreview,

        formatScheduledMinutes(scheduleData.totalScheduledMinutes)
      );
    }

    if (
      hourlyRateMajorUnit === null ||
      hourlyRateMajorUnit <= 0 ||
      !Number.isFinite(platformFeeRate) ||
      platformFeeRate < 0 ||
      platformFeeRate > 1
    ) {
      return;
    }

    var hourlyRateMinorUnit = Math.round(hourlyRateMajorUnit * 100);

    var perOccurrenceProfessionalPay = Math.round(
      (hourlyRateMinorUnit * scheduleData.scheduledMinutesPerOccurrence) / 60
    );

    var perOccurrencePlatformFee = Math.round(perOccurrenceProfessionalPay * platformFeeRate);

    var perOccurrenceEmployerCharge = perOccurrenceProfessionalPay + perOccurrencePlatformFee;

    var occurrenceCount = scheduleData.complete
      ? scheduleData.occurrenceCount
      : displayedOccurrenceCount;

    var totalProfessionalPay = perOccurrenceProfessionalPay * occurrenceCount;

    var totalPlatformFee = perOccurrencePlatformFee * occurrenceCount;

    var totalEmployerCharge = perOccurrenceEmployerCharge * occurrenceCount;

    setText(
      employerChargePerOccurrencePreview,

      formatMoneyFromMinorUnit(perOccurrenceEmployerCharge, currency)
    );

    setText(
      professionalPayPreview,

      formatMoneyFromMinorUnit(totalProfessionalPay, currency)
    );

    setText(
      platformFeePreview,

      formatMoneyFromMinorUnit(totalPlatformFee, currency)
    );

    setText(
      employerChargePreview,

      formatMoneyFromMinorUnit(totalEmployerCharge, currency)
    );
  }

  function handlePricingPreview() {
    [breakDurationInput, hourlyRateInput].filter(Boolean).forEach(function (input) {
      input.addEventListener("input", updatePricingPreview);
      input.addEventListener("change", updatePricingPreview);
    });

    updatePricingPreview();
  }

  /* ─────────────────────────────── FORM VALIDATION ─────────────────────────────── */

  function validateRequiredSkills() {
    if (!requiredSkillsInput) {
      return null;
    }

    var skills = requiredSkillsInput.value
      .split(",")
      .map(function (skill) {
        return skill.trim();
      })
      .filter(Boolean);

    if (skills.length > 20) {
      return {
        message: "A Shift cannot contain more than 20 required skills.",

        field: requiredSkillsInput,
      };
    }

    var hasLongSkill = skills.some(function (skill) {
      return skill.length > 100;
    });

    if (hasLongSkill) {
      return {
        message: "Each required skill cannot exceed 100 characters.",

        field: requiredSkillsInput,
      };
    }

    return null;
  }

  function validateSingleSchedule() {
    var localDate = normalizeLocalDate(singleDateInput?.value);

    if (!localDate) {
      return {
        message: "Select a valid Shift date.",

        field: singleDateInput,
      };
    }

    var startMinutes = parseTimeMinutes(singleStartTimeInput?.value);

    if (!Number.isSafeInteger(startMinutes)) {
      return {
        message: "Select a valid Shift start time.",

        field: singleStartTimeInput,
      };
    }

    var endMinutes = parseTimeMinutes(singleEndTimeInput?.value);

    if (!Number.isSafeInteger(endMinutes)) {
      return {
        message: "Select a valid Shift end time.",

        field: singleEndTimeInput,
      };
    }

    var endsNextDay = Boolean(singleEndsNextDayInput?.checked);

    var scheduledMinutes = calculateScheduledMinutes(startMinutes, endMinutes, endsNextDay);

    if (!scheduledMinutes) {
      return {
        message:
          "The Shift must last between 1 minute and 24 hours. Enable This Shift ends the next day for an overnight Shift.",

        field: singleEndTimeInput,
      };
    }

    var synchronizedSchedule = syncSingleScheduleFields();

    var startTime = parseLagosDateTime(synchronizedSchedule.startTimeValue);

    var endTime = parseLagosDateTime(synchronizedSchedule.endTimeValue);

    if (!startTime) {
      return {
        message: "The Shift start date and time could not be generated.",

        field: singleStartTimeInput,
      };
    }

    if (!endTime || endTime <= startTime) {
      return {
        message: "Shift end time must be later than start time.",

        field: singleEndTimeInput,
      };
    }

    if (startTime <= new Date()) {
      return {
        message: "Shift start time must be in the future.",

        field: singleStartTimeInput,
      };
    }

    return {
      scheduledMinutes,
      startTime,
      endTime,
    };
  }

  function validateMultipleSchedule() {
    var firstOccurrenceDate = normalizeLocalDate(firstOccurrenceDateInput?.value);

    if (!firstOccurrenceDate) {
      return {
        message: "Select a valid first Shift date.",

        field: firstOccurrenceDateInput,
      };
    }

    var occurrenceCount = Number(occurrenceCountInput?.value);

    var maximumOccurrenceCount = getMaximumOccurrenceCount();

    if (
      !Number.isSafeInteger(occurrenceCount) ||
      occurrenceCount < 2 ||
      occurrenceCount > maximumOccurrenceCount
    ) {
      return {
        message: "Number of Shifts must be between 2 and " + maximumOccurrenceCount + ".",

        field: occurrenceCountInput,
      };
    }

    var repeatDays = getSelectedRepeatDays();

    if (repeatDays.length === 0) {
      setRepeatDaysFeedbackVisible(true);

      return {
        message: "Select at least one repeat day.",

        field: repeatDayInputs[0] || firstOccurrenceDateInput,
      };
    }

    var firstWeekday = getLocalDateWeekday(firstOccurrenceDate);

    if (!repeatDays.includes(firstWeekday)) {
      setRepeatDaysFeedbackVisible(true);

      return {
        message: "The first Shift date must fall on one of the selected repeat days.",

        field: firstOccurrenceDateInput,
      };
    }

    var dailyStartTimeMinutes = parseTimeMinutes(dailyStartTimeInput?.value);

    var dailyEndTimeMinutes = parseTimeMinutes(dailyEndTimeInput?.value);

    if (!Number.isSafeInteger(dailyStartTimeMinutes)) {
      return {
        message: "Select a valid start time for each Shift.",

        field: dailyStartTimeInput,
      };
    }

    if (!Number.isSafeInteger(dailyEndTimeMinutes)) {
      return {
        message: "Select a valid end time for each Shift.",

        field: dailyEndTimeInput,
      };
    }

    var scheduledMinutes = calculateScheduledMinutes(
      dailyStartTimeMinutes,
      dailyEndTimeMinutes,
      Boolean(endsNextDayInput?.checked)
    );

    if (!scheduledMinutes) {
      return {
        message:
          "Each Shift must last between 1 minute and 24 hours. Enable Ends next day for an overnight Shift.",

        field: dailyEndTimeInput,
      };
    }

    var firstStartTime = buildLagosDateTime(firstOccurrenceDate, dailyStartTimeMinutes, 0);

    if (!firstStartTime || firstStartTime <= new Date()) {
      return {
        message: "The first Shift start time must be in the future.",

        field: firstOccurrenceDateInput,
      };
    }

    var scheduleData = buildMultipleScheduleData();

    if (!scheduleData.complete || scheduleData.occurrences.length !== occurrenceCount) {
      return {
        message: "The selected repeat pattern could not generate the requested Shifts.",

        field: firstOccurrenceDateInput,
      };
    }

    setRepeatDaysFeedbackVisible(false);

    return {
      scheduledMinutes,
    };
  }

  function validatePostShiftForm() {
    hidePostShiftFormAlert();

    postShiftForm.classList.add("was-validated");

    if (getScheduleMode() === "single") {
      syncSingleScheduleFields();
    }

    var select2FieldsAreValid = validateSelect2Fields();

    if (!postShiftForm.checkValidity() || !select2FieldsAreValid) {
      return {
        message: "Complete all required Shift details before creating it.",

        field: null,
      };
    }

    var scheduleValidation =
      getScheduleMode() === "multiple" ? validateMultipleSchedule() : validateSingleSchedule();

    if (scheduleValidation?.message) {
      return scheduleValidation;
    }

    var scheduledMinutes = scheduleValidation.scheduledMinutes;

    var breakDuration = parseNumber(breakDurationInput?.value);

    if (breakDuration === null) {
      breakDuration = 0;
    }

    if (
      !Number.isSafeInteger(breakDuration) ||
      breakDuration < 0 ||
      breakDuration > MINUTES_PER_DAY
    ) {
      return {
        message: "Break duration must be a whole number from 0 to 1,440 minutes.",

        field: breakDurationInput,
      };
    }

    if (breakDuration >= scheduledMinutes) {
      return {
        message: "Break duration must be shorter than each Shift.",

        field: breakDurationInput,
      };
    }

    var hourlyRateValue = String(hourlyRateInput?.value || "")
      .replace(/,/g, "")
      .trim();

    var hourlyRate = Number(hourlyRateValue);

    if (
      !/^\d+(\.\d{1,2})?$/.test(hourlyRateValue) ||
      !Number.isFinite(hourlyRate) ||
      hourlyRate <= 0
    ) {
      return {
        message: "Enter a valid hourly rate greater than zero.",

        field: hourlyRateInput,
      };
    }

    return validateRequiredSkills();
  }

  /* ─────────────────────────────── POST SHIFT SUBMISSION ─────────────────────────────── */

  function buildShiftSubmissionData() {
    if (getScheduleMode() === "single") {
      syncSingleScheduleFields();
    }

    var formData = new FormData(postShiftForm);

    var data = {};

    formData.forEach(function (value, key) {
      if (key !== "repeatDays") {
        data[key] = value;
      }
    });

    var scheduleMode = getScheduleMode();

    data.scheduleMode = scheduleMode;

    delete data.singleShiftDate;
    delete data.singleStartTime;
    delete data.singleEndTime;
    delete data.singleEndsNextDay;

    if (scheduleMode === "multiple") {
      delete data.startTime;
      delete data.endTime;

      data.repeatDays = formData.getAll("repeatDays");

      data.occurrenceCount = Number(occurrenceCountInput.value);

      data.endsNextDay = Boolean(endsNextDayInput?.checked);
    } else {
      data.startTime = startTimeInput?.value || "";

      data.endTime = endTimeInput?.value || "";

      data.occurrenceCount = 1;

      data.repeatDays = [];

      data.endsNextDay = false;
    }

    return data;
  }

  function resetPostShiftForm() {
    if (!postShiftForm) return;

    postShiftForm.reset();

    postShiftForm.classList.remove("was-validated");

    hidePostShiftFormAlert();

    resetSelect2Fields();

    resetDateTimePickers();

    resetOccurrencePreview();

    if (breakDurationInput) {
      breakDurationInput.value = "0";
    }

    if (occurrenceCountInput) {
      occurrenceCountInput.value = "2";
    }

    if (singleEndsNextDayInput) {
      singleEndsNextDayInput.checked = false;
    }

    if (startTimeInput) {
      startTimeInput.value = "";
    }

    if (endTimeInput) {
      endTimeInput.value = "";
    }

    if (endsNextDayInput) {
      endsNextDayInput.checked = false;
    }

    repeatDayInputs.forEach(function (input) {
      input.checked = false;
    });

    scheduleModeInputs.forEach(function (input) {
      input.checked = input.value === "single";
    });

    applyScheduleMode();

    resetPricingPreview();

    updatePricingPreview();
  }

  function buildFundingStateFromCreatePayload(payload) {
    var paymentReview = payload.paymentReview || {};

    var schedule = paymentReview.schedule || payload.schedule || {};

    var paymentOptions = paymentReview.paymentOptions || {};

    var wallet = paymentOptions.wallet || {};

    var paystack = paymentOptions.paystackCheckout || {};

    var actions = paymentReview.actions || {};

    var shift = payload.shift || {};

    return {
      shiftId: paymentReview.shiftId || shift.id || shift._id,

      referenceCode: paymentReview.referenceCode || shift.referenceCode,

      roleTitle: document.querySelector("#shiftRoleTitle")?.value || "—",

      branchName: getSelectedOptionLabel(branchSelect) || "—",

      scheduleSummary: buildCreatedScheduleSummary(schedule),

      actionLabel: paymentReview.actionLabel || "Complete Payment",

      employerCharge: paymentReview.employerCharge,

      employerChargeDisplay: paymentReview.employerChargeDisplay,

      professionalPayDisplay: paymentReview.professionalPayDisplay,

      platformFeeDisplay: paymentReview.platformFeeDisplay,

      occurrenceCountLabel: schedule.occurrenceCountLabel,

      hoursPerShiftDisplay: schedule.scheduledHoursPerOccurrenceDisplay,

      totalHoursDisplay: schedule.totalScheduledHoursDisplay,

      walletFundingUrl: actions.fundFromWalletUrl,

      checkoutUrl: actions.initializeCheckoutUrl,

      walletCanUse: wallet.canUse,

      walletAvailableBalanceDisplay: wallet.availableBalanceDisplay,

      walletBalanceAfterPaymentDisplay: wallet.balanceAfterPaymentDisplay,

      walletShortfall: wallet.shortfall,

      walletShortfallDisplay: wallet.shortfallDisplay,

      walletUnavailableMessage: wallet.unavailableMessage,

      paystackCanUse: paystack.canUse,

      paystackDescription: paystack.description,

      redirectUrl:
        payload.shiftDetailsUrl || shift.detailsUrl || "/employer/shifts?status=pending_funding",
    };
  }

  function buildCreatedScheduleSummary(schedule) {
    if (!schedule) {
      return "—";
    }

    if (schedule.scheduleMode === "multiple") {
      var parts = [
        schedule.occurrenceCountLabel,

        schedule.repeatDaysLabel,

        schedule.firstOccurrenceDateDisplay && schedule.lastOccurrenceDateDisplay
          ? schedule.firstOccurrenceDateDisplay + " – " + schedule.lastOccurrenceDateDisplay
          : null,
      ];

      if (schedule.occurrences?.[0]) {
        parts.push(
          schedule.occurrences[0].startTimeDisplay + " – " + schedule.occurrences[0].endTimeDisplay
        );
      }

      return parts.filter(Boolean).join(" • ");
    }

    var occurrence = schedule.occurrences?.[0];

    if (occurrence) {
      return (
        occurrence.occurrenceDateDisplay +
        " • " +
        occurrence.startTimeDisplay +
        " – " +
        occurrence.endTimeDisplay
      );
    }

    return schedule.firstOccurrenceDateDisplay || "—";
  }

  function openFundingModalAfterCreation(payload) {
    var state = buildFundingStateFromCreatePayload(payload);

    createdShiftRedirectUrl = state.redirectUrl;

    var showFundingModal = function () {
      resetPostShiftForm();

      populateFundingModal(state);

      fundShiftModal?.show();
    };

    if (postShiftModalElement && postShiftModal) {
      postShiftModalElement.addEventListener("hidden.bs.modal", showFundingModal, {
        once: true,
      });

      postShiftModal.hide();

      return;
    }

    showFundingModal();
  }

  function submitShiftDetails() {
    var validationError = validatePostShiftForm();

    if (validationError) {
      showPostShiftFormAlert(validationError.message);

      focusFormField(validationError.field);

      return;
    }

    hidePostShiftFormAlert();

    setButtonLoading(postShiftSubmitButton, true, false);

    axios
      .post(postShiftForm.action, buildShiftSubmissionData())
      .then(function (response) {
        setButtonLoading(postShiftSubmitButton, false, false);

        openFundingModalAfterCreation(getResponsePayload(response));
      })
      .catch(function (error) {
        setButtonLoading(postShiftSubmitButton, false, false);

        var errorMessage = getErrorMessage(
          error,

          "The Shift could not be created. Please try again."
        );

        showPostShiftFormAlert(errorMessage);

        showAlert({
          text: errorMessage,

          icon: "error",
        });
      });
  }

  function initializePostShiftForm() {
    postShiftForm = document.querySelector("#postShiftForm");

    postShiftSubmitButton = document.querySelector("#postShiftSubmitButton");

    postShiftFormAlert = document.querySelector("#postShiftFormAlert");

    if (!postShiftForm || !postShiftSubmitButton) {
      return;
    }

    postShiftModalElement = postShiftForm.closest(".modal");

    if (postShiftModalElement && typeof bootstrap !== "undefined") {
      postShiftModal = bootstrap.Modal.getOrCreateInstance(postShiftModalElement);
    }

    branchSelect = document.querySelector("#shiftBranchId");

    professionalTypeSelect = document.querySelector("#shiftProfessionalType");

    requiredSkillsInput = document.querySelector("#shiftRequiredSkills");

    breakDurationInput = document.querySelector("#shiftBreakDuration");

    hourlyRateInput = document.querySelector("#shiftHourlyRate");

    scheduleModeInputs = Array.from(document.querySelectorAll(".js-shift-schedule-mode"));

    singleScheduleFields = document.querySelector("#postShiftSingleScheduleFields");

    multipleScheduleFields = document.querySelector("#postShiftMultipleScheduleFields");

    singleDateInput = document.querySelector("#shiftSingleDate");

    singleStartTimeInput = document.querySelector("#shiftSingleStartTime");

    singleEndTimeInput = document.querySelector("#shiftSingleEndTime");

    singleEndsNextDayInput = document.querySelector("#shiftSingleEndsNextDay");

    startTimeInput = document.querySelector("#shiftStartTime");

    endTimeInput = document.querySelector("#shiftEndTime");

    firstOccurrenceDateInput = document.querySelector("#shiftFirstOccurrenceDate");

    occurrenceCountInput = document.querySelector("#shiftOccurrenceCount");

    dailyStartTimeInput = document.querySelector("#shiftDailyStartTime");

    dailyEndTimeInput = document.querySelector("#shiftDailyEndTime");

    endsNextDayInput = document.querySelector("#shiftEndsNextDay");

    repeatDayInputs = Array.from(document.querySelectorAll(".js-repeat-day"));

    repeatDaysFeedback = document.querySelector("#shiftRepeatDaysFeedback");

    generatedOccurrenceCount = document.querySelector("#shiftGeneratedOccurrenceCount");

    occurrencePreviewEmptyState = document.querySelector("#shiftOccurrencePreviewEmptyState");

    occurrencePreviewTableWrapper = document.querySelector("#shiftOccurrencePreviewTableWrapper");

    occurrencePreviewBody = document.querySelector("#shiftOccurrencePreviewBody");

    occurrenceCountPreview = document.querySelector("#shiftOccurrenceCountPreview");

    scheduledHoursPerOccurrencePreview = document.querySelector(
      "#shiftScheduledHoursPerOccurrencePreview"
    );

    scheduledHoursPreview = document.querySelector("#shiftScheduledHoursPreview");

    employerChargePerOccurrencePreview = document.querySelector(
      "#shiftEmployerChargePerOccurrencePreview"
    );

    professionalPayPreview = document.querySelector("#shiftProfessionalPayPreview");

    platformFeePreview = document.querySelector("#shiftPlatformFeePreview");

    employerChargePreview = document.querySelector("#shiftEmployerChargePreview");

    initializeShiftSelect2();

    initializeDateTimePickers();

    handleScheduleControls();

    handlePricingPreview();

    postShiftForm.addEventListener("submit", function (event) {
      event.preventDefault();

      submitShiftDetails();
    });

    postShiftModalElement?.addEventListener("shown.bs.modal", function () {
      initializeShiftSelect2();

      initializeDateTimePickers();

      applyScheduleMode();

      renderOccurrencePreview();

      updatePricingPreview();
    });

    postShiftModalElement?.addEventListener("hidden.bs.modal", function () {
      if (!createdShiftRedirectUrl) {
        resetPostShiftForm();
      }
    });
  }

  /* ─────────────────────────────── REUSABLE FUNDING MODAL ─────────────────────────────── */

  function showFundShiftAlert(message) {
    if (!fundShiftAlert) return;

    fundShiftAlert.textContent = message;

    fundShiftAlert.classList.remove("d-none");

    fundShiftAlert.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  function hideFundShiftAlert() {
    if (!fundShiftAlert) return;

    fundShiftAlert.textContent = "";

    fundShiftAlert.classList.add("d-none");
  }

  function resetFundingModal() {
    hideFundShiftAlert();

    walletCanUse = false;
    checkoutCanUse = false;
    fundingRequestInProgress = false;

    if (fundShiftId) {
      fundShiftId.value = "";
    }

    if (fundShiftWalletFundingUrl) {
      fundShiftWalletFundingUrl.value = "";
    }

    if (fundShiftCheckoutUrl) {
      fundShiftCheckoutUrl.value = "";
    }

    setText(fundShiftModalTitle, "Fund Shift");

    setText(fundShiftReference, null);

    setText(fundShiftRole, null);

    setText(fundShiftBranch, null);

    setText(fundShiftSchedule, null);

    setText(fundShiftOccurrenceCount, null);

    setText(fundShiftHoursPerOccurrence, null);

    setText(fundShiftTotalHours, null);

    setText(fundShiftEmployerCharge, null);

    setText(fundShiftProfessionalPay, null);

    setText(fundShiftPlatformFee, null);

    setText(fundShiftWalletBalanceAfter, null);

    setText(fundShiftWalletShortfall, null);

    if (fundShiftStatusBadge) {
      fundShiftStatusBadge.textContent = "Pending Funding";

      fundShiftStatusBadge.className = "badge badge-light-warning align-self-start";
    }

    if (fundShiftWalletStatusBadge) {
      fundShiftWalletStatusBadge.textContent = "Checking";

      fundShiftWalletStatusBadge.className = "badge badge-light-secondary";
    }

    if (fundShiftCheckoutStatusBadge) {
      fundShiftCheckoutStatusBadge.textContent = "Online Payment";

      fundShiftCheckoutStatusBadge.className = "badge badge-light-success";
    }

    setText(
      fundShiftWalletMessage,

      "Select a Shift to check whether your wallet balance is sufficient."
    );

    setText(
      fundShiftCheckoutMessage,

      "Use this option when you do not want to pay from your employer wallet."
    );

    fundShiftWalletShortfallRow?.classList.add("d-none");

    fundShiftAddWalletFundsLink?.classList.add("d-none");

    fundShiftWalletOption?.classList.remove("border-primary", "border-danger");

    fundShiftCheckoutOption?.classList.remove("border-success", "border-warning");

    setButtonLoading(fundShiftFromWalletButton, false, true);

    setButtonLoading(initializeFundShiftCheckoutButton, false, true);
  }

  function buildFundingStateFromButton(button) {
    return {
      shiftId: button.dataset.shiftId,

      referenceCode: button.dataset.shiftReference,

      roleTitle: button.dataset.shiftRole,

      branchName: button.dataset.shiftBranch,

      scheduleSummary: button.dataset.shiftSchedule,

      actionLabel: button.dataset.actionLabel,

      employerCharge: Number(button.dataset.employerCharge || 0),

      employerChargeDisplay: button.dataset.employerChargeDisplay,

      professionalPayDisplay: button.dataset.professionalPayDisplay,

      platformFeeDisplay: button.dataset.platformFeeDisplay,

      occurrenceCountLabel: button.dataset.occurrenceCountLabel,

      hoursPerShiftDisplay: button.dataset.hoursPerShiftDisplay,

      totalHoursDisplay: button.dataset.totalHoursDisplay,

      walletFundingUrl: button.dataset.walletFundingUrl,

      checkoutUrl: button.dataset.checkoutUrl,

      walletCanUse: parseBoolean(button.dataset.walletCanUse),

      walletAvailableBalanceDisplay: button.dataset.walletAvailableBalanceDisplay,

      walletBalanceAfterPaymentDisplay: button.dataset.walletBalanceAfterPaymentDisplay,

      walletShortfall: Number(button.dataset.walletShortfall || 0),

      walletShortfallDisplay: button.dataset.walletShortfallDisplay,

      walletUnavailableMessage: button.dataset.walletUnavailableMessage,

      paystackCanUse: parseBoolean(button.dataset.paystackCanUse),

      paystackDescription: button.dataset.paystackDescription,

      redirectUrl: button.dataset.shiftDetailsUrl || null,
    };
  }

  function populateFundingModal(state) {
    resetFundingModal();

    if (!state || !state.shiftId) {
      showFundShiftAlert("The selected Shift could not be resolved.");

      return;
    }

    if (fundShiftId) {
      fundShiftId.value = state.shiftId;
    }

    if (fundShiftWalletFundingUrl) {
      fundShiftWalletFundingUrl.value =
        state.walletFundingUrl ||
        "/employer/shifts/" + encodeURIComponent(state.shiftId) + "/fund-from-wallet";
    }

    if (fundShiftCheckoutUrl) {
      fundShiftCheckoutUrl.value =
        state.checkoutUrl ||
        "/employer/shifts/" + encodeURIComponent(state.shiftId) + "/initialize-checkout";
    }

    setText(fundShiftModalTitle, state.actionLabel || "Fund Shift");

    setText(fundShiftReference, state.referenceCode);

    setText(fundShiftRole, state.roleTitle);

    setText(fundShiftBranch, state.branchName);

    setText(fundShiftSchedule, state.scheduleSummary);

    setText(fundShiftOccurrenceCount, state.occurrenceCountLabel);

    setText(fundShiftHoursPerOccurrence, state.hoursPerShiftDisplay);

    setText(fundShiftTotalHours, state.totalHoursDisplay);

    setText(fundShiftEmployerCharge, state.employerChargeDisplay);

    setText(fundShiftProfessionalPay, state.professionalPayDisplay);

    setText(fundShiftPlatformFee, state.platformFeeDisplay);

    setText(fundShiftWalletAvailableBalance, state.walletAvailableBalanceDisplay);

    setText(fundShiftWalletBalanceAfter, state.walletBalanceAfterPaymentDisplay);

    setText(fundShiftWalletShortfall, state.walletShortfallDisplay);

    walletCanUse = Boolean(state.walletCanUse);

    checkoutCanUse = Boolean(state.paystackCanUse);

    if (fundShiftWalletShortfallRow) {
      fundShiftWalletShortfallRow.classList.toggle(
        "d-none",

        !(Number(state.walletShortfall || 0) > 0)
      );
    }

    if (fundShiftWalletStatusBadge) {
      fundShiftWalletStatusBadge.textContent = walletCanUse
        ? "Available"
        : Number(state.walletShortfall || 0) > 0
          ? "Insufficient Balance"
          : "Unavailable";

      fundShiftWalletStatusBadge.className = walletCanUse
        ? "badge badge-light-success"
        : Number(state.walletShortfall || 0) > 0
          ? "badge badge-light-danger"
          : "badge badge-light-warning";
    }

    setText(
      fundShiftWalletMessage,

      state.walletUnavailableMessage ||
        (walletCanUse
          ? "Your available wallet balance can fully fund this engagement."
          : Number(state.walletShortfall || 0) > 0
            ? "Add money to your employer wallet or use Paystack Checkout."
            : "Employer wallet funding is not available for this engagement.")
    );

    fundShiftWalletOption?.classList.toggle("border-primary", walletCanUse);

    fundShiftWalletOption?.classList.toggle(
      "border-danger",

      !walletCanUse && Number(state.walletShortfall || 0) > 0
    );

    fundShiftAddWalletFundsLink?.classList.toggle(
      "d-none",

      walletCanUse || !(Number(state.walletShortfall || 0) > 0)
    );

    setText(
      fundShiftCheckoutMessage,

      state.paystackDescription ||
        (checkoutCanUse
          ? "You will be redirected to Paystack to complete the engagement charge."
          : "Paystack Checkout is not available for this engagement.")
    );

    if (fundShiftCheckoutStatusBadge) {
      fundShiftCheckoutStatusBadge.textContent = checkoutCanUse ? "Online Payment" : "Unavailable";

      fundShiftCheckoutStatusBadge.className = checkoutCanUse
        ? "badge badge-light-success"
        : "badge badge-light-warning";
    }

    fundShiftCheckoutOption?.classList.toggle("border-success", checkoutCanUse);

    fundShiftCheckoutOption?.classList.toggle("border-warning", !checkoutCanUse);

    setButtonLoading(fundShiftFromWalletButton, false, !walletCanUse);

    setButtonLoading(initializeFundShiftCheckoutButton, false, !checkoutCanUse);
  }

  function handleFundingModalTriggers() {
    document.addEventListener("click", function (event) {
      var button = event.target.closest(".js-open-fund-shift-modal");

      if (!button) return;

      populateFundingModal(buildFundingStateFromButton(button));
    });
  }

  function handleWalletFunding() {
    fundShiftFromWalletButton?.addEventListener("click", function () {
      if (!walletCanUse || fundingRequestInProgress) {
        return;
      }

      var fundingUrl = fundShiftWalletFundingUrl?.value;

      if (!fundingUrl) {
        showFundShiftAlert("The wallet funding endpoint is unavailable.");

        return;
      }

      hideFundShiftAlert();

      fundingRequestInProgress = true;

      setButtonLoading(fundShiftFromWalletButton, true, true);

      setButtonLoading(initializeFundShiftCheckoutButton, false, true);

      axios
        .post(fundingUrl, {
          _csrf: getCsrfToken(),
        })
        .then(function (response) {
          var payload = getResponsePayload(response);

          var message =
            response?.data?.message ||
            payload.message ||
            "The Shift was funded and published successfully.";

          var redirectUrl =
            payload.shiftDetailsUrl ||
            response?.data?.shiftDetailsUrl ||
            payload.redirectUrl ||
            response?.data?.redirectUrl ||
            payload.manageShiftsUrl ||
            "/employer/shifts";

          createdShiftRedirectUrl = null;

          return showAlert({
            title: "Shift Published",

            text: message,

            icon: "success",
          }).then(function () {
            window.location.href = redirectUrl;
          });
        })
        .catch(function (error) {
          fundingRequestInProgress = false;

          setButtonLoading(fundShiftFromWalletButton, false, !walletCanUse);

          setButtonLoading(initializeFundShiftCheckoutButton, false, !checkoutCanUse);

          var details = getErrorDetails(error);

          if (details && hasUsableValue(details.availableBalance)) {
            var currency = details.currency || getCurrency();

            setText(
              fundShiftWalletAvailableBalance,

              formatMoneyFromMinorUnit(details.availableBalance, currency)
            );

            if (hasUsableValue(details.shortfall)) {
              fundShiftWalletShortfallRow?.classList.remove("d-none");

              setText(
                fundShiftWalletShortfall,

                formatMoneyFromMinorUnit(details.shortfall, currency)
              );
            }
          }

          var errorMessage = getErrorMessage(
            error,

            "The Shift could not be funded from your wallet. Please try again."
          );

          showFundShiftAlert(errorMessage);

          showAlert({
            text: errorMessage,

            icon: "error",
          });
        });
    });
  }

  function handleCheckoutInitialization() {
    initializeFundShiftCheckoutButton?.addEventListener("click", function () {
      if (!checkoutCanUse || fundingRequestInProgress) {
        return;
      }

      var checkoutUrl = fundShiftCheckoutUrl?.value;

      if (!checkoutUrl) {
        showFundShiftAlert("The Paystack Checkout endpoint is unavailable.");

        return;
      }

      var checkoutWindow = window.open("about:blank", "_blank");

      if (!checkoutWindow) {
        var popupMessage =
          "Your browser blocked the Paystack Checkout page. Allow popups for Loqum and try again.";

        showFundShiftAlert(popupMessage);

        showAlert({
          text: popupMessage,

          icon: "warning",
        });

        return;
      }

      checkoutWindow.opener = null;

      checkoutWindow.document.title = "Preparing Paystack Checkout";

      checkoutWindow.document.body.innerHTML =
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;background:#f5f5f5;color:#333">' +
        '<div style="text-align:center"><h2 style="margin-bottom:12px">Preparing Paystack Checkout</h2>' +
        '<p style="margin:0">Please wait while your secure payment page is created.</p></div></div>';

      hideFundShiftAlert();

      fundingRequestInProgress = true;

      setButtonLoading(initializeFundShiftCheckoutButton, true, true);

      setButtonLoading(fundShiftFromWalletButton, false, true);

      axios
        .post(checkoutUrl, {
          _csrf: getCsrfToken(),
        })
        .then(function (response) {
          var payload = getResponsePayload(response);

          var authorizationUrl = getFirstValue(
            payload,
            [
              "checkout.authorizationUrl",
              "checkout.authorization_url",
              "authorizationUrl",
              "authorization_url",
              "checkoutUrl",
              "data.authorizationUrl",
              "data.authorization_url",
              "data.checkout.authorizationUrl",
              "data.checkout.authorization_url",
            ],
            null
          );

          if (!authorizationUrl) {
            throw new Error("Paystack did not return a Checkout authorization URL.");
          }

          var parsedAuthorizationUrl;

          try {
            parsedAuthorizationUrl = new URL(authorizationUrl, window.location.origin);
          } catch (error) {
            throw new Error("Paystack returned an invalid Checkout authorization URL.");
          }

          if (parsedAuthorizationUrl.protocol !== "https:") {
            throw new Error("Paystack returned an insecure Checkout authorization URL.");
          }

          checkoutWindow.location.replace(parsedAuthorizationUrl.toString());

          fundingRequestInProgress = false;

          setButtonLoading(initializeFundShiftCheckoutButton, false, !checkoutCanUse);

          setButtonLoading(fundShiftFromWalletButton, false, !walletCanUse);
        })
        .catch(function (error) {
          fundingRequestInProgress = false;

          if (checkoutWindow && !checkoutWindow.closed) {
            checkoutWindow.close();
          }

          setButtonLoading(initializeFundShiftCheckoutButton, false, !checkoutCanUse);

          setButtonLoading(fundShiftFromWalletButton, false, !walletCanUse);

          var errorMessage = getErrorMessage(
            error,

            "Paystack Checkout could not be initialized. Please try again."
          );

          showFundShiftAlert(errorMessage);

          showAlert({
            text: errorMessage,

            icon: "error",
          });
        });
    });
  }

  function initializeFundingModal() {
    var fundingModalId = manageShiftsPage?.dataset.fundingModalId || "fundShiftModal";

    fundShiftModalElement = document.getElementById(fundingModalId);

    if (!fundShiftModalElement) {
      return;
    }

    if (typeof bootstrap !== "undefined") {
      fundShiftModal = bootstrap.Modal.getOrCreateInstance(fundShiftModalElement);
    }

    fundShiftModalTitle = document.querySelector("#fundShiftModalTitle");

    fundShiftCsrfToken = document.querySelector("#fundShiftCsrfToken");

    fundShiftId = document.querySelector("#fundShiftId");

    fundShiftWalletFundingUrl = document.querySelector("#fundShiftWalletFundingUrl");

    fundShiftCheckoutUrl = document.querySelector("#fundShiftCheckoutUrl");

    fundShiftAlert = document.querySelector("#fundShiftAlert");

    fundShiftReference = document.querySelector("#fundShiftReference");

    fundShiftStatusBadge = document.querySelector("#fundShiftStatusBadge");

    fundShiftRole = document.querySelector("#fundShiftRole");

    fundShiftBranch = document.querySelector("#fundShiftBranch");

    fundShiftSchedule = document.querySelector("#fundShiftSchedule");

    fundShiftOccurrenceCount = document.querySelector("#fundShiftOccurrenceCount");

    fundShiftHoursPerOccurrence = document.querySelector("#fundShiftHoursPerOccurrence");

    fundShiftTotalHours = document.querySelector("#fundShiftTotalHours");

    fundShiftEmployerCharge = document.querySelector("#fundShiftEmployerCharge");

    fundShiftProfessionalPay = document.querySelector("#fundShiftProfessionalPay");

    fundShiftPlatformFee = document.querySelector("#fundShiftPlatformFee");

    fundShiftWalletOption = document.querySelector("#fundShiftWalletOption");

    fundShiftWalletStatusBadge = document.querySelector("#fundShiftWalletStatusBadge");

    fundShiftWalletAvailableBalance = document.querySelector("#fundShiftWalletAvailableBalance");

    fundShiftWalletBalanceAfter = document.querySelector("#fundShiftWalletBalanceAfter");

    fundShiftWalletShortfallRow = document.querySelector("#fundShiftWalletShortfallRow");

    fundShiftWalletShortfall = document.querySelector("#fundShiftWalletShortfall");

    fundShiftWalletMessage = document.querySelector("#fundShiftWalletMessage");

    fundShiftFromWalletButton = document.querySelector("#fundShiftFromWalletButton");

    fundShiftAddWalletFundsLink = document.querySelector("#fundShiftAddWalletFundsLink");

    fundShiftCheckoutOption = document.querySelector("#fundShiftCheckoutOption");

    fundShiftCheckoutStatusBadge = document.querySelector("#fundShiftCheckoutStatusBadge");

    fundShiftCheckoutMessage = document.querySelector("#fundShiftCheckoutMessage");

    initializeFundShiftCheckoutButton = document.querySelector(
      "#initializeFundShiftCheckoutButton"
    );

    resetFundingModal();

    handleFundingModalTriggers();

    handleWalletFunding();

    handleCheckoutInitialization();

    fundShiftModalElement.addEventListener("hide.bs.modal", function (event) {
      if (fundingRequestInProgress) {
        event.preventDefault();
      }
    });

    fundShiftModalElement.addEventListener("hidden.bs.modal", function () {
      resetFundingModal();

      if (createdShiftRedirectUrl) {
        var redirectUrl = createdShiftRedirectUrl;

        createdShiftRedirectUrl = null;

        window.location.href = redirectUrl;
      }
    });
  }

  /* ─────────────────────────────── PAYSTACK CALLBACK MESSAGE ─────────────────────────────── */

  function getPaymentFailureMessage(errorCode) {
    var messages = {
      PAYSTACK_REFERENCE_REQUIRED:
        "Paystack returned without a transaction reference, so the payment could not be verified.",

      PAYSTACK_PAYMENT_NOT_SUCCESSFUL:
        "The Paystack payment was not completed successfully. The Shift remains unpublished.",

      PAYSTACK_PAYMENT_AMOUNT_MISMATCH:
        "The verified payment amount did not match the locked Shift charge.",

      PAYSTACK_PAYMENT_CURRENCY_MISMATCH:
        "The verified payment currency did not match the Shift currency.",

      PAYSTACK_PAYMENT_REFERENCE_MISMATCH:
        "The Paystack reference did not match the internal Shift-funding transaction.",

      PAYSTACK_PAYMENT_CUSTOMER_MISMATCH:
        "The verified Paystack customer did not match the employer account.",

      PAYSTACK_PAYMENT_SHIFT_MISMATCH:
        "The verified Paystack payment was not linked to the expected Shift.",

      PAYSTACK_SHIFT_TRANSACTION_NOT_FOUND:
        "Loqum could not find the internal transaction linked to this Paystack payment.",

      PAYSTACK_SHIFT_NOT_FOUND: "Loqum could not find the Shift linked to this Paystack payment.",

      SHIFT_FUNDING_WINDOW_EXPIRED:
        "This Shift expired because it was not funded before its scheduled start time.",
    };

    return (
      messages[errorCode] ||
      "The Shift payment could not be verified. The Shift remains unpublished."
    );
  }

  function cleanPaymentQueryParameters() {
    var url = new URL(window.location.href);

    ["payment", "shift", "paymentCode", "alreadyFunded"].forEach(function (parameterName) {
      url.searchParams.delete(parameterName);
    });

    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }

  function handlePaymentReturnMessage() {
    var parameters = new URLSearchParams(window.location.search);

    var paymentStatus = parameters.get("payment");

    if (!paymentStatus) {
      return;
    }

    var shiftReference = parameters.get("shift");

    var paymentCode = parameters.get("paymentCode");

    var alreadyFunded = parameters.get("alreadyFunded") === "true";

    cleanPaymentQueryParameters();

    if (paymentStatus === "success") {
      var successMessage = shiftReference
        ? "Shift " + shiftReference + " was funded and published successfully."
        : "The Shift was funded and published successfully.";

      if (alreadyFunded) {
        successMessage = shiftReference
          ? "Shift " + shiftReference + " had already been funded and published."
          : "The Shift had already been funded and published.";
      }

      showAlert({
        title: "Payment Confirmed",

        text: successMessage,

        icon: "success",
      });

      return;
    }

    if (paymentStatus === "pending") {
      showAlert({
        title: "Payment Processing",

        text:
          "Paystack has not confirmed the payment yet. " +
          "The Shift will remain in Pending Funding until verification succeeds.",

        icon: "info",
      });

      return;
    }

    showAlert({
      title: "Payment Not Completed",

      text: getPaymentFailureMessage(paymentCode),

      icon: "error",
    });
  }

  /* ─────────────────────────────── INITIALIZATION ─────────────────────────────── */

  return {
    init: function () {
      manageShiftsPage = document.querySelector("#manageShiftsPage");

      if (manageShiftsPage?.dataset.timeZone) {
        SHIFT_TIME_ZONE = manageShiftsPage.dataset.timeZone;
      }

      initializeFundingModal();

      initializePostShiftForm();

      handlePaymentReturnMessage();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerManageShifts.init();
});
