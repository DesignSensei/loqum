// public/js/onboarding-employer.js

"use strict";

var OnboardingEmployer = (function () {
  // Elements
  var form = document.querySelector("#kt_onboarding_employer_form");
  var submitButton = document.querySelector("#kt_onboarding_submit");

  // Handle Form Validation and Submission
  function handleFormSubmission() {
    if (!form || !submitButton) return;

    const validator = FormValidation.formValidation(form, {
      fields: {
        pharmacyName: {
          validators: { notEmpty: { message: "Pharmacy name is required." } },
        },
        businessRegistrationNumber: {
          validators: {
            notEmpty: { message: "PCN Registration number is required." },
          },
        },
        address: {
          validators: {
            notEmpty: { message: "Business address is required." },
          },
        },
        state: {
          validators: { notEmpty: { message: "Please select a state." } },
        },
        lga: {
          validators: { notEmpty: { message: "Please select an LGA." } },
        },
        contactFirstName: {
          validators: {
            notEmpty: { message: "Contact person's first name is required." },
          },
        },
        contactLastName: {
          validators: {
            notEmpty: { message: "Contact person's last name is required." },
          },
        },
        businessPhone: {
          validators: {
            notEmpty: { message: "Contact phone number is required." },
          },
        },
      },
      plugins: {
        trigger: new FormValidation.plugins.Trigger(),
        bootstrap: new FormValidation.plugins.Bootstrap5({
          rowSelector: ".fv-row, .col-md-6", // Handling both full rows and split columns
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
                text:
                  response.data.message || "Pharmacy profile setup complete!",
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
                text:
                  error.response?.data?.message ||
                  "An error occurred during setup.",
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
      handleFormSubmission();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  OnboardingEmployer.init();
});
