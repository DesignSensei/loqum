// public/js/reset-password.js

"use strict";

var PasswordReset = (function () {
  var form = document.querySelector("#kt_password_reset_form");
  var submitButton = document.querySelector("#kt_password_reset_submit");

  function handlePasswordResetSubmission() {
    if (!form || !submitButton) return;

    // Form Validation Setup
    const validator = FormValidation.formValidation(form, {
      fields: {
        email: {
          validators: {
            notEmpty: { message: "Email is required." },
            regexp: {
              regexp: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
              message: "Please enter a valid email address.",
            },
          },
        },
      },
      plugins: {
        trigger: new FormValidation.plugins.Trigger(),
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

      validator.validate().then(function (status) {
        if (status === "Valid") {
          // Show loading indicator
          submitButton.setAttribute("data-kt-indicator", "on");
          submitButton.disabled = true;

          // ✅ Automatically includes the hidden _csrf field
          const data = Object.fromEntries(new FormData(form));

          axios
            .post(form.action, data)
            .then(function (response) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text:
                  response.data.message ||
                  "Password reset link has been sent to your email.",
                icon: "success",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              }).then(function () {
                // Redirect to the URL specified in the form's data attribute
                const redirectUrl = form.getAttribute("data-kt-redirect-url");
                if (redirectUrl) {
                  window.location.href = redirectUrl;
                }
              });
            })
            .catch(function (error) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text:
                  error.response?.data?.message ||
                  "An error occurred. Please try again.",
                icon: "error",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              });
            });
        } else {
          Swal.fire({
            text: "Please enter a valid email address.",
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: { confirmButton: "btn btn-primary" },
          });
        }
      });
    });
  }

  return {
    init: function () {
      handlePasswordResetSubmission();
    },
  };
})();

// Initialize when DOM is loaded
KTUtil.onDOMContentLoaded(function () {
  PasswordReset.init();
});
