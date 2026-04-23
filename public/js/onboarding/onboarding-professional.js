// public/js/onboarding-professional.js

"use strict";

var OnboardingProfessional = (function () {
  var form = document.querySelector("#kt_onboarding_professional_form");
  var submitButton = document.querySelector("#kt_onboarding_professional_submit");
  var validator = null;

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

  function handleTypeSwitching() {
    var radios = document.querySelectorAll('input[name="type"]');
    if (!radios.length) return;

    function switchField(selectedType) {
      // Hide all, disable all
      document.querySelectorAll(".licence-field").forEach(function (field) {
        field.style.display = "none";
        var input = field.querySelector("input");
        if (input) input.disabled = true;
      });

      // Show and enable active field
      var config = typeConfig[selectedType];
      if (!config) return;

      var activeField = document.getElementById(config.fieldId);
      if (activeField) {
        activeField.style.display = "block";
        var input = activeField.querySelector("input");
        if (input) input.disabled = false;
      }

      // Update validator message
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

    // Set initial state on load
    var defaultRadio = document.querySelector('input[name="type"]:checked');
    if (defaultRadio) switchField(defaultRadio.value);

    // Listen for changes
    radios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        switchField(this.value);
      });
    });
  }

  function handleFormSubmission() {
    if (!form || !submitButton) return;

    validator = FormValidation.formValidation(form, {
      fields: {
        licenceNumber: {
          validators: { notEmpty: { message: "Licence number is required." } },
        },
        phone: {
          validators: { notEmpty: { message: "Phone number is required." } },
        },
        specialty: {
          validators: { notEmpty: { message: "Please select your specialty." } },
        },
        address: {
          validators: { notEmpty: { message: "Work/Base address is required." } },
        },
        state: {
          validators: { notEmpty: { message: "Please select a state." } },
        },
        lga: {
          validators: { notEmpty: { message: "Please select an LGA." } },
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

    submitButton.addEventListener("click", function (e) {
      e.preventDefault();

      validator.validate().then(function (status) {
        if (status === "Valid") {
          submitButton.setAttribute("data-kt-indicator", "on");
          submitButton.disabled = true;

          const formData = new FormData(form);
          const data = Object.fromEntries(formData);

          axios
            .post(form.action, data)
            .then(function (response) {
              submitButton.removeAttribute("data-kt-indicator");

              Swal.fire({
                text: response.data.message || "Profile completed!",
                icon: "success",
                buttonsStyling: false,
                confirmButtonText: "Go to Dashboard",
                customClass: { confirmButton: "btn btn-primary" },
              }).then(function () {
                window.location.href = response.data.redirectUrl;
              });
            })
            .catch(function (error) {
              submitButton.removeAttribute("data-kt-indicator");
              submitButton.disabled = false;

              Swal.fire({
                text: error.response?.data?.message || "An error occurred.",
                icon: "error",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              });
            });
        }
      });
    });
  }

  return {
    init: function () {
      LocationPicker.init("#stateSelect", "#lgaSelect");
      SpecialtyPicker.init('input[name="type"]', "#specialtySelect");
      handleFormSubmission();
      handleTypeSwitching();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  OnboardingProfessional.init();
});
