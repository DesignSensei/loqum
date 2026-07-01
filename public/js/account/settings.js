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

  return {
    init: function () {
      bindModalSelects();
      bindProfileUpdate();
      bindProfilePhotoUpdate();
      bindEmailChange();
      bindEnableTwoFactor();
      bindDisableTwoFactor();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  AccountSettings.init();
});
