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
  var editLocationLoadId = 0;

  var addressLocations = {
    add: {
      state: "#addBranchStateSelect",
      lga: "#addBranchLgaSelect",
      address: "#addBranchAddressInput",
      latitude: "#addBranchLatitudeInput",
      longitude: "#addBranchLongitudeInput",
      placeId: "#addBranchGooglePlaceIdInput",
      revalidate: function () {
        revalidateField("address");
      },
      confirmedState: null,
      confirmedLga: null,
      populating: false,
    },
    edit: {
      state: "#editBranchStateSelect",
      lga: "#editBranchLgaSelect",
      address: "#editBranchAddressInput",
      latitude: "#editBranchLatitudeInput",
      longitude: "#editBranchLongitudeInput",
      placeId: "#editBranchGooglePlaceIdInput",
      revalidate: function () {
        revalidateEditField("address");
      },
      confirmedState: null,
      confirmedLga: null,
      populating: false,
    },
    business: {
      state: "#businessDetailsStateSelect",
      lga: "#businessDetailsLgaSelect",
      address: "#businessDetailsAddressInput",
      latitude: "#businessDetailsLatitude",
      longitude: "#businessDetailsLongitude",
      placeId: "#businessDetailsGooglePlaceId",
      revalidate: function () {
        revalidateBusinessDetailsField("address");
      },
      confirmedState: null,
      confirmedLga: null,
      populating: false,
    },
  };

  // ───────────────────── BUSINESS PROFILE FIELD POLICY ─────────────────────

  // CAC legal identity is read-only during ordinary profile editing.
  // The backend independently enforces protected-field restrictions.

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

  // ───────────────────── SHARED LOCATION HELPERS ─────────────────────

  function getEmployerCountryCode() {
    var countryCodeInput = document.querySelector("#businessProfileCountryCode");

    return String(countryCodeInput ? countryCodeInput.value : "ng")
      .trim()
      .toLowerCase();
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

  function currentLocationValue(selector) {
    return normalizeLocationText(document.querySelector(selector)?.value);
  }

  function confirmAddressLocation(groupName, state, lga) {
    var location = addressLocations[groupName];
    if (!location) return;

    location.confirmedState =
      state === undefined ? currentLocationValue(location.state) : normalizeLocationText(state);

    location.confirmedLga =
      lga === undefined ? currentLocationValue(location.lga) : normalizeLocationText(lga);
  }

  function clearAddressEvidence(groupName, clearAddress) {
    var location = addressLocations[groupName];
    if (!location) return;

    [location.latitude, location.longitude, location.placeId].forEach(function (selector) {
      var input = document.querySelector(selector);
      if (input) input.value = "";
    });

    if (clearAddress) {
      var addressInput = document.querySelector(location.address);
      if (addressInput) addressInput.value = "";
    }

    location.confirmedState = null;
    location.confirmedLga = null;
    location.revalidate();
  }

  function handleAdministrativeLocationChange(groupName) {
    var location = addressLocations[groupName];
    if (!location || location.populating) return;

    var hasEvidence = Boolean(
      currentLocationValue(location.latitude) ||
      currentLocationValue(location.longitude) ||
      currentLocationValue(location.placeId)
    );

    if (!hasEvidence) return;

    if (
      location.confirmedState !== currentLocationValue(location.state) ||
      location.confirmedLga !== currentLocationValue(location.lga)
    ) {
      clearAddressEvidence(groupName, true);
    }
  }

  function bindAddressTextInvalidation() {
    Object.keys(addressLocations).forEach(function (groupName) {
      var location = addressLocations[groupName];
      var input = document.querySelector(location.address);
      if (!input) return;

      input.addEventListener("input", function () {
        clearAddressEvidence(groupName, false);
      });
    });
  }

  function hasValidAddressSelection(latitudeSelector, longitudeSelector, placeIdSelector) {
    var latitudeInput = document.querySelector(latitudeSelector);
    var longitudeInput = document.querySelector(longitudeSelector);
    var placeIdInput = document.querySelector(placeIdSelector);

    if (!latitudeInput || !longitudeInput || !placeIdInput) return false;

    var latitudeValue = normalizeLocationText(latitudeInput.value);
    var longitudeValue = normalizeLocationText(longitudeInput.value);
    var placeIdValue = normalizeLocationText(placeIdInput.value);

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

  function hasCurrentAddressEvidence(groupName) {
    var location = addressLocations[groupName];
    if (!location) return false;

    return (
      Boolean(currentLocationValue(location.state)) &&
      Boolean(currentLocationValue(location.lga)) &&
      location.confirmedState !== null &&
      location.confirmedLga !== null &&
      location.confirmedState === currentLocationValue(location.state) &&
      location.confirmedLga === currentLocationValue(location.lga) &&
      hasValidAddressSelection(location.latitude, location.longitude, location.placeId)
    );
  }

  function buildBranchSubmissionData(form) {
    var data = Object.fromEntries(new FormData(form));
    var contactPhone = normalizeLocationText(data.contactPhone).replace(/\s+/g, "");

    data.contactPhone = contactPhone;
    data.contactPhoneCode = contactPhone ? normalizeLocationText(data.contactPhoneCode) : "";

    if (form === editBranchForm && !data.branchId) {
      var branchIdInput = document.querySelector("#editBranchIdInput");

      data.branchId = normalizeLocationText(
        branchIdInput ? branchIdInput.value : editBranchOriginalLocation?.branchId
      );
    }

    // Preserve the form's CSRF token and managerMemberId.
    return data;
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

  // ───────────────────── SELECT2 AND LOCATION PICKERS ─────────────────────

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

  function initLocationPicker() {
    if (typeof LocationPicker === "undefined") return;

    LocationPicker.init("#addBranchStateSelect", "#addBranchLgaSelect");
    LocationPicker.init("#editBranchStateSelect", "#editBranchLgaSelect");
    LocationPicker.init("#businessDetailsStateSelect", "#businessDetailsLgaSelect");

    var currentStateInput = document.querySelector("#businessDetailsCurrentState");
    var currentLgaInput = document.querySelector("#businessDetailsCurrentLga");

    if (currentStateInput && currentLgaInput) {
      var location = addressLocations.business;

      location.populating = true;

      confirmAddressLocation("business", currentStateInput.value, currentLgaInput.value);

      setTimeout(function () {
        setSelectValue("#businessDetailsStateSelect", currentStateInput.value);

        setTimeout(function () {
          setSelectValue("#businessDetailsLgaSelect", currentLgaInput.value);
          location.populating = false;
        }, 150);
      }, 150);
    }
  }

  // ───────────────────── REVALIDATION HELPERS ─────────────────────

  function revalidateField(fieldName) {
    if (addBranchValidator) addBranchValidator.revalidateField(fieldName);
  }

  function revalidateEditField(fieldName) {
    if (editBranchValidator) editBranchValidator.revalidateField(fieldName);
  }

  function revalidateBusinessDetailsField(fieldName) {
    if (businessDetailsValidator) {
      businessDetailsValidator.revalidateField(fieldName);
    }
  }

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

  // ───────────────────── PROTECTED BUSINESS DETAILS ─────────────────────

  function updateBusinessDetailsRegulatoryBodyDisplay() {
    var regulatoryBodyDisplay = document.querySelector("#businessDetailsRegulatoryBodyDisplay");
    if (!regulatoryBodyDisplay) return;

    // Keep the stored regulator authoritative.
    if ("readOnly" in regulatoryBodyDisplay) {
      regulatoryBodyDisplay.readOnly = true;
    }

    regulatoryBodyDisplay.setAttribute("aria-readonly", "true");
  }

  function protectBusinessDetailsIdentityFields() {
    if (!businessDetailsForm) return;

    protectedBusinessDetailsFields.forEach(function (fieldName) {
      var fields = businessDetailsForm.querySelectorAll('[name="' + fieldName + '"]');

      fields.forEach(function (field) {
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

        if ("readOnly" in field) field.readOnly = true;
        field.setAttribute("aria-readonly", "true");
      });
    });

    var businessTypeSelect = document.querySelector("#businessTypeSelect");

    if (businessTypeSelect && businessDetailsForm.contains(businessTypeSelect)) {
      businessTypeSelect.disabled = true;

      if (typeof $ !== "undefined" && $(businessTypeSelect).data("select2")) {
        $(businessTypeSelect).prop("disabled", true);
      }
    }

    updateBusinessDetailsRegulatoryBodyDisplay();
  }

  function buildBusinessDetailsSubmissionData() {
    var formData = new FormData(businessDetailsForm);
    var data = {};

    editableBusinessDetailsFields.forEach(function (fieldName) {
      if (formData.has(fieldName)) {
        data[fieldName] = formData.get(fieldName);
      }
    });

    if (formData.has("_csrf")) {
      data._csrf = formData.get("_csrf");
    }

    return data;
  }

  // ───────────────────── LOCATION SELECT VALIDATION ─────────────────────

  function bindSelectValidation() {
    var stateSelect = document.querySelector("#addBranchStateSelect");
    var lgaSelect = document.querySelector("#addBranchLgaSelect");

    if (stateSelect) {
      stateSelect.addEventListener("change", function () {
        handleAdministrativeLocationChange("add");
        revalidateField("state");
      });
    }

    if (lgaSelect) {
      lgaSelect.addEventListener("change", function () {
        handleAdministrativeLocationChange("add");
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

  function bindEditSelectValidation() {
    var stateSelect = document.querySelector("#editBranchStateSelect");
    var lgaSelect = document.querySelector("#editBranchLgaSelect");

    if (stateSelect) {
      stateSelect.addEventListener("change", function () {
        handleAdministrativeLocationChange("edit");
        revalidateEditField("state");
      });
    }

    if (lgaSelect) {
      lgaSelect.addEventListener("change", function () {
        handleAdministrativeLocationChange("edit");
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

  function bindBusinessDetailsSelectValidation() {
    var typeSelect = document.querySelector("#businessTypeSelect");
    var stateSelect = document.querySelector("#businessDetailsStateSelect");
    var lgaSelect = document.querySelector("#businessDetailsLgaSelect");
    var contactRoleSelect = document.querySelector("#contactRoleSelect");

    if (typeSelect) {
      typeSelect.addEventListener("change", updateBusinessDetailsRegulatoryBodyDisplay);
    }

    if (stateSelect) {
      stateSelect.addEventListener("change", function () {
        handleAdministrativeLocationChange("business");
        updateBusinessDetailsRegulatoryBodyDisplay();
        revalidateBusinessDetailsField("state");
      });
    }

    if (lgaSelect) {
      lgaSelect.addEventListener("change", function () {
        handleAdministrativeLocationChange("business");
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

  // ───────────────────── GOOGLE ADDRESS AUTOCOMPLETE ─────────────────────

  function createAddressAutocomplete(groupName) {
    var location = addressLocations[groupName];
    if (!location) return;

    var addressInput = document.querySelector(location.address);
    var latitudeInput = document.querySelector(location.latitude);
    var longitudeInput = document.querySelector(location.longitude);
    var googlePlaceIdInput = document.querySelector(location.placeId);

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
      componentRestrictions: { country: getEmployerCountryCode() },
      fields: ["formatted_address", "geometry", "place_id"],
      types: ["geocode"],
    });

    autocomplete.addListener("place_changed", function () {
      var place = autocomplete.getPlace();

      if (!place?.geometry?.location || !place.place_id) {
        clearAddressEvidence(groupName, false);
        return;
      }

      addressInput.value = place.formatted_address || addressInput.value;
      latitudeInput.value = place.geometry.location.lat();
      longitudeInput.value = place.geometry.location.lng();
      googlePlaceIdInput.value = place.place_id;

      confirmAddressLocation(groupName);
      location.revalidate();
    });
  }

  function initAddBranchAddressAutocomplete() {
    createAddressAutocomplete("add");
  }

  function initEditBranchAddressAutocomplete() {
    createAddressAutocomplete("edit");
  }

  function initBusinessDetailsAddressAutocomplete() {
    createAddressAutocomplete("business");
  }

  // ───────────────────── ADD BRANCH VALIDATION ─────────────────────

  function handleAddBranchValidation() {
    addBranchForm = document.querySelector("#kt_add_branch_form");
    addBranchSubmitButton = document.querySelector("#kt_add_branch_submit");

    if (!addBranchForm || !addBranchSubmitButton) return;

    if (typeof FormValidation !== "undefined") {
      addBranchValidator = FormValidation.formValidation(addBranchForm, {
        fields: {
          name: {
            validators: {
              notEmpty: { message: "Branch name is required." },
            },
          },
          state: {
            validators: {
              notEmpty: { message: "Please select a state." },
            },
          },
          lga: {
            validators: {
              notEmpty: { message: "Please select an LGA." },
            },
          },
          address: {
            validators: {
              notEmpty: { message: "Branch address is required." },
              callback: {
                message: "Please select a valid address from the Google suggestions.",
                callback: function (input) {
                  if (!normalizeLocationText(input.value)) return false;
                  return hasCurrentAddressEvidence("add");
                },
              },
            },
          },
          contactPhone: {
            validators: {
              callback: {
                message: "Enter a valid branch phone number.",
                callback: function (input) {
                  var value = normalizeLocationText(input.value);
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
    }

    bindSelectValidation();
    handleAddBranchSubmission();
  }

  // ───────────────────── ADD BRANCH SUBMISSION ─────────────────────

  function handleAddBranchSubmission() {
    if (!addBranchForm || !addBranchSubmitButton) return;

    addBranchForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (addBranchSubmissionPending || addBranchSubmitButton.disabled) return;
      addBranchSubmissionPending = true;

      var submitForm = function () {
        addBranchSubmitButton.setAttribute("data-kt-indicator", "on");
        addBranchSubmitButton.disabled = true;

        if (!hasCurrentAddressEvidence("add")) {
          addBranchSubmissionPending = false;
          addBranchSubmitButton.removeAttribute("data-kt-indicator");
          addBranchSubmitButton.disabled = false;

          Swal.fire({
            text: "Select the branch address from Google suggestions after choosing the state and LGA.",
            icon: "warning",
          });
          return;
        }

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

  // ───────────────────── BRANCH STATUS ACTIONS ─────────────────────

  function handleBranchStatusActions() {
    document.addEventListener("click", function (event) {
      var actionLink = event.target.closest(".js-toggle-branch-status");
      if (!actionLink) return;

      event.preventDefault();

      var branchId = normalizeLocationText(actionLink.getAttribute("data-branch-id"));
      var action = normalizeLocationText(actionLink.getAttribute("data-branch-action"));

      if (pendingBranchStatusChanges[branchId]) return;
      if (actionLink.getAttribute("aria-disabled") === "true") return;

      if (!/^[a-f0-9]{24}$/i.test(branchId) || !["activate", "deactivate"].includes(action)) {
        Swal.fire({
          text: "Unable to identify a valid branch status action.",
          icon: "error",
        });
        return;
      }

      var csrfInput = document.querySelector(
        '#kt_edit_branch_form input[name="_csrf"], #kt_add_branch_form input[name="_csrf"], input[name="_csrf"]'
      );
      var csrfToken = csrfInput ? normalizeLocationText(csrfInput.value) : "";

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

  // ───────────────────── VIEW BRANCH MODAL ─────────────────────

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
            "/employer/branches/" + encodeURIComponent(branchId) + "/permits/manage";
          viewBranchPermitsLink.removeAttribute("aria-disabled");
          viewBranchPermitsLink.classList.remove("disabled");
        } else {
          viewBranchPermitsLink.removeAttribute("href");
          viewBranchPermitsLink.setAttribute("aria-disabled", "true");
          viewBranchPermitsLink.classList.add("disabled");
        }
      }

      if (viewBranchName) viewBranchName.textContent = name;
      if (viewBranchManager) viewBranchManager.textContent = "Manager: " + manager;
      if (viewBranchManagerName) viewBranchManagerName.textContent = manager;
      if (viewBranchAddress) viewBranchAddress.textContent = address;
      if (viewBranchState) viewBranchState.textContent = state;
      if (viewBranchLga) viewBranchLga.textContent = lga;

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
        var attributes = {
          "data-branch-id": branchId,
          "data-branch-name": name,
          "data-branch-address": address,
          "data-branch-state": state,
          "data-branch-lga": lga,
          "data-branch-manager-id": managerId,
          "data-branch-phone-code": phoneCode,
          "data-branch-phone": phone,
          "data-branch-geofence-radius": geofenceRadius,
          "data-branch-latitude": button.getAttribute("data-branch-latitude") || "",
          "data-branch-longitude": button.getAttribute("data-branch-longitude") || "",
          "data-branch-google-place-id": button.getAttribute("data-branch-google-place-id") || "",
        };

        Object.keys(attributes).forEach(function (key) {
          viewBranchEditButton.setAttribute(key, attributes[key]);
        });
      }
    });
  }

  // ───────────────────── POPULATE EDIT BRANCH FORM ─────────────────────

  function populateEditBranchForm(button) {
    if (!button) return;

    editBranchOriginalLocation = captureOriginalBranchLocation(button);

    var locationLoadId = ++editLocationLoadId;
    addressLocations.edit.populating = true;

    confirmAddressLocation(
      "edit",
      editBranchOriginalLocation.state,
      editBranchOriginalLocation.lga
    );

    var branchId = button.getAttribute("data-branch-id") || "";
    var name = button.getAttribute("data-branch-name") || "";
    var address = button.getAttribute("data-branch-address") || "";
    var state = button.getAttribute("data-branch-state") || "";
    var lga = button.getAttribute("data-branch-lga") || "";
    var managerId = button.getAttribute("data-branch-manager-id") || "";
    var phoneCode = button.getAttribute("data-branch-phone-code") || "";
    var phone = button.getAttribute("data-branch-phone") || "";
    var geofenceRadius = button.getAttribute("data-branch-geofence-radius") || "";
    var latitude = button.getAttribute("data-branch-latitude") || "";
    var longitude = button.getAttribute("data-branch-longitude") || "";
    var googlePlaceId = button.getAttribute("data-branch-google-place-id") || "";

    var values = {
      "#editBranchIdInput": branchId,
      "#editBranchNameInput": name,
      "#editBranchAddressInput": address,
      "#editBranchPhoneInput": phone,
      "#editBranchGeofenceRadiusInput": geofenceRadius,
      "#editBranchLatitudeInput": latitude,
      "#editBranchLongitudeInput": longitude,
      "#editBranchGooglePlaceIdInput": googlePlaceId,
    };

    Object.keys(values).forEach(function (selector) {
      var input = document.querySelector(selector);
      if (input) input.value = values[selector];
    });

    var phoneCodeInput = document.querySelector("#editBranchPhoneCodeInput");

    if (phoneCodeInput) {
      var defaultPhoneCode = phoneCodeInput.getAttribute("data-default-phone-code") || "";
      phoneCodeInput.value = phoneCode || defaultPhoneCode;
    }

    setSelectValue("#editBranchManagerSelect", managerId);
    setSelectValue("#editBranchStateSelect", state);

    setTimeout(function () {
      if (locationLoadId !== editLocationLoadId) return;

      setSelectValue("#editBranchLgaSelect", lga);
      addressLocations.edit.populating = false;
    }, 150);

    if (editBranchValidator) {
      editBranchValidator.resetForm(false);
    }
  }

  function handleEditBranchModal() {
    var modalElement = document.querySelector("#editBranchModal");
    if (!modalElement) return;

    modalElement.addEventListener("show.bs.modal", function (event) {
      var button = event.relatedTarget;

      if (!button || !button.classList.contains("js-edit-branch")) return;
      populateEditBranchForm(button);
    });
  }

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

  // ───────────────────── EDIT BRANCH VALIDATION ─────────────────────

  function handleEditBranchValidation() {
    editBranchForm = document.querySelector("#kt_edit_branch_form");
    editBranchSubmitButton = document.querySelector("#kt_edit_branch_submit");

    if (!editBranchForm || !editBranchSubmitButton) return;

    if (typeof FormValidation !== "undefined") {
      editBranchValidator = FormValidation.formValidation(editBranchForm, {
        fields: {
          name: {
            validators: {
              notEmpty: { message: "Branch name is required." },
            },
          },
          state: {
            validators: {
              notEmpty: { message: "Please select a state." },
            },
          },
          lga: {
            validators: {
              notEmpty: { message: "Please select an LGA." },
            },
          },
          address: {
            validators: {
              notEmpty: { message: "Branch address is required." },
              callback: {
                message: "Please select a valid address from the Google suggestions.",
                callback: function (input) {
                  if (!normalizeLocationText(input.value)) return false;
                  return hasCurrentAddressEvidence("edit");
                },
              },
            },
          },
          contactPhone: {
            validators: {
              callback: {
                message: "Enter a valid branch phone number.",
                callback: function (input) {
                  var value = normalizeLocationText(input.value);
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
                  var raw = normalizeLocationText(input.value);
                  if (!raw) return true;

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
    }

    bindEditSelectValidation();
    handleEditBranchSubmission();
  }

  // ───────────────────── EDIT BRANCH SUBMISSION ─────────────────────

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

        if (!hasCurrentAddressEvidence("edit")) {
          editBranchSubmissionPending = false;
          editBranchSubmitButton.removeAttribute("data-kt-indicator");
          editBranchSubmitButton.disabled = false;

          Swal.fire({
            text: "Select the branch address from Google suggestions after choosing the state and LGA.",
            icon: "warning",
          });
          return;
        }

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

          Swal.fire({
            text: "Please select a branch to edit.",
            icon: "error",
          });
          return;
        }

        if (!hasCurrentAddressEvidence("edit")) {
          submitForm();
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

  // ───────────────────── BUSINESS DETAILS VALIDATION ─────────────────────

  function handleBusinessDetailsValidation() {
    businessDetailsForm = document.querySelector("#kt_business_details_form");
    businessDetailsSubmitButton = document.querySelector("#kt_business_details_submit");

    if (!businessDetailsForm || !businessDetailsSubmitButton) return;

    protectBusinessDetailsIdentityFields();

    var validationFields = {
      businessEmail: {
        validators: {
          notEmpty: { message: "Business email is required." },
          regexp: {
            regexp: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            message: "Enter a valid business email address.",
          },
        },
      },
      businessPhoneCode: {
        validators: {
          notEmpty: { message: "Phone code is required." },
        },
      },
      businessPhone: {
        validators: {
          notEmpty: { message: "Business phone number is required." },
          callback: {
            message: "Enter a valid business phone number.",
            callback: function (input) {
              var value = normalizeLocationText(input.value);
              return /^[0-9]{7,15}$/.test(value.replace(/\s+/g, ""));
            },
          },
        },
      },
      state: {
        validators: {
          notEmpty: { message: "Please select a state." },
        },
      },
      lga: {
        validators: {
          notEmpty: { message: "Please select an LGA." },
        },
      },
      address: {
        validators: {
          notEmpty: { message: "Business address is required." },
          callback: {
            message: "Please select a valid address from the Google suggestions.",
            callback: function (input) {
              if (!normalizeLocationText(input.value)) return false;
              return hasCurrentAddressEvidence("business");
            },
          },
        },
      },
      contactFirstName: {
        validators: {
          notEmpty: { message: "Contact first name is required." },
        },
      },
      contactLastName: {
        validators: {
          notEmpty: { message: "Contact last name is required." },
        },
      },
      contactRole: {
        validators: {
          notEmpty: { message: "Please select a contact role." },
        },
      },
      contactPhoneCode: {
        validators: {
          notEmpty: { message: "Contact phone code is required." },
        },
      },
      contactPhone: {
        validators: {
          notEmpty: { message: "Contact phone number is required." },
          callback: {
            message: "Enter a valid contact phone number.",
            callback: function (input) {
              var value = normalizeLocationText(input.value);
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
    }

    bindBusinessDetailsSelectValidation();
    handleBusinessDetailsSubmission();
  }

  // ───────────────────── BUSINESS DETAILS SUBMISSION ─────────────────────

  function handleBusinessDetailsSubmission() {
    if (!businessDetailsForm || !businessDetailsSubmitButton) return;

    businessDetailsForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (businessDetailsSubmitButton.disabled) return;

      var submitForm = function () {
        businessDetailsSubmitButton.setAttribute("data-kt-indicator", "on");
        businessDetailsSubmitButton.disabled = true;

        if (!hasCurrentAddressEvidence("business")) {
          businessDetailsSubmitButton.removeAttribute("data-kt-indicator");
          businessDetailsSubmitButton.disabled = false;

          Swal.fire({
            text: "Select the business address from Google suggestions after choosing the state and LGA.",
            icon: "warning",
          });
          return;
        }

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
        businessDetailsValidator
          .validate()
          .then(function (status) {
            if (status !== "Valid") return;
            submitForm();
          })
          .catch(function () {
            Swal.fire({
              text: "Unable to validate business details. Please try again.",
              icon: "error",
            });
          });

        return;
      }

      submitForm();
    });
  }

  // ───────────────────── CLIPBOARD ─────────────────────

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

        if (copied) resolve();
        else reject(new Error("Copy command failed."));
      } catch (error) {
        document.body.removeChild(textarea);
        reject(error);
      }
    });
  }

  function handleCopyTextButtons() {
    document.addEventListener("click", function (event) {
      var copyButton = event.target.closest(".js-copy-text");

      if (!copyButton || copyButton.disabled) return;

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

  // ───────────────────── INITIALIZATION ─────────────────────

  return {
    init: function () {
      initSelect2();
      initLocationPicker();
      setBusinessDetailsInitialSelectValues();
      bindAddressTextInvalidation();

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
