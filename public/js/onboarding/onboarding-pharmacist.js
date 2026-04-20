// public/js/onboarding-pharmacist.js

"use strict";

var OnboardingPharmacist = (function () {
  // Elements
  var form = document.querySelector("#kt_onboarding_pharmacist_form");
  var submitButton = document.querySelector("#kt_onboarding_pharmacist_submit");

  // Handle Form Validation and Axios Submission
  function handleFormSubmission() {
    if (!form || !submitButton) return;

    // Initialize FormValidation
    const validator = FormValidation.formValidation(form, {
      fields: {
        licenceNumber: {
          validators: { notEmpty: { message: "Licence number is required." } },
        },
        phone: {
          validators: { notEmpty: { message: "Phone number is required." } },
        },
        specialty: {
          validators: {
            notEmpty: { message: "Please select your specialty." },
          },
        },
        address: {
          validators: {
            notEmpty: { message: "Work/Base address is required." },
          },
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
          // Show loading indication
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
      handleFormSubmission();
    },
  };
})();

// Initialize on DOM load
KTUtil.onDOMContentLoaded(function () {
  OnboardingPharmacist.init();
});
