// public/js/employer/manage-shifts.js

"use strict";

var EmployerManageShifts = (function () {
  var postShiftForm = null;
  var postShiftSubmitButton = null;
  var postShiftFormAlert = null;
  var postShiftModalElement = null;

  var branchSelect = null;
  var professionalTypeSelect = null;

  var startTimeInput = null;
  var endTimeInput = null;
  var breakDurationInput = null;
  var hourlyRateInput = null;
  var requiredSkillsInput = null;

  var startTimePicker = null;
  var endTimePicker = null;

  var scheduledHoursPreview = null;
  var professionalPayPreview = null;
  var platformFeePreview = null;
  var employerChargePreview = null;

  var attendancePinModalElement = null;
  var attendancePinModal = null;
  var attendancePinModalLabel = null;
  var attendancePinShiftReference = null;
  var attendancePinAlert = null;
  var attendancePinLoader = null;
  var attendancePinContent = null;
  var attendancePinTypeLabel = null;
  var attendancePinValue = null;

  /* ─────────────────────────────── GENERAL HELPERS ─────────────────────────────── */

  function getErrorMessage(error, fallbackMessage) {
    return error?.response?.data?.message || error?.message || fallbackMessage;
  }

  function setButtonLoading(button, isLoading) {
    if (!button) return;

    if (isLoading) {
      button.setAttribute("data-kt-indicator", "on");
      button.disabled = true;

      return;
    }

    button.removeAttribute("data-kt-indicator");
    button.disabled = false;
  }

  function showAlert({ text, icon, confirmButtonText = "Ok, got it!" }) {
    if (!window.Swal) {
      window.alert(text);

      return Promise.resolve();
    }

    return Swal.fire({
      text,
      icon,
      buttonsStyling: false,
      confirmButtonText,
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

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

  function parseNumber(value) {
    var normalizedValue = String(value || "")
      .replace(/,/g, "")
      .trim();

    if (!normalizedValue) {
      return null;
    }

    var numberValue = Number(normalizedValue);

    return Number.isFinite(numberValue) ? numberValue : null;
  }

  function parseDateTime(value) {
    if (!value) {
      return null;
    }

    var parsedDate = new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    return parsedDate;
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

  function getScheduledMinutes() {
    var startTime = parseDateTime(startTimeInput?.value);
    var endTime = parseDateTime(endTimeInput?.value);

    if (!startTime || !endTime) {
      return null;
    }

    var durationMilliseconds = endTime.getTime() - startTime.getTime();

    if (durationMilliseconds <= 0) {
      return null;
    }

    var scheduledMinutes = durationMilliseconds / (60 * 1000);

    if (!Number.isSafeInteger(scheduledMinutes)) {
      return null;
    }

    return scheduledMinutes;
  }

  function formatScheduledHours(scheduledMinutes) {
    var scheduledHours = Number((scheduledMinutes / 60).toFixed(2));

    return scheduledHours + (scheduledHours === 1 ? " hour" : " hours");
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

  /* ─────────────────────────────── SELECT2 ─────────────────────────────── */

  function initializeSelect2Field(selectElement, options) {
    if (!selectElement) return;
    if (!window.jQuery || !window.jQuery.fn.select2) return;

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
    if (!selectElement) return;
    if (!window.jQuery) return;

    window.jQuery(selectElement).next(".select2").find(".select2-selection").addClass("is-invalid");
  }

  function clearSelect2InvalidState(selectElement) {
    if (!selectElement) return;
    if (!window.jQuery) return;

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

  function resetSelect2Fields() {
    if (!window.jQuery || !window.jQuery.fn.select2) {
      return;
    }

    if (branchSelect) {
      window.jQuery(branchSelect).val("").trigger("change");
    }

    if (professionalTypeSelect) {
      window.jQuery(professionalTypeSelect).val("").trigger("change");
    }

    clearSelect2InvalidState(branchSelect);
    clearSelect2InvalidState(professionalTypeSelect);
  }

  /* ─────────────────────────────── FLATPICKR ─────────────────────────────── */

  function initializeDateTimePickers() {
    if (!startTimeInput || !endTimeInput) return;
    if (!window.flatpickr) return;

    if (!startTimePicker) {
      startTimePicker = window.flatpickr(startTimeInput, {
        enableTime: true,
        dateFormat: "Y-m-d\\TH:i",
        altInput: true,
        altFormat: "F j, Y at h:i K",
        minDate: "today",
        minuteIncrement: 5,
        time_24hr: false,
        disableMobile: true,
        allowInput: false,

        onChange: function (selectedDates) {
          var selectedStartTime = selectedDates[0] || null;

          if (endTimePicker) {
            endTimePicker.set("minDate", selectedStartTime || "today");

            var selectedEndTime = endTimePicker.selectedDates[0] || null;

            if (selectedStartTime && selectedEndTime && selectedEndTime <= selectedStartTime) {
              endTimePicker.clear();
            }
          }

          updatePricingPreview();
        },
      });
    }

    if (!endTimePicker) {
      endTimePicker = window.flatpickr(endTimeInput, {
        enableTime: true,
        dateFormat: "Y-m-d\\TH:i",
        altInput: true,
        altFormat: "F j, Y at h:i K",
        minDate: "today",
        minuteIncrement: 5,
        time_24hr: false,
        disableMobile: true,
        allowInput: false,

        onChange: function () {
          updatePricingPreview();
        },
      });
    }
  }

  function resetDateTimePickers() {
    if (startTimePicker) {
      startTimePicker.clear();
      startTimePicker.set("minDate", "today");
    }

    if (endTimePicker) {
      endTimePicker.clear();
      endTimePicker.set("minDate", "today");
    }
  }

  /* ─────────────────────────────── PRICING PREVIEW ─────────────────────────────── */

  function resetPricingPreview() {
    if (scheduledHoursPreview) {
      scheduledHoursPreview.textContent = "—";
    }

    if (professionalPayPreview) {
      professionalPayPreview.textContent = "—";
    }

    if (platformFeePreview) {
      platformFeePreview.textContent = "—";
    }

    if (employerChargePreview) {
      employerChargePreview.textContent = "—";
    }
  }

  function updatePricingPreview() {
    if (!postShiftForm) return;

    var scheduledMinutes = getScheduledMinutes();

    var hourlyRateMajorUnit = parseNumber(hourlyRateInput?.value);

    var platformFeeRate = Number(postShiftForm.dataset.platformFeeRate);

    var currency = postShiftForm.dataset.currency || "NGN";

    resetPricingPreview();

    if (!scheduledMinutes) {
      return;
    }

    if (scheduledHoursPreview) {
      scheduledHoursPreview.textContent = formatScheduledHours(scheduledMinutes);
    }

    if (
      hourlyRateMajorUnit === null ||
      hourlyRateMajorUnit <= 0 ||
      !Number.isFinite(platformFeeRate) ||
      platformFeeRate < 0
    ) {
      return;
    }

    var hourlyRateMinorUnit = Math.round(hourlyRateMajorUnit * 100);

    var estimatedProfessionalPay = Math.round((hourlyRateMinorUnit * scheduledMinutes) / 60);

    var estimatedPlatformFee = Math.round(estimatedProfessionalPay * platformFeeRate);

    var estimatedEmployerCharge = estimatedProfessionalPay + estimatedPlatformFee;

    if (professionalPayPreview) {
      professionalPayPreview.textContent = formatMoneyFromMinorUnit(
        estimatedProfessionalPay,
        currency
      );
    }

    if (platformFeePreview) {
      platformFeePreview.textContent = formatMoneyFromMinorUnit(estimatedPlatformFee, currency);
    }

    if (employerChargePreview) {
      employerChargePreview.textContent = formatMoneyFromMinorUnit(
        estimatedEmployerCharge,
        currency
      );
    }
  }

  function handlePricingPreview() {
    var pricingInputs = [startTimeInput, endTimeInput, breakDurationInput, hourlyRateInput];

    pricingInputs.forEach(function (input) {
      if (!input) return;

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
        message: "A shift cannot contain more than 20 required skills.",
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

  function validatePostShiftForm() {
    hidePostShiftFormAlert();

    postShiftForm.classList.add("was-validated");

    var select2FieldsAreValid = validateSelect2Fields();

    if (!postShiftForm.checkValidity() || !select2FieldsAreValid) {
      return {
        message: "Complete all required shift details before posting.",
        field: null,
      };
    }

    var startTime = parseDateTime(startTimeInput?.value);

    var endTime = parseDateTime(endTimeInput?.value);

    if (!startTime) {
      return {
        message: "Select a valid shift start date and time.",
        field: startTimeInput,
      };
    }

    if (!endTime) {
      return {
        message: "Select a valid shift end date and time.",
        field: endTimeInput,
      };
    }

    if (endTime <= startTime) {
      return {
        message: "Shift end time must be later than start time.",
        field: endTimeInput,
      };
    }

    var scheduledMinutes = getScheduledMinutes();

    if (!scheduledMinutes) {
      return {
        message: "The shift duration must be specified in whole minutes.",
        field: endTimeInput,
      };
    }

    var breakDuration = parseNumber(breakDurationInput?.value);

    if (breakDuration === null) {
      breakDuration = 0;
    }

    if (!Number.isSafeInteger(breakDuration) || breakDuration < 0) {
      return {
        message: "Break duration must be a non-negative whole number of minutes.",
        field: breakDurationInput,
      };
    }

    if (breakDuration >= scheduledMinutes && scheduledMinutes > 0) {
      return {
        message: "Break duration must be shorter than the shift duration.",
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

    var requiredSkillsValidation = validateRequiredSkills();

    if (requiredSkillsValidation) {
      return requiredSkillsValidation;
    }

    return null;
  }

  /* ─────────────────────────────── FORM RESET ─────────────────────────────── */

  function resetPostShiftForm() {
    if (!postShiftForm) return;

    postShiftForm.reset();
    postShiftForm.classList.remove("was-validated");

    hidePostShiftFormAlert();
    resetSelect2Fields();
    resetDateTimePickers();
    resetPricingPreview();

    if (breakDurationInput) {
      breakDurationInput.value = "0";
    }
  }

  /* ─────────────────────────────── POST SHIFT SUBMISSION ─────────────────────────────── */

  function handlePostShiftSubmission() {
    postShiftForm = document.querySelector("#postShiftForm");

    postShiftSubmitButton = document.querySelector("#postShiftSubmitButton");

    postShiftFormAlert = document.querySelector("#postShiftFormAlert");

    if (!postShiftForm || !postShiftSubmitButton) {
      return;
    }

    postShiftModalElement = postShiftForm.closest(".modal");

    branchSelect = document.querySelector("#shiftBranchId");

    professionalTypeSelect = document.querySelector("#shiftProfessionalType");

    startTimeInput = document.querySelector("#shiftStartTime");

    endTimeInput = document.querySelector("#shiftEndTime");

    breakDurationInput = document.querySelector("#shiftBreakDuration");

    hourlyRateInput = document.querySelector("#shiftHourlyRate");

    requiredSkillsInput = document.querySelector("#shiftRequiredSkills");

    scheduledHoursPreview = document.querySelector("#shiftScheduledHoursPreview");

    professionalPayPreview = document.querySelector("#shiftProfessionalPayPreview");

    platformFeePreview = document.querySelector("#shiftPlatformFeePreview");

    employerChargePreview = document.querySelector("#shiftEmployerChargePreview");

    initializeShiftSelect2();
    initializeDateTimePickers();
    handlePricingPreview();

    postShiftForm.addEventListener("submit", function (event) {
      event.preventDefault();

      var validationError = validatePostShiftForm();

      if (validationError) {
        showPostShiftFormAlert(validationError.message);

        focusFormField(validationError.field);

        return;
      }

      hidePostShiftFormAlert();
      setButtonLoading(postShiftSubmitButton, true);

      var formData = new FormData(postShiftForm);

      var data = Object.fromEntries(formData);

      axios
        .post(postShiftForm.action, data)
        .then(function (response) {
          setButtonLoading(postShiftSubmitButton, false);

          if (postShiftModalElement && window.bootstrap) {
            var modalInstance = bootstrap.Modal.getInstance(postShiftModalElement);

            if (modalInstance) {
              modalInstance.hide();
            }
          }

          showAlert({
            text: response.data.message || "The shift was posted successfully.",
            icon: "success",
          }).then(function () {
            window.location.href = response.data.redirectUrl || "/employer/shifts";
          });
        })
        .catch(function (error) {
          setButtonLoading(postShiftSubmitButton, false);

          var errorMessage = getErrorMessage(
            error,
            "The shift could not be posted. Please try again."
          );

          showPostShiftFormAlert(errorMessage);

          showAlert({
            text: errorMessage,
            icon: "error",
          });
        });
    });

    if (postShiftModalElement) {
      postShiftModalElement.addEventListener("shown.bs.modal", function () {
        initializeShiftSelect2();
        initializeDateTimePickers();
        updatePricingPreview();
      });

      postShiftModalElement.addEventListener("hidden.bs.modal", function () {
        resetPostShiftForm();
      });
    }
  }

  /* ─────────────────────────────── ATTENDANCE PIN MODAL ─────────────────────────────── */

  function initializeAttendancePinModal() {
    attendancePinModalElement = document.querySelector("#attendancePinModal");

    if (!attendancePinModalElement) {
      return;
    }

    attendancePinModalLabel = document.querySelector("#attendancePinModalLabel");

    attendancePinShiftReference = document.querySelector("#attendancePinShiftReference");

    attendancePinAlert = document.querySelector("#attendancePinAlert");

    attendancePinLoader = document.querySelector("#attendancePinLoader");

    attendancePinContent = document.querySelector("#attendancePinContent");

    attendancePinTypeLabel = document.querySelector("#attendancePinTypeLabel");

    attendancePinValue = document.querySelector("#attendancePinValue");

    if (window.bootstrap) {
      attendancePinModal = bootstrap.Modal.getOrCreateInstance(attendancePinModalElement);
    }

    attendancePinModalElement.addEventListener("hidden.bs.modal", function () {
      resetAttendancePinModal();
    });
  }

  function resetAttendancePinModal() {
    if (attendancePinModalLabel) {
      attendancePinModalLabel.textContent = "Attendance PIN";
    }

    if (attendancePinShiftReference) {
      attendancePinShiftReference.textContent = "";
    }

    if (attendancePinAlert) {
      attendancePinAlert.textContent = "";
      attendancePinAlert.classList.add("d-none");
    }

    if (attendancePinLoader) {
      attendancePinLoader.classList.add("d-none");
    }

    if (attendancePinContent) {
      attendancePinContent.classList.add("d-none");
    }

    if (attendancePinTypeLabel) {
      attendancePinTypeLabel.textContent = "Attendance PIN";
    }

    if (attendancePinValue) {
      attendancePinValue.textContent = "——— ———";
    }
  }

  function showAttendancePinLoader() {
    if (attendancePinAlert) {
      attendancePinAlert.textContent = "";
      attendancePinAlert.classList.add("d-none");
    }

    if (attendancePinContent) {
      attendancePinContent.classList.add("d-none");
    }

    if (attendancePinLoader) {
      attendancePinLoader.classList.remove("d-none");
    }
  }

  function showAttendancePinError(message) {
    if (attendancePinLoader) {
      attendancePinLoader.classList.add("d-none");
    }

    if (attendancePinContent) {
      attendancePinContent.classList.add("d-none");
    }

    if (attendancePinAlert) {
      attendancePinAlert.textContent = message;
      attendancePinAlert.classList.remove("d-none");
    }
  }

  function formatAttendancePin(pin) {
    var normalizedPin = String(pin || "")
      .replace(/\D/g, "")
      .padStart(6, "0")
      .slice(-6);

    return normalizedPin.slice(0, 3) + " " + normalizedPin.slice(3);
  }

  function showAttendancePinResult(data, requestedPinType) {
    if (attendancePinLoader) {
      attendancePinLoader.classList.add("d-none");
    }

    if (attendancePinAlert) {
      attendancePinAlert.textContent = "";
      attendancePinAlert.classList.add("d-none");
    }

    var pinType = data?.type || requestedPinType;

    var pinTypeLabel = pinType === "check_out" ? "Check-out PIN" : "Check-in PIN";

    if (attendancePinModalLabel) {
      attendancePinModalLabel.textContent = pinTypeLabel;
    }

    if (attendancePinTypeLabel) {
      attendancePinTypeLabel.textContent = pinTypeLabel;
    }

    if (attendancePinValue) {
      attendancePinValue.textContent = formatAttendancePin(data?.pin);
    }

    if (attendancePinContent) {
      attendancePinContent.classList.remove("d-none");
    }
  }

  function handleAttendancePinRequests() {
    initializeAttendancePinModal();

    document.addEventListener("click", function (event) {
      var pinButton = event.target.closest(".js-reveal-attendance-pin");

      if (!pinButton) return;

      event.preventDefault();

      var pinUrl = pinButton.getAttribute("data-pin-url");

      var pinType = pinButton.getAttribute("data-pin-type");

      var shiftReference = pinButton.getAttribute("data-shift-reference");

      if (!pinUrl) return;

      resetAttendancePinModal();

      var pinTypeLabel = pinType === "check_out" ? "Check-out PIN" : "Check-in PIN";

      if (attendancePinModalLabel) {
        attendancePinModalLabel.textContent = pinTypeLabel;
      }

      if (attendancePinTypeLabel) {
        attendancePinTypeLabel.textContent = pinTypeLabel;
      }

      if (attendancePinShiftReference) {
        attendancePinShiftReference.textContent = shiftReference || "";
      }

      showAttendancePinLoader();

      if (attendancePinModal) {
        attendancePinModal.show();
      }

      axios
        .get(pinUrl)
        .then(function (response) {
          showAttendancePinResult(response.data.data, pinType);
        })
        .catch(function (error) {
          showAttendancePinError(getErrorMessage(error, "Unable to retrieve the attendance PIN."));
        });
    });
  }

  /* ─────────────────────────────── INITIALIZATION ─────────────────────────────── */

  return {
    init: function () {
      handlePostShiftSubmission();
      handleAttendancePinRequests();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerManageShifts.init();
});
