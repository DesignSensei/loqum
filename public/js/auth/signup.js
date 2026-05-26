// public/js/signup.js

"use strict";

var SignUp = (function () {
  var form = document.querySelector("#kt_sign_up_form");
  var submitButton = document.querySelector("#kt_sign_up_submit");
  var googleSignupButton = document.querySelector("#googleSignupBtn");
  var passwordMeter;

  function getSelectedRole() {
    return form.querySelector('input[name="role"]:checked')?.value;
  }

  function handleGoogleSignup() {
    if (!form || !googleSignupButton) return;

    googleSignupButton.addEventListener("click", function (e) {
      e.preventDefault();

      const selectedRole = getSelectedRole();

      if (!selectedRole) {
        Swal.fire({
          text: "Please select an account type before continuing with Google.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: { confirmButton: "btn btn-primary" },
        });

        return;
      }

      window.location.href = `/auth/google?intent=signup&role=${encodeURIComponent(selectedRole)}`;
    });
  }

  function handleSignupSubmission() {
    if (!form || !submitButton) return;

    passwordMeter = KTPasswordMeter.getInstance(
      form.querySelector('[data-kt-password-meter="true"]')
    );

    const validator = FormValidation.formValidation(form, {
      fields: {
        firstName: {
          validators: {
            notEmpty: { message: "First Name is required." },
          },
        },

        lastName: {
          validators: {
            notEmpty: { message: "Last Name is required." },
          },
        },

        email: {
          validators: {
            notEmpty: { message: "Email is required." },
            regexp: {
              regexp: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
              message: "Please enter a valid email address.",
            },
          },
        },

        role: {
          validators: {
            notEmpty: { message: "Please select a role." },
          },
        },

        password: {
          validators: {
            notEmpty: { message: "Password is required." },
            callback: {
              message: "Please enter a valid password.",
              callback: function (input) {
                if (input.value.length > 0) {
                  return passwordMeter.getScore() > 50;
                }

                return false;
              },
            },
          },
        },

        confirmPassword: {
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
            notEmpty: {
              message: "You must accept the terms and conditions.",
            },
          },
        },
      },

      plugins: {
        excluded: new FormValidation.plugins.Excluded({
          excluded: function (field, element) {
            return element.closest(".d-none") !== null;
          },
        }),

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

    submitButton.addEventListener("click", function (e) {
      e.preventDefault();

      validator.revalidateField("password");

      validator.validate().then(function (status) {
        if (status === "Valid") {
          submitButton.setAttribute("data-kt-indicator", "on");
          submitButton.disabled = true;

          const data = Object.fromEntries(new FormData(form));

          axios
            .post(form.action, data)
            .then(function (response) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text: response.data.message,
                icon: "success",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              }).then(function () {
                window.location.href = response.data.redirectUrl;
              });
            })
            .catch(function (error) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text: error.response?.data?.message || "An error occurred. Please try again.",
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

    form.querySelector('input[name="password"]').addEventListener("input", function () {
      if (this.value.length > 0) {
        validator.updateFieldStatus("password", "NotValidated");
      }
    });

    form.querySelectorAll('[name="role"]').forEach(function (input) {
      input.addEventListener("change", function () {
        validator.revalidateField("role");
      });
    });
  }

  return {
    init: function () {
      handleGoogleSignup();
      handleSignupSubmission();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  SignUp.init();
});
