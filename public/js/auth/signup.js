// public/js/auth/signup.js

var SignUp = (function () {
  var form;
  var submitButton;
  var googleSignupButton;
  var passwordMeter;
  var validator;
  var isSubmitting = false;
  var initialized = false;

  /* ---------- Get invitation token ---------- */

  function getInviteToken() {
    var inviteTokenInput = form.querySelector('input[name="inviteToken"]');

    return inviteTokenInput ? String(inviteTokenInput.value || "").trim() : "";
  }

  /* ---------- Check invitation registration ---------- */

  function isInviteSignup() {
    return Boolean(getInviteToken());
  }

  /* ---------- Get selected account role ---------- */

  function getSelectedRole() {
    var selectedRoleInput = form.querySelector('input[name="role"]:checked');

    return selectedRoleInput ? selectedRoleInput.value : "";
  }

  /* ---------- Professional legal-name field policy ---------- */

  /*
   * Professional legal names must come from
   * structured NIN registry evidence during
   * the authenticated onboarding process.
   *
   * Ordinary professional registration collects
   * account credentials and the professional role.
   *
   * Employer registration still collects the
   * account holder's first and last names.
   *
   * Employer account-holder names are separate
   * from the CAC-registered legal business name.
   *
   * Invitation registration retains its existing
   * first-name and last-name requirements.
   *
   * These browser-side changes are for usability.
   *
   * AuthController, AuthService and User model
   * validation independently enforce the policy.
   */

  function syncRegistrationNameFields() {
    if (!form || isInviteSignup()) return;

    var shouldHideNames = getSelectedRole() !== "employer";

    ["firstName", "middleName", "lastName"].forEach(function (fieldName) {
      var field = form.querySelector('[name="' + fieldName + '"]');

      if (!field) return;

      var fieldContainer = field.closest(".fv-row");

      if (shouldHideNames) {
        field.value = "";

        if (!field.disabled) {
          field.disabled = true;
          field.dataset.professionalSignupDisabled = "true";
        }

        if (fieldContainer && !fieldContainer.classList.contains("d-none")) {
          fieldContainer.classList.add("d-none");
          fieldContainer.dataset.professionalSignupHidden = "true";
        }

        return;
      }

      /*
       * Restore the employer's name inputs
       * when the applicant selects Employer.
       *
       * Only undo changes introduced by
       * this professional-signup handler.
       *
       * Do not override a field or container
       * that was independently disabled or
       * hidden by the page template.
       */

      if (field.dataset.professionalSignupDisabled === "true") {
        field.disabled = false;
        delete field.dataset.professionalSignupDisabled;
      }

      if (fieldContainer && fieldContainer.dataset.professionalSignupHidden === "true") {
        fieldContainer.classList.remove("d-none");
        delete fieldContainer.dataset.professionalSignupHidden;
      }
    });

    /*
     * Reset name-field validation status
     * after switching account types.
     *
     * This prevents a previously invalid
     * employer name field from retaining
     * its error state when hidden for
     * professional registration.
     */

    if (validator) {
      ["firstName", "lastName"].forEach(function (fieldName) {
        if (typeof validator.updateFieldStatus === "function") {
          validator.updateFieldStatus(fieldName, "NotValidated");
        }
      });
    }
  }

  /* ---------- Remove professional legal names from submission ---------- */

  function buildSignupSubmissionData() {
    var formData = new FormData(form);

    /*
     * Invitation registration continues
     * submitting its existing name fields.
     *
     * Employer registration also retains
     * the account holder's legal-name fields.
     *
     * Professional registration must never
     * submit applicant-entered legal names.
     *
     * Explicitly remove them even if an older
     * signup template inadvertently contains
     * additional hidden name inputs.
     */

    if (!isInviteSignup() && getSelectedRole() === "professional") {
      formData.delete("firstName");
      formData.delete("middleName");
      formData.delete("lastName");
      formData.delete("displayName");

      formData.delete("legalNameSource");
      formData.delete("legalNameEvidence");
    }

    return Object.fromEntries(formData);
  }

  /* ---------- Handle Google signup ---------- */

  function handleGoogleSignup() {
    if (!form || !googleSignupButton) return;

    googleSignupButton.addEventListener("click", function (e) {
      e.preventDefault();
      if (isSubmitting) return;

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

        var safeGoogleUrl = getLocalRedirect(inviteGoogleUrl, null);
        if (!safeGoogleUrl) return;
        window.location.href = safeGoogleUrl;
        return;
      }

      var selectedRole = getSelectedRole();

      if (!["professional", "employer"].includes(selectedRole)) {
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

      /*
       * The selected role is passed to the
       * existing Google OAuth entry point.
       *
       * Do not pass manually entered legal names
       * through the OAuth redirect.
       *
       * The Google OAuth callback must separately
       * enforce the professional NIN-name policy.
       *
       * Google profile names must not become
       * authoritative professional legal names.
       */

      window.location.href = "/auth/google?intent=signup&role=" + encodeURIComponent(selectedRole);
    });
  }

  /* ---------- Initialise password meter ---------- */

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

  /* ---------- Get validation fields ---------- */

  function getValidationFields() {
    var fields = {
      /*
       * Name fields are required for employer
       * account registration and invitations.
       *
       * Professional name inputs are disabled
       * and hidden by syncRegistrationNameFields().
       *
       * The Excluded plugin below skips those
       * fields during professional registration.
       */

      firstName: {
        validators: {
          stringLength: { max: 100, message: "Name must be 100 characters or fewer." },
          notEmpty: {
            message: "First Name is required.",
          },
        },
      },

      lastName: {
        validators: {
          stringLength: { max: 100, message: "Name must be 100 characters or fewer." },
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

              if (value.length < 8) {
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

  /* ---------- Initialise validation ---------- */

  function initializeValidation() {
    if (!form || !submitButton || typeof FormValidation === "undefined") return;

    validator = FormValidation.formValidation(form, {
      fields: getValidationFields(),

      plugins: {
        /*
         * Professional legal-name fields are
         * deliberately hidden and disabled.
         *
         * They must not block signup validation.
         *
         * Employer and invitation name fields
         * remain visible and required.
         */

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

  /* ---------- Validate fallback and redirect destinations ---------- */

  function getLocalRedirect(value, fallback) {
    if (typeof value !== "string" || value.charAt(0) !== "/" || value.slice(0, 2) === "//")
      return fallback;
    try {
      var target = new URL(value, window.location.origin);
      return target.origin === window.location.origin
        ? target.pathname + target.search + target.hash
        : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function validateWithoutPlugin() {
    // novalidate disables automatic browser checks, not checkValidity().
    if (!form.checkValidity()) return false;
    var data = buildSignupSubmissionData();
    if (typeof data.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim()))
      return false;
    if (
      typeof data.password !== "string" ||
      data.password.length < 8 ||
      data.password !== data.confirmPassword
    )
      return false;
    if (data.toc !== "1") return false;
    if (isInviteSignup() || getSelectedRole() === "employer") {
      return [data.firstName, data.lastName].every(function (name) {
        return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 100;
      });
    }
    return getSelectedRole() === "professional";
  }

  /* ---------- Handle submit loading ---------- */

  function setSubmitLoading(isLoading) {
    isSubmitting = isLoading;
    if (googleSignupButton) googleSignupButton.disabled = isLoading;
    if (!submitButton) return;
    if (isLoading) submitButton.setAttribute("data-kt-indicator", "on");
    else submitButton.removeAttribute("data-kt-indicator");
    submitButton.disabled = isLoading;
  }

  function showMessage(text, icon) {
    return Swal.fire({
      text: text,
      icon: icon,
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",
      customClass: { confirmButton: "btn btn-primary" },
    });
  }

  /* ---------- Submit signup form ---------- */

  async function submitForm(data) {
    try {
      var response = await axios.post(form.action, data);
      if (!response.data || response.data.success !== true) {
        throw { response: response };
      }
      await showMessage(response.data.message || "Account created successfully.", "success");
      // Keep submissions locked while the success message is open and while navigating.
      window.location.href = getLocalRedirect(response.data.redirectUrl, "/login");
    } catch (error) {
      var responseData = error.response && error.response.data;
      var recoveryUrl = responseData && getLocalRedirect(responseData.redirectUrl, null);
      var recoverOTP = recoveryUrl === "/two-factor" && [429, 503].includes(error.response.status);
      if (!recoverOTP) setSubmitLoading(false);
      await showMessage(
        (responseData && responseData.message) || "An error occurred. Please try again.",
        "error"
      );
      if (recoverOTP) window.location.href = recoveryUrl;
    }
  }

  /* ---------- Handle signup submission ---------- */

  function handleSignupSubmission() {
    if (!form || !submitButton) return;
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (isSubmitting || submitButton.disabled) return;
      syncRegistrationNameFields();
      if (!isInviteSignup() && !["professional", "employer"].includes(getSelectedRole())) {
        await showMessage("Please select an account type before continuing.", "error");
        return;
      }

      // Lock before asynchronous validation, not just before the network request.
      setSubmitLoading(true);
      try {
        var data = buildSignupSubmissionData();
        var snapshot = JSON.stringify(data);
        var valid;
        if (validator) {
          await validator.revalidateField("password");
          valid = (await validator.validate()) === "Valid";
        } else {
          valid = validateWithoutPlugin();
        }
        // The role or other inputs may have changed while validation was pending.
        if (JSON.stringify(buildSignupSubmissionData()) !== snapshot) {
          setSubmitLoading(false);
          await showMessage(
            "Your signup details changed. Please review them and submit again.",
            "error"
          );
          return;
        }
        if (!valid) {
          setSubmitLoading(false);
          await showMessage(
            "Please make sure all required fields are correctly filled out.",
            "error"
          );
          return;
        }
        await submitForm(data);
      } catch (_) {
        setSubmitLoading(false);
        await showMessage("Signup could not be completed. Please refresh and try again.", "error");
      }
    });
  }

  /* ---------- Handle password input ---------- */

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

  /* ---------- Handle role change validation ---------- */

  function handleRoleChangeValidation() {
    if (!form || isInviteSignup()) return;

    form.querySelectorAll('[name="role"]').forEach(function (input) {
      input.addEventListener("change", function () {
        /*
         * Employer:
         * Show and enable account-holder names.
         *
         * Professional:
         * Clear, hide and disable legal names.
         *
         * The trusted NIN onboarding flow
         * supplies professional legal names later.
         */

        syncRegistrationNameFields();

        if (validator) {
          validator.revalidateField("role");
        }
      });
    });
  }

  return {
    init: function () {
      form = document.querySelector("#kt_sign_up_form");
      submitButton = document.querySelector("#kt_sign_up_submit");
      googleSignupButton = document.querySelector("#googleSignupBtn");

      if (!form || !submitButton || initialized) return;
      initialized = true;

      /*
       * Configure the initially selected
       * account type before validation starts.
       *
       * Invitation signup is not changed.
       */

      syncRegistrationNameFields();

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
