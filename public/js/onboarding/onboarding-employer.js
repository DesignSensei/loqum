// public/js/onboarding/onboarding-employer.js

var OnboardingEmployer = (function () {
  var form = document.querySelector("#kt_onboarding_employer_form");
  var submitButton = document.querySelector("#kt_onboarding_submit");

  var businessNameInput = document.querySelector("#businessNameInput");
  var cacInput = document.querySelector("#cacRegistrationNumberInput");
  var cacVerifyButton = document.querySelector("#kt_onboarding_cac_verify");

  var cacResult = document.querySelector("#cacVerificationResult");
  var cacIcon = document.querySelector("#cacVerificationIcon");
  var cacMessage = document.querySelector("#cacVerificationMessage");

  var cacNameRow = document.querySelector("#cacRegisteredBusinessNameRow");
  var cacRegisteredName = document.querySelector("#cacRegisteredBusinessName");
  var cacAdditionalNote = document.querySelector("#cacVerificationAdditionalNote");

  var validator = null;

  var cacLookupInProgress = false;
  var formSubmissionInProgress = false;

  // ───────────────────── REGULATORY REGISTRATION ─────────────────────

  function getSelectedBusinessType() {
    var selectedRadio = document.querySelector('input[name="type"]:checked');

    return selectedRadio ? selectedRadio.value : "";
  }

  function getSelectedState() {
    var stateSelect = document.querySelector("#stateSelect");

    return stateSelect ? stateSelect.value : "";
  }

  function getRegulatoryBodyName(type, state) {
    var cleanType = String(type || "").trim();

    var cleanState = String(state || "")
      .trim()
      .toLowerCase();

    if (cleanType === "pharmacy") {
      return "Pharmacists Council of Nigeria";
    }

    if (cleanType === "laboratory") {
      return "Medical Laboratory Science Council of Nigeria";
    }

    if (cleanType === "clinic" || cleanType === "hospital") {
      return cleanState === "lagos"
        ? "Health Facilities Monitoring and Accreditation Agency"
        : "State Ministry of Health";
    }

    return "regulatory body";
  }

  function getRegulatoryRegistrationMessage(type, state) {
    return getRegulatoryBodyName(type, state) + " registration number is required.";
  }

  function updateRegulatoryRegistrationValidationMessage() {
    if (!validator) return;

    var type = getSelectedBusinessType();
    var state = getSelectedState();

    var message = getRegulatoryRegistrationMessage(type, state);

    validator.updateFieldStatus("regulatoryRegistrationNumber", "NotValidated");

    validator.updateValidatorOption("regulatoryRegistrationNumber", "notEmpty", "message", message);
  }

  // ───────────────────── TYPE SWITCHING ─────────────────────

  function handleTypeSwitching() {
    var radios = document.querySelectorAll('input[name="type"]');

    if (!radios.length) return;

    function switchField(selectedRadio) {
      var selectedFieldId = selectedRadio.dataset.registrationField;

      document.querySelectorAll(".registration-field").forEach(function (field) {
        var isActive = field.id === selectedFieldId;

        field.style.display = isActive ? "block" : "none";

        field.querySelectorAll("input, select, textarea").forEach(function (input) {
          input.disabled = !isActive;
        });
      });

      updateRegulatoryRegistrationValidationMessage();
    }

    var defaultRadio = document.querySelector('input[name="type"]:checked');

    if (defaultRadio) {
      switchField(defaultRadio);
    }

    radios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        switchField(this);
      });
    });
  }

  function handleStateChangeForRegulatoryBody() {
    var stateSelect = document.querySelector("#stateSelect");

    if (!stateSelect) return;

    stateSelect.addEventListener("change", function () {
      updateRegulatoryRegistrationValidationMessage();
    });

    if (typeof $ !== "undefined") {
      $("#stateSelect").on("change.select2", function () {
        updateRegulatoryRegistrationValidationMessage();
      });
    }
  }

  // ───────────────────── CAC INPUT HELPERS ─────────────────────

  function normalizeCACNumber(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");
  }

  function normalizeBusinessName(value) {
    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/[^A-Z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getCACInputSignature() {
    if (!businessNameInput || !cacInput) {
      return "";
    }

    return (
      normalizeBusinessName(businessNameInput.value) + "|" + normalizeCACNumber(cacInput.value)
    );
  }

  function isSupportedCACLookupNumber(value) {
    return /^(RC|BN)\d{4,10}$/.test(normalizeCACNumber(value));
  }

  // ───────────────────── CAC RESULT DISPLAY ─────────────────────

  function clearCACResult() {
    if (!cacResult) return;

    cacResult.classList.add("d-none");

    cacResult.classList.remove(
      "alert-success",
      "alert-warning",
      "alert-danger",
      "alert-info",
      "alert-light-success",
      "alert-light-warning",
      "alert-light-danger",
      "alert-light-info"
    );

    if (cacMessage) {
      cacMessage.textContent = "";
    }

    if (cacRegisteredName) {
      cacRegisteredName.textContent = "";
    }

    if (cacNameRow) {
      cacNameRow.classList.add("d-none");
    }

    if (cacAdditionalNote) {
      cacAdditionalNote.textContent = "";
      cacAdditionalNote.classList.add("d-none");
    }

    if (cacIcon) {
      cacIcon.className = "ki-outline ki-information-2 fs-3 me-3";
    }
  }

  function showCACResult(options) {
    if (!cacResult || !cacMessage) return;

    var result = options || {};

    var type = result.type || "info";
    var message = result.message || "";

    var registeredName = result.registeredName || "";
    var additionalNote = result.additionalNote || "";

    clearCACResult();

    var alertClass = "alert-info";

    if (type === "success") {
      alertClass = "alert-success";
    } else if (type === "warning") {
      alertClass = "alert-warning";
    } else if (type === "danger") {
      alertClass = "alert-danger";
    }

    cacResult.classList.add(alertClass);
    cacResult.classList.remove("d-none");

    /*
     * Never use innerHTML for text obtained
     * from the verification provider.
     */
    cacMessage.textContent = String(message).slice(0, 500);

    if (registeredName && cacRegisteredName && cacNameRow) {
      cacRegisteredName.textContent = String(registeredName).slice(0, 200);

      cacNameRow.classList.remove("d-none");
    }

    if (additionalNote && cacAdditionalNote) {
      cacAdditionalNote.textContent = String(additionalNote).slice(0, 500);

      cacAdditionalNote.classList.remove("d-none");
    }

    if (cacIcon && type === "success") {
      cacIcon.className = "ki-outline ki-check-circle fs-3 me-3";
    }
  }

  function getCACResultType(result) {
    if (!result || !result.status) {
      return "warning";
    }

    /*
     * Only a confirmed production result
     * may display the successful green state.
     *
     * A sandbox match is test evidence,
     * not production business verification.
     */
    if (result.status === "matched" && result.verified === true && result.stagingOnly !== true) {
      return "success";
    }

    if (result.status === "not_found") {
      return "danger";
    }

    if (
      result.status === "needs_review" ||
      result.status === "matched" ||
      result.status === "failed"
    ) {
      return "warning";
    }

    return "info";
  }

  function getCACAdditionalNote(result) {
    if (!result) return "";

    if (result.stagingOnly === true) {
      return "This is a sandbox lookup result. " + "Production verification is still required.";
    }

    if (result.status === "matched" && result.verified === true) {
      return (
        "CAC registration details are confirmed. " +
        "PCN premises verification and employer approval " +
        "are separate requirements."
      );
    }

    if (result.status === "needs_review") {
      return (
        "The registration details require further review. " +
        "You can still complete your business profile."
      );
    }

    if (result.status === "not_found") {
      return (
        "Check that the registration number was entered " +
        "correctly. Your business profile can still be submitted."
      );
    }

    if (result.status === "failed") {
      return (
        "The lookup could not be completed. " + "Avoid repeatedly submitting verification requests."
      );
    }

    return "";
  }

  // ───────────────────── CAC LOADING STATE ─────────────────────

  function setCACLoading(loading) {
    cacLookupInProgress = loading;

    if (cacVerifyButton) {
      cacVerifyButton.disabled = loading || formSubmissionInProgress;

      if (loading) {
        cacVerifyButton.setAttribute("data-kt-indicator", "on");
      } else {
        cacVerifyButton.removeAttribute("data-kt-indicator");
      }
    }

    /*
     * Lock identity fields during the provider call.
     * This keeps the visible inputs aligned with
     * the verification request being processed.
     */
    if (businessNameInput) {
      businessNameInput.readOnly = loading;
    }

    if (cacInput) {
      cacInput.readOnly = loading;
    }

    if (submitButton && !formSubmissionInProgress) {
      submitButton.disabled = loading;
    }
  }

  // ───────────────────── CAC VERIFICATION ─────────────────────

  /*
   * The employer must explicitly click Verify CAC.
   *
   * No paid lookup happens on input or change.
   *
   * The server:
   * - Authenticates the employer;
   * - Selects Ninja or Dojah;
   * - Validates the registration;
   * - Evaluates business-name matching;
   * - Enforces lookup cooldown;
   * - Protects against concurrent lookups;
   * - Stores temporary verification evidence.
   *
   * The browser displays the result only.
   *
   * Browser-submitted verification flags must
   * never be trusted as authoritative evidence.
   */

  function handleCACVerification() {
    if (!form || !businessNameInput || !cacInput || !cacVerifyButton || !cacResult || !cacMessage) {
      return;
    }

    /*
     * Previously displayed CAC results must not
     * remain visible after identity fields change.
     */

    businessNameInput.addEventListener("input", clearCACResult);
    businessNameInput.addEventListener("change", clearCACResult);

    cacInput.addEventListener("input", clearCACResult);
    cacInput.addEventListener("change", clearCACResult);

    cacVerifyButton.addEventListener("click", async function (e) {
      e.preventDefault();

      if (cacLookupInProgress || formSubmissionInProgress) {
        return;
      }

      var businessName = businessNameInput.value.trim();
      var registrationNumber = normalizeCACNumber(cacInput.value);

      // ───────── BUSINESS NAME ─────────

      if (!businessName || !normalizeBusinessName(businessName)) {
        showCACResult({
          type: "danger",
          message: "Enter your registered business name before verifying CAC.",
        });

        businessNameInput.focus();
        return;
      }

      // ───────── CAC NUMBER ─────────

      if (!registrationNumber) {
        showCACResult({
          type: "danger",
          message: "Enter your CAC registration number.",
        });

        cacInput.focus();
        return;
      }

      /*
       * The current CAC coordinator supports
       * RC and BN registration formats.
       *
       * Actual provider capabilities may differ.
       *
       * For example, Ninja currently handles
       * RC lookups but does not support BN
       * through our configured adapter.
       *
       * Other CAC registration categories
       * remain eligible for separate review.
       */
      if (!isSupportedCACLookupNumber(registrationNumber)) {
        showCACResult({
          type: "warning",
          message:
            "Instant CAC lookup supports RC and BN registration numbers with 4 to 10 digits.",
          additionalNote:
            "If your registration uses another category, you can still complete your business profile for review.",
        });

        return;
      }

      // ───────── CSRF ─────────

      var csrfInput = form.querySelector('input[name="_csrf"]');

      var csrfToken = csrfInput ? csrfInput.value : "";

      if (!csrfToken) {
        showCACResult({
          type: "danger",
          message: "Your session could not be verified. Please refresh the page.",
        });

        return;
      }

      // ───────── ENDPOINT ─────────

      var verifyUrl = cacVerifyButton.getAttribute("data-verify-url");

      if (!verifyUrl) {
        showCACResult({
          type: "danger",
          message: "CAC verification is not configured on this form.",
        });

        return;
      }

      /*
       * Snapshot the exact business identity being
       * checked so an obsolete provider result
       * cannot be displayed for changed inputs.
       */
      var requestSignature = getCACInputSignature();

      clearCACResult();
      setCACLoading(true);

      try {
        var response = await axios.post(
          verifyUrl,
          {
            businessName: businessName,
            cacRegistrationNumber: registrationNumber,
            _csrf: csrfToken,
          },
          {
            headers: {
              "X-CSRF-Token": csrfToken,
            },
          }
        );

        /*
         * A result is valid only for the business
         * name and CAC number originally submitted.
         */
        if (requestSignature !== getCACInputSignature()) {
          showCACResult({
            type: "warning",
            message:
              "Your business details changed during verification. The previous result no longer applies.",
          });

          return;
        }

        if (!response.data || response.data.success !== true || !response.data.data) {
          throw new Error("Invalid CAC verification response.");
        }

        var result = response.data.data;

        var message = result.message || "CAC lookup completed.";

        var registeredName =
          typeof result.registeredBusinessName === "string"
            ? result.registeredBusinessName.trim()
            : "";

        showCACResult({
          type: getCACResultType(result),
          message: message,
          registeredName: registeredName,
          additionalNote: getCACAdditionalNote(result),
        });

        /*
         * Do not mark the employer as approved.
         *
         * CAC registry verification does not
         * verify the pharmacy's PCN premises
         * registration or administrative approval.
         */
      } catch (error) {
        var statusCode = error.response?.status;

        var errorCode = error.response?.data?.code || "";

        var message =
          error.response?.data?.message ||
          "Unable to verify CAC at the moment. Please try again later.";

        /*
         * A registration type may be supported
         * by Loqum's input rules but not by
         * the currently configured provider.
         */
        if (
          errorCode === "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE" ||
          errorCode === "CAC_UNSUPPORTED_REGISTRATION_FORMAT"
        ) {
          showCACResult({
            type: "warning",
            message: message,
            additionalNote:
              "You can continue onboarding. This registration will require separate review.",
          });

          return;
        }

        if (statusCode === 429) {
          showCACResult({
            type: "warning",
            message: message,
            additionalNote: "Verification requests are limited to avoid repeated provider charges.",
          });

          return;
        }

        if (statusCode === 409 || statusCode === 503) {
          showCACResult({
            type: "warning",
            message: message,
            additionalNote: "Your business profile can still be submitted.",
          });

          return;
        }

        showCACResult({
          type: "danger",
          message: message,
        });

        /*
         * Never automatically retry the lookup.
         *
         * A failed HTTP response does not prove
         * that the provider did not charge for
         * the original verification request.
         */
      } finally {
        setCACLoading(false);
      }
    });
  }

  // ───────────────────── FORM SUBMISSION ─────────────────────

  function handleFormSubmission() {
    if (!form || !submitButton) return;

    validator = FormValidation.formValidation(form, {
      fields: {
        businessName: {
          validators: {
            notEmpty: {
              message: "Business name is required.",
            },
          },
        },

        businessEmail: {
          validators: {
            notEmpty: {
              message: "Business email is required.",
            },
            emailAddress: {
              message: "Enter a valid business email address.",
            },
          },
        },

        cacRegistrationNumber: {
          validators: {
            notEmpty: {
              message: "CAC registration number is required.",
            },
            regexp: {
              /*
               * Preserve the registration categories
               * permitted by the existing form.
               *
               * Instant provider lookup is restricted
               * separately to RC/BN.
               */
              regexp: /^(RC|BN|IT|LP|LLP)[\s-]*\d{4,10}$/i,
              message: "Enter a valid CAC number, e.g. RC1234567 or BN1234567.",
            },
          },
        },

        regulatoryRegistrationNumber: {
          validators: {
            notEmpty: {
              message: "PCN premises registration number is required.",
            },
            regexp: {
              regexp: /^[A-Z0-9/\\\- ]{4,30}$/i,
              message: "Enter the PCN number exactly as shown on your premises certificate.",
            },
          },
        },

        address: {
          validators: {
            notEmpty: {
              message: "Business address is required.",
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

        businessPhone: {
          validators: {
            notEmpty: {
              message: "Business phone number is required.",
            },
          },
        },

        contactFirstName: {
          validators: {
            notEmpty: {
              message: "Contact person's first name is required.",
            },
          },
        },

        contactLastName: {
          validators: {
            notEmpty: {
              message: "Contact person's last name is required.",
            },
          },
        },

        contactRole: {
          validators: {
            notEmpty: {
              message: "Contact role is required.",
            },
          },
        },

        contactPhone: {
          validators: {
            notEmpty: {
              message: "Contact phone number is required.",
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
     * Handle the form submit event so that
     * pressing Enter follows the same validation
     * and submission flow as clicking the button.
     */

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      if (formSubmissionInProgress) {
        return;
      }

      if (cacLookupInProgress) {
        showCACResult({
          type: "warning",
          message: "Please wait for the CAC verification request to finish.",
        });

        return;
      }

      formSubmissionInProgress = true;
      submitButton.disabled = true;

      if (cacVerifyButton) {
        cacVerifyButton.disabled = true;
      }

      var loadingShown = false;

      try {
        // ───────── VALIDATION ─────────

        var status = await validator.validate();

        if (status !== "Valid") {
          return;
        }

        submitButton.setAttribute("data-kt-indicator", "on");

        loadingShown = true;

        // ───────── SUBMIT BUSINESS PROFILE ─────────

        var formData = new FormData(form);
        var data = Object.fromEntries(formData);

        /*
         * CAC verification results remain
         * server-side.
         *
         * Never submit browser-generated
         * verified/approved flags.
         */
        delete data.cacVerified;
        delete data.cacVerificationStatus;
        delete data.employerApprovalStatus;

        var response = await axios.post(form.action, data);

        if (!response.data || response.data.success !== true) {
          throw new Error("Unable to complete business profile setup.");
        }

        await Swal.fire({
          text: response.data.message || "Business profile setup complete!",
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
          redirectUrl = "/employer/dashboard";
        }

        window.location.href = redirectUrl;
      } catch (error) {
        Swal.fire({
          text: error.response?.data?.message || "An error occurred during setup.",
          icon: "error",
          buttonsStyling: false,
          confirmButtonText: "Ok, got it!",
          customClass: {
            confirmButton: "btn btn-primary",
          },
        });
      } finally {
        formSubmissionInProgress = false;

        if (loadingShown) {
          submitButton.removeAttribute("data-kt-indicator");
        }

        submitButton.disabled = false;

        if (cacVerifyButton) {
          cacVerifyButton.disabled = false;
        }
      }
    });
  }

  // ───────────────────── INITIALIZATION ─────────────────────

  return {
    init: function () {
      if (!form) return;

      LocationPicker.init("#stateSelect", "#lgaSelect");

      handleFormSubmission();
      handleTypeSwitching();
      handleStateChangeForRegulatoryBody();
      handleCACVerification();
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

  // Clear coordinates when an address is edited manually.
  addressInput.addEventListener("input", function () {
    latitudeInput.value = "";
    longitudeInput.value = "";
    googlePlaceIdInput.value = "";
  });

  // Populate coordinates when a Google suggestion is selected.
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
  OnboardingEmployer.init();
});
