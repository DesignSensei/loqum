// public/js/onboarding/onboarding-employer.js

"use strict";

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
  var formValidationInProgress = false;
  var formSubmissionInProgress = false;
  var onboardingCommitted = false;
  var verifiedCAC = null;
  var cacEvidenceTimer = null;

  var supportedBusinessTypes = ["pharmacy", "clinic", "hospital", "laboratory"];

  function getSelectedBusinessType() {
    var selectedRadio = document.querySelector('input[name="type"]:checked');
    return selectedRadio ? selectedRadio.value : "";
  }

  function handleBusinessTypeSelection() {
    var radios = form ? form.querySelectorAll('input[name="type"]') : [];

    if (!radios.length) {
      return;
    }

    function updateSelectedCard() {
      radios.forEach(function (radio) {
        var card = radio.closest("label");

        if (card) {
          card.classList.toggle("active", radio.checked);
        }
      });
    }

    radios.forEach(function (radio) {
      radio.addEventListener("change", updateSelectedCard);
    });

    updateSelectedCard();
  }

  function hasValidSelectedAddress() {
    var address = form ? form.querySelector("#addressInput") : null;
    var placeId = form ? form.querySelector("#googlePlaceIdInput") : null;
    var latitudeInput = form ? form.querySelector("#latitudeInput") : null;
    var longitudeInput = form ? form.querySelector("#longitudeInput") : null;

    if (
      !address?.value.trim() ||
      !placeId?.value.trim() ||
      !latitudeInput?.value.trim() ||
      !longitudeInput?.value.trim()
    ) {
      return false;
    }

    var latitude = Number(latitudeInput.value);
    var longitude = Number(longitudeInput.value);

    return (
      Number.isFinite(latitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      Number.isFinite(longitude) &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  function normalizeCACNumber(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, "");
  }

  function isSupportedCACLookupNumber(value) {
    return /^(RC|BN)\d{4,10}$/.test(normalizeCACNumber(value));
  }

  function getCACInputSignature() {
    return cacInput ? normalizeCACNumber(cacInput.value) : "";
  }

  function formatCACRetryTime(timestamp) {
    var date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      return "";
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function clearCACResult() {
    if (!cacResult) {
      return;
    }

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
    if (!cacResult || !cacMessage) {
      return;
    }

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

    cacMessage.textContent = String(message).slice(0, 1000);

    if (registeredName && cacRegisteredName && cacNameRow) {
      cacRegisteredName.textContent = String(registeredName).slice(0, 150);
      cacNameRow.classList.remove("d-none");
    }

    if (additionalNote && cacAdditionalNote) {
      cacAdditionalNote.textContent = String(additionalNote).slice(0, 700);
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

    if (result.status === "matched" && result.verified === true && result.stagingOnly === false) {
      return "success";
    }

    if (result.status === "not_found") {
      return "danger";
    }

    return "warning";
  }

  function getCACAdditionalNote(result) {
    if (!result) {
      return "";
    }

    if (result.stagingOnly === true) {
      return (
        "This is a sandbox result. Production CAC verification is required " +
        "before completing employer onboarding."
      );
    }

    if (result.status === "matched" && result.verified === true) {
      return (
        "CAC registration confirmed. Your main branch will be created " +
        "during setup. Applicable facility permits must be uploaded " +
        "and approved for each branch before shifts or permanent Jobs " +
        "can be published."
      );
    }

    if (result.status === "needs_review") {
      return (
        "The CAC registration requires additional review. " +
        "Successful production CAC verification is required " +
        "before completing normal employer onboarding."
      );
    }

    if (result.status === "not_found") {
      return (
        "Check the registration number and correct it if necessary. " +
        "A successful production CAC lookup is required to continue."
      );
    }

    if (result.status === "failed") {
      return (
        "The verification outcome could not be confirmed safely. " +
        "Do not repeatedly submit requests. Contact Loqum Support."
      );
    }

    return "";
  }

  function hasVerifiedCAC() {
    if (!verifiedCAC || !cacInput) {
      return false;
    }

    if (verifiedCAC.registrationNumber !== getCACInputSignature()) {
      return false;
    }

    return (
      Number.isFinite(verifiedCAC.expiresAt) &&
      verifiedCAC.expiresAt > Date.now() &&
      typeof verifiedCAC.registeredBusinessName === "string" &&
      verifiedCAC.registeredBusinessName.length > 0
    );
  }

  function clearCACEvidenceTimer() {
    if (cacEvidenceTimer !== null) {
      window.clearTimeout(cacEvidenceTimer);
      cacEvidenceTimer = null;
    }
  }

  function clearVerifiedCAC() {
    clearCACEvidenceTimer();
    verifiedCAC = null;

    if (businessNameInput) {
      businessNameInput.value = "";
    }

    if (validator) {
      validator.updateFieldStatus("businessName", "NotValidated");
    }

    updateCACControls();
  }

  function scheduleCACEvidenceExpiry() {
    clearCACEvidenceTimer();

    if (!verifiedCAC) {
      return;
    }

    var remaining = verifiedCAC.expiresAt - Date.now();

    if (remaining <= 0) {
      expireCACEvidence();
      return;
    }

    cacEvidenceTimer = window.setTimeout(
      function () {
        cacEvidenceTimer = null;
        expireCACEvidence();
      },
      Math.min(remaining, 2147483647)
    );
  }

  function expireCACEvidence() {
    if (!verifiedCAC) {
      return;
    }

    if (Date.now() < verifiedCAC.expiresAt) {
      scheduleCACEvidenceExpiry();
      return;
    }

    clearVerifiedCAC();

    showCACResult({
      type: "warning",
      message:
        "Your CAC verification evidence has expired. " +
        "Please verify the registration again before submitting your business profile.",
    });
  }

  function updateCACControls() {
    var busy =
      cacLookupInProgress ||
      formValidationInProgress ||
      formSubmissionInProgress ||
      onboardingCommitted;

    if (cacVerifyButton) {
      cacVerifyButton.disabled = busy;

      if (cacLookupInProgress) {
        cacVerifyButton.setAttribute("data-kt-indicator", "on");
      } else {
        cacVerifyButton.removeAttribute("data-kt-indicator");
      }
    }

    if (cacInput) {
      cacInput.readOnly = busy;
    }

    if (businessNameInput) {
      businessNameInput.readOnly = true;
    }

    if (submitButton) {
      submitButton.disabled = busy || !hasVerifiedCAC();
    }
  }

  function setCACLoading(loading) {
    cacLookupInProgress = loading;
    updateCACControls();
  }

  function handleCACRateLimit(error) {
    var response = error?.response;
    var data = response?.data;

    if (
      response?.status !== 429 ||
      data?.code !== "CAC_ONBOARDING_RATE_LIMITED" ||
      typeof data.nextEligibleAt !== "string" ||
      !["total", "distinct", "both"].includes(data.limitType)
    ) {
      return false;
    }

    var nextEligibleAt = Date.parse(data.nextEligibleAt);

    if (!Number.isFinite(nextEligibleAt) || nextEligibleAt <= Date.now()) {
      return false;
    }

    var retryTime = formatCACRetryTime(nextEligibleAt);
    var message;

    if (data.limitType === "total") {
      message =
        "You have used all 8 CAC lookup attempts allowed within a rolling 24-hour period. " +
        "Another paid lookup is unavailable until " +
        retryTime +
        ".";
    } else if (data.limitType === "distinct") {
      message =
        "You have checked 6 different CAC registration numbers within a rolling 24-hour period. " +
        "A seventh distinct number cannot be checked until " +
        retryTime +
        ".";
    } else {
      message =
        "Both CAC lookup limits have been reached for the submitted registration number. " +
        "That registration may become eligible on " +
        retryTime +
        ".";
    }

    var additionalNote =
      "An eligible cached result may still be reused. " +
      "A previously attempted registration may also be eligible " +
      "when total lookup allowance remains. " +
      "The server checks eligibility before any paid lookup.";

    showCACResult({
      type: "warning",
      message: message,
      additionalNote: additionalNote,
    });

    return true;
  }

  function handleCACVerification() {
    if (!form || !businessNameInput || !cacInput || !cacVerifyButton || !cacResult || !cacMessage) {
      return;
    }

    businessNameInput.value = "";
    businessNameInput.placeholder = "Filled automatically after CAC verification";
    businessNameInput.readOnly = true;

    updateCACControls();

    function handleRegistrationChange() {
      var currentRegistration = getCACInputSignature();

      if (verifiedCAC && verifiedCAC.registrationNumber !== currentRegistration) {
        clearVerifiedCAC();
      }

      clearCACResult();
      updateCACControls();
    }

    cacInput.addEventListener("input", handleRegistrationChange);
    cacInput.addEventListener("change", handleRegistrationChange);

    cacVerifyButton.addEventListener("click", async function (event) {
      event.preventDefault();

      if (
        cacLookupInProgress ||
        formValidationInProgress ||
        formSubmissionInProgress ||
        onboardingCommitted
      ) {
        return;
      }

      var registrationNumber = getCACInputSignature();

      if (!registrationNumber) {
        showCACResult({
          type: "danger",
          message: "Enter your CAC registration number.",
        });

        cacInput.focus();
        return;
      }

      if (!isSupportedCACLookupNumber(registrationNumber)) {
        showCACResult({
          type: "warning",
          message:
            "Automated CAC verification currently supports RC and BN numbers containing 4 to 10 digits.",
          additionalNote:
            "Other registration categories require a separate supported verification process. " +
            "Contact Loqum Support for assistance.",
        });

        cacInput.focus();
        return;
      }

      var csrfInput = form.querySelector('input[name="_csrf"]');
      var csrfToken = csrfInput ? csrfInput.value : "";

      if (!csrfToken) {
        showCACResult({
          type: "danger",
          message: "Your session could not be verified. Please refresh the page.",
        });
        return;
      }

      var configuredUrl = cacVerifyButton.getAttribute("data-verify-url");

      if (!configuredUrl) {
        showCACResult({
          type: "danger",
          message: "CAC verification is not configured on this form.",
        });
        return;
      }

      var verifyUrl;

      try {
        var url = new URL(configuredUrl, window.location.href);

        if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) {
          throw new Error("Invalid verification endpoint.");
        }

        verifyUrl = url.href;
      } catch {
        showCACResult({
          type: "danger",
          message: "CAC verification endpoint is invalid.",
        });
        return;
      }

      clearVerifiedCAC();

      var requestSignature = registrationNumber;

      clearCACResult();
      setCACLoading(true);

      try {
        var response = await axios.post(
          verifyUrl,
          {
            cacRegistrationNumber: registrationNumber,
            _csrf: csrfToken,
          },
          {
            headers: {
              "X-CSRF-Token": csrfToken,
            },
          }
        );

        if (requestSignature !== getCACInputSignature()) {
          showCACResult({
            type: "warning",
            message:
              "Your CAC registration number changed during verification. " +
              "The previous result cannot be used for this form.",
          });
          return;
        }

        if (!response.data || response.data.success !== true || !response.data.data) {
          throw new Error("Invalid CAC verification response.");
        }

        var result = response.data.data;

        var registeredName =
          typeof result.registeredBusinessName === "string"
            ? result.registeredBusinessName.trim()
            : "";

        var responseRegistration = normalizeCACNumber(result.registrationNumber);

        var expiresAt =
          typeof result.expiresAt === "string"
            ? Date.parse(result.expiresAt)
            : new Date(result.expiresAt).getTime();

        var matchedProduction =
          result.status === "matched" &&
          result.matched === true &&
          result.verified === true &&
          result.stagingOnly === false &&
          responseRegistration === registrationNumber &&
          registeredName.length > 0 &&
          registeredName.length <= 150 &&
          !/[\u0000-\u001F\u007F]/.test(registeredName) &&
          Number.isFinite(expiresAt) &&
          expiresAt > Date.now();

        if (matchedProduction) {
          cacInput.value = registrationNumber;

          verifiedCAC = {
            registrationNumber: registrationNumber,
            registeredBusinessName: registeredName,
            expiresAt: expiresAt,
          };

          businessNameInput.value = registeredName;

          if (validator) {
            validator.updateFieldStatus("businessName", "NotValidated");
          }

          scheduleCACEvidenceExpiry();
        }

        showCACResult({
          type: getCACResultType(result),
          message: result.message || "CAC lookup completed.",
          registeredName: matchedProduction ? registeredName : "",
          additionalNote: getCACAdditionalNote(result),
        });

        if (result.status === "matched" && result.verified === true && !matchedProduction) {
          showCACResult({
            type: "warning",
            message:
              "The CAC result could not be matched safely to the submitted registration. " +
              "Please contact Loqum Support.",
          });
        }
      } catch (error) {
        if (!handleCACRateLimit(error)) {
          var statusCode = error?.response?.status;
          var errorCode = error?.response?.data?.code || "";

          var message =
            error?.response?.data?.message ||
            error?.message ||
            "Unable to verify CAC at the moment.";

          if (
            errorCode === "CAC_PROVIDER_UNSUPPORTED_REGISTRATION_TYPE" ||
            errorCode === "CAC_UNSUPPORTED_REGISTRATION_FORMAT" ||
            errorCode === "CAC_ONBOARDING_INVALID_REGISTRATION_NUMBER"
          ) {
            showCACResult({
              type: "warning",
              message: message,
              additionalNote:
                "This registration cannot be verified through the current automated flow. " +
                "Contact Loqum Support for assistance.",
            });
          } else if (
            errorCode === "CAC_ONBOARDING_OUTCOME_UNCERTAIN" ||
            errorCode === "CAC_ONBOARDING_ALREADY_PROCESSING"
          ) {
            showCACResult({
              type: "warning",
              message: message,
              additionalNote:
                "Do not start another paid lookup while the previous provider outcome " +
                "is unresolved. Contact Loqum Support if the problem persists.",
            });
          } else if (statusCode === 429) {
            showCACResult({
              type: "warning",
              message: message,
              additionalNote: "CAC lookup limits protect against repeated provider charges.",
            });
          } else if (statusCode === 409 || statusCode === 503) {
            showCACResult({
              type: "warning",
              message: message,
              additionalNote:
                "A successful production CAC lookup is required before " +
                "normal employer onboarding can be completed.",
            });
          } else {
            showCACResult({
              type: "danger",
              message: message,
            });
          }
        }
      } finally {
        setCACLoading(false);
      }
    });

    window.addEventListener("focus", function () {
      if (verifiedCAC && !hasVerifiedCAC()) {
        expireCACEvidence();
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && verifiedCAC && !hasVerifiedCAC()) {
        expireCACEvidence();
      }
    });
  }

  function showFormAlert(message, type) {
    return Swal.fire({
      text: message,
      icon: type,
      buttonsStyling: false,
      confirmButtonText: "Ok, got it!",
      customClass: {
        confirmButton: "btn btn-primary",
      },
    });
  }

  function handleFormSubmission() {
    if (!form || !submitButton) {
      return;
    }

    validator = FormValidation.formValidation(form, {
      fields: {
        type: {
          validators: {
            notEmpty: {
              message: "Select a business type.",
            },
          },
        },

        businessName: {
          validators: {
            notEmpty: {
              message: "A verified CAC registered business name is required.",
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
              regexp: /^(RC|BN)[\s-]*\d{4,10}$/i,
              message: "Enter a valid RC or BN number, e.g. RC1234567 or BN1234567.",
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

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      if (
        cacLookupInProgress ||
        formValidationInProgress ||
        formSubmissionInProgress ||
        onboardingCommitted
      ) {
        return;
      }

      if (!supportedBusinessTypes.includes(getSelectedBusinessType())) {
        await showFormAlert("Select a valid business type.", "error");
        return;
      }

      if (!hasVerifiedCAC()) {
        if (verifiedCAC && verifiedCAC.expiresAt <= Date.now()) {
          expireCACEvidence();
        } else {
          showCACResult({
            type: "warning",
            message:
              "Verify your CAC registration and obtain a confirmed production " +
              "registered business name before submitting your profile.",
          });
        }

        if (cacInput) {
          cacInput.focus();
        }

        return;
      }

      formValidationInProgress = true;
      updateCACControls();

      var status;

      try {
        status = await validator.validate();
      } catch {
        await showFormAlert("Unable to validate your business profile. Please try again.", "error");
        return;
      } finally {
        formValidationInProgress = false;
        updateCACControls();
      }

      if (status !== "Valid") {
        return;
      }

      if (!hasValidSelectedAddress()) {
        await showFormAlert(
          "Select your main branch address from the Google address suggestions.",
          "error"
        );

        form.querySelector("#addressInput")?.focus();
        return;
      }

      if (!hasVerifiedCAC()) {
        showCACResult({
          type: "warning",
          message:
            "CAC verification has expired or the registration number has changed. " +
            "Please verify again.",
        });
        return;
      }

      formSubmissionInProgress = true;
      updateCACControls();

      submitButton.setAttribute("data-kt-indicator", "on");

      try {
        var formData = new FormData(form);
        var data = Object.fromEntries(formData);

        data.cacRegistrationNumber = verifiedCAC.registrationNumber;
        data.businessName = verifiedCAC.registeredBusinessName;

        delete data.regulatoryBody;
        delete data.regulatoryRegistrationNumber;
        delete data.cacVerified;
        delete data.cacVerificationStatus;
        delete data.employerApprovalStatus;
        delete data.registeredBusinessName;
        delete data.providerReference;
        delete data.processingClaimId;

        var response = await axios.post(form.action, data);

        if (!response.data || response.data.success !== true) {
          throw new Error("Unable to complete business profile setup.");
        }

        onboardingCommitted = true;
        updateCACControls();

        await showFormAlert(response.data.message || "Business profile setup complete!", "success");

        var redirectUrl = response.data.redirectUrl;

        if (
          typeof redirectUrl !== "string" ||
          !redirectUrl.startsWith("/") ||
          redirectUrl.startsWith("//") ||
          redirectUrl.includes("\\") ||
          /[\u0000-\u001F\u007F]/.test(redirectUrl)
        ) {
          redirectUrl = "/employer/dashboard";
        }

        window.location.assign(redirectUrl);
      } catch (error) {
        if (error?.response?.data?.onboardingCompleted === true) {
          onboardingCommitted = true;

          await showFormAlert(
            error.response.data.message ||
              "Your business profile was saved, but your session could not be updated. Please sign in again.",
            "warning"
          );
        } else {
          await showFormAlert(
            error?.response?.data?.message || "An error occurred during business profile setup.",
            "error"
          );
        }
      } finally {
        formSubmissionInProgress = false;
        submitButton.removeAttribute("data-kt-indicator");
        updateCACControls();
      }
    });
  }

  return {
    init: function () {
      if (!form) {
        return;
      }

      LocationPicker.init("#stateSelect", "#lgaSelect");
      handleFormSubmission();
      handleBusinessTypeSelection();
      handleCACVerification();
      updateCACControls();
    },
  };
})();

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
  OnboardingEmployer.init();
});
