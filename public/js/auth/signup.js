// public/js/auth/signup.js

"use strict";

var SignUp = (function () {
  var form;
  var submitButton;
  var googleSignupButton;
  var passwordMeter;
  var validator;

  function getInviteToken() {
    var inviteTokenInput = form.querySelector('input[name="inviteToken"]');

    return inviteTokenInput ? String(inviteTokenInput.value || "").trim() : "";
  }

  function isInviteSignup() {
    return Boolean(getInviteToken());
  }

  function getSelectedRole() {
    var selectedRoleInput = form.querySelector('input[name="role"]:checked');

    return selectedRoleInput ? selectedRoleInput.value : "";
  }

  function handleGoogleSignup() {
    if (!form || !googleSignupButton) return;

    googleSignupButton.addEventListener("click", function (e) {
      e.preventDefault();

      if (isInviteSignup()) {
        var inviteGoogleUrl = googleSignupButton.dataset.googleSignupUrl;

        if (!inviteGoogleUrl) {
          Swal.fire({
            text: "Invite signup could not be started. Please refresh the page and try again.",
            icon: "error",
            buttonsStyling: false,
            confirmButtonText: "Ok, got it!",
            customClass: {
              confirmButton: "btn btn-primary",
            },
          });

          return;
        }

        window.location.href = inviteGoogleUrl;
        return;
      }

      var selectedRole = getSelectedRole();

      if (!selectedRole) {
        Swal.fire({
          text: "Please select an account type before continuing with Google.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        return;
      }

      window.location.href = "/auth/google?intent=signup&role=" + encodeURIComponent(selectedRole);
    });
  }

  function initializePasswordMeter() {
    var passwordMeterElement = form.querySelector('[data-kt-password-meter="true"]');

    if (!passwordMeterElement || typeof KTPasswordMeter === "undefined") {
      passwordMeter = null;
      return;
    }

    passwordMeter = KTPasswordMeter.getInstance(passwordMeterElement);

    if (!passwordMeter && typeof KTPasswordMeter.createInstances === "function") {
      KTPasswordMeter.createInstances();
      passwordMeter = KTPasswordMeter.getInstance(passwordMeterElement);
    }
  }

  function getValidationFields() {
    var fields = {
      firstName: {
        validators: {
          notEmpty: {
            message: "First Name is required.",
          },
        },
      },

      lastName: {
        validators: {
          notEmpty: {
            message: "Last Name is required.",
          },
        },
      },

      email: {
        validators: {
          notEmpty: {
            message: "Email is required.",
          },
          regexp: {
            regexp: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            message: "Please enter a valid email address.",
          },
        },
      },

      password: {
        validators: {
          notEmpty: {
            message: "Password is required.",
          },
          callback: {
            message: "Please enter a valid password.",
            callback: function (input) {
              var value = String(input.value || "");

              if (!value) {
                return false;
              }

              if (passwordMeter && typeof passwordMeter.getScore === "function") {
                return passwordMeter.getScore() > 50;
              }

              return value.length >= 8;
            },
          },
        },
      },

      confirmPassword: {
        validators: {
          notEmpty: {
            message: "Please confirm your password.",
          },
          identical: {
            compare: function () {
              var passwordInput = form.querySelector('[name="password"]');

              return passwordInput ? passwordInput.value : "";
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
    };

    if (!isInviteSignup()) {
      fields.role = {
        validators: {
          notEmpty: {
            message: "Please select a role.",
          },
        },
      };
    }

    return fields;
  }

  function initializeValidation() {
    if (!form || !submitButton || typeof FormValidation === "undefined") return;

    validator = FormValidation.formValidation(form, {
      fields: getValidationFields(),

      plugins: {
        excluded: new FormValidation.plugins.Excluded({
          excluded: function (field, element) {
            return element.closest(".d-none") !== null || element.disabled;
          },
        }),

        trigger: new FormValidation.plugins.Trigger({
          event: {
            password: false,
          },
        }),

        bootstrap: new FormValidation.plugins.Bootstrap5({
          rowSelector: ".fv-row",
          eleInvalidClass: "",
          eleValidClass: "",
        }),
      },
    });
  }

  function setSubmitLoading(isLoading) {
    if (!submitButton) return;

    if (isLoading) {
      submitButton.setAttribute("data-kt-indicator", "on");
      submitButton.disabled = true;
      return;
    }

    submitButton.removeAttribute("data-kt-indicator");
    submitButton.disabled = false;
  }

  function submitForm() {
    setSubmitLoading(true);

    var data = Object.fromEntries(new FormData(form));

    axios
      .post(form.action, data)
      .then(function (response) {
        setSubmitLoading(false);

        Swal.fire({
          text: response.data.message || "Account created successfully.",
          icon: "success",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        }).then(function () {
          window.location.href = response.data.redirectUrl || "/login";
        });
      })
      .catch(function (error) {
        setSubmitLoading(false);

        Swal.fire({
          text: error.response?.data?.message || "An error occurred. Please try again.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });
      });
  }

  function handleSignupSubmission() {
    if (!form || !submitButton) return;

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      if (submitButton.disabled) return;

      if (!validator) {
        submitForm();
        return;
      }

      validator.revalidateField("password");

      validator.validate().then(function (status) {
        if (status === "Valid") {
          submitForm();
          return;
        }

        Swal.fire({
          text: "Please make sure all required fields are correctly filled out.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });
      });
    });
  }

  function handlePasswordInput() {
    if (!form || !validator) return;

    var passwordInput = form.querySelector('input[name="password"]');

    if (!passwordInput) return;

    passwordInput.addEventListener("input", function () {
      if (this.value.length > 0) {
        validator.updateFieldStatus("password", "NotValidated");
      }
    });
  }

  function handleRoleChangeValidation() {
    if (!form || !validator || isInviteSignup()) return;

    form.querySelectorAll('[name="role"]').forEach(function (input) {
      input.addEventListener("change", function () {
        validator.revalidateField("role");
      });
    });
  }

  return {
    init: function () {
      form = document.querySelector("#kt_sign_up_form");
      submitButton = document.querySelector("#kt_sign_up_submit");
      googleSignupButton = document.querySelector("#googleSignupBtn");

      if (!form || !submitButton) return;

      initializePasswordMeter();
      initializeValidation();

      handleGoogleSignup();
      handleSignupSubmission();
      handlePasswordInput();
      handleRoleChangeValidation();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  SignUp.init();
});
