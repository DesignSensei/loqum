// public/js/onboarding/onboarding-employer.js

"use strict";

var OnboardingEmployer = (function () {
  var form = document.querySelector("#kt_onboarding_employer_form");
  var submitButton = document.querySelector("#kt_onboarding_submit");

  var validator = null;

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

  // Handle dynamic registration field switching
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

  // Handle form validation and submission
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
              regexp: /^(RC|BN|IT|LP|LLP)\s?\d{4,10}$/i,
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

    submitButton.addEventListener("click", function (e) {
      e.preventDefault();

      validator.validate().then(function (status) {
        if (status !== "Valid") return;

        submitButton.setAttribute("data-kt-indicator", "on");
        submitButton.disabled = true;

        var formData = new FormData(form);
        var data = Object.fromEntries(formData);

        axios
          .post(form.action, data)
          .then(function (response) {
            submitButton.removeAttribute("data-kt-indicator");

            Swal.fire({
              text: response.data.message || "Business profile setup complete!",
              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Go to Dashboard",
              customClass: {
                confirmButton: "btn btn-primary",
              },
            }).then(function () {
              window.location.href = response.data.redirectUrl;
            });
          })
          .catch(function (error) {
            submitButton.removeAttribute("data-kt-indicator");
            submitButton.disabled = false;

            Swal.fire({
              text: error.response?.data?.message || "An error occurred during setup.",
              icon: "error",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",
              customClass: {
                confirmButton: "btn btn-primary",
              },
            });
          });
      });
    });
  }

  return {
    init: function () {
      LocationPicker.init("#stateSelect", "#lgaSelect");

      handleFormSubmission();
      handleTypeSwitching();
      handleStateChangeForRegulatoryBody();
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

  // Clear old coordinates if the user manually edits the address
  addressInput.addEventListener("input", function () {
    latitudeInput.value = "";
    longitudeInput.value = "";
    googlePlaceIdInput.value = "";
  });

  // Fill coordinates when the user selects a Google suggestion
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
