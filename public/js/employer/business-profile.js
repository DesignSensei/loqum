// public/js/employer/business-profile.js

var EmployerBusinessProfile = (function () {
  var addBranchForm = null;
  var addBranchSubmitButton = null;
  var addBranchValidator = null;

  var editBranchForm = null;
  var editBranchSubmitButton = null;
  var editBranchValidator = null;

  var businessDetailsForm = null;
  var businessDetailsSubmitButton = null;
  var businessDetailsValidator = null;

  var addBranchSubmissionPending = false;
  var editBranchSubmissionPending = false;
  var editBranchOriginalLocation = null;
  var pendingBranchStatusChanges = Object.create(null);

  /*
   * ───────────────────── BUSINESS PROFILE FIELD POLICY ─────────────────────
   *
   * Registered legal identity is established through
   * the trusted CAC onboarding and verification workflow.
   *
   * Ordinary business profile editing must not permit
   * applicants to change the registered legal name,
   * CAC number or regulatory registration identity.
   *
   * These fields remain visible but read-only.
   *
   * Client-side restrictions improve the interface.
   * Server-side authorisation remains mandatory.
   */

  var protectedBusinessDetailsFields = [
    "type",
    "businessName",
    "cacRegistrationNumber",
    "regulatoryBody",
    "regulatoryRegistrationNumber",
  ];

  var editableBusinessDetailsFields = [
    "businessEmail",
    "businessPhoneCode",
    "businessPhone",
    "state",
    "lga",
    "address",
    "latitude",
    "longitude",
    "googlePlaceId",
    "contactFirstName",
    "contactLastName",
    "contactRole",
    "contactPhoneCode",
    "contactPhone",
  ];

  /* ---------- Get employer country code ---------- */

  function getEmployerCountryCode() {
    var countryCodeInput = document.querySelector("#businessProfileCountryCode");

    return String(countryCodeInput ? countryCodeInput.value : "ng")
      .trim()
      .toLowerCase();
  }

  /* ---------- Shared branch payload and location helpers ---------- */

  function hasValidAddressSelection(latitudeSelector, longitudeSelector, placeIdSelector) {
    var latitudeInput = document.querySelector(latitudeSelector);
    var longitudeInput = document.querySelector(longitudeSelector);
    var placeIdInput = document.querySelector(placeIdSelector);

    if (!latitudeInput || !longitudeInput || !placeIdInput) return false;

    var latitudeValue = String(latitudeInput.value || "").trim();
    var longitudeValue = String(longitudeInput.value || "").trim();
    var placeIdValue = String(placeIdInput.value || "").trim();

    if (!latitudeValue || !longitudeValue || !placeIdValue) return false;

    var latitude = Number(latitudeValue);
    var longitude = Number(longitudeValue);

    return (
      Number.isFinite(latitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      Number.isFinite(longitude) &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  function buildBranchSubmissionData(form) {
    var data = Object.fromEntries(new FormData(form));
    var contactPhone = String(data.contactPhone || "")
      .replace(/\s+/g, "")
      .trim();

    data.contactPhone = contactPhone;
    data.contactPhoneCode = contactPhone ? String(data.contactPhoneCode || "").trim() : "";

    if (form === editBranchForm && !data.branchId) {
      var branchIdInput = document.querySelector("#editBranchIdInput");
      data.branchId = normalizeLocationText(
        branchIdInput ? branchIdInput.value : editBranchOriginalLocation?.branchId
      );
    }

    // Do not strip _csrf or managerMemberId. The form owns those fields.
    return data;
  }

  function normalizeLocationText(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeLocationCoordinate(value) {
    var raw = normalizeLocationText(value);
    if (!raw) return null;

    var number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  function captureOriginalBranchLocation(button) {
    return {
      branchId: normalizeLocationText(button.getAttribute("data-branch-id")),
      address: normalizeLocationText(button.getAttribute("data-branch-address")),
      state: normalizeLocationText(button.getAttribute("data-branch-state")),
      lga: normalizeLocationText(button.getAttribute("data-branch-lga")),
      googlePlaceId: normalizeLocationText(button.getAttribute("data-branch-google-place-id")),
      latitude: normalizeLocationCoordinate(button.getAttribute("data-branch-latitude")),
      longitude: normalizeLocationCoordinate(button.getAttribute("data-branch-longitude")),
    };
  }

  function hasBranchPremisesChanged(formData) {
    if (!editBranchOriginalLocation) return true;
    if (normalizeLocationText(formData.branchId) !== editBranchOriginalLocation.branchId) {
      return true;
    }

    return (
      normalizeLocationText(formData.address) !== editBranchOriginalLocation.address ||
      normalizeLocationText(formData.state) !== editBranchOriginalLocation.state ||
      normalizeLocationText(formData.lga) !== editBranchOriginalLocation.lga ||
      normalizeLocationText(formData.googlePlaceId) !== editBranchOriginalLocation.googlePlaceId ||
      normalizeLocationCoordinate(formData.latitude) !== editBranchOriginalLocation.latitude ||
      normalizeLocationCoordinate(formData.longitude) !== editBranchOriginalLocation.longitude
    );
  }

  /* ---------- Initialise Select2 ---------- */

  function initSelect2() {
    if (typeof $ === "undefined") return;

    $('[data-control="select2"], [data-kt-select2="true"]').each(function () {
      var $select = $(this);

      if ($select.data("select2")) return;

      var dropdownParentSelector = $select.attr("data-dropdown-parent");
      var options = {};

      if (dropdownParentSelector && $(dropdownParentSelector).length) {
        options.dropdownParent = $(dropdownParentSelector);
      }

      $select.select2(options);
    });
  }

  /* ---------- Set Select2 or normal select value ---------- */

  function setSelectValue(selector, value) {
    var select = document.querySelector(selector);

    if (!select) return;

    if (typeof $ !== "undefined" && $(select).data("select2")) {
      $(select)
        .val(value || "")
        .trigger("change");

      return;
    }

    select.value = value || "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ---------- Initialise state and LGA pickers ---------- */

  function initLocationPicker() {
    if (typeof LocationPicker === "undefined") return;

    LocationPicker.init("#addBranchStateSelect", "#addBranchLgaSelect");
    LocationPicker.init("#editBranchStateSelect", "#editBranchLgaSelect");
    LocationPicker.init("#businessDetailsStateSelect", "#businessDetailsLgaSelect");

    setTimeout(function () {
      var currentStateInput = document.querySelector("#businessDetailsCurrentState");
      var currentLgaInput = document.querySelector("#businessDetailsCurrentLga");

      if (!currentStateInput || !currentLgaInput) return;

      setSelectValue("#businessDetailsStateSelect", currentStateInput.value);

      setTimeout(function () {
        setSelectValue("#businessDetailsLgaSelect", currentLgaInput.value);
      }, 150);
    }, 150);
  }

  /* ---------- Form revalidation helpers ---------- */

  function revalidateField(fieldName) {
    if (!addBranchValidator) return;

    addBranchValidator.revalidateField(fieldName);
  }

  function revalidateEditField(fieldName) {
    if (!editBranchValidator) return;

    editBranchValidator.revalidateField(fieldName);
  }

  function revalidateBusinessDetailsField(fieldName) {
    if (!businessDetailsValidator) return;

    businessDetailsValidator.revalidateField(fieldName);
  }

  /* ---------- Business-details initial select values ---------- */

  function setBusinessDetailsInitialSelectValues() {
    var currentTypeInput = document.querySelector("#businessDetailsCurrentType");
    var currentContactRoleInput = document.querySelector("#businessDetailsCurrentContactRole");

    if (currentTypeInput) {
      setSelectValue("#businessTypeSelect", currentTypeInput.value);
    }

    if (currentContactRoleInput) {
      setSelectValue("#contactRoleSelect", currentContactRoleInput.value);
    }

    updateBusinessDetailsRegulatoryBodyDisplay();
  }

  /* ---------- Keep regulatory-body display authoritative ---------- */

  function updateBusinessDetailsRegulatoryBodyDisplay() {
    var regulatoryBodyDisplay = document.querySelector("#businessDetailsRegulatoryBodyDisplay");

    if (!regulatoryBodyDisplay) return;

    /*
     * The regulatory body stored on EmployerProfile
     * is the authoritative value for this employer.
     *
     * Do not recalculate and replace that value
     * merely because an applicant changes the
     * state selection in the browser.
     *
     * A location change that affects the applicable
     * regulator requires a separate verification flow.
     *
     * The backend validates this independently.
     */

    if ("readOnly" in regulatoryBodyDisplay) {
      regulatoryBodyDisplay.readOnly = true;
    }

    regulatoryBodyDisplay.setAttribute("aria-readonly", "true");
  }

  /* ---------- Protect registered business identity fields ---------- */

  function protectBusinessDetailsIdentityFields() {
    if (!businessDetailsForm) return;

    protectedBusinessDetailsFields.forEach(function (fieldName) {
      var fields = businessDetailsForm.querySelectorAll('[name="' + fieldName + '"]');

      fields.forEach(function (field) {
        /*
         * Text fields remain visible but read-only.
         *
         * Select fields cannot be made read-only
         * through standard HTML, so disable them.
         *
         * Hidden protected fields are also disabled
         * because the update request does not need
         * to submit any registered identity values.
         */

        if (
          field.tagName === "SELECT" ||
          field.type === "hidden" ||
          field.type === "checkbox" ||
          field.type === "radio"
        ) {
          field.disabled = true;

          if (field.tagName === "SELECT" && typeof $ !== "undefined" && $(field).data("select2")) {
            $(field).prop("disabled", true);
          }

          return;
        }

        if ("readOnly" in field) {
          field.readOnly = true;
        }

        field.setAttribute("aria-readonly", "true");
      });
    });

    /*
     * Protect the existing known controls even
     * if the view gives them a different name
     * or omits the name attribute.
     *
     * The template must still render these
     * fields as informational, not editable.
     */

    var businessTypeSelect = document.querySelector("#businessTypeSelect");

    if (businessTypeSelect && businessDetailsForm.contains(businessTypeSelect)) {
      businessTypeSelect.disabled = true;

      if (typeof $ !== "undefined" && $(businessTypeSelect).data("select2")) {
        $(businessTypeSelect).prop("disabled", true);
      }
    }

    updateBusinessDetailsRegulatoryBodyDisplay();
  }

  /* ---------- Build permitted business-details submission ---------- */

  function buildBusinessDetailsSubmissionData() {
    var formData = new FormData(businessDetailsForm);
    var data = {};

    /*
     * Submit only the fields allowed by
     * EmployerService.updateBusinessDetails().
     *
     * Do not use Object.fromEntries(formData)
     * for this form because it may include
     * protected legal identity or verification
     * fields rendered by an older template.
     *
     * Registered identity is retrieved from
     * the persisted profile by the backend.
     */

    editableBusinessDetailsFields.forEach(function (fieldName) {
      if (formData.has(fieldName)) {
        data[fieldName] = formData.get(fieldName);
      }
    });

    /*
     * Preserve the existing Express CSRF token
     * when the form includes it as a hidden field.
     *
     * Axios may also use the application's
     * configured CSRF header.
     */

    if (formData.has("_csrf")) {
      data._csrf = formData.get("_csrf");
    }

    return data;
  }

  /* ---------- Bind add-branch select validation ---------- */

  function bindSelectValidation() {
    var stateSelect = document.querySelector("#addBranchStateSelect");
    var lgaSelect = document.querySelector("#addBranchLgaSelect");

    if (stateSelect) {
      stateSelect.addEventListener("change", function () {
        revalidateField("state");
      });
    }

    if (lgaSelect) {
      lgaSelect.addEventListener("change", function () {
        revalidateField("lga");
      });
    }

    if (typeof $ !== "undefined") {
      $("#addBranchStateSelect").on("change.select2", function () {
        revalidateField("state");
      });

      $("#addBranchLgaSelect").on("change.select2", function () {
        revalidateField("lga");
      });
    }
  }

  /* ---------- Bind edit-branch select validation ---------- */

  function bindEditSelectValidation() {
    var stateSelect = document.querySelector("#editBranchStateSelect");
    var lgaSelect = document.querySelector("#editBranchLgaSelect");

    if (stateSelect) {
      stateSelect.addEventListener("change", function () {
        revalidateEditField("state");
      });
    }

    if (lgaSelect) {
      lgaSelect.addEventListener("change", function () {
        revalidateEditField("lga");
      });
    }

    if (typeof $ !== "undefined") {
      $("#editBranchStateSelect").on("change.select2", function () {
        revalidateEditField("state");
      });

      $("#editBranchLgaSelect").on("change.select2", function () {
        revalidateEditField("lga");
      });
    }
  }

  /* ---------- Bind business-details select validation ---------- */

  function bindBusinessDetailsSelectValidation() {
    var typeSelect = document.querySelector("#businessTypeSelect");
    var stateSelect = document.querySelector("#businessDetailsStateSelect");
    var lgaSelect = document.querySelector("#businessDetailsLgaSelect");
    var contactRoleSelect = document.querySelector("#contactRoleSelect");

    if (typeSelect) {
      typeSelect.addEventListener("change", function () {
        updateBusinessDetailsRegulatoryBodyDisplay();
      });
    }

    if (stateSelect) {
      stateSelect.addEventListener("change", function () {
        updateBusinessDetailsRegulatoryBodyDisplay();
        revalidateBusinessDetailsField("state");
      });
    }

    if (lgaSelect) {
      lgaSelect.addEventListener("change", function () {
        revalidateBusinessDetailsField("lga");
      });
    }

    if (contactRoleSelect) {
      contactRoleSelect.addEventListener("change", function () {
        revalidateBusinessDetailsField("contactRole");
      });
    }

    if (typeof $ !== "undefined") {
      $("#businessTypeSelect").on("change.select2", function () {
        updateBusinessDetailsRegulatoryBodyDisplay();
      });

      $("#businessDetailsStateSelect").on("change.select2", function () {
        updateBusinessDetailsRegulatoryBodyDisplay();
        revalidateBusinessDetailsField("state");
      });

      $("#businessDetailsLgaSelect").on("change.select2", function () {
        revalidateBusinessDetailsField("lga");
      });

      $("#contactRoleSelect").on("change.select2", function () {
        revalidateBusinessDetailsField("contactRole");
      });
    }
  }

  /* ---------- Add-branch Google address autocomplete ---------- */

  function initAddBranchAddressAutocomplete() {
    var addressInput = document.querySelector("#addBranchAddressInput");
    var latitudeInput = document.querySelector("#addBranchLatitudeInput");
    var longitudeInput = document.querySelector("#addBranchLongitudeInput");
    var googlePlaceIdInput = document.querySelector("#addBranchGooglePlaceIdInput");

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
        country: getEmployerCountryCode(),
      },

      fields: ["formatted_address", "geometry", "place_id"],

      types: ["geocode"],
    });

    addressInput.addEventListener("input", function () {
      latitudeInput.value = "";
      longitudeInput.value = "";
      googlePlaceIdInput.value = "";

      revalidateField("address");
    });

    autocomplete.addListener("place_changed", function () {
      var place = autocomplete.getPlace();

      if (!place.geometry || !place.geometry.location) {
        latitudeInput.value = "";
        longitudeInput.value = "";
        googlePlaceIdInput.value = "";

        revalidateField("address");

        return;
      }

      addressInput.value = place.formatted_address || addressInput.value;
      latitudeInput.value = place.geometry.location.lat();
      longitudeInput.value = place.geometry.location.lng();
      googlePlaceIdInput.value = place.place_id || "";

      revalidateField("address");
    });
  }

  /* ---------- Edit-branch Google address autocomplete ---------- */

  function initEditBranchAddressAutocomplete() {
    var addressInput = document.querySelector("#editBranchAddressInput");
    var latitudeInput = document.querySelector("#editBranchLatitudeInput");
    var longitudeInput = document.querySelector("#editBranchLongitudeInput");
    var googlePlaceIdInput = document.querySelector("#editBranchGooglePlaceIdInput");

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
        country: getEmployerCountryCode(),
      },

      fields: ["formatted_address", "geometry", "place_id"],

      types: ["geocode"],
    });

    addressInput.addEventListener("input", function () {
      latitudeInput.value = "";
      longitudeInput.value = "";
      googlePlaceIdInput.value = "";

      revalidateEditField("address");
    });

    autocomplete.addListener("place_changed", function () {
      var place = autocomplete.getPlace();

      if (!place.geometry || !place.geometry.location) {
        latitudeInput.value = "";
        longitudeInput.value = "";
        googlePlaceIdInput.value = "";

        revalidateEditField("address");

        return;
      }

      addressInput.value = place.formatted_address || addressInput.value;
      latitudeInput.value = place.geometry.location.lat();
      longitudeInput.value = place.geometry.location.lng();
      googlePlaceIdInput.value = place.place_id || "";

      revalidateEditField("address");
    });
  }

  /* ---------- Business-details Google address autocomplete ---------- */

  function initBusinessDetailsAddressAutocomplete() {
    var addressInput = document.querySelector("#businessDetailsAddressInput");
    var latitudeInput = document.querySelector("#businessDetailsLatitude");
    var longitudeInput = document.querySelector("#businessDetailsLongitude");
    var googlePlaceIdInput = document.querySelector("#businessDetailsGooglePlaceId");

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
        country: getEmployerCountryCode(),
      },

      fields: ["formatted_address", "geometry", "place_id"],

      types: ["geocode"],
    });

    addressInput.addEventListener("input", function () {
      latitudeInput.value = "";
      longitudeInput.value = "";
      googlePlaceIdInput.value = "";

      revalidateBusinessDetailsField("address");
    });

    autocomplete.addListener("place_changed", function () {
      var place = autocomplete.getPlace();

      if (!place.geometry || !place.geometry.location) {
        latitudeInput.value = "";
        longitudeInput.value = "";
        googlePlaceIdInput.value = "";

        revalidateBusinessDetailsField("address");

        return;
      }

      addressInput.value = place.formatted_address || addressInput.value;
      latitudeInput.value = place.geometry.location.lat();
      longitudeInput.value = place.geometry.location.lng();
      googlePlaceIdInput.value = place.place_id || "";

      revalidateBusinessDetailsField("address");
    });
  }

  /* ---------- Add-branch validation ---------- */

  function handleAddBranchValidation() {
    addBranchForm = document.querySelector("#kt_add_branch_form");
    addBranchSubmitButton = document.querySelector("#kt_add_branch_submit");

    if (!addBranchForm || !addBranchSubmitButton) return;

    if (typeof FormValidation !== "undefined") {
      addBranchValidator = FormValidation.formValidation(addBranchForm, {
        fields: {
          name: {
            validators: {
              notEmpty: {
                message: "Branch name is required.",
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

          address: {
            validators: {
              notEmpty: {
                message: "Branch address is required.",
              },

              callback: {
                message: "Please select a valid address from the Google suggestions.",

                callback: function (input) {
                  var addressValue = String(input.value || "").trim();

                  if (!addressValue) return false;

                  return hasValidAddressSelection(
                    "#addBranchLatitudeInput",
                    "#addBranchLongitudeInput",
                    "#addBranchGooglePlaceIdInput"
                  );
                },
              },
            },
          },

          contactPhone: {
            validators: {
              callback: {
                message: "Enter a valid branch phone number.",

                callback: function (input) {
                  var value = String(input.value || "").trim();

                  if (!value) return true;

                  return /^[0-9]{7,15}$/.test(value.replace(/\s+/g, ""));
                },
              },
            },
          },
        },

        plugins: {
          trigger: new FormValidation.plugins.Trigger(),

          bootstrap: new FormValidation.plugins.Bootstrap5({
            rowSelector: ".fv-row",
            eleInvalidClass: "",
            eleValidClass: "",
          }),
        },
      });

      bindSelectValidation();
    }

    handleAddBranchSubmission();
  }

  /* ---------- Add-branch submission ---------- */

  function handleAddBranchSubmission() {
    if (!addBranchForm || !addBranchSubmitButton) return;

    addBranchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (addBranchSubmissionPending || addBranchSubmitButton.disabled) return;

      addBranchSubmissionPending = true;

      var submitForm = function () {
        addBranchSubmitButton.setAttribute("data-kt-indicator", "on");
        addBranchSubmitButton.disabled = true;

        var data = buildBranchSubmissionData(addBranchForm);

        axios
          .post(addBranchForm.action, data)
          .then(function (response) {
            addBranchSubmitButton.removeAttribute("data-kt-indicator");

            Swal.fire({
              text: response.data.message || "Branch added successfully.",
              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",

              customClass: {
                confirmButton: "btn btn-primary",
              },
            }).then(function () {
              window.location.href =
                response.data.redirectUrl || "/employer/business-profile?tab=branches";
            });
          })
          .catch(function (error) {
            addBranchSubmissionPending = false;
            addBranchSubmitButton.removeAttribute("data-kt-indicator");
            addBranchSubmitButton.disabled = false;

            Swal.fire({
              text: error.response?.data?.message || "Unable to add branch.",

              icon: "error",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",

              customClass: {
                confirmButton: "btn btn-primary",
              },
            });
          });
      };

      if (addBranchValidator) {
        addBranchValidator
          .validate()
          .then(function (status) {
            if (status !== "Valid") {
              addBranchSubmissionPending = false;
              return;
            }

            submitForm();
          })
          .catch(function () {
            addBranchSubmissionPending = false;
            Swal.fire({
              text: "Unable to validate branch details. Please try again.",
              icon: "error",
            });
          });

        return;
      }

      submitForm();
    });
  }

  /* ---------- Branch activation and deactivation ---------- */

  function handleBranchStatusActions() {
    document.addEventListener("click", function (event) {
      var actionLink = event.target.closest(".js-toggle-branch-status");
      if (!actionLink) return;

      event.preventDefault();

      var branchId = String(actionLink.getAttribute("data-branch-id") || "").trim();
      var action = String(actionLink.getAttribute("data-branch-action") || "").trim();

      if (pendingBranchStatusChanges[branchId]) return;
      if (actionLink.getAttribute("aria-disabled") === "true") return;

      if (!/^[a-f0-9]{24}$/i.test(branchId) || (action !== "activate" && action !== "deactivate")) {
        Swal.fire({
          text: "Unable to identify a valid branch status action.",
          icon: "error",
        });
        return;
      }

      // Branch management modals contain the server-issued CSRF token.
      // Do not submit a status mutation when a token is unavailable.
      var csrfInput = document.querySelector(
        '#kt_edit_branch_form input[name="_csrf"], #kt_add_branch_form input[name="_csrf"], input[name="_csrf"]'
      );
      var csrfToken = csrfInput ? String(csrfInput.value || "").trim() : "";

      if (!csrfToken) {
        Swal.fire({
          text: "Security token unavailable. Refresh the page and try again.",
          icon: "error",
        });
        return;
      }

      pendingBranchStatusChanges[branchId] = true;

      var activating = action === "activate";
      Swal.fire({
        title: activating ? "Reactivate this branch?" : "Deactivate this branch?",
        text: activating
          ? "Reactivation changes the branch's administrative status only. " +
            "It does not reinstate expired or deactivated facility permits " +
            "or bypass regulatory readiness requirements."
          : "Deactivation marks this branch administratively inactive. " +
            "It does not automatically cancel existing shift obligations.",
        icon: "warning",
        showCancelButton: true,
        buttonsStyling: false,
        confirmButtonText: activating ? "Yes, reactivate" : "Yes, deactivate",
        cancelButtonText: "Cancel",
        customClass: {
          confirmButton: activating ? "btn btn-primary" : "btn btn-danger",
          cancelButton: "btn btn-light",
        },
      })
        .then(function (result) {
          if (!result.isConfirmed) {
            delete pendingBranchStatusChanges[branchId];
            return;
          }

          actionLink.setAttribute("aria-disabled", "true");
          actionLink.classList.add("disabled");

          axios
            .post("/employer/branches/" + encodeURIComponent(branchId) + "/status", {
              action: action,
              _csrf: csrfToken,
            })
            .then(function (response) {
              if (!response.data || response.data.success !== true) {
                throw new Error(response.data?.message || "Unable to change branch status.");
              }

              Swal.fire({
                text: response.data.message || "Branch status updated successfully.",
                icon: "success",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              }).then(function () {
                window.location.href =
                  response.data.redirectUrl || "/employer/business-profile?tab=branches";
              });
            })
            .catch(function (error) {
              delete pendingBranchStatusChanges[branchId];
              actionLink.removeAttribute("aria-disabled");
              actionLink.classList.remove("disabled");

              Swal.fire({
                text:
                  error.response?.data?.message ||
                  error.message ||
                  "Unable to change branch status.",
                icon: "error",
                buttonsStyling: false,
                confirmButtonText: "Ok, got it!",
                customClass: { confirmButton: "btn btn-primary" },
              });
            });
        })
        .catch(function () {
          delete pendingBranchStatusChanges[branchId];
          actionLink.removeAttribute("aria-disabled");
          actionLink.classList.remove("disabled");
        });
    });
  }

  /* ---------- View-branch modal ---------- */

  function handleViewBranchModal() {
    var modalElement = document.querySelector("#viewBranchModal");

    if (!modalElement) return;

    modalElement.addEventListener("show.bs.modal", function (event) {
      var button = event.relatedTarget;

      if (!button || !button.classList.contains("js-view-branch")) return;

      var branchId = button.getAttribute("data-branch-id") || "";
      var name = button.getAttribute("data-branch-name") || "-";
      var address = button.getAttribute("data-branch-address") || "-";
      var state = button.getAttribute("data-branch-state") || "-";
      var lga = button.getAttribute("data-branch-lga") || "-";

      var manager = button.getAttribute("data-branch-manager") || "Not assigned";

      var managerId = button.getAttribute("data-branch-manager-id") || "";

      var phoneCode = button.getAttribute("data-branch-phone-code") || "";

      var phone = button.getAttribute("data-branch-phone") || "";

      var geofenceRadius = button.getAttribute("data-branch-geofence-radius") || "";

      var status = (button.getAttribute("data-branch-status") || "inactive").toLowerCase();

      var viewBranchName = document.querySelector("#viewBranchName");
      var viewBranchManager = document.querySelector("#viewBranchManager");

      var viewBranchManagerName = document.querySelector("#viewBranchManagerName");

      var viewBranchAddress = document.querySelector("#viewBranchAddress");
      var viewBranchState = document.querySelector("#viewBranchState");
      var viewBranchLga = document.querySelector("#viewBranchLga");
      var viewBranchPhone = document.querySelector("#viewBranchPhone");

      var viewBranchGeofenceRadius = document.querySelector("#viewBranchGeofenceRadius");

      var viewBranchStatus = document.querySelector("#viewBranchStatus");

      var viewBranchEditButton = document.querySelector("#viewBranchEditButton");
      var viewBranchPermitsLink = document.querySelector("#viewBranchPermitsLink");

      if (viewBranchPermitsLink) {
        if (branchId) {
          viewBranchPermitsLink.href =
            "/employer/branches/" + encodeURIComponent(branchId) + "/permits";
          viewBranchPermitsLink.removeAttribute("aria-disabled");
          viewBranchPermitsLink.classList.remove("disabled");
        } else {
          viewBranchPermitsLink.removeAttribute("href");
          viewBranchPermitsLink.setAttribute("aria-disabled", "true");
          viewBranchPermitsLink.classList.add("disabled");
        }
      }

      if (viewBranchName) {
        viewBranchName.textContent = name;
      }

      if (viewBranchManager) {
        viewBranchManager.textContent = "Manager: " + manager;
      }

      if (viewBranchManagerName) {
        viewBranchManagerName.textContent = manager;
      }

      if (viewBranchAddress) {
        viewBranchAddress.textContent = address;
      }

      if (viewBranchState) {
        viewBranchState.textContent = state;
      }

      if (viewBranchLga) {
        viewBranchLga.textContent = lga;
      }

      if (viewBranchPhone) {
        viewBranchPhone.textContent = phone ? (phoneCode + " " + phone).trim() : "-";
      }

      if (viewBranchGeofenceRadius) {
        viewBranchGeofenceRadius.textContent = geofenceRadius ? geofenceRadius + " meters" : "-";
      }

      if (viewBranchStatus) {
        viewBranchStatus.innerHTML =
          status === "active"
            ? '<span class="badge badge-light-success">Active</span>'
            : '<span class="badge badge-light-secondary">Inactive</span>';
      }

      if (viewBranchEditButton) {
        viewBranchEditButton.setAttribute("data-branch-id", branchId);
        viewBranchEditButton.setAttribute("data-branch-name", name);
        viewBranchEditButton.setAttribute("data-branch-address", address);
        viewBranchEditButton.setAttribute("data-branch-state", state);
        viewBranchEditButton.setAttribute("data-branch-lga", lga);

        viewBranchEditButton.setAttribute("data-branch-manager-id", managerId);

        viewBranchEditButton.setAttribute("data-branch-phone-code", phoneCode);

        viewBranchEditButton.setAttribute("data-branch-phone", phone);

        viewBranchEditButton.setAttribute("data-branch-geofence-radius", geofenceRadius);

        viewBranchEditButton.setAttribute(
          "data-branch-latitude",
          button.getAttribute("data-branch-latitude") || ""
        );

        viewBranchEditButton.setAttribute(
          "data-branch-longitude",
          button.getAttribute("data-branch-longitude") || ""
        );

        viewBranchEditButton.setAttribute(
          "data-branch-google-place-id",
          button.getAttribute("data-branch-google-place-id") || ""
        );
      }
    });
  }

  /* ---------- Populate edit-branch form ---------- */

  function populateEditBranchForm(button) {
    if (!button) return;

    editBranchOriginalLocation = captureOriginalBranchLocation(button);

    var branchId = button.getAttribute("data-branch-id") || "";

    var name = button.getAttribute("data-branch-name") || "";

    var address = button.getAttribute("data-branch-address") || "";

    var state = button.getAttribute("data-branch-state") || "";

    var lga = button.getAttribute("data-branch-lga") || "";

    var managerId = button.getAttribute("data-branch-manager-id") || "";

    var phoneCode = button.getAttribute("data-branch-phone-code") || "";

    var phone = button.getAttribute("data-branch-phone") || "";

    // The server owns the default geofence policy; do not impose 100m here.
    var geofenceRadius = button.getAttribute("data-branch-geofence-radius") || "";

    var latitude = button.getAttribute("data-branch-latitude") || "";

    var longitude = button.getAttribute("data-branch-longitude") || "";

    var googlePlaceId = button.getAttribute("data-branch-google-place-id") || "";

    var branchIdInput = document.querySelector("#editBranchIdInput");
    var nameInput = document.querySelector("#editBranchNameInput");
    var addressInput = document.querySelector("#editBranchAddressInput");

    var phoneCodeInput = document.querySelector("#editBranchPhoneCodeInput");

    var phoneInput = document.querySelector("#editBranchPhoneInput");

    var radiusInput = document.querySelector("#editBranchGeofenceRadiusInput");

    var latitudeInput = document.querySelector("#editBranchLatitudeInput");

    var longitudeInput = document.querySelector("#editBranchLongitudeInput");

    var googlePlaceIdInput = document.querySelector("#editBranchGooglePlaceIdInput");

    if (branchIdInput) {
      branchIdInput.value = branchId;
    }

    if (nameInput) {
      nameInput.value = name;
    }

    if (addressInput) {
      addressInput.value = address;
    }

    if (phoneCodeInput) {
      var defaultPhoneCode = phoneCodeInput.getAttribute("data-default-phone-code") || "";

      phoneCodeInput.value = phoneCode || defaultPhoneCode;
    }

    if (phoneInput) {
      phoneInput.value = phone;
    }

    if (radiusInput) {
      radiusInput.value = geofenceRadius;
    }

    if (latitudeInput) {
      latitudeInput.value = latitude;
    }

    if (longitudeInput) {
      longitudeInput.value = longitude;
    }

    if (googlePlaceIdInput) {
      googlePlaceIdInput.value = googlePlaceId;
    }

    setSelectValue("#editBranchManagerSelect", managerId);
    setSelectValue("#editBranchStateSelect", state);

    setTimeout(function () {
      setSelectValue("#editBranchLgaSelect", lga);
    }, 150);

    if (editBranchValidator) {
      editBranchValidator.resetForm(false);
    }
  }

  /* ---------- Handle edit-branch modal ---------- */

  function handleEditBranchModal() {
    var modalElement = document.querySelector("#editBranchModal");

    if (!modalElement) return;

    modalElement.addEventListener("show.bs.modal", function (event) {
      var button = event.relatedTarget;

      if (!button || !button.classList.contains("js-edit-branch")) return;

      populateEditBranchForm(button);
    });
  }

  /* ---------- Open edit modal from view modal ---------- */

  function handleEditFromViewButton() {
    var viewBranchEditButton = document.querySelector("#viewBranchEditButton");

    if (!viewBranchEditButton) return;

    viewBranchEditButton.addEventListener("click", function () {
      populateEditBranchForm(viewBranchEditButton);

      var viewModalElement = document.querySelector("#viewBranchModal");
      var editModalElement = document.querySelector("#editBranchModal");

      if (!editModalElement) return;

      var openEditModal = function () {
        var editModal = bootstrap.Modal.getOrCreateInstance(editModalElement);

        editModal.show();
      };

      if (viewModalElement) {
        var viewModal = bootstrap.Modal.getInstance(viewModalElement);

        if (viewModal) {
          viewModalElement.addEventListener("hidden.bs.modal", openEditModal, {
            once: true,
          });

          viewModal.hide();

          return;
        }
      }

      openEditModal();
    });
  }

  /* ---------- Edit-branch validation ---------- */

  function handleEditBranchValidation() {
    editBranchForm = document.querySelector("#kt_edit_branch_form");

    editBranchSubmitButton = document.querySelector("#kt_edit_branch_submit");

    if (!editBranchForm || !editBranchSubmitButton) return;

    if (typeof FormValidation !== "undefined") {
      editBranchValidator = FormValidation.formValidation(editBranchForm, {
        fields: {
          name: {
            validators: {
              notEmpty: {
                message: "Branch name is required.",
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

          address: {
            validators: {
              notEmpty: {
                message: "Branch address is required.",
              },

              callback: {
                message: "Please select a valid address from the Google suggestions.",

                callback: function (input) {
                  var addressValue = String(input.value || "").trim();

                  if (!addressValue) return false;

                  return hasValidAddressSelection(
                    "#editBranchLatitudeInput",
                    "#editBranchLongitudeInput",
                    "#editBranchGooglePlaceIdInput"
                  );
                },
              },
            },
          },

          contactPhone: {
            validators: {
              callback: {
                message: "Enter a valid branch phone number.",

                callback: function (input) {
                  var value = String(input.value || "").trim();

                  if (!value) return true;

                  return /^[0-9]{7,15}$/.test(value.replace(/\s+/g, ""));
                },
              },
            },
          },

          geofenceRadiusMeters: {
            validators: {
              callback: {
                message: "Enter a valid positive whole-number geofence radius.",

                callback: function (input) {
                  var raw = String(input.value || "").trim();
                  if (!raw) return true; // On edit, the server preserves the saved radius.

                  var value = Number(raw);
                  return Number.isSafeInteger(value) && value > 0;
                },
              },
            },
          },
        },

        plugins: {
          trigger: new FormValidation.plugins.Trigger(),

          bootstrap: new FormValidation.plugins.Bootstrap5({
            rowSelector: ".fv-row",
            eleInvalidClass: "",
            eleValidClass: "",
          }),
        },
      });

      bindEditSelectValidation();
    }

    handleEditBranchSubmission();
  }

  /* ---------- Edit-branch submission ---------- */

  function handleEditBranchSubmission() {
    if (!editBranchForm || !editBranchSubmitButton) return;

    editBranchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (editBranchSubmissionPending || editBranchSubmitButton.disabled) return;

      editBranchSubmissionPending = true;

      var branchUpdateData = null;

      var submitForm = function () {
        editBranchSubmitButton.setAttribute("data-kt-indicator", "on");
        editBranchSubmitButton.disabled = true;

        axios
          .post(editBranchForm.action, branchUpdateData)
          .then(function (response) {
            editBranchSubmitButton.removeAttribute("data-kt-indicator");

            Swal.fire({
              text: response.data.message || "Branch updated successfully.",

              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",

              customClass: {
                confirmButton: "btn btn-primary",
              },
            }).then(function () {
              window.location.href =
                response.data.redirectUrl || "/employer/business-profile?tab=branches";
            });
          })
          .catch(function (error) {
            editBranchSubmissionPending = false;
            editBranchSubmitButton.removeAttribute("data-kt-indicator");
            editBranchSubmitButton.disabled = false;

            Swal.fire({
              text: error.response?.data?.message || "Unable to update branch.",

              icon: "error",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",

              customClass: {
                confirmButton: "btn btn-primary",
              },
            });
          });
      };

      var confirmLocationChangeIfNeeded = function () {
        branchUpdateData = buildBranchSubmissionData(editBranchForm);

        if (!branchUpdateData.branchId) {
          editBranchSubmissionPending = false;
          Swal.fire({ text: "Please select a branch to edit.", icon: "error" });
          return;
        }

        if (!hasBranchPremisesChanged(branchUpdateData)) {
          submitForm();
          return;
        }

        Swal.fire({
          title: "Confirm change of physical premises",
          text:
            "Changing this branch's physical premises will deactivate its current " +
            "facility permits. Any permits required for the new location must " +
            "be submitted and approved before regulatory readiness is restored.",
          icon: "warning",
          showCancelButton: true,
          buttonsStyling: false,
          confirmButtonText: "Yes, move this branch",
          cancelButtonText: "Cancel",
          customClass: {
            confirmButton: "btn btn-danger",
            cancelButton: "btn btn-light",
          },
        })
          .then(function (result) {
            if (!result.isConfirmed) {
              editBranchSubmissionPending = false;
              return;
            }

            submitForm();
          })
          .catch(function () {
            editBranchSubmissionPending = false;
          });
      };

      if (editBranchValidator) {
        editBranchValidator
          .validate()
          .then(function (status) {
            if (status !== "Valid") {
              editBranchSubmissionPending = false;
              return;
            }

            confirmLocationChangeIfNeeded();
          })
          .catch(function () {
            editBranchSubmissionPending = false;
            Swal.fire({
              text: "Unable to validate branch details. Please try again.",
              icon: "error",
            });
          });

        return;
      }

      confirmLocationChangeIfNeeded();
    });
  }

  /* ---------- Business-details validation ---------- */

  function handleBusinessDetailsValidation() {
    businessDetailsForm = document.querySelector("#kt_business_details_form");

    businessDetailsSubmitButton = document.querySelector("#kt_business_details_submit");

    if (!businessDetailsForm || !businessDetailsSubmitButton) return;

    /*
     * Apply protection before initialising
     * FormValidation.
     *
     * The protected CAC and regulatory fields
     * are not user-editable and are not required
     * in the ordinary profile-update payload.
     */

    protectBusinessDetailsIdentityFields();

    var validationFields = {
      businessEmail: {
        validators: {
          notEmpty: {
            message: "Business email is required.",
          },

          regexp: {
            regexp: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            message: "Enter a valid business email address.",
          },
        },
      },

      businessPhoneCode: {
        validators: {
          notEmpty: {
            message: "Phone code is required.",
          },
        },
      },

      businessPhone: {
        validators: {
          notEmpty: {
            message: "Business phone number is required.",
          },

          callback: {
            message: "Enter a valid business phone number.",

            callback: function (input) {
              var value = String(input.value || "").trim();

              return /^[0-9]{7,15}$/.test(value.replace(/\s+/g, ""));
            },
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

      address: {
        validators: {
          notEmpty: {
            message: "Business address is required.",
          },

          callback: {
            message: "Please select a valid address from the Google suggestions.",

            callback: function (input) {
              var addressValue = String(input.value || "").trim();

              if (!addressValue) return false;

              return hasValidAddressSelection(
                "#businessDetailsLatitude",
                "#businessDetailsLongitude",
                "#businessDetailsGooglePlaceId"
              );
            },
          },
        },
      },

      contactFirstName: {
        validators: {
          notEmpty: {
            message: "Contact first name is required.",
          },
        },
      },

      contactLastName: {
        validators: {
          notEmpty: {
            message: "Contact last name is required.",
          },
        },
      },

      contactRole: {
        validators: {
          notEmpty: {
            message: "Please select a contact role.",
          },
        },
      },

      contactPhoneCode: {
        validators: {
          notEmpty: {
            message: "Contact phone code is required.",
          },
        },
      },

      contactPhone: {
        validators: {
          notEmpty: {
            message: "Contact phone number is required.",
          },

          callback: {
            message: "Enter a valid contact phone number.",

            callback: function (input) {
              var value = String(input.value || "").trim();

              return /^[0-9]{7,15}$/.test(value.replace(/\s+/g, ""));
            },
          },
        },
      },
    };

    if (typeof FormValidation !== "undefined") {
      businessDetailsValidator = FormValidation.formValidation(businessDetailsForm, {
        fields: validationFields,

        plugins: {
          trigger: new FormValidation.plugins.Trigger(),

          bootstrap: new FormValidation.plugins.Bootstrap5({
            rowSelector: ".fv-row",
            eleInvalidClass: "",
            eleValidClass: "",
          }),
        },
      });

      bindBusinessDetailsSelectValidation();
    }

    handleBusinessDetailsSubmission();
  }

  /* ---------- Business-details submission ---------- */

  function handleBusinessDetailsSubmission() {
    if (!businessDetailsForm || !businessDetailsSubmitButton) return;

    businessDetailsForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (businessDetailsSubmitButton.disabled) {
        return;
      }

      var submitForm = function () {
        businessDetailsSubmitButton.setAttribute("data-kt-indicator", "on");

        businessDetailsSubmitButton.disabled = true;

        /*
         * Submit only fields permitted by the
         * ordinary employer profile update service.
         *
         * Do not submit the CAC legal name,
         * registration number, business type
         * or regulatory registration identity.
         *
         * The backend independently retrieves
         * these values from EmployerProfile
         * and enforces actor authorisation.
         */

        var data = buildBusinessDetailsSubmissionData();

        axios
          .post(businessDetailsForm.action, data)
          .then(function (response) {
            businessDetailsSubmitButton.removeAttribute("data-kt-indicator");

            Swal.fire({
              text: response.data.message || "Business details updated successfully.",

              icon: "success",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",

              customClass: {
                confirmButton: "btn btn-primary",
              },
            }).then(function () {
              window.location.href =
                response.data.redirectUrl || "/employer/business-profile?tab=business-details";
            });
          })
          .catch(function (error) {
            businessDetailsSubmitButton.removeAttribute("data-kt-indicator");

            businessDetailsSubmitButton.disabled = false;

            /*
             * The controller distinguishes:
             *
             * - Invalid input;
             * - Unauthorised editing;
             * - Protected identity changes;
             * - Premises requiring renewed review;
             * - Representative changes requiring review.
             *
             * Display the safe server message
             * rather than assuming every failure
             * is a client-side validation error.
             */

            var errorMessage =
              error.response?.data?.message || "Unable to update business details.";

            Swal.fire({
              text: errorMessage,

              icon: "error",
              buttonsStyling: false,
              confirmButtonText: "Ok, got it!",

              customClass: {
                confirmButton: "btn btn-primary",
              },
            });
          });
      };

      if (businessDetailsValidator) {
        businessDetailsValidator.validate().then(function (status) {
          if (status !== "Valid") return;

          submitForm();
        });

        return;
      }

      submitForm();
    });
  }

  /* ---------- Copy text to clipboard ---------- */

  function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      var textarea = document.createElement("textarea");

      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "0";
      textarea.style.opacity = "0";

      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        var copied = document.execCommand("copy");

        document.body.removeChild(textarea);

        if (copied) {
          resolve();
        } else {
          reject(new Error("Copy command failed."));
        }
      } catch (error) {
        document.body.removeChild(textarea);
        reject(error);
      }
    });
  }

  /* ---------- Handle copy buttons ---------- */

  function handleCopyTextButtons() {
    document.addEventListener("click", function (event) {
      var copyButton = event.target.closest(".js-copy-text");

      if (!copyButton) return;
      if (copyButton.disabled) return;

      var textToCopy = copyButton.getAttribute("data-copy-text");

      if (!textToCopy) return;

      var originalContent = copyButton.innerHTML;

      copyButton.disabled = true;

      copyTextToClipboard(textToCopy)
        .then(function () {
          copyButton.innerHTML = "Copied";

          setTimeout(function () {
            copyButton.innerHTML = originalContent;
            copyButton.disabled = false;
          }, 1500);
        })
        .catch(function () {
          copyButton.innerHTML = "Failed";

          setTimeout(function () {
            copyButton.innerHTML = originalContent;
            copyButton.disabled = false;
          }, 1500);
        });
    });
  }

  return {
    init: function () {
      initSelect2();
      initLocationPicker();
      setBusinessDetailsInitialSelectValues();

      handleCopyTextButtons();
      handleBranchStatusActions();

      handleViewBranchModal();
      handleEditBranchModal();
      handleEditFromViewButton();

      handleAddBranchValidation();
      handleEditBranchValidation();
      handleBusinessDetailsValidation();
    },

    initAddressAutocomplete: function () {
      initAddBranchAddressAutocomplete();
      initEditBranchAddressAutocomplete();
      initBusinessDetailsAddressAutocomplete();
    },
  };
})();

window.initBusinessProfileAddressAutocomplete = function () {
  EmployerBusinessProfile.initAddressAutocomplete();
};

KTUtil.onDOMContentLoaded(function () {
  EmployerBusinessProfile.init();
});
