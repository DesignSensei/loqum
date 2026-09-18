// public/js/employer/shift-attendance.js

"use strict";

var EmployerShiftAttendance = (function () {
  var page = null;
  var pinModalElement = null;
  var pinModalTitle = null;
  var pinModalContext = null;
  var pinAlert = null;
  var pinValue = null;
  var pinLoading = null;
  var pinResult = null;
  var requestSequence = 0;

  /* ─────────────────────────────── HELPERS ─────────────────────────────── */

  function parsePinConfig(element) {
    if (!element) return null;

    var raw = element.getAttribute("data-pin-config");

    if (!raw) return null;

    try {
      var config = JSON.parse(raw);

      return config && typeof config === "object" ? config : null;
    } catch (error) {
      return null;
    }
  }

  function clearSensitivePin() {
    if (pinValue) {
      pinValue.textContent = "";
    }
  }

  function hideAlert() {
    if (!pinAlert) return;

    pinAlert.textContent = "";
    pinAlert.classList.add("d-none");
  }

  function showAlert(message) {
    if (!pinAlert) return;

    pinAlert.textContent = message || "Unable to retrieve the attendance PIN.";

    pinAlert.classList.remove("d-none");
  }

  function setLoading(isLoading) {
    if (pinLoading) {
      pinLoading.classList.toggle("d-none", !isLoading);
    }

    if (pinResult) {
      pinResult.classList.add("d-none");
    }
  }

  function showPin(pin) {
    clearSensitivePin();

    if (pinLoading) {
      pinLoading.classList.add("d-none");
    }

    if (pinValue) {
      pinValue.textContent = pin;
    }

    if (pinResult) {
      pinResult.classList.remove("d-none");
    }
  }

  function resetModal() {
    requestSequence += 1;

    clearSensitivePin();
    hideAlert();
    setLoading(false);

    if (pinModalTitle) {
      pinModalTitle.textContent = "Attendance PIN";
    }

    if (pinModalContext) {
      pinModalContext.textContent = "";
    }
  }

  function buildContextText(trigger) {
    if (!trigger) return "";

    var occurrenceContext = String(trigger.getAttribute("data-pin-context") || "").trim();

    var occurrenceReference = String(
      trigger.getAttribute("data-occurrence-reference") || ""
    ).trim();

    if (occurrenceContext && occurrenceReference) {
      return occurrenceContext + " · " + occurrenceReference;
    }

    return occurrenceContext || occurrenceReference;
  }

  function presentRequest(trigger, config) {
    clearSensitivePin();
    hideAlert();
    setLoading(true);

    if (pinModalTitle) {
      pinModalTitle.textContent = config.modalTitle || config.label || "Attendance PIN";
    }

    if (pinModalContext) {
      pinModalContext.textContent = buildContextText(trigger);
    }
  }

  function getPinFromResponse(response) {
    var data = response && response.data && response.data.data ? response.data.data : null;

    if (!data || data.pin === null || data.pin === undefined || String(data.pin).trim() === "") {
      return null;
    }

    return String(data.pin);
  }

  function getResponseOccurrenceId(response) {
    var data = response && response.data && response.data.data ? response.data.data : null;

    return data && data.occurrenceId ? String(data.occurrenceId) : null;
  }

  function getErrorMessage(error) {
    return (
      error?.response?.data?.message || "Unable to retrieve the attendance PIN. Please try again."
    );
  }

  function showConfigurationError() {
    Swal.fire({
      text: "This attendance PIN action could not be loaded. Refresh the page and try again.",

      icon: "error",

      buttonsStyling: false,

      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  /* ─────────────────────────────── PIN REQUEST ─────────────────────────────── */

  function requestPin(trigger, config) {
    var currentRequest = ++requestSequence;

    var occurrenceCard = trigger.closest("[data-occurrence-id]");

    var expectedOccurrenceId = occurrenceCard
      ? String(occurrenceCard.getAttribute("data-occurrence-id") || "")
      : "";

    presentRequest(trigger, config);

    axios({
      method: String(config.method || "GET").toLowerCase(),

      url: config.url,

      headers: {
        "Cache-Control": "no-cache",
      },
    })
      .then(function (response) {
        if (currentRequest !== requestSequence) {
          return;
        }

        var returnedOccurrenceId = getResponseOccurrenceId(response);

        if (
          expectedOccurrenceId &&
          returnedOccurrenceId &&
          returnedOccurrenceId !== expectedOccurrenceId
        ) {
          setLoading(false);

          showAlert(
            "The returned attendance PIN does not match this occurrence. Refresh the page and try again."
          );

          return;
        }

        var pin = getPinFromResponse(response);

        if (!pin) {
          setLoading(false);

          showAlert(
            "The attendance PIN response did not contain a PIN. Refresh the page and try again."
          );

          return;
        }

        showPin(pin);
      })
      .catch(function (error) {
        if (currentRequest !== requestSequence) {
          return;
        }

        setLoading(false);

        showAlert(getErrorMessage(error));
      });
  }

  /* ─────────────────────────────── EVENTS ─────────────────────────────── */

  function bindPinTriggers() {
    if (!page) return;

    page.addEventListener("click", function (event) {
      var trigger = event.target.closest(".js-attendance-pin-trigger");

      if (!trigger || !page.contains(trigger)) {
        return;
      }

      var config = parsePinConfig(trigger);

      if (!config || !config.url) {
        event.preventDefault();

        resetModal();

        showConfigurationError();

        return;
      }

      requestPin(trigger, config);
    });
  }

  function bindModalReset() {
    if (!pinModalElement) {
      return;
    }

    pinModalElement.addEventListener("hidden.bs.modal", function () {
      resetModal();
    });
  }

  /* ─────────────────────────────── INITIALIZATION ─────────────────────────────── */

  function initializeElements() {
    page = document.querySelector("#shiftAttendancePage");

    pinModalElement = document.querySelector("#shiftAttendancePinModal");

    pinModalTitle = document.querySelector("#shiftAttendancePinModalLabel");

    pinModalContext = document.querySelector("#shiftAttendancePinContext");

    pinAlert = document.querySelector("#shiftAttendancePinAlert");

    pinValue = document.querySelector("#shiftAttendancePinValue");

    pinLoading = document.querySelector(".js-attendance-pin-loading");

    pinResult = document.querySelector(".js-attendance-pin-result");

    if (pinModalElement && typeof bootstrap !== "undefined" && bootstrap.Modal) {
      bootstrap.Modal.getOrCreateInstance(pinModalElement);
    }
  }

  function initAttendancePins() {
    initializeElements();

    if (!page) return;

    bindPinTriggers();
    bindModalReset();
  }

  return {
    init: function () {
      initAttendancePins();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerShiftAttendance.init();
});
