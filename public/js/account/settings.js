// public/js/account/settings.js

"use strict";

var AccountSettings = (function () {
  function getCsrfToken() {
    var tokenInput = document.querySelector("#accountSettingsCsrfToken");

    return tokenInput ? tokenInput.value : "";
  }

  function getCsrfHeaders() {
    return {
      "X-CSRF-Token": getCsrfToken(),
    };
  }

  function getErrorMessage(error, fallbackMessage) {
    return (
      error?.response?.data?.message ||
      error?.response?.data?.error ||
      error?.message ||
      fallbackMessage
    );
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

  function hideModal(modalSelector) {
    var modalElement = document.querySelector(modalSelector);

    if (!modalElement || !window.bootstrap) return;

    var modal = bootstrap.Modal.getInstance(modalElement);

    if (modal) {
      modal.hide();
    }
  }

  function hideModalAndWait(modalSelector) {
    var modalElement = document.querySelector(modalSelector);

    return new Promise(function (resolve) {
      if (!modalElement || !window.bootstrap) {
        resolve();
        return;
      }

      var modal =
        bootstrap.Modal.getInstance(modalElement) ||
        bootstrap.Modal.getOrCreateInstance(modalElement);

      if (!modalElement.classList.contains("show")) {
        resolve();
        return;
      }

      modalElement.addEventListener(
        "hidden.bs.modal",
        function () {
          resolve();
        },
        { once: true }
      );

      modal.hide();
    });
  }

  function showSuccess(message) {
    return Swal.fire({
      text: message,
      icon: "success",
      buttonsStyling: false,
      confirmButtonText: "Okay",
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
      confirmButtonText: "Okay",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function initModalSelects() {
    if (!window.jQuery || !$.fn.select2) return;

    var modal = $("#editProfileModal");
    var phoneCodeSelect = $("#accountPhoneCodeSelect");

    if (!modal.length || !phoneCodeSelect.length) return;

    if (phoneCodeSelect.hasClass("select2-hidden-accessible")) {
      phoneCodeSelect.select2("destroy");
    }

    phoneCodeSelect.select2({
      dropdownParent: modal,
      width: "100%",
      placeholder: phoneCodeSelect.data("placeholder") || "Code",
      allowClear: false,
      minimumResultsForSearch: 0,
    });
  }

  function bindModalSelects() {
    var modal = document.querySelector("#editProfileModal");

    if (!modal) return;

    modal.addEventListener("shown.bs.modal", function () {
      initModalSelects();
    });
  }

  function bindProfileUpdate() {
    var form = document.querySelector("#kt_account_profile_form");
    var submitButton = document.querySelector("#kt_account_profile_submit");

    if (!form || !submitButton) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      try {
        setButtonLoading(submitButton, true);

        var formData = new FormData(form);

        var data = {
          _csrf: getCsrfToken(),
          firstName: String(formData.get("firstName") || "").trim(),
          lastName: String(formData.get("lastName") || "").trim(),
          phoneCode: String(formData.get("phoneCode") || "").trim(),
          phoneNumber: String(formData.get("phoneNumber") || "").trim(),
        };

        await axios.post(form.action, data, {
          headers: getCsrfHeaders(),
        });

        hideModal("#editProfileModal");

        await showSuccess("Contact information updated successfully.");

        window.location.reload();
      } catch (error) {
        showError(getErrorMessage(error, "Unable to update contact information."));
      } finally {
        setButtonLoading(submitButton, false);
      }
    });
  }

  function bindProfilePhotoUpdate() {
    var form = document.querySelector("#kt_account_photo_form");
    var submitButton = document.querySelector("#kt_account_photo_submit");
    var photoInput = document.querySelector("#accountPhotoInput");

    if (!form || !submitButton || !photoInput) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      var file = photoInput.files && photoInput.files[0];

      if (!file) {
        showError("Please select a profile photo.");
        return;
      }

      var allowedTypes = ["image/jpeg", "image/png", "image/webp"];
      var maxSize = 2 * 1024 * 1024;

      if (!allowedTypes.includes(file.type)) {
        showError("Only JPG, PNG, and WEBP images are allowed.");
        return;
      }

      if (file.size > maxSize) {
        showError("Profile photo must not be larger than 2MB.");
        return;
      }

      try {
        setButtonLoading(submitButton, true);

        var formData = new FormData(form);

        if (!formData.get("_csrf")) {
          formData.append("_csrf", getCsrfToken());
        }

        await axios.post(form.action, formData, {
          headers: getCsrfHeaders(),
        });

        hideModal("#updateProfilePhotoModal");

        await showSuccess("Profile photo updated successfully.");

        window.location.reload();
      } catch (error) {
        showError(getErrorMessage(error, "Unable to update profile photo."));
      } finally {
        setButtonLoading(submitButton, false);
      }
    });
  }

  function bindEmailChange() {
    var form = document.querySelector("#kt_change_email_form");
    var submitButton = document.querySelector("#kt_change_email_submit");

    if (!form || !submitButton) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      var sendUrl = form.dataset.sendUrl;
      var confirmUrl = form.dataset.confirmUrl;
      var csrfToken = getCsrfToken();

      var newEmailInput = form.querySelector('[name="newEmail"]');
      var newEmail = newEmailInput ? newEmailInput.value.trim() : "";

      if (!sendUrl || !confirmUrl) return;

      if (!newEmail) {
        showError("Please enter your new email address.");
        return;
      }

      try {
        setButtonLoading(submitButton, true);

        await axios.post(
          sendUrl,
          {
            _csrf: csrfToken,
            newEmail: newEmail,
          },
          {
            headers: getCsrfHeaders(),
          }
        );

        setButtonLoading(submitButton, false);

        await hideModalAndWait("#changeEmailModal");

        var otpResult = await Swal.fire({
          title: "Enter OTP",
          text: "We sent a 6-digit OTP to your new email address.",
          input: "text",
          inputPlaceholder: "Enter 6-digit OTP",
          inputAttributes: {
            maxlength: 6,
            autocapitalize: "off",
            autocorrect: "off",
          },
          showCancelButton: true,
          confirmButtonText: "Update Email",
          cancelButtonText: "Cancel",
          buttonsStyling: false,
          heightAuto: false,
          customClass: {
            confirmButton: "btn btn-primary",
            cancelButton: "btn btn-light",
          },
          preConfirm: async function (otp) {
            if (!otp) {
              Swal.showValidationMessage("Please enter the OTP.");
              return false;
            }

            try {
              await axios.post(
                confirmUrl,
                {
                  _csrf: csrfToken,
                  otp: otp,
                },
                {
                  headers: getCsrfHeaders(),
                }
              );

              return true;
            } catch (error) {
              Swal.showValidationMessage(getErrorMessage(error, "Unable to update email address."));

              return false;
            }
          },
        });

        if (otpResult.isConfirmed) {
          await showSuccess("Email address updated successfully.");

          window.location.reload();
        }
      } catch (error) {
        showError(getErrorMessage(error, "Unable to send OTP."));
      } finally {
        setButtonLoading(submitButton, false);
      }
    });
  }

  function bindPasswordUpdate() {
    const form = document.querySelector("#kt_change_password_form");
    const submitButton = document.querySelector("#kt_change_password_submit");

    if (!form || !submitButton) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      const formData = new FormData(form);

      const currentPassword = String(formData.get("currentPassword") || "").trim();
      const newPassword = String(formData.get("newPassword") || "").trim();
      const confirmPassword = String(formData.get("confirmPassword") || "").trim();

      if (!currentPassword) {
        showError("Current password is required.");
        return;
      }

      if (!newPassword) {
        showError("New password is required.");
        return;
      }

      if (!confirmPassword) {
        showError("Please confirm your new password.");
        return;
      }

      if (newPassword !== confirmPassword) {
        showError("New password and confirmation do not match.");
        return;
      }

      if (currentPassword === newPassword) {
        showError("New password must be different from your current password.");
        return;
      }

      try {
        setButtonLoading(submitButton, true);

        const payload = {
          _csrf: getCsrfToken(),
          currentPassword,
          newPassword,
          confirmPassword,
        };

        const response = await axios.post(form.action, payload, {
          headers: getCsrfHeaders(),
        });

        hideModal("#changePasswordModal");

        form.reset();

        await showSuccess(response.data?.message || "Password updated successfully.");

        window.location.reload();
      } catch (error) {
        showError(getErrorMessage(error, "Unable to update password."));
      } finally {
        setButtonLoading(submitButton, false);
      }
    });
  }

  async function handleTwoFactorAction(button, options) {
    var sendUrl = button.dataset.sendUrl;
    var actionUrl = button.dataset[options.actionUrlKey];
    var csrfToken = getCsrfToken();

    if (!sendUrl || !actionUrl) return;

    try {
      setButtonLoading(button, true);

      await axios.post(
        sendUrl,
        {
          _csrf: csrfToken,
        },
        {
          headers: getCsrfHeaders(),
        }
      );

      setButtonLoading(button, false);

      var result = await Swal.fire({
        title: "Enter OTP",
        text: options.otpMessage,
        input: "text",
        inputPlaceholder: "Enter 6-digit OTP",
        inputAttributes: {
          maxlength: 6,
          autocapitalize: "off",
          autocorrect: "off",
        },
        showCancelButton: true,
        confirmButtonText: options.confirmText,
        cancelButtonText: "Cancel",
        buttonsStyling: false,
        customClass: {
          confirmButton: options.confirmButtonClass,
          cancelButton: "btn btn-light",
        },
        preConfirm: async function (otp) {
          if (!otp) {
            Swal.showValidationMessage("Please enter the OTP.");
            return false;
          }

          try {
            await axios.post(
              actionUrl,
              {
                _csrf: csrfToken,
                otp: otp,
              },
              {
                headers: getCsrfHeaders(),
              }
            );

            return true;
          } catch (error) {
            Swal.showValidationMessage(getErrorMessage(error, options.errorMessage));

            return false;
          }
        },
      });

      if (result.isConfirmed) {
        await showSuccess(options.successMessage);

        window.location.reload();
      }
    } catch (error) {
      showError(getErrorMessage(error, "Unable to send OTP."));
    } finally {
      setButtonLoading(button, false);
    }
  }

  function bindEnableTwoFactor() {
    var button = document.querySelector("#kt_enable_2fa_button");

    if (!button) return;

    button.addEventListener("click", function () {
      handleTwoFactorAction(button, {
        actionUrlKey: "enableUrl",
        otpMessage: "We sent a 6-digit OTP to your email address.",
        confirmText: "Turn on 2FA",
        confirmButtonClass: "btn btn-primary",
        successMessage: "Two-factor authentication has been turned on.",
        errorMessage: "Unable to turn on two-factor authentication.",
      });
    });
  }

  function bindDisableTwoFactor() {
    var button = document.querySelector("#kt_disable_2fa_button");

    if (!button) return;

    button.addEventListener("click", function () {
      handleTwoFactorAction(button, {
        actionUrlKey: "disableUrl",
        otpMessage: "We sent a 6-digit OTP to your email address.",
        confirmText: "Turn off 2FA",
        confirmButtonClass: "btn btn-danger",
        successMessage: "Two-factor authentication has been turned off.",
        errorMessage: "Unable to turn off two-factor authentication.",
      });
    });
  }

  function setAppearanceButtonState(activeMode) {
    var buttons = document.querySelectorAll(".js-theme-mode-option");

    buttons.forEach(function (button) {
      var isActive = button.getAttribute("data-theme-mode-value") === activeMode;

      button.classList.toggle("btn-primary", isActive);
      button.classList.toggle("btn-light", !isActive);
    });
  }

  function getCurrentThemeMode() {
    if (window.KTThemeMode && typeof window.KTThemeMode.getMode === "function") {
      return window.KTThemeMode.getMode();
    }

    return localStorage.getItem("data-bs-theme") || "system";
  }

  function bindAppearanceMode() {
    var buttons = document.querySelectorAll(".js-theme-mode-option");

    if (!buttons.length) return;

    setAppearanceButtonState(getCurrentThemeMode());

    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        var mode = button.getAttribute("data-theme-mode-value");

        if (!["light", "dark", "system"].includes(mode)) return;

        var headerThemeOption = document.querySelector(
          '[data-kt-element="theme-mode-menu"] [data-kt-element="mode"][data-kt-value="' +
            mode +
            '"]'
        );

        if (headerThemeOption) {
          headerThemeOption.click();
        } else if (window.KTThemeMode && typeof window.KTThemeMode.setMode === "function") {
          window.KTThemeMode.setMode(mode);
        } else {
          var resolvedMode = mode;

          if (mode === "system") {
            resolvedMode = window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light";
          }

          document.documentElement.setAttribute("data-bs-theme", resolvedMode);
          localStorage.setItem("data-bs-theme", mode);
        }

        setAppearanceButtonState(mode);
      });
    });
  }


  /* ---------- CLOSURE ---------- */

  function bindClosurePanel() {
    const panel = document.querySelector("[data-closure-panel]");
    if (!panel) return;

    const check = panel.querySelector("[data-closure-check]");
    const submit = panel.querySelector("[data-closure-submit]");
    const status = panel.querySelector("[data-closure-status]");
    const blockers = panel.querySelector("[data-closure-blockers]");
    const unavailable = panel.querySelector("[data-closure-unavailable]");
    const csrf = panel.querySelector("[data-closure-csrf]").value;
    const url = panel.dataset.closureUrl;
    const enabled = panel.dataset.executionEnabled === "true";

    let busy = false;
    let ready = false;

    unavailable.hidden = enabled;

    function updateButtons() {
      check.disabled = busy;
      submit.disabled = busy || !enabled || !ready;
    }

    function displayEligibility(eligibility) {
      ready = false;

      blockers.replaceChildren();
      blockers.hidden = true;

      if (!eligibility ||
          !Array.isArray(eligibility.blockers) ||
          !Array.isArray(eligibility.pendingChecks)) {
        status.textContent = "Eligibility could not be confirmed.";
        return;
      }

      for (const blocker of eligibility.blockers) {
        const item = document.createElement("li");

        item.textContent = blocker?.message ||
          "An outstanding commitment requires review.";

        blockers.appendChild(item);
      }

      blockers.hidden = blockers.children.length === 0;

      ready = eligibility.canClose === true &&
        eligibility.blockers.length === 0 &&
        eligibility.pendingChecks.length === 0;

      status.textContent = ready
        ? "No outstanding closure blockers were reported."
        : eligibility.pendingChecks.length
          ? "Further reconciliation is required before closure."
          : "Resolve outstanding commitments before closure.";
    }

    async function checkEligibility() {
      if (busy) return;

      busy = true;
      ready = false;

      blockers.replaceChildren();
      blockers.hidden = true;

      status.textContent = "Checking eligibility...";

      updateButtons();

      try {
        const response = await axios.get(url + "/eligibility");

        if (response.data?.success !== true) {
          throw new Error("Eligibility could not be confirmed.");
        }

        displayEligibility(response.data.eligibility);
      } catch (error) {
        status.textContent = error?.response?.data?.message ||
          "Unable to check eligibility. Please try again.";
      } finally {
        busy = false;
        updateButtons();
      }
    }

    async function requestClosure() {
      if (busy || !enabled || !ready) return;

      busy = true;
      updateButtons();

      try {
        const confirmation = panel.dataset.confirmation;

        const result = await Swal.fire({
          title: "Confirm permanent closure",
          text: "Enter " + confirmation + " to continue.",
          input: "text",

          inputAttributes: {
            autocomplete: "off",
          },

          showCancelButton: true,
          confirmButtonText: "Close permanently",
          cancelButtonText: "Cancel",
          buttonsStyling: false,

          customClass: {
            confirmButton: "btn btn-danger",
            cancelButton: "btn btn-light",
          },

          inputValidator: function (value) {
            if (value !== confirmation) {
              return "Enter the confirmation phrase exactly.";
            }
          },
        });

        if (!result.isConfirmed || result.value !== confirmation) return;

        ready = false;

        const response = await axios.post(url, {
          confirmation: confirmation,
          _csrf: csrf,
        }, {
          headers: {
            "X-CSRF-Token": csrf,
          },
        });

        if (response.data?.success !== true ||
            response.data?.closed !== true) {
          throw new Error("Closure was not confirmed.");
        }

        await Swal.fire({
          icon: "success",
          text: response.data.message ||
            "Closure completed successfully.",
        });

        window.location.assign(panel.dataset.redirect);
      } catch (error) {
        ready = false;

        const data = error?.response?.data;

        if (data?.eligibility) {
          displayEligibility(data.eligibility);
        }

        ready = false;

        await Swal.fire({
          icon: "error",
          text: data?.message ||
            "Closure could not be confirmed. Check eligibility before retrying.",
        });
      } finally {
        busy = false;
        updateButtons();
      }
    }

    check.addEventListener("click", checkEligibility);
    submit.addEventListener("click", requestClosure);

    updateButtons();
  }

  return {
    init: function () {
      bindClosurePanel();
      bindModalSelects();
      bindProfileUpdate();
      bindProfilePhotoUpdate();
      bindEmailChange();
      bindPasswordUpdate();
      bindAppearanceMode();
      bindEnableTwoFactor();
      bindDisableTwoFactor();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AccountSettings.init();
});
