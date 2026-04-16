// public/js/new-password.js

"use strict";

var NewPassword = (function () {
  var form = document.querySelector("#kt_new_password_form");
  var submitButton = document.querySelector("#kt_new_password_submit");
  var passwordMeter;

  function handleNewPasswordSubmission() {
    if (!form || !submitButton) return;

    // Initialize Password Meter
    passwordMeter = KTPasswordMeter.getInstance(
      form.querySelector('[data-kt-password-meter="true"]'),
    );

    // Form Validation Setup
    const validator = FormValidation.formValidation(form, {
      fields: {
        password: {
          validators: {
            notEmpty: { message: "Password is required." },
            callback: {
              message: "Please enter a stronger password.",
              callback: function (input) {
                if (input.value.length > 0) {
                  return passwordMeter.getScore() > 50;
                }
                return true;
              },
            },
          },
        },
        "confirm-password": {
          validators: {
            notEmpty: { message: "Please confirm your password." },
            identical: {
              compare: function () {
                return form.querySelector('[name="password"]').value;
              },
              message: "Passwords do not match.",
            },
          },
        },
        toc: {
          validators: {
            notEmpty: { message: "You must accept the terms and conditions." },
          },
        },
      },
      plugins: {
        trigger: new FormValidation.plugins.Trigger({
          event: { password: false },
        }),
        bootstrap: new FormValidation.plugins.Bootstrap5({
          rowSelector: ".fv-row",
          eleInvalidClass: "",
          eleValidClass: "",
        }),
      },
    });

    // Submit Button Click Handler
    submitButton.addEventListener("click", function (e) {
      e.preventDefault();

      validator.revalidateField("password");

      validator.validate().then(function (status) {
        if (status === "Valid") {
          // Show loading indicator
          submitButton.setAttribute("data-kt-indicator", "on");
          submitButton.disabled = true;

          // ✅ Automatically includes hidden _csrf field
          const data = Object.fromEntries(new FormData(form));

          axios
            .post(form.action, data)
            .then(function (response) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text:
                  response.data.message ||
                  "Password has been reset successfully.",
                icon: "success",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              }).then(function () {
                // Redirect to the URL specified in the form or response
                window.location.href =
                  response.data.redirectUrl ||
                  form.getAttribute("data-kt-redirect-url");
              });
            })
            .catch(function (error) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text:
                  error.response?.data?.message ||
                  "An error occurred while resetting password. Please try again.",
                icon: "error",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              });
            });
        } else {
          Swal.fire({
            text: "Please make sure all required fields are correctly filled out.",
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: { confirmButton: "btn btn-primary" },
          });
        }
      });
    });

    // Live validation for password field
    form
      .querySelector('input[name="password"]')
      .addEventListener("input", function () {
        if (this.value.length > 0) {
          validator.updateFieldStatus("password", "NotValidated");
        }
      });
  }

  return {
    init: function () {
      handleNewPasswordSubmission();
    },
  };
})();

// Initialize when DOM is loaded
KTUtil.onDOMContentLoaded(function () {
  NewPassword.init();
});
