// public/js/employer/shift-details.js

"use strict";

var EmployerShiftDetails = (function () {
  var shiftDetailsPage = null;
  var attendancePinPanel = null;
  var pinErrorAlert = null;
  var pinValues = { check_in: null, check_out: null };

  var fundingForm = null;
  var fundingSubmitButton = null;
  var fundingErrorAlert = null;
  var fundingMethodInputs = [];
  var fundingRequestInProgress = false;

  var overtimeRequestInProgress = false;

  /* ───────────────────────────── GENERAL HELPERS ───────────────────────────── */

  function getErrorMessage(error, fallback) {
    return (
      error?.response?.data?.message ||
      error?.response?.data?.error?.message ||
      error?.message ||
      fallback
    );
  }

  function getResponsePayload(response) {
    var data = response?.data || {};
    return data.data && typeof data.data === "object" ? data.data : data;
  }

  function getNestedValue(source, path) {
    if (!source || !path) return null;

    return path.split(".").reduce(function (value, key) {
      return value === null || value === undefined ? null : value[key];
    }, source);
  }

  function getFirstValue(source, paths, fallback) {
    for (var i = 0; i < paths.length; i += 1) {
      var value = getNestedValue(source, paths[i]);

      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }

    return fallback === undefined ? null : fallback;
  }

  function parseBoolean(value) {
    return (
      value === true ||
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

  function postProtectedJson(url, payload) {
    var csrfToken = getCsrfToken();

    return axios.post(url, Object.assign({ _csrf: csrfToken }, payload || {}), {
      headers: {
        "CSRF-Token": csrfToken,
        Accept: "application/json",
      },
    });
  }

  function setButtonLoading(button, loading, disabledWhenIdle) {
    if (!button) return;

    if (loading) {
      button.setAttribute("data-kt-indicator", "on");
      button.disabled = true;
    } else {
      button.removeAttribute("data-kt-indicator");
      button.disabled = Boolean(disabledWhenIdle);
    }
  }

  function showSuccess(title, message) {
    return Swal.fire({
      title: title,
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

  function showConfirmation(options) {
    return Swal.fire({
      title: options.title,
      text: options.text,
      icon: "warning",
      showCancelButton: true,
      buttonsStyling: false,
      confirmButtonText: options.confirmButtonText,
      cancelButtonText: "Cancel",
      customClass: {
        confirmButton: options.confirmButtonClass || "btn btn-danger",
        cancelButton: "btn btn-light",
      },
    }).then(function (result) {
      return result.isConfirmed === true;
    });
  }

  function redirectAfterRequest(response) {
    var payload = getResponsePayload(response);

    var url =
      getFirstValue(response?.data, ["shiftDetailsUrl", "redirectUrl", "manageShiftsUrl"], null) ||
      getFirstValue(payload, ["shiftDetailsUrl", "redirectUrl", "manageShiftsUrl"], null);

    if (url && typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) {
      window.location.assign(url);
    } else {
      window.location.reload();
    }
  }

  /* ─────────────────────────── ATTENDANCE PINS ─────────────────────────── */

  function getPinElement(type, attribute) {
    return attendancePinPanel?.querySelector("[" + attribute + '="' + type + '"]') || null;
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

  function setPinState(type, pin, status) {
    var valueElement = getPinElement(type, "data-pin-value");
    var statusElement = getPinElement(type, "data-pin-status");
    var copyButton = getPinElement(type, "data-copy-pin");

    pinValues[type] = pin;

    if (valueElement) {
      valueElement.textContent = pin || "••••";
    }

    if (statusElement) {
      statusElement.textContent = status;
    }

    if (copyButton) {
      copyButton.disabled = !pin;
    }
  }

  function clearPinValues() {
    ["check_in", "check_out"].forEach(function (type) {
      setPinState(type, null, "PIN cleared");
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
    setPinState(type, null, "Loading PIN...");

    if (!url) {
      setPinState(type, null, "PIN endpoint unavailable");

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

        setPinState(type, pin, "Ready");
        return pin;
      })
      .catch(function (error) {
        setPinState(type, null, getErrorMessage(error, "PIN unavailable"));

        throw error;
      });
  }

  function loadAttendancePins() {
    if (!attendancePinPanel || !parseBoolean(attendancePinPanel.dataset.canViewPins)) {
      return;
    }

    hidePinError();

    Promise.allSettled([
      loadPin("check_in", attendancePinPanel.dataset.checkInPinUrl || ""),
      loadPin("check_out", attendancePinPanel.dataset.checkOutPinUrl || ""),
    ]).then(function (results) {
      var failed = results.filter(function (result) {
        return result.status === "rejected";
      });

      if (failed.length === 2) {
        showPinError("The attendance PINs could not be loaded. Refresh the page and try again.");
      } else if (failed.length === 1) {
        showPinError("One attendance PIN could not be loaded. The available PIN is still shown.");
      }
    });
  }

  function copyTextToClipboard(value) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }

    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");

      area.value = value;
      area.readOnly = true;
      area.style.position = "fixed";
      area.style.opacity = "0";

      document.body.appendChild(area);
      area.select();

      try {
        var copied = document.execCommand("copy");

        if (copied) {
          resolve();
        } else {
          reject(new Error("Copy command failed."));
        }
      } catch (error) {
        reject(error);
      } finally {
        area.remove();
      }
    });
  }

  function initializeAttendancePins() {
    attendancePinPanel = document.querySelector("[data-attendance-pin-panel]");

    if (!attendancePinPanel) return;

    pinErrorAlert = attendancePinPanel.querySelector("[data-pin-error]");

    ["check_in", "check_out"].forEach(function (type) {
      var button = getPinElement(type, "data-copy-pin");

      if (!button) return;

      button.addEventListener("click", function () {
        var pin = pinValues[type];

        if (!pin) return;

        var status = getPinElement(type, "data-pin-status");

        copyTextToClipboard(pin)
          .then(function () {
            if (status) {
              status.textContent = "Copied to clipboard";
            }

            window.setTimeout(function () {
              if (status && pinValues[type] === pin) {
                status.textContent = "Ready";
              }
            }, 2000);
          })
          .catch(function () {
            if (status) {
              status.textContent = "Unable to copy PIN";
            }
          });
      });
    });

    loadAttendancePins();

    window.addEventListener("pagehide", clearPinValues);
  }

  /* ───────────────────────────── PAYSTACK HELPERS ───────────────────────────── */

  function openCheckoutWindow() {
    // Opening must occur directly inside the user's click handler.
    var checkoutWindow = window.open("about:blank", "_blank");

    if (!checkoutWindow) {
      throw new Error(
        "Your browser blocked Paystack Checkout. Allow popups for Loqum and try again."
      );
    }

    checkoutWindow.opener = null;
    checkoutWindow.document.title = "Preparing Paystack Checkout";
    checkoutWindow.document.body.textContent = "Preparing your secure Paystack payment page...";

    return checkoutWindow;
  }

  function getCheckoutAuthorizationUrl(response) {
    var payload = getResponsePayload(response);

    var paths = [
      "checkout.authorizationUrl",
      "checkout.authorization_url",
      "authorizationUrl",
      "authorization_url",
      "checkoutUrl",
      "data.authorizationUrl",
      "data.authorization_url",
      "data.checkout.authorizationUrl",
      "data.checkout.authorization_url",
    ];

    var raw = getFirstValue(payload, paths, null) || getFirstValue(response?.data, paths, null);

    if (!raw || typeof raw !== "string") {
      throw new Error("Paystack did not return a Checkout authorization URL.");
    }

    var parsed;

    try {
      parsed = new URL(raw);
    } catch (error) {
      throw new Error("Paystack returned an invalid Checkout authorization URL.");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("Paystack returned an insecure Checkout authorization URL.");
    }

    return parsed.toString();
  }

  function closeCheckoutWindow(checkoutWindow) {
    if (checkoutWindow && !checkoutWindow.closed) {
      checkoutWindow.close();
    }
  }

  /* ───────────────────────── INITIAL SHIFT FUNDING ───────────────────────── */

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

  function setFundingOptionsDisabled(disabled) {
    fundingMethodInputs.forEach(function (input) {
      if (disabled) {
        input.dataset.wasDisabled = input.disabled ? "true" : "false";

        input.disabled = true;
      } else {
        input.disabled = input.dataset.wasDisabled === "true";

        delete input.dataset.wasDisabled;
      }
    });
  }

  function resetFundingRequestState() {
    fundingRequestInProgress = false;

    setButtonLoading(fundingSubmitButton, false, false);

    setFundingOptionsDisabled(false);
  }

  function submitFundingRequest(method, url) {
    var checkoutWindow = null;

    hideFundingError();

    if (method === "paystack_checkout") {
      try {
        checkoutWindow = openCheckoutWindow();
      } catch (error) {
        showFundingError(error.message);
        showError(error.message);
        return;
      }
    }

    fundingRequestInProgress = true;

    setButtonLoading(fundingSubmitButton, true, true);

    setFundingOptionsDisabled(true);

    postProtectedJson(url)
      .then(function (response) {
        var payload = getResponsePayload(response);

        if (
          method === "wallet" ||
          payload.alreadyFunded === true ||
          response?.data?.alreadyFunded === true
        ) {
          closeCheckoutWindow(checkoutWindow);

          var message =
            response?.data?.message ||
            payload.message ||
            "The Shift was funded and published successfully.";

          return showSuccess("Shift Published", message).then(function () {
            redirectAfterRequest(response);
          });
        }

        var checkoutUrl = getCheckoutAuthorizationUrl(response);

        checkoutWindow.location.replace(checkoutUrl);

        resetFundingRequestState();

        return null;
      })
      .catch(function (error) {
        closeCheckoutWindow(checkoutWindow);
        resetFundingRequestState();

        var message = getErrorMessage(
          error,
          method === "wallet"
            ? "The Shift could not be funded from your wallet."
            : "Paystack Checkout could not be initialized."
        );

        showFundingError(message);
        showError(message);
      });
  }

  function initializeFundingForm() {
    fundingForm = document.querySelector("#shiftFundingForm");

    if (!fundingForm) return;

    fundingSubmitButton = fundingForm.querySelector("[data-funding-submit]");

    fundingErrorAlert = fundingForm.querySelector("[data-funding-error]");

    fundingMethodInputs = Array.from(fundingForm.querySelectorAll('input[name="fundingMethod"]'));

    fundingForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (fundingRequestInProgress) return;

      hideFundingError();

      var selected = fundingForm.querySelector('input[name="fundingMethod"]:checked');

      if (!selected) {
        showFundingError("Select a payment method.");
        return;
      }

      var method = selected.value;

      if (method !== "wallet" && method !== "paystack_checkout") {
        showFundingError("Select a valid payment method.");
        return;
      }

      var url =
        method === "wallet"
          ? fundingSubmitButton?.dataset.walletUrl
          : fundingSubmitButton?.dataset.checkoutUrl;

      if (!url) {
        showFundingError("The selected payment endpoint is unavailable.");
        return;
      }

      submitFundingRequest(method, url);
    });
  }

  /* ───────────────────────── OVERTIME DECISIONS ───────────────────────── */

  function setOvertimeBusy(busy) {
    overtimeRequestInProgress = busy;

    document
      .querySelectorAll(
        "[data-overtime-approve], [data-overtime-reject], " +
          "[data-overtime-topup-wallet], [data-overtime-topup-checkout]"
      )
      .forEach(function (button) {
        if (busy) {
          button.dataset.overtimeWasDisabled = button.disabled ? "true" : "false";

          button.disabled = true;
        } else {
          button.disabled = button.dataset.overtimeWasDisabled === "true";

          delete button.dataset.overtimeWasDisabled;
        }
      });
  }

  function getOvertimeActionUrl(button) {
    return button?.dataset.url || "";
  }

  function confirmOvertimeApproval() {
    return showConfirmation({
      title: "Approve overtime?",
      text:
        "This approves the professional's requested overtime duration in full. " +
        "It may create an additional employer funding obligation.",
      confirmButtonText: "Yes, Approve Overtime",
      confirmButtonClass: "btn btn-success",
    });
  }

  function requestOvertimeRejectionDetails(requestedMinutes) {
    var basisOptions = [
      ["", "Choose a rejection basis"],
      ["overtime_not_worked", "Overtime was not worked"],
      ["minutes_incorrect", "Requested minutes are incorrect"],
      ["remained_on_site_not_working", "Stayed on site but was not working"],
      ["worked_without_authorization", "Work was not authorised"],
      ["attendance_record_incorrect", "Attendance record is incorrect"],
      ["other", "Other reason"],
    ];

    var optionsHtml = basisOptions
      .map(function (item) {
        return '<option value="' + item[0] + '">' + item[1] + "</option>";
      })
      .join("");

    var formHtml =
      '<div class="text-start">' +
      '<label for="otRejectionBasis" class="form-label fw-bold">Rejection basis</label>' +
      '<select id="otRejectionBasis" class="form-select form-select-solid mb-4">' +
      optionsHtml +
      "</select>" +
      '<div id="otProposedMinutesWrap" class="d-none mb-4">' +
      '<label for="otProposedMinutes" class="form-label fw-bold">Minutes actually worked</label>' +
      '<input id="otProposedMinutes" class="form-control form-control-solid" type="number" min="1" step="1" inputmode="numeric" />' +
      '<div class="form-text">Must be less than the minutes requested by the professional.</div>' +
      "</div>" +
      '<label for="otRejectionReason" class="form-label fw-bold">Explanation</label>' +
      '<textarea id="otRejectionReason" class="form-control form-control-solid mb-4" rows="4" maxlength="500" placeholder="Explain the basis for rejecting this overtime request"></textarea>' +
      '<label class="form-check form-check-custom form-check-solid mb-2">' +
      '<input id="otNoSupportingEvidence" class="form-check-input" type="checkbox" />' +
      '<span class="form-check-label text-start">I confirm that no supporting documentary evidence is being submitted with this rejection.</span>' +
      "</label>" +
      '<div class="form-text">This declaration is recorded with the overtime decision. Do not select it if you intend to supply evidence.</div>' +
      "</div>";

    return Swal.fire({
      title: "Reject overtime request",
      html: formHtml,
      width: 600,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Reject Overtime",
      cancelButtonText: "Cancel",
      focusConfirm: false,
      buttonsStyling: false,

      customClass: {
        confirmButton: "btn btn-danger",
        cancelButton: "btn btn-light",
      },

      didOpen: function () {
        var basis = document.getElementById("otRejectionBasis");

        var minutesWrap = document.getElementById("otProposedMinutesWrap");

        basis.addEventListener("change", function () {
          minutesWrap.classList.toggle("d-none", basis.value !== "minutes_incorrect");
        });
      },

      preConfirm: function () {
        var basis = document.getElementById("otRejectionBasis").value;

        var reason = document.getElementById("otRejectionReason").value.trim();

        var noEvidence = document.getElementById("otNoSupportingEvidence").checked;

        var minutesText = document.getElementById("otProposedMinutes").value.trim();

        var allowed = basisOptions.slice(1).some(function (option) {
          return option[0] === basis;
        });

        if (!allowed) {
          Swal.showValidationMessage("Select a rejection basis.");
          return false;
        }

        if (!reason || reason.length > 500) {
          Swal.showValidationMessage("Enter an explanation of no more than 500 characters.");
          return false;
        }

        if (!noEvidence) {
          Swal.showValidationMessage(
            "Confirm that you are submitting no supporting evidence. Evidence upload is not available in this dialog."
          );
          return false;
        }

        var data = {
          rejectionBasis: basis,
          rejectionReason: reason,
          rejectionNoSupportingEvidence: true,
        };

        if (basis === "minutes_incorrect") {
          var minutes = Number(minutesText);

          if (
            !/^\d+$/.test(minutesText) ||
            !Number.isSafeInteger(minutes) ||
            minutes <= 0 ||
            !Number.isSafeInteger(requestedMinutes) ||
            minutes >= requestedMinutes
          ) {
            Swal.showValidationMessage(
              "Enter whole minutes greater than zero and less than the professional's requested minutes."
            );
            return false;
          }

          data.employerProposedMinutes = minutes;
        }

        return data;
      },
    }).then(function (result) {
      return result.isConfirmed === true ? result.value : null;
    });
  }

  function handleOvertimeDecisionSuccess(response, title) {
    var payload = getResponsePayload(response);

    var message = response?.data?.message || payload.message || "Overtime decision recorded.";

    return showSuccess(title, message).then(function () {
      redirectAfterRequest(response);
    });
  }

  function initializeOvertimeDecisions() {
    document.querySelectorAll("[data-overtime-approve]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (overtimeRequestInProgress || button.disabled) {
          return;
        }

        var url = getOvertimeActionUrl(button);

        if (!url) {
          showError("The overtime approval endpoint is unavailable.");
          return;
        }

        confirmOvertimeApproval().then(function (confirmed) {
          if (!confirmed || overtimeRequestInProgress) {
            return;
          }

          setOvertimeBusy(true);

          postProtectedJson(url)
            .then(function (response) {
              return handleOvertimeDecisionSuccess(response, "Overtime Approved");
            })
            .catch(function (error) {
              showError(getErrorMessage(error, "Unable to approve overtime."));
            })
            .finally(function () {
              setOvertimeBusy(false);
            });
        });
      });
    });

    document.querySelectorAll("[data-overtime-reject]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (overtimeRequestInProgress || button.disabled) {
          return;
        }

        var url = getOvertimeActionUrl(button);

        if (!url) {
          showError("The overtime rejection endpoint is unavailable.");
          return;
        }

        var requestedMinutes = Number(button.dataset.requestedMinutes || "");

        requestOvertimeRejectionDetails(requestedMinutes).then(function (details) {
          if (!details || overtimeRequestInProgress) {
            return;
          }

          setOvertimeBusy(true);

          postProtectedJson(url, details)
            .then(function (response) {
              return handleOvertimeDecisionSuccess(response, "Overtime Rejected");
            })
            .catch(function (error) {
              showError(getErrorMessage(error, "Unable to reject overtime."));
            })
            .finally(function () {
              setOvertimeBusy(false);
            });
        });
      });
    });
  }

  /* ─────────────────────── OVERTIME TOP-UP FUNDING ─────────────────────── */

  function initializeOvertimeTopUpFunding() {
    document.querySelectorAll("[data-overtime-topup-wallet]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (overtimeRequestInProgress || button.disabled) {
          return;
        }

        var url = getOvertimeActionUrl(button);

        if (!url) {
          showError("The overtime wallet top-up endpoint is unavailable.");
          return;
        }

        showConfirmation({
          title: "Pay overtime top-up?",
          text: "The approved overtime top-up will be deducted from your employer wallet.",
          confirmButtonText: "Pay from Wallet",
          confirmButtonClass: "btn btn-primary",
        }).then(function (confirmed) {
          if (!confirmed || overtimeRequestInProgress) {
            return;
          }

          setOvertimeBusy(true);

          postProtectedJson(url)
            .then(function (response) {
              var payload = getResponsePayload(response);

              return showSuccess(
                "Overtime Top-up Paid",
                response?.data?.message || payload.message || "Overtime funding was recorded."
              ).then(function () {
                redirectAfterRequest(response);
              });
            })
            .catch(function (error) {
              showError(
                getErrorMessage(error, "Unable to fund the overtime top-up from your wallet.")
              );
            })
            .finally(function () {
              setOvertimeBusy(false);
            });
        });
      });
    });

    document.querySelectorAll("[data-overtime-topup-checkout]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (overtimeRequestInProgress || button.disabled) {
          return;
        }

        var url = getOvertimeActionUrl(button);

        if (!url) {
          showError("The overtime Paystack endpoint is unavailable.");
          return;
        }

        var checkoutWindow;

        try {
          checkoutWindow = openCheckoutWindow();
        } catch (error) {
          showError(error.message);
          return;
        }

        setOvertimeBusy(true);

        postProtectedJson(url)
          .then(function (response) {
            var payload = getResponsePayload(response);

            if (payload.alreadyFunded === true || response?.data?.alreadyFunded === true) {
              closeCheckoutWindow(checkoutWindow);

              return showSuccess(
                "Overtime Top-up Paid",
                response?.data?.message || payload.message || "Overtime has already been funded."
              ).then(function () {
                redirectAfterRequest(response);
              });
            }

            checkoutWindow.location.replace(getCheckoutAuthorizationUrl(response));

            return null;
          })
          .catch(function (error) {
            closeCheckoutWindow(checkoutWindow);

            showError(getErrorMessage(error, "Unable to initialize the overtime Paystack top-up."));
          })
          .finally(function () {
            setOvertimeBusy(false);
          });
      });
    });
  }

  /* ────────────────────────── SHIFT CANCELLATION ────────────────────────── */

  function buildCancellationPreviewMessage(payload) {
    var message = getFirstValue(payload, ["message", "summary.message", "preview.message"], null);

    if (message) return message;

    var compensation = getFirstValue(
      payload,
      [
        "professionalCompensationDisplay",
        "compensation.professionalPayDisplay",
        "preview.professionalCompensationDisplay",
      ],
      null
    );

    var refund = getFirstValue(
      payload,
      ["refundAmountDisplay", "refund.refundAmountDisplay", "preview.refundAmountDisplay"],
      null
    );

    var parts = ["This action will cancel the applicable Shift occurrence or engagement."];

    if (compensation) {
      parts.push("Professional compensation: " + compensation + ".");
    }

    if (refund) {
      parts.push("Expected refund: " + refund + ".");
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

        var preview = previewUrl
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

        preview
          .then(function (response) {
            return showConfirmation({
              title: "Cancel Shift?",
              text: buildCancellationPreviewMessage(getResponsePayload(response)),
              confirmButtonText: "Yes, Cancel Shift",
            });
          })
          .then(function (confirmed) {
            if (!confirmed) {
              setButtonLoading(button, false, false);
              return null;
            }

            return postProtectedJson(cancelUrl);
          })
          .then(function (response) {
            if (!response) return;

            var payload = getResponsePayload(response);

            return showSuccess(
              "Shift Cancelled",
              response?.data?.message || payload.message || "The Shift was cancelled successfully."
            ).then(function () {
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

  /* ────────────────────────── EARLY TERMINATION ────────────────────────── */

  function handleEndShiftEarlyButtons() {
    document.querySelectorAll("[data-end-shift-early]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) return;

        var url = button.dataset.endEarlyUrl;

        if (!url) {
          showError("The early-termination endpoint is unavailable.");
          return;
        }

        showConfirmation({
          title: "End Shift Early?",
          text:
            "The professional will be paid according to the applicable early-termination rules. " +
            "This action cannot be undone.",
          confirmButtonText: "Yes, End Shift",
        }).then(function (confirmed) {
          if (!confirmed) return;

          setButtonLoading(button, true, false);

          postProtectedJson(url)
            .then(function (response) {
              var payload = getResponsePayload(response);

              return showSuccess(
                "Shift Ended",
                response?.data?.message || payload.message || "The Shift was ended successfully."
              ).then(function () {
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

  /* ────────────────────────── PAYSTACK CALLBACK MESSAGE ────────────────────────── */

  function getPaymentFailureMessage(code) {
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
      messages[code] || "The Shift payment could not be verified. The Shift remains unpublished."
    );
  }

  function cleanPaymentQueryParameters() {
    var url = new URL(window.location.href);

    ["payment", "shift", "paymentCode", "alreadyFunded"].forEach(function (key) {
      url.searchParams.delete(key);
    });

    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }

  function handlePaymentReturnMessage() {
    var params = new URLSearchParams(window.location.search);

    var status = params.get("payment");

    if (!status) return;

    var shiftReference = params.get("shift");
    var code = params.get("paymentCode");

    var alreadyFunded = params.get("alreadyFunded") === "true";

    cleanPaymentQueryParameters();

    if (status === "success") {
      var message = shiftReference
        ? "Shift " + shiftReference + " was funded and published successfully."
        : "The Shift was funded and published successfully.";

      if (alreadyFunded) {
        message = shiftReference
          ? "Shift " + shiftReference + " had already been funded and published."
          : "The Shift had already been funded and published.";
      }

      showSuccess("Payment Confirmed", message);

      return;
    }

    if (status === "pending") {
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

    showError(getPaymentFailureMessage(code));
  }

  /* ───────────────────────────── INITIALIZATION ───────────────────────────── */

  return {
    init: function () {
      shiftDetailsPage = document.querySelector("#shiftDetailsPage");

      if (!shiftDetailsPage) return;

      initializeAttendancePins();
      initializeFundingForm();

      initializeOvertimeDecisions();
      initializeOvertimeTopUpFunding();

      handleCancelShiftButtons();
      handleEndShiftEarlyButtons();
      handlePaymentReturnMessage();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerShiftDetails.init();
});
