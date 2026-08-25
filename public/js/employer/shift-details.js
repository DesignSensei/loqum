// public/js/employer/shift-details.js

"use strict";

var EmployerShiftDetails = (function () {
  var shiftDetailsPage;

  var attendancePinPanel;
  var pinErrorAlert;
  var checkInPinValue;
  var checkOutPinValue;
  var checkInPinStatus;
  var checkOutPinStatus;
  var checkInCopyButton;
  var checkOutCopyButton;

  var fundingForm;
  var fundingSubmitButton;
  var fundingErrorAlert;
  var fundingMethodInputs = [];

  var fundingRequestInProgress = false;

  var pinValues = {
    check_in: null,
    check_out: null,
  };

  /* ─────────────────────────────── GENERAL HELPERS ─────────────────────────────── */

  function getErrorMessage(error, fallbackMessage) {
    return (
      error?.response?.data?.message ||
      error?.response?.data?.error?.message ||
      error?.message ||
      fallbackMessage
    );
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

  function getCsrfToken() {
    return (
      fundingForm?.querySelector('input[name="_csrf"]')?.value ||
      shiftDetailsPage?.dataset.csrfToken ||
      ""
    );
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

  function setFundingOptionsDisabled(disabled) {
    fundingMethodInputs.forEach(function (input) {
      if (disabled) {
        input.dataset.wasDisabled = input.disabled ? "true" : "false";
        input.disabled = true;
        return;
      }

      input.disabled = input.dataset.wasDisabled === "true";
      delete input.dataset.wasDisabled;
    });
  }

  function showSuccess(title, message) {
    return Swal.fire({
      title,
      text: message,
      icon: "success",
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function showError(message) {
    return Swal.fire({
      text: message,
      icon: "error",
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",

      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function showConfirmation({ title, text, confirmButtonText, confirmButtonClass }) {
    return Swal.fire({
      title,
      text,
      icon: "warning",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText,
      cancelButtonText: "Cancel",

      customClass: {
        confirmButton: confirmButtonClass || "btn btn-danger",
        cancelButton: "btn btn-light",
      },
    }).then(function (result) {
      return result.isConfirmed === true;
    });
  }

  function redirectAfterRequest(response) {
    var payload = getResponsePayload(response);

    var redirectUrl =
      getFirstValue(payload, ["shiftDetailsUrl", "redirectUrl", "manageShiftsUrl"], null) ||
      getFirstValue(response?.data, ["shiftDetailsUrl", "redirectUrl", "manageShiftsUrl"], null);

    if (redirectUrl) {
      window.location.href = redirectUrl;
      return;
    }

    window.location.reload();
  }

  /* ─────────────────────────────── ATTENDANCE PIN HELPERS ─────────────────────────────── */

  function getPinValueElement(type) {
    return type === "check_in" ? checkInPinValue : checkOutPinValue;
  }

  function getPinStatusElement(type) {
    return type === "check_in" ? checkInPinStatus : checkOutPinStatus;
  }

  function getPinCopyButton(type) {
    return type === "check_in" ? checkInCopyButton : checkOutCopyButton;
  }

  function hidePinError() {
    if (!pinErrorAlert) return;

    pinErrorAlert.textContent = "";
    pinErrorAlert.classList.add("d-none");
  }

  function showPinError(message) {
    if (!pinErrorAlert) return;

    pinErrorAlert.textContent = message;
    pinErrorAlert.classList.remove("d-none");
  }

  function setPinLoading(type) {
    var valueElement = getPinValueElement(type);
    var statusElement = getPinStatusElement(type);
    var copyButton = getPinCopyButton(type);

    pinValues[type] = null;

    if (valueElement) {
      valueElement.textContent = "••••";
    }

    if (statusElement) {
      statusElement.textContent = "Loading PIN...";
    }

    if (copyButton) {
      copyButton.disabled = true;
    }
  }

  function setPinReady(type, pin) {
    var valueElement = getPinValueElement(type);
    var statusElement = getPinStatusElement(type);
    var copyButton = getPinCopyButton(type);

    pinValues[type] = pin;

    if (valueElement) {
      valueElement.textContent = pin;
    }

    if (statusElement) {
      statusElement.textContent = "Ready";
    }

    if (copyButton) {
      copyButton.disabled = false;
    }
  }

  function setPinFailed(type, message) {
    var valueElement = getPinValueElement(type);
    var statusElement = getPinStatusElement(type);
    var copyButton = getPinCopyButton(type);

    pinValues[type] = null;

    if (valueElement) {
      valueElement.textContent = "••••";
    }

    if (statusElement) {
      statusElement.textContent = message || "PIN unavailable";
    }

    if (copyButton) {
      copyButton.disabled = true;
    }
  }

  function clearPinValues() {
    ["check_in", "check_out"].forEach(function (type) {
      pinValues[type] = null;

      var valueElement = getPinValueElement(type);
      var statusElement = getPinStatusElement(type);
      var copyButton = getPinCopyButton(type);

      if (valueElement) {
        valueElement.textContent = "••••";
      }

      if (statusElement) {
        statusElement.textContent = "PIN cleared";
      }

      if (copyButton) {
        copyButton.disabled = true;
      }
    });
  }

  function extractPin(response, type) {
    var payload = getResponsePayload(response);

    var pin = String(
      getFirstValue(
        payload,
        ["pin", "attendancePin", type === "check_in" ? "checkInPin" : "checkOutPin"],
        ""
      )
    ).trim();

    if (!/^\d{4}$/.test(pin)) {
      throw new Error("The server returned an invalid attendance PIN.");
    }

    return pin;
  }

  function loadPin(type, url) {
    setPinLoading(type);

    if (!url) {
      setPinFailed(type, "PIN endpoint unavailable");

      return Promise.reject(new Error("The attendance PIN endpoint is unavailable."));
    }

    return axios
      .get(url, {
        params: {
          _: Date.now(),
        },

        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      })
      .then(function (response) {
        var pin = extractPin(response, type);

        setPinReady(type, pin);

        return pin;
      })
      .catch(function (error) {
        var fallbackMessage =
          type === "check_in"
            ? "Unable to load the check-in PIN."
            : "Unable to load the check-out PIN.";

        var message = getErrorMessage(error, fallbackMessage);

        setPinFailed(type, message);

        throw error;
      });
  }

  function loadAttendancePins() {
    if (!attendancePinPanel) return;

    if (!parseBoolean(attendancePinPanel.dataset.canViewPins)) {
      return;
    }

    hidePinError();

    var checkInPinUrl = attendancePinPanel.dataset.checkInPinUrl || "";
    var checkOutPinUrl = attendancePinPanel.dataset.checkOutPinUrl || "";

    Promise.allSettled([
      loadPin("check_in", checkInPinUrl),
      loadPin("check_out", checkOutPinUrl),
    ]).then(function (results) {
      var failedResults = results.filter(function (result) {
        return result.status === "rejected";
      });

      if (failedResults.length === 0) {
        return;
      }

      if (failedResults.length === 2) {
        showPinError("The attendance PINs could not be loaded. Refresh the page and try again.");
        return;
      }

      showPinError("One attendance PIN could not be loaded. The available PIN is still shown.");
    });
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      var textArea = document.createElement("textarea");

      textArea.value = text;
      textArea.setAttribute("readonly", "");
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";

      document.body.appendChild(textArea);

      textArea.select();

      try {
        var copied = document.execCommand("copy");

        document.body.removeChild(textArea);

        if (!copied) {
          reject(new Error("Copy command failed."));
          return;
        }

        resolve();
      } catch (error) {
        document.body.removeChild(textArea);
        reject(error);
      }
    });
  }

  function handlePinCopyButtons() {
    [checkInCopyButton, checkOutCopyButton].filter(Boolean).forEach(function (button) {
      button.addEventListener("click", function () {
        var type = button.dataset.copyPin;
        var pin = pinValues[type];

        if (!pin) return;

        var statusElement = getPinStatusElement(type);

        copyTextToClipboard(pin)
          .then(function () {
            if (statusElement) {
              statusElement.textContent = "Copied to clipboard";
            }

            window.setTimeout(function () {
              if (statusElement && pinValues[type]) {
                statusElement.textContent = "Ready";
              }
            }, 2000);
          })
          .catch(function () {
            if (statusElement) {
              statusElement.textContent = "Unable to copy PIN";
            }
          });
      });
    });
  }

  function initializeAttendancePins() {
    attendancePinPanel = document.querySelector("[data-attendance-pin-panel]");

    if (!attendancePinPanel) {
      return;
    }

    pinErrorAlert = attendancePinPanel.querySelector("[data-pin-error]");

    checkInPinValue = attendancePinPanel.querySelector('[data-pin-value="check_in"]');

    checkOutPinValue = attendancePinPanel.querySelector('[data-pin-value="check_out"]');

    checkInPinStatus = attendancePinPanel.querySelector('[data-pin-status="check_in"]');

    checkOutPinStatus = attendancePinPanel.querySelector('[data-pin-status="check_out"]');

    checkInCopyButton = attendancePinPanel.querySelector('[data-copy-pin="check_in"]');

    checkOutCopyButton = attendancePinPanel.querySelector('[data-copy-pin="check_out"]');

    handlePinCopyButtons();

    loadAttendancePins();

    window.addEventListener("pagehide", clearPinValues);
  }

  /* ─────────────────────────────── FUNDING FORM ─────────────────────────────── */

  function showFundingError(message) {
    if (!fundingErrorAlert) return;

    fundingErrorAlert.textContent = message;
    fundingErrorAlert.classList.remove("d-none");

    fundingErrorAlert.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  function hideFundingError() {
    if (!fundingErrorAlert) return;

    fundingErrorAlert.textContent = "";
    fundingErrorAlert.classList.add("d-none");
  }

  function getSelectedFundingMethod() {
    return fundingForm?.querySelector('input[name="fundingMethod"]:checked')?.value || null;
  }

  function resetFundingRequestState() {
    fundingRequestInProgress = false;

    setButtonLoading(fundingSubmitButton, false, false);

    setFundingOptionsDisabled(false);
  }

  function handleWalletFundingSuccess(response) {
    var payload = getResponsePayload(response);

    var message =
      response?.data?.message ||
      payload.message ||
      "The Shift was funded and published successfully.";

    return showSuccess("Shift Published", message).then(function () {
      redirectAfterRequest(response);
    });
  }

  function handleCheckoutInitializationSuccess(response, checkoutWindow) {
    var payload = getResponsePayload(response);

    if (payload.alreadyFunded === true || response?.data?.alreadyFunded === true) {
      if (checkoutWindow && !checkoutWindow.closed) {
        checkoutWindow.close();
      }

      var alreadyFundedMessage =
        response?.data?.message ||
        payload.message ||
        "The Shift has already been funded and published.";

      return showSuccess("Shift Published", alreadyFundedMessage).then(function () {
        redirectAfterRequest(response);
      });
    }

    var authorizationUrl =
      getFirstValue(
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
      ) ||
      getFirstValue(
        response?.data,
        [
          "checkout.authorizationUrl",
          "checkout.authorization_url",
          "authorizationUrl",
          "authorization_url",
          "checkoutUrl",
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

    resetFundingRequestState();

    return null;
  }

  function submitFundingRequest(method, requestUrl) {
    hideFundingError();

    var checkoutWindow = null;

    if (method === "paystack_checkout") {
      checkoutWindow = window.open("about:blank", "_blank");

      if (!checkoutWindow) {
        var popupMessage =
          "Your browser blocked the Paystack Checkout page. Allow popups for Loqum and try again.";

        showFundingError(popupMessage);

        showError(popupMessage);

        return;
      }

      checkoutWindow.opener = null;

      checkoutWindow.document.title = "Preparing Paystack Checkout";

      checkoutWindow.document.body.innerHTML =
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;background:#f5f5f5;color:#333">' +
        '<div style="text-align:center"><h2 style="margin-bottom:12px">Preparing Paystack Checkout</h2>' +
        '<p style="margin:0">Please wait while your secure payment page is created.</p></div></div>';
    }

    fundingRequestInProgress = true;

    setButtonLoading(fundingSubmitButton, true, true);

    setFundingOptionsDisabled(true);

    axios
      .post(requestUrl, {
        _csrf: getCsrfToken(),
      })
      .then(function (response) {
        if (method === "wallet") {
          return handleWalletFundingSuccess(response);
        }

        return handleCheckoutInitializationSuccess(response, checkoutWindow);
      })
      .catch(function (error) {
        if (checkoutWindow && !checkoutWindow.closed) {
          checkoutWindow.close();
        }

        resetFundingRequestState();

        var fallbackMessage =
          method === "wallet"
            ? "The Shift could not be funded from your wallet."
            : "Paystack Checkout could not be initialized.";

        var errorMessage = getErrorMessage(error, fallbackMessage);

        showFundingError(errorMessage);

        showError(errorMessage);
      });
  }

  function initializeFundingForm() {
    fundingForm = document.querySelector("#shiftFundingForm");

    if (!fundingForm) {
      return;
    }

    fundingSubmitButton = fundingForm.querySelector("[data-funding-submit]");

    fundingErrorAlert = fundingForm.querySelector("[data-funding-error]");

    fundingMethodInputs = Array.from(fundingForm.querySelectorAll('input[name="fundingMethod"]'));

    fundingForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (fundingRequestInProgress) {
        return;
      }

      hideFundingError();

      var method = getSelectedFundingMethod();

      if (!method) {
        showFundingError("Select a payment method.");

        return;
      }

      var requestUrl =
        method === "wallet"
          ? fundingSubmitButton?.dataset.walletUrl
          : fundingSubmitButton?.dataset.checkoutUrl;

      if (!requestUrl) {
        showFundingError("The selected payment endpoint is unavailable.");

        return;
      }

      submitFundingRequest(method, requestUrl);
    });
  }

  /* ─────────────────────────────── SHIFT CANCELLATION ─────────────────────────────── */

  function buildCancellationPreviewMessage(payload) {
    var message = getFirstValue(payload, ["message", "summary.message", "preview.message"], null);

    if (message) {
      return message;
    }

    var professionalCompensation = getFirstValue(
      payload,
      [
        "professionalCompensationDisplay",
        "compensation.professionalPayDisplay",
        "preview.professionalCompensationDisplay",
      ],
      null
    );

    var refundAmount = getFirstValue(
      payload,
      ["refundAmountDisplay", "refund.refundAmountDisplay", "preview.refundAmountDisplay"],
      null
    );

    var parts = ["This action will cancel the applicable Shift occurrence or engagement."];

    if (professionalCompensation) {
      parts.push("Professional compensation: " + professionalCompensation + ".");
    }

    if (refundAmount) {
      parts.push("Expected refund: " + refundAmount + ".");
    }

    return parts.join(" ");
  }

  function handleCancelShiftButtons() {
    document.querySelectorAll("[data-cancel-shift]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) return;

        var previewUrl = button.dataset.previewUrl;
        var cancelUrl = button.dataset.cancelUrl;

        if (!cancelUrl) {
          showError("The Shift cancellation endpoint is unavailable.");

          return;
        }

        setButtonLoading(button, true, false);

        var previewRequest = previewUrl
          ? axios.get(previewUrl, {
              params: {
                _: Date.now(),
              },

              headers: {
                Accept: "application/json",
                "Cache-Control": "no-store",
                Pragma: "no-cache",
              },
            })
          : Promise.resolve({
              data: {},
            });

        previewRequest
          .then(function (response) {
            var payload = getResponsePayload(response);

            return showConfirmation({
              title: "Cancel Shift?",
              text: buildCancellationPreviewMessage(payload),
              confirmButtonText: "Yes, Cancel Shift",
            });
          })
          .then(function (confirmed) {
            if (!confirmed) {
              setButtonLoading(button, false, false);

              return null;
            }

            return axios.post(cancelUrl, {
              _csrf: getCsrfToken(),
            });
          })
          .then(function (response) {
            if (!response) return;

            var payload = getResponsePayload(response);

            var message =
              response?.data?.message || payload.message || "The Shift was cancelled successfully.";

            return showSuccess("Shift Cancelled", message).then(function () {
              redirectAfterRequest(response);
            });
          })
          .catch(function (error) {
            setButtonLoading(button, false, false);

            showError(getErrorMessage(error, "The Shift could not be cancelled."));
          });
      });
    });
  }

  /* ─────────────────────────────── EARLY TERMINATION ─────────────────────────────── */

  function handleEndShiftEarlyButtons() {
    document.querySelectorAll("[data-end-shift-early]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) return;

        var requestUrl = button.dataset.endEarlyUrl;

        if (!requestUrl) {
          showError("The early-termination endpoint is unavailable.");

          return;
        }

        showConfirmation({
          title: "End Shift Early?",
          text: "The professional will be paid according to the applicable early-termination rules. This action cannot be undone.",
          confirmButtonText: "Yes, End Shift",
        }).then(function (confirmed) {
          if (!confirmed) return;

          setButtonLoading(button, true, false);

          axios
            .post(requestUrl, {
              _csrf: getCsrfToken(),
            })
            .then(function (response) {
              var payload = getResponsePayload(response);

              var message =
                response?.data?.message || payload.message || "The Shift was ended successfully.";

              return showSuccess("Shift Ended", message).then(function () {
                redirectAfterRequest(response);
              });
            })
            .catch(function (error) {
              setButtonLoading(button, false, false);

              showError(getErrorMessage(error, "The Shift could not be ended early."));
            });
        });
      });
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

      showSuccess("Payment Confirmed", successMessage);

      return;
    }

    if (paymentStatus === "pending") {
      Swal.fire({
        title: "Payment Processing",

        text:
          "Paystack has not confirmed the payment yet. " +
          "The Shift will remain in Pending Funding until verification succeeds.",

        icon: "info",

        buttonsStyling: false,

        confirmButtonText: "Ok, got it!",

        customClass: {
          confirmButton: "btn btn-primary",
        },
      });

      return;
    }

    showError(getPaymentFailureMessage(paymentCode));
  }

  /* ─────────────────────────────── INITIALIZATION ─────────────────────────────── */

  return {
    init: function () {
      shiftDetailsPage = document.querySelector("#shiftDetailsPage");

      if (!shiftDetailsPage) {
        return;
      }

      initializeAttendancePins();

      initializeFundingForm();

      handleCancelShiftButtons();

      handleEndShiftEarlyButtons();

      handlePaymentReturnMessage();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerShiftDetails.init();
});
