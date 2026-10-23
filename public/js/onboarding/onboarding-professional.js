// public/js/onboarding/onboarding-professional.js

var OnboardingProfessional = (function () {
  var form = document.querySelector("#kt_onboarding_professional_form");
  var submitButton = document.querySelector("#kt_onboarding_professional_submit");

  var ninInput = document.querySelector("#ninInput");
  var ninConsent = document.querySelector("#ninConsent");
  var ninVerifyButton = document.querySelector("#kt_onboarding_nin_verify");
  var ninResult = document.querySelector("#ninVerificationResult");
  var ninMessage = document.querySelector("#ninVerificationMessage");

  var validator = null;
  var ninLookupInProgress = false;
  var formSubmissionInProgress = false;

  // Type config — registration body per profession
  // When scaling: uncomment new types here and in the EJS
  var typeConfig = {
    pharmacist: {
      fieldId: "field-pharmacist",
      validatorMessage: "PCN licence number is required.",
    },
    // pharmacy_technician: {
    //   fieldId: "field-pharmacy_technician",
    //   validatorMessage: "PCN licence number is required.",
    // },
    // nurse: {
    //   fieldId: "field-nurse",
    //   validatorMessage: "NMCN licence number is required.",
    // },
    // doctor: {
    //   fieldId: "field-doctor",
    //   validatorMessage: "MDCN licence number is required.",
    // },
    // lab_scientist: {
    //   fieldId: "field-lab_scientist",
    //   validatorMessage: "MLSCN licence number is required.",
    // },
    // radiographer: {
    //   fieldId: "field-radiographer",
    //   validatorMessage: "RRBN licence number is required.",
    // },
    // physiotherapist: {
    //   fieldId: "field-physiotherapist",
    //   validatorMessage: "MRPN licence number is required.",
    // },
  };

  // ───────────────────── TYPE SWITCHING ─────────────────────

  function handleTypeSwitching() {
    var radios = document.querySelectorAll('input[name="type"]');
    if (!radios.length) return;

    function switchField(selectedType) {
      document.querySelectorAll(".licence-field").forEach(function (field) {
        field.style.display = "none";

        var input = field.querySelector("input");
        if (input) input.disabled = true;
      });

      var config = typeConfig[selectedType];
      if (!config) return;

      var activeField = document.getElementById(config.fieldId);

      if (activeField) {
        activeField.style.display = "block";

        var input = activeField.querySelector("input");
        if (input) input.disabled = false;
      }

      if (validator) {
        validator.updateFieldStatus("licenceNumber", "NotValidated");

        validator.updateValidatorOption(
          "licenceNumber",
          "notEmpty",
          "message",
          config.validatorMessage
        );
      }
    }

    var defaultRadio = document.querySelector('input[name="type"]:checked');

    if (defaultRadio) {
      switchField(defaultRadio.value);
    }

    radios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        switchField(this.value);
      });
    });
  }

  // ───────────────────── NIN RESULT DISPLAY ─────────────────────

  function clearNINResult() {
    if (!ninResult || !ninMessage) return;

    ninResult.classList.add("d-none");

    ninResult.classList.remove(
      "alert-success",
      "alert-warning",
      "alert-danger",
      "alert-info",
      "alert-light-success",
      "alert-light-warning",
      "alert-light-danger",
      "alert-light-info"
    );

    ninMessage.textContent = "";
  }

  function showNINResult(message, type) {
    if (!ninResult || !ninMessage) return;

    clearNINResult();

    var alertClass = "alert-info";

    if (type === "success") {
      alertClass = "alert-success";
    } else if (type === "warning") {
      alertClass = "alert-warning";
    } else if (type === "danger") {
      alertClass = "alert-danger";
    }

    ninResult.classList.add(alertClass);
    ninResult.classList.remove("d-none");

    // Never inject provider messages as HTML.
    ninMessage.textContent = String(message || "");
  }

  function getNINResultType(result) {
    if (!result || !result.status) {
      return "warning";
    }

    if (result.status === "matched") {
      return result.stagingOnly ? "warning" : "success";
    }

    if (result.status === "needs_review") {
      return "warning";
    }

    if (result.status === "not_found") {
      return "danger";
    }

    return "warning";
  }

  function setNINLoading(loading) {
    ninLookupInProgress = loading;

    if (ninVerifyButton) {
      ninVerifyButton.disabled = loading;

      if (loading) {
        ninVerifyButton.setAttribute("data-kt-indicator", "on");
      } else {
        ninVerifyButton.removeAttribute("data-kt-indicator");
      }
    }

    if (ninInput) {
      ninInput.readOnly = loading;
    }

    if (ninConsent) {
      ninConsent.disabled = loading;
    }

    // Do not complete onboarding while a lookup
    // is still being processed.
    if (submitButton && !formSubmissionInProgress) {
      submitButton.disabled = loading;
    }
  }

  // ───────────────────── NIN VERIFICATION ─────────────────────

  /*
   * NIN ONLY.
   *
   * The form does not offer BVN verification.
   *
   * A NIN lookup is initiated only when the
   * professional explicitly clicks Verify NIN.
   *
   * No lookup occurs while typing.
   *
   * The existing pre-onboarding service handles:
   *
   * - Account eligibility;
   * - Provider selection;
   * - NIN hashing;
   * - Name matching;
   * - Lookup cooldown;
   * - Concurrency protection;
   * - Temporary evidence persistence.
   *
   * A registry match is not identity-holder
   * authentication or professional approval.
   */

  function handleNINVerification() {
    if (!form || !ninInput || !ninConsent || !ninVerifyButton || !ninResult || !ninMessage) {
      return;
    }

    // Keep the input numeric.
    ninInput.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 11);

      // Previously displayed verification results
      // do not apply to a newly entered NIN.
      clearNINResult();
    });

    ninVerifyButton.addEventListener("click", async function (e) {
      e.preventDefault();

      if (ninLookupInProgress || formSubmissionInProgress) {
        return;
      }

      var nin = ninInput.value.trim();

      // ───────── NIN FORMAT ─────────

      if (!/^\d{11}$/.test(nin)) {
        showNINResult("Enter a valid 11-digit National Identification Number.", "danger");

        ninInput.focus();
        return;
      }

      // ───────── EXPLICIT CONSENT ─────────

      if (!ninConsent.checked) {
        showNINResult("Please consent to the NIN registry check before continuing.", "warning");

        ninConsent.focus();
        return;
      }

      // ───────── CSRF TOKEN ─────────

      var csrfInput = form.querySelector('input[name="_csrf"]');
      var csrfToken = csrfInput ? csrfInput.value : "";

      if (!csrfToken) {
        showNINResult("Your session could not be verified. Please refresh the page.", "danger");

        return;
      }

      // ───────── ENDPOINT ─────────

      var verifyUrl = ninVerifyButton.getAttribute("data-verify-url");

      if (!verifyUrl) {
        showNINResult("NIN verification is not configured on this form.", "danger");

        return;
      }

      clearNINResult();
      setNINLoading(true);

      try {
        /*
         * Send NIN only to the dedicated
         * verification endpoint.
         *
         * Do not send it to the regular
         * professional onboarding endpoint.
         *
         * Do not log the request payload.
         */

        var response = await axios.post(
          verifyUrl,
          {
            nin: nin,
            consentAccepted: true,
            _csrf: csrfToken,
          },
          {
            headers: {
              "X-CSRF-Token": csrfToken,
            },
          }
        );

        if (!response.data || response.data.success !== true || !response.data.data) {
          throw new Error("Invalid NIN verification response.");
        }

        var result = response.data.data;

        var message = result.message || "NIN verification request completed.";

        /*
         * Production registry matching is only
         * confirmation of matched details.
         *
         * It does not automatically verify the
         * identity holder or approve the user.
         */

        showNINResult(message, getNINResultType(result));

        /*
         * On successful registry matching, remove
         * the raw NIN from the visible input.
         *
         * The server has already persisted the
         * temporary verification evidence.
         *
         * Clearing the input programmatically does
         * not trigger the input event, so the result
         * message remains visible.
         */

        if (result.status === "matched") {
          ninInput.value = "";

          ninInput.placeholder = "NIN details checked successfully";
        }
      } catch (error) {
        var statusCode = error.response?.status;

        var message =
          error.response?.data?.message ||
          "Unable to verify NIN at the moment. Please try again later.";

        if (statusCode === 429) {
          showNINResult(
            message || "Please wait before requesting another NIN verification.",
            "warning"
          );
        } else if (statusCode === 409) {
          showNINResult(message, "warning");
        } else if (statusCode === 503) {
          showNINResult(message, "warning");
        } else {
          showNINResult(message, "danger");
        }

        /*
         * No automatic retries.
         *
         * A provider lookup may be chargeable even
         * if its response was interrupted.
         */
      } finally {
        setNINLoading(false);
      }
    });
  }

  // ───────────────────── FORM SUBMISSION ─────────────────────

  function handleFormSubmission() {
    if (!form || !submitButton) return;

    validator = FormValidation.formValidation(form, {
      fields: {
        licenceNumber: {
          validators: {
            notEmpty: {
              message: "Licence number is required.",
            },
            regexp: {
              regexp: /^[0-9]{6}$/,
              message: "Licence number must be exactly 6 digits.",
            },
          },
        },

        phone: {
          validators: {
            notEmpty: {
              message: "Phone number is required.",
            },
          },
        },

        specialty: {
          validators: {
            notEmpty: {
              message: "Please select your specialty.",
            },
          },
        },

        address: {
          validators: {
            notEmpty: {
              message: "Work/Base address is required.",
            },
          },
        },

        state: {
          validators: {
            notEmpty: {
              message: "Please select a state.",
            },
          },
        },

        lga: {
          validators: {
            notEmpty: {
              message: "Please select an LGA.",
            },
          },
        },
      },

      plugins: {
        trigger: new FormValidation.plugins.Trigger(),

        bootstrap: new FormValidation.plugins.Bootstrap5({
          rowSelector: ".fv-row, .col-md-6",
          eleInvalidClass: "",
          eleValidClass: "",
        }),
      },
    });

    /*
     * Handle the form submit event rather than only
     * the button click.
     *
     * This also prevents bypassing validation
     * by pressing Enter inside an input.
     */

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      if (formSubmissionInProgress) {
        return;
      }

      if (ninLookupInProgress) {
        showNINResult("Please wait for the NIN verification request to finish.", "warning");

        return;
      }

      // ───────── VALIDATE PROFILE ─────────

      var status;

      try {
        status = await validator.validate();
      } catch (error) {
        Swal.fire({
          text: "Unable to validate your profile. Please try again.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        return;
      }

      if (status !== "Valid") {
        return;
      }

      // ───────── GOOGLE PLACES VALIDATION ─────────

      var latitudeInput = document.querySelector("#latitudeInput");
      var longitudeInput = document.querySelector("#longitudeInput");
      var googlePlaceIdInput = document.querySelector("#googlePlaceIdInput");

      if (!latitudeInput?.value || !longitudeInput?.value || !googlePlaceIdInput?.value) {
        Swal.fire({
          text: "Please select a valid address from the suggestions.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        return;
      }

      // ───────── SUBMIT PROFESSIONAL PROFILE ─────────

      formSubmissionInProgress = true;

      submitButton.setAttribute("data-kt-indicator", "on");
      submitButton.disabled = true;

      if (ninVerifyButton) {
        ninVerifyButton.disabled = true;
      }

      /*
       * Only regular profile fields are submitted.
       *
       * The EJS NIN input deliberately has no
       * name attribute.
       *
       * These defensive deletions ensure the raw
       * NIN and consent are not included even if
       * their HTML attributes are later changed.
       */

      var formData = new FormData(form);
      var data = Object.fromEntries(formData);

      delete data.nin;
      delete data.consentAccepted;

      try {
        var response = await axios.post(form.action, data);

        if (!response.data || response.data.success !== true) {
          throw new Error("Unable to complete your profile.");
        }

        await Swal.fire({
          text: response.data.message || "Profile completed!",
          icon: "success",
          buttonsStyling: false,
          confirmButtonText: "Go to Dashboard",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });

        var redirectUrl = response.data.redirectUrl;

        if (
          typeof redirectUrl !== "string" ||
          !redirectUrl.startsWith("/") ||
          redirectUrl.startsWith("//")
        ) {
          redirectUrl = "/professional/dashboard";
        }

        window.location.href = redirectUrl;
      } catch (error) {
        Swal.fire({
          text: error.response?.data?.message || "An error occurred while completing your profile.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });
      } finally {
        formSubmissionInProgress = false;

        submitButton.removeAttribute("data-kt-indicator");
        submitButton.disabled = false;

        if (ninVerifyButton) {
          ninVerifyButton.disabled = false;
        }
      }
    });
  }

  // ───────────────────── INITIALIZATION ─────────────────────

  return {
    init: function () {
      if (!form) return;

      LocationPicker.init("#stateSelect", "#lgaSelect");

      SpecialtyPicker.init('input[name="type"]', "#specialtySelect");

      handleFormSubmission();
      handleTypeSwitching();
      handleNINVerification();
    },
  };
})();

// ───────────────────── GOOGLE PLACES ─────────────────────

window.initAddressAutocomplete = function () {
  var addressInput = document.querySelector("#addressInput");
  var latitudeInput = document.querySelector("#latitudeInput");
  var longitudeInput = document.querySelector("#longitudeInput");
  var googlePlaceIdInput = document.querySelector("#googlePlaceIdInput");

  if (
    !addressInput ||
    !latitudeInput ||
    !longitudeInput ||
    !googlePlaceIdInput ||
    !window.google ||
    !google.maps ||
    !google.maps.places
  ) {
    return;
  }

  var autocomplete = new google.maps.places.Autocomplete(addressInput, {
    componentRestrictions: {
      country: "ng",
    },
    fields: ["formatted_address", "geometry", "place_id"],
    types: ["geocode"],
  });

  // Clear old coordinates if the user manually edits
  // the address instead of selecting a suggestion.
  addressInput.addEventListener("input", function () {
    latitudeInput.value = "";
    longitudeInput.value = "";
    googlePlaceIdInput.value = "";
  });

  autocomplete.addListener("place_changed", function () {
    var place = autocomplete.getPlace();

    if (!place.geometry || !place.geometry.location) {
      latitudeInput.value = "";
      longitudeInput.value = "";
      googlePlaceIdInput.value = "";
      return;
    }

    addressInput.value = place.formatted_address || addressInput.value;

    latitudeInput.value = place.geometry.location.lat();

    longitudeInput.value = place.geometry.location.lng();

    googlePlaceIdInput.value = place.place_id || "";
  });
};

KTUtil.onDOMContentLoaded(function () {
  OnboardingProfessional.init();
});
